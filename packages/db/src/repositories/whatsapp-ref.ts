import { randomInt } from 'node:crypto'
import {
  AppError,
  PROVISIONAL_WHATSAPP_REF_TTL_DAYS,
  type TradingDateBasis,
  WHATSAPP_REF_ALPHABET,
  WHATSAPP_REF_CODE_LENGTH,
  WHATSAPP_REF_CODE_PATTERN,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { fileUnderTradingDate } from './analytics.ts'

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
export const REF_CAPTURE_OUTCOME_NAMES = [
  'matched',
  'unknown_code',
  'not_offered',
  'ref_expired',
  'ref_conflict',
] as const
export type RefCaptureOutcomeName = (typeof REF_CAPTURE_OUTCOME_NAMES)[number]

/** One issued code, with the lifetime it was issued under. */
export interface WhatsappRefRow {
  readonly refCode: string
  /** `analytics.session.session_id`, as a uuid string. The attribution, when the code is claimed. */
  readonly sessionReference: string
  readonly issuedAtIso: string
  /** When the code stops being claimable. Stamped at issue and never recomputed (0127). */
  readonly expiresAtIso: string
}

/**
 * One issued code as the CLAIM path needs it: the row, plus the prior claim that can conflict with this
 * one.
 *
 * A separate type from {@link WhatsappRefRow} rather than an optional field on it, because the prior claim
 * is a JOIN this query makes and the issue path neither has nor needs — and an optional
 * `claimedByCustomerId` would read as "nobody has claimed it" on every row that never looked.
 */
export interface MatchedWhatsappRefRow extends WhatsappRefRow {
  /**
   * The customer whose booking claimed this code FIRST, or null.
   *
   * The customer and not the booking: one person booking twice out of one conversation is not a conflict,
   * because the code identifies the conversation and both bookings came from it. `order by recorded_at`
   * and `limit 1` is a FIRST-ROW read and not a capped count — the limit is on which claim owns the code,
   * which is a single row by definition, and no figure here is derived from how many rows were returned.
   */
  readonly claimedByCustomerId: string | null
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
  /**
   * The analytics session the code is issued into: `analytics.session.session_id`.
   *
   * A uuid since 0127, enforced by the column's own type, and that is the PII guard rather than a
   * convention — see the schema mirror. A caller with no session has nothing to bind a code to and must
   * not issue one: the code exists to tie a conversation to a browser session, and a code bound to nothing
   * would be a denominator with no numerator possible.
   */
  readonly sessionReference: string
  /**
   * The code to issue, when the caller has one. Absent means draw one.
   *
   * Present is the path a FIXTURE takes and the path a backfill takes; absent is the route's. Both exist
   * because a test that could not name the code it was about would have to read back whatever was drawn,
   * and then the assertion is about the reader rather than about the code.
   */
  readonly refCode?: string
  /** When it was handed out. Absent means now, which is what a live issue means. */
  readonly issuedAt?: Date
  /**
   * How many days the code stays claimable. Absent means the provisional seven of Y12-ref-ttl.
   *
   * An ARGUMENT and not a settings read inside this function, for the shape `refCaptureRate` takes with
   * `expected`: the one reader of `booking.whatsapp_ref_ttl_days` is named at the call site, so a
   * transaction cannot be lengthened by a settings lookup and a test can state the window it is about
   * without writing a settings row. Absent is the PROVISIONAL value rather than "no expiry", which is the
   * direction that cannot silently create an immortal join key.
   */
  readonly ttlDays?: number
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
  /**
   * Where a drawn candidate comes from. The real generator by default, and the ONLY reason it is a
   * parameter is that the retry cannot otherwise be seen to work.
   *
   * A third positional argument with a default rather than a field on {@link IssueWhatsappRefInput},
   * deliberately: a field would travel inside a request-shaped object and a caller could pass a
   * code-choosing function by accident, which is exactly the hole `mintWhatsappRefCode` taking no input
   * exists to close. As a positional argument with a default, every production call site is the default
   * and a test that wants a forced collision has to say so at the call.
   *
   * The alternative was to force a collision statistically — fill enough of the 810,000-code space that a
   * draw collides — and it was rejected twice over: 5,000 rows would be needed for near-certainty, which
   * is a slow case whose vacuity is a probability rather than a fact, and those 5,000 codes could not
   * carry a fixture prefix (they are drawn), so the suite that asserts `whatsapp_ref` ships empty would
   * fail if this one ever crashed before its cleanup. `ingestCollectBatch` takes its session decision as a
   * parameter for the same kind of reason.
   */
  mint: () => string = mintWhatsappRefCode,
): Promise<WhatsappRefRow> {
  if (input.refCode !== undefined && !WHATSAPP_REF_CODE_PATTERN.test(input.refCode)) {
    throw new AppError(
      'validation',
      `"${input.refCode}" is not a WhatsApp ref code: four characters from A-Z and 2-9, excluding I, O, ` +
        '0 and 1.',
      { details: { refCode: input.refCode } },
    )
  }
  const ttlDays = input.ttlDays ?? PROVISIONAL_WHATSAPP_REF_TTL_DAYS
  if (!Number.isInteger(ttlDays) || ttlDays < 1) {
    throw new AppError(
      'validation',
      "A WhatsApp ref code's lifetime must be a whole number of days, at least one; received " +
        `${String(ttlDays)}. Zero days would make expires_at equal issued_at, which the column's own ` +
        'CHECK refuses — and a code that is dead the instant it is issued is a message the customer can ' +
        'never use.',
      { details: { ttlDays } },
    )
  }
  const attempts = input.refCode === undefined ? WHATSAPP_REF_MINT_ATTEMPTS : 1
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const candidate = input.refCode ?? mint()
    // `issued_at` and `expires_at` are derived from ONE expression. Written as a sub-select rather than as
    // two parameters because `now()` evaluated twice in one statement is the same instant but
    // `${issuedAt}` plus a JavaScript-computed expiry is not: a caller that added the days itself would
    // round differently from `make_interval` across a DST change, and the column's own CHECK
    // (`expires_at > issued_at`) would be the first thing to notice.
    const [row] = await uow.sql<
      {
        ref_code: string
        session_reference: string
        issued_at: Date
        expires_at: Date
      }[]
    >`
      insert into whatsapp_ref (ref_code, session_reference, issued_at, expires_at)
      select ${candidate}, ${input.sessionReference}::uuid, i.at,
             i.at + make_interval(days => ${ttlDays}::int)
        from (select ${input.issuedAt === undefined ? uow.sql`now()` : input.issuedAt}::timestamptz as at) i
      on conflict (ref_code) do nothing
      returning ref_code, session_reference::text as session_reference, issued_at, expires_at
    `
    if (row === undefined) continue
    await uow.audit.record({
      action: 'whatsapp_ref.issue',
      entityType: 'whatsapp_ref',
      entityId: row.ref_code,
      operation: 'create',
      // The session and the lifetime, and NOT the code's own characters again — `entityId` already holds
      // them. No contact detail of any kind reaches here, because there is none on the row to reach it.
      after: {
        sessionReference: row.session_reference,
        expiresAt: row.expires_at.toISOString(),
        ttlDays,
      },
    })
    return {
      refCode: row.ref_code,
      sessionReference: row.session_reference,
      issuedAtIso: row.issued_at.toISOString(),
      expiresAtIso: row.expires_at.toISOString(),
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
export async function matchWhatsappRef(
  sql: Sql,
  refCode: string,
): Promise<MatchedWhatsappRefRow | null> {
  const [row] = await sql<
    {
      ref_code: string
      session_reference: string
      issued_at: Date
      expires_at: Date
      claimed_by_customer_id: string | null
    }[]
  >`
    select r.ref_code,
           r.session_reference::text as session_reference,
           r.issued_at,
           r.expires_at,
           -- The FIRST claim, which is the one that owns the conversation. A correlated sub-select rather
           -- than a left join, because a join would multiply the code's row by however many bookings have
           -- matched it and the caller would then have to pick one — which is the picking this does, once,
           -- in the place that can state why recorded_at ascending is the right order.
           (select b.customer_id::text
              from booking_whatsapp_ref_capture c
              join booking b on b.id = c.booking_id
             where c.ref_code = r.ref_code and c.outcome = 'matched'
             order by c.recorded_at, c.booking_id
             limit 1) as claimed_by_customer_id
      from whatsapp_ref r
     where r.ref_code = ${refCode}
  `
  return row === undefined
    ? null
    : {
        refCode: row.ref_code,
        sessionReference: row.session_reference,
        issuedAtIso: row.issued_at.toISOString(),
        expiresAtIso: row.expires_at.toISOString(),
        claimedByCustomerId: row.claimed_by_customer_id,
      }
}

export interface RecordRefCaptureInput {
  readonly bookingId: string
  readonly outcome: RefCaptureOutcomeName
  /**
   * The code. Required for the three RESOLVING outcomes (`matched`, `ref_expired`, `ref_conflict`) and
   * refused for the other two, by the column's own CHECK.
   */
  readonly refCode?: string | null
  /** What was typed. Required for `unknown_code` and refused for everything else, likewise. */
  readonly enteredCode?: string | null
  /**
   * The session the booking is attributed to. Required for `matched` and refused for everything else.
   *
   * It must be the CODE's own session: 0127's ZY332 refuses a row whose value is anything else, so a
   * caller that passed a session of its own choosing is rejected by the database rather than quietly
   * creating an attribution nobody proved. `decideRefCapture` in `@berelax/core` is what supplies it, and
   * it has no other value in scope to supply.
   */
  readonly attributedSessionId?: string | null
}

export interface RecordedRefCapture {
  readonly bookingId: string
  readonly outcome: RefCaptureOutcomeName
  readonly refCode: string | null
  readonly enteredCode: string | null
  readonly attributedSessionId: string | null
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
      attributed_session_id: string | null
    }[]
  >`
    insert into booking_whatsapp_ref_capture
      (booking_id, outcome, ref_code, entered_code, attributed_session_id)
    values (${input.bookingId}::uuid, ${input.outcome}::whatsapp_ref_capture_outcome,
            ${input.refCode ?? null}, ${input.enteredCode ?? null},
            ${input.attributedSessionId ?? null}::uuid)
    on conflict (booking_id) do nothing
    returning booking_id::text as booking_id, outcome::text as outcome, ref_code, entered_code,
              attributed_session_id::text as attributed_session_id
  `
  if (row === undefined) {
    const [existing] = await uow.sql<
      {
        booking_id: string
        outcome: RefCaptureOutcomeName
        ref_code: string | null
        entered_code: string | null
        attributed_session_id: string | null
      }[]
    >`
      select booking_id::text as booking_id, outcome::text as outcome, ref_code, entered_code,
             attributed_session_id::text as attributed_session_id
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
      attributedSessionId: existing.attributed_session_id,
      inserted: false,
    }
  }
  await uow.audit.record({
    action: 'booking.whatsapp_ref_capture',
    entityType: 'booking_whatsapp_ref_capture',
    entityId: row.booking_id,
    operation: 'create',
    after: {
      outcome: row.outcome,
      refCode: row.ref_code,
      enteredCode: row.entered_code,
      attributedSessionId: row.attributed_session_id,
    },
  })
  return {
    bookingId: row.booking_id,
    outcome: row.outcome,
    refCode: row.ref_code,
    enteredCode: row.entered_code,
    attributedSessionId: row.attributed_session_id,
    inserted: true,
  }
}

/** Field for field `RefCaptureCounts` in `@berelax/core`, which computes the rate from it. */
export interface RefCaptureCountsRead {
  readonly matched: number
  readonly unknownCode: number
  readonly notOffered: number
  readonly refExpired: number
  readonly refConflict: number
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
  const [row] = await sql<
    {
      matched: string
      unknown_code: string
      not_offered: string
      ref_expired: string
      ref_conflict: string
    }[]
  >`
    select count(*) filter (where outcome = 'matched')      ::text as matched,
           count(*) filter (where outcome = 'unknown_code') ::text as unknown_code,
           count(*) filter (where outcome = 'not_offered')  ::text as not_offered,
           count(*) filter (where outcome = 'ref_expired')  ::text as ref_expired,
           count(*) filter (where outcome = 'ref_conflict') ::text as ref_conflict
      from booking_whatsapp_ref_capture
     where (${query.since ?? null}::timestamptz is null or recorded_at >= ${query.since ?? null})
       and (${query.bookingIds === undefined} or booking_id = any(${query.bookingIds ?? []}::uuid[]))
  `
  return {
    matched: Number(row?.matched ?? 0),
    unknownCode: Number(row?.unknown_code ?? 0),
    notOffered: Number(row?.not_offered ?? 0),
    refExpired: Number(row?.ref_expired ?? 0),
    refConflict: Number(row?.ref_conflict ?? 0),
  }
}

/** ------------------------------------------------------------------------------------------------
 * The day-level rollup: codes issued, and how many of those were claimed.
 * ------------------------------------------------------------------------------------------------ */

/** One day's figures, as `analytics.daily_ref_capture` holds them. */
export interface DailyRefCaptureRow {
  readonly tradingDate: string
  readonly tradingDateBasis: TradingDateBasis
  readonly codesIssued: number
  readonly codesClaimed: number
  readonly computedAtIso: string
}

/**
 * Recomputes one day's ref-loop figures from the two tables and upserts the row.
 *
 * ## Why RECOMPUTED rather than incremented
 *
 * The obvious shape is `codes_issued = codes_issued + 1` on issue and `codes_claimed = codes_claimed + 1`
 * on a claim, and it is the wrong one for the reason `readRefCaptureCounts` gives about counters: a number
 * kept beside the rows is a number that can disagree with them, and the disagreement is invisible because
 * the rollup is the thing everybody reads. Two increments lost to a rolled-back transaction, one
 * double-counted by a retried booking, and the capture rate is wrong for ever with no way to tell.
 *
 * So both figures are `count(*)` out of `whatsapp_ref` and `booking_whatsapp_ref_capture` in ONE statement
 * and the row is replaced. The consequences are worth stating because they are the whole argument:
 *
 *   - **It is idempotent.** Two runs over the same day produce identical rows but for `computed_at`, which
 *     is what makes it safe to call on every issue and every claim rather than only from a nightly pass.
 *   - **It converges.** A figure that went wrong — because a migration moved rows, or because an earlier
 *     version of this function was wrong — is corrected by the next call, where an increment would have to
 *     be repaired by hand.
 *   - **It cannot drift.** There is no state in which the rollup and the tables disagree and both look
 *     right.
 *
 * ## Why it is called on the write path and not from a nightly job
 *
 * There is no nightly pass to hang it on yet — A-FIRST-09 owns the rollup job — and a function nothing
 * calls is a figure nobody can trust. Calling it inside the issuing and claiming transactions costs one
 * upsert over two indexed counts and gives a figure that is current rather than up to a day stale, which
 * is what the front desk's own footer needs. When A-FIRST-09's pass arrives it calls the same function
 * over a date range, because recomputation makes that a no-op on days nothing changed.
 *
 * ## Which day a code belongs to
 *
 * `fileUnderTradingDate`, which is the same resolution `analytics.session` uses, so a funnel can join the
 * two on `(trading_date, trading_date_basis)` without a second opinion about what a trading date is. It is
 * a QUERY over `public.business_day` rather than `resolveTradingDate` for the reason that function's own
 * header gives: `packages/db` may not import `@berelax/core`, and the answer has to be a date the calendar
 * actually holds because of the foreign key.
 */
export async function rollUpDailyRefCapture(
  uow: UnitOfWork,
  input: {
    /** Any instant inside the day to recompute — normally a code's `issued_at`. */
    readonly atIso: string
  },
): Promise<DailyRefCaptureRow> {
  const filing = await fileUnderTradingDate(uow.sql, input.atIso)
  const [row] = await uow.sql<
    {
      trading_date: string
      trading_date_basis: TradingDateBasis
      codes_issued: string
      codes_claimed: string
      computed_at: Date
    }[]
  >`
    with issued as (
      -- Every code filed under this day, by the SAME resolution the row is keyed on. The join back to
      -- business_day is what makes "filed under" a fact about the calendar rather than about a date range
      -- this statement chose: a code at 01:30 belongs to the previous trading date because that day's
      -- window reaches past midnight, and this is where that is true rather than in a between.
      select r.ref_code
        from whatsapp_ref r
        join public.business_day b
          on b.trading_date = ${filing.tradingDate}::date
       where case
               when ${filing.basis} = 'trading'
                 then r.issued_at >= b.opens_at and r.issued_at < b.closes_at
               -- A gap instant is filed under the NEXT day the calendar opens, so its own window is the
               -- one that ENDS where that day begins: everything after the previous day closed and before
               -- this one opens. Written from the calendar rather than from 02:00-11:00, because a Ramadan
               -- hours override moves both edges and a literal would not follow it.
               else r.issued_at < b.opens_at
                 and r.issued_at >= coalesce(
                       (select p.closes_at from public.business_day p
                         where p.trading_date < b.trading_date
                         order by p.trading_date desc limit 1),
                       '-infinity'::timestamptz)
             end
    )
    insert into analytics.daily_ref_capture
      (trading_date, trading_date_basis, codes_issued, codes_claimed, computed_at)
    select ${filing.tradingDate}::date, ${filing.basis}, count(*),
           count(*) filter (
             where exists (
               select 1 from booking_whatsapp_ref_capture c
                where c.ref_code = issued.ref_code and c.outcome = 'matched'
             )
           ),
           now()
      from issued
    on conflict (trading_date, trading_date_basis) do update
       set codes_issued  = excluded.codes_issued,
           codes_claimed = excluded.codes_claimed,
           computed_at   = excluded.computed_at
    returning trading_date::text as trading_date, trading_date_basis,
              codes_issued::text as codes_issued, codes_claimed::text as codes_claimed, computed_at
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      `The ref-capture rollup for ${filing.tradingDate} (${filing.basis}) neither inserted nor updated a ` +
        'row. The statement is an unconditional upsert over an aggregate, which always produces exactly ' +
        'one row, so this cannot happen without the statement having been changed.',
      { details: { tradingDate: filing.tradingDate, basis: filing.basis } },
    )
  }
  return {
    tradingDate: row.trading_date,
    tradingDateBasis: row.trading_date_basis,
    codesIssued: Number(row.codes_issued),
    codesClaimed: Number(row.codes_claimed),
    computedAtIso: row.computed_at.toISOString(),
  }
}

/**
 * One day's row, or null when nothing has been rolled up for it.
 *
 * `null` and not a zeroed row, because "no codes were issued that day" and "the rollup has never run for
 * that day" are different states and only the first one is a rate of any kind. `refIssueCaptureRate` in
 * `@berelax/core` answers `no_codes_issued` for the first; the second is a caller that has to go and run
 * the rollup.
 */
export async function readDailyRefCapture(
  sql: Sql,
  query: { readonly tradingDate: string; readonly tradingDateBasis: TradingDateBasis },
): Promise<DailyRefCaptureRow | null> {
  const [row] = await sql<
    {
      trading_date: string
      trading_date_basis: TradingDateBasis
      codes_issued: string
      codes_claimed: string
      computed_at: Date
    }[]
  >`
    select trading_date::text as trading_date, trading_date_basis,
           codes_issued::text as codes_issued, codes_claimed::text as codes_claimed, computed_at
      from analytics.daily_ref_capture
     where trading_date = ${query.tradingDate}::date
       and trading_date_basis = ${query.tradingDateBasis}
  `
  return row === undefined
    ? null
    : {
        tradingDate: row.trading_date,
        tradingDateBasis: row.trading_date_basis,
        codesIssued: Number(row.codes_issued),
        codesClaimed: Number(row.codes_claimed),
        computedAtIso: row.computed_at.toISOString(),
      }
}

/** ------------------------------------------------------------------------------------------------
 * The two refusals 0127 makes, and what a caller does about each.
 * ------------------------------------------------------------------------------------------------ */

/**
 * The SQLSTATEs `0127_whatsapp_ref_lifetime.sql` raises.
 *
 * Both are allocated in `packages/db/src/sqlstate-registry.ts` (ADR 0043) and both entries name THIS file
 * as their translator, which is why no other module holds either as a literal: `pnpm sqlstate` checks the
 * translator list in both directions, so a second module carrying one fails the build until the registry
 * names it too.
 *
 * The match is on SQLSTATE alone. Matching on the message would make the translation depend on wording,
 * and a reworded message would silently stop translating — after which the caller that treats "this
 * attribution was never proved" as an unknown failure is the caller that retries it.
 */
export const WHATSAPP_REF_SQLSTATE = {
  /** A `matched` capture row named a code whose lifetime had already run out. */
  claimAfterExpiry: 'ZY331',
  /** A `matched` capture row named a session the code was not issued into, or no code at all. */
  attributionNotProved: 'ZY332',
} as const

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a refusal from `0127_whatsapp_ref_lifetime.sql` into an `AppError`, or `null` for anything
 * else.
 *
 * The KINDS are chosen by what the caller has to go and do, which is the only question a kind answers:
 *
 *   - `conflict` for ZY331. The statement is refused for THIS code at THIS instant and would have been
 *     accepted an hour earlier, which is what `conflict` means everywhere else in this build. The remedy
 *     is a different outcome on the same booking — `ref_expired`, which keeps the code and takes the
 *     booking — and that is a branch the caller takes rather than an error it shows.
 *   - `invariant_violated` for ZY332. This code, not the person at the counter, constructed an attribution
 *     naming a session the code was not issued into. A validation failure would send whoever reads it
 *     looking at what the desk typed, which is the one place the defect is not.
 */
export function whatsappRefError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code }
  switch (code) {
    case WHATSAPP_REF_SQLSTATE.claimAfterExpiry:
      return new AppError('conflict', message, { details })
    case WHATSAPP_REF_SQLSTATE.attributionNotProved:
      return new AppError('invariant_violated', message, { details })
    default:
      return null
  }
}

/**
 * True when the database refused the claim because the code had expired.
 *
 * Exists so the handler can branch rather than parse: `decideRefCapture` has already compared the expiry
 * against the capture instant, so reaching this is the RACE — a code that expired between the decision and
 * the insert — and the correct response is to record `ref_expired` and carry on, not to fail the booking.
 */
export const isRefClaimAfterExpiry = (err: unknown): boolean =>
  sqlState(err) === WHATSAPP_REF_SQLSTATE.claimAfterExpiry
