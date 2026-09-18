import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'

/**
 * B-CAT-03 — the service catalogue against real PostgreSQL.
 *
 * Every guarantee here is a database guarantee: a UNIQUE that makes the catalogue exactly 8 rows, a CHECK
 * that refuses a zero price, and two composite foreign keys that refuse a service nobody defined and a
 * room type a service may not be delivered in. A mock would assert the mock.
 *
 * The pure half — the zod schemas, the exhaustive style→skill mapping and the type-level proof that no
 * price is reachable from that mapping — is asserted in `packages/shared/src/schemas/catalogue.test.ts`.
 * The four price cases are deliberately the same four in both files: the schema is what refuses a bad
 * value with a readable message, and the constraint is what refuses it when the schema is bypassed.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Probe rows carry this prefix so cleanup never touches the seeded catalogue.
 *
 * Underscored, not hyphenated: `service_treatment_key_snake_case` refuses a hyphen, which is the first
 * thing this file proved about itself.
 */
const PROBE = 'bcat03_probe'
/** The same probe name as a slug. `service_slug_kebab_case` refuses the underscored form. */
const PROBE_SLUG = 'bcat03-probe'

let sql: Sql
/** A service of our own to hang variants and shapes off, so no test mutates a seeded row. */
let probeServiceId: string

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  const [row] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
    values ('asian', ${PROBE}, ${'bcat03-probe-service'}, 'Probe', 'Probe', 20)
    returning id
  `
  probeServiceId = row?.id as string
})

afterAll(async () => {
  // One delete is enough for variants and shapes — both cascade from the service — but the compatibility
  // rows a test may have added against a seeded service have to go explicitly.
  await sql`delete from service where treatment_key like ${`${PROBE}%`}`
  await sql`delete from service_room_type_compat where service_treatment_key like ${`${PROBE}%`}`
  await sql`
    delete from service_room_type_compat
    where service_style = 'asian' and service_treatment_key = 'massage_with_shaving'
      and room_type = 'couples'
  `
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

describe('acceptance — style is the enum B-CAT-02 created, and (style, treatment_key) is UNIQUE', () => {
  it('uses the treatment_style enum, the same type as service_room_type_compat', async () => {
    // The whole reason 0012 declared the enum. A second enum with identical labels is a different type,
    // and a composite foreign key between them cannot be created at all.
    const rows = await sql<{ table_name: string; udt_name: string }[]>`
      select table_name, udt_name from information_schema.columns
      where (table_name = 'service' and column_name = 'style')
         or (table_name = 'service_room_type_compat' and column_name = 'service_style')
      order by table_name
    `
    expect(rows).toEqual([
      { table_name: 'service', udt_name: 'treatment_style' },
      { table_name: 'service_room_type_compat', udt_name: 'treatment_style' },
    ])
  })

  it('keeps treatment_key as text, which is what makes the composite key attachable', async () => {
    // An enum here would read better and would make the foreign key impossible: there is no equality
    // operator between an enum and the child's `text` column.
    const [row] = await sql<{ data_type: string }[]>`
      select data_type from information_schema.columns
      where table_name = 'service' and column_name = 'treatment_key'
    `
    expect(row?.data_type).toBe('text')
  })

  it('holds exactly the 8 catalogue services', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from service where treatment_key not like ${`${PROBE}%`}
    `
    expect(row?.n).toBe('8')
  })

  it('refuses a ninth service that duplicates a (style, treatment_key) pair', async () => {
    // 23505 = unique_violation. The catalogue is 4 treatments x 2 styles and nothing else; a duplicate
    // pair would give "the price of an Asian normal massage" two answers.
    const rejected = await sqlstateOf(
      () => sql`
        insert into service
          (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
        values ('asian', 'normal_massage', ${`${PROBE_SLUG}-duplicate`}, 'Probe', 'Probe', 20)
      `,
    )
    expect(rejected).toBe('23505')

    // The control: the same insert with an unused pair succeeds, so the rejection above is the UNIQUE
    // firing and not this table refusing every insert.
    const accepted = await sqlstateOf(
      () => sql`
        insert into service
          (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
        values ('arabic', ${`${PROBE}_ninth`}, ${`${PROBE_SLUG}-ninth`}, 'Probe', 'Probe', 20)
      `,
    )
    expect(accepted).toBeUndefined()
    await sql`delete from service where treatment_key = ${`${PROBE}_ninth`}`
  })

  it('refuses a treatment key that is not snake_case and a slug that is not kebab-case', async () => {
    const badKey = await sqlstateOf(
      () => sql`
        insert into service
          (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
        values ('asian', 'Normal Massage', ${`${PROBE_SLUG}-bad-key`}, 'Probe', 'Probe', 20)
      `,
    )
    expect(badKey).toBe('23514')

    const badSlug = await sqlstateOf(
      () => sql`
        insert into service
          (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
        values ('asian', ${`${PROBE}_slug`}, 'Not A Slug', 'Probe', 'Probe', 20)
      `,
    )
    expect(badSlug).toBe('23514')
  })

  it('refuses a provisional row that names no open question', async () => {
    // An assumption with nothing to ask about it appears in the Unconfirmed Assumptions panel as a value
    // nobody can resolve.
    const rejected = await sqlstateOf(
      () => sql`
        insert into service
          (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
           is_provisional)
        values ('asian', ${`${PROBE}_unflagged`}, ${`${PROBE_SLUG}-unflagged`}, 'Probe', 'Probe', 20,
                true)
      `,
    )
    expect(rejected).toBe('23514')

    // The control: not provisional and no question is the ordinary case and must still insert.
    const accepted = await sqlstateOf(
      () => sql`
        insert into service
          (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
           is_provisional)
        values ('asian', ${`${PROBE}_plain`}, ${`${PROBE_SLUG}-plain`}, 'Probe', 'Probe', 20, false)
      `,
    )
    expect(accepted).toBeUndefined()
    await sql`delete from service where treatment_key = ${`${PROBE}_plain`}`
  })

  it('flags the seeded turnaround as provisional against Y9-turnaround', async () => {
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from service
      where is_provisional and open_question_id = 'Y9-turnaround'
        and treatment_key not like ${`${PROBE}%`}
    `
    expect(rows[0]?.n).toBe('8')
  })
})

describe('acceptance — the composite foreign key B-CAT-02 deferred is attached', () => {
  it('exists, from service_room_type_compat to service', async () => {
    const [row] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conname = 'service_room_type_compat_service_fk'
    `
    expect(row?.def).toContain('FOREIGN KEY (service_style, service_treatment_key)')
    expect(row?.def).toContain('REFERENCES service(style, treatment_key)')
  })

  it('refuses a compatibility row for a service that does not exist', async () => {
    // 23503 = foreign_key_violation. Before the parent existed, a typo in a treatment key produced a
    // service with zero bookable rooms — which reads as "no availability" and not as a mistake.
    const rejected = await sqlstateOf(
      () => sql`
        insert into service_room_type_compat (service_style, service_treatment_key, room_type)
        values ('asian', ${`${PROBE}_ghost`}, 'standard')
      `,
    )
    expect(rejected).toBe('23503')

    // The control: a new room type for a service that DOES exist still inserts. Massage with Shaving is
    // seeded standard-only, so the couples row is genuinely new.
    const accepted = await sqlstateOf(
      () => sql`
        insert into service_room_type_compat (service_style, service_treatment_key, room_type)
        values ('asian', 'massage_with_shaving', 'couples')
      `,
    )
    expect(accepted).toBeUndefined()
    await sql`
      delete from service_room_type_compat
      where service_style = 'asian' and service_treatment_key = 'massage_with_shaving'
        and room_type = 'couples'
    `
  })

  it('leaves every seeded service with compatibility rows and every compatibility row with a service', async () => {
    // Both directions. A service with no rows is unbookable; a row with no service is the orphan the
    // foreign key now makes impossible.
    const orphanServices = await sql<{ treatment_key: string }[]>`
      select s.treatment_key from service s
      where s.treatment_key not like ${`${PROBE}%`}
        and not exists (
          select 1 from service_room_type_compat c
          where c.service_style = s.style and c.service_treatment_key = s.treatment_key
        )
    `
    expect(orphanServices).toEqual([])

    const orphanCompat = await sql<{ service_treatment_key: string }[]>`
      select c.service_treatment_key from service_room_type_compat c
      where not exists (
        select 1 from service s where s.style = c.service_style and s.treatment_key = c.service_treatment_key
      )
    `
    expect(orphanCompat).toEqual([])
  })

  it('carries a renamed treatment key into its compatibility rows, and cascades a delete', async () => {
    // ON UPDATE CASCADE and ON DELETE CASCADE, proved on a probe service rather than argued about. The
    // delete case is the one that matters: two cascade paths reach this table and
    // service_resource_shape, and a RESTRICT on either would refuse a legitimate delete depending on
    // which path PostgreSQL ran first.
    const renamed = `${PROBE}_renamed`
    await sql`
      insert into service_room_type_compat (service_style, service_treatment_key, room_type)
      values ('asian', ${PROBE}, 'standard')
    `
    await sql`
      insert into service_resource_shape
        (service_style, service_treatment_key, shape, therapists_required, rooms_required,
         min_room_capacity, required_room_type, therapist_buffer_minutes)
      values ('asian', ${PROBE}, 'solo', 1, 1, 1, 'standard', 10)
    `

    await sql`update service set treatment_key = ${renamed} where id = ${probeServiceId}`
    const [moved] = await sql<{ n: string }[]>`
      select count(*)::text as n from service_room_type_compat
      where service_treatment_key = ${renamed}
    `
    expect(moved?.n).toBe('1')
    const [shapeMoved] = await sql<{ n: string }[]>`
      select count(*)::text as n from service_resource_shape
      where service_treatment_key = ${renamed}
    `
    expect(shapeMoved?.n).toBe('1')

    await sql`delete from service where id = ${probeServiceId}`
    const [compatLeft] = await sql<{ n: string }[]>`
      select count(*)::text as n from service_room_type_compat
      where service_treatment_key = ${renamed}
    `
    const [shapeLeft] = await sql<{ n: string }[]>`
      select count(*)::text as n from service_resource_shape
      where service_treatment_key = ${renamed}
    `
    expect([compatLeft?.n, shapeLeft?.n]).toEqual(['0', '0'])

    // Put the probe service back: the tests below hang variants off it.
    const [reborn] = await sql<{ id: string }[]>`
      insert into service
        (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
      values ('asian', ${PROBE}, ${'bcat03-probe-service'}, 'Probe', 'Probe', 20)
      returning id
    `
    probeServiceId = reborn?.id as string
  })
})

