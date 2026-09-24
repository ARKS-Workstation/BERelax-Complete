import type { Sql } from '../connection.ts'
import { type SuppressionPeppers, suppressionKey } from '../repositories/suppression.ts'

/**
 * The fixture salon's suppression list (C-CRM-04).
 *
 * One entry per source, so the fixture demonstrates every mechanism the enum names rather than five rows
 * that all say `manual`, plus one key that was suppressed and then lifted — because "removing somebody is
 * a new row" is only visible in a fixture that contains both rows for one key.
 *
 * ## Why the recipients are an argument, and why they arrive NORMALISED
 *
 * `packages/db` may not import `packages/fixtures`, and two guarantees live there: that a fixture phone
 * number sits on the unallocated `+971 59` prefix and cannot ring anybody (`assertSynthetic`), and that an
 * address is on the unroutable `fixture.invalid` domain. `packages/db` also may not import
 * `packages/core`, so it cannot normalise a recipient either — `normaliseBlocklistKey` is core's and
 * there is deliberately no second copy of it anywhere.
 *
 * So this module takes values that are ALREADY normalised and hashes them. That is not a hole: the loader
 * builds them with `syntheticPerson`, which produces canonical E.164 and a lower-cased address by
 * construction, and `packages/fixtures/src/suppression.itest.ts` asserts that the keys this seed wrote are
 * the keys the repository's own keying produces for the same recipients — which is the only assertion that
 * could catch a seeded key nothing will ever match. A key computed from an un-normalised value is the one
 * defect in this area with no database-side backstop, because the plaintext never reaches a column for a
 * CHECK to look at.
 *
 * ## The pepper is an argument too
 *
 * The seed does not read the environment. `packages/fixtures` resolves the pepper — the configured one
 * when there is one, and a visibly-labelled fixture pair otherwise — and every row records which through
 * `pepper_version`, so a row keyed under a fixture pepper says so out loud in the column that exists for
 * exactly that purpose.
 */

/** What a seeded entry demonstrates. */
export const SUPPRESSION_SEED_STATES = [
  /** On the list. The state a send must be refused for. */
  'suppressed',
  /** Suppressed and then lifted, so the log holds both rows and the first is untouched. */
  'lifted',
] as const
export type SuppressionSeedState = (typeof SUPPRESSION_SEED_STATES)[number]

export interface SuppressionSeedEntry {
  readonly keyKind: 'phone' | 'email'
  /** Already normalised: canonical E.164, or a lower-cased address. See the header. */
  readonly recipient: string
  readonly source: string
  readonly state: SuppressionSeedState
  readonly reason: string
  readonly actorKind: 'customer' | 'staff' | 'system'
  readonly actorLabel: string
  /** The contact the entry is about, when the fixture knows one. Never matched on. */
  readonly contactCustomerId: string | null
}

export interface SuppressionSeedInput {
  readonly entries: readonly SuppressionSeedEntry[]
  readonly peppers: SuppressionPeppers
  /**
   * The frozen instant every seeded row is stamped with, as ISO-8601.
   *
   * Supplied rather than `now()`, and the reason is idempotence rather than taste: `pnpm seed` run twice
   * from clean has to produce the same rows, and `suppression_one_record_per_instant` is what makes the
   * second run a no-op. With `now()` the second run would insert a second, differently-timed suppression
   * for every key — and two suppressions at different instants is a log, not a duplicate, so nothing
   * would report it.
   */
  readonly recordedAtIso: string
}

export interface SuppressionSeedResult {
  readonly suppressions: number
  readonly lifts: number
}

/**
 * Writes the fixture suppressions. Idempotent.
 *
 * A direct INSERT rather than `recordSuppression`, for the reason `seedConsent` gives: a seed has no
 * actor and no request, so a unit of work would have to invent one and the audit row it wrote would claim
 * a person made a decision that a migration made. Every CHECK, every enum and the append-only triggers
 * apply to these rows exactly as they apply to a real capture, which is what makes the seed a test of the
 * schema rather than a way round it.
 */
export async function seedSuppression(
  sql: Sql,
  input: SuppressionSeedInput,
): Promise<SuppressionSeedResult> {
  let suppressions = 0
  let lifts = 0

  for (const entry of input.entries) {
    const key = suppressionKey(input.peppers.current, entry.keyKind, entry.recipient)
    suppressions += await insertSeedSuppression(sql, {
      key,
      version: input.peppers.current.version,
      entry,
      kind: 'suppressed',
      recordedAtIso: input.recordedAtIso,
      reason: entry.reason,
      source: entry.source,
      actorKind: entry.actorKind,
    })

    if (entry.state !== 'lifted') continue
    // A SECOND row, one minute later, and the suppressing row above is left exactly as it is. That
    // ordering is the whole point: a lifted key's log still contains the suppression, which is what proves
    // the lift was a new record rather than an edit. The source becomes `manual`, because a lift needs a
    // decision behind it and the seeded suppression it lifts came from a hard bounce — which is an event
    // that happened and cannot un-happen (`suppression_unsuppression_has_a_decision_behind_it`).
    lifts += await insertSeedSuppression(sql, {
      key,
      version: input.peppers.current.version,
      entry,
      kind: 'unsuppressed',
      recordedAtIso: oneMinuteAfter(input.recordedAtIso),
      reason: 'Address confirmed deliverable again; the bounce was a provider outage.',
      source: 'manual',
      actorKind: 'staff',
    })
  }

  return { suppressions, lifts }
}

async function insertSeedSuppression(
  sql: Sql,
  args: {
    readonly key: string
    readonly version: string
    readonly entry: SuppressionSeedEntry
    readonly kind: 'suppressed' | 'unsuppressed'
    readonly recordedAtIso: string
    readonly reason: string
    readonly source: string
    readonly actorKind: 'customer' | 'staff' | 'system'
  },
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    insert into suppression
      (key_kind, key_hmac, pepper_version, kind, source, reason, actor_kind, actor_label, recorded_at,
       contact_customer_id)
    values (
      ${args.entry.keyKind}, ${args.key}, ${args.version}, ${args.kind}::suppression_kind,
      ${args.source}::suppression_source, ${args.reason}, ${args.actorKind}, ${args.entry.actorLabel},
      ${args.recordedAtIso}::timestamptz, ${args.entry.contactCustomerId}
    )
    on conflict (key_kind, key_hmac, kind, recorded_at) do nothing
    returning id
  `
  return rows.length
}

/** One minute later, as ISO. Enough to order the lift after the suppression with no ambiguity. */
function oneMinuteAfter(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new Error(`The suppression seed was given an unparseable instant: ${iso}`)
  }
  return new Date(ms + 60_000).toISOString()
}
