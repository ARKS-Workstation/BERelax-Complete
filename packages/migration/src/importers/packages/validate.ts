import { filsStringSchema, isoDateSchema, phoneSchema } from '@berelax/shared'
import type { RowVerdict } from '../../framework.ts'
import {
  EVIDENCE_KINDS,
  OWNER_SIGN_OFF_VALUE,
  type PackageWorkbookRow,
  parsePackageWorkbook,
} from './workbook.ts'

/**
 * The reconstruction workbook's validator, and the rejection vocabulary H-MIG-01 left to this unit.
 *
 * ## Why the vocabulary is a named constant and not a set of messages
 *
 * `import_row.outcome_detail` is free text (H-MIG-01 refused to put a CHECK on it, because a list in the
 * schema would be a second list for this one to disagree with). Free text at the database is not licence to
 * write prose at the caller: a rejection reason is asserted by NAME in this unit's tests, read by H-MIG-03's
 * variance report, and printed beside a line number for a person to act on. A message string is none of those
 * things — nobody can branch on prose, and a reworded sentence silently stops matching whatever was matching
 * it. So every reason is a value in {@link PACKAGE_REJECTIONS}, each has a named fixture file in
 * `./fixtures/` that must produce exactly it, and `validate.test.ts` iterates the pair rather than asserting
 * "the file failed" — which a syntax error satisfies (ADR 0003).
 *
 * ## One reason per row, in a stated order
 *
 * {@link RowVerdict} carries one reason, so a row with two problems is reported by the first one found. The
 * order below is not arbitrary: identity first (whose package, which package), then the figures, then the
 * evidence and the sign-off. A row whose holder or template cannot be read is not a row with a bad number —
 * it is a row nobody can say what liability it is about, and reporting the price as the problem would send
 * somebody to look at the wrong cell.
 *
 * Each of the fixtures therefore breaks exactly ONE cell, and the test asserts the file produced exactly one
 * rejection carrying the named reason. A fixture that broke two cells would still report one reason, and the
 * case would pass while proving nothing about the rule it names.
 *
 * ## Why the value checks come from `@berelax/shared` and not from a regular expression here
 *
 * `phoneSchema.shape.e164`, `isoDateSchema` and `filsStringSchema` are this repository's statements of what
 * an E.164 number, a calendar date and an integer-fils amount look like. Re-spelling any of them here would
 * be a workbook that accepts a number the customer table cannot store, or refuses one it can — and the two
 * would drift apart in whichever direction nobody tested. Normalising a number that is NOT already E.164 is
 * deliberately not done: that is H-MIG-04's subject (its acceptance names it), and a workbook that quietly
 * repaired `0501234567` would decide which customer a balance belongs to using a rule this unit never
 * proved.
 *
 * ## The template existence check takes the keys as an ARGUMENT
 *
 * `ImporterDefinition.validate` is synchronous and sees only the payload, which is right: validation happens
 * at staging time over every row, and a per-row database round trip would make a thousand-row workbook a
 * thousand queries. So the caller reads the template keys ONCE — `readPackageTemplateKeys` in
 * `packages/db/src/settings/package-templates.ts` — and hands them in. That is also what makes this module
 * pure and testable with nothing running, and what lets the same code answer the workbook generator, the
 * validator CLI and H-MIG-03's importer.
 */

/**
 * Every reason a reconstructed package row is refused.
 *
 * The eight the acceptance names are here — `sessionsUsedExceedsTotal`, `sessionsNegative`,
 * `templateUnknown`, `holderPhoneNotE164`, `priceNotIntegerFils`, `expiryBeforePurchase`,
 * `duplicateHolderTemplatePurchase`, `ownerSignOffMissing` — and the rest are the ones the shape of the
 * workbook makes reachable. Three are worth reading twice:
 *
 *   - `templateWithoutVersion` is a DIFFERENT failure from `templateUnknown` and is reported separately. The
 *     template exists and its terms do not: `package_sale.template_version_id` is not null, so there is
 *     nothing to sell against, and telling somebody their key is unknown would send them to create a
 *     template that is already there.
 *   - `sessionsRemainingDisagrees` is the only rejection that comes from the file contradicting ITSELF, and
 *     it is the reason the workbook asks for a figure it could compute. A reconstructed balance has no second
 *     source; this is the whole of what can be cross-checked.
 *   - `evidenceReferenceMissing` applies to `owner_attestation` as much as to a receipt. An attestation with
 *     no reference is not thin evidence, it is none — and the kind is admitted precisely because the business
 *     owes the money, which is an argument for recording what the owner recalls rather than for recording
 *     nothing.
 */
