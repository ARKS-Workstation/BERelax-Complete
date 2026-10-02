import type { SuppressionPepper, UnitOfWork } from '@berelax/db'
import { recordImportedContact, resolveOrCreateImportedCustomer } from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { ImporterDefinition, RowVerdict, StagedSourceRow } from '../../framework.ts'
import type { ImportedEntity } from '../../provenance.ts'
import type { ContactImportPlan, ContactNormaliser, StagedContactPayload } from './dedup.ts'
import { MINIMISED_PAYLOAD_KEYS, planContactImport } from './dedup.ts'
import { parseContactWorkbook } from './workbook.ts'

/**
 * The customer-list importer — H-MIG-04, and the unit whose whole subject is what it REFUSES.
 *
 * ## The one sentence
 *
 * **A list rebuilt from WhatsApp history and phone contacts is not consent.** Somebody who messaged to
 * book an appointment gave this business a number for that purpose; docs/11 §7 says what follows, without
 * exception, and docs/04 §5 says what it costs to get wrong — TDRA wants the opt-in proof to exist before
 * the send, penalties are reported up to AED 400,000 per message, and the sanction in practice is
 * sender-ID suspension, which with two registered identities (ADR 0016) is every campaign this business
 * can run.
 *
 * So the consent floor is not a field this importer fills in with `false`. 0056 made consent an
 * append-only LOG, and in that model "no marketing consent" is **the absence of a row** — not a false, and
 * specifically not a `withdrawn` row either, because nobody withdrew anything and nobody was ever asked.
 * This importer writes nothing to `consent`, its options carry nothing that could, and ZY271 refuses a
 * granted send-gating consent captured by an import whatever wrote it. Three layers, and the one that
 * holds is the database.
 *
 * ## What it does with a source file that claims consent
 *
 * It records that the claim was discarded. The contact list may well have an opt-in column, so
 * `./workbook.ts` has one — read, counted, carried into `imported_contact.consent_claim_discarded` and
 * into one audit row, and honoured nowhere. A file claiming consent for every line imports exactly as a
 * file claiming none, and the difference is visible afterwards, which is the point: a reconstruction that
 * silently dropped the assertion would leave nothing to show it had been made and refused.
 *
 * ## What it refuses to guess
 *
 * A cell it cannot read as a UAE number is QUARANTINED — an `imported_contact` record with the reason, no
 * customer, and provenance to the line of the file it came from. Nothing is repaired. H-MIG-02 recorded
 * the argument when it deferred this subject here: a workbook that quietly turned `0501234567` into
 * something would be deciding which customer a balance belongs to using a rule nobody proved, and
 * H-MIG-03 is already holding package balances against the numbers this import creates.
 *
 * A quarantine is deliberately NOT a rejection. H-MIG-02's validator refuses a whole FILE on one bad row
 * because its artefacts are liabilities and a half-imported liability reconciles to nothing; a contact
 * list is the opposite case — one unreadable cell in two thousand must not stop the other 1,999 arriving,
 * and the framework's rejection path fails the entire run by design.
 *
 * ## What `validate` is for, which is not the file
 *
 * Every rejection this importer can raise is about the STAGED PAYLOAD rather than about a cell, and that
 * is the structural half of this unit's answer to `Y9-import-ledger`. `./dedup.ts` stages a keyed digest
 * and never the number; `validate` refuses a payload carrying any key outside
 * {@link MINIMISED_PAYLOAD_KEYS}, by name, over every row at staging time. So a later change that put the
 * number back into the payload does not quietly work — it rejects the whole file and names the rule.
 *
 * ## Why there is no entry in `IMPORTERS`
 *
 * `IMPORTERS` is a module-level frozen array, so a registered importer cannot have read anything when it
 * is constructed — H-MIG-03's registry note says so. This importer needs two things that cannot be in a
 * frozen array: the suppression PEPPER, which is a secret and reaches the application through
 * `packages/config` (a package `packages/migration` may not import), and the phone normaliser from
 * `@berelax/core` (which it may not import either). A registry entry built without them would have to
 * either stage the plaintext number — the one thing this unit exists not to do — or throw, and H-MIG-02
 * recorded why an entry that cannot run is worse than no entry: the registry is a list a person is
 * supposed to be able to enumerate and run.
 *
 * So the door is `scripts/migrate-contacts.mjs`, which reads the pepper from the environment exactly as
 * the send path does and builds the importer with it. `registry.ts` says the same thing in one paragraph,
 * so somebody reading the registry is not left wondering where the customer importer went.
 */

