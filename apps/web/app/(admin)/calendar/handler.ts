import {
  ASIA_DUBAI,
  type CalendarAppointmentFacts,
  type CalendarDayFacts,
  calendarAxes,
  decideAppointmentTransition,
  FRONT_DESK_DIARY_PRINCIPAL,
  type HoursForDate,
  type Instant,
  localTime,
  recheckShapeAssignment,
  reminderOffsetsFrom,
  reminderPlanFor,
  rescheduleTradingDate,
  resolveTradingDate,
  toLocal,
} from '@berelax/core'
import {
  type Actor,
  type CalendarDayRead,
  type PlannedStep,
  type RescheduleDeps,
  readAdjacentTradingDates,
  readCalendarDay,
  readCalendarDayHours,
  readReminderOffsets,
  rescheduleAppointmentTx,
  rescheduleRefusalOf,
  type ScheduledStepMaintainer,
  type ScheduledStepPlanner,
  type SlotRecheck,
  type Sql,
  scheduledStepMaintainer,
  type TradingDateResolver,
  type TransitionActor,
  type TransitionDecider,
  transitionRefusalOf,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import {
  type CalendarOutcome,
  type CalendarView,
  calendarAnnouncement,
  renderCalendarGridFragment,
  renderCalendarHtml,
  renderClosedDayHtml,
} from './render.ts'

/**
 * `/calendar` — the front-desk diary (B-UI-03, docs/09 §2).
 *
 * The handler rather than the route binding, so it can be driven directly by
 * `apps/web/src/admin-calendar.itest.ts` against a real PostgreSQL with a **frozen clock**. That is not a
 * convenience: the first acceptance line is *"with the frozen clock at 01:30 the calendar header and query
 * both resolve to the previous trading date"*, and an instant cannot be frozen behind a `next start`. The
 * manage-booking page next door takes the same split for the same reason.
 *
 * ## Both axes come from one read
 *
 * `readCalendarDay` is ONE statement and `calendarAxes` answers room × time and therapist × time from what
 * it returned, carrying every appointment by reference. The room axis is primary because rooms are the
 * scarce resource; the therapist axis is a second READING and not a second query, which is the acceptance
 * criterion and is asserted by object identity rather than by comparing two lists.
 *
 * ## The write is B-LIFE-03's, by reference
 *
 * `rescheduleAppointmentTx` — the export the front desk's pair suite and the customer's own manage-booking
 * page both call — with the same three injected rules from `@berelax/core`. Not a path that behaves
 * similarly: the room `FOR UPDATE` lock, the slot re-check, the trading-date re-resolution, the exclusion
 * constraints and the scheduled-step maintenance are one implementation, so they cannot diverge.
 * {@link CALENDAR_WRITE_PATHS} exports the references and `admin-calendar.itest.ts` compares each with
 * `toBe` against what `@berelax/db` and `@berelax/core` publish, because behaviour that agrees today is how
 * two paths come to disagree quietly.
 *
 * ## What a drop may change, and what it may not
 *
 * The time and the ROOM. Not the therapist: that re-applies B-AVAIL-04's eligibility on the new date, and
 * under strict same-gender matching it needs the client's gender, which no table holds (B-AVAIL-05) — so
 * the therapist axis is read-only and the reassignment queue's reasoning applies unchanged. The duration is
 * read from the appointment row rather than taken from the request, and the proposed start must be one of
 * the day's own quarter-hour targets: a caller cannot post a time the grid does not offer.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, exactly as the credentials
 * screen, the reassignment queue, the compliance calendar and the Messages inbox all record — and this is
 * the first admin surface that writes, so the actor is the declared principal
 * `system:front_desk_diary` rather than a job title nobody signed in as.
 * `packages/core/src/access/principals/front-desk-diary.ts` records why, what it may do, and what W-SYS-01
 * replaces.
 */

/** The actor, and the principal the policy layer consults. Two fields, for the reason 0046 gives. */
const SURFACE = `Admin diary (${FRONT_DESK_DIARY_PRINCIPAL})`
export const CALENDAR_CALLER: Actor = { kind: 'staff', label: SURFACE }
const ACTOR: TransitionActor = {
  kind: 'staff',
  // The ROLE stored on the history row, and the PRINCIPAL the permission check reads.
  // `appointment_status_history_actor_role_known` (0046) accepts exactly the eight F07 roles, and `system`
  // is the honest one for a surface with no interactive login — the principal is what carries the grant.
  role: 'system',
  principal: FRONT_DESK_DIARY_PRINCIPAL,
  label: SURFACE,
}

/** `rescheduled` declares a reason mandatory, and the decider enforces it. One sentence, one meaning. */
const REASON = 'Moved on the admin diary'

/**
 * Core's rules, as the write path's injected seams. `satisfies` and not a cast, every one.
 *
 * Each declaration describes one seam across a boundary `packages/db` may not cross, which is what makes a
 * field added on one side and not the other a `pnpm typecheck` failure here rather than a rule that quietly
 * stopped being applied. `packages/fixtures/src/appointment-reschedule.itest.ts` composes the same three
 * for the staff path and `app/(public)/booking/[token]/handler.ts` for the customer's — and that they are
 * the same three is the point.
 */
const decide = decideAppointmentTransition satisfies TransitionDecider
const recheck = recheckShapeAssignment satisfies SlotRecheck
const resolveRescheduleTradingDate = rescheduleTradingDate satisfies TradingDateResolver

/**
 * The write path and the rules this surface uses, as references.
 *
 * Exported for one assertion, and it is an acceptance criterion: *"drag to reschedule calls the B-LIFE-03
 * reschedule"*. A wrapper around the right function passes every behavioural test and fails this.
 */
export const CALENDAR_WRITE_PATHS = {
  reschedule: rescheduleAppointmentTx,
  decide,
  recheck,
  resolveTradingDate: resolveRescheduleTradingDate,
} as const

export interface CalendarDeps {
  readonly sql: Sql
  /** Injected, so the integration suite can freeze it. "Today" is judged against this and nothing else. */
  readonly now: () => Instant
}

/** A trading date as the query string may carry it. Bounded, so a parameter cannot be a paragraph. */
const TRADING_DATE = /^\d{4}-\d{2}-\d{2}$/
/** A uuid, for the two ids a move names. Checked before a query, not after. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * B-MSG-03's step planner, bound to whatever the reminder-timing setting says right now.
 *
 * A twin of the one in the manage-booking handler, and a twin rather than an import for the reason that one
 * gives: `.dependency-cruiser.cjs` forbids reaching into another app, and the composition cannot live in a
 * package because it needs `readReminderOffsets` from `@berelax/db` and `reminderPlanFor` from
 * `@berelax/core` — only an app may import both. A reschedule that built no reminder set would leave a
 * moved customer with reminders for the old time, which is quieter than a broken drag and worse.
 */
async function maintainerFor(sql: Sql): Promise<ScheduledStepMaintainer> {
  const offsetsHours = reminderOffsetsFrom(await readReminderOffsets(sql))
  const plan: ScheduledStepPlanner = (input): readonly PlannedStep[] =>
    reminderPlanFor({
      appointmentId: input.appointmentId,
      period: input.period,
      offsetsHours,
    })
  return scheduledStepMaintainer({ plan })
}

function page(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached. A cached diary outlives the diary: an appointment moved five minutes ago would still
      // be drawn in its old slot, which is the one failure a room grid must not have.
      'cache-control': 'no-store',
    },
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * The business day the clock resolves to, through `resolveTradingDate` and never by truncating a date.
 *
 * A trading day crosses midnight — the hours live in `premises_hours` and no rendered file may write
 * them down — so 01:30 belongs to the PREVIOUS trading date, which is the whole of the first
 * acceptance line and the reason nothing here calls `toISOString().slice(0, 10)`. The candidate rows are a
 * superset bracketed by calendar date ±1 and the choice between them is core's rule, exactly as
 * `rescheduleAppointmentTx` reads them.
 *
 * When the instant belongs to no session — 09:00, before the day opens — the CALENDAR date is answered, so
 * the front desk arriving in the morning sees the day it is about to work rather than a named refusal. The
 * page says which day it is showing either way, and `readCalendarDay` answers `null` for a date the
 * premises does not trade on at all.
 */
async function currentTradingDate(deps: CalendarDeps): Promise<string> {
  const now = deps.now()
  const rows = await readCalendarDayHours(deps.sql, new Date(now).toISOString())
  const byDate = new Map(rows.map((row) => [row.tradingDate, row]))
  const hoursFor: HoursForDate = (date) => {
    const row = byDate.get(date)
    return row === undefined
      ? undefined
      : { open: localTime(row.open), close: localTime(row.close) }
  }
  const resolution = resolveTradingDate(now, hoursFor, ASIA_DUBAI)
  return resolution.kind === 'trading' ? resolution.date : resolution.calendarDate
}

/**
 * The read, as the pure grid needs it.
 *
 * A `satisfies` rather than a cast, and it is the seam: `CalendarDayRead` is `@berelax/db`'s shape and
 * `CalendarDayFacts` is `@berelax/core`'s, the two packages cannot import each other, and this line is
 * where a field renamed on one side becomes a typecheck failure instead of a grid that silently stopped
 * drawing turnarounds.
 */
function factsFrom(read: CalendarDayRead): CalendarDayFacts {
  const appointments = read.appointments.map(
    (row): CalendarAppointmentFacts => ({
      id: row.id,
      bookingId: row.bookingId,
      roomId: row.roomId,
      therapistIds: row.therapistIds,
      delivery: row.delivery,
      treatment: {
        startsAt: row.treatment.startsAt as Instant,
        endsAt: row.treatment.endsAt as Instant,
      },
      turnaroundMinutes: row.turnaroundMinutes,
      therapistBufferMinutes: row.therapistBufferMinutes,
      status: row.status,
      shape: row.shape,
      serviceLabel: row.serviceLabel,
    }),
  )
  return {
    tradingDate: read.tradingDate,
    opensAt: read.opensAt,
    closesAt: read.closesAt,
    rooms: read.rooms.map((room) => ({
      roomId: room.roomId,
      code: room.code,
      name: room.name,
      capacity: room.capacity,
    })),
    therapists: read.therapists.map((therapist) => ({
      therapistId: therapist.therapistId,
      reference: therapist.reference,
    })),
    appointments,
  } satisfies CalendarDayFacts
}

/** The day, as a view. `null` when the premises does not trade on it. */
async function viewFor(
  deps: CalendarDeps,
  args: { readonly tradingDate: string; readonly outcome: CalendarOutcome },
): Promise<CalendarView | null> {
  const read = await readCalendarDay(deps.sql, args.tradingDate)
  if (read === null) return null
  const adjacent = await readAdjacentTradingDates(deps.sql, args.tradingDate)
  const facts = factsFrom(read)
  return {
    axes: calendarAxes(facts),
    currentTradingDate: await currentTradingDate(deps),
    previousTradingDate: adjacent.previous,
    nextTradingDate: adjacent.next,
    // The day's own hours, formatted in the business zone. `toLocal` and not an `Intl` instance per render,
    // so two renders of one day are the same bytes.
    opensAtLabel: toLocal(read.opensAt as Instant, ASIA_DUBAI).time,
    closesAtLabel: toLocal(read.closesAt as Instant, ASIA_DUBAI).time,
    outcome: args.outcome,
  }
}

/**
 * The outcome a `?moved=` or `?refused=` parameter names, composed from the ROWS rather than from the URL.
 *
 * `?moved=<id>` carries an id and nothing else: the words come from where the appointment now is, so a
 * reader cannot be told a time the diary does not hold, and a stale link cannot announce a move that did
 * not happen. `?refused=` carries a refusal NAME, whose shape is checked here and whose words come from a
 * closed table in `render.ts`.
 */
function outcomeFrom(params: URLSearchParams, view: CalendarView): CalendarOutcome {
  const moved = params.get('moved')
  if (moved !== null && UUID.test(moved)) return movedOutcome(view, moved)
  const refused = params.get('refused')
  if (refused !== null && /^[a-z_]{1,64}$/.test(refused))
    return { kind: 'refused', refusal: refused }
  return { kind: 'none' }
}

/** Where an appointment now is, in words. `none` when this day does not hold it. */
function movedOutcome(view: CalendarView, appointmentId: string): CalendarOutcome {
  for (const lane of view.axes.rooms) {
    for (const card of lane.cards) {
      if (card.appointment.id !== appointmentId) continue
      const startsAt = card.appointment.treatment.startsAt
      const slot = view.axes.slots.find((entry) => entry.startsAt === startsAt)
      return {
        kind: 'moved',
        startsAtLabel: slot?.label ?? toLocal(startsAt as Instant, ASIA_DUBAI).time,
        roomLabel: lane.label,
      }
    }
  }
  return { kind: 'none' }
}

export async function handleCalendarRead(
  input: { readonly searchParams: URLSearchParams },
  deps: CalendarDeps,
): Promise<Response> {
  const requested = input.searchParams.get('date')
  const current = await currentTradingDate(deps)
  const tradingDate = requested !== null && TRADING_DATE.test(requested) ? requested : current
  const view = await viewFor(deps, { tradingDate, outcome: { kind: 'none' } })
  if (view === null) {
    return page(renderClosedDayHtml({ tradingDate, currentTradingDate: current }), 200)
  }
  const withOutcome: CalendarView = { ...view, outcome: outcomeFrom(input.searchParams, view) }
  // The grid alone, for the inline script's repaint after a move. The same renderer the document uses, so
  // there is no second opinion about what the "after" state looks like.
  if (input.searchParams.get('fragment') === 'grid') {
    return page(renderCalendarGridFragment(withOutcome))
  }
  return page(renderCalendarHtml(withOutcome))
}

/** What a move names. Every field is checked against the day before anything is written. */
interface MoveRequest {
  readonly appointmentId: string
  readonly startsAtIso: string
  readonly roomId: string
}

function moveFrom(source: URLSearchParams | Record<string, unknown>): MoveRequest | null {
  const read = (key: string): string | null => {
    if (source instanceof URLSearchParams) return source.get(key)
    const value = source[key]
    return typeof value === 'string' ? value : null
  }
  const appointmentId = read('appointmentId')
  const startsAtIso = read('startsAt')
  const roomId = read('roomId')
  if (appointmentId === null || startsAtIso === null || roomId === null) return null
  if (!UUID.test(appointmentId) || !UUID.test(roomId)) return null
  return { appointmentId, startsAtIso, roomId }
}

/**
 * A refusal name, from either translator. Never a message.
 *
 * BOTH, because both vocabularies are reachable from one drag: the reschedule's own refusals come from
 * `rescheduleRefusalOf`, and the lifecycle's come from `transitionRefusalOf` — a treatment that is already
 * `completed` is drawn on the grid (it still holds its room) and is terminal, so a move from it is refused
 * `illegal_transition`. The page has words for that name; without this line it reached the reader as words
 * that claim nothing and reached the log as `unknown`, which is a refusal nobody can find.
 */
function refusalOf(error: unknown): string {
  const named = rescheduleRefusalOf(error) ?? transitionRefusalOf(error)
  if (named !== null) return named
  // The reader is told nothing useful — `render.ts` falls back to words that claim nothing — so the SERVER
  // has to say something, or a refusal nobody named is a refusal nobody can find.
  console.error(
    '[calendar] a move refused with a name the translator does not recognise:',
    isAppError(error) ? `${error.kind}: ${error.message}` : String(error),
  )
  return 'unknown'
}

/**
 * The move itself, for both request shapes.
 *
 * Everything decidable is decided against the DAY the grid drew: the appointment must be on it, the room
 * must be one of its lanes, and the start must be one of its quarter-hour targets. So a request cannot ask
 * for a time the grid does not offer, and the three refusals that arise here are named rather than passed to
 * the transaction as a plausible-looking period.
 *
 * The duration comes from the appointment's own treatment period and never from the request: a caller that
 * could set the end could sell a two-hour room for a forty-five-minute treatment.
 */
async function move(
  deps: CalendarDeps,
  tradingDate: string,
  request: MoveRequest,
): Promise<{ readonly refusal: string } | { readonly movedId: string }> {
  const view = await viewFor(deps, { tradingDate, outcome: { kind: 'none' } })
  if (view === null) return { refusal: 'not_a_trading_date' }
  const card = view.axes.rooms
    .flatMap((lane) => lane.cards)
    .find((entry) => entry.appointment.id === request.appointmentId)
  if (card === undefined) return { refusal: 'unknown_appointment' }
  if (!view.axes.rooms.some((lane) => lane.id === request.roomId))
    return { refusal: 'unknown_room' }
  const slot = view.axes.slots.find((entry) => entry.startsAtIso === request.startsAtIso)
  if (slot === undefined) return { refusal: 'unknown_slot' }

  const { treatment } = card.appointment
  const startsAt = slot.startsAt as Instant
  const endsAt = (slot.startsAt + (treatment.endsAt - treatment.startsAt)) as Instant
  try {
    const result = await CALENDAR_WRITE_PATHS.reschedule(
      deps.sql,
      {
        appointmentId: request.appointmentId,
        actor: ACTOR,
        reason: REASON,
        // The treatment period only. Turnaround and the therapist buffer are the repository's to apply, and
        // a page that added them would be a second copy of a footprint rule.
        treatment: { startsAt, endsAt },
        roomId: request.roomId,
      },
      {
        decide,
        recheck,
        resolveTradingDate: resolveRescheduleTradingDate,
        steps: await maintainerFor(deps.sql),
      } satisfies RescheduleDeps,
    )
    // The SUCCESSOR's id: a reschedule is the old row moving to `rescheduled` and a new row acquiring the
    // period (B-LIFE-03), so the appointment that still exists is the successor and it is what the
    // announcement and the repainted grid are about.
    const successor = result.rows[0]?.successorId
    return { movedId: successor ?? request.appointmentId }
  } catch (error) {
    return { refusal: refusalOf(error) }
  }
}

/** Where the no-JavaScript form is sent back to, carrying what happened. POST-redirect-GET. */
function backTo(tradingDate: string, query: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: `/calendar?date=${tradingDate}${query}`,
      'cache-control': 'no-store',
    },
  })
}

