import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { JournalEntryInput } from '../repositories/journal.ts'
import { postJournalEntry } from '../repositories/journal.ts'
import { type PackageDefaultTerms, readPackageDefaultTerms } from '../settings/package.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Package templates and the package sale: the two writes M-TILL-09 owns.
 *
 * ## Editing a template is an INSERT
 *
 * `savePackageTemplateVersion` inserts `max(version) + 1` and never touches the version anybody has sold
 * against — `package_template_version` refuses UPDATE and DELETE outright (ZG001), so the immutability is
 * a database rule and not a habit of this file. That is the whole first acceptance line: a sale's terms,
 * price and session count cannot change, because the row they are on cannot change.
 *
 * ## A sale credits a LIABILITY
 *
 * `sellPackage` writes the journal entry the caller built (`packageSalePosting` in `@berelax/core`), the
 * sale, one `payment` row per tender, and one balance per line. The payment rows were MISSING in this
 * unit's first version and 0083 §6 is the argument: `payment.invoice_id` was NOT NULL and a package sale
 * issues no invoice, so cash taken for a package never reached `readDrawerTakings` and M-TILL-11's cash-up
 * read the drawer as over by it. The entry is `Dr` tender / `Cr 2050 Deferred revenue` at the full gross
 * and moves nothing on revenue and nothing on `2030`: **[UNVERIFIED] Y11-vat-package** puts the date of
 * supply at redemption, which is the strictest safe reading. Releasing `2050` into `4020` is M-TILL-10's.
 *
 * The posting arrives as a {@link JournalEntryInput} rather than being built here, for
 * `finaliseCheckout`'s reason: `packages/db` may never import `packages/core`, a posting rule is
 * arithmetic, and `packages/fixtures/src/package.ts` is the mapping that holds the two halves in step.
 * This file therefore spells no account code except in the ONE place it has to — see
 * {@link DEFERRED_REVENUE_ACCOUNT_CODE}.
 *
 * ## Why these take a UnitOfWork and not a pool
 *
 * `postJournalEntry`'s reason, and one of their own: four of this unit's six refusals are DEFERRED
 * constraint triggers that fire at COMMIT, which is outside every function here. So the SQLSTATE
 * translation is exported as {@link packageError} for a caller to wrap its own `withUnitOfWork` call,
 * exactly as `journalError` is:
 *
 * ```ts
 * try {
 *   await withUnitOfWork(sql, actor, (uow) => sellPackage(uow, input))
 * } catch (err) {
 *   throw packageError(err) ?? journalError(err) ?? err
 * }
 * ```
 */

/**
 * The SQLSTATEs `0078_package.sql` raises. Class 'ZP' is unused by PostgreSQL and reserved by the
 * standard for user-defined conditions.
 *
 * Custom codes rather than repurposed standard ones, `JOURNAL_SQLSTATE`'s reason: a caller has to tell
 * these six apart, and the alternative is matching on message text — which stops working silently the
 * first time somebody improves the wording, and the code that then treats an archived service as an
 * unknown failure is the code that retries it.
 */
export const PACKAGE_SQLSTATE = {
  /** A version, a line or a sale was UPDATEd or DELETEd. */
  immutableRow: 'ZG001',
  /** A sale's snapshotted terms disagree with the version it names. Raised at COMMIT. */
  termsDisagree: 'ZG002',
  /** A template line references an archived catalogue service. */
  archivedService: 'ZG003',
  /** A template version has no lines. Raised at COMMIT. */
  versionHasNoLines: 'ZG004',
  /** The sale's journal entry is not a pure deferred-revenue posting. Raised at COMMIT. */
  postingNotDeferredRevenue: 'ZG005',
  /** The balances' shares do not sum to the price. Raised at COMMIT. */
  allocationDisagrees: 'ZG006',
} as const

/** `23505`: two concurrent saves computed the same next version, and one of them lost. */
const UNIQUE_VIOLATION = '23505'

