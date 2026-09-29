import {
  ACCOUNTS,
  commissionFilsFor,
  entryId,
  filsFrom,
  localDate,
  money,
  splitGross,
  type TenderLine,
} from '@berelax/core'
import {
  type Actor,
  COMMISSION_SQLSTATE,
  createConnection,
  currentPackageTemplateVersion,
  issueInvoice,
  lockAccountingPeriod,
  postJournalEntry,
  publishCommissionRuleVersion,
  readCommissionDerivation,
  readCommissionEarnings,
  readCommissionRuleVersions,
  readCommissionRuns,
  redeemPackage,
  type Sql,
  savePackageTemplateVersion,
  sellPackage,
  unconfirmedAssumptionRows,
  withUnitOfWork,
} from '@berelax/db'
import {
  executeCommissionRun,
  readCommissionDerivationFor,
  recomputeCommissionRun,
} from '@berelax/hr'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_TRN } from './invoice.ts'
import {
  truncateCommissionFamily,
  truncateInvoiceFamily,
  truncatePackageFamily,
} from './invoice-family.ts'
import { packageSaleMapping } from './package.ts'
import {
  assertPackageRedemptionMappingReconciles,
  packageRedemptionMapping,
} from './package-redemption.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The PAIR for commission: `@berelax/core`'s arithmetic against the rows `@berelax/db` writes, against the
 * rules PostgreSQL holds, and against a period that has been FILED.
 *
 * `packages/db` may never import `packages/core`, so each half is exercised against a structural mirror of
 * the other and neither half's own suite can see the mapping between them. This file is where both can be
 * imported at once, and there are four things only it can assert:
 *
 *   1. **A recompute reproduces byte-identically, under a version that has since been SUPERSEDED.** The
 *      superseding version here is effective-dated BEFORE the period, so a fresh resolve really would pick
 *      it — which is what makes the reproduction a claim about the pin rather than about the calendar. The
 *      control runs that fresh resolve and asserts a DIFFERENT total.
 *   2. **A run over a locked period reads the figures AS FILED.** An appointment backdated into the closed
 *      month after the close is invisible to the run and visible to a read at `now`, which is the same query
 *      with one argument changed.
 *   3. **One formula, two implementations.** `commission_fils_for()` in SQL against `commissionFilsFor` in
 *      TypeScript, over a bounded CENSUS rather than a sample: "these two agree" checked on random inputs is
 *      a claim about the seed.
 *   4. **The gating rule, one case each.** A no-show, a cancellation and a completed-but-unpaid visit each
 *      produce zero lines, with a completed-and-paid visit beside them as the control.
 *
 * **Every rate in this file is this file's own fixture.** `commission_rule` (0097) seeds nothing, because
 * Y9-commission is open and its provisional answer is that no commission structure is configured — so
 * nothing below may be read as what this business pays.
 *
 * The business days are in **2081**, which no other suite and no gate posts into: 2083 and 2084 are
 * M-TILL-10's, 2085 and 2086 are gate blocks, 2087 onwards are M-TILL-11's, the journal's, period-close's
 * and the three fixtures suites'. 2082 is this unit's GATE block.
 *
 * ## Isolation, and what this file removes
 *
 * It owns the four `commission_*` tables outright: no migration seeds them and no other suite writes to
 * them, so `truncate` as the OWNER is the correct cleanup and is the ONLY one available — every row refuses
 * DELETE for every role (ZY071, ZY072). It truncates the invoice and package families as their owner for the
 * reason `invoice.itest.ts` records (`invoice` refuses DELETE, so truncate is the only legal removal), and it
 * removes its own booking, which cascades to its appointments. It does NOT try to remove `journal_entry`
 * rows: that table is append-only (ADR 0008) and a suite that deleted from it would be breaking a guarantee
 * to tidy up after itself.
 */

const ACTOR: Actor = {
  kind: 'staff',
  id: '77777777-7777-7777-7777-777777777777',
  label: 'Payroll (commission pair)',
}

const RUN = Date.now().toString(36)
const MARKER = `phr11-commission-${RUN}`

/**
 * A per-document counter for entry ids and idempotency keys.
 *
 * NOT a slice of the invoice's uuid, which is what this was first: `uuid_generate_v7()` begins with a 48-bit
 * millisecond timestamp, so the first eight hex characters of every uuid minted within about a minute are
 * IDENTICAL — and every document in this fixture then asked for one `journal_entry` id. The failure was a
 * duplicate primary key in `postJournalEntry`, three layers from the line that chose the name.
 */
let nonce = 0

/** The month that gets CLOSED, and the one that stays open. A commission period is a month. */
const CLOSED = { startsOn: '2081-03-01', endsOn: '2081-03-31' } as const
const OPEN = { startsOn: '2081-04-01', endsOn: '2081-04-30' } as const

const SOLD_ON = '2081-02-14'
const PAID_DAY = '2081-03-14'
const REDEEMED_ON = '2081-03-20'
/** The day a sale is BACKDATED into, after the month has been filed. */
const BACKDATED_DAY = '2081-03-25'
const OPEN_DAY = '2081-04-10'
const DAYS = [SOLD_ON, PAID_DAY, REDEEMED_ON, BACKDATED_DAY, OPEN_DAY] as const

/**
 * The fixture rule set. Two versions, and version 2 is effective-dated BEFORE the closed month on purpose.
 *
 * That is what makes the reproducibility claim mean something: with version 2 in force over March, a fresh
 * resolve picks it, so a recompute of the version-1 run that came back to the resolver would answer 15%
 * where the payslip said 10%. Every figure is this file's own.
 */
const V1 = { effectiveFrom: '2081-01-01', rateBp: 1_000 } as const
const V2 = { effectiveFrom: '2081-02-01', rateBp: 1_500 } as const

/** The catalogue price this file bills, in fils. Its own figure, not a price list's. */
const TREATMENT_GROSS = 26_250
/** A three-session course. Partial drawdown is what the acceptance line asks for. */
const COURSE_PRICE = 60_000
const COURSE_SESSIONS = 3

let sql: Sql
let customerId: string
let variantId: string
let roomId: string
let employeeA: string
let employeeB: string
let bookingId: string
let v1: { ruleVersionId: string; version: number }
let lockedAt: string

/** Appointment ids, by the role each plays in the assertions below. */
const appointments: Record<string, string> = {}

/**
 * The three families this file writes, each as its own legal statement.
 *
 * One hand-written list stood here naming all sixteen tables, and it broke twice in one merge: P-HR-11
 * pointed `commission_line` at `invoice` and `package_redemption`, and P-HR-12 pointed `payslip` at
 * `commission_run`. The second one sent all twenty-two cases to SKIPPED, because a `beforeAll` that throws
 * does not report as a failure against the thing it was setting up. The lists live in `./invoice-family.ts`
 * now, where `invoice-family.itest.ts` derives each closure from `pg_constraint` and fails on the list rather
 * than in a `beforeAll`.
 */