export async function handleCalendarWrite(
  input: {
    readonly searchParams: URLSearchParams
    /** The parsed body: a form's fields, or the JSON object the inline script sent. */
    readonly body: URLSearchParams | Record<string, unknown>
    readonly wantsJson: boolean
  },
  deps: CalendarDeps,
): Promise<Response> {
  const requested = input.searchParams.get('date')
  const tradingDate =
    requested !== null && TRADING_DATE.test(requested) ? requested : await currentTradingDate(deps)
  const request = moveFrom(input.body)
  if (request === null) {
    const outcome: CalendarOutcome = { kind: 'refused', refusal: 'new_period_invalid' }
    return input.wantsJson
      ? json(
          {
            ok: false,
            refusal: outcome.refusal,
            announcement: calendarAnnouncement(outcome),
          },
          400,
        )
      : backTo(tradingDate, '&refused=new_period_invalid')
  }

  const outcome = await move(deps, tradingDate, request)
  if ('refusal' in outcome) {
    const refused: CalendarOutcome = { kind: 'refused', refusal: outcome.refusal }
    return input.wantsJson
      ? json(
          { ok: false, refusal: outcome.refusal, announcement: calendarAnnouncement(refused) },
          409,
        )
      : backTo(tradingDate, `&refused=${outcome.refusal}`)
  }

  if (!input.wantsJson) {
    // A 303 rather than a rendered 200, so a reload does not re-submit the move: "it moved" shown twice is
    // a receptionist who thinks it moved twice.
    return backTo(tradingDate, `&moved=${outcome.movedId}`)
  }

  // Re-read, so what the browser paints is what a fresh GET would serve. The successor may have landed on
  // ANOTHER trading date — a move from 23:50 to 11:30 the next morning does — in which case this day no
  // longer holds it and the announcement says where it is rather than guessing.
  const after = await viewFor(deps, { tradingDate, outcome: { kind: 'none' } })
  if (after === null) {
    return json({ ok: true, announcement: calendarAnnouncement({ kind: 'none' }), grid: '' })
  }
  const announced: CalendarView = { ...after, outcome: movedOutcome(after, outcome.movedId) }
  return json({
    ok: true,
    movedId: outcome.movedId,
    announcement: calendarAnnouncement(announced.outcome),
    grid: renderCalendarGridFragment(announced),
  })
}
