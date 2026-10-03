import {
  DOMAIN_INVARIANT_RULES,
  type DomainBreach,
  type DomainInvariantCensus,
} from '@berelax/core'
import type { Sql } from '@berelax/db'

/**
 * The four docs/14 §3 claims, counted over every row the database holds. B-M1.
 *
 * The judgement is `packages/core/src/ops/domain-invariants.ts`; this is the five queries. It lives
 * here because this is the one package that may import both `@berelax/core` and `@berelax/db` (brief
 * rule 4), and because `packages/core` may read no database.
 *
 * ## Every query returns the rows that BREAK a claim, and that is why the counts are returned too
 *
 * An empty result is a pass, so a wrong join or a filter that matched nothing produces four passes
 * about nothing. The counts are what `domainInvariantProblems` refuses on, and the after-midnight
 * population is what says whether the fourth claim was exercised at all.
 *
 * ## It takes a `Sql` so a caller can hand it a TRANSACTION
 *
 * `packages/fixtures/src/domain-invariants.itest.ts` plants one breach per claim with the database's
 * own guard dropped — `alter table ... drop constraint` and `disable trigger` are transactional in
 * PostgreSQL — and rolls the whole thing back. That is the only way the therapist and capacity rules
 * can be WATCHED firing: the constraint and the trigger refuse the breach outright, which is correct
 * and is exactly why a census that merely restated them would be worth nothing.
 */

/** A limit on how many breaches of one kind are reported. A census of 10,000 bad rows is unreadable. */
const REPORTED_PER_RULE = 25

const capped = (rows: readonly DomainBreach[], rule: string, total: number): DomainBreach[] => {
  const reported = [...rows]
  if (total > reported.length) {
    reported.push({
      rule,
      detail:
        `and ${total - reported.length} more. Reported ${reported.length} of ${total}: a census of ` +
        'every bad row is unreadable, and the count is the figure that matters',
    })
  }
  return reported
}

