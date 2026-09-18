/**
 * The catalogue contract: what a service, a variant, a skill requirement and a resource shape are.
 *
 * These live in `shared` rather than in `db` or `core` because three packages need the same statement of
 * it: `db` writes the rows, `core` prices and schedules against them, and the admin routes validate what
 * an owner typed before either sees it. A type declared in `db` would pull the schema mirror into
 * `core`, which the boundary rules forbid and the dependency direction would not survive.
 *
 * Every constraint here has a counterpart in `packages/db/migrations/0017_catalogue.sql`, and that is the
 * point of the duplication, not an accident of it: zod refuses a bad value at the edge with a message a
 * person can read, and the database refuses it at the last possible moment with no way around it. Either
 * alone is a gap — an API route is bypassable by a psql session, and a CHECK violation reaches a customer
 * as a 500.
 */
import { z } from 'zod'

/**
 * Asian or Arabic, and it is an attribute of the **treatment** (ADR 0021, docs/01 decision 21).
 *
 * The obvious reading — a property of the therapist, because that is how a rota looks — is the one the
 * owner ruled out. A service is the pair `(style × treatment)`, which keeps price and therapist
 * assignment decoupled: reassigning a therapist cannot reprice a booking the customer was already quoted.
 */
export const TREATMENT_STYLES = ['asian', 'arabic'] as const
export type TreatmentStyle = (typeof TREATMENT_STYLES)[number]

/**
 * The four treatments on the menu (docs/13 §4).
 *
 * These exact keys are load-bearing: `service_room_type_compat` was seeded against them by B-CAT-02
 * before a `service` table existed, and the composite foreign key attached in 0017 matches on them. A
 * fifth key is a new treatment, a migration and a compatibility row — not a spelling variation.
 *
 * Four Hands and Couple Massage are deliberately **absent**: they are resource shapes of these
 * treatments, not treatments. See `SERVICE_SHAPES`.
 */
export const TREATMENT_KEYS = [
  'normal_massage',
  'hot_oil_balm_massage',
  'morocco_bath_jacuzzi',
  'massage_with_shaving',
] as const
export type TreatmentKey = (typeof TREATMENT_KEYS)[number]

/** The four bookable durations. Duration is the only pricing axis there is (ADR 0021). */
export const SERVICE_DURATIONS = [45, 60, 90, 120] as const
export type ServiceDuration = (typeof SERVICE_DURATIONS)[number]

/** Eligibility skills. A style maps to one of these; it never maps to a price. */
export const THERAPIST_SKILLS = ['asian_style', 'arabic_style'] as const
export type TherapistSkill = (typeof THERAPIST_SKILLS)[number]

/**
 * The resource footprint of one delivery.
 *
 * `four_hands` is two therapists over **one** client; `couple` is two therapists over **two** clients in
 * one room. Both are shapes of the treatments above, which is why the catalogue holds 8 services and not
 * 10 — and why `booking (1) → appointments (n)` is the shape of the booking container.
 */
export const SERVICE_SHAPES = ['solo', 'four_hands', 'couple'] as const
export type ServiceShape = (typeof SERVICE_SHAPES)[number]

/** The three kinds of treatment room. Mirrors the `room_type` enum B-CAT-02 created. */
export const ROOM_TYPE_NAMES = ['standard', 'couples', 'wet'] as const
export type RoomTypeName = (typeof ROOM_TYPE_NAMES)[number]

/**
 * What a style requires of whoever delivers it — and **nothing else**.
 *
 * The absence is the content. Decision 21 decouples pricing from therapist assignment, so the mapping
 * from style to skill must not be able to carry a price: a `grossPriceFils` reachable from here is all it
 * would take for one screen to read the price off the assignment path, and from then on reassigning a
 * therapist reprices the booking. `PriceFreeShape` below turns that from a convention into a type error.
 */
export interface ServiceSkillRequirement {
  readonly style: TreatmentStyle
  readonly requiredSkill: TherapistSkill
}

/**
 * Keys that look like money, in the spellings this codebase actually uses.
 *
 * Matched on the key rather than the value type, because the hazard is a *field that means a price*, and
 * a price smuggled in as a `string` or a branded `Money` would pass a value-type check.
 */
type PriceLikeKey<T> = Extract<
  keyof T,
  | `${string}price${string}`
  | `${string}Price${string}`
  | `${string}fils${string}`
  | `${string}Fils${string}`
  | `${string}amount${string}`
  | `${string}Amount${string}`
>

/**
 * `true` when `T` exposes no price-like field, `false` when it does.
 *
 * Used as a constraint — `Assert<PriceFreeShape<ServiceSkillRequirement>>` — so adding a price to the
 * skill-mapping type fails `pnpm typecheck` rather than review. The known-bad fixture in
 * `scripts/test-gates.mjs` adds one and asserts the compiler rejects it by message.
 */
export type PriceFreeShape<T> = [PriceLikeKey<T>] extends [never] ? true : false

/** Compile-time assertion helper: `Assert<X>` fails to typecheck unless `X` is exactly `true`. */
export type Assert<T extends true> = T

/**
 * Style → required skill, total over the style enum by construction.
 *
 * A `Record<TreatmentStyle, …>` rather than a lookup function with a default: adding a third style makes
 * this a compile error, where a function with a fall-back would quietly return the wrong skill and every
 * therapist would appear eligible for the new style.
 */