/**
 * The one account code this file spells, and the reason it has to.
 *
 * `sellPackage` does not build the posting — the caller does, from `@berelax/core`'s `ACCOUNTS`. But it
 * does have to READ the liability back to answer "what does this sale owe", and `packages/db` may not
 * import `packages/core`. So the code is here once, beside the reader that needs it, rather than threaded
 * through every caller as an argument nobody could get wrong in a useful way. ZG005 spells it a second
 * time in SQL, which is unavoidable — a trigger cannot import TypeScript — and
 * `packages/fixtures/src/package.itest.ts` holds all three equal.
 */
export const DEFERRED_REVENUE_ACCOUNT_CODE = '2050'

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

const constraintOf = (err: unknown): string | undefined => {
  const named = err as { constraint_name?: unknown; constraint?: unknown } | null
  if (typeof named?.constraint_name === 'string') return named.constraint_name
  if (typeof named?.constraint === 'string') return named.constraint
  const carried = (err as { details?: { constraint?: unknown } } | null)?.details?.constraint
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Raised when a template line names a catalogue service that has been archived.
 *
 * The acceptance line's error, and it is raised in TWO places on purpose: here, before the insert, so the
 * caller is told which line and which treatment; and by ZG003 in the database, so a writer that never came
 * through this function is refused as well. The two messages deliberately share no phrase — M-TILL-11
 * measured what happens when they do, and it is a gate reporting a pass over a service check somebody had
 * deleted, because the database refused the same statement and the suite stayed green.
 */
export class ArchivedServiceReferenced extends AppError {
  readonly lineNo: number
  readonly serviceVariantId: string
  constructor(lineNo: number, serviceVariantId: string, label: string, archivedAt: string) {
    super(
      'validation',
      `ArchivedServiceReferenced: line ${lineNo} sells ${label}, which was archived on ` +
        `${archivedAt} and is not bookable. A package that sold it would take money for an ` +
        'appointment the front desk can never make.',
      { userFacing: true, details: { lineNo, serviceVariantId, label, archivedAt } },
    )
    this.name = 'ArchivedServiceReferenced'
    this.lineNo = lineNo
    this.serviceVariantId = serviceVariantId
  }
}

/** Raised when the template key names nothing, or names a template withdrawn from sale. */
export class PackageTemplateUnavailable extends AppError {
  constructor(templateKey: string, why: string) {
    super('validation', `PackageTemplateUnavailable: "${templateKey}" ${why}`, {
      userFacing: true,
      details: { templateKey, why },
    })
    this.name = 'PackageTemplateUnavailable'
  }
}

/**
 * Translates a PostgreSQL error raised by `0078_package.sql` into an `AppError`, or `null` if it is not
 * one of ours.
 *
 * Exported because four of the six refusals arrive from `COMMIT`, which no function in this module
 * executes. The match is on SQLSTATE only: matching on the message would make the translation depend on
 * wording, and this is precisely the path where an unrecognised failure gets retried.
 */
export function packageError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case PACKAGE_SQLSTATE.immutableRow:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case PACKAGE_SQLSTATE.archivedService:
      return new AppError('validation', message, {
        userFacing: true,
        details: { sqlState: code },
      })
    case UNIQUE_VIOLATION:
      return isDuplicatePackageLine(err)
        ? new AppError(
            'validation',
            'A package may not list the same treatment twice: two lines for one catalogue variant is ' +
              'one entitlement expressed twice, and a redemption would have two balances to draw it ' +
              `from. ${message}`,
            { userFacing: true, details: { constraint: constraintOf(err) } },
          )
        : null
    case PACKAGE_SQLSTATE.termsDisagree:
    case PACKAGE_SQLSTATE.versionHasNoLines:
    case PACKAGE_SQLSTATE.postingNotDeferredRevenue:
    case PACKAGE_SQLSTATE.allocationDisagrees:
      // `invariant_violated` and not `validation`: a caller cannot fix any of these by prompting the user
      // differently. Some rule produced a sale that does not describe what happened, and the correct
      // response is to fail the transaction.
      return new AppError('invariant_violated', message, { details: { sqlState: code } })
    default:
      return null
  }
}

/**
 * Two lines of one version naming the same catalogue variant.
 *
 * A plausible caller mistake — "five massages and one more massage" — and without this the raw `23505`
 * reaches the till. The refusal is the CONSTRAINT's rather than an application check, because one
 * entitlement expressed twice would give a redemption two balances to draw down in either order, so
 * "which of my four massages did that use" would have two answers.
 */
