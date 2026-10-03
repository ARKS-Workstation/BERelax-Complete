import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The imported gateway payout: reading what this build holds, and writing the batch that followed.
 *
 * Y-PAY-09. The ARITHMETIC is `packages/core/src/payments/settlement.ts` and `packages/db` may not import
 * it (ADR 0001), so this module reads the local figures a reconciliation needs, writes the batch, its
 * lines and either its journal entry or its variances, and translates `0136`'s refusals. It decides
 * nothing: no figure here is computed from a rate, a tolerance or a date arithmetic.
 *
 * ## Why re-import is a SELECT and not a caught unique violation
 *
 * `settlement_batch.content_sha256` is unique, so a second import of one file cannot commit. That is the
 * backstop and not the mechanism: {@link findSettlementBatchByContent} is read first, and an ordinary
 * re-import answers `already_imported` without opening a transaction that will roll back. The reason the
 * distinction matters is what a caught unique violation costs: the import's own `audit_event` and
 * `journal_entry` writes would have happened inside the aborted transaction, so a retry loop would be
 * indistinguishable from a first import in the log, and the operator-visible answer would be an error
 * rather than "this file is already in".
 *
 * The digest is of the BYTES. Hashing the parsed lines would make two files that differ only in line
 * order two different batches, and two that differ by a line nobody parsed one batch.
 */

export const SETTLEMENT_SQLSTATE = {
  /** A batch, line or variance row was UPDATEd or DELETEd. */
  importIsAppendOnly: 'ZY441',
  /** A posted batch's declared net does not equal the signed sum of its lines. */
  doesNotReconcile: 'ZY442',
  /** Posted with a variance, quarantined with an entry, or quarantined with no variance. */
  postedAndQuarantined: 'ZY443',
  /** A posted line matched to nothing, mismatched, or a fee line carrying a local figure. */
  lineIsNotTied: 'ZY444',
  /** A line's tie account is not the one its kind declares. */
  tiesToTheWrongAccount: 'ZY445',
  /** A quarantined batch committed with no `audit_event` in the same transaction. */
  quarantineNotAlerted: 'ZY446',
  /** A variance row claiming a difference of nought fils. */
  varianceOfNought: 'ZY447',
} as const

export type SettlementRule = keyof typeof SETTLEMENT_SQLSTATE

/** `23505`: this file, or this movement, is already in. */
const UNIQUE_VIOLATION = '23505'

/** The constraints a second import trips, by name. The name is the contract. */
export const SETTLEMENT_CONSTRAINT = {
  oneBatchPerFile: 'settlement_batch_one_per_file',
  oneLinePerMovement: 'settlement_line_one_per_movement',
} as const

const sqlStateOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  const carried = (error as { details?: { sqlState?: unknown } }).details?.sqlState
  return typeof carried === 'string' ? carried : null
}

const constraintOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const name = (error as { constraint_name?: unknown }).constraint_name
  return typeof name === 'string' ? name : null
}

/**
 * A settlement refusal as a typed `AppError`, or null when the error is not one of ours.
 *
 * Matched on the five-character SQLSTATE alone, never on the message and never on the class: the class no
 * longer identifies a file (ADR 0043).
 *
 * Every one is `invariant_violated` and not one is `validation`, which is the opposite of
 * `chargebackError`'s split and deliberate. A chargeback's cap can be reached by an operator asking for
 * too large a refund — a person made a request the system declines. None of these can be reached by a
 * request: they are states the importer itself produced, so there is no figure to tell anybody and the
 * answer is a defect in the import rather than an answer to a user.
 */
export function settlementError(error: unknown): AppError | null {
  const state = sqlStateOf(error)
  if (state === null) return null
  const known = (Object.entries(SETTLEMENT_SQLSTATE) as [SettlementRule, string][]).find(
    ([, code]) => code === state,
  )
  if (known === undefined) return null
  const [rule] = known
  return new AppError(
    'invariant_violated',
    error instanceof Error ? error.message : `Settlement rule ${rule} refused the statement`,
    { details: { sqlState: state, rule } },
  )
}

