import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The opening-balance importer, and the reader that refuses to answer a silent zero (P-HR-08, 0066).
 *
 * ## What an opening balance is, and why it is a movement
 *
 * The accrual engine can only derive what it has months for. Everything before that — the leave every
 * therapist has already earned and already taken under whatever arrangement the business kept before this
 * system existed — arrives as ONE stated figure per employee, from the HR handover file. It is written as
 * a `leave_movement` of kind `opening_balance` rather than into a table of its own, and that is the
 * decision this module records: a separate `leave_opening_balance` table holding the same integer would
 * be a second source for the balance, and `leave_balance` sums the movements. The provenance the import
 * needs — the source, who loaded it, the date it is stated at, the provisional flag — is on that same row
 * (`source_note` is NOT NULL for exactly this kind), so nothing is lost by having one table instead of
 * two.
 *
 * ## The un-imported default, which is the acceptance criterion
 *
 * An employee nobody has imported a balance for has a balance of zero **that is an assumption**, and that
 * is a different fact from a balance of zero somebody wrote down. The two need opposite actions: one
 * needs the HR file loading and the other needs nothing at all. So {@link readLeaveOpeningBalances}
 * returns a row for every employee asked about, with `isImported` saying which it is, and the pure
 * constant it corresponds to lives in `@berelax/core` as `PROVISIONAL_OPENING_BALANCE` — flagged, and
 * naming Y8-leave.
 *
 * The absence is therefore reported by the READER and not by a row, and that is forced: there is no row
 * to flag. The Unconfirmed Assumptions panel lists the imported figures that are themselves provisional
 * (`unconfirmedAssumptionRows` reads `leave_movement`), and Y8-leave in `docs/OPEN-QUESTIONS.md` is what
 * records that the un-imported ones exist at all. A zero written into the table for every employee so
 * that it could be flagged would be the worse answer: it would make "nobody has told us" and "they had
 * none" the same row.
 *
 * ## No judgement here
 *
 * `packages/db` may never import `packages/core` — the dependency runs the other way — so this module
 * returns rows and takes figures. Which policy version applies, what a month accrues and what a leave
 * year carries over are `packages/core/src/hr/leave-accrual.ts`'s, and the caller
 * (`apps/worker/src/jobs/leave-accrual.ts`) supplies the answers. The audit row and the outbox event are
 * the caller's too, the same split `repositories/reassignment.ts` states.
 */

/** One imported opening balance, or the flagged default for an employee with none. */
export interface LeaveOpeningBalanceRow {
  readonly employeeId: string
  /** Day-hundredths. 250 is 2.5 days. */
  readonly hundredths: number
  /** False when nothing was imported and this row is the flagged zero. */
  readonly isImported: boolean
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  /** Where the figure came from. Null only when nothing was imported. */
  readonly sourceNote: string | null
  /** The date the figure is stated at. Null only when nothing was imported. */
  readonly asOf: string | null
}

/** One line of the HR handover file, as the importer takes it. */
export interface LeaveOpeningBalanceImport {
  readonly employeeId: string
  /** Day-hundredths, never days. The caller converts with `leaveDays()` from `@berelax/core`. */
  readonly hundredths: number
  /** The date the figure is stated at, which becomes the movement's `occurred_on`. */
  readonly asOf: string
  /** The leave year that date falls in, from `leaveYearStart()` in `@berelax/core`. */
  readonly leaveYearStart: string
  /** Where the figure came from. A blank or placeholder is refused by the database. */
  readonly sourceNote: string
  /** Who loaded it. A label; the audit row carries the full actor. */
  readonly importedBy: string
  /** True when the figure itself is an assumption rather than a stated fact. */
  readonly isProvisional?: boolean
  readonly provisionalNote?: string | null
  /** Required when `isProvisional`; the database refuses the pair otherwise. */
  readonly openQuestionId?: string | null
}

/** What the importer actually wrote. Empty when every line was already imported. */
export interface ImportedOpeningBalance {
  readonly movementId: string
  readonly employeeId: string
  readonly hundredths: number
}

/**
 * Loads opening balances, skipping any employee who already has one.
 *
 * `on conflict do nothing` against `leave_movement_one_opening_balance`, and the insert RETURNS only the
 * rows it wrote — so a re-run of the same file writes nothing, returns nothing, and therefore cannot make
 * the caller write a second audit row or publish a second event. A second import would otherwise ADD to
 * the first rather than replace it, and the balance would be the sum of two statements of the same fact
 * with both looking like figures somebody had checked.
 *
 * A correction to an imported figure is therefore **not** a re-import: it is a further movement, because
 * `leave_movement` is append-only (ZH001) and a balance that could be edited is one nobody can reconcile.
 * That is the same discipline the journal keeps, and it is why this function has no `update` sibling.
 */
