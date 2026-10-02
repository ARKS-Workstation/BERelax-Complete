import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { JournalEntryInput } from '../repositories/journal.ts'
import { postJournalEntry } from '../repositories/journal.ts'
import type { UnitOfWork } from '../tx.ts'
import { DEFERRED_REVENUE_ACCOUNT_CODE } from './sell-package.ts'

/**
 * The writes H-MIG-03 owns: the owner's sign-off, and one reconstructed package liability.
 *
 * `packages/migration` is the importer and may import `@berelax/db` and `@berelax/shared` and nothing else
 * first-party (H-MIG-01's `index.ts` states that as a hard constraint). So the domain writes are here,
 * beside `sell-package.ts`, which is where a `package_sale` has always been written from — and the
 * importer's `apply` is a resolution of names followed by one call to {@link importReconstructedPackage}.
 *
 * ## What a reconstructed sale records, which is the decision this file implements
 *
 * `0119_migration_signoff.sql`'s header has the argument. In short: a reconstructed `package_sale` records
 * what is still OUTSTANDING, not the package as it was sold, because the sessions already taken were
 * delivered under the previous arrangement against no appointment in this database — and 0083's ZG009 is
 * right that a drawdown here must have a `package_redemption` behind it, which posts the release through
 * `4020` and `2030` (ZG008) and would be output VAT on a supply that happened before this system traded.
 *
 * So a fully drawn package arrives as an `imported_package_sale` with NO sale, no balance and no posting:
 * nothing is outstanding, so there is no liability for these books to carry. The row is kept because the
 * cash was received — it belongs in the reconciliation — and because the history is what the holder will
 * ask about.
 *
 * ## Why the outstanding figure is computed in SQL
 *
 * `package_release_through_fils` (0083) is the ONE statement of what a session of a balance is worth, and
 * ZY257 holds the sale's price to `price_paid - package_release_through_fils(price_paid, total, used)`
 * using that same function. Computing the figure in TypeScript here would be a second implementation of
 * the rule, and the two would disagree in exactly the cases where a price does not divide by a session
 * count — which is most of them. `releaseThrough` in `@berelax/core` is the TypeScript half, held equal to
 * the SQL function over a census by `packages/fixtures/src/package-redemption.itest.ts`, and it is what
 * the REPORT and the cash reconciliation use; nothing in this file re-derives it.
 *
 * ## Why these take a UnitOfWork and not a pool
 *
 * `sellPackage`'s reason and one of its own: four of the refusals that guard this path are DEFERRED
 * constraint triggers firing at COMMIT, which is outside every function here. The importer is called with
 * the unit of work the framework opened, so the sale, its balance, the reconstruction record, the journal
 * entry, the provenance row, the audit row and the staged row's state transition all share one
 * transaction — which is what makes a killed import resumable rather than half applied. The SQLSTATE
 * translation is exported as {@link importPackageError} for a caller to wrap its own `withUnitOfWork`
 * call, exactly as `packageError` and `journalError` are.
 */

/**
 * The SQLSTATEs `0119_migration_signoff.sql` raises.
 *
 * Every code is allocated in `packages/db/src/sqlstate-registry.ts` (ADR 0043) and every entry there names
 * THIS file as its translator, which is why no other module holds one as a literal: `pnpm sqlstate` checks
 * the translator list in both directions, so a second module carrying a code fails the build until the
 * registry names it too.
 *
 * The match is on SQLSTATE alone. Matching on the message would make the translation depend on wording,
 * and a reworded message would silently stop translating — after which the caller that treats "this file
 * is not the one the owner signed for" as an unknown failure is the caller that retries it.
 */
