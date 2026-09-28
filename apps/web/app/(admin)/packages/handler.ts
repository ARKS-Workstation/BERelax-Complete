import {
  entryId,
  filsFrom,
  formatMoney,
  isPlaceholderText,
  localDate,
  money,
  type TenderLine,
} from '@berelax/core'
import {
  currentPackageTemplateVersion,
  packageError,
  packageRedemptionError,
  readBillableAppointments,
  readPackageTemplates,
  readRedeemableBalances,
  redeemPackage,
  type Sql,
  sellPackage,
  withUnitOfWork,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'
import { tillPackageRedemptionMapping, tillPackageSaleMapping } from '../../../src/till/mapping.ts'
import { PACKAGES_PATH, TILL_CASH_UP_PATH, TILL_FIELDS, TILL_PATH } from '../till/view.ts'
import { PACKAGE_FIELDS, type PackageView, renderPackagesHtml } from './render.ts'

/**
 * Everything the package screen decides (M-TILL-13).
 *
 * Two writes, and they are the only two money paths the till can COMPLETE today:
 *
 *   - a **sale** takes the tenders, posts `Dr tender / Cr 2050` at the full gross and opens one balance per
 *     template line. It issues no document at all, so `Y1-trn` does not block it: `payment.package_sale_id`
 *     (0083) is what lets a payment row name a package instead of an invoice, and that is exactly why cash
 *     taken for a package is visible to `readDrawerTakings` and to the cash-up;
 *   - a **redemption** releases the balance, credits 4020 at the net and 2030 at the VAT. Under
 *     Y11-vat-package's provisional answer the redemption IS the supply, so this is where output VAT enters
 *     the standard-rated grouping a VAT201 box 1 reads.
 *
 * ## The document owed at redemption, which is M-TILL-10's deferral ANSWERED rather than deferred again
 *
 * If the redemption is the supply then a tax document is owed for it, and M-TILL-10 left that to this unit
 * because issuing one needs the numbering series, the issuer snapshot and the mandatory field list. All three
 * exist. What does not exist is a TRN: `legal_entity.trn` holds `TRN-PENDING-Y1-TRN`, and every invoice form
 * states the supplier TRN — so the document owed for a redemption cannot be issued for exactly the same
 * reason the till cannot issue one for a treatment. The answer is therefore not "later": it is **the
 * obligation, stated on the screen, with both questions named** ({@link DOCUMENT_OBLIGATION}), and the VAT is
 * NOT deferred with it — 2030 is credited here, so box 1 is right whether or not the paper exists.
 */

export interface PackageRequest {
  readonly searchParams: URLSearchParams
  readonly body: URLSearchParams | null
  readonly chrome: AdminChrome
  readonly requestId: string | null
}

export interface PackageDeps {
  readonly sql: Sql
  readonly now: () => number
}

/**
 * The question that owns "what does this business sell as a package".
 *
 * Spelled here rather than imported from `@berelax/fixtures`, which is a devDependency of `@berelax/web` and
 * must not reach a route (see `src/till/mapping.ts`). `apps/web/src/till-render.test.ts` holds the two equal,
 * which is the check a second spelling needs.
 */
export const FIXTURE_PACKAGE_OPEN_QUESTION = 'Y9-package-catalogue'

/** The obligation a redemption creates and the system cannot discharge. Shown on every load. */
export const DOCUMENT_OBLIGATION = {
  sentence:
    'Under the provisional answer the supply happens at redemption, so a tax document is owed for every ' +
    'release below. None has been issued and none can be: every invoice form states the supplier Tax ' +
    'Registration Number, and it has not been entered. The VAT is not deferred with the paper — 2030 is ' +
    'credited by the redemption, so the output-VAT box is right whether or not the document exists.',
  openQuestionIds: ['Y1-trn', 'Y11-vat-package'] as readonly string[],
} as const

const html = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })

const fils = (value: number): string => formatMoney(money(filsFrom(value)))

function amountFils(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return 0
  if (!/^[0-9]{1,12}$/.test(trimmed)) return null
  return Number(trimmed)
}

