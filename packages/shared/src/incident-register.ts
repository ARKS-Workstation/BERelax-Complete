/**
 * The incident register's declared vocabulary: the classes, the parties that get notified, the field
 * list an insurer and a regulator ask for, and the two settings that carry the breach clock.
 *
 * `packages/shared` for `compliance-notices.ts`'s reason, which is the same reason one file along: four
 * things that may not import each other need these strings to agree exactly — the F09 registry
 * (`packages/config`), the pure clock (`packages/core/src/compliance/breach-clock.ts`), the writer and
 * the readers (`packages/db`), and the gate (`scripts/`). `shared` is the leaf every one of them may
 * reach, so a mismatch is not expressible rather than merely unlikely.
 *
 * ## Why the field list is DATA and not a document
 *
 * Because the acceptance line is that the schema's columns match the declared insurer and regulator
 * field list EXACTLY, in both directions, and "exactly" is not a claim prose can carry. A field an
 * insurer asks for that the table has no column for is a question somebody answers in an email at the
 * worst possible moment; a column nobody asks for is a field that gets left blank and then gets
 * dropped. Both are invisible to review and both are caught by
 * `packages/fixtures/src/incident.itest.ts`, which reads `information_schema` and holds the two equal.
 *
 * `askedBy` is on each field because the two readers want different things and the overlap is not
 * obvious. An insurer wants to know whether anybody was hurt and whether a claim is coming; a data
 * regulator wants the categories of personal data and roughly how many people. Recording WHO asks is
 * what makes a future deletion arguable — "the regulator does not ask for this" is a reason, and "we
 * do not use it" is not.
 *
 * ## What is deliberately NOT here
 *
 * No authority name, no contact, no statutory period as a constant, and no notification template. The
 * supervisory authority is a configured value that the rights engine already treats as absent until
 * somebody sets it (ADR 0034: a response naming an invented authority is worse than no response), the
 * period is a `provisional` F09 setting, and docs/04 §8 marks the whole regulation `[UNVERIFIED]`.
 */

/**
 * What kind of incident this is, and it decides which duties the filing generates.
 *
 * A closed set rather than free text, for `obligation_class`'s reason: a class spelled two ways is a
 * rule that silently applies to nothing. `personal_data_breach` is the one with a clock attached, and
 * it is a class rather than a boolean because the register has to hold the other kinds too — docs/04 §9
 * asks for an incident register under premises and inspections, and a register that only held breaches
 * would leave the injury somebody has to tell an insurer about with nowhere to go.
 */
export const INCIDENT_CLASSES = [
  'personal_data_breach',
  'client_injury',
  'staff_injury',
  'hygiene_failure',
  'equipment_failure',
  'security_event',
] as const
export type IncidentClass = (typeof INCIDENT_CLASSES)[number]

/** The incident class whose filing starts a statutory clock. */
export const PERSONAL_DATA_BREACH: IncidentClass = 'personal_data_breach'

/**
 * Who was told. A CATEGORY of recipient and never a named body or a contact.
 *
 * `supervisory_authority` is the category; WHICH authority is the configured value the rights engine
 * already withholds a response rather than invent (ADR 0034), and `Y1-entity` is the open question. The
 * same applies to `insurer`: this build has never seen a policy, so the party is a role and the row
 * records that somebody in that role was told, at an instant, by a named actor.
 */
export const INCIDENT_NOTIFIED_PARTIES = [
  'data_subjects',
  'supervisory_authority',
  'insurer',
  'police',
  'municipality',
  'health_authority',
] as const
export type IncidentNotifiedParty = (typeof INCIDENT_NOTIFIED_PARTIES)[number]

/** Which of the two readers asks for a field. `both` is recorded rather than duplicated. */
export const FIELD_AUDIENCES = ['insurer', 'regulator', 'both'] as const
export type FieldAudience = (typeof FIELD_AUDIENCES)[number]

/** The tables the register is spread across. A field says which one holds it. */
export const INCIDENT_TABLES = ['incident', 'incident_addendum', 'incident_notification'] as const
export type IncidentTable = (typeof INCIDENT_TABLES)[number]

export interface IncidentField {
  /** The column, exactly as the migration spells it. */
  readonly column: string
  readonly heldIn: IncidentTable
  readonly askedBy: FieldAudience
  /** Why it is asked for, in one sentence. The one field no check can verify. */
  readonly why: string
}

/**
 * Columns that exist for the database rather than for a reader, named so the completeness test can
 * exclude them — and asserted to be exactly these, so the exclusion cannot grow quietly.
 *
 * A growing exclusion list is how a both-directions test becomes a one-direction test: the easiest way
 * to satisfy "every column is a declared field" is to declare the column structural, and nothing would
 * say so. There are six, every one of them is a key or a row's own creation instant, and adding a
 * seventh is an edit to this constant that a reviewer sees.
 */
export const INCIDENT_STRUCTURAL_COLUMNS: readonly string[] = [
  'id',
  'created_at',
  'incident_id',
  'reference',
  'occurrence_known',
  'breach_fields_present',
]