const truncateAll = async (connection: Sql): Promise<void> => {
  // Commission first: it is the only one of the three that references the other two, so emptying it makes
  // the two statements that follow legal whatever order the schema grows in.
  await truncateCommissionFamily(connection)
  await truncateInvoiceFamily(connection)
  await truncatePackageFamily(connection)
}

const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: FIXTURE_TRN,
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

const cash = (fils: number): TenderLine => ({ kind: 'cash', amount: money(filsFrom(fils)) })

/** One appointment, at the fixture price, with the status the case needs. */
async function appointment(args: {
  readonly key: string
  readonly tradingDate: string
  readonly status: string
  readonly employeeId: string
  readonly hour: number
  readonly createdAtIso?: string
}): Promise<string> {
  const split = splitGross(money(filsFrom(TREATMENT_GROSS)))
  const start = `${args.tradingDate} ${args.hour}:00:00+04`
  const end = `${args.tradingDate} ${args.hour}:50:00+04`
  const [row] = await sql<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
       therapist_buffer_minutes, created_at)
    values (${bookingId}, ${args.tradingDate}::date, ${variantId}, 'solo'::service_shape,
            ${args.employeeId}, ${roomId}, ${`[${start},${end})`}::tstzrange,
            ${args.status}::appointment_status, ${TREATMENT_GROSS}, ${split.net.fils},
            ${split.vat.fils}, ${split.rateBp}, 20, 10,
            ${args.createdAtIso ?? new Date().toISOString()}::timestamptz)
    returning id
  `
  const id = row?.id
  if (id === undefined) throw new Error(`inserting appointment ${args.key} returned no row`)
  appointments[args.key] = id
  return id
}

/**
 * Issues a document for one appointment and posts it, optionally taking less than the whole gross.
 *
 * `issueInvoice` allocates the number inside the transaction, `postJournalEntry` records the supply, and the
 * `checkout_finalisation` row is what `period_close_blocker()` reads as "this document is in the ledger" —
 * so a closed-month document has to have one or the close is refused by ZE002. The row is inserted directly
 * rather than through `finaliseCheckout`, because that function requires the tenders to match the posting
 * exactly and this file needs one document deliberately UNDERPAID.
 */
async function bill(args: {
  readonly appointmentId: string
  readonly tradingDate: string
  readonly tenderFils: number
  readonly createdAtIso?: string
}): Promise<{ invoiceId: string; grossFils: number; netFils: number; vatFils: number }> {
  const split = splitGross(money(filsFrom(TREATMENT_GROSS)))
  const createdAt = args.createdAtIso ?? new Date().toISOString()
  const issued = await withUnitOfWork(sql, ACTOR, (uow) =>
    issueInvoice(uow, {
      documentKind: 'tax_invoice',
      seriesCode: 'TAX-INV',
      issuer: ISSUER,
      customer: { nameSnapshot: 'Customer 0042' },
      issueDate: args.tradingDate,
      issueTradingDate: args.tradingDate,
      taxPointDate: args.tradingDate,
      lines: [
        {
          descriptionEn: 'Treatment (commission pair fixture)',
          quantity: 1,
          unitGrossFils: TREATMENT_GROSS,
          vatRateBp: split.rateBp,
          netFils: split.net.fils,
          vatFils: split.vat.fils,
        },
      ],
      netTotalFils: split.net.fils,
      vatTotalFils: split.vat.fils,
      grossTotalFils: TREATMENT_GROSS,
    }),
  )

  nonce += 1
  const entry = entryId(`je-phr11-${RUN}-${nonce}`)
  await withUnitOfWork(sql, ACTOR, (uow) =>
    postJournalEntry(uow, {
      entryId: entry,
      entryDate: args.tradingDate,
      narrative: 'Treatment sold (commission pair fixture)',
      source: 'sale',
      lines: [
        { accountCode: ACCOUNTS.cashInDrawer, debitFils: TREATMENT_GROSS, creditFils: 0 },
        { accountCode: ACCOUNTS.treatmentRevenue, debitFils: 0, creditFils: split.net.fils },
        { accountCode: ACCOUNTS.outputVatPayable, debitFils: 0, creditFils: split.vat.fils },
      ],
    }),
  )

  await sql`
    insert into invoice_appointment (invoice_id, appointment_id, line_no, created_at)
    values (${issued.id}::uuid, ${args.appointmentId}::uuid, 1, ${createdAt}::timestamptz)
  `
  await sql`
    insert into checkout_finalisation (
      idempotency_key, request_fingerprint, basket_id, invoice_id, journal_entry_id, customer_id,
      trading_date, tender_total_fils
    ) values (
      ${`phr11-${RUN}-${nonce}`}, ${`fp-${RUN}-${nonce}`}, ${`basket-${RUN}-${nonce}`},
      ${issued.id}::uuid, ${entry}, ${customerId}::uuid, ${args.tradingDate}::date,
      ${args.tenderFils}
    )
  `
  if (args.tenderFils > 0) {
    await sql`
      insert into payment (
        invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, trading_date, created_at
      ) values (
        ${issued.id}::uuid, 1, 'cash', ${ACCOUNTS.cashInDrawer}, ${args.tenderFils},
        ${args.tradingDate}::date, ${createdAt}::timestamptz
      )
    `
  }
  return {
    invoiceId: issued.id,
    grossFils: TREATMENT_GROSS,
    netFils: split.net.fils,
    vatFils: split.vat.fils,
  }
}

/** The balance as core's `PackageBalanceState`, which the redemption mapping takes. */
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

/** The SQLSTATE of a rejected promise, or undefined. Never "an error was raised". */
async function stateOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    const direct = (error as { code?: unknown }).code
    const translated = (error as { details?: { sqlState?: unknown } }).details?.sqlState
    const code = typeof direct === 'string' ? direct : translated
    return typeof code === 'string' ? code : undefined
  }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })

  for (const day of DAYS) {
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
  // A lock over 2081 left behind by an earlier run of THIS file would refuse every posting below with
  // ZL002 and every case would report that instead — gate 103's and 105's reason for the same delete.
  await sql`delete from period_lock where starts_on >= '2081-01-01' and ends_on <= '2081-12-31'`
  await truncateAll(sql)

  const [buyer] = await sql<{ id: string }[]>`select id from customer order by id limit 1`
  if (buyer === undefined) throw new Error('run `pnpm seed`: a customer is needed')
  customerId = buyer.id

  const [variant] = await sql<{ id: string }[]>`
    select v.id from service_variant v join service s on s.id = v.service_id
     where s.archived_at is null order by v.id limit 1
  `
  if (variant === undefined) throw new Error('run `pnpm seed`: a priced variant is needed')
  variantId = variant.id

  const [room] = await sql<{ id: string }[]>`select id from rooms order by id limit 1`
  if (room === undefined) throw new Error('run `pnpm seed`: a room is needed')
  roomId = room.id

  // Two SEEDED employees, not fixture ones: `commission_line.employee_id` is a foreign key into `employee`,
  // and the nineteen seeded therapists are what a commission is really about. No count of that table is
  // asserted anywhere here — other suites create their own employees (brief rule 12).
  const staff = await sql<
    { id: string }[]
  >`select id from employee order by staff_reference limit 2`
  const [first, second] = staff
  if (first === undefined || second === undefined) {
    throw new Error('run `pnpm seed`: the seed creates nineteen therapists')
  }
  employeeA = first.id
  employeeB = second.id

  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes) values (${customerId}, 'front_desk', ${MARKER})
    returning id
  `
  if (booking === undefined) throw new Error('inserting the fixture booking returned no row')
  bookingId = booking.id

  // --- the CLOSED month -------------------------------------------------------------------------
  const paid = await appointment({
    key: 'closed-paid',
    tradingDate: PAID_DAY,
    status: 'completed',
    employeeId: employeeA,
    hour: 12,
  })
  await bill({ appointmentId: paid, tradingDate: PAID_DAY, tenderFils: TREATMENT_GROSS })

  // The package: sold in FEBRUARY so its own document is outside the month being closed, redeemed in
  // March. One redemption of three sessions, which is the partial drawdown the acceptance line asks for.
  const templateKey = `phr11_course_${RUN}`
  const saved = await withUnitOfWork(sql, ACTOR, (uow) =>
    savePackageTemplateVersion(uow, {
      templateKey,
      internalName: 'Commission pair course',
      publicDisplayName: 'Commission pair course',
      priceFils: COURSE_PRICE,
      lines: [{ serviceVariantId: variantId, sessionCount: COURSE_SESSIONS }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }),
  )
  const version = await currentPackageTemplateVersion(sql, templateKey)
  if (version === null) throw new Error('the package version just saved cannot be read back')
  const saleMapping = packageSaleMapping({
    entryId: entryId(`je-phr11-sale-${RUN}`),
    tradingDate: localDate(SOLD_ON),
    customerId,
    templateVersionId: saved.versionId,
    priceGross: money(filsFrom(COURSE_PRICE)),
    lines: version.lines.map((line) => ({
      lineNo: line.lineNo,
      serviceVariantId: line.serviceVariantId,
      sessionCount: line.sessionCount,
      listGrossFils: line.listGrossFils,
    })),
    tenders: [cash(COURSE_PRICE)],
    validityMonths: version.validityMonths,
    transferable: version.transferable,
    unredeemedBalancePolicy: version.unredeemedBalancePolicy,
    packageLabel: version.internalName,
  })
  const sold = await withUnitOfWork(sql, ACTOR, (uow) => sellPackage(uow, saleMapping.input))
  const balanceId = sold.balanceIds[0]
  if (balanceId === undefined) throw new Error('the package sale opened no balance')

  const redeemed = await appointment({
    key: 'closed-redeemed',
    tradingDate: REDEEMED_ON,
    status: 'completed',
    employeeId: employeeB,
    hour: 13,
  })
  const redemption = assertPackageRedemptionMappingReconciles(
    packageRedemptionMapping({
      entryId: entryId(`je-phr11-red-${RUN}`),
      tradingDate: localDate(REDEEMED_ON),
      balance: await balanceState(balanceId),
      appointmentId: redeemed,
      units: 1,
      packageLabel: version.internalName,
    }),
  )
  await withUnitOfWork(sql, ACTOR, (uow) => redeemPackage(uow, redemption.input))

  // --- the OPEN month, which is where the gating cases live -------------------------------------
  await appointment({
    key: 'open-no-show',
    tradingDate: OPEN_DAY,
    status: 'no_show',
    employeeId: employeeA,
    hour: 14,
  })
  await appointment({
    key: 'open-cancelled',
    tradingDate: OPEN_DAY,
    status: 'cancelled_by_customer',
    employeeId: employeeA,
    hour: 15,
  })
  const unpaid = await appointment({
    key: 'open-unpaid',
    tradingDate: OPEN_DAY,
    status: 'completed',
    employeeId: employeeA,
    hour: 16,
  })
  // One fil short of the gross. Not zero, deliberately: a document with no payment at all and a document
  // that is nearly paid must both earn nothing, and the second is the one an off-by-one would let through.
  await bill({ appointmentId: unpaid, tradingDate: OPEN_DAY, tenderFils: TREATMENT_GROSS - 1 })

  const openPaid = await appointment({
    key: 'open-paid',
    tradingDate: OPEN_DAY,
    status: 'completed',
    employeeId: employeeA,
    hour: 17,
  })
  await bill({ appointmentId: openPaid, tradingDate: OPEN_DAY, tenderFils: TREATMENT_GROSS })

  // --- version 1, and the close ------------------------------------------------------------------
  v1 = await withUnitOfWork(sql, ACTOR, (uow) =>
    publishCommissionRuleVersion(uow, {
      effectiveFrom: V1.effectiveFrom,
      basis: 'net_of_vat',
      roundingMode: 'floor',
      bands: [{ bandNo: 1, fromFils: 0, rateBp: V1.rateBp }],
      publishedByActorKind: 'staff',
      publishedByActorId: ACTOR.id ?? null,
      openQuestionId: 'Y9-commission',
      provisionalNote:
        'A FIXTURE rule set. Nothing about this business is configured; see Y9-commission.',
      sourceNote:
        'packages/fixtures/src/hr-commission.itest.ts — a fixture rule set, confirmed by nobody',
    }),
  )

  const lock = await withUnitOfWork(sql, ACTOR, (uow) =>
    lockAccountingPeriod(uow, {
      periodId: `phr11-${RUN}`,
      startsOn: CLOSED.startsOn,
      endsOn: CLOSED.endsOn,
      reason: 'Commission pair fixture: the month is filed',
      lockedByActorKind: 'staff',
      lockedByActorId: ACTOR.id ?? null,
    }),
  )
  const [lockRow] = await sql<{ lockedAt: string }[]>`
    select locked_at::text as "lockedAt" from period_lock where period_id = ${`phr11-${RUN}`}
  `
  if (lockRow === undefined) throw new Error('the lock just taken cannot be read back')
  lockedAt = lockRow.lockedAt
  expect(lock.periodId).toBe(`phr11-${RUN}`)

  // --- and the sale BACKDATED into the filed month, after the close ------------------------------
  // `invoice` carries no period guard — only the journal does — so this is a real thing that can happen,
  // and it is exactly why a commission run must read the books as filed rather than as they are now. No
  // journal entry and no checkout_finalisation: posting into a locked period is refused (ZL002), which is
  // the database being right, and the commission read does not depend on the posting.
  const backdated = await appointment({
    key: 'closed-backdated',
    tradingDate: BACKDATED_DAY,
    status: 'completed',
    employeeId: employeeA,
    hour: 18,
  })
  const lateSplit = splitGross(money(filsFrom(TREATMENT_GROSS)))
  /*
    One transaction, and it has to be one.

    `invoice_totals_match_lines` is a DEFERRED constraint trigger, so it fires at the end of the transaction
    the insert is in — and postgres.js autocommits a bare statement, which makes that transaction the INSERT
    alone. The document then has no lines yet and the refusal is `InvoiceWithoutLines`, three statements
    before the line that would have satisfied it. `issueInvoice` has the same shape for the same reason.
  */
  const lateInvoiceId = await sql.begin(async (tx) => {
    const [made] = await tx<{ id: string }[]>`
      insert into invoice (
        document_kind, series_code, period_key, number, display_number, issuer_legal_name,
        issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate,
        customer_id, customer_name_snapshot, issue_date, issue_trading_date, tax_point_date,
        net_total, vat_total, gross_total
      ) values (
        'tax_invoice', 'TAX-INV', '2081', 990001, ${`TI-2081-990001-${RUN}`},
        ${ISSUER.legalName}, ${ISSUER.tradingName}, ${ISSUER.trn}, ${ISSUER.addressSnapshot},
        ${ISSUER.emirate}, ${customerId}::uuid, 'Customer 0042',
        ${BACKDATED_DAY}::date, ${BACKDATED_DAY}::date, ${BACKDATED_DAY}::date,
        ${lateSplit.net.fils}, ${lateSplit.vat.fils}, ${TREATMENT_GROSS}
      )
      returning id
    `
    if (made === undefined) throw new Error('inserting the backdated invoice returned no row')
    await tx`
      insert into invoice_line (
        invoice_id, line_no, description_en, quantity, unit_gross_fils, vat_rate_bp, line_net_fils,
        line_vat_fils
      ) values (
        ${made.id}::uuid, 1, 'Treatment entered late', 1, ${TREATMENT_GROSS},
        ${lateSplit.rateBp}, ${lateSplit.net.fils}, ${lateSplit.vat.fils}
      )
    `
    await tx`
      insert into invoice_appointment (invoice_id, appointment_id, line_no)
      values (${made.id}::uuid, ${backdated}::uuid, 1)
    `
    await tx`
      insert into payment (
        invoice_id, tender_no, tender_kind, posting_account_code, amount_fils, trading_date
      ) values (
        ${made.id}::uuid, 1, 'cash', ${ACCOUNTS.cashInDrawer}, ${TREATMENT_GROSS},
        ${BACKDATED_DAY}::date
      )
    `
    return made.id
  })
  expect(typeof lateInvoiceId).toBe('string')
}, 120_000)

