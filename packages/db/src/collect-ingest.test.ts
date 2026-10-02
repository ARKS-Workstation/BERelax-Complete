import { readFileSync } from 'node:fs'
import { TRADING_DATE_BASES } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { ANALYTICS_SQLSTATE } from './repositories/analytics.ts'

/**
 * Migration 0116's two structural claims, read off the SQL (A-FIRST-05, ADR 0066).
 *
 * ## Why a static test beside the integration one
 *
 * `apps/web/app/api/collect/collect.itest.ts` proves both refusals FIRE, against a real PostgreSQL, which
 * is the claim that matters. It cannot prove they are still DECLARED: a trigger deleted from the migration
 * is invisible to a database that already has it, so the suite would stay green on a tree that no longer
 * creates it and the next person to build a database from `packages/db/migrations` would get a schema with
 * neither refusal in it. That is the shape gate case 123e exists for one migration over, and this is its
 * counterpart — `pnpm db:conventions` cannot cover it, because its append-only rule keys on the phrase
 * "UPDATE and DELETE raise" and `pre_consent_landing` is deliberately NOT append-only: the increment is the
 * write that has to keep working.
 *
 * It also holds the one vocabulary that is unavoidably written three times. `trading_date_basis`'s four
 * words are in the migration's two CHECKs, in the Drizzle mirror (because `pnpm db:drift` compares the two)
 * and in `TRADING_DATE_BASES` in `@berelax/shared` (because `packages/db` writes the column and may never
 * import `packages/core`, where the resolver's own union lives). `packages/core/src/analytics/ingest.ts`
 * holds the tuple equal to that union by a compile-time assertion; this holds the SQL equal to the tuple.
 */

const MIGRATION = 'packages/db/migrations/0116_collect_ingest.sql'
const MIRROR = 'packages/db/src/schema/analytics.ts'

const sql = readFileSync(MIGRATION, 'utf8')
const mirror = readFileSync(MIRROR, 'utf8')

/** The words inside a named CHECK's `in (...)` list. */
const checkVocabulary = (text: string, constraint: string): readonly string[] => {
  const match = new RegExp(`${constraint}[\\s\\S]{0,300}?in \\(([^)]*)\\)`).exec(text)
  if (match?.[1] === undefined) return []
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map((word) => word[1] as string).sort()
}

