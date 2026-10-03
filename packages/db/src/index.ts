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
  ALERT_OBSERVERS,
  type AlertObservationContext,
  type ObservedAlert,
  observeAlerts,
  raiseAlertNotification,
  raiseAlertThresholdFault,
  readAlertThresholdSettings,
} from './alerts.ts'
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
  CONTACT_DETAIL_COLUMNS,
  CREDENTIAL_COLUMN_PATTERN,
  coveredTables,
  erasureCoverage,
  FREE_TEXT_NOTE_EXCLUSIONS,
  FREE_TEXT_NOTE_PATTERN,
  type ProbeAxis,
  type ProbedColumnRow,
} from './privacy-coverage.ts'
export * from './processor-register.ts'
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
// M-VAT-12's closed-month reconciliation. The report READS every figure a `done` unit already derives —
// `trialBalanceMovement`, `readPackageLiability`, `vat201Boxes` and `commissionPeriodSource` — and its own
// module header carries the table naming which function owns which, because a reconciliation report is
// exactly where a second derivation of a money figure creeps in.
export {
  assertEverySourceIsClassified,
  classifyJournalSources,
  exportMonthReconciliation,
  JOURNAL_SOURCE_CLASSES,
  type JournalSourceClass,
  MONTH_RECONCILIATION_CONSUMERS,
  MONTH_RECONCILIATION_CONSUMERS_REQUIRING_SOUNDNESS,
  MONTH_RECONCILIATION_DERIVED_HERE,
  MONTH_RECONCILIATION_FORMAT_VERSION,
  MONTH_RECONCILIATION_LINE_IDS,
  type MonthReconciliation,
  type MonthReconciliationExport,
  type MonthReconciliationLineId,
  MonthReconciliationNotExportable,
  type MonthReconciliationPeriod,
  monthReconciliation,
  monthReconciliationBytes,
  type ReconciliationLine,
  type ReconciliationLineKind,
  type ReconciliationMeasure,
  type ReconciliationSide,
  type SourceClassificationCensus,
} from './queries/month-reconciliation.ts'
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
  readWhatsappNumber,
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
// M-TILL-13's four till readers. `readTillIssuer` returns the placeholder TRN unvalidated on purpose —
// `requireIssuerTrn` in `@berelax/core` is the only thing that may put a TRN on a document, and a reader
// that threw would leave the till unable to draw the screen explaining why it cannot issue one.
export {
  readBillableAppointments,
  readPackageBalances,
  readPackageTemplates,
  readTillIssuer,
  type TillBillableAppointmentRow,
  type TillIssuerRow,
  type TillPackageTemplateRow,
  type TillRedeemableBalanceRow,
} from './queries/till.ts'
export {
  isBalanced,
  type TrialBalance,
  type TrialBalanceRow,
  trialBalanceAsAt,
  trialBalanceMovement,
} from './queries/trial-balance.ts'
export {
  canonicaliseVat201WorkingPapers,
  type Vat201BoxRow,
  type Vat201DrillDownRow,
  type Vat201MappingDisagreement,
  type Vat201NotFileableReason,
  type Vat201PartitionCensusRow,
  type Vat201Period,
  Vat201PeriodNotClosed,
  type Vat201Reconciliation,
  type Vat201UnboxedRow,
  type Vat201UnrepresentableGrouping,
  type Vat201WorkingPapers,
  vat201Boxes,
  vat201BoxForGrouping,
  vat201ContentHash,
  vat201DrillDown,
  vat201MappingDisagreements,
  vat201PartitionCensus,
  vat201UnboxedTotals,
  vat201UnrepresentableGroupings,
  vat201WorkingPapers,
} from './queries/vat201-working-papers.ts'
// R-REP-05's cohort, acquisition-spend and package-liability reads. The arithmetic is `@berelax/core`'s
// `cohorts.ts`, `cac.ts` and `package-liability.ts`; these are the rows. Three things this file states and
// nothing else does: a cohort month is `date_trunc('month', dim_customer.first_visit_business_day)` and
// nothing recomputes "first visit" (0110 defines it); a member row is grouped on `merge_survivor_of` so a
// merged customer is one person even against a materialised view that has not been refreshed since the
// merge; and `2050` is read SPLIT BY `journal_entry.source`, because H-MIG-03's reconstructed liability
// posts on `opening_balance` and a scope of the till's two sources alone would be out by exactly the
// import. `acquisitionSpendCensus` reports a MOVEMENT and a count of channel-tagged rows — which is zero,
// structurally, because no cost table in this schema carries a marketing channel.
export {
  type AcquisitionSpendCensus,
  acquisitionSpendCensus,
  type CohortActivityRow,
  type CohortMemberRow,
  type CohortRevenueRow,
  cohortActivity,
  cohortMembers,
  cohortNetRevenue,
  type DeferredRevenueBySource,
  type PackageEntitlementRow,
  packageDeferredRevenueBySource,
  packageEntitlements,
  packageSoldLessReleasedFils,
} from './reporting/cohort-queries.ts'
// R-REP-06's forecast and seasonality reads. The arithmetic is `@berelax/core`'s; these are the rows, and
// every one of them is of a commitment somebody has already made (ADR 0073) — there is no read of history
// here to extrapolate from. `payrollForecastCensus` deliberately returns no amount at all: a partial wage
// bill is a number a screen renders that is lower than the real one by exactly the employees nobody has
// priced, which is ADR 0070's subject.
export {
  FORWARD_APPOINTMENT_STATUSES,
  type ForecastCashPosition,
  type ForecastWindow,
  type ForwardBookingRow,
  type ForwardBookings,
  forecastCashPosition,
  forwardBookingRows,
  type PayrollForecastCensus,
  payrollForecastCensus,
  type SeasonalityDayRow,
  type SeasonalityPeriod,
  type SeasonalityRevenueLineRow,
  type SeasonalityRoomClosureRow,
  type SeasonalityRoomDayRow,
  seasonalityPeriod,
} from './reporting/forecast-queries.ts'
// R-REP-04's KPI reads. The contribution margin and the eight operational KPIs are ARITHMETIC and live in
// `@berelax/core`; these are the rows they are computed from. `kpiLedgerMovement` goes through
// `statementLedgerFigures` rather than aggregating `journal_line` again, which is what that module asks
// for — a third read of a ledger position is a third answer to one question. No account code is stated in
// that file: every query that needs one takes it as an argument, because the chart is `ACCOUNTS` in a
// package `packages/db` may not import.
export {
  type KpiAccountCodes,
  type KpiAccountMovement,
  type KpiDeliveryRow,
  type KpiDiscountCoverage,
  type KpiDocumentCounts,
  type KpiInvoiceLineRow,
  type KpiNoShowRow,
  type KpiPeriod,
  type KpiPeriodFigures,
  type KpiRebooking,
  type KpiTherapistCostCensus,
  type KpiTherapistCostRow,
  kpiDeliveryRows,
  kpiDiscountCoverage,
  kpiDocumentCounts,
  kpiInvoiceLineRows,
  kpiLedgerMovement,
  kpiNoShowRows,
  kpiPeriodFigures,
  kpiRebooking,
  kpiTherapistCostCensus,
} from './reporting/kpi-queries.ts'
// R-REP-02's ledger reads. The three statements are ARITHMETIC and live in `@berelax/core`; these are the
// rows they are computed from, plus the drill-down that lets a caller add the rows up itself and the census
// that counts what no account set claims. `statementBytes` delegates to M-VAT-07's canonicaliser rather than
// copying it: a second answer to "what are the bytes of this artefact" is a future disagreement about which
// set of bytes an accountant was handed.
export {
  journalRowsWrittenAfter,
  type StatementAccountFigure,
  type StatementDrillDownRow,
  type StatementDrillDownWindow,
  type StatementLedgerCensus,
  type StatementLedgerFigures,
  type StatementPeriod,
  type StatementSource,
  statementBytes,
  statementContentHash,
  statementDrillDown,
  statementLedgerCensus,
  statementLedgerFigures,
  statementPeriodSource,
} from './reporting/statement-queries.ts'
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
  ANALYTICS_INGEST_REFUSALS,
  ANALYTICS_SQLSTATE,
  type AnalyticsIngestRefusal,
  analyticsIngestRefusal,
  type CollectIngestInput,
  type CollectIngestResult,
  countPreConsentLanding,
  fileUnderTradingDate,
  ingestCollectBatch,
  type NewestSession,
  newestSessionForUpdate,
  readPreConsentLandings,
  type SessionOrigination,
  type SessionStitchDecision,
  type TradingDateFiling,
} from './repositories/analytics.ts'
export {
  ANALYTICS_CONSENT_SQLSTATE,
  ANALYTICS_CONSENT_STORE_REFUSALS,
  type AnalyticsConsentCapture,
  type AnalyticsConsentStoreRefusal,
  analyticsConsentCounts,
  analyticsConsentStoreRefusalOf,
  type DispatchEnqueueResult,
  enqueueAnalyticsDispatch,
  recordAnalyticsConsent,
  sessionConsentRow,
  type WithdrawalResult,
  withdrawAnalyticsConsent,
} from './repositories/analytics-consent.ts'
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
/*
  Y-PAY-08's chargeback: a third party's decision, arriving late, as a dated event.

  Rows only, and there is no write to `payment_intent` anywhere in that module - `captured_fils` is a
  projection of append-only transaction rows (ZY163) and the capture HAPPENED, so reducing it would leave
  the sale's own entry explaining money the header says was never taken. `recordChargebackEvent` takes a
  `UnitOfWork` rather than a bare `Sql` because ZY436 compares two entries' lines at COMMIT: a row
  committed without its entry is a refusal that arrives after the damage. `readRefundablePosition` reads
  the three figures the cap needs in ONE query, because read separately a dispute landing between the
  second and the third produces a position that was never true - and the refund it would authorise is
  exactly the one ZY433 exists to refuse.
*/
export {
  CHARGEBACK_CONSTRAINT,
  CHARGEBACK_SQLSTATE,
  type ChargebackRow,
  type ChargebackRule,
  chargebackError,
  isChargebackRedelivery,
  isChargebackRule,
  journalLineMutationGrants,
  type RecordChargebackInput,
  type RefundablePositionRow,
  readDisputeEvents,
  readRefundablePosition,
  recordChargebackEvent,
} from './repositories/chargeback.ts'
/*
  P-HR-11's commission side (0097). Reads and writes only: the arithmetic is
  `packages/core/src/hr/commission.ts`'s, this package may not import it, and `packages/hr` is where the two
  halves meet.

  `readCommissionEarnings` takes a `sourceAsOf` INSTANT and every clause of it filters on `created_at <=` that
  instant, which is what makes a recompute reproduce. For a period a `period_lock` covers,
  `commissionPeriodSource` answers with the lock's own `locked_at` — the books as filed — so a payment applied
  after the close, or a sale backdated into the month, cannot move a figure that has already been paid.
  `assert_commission_run_reads_the_lock` (ZY076) refuses a run that disagrees.

  No function here answers "is this period closed?". That is `periodStatusOn` (M-VAT-06), which
  `commissionPeriodSource` calls; the `locked_at` it then reads is a column of the row that call has already
  identified, fetched by primary key.

  There is no update and no delete: a published version is immutable (ZY071) and a run is evidence (ZY072).
  A rate that is wrong is a NEW version; a run that is wrong is a NEW run, whose purpose is to be compared
  with the first.
*/
export {
  COMMISSION_SQLSTATE,
  type CommissionDerivationRow,
  type CommissionEarningRow,
  type CommissionLineToRecord,
  type CommissionPeriodSource,
  type CommissionRuleBandRow,
  type CommissionRuleVersionRow,
  type CommissionRunRow,
  commissionError,
  commissionPeriodSource,
  type PublishCommissionRuleVersionInput,
  publishCommissionRuleVersion,
  type RecordCommissionRunInput,
  type RecordedCommissionRun,
  readCommissionDerivation,
  readCommissionEarnings,
  readCommissionRuleVersions,
  readCommissionRuns,
  recordCommissionRun,
} from './repositories/commission.ts'
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
  readAssignedTherapistIds,
  readContraindicationFlags,
} from './repositories/contraindication-flags.ts'
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
/*
  Y-PAY-02's payment intents (0106). Rows only, for the payroll block's reason one paragraph down: the
  lifecycle table, the amount fold and the projection from events to transaction rows are all
  `packages/core/src/payments/`, this package may not import it, and `packages/payments/src/intent.ts` is
  where the halves meet.

  `claimPaymentIntent` inserts the row — and so claims the idempotency key — BEFORE anything calls the
  gateway, and reports which of the two happened. That ordering is the acceptance line "a repeated
  idempotency key returns the original intent and the adapter records zero additional calls": deduplicating
  on the gateway's answer instead would still return the first snapshot, because the adapter is idempotent
  too, and would still reach it — so the replay would appear in the operator-visible call log as a second
  authorisation.

  `deriveFiguresFromTransactions` is a SECOND derivation of the figures `@berelax/core` already computes, and
  the duplication is deliberate: the acceptance line is a claim about two independent derivations agreeing,
  and one of them has to be over the stored rows.

  There is no delete anywhere and no update beyond `applyPaymentIntentMovement` and `recordGatewayIntentId`.
  A transaction row is append-only for every role (ZY161), which makes the intent it references undeletable
  too, so a suite over these tables asserts a DELTA and never a total (brief rule 9).
*/
/*
  Y-PAY-06's deposit liability (0124). Rows only: the arithmetic — what a deposit settles, what a
  cancellation refunds, which redemption targets are refused — is `packages/core/src/payments/deposit.ts`,
  and `packages/fixtures/src/deposit.itest.ts` is where the pair is asserted. There is no update and no
  delete anywhere: a movement is append-only for every role (ZY301), because each one NAMES the journal
  entry that moved the liability, so a figure that is wrong is a NEW movement and a suite over the table
  asserts a DELTA and never a total (brief rule 9).
*/
export {
  type AppendDepositMovementInput,
  appendDepositMovement,
  DEPOSIT_CONSTRAINT,
  DEPOSIT_SQLSTATE,
  type DepositBalanceRow,
  type DepositMovementRow,
  type DepositRule,
  depositError,
  isDepositMovementRace,
  isDepositRule,
  readDepositBalance,
  readDepositMovements,
} from './repositories/deposit.ts'
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
  readCurrentTemplateClasses,
  readEnrolmentPinnedDefinition,
  readFlowByKey,
  readFlowDefinition,
  readLiveFlowVersion,
  setFlowActive,
} from './repositories/flow.ts'
export {
  type AdvanceFlowRunInput,
  advanceFlowRun,
  applyCustomerTag,
  type ClaimedFlowRun,
  type ContactStepLogEntry,
  claimFlowRun,
  claimNodeEffect,
  countNodeEffects,
  type EndFlowRunInput,
  endFlowRun,
  FLOW_RUN_AUDIT_ACTIONS,
  FLOW_RUN_REFUSALS,
  FLOW_RUN_SQLSTATE,
  type FlowContactInputs,
  type FlowRunRefusal,
  type FlowRunRow,
  flowRunRefusalOf,
  type HeldStepRead,
  type NodeEffectClaim,
  type NodeEffectKey,
  type RunStepLogEntry,
  readContactStepLog,
  readFlowContactInputs,
  readFlowRun,
  readHeldStepForNode,
  readRunForEnrolment,
  readRunStepLog,
  recordStepLog,
  type StartFlowRunInput,
  type StepLogRow,
  startFlowRun,
} from './repositories/flow-run.ts'
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
  type ClosedPeriodLabourAdjustmentInput,
  GRATUITY_SQLSTATE,
  type GratuityAccrualInput,
  type GratuityAccrualRow,
  type GratuityEmployeeRow,
  type GratuityLiabilityRow,
  type GratuityMonthTotalRow,
  type GratuityRuleRow,
  type GratuitySettlementInput,
  gratuityError,
  isGratuityAppendOnlyViolation,
  isGratuityPeriodDatingRefusal,
  postClosedPeriodLabourAdjustment,
  postGratuityAccrual,
  postGratuityCorrection,
  postGratuitySettlement,
  readGratuityAccruals,
  readGratuityEmployees,
  readGratuityLiabilities,
  readGratuityRules,
  readGratuityTotalsByMonth,
  type WrittenGratuityAccrual,
} from './repositories/gratuity.ts'
export {
  type ConfirmedObservance,
  confirmHolidayObservance,
  HOLIDAY_CALENDAR_SQLSTATE,
  type HolidayConfirmationInput,
  type HolidayConfirmationRow,
  type HolidayImpactAppointmentRow,
  type HolidayImpactLeaveDayRow,
  type HolidayImpactRows,
  type HolidayImpactShiftAssignmentRow,
  type HolidayObservanceInput,
  type HolidayObservanceRow,
  type HoursOverrideInput,
  type HoursOverrideSaveResult,
  holidayCalendarError,
  isHolidayOverrideStrandingRefusal,
  isLunarNotAnnouncedRefusal,
  type PremisesHoursOverrideRow,
  readHolidayConfirmation,
  readHolidayImpactRows,
  readHolidayObservances,
  readPremisesHoursOverrides,
  readStrandedAppointmentsForOverride,
  recordHolidayObservance,
  type StrandedAppointmentRow,
  saveHoursOverride,
} from './repositories/holiday-calendar.ts'
export {
  type AddendumArgs,
  addIncidentAddendum,
  type BreachFields,
  type DutyToDate,
  type FiledIncident,
  type FileIncidentArgs,
  fileIncident,
  type IncidentDutyRow,
  incidentDuties,
  type NotificationArgs,
  recordIncidentNotification,
} from './repositories/incident.ts'
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
/*
  P-HR-09's approval path, at the package boundary.

  `approveLeaveRequest` is the whole subject and the two rules it cannot take without arrive as
  `LeaveApprovalDeps`, because `packages/db` may not import `packages/core`. Both halves of that pair are
  exported here — the dependency TYPES as well as the transaction — so a caller wiring `@berelax/core`'s
  `coverageBreachesCausedBy` and `decideLeaveApproval` in can write `satisfies` against them, which is what
  makes a field added on one side a `pnpm typecheck` failure rather than an approval nothing judged.
*/
export {
  type ApprovedLeave,
  type ApproveLeaveInput,
  approveLeaveRequest,
  type CancelApprovedLeaveInput,
  type CancelledLeave,
  cancelApprovedLeave,
  type FloorPresenceRow,
  LEAVE_REQUEST_REFUSALS,
  type LeaveApprovalDeps,
  type LeaveConflictRow,
  type LeaveCoverageAnswer,
  type LeaveCoverageInput,
  type LeaveCoverageRule,
  type LeaveDecisionAnswer,
  type LeaveDecisionInput,
  type LeaveDecisionRule,
  type LeaveDelegationRow,
  type LeaveOverrideRow,
  type LeaveRequestRefusal,
  type LeaveRequestRow,
  leaveRequestRefusalOf,
  readFloorPresence,
  readLeaveApprovalConflicts,
  readLeaveApprovalDelegations,
  readLeaveApprovalNotices,
  readLeaveRequest,
  readLiveLeaveApproval,
  readLiveLeaveConflictOverrides,
  readTradingDatesCovering,
  recordLeaveConflictOverride,
  revokeLeaveApprovalDelegation,
  type WriteLeaveDelegationInput,
  type WriteLeaveRequestInput,
  writeLeaveApprovalDelegation,
  writeLeaveRequest,
} from './repositories/leave-request.ts'
/*
  Y-PAY-07's card-on-file mandate: the paperwork, and no instrument.

  Rows only, for the deposit repository's reason — `packages/db` may never import `packages/core`, so
  whether a charge is authorised is `packages/core/src/payments/fee-policy.ts` and
  `packages/fixtures/src/mandate.itest.ts` is where the two statements of the rule are held equal. There
  is no update path and no revoke-by-edit: `payment_mandate` is append-only (ZY421) because the row is
  EVIDENCE of what a person consented to, so `revokeMandate` INSERTS a revocation and touches nothing.
  `feePolicyIsOnFile` reads the database's own answer (false) rather than assuming it, which is what lets
  the pairing suite catch the one drift that matters: a database permitting a charge the module refuses.
*/
export {
  type ChargeAttemptInput,
  feePolicyIsOnFile,
  isMandateRule,
  logChargeAttempt,
  MANDATE_SQLSTATE,
  type MandateRule,
  type MandateStatusRow,
  mandateError,
  mandatesForCustomer,
  noShowPostingFootprint,
  type RecordMandateInput,
  recordMandate,
  revokeMandate,
} from './repositories/mandate.ts'
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
  type MessagingControlRow,
  readMessagingControls,
  type ToggleMessagingControlInput,
  type ToggleMessagingControlResult,
  toggleMessagingControl,
} from './repositories/messaging-controls.ts'
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
  applyPaymentIntentMovement,
  claimPaymentIntent,
  type DerivedIntentFigures,
  deriveFiguresFromTransactions,
  isPaymentIntentRule,
  PAYMENT_INTENT_SQLSTATE,
  type PaymentIntentClaim,
  type PaymentIntentClaimResult,
  type PaymentIntentMovement,
  type PaymentIntentRow,
  type PaymentIntentRule,
  type PaymentIntentTransactionRow,
  paymentIntentError,
  readPaymentIntent,
  readPaymentIntentByKey,
  readPaymentIntentTransactions,
  recordGatewayIntentId,
} from './repositories/payment-intent.ts'
/*
  P-HR-12's payroll side (0104). Reads and writes only: the arithmetic is
  `packages/core/src/hr/payroll.ts`'s and the WPS layout is `packages/core/src/hr/wps-sif.ts`'s, this
  package may not import either, and `packages/hr` is where the halves meet.

  There is deliberately NO reader here for `timesheet_approval`, `working_hours_rule` or
  `labour_cost_rule`: `readTimesheetApprovals`, `readWorkingHoursRules` and `readLabourCostRules` already
  exist and the orchestrator calls those. A second reader of a versioned rule table is the defect the
  versioning exists to prevent — two readers eventually disagree about which version governs a date, and the
  one that disagrees is discovered on a payslip.

  `readPayslips` takes a `UnitOfWork` and not an `Sql`, so the audit row and the read share a transaction and
  there is no shape of the call that does not write one — `readEmployeeBankDetail`'s arrangement, for the
  reason docs/04 SS7 gives about salary and bank details together. `recordWpsExport` uses `recordExport`, the
  INDEXED insider-threat signal (0005), on every call and not only a large one.

  There is no update and no delete beyond `completePayrollRun`, which issues the ONE UPDATE the schema
  permits (ZY142): a completed run is immutable (ZY141) and a run that is wrong is a NEW run naming it.
*/
export {
  type CompletePayrollRunInput,
  completePayrollRun,
  type EmployeeWageRow,
  type OpenPayrollRunInput,
  openPayrollRun,
  PAYROLL_SQLSTATE,
  type PayrollPeriod,
  type PayrollRunRow,
  type PayslipRow,
  type PayslipToRecord,
  type PeriodTotalRow,
  payrollError,
  type RecordDeductionInput,
  type RecordTipInput,
  type RecordWpsExportInput,
  readDeductionTotals,
  readEmployeeWages,
  readPayrollRuns,
  readPayslips,
  readTipTotals,
  readWpsExports,
  recordDeduction,
  recordPayslip,
  recordTip,
  recordWpsExport,
  type WpsExportRow,
} from './repositories/payroll.ts'
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
  authoriseDocumentFetch,
  type DocumentFetchArgs,
  type DocumentFetchRefusal,
  type PrivateDocumentRecord,
  type RegisteredPrivateDocument,
  type RegisterPrivateDocumentArgs,
  readPrivateDocument,
  recordDocumentFetch,
  registerPrivateDocument,
} from './repositories/private-document.ts'
/*
  W-SITE-10's publication control plane. The only module in the build that writes `publication_lint_pass`,
  `publication_approval` and `publication_record`: 0093 makes all three append-only for every role, so a
  caller reaching for `db.update(publicationRecord)` gets ZZ001 rather than a second write path.
*/
export {
  type ApprovalInput,
  type LintPassInput,
  PUBLICATION_AUDIT_ACTIONS,
  PUBLICATION_REFUSALS,
  PUBLICATION_SQLSTATE,
  type PublicationPositionRow,
  type PublicationRecordRow,
  type PublicationRefusal,
  type PublishInput,
  publicationContentHash,
  publicationHistory,
  publicationPosition,
  publicationRecordById,
  publicationRefusalOf,
  publicationSqlstateOf,
  publishSurface,
  recordApproval,
  recordDraft,
  recordLintPass,
  revertSurfaceTo,
} from './repositories/publication.ts'
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
  type AggregateWriteOutcome,
  type AwaitingPasteItem,
  countReviewsReportedBetween,
  getAwaitingPasteItem,
  type IntakeResolutionOutcome,
  listAwaitingPaste,
  listReviewIntakeTargets,
  type NeedsPasteInput,
  type ParsedForwardInput,
  type PlaceAggregateReadingInput,
  type PlaceAggregateRow,
  type RecordedForward,
  type ReviewIntakeTarget,
  rawBodyByteLength,
  rawBodyDigest,
  readPreviousPlaceAggregate,
  recordAggregateNotification,
  recordNeedsPasteForward,
  recordParsedForward,
  recordPlaceAggregateReading,
  resolveIntakeWithReview,
} from './repositories/review-intake.ts'
export {
  type ApiIngestOutcome,
  type ApiReviewPayload,
  type DraftWriteOutcome,
  getReview,
  type IngestedReview,
  ingestApiReview,
  isDeliveredReplyFrozenRefusal,
  listReviewQueue,
  listStaffDisplayNames,
  listUndraftedReviews,
  type ManualReviewInput,
  type QuarantineWriteOutcome,
  type QueuedReview,
  REPLY_DELIVERY_SQLSTATE,
  type ReconciliationInput,
  type ReconciliationOutcome,
  type ReplyDraftInput,
  type ReplyLintStamp,
  type ReviewRoutingVerdictInput,
  type RoutingWriteOutcome,
  reconcileApiReviewId,
  recordDraftQuarantine,
  recordManualReview,
  recordReplyApproved,
  recordReplyConfirmedByGoogle,
  recordReplyDraft,
  recordReplyPostedManually,
  recordReplySubmittedToApi,
  recordRoutingVerdict,
  replyDeliveryRefusal,
} from './repositories/reviews.ts'
export {
  assertRecipesMatchRules,
  beginRightsRequest,
  type ErasureDeps,
  type ErasureInput,
  type ErasureReport,
  EXECUTION_RECIPES,
  type ExportInput,
  type ExportResult,
  eraseSubject,
  exportSubjectData,
  overdueRightsRequests,
  REDACTION_MARKER,
  RETAINING_ERASURE_ACTIONS,
  RIGHTS_REFUSALS,
  RIGHTS_SQLSTATE,
  type RightsRefusal,
  type RightsRequestInput,
  type RightsRequestRow,
  recordRightsRequest,
} from './repositories/rights.ts'
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
/*
  G-SEO-05's suggestion store. The only module that writes `seo_suggestion`: 0133 makes every evidence
  column immutable and refuses every DELETE (ZY402), so a caller reaching for `db.update(seoSuggestion)`
  gets a refusal rather than a second write path — and the rollback descriptor is DERIVED here rather than
  accepted, because a descriptor naming another surface is the one field whose being wrong is invisible
  until somebody needs a rollback.
*/
export {
  approveSeoSuggestion,
  type InsertSeoSuggestionInput,
  insertSeoSuggestion,
  markSeoSuggestionApplied,
  markSeoSuggestionRolledBack,
  openSeoSuggestions,
  refuseSeoSuggestion,
  SEO_ROLLBACK_METHOD,
  SEO_SUGGESTION_REFUSALS,
  SEO_SUGGESTION_SQLSTATE,
  SEO_SUGGESTION_STATES,
  SEO_SUGGESTION_TRANSITIONS,
  type SeoSuggestionRefusal,
  type SeoSuggestionRow,
  type SeoSuggestionState,
  type SuggestionRegion,
  seoSuggestionById,
  seoSuggestionCountsForRun,
  seoSuggestionRefusalOf,
  seoSuggestionSqlstateOf,
} from './repositories/seo-suggestion.ts'
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
/*
  W-SYS-11's admin session (0090). `readStaffSession` is the only way a request learns who is reading, and
  it returns `role` as a `string`: `Role` and the matrix live in `packages/core`, which `packages/db` may
  not import, so `apps/web/src/session.ts` does the narrowing at the boundary where the matrix is in scope.
  No function here mints a credential — the first one is an operator's INSERT with a runbook, because a
  seeded admin account is an invented person nobody rotates (Y8-staff, brief rule 15).
*/
export {
  generateStaffSessionToken,
  hashStaffSessionToken,
  readStaffCredentialByReference,
  readStaffSession,
  recordTotpCounter,
  revokeStaffSession,
  STAFF_SESSION_TOKEN_BYTES,
  STAFF_SESSION_TTL_MS,
  type StaffCredentialRecord,
  type StaffPrincipalRow,
  type StaffSessionResolution,
  type StartedStaffSession,
  startStaffSession,
} from './repositories/staff-session.ts'
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
  P-HR-07's attendance and timesheet side (0086). Every table is append-only, so nothing here issues an
  UPDATE and nothing here deletes: a correction is `recordAttendanceCorrection`, a dated row that leaves the
  punch saying what it always said.

  `readRosteredSpansFromVersion` reads `rota_version_assignment` and deliberately NOT `shift`, which is
  P-HR-06's deferral in its own words — the immutable published version exists to be compared against. A
  variance measured against the draft would change every time somebody rewrote next month's roster.

  No function here answers "is this period closed?". That is `periodStatusOn` (M-VAT-06), which these call,
  over the same `period_lock_for()` and `earliest_open_date_from()` the database's own guards call.