afterAll(async () => {
  if (sql !== undefined) await truncateAll(sql)
  await sql`delete from booking where notes = ${MARKER}`
  await sql`delete from period_lock where starts_on >= '2081-01-01' and ends_on <= '2081-12-31'`
  await sql`delete from business_day where trading_date = any(${[...DAYS]}::date[])`
  await sql?.end({ timeout: 5 })
})

// -------------------------------------------------------------------------------------------------
// 1. One formula, two implementations
// -------------------------------------------------------------------------------------------------

describe('the commission formula in SQL and in TypeScript', () => {
  it('agree at every point of a bounded census, in both rounding modes', async () => {
    /*
      A CENSUS and not a sample. The claim is "these two implementations of one expression agree", and a
      random sample of it is a claim about the seed. 0083's release formula is held to its SQL twin the
      same way and for the same reason.

      The bases are chosen to include the cases where the two rounding modes differ and the exact ties,
      which is where a direction implemented as `> .5` instead of `>= .5` shows.
    */
    const bases = [
      0, 1, 7, 99, 100, 999, 1_000, 9_899, 9_900, 9_949, 9_950, 9_951, 10_000, 26_250, 19_048,
      123_456, 1_000_000, 99_999_999,
    ]
    const rates = [0, 1, 25, 100, 250, 500, 1_000, 1_250, 1_500, 2_500, 5_000, 10_000]
    const modes = ['floor', 'half_up'] as const
    const wanted: { basisFils: number; rateBp: number; mode: string }[] = []
    for (const basisFils of bases) {
      for (const rateBp of rates) {
        for (const mode of modes) wanted.push({ basisFils, rateBp, mode })
      }
    }
    // Counted, so a box that silently shrank to nothing fails instead of passing vacuously. 18 x 12 x 2.
    expect(wanted.length).toBe(432)

    const rows = await sql<{ basisFils: string; rateBp: number; mode: string; answer: string }[]>`
      select spec.basis_fils::text as "basisFils", spec.rate_bp as "rateBp", spec.mode,
             commission_fils_for(spec.basis_fils, spec.rate_bp, spec.mode)::text as answer
        from unnest(
               ${wanted.map((row) => row.basisFils)}::bigint[],
               ${wanted.map((row) => row.rateBp)}::int[],
               ${wanted.map((row) => row.mode)}::text[]
             ) as spec(basis_fils, rate_bp, mode)
    `
    expect(rows.length).toBe(432)

    let disagreements = 0
    let differingModes = 0
    for (const row of rows) {
      const basisFils = Number(row.basisFils)
      const mode = row.mode === 'half_up' ? 'half_up' : 'floor'
      if (commissionFilsFor(basisFils, row.rateBp, mode) !== Number(row.answer)) disagreements += 1
    }
    for (const basisFils of bases) {
      for (const rateBp of rates) {
        if (
          commissionFilsFor(basisFils, rateBp, 'floor') !==
          commissionFilsFor(basisFils, rateBp, 'half_up')
        ) {
          differingModes += 1
        }
      }
    }
    expect(disagreements).toBe(0)
    // The census CAN tell the two directions apart, so the zero above is evidence rather than the absence
    // of it. MEASURED on this exact box.
    expect(differingModes).toBe(80)
  }, 30_000)

  it('refuses an unknown rounding mode in SQL rather than falling through to floor', async () => {
    expect(await stateOf(sql`select commission_fils_for(1000, 1000, 'bankers')`)).toBe(
      COMMISSION_SQLSTATE.lineDoesNotFollowItsRule,
    )
    // The control: both modes the schema admits answer, so the refusal is about the unknown value.
    const [row] = await sql<{ floored: string; up: string }[]>`
      select commission_fils_for(9950, 100, 'floor')::text   as floored,
             commission_fils_for(9950, 100, 'half_up')::text as up
    `
    expect(row?.floored).toBe('99')
    expect(row?.up).toBe('100')
  })
})

