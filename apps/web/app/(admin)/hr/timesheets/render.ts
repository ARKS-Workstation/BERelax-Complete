import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'

/**
 * The timesheets screen: what each therapist actually worked against the published rota, and what is payable.
 *
 * Pure: rows in, a document out, no database and no clock. The instant the page was read at arrives in the
 * view and is printed on it, which is the rule the three HR screens next door follow — a screen that said "as
 * of now" could not produce two identical screenshots on a repeat run.
 *
 * ## Why this is a document served by a route handler and not a `page.tsx`
 *
 * The manifest's `files` list says `page.tsx`, and it is corrected in a NOTE. `apps/web/src/routes/registry.ts`
 * is in exact bijection with the filesystem and requires every **document** to be served in both locales
 * (`registry.test.ts`: "gives every document a locale"), so a `page.tsx` here would need an Arabic admin
 * document nobody has built, and it would join a screenshot matrix whose RTL half must be a real Arabic
 * route. P-HR-02's NOTE records that as the arrangement every HR surface takes, and the rota, credentials
 * and reassignment screens are all route handlers for it.
 *
 * ## The four things this screen must say, and the one it must never imply
 *
 *   1. **Which published rota version the variance was measured against.** Not decoration: the answer to "was
 *      she late on the 4th of March?" depends on what the rota said THEN, and a screen that showed a variance
 *      without naming the version would be showing a claim nobody could reproduce.
 *   2. **Every INCOMPLETE span, with the count beside the payable total, always.** An incomplete span
 *      contributes zero payable minutes, so a week where every clock-out was missed is 0 minutes and reads as
 *      a therapist who never came in. The count is not a footnote and is not conditional — `rota_version`'s
 *      unpriced count is printed the same way for the same reason.
 *   3. **Every correction, with its reason and its adjustment date.** A corrected day whose correction was
 *      invisible would be a changed payslip nobody could ask about, which is what the reason column exists
 *      for.
 *   4. **The period status.** Approved, or open; and when the accounting period is closed, the earliest date
 *      that is OPEN — because naming only the lock sends somebody to a month they also cannot use.
 *
 * And the thing it must never imply: that anybody has been PAID. The weighted figure is basis-point-minutes
 * and not money, because what an hour of a monthly wage is worth is unanswered (Y9-overtime), and a figure in
 * dirhams here would be that answer invented. P-HR-12 runs payroll.
 *
 * It names no therapist. `staff_reference` is the handle and nineteen employees have no name recorded (ADR
 * 0020, brief rule 10).
 *
 * It is READ-ONLY. A punch, a correction and an approval are all writes with an actor, and no route in this
 * application reads a staff session — `packages/auth` exists (F07) and nothing in `apps/web` imports it, which
 * is the real state the neighbouring screens misattribute to W-SYS-01. So a button here would either invent an
 * actor or write a placeholder, which `attendance_event_recorded_by_not_placeholder`,
 * `attendance_correction_corrected_by_not_placeholder` and `timesheet_approval_approved_by_not_placeholder`
 * all refuse. `route.ts` records the misattribution in full.
 */

/** One rostered span or unrostered presence, judged. Counts and times, never an identity. */
export interface TimesheetVarianceView {
  readonly tradingDate: string
  readonly outcome: string
  readonly incompleteReason: string | null
  readonly lateByMinutes: number
  readonly earlyLeaveByMinutes: number
  readonly rosteredMinutes: number
  readonly attendedMinutes: number
  /** The punch instants as Dubai wall clocks, `HH:MM`, so a 01:50 clock-out reads as 01:50. */
  readonly clockedInAt: string | null
  readonly clockedOutAt: string | null
  /** True when the clock-out came from a correction rather than from a punch. */
  readonly clockOutWasCorrected: boolean
}

export interface TimesheetCorrectionView {
  readonly tradingDate: string
  readonly adjustmentDate: string
  readonly kind: string
  readonly reason: string
  readonly correctedBy: string
}

export interface TimesheetEmployeeView {
  /** `employee.staff_reference`, the internal handle. Never a person's name. */
  readonly staffReference: string
  readonly variances: readonly TimesheetVarianceView[]
  readonly corrections: readonly TimesheetCorrectionView[]
  readonly payableMinutes: number
  readonly weightedMinuteBp: number
  readonly incompletePresenceCount: number
  readonly unrosteredPresenceCount: number
  /** Null when the period has not been approved for this employee. */
  readonly approval: {
    readonly approvedAtIso: string
    readonly approvedBy: string
    readonly payableMinutes: number
  } | null
}

export interface TimesheetGraceView {
  readonly effectiveFrom: string
  readonly openQuestionId: string | null
  readonly graceMinutesAfterStart: number
  readonly graceMinutesBeforeEnd: number
  readonly maximumPlausiblePresenceMinutes: number
  readonly punchToleranceMinutes: number
  readonly captureMethod: string
}

