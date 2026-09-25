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
  type BusinessDayAt,
  type BusinessDayInput,
  businessDayAt,
  businessDayFingerprint,
  type GenerationResult,
  generateBusinessDays,
  type WriteOptions,
} from './jobs/generate-business-days.ts'
export {
  assertParticipantIsWellFormed,
  MERGE_ALLOWLIST,
  MERGE_CATALOGUE_EXCLUDED_SCHEMAS,
  MERGE_ID_COLUMN_PATTERN,
  MERGE_PARTICIPANTS,
  MERGE_STRATEGIES,
  type MergeAllowlistEntry,
  type MergeCoverageRow,
  type MergeParticipant,
  type MergeStrategy,
  mergeCoverage,
  participantName,
  SQL_IDENTIFIER,
  SQL_PREDICATE,
} from './merge-participants.ts'
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
  type AlternativesOptions,
  type AlternativeTherapist,
  AVAILABILITY_OCCUPANCY_PAD_MINUTES,
  AVAILABILITY_REFUSALS,
  type AvailabilityAnswer,
  type AvailabilityBlockFacts,
  type AvailabilityCache,
  type AvailabilityCacheEntry,
  type AvailabilityDayHours,
  type AvailabilityDeps,
  type AvailabilityFacts,
  type AvailabilityRefusal,
  type AvailabilityRequest,
  type AvailabilityRoomFacts,
  type AvailabilityShapeFacts,
  type AvailabilityShiftFacts,
  type AvailabilitySlot,
  type AvailabilitySolve,
  type AvailabilitySolveInput,
  type AvailabilitySolveResult,
  type AvailabilityTherapistFacts,
  type AvailabilityVariantFacts,
  availabilityCacheTag,
  availabilityError,
  availabilityRefusalOf,
  createAvailabilityCache,
  DEFAULT_ALTERNATIVE_SEARCH_DAYS,
  DEFAULT_AVAILABILITY_TTL_MS,
  explainAvailabilityFacts,
  joinWaitlist,
  MAX_AVAILABILITY_TTL_MS,
  type NearestDay,
  type NoAvailabilityAnswer,
  noAvailabilityAlternatives,
  peekAvailabilityCache,
  queryAvailability,
  readAvailabilityEpochRow,
  readAvailabilityEpochs,
  readAvailabilityFacts,
  readWaitlistFor,
  WAITLIST_INELIGIBILITY,
  WAITLIST_WINDOW_CONSTRAINT,
  type WaitlistEligibility,
  type WaitlistIneligibility,
  type WaitlistJoinInput,
  type WaitlistJoinResult,
  type WaitlistRow,
} from './queries/availability.ts'
export {
  type BookableVariantRow,
  type BookedAppointmentRow,
  readBookableVariants,
  readBookingForCustomer,
  readOpenTradingDays,
  readPublishableTherapists,
  readTherapistLabels,
  type TherapistLabelRow,
  type TradingDayRow,
} from './queries/booking-page.ts'
export {
  readArchivedTreatmentSlugs,
  readTreatmentPages,
  type TreatmentPageRow,
} from './queries/catalogue-pages.ts'
export {
  type BlockedInputVatLine,
  blockedInputVatLines,
  disclosureFor,
  INPUT_VAT_NON_RECOVERY_REASONS,
  type InputVatAccountRow,
  type InputVatDisclosureRow,
  type InputVatNonRecoveryReason,
  type InputVatPeriod,
  type InputVatRecoveryWorkingPaper,
  inputVatRecovery,
} from './queries/input-vat-recovery.ts'
export {
  bucketTotalFils,
  type OutstandingPayable,
  outstandingPayables,
  overdueTotalFils,
  PAYABLES_AGING_BUCKETS,
  type PayablesAgingBucket,
  type PayablesAgingReport,
  type PayablesAgingRow,
  payablesAging,
} from './queries/payables-aging.ts'
export {
  type CataloguePriceRow,
  type HoursExceptionRow,
  type LegalNamesRow,
  type PremisesFacts,
  type PremisesFactsRow,
  type PriceOnRequestRow,
  readPremisesFacts,
  type TradingHoursRow,
} from './queries/premises-facts.ts'
export {
  type PublicReviewRow,
  type PublicTherapistRow,
  readPublicReviews,
  readPublicTherapists,
} from './queries/public-roster.ts'
export {
  type ForecastFilter,
  type ForecastPeriod,
  type ForecastRow,
  forecastPeriodTotalFils,
  type RecurringCostForecast,
  recurringCostForecast,
  recurringCostSchedule,
} from './queries/recurring-cost-forecast.ts'
export {
  REVERSE_CHARGE_EXCEPTION_KINDS,
  type ReverseChargeException,
  type ReverseChargeExceptionKind,
  type ReverseChargePeriod,
  reverseChargeExceptions,
} from './queries/reverse-charge-exceptions.ts'
export { doNotPairExclusion, therapistsExcludedBy } from './queries/therapist-exclusions.ts'
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
  type DecidedTransition,
  TRANSITION_REFUSALS,
  type TransitionActor,
  type TransitionDecider,
  type TransitionDecision,
  type TransitionDeps,
  type TransitionHistoryRow,
  type TransitionInput,
  type TransitionRefusal,
  type TransitionResult,
  transitionAppointment,
  transitionAppointmentTx,
  transitionRefusalOf,
} from './repositories/appointment-transition.ts'
export {
  attachBookingToSession,
  BOOKING_SESSION_TOKEN_BYTES,
  BOOKING_SESSION_TTL_MINUTES,
  type BookingSessionLookup,
  type BookingSessionRow,
  bookingSessionTokenMatches,
  endBookingSession,
  generateBookingSessionToken,
  hashBookingSessionToken,
  readBookingSession,
  type StartBookingSessionInput,
  type StartedBookingSession,
  startBookingSession,
  verifyBookingSession,
} from './repositories/booking-session.ts'
export {
  BOOKING_TOKEN_AUDIT_ACTIONS,
  BOOKING_TOKEN_WRITE_REFUSALS,
  type BookingTokenDecider,
  type BookingTokenWriteRefusal,
  bookingTokenDigest,
  bookingTokenWriteRefusalOf,
  type MintedBookingGrant,
  mintBookingManageGrant,
  type RedeemedBookingToken,
  readBookingManageGrant,
  redeemBookingManageToken,
  revokeBookingManageGrants,
  type StoredBookingGrantRow,
} from './repositories/booking-token.ts'
export {
  CANCELLATION_REFUSALS,
  CANCELLATION_STATUSES,
  type CancelAppointmentInput,
  type CancelBookingInput,
  type CancelBookingResult,
  type CancelDeps,
  type CancellationClassification,
  type CancellationPolicy,
  type CancellationRefusal,
  type CancellationStatus,
  type CancelledAppointment,
  cancelAppointment,
  cancelAppointmentTx,
  cancelBooking,
  cancelBookingTx,
  cancellationRefusalOf,
  type MarkNoShowInput,
  markNoShow,
  markNoShowTx,
  type NoShowClockCheck,
  type NoShowDeps,
  type NoShowResult,
} from './repositories/cancel.ts'
export {
  archiveService,
  assertPublicDisplayNameLinted,
  CATALOGUE_REFUSALS,
  CATALOGUE_SQLSTATE,
  type CatalogueRefusal,
  type CompliancePolicyRow,
  catalogueError,
  changeVariantPrice,
  deleteService,
  listBookableServices,
  type PathResolution,
  type PriceChange,
  type PriceChangeInput,
  type PublicDisplayNameLint,
  publishService,
  type RenameSlugResult,
  readCompliancePolicy,
  readService,
  refusalOf,
  renameServiceSlug,
  resolveServicePath,
  SERVICE_PATH_PREFIX,
  type ServiceSnapshot,
  type SetPublicDisplayNameInput,
  servicePath,
  setInternalName,
  setPublicDisplayName,
  TREATMENTS_INDEX_PATH,
} from './repositories/catalogue.ts'
export {
  CONSENT_AUDIT_ACTIONS,
  CONSENT_REFUSALS,
  CONSENT_SQLSTATE,
  type ConsentContactByPhone,
  type ConsentIntegrityBreach,
  type ConsentLogRead,
  type ConsentPurposeRecord,
  type ConsentRefusal,
  type ConsentRow,
  type ConsentWordingRecord,
  consentRefusalOf,
  consentStateCounts,
  consentWordingHash,
  consentWordingIntegrity,
  publishConsentWording,
  readConsentLog,
  readConsentLogs,
  readConsentPurposes,
  readConsentWording,
  readContactsByPhone,
  readCurrentConsentWording,
  recordConsent,
  withdrawConsent,
} from './repositories/consent.ts'
export {
  BOOKABLE_STATUSES,
  BOOKING_REFUSALS,
  BOOKING_SQLSTATE,
  type BookableStatus,
  type BookingDeliveryInput,
  type BookingPriceSnapshot,
  type BookingRefusal,
  bookingError,
  bookingRefusalOf,
  bookSlot,
  type CreateBookingDeps,
  type CreateBookingInput,
  type CreatedBooking,
  type CreatedBookingDelivery,
  createBooking,
  isIdempotencyRace,
  readBookingByIdempotencyKey,
  readBookingDeliveries,
  requestFingerprint,
  type SlotRecheck,
  type SlotRecheckInput,
  type SlotRecheckResult,
  type SlotRecheckRoom,
  type SlotRecheckShape,
} from './repositories/create-booking.ts'
export {
  CREDENTIAL_EXPIRING_SOON_SETTING_KEY,
  type CredentialPolicyRead,
  type CredentialSubjectRow,
  type EmployeeCredentialRow,
  PROVISIONAL_EXPIRING_SOON_DAYS,
  readCredentialPolicy,
  readCredentialSubjects,
  readEmployeeCredentials,
} from './repositories/credentials.ts'
export {
  addBlocklistEntry,
  addCustomerTag,
  applyCustomerLifecycleEvent,
  type BlocklistAddInput,
  type BlocklistAuthoriser,
  type BlocklistEntryRow,
  type BlocklistEvaluation,
  type BlocklistMatcher,
  type ClientRecordRead,
  type ContactKey,
  CRM_AUDIT_ACTIONS,
  CRM_AUDIT_COVERAGE,
  CRM_REFUSALS,
  CRM_TABLE_PATTERN,
  type CrmAuditCoverageRow,
  type CrmRefusal,
  type CustomerPreferenceInput,
  type CustomerPreferenceRecord,
  crmAuditCoverage,
  crmRefusalOf,
  evaluateBlocklist,
  type LifecycleDecider,
  type LifecycleResult,
  liftBlocklistEntry,
  liftDoNotPair,
  readActiveBlocklistEntries,
  readClientRecord,
  readCustomerPreferences,
  readCustomerTags,
  readDoNotPairFor,
  removeCustomerTag,
  setAcquisitionSource,
  setCustomerPreferences,
  setCustomerVip,
  setDoNotPair,
} from './repositories/crm.ts'
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
  DUPLICATE_CANDIDATE_LIMIT,
  DUPLICATE_CANDIDATE_REFUSALS,
  DUPLICATE_LABEL_SIMILARITY_FLOOR,
  DUPLICATE_PHONE_SIMILARITY_FLOOR,
  type DuplicateCandidateOptions,
  type DuplicateCandidateProbe,
  type DuplicateCandidateRefusal,
  type DuplicateCandidateRow,
  explainDuplicateCandidates,
  findDuplicateCandidates,
} from './repositories/duplicate-candidates.ts'
export {
  type EligibilityQueryInput,
  type EligibleTherapistRow,
  EXCLUSION_REASONS,
  type ExcludedTherapistRow,
  type ExclusionReason,
  exclusionReasonFrom,
  readCommittedAppointments,
  readEligibleTherapists,
  readMandatoryDocumentTypes,
  type ScheduledAppointmentRow,
  type SqlFragment,
  type TherapistExclusion,
  type TherapistPoolCtesQuery,
  type TherapistPoolRead,
  type TherapistShiftRow,
  therapistPoolCtes,
} from './repositories/eligibility.ts'
export {
  countEnrolmentsOnVersion,
  type EndEnrolmentInput,
  type EnrolInput,
  type Enrolment,
  endFlowEnrolment,
  enrolOnLiveVersion,
  FLOW_AUDIT_ACTIONS,
  FLOW_REFUSALS,
  FLOW_SQLSTATE,
  type FlowDefinitionRow,
  type FlowDefinitionValidator,
  type FlowDeps,
  type FlowRow,
  type FlowWriteRefusal,
  flowRefusalOf,
  type PinnedEnrolmentRead,
  type PublishedFlowVersion,
  type PublishFlowInput,
  publishFlowDefinition,
  readEnrolmentPinnedDefinition,
  readFlowByKey,
  readFlowDefinition,
  readLiveFlowVersion,
  setFlowActive,
} from './repositories/flow.ts'
export {
  type CustomerSnapshotInput,
  INVOICE_DOCUMENT_KINDS,
  INVOICE_SQLSTATE,
  type InvoiceDocumentKind,
  type InvoiceLineInput,
  type IssuedInvoice,
  type IssuedInvoiceLine,
  type IssueInvoiceInput,
  type IssuerSnapshotInput,
  invoiceError,
  isInvoiceAppendOnly,
  isInvoiceTotalsDisagreement,
  issueInvoice,
  type MandatoryInvoiceField,
  readInvoice,
  readInvoiceByDisplayNumber,
  Y11_VAT_INVOICE_FIELDS,
} from './repositories/invoice.ts'
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
  type AccruedMonthRow,
  type AccruingEmployeeRow,
  type LeaveAccrualInput,
  type LeaveBalanceRow,
  type LeaveEntitlementRuleRow,
  readAccruedMonths,
  readAccruingEmployees,
  readLeaveBalances,
  readLeaveEntitlementRules,
  readUnpaidLeaveDaysByMonth,
  type UnpaidLeaveDaysRow,
  type WrittenLeaveAccrual,
  writeLeaveAccruals,
} from './repositories/leave.ts'
export {
  type ImportedOpeningBalance,
  importLeaveOpeningBalances,
  type LeaveOpeningBalanceImport,
  type LeaveOpeningBalanceRow,
  readLeaveOpeningBalances,
} from './repositories/leave-opening-balance.ts'
export {
  applyMergeParticipant,
  assertParticipantKeyIsAUniqueIndex,
  type CustomerMergePlanInput,
  type CustomerMergeSubjectRead,
  MERGE_AUDIT_ACTIONS,
  MERGE_REFUSALS,
  MERGE_SQLSTATE,
  type MergeCustomersArgs,
  type MergeOutcome,
  type MergeRecordRead,
  type MergeRefusal,
  type MergeTableReport,
  mergeCustomers,
  mergeRefusalOf,
  mergeRowCounts,
  mergeSurvivorOf,
  readCustomerMergeSubject,
  readMergeRecordForLoser,
  readMergeTableReports,
} from './repositories/merge.ts'
export {
  type CostByTemplate,
  type CostByTradingDate,
  type CostWindow,
  countPromotionalMessagesSince,
  createPostgresMessageStore,
  type InboxEntry,
  type InboxFilter,
  type InboxReceipt,
  listMessageInbox,
  listMessageReceipts,
  type MessageAttemptOutcome,
  type MessageRow,
  type MessageToRecord,
  messageCostByTemplate,
  messageCostByTradingDate,
  type PostgresMessageStore,
  type ReceiptOutcome,
  type ReceiptToApply,
  readMessageRow,
} from './repositories/message.ts'
export {
  type ApprovalChange,
  type Reclassification,
  reclassifyTemplate,
  setTemplateApproval,
  TEMPLATE_REFUSALS,
  TEMPLATE_SQLSTATE,
  type TemplateRefusal,
  type TemplateSqlstate,
  templateRefusalOf,
} from './repositories/message-template.ts'
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
  OTP_RESEND_COOLDOWN_SECONDS,
  OTP_TTL_MINUTES,
  OTP_VERIFY_REJECTIONS,
  type OtpIssueRequest,
  type OtpIssueResult,
  type OtpPurpose,
  type OtpRateLimit,
  type OtpResendWindow,
  type OtpVerifyRejection,
  type OtpVerifyRequest,
  type OtpVerifyResult,
  readOtpResendWindow,
  verifyOtpCode,
} from './repositories/otp.ts'
export {
  type ClearedReassignmentFlag,
  clearReassignmentFlags,
  flagAppointmentsForReassignment,
  type ListCandidatesInput,
  type LiveReassignmentFlagRow,
  listReassignmentCandidates,
  type NoticeRuleVerdict,
  type NoticeTemplateRow,
  type RaisedReassignmentFlag,
  REASSIGNED_EVENT,
  REASSIGNMENT_NOTICE_EVENT,
  REASSIGNMENT_REFUSALS,
  REASSIGNMENT_RESOLVED_EVENT,
  type ReassignInput,
  type ReassignmentActor,
  type ReassignmentCandidateList,
  type ReassignmentCandidateRow,
  type ReassignmentCandidateRule,
  type ReassignmentDeps,
  type ReassignmentFlagInput,
  type ReassignmentNoticeRule,
  type ReassignmentQueueRow,
  type ReassignmentRefusal,
  type ReassignmentResult,
  type ReassignmentRuleAnswer,
  type ReassignmentRuleAppointment,
  type ReassignmentRuleInput,
  type ReassignmentRulePool,
  type ReassignmentTarget,
  type ReassignmentWindow,
  type ResolvedFlag,
  type ResolveFlagInput,
  readLiveReassignmentFlags,
  readReassignmentCandidates,
  readReassignmentQueue,
  reassignAppointment,
  reassignAppointmentTx,
  reassignmentError,
  reassignmentRefusalOf,
  resolveReassignmentFlag,
} from './repositories/reassignment.ts'
export {
  RESCHEDULE_REFUSALS,
  type RescheduleDeps,
  type RescheduledRow,
  type RescheduleInput,
  type RescheduleRefusal,
  type RescheduleResult,
  readScheduledStepKeys,
  rescheduleAppointment,
  rescheduleAppointmentTx,
  rescheduleRefusalOf,
  type ScheduledStepKeyReader,
  type ScheduledStepKeys,
  type TradingDateResolution,
  type TradingDateResolver,
  type TradingDayHours,
} from './repositories/reschedule.ts'
export {
  type ApiIngestOutcome,
  type ApiReviewPayload,
  type DraftWriteOutcome,
  getReview,
  type IngestedReview,
  ingestApiReview,
  listReviewQueue,
  listUndraftedReviews,
  type ManualReviewInput,
  type QuarantineWriteOutcome,
  type QueuedReview,
  type ReconciliationInput,
  type ReconciliationOutcome,
  type ReplyDraftInput,
  type ReviewRoutingVerdictInput,
  type RoutingWriteOutcome,
  reconcileApiReviewId,
  recordDraftQuarantine,
  recordManualReview,
  recordReplyConfirmedByGoogle,
  recordReplyDraft,
  recordReplyPostedManually,
  recordReplySubmittedToApi,
  recordRoutingVerdict,
} from './repositories/reviews.ts'
export {
  buildScheduledSteps,
  type ClaimedStep,
  claimScheduledStep,
  dueScheduledSteps,
  type PlannedStep,
  type RebuildResult,
  rebuildScheduledSteps,
  recordStepSent,
  recordStepSkipped,
  SCHEDULED_STEP_REFUSALS,
  type ScheduledStepMaintainer,
  type ScheduledStepMaintenance,
  type ScheduledStepPlanner,
  type ScheduledStepRefusal,
  scheduledStepMaintainer,
  scheduledStepRefusalOf,
  scheduledStepsFor,
  settleScheduledSteps,
} from './repositories/scheduled-step.ts'
export {
  countCandidatesMentioning,
  insertSuggestionCandidates,
  readSuggestionCandidates,
  SEO_CANDIDATE_CONSTRAINTS,
  type SuggestionCandidateInsert,
  type SuggestionCandidateRow,
  type SuggestionCandidateWrite,
} from './repositories/seo-candidates.ts'
export {
  type ClaimedInspection,
  claimUrlInspectionBatch,
  countGscDailyRows,
  GSC_BATCH_HAS_DUPLICATE_DIMENSIONS,
  GSC_UPSERT_LOST_ROWS,
  type GscDailyRow,
  type GscSnapshotInput,
  type GscSnapshotRow,
  type GscUpsertResult,
  type InspectionCandidate,
  type InspectionCoverage,
  type InspectionOutcome,
  type InspectionRunLedger,
  inspectionCoverage,
  openInspectionRun,
  readGscSnapshot,
  recordGscSnapshot,
  recordInspectionOutcomes,
  registerInspectionCandidates,
  upsertGscDailyRows,
} from './repositories/seo-warehouse.ts'
export {
  applyPreferenceCentreChange,
  type IssuedOptOutGrant,
  issueOptOutGrant,
  loadSuppressionPeppers,
  MIN_SUPPRESSION_PEPPER_LENGTH,
  OPTOUT_VERIFY_LIMITS,
  OPTOUT_VERIFY_MAX_PER_IP,
  OPTOUT_VERIFY_WINDOW_SECONDS,
  type OptOutDecider,
  type OptOutShapeChecker,
  type OptOutVerification,
  type OptOutVerifyLimit,
  type OptOutVerifyResult,
  optOutTokenDigest,
  type PlaintextLeak,
  PREFERENCE_CENTRE_ACTIONS,
  type PreferenceCentreAction,
  type PreferenceCentreChange,
  type PreferenceCentreResult,
  pruneOptOutVerificationAttempts,
  readSuppressionHistory,
  readSuppressionLogs,
  recordSuppression,
  revokeOptOutGrant,
  SUPPRESSION_AUDIT_ACTIONS,
  SUPPRESSION_REFUSALS,
  SUPPRESSION_SQLSTATE,
  SUPPRESSION_TABLES,
  type SuppressionInput,
  type SuppressionKeying,
  type SuppressionKeyNormaliser,
  type SuppressionLogRead,
  type SuppressionPepper,
  type SuppressionPepperEnv,
  type SuppressionPeppers,
  type SuppressionRefusal,
  type SuppressionRow,
  suppressionColumns,
  suppressionKey,
  suppressionPlaintextLeaks,
  suppressionRefusalOf,
  suppressionSourceCounts,
  unsuppressKey,
  verifyOptOutToken,
} from './repositories/suppression.ts'
export {
  type PublicHolidayClosureRow,
  type RosteredShiftRow,
  readPublicHolidayClosures,
  readRosteredShifts,
  readWorkingHoursRules,
  type WorkingHoursRuleRow,
} from './repositories/working-hours.ts'
export * as schema from './schema/index.ts'
export {
  type CatalogueSeedResult,
  PRICE_ON_REQUEST_SEED,
  seedCatalogue,
} from './seed/catalogue.ts'
export {
  CONSENT_SEED_STATES,
  CONSENT_WORDING_DRAFTS,
  CONSENT_WORDING_OPEN_QUESTION,
  CONSENT_WORDING_PROVISIONAL_NOTE,
  type ConsentSeedContact,
  type ConsentSeedInput,
  type ConsentSeedResult,
  type ConsentSeedState,
  type SeededWording,
  seedConsent,
  seedConsentWording,
} from './seed/consent.ts'
export {
  comparePriceCells,
  DOCS_13_PRICE_POINT_COUNT,
  DOCS_13_PRICES_AED,
  type Docs13PriceCell,
  docs13PriceCells,
  FILS_PER_AED,
  type PriceMismatch,
  type StoredPricePoint,
} from './seed/fixtures/prices-docs-13.ts'
export {
  PROVISIONAL_OPENING_DATE,
  PROVISIONAL_OPENING_LINES,
  seedProvisionalOpeningBalances,
} from './seed/opening-balances.ts'
export {
  AREA_ALIASES,
  areaAliasesFor,
  ensureLegalEntity,
  LEGAL_ENTITY_ID,
  LEGAL_ENTITY_SEED,
  PREMISES_ID,
  PREMISES_NAP,
  seedPremises,
  TRADING_CLOSE_TIME,
  TRADING_DAYS_OF_WEEK,
  TRADING_OPEN_TIME,
  WHATSAPP_CANDIDATES,
  WHATSAPP_PENDING,
} from './seed/premises.ts'
export {
  SUPPRESSION_SEED_STATES,
  type SuppressionSeedEntry,
  type SuppressionSeedInput,
  type SuppressionSeedResult,
  type SuppressionSeedState,
  seedSuppression,
} from './seed/suppression.ts'
export {
  type ResolvedTemplateRow,
  readCurrentTemplate,
  seedMessageTemplates,
  type TemplateSeedDefinition,
  type TemplateSeedResult,
} from './seed/templates.ts'
export {
  seedTherapistRoster,
  THERAPIST_HEADCOUNT,
  type TherapistRosterResult,
  therapistStaffReference,
  therapistStyleSkill,
} from './seed/therapists.ts'
export {
  AppointmentAlreadyBilled,
  CHECKOUT_CONSTRAINT,
  type CheckoutAppointmentInput,
  CheckoutAppointmentsNotOneBooking,
  type CheckoutTenderInput,
  checkoutError,
  type FinaliseCheckoutInput,
  type FinalisedCheckout,
  finaliseCheckout,
  IdempotencyKeyReused,
  isCheckoutAlreadyFinalised,
  type RecordedTender,
  readFinalisedCheckout,
  TenderPostingDisagrees,
} from './services/checkout-finalise.ts'
export {
  completeObligationInstance,
  fileObligationEvidence,
  generateObligationInstances,
  OBLIGATION_SQLSTATE,
  type ObligationDefinitionRow,
  type ObligationGenerationResult,
  type ObligationInstanceRow,
  OVERDUE_BLOCKING_OBLIGATION_EXCLUSION,
  OVERDUE_BLOCKING_OBLIGATION_REASON,
  overdueBlockingObligationExclusion,
  type PlannedObligationInstanceRow,
  readObligationDefinitions,
  readObligationInstances,
  readTradingHoursAround,
  rescheduleObligationInstance,
  setObligationAnchorDate,
  type TradingDateHoursRow,
} from './services/obligation.ts'
export {
  EVIDENCE_DOWNLOAD_REFUSALS,
  EVIDENCE_GRANT_TTL_SECONDS,
  type EvidenceDownloadRefusal,
  type IssuedEvidenceGrant,
  issueObligationEvidenceGrant,
  type RedeemedEvidence,
  readObligationEvidence,
  recordEvidenceDownload,
  redeemObligationEvidenceGrant,
  revokeObligationEvidenceGrant,
} from './services/obligation-evidence.ts'
export {
  acknowledgeObligationInstance,
  type ClaimedNotice,
  claimObligationNotice,
  dueObligationNotices,
  type NoticePlanMode,
  type NoticePlanResult,
  type NoticeStateCount,
  type NoticeSubjectRow,
  OBLIGATION_NOTICE_REFUSALS,
  OBLIGATION_NOTICE_SQLSTATE,
  type ObligationNoticeRefusal,
  obligationNoticeRefusalOf,
  obligationNoticeStateCounts,
  obligationNoticesFor,
  type PlannedObligationNoticeRow,
  planObligationNotices,
  readObligationAcknowledgements,
  readObligationNoticeSubjects,
  recordNoticeSent,
  recordNoticeSkipped,
  supersedePendingNotices,
} from './services/obligation-notice.ts'
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
export {
  BILL_SERIES_CODE,
  BILL_TAX_TREATMENTS,
  type BillLineToPost,
  type BillTaxTreatment,
  type BillToPost,
  findSupplierByCode,
  IMPORTED_SERVICES_TREATMENT,
  INPUT_VAT_RECOVERABILITIES,
  type InputVatRecoverability,
  isBlockedRecoverabilityRefusal,
  isDuplicateSupplierReference,
  isInputVatWithoutTrn,
  isReverseChargeRefusal,
  PLACE_OF_SUPPLY_RULES,
  type PlaceOfSupplyRule,
  type PostedBill,
  type PostedBillLine,
  PURCHASES_SQLSTATE,
  postBill,
  purchaseError,
  RECOVERABLE_INPUT_VAT_ACCOUNT_CODE,
  REVERSE_CHARGE_VAT_PAYABLE_ACCOUNT_CODE,
  readBill,
  recordSupplier,
  SUPPLIER_RESIDENCIES,
  type SupplierInput,
  type SupplierRecord,
  type SupplierResidency,
  TRADE_PAYABLES_ACCOUNT_CODE,
} from './services/post-bill.ts'
export {
  ACCOUNT_VAT_BOXES,
  type AccountClassification,
  type AccountVatBox,
  blockedInputVatAccountCodes,
  type ReclassifyAccountInput,
  readAccountClassification,
  reclassifyAccountRecoverability,
  recoverabilityOfPair,
} from './services/reclassify-account.ts'
export {
  findRecurringCostByCode,
  type GeneratedInstance,
  type GenerateWindow,
  generateRecurringInstances,
  isDuplicateRecurringCostMatch,
  type MatchInput,
  type MatchResult,
  matchBillToRecurringCost,
  type PeriodStatus,
  type PostedRecurringBill,
  postRecurringBill,
  type RaisedAlert,
  RECURRING_CADENCES,
  RECURRING_COST_ALERT_KINDS,
  RECURRING_COST_KINDS,
  RECURRING_COST_SQLSTATE,
  type RecurringBillToPost,
  type RecurringCadence,
  type RecurringCostAlertKind,
  type RecurringCostInput,
  type RecurringCostKind,
  type RecurringCostRecord,
  recordRecurringCost,
  recurringCostError,
  recurringCostPeriodStatus,
  sweepRecurringCostAlerts,
  tradingDateAt,
} from './services/recurring-cost.ts'
export {
  type AvailabilityLimits,
  GENDER_MATCHING_SETTING_KEY,
  MAX_ADVANCE_SETTING_KEY,
  MIN_LEAD_SETTING_KEY,
  readAvailabilityLimits,
  readGenderMatching,
  setGenderMatching,
} from './settings/availability.ts'
export {
  CANCELLATION_WINDOW_SETTING_KEY,
  readCancellationWindow,
} from './settings/cancellation.ts'
export {
  OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
  OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
  readObligationEscalationOffsets,
  readObligationReminderOffsets,
} from './settings/compliance.ts'
export {
  REMINDER_OFFSETS_SETTING_KEY,
  readReminderOffsets,
} from './settings/reminders.ts'
export {
  readSetting,
  // Exported for `packages/fixtures/src/load.ts`, which seeds the settings table before overriding three
  // of its values: every key in the registry is a row nothing else creates, and the two itests that
  // called this directly were the only reason any app_setting row existed on a fresh database.
  seedSettingDefaults,
  type UnconfirmedAssumptionRow,
  unconfirmedAssumptionRows,
  type WriteResult,
  writeSetting,
} from './settings-store.ts'
export { type UnitOfWork, withUnitOfWork } from './tx.ts'