// -------------------------------------------------------------------------------------------------
// 2. The published version is immutable
// -------------------------------------------------------------------------------------------------

describe('a published rule version cannot be edited', () => {
  it('refuses UPDATE and DELETE on the version, and on its bands, by name', async () => {
    // BOTH statements, on BOTH tables. A pair of triggers is where the defect hides: you write one, copy
    // it for the other event, and forget to change the word (`check-schema-conventions.mjs` says so).
    expect(
      await stateOf(
        sql`update commission_rule set basis = 'gross_inclusive' where id = ${v1.ruleVersionId}::uuid`,
      ),
    ).toBe(COMMISSION_SQLSTATE.ruleImmutable)
    expect(
      await stateOf(sql`delete from commission_rule where id = ${v1.ruleVersionId}::uuid`),
    ).toBe(COMMISSION_SQLSTATE.ruleImmutable)
    expect(
      await stateOf(
        sql`update commission_rule_band set rate_bp = 9999 where rule_version_id = ${v1.ruleVersionId}::uuid`,
      ),
    ).toBe(COMMISSION_SQLSTATE.ruleImmutable)
    expect(
      await stateOf(
        sql`delete from commission_rule_band where rule_version_id = ${v1.ruleVersionId}::uuid`,
      ),
    ).toBe(COMMISSION_SQLSTATE.ruleImmutable)
    // The control: the version is still there and still says what it said, so the four refusals above are
    // about the statements rather than about a row that was never written.
    const versions = await readCommissionRuleVersions(sql)
    const stored = versions.find((row) => row.ruleVersionId === v1.ruleVersionId)
    expect(stored?.basis).toBe('net_of_vat')
    expect(stored?.bands.map((band) => band.rateBp)).toEqual([V1.rateBp])
  })

  it('refuses a version whose bands do not start at zero', async () => {
    const state = await stateOf(
      withUnitOfWork(sql, ACTOR, (uow) =>
        publishCommissionRuleVersion(uow, {
          effectiveFrom: '2081-11-01',
          basis: 'net_of_vat',
          roundingMode: 'floor',
          bands: [{ bandNo: 1, fromFils: 5_000, rateBp: 500 }],
          publishedByActorKind: 'staff',
          openQuestionId: 'Y9-commission',
          sourceNote: 'a deliberately gapped fixture version',
        }),
      ),
    )
    expect(state).toBe(COMMISSION_SQLSTATE.bandsLeaveAGap)
    // The control, one field different: the same publish with band 1 from zero succeeds, so the refusal is
    // about the gap and not about the publish path.
    const published = await withUnitOfWork(sql, ACTOR, (uow) =>
      publishCommissionRuleVersion(uow, {
        effectiveFrom: '2081-11-01',
        basis: 'net_of_vat',
        roundingMode: 'floor',
        bands: [
          { bandNo: 1, fromFils: 0, rateBp: 500 },
          { bandNo: 2, fromFils: 5_000, rateBp: 900 },
        ],
        publishedByActorKind: 'staff',
        openQuestionId: 'Y9-commission',
        sourceNote: 'a fixture version whose bands cover from zero',
      }),
    )
    expect(published.version).toBeGreaterThan(v1.version)
  })
})