export const PACKAGE_REJECTIONS = {
  holderPhoneMissing: 'holder-phone-must-be-present',
  holderPhoneNotE164: 'holder-phone-must-be-e164',
  templateKeyMissing: 'template-key-must-be-present',
  templateUnknown: 'template-key-names-no-package-template',
  templateWithoutVersion: 'template-has-no-version-to-sell-against',
  purchaseDateNotADate: 'purchase-date-must-be-yyyy-mm-dd',
  expiryNotADate: 'expiry-must-be-yyyy-mm-dd',
  expiryBeforePurchase: 'expiry-must-not-precede-the-purchase-date',
  priceNotIntegerFils: 'price-must-be-integer-fils',
  priceNotPositive: 'price-must-be-more-than-zero-fils',
  sessionsNotInteger: 'sessions-must-be-whole-numbers',
  sessionsNegative: 'sessions-must-not-be-negative',
  sessionsTotalNotPositive: 'sessions-total-must-be-at-least-one',
  sessionsUsedExceedsTotal: 'sessions-used-must-not-exceed-sessions-total',
  sessionsRemainingDisagrees: 'sessions-remaining-must-equal-total-minus-used',
  evidenceKindUnknown: 'evidence-kind-must-be-one-of-the-declared-kinds',
  evidenceReferenceMissing: 'evidence-reference-must-say-where-the-evidence-is',
  ownerSignOffMissing: 'owner-sign-off-must-be-yes-on-every-row',
  duplicateHolderTemplatePurchase: 'duplicate-holder-template-and-purchase-date',
} as const

export type PackageRejection = (typeof PACKAGE_REJECTIONS)[keyof typeof PACKAGE_REJECTIONS]

/** Every reason, for a test that has to prove none was forgotten and none is unreachable. */
export const PACKAGE_REJECTION_REASONS: readonly PackageRejection[] = Object.freeze(
  Object.values(PACKAGE_REJECTIONS),
)

/** A package template as the validator needs to know about it: does it exist, and can it be sold against. */
export interface KnownPackageTemplate {
  readonly templateKey: string
  /** False for a `package_template` row with no `package_template_version`. */
  readonly hasVersion: boolean
}

export interface PackageValidatorOptions {
  /**
   * Every template key the database holds, retired ones INCLUDED.
   *
   * Retired templates are deliberately accepted. `package_template.retired_at` withdraws a package from SALE
   * and leaves the balances sold under it redeemable (migration 0078), so a retired template is exactly the
   * situation a reconstruction meets — and refusing it would leave a real outstanding liability
   * unrecordable. The workbook's reference block lists only the live ones, because that is what a person
   * filling in a new row should be choosing from; the validator answers the wider question, which is whether
   * the terms exist at all.
   */
  readonly templates: readonly KnownPackageTemplate[]
}

const asRow = (payload: Readonly<Record<string, unknown>>): PackageWorkbookRow => {
  const cell = (key: string): string => {
    const value = payload[key]
    return typeof value === 'string' ? value.trim() : ''
  }
  return {
    holderPhoneE164: cell('holderPhoneE164'),
    templateKey: cell('templateKey'),
    purchaseDate: cell('purchaseDate'),
    pricePaidFils: cell('pricePaidFils'),
    sessionsTotal: cell('sessionsTotal'),
    sessionsUsed: cell('sessionsUsed'),
    sessionsRemaining: cell('sessionsRemaining'),
    expiresOn: cell('expiresOn'),
    evidenceKind: cell('evidenceKind'),
    evidenceReference: cell('evidenceReference'),
    ownerSignedOff: cell('ownerSignedOff'),
    notes: cell('notes'),
  }
}

/** Whole numbers only, and a leading `-` is a number this column may not hold rather than a parse failure. */
const INTEGER = /^-?\d+$/

/**
 * The four session rules, in one step because they read three cells and each rule needs all three parsed.
 *
 * Order matters and is the reason they are together rather than four entries in the list: a total of `0`
 * makes `sessions_remaining` disagree as well, and reporting the disagreement would send somebody to check
 * their subtraction on a package that entitles its holder to nothing.
 */
function sessionsRejection(row: PackageWorkbookRow): PackageRejection | null {
  const cells = [row.sessionsTotal, row.sessionsUsed, row.sessionsRemaining]
  if (!cells.every((cell) => INTEGER.test(cell))) return PACKAGE_REJECTIONS.sessionsNotInteger
  const [total, used, remaining] = cells.map((cell) => Number.parseInt(cell, 10)) as [
    number,
    number,
    number,
  ]
  if (total < 0 || used < 0 || remaining < 0) return PACKAGE_REJECTIONS.sessionsNegative
  if (total < 1) return PACKAGE_REJECTIONS.sessionsTotalNotPositive
  if (used > total) return PACKAGE_REJECTIONS.sessionsUsedExceedsTotal
  if (remaining !== total - used) return PACKAGE_REJECTIONS.sessionsRemainingDisagrees
  return null
}

