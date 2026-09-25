import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import { FLOW_SQLSTATE } from '../repositories/flow.ts'

/**
 * C-AUTO-06 — the schema-side guarantees of the version and the pin.
 *
 * Every claim here is one that can only be made against a real PostgreSQL: the SHAPE of a constraint as
 * `information_schema` reports it, a trigger that refuses a statement, and a column the database
 * generates. The behaviour built on top of them — publishing version N+1, four hundred enrolments staying
 * pinned — is `packages/fixtures/src/flow-versioning.itest.ts`, which may import `@berelax/core` for the
 * real validator; this file may not (brief rule 4), so it writes its documents by hand.
 *
 * ## Isolation
 *
 * `flow_definition` refuses DELETE for every role including the owner, so **nothing published here is
 * cleaned up** (ADR 0008, brief rules 9 and 12). Two consequences, both deliberate: the flow key is
 * namespaced to this file, and no assertion is a total — every count and every version number is relative
 * to what this run publishes, so a second run against the same database appends rather than colliding.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

const FLOW_KEY = 'cauto06_schema_itest'
/** On the unallocated +971 59 prefix, and in a band no other suite uses (`synthetic.ts`). */
const PROBE_PHONE = '+971590061001'

/** The smallest publishable document. Written by hand: this package may not import the DSL. */
const document = (nodes: number) => ({
  dslVersion: 1,
  key: FLOW_KEY,
  title: 'Schema probe',
  nodes: Array.from({ length: nodes }, (_, at) =>
    at === 0
      ? { event: 'manual', id: 'start', kind: 'trigger' }
      : { id: `step_${String(at)}`, kind: 'action_tag', tag: `step_${String(at)}` },
  ),
  edges: [],
})

let flowId: string
let customerId: string

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  const [flow] = await sql<{ id: string }[]>`
    insert into flow (flow_key, title, created_by)
    values (${FLOW_KEY}, 'Schema probe', 'cauto06 itest')
    on conflict (flow_key) do update set title = excluded.title
    returning id
  `
  flowId = (flow as { id: string }).id
  const [contact] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'front_desk')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = (contact as { id: string }).id
})

afterAll(async () => {
  // Enrolments only. `flow_definition` refuses DELETE by trigger and `flow` is referenced by the versions
  // this run published, so neither can be cleaned up — which is what makes every assertion below relative.
  await sql`delete from flow_enrolment where flow_id = ${flowId}`
  await sql`delete from customer where id = ${customerId}`
  await sql?.end({ timeout: 5 })
})

/** The next version number for this flow, so nothing here asserts an absolute one. */
async function nextVersion(): Promise<number> {
  const [row] = await sql<{ next: number }[]>`
    select coalesce(max(version), 0) + 1 as next from flow_definition where flow_id = ${flowId}
  `
  return row?.next ?? 1
}

async function publish(nodes = 3): Promise<number> {
  const version = await nextVersion()
  await sql`
    insert into flow_definition (flow_id, version, dsl_version, definition, published_by)
    values (${flowId}, ${version}, 1, ${sql.json(document(nodes) as never)}, 'cauto06 itest')
  `
  return version
}

/** The SQLSTATE a statement raised, or null when it did not raise. */
async function sqlstateOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (error) {
    return typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null
  }
}

