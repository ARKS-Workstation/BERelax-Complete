import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { SuppressionPepper } from '../repositories/suppression.ts'
import { suppressionKey } from '../repositories/suppression.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The writes H-MIG-04 owns: one customer resolved or created from a reconstructed contact list, and the
 * record of what each line of that list became.
 *
 * `packages/migration` is the importer and may import `@berelax/db` and `@berelax/shared` and nothing else
 * first-party (H-MIG-01's `index.ts` states that as a hard constraint). So the domain writes are here and
 * the importer's `apply` is a resolution of names followed by two calls into this file.
 *
 * ## The consent floor, which is the whole unit, and where it is kept
 *
 * **A list rebuilt from WhatsApp history and phone contacts is not consent** (docs/11 §7). Nothing in this
 * file writes to `consent`, and there is deliberately no parameter anywhere in it that could: the floor is
 * not a flag set to `false`, because 0056 made consent an append-only LOG and in that model "no marketing
 * consent" is the ABSENCE of a row — not a `false`, and specifically not a `withdrawn` row either, since
 * nobody withdrew anything and nobody was ever asked.
 *
 * An importer that simply does not call `recordConsent` is a promise, though, and a promise is what a
 * later unit, a job or a `psql` session can break without touching this file. So the enforceable statement
 * of the floor is a refusal in the database: **ZY271** refuses a GRANTED consent row whose
 * `capture_source` is `'import'` on any purpose that gates a send. `0121_customer_import.sql`'s header has
 * the argument and names the door it deliberately leaves open for a lawfully collected external opt-in.
 *
 * What the import does with a source row that CLAIMS consent is record that the claim was discarded —
 * `imported_contact.consent_claim_discarded`, plus an audit row — because the claim is evidence about the
 * list this business was handed, and a reconstruction that silently dropped it would leave nothing to show
 * the assertion had been considered and refused.
 *
 * ## Why the digest is computed here and the number is not stored
 *
 * `0121`'s header answers Y9-import-ledger: the staging ledger keeps `import_row.payload` for ever, with
 * no DELETE grant anywhere in `import_staging`, and `jsonb` is invisible to all five of C-CRM-10's
 * catalogue probes — so a phone number staged there is not retained, it is unreachable. The import
 * therefore stages `HMAC-SHA256` of the number under the suppression pepper and the plaintext lives in
 * exactly one place, `customer.phone_e164`, which an erasure pseudonymises.
 *
 * {@link importContactHmac} is the one place that digest is computed, and it is a thin wrapper over
 * {@link suppressionKey} rather than its own HMAC: one implementation of one keyed digest, under key kinds
 * of this unit's own so the two key spaces stay disjoint. The kind is in the HMAC input (0064), which is
 * what stops a cell that happens to read like a number keying the same as a number.
 */

/**
 * The SQLSTATEs `0121_customer_import.sql` raises.
 *
 * Every code is allocated in `packages/db/src/sqlstate-registry.ts` (ADR 0043) and every entry there names
 * THIS file as its translator, which is why no other module holds one as a literal: `pnpm sqlstate` checks
 * the translator list in both directions, so a second module carrying a code fails the build until the
 * registry names it too.
 *
 * The match is on SQLSTATE alone. Matching on the message would make the translation depend on wording,
 * and a reworded message would silently stop translating — after which the caller that treats "an import
 * cannot produce an opt-in" as an unknown failure is the caller that retries it.
 */
export const IMPORT_CONTACT_SQLSTATE = {
  /** A GRANTED send-gating consent row was captured with `capture_source = 'import'`. */
  importIsNotAnOptIn: 'ZY271',
  /** An imported-contact record was updated or deleted. */
  importedContactImmutable: 'ZY272',
  /** An imported-contact record's outcome disagrees with what its import wrote. Raised at COMMIT. */
  outcomeDisagreesWithTheImport: 'ZY273',
} as const

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a refusal from `0121_customer_import.sql` into an `AppError`, or `null` for anything else.
 *
 * The KINDS are chosen by what the caller has to go and do, which is the only question a kind answers:
 *
 *   - `forbidden` for ZY271 and ZY272 — neither statement will ever be permitted, for any caller, with any
 *     data. An imported grant needs its wording published and this trigger changed by a migration; a
 *     corrected import record is a new import against the corrected file.
 *   - `invariant_violated` for ZY273 — this code, not the person running the import, wrote a record whose
 *     outcome does not describe what the import did. A validation failure would send whoever reads it
 *     looking at the contact list, which is the one place the defect is not.
 */
export function importContactError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code }
  switch (code) {
    case IMPORT_CONTACT_SQLSTATE.importIsNotAnOptIn:
    case IMPORT_CONTACT_SQLSTATE.importedContactImmutable:
      return new AppError('forbidden', message, { details })
    case IMPORT_CONTACT_SQLSTATE.outcomeDisagreesWithTheImport:
      return new AppError('invariant_violated', message, { details })
    default:
      return null
  }
}

