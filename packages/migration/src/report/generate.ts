import { DEFERRED_REVENUE_ACCOUNT_CODE, type Sql } from '@berelax/db'
import { AppError } from '@berelax/shared'
import { PROBE_IMPORTER_NAME, PROBE_TARGET } from '../conformance/probe-importer.ts'
import { VISITS_IMPORTER_NAME } from '../importers/appointments/import.ts'
import { CUSTOMERS_IMPORTER_NAME } from '../importers/customers/import.ts'
import { OPENING_IMPORTER_NAME } from '../importers/ledger/opening-balances.ts'
import { PACKAGES_IMPORTER_NAME } from '../importers/packages/import.ts'
import { STAFF_IMPORTER_NAME } from '../importers/staff/import.ts'
import { canonicalise, contentHash } from '../provenance.ts'

/**
 * The migration reconciliation report: one READING of what every import did, and nothing else.
 *
 * ## A report is a reading, and that is the whole shape of this module
 *
 * Nothing here writes. There is no table, no migration, no private SQLSTATE and no `UnitOfWork` anywhere
 * in the file, and `report/generate.ts` is absent from `write-path.test.ts`'s permitted list for the same
 * reason it is absent from `IMPORTERS`: a figure that defends an import must not be produced by something
 * that could have changed the import. The acceptance line "two runs on the same seed produce
 * byte-identical reports" is only a claim about the DATA if generating the report cannot move the data —
 * otherwise the second run measures the first one's side effects and the comparison passes by
 * construction.
 *
 * ## The run instant is held OUTSIDE the compared content
 *
 * {@link ReconciliationReport} has no timestamp in it, anywhere, and that is not an omission. A report
 * that carried the instant it ran at could never be compared with another run of itself: the bytes would
 * differ on the one field whose differing proves nothing. So the instant lives on
 * {@link ReconciliationRun}, which WRAPS the report — `{ generatedAt, contentDigest, report }` — and the
 * thing two runs are held equal on is `report` and its digest. `startedAt` and `finishedAt` are read off
 * every `import_run` row and deliberately dropped for the same reason; `runId` is kept because a uuid v7
 * is a fact about which run, not about when this report was generated.
 *
 * ## Zero unexplained variance, with no tolerance of any kind
 *
 * A variance is `sourceFigure - importedFigure` for one measure of one source file. Every variance is
 * decomposed into contributions from a CLOSED vocabulary ({@link VARIANCE_CAUSES}), each with its own
 * MEASURED magnitude, and what is left over is {@link Variance.unexplained}. There is no epsilon, no
 * rounding allowance and no "close enough": ADR 0007's money is integer fils, so the residual is an
 * integer, and ADR 0070 settled that an unattributable figure is a refusal rather than a zero. A non-zero
 * residual on any measure makes the whole report's exit status non-zero
 * ({@link reconciliationExitStatus}).
 *
 * The causes are subtracted rather than listed, which is the difference between this and a report that
 * merely annotates. A run with 3 rejected rows and a variance of 4 rows is NOT explained by "there were
 * rejections": three of the four are, and the fourth is the row somebody has to go and find.
 */

export const RECONCILIATION_REPORT_SCHEMA = 1 as const

/**
 * Every named cause a variance may be attributed to, and there are exactly three.
 *
 * Each one is a STATE of a staged row that the framework itself records, which is what makes the
 * magnitude measurable rather than asserted: `rejected`, `skipped` and `pending` are the three states in
 * `import_staging.import_row` that account for a staged row producing no entity. A fourth cause would
 * have to be a fourth row state, and there is none.
 *
 * Deliberately NOT a cause: "the importer quarantined the line". A quarantined line DOES produce a record
 * row — that is what `imported_contact.outcome = 'quarantined'` is — so it is on both sides of the count
 * and contributes nothing to a variance. Listing it would be an allowance for a difference that does not
 * exist, and the first row it absorbed would be a real one.
 */
export const VARIANCE_CAUSES = [
  'rejected_rows',
  'skipped_already_imported',
  'pending_rows',
] as const

export type VarianceCause = (typeof VARIANCE_CAUSES)[number]

export type VarianceMeasure = 'rows' | 'fils'

export interface VarianceContribution {
  readonly cause: VarianceCause
  /** Measured, in the variance's own units. Never a share and never a cap. */
  readonly figure: number
}

export interface Variance {
  /** `<importer>/<sourceFileHash>/<measure>`, or `quarantine/<relation>/rows`. Stable across runs. */
  readonly subject: string
  readonly measure: VarianceMeasure
  readonly sourceFigure: number
  readonly importedFigure: number
  /** `sourceFigure - importedFigure`. Signed: the two directions are different incidents. */
  readonly variance: number
  readonly explained: readonly VarianceContribution[]
  /** What no named cause accounts for. Anything but 0 fails the gate. */
  readonly unexplained: number
}

