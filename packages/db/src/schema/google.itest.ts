import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'

/**
 * G-CONN-01 — the guarantees that only a real PostgreSQL can be asked about.
 *
 * Three of them are claims about a schema, and the only honest way to check a claim about a schema is
 * to introspect the shipped one and then try the thing it forbids:
 *
 *   - the identity key is `google_sub` and **nothing** is keyed on `google_email`,
 *   - the event log is append-only and mirrors into `audit_event` in the same transaction,
 *   - at most one primary capability row per (connection, capability).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  // Capabilities cascade. Events do not: they are append-only, so every assertion here is a delta.
  await sql`delete from google_connections`
})

/** A sealed token stands in as opaque bytes; this file is about the schema, not the cryptography. */
const CT = Buffer.from('ciphertext-stand-in')

async function insertConnection(args: {
  sub: string
  email: string
  scopes?: string[]
  status?: string
}): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp, status)
    values (${args.sub}, ${args.email},
            ${sql.array(args.scopes ?? ['https://www.googleapis.com/auth/business.manage'])},
            ${CT}, ${CT}, ${CT}, 'v1', 'fp-stand-in', ${args.status ?? 'active'})
    returning id
  `
  return rows[0]?.id ?? ''
}

describe('acceptance — the identity key is google_sub, never the email', () => {
  it('has a unique index on google_sub', async () => {
    const rows = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'google_connections'
    `
    const unique = rows.filter((r) => r.indexdef.includes('UNIQUE'))
    expect(unique.some((r) => /\(google_sub\)/.test(r.indexdef))).toBe(true)
  })

  it('has no index, primary key or check constraint touching google_email', async () => {
    // The whole one-to-many design turns on this. A unique index here would mean a renamed Google
    // account becomes a second connection while the first keeps being refreshed.
    const indexes = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where tablename = 'google_connections'
    `
    expect(indexes.filter((r) => r.indexdef.includes('google_email'))).toEqual([])

    const constraints = await sql<{ conname: string; def: string }[]>`
      select conname, pg_get_constraintdef(oid) as def
      from pg_constraint where conrelid = 'google_connections'::regclass
    `
    expect(constraints.filter((c) => c.def.includes('google_email'))).toEqual([])
  })

  it('stores two active connections with the same email and different subs', async () => {
    // The real case: the GBP listing was claimed on one account and the Search Console property
    // verified on another, and both may carry the same display address after a rename.
    const first = await insertConnection({ sub: 'sub-gbp-owner', email: 'owner@berelax.ae' })
    const second = await insertConnection({ sub: 'sub-gsc-verified', email: 'owner@berelax.ae' })
    expect(first).not.toBe(second)

    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_connections
      where google_email = 'owner@berelax.ae' and status = 'active'
    `
    expect(count?.n).toBe('2')
  })

  it('refuses a second connection with the same sub', async () => {
    // The control on the assertion above: if nothing were unique, the test would prove nothing.
    await insertConnection({ sub: 'sub-duplicate', email: 'a@berelax.ae' })
    await expect(insertConnection({ sub: 'sub-duplicate', email: 'b@berelax.ae' })).rejects.toThrow(
      /google_sub/,
    )
  })
})

