import {
  ACCOUNTS,
  entryId,
  filsFrom,
  localDate,
  money,
  PACKAGE_DEFERRED_REVENUE_ACCOUNT,
  PACKAGE_OUTPUT_VAT_ACCOUNT,
  PACKAGE_REDEMPTION_REVENUE_ACCOUNT,
  releaseThrough,
  type TenderLine,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  currentPackageTemplateVersion,
  PACKAGE_REDEMPTION_SQLSTATE,
  PackageExpired,
  PackageNotTransferable,
  PackageReleaseDisagrees,
  packageRedemptionError,
  readExpiredPackages,
  readPackageLiability,
  readPackageSale,
  redeemPackage,
  type Sql,
  savePackageTemplateVersion,
  sellPackage,
  transferPackageBalance,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { packageSaleMapping } from './package.ts'
import {
  assertPackageRedemptionMappingReconciles,
  packageRedemptionMapping,
  releaseCensusBox,
} from './package-redemption.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The PAIR for the redemption: `@berelax/core`'s release rule against the rows `@berelax/db` writes, and
 * against the rules PostgreSQL holds.
 *
 * `packages/db` may never import `packages/core`, so each half is exercised against a structural mirror of
 * the other and neither half's own suite can see the mapping between them. This file is where both can be
 * imported at once, and it is the only place these can be compared:
 *
 *   1. core's `releaseThrough` against `package_release_through_fils` in SQL — one formula, two
 *      implementations, held equal over a CENSUS rather than by inspection;
 *   2. the deferred-revenue liability computed from the package ROWS against the same figure computed from
 *      `journal_line`, which is the acceptance line and which no single package can check;
 *   3. the output-VAT movement of the SALE period against that of the REDEMPTION period, which is the
 *      substance of [UNVERIFIED] Y11-vat-package's provisional answer.
 *
 * The business days are in **2084**, which no other suite and no gate posts into: gate 105 takes 2086,
 * M-TILL-11 2087 and 2089, the journal 2088, period-close 2091, M-TILL-09's own itest 2092, gate 103 2093,
 * gate 98 2094, and three fixtures suites 2095-2099. 2085 is this unit's GATE block.
 */

const ACTOR: Actor = {
  kind: 'staff',
  id: '66666666-6666-6666-6666-666666666666',
  label: 'Till (redemption pair)',
}

/** The sale day, a redemption day inside the validity, and one after it. Six months' validity. */
const SOLD_ON = '2084-03-14'
const REDEEMED_ON = '2084-05-20'
/** 2084-09-14 is the expiry of a 2084-03-14 sale; this is the day after. */
const AFTER_EXPIRY = '2084-09-15'

let sql: Sql
let customerId: string
let otherCustomerId: string
let variants: readonly { id: string; grossPriceFils: number }[]

const RUN = Date.now().toString(36)
let nonce = 0

const TRUNCATE =
  'truncate package_redemption, payment, package_balance, package_sale, package_template_line, ' +
  'package_template_version, package_template'

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })
  for (const day of [SOLD_ON, REDEEMED_ON, AFTER_EXPIRY]) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        ${day}::date,
        (${day}::date + time '11:00') at time zone 'Asia/Dubai',
        (${day}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
        'weekly'
      )
      on conflict (trading_date) do nothing
    `
  }
  // A lock over 2084 left behind by `period-close.itest.ts` would refuse every entry here by ZL002 and
  // every case would report that instead — gate 103's and gate 105's reason for the same delete.
  await sql`delete from period_lock where starts_on >= '2084-01-01' and ends_on <= '2084-12-31'`

  const buyers = await sql<{ id: string }[]>`select id from customer order by id limit 2`
  const [buyer, other] = buyers
  if (buyer === undefined || other === undefined) {
    throw new Error('run `pnpm seed` before the integration suite — two customers are needed')
  }
  customerId = buyer.id
  otherCustomerId = other.id

  const rows = await sql<{ id: string; grossPriceFils: string }[]>`
    select v.id, v.gross_price_fils as "grossPriceFils"
      from service_variant v join service s on s.id = v.service_id
     where s.archived_at is null
     order by v.gross_price_fils desc, v.id limit 2
  `
  if (rows.length < 2) throw new Error('the seed creates priced variants; run `pnpm seed`')
  variants = rows.map((row) => ({ id: row.id, grossPriceFils: Number(row.grossPriceFils) }))
})

afterAll(async () => {
  await sql?.unsafe(TRUNCATE)
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql.unsafe(TRUNCATE)
  nonce += 1
})

const cash = (fils: number): TenderLine => ({ kind: 'cash', amount: money(filsFrom(fils)) })
const uuid = () => crypto.randomUUID()

/**
 * Sells a one-line package of `sessions` sessions for `priceFils`, and returns the sale and its balance.
 *
 * One line, deliberately, for most cases: the per-LINE allocation is M-TILL-09's and is covered by its own
 * pair suite, and a one-line sale makes `package_balance.value_fils` equal to the price so a release figure
 * can be reasoned about in the test rather than derived by the thing under test.
 */
async function sellOneLine(priceFils: number, sessions: number, options: { day?: string } = {}) {
  const key = `mtill10_pair_${nonce}`
  const day = options.day ?? SOLD_ON
  const saved = await withUnitOfWork(sql, ACTOR, (uow) =>
    savePackageTemplateVersion(uow, {
      templateKey: key,
      internalName: 'Redemption course',
      publicDisplayName: 'Redemption course',
      priceFils,
      lines: [{ serviceVariantId: variants[0]?.id ?? '', sessionCount: sessions }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }),
  )
  const version = await currentPackageTemplateVersion(sql, key)
  if (version === null) throw new Error('the version just saved cannot be read back')

  const mapping = packageSaleMapping({
    entryId: entryId(`je-m10-sale-${RUN}-${nonce}`),
    tradingDate: localDate(day),
    customerId,
    templateVersionId: saved.versionId,
    priceGross: money(filsFrom(priceFils)),
    lines: version.lines.map((line) => ({
      lineNo: line.lineNo,
      serviceVariantId: line.serviceVariantId,
      sessionCount: line.sessionCount,
      listGrossFils: line.listGrossFils,
    })),
    tenders: [cash(priceFils)],
    validityMonths: version.validityMonths,
    transferable: version.transferable,
    unredeemedBalancePolicy: version.unredeemedBalancePolicy,
    packageLabel: version.internalName,
  })
  const sold = await withUnitOfWork(sql, ACTOR, (uow) => sellPackage(uow, mapping.input))
  const read = await readPackageSale(sql, sold.saleId)
  const balance = read?.balances[0]
  if (read === null || balance === undefined) throw new Error('the sale opened no balance')
  return { sold, read, balance, versionId: saved.versionId, label: version.internalName }
}

/** Reads a balance as core's `PackageBalanceState`, which is what the mapping takes. */
async function balanceState(balanceId: string) {
  const [row] = await sql<
    {
      sessionsTotal: number
      sessionsRedeemed: number
      valueFils: string
      releasedFils: string
    }[]
  >`
    select sessions_total as "sessionsTotal", sessions_redeemed as "sessionsRedeemed",
           value_fils as "valueFils", released_fils as "releasedFils"
      from package_balance where id = ${balanceId}::uuid
  `
  if (row === undefined) throw new Error(`no balance ${balanceId}`)
  return {
    balanceId,
    sessionsTotal: row.sessionsTotal,
    sessionsRedeemed: row.sessionsRedeemed,
    valueGross: money(filsFrom(Number(row.valueFils))),
    releasedGross: money(filsFrom(Number(row.releasedFils))),
  }
}

/** Redeems `units` sessions of a balance on `day`, through the mapping. */
async function redeemOnce(
  balanceId: string,
  label: string,
  options: { units?: number; day?: string; appointmentId?: string; suffix?: string } = {},
) {
  const mapping = assertPackageRedemptionMappingReconciles(
    packageRedemptionMapping({
      entryId: entryId(`je-m10-red-${RUN}-${nonce}-${options.suffix ?? uuid().slice(0, 8)}`),
      tradingDate: localDate(options.day ?? REDEEMED_ON),
      balance: await balanceState(balanceId),
      appointmentId: options.appointmentId ?? uuid(),
      units: options.units ?? 1,
      packageLabel: label,
    }),
  )
  return {
    mapping,
    result: await withUnitOfWork(sql, ACTOR, (uow) => redeemPackage(uow, mapping.input)),
  }
}

/**
 * Movement on one account over a date range, off `journal_line`. The ledger's own answer.
 *
 * Every caller reads this TWICE and asserts the difference, and that is not optional. `journal_entry` is
 * append-only and is truncated by nobody, while `beforeEach` truncates the package family — so an absolute
 * figure here carries every earlier case's postings and every earlier RUN's, and the first version of this
 * file asserted absolutes and failed on its second run with figures nobody could account for. Brief rule 12,
 * and rule 9 for the same reason: assert a delta, never a total.
 */
async function movementOn(account: string, from: string, to: string, sources?: readonly string[]) {
  const [row] = await sql<{ credit: string; debit: string }[]>`
    select coalesce(sum(l.credit_fils), 0)::text as credit,
           coalesce(sum(l.debit_fils), 0)::text  as debit
      from journal_line l
      join journal_entry e on e.entry_id = l.entry_id
     where l.account_code = ${account}
       and e.entry_date between ${from}::date and ${to}::date
       and (${sources === undefined} or e.source = any(${sources ?? []}::text[]))
  `
  return { creditFils: Number(row?.credit ?? 0), debitFils: Number(row?.debit ?? 0) }
}

// -------------------------------------------------------------------------------------------------
// 1. One formula, two implementations
// -------------------------------------------------------------------------------------------------

describe('the release formula in SQL and in TypeScript', () => {
  /**
   * A CENSUS and not a sample, and not a property test either.
   *
   * The claim is "these two implementations of one expression agree", and a random sample of it is a claim
   * about the seed. The box is bounded and stated once in `releaseCensusBox()` so both halves walk the same
   * one: 13 values × 15 session counts × every redemption point, which is 1,365 comparisons.
   *
   * This is the check that would have caught the defect a 300-run property missed in the last batch — a
   * float implementation passing because the generator never produced a quotient near a whole number.
   */
  it('agree at every point of a bounded census, and the census is counted', async () => {
    const box = releaseCensusBox()
    const wanted: { valueFils: number; sessionsTotal: number; sessionsRedeemed: number }[] = []
    for (const { valueFils, sessionsTotal } of box) {
      for (let redeemed = 0; redeemed <= sessionsTotal; redeemed += 1) {
        wanted.push({ valueFils, sessionsTotal, sessionsRedeemed: redeemed })
      }
    }
    // Counted, so a box that silently shrank to nothing fails instead of passing vacuously. 2,080 is
    // MEASURED and not reasoned: 13 values x the sum of (sessionsTotal + 1) over the 15 session counts.
    // The first version of this line said 1,365, which was arithmetic done in a comment.
    expect(wanted.length).toBe(2_080)

    // Three parallel arrays through `unnest`, not a JSON document: postgres.js sends a JS string as TEXT,
    // so `${'...'}::jsonb` arrived as a jsonb SCALAR and `jsonb_array_elements` refused it — measured, not
    // reasoned. Arrays are also what makes the row count assertable, because `unnest` of three arrays of
    // equal length is exactly that many rows.
    const rows = await sql<
      { valueFils: string; sessionsTotal: number; sessionsRedeemed: number; releasedFils: string }[]
    >`
      select spec.value_fils::text as "valueFils", spec.sessions_total as "sessionsTotal",
             spec.sessions_redeemed as "sessionsRedeemed",
             package_release_through_fils(spec.value_fils, spec.sessions_total,
                                          spec.sessions_redeemed)::text as "releasedFils"
        from unnest(
               ${wanted.map((row) => row.valueFils)}::bigint[],
               ${wanted.map((row) => row.sessionsTotal)}::int[],
               ${wanted.map((row) => row.sessionsRedeemed)}::int[]
             ) as spec(value_fils, sessions_total, sessions_redeemed)
    `
    expect(rows.length).toBe(2_080)

    let disagreements = 0
    let nonZero = 0
    for (const row of rows) {
      const inTypeScript = releaseThrough(
        money(filsFrom(Number(row.valueFils))),
        row.sessionsTotal,
        row.sessionsRedeemed,
      ).fils
      if (inTypeScript !== Number(row.releasedFils)) disagreements += 1
      if (Number(row.releasedFils) > 0) nonZero += 1
    }
    expect(disagreements).toBe(0)
    // The control on the census itself: a census whose every answer is zero would agree with anything.
    expect(nonZero).toBeGreaterThan(1_800)
  }, 30_000)

  /**
   * The control for the census: SQL and TypeScript must be able to DISAGREE.
   *
   * A census over two implementations is worthless if the comparison cannot fail, and the cheapest way to
   * be sure is to compare TypeScript against a deliberately wrong SQL expression — floor division instead
   * of ceiling — and require a disagreement. That is the same wrong answer `package-drawdown.test.ts`
   * rejects in arithmetic, checked here against the database.
   */
  it('the control: a floor-division SQL formula disagrees with core', async () => {
    const rows = await sql<{ valueFils: string; total: number; redeemed: number; wrong: string }[]>`
      select v.value_fils::text as "valueFils", v.total, v.redeemed,
             ((v.value_fils * v.redeemed) / v.total)::text as wrong
        from (values (100::bigint, 3, 1), (7::bigint, 3, 2), (1::bigint, 3, 2)) as v(value_fils, total, redeemed)
    `
    expect(rows.length).toBe(3)
    let disagreements = 0
    for (const row of rows) {
      const right = releaseThrough(
        money(filsFrom(Number(row.valueFils))),
        row.total,
        row.redeemed,
      ).fils
      if (right !== Number(row.wrong)) disagreements += 1
    }
    expect(disagreements).toBe(3)
  })
})

// -------------------------------------------------------------------------------------------------
// 2. The drawdown, the posting and the liability identity
// -------------------------------------------------------------------------------------------------

describe('a redemption releases the liability and recognises the supply', () => {
  it('draws the balance down, posts Dr 2050 / Cr 4020 / Cr 2030, and holds the identity', async () => {
    // Every ledger figure below is a DELTA across this case, for the reason on `movementOn`.
    const opening = {
      deferred: await movementOn(PACKAGE_DEFERRED_REVENUE_ACCOUNT, REDEEMED_ON, REDEEMED_ON),
      revenue: await movementOn(PACKAGE_REDEMPTION_REVENUE_ACCOUNT, REDEEMED_ON, REDEEMED_ON),
      vat: await movementOn(PACKAGE_OUTPUT_VAT_ACCOUNT, REDEEMED_ON, REDEEMED_ON),
      treatment: await movementOn(ACCOUNTS.treatmentRevenue, REDEEMED_ON, REDEEMED_ON),
      liability: await readPackageLiability(sql, REDEEMED_ON),
    }
    // A price that does not divide by the session count, so every figure below is a real allocation rather
    // than a round number the arithmetic cannot get wrong.
    const { sold, balance, label } = await sellOneLine(100_001, 3)
    expect(balance.valueFils).toBe(100_001)
    expect(balance.sessionsRedeemed).toBe(0)
    expect(balance.releasedFils).toBe(0)

    const { result } = await redeemOnce(
      (
        await sql<{ id: string }[]>`
        select id from package_balance where package_sale_id = ${sold.saleId}::uuid
      `
      )[0]?.id ?? '',
      label,
      { suffix: 'a' },
    )
    // ceil(100001 / 3) = 33334.
    expect(result.releasedFils).toBe(33_334)
    expect(result.netFils + result.vatFils).toBe(result.releasedFils)
    expect(result.sessionsRedeemed).toBe(1)
    expect(result.releasedThroughFils).toBe(33_334)
    expect(result.saleUnreleasedFils).toBe(100_001 - 33_334)

    // The posting, off the ledger. Three assertions, each against a figure on the ROW rather than against
    // another ledger figure — ZG008 already refused anything else, so this is the reader agreeing with the
    // refusal rather than a second opinion about arithmetic.
    const deferred = await movementOn(PACKAGE_DEFERRED_REVENUE_ACCOUNT, REDEEMED_ON, REDEEMED_ON)
    expect(
      deferred.debitFils -
        deferred.creditFils -
        (opening.deferred.debitFils - opening.deferred.creditFils),
    ).toBe(result.releasedFils)
    const revenue = await movementOn(PACKAGE_REDEMPTION_REVENUE_ACCOUNT, REDEEMED_ON, REDEEMED_ON)
    expect(
      revenue.creditFils -
        revenue.debitFils -
        (opening.revenue.creditFils - opening.revenue.debitFils),
    ).toBe(result.netFils)
    const vat = await movementOn(PACKAGE_OUTPUT_VAT_ACCOUNT, REDEEMED_ON, REDEEMED_ON)
    expect(vat.creditFils - vat.debitFils - (opening.vat.creditFils - opening.vat.debitFils)).toBe(
      result.vatFils,
    )
    // Nothing FURTHER on the treatment revenue account: a prepaid treatment is recognised on 4020, which
    // is what makes a drill-down able to tell the two apart.
    const treatment = await movementOn(ACCOUNTS.treatmentRevenue, REDEEMED_ON, REDEEMED_ON)
    expect(
      treatment.creditFils +
        treatment.debitFils -
        (opening.treatment.creditFils + opening.treatment.debitFils),
    ).toBe(0)

    /**
     * THE acceptance line: the liability equals the sold gross minus the redeemed gross.
     *
     * `outstandingFils` comes from the package rows and `ledgerBalanceFils` from `journal_line`, by two
     * different routes on purpose — a reader that derived both from one place would compare a value to
     * itself and report agreement for a ledger nothing had been posted to.
     */
    const liability = await readPackageLiability(sql, REDEEMED_ON)
    // The ROW side is absolute, because `beforeEach` truncates the package family so this case owns every
    // package_sale and package_redemption row there is.
    expect(liability.soldGrossFils).toBe(100_001)
    expect(liability.releasedFils).toBe(33_334)
    expect(liability.outstandingFils).toBe(66_667)
    // The LEDGER side is a delta, because journal_entry is append-only. The two sides come from two
    // different places on purpose: a reader that derived both from one would compare a value to itself and
    // report agreement for a ledger nothing had been posted to.
    expect(liability.ledgerBalanceFils - opening.liability.ledgerBalanceFils).toBe(
      liability.outstandingFils - opening.liability.outstandingFils,
    )
  })

  it('releases the whole value over the course, to the fils, and the liability reaches zero', async () => {
    const opening = await readPackageLiability(sql, REDEEMED_ON)
    const { sold, label } = await sellOneLine(100_001, 3)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const balanceId = row?.id ?? ''
    const released: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const { result } = await redeemOnce(balanceId, label, { suffix: `s${i}` })
      released.push(result.releasedFils)
    }
    // 33334 + 33334 + 33333: the last session carries the remainder DOWN, which is what makes the sum
    // exact rather than one fils over.
    expect(released).toEqual([33_334, 33_334, 33_333])
    expect(released.reduce((a, b) => a + b, 0)).toBe(100_001)

    const liability = await readPackageLiability(sql, REDEEMED_ON)
    expect(liability.outstandingFils).toBe(0)
    // A DELTA of zero, not a total of zero: the ledger carries earlier cases' 2050 movements.
    expect(liability.ledgerBalanceFils - opening.ledgerBalanceFils).toBe(0)

    // And the fourth is refused, by `@berelax/core` before a posting is even built. That is the earliest
    // of the THREE layers that refuse it, and the test asserts the layer it actually reached rather than a
    // phrase several of them emit — asserting a shared phrase is how a check comes to be deleted with its
    // suite still green.
    await expect(redeemOnce(balanceId, label, { suffix: 'over' })).rejects.toThrow(
      /cannot be drawn past what was sold/,
    )

    // The third layer, seen to fire: the CHECK 0078 declared with the column, reached by a statement that
    // came through neither core nor the service. This is the one that makes the first acceptance line true
    // for a writer nobody wrote.
    await expect(
      sql`
        update package_balance set sessions_redeemed = sessions_redeemed + 1
         where id = ${balanceId}::uuid
      `,
    ).rejects.toThrow(/package_balance_cannot_overdraw/)
    await expect(
      sql`update package_balance set released_fils = released_fils + 1 where id = ${balanceId}::uuid`,
    ).rejects.toThrow(/package_balance_cannot_overrelease/)
  }, 30_000)

  it('refuses a release figure the locked balance does not imply', async () => {
    const { sold, label } = await sellOneLine(100_001, 3)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const balanceId = row?.id ?? ''
    const mapping = packageRedemptionMapping({
      entryId: entryId(`je-m10-wrongfig-${RUN}-${nonce}`),
      tradingDate: localDate(REDEEMED_ON),
      balance: await balanceState(balanceId),
      appointmentId: uuid(),
      units: 1,
      packageLabel: label,
    })
    // One fils short. The figure is still arithmetically defensible and it is not the formula's, which is
    // the fils that makes the liability disagree with the cash taken.
    const tampered = {
      ...mapping.input,
      releasedFils: mapping.input.releasedFils - 1,
    }
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) => redeemPackage(uow, tampered)),
    ).rejects.toBeInstanceOf(PackageReleaseDisagrees)
    // Nothing was written: the refusal happens before the journal entry.
    const [count] = await sql<{ n: string }[]>`select count(*)::text as n from package_redemption`
    expect(Number(count?.n)).toBe(0)
  })
})

// -------------------------------------------------------------------------------------------------
// 3. Two parallel redemptions of the last session
// -------------------------------------------------------------------------------------------------

describe('concurrency', () => {
  /**
   * The acceptance line: "two parallel redemptions of the last session leave exactly one winner".
   *
   * Both transactions read the balance with `select … for update`, so the second blocks on the row lock
   * until the first commits and then sees `sessions_redeemed` AFTER it. The winner is decided by the
   * database and not by an ordering this test arranges — which is why both calls are started before either
   * is awaited.
   */
  it('two parallel redemptions of the last session leave exactly one winner', async () => {
    const { sold, label } = await sellOneLine(50_000, 1)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const balanceId = row?.id ?? ''
    const state = await balanceState(balanceId)

    // Both postings are built from the SAME pre-lock read, which is the realistic shape: two tills each
    // read the balance, each built a posting, and both are now committing.
    const attempt = (suffix: string) => {
      const mapping = packageRedemptionMapping({
        entryId: entryId(`je-m10-race-${RUN}-${nonce}-${suffix}`),
        tradingDate: localDate(REDEEMED_ON),
        balance: state,
        appointmentId: uuid(),
        units: 1,
        packageLabel: label,
      })
      return withUnitOfWork(sql, ACTOR, (uow) => redeemPackage(uow, mapping.input))
    }
    const outcomes = await Promise.allSettled([attempt('x'), attempt('y')])
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled')
    const lost = outcomes.filter((outcome) => outcome.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)

    // And the loser lost for a reason a caller can act on, rather than with a raw SQLSTATE.
    const rejection = lost[0]
    if (rejection?.status === 'rejected') {
      const translated = packageRedemptionError(rejection.reason) ?? rejection.reason
      expect(String((translated as Error).message)).toMatch(
        /nothing further to draw on|no sessions left|ZG009/,
      )
    }

    // Exactly one redemption row, one session drawn, and the whole value released once.
    const [after] = await sql<{ n: string; redeemed: number; released: string }[]>`
      select (select count(*)::text from package_redemption) as n,
             b.sessions_redeemed as redeemed, b.released_fils as released
        from package_balance b where b.id = ${balanceId}::uuid
    `
    expect(Number(after?.n)).toBe(1)
    expect(after?.redeemed).toBe(1)
    expect(Number(after?.released)).toBe(50_000)
  }, 30_000)
})

// -------------------------------------------------------------------------------------------------
// 4. The VAT periods
// -------------------------------------------------------------------------------------------------

describe('the VAT event is at the redemption and not at the sale', () => {
  /**
   * The acceptance line, measured as two PERIOD movements rather than as one entry's lines.
   *
   * The sale is in March and the redemption in May, so "the sale period's output-VAT box contains zero from
   * package sales while the redemption period's box 1 contains the VAT" is a comparison of two date ranges
   * over `2030` — which is what a VAT return actually is, and which no single entry's assertion can make.
   */
  it('the sale period moves nothing on 2030 and the redemption period moves the VAT', async () => {
    const PACKAGE_SOURCES = ['package_sale', 'package_redemption'] as const
    const opening = {
      marchVat: await movementOn(
        PACKAGE_OUTPUT_VAT_ACCOUNT,
        '2084-03-01',
        '2084-03-31',
        PACKAGE_SOURCES,
      ),
      mayVat: await movementOn(
        PACKAGE_OUTPUT_VAT_ACCOUNT,
        '2084-05-01',
        '2084-05-31',
        PACKAGE_SOURCES,
      ),
      marchLiability: await movementOn(
        PACKAGE_DEFERRED_REVENUE_ACCOUNT,
        '2084-03-01',
        '2084-03-31',
      ),
      marchRevenue: await movementOn(
        PACKAGE_REDEMPTION_REVENUE_ACCOUNT,
        '2084-03-01',
        '2084-03-31',
      ),
    }
    const { sold, label } = await sellOneLine(100_001, 3)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const { result } = await redeemOnce(row?.id ?? '', label, { suffix: 'vat' })

    const salePeriod = await movementOn(
      PACKAGE_OUTPUT_VAT_ACCOUNT,
      '2084-03-01',
      '2084-03-31',
      PACKAGE_SOURCES,
    )
    expect(
      salePeriod.creditFils +
        salePeriod.debitFils -
        (opening.marchVat.creditFils + opening.marchVat.debitFils),
    ).toBe(0)

    const redemptionPeriod = await movementOn(
      PACKAGE_OUTPUT_VAT_ACCOUNT,
      '2084-05-01',
      '2084-05-31',
      PACKAGE_SOURCES,
    )
    expect(
      redemptionPeriod.creditFils -
        redemptionPeriod.debitFils -
        (opening.mayVat.creditFils - opening.mayVat.debitFils),
    ).toBe(result.vatFils)
    expect(result.vatFils).toBeGreaterThan(0)

    // The control: the sale period is not empty of PACKAGE activity — it moved the whole price onto 2050.
    // Without this the zero above would also be satisfied by a sale that never happened.
    const saleLiability = await movementOn(
      PACKAGE_DEFERRED_REVENUE_ACCOUNT,
      '2084-03-01',
      '2084-03-31',
    )
    expect(
      saleLiability.creditFils -
        saleLiability.debitFils -
        (opening.marchLiability.creditFils - opening.marchLiability.debitFils),
    ).toBe(100_001)

    // And the revenue account gains the net in May and nothing in March.
    const marchRevenue = await movementOn(
      PACKAGE_REDEMPTION_REVENUE_ACCOUNT,
      '2084-03-01',
      '2084-03-31',
    )
    expect(
      marchRevenue.creditFils +
        marchRevenue.debitFils -
        (opening.marchRevenue.creditFils + opening.marchRevenue.debitFils),
    ).toBe(0)
  })
})

// -------------------------------------------------------------------------------------------------
// 5. Expiry, and the breakage that is not a posting
// -------------------------------------------------------------------------------------------------

describe('expiry refuses the redemption, retains the balance, and posts nothing', () => {
  it('refuses with PackageExpired on the day after expires_on, in this layer’s own words', async () => {
    const opening = await readPackageLiability(sql, AFTER_EXPIRY)
    const openingRevenue: Record<string, number> = {}
    for (const account of [
      PACKAGE_REDEMPTION_REVENUE_ACCOUNT,
      ACCOUNTS.voucherBreakageRevenue,
      ACCOUNTS.treatmentRevenue,
    ]) {
      const moved = await movementOn(account, '2084-01-01', '2084-12-31')
      openingRevenue[account] = moved.creditFils + moved.debitFils
    }
    const { sold, label } = await sellOneLine(60_000, 2)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const balanceId = row?.id ?? ''
    expect(sold.expiresOn).toBe('2084-09-14')

    const mapping = packageRedemptionMapping({
      entryId: entryId(`je-m10-expired-${RUN}-${nonce}`),
      tradingDate: localDate(AFTER_EXPIRY),
      balance: await balanceState(balanceId),
      appointmentId: uuid(),
      units: 1,
      packageLabel: label,
    })
    const refusal = withUnitOfWork(sql, ACTOR, (uow) => redeemPackage(uow, mapping.input))
    await expect(refusal).rejects.toBeInstanceOf(PackageExpired)
    await expect(refusal).rejects.toThrow(/kept rather than written off/)
    // This LAYER's wording, and explicitly not the database's: ZG010 says "the terms of sale … ended on",
    // and a test asserting a phrase both layers emit would pass after one of them was deleted.
    await expect(refusal).rejects.not.toThrow(/the terms of sale/)

    // The balance is RETAINED: untouched, and still worth what it was.
    const retained = await balanceState(balanceId)
    expect(retained.sessionsRedeemed).toBe(0)
    expect(retained.releasedGross.fils).toBe(0)
    expect(retained.valueGross.fils).toBe(60_000)

    // And NO breakage entry: the liability still holds the whole price after the expiry date.
    const liability = await readPackageLiability(sql, AFTER_EXPIRY)
    expect(liability.outstandingFils).toBe(60_000)
    expect(liability.ledgerBalanceFils - opening.ledgerBalanceFils).toBe(60_000)
    // Nothing FURTHER on any revenue account across the whole year, which is the claim "breakage posts
    // nothing" as a measurement rather than as a promise about the code. A delta, because the ledger is
    // append-only and earlier cases in this file posted releases.
    for (const account of [
      PACKAGE_REDEMPTION_REVENUE_ACCOUNT,
      ACCOUNTS.voucherBreakageRevenue,
      ACCOUNTS.treatmentRevenue,
    ]) {
      const moved = await movementOn(account, '2084-01-01', '2084-12-31')
      expect(moved.creditFils + moved.debitFils - (openingRevenue[account] ?? 0), account).toBe(0)
    }
  })

  it('accepts a redemption ON the expiry date, which is the boundary a validity in months means', async () => {
    const { sold, label } = await sellOneLine(60_000, 2)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        '2084-09-14'::date,
        ('2084-09-14'::date + time '11:00') at time zone 'Asia/Dubai',
        ('2084-09-14'::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
        'weekly'
      )
      on conflict (trading_date) do nothing
    `
    const { result } = await redeemOnce(row?.id ?? '', label, {
      day: '2084-09-14',
      suffix: 'boundary',
    })
    expect(result.releasedFils).toBe(30_000)
    expect(sold.expiresOn).toBe('2084-09-14')
  })

  it('reports the exposure, and a fully drawn-down expired sale is not exposure', async () => {
    const { sold, label } = await sellOneLine(60_000, 2)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const balanceId = row?.id ?? ''
    // Half of it taken inside the validity.
    await redeemOnce(balanceId, label, { suffix: 'half' })

    const owing = await readExpiredPackages(sql, AFTER_EXPIRY)
    expect(owing).toHaveLength(1)
    expect(owing[0]?.unreleasedFils).toBe(30_000)
    expect(owing[0]?.unredeemedBalancePolicy).toBe('retained')

    // Take the other half, and the sale leaves the exposure list entirely: there is nothing owed.
    await redeemOnce(balanceId, label, { suffix: 'rest' })
    expect(await readExpiredPackages(sql, AFTER_EXPIRY)).toHaveLength(0)
    // The control: it is still an EXPIRED sale, so the list is not empty because the filter broke.
    expect(await readExpiredPackages(sql, AFTER_EXPIRY, { onlyOwing: false })).toHaveLength(1)
    // And a date inside the validity finds nothing, which is the other end of the same boundary.
    expect(await readExpiredPackages(sql, REDEEMED_ON, { onlyOwing: false })).toHaveLength(0)
  })
})