// 41 is unused and will stay unused. W-SYS-06 reserved it, found it needed no schema change, and the
// number was not reclaimed: renumbering to close a gap is how two branches come to apply the same number
// to different SQL. 36 is 0036_setting_justification.sql, 37 is 0037_review_routing_verdict.sql, 38 is
// 0038_booking_transaction.sql — which corrects the unit `rooms.capacity` is counted in and adds the four
// figures an appointment snapshots — 39 is 0039_reverse_charge.sql, 40 is 0040_google_disconnect.sql,
// which makes the five refresh-token columns nullable so a disconnect can zeroise them and fences that
// nullability with three named CHECK constraints, 42 is 0042_seo_gsc_daily.sql, 43 is
// 0043_kek_rotation.sql, 44 and 45 are allocated to units in flight, and 46 is
// 0046_appointment_lifecycle.sql — which gives the transition chain its actor, F07 role and reason
// through the transaction-local settings 0036 introduced, because the trigger that writes the row cannot
// see a value that is not a column on `appointment`.
//
// 45 is 0045_waitlist.sql — `waitlist` with its UNIQUE NULLS NOT DISTINCT key, which is what makes a
// repeat join idempotent rather than a row per page refresh; `availability_epoch` with the four triggers
// that advance it (appointment, shift, resource_block and APPROVED leave_request); and
// `appointment_period_idx`, the GiST index the availability read runs through because 0024's leads with
// `room_id`. 47 is unused — W-SITE-05 holds it while that unit is in flight. 48 is 0048_review_draft.sql:
// the reply draft's provenance, the quarantine that is the absence of one, and the CHECK that makes
// "generation consumes a routing verdict" a fact the database holds rather than a call order.
//
// 49 is 0049_reschedule.sql: `appointment.rescheduled_from_id`, the successor's link to the row it
// replaced — partially UNIQUE, which is `repeat: 'refused'` on `rescheduled` expressed as an index — plus
// `late_cancellation` and the window figure it was judged against. The flag charges nothing: the
// cancellation window is provisional (Y9-windows), no fee policy is agreed and the business takes no card
// payments, so there is deliberately no fee column for a later reader to mistake for a capability.
//
// 50 is 0050_employee.sql: the employment record layered expand-only over 0030's therapist rows — the
// terms (contract type, wages in the `fils_nonneg` domain), the GENERATED `employee.is_publishable` that
// makes ADR 0020's publication guard a column nothing can write, `employee_language`,
// `employee_bank_detail` with one sealed payload per account, and `employee_document`'s sealed number.
//
// 51 is 0051_scheduled_step.sql: the reminder as a ROW carrying an `invalidation_key` derived from the
// appointment's current period, a partial unique index that allows exactly one PENDING step per
// (appointment, step type), a trigger making the exit from `pending` a one-way door, and two DEFERRED
// constraint triggers that refuse any transaction committing a pending step on an appointment which no
// longer holds its resources. There is deliberately no body, recipient or template column: all three are
// resolved at send time, because a body stored yesterday is a body about yesterday's period (B-MSG-03).
//
// 52 is 0052_obligation.sql: the compliance calendar (docs/04 §9). `obligation` with the seven seeded
// duties and their cadence, owner role, evidence requirement and unverified flag; `obligation_instance`,
// whose UNIQUE NULLS NOT DISTINCT key is what makes deterministic generation a constraint rather than a
// convention; and `obligation_evidence`, append-only. The blocking flag is GENERATED from
// `blocking_effect` and `refuse_obligation_shape_change()` refuses an UPDATE to anything but the due
// date, so there is nothing for a settings key to write — which is the unit's whole value. No seeded row
// carries a renewal date: the build has seen no licence, permit or certificate, and a plausible date
// would be indistinguishable from a configured one.
//
// 53 is 0053_crm_client_record.sql: the client record layered expand-only over 0019 — the CRM columns on
// `customer` (lifecycle state, acquisition source, the VIP flag fenced to its date by
// `customer_vip_since_matches_flag`), `customer_preference`, `customer_tag`, `customer_blocklist` keyed on
// a NORMALISED contact detail rather than on a customer id, and `customer_therapist_do_not_pair`. The two
// vocabularies are TABLES and not enums because every label in them is provisional (Y9-crm-lifecycle,
// Y9-crm-source) and an enum label cannot carry `is_provisional`, an OPEN-QUESTIONS id or a note; they are
// audited by a trigger rather than by a repository because they have no repository. Removing a blocklist
// entry or a do-not-pair flag is a LIFT and `delete` is revoked on both: the record of who blocked
// somebody and who unblocked them is the only evidence either happened.
//
// 54 is 0054_hr_credentials.sql: the credential registry. Eight labels added to `employee_document_type`
// — the four of docs/01 decision 20's stricter healthcare reading the enum could not previously spell,
// plus the two insurance records and the Emiratisation record of docs/04 §7, which are document types in
// this registry rather than three more tables — `employee_document.issuing_authority`,
// `regulatory_profile.non_expiring_document_types`, and `expires_on` made nullable with 0030's
// guarantee carried by the `employee_document_expiry_is_declared` trigger (ZS006) instead of by the
// NOT NULL. The mandatory-set DEFAULT is revised to decision 20's six; the row in force is deliberately
// left as 0030 wrote it, and that migration's header says why.
//
// 55 is 0055_duplicate_candidates.sql: two GiST trigram indexes on `customer` and nothing else — no
// table, no column and deliberately no foreign key, since a new FK to `customer` or `appointment` makes
// PostgreSQL refuse a TRUNCATE that does not name the referencing table and four integration suites
// truncate `appointment`. GiST and not GIN, measured rather than assumed: on the 5,000-row probe the
// planner costs GIN at ~583 against GiST at ~8 for an eleven-trigram probe, because `gincostestimate`
// charges a large startup an index this size never earns back — and GiST is a third of the size. An
// index the planner will not use at the size the table actually is is not an index.
// `customer_phone_match_key_trgm_idx` finds the MISTYPED neighbours of a number (one digit wrong, two
// transposed, one dropped); the btree beside it answers exact equality, which normalisation has already
// collapsed. `customer_name_fold_trgm_idx` is on `split_part(name_match_key, ':', 1)` — the folded name
// without its last-4 tail — because the folding itself cannot happen in SQL: `unaccent` is STABLE so it
// cannot appear in an index expression, and it folds no Arabic orthography in any case, which is half
// this customer base. `split_part` is IMMUTABLE, which is what makes the expression indexable, and
// dropping the tail stops the phone signal being counted a second time as a name signal. The review
// queue and the merge that act on the scores are C-CRM-05's, so this migration writes nothing a later
// unit would have to migrate.
//
// 56 is 0056_consent.sql: consent per (contact, channel, purpose, instant) carrying the exact wording
// version shown, both append-only. `consent_purpose` is the vocabulary TABLE (Y9-consent-purpose, four
// labels, every one provisional) and `is_send_gating` on it is what stops a photography grant reading as
// permission to text somebody. `consent_wording.content_hash` is GENERATED from the EN and AR text
// through `consent_wording_hash()`, so a wording row cannot lie about its own hash; the consent row
// SNAPSHOTS that hash and `assert_consent_wording_hash()` (ZP002) refuses an insert that disagrees, which
// is the only way an edit to a published statement is detectable at all. A withdrawal is a NEW row and so
// is a correction — UPDATE and DELETE raise for every role (ZP001, ZP003). `contact_customer_id` is a
// plain uuid with NO foreign key, the choice 0005, 0016 and 0024 make: a cascade would fire the refusal
// trigger and make `delete from customer` impossible, and this record has to outlive the erasure of the
// identity it is about (docs/04 §4, §8). `kind` is in `consent_one_record_per_instant` deliberately, so a
// withdrawal recorded at the same instant as a grant is stored rather than discarded as a duplicate — the
// log is then ambiguous and `resolveConsent` fails closed to `unknown`.
//
// 57 is 0057_seo_target_allowlist.sql: the SEO agent's propose-only surface (G-SEO-02).
// `seo_suggestion_candidate` is the one table the `system:seo_agent` principal may write to, and its two
// CHECK constraints are the database half of the target allowlist — `target_kind` against the seven
// allowlisted copy surfaces, and `target_ref` against `seo_target_ref_is_denied()`, which refuses a locator
// naming robots.txt, an X-Robots-Tag, a canonical, a noindex, a redirect or the sitemap even under an
// allowlisted kind. The function is IMMUTABLE because a CHECK may only call one, and NOT STRICT for 0026's
// reason: a strict function returns NULL for NULL and a CHECK whose expression is NULL passes. The claim
// filter from `regulatory_profile.banned_claim_terms` deliberately has NO counterpart here — it is
// `containsPhrase` over `lexiconTokens`, and a SQL re-implementation would be the second, slightly different
// reading of one lexicon that `lexicon.ts` exists to prevent — so it is enforced at the ingest boundary in
// code and proved over the rows this table holds. No foreign key to `agent_run`: same decision as
// `agent_run.job_id` in 0021, because three integration suites delete from that table and a candidate must
// outlive the run that produced it.
//
// 58 is 0058_appointment_reassignment_flag.sql: `appointment_reassignment_flag` plus the reconciliation
// 0054 deferred. The flag says "this appointment's therapist may no longer take it" WITHOUT touching
// `appointment.status`, because `holds_resources` is GENERATED from the status (0024) so any new
// terminal label would release the therapist and the room and hand the slot away mid-decision — and
// because `cancelled_by_salon` tells a customer their booking is gone when the intention is to keep it.
// One LIVE row per appointment is a PARTIAL unique index, which is what makes the nightly sweep
// idempotent in the database rather than in the job's memory (0031's argument for
// `recurring_cost_alert_once_per_period_and_kind`), and partial so a credential that lapses again after
// a renewal can raise a second flag while the first stays on file. `appointment_id` deliberately
// references nothing: PostgreSQL refuses `truncate appointment` while a referencing table is absent from
// the statement and three files truncate it by an explicit list, which is 0055's decision, 0021's for
// `agent_run.job_id` and 0024's for `appointment.therapist_id`. The reconciliation supersedes
// `regulatory_profile` and inserts a version naming ONLY `source_note` — character for character what
// 0004's own seed did — so every column takes its DEFAULT and "the seeded profile" and "every column at
// its DEFAULT" become one sentence. The row in force therefore now carries decision 20's six mandatory
// credentials that 0054 put in the DEFAULT and deliberately left the row without; the integration files
// that made a therapist bookable with a hard-coded pair read the set in force instead.
//
// 59 is 0059_hr_shift.sql: the working-hours rate table, and nothing else. `working_hours_rule` holds one
// row per VERSION of the rules — ordinary minutes per day and per week, the day a working week starts on,
// the daily overtime cap, the minimum rest gap, the night window as two wall-clock times and the four
// bucket multipliers in basis points — keyed on the first TRADING date the version governs, and the version
// that applies to a date is the latest row at or before it. Versioned and not an `app_setting`, which is
// the decision this file is the right place to record: a setting has one current value and payroll is asked
// about the past, so recomputing March in April would use April's rates and every figure would look
// plausible. `ordinary_multiplier_bp` is pinned to 10000 by a CHECK and stored anyway, so the pure splitter
// in `packages/core/src/hr/working-hours.ts` reads every multiplier from the table and holds no rate
// literal of its own; `working_hours_rule_uplifts_are_not_reductions` is what keeps "each minute is counted
// once, in the dearest applicable bucket" a partition rather than a mis-sort. `effective_from` is
// deliberately NOT a foreign key into `business_day` — a labour rule commences on a calendar date whether
// or not the premises trades that day. It creates NO table and adds NO column for shifts: 0030's `shift`
// and `shift_assignment` already carry the `tstzrange` period and the `trading_date` foreign key, and this
// migration deliberately adds no constraint tying the period to the day's window, because 0030 says why and
// `resolveTradingDate` in `@berelax/core` is the one reading of where a trading day ends. Version 1 is
// seeded from the sentinel date 1900-01-01 — visibly before any trading this business could have done,
// because every other candidate would be a claim about when the figures took effect — with every figure
// flagged provisional against Y9-overtime and listed by the Unconfirmed Assumptions panel.
//
// 58, 60 and 61 landed alongside this one and are described below; nothing is held any more.
//
// 60 is 0060_obligation_notice.sql: the compliance calendar's notices (M-VAT-11, docs/04 §9).
// `obligation_notice` is 0051's mechanism restated rather than a second one — a reminder about a deadline
// that has moved is the same bug as a reminder about an appointment that has moved, so the schedule is a
// ROW carrying an `invalidation_key` derived from the occurrence's CURRENT due date, `pending` is the only
// non-terminal state and leaving it is a one-way door, and every terminal state carries `settled_at`. Two
// things differ and both are deliberate: `notify_on` is a `date`, because an obligation falls due at the
// end of a day and the trading date is the unit of comparison; and there are TWO partial unique indexes
// rather than one, because the acceptance asks for at most one SENT notice per (occurrence, step) for ever
// and not merely one live one — which is the "(instance, step) idempotency key" M-VAT-10's NOTE deferred.
// `to_role` is NOT NULL and `assert_obligation_notice_names_an_accountable_role()` (ZN001) refuses a
// reminder addressed to anybody but the declared owner and an escalation addressed to the SAME role,
// because an escalation nobody new is accountable for is decoration. Acknowledgement is three columns on
// `obligation_instance` and not a state on the notice: it is a fact about the duty, and recorded against a
// notice it would stop only that rung. `obligation_evidence_grant` is the private-serving capability
// M-TILL-12's NOTE asked whichever unit landed first to own — a stored, expiring, revocable grant whose
// sha256 alone is kept, rather than an HMAC over a URL, so no fourth signing secret enters the rotation
// inventory for a link that lives fifteen minutes.
//
// 61 is 0061_template_approval_and_sender_identity.sql: no table and no column — four rules over tables
// 0014, 0015 and 0035 already shipped. `refuse_message_class_change` keeps 0014's words and gains a
// PRIVATE SQLSTATE (ZM001) so a probe can assert it was THAT rule that fired rather than any of the seven
// other `restrict_violation`s in this schema. `template_approval_transition_allowed` declares the seven
// edges of the approval state machine and `refuse_template_variant_change` enforces them (ZM002) plus a
// freeze on an APPROVED variant's words, channel, locale and care-window flag (ZM003) — the two together
// mean the only way to change approved words is approved -> draft -> pending -> approved, every step of
// it visible, which is the same defect as an editable `message_class` wearing different clothes.
// `reclassify_template` is replaced rather than re-created: the carried-over variants now land in
// `draft` and not `pending` (promotional words are not transactional words relabelled, and `pending`
// puts unwritten copy in front of a reviewer whose only question is yes or no), and it writes a
// `message_template.reclassified` audit_event naming the transaction-local actor. On `message`, two
// CHECKs make the sender identity a fact the database keeps — `sender_id` is present for sms and absent
// for everything else, and a promotional SMS carries the `AD-` prefix while a transactional one does not
// — and `message_class_matches_its_template` (ZM004) holds the class copied onto the row to the class of
// the template version it points at, checked at INSERT and on an UPDATE of either column rather than
// continuously, because a reclassification makes a NEW version the existing rows do not follow.
//
// 62 is 0062_booking_session.sql: the public booking flow's session (B-UI-02), which is the thing
// B-LIFE-02 stopped at and named — *"a successful verification has to mint a customer session or
// magic-link token and nothing in the system defines one yet"*. One table, no enum and no trigger.
// The token is 32 CSPRNG bytes in a cookie and the row holds their SHA-256; there is no column holding
// the token, exactly as `otp_challenge` holds no code. The one deliberate difference from 0019 is the
// hash: SHA-256 rather than an HMAC under a per-row salt, because a 256-bit random token has nothing to
// guess and the lookup has to be BY hash, which a per-row salt makes a full scan. `customer_id` and
// `booking_id` are plain uuids with NO foreign key — 0056's reason (a record outlives the erasure of the
// identity it is about, and a cascade makes `delete from customer` raise for every caller) plus
// B-MSG-03's TRUNCATE finding, since a key from here would break the four suites that truncate
// `appointment` and the four that clear `customer`. Three CHECKs carry the rules that matter:
// `verified_at` and `customer_id` are null together or set together, because `verified_at is not null`
// reads as "verified" everywhere and a row with no customer would pass that test and book for nobody;
// `booking_id` may only be set on a verified row; and `expires_at > created_at`, which is also what makes
// ending a session an UPDATE rather than a DELETE — `readBookingSession` distinguishes `expired` from
// `unknown`, and a delete would collapse the enumerated edge state into a first arrival. No sweep job:
// the retention pass docs/04 §8 asks for is one pass over every table holding a personal identifier, and
// a private sweep for this one would be the first of fourteen. `booking_session_expires_at_idx` is the
// index it will use.
// 63 is 0063_checkout.sql: checkout finalisation (M-TILL-06). Three tables and one column, and every one
// of them exists so that a till sale is one fact rather than five that usually arrive together.
// `checkout_finalisation`'s PRIMARY KEY is on an idempotency key the CALLER supplies — a key generated
// here could not deduplicate a retry, because the retry would generate a second one — and it is where two
// concurrent finalisations SERIALISE: the second INSERT blocks on the index until the first commits (then
// `checkout_finalisation_key_pk` refuses it, by name, which is what the test asserts) or rolls back (then
// the retry gets a fresh attempt). `booking_idempotency`'s mechanism (0024) applied to the till, and
// `request_fingerprint` is 0024's second column for 0024's reason: a replay with a DIFFERENT basket is a
// caller bug, and answering it with the first invoice looks exactly like success. The claim is written
// INSIDE the checkout's transaction, which is also what keeps the statutory range gap-free — the loser's
// rollback returns its number to the counter (M-TILL-03) — and it is written BEFORE the appointment link
// on purpose, so a retry trips the KEY and a genuinely different checkout billing an already-billed
// treatment trips `invoice_appointment_appointment_once`; the other order answers a retry with "already
// billed" and shows an error for a sale that went through. `invoice_appointment` is the wiring
// M-TILL-04's NOTE deferred, as a table rather than a column on `invoice_line` because the constraint
// that matters is UNIQUE on the APPOINTMENT and a column there would claim every invoice line is one;
// `appointment_id`, `booking_id` and `customer_id` carry NO foreign key, which is 0055's decision, 0058's
// and 0024's — PostgreSQL refuses `truncate appointment` while a referencing table is absent from the
// statement and four suites truncate it, and `booking` with it, by an explicit list. `payment` is created
// here because this unit's first acceptance line names it (an aborted finalisation must leave zero rows in
// it) and is deliberately minimal: M-TILL-07 owns the tender-type registry that replaces
// `payment_tender_kind_known` with a foreign key, plus refunds, over-tender change and the gateway
// adapter, and it EXTENDS this table rather than adding a second one beside it, because two tables
// recording money received is two answers to "what has this invoice been paid". `posting_account_code` is
// snapshotted from `TENDER_ACCOUNT` in `@berelax/core` for the reason every money column here is
// snapshotted: re-mapping `card_in_salon` from 1040 to 1020 must not restate a posting already filed —
// and 1040 rather than 1020 in the first place because the terminal settles in a batch, net of fees, days
// later. `invoice.booking_id` is the other half of the deferred wiring and the column the `invoice.issued`
// payload reads its booking id from, because an id carried on an event and stored nowhere is a fact with
// no record; `finaliseCheckout` DERIVES it from the appointments it is billing, so it cannot disagree with
// `invoice_appointment`. There is deliberately no `billed` appointment status: `holds_resources` is
// GENERATED from that enum (0024), so a tenth label would change what holds a room, and "billed" is
// therefore the link row existing rather than a second column that could contradict it. The three tables
// get INSERT and SELECT and no UPDATE or DELETE, and no refusal TRIGGER — 0018's distinction for `account`
// and `period_lock`: the history is the invoice and the journal entry, these are records ABOUT it, and
// dropping a trigger to fix a typed reference is how the trigger ends up dropped.
//
// 64 is 0064_suppression.sql: the suppression list and the opt-out grant (C-CRM-04). `suppression` keys on
// HMAC-SHA256 of the NORMALISED recipient under a server-side pepper (`SUPPRESSION_PEPPER`), lower-case
// hex, and `suppression_key_is_hmac_hex` is what makes "no plaintext" a fact rather than a promise: a
// normalised E.164 is at most 16 characters and an address contains an `@`, so the 64-hex CHECK refuses
// every recipient by length and by alphabet. A plain digest would not have done — the UAE mobile space is
// about ten million numbers per prefix, so an unpeppered hash of one is a phone number with extra steps —
// and `pepper_version` holds the LABEL and never the pepper, exactly as `google_connection.refresh_token_kid`
// does for a KEK, so a rotation is an operation rather than a data loss. The KEY is the hashed contact
// DETAIL and NOT a contact id, which is 0053's decision for `customer_blocklist` and the answer to what
// C-CRM-03's NOTE (4) asked this unit to settle: it is a DIFFERENT answer from `consent`'s rather than the
// same one, because a suppression names a detail and both details survive a merge with their suppressions
// attached — so C-CRM-05 re-points nothing here, and the only thing a merge owes this table is a
// `contact_customer_id` back-reference, which is an INSERT because the table refuses UPDATE (ZQ001) for
// every role including the owner. A suppression list is deliberately not a second blocklist: 0053's is "we
// will not SERVE this person" at the booking path, this one is "we will not MARKET to this person" at
// `evaluateGate`'s `isSuppressed` and nowhere else, and collapsing them would make an unsubscribe refuse
// appointments for ever. `suppression_source` and `suppression_kind` are Postgres ENUMS where
// `consent_purpose` is a table, and the contrast is the rule rather than an inconsistency: those labels are
// this build's guess at a business vocabulary and need `is_provisional`, while these five name mechanisms
// that already exist. `optout_grant` is `obligation_evidence_grant` restated — a stored, expiring,
// revocable grant whose sha256 alone is kept rather than an HMAC over a URL, so no second signing secret
// enters the rotation inventory — with one deliberate difference of two orders of magnitude: thirty days
// rather than fifteen minutes, because the person who needs this link is reading a message they were sent
// three weeks ago and a link that has expired by then is an opt-out this business does not have.
// `optout_verification_attempt` IS the rate limit (ten per address per minute, counted in SQL because a
// per-process counter is the limit multiplied by however many containers are running), and its
// `request_ip` is NOT NULL where `otp_challenge`'s is nullable: the OTP endpoint has a per-number limit
// that still binds without an address and this one has a single dimension, so the route refuses an
// unattributable request by name rather than recording one it cannot count.
//
//
// 65 is 0065_appointment_reassignment.sql: the reassignment as a RECORDED change, and the three ways a
// flag leaves the queue (P-HR-04). Two tables learn one thing each and neither of them is
// `appointment`: a reassignment writes `appointment.therapist_id` and nothing else, which is what makes
// "the customer's booking survives, only the therapist changes" a claim about one column.
// `appointment_status_history` gains `from_therapist_id` / `to_therapist_id`, because the acceptance
// asks for a history row carrying the actor and a reason from a closed set and the two ways of forcing
// one in without a column are both worse: `from_status = to_status` is refused by
// `appointment_status_history_is_a_change` (rightly — a row recording no change is a chain reading as
// activity where none occurred), and a NULL `from_status` is the shape 0024 gives a CREATION, so
// borrowing it would make "when was this booking taken" unanswerable for every reassigned appointment.
// `is_a_change` therefore keeps its NAME and widens to "the status moved, or the therapist did", so the
// self-transition control that asserts on that name still fails. `record_appointment_status()` gains a
// third branch AND its trigger gains a column — 0024 declared it `after insert or update OF STATUS`, so
// the branch alone would have been correct code that was never called, and the only symptom would have
// been a reassignment with no history row. The branch is an `elsif`: an UPDATE moving the status and the
// therapist at once would otherwise append two rows, and `transitionAppointment` refuses a transition
// that appended anything but exactly one. On `appointment_reassignment_flag`, `cleared_reason` is NOT
// NULL exactly when `cleared_at` is, which is the database half of "a flagged appointment cannot leave
// the queue except by reassignment or an audited explicit resolution": there is no fourth exit, DELETE
// stays revoked, and an UPDATE that stamped `cleared_at` without naming which exit it was is refused by
// a constraint rather than by review. `resolved_by_hand` carries a mandatory note because it is the one
// exit with no external fact behind it, and `reassigned_to_therapist_id` is the mirror of the
// `therapist_id` 0058 copies — after one reassignment the join no longer answers who it was taken from,
// and after a second it no longer answers who took it. Every pair test is spelled
// `is not distinct from` rather than `=`, because a live flag's `cleared_reason` is NULL and
// `null = 'reassigned'` is NULL, which a CHECK passes: the obvious operator would let a LIVE flag carry
// a successor and a resolution note.
//
// 66 is 0066_hr_leave.sql: leave entitlement, and the ledger a leave balance is the sum of (P-HR-08).
// `leave_entitlement_rule` is `working_hours_rule`'s shape one subject along — one row per VERSION, keyed
// on the first date it governs, because leave is asked about the PAST and a disputed month recomputed
// after a policy change must use the policy that applied then. Every quantity is integer day-hundredths
// (250 is 2.5 days) and `leave_entitlement_rule_annual_total_matches_monthly_accrual` holds the headline
// entitlement to twelve times the monthly figure, so a version whose contract number disagrees with its
// ledger number is not a storable row. `leave_movement` is the ledger, append-only with UPDATE and DELETE
// raising ZH001 for every role, and `leave_balance` is a VIEW summing it — there is NO stored balance
// column, which is the decision this file is the right place to record: a leave balance is the figure in
// an HR system most often corrected retrospectively, and a stored one disagrees with the movements the
// first time a month is re-accrued or a holiday withdrawn. `leave_movement_one_accrual_per_month` (a
// partial unique index on `(employee_id, accrual_month)`) IS the accrual job's idempotency guarantee
// rather than a check on it, and there is deliberately no `taken` movement kind: a request RESERVES when
// it is made, approval only makes the reservation final, so an approval moves no balance and writes no
// row. It creates NO table for leave requests: 0030's `leave_request` already carries the tstzrange
// period, and the one decision 0030 left open — whether a leave day is aligned to the trading day or the
// calendar day — is taken in `leaveCoveragePeriod()` in `@berelax/core` rather than in SQL, so a leave day
// covers its session's 00:00-02:00 tail and `resolveTradingDate` stays the one reading of where a trading
// day ends. Version 1 is seeded from the sentinel 1900-01-01 with every figure provisional against
// Y9-leave-detail; carry-over expiry is seeded FALSE, which is where the two recorded provisional answers
// conflict, and 0066's header states the conflict and why not-expiring is the direction whose error is
// visible.
//
// 67 is 0067_booking_manage_grant.sql: the magic link a reminder carries, as a stored capability
// (B-UI-05). The third table of the shape `booking_session` (0062) and `optout_grant` (0064) already
// established — 32 CSPRNG bytes handed out once, only their sha256 stored, expiry on the row, revocation
// by DELETE — and nothing about that shape is re-argued here. Two things ARE this table's own. Its
// `expires_at` is computed from the APPOINTMENT rather than from the issue: 24 hours after the treatment
// ends, because a fixed TTL long enough for a booking taken six weeks out would be a credential valid for
// six weeks, and one short enough to be safe would be dead before the customer read the reminder. And
// `booking_id` is a plain uuid with NO foreign key, and it is worth recording that it was a real
// `ON DELETE CASCADE` key first: a grant is a live capability rather than a record, so a cascade is the
// right semantics, and the argument rested on the claim that no suite truncates `booking`. Four do —
// `booking-constraints.itest.ts` (three sites), `catalogue.itest.ts`, `catalogue-compliance.itest.ts` and
// `repositories/catalogue.itest.ts` — and the key turned all 24 of the first file's cases red in a file
// this unit never touched. That is B-MSG-03's `scheduled_step` finding a second time, from the other
// table, and the answer here is the one `invoice.booking_id` and `checkout_idempotency` already wrote
// down rather than B-MSG-03's: no key, because four call sites in four other units' files is the wrong
// side of the trade for one column. The cost is stated in 0067's header — a deleted booking leaves a dead
// grant row, which grants nothing because the page answers the same 404 when the booking is absent.
// The token is 64 lower-case HEX characters and not
// 0064's 43-character base64url, and that is the one decision a reader is most likely to think is
// carelessness: the token is a PATH segment (`/booking/[token]`), `apps/web/src/routes/canonical.ts`
// lower-cases every path and 301s to the result, so a mixed-case token would be destroyed by the site's
// own canonicalisation — for every customer, every time, with a 404 whose cause is two modules away.
// UPDATE is revoked as well as TRUNCATE, because a different expiry or a different booking is a
// different grant and an UPDATE would move a live link onto somebody else's booking in one statement.
//
// 68 is 0068_payment_tender.sql: payments and refunds (M-TILL-07). It creates no second table for money
// received, which is the decision 0063 recorded for it — "two tables recording money received is two
// answers to what has this invoice been paid" — so `payment` is EXTENDED instead. `tender_type` is the
// registry 0063's `payment_tender_kind_known` CHECK became a foreign key into, and the constraint keeps
// its NAME on purpose: the name is what lets a caller, and the gate probe that has asserted on it since
// 0063, tell "that is not a tender type we take" from every other refusal in the same transaction. A
// constraint cannot be both a CHECK and a foreign key, so it is dropped and re-added rather than renamed.
// The registry carries the three facts a CHECK on `payment` could not express: `gives_change` (cash only —
// a card is authorised for an amount and a transfer arrives for one, so a surplus on either is a mis-keyed
// figure and paying change against it takes money out of the drawer nobody over-paid),
// `requires_reference` (0063 could refuse a BLANK reference and had no way to refuse a MISSING one, so a
// card payment with nothing to settle a dispute with was a storable row) and `settles_immediately`, whose
// consequence is `tender_type_change_needs_immediate_settlement`: change cannot be handed back out of
// money that has not arrived. `posting_account_code` lives here AND in `TENDER_ACCOUNT` in @berelax/core,
// which is not a second opinion but the thing a snapshot is taken FROM — `packages/db` may never import
// `packages/core`, and `packages/fixtures/src/payment.itest.ts` holds the two equal with a control.
// `payment` gains `change_given_fils` beside `amount_fils` rather than one net figure, which is the whole
// of "change recorded separately rather than netted into the payment": a drawer is counted against the
// notes that went in and the notes that came out, and one figure reconciles against neither.
// `applied_fils` is GENERATED (`amount_fils - change_given_fils`) so the settlement view and the ZT001
// ceiling read a column instead of each subtracting for themselves — and its domain is `fils` and not
// `fils_nonneg`, which is measured rather than reasoned: a generated column's DOMAIN is checked before the
// table's CHECKs, so `fils_nonneg` there refused an over-large change with `fils_nonneg_check` and
// `payment_change_not_more_than_tendered` never fired at all. `refund` is a new table whose
// `credit_note_id` is NOT NULL and carries NO foreign key, because `credit_note` is M-TILL-08's: the
// requirement — money does not leave against an invoice alone, or "an issued invoice is never edited or
// voided" stops being true — is enforceable today and the reference is not. It is the FOURTH table to
// reference `invoice`, so the five suites that truncate the invoice family name it, which is the loud
// failure 0063's own note predicted. The two ceilings are DEFERRED constraint triggers for 0018's and
// 0026's reason: `ZT001` caps what may be applied to a document at its gross PLUS the gratuity its own
// journal entry credited to 2040 — a tip is not consideration for a supply, so it is on no tax invoice and
// absent from `gross_total`, and M-TILL-06's tenders sum to the basket INCLUDING it, so a ceiling of
// `gross_total` alone would make every tipped checkout an overpayment — and `ZT004` caps refunds at what
// was applied. Deferred also because the tenders of one checkout are inserted a statement at a time inside
// one transaction, and a per-statement check would refuse the second before the first had finished paying.
// `ZT002` and `ZT003` are the per-row rules that need the registry, and both are IMMEDIATE because a
// caller reading them wants the row named. `invoice_settlement` is a VIEW, for the reason `leave_balance`
// is one (0066): there is no `invoice.paid_total` to drift, and `outstanding_fils` is exactly the quantity
// ZT001 refuses to let go negative, so the view and the ceiling cannot disagree about whether one more
// payment is allowed. Refunds are reported BESIDE it rather than subtracted, because a refund follows a
// credit note and the credited amount is M-TILL-08's. `refund` gets INSERT and SELECT and no UPDATE or
// DELETE, `tender_type` gets SELECT alone — adding a way of taking money needs a posting account chosen by
// somebody who knows what a clearing account is for, so it is a migration and not a form.
//
// 69 is 0069_customer_merge.sql: the merge as a RECORD, and the tombstone (C-CRM-05). `merge_record` is
// one row per completed merge with `loser_customer_id` UNIQUE, which makes it BOTH the tombstone index
// and the place two concurrent merges of one pair serialise — the argument 0063 makes for
// `checkout_finalisation_key_pk`, and the reason the repository inserts it before it moves a single row.
// There is deliberately no `merged_into_customer_id` column on `customer`: the pair would then exist
// twice and the first disagreement would be silent, and a merge has evidence (who, under what authority,
// on which score, and what the two records disagreed about) that does not fit in a column. Neither
// customer id is a foreign key, which is 0056's decision for an append-only log restated — a cascade
// would fire the refusal trigger and make `delete from customer` raise for the four suites that clear
// that table. `merge_record_table` holds the per-table before/after counts, and its three CHECKs are the
// unit's whole claim rather than a report about it: `rows_after_loser = rows_before_loser - rows_moved`,
// `rows_after_survivor = rows_before_survivor + rows_moved + rows_inserted`, and — for a strategy that
// moves rows — `rows_before_loser = rows_moved + rows_retained_on_loser` with a stated reason whenever
// anything was retained. A participant that quietly left rows behind cannot store its own report, and
// the refusal rolls the merge back. `merge_survivor_of(uuid)` follows the chain (A into B, later B into
// C, is an ordinary sequence of events and each row is unalterable), and `assert_merge_survivor_is_live`
// refuses an edge INTO a tombstone (ZT002) — which is also why a cycle cannot be constructed at all, so
// the depth bound raising ZT003 would mean that trigger had been dropped. Both tables are append-only
// for every role (ZT001). What it does NOT do is touch the `clinical` schema: 0009 revokes every
// privilege on it from the application role, and 0043's AAD binds a ciphertext to its `customer_id`, so
// a re-pointed clinical row would be a record nothing can decrypt — the clinical side resolves the
// tombstone on READ instead, which is what `merge_survivor_of` is granted to `berelax_clinical` for.
//
// 70 is 0070_flow_definition_and_enrolment.sql: the flow, its immutable versions, and the enrolment pin
// (C-AUTO-06). Three tables, and the whole unit is in the shape of the second and third. `flow_definition`
// holds PUBLISHED versions only, keyed `(flow_id, version)`, append-only with UPDATE and DELETE raising
// ZF001 for every role including the owner — so an edit is version N+1 and there is no draft state and no
// supersession column, both of which would be an UPDATE on a row this table refuses to update. Which
// version is LIVE is `max(version)`, deliberately NOT a `flow.live_version` column: a column there is a
// second statement of a fact the rows already carry, and the first half-failed publish makes the two
// disagree about which document the next enrolment gets. `flow_enrolment.definition_version` is NOT NULL
// and pinned by `flow_enrolment_pins_a_definition_version`, a COMPOSITE foreign key to `(flow_id,
// version)`: that is the "reference that cannot drift" the acceptance asks for, and the NOT NULL is what
// stops "not pinned yet" being expressible — a nullable column there would have every reader deciding what
// to do with it, and the convenient decision is to read `max(version)`, which is the drift this migration
// exists to prevent. The pin is also IMMUTABLE (ZF002) while `status`, `ended_at` and `ended_reason` stay
// writable, because the statement this design has to refuse is the bulk "upgrade everyone to the latest"
// and the statement it has to permit is an enrolment finishing; `flow_definition`'s append-only pair would
// have made the second impossible, which is why the two tables carry different rules. `node_count` is
// GENERATED from `jsonb_array_length(definition -> 'nodes')` so the 60-node bound holds where the row is
// written and cannot disagree with the document — a plain integer column would be a second opinion the
// first stray UPDATE breaks, and a document with no `nodes` array raises on INSERT rather than storing a
// flow with no steps. `flow.is_active` defaults to FALSE, which is the rule rather than a default:
// publishing a version is drawing a flow and enabling it is a separate decision, and a default of true
// makes the first publish of a win-back sequence start messaging the lapsed list.
// `flow_enrolment.customer_id` CASCADES, which is 0053's choice for every satellite table about a customer
// and also what keeps `delete from customer` working for the suites that clear the table (0063's recorded
// hazard about truncating `appointment`). No validation is in SQL beyond what a CHECK can state: the DSL's
// rules live in `@berelax/core` and are INJECTED into `publishFlowDefinition`, because this package may not
// import core — and with no validator injected the publish is refused by name rather than performed.
// `flow_run`, the step log and the execution cap are C-AUTO-07's and are deliberately absent here.
//
// 22, 41, 44 and 47 are unused and will stay unused: renumbering to close a gap is how two branches
// come to apply the same number to different SQL. 62 through 66 were allocations held by five units in
// flight in five worktrees, and 67 through 70 by four more; every one of them has now landed, so 55
// through 70 are in use and the four above are the only gaps left. 55, 56 and 57 landed out of order and
//
// Those five paragraphs were deleted three times by CLEAN merges before this one stuck. Each branch was
// based before the others' paragraphs existed, so git took the incoming side of this region with nothing
// to conflict on, and no other check reads this text — the migrations were present, `db:migrate:dry`
// replayed them, `db:drift` matched the mirror. Gate case 90a exists because of that: it asserts an
// unbroken run of paragraphs from 0049 up to the newest migration on disk, each naming its own file.
export const SCHEMA_VERSION = 70 as const
