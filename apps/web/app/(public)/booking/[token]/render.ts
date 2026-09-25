import {
  assertNever,
  MANAGE_BOOKING_FIELDS,
  type ManageBookingField,
  safeText,
} from '@berelax/core'
import { tokensCss } from '@berelax/ui'

/**
 * The manage-booking page, as HTML.
 *
 * Pure: facts in, a document out, no database and no clock. That is what lets `render.test.ts` assert the
 * allowlist, both languages and both directions without a server, and it is why nothing here reads
 * `new Date()` — a document printing "in 3 hours" could not produce two identical screenshots on a repeat
 * run, which is the other half of B-UI-05's acceptance criterion.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * The HR and compliance screens next door give one reason — W-SITE-01's registry requires every
 * **document** to be served in both locales and the admin has no Arabic shell — and this surface has a
 * sharper one, which is about the token rather than about the shell.
 *
 * A `page.tsx` at `/booking/[token]` would be a registry *document*, and the registry requires a document
 * to declare `sampleParams` and to carry a reciprocal, self-referential `hreflang` set in both locales
 * (`registry.test.ts`, `route-spine.itest.ts`). Every one of those three is wrong for a bearer credential:
 *
 *   - **`sampleParams` is a real token in source.** The screenshot harness, the normalisation walk and the
 *     header assertions each open a route's sample path and require a 200, so the declared token would have
 *     to resolve — a live, permanently valid magic link committed to `apps/web/src/routes/registry.ts`.
 *   - **The `hreflang` set publishes the token twice.** `<link rel="alternate" href=".../ar/booking/<token>">`
 *     puts the credential in the head of the page for every crawler, proxy and shared screenshot, and makes
 *     two URLs for one capability where the whole design is that there is one.
 *   - **A document is walked in every mis-spelling.** `route-spine.itest.ts` fetches the upper-cased path of
 *     every document and requires one 301 to a 200 — which for this route is a redirect onto a lower-cased
 *     token. That one is survivable, and only because the token is lower-case hex (see the core module);
 *     the first two are not.
 *
 * So the registry entry is a `handler`, the page is assembled here, and the two locales are ONE URL whose
 * language comes from `customer.locale` — the language that customer's reminder was sent in. A second URL
 * per language would be a second copy of the credential.
 *
 * ## What it may print
 *
 * `MANAGE_BOOKING_FIELDS` in `@berelax/core`, and the enforcement is structural rather than a comment:
 * {@link factRows} maps over that list, so the page prints one row per declared field and has no way to
 * print anything else. {@link LABELS} is a `Record` over the union, so a field added to the allowlist
 * fails `pnpm typecheck` here until it has a label in both languages.
 *
 * No name, no telephone number, no price and nothing clinical. The core module records why each of those
 * is absent; the short version is that this page is read off a phone on a café table by whoever is holding
 * it, and docs/06 D2 puts the *detail* behind the link, not the record.
 */

/** The page's own styles. Colours are tokens only; there is no literal in this file (`pnpm colours`). */
const MANAGE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 40rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-5); }
  h2 { font-size: 1.125rem; margin: 0 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); }
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  .notice {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  dl.facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: var(--space-3) var(--space-5);
    margin: 0;
  }
  dl.facts dt { color: var(--color-ink-2); font-size: 0.875rem; }
  dl.facts dd { margin: 0 0 var(--space-3); font-variant-numeric: tabular-nums; }
  form { display: grid; gap: var(--space-5); }
  label { display: grid; gap: var(--space-3); color: var(--color-ink-2); font-size: 0.875rem; }
  input[type="datetime-local"] {
    min-block-size: 3rem;
    padding: var(--space-3);
    font: inherit;
    color: var(--color-ink);
    background: var(--color-surface-raised);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
  }
  button {
    min-block-size: 3rem;
    min-inline-size: 3rem;
    padding: var(--space-3) var(--space-5);
    font: inherit;
    font-weight: 600;
    color: var(--color-ink-inverse);
    background: var(--color-ink);
    border: 1px solid var(--color-ink);
    border-radius: var(--radius-1);
    cursor: pointer;
  }
  button.secondary { color: var(--color-ink); background: var(--color-surface-raised); }
  a { color: var(--color-ink); }
  footer { color: var(--color-ink-2); font-size: 0.875rem; }