export function isDuplicatePackageLine(err: unknown): boolean {
  return (
    sqlState(err) === UNIQUE_VIOLATION &&
    constraintOf(err) === 'package_template_line_one_row_per_variant'
  )
}

export function isPackageVersionRaced(err: unknown): boolean {
  return (
    sqlState(err) === UNIQUE_VIOLATION &&
    constraintOf(err) === 'package_template_version_one_row_per_number'
  )
}

// --- template versions -------------------------------------------------------------------------

/** One entitlement a version sells: a catalogue variant and how many sessions of it. */
export interface PackageTemplateLineInput {
  readonly serviceVariantId: string
  readonly sessionCount: number
}

export interface SavePackageTemplateVersionInput {
  /** Lower snake case. Created on first save; reused on every edit, which is a new version. */
  readonly templateKey: string
  readonly internalName: string
  readonly publicDisplayName: string
  /** VAT-inclusive gross in integer fils (ADR 0007). */
  readonly priceFils: number
  /** At least one, in the order the version states them. `line_no` is assigned by position. */
  readonly lines: readonly PackageTemplateLineInput[]
  /**
   * The three policy terms. **Omit them** and the stored defaults are used, with their provenance: a
   * version defaulted from a still-unconfirmed setting is flagged provisional and names
   * Y9-package-policy, so it reaches the Unconfirmed Assumptions panel. Supplying them is a deliberate
   * override and the version is NOT flagged — somebody typed the numbers in.
   */
  readonly terms?: {
    readonly validityMonths: number
    readonly transferable: boolean
    readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  }
}

export interface SavedPackageTemplateVersion {
  readonly templateId: string
  readonly templateKey: string
  readonly versionId: string
  readonly version: number
  readonly priceFils: number
  readonly sessionCount: number
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
}

