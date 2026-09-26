/**
 * The frequency ledger: reading a contact's counted sends, and writing the row beside the send.
 *
 * ## Why this file does no counting
 *
 * `packages/db` may not import `@berelax/core` (the dependency runs the other way), so the rolling-window
 * arithmetic cannot live here — and that is the right place for it anyway. Two implementations of "how
 * many sends are inside the window" is one implementation plus a future disagreement, and the
 * disagreement would be silent: SQL's `counted_at > now() - interval '7 days'` and TypeScript's
 * `instant > now - 7 * 86400 * 1000` are the same rule written twice, and the day one of them changes the
 * cap counts one thing and reports another.
 *
 * So {@link readCountedSendInstants} SELECTS and {@link decideFrequencyCap} in `@berelax/core` DECIDES.
 * The selection is not a count and cannot be mistaken for one: it has no `limit` (brief rule 12 — a limit
 * is right for a panel and wrong for a count) and its horizon is the widest cap's window, which the core
 * decision then VERIFIES rather than trusts. See `countedSince` on `FrequencyCapInput`: a horizon that
 * does not reach as far back as a cap's window makes that cap under-count, and under-counting a cap is
 * indistinguishable from not having one.
 *
 * ## Why the write is one function for both message classes
 *
 * {@link recordSendWithLedger} records the message row and, for a PROMOTIONAL message only, the ledger
 * row — in one transaction, and returns `ledgerRowId: null` for a transactional one. The alternative was
 * a function that refused a transactional message, and it is worse for the reason the acceptance line
 * names: "a transactional send is permitted in every cap state and is never written to the ledger" is a
 * claim about the choke point, and a choke point that transactional traffic goes around is a choke point
 * with a second path nobody tests. Here the transactional case goes through the same function and the
 * absence of the ledger row is the assertion.
 *
 * ## Why the transaction is the caller's when the caller has one
 *
 * The acceptance line is "the ledger row is written in the same transaction as the send attempt —
 * injecting a failure after the provider call asserts the ledger row and the message row agree rather
 * than diverging". Two rows that can diverge is the whole hazard: a message row with no ledger row is a
 * send that spent no allowance, and a ledger row with no message row is an allowance spent on nothing.
 *
 * `postgres.js` exposes `savepoint` on a transaction handle and not on the pool, which is what
 * {@link isTransaction} reads. Given a transaction, this writes into it — so C-AUTO-07's job handler can
 * enclose the send, its idempotency row and the ledger row in one commit. Given the pool, it opens its
 * own. There is no third shape in which the two rows are written outside one transaction.
 */
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import {
  createPostgresMessageStore,
  type MessageAttemptOutcome,
  type MessageRow,
  type MessageToRecord,
} from './message.ts'

/** The three things in this build that can ask for a promotional send. Mirrors `frequency_source_kind`. */
export const FREQUENCY_SOURCE_KINDS = ['flow', 'campaign', 'manual'] as const
export type FrequencySourceKind = (typeof FREQUENCY_SOURCE_KINDS)[number]

/** Who asked for the send, and the natural key the ledger de-duplicates on. */
export interface FrequencyLedgerAttribution {
  readonly contactCustomerId: string
  readonly sourceKind: FrequencySourceKind
  /** The flow key or campaign id. Not a foreign key: see 0080's header. */
  readonly sourceRef: string
  /**
   * The natural key of this attempt: `templateKey:messageId` for a send, C-AUTO-07's
   * `(flow_run, node, channel, contact)` key for a node. `frequency_ledger_one_counted_send` folds
   * counted rows on it, which is what makes an at-least-once replay after a merge count once.
   */
  readonly sendKey: string
}

/** The cap that refused, as it stood at the moment it refused. Recorded, never recomputed. */
export interface FrequencyBoundCap {
  /** `week` or `month`. Refused by `frequency_ledger_bound_cap_key_known` otherwise. */
  readonly key: string
  readonly limit: number
  readonly windowSeconds: number
  /** Sends counted inside the window. At or above `limit`, or the refusal did not have to happen. */
  readonly countInWindow: number
}

export interface CountedSendRow {
  readonly contactCustomerId: string
  /** Milliseconds since the epoch, which is what `@berelax/core`'s `Instant` is. */
  readonly countedAt: number
}

/**
 * Every COUNTED send for these contacts since `sinceIso`, newest first.
 *
 * `counted_at` and not `attempted_at`, and that is the whole of why one table can hold both a send and a
 * refusal: a refused attempt's `counted_at` is NULL and no comparison against a NULL is ever true, so a
 * refusal cannot reach this result set even if the predicate were the only thing standing between it and
 * the count. Reading `attempted_at` here would make the cap self-reinforcing — the first refusal would
 * raise the count that caused it, and the contact would be refused for ever.
 *
 * `sinceIso` must be derived from the WIDEST cap's window — `frequencyLedgerHorizonSeconds(caps)` in
 * `@berelax/core` is what computes it, from the caps rather than from a number written down twice. A
 * narrower horizon silently under-counts the wider cap, and an under-counted cap is indistinguishable
 * from no cap at all, which is why `decideFrequencyCap` is GIVEN the horizon and refuses one that is too
 * short rather than this function being trusted to have used the right one.
 */
