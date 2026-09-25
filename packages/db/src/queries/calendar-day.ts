import type { Sql } from '../connection.ts'

/**
 * One trading day of the front-desk calendar, in **one** statement (B-UI-03).
 *
 * The admin calendar shows the same appointments twice — room × time as the primary axis because rooms are
 * the scarce resource, therapist × time as a second view — and the acceptance criterion for that is not
 * about the rendering: *"a test asserts both views are derived from one query result object (no second
 * fetch, no second source of truth)"*. A reader that answered the rooms in one round trip and the
 * appointments in another would already be two sources, whatever the page then did with them, so this is
 * one statement returning one row: the day, its rooms, the appointments on it and the therapists they
 * belong to, assembled as JSON by PostgreSQL.
 *
 * `calendarAxes` in `@berelax/core` takes what this returns and answers both axes from it, carrying every
 * appointment object by reference. That pairing is the whole design: this package may never import
 * `packages/core` (the dependency runs the other way), so the SHAPE below is what the two sides agree on,
 * and the app composes them with `satisfies` so a field added on one side and not the other is a
 * `pnpm typecheck` failure rather than a rule that silently stopped applying.
 *
 * ## What it selects, and what it must not
 *
 * No customer: not a name, not a phone, not an id. A front-desk grid answers "what is in which room when",
 * and the booking behind a card is reachable by its id for a surface that needs it. No therapist name
 * either — `employee.staff_reference` is the handle, because nineteen employees have no name recorded and
 * the ones that do have it under a publication guard (ADR 0020).
 *
 * Only appointments that still **hold their resources**: `holds_resources` is a GENERATED column
 * (`status <> no_show, cancelled_*, rescheduled`), so a cancelled booking and the predecessor of a
 * reschedule both disappear from the grid by the same rule the exclusion constraint and the availability
 * solver use. A calendar that drew them would draw a room as busy that anybody may sell.
 *
 * ## Why the trading date and not a calendar date
 *
 * `appointment.trading_date` is a foreign key into `business_day` (0024) and a trading day crosses midnight, so a
 * treatment starting at 23:50 belongs to the date it was sold on and appears on THAT grid — once, as one
 * continuous block — and is absent from the next day's, which is the acceptance criterion about midnight.
 * Selecting by `period` overlapping a calendar date instead would put it on both and split it on neither.
 */

/** A room lane, whether or not anything is in it. An empty room is what a receptionist is looking for. */
export interface CalendarRoomRow {
  readonly roomId: string
  readonly code: string
  readonly name: string
  readonly capacity: number
}

/** A therapist lane. `reference` is `employee.staff_reference`, or null when the employee row has gone. */
export interface CalendarTherapistRow {
  readonly therapistId: string
  readonly reference: string | null
}

/**
 * One appointment row, shaped for `calendarAxes`.
 *
 * `therapistIds` is an array of exactly one id, because an `appointment` row holds one therapist — a Four
 * Hands is two rows over one `delivery_id`. The array is the shape `ScheduledAppointment` declares and the
 * shape the solver's occupancy index reads, and a card is drawn per ROW for the same reason a therapist
 * lane is: each row blocks its own therapist.
 */
export interface CalendarAppointmentRow {
  readonly id: string
  readonly bookingId: string
  readonly roomId: string
  readonly therapistIds: readonly string[]
  readonly delivery: { readonly id: string; readonly places: number }
  readonly treatment: { readonly startsAt: number; readonly endsAt: number }
  readonly turnaroundMinutes: number
  readonly therapistBufferMinutes: number
  readonly status: string
  readonly shape: string
  readonly serviceLabel: string
}

export interface CalendarDayRead {
  readonly tradingDate: string
  readonly opensAt: number
  readonly closesAt: number
  readonly rooms: readonly CalendarRoomRow[]
  readonly therapists: readonly CalendarTherapistRow[]
  readonly appointments: readonly CalendarAppointmentRow[]
}

