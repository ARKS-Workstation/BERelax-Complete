import type { Sql } from '../connection.ts'

/**
 * The nineteen therapist employment records — the headcount, and deliberately nothing else.
 *
 * ## Why this is a seed and not a fixture
 *
 * `packages/fixtures/src/salon.ts` generates a synthetic eight-therapist salon for the demo book. This
 * is not that. docs/13 §5 states a fact about the real business — **19 therapists** — and
 * `assets/media/` holds 19 photographs of those 19 identifiable people (`Y12-consent-photo`). So the
 * roster belongs beside `premises.ts` and `catalogue.ts`, which are transcriptions of docs/13 rather
 * than generated data.
 *
 * ## What is seeded and what is refused
 *
 * `Y8-staff` asks for "names, skills (Asian/Arabic style), languages, gender, certification expiries"
 * and records the build's provisional position as exactly two things: **19 unnamed therapists, style
 * skills split evenly**. That is what this writes, and the rest is left NULL on purpose:
 *
 *   - **`display_name` NULL and `photo_consent` false.** docs/13 §5: names "will be set in the backend
 *     by the admin", and none has been supplied (`Y12-names`). `employee.is_publishable` is GENERATED
 *     from those two columns, so every one of the nineteen is unpublishable and the therapist grid
 *     renders a photograph with no name and no link — which is also the launch state the prototype is
 *     in. A photograph is never given a name here: the two would then be a claim about which person is
 *     in which picture, and nobody has made it.
 *   - **`gender` NULL.** Migration 0030 left the column nullable in so many words — "a NOT NULL here
 *     would have this migration invent nineteen people's genders (Y8-staff)" — and seeding nineteen
 *     genders does the thing that migration refused to do. It is also not inert: gender is a hard
 *     constraint on assignment (B-AVAIL-05, strict by default), so an invented one would make the
 *     booking engine decide who may treat whom from a fact the build made up.
 *   - **Wages, allowances and `contract_type` NULL.** A wage nobody has supplied is not zero: zero is a
 *     figure that flows into a WPS salary file and a gratuity accrual as though somebody had agreed it.
 *   - **No `employee_language` rows at all.** docs/13 §5 publishes no languages. A language is an
 *     attribute of a real person and there is nothing to derive one from — unlike the skill split, which
 *     follows from the published menu.
 *   - **No `employee_document` rows, so no credentials.** The consequence is deliberate and is
 *     B-AVAIL-04's rule working: a mandatory document type with no row at all is `credential_missing`,
 *     so none of the nineteen is bookable. Availability offering nothing until the HR file exists is the
 *     loud failure; a roster that could be booked on invented credentials is the quiet one.
 *
 * ## Why the skills ARE seeded, when the genders are not
 *
 * The difference is whether there is anything to derive the value from, and whether the assumption is
 * visible afterwards. The business publishes both an Asian and an Arabic menu (docs/13 §4), so its
 * therapists must collectively hold both skills — the split across individuals is an assumption, but the
 * existence of both is not. And `employee_skill` carries the provenance pair 0030 built for exactly
 * this (`is_provisional`, `open_question_id`), so every seeded skill row appears in the Unconfirmed
 * Assumptions panel naming `Y8-staff`. `employee.gender` has no per-value marker, so a seeded gender
 * would be indistinguishable from a confirmed one — which is brief rule 15 precisely.
 *
 * Idempotent: `on conflict do nothing` on `staff_reference`, so `pnpm seed` may run twice, and a run
 * after an admin has set a display name does not undo it.
 */

/** docs/13 §5. The one fact about the roster that has been supplied. */
export const THERAPIST_HEADCOUNT = 19

/**
 * The internal handle, never a display name.
 *
 * `Therapist 01`, zero-padded so the rota sorts in the order a person would read. The same spelling
 * `therapistReference()` uses in `packages/fixtures/src/salon.ts`, so the two datasets do not describe
 * one person under two labels.
 */
export const therapistStaffReference = (index: number): string =>
  `Therapist ${String(index).padStart(2, '0')}`

/**
 * The style skills, split evenly across the roster.
 *
 * Odd headcount, so the split cannot be exact: 10 Asian and 9 Arabic. The remainder goes to Asian
 * because the published menu has more Asian-style treatments (docs/13 §4) — a stated tie-break rather
 * than an accident of rounding, so the next reader knows it was a choice.
 */
export const therapistStyleSkill = (index: number): 'asian_style' | 'arabic_style' =>
  index % 2 === 1 ? 'asian_style' : 'arabic_style'

/** The open question every row written here is provisional against. */
const OPEN_QUESTION = 'Y8-staff'

const PROVISIONAL_NOTE =
  'Headcount only. docs/13 SS5 states 19 therapists and nothing else about them: no names ' +
  '(Y12-names), no photography consent (Y12-consent-photo), no genders, no languages, no contract ' +
  'terms and no wages. Y8-staff is the handover item that answers all of them.'

/**
 * The employment start date every seeded row carries.
 *
 * `employed_from` is NOT NULL (0030) and is compared against the trading date, so a row needs one to be
 * eligible on any date at all. `1970-01-01` is deliberately not plausible as an employment date for
 * this business: it cannot be mistaken for a transcribed fact, it makes every therapist employed on
 * every trading date the calendar covers, and it is visibly the epoch rather than a guess at a joining
 * date. The real dates come with the HR file; `is_provisional` is what says so.
 */
const PROVISIONAL_EMPLOYED_FROM = '1970-01-01'

export interface TherapistRosterResult {
  readonly employeesWritten: number
  readonly skillsWritten: number
}

/** Writes the nineteen employment records and their provisional style skills. Idempotent. */
export async function seedTherapistRoster(sql: Sql): Promise<TherapistRosterResult> {
  const references = Array.from({ length: THERAPIST_HEADCOUNT }, (_, i) =>
    therapistStaffReference(i + 1),
  )

  // Every column not named here stays at its default or NULL, which is the point of this seed. In
  // particular: display_name, gender, contract_type and all four wage columns.
  const inserted = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from, is_provisional, provisional_note,
                          open_question_id)
    select reference, ${PROVISIONAL_EMPLOYED_FROM}::date, true, ${PROVISIONAL_NOTE}, ${OPEN_QUESTION}
      from unnest(${references}::text[]) as reference
    on conflict (staff_reference) do nothing
    returning id
  `

  // Read the ids back rather than using `inserted`: on a second run the insert returns nothing and the
  // skills still have to be ensured, which is what makes this idempotent rather than merely re-runnable.
  const roster = await sql<{ id: string; staff_reference: string }[]>`
    select id, staff_reference
      from employee
     where staff_reference = any(${references}::text[])
     order by staff_reference
  `

  const skills = roster.map((row) => ({
    employeeId: row.id,
    skill: therapistStyleSkill(Number(row.staff_reference.slice(-2))),
  }))

  const skillRows = await sql<{ employee_id: string }[]>`
    insert into employee_skill (employee_id, skill, is_provisional, open_question_id)
    select employee_id::uuid, skill::therapist_skill, true, ${OPEN_QUESTION}
      from unnest(${skills.map((s) => s.employeeId)}::text[], ${skills.map((s) => s.skill)}::text[])
        as t(employee_id, skill)
    on conflict (employee_id, skill) do nothing
    returning employee_id
  `

  return { employeesWritten: inserted.length, skillsWritten: skillRows.length }
}
