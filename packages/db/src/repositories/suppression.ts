import { createHash, createHmac, randomBytes } from 'node:crypto'
import {
  AppError,
  SEND_GATING_CONSENT_PURPOSES,
  type SuppressionEntryInput,
  suppressionEntrySchema,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'
import { readCurrentConsentWording, recordConsent, withdrawConsent } from './consent.ts'

/**
 * The suppression list's writes and reads, and the opt-out token service (C-CRM-04), over 0064.
 *
 * ## Nothing here updates a suppression, and nothing here stores a recipient
 *
 * There is no `liftSuppression(id)` that sets a column. {@link unsuppressKey} INSERTs a row with
 * `kind: 'unsuppressed'`; the database refuses the alternative for every role including the owner
 * (ZQ001), so a method that tried would raise rather than silently succeed — but the shape of this module
 * is what stops anybody writing one.
 *
 * And no column anywhere in 0064 holds a phone number or an address. {@link suppressionKey} is the only
 * thing that produces what goes in `suppression.key_hmac`, and what it produces is
 * HMAC-SHA256(kind ∥ US ∥ normalised recipient) under the server-side pepper. The plaintext exists as a
 * query PARAMETER on the way in and in the message being sent; it never lands in a row, which is what
 * makes a database dump useless for answering "who has unsubscribed".
 *
 * ## Two decisions arrive as injected functions, because `packages/db` may not import `packages/core`
 *
 * The dependency runs core ← db, so the same seam `crm.ts` uses for `BlocklistMatcher` is used twice
 * here, and in both cases the permissive version is the dangerous one:
 *
 *   - **{@link SuppressionKeyNormaliser}** — `normaliseBlocklistKey` from `@berelax/core`. There is
 *     deliberately no fallback and no regex of its own in this file. An un-normalised value hashes to a
 *     key nothing will ever match, and because the plaintext never reaches a column there is **no
 *     constraint that could catch it**: the row would be accepted, look perfectly valid, and silently
 *     suppress nobody. That is the one failure mode in this unit with no database-side backstop, which is
 *     why a missing normaliser is refused by name rather than defaulted.
 *   - **{@link OptOutDecider}** — `decideOptOutAccess` from `@berelax/core`. A token verifier that
 *     defaulted to "granted" when nothing decided would hand somebody else's preference page to anybody
 *     who asked.
 *
 * ## The pepper is loaded once and passed, never read here
 *
 * {@link loadSuppressionPeppers} takes a record and returns the pair; it does not read `process.env`
 * itself, so a test can hand it a literal and the refusals below are reachable. Reads consult the current
 * pepper AND the retired one, which is what makes a rotation seamless — see
 * `docs/runbooks/key-rotation.md#rotating-the-suppression-pepper` for what a rotation can and cannot
 * recover, because the answer is "less than you would assume" and it is a consequence of the table
 * holding no plaintext rather than an oversight.
 */

// ------------------------------------------------------------------------------------------------
// Refusals
// ------------------------------------------------------------------------------------------------

/** Every reason a suppression or token write is refused, as a value. Callers branch on these. */
export const SUPPRESSION_REFUSALS = [
  /** The zod contract rejected the entry. `details.issues` carries what it said. */
  'suppression_entry_invalid',
  /** No normaliser was injected, so nothing produced a comparable key. Fail closed. */
  'suppression_key_not_normalised',
  /** The normaliser refused the value. `details.reason` carries its own named refusal. */
  'suppression_key_not_keyable',
  /** No pepper is configured, so no key can be computed at all. */
  'suppression_pepper_absent',
  /** No decider was injected for a token verification. Fail closed. */
  'optout_not_decided',
  /** A revoke names a grant that is not there. A second revoke is an error, not a no-op. */
  'optout_grant_not_found',
  /** A resubscribe needs the wording it is being given under, and no version is published. */
  'preference_centre_wording_absent',
] as const
export type SuppressionRefusal = (typeof SUPPRESSION_REFUSALS)[number]

/** SQLSTATEs 0064 raises, so a caller can tell an append-only refusal from any other conflict. */
export const SUPPRESSION_SQLSTATE = { suppressionImmutable: 'ZQ001' } as const

function refuse(
  refusal: SuppressionRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  const validation =
    refusal === 'suppression_entry_invalid' || refusal === 'suppression_key_not_keyable'
  throw new AppError(validation ? 'validation' : 'conflict', message, {
    userFacing: validation,
    details: { ...details, refusal },
  })
}

/** The named refusal carried on an error this module raised, or null. */
export function suppressionRefusalOf(err: unknown): SuppressionRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' &&
    (SUPPRESSION_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as SuppressionRefusal)
    : null
}

/** Audit actions this module writes. Named constants, so a caller can count a delta on one. */
export const SUPPRESSION_AUDIT_ACTIONS = {
  recorded: 'suppression.recorded',
  lifted: 'suppression.lifted',
  grantIssued: 'optout_grant.issued',
  grantRevoked: 'optout_grant.revoked',
  tokenRedeemed: 'optout_grant.redeemed',
  preferenceChanged: 'preference_centre.changed',
} as const

// ------------------------------------------------------------------------------------------------
// The pepper
// ------------------------------------------------------------------------------------------------

export interface SuppressionPepper {
  /** The label stored on every row keyed under it. Never the secret. */
  readonly version: string
  readonly secret: string
}

export interface SuppressionPeppers {
  readonly current: SuppressionPepper
  /** The retired pepper, retained so rows keyed under it stay matchable. Null when none is configured. */
  readonly retired: SuppressionPepper | null
}

/**
 * The shortest pepper this system will accept.
 *
 * 32 characters. `.env.example` generates 44 (32 random bytes in base64), so the only value this refuses
 * is one somebody typed — and a typed pepper is a guessable pepper, which makes the digests it produces
 * reversible by the same enumeration the pepper exists to stop. Refused rather than warned about,
 * because a warning about a secret is a warning nobody sees.
 */
export const MIN_SUPPRESSION_PEPPER_LENGTH = 32

