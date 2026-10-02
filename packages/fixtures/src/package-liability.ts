import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EntryDraft, JournalEntry, Money, ReconstructedPackage } from '@berelax/core'
import {
  entryId,
  filsFrom,
  localDate,
  money,
  openingPackageLiability,
  openingPackageLiabilityPosting,
  postEntry,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import { EVIDENCE_KINDS, type PackageWorkbookRow } from '@berelax/migration/importers/packages'

/**
 * The MAPPING for H-MIG-03: core's opening-liability arithmetic against the rows `@berelax/db` writes.
 *
 * `packages/db` may never import `packages/core`, and `packages/migration` may import neither
 * `@berelax/core` nor anything else first-party beyond `@berelax/db` and `@berelax/shared` (H-MIG-01's
 * constraint). So three statements of one rule exist by construction and no single package's suite can see
 * more than one of them:
 *
 *   1. **the posting.** `openingPackageLiabilityPosting` in `@berelax/core` builds the draft;
 *      `importReconstructedPackage` in `@berelax/db` writes the entry. ZG005 refuses an entry that credits
 *      anything but `2050`, by anything but the price, or that moves a revenue account or `2030` — so what
 *      is left unguarded is which account was DEBITED, and {@link assertOpeningPostingAgrees} is what
 *      covers it.
 *   2. **the outstanding figure.** Core computes it with `releaseThrough`; the database computes it with
 *      `package_release_through_fils` and ZY257 holds the sale to it. The two formulas are already held
 *      equal over a census by `package-redemption.itest.ts`, so this file does not re-prove that — it
 *      proves the two CALLERS agree, which is a different claim and the one an off-by-one in either
 *      direction of the subtraction would break.
 *   3. **the attestation kind.** `0119_migration_signoff.sql` spells `owner_attestation` once, as the
 *      expression of a GENERATED column, and H-MIG-02's `EVIDENCE_KINDS` is the vocabulary.
 *      {@link ATTESTATION_EVIDENCE_KIND} and the migration scan in `package-liability.test.ts` are what
 *      hold the literal to the array.
 *
 * It is also where the workbook a suite imports is BUILT, because a reconstruction's rows have to be
 * unique per execution: `imported_package_sale_one_per_holder_template_purchase` refuses one file's row
 * twice across two files, and the framework's idempotence skips a row whose content a completed run has
 * already applied. A suite that re-used H-MIG-02's committed holder numbers would pass once and skip
 * everything on its second run — which is the shape of leak the brief asks every suite to be run twice to
 * find.
 */

/**
 * H-MIG-02's vocabulary value for "no document of any kind", named once for this unit's consumers.
 *
 * Taken from `EVIDENCE_KINDS` by position rather than respelled, so a renamed kind is a failure here
 * instead of a flag that quietly stops being set: `package-liability.test.ts` asserts the array still
 * holds it AND that the migration's generated column spells the same word.
 */
export const ATTESTATION_EVIDENCE_KIND: string = (() => {
  const kind = EVIDENCE_KINDS.find((value) => value === 'owner_attestation')
  if (kind === undefined) {
    throw new Error(
      'EVIDENCE_KINDS no longer holds `owner_attestation`, which is the kind H-MIG-03 flags as admitted ' +
        'on the owner’s recollection alone (Y9-package-thin) and the one value migration 0119 spells. ' +
        'If the vocabulary was renamed, rename it in the migration in the same commit.',
    )
  }
  return kind
})()

/** The migration that owns the sign-off and the reconstruction record. Read, never re-stated. */
export const PACKAGE_LIABILITY_MIGRATION = join(
  'packages',
  'db',
  'migrations',
  '0119_migration_signoff.sql',
)

/** The `evidence_kind` literals migration 0119 spells, so a test can hold them to the vocabulary. */
export function evidenceKindsNamedInMigration(): readonly string[] {
  const sql = readFileSync(PACKAGE_LIABILITY_MIGRATION, 'utf8')
  const generated = /generated always as \(evidence_kind = '([a-z_]+)'\) stored/.exec(sql)
  return generated?.[1] === undefined ? [] : [generated[1]]
}

/** One row of the workbook a suite imports, with the figures a reconstruction carries. */
export interface LiabilityFixtureRow {
  readonly holderPhoneE164: string
  readonly templateKey: string
  readonly purchaseDate: string
  readonly pricePaidFils: number
  readonly sessionsTotal: number
  readonly sessionsUsed: number
  readonly expiresOn: string
  readonly evidenceKind: string
  readonly evidenceReference: string
  readonly notes: string
}

/** The row as the workbook writes it: every cell a string, because a cell is what somebody typed. */
export function asWorkbookRow(row: LiabilityFixtureRow): PackageWorkbookRow {
  return {
    holderPhoneE164: row.holderPhoneE164,
    templateKey: row.templateKey,
    purchaseDate: row.purchaseDate,
    pricePaidFils: String(row.pricePaidFils),
    sessionsTotal: String(row.sessionsTotal),
    sessionsUsed: String(row.sessionsUsed),
    // Asked for twice on purpose (H-MIG-02): a row disagreeing with itself is the only cross-check a
    // reconstructed balance has. Derived here because a fixture that typed it would be testing its own
    // arithmetic rather than the importer.
    sessionsRemaining: String(row.sessionsTotal - row.sessionsUsed),
    expiresOn: row.expiresOn,
    evidenceKind: row.evidenceKind,
    evidenceReference: row.evidenceReference,
    ownerSignedOff: 'yes',
    notes: row.notes,
  }
}

/** The row as `@berelax/core` wants it, for the reconciliation and the posting. */
export function asReconstructedPackage(
  row: LiabilityFixtureRow,
  lineNumber: number,
): ReconstructedPackage {
  return {
    lineNumber,
    holderPhoneE164: row.holderPhoneE164,
    templateKey: row.templateKey,
    purchaseDate: localDate(row.purchaseDate),
    pricePaid: money(filsFrom(row.pricePaidFils)),
    sessionsTotal: row.sessionsTotal,
    sessionsUsed: row.sessionsUsed,
    expiresOn: localDate(row.expiresOn),
    evidenceKind: row.evidenceKind,
  }
}

/** What core says this file's rows leave owing, which is what `2050` has to hold after the import. */
export function expectedOutstandingFils(rows: readonly LiabilityFixtureRow[]): number {
  return rows.reduce(
    (running, row) =>
      running + openingPackageLiability(asReconstructedPackage(row, 1)).outstanding.fils,
    0,
  )
}

/** One entry as `journal_line` holds it, keyed by account, signed `debit - credit`. */
export type PostedMovement = ReadonlyMap<string, number>

/** The same shape, from a draft core built, so the two can be compared without reading field names. */
export function movementOfDraft(draft: EntryDraft): PostedMovement {
  const entry: JournalEntry = postEntry(draft, STANDARD_SPA_CHART)
  const movement = new Map<string, number>()
  for (const line of entry.lines) {
    const code = line.account as string
    movement.set(code, (movement.get(code) ?? 0) + line.debitFils - line.creditFils)
  }
  return movement
}

/**
 * Holds the entry `@berelax/db` wrote equal to the draft `@berelax/core` builds for the same figure.
 *
 * Throws with both movements rather than returning a boolean: this is called from a suite, and a
 * comparison that reports "false" sends somebody to read two packages to find out which account moved.
 *
 * The deliberate asymmetry: core's narrative and the service's narrative are NOT compared. They say the
 * same things in different words on purpose — one is built from a reconstruction id and the other from the
 * workbook row — and a check over prose would be a check that fails on a reworded sentence, which is the
 * class of assertion this repository keeps deleting.
 */
export function assertOpeningPostingAgrees(input: {
  readonly posted: PostedMovement
  readonly outstanding: Money
  readonly reconstructionId: string
  readonly holderPhoneE164: string
  readonly templateKey: string
  readonly openingDate: string
}): void {
  const expected = movementOfDraft(
    openingPackageLiabilityPosting({
      entryId: entryId('pairing-probe'),
      openingDate: localDate(input.openingDate),
      outstanding: input.outstanding,
      reconstructionId: input.reconstructionId,
      holderPhoneE164: input.holderPhoneE164,
      templateKey: input.templateKey,
    }),
  )
  const asObject = (movement: PostedMovement): Record<string, number> =>
    Object.fromEntries([...movement.entries()].sort(([a], [b]) => (a < b ? -1 : 1)))
  const left = JSON.stringify(asObject(input.posted))
  const right = JSON.stringify(asObject(expected))
  if (left !== right) {
    throw new Error(
      'The opening package-liability entry the database holds is not the one @berelax/core builds for ' +
        `the same figure. Posted ${left}; core's draft ${right}. ZG005 refuses an entry that credits ` +
        'anything but 2050 by anything but the price, so the account this disagrees about is almost ' +
        'certainly the DEBIT — which is the one half ZG005 cannot see, and is why this pairing exists.',
    )
  }
}
