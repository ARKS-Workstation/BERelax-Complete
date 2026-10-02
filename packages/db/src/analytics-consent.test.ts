import { readFileSync } from 'node:fs'
import { CONSENT_MODE_SIGNALS } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { ANALYTICS_CONSENT_SQLSTATE } from './repositories/analytics-consent.ts'

/**
 * Migration 0125's structural claims, read off the SQL (A-MEAS-02).
 *
 * ## Why a static test beside the integration one
 *
 * `packages/fixtures/src/analytics-consent.itest.ts` proves the refusals FIRE, against a real PostgreSQL,
 * which is the claim that matters. It cannot prove they are still DECLARED: a trigger deleted from the
 * migration is invisible to a database that already has it, so the suite would stay green on a tree that
 * no longer creates it, and the next person to build a database from `packages/db/migrations` would get a
 * schema with no consent gate in it at all. That is gate case 123e's shape, and A-FIRST-05's
 * `collect-ingest.test.ts` is its nearest relative.
 *
 * ## The most important line in this file
 *
 * `default false` on the four session consent columns. Every other assertion here is about something
 * failing loudly; that one is about the direction the system fails in when nothing fails at all. A
 * `default true` would typecheck, apply, pass every integration case in this unit — the suites set the
 * columns explicitly — and silently permit an outbound advertising push for every session written by a
 * writer that had not been taught about consent. There is no runtime assertion that can catch it, because
 * the only evidence would be in somebody else's ad account, so it is caught here, in the text.
 */

const MIGRATION = 'packages/db/migrations/0125_analytics_consent.sql'
const MIRROR = 'packages/db/src/schema/analytics.ts'
const DISPATCH_MIRROR = 'packages/db/src/schema/analytics-dispatch.ts'

const sql = readFileSync(MIGRATION, 'utf8')
const mirror = readFileSync(MIRROR, 'utf8')
const dispatchMirror = readFileSync(DISPATCH_MIRROR, 'utf8')

describe('migration 0125 declares the record and its refusals', () => {
  it('reads the migration at all', () => {
    // The control. Every assertion below is satisfied by an empty string, which is ADR 0002's subject.
    expect(sql.length).toBeGreaterThan(8_000)
    expect(sql).toContain('create table analytics.consent_record')
  })

  it('declares the append-only pair, both halves, on the record', () => {
    /*
     * The pair is where the defect hides: you write one trigger, copy it for the other event, and forget
     * to change the word. `pnpm db:conventions` covers exactly this through the phrase "UPDATE and DELETE
     * raise" in the table's own comment — asserted here too, because the gate keys on it and a reworded
     * comment would silently exempt the table from that gate.
     */
    expect(sql).toMatch(/UPDATE and DELETE raise/)
    expect(sql).toMatch(
      /create trigger \w+ before update on analytics\.consent_record\s+for each row execute function analytics\.refuse_consent_record_change/,
    )
    expect(sql).toMatch(
      /create trigger \w+ before delete on analytics\.consent_record\s+for each row execute function analytics\.refuse_consent_record_change/,
    )
    expect(sql).toContain(`errcode = '${ANALYTICS_CONSENT_SQLSTATE.recordImmutable}'`)
  })

  it("attaches 0056's own wording-hash trigger rather than a second copy of it", () => {
    // A second implementation of "the snapshot must equal the stored version" is a second way for a valid
    // consent record to read as tampered. The function is 0056's; only the trigger is new.
    expect(sql).toMatch(
      /create trigger \w+ before insert on analytics\.consent_record\s+for each row execute function assert_consent_wording_hash/,
    )
    expect(sql, 'the hash check was reimplemented instead of attached').not.toContain(
      'create function assert_consent_wording_hash',
    )
  })

  it('requires a wording version and an instant on every record', () => {
    for (const column of ['consent_wording_id', 'wording_hash', 'decided_at']) {
      expect(
        new RegExp(`${column}\\s+[a-z ]+not null`).test(sql),
        `${column} must be NOT NULL: a record without it cannot answer what anybody agreed to`,
      ).toBe(true)
    }
    // `decided_at` is supplied and never defaulted, so every ordering assertion can be made under a
    // frozen clock. `created_at` beside it is when the row landed.
    expect(sql).toMatch(/decided_at\s+timestamptz not null,/)
    expect(sql).toMatch(/created_at\s+timestamptz not null default now\(\)/)
  })

  it('refuses a grant that grants nothing and a refusal that keeps a signal', () => {
    expect(sql).toContain('constraint consent_record_grant_grants_something')
    expect(sql).toContain('constraint consent_record_refusal_grants_nothing')
  })

  it('puts the record on the retention list, which is what stops the whole pass', () => {
    // `analytics.run_retention` raises ZY062 for a base table in this schema with no row here.
    expect(sql).toMatch(
      /insert into analytics\.retention_policy[\s\S]{0,400}'consent_record',\s*'keep_indefinitely'/,
    )
  })

  it('names no visitor, which is the decision the whole migration is shaped by', () => {
    /*
     * There is no `visitor_id` column on the record and this is the assertion that keeps it that way. The
     * visitor row is created AT consent by `ingestCollectBatch` — the one place the server decides who
     * owns an identifier — and does not exist when the banner is answered, so a column here would be a
     * second minting site. Scoped to the `create table` body so the header may discuss it at length.
     */
    const open = sql.indexOf('create table analytics.consent_record (')
    const body = sql.slice(open, sql.indexOf('\n);', open))
    expect(body.length).toBeGreaterThan(500)
    expect(body).not.toContain('visitor_id')
  })
})