export const IMPORT_PACKAGE_SQLSTATE = {
  /** The owner's sign-off was updated or deleted. */
  signOffImmutable: 'ZY251',
  /** A reconstructed sale was written with no expiry of its own. */
  reconstructionStatesNoExpiry: 'ZY252',
  /** A sale the till made was written with an expiry other than its terms'. */
  expiryDisagreesWithTerms: 'ZY253',
  /** A package sale's expiry was changed after the fact. */
  expiryImmutable: 'ZY254',
  /** A reconstruction record was updated or deleted. */
  reconstructionImmutable: 'ZY255',
  /** The sign-off does not attest to the hash of the file the row came from. Raised at COMMIT. */
  signOffIsForAnotherFile: 'ZY256',
  /** A reconstructed sale's figures disagree with the reconstruction that attests to them. */
  saleDisagreesWithAttestation: 'ZY257',
  /** A sale marked as a reconstruction carries no reconstruction record. Raised at COMMIT. */
  reconstructionNotAttested: 'ZY258',
} as const

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a refusal from `0119_migration_signoff.sql` into an `AppError`, or `null` for anything else.
 *
 * The KINDS are chosen by what the caller has to go and do, which is the only question a kind answers:
 *
 *   - `forbidden` for ZY251, ZY254 and ZY255 — the statement will never be permitted, for any caller, with
 *     any data. A corrected reconstruction is a new file, a new hash, a new signature and a new import.
 *   - `validation` for ZY253 and ZY256 — the caller asked for something incoherent: an expiry that is not
 *     the terms', or an import under a signature for another file. Both are fixed by supplying the right
 *     thing.
 *   - `invariant_violated` for ZY252, ZY257 and ZY258 — this code, not the person running the import,
 *     wrote a sale that does not describe what the workbook says. A validation failure would send whoever
 *     reads it looking at the spreadsheet, which is the one place the defect is not.
 */
export function importPackageError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code }
  switch (code) {
    case IMPORT_PACKAGE_SQLSTATE.signOffImmutable:
    case IMPORT_PACKAGE_SQLSTATE.expiryImmutable:
    case IMPORT_PACKAGE_SQLSTATE.reconstructionImmutable:
      return new AppError('forbidden', message, { details })
    case IMPORT_PACKAGE_SQLSTATE.expiryDisagreesWithTerms:
    case IMPORT_PACKAGE_SQLSTATE.signOffIsForAnotherFile:
      return new AppError('validation', message, { details })
    case IMPORT_PACKAGE_SQLSTATE.reconstructionStatesNoExpiry:
    case IMPORT_PACKAGE_SQLSTATE.saleDisagreesWithAttestation:
    case IMPORT_PACKAGE_SQLSTATE.reconstructionNotAttested:
      return new AppError('invariant_violated', message, { details })
    default:
      return null
  }
}

/**
 * The second account code this package spells, and the reason it has to.
 *
 * `sell-package.ts` spells `2050` once, beside the reader that needs it, because `packages/db` may not
 * import `packages/core` — and that constant is imported here rather than respelled, so this package names
 * the liability account once in total. `3030` is new and is named here for the same reason: the opening
 * entry has to be BUILT in this file (the importer may not import `@berelax/core` either, so there is no
 * caller between the two that could hand the posting in, which is the arrangement `sellPackage` uses).
 *
 * Retained earnings and not cash: the money was received in a period these books do not contain, so the
 * other side of the entry is opening equity. The CASH is H-MIG-07's opening asset — debiting it here would
 * double it the moment that unit imports the opening trial balance, which is the one error in an opening
 * position that is undetectable afterwards because the books still balance.
 *
 * `OPENING_PACKAGE_LIABILITY_ACCOUNTS` in `@berelax/core` is the same pair, and
 * `packages/fixtures/src/package-liability.itest.ts` holds the entry this file posts equal to the draft
 * that module builds, line for line. ZG005 already refuses an entry that credits anything but `2050`, by
 * anything but the price, or that touches revenue or `2030`; what it cannot see is which account was
 * debited, and that pairing is what covers it.
 */
export const OPENING_EQUITY_ACCOUNT_CODE = '3030'

