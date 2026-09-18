import { type Actor, AuditWriter, type RequestContext } from './audit.ts'
import type { Sql } from './connection.ts'
import { type DomainEvent, publishEvent } from './outbox.ts'

/**
 * A unit of work: one transaction, one actor, an audit writer and an event publisher.
 *
 * Every mutation in the system runs inside one of these. The point is that the state change, its
 * audit row and its domain event share a transaction — so they are all durable together or none of
 * them are. Any two of the three committing without the third is a bug that is very hard to find
 * later, because the evidence of it is precisely the record that is missing.
 */
export interface UnitOfWork {
  readonly sql: Sql
  readonly audit: AuditWriter
  publish(event: DomainEvent): Promise<string | null>
}

export async function withUnitOfWork<T>(
  sql: Sql,
  actor: Actor,
  fn: (uow: UnitOfWork) => Promise<T>,
  context: RequestContext = {},
): Promise<T> {
  return sql.begin(async (tx) => {
    const uow: UnitOfWork = {
      sql: tx as unknown as Sql,
      audit: new AuditWriter(tx as unknown as Sql, actor, context),
      publish: (event) => publishEvent(tx as unknown as Sql, event),
    }
    return fn(uow)
  }) as Promise<T>
}
