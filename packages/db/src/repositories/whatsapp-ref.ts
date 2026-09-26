import { randomInt } from 'node:crypto'
import {
  AppError,
  WHATSAPP_REF_ALPHABET,
  WHATSAPP_REF_CODE_LENGTH,
  WHATSAPP_REF_CODE_PATTERN,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The WhatsApp ref loop's reads and writes (B-UI-04, migration 0079).
 *
 * Four functions, and the split between them is the deferred-scope contract of docs/12 §1 rather than an
 * arrangement of convenience:
 *
 *   - {@link issueWhatsappRef} is **the real interface A-FIRST will implement against**. It exists now,
 *     with the signature the real generator needs, so that filling the port later is a call site rather
 *     than a rewrite. Nothing in this build calls it outside tests, and that is stated on the table itself:
 *     `whatsapp_ref` ships empty.
 *   - {@link matchWhatsappRef} is the lookup the booking path makes. It answers a ROW or `null`, never a
 *     boolean, because `decideRefCapture` in `@berelax/core` takes the matched row as its input and
 *     therefore cannot infer a match from anything else.
 *   - {@link recordRefCapture} writes the one capture row a booking gets.
 *   - {@link readRefCaptureCounts} counts, in SQL.
 *
 * ## Why the counts are `count(*)` and never a stored total
 *
 * `settings-store.itest.ts` cost this repository a real defect that is worth not repeating: it read a
 * DELTA through a capped reader, both sides of the subtraction pinned at the cap, and three recorded
 * changes read as zero. The same shape is available here in two flavours — a `whatsapp_ref.times_used`
 * counter, or paging the capture rows and counting them in JavaScript — and both are wrong for the same
 * reason. A counter beside the rows is a number that can disagree with them, and a paged count is a count
 * with a limit in it. So the numerator and the denominator are `count(*) filter (where …)` in ONE
 * statement, which cannot disagree with itself and has no limit to forget.
 */

/** The outcome vocabulary, mirroring `whatsapp_ref_capture_outcome` (0079) and core's own list. */
export const REF_CAPTURE_OUTCOME_NAMES = ['matched', 'unknown_code', 'not_offered'] as const
export type RefCaptureOutcomeName = (typeof REF_CAPTURE_OUTCOME_NAMES)[number]

/** One issued code. */
export interface WhatsappRefRow {
  readonly refCode: string
  readonly sessionReference: string
  readonly issuedAtIso: string
}

/**
 * A code, drawn uniformly from the unambiguous alphabet.
 *
 * `randomInt` from `node:crypto` and not `Math.random`: the code space is 32^4, so a predictable sequence
 * would make one conversation's code guessable from another's — and although guessing one only misattributes
 * a booking rather than disclosing anything, a generator whose output can be enumerated makes the whole
 * join worthless.
 *
 * In `packages/db` rather than `@berelax/core` because core is pure: it may not read a clock and may not
 * draw a random number. The SHAPE of a code is in `@berelax/shared`, which is what both sides read.
 */
export function mintWhatsappRefCode(): string {
  let code = ''
  for (let index = 0; index < WHATSAPP_REF_CODE_LENGTH; index += 1) {
    code += WHATSAPP_REF_ALPHABET[randomInt(WHATSAPP_REF_ALPHABET.length)]
  }
  return code
}

/** How many times {@link issueWhatsappRef} redraws on a collision before giving up. */
export const WHATSAPP_REF_MINT_ATTEMPTS = 8

export interface IssueWhatsappRefInput {
  /** A-FIRST's handle for the conversation. Opaque, and never a phone number (Y1-nap). */
  readonly sessionReference: string
  /**
   * The code to issue, when the caller has one. Absent means draw one.
   *
   * Present is the path a FIXTURE takes and the path a backfill takes; absent is A-FIRST's. Both exist
   * because a test that could not name the code it was about would have to read back whatever was drawn,
   * and then the assertion is about the reader rather than about the code.
   */
  readonly refCode?: string
  /** When it was handed out. Absent means now, which is what a live issue means. */
  readonly issuedAt?: Date
}

/**
 * Issues a code into a conversation, redrawing on the only collision that can happen.
 *
 * The retry is bounded and the exhaustion is an error rather than a fall back to a longer code: a code of
 * a different length would not match the page's `pattern`, the column's CHECK or anybody's expectations,
 * and silently changing the shape of the key under the front desk is worse than refusing. Eight attempts
 * against a 32^4 space is exhausted only when the table is very nearly full, which is a capacity problem
 * somebody has to be told about.
 *
 * `on conflict do nothing` plus a row count, rather than a pre-flight `select`: the pre-flight version has
 * a race between the check and the insert, and two conversations issued the same code is precisely the
 * defect that makes an attribution wrong.
 */
export async function issueWhatsappRef(
  uow: UnitOfWork,
  input: IssueWhatsappRefInput,
): Promise<WhatsappRefRow> {
  if (input.refCode !== undefined && !WHATSAPP_REF_CODE_PATTERN.test(input.refCode)) {
    throw new AppError(
      'validation',
      `"${input.refCode}" is not a WhatsApp ref code: four characters from A-Z and 2-9, excluding I, O, ` +
        '0 and 1.',
      { details: { refCode: input.refCode } },
    )
  }
  const attempts = input.refCode === undefined ? WHATSAPP_REF_MINT_ATTEMPTS : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = input.refCode ?? mintWhatsappRefCode()
    const [row] = await uow.sql<{ ref_code: string; session_reference: string; issued_at: Date }[]>`
      insert into whatsapp_ref (ref_code, session_reference, issued_at)
      values (${candidate}, ${input.sessionReference},
              ${input.issuedAt === undefined ? uow.sql`now()` : input.issuedAt})
      on conflict (ref_code) do nothing
      returning ref_code, session_reference, issued_at
    `
    if (row === undefined) continue
    await uow.audit.record({
      action: 'whatsapp_ref.issue',
      entityType: 'whatsapp_ref',
      entityId: row.ref_code,
      operation: 'create',
      after: { sessionReference: row.session_reference },
    })
    return {
      refCode: row.ref_code,
      sessionReference: row.session_reference,
      issuedAtIso: row.issued_at.toISOString(),
    }
  }
  throw new AppError(
    'invariant_violated',
    `Could not issue a WhatsApp ref code in ${attempts} attempt(s): every candidate was already taken. ` +
      'The code space is nearly exhausted, which is a capacity decision rather than something to retry ' +
      'around — a longer code would not match the field, the column or the desk.',
    { details: { attempts } },
  )
}

