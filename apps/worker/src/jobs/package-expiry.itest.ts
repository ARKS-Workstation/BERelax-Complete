import {
  BreakagePolicyUnanswered,
  PACKAGE_DEFERRED_REVENUE_ACCOUNT,
  PACKAGE_REDEMPTION_REVENUE_ACCOUNT,
} from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PACKAGE_EXPIRY_ACTOR, runPackageExpirySweep } from './package-expiry.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The expiry sweep: what it measures, and the journal entry it must never write.
 *
 * The whole point of this suite is the NEGATIVE claim. **[UNVERIFIED] Y9-package-policy** provisionally
 * RETAINS an unredeemed balance, so the customer is still owed the treatments and moving `2050` into revenue
 * would recognise money the business owes — on a VAT box, for a supply that has not happened, and reversing
 * it when the owner says "of course we honour it" means amending a filed return. So the assertions are: the
 * figure is measured, an audit row carries it, and the ledger does not move.
 *
 * A negative claim needs a control that can fail, and there are two: the exposure figure has to be non-zero
 * (otherwise "nothing was posted" is satisfied by a sweep that found nothing), and a sale sold under
 * `forfeited` terms has to RAISE — because a sweep that silently skipped what it cannot answer for would
 * report the same clean run as one that had nothing to do.
 *
 * The business days are in **2083**, which nothing else in the build posts into: 2084 is this unit's pair
 * suite, 2085 its gate block, 2086 gate 105, and 2087 onwards are M-TILL-11's, the journal's and the three
 * fixtures suites'.
 *
 * ## Why the sale is seeded in raw SQL
 *
 * `sellPackage` needs the posting built by `@berelax/core` and mapped by `@berelax/fixtures`, and `apps/worker`
 * depends on neither — `pnpm boundaries` is what says so, and adding the dependency to reach a test helper
 * would widen the worker's dependency graph for the sake of a fixture. The pair suite
 * (`packages/fixtures/src/package-redemption.itest.ts`) is where that path is exercised; this suite is about
 * the sweep, which only READS `package_expiry_exposure`. So the rows are written directly, and every rule
 * 0078 and 0083 hold has to accept them — which is itself a check that the sweep is being tested against
 * realistic rows rather than against a shape only this file can produce.
 */

const SOLD_ON = '2083-02-09'
/** The sale expires on 2083-08-09; the sweep runs well after it, at 06:00 Gulf time. */
const SWEEP_AT = '2083-10-01T02:00:00.000Z'
const SWEEP_DATE = '2083-10-01'
/** An instant BEFORE the expiry, for the control that the boundary is real. */
const EARLY_SWEEP_AT = '2083-04-01T02:00:00.000Z'

let sql: Sql
let customerId: string
let variantId: string

const RUN = Date.now().toString(36)
let nonce = 0

const TRUNCATE =
  'truncate package_redemption, payment, package_balance, package_sale, package_template_line, ' +
  'package_template_version, package_template'

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (
      ${SOLD_ON}::date,
      (${SOLD_ON}::date + time '11:00') at time zone 'Asia/Dubai',
      (${SOLD_ON}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
      'weekly'
    )
    on conflict (trading_date) do nothing
  `
  await sql`delete from period_lock where starts_on >= '2083-01-01' and ends_on <= '2083-12-31'`
  const [buyer] = await sql<{ id: string }[]>`select id from customer order by id limit 1`
  if (buyer === undefined) throw new Error('run `pnpm seed` before the integration suite')
  customerId = buyer.id
  const [variant] = await sql<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
     where s.archived_at is null order by v.gross_price_fils desc, v.id limit 1
  `
  if (variant === undefined) throw new Error('the seed creates priced variants; run `pnpm seed`')
  variantId = variant.id
})

afterAll(async () => {
  await sql?.unsafe(TRUNCATE)
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql.unsafe(TRUNCATE)
  nonce += 1
})

/**
 * Sells a one-line four-session package under the given unredeemed-balance policy, in raw SQL.
 *
 * ONE transaction, because four of 0078's refusals and two of 0083's are DEFERRED constraint triggers that
 * fire at COMMIT: the version's lines, the sale's snapshot, the posting, the allocation and the payment
 * ceiling are all checked there, so a statement-at-a-time seed would be refused by whichever fires first.
 */
