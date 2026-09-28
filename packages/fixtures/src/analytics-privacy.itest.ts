import { classifyErasureCoverage, ERASURE_RULES } from '@berelax/core'
import { createConnection, erasureCoverage, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The `analytics` schema and C-CRM-10's erasure catalogue, held against each other (A-FIRST-01).
 *
 * ## Why this file exists, and why it is here rather than in `packages/db`
 *
 * C-CRM-10's erasure engine enumerates every schema present in the database over five catalogue probes and
 * REFUSES an erasure when a column it finds has no classification rule. Two units have broken every customer
 * erasure by adding unclassified columns, so a unit that creates a whole new SCHEMA has to answer the
 * question out loud rather than hope. `packages/db` must never import `packages/core`, and this needs both —
 * `erasureCoverage` is the probe and `classifyErasureCoverage` is the registry — which makes
 * `packages/fixtures` its only legal home (brief rule 4).
 *
 * ## The answer, and why it is not "we avoided the probes"
 *
 * No column in `analytics` is probed, because there is nothing in it for the probes to find: no customer or
 * contact reference, no contact detail, no credential, no foreign key to a subject-scoped table, and no free
 * text on one. Every one of those absences is a decision recorded in 0096's header — the strongest being
 * that A-FIRST-08 owns attribution onto `customer` and `booking`, so the `customer_id` arrives with the unit
 * whose acceptance line names it and its merge and erasure classification arrive on the same commit.
 *
 * That answer is only worth anything if the probe can SEE this schema, so the third case here creates a
 * table in `analytics` that any of the probes would catch, inside a transaction that is rolled back, and
 * requires the catalogue to report it as unclassified. Without that, "nothing to classify" and "the probe
 * does not look here" are the same passing test — and `analytics` being absent from
 * `MERGE_CATALOGUE_EXCLUDED_SCHEMAS` is the mechanism, so a future unit that excluded it would turn this
 * file red rather than quietly widening the gap.
 *
 * ## What no row-level erasure can find, stated rather than implied
 *
 * A visitor cookie id is pseudonymous data about a person, and after this unit nothing in the database links
 * one to a customer. So a customer's erasure genuinely cannot reach it, and it is not honest to imply
 * otherwise: what removes it is TIME. `analytics.run_retention` purges every visitor, session and
 * attribution row past the 90-day window, which is the mechanism, and the retention policy rows are where
 * it is declared. The same limitation for free text on a non-subject-scoped table is recorded in
 * `privacy-coverage.ts` and ADR 0034; this is its analytics counterpart, and the day A-FIRST-08 adds a
 * customer reference the schema becomes reachable by erasure and this file's first case goes red until it
 * is classified.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

const ROLLBACK = 'A-FIRST-01 rolled this fixture back'

/**
 * Runs `body` inside a transaction and rolls it back. `analytics.itest.ts`'s helper, with its reasoning:
 * the marker is compared exactly so a genuine failure propagates, and the result is collected in an array
 * whose length is CHECKED so a body that never ran cannot be read as a passing case.
 */
async function rolledBack<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  const captured: T[] = []
  try {
    await sql.begin(async (tx) => {
      captured.push(await body(tx as unknown as Sql))
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error
  }
  if (captured.length !== 1) {
    throw new Error(
      `rolledBack captured ${captured.length} results and expected exactly 1, so the fixture body did ` +
        'not run to completion and whatever asserts next would be asserting on nothing.',
    )
  }
  return captured[0] as T
}

describe('the analytics schema and the erasure catalogue', () => {
  it('leaves the catalogue completely classified, which is the state an erasure needs', async () => {
    const probed = await erasureCoverage(sql)
    const coverage = classifyErasureCoverage(probed)
    // The same assertion `rights.itest.ts` makes, repeated here deliberately and not as duplication: that
    // file fails for whoever broke it, and this one says which unit's schema was present when it did.
    expect(
      coverage.unclassified.map((c) => `${c.schema}.${c.table}.${c.column} [${c.axes.join(',')}]`),
      'an unclassified column refuses EVERY customer erasure until somebody classifies it. If one of ' +
        'these is in the analytics schema, add its rule to ERASURE_RULES in ' +
        'packages/core/src/privacy/rights-policy.ts with an action and, where retained, a subject-facing ' +
        'reason',
    ).toEqual([])
    expect(coverage.staleRuleKeys).toEqual([])
    // The control: the probe returned a substantial catalogue. Both assertions above are satisfied by a
    // probe that returned nothing, which is ADR 0002's subject and how `pnpm boundaries` once reported
    // success over zero modules.
    expect(probed.length).toBeGreaterThan(80)
  })

  it('adds no probed column of its own, so it needs no erasure rule and has none', async () => {
    const probed = await erasureCoverage(sql)
    const inAnalytics = probed.filter((c) => c.schema === 'analytics')
    expect(
      inAnalytics.map((c) => `${c.table}.${c.column} [${c.axes.join(',')}]`),
      'a probed column in the analytics schema needs a rule in ERASURE_RULES. It is not there because ' +
        '0096 adds no customer or contact reference, no contact detail, no credential, no foreign key to ' +
        'a subject table and no free text on one — so a column here means one of those arrived',
    ).toEqual([])
    // And nothing claims otherwise from the registry side: a rule for an analytics column would match no
    // probed column and would be reported as stale by the case above, so this is the same fact read from
    // the other end and it is the one a reader of the registry checks.
    expect([...ERASURE_RULES.keys()].filter((key) => key.startsWith('analytics.'))).toEqual([])
  })

  it('IS enumerated by the probes — the known-bad case, without which the case above proves nothing', async () => {
    /*
     * A table in `analytics` that four of the five probes would each catch on their own, created inside a
     * transaction that is rolled back so the catalogue is unchanged afterwards. It is a real table while the
     * transaction is open, which is what makes the probe see it: a fixture the probe could not see would
     * prove nothing, which is `rights.itest.ts`'s own wording for the same shape.
     */
    const found = await rolledBack(async (tx) => {
      await tx`
        create table analytics.__gate_fixture_probed (
          id uuid primary key default public.uuid_generate_v7(),
          customer_id uuid not null,
          phone_e164 text not null,
          session_token text not null,
          notes text
        )
      `
      const probed = await erasureCoverage(tx)
      const coverage = classifyErasureCoverage(probed)
      return {
        columns: probed
          .filter((c) => c.table === '__gate_fixture_probed')
          .map((c) => `${c.column} [${c.axes.join(',')}]`)
          .sort(),
        unclassified: coverage.unclassified
          .filter((c) => c.table === '__gate_fixture_probed')
          .map((c) => c.column)
          .sort(),
        schema: probed.find((c) => c.table === '__gate_fixture_probed')?.schema,
      }
    })

    // The probe reaches the analytics schema, by name, and names the schema it found it in.
    expect(found.schema).toBe('analytics')
    // Four axes, each on the column it exists for: the merge registry's reference pattern, the contact
    // detail, the credential and the free-text note. `notes` is reached because the reference column makes
    // this a subject-scoped table, which is the fifth probe's own condition.
    expect(found.columns).toEqual([
      'customer_id [customer_reference]',
      'notes [free_text_note]',
      'phone_e164 [contact_detail]',
      'session_token [credential]',
    ])
    // And every one of them is UNCLASSIFIED, which is what would refuse an erasure — the failure this
    // whole file exists to prove cannot happen silently for a new schema.
    expect(found.unclassified).toEqual(['customer_id', 'notes', 'phone_e164', 'session_token'])

    // The fixture is gone and the catalogue is complete again, so the case left nothing behind.
    const after = classifyErasureCoverage(await erasureCoverage(sql))
    expect(after.unclassified).toEqual([])
  })

  it('removes its raw rows by TIME instead, which is the only mechanism that can reach them', async () => {
    // The honest half. A visitor cookie id is pseudonymous data about a person that no customer erasure can
    // reach, because after this unit nothing links one to a customer. What removes it is the retention pass,
    // and the policy rows are where that is declared rather than assumed.
    const rows = await sql<{ relation_name: string; policy: string; age_column: string | null }[]>`
      select relation_name, policy, age_column from analytics.retention_policy
       where policy = 'raw_row_purge' order by purge_order
    `
    expect(rows).toEqual([
      { relation_name: 'attribution', policy: 'raw_row_purge', age_column: 'resolved_at' },
      { relation_name: 'session', policy: 'raw_row_purge', age_column: 'last_event_at' },
      { relation_name: 'visitor', policy: 'raw_row_purge', age_column: 'last_seen_at' },
    ])
    // And the window is the one docs/03 states, read from the database rather than from a literal here.
    const [window] = await sql<{ days: number }[]>`select analytics.raw_retention_days() as days`
    expect(window?.days).toBe(90)
  })
})