/** The JSON one row carries. Epoch milliseconds, because the grid is arithmetic over instants. */
interface DayPayload {
  readonly trading_date: string
  readonly opens_at: number
  readonly closes_at: number
  readonly rooms: readonly {
    readonly room_id: string
    readonly code: string
    readonly name: string
    readonly capacity: number
  }[]
  readonly therapists: readonly {
    readonly therapist_id: string
    readonly reference: string | null
  }[]
  readonly appointments: readonly {
    readonly id: string
    readonly booking_id: string
    readonly room_id: string
    readonly therapist_id: string
    readonly delivery_id: string
    readonly room_places: number
    readonly starts_at: number
    readonly ends_at: number
    readonly turnaround_minutes: number
    readonly therapist_buffer_minutes: number
    readonly status: string
    readonly shape: string
    readonly service_label: string
  }[]
}

/**
 * The day, or `null` when the premises does not trade on that date.
 *
 * `null` rather than an empty grid, and the difference matters on the screen: a closed date has no
 * `business_day` row at all (a closure is an ABSENT row, not a flag), so a grid with no lanes would say
 * "nothing is booked" about a day nobody could have booked.
 *
 * Every room that is bookable gets a lane; the therapists are the ones with work on the day. Which is a
 * decision and not an omission: nineteen therapist lanes, all but a few empty and none of them carrying a
 * name, is a control nobody can use, and the rota that would justify a wider list is P-HR-01's
 * `shift_assignment` — a second question, with a second answer, on a screen whose subject is the ROOMS.
 */
export async function readCalendarDay(
  sql: Sql,
  tradingDate: string,
): Promise<CalendarDayRead | null> {
  const rows = await sql<{ payload: DayPayload }[]>`
    with day as (
      select trading_date, opens_at, closes_at
        from business_day
       where trading_date = ${tradingDate}::date
    ),
    appt as (
      select a.id,
             a.booking_id,
             a.room_id,
             a.therapist_id,
             a.delivery_id,
             a.room_places,
             lower(a.period)  as starts_at,
             upper(a.period)  as ends_at,
             a.turnaround_minutes,
             a.therapist_buffer_minutes,
             a.status::text   as status,
             a.shape::text    as shape,
             s.public_display_name as service_label
        from appointment a
        join day                on day.trading_date = a.trading_date
        join service_variant v  on v.id = a.service_variant_id
        join service s          on s.id = v.service_id
       -- The GENERATED column, so the grid and the exclusion constraint cannot disagree about which rows
       -- hold a room: a cancellation and a reschedule's predecessor are both released by it.
       where a.holds_resources
    )
    select json_build_object(
             'trading_date', (select trading_date::text from day),
             'opens_at',  (select (extract(epoch from opens_at)  * 1000)::bigint from day),
             'closes_at', (select (extract(epoch from closes_at) * 1000)::bigint from day),
             'rooms', coalesce((
               select json_agg(json_build_object(
                        'room_id', r.id::text, 'code', r.code, 'name', r.name, 'capacity', r.capacity)
                      order by r.display_order, r.code)
                 from rooms r
                where r.is_bookable
             ), '[]'::json),
             'therapists', coalesce((
               select json_agg(json_build_object(
                        'therapist_id', t.therapist_id::text, 'reference', t.reference)
                      order by t.reference nulls last, t.therapist_id)
                 from (
                   select distinct appt.therapist_id, e.staff_reference as reference
                     from appt
                     left join employee e on e.id = appt.therapist_id
                 ) t
             ), '[]'::json),
             'appointments', coalesce((
               select json_agg(json_build_object(
                        'id', appt.id::text,
                        'booking_id', appt.booking_id::text,
                        'room_id', appt.room_id::text,
                        'therapist_id', appt.therapist_id::text,
                        'delivery_id', appt.delivery_id::text,
                        'room_places', appt.room_places,
                        'starts_at', (extract(epoch from appt.starts_at) * 1000)::bigint,
                        'ends_at',   (extract(epoch from appt.ends_at)   * 1000)::bigint,
                        'turnaround_minutes', appt.turnaround_minutes,
                        'therapist_buffer_minutes', appt.therapist_buffer_minutes,
                        'status', appt.status,
                        'shape', appt.shape,
                        'service_label', appt.service_label)
                      -- Ascending start, then id: the order cards are laid out in, and a stable one, so
                      -- two reads of an unchanged day produce byte-identical HTML and a repeat screenshot
                      -- has zero pixel diff.
                      order by appt.starts_at, appt.id)
                 from appt
             ), '[]'::json)
           ) as payload
      from day
  `
  const payload = rows[0]?.payload
  if (payload === undefined) return null
  return {
    tradingDate: payload.trading_date,
    opensAt: Number(payload.opens_at),
    closesAt: Number(payload.closes_at),
    rooms: payload.rooms.map((room) => ({
      roomId: room.room_id,
      code: room.code,
      name: room.name,
      capacity: Number(room.capacity),
    })),
    therapists: payload.therapists.map((therapist) => ({
      therapistId: therapist.therapist_id,
      reference: therapist.reference,
    })),
    appointments: payload.appointments.map((row) => ({
      id: row.id,
      bookingId: row.booking_id,
      roomId: row.room_id,
      therapistIds: [row.therapist_id],
      delivery: { id: row.delivery_id, places: Number(row.room_places) },
      treatment: { startsAt: Number(row.starts_at), endsAt: Number(row.ends_at) },
      turnaroundMinutes: Number(row.turnaround_minutes),
      therapistBufferMinutes: Number(row.therapist_buffer_minutes),
      status: row.status,
      shape: row.shape,
      serviceLabel: row.service_label,
    })),
  }
}

