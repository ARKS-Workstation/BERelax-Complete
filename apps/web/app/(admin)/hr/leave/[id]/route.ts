import { loadConfig } from '@berelax/config'
import {
  ASIA_DUBAI,
  can,
  coverageBreachesCausedBy,
  type FloorPresence,
  type HeldCredential,
  instantFromIso,
  LEAVE_APPROVAL_PERMISSION,
  localDate,
  localTime,
  mayOverrideLeaveConflict,
  type Period,
  ROLES,
  type Role,
  type RotaCoverageRules,
  type RotaTherapist,
  type RotaTradingDay,
  toLocal,
  type WorkingHoursRules,
} from '@berelax/core'
import {
  createConnection,
  type FloorPresenceRow,
  type RotaCoverageRuleRow,
  readCredentialPolicy,
  readEmployeeCredentials,
  readFloorPresence,
  readLeaveApprovalConflicts,
  readLeaveRequest,
  readLiveLeaveApproval,
  readRotaCoverageRules,
  readRotaTherapists,
  readTradingDatesCovering,
  readTradingDayWindows,
  readWetRoomBookableWindows,
  readWetRoomSkills,
  readWorkingHoursRules,
  type Sql,
  type WorkingHoursRuleRow,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../../src/components/admin/google-reauth-source.ts'
import {
  type LeaveApprovalPageView,
  type LeaveConflictView,
  type LeaveCoverageBreachView,
  renderLeaveApprovalHtml,
} from './render.ts'

/**
 * `GET /hr/leave/[id]` — one leave request, its conflicting appointments, and what approving it would cost
 * the floor (P-HR-09).
 *
 * The rows come from `@berelax/db` and every JUDGEMENT from `@berelax/core`: the coverage answer is
 * `coverageBreachesCausedBy`, which is `validateRota` called twice, and the authorisation is `can()` over the
 * F07 matrix. Nothing is decided here. That split is what makes this page and the transaction agree about
 * whether an approval is possible — a screen with its own coverage arithmetic would print one answer while
 * `approveLeaveRequest` refused for another.
 *
 * ## Read-only, and what is actually missing
 *
 * There is no approve button, no override form and no withdraw control, and the reason is specific rather
 * than "authentication is not built". `packages/auth` exists and is done; **nothing in `apps/web` imports
 * it**, which is the state the HR screens beside this one variously attribute to W-SYS-01 and W-SYS-11. So a
 * write here would have to invent a staff member to attribute it to, and migration 0092 refuses exactly that:
 * `leave_approval.approver_role`, `leave_conflict_override.actor_label` and
 * `leave_approval_cancellation.cancelled_by` are all refused a placeholder, so the write would fail at the
 * database rather than quietly record a decision nobody took.
 *
 * W-SYS-11 is building the real admin session now. When it lands, `role` comes from that session instead of
 * from the query, and nothing else in this file changes — which is the point of taking it as an argument.
 *
 * ## `?role=` can only NARROW, and that is what makes it safe to take from a query
 *
 * A role IS a permission, so taking one from a query string would be an escalation with a query string. The
 * decision is therefore taken for the claimed role and then intersected with {@link CEILING_ROLE}'s, exactly
 * as `/clients/[id]/flags` does one directory group along. Every consequence follows from that intersection:
 *
 *   - `?role=owner` does not unlock a write, because there is no write on this page at all.
 *   - `?role=owner` does not widen what is SHOWN either: the ceiling is `manager`, which holds
 *     `leave:approve` and `employee:read`, so the widest reader this page will serve is a floor manager.
 *   - `?role=therapist` and `?role=marketer` are narrowings, and a marketer is refused the conflict report —
 *     which names a customer and a service, and is the one thing on this page that is somebody else's
 *     business.
 *   - An unrecognised role STRING is a 400 rather than a fall back to the ceiling: falling back would serve
 *     the page to a caller whose role nobody recognised, and they would never learn their role was a typo.
 *
 * The page reports a REFUSED reader as a page rather than as a 403, because "you may not see this" is
 * information the operator needs on the screen they are on, and the withheld version names nobody.
 *
 * ## Dynamic, never cached
 *
 * The conflict report and the coverage answer are both claims about rows a reassignment changes minute by
 * minute. A prerendered copy would show a conflict somebody had already resolved, and an operator would go
 * looking for an appointment that has moved.
 */
export const dynamic = 'force-dynamic'

/**
 * The widest reader this page serves until there is a session.
 *
 * `manager` and not `owner`, which is the narrower of the two available ceilings: the manager holds
 * `leave:approve` and `employee:read`, which is everything this page needs to show, and nothing an owner holds
 * beyond that is on it. A ceiling of `owner` would be a wider grant that bought nothing.
 */
const CEILING_ROLE: Role = 'manager'

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value)