export async function savePackageTemplateVersion(
  uow: UnitOfWork,
  input: SavePackageTemplateVersionInput,
): Promise<SavedPackageTemplateVersion> {
  if (input.lines.length === 0) {
    // Refused here as well as by ZG004, and the reason for both is that ZG004 fires at COMMIT: by then the
    // audit row has been written for a version that never existed.
    //
    // The CLASS and not a plain AppError whose message happens to spell the class name. Both of this
    // function's early refusals did that, and an error whose message claims a type the object is not is
    // worse than one with no name at all: `err instanceof PackageTemplateUnavailable` answered false for
    // an error that said PackageTemplateUnavailable on the line above.
    throw new PackageTemplateUnavailable(
      input.templateKey,
      'was saved with no lines. A version with no lines is an entitlement to nothing sold for money.',
    )
  }

  /**
   * The terms, and where they came from.
   *
   * ONE shape for both paths, so nothing downstream has to know which one it came from. Supplying
   * `terms` is somebody typing the numbers in, so the version is not flagged;
   * omitting them defaults from `app_setting`, and the flag follows the setting's own flag — which
   * `writeSetting` clears when a human confirms a value, so confirming Y9-package-policy stops new
   * versions being flagged without anybody editing this file.
   *
   * A setting flagged provisional with no `open_question_id` is refused by
   * `package_template_version_provisional_names_a_question` rather than by a check here. One statement of
   * "a provisional row names its question", and it is the column's.
   */
  const terms: PackageDefaultTerms =
    input.terms === undefined
      ? await readPackageDefaultTerms(uow.sql)
      : { ...input.terms, isProvisional: false, openQuestionId: null, provisionalNote: null }

  // Every line's service is checked BEFORE anything is inserted, so the refusal names the line rather
  // than arriving from a trigger halfway through a batch. `archived_at` is on `service` and not on the
  // variant, because archiving withdraws the treatment (0029).
  const variantIds = input.lines.map((line) => line.serviceVariantId)
  const services = await uow.sql<{ id: string; label: string; archivedAt: Date | null }[]>`
    select v.id, s.style::text || '/' || s.treatment_key || ' ' || v.duration_minutes::text || 'min'
             as label,
           s.archived_at as "archivedAt"
      from service_variant v
      join service s on s.id = v.service_id
     where v.id = any(${variantIds}::uuid[])
  `
  const byVariant = new Map(services.map((row) => [row.id, row]))
  for (const [index, line] of input.lines.entries()) {
    const service = byVariant.get(line.serviceVariantId)
    if (service === undefined) {
      throw new PackageTemplateUnavailable(
        input.templateKey,
        `names service variant "${line.serviceVariantId}" on line ${index + 1}, which the catalogue ` +
          'does not have.',
      )
    }
    if (service.archivedAt !== null) {
      throw new ArchivedServiceReferenced(
        index + 1,
        line.serviceVariantId,
        service.label,
        service.archivedAt.toISOString().slice(0, 10),
      )
    }
  }

  /**
   * Register the template if it is new, then read it. TWO statements, and not an upsert.
   *
   * `on conflict (template_key) do update set updated_at = now()` was the first version and the
   * application role cannot run it: 0078 narrows `berelax_app`'s UPDATE on this table to `retired_at`
   * alone, and a column-list grant is checked against the columns the statement NAMES — so naming
   * `updated_at` is `42501 permission denied for table package_template`. Nothing caught it, because
   * every test here connects as the owner; it was found by running the statement as `berelax_app` in
   * psql, and the itest below now runs the whole save-and-sell path under `set local role berelax_app`
   * so the grants and the service cannot drift apart again.
   *
   * Widening the grant to `updated_at` was the alternative and is worse: the column exists so that a
   * retirement is dated, and a grant allowing the application to touch it for any other reason is a
   * grant nobody argued for. `updated_at` now moves when `retired_at` does and at no other time, which
   * is what its comment in the migration says.
   */
  await uow.sql`
    insert into package_template (template_key) values (${input.templateKey})
    on conflict (template_key) do nothing
  `
  const [template] = await uow.sql<{ id: string; retiredAt: Date | null }[]>`
    select id, retired_at as "retiredAt" from package_template
     where template_key = ${input.templateKey}
  `
  if (template === undefined) {
    throw new AppError('invariant_violated', 'package_template insert left no row to read')
  }
  if (template.retiredAt !== null) {
    throw new PackageTemplateUnavailable(
      input.templateKey,
      'has been withdrawn from sale. A retired template keeps its versions, because balances point ' +
        'at them, but it gains no new ones.',
    )
  }

  /**
   * The next version number, read inside the transaction.
   *
   * Two concurrent saves both read the same `max(version)` and both try to insert it, and the LOSER is
   * refused by `package_template_version_one_row_per_number` rather than by a check in this function —
   * which is the difference between an idempotency claim the repository tolerates and one the database
   * refuses. {@link isPackageVersionRaced} is how a caller recognises it and retries.
   */
  const [next] = await uow.sql<{ version: number }[]>`
    select coalesce(max(version), 0) + 1 as version
      from package_template_version where template_id = ${template.id}::uuid
  `
  const version = next?.version ?? 1

  const [saved] = await uow.sql<{ id: string }[]>`
    insert into package_template_version (
      template_id, version, internal_name, public_display_name, price_fils, validity_months,
      transferable, unredeemed_balance_policy, is_provisional, provisional_note, open_question_id
    ) values (
      ${template.id}::uuid, ${version}, ${input.internalName}, ${input.publicDisplayName},
      ${input.priceFils}, ${terms.validityMonths}, ${terms.transferable},
      ${terms.unredeemedBalancePolicy}, ${terms.isProvisional},
      ${terms.provisionalNote}, ${terms.openQuestionId}
    )
    returning id
  `
  if (saved === undefined) {
    throw new AppError('invariant_violated', 'package_template_version insert returned no row')
  }

  for (const [index, line] of input.lines.entries()) {
    await uow.sql`
      insert into package_template_line (template_version_id, line_no, service_variant_id,
                                         session_count)
      values (${saved.id}::uuid, ${index + 1}, ${line.serviceVariantId}::uuid,
              ${line.sessionCount})
    `
  }

  await uow.audit.record({
    action: 'package.template_version_saved',
    entityType: 'package_template_version',
    entityId: saved.id,
    operation: 'create',
    after: {
      templateKey: input.templateKey,
      version,
      priceFils: input.priceFils,
      lines: input.lines.length,
      terms,
      isProvisional: terms.isProvisional,
    },
  })

  return {
    templateId: template.id,
    templateKey: input.templateKey,
    versionId: saved.id,
    version,
    priceFils: input.priceFils,
    sessionCount: input.lines.reduce((running, line) => running + line.sessionCount, 0),
    validityMonths: terms.validityMonths,
    transferable: terms.transferable,
    unredeemedBalancePolicy: terms.unredeemedBalancePolicy,
    isProvisional: terms.isProvisional,
    openQuestionId: terms.openQuestionId,
  }
}

