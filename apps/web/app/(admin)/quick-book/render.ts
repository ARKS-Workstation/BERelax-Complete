import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'
import {
  QUICK_BOOK_FIELDS,
  type QuickBookView,
  type RefNotice,
  refNoticeSentence,
  type TherapistRefusalReason,
  therapistRefusalSentence,
} from './view.ts'

/**
 * The quick-book screen, as HTML (B-UI-04).
 *
 * Pure: a view in, a document out. No database, no clock — every figure on the page is a function of the
 * view it is given, which is what lets `apps/web/src/quick-book-render.test.ts` assert the screen without a
 * server and what makes two renders of one view byte-identical.
 *
 * ## Why a route handler and not a page
 *
 * The reason the diary, the pipeline board, the Messages inbox, the template editor, the compliance
 * calendar and the duplicate queue all give: `apps/web/src/routes/registry.ts` is in exact bijection with
 * the filesystem and requires every *document* to be served in both locales, so a `page.tsx` here would
 * need an Arabic admin document and the W-SYS-01 shell, and would join a screenshot matrix whose RTL half
 * has to be a real Arabic route. `?dir=rtl` re-renders this English document mirrored, which is a layout
 * axis rather than a locale. **Not authenticated**, exactly as every route under `/calendar`, `/crm`,
 * `/compliance`, `/hr`, `/clients` and `/settings` records.
 *
 * ## The three things the markup has to get right, and why each is not a detail
 *
 * **There is no pointer-only control anywhere, and no `<script>` is required for any of it.** The
 * acceptance line is "the whole screen is operable by keyboard with no pointer events", and the way that is
 * made true is by there being nothing to click that is not a native control: every input is an `<input>`, a
 * `<select>` or a `<button type="submit">` inside a `<form method="post">`. The one inline script narrows
 * the start list to the chosen treatment, and the page is correct without it — with JavaScript off every
 * listed start is selectable and offerable for at least one treatment, and the server validates the pair it
 * was sent.
 *
 * **The start options carry their own instant.** Each `<option value>` is the ISO instant the server
 * computed from the trading day's window. A browser that turned a label back into a time would be a second
 * implementation of the grid, and B-UI-03 records where two implementations of that disagree: at the
 * midnight crossing and at the close, which are the two edges nobody drags onto while testing.
 *
 * **The WhatsApp ref is the first optional field in DOM order, and it never blocks.** It is an `<input>`
 * with a `pattern`, no `required`, and its unknown-code state is a warning rendered beside a Confirm button
 * that is still there. A field that refused the booking would answer Y12-ref-loop by fiat — the front desk
 * would stop using the screen, and the funnel would report a capture rate of zero for a reason nobody
 * recorded.
 */

/**
 * The page's own styles. Colours are tokens only; there is no literal in this file (`pnpm colours`).
 *
 * Exported so `quick-book-render.test.ts` can assert that last sentence about THIS string rather than about
 * the whole document — the document also embeds `tokensCss()`, which is the token layer and is where the hex
 * literals legitimately live, so a scan of the rendered page would fail for the one reason that is correct.
 */
export const QUICK_BOOK_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.0625rem; line-height: 1.3; margin: 0 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); max-width: 46rem; }
  .lede, .panel, .assignment, .notice, .confirmation {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-6);
  }
  .lede { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-accent-gold); }
  .lede p:last-child, .panel p:last-child, .notice p:last-child { margin-bottom: 0; }
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
  .field { display: block; margin: 0 0 var(--space-5); }
  .field > span.label { display: block; font-weight: 600; margin-bottom: var(--space-2); }
  .field > span.hint { display: block; margin-top: var(--space-2); }
  /*
    2.75rem is the touch-target floor the rest of the product holds to. It matters more here than on a
    marketing page: this is a screen somebody uses a hundred times a shift, standing up, often on a tablet.
  */
  input[type="text"], input[type="tel"], select, textarea {
    width: 100%;
    min-height: 2.75rem;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-ground);
    color: var(--color-ink);
    font: inherit;
  }
  textarea { min-height: 5rem; }
  fieldset {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-1);
    margin: 0 0 var(--space-5);
    padding: var(--space-4) var(--space-5);
  }
  legend { font-weight: 600; padding: 0 var(--space-2); }
  .choice { display: flex; align-items: center; gap: var(--space-3); min-height: 2.75rem; }
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
  :where(input, select, textarea, button, a):focus-visible {
    outline: var(--space-1) solid var(--color-accent-gold);
    outline-offset: var(--space-1);
  }
  .notice { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-ink); }
  .assignment { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-accent-gold); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: start; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--color-hairline); }
  code { font-family: ui-monospace, monospace; }
  .provisional { border-inline-start-width: var(--space-2); border-inline-start-color: var(--color-border); }
