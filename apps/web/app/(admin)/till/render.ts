import { DISCOUNT_REASONS, safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'
import { inlineScriptTag } from '../../../src/security/inline-script.ts'
import {
  TILL_FIELDS,
  TILL_TENDER_FIELDS,
  type TillBasketView,
  type TillMandatoryField,
  type TillPostingView,
  type TillView,
} from './view.ts'

/**
 * The till screen, as HTML (M-TILL-13).
 *
 * Pure: a view in, a document out. No database, no clock — every figure on the page is a function of the view
 * it is given, which is what lets `apps/web/src/till-render.test.ts` assert the screen without a server and
 * what makes two renders of one view byte-identical, which is what makes the screenshots diffable.
 *
 * ## Why a route handler and not a page
 *
 * The reason the diary, the pipeline board, the Messages inbox, the template editor, the compliance calendar,
 * the duplicate queue and quick-book all give: `apps/web/src/routes/registry.ts` is in exact bijection with
 * the filesystem and requires every *document* to be served in both locales, so a `page.tsx` here would need
 * an Arabic admin document and the W-SYS-01 shell, and would join a screenshot matrix whose RTL half has to
 * be a real Arabic route. `?dir=rtl` re-renders this English document mirrored, which is a layout axis rather
 * than a locale. **Not authenticated**, exactly as every route under `/calendar`, `/crm`, `/compliance`,
 * `/hr`, `/clients` and `/settings` records.
 *
 * ## The four things the markup has to get right
 *
 * **The keypad and the total column are laid out with LOGICAL properties, so `dir=rtl` really mirrors them.**
 * The acceptance line is that the RTL till is "genuinely mirrored: the numeric keypad and the total column
 * change side, not merely that the text is translated". That is made true by `grid-template-columns` on a
 * container whose writing direction the document sets — the browser places grid tracks in the inline
 * direction — plus `padding-inline`/`border-inline-start` everywhere and not one `left` or `right`. The itest
 * reads both elements' `getBoundingClientRect().x` in both directions and asserts the order flips; a
 * stylesheet using physical sides would pass every text assertion and fail that one.
 *
 * **TWO forms, and the split is what makes the keyboard count small.** A form's implicit submission takes its
 * FIRST submit button, so one form with a *Price* button and an *Issue* button means a stray Enter in the
 * tender field prices instead of issuing — or, with the order reversed, Enter in the basket issues a document
 * nobody has checked. Split, each form has exactly one submit button, so Enter always does the one thing that
 * form is for. The tender form carries the basket as hidden fields, which is also what makes the back button
 * and a second tab show the same basket.
 *
 * **Nothing is pointer-only and no `<script>` is required for any of it.** Every control is an `<input>`, a
 * `<select>` or a `<button type="submit">` inside a `<form method="post">`. The keypad's keys are
 * `type="button"` and the amount fields are ordinary text inputs, so with JavaScript off the operator types
 * the figures and the page is correct; the keypad is an affordance for a tablet, not the only way in.
 *
 * **No body text sits on `--color-surface-clay`, `--color-decor-gold` or `--color-decor-tan`.** Those three
 * are decorative surfaces — `decor-gold` measures 2.90:1 against ink — and docs/08 fences them off from copy.
 * This file uses `--color-surface`, `--color-ground` and `--color-surface-sand` for anything with words on
 * it, and the three forbidden tokens appear nowhere in it at all. Asserted twice: as a string scan of
 * {@link TILL_CSS} in `till-render.test.ts`, and over the COMPUTED background of every text node in the
 * rendered DOM in `till.itest.ts`, which is the half that catches a colour arriving from `tokensCss()` or
 * from the banner.
 */

/**
 * The page's own styles. Colours are tokens only; there is no literal in this file (`pnpm colours`).
 *
 * Exported so `till-render.test.ts` can assert that sentence about THIS string rather than about the whole
 * document — the document also embeds `tokensCss()`, which is the token layer and is where the hex literals
 * legitimately live, so a scan of the rendered page would fail for the one reason that is correct.
 */
export const TILL_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 74rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.0625rem; line-height: 1.3; margin: 0 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); max-width: 46rem; }
  .lede, .panel, .notice, .issued, .keypad, .totals, .entry {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-6);
  }
  .lede { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-accent-gold); }
  .lede p:last-child, .panel p:last-child, .notice p:last-child, .keypad p:last-child { margin-bottom: 0; }
  .live {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-3) var(--space-5);
    margin: 0 0 var(--space-5);
    min-height: 48px;
    display: flex;
    align-items: center;
  }
  nav ul {
    list-style: none;
    margin: 0 0 var(--space-6);
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-5);
  }
  nav a { color: var(--color-ink); }
  /*
    The desk. One column on a phone, two from 768 up — and the tracks are placed in the INLINE direction,
    which is what makes dir=rtl put the totals on the other side without a second stylesheet.
  */
  .desk { display: grid; gap: var(--space-6); grid-template-columns: 1fr; }
  @media (min-width: 768px) { .desk { grid-template-columns: 3fr 2fr; } }
  .field { display: block; margin: 0 0 var(--space-5); }
  .field > span.label { display: block; font-weight: 600; margin-bottom: var(--space-2); }
  .field > span.hint { display: block; margin-top: var(--space-2); }
  /*
    2.75rem is the touch-target floor the rest of the product holds to. It matters more here than on a
    marketing page: this is a screen somebody uses a hundred times a shift, standing up, often on a tablet.
  */
  input[type="text"], select {
    width: 100%;
    min-height: 2.75rem;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-ground);
    color: var(--color-ink);
    font: inherit;
  }
  fieldset {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-1);
    margin: 0 0 var(--space-5);
    padding: var(--space-4) var(--space-5);
  }
  legend { font-weight: 600; padding: 0 var(--space-2); }
  .choice { display: flex; align-items: flex-start; gap: var(--space-3); min-height: 2.75rem; }
  button {
    min-height: 2.75rem;
    padding: var(--space-2) var(--space-6);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    color: var(--color-ink);
    font: inherit;
    font-weight: 600;
  }
  /*
    A visible focus ring, stated rather than left to the user agent. A keyboard-only screen whose focus is
    invisible is a screen nobody can use with a keyboard, whatever the tab order says.
  */
  :where(input, select, button, a):focus-visible {
    outline: var(--space-1) solid var(--color-accent-gold);
    outline-offset: var(--space-1);
  }
  .keypad-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); }
  .keypad-grid button { width: 100%; padding: var(--space-3) var(--space-2); }
  .notice { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-ink); }
  .issued { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-accent-gold); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td {
    text-align: start;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-hairline);
  }
  td.money, th.money { text-align: end; font-variant-numeric: tabular-nums; }
  tr.total td, tr.total th { font-weight: 700; }
  code { font-family: ui-monospace, monospace; }
  .absent { font-style: italic; }
  .provisional { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-border); }
