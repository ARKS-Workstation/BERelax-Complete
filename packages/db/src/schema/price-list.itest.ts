import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'

/**
 * B-CAT-04 — `price_list` against real PostgreSQL.
 *
 * Everything asserted here is a database guarantee, and the important one cannot be tested any other
 * way: `price_list_no_overlap` is an `EXCLUDE USING gist` constraint, so its behaviour under two
 * concurrent inserts *is* the feature. An application-level "is there already a row covering this
 * period?" check passes both inserts, because each transaction sees the other's row as uncommitted.
 *
 * The pure half of B-CAT-04 — the resolution chain, the sixteen-combination table, the VAT round trip —
 * is `packages/core/src/pricing/resolve-price.test.ts`, which needs no rows at all. The two halves are
 * proved to agree in `packages/fixtures/src/price-resolution.itest.ts`, which is the one package
 * allowed to depend on both.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** Probe rows carry this label, so cleanup can never reach a real price list. */
const PROBE = 'bcat04_probe'
/** Underscored: `service_treatment_key_snake_case` (0017) refuses a hyphen. */
const PROBE_TREATMENT = 'bcat04_probe'

let sql: Sql
/** Two variants of our own, so an overlap test can prove the constraint is scoped per variant. */
let variantA: string
let variantB: string

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
    values ('asian', ${PROBE_TREATMENT}, 'bcat04-probe-service', 'Probe', 'Probe', 20)
    returning id
  `
  const serviceId = service?.id as string
  const variants = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils)
    values (${serviceId}, 60, 20000), (${serviceId}, 90, 30000)
    returning id
  `
  variantA = variants[0]?.id as string
  variantB = variants[1]?.id as string
})

afterAll(async () => {
  // The service cascades to its variants and they cascade to the price lists, so one delete is enough
  // — but a probe row written against a seeded variant by a future edit would survive it, so the
  // label sweep runs too.
  await sql`delete from price_list where label like ${`${PROBE}%`}`
  // LIKE, not equality: the cascade test below creates a second service keyed `bcat04_probe_x`, and a
  // run that failed part-way through would otherwise leave it behind and make the NEXT run fail on a
  // duplicate slug instead of on the thing that actually broke.
  await sql`delete from service where treatment_key like ${`${PROBE_TREATMENT}%`}`
  await sql?.end({ timeout: 5 })
})

/** The SQLSTATE and constraint name of a rejected statement, or undefined when it was accepted. */
async function rejection(
  run: () => Promise<unknown>,
): Promise<{ code: string; constraint: string } | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    const e = error as { code?: string; constraint_name?: string }
    return { code: e.code ?? '', constraint: e.constraint_name ?? '' }
  }
}

function insertPriceList(args: {
  variantId: string
  grossPriceFils: number | string
  from: string
  to: string | null
  label?: string
}): Promise<unknown> {
  return sql`
    insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to)
    values (
      ${args.variantId},
      ${args.grossPriceFils},
      ${args.label ?? `${PROBE} list`},
      ${args.from},
      ${args.to}
    )
  `
}