/** `(holder, template, purchase date)` — the only identity a reconstructed row has. */
const duplicateKey = (row: PackageWorkbookRow): string =>
  [row.holderPhoneE164, row.templateKey, row.purchaseDate].join('\u0000')

/**
 * Builds a validator for ONE pass over ONE file.
 *
 * Stateful, because `duplicateHolderTemplatePurchase` is a claim about the file and not about a row: two rows
 * for one holder, one template and one purchase date are one package entered twice, and importing both would
 * double a liability with nothing in either row looking wrong. The framework validates rows in file order at
 * staging time, so the first occurrence passes and every later one is refused naming the line it duplicates.
 *
 * One instance per run, therefore, and the resume path does not disturb that: a run with any rejection ends
 * `failed` having applied nothing, and a RESUMED run re-reads the rejections it already staged rather than
 * re-validating (H-MIG-01's `performRun`). So a fresh validator never sees a half-validated file.
 *
 * The obvious alternative — de-duplicating in the parser and staging one row — was rejected. The duplicate is
 * the person's mistake to see and fix in the file, and a parser that silently dropped one of two rows would
 * make the staged ledger disagree with the spreadsheet it is supposed to be evidence of.
 */
export function createPackageWorkbookValidator(options: PackageValidatorOptions): {
  validate(payload: Readonly<Record<string, unknown>>): RowVerdict
} {
  const withVersion = new Set(
    options.templates.filter((template) => template.hasVersion).map((t) => t.templateKey),
  )
  const known = new Set(options.templates.map((template) => template.templateKey))
  const seen = new Set<string>()

  /*
    The checks, as an ORDERED LIST of named functions rather than one long branch.

    The order is the whole of "one reason per row" and is stated in the module note, so it is worth being
    able to read it as a list: identity, then the file contradicting itself, then the figures, then the
    evidence and the sign-off. Each step answers a reason or `null`, and the first non-null wins.

    It is also the shape that keeps each rule small enough to be obviously right. The single branch this
    replaced was one function of cognitive complexity 39 — nineteen conditions deciding which of nineteen
    reasons a row gets — which is exactly the construct where an `if` in the wrong place gives a row the
    wrong reason and every test still passes, because the row is still refused.
  */
  const checks: readonly ((row: PackageWorkbookRow) => PackageRejection | null)[] = [
    // Identity first: a row nobody can attribute is not a row with a bad figure.
    (row) => (row.holderPhoneE164.length === 0 ? PACKAGE_REJECTIONS.holderPhoneMissing : null),
    (row) =>
      phoneSchema.shape.e164.safeParse(row.holderPhoneE164).success
        ? null
        : PACKAGE_REJECTIONS.holderPhoneNotE164,
    (row) => (row.templateKey.length === 0 ? PACKAGE_REJECTIONS.templateKeyMissing : null),
    (row) => (known.has(row.templateKey) ? null : PACKAGE_REJECTIONS.templateUnknown),
    (row) => (withVersion.has(row.templateKey) ? null : PACKAGE_REJECTIONS.templateWithoutVersion),
    (row) =>
      isoDateSchema.safeParse(row.purchaseDate).success
        ? null
        : PACKAGE_REJECTIONS.purchaseDateNotADate,
    // The duplicate, once the three cells that identify the row have been read. It consults `seen` and
    // does not add to it: a row that fails a LATER check has not been imported, so a corrected copy of it
    // further down the file must not be refused as a duplicate of a row nothing accepted.
    (row) =>
      seen.has(duplicateKey(row)) ? PACKAGE_REJECTIONS.duplicateHolderTemplatePurchase : null,
    // `filsStringSchema` refuses a decimal point, a comma and a minus sign in one statement, which is why
    // `priceNotPositive` is separate rather than a widening of it: "1500.00" is the wrong UNIT (ADR 0007)
    // and "0" is a package that took nothing, and the remedies differ.
    (row) =>
      filsStringSchema.safeParse(row.pricePaidFils).success
        ? null
        : PACKAGE_REJECTIONS.priceNotIntegerFils,
    (row) => (BigInt(row.pricePaidFils) <= 0n ? PACKAGE_REJECTIONS.priceNotPositive : null),
    (row) => sessionsRejection(row),
    (row) =>
      isoDateSchema.safeParse(row.expiresOn).success ? null : PACKAGE_REJECTIONS.expiryNotADate,
    // String comparison, and it is correct for `YYYY-MM-DD` rather than a shortcut: both cells have already
    // been held to that shape, and parsing them into instants would put a zone into a comparison of two
    // calendar dates, which is what the time rule forbids.
    (row) => (row.expiresOn < row.purchaseDate ? PACKAGE_REJECTIONS.expiryBeforePurchase : null),
    (row) =>
      EVIDENCE_KINDS.includes(row.evidenceKind) ? null : PACKAGE_REJECTIONS.evidenceKindUnknown,
    (row) =>
      row.evidenceReference.length === 0 ? PACKAGE_REJECTIONS.evidenceReferenceMissing : null,
    (row) =>
      row.ownerSignedOff === OWNER_SIGN_OFF_VALUE ? null : PACKAGE_REJECTIONS.ownerSignOffMissing,
  ]

  return {
    validate(payload: Readonly<Record<string, unknown>>): RowVerdict {
      const row = asRow(payload)
      for (const check of checks) {
        const rejection = check(row)
        if (rejection !== null) return { ok: false, reason: rejection }
      }
      seen.add(duplicateKey(row))
      return { ok: true }
    },
  }
}

