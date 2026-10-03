import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The durable half of Y-PAY-05: the gateway's side on file, the watermark, and every repair.
 *
 * Reads and writes only. The diff is `packages/payments/src/reconcile.ts` and this package may not
 * import it (ADR 0001).
 */

export const RECONCILIATION_SQLSTATE = {
  /** An observation, an exception or a run was edited beyond the single legal close. */
  recordIsAppendOnly: 'ZY681',
  /** A repair naming no event, or without both sides of the divergence. */
  repairIsNotJustified: 'ZY682',
  /** A quarantine committed with no `audit_event` in the same transaction. */
  quarantineNotAlerted: 'ZY683',
  /** A finished run closed behind the watermark. */
  watermarkWentBackwards: 'ZY684',
} as const

export type ReconciliationRule = keyof typeof RECONCILIATION_SQLSTATE

const sqlStateOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  const carried = (error as { details?: { sqlState?: unknown } }).details?.sqlState
  return typeof carried === 'string' ? carried : null
}

/**
 * A reconciliation refusal as a typed `AppError`, or null when the error is not one of ours.
 *
 * Matched on the five-character SQLSTATE alone (ADR 0043). Every one is `invariant_violated`: none can be
 * reached by a request, because the only caller is a scheduled pass. They are defects in the pass, and
 * the right answer is for the run to fail loudly and leave `finished_at` null — which is exactly what
 * makes the next pass re-read the window rather than skip it.
 */
export function reconciliationError(error: unknown): AppError | null {
  const state = sqlStateOf(error)
  if (state === null) return null
  const known = (Object.entries(RECONCILIATION_SQLSTATE) as [ReconciliationRule, string][]).find(
    ([, code]) => code === state,
  )
  if (known === undefined) return null
  const [rule] = known
  return new AppError(
    'invariant_violated',
    error instanceof Error ? error.message : `Reconciliation rule ${rule} refused the statement`,
    { details: { sqlState: state, rule } },
  )
}

/** Is this error the named reconciliation refusal? */
export function isReconciliationRule(error: unknown, rule: ReconciliationRule): boolean {
  return sqlStateOf(error) === RECONCILIATION_SQLSTATE[rule]
}

// ---------------------------------------------------------------------------------------------
// The watermark
// ---------------------------------------------------------------------------------------------

/**
 * Where the next pass resumes from: the cursor of the last FINISHED run, or `null` for the beginning.
 *
 * Only finished runs, which is the whole of the interrupted-run property. A single mutable cursor row
 * fails in exactly that case — it advances, the process dies before the repairs commit, and the events in
 * between are never read again and nothing says so.
 */
export async function readReconciliationWatermark(
  sql: Sql,
  gateway: string,
): Promise<string | null> {
  const [row] = await sql<{ cursorTo: string | null }[]>`
    select cursor_to as "cursorTo"
      from payment_reconciliation_watermark where gateway = ${gateway}
  `
  return row?.cursorTo ?? null
}

/** Opens a pass. Returns its id; it is NOT the watermark until it is closed. */
export async function openReconciliationRun(
  sql: Sql,
  gateway: string,
  cursorFrom: string | null,
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into payment_reconciliation_run (gateway, cursor_from)
    values (${gateway}, ${cursorFrom})
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'openReconciliationRun inserted no row and did not raise.',
    )
  }
  return row.id
}

/**
 * Closes a pass, which is what advances the watermark.
 *
 * The ONE legal UPDATE on the table, and `ZY681` refuses every other: a run cannot be re-attributed to
 * another gateway, re-dated, or closed twice. `ZY684` refuses a close behind the current watermark.
 */
export async function closeReconciliationRun(
  sql: Sql,
  input: {
    readonly runId: string
    readonly cursorTo: string | null
    readonly intentsExamined: number
    readonly repairs: number
    readonly quarantines: number
  },
): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    update payment_reconciliation_run
       set finished_at = now(),
           cursor_to = ${input.cursorTo},
           intents_examined = ${input.intentsExamined},
           repairs = ${input.repairs},
           quarantines = ${input.quarantines}
     where id = ${input.runId}::uuid and finished_at is null
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      `closeReconciliationRun matched no open run for ${input.runId}. A run closes once; a second close ` +
        'would move the watermark on evidence that has already been counted.',
    )
  }
}