`

/**
 * Fills the amount field the operator is on, and nothing else.
 *
 * The page is CORRECT without this script: the tender amounts are ordinary text inputs and a keyboard types
 * into them. What the keypad buys is a tablet at a standing desk.
 *
 * It appends to `value` and never rebuilds the field, and it re-focuses the input it wrote into. A DOM move
 * blurs the node it moves (`append` and `insertBefore` remove first), so a keypad that re-created the input
 * would throw the operator's focus away on every digit — the failure C-AUTO-08 found the hard way. The target
 * is the LAST focused amount field rather than `document.activeElement`, because pressing a keypad button
 * moves focus to the button.
 */
const TILL_SCRIPT = `
  var form = document.querySelector('[data-testid="till-tender-form"]')
  var pad = document.querySelector('[data-testid="till-keypad"]')
  if (form !== null && pad !== null) {
    var amounts = form.querySelectorAll('[data-amount="1"]')
    var target = amounts.length > 0 ? amounts[0] : null
    for (var i = 0; i < amounts.length; i += 1) {
      amounts[i].addEventListener('focus', function (event) { target = event.target })
    }
    pad.addEventListener('click', function (event) {
      var node = event.target
      var key = node !== null && node.getAttribute ? node.getAttribute('data-key') : null
      if (key === null || target === null) return
      if (key === 'clear') target.value = ''
      else if (key === 'back') target.value = target.value.slice(0, -1)
      else target.value = target.value + key
      /*
        Focus is restored explicitly. Clicking a button focuses the button, and a keypad that left it there
        would make the next digit go nowhere and read exactly like a dead key.
      */
      target.focus()
      pad.dataset.keypadLast = key
    })
  }
