import type { ContraindicationFlagSet } from '@berelax/shared'

/**
 * The clinical store's interface.
 *
 * Deliberately an interface rather than a concrete class: it is the seam that makes relocating the
 * clinical data to a different database a configuration change. The implementation lives behind it,
 * and the booking layer never sees either — it reads `ContraindicationFlagSet` through a view.
 */

/**
 * The ONLY shape permitted to cross the boundary. Booleans, no detail, no diagnosis.
 *
 * An alias for `ContraindicationFlagSet` in `@berelax/shared` since C-CRM-09, and the aliasing is the
 * point rather than tidying. F08 declared this shape here with five booleans, a `customerId` and an
 * `updatedAt`; the crossing's acceptance is that the exported type is `Record<FlagKey, boolean>` **and
 * nothing else**, and a second exported shape for the same crossing defeats that however careful the
 * first one is — a consumer imports whichever it found, and the one it found has a date on it.
 *
 * So there is one shape, spelled once, in the package every other package may depend on. `customerId` is
 * not on it because it identifies the row rather than crossing with it, and `updatedAt` is not on it
 * because a date on which somebody filled in a health form is not a booking decision (migration 0084
 * drops it from the view too).
 */
export type ContraindicationFlags = ContraindicationFlagSet

/**
 * A submission as the store takes it.
 *
 * **There is no `flags` field, and its absence is C-CRM-09's whole thesis.** F08's draft of this interface
 * took the flags as an argument, which makes them something a caller states rather than something derived:
 * a call site could then set `pregnancy: true` for a client who was never asked, and the row would be
 * indistinguishable from a derived one. A flag has to be traceable to an answer the client actually gave
 * against wording that was stored, so it is derived from the decrypted payload inside this package
 * (`ClinicalIntakeStore.deriveFlags`) and supplied by nobody.
 *
 * C-CRM-08 had already reached the same conclusion from the other end and gave `recordIntake` no flags
 * argument at all rather than one it would have to guess at; this removes the shape that said otherwise.
 */
export interface IntakeSubmissionInput {
  readonly customerId: string
  readonly templateId: string
  /** Plaintext answers. Sealed before they reach the database and never logged. */
  readonly answers: Readonly<Record<string, unknown>>
  readonly submittedVia: 'online' | 'in_salon' | 'staff_entry'
}

export interface TreatmentNoteInput {
  readonly customerId: string
  readonly appointmentId: string
  readonly authorEmployeeId: string
  readonly body: string
  /** A correction supersedes rather than overwrites; a rewritable clinical record is not evidence. */
  readonly supersedesId?: string
}

export interface ClinicalStore {
  recordIntake(input: IntakeSubmissionInput): Promise<{ readonly submissionId: string }>
  /** Requires the clinical role AND writes an audit row for the read. */
  readIntake(submissionId: string, customerId: string): Promise<Readonly<Record<string, unknown>>>
  recordTreatmentNote(input: TreatmentNoteInput): Promise<{ readonly noteId: string }>
  readTreatmentNote(noteId: string, customerId: string): Promise<string>
  /** Read through the public view; needs no clinical privilege. */
  flagsFor(customerId: string): Promise<ContraindicationFlagSet | null>
}
