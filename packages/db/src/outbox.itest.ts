import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from './connection.ts'
import {
  drainOutbox,
  type HandlerRegistration,
  outboxBacklog,
  publishEvent,
  type StoredEvent,
} from './outbox.ts'
import { withUnitOfWork } from './tx.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
const STAFF = {
  kind: 'staff',
  id: '33333333-3333-3333-3333-333333333333',
  label: 'Reception',
} as const

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

beforeEach(async () => {
  // Every undelivered event, not only this file's.
  //
  // `drainOutbox` is the worker's drain: it claims the oldest undelivered rows across the whole table,
  // deliberately, because that is what a worker has to do. So a test of it cannot coexist with another
  // unit's leftovers — and the moment a second unit started publishing (M-VAT-05's thousand journal
  // postings were the first), five assertions here began reading that unit's events instead of their own.
  // The symptom was "expected 1, got 50", in a file that had passed for weeks.
  //
  // `outbox_event` is not append-only, so unlike `audit_event` it can be cleared. Scoping the cleanup to
  // `aggregate_type = 'f06_test'` was not enough and could not have been: the reads are global.
  await sql`delete from outbox_event where published_at is null`
})

afterEach(async () => {
  await sql`delete from outbox_event where aggregate_type = 'f06_test'`
  // audit_event is deliberately append-only (migration 0005 DO INSTEAD NOTHING rules), so it
  // CANNOT be cleaned between tests — a delete here would silently do nothing. Every audit
  // assertion therefore uses an action unique to its own run. This is a permanent constraint on
  // how audit is tested, not a quirk of this file.
})

/** A per-run unique suffix, because audit rows accumulate forever by design. */
const RUN = `${process.pid}-${Math.floor(Math.random() * 1e6)}`

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

const event = (key: string, type = 'f06.thing.happened') => ({
  eventType: type,
  aggregateType: 'f06_test',
  aggregateId: 'agg-1',
  payload: { key },
  idempotencyKey: key,
})

describe('audit', () => {
  it('records a mutation with before and after state', async () => {
    await withUnitOfWork(sql, STAFF, async (uow) => {
      await uow.audit.record({
        action: `f06.service.price_changed.${RUN}`,
        entityType: 'service',
        entityId: 'svc-1',
        operation: 'update',
        before: { grossFils: 20_000 },
        after: { grossFils: 25_000 },
      })
    })

    const [row] = await sql<
      { action: string; before_state: unknown; after_state: unknown; actor_label: string }[]
    >`select action, before_state, after_state, actor_label from audit_event where action = ${`f06.service.price_changed.${RUN}`}`

    expect(row?.before_state).toEqual({ grossFils: 20_000 })
    expect(row?.after_state).toEqual({ grossFils: 25_000 })
    expect(row?.actor_label).toBe('Reception')
  })

  it('records a read of sensitive data — the insider-threat control', async () => {
    await withUnitOfWork(sql, STAFF, async (uow) => {
      await uow.audit.recordSensitiveRead(
        'clinical_note',
        'note-1',
        `f06.clinical_note.read.${RUN}`,
      )
    })
    const [row] = await sql<{ operation: string }[]>`
      select operation from audit_event where action = ${`f06.clinical_note.read.${RUN}`}
    `
    expect(row?.operation).toBe('read')
  })

  it('records an export with its row count, so an unusually large one is detectable', async () => {
    await withUnitOfWork(sql, STAFF, async (uow) => {
      await uow.audit.recordExport('customer', 4213, `f06.customer.export.${RUN}`)
    })
    const [row] = await sql<{ operation: string; after_state: { rowCount: number } }[]>`
      select operation, after_state from audit_event where action = ${`f06.customer.export.${RUN}`}
    `
    expect(row?.operation).toBe('export')
    expect(row?.after_state.rowCount).toBe(4213)
  })

  it('rejects an un-namespaced action, so the trail stays queryable', async () => {
    await expect(
      withUnitOfWork(sql, STAFF, async (uow) => {
        await uow.audit.record({ action: 'didsomething', entityType: 'x', operation: 'update' })
      }),
    ).rejects.toThrow(/namespaced/)
  })
})