export async function censusDomainInvariants(sql: Sql): Promise<DomainInvariantCensus> {
  const [counts] = await sql<
    {
      appointments: number
      rooms: number
      trading_dates: number
      after_midnight: number
    }[]
  >`
    select (select count(*)::int from appointment where holds_resources)        as appointments,
           (select count(*)::int from rooms)                                   as rooms,
           (select count(*)::int from business_day)                            as trading_dates,
           -- The population claim four is about: a start between midnight and the following day's
           -- opening, in the salon's own zone. Trading runs 11:00-02:00, so such a start belongs to the
           -- PREVIOUS trading date and a calendar truncation would file it on the wrong one.
           (select count(*)::int from appointment
             where holds_resources
               and (lower(period) at time zone 'Asia/Dubai')::time < time '06:00') as after_midnight
  `

  // 1. No double-booked therapist. The exclusion constraint's claim, re-derived as a self-join so a row
  //    written while the constraint was dropped or deferred is still found.
  const overlaps = await sql<
    {
      left_id: string
      right_id: string
      therapist: string
      left_period: string
      right_period: string
    }[]
  >`
    select a.id::text        as left_id,
           b.id::text        as right_id,
           e.staff_reference as therapist,
           a.period::text    as left_period,
           b.period::text    as right_period
      from appointment a
      join appointment b on b.therapist_id = a.therapist_id and b.id > a.id and a.period && b.period
      join employee e    on e.id = a.therapist_id
     where a.holds_resources and b.holds_resources
     order by a.id, b.id
     limit ${REPORTED_PER_RULE}
  `
  const [overlapTotal] = await sql<{ n: number }[]>`
    select count(*)::int as n
      from appointment a
      join appointment b on b.therapist_id = a.therapist_id and b.id > a.id and a.period && b.period
     where a.holds_resources and b.holds_resources
  `

  // 2. No room over capacity, through `room_peak_concurrency` — the ONE statement of how many client
  //    places a room holds at an instant, and the function `assert_room_capacity` itself calls.
  const overCapacity = await sql<
    { id: string; room: string; capacity: number; concurrent: number; at: string }[]
  >`
    select a.id::text     as id,
           r.code         as room,
           r.capacity     as capacity,
           p.concurrent   as concurrent,
           p.at::text     as at
      from appointment a
      join rooms r on r.id = a.room_id
      cross join lateral room_peak_concurrency(a.room_id, a.period) p
     where a.holds_resources and p.concurrent > r.capacity
     order by a.id
     limit ${REPORTED_PER_RULE}
  `

  // 3. Nothing scheduled past close once turnaround is counted, and 4. every start inside the window
  //    of the trading date the row itself claims. One query, because both are a comparison against the
  //    same `business_day` row and reading it twice would be two statements of one join.
  const outside = await sql<
    {
      id: string
      trading_date: string
      starts_at: string
      ends_at: string
      turnaround_minutes: number
      opens_at: string
      closes_at: string
      before_opening: boolean
      after_closing: boolean
    }[]
  >`
    select a.id::text                   as id,
           a.trading_date::text         as trading_date,
           lower(a.period)::text        as starts_at,
           upper(a.period)::text        as ends_at,
           a.turnaround_minutes         as turnaround_minutes,
           d.opens_at::text             as opens_at,
           d.closes_at::text            as closes_at,
           lower(a.period) < d.opens_at or lower(a.period) >= d.closes_at as before_opening,
           upper(a.period) + make_interval(mins => a.turnaround_minutes) > d.closes_at
                                        as after_closing
      from appointment a
      join business_day d on d.trading_date = a.trading_date
     where a.holds_resources
       and (lower(a.period) < d.opens_at
            or lower(a.period) >= d.closes_at
            or upper(a.period) + make_interval(mins => a.turnaround_minutes) > d.closes_at)
     order by a.trading_date, a.id
     limit ${REPORTED_PER_RULE * 2}
  `

  // A trading date `business_day` does not hold at all. Reported under the close rule because that is
  // what it breaks: a day with no hours has no close to be inside, and the join above drops the row
  // silently — which is the one way an appointment could pass every claim by being invisible to it.
  const notTrading = await sql<{ id: string; trading_date: string }[]>`
    select a.id::text as id, a.trading_date::text as trading_date
      from appointment a
     where a.holds_resources
       and not exists (select 1 from business_day d where d.trading_date = a.trading_date)
     order by a.trading_date, a.id
     limit ${REPORTED_PER_RULE}
  `

  const pastClose: DomainBreach[] = []
  const wrongBusinessDay: DomainBreach[] = []
  for (const row of outside) {
    if (row.after_closing) {
      pastClose.push({
        rule: DOMAIN_INVARIANT_RULES.pastClose,
        detail:
          `appointment ${row.id} on ${row.trading_date} ends at ${row.ends_at} and holds its room for ` +
          `${row.turnaround_minutes} more minute(s), past a close of ${row.closes_at}`,
      })
    }
    if (row.before_opening) {
      wrongBusinessDay.push({
        rule: DOMAIN_INVARIANT_RULES.wrongBusinessDay,
        detail:
          `appointment ${row.id} starts at ${row.starts_at} and claims trading date ` +
          `${row.trading_date}, whose window is ${row.opens_at} to ${row.closes_at}. Trading runs ` +
          '11:00-02:00, so a start outside that window is filed on the wrong business day',
      })
    }
  }

  return {
    appointmentsExamined: counts?.appointments ?? 0,
    roomsExamined: counts?.rooms ?? 0,
    tradingDatesExamined: counts?.trading_dates ?? 0,
    afterMidnightExamined: counts?.after_midnight ?? 0,
    therapistOverlaps: capped(
      overlaps.map((row) => ({
        rule: DOMAIN_INVARIANT_RULES.doubleBookedTherapist,
        detail:
          `therapist ${row.therapist} holds ${row.left_id} ${row.left_period} and ${row.right_id} ` +
          `${row.right_period} at once`,
      })),
      DOMAIN_INVARIANT_RULES.doubleBookedTherapist,
      overlapTotal?.n ?? 0,
    ),
    roomsOverCapacity: overCapacity.map((row) => ({
      rule: DOMAIN_INVARIANT_RULES.roomOverCapacity,
      detail:
        `room ${row.room} holds ${row.concurrent} client place(s) at ${row.at} and its capacity is ` +
        `${row.capacity} (appointment ${row.id})`,
    })),
    pastClose,
    wrongBusinessDay,
    daysNotTrading: notTrading.map((row) => ({
      rule: DOMAIN_INVARIANT_RULES.dayNotTrading,
      detail:
        `appointment ${row.id} claims trading date ${row.trading_date}, which business_day does not ` +
        'hold at all — so it has no close to be inside and every window comparison skips it',
    })),
  }
}
