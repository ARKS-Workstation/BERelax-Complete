/**
 * The clinical store's interface.
 *
 * Deliberately an interface rather than a concrete class: it is the seam that makes relocating the
 * clinical data to a different database a configuration change. The implementation lives behind it,
 * and the booking layer never sees either — it reads `ContraindicationFlags` through a view.
 */

/** The ONLY shape permitted to cross the boundary. Booleans, no detail, no diagnosis. */
export interface ContraindicationFlags {
  readonly customerId: string
  readonly pregnancy: boolean
  readonly recentSurgery: boolean
  readonly cardiovascular: boolean
  readonly skinCondition: boolean
  readonly requiresConsultation: boolean
  readonly updatedAt: Date
}

export interface IntakeSubmissionInput {
  readonly customerId: string
  readonly templateId: string
  /** Plaintext answers. Sealed before they reach the database and never logged. */
  readonly answers: Readonly<Record<string, unknown>>
  readonly submittedVia: 'online' | 'in_salon' | 'staff_entry'
  readonly flags: Omit<ContraindicationFlags, 'customerId' | 'updatedAt'>
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
  flagsFor(customerId: string): Promise<ContraindicationFlags | null>
}
