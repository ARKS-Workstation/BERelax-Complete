import {
  AppError,
  type ConsentRecordInput,
  type ConsentWordingInput,
  consentRecordSchema,
  consentWordingSchema,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The consent store's writes and reads (C-CRM-03), over the append-only tables in 0056.
 *
 * ## Nothing here updates anything
 *
 * There is no `withdrawConsent(id)` that sets a column and no `republishWording` that edits a text.
 * {@link withdrawConsent} INSERTs a row with `kind: 'withdrawn'`; {@link publishConsentWording} INSERTs
 * the next version. The database refuses the alternative for every role including the owner (ZP001,
 * ZP003), so a method that tried would raise rather than silently succeed — but the shape of this module
 * is what stops anybody writing one.
 *
 * ## The zod schema runs before the SQL, and the SQL runs anyway
 *
 * `consentRecordSchema` and `consentWordingSchema` live in `@berelax/shared` and are parsed here, at the
 * write. The database repeats every one of those rules as a NOT NULL, a CHECK or a trigger. That is
 * deliberate duplication, not belt-and-braces: the schema gives a person a readable message at the edge,
 * and the constraint is what holds when the write arrives from a psql session, a migration or a future
 * caller that forgot this module exists. `packages/fixtures/src/consent.itest.ts` asserts both halves for
 * every mandatory field, because a gap in either is invisible from the other side.
 *
 * ## Why the wording hash is an argument and not computed here
 *
 * `recordConsent` takes the hash the caller had in hand when it rendered the statement, and the trigger
 * on `consent` compares it to the stored version's. That makes the pair a check on the round trip: read
 * a version, render it, write the record, and if somebody published a different version in between the
 * write is refused instead of recorded against words nobody showed. If this module hashed the text
 * itself, it would hash whatever the table currently says — which is exactly the value that cannot be
 * trusted once tampering is the thing being defended against.
 *
 * ## What is NOT here
 *
 * `resolveConsent` — the fold from the log to a state — is `packages/core`'s, because `packages/db` may
 * never import `packages/core` and because it is a pure function over data. {@link readConsentLog}
 * returns exactly the shape that function takes, and `packages/fixtures` is the only package that may
 * hold both and assert the pair.
 */

/** Every reason a consent write is refused, as a value. Callers branch on these, never on prose. */
export const CONSENT_REFUSALS = [
  /** The zod contract rejected the capture. `details.issues` carries what it said. */
  'consent_capture_invalid',
  /** The wording version named does not exist. */
  'consent_wording_not_found',
  /** The snapshot hash disagrees with the stored version — ZP002 from the database. */
  'consent_wording_hash_mismatch',
  /** A wording version number already exists for that purpose, or was not the next one. */
  'consent_wording_version_taken',
  /** The purpose is not in the vocabulary. */
  'consent_purpose_unknown',
] as const
export type ConsentRefusal = (typeof CONSENT_REFUSALS)[number]

/** SQLSTATEs 0056 raises, so a caller can tell a tamper from a constraint without reading prose. */
export const CONSENT_SQLSTATE = {
  wordingImmutable: 'ZP001',
  wordingHashMismatch: 'ZP002',
  consentImmutable: 'ZP003',
} as const

function refuse(
  refusal: ConsentRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError(refusal === 'consent_capture_invalid' ? 'validation' : 'conflict', message, {
    userFacing: refusal === 'consent_capture_invalid',
    details: { ...details, refusal },
  })
}

/** The named refusal carried on an error this module raised, or null. */
export function consentRefusalOf(err: unknown): ConsentRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' && (CONSENT_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as ConsentRefusal)
    : null
}

const sqlstateOf = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** Audit actions this module writes. Named constants, so a caller can count a delta on one. */
export const CONSENT_AUDIT_ACTIONS = {
  recorded: 'consent.recorded',
  wordingPublished: 'consent_wording.published',
} as const

// ------------------------------------------------------------------------------------------------
// The canonical hash
// ------------------------------------------------------------------------------------------------

