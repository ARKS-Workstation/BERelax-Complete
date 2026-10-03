import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The suite the restore drill runs AGAINST THE RESTORED DATABASE (H-HARD-04).
 *
 * `scripts/restore-drill.mjs` points `TEST_DATABASE_URL` at the database it has just restored and runs
 * this file. It is also an ordinary member of `pnpm test:integration`, so it runs against the shared
 * integration database on every verify — which is what keeps it honest: a suite that only ever ran
 * inside the drill would be a suite nobody else's work could break.
 *
 * ## What it asserts, and why these claims rather than "some rows are there"
 *
 * The drill script already reconciles every table's row count in both directions and reads four rows
 * back. What a row count cannot see is the part of a restore that is not data, and each of these leaves
 * a database that looks right and is not:
 *
 *   1. **The protections did not come back.** `invoice` is append-only by a trigger raising `ZI003`
 *      (migration 0026) and `audit_event` by RULES (0005). `pg_restore --data-only`, or a restore with
 *      `--disable-triggers`, gives you every row and none of the enforcement — and nothing about the
 *      data would say so. This is the claim the drill most needs, because the restored copy is the one
 *      somebody will be writing into during an incident.
 *   2. **The extensions are absent.** `btree_gist` is what the no-double-booking exclusion constraint
 *      is built on, so a restore without it is a database that accepts a double booking.
 *   3. **The constraints are gone.** A restore that dropped the CHECKs and the foreign keys accepts
 *      every row the schema is supposed to refuse, starting with the next one somebody types.
 *   4. **A function the schema depends on is missing.** `is_placeholder_text` (0026) is what makes a
 *      provisional value refusable; without it the CHECKs that call it cannot have been restored either.
 *
 * Every assertion is a floor or an invariant over whatever the database holds, never a total: this file
 * runs against the shared integration database with other suites' rows in it (brief rule 12), and
 * against a restored copy whose contents are whatever was dumped.
 *
 * ## It deletes nothing and inserts nothing that survives
 *
 * The append-only probes run inside a transaction that is rolled back by throwing, so this suite writes
 * nothing at all — which is what lets it run twice in a row against one database with the same result.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error(
    'TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip (ADR 0002).',
  )
}

/**
 * Floors, not totals.
 *
 * Measured on a current schema: 132 tables, 519 triggers, 1,237 CHECK constraints, 1,214 indexes. Each
 * floor is roughly half of that — an order of magnitude above what a partial restore leaves and far
 * enough below the real figure that no migration trips it. A floor at the measured number would fail on
 * the next one, which is the gate-that-fails-on-correct-work shape.
 */
const FLOORS = {
  tables: 60,
  foreignKeys: 100,
  triggers: 200,
  checkConstraints: 400,
  indexes: 400,
} as const

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  await sql`select 1`
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('a restored database is usable', () => {
  it('holds the schema and its enforcement, not just the rows', async () => {
    const [row] = await sql<
      {
        tables: string
        fks: string
        triggers: string
        checks: string
        indexes: string
      }[]
    >`
      select
        (select count(*)::text from information_schema.tables
          where table_schema = 'public' and table_type = 'BASE TABLE') as tables,
        (select count(*)::text from pg_constraint where contype = 'f') as fks,
        (select count(*)::text from pg_trigger where not tgisinternal) as triggers,
        (select count(*)::text from pg_constraint where contype = 'c') as checks,
        (select count(*)::text from pg_class where relkind = 'i') as indexes
    `
    expect(Number(row?.tables)).toBeGreaterThanOrEqual(FLOORS.tables)
    expect(Number(row?.fks)).toBeGreaterThanOrEqual(FLOORS.foreignKeys)
    expect(Number(row?.triggers)).toBeGreaterThanOrEqual(FLOORS.triggers)
    expect(Number(row?.checks)).toBeGreaterThanOrEqual(FLOORS.checkConstraints)
    expect(Number(row?.indexes)).toBeGreaterThanOrEqual(FLOORS.indexes)
  })

  it('has btree_gist installed, which the no-double-booking constraint is built on', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from pg_extension where extname = 'btree_gist'
    `
    expect(Number(row?.n)).toBe(1)
  })

  it('has the functions the schema’s own CHECKs call', async () => {
    const rows = await sql<{ name: string }[]>`
      select p.proname as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = any(array['is_placeholder_text', 'refuse_invoice_change'])
    `
    expect(rows.map((entry) => entry.name).sort()).toEqual([
      'is_placeholder_text',
      'refuse_invoice_change',
    ])
  })

  it('still refuses to UPDATE an issued invoice, by the SQLSTATE the registry records', async () => {
    const [invoice] = await sql<{ id: string }[]>`select id::text as id from invoice limit 1`
    if (invoice === undefined) {
      // No invoice means nothing to probe, and a silent pass would be the vacuous case this file
      // exists to avoid — so the trigger's PRESENCE is asserted instead, which is still a claim.
      const [trigger] = await sql<{ n: string }[]>`
        select count(*)::text as n from pg_trigger
        where tgname in ('invoice_no_update', 'invoice_no_delete')
      `
      expect(Number(trigger?.n)).toBe(2)
      return
    }
    // Inside a transaction that is rolled back, so this suite writes nothing. The refusal has to arrive
    // as ZI003 and not as a permission error or a constraint name, either of which would satisfy a bare
    // "it threw" assertion while proving the trigger was gone.
    let code: string | null = null
    await sql
      .begin(async (tx) => {
        await tx`update invoice set currency = currency where id = ${invoice.id}::uuid`
        throw new Error('rolled back: the update should not have been accepted')
      })
      .catch((error: unknown) => {
        code = (error as { code?: string }).code ?? null
      })
    expect(code).toBe('ZI003')
  })

  it('still reports success and changes nothing on an UPDATE to the audit trail', async () => {
    const [counts] = await sql<{ total: string; notSystem: string }[]>`
      select count(*)::text as total,
             count(*) filter (where actor_kind <> 'system')::text as "notSystem"
        from audit_event
    `
    if (Number(counts?.total) === 0) {
      const [rules] = await sql<{ n: string }[]>`
        select count(*)::text as n from pg_rules
        where tablename = 'audit_event'
          and rulename in ('audit_event_no_update', 'audit_event_no_delete')
      `
      expect(Number(rules?.n)).toBe(2)
      return
    }
    /*
      The rules are `do instead nothing`, so the caller is TOLD it worked — migration 0018's own comment
      warns about exactly that. So the assertion is on the effect and not on an error: set every row's
      actor to `system`, delete the lot, and read the counts back inside the same rolled-back
      transaction. If the rules did not survive the restore both numbers move.
    */
    await sql
      .begin(async (tx) => {
        await tx`update audit_event set actor_kind = 'system'`
        await tx`delete from audit_event`
        const [after] = await tx<{ total: string; notSystem: string }[]>`
          select count(*)::text as total,
                 count(*) filter (where actor_kind <> 'system')::text as "notSystem"
            from audit_event
        `
        expect(after?.total).toBe(counts?.total)
        expect(after?.notSystem).toBe(counts?.notSystem)
        throw new Error('rolled back: the audit probe never commits')
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        if (!message.startsWith('rolled back')) throw error
      })
  })

  it('holds the legal entity as a singleton, which every tax document snapshots from', async () => {
    const [row] = await sql<{ n: string }[]>`select count(*)::text as n from legal_entity`
    // At most one, and the restore must not have produced two. Zero is a database nobody has seeded,
    // which is a legitimate state for a fresh migration run and not a restore failure.
    expect(Number(row?.n)).toBeLessThanOrEqual(1)
  })
})