export const isImportIsNotAnOptInRefusal = (err: unknown): boolean =>
  sqlState(err) === IMPORT_CONTACT_SQLSTATE.importIsNotAnOptIn

/**
 * The audit action this file writes. ONE, and the three that are deliberately absent are the point.
 *
 * `consentClaimDiscarded` is the "logged override" H-MIG-04's first acceptance line asks for, and nothing
 * else in the build records it. It carries the imported-contact record and not the number: an audit row is
 * retained for ever, and a phone number in one would be the second unerasable copy this unit's whole
 * decision is about.
 *
 * A customer CREATED, a customer MATCHED and a line QUARANTINED are not audited here, because they are
 * already recorded twice: H-MIG-01's framework writes one `migration.row.imported` audit row per staged
 * row naming every entity that row produced, and `imported_contact.outcome` is the column ZY273 holds to
 * those same facts. A third statement would drift from both, and at two thousand lines it would also be
 * four thousand audit rows saying what two already say.
 */
export const IMPORT_CONTACT_AUDIT_ACTIONS = {
  consentClaimDiscarded: 'migration.contact.consent_claim_discarded',
} as const

/**
 * The key kinds this unit's digests are computed under, and why they are not `'phone'`.
 *
 * `'phone'` is `suppression.key_kind`'s value, so using it here would make a staged digest literally a
 * suppression key — one table's rows joinable to another's by a reader who needed neither. The kind is IN
 * the HMAC input for exactly this reason (0064), so two kinds keep the two key spaces disjoint at no cost.
 *
 * The two kinds here are disjoint from each other for the same reason: a quarantined line keys the CELL as
 * typed, which may happen to read like a number, and it must not collide with the digest of a number.
 */
export const IMPORT_CONTACT_KEY_KINDS = {
  /** A canonical E.164 number, for a line that was read. */
  number: 'import_contact_phone',
  /** The cell exactly as the file held it, for a line that was not. */
  cell: 'import_contact_cell',
} as const

export type ImportContactKeyKind =
  (typeof IMPORT_CONTACT_KEY_KINDS)[keyof typeof IMPORT_CONTACT_KEY_KINDS]

/**
 * The keyed digest one line of a contact list is staged and recorded under.
 *
 * The HMAC input is the JSON encoding of the value rather than the value, and that is a correctness fix
 * rather than a style: {@link suppressionKey} refuses a value containing U+001F, which is the separator it
 * puts between the kind and the value, and a cell out of a contact export may hold anything. `JSON.stringify`
 * is injective and escapes U+001F as `\u001f`, so every cell can be keyed and no two different cells can
 * produce one digest. Applied to both kinds, so there is one rule rather than a special case.
 */
export function importContactHmac(
  pepper: SuppressionPepper,
  keyKind: ImportContactKeyKind,
  value: string,
): string {
  return suppressionKey(pepper, keyKind, JSON.stringify(value))
}