export interface TimesheetPageView {
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
  /**
   * The published rota version the variances were measured against, or null when none covers the period.
   *
   * Null is not an empty screen: it is the one state in which no variance can be computed at all, because
   * there is nothing immutable to compare against. The screen says so rather than showing every day as
   * UNROSTERED, which is what it would otherwise mean.
   */
  readonly rotaVersion: { readonly id: string; readonly versionNo: number } | null
  readonly employees: readonly TimesheetEmployeeView[]
  readonly grace: TimesheetGraceView
  /** From `periodStatusOn` — the one reader. `earliestOpenDate` equals `on` when the period is open. */
  readonly accountingPeriod: {
    readonly closed: boolean
    readonly periodId: string | null
    readonly earliestOpenDate: string
  }
}

const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** Every colour is a token. `pnpm colours` refuses a literal hex outside the token layer (brief rule 11). */
const TIMESHEET_CSS = `
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
  h3 { font-size: 1rem; margin: var(--space-5) 0 var(--space-2); }
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
  ul.days, ul.fixes { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-3); }
  ul.days li, ul.fixes li {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-inline-start: var(--space-2) solid var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-3) var(--space-5);
  }
  code { font-family: ui-monospace, monospace; }
  .empty { color: var(--color-ink-muted); }
`

/** Whole minutes as `7h 53m`, which is how a timesheet is read. Never a decimal hour: 7.88 reconciles to
 * nothing and invites the float this build refuses everywhere else (ADR 0007 applied to time). */
function asDuration(minutes: number): string {
  return `${Math.trunc(minutes / 60)}h ${minutes % 60}m`
}

function varianceLine(row: TimesheetVarianceView): string {
  const punches =
    row.clockedInAt === null
      ? 'no punch recorded'
      : `${safeText(row.clockedInAt)}–${row.clockedOutAt === null ? '(no clock-out)' : safeText(row.clockedOutAt)}` +
        (row.clockOutWasCorrected ? ' (clock-out supplied by a correction)' : '')
  const deviations = [
    row.lateByMinutes > 0 ? `${row.lateByMinutes}m late` : '',
    row.earlyLeaveByMinutes > 0 ? `${row.earlyLeaveByMinutes}m early` : '',
  ].filter((part) => part !== '')
  // Both figures whenever both are non-zero, because the outcome is ONE badge and the precedence puts LATE
  // above EARLY_LEAVE — so a screen printing only the badge would hide the second deviation entirely.
  const why =
    row.outcome === 'INCOMPLETE'
      ? row.incompleteReason === 'implausible_span'
        ? ' — the two punches are too far apart to be one presence, so it is unpriced until corrected'
        : ' — no clock-out, so it is unpriced until an audited correction supplies one'
      : deviations.length === 0
        ? ''
        : ` — ${deviations.join(', ')}`
  return (
    `<li><strong>${safeText(row.tradingDate)}</strong> <code>${safeText(row.outcome)}</code>${safeText(why)}` +
    `<br>${punches}; rostered ${asDuration(row.rosteredMinutes)}, attended ` +
    `${asDuration(row.attendedMinutes)}</li>`
  )
}

function employeeSection(employee: TimesheetEmployeeView): string {
  const approval =
    employee.approval === null
      ? '<p class="empty">Not approved. The period is open, so a punch may still be recorded for it.</p>'
      : `<p><strong>Approved</strong> ${safeText(DUBAI.format(new Date(employee.approval.approvedAtIso)))} ` +
        `Dubai by ${safeText(employee.approval.approvedBy)}, at ` +
        `${asDuration(employee.approval.payableMinutes)} payable. The period is LOCKED: a new punch for it ` +
        'is refused, and the only change is a dated correction.</p>'
  return [
    `<h3>${safeText(employee.staffReference)}</h3>`,
    '<div class="card"><dl>',
    `<dt>Payable</dt><dd>${asDuration(employee.payableMinutes)} (${employee.payableMinutes} minutes)</dd>`,
    // Always printed, never conditional, and for `rota_version.forecast_unpriced_employees`'s reason: an
    // incomplete span contributes nothing, so a week of missed clock-outs is 0 minutes and reads as somebody
    // who never came in.
    `<dt>Incomplete</dt><dd>${employee.incompletePresenceCount} span(s) contributed nothing because an end ` +
      'was unknown or not believed</dd>',
    `<dt>Unrostered</dt><dd>${employee.unrosteredPresenceCount} span(s) the published rota rostered nobody ` +
      'for. The minutes ARE payable — somebody who worked is paid — and the roster is what needs fixing</dd>',
    // Basis-point-minutes and not money, deliberately: see the header. A dirham figure here would answer
    // Y9-overtime by inventing it.
    `<dt>Weighted</dt><dd>${employee.weightedMinuteBp} basis-point-minutes, which is not money: what an ` +
      'hour of a monthly wage is worth is unanswered, and payroll is P-HR-12’s</dd>',
    '</dl></div>',
    approval,
    employee.variances.length === 0
      ? '<p class="empty">Nothing rostered and nothing punched in this period.</p>'
      : `<ul class="days">${employee.variances.map(varianceLine).join('')}</ul>`,
    employee.corrections.length === 0
      ? ''
      : [
          '<h3 class="empty">Corrections</h3>',
          `<ul class="fixes">${employee.corrections
            .map(
              (fix) =>
                `<li><strong>${safeText(fix.tradingDate)}</strong> <code>${safeText(fix.kind)}</code>, ` +
                `adjusted on ${safeText(fix.adjustmentDate)} by ${safeText(fix.correctedBy)} — ` +
                `${safeText(fix.reason)}</li>`,
            )
            .join('')}</ul>`,
        ].join(''),
  ].join('')
}