`

/**
 * Every fact the page prints, and its type.
 *
 * Keyed on `MANAGE_BOOKING_FIELDS` in both directions by {@link FACTS_ARE_THE_ALLOWLIST} below, so a
 * field here that the allowlist does not declare fails the typecheck — which is what makes the allowlist
 * the thing the page actually reads rather than documentation of it.
 */
export interface ManageBookingFacts {
  readonly bookingReference: string
  readonly tradingDate: string
  readonly startsAtIso: string
  readonly endsAtIso: string
  readonly serviceName: string
  readonly durationMinutes: number
  readonly status: string
  readonly insideCancellationWindow: boolean
  readonly cancellationWindowHours: number
  readonly linkExpiresAtIso: string
}

type MissingFromView = Exclude<ManageBookingField, keyof ManageBookingFacts>
type NotOnTheAllowlist = Exclude<keyof ManageBookingFacts, ManageBookingField>

/**
 * `true` exactly when the view's fields and the allowlist are the same set.
 *
 * A type-level assertion rather than a test, because the failure it catches is a field somebody ADDS: a
 * test enumerating the allowlist would still pass while the view carried a tenth property nobody declared,
 * and that property is how a row read out of the database reaches the page. Exported so it is a value with
 * a reader rather than an unused constant the linter removes.
 */
export const FACTS_ARE_THE_ALLOWLIST: [MissingFromView, NotOnTheAllowlist] extends [never, never]
  ? true
  : never = true

/** The language a page is served in. `customer.locale`'s two values (0019). */
export type ManageLocale = 'en' | 'ar'

/** What just happened, when something did. Rendered as a named designed state, never as a bare message. */
export type ManageOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'rescheduled' }
  | { readonly kind: 'cancelled' }
  /** A refusal the domain named — `slot_taken`, `new_slot_outside_trading`, and the rest. */
  | { readonly kind: 'refused'; readonly refusal: string }

export interface ManageBookingView {
  readonly locale: ManageLocale
  readonly facts: ManageBookingFacts
  readonly outcome: ManageOutcome
  /** The desk number, from the `premises` row. The one thing on the page that is not about this booking. */
  readonly deskPhoneE164: string
  /**
   * Whether the booking can still be changed from here.
   *
   * False once every appointment of it is terminal, which is what a reader sees after cancelling: the
   * facts, the confirmation, and the desk number instead of two forms that would refuse.
   */
  readonly changeable: boolean
}

/** One label per declared field, in both languages. A `Record`, so a new field must be labelled. */
const LABELS: Readonly<Record<ManageBookingField, Readonly<Record<ManageLocale, string>>>> =
  Object.freeze({
    bookingReference: { en: 'Booking reference', ar: 'رقم الحجز' },
    tradingDate: { en: 'Trading date', ar: 'يوم العمل' },
    startsAtIso: { en: 'Starts', ar: 'يبدأ' },
    endsAtIso: { en: 'Ends', ar: 'ينتهي' },
    serviceName: { en: 'Treatment', ar: 'الجلسة' },
    durationMinutes: { en: 'Duration', ar: 'المدة' },
    status: { en: 'Status', ar: 'الحالة' },
    insideCancellationWindow: { en: 'Change notice', ar: 'مهلة التغيير' },
    cancellationWindowHours: { en: 'Notice period', ar: 'مدة الإشعار' },
    linkExpiresAtIso: { en: 'This link works until', ar: 'هذا الرابط صالح حتى' },
  })

const COPY: Readonly<Record<ManageLocale, Readonly<Record<string, string>>>> = Object.freeze({
  en: {
    title: 'Your booking',
    heading: 'Your booking',
    facts: 'What is booked',
    move: 'Move this booking',
    moveField: 'New start time',
    moveButton: 'Move this booking',
    cancel: 'Cancel this booking',
    cancelButton: 'Cancel this booking',
    cancelWarning:
      'Cancelling cannot be undone from this page, and the link stops working once it is done.',
    lateNotice:
      'This is inside the notice period the salon asks for, so the change is recorded as short notice. ' +
      'Nothing is charged for it.',
    doneRescheduled: 'Your booking has been moved. The details above are the new ones.',
    doneCancelled:
      'Your booking is cancelled. This link has been withdrawn, so telephone the desk if you would ' +
      'like to book again.',
    closed: 'This booking can no longer be changed from here. Telephone the desk and we will help.',
    desk: 'Telephone the desk',
    yes: 'Short notice',
    no: 'Ample notice',
    minutes: 'minutes',
    hours: 'hours',
  },
  ar: {
    title: 'حجزك',
    heading: 'حجزك',
    facts: 'تفاصيل الحجز',
    move: 'تغيير موعد الحجز',
    moveField: 'الموعد الجديد',
    moveButton: 'تغيير الموعد',
    cancel: 'إلغاء الحجز',
    cancelButton: 'إلغاء الحجز',
    cancelWarning: 'لا يمكن التراجع عن الإلغاء من هذه الصفحة، ويتوقف الرابط عن العمل بعده.',
    lateNotice: 'هذا التغيير داخل مدة الإشعار المطلوبة، ويُسجَّل كإشعار قصير. ولا يُحتسب عليه أي مبلغ.',
    doneRescheduled: 'تم تغيير موعد حجزك. التفاصيل أعلاه هي الجديدة.',
    doneCancelled: 'تم إلغاء حجزك. تم إيقاف هذا الرابط، فاتصل بالاستقبال إن أردت الحجز من جديد.',
    closed: 'لم يعد بالإمكان تغيير هذا الحجز من هنا. اتصل بالاستقبال وسنساعدك.',
    desk: 'اتصل بالاستقبال',
    yes: 'إشعار قصير',
    no: 'إشعار كافٍ',
    minutes: 'دقيقة',
    hours: 'ساعة',
  },
})

/**
 * Every named refusal this page has words for, in both languages.
 *
 * A `Record` over the refusals it can receive rather than a `switch` with a default, for the reason the
 * transition table is data: a default branch here would print one sentence for every future refusal, and
 * the sentence would be wrong for most of them. An unnamed refusal falls to {@link refusalCopy}'s honest
 * fallback, which says what happened without pretending to know why.
 */
const REFUSALS: Readonly<Record<string, Readonly<Record<ManageLocale, string>>>> = Object.freeze({
  slot_taken: {
    en: 'That time has just been taken. Choose another and we will hold it.',
    ar: 'هذا الوقت محجوز للتو. اختر وقتًا آخر وسنحفظه لك.',
  },
  /*
    No times in these words, and the omission is a rule rather than brevity. `premises_hours` is the only
    source of the trading window and it reaches a page through `readPremisesFacts`;
    `packages/db/src/seed/premises.test.ts` scans every rendered surface for an opening or closing time and
    fails on one. It caught this file's first draft, which named the opening and closing times in both
    languages — a page that would go on printing them after the owner had changed them. The scanner reads
    comments too, which is why this one does not repeat the words either.
  */
  new_slot_outside_trading: {
    en: 'We are not open then. Choose a time inside our opening hours, or telephone the desk.',
    ar: 'نحن مغلقون في هذا الوقت. اختر وقتًا داخل ساعات العمل أو اتصل بالاستقبال.',
  },
  not_a_trading_date: {
    en: 'We are not open that day. Choose another and we will hold it.',
    ar: 'نحن مغلقون في هذا اليوم. اختر يومًا آخر وسنحفظه لك.',
  },
  reschedule_changes_nothing: {
    en: 'That is the time you already have.',
    ar: 'هذا هو الموعد المحجوز لك بالفعل.',
  },
  therapist_not_eligible: {
    en: 'Nobody who can give this treatment is free then. Choose another time.',
    ar: 'لا يوجد من يمكنه تقديم هذه الجلسة في هذا الوقت. اختر وقتًا آخر.',
  },
  new_period_invalid: {
    en: 'That time could not be read. Please choose it again.',
    ar: 'لم نتمكن من قراءة هذا الوقت. اختره من جديد.',
  },
  illegal_transition: {
    en: 'This booking can no longer be changed from here. Telephone the desk and we will help.',
    ar: 'لم يعد بالإمكان تغيير هذا الحجز من هنا. اتصل بالاستقبال وسنساعدك.',
  },
})

const refusalCopy = (refusal: string, locale: ManageLocale): string =>
  REFUSALS[refusal]?.[locale] ??
  (locale === 'ar'
    ? 'لم نستطع إتمام هذا التغيير. اتصل بالاستقبال وسنساعدك.'
    : 'We could not make that change. Telephone the desk and we will help.')

/**
 * One instant, in the timezone the business runs in.
 *
 * Asia/Dubai and an explicit locale per language, because a render that read the request's `Accept-Language`
 * would produce a different document for two readers of the same page — and a screenshot has to be
 * byte-identical on a repeat run. `en-GB` and `ar-AE` with `latn` numerals: the price list, the invoice and
 * the calendar all print Latin digits, and one page in Arabic-Indic digits would be the only surface where
 * a time could not be compared with the SMS that carried the link.
 */
const FORMATTERS: Readonly<Record<ManageLocale, Intl.DateTimeFormat>> = Object.freeze({
  en: new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    dateStyle: 'full',
    timeStyle: 'short',
  }),
  ar: new Intl.DateTimeFormat('ar-AE-u-nu-latn', {
    timeZone: 'Asia/Dubai',
    dateStyle: 'full',
    timeStyle: 'short',
  }),
})

const instant = (iso: string, locale: ManageLocale): string => {
  const at = Date.parse(iso)
  // A value the page cannot read is printed as what it is. An `Invalid Date` in a `<dd>` is a document
  // that looks broken for a reason nobody can see; the ISO string at least says what arrived.
  return Number.isNaN(at) ? iso : FORMATTERS[locale].format(new Date(at))
}

/**
 * One printed row per declared field.
 *
 * A map over `MANAGE_BOOKING_FIELDS` and a `switch` with `assertNever`, so there is no path by which this
 * function prints a field the allowlist does not declare and no path by which it silently skips one. A
 * template that interpolated `view.facts` directly would satisfy every positive assertion about the page
 * and would print whatever a future field carried.
 */
function factRows(view: ManageBookingView): readonly { label: string; value: string }[] {
  const { facts, locale } = view
  const copy = COPY[locale]
  return MANAGE_BOOKING_FIELDS.map((field) => {
    const label = LABELS[field][locale]
    switch (field) {
      case 'bookingReference':
        return { label, value: facts.bookingReference }
      case 'tradingDate':
        return { label, value: facts.tradingDate }
      case 'startsAtIso':
        return { label, value: instant(facts.startsAtIso, locale) }
      case 'endsAtIso':
        return { label, value: instant(facts.endsAtIso, locale) }
      case 'serviceName':
        return { label, value: facts.serviceName }
      case 'durationMinutes':
        return { label, value: `${facts.durationMinutes} ${copy['minutes'] ?? ''}` }
      case 'status':
        return { label, value: facts.status }
      case 'insideCancellationWindow':
        return {
          label,
          value: (facts.insideCancellationWindow ? copy['yes'] : copy['no']) ?? '',
        }
      case 'cancellationWindowHours':
        return { label, value: `${facts.cancellationWindowHours} ${copy['hours'] ?? ''}` }
      case 'linkExpiresAtIso':
        return { label, value: instant(facts.linkExpiresAtIso, locale) }
      default:
        return assertNever(field, 'factRows')
    }
  })
}

/**
 * The outcome banner, as a NAMED state.
 *
 * `data-manage-state` rather than a class, for the reason B-UI-02's confirmation carries
 * `data-book-region`: a test asserting on a sentence asserts on copy the owner may reword, and a test
 * asserting on a marker asserts on the state the page is in.
 */
function outcomeBanner(view: ManageBookingView): string {
  const copy = COPY[view.locale]
  switch (view.outcome.kind) {
    case 'none':
      return ''
    case 'rescheduled':
      return banner('rescheduled', copy['doneRescheduled'] ?? '')
    case 'cancelled':
      return banner('cancelled', copy['doneCancelled'] ?? '')
    case 'refused':
      return banner('refused', refusalCopy(view.outcome.refusal, view.locale), view.outcome.refusal)
    default:
      return assertNever(view.outcome, 'outcomeBanner')
  }
}

const banner = (state: string, message: string, refusal?: string): string =>
  `<p class="notice" data-manage-state="${safeText(state)}"${
    refusal === undefined ? '' : ` data-manage-refusal="${safeText(refusal)}"`
  } role="status">${safeText(message)}</p>`

/**
 * The two forms, or the desk number.
 *
 * `method="post"` to the page's own URL, with no `action`: the token is in the path, so an `action` would
 * be a second place the credential is written and a relative one would break under the canonical redirect.
 * Both forms work with JavaScript off, which is the same constraint steps 1–3 of `/book` are built to
 * (docs/09 §3) and matters more here — this page is opened from an SMS on whatever browser the phone has.
 */
function actions(view: ManageBookingView): string {
  const copy = COPY[view.locale]
  if (!view.changeable) {
    return [
      `<section class="card" data-manage-region="closed">`,
      `<h2>${safeText(copy['desk'] ?? '')}</h2>`,
      `<p>${safeText(copy['closed'] ?? '')}</p>`,
      deskLink(view),
      '</section>',
    ].join('')
  }
  return [
    '<section class="card" data-manage-region="reschedule">',
    `<h2>${safeText(copy['move'] ?? '')}</h2>`,
    view.facts.insideCancellationWindow
      ? `<p data-manage-state="short-notice">${safeText(copy['lateNotice'] ?? '')}</p>`
      : '',
    '<form method="post">',
    '<input type="hidden" name="intent" value="reschedule">',
    `<label for="startsAt">${safeText(copy['moveField'] ?? '')}`,
    // `step="900"` — quarter hours, which is the granularity the slot grid offers. Not a validation of
    // availability: the salon's answer to "is that time free" is the booking transaction's, and it arrives
    // as a named refusal above rather than as a guess made in the browser.
    '<input type="datetime-local" id="startsAt" name="startsAt" step="900" required>',
    '</label>',
    `<button type="submit">${safeText(copy['moveButton'] ?? '')}</button>`,
    '</form>',
    '</section>',
    '<section class="card" data-manage-region="cancel">',
    `<h2>${safeText(copy['cancel'] ?? '')}</h2>`,
    `<p>${safeText(copy['cancelWarning'] ?? '')}</p>`,
    '<form method="post">',
    '<input type="hidden" name="intent" value="cancel">',
    `<button type="submit" class="secondary">${safeText(copy['cancelButton'] ?? '')}</button>`,
    '</form>',
    '</section>',
    `<footer data-manage-region="desk">${deskLink(view)}</footer>`,
  ].join('')
}

/**
 * The desk number, as a `tel:` link.
 *
 * On every render, changeable or not. B-UI-02's confirmation reached the same conclusion from the other
 * side: the telephone is the fallback for every state this page cannot resolve, and a page that offered it
 * only on failure would be a page that hides it exactly when somebody is already annoyed.
 */
const deskLink = (view: ManageBookingView): string =>
  `<a href="tel:${safeText(view.deskPhoneE164)}">${safeText(COPY[view.locale]['desk'] ?? '')}: ${safeText(
    view.deskPhoneE164,
  )}</a>`

export function renderManageBookingHtml(view: ManageBookingView): string {
  const copy = COPY[view.locale]
  const direction = view.locale === 'ar' ? 'rtl' : 'ltr'
  return [
    '<!doctype html>',
    `<html lang="${view.locale}" dir="${direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // The page IS a credential in a URL. `noindex` keeps it out of an index and `noreferrer` keeps the
    // token out of the Referer header of every link on it — `x-robots-tag` from the proxy carries the first
    // claim on the response, and this is the half a header cannot make.
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${safeText(copy['title'] ?? '')}</title>`,
    `<style>${tokensCss()}${MANAGE_CSS}</style>`,
    '</head>',
    '<body>',
    '<main data-manage-page="booking">',
    `<h1>${safeText(copy['heading'] ?? '')}</h1>`,
    outcomeBanner(view),
    '<section class="card" data-manage-region="facts">',
    `<h2>${safeText(copy['facts'] ?? '')}</h2>`,
    '<dl class="facts">',
    factRows(view)
      .map((row) => `<dt>${safeText(row.label)}</dt><dd>${safeText(row.value)}</dd>`)
      .join(''),
    '</dl>',
    '</section>',
    actions(view),
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