describe('migration 0116 declares both refusals', () => {
  it('reads the migration at all', () => {
    // The control. Every assertion below is satisfied by an empty string, which is ADR 0002's subject.
    expect(sql.length).toBeGreaterThan(5_000)
    expect(sql).toContain('create table analytics.pre_consent_landing')
  })

  it('guards the pre-consent counter against a DELETE and against a lowered count, with a trigger each', () => {
    /*
     * Two triggers and not one `before update or delete`, which is 0096's reasoning at
     * `event_refuse_update`: a combined trigger reads as covering both and is one edit away from covering
     * neither, and nothing else in the tree would notice. The count is the only surviving record that a
     * pre-consent visit happened — the event itself was never stored (ADR 0066) — so a revision downwards
     * moves every conversion rate that divides by it.
     */
    expect(sql).toMatch(
      /create trigger pre_consent_landing_refuse_update\s+before update on analytics\.pre_consent_landing/,
    )
    expect(sql).toMatch(
      /create trigger pre_consent_landing_refuse_delete\s+before delete on analytics\.pre_consent_landing/,
    )
    expect(sql).toContain('analytics.refuse_pre_consent_landing_loss()')
    // And the function raises the registered code, in all three of its branches: a removal, a lowered
    // count, and a count moved onto another day or route.
    expect([
      ...sql.matchAll(new RegExp(`errcode = '${ANALYTICS_SQLSTATE.preConsentLandingLoss}'`, 'g')),
    ]).toHaveLength(3)
  })

  it('holds a session’s trading-date basis against the calendar, with a trigger that fires on UPDATE too', () => {
    // On UPDATE as well as INSERT, and that half is load-bearing: ingest advances `last_event_at` on a
    // stitched session, so a later UPDATE moving `started_at` or `trading_date` without the basis would slip
    // past a check made only at insert.
    expect(sql).toMatch(
      /create trigger session_assert_trading_basis\s+after insert or update on analytics\.session/,
    )
    expect(sql).toContain('analytics.assert_session_trading_basis()')
    expect(sql).toContain(`errcode = '${ANALYTICS_SQLSTATE.sessionTradingBasis}'`)
    // It compares against `business_day`'s OWN instants rather than re-deriving 11:00-02:00, which would
    // disagree with the calendar on exactly the dates somebody overrode the hours for.
    expect(sql).toContain('from public.business_day')
    expect(sql).toContain('new.started_at >= v_opens_at and new.started_at < v_closes_at')
    // Both directions, as one comparison. A one-sided check is satisfied by a writer that stamps every row
    // with a gap reason, which loses exactly as much as stamping every row `trading`.
    expect(sql).toContain("v_inside <> (new.trading_date_basis = 'trading')")
  })

  it('gives the counter no default on the session basis, because `trading` is what a careless caller gets', () => {
    const addColumn = /alter table analytics\.session add column trading_date_basis[^;]*/.exec(
      sql,
    )?.[0]
    expect(addColumn, 'the column is no longer added in the shape this case reads').toBeDefined()
    expect(addColumn).not.toMatch(/default/i)
  })

  it('classifies the new table for retention, which the pass refuses to run without', () => {
    // `analytics.run_retention` raises ZY062 for a base table in this schema with no policy row, so the
    // whole pass stops rather than retaining a new table for ever by omission. `keep_indefinitely` because
    // the row holds no identifier for retention to protect anybody from, and because it is the only
    // surviving record of a pre-consent visit.
    expect(sql).toMatch(/'pre_consent_landing',\s*'keep_indefinitely'/)
  })

  it('puts no instant of any kind on the counter, which is what identifier-free means here', () => {
    const table = /create table analytics\.pre_consent_landing[\s\S]*?\n\);/.exec(sql)?.[0]
    expect(table, 'the table is no longer declared in the shape this case reads').toBeDefined()
    // A timestamp on a row whose count is 1 is a timestamp of one person's visit. Every sibling table in
    // this schema has a `created_at`; this one must not, and the absence is the claim rather than an
    // oversight.
    expect(table).not.toMatch(/timestamptz/)
    expect(table).not.toMatch(/_at\b/)
    // And no foreign key, so C-CRM-10's fourth erasure probe has nothing to follow. A key to
    // `business_day` would also have refused the one cohort this table exists to keep: an instant in the
    // 02:00-11:00 gap belongs to no trading date at all.
    expect(table).not.toMatch(/references/i)
  })
})

describe('the trading-date basis vocabulary, in all three places it is written', () => {
  const expected = [...TRADING_DATE_BASES].sort()

  it('is the same four words in the migration, the mirror and the shared tuple', () => {
    for (const constraint of [
      'session_trading_date_basis_known',
      'pre_consent_landing_basis_known',
    ]) {
      expect(
        checkVocabulary(sql, constraint),
        `${constraint} in the migration must hold exactly TRADING_DATE_BASES`,
      ).toEqual(expected)
      expect(
        checkVocabulary(mirror, constraint),
        `${constraint} in the Drizzle mirror must hold exactly TRADING_DATE_BASES — pnpm db:drift ` +
          'compares the mirror to the database and has nothing to say about a CHECK list',
      ).toEqual(expected)
    }
  })

  it('found something to compare, in both files', () => {
    // The control: an `in (...)` pattern that stopped matching returns [] from both sides and would make
    // the case above compare two empty lists if the tuple were ever empty too.
    expect(checkVocabulary(sql, 'session_trading_date_basis_known').length).toBe(4)
    expect(checkVocabulary(mirror, 'pre_consent_landing_basis_known').length).toBe(4)
    expect(expected.length).toBe(4)
  })
})
