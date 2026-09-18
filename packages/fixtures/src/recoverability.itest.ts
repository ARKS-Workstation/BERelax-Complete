import {
  ACCOUNTS,
  accountFor,
  BLOCKED_INPUT_VAT_CATEGORIES,
  billEntryDraft,
  blockedInputVatAccounts,
  crossesMidnight,
  deriveBill,
  filsFrom,
  instantFromIso,
  type LocalDate,
  localTime,
  money,
  recoverabilityOf,
  resolveTradingDate,
  STANDARD_SPA_CHART,
  vatBearingTreatmentFor,
} from '@berelax/core'
import {
  blockedInputVatAccountCodes,
  blockedInputVatLines,
  createConnection,
  disclosureFor,
  INPUT_VAT_NON_RECOVERY_REASONS,
  inputVatRecovery,
  isBalanced,
  isBlockedRecoverabilityRefusal,
  type PostedBill,
  postBill,
  purchaseError,
  readAccountClassification,
  readBill,
  reclassifyAccountRecoverability,
  recordSupplier,
  type Sql,
  trialBalanceAsAt,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_CLOSE, FIXTURE_OPEN } from './clock.ts'
import { FIXTURE_SUPPLIERS } from './purchases.ts'
import {
  RECOVERABILITY_ACCOUNT_CLASSIFICATIONS,
  RECOVERABILITY_BILL_SHAPES,
  RECOVERABILITY_ENTRY_DATE,
  RECOVERABILITY_ENTRY_INSTANT_ISO,
  RECOVERABILITY_PERIOD,
  RECOVERABILITY_TOTAL_GROSS_FILS,
  RECOVERABILITY_WORKED_EXAMPLE,
  type RecoverabilityBillShape,
  recoverabilityShape,
} from './recoverability.ts'

/**
 * M-VAT-02 — the classification, the posting and the working paper, against real PostgreSQL.
 *
 * It lives in `@berelax/fixtures` because it compares `core`'s classification against `db`'s rows and
 * `db`'s posting against `core`'s derivation, and fixtures is the one package allowed to depend on both —
 * `db` must never import `core`.
 *
 * What is proved here and nowhere else:
 *
 *   1. **The blocked population is the same on both sides.** `blockedInputVatAccounts` in core and
 *      `vat_box = 'blocked_input_tax'` in the database are two statements of one classification, and a
 *      chart that disagreed with the seed would produce a return nobody could reconcile.
 *   2. **A blocked line posts its VAT to the expense and zero to 1080**, for every blocked account in the
 *      chart, and the entry still balances.
 *   3. **The period's claim excludes every blocked line and matches the committed worked example**, with
 *      an entertainment bill in it.
 *   4. **Reclassifying an account cannot alter a posted line.** The one that would be a silent restatement
 *      of a filed period.
 *   5. **The blocked bill appears under an explicit non-recoverable disclosure**, non-zero, rather than
 *      being absent from the return.
 *
 * Nothing here deletes a bill or a posting — both are append-only and refuse the owner too (ADR 0008) — so
 * every total is a delta over this suite's own writes, and every supplier code carries a per-run suffix.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const ACTOR = { kind: 'system', label: 'm-vat-02-itest' } as const
const RUN = Date.now().toString(36)
const codeFor = (fixtureCode: string) => `${fixtureCode}-mvat02-${RUN}`
const referenceFor = (supplierReference: string) => `${supplierReference}-${RUN}`

/** The fixture salon trades 11:00–02:00, which is what makes 01:30 the previous trading day. */
const FIXTURE_HOURS = { open: localTime(FIXTURE_OPEN), close: localTime(FIXTURE_CLOSE) }
const hoursFor = () => FIXTURE_HOURS

let sql: Sql
let entryDate: LocalDate
const supplierIds = new Map<string, string>()
const posted = new Map<string, PostedBill>()
let openingBalance = { debit: 0n, credit: 0n }
/** The working paper before this suite wrote anything, so every figure below can be a delta. */
let before = { recoverable: 0n, blocked: 0n }

async function post(bill: Parameters<typeof postBill>[1]): Promise<PostedBill> {
  try {
    return await withUnitOfWork(sql, ACTOR, (uow) => postBill(uow, bill))
  } catch (err) {
    throw purchaseError(err) ?? err
  }
}

/** The error a call raised, or undefined when it was accepted. */
async function rejection(run: () => Promise<unknown>): Promise<Error | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return error as Error
  }
}

