/**
 * @berelax/shared — the only package every other package may depend on.
 * Types, branded primitives and error taxonomy. No I/O, no framework imports.
 */

export {
  CLINICAL_LINT_QUESTION_COPY_SETTING_KEY,
  CLINICAL_OPEN_QUESTIONS,
  CLINICAL_REAL_INTAKE_SETTING_KEY,
  CLINICAL_STEP_UP_WINDOW_CEILING_MINUTES,
  CLINICAL_STEP_UP_WINDOW_MINUTES,
  CLINICAL_STEP_UP_WINDOW_SETTING_KEY,
  clinicalStepUpWindowSchema,
  PROVISIONAL_LINT_QUESTION_COPY,
  PROVISIONAL_REAL_INTAKE_PERMITTED,
} from './clinical.ts'
export {
  COMPLIANCE_CALENDAR_AGENT,
  DEFAULT_OBLIGATION_ESCALATION_OFFSETS_DAYS,
  DEFAULT_OBLIGATION_REMINDER_OFFSETS_DAYS,
  MAX_OBLIGATION_NOTICE_OFFSET_DAYS,
  MAX_OBLIGATION_NOTICE_OFFSETS,
  OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
  OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
  REBUILD_OBLIGATION_NOTICES_JOB,
} from './compliance-notices.ts'
export {
  CREDENTIAL_EXPIRING_SOON_SETTING_KEY,
  credentialExpiringSoonDaysSchema,
  PROVISIONAL_EXPIRING_SOON_DAYS,
} from './credential-window.ts'
export {
  GENDER_MATCHING_MODES,
  GENDER_MATCHING_SETTING_KEY,
  type GenderMatchingMode,
  genderMatchingMode,
  genderMatchingModeSchema,
  STRICT_GENDER_MATCHING,
} from './gender-matching.ts'
export {
  DEFAULT_GOOGLE_REAUTH_REPEAT_CAP,
  GOOGLE_REAUTH_REPEAT_CAP_SETTING_KEY,
  GOOGLE_REAUTH_SMS_SETTING_KEY,
  GOOGLE_REAUTH_TEMPLATE_KEY_LIST,
  GOOGLE_REAUTH_TEMPLATE_KEYS,
  MAX_GOOGLE_REAUTH_LADDER_STEPS,
  REAUTH_REASSURANCE_SENTENCE,
} from './google-reauth.ts'
export {
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDER_NAMES,
  LLM_PROVIDER_SETTING_KEY,
  type LlmProviderName,
  llmProviderName,
  llmProviderSchema,
} from './llm-provider.ts'
export {
  advanceMessageStatus,
  type Channel,
  DELIVERY_REPORTED_FAILED,
  isSendableApproval,
  isTemplateApprovalTransition,
  isTerminalMessageStatus,
  MESSAGE_CHANNELS,
  MESSAGE_CLASSES,
  MESSAGE_FAILURE_REASONS,
  MESSAGE_ROW_FAILURE_REASONS,
  MESSAGE_STATUS_RANK,
  MESSAGE_STATUSES,
  type MessageClass,
  type MessageFailureReason,
  type MessageRowFailureReason,
  type MessageStatus,
  type ReceiptIgnoredReason,
  type StatusAdvance,
  TEMPLATE_APPROVAL_STATES,
  TEMPLATE_APPROVAL_TRANSITIONS,
  type TemplateApprovalState,
} from './messaging.ts'
export {
  DEFAULT_REMINDER_OFFSETS_HOURS,
  MAX_REMINDER_OFFSET_HOURS,
  MAX_REMINDER_OFFSETS,
  REBUILD_SCHEDULED_STEPS_JOB,
  REMINDER_OFFSETS_SETTING_KEY,
} from './reminders.ts'
export {
  BUSINESS_PROFILE_ACCESS_SETTING_KEY,
  configuredReviewLanguages,
  DETECTABLE_REVIEW_LANGUAGES,
  type DetectableReviewLanguage,
  MINIMUM_REVIEW_COOLING_OFF_HOURS,
  REVIEW_AUTOSEND_DISABLED,
  REVIEW_AUTOSEND_SETTING_KEY,
  REVIEW_AUTOSEND_SETTING_KEYS,
  REVIEW_COOLING_OFF_SETTING_KEY,
  REVIEW_REPLY_LANGUAGES_SETTING_KEY,
  REVIEW_REPLY_MODES,
  type ReviewAutosendSettingKey,
  type ReviewReplyMode,
  reviewAutosendEnabled,
  reviewAutosendEnabledSchema,
  reviewCoolingOffHours,
  reviewCoolingOffHoursSchema,
  reviewReplyLanguagesSchema,
  reviewReplyMode,
} from './review-autosend.ts'
export {
  type Assert,
  grossPriceFilsSchema,
  type PriceFreeShape,
  REQUIRED_SKILL_BY_STYLE,
  ROOM_TYPE_NAMES,
  type RoomTypeName,
  requiredSkillFor,
  roomTypeNameSchema,
  SERVICE_DURATIONS,
  SERVICE_SHAPES,
  type ServiceDuration,
  type ServiceInput,
  type ServiceResourceShapeInput,
  type ServiceShape,
  type ServiceSkillRequirement,
  type ServiceVariantInput,
  serviceDurationSchema,
  serviceResourceShapeSchema,
  serviceSchema,
  serviceShapeSchema,
  serviceVariantSchema,
  skillRequirements,
  THERAPIST_SKILLS,
  type TherapistSkill,
  TREATMENT_KEYS,
  TREATMENT_STYLES,
  type TreatmentKey,
  type TreatmentStyle,
  therapistSkillSchema,
  treatmentKeySchema,
  treatmentStyleSchema,
} from './schemas/catalogue.ts'
export {
  CONSENT_ACTOR_KINDS,
  CONSENT_CAPTURE_SOURCES,
  CONSENT_CHANNELS,
  CONSENT_KINDS,
  CONSENT_LOCALES,
  CONSENT_PURPOSES,
  type ConsentActorKind,
  type ConsentCaptureContext,
  type ConsentCaptureSource,
  type ConsentChannel,
  type ConsentKind,
  type ConsentLocale,
  type ConsentPurpose,
  type ConsentRecordInput,
  type ConsentWordingInput,
  consentCaptureContextSchema,
  consentRecordSchema,
  consentWordingSchema,
  isSendGatingPurpose,
  MAX_CONSENT_WORDING_LENGTH,
  PLACEHOLDER_MARKERS,
  SEND_GATING_CONSENT_PURPOSES,
  type SendGatingConsentPurpose,
} from './schemas/consent.ts'
export {
  FLOW_ANALYSIS_RULES,
  FLOW_BOOLEAN_CONDITION_FACTS,
  FLOW_CONDITION_BRANCHES,
  FLOW_CONDITION_FACTS,
  FLOW_CONDITION_OPERATORS,
  FLOW_DEFAULT_BRANCH,
  FLOW_DSL_RULES,
  FLOW_DSL_VERSION,
  FLOW_EXIT_REASONS,
  FLOW_NODE_KINDS,
  FLOW_RULES,
  FLOW_TERMINAL_NODE_KINDS,
  FLOW_TRIGGER_EVENTS,
  type FlowAnalysisRule,
  type FlowConditionFact,
  type FlowConditionOperator,
  type FlowDefinition,
  type FlowDslRule,
  type FlowEdge,
  type FlowExitReason,
  type FlowNode,
  type FlowNodeKind,
  type FlowRefusal,
  type FlowRule,
  type FlowTriggerEvent,
  flowDefinitionSchema,
  flowRuleMessage,
  isBooleanConditionFact,
  isFlowRule,
  MAX_FLOW_ACCUMULATED_DELAY_MINUTES,
  MAX_FLOW_NODES,
} from './schemas/flow.ts'
export {
  isUnsuppressionSource,
  SUPPRESSION_ACTOR_KINDS,
  SUPPRESSION_KEY_KINDS,
  SUPPRESSION_KINDS,
  SUPPRESSION_SOURCES,
  type SuppressionActorKind,
  type SuppressionEntryInput,
  type SuppressionKeyKind,
  type SuppressionKind,
  type SuppressionSource,
  suppressionEntrySchema,
  UNSUPPRESSION_SOURCES,
  type UnsuppressionSource,
} from './schemas/suppression.ts'