export interface PackageTemplateVersionRow {
  readonly versionId: string
  readonly templateId: string
  readonly templateKey: string
  readonly version: number
  readonly internalName: string
  readonly publicDisplayName: string
  readonly priceFils: number
  readonly sessionCount: number
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly lines: readonly {
    readonly lineNo: number
    readonly serviceVariantId: string
    readonly sessionCount: number
    readonly listGrossFils: number
  }[]
}

/**
 * The CURRENT version of a template: `max(version)`.
 *
 * There is deliberately no `current_version_id` pointer to read instead. A pointer is a second answer to
 * a question `max()` already answers, and its failure mode is a pointer at a version a later insert
 * superseded — which reads as a template that quietly stopped being editable.
 *
 * `listGrossFils` is the variant's price × the session count, which is the WEIGHT `allocateByWeight` in
 * `@berelax/core` uses and never an amount posted. Read at the CURRENT catalogue price, deliberately: the
 * weight decides how a discount is spread across the lines of a package being sold TODAY, and a sale
 * already made stores its own shares on `package_balance` and never consults this again.
 */
export async function currentPackageTemplateVersion(
  sql: Sql,
  templateKey: string,
): Promise<PackageTemplateVersionRow | null> {
  const [head] = await sql<
    {
      versionId: string
      templateId: string
      templateKey: string
      version: number
      internalName: string
      publicDisplayName: string
      priceFils: string
      validityMonths: number
      transferable: boolean
      unredeemedBalancePolicy: 'retained' | 'forfeited'
      isProvisional: boolean
      openQuestionId: string | null
    }[]
  >`
    select v.id as "versionId", t.id as "templateId", t.template_key as "templateKey",
           v.version, v.internal_name as "internalName",
           v.public_display_name as "publicDisplayName", v.price_fils as "priceFils",
           v.validity_months as "validityMonths", v.transferable,
           v.unredeemed_balance_policy as "unredeemedBalancePolicy",
           v.is_provisional as "isProvisional", v.open_question_id as "openQuestionId"
      from package_template_version v
      join package_template t on t.id = v.template_id
     where t.template_key = ${templateKey}
     order by v.version desc
     limit 1
  `
  if (head === undefined) return null

  const lines = await sql<
    { lineNo: number; serviceVariantId: string; sessionCount: number; listGrossFils: string }[]
  >`
    select l.line_no as "lineNo", l.service_variant_id as "serviceVariantId",
           l.session_count as "sessionCount",
           (l.session_count * v.gross_price_fils) as "listGrossFils"
      from package_template_line l
      join service_variant v on v.id = l.service_variant_id
     where l.template_version_id = ${head.versionId}::uuid
     order by l.line_no
  `
  return {
    ...head,
    priceFils: Number(head.priceFils),
    sessionCount: lines.reduce((running, line) => running + line.sessionCount, 0),
    lines: lines.map((line) => ({
      lineNo: line.lineNo,
      serviceVariantId: line.serviceVariantId,
      sessionCount: line.sessionCount,
      listGrossFils: Number(line.listGrossFils),
    })),
  }
}

// --- the sale ----------------------------------------------------------------------------------

/** One tender, as the till recorded it. The account is the CALLER's, from core's tender registry. */
export interface PackageTenderInput {
  readonly tenderKind: string
  readonly postingAccountCode: string
  readonly amountFils: number
  readonly reference?: string
}

/** One balance the sale opens. `valueFils` is core's allocation, never re-derived here. */
export interface PackageBalanceInput {
  readonly lineNo: number
  readonly serviceVariantId: string
  readonly sessionsTotal: number
  readonly valueFils: number
}