export const CUSTOMERS_IMPORTER_NAME = 'customers'

/**
 * The importer's own version, recorded on every run.
 *
 * `1`: nothing has read a contact list before. H-MIG-01 says what the version is for — an imported figure
 * that disagrees with what somebody believes has to be traceable to the CODE that read it as well as to
 * the row it came from, and for this importer the code's normalisation IS the figure: which record a
 * number landed on is a decision `e164IdentityResult` made.
 */
export const CUSTOMERS_IMPORTER_VERSION = '1'

/**
 * The tables this importer writes, schema-qualified and complete: ZY194 refuses provenance for anything
 * not in this list, and the report's before/after checksums are taken over exactly it.
 *
 * `imported_contact` is first because it is the row that ALWAYS exists — 0119's arrangement, and here it
 * is also what makes a quarantined line and a repeated line expressible at all.
 */
export const CUSTOMERS_IMPORTER_TARGETS: readonly string[] = Object.freeze([
  'public.imported_contact',
  'public.customer',
])

/**
 * Every reason a staged contact payload is refused, and every one of them is about the PAYLOAD.
 *
 * Named values rather than message strings, for H-MIG-02's reason: a rejection is asserted by name in this
 * unit's tests, printed beside a line number for a person to act on, and branched on by nothing that can
 * read prose. `import.test.ts` iterates the pair — one payload per reason, producing exactly it — rather
 * than asserting "the row failed", which a typo in a key name satisfies too (ADR 0003).
 *
 * `payloadNotMinimised` is the one that matters and is the reason this list exists at all. It is the
 * structural half of this unit's answer to `Y9-import-ledger`: the ledger keeps `import_row.payload` for
 * ever and no erasure can reach it, so a payload carrying anything beyond the four minimised keys refuses
 * the whole file instead of being imported and kept.
 */
export const CONTACT_REJECTIONS = {
  payloadNotMinimised: 'staged-payload-must-carry-only-the-minimised-keys',
  digestNotKeyed: 'staged-contact-digest-must-be-a-keyed-hmac',
  pepperVersionMissing: 'staged-contact-digest-must-name-the-pepper-that-keyed-it',
  consentClaimNotBoolean: 'staged-consent-claim-must-be-a-boolean',
  quarantineReasonNotANamedReason: 'quarantine-reason-must-be-a-short-lower-case-name',
} as const

export type ContactRejection = (typeof CONTACT_REJECTIONS)[keyof typeof CONTACT_REJECTIONS]

/** Every reason, for a test that has to prove none was forgotten and none is unreachable. */
export const CONTACT_REJECTION_REASONS: readonly ContactRejection[] = Object.freeze(
  Object.values(CONTACT_REJECTIONS),
)

const HMAC = /^[a-f0-9]{64}$/
/**
 * The SHAPE of a quarantine reason, not the vocabulary.
 *
 * The vocabulary is `E164_IDENTITY_REJECTIONS` in `@berelax/core`, which this package may not import, and
 * naming the four values here would be a second list for that one to disagree with. So this layer holds
 * the shape — a short lower-case name — the database holds the same shape in a CHECK, and the AGREEMENT
 * with core's vocabulary is asserted in `packages/fixtures/src/customer-import.itest.ts`, which may
 * import both.
 */
const REASON_SHAPE = /^[a-z][a-z0-9_]{0,63}$/

const MINIMISED = new Set<string>(MINIMISED_PAYLOAD_KEYS)

/**
 * Judges one staged payload. Not one cell: by the time anything reaches here the cell has been normalised
 * and keyed, and a cell that could not be read is carrying its reason rather than being refused.
 */
