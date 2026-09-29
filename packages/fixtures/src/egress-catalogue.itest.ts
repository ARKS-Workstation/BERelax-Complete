import {
  buildEgressPayload,
  type CatalogueRef,
  catalogueRefKey,
  catalogueVocabulary,
  categoryCodeFor,
  egressTokensOf,
  enumerateCatalogueRefs,
  PRICE_ON_REQUEST_FOOTPRINTS,
  type PriceOnRequestFootprint,
  serialiseEgressPayload,
  unpermittedEgressTokens,
} from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import {
  SERVICE_DURATIONS,
  type ServiceDuration,
  TREATMENT_KEYS,
  TREATMENT_STYLES,
  type TreatmentKey,
  type TreatmentStyle,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadSalon } from './load.ts'
import { generateSalon } from './salon.ts'

/**
 * A-MEAS-01 — the closed set the guard enumerates IS the catalogue the seed writes.
 *
 * `packages/core/src/analytics/egress-guard.test.ts` proves the mapping is total, injective and opaque over
 * `enumerateCatalogueRefs()`. On its own that is a claim about a list this build wrote about itself: if the
 * enumeration and the seeded rows ever disagree, a dispatcher reading a real row finds no code for it and
 * the unit's whole purpose — "an unmapped row fails the suite" — would be measured against nothing. ADR
 * 0002's defect exactly, and the reason the acceptance line says *seeded* catalogue row.
 *
 * `packages/core` cannot see a row and `packages/db` may not import `packages/core`, so this is the one
 * place both halves are visible — the seam `catalogue-compliance.itest.ts` and `funnel.test.ts` each use for
 * their own pair.
 *
 * Four row sets, each asserted in BOTH directions:
 *
 *   - `service`: the 8 `(style × treatment)` pairs;
 *   - `service_variant`: the 32 `(style × treatment × duration)` cells of docs/13 §4;
 *   - `price_on_request`: the three offerings docs/13 lists with no figure, projected on `shape` rather than
 *     on `menu_label` — the label is the public name this unit exists to keep off the wire;
 *   - `package_template`: one category for all of them, because `template_key` is owner-authored and so the
 *     set of keys is open (see {@link CatalogueRef}'s header).
 *
 * ## Why every read is narrowed to PUBLISHED services
 *
 * Not to make an assertion pass. Publication is what makes a service reachable — the catalogue seed's own
 * header says *"this function is the write that puts them in front of a customer"* — so an unpublished row
 * cannot be viewed, priced, booked or paid for, and no analytics event can be about one. That is also the
 * narrowing brief rule 12 asks for: this suite shares a database with sixteen others, several of which
 * commit a probe `service` row with a `treatment_key` of their own (`bcat05_pair_probe`) and remove it in
 * `afterAll`. Narrowing what the code under test can SEE is the fix; filtering by the probe's own name
 * would be the other thing, and `catalogue-compliance.itest.ts` already does that for its own reads.
 *
 * The wider claim is not dropped, it is stated where it is robust: a published service the guard CANNOT
 * categorise is a failure, asserted below over every row in the table. An unpublished one is not, because
 * nothing can dispatch an event about it.
 *
 * This suite writes nothing and empties nothing, so it needs no entry in
 * `packages/db/src/suite-table-declarations.ts` (ADR 0050).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

const REFS = enumerateCatalogueRefs()
const refsOfKind = <K extends CatalogueRef['kind']>(kind: K): readonly CatalogueRef[] =>
  REFS.filter((ref) => ref.kind === kind)

const sorted = (keys: readonly string[]): readonly string[] => [...keys].sort()

/**
 * Words the seeded names contain that the enums do not supply, and why each is not a gap.
 *
 * `catalogueVocabulary()` is derived from `TREATMENT_KEYS` and `TREATMENT_STYLES`, and the eight seeded names
 * are those words plus punctuation and one joining word: `Asian Morocco Bath or Jacuzzi`. Declared with the
 * reason rather than added to the derivation, because `or` is grammar and not a treatment — putting it in the
 * vocabulary would widen the opacity detector for nothing.
 */
const JOINING_WORDS = new Set(['or'])

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  // The file order is not this file's to choose and the seeder is idempotent per table, so it is re-run
  // rather than assumed (brief rule 24).
  await loadSalon(sql, generateSalon())
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

const isStyle = (value: string): value is TreatmentStyle =>
  (TREATMENT_STYLES as readonly string[]).includes(value)