/**
 * Where the report reads an importer's own record of what it did.
 *
 * Every importer writes exactly ONE row per applied source row into a relation that exists for no other
 * purpose, and that relation is the second source this report reconciles against: the staged ledger says
 * what the file held, and this relation says what the database kept. `moneyColumn` is the figure on it
 * that a source total can be held against, and `null` means the source carries no money at all — which
 * is reported as `none_by_construction` and never as zero (ADR 0070).
 *
 * Declared here, keyed by the importers' own exported names, so a reader can enumerate what the report
 * covers. `report-coverage.test.ts` holds this map against `IMPORTERS` and against each importer's
 * declared `targetTables`, so a record relation that is not one of the importer's targets, or an importer
 * with no entry at all, is a test failure rather than a source file silently missing from the report.
 */
export const IMPORT_RECORDS: Readonly<
  Record<string, { readonly relation: string; readonly moneyColumn: string | null }>
> = Object.freeze({
  [PACKAGES_IMPORTER_NAME]: Object.freeze({
    relation: 'public.imported_package_sale',
    moneyColumn: 'price_paid_fils',
  }),
  [CUSTOMERS_IMPORTER_NAME]: Object.freeze({
    relation: 'public.imported_contact',
    moneyColumn: null,
  }),
  [VISITS_IMPORTER_NAME]: Object.freeze({
    relation: 'public.imported_appointment',
    moneyColumn: null,
  }),
  [STAFF_IMPORTER_NAME]: Object.freeze({
    relation: 'public.imported_staff_row',
    moneyColumn: null,
  }),
  [OPENING_IMPORTER_NAME]: Object.freeze({
    relation: 'public.opening_balance_import',
    moneyColumn: 'total_debit_fils',
  }),
  [PROBE_IMPORTER_NAME]: Object.freeze({
    relation: PROBE_TARGET,
    moneyColumn: null,
  }),
})

/**
 * How the money total a source file STATES is summed out of the staged payload.
 *
 * One entry per importer whose source carries money, and the key it carries it under. The opening trial
 * balance states its figures on a nested `lines` array rather than on a flat key, so the two are
 * different shapes and the extractor is a function rather than a column name.
 *
 * `report-coverage.test.ts` asserts every key named here is in that importer's own declared payload keys,
 * so a renamed cell is a test failure instead of a total that silently reads zero — which is the failure
 * mode this unit exists to make impossible.
 */
export const SOURCE_TOTALS: Readonly<
  Record<
    string,
    { readonly payloadKeys: readonly string[]; readonly of: (payload: unknown) => number }
  >
> = Object.freeze({
  [PACKAGES_IMPORTER_NAME]: Object.freeze({
    payloadKeys: Object.freeze(['pricePaidFils']),
    of: (payload: unknown) => wholeFils(readKey(payload, 'pricePaidFils')),
  }),
  [OPENING_IMPORTER_NAME]: Object.freeze({
    payloadKeys: Object.freeze(['lines']),
    of: (payload: unknown) => {
      const lines = readKey(payload, 'lines')
      if (!Array.isArray(lines)) {
        throw new AppError(
          'invariant_violated',
          'An opening-balance payload carried no `lines` array, so the file total cannot be summed. ' +
            'Refused rather than reported as 0: a zero here would read as a trial balance of nothing ' +
            'and would reconcile against an import that posted nothing (ADR 0070).',
        )
      }
      return lines.reduce<number>((sum, line) => sum + wholeFils(readKey(line, 'debitFils')), 0)
    },
  }),
})

const readKey = (payload: unknown, key: string): unknown =>
  typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined

/**
 * A staged money cell as integer fils, refusing anything else.
 *
 * `Number('40000.00')` is 40000 and an integer, which is H-MIG-07's recorded defect: a cell written in
 * dirhams-and-cents reads as a hundredth of itself and reconciles. So the text has to be a bare digit run
 * before it is a number at all, and a value that is not one is a refusal rather than a zero.
 */
function wholeFils(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  throw new AppError(
    'invariant_violated',
    `A staged money cell held ${JSON.stringify(value)}, which is not a whole number of fils. The file ` +
      'total is refused rather than reported as 0: money is integer fils (ADR 0007) and a decimal read ' +
      'with Number() is a hundredfold error that reconciles against nothing.',
  )
}

export type QuarantineRelation =
  | 'public.imported_contact'
  | 'public.imported_appointment'
  | 'public.imported_staff_row'

