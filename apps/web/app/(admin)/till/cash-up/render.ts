import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import type { AdminChrome } from '../../../../src/components/admin/google-reauth-banner.ts'
import {
  ADMIN_BANNER_CSS,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'
import { TILL_CSS } from '../render.ts'

/**
 * The cash-up screen, as HTML (M-TILL-13).
 *
 * Pure: a view in, a document out. It shares {@link TILL_CSS} with the till rather than declaring its own
 * stylesheet, which is not tidiness — the palette rule ("no body text on `--color-surface-clay`,
 * `--color-decor-gold` or `--color-decor-tan`") and the touch-target floor then hold for all three till
 * surfaces because there is one place they can be broken, and the itest's DOM scan proves it once for a
 * stylesheet three screens share.
 *
 * ## What this screen refuses to do, and why that is the design
 *
 * It never lets a close absorb a variance. The count is a MEASUREMENT of the physical world and the
 * expectation is a derivation from rows; when they differ the measurement is the fact, so the close is
 * RECORDED with a reason and a posting to 6140 and never refused — M-TILL-11's argument, and ZU004 is that
 * rule as a deferred constraint trigger. What the screen does is make the reason field mandatory in front of
 * the operator, so the refusal arrives before the transaction rather than out of a trigger.
 *
 * A closed session cannot be reopened and there is no control that offers to: correcting a counted drawer is
 * a new dated adjustment (`postCashSessionAdjustment`), which is a separate form.
 */

export const CASH_UP_FIELDS = {
  step: 's',
  day: 'day',
  drawer: 'drawer',
  session: 'session',
  float: 'float',
  counted: 'counted',
  note: 'note',
  dropAmount: 'drop',
  dropDestination: 'dest',
  dropReason: 'dropwhy',
  direction: 'dir',
} as const

export const CASH_UP_STEPS = ['open', 'drop', 'close'] as const
export type CashUpStep = (typeof CASH_UP_STEPS)[number]

export interface CashUpTakingsView {
  readonly openingFloatLabel: string
  readonly cashReceivedLabel: string
  readonly changeGivenLabel: string
  readonly cashRefundedLabel: string
  readonly dropsLabel: string
  readonly expectedLabel: string
}

export interface CashUpSessionView {
  readonly sessionId: string
  readonly drawerCode: string
  readonly tradingDate: string
  readonly shiftNo: number
  readonly status: 'open' | 'closed'
  readonly openingFloatLabel: string
  readonly countedLabel: string | null
  readonly expectedLabel: string | null
  readonly discrepancyLabel: string | null
  readonly direction: 'balanced' | 'over' | 'short' | null
  readonly countNote: string | null
}

export interface CashUpDrawerView {
  readonly code: string
  readonly label: string
  readonly postingAccountCode: string
  readonly chosen: boolean
}

export interface CashUpView {
  readonly direction: 'ltr' | 'rtl'
  readonly chrome: AdminChrome
  readonly action: string
  readonly tillHref: string
  readonly previewHref: string
  readonly cashUpHref: string
  readonly packagesHref: string
  readonly tradingDate: string
  /**
   * The day's own opening and closing time, read off the `business_day` row.
   *
   * Carried rather than written into the template: `premises_hours` is where the hours live, and
   * `premises.test.ts` refuses a literal opening or closing time anywhere in `apps/web` — because a surface
   * with them typed in goes on showing them after the owner has changed them. It caught this screen's lede.
   */
  readonly hoursLabel: string
  readonly announcement: string
  readonly refusal: string | null
  readonly drawers: readonly CashUpDrawerView[]
  readonly drawerCode: string
  /** The open session for the chosen drawer, or null: then the screen offers to open one. */
  readonly open: CashUpSessionView | null
  readonly takings: CashUpTakingsView | null
  readonly sessions: readonly CashUpSessionView[]
  /** The entry the last close posted, if it posted one. */
  readonly postedLines: readonly { accountCode: string; debitLabel: string; creditLabel: string }[]
}

const attribute = (name: string, value: string): string => `${name}="${safeText(value)}"`

const hidden = (name: string, value: string): string =>
  `<input type="hidden" ${attribute('name', name)} ${attribute('value', value)}>`

function nav(view: CashUpView): string {
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

function openForm(view: CashUpView): string {
  if (view.open !== null) return ''
  return [
    `<form method="post" data-testid="cash-up-open-form" ${attribute('action', view.action)}>`,
    hidden(CASH_UP_FIELDS.step, 'open'),
    hidden(CASH_UP_FIELDS.day, view.tradingDate),
    hidden(CASH_UP_FIELDS.drawer, view.drawerCode),
    hidden(CASH_UP_FIELDS.direction, view.direction),
    '<label class="field" for="cash-up-float">',
    '<span class="label">Opening float <span>(in fils)</span></span>',
    `<input type="text" inputmode="numeric" ${attribute('id', 'cash-up-float')} ` +
      `data-testid="cash-up-float" ${attribute('name', CASH_UP_FIELDS.float)} value="" autofocus>`,
    '<span class="hint">Declared, never derived. The previous close&#39;s counted cash, left in the till.</span>',
    '</label>',
    '<button type="submit" data-testid="cash-up-open">Open the drawer</button>',
    '</form>',
  ].join('')
}

function takingsPanel(view: CashUpView): string {
  const takings = view.takings
  if (takings === null || view.open === null) return ''
  return [
    '<div class="panel" data-testid="cash-up-takings">',
    '<h2>What the rows say the drawer holds</h2>',
    '<dl>',
    `<dt>Opening float</dt><dd data-field="opening">${safeText(takings.openingFloatLabel)}</dd>`,
    `<dt>Cash received</dt><dd data-field="received">${safeText(takings.cashReceivedLabel)}</dd>`,
    `<dt>Change given</dt><dd data-field="change">${safeText(takings.changeGivenLabel)}</dd>`,
    `<dt>Cash refunded</dt><dd data-field="refunded">${safeText(takings.cashRefundedLabel)}</dd>`,
    `<dt>Drops</dt><dd data-field="drops">${safeText(takings.dropsLabel)}</dd>`,
    `<dt>Expected</dt><dd data-field="expected">${safeText(takings.expectedLabel)}</dd>`,
    '</dl>',
    '<p>Cash in and change out are two figures and never one net figure: a cash-up sheet is checked against the till roll in both directions.</p>',
    '</div>',
  ].join('')
}

function closeForm(view: CashUpView): string {
  const open = view.open
  if (open === null) return ''
  return [
    `<form method="post" data-testid="cash-up-close-form" ${attribute('action', view.action)}>`,
    hidden(CASH_UP_FIELDS.step, 'close'),
    hidden(CASH_UP_FIELDS.day, view.tradingDate),
    hidden(CASH_UP_FIELDS.drawer, view.drawerCode),
    hidden(CASH_UP_FIELDS.direction, view.direction),
    hidden(CASH_UP_FIELDS.session, open.sessionId),
    '<label class="field" for="cash-up-counted">',
    '<span class="label">Counted <span>(in fils)</span></span>',
    `<input type="text" inputmode="numeric" ${attribute('id', 'cash-up-counted')} ` +
      `data-testid="cash-up-counted" ${attribute('name', CASH_UP_FIELDS.counted)} value="" autofocus>`,
    '<span class="hint">An empty field is not a count of zero. A close with no count is refused as CountRequired.</span>',
    '</label>',
    '<label class="field" for="cash-up-note">',
    '<span class="label">Why the drawer is out</span>',
    `<input type="text" ${attribute('id', 'cash-up-note')} data-testid="cash-up-note" ` +
      `${attribute('name', CASH_UP_FIELDS.note)} value="">`,
    '<span class="hint">Required whenever the count and the expectation differ. The difference is posted to 6140 in the same transaction as the close — it can never be absorbed.</span>',
    '</label>',
    '<button type="submit" data-testid="cash-up-close">Count and close the shift</button>',
    '</form>',
  ].join('')
}

function dropForm(view: CashUpView): string {
  const open = view.open
  if (open === null) return ''
  return [
    `<form method="post" data-testid="cash-up-drop-form" ${attribute('action', view.action)}>`,
    hidden(CASH_UP_FIELDS.step, 'drop'),
    hidden(CASH_UP_FIELDS.day, view.tradingDate),
    hidden(CASH_UP_FIELDS.drawer, view.drawerCode),
    hidden(CASH_UP_FIELDS.direction, view.direction),
    hidden(CASH_UP_FIELDS.session, open.sessionId),
    '<label class="field" for="cash-up-drop">',
    '<span class="label">Cash out of the drawer <span>(in fils)</span></span>',
    `<input type="text" inputmode="numeric" ${attribute('id', 'cash-up-drop')} ` +
      `data-testid="cash-up-drop" ${attribute('name', CASH_UP_FIELDS.dropAmount)} value="">`,
    '</label>',
    '<label class="field" for="cash-up-drop-destination">',
    '<span class="label">Where it went</span>',
    `<select ${attribute('id', 'cash-up-drop-destination')} data-testid="cash-up-drop-destination" ` +
      `${attribute('name', CASH_UP_FIELDS.dropDestination)}>`,
    '<option value="1020">1020 Bank current — banked</option>',
    '<option value="1015">1015 Petty cash float — the safe</option>',
    '</select>',
    '</label>',
    '<label class="field" for="cash-up-drop-reason">',
    '<span class="label">Why</span>',
    `<input type="text" ${attribute('id', 'cash-up-drop-reason')} ` +
      `${attribute('name', CASH_UP_FIELDS.dropReason)} value="">`,
    '</label>',
    '<button type="submit" data-testid="cash-up-drop-submit">Record the drop</button>',
    '</form>',
  ].join('')
}

function sessionsPanel(view: CashUpView): string {
  if (view.sessions.length === 0) {
    return '<p data-testid="cash-up-sessions-empty">No shift has been counted on this business day.</p>'
  }
  return [
    '<h2>Shifts on this business day</h2>',
    '<table data-testid="cash-up-sessions">',
    '<thead><tr><th scope="col">Drawer</th><th scope="col">Shift</th><th scope="col">Status</th>' +
      '<th scope="col" class="money">Expected</th><th scope="col" class="money">Counted</th>' +
      '<th scope="col" class="money">Out by</th><th scope="col">Reason</th></tr></thead>',
    '<tbody>',
    ...view.sessions.map(
      (session) =>
        `<tr ${attribute('data-session', session.sessionId)} ` +
        `${attribute('data-status', session.status)} ` +
        `${attribute('data-direction', session.direction ?? 'unknown')}>` +
        `<td>${safeText(session.drawerCode)}</td><td>${safeText(String(session.shiftNo))}</td>` +
        `<td>${safeText(session.status)}</td>` +
        `<td class="money">${safeText(session.expectedLabel ?? '')}</td>` +
        `<td class="money">${safeText(session.countedLabel ?? '')}</td>` +
        `<td class="money">${safeText(session.discrepancyLabel ?? '')}</td>` +
        `<td>${safeText(session.countNote ?? '')}</td></tr>`,
    ),
    '</tbody></table>',
  ].join('')
}

function postedPanel(view: CashUpView): string {
  if (view.postedLines.length === 0) return ''
  return [
    '<h2>The entry the close posted</h2>',
    '<table data-testid="cash-up-posting">',
    '<thead><tr><th scope="col">Account</th><th scope="col" class="money">Debit</th>' +
      '<th scope="col" class="money">Credit</th></tr></thead>',
    '<tbody>',
    ...view.postedLines.map(
      (line) =>
        `<tr ${attribute('data-account', line.accountCode)}>` +
        `<td><code>${safeText(line.accountCode)}</code></td>` +
        `<td class="money">${safeText(line.debitLabel)}</td>` +
        `<td class="money">${safeText(line.creditLabel)}</td></tr>`,
    ),
    '</tbody></table>',
  ].join('')
}

export function renderCashUpHtml(view: CashUpView): string {
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}" data-till-screen="cash-up"` +
      `${view.refusal === null ? '' : ' data-cash-up-refused="1"'}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<title>Cash-up — admin</title>',
    `<style>${tokensCss()}${TILL_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Cash-up</h1>',
    nav(view),
    '<div class="lede">',
    `<p><strong>Business day ${safeText(view.tradingDate)}</strong></p>`,
    `<p data-testid="cash-up-lede">Keyed on the business day and never the calendar date: this day trades ` +
      `${safeText(view.hoursLabel)}, so one shift crosses midnight and is one session — a cash payment taken ` +
      'in the small hours belongs to the day before.</p>',
    '</div>',
    `<p class="live" role="status" aria-live="polite" data-testid="cash-up-live">${safeText(view.announcement)}</p>`,
    view.refusal === null
      ? ''
      : `<div class="notice" data-testid="cash-up-refusal"><p>${safeText(view.refusal)}</p></div>`,
    '<div class="desk">',
    '<div class="entry">',
    openForm(view),
    closeForm(view),
    dropForm(view),
    '</div>',
    '<div class="totals" data-testid="till-total-column">',
    takingsPanel(view),
    sessionsPanel(view),
    postedPanel(view),
    '</div>',
    '</div>',
    '</main>',
    '</body>',
    '</html>',
  ].join('\n')
}