/** Is this error the named settlement refusal? For a caller that branches on one rule. */
export function isSettlementRule(error: unknown, rule: SettlementRule): boolean {
  return sqlStateOf(error) === SETTLEMENT_SQLSTATE[rule]
}

/**
 * Is this the same payout file arriving twice?
 *
 * The backstop behind {@link findSettlementBatchByContent}, for two importers racing on one file. A bare
 * `23505` cannot be told apart from any other unique violation in the same statement — including
 * `settlement_line_one_per_movement`, which means something completely different and is a defect in the
 * file rather than a re-import.
 */
export function isSettlementReimport(error: unknown): boolean {
  return (
    sqlStateOf(error) === UNIQUE_VIOLATION &&
    constraintOf(error) === SETTLEMENT_CONSTRAINT.oneBatchPerFile
  )
}

// ---------------------------------------------------------------------------------------------
// Reading what this build already holds
// ---------------------------------------------------------------------------------------------

/** One (kind, reference) pair and the figure this build holds for it. `null` is "no such record". */
export interface SettlementTieRow {
  readonly kind: string
  readonly reference: string
  /**
   * Integer fils, or `null` for "no such record".
   *
   * A NUMBER, converted from the digits the driver returns. `createConnection` maps `bigint` to a
   * **string** on purpose — *"rather than a lossy JS number"* — and the consumer of this figure compares
   * it with `!==` against a file's own integer. A string left here therefore makes EVERY line of EVERY
   * batch a variance, which is how this was found: the integration suite's first run reported seven
   * failures whose message was `expected '21000' to be 21000`. {@link storedFils} is the conversion with
   * the round trip checked, so a figure that cannot be represented exactly is refused rather than
   * reconciled against.
   */
  readonly localFils: number | null
}

/**
 * A bigint money column as a number, refusing a value that does not survive the round trip.
 *
 * `createConnection` maps `bigint` to a STRING so nothing rounds a money figure on the way here, and this
 * is the boundary where it has to become a number — the reconciliation compares it with `!==` against a
 * file's own integer, and a string makes every line a variance. `filsFromStoredDigits` in `@berelax/core`
 * is the same guard and this package may not import it; `repositories/commission.ts` has the same local
 * copy for the same reason.
 */
function storedFils(value: string, what: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new AppError(
      'invariant_violated',
      `${what} is "${value}", which does not survive the round trip to a JavaScript number. A money ` +
        'figure that rounds is a different figure (ADR 0007).',
    )
  }
  return parsed
}