/**
 * The three record relations that can hold a QUARANTINED row, and nothing else holds one.
 *
 * `imported_package_sale` and `opening_balance_import` are absent and that is a property of those two
 * importers rather than an omission: a reconstruction workbook and an opening trial balance are
 * all-or-nothing on validity (ADR 0065), so a bad line is REJECTED at staging and no record row is
 * written at all. A quarantine is the other arrangement — the line is recorded, nothing is guessed, and
 * the reason is kept beside it — and only the three importers whose sources name things that may not
 * resolve have one.
 *
 * A union of literals rather than an array of strings, so the `switch` in {@link readQuarantinedRows}
 * cannot compile without a branch for every member: a relation added here with no query is a type error
 * instead of a quarantine the report silently does not enumerate.
 */
export const QUARANTINE_RELATIONS: readonly QuarantineRelation[] = Object.freeze([
  'public.imported_contact',
  'public.imported_appointment',
  'public.imported_staff_row',
])

export interface SourceFileReconciliation {
  readonly importer: string
  readonly importerVersion: string
  readonly sourceFile: string
  readonly sourceFileHash: string
  readonly runId: string
  readonly mode: string
  readonly state: string
  readonly recordRelation: string
  readonly sourceRows: number
  readonly appliedRows: number
  readonly skippedRows: number
  readonly rejectedRows: number
  readonly pendingRows: number
  /** Rows of {@link recordRelation} that provenance resolves to this run. The imported count. */
  readonly importedRows: number
  readonly sourceTotalFils: number | null
  readonly importedTotalFils: number | null
  /** `measured` or `none_by_construction`. Never `measured` with a null figure. */
  readonly totalBasis: 'measured' | 'none_by_construction'
  /**
   * Staged rows whose money cell could not be read as whole fils, so no total includes them.
   *
   * It can only be non-zero on a REJECTED row, and that is the point of reporting it rather than
   * absorbing it: the unreadable cell is usually WHY the row was rejected (`price-not-integer-fils` is
   * one of H-MIG-02's named rejections), so refusing to generate the report at all would mean a failed
   * import could not be reported on — the one case the report is most needed for. An unreadable cell on
   * an applied, skipped or pending row is a different thing entirely, and {@link readMoney} refuses it.
   *
   * Counted and stated because a total summed over fewer rows than the file has is a figure that means
   * less than its label, and a report that did not say so would be the quiet version of ADR 0070.
   */
  readonly unreadableMoneyCells: number
  readonly quarantinedRows: number
}

export interface LiabilityReading {
  /** What the reconstructed sales still owe, summed off `package_balance`. */
  readonly outstandingPackageLiabilityFils: number
  /** What the ledger carries on 2050. Held against the figure above by a variance. */
  readonly packageDeferredRevenueFils: number
  readonly reconstructedPackages: number
  readonly fullyDrawnPackages: number
  readonly leaveOpeningBalanceHundredths: number
  readonly leaveOpeningBalanceEmployees: number
  readonly leaveOpeningBalanceProvisional: number
  /**
   * Leave liability in MONEY, which this build cannot compute and therefore does not state.
   *
   * `employee.basic_wage_fils` is null for every employment record (Y8-staff), so a money figure here
   * would be the sum over an empty wage set — 0 fils, reading as a workforce that is owed nothing for
   * leave it has accrued. ADR 0070 settled that exact substitution: `unattributable`, naming the open
   * question, and never a zero. The DAYS are measured and stated above, because those are a fact.
   */
  readonly leaveLiabilityFils: null
  readonly leaveLiabilityBasis: 'unattributable'
  readonly leaveLiabilityOpenQuestionId: string
}

export interface DedupReading {
  readonly contactRecords: number
  readonly contactsCreated: number
  readonly contactsMatched: number
  readonly contactsQuarantined: number
  /** Distinct keyed digests across every contact import. */
  readonly distinctContactKeys: number
  /** Records beyond the first for a digest: the lines a later file repeated. */
  readonly repeatedContactKeys: number
  readonly consentClaimsDiscarded: number
}

export interface QuarantinedRow {
  readonly relation: string
  readonly recordId: string
  readonly reason: string
  readonly importer: string
  readonly sourceFile: string
  readonly sourceLine: number
  readonly contentHash: string
  readonly runId: string
}

export interface QuarantineReconciliation {
  readonly relation: string
  /** Rows the report ENUMERATED, each with a reason and a provenance. */
  readonly enumerated: number
  /** Rows the relation holds with a quarantine outcome, counted in SQL independently. */
  readonly counted: number
}

export interface ReconciliationReport {
  readonly schema: typeof RECONCILIATION_REPORT_SCHEMA
  readonly sources: readonly SourceFileReconciliation[]
  readonly liability: LiabilityReading
  readonly dedup: DedupReading
  readonly quarantine: readonly QuarantinedRow[]
  readonly quarantineCounts: readonly QuarantineReconciliation[]
  readonly variances: readonly Variance[]
  readonly unexplainedVariances: number
}