// -------------------------------------------------------------------------------------------------
// 6. The transfer that is refused
// -------------------------------------------------------------------------------------------------

describe('a non-transferable balance may not move between customers', () => {
  it('refuses the transfer and writes an audit_event for the refused attempt', async () => {
    const { sold } = await sellOneLine(40_000, 2)

    // `audit_event` is append-only (ADR 0008), so the assertion is a DELTA and never a total.
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'package.transfer_refused'
    `
    // `sql` and not a `uow`, and the reason is the assertion two lines down: a refused attempt inside the
    // caller's transaction writes NO audit row, because the throw rolls it back. That was this unit's own
    // defect and this delta is what found it.
    const refusal = transferPackageBalance(sql, ACTOR, {
      packageSaleId: sold.saleId,
      toCustomerId: otherCustomerId,
      reason: 'the customer asked for it to go to a friend',
    })
    await expect(refusal).rejects.toBeInstanceOf(PackageNotTransferable)
    await expect(refusal).rejects.toThrow(/Y9-package-policy/)

    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'package.transfer_refused'
    `
    expect(Number(after[0]?.n) - Number(before[0]?.n)).toBe(1)

    // The sale still belongs to the person who bought it.
    const [owner] = await sql<{ customerId: string }[]>`
      select customer_id as "customerId" from package_sale where id = ${sold.saleId}::uuid
    `
    expect(owner?.customerId).toBe(customerId)
  })

  it('the control: the same statement a customer MERGE issues is still permitted', async () => {
    const { sold } = await sellOneLine(40_000, 2)
    // `berelax_app` holds `update (customer_id)` on package_sale and nothing more (0078), and a merge
    // re-points exactly that column. The transfer refusal above is therefore a SERVICE rule and not a
    // database one — no trigger can tell a merge from a transfer, because they are the same statement.
    // This is the half that proves the refusal did not close the door on the merge.
    await sql.begin(async (tx) => {
      await tx.unsafe('set local role berelax_app')
      await tx`
        update package_sale set customer_id = ${otherCustomerId}::uuid
         where id = ${sold.saleId}::uuid
      `
    })
    const [owner] = await sql<{ customerId: string }[]>`
      select customer_id as "customerId" from package_sale where id = ${sold.saleId}::uuid
    `
    expect(owner?.customerId).toBe(otherCustomerId)
  })
})