/**
 * The hash of a wording pair, computed by the database's own `consent_wording_hash()`.
 *
 * Deliberately a round trip rather than a `createHash` call here. One definition of the canonicalisation
 * exists — the SQL function — and it is the one the GENERATED column and the INSERT trigger use. A
 * second implementation in TypeScript would agree today and be two things to change tomorrow, and the
 * symptom of a disagreement is a valid consent record refused as tampered.
 */
export async function consentWordingHash(
  sql: Sql,
  text: { readonly textEn: string; readonly textAr: string },
): Promise<string> {
  const rows = await sql<{ hash: string }[]>`
    select encode(consent_wording_hash(${text.textEn}, ${text.textAr}), 'hex') as hash
  `
  const row = rows[0]
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'consent_wording_hash() returned no row. The function is IMMUTABLE and takes two text arguments; ' +
        'no row means it is not the function 0056 created.',
    )
  }
  return row.hash
}

// ------------------------------------------------------------------------------------------------
// Wording versions
// ------------------------------------------------------------------------------------------------

export interface ConsentWordingRecord {
  readonly id: string
  readonly purpose: string
  readonly version: number
  readonly textEn: string
  readonly textAr: string
  /** Lower-case hex. Hand this back to {@link recordConsent} unchanged. */
  readonly contentHashHex: string
  readonly publishedAt: Date
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
}

interface WordingRow {
  readonly id: string
  readonly purpose: string
  readonly version: number
  readonly text_en: string
  readonly text_ar: string
  readonly content_hash_hex: string
  readonly published_at: Date
  readonly is_provisional: boolean
  readonly open_question_id: string | null
  readonly provisional_note: string | null
}

const toWording = (row: WordingRow): ConsentWordingRecord => ({
  id: row.id,
  purpose: row.purpose,
  version: row.version,
  textEn: row.text_en,
  textAr: row.text_ar,
  contentHashHex: row.content_hash_hex,
  publishedAt: row.published_at,
  isProvisional: row.is_provisional,
  openQuestionId: row.open_question_id,
  provisionalNote: row.provisional_note,
})

const WORDING_COLUMNS = `
  id, purpose, version, text_en, text_ar, encode(content_hash, 'hex') as content_hash_hex,
  published_at, is_provisional, open_question_id, provisional_note
`

/**
 * Publishes the next version of a purpose's wording.
 *
 * The version number is chosen HERE, from `max(version) + 1` under the purpose's row lock, rather than
 * taken from the caller. Two operators publishing a correction in the same minute would otherwise both
 * compute version 3, and the second would get a unique-constraint violation that reads as a bug in the
 * admin screen rather than as "somebody else just published". The lock is on `consent_purpose`, which is
 * the only row both transactions are guaranteed to touch — `consent_wording` has no row to lock before
 * the first version exists.
 */
export async function publishConsentWording(
  uow: UnitOfWork,
  input: ConsentWordingInput,
): Promise<ConsentWordingRecord> {
  const parsed = consentWordingSchema.safeParse(input)
  if (!parsed.success) {
    refuse('consent_capture_invalid', `Refusing to publish this wording: ${parsed.error.message}`, {
      issues: parsed.error.issues,
    })
  }
  const wording = parsed.data

  const [purposeRow] = await uow.sql<{ purpose: string }[]>`
    select purpose from consent_purpose where purpose = ${wording.purpose} for update
  `
  if (purposeRow === undefined) {
    refuse('consent_purpose_unknown', `'${wording.purpose}' is not a consent purpose.`, {
      purpose: wording.purpose,
    })
  }

  let rows: WordingRow[]
  try {
    rows = await uow.sql<WordingRow[]>`
      insert into consent_wording
        (purpose, version, text_en, text_ar, published_at, is_provisional, open_question_id,
         provisional_note)
      select ${wording.purpose}, coalesce(max(version), 0) + 1, ${wording.textEn},
             ${wording.textAr}, ${wording.publishedAtIso}::timestamptz, ${wording.isProvisional},
             ${wording.openQuestionId}, ${wording.provisionalNote}
        from consent_wording where purpose = ${wording.purpose}
      returning ${uow.sql.unsafe(WORDING_COLUMNS)}
    `
  } catch (error) {
    if (sqlstateOf(error) === '23505') {
      refuse(
        'consent_wording_version_taken',
        `Another transaction published a ${wording.purpose} wording version first. Re-read and publish ` +
          'again; nothing has been changed.',
        { purpose: wording.purpose },
      )
    }
    throw error
  }

  const row = rows[0]
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      `The ${wording.purpose} wording insert returned no row. The statement has a RETURNING clause and ` +
        'the purpose was locked, so an empty result is not a lost race.',
    )
  }
  await uow.audit.record({
    action: CONSENT_AUDIT_ACTIONS.wordingPublished,
    entityType: 'consent_wording',
    entityId: row.id,
    operation: 'create',
    // No `before`: a version is never replaced, so there is nothing it succeeded. The version number in
    // `after` is what says which one it follows.
    after: {
      purpose: row.purpose,
      version: row.version,
      contentHash: row.content_hash_hex,
      isProvisional: row.is_provisional,
    },
  })
  return toWording(row)
}