/** The four names, exactly as `packages/config/src/env.ts` declares them. */
export interface SuppressionPepperEnv {
  readonly SUPPRESSION_PEPPER?: string | undefined
  readonly SUPPRESSION_PEPPER_VERSION?: string | undefined
  readonly SUPPRESSION_PEPPER_PREVIOUS?: string | undefined
  readonly SUPPRESSION_PEPPER_PREVIOUS_VERSION?: string | undefined
}

/**
 * Loads the pepper pair, refusing loudly and by name when it cannot.
 *
 * Takes a record rather than reading the environment, so the refusals are reachable from a test and so
 * `packages/config` stays the one place that parses `process.env`. Every refusal here is a
 * `configuration` fault and none of them is recoverable at run time: a send path that carried on without
 * a pepper would compute keys under an empty one, match nothing, and send to everybody who had opted out.
 *
 * The retired slot is whole or absent. Half of it — a secret with no label, or a label with no secret —
 * is what a half-finished rotation looks like, and the version label is what `suppression.pepper_version`
 * records, so a retired secret with no label could never be attributed to the rows it keyed.
 */
export function loadSuppressionPeppers(env: SuppressionPepperEnv): SuppressionPeppers {
  const secret = env.SUPPRESSION_PEPPER ?? ''
  const version = env.SUPPRESSION_PEPPER_VERSION ?? ''
  if (secret.trim() === '' || version.trim() === '') {
    refuse(
      'suppression_pepper_absent',
      'SUPPRESSION_PEPPER and SUPPRESSION_PEPPER_VERSION are both required before the suppression list ' +
        'can be read or written. Without the pepper the stored digests would be reversible by ' +
        'enumeration (the UAE mobile space is about ten million numbers per prefix), and without the ' +
        'version label a row could not be attributed to the pepper that keyed it. See ' +
        'docs/runbooks/key-rotation.md#rotating-the-suppression-pepper.',
      { haveSecret: secret.trim() !== '', haveVersion: version.trim() !== '' },
    )
  }
  if (secret.length < MIN_SUPPRESSION_PEPPER_LENGTH) {
    refuse(
      'suppression_pepper_absent',
      `SUPPRESSION_PEPPER is ${secret.length} characters and must be at least ` +
        `${MIN_SUPPRESSION_PEPPER_LENGTH}. .env.example generates 44 (32 random bytes in base64); the ` +
        'only value this refuses is one somebody typed, and a typed pepper is a guessable one.',
      { length: secret.length },
    )
  }

  const retiredSecret = env.SUPPRESSION_PEPPER_PREVIOUS ?? ''
  const retiredVersion = env.SUPPRESSION_PEPPER_PREVIOUS_VERSION ?? ''
  const retiredHalf = (retiredSecret.trim() === '') !== (retiredVersion.trim() === '')
  if (retiredHalf) {
    refuse(
      'suppression_pepper_absent',
      'SUPPRESSION_PEPPER_PREVIOUS and SUPPRESSION_PEPPER_PREVIOUS_VERSION are one fact said twice: ' +
        'supply both or neither. Half of the pair is what a rotation that was interrupted looks like, ' +
        'and a retired secret with no label cannot be attributed to the rows it keyed.',
      { haveSecret: retiredSecret.trim() !== '', haveVersion: retiredVersion.trim() !== '' },
    )
  }
  if (retiredSecret.trim() !== '' && retiredVersion.trim() === version.trim()) {
    refuse(
      'suppression_pepper_absent',
      `The retired pepper carries the same version label as the current one ('${version}'). The label ` +
        'is how a row says which pepper keyed it, so two peppers under one label makes every row ' +
        'ambiguous and the re-key sweep unable to tell what it has already moved.',
      { version },
    )
  }

  return {
    current: { version: version.trim(), secret },
    retired:
      retiredSecret.trim() === ''
        ? null
        : { version: retiredVersion.trim(), secret: retiredSecret },
  }
}

/**
 * The unit separator between the key kind and the value.
 *
 * Load-bearing for the reason `consent_wording_hash`'s is: without it, ('phone', '+9715…') and ('phon',
 * 'e+9715…') hash identically, so one kind's key could be another kind's. The kind is IN the input
 * because the two kinds are looked up together and a phone key that matched an email row would suppress
 * the wrong channel.
 */
const UNIT_SEPARATOR = '\u001f'

/**
 * The stored key for one normalised recipient, under one pepper.
 *
 * The value must already be normalised — E.164 for a phone, a lower-cased address for an email — and it
 * is refused if it could break the separator's guarantee. `normaliseEmail` in `@berelax/core` accepts a
 * control character in the local part today (its shape test excludes whitespace and `@`, and U+001F is
 * neither), so this is not a theoretical guard: it is the one input that could make two different pairs
 * produce one key. Refused here rather than fixed there, because tightening that normaliser would change
 * which values `customer_blocklist` accepts, which is 0053's key space and not this unit's.
 */
export function suppressionKey(
  pepper: SuppressionPepper,
  keyKind: string,
  normalisedValue: string,
): string {
  if (normalisedValue.includes(UNIT_SEPARATOR)) {
    refuse(
      'suppression_key_not_keyable',
      'A suppression key may not contain U+001F, which is the separator between the kind and the value. ' +
        'A value carrying one could make two different (kind, value) pairs produce the same key.',
      { keyKind },
    )
  }
  return createHmac('sha256', pepper.secret)
    .update(`${keyKind}${UNIT_SEPARATOR}${normalisedValue}`, 'utf8')
    .digest('hex')
}

/** `normaliseBlocklistKey` from `@berelax/core`, injected. Strings, because the vocabulary is core's. */
export type SuppressionKeyNormaliser = (
  kind: string,
  raw: string,
) =>
  | { readonly ok: true; readonly key: { readonly kind: string; readonly value: string } }
  | { readonly ok: false; readonly reason: string; readonly detail?: string | undefined }