// --- the sign-off ------------------------------------------------------------------------------

export interface RecordSignOffInput {
  /** The importer's registered name, e.g. `packages`. */
  readonly importer: string
  /** sha-256 of the source file's BYTES, lower-case hex — `import_run.source_file_hash`. */
  readonly sourceFileHash: string
  /** Who signed, as they identified themselves. Never defaulted (brief rule 15). */
  readonly signedBy: string
  readonly signedOn: string
  readonly statement: string
  readonly rowsAttested: number
  readonly totalPricePaidFils: number
  readonly cashReceivedFils: number
  /** The business day the liability enters these books. A `business_day` row must exist for it. */
  readonly openingDate: string
}

export interface PackageSignOff {
  readonly signOffId: string
  readonly importer: string
  readonly sourceFileHash: string
  readonly signedBy: string
  readonly signedOn: string
  readonly rowsAttested: number
  readonly totalPricePaidFils: number
  readonly cashReceivedFils: number
  readonly openingDate: string
}

interface SignOffRow extends Omit<PackageSignOff, 'totalPricePaidFils' | 'cashReceivedFils'> {
  readonly totalPricePaidFils: string
  readonly cashReceivedFils: string
}

const asSignOff = (row: SignOffRow): PackageSignOff => ({
  ...row,
  totalPricePaidFils: Number(row.totalPricePaidFils),
  cashReceivedFils: Number(row.cashReceivedFils),
})

/**
 * Records the owner's attestation for one source file.
 *
 * Append-only once written (ZY251): a signature that can be edited afterwards is not a signature. A
 * corrected reconstruction is a new file, which has a new hash, which needs a new signature — and
 * `import_sign_off_one_per_file` is what makes a second signature for the SAME bytes a refusal rather than
 * a second answer to "what did the owner accept".
 */
export async function recordPackageSignOff(
  uow: UnitOfWork,
  input: RecordSignOffInput,
): Promise<PackageSignOff> {
  const rows = await uow.sql<SignOffRow[]>`
    insert into import_staging.import_sign_off (
      importer, source_file_hash, signed_by, signed_on, statement, rows_attested,
      total_price_paid_fils, cash_received_fils, opening_date
    ) values (
      ${input.importer}, ${input.sourceFileHash}, ${input.signedBy}, ${input.signedOn}::date,
      ${input.statement}, ${input.rowsAttested}, ${input.totalPricePaidFils},
      ${input.cashReceivedFils}, ${input.openingDate}::date
    )
    returning id                    as "signOffId",
           importer,
           source_file_hash      as "sourceFileHash",
           signed_by             as "signedBy",
           signed_on::text       as "signedOn",
           rows_attested         as "rowsAttested",
           total_price_paid_fils as "totalPricePaidFils",
           cash_received_fils    as "cashReceivedFils",
           opening_date::text    as "openingDate"
  `
  const row = rows[0]
  if (row === undefined) {
    throw new AppError('invariant_violated', 'The import sign-off insert returned no row.')
  }
  await uow.audit.record({
    action: 'migration.sign_off_recorded',
    entityType: 'import_sign_off',
    entityId: row.signOffId,
    operation: 'create',
    after: {
      importer: input.importer,
      sourceFileHash: input.sourceFileHash,
      signedBy: input.signedBy,
      signedOn: input.signedOn,
      rowsAttested: input.rowsAttested,
      totalPricePaidFils: input.totalPricePaidFils,
      cashReceivedFils: input.cashReceivedFils,
      openingDate: input.openingDate,
    },
  })
  return asSignOff(row)
}

