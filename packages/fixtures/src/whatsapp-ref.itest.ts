import { decideRefCapture, type Instant, REF_CAPTURE_OUTCOMES, refCaptureRate } from '@berelax/core'
import {
  createConnection,
  issueWhatsappRef,
  matchWhatsappRef,
  mintWhatsappRefCode,
  REF_CAPTURE_OUTCOME_NAMES,
  readRefCaptureCounts,
  recordRefCapture,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import {
  normaliseWhatsappRefCode,
  WHATSAPP_REF_ALPHABET,
  WHATSAPP_REF_CODE_PATTERN,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SYNTHETIC_REF_CODE_PREFIX } from './synthetic.ts'

/**
 * B-UI-04 — the WhatsApp ref loop against a real PostgreSQL (migration 0079).
 *
 * In `packages/fixtures` because it exercises the PAIR: `decideRefCapture` is `@berelax/core`'s and the
 * writer is `@berelax/db`'s, the two may not import each other, and this is the only package that may
 * depend on both (brief rule 4). What is asserted here is the half that a unit test cannot reach — the
 * DATABASE refusing a row the rule would never construct — because a rule and a constraint that agree
 * today are a rule and a constraint that can disagree later, and the constraint is the one that holds when
 * somebody writes the row from `psql`.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12). So:
 *
 *   - every count is read through `bookingIds`, narrowing what the query can SEE to this file's own
 *     bookings rather than assuming it owns `booking_whatsapp_ref_capture`;
 *   - the global count is asserted as a DELTA around this file's writes, never as a total;
 *   - the fixture codes are drawn from a prefix no other suite uses and are removed in `afterAll`, and the
 *     bookings are removed first because the capture rows cascade with them.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'bui04 whatsapp ref itest'
/** Four codes on a prefix no other suite uses. `Q` is in the alphabet; `QA` is this file's. */
const CODE_MATCHED = 'QA23'
const CODE_SPARE = 'QA24'
const CODE_UNREFERENCED = 'QA25'
const FIXTURE_CODES = [CODE_MATCHED, CODE_SPARE, CODE_UNREFERENCED] as const
/** Unallocated +971 59 prefix, in a band no other suite uses. */
const PHONE = '+971590000741'

/**
 * The sessions these codes are issued into, as uuids.
 *
 * `whatsapp_ref.session_reference` is a `uuid` since migration 0127, and the type is the PII guard: every
 * other column on that row is one step from a person, so the handle is constrained to the one shape a
 * contact detail cannot take. They are literals rather than `randomUUID()` so a failure names the same
 * session twice, and v7-shaped so they sort as `analytics.session.session_id` does.
 */
const SESSION_A = '0195a000-0000-7000-8000-00000000000a'
const SESSION_B = '0195a000-0000-7000-8000-00000000000b'
const SESSION_UNREFERENCED = '0195a000-0000-7000-8000-00000000000c'

let sql: Sql
let customerId = ''
const bookingIds: string[] = []

const ACTOR = { kind: 'staff', label: MARKER } as const

/** A booking of this file's own, with nothing attached to it. */
async function newBooking(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source, notes)
    values (${customerId}, 'walk_in', ${MARKER})
    returning id::text as id
  `
  const id = (row as { id: string }).id
  bookingIds.push(id)
  return id
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PHONE}, 'front_desk')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id::text as id
  `
  customerId = (customer as { id: string }).id
})

afterAll(async () => {
  if (sql === undefined) return
  /*
    The CAPTURE ROWS first, then the bookings, then the codes.

    `booking_whatsapp_ref_capture.booking_id` is deliberately NOT a foreign key (0079's header says why: six
    suites truncate `booking` by an explicit list), so nothing cascades and a fixture that deleted only its
    bookings would leave capture rows behind — counted in every later capture rate, for ever. The order
    matters the other way too: `ref_code` IS a foreign key, ON DELETE RESTRICT, so the codes cannot go until
    the rows referencing them have.
  */
  if (bookingIds.length > 0) {
    await sql`delete from booking_whatsapp_ref_capture where booking_id = any(${bookingIds}::uuid[])`
    await sql`delete from booking where id = any(${bookingIds}::uuid[])`
  }
  await sql`delete from whatsapp_ref where ref_code = any(${[...FIXTURE_CODES]}::text[])`
  await sql`delete from customer where phone_e164 = ${PHONE}`
  await sql.end({ timeout: 5 })
})

