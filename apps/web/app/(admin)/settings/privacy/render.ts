import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * The data-subject rights screen (C-CRM-10): the requests, their deadlines, and what an erasure would do.
 *
 * Pure: rows in, a document out, no database and no clock. The instant the page was read at arrives in the
 * view and is printed on it, which is the rule every admin screen here follows — a screen that said "as of
 * now" could not produce two identical screenshots on a repeat run.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * The manifest's `files` list says `apps/web/app/(admin)/settings/privacy/`, which this satisfies, and the
 * choice of a handler is the one every admin surface in this build has taken. `apps/web/src/routes/registry.ts`
 * requires every **document** to be served in both locales, so a `page.tsx` here would need an Arabic admin
 * document that W-SYS-01 has not built and would join a screenshot matrix whose RTL half must be a real
 * Arabic route. The three HR screens and the two settings screens beside it give the same reason.
 *
 * ## What it shows, and the one thing it must not let anybody mistake
 *
 * Four things, and the fourth is the reason the screen exists rather than a report:
 *
 *   1. **The open requests and their due dates**, soonest first, with the overdue ones named as overdue.
 *      A deadline nobody can see is a deadline nobody meets.
 *   2. **What an erasure DOES, per data class**, taken from the rule registry rather than described here.
 *      The screen is a view of `ERASURE_RULES`, so it cannot drift from what the engine actually does —
 *      which is the failure a hand-written "here is what we delete" page has by construction.
 *   3. **What is RETAINED and the reason for each**, because that is the sentence a data subject is
 *      entitled to and the sentence the business has to be able to say out loud. Including the two it is
 *      least comfortable to say: a tax invoice keeps their name and number, and a blocklist entry keeps
 *      their number in the clear.
 *   4. **That the written response cannot be issued**, and why. This is the part that must not be
 *      mistakable for a configuration error: the rights are performed in full and the LETTER is withheld,
 *      because no supervisory authority is recorded and `Y1-entity` decides which one has jurisdiction. A
 *      screen that showed a blank field would read as something somebody forgot to fill in; this one says
 *      what the blank costs and what filling it in buys.
 *
 * It is READ-ONLY. Recording a request is a write with an actor and a verification method, and there is no
 * admin session until W-SYS-01 — so a button here would either invent an actor or write a placeholder,
 * which `rights_request_actor_is_stated` refuses. It names no customer: a subject is its record id and its
 * pseudonym, and a customer with no display name is `Customer 0042` (ADR 0020).
 */

/** One open or recently answered request, as the screen lists it. Never a name. */
export interface RightsRequestView {
  readonly id: string
  readonly requestType: string
  readonly subjectLabel: string
  readonly receivedAtIso: string
  readonly dueAtIso: string
  readonly state: string
  readonly isOverdue: boolean
  readonly verifiedVia: string
}

/** One data class, and what the registry says happens to it. */
export interface DataClassView {
  readonly dataClass: string
  /** Distinct actions the rules for this class take, so a class doing two things says so. */
  readonly actions: readonly string[]
  readonly columnCount: number
}

/** One retention, with the reason it is lawful to keep it. The sentence a subject is owed. */
export interface RetentionView {
  readonly participant: string
  readonly columnName: string
  readonly action: string
  readonly why: string
  readonly obligationColumn: string | null
  readonly obligationYears: number | null
}

export interface ProbeView {
  readonly axis: string
  readonly columnCount: number
}

export interface PrivacyPageView {
  readonly chrome: AdminChrome
  readonly readAtIso: string
  readonly slaDays: number
  readonly slaOpenQuestionId: string
  readonly slaProvenance: string
  /** Empty when nothing is recorded, which is the case this screen is most careful about. */
  readonly supervisoryAuthority: string
  readonly responseCanBeIssued: boolean
  readonly regulatoryProfileVersion: number
  readonly erasureOverridesRetention: boolean
  readonly clinicalRetentionYears: number
  readonly financialRetentionYears: number
  readonly realIntakePermitted: boolean
  readonly requests: readonly RightsRequestView[]
  readonly overdueCount: number
  readonly probes: readonly ProbeView[]
  readonly unclassifiedColumnCount: number
  readonly classes: readonly DataClassView[]
  readonly retentions: readonly RetentionView[]
}