/**
 * The row a typed code names, or null.
 *
 * A row and not a boolean, so the caller cannot construct a match from anything but a row that exists —
 * see `decideRefCapture`'s own header. The comparison is on the primary key and the value is expected
 * already normalised: `normaliseWhatsappRefCode` is the single normaliser and doing it again here would be
 * a second opinion about the alphabet.
 */
export async function matchWhatsappRef(sql: Sql, refCode: string): Promise<WhatsappRefRow | null> {
  const [row] = await sql<{ ref_code: string; session_reference: string; issued_at: Date }[]>`
    select ref_code, session_reference, issued_at from whatsapp_ref where ref_code = ${refCode}
  `
  return row === undefined
    ? null
    : {
        refCode: row.ref_code,
        sessionReference: row.session_reference,
        issuedAtIso: row.issued_at.toISOString(),
      }
}

export interface RecordRefCaptureInput {
  readonly bookingId: string
  readonly outcome: RefCaptureOutcomeName
  /** The matched code. Required for `matched` and refused for everything else, by the column's CHECK. */
  readonly refCode?: string | null
  /** What was typed. Required for `unknown_code` and refused for everything else, likewise. */
  readonly enteredCode?: string | null
}

export interface RecordedRefCapture {
  readonly bookingId: string
  readonly outcome: RefCaptureOutcomeName
  readonly refCode: string | null
  readonly enteredCode: string | null
  /** False when a row for this booking already existed, which is what a retried booking produces. */
  readonly inserted: boolean
}

/**
 * Writes the one capture row a booking gets, idempotently.
 *
 * `on conflict (booking_id) do nothing` and `inserted` reported back, because the booking endpoint is
 * idempotent: a retry after a timeout returns the ORIGINAL booking, and a capture path that upserted would
 * count that booking twice or rewrite the first decision with a second one. The first decision stands, and
 * `inserted: false` is how the caller knows nothing moved. (UPDATE is revoked from `berelax_app` anyway, so
 * `do update` would be refused by the server rather than merely wrong.)
 *
 * The audit row is written explicitly rather than by trigger. A trigger would be the stronger guarantee,
 * and the reason not to reach for one is that the only existing generic trigger function is 0053's
 * `record_crm_vocabulary_change`, whose name and comment are about a CRM vocabulary — reusing it here
 * would put misleading prose on this table's behaviour, and a fourth copy of the same thirty lines of
 * plpgsql is worse again. Gate case 106f removes this call and requires the pair suite to notice.
 */
