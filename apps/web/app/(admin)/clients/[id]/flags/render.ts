import type { ContraindicationAccess, ContraindicationAccessDecision, Role } from '@berelax/core'
import {
  CONTRAINDICATION_FALSE_MEANING,
  CONTRAINDICATION_FLAG_ACTIONS,
  CONTRAINDICATION_FLAG_LABELS,
  safeText,
} from '@berelax/core'
import { CONTRAINDICATION_FLAG_KEYS, type ContraindicationFlagSet } from '@berelax/shared'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../../src/components/admin/google-reauth-banner.ts'

/**
 * One client's contraindication flags, as HTML (C-CRM-09).
 *
 * This is the screen the unit's name is about. It is read by somebody who may learn **that there is a
 * contraindication to check** and who must not learn **what the client wrote** — a receptionist taking a
 * booking, or a therapist about to deliver a treatment.
 *
 * Pure: a view in, a document out. No database, no clock, no key, which is what lets
 * `apps/web/src/flags-render.test.ts` assert the BYTES of the response rather than the return value of a
 * function. That distinction is the point of the test: a round trip through the derivation proves a flag
 * came back, and only the bytes prove that an answer did not come with it.
 *
 * ## What is on this page, in full
 *
 * The client's id, the eight flag names from the closed set, whether each is set, one action line per set
 * flag, and — when the reader may not see the detail — the name of the rule that refused them.
 *
 * ## What is NOT on this page, and why each absence is a decision
 *
 * **Any question label.** A label is what the client was asked, which is health data even with no answer
 * beside it: "Are you pregnant?" on a screen tells the reader what the form covers about this person. Labels
 * belong to the intake page, behind the step-up gate.
 *
 * **Any answer value.** There is no truncation, no redaction placeholder shaped like a value, and no "see
 * note" excerpt.
 *
 * **Any count.** Not how many flags are set, not how many questions were asked, not how many answers the
 * derivation could not read. A count of set flags is a measure of how ill somebody is, and it would travel
 * through a heading, a badge and eventually a log line.
 *
 * **Any date.** Not when the form was filled in and not when the flags were derived. The crossing carries no
 * instant (migration 0084 drops `updated_at` from the view), so there is none here to print.
 *
 * **Any name.** Brief rule 10: the client is labelled by id and the reader by their own employee id.
 *
 * ## The three states, which must not look alike
 *
 * **Flags derived.** Each of the eight is shown as set or not. "Not flagged" is worded as
 * {@link CONTRAINDICATION_FALSE_MEANING} says it must be — nothing on the form said yes — and never as
 * "clear", "none" or a tick, because the form may not have asked.
 *
 * **Nothing derived.** No flag row exists for this client. Rendered as its own state and NOT as eight
 * falses: those two would look identical and mean opposite things, and the second one is a claim that
 * somebody's form said no to eight questions when nothing has read it.
 *
 * **Refused.** This reader may not see the flags. The rule name is printed verbatim so an operator can quote
 * it and a search finds it beside the audit row that recorded the attempt.
 */

export type FlagsRenderDirection = 'ltr' | 'rtl'

/** The flags were derived and this reader may see them. */
export interface FlagsPresentView {
  readonly kind: 'flags'
  readonly flags: ContraindicationFlagSet
}

/**
 * No derivation has ever run for this client. NOT the same as eight falses.
 *
 * It deliberately does not say whether the client has filled in a form. That fact lives in
 * `clinical.intake_submission`, which the credential serving this page cannot read at all (0009), and the
 * two cases have the same remedy from here anyway: find somebody who can open the form, or hand the client
 * one. Inventing the distinction would mean either widening the crossing or widening the credential, and
 * both are worse than a reader being told one sentence instead of two.
 */
export interface FlagsNotDerivedView {
  readonly kind: 'not_derived'
}

export type FlagsOutcome = FlagsPresentView | FlagsNotDerivedView