const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  dateStyle: 'medium',
  timeStyle: 'short',
})

const when = (iso: string): string => DUBAI.format(new Date(iso))

/** Every colour is a token. `pnpm colours` refuses a literal hex outside the token layer (brief rule 11). */
const PRIVACY_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 68rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-7) 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); }
  .policy, .card, .withheld {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  .policy, .withheld { border-inline-start-width: var(--space-2); }
  .card { background: var(--color-surface); border-color: var(--color-hairline); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  ul.requests, ul.retentions, ul.classes {
    list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3);
  }
  ul.requests li, ul.retentions li, ul.classes li {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-inline-start: var(--space-2) solid var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-3) var(--space-5);
  }
  code { font-family: ui-monospace, monospace; }
  .empty { color: var(--color-ink-muted); }
  .overdue { font-weight: 600; }
`

function requestList(view: PrivacyPageView): string {
  if (view.requests.length === 0) {
    return (
      '<p class="empty">No request is open. A request is recorded by the front desk against the record it ' +
      'is about, with how the person was verified — and it cannot be recorded here, because a write needs ' +
      'an actor and there is no admin session until W-SYS-01.</p>'
    )
  }
  return `<ul class="requests">${view.requests
    .map(
      (request) =>
        `<li><code>${safeText(request.requestType)}</code> for ${safeText(request.subjectLabel)} — ` +
        `received ${safeText(when(request.receivedAtIso))}, due ${safeText(when(request.dueAtIso))}, ` +
        `state <code>${safeText(request.state)}</code>, verified by ` +
        `<code>${safeText(request.verifiedVia)}</code>` +
        (request.isOverdue ? ' — <span class="overdue">OVERDUE</span>' : '') +
        '</li>',
    )
    .join('')}</ul>`
}

function retentionList(view: PrivacyPageView): string {
  if (view.retentions.length === 0) {
    return '<p class="empty">Nothing is retained, which cannot be right — see the coverage count above.</p>'
  }
  return `<ul class="retentions">${view.retentions
    .map(
      (retention) =>
        `<li><code>${safeText(retention.participant)}.${safeText(retention.columnName)}</code> — ` +
        `<code>${safeText(retention.action)}</code>` +
        (retention.obligationColumn === null
          ? ''
          : ` under <code>${safeText(retention.obligationColumn)}</code> = ` +
            `${retention.obligationYears ?? 0} year(s)`) +
        `<br>${safeText(retention.why)}</li>`,
    )
    .join('')}</ul>`
}

export function renderPrivacyHtml(view: PrivacyPageView): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Data-subject rights — privacy admin</title>',
    `<style>${tokensCss()}${PRIVACY_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Data-subject rights</h1>',
    '<div class="policy">',
    `<p><strong>Read at ${safeText(when(view.readAtIso))} Dubai.</strong> Every export, rectification, ` +
      'erasure, objection and withdrawal is a recorded request with a deadline and an audit trail, and ' +
      'this screen is a view of what the engine would actually do rather than a description of it — the ' +
      'classes and reasons below come from the rule registry the erasure reads.</p>',
    `<p>Requests are answered within <strong>${view.slaDays} day(s)</strong>. ` +
      `${safeText(view.slaProvenance)} (<code>${safeText(view.slaOpenQuestionId)}</code>)</p>`,
    '</div>',
    // The withheld response. FIRST after the policy, because it is the one thing on this page that must not
    // be read as a field somebody forgot to fill in.
    view.responseCanBeIssued
      ? `<div class="card"><p>Written responses name <strong>${safeText(view.supervisoryAuthority)}</strong> ` +
        'as the authority a dissatisfied subject complains to.</p></div>'
      : '<div class="withheld"><p><strong>Written responses are withheld, and requests are still carried ' +
        'out in full.</strong> A response has to tell the subject where to complain, and no supervisory ' +
        'authority is recorded: <code>Y1-entity</code> decides whether the regulator is the federal one, ' +
        'DIFC’s or ADGM’s, and this build has not been told which. It is deliberately blank rather than ' +
        'assumed — a plausible authority in a letter would send a real complaint to an office that cannot ' +
        'hear it, and it would look exactly like a correct one. Recording the authority is one setting ' +
        'change and it is the only thing standing between this engine and a complete answer.</p></div>',
    '<h2>Open requests</h2>',
    view.overdueCount === 0
      ? ''
      : `<p><strong>${view.overdueCount} request(s) are past their deadline.</strong></p>`,
    requestList(view),
    '<h2>How the conflict resolves today</h2>',
    '<div class="card"><dl>',
    `<dt>Regulatory profile</dt><dd>version ${view.regulatoryProfileVersion}, and every retention below ` +
      'records which version decided it, so a past decision stays explainable</dd>',
    `<dt>Erasure overrides retention</dt><dd><code>${view.erasureOverridesRetention}</code> — ` +
      (view.erasureOverridesRetention
        ? 'an erasure request prevails over a retention obligation, so clinical content is destroyed'
        : 'a retention obligation prevails, so clinical CONTENT is retained while the identity is ' +
          'pseudonymised and every contact channel destroyed. The subject is unreachable either way: the ' +
          'clinical schema holds no phone number, no address and no name') +
      '</dd>',
    `<dt>Financial retention</dt><dd>${view.financialRetentionYears} year(s) — a tax invoice naming the ` +
      'person is kept, and so is their name and number ON it, because the document may not be edited</dd>',
    `<dt>Clinical retention</dt><dd>${view.clinicalRetentionYears} year(s), the healthcare-grade figure, ` +
      'because <code>Y1-licence</code> is unconfirmed and that is the stricter reading</dd>',
    `<dt>Real intake permitted</dt><dd><code>${view.realIntakePermitted}</code> — ` +
      (view.realIntakePermitted
        ? 'real health data may be stored, so the clinical conflict above is LIVE'
        : 'every clinical row is synthetic (<code>Y5-residency</code>), so no retention obligation ' +
          'attaches to one and destroying its key defeats nothing') +
      '</dd>',
    '</dl></div>',
    '<h2>What an erasure finds</h2>',
    `<p>Five catalogue probes, run against the database rather than against a list. ` +
      (view.unclassifiedColumnCount === 0
        ? 'Every column they find is accounted for by name.'
        : `<strong>${view.unclassifiedColumnCount} column(s) are unclassified, and an erasure will ` +
          'REFUSE to run until each one is.</strong>') +
      '</p>',
    '<div class="card"><dl>',
    view.probes
      .map(
        (probe) =>
          `<dt><code>${safeText(probe.axis)}</code></dt><dd>${probe.columnCount} column(s)</dd>`,
      )
      .join(''),
    '</dl></div>',
    '<h2>What happens, per data class</h2>',
    `<ul class="classes">${view.classes
      .map(
        (entry) =>
          `<li><code>${safeText(entry.dataClass)}</code> — ${entry.columnCount} column(s): ` +
          `${safeText(entry.actions.join(', '))}</li>`,
      )
      .join('')}</ul>`,
    '<h2>What is retained, and why it is lawful to keep it</h2>',
    '<p>Each of these is a sentence the business has to be able to say to the person it is about. Two of ' +
      'them are uncomfortable and are stated plainly rather than softened: a tax invoice keeps their name, ' +
      'number and address because the FTA requires the document be kept and it may not be edited, and a ' +
      'blocklist entry keeps their number in the clear because deleting it would make a privacy request a ' +
      'way to clear a safety block. Neither is a way to reach them — no send path reads either one, and ' +
      'the suppression entry refuses the send even if the number were typed in by hand.</p>',
    retentionList(view),
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