*/
export {
  type ApproveTimesheetArgs,
  ATTENDANCE_SQLSTATE,
  type AttendanceCorrectionResult,
  type AttendanceCorrectionRow,
  type AttendanceGraceRuleRow,
  type AttendancePunchRow,
  approveTimesheet,
  attendanceError,
  type RecordCorrectionInput,
  type RecordPunchInput,
  type RosteredSpanRow,
  readAttendanceCorrections,
  readAttendanceGraceRules,
  readAttendancePunches,
  readRosteredSpansFromVersion,
  readTimesheetApprovals,
  recordAttendanceCorrection,
  recordAttendancePunch,
  type TimesheetApprovalRow,
  type TimesheetFigures,
  type TradingDateRange,
} from './repositories/timesheet.ts'
/*
  The WhatsApp ref loop: B-UI-04's booking side (0079) and A-FIRST-07's lifetime, attribution and rollup
  (0127).

  0079 exported `issueWhatsappRef` and `mintWhatsappRefCode` with nothing in the build calling them, as the
  deferred-scope contract of docs/12 §1.1 — the interface A-FIRST would generate codes through, so that
  filling it later was a call site and not a rewrite. A-FIRST-07 filled it: `/api/whatsapp` mints a code
  bound to the browser session and composes the `wa.me` link from the premises row.

  `whatsapp_ref` is STILL empty in this build, and the reason has changed from "nothing calls it" to a
  refusal the unit chose. `premises.phone_whatsapp` holds the Y1-nap placeholder, the route will not mint a
  code for a message nobody can send, and that is deliberate: a code issued into an unsendable message
  would inflate the denominator of the capture rate with the absence of a phone number, and 0% would then
  read as a front-desk failure. Every code the desk types today is still `unknown_code`.
*/
export {
  type DailyRefCaptureRow,
  type IssueWhatsappRefInput,
  isRefClaimAfterExpiry,
  issueWhatsappRef,
  type MatchedWhatsappRefRow,
  matchWhatsappRef,
  mintWhatsappRefCode,
  REF_CAPTURE_OUTCOME_NAMES,
  type RecordedRefCapture,
  type RecordRefCaptureInput,
  type RefCaptureCountsQuery,
  type RefCaptureCountsRead,
  type RefCaptureOutcomeName,
  readDailyRefCapture,
  readRefCaptureCounts,
  recordRefCapture,
  rollUpDailyRefCapture,
  WHATSAPP_REF_MINT_ATTEMPTS,
  WHATSAPP_REF_SQLSTATE,
  type WhatsappRefRow,
  whatsappRefError,
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
  APPOINTMENT_IMPORT_SQLSTATE,
  appointmentImportError,
  type ImportedAppointmentCounts,
  type ImportedAppointmentInput,
  type InsertedMigratedVisit,
  insertMigratedVisit,
  isMigratedAppointmentNotLiveRefusal,
  type MigratedVisitInput,
  type ResolvedVisitTargets,
  readImportedAppointmentCounts,
  recordImportedAppointment,
  resolveVisitTargets,
  VISIT_QUARANTINE_REASONS,
  VISIT_QUARANTINES,
  type VisitQuarantine,
  type VisitResolution,
  type VisitTargetRequest,
} from './services/import-appointments.ts'
export {
  IMPORT_CONTACT_AUDIT_ACTIONS,
  IMPORT_CONTACT_KEY_KINDS,
  IMPORT_CONTACT_SQLSTATE,
  IMPORTED_CONTACT_OUTCOMES,
  type ImportContactKeyKind,
  type ImportedContactCounts,
  type ImportedContactInput,
  type ImportedContactOutcome,
  importContactError,
  importContactHmac,
  isImportIsNotAnOptInRefusal,
  type ResolvedImportedCustomer,
  readImportedContactCounts,
  readImportedContactsForNumber,
  recordImportedContact,
  resolveOrCreateImportedCustomer,
} from './services/import-contacts.ts'
export {
  type AccountPosition,
  isBehindTheBoundaryRefusal,
  OPENING_BOUNDARY_SQLSTATE,
  type OpeningReconciliationRow,
  openingBalanceIsAttested,
  openingBoundaryError,
  readChartAccountCodes,
  readLegalEntityId,
  readOpeningBalancePostings,
  readOpeningBoundary,
  readVat201Attributions,
  reconcileOpeningPosition,
  type Vat201AccountAttribution,
} from './services/import-opening-balances.ts'
export {
  CustomerUnknown,
  IMPORT_PACKAGE_SQLSTATE,
  type ImportedPackageLiabilityRow,
  type ImportedReconstructedPackage,
  type ImportReconstructedPackageInput,
  importPackageError,
  importReconstructedPackage,
  OPENING_EQUITY_ACCOUNT_CODE,
  type PackageSignOff,
  type ReconstructionTemplate,
  type RecordSignOffInput,
  readCustomerPackageAttestation,
  readImportedPackageLiability,
  readPackageDeferredRevenueFils,
  readPackageSignOff,
  readReconstructionTemplate,
  recordPackageSignOff,
  resolveHolder,
  TemplateCannotCarryReconstruction,
} from './services/import-package-liability.ts'
export {
  IMPORTED_LEAVE_SOURCE_NOTE,
  type ImportedStaffCounts,
  type ImportedStaffInput,
  type ImportedStaffRowInput,
  type InsertedImportedStaff,
  insertImportedStaff,
  isLeaveBalanceBasisRefusal,
  readImportableDocumentTypes,
  readImportedStaffCounts,
  readLeaveRuleInForce,
  recordImportedStaffRow,
  STAFF_IMPORT_SQLSTATE,
  STAFF_QUARANTINE_REASONS,
  STAFF_QUARANTINES,
  type StaffCredential,
  type StaffQuarantine,
  staffImportError,
  staffReferenceIsHeld,
  ZERO_LEAVE_BALANCE_QUESTION,
} from './services/import-staff.ts'
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
  isAppointmentAlreadyRedeemed,
  isBalanceOverdrawn,
  PACKAGE_REDEMPTION_SQLSTATE,
  PackageBalanceUnavailable,
  PackageExpired,
  type PackageExposureRow,
  type PackageLiability,
  PackageNotTransferable,
  PackageReleaseDisagrees,
  packageRedemptionError,
  type RedeemedPackage,
  type RedeemPackageInput,
  readExpiredPackages,
  readPackageLiability,
  redeemPackage,
  type TransferPackageBalanceInput,
  type TransferredPackage,
  transferPackageBalance,
} from './services/redeem-package.ts'
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
  type AmendVatReturnInput,
  amendVatReturn,
  type FinaliseVatReturnInput,
  finaliseVatReturn,
  readVatReturn,
  SamePersonSignOff,
  type SignOffVatReturnInput,
  type SnapshotVatReturnInput,
  type StoredVatReturn,
  signOffVatReturn,
  snapshotVatReturn,
  VAT_RETURN_CONSUMERS,
  VAT_RETURN_SIGN_OFF_CAPACITIES,
  VAT_RETURN_SQLSTATE,
  type VatReturnBoxFigure,
  type VatReturnConsumer,
  type VatReturnFinalisation,
  type VatReturnForFiling,
  type VatReturnNotFileableReasonRow,
  VatReturnNotSignedOff,
  type VatReturnSignature,
  type VatReturnSignOff,
  type VatReturnSignOffCapacity,
  type VatReturnSignOffState,
  vatReturnBoxFigures,
  vatReturnError,
  vatReturnForFiling,
  vatReturnNotFileableReasons,
  vatReturnSigningRoles,
  vatReturnSignOffState,
} from './services/vat-return-signoff.ts'
// M-VAT-09. The one-way Zoho Books export, beside the return it reads: bytes a person carries into the
// accounting package, never a call. `renderZohoVatReturn` and `zohoExportFilename` are exported beside the
// service because a screen has to be able to name the download before asking for it; what is NOT exported
// anywhere is a way to reach the figures except through `vatReturnForFiling` (ADR 0052).
export {
  type ExportVatReturnForZohoInput,
  exportVatReturnForZoho,
  renderZohoVatReturn,
  ZOHO_EXPORT_FORMAT_VERSION,
  ZOHO_EXPORT_MEDIA_TYPE,
  ZOHO_EXPORT_SURFACE,
  type ZohoExportBoxRow,
  type ZohoExportNotFileableRow,
  ZohoExportSnapshotUnreadable,
  type ZohoExportSurfaceEntry,
  type ZohoExportTotals,
  type ZohoVatReturnDocument,
  type ZohoVatReturnExport,
  zohoExportFilename,
} from './services/zoho-export.ts'
export {
  type AvailabilityLimits,
  GENDER_MATCHING_SETTING_KEY,
  MAX_ADVANCE_SETTING_KEY,
  MIN_LEAD_SETTING_KEY,
  readAvailabilityLimits,
  readFrontDeskMinLeadMinutes,
  readGenderMatching,
  readWhatsappRefExpected,
  readWhatsappRefTtlDays,
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
  type PackageReconstructionPolicy,
  type PackageTemplateKeyRow,
  readPackageReconstructionPolicy,
  readPackageTemplateKeys,
  readWorkbookPackageTemplates,
  type WorkbookPackageTemplate,
} from './settings/package-templates.ts'
export {
  DEPOSIT_ENABLED_SETTING_KEY,
  DEPOSIT_PERCENT_BP_SETTING_KEY,
  DEPOSIT_POLICY_SETTING_KEYS,
  readDepositPolicy,
  type StoredDepositPolicy,
} from './settings/payments.ts'
export {
  BREACH_NOTIFICATION_HOURS_SETTING_KEY,
  readBreachNotificationHours,
} from './settings/pdpl.ts'
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
// The declarations only, never the scan: `./suite-table-ownership.ts` reaches for `node:fs` and this barrel
// is imported by the application. The integration run's own invariant needs to know which tables a suite is
// allowed to have emptied, and it runs from `packages/fixtures`.
export {
  DECLARED_UNQUALIFIED,
  type DeclaredKind,
  type DeclaredUnqualified,
  NEVER_DECLARABLE,
  restorableTables,
} from './suite-table-declarations.ts'
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
// refuses an edge INTO a tombstone (ZT006) — which is also why a cycle cannot be constructed at all, so
// the depth bound raising ZT007 would mean that trigger had been dropped. Both tables are append-only
// for every role (ZT005). Those three were ZT001-ZT003 until 0099: this file and 0068 both reached for
// class ZT in worktrees that could not see each other, so for eleven merges one code stood for the
// overpayment ceiling AND for this table being append-only. What it does NOT do is touch the `clinical` schema: 0009 revokes every
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
// `flow_run`, the step log and the execution cap were C-AUTO-07's and are no longer absent: 0091 adds
// all three, and the sentence that used to stand here said they never would be.
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
// the cascade would fire the refusal trigger and make `delete from customer` impossible. `ZU008`,
// `ZU009` and `ZU010` are its private SQLSTATEs; `ZU` rather than a mnemonic letter because the mnemonic
// ones are taken (`ZK` is the KEK's, `ZP` is consent's, `ZF` is the flow's) and what a private code has to
// be is unique to one RULE, not memorable and not unique to a file. They were ZU001-ZU003 until 0099,
// which is the correction: 0076's cash session held those three, so a probe asserting `ZU002` was as
// happily satisfied by a closed drawer refusing an edit as by this log refusing one.
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
// M-TILL-10 — re-ownered, because the unit wrote M-TILL-12 and that unit is already done — and stated
// rather than papered over: a package sale writes NO `payment` row, because
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
// to erase their roster is the delete worth refusing.
//
// That principle needs its exception stated beside it, because 0076 four numbers below deliberately does
// the opposite and is RIGHT to: `cash_session.trading_date` IS a foreign key into `business_day`, ON
// DELETE RESTRICT, so a trading date on which a drawer was counted cannot be removed. Both positions are
// correct and the difference is what the reference MEANS. 0081's were provenance — which rota version
// judged this roster, which rule priced it — and provenance is a fact about the past that should not
// reach forward and stop somebody editing the present. 0076's is EVIDENCE: a counted drawer is a
// statement about that day, and a day you took money on is not a day anybody may un-trade. So the rule
// is not "an immutable table never holds a key"; it is that an immutable row may pin a parent only when
// pinning it is the point. When it is merely recording where something came from, the reference is a
// plain column.
//
// P-HR-07 then sharpened the test into something mechanical, which is better than a judgement about
// meaning: ask whether the CHILD can be deleted to release the pin. A `cash_session` can — 0076's own
// suite deletes its sessions — so the pin is releasable and holding the key costs nothing. An
// `attendance_event` cannot be deleted by anybody, so a RESTRICT reference from one would pin every date
// it names for ever, which is why 0086 checks the trading date at INSERT, where the row is still fixable,
// and keeps the column plain. Same conclusion as "provenance versus evidence", reached without having to
// agree on what a reference means. Two figures in 0081 are deliberately visible rather
// than convenient: `forecast_unpriced_employees`, because an employee with no wage contributes nothing to a
// sum and a forecast over the nineteen seeded therapists (every one of whom has `basic_wage_fils` null) is
// 0 fils and reads as a free rota; and `rota_coverage_rule.high_intensity_treatment_codes`, seeded EMPTY,
// because Y9-coverage says "max 4 of them deep-tissue" and no service in the catalogue is recorded as heavy
// work — 0004 refuses "Therapeutic Deep Tissue" as a CLAIM — so a list here would be a guess
// indistinguishable from a decision (brief rule 15). The sub-cap is therefore inert and says so, which is
// the visible error rather than the invisible one. `rota_publication_notice` is one row per assigned
// EMPLOYEE per version, unique on the pair, and its outcome today is `skipped` with
// `no_recipient_on_file`: nothing in this build holds a staff phone or email, and 0075 had to record the
// same gap for the Google re-auth ladder. `ZW006` (published rota immutable), `ZW007` (change request
// append-only) — both moved off `ZW001`/`ZW002` by 0099, which 0080's frequency ledger holds — `ZW003` (an
// unchanged re-publish, refused at COMMIT by a deferred constraint trigger, which
// is how "re-publishing an unchanged version emits no notification" is a property of the database rather
// than of whichever caller remembered to compare), `ZW004` (notice append-only) and `ZW005` (a version that
// does not follow the one it supersedes) are its private SQLSTATEs; `ZW` rather than a mnemonic letter
// because the mnemonic ones are taken (`ZR` is the reschedule's, `ZS` the session's) and what a private code
// has to be is unique to one RULE, not memorable and not unique to a file — 0077's paragraph, corrected in
// the same place and for the same reason.
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
// free" number for long. Which number is next free is stated ONCE, in the note immediately before
// `SCHEMA_VERSION`, and nowhere else — this paragraph said 83 for four merges after 83 had landed.
// 55, 56 and 57 landed out of order
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
// 82 is 0082_clinical_intake.sql: the template that is versioned rather than edited, the consent that must
// exist before an answer may be stored, and the step-up grant a read is refused without (C-CRM-08). 0008
// built the tables and 0043 built the rotation rules; nothing here re-argues either. Five things ARE this
// file's. A template row is IMMUTABLE apart from `is_current` and `superseded_at` (ZJ001), which is what
// makes "editing a template creates a new version" a fact about the database rather than a property of the
// repository that happened to issue the write — a typo corrected in `psql` would otherwise change the
// meaning of every submission already captured against that row, because a submission holds only a
// reference to it. A new version must be numbered ABOVE every existing version of its locale (ZJ002), and
// monotonic rather than contiguous on purpose: a contiguous rule makes this table order-dependent across
// the integration suite, so the first file to insert version 1 would fail every later file that wanted it,
// and a BEFORE INSERT trigger fires before ON CONFLICT is resolved, so refusing a version that already
// exists breaks every idempotent upsert — both found by collateral, the second on the SECOND run of
// `crypto/rotation.itest.ts`. The consent gate is a DEFERRED constraint trigger matching on the wording
// HASH and not on the template id (ZJ003), which is the substance of it: consent given to version 3's
// wording covers version 4 only if the wording did not change, and a gate keyed on the template id would
// both refuse a client who consented to wording nobody touched and — far worse — ACCEPT one whose consent
// predates a rewritten consent paragraph. `data_origin = 'real'` is refused outright while
// OPEN-QUESTIONS Y5-residency is open (ZJ005), through a SETTING the trigger reads, so answering the
// question is a configuration change and not a release; an absent setting row reads as false, because a
// gate whose default is "permitted" when its configuration is missing is a gate that opens during a
// restore. And `clinical.step_up_grant` is in the CLINICAL schema rather than in public, by ADR 0010's own
// test for what belongs there — exactly one code path consumes a grant, nothing else joins it, and a
// relocated store that had left its grants behind would reach back across a database boundary for its own
// authorisation decision. The AAD gains a FOURTH term, `aad_context`, stored rather than derived so that
// every term the GCM tag covers is a column of the row and 0043's ZK002 freezes all four; a CHECK ties it
// to `template_version` and a trigger ties that to the referenced template (ZJ004), because an intake
// payload is a map from a question set's field keys to values, so a payload captured under version 3 moved
// onto a row labelled version 4 would decrypt cleanly and be read against questions it was not asked.
// `retain_until` is computed at capture from `regulatory_profile_current.clinical_retention_years` — 25
// years under the unconfirmed licence, because Y1-licence resolves to the stricter reading — and STORED,
// so a past decision stays explainable after the profile changes. What this file deliberately does NOT
// hold: a plaintext column of any kind, a DELETE grant (0009 revokes it across the schema and a grant here
// would reinstate it for the one table that records who looked at a health record), and any foreign key to
// `public` — `employee_id` and `customer_id` are plain uuids, which is 0008's decision verbatim. `ZJ` is
// its private SQLSTATE prefix: `ZI` is 0026's and 0072's, and every other mnemonic letter is taken, so what
// a private code has to be is unique to one file rather than memorable, which is 0077's argument verbatim.
//
// 83 is 0083_package_redemption.sql: the drawdown, the VAT event, expiry, and the `payment` row a package
// sale never wrote (M-TILL-10). 0078 put the whole consideration into 2050 as a liability; this is the other
// end, and the POSTING is the unit: `Dr 2050` at the released gross, `Cr 4020` at the net, `Cr 2030` at the
// VAT, because **[UNVERIFIED] Y11-vat-package** puts the date of supply at REDEMPTION — so the sale period's
// output-VAT box holds nothing from packages and the redemption period's box 1 holds the tax on what was
// delivered. ZG008 is that rule as a database refusal and it is STRICTER than ZG005 has to be: a sale may
// say "nothing on revenue", and a release has to say "exactly this much on exactly 4020 and nothing on any
// other revenue account" — measured as debits PLUS credits on the others, ZG005's reason, because 4010
// credited against the contra 4095 nets to zero and has put a package's revenue on the wrong VAT box. What a
// redemption releases is `package_release_through_fils(value, total, redeemed) = ceil(value * redeemed /
// total)`, ONE expression in SQL that `@berelax/core`'s `releaseThrough` computes identically in BigInt and
// that a census in packages/fixtures holds equal both ways; deliberately NOT largest-remainder over equal
// weights, which is what the per-LINE split uses, because checking largest remainder in a CONSTRAINT means
// reimplementing it in PL/pgSQL and a closed form has no second implementation. ZG009 is what makes the
// drawdown columns mean anything: 0078 gave them ceilings and a ceiling is not an identity, so ZG009 holds
// `sessions_redeemed` and `released_fils` equal to the SUM of the redemptions AND to the formula — the third
// equality being the one the other two cannot give, since a caller releasing a plausible but wrong figure
// consistently in both places satisfies them. It fires from BOTH tables, because a balance moved with no
// redemption row and a redemption row with no balance move are different defects. Expiry READS 0078's
// generated `expires_on` (ZG010) and BREAKAGE POSTS NOTHING: **[UNVERIFIED] Y9-package-policy**
// provisionally RETAINS an unredeemed balance, so the customer is still owed the treatments and moving 2050
// into revenue would recognise money the business owes — on a VAT box, for a supply that has not happened,
// and reversing it later means amending a filed return. `package_expiry_exposure` is therefore a VIEW that
// MEASURES what is unreleased against an expired sale, which is the figure the owner needs to answer the
// question at all; a sale sold under `forfeited` terms gets a refusal naming the question rather than a
// guessed posting, and 4050 Unredeemed voucher breakage is NOT reused because a voucher and a package are
// different products sharing a box. An appointment is redeemed or charged and never both, which cannot be a
// unique constraint because the two facts live in two tables — it is a TRIGGER PAIR (ZG011), one on each
// table, because whichever row arrives second has to be the one refused. Finally the fix to 0078's own
// recorded defect: `payment.invoice_id` becomes NULLABLE, `payment.package_sale_id` is added beside it and
// exactly one of the two is required, because a package sale writes no invoice and cash taken for it was
// absent from `readDrawerTakings` and ZU005 — so M-TILL-11's cash-up read the drawer as OVER by it and
// posted the difference to 6140. `payment_within_the_document()` (ZT001) is REPLACED rather than extended,
// and not for a feature: with a nullable invoice_id its test became `0 > NULL`, which is NULL, which is not
// TRUE, so the ceiling silently stopped applying to exactly the rows this file adds — the package branch is
// an EQUALITY (ZG012) and not a ceiling, because an invoice may be part paid and a package may not. Its
// SQLSTATE class is `ZG`, the SAME as 0078's, which is the one place this file departs from that header's
// argument on purpose: 0078 left `ZP` because two DOMAINS sharing a class makes one translator answer for
// the other's refusal, and this is the same domain read by the same caller with disjoint numbers — and
// eleven codes already appear in more than one migration file, because a later migration replaces the
// function that raises one. Deferred to M-TILL-13, which is todo: a tax document at redemption (the VAT
// itself is NOT deferred with it — 2030 is credited here) and the seeded fixture packages, because what the
// business sells is a fact nobody has stated.
//
// 89 is 0089_vat201_mapping.sql: the VAT201 box mapping as ROWS, the return engine that sums them, and the
// drill-down from a box to a journal line to the document behind it (M-VAT-07). [UNVERIFIED]
// Y11-vat201-boxes is open — the real box numbers await an FTA-registered tax agent, Y11-tax-agent records
// that review as not optional — and its recorded provisional answer is "Box 1 / Box 3 / Box 10 as
// placeholders, held in a data table with a test proving the mapping is data not code". The clause after
// the comma is the whole design: `vat201_box` and `vat201_box_mapping` are rows, and
// `packages/fixtures/src/vat201.itest.ts` UPDATEs one row and asserts a figure lands in a different box
// with a control proving it was in the first box beforehand. A mapping written as `if (grouping =
// 'standard_rated_supplies') then 1` is one nobody can correct without a deploy, and the one thing
// everybody agrees about this unit is that an agent will hand back different numbers.
//
// The mapping is keyed on the ACCOUNT and NOT on `account.vat_box`, which is M-VAT-03's recorded finding
// rather than a preference: every recoverable expense account carries `recoverable_input_tax` as well as
// 1080 does, so summing the grouping added the rent expense to the input VAT (measured: 2,006,706 fils
// where the claim was 6,706); and `reverse_charge` is carried by BOTH 2035 and 6075, which belong in
// different COLUMNS of the box on opposite SIDES of the arithmetic. So each row states three things the
// chart does not — `box_no` (what Y11-vat201-boxes answers), `measure` (the value of the supply or the tax
// on it) and `contribution` (which direction is positive). `contribution` is derived at seed time from
// `account.type` and never from `normal_balance`: 4095 Discounts and allowances is a CONTRA revenue
// account on the debit side whose contribution is still `credit_less_debit`, because a 500-fils discount
// must REDUCE box 1 — the one account in the chart where the two rules differ, and deriving from
// `normal_balance` gets it exactly backwards on a return that still balances.
//
// The seed is five INSERT … SELECTs off the chart rather than 62 retyped codes, and it caught a real
// mistake while being written: 0034 reclassified 5060 Staff accommodation from recoverable to BLOCKED, so
// a list typed from 0018 would have mapped it into the input box. An account a LATER migration adds gets
// no row at all, which `vat201_mapping_is_complete()` refuses (ZY009, deferred so an account and its
// attribution may arrive in either order) — that is the acceptance line "a test enumerates the chart and
// fails on an untagged account", enforced by the database instead of by a test that has to remember to
// run. ZY010 is the one rule here that is double entry rather than a VAT question, and it is refused
// rather than reported: a revenue account mapped as `measure = 'tax'` would report the whole net as VAT,
// about twenty-one times the right figure, on a return whose drill-down still reconciles to it.
//
// What is NOT refused is drift against `account.vat_box`. `reclassifyAccountRecoverability` (M-VAT-02) is
// a sanctioned audited owner operation that UPDATEs that column, and a trigger here would refuse the very
// change the chart exists to permit — so `vat201_mapping_disagreement()` REPORTS it, the working paper
// carries it as a section that must be empty, and the itest asserts it is empty with a control that
// retags an account and requires the row to appear. A refusal nobody can satisfy is worse than a
// measurement somebody reads.
//
// `vat201_box_total()` is an AGGREGATE OVER `vat201_box_line()` and never a second query over the journal.
// That is the structural half of "a box total equals the sum of its drill-down lines, exact to the fils":
// two queries are two `where` clauses that agree until somebody edits one, and a one-fils disagreement
// between a box and the lines a preparer is shown when they click it is the defect this unit exists to
// prevent. The join from a line to its attribution is a LEFT JOIN on purpose — an INNER one would DROP a
// line whose account has no attribution, and both the return and the census meant to notice would report
// success — so an unattributed line becomes a visible bucket with a count instead. Nothing in the file
// divides, rounds, multiplies or names a VAT rate, which is why the answer to [UNVERIFIED] Y11-rounding
// cannot move a box total by a fils: it decides how an invoice SPLIT its gross when it was issued, which
// is M-TILL's, and a filed period cannot be restated by re-reading it.
//
// The SQLSTATE class is ZY, and it is FRESH. `packages/db/src/sqlstate-uniqueness.test.ts` records
// thirteen codes already standing for two rules each, and measured before this file was written ZA
// through ZX are all in use: only ZY and ZZ were free. Taking "the next number in a plausible class"
// would have made one file's translator report another file's refusal with a plausible message and the
// wrong cause. **ZZ is now the only free class left**, which is recorded here because the next unit that
// needs one has to know before it starts rather than after.
//
// 78 through 81 are allocations held by units in flight in other worktrees, so 82 is not a gap in the
// record: gate case 90a walks the migrations that EXIST on disk rather than consecutive integers, which is
// what makes a non-contiguous allocation cost nothing. 83, 84, 86 and 87 landed together as the second
// batch of five; 85 was allocated to C-CRM-10, whose worktree survived a container restart with the work
// uncommitted, so 85 is HELD rather than free and rather than a permanent gap — it will land with that
// unit. **Which number is next free is stated ONCE, in the allocation note immediately before
// `SCHEMA_VERSION`, and nowhere else.** This paragraph carried its own answer — 88 — for nine migrations
// after 88 had landed, which is exactly the drift that note exists to prevent, one paragraph away from the
// sentence saying so.
//
// 84 is 0084_contraindication.sql: the boolean-only crossing — the one thing the booking layer may ever
// learn about a clinical record, made into a shape that can carry nothing else. 0008 created
// `clinical.contraindication_flag` with five booleans and 0009 built the view over it; 0082 wrote no flag
// row at all, so until this file the view answered EMPTY for every submission in the database and nothing
// in the build read it. Four changes, and each closes a way the crossing could say something it has no
// right to say. **The closed set is eight keys, so three columns are added** — `allergy_present`,
// `blood_thinners` and `acute_injury` are in `CONTRAINDICATION_FLAG_KEYS` and had no column, and a key
// without a column is a flag that derives and is then indistinguishable from a client who answered no. The
// eighth key is `requires_consultation` and NOT `practitioner_review_required`: `practitioner` is a
// `PROVIDER_TITLES` entry the seeded `regulatory_profile.permitted_public_titles` does not permit, so under
// the unconfirmed licence (Y1-licence, which resolves to the narrower wellness vocabulary) a label built on
// it is refused by `unpermitted_staff_title` — and 0008 already had the column under this name. **A flag
// row carries its own provenance**, `derivation_version` and `source_template_version`, because without
// them a stale set is indistinguishable from a fresh one and the front desk reads a marker derived from a
// form the client has since replaced; a trigger ties the claimed version to the referenced submission
// (ZA001) and, the one that would be a disclosure rather than a stale marker, refuses a row whose source
// submission belongs to a DIFFERENT customer (ZA002) — `customer_id` is the primary key and
// `source_submission_id` points at a row whose own customer is another column, so nothing structural stops
// a flag row putting one person's answers on somebody else's record. An existing row back-fills to
// `derivation_version = 0` and not 1, because a back-filled 1 would claim the current derivation produced
// it and read as fresh for ever; 0 reads as stale, which is brief rule 15 applied to a version number. Both
// defaults are then DROPPED, so a writer that omits `undetermined_count` cannot assert that every answer
// was readable. **"We could not read an answer" implies "ask a human", as a CHECK**:
// `undetermined_count = 0 or requires_consultation`, here as well as in the derivation for ADR 0010's
// reason, so a row written by hand that swallows an unreadable answer is refused — and the two layers are
// asserted through different observables on purpose, a pure assertion for the derivation and this
// constraint's NAME for the row, which is C-CRM-08's recorded fix for two cases that reported the same name
// for both. **The view is rebuilt to carry the crossing and nothing else**: a customer id and eight
// booleans, asserted against `information_schema`. `updated_at` is DROPPED from it — the one non-boolean it
// carried, and the date on which somebody filled in a health form is not a booking decision — and it stays
// on the table, behind the step-up gate. `customer_id` is resolved through `merge_survivor_of()` and the
// two histories `bool_or`ed, which closes C-CRM-05's deferral: `merge-participants.ts` registers this table
// as one a merge deliberately does not re-point, records that the tombstone is resolved ON READ, and
// records that nothing read the view yet — so this unit is its first reader, and without the resolution a
// client whose duplicate record was merged away would silently lose every marker. `requires_consultation`
// is ORed with `clinical.contraindication_flags_are_stale()` in the view, so a stale set arrives at the
// front desk as "ask the client" with no second column for a consumer to forget; that function is SECURITY
// DEFINER with a pinned `search_path`, because `security_invoker = false` makes a view's own base relations
// checked against the view owner and does NOT do that for a function called from the view body — found by
// running one statement as `berelax_app` rather than as the owner a test pool connects as. `ZA` is its
// private SQLSTATE prefix: `ZB` through `ZW` are taken, one file each, so what a private code has to be is
// unique to one file rather than memorable, which is 0077's argument and 0082's verbatim.
//
// 86 is 0086_attendance.sql: attendance as EVIDENCE, the timesheet approval that locks a period, and the
// dated correction that is the only way to change what a locked period says. Every table is append-only
// (ZX001, for every role including the owner) because payroll pays attendance: a punch that can be edited is
// a paid hour that can be made never to have happened. `attendance_event` holds one row per PUNCH rather than
// one per presence with a nullable clock-out, and that is forced rather than chosen — filling a clock-out in
// later is an UPDATE — which makes INCOMPLETE a SHAPE, a clock-in with nothing after it, instead of a null a
// reader has to remember to check. `occurred_at` is refused off a whole minute, because `workedMinutes` in
// @berelax/core refuses a span that is, so seconds admitted here would surface as a thrown pricing call on a
// screen rather than as a rejected punch at the desk. `attendance_trading_date_for()` is THE one definition
// of which trading date a punch belongs to — the insert trigger checks the column against it (ZX003) and
// `recordAttendancePunch` takes no trading date at all, so a 01:50 clock-out belongs to the day that opened
// at 11:00 and there is no second reading to disagree; it reads the materialised `business_day` calendar
// widened by a versioned `punch_tolerance_minutes`, bounded at 240 because one day's close and the next day's
// open are nine hours apart and a wider tolerance would make two days claim one punch.
// `assert_attendance_punch_alternates` (ZX002) is what makes INCOMPLETE mean exactly one thing, and it is
// scoped to the trading date because an unclosed Monday must not stop somebody clocking in on Tuesday. The
// grace windows, the implausible-span figure and the tolerance are VERSIONED rows of `attendance_grace_rule`
// and not `app_setting` values, which is 0059's, 0066's and 0081's decision taken a fourth time and it is
// sharpest here: this is the unit asked about the PAST most often, and widening the window in April must not
// make March's lateness retroactively disappear. A correction produces NO punch row — the obvious shape, and
// wrong twice, because the punch would be dated inside the very period the correction works around and
// because the same fact in two places means a reader that found one and not the other reports a corrected day
// as an ordinary one; `applyAttendanceCorrections` layers the row over the punches instead, and
// `attendance_correction.reason` is refused blank, placeholder or under eight characters by CONSTRAINT rather
// than by UI validation alone. TWO locks compose without a second reader of either: the accounting period
// lock through `raise_if_period_locked()`, the same function every posting path reaches so a refusal names
// the earliest OPEN date, and the approved timesheet through ZX004, which is absolute and needs no exemption
// precisely because a correction changes an approved period without inserting into that table. What this file
// deliberately does NOT hold: a foreign key from any of the three tables into `business_day`, because
// `business_day` is generated and `business-days.itest.ts` empties it, so a RESTRICT reference from a row
// that can never be deleted would pin every date it named for ever — the failure P-HR-06 found in eleven
// cases of another unit's suite, and the reason 0076's `cash_session.trading_date` CAN hold that key is the
// mechanism rather than the meaning: a cash session can be deleted to release the pin. What it does hold is
// `timesheet_approval.rota_version_id` as a KEY, which is P-HR-06's deferral in its own words — the immutable
// version exists to be compared against — and a PRECONDITION rather than provenance, since a plain column
// would let a timesheet be approved against a version nobody published (ZX005 also refuses a superseded one).
// `ZX` is its private SQLSTATE prefix: every mnemonic letter from `ZB` to `ZW` is taken, so what a private
// code has to be is unique to one file rather than memorable, which is 0077's argument verbatim.
//
// 87 is 0087_compliance_gate.sql: the promotional send window cannot be switched off, and the refusal holds
// for a `psql` session (C-AUTO-04). It adds no table and seeds no row. `messaging.promotional_window` is an
// `app_setting` row, and before this file the ONLY thing refusing `{"startHour": 0, "endHour": 24}` was
// `assertPromotionalWindowChange` in `@berelax/messaging` — correct, and not in the path of a seed, an
// import, a `writeSetting` from a script, or the UPDATE somebody runs at 02:00 to get a campaign out. So
// `promotional_window_is_a_narrowing()` is ONE predicate called from a trigger and from a CHECK, which is
// 0080's division of labour verbatim: the trigger is the sentence a human can act on, the CHECK is the layer
// that still holds when `session_replication_role = 'replica'` has triggers off, which is how a restore
// runs. It refuses SQL NULL, JSON null, `0`, `false`, `"off"`, a non-integer hour, any widening past
// 07:00-21:00, and — the subtle one — a window that never opens: `{"startHour": 21, "endHour": 21}` is
// inside the ceiling by both bounds and permits nothing, which holds every promotional message for ever with
// nothing saying why, so it is quiet hours switched off by starvation rather than by a setting. `case`
// rather than `and`, because SQL does not guarantee `and`'s evaluation order and the cast would raise on
// the very value the predicate exists to refuse politely (0080 found that). NOT strict, because a strict
// function returns NULL for NULL and a CHECK whose expression is NULL is SATISFIED. The figures 7 and 21
// are written down here and nowhere else in SQL: the alternative is an `app_setting` row holding the
// ceiling, which is a switch for the ceiling, and a ceiling that an UPDATE can raise is not a ceiling. They
// are NOT provisional and no OPEN-QUESTIONS id covers them — 07:00-21:00 is TDRA's restriction, which is
// why `messaging.promotional_window` deliberately does not appear in the Unconfirmed Assumptions panel.
// What is provisional is the Ramadan NARROWING (`Y9-ramadan-window`, provisionally 10:00-16:00), held as
// dated `business_calendar` rows an admin states because Ramadan's dates are announced by an authority and
// are not a value this build may invent, and the staleness ceiling on a held promotional message
// (`Y9-queued-staleness`, provisionally 12 hours), which is a constant in `@berelax/core`. `ZX006` is its
// one private SQLSTATE. It was `ZX001`, chosen here because `ZX` looked unowned while `ZW001` was known to
// be raised by BOTH 0080 and 0081 — and `ZX001` was 0086's attendance rule, taken in a worktree this one
// could not see, so the paragraph naming the collision it was avoiding created another. 0099 moved this
// side to `ZX006` and `packages/db/src/sqlstate-registry.ts` is what now answers "is this code free".
//
//
// 85 is 0085_data_subject_rights.sql: the five rights as a policy engine with a deadline and an audit
// trail, and the erasure/retention conflict resolved with neither side silently winning. The tables are
// `rights_request` (the subject, the type, the instant it was received, the SLA it was taken under, the
// derived due instant, the verification method and the lifecycle), `rights_resolution` (one per completed
// request: which regulatory_profile VERSION decided it, the pseudonym the identity became, the regime and
// that the regime is an assumption, the OPEN-QUESTIONS ids that would change it, the stated position on
// backups, and whether the written response could be issued), `rights_resolution_class` (per table and
// column: the rows that were there, the rows acted on, the rows retained and why), `rights_export` (with
// the subject count that drives docs/06 D4's insider-threat alert) and `legal_hold`. The claim of the whole
// file is one CHECK: `rows_before = rows_acted + rows_retained`, so an erasure that could not account for a
// row cannot store its own report and the refusal rolls it back inside its own transaction — 0069's
// `merge_record_table` argument applied to the operation whose defects are quieter still, because a merge
// that leaves rows behind surfaces as a record nobody reads and an erasure that leaves rows behind surfaces
// as a message to somebody who asked to be forgotten. A retained row needs `retained_reason`, and
// `retain_statutory` additionally needs the profile COLUMN naming the obligation and the figure, so no
// years number is ever a literal. `rights_request` freezes the columns an SLA is measured against (ZY002)
// and permits only the transitions the policy declares (ZY003), because a request answered on day forty is
// compliant if `received_at` can be edited and nothing about the row would look wrong afterwards. Erasure
// of the CRM identity is a PSEUDONYM in `customer.phone_e164`, which had to widen that column's E.164 check:
// every value matching it is a plausible phone number and a plausible number may be a real stranger's, so
// the pseudonym is `erased-` plus 32 letters from a to p — digit-free, so `phone_match_key` derives to the
// empty string and an erased record can never surface as a merge candidate — tied to `erased_at` by
// `customer_erasure_and_pseudonym_agree`, which refuses both halves of the disagreement and whose second
// half IS this unit's defining failure: a real number still in place on a record marked erased. Clinical
// data is crypto-erased through `public.destroy_customer_deks`, SECURITY DEFINER because 0009 revokes the
// clinical schema from the application role, refusing (ZY006) unless an `in_progress` erasure request names
// that customer — so a bug cannot shred a clinical record, because a bug does not first insert a request
// saying it may. It is in `public` and not in `clinical` because EXECUTE on a function also needs USAGE on
// the schema holding it, and granting `berelax_app` usage on `clinical` would make "the application role
// holds no privilege on the clinical schema" stop being literally true — without letting it read a table,
// so it would have been a weakening no test could see. The destroyed marker is a ZERO-LENGTH `wrapped_data_key` (a real one is always 60 bytes), and a
// CHECK asserting that length was written and REMOVED: `intake.itest.ts` inserts one-byte placeholder keys
// in the cases that prove C-CRM-08's consent gate and version guard, and a CHECK fires before both, so two
// of that unit's passing tests would have failed with this file's error instead of the one they assert.
// `clinical.dek_destruction` is the authority instead. `ZY` is this file's private SQLSTATE prefix, and it
// is the SECOND one this file had. It was written as `ZA`, on the reasoning that ZB through ZW were taken
// and that a unit continuing the alphabet from ZW would reach for ZX next — sound reasoning that still
// collided, because 0084 was a held allocation in another worktree at the time and had taken ZA for
// itself. Nothing either unit could read said so. The merge is where it became real: `ZA001` stood for
// "this flag row claims a template version its source submission does not have" AND for "rights_request
// refuses DELETE", and `ZA002` for "this flag cites another customer's submission" AND for "a frozen SLA
// column changed" — two pairs of unrelated rules under one code each, which every translator in
// `packages/db` matches on alone. `packages/db/src/sqlstate-uniqueness.test.ts` caught it on the first run
// after the merge, which is the whole reason it exists. This file's eight codes moved to ZY001-ZY008
// rather than 0084's two, because 0084 merged first and its codes are asserted by C-CRM-09's suite; the
// move is a rename within one file's own family and changes no rule. ZZ is now the last free class, so the
// convention that a class identifies a FILE has one allocation left in it — W-SYS-12 owns replacing it
// with an allocator. That sentence was true when it was written and 0091 is where it stopped being true:
// see the ZY011-ZY014 paragraph below, which took a SUBCLASS RANGE rather than the last class, on
// W-SYS-12's provisional answer. ZZ is still unspent.
//
// 90 is 0090_admin_session.sql: the admin session's storage — `staff_credential`, holding what a member of
// staff signs in with, and `staff_session`, the row a cookie names. It is W-SYS-11's, the unit that exists
// because 56 manifest references deferred the whole admin estate to W-SYS-01, a `done` unit that never owned
// a session. `staff_credential` REFERENCES an existing `employee` row rather than introducing a second
// answer to "who is this member of staff" — the seam B-AVAIL-04's NOTE hands every later unit and 0050
// already took. `staff_session` holds the SHA-256 of the 32 random bytes the cookie carries and NO ROLE, and
// that absence is the whole design: a request's role is reached only by joining a live session to its
// credential, so a tampered cookie names nothing rather than asserting something, a demotion takes effect on
// the next request with nothing to invalidate, and there is no representable state in which a session's
// authority disagrees with its credential's. A signed cookie carrying `{role}` would need neither table and
// would lose all three (ADR 0039). NO ROW IS SEEDED in any environment: `Y8-staff` is open, so a seeded
// admin account would be an invented person with an invented password (brief rule 15) and the account
// nobody rotates because nobody knows it exists — a deployment with no credential row refuses every login,
// and there is deliberately no bootstrap account, no `APP_ENV` branch and no environment variable standing
// in for a row. The TOTP seed is in a readable column and the migration header says why it is not sealed
// under `STAFF_PII_KEK`: 0050 records that `scripts/rotate-kek.mjs` cannot rotate the staff estate, so
// sealing an authentication secret there trades a readable column for an unrotatable one and makes that key
// a hard dependency of logging in at all. Both tables are revoked from `berelax_readonly` at TABLE level,
// because a column-level REVOKE does not subtract from a table-level grant — the fact 0050 paid to learn. It
// raises NO private SQLSTATE and takes no class, which is deliberate given that ZZ is the last one free: a
// session lookup needs no private code, because every refusal it makes is a row that is ABSENT rather than a
// rule that fired.
//
//
// 91 is 0091_flow_run.sql: the run, the idempotency key, and the step log that answers one question in one
// query (C-AUTO-07). 0070 built the flow, its immutable versions and the enrolment pin and stated in its own
// header what it was not building -- "No interpreter state. `flow_run`, the step log, the idempotency key and
// the execution cap are C-AUTO-07's" -- so nothing here re-argues the pin, and the paragraph above that used
// to say those three were deliberately absent has been corrected rather than left to read as still true.
// Three tables. `flow_run` is where an enrolment has got to, and is also where a DRY RUN lives with no
// enrolment at all: making a projection the same table is what stops the dry run being a second interpreter,
// and `flow_run_live_run_is_an_enrolments` states the biconditional so neither reading can drift into the
// other. `flow_node_effect` is the acceptance line's UNIQUE constraint on (flow_run, node, channel, contact)
// and carries nothing else -- no outcome, no message id -- because it is a TOKEN: the handler inserts it with
// `on conflict on constraint flow_node_effect_once_per_contact do nothing returning id` BEFORE it calls a
// transport, and reads the absence of a returned row as the typed `duplicate` outcome, which is a value
// derived from the constraint rather than a caught exception whose message happened to mention uniqueness.
// `flow_step_log` is the evidence, and `definition_version` is DENORMALISED onto it deliberately: "why did
// this contact get this message" has to be one SELECT with no join, so the version, the node id, the resolved
// `consent_record_id` and the `gate_decision` are four columns on the row, and
// `flow_step_log_pins_a_definition_version` -- the same composite foreign key `flow_enrolment` carries -- is
// what keeps the denormalised number a version that was really published.
//
// The execution cap is a COLUMN and not a constant in SQL. `max_node_executions` is NOT NULL with no
// DEFAULT, so the writer supplies `MAX_FLOW_NODE_EXECUTIONS` (200, provisional, and written once in
// `@berelax/shared`); what the database states is the RELATION, `flow_run_executions_within_bound`, so a run
// that executed one node past its own ceiling cannot be stored whatever the worker believed. A DEFAULT here
// would have been a second statement of a provisional figure, and a run halted under one ceiling and
// reported against another is unanswerable. The same reasoning is why `flow_enrolment.ended_reason` stays
// `text`: FLOW_END_REASONS is DERIVED from the DSL's own exit reasons plus the interpreter's halts, so an
// enum would be a third statement of an already-computed list and would be the thing refusing to store the
// ninth exit reason somebody draws. The three vocabularies that ARE enums -- `flow_run_mode`,
// `flow_run_status`, `flow_node_outcome` -- are compared against their `@berelax/shared` lists through
// `pg_enum` in both directions by `apps/worker/src/automation/interpreter.itest.ts`, which is what makes two
// vocabulary safe rather than latent.
//
// A DRY RUN leaves nothing behind, and that is the database's claim rather than the worker's care:
// `refuse_dry_run_side_effect` raises ZY003 for any `flow_node_effect` insert under a dry run and for a
// `flow_step_log` row naming a message, for every role including the owner. So the suite's "exactly zero
// message rows" assertions measure a rule a `psql` session meets too.
//
// `flow_enrolment` gains a partial UNIQUE index here, `flow_enrolment_one_active_per_contact` on
// (flow_id, customer_id) where `ended_at is null`, and it is where two acceptance lines meet. "Enrolling the
// same contact twice in one flow yields one active enrolment" is a dedupe the enrolment writer performs;
// "a contact merged mid-run continues on the survivor exactly once" is a MERGE, which goes nowhere near that
// writer -- `mergeCustomers` issues `update flow_enrolment set customer_id = survivor`, and with nothing to
// refuse it the survivor would hold one flow twice and be sent every node twice. The predicate is
// `ended_at is null` rather than `status = 'active'` because the two are the same set (0070's
// `flow_enrolment_ended_matches_status` is that biconditional) and because `MergeParticipant.activePredicate`
// admits `<column> is [not] null` and nothing wider -- a predicate grammar wide enough to be useful is wide
// enough to carry a subquery into `sql.unsafe`.
//
// It also changes two of 0035's constraints, and only because the caller finally exists. `message
// .last_failure_reason` gains `stale_outside_window`: C-AUTO-04 decided against adding it and said why --
// "the value would be unwritable by anything, and a vocabulary with no writer is a CHECK five other units'
// probes depend on, edited for a caller that does not exist" -- and the release job this unit adds is the
// first thing in this build that moves a held message, so the value arrives with its one writer.
// `message_sent_counts_an_attempt` is relaxed in the same breath and only for that value: an expiry is a
// message that never left, so it has no attempt at all, and the original constraint would have made the
// honest row unstorable. A `sent` row with zero attempts is still refused, which is what gate case 39c
// measures and which is the rule that constraint was written for.
//
// Four private SQLSTATEs, and they are `ZY011`-`ZY014` because the CLASS no longer identifies a file.
// This paragraph was written twice. The first version argued that ZY was free, on the reading
// `sqlstate-uniqueness.test.ts` supported at the time -- ZA through ZX taken, thirteen codes already standing
// for two unrelated rules each, ZY and ZZ left -- and took ZY001-ZY004. By the merge that reading was false
// in three directions at once: 0085 had moved its eight codes to ZY001-ZY008 (its own header records why),
// and two further units in flight had reached for ZY001 as well. Four migrations claiming ZY001 is precisely
// the failure the convention existed to prevent, restated one level up: it is not the code that was scarce,
// it is the CLASS, and a convention that hands out 26 of anything across 90-odd migrations runs out.
// So the replacement, which is W-SYS-12's provisional answer taken as the strictest safe reading of the
// question its own manifest entry poses: a refusal is identified by all FIVE characters, two unrelated rules
// may share a class as long as they never share a code, and a unit takes a SUBCLASS range rather than a
// class. This file's range is ZY011-ZY014, allocated by the integrator against the ranges other units in
// flight already hold, and it deliberately leaves ZY001-ZY008 to 0085 and ZY015 onward to the units that
// asked before this one. ZY011 a flow_step_log row was UPDATEd or DELETEd; ZY012 a flow_node_effect row was
// DELETEd or UPDATEd in any way but a merge re-pointing its contact; ZY013 a dry run tried to leave a side
// effect behind; ZY014 a run's mode or enrolment changed. Four and not one because each has a different
// runbook answer, which is the whole argument for a private code (0061's, restated); the argument for a
// private CLASS is over, and W-SYS-12 owns the allocator that makes the new rule enforceable rather than
// agreed.
//
//
// 93 is 0093_publication.sql: nothing reaches the public without a lint pass, a named approval against a
// content hash, and an append-only record — and none of those four facts is a promise a caller keeps
// (W-SITE-10). Three of the four halves already existed and were correct: `access/publication.ts`
// authorises a publication, `packages/cms/src/publication.ts` lints CMS copy against the profile in force,
// and `apps/web/src/media/publish-gate.ts` refuses a slot image over its byte budget. What no layer held was
// the SEQUENCE — nothing recorded that a lint had passed, nothing recorded who approved WHAT, and nothing
// stopped a row reaching a published state without either. The tables are `publication_lint_pass` (the
// surface, the sha256 of exactly what was linted, WHICH `regulatory_profile` version decided it, and how
// many terms the pass actually compared against — `> 0`, because a lint over an empty vocabulary passes
// everything and a row recording it would be evidence for a check that examined nothing),
// `publication_approval` (the approver's id with their display name and role SNAPSHOTTED beside it, so a
// later rename cannot rewrite who approved what) and `publication_record` (one appended row per state, the
// weight the publish-time check measured and the budget it judged against, and `supersedes_id` for a
// correction or a revert). Four layers make the claims properties of the database rather than of the
// caller: a CHECK — `publication_record_published_needs_evidence` — because it answers an UPDATE as well as
// an INSERT and still answers when a restore has triggers off; COMPOSITE foreign keys
// `(lint_pass_id, content_sha256)` and `(approval_id, content_sha256)`, so approving or publishing content
// whose hash differs from the linted or approved content is `23503` naming a constraint rather than a
// trigger somebody can disable, and cannot be satisfied by editing the parent because the parent is
// append-only; a BEFORE INSERT trigger for the ORDERING, which a CHECK cannot express because it cannot
// read the previous row; and a `deferrable initially deferred` constraint trigger for the audit row, which
// is 0081's ZW003 shape and is what makes "every publish writes an audit_event IN THE SAME TRANSACTION"
// unfalsifiable — an audit row written afterwards in a second transaction does not satisfy it. The file
// also inserts one new `regulatory_profile` version, appending `clinic` to `banned_claim_terms` and copying
// every other column FROM the row in force rather than restating it (`opening-balances.itest.ts`'s lesson):
// 0004's list was written for service display names, where the word cannot appear, and the lexicon's
// stemmer stops at plurals and `-ing` on purpose, so `clinical` does not match `clinic`. `ZZ001`
// (append-only), `ZZ002` (a state that does not follow the one before it), `ZZ003` (a correction naming no
// superseded record, the wrong one, or another surface's), `ZZ004` (a published record with no audit row at
// COMMIT) and `ZZ005` (over the weight budget, with both numbers in the message) are its private
// SQLSTATEs. `ZZ` because it was the LAST free class: 0099 is what replaced the convention that made a
// class scarce, and `packages/db/src/sqlstate-registry.ts` is where a code is taken now.
//
// 92 is 0092_leave_approval.sql: approving leave — who may decide it, what it costs the floor, and what it
// may never do to a booking. It is the first writer of `leave_request` in the build. 0030 created the table
// and left ONE decision to P-HR, and 0066 took it in `leaveCoveragePeriod()` while saying in its own header
// that "writing and approving that period is P-HR-09's"; until this file nothing had written one, which is
// why the trading-day alignment finally has a caller. The consequence a reader meets first: a day of leave
// on the 17th is stored as 11:00 on the 17th to 02:00 on the 18th, so the 01:30 appointment in the tail is a
// REPORTED CONFLICT rather than a booking somebody discovers on the day. No arithmetic for that is in this
// file or in the SQL — ZY019 compares the approval's period against the request's, which is a comparison and
// not a second derivation, for the reason 0066 gives: `resolveTradingDate` is the one reading of where a
// trading day ends. What the file deliberately does NOT do is three things. It stores no CONFLICT REPORT:
// the report is a read recomputed on every attempt, because a stored one is a snapshot of a world a
// reassignment has since changed and the approval would then commit against rows nobody looked at; what is
// stored is the one thing a read cannot recover, the DECISION a human took about a conflict they chose not
// to resolve (`leave_conflict_override`, whose role and reason are refused by ZY016 rather than by a
// TypeScript guard alone, so the refusal holds for a `psql` session — 0080's division of labour). It moves
// NO LEAVE BALANCE, because 0066 is explicit that a request reserves when it is MADE and approval only makes
// the reservation final; the reservation belongs to the submission path, which is P-HR-14's, so this unit
// writes neither a `reserved` nor a `released` movement — symmetrically, since a release with no reservation
// creates leave out of nothing, which `decideRequest` in @berelax/core refuses. And it TOUCHES NO
// APPOINTMENT: that is ADR 0041, and the proof is not a promise but an enumeration out of the source —
// `packages/fixtures/src/hr-leave-approval.test.ts` walks the modules reachable from the approval entry
// points, collects every appointment status any of them can write, and asserts `cancelled_by_salon` and
// `no_show` are not among them, with the same scan shown firing over `cancel.ts` so an empty answer means
// something. `leave_coverage_lock` is the table that looks unnecessary and is not: two approvals for two
// DIFFERENT therapists on one day conflict on no row, so each transaction reads a floor that still holds the
// other therapist, both coverage checks pass, and the floor ends up short with every check having said yes.
// `approveLeaveRequest` takes `select ... for update` over one row per trading date in ascending order, so
// the second transaction BLOCKS, re-reads `employee_approved_leave` and is refused BY THE COVERAGE CHECK
// inside the transaction — which is the acceptance line's own wording, and why a row nobody can see would
// have been the wrong mechanism (ADR 0023's row-locked counter is the precedent). The coverage answer itself
// is P-HR-06's `validateRota` called TWICE over identical arguments bar the leave, and the refusal is the
// set DIFFERENCE: the segments covered without this leave and not with it. An absolute reading would refuse
// every approval on any database whose `shift` table is empty, which is every seeded one, and it would name
// a segment the requester cannot do anything about. `leave_approval` snapshots the `rota_coverage_rule`
// version that judged the floor, which is 0081's argument taken a fifth time and exactly as true here: "was
// the floor covered when this leave was approved?" is a question about a decision taken months ago, and
// raising the minimum in April must not make March's approval retroactively wrong. Withdrawing an approval
// is a `leave_approval_cancellation` row rather than a column, because the approval table is append-only for
// the same reason as the rest, and `leave_approval_live` is the view that joins the two — `employee_approved_leave`'s
// precedent (0030): a predicate held in a view cannot be forgotten, and forgetting this one shows a
// therapist as blocked after their holiday was withdrawn. Its private SQLSTATEs are `ZY015` through `ZY020`,
// and the allocation is worth reading because the CONVENTION changed under it. "One private class per
// migration" has run out — `ZA` through `ZY` are in use and `ZZ` is another unit's — and this file first took
// `ZY001`-`ZY006` on the reasoning every previous file used: read the migrations you can see, take a class
// nobody raises. Three other units reasoned identically in the same week, and `0085` had already moved its
// eight codes INTO `ZY` after it and `0084` both landed on `ZA`. Four migrations claimed `ZY001` at once. So
// the rule is now W-SYS-12's provisional answer — a refusal is identified by all FIVE characters, and two
// unrelated rules may share a class as long as they never share a code — and `sqlstate-uniqueness.test.ts`
// was already keyed on the exact five, which is what makes the new convention checkable rather than a hope:
// a shared class is not a finding, a shared code is. What has not changed is why: a code standing for two
// rules makes one file's translator report the other file's refusal, and makes a probe asserting it pass
// when the statement bounced off something else.
//
// 99 is 0099_sqlstate_reallocation.sql: one private SQLSTATE, one rule (W-SYS-12). The file creates no
// table, column or constraint. It `create or replace`s nine trigger functions and changes exactly one token
// in each — the five characters the refusal carries — and re-issues three of 0077's table and column
// comments that named an old code.
//
// The convention it replaces was that a private CLASS identifies a migration file. That ran out: 26 classes
// across 90-odd migrations, 0093 taking the last free one, and — the failure that actually cost time —
// units in flight cannot see each other, so four migrations claimed `ZY001` in one afternoon and thirteen
// codes each stood for two rules. A code standing for two rules is not untidy: every translator in this
// package matches on the code ALONE, so one file's refusal is reported as the other's with a plausible
// message and the wrong cause, and a probe asserting the code passes on a statement it never touched.
//
// So the class stops identifying a file (ADR 0043): a refusal is identified by all FIVE characters, two
// unrelated rules may share a class and may never share a code, and `sqlstate-registry.ts` allocates them
// with one entry per code naming the rule, the migration whose LIVE definition raises it, the functions that
// raise it and the translators that report it. `pnpm sqlstate` proves every field but the rule sentence
// against the migrations themselves, in five directions: two entries on one code, a raised code with no
// entry, an entry no migration raises (which is what lets the registry SHRINK), an entry that disagrees
// with the tree, and a code raised from two migrations' live definitions.
//
// Nine of the thirteen were two different rules and moved here, each to the next free subclass of the class
// it already sat in: `ZT005`-`ZT007` for 0069's merge record, survivor-is-live and chain bound (0068 keeps
// `ZT001`-`ZT003`); `ZU008`-`ZU010` for 0077's card move, transition log and gapless positions (0076 keeps
// `ZU001`-`ZU003`); `ZW006`-`ZW007` for 0081's published rota and change request (0080 keeps
// `ZW001`-`ZW002`); and `ZX006` for 0087's promotional window (0086 keeps `ZX001`). The later migration
// moved in all nine, which is not a coincidence — the second unit to reach for a class is the one whose
// worktree could not see the first.
//
// The other four were never collisions, and finding that out is what the measurement bought. ZB001, ZB002,
// ZL002 and ZV002 are ONE rule each whose function was later `create or replace`d — `assert_room_capacity`
// and `assert_room_capacity_covers_commitments` in 0038, `raise_if_period_locked` in 0073,
// `assert_bill_totals_match_lines` in 0039 — so the earlier file's `raise` is dead text that can never
// execute. The detector they were listed in keyed on which FILES contain a code, which cannot tell a
// superseded definition from a second rule; the check now resolves every raising function to its live
// definition first. 0069, 0077, 0081 and 0087 are deliberately NOT edited: a numbered migration is a record
// of what was applied, the live definition is what the gate reads, and a future file replacing one of these
// functions back onto its old code fails `pnpm sqlstate` rather than quietly re-creating the collision.
//

