/**
 * @berelax/db — Drizzle schema, migrations and repositories.
 *
 * Hard constraints, enforced by `pnpm boundaries`:
 *   - may import @berelax/shared only
 *   - MUST NOT import @berelax/core (dependency direction is core <- db, never db -> core)
 */

/*
  M-TILL-07's payment adapter, at the package boundary.

  This paragraph was lost in a CLEAN auto-merge: the M-TILL-07 merge landed the module, its pair suite and
  its migration, and dropped the one thing that says what this package exports. Nothing conflicted, and no
  check reads a list of re-exports, so the symptom named neither the merge nor the unit — five TS2305s in
  `packages/fixtures/src/payment.itest.ts`, a file nobody had touched, about a module that is present and
  complete on disk.

  FIVE units in two batches found it independently and restored it, which is the measurement worth keeping:
  a file that decides what a package IS has no gate over it, so the only thing that catches a deletion here
  is the next person to typecheck. That is the same hazard the ledger region in this file's tail records
  three times over.
*/
export {
  type Authorisation,
  type CapturedPayment,
  type CapturePaymentInput,
  type InvoiceSettlement,
  isOverpayment,
  isRefundExceedingPayments,
  manualPaymentAdapter,
  Overpayment,
  PAYMENT_ADAPTER_MEMBERS,
  PAYMENT_ADAPTER_MEMBERS_ARE_EXACT,
  PAYMENT_CONSTRAINT,
  PAYMENT_SQLSTATE,
  type PaymentAdapter,
  type PaymentAdapterMembersAreExact,
  paymentError,
  type RecordedPayment,
  type RecordedRefund,
  RefundExceedsPayments,
  type RefundInput,
  RefundRequiresCreditNote,
  type RegisteredTenderType,
  readInvoiceSettlement,
  readTenderTypes,
  type TenderToRecord,
  TenderTypeNotRegistered,
  TRADE_RECEIVABLES_ACCOUNT_CODE,
  type WebhookReconciliation,
} from './adapters/manual-payment.ts'
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
  type CalendarAppointmentRow,
  type CalendarDayHoursRow,
  type CalendarDayRead,
  type CalendarRoomRow,
  type CalendarTherapistRow,
  readAdjacentTradingDates,
  readCalendarDay,
  readCalendarDayHours,
} from './queries/calendar-day.ts'
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
  DUPLICATE_QUEUE_SUBJECT_LIMIT,
  type DuplicateQueueScan,
  type DuplicateQueueScanOptions,
  scanDuplicateQueue,
} from './repositories/duplicate-queue.ts'
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
  type CountedSendRow,
  FREQUENCY_SOURCE_KINDS,
  type FrequencyBoundCap,
  type FrequencyLedgerAttribution,
  type FrequencyLedgerEntry,
  type FrequencySourceKind,
  type RecordedSendWithLedger,
  readCountedSendInstants,
  readCountedSendsByContact,
  readFrequencyLedger,
  recordFrequencyCapRefusal,
  recordSendWithLedger,
} from './repositories/frequency-ledger.ts'
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
  readCustomerMergeSubjects,
  readMergedAwayCustomerIds,
  readMergeRecordForLoser,
  readMergeTableReports,
} from './repositories/merge.ts'
export {
  MERGE_UNDER_PREVIEW,
  type MergePreview,
  type MergePreviewPair,
  type MergePreviewWrites,
  PREVIEW_ROLLBACK_MESSAGE,
  previewCustomerMerge,
} from './repositories/merge-preview.ts'
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
/*
  C-AUTO-08's pipeline board. `PIPELINE_ENROLMENT_PATH` is exported for one assertion and it is an
  acceptance criterion: a stage entry enrols through `enrolOnLiveVersion`, the writer C-AUTO-06 published,
  and the test compares the reference rather than the behaviour.
*/
export {
  type ArchiveStageInput,
  archivePipelineStage,
  type MoveCardInput,
  type MoveCardOutcome,
  moveCard,
  PIPELINE_AUDIT_ACTIONS,
  PIPELINE_ENROLMENT_PATH,
  PIPELINE_REFUSALS,
  PIPELINE_SQLSTATE,
  type PipelineBoard,
  type PipelineCard,
  type PipelineColumn,
  type PipelineDeps,
  type PipelineRefusal,
  type PipelineStageRow,
  pipelineRefusalOf,
  type ReorderInput,
  readCardHistory,
  readPipelineBoard,
  readPipelineStages,
  reorderPipelineStages,
  type StageEntryEnroller,
  type TransitionRow,
} from './repositories/pipeline.ts'
/*
  C-CRM-07's preference centre. `applyPreferenceCentreChange` and its two types moved here from
  `./repositories/suppression.ts` with the write itself, so C-CRM-04's endpoint keeps importing the same
  names from this barrel and nothing outside the package changed. See that module's header for why the
  coarse action is now the scoped write's `everything` case.
*/
export {
  applyPreferenceCentreChange,
  applyPreferenceSelection,
  PHONE_CHANNELS,
  PREFERENCE_CENTRE_ACTIONS,
  PREFERENCE_CENTRE_ACTOR_LABEL,
  PREFERENCE_CENTRE_REFUSALS,
  PREFERENCE_GRID,
  type PreferenceCentreAction,
  type PreferenceCentreChange,
  type PreferenceCentreRefusal,
  type PreferenceCentreResult,
  type PreferenceGridCell,
  type PreferenceScope,
  type PreferenceSelection,
  type PreferenceSelectionResult,
  type PreferenceSubject,
  preferenceCentreRefusalOf,
  type RenderedWording,
  readPreferenceSubject,
} from './repositories/preference-centre.ts'
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
  type LabourCostRuleRow,
  type PublishedRota,
  type PublishRotaArgs,
  publishRota,
  ROTA_PUBLISHED_TEMPLATE_KEY,
  type RotaAssignmentToPublish,
  type RotaChangeRequestArgs,
  type RotaChangeRequestResult,
  type RotaCoverageRuleRow,
  type RotaPublicationNoticeRow,
  type RotaTherapistRow,
  type RotaVerdict,
  type RotaVersionAssignmentRow,
  type RotaVersionRow,
  readCurrentRotaVersion,
  readLabourCostRules,
  readRotaCoverageRules,
  readRotaPublicationNotices,
  readRotaTherapists,
  readRotaVersionAssignments,
  readTradingDayWindows,
  readTreatmentLoads,
  readWetRoomBookableWindows,
  readWetRoomSkills,
  recordRotaChangeRequest,
  rotaAssignmentDigest,
  type TradingDayWindowRow,
  type TreatmentLoadRow,
  type WetRoomWindowRow,
} from './repositories/rota.ts'
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
/*
  B-UI-04's WhatsApp ref loop (0079). `issueWhatsappRef` and `mintWhatsappRefCode` are exported although
  nothing in this build calls them, and that is the deferred-scope contract rather than dead code: they are
  the interface A-FIRST will generate codes through (docs/12 §1.1), so filling the port later is a call site
  and not a rewrite. `whatsapp_ref` ships EMPTY, which is why every code the front desk types today is
  `unknown_code` — the honest state, shown on the screen rather than reported as a zero.
*/
export {
  type IssueWhatsappRefInput,
  issueWhatsappRef,
  matchWhatsappRef,
  mintWhatsappRefCode,
  REF_CAPTURE_OUTCOME_NAMES,
  type RecordedRefCapture,
  type RecordRefCaptureInput,
  type RefCaptureCountsQuery,
  type RefCaptureCountsRead,
  type RefCaptureOutcomeName,
  readRefCaptureCounts,
  recordRefCapture,
  WHATSAPP_REF_MINT_ATTEMPTS,
  type WhatsappRefRow,
} from './repositories/whatsapp-ref.ts'
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
  CASH_SESSION_SQLSTATE,
  type CashSessionRowShape,
  type CloseCashSessionInput,
  cashSessionError,
  closeCashSession,
  type DrawerTakingsRow,
  isCashSessionClosed,
  isCashSessionPeriodLocked,
  isCountRequired,
  isVarianceNotPosted,
  type OpenCashSessionInput,
  openCashSession,
  type PostCashSessionAdjustmentInput,
  type PostedCashSessionAdjustment,
  postCashSessionAdjustment,
  type RecordCashDropInput,
  type RecordedCashDrop,
  type RegisteredCashDrawer,
  readCashDrawers,
  readCashDrops,
  readCashSession,
  readCashSessionAdjustments,
  readCashSessionsForBusinessDay,
  readDrawerTakings,
  readOpenCashSession,
  recordCashDrop,
} from './services/cash-session.ts'
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
  assertReversalMatches,
  CREDIT_NOTE_SQLSTATE,
  type CreditNoteLineInput,
  creditNoteError,
  type IssueCreditNoteInput,
  type IssuedCreditNote,
  type IssuedCreditNoteLine,
  isCreditNoteAppendOnly,
  isCreditNotePeriodLocked,
  isOverCredited,
  issueCreditNote,
  readCreditNote,
  readCreditNoteByDisplayNumber,
  readCreditNotesForInvoice,
} from './services/issue-credit-note.ts'
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
  type ClosedPeriod,
  closeAccountingPeriod,
  type DatedCorrectionInput,
  earliestOpenDateFrom,
  PERIOD_CLOSE_SQLSTATE,
  type PeriodCloseInput,
  type PeriodCloseReadiness,
  type PeriodLockStatus,
  type PostedCorrection,
  periodCloseBlockers,
  periodCloseError,
  periodStatusOn,
  postDatedCorrection,
  trialBalanceHashAsAt,
  type UnpostedDocument,
} from './services/period-close.ts'
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
  ArchivedServiceReferenced,
  currentPackageTemplateVersion,
  DEFERRED_REVENUE_ACCOUNT_CODE,
  isDuplicatePackageLine,
  isPackageVersionRaced,
  PACKAGE_SQLSTATE,
  type PackageBalanceInput,
  type PackageSaleRow,
  type PackageTemplateLineInput,
  PackageTemplateUnavailable,
  type PackageTemplateVersionRow,
  type PackageTenderInput,
  packageError,
  readPackageSale,
  type SavedPackageTemplateVersion,
  type SavePackageTemplateVersionInput,
  type SellPackageInput,
  type SoldPackage,
  savePackageTemplateVersion,
  sellPackage,
} from './services/sell-package.ts'
export {
  type AvailabilityLimits,
  GENDER_MATCHING_SETTING_KEY,
  MAX_ADVANCE_SETTING_KEY,
  MIN_LEAD_SETTING_KEY,
  readAvailabilityLimits,
  readFrontDeskMinLeadMinutes,
  readGenderMatching,
  readWhatsappRefExpected,
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
  PACKAGE_POLICY_SETTING_KEYS,
  PACKAGE_TRANSFERABLE_SETTING_KEY,
  PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
  PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
  type PackageDefaultTerms,
  readPackageDefaultTerms,
} from './settings/package.ts'
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
// 72 is 0072_credit_note.sql: the credit note, and the reference 0068 could not make (M-TILL-08). 0026
// created `invoice` append-only and named the correction path in its own comment; 0013 had already
// allocated CR-NOTE as a separate counter row and said why. So nothing here re-argues that a credit note
// is a separate document with its own series. Four things ARE this file's.
//
// 73 is 0073_period_close.sql: the period close, its preconditions, and the evidence hash (M-VAT-06).
// 0018 built the mechanism and said so in its own NOTE -- `period_lock` with a gist exclusion so two
// overlapping locks cannot exist, `period_lock_for(date)` as the single definition of "is this date
// closed", and BEFORE INSERT guards on both journal tables so every posting path meets the lock at one
// choke point -- and left the preconditions to this unit. Four things are this file's. The close is
// refused BY THE DATABASE and not only by the service: `period_lock` gains a BEFORE INSERT trigger
// raising ZE001 when the trial balance as at `ends_on` does not balance and ZE002 when a document dated
// in the period is not in the ledger, for EVERY role including the owner, because a close that only the
// application checks is a close that `psql` performs and `lockAccountingPeriod` is not the only caller
// of that table. `period_close_blocker(starts_on, ends_on)` returns the stragglers as ROWS rather than a
// boolean, so ZE002 can name them and `periodCloseBlockers` can hand the whole list back as data -- one
// definition with two readers, which is not the same as two statements of one rule.
// `period_trial_balance_hash(as_at)` is sha256 over "tb1|<date>" and one line per account of
// code|debits|credits ordered by code: in SQL so a psql session and a report written in five years both
// reproduce it, and deliberately EXCLUDING account names, because `reclassify-account.ts` exists to
// change one and a hash over the name would read as a restatement when no figure had moved. The version
// tag makes a future canonical form incomparable rather than merely unequal. And
// `raise_if_period_locked()` is REPLACED so ZL002 names the earliest OPEN date as well as the locked
// period -- appended to the existing message, so every assertion on it stays true -- which gives all
// five posting paths that refusal without five copies of it, M-VAT-05's argument for ZL004 restated.
// What it does NOT add is a refusal trigger for UPDATE or DELETE on `period_lock`: 0018 weighed that and
// decided against it ("dropping a trigger to fix a typo is how the trigger ends up dropped"), and two
// suites have since come to reset themselves by deleting locks, so the trigger's first act would have
// been to turn them red. Reopening is shut for every CODE path instead -- no grant for `berelax_app`, no
// exported function, ADR 0026 -- and that is what `period-close.itest.ts` and block 98 assert.
//
// 75 is 0075_google_reauth_notice.sql: what the Google re-auth ladder has already told somebody
// (G-CONN-08). 0016 created the connection, its capabilities and the append-only event log, and G-CONN-06
// computed the notification DECISION while saying outright that it sends nothing; this is the one durable
// fact the sending needs, and nothing here re-argues any of that. Four things ARE this file's. The table
// records DECISIONS rather than planning intentions, which is where it departs from 0051 and 0060: those
// two plan `pending` rows because both are about a date that can MOVE, and a re-auth rung is a pure
// function of the instant the incident opened and a cap (`reauthLadderFor`), so a planned row would store
// a reproducible derivation and be wrong the moment the cap changed. Every row is therefore terminal on
// insert and `google_reauth_notice_is_terminal` raises on UPDATE — but DELETE is deliberately NOT refused
// and the table does not claim to be append-only, because the foreign key cascades from
// `google_connections` and a notice history is about a grant. `incident_key` is what makes "one incident"
// a fact rather than a window: `reauth:<event id>` for a dead grant, `expiry:<iso instant>` for an
// approaching Testing expiry — that second form is the only thing that can satisfy "does not re-fire for
// the same expiry instant", because nothing HAPPENS at the moment a deadline comes into view and there is
// therefore no event row to key on. The unique index on (connection, incident, step, role, channel) is
// total rather than partial on `sent`, which is 0060's opposite choice and deliberate: a skip is also a
// decision about that rung, so a partial index would let a skipped rung retry on every pass and each retry
// would be an insert the index refuses and a pass that throws. And `rung_index between 1 and 8` restates
// MAX_GOOGLE_REAUTH_LADDER_STEPS in SQL for 0051's reason — a cap that lives only in code is a cap one bad
// settings row removes, and "escalating for ever" is the failure the word escalating invites.
// The door is held twice, which is M-VAT-06's precedent for `period_lock` and 0072's for `credit_note`:
// `google_reauth_notice_is_terminal` refuses an UPDATE from every role including the owner, and the grants
// at the foot of the file revoke UPDATE, DELETE and TRUNCATE from `berelax_app` — 0009 granted all three
// on every table in public and set default privileges extending that to tables created later, so this one
// ARRIVED with them. TRUNCATE is the one that matters most and the one a trigger cannot see: a truncated
// notice table is a ladder that sends every rung of every live incident again. DELETE stays revoked and the
// cascade still works, because a referential action does not check the deleting role's privilege on the
// referencing table.
//
// 76 is 0076_cash_session.sql: the cash drawer reconciliation, keyed on the BUSINESS DAY (M-TILL-11).
// 0011 made `business_day` a table because trading runs 11:00-02:00 and a trading date cannot be had by
// truncating a timestamp; 0063 put `trading_date` on `payment` naming this unit -- "the cash-up that
// reconciles it (M-TILL-11) cuts on this column"; and 0068 put `change_given_fils` BESIDE `amount_fils`
// for this unit too, "because a drawer is counted against the notes that went in and the notes that came
// out". Nothing here re-argues any of that. Four things ARE this file's. `cash_session.trading_date` is a
// foreign key into `business_day (trading_date)` and carries the SAME column name as the other nine
// tables holding this quantity, `business_day`'s own primary key included -- a tenth spelling for one
// fact is how two queries come to disagree about which day a note belongs to -- and it is the key
// because a shift from 23:00 to 02:00 is ONE business day: 02:00 is the close instant of the 23:00
// date's session, so both instants resolve to the same date, and a CALENDAR key would split that shift
// across two counts, measure the first against a drawer still in use and the second against a float
// nobody declared, and balance neither. There is deliberately no generated date beside `opened_at`: a
// second derivation is a second answer. `expected_float_fils` and `discrepancy_fils` are both GENERATED
// through one immutable function, `cash_session_expected_float_fils()`, because PostgreSQL forbids a
// generation expression from referencing another generated column and the alternative is two copies of
// the cash-up formula; the function is `strict`, so an OPEN session has a NULL expectation rather than
// one derived from a count nobody took. `discrepancy_fils` is `counted - expected`, SIGNED, in the
// permissive `fils` domain -- negative is short, positive is over -- and not a boolean, because a till
// out by 5 fils and one out by 500 dirhams are the same boolean and different events, and a boolean
// cannot be summed over a month to tell a process problem from a person problem; `fils_nonneg` there
// would refuse the short drawer, which is the case that matters, with a message naming no rule anybody
// could act on (0068 measured the same trap on `applied_fils`). A disagreement is RECORDED and never
// refused: `cash_session_variance_needs_a_reason` demands a `count_note` and ZU004 -- a DEFERRED
// constraint trigger, because the close and its entry are separate statements in one transaction --
// demands a `cash_up` entry dated on the session's business day carrying exactly the discrepancy on the
// side its sign says, and demands the opposite for a balanced drawer, which must name NO entry because
// `journal_line_exactly_one_side` refuses a zero-value line. Refusing the close was weighed and is
// wrong: the count is a measurement of the physical world and the expectation a derivation from rows, so
// a refusal would destroy the evidence with the mechanism meant to protect it and leave the operator
// typing the expected figure in to finish the day. ZU005 holds the four snapshotted figures equal to the
// `payment`, `refund` and `cash_drop` rows at COMMIT and ZU006 keeps that true afterwards by refusing
// cash dated on a business day whose drawer has been counted -- both scoped to the business day rather
// than to a drawer, which is EXACT while `cash_drawer` holds one row and is stated as M-TILL-13's to
// narrow once `payment.drawer_code` exists. And closed is TERMINAL: ZU002 refuses EVERY update to a
// closed session for every role including the owner, not just the `closed`->`open` transition, because
// rewriting `counted_float_fils` in place undoes a count without touching `status`; the remedy is
// `cash_session_adjustment`, a new row on its OWN business day with its own entry, which is 0072's shape
// for a credit note and 0073's for a dated reversal. "Is this date closed?" is `period_lock_for()` and
// `earliest_open_date_from()` -- 0018's and 0073's, the same two the journal's guards and
// `periodStatusOn()` read -- so no second definition exists to disagree.
//
// 77 is 0077_pipeline.sql: the pipeline board — ordered columns, one card per person, and every move
// recorded (C-AUTO-08). 0053 built both CRM vocabularies and said why a vocabulary about a person is a
// TABLE rather than an enum, and 0070 built the flow and the enrolment pin; nothing here re-argues either.
// Four things ARE this file's. The stage vocabulary is NOT `customer_lifecycle_state` under another name:
// the lifecycle is DERIVED from what has happened and a pipeline stage is where a human has PUT somebody,
// and the two disagree on purpose — a record can be `active` in the lifecycle and `lapsed` on the board
// because the front desk has given up on them. Positions are unique AND gapless, and both constraints are
// DEFERRED, which is the decision that makes a reorder possible at all: every intermediate state of a
// three-row shuffle holds either a duplicate or a gap, so an immediate UNIQUE refuses the first statement
// and an immediate gapless check refuses the second — `reorderPipelineStages` therefore needs no scratch
// positions, and the `set display_order = -n` pass it replaces is the one that leaves negative positions
// behind when a transaction dies half way through. A stage change is refused BY THE DATABASE unless the
// move is recorded: `customer_pipeline_card_records_every_move` is a deferred constraint trigger requiring
// a `pipeline_stage_transition` row for exactly this move — same contact, same from, same to, and
// `occurred_at` equal to the card's `stage_entered_at`, which is the equality that stops an OLDER
// transition into the same stage satisfying a newer move — and it fires for every role including the
// owner, because the owner is who moves a card by hand at 02:00. And the naming is the classification:
// `customer_pipeline_card` carries the `customer_` prefix so it falls inside `CRM_TABLE_PATTERN` and must
// be registered in `CRM_AUDIT_COVERAGE` (it is, by trigger), while `pipeline_stage` is the board's column
// list and `pipeline_stage_transition` IS an append-only record of who moved whom, so neither is an
// unattributable claim about a person. What this file deliberately does NOT hold: a per-column card order
// (cards are ordered by `stage_entered_at`, and a second ordering would be a second thing a drag has to
// get right), a `pipeline_stage.card_count` (a count beside the rows is a count that disagrees with them),
// and a per-stage list of flows — `entry_flow_key` is one nullable column, because a join table nothing
// writes two rows into is a table pretending to a capability, and the editor that would display several
// is C-AUTO-09's. `pipeline_stage_transition.customer_id` is a plain uuid and NOT a foreign key, which is
// 0056's decision for `consent` verbatim: an append-only log cannot reference a mutable parent, because
// the cascade would fire the refusal trigger and make `delete from customer` impossible. `ZU001`,
// `ZU002` and `ZU003` are its private SQLSTATEs; `ZU` rather than a mnemonic letter because the mnemonic
// ones are taken (`ZK` is the KEK's, `ZP` is consent's, `ZF` is the flow's) and what a private code has to
// be is unique to one file, not memorable.
//
// 78 is 0078_package.sql: versioned package templates, and a package sale that is a LIABILITY rather than
// a sale (M-TILL-09). Two things kept apart: what the business currently offers, which changes, and what a
// customer actually bought, which never does. `package_template_version` and `package_template_line` refuse
// UPDATE and DELETE outright (ZG001), so "edit the six-massage package" is `insert ... version = 2` and the
// row every outstanding balance points at cannot be reached by the edit at all — 0072's decision for a
// document and C-AUTO-06's for a flow definition, and this is the third; nothing here re-argues it. The
// current version is `max(version)` and there is deliberately NO pointer column, whose failure mode is a
// pointer at a version a later insert superseded. A sale SNAPSHOTS all five terms even though the version
// is immutable, `invoice`'s reason for snapshotting the issuer's legal name — a contract has to be readable
// as a document rather than as a join — and the two cannot drift because ZG002 holds them equal at COMMIT,
// `session_count` against `sum(package_template_line.session_count)` rather than against a stored total
// that would be a third copy. The POSTING is the unit: `Dr` tender / `Cr 2050` at the FULL gross and
// nothing on any revenue account and nothing on 2030, because **[UNVERIFIED] Y11-vat-package** puts the
// date of supply at REDEMPTION and that is the strictest safe reading — the salon holds the money as a
// liability and recognises nothing until a treatment is delivered, so an uncorrected assumption cannot
// understate a box that has already been filed. ZG005 is that rule as a database refusal, and it measures
// TOTAL movement (debits plus credits) rather than the net, because an entry crediting 4010 and debiting
// the contra 4095 by the same figure nets to zero and HAS recognised revenue. `package_balance.value_fils`
// is the sale's gross allocated across the lines largest-remainder so the shares sum to the price exactly
// (ZG006 re-adds them in SQL), because a redemption needs a figure to release and "the package cost 3,000"
// does not say what one facial out of it was worth. Its SQLSTATE class is `ZG` and NOT the mnemonic `ZP`:
// 0056_consent.sql already raises ZP001-ZP003, and two files raising one code would have made
// `packageError` translate a consent refusal as a package one — both match on SQLSTATE alone precisely so
// a wording change cannot break them. Deferred to M-TILL-10: `package_redemption`, the drawdown, expiry,
// breakage and transfers; `expires_on` is generated HERE because it is a property of the sale and a second
// derivation in TypeScript would be a second answer about when a customer's money runs out. Deferred to
// M-TILL-12/13 and stated rather than papered over: a package sale writes NO `payment` row, because
// `payment.invoice_id` is NOT NULL and this unit issues no invoice — so cash taken for a package is absent
// from `readDrawerTakings` and the cash-up (M-TILL-11) will show it as an over drawer.
//
// 79 is 0079_whatsapp_ref.sql: the WhatsApp ref loop — the codes A-FIRST will issue, and what the front
// desk did with one when it took a booking (B-UI-04). Four things are this file's and none of them
// re-argues 0053, which built both CRM vocabularies and said why a vocabulary about a PERSON is a table
// rather than an enum. First, the capture is ONE row per booking taken at the desk whatever happened —
// matched, matched nothing, or not offered — so a capture rate is two counts over one table rather than a
// matched-count divided by a guess at how many bookings there were. The rejected alternative was a nullable
// `booking.whatsapp_ref` column, and it fails twice over: a null there means BOTH "no code offered" and "a
// code that matched nothing", which are the two findings Y12-ref-loop needs told apart ("the desk is not
// pasting" is training, "the desk is pasting codes we have no rows for" is A-FIRST not having written the
// row), and a column on `booking` would put a customer-reachable attribution inside C-CRM-05's merge
// participant registry — so the capture is keyed on the BOOKING and carries no customer id at all, because
// an attribution belongs to the booking and a client-record merge must not move it. Second, the two CHECK
// constraints are the whole of "an invented attribution is unrepresentable", and they are EQUALITIES rather
// than one-way implications precisely so that neither hole is open: `matched` requires a `ref_code` and a
// `ref_code` requires `matched`, so no row can name a conversation nobody proved it came from and no
// matched row can fail to name one. Third, `whatsapp_ref_capture_outcome` IS an enum, and that is the one
// place this file departs from 0053's reasoning on purpose: those labels are provisional claims about a
// person the owner may correct, and these three are the exhaustive result of a string comparison against a
// primary key — no fourth answer for anybody to supply, nothing to confirm, no label to rename — so
// `is_provisional` would have nothing to say. Fourth, neither table is append-only, and the reason is
// mechanical rather than a relaxation: `booking_id` is ON DELETE CASCADE, so an ADR 0017 BEFORE DELETE
// trigger that raised would make `delete from booking` impossible, which is how every fixture in this
// repository cleans up. The protection is at the PRIVILEGE level instead — UPDATE, DELETE and TRUNCATE
// revoked from `berelax_app`, with referential actions bypassing privileges so the cascade still runs — and
// that is stated as the weaker promise it is rather than dressed up as the stronger one. What this file
// deliberately does NOT hold: a phone number anywhere (Y1-nap records two rival WhatsApp numbers and the
// build picks neither, so `session_reference` is A-FIRST's opaque handle and a column shaped like a number
// could not be honestly filled), a `times_used` counter beside the rows (a count beside the rows is a count
// that disagrees with them — `readRefCaptureCounts` is one `count(*) filter` statement), an expiry on a code
// (the code is a primary key and is never reissued, so nothing goes stale), and a UNIQUE on
// `session_reference` (the contract is "short code -> session", many-to-one: a conversation that comes back
// gets a second code, and refusing that would be a guess about A-FIRST's behaviour dressed as a safety
// rule). It ships with NO rows, which is the state the quick-book screen shows rather than hides.
//
// 80 is 0080_frequency_ledger.sql: one rolling-window count per contact, shared by every flow and every
// campaign (C-AUTO-03). The table exists because three unrelated journeys — a win-back sequence, a
// birthday greeting and a February campaign — each sending "only one message" collectively spam one
// person, every one of them inside its own rule, and docs/04 §5 says TDRA's sanction is sender-ID
// SUSPENSION rather than a per-message fine: the penalty falls on the identity the booking confirmations
// also leave from. So the count is per CONTACT and there is one of it; a per-campaign cap may only ever be
// stricter (C-AUTO-10), because no arrangement of per-campaign caps adds up to this one.
//
// THE decision in this file is `counted_at`. A refused attempt is a row in the SAME table — B-MSG-04
// writes no `message` row for a refused send and names this unit as where the `frequency_capped` outcome
// is kept — and what makes that safe is a biconditional: `counted_at is not null` if and only if
// `outcome = 'sent'`, with every count of the cap reading `counted_at` and never `attempted_at`. No range
// predicate on a NULL is ever true, so a query that forgot `where outcome = 'sent'` still cannot count a
// refusal. Without it the cap would be SELF-REINFORCING: the first refusal would raise the count that
// caused it, each refusal would extend its own window, and a contact who hit the cap once would be refused
// for ever. `refused_at` is the mirror column rather than a second copy of `attempted_at`, so a row has
// exactly one of the two and nothing is stored twice.
//
// The merge strategy is `union_dedupe`, which 0069 reserved for this table and which this is the only
// participant using. A ledger row says this contact was sent a promotional message at an instant, and
// after a merge the contact IS the survivor — so re-pointing makes nothing untrue and makes the cap read
// one person's real history. Both alternatives are wrong in a direction somebody pays for: rows left on
// the tombstone are invisible to the cap, which hands the merged contact a FRESH ALLOWANCE and turns a
// merge into a way to message past the cap; rows COPIED the way `consent` is copied would count one
// message twice and silence the contact for a fortnight. The natural key is
// `frequency_ledger_one_counted_send` on `(contact_customer_id, send_key)`, PARTIAL on counted rows — the
// partiality is what lets a capped attempt retried after the window rolls become a sent row under the same
// key, and the case the de-duplication exists for is real: pg-boss is at-least-once, a queued job carries
// the customer id it was enqueued with, and a contact merged mid-run leaves a job pinned to the loser.
//
// `source_ref` is text with NO foreign key, which is `invoice`'s argument applied to a counter: a deleted
// campaign must not delete the evidence of what it sent, nor reduce a contact's count. Neither it nor
// `send_key` is checked against `is_placeholder_text()` either, and that is deliberate rather than the rule
// 15 guard being forgotten — both are machine keys, that function is a SUBSTRING search, and a template key
// spelled `payment_pending` would be refused by a guard about placeholder legal copy. The cap FIGURES are
// provisional (`Y9-frequency-cap`: 2 per rolling 7 days, 6 per rolling 30) and live in `app_setting` where
// the Unconfirmed Assumptions panel reads them; they are NOT seeded here, because 0010 leaves that to
// `seedSettingDefaults` and a figure written in two places is a figure that will disagree with itself. What
// this file does add is `frequency_cap_value_is_a_cap()`, ONE predicate called from a trigger (`ZW001`, for
// the sentence a human can act on) and from a CHECK (the layer that still holds when
// `session_replication_role` has triggers off, which is how a restore runs). It refuses 0 as well as null
// and `"unlimited"`: 0 looks like the strictest setting and is the ambiguous one, because in every other
// `max_` setting 0 ALSO means "no limit" — and a reader that treats it as falsy turns the strictest value
// into the switched-off one. `ZW002` refuses an UPDATE that re-dates or un-counts a send, for every role
// including the owner; `contact_customer_id` stays writable, because the merge re-points it.
//
// 81 is 0081_hr_rota_version.sql: rota publishing — the immutable published version, the versioned
// coverage and fatigue thresholds, the wage divisor a forecast needs, the swap and claim record, and the
// per-employee publication notice (P-HR-06). Six tables, and the decision that shapes all of them is the
// one 0059 and 0066 already took for their own figures, taken again rather than by analogy: a rota is asked
// about the PAST. "Was the floor covered on the 4th of March?" is a question about a rota published months
// ago, and raising the floor minimum in April must not make March's rota retroactively non-compliant —
// which one `app_setting` value cannot express, and `app_setting_history` read as a rule table is a rule
// table nobody meant to build. So `rota_coverage_rule` and `labour_cost_rule` are VERSIONED rows keyed on
// the first trading date each governs, and `rota_version` names all three rule versions that judged and
// priced it, so the record is "this rota satisfied THESE thresholds" rather than "this rota was valid" —
// and only the first stays true. `labour_cost_rule` is separate from 0059's table rather than two more
// columns on it because the divisor answers a different question from the multipliers and will be answered
// by a different person: a column added from here would mean confirming Y9-overtime also restated a divisor
// nobody asked about. There is NO status column and no draft version row, which is 0030's decision rather
// than a simplification — the draft already exists as `shift` plus `shift_assignment`, which 0030 says "is
// rewritten", so a draft version row would be a second draft for the two to disagree about. Supersession is
// therefore forward-only: the new row carries `supersedes_id`, `unique (supersedes_id)` makes a concurrent
// double-publish a database error instead of two rival current rotas, and "the current version" is the row
// nothing points at. An OPEN SHIFT needs no table at all: it is a `shift` row with no `shift_assignment`
// row, which is what 0030 made two tables FOR, and a `rota_open_shift` flag would be a second way to say
// the same thing for somebody to forget to clear. `rota_version_assignment` SNAPSHOTS the employee, the
// trading date and the period rather than referencing `shift_assignment`, because that table's `shift_id`
// is ON DELETE CASCADE and a published rota that lost rows when a draft shift was deleted would not be
// immutable — which is the one claim it exists to make. And every reference OUT of the four immutable tables
// to a parent anybody legitimately deletes is a PLAIN COLUMN rather than a foreign key — `trading_date`, the
// three rule `effective_from` dates and both `shift_id` columns — under one principle stated in the
// migration's header: an immutable row records what was true and holds nothing else hostage. Both referential
// actions fail here for the same underlying reason and both were found by ANOTHER unit's suite. ON DELETE SET
// NULL arrives as an UPDATE, which these tables refuse for every role, so a `source_shift_id` reference made
// `delete from shift` impossible and the draft roster 0030 exists to let anybody rewrite could never be
// rewritten again; ON DELETE RESTRICT pins the parent for ever, because nothing here can be deleted to
// release it, so a reference to `business_day` stopped `generateBusinessDays` removing a date that had
// stopped trading (eleven cases in `business-days.itest.ts`) and one to `working_hours_rule` stopped P-HR-05's
// suite emptying the rate table in a probe to prove its reader throws rather than inventing rates. 0077
// recorded the first half for `pipeline_stage_transition.customer_id`; the second half is 0081's contribution
// to the same lesson. `employee_id` IS still a reference, because 0030 already decided that deleting a person
// to erase their roster is the delete worth refusing. Two figures in it are deliberately visible rather
// than convenient: `forecast_unpriced_employees`, because an employee with no wage contributes nothing to a
// sum and a forecast over the nineteen seeded therapists (every one of whom has `basic_wage_fils` null) is
// 0 fils and reads as a free rota; and `rota_coverage_rule.high_intensity_treatment_codes`, seeded EMPTY,
// because Y9-coverage says "max 4 of them deep-tissue" and no service in the catalogue is recorded as heavy
// work — 0004 refuses "Therapeutic Deep Tissue" as a CLAIM — so a list here would be a guess
// indistinguishable from a decision (brief rule 15). The sub-cap is therefore inert and says so, which is
// the visible error rather than the invisible one. `rota_publication_notice` is one row per assigned
// EMPLOYEE per version, unique on the pair, and its outcome today is `skipped` with
// `no_recipient_on_file`: nothing in this build holds a staff phone or email, and 0075 had to record the
// same gap for the Google re-auth ladder. `ZW001` (published rota immutable), `ZW002` (change request
// append-only), `ZW003` (an unchanged re-publish, refused at COMMIT by a deferred constraint trigger, which
// is how "re-publishing an unchanged version emits no notification" is a property of the database rather
// than of whichever caller remembered to compare), `ZW004` (notice append-only) and `ZW005` (a version that
// does not follow the one it supersedes) are its private SQLSTATEs; `ZW` rather than a mnemonic letter
// because the mnemonic ones are taken (`ZR` is the reschedule's, `ZS` the session's) and what a private code
// has to be is unique to one file, not memorable — 0077's reasoning verbatim.
//
// 22, 41, 44, 47, 71 and 74 are unused and will stay unused: renumbering to close a gap is how two
// branches come to apply the same number to different SQL. 71 was allocated to B-UI-03 and 74 to
// C-CRM-07, and both units turned out to need no migration at all — which is the good outcome, not a
// mistake to tidy away, so both are PERMANENT rather than held. Gate case 90a walks the migrations that
// EXIST on disk rather than consecutive integers, so a gap costs nothing and needs no declaration. 62
// through 66 were one allocation block held across five worktrees and 67 through 70 another across four;
// 72, 73 and 75 were held by three more; every one of those has landed, and 76 and 77 landed within the
// hour of each other after that. 78 through 82 were allocated to one batch of five units and landed
// together, which is why no number between 78 and 82 is a gap and why none of them was ever the "next
// free" number for long. 83 is the next number nobody holds. 55, 56 and 57 landed out of order
// and within an hour of one another, which is the arrangement this note exists for: the number is a
// high-water mark, not a count, and no gap has been closed to tidy the sequence.
//
// This paragraph was THREE rival paragraphs when M-TILL-11 arrived, and repairing them is the reason to
// say so here rather than in a commit message. One claimed 73 was still held by a unit in flight, six
// lines under 73's own paragraph; one restated the permanent gaps a second time; and the third stopped
// mid-sentence at “55, 56 and 57 landed out of order and”. That is the same clean-merge loss gate case
// 90a exists for, arriving in the one part of this region 90a cannot read: it checks the `// NN is FILE`
// openings, and nothing checks the prose. Three branches each based before the others' paragraphs
// existed, the merge taking the incoming side of each, and no conflict to look at.
//
// Those five paragraphs were deleted three times by CLEAN merges before this one stuck. Each branch was
// based before the others' paragraphs existed, so git took the incoming side of this region with nothing
// to conflict on, and no other check reads this text — the migrations were present, `db:migrate:dry`
// replayed them, `db:drift` matched the mirror. Gate case 90a exists because of that: it asserts an
// unbroken run of paragraphs from 0049 up to the newest migration on disk, each naming its own file.
export const SCHEMA_VERSION = 81 as const