/**
 * The local figure for each (kind, reference) the file claims, in ONE query.
 *
 * One query and not four, because the four have to be consistent with each other: read separately, a
 * refund landing between the capture read and the refund read produces a position that was never true and
 * the batch would reconcile against it. That is `readRefundablePosition`'s argument one table along.
 *
 * Every row the caller asked about comes back, with `localFils` NULL where nothing answered: an absent
 * record and a record of nought are different claims (ADR 0070) and the caller has to tell them apart.
 *
 * ## Where each figure comes from
 *
 * - **capture** — `payment_intent.captured_fils` LESS the card tip (below). The acquirer reports the
 *   capture and the tip as separate lines while the till debited `1030` for the whole card tender, so
 *   `captures + tips = captured_fils` is an identity over two local sources rather than a restatement of
 *   one.
 * - **refund** — the sum of the intent's append-only `refunded` transaction rows. From the rows and not
 *   from `payment_intent.refunded_fils`, which `ZY163` holds equal to them: either would do, and the rows
 *   are what a settlement line is about.
 * - **chargeback** — `chargeback.amount_fils` for the `received` event of that dispute. The RECEIVED
 *   event, because a payout deducts what the acquirer TOOK; a dispute won afterwards is a separate
 *   movement in a later batch.
 * - **tip** — see below. There is no per-intent tip record in this build and this is a derivation.
 * - **fee** — nothing. A fee has no local counterpart and `ZY444` requires it to have none: nothing here
 *   knows what an acquirer will charge and a figure for one would be a rate this build invented.
 *
 * ## The tip's figure is the 2040 POSTING, read through a function that already exists
 *
 * `employee_tip` is keyed on employee, trading date and cash session and carries no payment and no
 * intent, so "the tip on this gateway capture" cannot be looked up there. It does not have to be:
 * `invoice_payable_fils()` (0068) is already `invoice.gross_total` PLUS *"the gratuity this document's own
 * posting collected ... read from the entry rather than carried in a second column, so the two cannot
 * disagree"* — the credit to `tips_payable_account_code()` on the invoice's `checkout_finalisation` entry.
 * So the tip on a ticket is `invoice_payable_fils(invoice) - invoice.gross_total`, exactly, and the figure
 * a settlement tip line is checked against IS the liability posting the acceptance line names. Nothing is
 * restated: `ZT001` already uses this function as the overpayment ceiling.
 *
 * The join to the gateway is `payment.reference`, and that is not a guess. `TENDER_TYPES.card_online` in
 * `@berelax/core` says of it in so many words: *"the reference is the gateway's own intent id, and a
 * `card_online` payment without one cannot be tied to a payout line, a webhook or a dispute"*, and
 * `requiresReference` is true for that kind, so the column is there by construction.
 *
 * Three cases, and the third is the one worth stating:
 *
 * - **one tender on the invoice** — the whole gratuity rode in on the card, so the tip is the ticket's,
 *   exact.
 * - **several tenders and no gratuity on the ticket at all** — a measured NOUGHT.
 * - **several tenders and a gratuity among them** — the apportionment between the tenders is recorded
 *   NOWHERE, so the figure is NULL and the line is quarantined. Not apportioned pro rata: that is a
 *   policy decision disguised as a calculation, and ADR 0070 refused the same arithmetic for a cost
 *   component. A quarantined line is investigated; an apportioned one reconciles perfectly against a
 *   figure nobody chose.
 */
export async function readSettlementTies(
  sql: Sql,
  wanted: readonly { readonly kind: string; readonly reference: string }[],
): Promise<readonly SettlementTieRow[]> {
  if (wanted.length === 0) return []
  const kinds = wanted.map((row) => row.kind)
  const references = wanted.map((row) => row.reference)
  const rows = await sql<{ kind: string; reference: string; localFils: string | null }[]>`
    with asked (kind, reference) as (
      select * from unnest(${kinds}::text[], ${references}::text[])
    ),
    ticket as (
      select p.reference                      as reference,
             (select count(*) from payment q where q.invoice_id = p.invoice_id)::int
                                              as tenders,
             -- The gratuity the ticket collected, from invoice_payable_fils() (0068) less the document's
             -- own gross: the credit to 2040 on the invoice's checkout entry, read where it lives rather
             -- than restated here.
             (invoice_payable_fils(p.invoice_id) - i.gross_total::bigint)
                                              as tip_total_fils
        from payment p
        join invoice i on i.id = p.invoice_id
       where p.tender_kind = 'card_online'
         and p.reference is not null
         and btrim(p.reference) <> ''
    ),
    card_tip as (
      select t.reference,
             case
               when t.tenders = 1 then t.tip_total_fils
               when t.tip_total_fils = 0 then 0::bigint
               else null::bigint
             end as tip_fils
        from ticket t
    ),
    refunded as (
      select pi.gateway_intent_id as reference,
             sum(tr.amount_fils::bigint) as refunded_fils
        from payment_intent pi
        join payment_intent_transaction tr on tr.payment_intent_id = pi.id
       where pi.gateway_intent_id is not null
         and tr.gateway_event_type = 'refunded'
       group by pi.gateway_intent_id
    )
    select a.kind, a.reference,
           case a.kind
             when 'capture' then (
               -- NULL when a card tender exists and its tip is indeterminate, because the capture is
               -- then indeterminate too: the split between the supply and the gratuity is the unknown.
               select case
                        when ct.reference is not null and ct.tip_fils is null then null
                        else pi.captured_fils::bigint - coalesce(ct.tip_fils, 0)
                      end
                 from payment_intent pi
                 left join card_tip ct on ct.reference = pi.gateway_intent_id
                where pi.gateway_intent_id = a.reference
                limit 1
             )
             when 'refund' then (
               select r.refunded_fils from refunded r where r.reference = a.reference
             )
             when 'tip' then (
               select ct.tip_fils from card_tip ct where ct.reference = a.reference
             )
             when 'chargeback' then (
               select c.amount_fils::bigint
                 from chargeback c
                where c.dispute_ref = a.reference and c.kind = 'received'
                limit 1
             )
             else null
           end as "localFils"
      from asked a
  `
  return rows.map((row) => ({
    kind: row.kind,
    reference: row.reference,
    localFils:
      row.localFils === null
        ? null
        : storedFils(row.localFils, `the local figure for ${row.kind} ${row.reference}`),
  }))
}

