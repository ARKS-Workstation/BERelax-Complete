import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MERGE_PARTICIPANTS } from './merge-participants.ts'

/**
 * Migration 0149's structural claims, read off the SQL, plus the three registrations that are invisible
 * to a database which already has the tables (A-FIRST-08).
 *
 * ## Why a static test beside the integration one
 *
 * `attribution.itest.ts` proves the refusals FIRE against a real PostgreSQL, which is the claim that
 * matters. It cannot prove they are still DECLARED: a trigger deleted from the migration is invisible to
 * a database that already has it, so the suite stays green on a tree that no longer creates it and the
 * next person to build a database from `packages/db/migrations` gets a schema with no write-once first
 * touch and no bound on a last touch. `analytics-dispatch.test.ts` states the same reason for 0137.
 *
 * ## The most important assertions in this file
 *
 * The two about things that DO NOT fail loudly. The absence of a foreign key to `analytics.session` is
 * one: a key added here would look like an improvement, would pass every test for ninety days, and would
 * then either block the retention purge or cascade away the claim the whole unit exists to preserve. The
 * call in `createBooking` is the other: without it nothing writes an attribution row at all, every
 * assertion in `attribution.itest.ts` still passes because that file calls the writer directly, and the
 * symptom is an attribution-coverage figure that reads as a marketing failure.
 */

const MIGRATION = 'packages/db/migrations/0149_attribution_columns.sql'
const MIRROR = 'packages/db/src/schema/attribution.ts'
const WRITER = 'packages/db/src/repositories/attribution.ts'
const BOOKING = 'packages/db/src/repositories/create-booking.ts'
const RIGHTS_POLICY = 'packages/core/src/privacy/rights-policy.ts'
const ERASURE = 'packages/db/src/repositories/rights.ts'

const sql = readFileSync(MIGRATION, 'utf8')
const mirror = readFileSync(MIRROR, 'utf8')
const writer = readFileSync(WRITER, 'utf8')
const booking = readFileSync(BOOKING, 'utf8')
const rightsPolicy = readFileSync(RIGHTS_POLICY, 'utf8')
const erasure = readFileSync(ERASURE, 'utf8')

describe('the origination shape is stated once', () => {
  it('is an IMMUTABLE function both tables’ CHECKs call, rather than two copies of one rule', () => {
    expect(sql).toContain('create function attribution_origination_is_well_formed(')
    expect(sql).toContain('immutable')
    // Both tables, by name. Two hand-written copies of this rule would drift into one table accepting a
    // row the other refuses, which is the brief's "a second statement of a fact drifts".
    expect(sql).toContain(
      'constraint customer_attribution_origination_well_formed\n    check (attribution_origination_is_well_formed(',
    )
    expect(sql).toContain(
      'constraint booking_attribution_origination_well_formed\n    check (attribution_origination_is_well_formed(',
    )
  })

  it('admits offline as a FIFTH basis and keeps its spelling to one', () => {
    expect(sql).toContain("p_basis in ('utm', 'click_id', 'referrer', 'direct', 'offline')")
    // One spelling each. Without these a direct visit arrives as ('direct','none'), ('(direct)','(none)')
    // or ('direct','') from three callers and the report shows three rows for one thing.
    expect(sql).toContain("p_basis <> 'direct' or (p_source = 'direct' and p_medium = 'none')")
    expect(sql).toContain("p_basis <> 'offline' or (p_source = 'offline' and p_medium = 'direct')")
  })

  it('makes a session and an offline basis mutually exclusive in BOTH directions', () => {
    // `=` and not an implication. A row claiming `offline` WITH a session would be counted as
    // unattributed while naming the session that attributes it; a web basis with NO session is a claim
    // with no evidence behind it. A one-sided rule accepts one of the two.
    expect(sql).toContain("and (p_basis = 'offline') = (p_session_reference is null)")
  })

  it('confines a how-heard answer to an offline touch and refuses a blank one', () => {
    expect(sql).toContain("and (p_how_heard is null or p_basis = 'offline')")
    // A blank is a staff member who pressed Enter. Stored, it would read as an answer in every count of
    // how-heard responses, which is brief rule 15 applied to an absence.
    expect(sql).toContain("and (p_how_heard is null or btrim(p_how_heard) <> '')")
  })
})

describe('the two refusals are declared', () => {
  it('lets a first touch move EARLIER and nothing else (ZY691)', () => {
    expect(sql).toContain('create function assert_first_touch_only_moves_earlier()')
    // Strictly earlier, which is the rule that makes write-once and the merge fold ONE rule. `<=` here
    // would permit an equal-instant overwrite, which is every re-run of a resolver rewriting the claim.
    expect(sql).toContain('if new.occurred_at < old.occurred_at then')
    expect(sql).toContain("using errcode = 'ZY691'")
    expect(sql).toContain(
      'create trigger customer_attribution_first_touch_is_write_once\n  before update on customer_attribution',
    )
  })

  it('bounds a last touch by its own booking, inclusively (ZY692)', () => {
    expect(sql).toContain('create function assert_last_touch_precedes_its_booking()')
    expect(sql).toContain('select b.created_at into v_created_at from booking b')
    // `<=` and not `<`: a one-page quick-book takes the booking in the same instant as the session that
    // produced it, and a strict bound would discard exactly the sessions that convert fastest.
    expect(sql).toContain('if new.occurred_at <= v_created_at then')
    expect(sql).toContain("using errcode = 'ZY692'")
    expect(sql).toContain('before insert or update on booking_attribution')
  })

  it('folds the earlier first touch onto a merge survivor, on the merge_record insert', () => {
    expect(sql).toContain('create function fold_first_touch_onto_merge_survivor()')
    // The fold is conditional on the loser's claim being EARLIER. Without the predicate it would
    // overwrite the survivor's claim with a later one, which ZY691 would then refuse — so the merge
    // would fail rather than silently moving the attribution, but it would fail on every merge.
    expect(sql).toContain('and l.occurred_at < s.occurred_at')
    expect(sql).toContain(
      'create trigger merge_record_folds_first_touch\n  after insert on merge_record',
    )
  })
})