//
// 94 is 0094_review_fallback_intake.sql: the forwarded notification that could not be read, and the Places
// aggregate the count tripwire compares against (G-REV-02). Two tables, and the argument for each is that
// neither thing it has to remember is a REVIEW. A forward nothing could parse has no rating, so it could not
// satisfy `google_reviews.rating` (NOT NULL, 1-5), and inventing one to make it fit is the guess docs/12 §1
// forbids in its worst form — a one-star review filed at four stars is auto-send eligible under docs/07 §4.
// So `review_intake_email` holds the BYTES and nothing interpreted, with a closed two-value status
// (`parsed` | `needs_paste`) because a third outcome would be a state nothing decides: the parser returns one
// of two shapes. And an aggregate reading is not a review either — it is two numbers about the listing whose
// only value is that yesterday's are still there to compare against, which a column on `google_capabilities`
// would hold and lose. `google_place_aggregate` therefore has no text column AT ALL, which is what turns the
// acceptance line's scan — none of those review bodies appears in any table — into a property of the SCHEMA
// rather than a promise about the adapter, and it is the strictest safe reading of the caching terms docs/10
// §6 marks unverified (the ADR this file cites for that is the one renumbered to 0049 at merge).
//
// It takes NO private SQLSTATE, and said so in a header written before W-SYS-12 landed: the refusals here are
// ordinary `check_violation`s, and the ones that need a name are raised in application code and asserted by
// name (`PLACES_ANSWERED_ABOUT_ANOTHER_PLACE` in `packages/google`, the parse refusals in
// `packages/core/src/reviews/email-parse.ts`). It is the last file written under the convention that a
// private CLASS identifies one migration, and the only one of the seven in that wave that declined to spend
// the last class — which is the reasoning 0099 replaced with a registry.
//
// Its two `agent_definition` rows are the first crons in this build whose subject is something that happened
// OUTSIDE the system: the tripwire reads the Places aggregate daily and reports an increase, the nudge
// reports a week of silence on a Monday. Separate agents rather than one, for 0033's reason — a shared
// heartbeat would be minutes old for ever and would make a dead weekly pass invisible behind a healthy daily
// one — and their declared intervals (24 hours, 7 days) are what give the watchdog's "no success within
// twice the interval" something to mean for each.
//
// 95 is 0095_vat_return.sql: the VAT return as a SEALED SNAPSHOT — the figures as bytes, a hash over exactly
// those bytes, two named signatures from two different people, and no way to edit any of it (M-VAT-08).
// M-VAT-07's working papers are a FUNCTION OF THE LEDGER, recomputed on every read, which is right for a
// working paper and wrong for a filed return: a return is a statement made on a date about a period, and the
// one thing it must not do is change when the ledger behind it does. So `vat_return` stores `snapshot_json` —
// exactly the bytes `canonicaliseVat201WorkingPapers()` produced — and
// `content_hash = encode(sha256(convert_to(snapshot_json, 'UTF8')), 'hex')` as a CHECK, which is the same
// value `vat201ContentHash()` computes in TypeScript over the same bytes. That CHECK does not claim the bytes
// are what the ledger said, and the header says so: what claims that is
// `services/vat-return-signoff.itest.ts`, which regenerates the papers with the clock five years on and
// requires the hash back identical.
//
// **The figures are VIEWS over those bytes and not a second table**, which is the one decision in this file
// worth arguing with. `vat_return_box_figure` and `vat_return_not_fileable_reason` read
// `vat_return.snapshot_json` and touch nothing else — no `journal_line`, no `vat201_box_total()` — so a figure
// cannot move when the ledger does, and gate case 122t asserts that over the view definitions with a fixture
// that plants a join to `vat201_box_line`. A box TABLE was written first and is worse in the way this build
// keeps paying for: a second statement of a fact drifts, nothing in SQL can prove two copies of a figure
// agree, and the copy that disagrees is the one a screen reads while the hash still verifies the other. It
// also needs three rules the view needs none of — a refusal for a row appended to a sealed return in a later
// transaction, one for a figure that is not the figure in the hashed bytes, and one for a snapshot committed
// with no rows at all. The cost is that a view carries no index, which is nothing here: a VAT return is
// quarterly and every read names one id. Seven scalar columns are duplicated between the row and the bytes on
// purpose — a return is looked up by period and a `psql` session should not have to parse JSON — and two
// CHECKs compare each one against its own value inside the snapshot, so the duplication is refused the chance
// to drift rather than merely discouraged.
//
// `fileable` is the trap this unit could most easily have walked into and it is shut by a CHECK, not by a
// service: `vat_return_fileable_only_when_nothing_in_it_refuses_filing` reads the HASHED BYTES, so `true` is
// impossible while the snapshot carries a `notFileableReasons` entry or a box marked `isProvisional`. Every
// box is provisional today ([UNVERIFIED] Y11-vat201-boxes, and Y11-tax-agent records an FTA-registered
// agent's review as not optional), so the answer is always false and the row says why. The GENERATING CODE
// VERSION is two columns and neither is a number anybody typed: `format_version` is the canonical form's own
// tag from the paper, and `engine_signature` is `vat201_engine_signature()` — the sha256 of
// `pg_get_functiondef()` over the seven SQL functions that compute a VAT201 figure, which raises `ZY056` when
// the catalogue holds a different number of them than the list names, because a hash of six definitions out
// of seven would be quietly wrong in the one column whose job is to differ when the code differs.
//
// Sign-off is `vat_return_sign_off`, one row per capacity, and PREPARER AND REVIEWER ARE TWO DIFFERENT PEOPLE
// refused in the database: `unique (return_id, signatory_user_id)` is the storage layer that survives a
// restore with triggers off, and `ZY052` (`SamePersonSignOff`) fires first and names the person and the
// capacity they already signed in — 0093's two-layer pattern, for 0093's reason. The signatory's display name
// and role are SNAPSHOTTED beside their id so a later rename cannot rewrite who signed (0026's argument,
// `publication_approval`'s shape). Who MAY sign is `vat_return_signing_roles()`, a function rather than a
// literal inside the CHECK so the list can be READ from outside it:
// `packages/fixtures/src/vat-return-signoff.itest.ts` requires it to equal the roles holding
// `vat_return:prepare` in `core/src/access/permissions.ts`, for all eight roles individually, which is the
// only thing stopping the two drifting — `packages/db` may not import `packages/core`, so nothing compiles
// them against each other. Deny by default: manager, receptionist, therapist, marketer, auditor and system
// are refused by absence, with `ZY053` naming the role and the permitted set.
//
// `vat_return_finalisation` is the row a filing cites and `ZY055` refuses it unless both capacities have
// signed; `vat_return_for_filing()` raises the same code, so the refusal reaches a READ as well as a write
// and M-VAT-09's one-way export cannot be built without coming through it. Both read
// `vat_return_sign_off_state()`, the ONE reader of "is this signed" — `periodStatusOn`'s arrangement for "is
// this date closed", for the same reason. The base tables stay readable deliberately: a preparer has to be
// able to see the figures they are about to sign, and what is guarded is the door labelled FILING.
// `closed_period_id` is a plain column and NOT a foreign key to `period_lock`, which is 0086's releasable-pin
// test rather than a shortcut — a lock CAN be deleted and four suites delete their own, while a `vat_return`
// row can be deleted by nobody, so a reference from here would pin every lock it names for ever. `ZY051`
// (append-only, every role including the owner), `ZY052`, `ZY053`, `ZY054` (an amendment that is not the next
// version of the period in force, describes another period, or forks a superseded one), `ZY055`, `ZY056` and
// `ZY057` (a signature or a finalisation with no `audit_event` at COMMIT, 0081's ZW003 and 0093's ZZ004
// shape) are its private SQLSTATEs — band `ZY051`-`ZY057` of a class that no longer identifies a file, with
// `ZY058`-`ZY060` left free rather than taken and unused.
//
// 96 is 0096_analytics_schema.sql: the `analytics` schema, its monthly partitions, and the 90-day raw
// retention as a thing that RUNS (A-FIRST-01). Nine tables — `visitor`, `session`, `event`, `funnel_step`,
// `attribution`, the three daily rollups and `retention_policy` — with `event` and `funnel_step` RANGE
// partitioned by month on `occurred_at`. `whatsapp_ref` is NOT among them although the unit summary lists
// it: 0079 already created `public.whatsapp_ref`, whose `session_reference` is documented there as
// "A-FIRST's opaque handle for the conversation", and a second one would be a second statement of one fact.
// Four things in it are worth knowing before reading it. **There IS a default partition on each raw
// parent**, against 0005's advice and for 0005's reason: measured on PostgreSQL 16, a row is ROUTED before
// any row-level trigger fires, so tuple routing raises `23514 no partition of relation "event" found for
// row` before a guard on the parent could run — a guard that is unreachable code on exactly the day it is
// needed. Each raw parent therefore has a default partition whose BEFORE INSERT trigger raises `ZY061`
// naming the month, the parent and `analytics.ensure_partitions()`, and stores nothing, so there is no row
// in it for anybody to forget to prune. **`analytics.retention_policy` is load-bearing**: one row per base
// table in the schema, and `analytics.run_retention` REFUSES the whole pass on a table with no row
// (`ZY062`) or a row for a relation that is not there (`ZY063`) — the same two directions C-CRM-10's
// erasure registry is checked in — which is what makes the three rollups' exemption an explicit list rather
// than an omission. **A partition's upper bound is only readable as the TEXT of
// `pg_get_expr(relpartbound, …)`**, so `analytics.partition_bounds` parses it and raises `ZY064` on a bound
// it cannot read rather than skipping the partition: a parser that stopped matching would make every
// partition look un-droppable and the pass would report success having dropped nothing. **And
// `analytics.event` is append-only for every role but `berelax_retention`** (`ZY065`), by two BEFORE
// triggers declared on the partitioned parent so PostgreSQL clones them onto every partition — a direct
// `delete from analytics.event_2026_09` is refused too, which a grant on the parent alone would not do; the
// refusal tests `current_user` by NAME rather than `pg_has_role`, because `berelax` is a superuser and
// `pg_has_role` answers true for it. `ZY066` is the negative look-ahead that would create nothing while
// reporting success. The file adds no customer or booking reference anywhere in the schema and no IP
// address or user-agent string, both deliberately and both recorded in its header: a `customer_id` here
// would enter C-CRM-05's merge registry and C-CRM-10's erasure catalogue with no unit owning the decision,
// and A-FIRST-08's acceptance line is what names it. Its private SQLSTATEs are `ZY061`-`ZY066` from the
// band W-SYS-12's allocator handed this unit; `ZY067`-`ZY070` are still free within it.
//