export interface FlagsPageView {
  /** The Google re-auth banner, required of every admin document (G-CONN-08). */
  readonly chrome: AdminChrome
  readonly customerId: string
  readonly direction: FlagsRenderDirection
  /** Who is reading, as the query said. Printed so the audit row and the screen agree. */
  readonly role: Role
  readonly employeeId: string
  /** The two decisions: may this reader see the flags, and may they see the detail behind one. */
  readonly access: ContraindicationAccess
  readonly outcome: FlagsOutcome
}

/** The page's own styles. Colours are tokens only; there is no literal in this file (`pnpm colours`). */
const FLAGS_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 68ch; margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-6) 0 var(--space-3); }
  .meta { color: var(--color-ink-3); font-size: 0.875rem; margin: 0 0 var(--space-5); }
  .panel {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
    background: var(--color-surface);
  }
  .panel[data-tone="refused"] { border-color: var(--color-danger); }
  .rule {
    font-family: ui-monospace, monospace;
    font-size: 0.875rem;
    color: var(--color-ink-3);
  }
  ul.flags { list-style: none; margin: 0; padding: 0; }
  ul.flags > li {
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-hairline);
  }
  li[data-set="true"] { border-inline-start: var(--space-1) solid var(--color-danger); }
  li[data-set="true"] .state { font-weight: 600; }
  li[data-set="false"] { color: var(--color-ink-3); }
  .flag-name { display: block; font-weight: 600; }
  .action { margin: var(--space-1) 0 0; }
  a { color: var(--color-ink); }
  @media (max-width: 480px) { body { padding: var(--space-5) var(--gutter); } }
