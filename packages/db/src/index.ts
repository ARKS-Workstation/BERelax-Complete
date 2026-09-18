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
  isBalanced,
  type TrialBalance,
  type TrialBalanceRow,
  trialBalanceAsAt,
  trialBalanceMovement,
} from './queries/trial-balance.ts'
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
  CUSTOMER_ORIGINS,
  type CustomerIdentityInput,
  type CustomerOrigin,
  type CustomerRecord,
  type EnsureCustomerResult,
  ensureCustomer,
  findCustomerByPhone,
  markPhoneVerified,
} from './repositories/customer.ts'
export {
  type AccountBalanceRow,
  accountTotals,
  isAppendOnlyViolation,
  isPeriodLocked,
  isUnbalancedEntry,
  JOURNAL_SQLSTATE,
  type JournalEntryInput,
  type JournalLineInput,
  journalError,
  listPeriodLocks,
  lockAccountingPeriod,
  type PeriodLockInput,
  type PeriodLockRow,
  type PostedJournalEntry,
  type PostedJournalLine,
  periodLockFor,
  postJournalEntry,
  readChartOfAccounts,
  readJournalEntry,
  type StoredAccount,
  type StoredChartOfAccounts,
  type StoredProvisionalMarker,
} from './repositories/journal.ts'
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
  generateOtpCode,
  hashOtpCode,
  issueOtpChallenge,
  OTP_CODE_DIGITS,
  OTP_IP_WINDOW_MINUTES,
  OTP_LOCK_MINUTES,
  OTP_MAX_FAILED_ATTEMPTS,
  OTP_MAX_REQUESTS_PER_IP,
  OTP_MAX_REQUESTS_PER_PHONE,
  OTP_PHONE_WINDOW_MINUTES,
  OTP_PURPOSES,
  OTP_RATE_LIMITS,
  OTP_TTL_MINUTES,
  OTP_VERIFY_REJECTIONS,
  type OtpIssueRequest,
  type OtpIssueResult,
  type OtpPurpose,
  type OtpRateLimit,
  type OtpVerifyRejection,
  type OtpVerifyRequest,
  type OtpVerifyResult,
  verifyOtpCode,
} from './repositories/otp.ts'
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
export {
  PROVISIONAL_OPENING_DATE,
  PROVISIONAL_OPENING_LINES,
  seedProvisionalOpeningBalances,
} from './seed/opening-balances.ts'
export {
  type ImportedOpeningBalances,
  importOpeningBalances,
  isBeforeOpeningBalance,
  OPENING_BALANCE_SQLSTATE,
  type OpeningBalanceImport,
  type OpeningBalanceLine,
  openingDate,
  openingImbalanceFils,
  provisionalOpeningBalances,
} from './services/opening-balances.ts'
export { type UnitOfWork, withUnitOfWork } from './tx.ts'

export const SCHEMA_VERSION = 27 as const
