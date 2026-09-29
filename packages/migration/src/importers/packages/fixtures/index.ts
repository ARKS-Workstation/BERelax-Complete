import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PACKAGE_REJECTIONS, type PackageRejection } from '../validate.ts'
import {
  type PackageWorkbookRow,
  parsePackageWorkbook,
  WORKBOOK_PAYLOAD_KEYS,
  type WorkbookTerms,
} from '../workbook.ts'

/**
 * The named workbook fixtures: one malformed file per rejection, and one clean file that must import.
 *
 * H-MIG-01 left the rejection vocabulary to this unit and said why: a CHECK in the schema listing the reasons
 * a row may be rejected would be a second list for this one to disagree with. So the vocabulary is
 * {@link PACKAGE_REJECTIONS}, and this module is what makes it a set of rules rather than a set of strings —
 * every reason has a FILE that produces it, `validate.test.ts` iterates the pairing, and
 * {@link MALFORMED_FIXTURES} is asserted to cover every reason exactly once. A reason with no fixture would be
 * a refusal nobody has seen fire (ADR 0003), and a fixture whose reason is not in the vocabulary would be a
 * message the report cannot be read by.
 *
 * ## Why the fixtures are real `.tsv` files and not literals in a test
 *
 * The artefact under test is a FILE a person fills in in a spreadsheet, and half the failures this unit is
 * arranged against are properties of the file rather than of a row: a header somebody reordered, a set of
 * cells that is blank because the column moved, a re-save that changed every byte. A literal in a test cannot
 * have those properties. The files are also readable on their own — each opens with a `#` line saying what is
 * deliberately wrong with it — which matters because the next person to meet this vocabulary is whoever is
 * correcting a real workbook against it.
 *
 * ## Each malformed file differs from the clean row in exactly ONE cell
 *
 * That is the discipline that makes "rejects by name" mean anything. A verdict carries one reason, so a fixture
 * that broke two cells would still report one — and the case asserting "it failed" would pass while the rule
 * it names went unexercised. So the test asserts each file produces EXACTLY ONE rejection and that its reason
 * is the named one, and every file below is the clean first row with a single value replaced.
 *
 * `header-mismatch.tsv` and `no-rows.tsv` are the two that cannot follow that rule and are kept separate
 * ({@link FILE_LEVEL_FIXTURES}): both are refused by the PARSER before any row is judged, because a bad header
 * and an empty file are facts about the whole file and cannot be reported per line.
 *
 * ## Nothing here is dialable and nothing here is a name
 *
 * Every holder is on `+97159`, which is not an allocated UAE mobile prefix — the same guarantee
 * `packages/fixtures/src/synthetic.ts` gives and for the same reason: a fixture number that could ring a real
 * handset eventually does. `validate.test.ts` asserts it over every cell of every file, against the allocated
 * prefixes rather than against a spelling, so a fixture edited onto a real prefix fails. There is no holder
 * NAME anywhere, because the workbook has no column for one: a package is held by a phone number (ADR 0014),
 * and a name could not be matched to a customer record even if somebody typed it.
 */

const DIRECTORY = import.meta.dirname

/** The clean file. Five reconstructed packages, every evidence kind exercised, all signed off. */
export const CLEAN_FIXTURE = 'clean.tsv'

export interface MalformedFixture {
  readonly file: string
  /** The reason the file must produce, and the ONLY rejection it may produce. */
  readonly rejection: PackageRejection
  /** What is wrong with it, in the words a person correcting a real workbook would use. */
  readonly why: string
}

/**
 * One file per rejection, and the acceptance line's eight are all here.
 *
 * `sessions_used` greater than `sessions_total`, negative sessions, an unknown template, a non-E.164 phone, a
 * non-integer-fils price, an expiry before the purchase date, a duplicate (holder, template, purchase date)
 * and a missing owner sign-off — plus the eleven the shape of the workbook makes reachable, of which
 * `sessions-remaining-disagrees` is the one the workbook exists to be able to catch at all.
 */