function derive(shape: RecoverabilityBillShape) {
  return deriveBill(
    shape.lines.map((line) => ({
      description: line.description,
      account: line.account,
      gross: money(filsFrom(line.grossFils)),
      treatment: line.treatment,
    })),
  )
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  // The entry date is RESOLVED, not asserted: 01:30 on 16 December belongs to the 15th's session, and a
  // truncated instant would file these bills in the next VAT period — the one nobody has filed yet.
  expect(crossesMidnight(FIXTURE_HOURS)).toBe(true)
  const resolved = resolveTradingDate(instantFromIso(RECOVERABILITY_ENTRY_INSTANT_ISO), hoursFor)
  expect(resolved.kind).toBe('trading')
  entryDate = (resolved as { date: LocalDate }).date
  expect(entryDate).toBe(RECOVERABILITY_ENTRY_DATE)

  const trial = await trialBalanceAsAt(sql, RECOVERABILITY_PERIOD.to)
  openingBalance = { debit: trial.totalDebitFils, credit: trial.totalCreditFils }
  const paperBefore = await inputVatRecovery(sql, {
    from: RECOVERABILITY_PERIOD.from,
    to: RECOVERABILITY_PERIOD.to,
  })
  before = {
    recoverable: paperBefore.recoverableInputVatFils,
    blocked: paperBefore.blockedInputVatFils,
  }

  for (const supplier of FIXTURE_SUPPLIERS) {
    const record = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordSupplier(uow, {
        code: codeFor(supplier.code),
        legalName: supplier.legalName,
        residency: supplier.residency,
        placeOfSupplyRule: supplier.placeOfSupplyRule,
        trn: supplier.trn,
      }),
    )
    supplierIds.set(supplier.code, record.supplierId)
  }

  for (const shape of RECOVERABILITY_BILL_SHAPES) {
    const derived = derive(shape)
    posted.set(
      shape.supplierReference,
      await post({
        supplierId: supplierIds.get(shape.supplierCode) as string,
        supplierReference: referenceFor(shape.supplierReference),
        billDate: RECOVERABILITY_ENTRY_DATE,
        dueDate: RECOVERABILITY_ENTRY_DATE,
        entryDate,
        receivedBy: 'm-vat-02-itest',
        lines: derived.lines.map((line) => ({
          description: line.description,
          expenseAccountCode: line.account,
          taxTreatment: line.treatment,
          vatRateBp: line.rateBp,
          grossFils: line.gross.fils,
          netFils: line.net.fils,
        })),
      }),
    )
  }
}, 120_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('the blocked population is the same in core and in the database', () => {
  it('names the same accounts on both sides, and the seed is not merely non-empty', async () => {
    const fromDb = await blockedInputVatAccountCodes(sql)
    const fromCore = blockedInputVatAccounts(STANDARD_SPA_CHART)
      .map((account) => account.code as string)
      .sort()
    expect([...fromDb]).toEqual(fromCore)
    expect(fromDb.length).toBeGreaterThan(0)
    // The two the categories name, by code, so a chart that dropped one fails here rather than in a
    // return six months later.
    expect([...fromDb]).toContain(ACCOUNTS.entertainment as string)
    expect([...fromDb]).toContain(ACCOUNTS.staffAccommodation as string)
    // Every category in core points at an account the database agrees is blocked.
    for (const category of BLOCKED_INPUT_VAT_CATEGORIES) {
      const stored = await readAccountClassification(sql, category.account as string)
      expect(stored?.recoverability, category.id).toBe('blocked')
      expect(stored?.inputVatRecoverable, category.id).toBe(false)
    }
  })

  it('agrees with core on the classification of every account in the chart', async () => {
    // The pure derivation and the SQL CASE in 0034 are two statements of one rule. Compared over every
    // account rather than the blocked ones, because the rule that matters for an over-claim is which
    // accounts are *recoverable*.
    for (const account of STANDARD_SPA_CHART.accounts) {
      const stored = await readAccountClassification(sql, account.code as string)
      expect(stored?.recoverability, account.code as string).toBe(recoverabilityOf(account))
    }
    // And the committed expectations, which neither side computed.
    for (const { account, recoverability } of RECOVERABILITY_ACCOUNT_CLASSIFICATIONS) {
      const stored = await readAccountClassification(sql, account as string)
      expect(stored?.recoverability, account as string).toBe(recoverability)
    }
  })

  it('leaves input_vat_recoverable NOT NULL with no default, so an account cannot omit it', async () => {
    const [column] = await sql<{ is_nullable: string; column_default: string | null }[]>`
      select is_nullable, column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'account'
        and column_name = 'input_vat_recoverable'
    `
    expect(column?.is_nullable).toBe('NO')
    // No default: defaulting it true over-claims on entertainment and defaulting it false under-claims on
    // rent, so there is no safe value to pick and a row that never stated it must fail to exist. The
    // known-bad INSERT that proves the refusal is in scripts/test-gates.mjs.
    expect(column?.column_default).toBeNull()

    // The control: the same query over a column that DOES carry a default returns one, so the assertion
    // above is reading the catalogue rather than an empty result.
    const [withDefault] = await sql<{ column_default: string | null }[]>`
      select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'bill_line'
        and column_name = 'blocked_input_vat_fils'
    `
    expect(withDefault?.column_default).not.toBeNull()
  })

  it('enumerates the whole chart and finds no expense account unclassified', async () => {
    // The acceptance criterion in full, against the database rather than the TypeScript: every expense
    // account states a recovery position. An unclassified expense drops out of the claim silently, and
    // the entries still balance.
    const rows = await sql<{ code: string }[]>`
      select code from account
      where type = 'expense' and input_vat_recoverable is null
    `
    expect(rows).toEqual([])
    // Vacuity guard: there ARE expense accounts to have found. A `where` that matched nothing because the
    // table was empty would satisfy the assertion above.
    const [counted] = await sql<{ n: string }[]>`
      select count(*)::text as n from account where type = 'expense'
    `
    expect(Number(counted?.n)).toBeGreaterThan(20)
  })
})

