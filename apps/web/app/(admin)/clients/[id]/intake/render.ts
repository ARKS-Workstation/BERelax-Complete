import type { ClinicalReadRefusal, RenderedSubmission } from '@berelax/core'
import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../../src/components/admin/google-reauth-banner.ts'

/**
 * One client's intake record, as HTML (C-CRM-08).
 *
 * Pure: a view in, a document out. No database, no clock, no key — which is what lets
 * `apps/web/src/intake-render.test.ts` assert the screen without a server and what makes two renders of
 * one view identical.
 *
 * ## The screen has three states and they must not look alike
 *
 * A clinical record is the one screen in this application where "nothing to show" has three meanings with
 * three different remedies, and a page that printed one sentence for all of them would be hiding the only
 * one worth acting on:
 *
 *   - **Refused.** There is a record and this operator may not see it. The page says WHICH rule refused, by
 *     name, and what to do about it — step up, or go and take a consent. This is the state the unit exists
 *     for and it is rendered as prominently as the record itself.
 *   - **Consent not established.** There is a record and there is no lawful basis to open it. Not a
 *     permissions problem, and the remedy is a conversation with the client rather than a second factor.
 *   - **No submission.** The client has not filled one in. Nothing is wrong.
 *
 * ## What is NOT on this page
 *
 * No answer value appears anywhere unless the read was permitted — there is no partial render, no
 * "redacted" placeholder shaped like a value, and no count of how many answers are hidden. A count is a
 * fact about somebody's health record and reading one should cost a step-up like reading any other.
 *
 * The page also never renders a therapist's or a client's NAME (brief rule 10): the client is labelled by
 * the id the caller passed, and the reader by their own employee id.
 */

export type RenderDirection = 'ltr' | 'rtl'

/** What the page shows when the read was permitted. */
export interface IntakeRecordView {
  readonly kind: 'record'
  readonly rendered: RenderedSubmission
  readonly grantId: string
  readonly statedPurpose: string
  /** The wording version the answers were given to, restated so the page can say it plainly. */
  readonly templateTitle: string
}

/** What the page shows when the read was refused, by name. */
export interface IntakeRefusedView {
  readonly kind: 'refused'
  readonly refusal: ClinicalReadRefusal
  readonly because: string
  readonly submissionId: string
}

/** What the page shows when the client has no submission at all. */
export interface IntakeAbsentView {
  readonly kind: 'absent'
}

export type IntakeOutcome = IntakeRecordView | IntakeRefusedView | IntakeAbsentView

export interface IntakePageView {
  /**
   * The Google re-auth banner and the page a reconnect comes back to (G-CONN-08).
   *
   * Required rather than optional, for the reason every other admin document records: an optional field
   * would be a permissive default, and the default would be an admin page saying nothing while the Google
   * grant is dead. `apps/web/src/google-reauth-banner.test.ts` walks every admin document on disk.
   */
  readonly chrome: AdminChrome
  readonly customerId: string
  readonly outcome: IntakeOutcome
  readonly direction: RenderDirection
  /**
   * Whether real intake data may be stored at all, and the question that decides it.
   *
   * On the page because a screen showing only synthetic fixtures must SAY so. An operator who believes
   * this is the live clinical record of a real client will act on it, and docs/12 §1's first prohibition
   * is that a stub must never look like it works.
   */
  readonly realIntakePermitted: boolean
  readonly residencyQuestionId: string
}

/** The page's own styles. Colours are tokens only; there is no literal in this file (`pnpm colours`). */
const INTAKE_CSS = `
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
  dl.answers { margin: 0; }
  dl.answers > div {
    padding: var(--space-3) 0;
    border-bottom: 1px solid var(--color-hairline);
  }
  dl.answers dt { font-weight: 600; margin: 0 0 var(--space-1); }
  dl.answers dd { margin: 0; }
  dd[data-missing="true"] { color: var(--color-ink-3); }
  .assumption {
    border: 1px dashed var(--color-hairline);
    border-radius: var(--radius-2);
    padding: var(--space-4);
    margin: var(--space-6) 0 0;
    font-size: 0.875rem;
  }
  a { color: var(--color-ink); }
  @media (max-width: 480px) { body { padding: var(--space-5) var(--gutter); } }
`

/** The remedy for each refusal, in words an operator can act on. Exhaustive by construction. */
const REMEDY: Record<ClinicalReadRefusal, string> = {
  clinical_consent_not_established:
    'There is no consent record covering the wording this form was captured under. Take a consent from ' +
    'the client before opening it. Nothing about this record may be shown until then.',
  clinical_consent_withdrawn:
    'This client has withdrawn consent. The record is retained as evidence and may not be read. Ask the ' +
    'proprietor before doing anything further with it.',
  clinical_step_up_required:
    'Re-enter your second factor, stating why you are opening this record. The grant lasts a few minutes ' +
    'and covers that one stated reason.',
  clinical_step_up_expired:
    'Your step-up has expired. Re-enter your second factor with the reason you are opening this record.',
  clinical_step_up_revoked:
    'Your step-up was revoked. Re-enter your second factor, or speak to the proprietor if you did not ' +
    'expect this.',
  clinical_step_up_purpose_mismatch:
    'You stepped up for a different reason. A grant covers one stated purpose; step up again with this ' +
    'one.',
  clinical_read_purpose_not_stated:
    'Say why you are opening this record, in a sentence. It goes on the audit trail beside your name.',
}

