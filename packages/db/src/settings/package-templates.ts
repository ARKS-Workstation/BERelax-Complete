import { PACKAGE_POLICY_SETTING_KEYS } from '@berelax/config'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { readPackageTemplates, type TillPackageTemplateRow } from '../queries/till.ts'
import { unconfirmedAssumptionRows, unconfirmedAssumptions } from '../settings-store.ts'
import { type PackageDefaultTerms, readPackageDefaultTerms } from './package.ts'

/**
 * What the package-reconstruction workbook is generated from, and what its validator judges against.
 *
 * H-MIG-02's constraint is that **there is no incumbent export**: outstanding packages are reconstructed by
 * hand into a workbook, so nothing can be imported until the shapes the workbook names already exist. This
 * module is the settings-side half of that — the two reads the generator and the validator need, and the one
 * check that holds two existing readers of the same column equal.
 *
 * ## Why this composes existing readers instead of querying
 *
 * `readPackageTemplates` (the till's sell list) already answers "every live template at max(version), with its
 * price, session count and terms", and `readPackageDefaultTerms` already answers "the three package-policy
 * settings and whether anybody has confirmed them". A third query for either would be the second statement of
 * a fact — and the one that matters here is `max(version)`, whose failure mode is a workbook generated against
 * a superseded version's price while every other screen shows the current one.
 *
 * The ONE genuinely new read is {@link readPackageTemplateKeys}, and it exists because the validator asks a
 * question no existing reader answers: does this template EXIST. `readPackageTemplates` deliberately drops a
 * retired template and a template with no version, which is right for a sell list and wrong here — see that
 * function's own note.
 */

/** A template key the validator may be handed, and whether there are terms to sell against. */
export interface PackageTemplateKeyRow {
  readonly templateKey: string
  /** False for a `package_template` row with no `package_template_version` yet. */
  readonly hasVersion: boolean
  /** True once `retired_at` is set. Retired templates are still valid on a reconstruction row. */
  readonly retired: boolean
}

/**
 * Every `package_template` key in the database, retired ones and versionless ones included.
 *
 * The validator's question, and it is a different question from the till's. Two rows the sell list correctly
 * hides are exactly the ones a reconstruction meets:
 *
 *   - **A RETIRED template.** `retired_at` withdraws a package from sale and leaves the balances sold under it
 *     redeemable (migration 0078). A customer holding sessions of a package the salon has since stopped
 *     selling is the ordinary case for this import, and refusing the key would leave a real liability with
 *     nowhere to go — which is the failure that costs money, as against admitting a row whose product is no
 *     longer offered, which costs nothing.
 *   - **A template with NO VERSION.** It cannot be sold against at all: `package_sale.template_version_id` is
 *     `not null`. The validator reports that separately from an unknown key, because "unknown" would send
 *     somebody to create a template that is already there.
 *
 * `left join` and not `exists`, so a template with several versions still yields one row.
 */
export async function readPackageTemplateKeys(sql: Sql): Promise<readonly PackageTemplateKeyRow[]> {
  return sql<PackageTemplateKeyRow[]>`
    select t.template_key                     as "templateKey",
           count(v.id) > 0                    as "hasVersion",
           t.retired_at is not null           as retired
      from package_template t
      left join package_template_version v on v.template_id = t.id
     group by t.template_key, t.retired_at
     order by t.template_key
  `
}

/** The three provisional terms, with the rows that put them on the Unconfirmed Assumptions panel. */
export interface PackageReconstructionPolicy {
  readonly terms: PackageDefaultTerms
  /**
   * The subset of {@link PACKAGE_POLICY_SETTING_KEYS} the Unconfirmed Assumptions query returns.
   *
   * Carried rather than recomputed, so the workbook can print the question id a reader will look up and so a
   * caller can assert the acceptance line — "validity, transferability and unredeemed-balance treatment are
   * provisional:true settings returned by the Unconfirmed Assumptions query" — against the query itself
   * rather than against a flag some other reader derived.
   */
  readonly unconfirmed: readonly {
    readonly key: string
    readonly openQuestionId: string | null
    readonly note: string | null
  }[]
}