export const REQUIRED_SKILL_BY_STYLE: Readonly<Record<TreatmentStyle, TherapistSkill>> =
  Object.freeze({
    asian: 'asian_style',
    arabic: 'arabic_style',
  })

/** The skill a style requires. Total: every member of the enum has a row, checked by the type above. */
export function requiredSkillFor(style: TreatmentStyle): TherapistSkill {
  return REQUIRED_SKILL_BY_STYLE[style]
}

/** The mapping as rows, in enum order, for seeding and for asserting totality against `pg_enum`. */
export function skillRequirements(): readonly ServiceSkillRequirement[] {
  return TREATMENT_STYLES.map((style) => ({ style, requiredSkill: REQUIRED_SKILL_BY_STYLE[style] }))
}

export const treatmentStyleSchema = z.enum(TREATMENT_STYLES)
export const treatmentKeySchema = z.enum(TREATMENT_KEYS)
export const therapistSkillSchema = z.enum(THERAPIST_SKILLS)
export const serviceShapeSchema = z.enum(SERVICE_SHAPES)
export const roomTypeNameSchema = z.enum(ROOM_TYPE_NAMES)

/**
 * A bookable duration.
 *
 * A literal union, not `z.number().int().min(45)`: 50 minutes is not a shorter treatment, it is a
 * treatment with no price, because the price list has exactly four columns.
 */
export const serviceDurationSchema = z.union([
  z.literal(45),
  z.literal(60),
  z.literal(90),
  z.literal(120),
])

/**
 * VAT-inclusive gross, in integer fils (docs/01 decision 7).
 *
 * `int()` and `positive()` are both load-bearing, and each catches something the other does not:
 * `positive()` refuses 0 and any negative, `int()` refuses 250.5. The database refuses all four as well
 * (`service_variant_price_positive`, plus the `fils` domain's own input parsing) — the pair is the point.
 * Fils rather than dirhams because 0.05 of a dirham cannot be represented as a float, and VAT at 5 % on a
 * float base drifts by a fil per invoice until a return does not balance.
 */
export const grossPriceFilsSchema = z
  .number()
  .int('A price is whole fils — 250.5 fils is not an amount of money.')
  .positive('A price must be greater than zero. Zero is a missing price, not a free treatment.')

export const serviceSchema = z.object({
  style: treatmentStyleSchema,
  treatmentKey: treatmentKeySchema,
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'A slug is lower-case words joined by single hyphens.'),
  /** Unconstrained beyond being a name: the front desk's own words are not a compliance surface. */
  internalName: z.string().trim().min(1),
  /** B-CAT-05 additionally lints this against the banned-claims lexicon from `regulatory_profile`. */
  publicDisplayName: z.string().trim().min(1),
  /** Minutes the ROOM is held after the treatment. Never the therapist buffer. */
  turnaroundMinutes: z.number().int().min(0).max(240),
})
export type ServiceInput = z.infer<typeof serviceSchema>

export const serviceVariantSchema = z.object({
  durationMinutes: serviceDurationSchema,
  grossPriceFils: grossPriceFilsSchema,
})
export type ServiceVariantInput = z.infer<typeof serviceVariantSchema>

/**
 * A resource footprint, with the two shape rules the database also enforces.
 *
 * The refinements are not belt-and-braces. A `couple` shape that fits in a capacity-1 room puts two
 * clients in a single room, and a `four_hands` shape with one therapist cannot deliver what it is named
 * after — both are rows that look valid and produce a booking nobody can work.
 */
export const serviceResourceShapeSchema = z
  .object({
    shape: serviceShapeSchema,
    therapistsRequired: z.number().int().min(1).max(4),
    roomsRequired: z.number().int().min(1).max(4),
    /**
     * Clients the room must hold — not derivable from `therapistsRequired`. Four Hands is two therapists
     * over one client, so its minimum capacity is 1 while Couple Massage's is 2.
     */
    minRoomCapacity: z.number().int().min(1).max(4),
    /** `undefined` means any type the service's compatibility rows allow; a value narrows them. */
    requiredRoomType: roomTypeNameSchema.optional(),
    /** Minutes protecting the THERAPIST either side. Distinct resource, distinct duration. */
    therapistBufferMinutes: z.number().int().min(0).max(60),
  })
  .refine((shape) => shape.shape !== 'couple' || shape.minRoomCapacity >= 2, {
    message: 'A couple shape needs a room that holds two clients.',
    path: ['minRoomCapacity'],
  })
  .refine((shape) => shape.shape !== 'four_hands' || shape.therapistsRequired >= 2, {
    message: 'A four-hands shape needs two therapists.',
    path: ['therapistsRequired'],
  })
export type ServiceResourceShapeInput = z.infer<typeof serviceResourceShapeSchema>

/**
 * The skill mapping carries no price, and this line is what makes that a compile error.
 *
 * Exported so the gate fixture can extend the interface with a price field and watch `tsc` reject the
 * same assertion — a type-level test whose control is a real compiler failure, not a comment.
 */
export type SkillMappingCarriesNoPrice = Assert<PriceFreeShape<ServiceSkillRequirement>>
