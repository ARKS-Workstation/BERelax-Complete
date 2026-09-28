import { createHash } from 'node:crypto'
import {
  ASIA_DUBAI,
  type Basket,
  type BasketLineDraft,
  basketId,
  buildBasket,
  checkoutPosting,
  DOCUMENT_FORM_FIELDS,
  discountLine,
  entryId,
  filsFrom,
  formatMoney,
  grossMoneyFromFils,
  type HoursForDate,
  type Instant,
  type IssuerSnapshot,
  isPlaceholderText,
  issuerAddressSnapshot,
  localDate,
  localTime,
  type Money,
  money,
  requireInvoiceForm,
  STANDARD_SPA_CHART,
  serviceLineFromAppointment,
  type TenderLine,
  TrnNotConfigured,
  tipLine,
  toLocal,
  type VatRateBp,
} from '@berelax/core'
import {
  type Actor,
  checkoutError,
  finaliseCheckout,
  readBillableAppointments,
  readTillIssuer,
  type Sql,
  type TillBillableAppointmentRow,
  type TillIssuerRow,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'
import { type TillCheckoutMapping, tillCheckoutMapping } from '../../../src/till/mapping.ts'
import { renderTillHtml } from './render.ts'
import {
  PACKAGES_PATH,
  TILL_CASH_UP_PATH,
  TILL_FIELD_LABELS,
  TILL_FIELDS,
  TILL_PATH,
  TILL_TENDER_FIELDS,
  type TillAssumption,
  type TillBasketView,
  type TillForm,
  type TillMandatoryField,
  type TillPostingView,
  type TillRefusal,
  type TillRefusalCode,
  type TillScreen,
  type TillView,
  tillRefusalSentence,
} from './view.ts'

/**
 * Everything the till screen decides (M-TILL-13).
 *
 * Split out of `route.ts` for the reason the diary, the pipeline board and quick-book give: every figure this
 * screen shows is a function of `now` and of the rows, and `now` cannot be frozen behind a `next start`. So
 * the handler takes its clock and its connection as arguments and `apps/web/src/till.itest.ts` drives it
 * directly for the claims a browser cannot reach.
 *
 * ## The issuer reader is INJECTED, and that is not a door
 *
 * `TillDeps.readIssuer` defaults to {@link databaseIssuer}, which reads `legal_entity` and `premises`. The
 * route never passes anything else. A test passes a reader returning a configured issuer, which is the only
 * way to exercise the path past the TRN — and it is not a bypass, because whatever comes back still goes
 * through `requireIssuerSnapshot` inside `tillCheckoutMapping`: a caller can supply a *valid* fifteen-digit
 * TRN, exactly as the owner will when they enter the real one, and cannot supply a placeholder or a blank.
 * The same injection the clock gets, for the same reason.
 *
 * Today the real row holds `TRN-PENDING-Y1-TRN`, so the ISSUE step refuses with `TrnNotConfigured` before
 * anything is composed and writes nothing. That refusal is the deliverable; see `view.ts`.
 */

export interface TillRequest {
  readonly searchParams: URLSearchParams
  readonly body: URLSearchParams | null
  readonly chrome: AdminChrome
  readonly requestId: string | null
}

export interface TillDeps {
  readonly sql: Sql
  readonly now: () => number
  /** Defaults to {@link databaseIssuer}. See the module note: the value is still validated by core. */
  readonly readIssuer?: (sql: Sql) => Promise<IssuerSnapshot | null>
}

/** The provisional values this screen stands on. Every one appears on the page, named. */
const TILL_ASSUMPTIONS: readonly TillAssumption[] = Object.freeze([
  {
    what: 'The business Tax Registration Number has not been entered, so no invoice form can be issued and no treatment can be paid for.',
    openQuestionId: 'Y1-trn',
  },
  {
    what: 'The mandatory tax-invoice field list is a superset of the known requirements, not an agreed list.',
    openQuestionId: 'Y11-vat-invoice',
  },
  {
    what: 'The simplified-invoice threshold is AED 10,000 gross, pending the tax agent.',
    openQuestionId: 'Y11-vat-invoice',
  },
])

/**
 * Who the till records as the actor on every audit row.
 *
 * The SURFACE and not a person, because there is no admin session until W-SYS-01 — exactly what the pipeline
 * board records for its transitions. A name here would be an invented one (brief rule 10), and a blank actor
 * would make an audit row say a checkout happened with nobody at the desk.
 */
const TILL_ACTOR: Actor = { kind: 'staff', label: 'Till' }

const html = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })

const first = (params: URLSearchParams, name: string): string => params.get(name) ?? ''

const gross = (fils: number): Money => money(filsFrom(fils))

/** Digits only, and an empty field is zero. A malformed figure is refused rather than coerced. */
function amountFils(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return 0
  if (!/^[0-9]{1,12}$/.test(trimmed)) return null
  return Number(trimmed)
}

function parseForm(params: URLSearchParams): TillForm {
  return {
    day: first(params, TILL_FIELDS.day),
    appointments: params.getAll(TILL_FIELDS.appointment).filter((value) => value !== ''),
    tip: first(params, TILL_FIELDS.tip),
    discount: first(params, TILL_FIELDS.discount),
    discountReason: first(params, TILL_FIELDS.discountReason),
    cash: first(params, TILL_FIELDS.cash),
    card: first(params, TILL_FIELDS.card),
    bank: first(params, TILL_FIELDS.bank),
    cardRef: first(params, TILL_FIELDS.cardRef),
    bankRef: first(params, TILL_FIELDS.bankRef),
  }
}

/** The issuer, read out of the database. The route's reader, and the default. */
export async function databaseIssuer(sql: Sql): Promise<IssuerSnapshot | null> {
  const row = await readTillIssuer(sql)
  return row === null ? null : issuerSnapshotOf(row)
}

function issuerSnapshotOf(row: TillIssuerRow): IssuerSnapshot {
  return {
    legalName: row.legalName,
    tradingName: row.tradingName,
    // The empty string rather than a stand-in for a NULL: `requireIssuerTrn` reports `missing` for it, which
    // is the truthful reason, where any invented digits would report `malformed` about a value nobody entered.
    trn: row.trn ?? '',
    addressLines: row.addressLines,
    emirate: row.emirate,
    ...(row.phone === undefined ? {} : { phone: row.phone }),
    ...(row.licenceNumber === undefined ? {} : { licenceNumber: row.licenceNumber }),
  }
}

/** The trading day, requested or in progress. Null means the premises did not trade on the day named. */
async function tradingWindowFor(
  sql: Sql,
  now: number,
  requested: string,
): Promise<{ tradingDate: string } | null> {
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : null
  const [row] = await sql<{ trading_date: string }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date
      from business_day
     where case when ${wanted}::text is null then closes_at > ${new Date(now)}
                else trading_date = ${wanted}::date end
     order by trading_date
     limit 1
  `
  return row === undefined ? null : { tradingDate: row.trading_date }
}

/**
 * The hours around an instant, as `resolveTaxPoint` takes them.
 *
 * Shaped exactly as quick-book's and `/api/v1/bookings`'. A window of five days and not one, because trading
 * runs 11:00–02:00: an instant at 01:30 belongs to the previous trading date, and the tax point is resolved
 * from the SUPPLY instant, which may be a day either side of the issue.
 */
async function hoursAround(
  sql: Sql,
  instant: number,
): Promise<
  (
    date: string,
  ) => { open: ReturnType<typeof localTime>; close: ReturnType<typeof localTime> } | undefined
> {
  const day = toLocal(instant as Instant, ASIA_DUBAI).date
  const rows = await sql<{ trading_date: string; opens: string; closes: string }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date,
           to_char(opens_at at time zone 'Asia/Dubai', 'HH24:MI') as opens,
           to_char(closes_at at time zone 'Asia/Dubai', 'HH24:MI') as closes
      from business_day
     where trading_date between ${day}::date - 2 and ${day}::date + 2
  `
  const map = new Map(
    rows.map((row) => [
      row.trading_date,
      { open: localTime(row.opens), close: localTime(row.closes) },
    ]),
  )
  return (date: string) => map.get(date)
}