describe('a blocked line posts its VAT to the expense and nothing to the claim', () => {
  it.each(
    blockedInputVatAccounts(STANDARD_SPA_CHART).map(
      (account) => [account.code as string, account] as const,
    ),
  )('%s posts the whole gross to the expense', async (code, account) => {
    // Table-driven over the chart, not over the fixture list: the day somebody adds a blocked account,
    // this case runs for it and fails if nothing posts to it.
    const shape = RECOVERABILITY_BILL_SHAPES.find((candidate) =>
      candidate.lines.some(
        (line) => line.account === account.code && line.treatment === 'blocked_not_recoverable',
      ),
    )
    expect(shape, code).toBeDefined()
    const bill = posted.get((shape as RecoverabilityBillShape).supplierReference) as PostedBill
    const blockedLines = bill.lines.filter((line) => line.expenseAccountCode === code)
    expect(blockedLines.length, code).toBeGreaterThan(0)
    for (const line of blockedLines) {
      expect(line.taxTreatment, code).toBe('blocked_not_recoverable')
      // The whole of the acceptance criterion: the VAT is in the expense debit, and the claim is zero.
      expect(line.recoverableInputVatFils, code).toBe(0)
      expect(line.blockedInputVatFils, code).toBeGreaterThan(0)
      expect(line.expenseDebitFils, code).toBe(line.netFils + line.blockedInputVatFils)
      expect(line.expenseDebitFils, code).toBe(line.grossFils)
    }

    // Read back through the entry: the expense account was debited the gross, and 1080 does not appear.
    const entryLines = await sql<{ account_code: string; debit_fils: string }[]>`
      select account_code, debit_fils::text as debit_fils from journal_line
      where entry_id = ${bill.entryId} order by line_no
    `
    const debited = new Map(entryLines.map((row) => [row.account_code, BigInt(row.debit_fils)]))
    const expectedDebit = blockedLines.reduce((total, line) => total + line.grossFils, 0)
    expect(debited.get(code)).toBe(BigInt(expectedDebit))
    if (bill.recoverableInputVatFils === 0) {
      // No zero line either: a zero posting is a line somebody forgot to fill in, and
      // journal_line_exactly_one_side refuses it.
      expect(debited.has('1080')).toBe(false)
    }
  })

  it.each(RECOVERABILITY_BILL_SHAPES.map((shape) => [shape.supplierReference, shape] as const))(
    '%s stores the committed figures and the journal core describes',
    async (reference, shape) => {
      const bill = posted.get(reference) as PostedBill
      expect(bill.netFils).toBe(shape.expected.netFils)
      expect(bill.vatFils).toBe(shape.expected.vatFils)
      expect(bill.grossFils).toBe(shape.expected.grossFils)
      expect(bill.recoverableInputVatFils).toBe(shape.expected.recoverableInputVatFils)
      expect(bill.blockedInputVatFils).toBe(shape.expected.blockedInputVatFils)
      // The header's VAT partitions into the claim and the disclosure exactly — the equality the deferred
      // totals trigger proves against the rows themselves.
      expect(bill.recoverableInputVatFils + bill.blockedInputVatFils).toBe(bill.vatFils)

      const draft = billEntryDraft({
        entryId: bill.entryId,
        entryDate,
        narrative: `Supplier bill ${bill.displayNumber}`,
        bill: derive(shape),
      })
      const entryLines = await sql<
        { account_code: string; debit_fils: string; credit_fils: string }[]
      >`
        select account_code, debit_fils::text as debit_fils, credit_fils::text as credit_fils
        from journal_line where entry_id = ${bill.entryId} order by line_no
      `
      const stored = entryLines.map((row) => [
        row.account_code,
        row.debit_fils === '0' ? 'credit' : 'debit',
        Number(row.debit_fils === '0' ? row.credit_fils : row.debit_fils),
      ])
      // `postBill` built these rows without importing core; `billEntryDraft` built the comparison without
      // touching a database. Two statements of one posting rule, compared line for line.
      expect(stored).toEqual(draft.lines.map((line) => [line.account, line.side, line.amount.fils]))
      // And the committed expectation, which neither half computed.
      expect(stored).toEqual(
        shape.expected.journalLines.map(([account, side, fils]) => [account, side, fils]),
      )

      // The stored row, re-read: the database's own copy agrees with what postBill returned.
      const reread = await readBill(sql, bill.billId)
      expect(reread?.blockedInputVatFils).toBe(shape.expected.blockedInputVatFils)
      expect(reread?.lines.map((line) => line.blockedInputVatFils)).toEqual(
        bill.lines.map((line) => line.blockedInputVatFils),
      )
    },
  )

  it('leaves the ledger balanced and moves exactly the gross of every shape', async () => {
    const after = await trialBalanceAsAt(sql, RECOVERABILITY_PERIOD.to)
    expect(isBalanced(after)).toBe(true)
    // A delta: other suites post into this ledger and nothing here can be deleted (ADR 0008). Blocked VAT
    // does not change the total that moves — it changes which account holds it.
    expect(after.totalDebitFils - openingBalance.debit).toBe(
      BigInt(RECOVERABILITY_TOTAL_GROSS_FILS),
    )
    expect(after.totalCreditFils - openingBalance.credit).toBe(
      BigInt(RECOVERABILITY_TOTAL_GROSS_FILS),
    )
  })
})