describe('transactional guarantee', () => {
  it('a rollback discards the audit row AND the event together', async () => {
    const key = `f06-rollback-${Date.now()}`
    await expect(
      withUnitOfWork(sql, STAFF, async (uow) => {
        await uow.audit.record({
          action: `f06.thing.created.${key}`,
          entityType: 'thing',
          operation: 'create',
          after: { id: 1 },
        })
        await uow.publish(event(key))
        throw new Error('deliberate failure after both writes')
      }),
    ).rejects.toThrow('deliberate failure')

    const [audit] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = ${`f06.thing.created.${key}`}
    `
    const [outbox] = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event where idempotency_key = ${key}
    `
    // Neither survives. An event for a change that rolled back is the bug this prevents.
    expect(audit?.n).toBe('0')
    expect(outbox?.n).toBe('0')
  })

  it('a commit persists both', async () => {
    const key = `f06-commit-${Date.now()}`
    await withUnitOfWork(sql, STAFF, async (uow) => {
      await uow.audit.record({
        action: 'f06.thing.created',
        entityType: 'thing',
        operation: 'create',
      })
      await uow.publish(event(key))
    })
    const [outbox] = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event where idempotency_key = ${key}
    `
    expect(outbox?.n).toBe('1')
  })
})

describe('publishEvent', () => {
  it('ignores a duplicate idempotency key rather than throwing', async () => {
    const key = `f06-dupe-${Date.now()}`
    const first = await publishEvent(sql, event(key))
    const second = await publishEvent(sql, event(key))
    expect(first).toBeTruthy()
    // Already recorded: not an error, just nothing new.
    expect(second).toBeNull()
  })

  it('rejects an un-namespaced event type', async () => {
    await expect(publishEvent(sql, { ...event('x'), eventType: 'happened' })).rejects.toThrow(
      /namespaced/,
    )
  })
})

describe('drainOutbox', () => {
  const collector = (
    name: string,
    seen: StoredEvent[],
    types: string[] = ['f06.thing.happened'],
  ): HandlerRegistration => ({
    name,
    eventTypes: types,
    handle: async (e) => {
      seen.push(e)
    },
  })

  it('delivers an event to each interested handler exactly once', async () => {
    const key = `f06-drain-${Date.now()}`
    await publishEvent(sql, event(key))

    const a: StoredEvent[] = []
    const b: StoredEvent[] = []
    const handlers = [collector(`f06-a-${key}`, a), collector(`f06-b-${key}`, b)]

    const first = await drainOutbox(sql, handlers)
    expect(first.delivered).toBe(2)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)

    // Draining again must not re-deliver: the event is published and the pairs are claimed.
    const second = await drainOutbox(sql, handlers)
    expect(second.delivered).toBe(0)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
  })

  it('does not deliver to a handler that is not interested in the event type', async () => {
    const key = `f06-filter-${Date.now()}`
    await publishEvent(sql, event(key))
    const seen: StoredEvent[] = []
    await drainOutbox(sql, [collector(`f06-other-${key}`, seen, ['f06.something.else'])])
    expect(seen).toHaveLength(0)
  })

  it('a wildcard handler receives every event type', async () => {
    const key = `f06-wild-${Date.now()}`
    await publishEvent(sql, event(key))
    const seen: StoredEvent[] = []
    await drainOutbox(sql, [collector(`f06-wild-h-${key}`, seen, ['*'])])
    expect(seen).toHaveLength(1)
  })

  it('a failing handler leaves the event unpublished for retry, and records the error', async () => {
    const key = `f06-fail-${Date.now()}`
    await publishEvent(sql, event(key))

    let attempts = 0
    const flaky: HandlerRegistration = {
      name: `f06-flaky-${key}`,
      eventTypes: ['f06.thing.happened'],
      handle: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('transient provider failure')
      },
    }

    const first = await drainOutbox(sql, [flaky])
    expect(first.failed).toBe(1)

    const [pending] = await sql<
      { published_at: Date | null; attempts: number; last_error: string }[]
    >`
      select published_at, attempts, last_error from outbox_event where idempotency_key = ${key}
    `
    expect(pending?.published_at).toBeNull()
    expect(pending?.attempts).toBe(1)
    expect(pending?.last_error).toContain('transient provider failure')

    // Second drain succeeds and publishes.
    const second = await drainOutbox(sql, [flaky])
    expect(second.delivered).toBe(1)
    const [done] = await sql<{ published_at: Date | null }[]>`
      select published_at from outbox_event where idempotency_key = ${key}
    `
    expect(done?.published_at).not.toBeNull()
  })

  it('one broken handler does not stop a healthy one from receiving the event', async () => {
    const key = `f06-mixed-${Date.now()}`
    await publishEvent(sql, event(key))
    const healthy: StoredEvent[] = []
    const result = await drainOutbox(sql, [
      {
        name: `f06-broken-${key}`,
        eventTypes: ['f06.thing.happened'],
        handle: async () => {
          throw new Error('broken')
        },
      },
      collector(`f06-healthy-${key}`, healthy),
    ])
    expect(healthy).toHaveLength(1)
    expect(result.failed).toBe(1)
    expect(result.delivered).toBe(1)
  })

  it('concurrent drains do not double-deliver — skip locked plus the delivery PK', async () => {
    const keys = Array.from({ length: 12 }, (_, i) => `f06-conc-${Date.now()}-${i}`)
    for (const k of keys) await publishEvent(sql, event(k))

    const seen: StoredEvent[] = []
    const handler = collector(`f06-conc-h-${Date.now()}`, seen)

    // Four workers racing on the same backlog.
    const results = await Promise.all([
      drainOutbox(sql, [handler], { batchSize: 12 }),
      drainOutbox(sql, [handler], { batchSize: 12 }),
      drainOutbox(sql, [handler], { batchSize: 12 }),
      drainOutbox(sql, [handler], { batchSize: 12 }),
    ])

    const totalDelivered = results.reduce((n, r) => n + r.delivered, 0)
    expect(totalDelivered).toBe(12)
    expect(seen).toHaveLength(12)
    expect(new Set(seen.map((e) => e.id)).size).toBe(12)
  })

  it('reports backlog depth and age for the watchdog', async () => {
    const key = `f06-backlog-${Date.now()}`
    await publishEvent(sql, event(key))
    const backlog = await outboxBacklog(sql)
    expect(backlog.pending).toBeGreaterThanOrEqual(1)
    expect(backlog.oldestAgeSeconds).toBeGreaterThanOrEqual(0)
  })
})