interface PricedTill {
  readonly basket: Basket
  readonly tenders: readonly TenderLine[]
  readonly origins: readonly { lineId: string; appointmentId: string }[]
  readonly customerId: string | null
  readonly customerLabel: string
  readonly dueFils: number
  readonly tenderedFils: number
}

/**
 * Prices the basket, or names the refusal.
 *
 * The arithmetic is entirely `@berelax/core`'s: `serviceLineFromAppointment` reconciles the snapshot against
 * its own net and VAT, `discountLine` refuses a discount with no reason, `tipLine` refuses a non-positive
 * gratuity, and `buildBasket` applies the discounts and sums the charges. Nothing here adds two money figures
 * together.
 */
function priceTill(args: {
  readonly form: TillForm
  readonly billable: readonly TillBillableAppointmentRow[]
}): { priced: PricedTill } | { refusal: TillRefusalCode; detail?: string } {
  const chosen = new Set(args.form.appointments)
  const pulled = args.billable.filter((row) => chosen.has(row.appointmentId))
  if (pulled.length === 0) return { refusal: 'nothing_to_bill' }

  const lines: BasketLineDraft[] = []
  const origins: { lineId: string; appointmentId: string }[] = []
  let customerId: string | null = null
  let customerLabel = 'Walk-in'

  pulled.forEach((row, index) => {
    const lineId = `appt-${index + 1}`
    lines.push(
      serviceLineFromAppointment(lineId, {
        appointmentId: row.appointmentId,
        serviceVariantId: row.serviceVariantId,
        status: 'completed',
        description: row.description,
        gross: gross(Number(row.grossFils)),
        net: gross(Number(row.netFils)),
        vat: gross(Number(row.vatFils)),
        vatRateBp: row.vatRateBp as VatRateBp,
        priceListId: null,
        promotionId: null,
      }),
    )
    origins.push({ lineId, appointmentId: row.appointmentId })
    if (row.customerId !== null) {
      customerId = row.customerId
      customerLabel = row.customerLabel ?? 'no label recorded'
    }
  })

  const discount = amountFils(args.form.discount)
  if (discount === null) return { refusal: 'not_a_figure', detail: 'The discount is not a figure.' }
  if (discount > 0) {
    if (args.form.discountReason === '') return { refusal: 'discount_needs_a_reason' }
    const target = lines[0]
    if (target === undefined) return { refusal: 'nothing_to_bill' }
    try {
      lines.push(
        discountLine({
          lineId: 'discount-1',
          targetLineId: target.lineId as string,
          reason: args.form.discountReason as Parameters<typeof discountLine>[0]['reason'],
          kind: 'absolute_fils',
          value: discount,
        }),
      )
    } catch (error) {
      return {
        refusal: 'discount_needs_a_reason',
        detail: isAppError(error) ? error.message : 'The discount was refused.',
      }
    }
  }

  const tip = amountFils(args.form.tip)
  if (tip === null) return { refusal: 'not_a_figure', detail: 'The gratuity is not a figure.' }
  if (tip > 0) lines.push(tipLine({ lineId: 'tip-1', gross: gross(tip) }))

  let basket: Basket
  try {
    basket = buildBasket(
      { basketId: basketId(`till-${basketDigest(args.form)}`), customerId, lines },
      STANDARD_SPA_CHART,
    )
  } catch (error) {
    return {
      refusal: 'nothing_to_bill',
      detail: isAppError(error) ? error.message : 'The basket was refused.',
    }
  }

  const tenders: TenderLine[] = []
  let tenderedFils = 0
  for (const tender of TILL_TENDER_FIELDS) {
    const raw =
      tender.field === TILL_FIELDS.cash
        ? args.form.cash
        : tender.field === TILL_FIELDS.card
          ? args.form.card
          : args.form.bank
    const value = amountFils(raw)
    if (value === null) return { refusal: 'not_a_figure', detail: 'A tender is not a figure.' }
    if (value === 0) continue
    const reference =
      tender.referenceField === TILL_FIELDS.cardRef
        ? args.form.cardRef
        : tender.referenceField === TILL_FIELDS.bankRef
          ? args.form.bankRef
          : ''
    tenders.push({
      kind: tender.kind,
      amount: gross(value),
      ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
    })
    tenderedFils += value
  }

  return {
    priced: {
      basket,
      tenders,
      origins,
      customerId,
      customerLabel,
      dueFils: basket.totals.grossTotal.fils,
      tenderedFils,
    },
  }
}