describe('acceptance — the overlap constraint is a gist exclusion, not an application check', () => {
  it('exists as an EXCLUDE constraint backed by a gist index', async () => {
    // Asserted by introspection rather than by reading the migration, because the migration is what
    // was written and this is what was applied. A CHECK named price_list_no_overlap would read the
    // same in review and would not hold under concurrency.
    const [row] = await sql<{ contype: string; definition: string; access_method: string }[]>`
      select c.contype::text as contype,
             pg_get_constraintdef(c.oid) as definition,
             am.amname as access_method
      from pg_constraint c
      join pg_class i on i.oid = c.conindid
      join pg_am am on am.oid = i.relam
      where c.conrelid = 'price_list'::regclass and c.conname = 'price_list_no_overlap'
    `
    expect(row?.contype).toBe('x')
    expect(row?.access_method).toBe('gist')
    expect(row?.definition).toContain('service_variant_id WITH =')
    // Inclusive at both ends. An exclusive upper bound expires a menu one day early, once.
    expect(row?.definition).toContain(`daterange(valid_from, valid_to, '[]'`)
  })

  it('refuses a second row overlapping the first for the same variant', async () => {
    await insertPriceList({
      variantId: variantA,
      grossPriceFils: 18000,
      from: '2027-03-01',
      to: '2027-03-31',
    })

    const overlapping = await rejection(() =>
      insertPriceList({
        variantId: variantA,
        grossPriceFils: 19000,
        from: '2027-03-15',
        to: '2027-04-15',
      }),
    )
    // 23P01 = exclusion_violation, and by the name of the rule written for it: a bare non-zero is also
    // what a typo in a column name produces (ADR 0003).
    expect(overlapping?.code).toBe('23P01')
    expect(overlapping?.constraint).toBe('price_list_no_overlap')
  })

  it('refuses a row contained entirely inside an existing one', async () => {
    const contained = await rejection(() =>
      insertPriceList({
        variantId: variantA,
        grossPriceFils: 19000,
        from: '2027-03-10',
        to: '2027-03-12',
      }),
    )
    expect(contained?.constraint).toBe('price_list_no_overlap')
  })

  it('refuses a row that starts on the last day of an existing one', async () => {
    // The inclusive upper bound, from the other side. With an exclusive bound this would be accepted
    // and the 31st would have two prices.
    const sameDay = await rejection(() =>
      insertPriceList({
        variantId: variantA,
        grossPriceFils: 19000,
        from: '2027-03-31',
        to: '2027-04-30',
      }),
    )
    expect(sameDay?.constraint).toBe('price_list_no_overlap')
  })

  it('accepts an abutting row that starts the day after, which is the control', async () => {
    // Without this the three refusals above would be satisfied by a constraint that refused every
    // insert — and a table nobody can write to also has no overlapping rows.
    const abutting = await rejection(() =>
      insertPriceList({
        variantId: variantA,
        grossPriceFils: 19000,
        from: '2027-04-01',
        to: '2027-04-30',
      }),
    )
    expect(abutting).toBeUndefined()
  })

  it('accepts the same overlapping period for a different variant', async () => {
    // The constraint is scoped per service_variant. A 90-minute treatment and a 60-minute one change
    // price on the same day as a matter of course, and a constraint that forbade it would make a menu
    // change impossible.
    const otherVariant = await rejection(() =>
      insertPriceList({
        variantId: variantB,
        grossPriceFils: 28000,
        from: '2027-03-15',
        to: '2027-04-15',
      }),
    )
    expect(otherVariant).toBeUndefined()
  })

  it('treats a null valid_to as unbounded', async () => {
    const openEnded = await rejection(() =>
      insertPriceList({ variantId: variantA, grossPriceFils: 21000, from: '2027-05-01', to: null }),
    )
    expect(openEnded).toBeUndefined()

    // Anything after it now collides, because the open row runs to infinity.
    const afterOpenEnded = await rejection(() =>
      insertPriceList({ variantId: variantA, grossPriceFils: 22000, from: '2029-01-01', to: null }),
    )
    expect(afterOpenEnded?.constraint).toBe('price_list_no_overlap')

    // And anything strictly before it still fits — the control for the line above.
    const beforeOpenEnded = await rejection(() =>
      insertPriceList({
        variantId: variantA,
        grossPriceFils: 17000,
        from: '2027-01-01',
        to: '2027-02-28',
      }),
    )
    expect(beforeOpenEnded).toBeUndefined()
  })
})