/** One rejected line, as the report prints it. */
export interface WorkbookRejection {
  /** The line in the FILE, so `<file>:<line>` opens the spreadsheet at the row. */
  readonly lineNumber: number
  readonly reason: PackageRejection
}

/**
 * What one pass over one workbook found.
 *
 * The three totals are H-MIG-03's, and they are here rather than there because they are properties of the
 * FILE: that unit reconciles the sum of remaining package value to cash actually received, and it cannot do
 * that from rows it has already imported without re-deriving the figure it is checking.
 */
export interface WorkbookValidationReport {
  readonly sourceFile: string
  readonly rows: number
  readonly accepted: number
  readonly rejections: readonly WorkbookRejection[]
  /** Accepted rows only, by `evidence_kind`. A rejected row's evidence may be the thing that is wrong. */
  readonly evidence: Readonly<Record<string, number>>
  /** Accepted rows resting on `owner_attestation` alone — Y9-package-thin's population. */
  readonly attested: number
  /** Sum over accepted rows, as digits: fils does not fit a float and never becomes one (ADR 0007). */
  readonly totalPricePaidFils: string
  readonly totalSessionsRemaining: number
  readonly ok: boolean
}

/**
 * Validates a whole workbook and reports every rejection with its line.
 *
 * All-or-nothing is the report's `ok`, and the CLI's exit code follows it: a file with one bad row imports
 * NOTHING. The artefacts being reconstructed are liabilities, and a half-imported set is a deferred-revenue
 * balance that reconciles to nothing — so the useful output is every bad line at once, for one correcting
 * pass over the spreadsheet rather than nine.
 */
export function validatePackageWorkbook(options: {
  readonly sourceFile: string
  readonly sourceText: string
  readonly templates: readonly KnownPackageTemplate[]
}): WorkbookValidationReport {
  const parsed = parsePackageWorkbook(options.sourceText)
  const validator = createPackageWorkbookValidator({ templates: options.templates })
  const rejections: WorkbookRejection[] = []
  const evidence: Record<string, number> = {}
  for (const kind of EVIDENCE_KINDS) evidence[kind] = 0
  let accepted = 0
  let attested = 0
  let totalPrice = 0n
  let totalRemaining = 0

  for (const row of parsed) {
    const verdict = validator.validate(row.payload)
    if (!verdict.ok) {
      rejections.push({ lineNumber: row.lineNumber, reason: verdict.reason as PackageRejection })
      continue
    }
    const cells = asRow(row.payload)
    accepted += 1
    evidence[cells.evidenceKind] = (evidence[cells.evidenceKind] ?? 0) + 1
    if (cells.evidenceKind === 'owner_attestation') attested += 1
    totalPrice += BigInt(cells.pricePaidFils)
    totalRemaining += Number.parseInt(cells.sessionsRemaining, 10)
  }

  return {
    sourceFile: options.sourceFile,
    rows: parsed.length,
    accepted,
    rejections,
    evidence,
    attested,
    totalPricePaidFils: totalPrice.toString(),
    totalSessionsRemaining: totalRemaining,
    ok: rejections.length === 0,
  }
}

/** `path/to/file.tsv:214  sessions-used-must-not-exceed-sessions-total`, one per rejected row. */
export function formatWorkbookRejections(report: WorkbookValidationReport): readonly string[] {
  return report.rejections.map(
    (rejection) => `${report.sourceFile}:${rejection.lineNumber}  ${rejection.reason}`,
  )
}