function basketView(priced: PricedTill): TillBasketView {
  const outstanding = priced.dueFils - priced.tenderedFils
  return {
    lines: priced.basket.lines.map((line) => ({
      kind: line.kind,
      description: line.description,
      grossLabel: formatMoney(line.gross),
      reason: line.kind === 'discount' ? line.terms.reason : null,
    })),
    netLabel: formatMoney(priced.basket.totals.netTotal),
    vatLabel: formatMoney(priced.basket.totals.vatTotal),
    documentGrossLabel: formatMoney(priced.basket.totals.taxableGross),
    tipLabel: formatMoney(priced.basket.totals.tipTotal),
    dueLabel: formatMoney(priced.basket.totals.grossTotal),
    dueFils: priced.dueFils,
    tenderedLabel: formatMoney(gross(priced.tenderedFils)),
    outstandingLabel: formatMoney(gross(Math.abs(outstanding))),
    balanced: outstanding === 0,
  }
}

/**
 * The entry the basket would post, shown whether or not the document can be issued.
 *
 * Built straight from `checkoutPosting` and NOT through {@link tillCheckoutMapping}, which is the important
 * part: a posting is not a document. The entry balances whatever `legal_entity.trn` says, so showing it is
 * what makes "the money is right, the paper is not" visible on the screen — and building it through the
 * mapping would have needed an issuer, which would have meant inventing a TRN to draw a page with (brief
 * rule 15).
 */
function postingViewFor(priced: PricedTill, tradingDate: string): TillPostingView | null {
  if (priced.tenders.length === 0) return null
  let lines: ReturnType<typeof checkoutPosting>['entry']['lines']
  try {
    lines = checkoutPosting(
      {
        entryId: entryId(`till-preview-${tradingDate}`),
        entryDate: localDate(tradingDate),
        basket: priced.basket,
        tenders: priced.tenders,
      },
      STANDARD_SPA_CHART,
    ).entry.lines
  } catch {
    // `TendersDoNotCoverBasket` and `MalformedTender` are both ordinary states of a half-typed tender panel.
    // The screen's own outstanding figure already says so, and an entry for a basket nobody has finished
    // paying for would be a claim about money that has not moved.
    return null
  }
  const debit = lines.reduce((total, line) => total + line.debitFils, 0)
  const credit = lines.reduce((total, line) => total + line.creditFils, 0)
  return {
    lines: lines.map((line) => ({
      accountCode: line.account as string,
      memo: line.memo ?? '',
      debitLabel: line.debitFils === 0 ? '' : formatMoney(gross(line.debitFils)),
      creditLabel: line.creditFils === 0 ? '' : formatMoney(gross(line.creditFils)),
    })),
    debitTotalLabel: formatMoney(gross(debit)),
    creditTotalLabel: formatMoney(gross(credit)),
    differenceLabel: formatMoney(gross(Math.abs(debit - credit))),
    balanced: debit === credit,
  }
}