/**
 * The package terms a reconstructed balance is assumed to carry, and the proof that they are still unanswered.
 *
 * ## Why this reads the same column through two queries and then compares them
 *
 * `readPackageDefaultTerms` reads `app_setting.is_provisional` per key; `unconfirmedAssumptions` selects
 * `where is_provisional`. Both are statements about the same column and both already ship, so this function
 * does not add a second one — it adds the check that holds them equal, in the same place that depends on
 * both. Without it the drift is silent in the direction that matters: a narrowed panel query would leave the
 * workbook printing "NONE OF THE THREE IS CONFIRMED" while the screen built to show unanswered assumptions
 * showed nothing, and the workbook would be the only place the reader was told.
 *
 * `unconfirmedAssumptionRows` is consulted as well, because the two are separate queries with separate
 * clauses — B-CAT-06 added the second precisely because the first read `app_setting` alone — and a package
 * term that reached one and not the other would be invisible on one of the two screens.
 */
export async function readPackageReconstructionPolicy(
  sql: Sql,
): Promise<PackageReconstructionPolicy> {
  const keys = new Set<string>(PACKAGE_POLICY_SETTING_KEYS)
  const [terms, flagged, panel] = await Promise.all([
    readPackageDefaultTerms(sql),
    unconfirmedAssumptions(sql),
    unconfirmedAssumptionRows(sql),
  ])
  const unconfirmed = flagged
    .filter((row) => keys.has(row.key))
    .map((row) => ({ key: row.key, openQuestionId: row.openQuestionId, note: row.note }))

  if (terms.isProvisional !== unconfirmed.length > 0) {
    throw new AppError(
      'invariant_violated',
      'The package policy settings read as ' +
        `${terms.isProvisional ? 'unconfirmed' : 'confirmed'} through readPackageDefaultTerms and as ` +
        `${unconfirmed.length > 0 ? 'unconfirmed' : 'confirmed'} through the Unconfirmed Assumptions ` +
        'query. Both read app_setting.is_provisional, so they cannot disagree unless one of them has been ' +
        'narrowed — and the reconstruction workbook prints one of them on its face, which would then be ' +
        'the only place a reader was told that a term is still an assumption.',
      {
        details: { isProvisional: terms.isProvisional, unconfirmed: unconfirmed.map((r) => r.key) },
      },
    )
  }

  const onPanel = new Set(
    panel.filter((row) => keys.has(row.reference)).map((row) => row.reference),
  )
  const missing = unconfirmed.filter((row) => !onPanel.has(row.key)).map((row) => row.key)
  if (missing.length > 0) {
    throw new AppError(
      'invariant_violated',
      `${missing.join(', ')} is flagged provisional and does not reach unconfirmedAssumptionRows, so it ` +
        'appears on the settings screen and not on the Unconfirmed Assumptions panel. The two queries read ' +
        'the same flag on the same table and a term visible on only one of the two screens is a term ' +
        'somebody will report as answered.',
      { details: { missing } },
    )
  }

  return { terms, unconfirmed }
}

/** One line of the workbook's template reference block. */
export interface WorkbookPackageTemplate {
  readonly templateKey: string
  readonly sessionCount: number
  readonly priceFils: string
  readonly publicDisplayName: string
}

/**
 * The templates the workbook's reference block lists: live, at their current version, four columns.
 *
 * The SELL list and not {@link readPackageTemplateKeys}, and the asymmetry with the validator is deliberate.
 * A person filling in a new row should be choosing from what the business currently offers; the validator has
 * to accept a key whose package was withdrawn years ago, because that balance is still owed. Listing a
 * retired template here would invite somebody to reconstruct a package against terms the salon has
 * deliberately stopped selling.
 *
 * It PROJECTS rather than passing the till row through, and the four columns it drops are the reason it
 * exists: `salesCount`, `sessionsRedeemed` and `sessionsSold` are the drawdown this system has recorded, and
 * the whole premise of the workbook is that the packages in it are the ones this system has NEVER seen. A
 * reference block showing "0 sales" beside every template would be a true figure making a false suggestion.
 *
 * An EMPTY list is a real answer and is not treated as an error: a database with no configured package has
 * nothing to reconstruct against, the workbook says so in words, and no row in it can validate. Inventing a
 * key to put in the list would be inventing the product (brief rule 15, and Y9-package-catalogue is open).
 */
export async function readWorkbookPackageTemplates(
  sql: Sql,
): Promise<readonly WorkbookPackageTemplate[]> {
  const rows: readonly TillPackageTemplateRow[] = await readPackageTemplates(sql)
  return rows.map((row) => ({
    templateKey: row.templateKey,
    sessionCount: row.sessionCount,
    priceFils: row.priceFils,
    publicDisplayName: row.publicDisplayName,
  }))
}