async function sellUnder(policy: 'retained' | 'forfeited', priceFils = 80_000): Promise<string> {
  const key = `mtill10_sweep_${policy}_${nonce}`
  const entry = `je-m10-sweep-${RUN}-${nonce}-${policy}`
  await sql.begin(async (tx) => {
    await tx`insert into package_template (template_key) values (${key})`
    await tx`
      insert into package_template_version (template_id, version, internal_name,
        public_display_name, price_fils, validity_months, transferable, unredeemed_balance_policy,
        is_provisional, provisional_note, open_question_id)
      values ((select id from package_template where template_key = ${key}), 1,
        'Sweep course', 'Sweep course', ${priceFils}, 6, false, ${policy},
        true, 'suite seed', 'Y9-package-policy')
    `
    await tx`
      insert into package_template_line (template_version_id, line_no, service_variant_id,
        session_count)
      values ((select v.id from package_template_version v
                 join package_template t on t.id = v.template_id
                where t.template_key = ${key} and v.version = 1),
              1, ${variantId}::uuid, 4)
    `
    await tx`
      insert into journal_entry (entry_id, entry_date, narrative, source)
      values (${entry}, ${SOLD_ON}::date, 'Suite package sale', 'package_sale')
    `
    await tx`
      insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
      values (${entry}, 1, '1010', ${priceFils}, 0),
             (${entry}, 2, ${PACKAGE_DEFERRED_REVENUE_ACCOUNT}, 0, ${priceFils})
    `
    await tx`
      insert into package_sale (customer_id, template_version_id, trading_date, price_fils,
        session_count, validity_months, transferable, unredeemed_balance_policy, journal_entry_id)
      values (${customerId}::uuid,
              (select v.id from package_template_version v
                 join package_template t on t.id = v.template_id
                where t.template_key = ${key} and v.version = 1),
              ${SOLD_ON}::date, ${priceFils}, 4, 6, false, ${policy}, ${entry})
    `
    await tx`
      insert into package_balance (package_sale_id, line_no, service_variant_id, sessions_total,
        value_fils)
      values ((select id from package_sale where journal_entry_id = ${entry}), 1,
              ${variantId}::uuid, 4, ${priceFils})
    `
    // The payment row 0083 added, and ZG012 requires it to equal the price exactly — so this seed also
    // exercises the fix to M-TILL-09's drawer defect rather than routing round it.
    await tx`
      insert into payment (invoice_id, package_sale_id, tender_no, tender_kind,
        posting_account_code, amount_fils, change_given_fils, trading_date)
      values (null, (select id from package_sale where journal_entry_id = ${entry}), 1, 'cash',
              '1010', ${priceFils}, 0, ${SOLD_ON}::date)
    `
  })
  const [sale] = await sql<{ id: string; expiresOn: string }[]>`
    select id, expires_on::text as "expiresOn" from package_sale where journal_entry_id = ${entry}
  `
  // The expiry is 0078's GENERATED column and this suite READS it: six months from the sale's business day.
  // Asserted here because every case below depends on it and a wrong value would make them all pass or all
  // fail for a reason that has nothing to do with the sweep.
  expect(sale?.expiresOn).toBe('2083-08-09')
  return sale?.id ?? ''
}

/** Total movement (debits plus credits) on an account over 2083, off `journal_line`. */
async function movedIn2083(account: string): Promise<number> {
  const [row] = await sql<{ moved: string }[]>`
    select coalesce(sum(l.debit_fils + l.credit_fils), 0)::text as moved
      from journal_line l join journal_entry e on e.entry_id = l.entry_id
     where l.account_code = ${account}
       and e.entry_date between '2083-01-01'::date and '2083-12-31'::date
  `
  return Number(row?.moved ?? 0)
}