describe('acceptance — the vocabulary is one vocabulary', () => {
  it('pins the enum members to core’s list and to the repository’s, in order', async () => {
    const rows = await sql<{ label: string }[]>`
      select e.enumlabel as label
        from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'whatsapp_ref_capture_outcome'
       order by e.enumsortorder
    `
    const labels = rows.map((row) => row.label)
    // Three lists in three packages that may not import each other. A member added to one and not the
    // others is a therapist— or here an OUTCOME — the caller cannot name, and this is what makes that a red
    // test rather than a silent divergence.
    expect(labels).toEqual([...REF_CAPTURE_OUTCOMES])
    expect(labels).toEqual([...REF_CAPTURE_OUTCOME_NAMES])
    // The control: the enum really has members, so a query that came back empty could not satisfy it.
    // Five since A-FIRST-07 added `ref_expired` and `ref_conflict` — the two states a code that DID
    // resolve can be in without producing an attribution.
    expect(labels.length).toBe(5)
  })
})

describe('acceptance — a code is issued, and matched', () => {
  it('issues a named code and finds it again', async () => {
    const issued = await withUnitOfWork(sql, ACTOR, (uow) =>
      issueWhatsappRef(uow, {
        sessionReference: SESSION_A,
        refCode: CODE_MATCHED,
        issuedAt: new Date('2099-01-01T08:00:00.000Z'),
      }),
    )
    expect(issued.refCode).toBe(CODE_MATCHED)
    expect(issued.issuedAtIso).toBe('2099-01-01T08:00:00.000Z')
    const found = await matchWhatsappRef(sql, CODE_MATCHED)
    expect(found?.sessionReference).toBe(SESSION_A)
    // The lifetime, stamped at issue from the provisional seven days of Y12-ref-ttl (0127). Asserted as
    // the ARITHMETIC against the issue instant rather than as a literal date, so answering the open
    // question moves one constant and not this expectation.
    expect(Date.parse(found?.expiresAtIso ?? '') - Date.parse(found?.issuedAtIso ?? '')).toBe(
      7 * 24 * 60 * 60 * 1000,
    )
    // And a code nobody issued is not found, which is the control: a reader that answered a row for
    // anything would make every booking `matched`.
    expect(await matchWhatsappRef(sql, 'QA99')).toBeNull()
  })

  it('records an audit row naming the surface that issued it', async () => {
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'whatsapp_ref.issue'
    `
    await withUnitOfWork(sql, ACTOR, (uow) =>
      issueWhatsappRef(uow, { sessionReference: SESSION_B, refCode: CODE_SPARE }),
    )
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'whatsapp_ref.issue'
    `
    // A DELTA and never a total: `audit_event` is append-only (ADR 0008) so it only grows, and every other
    // suite in the run writes to it.
    expect(Number(after?.n ?? 0) - Number(before?.n ?? 0)).toBe(1)
  })

  it('refuses a code the alphabet does not allow, before the column has to', async () => {
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        issueWhatsappRef(uow, { sessionReference: SESSION_A, refCode: 'QA2O' }),
      ),
    ).rejects.toThrow(/not a WhatsApp ref code/)
    // And the DATABASE refuses it too, which is the assertion that matters: the TypeScript guard is a
    // courtesy and the CHECK is the rule, and only the second one holds for a `psql` session.
    await expect(
      sql`
        insert into whatsapp_ref (ref_code, session_reference, expires_at)
        values ('QA2O', ${SESSION_A}::uuid, now() + interval '7 days')
      `,
    ).rejects.toThrow(/whatsapp_ref_ref_code_check/)
  })

  it('mints codes only from the unambiguous alphabet', () => {
    // 400 draws, because the four excluded characters are four of thirty-six: a generator that admitted them
    // would produce one about every nine codes, so a handful of draws would miss it most of the time.
    const drawn = new Set<string>()
    for (let index = 0; index < 400; index += 1) {
      const code = mintWhatsappRefCode()
      expect(WHATSAPP_REF_CODE_PATTERN.test(code), code).toBe(true)
      for (const character of code) expect(WHATSAPP_REF_ALPHABET).toContain(character)
      drawn.add(code)
    }
    // The control on the loop: a generator returning one constant would satisfy every assertion above.
    // 400 draws from 30^4 collide rarely; a floor of 350 distinct is far under the expected 399.
    expect(drawn.size).toBeGreaterThan(350)
  })
})