describe('the period claims the committed total and discloses the rest', () => {
  it('matches the worked example to the fils, excluding every blocked line', async () => {
    const paper = await inputVatRecovery(sql, {
      from: RECOVERABILITY_PERIOD.from,
      to: RECOVERABILITY_PERIOD.to,
    })
    // Deltas, because the integration suite shares one database: a foreign bill in December would show up
    // as a failure of these two rather than quietly inflating a total that still looked plausible.
    expect(paper.recoverableInputVatFils - before.recoverable).toBe(
      BigInt(RECOVERABILITY_WORKED_EXAMPLE.recoverableInputVatFils),
    )
    expect(paper.blockedInputVatFils - before.blocked).toBe(
      BigInt(RECOVERABILITY_WORKED_EXAMPLE.blockedInputVatFils),
    )
    // The over-claim this unit prevents, named: the whole VAT of the period, which is what a return that
    // read `vat_fils` would put in the box.
    const allVat = paper.recoverableInputVatFils + paper.blockedInputVatFils
    expect(allVat).not.toBe(paper.recoverableInputVatFils)
    expect(allVat - before.recoverable - before.blocked).toBe(
      BigInt(
        RECOVERABILITY_WORKED_EXAMPLE.recoverableInputVatFils +
          RECOVERABILITY_WORKED_EXAMPLE.blockedInputVatFils,
      ),
    )
  })

  it('carries an explicit non-recoverable disclosure line that is present and non-zero', async () => {
    const paper = await inputVatRecovery(sql, {
      from: RECOVERABILITY_PERIOD.from,
      to: RECOVERABILITY_PERIOD.to,
      supplierCode: codeFor('fixture-registered-consumables'),
    })
    // Scoped to one of this run's suppliers, so the rows are this suite's alone and can be asserted
    // absolutely rather than as a delta.
    const blocked = disclosureFor(paper, 'blocked_category')
    // The acceptance criterion in full: the blocked bill appears UNDER A DISCLOSURE LINE, and that line is
    // non-zero — not absent from the return, which is what dropping the bill would look like.
    expect(blocked.lineCount).toBe(2)
    expect(blocked.nonRecoverableVatFils).toBe(1_000n + 200n)
    expect(blocked.netFils).toBe(20_000n + 4_000n)
    expect(blocked.grossFils).toBe(21_000n + 4_200n)

    // Every reason is a row, always, in report order. A reason with nothing in it is a zero rather than a
    // gap: "we claimed nothing on entertainment" has to be visible to be evidence.
    expect(paper.disclosures.map((row) => row.reason)).toEqual([...INPUT_VAT_NON_RECOVERY_REASONS])
    expect(disclosureFor(paper, 'no_supplier_trn').lineCount).toBe(0)
    expect(disclosureFor(paper, 'no_supplier_trn').nonRecoverableVatFils).toBe(0n)

    // The three reasons are not interchangeable, over the whole run: tax the business bore is a different
    // answer from expenditure that never carried tax.
    const all = await inputVatRecovery(sql, {
      from: RECOVERABILITY_PERIOD.from,
      to: RECOVERABILITY_PERIOD.to,
      supplierCode: codeFor('fixture-unregistered-laundry'),
    })
    expect(disclosureFor(all, 'no_supplier_trn').lineCount).toBe(1)
    expect(disclosureFor(all, 'no_supplier_trn').netFils).toBe(63_000n)
    // No VAT was charged, so nothing was blocked — the distinction a single "not recoverable" bucket
    // cannot make.
    expect(disclosureFor(all, 'no_supplier_trn').nonRecoverableVatFils).toBe(0n)
    expect(disclosureFor(all, 'blocked_category').lineCount).toBe(0)
  })

  it('drills every blocked fils down to the line and the document that produced it', async () => {
    const lines = await blockedInputVatLines(sql, {
      from: RECOVERABILITY_PERIOD.from,
      to: RECOVERABILITY_PERIOD.to,
      supplierCode: codeFor('fixture-registered-landlord'),
    })
    expect(lines.map((line) => line.accountCode)).toEqual([ACCOUNTS.staffAccommodation as string])
    const transport = lines[0]
    expect(transport?.blockedInputVatFils).toBe(2_500n)
    expect(transport?.entryDate).toBe(RECOVERABILITY_ENTRY_DATE)
    expect(transport?.supplierReference).toBe(referenceFor('FIX-BLOCK-TRANSPORT-0001'))
    // The reference reaches a real bill, so the disclosure is traceable rather than a number to be taken
    // on trust.
    expect(transport?.reference).toBe(
      posted.get('FIX-BLOCK-TRANSPORT-0001')?.displayNumber as string,
    )

    // The sum of the drill-down is the disclosure figure. A detail that does not tie to the summary is
    // worse than a summary that is merely wrong.
    const paper = await inputVatRecovery(sql, {
      from: RECOVERABILITY_PERIOD.from,
      to: RECOVERABILITY_PERIOD.to,
      supplierCode: codeFor('fixture-registered-landlord'),
    })
    expect(lines.reduce((total, line) => total + line.blockedInputVatFils, 0n)).toBe(
      disclosureFor(paper, 'blocked_category').nonRecoverableVatFils,
    )
  })

  it('reads the period from the business day, not the supplier tax point', async () => {
    // The bills are dated 15 December and entered on the 15th's trading day, so a window that excludes
    // the entry date returns nothing of this run's — which is what makes the period filter real.
    const outside = await inputVatRecovery(sql, {
      from: '2026-11-01',
      to: '2026-11-30',
      supplierCode: codeFor('fixture-registered-consumables'),
    })
    expect(outside.recoverableInputVatFils).toBe(0n)
    expect(outside.blockedInputVatFils).toBe(0n)
    expect(outside.accounts).toEqual([])
    // And a period read backwards is refused rather than returning an empty report that looks like a
    // quarter with no purchases in it.
    await expect(inputVatRecovery(sql, { from: '2026-12-31', to: '2026-12-01' })).rejects.toThrow(
      /before it starts/,
    )
  })
})

