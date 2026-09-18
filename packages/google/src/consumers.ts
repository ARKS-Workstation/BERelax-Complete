import {
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type GoogleCapability,
  type GoogleRequestedScope,
} from '@berelax/core'
import { AppError } from '@berelax/shared'

/**
 * The CONSUMERS table from docs/10 §2 — the only place a consumer says what it needs.
 *
 * ## Why the degraded mode lives here and not at the call site
 *
 * A consumer that decided its own degraded mode where it calls `withGoogle` would mean two places to
 * change when the answer changes: the table everyone reads and the branch in production. The one nobody
 * updates is the one in production, and the symptom is the review autoresponder going silent — which is
 * indistinguishable from "no reviews arrived" — when it was supposed to fall back to drafting.
 *
 * So `withGoogle` takes a capability, looks the declaration up here, and the consumer does not get a
 * vote. Adding a consumer is a row in this table; changing what one degrades to is an edit to that row.
 *
 * ## Why the capability parameter is typed from the table
 *
 * `DeclaredCapability` is derived from the table's contents, so `withGoogle('gbp_performance')` is a
 * **compile error** until a consumer declares that it needs it. That is the strongest available form of
 * "the table is the only place a consumer names what it needs": a capability nobody has declared has no
 * declared degraded mode either, and the alternative to a compile error is inventing one at the call
 * site, which is the thing this file exists to prevent.
 */

/**
 * What a consumer does when Google is unavailable to it. Three modes, and they are not interchangeable.
 *
 * - `draft_only` — the review autoresponder keeps drafting replies for the owner to post by hand. docs/10
 *   §6 measures this at 70–80% of the value, because the bottleneck was never the posting.
 * - `disabled` — the SEO agent has nothing to work from. Search Console data has no manual substitute, and
 *   a report built from no data is worse than no report.
 * - `manual_snapshot` — the GBP-versus-website consistency check falls back to the last snapshot a human
 *   confirmed, and says how old it is.
 */
export type DegradedMode = 'draft_only' | 'disabled' | 'manual_snapshot'

export interface ConsumerDeclaration {
  readonly capability: GoogleCapability
  /**
   * The scopes this consumer's capability needs.
   *
   * Typed `GoogleRequestedScope`, so a consumer cannot declare a need for a scope the consent screen is
   * forbidden from requesting (G-CONN-02 closed that set with the type system rather than with a test).
   */
  readonly scopes: readonly GoogleRequestedScope[]
  readonly degradesTo: DegradedMode
}

export const CONSUMERS = {
  reviewAutoresponder: {
    capability: 'gbp_reviews',
    scopes: [GOOGLE_SCOPE_BUSINESS_MANAGE],
    degradesTo: 'draft_only',
  },
  seoAgent: {
    capability: 'gsc',
    scopes: [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
    degradesTo: 'disabled',
  },
  localSeoChecker: {
    capability: 'gbp_location',
    scopes: [GOOGLE_SCOPE_BUSINESS_MANAGE],
    degradesTo: 'manual_snapshot',
  },
} as const satisfies Readonly<Record<string, ConsumerDeclaration>>

export type GoogleConsumer = keyof typeof CONSUMERS

/** The capabilities some consumer has declared. Widens automatically when a row is added above. */
export type DeclaredCapability = (typeof CONSUMERS)[GoogleConsumer]['capability']

export interface CapabilityDeclaration extends ConsumerDeclaration {
  readonly consumer: GoogleConsumer
}

/**
 * Inverts the table, refusing an ambiguous inversion.
 *
 * Two consumers declaring the same capability with different degraded modes would make
 * `withGoogle('gbp_reviews')` resolve to whichever row the object happened to enumerate first — a value
 * that would change under a rename. Refusing it is the point: the second consumer of a capability is a
 * design decision (which mode wins?), not an accident to be resolved by iteration order.
 *
 * Takes the table as an argument so the refusal itself is testable. A guard that cannot be shown to fire
 * is not a guard.
 */
export function indexByCapability(
  consumers: Readonly<Record<string, ConsumerDeclaration>>,
): ReadonlyMap<GoogleCapability, CapabilityDeclaration> {
  const index = new Map<GoogleCapability, CapabilityDeclaration>()
  for (const [consumer, declaration] of Object.entries(consumers)) {
    const existing = index.get(declaration.capability)
    if (existing !== undefined) {
      throw new AppError(
        'invariant_violated',
        `${existing.consumer} and ${consumer} both declare the ${declaration.capability} capability. ` +
          'One capability has one declared degraded mode, or withGoogle resolves by enumeration order.',
      )
    }
    index.set(declaration.capability, { ...declaration, consumer: consumer as GoogleConsumer })
  }
  return index
}

const BY_CAPABILITY = indexByCapability(CONSUMERS)

/**
 * The declaration for a capability.
 *
 * Throws rather than returning undefined for an undeclared capability, and the throw is unreachable from
 * typed code: `DeclaredCapability` excludes it at compile time. It exists for a capability that arrived
 * as data — a string from a database row — where the type system has nothing to say.
 */
export function declarationFor(capability: GoogleCapability): CapabilityDeclaration {
  const declaration = BY_CAPABILITY.get(capability)
  if (declaration === undefined) {
    throw new AppError(
      'invariant_violated',
      `No consumer declares the ${capability} capability, so nothing declares what it degrades to. ` +
        'Add a row to CONSUMERS in packages/google/src/consumers.ts (docs/10 §2).',
    )
  }
  return declaration
}

/** True for a capability some consumer has declared. For narrowing a capability that arrived as data. */
export function isDeclaredCapability(
  capability: GoogleCapability,
): capability is DeclaredCapability {
  return BY_CAPABILITY.has(capability)
}