/** Nominal typing helper, so an AppointmentId cannot be passed where a RoomId is wanted. */
export type Brand<T, B extends string> = T & { readonly __brand: B }

/** Every error crossing a module boundary is one of these. */
export type ErrorKind =
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'forbidden'
  | 'unauthenticated'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'invariant_violated'

export class AppError extends Error {
  readonly kind: ErrorKind
  /** Safe to show a customer. Anything else is internal-only. */
  readonly userFacing: boolean
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    kind: ErrorKind,
    message: string,
    options?: { userFacing?: boolean; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.kind = kind
    this.userFacing = options?.userFacing ?? false
    this.details = Object.freeze({ ...options?.details })
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError
export {
  addressLines,
  addressOneLine,
  directionsLinkFor,
  formatUaePhone,
  type MapTarget,
  mapLinkFor,
  type PostalAddress,
  telLinkFor,
} from './premises-links.ts'
export {
  addressSchema,
  catalogueSchema,
  FACTS_SCHEMA_VERSION,
  type Facts,
  type FactsAddress,
  type FactsCatalogue,
  type FactsHours,
  type FactsHoursException,
  type FactsOpeningHoursDay,
  type FactsPhone,
  type FactsWhatsapp,
  factsSchema,
  filsStringSchema,
  geoSchema,
  hoursExceptionSchema,
  hoursSchema,
  isoDateSchema,
  localTimeSchema,
  openingHoursDaySchema,
  type ProvisionalFact,
  phoneSchema,
  priceOnRequestSchema,
  priceServiceSchema,
  priceVariantSchema,
  provisionalFactSchema,
  type UnansweredFact,
  unansweredFactSchema,
  whatsappSchema,
} from './schemas/facts.ts'
export {
  MANAGE_BOOKING_PATH_PREFIX,
  manageBookingLink,
  manageBookingPath,
  PREFERENCE_CENTRE_PATH,
  type PreferenceCentreLink,
  preferenceCentreLink,
  preferenceCentrePath,
  RECONNECT_SCREEN_PATH,
  reconnectLink,
  SITE_ORIGIN_ENV,
  SITE_ORIGIN_FALLBACK,
  siteOriginFrom,
} from './site-origin.ts'
export {
  FRONT_DESK_MIN_LEAD_SETTING_KEY,
  isWhatsappRefCode,
  normaliseWhatsappRefCode,
  PROVISIONAL_FRONT_DESK_MIN_LEAD_MINUTES,
  PROVISIONAL_WHATSAPP_REF_EXPECTED,
  WHATSAPP_REF_ALPHABET,
  WHATSAPP_REF_CODE_CLASS,
  WHATSAPP_REF_CODE_HTML_PATTERN,
  WHATSAPP_REF_CODE_LENGTH,
  WHATSAPP_REF_CODE_PATTERN,
  WHATSAPP_REF_EXPECTED_SETTING_KEY,
  WHATSAPP_REF_INPUT_CLASS,
  WHATSAPP_REF_OPEN_QUESTION,
  whatsappRefCodeSchema,
} from './whatsapp-ref.ts'