/** The newest version of a purpose's wording, or null when none has been published. */
export async function readCurrentConsentWording(
  sql: Sql,
  purpose: string,
): Promise<ConsentWordingRecord | null> {
  const rows = await sql<WordingRow[]>`
    select ${sql.unsafe(WORDING_COLUMNS)} from consent_wording
     where purpose = ${purpose} order by version desc limit 1
  `
  const row = rows[0]
  return row === undefined ? null : toWording(row)
}

/** One exact version, by id. What an audit or a subject-access request reads. */
export async function readConsentWording(
  sql: Sql,
  id: string,
): Promise<ConsentWordingRecord | null> {
  const rows = await sql<WordingRow[]>`
    select ${sql.unsafe(WORDING_COLUMNS)} from consent_wording where id = ${id}
  `
  const row = rows[0]
  return row === undefined ? null : toWording(row)
}

// ------------------------------------------------------------------------------------------------
// Consent records
// ------------------------------------------------------------------------------------------------

export interface ConsentRow {
  readonly id: string
  readonly contactCustomerId: string
  readonly channel: string
  readonly purpose: string
  readonly kind: 'granted' | 'withdrawn'
  readonly recordedAt: Date
  readonly consentWordingId: string | null
  readonly wordingHashHex: string | null
  readonly captureSource: string
  readonly captureActorKind: string
  readonly captureActorLabel: string
  readonly captureLocale: string
  readonly createdAt: Date
}

interface RawConsentRow {
  readonly id: string
  readonly contact_customer_id: string
  readonly channel: string
  readonly purpose: string
  readonly kind: 'granted' | 'withdrawn'
  readonly recorded_at: Date
  readonly consent_wording_id: string | null
  readonly wording_hash_hex: string | null
  readonly capture_source: string
  readonly capture_actor_kind: string
  readonly capture_actor_label: string
  readonly capture_locale: string
  readonly created_at: Date
}

const toConsent = (row: RawConsentRow): ConsentRow => ({
  id: row.id,
  contactCustomerId: row.contact_customer_id,
  channel: row.channel,
  purpose: row.purpose,
  kind: row.kind,
  recordedAt: row.recorded_at,
  consentWordingId: row.consent_wording_id,
  wordingHashHex: row.wording_hash_hex,
  captureSource: row.capture_source,
  captureActorKind: row.capture_actor_kind,
  captureActorLabel: row.capture_actor_label,
  captureLocale: row.capture_locale,
  createdAt: row.created_at,
})

const CONSENT_COLUMNS = `
  id, contact_customer_id, channel::text as channel, purpose, kind::text as kind, recorded_at,
  consent_wording_id, encode(wording_hash, 'hex') as wording_hash_hex, capture_source,
  capture_actor_kind, capture_actor_label, capture_locale, created_at
`

/**
 * Records one consent event. Never an update, whatever the event is.
 *
 * Idempotent on (contact, channel, purpose, kind, instant), which is `consent_one_record_per_instant`: a
 * double-submitted opt-in form is one record and the second call reports `recorded: false`. `kind` is in
 * that key deliberately, so a withdrawal recorded at the same instant as a grant is STORED rather than
 * discarded as a duplicate — the log is then ambiguous and `resolveConsent` fails closed to `unknown`,
 * which is safe and visible. A conflict rule that could silently drop a withdrawal is the one thing this
 * table exists to prevent.
 */