describe('acceptance — service_variant duration and price', () => {
  afterAll(async () => {
    await sql`delete from service_variant where service_id = ${probeServiceId}`
  })

  for (const duration of [45, 60, 90, 120]) {
    it(`accepts a ${duration}-minute variant`, async () => {
      const accepted = await sqlstateOf(
        () => sql`
          insert into service_variant (service_id, duration_minutes, gross_price_fils)
          values (${probeServiceId}, ${duration}, 25000)
        `,
      )
      expect(accepted).toBeUndefined()
    })
  }

  it('refuses a duration the price list has no column for', async () => {
    for (const duration of [30, 50, 75, 150]) {
      const rejected = await sqlstateOf(
        () => sql`
          insert into service_variant (service_id, duration_minutes, gross_price_fils)
          values (${probeServiceId}, ${duration}, 25000)
        `,
      )
      expect(rejected).toBe('23514')
    }
  })

  it('refuses two prices for the same (service, duration)', async () => {
    await sql`
      insert into service_variant (service_id, duration_minutes, gross_price_fils)
      values (${probeServiceId}, 90, 44000)
      on conflict do nothing
    `
    const rejected = await sqlstateOf(
      () => sql`
        insert into service_variant (service_id, duration_minutes, gross_price_fils)
        values (${probeServiceId}, 90, 30000)
      `,
    )
    expect(rejected).toBe('23505')
  })

  it('rejects zero, negative, NULL and non-integer prices — four separate cases', async () => {
    // The same four the zod schema rejects, asserted here against the database because an API route is
    // not the only way a row arrives. Each SQLSTATE is different, which is the evidence that four
    // distinct mechanisms are doing the work rather than one catch-all.
    //
    // Starting from no variants, so the control insert at the end is refused by nothing but a price rule.
    await sql`delete from service_variant where service_id = ${probeServiceId}`
    const zero = await sqlstateOf(
      () => sql`
        insert into service_variant (service_id, duration_minutes, gross_price_fils)
        values (${probeServiceId}, 60, 0)
      `,
    )
    expect(zero).toBe('23514')

    const negative = await sqlstateOf(
      () => sql`
        insert into service_variant (service_id, duration_minutes, gross_price_fils)
        values (${probeServiceId}, 60, -25000)
      `,
    )
    expect(negative).toBe('23514')

    const missing = await sqlstateOf(
      () => sql`
        insert into service_variant (service_id, duration_minutes, gross_price_fils)
        values (${probeServiceId}, 60, null)
      `,
    )
    expect(missing).toBe('23502')

    // 22P02 = invalid_text_representation, raised by the `fils` domain's own input parsing. Passed as a
    // PARAMETER on purpose: written as a SQL literal, `250.5` is a numeric constant that Postgres would
    // round to 251 on the way into a bigint, silently. Every write from the application arrives as a
    // parameter, which is the path that actually refuses it.
    const fractional = await sqlstateOf(
      () => sql`
        insert into service_variant (service_id, duration_minutes, gross_price_fils)
        values (${probeServiceId}, 60, ${250.5})
      `,
    )
    expect(fractional).toBe('22P02')

    // The control, and the reason the four above mean anything: a real price inserts.
    const accepted = await sqlstateOf(
      () => sql`
        insert into service_variant (service_id, duration_minutes, gross_price_fils)
        values (${probeServiceId}, 60, 25000)
      `,
    )
    expect(accepted).toBeUndefined()
  })

  it('stores the price in the fils domain, so the unit is in the column type', async () => {
    const [row] = await sql<{ domain_name: string | null; data_type: string }[]>`
      select domain_name, data_type from information_schema.columns
      where table_name = 'service_variant' and column_name = 'gross_price_fils'
    `
    expect(row?.domain_name).toBe('fils')
    expect(row?.data_type).toBe('bigint')
  })
})