export interface SellPackageInput {
  readonly customerId: string
  readonly templateVersionId: string
  /** The business day, `YYYY-MM-DD`, resolved with `resolveTradingDate`. Never a calendar date. */
  readonly tradingDate: string
  /** The terms snapshot. Held equal to the version by ZG002 at COMMIT. */
  readonly priceFils: number
  readonly sessionCount: number
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  /** Already balanced by `postEntry`. Mapped field for field from core's `JournalEntry`. */
  readonly journal: JournalEntryInput
  /** One per template line, in `line_no` order. ZG006 requires one per line and the exact total. */
  readonly balances: readonly PackageBalanceInput[]
  /**
   * The tenders, one `payment` row each. NOT posted from here — the posting is the caller's journal entry,
   * and {@link TenderPostingDisagrees}'s hazard one domain along is why the two are mapped together.
   */
  readonly tenders: readonly PackageTenderInput[]
}

export interface SoldPackage {
  readonly saleId: string
  readonly entryId: string
  readonly priceFils: number
  readonly expiresOn: string
  readonly balanceIds: readonly string[]
}

export async function sellPackage(uow: UnitOfWork, input: SellPackageInput): Promise<SoldPackage> {
  if (input.journal.source !== 'package_sale') {
    // `source` is carried rather than inferred from the accounts, and a sale filed under `sale` would be
    // indistinguishable from a treatment in every report that groups by it — including the one that
    // proves this unit's deferred-revenue balance came from packages.
    throw new AppError(
      'validation',
      `sellPackage was handed a journal entry whose source is "${input.journal.source}". A package ` +
        'sale posts under "package_sale": a refund and a prepaid sale can produce similar lines and ' +
        'are answered differently when a customer asks.',
      { details: { source: input.journal.source } },
    )
  }
  const tendered = input.tenders.reduce((running, tender) => running + tender.amountFils, 0)
  if (tendered !== input.priceFils) {
    throw new AppError(
      'validation',
      `sellPackage was handed tenders of ${tendered} fils against a price of ${input.priceFils} ` +
        'fils. A partial payment leaves a receivable and an over-tender gives change; neither may ' +
        'be absorbed into a liability the salon was not paid for.',
      { details: { tendered, priceFils: input.priceFils } },
    )
  }

  await postJournalEntry(uow, input.journal)

  const [sale] = await uow.sql<{ id: string; expiresOn: string }[]>`
    insert into package_sale (
      customer_id, template_version_id, trading_date, price_fils, session_count, validity_months,
      transferable, unredeemed_balance_policy, journal_entry_id
    ) values (
      ${input.customerId}::uuid, ${input.templateVersionId}::uuid, ${input.tradingDate}::date,
      ${input.priceFils}, ${input.sessionCount}, ${input.validityMonths}, ${input.transferable},
      ${input.unredeemedBalancePolicy}, ${input.journal.entryId}
    )
    returning id, expires_on::text as "expiresOn"
  `
  if (sale === undefined) {
    throw new AppError('invariant_violated', 'package_sale insert returned no row')
  }

  /**
   * The `payment` rows, and this is M-TILL-09's own recorded defect being fixed rather than a feature.
   *
   * This unit took money for a package and wrote no `payment` row, because `payment.invoice_id` was NOT
   * NULL (0063) and a package sale issues no invoice. The consequence is not cosmetic: `readDrawerTakings`
   * and `ZU005` (0076) both sum this table for the business day, so cash taken for a package was invisible
   * to both — and M-TILL-11's cash-up read the drawer as OVER by exactly that amount and posted the
   * difference to `6140 Cash over and short`. A `done` unit's reconciliation was knowably wrong for every
   * package sold for cash.
   *
   * `0083_package_redemption.sql` made `invoice_id` nullable, added `package_sale_id` beside it, and
   * requires exactly one of the two (`payment_settles_exactly_one_document`). `tender_no` is the POSITION,
   * 0063's reason: an insertion-ordered list reorders the moment a query plan changes, and
   * `payment_one_row_per_package_tender` is what makes a retried tender a refusal rather than a second
   * expectation in the drawer.
   *
   * `trading_date` is the sale's business day and not a truncated instant. Trading runs 11:00-02:00, so a
   * 01:30 package sale belongs to the previous trading date and the cash-up that reconciles it cuts on this
   * column — getting it wrong moves the takings between two drawers, both of which then fail to balance.
   */
  for (const [index, tender] of input.tenders.entries()) {
    await uow.sql`
      insert into payment (invoice_id, package_sale_id, tender_no, tender_kind,
                           posting_account_code, amount_fils, change_given_fils, reference,
                           trading_date)
      values (null, ${sale.id}::uuid, ${index + 1}, ${tender.tenderKind},
              ${tender.postingAccountCode}, ${tender.amountFils}, 0,
              ${tender.reference ?? null}, ${input.tradingDate}::date)
    `
  }

  const balanceIds: string[] = []
  for (const balance of input.balances) {
    const [row] = await uow.sql<{ id: string }[]>`
      insert into package_balance (package_sale_id, line_no, service_variant_id, sessions_total,
                                   value_fils)
      values (${sale.id}::uuid, ${balance.lineNo}, ${balance.serviceVariantId}::uuid,
              ${balance.sessionsTotal}, ${balance.valueFils})
      returning id
    `
    if (row === undefined) {
      throw new AppError('invariant_violated', 'package_balance insert returned no row')
    }
    balanceIds.push(row.id)
  }

  await uow.audit.record({
    action: 'package.sold',
    entityType: 'package_sale',
    entityId: sale.id,
    operation: 'create',
    after: {
      customerId: input.customerId,
      templateVersionId: input.templateVersionId,
      tradingDate: input.tradingDate,
      priceFils: input.priceFils,
      expiresOn: sale.expiresOn,
      entryId: input.journal.entryId,
      tenders: input.tenders.map((tender) => ({
        kind: tender.tenderKind,
        account: tender.postingAccountCode,
        amountFils: tender.amountFils,
      })),
    },
  })

  return {
    saleId: sale.id,
    entryId: input.journal.entryId,
    priceFils: input.priceFils,
    expiresOn: sale.expiresOn,
    balanceIds,
  }
}