// -------------------------------------------------------------------------------------------------
// 7. One appointment, one settlement
// -------------------------------------------------------------------------------------------------

describe('an appointment is redeemed or charged, never both and never twice', () => {
  it('refuses a second redemption of the same appointment', async () => {
    const { sold, label } = await sellOneLine(60_000, 2)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const balanceId = row?.id ?? ''
    const appointmentId = uuid()
    await redeemOnce(balanceId, label, { appointmentId, suffix: 'first' })
    const second = redeemOnce(balanceId, label, { appointmentId, suffix: 'second' })
    await expect(second).rejects.toThrow(/package_redemption_appointment_once/)
  })

  it('refuses redeeming an appointment a document already states as a chargeable line', async () => {
    const { sold, label } = await sellOneLine(60_000, 2)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const appointmentId = uuid()
    // The invoice side, written directly: building a whole checkout here would exercise M-TILL-06 rather
    // than this rule, and the rule is about the LINK row.
    const invoiceId = await seedInvoiceWithAppointment(appointmentId, 1)
    expect(invoiceId).not.toBe('')

    const refusal = redeemOnce(row?.id ?? '', label, { appointmentId, suffix: 'charged' })
    await expect(refusal).rejects.toThrow(/ZG011/)
  })

  it('refuses stating a redeemed appointment as a chargeable line, which is the other order', async () => {
    const { sold, label } = await sellOneLine(60_000, 2)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const appointmentId = uuid()
    await redeemOnce(row?.id ?? '', label, { appointmentId, suffix: 'redeemed' })
    await expect(seedInvoiceWithAppointment(appointmentId, 1)).rejects.toThrow(/ZG011/)
    // The control: the SAME link with no line number is accepted, because that is the row a checkout
    // containing a redemption has to write (0063) and refusing it would refuse the normal case.
    await expect(seedInvoiceWithAppointment(appointmentId, null)).resolves.not.toBe('')
  })
})