`

/**
 * Narrows the start list to the chosen treatment, and nothing else.
 *
 * The page is CORRECT without this script. With JavaScript off every offered start is selectable, and every
 * one of them is offerable for at least one treatment — the grid emits no instant that no treatment suits —
 * so the only pair a no-JavaScript operator can get wrong is a long treatment at a late start, which the
 * server refuses by name as `start_not_offered` with the times that ARE open. What the script buys is that
 * the desk cannot pick that pair by accident.
 *
 * The option LABEL is the clock time alone and deliberately does not name a treatment, because one option
 * serves several: the instants are shared and only the durations differ. Which treatments an instant suits is
 * carried as `data-variants`, which is machine-readable for this script and for the server's own check.
 *
 * It sets `hidden` and `disabled` on the options that do not apply and **moves no node**. That is
 * deliberate: a DOM move blurs the element it moves (`append` and `insertBefore` remove first), so a
 * rebuilt `<select>` would throw the keyboard user's focus away mid-form — the failure this session found
 * the hard way elsewhere. Disabling an option is also what a screen reader announces, where a removed one
 * simply vanishes.
 */
const QUICK_BOOK_SCRIPT = `
  var form = document.querySelector('[data-testid="quick-book-form"]')
  if (form !== null) {
    var variant = form.querySelector('[data-testid="quick-book-variant"]')
    var start = form.querySelector('[data-testid="quick-book-start"]')
    if (variant !== null && start !== null) {
      var narrow = function () {
        var chosen = variant.value
        var firstUsable = null
        for (var index = 0; index < start.options.length; index += 1) {
          var option = start.options[index]
          var owners = option.dataset.variants
          /*
            Membership and not equality: one option per instant, carrying every treatment it suits. Split on
            a space, because an attribute holding a list is the only way an option can belong to several
            treatments while keeping its own value unique - and a select with duplicate values cannot be set
            by value at all: the browser takes the first match, which after narrowing may be disabled.
          */
          var mine = owners === undefined || owners.split(' ').indexOf(chosen) !== -1
          option.hidden = !mine
          option.disabled = !mine
          if (mine && firstUsable === null) firstUsable = option
        }
        /*
          A selection that has just been disabled would be submitted as a pair the server refuses, so the
          list falls back to its first usable option. The value is READ back rather than assumed, because a
          list with nothing usable in it must leave the field alone rather than blank it.
        */
        var current = start.selectedOptions[0]
        if ((current === undefined || current.disabled) && firstUsable !== null) {
          start.value = firstUsable.value
        }
        form.dataset.narrowedTo = chosen
      }
      variant.addEventListener('change', narrow)
      narrow()
    }
  }
