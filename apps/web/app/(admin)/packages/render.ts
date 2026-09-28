import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'
import {
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'
import { TILL_CSS } from '../till/render.ts'

/**
 * The package screen, as HTML (M-TILL-13).
 *
 * Pure: a view in, a document out. It shares {@link TILL_CSS} with the till and the cash-up for the reason
 * `cash-up/render.ts` gives — one stylesheet is one place the palette rule and the touch-target floor can be
 * broken, and the itest's DOM scan then proves it once for three screens.
 *
 * ## Why every package on this screen carries a marker, and what that marker is for
 *
 * **What this business sells as a package is a fact nobody has stated.** The size, the price, the treatments
 * and the discount are all owner-side, and there is no document in the repository that names one. A seeded
 * "6 Massage Package at AED 1,200" would be indistinguishable from a configured one the moment it appeared in
 * a screenshot somebody reviews, which is brief rule 15's whole subject: a plausible value is worse than a
 * blank one, because blank is visibly unanswered and plausible looks configured.
 *
 * So the fixture templates carry their unconfirmed state **in the data**, three ways at once, and this screen
 * renders all three rather than a badge it decides for itself:
 *
 *   1. `package_template_version.is_provisional` is true and `open_question_id` is `Y9-package-catalogue`,
 *      which is what puts the row on the Unconfirmed Assumptions panel;
 *   2. the display name itself carries a marker `is_placeholder_text()` recognises — so the same function
 *      that stops `TRN-PENDING-Y1-TRN` reaching an invoice would stop this name reaching one, and the words
 *      on the screen say the package is not a real product;
 *   3. this screen prints the open question beside every provisional template, as a `<code>` element, so a
 *      reviewer looking at a PNG reads the id rather than having to know.
 *
 * A template the owner confirms loses all three by having its flag cleared and a new version published with
 * the real terms — no code change, which is the same mechanism a confirmed setting uses. `is_provisional` is
 * the switch, so this screen cannot be wrong about a package that has been answered.
 */

export const PACKAGE_FIELDS = {
  step: 's',
  day: 'day',
  template: 'tpl',
  customer: 'cust',
  cash: 'cash',
  card: 'card',
  cardRef: 'cardref',
  balance: 'bal',
  appointment: 'appt',
  units: 'units',
  direction: 'dir',
} as const

export const PACKAGE_STEPS = ['sell', 'redeem'] as const
export type PackageStep = (typeof PACKAGE_STEPS)[number]

export interface PackageTemplateOption {
  readonly templateKey: string
  readonly publicDisplayName: string
  readonly internalName: string
  readonly priceLabel: string
  readonly sessionCount: number
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: string
  readonly version: number
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly salesCount: number
  readonly sessionsRedeemed: number
  readonly sessionsSold: number
  readonly drawdownLabel: string
  readonly chosen: boolean
}

export interface PackageBalanceRow {
  readonly balanceId: string
  readonly label: string
  readonly customerLabel: string
  readonly sessionsTotal: number
  readonly sessionsRedeemed: number
  readonly valueLabel: string
  readonly releasedLabel: string
  readonly unreleasedLabel: string
  readonly expiresOn: string
  readonly expired: boolean
  readonly stateLabel: string
  readonly openQuestionId: string | null
}

export interface PackageCustomerOption {
  readonly customerId: string
  readonly label: string
}

export interface PackageAppointmentOption {
  readonly appointmentId: string
  readonly label: string
}

export interface PackageSoldView {
  readonly saleId: string
  readonly priceLabel: string
  readonly expiresOn: string
  readonly entryLines: readonly { accountCode: string; debitLabel: string; creditLabel: string }[]
}

export interface PackageRedeemedView {
  readonly redemptionId: string
  readonly releasedLabel: string
  readonly vatLabel: string
  readonly netLabel: string
  readonly sessionsRedeemed: number
  readonly sessionsTotal: number
  readonly entryLines: readonly { accountCode: string; debitLabel: string; creditLabel: string }[]
}

export interface PackageView {
  readonly direction: 'ltr' | 'rtl'
  readonly chrome: AdminChrome
  readonly action: string
  readonly tillHref: string
  readonly previewHref: string
  readonly cashUpHref: string
  readonly packagesHref: string
  readonly tradingDate: string
  readonly announcement: string
  readonly refusal: string | null
  readonly templates: readonly PackageTemplateOption[]
  readonly balances: readonly PackageBalanceRow[]
  readonly customers: readonly PackageCustomerOption[]
  readonly appointments: readonly PackageAppointmentOption[]
  readonly sold: PackageSoldView | null
  readonly redeemed: PackageRedeemedView | null
  /** The document that is OWED at redemption and cannot be issued. Always present, always named. */
  readonly documentObligation: {
    readonly sentence: string
    readonly openQuestionIds: readonly string[]
  }
}

const attribute = (name: string, value: string): string => `${name}="${safeText(value)}"`

const hidden = (name: string, value: string): string =>
  `<input type="hidden" ${attribute('name', name)} ${attribute('value', value)}>`

function nav(view: PackageView): string {
  return [
    '<nav aria-label="Till">',
    '<ul>',
    `<li><a ${attribute('href', view.tillHref)} data-testid="till-nav-till">Till</a></li>`,
    `<li><a ${attribute('href', view.previewHref)} data-testid="till-nav-preview">Invoice preview</a></li>`,
    `<li><a ${attribute('href', view.cashUpHref)} data-testid="till-nav-cash-up">Cash-up</a></li>`,
    `<li><a ${attribute('href', view.packagesHref)} data-testid="till-nav-packages">Packages</a></li>`,
    '</ul>',
    '</nav>',
  ].join('')
}

function templatesPanel(view: PackageView): string {
  if (view.templates.length === 0) {
    return '<p data-testid="packages-empty">No package is configured. Nothing in the repository says what this business sells as a package — <code>Y9-package-catalogue</code>.</p>'
  }
  return [
    '<h2>Packages</h2>',
    '<table data-testid="packages-templates">',
    '<thead><tr><th scope="col">Package</th><th scope="col" class="money">Price</th>' +
      '<th scope="col">Sessions</th><th scope="col">Terms</th><th scope="col">Drawdown</th>' +
      '<th scope="col">Waiting on</th></tr></thead>',
    '<tbody>',
    ...view.templates.map(
      (template) =>
        `<tr ${attribute('data-template', template.templateKey)} ` +
        `${attribute('data-provisional', template.isProvisional ? '1' : '0')}>` +
        `<td>${safeText(template.publicDisplayName)} <small>v${safeText(String(template.version))}</small></td>` +
        `<td class="money">${safeText(template.priceLabel)}</td>` +
        `<td>${safeText(String(template.sessionCount))}</td>` +
        `<td>${safeText(String(template.validityMonths))} months, ` +
        `${template.transferable ? 'transferable' : 'non-transferable'}, ` +
        `${safeText(template.unredeemedBalancePolicy)} at expiry</td>` +
        `<td data-field="drawdown">${safeText(template.drawdownLabel)}</td>` +
        `<td>${
          template.openQuestionId === null
            ? ''
            : `<code data-testid="packages-question">${safeText(template.openQuestionId)}</code>`
        }</td></tr>`,
    ),
    '</tbody></table>',
  ].join('')
}

function balancesPanel(view: PackageView): string {
  if (view.balances.length === 0) {
    return '<p data-testid="packages-balances-empty">No entitlement is outstanding.</p>'
  }
  return [
    '<h2>Outstanding entitlements</h2>',
    '<table data-testid="packages-balances">',
    '<thead><tr><th scope="col">Package</th><th scope="col">Customer</th><th scope="col">State</th>' +
      '<th scope="col" class="money">Released</th><th scope="col" class="money">Still owed</th>' +
      '<th scope="col">Valid until</th></tr></thead>',
    '<tbody>',
    ...view.balances.map(
      (balance) =>
        `<tr ${attribute('data-balance', balance.balanceId)} ` +
        `${attribute('data-expired', balance.expired ? '1' : '0')} ` +
        `${attribute('data-state', balance.stateLabel)}>` +
        `<td>${safeText(balance.label)}</td><td>${safeText(balance.customerLabel)}</td>` +
        `<td data-field="state">${safeText(balance.stateLabel)} ` +
        `(${safeText(String(balance.sessionsRedeemed))} of ${safeText(String(balance.sessionsTotal))})</td>` +
        `<td class="money">${safeText(balance.releasedLabel)}</td>` +
        `<td class="money">${safeText(balance.unreleasedLabel)}</td>` +
        `<td>${safeText(balance.expiresOn)}${balance.expired ? ' — out of validity' : ''}</td></tr>`,
    ),
    '</tbody></table>',
    '<p>An expired balance stays on this list and stays redeemable-looking on purpose: under the provisional policy the unredeemed balance is RETAINED, so the customer is still owed the treatments and the desk has to be able to see the thing it has to explain. The redemption itself is refused, by the service and again in SQL.</p>',
  ].join('')
}

function sellForm(view: PackageView): string {
  if (view.templates.length === 0 || view.customers.length === 0) return ''
  return [
    `<form method="post" data-testid="packages-sell-form" ${attribute('action', view.action)}>`,
    hidden(PACKAGE_FIELDS.step, 'sell'),
    hidden(PACKAGE_FIELDS.day, view.tradingDate),
    hidden(PACKAGE_FIELDS.direction, view.direction),
    '<fieldset>',
    '<legend>Sell a package</legend>',
    '<label class="field" for="packages-template">',
    '<span class="label">Package</span>',
    `<select ${attribute('id', 'packages-template')} data-testid="packages-template" ` +
      `${attribute('name', PACKAGE_FIELDS.template)} autofocus>`,
    ...view.templates.map(
      (template) =>
        `<option ${attribute('value', template.templateKey)}${template.chosen ? ' selected' : ''}>` +
        `${safeText(template.publicDisplayName)} — ${safeText(template.priceLabel)}</option>`,
    ),
    '</select>',
    '</label>',
    '<label class="field" for="packages-customer">',
    '<span class="label">Customer</span>',
    `<select ${attribute('id', 'packages-customer')} data-testid="packages-customer" ` +
      `${attribute('name', PACKAGE_FIELDS.customer)}>`,
    ...view.customers.map(
      (customer) =>
        `<option ${attribute('value', customer.customerId)}>${safeText(customer.label)}</option>`,
    ),
    '</select>',
    '<span class="hint">A package is an entitlement somebody walks in and uses, so it is always attached to a record — unlike a counter sale, which may have none.</span>',
    '</label>',
    '<label class="field" for="packages-cash">',
    '<span class="label">Cash <span>(in fils)</span></span>',
    `<input type="text" inputmode="numeric" ${attribute('id', 'packages-cash')} ` +
      `data-testid="packages-cash" ${attribute('name', PACKAGE_FIELDS.cash)} value="">`,
    '</label>',
    '<label class="field" for="packages-card">',
    '<span class="label">Card <span>(in fils)</span></span>',
    `<input type="text" inputmode="numeric" ${attribute('id', 'packages-card')} ` +
      `data-testid="packages-card" ${attribute('name', PACKAGE_FIELDS.card)} value="">`,
    '</label>',
    '<label class="field" for="packages-card-ref">',
    '<span class="label">Card reference</span>',
    `<input type="text" ${attribute('id', 'packages-card-ref')} ` +
      `${attribute('name', PACKAGE_FIELDS.cardRef)} value="">`,
    '</label>',
    '<span class="hint">The tenders have to add up to the price EXACTLY. An invoice may be part paid; a package may not — a part payment would credit 2050 with a liability the salon was never paid for (ZG012).</span>',
    '</fieldset>',
    '<button type="submit" data-testid="packages-sell">Take the money and open the balance</button>',
    '</form>',
  ].join('')
}

function redeemForm(view: PackageView): string {
  if (view.balances.length === 0 || view.appointments.length === 0) {
    return [
      '<div class="panel" data-testid="packages-redeem-unavailable">',
      '<h2>Redeem a session</h2>',
      `<p>${
        view.balances.length === 0
          ? 'No entitlement is outstanding, so there is nothing to draw against.'
          : 'No delivered treatment on this business day is still unsettled, so there is nothing to draw it against.'
      }</p>`,
      '</div>',
    ].join('')
  }
  return [
    `<form method="post" data-testid="packages-redeem-form" ${attribute('action', view.action)}>`,
    hidden(PACKAGE_FIELDS.step, 'redeem'),
    hidden(PACKAGE_FIELDS.day, view.tradingDate),
    hidden(PACKAGE_FIELDS.direction, view.direction),
    '<fieldset>',
    '<legend>Redeem a session</legend>',
    '<label class="field" for="packages-balance">',
    '<span class="label">Entitlement</span>',
    `<select ${attribute('id', 'packages-balance')} data-testid="packages-balance" ` +
      `${attribute('name', PACKAGE_FIELDS.balance)}>`,
    ...view.balances.map(
      (balance) =>
        `<option ${attribute('value', balance.balanceId)}>${safeText(balance.label)} — ` +
        `${safeText(balance.customerLabel)}, ${safeText(balance.stateLabel)}</option>`,
    ),
    '</select>',
    '</label>',
    '<label class="field" for="packages-appointment">',
    '<span class="label">Treatment delivered</span>',
    `<select ${attribute('id', 'packages-appointment')} data-testid="packages-appointment" ` +
      `${attribute('name', PACKAGE_FIELDS.appointment)}>`,
    ...view.appointments.map(
      (appointment) =>
        `<option ${attribute('value', appointment.appointmentId)}>${safeText(appointment.label)}</option>`,
    ),
    '</select>',
    '<span class="hint">One appointment, one settlement: an appointment cannot be both redeemed and invoiced for cash, which is a trigger on each of the two tables because whichever row arrives second has to be the one refused (ZG011).</span>',
    '</label>',
    '<label class="field" for="packages-units">',
    '<span class="label">Sessions consumed</span>',
    `<input type="text" inputmode="numeric" ${attribute('id', 'packages-units')} ` +
      `data-testid="packages-units" ${attribute('name', PACKAGE_FIELDS.units)} value="1">`,
    '</label>',
    '</fieldset>',
    '<button type="submit" data-testid="packages-redeem">Draw the session down</button>',
    '</form>',
  ].join('')
}

function entryPanel(
  testid: string,
  heading: string,
  lines: readonly { accountCode: string; debitLabel: string; creditLabel: string }[],
): string {
  if (lines.length === 0) return ''
  return [
    `<h2>${safeText(heading)}</h2>`,
    `<table ${attribute('data-testid', testid)}>`,
    '<thead><tr><th scope="col">Account</th><th scope="col" class="money">Debit</th>' +
      '<th scope="col" class="money">Credit</th></tr></thead>',
    '<tbody>',
    ...lines.map(
      (line) =>
        `<tr ${attribute('data-account', line.accountCode)}>` +
        `<td><code>${safeText(line.accountCode)}</code></td>` +
        `<td class="money">${safeText(line.debitLabel)}</td>` +
        `<td class="money">${safeText(line.creditLabel)}</td></tr>`,
    ),
    '</tbody></table>',
  ].join('')
}

export function renderPackagesHtml(view: PackageView): string {
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}" data-till-screen="packages"` +
      `${view.refusal === null ? '' : ' data-packages-refused="1"'}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<title>Packages — admin</title>',
    `<style>${tokensCss()}${TILL_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Packages</h1>',
    nav(view),
    '<div class="lede">',
    `<p><strong>Business day ${safeText(view.tradingDate)}</strong></p>`,
    '<p data-testid="packages-lede">A sale takes the money and recognises nothing: the whole consideration sits in 2050 as a liability. A redemption is the supply — it releases the balance, recognises the revenue on 4020 and puts the tax on 2030, which is where output VAT reaches box 1.</p>',
    '</div>',
    `<p class="live" role="status" aria-live="polite" data-testid="packages-live">${safeText(view.announcement)}</p>`,
    view.refusal === null
      ? ''
      : `<div class="notice" data-testid="packages-refusal"><p>${safeText(view.refusal)}</p></div>`,
    '<div class="notice" data-testid="packages-document-obligation">',
    '<h2>A document is owed at redemption, and cannot be issued</h2>',
    `<p>${safeText(view.documentObligation.sentence)}</p>`,
    `<p>Waiting on ${view.documentObligation.openQuestionIds
      .map((id) => `<code>${safeText(id)}</code>`)
      .join(' and ')}.</p>`,
    '</div>',
    '<div class="desk">',
    '<div class="entry">',
    sellForm(view),
    redeemForm(view),
    '</div>',
    '<div class="totals" data-testid="till-total-column">',
    templatesPanel(view),
    balancesPanel(view),
    view.sold === null
      ? ''
      : `<div class="issued" data-testid="packages-sold"><h2>Sold</h2><dl>` +
        `<dt>Price</dt><dd data-field="price">${safeText(view.sold.priceLabel)}</dd>` +
        `<dt>Valid until</dt><dd data-field="expires">${safeText(view.sold.expiresOn)}</dd>` +
        '</dl></div>',
    view.sold === null
      ? ''
      : entryPanel('packages-sale-posting', 'The entry the sale posted', view.sold.entryLines),
    view.redeemed === null
      ? ''
      : `<div class="issued" data-testid="packages-redeemed"><h2>Redeemed</h2><dl>` +
        `<dt>Released</dt><dd data-field="released">${safeText(view.redeemed.releasedLabel)}</dd>` +
        `<dt>Net</dt><dd data-field="net">${safeText(view.redeemed.netLabel)}</dd>` +
        `<dt>VAT</dt><dd data-field="vat">${safeText(view.redeemed.vatLabel)}</dd>` +
        `<dt>Drawn down</dt><dd data-field="drawn">${safeText(String(view.redeemed.sessionsRedeemed))} of ` +
        `${safeText(String(view.redeemed.sessionsTotal))}</dd>` +
        '</dl></div>',
    view.redeemed === null
      ? ''
      : entryPanel(
          'packages-redemption-posting',
          'The entry the redemption posted',
          view.redeemed.entryLines,
        ),
    '</div>',
    '</div>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n')
}
