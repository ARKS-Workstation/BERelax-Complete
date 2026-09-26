import { loadConfig } from '@berelax/config'
import {
  describeRotaViolation,
  forecastLabourCost,
  instantFromIso,
  type LabourCostRules,
  labourCostRulesFor,
  localDate,
  localTime,
  type RosteredShift,
  type RotaCoverageRules,
  type RotaTherapist,
  type RotaTradingDay,
  rotaCoverageRulesFor,
  validateRota,
  type WorkingHoursRules,
} from '@berelax/core'
import {
  createConnection,
  type LabourCostRuleRow,
  type RotaCoverageRuleRow,
  readCredentialPolicy,
  readCurrentRotaVersion,
  readEmployeeCredentials,
  readLabourCostRules,
  readRosteredShifts,
  readRotaCoverageRules,
  readRotaPublicationNotices,
  readRotaTherapists,
  readRotaVersionAssignments,
  readTradingDayWindows,
  readTreatmentLoads,
  readWetRoomBookableWindows,
  readWetRoomSkills,
  readWorkingHoursRules,
  type Sql,
  type WorkingHoursRuleRow,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { type RotaPageView, type RotaShortfallView, renderRotaHtml } from './render.ts'

/**
 * The rota screen (P-HR-06): what is published for a period, what the draft would refuse, what it costs.
 *
 * The rows come from `@berelax/db` and every JUDGEMENT from `@berelax/core`. That split is the unit's, not a
 * style: `packages/db` may not import `packages/core`, so the composition happens here — read, validate,
 * forecast, render — and `packages/fixtures/src/hr-rota.itest.ts` asserts the same composition against real
 * PostgreSQL. Nothing in this file decides anything a rule could decide.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, exactly as the credentials
 * and reassignment screens next door record. It is READ-ONLY — GET, no mutation — so there is no actor to
 * record and none is invented: `rota_version_published_by_not_placeholder` would refuse a placeholder, which
 * is the constraint doing what a comment could not.
 *
 * The period comes from the query string and defaults to the seven trading dates from `from`, because a rota
 * is always asked about a week. An unbounded read would be a page that gets slower every month.
 */
export const dynamic = 'force-dynamic'

/** A rota is a week. Bounded, and the bound is small, because the page draws a segment grid per day. */
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

/** `YYYY-MM-DD` or nothing. Rejected rather than coerced: a half-parsed date is a rota for another week. */
function parseDate(raw: string | null): string | null {
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

function addDays(date: string, days: number): string {
  const stepped = new Date(`${date}T00:00:00Z`)
  stepped.setUTCDate(stepped.getUTCDate() + days)
  return stepped.toISOString().slice(0, 10)
}

const asCoverageRules = (row: RotaCoverageRuleRow): RotaCoverageRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  coverageSegmentMinutes: row.coverageSegmentMinutes,
  minimumTherapistsOnFloor: row.minimumTherapistsOnFloor,
  minimumWetRoomCapable: row.minimumWetRoomCapable,
  treatmentMinutesCapPerDay: row.treatmentMinutesCapPerDay,
  highIntensityMinutesCapPerDay: row.highIntensityMinutesCapPerDay,
  highIntensityTreatmentCodes: row.highIntensityTreatmentCodes,
})

