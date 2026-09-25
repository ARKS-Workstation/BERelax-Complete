import { assertNever, safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'

/**
 * The preference centre, as HTML (C-CRM-07).
 *
 * Pure: facts in, a document out, no database and no clock. That is what lets `preference-centre-render.test.ts`
 * assert the shell equality, both languages and both directions without a server, and it is why nothing here
 * reads `new Date()` — a document printing "in 3 hours" could not produce two identical screenshots on a
 * repeat run.
 *
 * ## The whole page works with JavaScript off, and that is not a nicety
 *
 * Every control is a `<button type="submit">` inside its own `<form method="post">` with no `action`, so the
 * browser posts to the page's own URL — query string and all, which is where the capability is. There is no
 * client island, no fetch and no hydration anywhere in this document. docs/04 §5 makes this link the ONLY
 * functional opt-out this business has, because an alphanumeric sender ID cannot receive an inbound SMS; the
 * page is opened from a text message on whatever browser the phone has, by somebody who has had enough, and
 * a page that needed a script to work would be an opt-out that fails for the readers most likely to use it.
 *
 * ## Why a refused link renders THIS shell rather than a different document
 *
 * B-UI-05's manage-booking page answers one frozen 404 document for every refusal, and that is right for a
 * route whose path IS the credential — `/booking/{token}` for an unknown token is a URL that does not name
 * anything. Here the credential is a query field, so `/preferences` is a URL that always exists, and the
 * acceptance asks for the stronger property: *a valid token and a well-formed-but-unknown token produce the
 * same status code and the same page shell*. So {@link renderPreferenceCentreHtml} builds one shell and
 * fills it, the state lives on `<section data-preference-body>` INSIDE `<main>`, and everything outside
 * `<main>`'s children is byte-identical for both — same status, same head, same title, same footer. A
 * requester therefore learns nothing about whether a contact is known to the business from anything except
 * the words inside the card, which they can only reach by holding a live link for it.
 *
 * The language of the document comes from the URL and never from the record, for the same reason:
 * `customer.locale` in the `dir` attribute would be a fact about the contact readable by anybody holding the
 * link, and it would make the two shells differ. `packages/shared/src/site-origin.ts` puts the locale in the
 * link the sender builds.
 *
 * ## What it may print
 *
 * The grid, the statement, the link's expiry and the desk telephone number. No name, no contact detail, no
 * booking, nothing clinical: this page is read off a phone by whoever is holding it. The contact id is in
 * the URL because 0064 puts it there, and it is deliberately not printed — a uuid on the page is a uuid in a
 * screenshot somebody forwards.
 */

/** The language a page is served in. `customer.locale`'s two values (0019), chosen by the URL. */
export type PreferenceLocale = 'en' | 'ar'

/** What a single toggle is currently in. `resolveConsent`'s three states, folded by the handler. */
export type PreferenceConsentState = 'granted' | 'withdrawn' | 'unknown'

/** One cell of the grid, as the page prints it. */
export interface PreferenceCellView {
  readonly channel: string
  readonly purpose: string
  readonly consent: PreferenceConsentState
}

/** One statement the page shows, for one purpose, in the rendered language only. */
export interface PreferenceWordingView {
  /**
   * Which purpose it is the statement for.
   *
   * One section per purpose, not one statement for the grid, and the reason is what the resulting row
   * means: a page showing the marketing statement while recording a `review_request` grant would be storing
   * proof of an agreement to words that say nothing about review requests. `RenderedWording` in
   * `@berelax/db` refuses that at the write; this is the half that makes the page honest about it.
   */
  readonly purpose: string
  readonly version: number
  readonly text: string
  /**
   * Whether this is approved copy or this build's draft.
   *
   * Surfaced rather than hidden (brief rule 15, `Y9-consent-wording`): the seeded statement says in its own
   * text that it is provisional, and a page that presented it as approved marketing copy would be doing
   * exactly what that rule is about.
   */
  readonly isProvisional: boolean
}

/** What just happened, when something did. A named designed state, never a bare message. */
export type PreferenceOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'started' }
  /** A refusal the domain named. Looked up in a closed `Record`; an unknown one claims nothing. */
  | { readonly kind: 'refused'; readonly refusal: string }