export interface SuppressionKeying {
  readonly peppers: SuppressionPeppers
  readonly normalise: SuppressionKeyNormaliser
}

interface KeyedRecipient {
  readonly keyKind: string
  readonly normalised: string
  /** The key under the CURRENT pepper. What a write stores. */
  readonly current: string
  /** Every key a READ must look for: the current one, plus the retired one while it is retained. */
  readonly candidates: readonly string[]
}

function keyRecipient(keying: SuppressionKeying, keyKind: string, raw: string): KeyedRecipient {
  if (typeof keying.normalise !== 'function') {
    refuse(
      'suppression_key_not_normalised',
      'No key normaliser was injected, so nothing produced a comparable suppression key. Wire ' +
        '`normaliseBlocklistKey` from @berelax/core. There is no fallback on purpose: an un-normalised ' +
        'key matches nothing, and because the plaintext never reaches a column no constraint can catch ' +
        'it — the row would look perfectly valid and suppress nobody.',
      { keyKind },
    )
  }
  const result = keying.normalise(keyKind, raw)
  if (!result.ok) {
    refuse(
      'suppression_key_not_keyable',
      `This ${keyKind} cannot be normalised (${result.reason}), so it cannot be keyed. Comparing the ` +
        'raw string instead would be the one path on which a match could be made by accident.',
      { keyKind, reason: result.reason, detail: result.detail ?? null },
    )
  }
  const normalised = result.key.value
  const current = suppressionKey(keying.peppers.current, keyKind, normalised)
  const retired = keying.peppers.retired
  return {
    keyKind,
    normalised,
    current,
    candidates:
      retired === null ? [current] : [current, suppressionKey(retired, keyKind, normalised)],
  }
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

export interface SuppressionRow {
  readonly id: string
  readonly keyKind: string
  readonly keyHmac: string
  readonly pepperVersion: string
  readonly kind: 'suppressed' | 'unsuppressed'
  readonly source: string
  readonly reason: string
  readonly actorKind: string
  readonly actorLabel: string
  readonly recordedAt: Date
  readonly contactCustomerId: string | null
  readonly createdAt: Date
}

interface RawSuppressionRow {
  readonly id: string
  readonly key_kind: string
  readonly key_hmac: string
  readonly pepper_version: string
  readonly kind: 'suppressed' | 'unsuppressed'
  readonly source: string
  readonly reason: string
  readonly actor_kind: string
  readonly actor_label: string
  readonly recorded_at: Date
  readonly contact_customer_id: string | null
  readonly created_at: Date
}

const toSuppression = (row: RawSuppressionRow): SuppressionRow => ({
  id: row.id,
  keyKind: row.key_kind,
  keyHmac: row.key_hmac,
  pepperVersion: row.pepper_version,
  kind: row.kind,
  source: row.source,
  reason: row.reason,
  actorKind: row.actor_kind,
  actorLabel: row.actor_label,
  recordedAt: row.recorded_at,
  contactCustomerId: row.contact_customer_id,
  createdAt: row.created_at,
})

const SUPPRESSION_COLUMNS = `
  id, key_kind, key_hmac, pepper_version, kind::text as kind, source::text as source, reason,
  actor_kind, actor_label, recorded_at, contact_customer_id, created_at
`

/** What a caller supplies. The RAW recipient: normalising it is the injected function's job. */
export interface SuppressionInput {
  readonly keyKind: string
  /** As typed or as received. Normalised through the injected function, never stored. */
  readonly recipient: string
  readonly source: string
  readonly reason: string
  readonly actorKind: string
  readonly actorLabel: string
  /** The instant the decision was made, from an injected clock. */
  readonly recordedAtIso: string
  readonly contactCustomerId: string | null
}

/**
 * Records a suppression. Never an update, whatever the source.
 *
 * Idempotent on (key_kind, key_hmac, kind, recorded_at) — `suppression_one_record_per_instant` — so a
 * double-clicked unsubscribe is one row and the second call reports `recorded: false`. `kind` is in that
 * key deliberately, so a suppression and an unsuppression recorded at one instant are both STORED rather
 * than one being discarded as a duplicate: the log is then ambiguous and `resolveSuppression` fails
 * closed to SUPPRESSED, which is safe and visible.
 */
export async function recordSuppression(
  uow: UnitOfWork,
  keying: SuppressionKeying,
  input: SuppressionInput,
): Promise<{ readonly recorded: boolean; readonly row: SuppressionRow }> {
  return writeSuppression(uow, keying, input, 'suppressed')
}

/**
 * Lifts a suppression, which is a NEW row with `kind: 'unsuppressed'`.
 *
 * A thin wrapper over the same statement rather than its own, so the contract, the keying and the
 * idempotence are the ones a suppression goes through — a lift path with its own INSERT is a second place
 * for a rule to be missing. The source is restricted to the three with a decision behind them by both
 * `suppressionEntrySchema` and `suppression_unsuppression_has_a_decision_behind_it`.
 */
export async function unsuppressKey(
  uow: UnitOfWork,
  keying: SuppressionKeying,
  input: SuppressionInput,
): Promise<{ readonly recorded: boolean; readonly row: SuppressionRow }> {
  return writeSuppression(uow, keying, input, 'unsuppressed')
}

async function writeSuppression(
  uow: UnitOfWork,
  keying: SuppressionKeying,
  input: SuppressionInput,
  kind: 'suppressed' | 'unsuppressed',
): Promise<{ readonly recorded: boolean; readonly row: SuppressionRow }> {
  const keyed = keyRecipient(keying, input.keyKind, input.recipient)
  const candidate: SuppressionEntryInput = {
    keyKind: keyed.keyKind as SuppressionEntryInput['keyKind'],
    keyHmacHex: keyed.current,
    pepperVersion: keying.peppers.current.version,
    kind,
    source: input.source as SuppressionEntryInput['source'],
    reason: input.reason,
    actorKind: input.actorKind as SuppressionEntryInput['actorKind'],
    actorLabel: input.actorLabel,
    recordedAtIso: input.recordedAtIso,
    contactCustomerId: input.contactCustomerId,
  }
  const parsed = suppressionEntrySchema.safeParse(candidate)
  if (!parsed.success) {
    refuse(
      'suppression_entry_invalid',
      `Refusing to record this suppression: ${parsed.error.message}`,
      { issues: parsed.error.issues },
    )
  }
  const entry = parsed.data

  const rows = await uow.sql<RawSuppressionRow[]>`
    insert into suppression
      (key_kind, key_hmac, pepper_version, kind, source, reason, actor_kind, actor_label, recorded_at,
       contact_customer_id)
    values (
      ${entry.keyKind}, ${entry.keyHmacHex}, ${entry.pepperVersion}, ${entry.kind}::suppression_kind,
      ${entry.source}::suppression_source, ${entry.reason}, ${entry.actorKind}, ${entry.actorLabel},
      ${entry.recordedAtIso}::timestamptz, ${entry.contactCustomerId}
    )
    on conflict (key_kind, key_hmac, kind, recorded_at) do nothing
    returning ${uow.sql.unsafe(SUPPRESSION_COLUMNS)}
  `

  const inserted = rows[0]
  if (inserted === undefined) {
    // The conflict arm. Read the row that won rather than reporting nothing: a caller retrying a
    // double-clicked unsubscribe needs the row, and a `null` here would send it round again.
    const existing = await uow.sql<RawSuppressionRow[]>`
      select ${uow.sql.unsafe(SUPPRESSION_COLUMNS)} from suppression
       where key_kind = ${entry.keyKind} and key_hmac = ${entry.keyHmacHex}
         and kind = ${entry.kind}::suppression_kind
         and recorded_at = ${entry.recordedAtIso}::timestamptz
    `
    const row = existing[0]
    if (row === undefined) {
      throw new AppError(
        'invariant_violated',
        'A suppression insert conflicted and the conflicting row cannot be read back. Nothing deletes ' +
          'from this table, so the row that caused the conflict must still be there.',
        { details: { keyKind: entry.keyKind, kind: entry.kind } },
      )
    }
    // No audit row on the no-op, the way `recordConsent` writes none: a trail that records a retry as a
    // change makes every double submission look like a second decision.
    return { recorded: false, row: toSuppression(row) }
  }

  await uow.audit.record({
    action:
      kind === 'suppressed' ? SUPPRESSION_AUDIT_ACTIONS.recorded : SUPPRESSION_AUDIT_ACTIONS.lifted,
    entityType: 'suppression',
    entityId: inserted.id,
    operation: 'create',
    after: {
      // The HMAC and never the recipient. `audit_event` is a partitioned table several roles read, and a
      // plaintext number here would put back exactly what 0064 keeps out of `suppression`.
      key_kind: inserted.key_kind,
      key_hmac: inserted.key_hmac,
      pepper_version: inserted.pepper_version,
      kind: inserted.kind,
      source: inserted.source,
      actor_kind: inserted.actor_kind,
      recorded_at: inserted.recorded_at,
      contact_customer_id: inserted.contact_customer_id,
    },
  })
  return { recorded: true, row: toSuppression(inserted) }
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

/** The log `resolveSuppression` in `@berelax/core` takes, for one key. */
export interface SuppressionLogRead {
  /** The key under the CURRENT pepper, whichever pepper the records were written under. */
  readonly key: string
  readonly records: readonly {
    readonly id: string
    readonly kind: string
    readonly source: string
    /** Epoch milliseconds, which is what `Instant` is. A `Date` here would need a cast in core. */
    readonly recordedAt: number
  }[]
}

/**
 * The suppression logs for a set of recipients, in one query whatever the size of the set.
 *
 * Keyed on the recipient string the caller passed — the plaintext, exactly as `message.recipient` spells
 * it — so the map can be handed straight to `suppressionGateEvaluator`. That is not a leak of the thing
 * the table exists not to hold: the recipient is already in the message being sent, and this map lives
 * for the length of one send run.
 *
 * **Every recipient that can be KEYED gets an entry, including one with no rows at all.** The
 * distinction is load-bearing: `suppressionGateEvaluator` throws for a recipient it has no log for,
 * because an unread list is not a clearance, and an absent entry for somebody who simply is not on the
 * list would turn "nobody asked us to stop" into `blocked_unevaluable`.
 *
 * A recipient that cannot be keyed is deliberately **absent** from the map rather than present with an
 * empty log. An unnormalisable recipient is one this module cannot answer about, and answering "not
 * suppressed" would be a clearance derived from a failure — so the evaluator throws and the gate records
 * `blocked_unevaluable`, which is the fail-closed direction for a prohibition.
 *
 * Both peppers are looked for in the same statement. A row keyed under the retired pepper is folded into
 * the same log as one keyed under the current pepper, because they are the same person and the instants
 * order them; the log reports the CURRENT key, so a caller that writes after reading writes forward.
 */
export async function readSuppressionLogs(
  sql: Sql,
  keying: SuppressionKeying,
  recipients: readonly { readonly keyKind: string; readonly recipient: string }[],
): Promise<ReadonlyMap<string, SuppressionLogRead>> {
  const logs = new Map<string, SuppressionLogRead>()
  const byCandidate = new Map<string, string[]>()
  const wanted = new Map<string, { keyKind: string; recipient: string }>()
  for (const entry of recipients) wanted.set(entry.recipient, { ...entry })

  for (const [recipient, entry] of wanted) {
    let keyed: KeyedRecipient
    try {
      keyed = keyRecipient(keying, entry.keyKind, recipient)
    } catch (error) {
      // An unkeyable recipient is left OUT of the map on purpose — see the header. Rethrown only when the
      // fault is the configuration rather than the value: a missing pepper or a missing normaliser is a
      // deployment error that must stop the run, not a recipient the run can skip.
      const refusal = suppressionRefusalOf(error)
      if (refusal === 'suppression_key_not_keyable') continue
      throw error
    }
    logs.set(recipient, { key: keyed.current, records: [] })
    for (const candidate of keyed.candidates) {
      byCandidate.set(candidate, [...(byCandidate.get(candidate) ?? []), recipient])
    }
  }
  if (byCandidate.size === 0) return logs

  const rows = await sql<
    {
      key_hmac: string
      id: string
      kind: string
      source: string
      recorded_at_ms: string
    }[]
  >`
    select key_hmac, id, kind::text as kind, source::text as source,
           (extract(epoch from recorded_at) * 1000)::bigint::text as recorded_at_ms
      from suppression
     where key_hmac = any(${[...byCandidate.keys()]}::text[])
     order by key_hmac, recorded_at, id
  `

  const collected = new Map<string, SuppressionLogRead['records'][number][]>()
  for (const row of rows) {
    for (const recipient of byCandidate.get(row.key_hmac) ?? []) {
      collected.set(recipient, [
        ...(collected.get(recipient) ?? []),
        {
          id: row.id,
          kind: row.kind,
          source: row.source,
          recordedAt: Number(row.recorded_at_ms),
        },
      ])
    }
  }
  for (const [recipient, records] of collected) {
    const existing = logs.get(recipient)
    if (existing !== undefined) logs.set(recipient, { key: existing.key, records })
  }
  return logs
}

/** Every row for one key, newest first. What an admin screen and a merge report read. */
export async function readSuppressionHistory(
  sql: Sql,
  keying: SuppressionKeying,
  args: { readonly keyKind: string; readonly recipient: string },
): Promise<readonly SuppressionRow[]> {
  const keyed = keyRecipient(keying, args.keyKind, args.recipient)
  const rows = await sql<RawSuppressionRow[]>`
    select ${sql.unsafe(SUPPRESSION_COLUMNS)} from suppression
     where key_hmac = any(${[...keyed.candidates]}::text[])
     order by recorded_at desc, id desc
  `
  return rows.map(toSuppression)
}

/** How many contacts are suppressed per source, counted in SQL. What a marketing report asks. */
export async function suppressionSourceCounts(
  sql: Sql,
): Promise<readonly { readonly source: string; readonly keys: number }[]> {
  const rows = await sql<{ source: string; keys: string }[]>`
    select source::text as source, count(distinct key_hmac)::text as keys
      from suppression group by source order by source
  `
  return rows.map((row) => ({ source: row.source, keys: Number(row.keys) }))
}

// ------------------------------------------------------------------------------------------------
// The content scan
// ------------------------------------------------------------------------------------------------

/** The tables 0064 creates, in the order the scan reports them. */
export const SUPPRESSION_TABLES = [
  'suppression',
  'optout_grant',
  'optout_verification_attempt',
] as const

export interface PlaintextLeak {
  readonly table: string
  readonly rowId: string
  readonly needle: string
}

/**
 * Rows in this unit's tables whose text contains a recipient in the clear.
 *
 * The acceptance criterion asks for a content scan asserting no plaintext phone number or address is
 * present in any column, and this is it: `to_jsonb(row)::text` renders **every** column of the row —
 * including any column a later migration adds, which is the half a hand-written column list would miss —
 * and the needles are compared with `position()`, exactly, rather than with a pattern.
 *
 * Exact needles rather than a regex, and the reason is worth stating because the regex version was
 * written first and is wrong. A pattern for "nine or more digits in a row" matches `key_hmac` by
 * accident: a 64-character hex digest contains a run of nine decimal digits about half the time, because
 * ten of the sixteen hex characters are digits. So the scan would have reported a leak on a correctly
 * hashed table, somebody would have loosened it, and it would then have stopped reporting anything. A
 * caller that knows which recipients it wrote can ask the exact question instead.
 *
 * `reason` and `actor_label` are free text, so this scan can genuinely fail: a member of staff typing
 * "unsubscribed, called from +971 59 000 0042" puts a number into a column the hashing scheme never
 * touches. That is the leak worth finding, and it is why the scan covers every column rather than
 * asserting a shape on `key_hmac` alone.
 */
export async function suppressionPlaintextLeaks(
  sql: Sql,
  needles: readonly string[],
): Promise<readonly PlaintextLeak[]> {
  const found: PlaintextLeak[] = []
  const wanted = [...new Set(needles.filter((needle) => needle.trim() !== ''))]
  if (wanted.length === 0) return found
  for (const table of SUPPRESSION_TABLES) {
    const rows = await sql<{ id: string; needle: string }[]>`
      select t.id::text as id, n.needle
        from ${sql(table)} t
        cross join unnest(${[...wanted]}::text[]) as n(needle)
       where position(n.needle in to_jsonb(t)::text) > 0
       order by t.id, n.needle
    `
    for (const row of rows) found.push({ table, rowId: row.id, needle: row.needle })
  }
  return found
}

/** Every column of one of this unit's tables, so a test can assert none is named for a recipient. */
export async function suppressionColumns(
  sql: Sql,
  table: (typeof SUPPRESSION_TABLES)[number],
): Promise<readonly string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
     where table_schema = 'public' and table_name = ${table}
     order by ordinal_position
  `
  return rows.map((row) => row.column_name)
}

// ------------------------------------------------------------------------------------------------
// The opt-out token
// ------------------------------------------------------------------------------------------------

/**
 * How many verifications one address may make per window, and how long the window is.
 *
 * Ten a minute. Not an anti-guessing measure — a 256-bit token is not guessable and
 * `OPT_OUT_TOKEN_BYTES` in `@berelax/core` says so — but an anti-flood one: the endpoint is
 * unauthenticated by construction, every call is a query and a write, and a script pointed at it is a
 * denial of service against the one opt-out path this business has. Ten is generous for a person
 * following a link and refuses a script.
 *
 * Counted over rows rather than in memory, for the reason `otp_challenge` counts its own: the
 * application runs in more than one container, and a per-process counter is the limit multiplied by
 * however many are running.
 */
export const OPTOUT_VERIFY_MAX_PER_IP = 10
export const OPTOUT_VERIFY_WINDOW_SECONDS = 60

/** The only rate limit this endpoint has, named so a refusal is actionable. */
export const OPTOUT_VERIFY_LIMITS = ['ip'] as const
export type OptOutVerifyLimit = (typeof OPTOUT_VERIFY_LIMITS)[number]

/** The sha256 of a token, hex. The only representation of one that is ever stored. */
export const optOutTokenDigest = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex')

export interface IssuedOptOutGrant {
  readonly grantId: string
  /** The token. Returned once, never stored, and never written to an audit row or a log. */
  readonly token: string
  readonly expiresAtIso: string
}

/**
 * Mints an opt-out link for one contact.
 *
 * `randomBytes(32).toString('base64url')` — 256 bits, in the alphabet a URL needs. `randomInt` and
 * `randomBytes` rather than `Math.random` for `generateOtpCode`'s reason: the second is seeded from
 * something an attacker can often predict, and a predictable capability is not a capability.
 *
 * Audited at the MINT rather than only at the redemption, so a link nobody ever followed still leaves a
 * trace. "Was this customer ever sent a way to opt out" is a different question from "did they use it",
 * and a TDRA complaint asks the first one.
 */
export async function issueOptOutGrant(
  uow: UnitOfWork,
  args: {
    readonly contactCustomerId: string
    readonly channel: string
    readonly purpose: string
    readonly issuedAtIso: string
    readonly ttlSeconds: number
  },
): Promise<IssuedOptOutGrant> {
  if (!Number.isInteger(args.ttlSeconds) || args.ttlSeconds < 1) {
    throw new AppError(
      'validation',
      `An opt-out grant must live a whole positive number of seconds, received ${args.ttlSeconds}. A ` +
        'grant that has already expired when it is written reads to a customer as a broken link, and ' +
        'this link is the only functional opt-out this product has.',
      { details: { ttlSeconds: args.ttlSeconds } },
    )
  }
  const token = randomBytes(32).toString('base64url')
  const digest = optOutTokenDigest(token)
  const [row] = await uow.sql<{ id: string; expires_at: Date }[]>`
    insert into optout_grant
      (token_sha256, contact_customer_id, purpose, channel, issued_at, expires_at)
    values (
      ${digest}, ${args.contactCustomerId}::uuid, ${args.purpose}, ${args.channel}::message_channel,
      ${args.issuedAtIso}::timestamptz,
      ${args.issuedAtIso}::timestamptz + make_interval(secs => ${args.ttlSeconds})
    )
    returning id::text as id, expires_at
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'The opt-out grant was not written and did not raise.')
  }
  await uow.audit.record({
    action: SUPPRESSION_AUDIT_ACTIONS.grantIssued,
    entityType: 'optout_grant',
    entityId: row.id,
    operation: 'create',
    // The token is deliberately absent. An audit trail carrying the credential would be a second copy of
    // it, in a partitioned table several roles may read.
    after: {
      contact_customer_id: args.contactCustomerId,
      channel: args.channel,
      purpose: args.purpose,
      expires_at: row.expires_at,
    },
  })
  return { grantId: row.id, token, expiresAtIso: row.expires_at.toISOString() }
}