// -------------------------------------------------------------------------------------------------
// 3. The run over the filed month, and the reproduction
// -------------------------------------------------------------------------------------------------

describe('a run over a closed period reads the figures as filed', () => {
  it('names the lock and reads at the instant the lock was taken', async () => {
    const result = await executeCommissionRun(sql, {
      periodStartsOn: CLOSED.startsOn,
      periodEndsOn: CLOSED.endsOn,
      moduleEnabled: true,
      // Deliberately NOW, to prove the run does not use it for a filed period.
      nowIso: new Date().toISOString(),
      actor: ACTOR,
    })
    expect(result.inertReason).toBeNull()
    expect(result.lockedPeriodId).toBe(`phr11-${RUN}`)
    expect(result.sourceAsOf).toBe(lockedAt)
    expect(result.ruleVersion).toBe(v1.version)
    // Two appointments earned: the paid treatment and the redemption. The BACKDATED one did not, although
    // it is completed, paid and dated inside the month — because it was created after the close.
    expect(result.lineCount).toBe(2)
  }, 60_000)

  it('sees the backdated sale at NOW and not at the lock, which is the same query one argument apart', async () => {
    const atTheLock = await readCommissionEarnings(sql, {
      periodStartsOn: CLOSED.startsOn,
      periodEndsOn: CLOSED.endsOn,
      sourceAsOf: lockedAt,
    })
    const atNow = await readCommissionEarnings(sql, {
      periodStartsOn: CLOSED.startsOn,
      periodEndsOn: CLOSED.endsOn,
      sourceAsOf: new Date().toISOString(),
    })
    const backdated = appointments['closed-backdated'] as string
    expect(atTheLock.map((row) => row.appointmentId)).not.toContain(backdated)
    // The control, and it is the whole point: the row IS there and IS commissionable, so its absence above
    // is the as-of filter doing work rather than a fixture that failed to create it.
    expect(atNow.map((row) => row.appointmentId)).toContain(backdated)
    expect(atNow.length).toBe(atTheLock.length + 1)
  })

  it('refuses a run over the filed month that reads at any other instant', async () => {
    const [run] = await sql<{ id: string }[]>`
      select id from commission_run where period_starts_on = ${CLOSED.startsOn}::date limit 1
    `
    expect(run).toBeDefined()
    // Straight at the table, as the schema's own claim rather than the orchestrator's care: a caller that
    // computed the earnings itself and inserted a run would meet the same refusal.
    expect(
      await stateOf(sql`
        insert into commission_run (
          rule_version_id, period_starts_on, period_ends_on, source_as_of, locked_period_id,
          module_enabled, total_fils, line_count, computed_by_actor_kind
        ) values (
          ${v1.ruleVersionId}::uuid, ${CLOSED.startsOn}::date, ${CLOSED.endsOn}::date,
          now(), ${`phr11-${RUN}`}, true, 0, 0, 'system'
        )
      `),
    ).toBe(COMMISSION_SQLSTATE.ignoresTheLock)
    // And a run over the filed month that names NO lock is refused too, which is the other direction.
    expect(
      await stateOf(sql`
        insert into commission_run (
          rule_version_id, period_starts_on, period_ends_on, source_as_of, locked_period_id,
          module_enabled, total_fils, line_count, computed_by_actor_kind
        ) values (
          ${v1.ruleVersionId}::uuid, ${CLOSED.startsOn}::date, ${CLOSED.endsOn}::date,
          ${lockedAt}::text::timestamptz, null, true, 0, 0, 'system'
        )
      `),
    ).toBe(COMMISSION_SQLSTATE.ignoresTheLock)
  })

  it('refuses a run judged by a version that had not commenced when the period began', async () => {
    const future = await withUnitOfWork(sql, ACTOR, (uow) =>
      publishCommissionRuleVersion(uow, {
        effectiveFrom: '2081-12-01',
        basis: 'net_of_vat',
        roundingMode: 'floor',
        bands: [{ bandNo: 1, fromFils: 0, rateBp: 300 }],
        publishedByActorKind: 'staff',
        openQuestionId: 'Y9-commission',
        sourceNote: 'a fixture version commencing after the closed month',
      }),
    )
    expect(
      await stateOf(sql`
        insert into commission_run (
          rule_version_id, period_starts_on, period_ends_on, source_as_of, locked_period_id,
          module_enabled, total_fils, line_count, computed_by_actor_kind
        ) values (
          ${future.ruleVersionId}::uuid, ${CLOSED.startsOn}::date, ${CLOSED.endsOn}::date,
          ${lockedAt}::text::timestamptz, ${`phr11-${RUN}`}, true, 0, 0, 'system'
        )
      `),
    ).toBe(COMMISSION_SQLSTATE.versionNotYetInForce)
  })
})