/**
 * The mandatory field list for the form the rule chose, with every absence marked and named.
 *
 * Read off `DOCUMENT_FORM_FIELDS` in `@berelax/core` rather than typed here, so the preview and the renderer
 * cannot come to disagree about what a document states — and so a field added when Y11-vat-invoice is
 * answered appears on this screen without an edit here.
 *
 * A value that `isPlaceholderText` accepts is reported as ABSENT rather than printed. That is the whole point
 * of the screen: `TRN-PENDING-Y1-TRN` is not a TRN, and a preview that printed it would look configured.
 */
function mandatoryFields(args: {
  readonly form: 'tax_invoice' | 'simplified_invoice'
  readonly issuer: TillIssuerRow
  readonly basket: TillBasketView | null
  readonly tradingDate: string
  readonly customerLabel: string
}): readonly TillMandatoryField[] {
  const stated: Partial<Record<string, string | null>> = {
    documentTitle: args.form === 'tax_invoice' ? 'Tax Invoice' : 'Simplified Tax Invoice',
    issuerLegalName: args.issuer.legalName,
    issuerTradingName: args.issuer.tradingName,
    issuerAddress: issuerAddressSnapshot(args.issuer.addressLines).replace(/\n/g, ', '),
    issuerEmirate: args.issuer.emirate,
    issuerTrn: args.issuer.trn,
    issuerPhone: args.issuer.phone ?? null,
    // Drawn from `document_series` at issue and gapless (ADR 0017), so there is nothing to show before the
    // document exists. Absent because it has not happened, not because a value is missing.
    documentNumber: null,
    documentSeries: args.form === 'tax_invoice' ? 'TAX-INV' : 'SIMPL-INV',
    issueDate: args.tradingDate,
    taxPointDate: args.tradingDate,
    customerName: args.customerLabel,
    customerAddress: null,
    customerTrn: null,
    lineDescription: args.basket === null ? null : 'one per basket line, below',
    lineQuantity: args.basket === null ? null : '1 per line',
    lineUnitGross: args.basket === null ? null : 'one per basket line, below',
    lineNet: args.basket?.netLabel ?? null,
    lineVatRate: args.basket === null ? null : '5%',
    lineVat: args.basket?.vatLabel ?? null,
    lineGross: args.basket?.documentGrossLabel ?? null,
    netTotal: args.basket?.netLabel ?? null,
    vatTotal: args.basket?.vatLabel ?? null,
    grossTotal: args.basket?.documentGrossLabel ?? null,
    currency: 'AED',
    arabicText: 'every label, title and statement, rendered by the F10 template',
    notATaxInvoice: null,
  }
  return (DOCUMENT_FORM_FIELDS[args.form] ?? []).map((key) => {
    const raw = stated[key as string]
    const value = raw === undefined || raw === null || isPlaceholderText(raw) ? null : raw
    return {
      key,
      label: TILL_FIELD_LABELS[key],
      value,
      // The TRN is Y1-trn's and everything else absent is Y11-vat-invoice's — that list is what the agent
      // has to confirm, so a field the system cannot state is exactly what to show them.
      openQuestionId: value !== null ? null : key === 'issuerTrn' ? 'Y1-trn' : 'Y11-vat-invoice',
    }
  })
}

