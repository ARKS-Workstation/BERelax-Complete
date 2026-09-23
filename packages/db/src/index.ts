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
export * as schema from './schema/index.ts'
export {
  type CatalogueSeedResult,
  PRICE_ON_REQUEST_SEED,
  seedCatalogue,
} from './seed/catalogue.ts'
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
// 22, 41, 44 and 47 are unused and will stay unused: renumbering to close a gap is how two branches
// come to apply the same number to different SQL.
export const SCHEMA_VERSION = 54 as const