export interface PreferenceCentreView {
  readonly locale: PreferenceLocale
  /**
   * The grid, or null when the link opened nothing.
   *
   * Null is the refused state and it is the ONLY thing that differs between the two documents outside the
   * card: a `<section data-preference-body="unavailable">` where the grid would be. See the header.
   */
  readonly cells: readonly PreferenceCellView[] | null
  /** True when the handset is on the suppression list, whatever the consent rows say. */
  readonly suppressed: boolean
  /** Which mechanism suppressed it, when one did. A closed vocabulary (0064), never free text. */
  readonly suppressionSource: string | null
  /** The statements, one per purpose, in grid order. Empty when nothing is published. */
  readonly wording: readonly PreferenceWordingView[]
  /** When the link stops working. Printed, because a link with a silent expiry is a broken link later. */
  readonly linkExpiresAtIso: string | null
  readonly outcome: PreferenceOutcome
  /** The desk number, from the `premises` row. Never a literal (`pnpm secrets`, ADR 0019). */
  readonly deskPhoneE164: string
  /** This page's own URL in the OTHER language, carrying the same capability. */
  readonly otherLocaleHref: string
  /**
   * Whether an email preference can be acted on at all.
   *
   * `customer` has no email column (C-CRM-01's NOTE 3), so an email row records the DECISION and has no
   * address to suppress. Stated on the page rather than left as a toggle that does less than its
   * neighbours.
   */
  readonly emailDetailHeld: boolean
}

/** The page's own styles. Colours are tokens only; there is no literal in this file (`pnpm colours`). */
const PREFERENCE_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 42rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-5); }
  h2 { font-size: 1.125rem; margin: 0 0 var(--space-3); }
  h3 { font-size: 1rem; margin: 0 0 var(--space-3); }
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
  .statement { background: var(--color-surface-raised); }
  ul.grid { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  ul.grid > li {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-5);
    align-items: center;
    justify-content: space-between;
    padding-block-end: var(--space-3);
    border-block-end: 1px solid var(--color-hairline);
  }
  .cell-name { font-weight: 600; }
  .cell-state { color: var(--color-ink-2); font-size: 0.875rem; }
  form { margin: 0; }
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
  dl.meta { margin: 0; }
  dl.meta dt { color: var(--color-ink-2); font-size: 0.875rem; }
  dl.meta dd { margin: 0 0 var(--space-3); }
  a { color: var(--color-ink); }
  footer { color: var(--color-ink-2); font-size: 0.875rem; }
