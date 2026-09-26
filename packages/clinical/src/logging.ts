/**
 * The clinical store's telemetry seams (C-CRM-08).
 *
 * Interfaces rather than a logger and the Sentry SDK, for the reason `with-google.ts` gives about a
 * refresh token: a log line and a breadcrumb are two of the places a payload value must never reach, and
 * a seam is what lets a test assert that by capturing everything the path emits. Asserting it against
 * the real SDK would be asserting against Sentry's serialiser.
 *
 * The difference from the Google one is the shape of `fields`, and it is the substance of this file:
 * **every value that may appear in a clinical log line is a number, an id, an instant or a name from a
 * closed set.** Not "should be" — the type says so. A free-form `Record<string, unknown>` is how a
 * payload reaches a log: somebody adds `answers` to a debugging line, the line is correct for the bug
 * they were chasing, and it is then in a log aggregator for as long as the retention says.
 *
 * `answerCount` and `fieldCount` are the shape of a submission and are deliberately permitted: knowing a
 * submission had eleven answers tells an operator the write worked and tells a reader nothing about
 * anybody. `refusal` is one of the named refusals, which is what makes a refused read searchable.
 */

export type ClinicalLogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * The only value kinds a clinical log field may hold.
 *
 * `string` is in it, which looks like the hole — and is not, because the FIELD NAMES are a closed set
 * too (see {@link ClinicalLogFields}) and every string-valued one names a uuid, a refusal or a purpose.
 * A purpose is the one free-text value here, it is typed by a member of staff rather than by a client,
 * and it is on the audit row anyway: the audit trail's whole job is to say why somebody looked.
 */
export type ClinicalLogValue = string | number | boolean | null

/**
 * A closed field map. Adding a key is an edit to this type, which is the point.
 *
 * `packages/clinical/src/logging.test.ts` asserts that no key here is named after anything a payload
 * holds, and the leak spy in `repository.itest.ts` drives the whole submission path and greps every
 * emitted line for every payload value.
 */
export interface ClinicalLogFields {
  readonly submissionId?: string
  readonly noteId?: string
  readonly templateId?: string
  readonly templateVersion?: number
  readonly customerId?: string
  readonly employeeId?: string
  readonly grantId?: string
  readonly statedPurpose?: string
  readonly refusal?: string
  /** How many answers the payload held. A count, never a key and never a value. */
  readonly answerCount?: number
  /** How many questions the captured version asked. */
  readonly fieldCount?: number
  readonly kekVersion?: string
  readonly dataOrigin?: string
  readonly ciphertextBytes?: number
  readonly outcome?: 'stored' | 'read' | 'refused'
  /**
   * The contraindication derivation's three fields (C-CRM-09). Each one is a number or a boolean about
   * the DERIVATION, never about the client.
   *
   * `undeterminedCount` is how many flags the captured version asked about and whose answer the derivation
   * would not interpret — a measure of how readable the form was. `flagsChanged` says whether a
   * re-derivation moved anything, which is the difference between a sweep and a real change.
   *
   * Deliberately absent: the flag set itself, and a count of how many flags are SET. The first is the
   * crossing and belongs on a screen behind a permission, not in a log aggregator for as long as the
   * retention says; the second is a measure of how ill somebody is, which is worse than either.
   */
  readonly undeterminedCount?: number
  readonly derivationVersion?: number
  readonly flagsChanged?: boolean
}

export interface ClinicalLogLine {
  readonly level: ClinicalLogLevel
  readonly message: string
  readonly fields: ClinicalLogFields
}

export interface ClinicalLogger {
  log(line: ClinicalLogLine): void
}

/** The error reporter, shaped like the subset of Sentry this system uses. */
export interface ClinicalErrorSink {
  addBreadcrumb(crumb: {
    readonly category: string
    readonly message: string
    readonly data?: ClinicalLogFields
  }): void
  captureException(
    error: unknown,
    context: { readonly tags: Readonly<Record<string, string>> },
  ): void
}

/**
 * A logger that discards everything, for a caller that has none.
 *
 * Exported rather than made the default inside the repository: a required dependency with a silent
 * default is a dependency every caller omits, and then the one place that needed the diagnostics has
 * none. A caller that genuinely wants silence says so here, in one word, at its own call site.
 */
export const SILENT_CLINICAL_LOGGER: ClinicalLogger = { log: () => {} }
