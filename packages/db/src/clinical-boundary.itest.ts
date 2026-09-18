import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from './connection.ts'

/**
 * Proves the clinical boundary is enforced by the DATABASE, not by application discipline.
 *
 * Each of these would be a documented convention in most codebases. Here they are assertions,
 * because the boundary's whole purpose is to survive a mistake in the application layer.
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

describe('schema isolation', () => {
  it('the clinical schema exists', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from information_schema.schemata where schema_name = 'clinical'
    `
    expect(row?.n).toBe('1')
  })

  it('NO foreign key crosses the boundary in either direction', async () => {
    // This is the property that makes relocating the clinical store possible. A single FK from
    // clinical to public welds the two schemas into one database forever.
    const rows = await sql<{ constraint_name: string; from_schema: string; to_schema: string }[]>`
      select c.conname as constraint_name,
             sf.nspname as from_schema,
             st.nspname as to_schema
      from pg_constraint c
      join pg_class tf on tf.oid = c.conrelid
      join pg_namespace sf on sf.oid = tf.relnamespace
      join pg_class tt on tt.oid = c.confrelid
      join pg_namespace st on st.oid = tt.relnamespace
      where c.contype = 'f'
        and sf.nspname <> st.nspname
        and 'clinical' in (sf.nspname, st.nspname)
    `
    expect(rows, `cross-boundary foreign keys found: ${JSON.stringify(rows)}`).toEqual([])
  })

  it('the application role cannot read the clinical schema', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role berelax_app`
        await tx`select 1 from clinical.intake_submission limit 1`
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('the application role cannot read treatment notes', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role berelax_app`
        await tx`select 1 from clinical.treatment_note limit 1`
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('the read-only reporting role cannot read the clinical schema either', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role berelax_readonly`
        await tx`select 1 from clinical.intake_submission limit 1`
      }),
    ).rejects.toThrow(/permission denied/i)
  })

  it('the clinical role CAN read the clinical schema', async () => {
    await sql.begin(async (tx) => {
      await tx`set local role berelax_clinical`
      const rows = await tx`select count(*) from clinical.intake_submission`
      expect(rows).toHaveLength(1)
    })
  })

  it('even the clinical role cannot DELETE a treatment note — corrections supersede', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role berelax_clinical`
        await tx`delete from clinical.treatment_note where false`
      }),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('the boundary view — the only path across', () => {
  it('exposes booleans only, with no free text or diagnosis column', async () => {
    const rows = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'customer_contraindication_flags'
      order by ordinal_position
    `
    const byName = new Map(rows.map((r) => [r.column_name, r.data_type]))

    expect(rows.length).toBeGreaterThan(0)
    for (const flag of [
      'pregnancy',
      'recent_surgery',
      'cardiovascular',
      'skin_condition',
      'requires_consultation',
    ]) {
      expect(byName.get(flag), `${flag} must be boolean`).toBe('boolean')
    }
    // No text column can leak a note or a diagnosis through the view.
    const textColumns = rows.filter((r) => r.data_type === 'text' || r.data_type.includes('char'))
    expect(textColumns, `view exposes text columns: ${JSON.stringify(textColumns)}`).toEqual([])
  })

  it('the application role CAN read the view without any clinical privilege', async () => {
    await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      const rows = await tx`select count(*) from public.customer_contraindication_flags`
      expect(rows).toHaveLength(1)
    })
  })
})

describe('storage shape', () => {
  it('intake payloads are stored as bytea with a nonce, wrapped key and KEK version', async () => {
    const rows = await sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type
      from information_schema.columns
      where table_schema = 'clinical' and table_name = 'intake_submission'
    `
    const byName = new Map(rows.map((r) => [r.column_name, r.data_type]))
    expect(byName.get('payload_ciphertext')).toBe('bytea')
    expect(byName.get('payload_nonce')).toBe('bytea')
    expect(byName.get('wrapped_data_key')).toBe('bytea')
    expect(byName.get('kek_version')).toBe('text')
    expect(byName.get('aad_fingerprint')).toBe('text')
    // There is deliberately no plaintext column to fall back to.
    expect(byName.has('payload')).toBe(false)
    expect(byName.has('answers')).toBe(false)
  })

  it('a treatment note can only be corrected by superseding, which the schema models', async () => {
    const [row] = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'clinical' and table_name = 'treatment_note' and column_name = 'supersedes_id'
    `
    expect(row?.column_name).toBe('supersedes_id')
  })

  it('exactly one intake template is current per locale', async () => {
    const [row] = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes
      where schemaname = 'clinical' and indexname = 'intake_template_one_current_per_locale'
    `
    expect(row?.def).toContain('WHERE is_current')
  })
})