export async function readCountedSendInstants(
  sql: Sql,
  args: {
    readonly contactCustomerIds: readonly string[]
    readonly sinceIso: string
    readonly untilIso: string
  },
): Promise<readonly CountedSendRow[]> {
  if (args.contactCustomerIds.length === 0) return []
  const rows = await sql<{ contactCustomerId: string; countedAtMs: string }[]>`
    select contact_customer_id as "contactCustomerId",
           (extract(epoch from counted_at) * 1000)::bigint::text as "countedAtMs"
      from frequency_ledger
     where contact_customer_id = any (${[...args.contactCustomerIds]}::uuid[])
       and counted_at > ${args.sinceIso}::timestamptz
       and counted_at <= ${args.untilIso}::timestamptz
     order by contact_customer_id, counted_at desc
  `
  return rows.map((row) => ({
    contactCustomerId: row.contactCustomerId,
    countedAt: Number(row.countedAtMs),
  }))
}

/**
 * The counted instants for one contact, grouped ready for `frequencyCapGateEvaluator`.
 *
 * A contact with no ledger rows gets an EMPTY ARRAY rather than being absent, and the distinction is the
 * one the gate's unevaluable path rests on: absent means the ledger was not read about this contact, and
 * `frequencyCapGateEvaluator` throws on it so the send is recorded `blocked_unevaluable`. An empty array
 * means it was read and there is nothing there. A reader that let "no rows" become "not asked" would make
 * a contact with no history indistinguishable from a database that was unreachable.
 */
export async function readCountedSendsByContact(
  sql: Sql,
  args: {
    readonly contactCustomerIds: readonly string[]
    readonly sinceIso: string
    readonly untilIso: string
  },
): Promise<ReadonlyMap<string, readonly number[]>> {
  const grouped = new Map<string, number[]>()
  for (const id of args.contactCustomerIds) grouped.set(id, [])
  for (const row of await readCountedSendInstants(sql, args)) {
    grouped.get(row.contactCustomerId)?.push(row.countedAt)
  }
  return grouped
}

export interface RecordedSendWithLedger {
  readonly message: MessageRow
  /** The ledger row, or `null` for a transactional message — which is never counted. */
  readonly ledgerRowId: string | null
}

/**
 * Records the message row and, for a promotional message, its ledger row, in ONE transaction.
 *
 * `attemptedAtIso` is the instant the send is counted at, and it is the CALLER's — the same clock the cap
 * decision used. Taking `now()` here would count the send at a different instant from the one the
 * decision was made at, which is unassertable to the second and therefore untestable at the boundary the
 * rolling window turns on.
 */
export async function recordSendWithLedger(
  sql: Sql,
  args: {
    readonly message: MessageToRecord
    readonly outcome: MessageAttemptOutcome
    readonly queuedAtIso: string
    readonly attemptedAtIso: string
    readonly attribution: FrequencyLedgerAttribution
  },
): Promise<RecordedSendWithLedger> {
  const body = async (tx: Sql): Promise<RecordedSendWithLedger> => {
    const message = await createPostgresMessageStore(tx).recordSend(
      args.message,
      args.outcome,
      args.queuedAtIso,
    )
    if (args.message.messageClass !== 'promotional') {
      // Transactional traffic is not counted and is not recorded here. Not a skipped branch: the
      // `ledgerRowId: null` is what `frequency-ledger.itest.ts` asserts over the whole class cross
      // product, and a booking confirmation that spent a marketing allowance would silence the
      // marketing this business is allowed to do.
      return { message, ledgerRowId: null }
    }
    const [row] = await tx<{ id: string }[]>`
      insert into frequency_ledger (
        contact_customer_id, outcome, counted_at, attempted_at, channel, message_id,
        source_kind, source_ref, send_key
      ) values (
        ${args.attribution.contactCustomerId}::uuid, 'sent',
        ${args.attemptedAtIso}::timestamptz, ${args.attemptedAtIso}::timestamptz,
        ${args.message.channel}::message_channel, ${message.id}::uuid,
        ${args.attribution.sourceKind}::frequency_source_kind, ${args.attribution.sourceRef},
        ${args.attribution.sendKey}
      )
      returning id
    `
    if (row === undefined) {
      throw new AppError(
        'invariant_violated',
        'The frequency ledger insert returned no row for a message that was recorded as sent. The two ' +
          'must agree: a message row with no ledger row is a promotional send that spent no allowance.',
        { details: { messageId: message.id, sendKey: args.attribution.sendKey } },
      )
    }
    return { message, ledgerRowId: row.id }
  }
  if (isTransaction(sql)) return await body(sql)
  // `tx as unknown as Sql` for the reason `withUnitOfWork` does it: postgres.js types a transaction
  // handle as `TransactionSql`, which is deliberately missing `END`, `CLOSE` and the pool's own members,
  // and every repository in this package takes `Sql`. The cast is at the seam and nowhere else.
  return (await sql.begin(async (tx) => await body(tx as unknown as Sql))) as RecordedSendWithLedger
}