export async function recordConsent(
  uow: UnitOfWork,
  input: ConsentRecordInput,
): Promise<{ readonly recorded: boolean; readonly row: ConsentRow }> {
  const parsed = consentRecordSchema.safeParse(input)
  if (!parsed.success) {
    refuse('consent_capture_invalid', `Refusing to record this consent: ${parsed.error.message}`, {
      issues: parsed.error.issues,
    })
  }
  const record = parsed.data

  let rows: RawConsentRow[]
  try {
    rows = await uow.sql<RawConsentRow[]>`
      insert into consent
        (contact_customer_id, channel, purpose, kind, recorded_at, consent_wording_id, wording_hash,
         capture_source, capture_actor_kind, capture_actor_label, capture_locale)
      values (
        ${record.contactCustomerId}, ${record.channel}::message_channel, ${record.purpose},
        ${record.kind}::consent_kind, ${record.recordedAtIso}::timestamptz, ${record.wordingId},
        decode(${record.wordingHashHex}, 'hex'), ${record.capture.source},
        ${record.capture.actorKind}, ${record.capture.actorLabel}, ${record.capture.locale}
      )
      on conflict (contact_customer_id, channel, purpose, kind, recorded_at) do nothing
      returning ${uow.sql.unsafe(CONSENT_COLUMNS)}
    `
  } catch (error) {
    if (sqlstateOf(error) === CONSENT_SQLSTATE.wordingHashMismatch) {
      refuse(
        'consent_wording_hash_mismatch',
        `The wording hash this record snapshots does not match consent_wording ${record.wordingId}. ` +
          'Re-read the version and record again: either a newer version was published between the ' +
          'render and the write, or the stored wording has been altered.',
        { wordingId: record.wordingId, sqlstate: CONSENT_SQLSTATE.wordingHashMismatch },
      )
    }
    if (sqlstateOf(error) === '23503') {
      refuse(
        'consent_wording_not_found',
        `consent_wording ${record.wordingId} does not exist, or '${record.purpose}' is not a consent ` +
          'purpose.',
        { wordingId: record.wordingId, purpose: record.purpose },
      )
    }
    throw error
  }

  const inserted = rows[0]
  if (inserted === undefined) {
    // The conflict arm. Read the row that won rather than reporting nothing: a caller retrying a form
    // submission needs the record, and a `null` here would send it round again.
    const existing = await uow.sql<RawConsentRow[]>`
      select ${uow.sql.unsafe(CONSENT_COLUMNS)} from consent
       where contact_customer_id = ${record.contactCustomerId}
         and channel = ${record.channel}::message_channel
         and purpose = ${record.purpose}
         and kind = ${record.kind}::consent_kind
         and recorded_at = ${record.recordedAtIso}::timestamptz
    `
    const row = existing[0]
    if (row === undefined) {
      throw new AppError(
        'invariant_violated',
        'A consent insert conflicted and the conflicting row cannot be read back. Nothing deletes from ' +
          'this table, so the row that caused the conflict must still be there.',
        { details: { contactCustomerId: record.contactCustomerId, purpose: record.purpose } },
      )
    }
    // No audit row on the no-op, the way `addCustomerTag` writes none: an audit trail that records a
    // retry as a change makes every duplicate submission look like a second decision.
    return { recorded: false, row: toConsent(row) }
  }

  await uow.audit.record({
    action: CONSENT_AUDIT_ACTIONS.recorded,
    entityType: 'consent',
    entityId: inserted.id,
    operation: 'create',
    after: {
      contact_customer_id: inserted.contact_customer_id,
      channel: inserted.channel,
      purpose: inserted.purpose,
      kind: inserted.kind,
      recorded_at: inserted.recorded_at,
      consent_wording_id: inserted.consent_wording_id,
      capture_source: inserted.capture_source,
      capture_actor_kind: inserted.capture_actor_kind,
      capture_locale: inserted.capture_locale,
    },
  })
  return { recorded: true, row: toConsent(inserted) }
}