describe('acceptance — turnaround and the therapist buffer are two columns with no derivation', () => {
  it('has the wet-room service at 30 turnaround and its shape at 10 buffer', async () => {
    const [service] = await sql<{ turnaround_minutes: number }[]>`
      select turnaround_minutes from service
      where style = 'asian' and treatment_key = 'morocco_bath_jacuzzi'
    `
    const [shape] = await sql<{ therapist_buffer_minutes: number }[]>`
      select therapist_buffer_minutes from service_resource_shape
      where service_style = 'asian' and service_treatment_key = 'morocco_bath_jacuzzi'
        and shape = 'solo'
    `
    expect(service?.turnaround_minutes).toBe(30)
    expect(shape?.therapist_buffer_minutes).toBe(10)
    // The dry services keep 20, so 30 is the wet room being different and not a single global number.
    const [dry] = await sql<{ turnaround_minutes: number }[]>`
      select turnaround_minutes from service
      where style = 'asian' and treatment_key = 'normal_massage'
    `
    expect(dry?.turnaround_minutes).toBe(20)
  })

  it('neither column is generated from the other', async () => {
    // A generated column would make one readable from the other by definition. Asserting on
    // is_generated rather than on the values catches the derivation even when the two numbers happen to
    // agree, which they do for every standard-room service.
    const rows = await sql<{ table_name: string; is_generated: string; expr: string | null }[]>`
      select table_name, is_generated, generation_expression as expr
      from information_schema.columns
      where (table_name = 'service' and column_name = 'turnaround_minutes')
         or (table_name = 'service_resource_shape' and column_name = 'therapist_buffer_minutes')
      order by table_name
    `
    expect(rows.map((r) => [r.table_name, r.is_generated, r.expr])).toEqual([
      ['service', 'NEVER', null],
      ['service_resource_shape', 'NEVER', null],
    ])
  })

  it('moves one without moving the other, in both directions', async () => {
    // The behavioural half. If either value were derived from the other, one of these updates would
    // drag its partner along — which is the failure docs/06 B1 describes: a 30-minute room clean
    // becoming a 30-minute therapist break, or a 10-minute break becoming a 10-minute room clean.
    await sql`
      update service_resource_shape set therapist_buffer_minutes = 25
      where service_style = 'asian' and service_treatment_key = 'morocco_bath_jacuzzi' and shape = 'solo'
    `
    const [afterBuffer] = await sql<{ turnaround_minutes: number }[]>`
      select turnaround_minutes from service
      where style = 'asian' and treatment_key = 'morocco_bath_jacuzzi'
    `
    expect(afterBuffer?.turnaround_minutes).toBe(30)

    await sql`
      update service set turnaround_minutes = 45
      where style = 'asian' and treatment_key = 'morocco_bath_jacuzzi'
    `
    const [afterTurnaround] = await sql<{ therapist_buffer_minutes: number }[]>`
      select therapist_buffer_minutes from service_resource_shape
      where service_style = 'asian' and service_treatment_key = 'morocco_bath_jacuzzi'
        and shape = 'solo'
    `
    expect(afterTurnaround?.therapist_buffer_minutes).toBe(25)

    await sql`
      update service set turnaround_minutes = 30
      where style = 'asian' and treatment_key = 'morocco_bath_jacuzzi'
    `
    await sql`
      update service_resource_shape set therapist_buffer_minutes = 10
      where service_style = 'asian' and service_treatment_key = 'morocco_bath_jacuzzi' and shape = 'solo'
    `
    const [restored] = await sql<{ turnaround: number; buffer: number }[]>`
      select s.turnaround_minutes as turnaround, r.therapist_buffer_minutes as buffer
      from service s
      join service_resource_shape r
        on r.service_style = s.style and r.service_treatment_key = s.treatment_key
      where s.style = 'asian' and s.treatment_key = 'morocco_bath_jacuzzi' and r.shape = 'solo'
    `
    expect([restored?.turnaround, restored?.buffer]).toEqual([30, 10])
  })
})