/** Revokes one grant. The record that it was minted stays: `audit_event` is append-only. */
export async function revokeOptOutGrant(
  uow: UnitOfWork,
  args: { readonly grantId: string; readonly reason: string },
): Promise<void> {
  const rows = await uow.sql<{ id: string }[]>`
    delete from optout_grant where id = ${args.grantId}::uuid returning id::text as id
  `
  if (rows.length !== 1) {
    refuse('optout_grant_not_found', `No opt-out grant ${args.grantId}.`, {
      grantId: args.grantId,
    })
  }
  await uow.audit.record({
    action: SUPPRESSION_AUDIT_ACTIONS.grantRevoked,
    entityType: 'optout_grant',
    entityId: args.grantId,
    operation: 'delete',
    before: { grantId: args.grantId },
    after: { reason: args.reason },
  })
}

/** `decideOptOutAccess` from `@berelax/core`, injected. Mirrors `OptOutAccessDecision`. */
export type OptOutDecider = (input: {
  readonly grant: {
    readonly grantId: string
    readonly tokenSha256Hex: string
    readonly contactCustomerId: string
    readonly purpose: string
    readonly channel: string
    readonly expiresAt: number
  } | null
  readonly presentedDigestHex: string
  readonly requestedContactId: string
  readonly expectedPurpose: 'preference_centre'
  readonly at: number
}) =>
  | {
      readonly kind: 'granted'
      readonly grantId: string
      readonly contactCustomerId: string
      readonly channel: string
      readonly expiresAtIso: string
    }
  | { readonly kind: 'refused'; readonly reason: string; readonly detail: string }