/**
 * Withdraws consent. A NEW row with `kind: 'withdrawn'`, and the granting row is left untouched.
 *
 * A thin wrapper over {@link recordConsent} rather than its own statement, so the capture context, the
 * zod contract and the idempotence are the same ones a grant goes through — a withdrawal path with its
 * own INSERT is a second place for a rule to be missing. The wording reference is optional here and
 * mandatory for a grant; `consentRecordSchema` states why.
 */
export async function withdrawConsent(
  uow: UnitOfWork,
  input: Omit<ConsentRecordInput, 'kind'>,
): Promise<{ readonly recorded: boolean; readonly row: ConsentRow }> {
  return recordConsent(uow, { ...input, kind: 'withdrawn' })
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

/**
 * The log `resolveConsent` in `@berelax/core` takes, for one contact.
 *
 * Mirrors `ConsentLog` there. `packages/db` may not import `packages/core`, so this is the second
 * declaration of one shape and `packages/fixtures/src/consent.itest.ts` asserts the two with `satisfies`
 * rather than describing the agreement in a comment.
 */
export interface ConsentLogRead {
  readonly contactId: string
  readonly records: readonly {
    readonly id: string
    readonly channel: string
    readonly purpose: string
    readonly kind: 'granted' | 'withdrawn'
    /** Epoch milliseconds, which is what `Instant` is. A `Date` here would need a cast in core. */
    readonly recordedAt: number
    readonly wordingId: string | null
  }[]
  readonly wordingVersions: readonly {
    readonly id: string
    readonly purpose: string
    readonly version: number
    readonly contentHashHex: string
  }[]
}

/**
 * Reads one contact's whole consent log, plus every wording version its records name.
 *
 * **Not capped.** `settingHistory` takes a `limit` and `settings-store.itest.ts` records what that cost:
 * a delta read through a capped reader over an append-only table pinned at the cap and three recorded
 * changes read as zero (brief rule 12). The consent log decides whether a message may be sent, and a
 * resolver handed the newest 20 of 400 rows would resolve a stale answer with no symptom. A limit is
 * right for a panel and wrong for a fold.
 *
 * The wording versions are the ones the log REFERENCES rather than all of them, and the join is on the
 * record's own `consent_wording_id`: a version published after these records were written is not
 * evidence about them, and including it would let a later publication change what an old record resolves
 * to.
 */
export async function readConsentLog(sql: Sql, contactId: string): Promise<ConsentLogRead> {
  const records = await sql<
    {
      id: string
      channel: string
      purpose: string
      kind: 'granted' | 'withdrawn'
      recorded_at_ms: string
      consent_wording_id: string | null
    }[]
  >`
    select id, channel::text as channel, purpose, kind::text as kind,
           (extract(epoch from recorded_at) * 1000)::bigint::text as recorded_at_ms,
           consent_wording_id
      from consent where contact_customer_id = ${contactId}
      order by recorded_at, id
  `

  const versions = await sql<
    { id: string; purpose: string; version: number; content_hash_hex: string }[]
  >`
    select w.id, w.purpose, w.version, encode(w.content_hash, 'hex') as content_hash_hex
      from consent_wording w
     where w.id in (select consent_wording_id from consent
                     where contact_customer_id = ${contactId} and consent_wording_id is not null)
     order by w.purpose, w.version
  `

  return {
    contactId,
    records: records.map((row) => ({
      id: row.id,
      channel: row.channel,
      purpose: row.purpose,
      kind: row.kind,
      recordedAt: Number(row.recorded_at_ms),
      wordingId: row.consent_wording_id,
    })),
    wordingVersions: versions.map((row) => ({
      id: row.id,
      purpose: row.purpose,
      version: row.version,
      contentHashHex: row.content_hash_hex,
    })),
  }
}

/**
 * The logs for a set of contacts, in two queries whatever the size of the set.
 *
 * What a campaign prefetches before building the gate's consent evaluator. Two round trips — the records,
 * then the wording versions those records name — rather than two per recipient: a 400-contact campaign
 * calling {@link readConsentLog} in a loop is 800 sequential queries, and the first symptom is a send run
 * that takes minutes with nothing to point at.
 *
 * **Every contact asked about gets an entry, including one with no rows at all.** The distinction is
 * load-bearing and it is the reason this returns a `Map` keyed on every input rather than only on the
 * contacts that had records: `consentGateEvaluator` throws for a recipient it has no log for, because an
 * unread log is not a refusal, and an absent entry for a contact who genuinely has no records would turn
 * "never asked" into `blocked_unevaluable`. The two are different operational events and only one of them
 * is a bug.
 */
export async function readConsentLogs(
  sql: Sql,
  contactIds: readonly string[],
): Promise<ReadonlyMap<string, ConsentLogRead>> {
  const wanted = [...new Set(contactIds)]
  const logs = new Map<string, ConsentLogRead>()
  // Seeded with an empty log per contact FIRST, so a contact with no rows is present rather than missing.
  for (const contactId of wanted) {
    logs.set(contactId, { contactId, records: [], wordingVersions: [] })
  }
  if (wanted.length === 0) return logs

  const records = await sql<
    {
      contact_customer_id: string
      id: string
      channel: string
      purpose: string
      kind: 'granted' | 'withdrawn'
      recorded_at_ms: string
      consent_wording_id: string | null
    }[]
  >`
    select contact_customer_id, id, channel::text as channel, purpose, kind::text as kind,
           (extract(epoch from recorded_at) * 1000)::bigint::text as recorded_at_ms,
           consent_wording_id
      from consent where contact_customer_id = any(${wanted}::uuid[])
      order by contact_customer_id, recorded_at, id
  `
  const versions = await sql<
    { id: string; purpose: string; version: number; content_hash_hex: string }[]
  >`
    select w.id, w.purpose, w.version, encode(w.content_hash, 'hex') as content_hash_hex
      from consent_wording w
     where w.id in (select consent_wording_id from consent
                     where contact_customer_id = any(${wanted}::uuid[])
                       and consent_wording_id is not null)
     order by w.purpose, w.version
  `
  const allVersions = versions.map((row) => ({
    id: row.id,
    purpose: row.purpose,
    version: row.version,
    contentHashHex: row.content_hash_hex,
  }))

  const byContact = new Map<string, ConsentLogRead['records'][number][]>()
  for (const row of records) {
    const list = byContact.get(row.contact_customer_id) ?? []
    list.push({
      id: row.id,
      channel: row.channel,
      purpose: row.purpose,
      kind: row.kind,
      recordedAt: Number(row.recorded_at_ms),
      wordingId: row.consent_wording_id,
    })
    byContact.set(row.contact_customer_id, list)
  }
  for (const [contactId, list] of byContact) {
    // The version list is the union across the whole set rather than per contact. That is safe and it is
    // deliberate: `resolveConsent` looks a version up by the id its own record names, so a version another
    // contact granted under is unreachable for this one — and splitting it per contact would be a second
    // grouping pass to produce an answer no caller can tell apart.
    logs.set(contactId, { contactId, records: list, wordingVersions: allVersions })
  }
  return logs
}

/** One contact's id and the phone number a send is addressed to, for building the evaluator's map. */
export interface ConsentContactByPhone {
  readonly contactId: string
  readonly phoneE164: string
}

/**
 * Resolves E.164 recipients to contact ids.
 *
 * The join the send path needs and the one place it exists: `message.recipient` is an E.164 number for
 * sms and whatsapp, `customer.phone_e164` IS the identity (ADR 0014), and the consent record is keyed on
 * the customer id. A recipient with no customer row is simply absent from the answer, which is what makes
 * the evaluator throw for it rather than quietly treat it as un-consented.
 *
 * There is no email equivalent, because `customer` has no email column — C-CRM-01's NOTE (3) records
 * that nothing in the build collects one. Email consent rows can be stored and resolved; addressing a
 * send by address is C-CRM-04's, which hashes recipients under a pepper.
 */
export async function readContactsByPhone(
  sql: Sql,
  phoneNumbers: readonly string[],
): Promise<readonly ConsentContactByPhone[]> {
  if (phoneNumbers.length === 0) return []
  const rows = await sql<{ id: string; phone_e164: string }[]>`
    select id, phone_e164 from customer
     where phone_e164 = any(${[...phoneNumbers]}::text[])
  `
  return rows.map((row) => ({ contactId: row.id, phoneE164: row.phone_e164 }))
}

/**
 * Consent rows whose snapshotted wording hash no longer equals the referenced version's.
 *
 * Empty is the only acceptable answer, and the query exists because the tampering it detects is
 * otherwise invisible. `consent_wording.content_hash` is GENERATED, so altering the text moves the hash
 * with it and the wording row stays internally consistent; the consent rows pointing at it are the only
 * place the original hash survives. An UPDATE to the wording needs the refusal trigger disabled as the
 * table's owner, which is not a thing the application can do — so a non-empty answer here means somebody
 * with database ownership edited a published consent statement, which is exactly the event PDPL and TDRA
 * would want reported.
 */
export interface ConsentIntegrityBreach {
  readonly consentId: string
  readonly consentWordingId: string
  readonly snapshotHashHex: string
  readonly currentHashHex: string
}

export async function consentWordingIntegrity(
  sql: Sql,
): Promise<readonly ConsentIntegrityBreach[]> {
  const rows = await sql<
    {
      consent_id: string
      consent_wording_id: string
      snapshot_hash_hex: string
      current_hash_hex: string
    }[]
  >`
    select c.id as consent_id,
           c.consent_wording_id,
           encode(c.wording_hash, 'hex') as snapshot_hash_hex,
           encode(w.content_hash, 'hex') as current_hash_hex
      from consent c
      join consent_wording w on w.id = c.consent_wording_id
     where c.wording_hash <> w.content_hash
     order by c.recorded_at, c.id
  `
  return rows.map((row) => ({
    consentId: row.consent_id,
    consentWordingId: row.consent_wording_id,
    snapshotHashHex: row.snapshot_hash_hex,
    currentHashHex: row.current_hash_hex,
  }))
}

/** A purpose as the vocabulary holds it, including whether a promotional send may be gated on it. */
export interface ConsentPurposeRecord {
  readonly purpose: string
  readonly displayOrder: number
  readonly description: string
  readonly isSendGating: boolean
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
}

export async function readConsentPurposes(sql: Sql): Promise<readonly ConsentPurposeRecord[]> {
  const rows = await sql<
    {
      purpose: string
      display_order: number
      description: string
      is_send_gating: boolean
      is_provisional: boolean
      open_question_id: string | null
      provisional_note: string | null
    }[]
  >`
    select purpose, display_order, description, is_send_gating, is_provisional, open_question_id,
           provisional_note
      from consent_purpose order by display_order
  `
  return rows.map((row) => ({
    purpose: row.purpose,
    displayOrder: row.display_order,
    description: row.description,
    isSendGating: row.is_send_gating,
    isProvisional: row.is_provisional,
    openQuestionId: row.open_question_id,
    provisionalNote: row.provisional_note,
  }))
}

/**
 * How many consent rows exist per (channel, purpose, kind), counted in SQL.
 *
 * Counted in SQL and never through a reader with a limit, for the reason brief rule 12 records about
 * `app_setting_history`: both sides of a delta over an append-only table pin at the cap, and three
 * recorded changes read as zero. Used by the seed's coverage assertion, which is a claim about what
 * exists rather than about what a panel shows.
 */
export async function consentStateCounts(sql: Sql): Promise<
  readonly {
    readonly channel: string
    readonly purpose: string
    readonly kind: string
    readonly contacts: number
  }[]
> {
  const rows = await sql<{ channel: string; purpose: string; kind: string; contacts: string }[]>`
    select channel::text as channel, purpose, kind::text as kind,
           count(distinct contact_customer_id)::text as contacts
      from consent group by channel, purpose, kind
      order by channel, purpose, kind
  `
  return rows.map((row) => ({
    channel: row.channel,
    purpose: row.purpose,
    kind: row.kind,
    contacts: Number(row.contacts),
  }))
}
