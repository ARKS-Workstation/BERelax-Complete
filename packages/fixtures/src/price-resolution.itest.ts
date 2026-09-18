import {
  filsFrom,
  localDate,
  type PriceListId,
  type PriceListLayer,
  resolvePrice,
  selectEffectivePriceList,
} from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * B-CAT-04 — the SQL window and the pure window are the same window.
 *
 * `price_list` is effective-dated in PostgreSQL by `daterange(valid_from, valid_to, '[]')`, and
 * `packages/core/src/pricing/resolve-price.ts` decides the same question in TypeScript with a string
 * comparison. Two implementations of one rule is two chances to be wrong about the last day of a
 * promotion, and the disagreement would be invisible: each half has its own passing test.
 *
 * This file lives in `@berelax/fixtures` because it needs both, and fixtures is the only package
 * allowed to depend on `core` and `db` at once — `db` must never import `core`. Putting it beside
 * either half would have meant relaxing that boundary for the sake of a test.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const PROBE_TREATMENT = 'bcat04_pair_probe'

let sql: Sql
let variantId: string
/** The variant's own catalogue gross, read back from the row rather than assumed. */
let variantGrossFils: number
let septemberListId: string
let octoberListId: string

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
    values ('asian', ${PROBE_TREATMENT}, 'bcat04-pair-probe', 'Probe', 'Probe', 20)
    returning id
  `
  const [variant] = await sql<{ id: string; gross_price_fils: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils)
    values (${service?.id as string}, 60, 20000)
    returning id, gross_price_fils
  `
  variantId = variant?.id as string
  variantGrossFils = Number(variant?.gross_price_fils)

  // A closed September menu and an open-ended October price rise. Abutting, not overlapping: the
  // exclusion constraint would refuse the second row otherwise, which is the guarantee that makes
  // "the effective row" singular on every date.
  const [september] = await sql<{ id: string }[]>`
    insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to)
    values (${variantId}, 18000, 'bcat04 September menu', '2027-09-01', '2027-09-30')
    returning id
  `
  const [october] = await sql<{ id: string }[]>`
    insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to)
    values (${variantId}, 22000, 'bcat04 October rise', '2027-10-01', null)
    returning id
  `
  septemberListId = september?.id as string
  octoberListId = october?.id as string
})

afterAll(async () => {
  // The price lists cascade from the variant, which cascades from the service.
  await sql`delete from service where treatment_key = ${PROBE_TREATMENT}`
  await sql?.end({ timeout: 5 })
})

/** Every price list row for the variant, in the shape `packages/core` prices from. */
async function layersFromDatabase(): Promise<readonly PriceListLayer[]> {
  const rows = await sql<
    { id: string; gross_price_fils: string; valid_from: Date; valid_to: Date | null }[]
  >`
    select id, gross_price_fils, valid_from, valid_to
    from price_list
    where service_variant_id = ${variantId}
    order by valid_from
  `
  return rows.map((row) => ({
    priceListId: row.id as PriceListId,
    // filsFrom, not a cast: the driver hands back the digits as a string and this is where a
    // non-integer would have to be caught, since the type system cannot see across the wire.
    grossFils: filsFrom(Number(row.gross_price_fils)),
    validFrom: localDate(row.valid_from.toISOString().slice(0, 10)),
    validTo: row.valid_to === null ? null : localDate(row.valid_to.toISOString().slice(0, 10)),
  }))
}