const isTreatmentKey = (value: string): value is TreatmentKey =>
  (TREATMENT_KEYS as readonly string[]).includes(value)
const isDuration = (value: number): value is ServiceDuration =>
  (SERVICE_DURATIONS as readonly number[]).includes(value)

describe('every seeded service row has an opaque category code', () => {
  it('projects onto exactly the eight enumerated service refs, both directions', async () => {
    const rows = await sql<{ style: string; treatment_key: string }[]>`
      select distinct s.style::text as style, s.treatment_key
        from service s
       where s.published_at is not null
    `
    // Direction 1: every seeded row is a ref the guard holds a code for. An unmapped row fails HERE, which
    // is the acceptance line, and the failure names the row rather than a count.
    const projected: string[] = []
    for (const row of rows) {
      expect(isStyle(row.style), `service.style '${row.style}' is not in TREATMENT_STYLES`).toBe(
        true,
      )
      expect(
        isTreatmentKey(row.treatment_key),
        `published service '${row.style}/${row.treatment_key}' has no category code: its treatment key ` +
          'is not in TREATMENT_KEYS, so a dispatcher reading this row would have nothing opaque to send ' +
          'for it. Either the enum and the catalogue have come apart, or another suite has left a ' +
          'published probe row behind.',
      ).toBe(true)
      if (!isStyle(row.style) || !isTreatmentKey(row.treatment_key)) continue
      projected.push(
        catalogueRefKey({ kind: 'service', style: row.style, treatmentKey: row.treatment_key }),
      )
    }
    // Direction 2: every ref the guard enumerates is a row that exists. Without this, a code for a service
    // the catalogue does not have would sit in the table for ever as a bucket nothing fills.
    expect(sorted(projected)).toEqual(sorted(refsOfKind('service').map(catalogueRefKey)))
    expect(rows).toHaveLength(8)
  })

  it('has no published service the guard cannot categorise', async () => {
    // The wider claim, stated where it is robust: an unpublished probe row is fine — nothing can dispatch an
    // event about it — but a PUBLISHED row outside the enum is a customer-reachable service with no code.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from service
       where published_at is not null
         and treatment_key <> all(${[...TREATMENT_KEYS]}::text[])
    `
    expect(Number(row?.n ?? '-1')).toBe(0)
  })

  it('shares no token with the real internal and public names', async () => {
    const rows = await sql<
      { style: string; treatment_key: string; internal_name: string; public_display_name: string }[]
    >`
      select s.style::text as style, s.treatment_key, s.internal_name, s.public_display_name
        from service s
       where s.published_at is not null
       order by s.display_order
    `
    expect(rows).toHaveLength(8)
    const vocabulary = new Set(catalogueVocabulary())

    for (const row of rows) {
      if (!isStyle(row.style) || !isTreatmentKey(row.treatment_key)) continue
      const code = categoryCodeFor({
        kind: 'service',
        style: row.style,
        treatmentKey: row.treatment_key,
      })
      const codeTokens = new Set(egressTokensOf(code))
      for (const name of [row.internal_name, row.public_display_name]) {
        const overlap = egressTokensOf(name).filter((token) => codeTokens.has(token))
        expect(
          overlap,
          `${code} shares ${overlap.join(', ')} with "${name}", so a reader of the wire can decode it`,
        ).toEqual([])
      }
      // The bridge that makes the core-side derivation honest: the words in the REAL names are the words
      // the enums supply, plus the declared joining word. Without this, `catalogueVocabulary()` could fall
      // behind the seeded names and the opacity assertions in core would be measuring the wrong vocabulary.
      for (const name of [row.internal_name, row.public_display_name]) {
        for (const token of egressTokensOf(name)) {
          expect(
            vocabulary.has(token) || JOINING_WORDS.has(token),
            `"${token}" is in the seeded name "${name}" and is neither a word catalogueVocabulary() ` +
              'derives from the enums nor a declared joining word, so the opacity detector in ' +
              'packages/core is measuring against an incomplete vocabulary',
          ).toBe(true)
        }
      }
      // And the control, because both loops above are satisfied by an empty token list: the names DO carry
      // tokens the closed egress vocabulary refuses, so a leaked name would be caught on the wire.
      expect(unpermittedEgressTokens(row.public_display_name).length).toBeGreaterThan(0)
    }
  })
})

describe('every seeded variant row has an opaque category code', () => {
  it('projects onto exactly the thirty-two enumerated variant refs, both directions', async () => {
    const rows = await sql<{ style: string; treatment_key: string; duration_minutes: number }[]>`
      select distinct s.style::text as style, s.treatment_key, v.duration_minutes
        from service_variant v
        join service s on s.id = v.service_id
       where s.published_at is not null
    `
    const projected: string[] = []
    for (const row of rows) {
      expect(
        isStyle(row.style) && isTreatmentKey(row.treatment_key) && isDuration(row.duration_minutes),
        `published variant '${row.style}/${row.treatment_key}/${row.duration_minutes}' has no category ` +
          'code: one of style, treatment key or duration is outside the enums the mapping is total over',
      ).toBe(true)
      if (!isStyle(row.style) || !isTreatmentKey(row.treatment_key)) continue
      if (!isDuration(row.duration_minutes)) continue
      projected.push(
        catalogueRefKey({
          kind: 'variant',
          style: row.style,
          treatmentKey: row.treatment_key,
          durationMinutes: row.duration_minutes,
        }),
      )
    }
    expect(sorted(projected)).toEqual(sorted(refsOfKind('variant').map(catalogueRefKey)))
    // The 32 price points of docs/13 §4, which is what `DOCS_13_PRICE_POINT_COUNT` seeds.
    expect(rows).toHaveLength(32)
  })
})

describe('every price-on-request row has an opaque category code', () => {
  it('projects on the footprint, not the label, and covers all three both ways', async () => {
    const rows = await sql<{ menu_label: string; shape: string | null; modelled_as: string }[]>`
      select menu_label, shape::text as shape, modelled_as::text as modelled_as
        from price_on_request
       order by menu_label
    `
    expect(rows).toHaveLength(3)

    const footprints: string[] = []
    for (const row of rows) {
      // `price_on_request_shape_matches_modelling` (migration 0032) makes these two the same fact, so the
      // projection is total and carries no name. Asserted rather than assumed: if the CHECK were dropped, a
      // row with both null would project to `not_modelled` while claiming to be modelled.
      expect(row.shape === null).toBe(row.modelled_as === 'not_modelled')
      const footprint = (row.shape ?? 'not_modelled') as PriceOnRequestFootprint
      expect(
        PRICE_ON_REQUEST_FOOTPRINTS as readonly string[],
        `price_on_request "${row.menu_label}" has footprint '${footprint}', which has no category code`,
      ).toContain(footprint)
      footprints.push(footprint)
    }
    // Injective over the rows: three rows, three distinct footprints. A fourth row sharing one would be two
    // offerings behind one code, and the symptom is a category that appears to convert twice as often.
    expect(new Set(footprints).size).toBe(rows.length)
    expect(sorted(footprints)).toEqual(sorted([...PRICE_ON_REQUEST_FOOTPRINTS]))

    // And the label never reaches a code. `Full Body Shaving` is the one whose words the enums do not
    // supply, which is exactly why the ref carries a footprint and not a label.
    for (const row of rows) {
      const code = categoryCodeFor({
        kind: 'price_on_request',
        footprint: (row.shape ?? 'not_modelled') as PriceOnRequestFootprint,
      })
      const codeTokens = new Set(egressTokensOf(code))
      expect(egressTokensOf(row.menu_label).filter((token) => codeTokens.has(token))).toEqual([])
      expect(unpermittedEgressTokens(row.menu_label).length).toBeGreaterThan(0)
    }
  })
})

describe('every package template has an opaque category code', () => {
  it('projects onto the one bundle category, and the key never travels', async () => {
    const rows = await sql<{ template_key: string }[]>`
      select template_key from package_template order by template_key
    `
    // At least one, or the assertion below passes over nothing (ADR 0002). The fixture salon seeds four.
    expect(rows.length).toBeGreaterThanOrEqual(1)

    const projected = new Set(rows.map(() => catalogueRefKey({ kind: 'package_template' })))
    expect([...projected]).toEqual(refsOfKind('package_template').map(catalogueRefKey))

    const { payload, dropped } = buildEgressPayload(
      { ref: { kind: 'package_template' }, eventType: 'paid', quantity: 1 },
      // Handed the row, which is what a dispatcher actually has. Every key of it is dropped and counted.
      { templateKey: rows[0]?.template_key ?? '' },
    )
    const serialised = serialiseEgressPayload(payload)
    expect(dropped.map((entry) => entry.field)).toEqual(['templateKey'])
    expect(unpermittedEgressTokens(serialised)).toEqual([])
    for (const row of rows) {
      expect(serialised).not.toContain(row.template_key)
    }
  })
})
