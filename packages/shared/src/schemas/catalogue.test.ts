import { describe, expect, it } from 'vitest'
import {
  grossPriceFilsSchema,
  type PriceFreeShape,
  REQUIRED_SKILL_BY_STYLE,
  requiredSkillFor,
  SERVICE_DURATIONS,
  type ServiceSkillRequirement,
  type SkillMappingCarriesNoPrice,
  serviceDurationSchema,
  serviceResourceShapeSchema,
  serviceSchema,
  serviceVariantSchema,
  skillRequirements,
  THERAPIST_SKILLS,
  TREATMENT_KEYS,
  TREATMENT_STYLES,
} from './catalogue.ts'

/**
 * B-CAT-03 — the catalogue contract, asserted where it can be asserted without a database.
 *
 * The database half of every rule here is asserted against real PostgreSQL in
 * `packages/db/src/schema/catalogue.itest.ts`. Both halves exist on purpose: zod is what a route uses to
 * refuse a bad value with a readable message, and the CHECK constraint is what refuses it when the route
 * is bypassed. A test for one is not a test for the other, so the price cases below are deliberately the
 * same four cases the integration test runs — zero, negative, non-integer, missing.
 */

describe('acceptance — the treatment keys are the four B-CAT-02 seeded compatibility rows against', () => {
  it('holds exactly those four keys, in the exact spellings the compatibility rows use', () => {
    // These strings are a foreign key. `service_room_type_compat` was seeded against them before a
    // `service` table existed, and 0017's composite FK matches on them: a renamed key here is not a
    // rename, it is a service with no compatible rooms and a migration that will not apply.
    expect([...TREATMENT_KEYS]).toEqual([
      'normal_massage',
      'hot_oil_balm_massage',
      'morocco_bath_jacuzzi',
      'massage_with_shaving',
    ])
  })

  it('does not treat Four Hands or Couple Massage as treatments', () => {
    // docs/13 section 4 lists them beside the four treatments, which is the trap this assertion exists
    // for: they are resource SHAPES of these treatments. A fifth key would multiply the styles and
    // durations they share with their parent and would have no compatibility row to stand on.
    const keys: readonly string[] = TREATMENT_KEYS
    expect(keys).not.toContain('four_hands')
    expect(keys).not.toContain('couple_massage')
    // The control: the shape names DO exist, as shapes, so the absence above is a decision and not an
    // omission.
    expect(
      serviceResourceShapeSchema.safeParse(
        shapeInput({ shape: 'four_hands', therapistsRequired: 2 }),
      ).success,
    ).toBe(true)
  })

  it('makes 8 services out of 4 treatments and 2 styles', () => {
    expect(TREATMENT_KEYS.length * TREATMENT_STYLES.length).toBe(8)
    // 32 price points: 8 services x 4 durations (ADR 0021). The number the seed in B-CAT-06 must produce.
    expect(TREATMENT_KEYS.length * TREATMENT_STYLES.length * SERVICE_DURATIONS.length).toBe(32)
  })
})

describe('acceptance — duration is one of 45, 60, 90, 120', () => {
  for (const duration of SERVICE_DURATIONS) {
    it(`accepts ${duration} minutes`, () => {
      expect(serviceDurationSchema.safeParse(duration).success).toBe(true)
    })
  }

  // The controls. 50 minutes is not a shorter treatment; it is a treatment with no price, because the
  // price list has exactly four columns.
  for (const bad of [0, 30, 50, 75, 121, 45.5, -60]) {
    it(`rejects ${bad}`, () => {
      expect(serviceDurationSchema.safeParse(bad).success).toBe(false)
    })
  }
})