describe('the package expiry sweep measures and posts nothing', () => {
  it('reports the unreleased liability of an expired sale, and writes no journal entry', async () => {
    await sellUnder('retained')
    const openingRevenue = await movedIn2083(PACKAGE_REDEMPTION_REVENUE_ACCOUNT)
    const openingLiability = await movedIn2083(PACKAGE_DEFERRED_REVENUE_ACCOUNT)
    // `audit_event` is append-only (ADR 0008), so the assertion is a DELTA and never a total.
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'package.expiry_swept'
    `

    const result = await runPackageExpirySweep(sql, PACKAGE_EXPIRY_ACTOR, SWEEP_AT)

    expect(result.asAt).toBe(SWEEP_DATE)
    expect(result.exposure.expired).toHaveLength(1)
    // The control that makes the negative claim mean something: the figure is NOT zero, so "nothing was
    // posted" is not being satisfied by a sweep that found nothing to post about.
    expect(result.exposure.unreleasedFils).toBe(80_000)
    expect(result.exposure.retainedCount).toBe(1)
    expect(result.exposure.awaitingPolicy).toHaveLength(0)
    expect(result.journalEntriesPosted).toBe(0)

    // THE claim: the ledger did not move. A delta over the whole year on both the liability and the
    // revenue account it would have been released into.
    expect(await movedIn2083(PACKAGE_REDEMPTION_REVENUE_ACCOUNT)).toBe(openingRevenue)
    expect(await movedIn2083(PACKAGE_DEFERRED_REVENUE_ACCOUNT)).toBe(openingLiability)

    // And the measurement is recorded, because a pass whose only output is a return value leaves nothing
    // for a human or a report to read.
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'package.expiry_swept'
    `
    expect(Number(after?.n) - Number(before?.n)).toBe(1)
    const [row] = await sql<
      { afterState: { unreleasedFils: number; journalEntriesPosted: number } }[]
    >`
      select after_state as "afterState" from audit_event where action = 'package.expiry_swept'
       order by occurred_at desc limit 1
    `
    expect(row?.afterState.unreleasedFils).toBe(80_000)
    expect(row?.afterState.journalEntriesPosted).toBe(0)
  })

  it('the control: a sweep dated INSIDE the validity finds nothing at all', async () => {
    await sellUnder('retained')
    const result = await runPackageExpirySweep(sql, PACKAGE_EXPIRY_ACTOR, EARLY_SWEEP_AT)
    expect(result.asAt).toBe('2083-04-01')
    expect(result.exposure.expired).toHaveLength(0)
    expect(result.exposure.unreleasedFils).toBe(0)
  })

  /**
   * A sale sold under `forfeited` terms has no posting, so the sweep RAISES rather than guessing.
   *
   * Writing it off needs an account that does not exist — `4050` is the VOUCHER account and a package is a
   * different product on the same VAT box — and an answer to whether forfeited consideration is a supply at
   * all, which neither Y9-package-policy nor Y11-vat-package settles. A guessed posting would put revenue,
   * and possibly output VAT, into a filed period on an assumption.
   *
   * The audit row is written FIRST and committed, so the measurement for the retained sales survives the
   * throw. That ordering is asserted here rather than left to the comment in the job.
   */
  it('raises BreakagePolicyUnanswered for a forfeited sale, after recording the measurement', async () => {
    await sellUnder('forfeited', 70_000)
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'package.expiry_swept'
    `
    await expect(runPackageExpirySweep(sql, PACKAGE_EXPIRY_ACTOR, SWEEP_AT)).rejects.toBeInstanceOf(
      BreakagePolicyUnanswered,
    )
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'package.expiry_swept'
    `
    expect(Number(after?.n) - Number(before?.n)).toBe(1)
    // And still nothing in the ledger: a refusal is not a posting either.
    expect(await movedIn2083(PACKAGE_REDEMPTION_REVENUE_ACCOUNT)).toBe(0)
  })

  it('resolves the business date in Asia/Dubai and not in UTC', async () => {
    await sellUnder('retained')
    // 20:30 UTC on 30 September is 00:30 on 1 October in Abu Dhabi. Slicing the ISO string would ask about
    // September, which for a package expiring at a month boundary is a whole extra pass of it reading as
    // still live.
    const result = await runPackageExpirySweep(
      sql,
      PACKAGE_EXPIRY_ACTOR,
      '2083-09-30T20:30:00.000Z',
    )
    expect(result.asAt).toBe('2083-10-01')
    expect('2083-09-30T20:30:00.000Z'.slice(0, 10)).toBe('2083-09-30')
    expect(result.asAt).not.toBe('2083-09-30T20:30:00.000Z'.slice(0, 10))
  })
})