/**
 * The field list, which is the specification the schema is held to.
 *
 * Grouped by table and, inside a table, in the order a filer meets them: when, who, what, how bad,
 * and then the breach-only fields. The order is for a reader; the test compares sets.
 */
export const INCIDENT_FIELDS: readonly IncidentField[] = [
  // --- incident: the event, and the two instants the whole unit is about -------------------------
  {
    column: 'incident_class',
    heldIn: 'incident',
    askedBy: 'both',
    why: 'Which kind of event this is. It decides which duties the filing generates and which of the fields below are required.',
  },
  {
    column: 'occurred_at',
    heldIn: 'incident',
    askedBy: 'both',
    why: 'When it happened, where that is known. Nullable, because for a breach it very often is not — and a guessed instant on the row an insurer reads is worse than a blank one.',
  },
  {
    column: 'discovered_at',
    heldIn: 'incident',
    askedBy: 'both',
    why: 'When the business became aware. THE CLOCK: every notification deadline derives from this instant and never from when the paperwork was done.',
  },
  {
    column: 'filed_at',
    heldIn: 'incident',
    askedBy: 'both',
    why: 'When this row was written. Separate from discovery so the gap between noticing and recording is visible rather than erased.',
  },
  {
    column: 'recorded_by_role',
    heldIn: 'incident',
    askedBy: 'both',
    why: 'Which F07 role filed it. A register whose entries nobody is attributed to is a register nobody is accountable for.',
  },
  {
    column: 'recorded_by_label',
    heldIn: 'incident',
    askedBy: 'both',
    why: 'The actor label the audit trail uses for the same act, so the register and the trail name the filer the same way.',
  },
  {
    column: 'summary',
    heldIn: 'incident',
    askedBy: 'both',
    why: 'What happened, in the words of whoever was there. The first question either reader asks.',
  },
  {
    column: 'location',
    heldIn: 'incident',
    askedBy: 'insurer',
    why: 'Where on the premises. An insurer prices a slip in a wet room differently from one in a corridor, and a municipality inspection asks the same question.',
  },
  {
    column: 'immediate_action',
    heldIn: 'incident',
    askedBy: 'both',
    why: 'What was done at once. The regulator asks for measures taken to address the breach; the insurer asks what was done to limit the loss. One field, two questions.',
  },
  {
    column: 'measures_proposed',
    heldIn: 'incident',
    askedBy: 'regulator',
    why: 'Measures proposed but not yet taken. Separate from the action already taken, because a plan and a fact are not the same claim.',
  },
  {
    column: 'people_affected_count',
    heldIn: 'incident',
    askedBy: 'both',
    why: 'How many people were involved at all, breach or injury. A count the filer knows, not an estimate derived from a query.',
  },
  {
    column: 'injury_reported',
    heldIn: 'incident',
    askedBy: 'insurer',
    why: 'Whether anybody said they were hurt. Reported rather than diagnosed: this build has no clinical judgement to offer and should not imply one.',
  },
  {
    column: 'emergency_services_attended',
    heldIn: 'incident',
    askedBy: 'insurer',
    why: 'Whether an ambulance, the police or civil defence came. It changes the notification duties and an insurer asks it first.',
  },
  {
    column: 'claim_anticipated',
    heldIn: 'incident',
    askedBy: 'insurer',
    why: 'Whether the business expects a claim. A policy usually requires notification of circumstances that MIGHT give rise to one, so this is recorded at filing rather than decided later.',
  },
  {
    column: 'estimated_loss_fils',
    heldIn: 'incident',
    askedBy: 'insurer',
    why: 'The loss as the business estimates it, in fils (ADR 0007). Nullable: an unknown figure is left blank, never zeroed, because zero is a claim.',
  },
  // --- incident: the breach-only fields, required exactly when the class is a breach -------------
  {
    column: 'personal_data_categories',
    heldIn: 'incident',
    askedBy: 'regulator',
    why: 'Which categories of personal data were involved. Required for a breach, because the categories are what decide how serious it is — contact details and intake notes are not the same event.',
  },
  {
    column: 'data_subjects_affected_estimate',
    heldIn: 'incident',
    askedBy: 'regulator',
    why: 'Approximately how many people. An estimate by name, because a breach notification is due before anybody can count, and a precise-looking figure would be a guess presented as a count.',
  },
  {
    column: 'records_affected_estimate',
    heldIn: 'incident',
    askedBy: 'regulator',
    why: 'Approximately how many records. Asked separately from the number of people, because one person with four hundred bookings is a different exposure from four hundred people with one.',
  },
  {
    column: 'likely_consequences',
    heldIn: 'incident',
    askedBy: 'regulator',
    why: 'The likely consequences for the people affected. The field that decides whether they have to be told as well as the authority.',
  },
  {
    column: 'cross_border_transfer',
    heldIn: 'incident',
    askedBy: 'regulator',
    why: 'Whether data left the UAE. docs/04 marks health-sector localisation [UNVERIFIED] (Y5-residency), so whether a transfer happened is a fact worth holding before anybody knows what follows from it.',
  },
  // --- incident_addendum: the only way to add information to a filed incident -------------------
  {
    column: 'added_at',
    heldIn: 'incident_addendum',
    askedBy: 'both',
    why: 'When this was learned. An addendum dated when it was written is what makes a later finding distinguishable from something known at filing.',
  },
  {
    column: 'added_by_role',
    heldIn: 'incident_addendum',
    askedBy: 'both',
    why: 'Which role added it, for the reason the filer is recorded.',
  },
  {
    column: 'added_by_label',
    heldIn: 'incident_addendum',
    askedBy: 'both',
    why: 'The actor label, matching the audit trail for the same act.',
  },
  {
    column: 'body',
    heldIn: 'incident_addendum',
    askedBy: 'both',
    why: 'What was learned. The whole mechanism: a filed incident cannot be edited, so new information is a new row and the original stays readable.',
  },
  {
    column: 'corrects_field',
    heldIn: 'incident_addendum',
    askedBy: 'both',
    why: 'Which field this addendum corrects, where it corrects one. Nullable, because most addenda add rather than correct — and a correction that does not say what it corrects is not a correction.',
  },
  // --- incident_notification: what was notified ---------------------------------------------------
  {
    column: 'party',
    heldIn: 'incident_notification',
    askedBy: 'both',
    why: 'Which category of recipient was told. A category and never a named body: which authority it is remains a configured value (Y1-entity).',
  },
  {
    column: 'notified_at',
    heldIn: 'incident_notification',
    askedBy: 'both',
    why: 'When they were told. The instant that answers "did you notify within the period", and it is compared against discovery rather than against filing.',
  },
  {
    column: 'notified_by_role',
    heldIn: 'incident_notification',
    askedBy: 'both',
    why: 'Which role did the telling. A notification nobody is attributed to is a claim with no claimant.',
  },
  {
    column: 'notified_by_label',
    heldIn: 'incident_notification',
    askedBy: 'both',
    why: 'The actor label, matching the audit trail for the same act.',
  },
  {
    column: 'channel',
    heldIn: 'incident_notification',
    askedBy: 'both',
    why: "How they were told, in the filer's words. Free text rather than an enum, because this build has no notification integration and a closed list would be a list of channels nobody has used.",
  },
  {
    column: 'content_summary',
    heldIn: 'incident_notification',
    askedBy: 'both',
    why: 'What they were told. Both readers ask what was disclosed, and a notification row with no content is a tick in a box.',
  },
]