// ---------------------------------------------------------------------------------------------
// Writing the batch
// ---------------------------------------------------------------------------------------------

export interface SettlementBatchRow {
  readonly id: string
  readonly batchReference: string
  readonly contentSha256: string
  readonly settledOn: string
  readonly declaredNetFils: number
  readonly linesNetFils: number
  readonly state: string
  readonly journalEntryId: string | null
}

/** The batch this file already produced, or null. Read BEFORE an import opens a transaction. */
export async function findSettlementBatchByContent(
  sql: Sql,
  contentSha256: string,
): Promise<SettlementBatchRow | null> {
  const [row] = await sql<SettlementBatchRow[]>`
    select id,
           batch_reference          as "batchReference",
           content_sha256           as "contentSha256",
           settled_on::text         as "settledOn",
           declared_net_fils::bigint as "declaredNetFils",
           lines_net_fils::bigint   as "linesNetFils",
           state,
           journal_entry_id         as "journalEntryId"
      from settlement_batch
     where content_sha256 = ${contentSha256}
  `
  return row ?? null
}

export interface SettlementLineInput {
  readonly lineNo: number
  readonly kind: string
  readonly reference: string
  readonly amountFils: number
  readonly tieAccountCode: string
  readonly localFils: number | null
}

export interface SettlementVarianceInput {
  /** Null exactly for the `unattributable` kind, which is a fact about the batch. */
  readonly lineNo: number | null
  readonly kind: string
  readonly fileFils: number
  readonly localFils: number | null
  readonly differenceFils: number
  readonly explanation: string
}

export interface RecordSettlementBatchInput {
  readonly batchReference: string
  readonly contentSha256: string
  readonly settledOn: string
  readonly declaredNetFils: number
  readonly linesNetFils: number
  readonly lines: readonly SettlementLineInput[]
  /** Empty for a batch that reconciled; a batch with any variance is quarantined. */
  readonly variances: readonly SettlementVarianceInput[]
  /**
   * The entry the batch posts. Must already exist in the SAME transaction, and must be absent exactly
   * when the batch is quarantined — `ZY443` is that biconditional.
   */
  readonly journalEntryId: string | null
}

export interface RecordedSettlementBatch {
  readonly batchId: string
  readonly state: 'posted' | 'quarantined'
}