/** `optOutTokenShape` from `@berelax/core`, injected. Refuses a malformed token before any query. */
export type OptOutShapeChecker = (
  presented: string | null,
) => { readonly ok: true; readonly token: string } | { readonly ok: false; readonly reason: string }

export interface OptOutVerification {
  readonly decide: OptOutDecider
  readonly shape: OptOutShapeChecker
}

export type OptOutVerifyResult =
  | {
      readonly kind: 'granted'
      readonly grantId: string
      readonly contactCustomerId: string
      readonly channel: string
      readonly expiresAtIso: string
    }
  | { readonly kind: 'refused'; readonly reason: string; readonly detail: string }
  | {
      readonly kind: 'rate_limited'
      readonly limit: OptOutVerifyLimit
      readonly retryAfterSeconds: number
    }

/**
 * Verifies a presented token against the grant table, rate-limited by address.
 *
 * The order is the whole of it and every step is there to stop the one after it being reached
 * unnecessarily:
 *
 *   1. **the rate limit**, counted in SQL over the window. Refused before anything is parsed, so a flood
 *      costs one count and one insert rather than a lookup;
 *   2. **the shape**, from the injected checker, so a malformed token costs a regex and not a query;
 *   3. **the lookup**, on the DIGEST — the stored value is never compared against a secret this function
 *      was given in the clear;
 *   4. **the decision**, from the injected decider, which compares the digests without a short circuit,
 *      judges expiry against the instant supplied, and refuses a valid grant presented for a different
 *      contact.
 *
 * Every outcome is recorded against the address, including the refusals, because the count in step 1 is
 * over attempts and not over successes: a limit that only counted the ones that worked would be no limit
 * at all against somebody trying tokens.
 *
 * `atIso` is supplied rather than read as `now()` because every window and expiry assertion in this area
 * is made under a frozen clock. Both the count and the expiry comparison use it, so the two cannot drift
 * apart mid-request the way they would if one read the clock and the other read the row.
 */