describe('the four session consent columns', () => {
  it('exist, one per Consent Mode v2 signal, named after the signal', () => {
    for (const signal of CONSENT_MODE_SIGNALS) {
      expect(sql, `the session has no column for ${signal}`).toContain(`consent_${signal}`)
      // And the Drizzle mirror has it too, because `pnpm db:drift` compares the two and a mirror that
      // lacked a column would make every query against it fail at runtime on the path nobody exercised.
      expect(mirror, `the mirror has no column for ${signal}`).toContain(`consent_${signal}`)
    }
  })

  it('DEFAULT FALSE, every one of them, which is the fail-closed direction', () => {
    /*
     * The single most important assertion in this file. See the header: a `default true` would apply, pass
     * every integration case and silently permit an outbound push for every session written by a writer
     * that had not been taught about consent.
     *
     * Matched as "the column, then `not null default false` before the next comma or newline", so a
     * default changed to `true` fails here rather than being reported as a missing column.
     */
    for (const signal of CONSENT_MODE_SIGNALS) {
      expect(
        new RegExp(`consent_${signal}\\s+boolean not null default false`).test(sql),
        `consent_${signal} must default to FALSE: a gate that defaults to granted opens by accident`,
      ).toBe(true)
    }
    // And nothing in the migration defaults a consent column to true, in any spelling.
    expect(sql).not.toMatch(/consent_[a-z_]+\s+boolean not null default true/)
  })

  it('are not constrained to be true, which is stated rather than forgotten', () => {
    // `consent_analytics_storage` holds for every session the ingest writes, so a CHECK would pass today
    // and would refuse every fixture row written before this migration — while buying nothing, because the
    // default already makes the unsafe direction impossible. The reason is in the column's own comment.
    expect(sql).toMatch(/Deliberately NOT constrained to true/)
  })
})