describe('reclassifying an account cannot alter a posted line', () => {
  it('changes the chart, records an audit row, and leaves every posted figure untouched', async () => {
    const paperBefore = await inputVatRecovery(sql, {
      from: RECOVERABILITY_PERIOD.from,
      to: RECOVERABILITY_PERIOD.to,
      supplierCode: codeFor('fixture-registered-landlord'),
    })
    const billBefore = await readBill(
      sql,
      (posted.get('FIX-BLOCK-TRANSPORT-0001') as PostedBill).billId,
    )
    const [auditBefore] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
      where action = 'ledger.account.recoverability_reclassified' and entity_id = '5060'
    `

    // The change Y11-blocked-vat will one day make: the tax agent confirms a contractual obligation to
    // transport staff, so staff accommodation and transport becomes recoverable.
    const after = await withUnitOfWork(sql, ACTOR, (uow) =>
      reclassifyAccountRecoverability(uow, {
        code: ACCOUNTS.staffAccommodation as string,
        vatBox: 'recoverable_input_tax',
        inputVatRecoverable: true,
        reason: 'm-vat-02 itest: Y11-blocked-vat answered — obligation confirmed in the contract',
        openQuestionId: 'Y11-blocked-vat',
      }),
    )
    try {
      expect(after.recoverability).toBe('recoverable')
      expect((await readAccountClassification(sql, '5060'))?.recoverability).toBe('recoverable')

      // An audited change: one row, naming the before, the after and the reason.
      const [audited] = await sql<{ n: string; before_state: unknown; after_state: unknown }[]>`
        select count(*)::text as n,
               min(before_state::text) as before_state,
               min(after_state::text)  as after_state
        from audit_event
        where action = 'ledger.account.recoverability_reclassified' and entity_id = '5060'
      `
      expect(Number(audited?.n) - Number(auditBefore?.n)).toBe(1)
      expect(String(audited?.before_state)).toContain('blocked')
      expect(String(audited?.after_state)).toContain('Y11-blocked-vat')

      // THE POINT. The posted line keeps the treatment and the figures it was recorded with, and the
      // period's working paper does not move — a return recomputing recoverability from today's chart
      // would have just restated a filed period.
      const billAfter = await readBill(
        sql,
        (posted.get('FIX-BLOCK-TRANSPORT-0001') as PostedBill).billId,
      )
      expect(billAfter).toEqual(billBefore)
      expect(billAfter?.lines[0]?.taxTreatment).toBe('blocked_not_recoverable')
      expect(billAfter?.lines[0]?.blockedInputVatFils).toBe(2_500)
      expect(billAfter?.lines[0]?.recoverableInputVatFils).toBe(0)

      const paperAfter = await inputVatRecovery(sql, {
        from: RECOVERABILITY_PERIOD.from,
        to: RECOVERABILITY_PERIOD.to,
        supplierCode: codeFor('fixture-registered-landlord'),
      })
      expect(paperAfter.recoverableInputVatFils).toBe(paperBefore.recoverableInputVatFils)
      expect(paperAfter.blockedInputVatFils).toBe(paperBefore.blockedInputVatFils)
      expect(disclosureFor(paperAfter, 'blocked_category').nonRecoverableVatFils).toBe(
        disclosureFor(paperBefore, 'blocked_category').nonRecoverableVatFils,
      )
      // The label DID move, which is the control: the working paper shows the account's classification
      // today, and if nothing about the query had changed the assertions above would be vacuous.
      expect(paperAfter.accounts.find((row) => row.accountCode === '5060')?.recoverabilityNow).toBe(
        'recoverable',
      )
      expect(
        paperBefore.accounts.find((row) => row.accountCode === '5060')?.recoverabilityNow,
      ).toBe('blocked')

      // And the reclassification takes effect for the NEXT bill: with 5060 recoverable, a blocked line on
      // it is now refused and a claim on it is allowed.
      const refused = await rejection(() =>
        post({
          supplierId: supplierIds.get('fixture-registered-landlord') as string,
          supplierReference: referenceFor('FIX-AFTER-RECLASSIFY'),
          billDate: RECOVERABILITY_ENTRY_DATE,
          dueDate: RECOVERABILITY_ENTRY_DATE,
          entryDate,
          receivedBy: 'm-vat-02-itest',
          lines: [
            {
              description: 'Staff transport, after the reclassification',
              expenseAccountCode: ACCOUNTS.staffAccommodation as string,
              taxTreatment: 'blocked_not_recoverable',
              vatRateBp: 500,
              grossFils: 10_500,
              netFils: 10_000,
            },
          ],
        }),
      )
      expect(refused?.message).toContain('blocked_not_recoverable')
      expect(refused?.message).toContain('recoverable rather than a blocked category')
    } finally {
      // Put it back. The conservative classification is what the chart ships with, and leaving this suite's
      // experiment behind would make every later suite's bill on 5060 recoverable — including another
      // unit's, on somebody else's branch.
      await withUnitOfWork(sql, ACTOR, (uow) =>
        reclassifyAccountRecoverability(uow, {
          code: ACCOUNTS.staffAccommodation as string,
          vatBox: 'blocked_input_tax',
          inputVatRecoverable: false,
          reason: 'm-vat-02 itest: restoring the shipped conservative classification',
          openQuestionId: 'Y11-blocked-vat',
        }),
      )
    }
    expect((await readAccountClassification(sql, '5060'))?.recoverability).toBe('blocked')
  })

  it('refuses a reclassification that changes nothing, and one with no stated reason', async () => {
    const noop = await rejection(() =>
      withUnitOfWork(sql, ACTOR, (uow) =>
        reclassifyAccountRecoverability(uow, {
          code: ACCOUNTS.entertainment as string,
          vatBox: 'blocked_input_tax',
          inputVatRecoverable: false,
          reason: 'no change at all',
        }),
      ),
    )
    expect(noop?.message).toContain('Nothing to reclassify')

    const unexplained = await rejection(() =>
      withUnitOfWork(sql, ACTOR, (uow) =>
        reclassifyAccountRecoverability(uow, {
          code: ACCOUNTS.entertainment as string,
          vatBox: 'recoverable_input_tax',
          inputVatRecoverable: true,
          reason: '   ',
        }),
      ),
    )
    expect(unexplained?.message).toContain('needs a stated reason')
    // Neither wrote anything: entertainment is still blocked, which is the assertion that makes the two
    // refusals above more than a message.
    expect((await readAccountClassification(sql, '6090'))?.recoverability).toBe('blocked')

    // And a code that is not in the chart is a migration, not a reclassification.
    const unknown = await rejection(() =>
      withUnitOfWork(sql, ACTOR, (uow) =>
        reclassifyAccountRecoverability(uow, {
          code: '9999',
          vatBox: null,
          inputVatRecoverable: false,
          reason: 'there is no such account',
        }),
      ),
    )
    expect(unknown?.message).toContain('No account "9999"')
  })
})

describe('the classification refuses the over-claim before anything is written', () => {
  it('refuses a claim on a blocked account, naming the account and the alternative', async () => {
    const [billsBefore] = await sql<{ n: string }[]>`select count(*)::text as n from bill`
    const refused = await rejection(() =>
      post({
        supplierId: supplierIds.get('fixture-registered-consumables') as string,
        supplierReference: referenceFor('FIX-OVERCLAIM'),
        billDate: RECOVERABILITY_ENTRY_DATE,
        dueDate: RECOVERABILITY_ENTRY_DATE,
        entryDate,
        receivedBy: 'm-vat-02-itest',
        lines: [
          {
            description: 'Customer refreshments, claimed by mistake',
            expenseAccountCode: ACCOUNTS.entertainment as string,
            taxTreatment: 'standard_recoverable',
            vatRateBp: 500,
            grossFils: 21_000,
            netFils: 20_000,
          },
        ],
      }),
    )
    // The bill would have posted, balanced and over-claimed 1,000 fils. Neither existing layer sees it:
    // the TRN is present and the arithmetic is right.
    expect(refused?.message).toContain('6090')
    expect(refused?.message).toContain('Entertainment and staff hospitality')
    expect(refused?.message).toContain('blocked_not_recoverable')
    expect(isBlockedRecoverabilityRefusal(refused)).toBe(true)
    // Nothing was written, which is a claim about the whole transaction rather than about the bill row.
    const [billsAfter] = await sql<{ n: string }[]>`select count(*)::text as n from bill`
    expect(billsAfter?.n).toBe(billsBefore?.n)

    // The control: the identical bill on a recoverable account posts. A guard that refused every claim
    // would satisfy the refusal above and leave the whole purchase ledger unclaimable.
    const accepted = await post({
      supplierId: supplierIds.get('fixture-registered-consumables') as string,
      supplierReference: referenceFor('FIX-OVERCLAIM-CONTROL'),
      billDate: RECOVERABILITY_ENTRY_DATE,
      dueDate: RECOVERABILITY_ENTRY_DATE,
      entryDate,
      receivedBy: 'm-vat-02-itest',
      lines: [
        {
          description: 'Treatment consumables',
          expenseAccountCode: ACCOUNTS.consumablesUsed as string,
          taxTreatment: 'standard_recoverable',
          vatRateBp: 500,
          grossFils: 21_000,
          netFils: 20_000,
        },
      ],
    })
    expect(accepted.recoverableInputVatFils).toBe(1_000)
  })

  it('refuses a claim on an out-of-scope account too, which is a different classification', async () => {
    const refused = await rejection(() =>
      post({
        supplierId: supplierIds.get('fixture-registered-landlord') as string,
        supplierReference: referenceFor('FIX-OUTSCOPE-CLAIM'),
        billDate: RECOVERABILITY_ENTRY_DATE,
        dueDate: RECOVERABILITY_ENTRY_DATE,
        entryDate,
        receivedBy: 'm-vat-02-itest',
        lines: [
          {
            description: 'Municipality fee, claimed by mistake',
            expenseAccountCode: ACCOUNTS.licenceAndGovernmentFees as string,
            taxTreatment: 'standard_recoverable',
            vatRateBp: 500,
            grossFils: 21_000,
            netFils: 20_000,
          },
        ],
      }),
    )
    expect(refused?.message).toContain('out_of_scope')
    expect(refused?.message).toContain('the amount is cost')
    expect(isBlockedRecoverabilityRefusal(refused)).toBe(true)
  })

  it('refuses a blocked line whose account is not a blocked category', async () => {
    const refused = await rejection(() =>
      post({
        supplierId: supplierIds.get('fixture-registered-landlord') as string,
        supplierReference: referenceFor('FIX-BLOCKED-ON-RENT'),
        billDate: RECOVERABILITY_ENTRY_DATE,
        dueDate: RECOVERABILITY_ENTRY_DATE,
        entryDate,
        receivedBy: 'm-vat-02-itest',
        lines: [
          {
            description: 'Rent, recorded blocked by mistake',
            expenseAccountCode: ACCOUNTS.rent as string,
            taxTreatment: 'blocked_not_recoverable',
            vatRateBp: 500,
            grossFils: 21_000,
            netFils: 20_000,
          },
        ],
      }),
    )
    // The under-claim: money left on the table. It is not a compliance failure, and it is still wrong, and
    // the account is what decides the category.
    expect(refused?.message).toContain('6010')
    expect(refused?.message).toContain('recoverable rather than a blocked category')
    expect(isBlockedRecoverabilityRefusal(refused)).toBe(true)
    // And core answers the same question the same way, which is what keeps the two statements of the rule
    // in step.
    expect(vatBearingTreatmentFor(accountFor(STANDARD_SPA_CHART, ACCOUNTS.rent))).toBe(
      'standard_recoverable',
    )
  })

  it('refuses a blocked line from a supplier with no TRN, because only a registered one charges VAT', async () => {
    const refused = await rejection(() =>
      post({
        supplierId: supplierIds.get('fixture-unregistered-laundry') as string,
        supplierReference: referenceFor('FIX-BLOCKED-NO-TRN'),
        billDate: RECOVERABILITY_ENTRY_DATE,
        dueDate: RECOVERABILITY_ENTRY_DATE,
        entryDate,
        receivedBy: 'm-vat-02-itest',
        lines: [
          {
            description: 'Refreshments from an unregistered supplier',
            expenseAccountCode: ACCOUNTS.entertainment as string,
            taxTreatment: 'blocked_not_recoverable',
            vatRateBp: 500,
            grossFils: 21_000,
            netFils: 20_000,
          },
        ],
      }),
    )
    // The rule M-VAT-01 already owns, reused rather than restated: no TRN, no tax invoice, and the whole
    // amount is cost. A blocked figure standing on no tax invoice would overstate the disclosure.
    expect(refused?.message).toContain('carries UAE VAT on line(s) 1')
    expect(refused?.message).toContain('held no TRN')
    expect(refused?.message).toContain('no_trn_not_recoverable')

    // The control: the same bill recorded as no_trn_not_recoverable posts, which is the other half of
    // M-VAT-01's point — a bill from an unregistered supplier stays postable.
    const accepted = await post({
      supplierId: supplierIds.get('fixture-unregistered-laundry') as string,
      supplierReference: referenceFor('FIX-BLOCKED-NO-TRN-CONTROL'),
      billDate: RECOVERABILITY_ENTRY_DATE,
      dueDate: RECOVERABILITY_ENTRY_DATE,
      entryDate,
      receivedBy: 'm-vat-02-itest',
      lines: [
        {
          description: 'Refreshments from an unregistered supplier',
          expenseAccountCode: ACCOUNTS.entertainment as string,
          taxTreatment: 'no_trn_not_recoverable',
          grossFils: 21_000,
          netFils: 21_000,
        },
      ],
    })
    expect(accepted.blockedInputVatFils).toBe(0)
    expect(accepted.recoverableInputVatFils).toBe(0)
  })

  it('refuses a blocked line carrying no VAT, which is a treatment used as a catch-all', async () => {
    const refused = await rejection(() =>
      post({
        supplierId: supplierIds.get('fixture-registered-consumables') as string,
        supplierReference: referenceFor('FIX-BLOCKED-NO-VAT'),
        billDate: RECOVERABILITY_ENTRY_DATE,
        dueDate: RECOVERABILITY_ENTRY_DATE,
        entryDate,
        receivedBy: 'm-vat-02-itest',
        lines: [
          {
            description: 'Refreshments with no VAT charged',
            expenseAccountCode: ACCOUNTS.entertainment as string,
            taxTreatment: 'blocked_not_recoverable',
            vatRateBp: 500,
            grossFils: 21_000,
            netFils: 21_000,
          },
        ],
      }),
    )
    expect(refused?.message).toContain('nothing is blocked')
  })

  it('posts the shape the acceptance names end to end: one entertainment bill, disclosed', async () => {
    const shape = recoverabilityShape('FIX-BLOCK-TEA-0001')
    const bill = posted.get(shape.supplierReference) as PostedBill
    // Present in the return, under the disclosure, with its VAT nowhere near the claim: the three facts
    // the acceptance asks for, on the one bill it names.
    expect(bill.blockedInputVatFils).toBe(1_000)
    expect(bill.recoverableInputVatFils).toBe(0)
    const lines = await blockedInputVatLines(sql, {
      from: RECOVERABILITY_PERIOD.from,
      to: RECOVERABILITY_PERIOD.to,
      supplierCode: codeFor(shape.supplierCode),
    })
    expect(lines.map((line) => line.reference)).toContain(bill.displayNumber)
  })
})