/**
 * Writes one imported batch: the header, its lines, and either its entry or its variances.
 *
 * Takes a `UnitOfWork` and not a bare `Sql`, and that is load-bearing twice. `ZY443` and `ZY444` are
 * deferred and read the LINES, so a header committed without them is a refusal that arrives after the
 * damage. And `ZY446` requires the quarantine's `audit_event` to be in the same transaction, which is
 * what `uow.audit` is — an audit row written afterwards would commit a quarantine nobody was told about.
 *
 * The state is DERIVED from `variances.length` rather than passed in. A caller that could say "posted"
 * while handing over a variance would be a caller that could post a batch with an open exception, and the
 * database would refuse it — correctly, and one layer later than the mistake was available.
 */
export async function recordSettlementBatch(
  uow: UnitOfWork,
  input: RecordSettlementBatchInput,
): Promise<RecordedSettlementBatch> {
  const state: 'posted' | 'quarantined' = input.variances.length === 0 ? 'posted' : 'quarantined'
  if (state === 'posted' && input.journalEntryId === null) {
    throw new AppError(
      'validation',
      `Batch ${input.batchReference} reconciled and was handed no journal entry. A posted batch with no ` +
        'entry is a payout the bank reconciliation treats as answered and the ledger has never heard of.',
    )
  }
  if (state === 'quarantined' && input.journalEntryId !== null) {
    throw new AppError(
      'validation',
      `Batch ${input.batchReference} carries ${input.variances.length} variance(s) and was handed ` +
        'journal entry ' +
        `${input.journalEntryId}. A quarantined batch posts nothing: an entry would put the acquirer's ` +
        'figures on the bank reconciliation while the variance that stopped the batch was still open.',
    )
  }

  const [batch] = await uow.sql<{ id: string }[]>`
    insert into settlement_batch (
      batch_reference, content_sha256, settled_on, declared_net_fils, lines_net_fils, state,
      journal_entry_id
    ) values (
      ${input.batchReference}, ${input.contentSha256}, ${input.settledOn}::date,
      ${input.declaredNetFils}, ${input.linesNetFils}, ${state}, ${input.journalEntryId}
    )
    returning id
  `
  if (batch === undefined) {
    throw new AppError(
      'invariant_violated',
      'recordSettlementBatch inserted no batch and did not raise.',
    )
  }
  const batchId = batch.id

  // One statement per line, which is the shape the deferred checks exist to allow. Batching them into one
  // INSERT would make an immediate trigger appear to work, and the first caller to loop would discover
  // otherwise — `postJournalEntry`'s own note, for its reason.
  const lineIds = new Map<number, string>()
  for (const line of input.lines) {
    const [row] = await uow.sql<{ id: string }[]>`
      insert into settlement_line (
        batch_id, line_no, kind, reference, amount_fils, tie_account_code, local_fils
      ) values (
        ${batchId}::uuid, ${line.lineNo}, ${line.kind}, ${line.reference}, ${line.amountFils},
        ${line.tieAccountCode}, ${line.localFils}
      )
      returning id
    `
    if (row === undefined) {
      throw new AppError(
        'invariant_violated',
        `recordSettlementBatch inserted no row for line ${line.lineNo} and did not raise.`,
      )
    }
    lineIds.set(line.lineNo, row.id)
  }

  for (const variance of input.variances) {
    const lineId = variance.lineNo === null ? null : lineIds.get(variance.lineNo)
    if (variance.lineNo !== null && lineId === undefined) {
      throw new AppError(
        'invariant_violated',
        `A variance names line ${variance.lineNo} of batch ${input.batchReference} and no such line was ` +
          'written. A variance pointing at nothing is an exception an operator cannot open.',
      )
    }
    await uow.sql`
      insert into settlement_variance (
        batch_id, settlement_line_id, kind, file_fils, local_fils, difference_fils, explanation
      ) values (
        ${batchId}::uuid, ${lineId ?? null}, ${variance.kind}, ${variance.fileFils},
        ${variance.localFils}, ${variance.differenceFils}, ${variance.explanation}
      )
    `
  }

  if (state === 'quarantined') {
    // `ZY446`. In THIS transaction, which is the whole claim: a quarantine that commits with no alert is
    // the force-match with an extra step — the lines sit in a table and the money sits unexplained.
    await uow.audit.record({
      action: 'settlement.quarantined',
      entityType: 'settlement_batch',
      entityId: batchId,
      operation: 'create',
      after: {
        batchReference: input.batchReference,
        declaredNetFils: input.declaredNetFils,
        linesNetFils: input.linesNetFils,
        variances: input.variances.map((variance) => ({
          kind: variance.kind,
          lineNo: variance.lineNo,
          differenceFils: variance.differenceFils,
        })),
      },
    })
  } else {
    await uow.audit.record({
      action: 'settlement.posted',
      entityType: 'settlement_batch',
      entityId: batchId,
      operation: 'create',
      after: {
        batchReference: input.batchReference,
        netFils: input.declaredNetFils,
        journalEntryId: input.journalEntryId,
        lines: input.lines.length,
      },
    })
  }

  return { batchId, state }
}