export function renderTimesheetsHtml(view: TimesheetPageView): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's "brand collision" forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Timesheets — HR admin</title>',
    `<style>${tokensCss()}${TIMESHEET_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Timesheets</h1>',
    '<div class="policy">',
    // No opening or closing TIME is written here, and that is a rule rather than a style: the hours live in
    // `premises_hours` and every consumer formats them, so a literal on a rendered surface is a second source
    // of truth that goes on showing the old time after an owner changes it.
    // `packages/db/src/seed/premises.test.ts` refuses one anywhere in apps/web or packages/ui.
    `<p><strong>${safeText(view.fromTradingDate)} to ${safeText(view.toTradingDate)}, read at ` +
      `${safeText(DUBAI.format(new Date(view.readAtIso)))} Dubai.</strong> Trading dates, not calendar ` +
      'dates: the premises closes after midnight, so a clock-out in the small hours belongs to the day that ' +
      'opened the evening before. Each day’s punch times below are that day’s own wall clock.</p>',
    view.rotaVersion === null
      ? '<p><strong>No published rota covers this period, so no variance can be computed.</strong> ' +
        'Attendance is measured against a published version and never against the draft, because a draft ' +
        'is rewritten freely — a variance measured against one would change after the fact. Publish the ' +
        'rota for these dates first.</p>'
      : `<p>Measured against published rota version ${view.rotaVersion.versionNo}, which is immutable. ` +
        'That is the whole point: an edit publishes a NEW version, so what this timesheet was judged ' +
        'against stays true after the roster changes.</p>',
    view.accountingPeriod.closed
      ? `<p><strong>The accounting period covering these dates is closed</strong> ` +
        `(${safeText(String(view.accountingPeriod.periodId))}). No punch may be recorded for it, and a ` +
        `correction must be dated on or after ${safeText(view.accountingPeriod.earliestOpenDate)}, which ` +
        'is the earliest OPEN date.</p>'
      : '<p>The accounting period covering these dates is open.</p>',
    // The provisional banner. Every figure the variance is judged against is a guess the build made, and
    // docs/12 §2 requires that to be visible where the figure is used rather than only on the panel.
    `<p><strong>Every figure below is provisional</strong> ` +
      `(${safeText(view.grace.openQuestionId ?? 'unflagged')}, effective ` +
      `${safeText(view.grace.effectiveFrom)}). They are versioned rows rather than settings, so confirming ` +
      'them publishes a new version and leaves what an approved timesheet was judged against unchanged.</p>',
    '</div>',
    '<h2>Figures in force</h2>',
    '<div class="card"><dl>',
    `<dt>Grace, arriving</dt><dd>${view.grace.graceMinutesAfterStart} minute(s) after the rostered start</dd>`,
    `<dt>Grace, leaving</dt><dd>${view.grace.graceMinutesBeforeEnd} minute(s) before the rostered end</dd>`,
    `<dt>Believed as one presence</dt><dd>up to ${asDuration(view.grace.maximumPlausiblePresenceMinutes)}. ` +
      'A clock-in and clock-out further apart than that are not treated as one shift, so a forgotten ' +
      'clock-out closed the next morning is unpriced rather than paid</dd>',
    `<dt>Punch tolerance</dt><dd>${view.grace.punchToleranceMinutes} minute(s) outside the trading window, ` +
      'because staff arrive before the doors open and the cash-up runs after close</dd>',
    // Stated on the face of the screen, because "there is no reader" is itself an answer somebody has to
    // confirm — and the day one is bought, a new rule version records it rather than silently changing what
    // every historical row meant.
    `<dt>Captured by</dt><dd><code>${safeText(view.grace.captureMethod)}</code> — the front desk types it. ` +
      'There is no biometric reader and no device integration</dd>',
    '</dl></div>',
    '<h2>By therapist</h2>',
    view.employees.length === 0
      ? '<p class="empty">Nobody was rostered and nobody punched in this period.</p>'
      : view.employees.map(employeeSection).join(''),
    '<p class="empty">Payable minutes are the same minute buckets the rota forecast uses, over what was ' +
      'ATTENDED rather than what was rostered — so the two differ every period somebody is ill, late or ' +
      'asked to stay. Nothing on this page is money: payroll is P-HR-12’s.</p>',
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