/**
 * A minimal issued document billing one appointment, and the line number it billed it as.
 *
 * The issuer's legal name and trading name are the ones `0026_invoice.sql` seeds — quoted, not invented
 * (brief rule 15) — and the TRN is a suite value with a comment saying so, because the real one is unknown
 * (Y1-trn) and the seeded placeholder is refused by two CHECKs on `invoice`.
 *
 * ## The series is SIMPL-INV and not TAX-INV, and that is not a detail
 *
 * `invoice` refuses DELETE for every role including the owner (ZI003), so the only removal is a TRUNCATE —
 * and truncating it here would wipe every other suite's documents and the seeded ones with them. The rows
 * this helper writes therefore STAY, which makes the series they are written to a decision rather than a
 * default.
 *
 * `checkout-finalise.itest.ts` asserts `document_series.next_number = max(invoice.number) + 1` for
 * **TAX-INV**, because the counter is where a leaked statutory number would show. A document left behind in
 * that series with a number above the counter breaks that assertion — and the first version of this helper
 * did exactly that, numbering in TAX-INV from 840,000. Measured, not reasoned: the run reported
 * `expected 11 to be 840160` in a file this unit does not touch, and the order of the integration suite was
 * the only thing that had been hiding it.
 *
 * SIMPL-INV is a real series for a real `document_kind` (0026), nothing asserts a maximum or a counter over
 * it, and a simplified invoice is the right shape for a fixture document anyway — it is what a till issues
 * without a customer's TRN.
 */