describe('acceptance — the resource shape of each service', () => {
  interface ShapeRow {
    readonly therapists_required: number
    readonly rooms_required: number
    readonly min_room_capacity: number
    readonly required_room_type: string | null
  }

  const shapeOf = async (
    style: string,
    key: string,
    shape: string,
  ): Promise<ShapeRow | undefined> => {
    const rows = await sql<ShapeRow[]>`
      select therapists_required, rooms_required, min_room_capacity,
             required_room_type::text as required_room_type
      from service_resource_shape
      where service_style = ${style}::treatment_style and service_treatment_key = ${key}
        and shape = ${shape}::service_shape
    `
    return rows[0]
  }

  it('Four Hands is 2 therapists, 1 room, minimum capacity 1, standard room', async () => {
    // Minimum capacity 1 is the non-obvious number: two therapists work over ONE client, so deriving
    // capacity from the therapist count would demand a couples room and lose three of the five rooms.
    for (const style of ['asian', 'arabic']) {
      expect(await shapeOf(style, 'normal_massage', 'four_hands')).toEqual({
        therapists_required: 2,
        rooms_required: 1,
        min_room_capacity: 1,
        required_room_type: 'standard',
      })
    }
  })

  it('Couple Massage is 2 therapists, 1 room, minimum capacity 2', async () => {
    for (const style of ['asian', 'arabic']) {
      expect(await shapeOf(style, 'normal_massage', 'couple')).toEqual({
        therapists_required: 2,
        rooms_required: 1,
        min_room_capacity: 2,
        required_room_type: 'couples',
      })
    }
  })

  it('Morocco Bath is 1 therapist, 1 room, and the wet room', async () => {
    for (const style of ['asian', 'arabic']) {
      expect(await shapeOf(style, 'morocco_bath_jacuzzi', 'solo')).toEqual({
        therapists_required: 1,
        rooms_required: 1,
        min_room_capacity: 1,
        required_room_type: 'wet',
      })
    }
  })

  it('gives every service a solo shape and no two-therapist shape to the wet or shaving treatments', async () => {
    const rows = await sql<{ shape: string; n: string }[]>`
      select shape::text as shape, count(*)::text as n from service_resource_shape
      where service_treatment_key not like ${`${PROBE}%`}
      group by shape order by shape::text
    `
    expect(rows).toEqual([
      { shape: 'couple', n: '4' },
      { shape: 'four_hands', n: '4' },
      { shape: 'solo', n: '8' },
    ])

    const twoTherapist = await sql<{ key: string }[]>`
      select distinct service_treatment_key as key from service_resource_shape
      where shape in ('four_hands', 'couple') order by key
    `
    expect(twoTherapist.map((r) => r.key)).toEqual(['hot_oil_balm_massage', 'normal_massage'])
  })

  it('refuses a couple shape that fits in a single room and four hands with one therapist', async () => {
    const singleRoomCouple = await sqlstateOf(
      () => sql`
        insert into service_resource_shape
          (service_style, service_treatment_key, shape, therapists_required, rooms_required,
           min_room_capacity, therapist_buffer_minutes)
        values ('asian', ${PROBE}, 'couple', 2, 1, 1, 10)
      `,
    )
    expect(singleRoomCouple).toBe('23514')

    const oneHandedFourHands = await sqlstateOf(
      () => sql`
        insert into service_resource_shape
          (service_style, service_treatment_key, shape, therapists_required, rooms_required,
           min_room_capacity, therapist_buffer_minutes)
        values ('asian', ${PROBE}, 'four_hands', 1, 1, 1, 10)
      `,
    )
    expect(oneHandedFourHands).toBe('23514')
  })

  it('refuses a shape demanding a room type the service may not be delivered in', async () => {
    // The guarantee the natural key buys. A Morocco Bath shape asking for a couples room has no
    // compatibility row to stand on, and without this foreign key it would resolve to zero bookable
    // rooms and present as "no availability" for ever.
    const rejected = await sqlstateOf(
      () => sql`
        insert into service_resource_shape
          (service_style, service_treatment_key, shape, therapists_required, rooms_required,
           min_room_capacity, required_room_type, therapist_buffer_minutes)
        values ('asian', 'morocco_bath_jacuzzi', 'couple', 2, 1, 2, 'couples', 10)
      `,
    )
    expect(rejected).toBe('23503')

    // Two controls on the probe service. With a compatibility row for 'standard' the same shape inserts;
    // asking for 'wet' — which the probe service has no row for — is refused. So the rejection is the
    // compatibility set doing the work, not the shape table refusing every insert.
    await sql`
      insert into service_room_type_compat (service_style, service_treatment_key, room_type)
      values ('asian', ${PROBE}, 'standard')
      on conflict do nothing
    `
    const accepted = await sqlstateOf(
      () => sql`
        insert into service_resource_shape
          (service_style, service_treatment_key, shape, therapists_required, rooms_required,
           min_room_capacity, required_room_type, therapist_buffer_minutes)
        values ('asian', ${PROBE}, 'four_hands', 2, 1, 1, 'standard', 10)
      `,
    )
    expect(accepted).toBeUndefined()

    const wetRejected = await sqlstateOf(
      () => sql`
        insert into service_resource_shape
          (service_style, service_treatment_key, shape, therapists_required, rooms_required,
           min_room_capacity, required_room_type, therapist_buffer_minutes)
        values ('asian', ${PROBE}, 'couple', 2, 1, 2, 'wet', 10)
      `,
    )
    expect(wetRejected).toBe('23503')

    // A NULL required_room_type is MATCH SIMPLE, so it is unconstrained and falls back to the full
    // compatibility set — the case that must stay legal or every solo shape would need a row per type.
    const nullType = await sqlstateOf(
      () => sql`
        insert into service_resource_shape
          (service_style, service_treatment_key, shape, therapists_required, rooms_required,
           min_room_capacity, required_room_type, therapist_buffer_minutes)
        values ('asian', ${PROBE}, 'solo', 1, 1, 1, null, 10)
      `,
    )
    expect(nullType).toBeUndefined()

    await sql`delete from service_resource_shape where service_treatment_key = ${PROBE}`
    await sql`delete from service_room_type_compat where service_treatment_key = ${PROBE}`
  })
})