export interface ReconciliationRun {
  /** The one instant in the artefact, and it is OUTSIDE `report` on purpose. */
  readonly generatedAt: string
  /** sha-256 of the canonical form of `report`. What two runs are compared on. */
  readonly contentDigest: string
  readonly report: ReconciliationReport
}

export const LEAVE_LIABILITY_OPEN_QUESTION_ID = 'Y8-staff'

/** One variance, with its residual computed rather than asserted. */
export function varianceOf(input: {
  readonly subject: string
  readonly measure: VarianceMeasure
  readonly sourceFigure: number
  readonly importedFigure: number
  readonly explained?: readonly VarianceContribution[]
}): Variance {
  const explained = input.explained ?? []
  for (const contribution of explained) {
    if (!Number.isInteger(contribution.figure)) {
      throw new AppError(
        'invariant_violated',
        `The ${contribution.cause} contribution to ${input.subject} is ${String(contribution.figure)}, ` +
          'which is not an integer. Rows are counted and money is integer fils (ADR 0007), so a ' +
          'fractional contribution is the rounding allowance this unit is arranged to refuse.',
      )
    }
  }
  const variance = input.sourceFigure - input.importedFigure
  const accounted = explained.reduce((sum, contribution) => sum + contribution.figure, 0)
  return {
    subject: input.subject,
    measure: input.measure,
    sourceFigure: input.sourceFigure,
    importedFigure: input.importedFigure,
    variance,
    // Only the contributions that are non-zero. A listed cause of 0 is an explanation of nothing and
    // would make every variance look partly accounted for.
    explained: Object.freeze(explained.filter((contribution) => contribution.figure !== 0)),
    unexplained: variance - accounted,
  }
}

/** How many of a report's variances no named cause accounts for. */
export const unexplainedVarianceCount = (variances: readonly Variance[]): number =>
  variances.filter((variance) => variance.unexplained !== 0).length

/**
 * 0 when every variance is accounted for, 1 when any is not.
 *
 * A separate function from the count so that a caller cannot accidentally treat the COUNT as an exit
 * code: they agree at 0 and at 1 and disagree at 2, which is exactly the kind of coincidence that passes
 * a test and ships.
 */
export const reconciliationExitStatus = (report: ReconciliationReport): 0 | 1 =>
  report.unexplainedVariances > 0 ? 1 : 0

/** The bytes two runs are held equal on: the report, keys sorted, no instant anywhere in it. */
export const reportContentBytes = (report: ReconciliationReport): string => canonicalise(report)

export const reportContentDigest = (report: ReconciliationReport): string => contentHash(report)

/** Wraps a report with the instant it was generated at, which is the only place one appears. */
export const recordReconciliationRun = (
  report: ReconciliationReport,
  generatedAt: Date,
): ReconciliationRun => ({
  generatedAt: generatedAt.toISOString(),
  contentDigest: reportContentDigest(report),
  report,
})

/**
 * One staged row's money cell, or `null` when it cannot be read AND the row was rejected.
 *
 * The asymmetry is the decision. A rejected row's cell is allowed to be unreadable because that is
 * frequently the reason it was rejected, and a report that threw on it would be unable to describe a
 * failed import. An applied row's cell cannot be: it passed `validate`, so an unreadable value there is
 * a disagreement between the validator and this reader, and reporting it as 0 would make the file total
 * quietly smaller than the file. So that case propagates.
 */
export function readMoney(
  total: { readonly of: (payload: unknown) => number },
  row: { readonly state: string; readonly payload: unknown },
): number | null {
  try {
    return total.of(row.payload)
  } catch (error) {
    if (row.state === 'rejected') return null
    throw error
  }
}

interface RunRow {
  readonly runId: string
  readonly importer: string
  readonly importerVersion: string
  readonly sourceFile: string
  readonly sourceFileHash: string
  readonly mode: string
  readonly state: string
  readonly sourceRows: number
  readonly appliedRows: number
  readonly skippedRows: number
  readonly rejectedRows: number
  readonly pendingRows: number
}

/**
 * Every run, with its staged rows counted BY STATE in the same pass.
 *
 * Ordered by `(importer, source_file_hash, id)` and never by an instant, because the report's bytes are
 * compared across runs: `started_at` ordering is stable only until two runs share a millisecond, and the
 * day it is not stable the comparison fails on the order of two identical rows.
 *
 * `started_at` and `finished_at` are not selected at all. A column that is not read cannot leak into the
 * compared content by somebody later spreading the row into the report.
 */