/** Every declared field for one table. */
export function incidentFieldsFor(table: IncidentTable): readonly IncidentField[] {
  return INCIDENT_FIELDS.filter((field) => field.heldIn === table)
}

/**
 * The obligation the compliance calendar already owns, which a breach filing generates instances of.
 *
 * A key and not an id, for `obligation.key`'s stated reason: it is named in refusals, in tests and in
 * the calendar, so `BreachNotificationOverdue: pdpl_breach_notification` is actionable where a UUID is
 * not. Spelled here because the migration seeds the definition and the writer looks it up.
 */
export const BREACH_NOTIFICATION_OBLIGATION_KEY = 'pdpl_breach_notification'

/** The duty to tell the people whose data it was, which is a separate deadline from the authority's. */
export const BREACH_SUBJECT_NOTIFICATION_OBLIGATION_KEY = 'pdpl_breach_subject_notification'

/**
 * How many hours after DISCOVERY the authority notification is due.
 *
 * A setting and not a constant, and `provisional` rather than merely configurable. docs/04 §8 marks
 * Federal Decree-Law 45 of 2021 and its executive regulations `[UNVERIFIED]` — in so many words, the
 * breach notification threshold and deadline are among the things it says to confirm — so 72 hours is
 * the build's reading of a secondary source and not a figure anybody has checked. A constant would make
 * the correction a release and would read, on the screen, exactly like a figure somebody looked up.
 */
export const BREACH_NOTIFICATION_HOURS_SETTING_KEY = 'pdpl.breach_notification_hours'

/**
 * Where the unanswered part is recorded.
 *
 * `Y1-entity` is the existing row that holds which privacy law applies and which authority supervises
 * it; this is the narrower question of the PERIOD, which has its own answer and its own answerer.
 */
export const BREACH_CLOCK_OPEN_QUESTION_ID = 'Y1-breach-clock'

/**
 * The threshold question, which this build deliberately does not answer.
 *
 * Whether a given breach is notifiable at all is a legal judgement about risk to the people affected,
 * and nothing in this repository is in a position to make it. So every personal-data-breach filing
 * generates the duty and dates it, and the duty is COMPLETED with a reason — including "assessed as not
 * notifiable" — rather than never created. A build that decided the threshold itself would be deciding
 * not to notify, silently, from a rule nobody wrote down.
 */
export const BREACH_THRESHOLD_OPEN_QUESTION_ID = 'Y1-breach-threshold'