async function seedInvoiceWithAppointment(
  appointmentId: string,
  lineNo: number | null,
): Promise<string> {
  const marker = `M10-${RUN}-${nonce}-${lineNo ?? 'none'}`
  // ONE transaction, deliberately: `assert_invoice_totals_match_lines` (ZI002) is DEFERRED, so a bare
  // `insert into invoice` commits on its own and is refused as a document with no lines — which is what
  // the first version of this helper did, and both ZG011 cases then reported InvoiceWithoutLines while
  // claiming to be about the redemption pair.
  return sql.begin(async (tx) => {
    const [invoice] = await tx<{ id: string }[]>`
      insert into invoice (document_kind, series_code, period_key, number, display_number,
        issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
        customer_name_snapshot, issue_date, tax_point_date, net_total, vat_total, gross_total, notes)
      values ('simplified_invoice', 'SIMPL-INV', ${marker},
        ${840_000 + nonce * 10 + (lineNo ?? 9)}, ${`${marker}-DOC`},
        'BE RELAX SPA - L.L.C - O.P.C', 'BE RELAX - Massage Center and Spa',
        '100123456700003', '250 Al Meena Street', 'Abu Dhabi', 'Customer 0042',
        ${SOLD_ON}::date, ${SOLD_ON}::date, 20, 2, 22, ${marker})
      returning id
    `
    const invoiceId = invoice?.id ?? ''
    await tx`
      insert into invoice_line (invoice_id, line_no, description_en, quantity, unit_gross_fils,
        vat_rate_bp, line_net_fils, line_vat_fils)
      values (${invoiceId}::uuid, 1, 'Suite probe treatment', 1, 22, 500, 20, 2)
    `
    await tx`
      insert into invoice_appointment (invoice_id, appointment_id, line_no)
      values (${invoiceId}::uuid, ${appointmentId}::uuid, ${lineNo})
    `
    return invoiceId
  }) as unknown as string
}

