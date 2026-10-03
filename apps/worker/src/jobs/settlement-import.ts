import {
  ACCOUNTS,
  type EntryId,
  entryId,
  filsFrom,
  type LocalDate,
  localDate,
  money,
  type ReverseCharge,
  reconcileSettlementBatch,
  recoverabilityOf,
  reverseChargeOn,
  SETTLEMENT_LINE_KINDS,
  SETTLEMENT_LINE_TIE_ACCOUNT,
  type SettlementBatchReconciliation,
  type SettlementFeeTax,
  type SettlementFile,
  type SettlementLine,
  type SettlementLineKind,
  type SettlementTie,
  STANDARD_SPA_CHART,
  settlementBatchEntry,
} from '@berelax/core'
import {
  findSettlementBatchByContent,
  isSettlementReimport,
  postJournalEntry,
  readSettlementTies,
  recordSettlementBatch,
  type Sql,
  settlementError,
  withUnitOfWork,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * Y-PAY-09 — importing one gateway payout file, as a queue with no schedule.
 *
 * **Why no `cron`.** A settlement import is triggered by a FILE ARRIVING. A cron here would be a poller
 * looking for work that whatever delivers the file already announced, and it would either run constantly
 * doing nothing or leave a payout unimported until it next fired. `assertRegistry` therefore demands no
 * `agent_definition` for it, because the thing G-AGT-01 watches is a schedule nobody is looking at; here
 * the caller is whatever accepted the file. Y-PAY-05's reconciliation job is the one with a cron, and it
 * brings its own agent row.
 *
 * **Nothing here parses a file**, and that is not a gap left for later. No gateway has been chosen
 * (OPEN-QUESTIONS `Y7-gateway`), so there is no format, and a parser written now would be a parser for a
 * layout this build invented — which is worse than none, because it would look like a contract. So the
 * job's payload is the file in its PARSED form plus `contentSha256`, which is the digest of the BYTES that
 * produced it. Whoever delivers a real file computes that digest and parses the layout; this job's subject
 * is everything after, which is where every way the process can go wrong lives.
 *
 * ## The order of operations, and why the hash check is first
 *
 * 1. `findSettlementBatchByContent`. A file already imported is a NO-OP: `already_imported`, no
 *    transaction, no entry, no audit row. The unique constraint on the column is the backstop for two
 *    importers racing, not the mechanism — see `repositories/settlement.ts`.
 * 2. `readSettlementTies` reads every local figure in one query.
 * 3. `reconcileSettlementBatch` in `@berelax/core` returns the identities and the named variances.
 * 4. Reconciled → build the entry, post it, record the batch `posted`. Not reconciled → record the batch
 *    `quarantined` with its variances, which writes the `audit_event` `ZY446` requires in the same
 *    transaction. **There is no third branch**: nothing is posted with exceptions beside it, and
 *    `ZY443` refuses the attempt.
 *
 * ## Why the fee's tax treatment is an argument and not a lookup here
 *
 * `supplier_tax_profile` holds whether the processor is offshore, and {@link settlementFeeTaxFor} reads
 * it — but the ABSENCE of a profile is a refusal rather than a default (ADR 0088's shape, docs/04 §4).
 * Defaulting to domestic drops the reverse charge on every offshore batch and the return still balances,
 * which is exactly why the obligation is the one most commonly missed at this size. So a batch with a fee
 * line and no supplier profile is quarantined with the fee line named, and no entry is posted.
 */

export const SETTLEMENT_IMPORT_JOB = 'payments.settlement-import'

/** One line of the payload. Positive fils; the direction is the kind. */
export interface SettlementImportLine {
  readonly lineNo: number
  readonly kind: SettlementLineKind
  readonly reference: string
  readonly amountFils: number
}

export interface SettlementImportData {
  readonly batchReference: string
  /** The digest of the BYTES the acquirer sent, lower-case hex. */
  readonly contentSha256: string
  /** `YYYY-MM-DD`, the day the acquirer paid, from the file. */
  readonly settledOn: string
  /** The net the FILE declares. Signed: an acquirer bills in a period of heavy chargebacks. */
  readonly declaredNetFils: number
  readonly lines: readonly SettlementImportLine[]
  /**
   * The supplier row for the processor, whose `supplier_tax_profile` decides the fee's treatment.
   *
   * Optional on the payload and REQUIRED when the file carries a fee line: a batch with a fee and no
   * named supplier is quarantined rather than posted at a guessed treatment.
   */
  readonly feeSupplierId?: string
}

export type SettlementImportOutcome =
  | { readonly kind: 'already_imported'; readonly batchId: string }
  | { readonly kind: 'posted'; readonly batchId: string; readonly journalEntryId: string }
  | {
      readonly kind: 'quarantined'
      readonly batchId: string
      readonly variances: readonly string[]
    }

export interface SettlementImportDeps {
  readonly sql: Sql
  /** Injected, so the suite can pin it. A job body never reads the clock itself. */
  readonly now: () => string
}

/**
 * The fee's tax treatment, read from `supplier_tax_profile`.
 *
 * Returns `null` when there is no profile, and the caller quarantines. NOT a default: the three states
 * `place_of_supply_rule` admits are `domestic_uae`, `imported_services_reverse_charge` and
 * `outside_scope`, and an absent row is a fourth state that means nobody has decided. Defaulting it to
 * domestic is the specific mistake docs/04 §4 calls the most commonly missed obligation at this size,
 * because the return balances either way.
 *
 * The reverse-charge PAIR comes from `reverseChargeOn` in `@berelax/core` and is not computed here, so
 * there is one implementation of the rounding and a settlement cannot round a half fils differently from
 * a supplier bill.
 */
export async function settlementFeeTaxFor(
  sql: Sql,
  supplierId: string,
  feeFils: number,
): Promise<SettlementFeeTax | null> {
  const [row] = await sql<{ rule: string }[]>`
    select place_of_supply_rule as rule
      from supplier_tax_profile
     where supplier_id = ${supplierId}::uuid
  `
  if (row === undefined) return null
  if (row.rule === 'imported_services_reverse_charge') {
    // Recoverability is a property of the ACCOUNT (0034) and `6080` is where a processor fee is coded, so
    // the classification is read from the chart rather than stated here.
    const account = STANDARD_SPA_CHART.accounts.find(
      (candidate) => candidate.code === ACCOUNTS.paymentProcessingFees,
    )
    if (account === undefined) {
      throw new AppError(
        'invariant_violated',
        `The chart holds no ${ACCOUNTS.paymentProcessingFees}, so a processor fee cannot be classified ` +
          'for recovery. A reverse charge needs the account to decide its input side.',
      )
    }
    const pair: ReverseCharge = reverseChargeOn(money(filsFrom(feeFils)), recoverabilityOf(account))
    return { treatment: 'imported_services_reverse_charge', reverseCharge: pair }
  }
  if (row.rule === 'domestic_uae') return { treatment: 'domestic_uae' }
  if (row.rule === 'outside_scope') return { treatment: 'outside_scope' }
  throw new AppError(
    'invariant_violated',
    `supplier_tax_profile.place_of_supply_rule is "${row.rule}", which this importer does not know. A ` +
      'treatment it cannot name is not a treatment it may guess at.',
  )
}

/** The entry id for one batch. Deterministic, so a retry after a crash cannot post a second entry. */
export function settlementEntryId(contentSha256: string): EntryId {
  // The CONTENT hash and not the batch reference: an acquirer may reuse a reference, and two files with
  // one reference are two settlements. Truncated to keep the id readable in a trial balance; 32 hex
  // characters is 128 bits, and a collision would be refused by the primary key rather than merged.
  return entryId(`SETTLE-${contentSha256.slice(0, 32)}`)
}

/**
 * Imports one payout file. Idempotent on `contentSha256`.
 *
 * Exported so the suite drives the same code the queue does, with its own connection and a pinned clock —
 * `handleWhatsappIssueRequest`'s arrangement one subject along.
 */
export async function importSettlementFile(
  deps: SettlementImportDeps,
  data: SettlementImportData,
): Promise<SettlementImportOutcome> {
  const existing = await findSettlementBatchByContent(deps.sql, data.contentSha256)
  if (existing !== null) return { kind: 'already_imported', batchId: existing.id }

  const lines: SettlementLine[] = data.lines.map((line) => ({
    lineNo: line.lineNo,
    kind: line.kind,
    reference: line.reference,
    amount: money(filsFrom(line.amountFils)),
  }))
  const file: SettlementFile = {
    batchReference: data.batchReference,
    contentSha256: data.contentSha256,
    settledOn: localDate(data.settledOn),
    declaredNetFils: data.declaredNetFils,
    lines,
  }

  const wanted = data.lines.map((line) => ({ kind: line.kind, reference: line.reference }))
  const rows = await readSettlementTies(deps.sql, wanted)
  const ties: SettlementTie[] = rows
    .filter((row): row is typeof row & { kind: SettlementLineKind } =>
      (SETTLEMENT_LINE_KINDS as readonly string[]).includes(row.kind),
    )
    .map((row) => ({ kind: row.kind, reference: row.reference, localFils: row.localFils }))

  const reconciliation = reconcileSettlementBatch(file, ties)

  // The fee's treatment is resolved BEFORE the posted/quarantined decision, because a missing supplier
  // profile is itself a reason to quarantine — and resolving it afterwards would mean a reconciled batch
  // threw instead of being quarantined, which loses the named reason an operator needs.
  const feeFils = reconciliation.totals.fees.fils
  let feeTax: SettlementFeeTax | null = null
  let feeProblem: string | null = null
  if (feeFils > 0) {
    if (data.feeSupplierId === undefined) {
      feeProblem =
        `The batch deducts ${feeFils} fils of processor fee and the import names no supplier, so its ` +
        'tax treatment cannot be read. Defaulting to domestic drops the reverse charge on every ' +
        'offshore batch and the return still balances (docs/04 §4), so the batch is quarantined.'
    } else {
      feeTax = await settlementFeeTaxFor(deps.sql, data.feeSupplierId, feeFils)
      if (feeTax === null) {
        feeProblem =
          `The batch deducts ${feeFils} fils of processor fee and supplier ${data.feeSupplierId} has no ` +
          'supplier_tax_profile row. An absent profile means nobody has decided whether the fee ' +
          'self-accounts under the imported-services reverse charge, and the absence is a refusal ' +
          'rather than a default (ADR 0088).'
      }
    }
  }

  const variances = [...reconciliation.variances]

  return await withUnitOfWork(
    deps.sql,
    { kind: 'system', label: SETTLEMENT_IMPORT_JOB },
    async (uow) => {
      const lineInputs = data.lines.map((line) => {
        const tie = ties.find(
          (candidate) => candidate.kind === line.kind && candidate.reference === line.reference,
        )
        return {
          lineNo: line.lineNo,
          kind: line.kind,
          reference: line.reference,
          amountFils: line.amountFils,
          tieAccountCode: SETTLEMENT_LINE_TIE_ACCOUNT[line.kind],
          // A fee ties to nothing and `ZY444` requires it to, so the local figure is dropped for one even
          // if a reader supplied it.
          localFils: line.kind === 'fee' ? null : (tie?.localFils ?? null),
        }
      })

      if (reconciliation.reconciled && feeProblem === null) {
        const posted = await postSettled(uow, reconciliation, feeTax, data)
        const recorded = await recordSettlementBatch(uow, {
          batchReference: data.batchReference,
          contentSha256: data.contentSha256,
          settledOn: data.settledOn,
          declaredNetFils: data.declaredNetFils,
          linesNetFils: data.declaredNetFils,
          lines: lineInputs,
          variances: [],
          journalEntryId: posted,
        })
        return { kind: 'posted', batchId: recorded.batchId, journalEntryId: posted } as const
      }

      if (feeProblem !== null) {
        // A batch-level variance, which is the one kind that names no line: the fee's TREATMENT is a fact
        // about the batch, and attaching it to the fee line would make `settlement_variance_line_only_for_a_line`
        // refuse it.
        variances.push({
          kind: 'unattributable',
          lineNo: null,
          lineKind: null,
          reference: data.batchReference,
          fileFils: feeFils,
          localFils: null,
          differenceFils: feeFils,
          explanation: feeProblem,
        })
      }

      const recorded = await recordSettlementBatch(uow, {
        batchReference: data.batchReference,
        contentSha256: data.contentSha256,
        settledOn: data.settledOn,
        declaredNetFils: data.declaredNetFils,
        // The LINES' own net, which is what `ZY442` holds to the rows — not the declared net, which is
        // the figure the rows are being checked against.
        linesNetFils: data.declaredNetFils - reconciliation.identities.declaredVersusLinesFils,
        lines: lineInputs,
        variances: variances.map((variance) => ({
          lineNo: variance.lineNo,
          kind: variance.kind,
          fileFils: variance.fileFils,
          localFils: variance.localFils,
          differenceFils: variance.differenceFils,
          explanation: variance.explanation,
        })),
        journalEntryId: null,
      })
      return {
        kind: 'quarantined',
        batchId: recorded.batchId,
        variances: variances.map((variance) =>
          variance.lineNo === null
            ? `${variance.kind}: ${variance.differenceFils} fils, no line`
            : `line ${variance.lineNo} ${variance.lineKind}: ${variance.kind}, ${variance.differenceFils} fils`,
        ),
      } as const
    },
  )
}

/** Builds and posts the batch's entry. Returns its id. */
async function postSettled(
  uow: Parameters<typeof postJournalEntry>[0],
  reconciliation: SettlementBatchReconciliation,
  feeTax: SettlementFeeTax | null,
  data: SettlementImportData,
): Promise<string> {
  const id = settlementEntryId(data.contentSha256)
  const entry = settlementBatchEntry({
    reconciliation,
    entryId: id,
    entryDate: localDate(data.settledOn) as LocalDate,
    chart: STANDARD_SPA_CHART,
    ...(feeTax === null ? {} : { feeTax }),
  })
  await postJournalEntry(uow, {
    entryId: entry.entryId,
    entryDate: entry.entryDate,
    narrative: entry.narrative,
    source: entry.source,
    lines: entry.lines.map((line) => ({
      accountCode: line.account,
      debitFils: line.debitFils,
      creditFils: line.creditFils,
      memo: line.memo,
    })),
  })
  return entry.entryId
}

const settlementImportHandler = async (
  data: SettlementImportData,
  _context: JobContext,
): Promise<void> => {
  const sql = importSql
  if (sql === undefined) {
    throw new AppError(
      'invariant_violated',
      'The settlement importer has no connection. `setSettlementImportSql` is called at boot, for the ' +
        'reason `setMediaStorage` is: JOB_REGISTRY is a module constant `pnpm jobs` enumerates without a ' +
        'database, so a handler whose dependencies were constructor arguments would turn the registry ' +
        'into a function and "every job is declared in one array" would stop being checkable statically.',
    )
  }
  try {
    await importSettlementFile({ sql, now: () => new Date().toISOString() }, data)
  } catch (error) {
    if (isSettlementReimport(error)) return
    throw settlementError(error) ?? error
  }
}

let importSql: Sql | undefined

export function setSettlementImportSql(sql: Sql): void {
  importSql = sql
}

export const SETTLEMENT_IMPORT_JOB_DEFINITION: JobDefinition<SettlementImportData> = {
  name: SETTLEMENT_IMPORT_JOB,
  purpose:
    'Imports one gateway payout file: matches every line to a capture, refund, chargeback, card tip or ' +
    'processor fee this build already holds, and either posts the net bank receipt or quarantines the ' +
    'whole batch with the variance named. Reconciliation is to the fils and there is no tolerance — a ' +
    'difference absorbed produces an entry that balances and a clearing balance that ties to nothing ' +
    '(Y-PAY-09, ADR 0090).',
  // No `cron`, and therefore no `agent`. An import is announced by the file that arrived; a schedule here
  // would be a poller looking for work an enqueue already named (W-SYS-05's argument, one subject along).
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // One read of the local figures, one entry and a statement per line. A payout file is tens of lines, not
  // thousands; a pass still running past two minutes is blocked rather than slow, and reclaiming it is
  // safe because the content hash makes a second attempt a no-op.
  expireInSeconds: 120,
  handler: settlementImportHandler,
}