describe('acceptance — gross_price_fils is a positive integer, four ways', () => {
  it('accepts a real price, so the rejections below are not a schema that refuses everything', () => {
    // AED 250.00 VAT-inclusive, which is the Asian 60-minute hot oil price from docs/13 section 4.
    expect(grossPriceFilsSchema.safeParse(25_000)).toMatchObject({ success: true, data: 25_000 })
  })

  const rejected: readonly [string, unknown][] = [
    ['zero', 0],
    ['negative', -25_000],
    ['non-integer', 250.5],
    ['missing', undefined],
  ]

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(grossPriceFilsSchema.safeParse(value).success).toBe(false)
    })
  }

  it('rejects zero for being zero and 250.5 for being fractional, not for some shared reason', () => {
    // Asserting on the issue codes, not merely on failure: a schema that had lost `.int()` would still
    // reject 0, and this suite would stay green while fractional fils became storable.
    const zero = grossPriceFilsSchema.safeParse(0)
    const fractional = grossPriceFilsSchema.safeParse(250.5)
    expect(zero.success).toBe(false)
    expect(fractional.success).toBe(false)
    expect(zero.error?.issues.map((issue) => issue.code)).toContain('too_small')
    expect(fractional.error?.issues.map((issue) => issue.code)).toContain('invalid_type')
  })

  it('refuses a fractional price inside a whole variant, not only in isolation', () => {
    const variant = serviceVariantSchema.safeParse({ durationMinutes: 60, grossPriceFils: 250.5 })
    expect(variant.success).toBe(false)
    expect(
      serviceVariantSchema.safeParse({ durationMinutes: 60, grossPriceFils: 25_000 }).success,
    ).toBe(true)
  })
})

describe('acceptance — service_skill is total over the style enum', () => {
  it('maps every style, with no style left over and no skill invented', () => {
    // Exhaustiveness over the enum, asserted by iterating the enum rather than by listing the pairs: a
    // third style would fail here (and would already have failed `tsc`, because the mapping is a
    // Record over the union).
    for (const style of TREATMENT_STYLES) {
      expect(THERAPIST_SKILLS).toContain(requiredSkillFor(style))
    }
    expect(Object.keys(REQUIRED_SKILL_BY_STYLE)).toHaveLength(TREATMENT_STYLES.length)
    expect(requiredSkillFor('asian')).toBe('asian_style')
    expect(requiredSkillFor('arabic')).toBe('arabic_style')
  })

  it('is a bijection, so one skill cannot serve both styles', () => {
    // A single skill covering both styles is the "style is really a therapist attribute" model creeping
    // back in through the mapping: every therapist would be eligible for everything.
    const skills = skillRequirements().map((requirement) => requirement.requiredSkill)
    expect(new Set(skills).size).toBe(skills.length)
    expect(skillRequirements()).toEqual([
      { style: 'asian', requiredSkill: 'asian_style' },
      { style: 'arabic', requiredSkill: 'arabic_style' },
    ])
  })

  it('exposes no price field, at the type level, and detects one when it is there', () => {
    // Decision 21 decouples pricing from therapist assignment. The type-level guard is the part that
    // survives a refactor: a `grossPriceFils` reachable from the skill mapping is all it takes for one
    // screen to read the price off the assignment path, after which reassigning a therapist reprices a
    // booking the customer was already quoted.
    const priceFree: SkillMappingCarriesNoPrice = true
    expect(priceFree).toBe(true)

    // The control, and the reason the line above is worth anything: a shape that DOES carry a price
    // resolves to `false`. If `PriceFreeShape` ever stopped matching a price-like key, this assignment
    // would not compile, and `pnpm typecheck` would fail rather than this file passing vacuously.
    const detected: PriceFreeShape<{ readonly grossPriceFils: number }> = false
    expect(detected).toBe(false)

    // Spelled three ways, because the hazard is the field's meaning and not its casing.
    const snake: PriceFreeShape<{ readonly gross_price_fils: number }> = false
    const amount: PriceFreeShape<{ readonly amountFils: string }> = false
    expect([snake, amount]).toEqual([false, false])

    const requirement: ServiceSkillRequirement = { style: 'asian', requiredSkill: 'asian_style' }
    expect(Object.keys(requirement)).toEqual(['style', 'requiredSkill'])
  })
})