describe('what the migration deliberately does NOT declare', () => {
  it('has no foreign key to analytics.session, in either direction', () => {
    // The assertion about the thing that does not fail loudly. A key here would look like an
    // improvement, pass every test for ninety days, and then either block `analytics.run_retention` or
    // cascade away the claim this whole unit exists to preserve.
    expect(sql).not.toMatch(/references\s+analytics\./i)
    expect(mirror).not.toMatch(/references\(/)
    // And the mirror says so, because somebody assembling a write from the Drizzle definitions is
    // exactly who would add one.
    expect(mirror).toContain('NOT a foreign key and never will be')
  })

  it('grants DELETE, so C-CRM-10’s erasure stays a statement rather than a definer branch', () => {
    expect(sql).toContain(
      'grant select, insert, update, delete on customer_attribution, booking_attribution to berelax_app',
    )
  })
})

describe('the registrations a database that already has the tables cannot see', () => {
  it('registers customer_attribution as a merge participant keyed on the customer alone', () => {
    const entry = MERGE_PARTICIPANTS.find((p) => p.table === 'customer_attribution')
    expect(
      entry,
      'customer_attribution carries a customer_id, so a merge must account for it',
    ).not.toBeUndefined()
    expect(entry?.strategy).toBe('repoint_update')
    // The primary key IS the customer id, so the conflict test is on no further column. `null` here
    // would claim no unique key involves the customer, which is false and would make the statement
    // attempt an UPDATE the primary key refuses.
    expect(entry?.conflictKey).toEqual([])
    expect(entry?.retainedReason).toContain('EARLIER')
  })

  it('classifies both new columns in the erasure catalogue, and gives the first a statement', () => {
    // An unclassified customer-scoped column REFUSES every customer erasure, which is the failure the
    // deferral NOTE on A-FIRST-01, A-FIRST-05 and A-FIRST-07 each named.
    expect(rightsPolicy).toContain("key: 'public.customer_attribution.customer_id'")
    expect(rightsPolicy).toContain("key: 'public.booking_attribution.booking_id'")
    // And the statement that carries the first one out. A rule with no statement reports its rows as
    // acted on while changing nothing, which is the quietest way for an erasure to be incomplete —
    // `rights.itest.ts` holds the two sets equal and this is the half a unit test can see.
    expect(erasure).toContain("ruleKey: 'public.customer_attribution.customer_id'")
  })

  it('is written inside the booking transaction rather than by an outbox handler', () => {
    // Without this call nothing writes an attribution row at all. Every assertion in
    // `attribution.itest.ts` still passes, because that file calls the writer directly — and the symptom
    // is an attribution-coverage figure that reads as a marketing failure.
    expect(booking).toContain('await recordBookingAttribution(uow.sql, {')
    expect(booking).toContain("import { recordBookingAttribution } from './attribution.ts'")
  })
})

describe('the writer’s own two claims', () => {
  it('bounds the last-touch selection in the STATEMENT and orders it totally', () => {
    // The bound is what stops a later session overwriting the touch that produced the booking, and it is
    // in SQL because the alternative is reading every session of a visitor into the application.
    expect(writer).toContain('and s.started_at <= b.created_at')
    // Total in both directions, for the reason the pure comparator is: two sessions of one visitor can
    // share a `started_at` to the millisecond, and without the tie-break the answer depends on the order
    // PostgreSQL happened to return the rows in.
    expect(writer).toContain('order by s.started_at desc, s.session_id desc')
    expect(writer).toContain('order by s.started_at, s.session_id')
  })

  it('makes the first-touch upsert converge rather than accumulate', () => {
    // The `where` on the `do update` is what makes this write-once: a later claim changes nothing, so
    // replaying sessions in any order converges, and an EARLIER one replaces the row — which is the only
    // replacement ZY691 permits. Without it every pass would rewrite the claim and ZY691 would refuse.
    expect(writer).toContain('where excluded.occurred_at < customer_attribution.occurred_at')
  })

  it('counts a paid booking with no attribution as `unknown` rather than dropping it', () => {
    // Dropping it would shrink the denominator by exactly the bookings nobody attributed, so the
    // coverage figure would rise towards 100% as the attribution got worse.
    expect(writer).toContain("coalesce(ba.source, 'unknown') as source")
    // "Paid" is the LEDGER's fact. A funnel that counted its own idea of paid would disagree with the
    // invoice the moment a refund landed.
    expect(writer).toContain('st.outstanding_fils <= 0')
  })
})
