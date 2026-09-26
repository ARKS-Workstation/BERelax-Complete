import { loadConfig } from '@berelax/config'
import {
  type AttendanceGraceRules,
  attendanceGraceFor,
  type Instant,
  instantFromIso,
  localDate,
  localTime,
  summariseTimesheet,
  toLocal,
  type WorkingHoursRules,
} from '@berelax/core'
import {
  type AttendanceGraceRuleRow,
  createConnection,
  periodStatusOn,
  readAttendanceCorrections,
  readAttendanceGraceRules,
  readAttendancePunches,
  readCurrentRotaVersion,
  readRosteredSpansFromVersion,
  readTimesheetApprovals,
  readWorkingHoursRules,
  type Sql,
  type WorkingHoursRuleRow,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import {
  renderTimesheetsHtml,
  type TimesheetCorrectionView,
  type TimesheetEmployeeView,
  type TimesheetPageView,
  type TimesheetVarianceView,
} from './render.ts'

/**
 * The timesheets screen (P-HR-07): what each therapist worked against the published rota, and what is payable.
 *
 * The rows come from `@berelax/db` and every JUDGEMENT from `@berelax/core`. That split is the unit's, not a
 * style: `packages/db` may not import `packages/core`, so the composition happens here — read, derive, render —
 * and `packages/fixtures/src/hr-attendance.itest.ts` asserts the same composition against real PostgreSQL.
 * Nothing in this file decides anything a rule could decide, and nothing in it computes a minute.
 *
 * **This route is not authenticated, and the reason the three HR screens next door give for that is wrong.**
 * They say "there is no admin session until W-SYS-01". W-SYS-01 is the app shell — route groups, Tailwind
 * token mapping and the four self-hosted faces — and it is `done`; it was never going to provide a session.
 * F07 ("staff auth with mandatory TOTP and the RBAC policy layer") is `done` too, so the primitives exist in
 * `packages/auth`. What is actually missing is that **nothing in `apps/web` imports `@berelax/auth`** — no
 * route in this application reads a staff session, so no route handler has an actor to record. The
 * arrangement is therefore the same as the neighbours' and the citation is not; P-HR-07 reports the wrong one
 * rather than repeating it.
 *
 * It is READ-ONLY — GET, no mutation — so there is no actor to record and none is invented: three separate
 * constraints refuse a placeholder actor on a punch, a correction and an approval, which is the schema doing
 * what a comment could not.
 *
 * ## Why the period comes from the query string and defaults to a week
 *
 * A timesheet is asked about a period, and the period is the unit of approval. An unbounded read would be a
 * page that gets slower every month and a variance list nobody can read; the rota screen bounds itself the
 * same way and for the same reason.
 *
 * ## The one state this screen has to refuse to guess about
 *
 * **No published rota version covering the period.** Every variance is measured against
 * `rota_version_assignment`, so with no version there is nothing to compare against — and the screen says so
 * rather than rendering every day as `UNROSTERED`, which is what an empty roster would silently mean. That is
 * the same choice `readWetRoomBookableWindows` forced on P-HR-06: a rule that quietly stops checking is the
 * invisible error, and a visible statement is the alternative.
 */
export const dynamic = 'force-dynamic'

/** A timesheet is a week. Bounded, and the bound is small, because the page draws a row per span per day. */
const DEFAULT_DAYS = 7
const MAX_DAYS = 31

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** `YYYY-MM-DD` or nothing. Rejected rather than coerced: a half-parsed date is a timesheet for another week. */
function parseDate(raw: string | null): string | null {
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

function addDays(date: string, days: number): string {
  const stepped = new Date(`${date}T00:00:00Z`)
  stepped.setUTCDate(stepped.getUTCDate() + days)
  return stepped.toISOString().slice(0, 10)
}

const asGraceRules = (row: AttendanceGraceRuleRow): AttendanceGraceRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  graceMinutesAfterStart: row.graceMinutesAfterStart,
  graceMinutesBeforeEnd: row.graceMinutesBeforeEnd,
  maximumPlausiblePresenceMinutes: row.maximumPlausiblePresenceMinutes,
  punchToleranceMinutes: row.punchToleranceMinutes,
})