`

const attribute = (name: string, value: string): string => `${name}="${safeText(value)}"`

/** The refusal names, as the page says them. One wording per name; see `view.ts` for why it is a table. */
function therapistRefusal(reason: TherapistRefusalReason): string {
  return therapistRefusalSentence(reason)
}

function refNotice(notice: RefNotice): string {
  return refNoticeSentence(notice)
}

/**
 * A `<select>` whose options carry an owning variant, so the script can narrow it and the server can
 * refuse a pair it did not offer.
 */
function startSelect(view: QuickBookView): string {
  const options = view.starts.map((start) => {
    const selected = start.value === view.form.start ? ' selected' : ''
    return (
      `<option ${attribute('value', start.value)} ` +
      `${attribute('data-variants', start.serviceVariantIds.join(' '))}` +
      `${selected}>${safeText(start.label)}</option>`
    )
  })
  return [
    '<label class="field" for="quick-book-start">',
    '<span class="label">Start</span>',
    '<select id="quick-book-start" data-testid="quick-book-start" ' +
      `${attribute('name', QUICK_BOOK_FIELDS.start)} required>`,
    ...options,
    '</select>',
    `<span class="hint" data-testid="quick-book-start-hint">${safeText(view.startHint)}</span>`,
    '</label>',
  ].join('')
}

function variantSelect(view: QuickBookView): string {
  return [
    '<label class="field" for="quick-book-variant">',
    '<span class="label">Treatment</span>',
    '<select id="quick-book-variant" data-testid="quick-book-variant" ' +
      `${attribute('name', QUICK_BOOK_FIELDS.variant)} required>`,
    ...view.variants.map(
      (variant) =>
        `<option ${attribute('value', variant.serviceVariantId)}` +
        `${variant.serviceVariantId === view.form.variant ? ' selected' : ''}>` +
        `${safeText(variant.label)}</option>`,
    ),
    '</select>',
    '</label>',
  ].join('')
}

/**
 * The client's gender, as a required radio group.
 *
 * Required, and that is B-AVAIL-05 rather than this screen's choice: under strict same-gender matching a
 * booking request with no client gender is refused outright with `requires_client_gender`, so a screen that
 * did not ask would be a screen whose every booking failed. The manifest's acceptance line names three
 * required fields and this is a fourth; the NOTE on the unit says so rather than leaving a reader to
 * discover it.
 *
 * A radio group and not a `<select>`, because two options reached in one keystroke is faster than a list
 * opened and closed — and because "prefer not to say" is deliberately absent: it is not a value the
 * matching rule can act on, and offering it would collect an answer that refuses the booking.
 */
function genderChoice(view: QuickBookView): string {
  return [
    '<fieldset data-testid="quick-book-gender">',
    '<legend>Treatment is for</legend>',
    ...(['female', 'male'] as const).map((value) =>
      [
        `<span class="choice"><input type="radio" id="quick-book-gender-${value}" `,
        `${attribute('name', QUICK_BOOK_FIELDS.gender)} ${attribute('value', value)}`,
        view.form.gender === value ? ' checked' : '',
        ' required>',
        `<label for="quick-book-gender-${value}">A ${value} client</label></span>`,
      ].join(''),
    ),
    `<p class="hint" data-testid="quick-book-gender-why">${safeText(view.genderWhy)}</p>`,
    '</fieldset>',
  ].join('')
}

/**
 * The WhatsApp ref field: the FIRST optional field in DOM order.
 *
 * `pattern` from `@berelax/shared`, so the browser refuses a malformed code before a round trip and the
 * column's CHECK, this attribute and the normaliser are one rule rather than three. No `required`, no
 * `aria-required`, and `autocomplete="off"` — a code belongs to one conversation and a browser offering the
 * last one is a browser offering a wrong attribution.
 */
function refField(view: QuickBookView): string {
  return [
    '<label class="field" for="quick-book-ref">',
    '<span class="label">WhatsApp ref code <span data-testid="quick-book-ref-optional">(optional)</span></span>',
    `<input type="text" id="quick-book-ref" data-testid="quick-book-ref" ${attribute('name', QUICK_BOOK_FIELDS.ref)} `,
    `${attribute('pattern', view.refCodePattern)} ${attribute('maxlength', String(view.refCodeLength))} `,
    `inputmode="text" autocapitalize="characters" autocomplete="off" spellcheck="false" `,
    `${attribute('value', view.form.ref)}>`,
    `<span class="hint" data-testid="quick-book-ref-hint">${safeText(view.refHint)}</span>`,
    '</label>',
  ].join('')
}

/** The hidden fields that carry the entry form across the check and the confirm. Never a URL. */
function carried(view: QuickBookView): string {
  return (
    [
      [QUICK_BOOK_FIELDS.phone, view.form.phone],
      [QUICK_BOOK_FIELDS.ref, view.form.ref],
      [QUICK_BOOK_FIELDS.variant, view.form.variant],
      [QUICK_BOOK_FIELDS.gender, view.form.gender],
      [QUICK_BOOK_FIELDS.start, view.form.start],
      [QUICK_BOOK_FIELDS.notes, view.form.notes],
      [QUICK_BOOK_FIELDS.therapist, view.form.therapist],
    ] as const
  )
    .map(
      ([name, value]) =>
        `<input type="hidden" ${attribute('name', name)} ${attribute('value', value)}>`,
    )
    .join('')
}

/** The entry form. Phone, then the ref, then the treatment, the client, the start and the note. */
function entryForm(view: QuickBookView): string {
  return [
    `<form class="panel" method="post" data-testid="quick-book-form" ${attribute('action', view.action)}>`,
    '<h2>Take a booking</h2>',
    `<input type="hidden" ${attribute('name', QUICK_BOOK_FIELDS.step)} value="check">`,
    // Phone first, because it is the only field the desk cannot look up and because an autofocused phone
    // box is what makes the first keystroke of the measured interaction land somewhere useful.
    '<label class="field" for="quick-book-phone">',
    '<span class="label">Mobile number</span>',
    `<input type="tel" id="quick-book-phone" data-testid="quick-book-phone" ${attribute('name', QUICK_BOOK_FIELDS.phone)} `,
    `inputmode="tel" autocomplete="off" autofocus required ${attribute('value', view.form.phone)}>`,
    `<span class="hint">${safeText(view.phoneHint)}</span>`,
    '</label>',
    refField(view),
    variantSelect(view),
    genderChoice(view),
    startSelect(view),
    '<label class="field" for="quick-book-notes">',
    '<span class="label">Note <span>(optional)</span></span>',
    `<textarea id="quick-book-notes" data-testid="quick-book-notes" ${attribute('name', QUICK_BOOK_FIELDS.notes)} `,
    `maxlength="2000">${safeText(view.form.notes)}</textarea>`,
    '</label>',
    '<button type="submit" data-testid="quick-book-check">Check the time</button>',
    '</form>',
  ].join('')
}

/**
 * The assignment, and the confirm.
 *
 * Therapist and room are DISPLAYED and are not editable here: the solver chose them, and the acceptance
 * line asks for them shown before confirm. The override below is a separate control that re-checks rather
 * than a field on this panel, because changing the therapist changes the assignment and a form that let
 * both be edited at once would be a form whose displayed assignment was stale.
 */
function assignmentPanel(view: QuickBookView): string {
  const checked = view.checked
  if (checked === null) return ''
  return [
    '<div class="assignment" data-testid="quick-book-assignment">',
    '<h2>Assigned, not yet booked</h2>',
    '<dl>',
    `<dt>Treatment</dt><dd data-testid="quick-book-assigned-treatment">${safeText(checked.treatmentLabel)}</dd>`,
    `<dt>Start</dt><dd data-testid="quick-book-assigned-start">${safeText(checked.startLabel)}</dd>`,
    `<dt>Room</dt><dd ${attribute('data-testid', 'quick-book-assigned-room')} ${attribute('data-room', checked.roomId)}>${safeText(checked.roomLabel)}</dd>`,
    // Therapists by their internal reference and never by a name: a therapist has no display name until an
    // admin sets one, and publishing one needs a recorded photography consent as well (ADR 0020).
    '<dt>Therapist</dt><dd data-testid="quick-book-assigned-therapist">',
    checked.therapists
      .map(
        (therapist) =>
          `<span ${attribute('data-therapist', therapist.therapistId)}>${safeText(therapist.reference)}</span>`,
      )
      .join(', '),
    '</dd>',
    `<dt>Price</dt><dd data-testid="quick-book-assigned-price">${safeText(checked.priceLabel)}</dd>`,
    '</dl>',
    '</div>',
    `<form class="panel" method="post" data-testid="quick-book-confirm-form" ${attribute('action', view.action)}>`,
    `<input type="hidden" ${attribute('name', QUICK_BOOK_FIELDS.step)} value="confirm">`,
    carried(view),
    `<input type="hidden" ${attribute('name', QUICK_BOOK_FIELDS.room)} ${attribute('value', checked.roomId)}>`,
    ...checked.therapists.map(
      (therapist) =>
        `<input type="hidden" ${attribute('name', QUICK_BOOK_FIELDS.assigned)} ${attribute('value', therapist.therapistId)}>`,
    ),
    '<button type="submit" data-testid="quick-book-confirm">Confirm the booking</button>',
    '</form>',
  ].join('')
}

/**
 * The therapist override, offered only when the engine found somebody else free.
 *
 * A control that is absent rather than disabled when there is no alternative, which is the reasoning
 * B-UI-01's therapist selector and P-HR-04's candidate list both record: offering a choice known to fail is
 * worse than not offering it. The refusal path still exists and is still named, because a page is a
 * snapshot — a credential that expires between this render and the submit is exactly how an ineligible
 * therapist reaches the server.
 */
function overrideForm(view: QuickBookView): string {
  const checked = view.checked
  if (checked === null || checked.alternatives.length === 0) return ''
  return [
    `<form class="panel" method="post" data-testid="quick-book-override-form" ${attribute('action', view.action)}>`,
    '<h2>Someone else</h2>',
    `<input type="hidden" ${attribute('name', QUICK_BOOK_FIELDS.step)} value="check">`,
    ...(
      [
        [QUICK_BOOK_FIELDS.phone, view.form.phone],
        [QUICK_BOOK_FIELDS.ref, view.form.ref],
        [QUICK_BOOK_FIELDS.variant, view.form.variant],
        [QUICK_BOOK_FIELDS.gender, view.form.gender],
        [QUICK_BOOK_FIELDS.start, view.form.start],
        [QUICK_BOOK_FIELDS.notes, view.form.notes],
      ] as const
    ).map(
      ([name, value]) =>
        `<input type="hidden" ${attribute('name', name)} ${attribute('value', value)}>`,
    ),
    '<label class="field" for="quick-book-therapist">',
    '<span class="label">Therapist <span>(optional — the solver has already chosen one)</span></span>',
    `<select id="quick-book-therapist" data-testid="quick-book-therapist" ${attribute('name', QUICK_BOOK_FIELDS.therapist)}>`,
    `<option value=""${view.form.therapist === '' ? ' selected' : ''}>Whoever the solver chose</option>`,
    ...checked.alternatives.map(
      (therapist) =>
        `<option ${attribute('value', therapist.therapistId)}` +
        `${therapist.therapistId === view.form.therapist ? ' selected' : ''}>` +
        `${safeText(therapist.reference)}</option>`,
    ),
    '</select>',
    '</label>',
    '<button type="submit" data-testid="quick-book-recheck">Check with this therapist</button>',
    '</form>',
  ].join('')
}

/**
 * Who the engine excluded, and why — the four reason codes, on the screen.
 *
 * Read off the availability answer the check already computed, so this costs no extra query. It is on the
 * page because "no availability" is the answer a front desk cannot act on: an expired credential is a
 * renewal, a missing skill is a training record, an unrostered therapist is a rota edit, and a gender
 * mismatch is none of those and is not about the therapist at all.
 */
function exclusionPanel(view: QuickBookView): string {
  const checked = view.checked
  if (checked === null || checked.excluded.length === 0) return ''
  return [
    '<div class="panel" data-testid="quick-book-excluded">',
    '<h2>Not available for this treatment</h2>',
    '<table>',
    '<thead><tr><th scope="col">Therapist</th><th scope="col">Why</th></tr></thead>',
    '<tbody>',
    ...checked.excluded.map(
      (row) =>
        `<tr ${attribute('data-therapist', row.therapistId)} ${attribute('data-reason', row.reason)}>` +
        `<td>${safeText(row.reference)}</td><td>${safeText(row.sentence)}</td></tr>`,
    ),
    '</tbody></table>',
    '</div>',
  ].join('')
}

/** The booked confirmation. The one state that says a row exists. */
function confirmation(view: QuickBookView): string {
  const booked = view.booked
  if (booked === null) return ''
  return [
    '<div class="confirmation" data-testid="quick-book-confirmation">',
    '<h2>Booked</h2>',
    '<dl>',
    `<dt>Booking</dt><dd data-testid="quick-book-booking-id">${safeText(booked.bookingId)}</dd>`,
    `<dt>Treatment</dt><dd>${safeText(booked.treatmentLabel)}</dd>`,
    `<dt>Start</dt><dd>${safeText(booked.startLabel)}</dd>`,
    `<dt>Room</dt><dd ${attribute('data-room', booked.roomId)}>${safeText(booked.roomLabel)}</dd>`,
    '<dt>Therapist</dt><dd>',
    booked.therapists
      .map(
        (therapist) =>
          `<span ${attribute('data-therapist', therapist.therapistId)}>${safeText(therapist.reference)}</span>`,
      )
      .join(', '),
    '</dd>',
    // The attribution, stated as what it IS. `unknown` is a legitimate and common answer and is printed as
    // such, because a blank here would read as a field nobody filled rather than as a fact nobody has.
    `<dt>WhatsApp attribution</dt><dd ${attribute('data-testid', 'quick-book-attribution')} ${attribute('data-outcome', booked.captureOutcome)}>${safeText(booked.captureLabel)}</dd>`,
    '</dl>',
    `<p><a ${attribute('href', view.action)}>Take another booking</a></p>`,
    '</div>',
  ].join('')
}

/** The capture rate, and the claim it is entitled to make. Never a bare percentage. */
function ratePanel(view: QuickBookView): string {
  const rate = view.rate
  return [
    '<div class="panel provisional" data-testid="quick-book-rate">',
    '<h2>Ref capture</h2>',
    `<p data-testid="quick-book-rate-claim" ${attribute('data-claim', rate.claim)}>${safeText(rate.sentence)}</p>`,
    `<p><span data-testid="quick-book-rate-matched">${safeText(String(rate.matched))}</span> matched, ` +
      `<span data-testid="quick-book-rate-unknown">${safeText(String(rate.unknownCode))}</span> not ` +
      `recognised, <span data-testid="quick-book-rate-blank">${safeText(String(rate.notOffered))}</span> ` +
      `with no code, of <span data-testid="quick-book-rate-total">${safeText(String(rate.total))}</span> ` +
      'bookings taken at the desk.</p>',
    rate.openQuestionId === null
      ? ''
      : `<p>Tracked as <code data-testid="quick-book-rate-question">${safeText(rate.openQuestionId)}</code>.</p>`,
    '</div>',
  ].join('')
}

/** The provisional values this screen is standing on, named, with their question ids. */
function assumptionsPanel(view: QuickBookView): string {
  return [
    '<div class="panel provisional" data-testid="quick-book-assumptions">',
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

export function renderQuickBookHtml(view: QuickBookView): string {
  const refused = view.refusal
  return [
    '<!doctype html>',
    `<html lang="en" dir="${view.direction}"` +
      `${refused === null ? '' : ` data-quick-book-refusal="${safeText(refused.name)}"`}>`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: `apps/web/src/seo/brand.test.ts` requires the full trading name wherever the
    // brand appears, and an internal screen naming it would be citing the wrong entity. The rule is about
    // how the brand is written, so not writing it is compliant.
    '<title>Quick-book — admin</title>',
    `<style>${tokensCss()}${QUICK_BOOK_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Quick-book</h1>',
    '<div class="lede">',
    `<p><strong>${safeText(view.dayLabel)}</strong></p>`,
    `<p data-testid="quick-book-lede">${safeText(view.lede)}</p>`,
    '</div>',
    // `role="status"` with `aria-live="polite"`: on this screen every outcome arrives as a new document, so
    // the live region is what a screen-reader user hears instead of being told to go and look for it.
    '<p class="live" role="status" aria-live="polite" data-testid="quick-book-live">' +
      `${safeText(view.announcement)}</p>`,
    view.refNotice === null
      ? ''
      : `<div class="notice" data-testid="quick-book-ref-notice" ${attribute('data-notice', view.refNotice)}>` +
        `<p>${safeText(refNotice(view.refNotice))}</p></div>`,
    refused === null
      ? ''
      : `<div class="notice" data-testid="quick-book-refusal" ${attribute('data-refusal', refused.name)}>` +
        `<p>${safeText(refused.sentence)}</p>` +
        (refused.therapistReason === null
          ? ''
          : `<p data-testid="quick-book-therapist-refusal" ${attribute('data-reason', refused.therapistReason)}>` +
            `${safeText(therapistRefusal(refused.therapistReason))}</p>`) +
        '</div>',
    confirmation(view),
    assignmentPanel(view),
    overrideForm(view),
    exclusionPanel(view),
    view.booked === null && view.checked === null ? entryForm(view) : '',
    ratePanel(view),
    assumptionsPanel(view),
    '</main>',
    `<script>${QUICK_BOOK_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}