// -------------------------------------------------------------------------------------------------
// 8. The payment row a package sale never wrote
// -------------------------------------------------------------------------------------------------

describe('the cash taken for a package reaches the drawer', () => {
  /**
   * M-TILL-09's own recorded defect, re-ownered here and fixed: a package sale wrote no `payment` row, so
   * `readDrawerTakings` and ZU005 (0076) — which both sum `payment` for the business day — could not see
   * the cash, and M-TILL-11's cash-up read the drawer as OVER by it and posted the difference to 6140.
   *
   * Asserted as a DELTA over the business day rather than as a total, because the integration suite runs
   * sequentially against one database and earlier files leave payment rows behind (brief rule 12).
   */
  it('a package sale writes one payment row per tender, on the sale’s business day', async () => {
    const [before] = await sql<{ total: string }[]>`
      select coalesce(sum(p.amount_fils), 0)::text as total
        from payment p join tender_type t on t.code = p.tender_kind
       where p.trading_date = ${SOLD_ON}::date and t.gives_change
    `
    const { sold } = await sellOneLine(100_001, 3)
    const [after] = await sql<{ total: string }[]>`
      select coalesce(sum(p.amount_fils), 0)::text as total
        from payment p join tender_type t on t.code = p.tender_kind
       where p.trading_date = ${SOLD_ON}::date and t.gives_change
    `
    expect(Number(after?.total) - Number(before?.total)).toBe(100_001)

    // And the row NAMES the package rather than floating free, which is the half a nullable invoice_id
    // alone would not have given.
    const rows = await sql<{ invoiceId: string | null; packageSaleId: string; tenderNo: number }[]>`
      select invoice_id as "invoiceId", package_sale_id as "packageSaleId", tender_no as "tenderNo"
        from payment where package_sale_id = ${sold.saleId}::uuid order by tender_no
    `
    expect(rows).toHaveLength(1)
    expect(rows[0]?.invoiceId).toBeNull()
    expect(rows[0]?.tenderNo).toBe(1)
  })

  it('refuses a package payment that does not equal the price, in either direction', async () => {
    const { sold } = await sellOneLine(100_001, 3)
    for (const [amount, why] of [
      [1, 'an over-tender'],
      [-1, 'a part payment'],
    ] as const) {
      const attempt = sql.begin(async (tx) => {
        if (amount > 0) {
          await tx`
            insert into payment (invoice_id, package_sale_id, tender_no, tender_kind,
              posting_account_code, amount_fils, change_given_fils, trading_date)
            values (null, ${sold.saleId}::uuid, 2, 'cash', '1010', ${amount}, 0, ${SOLD_ON}::date)
          `
        } else {
          // A part payment, reached by deleting the tender the sale wrote and writing a smaller one. The
          // delete is the OWNER's: `berelax_app` holds no DELETE on payment (0063) and that is the point.
          await tx`delete from payment where package_sale_id = ${sold.saleId}::uuid`
          await tx`
            insert into payment (invoice_id, package_sale_id, tender_no, tender_kind,
              posting_account_code, amount_fils, change_given_fils, trading_date)
            values (null, ${sold.saleId}::uuid, 1, 'cash', '1010', 60_000, 0, ${SOLD_ON}::date)
          `
        }
      })
      await expect(attempt, why).rejects.toThrow(
        new RegExp(PACKAGE_REDEMPTION_SQLSTATE.paymentsDisagree),
      )
    }
  })
})