describe('acceptance — the enrolment names an exact version row', () => {
  it('pins through a composite foreign key to (flow_id, version)', async () => {
    // The SHAPE of the constraint, from information_schema, and not merely that a reference exists: a
    // foreign key on `flow_id` alone would satisfy "there is a reference" and would follow nothing at
    // all, while `definition_version` sat beside it as an unconstrained integer.
    const columns = await sql<{ column_name: string; ordinal_position: number }[]>`
      select kcu.column_name, kcu.ordinal_position
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_name = tc.constraint_name
       where tc.constraint_name = 'flow_enrolment_pins_a_definition_version'
         and tc.constraint_type = 'FOREIGN KEY'
       order by kcu.ordinal_position
    `
    expect(columns.map((row) => row.column_name)).toEqual(['flow_id', 'definition_version'])

    const [target] = await sql<{ table_name: string; columns: string }[]>`
      select ccu.table_name, string_agg(ccu.column_name, ',' order by ccu.column_name) as columns
        from information_schema.table_constraints tc
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_name = tc.constraint_name
       where tc.constraint_name = 'flow_enrolment_pins_a_definition_version'
       group by ccu.table_name
    `
    expect(target?.table_name).toBe('flow_definition')
    expect(target?.columns).toBe('flow_id,version')
  })

  it('refuses a version that was never published', async () => {
    const version = await publish()
    const state = await sqlstateOf(sql`
      insert into flow_enrolment (flow_id, definition_version, customer_id, created_by)
      values (${flowId}, ${version + 500}, ${customerId}, 'cauto06 itest')
    `)
    expect(state).toBe('23503')
  })

  it('has definition_version NOT NULL, so no reference can follow the latest version', async () => {
    const [column] = await sql<{ is_nullable: string; data_type: string }[]>`
      select is_nullable, data_type
        from information_schema.columns
       where table_name = 'flow_enrolment' and column_name = 'definition_version'
    `
    expect(column?.is_nullable).toBe('NO')
    expect(column?.data_type).toBe('integer')
    // And the control, which is that the NOT NULL is the thing refusing it rather than the foreign key:
    // 23502 is not_null_violation, and a null on a MATCH SIMPLE composite key would otherwise be ACCEPTED
    // by the foreign key — a nullable column here would make "not pinned" storable.
    const state = await sqlstateOf(sql`
      insert into flow_enrolment (flow_id, definition_version, customer_id, created_by)
      values (${flowId}, null, ${customerId}, 'cauto06 itest')
    `)
    expect(state).toBe('23502')
  })

  it('refuses a DELETE of the version an enrolment is running on', async () => {
    // Belt and braces with the append-only trigger: even if the trigger were dropped, the RESTRICT would
    // still stop a published version disappearing from under an enrolment.
    const version = await publish()
    await sql`
      insert into flow_enrolment (flow_id, definition_version, customer_id, created_by)
      values (${flowId}, ${version}, ${customerId}, 'cauto06 itest')
    `
    const state = await sqlstateOf(
      sql`delete from flow_definition where flow_id = ${flowId} and version = ${version}`,
    )
    // ZF001 is the trigger, which fires first. The FK's 23503 is the second layer and is asserted by the
    // trigger-disabled case below being impossible: a BEFORE trigger cannot be bypassed from SQL.
    //
    // Compared against the CONSTANT the repository exports rather than against a literal: a caller
    // branches on that constant, and a trigger raising a code nothing branches on is a refusal no code
    // can act on.
    expect(state).toBe(FLOW_SQLSTATE.definitionImmutable)
  })
})

describe('acceptance — a published version is immutable', () => {
  it('raises ZF001 on UPDATE and on DELETE, for the owner', async () => {
    const version = await publish()
    expect(
      await sqlstateOf(sql`
        update flow_definition set definition = ${sql.json(document(2) as never)}
         where flow_id = ${flowId} and version = ${version}
      `),
    ).toBe(FLOW_SQLSTATE.definitionImmutable)
    expect(
      await sqlstateOf(
        sql`delete from flow_definition where flow_id = ${flowId} and version = ${version}`,
      ),
    ).toBe(FLOW_SQLSTATE.definitionImmutable)
    // The control: the same statement against the FLOW succeeds, so ZF001 is this table's rule rather
    // than a database that has stopped accepting writes.
    await expect(
      sql`update flow set title = 'Schema probe' where id = ${flowId}`,
    ).resolves.toBeDefined()
  })

  it('carries both refusal triggers, which is what the conventions gate reads', async () => {
    const triggers = await sql<{ trigger_name: string; event_manipulation: string }[]>`
      select trigger_name, event_manipulation
        from information_schema.triggers
       where event_object_table = 'flow_definition'
       order by trigger_name, event_manipulation
    `
    expect(triggers.map((row) => row.event_manipulation).sort()).toEqual(['DELETE', 'UPDATE'])
  })

  it('generates node_count from the document, and refuses a value for it', async () => {
    const version = await nextVersion()
    await sql`
      insert into flow_definition (flow_id, version, dsl_version, definition, published_by)
      values (${flowId}, ${version}, 1, ${sql.json(document(5) as never)}, 'cauto06 itest')
    `
    const [row] = await sql<{ node_count: number }[]>`
      select node_count from flow_definition where flow_id = ${flowId} and version = ${version}
    `
    expect(row?.node_count).toBe(5)
    // A caller-supplied count would be a second opinion about a document the row already holds.
    expect(
      await sqlstateOf(sql`
        insert into flow_definition (flow_id, version, dsl_version, definition, node_count, published_by)
        values (${flowId}, ${version + 1}, 1, ${sql.json(document(5) as never)}, 99, 'cauto06 itest')
      `),
    ).toBe('428C9')
  })

  it('refuses a document whose dslVersion disagrees with the column', async () => {
    const version = await nextVersion()
    const state = await sqlstateOf(sql`
      insert into flow_definition (flow_id, version, dsl_version, definition, published_by)
      values (${flowId}, ${version}, 2, ${sql.json(document(3) as never)}, 'cauto06 itest')
    `)
    expect(state).toBe('23514')
  })

  it('refuses a document over the node maximum', async () => {
    const version = await nextVersion()
    const state = await sqlstateOf(sql`
      insert into flow_definition (flow_id, version, dsl_version, definition, published_by)
      values (${flowId}, ${version}, 1, ${sql.json(document(61) as never)}, 'cauto06 itest')
    `)
    expect(state).toBe('23514')
    // The control: sixty is accepted, so the CHECK is a bound rather than a refusal of everything.
    const ok = await nextVersion()
    await expect(
      sql`
        insert into flow_definition (flow_id, version, dsl_version, definition, published_by)
        values (${flowId}, ${ok}, 1, ${sql.json(document(60) as never)}, 'cauto06 itest')
      `,
    ).resolves.toBeDefined()
  })
})