async function readRuns(sql: Sql): Promise<readonly RunRow[]> {
  return sql<RunRow[]>`
    select r.id::text                                               as "runId",
           r.importer                                               as "importer",
           r.importer_version                                       as "importerVersion",
           r.source_file                                            as "sourceFile",
           r.source_file_hash                                       as "sourceFileHash",
           r.mode                                                   as "mode",
           r.state                                                  as "state",
           count(w.id)::int                                         as "sourceRows",
           count(w.id) filter (where w.state = 'applied')::int      as "appliedRows",
           count(w.id) filter (where w.state = 'skipped')::int      as "skippedRows",
           count(w.id) filter (where w.state = 'rejected')::int     as "rejectedRows",
           count(w.id) filter (where w.state = 'pending')::int      as "pendingRows"
      from import_staging.import_run r
      left join import_staging.import_row w on w.run_id = r.id
     group by r.id, r.importer, r.importer_version, r.source_file, r.source_file_hash, r.mode, r.state
     order by r.importer, r.source_file_hash, r.id
  `
}

/** Provenanced entity rows per (run, target relation). The IMPORTED side of every count variance. */
async function readProvenancedCounts(sql: Sql): Promise<ReadonlyMap<string, number>> {
  const rows = await sql<{ runId: string; relation: string; rows: number }[]>`
    select w.run_id::text                                      as "runId",
           p.target_schema || '.' || p.target_table            as "relation",
           count(*)::int                                       as "rows"
      from import_staging.import_provenance p
      join import_staging.import_row w on w.id = p.import_row_id
     group by 1, 2
  `
  return new Map(rows.map((row) => [`${row.runId}\u0000${row.relation}`, row.rows]))
}

/** The staged payloads of the two importers whose source states money, by run and row state. */
async function readStagedMoney(
  sql: Sql,
): Promise<readonly { runId: string; importer: string; state: string; payload: unknown }[]> {
  return sql<{ runId: string; importer: string; state: string; payload: unknown }[]>`
    select w.run_id::text as "runId", r.importer as "importer", w.state as "state", w.payload as "payload"
      from import_staging.import_row w
      join import_staging.import_run r on r.id = w.run_id
     where r.importer = any(${Object.keys(SOURCE_TOTALS)}::text[])
     order by w.run_id, w.line_number
  `
}

/**
 * What the database holds, per run, for each money importer's record relation.
 *
 * Two explicit queries and no dynamic relation name, because there are exactly two and a `format()` over
 * a column name would be a third thing to get wrong for no benefit. Each joins through provenance, so the
 * figure is "the rows THIS run produced" rather than "the rows the table happens to hold" — which is what
 * makes a second import of a second file reconcile separately instead of both reconciling against the
 * sum.
 */
async function readImportedMoney(sql: Sql): Promise<ReadonlyMap<string, number>> {
  const packages = await sql<{ runId: string; total: string }[]>`
    select w.run_id::text as "runId", coalesce(sum(i.price_paid_fils), 0)::text as "total"
      from imported_package_sale i
      join import_staging.import_provenance p
        on p.target_schema = 'public'
       and p.target_table = 'imported_package_sale'
       and p.target_id = i.id::text
      join import_staging.import_row w on w.id = p.import_row_id
     group by 1
  `
  const opening = await sql<{ runId: string; total: string }[]>`
    select w.run_id::text as "runId", coalesce(sum(o.total_debit_fils), 0)::text as "total"
      from opening_balance_import o
      join import_staging.import_provenance p
        on p.target_schema = 'public'
       and p.target_table = 'opening_balance_import'
       and p.target_id = o.import_id::text
      join import_staging.import_row w on w.id = p.import_row_id
     group by 1
  `
  return new Map([...packages, ...opening].map((row) => [row.runId, Number(row.total)]))
}

/**
 * Every quarantined row, with its reason and its provenance, from the three relations that hold one.
 *
 * The WHOLE JOIN CHAIN is inner — provenance, then the staged row, then the run — and that is the
 * mechanism behind the third acceptance line. A quarantined record that no staged row explains cannot be
 * enumerated with a provenance, so it drops out of this list while {@link readQuarantineCounts} still
 * counts it in SQL, and the difference is a variance with no named cause.
 *
 * Inner at every step rather than only at the first, which is not a stylistic choice: with a LEFT JOIN to
 * provenance alone the row is still dropped by the inner join to `import_row`, so changing one of the
 * three is a NO-OP and a reader who changed it would believe they had changed the behaviour. (That is not
 * hypothetical — a gate case in block 183 was written against exactly that anchor and reported a defect
 * it had not created.) Make them all outer and the row is enumerated with empty provenance fields, which
 * reads as a row that came from nowhere and reconciles; the case that proves the detection works is 183h,
 * which absorbs the difference into a named cause instead.
 */
