import { randomUUID } from 'node:crypto'
import {
  ACCOUNTS,
  buildRetentionCohorts,
  type CohortActivity,
  CohortContributionNotAttributable,
  type CohortMember,
  type ContributionMarginUnit,
  type CustomerMergeSubject,
  channelAttributedSpend,
  cohortContributionRow,
  cohortRealisedWindow,
  comparableHorizon,
  contributionMarginUnit,
  EMPTY_KPI_INPUT,
  entryId,
  filsFrom,
  firstTouchPaidStateOf,
  instantFromIso,
  isNoDenominator,
  type KpiCohortContribution,
  type KpiInput,
  localDate,
  measuredCost,
  money,
  noCostByConstruction,
  packageLiabilitySchedule,
  packageLiabilityTotalFils,
  packageSourcedDeferredRevenueFils,
  paymentFeeComponent,
  planCustomerMerge,
  publishedFigure,
  reconcilePackageLiabilityToLedger,
  resolveKpi,
  scoreDuplicatePair,
  type TenderKind,
  totalDeferredRevenueFils,
  unattributableCost,
} from '@berelax/core'
import {
  type Actor,
  acquisitionSpendCensus,
  cohortActivity,
  cohortMembers,
  cohortNetRevenue,
  createConnection,
  currentPackageTemplateVersion,
  ensureCustomer,
  issueInvoice,
  kpiTherapistCostCensus,
  mergeCustomers,
  mergeSurvivorOf,
  packageDeferredRevenueBySource,
  packageEntitlements,
  packageSoldLessReleasedFils,
  readCustomerMergeSubject,
  readPackageDeferredRevenueFils,
  readPackageLiability,
  redeemPackage,
  type Sql,
  savePackageTemplateVersion,
  sellPackage,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { invoiceFixture } from './invoice.ts'
import { packageSaleMapping } from './package.ts'
import {
  assertPackageRedemptionMappingReconciles,
  packageRedemptionMapping,
} from './package-redemption.ts'
import { type SyntheticPerson, syntheticPerson } from './synthetic.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * R-REP-05 — the cohorts, CAC and the package liability against a real database.
 *
 * It lives in `@berelax/fixtures` because the arithmetic is `@berelax/core`'s and the rows are
 * `@berelax/db`'s, and fixtures is the one package allowed to depend on both: `db` must never import
 * `core` (ADR 0001). That is R-REP-02's and R-REP-04's arrangement for the same reason.
 *
 * # What is proved here and nowhere else
 *
 *   1. **A merged customer is in ONE cohort, the earlier one, against a STALE view.** The suite
 *      refreshes `reporting.dim_customer`, THEN merges two records, THEN queries without refreshing —
 *      which is the only window in which the query's `merge_survivor_of` grouping does any work, and is
 *      exactly the window in which somebody has just run a merge and is looking at the screen to see
 *      whether it worked. The control is that the view still holds the tombstone with a first visit of
 *      its own, so the single cohort is the grouping's doing and not the refresh's.
 *   2. **Period 0 equals the cohort size over real deliveries**, with the activity read through
 *      `fact_appointment` so a treatment after midnight counts in its own trading month.
 *   3. **The liability ties to `2050` to the fils, as a DELTA.** `journal_line` is append-only
 *      (ADR 0008, and ZL001 refuses the DELETE) and `2050` is one account every package suite posts to,
 *      so every assertion about it is a delta across this suite's own sale and redemption and never a
 *      total (brief rule 9). What IS asserted as a total is the per-row identity
 *      `floor(value x remaining / total) = value - released`, over every entitlement row in the
 *      database — which needs no isolation because it is a property of each row.
 *   4. **The two figures this unit re-reads are held equal to the functions that own them, in the same
 *      commit.** `packageSoldLessReleasedFils` against `readPackageLiability` (M-TILL-10) and the
 *      source split's total against `readPackageDeferredRevenueFils`. Both are totals, because both
 *      sides read the same rows by the same route.
 *   5. **CAC refuses against this build's own data, MEASURED rather than asserted.** No acquisition
 *      label records a paid first touch, and the acquisition spend census counts the postings, the bill
 *      lines and the channel-tagged rows that exist. The unattributed share over the real cohort is the
 *      whole of it.
 *   6. **No delivery has an attributable cost**, through `kpiTherapistCostCensus`, which is why a
 *      contribution row built from the real margins is refused — ADR 0070 reaching this unit. The LTV
 *      is then asserted to the fils over the same real deliveries with the costs STATED, so the
 *      mechanism is exercised and the gap is visible as a gap.
 *
 * # Why the months are searched for rather than fixed
 *
 * `invoice`, `journal_entry` and `package_redemption` all refuse DELETE for every role, and `customer`
 * cannot be deleted at all (0069's refusal trigger). So a FIXED month would double every figure on a
 * second run, and the brief requires this suite to run twice. It therefore reserves a span of trading
 * years no other suite uses and takes the first run of three consecutive months with no `business_day`
 * row in any of them — months no earlier run can have written to. R-REP-02 and R-REP-04 do the same
 * over 2250-2299, 2300-2349 and 2075.
 *
 * **The YEARS are 2415 to 2514 and nothing in the repository claims a date in them.** R-REP-04's own
 * note records why the year matters more than the days: `TAX-INV` resets ANNUALLY, so a tax invoice
 * issued here consumes a number inside its own `period_key`, and `issue-credit-note.itest.ts` asserts
 * `displayNumber === 'TI-2097-00001'`.
 *
 * **A hundred years, and the arithmetic is why — the first version reserved five and was exhausted by
 * this unit's own gate block.** One run consumes three months. Gate block 149 runs this suite THREE
 * times (149r and 149s each drive it with a module edited, and 149z is the control that drives the real
 * tree), so one gate-block run consumes nine months and one `pnpm verify` consumes twelve with
 * `pnpm test:integration`'s own run. Five years is sixty months, which is twenty runs: five runs of the
 * block plus four direct ones used the lot, and the twenty-first failed on `virginMonths` with the
 * message below. A hundred years is twelve hundred months, which is about a hundred verifies — and the
 * span costs nothing but the two literals. If it is ever exhausted again, widen it rather than reusing a
 * month: a month with a `business_day` row is a month an earlier run's invoices, journal entries and
 * redemptions are in, and none of those can be deleted.
 *
 * Nothing here truncates. Every figure is read over this suite's own months or as a delta across its own
 * writes, so earlier files' rows cannot reach it (brief rule 12) and nothing has to be removed.
 */

const RESERVED_FROM = '2415-01-01'
const RESERVED_TO = '2514-12-31'

const ACTOR: Actor = { kind: 'staff', label: 'R-REP-05 cohort pair itest' }

/**
 * Unique per EXECUTION, so a second run creates its own customers rather than finding the first's.
 *
 * The people come from `syntheticPerson`, which is not a convenience: the duplicate scorer keys a phone
 * number through `crmPhoneKey`, and a number it cannot key is classified `unknown` rather than
 * `identical` — so the merge this suite needs is refused as `merge_verdict_is_distinct`. A hand-built
 * `+97159…` number did exactly that on the first run of this file, and the message named a verdict
 * rather than a prefix. `synthetic.ts` owns the one prefix that is both unallocated (so it cannot reach
 * a real handset) and keyable.
 *
 * The base index is drawn per execution because `customer` cannot be deleted at all — 0069's refusal
 * trigger — so a second run must not find the first run's records: `ensureCustomer` keys on the phone
 * and would return them, with a first visit in a month this run does not cover.
 */
const PROBE_BASE =
  7_000_000 + (Number.parseInt(randomUUID().replace(/-/g, '').slice(0, 8), 16) % 150_000)
const PROBE_INDEX: Record<string, number> = { a: 0, b: 1, c: 2, d: 3, e: 4 }
const probePerson = (who: string): SyntheticPerson =>
  syntheticPerson(PROBE_BASE + (PROBE_INDEX[who] ?? 9))

/** A token for the identifiers this run issues: a template key, two journal entry ids. */
const RUN = String(PROBE_BASE)

/** 21,000 gross: net 20,000, VAT 1,000 (VAT is the remainder, ADR 0007). */
const TREATMENT_GROSS = 21_000
const TREATMENT_NET = 20_000
/** Two sessions at 60,000 gross. One redemption releases 30,000 gross. */
const PACKAGE_GROSS = 60_000

let sql: Sql
let months: readonly string[]
let tradingDates: readonly string[]
let variantId: string
let roomId: string
let employeeId: string
/** A: every month. B: the first only. C: the second only. */
let customerA: string
let customerB: string
let customerC: string
/** The merge pair: D acquired in month 0, E in month 1, E merged INTO D. */
let survivorD: string
let loserE: string
let invoiceANet: bigint
let templateKey: string
let packageSaleId: string

const dubai = (date: string, hhmm: string): string => `${date} ${hhmm}:00+04`

/**
 * The first three consecutive months in the reserved span with no `business_day` row in any of them.
 *
 * Three and not one, because a cohort needs a horizon: a retention grid over one month proves period 0
 * and nothing else, and the figure this unit is about is the value at month 2.
 */
async function virginMonths(): Promise<readonly string[]> {
  const rows = await sql<{ month: string }[]>`
    select m::date::text as month
      from generate_series(${RESERVED_FROM}::date, ${RESERVED_TO}::date, interval '1 month') m
     where not exists (
             select 1 from business_day bd
              where bd.trading_date >= m::date
                and bd.trading_date < (m::date + interval '3 months')
           )
     order by m
     limit 1
  `
  const first = rows[0]?.month
  if (first === undefined) {
    throw new Error(
      `every three-month run from ${RESERVED_FROM} to ${RESERVED_TO} is already used. This suite ` +
        'cannot delete an invoice, a journal entry, a redemption or a customer, so it needs three ' +
        'fresh months each run — and gate block 149 drives it three times, so a gate-block run costs ' +
        'nine months. Widen RESERVED_TO rather than reusing a month: a month with a business_day row ' +
        "is a month an earlier run's documents are in.",
    )
  }
  const [year, month] = [Number(first.slice(0, 4)), Number(first.slice(5, 7))]
  return Object.freeze(
    [0, 1, 2].map((step) => {
      const index = month - 1 + step
      const y = year + Math.floor(index / 12)
      const m = (index % 12) + 1
      return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`
    }),
  )
}

async function openTradingDay(tradingDate: string): Promise<void> {
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (
      ${tradingDate}::date,
      (${tradingDate}::date + time '11:00') at time zone 'Asia/Dubai',
      (${tradingDate}::date + 1 + time '02:00') at time zone 'Asia/Dubai',
      'weekly'
    )
    on conflict (trading_date) do nothing
  `
}

async function newCustomer(who: string): Promise<string> {
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const result = await ensureCustomer(uow, {
      phoneE164: probePerson(who).phone,
      displayName: null,
      nameMatchKey: null,
      locale: 'en',
      createdVia: 'front_desk',
    })
    return result.customer.id
  })
}

/** A booking and one DELIVERED appointment on `tradingDate`, which is what a cohort visit is. */
async function deliverTreatment(args: {
  readonly customerId: string
  readonly tradingDate: string
  readonly hour: number
}): Promise<string> {
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${args.customerId}::uuid, 'walk_in', 'R-REP-05 cohort pair itest')
    returning id::text as id
  `
  const bookingId = booking?.id
  if (bookingId === undefined) throw new Error('the booking insert returned no row')
  const slot =
    `[${dubai(args.tradingDate, `${String(args.hour).padStart(2, '0')}:00`)},` +
    `${dubai(args.tradingDate, `${String(args.hour).padStart(2, '0')}:50`)})`
  const [appointment] = await sql<{ id: string }[]>`
    insert into appointment (
      booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
      delivery_id, room_places, turnaround_minutes, therapist_buffer_minutes,
      gross_price_fils, net_fils, vat_fils, vat_rate_bp
    ) values (
      ${bookingId}::uuid, ${args.tradingDate}::date, ${variantId}::uuid, 'solo'::service_shape,
      ${employeeId}::uuid, ${roomId}::uuid, ${slot}::tstzrange, 'completed'::appointment_status,
      gen_random_uuid(), 1, 10, 10,
      ${TREATMENT_GROSS}, ${TREATMENT_NET}, ${TREATMENT_GROSS - TREATMENT_NET}, 500
    )
    returning id::text as id
  `
  const id = appointment?.id
  if (id === undefined) throw new Error('the appointment insert returned no row')
  return id
}

/** One tax invoice for one treatment, with the series counter aligned first. */
async function issueOneInvoice(args: {
  readonly customerId: string
  readonly tradingDate: string
}): Promise<bigint> {
  // R-REP-04's alignment, verbatim in intent: `allocate_document_number` sets `next_number = 2`
  // whenever the `period_key` CHANGES (0013), so a run here, then any other suite issuing in its own
  // probe year, then a second run here, resets the counter to 1 and collides with this suite's own
  // earlier `TI-<year>-00001` on `invoice_display_number_unique` — with a message about a display
  // number and nothing about ordering. Setting it one past the highest this series has issued in this
  // period is idempotent and is what `issue-credit-note.itest.ts` does in its `beforeEach`.
  const year = args.tradingDate.slice(0, 4)
  await sql`
    update document_series s
       set period_key = ${year},
           next_number = coalesce(
             (select max(i.number) from invoice i
               where i.series_code = s.code and i.period_key = ${year}),
             0
           ) + 1
     where s.code = 'TAX-INV'
  `
  const fixture = invoiceFixture({
    supplyAt: instantFromIso(`${args.tradingDate}T12:00:00+04:00`),
    issuedAt: instantFromIso(`${args.tradingDate}T12:30:00+04:00`),
    customerId: args.customerId,
    lines: [{ descriptionEn: 'Massage, 50 minutes', quantity: 1, unitGrossFils: TREATMENT_GROSS }],
  })
  const issued = await withUnitOfWork(sql, ACTOR, (uow) => issueInvoice(uow, fixture.input))
  const [row] = await sql<{ netTotal: string }[]>`
    select net_total::text as "netTotal" from invoice where id = ${issued.id}::uuid
  `
  return BigInt(row?.netTotal ?? '0')
}

const refresh = async (view: string): Promise<void> => {
  await sql`select reporting.refresh(${view}, 'on_demand')`
}

const inputOf = (overrides: Partial<KpiInput>): KpiInput => ({ ...EMPTY_KPI_INPUT, ...overrides })

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })
  months = await virginMonths()
  // The 9th of each month: well inside it, so no arithmetic here can land on a boundary.
  tradingDates = Object.freeze(months.map((month) => `${month.slice(0, 8)}09`))
  for (const tradingDate of tradingDates) await openTradingDay(tradingDate)
  // A lock over these years left behind by another suite would refuse every posting by ZL002, and every
  // case would report that instead of what it is about.
  await sql`delete from period_lock where starts_on >= ${RESERVED_FROM}::date and ends_on <= ${RESERVED_TO}::date`

  const [variant] = await sql<{ id: string }[]>`
    select v.id::text as id from service_variant v join service s on s.id = v.service_id
     where s.archived_at is null order by v.id limit 1
  `
  const [room] = await sql<{ id: string }[]>`select id::text as id from rooms order by id limit 1`
  const [employee] = await sql<{ id: string }[]>`
    select id::text as id from employee order by id limit 1
  `
  variantId = variant?.id ?? ''
  roomId = room?.id ?? ''
  employeeId = employee?.id ?? ''
  if (!variantId || !roomId || !employeeId) {
    throw new Error('the fixture salon is not seeded: run `pnpm seed` (brief rule 24)')
  }

  customerA = await newCustomer('a')
  customerB = await newCustomer('b')
  customerC = await newCustomer('c')
  // D is created FIRST so it is the earlier record and `planCustomerMerge` picks it as the survivor.
  survivorD = await newCustomer('d')
  loserE = await newCustomer('e')

  const [m0, m1, m2] = tradingDates as readonly [string, string, string]
  await deliverTreatment({ customerId: customerA, tradingDate: m0, hour: 11 })
  await deliverTreatment({ customerId: customerA, tradingDate: m1, hour: 11 })
  await deliverTreatment({ customerId: customerA, tradingDate: m2, hour: 11 })
  await deliverTreatment({ customerId: customerB, tradingDate: m0, hour: 12 })
  await deliverTreatment({ customerId: customerC, tradingDate: m1, hour: 12 })
  await deliverTreatment({ customerId: survivorD, tradingDate: m0, hour: 13 })
  await deliverTreatment({ customerId: loserE, tradingDate: m1, hour: 13 })

  invoiceANet = await issueOneInvoice({ customerId: customerA, tradingDate: m0 })
  await issueOneInvoice({ customerId: customerB, tradingDate: m0 })

  // The views are refreshed BEFORE the merge, deliberately. See the header: the stale window is the
  // only one in which the query's survivor grouping does any work, and it is the window a person is
  // looking at the screen in.
  await refresh('dim_customer')
  await refresh('fact_appointment')
  await refresh('fact_sale')

  const subjectOf = async (id: string): Promise<CustomerMergeSubject> => {
    const subject = await readCustomerMergeSubject(sql, id)
    if (subject === null) throw new Error(`the fixture customer ${id} is missing`)
    return subject as CustomerMergeSubject
  }
  // One number scored against ITSELF, which is what the fixture represents: two spellings of one
  // handset, the only shape C-CRM-02's table lets `auto_merge` act on. `merge.itest.ts` does the same,
  // and for the same reason — `customer.phone_e164` is UNIQUE, so two probe records cannot share one.
  const probeD = probePerson('d')
  const score = scoreDuplicatePair(
    { phone: probeD.phone, label: probeD.label },
    { phone: probeD.phone, label: probeD.label },
  )
  const decision = planCustomerMerge(
    await subjectOf(survivorD),
    await subjectOf(loserE),
    score,
    'auto_merge',
  )
  if (decision.kind !== 'plan') {
    throw new Error(`the fixture merge pair was refused by the planner: ${decision.refusal}`)
  }
  if (decision.survivorId !== survivorD) {
    throw new Error('the earlier record is meant to survive; the fixture creates D first')
  }
  await withUnitOfWork(sql, ACTOR, (uow) =>
    mergeCustomers(uow, {
      plan: decision,
      mergedAtIso: `${m1}T10:00:00.000Z`,
      reason: 'R-REP-05: one person, two records, so one cohort.',
      actorKind: 'staff',
      actorLabel: 'R-REP-05 cohort pair itest',
    }),
  )
  // Read the TOMBSTONE back rather than trusting the call's own word, because what every cohort
  // assertion below depends on is `merge_record` holding the edge, not the function having returned.
  if ((await mergeSurvivorOf(sql, loserE)) !== survivorD) {
    throw new Error('the fixture merge did not take: the loser still resolves to itself')
  }

  templateKey = `rrep05_${RUN}`
  await withUnitOfWork(sql, ACTOR, (uow) =>
    savePackageTemplateVersion(uow, {
      templateKey,
      internalName: 'R-REP-05 liability course',
      publicDisplayName: 'R-REP-05 liability course',
      priceFils: PACKAGE_GROSS,
      lines: [{ serviceVariantId: variantId, sessionCount: 2 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }),
  )
}, 120_000)

afterAll(async () => {
  if (sql !== undefined) await sql.end({ timeout: 5 })
})

const periodOf = () => ({
  periodId: `rrep05-${months[0]}`,
  startsOn: months[0] as string,
  endsOn: `${(months[2] as string).slice(0, 8)}28`,
})

// --- the cohorts ---------------------------------------------------------------------------------

describe('retention cohorts over real deliveries', () => {
  it('keys a cohort on the first DELIVERED visit, and puts a merged customer in the earlier one', async () => {
    const members = await cohortMembers(sql, { period: periodOf() })
    const byId = new Map(members.map((member) => [member.customerId, member]))

    // Four people, not five: D and E are one person. And D's cohort is month 0, which is E's EARLIER
    // record's month, not the month E was acquired in.
    expect(members).toHaveLength(4)
    expect([...byId.keys()].sort()).toEqual([customerA, customerB, customerC, survivorD].sort())
    expect(byId.get(survivorD)?.cohortMonth).toBe(months[0])
    expect(byId.get(customerA)?.cohortMonth).toBe(months[0])
    expect(byId.get(customerB)?.cohortMonth).toBe(months[0])
    expect(byId.get(customerC)?.cohortMonth).toBe(months[1])
    expect(byId.has(loserE)).toBe(false)

    // The control, and it is what makes the assertion above about the GROUPING rather than about a
    // refresh that happened to tidy up: the view has not been refreshed since the merge, so it still
    // holds the tombstone with a first visit of its own in month 1. Without
    // `group by merge_survivor_of(...)` the query would return five members and a month-1 cohort of
    // two.
    const [stale] = await sql<{ firstVisit: string | null }[]>`
      select first_visit_business_day::text as "firstVisit"
        from reporting.dim_customer where customer_id = ${loserE}::uuid
    `
    expect(stale?.firstVisit).toBe(`${(months[1] as string).slice(0, 8)}09`)
    expect(await mergeSurvivorOf(sql, loserE)).toBe(survivorD)
  })

  it("period 0's count equals the cohort size, over activity read from fact_appointment", async () => {
    const members = await cohortMembers(sql, { period: periodOf() })
    const activity = await cohortActivity(sql, {
      fromMonth: months[0] as string,
      throughMonth: months[2] as string,
    })
    const cohorts = buildRetentionCohorts({
      members: members.map(
        (member): CohortMember => ({
          customerId: member.customerId,
          firstVisitBusinessDay: localDate(member.firstVisitBusinessDay),
          firstTouch: firstTouchPaidStateOf(member.acquisitionSource as never),
        }),
      ),
      activity: activity
        .filter((row) => members.some((member) => member.customerId === row.customerId))
        .map(
          (row): CohortActivity => ({
            customerId: row.customerId,
            activityMonth: localDate(row.activityMonth),
          }),
        ),
      horizonMonths: 3,
    })

    expect(cohorts.map((cohort) => cohort.cohortMonth)).toEqual([months[0], months[1]])
    for (const cohort of cohorts) {
      expect(cohort.periods[0]?.activeCustomers).toBe(cohort.cohortSize)
      expect(cohort.periods[0]?.retainedBasisPoints).toBe(10_000)
    }
    // Month 0's cohort is A, B and the survivor. A came back in both later months; the survivor came
    // back in month 1 through the record that was merged away, which the activity read resolves.
    const first = cohorts[0]
    expect(first?.cohortSize).toBe(3)
    expect(first?.periods.map((period) => period.activeCustomers)).toEqual([3, 2, 1])
    // 2/3 of a cohort is 6,667 bp half-up, which is the figure and not 6,666: the share is rounded
    // once, here, and a report that recomputed it from the counts would get the same answer.
    expect(first?.periods[1]?.retainedBasisPoints).toBe(6_667)
    expect(cohorts[1]?.cohortSize).toBe(1)
  })

  it("reports net revenue per customer-month from the documents' own tax points", async () => {
    const revenue = await cohortNetRevenue(sql, {
      fromMonth: months[0] as string,
      throughMonth: months[2] as string,
    })
    const forA = revenue.find((row) => row.customerId === customerA)
    expect(forA?.revenueMonth).toBe(months[0])
    expect(forA?.netFils).toBe(invoiceANet)
    expect(forA?.netFils).toBe(BigInt(TREATMENT_NET))
    expect(forA?.documentCount).toBe(1)
    // The control: A was DELIVERED a treatment in months 1 and 2 and invoiced for neither, so revenue
    // and activity are different facts and this query must not invent the second from the first.
    expect(revenue.filter((row) => row.customerId === customerA)).toHaveLength(1)
  })
})

// --- realised, never forecast, over the real cohort ---------------------------------------------

describe('the realised value of a real cohort', () => {
  /** The month-0 cohort's three customers, their window, and their deliveries. */
  const worked = async (): Promise<{
    members: KpiInput['cohortMembers']
    monthsOf: KpiInput['cohortMonths']
  }> => {
    const rows = await cohortMembers(sql, { period: periodOf() })
    return {
      members: rows
        .filter((row) => row.cohortMonth === months[0])
        .map((row) => ({
          customerId: row.customerId,
          cohortMonth: localDate(row.cohortMonth),
          firstTouch: firstTouchPaidStateOf(row.acquisitionSource as never),
        })),
      monthsOf: cohortRealisedWindow({
        cohortMonth: localDate(months[0] as string),
        horizonMonths: 3,
        // The last complete month is the suite's own third month, taken from the trading calendar and
        // never from a clock: this module reads no instant for ADR 0060's reason.
        throughMonth: localDate(months[2] as string),
      }),
    }
  }

  it('refuses a horizon past the months the cohort has lived', async () => {
    const { monthsOf } = await worked()
    expect(monthsOf).toHaveLength(3)
    expect(() =>
      cohortRealisedWindow({
        cohortMonth: localDate(months[0] as string),
        horizonMonths: 4,
        throughMonth: localDate(months[2] as string),
      }),
    ).toThrow(/has 3 fully elapsed month/)
    // And the horizon the two cohorts can be compared at is the younger one's, which is two.
    expect(
      comparableHorizon(
        [localDate(months[0] as string), localDate(months[1] as string)],
        localDate(months[2] as string),
      ),
    ).toBe(2)
  })

  it('MEASURES that no delivery in this build has an attributable cost, so a contribution is refused', async () => {
    const census = await kpiTherapistCostCensus(sql, {
      period: {
        periodId: periodOf().periodId,
        startsOn: periodOf().startsOn,
        endsOn: periodOf().endsOn,
      },
    })
    // Not asserted — measured. ADR 0070's two facts, read off this database: the commission module
    // publishes no rule version, so there are no commission lines at the right grain; and every
    // delivering employee is unpriced, so no wage can be attributed either.
    expect(census.publishedCommissionRuleVersions).toBe(0)
    expect(census.unpricedEmployees).toBeGreaterThan(0)

    const asThisBuildKnowsIt: ContributionMarginUnit = contributionMarginUnit({
      appointmentId: 'rrep05-real',
      serviceVariantId: variantId,
      treatmentStyle: 'asian',
      netPriceFils: BigInt(TREATMENT_NET),
      source: { basis: 'invoice_line', invoiceId: 'rrep05', lineNo: 1 },
      costs: [
        unattributableCost(
          'therapist',
          `measured on this database: ${census.publishedCommissionRuleVersions} published commission ` +
            `rule version(s) and ${census.unpricedEmployees} delivering employee(s) ` +
            'with no wage recorded',
        ),
        unattributableCost(
          'consumables',
          'the ledger holds the period total on 6030 and nothing per treatment',
        ),
        unattributableCost('room_consumables', 'no room cost is recorded anywhere'),
        paymentFeeComponent(['cash']),
      ],
    })
    expect(asThisBuildKnowsIt.state).toBe('not_attributable')
    expect(() =>
      cohortContributionRow({
        cohortMonth: localDate(months[0] as string),
        monthIndex: 0,
        customerId: customerA,
        units: [asThisBuildKnowsIt],
      }),
    ).toThrow(CohortContributionNotAttributable)
  })

  it('is the cumulative realised contribution per customer, to the fils', async () => {
    const { members, monthsOf } = await worked()
    expect(members).toHaveLength(3)

    // The costs are STATED here, which is the only way a contribution exists in this build, and the
    // figures are this fixture's rather than the business's: a therapist cost of 6,000 fils and
    // nothing else attributable. Net 20,000 less 6,000 is 14,000 fils of margin per delivery.
    const delivered = await sql<{ customerId: string; month: string; appointmentId: string }[]>`
      select merge_survivor_of(a.customer_id)::text          as "customerId",
             date_trunc('month', a.business_day)::date::text as month,
             a.appointment_id::text                          as "appointmentId"
        from reporting.fact_appointment a
       where a.is_delivered
         and a.business_day between ${periodOf().startsOn}::date and ${periodOf().endsOn}::date
       order by 1, 2
    `
    const mine = delivered.filter((row) => members.some((m) => m.customerId === row.customerId))
    // A three times, B once, the survivor twice (its own and the merged record's) — six deliveries.
    expect(mine).toHaveLength(6)

    const contributions: KpiCohortContribution[] = []
    for (const member of members) {
      for (const [monthIndex, month] of (months as readonly string[]).entries()) {
        const units = mine
          .filter((row) => row.customerId === member.customerId && row.month === month)
          .map((row) =>
            contributionMarginUnit({
              appointmentId: row.appointmentId,
              serviceVariantId: variantId,
              treatmentStyle: 'asian',
              netPriceFils: BigInt(TREATMENT_NET),
              source: { basis: 'invoice_line', invoiceId: 'rrep05', lineNo: 1 },
              costs: [
                measuredCost('therapist', 6_000n, 'stated by this fixture, not by the business'),
                noCostByConstruction('consumables', 'none consumed by this fixture treatment'),
                noCostByConstruction('room_consumables', 'none consumed by this fixture treatment'),
                paymentFeeComponent(['cash']),
              ],
            }),
          )
        if (units.length === 0) continue
        contributions.push(
          cohortContributionRow({
            cohortMonth: localDate(months[0] as string),
            monthIndex,
            customerId: member.customerId,
            units,
          }),
        )
      }
    }

    // Six deliveries at 14,000 fils is 84,000 over three customers: 28,000 fils each, at a horizon of
    // three months, which is 9,333 fils a month half-up.
    const input = inputOf({
      cohortMembers: members,
      cohortMonths: monthsOf,
      cohortContributions: contributions,
    })
    const value = resolveKpi('cohort_realised_value_per_customer').compute(input)
    expect(isNoDenominator(value)).toBe(false)
    if (!isNoDenominator(value)) {
      expect(publishedFigure(value)).toBe('28000')
      expect(value.unit).toBe('fils_per_customer')
    }
    const monthly = resolveKpi('cohort_monthly_contribution_per_customer').compute(input)
    if (!isNoDenominator(monthly)) expect(publishedFigure(monthly)).toBe('9333')

    // And the control for "realised": the same contributions at a two-month horizon are a SMALLER
    // figure, because month 2's delivery is outside the window. A figure that did not move with the
    // horizon would be a figure the horizon does not bound.
    const shorter = inputOf({
      ...input,
      cohortMonths: cohortRealisedWindow({
        cohortMonth: localDate(months[0] as string),
        horizonMonths: 2,
        throughMonth: localDate(months[2] as string),
      }),
    })
    const atTwo = resolveKpi('cohort_realised_value_per_customer').compute(shorter)
    if (!isNoDenominator(atTwo)) expect(publishedFigure(atTwo)).toBe('23333')
  })
})

// --- CAC, measured against this build's own data ------------------------------------------------

describe("CAC against this build's own data", () => {
  it('finds no acquisition spend at all, and no channel tag to attribute one by', async () => {
    const census = await acquisitionSpendCensus(sql, {
      period: periodOf(),
      marketingAccountCodes: [ACCOUNTS.marketing as string],
    })
    expect(census.accountCodes).toEqual(['6070'])
    // MEASURED, not assumed: nothing in this build has ever posted to the marketing account, and no
    // cost table carries a channel to attribute one by. Both halves of CAC are mechanisms today.
    expect(census.movementFils).toBe(0n)
    expect(census.journalLineCount).toBe(0)
    expect(census.channelTaggedRows).toBe(0)
    expect(census.billLineCount).toBe(0)
    expect(census.recurringCostCount).toBe(0)
    // A census of nothing is `channelAttributedSpend([])` and not a refusal: a period in which the
    // business genuinely spent nothing has a real figure of zero. The refusal is for a MOVEMENT no
    // channel claims, which this build will produce the first time a marketing bill is entered.
    expect(() =>
      channelAttributedSpend([], `measured: ${census.journalLineCount} posting(s) on 6070`),
    ).not.toThrow()
  })

  it('answers no_denominator for CAC and publishes the unattributed share as the whole of it', async () => {
    const rows = await cohortMembers(sql, { period: periodOf() })
    const members = rows.map((row) => ({
      customerId: row.customerId,
      cohortMonth: localDate(row.cohortMonth),
      firstTouch: firstTouchPaidStateOf(row.acquisitionSource as never),
    }))
    // Every real member's first touch is unrecorded, because no label in `customer_acquisition_source`
    // records paid-ness — which is the measurement, not a fixture choice.
    expect(new Set(members.map((member) => member.firstTouch))).toEqual(new Set(['not_recorded']))
    expect(new Set(rows.map((row) => row.acquisitionSource))).toEqual(new Set(['unknown']))

    const input = inputOf({
      cohortMembers: members,
      cohortMonths: cohortRealisedWindow({
        cohortMonth: localDate(months[0] as string),
        horizonMonths: 1,
        throughMonth: localDate(months[2] as string),
      }),
    })
    const cac = resolveKpi('customer_acquisition_cost').compute(input)
    expect(isNoDenominator(cac)).toBe(true)
    if (isNoDenominator(cac)) {
      expect(cac.divisorFormula).toBe('new_customers_from_paid_channels')
      expect(cac.provisional?.openQuestionId).toBe('Y9-paid-channel-attribution')
    }
    // The figure that says why the tile is empty, published beside it.
    const share = resolveKpi('acquisition_unattributed_share').compute(input)
    if (!isNoDenominator(share)) expect(publishedFigure(share)).toBe('1.0000')
    // And the payback, which divides by a cohort with no contribution row.
    expect(isNoDenominator(resolveKpi('cac_payback_months').compute(input))).toBe(true)
  })
})

// --- the outstanding package liability ----------------------------------------------------------

describe('the outstanding package liability', () => {
  /** The three independent reads, taken together so a delta across them is one instant's worth. */
  const readAll = async (asAt: string) => {
    const entitlements = await packageEntitlements(sql, { asAt })
    const ledger = await packageDeferredRevenueBySource(sql, {
      asAt,
      deferredRevenueAccountCode: ACCOUNTS.packageDeferredRevenue as string,
    })
    return {
      schedule: packageLiabilityTotalFils(packageLiabilitySchedule(entitlements)),
      ledger,
      soldLessReleased: await packageSoldLessReleasedFils(sql, { asAt }),
      entitlements,
    }
  }

  it('ties the session schedule to 2050 and to sold − released, as a delta across its own writes', async () => {
    const asAt = `${(months[2] as string).slice(0, 8)}28`
    const before = await readAll(asAt)

    const version = await currentPackageTemplateVersion(sql, templateKey)
    if (version === null) throw new Error('the template version just saved cannot be read back')
    const saleMapping = packageSaleMapping({
      entryId: entryId(`je-rrep05-sale-${RUN}`),
      tradingDate: localDate(tradingDates[0] as string),
      customerId: customerA,
      templateVersionId: version.versionId,
      priceGross: money(filsFrom(PACKAGE_GROSS)),
      lines: version.lines.map((line) => ({
        lineNo: line.lineNo,
        serviceVariantId: line.serviceVariantId,
        sessionCount: line.sessionCount,
        listGrossFils: line.listGrossFils,
      })),
      tenders: [{ kind: 'cash' as TenderKind, amount: money(filsFrom(PACKAGE_GROSS)) }],
      validityMonths: version.validityMonths,
      transferable: version.transferable,
      unredeemedBalancePolicy: version.unredeemedBalancePolicy,
      packageLabel: version.internalName,
    })
    const sold = await withUnitOfWork(sql, ACTOR, (uow) => sellPackage(uow, saleMapping.input))
    packageSaleId = sold.saleId
    const redeemAppointment = await deliverTreatment({
      customerId: customerA,
      tradingDate: tradingDates[1] as string,
      hour: 15,
    })
    const [balance] = await sql<
      {
        id: string
        sessionsTotal: number
        sessionsRedeemed: number
        valueFils: string
        releasedFils: string
      }[]
    >`
      select id::text as id, sessions_total as "sessionsTotal",
             sessions_redeemed as "sessionsRedeemed", value_fils::text as "valueFils",
             released_fils::text as "releasedFils"
        from package_balance where package_sale_id = ${packageSaleId}::uuid
    `
    if (balance === undefined) throw new Error('the sale opened no balance')
    const redemption = assertPackageRedemptionMappingReconciles(
      packageRedemptionMapping({
        entryId: entryId(`je-rrep05-red-${RUN}`),
        tradingDate: localDate(tradingDates[1] as string),
        balance: {
          balanceId: balance.id,
          sessionsTotal: balance.sessionsTotal,
          sessionsRedeemed: balance.sessionsRedeemed,
          valueGross: money(filsFrom(Number(balance.valueFils))),
          releasedGross: money(filsFrom(Number(balance.releasedFils))),
        },
        appointmentId: redeemAppointment,
        units: 1,
        packageLabel: version.internalName,
      }),
    )
    await withUnitOfWork(sql, ACTOR, (uow) => redeemPackage(uow, redemption.input))

    const after = await readAll(asAt)
    // One of two sessions taken on a 60,000-fils line: the release formula gives
    // ceil(60,000 x 1 / 2) = 30,000, so 30,000 remains. All three reads move by exactly that.
    //
    // DELTAS and not totals, because `journal_line` is append-only (ADR 0008, ZL001) and `2050` is one
    // account every package suite in this repository posts to — a total here would be a claim about
    // every other suite's rows as well (brief rule 9 and rule 12).
    const scheduleDelta = after.schedule - before.schedule
    const ledgerDelta =
      packageSourcedDeferredRevenueFils(after.ledger) -
      packageSourcedDeferredRevenueFils(before.ledger)
    const soldDelta = after.soldLessReleased - before.soldLessReleased
    expect(scheduleDelta).toBe(30_000n)
    expect(ledgerDelta).toBe(30_000n)
    expect(soldDelta).toBe(30_000n)

    const reconciliation = reconcilePackageLiabilityToLedger({
      lines: packageLiabilitySchedule(
        after.entitlements.filter((row) => row.packageSaleId === packageSaleId),
      ),
      ledger: {
        packageSaleFils: after.ledger.packageSaleFils - before.ledger.packageSaleFils,
        packageRedemptionFils:
          after.ledger.packageRedemptionFils - before.ledger.packageRedemptionFils,
        openingBalanceFils: after.ledger.openingBalanceFils - before.ledger.openingBalanceFils,
        otherFils: after.ledger.otherFils - before.ledger.otherFils,
      },
      soldLessReleasedFils: soldDelta,
    })
    expect(reconciliation.variances).toEqual([])
    expect(reconciliation.outstandingFils).toBe(30_000n)
    expect(reconciliation.sessionsRemaining).toBe(1)
    // And the control: a posting to 2050 from outside the package path would have shown on its own
    // line rather than inside the first one. This suite made none, so the census figure is zero.
    expect(after.ledger.otherFils - before.ledger.otherFils).toBe(0n)
  })

  it('holds the session share equal to value − released for EVERY entitlement row in the database', async () => {
    // A total rather than a delta, and it needs no isolation: the identity
    // `floor(value x remaining / total) = value - ceil(value x redeemed / total)` is a property of each
    // ROW, so every row any suite has ever written is evidence about it. ZG009 re-adds the release
    // formula over every balance, so a row that failed this would be a row drawn down by something the
    // database should have refused.
    const rows = await packageEntitlements(sql, { asAt: `${(months[2] as string).slice(0, 8)}28` })
    expect(rows.length).toBeGreaterThan(0)
    let partlyDrawn = 0
    for (const line of packageLiabilitySchedule(rows)) {
      const row = rows.find((candidate) => candidate.balanceId === line.balanceId)
      if (row === undefined) throw new Error('the schedule invented a balance')
      if (row.releasedFils > 0n) partlyDrawn += 1
      expect(line.outstandingFils, `balance ${line.balanceId}`).toBe(
        row.valueFils - row.releasedFils,
      )
    }
    // The count that makes it evidence rather than a tautology over untouched balances: a row with
    // nothing released satisfies the identity for any implementation that returns `value` unchanged.
    expect(partlyDrawn).toBeGreaterThan(0)
  })

  it('holds the two re-read figures equal to the functions that own them', async () => {
    const asAt = `${(months[2] as string).slice(0, 8)}28`
    // `packageSoldLessReleasedFils` against M-TILL-10's own subtraction, and the source split's total
    // against `readPackageDeferredRevenueFils`. Both are TOTALS, because both sides read the same rows
    // by the same route — which is what makes this a check that holds two readings equal rather than a
    // claim about isolation. Stated in the same commit as the second reading (brief rule: a second
    // statement of a fact drifts).
    const owned = await readPackageLiability(sql, asAt)
    expect(await packageSoldLessReleasedFils(sql, { asAt })).toBe(BigInt(owned.outstandingFils))

    const split = await packageDeferredRevenueBySource(sql, {
      asAt,
      deferredRevenueAccountCode: ACCOUNTS.packageDeferredRevenue as string,
    })
    // `readPackageDeferredRevenueFils` reads the whole account with no date bound, so the split is
    // compared at an `asAt` past every trading date any suite uses.
    expect(totalDeferredRevenueFils(split)).toBe(BigInt(await readPackageDeferredRevenueFils(sql)))
    // And `readPackageLiability`'s own ledger figure is the NARROWER scope — the till's two sources —
    // which is the difference this unit's split exists to make visible rather than absorb.
    expect(split.packageSaleFils + split.packageRedemptionFils).toBe(
      BigInt(owned.ledgerBalanceFils),
    )
  })
})