/** The effective row as SQL finds it — the predicate a repository would write. */
async function effectiveInSql(on: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    select id from price_list
    where service_variant_id = ${variantId}
      and valid_from <= ${on}::date
      and (valid_to is null or ${on}::date <= valid_to)
  `
  expect(rows.length).toBeLessThanOrEqual(1)
  return rows[0]?.id ?? null
}

describe('acceptance — the database and the resolver agree on which row is effective', () => {
  const dates = [
    ['2027-08-31', null],
    ['2027-09-01', 'september'],
    ['2027-09-15', 'september'],
    ['2027-09-30', 'september'],
    ['2027-10-01', 'october'],
    ['2029-06-06', 'october'],
  ] as const

  for (const [day, expected] of dates) {
    it(`${day}: both halves pick ${expected ?? 'no row'}`, async () => {
      const layers = await layersFromDatabase()
      const fromCore = selectEffectivePriceList(layers, localDate(day))
      const fromSql = await effectiveInSql(day)

      const expectedId =
        expected === null ? null : expected === 'september' ? septemberListId : octoberListId

      expect(fromSql).toBe(expectedId)
      expect(fromCore?.priceListId ?? null).toBe(expectedId)
    })
  }

  it('an exclusive upper bound would disagree on the last day, which is why it is inclusive', async () => {
    // The control. Both halves agreeing proves nothing if the boundary they agree on is never tested,
    // and `<=` versus `<` on the last day of a promotion is exactly the difference that would survive
    // review. This runs the wrong predicate and asserts it finds nothing on the 30th.
    const wrong = await sql<{ id: string }[]>`
      select id from price_list
      where service_variant_id = ${variantId}
        and valid_from <= '2027-09-30'::date
        and (valid_to is null or '2027-09-30'::date < valid_to)
    `
    expect(wrong).toHaveLength(0)
    expect(await effectiveInSql('2027-09-30')).toBe(septemberListId)
  })
})

describe('acceptance — a price resolved from real rows carries the row that produced it', () => {
  it('prices the September menu and names the price list row', async () => {
    const layers = await layersFromDatabase()
    const priceList = selectEffectivePriceList(layers, localDate('2027-09-15'))
    const resolved = resolvePrice(
      {
        variant: { grossFils: filsFrom(variantGrossFils), durationMinutes: 60 },
        priceList,
      },
      { on: localDate('2027-09-15') },
    )

    expect(resolved.gross.fils).toBe(18_000)
    expect(resolved.net.fils).toBe(17_143)
    expect(resolved.vat.fils).toBe(857)
    expect(resolved.net.fils + resolved.vat.fils).toBe(resolved.gross.fils)
    expect(resolved.appliedRule).toBe('price_list')
    // The snapshot names the row a reader can go and look at. This is the field B-AVAIL-06 stores.
    expect(resolved.priceListId).toBe(septemberListId)
    expect(resolved.promotionId).toBeNull()
  })

  it('falls back to the variant when no price list covers the date', async () => {
    const layers = await layersFromDatabase()
    const priceList = selectEffectivePriceList(layers, localDate('2027-08-31'))
    const resolved = resolvePrice(
      {
        variant: { grossFils: filsFrom(variantGrossFils), durationMinutes: 60 },
        priceList,
      },
      { on: localDate('2027-08-31') },
    )

    expect(resolved.gross.fils).toBe(variantGrossFils)
    expect(resolved.appliedRule).toBe('variant')
    expect(resolved.priceListId).toBeNull()
    // The control for the test above: the two dates must produce different prices, or neither
    // assertion is about the price list at all.
    expect(resolved.gross.fils).not.toBe(18_000)
  })

  it('a price list inserted after the fact does not change what an earlier date resolves to', async () => {
    // The guarantee B-AVAIL-06's snapshot rests on, checked here at the resolver rather than at the
    // appointment: resolution is a pure function of the rows and the date, so a row added for July
    // cannot move a September answer.
    //
    // July and not November, because the October row is open-ended and the exclusion constraint
    // therefore refuses every later row — which is itself the constraint doing its job, and was worth
    // discovering here rather than in a repository that assumed it could append a price rise.
    await sql`
      insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to)
      values (${variantId}, 25000, 'bcat04 late insert', '2027-07-01', '2027-07-31')
    `
    const layers = await layersFromDatabase()
    const resolved = resolvePrice(
      {
        variant: { grossFils: filsFrom(variantGrossFils), durationMinutes: 60 },
        priceList: selectEffectivePriceList(layers, localDate('2027-09-15')),
      },
      { on: localDate('2027-09-15') },
    )
    expect(resolved.gross.fils).toBe(18_000)
    expect(resolved.priceListId).toBe(septemberListId)

    // And the new row is genuinely there, so the assertion above is not passing because nothing
    // happened.
    expect(await effectiveInSql('2027-07-15')).not.toBeNull()
  })
})
