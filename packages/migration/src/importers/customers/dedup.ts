import type { SuppressionPepper } from '@berelax/db'
import { IMPORT_CONTACT_KEY_KINDS, importContactHmac } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { StagedSourceRow } from '../../framework.ts'
import type { ContactCell } from './workbook.ts'

/**
 * The minimised staged payload, the dedup it makes possible, and the forecast of what an import will do.
 *
 * ## The payload is a digest, and this is the module that makes sure it stays one
 *
 * `0121_customer_import.sql`'s header answers `Y9-import-ledger` and this file is where the answer is
 * carried out. In one sentence: the staging ledger keeps `import_row.payload` for ever — append-only by
 * ZY192, with no role holding DELETE anywhere in `import_staging`, and `jsonb` invisible to all five of
 * C-CRM-10's catalogue probes — so a phone number staged there is not retained against an obligation, it
 * is unreachable. Nothing can erase it and nothing can even find it.
 *
 * So the number does not go in. {@link stageContactCell} produces a payload of exactly four keys: a keyed
 * digest, the label of the pepper that keyed it, the consent claim as a boolean, and — only for a line
 * that could not be read — the reason. The plaintext number lives in `customer.phone_e164` and nowhere
 * else, and {@link planContactImport} hands it back to the caller in memory, for the duration of one run,
 * so `apply` can insert the customer without the ledger ever holding it.
 *
 * {@link MINIMISED_PAYLOAD_KEYS} is what makes that a CHECK rather than a convention: the importer's
 * `validate` refuses a payload carrying any other key, by name, at staging time and over every row. So a
 * later change that put the number back in the payload does not quietly work — it rejects the whole file
 * and names the rule it broke.
 *
 * ## Why the dedup here is a FORECAST and the unique index is the authority
 *
 * Two source lines spelling one number are one customer. That is decided by the unique index on
 * `customer.phone_e164` (0019: "two spellings of one number must collide on insert rather than produce
 * two customers whose history, package balance and contraindication flags each hold half the truth"), and
 * `resolveOrCreateImportedCustomer` is the only place the import relies on it.
 *
 * What this module computes is the same count from the FILE alone, before anything is written, because
 * that is what an operator needs in order to decide whether to run the import at all: 2,000 lines naming
 * 1,760 people is a fact about the list, and a dry run reports it. It can disagree with the database in
 * exactly one direction — a number this file names that is ALREADY a customer counts as distinct here and
 * imports as `matched` — and that is not a drift, it is the difference between "how many people is this
 * list about" and "how many records did it create". `customer-import.itest.ts` holds the two together on
 * a fresh list, where they must agree exactly.
 *
 * ## Why the plan does not de-duplicate the staged rows
 *
 * Every line of the file is staged, repeats included, and H-MIG-02's reason carries over: a parser that
 * dropped one of two rows would make the staged ledger disagree with the file it is supposed to be
 * evidence of. The repeat is applied too, as an `imported_contact` record with outcome `matched` —
 * because `import_provenance_one_per_target` refuses a second claim on the customer the first line
 * created, and ZY196 refuses the COMMIT of an applied row that recorded nothing at all.
 */

/** The keys a staged contact payload may carry, and nothing else. */
export const MINIMISED_PAYLOAD_KEYS = [
  'contactHmac',
  'pepperVersion',
  'sourceConsentClaim',
  'quarantineReason',
] as const
export type MinimisedPayloadKey = (typeof MINIMISED_PAYLOAD_KEYS)[number]

/**
 * What a contact line stages. Four keys, three of them always present.
 *
 * `quarantineReason` is absent rather than null for a line that was read, because `canonicalise` in
 * `../../provenance.ts` drops an absent key and would hash a null — so an absent key and a null one are
 * two different row hashes for one fact, and idempotence is decided on that hash.
 */
export interface StagedContactPayload {
  readonly contactHmac: string
  readonly pepperVersion: string
  readonly sourceConsentClaim: boolean
  readonly quarantineReason?: string
}

/**
 * The normaliser, injected. Strings, because the vocabulary is `@berelax/core`'s.
 *
 * `packages/migration` may import `@berelax/db` and `@berelax/shared` and nothing else first-party
 * (H-MIG-01 states it as a hard constraint and gives the reason: there is no calculation in this package,
 * and the importer that needs one takes the answer as an argument). `e164IdentityResult` lives in
 * `@berelax/core`, so it arrives as a parameter — the same arrangement `SuppressionKeyNormaliser` uses in
 * `packages/db/src/repositories/suppression.ts`, for the same reason.
 *
 * There is deliberately NO default. That module's own note says why: "an un-normalised key matches
 * nothing, and because the plaintext never reaches a column no constraint can catch it — the row would
 * look perfectly valid and suppress nobody." Here the equivalent default would be an identity function,
 * and it would key every spelling of one number separately and import one person four times.
 */
export type ContactNormaliser = (
  raw: string,
) =>
  | { readonly ok: true; readonly e164: string; readonly messageable: boolean }
  | { readonly ok: false; readonly reason: string }

export interface ContactKeying {
  readonly pepper: SuppressionPepper
  readonly normalise: ContactNormaliser
}