//
// 97 is 0097_hr_commission.sql: a commission figure that cannot be recomputed into a different answer
// (P-HR-11). The subject is narrower than it sounds — anybody can compute a commission; what a therapist
// disputing a payslip needs is that the same period computed again comes back byte-identical — and four
// tables make it so. `commission_rule` is one published, IMMUTABLE version (which figure a percentage
// applies to, and how it rounds) with `commission_rule_band` holding its rates as ordered rows, so one band
// from zero is a flat percentage and several ascending bands are a tiered one. `commission_run` names the
// version that judged it (NOT NULL) and carries `source_as_of`, the instant the source figures were READ
// at; `commission_line` pins the SAME version through a composite foreign key rather than through a second
// column somebody keeps in step. Four refusals make the claims properties of the database rather than of
// the program that wrote the rows: ZY071 and ZY072 refuse every UPDATE and DELETE for every role including
// the owner, so a rate that is wrong is a new VERSION and a run that is wrong is a new RUN; ZY073 holds a
// version's bands to covering the value range from zero upwards, so "some band applies" is true by
// construction and the engine has no unanswered case to invent behaviour for; ZY076 refuses a run over a
// closed accounting period whose `source_as_of` is not the lock's own `locked_at`, which is the whole trap —
// a payment applied after the close, or a sale backdated into a filed month, is correct arithmetic over
// facts that postdate the payslip; and ZY077 holds every line's band, rate and figure to
// `commission_fils_for()`, the arithmetic in SQL, mirrored by `commissionFilsFor` in `@berelax/core` and
// held equal to it over a census for the reason 0083 gives about `package_release_through_fils`. ZY074 is
// the deferred trigger holding the run header to its lines, which is what makes the `commission_derivation`
// view's "rows summing exactly to the header total" a claim about two independent figures rather than about
// a sum agreeing with itself. **NOTHING IS SEEDED**, unlike 0059, 0066, 0081 and 0086: there is no law
// about commission and no figure in the handover, Y9-commission's provisional answer is "none configured;
// the module ships disabled", and an empty table is therefore the strictest safe option — with no version
// published the engine produces zero lines and nothing can be paid at a rate nobody chose. The module being
// off is `hr.commission_enabled` in the settings registry, `false` and flagged provisional, so it appears on
// the Unconfirmed Assumptions panel rather than being a fact only the code knows. Private SQLSTATEs
// ZY071-ZY077, a subclass range of the shared `ZY` class per 0091's rule; ZY078-ZY080 are unused.
//
// 98 is 0098_messaging_controls.sql: the marketing kill switch has ONE home, and no control row can ever name
// transactional traffic (C-AUTO-05). `messaging_control` holds one row per promotional operator control —
// `marketing_kill_switch` and `promotional_sender_suspended` — with `engaged`, the actor, the actor's role, the
// direction and the reason, which is exactly what the console renders and what the audit row must agree with.
// A TABLE rather than an `app_setting` row, and the argument is the one `agent_definition` already makes two
// tables along: *"a disabled agent is silent by design, a killed one is an incident, and the two want
// different audit stories"*. A toggle has a direction and a reason, and the tier system has no honest place
// for it — `compliance_locked` is owner-only through `assertRoleMayEdit`, which would stop the floor manager
// engaging the switch at 22:00, and `operational` would file "stop all marketing" beside a turnaround time.
// The sender-ID suspension is not a setting in any reading: nobody CONFIGURES a TDRA suspension.
//
// Both rows are SEEDED here, disengaged, so no reader needs a default for a missing row — a default in the
// reader is the second statement of the switch's state, and the default would be the permissive one.
// `readMessagingControls` therefore REFUSES a missing row rather than answering "disengaged". What is NOT
// stored is the provisional rule that the switch is engaged in every non-production environment: that is a
// property of `APP_ENV` applied by `resolveMarketingKillSwitch` in `@berelax/messaging`, and seeding `true`
// into staging's row would make it disengageable by an UPDATE that looks entirely legitimate.
//
// Two predicate functions, called from a CHECK and from a trigger apiece — 0080's and 0087's division of
// labour, because the reasons are the same: the trigger gives a human a sentence they can act on, and the
// CHECK is the layer that still holds under `session_replication_role = 'replica'`, which is how a restore
// from a dump runs. `messaging_control_is_promotional_only()` is the storage half of "the switch structurally
// cannot touch transactional traffic": there is deliberately no control key naming transactional traffic and
// this is what makes one unstorable rather than merely absent. `messaging_control_role_may_toggle()` restates
// `settings:write` — owner and manager — where SQL can read it, which is the ONE figure in this file that
// exists in two places, held equal behaviourally by gate case 126d rather than trusted (0087's arrangement for
// the window's ceiling).
//
// Four private SQLSTATEs, `ZY081`-`ZY084`, from the range this unit was allocated (`ZY081`-`ZY090`). `ZY081` a
// control key outside the closed set — worse than a missing row, because a missing row reads as "not engaged",
// so a misspelled key is a switch a screen shows as engaged and the gate never reads. `ZY082` a role that may
// not toggle, which is the layer that holds for a `psql` session, a seed, or an import of another
// environment's rows. `ZY083` a blank reason, refused by SHAPE before the role so the message says "this has
// no reason" rather than "not you". `ZY084` a DELETE, and it is the subtle one: removing the row is a
// DISENGAGEMENT that writes no audit event, because no UPDATE happened for one to hang off. Four codes and not
// one because each has a different runbook answer, which is 0061's argument for a private code at all; the
// CLASS identifies nothing any more, which is 0091's paragraph above and W-SYS-12's subject.
//
// 100 was allocated to W-SYS-13 and is not used. The unit is about what the SUITES may remove, not about
// what the schema holds: a scan that derives every unqualified `delete`/`truncate` in a test file and refuses
// one that is neither scoped nor declared, a derivation of the seeded tables from the loaders themselves, and
// an invariant wrapped round the integration run that reads the seeded rows before it and again after it. No
// table, column, constraint, trigger or private SQLSTATE. A DATABASE-level answer was considered and is the
// wrong shape twice over: `revoke delete on customer from berelax` would stop the fixture loaders too, since
// the seed runs as the owner, and an event trigger cannot tell a suite's own row from a seeded one — which is
// the whole distinction (ADR 0050). 100 is therefore released and NOT renumbered, like 22, 41, 44, 47, 71, 74
// and 88 before it, for the reason the paragraph below gives.
// 101 is 0101_private_document.sql: the register of every private document, and the fetch that cannot be
// replayed or lost (W-SYS-14). Two tables. `private_document` is one row per object in the private bucket —
// the class that decides who may read it, the storage key, the content hash that says which bytes it is, and
// the `use_policy` derived from the class. `private_document_fetch` is one row per authorised fetch, written
// in the SAME transaction as the authorisation, which is what makes "a download the trail is missing"
// unrepresentable rather than unlikely. The hole it closes is not abstract: `writeTaxDocumentPdf()` in
// `@berelax/pdf` took a `path` and called `writeFileSync`, so a filed tax invoice — issuer TRN, customer,
// every line and every figure — was readable by anybody who learned the path, and private storage had been
// DEFERRED by M-TILL-12 to M-TILL-13 and M-VAT-11, both of which went `done` without ever owning it.
//
// A REGISTER rather than a `storage_key` column on each producer's row, and that is the whole design
// decision. Five producers each with a private path is five routes, five permission checks and five chances
// that the sixth producer has none — which is what the deferral chain looks like after three units. One
// register means one route, one permission check read out of the authorisation matrix rather than copied, one
// audit action, and an answer to "what private documents does this business hold" that is a SELECT rather
// than a survey. There is deliberately NO `bucket` column: every row is in the private bucket by definition,
// and a column able to say `public` is a column somebody sets to `public`.
//
// Three private SQLSTATEs, `ZY111`-`ZY113`, from the range this unit was allocated (`ZY111`-`ZY120`);
// `ZY114`-`ZY120` are unused. `ZY111` a single-use link fetched twice — a payslip and a clinical extract are
// `single_use`, and the trigger takes `for update` on the register row before it looks, because a
// read-then-insert in TypeScript is two statements and two concurrent fetches of one forwarded link both
// pass the read. That lock is the reason the check is here and not in the repository, and it is 0023's
// row-locked counter used as a mutex rather than as a sequence. `ZY112` an UPDATE or DELETE on either table:
// the register is what an audited download NAMES, so a repointable storage key would make a recorded
// download name bytes that were never served, and the fetch log is the record that a copy left the business.
// `ZY113` a document class outside `PRIVATE_DOCUMENT_CLASSES` in `@berelax/core` — deny-by-default fails in
// the WRONG DIRECTION without it, because an unclassified document has no permission mapped to it and is
// therefore one nobody can fetch and nobody can notice is unfetchable. That closed set is the one figure in
// the file that exists in two places, held equal behaviourally by gate case 129j rather than trusted, which
// is 0098's arrangement for `settings:write`. Codes are allocated by
// `packages/db/src/sqlstate-registry.ts` and not by reading the migrations a worktree can see (ADR 0043).
//
// The fetch log is deliberately not `audit_event`, and it writes one anyway. `audit_event` is partitioned
// with a JSON `after`, so "has this nonce been burned" would be a JSON containment query on the hot path of
// every download and the uniqueness the replay defence needs could not be a constraint at all. This table is
// the CONSTRAINT; the audit row is the narrative.
// 105 is 0105_gateway_tender_type.sql: one row, and the decision it stands for (Y-PAY-01). The file creates
// no table, column, constraint, function or refusal code. It inserts `card_online` into `tender_type` —
// posting to `1030 Payment gateway clearing`, `adapter = 'gateway'`, requiring a reference, settling later —
// and that is the entire schema change this unit needs.
//
// 0068 designed the row and said so: its `adapter` column carries the closed set `('manual', 'gateway')`
// under the note "All three are `manual` today, which is the honest answer: the gateway does not exist. This
// is the column Y-PAY's types will differ on." 0018 seeded account 1030 in the same anticipatory spirit and
// nothing had debited it until now.
//
// What the row decides is whether the gateway port reuses the tender vocabulary or brings its own. The
// cheaper option was its own — a `PaymentMethod` enum on the port, which the H02 provider fakes already
// carry, and no migration at all. It is a second answer to "where does card money go", with a second
// posting-account map beside it, and a disagreement between the two does not present as a type error: it
// presents as a bank reconciliation out by every gateway batch, weeks later, with two plausible sources. So
// the port's instrument type IS `TenderKind`, there is one map from instrument to account, and this row is
// what makes `packages/fixtures/src/payment.itest.ts` keep holding the registry equal to `TENDER_ACCOUNT` in
// both directions once core declares the kind.
//
// 1030 and not 1040, though both clear card money that has not arrived: the terminal settles in batches
// against a merchant statement and the gateway pays out on its own schedule net of processor fees against a
// payout file. One account holding both streams reconciles against neither statement on its own, and the
// residue after matching one is indistinguishable from an error in the other.
//
// The row enables nothing on its own, which is deliberate. `finaliseCheckout` has no gateway call in it and
// no path to one; the adapters live in `@berelax/payments` and are constructed only by that package's
// registry; `PAYMENT_PROVIDER=real` is refused outside production by `parseConfig` (ADR 0005), so the only
// gateway any environment can reach is the H02 fake. The band `ZY151`-`ZY160` issued to this unit is left
// wholly unused: there is no new rule here to raise one, and ADR 0043's gate refuses an entry no migration
// raises.
// 104 is 0104_hr_payroll.sql: the run that cannot be edited after it has paid somebody, and the tip that
// cannot be revenue (P-HR-12). Five tables. `payroll_run` is a DRAFT until `completed_at` is set and
// immutable after (ZY141); the only UPDATE a draft accepts is the one that completes it, which is also the
// only statement that may state its header figures (ZY142) — they are the sum of payslips that arrive over
// several transactions, so they are not knowable when the run is opened, and ZY150 holds them to the
// payslips on that same statement. A run that is wrong is corrected by a NEW dated run naming the one it
// corrects (ZY143, plus `payroll_run_one_original_per_period`), which is 0018's journal rule applied to
// wages and the shape 0086 gave attendance and 0097 gave commission.
//
// `payslip` PINS every figure it prints rather than recomputing one. The commission comes off a
// `commission_run` with its rule version snapshotted beside it (ZY147) — P-HR-11 built a whole migration to
// make a run reproducible, and a payslip that called the engine again would resolve "the rule in force" and
// restate March at June's rates. The overtime comes off a `timesheet_approval` and is priced at the
// `labour_cost_rule` version the RUN pins, never at today's divisor. `gross_fils` and `net_fils` are
// GENERATED for `employee.total_wage_fils`'s reason, sharpened: the payslip, the screen and the WPS file must
// not be able to compute the net differently, and generated makes a wrong net unstorable rather than merely
// detectable. The oracle the acceptance criterion asks for is therefore a THIRD computation —
// `summarisePayroll` in `@berelax/core`, these columns, and a table of worked examples in
// `payroll.test.ts` — which is what makes "reconciles" a claim rather than a tautology.
//
// **The overtime line is the UPLIFT only, and that is the one modelling decision in the unit.**
// `employee.basic_wage_fils` is a MONTHLY figure paid in full whatever was attended, and P-HR-05's
// `weighted_minute_bp` is `sum(minutes × multiplier)` over EVERY minute — so pricing it whole and adding it
// to the monthly basic pays the ordinary month twice. `payslip.overtime_uplift_minute_bp` is
// `weighted_minute_bp` less `payable_minutes` at the ordinary multiplier READ FROM the `working_hours_rule`
// version the approval snapshotted, which is why there is no literal 10000 in `payroll.ts` to reach for. The
// other reading — every attended minute priced at its bucket rate, the monthly figure only a budget — is a
// different payslip for somebody who worked three days of a month, and which one is right is part of
// Y9-overtime rather than something a comment can settle.
//
// Two tables hold what a payslip subtracts and adds, and neither invents a policy. `employee_tip` is an
// individually attributed pass-through LIABILITY: the row names the account the salon owes it against and
// ZY146 refuses any account whose type is not `liability`, so "a tip never lands in a revenue account" is a
// property of the schema and not a habit of a function — and it refuses an EXPENSE or ASSET account too,
// which a revenue-only check would pass. It defaults to 2040 `Tips payable to therapists`, which 0018
// already seeded; this migration invents no account. `payroll_deduction` carries an authorised actor, a
// recorder who is deliberately a different column, a reason somebody wrote, and NO `kind` vocabulary —
// which deductions are lawful and what proportion of pay they may reach is Y9-deductions and nobody has
// answered it, so a closed set would read as the list of deductions this business makes.
//
// **Nothing here holds a WPS employer id, agent id, establishment id or MOL number, and there is no column
// that could.** docs/04 §7's entire statement about the Wage Protection System is "salary file, in the
// format the bank requires": no bank named, no agent code, no layout, no field spec. Y8-wps is the question.
// The identifiers are settings whose defaults SAY they are pending and fail `validateWpsFile` twice over,
// `PLACEHOLDER_TRN`'s technique for `PLACEHOLDER_TRN`'s reason — brief rule 15 at its sharpest in this
// build, because plausible digits would produce a file that passes every check and pays nineteen people
// against somebody else's registration. `wps_export` records which run, which layout, how many records, what
// total and the sha256 of the bytes, and ZY149 refuses an export of a run nobody completed: the bytes carry
// no draft flag a bank would read. There is no submit path anywhere in the repository — absent, not
// disabled, which is docs/04 §4's rule for VAT201 applied where the consequence is larger, and
// `packages/fixtures/src/wps-no-submission.test.ts` is the scan that keeps it absent.
//
// "A locked period refuses a new payroll run" costs no private code: `payroll_run_period_guard` CALLS
// `raise_if_period_locked()` (0018, redefined by 0073), which already names the locked period and the
// earliest OPEN date. 0086 and 0097 both took that decision and this is the third — the lock has one reader
// and this file does not add a second. ZY145 is the refusal that IS this unit's: a run over a period whose
// approved timesheets count an INCOMPLETE presence, read from P-HR-07's stored count rather than by pairing
// the punches again, because whether a clock-in was ever closed is decided once and against the grace
// version the approval snapshotted.
//
// Ten private SQLSTATEs, `ZY141`-`ZY150`, the whole of this unit's band, allocated through
// `packages/db/src/sqlstate-registry.ts` and not by reading the migrations a worktree can see (ADR 0043).
// Ten and not one because each has a different runbook answer — "correct it with a new run", "complete the
// run first", "record an attendance correction" and "name a liability account" are four different things to
// go and do, which is 0061's argument for a private code at all.
//
// 106 is 0106_payment_intent.sql (Y-PAY-02): `payment_intent`, its append-only
// `payment_intent_transaction`, and five refusals. The
// two tables are ordinary and the refusals are the unit. ZY162 is the one worth reading — an intent's state
// or any of its three figures may change only by advancing `last_transaction_id` to a NEW transaction row
// belonging to that intent — because it is where "the gateway, never the client, is the only thing that can
// move an intent" stops being a sentence in a route handler. ADR 0056 records the decision and the division
// of labour with `@berelax/core`: WHICH state an event reaches is the lifecycle table's and has one home,
// and WHETHER anything may move at all is the database's. Restating the (state, event) table in plpgsql was
// the obvious alternative and is the two-homes-for-one-fact defect ADR 0043 is itself about.
//
// There is one transaction row per gateway EVENT and not one per movement, and the reason is that ZY162 has
// to be total. `action_required` and `authorisation_failed` move the state while moving no money, so a
// movements-only table left those two transitions with no row to name — and the exemption that would have
// fixed it would itself have been a second copy, in plpgsql, of which events move money. Three of the six
// kinds carry zero fils by CHECK, which is `INTENT_EVENT_CARRIES_AMOUNT` in `@berelax/core` as schema, in
// both directions: a zero-fils capture reads as a settled movement for nothing, and a figure on a `voided`
// row reads as a partial release, which does not exist.
//
// ZY163 recomputes the header from the rows at COMMIT — MAX over the `authorised` rows, SUM over `captured`
// and `refunded`. The maximum is not a typo and it is the one arithmetic mistake here that makes an
// over-capture look legal: a gateway increasing a reservation reports the new TOTAL rather than the
// increment, so summing authorisation rows doubles the ceiling every capture is checked against. `reduceIntent`
// in `@berelax/core` takes the largest authorisation it has seen for the same reason, and 0106's check is a
// deliberately INDEPENDENT second derivation of the same figures, which is what makes the acceptance line
// "the intent's derived balance equals the sum of its append-only transaction rows" a claim about two
// answers agreeing rather than about one answer being reread.
//
// Deferred rather than immediate for 0018's reason: the row and the header are separate statements, so an
// intent is transiently out of step with its rows by construction and an IMMEDIATE trigger would reject
// every legal write. And a consequence that surprised this unit's own probe — the header-lies case is
// normally caught by ZY162 first, because a figure changing with no new row is already a refusal; reaching
// ZY163 needs a genuine new row AND a header that disagrees with it, which is what
// `payment-intent.itest.ts` drives.
//
// **Neither table can be emptied by anybody, and that is the design.** ZY161 refuses DELETE on a
// transaction row for every role including the owner, and `payment_intent_transaction.payment_intent_id`
// references the intent, so the intent is undeletable too. That is the intended reading of P-HR-07's
// mechanical test: the child cannot be deleted to release the pin, and pinning the parent is the POINT
// rather than a cost, because an intent that touched money is evidence and not a draft. So the suites here
// assert a DELTA and never a total (brief rule 9), nothing is declared in
// `packages/db/src/suite-table-declarations.ts`, and W-SYS-13's scan has nothing to say about them.
//
// `reference` is text and not a foreign key into `invoice`, unlike `payment.invoice_id` which is one. The
// difference is definitional rather than convenient: a tender is BY DEFINITION against an issued document,
// and an intent is authorised before there is one — a deposit on a booking — so the key would have to be
// nullable, and a nullable reference to a document that does not exist yet is not the fact the column
// records.
//
// Five private SQLSTATEs, `ZY161`-`ZY165`, from the band `ZY161`-`ZY170` issued to this unit and allocated
// through `packages/db/src/sqlstate-registry.ts` (ADR 0043). Five and not one because each has a different
// runbook answer: "write a new row", "find the gateway movement that justifies this", "your figures
// disagree with your rows", "this is a redelivery, answer 200" and "that tender is taken at the desk" are
// five different things to go and do. `ZY166`-`ZY170` are unused and deliberately NOT registered — an entry
// for a code no migration raises is what direction 3 of the gate refuses, and that is the direction which
// lets the registry shrink.
// 107 is 0107_hr_gratuity.sql: end-of-service gratuity, the liability that grows every month (P-HR-13).
//
// Four tables. `gratuity_rule` holds the FIGURES as a versioned provisional row, because docs/04 section 7
// says exactly one thing about this subject — that gratuity is an accruing balance-sheet liability accrued
// monthly — and no rate, band, cap, divisor or wage basis anywhere. That section also says where the HR
// figures go instead and why, naming `working_hours_rule` (0059) and `leave_entitlement_rule` (0066), so
// this is that shape: flagged against Y9-gratuity, on the Unconfirmed Assumptions panel, and answered by
// publishing a NEW version rather than by editing a document. Gratuity is asked about the PAST for
// payroll's reason — a settlement recomputed after a rate change must use the rate that applied then.
//
// There is deliberately NO CAP COLUMN. docs/04 names none, and the SHAPE of a cap is as unknown as its
// number: a ceiling on the days earned, on the months that earn, or on the total as a multiple of the wage
// are three different columns, so a nullable one would be a place to put a figure the engine would then
// apply to the wrong quantity. That is 0066's reasoning about carry-over expiry — a policy the code would
// silently mis-apply is worse as a column than left unexpressible.
//
// `gratuity_accrual` is the month's movement, and the month's movement is a DIFFERENCE: the whole liability
// owed at the month end minus what is already on the books. ADR 0057 is why that way round. Twelve
// independently-rounded twelfths do not sum to a year, the residue is permanent in a journal that cannot be
// edited (ADR 0017), and it grows over a career. Making the cumulative figure the primitive also means a
// wage rise lands as one catch-up movement in the month it is known — so nothing here can require a
// COMPLETED PAYROLL RUN to be rewritten, which is the constraint P-HR-12 handed over (ZY141 makes a
// completed run immutable and ZY142 lets only the completing statement write its header figures).
//
// `gratuity_settlement` discharges a leaver's liability to exactly zero, enforced rather than asserted:
// ZY175 refuses any figure other than the live accrued total from `employee_gratuity_liability`, the view
// that excludes every accrual some correction supersedes.
//
// `closed_period_labour_adjustment` answers a gap Y9-attendance has carried since 0086 and that P-HR-12
// re-pointed here. Attendance for a day in a CLOSED accounting period with no punch at all cannot be
// entered, because `attendance_correction.corrects_event_id` is NOT NULL — a correction amends a record and
// cannot invent one. P-HR-12 could not take it either: `payroll_deduction` only ever REDUCES pay, and
// unrecorded work needs an UPWARD adjustment. So it is a ledger-side accrual, wages expense against wages
// payable, and the AMOUNT is stated by whoever authorises it and never derived — deriving it means deciding
// what a day of a monthly salary is worth, which Y9-deductions records as unanswered, and a derived figure
// would be indistinguishable on the ledger from an authorised one.
//
// The DEBIT AND CREDIT ACCOUNTS are resolved from `app_setting` and never written into a posting rule,
// because `chart_of_accounts` is itself provisional against Y8-coa (0018 says so on the table). ZY173
// checks the account TYPES — expense debited, liability credited — and deliberately not the codes, which is
// the shape 0104 gave a tip with ZY146.
//
// Seven private SQLSTATEs, `ZY171`-`ZY177` of the `ZY171`-`ZY180` band, allocated through
// `packages/db/src/sqlstate-registry.ts` (ADR 0043); `ZY178`-`ZY180` are left free. Seven and not one
// because each has a different thing to go and do: "correct it with a reversal", "wait for the period to
// close", "post the journal entry first", "end the employment first", "recompute the liability" and "record
// a punch correction instead" are six different answers.
//
// 110 is 0110_reporting_schema.sql: the `reporting` schema (R-REP-01) — four dimensions, three facts, all
// materialised views over `public`, all keyed on `business_day`. Three things in it are decisions rather
// than DDL, and ADR 0060 argues them at length.
//
// **Nothing in the schema states a fact of its own.** Every relation is derived and the only thing that
// changes a row is `reporting.refresh_all()`. That is what makes the schema's absence from C-CRM-05's merge
// registry and C-CRM-10's erasure catalogue — both of which enumerate `relkind in ('r','p')`, and a
// materialised view is `'m'` — safe rather than a hole: a merge has nothing to re-point, and an erasure is
// complete when the base row changes whether or not a refresh has run. It is only safe while it stays true,
// so `dim_customer` carries no phone, no name, no label and no note, and `dim_staff` carries no wage.
//
// **`dim_date` is keyed on `business_day.trading_date` and has no calendar date of its own.** A dimension
// generated from `generate_series` would be a twelfth statement of the trading calendar and the first one
// entitled to disagree with it, because nothing would join the two. The cost is stated rather than hidden:
// `reporting` cannot answer a question about a day the premises did not trade on, which is the right
// refusal for every figure R-REP-02 through R-REP-08 asks for and a real limit on anything else.
//
// **The refresh is CONCURRENT, and the unique index on every view is what makes that legal.** A plain
// refresh takes ACCESS EXCLUSIVE, so every reader blocks for the rebuild — and the tempting fix when a
// concurrent refresh fails is to drop the keyword. So the absence of a usable unique index is refused
// BEFORE the refresh (ZY182) rather than reported by PostgreSQL afterwards in a message naming neither the
// view nor the remedy. `reporting.refresh_run` is append-only (ZY184) because R-REP-07 decides from it
// whether a tile may render a number, and the one thing an editable freshness log permits is making a stale
// view look current.
//
// `fact_sale` is keyed on `invoice.tax_point_date`, the date of SUPPLY, which 0026 already stores as a
// trading date. `tax_point_date` has no foreign key to `business_day`, so an INNER JOIN would have looked
// like the fix and would have DROPPED an off-calendar invoice — revenue leaving a revenue fact in silence.
// `reporting.assert_business_day_keys` refuses the refresh instead (ZY185), naming every offending date, and
// it is applied to `fact_appointment` and `fact_shift` too even though a foreign key already covers them:
// one rule in one place is what a fact added later inherits.
//
// The holiday calendar is P-HR-10's and does not exist yet, so `reporting.calendar_observance` is the
// minimum source for `dim_date`'s two flags — and the reason it is a new table rather than a read of
// `premises_closure` is worth reading, because the obvious answer is exactly backwards: a closure means the
// premises is SHUT, a shut date has no `business_day` row and therefore no `dim_date` row, while a public
// holiday the salon TRADES THROUGH has no closure row at all (Y9-overtime says so). It ships EMPTY: every
// date is `Y9-holiday-calendar`, and `calendar_observance_lunar_is_provisional` makes "every lunar-date
// holiday row carries provisional = true" a refusal rather than a property of rows somebody seeded.
//
// Five private SQLSTATEs, `ZY181`-`ZY185` of the `ZY181`-`ZY190` band, allocated through
// `packages/db/src/sqlstate-registry.ts` (ADR 0043); `ZY186`-`ZY190` are left free and deliberately
// unregistered, because an entry for a code no migration raises is refused. Five and not one because each
// names a different thing to go and do: register the view, index it, spell the name the registry holds,
// re-run the refresh instead of editing its log, and generate the trading days the facts are keyed on.
//
// ---------------------------------------------------------------------------------------------
// 111 is 0111_migration_staging.sql (H-MIG-01) — the import substrate: a staging ledger, per-row provenance,
// and the two rules that make an import resumable rather than run twice
// ---------------------------------------------------------------------------------------------
// The schema is `import_staging` and NOT `staging`, because `staging` is an APP_ENV value
// (`packages/config/src/env.ts` lists five and that is one of them) and a schema of that name reads as "the
// schema the staging deployment uses" to everybody who meets it later. It is not that: it is where imported
// data sits while it is being judged, in production as much as anywhere.
//
// Everything in the file follows from one sentence in H-MIG-01's own summary — **there is no incumbent
// export.** The source of every figure that arrives here is a spreadsheet a human typed, so there is no
// foreign primary key to reconcile against, nothing to re-query, and no way to re-derive a row once the file
// has been edited. The only identity a source row has is (file, line, content hash), and that is exactly
// what provenance records.
//
// `import_provenance` names (target_schema, target_table, target_id) and an `import_row_id`, and carries NO
// copy of the file, the line or the hash. Those live once each on `import_run` and `import_row`, and
// `import_staging.entity_provenance` is the single view that joins them. Denormalising would be faster to
// read and would be wrong in a way nobody would see: a provenance row holding its own copy of the file hash
// cannot be checked against the run it came from, so a corrected re-import that edited one row would leave
// provenance claiming a hash the file no longer has — and the claim would still resolve. `target_id` is
// `text` and not `uuid` because `package_template` is keyed by a code and 0106's chart-of-accounts work will
// be too; a uuid column would push the one importer with a natural key into keeping its provenance somewhere
// else, and "somewhere else" is how coverage stops being 100%.
//
// **ZY196 is the deliverable.** A DEFERRED constraint trigger refuses, at COMMIT, any `import_row` that
// reached `applied` with no provenance row naming it — so "a row without provenance cannot be inserted" is a
// property of the database rather than of whichever importer remembered. Deferred and not immediate because
// the order of the three statements is the importer's business, and the claim is about what may be
// COMMITTED. What the database cannot see is an INSERT into an arbitrary target table, so the other
// direction is MEASURED rather than assumed: `import_staging.unprovenanced_row_ids` reads a target relation
// for rows nothing names, and the framework's report carries the count per declared target.
//
// **ZY198 is the only rule here whose absence loses data while reporting success.** The idempotence check
// trusts `completed`: a second import skips a row because a completed run already applied it. A run marked
// completed with rows still pending therefore makes the next import skip rows that were never imported, so
// the state is refused rather than reported. ZY191 (one open LIVE run per file — a dry run rolls back and is
// deliberately exempt), ZY192 (a staged row's evidence and its terminal outcome are fixed), ZY193 (nothing
// staged into a finished run), ZY194 (provenance only for a declared target), ZY195 (provenance is
// append-only) and ZY197/ZY199 (a checksum over no columns, and a coverage read over a relation provenance
// cannot address, are refused rather than answered with a constant) complete the band ZY191-ZY199; ZY200 is
// left FREE and unregistered, because an entry for a code no migration raises is what direction 3 refuses.
//
// ZY197 deserves its line. Every acceptance line in this unit is asserted by comparing two checksums, so the
// checksum is the thing whose being wrong would make the whole unit report success while measuring nothing.
// `content_checksum` therefore lives in the DATABASE — one implementation for the report and for every
// suite — an EMPTY relation answers `empty:<relation>` rather than `md5('')`, and an exclusion list that has
// removed every column raises instead of returning a constant that compares equal for ever.
//
// The file also creates ONE target table, the framework's conformance target, so those claims are proved
// against real constraints, a real deferred trigger and a real checksum instead of a mock —
// `packages/payments/src/conformance/fixtures` ships deliberately broken adapters for the same reason, and
// `packages/migration/src/write-path.test.ts` is what stops a real importer naming it. Nothing in this
// schema has ON DELETE CASCADE and the application role holds no DELETE or TRUNCATE anywhere in it: a run
// that should not have happened is recorded as having happened, which is what an audit trail is.
//
// 113 is 0113_reply_lint_stamp.sql — the reply lint stamp, and the delivery timestamp that cannot exist
// without one (G-REV-05).
//
// Four columns on `google_reviews` and four CHECKs, and the unit is one of them:
// `google_reviews_delivery_needs_a_lint_pass` refuses `submitted_at` (API mode) or `posted_manually_at`
// (fallback mode, which is the launch mode) on a row carrying no `reply_lint_version`. docs/10 §6 says the
// same linter runs in both modes and the manifest says a caller cannot route around it; the TypeScript half
// is that `recordReplySubmittedToApi` and `recordReplyPostedManually` now take the stamp as a required
// argument, and this constraint is what still holds when somebody writes the UPDATE by hand. One constraint
// covering both modes rather than one each, because the claim is about delivery: a per-mode pair is the
// shape that ends up covering one of them.
//
// `reply_approved_text` is deliberately not `reply_draft`. 0048's draft is the MACHINE's sentence and its
// writer is guarded by `reply_draft is null` so that an owner's edit is never overwritten — which means the
// moment anybody edits anything the two are different facts, and the one that matters afterwards is what
// was published. It is the only thing `reply_lint_content_sha256` can be a hash of, and it is what
// G-REV-06's *Copy reply* puts on the clipboard byte for byte.
//
// `google_reviews_reply_approved_text_within_cap` carries 1,200, which is a second statement of
// `REPLY_LENGTH_CAP` and therefore arrives with the check that refuses a disagreement:
// `packages/google/src/reviews/reply-delivery.itest.ts` reads the constraint's own definition out of
// `pg_constraint` and asserts the number in it equals the constant. That suite and not the one beside the
// other `google_reviews` probes, because ADR 0001 forbids `packages/db` from importing `packages/core` and
// a test there could not name the constant. The direction that drift would take is the dangerous one — a
// database still accepting what the linter had started refusing.
//
// NO private SQLSTATE, and the band ZY211-ZY220 allocated to this unit is released unused. Every refusal
// here is an ordinary 23514 naming its own constraint, and a private code is for a refusal with a runbook
// answer (ADR 0043, 0061): the answer to all four of these is the same sentence — lint the reply and
// deliver it through the send path.
//
// 116 is 0116_collect_ingest.sql — pre-consent staging, and the reason a session's trading date is the
// date it says (A-FIRST-05, ADR 0066).
//
// One table and one column, and each answers a question the ingest route could not avoid.
//
// `analytics.pre_consent_landing` is the identifier-free half. The internal store is treated as
// consent-gated while `Y5-analytics-basis` is open, so `analytics.visitor` and `analytics.session` are
// created AT consent and never before it — which leaves the funnel's first stage, `landing`, with no way to
// count a visitor who arrived, read, and left without answering a banner. Dropping the event loses the
// denominator every conversion rate divides by; keeping it loses the position. The obvious third answer is
// to STAGE the event until a decision arrives, and that answer is not available: a holding pen needs a key
// to promote a row by, and a key before consent is the identifier the position withholds. So the
// pre-consent path is an irreversible PROJECTION — one `+1` against a bucket of (business day, gap basis,
// route) and nothing else — which is what makes two claims properties of the table rather than promises
// about code. Consent never arriving needs no purge, because nothing identifying was written; and a subject
// access request finds nothing because the row holds no column any of C-CRM-10's five erasure probes can
// reach and no instant finer than a date. That last absence is deliberate: there is no `created_at` and no
// `computed_at`, because a timestamp on a row whose count is 1 is a timestamp of one person's visit.
// Retention keeps it indefinitely, beside the three rollups; ZY221 refuses a DELETE, a lowered count and a
// count moved onto another key, because it is the only surviving record that the visit happened.
//
// `analytics.session.trading_date_basis` is the other half, and it exists because 0096 made
// `trading_date` NOT NULL with a real key to `public.business_day`. Trading runs 11:00-02:00, so between
// 02:00 and 11:00 an instant belongs to NO trading date while web traffic carries on — A-FIRST-02 refused
// to invent an answer and recorded `Y5-funnel-gap-bucket`, but a row still has to name a date. It names the
// next date the calendar opens and says WHY, which is 0096's own argument for `attribution.basis` one table
// over. ZY222 is what makes that structural: `analytics.assert_session_trading_basis` compares `started_at`
// against that business day's OWN `opens_at` and `closes_at` — not against a re-derived 11:00-02:00, which
// would disagree with the calendar on exactly the dates somebody overrode the hours for — and refuses the
// disagreement in BOTH directions, because a writer stamping every row with a gap reason loses the same
// information as one stamping every row `trading`. The column has NO default, deliberately: `trading` is
// exactly the value a caller who has not thought about the gap would get, and it would be wrong nine hours
// out of every twenty-four.
//
// Two figures are second statements and each arrives with the check that holds it equal to the first. The
// visitor cookie's `Max-Age` is `analytics.raw_retention_days()` in seconds, asserted against the function
// itself by `apps/web/app/api/collect/collect.itest.ts` — a cookie outliving its own row would present an
// id naming nothing. And the four words of `trading_date_basis` are also `TRADING_DATE_BASES` in
// `@berelax/shared`, which `packages/core/src/analytics/ingest.ts` holds equal to `OutsideTradingReason` by
// a two-way TYPE assertion, so a reason added to the resolver and not to the tuple fails `pnpm typecheck`.
//
// No CHECK on `event_name` and none on `bot_kind`: 0096 and A-FIRST-04 each recorded why a list in SQL
// beside a union in TypeScript is two lists. No customer or booking reference, which is A-FIRST-08's to add
// with its erasure classification on the same commit. And no `fbp`/`fbc` columns — those cookies exist only
// once a Meta pixel has run, and the pixel cannot run before consent (A-MEAS-02), so the unit that makes
// them reachable is the unit that owns them.
//
// Every number allocated through 99 has now landed: the run on disk is 1..99 less the permanent gaps above,
// less 88, which M-TILL-13 released as a permanent gap because every table its screens touch already
// existed. 85 and 89 through 99 arrived out of order, each with the unit that held it, 94 (G-REV-02) last of
// them. 100 through 107 have all landed now, each with the unit that held it — W-SYS-13, W-SYS-14, M-VAT-09,
// M-VAT-12, P-HR-12, Y-PAY-01, Y-PAY-02 and P-HR-13, in that order. 108 and 109 were held by A-FIRST-03 and
// A-MEAS-01 and RELEASED: both turned out to need no migration at all, so both are permanent gaps rather
// than numbers anybody is waiting on. 110 through 113 were handed out together to the units of one batch,
// and all four have now landed or released: 110 with R-REP-01, 111 with H-MIG-01 (out of order, before
// 110 — which is the arrangement this note exists for: the number is a high-water mark and not a count),
// 112 released unused by A-FIRST-04 and so a permanent gap, and 113 with G-REV-05. 114 (R-REP-02), 115
// (H-MIG-02), 118 (R-REP-03) and 120 were all RELEASED unused and are permanent gaps, each on one
// argument: a statement, a KPI and a cohort figure are arithmetic over rows other units already write, and
// a private SQLSTATE is for a refusal that needs a runbook answer at the database boundary. 120 is the one
// number this note records as allocated TWICE, to R-REP-04 and then to R-REP-05 — an integrator's error,
// harmless only because both released it, and recorded because the gate walks what is on disk and would
// never have seen it. 116 landed with A-FIRST-05, 117 with Y-PAY-03, 119 with H-MIG-03 and 122 with
// R-REP-06, which is the newest on disk, and 121 with H-MIG-04 — out of order, after 122, which is the
// arrangement this note exists for: the number is a high-water mark and not a count. 123 is the first
// number nobody holds. Gate case 90a walks the migrations that EXIST on disk rather
// than consecutive integers, which is what makes a non-contiguous allocation cost nothing; a held number
// that turns out to need no migration becomes a permanent gap like 22, 41, 44, 47, 71, 74 and now 88, and is
// NOT renumbered, because renumbering to close a gap is how two branches come to apply one number to
// different SQL.
//
// W-SYS-12 landed as 99 and not as the 94 it was issued, and the reason belongs in this note rather than in
// a commit message: 94 had ALREADY been allocated to G-REV-02, in two waves, and neither worktree could see
// the other. G-REV-02 keeps it because it was first and had it committed. That is W-SYS-12's own subject
// arriving in migration numbers instead of refusal codes — the scarce thing allocated by reading what a
// worktree can see — and the difference is that a duplicated migration number is caught by the first
// integrator who lists the directory, where a duplicated SQLSTATE class was caught by nothing for thirteen
// codes. Which is the argument for the registry, made from the other side.
//
// Private SQLSTATEs are no longer allocated in this note, or by reading the migrations a worktree can see.
// `packages/db/src/sqlstate-registry.ts` holds one entry per code and `pnpm sqlstate` refuses a second claim
// on one, which is ADR 0043: the migration number and the refusal code stopped being the same kind of thing
// the moment a class ran out.
//
// This note replaced five copies of itself. Every batch merge resolved the allocation sentence by keeping
// both sides, and four of the five surviving copies then described a set of held numbers that had since
// landed — in the file whose own rule is that a second statement of a fact drifts. There is one now, it is
// the last thing before SCHEMA_VERSION, and a merge that wants to add another edits this one instead:
// `allocation-note.test.ts` is what refuses a second copy, and a second next-free claim in any wording, now
// that saying so here has failed five times.
//
// 117 is 0117_card_shape_refusal.sql — no column a checkout writes may hold text shaped like a card number
// (Y-PAY-03). One function, `is_card_shaped()`, and one rule, `ZY231`, on `payment_intent.reference`,
// `payment_intent.idempotency_key`, `payment_intent.gateway_intent_id` and
// `payment_intent_transaction.gateway_event_id`. No table, no column and no index, so the Drizzle mirror is
// unchanged and `pnpm db:drift` has nothing new to compare — the file is a refusal and nothing else.
//
// Two decisions in it are worth finding here rather than in the file, because both are the kind that gets
// "simplified" by a later reader.
//
// **It is a TRIGGER and not a CHECK constraint, and that is the point of the migration.** A CHECK is the
// obvious spelling and it is the wrong one: PostgreSQL appends `DETAIL: Failing row contains (…)` to a CHECK
// violation, so the constraint that kept the card number out of the column would have written it into the
// server log and from there into wherever logs ship. The guard would have created the disclosure it exists to
// prevent, on the path everybody agrees is the safe one. A trigger raises a message we write, which names the
// TABLE and the COLUMN and never the value — and that is also why the refusal needs a private SQLSTATE at
// all: the prose is deliberately uninformative, so a caller has to be able to branch on the code.
//
// **It is deliberately NOT on `audit_event` or `outbox_event`**, which is the version of this rule somebody
// will propose. `is_card_shaped` reports a 13-to-19-digit Luhn-valid run, and about one arbitrary run in ten
// of that length is Luhn-valid; those two payloads carry the whole build's data, including a fifteen-digit
// TRN, an IBAN whose BBAN can be sixteen digits or more (P-HR-12's WPS file) and E.164 numbers up to fifteen.
// A trigger there would refuse legitimate writes, and an audit write that can be refused is an audit trail
// with a hole in it — a worse failure than the one being prevented. Those tables get the other mechanism
// instead: `redactCardData` before every sink, `pnpm saq-a` refusing a payments write that skips it, and a
// full-text sweep in `apps/web/src/checkout.itest.ts`. Structural where a refusal is safe, scanned where it
// is not. ADR 0067 records the division.
//
// `luhn_check()` and `is_card_shaped()` are a second statement of `cardShapedRuns()` in
// `packages/payments/src/redaction.ts`, because SQL cannot read TypeScript, so the check that holds them
// equal ships in the same commit: `packages/fixtures/src/card-shape-agreement.itest.ts` drives
// `CARD_SHAPE_PROBES` — stated once, in that module — through both and requires identical verdicts. The
// direction the drift would take is the dangerous one: a database still accepting what the request boundary
// had started refusing, so a test asserting the refusal would be satisfied by the wrong layer.
//
//
// 119 is 0119_migration_signoff.sql (H-MIG-03) — the owner sign-off, and the shape a RECONSTRUCTED package
// liability has. `import_staging.import_sign_off` is the table H-MIG-01 deliberately did not create ("a
// table with no unit deciding who may sign and what a signature covers would be a shape for somebody else
// to work around"); it attests to `import_run.source_file_hash`, which was already there, and carries the
// cash figure and the opening date the owner is accepting along with it. `imported_package_sale` is what the
// reconstruction workbook said about one package, kept beside the `package_sale` it produced.
//
// The decision in the file, and the reason this unit is the migration's highest-risk artefact: **a
// reconstructed `package_sale` records what is still OUTSTANDING, not the package as it was sold.** The
// sessions a workbook row says were taken were delivered under the previous arrangement against no
// appointment in this database, and 0083's ZG009 is right that a drawdown here must have a
// `package_redemption` behind it — because a redemption posts the release through `4020` and `2030` (ZG008),
// which would be output VAT on a supply made before this system traded. So the entitlement that arrives is
// the one that remains, the attested figures live on the reconstruction record, and a FULLY DRAWN package
// imports with no sale at all: nothing is outstanding, so there is no liability, no balance and no posting,
// and the row is kept because the cash was received and because the history is what the holder will ask
// about.
//
// Three things it changes, and only one of them is another unit's rule. `package_sale.expires_on` stops
// being GENERATED, because a reconstruction's expiry is the date the holder's own copy carries and H-MIG-02
// asks for it as a column precisely because the validity was an assumption when the package was sold; a
// BEFORE INSERT trigger derives the same date for every sale the till makes, so that path supplies nothing
// and gets what it always got, and ZY253 refuses a caller that states a different one rather than silently
// overwriting it. ZY254 then makes the column immutable, which 0078 could leave to the generated expression
// and 0119 cannot — and it is a code of its own rather than a widening of ZG001's comparison because ZG001
// is also raised by `package_row_is_immutable` in 0078, and `pnpm sqlstate` refuses a code whose live raise
// sites span two migrations. ZG002 is EXEMPTED for a reconstruction and replaced by ZY257, which holds the
// sale's liability, session count and expiry equal to the workbook row instead of to the template version —
// through `package_release_through_fils`, 0083's own release formula, so the imported liability is the
// figure a redemption would compute. Everything else is untouched: ZG005 still refuses a posting that is
// not pure deferred revenue, which is how "no output VAT at import" is a property of the database rather
// than of an importer.
//
// The posting is `Dr 3030 Retained earnings / Cr 2050 Deferred revenue — packages` at what is still owed,
// dated on the opening date, `source = 'opening_balance'` — load-bearing, because ZL004 (0027) refuses any
// entry dated before the books open except an opening balance and a reversal. The counterpart is equity and
// NOT cash: the money was received in a period these books do not contain, and the cash is H-MIG-07's
// opening asset. Debiting it here would double it the moment that unit imports the opening trial balance,
// which is the one error in an opening position that is undetectable afterwards, because the books still
// balance. `artifacts/migration/package-liability.json` is the figure handed over.
//
// SQLSTATEs ZY251-ZY258 of the allocated band ZY251-ZY260; ZY259 and ZY260 are left FREE and deliberately
// UNREGISTERED, because an entry for a code no migration raises is what direction 3 of `pnpm sqlstate`
// refuses. Two views carry the acceptance lines that are about being able to SEE this:
// `imported_package_liability` is the liability report and `customer_package_attestation` is the
// honour-once-on-evidence flag on the customer record, a view rather than a column on `customer` for the
// reason 0084's `customer_contraindication_flags` is one.
//
// 121 is 0121_customer_import.sql (H-MIG-04) — the consent floor as a refusal, and the record of what one
// line of a reconstructed contact list became. One table, `imported_contact`, and three rules: ZY271,
// ZY272, ZY273.
//
// **ZY271 is the file.** docs/11 §7 states the rule without exception — a customer list rebuilt from
// WhatsApp history and phone contacts imports with no marketing consent, transactional messaging stays
// permitted, and consent is captured at the next booking with the wording version shown — and nothing
// enforced it. There is no `marketing_consent` column anywhere in this schema and this migration
// deliberately does not add one: 0056 made consent an append-only LOG, so "no marketing consent" is the
// ABSENCE of a row, not a `false` and specifically not a `withdrawn` row either, because nobody withdrew
// anything and nobody was ever asked. The only enforceable statement of an absence is a refusal, so a
// GRANTED consent row whose `capture_source` is `'import'` is refused for any purpose that gates a send.
// What makes such a row false is not that an importer wrote it: `consent_wording` holds only the
// statements this system published and SHOWED, 0056 requires a grant to name one, and a contact
// reconstructed from a chat thread was shown none of them — so the row claims words were read that nobody
// displayed, which is exactly the artefact TDRA asks a promotional sender to produce. The purposes come
// from `consent_purpose.is_send_gating` rather than being listed again, so `clinical_processing` and
// `photography` are untouched, and a WITHDRAWAL captured by an import is permitted because it only ever
// restricts sending. The door it leaves is named in the file: a lawfully collected external opt-in list
// (docs/11 §7's "one-time opt-in campaign only if your lawyer confirms a lawful basis") needs its wording
// published and this trigger changed by a migration, which is the right barrier for a mass import of
// marketing consent.
//
// **`imported_contact` answers Y9-import-ledger, which H-MIG-01 left for this unit.** The staging ledger
// keeps `import_row.payload` for ever — append-only by ZY192, with no role holding DELETE anywhere in
// `import_staging` — and `payload` is `jsonb`, which none of C-CRM-10's five catalogue probes can see
// inside. A phone number staged there is not retained against an obligation, it is unreachable. For a
// contact list the payload IS the identifier, so minimising the fields is not enough: the number does not
// go in at all. What is staged is `HMAC-SHA256(json(number), SUPPRESSION_PEPPER)` — 0064's instrument,
// under this unit's own key kinds so the two key spaces stay disjoint — and the plaintext lives in exactly
// one place, `customer.phone_e164`, which an erasure pseudonymises. So an erasure is complete again: the
// digest cannot be recomputed from anything left in the database, and the row stops resolving to a person
// while staying what it was, the evidence that an import happened and what it did. The column is named
// `contact_hmac` ON PURPOSE, because `CREDENTIAL_COLUMN_PATTERN` matches `_hmac` and the erasure engine
// therefore REFUSES to run until `rights-policy.ts` classifies it; a column called `phone_digest` would
// have been invisible to all five probes, which is the accident the open question is about. The cost,
// stated and asserted rather than discovered: a pepper rotation changes every digest, so a re-import after
// one applies every line again — landing as `matched`, because the unique index on `customer.phone_e164`
// is the real dedup and the digest is only the forecast.
//
// The table holds a digest, a pepper label, an outcome and a reason, and nothing else. No copy of the
// number, for the reason above; no copy of a quarantined cell, because a quarantine record is a REASON and
// a REFERENCE and the cell is in the file the operator already has; and no customer id, which is 0119's
// reason for `imported_package_sale` — a merge re-points the columns `merge-participants.ts` registers,
// and a second copy of the holder here would be the copy the merge did not follow. One row per staged
// line, always, which is also what makes a duplicate line and a quarantined line expressible at all:
// `import_provenance_one_per_target` refuses a second claim on the customer the first line created, and
// ZY196 refuses the COMMIT of an applied row that recorded nothing. ZY273 then holds the outcome equal to
// what the import actually wrote, in both directions, by walking the record's own provenance to the staged
// row — the distinct count every acceptance line in that unit is read off is `outcome = 'created'`, and a
// record saying `created` with no customer behind it would report an import of people who are not in the
// database while satisfying ZY196 perfectly well.
//
// SQLSTATEs ZY271-ZY273 of the allocated band ZY271-ZY280; ZY274 through ZY280 are left FREE and
// deliberately UNREGISTERED, because an entry for a code no migration raises is what direction 3 of
// `pnpm sqlstate` refuses. The allocated test port band `{ start: 16_100, width: 300 }` was NOT used and
// is NOT declared: this unit starts no server, and a declared-but-unused band fails
// `apps/web/src/test-ports.test.ts`.
//
//
// 122 is 0122_cash_forecast_agent.sql (R-REP-06) — two rows and no schema: the `agent_definition` and
// `agent_heartbeat` rows behind the weekly 13-week cash-forecast cron.
//
// Worth a paragraph for what it does NOT contain, because three units in a row decided the opposite way
// and this one nearly did. R-REP-02, R-REP-03 and R-REP-04 each released their migration number unused on
// the same argument — the arithmetic is pure, and a private code is for a refusal that needs a runbook
// answer at the database boundary — and all of that holds here too. **The forecast is not materialised**:
// ADR 0064's reasoning reaches one subject further, because a stored 13-week snapshot is a second
// statement of a figure that would disagree with the recomputed one the first time a booking was
// cancelled. What this unit has that those three did not is a CRON, and `apps/worker/src/job.ts` requires
// an agent on any job with one — "a cron nobody watches is the failure G-AGT-01 exists to remove". An
// agent is a row, so it is a migration, and that is the whole of the file.
//
// The declared interval is seven days, so the watchdog's "no success within twice the interval" means two
// Sundays with no forecast rather than a number this migration chose. The budget is 0: the pass makes no
// outbound call, writes nothing and logs one line.
//
// It seeds NO `reporting.calendar_observance` row and NO `premises_hours_override` row, deliberately.
// The dates are `Y9-holiday-calendar` and 0110 ships that table empty because "a plausible lunar date is
// indistinguishable from a confirmed one" in the one place every report keys on; seeding one here would
// invent in a replayed migration the figure 0110 refused to invent. The mechanism is built over whatever
// the table holds and `packages/fixtures/src/cash-forecast.itest.ts` proves it against rows the suite
// inserts — including the Ramadan hours override that changes the seasonality index with no code change,
// which is R-REP-06's third acceptance line.
//
// The SQLSTATE band ZY281-ZY290 and the test port band { start: 17_000, width: 300 } allocated to this
// unit are released UNUSED and the codes are deliberately left unregistered, because `pnpm sqlstate`
// refuses an entry for a code no migration raises — and nothing here can be refused by the database,
// since nothing here writes.
//
//
// 123 is 0123_hr_holiday_calendar.sql (P-HR-10) — the operational holiday calendar, the announcement a
// confirmed lunar date rests on, and the refusal that stops a Ramadan hours override stranding a booking.
//
// Two tables, `holiday_observance` and `holiday_confirmation`, and no third: `premises_hours_override`
// already exists (0011) and what this file adds to it is a refusal. Still EMPTY on a fresh database, and
// that is the unit's largest decision rather than an omission — every date is `Y9-holiday-calendar`, and a
// plausible lunar date is indistinguishable from a confirmed one in the one place the rota, the payslip
// and three reports all key on (brief rule 15). A date seeded here would be invented in a REPLAYED
// migration, so every tree would carry it and nothing would say where it came from. There is deliberately
// no "seed the UAE public holidays" helper anywhere in `packages/db` either.
//
// **The confirmation STATE is a column**, `holiday_observance.confirmation_state`, in {provisional,
// confirmed} — not a boolean, because the two states are two positive claims about where a date came from
// rather than the presence and absence of a flag. `holiday_observance_provisional_names_a_question` holds
// it to the OPEN-QUESTIONS id that owns it, which is 0110's convention and 0026's before it.
//
// **ZY291 is the successor to 0110's `calendar_observance_lunar_is_provisional`**, and 0110 asked for it in
// so many words: that CHECK refuses a lunar-dated observance that is not provisional and its own comment
// says it "is safe to assert NOW because nothing in this build can record an announcement". Something can
// now, so the flat refusal became a refusal of the correct answer. Its successor is the same rule with the
// escape it was always missing — a lunar-dated observance may be `confirmed` only where a
// `holiday_confirmation` row names the announcement — which keeps the claim 0110 was making (a lunar date
// presented as settled with nothing on file is refused) and admits the one it could not express.
//
// `reporting.calendar_observance` is NOT dropped and `reporting.dim_date` is NOT re-pointed, which is the
// one thing 0110's deferral asked for that this file does not do. The reason is measured and is recorded as
// a NOTE on P-HR-10's manifest entry: thirteen files read that table, `cash-forecast.itest.ts` asserts the
// constraint BY NAME, gate block 151 rests on that assertion and two ADRs describe it. Removing it is an
// integrating change across three units' committed work, not a unit's.
//
// **ZY294 and the one statement of "stranded".** `holiday_override_stranded_appointments(...)` is a SQL
// function, and both the refusal and `readStrandedAppointmentsForOverride` call it — so the report a screen
// renders and the refusal the database makes cannot name different appointments. The alternative drifts in
// the dangerous direction: an empty report beside a failing write. It compares the ROOM period, treatment
// plus that appointment's own turnaround, because a treatment finishing at 01:55 with a 20-minute
// turnaround needs the premises open until 02:15 and comparing the treatment alone accepts an override
// that sends the last customer out through a locked door. `packages/core/src/availability/hours-override.ts`
// states the same rule in TypeScript because `packages/core` is pure and SQL cannot read it, so the check
// that holds the two equal ships in the same commit — `holiday-hours-agreement.itest.ts`, driving one
// probe set through both, which is 0117's `is_card_shaped`/`cardShapedRuns` arrangement.
//
// Three constraint triggers are DEFERRABLE INITIALLY DEFERRED and each one has to be. ZY291 and ZY293 fire
// at COMMIT so the repository may confirm the observance and record the announcement in either order;
// immediate would have forced one order and made the natural one impossible. ZY294 is deferred so a
// transaction can move the affected appointments AND narrow the hours — immediate makes each impossible
// without the other, which is a refusal with no way to comply.
//
// An observance does NOT close the premises and changes no trading hour. `premises_closure` carries
// `kind = 'public_holiday'` and looks like the calendar; 0110's header records the direction of the error,
// and Y9-overtime states that a public holiday the salon trades through has no closure row at all. So a row
// here is a PAY and ROTA fact — which bucket a worked minute is paid in, and what the rota screen shows —
// and "a provisional holiday changes no availability" is true by construction rather than by a flag
// somebody remembered to check.
//
// SQLSTATEs ZY291-ZY294 of the allocated band ZY291-ZY300; ZY295-ZY300 are left FREE and deliberately
// UNREGISTERED, because an entry for a code no migration raises is what direction 3 of `pnpm sqlstate`
// refuses. The test port band { start: 17_300, width: 300 } is RELEASED UNUSED: this unit starts no server,
// the calendar is rendered by P-HR-06's existing rota handler and the pure render is asserted in
// `apps/web/src/hr-rota-render.test.ts`.
//
// 124 is 0124_deposit.sql (Y-PAY-06) — one account, one tender type, one append-only table and six
// refusals: a deposit is money received against ONE appointment, held as a liability until the treatment
// is delivered.
//
// Three decisions in it are worth a paragraph, because each was a choice between two codes or two
// vocabularies that both looked right.
//
// **`2045 Customer deposits held` is a NEW account and not `2050`.** 2050 is Deferred revenue — packages,
// it has the right type and the right side, and it was sitting there. docs/01 decision 19b is why not: a
// deposit "is not a prepaid product", and the whole reason 19b admits packages and nothing else is that
// "one prepaid product means one deferred-revenue path, one liability account, one migration artefact and
// one VAT date-of-supply question". Posting a deposit to 2050 would put a second kind of money into the
// outstanding package liability R-REP-05 reports and H-MIG-03 reconciles to a workbook, and nothing on a
// journal_line would say which kind it was.
//
// **Applying a deposit is a fifth `tender_type` and not a mechanism of its own.** 0105's rule for this
// exact decision is "reuse a word when it means the same thing, and do not reuse one when it does not",
// and `payment` means ONE SETTLEMENT against an issued document — which is what a deposit release is.
// Three things read those rows and nothing else: ZT001, the ceiling that stops a document being overpaid;
// `invoice_payable_fils`, the outstanding figure; and `TenderPostingDisagrees`. A release outside that
// vocabulary would be a second answer to how much of a document is paid, and the first answer would say
// the invoice was owed in full for ever. `deposit_on_account` is therefore the only tender type whose
// posting account is a LIABILITY: every other kind debits an asset because money is arriving, and this one
// debits 2045 because a liability already recorded is being discharged.
//
// **The VAT treatment is an open question, `Y11-vat-deposit`, and no rate is applied.** A payment received
// before a supply can be a date of supply in its own right. The provisional answer is the SHAPE of
// Y11-vat-package's — the deposit is held at its whole gross, UNSPLIT, and the invoice carries the entire
// net/VAT split on delivery — and ZY303 is that reading as a refusal. Holding it unsplit is what makes the
// other answer a new entry rather than a restatement: there is no net and no VAT figure on a deposit row to
// have been wrong. `vat201_box_mapping` carries 2045 as `out_of_scope` with 2050's own wording, which is
// not the same claim: the question decides which ENTRY is posted, not whether an account holding money
// owed feeds a box — 0078 records the identical separation for ZG005.
//
// `deposit_movement.appointment_id` carries NO foreign key, which is `invoice_appointment`'s decision
// (0063) for its stated reason: `truncate appointment` would break in four suites, in teardown, after
// their assertions had passed. ADR 0057's cumulative figure is the primitive — `held_before_fils` and
// `held_after_fils` on every row, with a CHECK for the per-row identity and ZY304 for the chain — and the
// live balance is the VIEW `appointment_deposit_balance` rather than a stored column, which is that ADR's
// rejection of a second statement of a sum the rows already make.
//
// ZY301-ZY306 of the band ZY301-ZY310 are used; ZY307-ZY310 are released UNUSED and deliberately
// unregistered, because `pnpm sqlstate` refuses an entry for a code no migration raises. The test port band
// { start: 17_600, width: 300 } allocated to this unit is released UNUSED: nothing here starts a server.
//
// 125 is 0125_analytics_consent.sql (A-MEAS-02) — the analytics consent record, the four Consent Mode v2
// signals a session carries, and the dispatch queue the gate governs.
//
// One paragraph for the decision that shapes the whole file, because the obvious alternative is what every
// reader will reach for first: `analytics.consent_record` holds NO identifier and names no visitor. ADR
// 0066 and A-FIRST-05 create `analytics.visitor` AT consent, inside `ingestCollectBatch`, which is "the
// ONE place the server decides who owns an identifier" — so at the instant the banner is answered there is
// no visitor row yet, and minting one here would be a second identifier-minting site. A nullable
// `visitor_id` was the alternative and is worse: NULL for the common case, so mostly empty and mostly
// useless, while costing a foreign key into a table the retention pass purges every 90 days — the
// contradiction 0024 and 0056 both refuse, since the parent's DELETE either fails or rewrites history. The
// price is stated out loud in 0125's header: nothing says WHICH visitor made which decision, and the
// operative state the gate reads is four boolean columns on `analytics.session` instead.
//
// Those four columns are `not null default false`, and the default is the most important value in the
// migration. A gate that defaults to granted is a gate that opens by accident: with `false`, a writer that
// forgets them suppresses every outbound dispatch and writes a visible `suppressed` row, and the omission
// is in the one place somebody would look rather than in an ad account.
//
// The gate is stated THREE times and that is deliberate, with two checks holding them together.
// `CONSENT_GATED_TARGETS` in `packages/core/src/analytics/consent-gate.ts` is the pure one.
// `analytics_dispatch_destination` is the database's, four booleans named one for one against the session's
// four columns, and `packages/fixtures/src/analytics-consent.itest.ts` holds those two equal in BOTH
// directions — it is the only package that may import core and db together (ADR 0001 is why the writer
// here cannot ask the pure gate at all). The COMPARISON, which is the part that could silently invert, is
// stated ONCE: `dispatch_consent_gap(session, destination)` is called both by the ZY312 trigger and by
// `enqueueAnalyticsDispatch`, so the state the writer chooses and the state the trigger permits cannot
// disagree.
//
// ZY311 makes `analytics.consent_record` append-only for every role, `berelax_retention` included —
// that role holds UPDATE and DELETE here through the schema's default privileges while the policy row says
// `keep_indefinitely`, so a write from it would be a bug and an exemption would make it a silent one.
// ZY312 refuses a dispatch reaching `queued` or `sent` while a required signal is missing, on INSERT and
// on UPDATE; the UPDATE half is what makes a withdrawal airtight, because the withdrawal clears the
// session's columns and a cancelled row therefore cannot be reinstated and transmitted. ZY313 through
// ZY320 are RELEASED unused and deliberately left unregistered, since `pnpm sqlstate` refuses an entry for
// a code no migration raises.
//
// Version 1 of the banner's words is inserted HERE rather than by the seed, unlike C-CRM-03's four drafts,
// and the difference is what each is for: those are drafts of a statement a human reads off a form, while
// this is text a public page renders to every visitor and no consent record can be written without a
// wording row to reference. The same bytes are also `ANALYTICS_CONSENT_WORDING` in `@berelax/shared`,
// because `/` and `/ar` are prerendered and a build-time database read would either fail the build on a
// machine with no database or bake whatever that machine held. So the words are written twice and the
// check that holds them equal is STRUCTURAL: `recordAnalyticsConsent` resolves the row BY THE HASH of the
// constant's bytes, so a tree whose copy was edited without a new version being published cannot find a
// wording row and every write is refused by name.
//
// The queue is `public.analytics_dispatch` and not `analytics.dispatch`. It behaves like `outbox_event`,
// A-MEAS-03's own title calls it `analytics_dispatch`, and keeping it out of that schema keeps one claim
// honest: a base table there needs a `retention_policy` row, and these rows leave with the session they
// are about by `on delete cascade`, so `keep_indefinitely` would be false and `raw_row_purge` would
// declare a purge the cascade has already done.
//
// 127 is 0127_whatsapp_ref_lifetime.sql (A-FIRST-07) — the ref loop closed: a code that expires, a handle
// that cannot carry a person, an attribution that names the session it was proved against, and the
// day-level counts a capture rate is read off.
//
// 0079 built the booking side of this join and left three things to "the unit that owns the conversation".
// Each of them turned out to be a decision rather than a gap, and the three are worth finding here because
// each has an obvious alternative that is wrong in a way a reader would have to reconstruct.
//
// **The expiry is STORED, and an expired code is never recycled.** `expires_at` is stamped at issue from
// `booking.whatsapp_ref_ttl_days` (Y12-ref-ttl, provisionally 7 days) rather than recomputed at claim time,
// because recomputing it would mean that answering the TTL question retroactively moved the recorded
// outcome of bookings already taken — a booking filed as `ref_expired` in March reading as `matched` in
// April with no row having changed. And the code is not reissued after it dies, which is the step a TTL
// invites: the four characters live in the customer's chat history, not in our database, so handing them to
// a second conversation makes a two-week-old message attribute a booking to a stranger's session. That is
// the confident wrong join the alphabet's I/O/0/1 exclusions exist to prevent, arriving by another door.
// The primary key therefore has no expiry in it and `issueWhatsappRef` redraws on a collision, inside the
// TTL window and outside it alike.
//
// **`session_reference` is a uuid, and the type IS the PII decision.** 0079 made it `text` and opaque. Every
// other column on that row is one step from a person — the code is read off a phone screen and typed back
// in at a counter — so a text handle is a column a later unit could put a phone number, an email address or
// a name into with nothing to notice. A blacklist CHECK cannot close it: `session_reference !~ '[0-9]{6}'`
// refuses most uuids as well, because a hex string is six consecutive decimal digits somewhere about four
// fifths of the time. The guard is positive instead — the only value the column accepts is a uuid, and a
// uuid cannot be a contact detail. It is still NOT a foreign key and still not named `session_id`:
// retention purges a session at 90 days and an attribution has to outlive the session it is about, so
// neither CASCADE nor RESTRICT is available, and a name that promised a key would be a lie about which of
// the two rows is allowed to disappear.
//
// **An attribution is refused at the database boundary, not only in the rule.** `attributed_session_id` is
// on `booking_whatsapp_ref_capture` and not on `booking`, for the reason 0079 rejected a `whatsapp_ref`
// column there. The three CHECK constraints state what one row can state; the two facts that live on
// ANOTHER row cannot be a CHECK, and they are the two SQLSTATEs this file takes:
//
//   * **ZY331** — a `matched` row naming a code whose lifetime had run out. A `conflict` to a caller,
//     because it would have been accepted an hour earlier and the remedy is a different outcome on the same
//     booking rather than a failed booking. The ref field never blocks one (0079's acceptance line).
//   * **ZY332** — a `matched` row naming a session the code was not issued into, or naming no code at all.
//     An `invariant_violated`, because this code and not the person at the counter constructed it.
//
// ZY333 through ZY340 of the allocated band ZY331-ZY340 are left FREE and deliberately UNREGISTERED: an
// entry for a code no migration raises is what direction 3 of `pnpm sqlstate` refuses.
//
// **The capture rate is a rollup table and not a `daily_funnel` row**, which A-FIRST-01 deferred here in so
// many words ("day-level rather than step-level figures"). `analytics.daily_funnel` is keyed on
// (trading_date, step, source, medium, campaign) and holds `entered` and `excluded`; a code ISSUE is not
// one of the eight funnel steps, has no origination tuple of its own, and "claimed" is not an exclusion.
// Writing it there needs either a ninth enum member no funnel draws or a second meaning for two columns
// A-FIRST-09 and A-FIRST-10 read. So `analytics.daily_ref_capture` is a fourth rollup beside the three of
// 0096, on the same keep-indefinitely policy, keyed on `analytics.session`'s own
// (trading_date, trading_date_basis) pair so a funnel can join the two without a second opinion about what
// a trading date is. It is RECOMPUTED from both tables on every write rather than incremented — a counter
// beside the rows is a number that can disagree with them, and the disagreement is invisible because the
// rollup is the thing everybody reads.
//
// Two things this migration deliberately does NOT contain.
//
// **No WhatsApp provider, credential or sender id.** The loop needs none, and that is the shape rather than
// a deferral: the message is composed as a `wa.me` URL and SENT BY THE CUSTOMER'S OWN CLIENT, so there is
// no outbound call to make. The server-side WhatsApp send stays `unregistered` in
// `SENDER_IDENTITY_ROUTES` (ADR 0016) and nothing here touches it.
//
// **No purge of a dead unclaimed code.** A code a booking is attributed to must survive, which the capture
// row's ON DELETE RESTRICT already enforces; a code that expired with nothing referencing it has no purpose
// and should eventually go. That is a nightly pass, and a cron needs an agent row and a job — it is handed
// to A-FIRST-09, which owns the nightly rollups, with `whatsapp_ref_expires_at_idx` created here as the
// predicate it will need. `whatsapp_ref` is in `public` rather than `analytics`, so 0096's
// `retention_policy` does not cover it and its absence from that list is not an omission.
//
// **The alphabet loses `U` and `L`**, and the CHECK on `whatsapp_ref.ref_code` is dropped and re-added for
// it. 0079 excluded I, O, 0 and 1 as the characters a person misreads off a screen; with those gone, a
// misread of `L` as `1` or `I` produces a value that is not a code at all and resolves to `unknown_code` —
// a visible warning and an honestly unknown attribution. `U` misread as `V` is the ONLY remaining pair in
// which the wrong character is itself in the alphabet, so it is the last one that can produce another
// VALID code and credit a booking to somebody else's conversation. Safe to narrow in this migration and
// not in a later one: the table is still empty, so no issued code is retrospectively refused by a column
// that no longer admits it. 30^4 = 810,000 is still orders of magnitude more codes than this business will
// issue.
//
// The allocated test port band { start: 18_500, width: 300 } was NOT used and is NOT declared: this unit's
// round trip is `apps/web/src/whatsapp-ref-loop.itest.ts`, which drives the real ingest, the real issue
// route and the real claim as FUNCTIONS against a real PostgreSQL and starts no server — and a
// declared-but-unused band fails `apps/web/src/test-ports.test.ts`.
//
// 128 is 0128_reply_posting_claim.sql (G-REV-06) — the approval queue's two refusals: a manual posting is
// a NAMED HUMAN'S CLAIM, and a delivered reply's record is frozen. No table and no column, so there is no
// Drizzle mirror to extend.
//
// The first is the unit. There is no Business Profile API access in this build (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api), which is the
// whole reason an approval queue exists at all — so at the moment `posted_manually_at` is written,
// **nothing in this system has seen the reply on the listing.** A person pressed a button to say they had
// pasted it into Google. A row recording only *the reply was posted at 14:02* is a fact nobody is
// answerable for, and the first question asked of it — who said so? — has no answer.
//
// The claimant is deliberately NOT a second column. `audit_event` already carries `actor_kind`, `actor_id`
// and `occurred_at` for every write in this build, and a copy of the actor on `google_reviews` would be
// the brief's "a second statement of a fact drifts" with the drifting copy on the row an auditor reads.
// What was missing was any guarantee the trail is THERE, so ZY341 is a deferrable constraint trigger
// refusing the delivery at COMMIT unless an `audit_event` in the same transaction attributes it to a staff
// actor with a non-null `actor_id` — ZZ004's shape (0093), for ZZ004's reason: an audit row written in a
// later transaction is not the same promise, because the delivery can commit and the audit can fail.
// `actor_kind = 'staff'` is not enough on its own, since a row whose label names a SURFACE satisfies it,
// and that is what the diary, the pipeline board and the quick-book screen correctly record for
// themselves — they have no session to read. This screen does (W-SYS-11).
//
// It fires on the UPDATE only, and the hole is stated rather than hidden: an INSERT arriving with the
// timestamp already set slips past. That is because rows like that exist and are correct —
// `packages/db/src/schema/reviews.itest.ts` inserts one to prove 0020's decision that the two modes'
// timestamps coexist and exclude each other per row, which is a claim about a row's SHAPE rather than
// about a queue action. Demanding an audit row from that probe would make this migration refuse a correct
// test of a different rule, and the way that gets resolved under pressure is by weakening the rule. No
// production path inserts a delivered row.
//
// ZY342 is what G-REV-05 deferred here by name — "immutability after delivery is a trigger that unit
// should add". AFTER DELIVERY and not after approval, because this unit's screen has two steps: an owner
// approves a reply, reads it again, and may edit it before pasting it anywhere. So a re-approval
// overwrites the stamp and writes a second `google_review.reply_approved` row carrying the new hash, and
// the append-only trail (ADR 0008) is what keeps every version recoverable.
//
// Once a delivery timestamp is set, the lint VERSION, the DIGEST and an already-set delivery instant are
// frozen — and `reply_approved_text` and `reply_lint_passed_at` deliberately are NOT, which is the sharper
// half of the design and was arrived at by being wrong first. Freezing the text destroys the detector:
// `reproduceReplyLint`'s `content_changed` outcome is "the stored text no longer hashes to the stored
// digest", and it is reachable only because the digest cannot move. Freeze both and an edited row is
// indistinguishable from an untouched one; freeze neither and whoever edits the text recomputes the hash
// and nothing notices. Freezing exactly the digest is what makes an edit DETECTABLE, which is the honest
// limit `deliver.ts` already states: the floor stops the accident, the reproduction catches the
// fabrication — and `reply-delivery.itest.ts` constructs precisely that row, which is how this was found.
// `reply_lint_passed_at` is outside it for a plainer reason: nothing compares it, and the one writer that
// legitimately touches a delivered row sets it to `now()` in the same statement, so a trigger raising
// there would answer `review-queue.itest.ts`'s assertion about `google_reviews_delivery_fields_match_mode`
// with this code's name instead.
//
// `confirmed_at` is not frozen — it is Google's acknowledgement arriving after an API submission, so it is
// written on an already-delivered row by construction. Neither does ZY342 fire on a NULL instant becoming
// non-null on a delivered row: that is the both-modes contradiction, and
// `google_reviews_delivery_fields_match_mode` (0020) is the rule that names it, asserted by name in
// `review-queue.itest.ts`. A BEFORE trigger raising first would answer that assertion with this unit's
// code instead, which is how a correct test of one rule comes to be about another.
//
// Both are triggers rather than CHECK constraints because neither claim is about one row's columns: ZY341
// reads `audit_event`, which no CHECK may do, and ZY342 compares NEW to OLD, which a CHECK cannot see.
// ZY341-ZY342 of the band ZY341-ZY350 are used; ZY343 through ZY350 are released UNUSED and deliberately
// unregistered, because `pnpm sqlstate` refuses an entry for a code no migration raises.
//
// 130 is 0130_appointment_migrated.sql (H-MIG-05) — one boolean on `appointment`, one append-only record
// table, six refusals and a fifth value on `booking.source`: a visit reconstructed out of the previous
// arrangement's records is history the live machine cannot touch.
//
// Three decisions in it are worth finding here rather than in the file, because each is the kind a later
// reader would simplify.
//
// **It is a flag on `appointment` and not a `historic_appointment` table.** The imported visits have to
// appear in the customer's record and in the retention cohorts, and both read `appointment` — the second
// through `reporting.fact_appointment`, which is a view over it. A parallel table would mean a `union all`
// in every one of those readers and a shorter history than this business has wherever one was missed, and
// it would put the rows outside `appointment_therapist_no_overlap` and `assert_room_capacity`, which are
// exactly what make "no double-booked therapist, no room over capacity" a checkable claim about the
// imported dataset. A tenth `appointment_status` was the other alternative and fails on totality: 0051's
// transition and action tables are `Record<AppointmentStatus, …>`, so a tenth label needs fifteen
// transition answers and an `emitsRevenue` answer for something that is not a state of the machine.
//
// **ZY366 — no migrated row may END in the future — is the refusal that does the most work.**
// `readCommittedAppointments` takes a trading date and `readReassignmentCandidates` takes an instant
// floor, so a reconstruction that cannot be dated forward is a row no forward-looking read can reach. The
// alternative was `and not a.migrated` in each of those queries, which is the same claim restated in every
// reader that grows later. It is a trigger and not a CHECK because `now()` is not immutable, and it judges
// the UPPER bound so a treatment that ran past midnight two hours ago still imports.
//
// **The importer posts NOTHING, so the P&L claim needs no filter.** No invoice, no payment and no journal
// entry: a statement line is a directed sum over `journal_line` (ADR 0064), so a visit outside the ledger
// contributes zero to every line of every statement, and `visit-import.itest.ts` asserts it as the census
// — a count and two sums with no account set in them — rather than as a statement that might net to
// nought. `vat_rate_bp = 0` and `vat_fils = 0` are a CHECK for ADR 0069's reason: this system posts no
// output tax on a supply made before its books opened, and there must be no tax figure on the row for
// anything to add up. The migration therefore touches no money table at all, so
// `packages/fixtures/src/invoice-family.ts`'s lists are unchanged — `imported_appointment`'s only foreign
// key is into `appointment`, which no family list names.
//
// ZY361-ZY366 of the band ZY361-ZY370 are used; ZY367-ZY370 are released UNUSED and deliberately
// unregistered. The test port band { start: 19_400, width: 300 } offered to this group is released UNUSED:
// nothing in H-MIG-05 starts a server.
//
// 131 is 0131_staff_import.sql (H-MIG-06) — one column on `leave_movement`, one append-only record table
// and four refusals: the nineteen employment records, and the four things this import will not infer.
//
// Three decisions in it are worth finding here rather than in the file.
//
// **`leave_movement.day_basis` is a CONFIRMATION and not an arithmetic.** `0066_leave.sql` settled that
// the statutory entitlement is counted in calendar days ("a leave day is a calendar day, never a working
// day") and `hundredths` is in those units throughout this ledger; nothing in 0131 changes that, and a
// migration that did would contradict a locked decision. What ZY371 asks is the question
// `0092_leave_approval.sql` already asks of a leave REQUEST from the other end — ZY020 refuses a period
// bounded by a midnight inside a trading session — applied to the BALANCE every such request will be
// spent against. This business opens on every date, so the two readings are the same quantity today;
// which is exactly why nobody would notice the question was never asked, and why the refusal's own
// message COUNTS, from `business_day`, how many dates of the covering leave year are not trading days.
//
// **ZY372 — a zero opening balance must be marked provisional — is a trigger and not a CHECK**, because
// the message has to carry the remedy and a CHECK violation names the constraint and prints the failing
// figure, which here is a zero and says nothing about what to do. docs/11 §7 is the authority: the
// accrual engine needs a real opening balance rather than a zero, and nineteen silent zeros are a
// business with no leave liability at all — a figure that reaches an end-of-service calculation and
// nothing that would query it.
//
// **There is NO column anywhere in this migration, and no cell in the workbook behind it, for a bank
// account, an Emirates ID number, a passport number, a visa number or a wage.** That is the unit's main
// decision and it is an absence, so it is easy to read as an omission. `import_row.payload` is kept for
// ever and no erasure reaches it (ADR 0072, Y9-import-ledger), so an IBAN in a staff workbook is an IBAN
// in that ledger permanently — strictly worse than the plaintext column `employee_bank_detail` was built
// to avoid, because that column does not exist and this one could not be removed afterwards. What the
// import DOES write about a credential is its type and its expiry, which is the half
// `readEligibleTherapists` gates availability on; a document number is not in that path at all.
// `employee.is_publishable` is untouched for the same kind of reason: it is already GENERATED from
// `display_name` and `photo_consent` (0030, decision 23), so an import cannot publish a therapist
// whatever it writes, and re-stating the rule here would be the second statement that drifts.
//
// ZY371-ZY374 of the band ZY371-ZY380 are used; ZY375-ZY380 are released UNUSED and deliberately
// unregistered. No test port band is used: nothing in H-MIG-06 starts a server.
//
// 132 is 0132_opening_boundary.sql (H-MIG-07) — no table and no column, four refusals and three
// triggers: once an opening balance is attested, nothing may be dated behind its boundary. The Drizzle
// mirror is therefore unchanged and `pnpm db:drift` has nothing new to compare, which is 0117's shape.
//
// **The hole it closes, and why it is not theoretical.** `refuse_entry_before_opening()` (0027) exempts
// `source in ('opening_balance', 'reversal')` and gives the reason: the opening entry has to be
// insertable, and it commits BEFORE the import row exists to guard against it. That exemption is correct
// for exactly one entry and permanent for every other — and H-MIG-03's reconstructed package liability
// posts on `opening_balance` (ADR 0069), so the opening position in this build is a SET of entries and a
// second one could be dated anywhere behind the boundary at any time. The books would still balance;
// they would simply be larger, which 0027's own header names as undetectable afterwards. `ZY381` refuses
// anything dated before the boundary whatever its source, and `ZY383` refuses a further
// `opening_balance` entry dated ON it.
//
// It follows that **the package liability must be imported BEFORE the opening trial balance**, which is
// the dependency H-MIG-07's manifest entry already declares: the trial balance is the statement of the
// whole opening position, so anything belonging in it has to be in the books before it is attested.
//
// **The relationship between the two imports, stated here because it is the thing a reader needs.** The
// trial-balance file states the FULL balance of every account — which is what somebody can check against
// the books they are copying from — and the importer posts the REMAINDER after reading what
// `opening_balance` entries already hold at the boundary (`readOpeningBalancePostings`, and
// `openingRemainder` in `@berelax/core` for the arithmetic). A stated figure BELOW what is posted is
// refused by name and never netted the other way: ADR 0071 settled that a posting from outside the
// package path is "a named variance rather than one absorbed", and this is that rule at the opening.
// `reconcileOpeningPosition` is the per-account read the acceptance line's reconciliation test asserts
// to the fils.
//
// **`ZY382` holds the attested totals to the entry they NAME, and not to every `opening_balance` line at
// the boundary.** The wider reading was built first and is wrong for a mechanical reason worth recording:
// `importOpeningBalances` (0027's own writer, in `services/opening-balances.ts`) computes its totals from
// its own lines, so the moment any other entry shared the boundary that existing and tested writer would
// have stopped being able to commit at all. 0027 left those totals "derived, and asserted against the
// lines by the itest rather than trusted"; ZY382 is that assertion moved into the database, which matters
// because `ZY384` makes the row append-only so nothing would ever re-derive them.
//
// **No `period_lock` row and no new table.** `period_lock` is for closing a month that has been reported
// (0073) and its exclusion constraint is over dated ranges; the pre-boundary period has no start that is
// not invented, and `raise_if_period_locked` would be a second answer to the question ZL004 and ZY381
// already answer. The chart of accounts is not seeded, extended or re-tagged either:
// `account_carries_a_vat201_attribution` (0089) demands an attribution per account, and an attribution is
// a decision about what feeds a VAT return rather than a column somebody fills in to get an import to
// run — so `importers/ledger/coa.ts` CHECKS the chart and the importer refuses a file naming an account
// it does not hold.
//
// ZY381-ZY384 of the band ZY381-ZY390 are used; ZY385-ZY390 are released UNUSED and deliberately
// unregistered. No test port band is used: nothing in H-MIG-07 starts a server.
//
// 134 is 0134_payment_mandate.sql (Y-PAY-07) — the card-on-file mandate as a RECORD that a mandate exists
// at a gateway, and the fee charge path made provably disabled by a trigger rather than by a comment.
//
// The decision the whole file turns on is that a mandate row is EVIDENCE, not configuration. It says a
// specific person was shown a specific disclosure at a specific instant and agreed to a specific maximum,
// so ZY421 refuses every UPDATE and DELETE on it for every role including the owner — ADR 0008's argument
// for `audit_event` applied to the one row whose edit would restate what somebody consented to. That
// forces revocation out of the row: `revoked_at` would be an UPDATE, so a revocation is a row in
// `payment_mandate_revocation` keyed ON the mandate id, which also makes revoking twice impossible. The
// live state is the VIEW `payment_mandate_status` over the dates and that row, which is ADR 0057's shape
// one subject along from `appointment_deposit_balance`; a stored `state` column is the dangerous
// alternative for a specific reason — nothing runs at the instant a mandate expires, so it would read
// `active` for ever and the charge path would read `active` from a lapsed authority.
//
// There is NO column here able to hold card data and the absence is structural rather than conventional:
// no PAN, no expiry, no CVV, no last-four and no BIN, because each fragment is individually defensible and
// the set of them is a cardholder data environment this build is not in (ADR 0067). ZY423 refuses a
// card-shaped `token_reference` by CALLING 0117's `is_card_shaped()` — never a second Luhn check, which
// `pnpm saq-a` refuses tree-wide because the second detector is the one that misses the spelling with
// spaces in it. A separate code from ZY231 and not a branch added to `refuse_card_shaped_payment_text()`
// by `create or replace`: the two are different rules over one shape — free text a PERSON typed against a
// value a GATEWAY returned — and `create or replace` would put one function's body in two migration files,
// so whichever reads second silently wins.
//
// **ZY426 is the unit.** No `mandate_charge_attempt` row may read `charged` while
// `cancellation_fee_policy_on_file()` answers false, which it does. That is "the charge path ships
// disabled" written where PostgreSQL enforces it rather than where a second call site would not read it,
// and it is a REFUSAL and never a charge of zero fils: a zero posts, balances, and reports as a fee
// correctly worked out to be nothing, so the figure ends up in the books as a decision nobody made (ADR
// 0070, and Y9-commission's recorded version of the same mistake). The figure itself is an ARGUMENT
// everywhere — `cancellationCharge()` answers zero for every input and `Y9-windows` says "24h window, no
// fee charged, flagged only" — so nothing in this unit derives a fee, and `cancellation_fee_policy_on_file()`
// reads no setting at all, because a function that fell back to false over a missing row would make "the
// policy is off" and "nobody has recorded a policy" indistinguishable.
//
// The order of the three attempt refusals is the REVERSE of the obvious one, and that is what keeps four
// of the five acceptance lines reachable: ZY425 (not active at the attempt's own instant, never at
// `now()`) and ZY424 (above the cap) are checked BEFORE the policy gate, so the cap rule and the
// revocation rule fire today instead of collapsing into one "no policy on file" message and becoming code
// nobody has ever seen run (ADR 0003). Refused attempts are ROWS rather than an absence of rows, because
// "we tried to charge this customer and the system stopped us" is a fact an operator needs and a refusal
// nothing counts is a refusal nothing can audit.
//
// ZY421-ZY426 of the band ZY421-ZY430 are used; ZY427-ZY430 are RELEASED unused and deliberately
// unregistered, because `pnpm sqlstate` refuses an entry for a code no migration raises.
//
// 135 is 0135_chargeback.sql (Y-PAY-08) — a third party's decision, arriving late, as a dated event with
// its own effect on the ledger, and the refund cap as a refusal rather than a screen's validation.
//
// The decision the file turns on is that a chargeback is never an EDIT. The tempting implementation is
// `captured_fils = captured_fils - disputed`, and it is refused on two grounds: mechanically, that column
// is a projection of the append-only `payment_intent_transaction` rows and ZY163 holds the two equal at
// commit, so the subtraction cannot be written without also writing a fake transaction row; and
// substantively, the capture HAPPENED — restating it would leave the sale's own entry explaining money the
// header says was never taken, with nothing in the database saying which of the two was edited. So a
// dispute is a `chargeback` row with its own `received_at`, its own `trading_date` and its own entry, and
// nothing in `repositories/chargeback.ts` writes to `payment_intent` at all.
//
// **ZY433 is the half a screen would otherwise be the only guard for.** `payment_intent` already carries
// `check (refunded_fils <= captured_fils)`, and that check is satisfied by an intent whose money an
// acquirer has ALREADY taken back: AED 100 captured, AED 100 charged back, and AED 100 still reads as
// refundable — so the business refunds money it no longer has and the figure reconciles at both ends. What
// remains is `captured - refunded - chargedBackNet`, and the trigger is attached to BOTH tables, because
// either side can break it. The ordering that matters is the second: a dispute arriving AFTER a refund
// that was legitimate when it was made — a customer refunded in good faith who then disputes the original
// charge anyway — which a rule attached only to the refund path would miss entirely. Y-PAY-06's deposit
// refund records the same mistake without a third party in it: an uncapped subtraction returns a NEGATIVE
// refund, which posts as money ARRIVING from a cancellation.
//
// ZY432 is the `business_day` primitive as a refusal. Trading runs 11:00-02:00, so an acquirer's notice at
// 01:30 belongs to the PREVIOUS trading date; the caller resolves it with `resolveTradingDate` and the
// trigger checks the answer against `business_day`, because a notice attributed to the calendar date lands
// in a cash-up for a session that had not started and the two days' card totals are then wrong by the same
// amount in opposite directions — an error that reconciles perfectly at every level except the one it is
// wrong at. A notice in no session is REFUSED rather than attributed to the nearest day (ADR 0070): of the
// two available errors only one is detectable afterwards.
//
// `1045 Disputed card receipts` is new and is NOT `1030`: a clearing balance is money the business WILL
// receive and a disputed receipt is money it MAY receive, and a reader who cannot see the two apart cannot
// check either against its own source — ADR 0064's argument for a partition, and 0077's for 2045 one
// liability along. It is not an expense either, because at the moment a chargeback lands the business has
// not lost the money; it has lost the use of it while somebody else decides. The account gets its own
// balance-sheet and cash-flow line for the same reason, and `disputed_card_receipts_account_code()` states
// the code once so the pair with `ACCOUNTS.disputedCardReceipts` is one assertion.
//
// `kind` is a TOTAL partition {received, won, lost} and ZY434 keeps it so, which is what makes 1045 a
// clearing account rather than a place figures accumulate: a resolution with no received event before it
// would credit a balance the account never held, and a second resolution would unwind it twice and leave
// it negative. ZY436 holds a won dispute's entry to being the REVERSAL of its received entry and the pair
// to nought on 1045, read over `journal_line` rather than over the two amounts — because two entries can
// each balance while moving different amounts on one account, which is the only way the identity can fail.
// A hand-built mirror entry would be correct today and would be exactly where the two drifted.
//
// ZY433 and ZY436 are `deferrable initially deferred`, so they fire at COMMIT. A probe inside a savepoint
// that is rolled back never reaches either — the rollback discards the pending check — which is why
// `packages/fixtures/src/chargeback.itest.ts` drives both through real transactions, and it is written
// down here because it cost that suite a run.
//
// ZY431-ZY436 of the band ZY431-ZY440 are used; ZY437-ZY440 are RELEASED unused and deliberately
// unregistered, because `pnpm sqlstate` refuses an entry for a code no migration raises.
//
// 133 is 0133_seo_suggestion.sql (G-SEO-05) — the SEO suggestion store: the before-state is STORED, so a
// change always has a way back.
//
// **Why the before-state is a column and not something the rollback recomputes.** The obvious
// implementation reads what the page says now and works backwards, and it fails in the two cases a
// rollback exists for: an editor who touched the page between the apply and the rollback has made the
// current content a different document, so working backwards destroys an edit nobody asked to lose; and a
// suggestion that changed a title the agent had itself changed a week earlier has no recoverable earlier
// state at all. So `before_regions` and `before_content_sha256` are written at the moment the suggestion
// is drafted. A suggestion that can be applied and not un-applied is a change with no way back, and the
// before/after pair is this unit's primitive rather than a convenience.
//
// `rollback_descriptor` is NOT a second copy of the before-state — that would be two answers to compare on
// the day somebody needs one. It says HOW the stored before-state goes back: the method, and the surface.
// ZY401 is what makes it a claim rather than a blob, because NOT NULL already admits `'{}'::jsonb` and a
// descriptor that says nothing is a rollback nobody can perform, discovered at the worst moment.
//
// **ZY403 is what makes "rollback is exact" a database fact.** An `applied` row's `publication_record`
// must carry `after_content_sha256`, and a `rolled_back` row's must carry `before_content_sha256`. A
// composite foreign key would be better and is what 0093 uses to tie an approval to the hash its lint pass
// cleared; it needs `unique (id, content_sha256)` on `publication_record`, which 0093 did not add, and
// adding a unique index to another unit's append-only evidence table from here would be a wider change
// than this unit needs. The trigger is the narrower answer and it is exact.
//
// **Everything that is evidence is immutable (ZY402) and no row may be deleted at all**, so a suite
// asserts a DELTA on this table and never a total. The state is a sequence rather than a value —
// `proposed` to `approved` or `refused`, `approved` to `applied`, `applied` to `rolled_back` — and in
// particular `refused` to `approved` is refused: what refused a suggestion was a lint version and a
// profile version, so a row promoted past its own refusal would carry a lint stamp for a decision the lint
// did not make.
//
// There is no `approved_by` column: the named approver is `publication_approval.approver_user_id` and
// `approver_display_name`, snapshotted by 0093 so a later rename cannot rewrite who approved what. There
// is no second cost cap either — `agent_definition.budget_fils_per_run` enforced mid-run by
// `createRunBudget` is the cap, and a second one would be a second answer to whether a run may continue.
// `cost_fils` is the `fils_nonneg` domain, the same one `agent_run.cost_fils` uses, so the per-suggestion
// figure and the per-run total it sums into cannot disagree.
//
// The manifest entry for this unit names `packages/db/migrations/0047_seo_suggestion.sql`. 0047 does not
// exist and was never this unit's: the number allocated to G-SEO-05 is 133, and the manifest's file list
// is the only place that said otherwise.
//
// ZY401-ZY403 of the band ZY401-ZY410 are used; ZY404-ZY410 are released UNUSED and deliberately
// unregistered, because `pnpm sqlstate` refuses an entry for a code no migration raises.
//
// 142 is 0142_incident.sql (H-HARD-07) — the incident register, and a statutory clock that starts at an
// event rather than at the paperwork.
//
// docs/04 §9 asks for an incident register and docs/04 §8 asks for a PDPL response while marking the
// whole regulation [UNVERIFIED], including — in so many words — the breach notification threshold and
// deadline. This migration is the register and the clock, and the three decisions in it are all about
// instants.
//
// **`discovered_at` is the clock and `filed_at` is not.** A breach is noticed on a Friday evening and
// written down on Monday morning. If the deadline came from the filing, the statutory clock would
// restart every time somebody got round to the paperwork, and the later the record the more time the
// business would appear to have. They are separate columns, `incident_filed_after_discovery` orders
// them, and the gap is a visible fact rather than an erased one. The deadline is then computed in the
// CIVIL zone and never through `resolveTradingDate`: trading runs 11:00–02:00, so the trading date puts
// 01:30 on the previous day, and `rights-policy.ts` already states the principle — a statutory deadline
// does not move with the salon's trading hours. Using the trading date would hand the business an extra
// day roughly one night in three.
//
// **A filed incident is immutable (ZY521) and `incident_addendum` is the only way to add to it
// (ZY522).** The obvious design is an editable row, because almost everything about an incident is
// learned afterwards, and it fails in the one situation the register exists for: an insurer or a
// regulator asks what was known WHEN, and an edited row reads identically whether a figure was known at
// filing or written in last week. `incident_notification` is append-only too (ZY523) — when somebody was
// told is the fact the whole clock rests on — and ZY525 refuses a notification dated before the
// discovery it answers, which is either a mistyped instant or a backdated record.
//
// **ZY524 is the one that carries the unit, and it is DEFERRED.** A `personal_data_breach` row that
// leaves its transaction without both notification duties dated is refused at COMMIT, so "filing a
// breach creates the duties" is a property of the schema rather than of whichever writer remembered.
// Deferred because the `obligation_instance` rows cannot exist before the incident they reference, so an
// immediate check would refuse every correct filing.
//
// The duties are rows in the calendar 0052 already built rather than a second calendar: it reminds,
// escalates, shows overdue and refuses a completion with no actor. Two things had to move for that.
// `obligation_class` gained `privacy`, because two PDPL duties filed under `licence` would sit beside
// the trade licence renewal where nobody would look for them — it carries `blocking_effect = 'none'`,
// since blocking publishing on an overdue breach notification would be this build inventing a
// consequence 0052 deliberately ties to two classes. And `obligation_instance` gained `incident_id`,
// which joined `obligation_instance_one_per_due_date`: without it, two breaches whose deadlines land on
// the same civil date collide on that constraint and the second filing silently reuses the first's duty,
// so completing one notification would mark the other done. NULLS NOT DISTINCT is kept, so every
// cadence-generated instance behaves exactly as before and the generator's `on conflict on constraint`
// still names a constraint that exists.
//
// **Nothing here names an authority, a contact or a statutory period.** `obligation.authority` is NULL on
// both definitions, which is that column's own stated purpose — a plausible one reads as configured
// (brief rule 15) — and both carry `is_unverified` with an open question. The period is the
// `provisional` setting `pdpl.breach_notification_hours`, so it appears on the Unconfirmed Assumptions
// panel and is corrected by one audited settings change rather than by a release. And the THRESHOLD —
// whether a given breach is notifiable at all — is deliberately decided nowhere: it is a judgement about
// risk to the people affected, every breach filing generates the duty, and closing it is an act with a
// recorded reason. A build that applied a threshold of its own would be deciding not to notify, silently,
// with an absence for evidence.
//
// One defect worth recording, because it is a general trap: `incident_personal_data_categories_nonempty`
// first read `array_length(personal_data_categories, 1) >= 1`, and `array_length` of an EMPTY array is
// NULL rather than 0 — so the comparison was NULL, the conjunction was NULL, and a CHECK evaluating to
// NULL PASSES. An empty category list went straight through and was caught at COMMIT by ZY524 instead,
// naming the wrong rule entirely. It is `coalesce(..., 0) >= 1` now. The blank-element half goes through
// `text_array_has_blank`, an IMMUTABLE function, because a CHECK may not contain a subquery and both of
// the obvious spellings are one.
//
// ZY521-ZY525 of the band ZY521-ZY530 are used; ZY526 through ZY530 are released UNUSED and deliberately
// unregistered, because `pnpm sqlstate` refuses an entry for a code no migration raises.
//
export const SCHEMA_VERSION = 142 as const
