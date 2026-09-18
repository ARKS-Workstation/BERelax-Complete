import type { Sql } from '../connection.ts'

/**
 * The trial balance — the query every later gate depends on.
 *
 * It exists so that "do the books balance?" has one answer computed one way. The alternative is each
 * report summing the ledger for itself, and the failure mode of that is not a wrong number but two
 * numbers: a VAT return that balances and a management report that does not, with no way to tell which
 * is wrong. The M-VAT and R-REP units all assert against this function.
 *
 * ## As at, not between
 *
 * A trial balance is a position, not a period: it is the cumulative effect of every entry dated on or
 * before a date. `asAt` therefore takes one date and sums from the beginning. A period report is the
 * difference between two of these, which is a subtraction the caller can do and this function should
 * not guess at.
 *
 * `entry_date` is the **business day** the poster resolved, never a truncated `posted_at`. Trading runs
 * 11:00–02:00, so an entry posted at 01:30 belongs to the previous trading date; cutting on `posted_at`
 * would move a late sale into the next day's totals and, at a period boundary, into a period that has
 * already been filed.
 */
/**
 * ## Why every figure here is a `bigint`
 *
 * The `fils` domain is `bigint`, and `packages/db/src/connection.ts` returns bigint as a **string** for a
 * stated reason: nothing may silently round a money figure. Summing those strings into a JavaScript
 * `number` puts the rounding straight back — and not harmlessly, because the debit side and the credit
 * side round independently. This file was written with `number` and its own test caught it: a ledger
 * containing 2^53 + 1 fils on each side reported a difference of **-4 fils**, out of nothing.
 *
 * 2^53 fils is about 900 billion dirhams, so no real balance will reach it. That is not the argument. The
 * argument is that a trial balance is the function every later gate asserts against, and one that can
 * report a non-zero difference for a ledger that balances is a gate that can fire on a sound ledger — and
 * the first person to see it will go looking for a missing posting that does not exist.
 */
export interface TrialBalanceRow {
  readonly accountCode: string
  readonly accountName: string
  readonly accountType: string
  /** Cumulative debits in integer fils. */
  readonly debitFils: bigint
  readonly creditFils: bigint
  /**
   * `debit - credit`. Signed, and signed deliberately: an account's *natural* side is a property of
   * the account, and folding it in here would make a contra-asset read as a liability.
   */
  readonly balanceFils: bigint
}

export interface TrialBalance {
  readonly asAt: string
  readonly rows: readonly TrialBalanceRow[]
  readonly totalDebitFils: bigint
  readonly totalCreditFils: bigint
  /**
   * `totalDebit - totalCredit`. Zero in a sound ledger, and the only figure anybody looks at first.
   *
   * Reported rather than asserted. A trial balance that threw when it did not balance would be a
   * diagnostic that refuses to run at exactly the moment somebody needs it; the caller asserts, and
   * `isBalanced` below is the assertion.
   */
  readonly differenceFils: bigint
}

export async function trialBalanceAsAt(sql: Sql, asAt: string): Promise<TrialBalance> {
  const rows = (await sql`
    select l.account_code,
           a.name        as account_name,
           a.type        as account_type,
           sum(l.debit_fils)::text  as debit_fils,
           sum(l.credit_fils)::text as credit_fils
    from journal_line l
    join journal_entry e on e.entry_id = l.entry_id
    join account a on a.code = l.account_code
    where e.entry_date <= ${asAt}::date
    group by l.account_code, a.name, a.type
    having sum(l.debit_fils) <> 0 or sum(l.credit_fils) <> 0
    order by l.account_code
  `) as unknown as {
    account_code: string
    account_name: string
    account_type: string
    debit_fils: string
    credit_fils: string
  }[]

  const mapped = rows.map((row) => {
    // `sum()` over bigint returns numeric, and the driver hands it back as a string precisely so a value
    // beyond 2^53 cannot be silently rounded. `BigInt`, not `Number`, for the same reason.
    const debitFils = BigInt(row.debit_fils)
    const creditFils = BigInt(row.credit_fils)
    return {
      accountCode: row.account_code,
      accountName: row.account_name,
      accountType: row.account_type,
      debitFils,
      creditFils,
      balanceFils: debitFils - creditFils,
    }
  })

  const totalDebitFils = mapped.reduce((sum, row) => sum + row.debitFils, 0n)
  const totalCreditFils = mapped.reduce((sum, row) => sum + row.creditFils, 0n)

  return {
    asAt,
    rows: mapped,
    totalDebitFils,
    totalCreditFils,
    differenceFils: totalDebitFils - totalCreditFils,
  }
}

/** True when debits equal credits exactly. Exactly: fils are integers and there is no tolerance. */
export function isBalanced(balance: TrialBalance): boolean {
  return balance.differenceFils === 0n
}

/**
 * The movement between two dates: the later position minus the earlier one.
 *
 * `from` is **exclusive** and `to` inclusive, so consecutive periods neither overlap nor leave a gap —
 * the shape that makes twelve monthly movements sum to the annual one. A closed range would count the
 * boundary date in both periods, which is the classic off-by-one in a financial report and shows up as
 * a year that does not add up to its months.
 */
export async function trialBalanceMovement(
  sql: Sql,
  fromExclusive: string,
  toInclusive: string,
): Promise<TrialBalance> {
  const [opening, closing] = await Promise.all([
    trialBalanceAsAt(sql, fromExclusive),
    trialBalanceAsAt(sql, toInclusive),
  ])

  const openingByCode = new Map(opening.rows.map((row) => [row.accountCode, row]))
  const rows = closing.rows
    .map((row) => {
      const before = openingByCode.get(row.accountCode)
      const debitFils = row.debitFils - (before?.debitFils ?? 0n)
      const creditFils = row.creditFils - (before?.creditFils ?? 0n)
      return { ...row, debitFils, creditFils, balanceFils: debitFils - creditFils }
    })
    .filter((row) => row.debitFils !== 0n || row.creditFils !== 0n)

  const totalDebitFils = rows.reduce((sum, row) => sum + row.debitFils, 0n)
  const totalCreditFils = rows.reduce((sum, row) => sum + row.creditFils, 0n)
  return {
    asAt: toInclusive,
    rows,
    totalDebitFils,
    totalCreditFils,
    differenceFils: totalDebitFils - totalCreditFils,
  }
}