/**
 * The trading dates around one date, with their hours, so a caller can resolve "which day is it now".
 *
 * The same superset `rescheduleAppointmentTx` reads for the same reason: WHICH `business_day` row contains
 * an instant is `resolveTradingDate`'s rule and this package may not own it, so the bracket is ±1 calendar
 * date around the instant's own Dubai date and the choice is made by the caller's injected resolver.
 * `to_char(... at time zone 'Asia/Dubai')` rather than a second timezone calculation in TypeScript.
 */
export interface CalendarDayHoursRow {
  readonly tradingDate: string
  readonly open: string
  readonly close: string
}

export async function readCalendarDayHours(
  sql: Sql,
  aroundIso: string,
): Promise<readonly CalendarDayHoursRow[]> {
  const rows = await sql<{ trading_date: string; open_time: string; close_time: string }[]>`
    select trading_date::text as trading_date,
           to_char(opens_at  at time zone 'Asia/Dubai', 'HH24:MI') as open_time,
           to_char(closes_at at time zone 'Asia/Dubai', 'HH24:MI') as close_time
      from business_day
     where trading_date between
             ((${aroundIso}::timestamptz at time zone 'Asia/Dubai')::date - 1)
         and ((${aroundIso}::timestamptz at time zone 'Asia/Dubai')::date + 1)
     order by trading_date
  `
  return rows.map((row) => ({
    tradingDate: row.trading_date,
    open: row.open_time,
    close: row.close_time,
  }))
}

/**
 * The nearest OPEN trading dates either side of one, for the day navigation.
 *
 * Arithmetic on the date would be wrong for the reason a closure is an absent row rather than a flag: the
 * day before a closed Monday is the previous Sunday, and `date - 1` would offer a link to a day with no
 * `business_day` row and therefore no grid. `null` at either end means the trading calendar does not go
 * that far — P-BIZ's generator fills it a season at a time, so the end of it is a real place to be.
 *
 * A second statement, and deliberately not folded into {@link readCalendarDay}: that read is the one the
 * two axes are derived from and its being ONE statement is an acceptance criterion. Navigation is a
 * different question, and answering it inside the same JSON object would make the claim harder to check
 * rather than stronger.
 */
export async function readAdjacentTradingDates(
  sql: Sql,
  tradingDate: string,
): Promise<{ readonly previous: string | null; readonly next: string | null }> {
  const [row] = await sql<{ previous: string | null; next: string | null }[]>`
    select (select max(trading_date)::text from business_day where trading_date < ${tradingDate}::date)
             as previous,
           (select min(trading_date)::text from business_day where trading_date > ${tradingDate}::date)
             as next
  `
  return { previous: row?.previous ?? null, next: row?.next ?? null }
}
