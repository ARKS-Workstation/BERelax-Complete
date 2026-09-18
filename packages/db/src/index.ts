/**
 * @berelax/db — Drizzle schema, migrations and repositories.
 *
 * Hard constraints, enforced by `pnpm boundaries`:
 *   - may import @berelax/shared only
 *   - MUST NOT import @berelax/core (dependency direction is core <- db, never db -> core)
 */

export {
  type Actor,
  type ActorKind,
  type AuditOperation,
  type AuditRecord,
  AuditWriter,
  type RequestContext,
} from './audit.ts'
export {
  type ConnectionOptions,
  createConnection,
  REQUIRED_EXTENSIONS,
  type Sql,
} from './connection.ts'
export {
  createJobQueue,
  DEFAULT_QUEUE_OPTIONS,
  type JobQueueOptions,
  MAINTENANCE_JOBS,
  PGBOSS_SCHEMA,
} from './jobs/boss.ts'
export {
  type BusinessDayInput,
  businessDayFingerprint,
  type GenerationResult,
  generateBusinessDays,
  type WriteOptions,
} from './jobs/generate-business-days.ts'
export {
  type DomainEvent,
  type DrainResult,
  drainOutbox,
  type EventHandler,
  type HandlerRegistration,
  outboxBacklog,
  publishEvent,
  type StoredEvent,
} from './outbox.ts'
export {
  type AgentDefinitionRow,
  type AgentHeartbeatRow,
  type AgentOutcome,
  type AgentRunResult,
  type AlertToRaise,
  agentsWithHeartbeat,
  findAgent,
  openAlerts,
  type RunBody,
  type RunOptions,
  raiseAlert,
  recordHeartbeat,
  setEnabled,
  setKillSwitch,
  withAgentRun,
} from './repositories/agents.ts'
export {
  type AllocatedDocumentNumber,
  allocateDocumentNumber,
  DOCUMENT_SERIES_CODES,
  type DocumentSeriesCode,
  type DocumentSeriesRow,
  findNumberingGaps,
  listDocumentSeries,
  NUMBERING_LEDGER_COLUMNS,
  type NumberingGap,
} from './repositories/numbering.ts'
export {
  type ApiIngestOutcome,
  type ApiReviewPayload,
  getReview,
  type IngestedReview,
  ingestApiReview,
  listReviewQueue,
  type ManualReviewInput,
  type QueuedReview,
  type ReconciliationInput,
  type ReconciliationOutcome,
  reconcileApiReviewId,
  recordManualReview,
  recordReplyConfirmedByGoogle,
  recordReplyPostedManually,
  recordReplySubmittedToApi,
} from './repositories/reviews.ts'
export * as schema from './schema/index.ts'
export { type UnitOfWork, withUnitOfWork } from './tx.ts'

export const SCHEMA_VERSION = 21 as const