async function readQuarantinedRows(
  sql: Sql,
  relation: QuarantineRelation,
): Promise<readonly QuarantinedRow[]> {
  const provenanced = async (
    table: 'imported_contact' | 'imported_appointment' | 'imported_staff_row',
  ) => {
    switch (table) {
      case 'imported_contact':
        return sql<Omit<QuarantinedRow, 'relation'>[]>`
          select i.id::text as "recordId", i.quarantine_reason as "reason", r.importer as "importer",
                 r.source_file as "sourceFile", w.line_number as "sourceLine",
                 w.row_hash as "contentHash", r.id::text as "runId"
            from imported_contact i
            join import_staging.import_provenance p
              on p.target_schema = 'public' and p.target_table = 'imported_contact'
             and p.target_id = i.id::text
            join import_staging.import_row w on w.id = p.import_row_id
            join import_staging.import_run r on r.id = w.run_id
           where i.outcome = 'quarantined'
           order by r.source_file_hash, w.line_number, i.id
        `
      case 'imported_appointment':
        return sql<Omit<QuarantinedRow, 'relation'>[]>`
          select i.id::text as "recordId", i.quarantine_reason as "reason", r.importer as "importer",
                 r.source_file as "sourceFile", w.line_number as "sourceLine",
                 w.row_hash as "contentHash", r.id::text as "runId"
            from imported_appointment i
            join import_staging.import_provenance p
              on p.target_schema = 'public' and p.target_table = 'imported_appointment'
             and p.target_id = i.id::text
            join import_staging.import_row w on w.id = p.import_row_id
            join import_staging.import_run r on r.id = w.run_id
           where i.outcome = 'quarantined'
           order by r.source_file_hash, w.line_number, i.id
        `
      case 'imported_staff_row':
        return sql<Omit<QuarantinedRow, 'relation'>[]>`
          select i.id::text as "recordId", i.quarantine_reason as "reason", r.importer as "importer",
                 r.source_file as "sourceFile", w.line_number as "sourceLine",
                 w.row_hash as "contentHash", r.id::text as "runId"
            from imported_staff_row i
            join import_staging.import_provenance p
              on p.target_schema = 'public' and p.target_table = 'imported_staff_row'
             and p.target_id = i.id::text
            join import_staging.import_row w on w.id = p.import_row_id
            join import_staging.import_run r on r.id = w.run_id
           where i.outcome = 'quarantined'
           order by r.source_file_hash, w.line_number, i.id
        `
    }
  }
  const table = relation.slice('public.'.length) as
    | 'imported_contact'
    | 'imported_appointment'
    | 'imported_staff_row'
  const rows = await provenanced(table)
  return rows.map((row) => ({ relation, ...row }))
}

/** The same three relations, counted in SQL without touching provenance. The independent half. */
async function readQuarantineCounts(sql: Sql): Promise<ReadonlyMap<string, number>> {
  const rows = await sql<{ relation: string; rows: number }[]>`
      select 'public.imported_contact' as "relation", count(*)::int as "rows"
        from imported_contact where outcome = 'quarantined'
    union all
      select 'public.imported_appointment', count(*)::int
        from imported_appointment where outcome = 'quarantined'
    union all
      select 'public.imported_staff_row', count(*)::int
        from imported_staff_row where outcome = 'quarantined'
  `
  return new Map(rows.map((row) => [row.relation, row.rows]))
}

async function readLiability(sql: Sql): Promise<LiabilityReading> {
  const packages = await sql<
    {
      outstanding: string
      reconstructed: number
      fullyDrawn: number
    }[]
  >`
    select coalesce(sum(remaining_value_fils), 0)::text                  as "outstanding",
           count(*)::int                                                 as "reconstructed",
           count(*) filter (where package_sale_id is null)::int          as "fullyDrawn"
      from imported_package_liability
  `
  // Scoped to the entries an IMPORT posted, through provenance, and not to the whole account. 2050 also
  // carries every package the till has ever sold (`sell-package.ts`), so an unscoped sum would be held
  // against a reconstruction total it has nothing to do with and would report a variance the size of the
  // business's ordinary trading — which is the shape of a figure nobody can act on, and the first
  // response to one is to stop reading the report.
  const deferred = await sql<{ balance: string }[]>`
    select coalesce(sum(l.credit_fils - l.debit_fils), 0)::text as "balance"
      from journal_line l
     where l.account_code = ${DEFERRED_REVENUE_ACCOUNT_CODE}
       and exists (
             select 1
               from import_staging.import_provenance p
              where p.target_schema = 'public'
                and p.target_table = 'journal_entry'
                and p.target_id = l.entry_id
           )
  `
  const leave = await sql<{ hundredths: string; employees: number; provisional: number }[]>`
    select coalesce(sum(hundredths), 0)::text                     as "hundredths",
           count(distinct employee_id)::int                       as "employees",
           count(*) filter (where is_provisional)::int            as "provisional"
      from leave_movement
     where kind = 'opening_balance'
  `
  return {
    outstandingPackageLiabilityFils: Number(packages[0]?.outstanding ?? '0'),
    packageDeferredRevenueFils: Number(deferred[0]?.balance ?? '0'),
    reconstructedPackages: packages[0]?.reconstructed ?? 0,
    fullyDrawnPackages: packages[0]?.fullyDrawn ?? 0,
    leaveOpeningBalanceHundredths: Number(leave[0]?.hundredths ?? '0'),
    leaveOpeningBalanceEmployees: leave[0]?.employees ?? 0,
    leaveOpeningBalanceProvisional: leave[0]?.provisional ?? 0,
    leaveLiabilityFils: null,
    leaveLiabilityBasis: 'unattributable',
    leaveLiabilityOpenQuestionId: LEAVE_LIABILITY_OPEN_QUESTION_ID,
  }
}