`

/** Why a reader was refused, in words they can act on. Exhaustive over the refusal names. */
const REMEDY = {
  flags_not_permitted_for_role:
    'Your job title does not include reading clinical markers. Ask the proprietor if you believe it ' +
    'should; nothing about this client is shown until it does.',
  note_not_permitted_for_role:
    'The detail behind a marker is an intake answer or a treatment note, and your job title covers the ' +
    'marker and not the answer. Ask the client, or ask the therapist who is delivering the treatment.',
  therapist_not_assigned:
    'You are not assigned to any appointment for this client, so nothing here is about a treatment you ' +
    'are giving. If you have taken the appointment over, have it reassigned first.',
} as const satisfies Record<string, string>

const refusedPanel = (
  what: string,
  decision: Extract<ContraindicationAccessDecision, { permitted: false }>,
): string =>
  `<section class="panel" data-tone="refused" data-outcome="refused" data-scope="${safeText(what)}" ` +
  `data-refusal="${safeText(decision.refusal)}">` +
  `<h2>${safeText(what === 'flags' ? 'These markers were not shown' : 'The detail is not yours to read')}</h2>` +
  // The rule NAME, verbatim, for the reason the intake page prints its own: an operator can quote it and a
  // search finds it in the audit trail beside the row that recorded the attempt.
  `<p class="rule">${safeText(decision.refusal)}</p>` +
  `<p>${safeText(REMEDY[decision.refusal])}</p>` +
  `<p class="meta">${safeText(decision.because)}</p>` +
  '</section>'

/**
 * One line per flag, in the closed set's order.
 *
 * Every flag is listed, set or not, rather than only the set ones. A page that printed only the set flags
 * would make an empty page mean two things — nothing is set, and nothing was derived — and the reader could
 * not tell which. It also makes the closed set visible: the front desk learns what this system does and does
 * not know about a client, which is the honest version of a marker.
 */
const flagList = (flags: ContraindicationFlagSet): string =>
  `<ul class="flags">${CONTRAINDICATION_FLAG_KEYS.map((flag) => {
    const set = flags[flag]
    return (
      `<li data-flag="${flag}" data-set="${String(set)}">` +
      `<span class="flag-name">${safeText(CONTRAINDICATION_FLAG_LABELS[flag])}</span>` +
      `<span class="state">${set ? 'To check before the appointment' : 'Not flagged'}</span>` +
      (set ? `<p class="action">${safeText(CONTRAINDICATION_FLAG_ACTIONS[flag])}</p>` : '') +
      '</li>'
    )
  }).join('')}</ul>`

/**
 * Where the detail is, for a reader who may open it — and deliberately NOT an anchor.
 *
 * `/clients/[id]/intake` requires `?purpose=`, in at least eight characters, and refuses the request with a
 * 400 without one (migration 0082 refuses a blank or placeholder purpose too). So every link this page could
 * emit lands on a 400: with the parameter empty because it is empty, and without it because it is missing.
 * A link that cannot work is worse than a path somebody types, and filling in a purpose here would mean this
 * page inventing the reason somebody opened a health record — which is the one value on that audit row that
 * has to have been committed to before the record was opened (ADR 0031).
 *
 * So the path is shown as text, with what it needs. There is no form to type a purpose into until W-SYS-01
 * brings the admin session, and docs/12 §1's first prohibition is that a stub must never look like it works.
 */
const detailPath = (view: FlagsPageView): string =>
  view.access.note.permitted
    ? '<p class="meta" data-detail-href>The answers behind these markers are on this client’s intake ' +
      `form, at <code>/clients/${safeText(view.customerId)}/intake</code>. That page needs a step-up ` +
      're-authentication and a stated reason of your own, in your own words, and opening it is recorded ' +
      'separately. It is not a link, because the reason cannot be filled in for you.</p>'
    : refusedPanel(
        'note',
        view.access.note as Extract<ContraindicationAccessDecision, { permitted: false }>,
      )

const body = (view: FlagsPageView): string => {
  if (!view.access.flags.permitted) {
    // Refused the flags, so the note panel is not rendered either: a reader who may not see that a marker
    // exists must not be told which second rule would also have refused them, and an unassigned therapist
    // learning "there is a note here" is the disclosure this whole screen is arranged to prevent.
    return refusedPanel('flags', view.access.flags)
  }
  if (view.outcome.kind === 'not_derived') {
    return (
      '<section class="panel" data-outcome="not_derived">' +
      '<h2>No markers have been worked out for this client</h2>' +
      '<p><strong>That is not the same as having none.</strong> Either this client has not filled in an ' +
      'intake form, or one has been filled in and nothing has read it yet. Before the appointment, hand ' +
      'them a form or ask somebody who can open theirs.</p>' +
      '</section>'
    )
  }
  return (
    '<section class="panel" data-outcome="flags">' +
    '<h2>What to check before the appointment</h2>' +
    flagList(view.outcome.flags) +
    // The sentence that stops "Not flagged" being read as "cleared". Rendered on every flags page, because
    // the reading it corrects is the one a reader arrives with.
    `<p class="meta" data-false-meaning>${safeText(CONTRAINDICATION_FALSE_MEANING)}</p>` +
    detailPath(view) +
    '</section>'
  )
}

export function renderFlagsPageHtml(view: FlagsPageView): string {
  return (
    '<!doctype html>\n' +
    `<html lang="en" dir="${view.direction}">` +
    '<head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<title>Client markers</title>' +
    `<style>${tokensCss()}${GOOGLE_REAUTH_BANNER_CSS}${FLAGS_CSS}</style>` +
    '</head><body>' +
    // `'<main>'` as a literal of its own, because `google-reauth-banner.test.ts` walks every admin
    // document's SOURCE for exactly this string to prove the banner is emitted INSIDE the landmark.
    '<main>' +
    renderAdminBanner(view.chrome) +
    '<h1>Client markers</h1>' +
    `<p class="meta" data-customer="${safeText(view.customerId)}" data-role="${safeText(view.role)}">` +
    `Client ${safeText(view.customerId)}, read as ${safeText(view.role)} ` +
    `${safeText(view.employeeId)}.</p>` +
    body(view) +
    '</main></body></html>'
  )
}