/** One line, staged: the payload the ledger keeps, and the plaintext it deliberately does not. */
export interface StagedContact {
  readonly lineNumber: number
  readonly payload: StagedContactPayload
  /** The canonical number, for `apply` and for nothing that writes. `null` for a quarantined line. */
  readonly e164: string | null
  /** False for a landline and a toll-free line. Reported by the plan; never stored. */
  readonly messageable: boolean
}

/**
 * Normalises and keys one cell, producing the payload that may be staged.
 *
 * The digest is {@link importContactHmac}'s, under this unit's own key kinds, and which kind is used
 * follows from whether the cell could be read: a canonical number under `import_contact_phone`, a cell
 * that could not be read under `import_contact_cell`. Two kinds, so a cell that happens to look like a
 * number cannot key the same as a number — the reason the kind is part of the HMAC input at all (0064).
 */
export function stageContactCell(keying: ContactKeying, cell: ContactCell): StagedContact {
  if (typeof keying.normalise !== 'function') {
    throw new AppError(
      'invariant_violated',
      'No phone normaliser was injected, so nothing produced a comparable contact key. Wire ' +
        '`e164IdentityResult` from @berelax/core. There is no fallback on purpose: an un-normalised key ' +
        'keys every spelling of one number separately, and because the plaintext never reaches the ' +
        'ledger no constraint can catch it — the import would create one person four times and look ' +
        'entirely correct.',
    )
  }
  const normalised = keying.normalise(cell.phoneAsListed)
  if (!normalised.ok) {
    return {
      lineNumber: cell.lineNumber,
      payload: {
        contactHmac: importContactHmac(
          keying.pepper,
          IMPORT_CONTACT_KEY_KINDS.cell,
          cell.phoneAsListed,
        ),
        pepperVersion: keying.pepper.version,
        sourceConsentClaim: cell.sourceConsentClaim,
        quarantineReason: normalised.reason,
      },
      e164: null,
      messageable: false,
    }
  }
  return {
    lineNumber: cell.lineNumber,
    payload: {
      contactHmac: importContactHmac(
        keying.pepper,
        IMPORT_CONTACT_KEY_KINDS.number,
        normalised.e164,
      ),
      pepperVersion: keying.pepper.version,
      sourceConsentClaim: cell.sourceConsentClaim,
    },
    e164: normalised.e164,
    messageable: normalised.messageable,
  }
}

/** What an import of this file would do, counted from the file alone. */
export interface ContactImportPlan {
  /** Every line, in file order, repeats included. One `StagedSourceRow` each. */
  readonly rows: readonly StagedSourceRow[]
  readonly lines: number
  /** Distinct readable numbers — the count of customers a FRESH import of this file creates. */
  readonly distinct: number
  /** Lines whose number a line above already named. */
  readonly repeated: number
  /** Lines whose cell could not be read, by reason. */
  readonly quarantined: number
  readonly quarantinedByReason: Readonly<Record<string, number>>
  /**
   * Distinct numbers nothing can send to: a landline or a toll-free line.
   *
   * Reported because it is the figure that surprises somebody: these contacts import, they are real
   * customers, and a reminder for their next appointment will never reach them. It is NOT a reason to
   * refuse the row — see `packages/core/src/identity/e164.ts` on why identity and SMS targeting are two
   * questions — and it is deliberately not stored, because it is derivable from the number.
   */
  readonly unmessageable: number
  /** Lines whose source claimed a marketing consent. Every one of them is discarded. */
  readonly consentClaims: number
  /** The canonical number for each distinct digest, for `apply`. In memory, for one run. */
  readonly plaintextByHmac: ReadonlyMap<string, string>
}

/**
 * The plan: every line staged, the distinct count, and the plaintext map `apply` resolves through.
 *
 * Pure, so the property test can generate thousands of files and assert over the plan with nothing
 * running — and so that the one claim this unit cannot make at the database (that no staged payload
 * contains any digit of the source) is assertable at all.
 */
export function planContactImport(
  keying: ContactKeying,
  cells: readonly ContactCell[],
): ContactImportPlan {
  const rows: StagedSourceRow[] = []
  const plaintextByHmac = new Map<string, string>()
  const quarantinedByReason: Record<string, number> = {}
  const seen = new Set<string>()
  let repeated = 0
  let quarantined = 0
  let unmessageable = 0
  let consentClaims = 0

  for (const cell of cells) {
    const staged = stageContactCell(keying, cell)
    rows.push({ lineNumber: staged.lineNumber, payload: { ...staged.payload } })
    if (cell.sourceConsentClaim) consentClaims += 1
    const reason = staged.payload.quarantineReason
    if (reason !== undefined) {
      quarantined += 1
      quarantinedByReason[reason] = (quarantinedByReason[reason] ?? 0) + 1
      continue
    }
    if (staged.e164 === null) continue
    if (seen.has(staged.payload.contactHmac)) {
      repeated += 1
      continue
    }
    seen.add(staged.payload.contactHmac)
    plaintextByHmac.set(staged.payload.contactHmac, staged.e164)
    if (!staged.messageable) unmessageable += 1
  }

  return {
    rows,
    lines: cells.length,
    distinct: seen.size,
    repeated,
    quarantined,
    quarantinedByReason: Object.freeze({ ...quarantinedByReason }),
    unmessageable,
    consentClaims,
    plaintextByHmac,
  }
}