async function readDedup(sql: Sql): Promise<DedupReading> {
  const rows = await sql<
    {
      records: number
      created: number
      matched: number
      quarantined: number
      distinctKeys: number
      consentDiscarded: number
    }[]
  >`
    select count(*)::int                                            as "records",
           count(*) filter (where outcome = 'created')::int          as "created",
           count(*) filter (where outcome = 'matched')::int          as "matched",
           count(*) filter (where outcome = 'quarantined')::int      as "quarantined",
           count(distinct contact_hmac)::int                         as "distinctKeys",
           count(*) filter (where consent_claim_discarded)::int      as "consentDiscarded"
      from imported_contact
  `
  const row = rows[0]
  const records = row?.records ?? 0
  const distinctKeys = row?.distinctKeys ?? 0
  return {
    contactRecords: records,
    contactsCreated: row?.created ?? 0,
    contactsMatched: row?.matched ?? 0,
    contactsQuarantined: row?.quarantined ?? 0,
    distinctContactKeys: distinctKeys,
    repeatedContactKeys: records - distinctKeys,
    consentClaimsDiscarded: row?.consentDiscarded ?? 0,
  }
}

/**
 * Reads the whole reconciliation, and writes nothing.
 *
 * Takes an `Sql` and never a `UnitOfWork`, which is the type-level half of "a report is a reading": there
 * is no `audit.record`, no `publish` and no transaction to join, so a caller cannot pass this function
 * something it could write through. `write-path.test.ts` is the repository-level half.
 */
interface RunContext {
  readonly provenanced: ReadonlyMap<string, number>
  readonly stagedMoney: readonly { runId: string; state: string; payload: unknown }[]
  readonly importedMoney: ReadonlyMap<string, number>
  readonly quarantinedByRun: ReadonlyMap<string, number>
}

/**
 * One run's reconciliation and its variances.
 *
 * Extracted from {@link generateReconciliationReport} rather than inlined, because the loop body IS the
 * unit's arithmetic and a reader looking for "how is a variance decided" should find one function rather
 * than the middle of a reader. It also keeps the generator under the cognitive-complexity ceiling
 * `biome.json` sets, which is a real constraint here: a formatter diagnostic stops every verify step.
 */
function reconcileRun(
  run: RunRow,
  context: RunContext,
): { readonly source: SourceFileReconciliation; readonly variances: readonly Variance[] } {
  const record = IMPORT_RECORDS[run.importer]
  if (record === undefined) {
    throw new AppError(
      'invariant_violated',
      `The staging ledger holds a run of "${run.importer}" and this report has no record relation for ` +
        'it, so its rows would be reconciled against nothing and the file would read as fully imported. ' +
        'Refused rather than reported: an importer absent from IMPORT_RECORDS is a gap in the report, ' +
        'not a source with no variance.',
      { details: { importer: run.importer } },
    )
  }
  const total = SOURCE_TOTALS[run.importer]
  const importedRows = context.provenanced.get(`${run.runId}\u0000${record.relation}`) ?? 0

  const runMoney =
    total === undefined
      ? []
      : context.stagedMoney
          .filter((row) => row.runId === run.runId)
          .map((row) => ({ state: row.state, fils: readMoney(total, row) }))
  const sourceTotalFils =
    total === undefined ? null : runMoney.reduce((sum, row) => sum + (row.fils ?? 0), 0)
  const importedTotalFils = total === undefined ? null : (context.importedMoney.get(run.runId) ?? 0)

  const source: SourceFileReconciliation = {
    importer: run.importer,
    importerVersion: run.importerVersion,
    sourceFile: run.sourceFile,
    sourceFileHash: run.sourceFileHash,
    runId: run.runId,
    mode: run.mode,
    state: run.state,
    recordRelation: record.relation,
    sourceRows: run.sourceRows,
    appliedRows: run.appliedRows,
    skippedRows: run.skippedRows,
    rejectedRows: run.rejectedRows,
    pendingRows: run.pendingRows,
    importedRows,
    sourceTotalFils,
    importedTotalFils,
    totalBasis: total === undefined ? 'none_by_construction' : 'measured',
    unreadableMoneyCells: runMoney.filter((row) => row.fils === null).length,
    quarantinedRows: context.quarantinedByRun.get(run.runId) ?? 0,
  }

  const variances: Variance[] = [
    varianceOf({
      subject: `${run.importer}/${run.sourceFileHash}/rows`,
      measure: 'rows',
      sourceFigure: run.sourceRows,
      importedFigure: importedRows,
      explained: [
        { cause: 'rejected_rows', figure: run.rejectedRows },
        { cause: 'skipped_already_imported', figure: run.skippedRows },
        { cause: 'pending_rows', figure: run.pendingRows },
      ],
    }),
  ]

  if (sourceTotalFils !== null && importedTotalFils !== null) {
    // The money a non-applied row states, BY STATE, so each contribution is measured in fils rather than
    // inferred from a row count. A rejected row and a skipped row are not the same money.
    const moneyInState = (state: string) =>
      runMoney.filter((row) => row.state === state).reduce((sum, row) => sum + (row.fils ?? 0), 0)
    variances.push(
      varianceOf({
        subject: `${run.importer}/${run.sourceFileHash}/fils`,
        measure: 'fils',
        sourceFigure: sourceTotalFils,
        importedFigure: importedTotalFils,
        explained: [
          { cause: 'rejected_rows', figure: moneyInState('rejected') },
          { cause: 'skipped_already_imported', figure: moneyInState('skipped') },
          { cause: 'pending_rows', figure: moneyInState('pending') },
        ],
      }),
    )
  }

  return { source, variances: Object.freeze(variances) }
}