// -------------------------------------------------------------------------------------------------
// 9. The application role, not the owner
// -------------------------------------------------------------------------------------------------

describe('the statements run as berelax_app and not only as the owner', () => {
  /**
   * M-TILL-09's worst recorded defect was an upsert naming a column outside the application role's UPDATE
   * grant: every test connected as the OWNER, so it passed everything and would have failed on the first
   * real save. 0078 narrowed `package_balance`'s UPDATE to `(sessions_redeemed, released_fils)` for this
   * unit, so the drawdown statement has to be run as the role that will run it in production.
   *
   * The whole path — the redemption INSERT and the balance UPDATE — under `set local role berelax_app`,
   * with the control that the same role still cannot do the things the grants forbid.
   */
  it('inserts a redemption and draws the balance down as berelax_app', async () => {
    const { sold, label } = await sellOneLine(90_000, 3)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const balanceId = row?.id ?? ''
    const mapping = packageRedemptionMapping({
      entryId: entryId(`je-m10-approle-${RUN}-${nonce}`),
      tradingDate: localDate(REDEEMED_ON),
      balance: await balanceState(balanceId),
      appointmentId: uuid(),
      units: 1,
      packageLabel: label,
    })
    const journal = mapping.input.journal
    await sql.begin(async (tx) => {
      await tx.unsafe('set local role berelax_app')
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${journal.entryId}, ${journal.entryDate}::date, ${journal.narrative}, ${journal.source})
      `
      for (const [index, line] of journal.lines.entries()) {
        await tx`
          insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
          values (${journal.entryId}, ${index + 1}, ${line.accountCode}, ${line.debitFils},
                  ${line.creditFils})
        `
      }
      await tx`
        insert into package_redemption (package_balance_id, appointment_id, sessions_redeemed,
          released_fils, vat_fils, vat_rate_bp, trading_date, journal_entry_id)
        values (${balanceId}::uuid, ${uuid()}::uuid, 1, ${mapping.input.releasedFils},
                ${mapping.input.vatFils}, ${mapping.input.vatRateBp}, ${REDEEMED_ON}::date,
                ${journal.entryId})
      `
      await tx`
        update package_balance
           set sessions_redeemed = sessions_redeemed + 1,
               released_fils = package_release_through_fils(value_fils, sessions_total,
                                                            sessions_redeemed + 1)
         where id = ${balanceId}::uuid
      `
    })
    const after = await balanceState(balanceId)
    expect(after.sessionsRedeemed).toBe(1)
    expect(after.releasedGross.fils).toBe(30_000)
  })

  it('the control: berelax_app may not UPDATE or DELETE a redemption, and holds no other balance column', async () => {
    const { sold, label } = await sellOneLine(90_000, 3)
    const [row] = await sql<{ id: string }[]>`
      select id from package_balance where package_sale_id = ${sold.saleId}::uuid
    `
    const balanceId = row?.id ?? ''
    await redeemOnce(balanceId, label, { suffix: 'grants' })

    for (const statement of [
      'update package_redemption set released_fils = 1',
      'delete from package_redemption',
      'update package_balance set value_fils = 1',
      'update package_balance set sessions_total = 99',
    ]) {
      const attempt = sql.begin(async (tx) => {
        await tx.unsafe('set local role berelax_app')
        await tx.unsafe(statement)
      })
      await expect(attempt, statement).rejects.toThrow(/permission denied|ZG007/)
    }

    // And the grants as `information_schema` reports them, which is the claim rather than the symptom.
    const [grants] = await sql<
      { redemptionUpdate: boolean; redemptionDelete: boolean; redemptionInsert: boolean }[]
    >`
      select has_table_privilege('berelax_app', 'package_redemption', 'UPDATE') as "redemptionUpdate",
             has_table_privilege('berelax_app', 'package_redemption', 'DELETE') as "redemptionDelete",
             has_table_privilege('berelax_app', 'package_redemption', 'INSERT') as "redemptionInsert"
    `
    expect(grants).toEqual({
      redemptionUpdate: false,
      redemptionDelete: false,
      redemptionInsert: true,
    })
  }, 30_000)
})