export const MALFORMED_FIXTURES: readonly MalformedFixture[] = Object.freeze([
  Object.freeze({
    file: 'holder-phone-missing.tsv',
    rejection: PACKAGE_REJECTIONS.holderPhoneMissing,
    why: 'the holder cell is blank, so nobody can say whose liability this is',
  }),
  Object.freeze({
    file: 'holder-phone-not-e164.tsv',
    rejection: PACKAGE_REJECTIONS.holderPhoneNotE164,
    why: 'a national number as the front desk types it. Normalising is H-MIG-04’s, not this unit’s',
  }),
  Object.freeze({
    file: 'template-key-missing.tsv',
    rejection: PACKAGE_REJECTIONS.templateKeyMissing,
    why: 'the template cell is blank, so the row names no terms',
  }),
  Object.freeze({
    file: 'template-unknown.tsv',
    rejection: PACKAGE_REJECTIONS.templateUnknown,
    why:
      'a key no package_template holds — the acceptance line "the attempt fails naming the missing ' +
      'template"',
  }),
  Object.freeze({
    file: 'template-without-version.tsv',
    rejection: PACKAGE_REJECTIONS.templateWithoutVersion,
    why: 'a template that exists with no version, so there are no terms to sell against',
  }),
  Object.freeze({
    file: 'purchase-date-not-a-date.tsv',
    rejection: PACKAGE_REJECTIONS.purchaseDateNotADate,
    why: 'the date spelling a spreadsheet offers, which is not YYYY-MM-DD',
  }),
  Object.freeze({
    file: 'expiry-not-a-date.tsv',
    rejection: PACKAGE_REJECTIONS.expiryNotADate,
    why: 'a word where the expiry should be. "unknown" is honest and is still not importable',
  }),
  Object.freeze({
    file: 'expiry-before-purchase.tsv',
    rejection: PACKAGE_REJECTIONS.expiryBeforePurchase,
    why: 'the balance expires before it was bought',
  }),
  Object.freeze({
    file: 'price-not-integer-fils.tsv',
    rejection: PACKAGE_REJECTIONS.priceNotIntegerFils,
    why: 'dirhams with a decimal point. The wrong UNIT, not the wrong number (ADR 0007)',
  }),
  Object.freeze({
    file: 'price-not-positive.tsv',
    rejection: PACKAGE_REJECTIONS.priceNotPositive,
    why: 'a package that took no money, which is a missing figure rather than a free package',
  }),
  Object.freeze({
    file: 'sessions-not-integer.tsv',
    rejection: PACKAGE_REJECTIONS.sessionsNotInteger,
    why: 'half a session',
  }),
  Object.freeze({
    file: 'sessions-negative.tsv',
    rejection: PACKAGE_REJECTIONS.sessionsNegative,
    why: 'a negative count, which a spreadsheet formula produces and nobody reads',
  }),
  Object.freeze({
    file: 'sessions-total-not-positive.tsv',
    rejection: PACKAGE_REJECTIONS.sessionsTotalNotPositive,
    why: 'a package entitling its holder to nothing',
  }),
  Object.freeze({
    file: 'sessions-used-exceeds-total.tsv',
    rejection: PACKAGE_REJECTIONS.sessionsUsedExceedsTotal,
    why: 'more sessions taken than were ever sold',
  }),
  Object.freeze({
    file: 'sessions-remaining-disagrees.tsv',
    rejection: PACKAGE_REJECTIONS.sessionsRemainingDisagrees,
    why: 'the row contradicting itself. The only cross-check a reconstructed balance has',
  }),
  Object.freeze({
    file: 'evidence-kind-unknown.tsv',
    rejection: PACKAGE_REJECTIONS.evidenceKindUnknown,
    why: 'evidence outside the declared vocabulary, written as a sentence',
  }),
  Object.freeze({
    file: 'evidence-reference-missing.tsv',
    rejection: PACKAGE_REJECTIONS.evidenceReferenceMissing,
    why: 'a kind with nowhere to go and look, which is not thin evidence but none',
  }),
  Object.freeze({
    file: 'owner-sign-off-missing.tsv',
    rejection: PACKAGE_REJECTIONS.ownerSignOffMissing,
    why: 'a row the owner has not accepted as a liability of the business',
  }),
  Object.freeze({
    file: 'duplicate-holder-template-purchase.tsv',
    rejection: PACKAGE_REJECTIONS.duplicateHolderTemplatePurchase,
    why: 'one package entered twice. The second occurrence is refused and the first stands',
  }),
])

/** The two files the PARSER refuses, before any row has a verdict. */
export const FILE_LEVEL_FIXTURES = Object.freeze({
  /** Two columns transposed, so every row would parse into the wrong field rather than failing. */
  headerMismatch: 'header-mismatch.tsv',
  /** A generated workbook nobody filled in. */
  noRows: 'no-rows.tsv',
})

/**
 * The templates the fixtures name, and the one that deliberately has no version.
 *
 * One list with both projections derived from it, because the validator wants `(key, hasVersion)` and the
 * workbook's reference block wants the four columns a person reads — and two hand-written lists of the same
 * templates is the second statement this repository keeps paying for.
 *
 * The display names carry `[confirm]` and name Y9-package-catalogue, the marker `is_placeholder_text()`
 * (migration 0026) matches and `packages/fixtures/src/package-seed.ts` uses for the same reason: what this
 * business sells as a package is a fact nobody has stated, so a fixture name that read like a product could
 * be mistaken for one in a screenshot of the generated workbook.
 */