// ---------------------------------------------------------------------------------------------
// The gateway's side
// ---------------------------------------------------------------------------------------------

export interface RecordObservationInput {
  readonly gateway: string
  readonly gatewayIntentId: string
  readonly state: string
  readonly authorisedFils: number
  readonly capturedFils: number
  readonly refundedFils: number
  /** The instant WE asked, ISO-8601. */
  readonly observedAtIso: string
  /** False when the gateway does not know this intent at all. */
  readonly recognised: boolean
}

/**
 * Records what the gateway said. Returns the observation's id, which every exception names.
 *
 * An unrecognised intent gets a row too, with nought figures — a MEASURED nothing rather than a stand-in,
 * because the gateway holds nothing for it. "We asked and it said no" and "we never asked" are different
 * facts and only the first justifies a quarantine.
 */
export async function recordGatewayObservation(
  uow: UnitOfWork,
  input: RecordObservationInput,
): Promise<string> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into gateway_state_observation (
      gateway, gateway_intent_id, state, authorised_fils, captured_fils, refunded_fils, observed_at,
      recognised
    ) values (
      ${input.gateway}, ${input.gatewayIntentId}, ${input.state},
      ${input.recognised ? input.authorisedFils : 0},
      ${input.recognised ? input.capturedFils : 0},
      ${input.recognised ? input.refundedFils : 0},
      ${input.observedAtIso}::timestamptz, ${input.recognised}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'recordGatewayObservation inserted no row and did not raise.',
    )
  }
  return row.id
}

// ---------------------------------------------------------------------------------------------
// The exceptions
// ---------------------------------------------------------------------------------------------

export interface RecordExceptionInput {
  readonly runId: string
  readonly paymentIntentId: string
  readonly gatewayIntentId: string
  readonly observationId: string
  readonly kind: 'repaired' | 'quarantined'
  /** `IntentDivergence` as the diff produced it, or null when the figures already agreed. */
  readonly before: unknown
  readonly after: unknown
  readonly missedEventIds: readonly string[]
  readonly detail: string
}

/**
 * Records one repair or one quarantine, and ALERTS a quarantine in the same transaction.
 *
 * Takes a `UnitOfWork` because `ZY683` reads the `audit_event` rows at COMMIT: an alert written
 * afterwards in a second transaction is not the same guarantee — the quarantine can commit and the alert
 * can fail, and the only evidence that an intent went unexplained would be the intent.
 *
 * `operation: 'denied'` for a quarantine, which is one of `ALWAYS_AUDITED`: a divergence nothing explains
 * is the shape of a gateway defect and of a tampered record, and telling those apart later needs the
 * attempt on the trail.
 */
export async function recordReconciliationException(
  uow: UnitOfWork,
  input: RecordExceptionInput,
): Promise<string> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into reconciliation_exception (
      run_id, payment_intent_id, gateway_intent_id, observation_id, kind, before_state, after_state,
      missed_event_ids, detail
    ) values (
      ${input.runId}::uuid, ${input.paymentIntentId}::uuid, ${input.gatewayIntentId},
      ${input.observationId}::uuid, ${input.kind},
      ${input.before === null || input.before === undefined ? null : uow.sql.json(input.before as never)},
      ${input.after === null || input.after === undefined ? null : uow.sql.json(input.after as never)},
      ${uow.sql.array([...input.missedEventIds])}, ${input.detail}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'recordReconciliationException inserted no row and did not raise.',
    )
  }
  if (input.kind === 'quarantined') {
    await uow.audit.record({
      action: 'payment.reconciliation-quarantined',
      entityType: 'reconciliation_exception',
      entityId: row.id,
      operation: 'denied',
      after: {
        gatewayIntentId: input.gatewayIntentId,
        detail: input.detail,
        missedEventIds: [...input.missedEventIds],
      },
    })
  }
  return row.id
}

