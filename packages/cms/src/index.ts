/**
 * @berelax/cms — the content model, the catalogue boundary and the CMS access policy.
 *
 * Payload itself is not in here. Payload's configuration is executable code that imports Payload and
 * belongs to the app that serves the admin (`apps/web/payload.config.ts`); what belongs in a package is
 * the part two other things have to agree with — the field lists, the rendered document types, the
 * boundary rules and the route prefixes. See `fields.ts` for why the split is where it is.
 *
 * Depends on `@berelax/core` for the authorisation matrix and `@berelax/shared` for the error taxonomy,
 * and on nothing else. No I/O: the future-booking count a retire decision needs is injected, because the
 * table it comes from belongs to the catalogue.
 */
export {
  assertMayOperateOnCollection,
  assertMayWriteGlobal,
  CMS_OPERATIONS,
  type CmsOperation,
  type CmsPrincipal,
  isRole,
  mayOperateOnCollection,
  mayReadGlobal,
  mayWriteGlobal,
  permissionFor,
} from './access.ts'
export {
  auditOperationFor,
  auditStateOf,
  CMS_MUTATIONS,
  type CmsAuditEntry,
  type CmsMutation,
  classifyMutation,
  cmsAuditEntry,
  type DocumentStatus,
  type MutationSignals,
} from './audit.ts'
export {
  assertBoundary,
  type BoundarySubject,
  type BoundaryViolation,
  boundaryViolations,
  CATALOGUE_OWNED_FIELD_NAMES,
  CATALOGUE_OWNED_TOKENS,
  isCatalogueOwnedFieldName,
  isCrossBoundaryReference,
  isNameShapedFieldName,
  normaliseFieldName,
  shippedSubjects,
  walkFields,
} from './boundary.ts'
export {
  CONTENT_COLLECTIONS,
  type ContentCollectionSlug,
  contentCollection,
  FAQ_ENTRIES,
  JOURNAL_POSTS,
  PAGES,
  SERVICE_NARRATIVE,
  TESTIMONIALS,
  THERAPIST_NARRATIVE,
} from './collections/index.ts'
export type {
  ArrayRowValue,
  ComplianceNoticesGlobal,
  DocumentMeta,
  DocumentOf,
  EditorialDefaultsGlobal,
  FaqEntryDocument,
  GlobalOf,
  JournalPostDocument,
  PageDocument,
  RichTextValue,
  ServiceNarrativeDocument,
  TestimonialDocument,
  TherapistNarrativeDocument,
} from './documents.ts'
export {
  COLLECTION_WRITE_PERMISSION,
  CONTENT_FIELD_TYPES,
  type ContentCollection,
  type ContentField,
  type ContentFieldType,
  type ContentGlobal,
  PUBLISH_PERMISSION,
} from './fields.ts'
export {
  COMPLIANCE_NOTICES,
  CONTENT_GLOBALS,
  type ContentGlobalSlug,
  contentGlobal,
  EDITORIAL_DEFAULTS,
} from './globals/index.ts'
export {
  assertMayRetire,
  type FutureBookingReport,
  RETIRE_ACTIONS,
  type RetireAction,
  type RetireRefusal,
  type RetireRequest,
  refusalOf,
  retireRefusal,
  SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE,
  SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS,
} from './lifecycle.ts'
export {
  CMS_ROBOTS_TAG,
  CMS_ROUTE_PREFIXES,
  type CmsRoutePrefix,
  cmsRoutesIn,
  isCmsRoute,
  PAYLOAD_ADMIN_ROUTE,
  PAYLOAD_API_ROUTE,
  ROBOTS_HEADER_NAME,
} from './routes.ts'