/** The owner's sign-off for one importer and one file's bytes, or `null` if nobody has signed for it. */
export async function readPackageSignOff(
  sql: Sql,
  importer: string,
  sourceFileHash: string,
): Promise<PackageSignOff | null> {
  const rows = await sql<SignOffRow[]>`
    select id                    as "signOffId",
           importer,
           source_file_hash      as "sourceFileHash",
           signed_by             as "signedBy",
           signed_on::text       as "signedOn",
           rows_attested         as "rowsAttested",
           total_price_paid_fils as "totalPricePaidFils",
           cash_received_fils    as "cashReceivedFils",
           opening_date::text    as "openingDate"
      from import_staging.import_sign_off
     where importer = ${importer} and source_file_hash = ${sourceFileHash}
  `
  const row = rows[0]
  return row === undefined ? null : asSignOff(row)
}

// --- one reconstructed package -----------------------------------------------------------------

export interface ImportReconstructedPackageInput {
  readonly signOffId: string
  /** The business day the liability enters these books. The sign-off's `opening_date`. */
  readonly openingDate: string
  /** Resolved from the holder's phone by the importer. Never created here: see {@link CustomerUnknown}. */
  readonly customerId: string
  /** The CURRENT version of the template the row named, and the one catalogue line it carries. */
  readonly templateVersionId: string
  readonly serviceVariantId: string
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  /** The entry id for the opening posting. Allocated by the caller; this file never invents one. */
  readonly entryId: string
  /** The workbook row, cell for cell, already parsed and validated. */
  readonly holderPhoneE164: string
  readonly templateKey: string
  readonly purchaseDate: string
  readonly pricePaidFils: number
  readonly sessionsTotal: number
  readonly sessionsUsed: number
  readonly expiresOn: string
  readonly evidenceKind: string
  readonly evidenceReference: string
  readonly notes: string | null
}

export interface ImportedReconstructedPackage {
  readonly reconstructionId: string
  /** Null for a fully drawn package: nothing outstanding, so no liability and no posting. */
  readonly packageSaleId: string | null
  readonly balanceIds: readonly string[]
  readonly entryId: string | null
  /** What `2050` was credited by for this row, from `package_release_through_fils`. */
  readonly outstandingFils: number
  readonly sessionsRemaining: number
}

/** Raised when a workbook row's holder is not a customer this database has. */
export class CustomerUnknown extends AppError {
  constructor(phoneE164: string, lineHint: string) {
    super(
      'validation',
      `CustomerUnknown: no customer record holds ${phoneE164}, so there is nothing for this package to ` +
        'belong to. A customer is NOT created here: H-MIG-04 owns the customer import and the consent ' +
        'floor every imported record arrives with (marketing_consent = false, with no flag able to change ' +
        'it), and a record created from a package workbook would go round that floor. Import the ' +
        `customers first. ${lineHint}`,
      { details: { phoneE164 }, userFacing: true },
    )
    this.name = 'CustomerUnknown'
  }
}

/** Raised when the template a workbook row names cannot carry a reconstruction. */
export class TemplateCannotCarryReconstruction extends AppError {
  constructor(templateKey: string, why: string) {
    super('validation', `TemplateCannotCarryReconstruction: "${templateKey}" ${why}`, {
      details: { templateKey },
      userFacing: true,
    })
    this.name = 'TemplateCannotCarryReconstruction'
  }
}

/**
 * Resolves a holder's phone number to the customer record that holds it.
 *
 * Exact match on `phone_e164`, which IS the identity (ADR 0014). Deliberately NOT on `phone_match_key` —
 * the trailing nine digits — because that column is the merge CANDIDATE key and is not unique: two records
 * can share it, and picking one would attach a liability to whichever row the planner reached first.
 * Normalising a number that is not already E.164 is H-MIG-04's and H-MIG-02's validator refuses one here.
 */
