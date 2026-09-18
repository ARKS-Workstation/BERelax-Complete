import { AppError } from '@berelax/shared'
import type { Sql } from './connection.ts'

/**
 * The transactional outbox.
 *
 * An event is written in the SAME transaction as the state change that caused it, so:
 *   - a booking cannot be confirmed without its confirmation event, and
 *   - an event cannot exist for a booking whose transaction rolled back.
 *
 * That property is the entire reason the queue lives in PostgreSQL rather than Redis
 * (docs/01 decision 4). Delivery is at-least-once; `outbox_delivery` turns that into
 * exactly-once *per handler* (migration 0007).
 */

export interface DomainEvent {
  readonly eventType: string
  readonly eventVersion?: number
  readonly aggregateType: string
  readonly aggregateId: string
  readonly payload: Readonly<Record<string, unknown>>
  /**
   * Deduplicates the event itself. Derive it from the business fact, not from a random value —
   * `booking.confirmed:${bookingId}` means a retry of the same operation cannot enqueue twice.
   */
  readonly idempotencyKey: string
}

export interface StoredEvent extends DomainEvent {
  readonly id: string
  readonly occurredAt: Date
}

export type EventHandler = (event: StoredEvent) => Promise<void>

export interface HandlerRegistration {
  /** Stable name. Changing it makes every past event undelivered for the new name, by design. */
  readonly name: string
  /** Event types this handler consumes. `'*'` receives everything. */
  readonly eventTypes: readonly string[]
  readonly handle: EventHandler
}

/**
 * Appends an event. MUST be called with a transaction handle that is also performing the state
 * change — passing a pooled connection defeats the entire pattern.
 */
export async function publishEvent(tx: Sql, event: DomainEvent): Promise<string | null> {
  if (!event.eventType.includes('.')) {
    throw new AppError(
      'validation',
      `Event type must be namespaced, e.g. "booking.confirmed", received "${event.eventType}"`,
    )
  }
  // A duplicate idempotency key is not an error: it means this business fact is already recorded.
  const rows = await tx<{ id: string }[]>`
    insert into outbox_event (event_type, event_version, aggregate_type, aggregate_id, payload, idempotency_key)
    values (
      ${event.eventType},
      ${event.eventVersion ?? 1},
      ${event.aggregateType},
      ${event.aggregateId},
      ${tx.json(event.payload as never)},
      ${event.idempotencyKey}
    )
    on conflict (idempotency_key) do nothing
    returning id
  `
  return rows[0]?.id ?? null
}

export interface DrainResult {
  readonly claimed: number
  readonly delivered: number
  readonly skippedAlreadyDelivered: number
  readonly failed: number
}

/**
 * Claims and dispatches a batch of unpublished events.
 *
 * `for update skip locked` lets several workers drain concurrently without either blocking on each
 * other or claiming the same row — which is what makes horizontal scaling safe without a broker.
 *
 * A handler that throws leaves the event unpublished so it is retried; its error is recorded against
 * that handler only, so one broken consumer cannot block the others.
 */
export async function drainOutbox(
  sql: Sql,
  handlers: readonly HandlerRegistration[],
  options: { readonly batchSize?: number } = {},
): Promise<DrainResult> {
  const batchSize = options.batchSize ?? 50
  let delivered = 0
  let skipped = 0
  let failed = 0
  let claimed = 0

  await sql.begin(async (tx) => {
    const events = await tx<
      {
        id: string
        occurred_at: Date
        event_type: string
        event_version: number
        aggregate_type: string
        aggregate_id: string
        payload: Record<string, unknown>
        idempotency_key: string
      }[]
    >`
      select id, occurred_at, event_type, event_version, aggregate_type, aggregate_id,
             payload, idempotency_key
      from outbox_event
      where published_at is null
      order by occurred_at
      limit ${batchSize}
      for update skip locked
    `
    claimed = events.length

    for (const row of events) {
      const event: StoredEvent = {
        id: row.id,
        occurredAt: row.occurred_at,
        eventType: row.event_type,
        eventVersion: row.event_version,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        idempotencyKey: row.idempotency_key,
      }

      const interested = handlers.filter(
        (h) => h.eventTypes.includes('*') || h.eventTypes.includes(event.eventType),
      )

      let allSucceeded = true

      for (const handler of interested) {
        // Claim the (event, handler) pair first. A PK conflict means another worker already
        // delivered it, so this attempt is skipped rather than duplicating the side effect.
        const claimRows = await tx<{ event_id: string }[]>`
          insert into outbox_delivery (event_id, handler)
          values (${event.id}, ${handler.name})
          on conflict (event_id, handler) do nothing
          returning event_id
        `
        if (claimRows.length === 0) {
          skipped += 1
          continue
        }

        try {
          await handler.handle(event)
          delivered += 1
        } catch (error) {
          allSucceeded = false
          failed += 1
          // Release the claim so the event is retried, and keep the reason.
          await tx`
            delete from outbox_delivery where event_id = ${event.id} and handler = ${handler.name}
          `
          await tx`
            update outbox_event
               set attempts = attempts + 1,
                   last_error = ${error instanceof Error ? error.message : String(error)}
             where id = ${event.id}
          `
        }
      }

      if (allSucceeded) {
        await tx`update outbox_event set published_at = now() where id = ${event.id}`
      }
    }
  })

  return { claimed, delivered, skippedAlreadyDelivered: skipped, failed }
}

/** Events awaiting publication. Feeds the agent-console heartbeat and the watchdog. */
export async function outboxBacklog(
  sql: Sql,
): Promise<{ pending: number; oldestAgeSeconds: number }> {
  const [row] = await sql<{ pending: string; oldest: string | null }[]>`
    select count(*)::text as pending,
           coalesce(extract(epoch from (now() - min(occurred_at)))::bigint, 0)::text as oldest
    from outbox_event
    where published_at is null
  `
  return { pending: Number(row?.pending ?? 0), oldestAgeSeconds: Number(row?.oldest ?? 0) }
}
