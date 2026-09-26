import { aedFrom, formatMoney, safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * The rota screen: what is published, what the draft would refuse, and what it would cost.
 *
 * Pure: rows in, a document out, no database and no clock. The instant the page was read at arrives in the
 * view and is printed on it, which is the rule the two HR screens next door follow — a screen that said "as
 * of now" could not produce two identical screenshots on a repeat run.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * The manifest's `files` list says `page.tsx`, and it is corrected in a NOTE. `apps/web/src/routes/registry.ts`
 * is in exact bijection with the filesystem and requires every **document** to be served in both locales
 * (`registry.test.ts`: "gives every document a locale"), so a `page.tsx` here would need an Arabic admin
 * document that W-SYS-01 has not built, and it would join a screenshot matrix whose RTL half must be a real
 * Arabic route. The credentials and reassignment screens one directory along give the same reason, and
 * P-HR-02's NOTE records it as the arrangement every HR surface takes until W-SYS-01 lands.
 *
 * ## What it shows, and what it must not
 *
 * Three things a person can act on, and one they must not be able to mistake:
 *
 *   1. **The published version**: which one is current, when, by whom, and how many people were notified.
 *   2. **The draft's refusals**, by rule name and in the validator's own order. This is the working part of
 *      the screen: a rota is published or it is not, and the list is what has to be fixed first.
 *   3. **The segments the floor is short in**, named. Not all sixty of them — a table of sixty rows in
 *      which fifty-six say "fine" hides the four that do not — so the shortfalls are listed and the rest
 *      are counted.
 *   4. **The forecast, with its unpriced count beside it, always.** Nineteen employees have no
 *      `basic_wage_fils`, so the ordinary forecast today is 0 fils, and a screen that printed that figure
 *      alone would be reporting a free rota. The count is not a footnote and is not conditional.
 *
 * It names no therapist. `staff_reference` is the handle and nineteen employees have no name recorded (ADR
 * 0020, brief rule 10) — and a coverage shortfall is about a NUMBER on the floor rather than about who is
 * on it, so the segment rows carry counts and no identities at all.
 *
 * It is READ-ONLY. Publishing is a write with an actor, and there is no admin session until W-SYS-01; a
 * button here would either invent an actor or write `published_by` as a placeholder, which
 * `rota_version_published_by_not_placeholder` refuses. The transaction is `publishRota`.
 */

/** One segment the floor or the wet room is short in. Counts, never identities. */
export interface RotaShortfallView {
  readonly label: string
  readonly rule: string
  readonly onFloor: number
  readonly required: number
}

/** One refusal, as the validator worded it. */
export interface RotaViolationView {
  readonly rule: string
  readonly detail: string
}

export interface RotaPublishedView {
  readonly versionNo: number
  readonly publishedAtIso: string
  readonly publishedBy: string
  readonly assignmentCount: number
  /** One per assigned employee. Skipped today, because nothing holds a staff address. */
  readonly noticeCount: number
  readonly forecastLabourCostFils: number
  readonly forecastUnpricedEmployees: number
}

export interface RotaThresholdView {
  readonly effectiveFrom: string
  readonly openQuestionId: string | null
  readonly minimumTherapistsOnFloor: number
  readonly minimumWetRoomCapable: number
  readonly coverageSegmentMinutes: number
  readonly treatmentMinutesCapPerDay: number
  readonly highIntensityMinutesCapPerDay: number
  /** Empty in version 1, which makes the sub-cap inert. The screen says so rather than omitting it. */
  readonly highIntensityTreatmentCodes: readonly string[]
}

export interface RotaPageView {
  /**
   * The Google re-auth banner and the page a reconnect comes back to (G-CONN-08).
   *
   * Required rather than optional, for the reassignment screen's reason: an optional field would be a
   * permissive default, and the default would be the one state the banner exists to make impossible.
   */
  readonly chrome: AdminChrome
  readonly readAtIso: string
  readonly fromTradingDate: string
  readonly toTradingDate: string
  readonly published: RotaPublishedView | null
  readonly draftAssignmentCount: number
  readonly draftTherapistCount: number
  /**
   * Rostered employees holding no therapist skill, so counted towards no segment's cover.
   *
   * Printed rather than dropped. Nothing in this database says who is a therapist except `employee_skill`,
   * so this number is either the front desk (fine) or a therapist whose skills nobody has recorded (not
   * fine, and invisible otherwise — their shifts would look like cover and count for nothing).
   */
  readonly unskilledRosteredCount: number
  readonly isPublishable: boolean
  readonly violations: readonly RotaViolationView[]
  readonly shortfalls: readonly RotaShortfallView[]
  readonly segmentCount: number
  readonly forecastTotalFils: number
  readonly forecastTotalMinutes: number
  readonly unpricedEmployeeCount: number
  readonly pricedEmployeeCount: number
  readonly thresholds: RotaThresholdView
  readonly wageDivisorEffectiveFrom: string
  readonly wageDivisorOpenQuestionId: string | null
}

const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** Every colour is a token. `pnpm colours` refuses a literal hex outside the token layer (brief rule 11). */
const ROTA_CSS = `
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
  .policy, .card {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  .policy { border-inline-start-width: var(--space-2); }
  .card { background: var(--color-surface); border-color: var(--color-hairline); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  ul.rules, ul.segments { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
  ul.rules li, ul.segments li {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-inline-start: var(--space-2) solid var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-3) var(--space-5);
  }
  code { font-family: ui-monospace, monospace; }
  .empty { color: var(--color-ink-muted); }
`

/** Integer fils as AED, through the one formatter this repository has (ADR 0007). */
function asMoney(fils: number): string {
  return formatMoney(aedFrom(fils))
}

function publishedCard(view: RotaPageView): string {
  if (view.published === null) {
    return (
      '<p class="empty">Nothing has been published for this period yet. The draft below is ' +
      '<code>shift</code> and <code>shift_assignment</code>, which are rewritten freely until somebody ' +
      'publishes them.</p>'
    )
  }
  const published = view.published
  return [
    '<div class="card"><dl>',
    `<dt>Version</dt><dd>${published.versionNo}</dd>`,
    `<dt>Published</dt><dd>${safeText(DUBAI.format(new Date(published.publishedAtIso)))} Dubai, by ${safeText(published.publishedBy)}</dd>`,
    `<dt>Assignments</dt><dd>${published.assignmentCount}</dd>`,
    // The notice count, and what became of the notices. Not "5 therapists notified": nothing was sent,
    // because nothing in this build holds a staff phone or email, and a screen claiming otherwise would be
    // the stub that looks like it works (docs/12 §1).
    `<dt>Staff notices</dt><dd>${published.noticeCount} recorded, none sent — no staff phone or email is on file</dd>`,
    `<dt>Forecast</dt><dd>${safeText(asMoney(published.forecastLabourCostFils))}, with ${published.forecastUnpricedEmployees} employee(s) unpriced</dd>`,
    '</dl></div>',
  ].join('')
}

function violationList(view: RotaPageView): string {
  if (view.violations.length === 0) {
    return (
      '<p class="empty">The draft satisfies every rule and can be published. Publishing is a write with ' +
      'an actor, and there is no admin session until W-SYS-01, so it is not reachable from here.</p>'
    )
  }
  return `<ul class="rules">${view.violations
    .map(
      (violation) =>
        `<li><code>${safeText(violation.rule)}</code> — ${safeText(violation.detail)}</li>`,
    )
    .join('')}</ul>`
}

function shortfallList(view: RotaPageView): string {
  if (view.shortfalls.length === 0) {
    return `<p class="empty">Every one of the ${view.segmentCount} segments has its minimum cover.</p>`
  }
  return [
    `<p>${view.shortfalls.length} of ${view.segmentCount} segments are short.</p>`,
    `<ul class="segments">${view.shortfalls
      .map(
        (shortfall) =>
          `<li><strong>${safeText(shortfall.label)}</strong> — ${shortfall.onFloor} of ${shortfall.required} (<code>${safeText(shortfall.rule)}</code>)</li>`,
      )
      .join('')}</ul>`,
  ].join('')
}

export function renderRotaHtml(view: RotaPageView): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Rota — HR admin</title>',
    `<style>${tokensCss()}${ROTA_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Rota</h1>',
    '<div class="policy">',
    // No opening or closing TIME is written here, and that is a rule rather than a style: the hours live in
    // `premises_hours` and every consumer formats them, so a literal on a rendered surface is a second
    // source of truth that goes on showing the old time after an owner changes it.
    // `packages/db/src/seed/premises.test.ts` refuses one anywhere in apps/web or packages/ui, by the rule
    // `nap-hours-literal-outside-the-seed`, and it caught this paragraph's first draft. The real times are on
    // the page already — every segment label carries them, formatted from `business_day`.
    `<p><strong>${safeText(view.fromTradingDate)} to ${safeText(view.toTradingDate)}, read at ` +
      `${safeText(DUBAI.format(new Date(view.readAtIso)))} Dubai.</strong> Trading dates, not calendar ` +
      'dates: the premises closes after midnight, so a day’s last segments fall on the following morning ' +
      'and belong to the day that opened the evening before. The segment labels below are that day’s own ' +
      'hours, as the calendar records them.</p>',
    `<p>Coverage is judged in ${view.thresholds.coverageSegmentMinutes}-minute segments across the whole ` +
      'trading window, and a therapist counts towards a segment only if they are on the floor for the ' +
      'whole of it. A published version is immutable: an edit publishes a new one, and the old one stays ' +
      'as the record of what the rota said at the time.</p>',
    // The provisional banner. Every threshold on this screen is a guess the build made, and docs/12 §2
    // requires that to be visible where the figure is used rather than only on the assumptions panel.
    `<p><strong>Every threshold below is provisional</strong> (${safeText(view.thresholds.openQuestionId ?? 'unflagged')}, ` +
      `rules effective ${safeText(view.thresholds.effectiveFrom)}), and so are the wage divisors the ` +
      `forecast uses (${safeText(view.wageDivisorOpenQuestionId ?? 'unflagged')}, effective ` +
      `${safeText(view.wageDivisorEffectiveFrom)}). They are versioned rows rather than settings, so ` +
      'confirming them publishes a new version and leaves what this rota was judged against unchanged.</p>',
    '</div>',
    '<h2>Thresholds in force</h2>',
    '<div class="card"><dl>',
    `<dt>Therapists on the floor</dt><dd>at least ${view.thresholds.minimumTherapistsOnFloor} in every segment</dd>`,
    `<dt>Wet-room capable</dt><dd>at least ${view.thresholds.minimumWetRoomCapable} whenever the wet room is bookable</dd>`,
    `<dt>Treatment minutes a day</dt><dd>${view.thresholds.treatmentMinutesCapPerDay} per therapist</dd>`,
    // The inert sub-cap, stated. An empty list is the honest answer to Y9-coverage — no service in the
    // catalogue is recorded as heavy work — and a screen that printed the 240 without saying the list is
    // empty would report a protection nobody has.
    `<dt>High-intensity minutes a day</dt><dd>${view.thresholds.highIntensityMinutesCapPerDay} per therapist, ` +
      (view.thresholds.highIntensityTreatmentCodes.length === 0
        ? 'and <strong>no treatment is classified as high-intensity yet</strong>, so this cap cannot fire'
        : `over ${safeText(view.thresholds.highIntensityTreatmentCodes.join(', '))}`) +
      '</dd>',
    '</dl></div>',
    '<h2>Published</h2>',
    publishedCard(view),
    '<h2>The draft</h2>',
    `<p>${view.draftAssignmentCount} assignment(s) across ${view.draftTherapistCount} therapist(s). ` +
      `${view.isPublishable ? 'Publishable.' : `Refused by ${view.violations.length} rule breach(es).`}</p>`,
    view.unskilledRosteredCount === 0
      ? ''
      : `<p><strong>${view.unskilledRosteredCount} rostered employee(s) hold no therapist skill</strong> ` +
        'and count towards no segment’s cover. If any of them delivers treatments, their skills have not ' +
        'been recorded and the floor above is understated.</p>',
    violationList(view),
    '<h2>Coverage</h2>',
    shortfallList(view),
    '<h2>Labour-cost forecast</h2>',
    '<div class="card"><dl>',
    `<dt>Rostered minutes</dt><dd>${view.forecastTotalMinutes}</dd>`,
    `<dt>Forecast</dt><dd>${safeText(asMoney(view.forecastTotalFils))}</dd>`,
    // Always printed, never conditional. An unpriced employee contributes nothing to a sum, so a forecast
    // over a rota of unpriced therapists is 0 and reads as a free rota.
    `<dt>Priced</dt><dd>${view.pricedEmployeeCount} of ${view.pricedEmployeeCount + view.unpricedEmployeeCount} therapist(s)</dd>`,
    `<dt>Unpriced</dt><dd>${view.unpricedEmployeeCount} therapist(s) have no basic wage on file, so their ` +
      'hours are in the minutes above and their cost is in nothing below</dd>',
    '</dl></div>',
    '<p class="empty">A forecast prices the ROSTER. Payroll pays attendance, against the same minute ' +
      'buckets, so the two differ every month somebody is ill, late or asked to stay — and this figure is ' +
      'never what anybody is paid.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
