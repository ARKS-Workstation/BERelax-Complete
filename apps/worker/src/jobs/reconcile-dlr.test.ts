/**
 * The delivery-receipt pass: out of order, duplicated, unrecognised, and counted.
 *
 * Against the in-memory store, so the lifecycle rules are exercised in the unit suite where they run in
 * milliseconds. The *database's* enforcement of the same rules — the trigger, the replay index, the
 * constraints — is asserted against real PostgreSQL in `packages/fixtures/src/message-lifecycle.itest.ts`.
 * Both matter: this file proves the pass reads a receipt correctly, that one proves the row cannot be
 * written wrongly even by something that never came through here.
 */
import {
  createInMemoryMessageStore,
  type DeliveryReceiptRecord,
  type ReceiptSource,
} from '@berelax/messaging'
import { describe, expect, it } from 'vitest'
import { reconcileDeliveryReceipts } from './reconcile-dlr.ts'

const AT = '2026-09-18T10:00:00.000Z'
const LATER = '2026-09-18T10:05:00.000Z'

const sent = {
  kind: 'accepted' as const,
  providerMessageId: 'transactional:smsala-000001',
  segments: 1,
  costFils: 9,
  atIso: AT,
}

const message = {
  templateId: 't1',
  channel: 'sms' as const,
  messageClass: 'transactional' as const,
  locale: 'en' as const,
  vendor: 'smsala' as const,
  recipient: '+971528239069',
  senderId: 'BERELAX',
  subject: null,
  body: 'Your appointment is confirmed.',
  bodyHtml: null,
  encoding: 'GSM-7' as const,
  segments: 1,
  costFils: 9,
}

function receipt(overrides: Partial<DeliveryReceiptRecord> = {}): DeliveryReceiptRecord {
  return {
    vendor: 'smsala',
    providerMessageId: sent.providerMessageId,
    vendorStatus: 'delivered',
    mapped: 'delivered',
    occurredAtIso: LATER,
    reason: null,
    ...overrides,
  }
}

/** A source that yields a fixed list once, like a drained vendor queue. */
function sourceOf(receipts: readonly DeliveryReceiptRecord[]): ReceiptSource {
  let drained = false
  return {
    vendor: 'smsala',
    async drain() {
      if (drained) return []
      drained = true
      return receipts
    },
  }
}

async function storeWithOneSentMessage() {
  const store = createInMemoryMessageStore()
  const row = await store.recordSend(message, sent, AT)
  return { store, row }
}

describe('a receipt that advances the status', () => {
  it('applies it and records it', async () => {
    const { store, row } = await storeWithOneSentMessage()
    const result = await reconcileDeliveryReceipts({ store, sources: [sourceOf([receipt()])] })
    expect(result).toMatchObject({ drained: 1, applied: 1, replayed: 0, unknown: 0, ignored: {} })
    expect(store.byId(row.id)?.status).toBe('delivered')
    expect(store.byId(row.id)?.deliveredAtIso).toBe(LATER)
    expect(store.byId(row.id)?.receipts).toHaveLength(1)
  })
})

describe('a receipt that arrives out of order', () => {
  it('does not regress the status, asserted on the final stored value', async () => {
    const { store, row } = await storeWithOneSentMessage()
    // The delivered receipt overtakes the accepted one, which is the normal case for a webhook.
    const result = await reconcileDeliveryReceipts({
      store,
      sources: [
        sourceOf([
          receipt({ vendorStatus: 'delivered', mapped: 'delivered', occurredAtIso: LATER }),
          receipt({ vendorStatus: 'accepted', mapped: 'sent', occurredAtIso: AT }),
        ]),
      ],
    })
    expect(result.applied).toBe(1)
    expect(result.ignored).toEqual({ status_would_not_advance: 1 })
    // The assertion the acceptance criterion names: the FINAL stored value.
    expect(store.byId(row.id)?.status).toBe('delivered')
    // Both receipts are on record, including the one that changed nothing. A receipt discarded
    // silently is a receipt nobody can use to explain the status three days later.
    expect(store.byId(row.id)?.receipts).toHaveLength(2)
  })

  it('keeps the first terminal state when a second one follows', async () => {
    const { store, row } = await storeWithOneSentMessage()
    const result = await reconcileDeliveryReceipts({
      store,
      sources: [
        sourceOf([
          receipt({ vendorStatus: 'delivered', mapped: 'delivered', occurredAtIso: AT }),
          // A late expiry notice from the vendor's retry queue. The handset already acknowledged it.
          receipt({ vendorStatus: 'expired', mapped: 'failed', occurredAtIso: LATER }),
        ]),
      ],
    })
    expect(result.applied).toBe(1)
    expect(result.ignored).toEqual({ status_would_not_advance: 1 })
    expect(store.byId(row.id)?.status).toBe('delivered')
    expect(store.byId(row.id)?.failedAtIso).toBeNull()
  })
})

