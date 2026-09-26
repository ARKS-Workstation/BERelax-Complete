import { instantFromIso, REAUTH_SKIP_REASONS, reauthIncidentKey } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { MAX_GOOGLE_REAUTH_LADDER_STEPS } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresReauthNoticeStore } from './notify/postgres-notice-store.ts'

/**
 * G-CONN-08 — the guarantees only a real PostgreSQL can be asked about (migration 0075).
 *
 * The ladder's two most important claims are enforced by the DATABASE and not by the pass, which is what
 * makes them true under a second worker:
 *
 *  1. **One notice per rung, per role, per channel, per incident.** A unique index. The pass's own dedupe
 *     is a read-then-write and two workers can interleave it; an index cannot be interleaved.
 *  2. **The escalation cannot run for ever.** `rung_index between 1 and 8`, which is
 *     `MAX_GOOGLE_REAUTH_LADDER_STEPS` restated in SQL — because a cap that lives only in TypeScript is a
 *     cap one bad settings row removes.
 *
 * Plus three refusals that are the same idea from other directions: a step label that is not a rung this
 * ladder can name, an incident key with no cause prefix, and an UPDATE of a decision that was already made.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave Google connections
 * behind (brief rule 12) — `google-oauth.itest.ts` and the health suites both create some. So this file
 * creates its OWN connection under a fixed sub and deletes only that one, which also tidies its
 * predecessor's row on the next run. It never issues `delete from google_connections`: `google_reviews`
 * references it `ON DELETE RESTRICT`, and a blanket delete here would fail on somebody else's rows.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
let connectionId = ''

const SUB = 'sub-gconn08-reauth-notice'
const ACCOUNT = 'google-admin@example.invalid'
const NOW = instantFromIso('2026-09-25T10:00:00.000Z')
/** A sealed token stands in as opaque bytes. Nothing here opens one; this file is about the schema. */
const CT = Buffer.from('ciphertext-stand-in')

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  // A fixed sub rather than a per-run one, so each run tidies up its predecessor's rows (the arrangement
  // B-MSG-04 recorded for the template prefix).
  await sql`delete from google_connections where google_sub = ${SUB}`
  const rows = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp, status, status_reason)
    values (${SUB}, ${ACCOUNT},
            ${sql.array(['https://www.googleapis.com/auth/business.manage'])},
            ${CT}, ${CT}, ${CT}, 'v1', 'fp-stand-in', 'needs_reauth', 'invalid_grant')
    returning id
  `
  connectionId = rows[0]?.id ?? ''
  expect(connectionId).not.toBe('')
})

afterAll(async () => {
  // Only this file's connection. The notices cascade with it, which is 0075's declared behaviour.
  if (sql !== undefined) {
    await sql`delete from google_connections where google_sub = ${SUB}`
    await sql.end({ timeout: 5 })
  }
})

/** One row, with every column the pass would write. Overridable so a case can break exactly one thing. */
const insert = async (over: Record<string, unknown> = {}): Promise<void> => {
  const row = {
    incident_key: reauthIncidentKey(1),
    kind: 'reactive',
    step: 'reactive_0h',
    rung_index: 1,
    to_role: 'owner',
    channel: 'email',
    outcome: 'sent',
    skipped_reason: null,
    ...over,
  }
  await sql`
    insert into google_reauth_notice
      (connection_id, incident_key, kind, step, rung_index, to_role, channel, outcome,
       skipped_reason, due_at, decided_at)
    values (${connectionId}::uuid, ${row.incident_key as string}, ${row.kind as string},
            ${row.step as string}, ${row.rung_index as number}, ${row.to_role as string},
            ${row.channel as string}, ${row.outcome as string},
            ${row.skipped_reason as string | null},
            '2026-09-25T10:00:00.000Z'::timestamptz, now())
  `
}

/** Every row this file wrote, cleared between cases. Scoped to this connection, never to the table. */
const clear = async (): Promise<void> => {
  await sql`delete from google_reauth_notice where connection_id = ${connectionId}::uuid`
}

describe('acceptance — one notice per rung, per role, per channel, per incident', () => {
  it('refuses the second row for the same five values, and accepts every variation of them', async () => {
    await clear()
    await insert()
    // THE dedupe. Two workers reading "nothing sent yet" at the same moment is the case the pass's own
    // read cannot close, and this is what closes it.
    await expect(insert()).rejects.toThrow(/google_reauth_notice_one_per_rung_role_channel/)
    // Four controls, so the index is shown to be about the five columns rather than about the connection:
    // the same rung to the other role, on the other channel, on the next rung, and in a new incident.
    await insert({ to_role: 'manager' })
    await insert({ channel: 'sms', outcome: 'skipped', skipped_reason: 'channel_disabled' })
    await insert({ step: 'reactive_24h', rung_index: 2 })
    await insert({ incident_key: reauthIncidentKey(2) })
    const [count] = await sql<{ n: number }[]>`
      select count(*)::int as n from google_reauth_notice where connection_id = ${connectionId}::uuid
    `
    expect(count?.n).toBe(5)
  })

  it('counts a SKIP as a decision too, so a skipped rung is not retried for ever', async () => {
    await clear()
    await insert({ outcome: 'skipped', skipped_reason: 'no_recipient_on_file' })
    // The reason the index is total rather than partial on `sent` (0060 makes the other choice): a skipped
    // rung that retried on the next pass would be an insert this index refuses and a pass that throws.
    await expect(insert()).rejects.toThrow(/google_reauth_notice_one_per_rung_role_channel/)
    const store = createPostgresReauthNoticeStore(sql)
    expect(await store.decidedSteps({ connectionId, incidentKey: reauthIncidentKey(1) })).toEqual([
      'reactive_0h',
    ])
  })
})

describe('acceptance — the escalation cannot run for ever', () => {
  it('refuses a rung above the declared ceiling', async () => {
    await clear()
    // 8 is `MAX_GOOGLE_REAUTH_LADDER_STEPS`. The eighth rung is the last one any declared ladder reaches.
    expect(MAX_GOOGLE_REAUTH_LADDER_STEPS).toBe(8)
    await insert({ step: 'reactive_168h', rung_index: MAX_GOOGLE_REAUTH_LADDER_STEPS })
    await expect(
      insert({ step: 'reactive_192h', rung_index: MAX_GOOGLE_REAUTH_LADDER_STEPS + 1 }),
    ).rejects.toThrow(/google_reauth_notice_rung_is_within_the_ladder/)
    await expect(insert({ step: 'reactive_0h', rung_index: 0 })).rejects.toThrow(
      /google_reauth_notice_rung_is_within_the_ladder/,
    )
  })

  it('refuses an hour offset past the furthest rung, which is the same bound read the other way', async () => {
    await clear()
    // 168 hours is rung eight. A label beyond it is a ladder nobody declared, whatever `rung_index` says.
    await expect(insert({ step: 'reactive_9999h', rung_index: 2 })).rejects.toThrow(
      /google_reauth_notice_step_is_a_declared_rung/,
    )
    await expect(insert({ step: 'reactive_0009h', rung_index: 2 })).rejects.toThrow(
      /google_reauth_notice_step_is_a_declared_rung/,
    )
    await expect(insert({ step: 'urgent_0h', rung_index: 1 })).rejects.toThrow(
      /google_reauth_notice_step_is_a_declared_rung/,
    )
  })

  it('refuses a predictive notice on a second rung, because that ladder has one', async () => {
    await clear()
    await insert({ kind: 'predictive', step: 'predictive_0h', rung_index: 1 })
    await expect(
      insert({ kind: 'predictive', step: 'predictive_24h', rung_index: 2 }),
    ).rejects.toThrow(/google_reauth_notice_predictive_has_one_rung/)
  })

  it('refuses a step whose kind and label disagree', async () => {
    await clear()
    // One fact written twice. A row counted one way by a report and worded the other way by the sender.
    await expect(insert({ kind: 'predictive', step: 'reactive_0h' })).rejects.toThrow(
      /google_reauth_notice_step_matches_its_kind/,
    )
  })
})

describe('acceptance — an incident key names a cause', () => {
  it('refuses a key with no prefix, and accepts all three that have one', async () => {
    await clear()
    await expect(insert({ incident_key: '4231' })).rejects.toThrow(
      /google_reauth_notice_incident_key_shaped/,
    )
    await expect(insert({ incident_key: 'reauth:' })).rejects.toThrow(
      /google_reauth_notice_incident_key_shaped/,
    )
    for (const key of [
      'reauth:4231',
      'expiry:2026-09-27T10:00:00.000Z',
      'stale:2026-09-24T10:00:00.000Z',
    ]) {
      await insert({ incident_key: key })
    }
    const [count] = await sql<{ n: number }[]>`
      select count(*)::int as n from google_reauth_notice where connection_id = ${connectionId}::uuid
    `
    expect(count?.n).toBe(3)
  })
})

describe('acceptance — a decision that was made cannot be edited', () => {
  it('raises on any UPDATE, naming the row', async () => {
    await clear()
    await insert()
    await expect(
      sql`
        update google_reauth_notice set outcome = 'skipped', skipped_reason = 'send_refused'
        where connection_id = ${connectionId}::uuid
      `,
    ).rejects.toThrow(/records a notice decision that was already made/)
  })

  it('still cascades from the connection, which is why it does not claim to be append-only', async () => {
    // A notice history is about a GRANT. When the grant's row goes so does the record of what was said
    // about it — and `google_connection_events` is the connection's own audit trail, append-only there.
    await clear()
    await insert()
    const rows = await sql<{ id: string }[]>`
      insert into google_connections
        (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
         refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp, status)
      values (${`${SUB}-cascade`}, ${ACCOUNT},
              ${sql.array(['https://www.googleapis.com/auth/business.manage'])},
              ${CT}, ${CT}, ${CT}, 'v1', 'fp-stand-in', 'needs_reauth')
      returning id
    `
    const doomed = rows[0]?.id ?? ''
    await sql`
      insert into google_reauth_notice
        (connection_id, incident_key, kind, step, rung_index, to_role, channel, outcome, due_at, decided_at)
      values (${doomed}::uuid, ${reauthIncidentKey(9)}, 'reactive', 'reactive_0h', 1, 'owner', 'email',
              'sent', now(), now())
    `
    await sql`delete from google_connections where id = ${doomed}::uuid`
    const [left] = await sql<{ n: number }[]>`
      select count(*)::int as n from google_reauth_notice where connection_id = ${doomed}::uuid
    `
    expect(left?.n).toBe(0)
    // The control: this file's own row is untouched by that delete.
    const [mine] = await sql<{ n: number }[]>`
      select count(*)::int as n from google_reauth_notice where connection_id = ${connectionId}::uuid
    `
    expect(mine?.n).toBe(1)
  })
})

describe('acceptance — the skip vocabulary in SQL is the one in packages/core', () => {
  it('accepts every reason a row can carry and refuses one it cannot', async () => {
    await clear()
    // The three reasons the pass decides BEFORE a row exists are deliberately absent from the CHECK: a row
    // for `connection_is_healthy` would be a row per connection per pass, for ever.
    const recordable = REAUTH_SKIP_REASONS.filter(
      (reason) =>
        reason !== 'connection_is_healthy' &&
        reason !== 'no_rung_is_due_yet' &&
        reason !== 'ladder_cap_reached',
    )
    expect(recordable.length).toBeGreaterThan(3)
    let rung = 0
    for (const reason of recordable) {
      rung += 1
      await insert({
        step: `reactive_${rung === 1 ? 0 : (rung - 1) * 24}h`,
        rung_index: rung,
        outcome: 'skipped',
        skipped_reason: reason,
      })
    }
    await expect(
      insert({ step: 'reactive_0h', outcome: 'skipped', skipped_reason: 'connection_is_healthy' }),
    ).rejects.toThrow(/google_reauth_notice_skipped_reason_known/)
    // And the other half of the pairing: a SENT row may not carry a reason, and a skipped one must.
    await clear()
    await expect(insert({ outcome: 'skipped', skipped_reason: null })).rejects.toThrow(
      /google_reauth_notice_skip_carries_a_reason/,
    )
    await expect(insert({ outcome: 'sent', skipped_reason: 'send_refused' })).rejects.toThrow(
      /google_reauth_notice_skip_carries_a_reason/,
    )
  })
})

describe('acceptance — the application role cannot forget what an owner was told', () => {
  it('holds select and insert and nothing else, so the door is the grant as well as the trigger', async () => {
    // The precedent M-VAT-06 set for `period_lock` and 0072 for `credit_note`: a rule held by the GRANT is
    // one a later migration cannot drop by rewriting a trigger. 0009 granted the application role update
    // and delete on every table in public and set default privileges extending that to tables created
    // later, so this table ARRIVED with both — an append-only table that forgets to revoke them is
    // append-only only for as long as nobody writes the statement.
    const rows = await sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where table_name = 'google_reauth_notice' and grantee = 'berelax_app'
    `
    const held = rows.map((row) => row.privilege_type).sort()
    expect(held).toEqual(['INSERT', 'SELECT'])
    // Named individually as well as by the set, so a reader looking for one of them finds it. TRUNCATE is
    // the statement that fires no row-level trigger, so the refusal above would not see it — and a
    // truncated notice table is a ladder that sends every rung of every live incident again.
    for (const forbidden of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(held, `berelax_app holds ${forbidden}`).not.toContain(forbidden)
    }
    // The control: the read discriminates. The owner holds all seven, so an empty result or a query
    // matching nothing would not have produced the assertion above.
    const owner = await sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where table_name = 'google_reauth_notice' and grantee = 'berelax'
    `
    expect(owner.map((row) => row.privilege_type)).toContain('UPDATE')
  })
})

describe('the store reads what the pass needs', () => {
  it('finds the incident from the newest reauth_required event, and nothing when there is none', async () => {
    await clear()
    const store = createPostgresReauthNoticeStore(sql)
    // No event yet: null, which is what makes the pass send nothing rather than send on every pass.
    await sql`delete from google_connection_events where connection_id = ${connectionId}::uuid`
    expect(await store.latestReauthIncident(connectionId)).toBeNull()
    const inserted = await sql<{ id: string }[]>`
      insert into google_connection_events (connection_id, google_sub, event, detail, occurred_at)
      values (${connectionId}::uuid, ${SUB}, 'reauth_required', '{}'::jsonb,
              '2026-09-25T09:00:00.000Z'::timestamptz)
      returning id::text as id
    `
    const first = await store.latestReauthIncident(connectionId)
    expect(first?.key).toBe(reauthIncidentKey(inserted[0]?.id ?? ''))
    expect(first?.openedAt).toBe(instantFromIso('2026-09-25T09:00:00.000Z'))
    // A second incident later: the NEWEST event is the incident, which is what makes a re-broken connection
    // a new ladder rather than a spent one.
    const second = await sql<{ id: string }[]>`
      insert into google_connection_events (connection_id, google_sub, event, detail, occurred_at)
      values (${connectionId}::uuid, ${SUB}, 'reauth_required', '{}'::jsonb,
              '2026-09-26T09:00:00.000Z'::timestamptz)
      returning id::text as id
    `
    const after = await store.latestReauthIncident(connectionId)
    expect(after?.key).toBe(reauthIncidentKey(second[0]?.id ?? ''))
    expect(after?.key).not.toBe(first?.key)
  })

  it('records and reads back a decision through the store, not only through raw SQL', async () => {
    await clear()
    const store = createPostgresReauthNoticeStore(sql)
    const decision = {
      connectionId,
      incidentKey: reauthIncidentKey(42),
      kind: 'reactive' as const,
      step: 'reactive_0h',
      rungIndex: 1,
      toRole: 'owner' as const,
      channel: 'email' as const,
      dueAt: NOW,
      decidedAt: NOW,
      messageId: null,
      skippedReason: null,
    }
    await store.record(decision)
    const back = await store.decisionsFor({ connectionId, incidentKey: decision.incidentKey })
    expect(back).toHaveLength(1)
    expect(back[0]).toEqual(decision)
    // The store does NOT swallow the conflict: `on conflict do nothing` would turn "this rung was already
    // decided" into a silent success, which is the one thing that would let a second worker send twice.
    await expect(store.record(decision)).rejects.toThrow(
      /google_reauth_notice_one_per_rung_role_channel/,
    )
  })
})