/** The Y9-coverage id, printed on the face of the screen beside the figure it governs (docs/12 §2). */
const COVERAGE_OPEN_QUESTION = 'Y9-coverage'

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
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

/** `2086-03-18 01:30`, the wall clock in the business zone — so a 01:30 in the tail reads as 01:30. */
const wallClock = (instant: number): string => {
  const local = toLocal(instantFromIso(new Date(instant).toISOString()), ASIA_DUBAI)
  return `${local.date} ${local.time}`
}

const asFloorPresence = (row: FloorPresenceRow): FloorPresence => ({
  employeeId: row.employeeId,
  tradingDate: localDate(row.tradingDate),
  period: { startsAt: row.startsAt, endsAt: row.endsAt } as Period,
})

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const { id: leaveRequestId } = await context.params
    const claimedRole = url.searchParams.get('role')?.trim() ?? CEILING_ROLE
    if (!isRole(claimedRole)) {
      // Deny by default, including for an unknown role STRING. A 400 rather than a silent fall back to the
      // ceiling: falling back serves the page to a caller whose role nobody recognised.
      throw new TypeError(
        `?role=${claimedRole} is not a role this system knows (${ROLES.join(', ')}). An unrecognised ` +
          'role is refused rather than treated as the narrowest one, so a typo cannot be mistaken for a ' +
          'permission decision.',
      )
    }
    const direction = url.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr'

    // The intersection IS the narrowing, and it is one expression so there is nowhere for a widening to
    // hide: every capability is the claimed role's AND the ceiling's.
    const access = {
      role: claimedRole,
      mayApprove:
        can(claimedRole, LEAVE_APPROVAL_PERMISSION) && can(CEILING_ROLE, LEAVE_APPROVAL_PERMISSION),
      mayOverride: mayOverrideLeaveConflict(claimedRole) && mayOverrideLeaveConflict(CEILING_ROLE),
      // The conflict report names a customer and a service. `booking:read` is the grant that says a role
      // may see a booking at all, and it is intersected the same way.
      maySeeConflicts: can(claimedRole, 'booking:read') && can(CEILING_ROLE, 'booking:read'),
    }

    const outcome = await withSql(async (sql) => {
      const now = instantFromIso(new Date().toISOString())
      const chrome = await adminChromeFor({ sql, now, request })
      const leave = await readLeaveRequest(sql, leaveRequestId)
      if (leave === null) return { kind: 'missing' as const }

      // The trading dates come from the `business_day` calendar itself, by range overlap, and are not
      // derived from the period's instants here. `resolveTradingDate` is the one reading of which session an
      // instant belongs to, and a second one in this file would disagree with it the moment a Ramadan
      // override moved a close — see `readTradingDatesCovering`'s own comment for what the first version of
      // it did wrong.
      const covered = await readTradingDatesCovering(sql, {
        startsAt: leave.startsAt,
        endsAt: leave.endsAt,
      })
      const dates = {
        fromTradingDate: covered[0] ?? '',
        toTradingDate: covered.at(-1) ?? '',
      }
      if (covered.length === 0) {
        // No trading date at all: the premises does not open inside this period, so there is no segment grid
        // and no coverage question. Reported rather than guessed at — a zero-day window read as "no breach"
        // would be a coverage check that examined nothing (ADR 0002).
        return { kind: 'no_trading_day' as const, leave, chrome }
      }

      const [
        conflicts,
        approval,
        therapistRows,
        windows,
        coverageRuleRows,
        workingHoursRows,
        wetRoomSkills,
        wetWindows,
        policy,
        presenceRows,
      ] = await Promise.all([
        // Not read at all when the reader may not see them. A refused reader must not cause a query whose
        // timing could tell them whether there is a row, and there is nothing this page could do with it.
        access.maySeeConflicts
          ? readLeaveApprovalConflicts(sql, { leaveRequestId })
          : Promise.resolve([]),
        readLiveLeaveApproval(sql, leaveRequestId),
        readRotaTherapists(sql, dates),
        readTradingDayWindows(sql, dates),
        readRotaCoverageRules(sql),
        readWorkingHoursRules(sql),
        readWetRoomSkills(sql),
        readWetRoomBookableWindows(sql, dates),
        readCredentialPolicy(sql),
        readFloorPresence(sql, dates),
      ])

      const credentials = await readEmployeeCredentials(
        sql,
        therapistRows.map((row) => row.employeeId),
      )
      const therapists: RotaTherapist[] = therapistRows.map((row) => ({
        employeeId: row.employeeId,
        skills: row.skills,
        credentials: credentials
          .filter((credential) => credential.employeeId === row.employeeId)
          .map(
            (credential): HeldCredential => ({
              documentType: credential.documentType,
              expiresOn: credential.expiresOn === null ? null : localDate(credential.expiresOn),
            }),
          ),
      }))
      const known = new Set(therapists.map((row) => row.employeeId))
      const days: RotaTradingDay[] = windows.map((day) => ({
        tradingDate: localDate(day.tradingDate),
        opensAt: day.opensAt as RotaTradingDay['opensAt'],
        closesAt: day.closesAt as RotaTradingDay['closesAt'],
        wetRoomBookableDuring: wetWindows
          .filter((wet) => wet.tradingDate === day.tradingDate)
          .map((wet) => ({ startsAt: wet.startsAt, endsAt: wet.endsAt }) as Period),
        isPublicHoliday: false,
      }))

      // A day this period covers with no `business_day` row cannot be judged: the segment grid comes from
      // the window, so an absent day would be silently uncovered by every rule. Reported rather than
      // guessed at.
      const coverage =
        days.length === 0
          ? null
          : coverageBreachesCausedBy({
              rota: {
                days,
                therapists,
                treatmentLoads: [],
                coverageRuleVersions: coverageRuleRows.map(asCoverageRules),
                workingHoursRuleVersions: workingHoursRows.map(asWorkingHoursRules),
                wetRoomSkills,
                credentialPolicy: policy,
                zone: ASIA_DUBAI,
              },
              // Narrowed to the therapist roster the rota was read for: `validateRota` refuses an
              // assignment naming an employee it was not given, and a receptionist on shift contributes no
              // floor cover — which is the validator's own stated decision, not a second one here.
              presence: presenceRows
                .filter((row) => known.has(row.employeeId))
                .map(asFloorPresence),
              employeeId: leave.employeeId,
              period: { startsAt: leave.startsAt, endsAt: leave.endsAt } as Period,
            })

      const governing = coverageRuleRows
        .filter((row) => row.effectiveFrom <= dates.fromTradingDate)
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0]

      const therapistReference =
        therapistRows.find((row) => row.employeeId === leave.employeeId)?.reference ??
        leave.employeeId

      return {
        kind: 'found' as const,
        view: {
          chrome,
          leaveRequestId,
          therapistReference,
          kind: leave.kind,
          status: leave.status,
          startsAt: wallClock(leave.startsAt),
          endsAt: wallClock(leave.endsAt),
          fromTradingDate: dates.fromTradingDate,
          toTradingDate: dates.toTradingDate,
          readAtIso: new Date(Number(now)).toISOString(),
          conflicts: conflicts.map(
            (row): LeaveConflictView => ({
              appointmentId: row.appointmentId,
              customerId: row.customerId,
              customerDisplayName: row.customerDisplayName,
              serviceLabel: row.serviceLabel,
              roomCode: row.roomCode,
              therapistReference: row.therapistReference,
              startsAt: wallClock(row.startsAt.getTime()),
              resolution: row.resolution,
            }),
          ),
          breaches: (coverage?.caused ?? []).map(
            (breach): LeaveCoverageBreachView => ({
              rule: breach.rule,
              segmentLabel: breach.segmentLabel,
            }),
          ),
          preexistingBreachCount: coverage?.preexisting.length ?? 0,
          minimumTherapistsOnFloor: governing?.minimumTherapistsOnFloor ?? 0,
          coverageRuleEffectiveFrom: governing?.effectiveFrom ?? 'none',
          coverageOpenQuestionId: COVERAGE_OPEN_QUESTION,
          approval:
            approval === null
              ? null
              : {
                  approverRole: approval.approverRole,
                  approvedVia: approval.approvedVia,
                  coverageRuleEffectiveFrom: approval.coverageRuleEffectiveFrom,
                  conflictsOverridden: approval.conflictsOverridden,
                  conflictsReassigned: approval.conflictsReassigned,
                },
          access,
          direction,
        } satisfies LeaveApprovalPageView,
      }
    })

    if (outcome.kind === 'missing') {
      return new Response(`No leave request ${leaveRequestId}\n`, {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      })
    }

    if (outcome.kind === 'no_trading_day') {
      // 200 and a sentence, not a 404 and not an empty grid. The request exists; what is absent is a
      // session inside it, which is a true and useful answer — and a page that drew an empty coverage
      // section would read as a floor that holds.
      return new Response(
        `Leave request ${leaveRequestId} covers no trading date: the premises does not open inside the ` +
          'period, so there is no floor to judge and no appointment can fall inside it. Generate the ' +
          'business_day calendar for those dates first.\n',
        {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        },
      )
    }

    return new Response(renderLeaveApprovalHtml(outcome.view), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error) {
    // A refused parameter is the caller's, a failed read is not, and the two must not answer the same way.
    // A refused READER is neither: it is rendered as a page, above.
    const isRequest = error instanceof TypeError
    const message = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
    return new Response(`The leave request could not be read: ${message}\n`, {
      status: isRequest ? 400 : 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