describe('acceptance — the schema makes an invented attribution unrepresentable', () => {
  it('refuses a matched row with no ref code, by whichever half of the rule it broke first', async () => {
    const bookingId = await newBooking()
    // A bare `matched` row breaks TWO constraints at once since A-FIRST-07: it carries no code and no
    // attributed session, and PostgreSQL reports the first one it evaluates. The assertion names the one it
    // reports rather than being loosened to "any error", because a bare non-zero refusal is satisfied by
    // the row being rejected for an unrelated reason.
    await expect(
      sql`
        insert into booking_whatsapp_ref_capture (booking_id, outcome)
        values (${bookingId}::uuid, 'matched')
      `,
    ).rejects.toThrow(/booking_whatsapp_ref_capture_attribution_only_when_matched/)
    // And with the session supplied, so the only thing missing is the code: this is the half 0079 wrote,
    // under the name 0127 gave it when `ref_expired` and `ref_conflict` made `matched_names_its_ref` false.
    await expect(
      sql`
        insert into booking_whatsapp_ref_capture (booking_id, outcome, attributed_session_id)
        values (${bookingId}::uuid, 'matched', ${SESSION_A}::uuid)
      `,
    ).rejects.toThrow(/booking_whatsapp_ref_capture_resolved_names_its_ref/)
  })

  it('refuses a ref code on a row that matched nothing', async () => {
    const bookingId = await newBooking()
    // The hole that matters. A handler bug that recorded `not_offered` while still carrying the code would
    // put an attribution on a booking nobody proved came from that conversation, and every count would read
    // correctly.
    await expect(
      sql`
        insert into booking_whatsapp_ref_capture (booking_id, outcome, ref_code)
        values (${bookingId}::uuid, 'not_offered', ${CODE_MATCHED})
      `,
    ).rejects.toThrow(/booking_whatsapp_ref_capture_resolved_names_its_ref/)
    await expect(
      sql`
        insert into booking_whatsapp_ref_capture (booking_id, outcome, ref_code, entered_code)
        values (${bookingId}::uuid, 'unknown_code', ${CODE_MATCHED}, 'QA77')
      `,
    ).rejects.toThrow(/booking_whatsapp_ref_capture_resolved_names_its_ref/)
  })

  it('refuses an unknown-code row that dropped what was typed, and a typed value on any other outcome', async () => {
    const bookingId = await newBooking()
    await expect(
      sql`
        insert into booking_whatsapp_ref_capture (booking_id, outcome)
        values (${bookingId}::uuid, 'unknown_code')
      `,
    ).rejects.toThrow(/booking_whatsapp_ref_capture_unknown_keeps_what_was_typed/)
    await expect(
      sql`
        insert into booking_whatsapp_ref_capture (booking_id, outcome, entered_code)
        values (${bookingId}::uuid, 'not_offered', 'QA77')
      `,
    ).rejects.toThrow(/booking_whatsapp_ref_capture_unknown_keeps_what_was_typed/)
  })

  it('accepts each shape a live, unclaimed code can produce, which is the control', async () => {
    // Without this every refusal above would be satisfied by a table that refuses everything.
    //
    // Three and not five: `ref_expired` and `ref_conflict` need a code whose lifetime has run out and a
    // code another customer has already claimed, which are states of ANOTHER row rather than of this one.
    // They are proved in `ref-loop.itest.ts`, against the triggers 0127 added for them.
    const matched = await newBooking()
    const unknown = await newBooking()
    const blank = await newBooking()
    for (const [bookingId, entered, matchedCode] of [
      [matched, 'qa23', CODE_MATCHED],
      [unknown, 'zz99', null],
      [blank, '   ', null],
    ] as const) {
      const decision = decideRefCapture({
        entered,
        at: Date.now() as Instant,
        customerId,
        matched:
          matchedCode === null
            ? null
            : {
                refCode: matchedCode,
                sessionId: SESSION_A,
                // Far enough ahead that the lifetime cannot be the thing under test here; the expiry
                // itself is `ref-loop.itest.ts`'s subject.
                expiresAt: (Date.now() + 7 * 24 * 60 * 60 * 1000) as Instant,
                claimedByCustomerId: null,
              },
      })
      const recorded = await withUnitOfWork(sql, ACTOR, (uow) =>
        recordRefCapture(uow, {
          bookingId,
          outcome: decision.outcome,
          refCode: decision.refCode,
          enteredCode: decision.enteredCode,
          attributedSessionId: decision.attributedSessionId,
        }),
      )
      expect(recorded.inserted, bookingId).toBe(true)
      expect(recorded.outcome).toBe(decision.outcome)
      expect(recorded.refCode).toBe(decision.refCode)
    }
    const [row] = await sql<{ outcome: string; ref_code: string | null }[]>`
      select outcome::text as outcome, ref_code from booking_whatsapp_ref_capture
       where booking_id = ${matched}::uuid
    `
    expect(row?.outcome).toBe('matched')
    expect(row?.ref_code).toBe(CODE_MATCHED)
    // The normaliser is what made a lower-case paste match, and it is asserted here rather than assumed:
    // the code the desk typed was `qa23`.
    expect(normaliseWhatsappRefCode('qa23')).toBe(CODE_MATCHED)
  })

  it('refuses to remove a code a booking is attributed to', async () => {
    // ON DELETE RESTRICT, and it is the one foreign key this table has: `booking_id` is deliberately not one
    // (0079's header) and `ref_code` is, because a code withdrawn after the fact would silently turn a matched
    // booking into one whose attribution cannot be followed.
    await expect(sql`delete from whatsapp_ref where ref_code = ${CODE_MATCHED}`).rejects.toThrow(
      /violates foreign key constraint/,
    )
    // The control: a code NOTHING references is removable, so the refusal above is the reference and not a
    // blanket refusal to delete.
    await withUnitOfWork(sql, ACTOR, (uow) =>
      issueWhatsappRef(uow, {
        sessionReference: SESSION_UNREFERENCED,
        refCode: CODE_UNREFERENCED,
      }),
    )
    await sql`delete from whatsapp_ref where ref_code = ${CODE_UNREFERENCED}`
    expect(await matchWhatsappRef(sql, CODE_UNREFERENCED)).toBeNull()
  })

  it('audits the capture, naming the surface that recorded it', async () => {
    const bookingId = await newBooking()
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'booking.whatsapp_ref_capture'
    `
    await withUnitOfWork(sql, ACTOR, (uow) =>
      recordRefCapture(uow, { bookingId, outcome: 'not_offered' }),
    )
    const [after] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'booking.whatsapp_ref_capture'
    `
    // A DELTA and never a total: `audit_event` is append-only (ADR 0008) so it only grows, and every other
    // suite in the run writes to it. An attribution nobody can attribute is the failure this guards.
    expect(Number(after?.n ?? 0) - Number(before?.n ?? 0)).toBe(1)
    const [row] = await sql<{ actor_kind: string; actor_label: string }[]>`
      select actor_kind, actor_label from audit_event
       where action = 'booking.whatsapp_ref_capture' and entity_id = ${bookingId}
    `
    expect(row?.actor_kind).toBe('staff')
    expect(row?.actor_label).toBe(MARKER)
  })

  it('records one row per booking and keeps the FIRST decision on a replay', async () => {
    const bookingId = await newBooking()
    const first = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordRefCapture(uow, {
        bookingId,
        outcome: 'matched',
        refCode: CODE_MATCHED,
        // The CODE's own session and never a value chosen here: 0127's ZY332 refuses anything else.
        attributedSessionId: SESSION_A,
      }),
    )
    expect(first.inserted).toBe(true)
    // The booking endpoint is idempotent: a retry after a timeout returns the ORIGINAL booking. A capture
    // path that upserted would count that booking twice or rewrite the first decision with a second one.
    const second = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordRefCapture(uow, { bookingId, outcome: 'not_offered' }),
    )
    expect(second.inserted).toBe(false)
    expect(second.outcome).toBe('matched')
    expect(second.refCode).toBe(CODE_MATCHED)
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from booking_whatsapp_ref_capture where booking_id = ${bookingId}::uuid
    `
    expect(Number(row?.n ?? 0)).toBe(1)
  })
})

describe('acceptance — both counters, and the rate computed from them', () => {
  it('counts matched and unmatched separately, narrowed to this file’s bookings', async () => {
    const counts = await readRefCaptureCounts(sql, { bookingIds })
    // Written above: two matched (the three-shapes control and the replay case), one unknown, and two blank
    // (the three-shapes control and the audit case). The three ineligible-shape bookings carry no row at all,
    // because every insert for them was refused.
    // Five buckets since A-FIRST-07, and the two it added are zero HERE rather than absent: this file
    // issues no expired or contested code, which is `ref-loop.itest.ts`'s subject.
    expect(counts).toEqual({
      matched: 2,
      unknownCode: 1,
      notOffered: 2,
      refExpired: 0,
      refConflict: 0,
    })

    const rate = refCaptureRate(counts)
    expect(rate.total).toBe(5)
    // An unknown code is in the DENOMINATOR and never in the numerator: a typed code we have no row for is a
    // booking whose attribution is unknown, and putting it in the numerator is the most tempting way to make
    // this screen look like it works.
    expect(rate.capturedBp).toBe(4_000)
    expect(rate.claim).toBe('loop_unconfirmed')
    expect(rate.openQuestionId).toBe('Y12-ref-loop')
  })

  it('asks about nobody when the filter is empty, and about everybody when it is absent', async () => {
    // An absent filter and an empty one are different questions, and conflating them is how a report that
    // should have said "nothing yet" comes to print the whole table's numbers.
    expect(await readRefCaptureCounts(sql, { bookingIds: [] })).toEqual({
      matched: 0,
      unknownCode: 0,
      notOffered: 0,
      refExpired: 0,
      refConflict: 0,
    })
    const everybody = await readRefCaptureCounts(sql)
    const mine = await readRefCaptureCounts(sql, { bookingIds })
    // A DELTA-shaped claim rather than an equality: other suites in the run write capture rows too, so the
    // only safe assertion is that the global count is at least this file's.
    expect(everybody.matched).toBeGreaterThanOrEqual(mine.matched)
    expect(everybody.notOffered).toBeGreaterThanOrEqual(mine.notOffered)
  })

  it('ships the code table EMPTY, which is the honest state of the funnel', async () => {
    /*
      "This BUILD writes no rows" as a row count, narrowed to the rows no fixture owns — other suites may add
      their own, so the claim is about the application's code paths and not about the table being empty at the
      end of a run.

      A-FIRST-07 wired `/api/whatsapp` to `issueWhatsappRef` and the claim still holds, which is the point
      worth reading twice: the route REFUSES to mint a code while `premises.phone_whatsapp` holds the Y1-nap
      placeholder, deliberately, because `codes_issued` is the denominator of the capture rate and a code
      minted into an unsendable message would make a missing phone number read as a front-desk failure.

      The exclusion is by CODE PREFIX and not by session reference, which it used to be: 0127 made
      `session_reference` a uuid, so there is nowhere on the row to write a marker, and
      `SYNTHETIC_REF_CODE_PREFIX` is the one statement of the convention the three suites that issue codes
      share.

      In THIS describe, which is last, rather than in the first one, and for a reason: the filter has to be
      shown to DISCRIMINATE. Run before any code was issued, the count is zero whether the filter excludes the
      right rows or excludes everything, so the assertion could not fail. Here the fixture codes exist, and the
      second half asserts they are still counted.
    */
    const [unowned] = await sql<{ n: string }[]>`
      select count(*)::text as n from whatsapp_ref
       where ref_code not like ${`${SYNTHETIC_REF_CODE_PREFIX}%`}
    `
    expect(Number(unowned?.n ?? -1), 'a code this build wrote').toBe(0)
    const [owned] = await sql<{ n: string }[]>`
      select count(*)::text as n from whatsapp_ref
       where ref_code = any(${[...FIXTURE_CODES]}::text[])
    `
    // The control: the filter above excluded rows that exist, so a filter matching nothing could not have
    // satisfied it. Two of the three fixture codes are still present; the third was deleted on purpose.
    expect(Number(owned?.n ?? 0), 'the filter excludes rows that exist').toBeGreaterThan(0)
  })

  it('counts in SQL, so no limit can pin a count', async () => {
    // The `settings-store.itest.ts` defect, stated as a test: a count read through a capped reader pins at
    // the cap, and three recorded changes read as zero. There is no limit in `readRefCaptureCounts`, and the
    // way that is asserted is that the count of this file's bookings matches a bare `count(*)` over the same
    // ids however the rows are ordered — a paged reader with a limit of one would answer one.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from booking_whatsapp_ref_capture
       where booking_id = any(${bookingIds}::uuid[])
    `
    const counts = await readRefCaptureCounts(sql, { bookingIds })
    expect(
      counts.matched +
        counts.unknownCode +
        counts.notOffered +
        counts.refExpired +
        counts.refConflict,
    ).toBe(Number(row?.n ?? -1))
  })
})