describe('acceptance — a price list row is a price', () => {
  it('refuses a zero and a negative gross by name', async () => {
    for (const gross of [0, -1]) {
      const rejected = await rejection(() =>
        insertPriceList({
          variantId: variantB,
          grossPriceFils: gross,
          from: '2030-01-01',
          to: null,
        }),
      )
      expect(rejected?.code).toBe('23514')
      expect(rejected?.constraint).toBe('price_list_gross_positive')
    }
  })

  it('refuses a fractional gross on the parameterised path, which is the path the app uses', async () => {
    // 22P02 = invalid_text_representation, raised by the bigint input function parsing "250.5".
    const rejected = await rejection(() =>
      insertPriceList({ variantId: variantB, grossPriceFils: 250.5, from: '2030-01-01', to: null }),
    )
    expect(rejected?.code).toBe('22P02')
  })

  it('shows why that has to be the parameterised path: a SQL literal is rounded instead', async () => {
    // The trap B-CAT-03 found, asserted rather than described. Written into the statement text, 250.5
    // is a NUMERIC constant and the assignment cast to bigint rounds it — silently, to 251. A gate
    // that probed the fractional case with `psql -c` would therefore report that the rejection works
    // while the application path was the only one that ever refused anything.
    const [row] = await sql<{ gross_price_fils: string }[]>`
      insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to)
      values (${variantB}, 250.5, ${`${PROBE} rounded literal`}, '2031-01-01', null)
      returning gross_price_fils
    `
    expect(row?.gross_price_fils).toBe('251')
    await sql`delete from price_list where label = ${`${PROBE} rounded literal`}`
  })

  it('stores a large gross without precision loss', async () => {
    // bigint comes back as a string (see connection.ts). A value beyond 2^53 proves the driver is not
    // routing money through a double on the way out.
    const [row] = await sql<{ gross_price_fils: string }[]>`
      insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to)
      values (${variantB}, ${'9007199254740993'}, ${`${PROBE} big`}, '2032-01-01', null)
      returning gross_price_fils
    `
    expect(row?.gross_price_fils).toBe('9007199254740993')
    await sql`delete from price_list where label = ${`${PROBE} big`}`
  })

  it('refuses a window that ends before it starts', async () => {
    const rejected = await rejection(() =>
      insertPriceList({
        variantId: variantB,
        grossPriceFils: 18000,
        from: '2033-03-31',
        to: '2033-03-01',
      }),
    )
    expect(rejected?.constraint).toBe('price_list_valid_to_not_before_from')
  })

  it('accepts a one-day price list, which is the control for the window check', async () => {
    const accepted = await rejection(() =>
      insertPriceList({
        variantId: variantB,
        grossPriceFils: 18000,
        from: '2033-03-01',
        to: '2033-03-01',
      }),
    )
    expect(accepted).toBeUndefined()
  })

  it('refuses a price list with no label', async () => {
    const rejected = await rejection(() =>
      insertPriceList({
        variantId: variantB,
        grossPriceFils: 18000,
        from: '2034-01-01',
        to: null,
        label: '   ',
      }),
    )
    expect(rejected?.constraint).toBe('price_list_label_nonempty')
  })

  it('refuses a provisional price that names no open question', async () => {
    const rejected = await rejection(
      () => sql`
        insert into price_list
          (service_variant_id, gross_price_fils, label, valid_from, valid_to, is_provisional)
        values (${variantB}, 18000, ${`${PROBE} unflagged`}, '2035-01-01', null, true)
      `,
    )
    expect(rejected?.constraint).toBe('price_list_provisional_names_a_question')
  })

  it('cascades away with its variant, so no price list outlives the thing it prices', async () => {
    const [service] = await sql<{ id: string }[]>`
      insert into service
        (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
      values ('arabic', ${`${PROBE_TREATMENT}_x`}, 'bcat04-probe-cascade', 'Probe', 'Probe', 20)
      returning id
    `
    const [variant] = await sql<{ id: string }[]>`
      insert into service_variant (service_id, duration_minutes, gross_price_fils)
      values (${service?.id as string}, 45, 17000)
      returning id
    `
    await insertPriceList({
      variantId: variant?.id as string,
      grossPriceFils: 18000,
      from: '2036-01-01',
      to: null,
      label: `${PROBE} cascade`,
    })
    await sql`delete from service where id = ${service?.id as string}`
    const remaining = await sql<{ n: string }[]>`
      select count(*)::text as n from price_list where label = ${`${PROBE} cascade`}
    `
    expect(remaining[0]?.n).toBe('0')
  })
})

describe('acceptance — the effective row on a date, as SQL asks for it', () => {
  it('returns exactly one row per variant per date, inclusive at both ends', async () => {
    // The same window predicate `windowStateOn` implements in packages/core. The exclusion constraint
    // is what makes "exactly one" true rather than "the first one the planner reached".
    const effectiveOn = (variantId: string, on: string) => sql<{ label: string; n: string }[]>`
      select label, count(*) over ()::text as n
      from price_list
      where service_variant_id = ${variantId}
        and valid_from <= ${on}::date
        and (valid_to is null or ${on}::date <= valid_to)
    `

    const march = await effectiveOn(variantA, '2027-03-31')
    expect(march).toHaveLength(1)
    expect(march[0]?.n).toBe('1')

    const april = await effectiveOn(variantA, '2027-04-01')
    expect(april).toHaveLength(1)

    // A date no row covers. The control: without it, a predicate that matched everything would satisfy
    // the two assertions above on a table holding one row per period.
    const gap = await effectiveOn(variantA, '2026-12-31')
    expect(gap).toHaveLength(0)
  })
})