export interface FixtureTemplate {
  readonly templateKey: string
  readonly hasVersion: boolean
  readonly sessionCount: number
  readonly priceFils: string
  readonly publicDisplayName: string
}

export const FIXTURE_TEMPLATES: readonly FixtureTemplate[] = Object.freeze([
  Object.freeze({
    templateKey: 'fixture_template_a',
    hasVersion: true,
    sessionCount: 5,
    priceFils: '100000',
    publicDisplayName:
      '[confirm] fixture template A — not a package this business sells; ' + 'Y9-package-catalogue',
  }),
  Object.freeze({
    templateKey: 'fixture_template_b',
    hasVersion: true,
    sessionCount: 3,
    priceFils: '60000',
    publicDisplayName:
      '[confirm] fixture template B — not a package this business sells; ' + 'Y9-package-catalogue',
  }),
  Object.freeze({
    templateKey: 'fixture_template_without_version',
    hasVersion: false,
    sessionCount: 0,
    priceFils: '0',
    publicDisplayName:
      '[confirm] a template with no version — no terms to sell against; ' + 'Y9-package-catalogue',
  }),
])

/** What the validator needs: does the key exist, and are there terms behind it. */
export const FIXTURE_VALIDATOR_TEMPLATES = Object.freeze(
  FIXTURE_TEMPLATES.map((template) =>
    Object.freeze({ templateKey: template.templateKey, hasVersion: template.hasVersion }),
  ),
)

/** What the workbook's reference block prints: the live ones, as the sell list would give them. */
export const FIXTURE_WORKBOOK_TEMPLATES = Object.freeze(
  FIXTURE_TEMPLATES.filter((template) => template.hasVersion).map((template) =>
    Object.freeze({
      templateKey: template.templateKey,
      sessionCount: template.sessionCount,
      priceFils: template.priceFils,
      publicDisplayName: template.publicDisplayName,
    }),
  ),
)

/**
 * Terms for the generator's fixture, deliberately DIFFERENT from the configured defaults.
 *
 * Three months, transferable, forfeited — none of which is what `app_setting` holds. That is the point: the
 * generator must print the terms it is HANDED rather than a constant of its own, and terms equal to the
 * configured ones could not tell the two apart. It also proves the parser ignores the preamble, because a
 * workbook whose face says "forfeited" still validates identically.
 */
export const FIXTURE_WORKBOOK_TERMS: WorkbookTerms = Object.freeze({
  validityMonths: 3,
  transferable: true,
  unredeemedBalancePolicy: 'forfeited',
  isProvisional: true,
  openQuestionId: 'Y9-package-policy',
})

/**
 * The synthetic fixture set: the five rows a filled copy of the generated workbook carries.
 *
 * The same five rows `clean.tsv` holds, and `validate.test.ts` asserts that — so the round-trip claim ("a
 * filled copy of the generated file validates clean against the synthetic fixture set") is proved against the
 * committed file rather than against a second set of rows written beside it.
 */
export const SYNTHETIC_PACKAGE_ROWS: readonly PackageWorkbookRow[] = Object.freeze(
  readFixtureRows(CLEAN_FIXTURE),
)

/** Reads a fixture file's bytes. Exported so a test reads exactly what a person would open. */
export function readFixture(file: string): string {
  return readFileSync(join(DIRECTORY, file), 'utf8')
}

/**
 * The data rows of a fixture, as typed cells.
 *
 * Read through {@link parsePackageWorkbook} and projected with {@link WORKBOOK_PAYLOAD_KEYS}, so this module
 * states the column order nowhere. A local reader with its own cell indices would be the third statement of
 * the twelve columns and the one nothing holds equal — and its failure mode is the quiet one: a column
 * inserted in the middle would shift the fixture's cells while the file and the parser still agreed, so the
 * round-trip test would compare two differently-wrong readings and pass.
 *
 * Deliberately a re-read of the file rather than a literal: {@link SYNTHETIC_PACKAGE_ROWS} is what a filled
 * workbook is built from in the round-trip test, and if the rows were written out here the test would prove
 * that two copies of the same rows agree rather than that the committed fixture round-trips.
 */
function readFixtureRows(file: string): PackageWorkbookRow[] {
  return parsePackageWorkbook(readFixture(file)).map((staged) => {
    const payload = staged.payload as Record<string, string>
    const projected: Record<string, string> = {}
    for (const key of WORKBOOK_PAYLOAD_KEYS) projected[key] = payload[key] ?? ''
    return projected as unknown as PackageWorkbookRow
  })
}