describe('a duplicate webhook', () => {
  it('is idempotent: one transition and one receipt however many times it is replayed', async () => {
    const { store, row } = await storeWithOneSentMessage()
    const before = store.byId(row.id)
    const three = [receipt(), receipt(), receipt()]
    const result = await reconcileDeliveryReceipts({ store, sources: [sourceOf(three)] })
    expect(result.drained).toBe(3)
    expect(result.applied).toBe(1)
    // Two of the three conflicted on the replay guard, so they are not two more receipts and not two
    // more transitions.
    expect(result.replayed).toBe(2)
    expect(store.byId(row.id)?.receipts).toHaveLength(1)
    expect(store.byId(row.id)?.status).toBe('delivered')
    // Cost is unchanged by a receipt, replayed or not: a delivery does not re-bill a message.
    expect(store.byId(row.id)?.costFils).toBe(before?.costFils)
    expect(store.byId(row.id)?.attempts).toBe(before?.attempts)
  })
})

describe('a vendor status this system does not recognise', () => {
  it('changes nothing, is recorded with its own word, and is not read as delivered', async () => {
    const { store, row } = await storeWithOneSentMessage()
    const result = await reconcileDeliveryReceipts({
      store,
      sources: [sourceOf([receipt({ vendorStatus: 'DELIVRD', mapped: null })])],
    })
    expect(result.applied).toBe(0)
    expect(result.ignored).toEqual({ vendor_status_unrecognised: 1 })
    // The point of the whole mapping: not delivered.
    expect(store.byId(row.id)?.status).toBe('sent')
    expect(store.byId(row.id)?.receipts[0]?.vendorStatus).toBe('DELIVRD')
  })

  it('still applies the ones it does recognise in the same batch', async () => {
    // The control. Without it, a pass that ignored everything would satisfy the test above.
    const { store, row } = await storeWithOneSentMessage()
    const result = await reconcileDeliveryReceipts({
      store,
      sources: [
        sourceOf([
          receipt({ vendorStatus: 'DELIVRD', mapped: null, occurredAtIso: AT }),
          receipt({ vendorStatus: 'delivered', mapped: 'delivered', occurredAtIso: LATER }),
        ]),
      ],
    })
    expect(result.applied).toBe(1)
    expect(result.ignored).toEqual({ vendor_status_unrecognised: 1 })
    expect(store.byId(row.id)?.status).toBe('delivered')
  })
})

describe('a recognised event that is not about delivery', () => {
  it('records Resend opened and complained without moving the status', async () => {
    const { store, row } = await storeWithOneSentMessage()
    const result = await reconcileDeliveryReceipts({
      store,
      sources: [
        sourceOf([
          receipt({ vendorStatus: 'opened', mapped: 'no_lifecycle_change', occurredAtIso: AT }),
          receipt({
            vendorStatus: 'complained',
            mapped: 'no_lifecycle_change',
            occurredAtIso: LATER,
          }),
        ]),
      ],
    })
    expect(result.applied).toBe(0)
    expect(result.ignored).toEqual({ vendor_status_carries_no_lifecycle_change: 2 })
    // A complaint follows a delivery. Reporting it as a failure would say the message never arrived.
    expect(store.byId(row.id)?.status).toBe('sent')
    expect(store.byId(row.id)?.receipts).toHaveLength(2)
  })
})

describe('a receipt for a message this system never sent', () => {
  it('is counted rather than thrown, and creates nothing', async () => {
    const { store } = await storeWithOneSentMessage()
    const result = await reconcileDeliveryReceipts({
      store,
      sources: [sourceOf([receipt({ providerMessageId: 'transactional:smsala-999999' })])],
    })
    expect(result.unknown).toBe(1)
    expect(result.applied).toBe(0)
    expect(store.all()).toHaveLength(1)
  })
})

describe('a pass with no source', () => {
  it('refuses rather than reporting a tidy zero', async () => {
    const { store } = await storeWithOneSentMessage()
    // "0 receipts drained" from a run with nothing wired up reads exactly like a quiet night, which is
    // how a broken DLR path stays broken for a month.
    await expect(reconcileDeliveryReceipts({ store, sources: [] })).rejects.toThrow(
      /no receipt source/,
    )
  })

  it('names the vendors it did read', async () => {
    const { store } = await storeWithOneSentMessage()
    const result = await reconcileDeliveryReceipts({ store, sources: [sourceOf([])] })
    expect(result.vendors).toEqual(['smsala'])
    expect(result.drained).toBe(0)
  })
})