/** A stable digest of what is being billed. Compared on a replay, never interpreted. */
function basketDigest(form: TillForm): string {
  return createHash('sha256')
    .update(
      [
        form.day,
        [...form.appointments].sort().join(','),
        form.tip,
        form.discount,
        form.discountReason,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 32)
}

interface BuiltView {
  readonly view: TillView
  readonly priced: PricedTill | null
  readonly pricingRefusal: TillRefusal | null
  readonly issuer: TillIssuerRow
  readonly tradingDate: string
}

const EMPTY_ISSUER: TillIssuerRow = {
  legalName: '',
  tradingName: '',
  trn: null,
  addressLines: [],
  emirate: '',
  trnIsPlaceholder: true,
}

async function buildView(args: {
  readonly deps: TillDeps
  readonly request: TillRequest
  readonly form: TillForm
  readonly screen: TillScreen
  readonly direction: 'ltr' | 'rtl'
  readonly announcement: string
  readonly refusal: TillRefusal | null
  readonly issued: TillView['issued']
}): Promise<BuiltView | { notTrading: true }> {
  const { deps, request, form } = args
  const window = await tradingWindowFor(deps.sql, deps.now(), form.day)
  if (window === null) return { notTrading: true }

  const issuer = (await readTillIssuer(deps.sql)) ?? EMPTY_ISSUER
  const billable = await readBillableAppointments(deps.sql, window.tradingDate)

  const priced = priceTill({ form, billable })
  const pricedTill = 'priced' in priced ? priced.priced : null
  // A refusal only when the operator asked for something. An empty basket on first load is the resting state
  // of the screen, not a failure, and a page that opened with a red panel would train the desk to ignore it.
  const pricingRefusal: TillRefusal | null =
    'refusal' in priced && form.appointments.length > 0
      ? {
          code: priced.refusal,
          sentence: tillRefusalSentence(priced.refusal, priced.detail),
          openQuestionId: null,
        }
      : null

  const basket = pricedTill === null ? null : basketView(pricedTill)
  const posting = pricedTill === null ? null : postingViewFor(pricedTill, window.tradingDate)

  const query = new URLSearchParams()
  query.set(TILL_FIELDS.day, window.tradingDate)
  if (args.direction === 'rtl') query.set(TILL_FIELDS.direction, 'rtl')
  const previewQuery = new URLSearchParams(query)
  previewQuery.set(TILL_FIELDS.view, 'preview')

  const documentForm =
    pricedTill === null
      ? 'simplified_invoice'
      : requireInvoiceForm({
          gross: pricedTill.basket.totals.taxableGross,
          customerIdentified: pricedTill.customerId !== null,
        })

  return {
    priced: pricedTill,
    pricingRefusal,
    issuer,
    tradingDate: window.tradingDate,
    view: {
      screen: args.screen,
      direction: args.direction,
      chrome: request.chrome,
      action: `${TILL_PATH}?${query.toString()}`,
      tillHref: `${TILL_PATH}?${query.toString()}`,
      previewHref: `${TILL_PATH}?${previewQuery.toString()}`,
      cashUpHref: `${TILL_CASH_UP_PATH}?${query.toString()}`,
      packagesHref: `${PACKAGES_PATH}?${query.toString()}`,
      dayLabel: `Business day ${window.tradingDate}`,
      tradingDate: window.tradingDate,
      lede:
        'Trading runs 11:00 to 02:00, so a treatment delivered at 01:30 is billed on the previous ' +
        'business day. Every date on this screen is the business day, never the calendar date.',
      announcement: args.announcement,
      billable: billable.map((row) => ({
        appointmentId: row.appointmentId,
        description: row.description,
        grossLabel: formatMoney(grossMoneyFromFils(row.grossFils)),
        startLabel: toLocal(row.startsAt.getTime() as Instant, ASIA_DUBAI).time,
        customerLabel: row.customerLabel ?? 'Walk-in, no record',
        inBasket: form.appointments.includes(row.appointmentId),
      })),
      basket,
      posting,
      refusal: args.refusal ?? pricingRefusal,
      issued: args.issued,
      issuer: {
        legalName: issuer.legalName,
        tradingName: issuer.tradingName,
        addressLabel: issuerAddressSnapshot(issuer.addressLines).replace(/\n/g, ', '),
        emirate: issuer.emirate,
        trn: issuer.trnIsPlaceholder ? null : issuer.trn,
      },
      mandatory:
        args.screen === 'preview'
          ? mandatoryFields({
              form: documentForm,
              issuer,
              basket,
              tradingDate: window.tradingDate,
              customerLabel: pricedTill?.customerLabel ?? 'Walk-in',
            })
          : [],
      assumptions: TILL_ASSUMPTIONS,
      form: { ...form, day: window.tradingDate },
    },
  }
}

function notTradingResponse(form: TillForm): Response {
  // 409 and `text/plain`. Deliberately NOT a document: every file under `app/(admin)` that emits a doctype
  // has to render the Google re-auth banner (G-CONN-08) and `google-reauth-banner.test.ts` walks the tree to
  // say so, and a one-sentence refusal about a day the premises did not trade is not a page. Dressing it as
  // one would put a second, bannerless copy of the shell in this file — quick-book's `unavailable` records
  // the same argument.
  return new Response(
    `${tillRefusalSentence('not_a_trading_day')} Requested: ${
      form.day === '' ? 'the day in progress' : form.day
    }\n`,
    {
      status: 409,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    },
  )
}

const directionOf = (params: URLSearchParams): 'ltr' | 'rtl' =>
  params.get(TILL_FIELDS.direction) === 'rtl' ? 'rtl' : 'ltr'

const screenOf = (params: URLSearchParams): TillScreen =>
  params.get(TILL_FIELDS.view) === 'preview' ? 'preview' : 'till'

export async function handleTillRead(request: TillRequest, deps: TillDeps): Promise<Response> {
  const form = parseForm(request.searchParams)
  const built = await buildView({
    deps,
    request,
    form,
    screen: screenOf(request.searchParams),
    direction: directionOf(request.searchParams),
    announcement: 'Pull a completed treatment through, then take the payment.',
    refusal: null,
    issued: null,
  })
  if ('notTrading' in built) return notTradingResponse(form)
  return html(renderTillHtml(built.view), 200)
}

export async function handleTillWrite(request: TillRequest, deps: TillDeps): Promise<Response> {
  const body = request.body
  if (body === null || body.get(TILL_FIELDS.step) === null) {
    // A body that is not form-encoded parses to an empty `URLSearchParams`, which lands here rather than as a
    // 500: this screen has no JSON client and never will, and a hand-crafted POST gets the same named answer
    // an empty one does.
    const form = parseForm(body ?? new URLSearchParams())
    const refusal: TillRefusal = {
      code: 'unreadable_request',
      sentence: tillRefusalSentence('unreadable_request'),
      openQuestionId: null,
    }
    const built = await buildView({
      deps,
      request,
      form,
      screen: 'till',
      direction: directionOf(body ?? request.searchParams),
      announcement: refusal.sentence,
      refusal,
      issued: null,
    })
    if ('notTrading' in built) return notTradingResponse(form)
    return html(renderTillHtml(built.view), 400)
  }

  const form = parseForm(body)
  const direction = directionOf(body)

  if (body.get(TILL_FIELDS.step) !== 'issue') {
    const built = await buildView({
      deps,
      request,
      form,
      screen: screenOf(body),
      direction,
      announcement: 'Priced. Check the totals and the entry, then take the payment.',
      refusal: null,
      issued: null,
    })
    if ('notTrading' in built) return notTradingResponse(form)
    return html(renderTillHtml(built.view), built.pricingRefusal === null ? 200 : 409)
  }

  const built = await buildView({
    deps,
    request,
    form,
    screen: screenOf(body),
    direction,
    announcement: 'Taking the payment.',
    refusal: null,
    issued: null,
  })
  if ('notTrading' in built) return notTradingResponse(form)
  if (built.priced === null || built.pricingRefusal !== null) {
    return html(renderTillHtml(built.view), 409)
  }

  const priced = built.priced
  const outstanding = priced.dueFils - priced.tenderedFils
  if (outstanding !== 0) {
    const refusal: TillRefusal = {
      code: 'tender_does_not_cover',
      sentence: tillRefusalSentence(
        'tender_does_not_cover',
        `Due ${formatMoney(gross(priced.dueFils))}, tendered ${formatMoney(gross(priced.tenderedFils))}.`,
      ),
      openQuestionId: null,
    }
    return html(renderTillHtml({ ...built.view, refusal, announcement: refusal.sentence }), 409)
  }

  const issuer = await (deps.readIssuer ?? databaseIssuer)(deps.sql)
  const now = deps.now()
  const hoursFor = await hoursAround(deps.sql, now)
  const invoiceForm = requireInvoiceForm({
    gross: priced.basket.totals.taxableGross,
    customerIdentified: priced.customerId !== null,
  })

  let mapping: TillCheckoutMapping
  try {
    mapping = tillCheckoutMapping({
      basket: priced.basket,
      tenders: priced.tenders,
      entryId: entryId(`till-${basketDigest(form)}`),
      idempotencyKey: `till:${built.tradingDate}:${basketDigest(form)}`,
      requestFingerprint: basketDigest(form),
      supplyAt: now as Instant,
      issuedAt: now as Instant,
      origins: priced.origins,
      // The empty snapshot when `legal_entity` has no row at all, which is a migration that did not run;
      // `requireIssuerSnapshot` refuses it by the same path as the placeholder, naming `missing`.
      issuer: issuer ?? { legalName: '', tradingName: '', trn: '', addressLines: [], emirate: '' },
      documentKind: invoiceForm,
      seriesCode: invoiceForm === 'tax_invoice' ? 'TAX-INV' : 'SIMPL-INV',
      customerLabel: priced.customerLabel,
      ...(priced.customerId === null ? {} : { customerId: priced.customerId }),
      hoursFor: hoursFor as unknown as HoursForDate,
    })
  } catch (error) {
    // `TrnNotConfigured` is the expected answer today and is NOT a 500: it is the state of the business, and
    // this screen's job is to say which question is waiting. Nothing has been written — the refusal happens
    // before the mapping composes anything, which is why this branch cannot leave a half-built document for
    // a retry to trip over.
    const trn = error instanceof TrnNotConfigured
    const refusal: TillRefusal = {
      code: trn ? 'issuer_trn_not_configured' : 'refused_by_the_ledger',
      sentence: trn
        ? tillRefusalSentence('issuer_trn_not_configured')
        : tillRefusalSentence(
            'refused_by_the_ledger',
            isAppError(error) ? error.message : 'Unexpected.',
          ),
      openQuestionId: trn ? 'Y1-trn' : null,
    }
    return html(renderTillHtml({ ...built.view, refusal, announcement: refusal.sentence }), 409)
  }

  try {
    const finalised = await finaliseCheckout(deps.sql, TILL_ACTOR, mapping.input, {
      ...(request.requestId === null ? {} : { requestId: request.requestId }),
    })
    const issued = {
      displayNumber: finalised.invoice.displayNumber,
      documentKind: invoiceForm,
      seriesCode: mapping.input.invoice.seriesCode,
      grossLabel: formatMoney(gross(finalised.invoice.grossTotalFils)),
      tenderLabels: finalised.tenders.map(
        (tender) => `${tender.tenderKind} ${formatMoney(gross(tender.amountFils))}`,
      ),
    }
    return html(
      renderTillHtml({
        ...built.view,
        issued,
        announcement: `Issued ${issued.displayNumber} and took ${issued.grossLabel}.`,
      }),
      200,
    )
  } catch (error) {
    const named = checkoutError(error)
    const refusal: TillRefusal = {
      code: 'refused_by_the_ledger',
      sentence: tillRefusalSentence(
        'refused_by_the_ledger',
        named?.message ?? (isAppError(error) ? error.message : 'Unexpected.'),
      ),
      openQuestionId: null,
    }
    return html(renderTillHtml({ ...built.view, refusal, announcement: refusal.sentence }), 409)
  }
}