export interface PackageSaleRow {
  readonly saleId: string
  readonly customerId: string
  readonly templateVersionId: string
  readonly tradingDate: string
  readonly priceFils: number
  readonly sessionCount: number
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  readonly expiresOn: string
  readonly entryId: string
  readonly balances: readonly {
    readonly lineNo: number
    readonly serviceVariantId: string
    readonly sessionsTotal: number
    readonly sessionsRedeemed: number
    readonly valueFils: number
    readonly releasedFils: number
  }[]
}

export async function readPackageSale(sql: Sql, saleId: string): Promise<PackageSaleRow | null> {
  const [sale] = await sql<
    {
      saleId: string
      customerId: string
      templateVersionId: string
      tradingDate: string
      priceFils: string
      sessionCount: number
      validityMonths: number
      transferable: boolean
      unredeemedBalancePolicy: 'retained' | 'forfeited'
      expiresOn: string
      entryId: string
    }[]
  >`
    select id as "saleId", customer_id as "customerId",
           template_version_id as "templateVersionId", trading_date::text as "tradingDate",
           price_fils as "priceFils", session_count as "sessionCount",
           validity_months as "validityMonths", transferable,
           unredeemed_balance_policy as "unredeemedBalancePolicy",
           expires_on::text as "expiresOn", journal_entry_id as "entryId"
      from package_sale where id = ${saleId}::uuid
  `
  if (sale === undefined) return null
  const balances = await sql<
    {
      lineNo: number
      serviceVariantId: string
      sessionsTotal: number
      sessionsRedeemed: number
      valueFils: string
      releasedFils: string
    }[]
  >`
    select line_no as "lineNo", service_variant_id as "serviceVariantId",
           sessions_total as "sessionsTotal", sessions_redeemed as "sessionsRedeemed",
           value_fils as "valueFils", released_fils as "releasedFils"
      from package_balance where package_sale_id = ${saleId}::uuid order by line_no
  `
  return {
    ...sale,
    priceFils: Number(sale.priceFils),
    balances: balances.map((balance) => ({
      lineNo: balance.lineNo,
      serviceVariantId: balance.serviceVariantId,
      sessionsTotal: balance.sessionsTotal,
      sessionsRedeemed: balance.sessionsRedeemed,
      valueFils: Number(balance.valueFils),
      releasedFils: Number(balance.releasedFils),
    })),
  }
}