describe('recomputing a filed month reproduces it, under a version that has since been superseded', () => {
  it('reproduces every line byte-identically and on the total', async () => {
    const [before] = await readCommissionRuns(sql, {
      periodStartsOn: CLOSED.startsOn,
      periodEndsOn: CLOSED.endsOn,
    })
    expect(before).toBeDefined()
    if (before === undefined) return
    const original = await readCommissionDerivation(sql, { runId: before.runId })
    expect(original.length).toBe(2)

    // Version 2, effective BEFORE the closed month, with a different rate. After this, a fresh resolve for
    // March answers version 2 — so a recompute that resolved by date would restate a month already paid.
    const v2 = await withUnitOfWork(sql, ACTOR, (uow) =>
      publishCommissionRuleVersion(uow, {
        effectiveFrom: V2.effectiveFrom,
        basis: 'net_of_vat',
        roundingMode: 'floor',
        bands: [{ bandNo: 1, fromFils: 0, rateBp: V2.rateBp }],
        publishedByActorKind: 'staff',
        openQuestionId: 'Y9-commission',
        provisionalNote: 'A FIXTURE rule set. See Y9-commission.',
        sourceNote:
          'packages/fixtures/src/hr-commission.itest.ts — the superseding fixture version',
      }),
    )
    expect(v2.version).toBeGreaterThan(v1.version)

    const again = await recomputeCommissionRun(sql, {
      run: {
        ruleVersionId: before.ruleVersionId,
        periodStartsOn: before.periodStartsOn,
        periodEndsOn: before.periodEndsOn,
        sourceAsOf: before.sourceAsOf,
        lockedPeriodId: before.lockedPeriodId,
      },
      actor: ACTOR,
    })
    expect(again.runId).not.toBe(before.runId)
    expect(again.totalFils).toBe(before.totalFils)
    expect(again.lineCount).toBe(before.lineCount)
    expect(again.ruleVersion).toBe(v1.version)

    const reproduced = await readCommissionDerivation(sql, { runId: String(again.runId) })
    // Line by line, in order, on every figure a payslip would carry. Compared as a SEQUENCE, because
    // byte-identical is a claim about an order too and both reads are ordered by (trading date, id).
    const shape = (rows: typeof original) =>
      rows.map((row) => ({
        appointmentId: row.appointmentId,
        employeeId: row.employeeId,
        tradingDate: row.tradingDate,
        source: row.source,
        basisFils: row.basisFils,
        bandNo: row.bandNo,
        rateBp: row.rateBp,
        commissionFils: row.commissionFils,
        ruleVersion: row.ruleVersion,
      }))
    expect(shape(reproduced)).toEqual(shape(original))
    expect(JSON.stringify(shape(reproduced))).toBe(JSON.stringify(shape(original)))
  }, 60_000)

  it('CONTROL: a fresh run over the same month under the new version differs', async () => {
    // Without this the reproduction above would be satisfied by a version-2 rate that happened to equal
    // version 1's — or by a recompute that resolved and got the same answer for the wrong reason.
    const fresh = await executeCommissionRun(sql, {
      periodStartsOn: CLOSED.startsOn,
      periodEndsOn: CLOSED.endsOn,
      moduleEnabled: true,
      nowIso: new Date().toISOString(),
      actor: ACTOR,
    })
    const runs = await readCommissionRuns(sql, {
      periodStartsOn: CLOSED.startsOn,
      periodEndsOn: CLOSED.endsOn,
    })
    const underV1 = runs.filter((run) => run.ruleVersionId === v1.ruleVersionId)
    expect(underV1.length).toBe(2)
    expect(fresh.ruleVersion).not.toBe(v1.version)
    // 15% against 10% over the same two appointments, so the figure really would have moved.
    expect(fresh.totalFils).toBeGreaterThan(underV1[0]?.totalFils ?? 0)
    // And the version-1 runs still say what they said, because nothing can edit them.
    expect(underV1.every((run) => run.totalFils === underV1[0]?.totalFils)).toBe(true)
  }, 60_000)
})

// -------------------------------------------------------------------------------------------------
// 4. The gating rule, one case each
// -------------------------------------------------------------------------------------------------

describe('commission derives only from a COMPLETED appointment whose document was PAID', () => {
  let lines: readonly { appointmentId: string; commissionFils: number; source: string }[] = []

  beforeAll(async () => {
    const result = await executeCommissionRun(sql, {
      periodStartsOn: OPEN.startsOn,
      periodEndsOn: OPEN.endsOn,
      moduleEnabled: true,
      nowIso: new Date().toISOString(),
      actor: ACTOR,
    })
    expect(result.lockedPeriodId).toBeNull()
    lines = await readCommissionDerivation(sql, { runId: String(result.runId) })
  }, 60_000)

  it('produces a line for the completed, paid visit — the control for the three below', () => {
    expect(lines.map((line) => line.appointmentId)).toContain(appointments['open-paid'])
    expect(lines.length).toBe(1)
  })

  it('produces no line for a no-show', () => {
    expect(lines.map((line) => line.appointmentId)).not.toContain(appointments['open-no-show'])
  })

  it('produces no line for a cancelled appointment', () => {
    expect(lines.map((line) => line.appointmentId)).not.toContain(appointments['open-cancelled'])
  })

  it('produces no line for a completed visit whose document is one fil short', () => {
    expect(lines.map((line) => line.appointmentId)).not.toContain(appointments['open-unpaid'])
  })
})