`

const attribute = (name: string, value: string): string => `${name}="${safeText(value)}"`

const hidden = (name: string, value: string): string =>
  `<input type="hidden" ${attribute('name', name)} ${attribute('value', value)}>`

/** The navigation between the four till surfaces. Named links, so the walkthrough is a walk. */
function tillNav(view: TillView): string {
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

/**
 * The basket form: which treatments, the gratuity, and the discount that must say why.
 *
 * `autofocus` lands on the first appointment ONLY while the basket is empty. Two `autofocus` attributes in one
 * document are not two focuses: the browser takes the first in DOM order, so leaving it on the checkbox once
 * the tender form exists would put the operator back at the top of the screen after every price — and the
 * twelve-interaction walk would spend its budget on Tab. Focus follows the next thing the operator needs.
 */
function basketForm(view: TillView): string {
  const rows =
    view.billable.length === 0
      ? [
          '<p data-testid="till-billable-empty">Nothing delivered on this day is still unbilled.</p>',
        ]
      : view.billable.map((row, index) => {
          const id = `till-appointment-${index + 1}`
          return (
            `<div class="choice" ${attribute('data-appointment', row.appointmentId)}>` +
            `<input type="checkbox" ${attribute('id', id)} ${attribute('name', TILL_FIELDS.appointment)} ` +
            `${attribute('value', row.appointmentId)}${row.inBasket ? ' checked' : ''}` +
            `${index === 0 && view.basket === null ? ' autofocus' : ''}>` +
            `<label ${attribute('for', id)}>${safeText(row.description)} — ` +
            `<strong>${safeText(row.grossLabel)}</strong>, ${safeText(row.startLabel)}, ` +
            `${safeText(row.customerLabel)}</label>` +
            '</div>'
          )
        })
  return [
    `<form method="post" data-testid="till-basket-form" ${attribute('action', view.action)}>`,
    hidden(TILL_FIELDS.step, 'price'),
    hidden(TILL_FIELDS.day, view.form.day),
    hidden(TILL_FIELDS.direction, view.direction),
    hidden(TILL_FIELDS.view, view.screen),
    '<fieldset data-testid="till-billable">',
    '<legend>Completed treatments waiting to be billed</legend>',
    ...rows,
    '</fieldset>',
    '<label class="field" for="till-tip">',
    '<span class="label">Gratuity <span>(optional, in fils)</span></span>',
    `<input type="text" inputmode="numeric" ${attribute('id', 'till-tip')} data-testid="till-tip" ` +
      `${attribute('name', TILL_FIELDS.tip)} ${attribute('value', view.form.tip)}>`,
    '<span class="hint">Outside the scope of VAT and on no tax invoice: a gratuity is not consideration for a supply.</span>',
    '</label>',
    '<label class="field" for="till-discount">',
    '<span class="label">Discount <span>(optional, in fils)</span></span>',
    `<input type="text" inputmode="numeric" ${attribute('id', 'till-discount')} ` +
      `data-testid="till-discount" ${attribute('name', TILL_FIELDS.discount)} ` +
      `${attribute('value', view.form.discount)}>`,
    '</label>',
    '<label class="field" for="till-discount-reason">',
    '<span class="label">Why the discount was given</span>',
    `<select ${attribute('id', 'till-discount-reason')} data-testid="till-discount-reason" ` +
      `${attribute('name', TILL_FIELDS.discountReason)}>`,
    `<option value=""${view.form.discountReason === '' ? ' selected' : ''}>Not given</option>`,
    ...DISCOUNT_REASONS.map(
      (reason) =>
        `<option ${attribute('value', reason)}` +
        `${reason === view.form.discountReason ? ' selected' : ''}>` +
        `${safeText(reason.replace(/_/g, ' '))}</option>`,
    ),
    '</select>',
    '<span class="hint">A discount with no reason is refused: 4095 is a contra-revenue account and an unexplained credit to it is what an audit asks about.</span>',
    '</label>',
    `<button type="submit" data-testid="till-price">Price the basket</button>`,
    '</form>',
  ].join('')
}

/**
 * The tender form: up to three forms of payment, and the one button that takes the money.
 *
 * Rendered only when the basket has something in it. A *Take payment* button above an empty basket is a
 * control known to fail, which is the reasoning B-UI-01's therapist selector and quick-book's override form
 * both record.
 */
function tenderForm(view: TillView): string {
  if (view.basket === null) return ''
  const amountOf = (field: string): string =>
    field === TILL_FIELDS.cash
      ? view.form.cash
      : field === TILL_FIELDS.card
        ? view.form.card
        : view.form.bank
  const referenceOf = (field: string | null): string =>
    field === TILL_FIELDS.cardRef ? view.form.cardRef : field === null ? '' : view.form.bankRef
  return [
    `<form method="post" data-testid="till-tender-form" ${attribute('action', view.action)}>`,
    hidden(TILL_FIELDS.step, 'issue'),
    hidden(TILL_FIELDS.day, view.form.day),
    hidden(TILL_FIELDS.direction, view.direction),
    hidden(TILL_FIELDS.view, view.screen),
    ...view.form.appointments.map((id) => hidden(TILL_FIELDS.appointment, id)),
    hidden(TILL_FIELDS.tip, view.form.tip),
    hidden(TILL_FIELDS.discount, view.form.discount),
    hidden(TILL_FIELDS.discountReason, view.form.discountReason),
    '<fieldset data-testid="till-tender">',
    `<legend>Tender — ${safeText(view.basket.dueLabel)} due</legend>`,
    ...TILL_TENDER_FIELDS.flatMap((tender, index) => {
      const id = `till-tender-${tender.kind}`
      const rows = [
        `<label class="field" ${attribute('for', id)}>`,
        `<span class="label">${safeText(tender.label)} <span>(in fils)</span></span>`,
        `<input type="text" inputmode="numeric" data-amount="1" ${attribute('id', id)} ` +
          `${attribute('data-testid', `till-amount-${tender.kind}`)} ` +
          `${attribute('name', tender.field)} ${attribute('value', amountOf(tender.field))}` +
          `${index === 0 ? ' autofocus' : ''}>`,
        '</label>',
      ]
      if (tender.referenceField !== null) {
        const referenceId = `${id}-reference`
        rows.push(
          `<label class="field" ${attribute('for', referenceId)}>`,
          `<span class="label">${safeText(tender.label)} reference</span>`,
          `<input type="text" ${attribute('id', referenceId)} ` +
            `${attribute('name', tender.referenceField)} ` +
            `${attribute('value', referenceOf(tender.referenceField))}>`,
          '</label>',
        )
      }
      return rows
    }),
    '</fieldset>',
    '<button type="submit" data-testid="till-issue">Take payment and issue</button>',
    '</form>',
  ].join('')
}

/** The numeric keypad. Buttons, not a widget: each one is a real control with a real accessible name. */
function keypad(view: TillView): string {
  if (view.basket === null) return ''
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '0', '00']
  return [
    '<div class="keypad" data-testid="till-keypad">',
    '<h2 id="till-keypad-heading">Keypad</h2>',
    '<div class="keypad-grid" role="group" aria-labelledby="till-keypad-heading">',
    ...keys.map(
      (key) => `<button type="button" ${attribute('data-key', key)}>${safeText(key)}</button>`,
    ),
    // The literal ERASE TO THE LEFT character, escaped, and NOT an HTML numeric character reference.
    // `pnpm colours` reads the digits of such a reference as a four-digit hex colour and refuses it by name —
    // correctly, because it cannot tell the two apart, and a keypad is exactly where an untokened colour
    // would hide. This form names the same glyph and renders identically. (This comment is worded to avoid
    // the pattern too: the scanner reads comments.)
    `<button type="button" ${attribute('data-key', 'back')} aria-label="Delete the last digit">\u232b</button>`,
    `<button type="button" ${attribute('data-key', 'clear')} aria-label="Clear the amount">Clear</button>`,
    '</div>',
    '<p>Fills the amount last used. Typing into the field does the same thing.</p>',
    '</div>',
  ].join('')
}

/** The basket, priced, and what is still outstanding. */
function basketPanel(basket: TillBasketView | null): string {
  if (basket === null) return '<p data-testid="till-basket-empty">The basket is empty.</p>'
  return [
    '<h2>Basket</h2>',
    '<table data-testid="till-basket">',
    '<thead><tr><th scope="col">Line</th><th scope="col" class="money">Gross</th></tr></thead>',
    '<tbody>',
    ...basket.lines.map(
      (line) =>
        `<tr ${attribute('data-line-kind', line.kind)}><td>${safeText(line.description)}` +
        (line.reason === null ? '' : ` <code>${safeText(line.reason)}</code>`) +
        `</td><td class="money">${safeText(line.grossLabel)}</td></tr>`,
    ),
    '</tbody>',
    '</table>',
    '<dl data-testid="till-totals">',
    `<dt>Net</dt><dd data-field="net">${safeText(basket.netLabel)}</dd>`,
    `<dt>VAT</dt><dd data-field="vat">${safeText(basket.vatLabel)}</dd>`,
    `<dt>Document total</dt><dd data-field="document-gross">${safeText(basket.documentGrossLabel)}</dd>`,
    `<dt>Gratuity</dt><dd data-field="tip">${safeText(basket.tipLabel)}</dd>`,
    `<dt>Due</dt><dd data-field="due">${safeText(basket.dueLabel)}</dd>`,
    `<dt>Tendered</dt><dd data-field="tendered">${safeText(basket.tenderedLabel)}</dd>`,
    `<dt>Outstanding</dt><dd data-field="outstanding">${safeText(basket.outstandingLabel)}</dd>`,
    '</dl>',
  ].join('')
}

/** The entry the basket would post, with its own difference shown rather than asserted. */
function postingPanel(posting: TillPostingView | null): string {
  if (posting === null) return ''
  return [
    '<h2>The entry this would post</h2>',
    `<table data-testid="till-posting" ${attribute('data-balanced', posting.balanced ? '1' : '0')}>`,
    '<thead><tr><th scope="col">Account</th><th scope="col">Memo</th>' +
      '<th scope="col" class="money">Debit</th><th scope="col" class="money">Credit</th></tr></thead>',
    '<tbody>',
    ...posting.lines.map(
      (line) =>
        `<tr ${attribute('data-account', line.accountCode)}>` +
        `<td><code>${safeText(line.accountCode)}</code></td><td>${safeText(line.memo)}</td>` +
        `<td class="money">${safeText(line.debitLabel)}</td>` +
        `<td class="money">${safeText(line.creditLabel)}</td></tr>`,
    ),
    '<tr class="total"><th scope="row" colspan="2">Totals</th>' +
      `<td class="money" data-field="debit-total">${safeText(posting.debitTotalLabel)}</td>` +
      `<td class="money" data-field="credit-total">${safeText(posting.creditTotalLabel)}</td></tr>`,
    '<tr class="total"><th scope="row" colspan="3">Difference</th>' +
      `<td class="money" data-field="difference">${safeText(posting.differenceLabel)}</td></tr>`,
    '</tbody>',
    '</table>',
  ].join('')
}

/** The mandatory field list, with every absence marked and named. Shown on the preview screen. */
function mandatoryPanel(fields: readonly TillMandatoryField[]): string {
  if (fields.length === 0) return ''
  return [
    '<div class="panel" data-testid="till-mandatory">',
    '<h2>What the document has to state</h2>',
    '<table>',
    '<thead><tr><th scope="col">Field</th><th scope="col">Value</th>' +
      '<th scope="col">Waiting on</th></tr></thead>',
    '<tbody>',
    ...fields.map(
      (field) =>
        `<tr ${attribute('data-field-key', field.key)}` +
        `${field.value === null ? ' data-absent="1"' : ''}>` +
        `<td>${safeText(field.label)}</td>` +
        `<td>${
          field.value === null
            ? '<span class="absent">not stated — the system holds no value</span>'
            : safeText(field.value)
        }</td>` +
        `<td>${field.openQuestionId === null ? '' : `<code>${safeText(field.openQuestionId)}</code>`}</td>` +
        '</tr>',
    ),
    '</tbody></table>',
    '</div>',
  ].join('')
}

/** The provisional values this screen stands on, named, with their question ids. */
function assumptionsPanel(view: TillView): string {
  if (view.assumptions.length === 0) return ''
  return [
    '<div class="panel provisional" data-testid="till-assumptions">',
    '<h2>Unconfirmed, and assumed</h2>',
    '<table>',
    '<thead><tr><th scope="col">Assumption</th><th scope="col">Question</th></tr></thead>',
    '<tbody>',
    ...view.assumptions.map(
      (row) =>
        `<tr ${attribute('data-question', row.openQuestionId)}><td>${safeText(row.what)}</td>` +
        `<td><code>${safeText(row.openQuestionId)}</code></td></tr>`,
    ),
    '</tbody></table>',
    '</div>',
  ].join('')
}

function issuerPanel(view: TillView): string {
  return [
    '<div class="panel" data-testid="till-issuer">',
    '<h2>Issued by</h2>',
    '<dl>',
    `<dt>Legal name</dt><dd data-field="legal-name">${safeText(view.issuer.legalName)}</dd>`,
    `<dt>Trading name</dt><dd data-field="trading-name">${safeText(view.issuer.tradingName)}</dd>`,
    `<dt>Address</dt><dd data-field="address">${safeText(view.issuer.addressLabel)}</dd>`,
    `<dt>TRN</dt><dd data-field="trn"${view.issuer.trn === null ? ' data-absent="1"' : ''}>${
      view.issuer.trn === null
        ? '<span class="absent">not entered</span> <code>Y1-trn</code>'
        : safeText(view.issuer.trn)
    }</dd>`,
    '</dl>',
    '</div>',
  ].join('')
}

export function renderTillHtml(view: TillView): string {
  const refused = view.refusal
  const issued = view.issued
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}"` +
      `${refused === null ? '' : ` data-till-refusal="${safeText(refused.code)}"`}` +
      ` data-till-screen="${safeText(view.screen)}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: `apps/web/src/seo/brand.test.ts` requires the full trading name wherever the
    // brand appears, and an internal screen naming it would be citing the wrong entity. The rule is about
    // how the brand is written, so not writing it is compliant.
    `<title>${view.screen === 'preview' ? 'Invoice preview' : 'Till'} — admin</title>`,
    `<style>${tokensCss()}${TILL_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    `<h1>${view.screen === 'preview' ? 'Invoice preview' : 'Till'}</h1>`,
    tillNav(view),
    '<div class="lede">',
    `<p><strong>${safeText(view.dayLabel)}</strong></p>`,
    `<p data-testid="till-lede">${safeText(view.lede)}</p>`,
    '</div>',
    // `role="status"` with `aria-live="polite"`: on this screen every outcome arrives as a new document, so
    // the live region is what a screen-reader user hears instead of being told to go and look for it.
    `<p class="live" role="status" aria-live="polite" data-testid="till-live">${safeText(view.announcement)}</p>`,
    refused === null
      ? ''
      : `<div class="notice" data-testid="till-refusal" ${attribute('data-refusal', refused.code)}>` +
        `<p>${safeText(refused.sentence)}</p>` +
        (refused.openQuestionId === null
          ? ''
          : `<p>Waiting on <code data-testid="till-refusal-question">${safeText(refused.openQuestionId)}</code>.</p>`) +
        '</div>',
    issued === null
      ? ''
      : '<div class="issued" data-testid="till-issued">' +
        '<h2>Issued</h2><dl>' +
        `<dt>Document</dt><dd data-field="number">${safeText(issued.displayNumber)}</dd>` +
        `<dt>Form</dt><dd data-field="kind">${safeText(issued.documentKind)}</dd>` +
        `<dt>Series</dt><dd data-field="series">${safeText(issued.seriesCode)}</dd>` +
        `<dt>Total</dt><dd data-field="gross">${safeText(issued.grossLabel)}</dd>` +
        `<dt>Tendered</dt><dd data-field="tenders">${safeText(issued.tenderLabels.join(', '))}</dd>` +
        '</dl></div>',
    '<div class="desk">',
    '<div class="entry">',
    basketForm(view),
    tenderForm(view),
    keypad(view),
    '</div>',
    '<div class="totals" data-testid="till-total-column">',
    basketPanel(view.basket),
    postingPanel(view.posting),
    '</div>',
    '</div>',
    view.screen === 'preview' ? mandatoryPanel(view.mandatory) : '',
    issuerPanel(view),
    assumptionsPanel(view),
    '</main>',
    inlineScriptTag(view.chrome.cspNonce, TILL_SCRIPT),
    '</body>',
    '</html>',
  ].join('\n')
}