describe('acceptance — status and granted_scopes', () => {
  it('constrains status to exactly the four stored states', async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def
      from pg_constraint
      where conrelid = 'google_connections'::regclass and conname = 'google_connections_status_check'
    `
    const def = row?.def ?? ''
    for (const status of ['active', 'needs_reauth', 'revoked', 'disconnected']) {
      expect(def).toContain(status)
    }
    // Exactly four: a fifth value slipping in is how a displayed state gets stored by mistake.
    expect(def.match(/'[a-z_]+'::text/g)).toHaveLength(4)
  })

  it("rejects the plausible-but-wrong status 'expired'", async () => {
    await expect(
      insertConnection({ sub: 'sub-expired', email: 'x@berelax.ae', status: 'expired' }),
    ).rejects.toThrow(/status/)
  })

  it('rejects a null granted_scopes', async () => {
    // Absent scopes are not the same as no scopes, and a nullable column makes "we do not know what
    // this grant can do" indistinguishable from "it can do nothing".
    await expect(sql`
      insert into google_connections
        (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
         refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
      values ('sub-null-scopes', 'x@berelax.ae', null, ${CT}, ${CT}, ${CT}, 'v1', 'fp')
    `).rejects.toThrow(/granted_scopes/)
  })

  it('stores an empty scope array, which is a different fact from null', async () => {
    const id = await insertConnection({ sub: 'sub-no-scopes', email: 'x@berelax.ae', scopes: [] })
    const [row] = await sql<{ granted_scopes: string[] }[]>`
      select granted_scopes from google_connections where id = ${id}
    `
    expect(row?.granted_scopes).toEqual([])
  })

  it('requires refresh_token_kid, so the rotation job can always tell what to re-wrap from', async () => {
    await expect(sql`
      insert into google_connections
        (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
         refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
      values ('sub-no-kid', 'x@berelax.ae', '{}', ${CT}, ${CT}, ${CT}, null, 'fp')
    `).rejects.toThrow(/refresh_token_kid/)
  })
})

describe('acceptance — capabilities', () => {
  it('constrains capability to the four the system knows about', async () => {
    const id = await insertConnection({ sub: 'sub-cap', email: 'x@berelax.ae' })
    await expect(sql`
      insert into google_capabilities (connection_id, capability) values (${id}, 'gmail')
    `).rejects.toThrow(/capability/)
  })

  it('stores resource_ref as jsonb and reads back a placeId', async () => {
    const id = await insertConnection({ sub: 'sub-ref', email: 'x@berelax.ae' })
    await sql`
      insert into google_capabilities (connection_id, capability, resource_ref, is_primary)
      values (${id}, 'gbp_reviews', ${sql.json({ account: 'accounts/1', placeId: 'ChIJ-fixture' })}, true)
    `
    const [row] = await sql<{ place_id: string; type: string }[]>`
      select resource_ref->>'placeId' as place_id, pg_typeof(resource_ref)::text as type
      from google_capabilities where connection_id = ${id}
    `
    expect(row?.place_id).toBe('ChIJ-fixture')
    expect(row?.type).toBe('jsonb')
  })

  it('allows several rows for one capability but only one primary', async () => {
    // Several Search Console properties on one account is ordinary. Two primaries makes "which site do
    // I report on" resolve differently per query plan.
    const id = await insertConnection({ sub: 'sub-multi', email: 'x@berelax.ae' })
    await sql`
      insert into google_capabilities (connection_id, capability, resource_ref, is_primary)
      values (${id}, 'gsc', ${sql.json({ siteUrl: 'https://berelax.ae/' })}, true)
    `
    await sql`
      insert into google_capabilities (connection_id, capability, resource_ref, is_primary)
      values (${id}, 'gsc', ${sql.json({ siteUrl: 'https://old.berelax.ae/' })}, false)
    `
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_capabilities where connection_id = ${id}
    `
    expect(count?.n).toBe('2')

    await expect(sql`
      insert into google_capabilities (connection_id, capability, resource_ref, is_primary)
      values (${id}, 'gsc', ${sql.json({ siteUrl: 'https://new.berelax.ae/' })}, true)
    `).rejects.toThrow(/google_capability_one_primary/)
  })

  it('allows a primary of a different capability on the same connection', async () => {
    // The control: the index is partial on (connection_id, capability), not on the connection.
    const id = await insertConnection({ sub: 'sub-two-caps', email: 'x@berelax.ae' })
    await sql`
      insert into google_capabilities (connection_id, capability, is_primary)
      values (${id}, 'gsc', true)
    `
    await sql`
      insert into google_capabilities (connection_id, capability, is_primary)
      values (${id}, 'gbp_reviews', true)
    `
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_capabilities where connection_id = ${id} and is_primary
    `
    expect(count?.n).toBe('2')
  })
})

describe('acceptance — the event log is append-only and mirrored', () => {
  async function auditCount(): Promise<number> {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where entity_type = 'google_connection'
    `
    return Number(row?.n ?? '0')
  }

  it('mirrors every insert into audit_event in the same transaction', async () => {
    // A delta, never a total: audit_event is append-only and other suites write to it.
    const id = await insertConnection({ sub: 'sub-event', email: 'x@berelax.ae' })
    const before = await auditCount()
    await sql`
      insert into google_connection_events (connection_id, google_sub, event, detail)
      values (${id}, 'sub-event', 'connected', ${sql.json({ scopes: 2 })})
    `
    expect((await auditCount()) - before).toBe(1)

    const [row] = await sql<{ action: string; entity_id: string; operation: string }[]>`
      select action, entity_id, operation from audit_event
      where entity_type = 'google_connection' and entity_id = ${id}
      order by occurred_at desc limit 1
    `
    expect(row?.action).toBe('google_connection.connected')
    expect(row?.operation).toBe('create')
  })

  it('rolls the mirrored audit row back with the event when the transaction aborts', async () => {
    // "In the same transaction" is the claim; this is what makes it one rather than two writes that
    // usually both happen.
    const id = await insertConnection({ sub: 'sub-rollback', email: 'x@berelax.ae' })
    const before = await auditCount()
    await expect(
      sql.begin(async (tx) => {
        await tx`
          insert into google_connection_events (connection_id, google_sub, event)
          values (${id}, 'sub-rollback', 'connected')
        `
        throw new Error('deliberate abort')
      }),
    ).rejects.toThrow(/deliberate abort/)
    expect(await auditCount()).toBe(before)
  })

  it('raises on UPDATE and on DELETE', async () => {
    const id = await insertConnection({ sub: 'sub-append', email: 'x@berelax.ae' })
    await sql`
      insert into google_connection_events (connection_id, google_sub, event)
      values (${id}, 'sub-append', 'connected')
    `
    await expect(
      sql`update google_connection_events set event = 'revoked' where connection_id = ${id}`,
    ).rejects.toThrow(/append-only/)
    await expect(
      sql`delete from google_connection_events where connection_id = ${id}`,
    ).rejects.toThrow(/append-only/)
  })

  it('refuses an event payload carrying a token', async () => {
    // Rows reach query logs, pg_stat_statements, backups and pg-boss job payloads. The tempting
    // debugging line is exactly this one, at 2am.
    const id = await insertConnection({ sub: 'sub-leak', email: 'x@berelax.ae' })
    await expect(sql`
      insert into google_connection_events (connection_id, google_sub, event, detail)
      values (${id}, 'sub-leak', 'refreshed', ${sql.json({ refresh_token: '1//09-secret' })})
    `).rejects.toThrow(/no_token/)
  })

  it('accepts an event before any connection row exists', async () => {
    // A Workspace admin marking the service Restricted surfaces at authorisation, before a token
    // exists — and that is precisely the event somebody will go looking for.
    const before = await auditCount()
    await sql`
      insert into google_connection_events (google_sub, event, detail)
      values ('sub-refused', 'health_check_failed', ${sql.json({ failure: 'admin_policy_enforced' })})
    `
    expect((await auditCount()) - before).toBe(1)
    const [row] = await sql<{ entity_id: string }[]>`
      select entity_id from audit_event
      where entity_type = 'google_connection' and entity_id = 'sub-refused'
    `
    expect(row?.entity_id).toBe('sub-refused')
  })
})