export async function importLeaveOpeningBalances(
  sql: Sql,
  lines: readonly LeaveOpeningBalanceImport[],
): Promise<readonly ImportedOpeningBalance[]> {
  if (lines.length === 0) return []
  for (const line of lines) {
    if (!Number.isInteger(line.hundredths) || line.hundredths < 0) {
      throw new AppError(
        'validation',
        `An opening balance must be a whole non-negative number of day-hundredths, got ` +
          `${line.hundredths} for employee ${line.employeeId}. A negative opening balance would be a ` +
          'debt the engine has no movement kind for.',
      )
    }
  }
  const rows = await sql<{ id: string; employee_id: string; hundredths: number }[]>`
    insert into leave_movement
      (employee_id, kind, hundredths, occurred_on, leave_year_start,
       created_by, source_note, is_provisional, provisional_note, open_question_id)
    select line."employeeId"::uuid,
           'opening_balance',
           line.hundredths::integer,
           line."asOf"::date,
           line."leaveYearStart"::date,
           line."importedBy",
           line."sourceNote",
           -- isProvisional is optional on the input, so an absent key arrives as NULL and the column is
           -- NOT NULL. Defaulted to FALSE here rather than left to the column's own DEFAULT, because a
           -- DEFAULT does not apply to an explicit NULL - which is how an optional field in a recordset
           -- insert comes to fail a not-null constraint that looked covered.
           coalesce(line."isProvisional", false),
           line."provisionalNote",
           line."openQuestionId"
      -- Column names are QUOTED so they match the JSON keys exactly. jsonb_to_recordset pairs a key to a
      -- column by name and an unquoted identifier is folded to lower case, so employee_id would never
      -- match employeeId and every row would arrive with a null employee.
      from jsonb_to_recordset(${sql.json([...lines] as never)}) as line(
             "employeeId"      text,
             hundredths        integer,
             "asOf"            text,
             "leaveYearStart"  text,
             "sourceNote"      text,
             "importedBy"      text,
             "isProvisional"   boolean,
             "provisionalNote" text,
             "openQuestionId"  text
           )
    -- The partial unique index is the guarantee, not this clause: a second import of the same employee is
    -- refused by the database whatever the caller believes about what it has already loaded.
    on conflict do nothing
    returning id::text as id, employee_id::text as employee_id, hundredths
  `
  return rows.map((row) => ({
    movementId: row.id,
    employeeId: row.employee_id,
    hundredths: row.hundredths,
  }))
}

/**
 * The opening balance for each employee asked about — imported, or the flagged zero.
 *
 * Every requested id gets a row, which is the whole point: a reader that returned only the imported ones
 * would leave the caller to supply the default, and the default is the thing that must not be got wrong
 * in one of several call sites. `isImported: false` is the signal, and the figures that go with it are
 * `PROVISIONAL_OPENING_BALANCE`'s in `@berelax/core` — restated here rather than imported, because
 * `packages/db` may not import `packages/core`, and pinned to it by
 * `apps/worker/src/jobs/leave-accrual.itest.ts`.
 *
 * An empty list is refused rather than silently meaning "everybody", for `readRosteredShifts`'s reason:
 * an empty array is what an unfiltered variable looks like.
 */
export async function readLeaveOpeningBalances(
  sql: Sql,
  employeeIds: readonly string[],
): Promise<readonly LeaveOpeningBalanceRow[]> {
  if (employeeIds.length === 0) {
    throw new AppError(
      'validation',
      'readLeaveOpeningBalances was given an empty employee list. There is no "every employee" reading ' +
        'of an opening balance, and an empty array is what an unfiltered variable looks like.',
    )
  }
  const rows = await sql<
    {
      employee_id: string
      hundredths: number | null
      is_provisional: boolean | null
      open_question_id: string | null
      source_note: string | null
      as_of: string | null
    }[]
  >`
    select asked.id::text            as employee_id,
           m.hundredths             as hundredths,
           m.is_provisional         as is_provisional,
           m.open_question_id       as open_question_id,
           m.source_note            as source_note,
           m.occurred_on::text      as as_of
      from unnest(${[...employeeIds]}::uuid[]) as asked(id)
      -- A LEFT join, because the answer for an employee with no import is a row and not an absence. An
      -- inner join here is exactly the silent-zero defect: the caller would see a shorter list and
      -- default the rest to zero with nothing saying the zero was never stated.
      left join leave_movement m
             on m.employee_id = asked.id and m.kind = 'opening_balance'
     order by asked.id
  `
  return rows.map((row) => ({
    employeeId: row.employee_id,
    hundredths: row.hundredths ?? 0,
    isImported: row.hundredths !== null,
    // Flagged when nothing was imported, whatever the row said — an absent figure is always an
    // assumption. `?? true` rather than a conditional so a NULL from the left join cannot read as false.
    isProvisional: row.hundredths === null ? true : (row.is_provisional ?? true),
    openQuestionId: row.hundredths === null ? 'Y8-leave' : row.open_question_id,
    sourceNote: row.source_note,
    asOf: row.as_of,
  }))
}