describe('acceptance — service_skill is total over the style enum and carries no price', () => {
  it('has exactly one row per label of treatment_style', async () => {
    // Totality cannot be a CHECK — a constraint cannot count rows — so it is asserted against pg_enum.
    // A third style added without a skill row would fail here, which is the point: it would otherwise
    // surface as an empty therapist list for a service that looks bookable.
    const [row] = await sql<{ labels: string; mappings: string }[]>`
      select
        (select count(*)::text from pg_enum e join pg_type t on t.oid = e.enumtypid
         where t.typname = 'treatment_style') as labels,
        (select count(*)::text from service_skill) as mappings
    `
    expect(row?.mappings).toBe(row?.labels)
    expect(row?.labels).toBe('2')
  })

  it('maps asian to asian_style and arabic to arabic_style', async () => {
    const rows = await sql<{ style: string; required_skill: string }[]>`
      select style::text as style, required_skill::text as required_skill
      from service_skill order by style::text
    `
    expect(rows).toEqual([
      { style: 'arabic', required_skill: 'arabic_style' },
      { style: 'asian', required_skill: 'asian_style' },
    ])
  })

  it('refuses one skill serving both styles', async () => {
    // Which would be "style is really a therapist attribute" arriving through the mapping: every
    // therapist eligible for everything.
    const rejected = await sqlstateOf(
      () => sql`update service_skill set required_skill = 'asian_style' where style = 'arabic'`,
    )
    expect(rejected).toBe('23505')
  })

  it('has no price column anywhere in the table', async () => {
    // The database half of the type-level assertion in packages/shared. Decision 21 decouples pricing
    // from therapist assignment; a price reachable from the eligibility mapping recouples them, and the
    // recoupling is invisible until a therapist reassignment changes a quoted price.
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_name = 'service_skill' order by ordinal_position
    `
    expect(columns.map((c) => c.column_name)).toEqual(['style', 'required_skill', 'created_at'])
  })

  it('uses the therapist_skill enum with exactly two labels', async () => {
    const rows = await sql<{ label: string }[]>`
      select e.enumlabel as label from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'therapist_skill' order by e.enumsortorder
    `
    expect(rows.map((r) => r.label)).toEqual(['asian_style', 'arabic_style'])
  })
})