// -------------------------------------------------------------------------------------------------
// 5. A package redemption is commissioned on what it RECOGNISED
// -------------------------------------------------------------------------------------------------

describe('a package redemption at partial drawdown', () => {
  it('is commissioned on the released value and never on the sale value', async () => {
    /*
      The run under version ONE, named explicitly.

      NOT `readCommissionRuns(...)[0]`, which is the NEWEST run — and by the time this case runs the newest
      is the control's fresh run under version 2, at a different rate. The first version of this case took
      the newest and compared its figure against version 1's rate: 15% of the same basis, reported as a
      redemption priced on the wrong value. The lesson is the unit's own: a figure is only meaningful beside
      the version that produced it, and that includes a figure in a test.
    */
    const runs = await readCommissionRuns(sql, {
      periodStartsOn: CLOSED.startsOn,
      periodEndsOn: CLOSED.endsOn,
    })
    const run = runs.find((row) => row.ruleVersionId === v1.ruleVersionId)
    expect(run).toBeDefined()
    if (run === undefined) return
    const lines = await readCommissionDerivation(sql, { runId: run.runId })
    const redemption = lines.find((line) => line.source === 'package_redemption')
    expect(redemption).toBeDefined()
    expect(run.ruleVersion).toBe(v1.version)

    const [row] = await sql<{ releasedFils: string; vatFils: string; sessionsRedeemed: number }[]>`
      select pr.released_fils::text as "releasedFils", pr.vat_fils::text as "vatFils",
             b.sessions_redeemed as "sessionsRedeemed"
        from package_redemption pr join package_balance b on b.id = pr.package_balance_id
       where pr.appointment_id = ${appointments['closed-redeemed'] as string}::uuid
    `
    expect(row).toBeDefined()
    // PARTIAL drawdown, which is what the acceptance line asks for: one of three sessions.
    expect(row?.sessionsRedeemed).toBe(1)
    const released = Number(row?.releasedFils ?? 0)
    const vat = Number(row?.vatFils ?? 0)
    // The basis is the RECOGNISED value net of its VAT, which is a third of the course and not the course.
    expect(redemption?.basisFils).toBe(released - vat)
    expect(released).toBeLessThan(COURSE_PRICE)
    // Stated the other way round as well, because "less than" would also hold for a figure that was wrong
    // in some other way: the sale value must not appear at all.
    expect(redemption?.basisFils).not.toBe(COURSE_PRICE)
    expect(redemption?.commissionFils).toBe(commissionFilsFor(released - vat, V1.rateBp, 'floor'))
  })
})

// -------------------------------------------------------------------------------------------------
// 6. A run and its lines are evidence
// -------------------------------------------------------------------------------------------------

describe('a run cannot be edited, and a line cannot disagree with its rule', () => {
  it('refuses UPDATE and DELETE on the run and on its lines, by name', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from commission_run where period_starts_on = ${CLOSED.startsOn}::date limit 1
    `
    expect(row).toBeDefined()
    if (row === undefined) return
    const run = row.id
    expect(
      await stateOf(sql`update commission_run set total_fils = 0 where id = ${run}::uuid`),
    ).toBe(COMMISSION_SQLSTATE.runImmutable)
    expect(await stateOf(sql`delete from commission_run where id = ${run}::uuid`)).toBe(
      COMMISSION_SQLSTATE.runImmutable,
    )
    expect(
      await stateOf(
        sql`update commission_line set commission_fils = 1 where run_id = ${run}::uuid`,
      ),
    ).toBe(COMMISSION_SQLSTATE.runImmutable)
    expect(await stateOf(sql`delete from commission_line where run_id = ${run}::uuid`)).toBe(
      COMMISSION_SQLSTATE.runImmutable,
    )
  })

  it('refuses a line whose figure, band or rate does not follow from the version it names', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from commission_run
       where period_starts_on = ${CLOSED.startsOn}::date and rule_version_id = ${v1.ruleVersionId}::uuid
       limit 1
    `
    expect(row).toBeDefined()
    if (row === undefined) return
    const run = row.id

    /**
     * One hand-written line against the run, in its own transaction, rolled back either way.
     *
     * Hand-written and not through the orchestrator, deliberately: the claim is that the DATABASE holds a
     * line to its rule, so the statement has to be one a caller who computed nothing could issue. The run's
     * header is left disagreeing with its lines inside the transaction, which ZY074 would catch at COMMIT —
     * so every arm rolls back, and the arm that is SUPPOSED to be accepted is proved by the absence of
     * ZY077 rather than by a row surviving.
     */
    const lineWith = (over: {
      basisFils?: number
      bandNo?: number
      rateBp?: number
      commissionFils?: number
    }): Promise<unknown> =>
      sql.begin(async (tx) => {
        await tx`
          insert into commission_line (
            run_id, rule_version_id, employee_id, appointment_id, source, invoice_id, trading_date,
            basis_fils, band_no, rate_bp, commission_fils
          ) values (
            ${run}::uuid, ${v1.ruleVersionId}::uuid, ${employeeA}::uuid,
            ${crypto.randomUUID()}::uuid, 'invoice_line',
            (select id from invoice order by created_at limit 1), ${PAID_DAY}::date,
            ${over.basisFils ?? 25_000}, ${over.bandNo ?? 1}, ${over.rateBp ?? V1.rateBp},
            ${over.commissionFils ?? 2_500}
          )
        `
        // Never committed: the header would then disagree with its lines. The refusal under test is
        // IMMEDIATE (a BEFORE INSERT trigger), so it has already fired or already not by this point.
        throw new Error('rollback')
      })

    const stateOfLine = async (
      over: Parameters<typeof lineWith>[0],
    ): Promise<string | undefined> => {
      const state = await stateOf(lineWith(over))
      // The deliberate rollback surfaces as an Error with no SQLSTATE, which reads as "accepted".
      return state
    }

    // A figure that is not what the rate and the rounding produce. 10% of 25,000 is 2,500, not 2,600.
    expect(await stateOfLine({ commissionFils: 2_600 })).toBe(
      COMMISSION_SQLSTATE.lineDoesNotFollowItsRule,
    )
    // A band the basis does not fall in. Version 1 has one band, so band 2 cannot apply to anything.
    expect(await stateOfLine({ bandNo: 2 })).toBe(COMMISSION_SQLSTATE.lineDoesNotFollowItsRule)
    // A rate that is not the band's, with a figure that follows from IT — so only the snapshot check can
    // catch it. This is the shape in which a rate nobody published reaches a payslip.
    expect(await stateOfLine({ rateBp: 2_000, commissionFils: 5_000 })).toBe(
      COMMISSION_SQLSTATE.lineDoesNotFollowItsRule,
    )
    // The CONTROL: the line that DOES follow version 1 is accepted, so the three refusals above are about
    // the figures rather than about an insert that could never succeed.
    expect(await stateOfLine({})).toBeUndefined()
  })

  it('refuses a run whose header does not equal its lines', async () => {
    // A run inserted with a total that is not the sum of the lines inserted with it, in ONE transaction:
    // the trigger is deferred, so the refusal arrives at COMMIT. That is the only shape in which the check
    // can be about the SET rather than about whichever row arrived first.
    const state = await stateOf(
      sql.begin(async (tx) => {
        const [made] = await tx<{ id: string }[]>`
          insert into commission_run (
            rule_version_id, period_starts_on, period_ends_on, source_as_of, locked_period_id,
            module_enabled, total_fils, line_count, computed_by_actor_kind
          ) values (
            ${v1.ruleVersionId}::uuid, ${OPEN.startsOn}::date, ${OPEN.endsOn}::date,
            now(), null, true, 9_999, 1, 'system'
          )
          returning id
        `
        if (made === undefined) throw new Error('inserting the probe run returned no row')
        await tx`
          insert into commission_line (
            run_id, rule_version_id, employee_id, appointment_id, source, invoice_id, trading_date,
            basis_fils, band_no, rate_bp, commission_fils
          ) values (
            ${made.id}::uuid, ${v1.ruleVersionId}::uuid, ${employeeA}::uuid,
            ${crypto.randomUUID()}::uuid, 'invoice_line',
            (select id from invoice order by created_at limit 1), ${OPEN_DAY}::date,
            25000, 1, ${V1.rateBp}, 2500
          )
        `
      }),
    )
    expect(state).toBe(COMMISSION_SQLSTATE.headerDisagreesWithLines)
  })
})