`

const COPY: Readonly<Record<PreferenceLocale, Readonly<Record<string, string>>>> = Object.freeze({
  en: {
    title: 'Your message preferences',
    heading: 'Your message preferences',
    statement: 'What you are agreeing to',
    draft: 'This wording is a draft and has not been approved yet.',
    version: 'Statement version',
    choices: 'What we may send you',
    stopAll: 'Stop all promotional messages',
    stopAllButton: 'Stop all promotional messages',
    startButton: 'Start again',
    stopButton: 'Stop',
    unavailable: 'This link is not available',
    unavailableBody:
      'It may have expired, or it may have been withdrawn. Our booking pages are at ' +
      'berelaxmassage.com, or telephone the desk and we will change your preferences for you.',
    suppressed:
      'You are on our do-not-message list, so no promotional message will be sent to this number ' +
      'whatever the rows below say. Bookings and reminders are not promotional and still reach you.',
    handsetNote:
      'Stopping any of the handset rows also puts this number on our do-not-message list, which stops ' +
      'every promotional message to it. There is no way to stop one and keep another.',
    emailNote:
      'We hold no email address for you, so an email row records your decision and nothing else.',
    doneStopped: 'That is recorded. We have stopped it.',
    doneStarted: 'That is recorded. We will start again.',
    expires: 'This link works until',
    desk: 'Telephone the desk',
    otherLocale: 'العربية',
    granted: 'On',
    withdrawn: 'Off',
    unknown: 'Not set',
    source: 'Reason',
    channelSms: 'Text message',
    channelEmail: 'Email',
    channelWhatsapp: 'WhatsApp',
    purposeMarketing: 'Offers and news',
    purposeReviewRequest: 'Review requests',
  },
  ar: {
    title: 'تفضيلات الرسائل',
    heading: 'تفضيلات الرسائل',
    statement: 'ما توافق عليه',
    draft: 'هذه الصيغة مسودة ولم تُعتمد بعد.',
    version: 'إصدار النص',
    choices: 'ما يمكننا إرساله إليك',
    stopAll: 'إيقاف كل الرسائل الترويجية',
    stopAllButton: 'إيقاف كل الرسائل الترويجية',
    startButton: 'إعادة التشغيل',
    stopButton: 'إيقاف',
    unavailable: 'هذا الرابط غير متاح',
    unavailableBody:
      'قد تكون مدته انتهت أو أنه أُلغي. صفحات الحجز على berelaxmassage.com، أو اتصل بالاستقبال ' +
      'وسنغيّر تفضيلاتك بدلًا عنك.',
    suppressed:
      'رقمك مدرج في قائمة عدم الإرسال، فلن تُرسل أي رسالة ترويجية إلى هذا الرقم مهما كانت الصفوف ' +
      'أدناه. الحجوزات والتنبيهات ليست ترويجية وتصلك كما هي.',
    handsetNote:
      'إيقاف أي صف من صفوف الهاتف يضيف هذا الرقم إلى قائمة عدم الإرسال، وهذا يوقف كل رسالة ترويجية ' +
      'إليه. لا يمكن إيقاف واحدة والإبقاء على أخرى.',
    emailNote: 'لا نحفظ لك عنوان بريد إلكتروني، فصف البريد يسجّل قرارك ولا شيء غير ذلك.',
    doneStopped: 'تم التسجيل. أوقفناها.',
    doneStarted: 'تم التسجيل. سنعيد الإرسال.',
    expires: 'هذا الرابط صالح حتى',
    desk: 'اتصل بالاستقبال',
    otherLocale: 'English',
    granted: 'مُفعّل',
    withdrawn: 'موقوف',
    unknown: 'غير محدد',
    source: 'السبب',
    channelSms: 'رسالة نصية',
    channelEmail: 'البريد الإلكتروني',
    channelWhatsapp: 'واتساب',
    purposeMarketing: 'العروض والأخبار',
    purposeReviewRequest: 'طلبات التقييم',
  },
})

/**
 * Every named refusal this page has words for, in both languages.
 *
 * A `Record` rather than a `switch` with a default, for the reason B-UI-05's renderer gives: a default
 * branch prints one sentence for every future refusal and the sentence is wrong for most of them. An
 * unnamed refusal falls to {@link refusalCopy}'s fallback, which says what happened without pretending to
 * know why.
 */
const REFUSALS: Readonly<Record<string, Readonly<Record<PreferenceLocale, string>>>> =
  Object.freeze({
    preference_grant_on_a_tombstone: {
      en:
        'We cannot start messages again from this link, because your record has since been joined with ' +
        'another one. Telephone the desk and we will do it for you. Stopping messages still works here.',
      ar:
        'لا يمكننا إعادة تشغيل الرسائل من هذا الرابط، لأن سجلك دُمج مع سجل آخر. اتصل بالاستقبال ' +
        'وسنقوم بذلك بدلًا عنك. أما إيقاف الرسائل فلا يزال يعمل من هنا.',
    },
    preference_contact_unreachable: {
      en:
        'We hold no telephone number for you, so there is nothing to stop on this one. Telephone the ' +
        'desk and we will change your preferences for you.',
      ar: 'لا نحفظ لك رقم هاتف، فلا يوجد ما يمكن إيقافه هنا. اتصل بالاستقبال وسنغيّر تفضيلاتك بدلًا عنك.',
    },
    preference_centre_wording_absent: {
      en:
        'We cannot start messages again until the wording you would be agreeing to has been published. ' +
        'Telephone the desk and we will help.',
      ar: 'لا يمكننا إعادة التشغيل قبل نشر النص الذي ستوافق عليه. اتصل بالاستقبال وسنساعدك.',
    },
    preference_scope_unknown: {
      en: 'We could not read that choice. Please use the buttons on this page.',
      ar: 'لم نتمكن من قراءة هذا الاختيار. استخدم الأزرار في هذه الصفحة.',
    },
  })

const refusalCopy = (refusal: string, locale: PreferenceLocale): string =>
  REFUSALS[refusal]?.[locale] ??
  (locale === 'ar'
    ? 'لم نستطع تسجيل هذا التغيير. اتصل بالاستقبال وسنساعدك.'
    : 'We could not record that change. Telephone the desk and we will help.')

/**
 * One instant, in the timezone the business runs in.
 *
 * Asia/Dubai and an explicit locale per language, because a render that read the request's `Accept-Language`
 * would produce a different document for two readers of the same page — and a screenshot has to be
 * byte-identical on a repeat run. `latn` numerals for the reason the manage-booking page gives: every other
 * surface prints Latin digits, and one page in Arabic-Indic digits would be the only one where a date could
 * not be compared with the message that carried the link.
 */
const FORMATTERS: Readonly<Record<PreferenceLocale, Intl.DateTimeFormat>> = Object.freeze({
  en: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'full' }),
  ar: new Intl.DateTimeFormat('ar-AE-u-nu-latn', { timeZone: 'Asia/Dubai', dateStyle: 'full' }),
})

const day = (iso: string, locale: PreferenceLocale): string => {
  const at = Date.parse(iso)
  // A value the page cannot read is printed as what it is. An `Invalid Date` in a `<dd>` looks broken for a
  // reason nobody can see; the ISO string at least says what arrived.
  return Number.isNaN(at) ? iso : FORMATTERS[locale].format(new Date(at))
}

const copyKeyForChannel: Readonly<Record<string, string>> = Object.freeze({
  sms: 'channelSms',
  email: 'channelEmail',
  whatsapp: 'channelWhatsapp',
})
const copyKeyForPurpose: Readonly<Record<string, string>> = Object.freeze({
  marketing: 'purposeMarketing',
  review_request: 'purposeReviewRequest',
})

/**
 * A cell's name, in words.
 *
 * Falls back to the raw value rather than omitting the row, and the fallback is the honest one: a channel
 * or purpose this file has no words for is still a decision the send path will consult, so a page that
 * silently dropped it would be a page offering fewer choices than the system has. `pnpm typecheck` cannot
 * catch it — the grid comes from `@berelax/shared` at run time — so `preference-centre-render.test.ts`
 * asserts every cell of the real grid is named.
 */
export function cellName(
  cell: { readonly channel: string; readonly purpose: string },
  locale: PreferenceLocale,
): string {
  const copy = COPY[locale]
  const channel = copy[copyKeyForChannel[cell.channel] ?? ''] ?? cell.channel
  const purpose = copy[copyKeyForPurpose[cell.purpose] ?? ''] ?? cell.purpose
  // Purpose then channel in both languages, and the separator is a middle dot rather than a word, so the
  // string reads the same way round in an RTL document without a second word order to translate.
  return `${purpose} \u00b7 ${channel}`
}

/** The marker the shell comparison splits on. One `<main>`, identical on both documents. */
export const PREFERENCE_MAIN_OPEN = '<main data-preference-page="preferences">'

function stateWord(state: PreferenceConsentState, locale: PreferenceLocale): string {
  const copy = COPY[locale]
  switch (state) {
    case 'granted':
      return copy['granted'] ?? ''
    case 'withdrawn':
      return copy['withdrawn'] ?? ''
    case 'unknown':
      return copy['unknown'] ?? ''
    default:
      return assertNever(state, 'stateWord')
  }
}

/**
 * One row of the grid: what it is, what it is in, and the one button that changes it.
 *
 * The button's accessible name carries the row — "Stop Offers and news · Text message" — rather than a bare
 * "Stop", because a page with six buttons all reading "Stop" is a page a screen reader cannot navigate, and
 * `button-name` is one of the two rule ids this unit's known-bad axe control asserts.
 */
function gridRow(cell: PreferenceCellView, view: PreferenceCentreView): string {
  const copy = COPY[view.locale]
  const name = cellName(cell, view.locale)
  // Granted is the only state with something to stop. `withdrawn` and `unknown` both offer the grant,
  // because "not set" is the absence of a row and a reader who wants the messages has to be able to say so.
  const stop = cell.consent === 'granted'
  const label = `${stop ? (copy['stopButton'] ?? '') : (copy['startButton'] ?? '')} ${name}`
  return [
    `<li data-preference-cell="${safeText(`${cell.channel}:${cell.purpose}`)}"`,
    ` data-preference-state="${safeText(cell.consent)}">`,
    '<span>',
    `<span class="cell-name">${safeText(name)}</span><br>`,
    `<span class="cell-state">${safeText(stateWord(cell.consent, view.locale))}</span>`,
    '</span>',
    '<form method="post">',
    '<input type="hidden" name="intent" value="pair">',
    `<input type="hidden" name="channel" value="${safeText(cell.channel)}">`,
    `<input type="hidden" name="purpose" value="${safeText(cell.purpose)}">`,
    `<input type="hidden" name="action" value="${stop ? 'unsubscribe' : 'resubscribe'}">`,
    `<button type="submit"${stop ? '' : ' class="secondary"'}>${safeText(label)}</button>`,
    '</form>',
    '</li>',
  ].join('')
}

/**
 * The statements, one card per purpose, each with its version and its provisional marker.
 *
 * Empty when nothing is published for any purpose — which is a state the page can be in and the write
 * refuses a GRANT in, so the reader sees the grid and can still stop things.
 */
function statements(view: PreferenceCentreView): string {
  const copy = COPY[view.locale]
  return view.wording
    .map((wording) =>
      [
        `<section class="card statement" data-preference-region="statement:${safeText(wording.purpose)}">`,
        `<h2>${safeText(copy['statement'] ?? '')}: ${safeText(purposeName(wording.purpose, view.locale))}</h2>`,
        // The words themselves, marked with the purpose so a test can read them back and hash them against
        // the row that purpose's decision produced. The acceptance is that the version rendered here is the
        // version on the resulting consent row, and a marker is how that is checked against the BYTES
        // rather than against a variable.
        `<p data-preference-wording="${safeText(wording.purpose)}" data-preference-wording-version="${wording.version}">`,
        safeText(wording.text),
        '</p>',
        wording.isProvisional
          ? `<p class="notice" data-preference-state="draft-wording">${safeText(copy['draft'] ?? '')}</p>`
          : '',
        '<dl class="meta">',
        `<dt>${safeText(copy['version'] ?? '')}</dt><dd>${wording.version}</dd>`,
        '</dl>',
        '</section>',
      ].join(''),
    )
    .join('')
}

/** A purpose in words, falling back to the raw value for the reason {@link cellName} states. */
const purposeName = (purpose: string, locale: PreferenceLocale): string =>
  COPY[locale][copyKeyForPurpose[purpose] ?? ''] ?? purpose

/** The outcome banner, as a NAMED state rather than as a sentence a test would assert on. */
function outcomeBanner(view: PreferenceCentreView): string {
  const copy = COPY[view.locale]
  switch (view.outcome.kind) {
    case 'none':
      return ''
    case 'stopped':
      return banner('stopped', copy['doneStopped'] ?? '')
    case 'started':
      return banner('started', copy['doneStarted'] ?? '')
    case 'refused':
      return banner('refused', refusalCopy(view.outcome.refusal, view.locale), view.outcome.refusal)
    default:
      return assertNever(view.outcome, 'outcomeBanner')
  }
}

const banner = (state: string, message: string, refusal?: string): string =>
  `<p class="notice" data-preference-state="${safeText(state)}"${
    refusal === undefined ? '' : ` data-preference-refusal="${safeText(refusal)}"`
  } role="status">${safeText(message)}</p>`

/** The card a refused link opens onto. The only thing in this document that differs from a valid one. */
function unavailable(view: PreferenceCentreView): string {
  const copy = COPY[view.locale]
  return [
    '<section class="card" data-preference-body="unavailable">',
    `<h2>${safeText(copy['unavailable'] ?? '')}</h2>`,
    `<p>${safeText(copy['unavailableBody'] ?? '')}</p>`,
    '</section>',
  ].join('')
}

/** The grid, the notes that qualify it, and the one control that covers everything. */
function grid(cells: readonly PreferenceCellView[], view: PreferenceCentreView): string {
  const copy = COPY[view.locale]
  return [
    '<section class="card" data-preference-body="grid">',
    `<h2>${safeText(copy['choices'] ?? '')}</h2>`,
    view.suppressed
      ? [
          '<p class="notice" data-preference-state="suppressed"',
          view.suppressionSource === null
            ? ''
            : ` data-preference-suppression-source="${safeText(view.suppressionSource)}"`,
          ` role="status">${safeText(copy['suppressed'] ?? '')}</p>`,
        ].join('')
      : '',
    // The consequence, printed rather than left to be discovered. A suppression names a hashed DETAIL and
    // there is no per-purpose suppression, so stopping one handset row stops the number — the repository's
    // header argues why that asymmetry is the two keys doing what each is for, and this is the half a
    // reader is owed.
    `<p data-preference-note="handset">${safeText(copy['handsetNote'] ?? '')}</p>`,
    view.emailDetailHeld
      ? ''
      : `<p data-preference-note="email">${safeText(copy['emailNote'] ?? '')}</p>`,
    '<ul class="grid">',
    cells.map((cell) => gridRow(cell, view)).join(''),
    '</ul>',
    '</section>',
    '<section class="card" data-preference-region="stop-all">',
    `<h2>${safeText(copy['stopAll'] ?? '')}</h2>`,
    '<form method="post">',
    '<input type="hidden" name="intent" value="everything">',
    '<input type="hidden" name="action" value="unsubscribe">',
    `<button type="submit">${safeText(copy['stopAllButton'] ?? '')}</button>`,
    '</form>',
    '</section>',
  ].join('')
}

/** The desk number as a `tel:` link, on every render. The fallback for every state this page cannot fix. */
const deskLink = (view: PreferenceCentreView): string =>
  `<a href="tel:${safeText(view.deskPhoneE164)}">${safeText(
    COPY[view.locale]['desk'] ?? '',
  )}: ${safeText(view.deskPhoneE164)}</a>`

export function renderPreferenceCentreHtml(view: PreferenceCentreView): string {
  const copy = COPY[view.locale]
  const direction = view.locale === 'ar' ? 'rtl' : 'ltr'
  return [
    '<!doctype html>',
    `<html lang="${view.locale}" dir="${direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // The URL IS a credential. `noindex` keeps the page out of an index; `no-referrer` keeps the query
    // string — which carries the token — out of the Referer of every link on it, and that matters more here
    // than on a path-token page because a query is what a referrer header carries in full.
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${safeText(copy['title'] ?? '')}</title>`,
    `<style>${tokensCss()}${PREFERENCE_CSS}</style>`,
    '</head>',
    '<body>',
    PREFERENCE_MAIN_OPEN,
    `<h1>${safeText(copy['heading'] ?? '')}</h1>`,
    outcomeBanner(view),
    statements(view),
    view.cells === null ? unavailable(view) : grid(view.cells, view),
    view.linkExpiresAtIso === null
      ? ''
      : [
          '<dl class="meta" data-preference-region="expiry">',
          `<dt>${safeText(copy['expires'] ?? '')}</dt>`,
          `<dd>${safeText(day(view.linkExpiresAtIso, view.locale))}</dd>`,
          '</dl>',
        ].join(''),
    /*
      The language switch is INSIDE `<main>`, and that placement is the acceptance criterion rather than a
      layout choice. It is the one element on the page whose href carries the capability, so a footer
      holding it would put the token in the SHELL — and the shell is exactly what a valid document and a
      refused one have to share byte for byte, or the response tells a caller whether the contact behind a
      guessed id exists. A link rather than a `<select>`, because the page has no script and a form control
      needing one would be a language switch that does nothing on the phone this page is opened from.
    */
    `<p data-preference-region="language"><a href="${safeText(view.otherLocaleHref)}" hreflang="${
      view.locale === 'ar' ? 'en' : 'ar'
    }">${safeText(copy['otherLocale'] ?? '')}</a></p>`,
    '</main>',
    // Nothing in the footer is derived from the request: the desk number is the `premises` singleton, read
    // the same way for a valid link and a refused one, so the shell stays identical.
    `<footer data-preference-region="footer">${deskLink(view)}</footer>`,
    '</body>',
    '</html>',
  ].join('')
}