export interface ReconciliationExceptionRow {
  readonly id: string
  readonly runId: string
  readonly gatewayIntentId: string
  readonly kind: string
  readonly missedEventIds: readonly string[]
  readonly detail: string
}

/** Every exception of one run. What the report reads and a test counts. */
export async function readReconciliationExceptions(
  sql: Sql,
  runId: string,
): Promise<readonly ReconciliationExceptionRow[]> {
  return await sql<ReconciliationExceptionRow[]>`
    select id,
           run_id            as "runId",
           gateway_intent_id as "gatewayIntentId",
           kind,
           missed_event_ids  as "missedEventIds",
           detail
      from reconciliation_exception
     where run_id = ${runId}::uuid
     order by created_at, gateway_intent_id
  `
}

export interface IntentPositionRow {
  readonly id: string
  readonly gatewayIntentId: string
  readonly state: string
  readonly authorisedFils: number
  readonly capturedFils: number
  readonly refundedFils: number
  readonly knownEventIds: readonly string[]
}

/**
 * Every intent this build holds for a gateway, with the event ids already on file, in ONE query.
 *
 * One query and not one per intent, because 500 intents is 500 round trips otherwise — and because the
 * positions have to be consistent with each other: read one at a time, a webhook landing between the
 * tenth and the eleventh produces a snapshot that was never true, and the pass would repair against it.
 *
 * `narrowTo` exists for the suites. The pass reads the whole population, and a suite that did the same
 * would reconcile every other suite's fixture intents into a table that refuses DELETE for every role
 * (brief rule 12) — so a suite narrows and the pass does not.
 */
export async function readIntentPositions(
  sql: Sql,
  gateway: string,
  narrowTo?: readonly string[],
): Promise<readonly IntentPositionRow[]> {
  const rows = await sql<
    {
      id: string
      gatewayIntentId: string
      state: string
      authorisedFils: string
      capturedFils: string
      refundedFils: string
      knownEventIds: readonly string[]
    }[]
  >`
    select pi.id,
           pi.gateway_intent_id as "gatewayIntentId",
           pi.state,
           pi.authorised_fils::bigint as "authorisedFils",
           pi.captured_fils::bigint   as "capturedFils",
           pi.refunded_fils::bigint   as "refundedFils",
           coalesce(
             array_agg(t.gateway_event_id order by t.occurred_at, t.gateway_event_id)
               filter (where t.gateway_event_id is not null),
             '{}'
           ) as "knownEventIds"
      from payment_intent pi
      left join payment_intent_transaction t on t.payment_intent_id = pi.id
     where pi.gateway = ${gateway}
       and pi.gateway_intent_id is not null
       ${narrowTo === undefined ? sql`` : sql`and pi.gateway_intent_id = any(${sql.array([...narrowTo])})`}
     group by pi.id
     order by pi.created_at
  `
  return rows.map((row) => ({
    id: row.id,
    gatewayIntentId: row.gatewayIntentId,
    state: row.state,
    authorisedFils: storedFils(row.authorisedFils, `authorised on ${row.gatewayIntentId}`),
    capturedFils: storedFils(row.capturedFils, `captured on ${row.gatewayIntentId}`),
    refundedFils: storedFils(row.refundedFils, `refunded on ${row.gatewayIntentId}`),
    knownEventIds: row.knownEventIds,
  }))
}

/**
 * A bigint money column as a number, refusing a value that does not survive the round trip.
 *
 * `createConnection` maps `bigint` to a string so nothing rounds a money figure, and this is the boundary
 * where it has to become one: the diff compares it with `!==` against the gateway's figure, and a string
 * makes every intent diverge in every field. `repositories/settlement.ts` and `repositories/commission.ts`
 * carry the same local copy, because this package may not import `filsFromStoredDigits` from core.
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