export async function resolveHolder(sql: Sql, phoneE164: string): Promise<string | null> {
  const rows = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = ${phoneE164}
  `
  return rows[0]?.id ?? null
}

export interface ReconstructionTemplate {
  readonly templateVersionId: string
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  readonly lines: readonly { readonly lineNo: number; readonly serviceVariantId: string }[]
}

/**
 * The CURRENT version of a template and its lines, as a reconstruction needs them.
 *
 * `max(version)`, which is what `currentPackageTemplateVersion` reads and for the reason 0078 gives: a
 * `current_version_id` pointer would be a second answer to a question `max()` already answers. The price
 * and the session count are deliberately NOT read — a reconstruction's are the holder's, not the
 * catalogue's, and reading them here would invite a comparison ZG002 no longer makes.
 */
export async function readReconstructionTemplate(
  sql: Sql,
  templateKey: string,
): Promise<ReconstructionTemplate | null> {
  const head = await sql<
    {
      templateVersionId: string
      validityMonths: number
      transferable: boolean
      unredeemedBalancePolicy: 'retained' | 'forfeited'
    }[]
  >`
    select v.id as "templateVersionId", v.validity_months as "validityMonths", v.transferable,
           v.unredeemed_balance_policy as "unredeemedBalancePolicy"
      from package_template_version v
      join package_template t on t.id = v.template_id
     where t.template_key = ${templateKey}
     order by v.version desc
     limit 1
  `
  const version = head[0]
  if (version === undefined) return null
  const lines = await sql<{ lineNo: number; serviceVariantId: string }[]>`
    select line_no as "lineNo", service_variant_id as "serviceVariantId"
      from package_template_line
     where template_version_id = ${version.templateVersionId}::uuid
     order by line_no
  `
  return { ...version, lines }
}

/**
 * Imports one reconstructed package: the liability, the entitlement that remains, and the record of what
 * the workbook said.
 *
 * The order is the one the constraints require and is worth reading as a sequence:
 *
 *   1. the outstanding figure, from `package_release_through_fils` — the ONE statement of the release rule
 *      (0083), so the liability this import records is the figure a redemption would compute;
 *   2. for a fully drawn package, the reconstruction record ALONE and nothing else. Nothing is
 *      outstanding, `package_balance_value_positive` would refuse a balance of nothing, and ZY257 holds
 *      `package_sale_id` null exactly when no session remains;
 *   3. otherwise the opening entry, then the sale, then its balances, then the record — because
 *      `package_sale.journal_entry_id` is a foreign key, ZG006 counts the balances from the sale, and
 *      ZY257 reads the sale's stored columns.
 *
 * Nothing here opens a transaction: see the module note on why it takes a `UnitOfWork`.
 */
export async function importReconstructedPackage(
  uow: UnitOfWork,
  input: ImportReconstructedPackageInput,
): Promise<ImportedReconstructedPackage> {
  if (input.sessionsUsed > input.sessionsTotal || input.sessionsTotal < 1) {
    // H-MIG-02's validator has already refused this file, so reaching here means a caller went round it.
    // Refused rather than trusted, because the SQL below would compute a negative liability — which
    // balances, and is wrong.
    throw new AppError(
      'invariant_violated',
      `importReconstructedPackage was handed ${input.sessionsUsed} of ${input.sessionsTotal} session(s) ` +
        'taken. The workbook validator refuses that row, so this is a caller that did not run it.',
      { details: { sessionsTotal: input.sessionsTotal, sessionsUsed: input.sessionsUsed } },
    )
  }

  const sessionsRemaining = input.sessionsTotal - input.sessionsUsed
  const [figures] = await uow.sql<{ outstanding: string }[]>`
    select (${input.pricePaidFils}::bigint - package_release_through_fils(
              ${input.pricePaidFils}::bigint, ${input.sessionsTotal}::integer,
              ${input.sessionsUsed}::integer))::text as outstanding
  `
  if (figures === undefined) {
    throw new AppError('invariant_violated', 'The outstanding-liability query returned no row.')
  }
  const outstandingFils = Number(figures.outstanding)

  if (sessionsRemaining > 0 && outstandingFils <= 0) {
    // Reachable only for a package whose price is smaller than its session count — 2 fils over 5
    // sessions, four taken. Refused with the figures rather than left to `package_balance_value_positive`,
    // which would arrive as a bare 23514 naming a constraint and not a workbook row.
    throw new TemplateCannotCarryReconstruction(
      input.templateKey,
      `was reconstructed at ${String(input.pricePaidFils)} fils over ${String(input.sessionsTotal)} ` +
        `session(s) with ${String(input.sessionsUsed)} taken, which leaves ${String(sessionsRemaining)} ` +
        'session(s) worth nothing. A balance has to be worth something to be drawn down, so either the ' +
        'price or the session count in that row is not what was sold.',
    )
  }

  const reconstruction = async (packageSaleId: string | null): Promise<string> => {
    const rows = await uow.sql<{ id: string }[]>`
      insert into imported_package_sale (
        sign_off_id, package_sale_id, holder_phone_e164, template_key, purchase_date, price_paid_fils,
        sessions_total_attested, sessions_used_attested, stated_expires_on, evidence_kind,
        evidence_reference, notes
      ) values (
        ${input.signOffId}::uuid,
        ${packageSaleId}::uuid,
        ${input.holderPhoneE164}, ${input.templateKey}, ${input.purchaseDate}::date,
        ${input.pricePaidFils}, ${input.sessionsTotal}, ${input.sessionsUsed},
        ${input.expiresOn}::date, ${input.evidenceKind}, ${input.evidenceReference}, ${input.notes}
      )
      returning id
    `
    const id = rows[0]?.id
    if (id === undefined) {
      throw new AppError('invariant_violated', 'The reconstruction record insert returned no row.')
    }
    return id
  }

  if (sessionsRemaining === 0) {
    const reconstructionId = await reconstruction(null)
    await uow.audit.record({
      action: 'migration.package_liability_imported',
      entityType: 'imported_package_sale',
      entityId: reconstructionId,
      operation: 'create',
      after: {
        signOffId: input.signOffId,
        holderPhoneE164: input.holderPhoneE164,
        templateKey: input.templateKey,
        purchaseDate: input.purchaseDate,
        pricePaidFils: input.pricePaidFils,
        sessionsTotal: input.sessionsTotal,
        sessionsUsed: input.sessionsUsed,
        sessionsRemaining: 0,
        outstandingFils: 0,
        evidenceKind: input.evidenceKind,
        fullyDrawn: true,
      },
    })
    return {
      reconstructionId,
      packageSaleId: null,
      balanceIds: [],
      entryId: null,
      outstandingFils: 0,
      sessionsRemaining: 0,
    }
  }

  /*
    The opening posting.

        Dr  3030  Retained earnings            what is still owed
          Cr  2050  Deferred revenue — packages    the same

    ZG005 holds it at COMMIT: dated on the sale's own business day, crediting `2050` by exactly the price,
    and moving nothing on any account the chart types as revenue and nothing on `2030`. That is H-MIG-03's
    third acceptance line as a property of the database — [UNVERIFIED] Y11-vat-package puts the date of
    supply at REDEMPTION, and the sessions this row says were taken were supplied before this system
    existed, so there is no output VAT here for anybody's box.

    `source` is `opening_balance` and is load-bearing: ZL004 (0027) refuses an entry dated before the books
    open except an opening balance and a reversal.
  */
  const journal: JournalEntryInput = {
    entryId: input.entryId,
    entryDate: input.openingDate,
    narrative:
      `Opening package liability: ${input.holderPhoneE164} holds an outstanding ${input.templateKey} ` +
      `balance of ${String(outstandingFils)} fils, reconstructed from a package purchased on ` +
      `${input.purchaseDate} and imported at cutover`,
    source: 'opening_balance',
    lines: [
      {
        accountCode: OPENING_EQUITY_ACCOUNT_CODE,
        debitFils: outstandingFils,
        creditFils: 0,
        memo: 'Opening equity: the consideration was received before these books opened',
      },
      {
        accountCode: DEFERRED_REVENUE_ACCOUNT_CODE,
        debitFils: 0,
        creditFils: outstandingFils,
        memo: 'Treatments still owed to the holder',
      },
    ],
  }
  await postJournalEntry(uow, journal)

  const [sale] = await uow.sql<{ id: string }[]>`
    insert into package_sale (
      customer_id, template_version_id, trading_date, price_fils, session_count, validity_months,
      transferable, unredeemed_balance_policy, expires_on, journal_entry_id, reconstructed
    ) values (
      ${input.customerId}::uuid, ${input.templateVersionId}::uuid, ${input.openingDate}::date,
      ${outstandingFils}, ${sessionsRemaining}, ${input.validityMonths}, ${input.transferable},
      ${input.unredeemedBalancePolicy}, ${input.expiresOn}::date, ${input.entryId}, true
    )
    returning id
  `
  if (sale === undefined) {
    throw new AppError(
      'invariant_violated',
      'The reconstructed package_sale insert returned no row.',
    )
  }

  // One balance, on line 1 of the version, carrying the whole outstanding entitlement. ZG006 requires one
  // balance per line of the version and the shares to sum to the price, so a multi-line template cannot
  // carry a reconstruction at all — the workbook states one session count for the package and nothing in
  // it says which line a taken session came from. The importer refuses that template by name before
  // reaching here, which is where the message belongs.
  const [balance] = await uow.sql<{ id: string }[]>`
    insert into package_balance (package_sale_id, line_no, service_variant_id, sessions_total,
                                 value_fils)
    values (${sale.id}::uuid, 1, ${input.serviceVariantId}::uuid, ${sessionsRemaining},
            ${outstandingFils})
    returning id
  `
  if (balance === undefined) {
    throw new AppError(
      'invariant_violated',
      'The reconstructed package_balance insert returned no row.',
    )
  }

  const reconstructionId = await reconstruction(sale.id)

  await uow.audit.record({
    action: 'migration.package_liability_imported',
    entityType: 'imported_package_sale',
    entityId: reconstructionId,
    operation: 'create',
    after: {
      signOffId: input.signOffId,
      packageSaleId: sale.id,
      customerId: input.customerId,
      holderPhoneE164: input.holderPhoneE164,
      templateKey: input.templateKey,
      purchaseDate: input.purchaseDate,
      openingDate: input.openingDate,
      pricePaidFils: input.pricePaidFils,
      sessionsTotal: input.sessionsTotal,
      sessionsUsed: input.sessionsUsed,
      sessionsRemaining,
      outstandingFils,
      expiresOn: input.expiresOn,
      evidenceKind: input.evidenceKind,
      entryId: input.entryId,
      fullyDrawn: false,
    },
  })

  return {
    reconstructionId,
    packageSaleId: sale.id,
    balanceIds: [balance.id],
    entryId: input.entryId,
    outstandingFils,
    sessionsRemaining,
  }
}

// --- the liability report ----------------------------------------------------------------------

/** One row of `imported_package_liability`, which is H-MIG-03's liability report. */
export interface ImportedPackageLiabilityRow {
  readonly reconstructionId: string
  readonly packageSaleId: string | null
  readonly customerId: string | null
  readonly holderPhoneE164: string
  readonly templateKey: string
  readonly openingDate: string | null
  readonly purchaseDate: string
  readonly statedExpiresOn: string
  readonly pricePaidFils: number
  readonly sessionsTotalAttested: number
  readonly sessionsUsedAttested: number
  readonly sessionsRemaining: number
  readonly remainingValueFils: number
  readonly sessionsAvailable: number
  readonly evidenceKind: string
  readonly evidenceReference: string
  /** Y9-package-thin: admitted on the owner's recollection alone, and flagged for the desk. */
  readonly admittedOnAttestation: boolean
  readonly journalEntryId: string | null
  readonly signOffId: string
  readonly signedBy: string
  readonly sourceFileHash: string
  readonly sourceFile: string | null
  readonly sourceLine: number | null
  readonly contentHash: string | null
}

/**
 * The imported package liability, read for one sign-off.
 *
 * Scoped to a sign-off rather than reading the whole table, because the report H-MIG-03 produces is about
 * ONE file: a second reconstruction imported later is a second report, and a reader that summed both would
 * be answering a question nobody asked while looking like it was answering this one.
 */
export async function readImportedPackageLiability(
  sql: Sql,
  signOffId: string,
): Promise<readonly ImportedPackageLiabilityRow[]> {
  const rows = await sql<
    (Omit<
      ImportedPackageLiabilityRow,
      'pricePaidFils' | 'remainingValueFils' | 'sessionsAvailable'
    > & {
      pricePaidFils: string
      remainingValueFils: string
      sessionsAvailable: string
    })[]
  >`
    select reconstruction_id        as "reconstructionId",
           package_sale_id          as "packageSaleId",
           customer_id              as "customerId",
           holder_phone_e164        as "holderPhoneE164",
           template_key             as "templateKey",
           opening_date::text       as "openingDate",
           purchase_date::text      as "purchaseDate",
           stated_expires_on::text  as "statedExpiresOn",
           price_paid_fils          as "pricePaidFils",
           sessions_total_attested  as "sessionsTotalAttested",
           sessions_used_attested   as "sessionsUsedAttested",
           sessions_remaining       as "sessionsRemaining",
           remaining_value_fils     as "remainingValueFils",
           sessions_available       as "sessionsAvailable",
           evidence_kind            as "evidenceKind",
           evidence_reference       as "evidenceReference",
           admitted_on_attestation  as "admittedOnAttestation",
           journal_entry_id         as "journalEntryId",
           sign_off_id              as "signOffId",
           signed_by                as "signedBy",
           source_file_hash         as "sourceFileHash",
           source_file              as "sourceFile",
           source_line              as "sourceLine",
           content_hash             as "contentHash"
      from imported_package_liability
     where sign_off_id = ${signOffId}::uuid
     order by purchase_date, holder_phone_e164, template_key
  `
  return rows.map((row) => ({
    ...row,
    pricePaidFils: Number(row.pricePaidFils),
    remainingValueFils: Number(row.remainingValueFils),
    sessionsAvailable: Number(row.sessionsAvailable),
  }))
}

/** The attestation flags on one customer's record, or `null` when they hold no imported package. */
export async function readCustomerPackageAttestation(
  sql: Sql,
  customerId: string,
): Promise<{
  readonly importedPackageCount: number
  readonly attestedPackageCount: number
  readonly hasAttestedPackage: boolean
} | null> {
  const rows = await sql<
    {
      importedPackageCount: number
      attestedPackageCount: number
      hasAttestedPackage: boolean
    }[]
  >`
    select imported_package_count as "importedPackageCount",
           attested_package_count as "attestedPackageCount",
           has_attested_package   as "hasAttestedPackage"
      from customer_package_attestation
     where customer_id = ${customerId}::uuid
  `
  return rows[0] ?? null
}

/**
 * What `2050 Deferred revenue — packages` holds, read off `journal_line`.
 *
 * `credit - debit`, so the figure is the liability's own direction and a debit cannot be mistaken for one.
 * Read from the LEDGER and not from the balances, which is the whole point of H-MIG-03's first acceptance
 * line: the two are computed from different rows by different code, and the import is only right if they
 * agree to the fils.
 */
export async function readPackageDeferredRevenueFils(sql: Sql): Promise<number> {
  const rows = await sql<{ balance: string }[]>`
    select coalesce(sum(credit_fils - debit_fils), 0)::text as balance
      from journal_line
     where account_code = ${DEFERRED_REVENUE_ACCOUNT_CODE}
  `
  return Number(rows[0]?.balance ?? '0')
}