const asLabourCostRules = (row: LabourCostRuleRow): LabourCostRules => ({
  effectiveFrom: localDate(row.effectiveFrom),
  monthlyWageDaysDivisor: row.monthlyWageDaysDivisor,
  paidMinutesPerDay: row.paidMinutesPerDay,
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
      // One connection for the chrome and the rota, for the reassignment screen's reason: a second pool
      // would make one page load two connections, and the integration suite opens 64 of its own.
      const chrome = await adminChromeFor({ sql, now: instantFromIso(readAtIso), request })
      const [
        windows,
        therapistRows,
        coverageRuleRows,
        workingHoursRows,
        labourRows,
        wetRoomSkills,
        wetWindows,
        loads,
        policy,
        shiftRows,
        currentVersion,
      ] = await Promise.all([
        readTradingDayWindows(sql, range),
        readRotaTherapists(sql, range),
        readRotaCoverageRules(sql),
        readWorkingHoursRules(sql),
        readLabourCostRules(sql),
        readWetRoomSkills(sql),
        readWetRoomBookableWindows(sql, range),
        readTreatmentLoads(sql, range),
        readCredentialPolicy(sql),
        readRosteredShifts(sql, range),
        readCurrentRotaVersion(sql, range),
      ])

      const rostered = new Set(shiftRows.map((row) => row.employeeId))
      // `readRotaTherapists` returns only employees holding a therapist skill, because coverage counts
      // therapists and nothing in this database says who is one except `employee_skill`. A rostered employee
      // without a skill row is therefore NOT a therapist — front desk, or somebody whose skills have not
      // been recorded yet — and is excluded from the validator's roster and from its assignments, because
      // passing them would refuse the whole call. Counted and printed instead, so an unrecorded skill shows
      // up as a number on the screen rather than as cover nobody has.
      const therapistIds = new Set(
        therapistRows.filter((row) => rostered.has(row.employeeId)).map((row) => row.employeeId),
      )
      const unskilledRosteredCount = [...rostered].filter((id) => !therapistIds.has(id)).length
      const credentials = await readEmployeeCredentials(sql, [...rostered])
      const therapists: RotaTherapist[] = therapistRows
        .filter((row) => therapistIds.has(row.employeeId))
        .map((row) => ({
          employeeId: row.employeeId,
          skills: row.skills,
          credentials: credentials
            .filter((credential) => credential.employeeId === row.employeeId)
            .map((credential) => ({
              documentType: credential.documentType,
              expiresOn: credential.expiresOn === null ? null : localDate(credential.expiresOn),
            })),
        }))

      const tradingDays: RotaTradingDay[] = windows.map((window) => ({
        tradingDate: localDate(window.tradingDate),
        opensAt: window.opensAt as RotaTradingDay['opensAt'],
        closesAt: window.closesAt as RotaTradingDay['closesAt'],
        wetRoomBookableDuring: wetWindows
          .filter((wet) => wet.tradingDate === window.tradingDate)
          .map(
            (wet) =>
              ({
                startsAt: wet.startsAt,
                endsAt: wet.endsAt,
              }) as RotaTradingDay['wetRoomBookableDuring'][number],
          ),
        // The holiday flag is an ARGUMENT (P-HR-05's NOTE): `premises_closure` is a floor and not a
        // calendar, so this screen states it rather than deriving a set it knows is incomplete. A holiday
        // the premises trades through has no closure row, and Y9-overtime is what fills the gap.
        isPublicHoliday: false,
      }))
      const known = new Set(tradingDays.map((day) => String(day.tradingDate)))
      const assignments: RosteredShift[] = shiftRows
        // A shift whose trading date has no `business_day` row inside the requested range cannot happen —
        // `shift.trading_date` is a foreign key — but a shift on a date OUTSIDE the range can, when the
        // reader's range and the window reader's disagree. Narrowed rather than passed, because the
        // validator refuses an assignment on a day it was not given, and a 500 on an admin screen for a
        // date arithmetic disagreement is the wrong failure.
        .filter((row) => known.has(row.tradingDate) && therapistIds.has(row.employeeId))
        .map((row) => ({
          shiftId: row.shiftId,
          employeeId: row.employeeId,
          tradingDate: localDate(row.tradingDate),
          period: { startsAt: row.startsAt, endsAt: row.endsAt } as RosteredShift['period'],
        }))

      const coverageRuleVersions = coverageRuleRows.map(asCoverageRules)
      const validation = validateRota({
        days: tradingDays,
        therapists,
        assignments,
        treatmentLoads: loads
          .filter((load) => known.has(load.tradingDate) && therapistIds.has(load.employeeId))
          .map((load) => ({
            appointmentId: load.appointmentId,
            employeeId: load.employeeId,
            tradingDate: localDate(load.tradingDate),
            minutes: load.minutes,
            treatmentCode: load.treatmentCode,
          })),
        coverageRuleVersions,
        workingHoursRuleVersions: workingHoursRows.map(asWorkingHoursRules),
        wetRoomSkills,
        credentialPolicy: policy,
      })

      const forecast = forecastLabourCost({
        days: validation.workedHours.days,
        wages: therapists.map((therapist) => ({
          employeeId: therapist.employeeId,
          basicWageFils:
            therapistRows.find((row) => row.employeeId === therapist.employeeId)?.basicWageFils ??
            null,
        })),
        ruleVersions: labourRows.map(asLabourCostRules),
      })

      // The two segment-shaped refusals, flattened into the one list the screen draws. The callback's
      // return type is annotated, so a third segment rule added later is a type error here rather than a
      // shortfall the screen silently stops drawing.
      const shortfalls: RotaShortfallView[] = validation.violations.flatMap(
        (violation): RotaShortfallView[] => {
          if (violation.rule === 'minimum_floor_coverage') {
            return [
              {
                label: violation.segmentLabel,
                rule: violation.rule,
                onFloor: violation.onFloor,
                required: violation.required,
              },
            ]
          }
          if (violation.rule === 'wet_room_capability') {
            return [
              {
                label: violation.segmentLabel,
                rule: violation.rule,
                // The CAPABLE count and not the floor count: the claim this row makes is "nobody on the
                // floor can run the bath", and printing the floor size would say the opposite.
                onFloor: violation.capableOnFloor,
                required: violation.required,
              },
            ]
          }
          return []
        },
      )

      const published = currentVersion
      const publishedView =
        published === null
          ? null
          : {
              versionNo: published.versionNo,
              publishedAtIso: published.publishedAt.toISOString(),
              publishedBy: published.publishedBy,
              assignmentCount: (await readRotaVersionAssignments(sql, published.id)).length,
              noticeCount: (await readRotaPublicationNotices(sql, published.id)).length,
              forecastLabourCostFils: published.forecastLabourCostFils,
              forecastUnpricedEmployees: published.forecastUnpricedEmployees,
            }

      // The rule version governing the FIRST day of the range, which is the one the screen's threshold
      // panel describes. A range spanning a threshold change describes the earlier version, deliberately:
      // it is the version the first breach is judged against, and the validator reads the right one per day
      // regardless of what this panel says.
      const firstDay = tradingDays[0]?.tradingDate ?? localDate(fromTradingDate)
      const thresholdRow = rotaCoverageRulesFor(coverageRuleVersions, firstDay)
      const coverageProvenance = coverageRuleRows.find(
        (row) => row.effectiveFrom === String(thresholdRow.effectiveFrom),
      )
      const wageRow = labourCostRulesFor(labourRows.map(asLabourCostRules), firstDay)
      const wageProvenance = labourRows.find(
        (row) => row.effectiveFrom === String(wageRow.effectiveFrom),
      )

      const page: RotaPageView = {
        chrome,
        readAtIso,
        fromTradingDate,
        toTradingDate,
        published: publishedView,
        draftAssignmentCount: assignments.length,
        draftTherapistCount: new Set(assignments.map((shift) => shift.employeeId)).size,
        unskilledRosteredCount,
        isPublishable: validation.isPublishable,
        violations: validation.violations.map((violation) => ({
          rule: violation.rule,
          detail: describeRotaViolation(violation),
        })),
        shortfalls,
        segmentCount: validation.segments.length,
        forecastTotalFils: forecast.totalFils,
        forecastTotalMinutes: forecast.totalMinutes,
        unpricedEmployeeCount: forecast.unpricedEmployeeIds.length,
        pricedEmployeeCount: forecast.pricedEmployeeIds.length,
        thresholds: {
          effectiveFrom: String(thresholdRow.effectiveFrom),
          openQuestionId: coverageProvenance?.openQuestionId ?? null,
          minimumTherapistsOnFloor: thresholdRow.minimumTherapistsOnFloor,
          minimumWetRoomCapable: thresholdRow.minimumWetRoomCapable,
          coverageSegmentMinutes: thresholdRow.coverageSegmentMinutes,
          treatmentMinutesCapPerDay: thresholdRow.treatmentMinutesCapPerDay,
          highIntensityMinutesCapPerDay: thresholdRow.highIntensityMinutesCapPerDay,
          highIntensityTreatmentCodes: thresholdRow.highIntensityTreatmentCodes,
        },
        wageDivisorEffectiveFrom: String(wageRow.effectiveFrom),
        wageDivisorOpenQuestionId: wageProvenance?.openQuestionId ?? null,
      }
      return page
    })

    return new Response(renderRotaHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached rota outlives the draft: a shift moved five minutes ago would still be on
        // it, and somebody would publish a rota they had already changed.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looked like an empty
    // rota would say "nobody is rostered" when the truth is "nothing could be read" — which for a coverage
    // screen is the one failure it must never have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The rota could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