/**
 * Reads the whole reconciliation, and writes nothing.
 *
 * Takes an `Sql` and never a `UnitOfWork`, which is the type-level half of "a report is a reading": there
 * is no `audit.record`, no `publish` and no transaction to join, so a caller cannot pass this function
 * something it could write through. `write-path.test.ts` is the repository-level half.
 */
export async function generateReconciliationReport(sql: Sql): Promise<ReconciliationReport> {
  const runs = await readRuns(sql)
  const context: RunContext = {
    provenanced: await readProvenancedCounts(sql),
    stagedMoney: await readStagedMoney(sql),
    importedMoney: await readImportedMoney(sql),
    quarantinedByRun: new Map(),
  }
  const quarantineCountsByRelation = await readQuarantineCounts(sql)

  const quarantine: QuarantinedRow[] = []
  for (const relation of QUARANTINE_RELATIONS) {
    quarantine.push(...(await readQuarantinedRows(sql, relation)))
  }
  const quarantinedByRun = new Map<string, number>()
  for (const row of quarantine) {
    quarantinedByRun.set(row.runId, (quarantinedByRun.get(row.runId) ?? 0) + 1)
  }

  const sources: SourceFileReconciliation[] = []
  const variances: Variance[] = []
  for (const run of runs) {
    const reconciled = reconcileRun(run, { ...context, quarantinedByRun })
    sources.push(reconciled.source)
    variances.push(...reconciled.variances)
  }

  const quarantineCounts: QuarantineReconciliation[] = QUARANTINE_RELATIONS.map((relation) => ({
    relation,
    enumerated: quarantine.filter((row) => row.relation === relation).length,
    counted: quarantineCountsByRelation.get(relation) ?? 0,
  }))

  for (const entry of quarantineCounts) {
    // `counted` is the SOURCE side here: the relation holds this many quarantined rows, and the report
    // managed to resolve a provenance for `enumerated` of them. A row it could not resolve is a record
    // nothing attests to, which has no named cause and therefore fails the report.
    variances.push(
      varianceOf({
        subject: `quarantine/${entry.relation}/rows`,
        measure: 'rows',
        sourceFigure: entry.counted,
        importedFigure: entry.enumerated,
      }),
    )
  }

  const liability = await readLiability(sql)

  // The one liability identity H-MIG-03's first acceptance line is about, re-asserted over whatever the
  // database holds now: what the balances still owe and what 2050 carries are computed from different
  // rows by different code, so the import is only right if they agree to the fils. A difference has no
  // named cause by construction — there is no state of a staged row that could account for it.
  variances.push(
    varianceOf({
      subject: 'liability/package-deferred-revenue/fils',
      measure: 'fils',
      sourceFigure: liability.outstandingPackageLiabilityFils,
      importedFigure: liability.packageDeferredRevenueFils,
    }),
  )

  return {
    schema: RECONCILIATION_REPORT_SCHEMA,
    sources: Object.freeze(sources),
    liability,
    dedup: await readDedup(sql),
    quarantine: Object.freeze(quarantine),
    quarantineCounts: Object.freeze(quarantineCounts),
    variances: Object.freeze(variances),
    unexplainedVariances: unexplainedVarianceCount(variances),
  }
}