describe('the dispatch gate, declared in the database', () => {
  it('states the comparison ONCE, in a function both callers use', () => {
    expect(sql).toContain(
      'create function dispatch_consent_gap(p_session_id uuid, p_destination text)',
    )
    // The trigger calls it rather than repeating the comparison, which is the whole reason it is a
    // function: `enqueueAnalyticsDispatch` is the other caller and `packages/db` may not ask the pure gate.
    expect(sql).toMatch(/v_missing := dispatch_consent_gap\(new\.session_id, new\.destination\)/)
    const repository = readFileSync('packages/db/src/repositories/analytics-consent.ts', 'utf8')
    expect(repository).toContain('dispatch_consent_gap(')
  })

  it('fires on INSERT and on UPDATE, which is what makes a withdrawal airtight', () => {
    // The UPDATE half is the one that matters most: the withdrawal clears the session's columns, so a
    // cancelled row cannot be reinstated or marked sent afterwards.
    expect(sql).toMatch(
      /create trigger \w+\s+before insert or update on analytics_dispatch\s+for each row execute function assert_dispatch_consent/,
    )
    expect(sql).toContain(`errcode = '${ANALYTICS_CONSENT_SQLSTATE.dispatchConsentGate}'`)
  })

  it('tests the gap with `cardinality` and never with `array_length`', () => {
    /*
     * A one-character fail-open. `array_length(x, 1)` is NULL for an empty array, so
     * `array_length(missing, 1) > 0` is NULL for the permitted case — and a `case` whose condition is NULL
     * falls to the `else`, which in the writer is the PERMITTED branch. `cardinality` of an empty array is
     * 0. Both the trigger and the writer are checked, because they each make the test.
     */
    const repository = readFileSync('packages/db/src/repositories/analytics-consent.ts', 'utf8')
    expect(sql).toContain('cardinality(v_missing) = 0')
    expect(repository).toContain('cardinality(gap.missing) = 0')
    expect(sql, 'array_length on the gap is NULL for the permitted case').not.toMatch(
      /array_length\(\s*v_missing/,
    )
    expect(repository, 'array_length on the gap is NULL for the permitted case').not.toMatch(
      /array_length\(\s*gap\.missing/,
    )
  })

  it('raises rather than returning an empty gap for a row it cannot read', () => {
    // An empty gap means PERMITTED, so a function that returned one for a session or a destination it
    // could not find would be a gate that opens for exactly the input it cannot judge. Both guards.
    const open = sql.indexOf('create function dispatch_consent_gap')
    const body = sql.slice(open, sql.indexOf('end $$;', open))
    expect([...body.matchAll(/if not found then/g)]).toHaveLength(2)
  })

  it('refuses a destination that requires no signal at all', () => {
    // The structural fail-closed guard: the natural way to add a destination is to copy a row and clear
    // the flags, and a destination requiring nothing is permitted for every session.
    expect(sql).toContain('constraint analytics_dispatch_destination_requires_something')
    expect(dispatchMirror).toContain('analytics_dispatch_destination_requires_something')
  })

  it('leaves a suppression and a cancellation writable, which is what makes them visible', () => {
    // The trigger must NOT check those two states: refusing to write them would make the suppression
    // silent, which is the one outcome the table exists to prevent.
    expect(sql).toMatch(/if new\.state not in \('queued', 'sent'\) then\s+return new;/)
  })

  it('ties a transmission instant to the sent state in both directions', () => {
    // What makes "nothing was transmitted" a query over a stored fact rather than a claim about what a
    // test did not do.
    expect(sql).toContain('constraint analytics_dispatch_transmitted_iff_sent')
    expect(sql).toMatch(/check \(\(state = 'sent'\) = \(transmitted_at is not null\)\)/)
  })

  it('names the two suppression reasons the acceptance lines use', () => {
    expect(sql).toContain("reason = 'consent_denied'")
    expect(sql).toContain("reason = 'consent_withdrawn'")
    expect(sql).toContain("'cancelled_consent_withdrawn'")
  })
})

describe('the wording version the banner renders', () => {
  it('is published by the migration rather than by the seed', () => {
    // A database with the schema and no seed must still be able to record a consent decision: the record
    // references a wording row, so a tree whose version 1 lived in the seed would refuse every consent a
    // visitor gave on a freshly migrated database.
    expect(sql).toMatch(/insert into consent_wording[\s\S]{0,200}'analytics_measurement', 1,/)
  })

  it('carries the provisional trio, because the copy is legal text nobody has approved', () => {
    expect(sql).toMatch(/'analytics_measurement', 1,[\s\S]{0,900}true, 'Y9-consent-wording'/)
    // And a visible draft marker in both languages, so a reader of the rendered page can see it is a
    // draft — rule 15: a plausible consent statement is indistinguishable from approved copy.
    expect(sql).toContain('[DRAFT WORDING')
  })
})