/** What happened to one line of a reconstructed contact list. Mirrors `imported_contact.outcome`. */
export const IMPORTED_CONTACT_OUTCOMES = ['created', 'matched', 'quarantined'] as const
export type ImportedContactOutcome = (typeof IMPORTED_CONTACT_OUTCOMES)[number]

export interface ResolvedImportedCustomer {
  readonly customerId: string
  /** True when THIS call is why the row exists. The import's distinct count is the number of these. */
  readonly created: boolean
}

/**
 * Finds the customer this number already belongs to, or creates one with no consent of any kind.
 *
 * `on conflict (phone_e164) do nothing` and then a read, which is the arrangement the consent seed uses
 * and for its stated reason: the row IS the customer's identity (ADR 0014), and an import has no business
 * rewriting a locale or an origin that somebody may have corrected since. So a number that already
 * resolves — because an earlier line of this same file created it, because an earlier import did, or
 * because the person has walked in and booked since — is MATCHED and left exactly as it is.
 *
 * That is also the dedup. The unique index on `phone_e164` is what makes two spellings of one number one
 * customer (0019: "two spellings of one number must collide on insert rather than produce two customers
 * whose history, package balance and contraindication flags each hold half the truth"), and this function
 * is the only place the import relies on it. `planContactImport` in `@berelax/migration` forecasts the
 * same count from the file alone; the database is the authority and the forecast is held to it by
 * `customer-import.itest.ts`.
 *
 * `created_via = 'import'` is not configurable here, and the parameter list is the point: there is nowhere
 * to pass a display name, a locale other than the column's default, or anything resembling a consent. A
 * name typed into somebody's phone contacts is not a name this system may publish (ADR 0020), and the
 * acceptance line this unit is about would be unprovable if the shape of this call could carry one.
 */
