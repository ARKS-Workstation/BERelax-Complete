import type { TherapistSkill } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The two lists a screen needs when it must name a room and a therapist itself.
 *
 * ## Why this exists at all, when `queryAvailability` already answers both
 *
 * Because it answers them for a slot in the FUTURE. `/record-visit` enters a treatment that already
 * happened, and "is this therapist free at 19:00 yesterday" is not a question a solver can answer: it is
 * answered by what they actually did. So the desk says who it was and which room, and the authority on
 * whether that is possible is `createBooking` — it re-applies B-AVAIL-04's eligibility read model inside
 * its own transaction and refuses `therapist_not_eligible` by name, and 0024's exclusion on
 * `(therapist_id, period)` refuses an overlap whatever any list here said.
 *
 * These are therefore OPTION LISTS and not permissions. A reader who treats them as a guarantee has the
 * relationship backwards, which is why neither function filters on anything the transaction re-checks.
 */

export interface BookableRoomRow {
  readonly roomId: string
  readonly code: string
  readonly name: string
  readonly capacity: number
  readonly roomType: string
}

/**
 * Every room the salon books into, in the order the diary lays them out.
 *
 * `is_bookable` and not every row: a decommissioned room is still referenced by last year's appointments
 * and must stay in the table, but it is not somewhere a treatment can have happened this week. Ordered by
 * `display_order, code` — the same order `calendar-day.ts` uses, so the select on this screen and the
 * columns on the diary name the rooms in one sequence rather than two.
 */
export async function readBookableRooms(sql: Sql): Promise<readonly BookableRoomRow[]> {
  const rows = await sql<
    { id: string; code: string; name: string; capacity: number; room_type: string }[]
  >`
    select id::text as id, code, name, capacity, room_type::text as room_type
      from rooms where is_bookable
     order by display_order, code
  `
  return rows.map((row) => ({
    roomId: row.id,
    code: row.code,
    name: row.name,
    capacity: Number(row.capacity),
    roomType: row.room_type,
  }))
}

/**
 * The skill a variant's style requires, or `null` when the catalogue does not say.
 *
 * Through `service_skill` and not through a mapping in TypeScript, for ADR 0021's reason: the style is the
 * catalogue axis and the skill is the staffing axis, and `service_skill.style` is the one row that joins
 * them. A copy here would be a second answer that drifts the first time a style is added.
 *
 * `null` rather than a throw, because the caller's remedy is a sentence on screen — the treatment cannot
 * be recorded because nobody has said who is qualified to give it — not a 500 on a form submission.
 */
export async function readRequiredSkillForVariant(
  sql: Sql,
  serviceVariantId: string,
): Promise<TherapistSkill | null> {
  const [row] = await sql<{ required_skill: string }[]>`
    select sk.required_skill::text as required_skill
      from service_variant v
      join service s        on s.id = v.service_id
      join service_skill sk on sk.style = s.style
     where v.id = ${serviceVariantId}
  `
  return row === undefined ? null : (row.required_skill as TherapistSkill)
}
