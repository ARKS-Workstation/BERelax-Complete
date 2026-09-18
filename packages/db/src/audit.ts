import { AppError } from '@berelax/shared'
import type { Sql } from './connection.ts'

/**
 * The audit trail.
 *
 * Two things make this more than logging:
 *
 *   1. **Reads are recorded, not just writes.** The realistic breach for this business is an insider
 *      reading or exporting the client list, not an external attacker (docs/06 §D4). A trail that
 *      only records mutations cannot answer "who opened whose clinical notes".
 *   2. **It is append-only in the database**, via rules in migration 0005. Not by convention.
 *
 * Writes go through the same transaction as the change they describe, so an audited mutation and its
 * audit row commit or roll back together. An audit row for a change that did not happen is as bad as
 * a change with no audit row.
 */

export type ActorKind = 'staff' | 'customer' | 'system' | 'agent'

export type AuditOperation =
  | 'create'
  | 'update'
  | 'delete'
  | 'read'
  | 'export'
  | 'login'
  | 'logout'
  | 'denied'

export interface Actor {
  readonly kind: ActorKind
  readonly id?: string
  readonly label?: string
}

export interface RequestContext {
  readonly requestId?: string
  readonly ipAddress?: string
  readonly userAgent?: string
}

export interface AuditRecord {
  readonly action: string
  readonly entityType: string
  readonly entityId?: string
  readonly operation: AuditOperation
  readonly before?: unknown
  readonly after?: unknown
}

/** Operations that must always produce an audit row, regardless of caller diligence. */
const ALWAYS_AUDITED: ReadonlySet<AuditOperation> = new Set([
  'create',
  'update',
  'delete',
  'export',
  'denied',
])

export class AuditWriter {
  constructor(
    private readonly sql: Sql,
    private readonly actor: Actor,
    private readonly context: RequestContext = {},
  ) {}

  async record(entry: AuditRecord): Promise<void> {
    if (!entry.action.includes('.')) {
      throw new AppError(
        'validation',
        `Audit action must be namespaced, e.g. "booking.reschedule", received "${entry.action}"`,
      )
    }
    await this.sql`
      insert into audit_event (
        actor_kind, actor_id, actor_label, action, entity_type, entity_id, operation,
        before_state, after_state, request_id, ip_address, user_agent
      ) values (
        ${this.actor.kind},
        ${this.actor.id ?? null},
        ${this.actor.label ?? null},
        ${entry.action},
        ${entry.entityType},
        ${entry.entityId ?? null},
        ${entry.operation},
        ${entry.before === undefined ? null : this.sql.json(entry.before as never)},
        ${entry.after === undefined ? null : this.sql.json(entry.after as never)},
        ${this.context.requestId ?? null},
        ${this.context.ipAddress ?? null},
        ${this.context.userAgent ?? null}
      )
    `
  }

  /** Convenience for a read of sensitive data — clinical notes, salary, bank details. */
  async recordSensitiveRead(entityType: string, entityId: string, action: string): Promise<void> {
    await this.record({ action, entityType, entityId, operation: 'read' })
  }

  /**
   * An export is the insider-threat signal. Recorded with the row count so an unusually large
   * export is detectable, and separately indexed in migration 0005 so it is cheap to find.
   */
  async recordExport(entityType: string, rowCount: number, action: string): Promise<void> {
    await this.record({
      action,
      entityType,
      operation: 'export',
      after: { rowCount },
    })
  }

  static requiresAudit(operation: AuditOperation): boolean {
    return ALWAYS_AUDITED.has(operation)
  }
}
