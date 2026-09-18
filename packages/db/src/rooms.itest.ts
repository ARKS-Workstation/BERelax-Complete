import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from './connection.ts'

/**
 * B-CAT-02 — rooms, room types, capacity and service/room compatibility, against real PostgreSQL.
 *
 * Every guarantee asserted here is a database guarantee: an enum that refuses an unknown label, a
 * CHECK that refuses a capacity of zero, a join that returns nothing rather than everything. None of
 * them can be tested against a mock, because a mock would be asserting the mock.
 *
 * The pure half of the unit — `roomBusyDuring` and the `[)` boundary — is asserted in
 * `packages/core/src/availability/room-predicates.test.ts`. `packages/db` must never import
 * `packages/core`, so the agreement between them is kept by asserting the same boundary minute on
 * both sides: Postgres's own `&&` is checked here at 19:00 exactly.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** Probe rows carry this prefix so cleanup never touches the seeded inventory. */
const PROBE = 'bcat02-probe'

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql`delete from rooms where code like ${`${PROBE}%`}`
  await sql`delete from service_room_type_compat where service_treatment_key like ${`${PROBE}%`}`
  await sql?.end({ timeout: 5 })
})

/** The SQLSTATE of a rejected statement, or undefined when it was not rejected at all. */
async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('acceptance — rooms.capacity', () => {
  it('is a smallint, so the column cannot quietly hold a room for four billion clients', async () => {
    const [row] = await sql<{ data_type: string }[]>`
      select data_type from information_schema.columns
      where table_name = 'rooms' and column_name = 'capacity'
    `
    expect(row?.data_type).toBe('smallint')
  })

  it('carries a CHECK capacity >= 1', async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'rooms_capacity_positive'
    `
    expect(row?.def).toMatch(/capacity >= 1/)
  })

  it('rejects a capacity of zero and accepts a capacity of one', async () => {
    // 23514 = check_violation. The paired insert is the control: without it, a typo in the table
    // name would make the first expectation pass for the wrong reason.
    const rejected = await sqlstateOf(
      () => sql`
        insert into rooms (code, name, room_type, capacity)
        values (${`${PROBE}-zero`}, 'Probe', 'standard', 0)
      `,
    )
    expect(rejected).toBe('23514')

    const accepted = await sqlstateOf(
      () => sql`
        insert into rooms (code, name, room_type, capacity)
        values (${`${PROBE}-one`}, 'Probe', 'standard', 1)
      `,
    )
    expect(accepted).toBeUndefined()
  })

  it('refuses a couples room that holds one client', async () => {
    const rejected = await sqlstateOf(
      () => sql`
        insert into rooms (code, name, room_type, capacity)
        values (${`${PROBE}-couples-1`}, 'Probe', 'couples', 1)
      `,
    )
    expect(rejected).toBe('23514')
  })

  it('seeds the wet room at capacity 1 and the couples room at capacity 2', async () => {
    const rows = await sql<{ code: string; room_type: string; capacity: number }[]>`
      select code, room_type, capacity from rooms
      where code in ('room-wet', 'room-couples') order by code
    `
    expect(rows).toEqual([
      { code: 'room-couples', room_type: 'couples', capacity: 2 },
      { code: 'room-wet', room_type: 'wet', capacity: 1 },
    ])
  })

  it('seeds the documented provisional inventory: three standard, one couples, one wet', async () => {
    const rows = await sql<{ room_type: string; n: string }[]>`
      select room_type::text as room_type, count(*)::text as n
      from rooms where code like 'room-%' group by room_type order by room_type
    `
    expect(rows).toEqual([
      { room_type: 'couples', n: '1' },
      { room_type: 'standard', n: '3' },
      { room_type: 'wet', n: '1' },
    ])
  })
})

describe('acceptance — room_type is an enum of exactly standard|couples|wet', () => {
  it('has those three labels and no others', async () => {
    const rows = await sql<{ label: string }[]>`
      select e.enumlabel as label
      from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'room_type'
      order by e.enumsortorder
    `
    expect(rows.map((r) => r.label)).toEqual(['standard', 'couples', 'wet'])
  })

  it('rejects an unknown room type at the database level', async () => {
    // 22P02 = invalid_text_representation. A text column with a CHECK would give 23514; the point of
    // the enum is that the type itself refuses the value, before any constraint runs.
    const rejected = await sqlstateOf(
      () => sql`
        insert into rooms (code, name, room_type, capacity)
        values (${`${PROBE}-sauna`}, 'Probe', 'sauna', 1)
      `,
    )
    expect(rejected).toBe('22P02')
  })

  it('is the column type on both rooms and service_room_type_compat', async () => {
    const rows = await sql<{ table_name: string; udt_name: string }[]>`
      select table_name, udt_name from information_schema.columns
      where column_name = 'room_type' and table_name in ('rooms', 'service_room_type_compat')
      order by table_name
    `
    expect(rows).toEqual([
      { table_name: 'rooms', udt_name: 'room_type' },
      { table_name: 'service_room_type_compat', udt_name: 'room_type' },
    ])
  })
})

describe('acceptance — service_room_type_compat has no default and no fall-back', () => {
  it('yields zero bookable rooms for a service with no compatibility rows', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from service_bookable_room
      where service_style = 'asian' and service_treatment_key = ${`${PROBE}-unmapped`}
    `
    expect(row?.n).toBe('0')

    // The control that stops this passing vacuously: the view is not simply empty. A seeded service
    // over the same inventory returns rooms.
    const [seeded] = await sql<{ n: string }[]>`
      select count(*)::text as n from service_bookable_room
      where service_style = 'asian' and service_treatment_key = 'normal_massage'
    `
    expect(Number(seeded?.n)).toBeGreaterThan(0)
  })

  it('starts returning rooms the moment a compatibility row is added, and stops when it is removed', async () => {
    const key = `${PROBE}-latecomer`
    const count = async (): Promise<number> => {
      const [row] = await sql<{ n: string }[]>`
        select count(*)::text as n from service_bookable_room
        where service_style = 'arabic' and service_treatment_key = ${key}
      `
      return Number(row?.n)
    }

    expect(await count()).toBe(0)
    await sql`
      insert into service_room_type_compat (service_style, service_treatment_key, room_type)
      values ('arabic', ${key}, 'wet')
    `
    expect(await count()).toBe(1)
    await sql`delete from service_room_type_compat where service_treatment_key = ${key}`
    expect(await count()).toBe(0)
  })

  it('excludes a decommissioned room from the bookable set', async () => {
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from service_bookable_room
      where service_style = 'asian' and service_treatment_key = 'normal_massage'
    `
    await sql`update rooms set is_bookable = false where code = 'room-3'`
    const during = await sql<{ n: string }[]>`
      select count(*)::text as n from service_bookable_room
      where service_style = 'asian' and service_treatment_key = 'normal_massage'
    `
    await sql`update rooms set is_bookable = true where code = 'room-3'`
    expect(Number(during[0]?.n)).toBe(Number(before[0]?.n) - 1)
  })
})

describe('acceptance — the exact compatibility set of all 8 catalogue services', () => {
  /** (style x treatment) from docs/13 section 4. Eight services, no more and no fewer. */
  const EXPECTED: readonly [string, string, string[]][] = [
    ['asian', 'normal_massage', ['couples', 'standard']],
    ['asian', 'hot_oil_balm_massage', ['couples', 'standard']],
    ['asian', 'morocco_bath_jacuzzi', ['wet']],
    ['asian', 'massage_with_shaving', ['standard']],
    ['arabic', 'normal_massage', ['couples', 'standard']],
    ['arabic', 'hot_oil_balm_massage', ['couples', 'standard']],
    ['arabic', 'morocco_bath_jacuzzi', ['wet']],
    ['arabic', 'massage_with_shaving', ['standard']],
  ]

  it('holds compatibility rows for exactly those eight services', async () => {
    const rows = await sql<{ style: string; key: string }[]>`
      select distinct service_style::text as style, service_treatment_key as key
      from service_room_type_compat
      where service_treatment_key not like ${`${PROBE}%`}
    `
    expect(rows).toHaveLength(8)
    const seen = new Set(rows.map((r) => `${r.style}.${r.key}`))
    for (const [style, key] of EXPECTED) expect(seen.has(`${style}.${key}`)).toBe(true)
  })

  for (const [style, key, roomTypes] of EXPECTED) {
    it(`maps ${style} ${key} to exactly ${roomTypes.join(' + ')}`, async () => {
      const rows = await sql<{ room_type: string }[]>`
        select room_type::text as room_type from service_room_type_compat
        where service_style = ${style}::treatment_style and service_treatment_key = ${key}
        order by room_type::text
      `
      expect(rows.map((r) => r.room_type)).toEqual(roomTypes)
    })
  }

  it('resolves Morocco Bath / Jacuzzi to the wet room and nothing else, in both styles', async () => {
    const rows = await sql<{ style: string; room_code: string }[]>`
      select service_style::text as style, room_code from service_bookable_room
      where service_treatment_key = 'morocco_bath_jacuzzi' order by style
    `
    expect(rows).toEqual([
      { style: 'arabic', room_code: 'room-wet' },
      { style: 'asian', room_code: 'room-wet' },
    ])

    // The control: a dry treatment over the same inventory reaches rooms the bath cannot, so the
    // single-row result above is a restriction and not an empty inventory. Scoped to the seeded
    // inventory, because the probe rooms this file inserts are standard rooms too.
    const [dry] = await sql<{ n: string }[]>`
      select count(*)::text as n from service_bookable_room
      where service_treatment_key = 'normal_massage' and room_code like 'room-%'
    `
    expect(Number(dry?.n)).toBe(8)
  })

  it('flags the shaving rows as provisional against Y9-shaving-room', async () => {
    const rows = await sql<{ is_provisional: boolean; open_question_id: string }[]>`
      select is_provisional, open_question_id from service_room_type_compat
      where service_treatment_key = 'massage_with_shaving'
    `
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.is_provisional && r.open_question_id === 'Y9-shaving-room')).toBe(
      true,
    )
    // Control: not every row is flagged, or the flag would carry no information.
    const [unflagged] = await sql<{ n: string }[]>`
      select count(*)::text as n from service_room_type_compat where not is_provisional
    `
    expect(Number(unflagged?.n)).toBeGreaterThan(0)
  })
})

describe('resource_block periods are half-open, and Postgres agrees with the pure predicate', () => {
  const roomId = async (): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`select id from rooms where code = 'room-wet'`
    return row?.id as string
  }

  it('overlaps a block that straddles the period and not one that abuts it', async () => {
    // The same boundary minute the core test asserts: a block ending at 19:00 does not consume the
    // 19:00 slot. If these two ever disagree, the scheduler offers a slot the database then refuses.
    const [row] = await sql<{ abutting: boolean; overlapping: boolean }[]>`
      select
        tstzrange('2026-10-02T18:00:00+04', '2026-10-02T19:00:00+04', '[)')
          && tstzrange('2026-10-02T19:00:00+04', '2026-10-02T20:00:00+04', '[)') as abutting,
        tstzrange('2026-10-02T18:00:00+04', '2026-10-02T19:01:00+04', '[)')
          && tstzrange('2026-10-02T19:00:00+04', '2026-10-02T20:00:00+04', '[)') as overlapping
    `
    expect(row?.abutting).toBe(false)
    expect(row?.overlapping).toBe(true)
  })

  it('refuses an inclusive upper bound, so no writer can store a closed period', async () => {
    const id = await roomId()
    const rejected = await sqlstateOf(
      () => sql`
        insert into resource_block (room_id, period, kind, reason)
        values (${id}, tstzrange('2026-10-02T18:00:00+04', '2026-10-02T19:00:00+04', '[]'),
                'maintenance', 'probe')
      `,
    )
    expect(rejected).toBe('23514')
  })

  it('refuses an empty period and an unbounded one', async () => {
    const id = await roomId()
    const empty = await sqlstateOf(
      () => sql`
        insert into resource_block (room_id, period, kind, reason)
        values (${id}, tstzrange('2026-10-02T18:00:00+04', '2026-10-02T18:00:00+04', '[)'),
                'maintenance', 'probe')
      `,
    )
    expect(empty).toBe('23514')

    const unbounded = await sqlstateOf(
      () => sql`
        insert into resource_block (room_id, period, kind, reason)
        values (${id}, tstzrange('2026-10-02T18:00:00+04', null, '[)'), 'maintenance', 'probe')
      `,
    )
    expect(unbounded).toBe('23514')
  })

  it('accepts a well-formed block and finds it by overlap, then cascades on room delete', async () => {
    const [probe] = await sql<{ id: string }[]>`
      insert into rooms (code, name, room_type, capacity)
      values (${`${PROBE}-cascade`}, 'Probe', 'standard', 1)
      returning id
    `
    const id = probe?.id as string
    await sql`
      insert into resource_block (room_id, period, kind, reason)
      values (${id}, tstzrange('2026-10-02T18:00:00+04', '2026-10-02T19:30:00+04', '[)'),
              'deep_clean', 'probe')
    `
    const [found] = await sql<{ n: string }[]>`
      select count(*)::text as n from resource_block
      where room_id = ${id}
        and period && tstzrange('2026-10-02T19:00:00+04', '2026-10-02T20:00:00+04', '[)')
    `
    expect(found?.n).toBe('1')

    await sql`delete from rooms where id = ${id}`
    const [orphans] = await sql<{ n: string }[]>`
      select count(*)::text as n from resource_block where room_id = ${id}
    `
    expect(orphans?.n).toBe('0')
  })

  it('indexes (room_id, period) with GiST, which is what btree_gist is installed for', async () => {
    const [row] = await sql<{ def: string }[]>`
      select indexdef as def from pg_indexes where indexname = 'resource_block_room_period_idx'
    `
    expect(row?.def).toContain('USING gist')
    expect(row?.def).toContain('room_id')
    expect(row?.def).toContain('period')
  })

  it('rejects a block against a room that does not exist', async () => {
    // 23503 = foreign_key_violation. A block on a phantom room would sit in the table making
    // nothing unavailable, which reads as "the room is free" for a room nobody can find.
    const rejected = await sqlstateOf(
      () => sql`
        insert into resource_block (room_id, period, kind, reason)
        values ('00000000-0000-7000-8000-000000000000',
                tstzrange('2026-10-02T18:00:00+04', '2026-10-02T19:00:00+04', '[)'),
                'maintenance', 'probe')
      `,
    )
    expect(rejected).toBe('23503')
  })
})