// -------------------------------------------------------------------------------------------------
// 7. The derivation, and who may read it
// -------------------------------------------------------------------------------------------------

describe('the derivation view', () => {
  it('returns per-appointment rows summing exactly to the header total', async () => {
    const [run] = await readCommissionRuns(sql, {
      periodStartsOn: CLOSED.startsOn,
      periodEndsOn: CLOSED.endsOn,
    })
    expect(run).toBeDefined()
    if (run === undefined) return
    const rows = await readCommissionDerivation(sql, { runId: run.runId })
    // One row per appointment, and no appointment twice — which is what makes the sum below a sum over
    // appointments rather than over whatever the join produced.
    expect(new Set(rows.map((row) => row.appointmentId)).size).toBe(rows.length)
    expect(rows.length).toBe(run.lineCount)
    expect(rows.reduce((sum, row) => sum + row.commissionFils, 0)).toBe(run.totalFils)
    // The header is an INDEPENDENT figure held equal to the lines by ZY074, which is what makes this an
    // assertion about two things agreeing rather than about a sum agreeing with itself.
    expect(rows.every((row) => row.runTotalFils === run.totalFils)).toBe(true)
    // And it names the employee by handle, never by a name: nineteen employees have none (ADR 0020).
    expect(rows.every((row) => row.staffReference.trim() !== '')).toBe(true)
  })

  it('lets a therapist read their own derivation and refuses a colleague’s', async () => {
    const [run] = await readCommissionRuns(sql, {
      periodStartsOn: CLOSED.startsOn,
      periodEndsOn: CLOSED.endsOn,
    })
    expect(run).toBeDefined()
    if (run === undefined) return

    const own = await readCommissionDerivationFor(sql, {
      runId: run.runId,
      role: 'therapist',
      viewerEmployeeId: employeeA,
      subjectEmployeeId: employeeA,
    })
    // Their own rows, and only theirs: employeeB's redemption is in the same run.
    expect(own.every((row) => row.employeeId === employeeA)).toBe(true)
    expect(own.length).toBeGreaterThan(0)

    await expect(
      readCommissionDerivationFor(sql, {
        runId: run.runId,
        role: 'therapist',
        viewerEmployeeId: employeeA,
        subjectEmployeeId: employeeB,
      }),
    ).rejects.toThrow(/only their own/)

    // The control in the other direction: the accountant holds payroll:read and may read either.
    const wider = await readCommissionDerivationFor(sql, {
      runId: run.runId,
      role: 'accountant',
      viewerEmployeeId: employeeA,
      subjectEmployeeId: employeeB,
    })
    expect(wider.every((row) => row.employeeId === employeeB)).toBe(true)
    expect(wider.length).toBeGreaterThan(0)
  })
})

// -------------------------------------------------------------------------------------------------
// 8. The module is off by default, and the panel says so
// -------------------------------------------------------------------------------------------------

describe('the disabled module and the Unconfirmed Assumptions panel', () => {
  it('produces zero lines and records WHY, with no run row at all', async () => {
    const result = await executeCommissionRun(sql, {
      periodStartsOn: OPEN.startsOn,
      periodEndsOn: OPEN.endsOn,
      moduleEnabled: false,
      nowIso: new Date().toISOString(),
      actor: ACTOR,
    })
    expect(result.runId).toBeNull()
    expect(result.lineCount).toBe(0)
    expect(result.totalFils).toBe(0)
    // The reason is REPORTED and is distinguishable from "nothing was earned" — which is the acceptance
    // line's "no silent success".
    expect(result.inertReason).toBe('module_disabled')
  }, 60_000)

  it('lists the flag and every provisional rule version on the panel', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    // The flag itself, which is where Y9-commission's provisional answer ("none configured") lives.
    expect(
      rows.some((row) => row.source === 'app_setting' && row.reference === 'hr.commission_enabled'),
      'hr.commission_enabled is on the panel',
    ).toBe(true)
    // And the fixture versions, because a rule version drafted by a build and not confirmed by the
    // business must not be indistinguishable from an agreed rate — what it decides is somebody's pay.
    const versions = rows.filter((row) => row.source === 'commission_rule')
    expect(versions.length).toBeGreaterThan(0)
    expect(versions.every((row) => row.openQuestionId === 'Y9-commission')).toBe(true)
    // The control, in a transaction that is rolled back: a version whose flag is clear leaves the panel.
    await sql
      .begin(async (tx) => {
        await tx`alter table commission_rule disable trigger commission_rule_no_update`
        await tx`update commission_rule set is_provisional = false, open_question_id = null`
        const listed = await unconfirmedAssumptionRows(tx as unknown as Sql)
        expect(listed.filter((row) => row.source === 'commission_rule')).toEqual([])
        throw new Error('rollback')
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error
      })
  })
})