export function validateStagedContact(payload: Readonly<Record<string, unknown>>): RowVerdict {
  for (const key of Object.keys(payload)) {
    if (!MINIMISED.has(key)) {
      return { ok: false, reason: CONTACT_REJECTIONS.payloadNotMinimised }
    }
  }
  const hmac = payload['contactHmac']
  if (typeof hmac !== 'string' || !HMAC.test(hmac)) {
    return { ok: false, reason: CONTACT_REJECTIONS.digestNotKeyed }
  }
  const pepperVersion = payload['pepperVersion']
  if (typeof pepperVersion !== 'string' || pepperVersion.trim().length === 0) {
    return { ok: false, reason: CONTACT_REJECTIONS.pepperVersionMissing }
  }
  if (typeof payload['sourceConsentClaim'] !== 'boolean') {
    return { ok: false, reason: CONTACT_REJECTIONS.consentClaimNotBoolean }
  }
  const reason = payload['quarantineReason']
  if (reason !== undefined && (typeof reason !== 'string' || !REASON_SHAPE.test(reason))) {
    return { ok: false, reason: CONTACT_REJECTIONS.quarantineReasonNotANamedReason }
  }
  return { ok: true }
}

/** The staged payload, read back from `jsonb` with its keys typed. */
function readStaged(payload: Readonly<Record<string, unknown>>): StagedContactPayload {
  const verdict = validateStagedContact(payload)
  if (!verdict.ok) {
    throw new AppError(
      'invariant_violated',
      `A staged contact payload reached apply that staging should have refused (${verdict.reason}). ` +
        'Validation happens over every row before anything is applied, so reaching here means a payload ' +
        'was written into the ledger by something other than this importer.',
      { details: { reason: verdict.reason } },
    )
  }
  const reason = payload['quarantineReason']
  return {
    contactHmac: payload['contactHmac'] as string,
    pepperVersion: payload['pepperVersion'] as string,
    sourceConsentClaim: payload['sourceConsentClaim'] as boolean,
    ...(typeof reason === 'string' ? { quarantineReason: reason } : {}),
  }
}

export interface CustomersImporterOptions {
  /**
   * The suppression pepper, injected. The digest staged in the ledger is keyed under it.
   *
   * Required, with no default and no fallback. An unpeppered digest of a UAE mobile is a phone number with
   * extra steps (0064: the mobile space is small enough to enumerate), so a default here would quietly
   * undo the whole reason the ledger holds a digest rather than a number.
   */
  readonly pepper: SuppressionPepper
  /** `e164IdentityResult` from `@berelax/core`, injected. See `./dedup.ts` on why it is a parameter. */
  readonly normalise: ContactNormaliser
}

/**
 * Applies one staged contact line.
 *
 * Three outcomes and one shape: every line produces exactly one `imported_contact` record, and a line that
 * CREATED a customer produces the customer row beside it. That is not symmetry for its own sake — it is
 * what `import_provenance_one_per_target` forces, since the second line naming a number cannot claim
 * provenance on the customer the first line created, and what ZY196 forces, since an applied row that
 * recorded nothing cannot COMMIT.
 *
 * ZY273 then holds the record's `outcome` equal to what actually happened, by walking the record's own
 * provenance to the staged row and asking whether a customer came from it. A `created` record with no
 * customer behind it would otherwise make this unit's distinct count a report of people who are not in the
 * database — and nothing else would notice, because the record itself carries provenance.
 */