export async function recordRefCapture(
  uow: UnitOfWork,
  input: RecordRefCaptureInput,
): Promise<RecordedRefCapture> {
  const [row] = await uow.sql<
    {
      booking_id: string
      outcome: RefCaptureOutcomeName
      ref_code: string | null
      entered_code: string | null
    }[]
  >`
    insert into booking_whatsapp_ref_capture (booking_id, outcome, ref_code, entered_code)
    values (${input.bookingId}::uuid, ${input.outcome}::whatsapp_ref_capture_outcome,
            ${input.refCode ?? null}, ${input.enteredCode ?? null})
    on conflict (booking_id) do nothing
    returning booking_id::text as booking_id, outcome::text as outcome, ref_code, entered_code
  `
  if (row === undefined) {
    const [existing] = await uow.sql<
      {
        booking_id: string
        outcome: RefCaptureOutcomeName
        ref_code: string | null
        entered_code: string | null
      }[]
    >`
      select booking_id::text as booking_id, outcome::text as outcome, ref_code, entered_code
        from booking_whatsapp_ref_capture where booking_id = ${input.bookingId}::uuid
    `
    if (existing === undefined) {
      throw new AppError(
        'invariant_violated',
        'The capture row for this booking was neither inserted nor found. `on conflict do nothing` ' +
          'answered nothing and the row is absent, which cannot both be true inside one transaction.',
        { details: { bookingId: input.bookingId } },
      )
    }
    return {
      bookingId: existing.booking_id,
      outcome: existing.outcome,
      refCode: existing.ref_code,
      enteredCode: existing.entered_code,
      inserted: false,
    }
  }
  await uow.audit.record({
    action: 'booking.whatsapp_ref_capture',
    entityType: 'booking_whatsapp_ref_capture',
    entityId: row.booking_id,
    operation: 'create',
    after: { outcome: row.outcome, refCode: row.ref_code, enteredCode: row.entered_code },
  })
  return {
    bookingId: row.booking_id,
    outcome: row.outcome,
    refCode: row.ref_code,
    enteredCode: row.entered_code,
    inserted: true,
  }
}

/** Field for field `RefCaptureCounts` in `@berelax/core`, which computes the rate from it. */
export interface RefCaptureCountsRead {
  readonly matched: number
  readonly unknownCode: number
  readonly notOffered: number
}

export interface RefCaptureCountsQuery {
  /** Inclusive lower bound on `recorded_at`. Absent counts everything. */
  readonly since?: Date
  /**
   * Narrows to these bookings.
   *
   * Production behaviour — a funnel report for one campaign's bookings — and also the only safe isolation
   * for a test: the integration suite runs sequentially against ONE database and earlier files leave rows
   * behind (brief rule 12), so a suite asserting a COUNT has to narrow what the query can see rather than
   * assume it owns the table. An absent filter and an empty one are different questions: empty is a query
   * about no bookings and is answered with zeroes.
   */
  readonly bookingIds?: readonly string[]
}

/**
 * The three counts, in ONE statement.
 *
 * `count(*) filter (where …)` rather than three queries or a group-by read into a map, and the reason is
 * the same one `readPipelineBoard` gives for the board: three reads of the same rows can disagree with
 * each other, so a booking recorded between the first and the third is counted once or twice. One
 * statement cannot disagree with itself.
 *
 * Every outcome is named explicitly and there is no `else` bucket: a fourth enum member added without a
 * change here would be silently absent from the denominator, which is how a capture rate comes to be
 * computed over a subset of the bookings while looking exactly right.
 */
export async function readRefCaptureCounts(
  sql: Sql,
  query: RefCaptureCountsQuery = {},
): Promise<RefCaptureCountsRead> {
  const [row] = await sql<{ matched: string; unknown_code: string; not_offered: string }[]>`
    select count(*) filter (where outcome = 'matched')::text      as matched,
           count(*) filter (where outcome = 'unknown_code')::text as unknown_code,
           count(*) filter (where outcome = 'not_offered')::text  as not_offered
      from booking_whatsapp_ref_capture
     where (${query.since ?? null}::timestamptz is null or recorded_at >= ${query.since ?? null})
       and (${query.bookingIds === undefined} or booking_id = any(${query.bookingIds ?? []}::uuid[]))
  `
  return {
    matched: Number(row?.matched ?? 0),
    unknownCode: Number(row?.unknown_code ?? 0),
    notOffered: Number(row?.not_offered ?? 0),
  }
}
