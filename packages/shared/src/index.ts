/**
 * @berelax/shared — the only package every other package may depend on.
 * Types, branded primitives and error taxonomy. No I/O, no framework imports.
 */

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
  isTerminalMessageStatus,
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
} from './messaging.ts'
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