async function applyContactRow(
  uow: UnitOfWork,
  payload: Readonly<Record<string, unknown>>,
  plan: () => ContactImportPlan,
): Promise<readonly ImportedEntity[]> {
  const staged = readStaged(payload)

  if (staged.quarantineReason !== undefined) {
    const id = await recordImportedContact(uow, {
      contactHmac: staged.contactHmac,
      pepperVersion: staged.pepperVersion,
      outcome: 'quarantined',
      quarantineReason: staged.quarantineReason,
      consentClaimDiscarded: staged.sourceConsentClaim,
    })
    return [{ table: 'imported_contact', id }]
  }

  /*
    The plaintext number, from the plan this run's `parse` built — and the only place in the import where
    it exists outside `customer.phone_e164`.

    `apply` is handed a unit of work and a payload and nothing else (H-MIG-01's shape), and the payload
    carries a digest rather than a number, so the number has to come from the parse of the file this run is
    about. That is sound on every path the framework has: `runImport` parses before it stages, before it
    resumes, and before a dry run, and a resumed run is the SAME run over the SAME file hash — so a row
    still pending was keyed by a parse of the same bytes.

    A digest the plan does not hold is therefore not a missing lookup, it is a payload that came from
    somewhere else, and it is refused rather than repaired: the alternative would be inventing which
    customer this line is about, which is the one thing this unit may not do.
  */
  const e164 = plan().plaintextByHmac.get(staged.contactHmac)
  if (e164 === undefined) {
    throw new AppError(
      'invariant_violated',
      `No line of the contact list this run parsed keys to ${staged.contactHmac}, so this payload ` +
        'cannot say which number it is about. The staged payload holds a keyed digest and never the ' +
        'number (0121, Y9-import-ledger), so the plaintext comes from the parse of the file being ' +
        'imported — and reaching here means something applied a payload that parse never produced. ' +
        'A pepper rotated between two runs of one file produces different digests and is the expected ' +
        'cause; the import is then re-run from the start rather than resumed.',
      { details: { contactHmac: staged.contactHmac } },
    )
  }

  const resolved = await resolveOrCreateImportedCustomer(uow, e164)
  const id = await recordImportedContact(uow, {
    contactHmac: staged.contactHmac,
    pepperVersion: staged.pepperVersion,
    outcome: resolved.created ? 'created' : 'matched',
    consentClaimDiscarded: staged.sourceConsentClaim,
  })

  const entities: ImportedEntity[] = [{ table: 'imported_contact', id }]
  // Only when THIS line created it. A `matched` line claiming provenance on a customer another line or
  // another run created would be a provenance row saying this file is where that record came from, which
  // is false — and `import_provenance_one_per_target` would refuse it as a unique violation anyway.
  if (resolved.created) entities.push({ table: 'customer', id: resolved.customerId })
  return entities
}

/**
 * Builds the customer-list importer, and the plan one run shares.
 *
 * Stateful across `parse` and `apply`, which is the arrangement H-MIG-02's validator already needs for its
 * own file-scoped claim and H-MIG-03's registry entry uses for its template keys. Here it carries the one
 * thing that must not be written down: the map from a digest to the number it was computed over.
 *
 * `parse` replaces the plan rather than adding to it, so two files in one process cannot resolve through
 * each other — and `apply` before any `parse` throws by name rather than resolving nothing, because
 * refusing an import nobody parsed is recoverable and the alternative is a customer created from a digest
 * whose number this process is guessing at.
 */
export function customersImporter(options: CustomersImporterOptions): ImporterDefinition {
  let plan: ContactImportPlan | null = null
  const current = (): ContactImportPlan => {
    if (plan === null) {
      throw new AppError(
        'invariant_violated',
        'The customer importer was asked to apply a row before it had parsed a file. The plaintext ' +
          'number for a staged digest comes from the parse of the file being imported, so there is ' +
          'nothing to resolve through — and resolving through a previous file would attach this line to ' +
          "another list's number.",
      )
    }
    return plan
  }

  return {
    name: CUSTOMERS_IMPORTER_NAME,
    version: CUSTOMERS_IMPORTER_VERSION,
    targetTables: CUSTOMERS_IMPORTER_TARGETS,
    parse: (sourceText: string): readonly StagedSourceRow[] => {
      plan = planContactImport(options, parseContactWorkbook(sourceText))
      return plan.rows
    },
    validate: validateStagedContact,
    apply: (uow: UnitOfWork, payload: Readonly<Record<string, unknown>>) =>
      applyContactRow(uow, payload, current),
  }
}

/**
 * What an import of this file WOULD do, without a database and without staging anything.
 *
 * The forecast `scripts/migrate-contacts.mjs --plan` prints and the dry run reports beside the framework's
 * own report: how many people this list is about, how many lines repeat one of them, how many cells could
 * not be read and why, how many of the numbers nothing can send to, and how many lines claimed a consent
 * that is being discarded. Exported separately from the importer because it answers a question somebody
 * asks BEFORE deciding to import at all.
 */
export function planContactList(
  options: CustomersImporterOptions,
  sourceText: string,
): ContactImportPlan {
  return planContactImport(options, parseContactWorkbook(sourceText))
}