export interface SettlementVarianceRow {
  readonly id: string
  readonly batchId: string
  readonly batchReference: string
  readonly lineNo: number | null
  readonly kind: string
  readonly fileFils: number
  readonly localFils: number | null
  readonly differenceFils: number
  readonly explanation: string
}

/**
 * Every open variance, newest batch first. What the settlement report reads.
 *
 * A `left join` to the line, because the `unattributable` kind has none — and `line_no` comes back null
 * for it rather than zero, so a report can print "no line" instead of line 0.
 */
export async function readSettlementVariances(
  sql: Sql,
  limit = 200,
): Promise<readonly SettlementVarianceRow[]> {
  const rows = await sql<
    {
      id: string
      batchId: string
      batchReference: string
      lineNo: number | null
      kind: string
      fileFils: string
      localFils: string | null
      differenceFils: string
      explanation: string
    }[]
  >`
    select v.id,
           v.batch_id              as "batchId",
           b.batch_reference       as "batchReference",
           l.line_no               as "lineNo",
           v.kind,
           v.file_fils::bigint     as "fileFils",
           v.local_fils::bigint    as "localFils",
           v.difference_fils::bigint as "differenceFils",
           v.explanation
      from settlement_variance v
      join settlement_batch b on b.id = v.batch_id
      left join settlement_line l on l.id = v.settlement_line_id
     order by b.imported_at desc, l.line_no nulls last
     limit ${limit}
  `
  // The fils as NUMBERS, for `readSettlementTies`' reason: the driver returns a bigint as a string, and a
  // report comparing one with `===` — or a test asserting `toBe(1)` — fails on the type rather than on
  // the figure. `lineNo` is `integer` and needs no conversion, which is why it is read as it stands.
  return rows.map((row) => ({
    id: row.id,
    batchId: row.batchId,
    batchReference: row.batchReference,
    lineNo: row.lineNo,
    kind: row.kind,
    fileFils: storedFils(row.fileFils, `the file figure on variance ${row.id}`),
    localFils:
      row.localFils === null
        ? null
        : storedFils(row.localFils, `the local figure on variance ${row.id}`),
    differenceFils: storedFils(row.differenceFils, `the difference on variance ${row.id}`),
    explanation: row.explanation,
  }))
}

/**
 * The tie account `0136` declares for a kind, read from the database.
 *
 * Exists so `packages/fixtures/src/settlement.itest.ts` can hold `settlement_tie_account()` equal to
 * `SETTLEMENT_LINE_TIE_ACCOUNT` in `@berelax/core` — the two homes of one mapping, with the check that
 * holds them equal shipping in the same commit as the second one.
 */
export async function settlementTieAccount(sql: Sql, kind: string): Promise<string | null> {
  const [row] = await sql<{ code: string | null }[]>`
    select settlement_tie_account(${kind}) as code
  `
  return row?.code ?? null
}