/**
 * Records an attempt the cap refused, naming the cap that bound it.
 *
 * No message row, because nothing was sent — B-MSG-04 says why it writes none for a refused send, and
 * names this unit as where the `frequency_capped` outcome is kept. The four `bound_cap_*` columns are
 * required together by `frequency_ledger_refusal_names_its_cap`: a recorded limit with no count beside it
 * is a refusal nobody can check.
 */
export async function recordFrequencyCapRefusal(
  sql: Sql,
  args: {
    readonly attribution: FrequencyLedgerAttribution
    readonly channel: string
    readonly attemptedAtIso: string
    readonly boundCap: FrequencyBoundCap
  },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into frequency_ledger (
      contact_customer_id, outcome, refused_at, attempted_at, channel,
      source_kind, source_ref, send_key,
      bound_cap_key, bound_cap_limit, bound_cap_window_seconds, bound_cap_count
    ) values (
      ${args.attribution.contactCustomerId}::uuid, 'frequency_capped',
      ${args.attemptedAtIso}::timestamptz, ${args.attemptedAtIso}::timestamptz,
      ${args.channel}::message_channel,
      ${args.attribution.sourceKind}::frequency_source_kind, ${args.attribution.sourceRef},
      ${args.attribution.sendKey},
      ${args.boundCap.key}, ${args.boundCap.limit}, ${args.boundCap.windowSeconds},
      ${args.boundCap.countInWindow}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'The frequency-cap refusal insert returned no row. A refusal nobody recorded is a campaign whose ' +
        'missing recipients have no explanation.',
      { details: { sendKey: args.attribution.sendKey } },
    )
  }
  return row.id
}

/** One contact's ledger, newest attempt first. The read behind "why did this contact get nothing". */
export interface FrequencyLedgerEntry {
  readonly id: string
  readonly outcome: 'sent' | 'frequency_capped'
  readonly attemptedAtIso: string
  readonly countedAtIso: string | null
  readonly channel: string
  readonly messageId: string | null
  readonly sourceKind: FrequencySourceKind
  readonly sourceRef: string
  readonly sendKey: string
  readonly boundCapKey: string | null
  readonly boundCapLimit: number | null
  readonly boundCapWindowSeconds: number | null
  readonly boundCapCount: number | null
}

export async function readFrequencyLedger(
  sql: Sql,
  contactCustomerId: string,
): Promise<readonly FrequencyLedgerEntry[]> {
  const rows = await sql<
    {
      id: string
      outcome: 'sent' | 'frequency_capped'
      attemptedAt: Date
      countedAt: Date | null
      channel: string
      messageId: string | null
      sourceKind: FrequencySourceKind
      sourceRef: string
      sendKey: string
      boundCapKey: string | null
      boundCapLimit: number | null
      boundCapWindowSeconds: number | null
      boundCapCount: number | null
    }[]
  >`
    select id, outcome, attempted_at as "attemptedAt", counted_at as "countedAt", channel::text as channel,
           message_id as "messageId", source_kind as "sourceKind", source_ref as "sourceRef",
           send_key as "sendKey", bound_cap_key as "boundCapKey", bound_cap_limit as "boundCapLimit",
           bound_cap_window_seconds as "boundCapWindowSeconds", bound_cap_count as "boundCapCount"
      from frequency_ledger
     where contact_customer_id = ${contactCustomerId}::uuid
     order by attempted_at desc, id desc
  `
  return rows.map((row) => ({
    ...row,
    attemptedAtIso: row.attemptedAt.toISOString(),
    countedAtIso: row.countedAt === null ? null : row.countedAt.toISOString(),
  }))
}

/**
 * True when this handle is a transaction rather than the pool.
 *
 * `postgres.js` puts `savepoint` on a transaction handle and nowhere else — the same fact
 * `packages/fixtures/src/merge.itest.ts` relies on to nest a savepoint. Read here so
 * {@link recordSendWithLedger} can join a caller's transaction instead of opening a second one inside
 * it, which `postgres.js` would turn into a savepoint whose rollback the caller never hears about.
 */
function isTransaction(sql: Sql): boolean {
  return typeof (sql as unknown as { savepoint?: unknown }).savepoint === 'function'
}