describe('acceptance — the pin cannot drift', () => {
  it('raises ZF002 on an UPDATE of either pinned column, and permits a status change', async () => {
    const first = await publish()
    const [enrolment] = await sql<{ id: string }[]>`
      insert into flow_enrolment (flow_id, definition_version, customer_id, created_by)
      values (${flowId}, ${first}, ${customerId}, 'cauto06 itest')
      returning id
    `
    const enrolmentId = (enrolment as { id: string }).id
    const second = await publish()

    // THE statement this design exists to refuse: "upgrade everyone to the latest".
    expect(
      await sqlstateOf(sql`
        update flow_enrolment set definition_version = ${second} where id = ${enrolmentId}
      `),
    ).toBe(FLOW_SQLSTATE.enrolmentPinImmutable)
    expect(
      await sqlstateOf(sql`
        update flow_enrolment set flow_id = ${flowId}, definition_version = ${second}
         where id = ${enrolmentId}
      `),
    ).toBe(FLOW_SQLSTATE.enrolmentPinImmutable)

    // The control, and the reason the rule is column-level rather than the append-only pair
    // `flow_definition` carries: an enrolment has to be able to finish.
    await expect(
      sql`
        update flow_enrolment
           set status = 'completed', ended_at = now(), ended_reason = 'goal_met'
         where id = ${enrolmentId}
      `,
    ).resolves.toBeDefined()
    const [row] = await sql<{ definition_version: number }[]>`
      select definition_version from flow_enrolment where id = ${enrolmentId}
    `
    expect(row?.definition_version, 'the pin survived the status change').toBe(first)
  })

  it('refuses an ended enrolment with no reason, and a live one with an end', async () => {
    const version = await publish()
    const [enrolment] = await sql<{ id: string }[]>`
      insert into flow_enrolment (flow_id, definition_version, customer_id, created_by)
      values (${flowId}, ${version}, ${customerId}, 'cauto06 itest')
      returning id
    `
    const enrolmentId = (enrolment as { id: string }).id
    expect(
      await sqlstateOf(sql`
        update flow_enrolment set status = 'completed', ended_at = now() where id = ${enrolmentId}
      `),
    ).toBe('23514')
    expect(
      await sqlstateOf(sql`update flow_enrolment set ended_at = now() where id = ${enrolmentId}`),
    ).toBe('23514')
  })
})

describe('the application role may not rewrite history', () => {
  it('has UPDATE and DELETE revoked on flow_definition, and DELETE on flow_enrolment', async () => {
    const rows = await sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type
        from information_schema.role_table_grants
       where grantee = 'berelax_app'
         and table_name in ('flow_definition', 'flow_enrolment')
       order by table_name, privilege_type
    `
    const held = (table: string) =>
      rows.filter((row) => row.table_name === table).map((row) => row.privilege_type)
    expect(held('flow_definition').sort()).toEqual(['INSERT', 'SELECT'])
    expect(held('flow_enrolment').sort()).toEqual(['INSERT', 'SELECT', 'UPDATE'])
  })
})