const answersList = (rendered: RenderedSubmission): string =>
  `<dl class="answers">${rendered.answers
    .map(
      (answer) =>
        `<div><dt>${safeText(answer.label)}</dt>` +
        `<dd data-missing="${String(answer.missing)}" data-key="${safeText(answer.key)}">` +
        `${answer.missing ? 'not answered' : safeText(answer.value ?? '')}</dd></div>`,
    )
    .join('')}</dl>`

const unknownKeys = (rendered: RenderedSubmission): string =>
  rendered.unknownKeys.length === 0
    ? ''
    : `<p class="meta" data-unknown-keys="${rendered.unknownKeys.length}">This submission holds ` +
      `${rendered.unknownKeys.length} answer(s) to questions version ${rendered.templateVersion} does ` +
      `not ask: ${rendered.unknownKeys.map((key) => safeText(key)).join(', ')}. The values are not ` +
      'shown — a key is a diagnostic, a value is health data.</p>'

const body = (view: IntakePageView): string => {
  const outcome = view.outcome
  if (outcome.kind === 'absent') {
    return (
      '<section class="panel" data-outcome="absent">' +
      '<h2>No intake form on record</h2>' +
      '<p>This client has not completed one. Nothing is wrong and nothing is hidden.</p>' +
      '</section>'
    )
  }
  if (outcome.kind === 'refused') {
    return (
      '<section class="panel" data-tone="refused" data-outcome="refused" ' +
      `data-refusal="${safeText(outcome.refusal)}">` +
      '<h2>This record was not opened</h2>' +
      // The rule NAME, verbatim. An operator reporting a problem can quote it, and a search finds it in
      // the audit trail beside the row that recorded the attempt.
      `<p class="rule">${safeText(outcome.refusal)}</p>` +
      `<p>${safeText(REMEDY[outcome.refusal])}</p>` +
      `<p class="meta">${safeText(outcome.because)}</p>` +
      '</section>'
    )
  }
  return (
    '<section class="panel" data-outcome="record">' +
    `<h2>${safeText(outcome.templateTitle)}</h2>` +
    `<p class="meta" data-version="${outcome.rendered.templateVersion}">Answers as given to version ` +
    `${outcome.rendered.templateVersion} of this form. The wording below is that version's, not the ` +
    'current one.</p>' +
    answersList(outcome.rendered) +
    unknownKeys(outcome.rendered) +
    `<p class="meta" data-grant="${safeText(outcome.grantId)}">Opened for: ` +
    `${safeText(outcome.statedPurpose)}. This read is on the audit trail.</p>` +
    '</section>'
  )
}

const assumption = (view: IntakePageView): string =>
  view.realIntakePermitted
    ? ''
    : '<aside class="assumption" data-unconfirmed-assumption=' +
      `"${safeText(view.residencyQuestionId)}">` +
      '<strong>Synthetic records only.</strong> Real client intake data may not be stored in this ' +
      `database yet (${safeText(view.residencyQuestionId)}): whether intake notes count as health data ` +
      'subject to UAE localisation is unconfirmed, so anything shown here is an obviously-fake fixture. ' +
      'A real submission is refused by name, by the database as well as by the application.' +
      '</aside>'

export function renderIntakePageHtml(view: IntakePageView): string {
  return (
    '<!doctype html>\n' +
    `<html lang="en" dir="${view.direction}">` +
    '<head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow">' +
    '<title>Client intake</title>' +
    `<style>${tokensCss()}${GOOGLE_REAUTH_BANNER_CSS}${INTAKE_CSS}</style>` +
    '</head><body>' +
    // `'<main>'` as a literal of its own, because `google-reauth-banner.test.ts` walks every admin
    // document's SOURCE for exactly this string to prove the banner is emitted INSIDE the landmark. Fused
    // into the surrounding tags it produced identical HTML and failed that walk — a region outside every
    // landmark is reachable by a screen reader only through "all content", which for a warning is not
    // good enough.
    '<main>' +
    renderAdminBanner(view.chrome) +
    '<h1>Client intake</h1>' +
    // The client is labelled by id. Brief rule 10: nothing here invents a name, and a clinical screen is
    // the last place to start.
    `<p class="meta" data-customer="${safeText(view.customerId)}">Client ${safeText(view.customerId)}</p>` +
    body(view) +
    assumption(view) +
    '</main></body></html>'
  )
}