export async function verifyOptOutToken(
  uow: UnitOfWork,
  verification: OptOutVerification,
  args: {
    readonly token: string | null
    readonly requestedContactId: string
    readonly requestIp: string
    readonly atIso: string
    readonly expectedPurpose?: 'preference_centre'
  },
): Promise<OptOutVerifyResult> {
  if (typeof verification.decide !== 'function' || typeof verification.shape !== 'function') {
    refuse(
      'optout_not_decided',
      'No decider or shape checker was injected for this opt-out verification, so nothing evaluated the ' +
        'token. Wire `decideOptOutAccess` and `optOutTokenShape` from @berelax/core. There is no ' +
        'fallback: a verifier that defaulted to granted would hand somebody else’s preference page to ' +
        'anybody who asked.',
      {},
    )
  }
  const atMs = Date.parse(args.atIso)
  if (Number.isNaN(atMs)) {
    throw new AppError(
      'validation',
      `verifyOptOutToken was given an unparseable instant "${args.atIso}".`,
    )
  }

  const [count] = await uow.sql<{ attempts: string; oldest: Date | null }[]>`
    select count(*)::text as attempts, min(attempted_at) as oldest
      from optout_verification_attempt
     where request_ip = ${args.requestIp}::inet
       and attempted_at > ${args.atIso}::timestamptz
                          - make_interval(secs => ${OPTOUT_VERIFY_WINDOW_SECONDS})
  `
  if (count !== undefined && Number(count.attempts) >= OPTOUT_VERIFY_MAX_PER_IP) {
    await recordAttempt(uow, args.requestIp, args.atIso, 'rate_limited')
    // The window slides off the OLDEST attempt rather than resetting on the minute: a fixed window lets
    // somebody spend double the allowance across its boundary.
    const freesAt = (count.oldest?.getTime() ?? atMs) + OPTOUT_VERIFY_WINDOW_SECONDS * 1000 - atMs
    return {
      kind: 'rate_limited',
      limit: 'ip',
      retryAfterSeconds: Math.max(1, Math.ceil(freesAt / 1000)),
    }
  }

  const shape = verification.shape(args.token)
  if (!shape.ok) {
    await recordAttempt(uow, args.requestIp, args.atIso, shape.reason)
    return {
      kind: 'refused',
      reason: shape.reason,
      detail: 'The presented token is not the shape a token has, so nothing was looked up.',
    }
  }

  const digest = optOutTokenDigest(shape.token)
  const [row] = await uow.sql<
    {
      id: string
      token_sha256: string
      contact_customer_id: string
      purpose: string
      channel: string
      expires_at_ms: string
    }[]
  >`
    select id::text as id, token_sha256, contact_customer_id::text as contact_customer_id, purpose,
           channel::text as channel,
           (extract(epoch from expires_at) * 1000)::bigint::text as expires_at_ms
      from optout_grant where token_sha256 = ${digest}
  `

  const decision = verification.decide({
    grant:
      row === undefined
        ? null
        : {
            grantId: row.id,
            tokenSha256Hex: row.token_sha256,
            contactCustomerId: row.contact_customer_id,
            purpose: row.purpose,
            channel: row.channel,
            expiresAt: Number(row.expires_at_ms),
          },
    presentedDigestHex: digest,
    requestedContactId: args.requestedContactId,
    expectedPurpose: args.expectedPurpose ?? 'preference_centre',
    at: atMs,
  })

  if (decision.kind === 'refused') {
    await recordAttempt(uow, args.requestIp, args.atIso, decision.reason)
    return decision
  }
  await recordAttempt(uow, args.requestIp, args.atIso, 'granted')
  await uow.audit.record({
    action: SUPPRESSION_AUDIT_ACTIONS.tokenRedeemed,
    entityType: 'optout_grant',
    entityId: decision.grantId,
    operation: 'read',
    after: { contact_customer_id: decision.contactCustomerId, channel: decision.channel },
  })
  return decision
}

