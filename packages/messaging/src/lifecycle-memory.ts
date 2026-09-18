/**
 * An in-memory `MessageLifecycleStore`, for the tests that are not about SQL.
 *
 * Two things need one. The retry path — exact attempt counts per failure mode, and the declared backoff —
 * is arithmetic over a clock and a policy, and it should be provable in the unit suite where it runs in
 * milliseconds. And the DLR pass's own counting (drained, applied, replayed, ignored by reason) is a loop,
 * not a query.
 *
 * ## What it does and does not claim
 *
 * It keeps the two promises the port makes: the replay guard (a receipt with the same message, vendor
 * status and instant is recorded once) and the no-regression rule (a receipt that would lower the status
 * changes nothing and says why). Both by calling `advanceMessageStatus` — the *same* function the
 * Postgres store calls — so this cannot agree with a rule the real one does not implement.
 *
 * It claims nothing about the constraints, the trigger or the row lock. Those are the database's, and
 * `packages/fixtures/src/message-lifecycle.itest.ts` asserts every one of them against real PostgreSQL.
 * A fake that asserted them would be a second implementation of the schema, which is the shape of test
 * that passes while production is broken.
 */
import { advanceMessageStatus, type MessageStatus } from '@berelax/shared'
import type {
  AttemptOutcome,
  DeliveryReceiptRecord,
  MessageLifecycleStore,
  MessageRecord,
  ReceiptApplication,
  RecordedMessage,
} from './lifecycle.ts'

/** One stored message, with the fields the port exposes plus the ones a test wants to read. */
export interface StoredMessage extends MessageRecord {
  readonly message: RecordedMessage
  readonly queuedAtIso: string
  readonly sentAtIso: string | null
  readonly deliveredAtIso: string | null
  readonly failedAtIso: string | null
  readonly receipts: readonly DeliveryReceiptRecord[]
}

export interface InMemoryMessageStore extends MessageLifecycleStore {
  /** Every row, in insertion order. */
  all(): readonly StoredMessage[]
  byId(id: string): StoredMessage | undefined
}

export function createInMemoryMessageStore(): InMemoryMessageStore {
  const rows = new Map<string, StoredMessage>()
  /** `message_delivery_receipt_replay_unique`, in a set. */
  const seenReceipts = new Set<string>()
  let counter = 0

  const write = (row: StoredMessage): StoredMessage => {
    rows.set(row.id, row)
    return row
  }

  const applyOutcome = (row: StoredMessage, outcome: AttemptOutcome): StoredMessage => {
    if (outcome.kind === 'accepted') {
      return {
        ...row,
        status: 'sent',
        providerMessageId: outcome.providerMessageId,
        attempts: row.attempts + 1,
        segments: outcome.segments,
        costFils: outcome.costFils,
        nextAttemptAtIso: null,
        lastFailureReason: null,
        sentAtIso: outcome.atIso,
      }
    }
    if (outcome.kind === 'held') {
      return { ...row, status: 'queued', nextAttemptAtIso: outcome.releaseAtIso }
    }
    const terminal = outcome.nextAttemptAtIso === null
    return {
      ...row,
      status: terminal ? 'failed' : 'queued',
      attempts: row.attempts + 1,
      nextAttemptAtIso: outcome.nextAttemptAtIso,
      lastFailureReason: outcome.reason,
      failedAtIso: terminal ? outcome.atIso : null,
    }
  }

  return {
    async recordSend(message, outcome, queuedAtIso) {
      counter += 1
      const blank: StoredMessage = {
        id: `mem-${String(counter).padStart(4, '0')}`,
        status: 'queued',
        providerMessageId: null,
        attempts: 0,
        segments: message.segments,
        costFils: message.costFils,
        nextAttemptAtIso: null,
        lastFailureReason: null,
        message,
        queuedAtIso,
        sentAtIso: null,
        deliveredAtIso: null,
        failedAtIso: null,
        receipts: [],
      }
      return write(applyOutcome(blank, outcome))
    },

    async recordAttempt(messageId, outcome) {
      const row = rows.get(messageId)
      if (row === undefined) throw new Error(`No in-memory message ${messageId}`)
      return write(applyOutcome(row, outcome))
    },

    async applyReceipt(receipt): Promise<ReceiptApplication> {
      const row = [...rows.values()].find(
        (candidate) =>
          candidate.message.vendor === receipt.vendor &&
          candidate.providerMessageId === receipt.providerMessageId,
      )
      if (row === undefined) {
        return { kind: 'unknown_message', providerMessageId: receipt.providerMessageId }
      }
      const key = `${row.id}|${receipt.vendorStatus}|${receipt.occurredAtIso}`
      if (seenReceipts.has(key)) {
        return { kind: 'replayed', messageId: row.id, status: row.status }
      }
      seenReceipts.add(key)
      write({ ...row, receipts: [...row.receipts, receipt] })

      if (receipt.mapped === 'no_lifecycle_change') {
        return {
          kind: 'ignored',
          messageId: row.id,
          status: row.status,
          reason: 'vendor_status_carries_no_lifecycle_change',
        }
      }
      const advance = advanceMessageStatus(row.status, receipt.mapped)
      if (!advance.applied) {
        return { kind: 'ignored', messageId: row.id, status: row.status, reason: advance.reason }
      }
      const next: MessageStatus = advance.status
      write({
        ...(rows.get(row.id) as StoredMessage),
        status: next,
        nextAttemptAtIso: null,
        deliveredAtIso: next === 'delivered' ? receipt.occurredAtIso : row.deliveredAtIso,
        failedAtIso: next === 'failed' ? receipt.occurredAtIso : row.failedAtIso,
        lastFailureReason: next === 'failed' ? 'delivery_reported_failed' : row.lastFailureReason,
      })
      return { kind: 'applied', messageId: row.id, status: next }
    },

    all() {
      return [...rows.values()]
    },

    byId(id) {
      return rows.get(id)
    },
  }
}