const asWorkingHoursRules = (row: WorkingHoursRuleRow): WorkingHoursRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  ordinaryMinutesPerDay: row.ordinaryMinutesPerDay,
  ordinaryMinutesPerWeek: row.ordinaryMinutesPerWeek,
  weekStartsOn: row.weekStartsOn,
  overtimeDailyCapMinutes: row.overtimeDailyCapMinutes,
  minimumRestMinutes: row.minimumRestMinutes,
  nightWindow: { from: localTime(row.nightWindowFrom), until: localTime(row.nightWindowUntil) },
  multiplierBp: {
    ordinary: row.ordinaryMultiplierBp,
    overtime: row.overtimeMultiplierBp,
    night: row.nightMultiplierBp,
    publicHoliday: row.publicHolidayMultiplierBp,
  },
})

/**
 * A punch instant as a Dubai wall clock, `HH:MM`.
 *
 * Through `toLocal` and never through `toISOString().slice(11, 16)`, which reports 21:50 for a 01:50-Dubai
 * clock-out — the previous day, at the wrong time. P-HR-06 had a test pass for exactly that reason, and this
 * is the surface where it would be read by a person rather than by an assertion.
 */
function dubaiTime(instant: Instant): string {
  return toLocal(instant).time
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const readAtIso = new Date().toISOString()
    const fromTradingDate = parseDate(url.searchParams.get('from')) ?? readAtIso.slice(0, 10)
    const requestedDays = Number(url.searchParams.get('days') ?? '')
    const days =
      Number.isInteger(requestedDays) && requestedDays > 0
        ? Math.min(requestedDays, MAX_DAYS)
        : DEFAULT_DAYS
    const toTradingDate = addDays(fromTradingDate, days - 1)
    const range = { fromTradingDate, toTradingDate }

    const view = await withSql(async (sql) => {
      // One connection for the chrome and the timesheets, for the reassignment screen's reason: a second pool
      // would make one page load two connections, and the integration suite opens 64 of its own.
      const chrome = await adminChromeFor({ sql, now: instantFromIso(readAtIso), request })
      const [graceRows, rateRows, currentVersion, status] = await Promise.all([
        readAttendanceGraceRules(sql),
        readWorkingHoursRules(sql),
        readCurrentRotaVersion(sql, range),
        // The ONE reader of the period lock (M-VAT-06). Read here so the screen can name the earliest OPEN
        // date as data rather than as text somebody has to parse out of a refusal they have not seen yet.
        periodStatusOn(sql, fromTradingDate),
      ])
      const graceVersions = graceRows.map(asGraceRules)
      const rateVersions = rateRows.map(asWorkingHoursRules)
      const grace = attendanceGraceFor(graceVersions, localDate(fromTradingDate))
      const graceProvenance = graceRows.find(
        (row) => row.effectiveFrom === String(grace.effectiveFrom),
      )

      const [punches, corrections, approvals] = await Promise.all([
        readAttendancePunches(sql, range),
        readAttendanceCorrections(sql, range),
        readTimesheetApprovals(sql, range),
      ])
      const rostered =
        currentVersion === null
          ? []
          : await readRosteredSpansFromVersion(sql, { rotaVersionId: currentVersion.id })

      // Everybody who appears on either side. A therapist rostered and absent has to be on this screen, and
      // so has somebody who punched with nothing rostered — the two are the outcomes the unit exists to name.
      const employeeIds = [
        ...new Set([
          ...rostered.map((row) => row.employeeId),
          ...punches.map((row) => row.employeeId),
        ]),
      ]
      const references =
        employeeIds.length === 0
          ? []
          : await sql<{ id: string; staffReference: string }[]>`
              select id, staff_reference as "staffReference" from employee
               where id = any(${employeeIds}::uuid[])
            `
      // The handle and never a name: nineteen employees have no name recorded (ADR 0020, brief rule 10).
      const referenceOf = new Map(references.map((row) => [row.id, row.staffReference]))

      const employees: TimesheetEmployeeView[] = employeeIds
        .map((employeeId): TimesheetEmployeeView => {
          const summary = summariseTimesheet({
            employeeId,
            fromTradingDate: localDate(fromTradingDate),
            toTradingDate: localDate(toTradingDate),
            rostered: rostered.map((row) => ({
              employeeId: row.employeeId,
              tradingDate: localDate(row.tradingDate),
              startsAt: row.startsAt as Instant,
              endsAt: row.endsAt as Instant,
            })),
            punches: punches.map((row) => ({
              eventId: row.eventId,
              employeeId: row.employeeId,
              tradingDate: localDate(row.tradingDate),
              kind: row.kind,
              occurredAt: row.occurredAt as Instant,
              correctionId: null,
            })),
            corrections: corrections.map((row) => ({
              correctionId: row.correctionId,
              employeeId: row.employeeId,
              tradingDate: localDate(row.tradingDate),
              adjustmentDate: localDate(row.adjustmentDate),
              kind: row.kind,
              correctsEventId: row.correctsEventId,
              correctedOccurredAt: row.correctedOccurredAt as Instant,
            })),
            graceRuleVersions: graceVersions,
            workingHoursRuleVersions: rateVersions,
          })
          const variances: TimesheetVarianceView[] = summary.variances.map((row) => {
            const first = row.presences[0]
            const last = row.presences[row.presences.length - 1]
            return {
              tradingDate: String(row.tradingDate),
              outcome: row.outcome,
              incompleteReason: row.incompleteReason,
              lateByMinutes: row.lateByMinutes,
              earlyLeaveByMinutes: row.earlyLeaveByMinutes,
              rosteredMinutes: row.rosteredMinutes,
              attendedMinutes: row.attendedMinutes,
              clockedInAt: first === undefined ? null : dubaiTime(first.startsAt),
              clockedOutAt:
                last === undefined || last.endsAt === null ? null : dubaiTime(last.endsAt),
              // The supplied clock-out carries a `correction:` event id rather than a uuid, which is what
              // makes a corrected day visible as one instead of a figure that silently differs from the
              // punches underneath it.
              clockOutWasCorrected: last?.clockOutEventId?.startsWith('correction:') ?? false,
            }
          })
          const approval = approvals.find((row) => row.employeeId === employeeId) ?? null
          const mine: TimesheetCorrectionView[] = corrections
            .filter((row) => row.employeeId === employeeId)
            .map((row) => ({
              tradingDate: row.tradingDate,
              adjustmentDate: row.adjustmentDate,
              kind: row.kind,
              reason: row.reason,
              correctedBy: row.correctedBy,
            }))
          return {
            staffReference: referenceOf.get(employeeId) ?? employeeId,
            variances,
            corrections: mine,
            payableMinutes: summary.payableMinutes,
            weightedMinuteBp: summary.weightedMinuteBp,
            incompletePresenceCount: summary.incompletePresenceCount,
            unrosteredPresenceCount: summary.variances.filter((row) => row.outcome === 'UNROSTERED')
              .length,
            approval:
              approval === null
                ? null
                : {
                    approvedAtIso: approval.approvedAt.toISOString(),
                    approvedBy: approval.approvedBy,
                    payableMinutes: approval.payableMinutes,
                  },
          }
        })
        // By the handle, so two reads of the same period draw the same page. Ordering by insertion would make
        // the list depend on which employee happened to punch first.
        .sort((a, b) => (a.staffReference < b.staffReference ? -1 : 1))

      const page: TimesheetPageView = {
        chrome,
        readAtIso,
        fromTradingDate,
        toTradingDate,
        rotaVersion:
          currentVersion === null
            ? null
            : { id: currentVersion.id, versionNo: currentVersion.versionNo },
        employees,
        grace: {
          effectiveFrom: String(grace.effectiveFrom),
          openQuestionId: graceProvenance?.openQuestionId ?? null,
          graceMinutesAfterStart: grace.graceMinutesAfterStart,
          graceMinutesBeforeEnd: grace.graceMinutesBeforeEnd,
          maximumPlausiblePresenceMinutes: grace.maximumPlausiblePresenceMinutes,
          punchToleranceMinutes: grace.punchToleranceMinutes,
          captureMethod: graceProvenance?.captureMethod ?? 'manual_front_desk',
        },
        accountingPeriod: {
          closed: status.closed,
          periodId: status.periodId,
          earliestOpenDate: status.earliestOpenDate,
        },
      }
      return page
    })

    return new Response(renderTimesheetsHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached timesheet outlives the punches: a clock-out entered a minute ago would be
        // missing from it, and somebody would approve a period they had already corrected.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looked like an empty
    // timesheet would say "nobody worked" when the truth is "nothing could be read" — which for a screen
    // somebody approves pay from is the one failure it must never have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The timesheets could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