async function recordAttempt(
  uow: UnitOfWork,
  requestIp: string,
  atIso: string,
  outcome: string,
): Promise<void> {
  await uow.sql`
    insert into optout_verification_attempt (request_ip, attempted_at, outcome)
    values (${requestIp}::inet, ${atIso}::timestamptz, ${outcome})
  `
}

/** Removes attempts older than the window. The table is only ever READ over the last minute. */
export async function pruneOptOutVerificationAttempts(
  sql: Sql,
  args: { readonly beforeIso: string },
): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    delete from optout_verification_attempt
     where attempted_at < ${args.beforeIso}::timestamptz
     returning id
  `
  return rows.length
}

// ------------------------------------------------------------------------------------------------
// The preference centre's write
// ------------------------------------------------------------------------------------------------

/** What the preference centre can do. Two actions, and they are exact opposites. */
export const PREFERENCE_CENTRE_ACTIONS = ['unsubscribe', 'resubscribe'] as const
export type PreferenceCentreAction = (typeof PREFERENCE_CENTRE_ACTIONS)[number]

export interface PreferenceCentreChange {
  readonly contactCustomerId: string
  readonly action: PreferenceCentreAction
  /** The recipient the link was reached through, raw. The only detail that can be suppressed. */
  readonly recipient: string
  readonly keyKind: string
  /** The locale the wording was shown in, which is part of the consent capture context. */
  readonly locale: 'en' | 'ar'
  readonly decidedAtIso: string
}

export interface PreferenceCentreResult {
  readonly action: PreferenceCentreAction
  /** How many consent rows the change wrote. Every send-gating purpose × every channel. */
  readonly consentRows: number
  readonly suppressionRecorded: boolean
  readonly suppressionId: string
}

/**
 * Applies what somebody clicked in the preference centre. Both halves, in one transaction.
 *
 * ## Why an unsubscribe writes a consent withdrawal AND a suppression
 *
 * They answer different questions and dropping either one leaves a hole somebody walks through:
 *
 *   - the **consent withdrawal** is the record that this person changed their mind, per channel and per
 *     purpose, carrying the capture context PDPL asks for. It is what `resolveConsent` reads, and it is
 *     the row a regulator would want to see;
 *   - the **suppression** is the instruction that outlives a later grant. Somebody who unsubscribes and
 *     then fills in a booking form again has a NEW consent row, newer than the withdrawal, and consent
 *     alone would start messaging them. The suppression is what makes that not happen, and it is exactly
 *     why the precedence rule is "suppression beats consent with no exceptions".
 *
 * ## Why the withdrawal covers every channel and the suppression covers one detail
 *
 * Consent is keyed on the CONTACT, so a withdrawal can cover every channel and every send-gating
 * purpose — which is what "stop messaging me" means, and anything narrower would be this system deciding
 * that the person only meant SMS. A suppression is keyed on a hashed contact DETAIL, so it can only cover
 * the detail the link was reached through. That asymmetry is not a compromise, it is the two keys doing
 * what each is for, and it is why an email address with no `customer` row can still be suppressed
 * (C-CRM-01's NOTE 3: `customer` has no email column, so such an address resolves to no contact at all).
 *
 * ## A resubscribe is the symmetric pair and needs a wording version
 *
 * It records a GRANT, which `consent_grant_carries_its_wording` refuses without the version shown, and an
 * `unsuppressed` row from `preference_centre`. If no wording is published there is nothing to grant
 * against and the change is refused by name rather than recorded against words nobody showed.
 */
export async function applyPreferenceCentreChange(
  uow: UnitOfWork,
  keying: SuppressionKeying,
  change: PreferenceCentreChange,
): Promise<PreferenceCentreResult> {
  const channels = ['sms', 'email', 'whatsapp'] as const
  let consentRows = 0

  if (change.action === 'unsubscribe') {
    for (const channel of channels) {
      for (const purpose of SEND_GATING_CONSENT_PURPOSES) {
        const written = await withdrawConsent(uow, {
          contactCustomerId: change.contactCustomerId,
          channel,
          purpose,
          // No wording on a withdrawal. `consentRecordSchema` says why a grant needs one and a
          // withdrawal does not: a system that refused to record an opt-out until an operator produced a
          // wording version would be easier to opt into than out of.
          wordingId: null,
          wordingHashHex: null,
          recordedAtIso: change.decidedAtIso,
          capture: {
            source: 'preference_centre',
            actorKind: 'customer',
            actorLabel: 'Preference centre (link holder)',
            locale: change.locale,
          },
        })
        if (written.recorded) consentRows += 1
      }
    }
    const suppressed = await recordSuppression(uow, keying, {
      keyKind: change.keyKind,
      recipient: change.recipient,
      source: 'preference_centre',
      reason: 'Unsubscribed through the preference centre link.',
      actorKind: 'customer',
      actorLabel: 'Preference centre (link holder)',
      recordedAtIso: change.decidedAtIso,
      contactCustomerId: change.contactCustomerId,
    })
    await auditPreferenceChange(uow, change, suppressed.row.id)
    return {
      action: change.action,
      consentRows,
      suppressionRecorded: suppressed.recorded,
      suppressionId: suppressed.row.id,
    }
  }

  for (const purpose of SEND_GATING_CONSENT_PURPOSES) {
    const wording = await readCurrentConsentWording(uow.sql, purpose)
    if (wording === null) {
      refuse(
        'preference_centre_wording_absent',
        `No consent wording is published for '${purpose}', so there is nothing to grant against. A ` +
          'grant with no record of the words shown is not an opt-in proof, and the database refuses one.',
        { purpose },
      )
    }
    for (const channel of channels) {
      const written = await recordConsent(uow, {
        contactCustomerId: change.contactCustomerId,
        channel,
        purpose,
        kind: 'granted',
        recordedAtIso: change.decidedAtIso,
        wordingId: wording.id,
        wordingHashHex: wording.contentHashHex,
        capture: {
          source: 'preference_centre',
          actorKind: 'customer',
          actorLabel: 'Preference centre (link holder)',
          locale: change.locale,
        },
      })
      if (written.recorded) consentRows += 1
    }
  }
  const lifted = await unsuppressKey(uow, keying, {
    keyKind: change.keyKind,
    recipient: change.recipient,
    source: 'preference_centre',
    reason: 'Resubscribed through the preference centre link.',
    actorKind: 'customer',
    actorLabel: 'Preference centre (link holder)',
    recordedAtIso: change.decidedAtIso,
    contactCustomerId: change.contactCustomerId,
  })
  await auditPreferenceChange(uow, change, lifted.row.id)
  return {
    action: change.action,
    consentRows,
    suppressionRecorded: lifted.recorded,
    suppressionId: lifted.row.id,
  }
}

async function auditPreferenceChange(
  uow: UnitOfWork,
  change: PreferenceCentreChange,
  suppressionId: string,
): Promise<void> {
  await uow.audit.record({
    action: SUPPRESSION_AUDIT_ACTIONS.preferenceChanged,
    entityType: 'suppression',
    entityId: suppressionId,
    operation: 'create',
    // No recipient. The key kind says which detail was acted on and the suppression row holds its HMAC.
    after: {
      contact_customer_id: change.contactCustomerId,
      action: change.action,
      key_kind: change.keyKind,
      locale: change.locale,
      decided_at: change.decidedAtIso,
    },
  })
}