export async function resolveOrCreateImportedCustomer(
  uow: UnitOfWork,
  phoneE164: string,
): Promise<ResolvedImportedCustomer> {
  const inserted = await uow.sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via)
    values (${phoneE164}, 'import')
    on conflict (phone_e164) do nothing
    returning id
  `
  const created = inserted[0]
  if (created !== undefined) return { customerId: created.id, created: true }

  const existing = await uow.sql<{ id: string }[]>`
    select id from customer where phone_e164 = ${phoneE164}
  `
  const row = existing[0]
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'A customer insert conflicted on phone_e164 and the conflicting row cannot be read back. The ' +
        'import deletes nothing, so the row that caused the conflict must still be there — unless ' +
        'another transaction removed it between the two statements.',
      { details: { refusal: 'imported_contact_conflict_unreadable' } },
    )
  }
  return { customerId: row.id, created: false }
}

export interface ImportedContactInput {
  /** From {@link importContactHmac}. Never a number. */
  readonly contactHmac: string
  readonly pepperVersion: string
  readonly outcome: ImportedContactOutcome
  /** One of `E164_IDENTITY_REJECTIONS`, required for `quarantined` and refused for the others. */
  readonly quarantineReason?: string | null
  /** True when the source row asserted a marketing consent. The claim is recorded, never honoured. */
  readonly consentClaimDiscarded: boolean
}

/**
 * Records what one line of a reconstructed contact list became.
 *
 * One row per staged line, always — 0119's arrangement and its reason: the record that ALWAYS exists is
 * what gives every staged row exactly one provenance target, which matters here because
 * `import_provenance_one_per_target` would refuse a second line's claim on the customer the first line
 * created, and ZY196 would refuse the COMMIT of an applied row that recorded nothing at all.
 *
 * The ONE audit row it may write says a consent claim was discarded, and it carries this record's id and
 * not the number — see {@link IMPORT_CONTACT_AUDIT_ACTIONS} for what is deliberately not audited here and
 * why. A count of discarded claims is then a count of rows rather than a scan of payloads.
 */
export async function recordImportedContact(
  uow: UnitOfWork,
  input: ImportedContactInput,
): Promise<string> {
  const reason = input.quarantineReason ?? null
  const rows = await uow.sql<{ id: string }[]>`
    insert into imported_contact
      (contact_hmac, pepper_version, outcome, quarantine_reason, consent_claim_discarded)
    values (
      ${input.contactHmac}, ${input.pepperVersion}, ${input.outcome}, ${reason},
      ${input.consentClaimDiscarded}
    )
    returning id
  `
  const id = rows[0]?.id
  if (id === undefined) {
    throw new AppError(
      'invariant_violated',
      'The imported-contact insert returned no row, which cannot happen for an INSERT ... RETURNING ' +
        'that did not raise. Treated as a failure rather than ignored: the alternative is an applied ' +
        'row whose provenance nobody holds an id for.',
    )
  }

  if (input.consentClaimDiscarded) {
    await uow.audit.record({
      action: IMPORT_CONTACT_AUDIT_ACTIONS.consentClaimDiscarded,
      entityType: 'imported_contact',
      entityId: id,
      operation: 'create',
      after: {
        outcome: input.outcome,
        // Spelled out rather than left implicit: this row is the record that a list asserted an opt-in
        // and that nothing was written to `consent` because of it.
        consent_rows_written: 0,
        refused_by: IMPORT_CONTACT_SQLSTATE.importIsNotAnOptIn,
      },
    })
  }

  return id
}

export interface ImportedContactCounts {
  readonly created: number
  readonly matched: number
  readonly quarantined: number
  readonly consentClaimsDiscarded: number
}

/**
 * The counts an import report and the liability of this unit's acceptance are read off.
 *
 * Counted in SQL and not by reading rows into the process, for `settings-store.itest.ts`'s recorded
 * reason: this table only grows, so a capped reader would pin both sides of a delta at its limit and
 * three recorded imports would read as zero. A suite asserts a DELTA across an import (brief rule 9),
 * which is why this returns totals rather than trying to scope itself to a run — a run scope would need a
 * join through provenance that the caller can make when it wants one.
 */
export async function readImportedContactCounts(sql: Sql): Promise<ImportedContactCounts> {
  const rows = await sql<
    { created: string; matched: string; quarantined: string; claims: string }[]
  >`
    select count(*) filter (where outcome = 'created')::text     as created,
           count(*) filter (where outcome = 'matched')::text     as matched,
           count(*) filter (where outcome = 'quarantined')::text as quarantined,
           count(*) filter (where consent_claim_discarded)::text as claims
      from imported_contact
  `
  const row = rows[0]
  return {
    created: Number(row?.created ?? '0'),
    matched: Number(row?.matched ?? '0'),
    quarantined: Number(row?.quarantined ?? '0'),
    consentClaimsDiscarded: Number(row?.claims ?? '0'),
  }
}

/**
 * Every imported-contact record for one customer's number, newest first.
 *
 * The read that answers "which lines of which lists is this person from", and the reason the digest is
 * what links them: there is no `customer_id` on `imported_contact` (0119's reason about a merge
 * re-pointing the one copy that exists), so the link is recomputed from `customer.phone_e164`.
 *
 * It therefore stops resolving once that number is pseudonymised, which is correct and not a limitation:
 * after an erasure the lines of the list are still evidence that an import happened, and the person they
 * were about is no longer in this database to be joined to.
 */
export async function readImportedContactsForNumber(
  sql: Sql,
  pepper: SuppressionPepper,
  phoneE164: string,
): Promise<readonly { readonly id: string; readonly outcome: string }[]> {
  const hmac = importContactHmac(pepper, IMPORT_CONTACT_KEY_KINDS.number, phoneE164)
  return sql<{ id: string; outcome: string }[]>`
    select id, outcome from imported_contact
     where contact_hmac = ${hmac}
     order by created_at desc, id desc
  `
}