describe('acceptance — a resource shape states its own resources', () => {
  it('accepts Four Hands: two therapists, one standard room, one client', () => {
    // Two therapists over ONE client, which is why min capacity is 1 and cannot be derived from the
    // therapist count.
    const parsed = serviceResourceShapeSchema.safeParse(
      shapeInput({ shape: 'four_hands', therapistsRequired: 2, minRoomCapacity: 1 }),
    )
    expect(parsed.success).toBe(true)
  })

  it('accepts Couple Massage: two therapists, one double-capacity room, two clients', () => {
    const parsed = serviceResourceShapeSchema.safeParse(
      shapeInput({
        shape: 'couple',
        therapistsRequired: 2,
        minRoomCapacity: 2,
        requiredRoomType: 'couples',
      }),
    )
    expect(parsed.success).toBe(true)
  })

  it('refuses a couple shape that fits in a single room', () => {
    // Two clients in a capacity-1 room. The database refuses it too
    // (`service_resource_shape_couple_holds_two`); this is the half that gives the admin a sentence.
    const parsed = serviceResourceShapeSchema.safeParse(
      shapeInput({ shape: 'couple', therapistsRequired: 2, minRoomCapacity: 1 }),
    )
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain('holds two clients')
  })

  it('refuses a four-hands shape with one therapist', () => {
    const parsed = serviceResourceShapeSchema.safeParse(
      shapeInput({ shape: 'four_hands', therapistsRequired: 1 }),
    )
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues[0]?.message).toContain('two therapists')
  })

  it('treats the therapist buffer as its own bounded number', () => {
    expect(
      serviceResourceShapeSchema.safeParse(shapeInput({ therapistBufferMinutes: 0 })).success,
    ).toBe(true)
    expect(
      serviceResourceShapeSchema.safeParse(shapeInput({ therapistBufferMinutes: 61 })).success,
    ).toBe(false)
    expect(
      serviceResourceShapeSchema.safeParse(shapeInput({ therapistBufferMinutes: 10.5 })).success,
    ).toBe(false)
  })

  it('leaves the room type optional, because absent means "any compatible room"', () => {
    const parsed = serviceResourceShapeSchema.safeParse(shapeInput({}))
    expect(parsed.success).toBe(true)
    expect(parsed.data?.requiredRoomType).toBeUndefined()
    expect(
      serviceResourceShapeSchema.safeParse(shapeInput({ requiredRoomType: 'sauna' })).success,
    ).toBe(false)
  })
})

describe('acceptance — the internal name is unconstrained and the public one is not the same field', () => {
  it('accepts a claim-laden internal name that B-CAT-05 will refuse as a public name', () => {
    // The front desk's own words are not a compliance surface. The banned-claims lexicon applies to the
    // PUBLIC name only (B-CAT-05), and the two must therefore be two columns: one field serving both
    // forces the lint onto the internal label or drops it from the customer-facing one.
    const parsed = serviceSchema.safeParse({
      style: 'asian',
      treatmentKey: 'normal_massage',
      slug: 'asian-normal-massage',
      internalName: 'Therapeutic Deep Tissue Treatment',
      publicDisplayName: 'Normal Massage (Asian)',
      turnaroundMinutes: 20,
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses an empty name of either kind, and a slug that is not a slug', () => {
    const base = {
      style: 'asian' as const,
      treatmentKey: 'normal_massage' as const,
      slug: 'asian-normal-massage',
      internalName: 'Asian Normal Massage',
      publicDisplayName: 'Normal Massage (Asian)',
      turnaroundMinutes: 20,
    }
    expect(serviceSchema.safeParse({ ...base, internalName: '   ' }).success).toBe(false)
    expect(serviceSchema.safeParse({ ...base, publicDisplayName: '' }).success).toBe(false)
    expect(serviceSchema.safeParse({ ...base, slug: 'Asian Normal Massage' }).success).toBe(false)
    expect(serviceSchema.safeParse({ ...base, turnaroundMinutes: 241 }).success).toBe(false)
    // Zero turnaround is legal: a treatment needing no room reset is a possible answer, and rejecting it
    // would make the bound a policy rather than a sanity check.
    expect(serviceSchema.safeParse({ ...base, turnaroundMinutes: 0 }).success).toBe(true)
  })
})

/** A valid solo shape, with the one field under test overridden. */
function shapeInput(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    shape: 'solo',
    therapistsRequired: 1,
    roomsRequired: 1,
    minRoomCapacity: 1,
    therapistBufferMinutes: 10,
    ...overrides,
  }
}