async function tradingDateFor(sql: Sql, now: number, requested: string): Promise<string | null> {
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : null
  const [row] = await sql<{ trading_date: string }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date
      from business_day
     where case when ${wanted}::text is null then closes_at > ${new Date(now)}
                else trading_date = ${wanted}::date end
     order by trading_date
     limit 1
  `
  return row?.trading_date ?? null
}

/**
 * How far through a course a balance is, as a phrase.
 *
 * The four states docs/12 §5 asks the fixture salon to hold, named from the ROWS rather than stored beside
 * them: a stored label is a second answer to a question `sessions_redeemed` already answers, and its failure
 * mode is a label that stopped being true when the last session was drawn.
 */
export function drawdownState(args: {
  readonly sessionsRedeemed: number
  readonly sessionsTotal: number
  readonly expired: boolean
}): string {
  if (args.expired && args.sessionsRedeemed < args.sessionsTotal) return 'expired with a balance'
  if (args.sessionsRedeemed === 0) return 'untouched'
  if (args.sessionsRedeemed >= args.sessionsTotal) return 'fully used'
  return 'part used'
}

async function buildView(args: {
  readonly deps: PackageDeps
  readonly request: PackageRequest
  readonly params: URLSearchParams
  readonly announcement: string
  readonly refusal: string | null
  readonly sold: PackageView['sold']
  readonly redeemed: PackageView['redeemed']
}): Promise<PackageView | null> {
  const { deps, params } = args
  const tradingDate = await tradingDateFor(
    deps.sql,
    deps.now(),
    params.get(PACKAGE_FIELDS.day) ?? '',
  )
  if (tradingDate === null) return null
  const direction = params.get(PACKAGE_FIELDS.direction) === 'rtl' ? 'rtl' : 'ltr'

  const [templates, balances, appointments, customers] = await Promise.all([
    readPackageTemplates(deps.sql),
    readRedeemableBalances(deps.sql, tradingDate),
    readBillableAppointments(deps.sql, tradingDate),
    deps.sql<{ id: string; label: string | null }[]>`
      select id, display_name as label from customer order by created_at, id limit 20
    `,
  ])

  const query = new URLSearchParams()
  query.set(TILL_FIELDS.day, tradingDate)
  if (direction === 'rtl') query.set(TILL_FIELDS.direction, 'rtl')
  const previewQuery = new URLSearchParams(query)
  previewQuery.set(TILL_FIELDS.view, 'preview')

  const chosenTemplate = params.get(PACKAGE_FIELDS.template) ?? ''

  return {
    direction,
    chrome: args.request.chrome,
    action: `${PACKAGES_PATH}?${query.toString()}`,
    tillHref: `${TILL_PATH}?${query.toString()}`,
    previewHref: `${TILL_PATH}?${previewQuery.toString()}`,
    cashUpHref: `${TILL_CASH_UP_PATH}?${query.toString()}`,
    packagesHref: `${PACKAGES_PATH}?${query.toString()}`,
    tradingDate,
    announcement: args.announcement,
    refusal: args.refusal,
    templates: templates.map((template) => ({
      templateKey: template.templateKey,
      publicDisplayName: template.publicDisplayName,
      internalName: template.internalName,
      priceLabel: fils(Number(template.priceFils)),
      sessionCount: template.sessionCount,
      validityMonths: template.validityMonths,
      transferable: template.transferable,
      unredeemedBalancePolicy: template.unredeemedBalancePolicy,
      version: template.version,
      isProvisional: template.isProvisional,
      // The row's question, or `Y9-package-catalogue` when the row carries none and the NAME is marked. A
      // template whose terms were typed in is not flagged `is_provisional` — that is what the flag means — but
      // a fixture package is still not a product this business sells, and a screenshot of a package with no
      // question beside it is exactly what a reviewer could mistake for real.
      openQuestionId:
        template.openQuestionId ??
        (isPlaceholderText(template.publicDisplayName) ? FIXTURE_PACKAGE_OPEN_QUESTION : null),
      salesCount: template.salesCount,
      sessionsRedeemed: template.sessionsRedeemed,
      sessionsSold: template.sessionsSold,
      drawdownLabel:
        template.salesCount === 0
          ? 'never sold'
          : `${template.sessionsRedeemed} of ${template.sessionsSold} sessions drawn across ${template.salesCount} sale(s)`,
      chosen: template.templateKey === chosenTemplate,
    })),
    balances: balances.map((balance) => {
      const expired = balance.expiresOn < tradingDate
      return {
        balanceId: balance.balanceId,
        label: balance.publicDisplayName,
        customerLabel: balance.customerLabel ?? 'no label recorded',
        sessionsTotal: balance.sessionsTotal,
        sessionsRedeemed: balance.sessionsRedeemed,
        valueLabel: fils(Number(balance.valueFils)),
        releasedLabel: fils(Number(balance.releasedFils)),
        unreleasedLabel: fils(Number(balance.valueFils) - Number(balance.releasedFils)),
        expiresOn: balance.expiresOn,
        expired,
        stateLabel: drawdownState({
          sessionsRedeemed: balance.sessionsRedeemed,
          sessionsTotal: balance.sessionsTotal,
          expired,
        }),
        openQuestionId: balance.openQuestionId,
      }
    }),
    customers: customers.map((row) => ({
      customerId: row.id,
      // The label, and never an invented name (ADR 0020, brief rule 10).
      label: row.label ?? `no label recorded (${row.id.slice(0, 8)})`,
    })),
    appointments: appointments.map((row) => ({
      appointmentId: row.appointmentId,
      label: `${row.description} — ${row.customerLabel ?? 'Walk-in, no record'}`,
    })),
    sold: args.sold,
    redeemed: args.redeemed,
    documentObligation: DOCUMENT_OBLIGATION,
  }
}

const NOT_TRADING = (): Response =>
  new Response('The premises did not trade on that day, so nothing can be dated on it.\n', {
    status: 409,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })

export async function handlePackagesRead(
  request: PackageRequest,
  deps: PackageDeps,
): Promise<Response> {
  const view = await buildView({
    deps,
    request,
    params: request.searchParams,
    announcement: 'Sell a package, or draw a delivered treatment against one.',
    refusal: null,
    sold: null,
    redeemed: null,
  })
  return view === null ? NOT_TRADING() : html(renderPackagesHtml(view), 200)
}

export async function handlePackagesWrite(
  request: PackageRequest,
  deps: PackageDeps,
): Promise<Response> {
  const body = request.body ?? new URLSearchParams()
  const step = body.get(PACKAGE_FIELDS.step)
  const context = request.requestId === null ? {} : { requestId: request.requestId }

  const answer = async (
    announcement: string,
    refusal: string | null,
    status: number,
    sold: PackageView['sold'] = null,
    redeemed: PackageView['redeemed'] = null,
  ): Promise<Response> => {
    const view = await buildView({
      deps,
      request,
      params: body,
      announcement,
      refusal,
      sold,
      redeemed,
    })
    return view === null ? NOT_TRADING() : html(renderPackagesHtml(view), status)
  }

  if (step === null) {
    const message = 'That request could not be read as a package submission.'
    return answer(message, message, 400)
  }

  const tradingDate = await tradingDateFor(deps.sql, deps.now(), body.get(PACKAGE_FIELDS.day) ?? '')
  if (tradingDate === null) return NOT_TRADING()

  try {
    if (step === 'sell') {
      const templateKey = body.get(PACKAGE_FIELDS.template) ?? ''
      const customerId = body.get(PACKAGE_FIELDS.customer) ?? ''
      const version = await currentPackageTemplateVersion(deps.sql, templateKey)
      if (version === null) {
        const message = `No package "${templateKey}" is available to sell.`
        return answer(message, message, 409)
      }
      const cash = amountFils(body.get(PACKAGE_FIELDS.cash) ?? '')
      const card = amountFils(body.get(PACKAGE_FIELDS.card) ?? '')
      if (cash === null || card === null) {
        const message = 'A tender has to be a whole number of fils.'
        return answer(message, message, 409)
      }
      const cardRef = (body.get(PACKAGE_FIELDS.cardRef) ?? '').trim()
      const tenders: TenderLine[] = []
      if (cash > 0) tenders.push({ kind: 'cash', amount: money(filsFrom(cash)) })
      if (card > 0) {
        tenders.push({
          kind: 'card_in_salon',
          amount: money(filsFrom(card)),
          ...(cardRef === '' ? {} : { reference: cardRef }),
        })
      }
      const mapping = tillPackageSaleMapping({
        entryId: entryId(`pkg-sale-${tradingDate}-${templateKey}-${cash}-${card}`),
        tradingDate: localDate(tradingDate),
        customerId,
        templateVersionId: version.versionId,
        priceGross: money(filsFrom(version.priceFils)),
        lines: version.lines.map((line) => ({
          lineNo: line.lineNo,
          serviceVariantId: line.serviceVariantId,
          sessionCount: line.sessionCount,
          listGrossFils: line.listGrossFils,
        })),
        tenders,
        validityMonths: version.validityMonths,
        transferable: version.transferable,
        unredeemedBalancePolicy: version.unredeemedBalancePolicy,
        packageLabel: version.internalName,
      })
      const soldPackage = await withUnitOfWork(
        deps.sql,
        { kind: 'staff', label: 'Packages' },
        async (uow) => sellPackage(uow, mapping.input),
        context,
      )
      return answer(
        `Took ${fils(soldPackage.priceFils)} and opened ${soldPackage.balanceIds.length} entitlement(s), valid until ${soldPackage.expiresOn}.`,
        null,
        200,
        {
          saleId: soldPackage.saleId,
          priceLabel: fils(soldPackage.priceFils),
          expiresOn: soldPackage.expiresOn,
          entryLines: mapping.posting.entry.lines.map((line) => ({
            accountCode: line.account as string,
            debitLabel: line.debitFils === 0 ? '' : fils(line.debitFils),
            creditLabel: line.creditFils === 0 ? '' : fils(line.creditFils),
          })),
        },
      )
    }

    if (step === 'redeem') {
      const balanceId = body.get(PACKAGE_FIELDS.balance) ?? ''
      const appointmentId = body.get(PACKAGE_FIELDS.appointment) ?? ''
      const units = amountFils(body.get(PACKAGE_FIELDS.units) ?? '')
      if (units === null || units < 1) {
        const message = 'A redemption consumes at least one whole session.'
        return answer(message, message, 409)
      }
      const balances = await readRedeemableBalances(deps.sql, tradingDate)
      const row = balances.find((balance) => balance.balanceId === balanceId)
      if (row === undefined) {
        const message = 'That entitlement has no sessions left, or does not exist.'
        return answer(message, message, 409)
      }
      const mapping = tillPackageRedemptionMapping({
        entryId: entryId(`pkg-redeem-${appointmentId}`),
        tradingDate: localDate(tradingDate),
        balance: {
          balanceId: row.balanceId,
          sessionsTotal: row.sessionsTotal,
          sessionsRedeemed: row.sessionsRedeemed,
          valueGross: money(filsFrom(Number(row.valueFils))),
          releasedGross: money(filsFrom(Number(row.releasedFils))),
        },
        appointmentId,
        units,
        packageLabel: row.packageLabel,
      })
      const redeemed = await withUnitOfWork(
        deps.sql,
        { kind: 'staff', label: 'Packages' },
        async (uow) => redeemPackage(uow, mapping.input),
        context,
      )
      return answer(
        `Released ${fils(redeemed.releasedFils)} — ${fils(redeemed.netFils)} to 4020 and ${fils(redeemed.vatFils)} to 2030, which is the output VAT on what was delivered.`,
        null,
        200,
        null,
        {
          redemptionId: redeemed.redemptionId,
          releasedLabel: fils(redeemed.releasedFils),
          vatLabel: fils(redeemed.vatFils),
          netLabel: fils(redeemed.netFils),
          sessionsRedeemed: redeemed.sessionsRedeemed,
          sessionsTotal: redeemed.sessionsTotal,
          entryLines: mapping.posting.entry.lines.map((line) => ({
            accountCode: line.account as string,
            debitLabel: line.debitFils === 0 ? '' : fils(line.debitFils),
            creditLabel: line.creditFils === 0 ? '' : fils(line.creditFils),
          })),
        },
      )
    }

    const unknown = `Unknown step "${step}".`
    return answer(unknown, unknown, 400)
  } catch (error) {
    // The services' own named refusals first — `PackageExpired`, `PackageBalanceUnavailable`,
    // `ArchivedServiceReferenced`, and the SQLSTATE translations of the ZG rules — so the screen says what the
    // ledger said rather than "something went wrong".
    const named = packageRedemptionError(error) ?? packageError(error)
    const message = named?.message ?? (isAppError(error) ? error.message : 'Unexpected.')
    return answer(message, message, 409)
  }
}
