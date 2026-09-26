import {
  CONTRAINDICATION_DERIVATION_VERSION,
  CONTRAINDICATION_ESCALATION_FLAG,
  CONTRAINDICATION_FLAG_KEYS,
  type ContraindicationFlagKey,
  type ContraindicationFlagSet,
} from '@berelax/shared'
import { can, type Role } from '../access/permissions.ts'
import {
  type CompliancePolicy,
  lintPublicDisplayName,
  type PublicNameFinding,
} from '../compliance/lexicon.ts'
import type { IntakeField, IntakeTemplate } from './intake.ts'

/**
 * The boolean-only crossing (C-CRM-09).
 *
 * `clinical.intake_submission` holds answers a client wrote, sealed under `CLINICAL_KEK`. The booking layer
 * needs to know that *there is something to check*, and must never learn what was written. This module is
 * the whole of what crosses: a pure derivation from a decrypted payload to eight booleans, the decision
 * about who may read them, and the copy that goes beside them.
 *
 * Nothing here touches a payload's ciphertext, a key, a clock or a database. That is load-bearing rather
 * than tidy: the two rules a reviewer most needs to check by reading — *an answer nobody gave does not
 * produce a flag*, and *a reader who may not see the note still sees the flag* — are decisions over values,
 * and a decision over values is testable with no key and no server.
 *
 * ## The one thing this module will not do
 *
 * **It never reads free text.** A flag is derived from a `boolean` question and from nothing else. The
 * tempting alternative is right there: an intake form asks "are you taking any medication?" as
 * `short_text`, a client writes a drug name, and a regular expression over that answer would set
 * `blood_thinners` correctly most of the time. It would also be this system asserting a fact about
 * somebody's health that nobody stated — the brief's prohibition exactly, and worse than useless because
 * the times it is wrong are the times the answer was unusual. If the salon wants the flag, the template
 * asks the question: `blood_thinners`, `kind: 'boolean'`.
 *
 * ## Identity mapping, not a lookup table
 *
 * A template field determines a flag when its `key` **equals** the flag key. There is deliberately no
 * alias table and no label matching. An alias table is a place where somebody adds
 * `'surgery_recent' -> recent_surgery` for one template, and a template that spells it a third way then
 * derives `false` for a client who answered yes — a false negative on a contraindication, which is the
 * failure direction that matters. {@link lintContraindicationDefinition} closes the other half: a template
 * that asks a flag-keyed question with the wrong KIND is refused at publication rather than deriving
 * nothing in silence for the life of that version.
 *
 * ## `Y1-licence` is open, and it is why the eighth key is `requires_consultation`
 *
 * See `CONTRAINDICATION_FLAG_KEYS` in `@berelax/shared` for the argument and for what widens if the owner
 * answers `healthcare`. {@link lintContraindicationCopy} is what makes it a check rather than a claim:
 * every label and every action line goes through the publication lexicon under the profile in force, and
 * `contraindication-flags.test.ts` asserts zero findings with the manifest's own `practitioner`-based
 * wording as the control that the lint can still fail.
 */

// ------------------------------------------------------------------------------------------------
// What a template must look like for a flag to be derivable at all
// ------------------------------------------------------------------------------------------------

/** The one field kind a flag may be derived from. Named once; two spellings would be two rules. */
export const CONTRAINDICATION_FIELD_KIND = 'boolean' as const

export const CONTRAINDICATION_DEFINITION_RULES = [
  'contraindication_field_must_be_boolean',
  'escalation_flag_is_not_a_question',
] as const
export type ContraindicationDefinitionRule = (typeof CONTRAINDICATION_DEFINITION_RULES)[number]

export interface ContraindicationDefinitionProblem {
  readonly rule: ContraindicationDefinitionRule
  readonly fieldKey: string
  readonly why: string
}

/** True when a template field key names a flag, and is therefore subject to the rules below. */
export const isContraindicationFieldKey = (key: string): key is ContraindicationFlagKey =>
  (CONTRAINDICATION_FLAG_KEYS as readonly string[]).includes(key)

/**
 * Every reason a template's question set could not derive the flags it appears to.
 *
 * Called from `publishTemplate`, so the refusal lands on whoever is writing the form rather than on a front
 * desk months later. Both rules exist because their failure is SILENT:
 *
 *   - a field keyed `recent_surgery` with `kind: 'long_text'` looks like the question that feeds the flag,
 *     is answered by every client, and derives nothing for the life of that template version;
 *   - a field keyed `requires_consultation` asks the client to decide the escalation, which inverts what
 *     the flag means — it is set when the system could not READ an answer, and a client cannot answer that
 *     question about their own form.
 */
export function lintContraindicationDefinition(
  fields: readonly IntakeField[],
): readonly ContraindicationDefinitionProblem[] {
  const problems: ContraindicationDefinitionProblem[] = []
  for (const field of fields) {
    if (!isContraindicationFieldKey(field.key)) continue
    if (field.key === CONTRAINDICATION_ESCALATION_FLAG) {
      problems.push({
        rule: 'escalation_flag_is_not_a_question',
        fieldKey: field.key,
        why:
          `"${CONTRAINDICATION_ESCALATION_FLAG}" is not something a client can be asked. It is set when ` +
          'an answer to one of the other questions could not be read as yes or no, which is a fact about ' +
          'this form and not about the person filling it in.',
      })
      continue
    }
    if (field.kind !== CONTRAINDICATION_FIELD_KIND) {
      problems.push({
        rule: 'contraindication_field_must_be_boolean',
        fieldKey: field.key,
        why:
          `"${field.key}" names a contraindication flag, so it must be asked as ` +
          `${CONTRAINDICATION_FIELD_KIND} and is asked as ${field.kind}. A flag is never read out of free ` +
          'text: this system does not interpret what a client wrote, so a non-boolean question here would ' +
          'derive nothing at all for every submission captured against this version.',
      })
    }
  }
  return Object.freeze(problems)
}

// ------------------------------------------------------------------------------------------------
// The derivation
// ------------------------------------------------------------------------------------------------

/**
 * How one flag's question was answered.
 *
 * Four states, and the crossing has two — which is the whole difficulty of this unit and the reason the
 * reduction is written out rather than inlined. See {@link deriveContraindicationFlags}.
 */
export type ContraindicationAnswerReading =
  /** The captured version asked, as a boolean, and the answer was `true`. */
  | 'affirmed'
  /** The captured version asked, as a boolean, and the answer was `false`. */
  | 'denied'
  /** The captured version asked and the answer cannot be read as yes or no. */
  | 'undetermined'
  /** The captured version never asked. */
  | 'not_asked'

/** Where one flag came from. Stays INSIDE the boundary: `label` is a question a client was asked. */
export interface ContraindicationProvenance {
  readonly flag: ContraindicationFlagKey
  readonly reading: ContraindicationAnswerReading
  /** The field key in the captured version, or null when it asked nothing that feeds this flag. */
  readonly fieldKey: string | null
  /** The label as the CAPTURED version worded it, so a flag is traceable to wording that was stored. */
  readonly label: string | null
}

export interface ContraindicationDerivation {
  /** The crossing. Booleans, keyed by the closed set, and nothing else. */
  readonly flags: ContraindicationFlagSet
  readonly derivationVersion: number
  /** The version of the template the source submission was captured under. */
  readonly sourceTemplateVersion: number
  /**
   * Flags whose question was asked and whose answer could not be read. Drives the escalation flag.
   *
   * A count of these is the only thing about them that is persisted (migration 0084's
   * `undetermined_count`), and the count never crosses the boundary: it is a fact about how readable this
   * form was, and it is used by a CHECK constraint to hold "unreadable implies ask a human".
   */
  readonly undetermined: readonly ContraindicationFlagKey[]
  /** Flags the captured version never asked about. NOT an escalation — see the class doc. */
  readonly notAsked: readonly ContraindicationFlagKey[]
  /**
   * One entry per flag, in `CONTRAINDICATION_FLAG_KEYS` order.
   *
   * Never persisted, never logged, never rendered outside the step-up-gated clinical screen: it names the
   * question a client was asked, which is health data even though it holds no answer.
   */
  readonly provenance: readonly ContraindicationProvenance[]
}

/** Reads one answer, in the one way this system is willing to read one. */
function readOneField(
  field: IntakeField,
  answers: Readonly<Record<string, unknown>>,
): ContraindicationAnswerReading {
  // The KIND is checked here as well as at publication, because a template published before this rule
  // existed — or edited into a new version by a path that skipped the lint — is still a template whose
  // submissions get read. Deriving `denied` from a free-text answer would be the false negative the whole
  // module is arranged to avoid.
  if (field.kind !== CONTRAINDICATION_FIELD_KIND) return 'undetermined'
  const value = answers[field.key]
  if (value === true) return 'affirmed'
  if (value === false) return 'denied'
  // Absent, null, a string, a number, an object. All the same decision: nobody gave an answer this system
  // is willing to read, so it escalates rather than guessing in either direction.
  return 'undetermined'
}

/**
 * The pure derivation: a decrypted payload and the template version it was captured under, to eight
 * booleans.
 *
 * Deterministic and total — the same payload always yields the same set, and every key is always present,
 * because a missing key in a `Record<FlagKey, boolean>` is `undefined`, and `undefined` at a call site that
 * asks `if (flags.pregnancy)` is `false` with no decision having been made.
 *
 * ## How four readings become two booleans
 *
 * `affirmed` is the flag. `denied` is not the flag. The two that have nowhere to go are the point:
 *
 * **`undetermined` sets `CONTRAINDICATION_ESCALATION_FLAG` and NOT the specific flag.** Setting the specific
 * flag would assert a condition from an answer nobody could read; leaving it at that and setting nothing
 * would be "we could not establish it" falling through to "proceed", which is the failure ADR 0031 spent a
 * whole unit making unreachable one layer down. So the observable behaviour is escalation: the screen says a
 * human has to ask, and migration 0084's CHECK refuses a row that claims otherwise.
 *
 * **`not_asked` sets nothing at all.** A template that does not ask about blood thinners produces
 * `blood_thinners: false`, and that is the honest answer to "has this client told us about blood thinners"
 * — no. The alternative was considered and discarded: escalating every unasked flag makes
 * `requires_consultation` true for every submission of every real template, and a marker that is always lit
 * is a marker nobody reads. Which questions the form asks is the salon's decision, taken once per template
 * version, and it is visible on the clinical screen rather than repeated onto every client.
 *
 * So `false` in the crossing means **not affirmed by an answer on record**, never *ruled out*. Both screens
 * say that in words, and {@link CONTRAINDICATION_FALSE_MEANING} is the sentence, spelled once.
 *
 * ## Why any affirmative wins
 *
 * A version may ask more than one question feeding one flag (a reword that kept both). `affirmed` from any
 * of them affirms; otherwise `undetermined` from any of them escalates; otherwise `denied`. Ordered so the
 * safe reading survives disagreement between two questions, which is the only order that does.
 */
export function deriveContraindicationFlags(
  template: IntakeTemplate,
  answers: Readonly<Record<string, unknown>>,
): ContraindicationDerivation {
  const provenance: ContraindicationProvenance[] = []
  const undetermined: ContraindicationFlagKey[] = []
  const notAsked: ContraindicationFlagKey[] = []
  const affirmed = new Set<ContraindicationFlagKey>()

  for (const flag of CONTRAINDICATION_FLAG_KEYS) {
    if (flag === CONTRAINDICATION_ESCALATION_FLAG) continue
    const asked = template.fields.filter((field) => field.key === flag)
    const first = asked[0]
    if (first === undefined) {
      notAsked.push(flag)
      provenance.push({ flag, reading: 'not_asked', fieldKey: null, label: null })
      continue
    }
    const readings = asked.map((field) => ({ field, reading: readOneField(field, answers) }))
    const chosen = readings.find((r) => r.reading === 'affirmed') ??
      readings.find((r) => r.reading === 'undetermined') ?? {
        field: first,
        reading: 'denied' as ContraindicationAnswerReading,
      }
    if (chosen.reading === 'affirmed') affirmed.add(flag)
    if (chosen.reading === 'undetermined') undetermined.push(flag)
    provenance.push({
      flag,
      reading: chosen.reading,
      fieldKey: chosen.field.key,
      label: chosen.field.label,
    })
  }

  const escalate = undetermined.length > 0
  // The escalation flag's provenance has no field and no wording, because no question feeds it: it is a fact
  // about how readable this form was. `affirmed` here means "this system set it", not "a client said yes" —
  // the only entry in `provenance` where that reading applies, and it is why `fieldKey` and `label` are null
  // rather than pointing at whichever question happened to be unreadable.
  provenance.push({
    flag: CONTRAINDICATION_ESCALATION_FLAG,
    reading: escalate ? 'affirmed' : 'denied',
    fieldKey: null,
    label: null,
  })

  const flags = Object.fromEntries(
    CONTRAINDICATION_FLAG_KEYS.map((flag) => [
      flag,
      flag === CONTRAINDICATION_ESCALATION_FLAG ? escalate : affirmed.has(flag),
    ]),
  ) as Record<ContraindicationFlagKey, boolean>

  return {
    flags: Object.freeze(flags),
    derivationVersion: CONTRAINDICATION_DERIVATION_VERSION,
    sourceTemplateVersion: template.version,
    undetermined: Object.freeze(undetermined),
    notAsked: Object.freeze(notAsked),
    provenance: Object.freeze(provenance),
  }
}

/** What `false` means in the crossing, in one sentence, spelled once and rendered by both screens. */
export const CONTRAINDICATION_FALSE_MEANING =
  'Not flagged means nothing on this client’s intake form said yes to that question. It does not mean ' +
  'the question was asked, and it does not mean anything has been ruled out.'

// ------------------------------------------------------------------------------------------------
// Staleness
// ------------------------------------------------------------------------------------------------

export const CONTRAINDICATION_STALENESS_REASONS = [
  'no_flags_derived',
  'derivation_version_changed',
  'source_submission_changed',
  'template_version_changed',
] as const
export type ContraindicationStalenessReason = (typeof CONTRAINDICATION_STALENESS_REASONS)[number]

export interface StoredFlagProvenance {
  readonly derivationVersion: number
  readonly sourceSubmissionId: string
  readonly sourceTemplateVersion: number
}

export interface ContraindicationFreshnessRequest {
  /** The flag row on record, or null when nothing has ever been derived for this client. */
  readonly stored: StoredFlagProvenance | null
  /** The client's live (non-superseded) submission, or null when they have none. */
  readonly liveSubmission: {
    readonly submissionId: string
    readonly templateVersion: number
  } | null
  /** The newest published version for the locale that submission was captured in, or null. */
  readonly currentTemplateVersion: number | null
  readonly currentDerivationVersion: number
}

export type ContraindicationFreshness =
  | { readonly fresh: true }
  | {
      readonly fresh: false
      readonly reason: ContraindicationStalenessReason
      readonly because: string
    }

/**
 * Whether a stored flag set still says what a fresh derivation would say.
 *
 * "Stale flags are detectable, not silently used" is the acceptance line, and *detectable* is the whole of
 * it: this does not re-derive and it does not blank the flags. A stale set is the best information the front
 * desk has, and hiding it would trade a marker that may be out of date for no marker at all — which is
 * strictly worse at the moment somebody is about to be treated. So the verdict is reported, the screens
 * carry it, and re-deriving is an audited act by somebody who has stepped up.
 *
 * Ordered from the most fundamental. `no_flags_derived` first, because a client with a submission and no
 * flag row is not a client with no contraindications: it is a derivation that has not been run, and those
 * two must never render the same way.
 */
export function resolveContraindicationFreshness(
  request: ContraindicationFreshnessRequest,
): ContraindicationFreshness {
  const { stored, liveSubmission } = request
  // Nothing to be stale about. A client who has filled in no intake form has no flags, and that is a
  // complete answer rather than a missing one.
  if (liveSubmission === null) return { fresh: true }

  if (stored === null) {
    return {
      fresh: false,
      reason: 'no_flags_derived',
      because:
        'this client has an intake submission and no flag row, so nothing has been derived from it. An ' +
        'empty flag set here would read as "no contraindications", which is a claim nobody has made',
    }
  }
  if (stored.derivationVersion !== request.currentDerivationVersion) {
    return {
      fresh: false,
      reason: 'derivation_version_changed',
      because:
        `these flags were derived by version ${stored.derivationVersion} of the derivation and the ` +
        `current version is ${request.currentDerivationVersion}. The same answers may now produce a ` +
        'different set, which is what a version bump means',
    }
  }
  if (stored.sourceSubmissionId !== liveSubmission.submissionId) {
    return {
      fresh: false,
      reason: 'source_submission_changed',
      because:
        'the client has filled in a newer intake form than the one these flags came from. The older ' +
        'submission is retained and superseded (ADR 0010); its flags are not the current answer',
    }
  }
  if (
    request.currentTemplateVersion !== null &&
    request.currentTemplateVersion > stored.sourceTemplateVersion
  ) {
    return {
      fresh: false,
      reason: 'template_version_changed',
      because:
        `these flags were derived against template version ${stored.sourceTemplateVersion} and the form ` +
        `is now at version ${request.currentTemplateVersion}. The client has not answered the newer ` +
        'question set, so a flag the new version asks about has no answer behind it',
    }
  }
  return { fresh: true }
}

// ------------------------------------------------------------------------------------------------
// Who may read what
// ------------------------------------------------------------------------------------------------

export const CONTRAINDICATION_ACCESS_REFUSALS = [
  'flags_not_permitted_for_role',
  'note_not_permitted_for_role',
  'therapist_not_assigned',
] as const
export type ContraindicationAccessRefusal = (typeof CONTRAINDICATION_ACCESS_REFUSALS)[number]

export type ContraindicationAccessDecision =
  | { readonly permitted: true }
  | {
      readonly permitted: false
      readonly refusal: ContraindicationAccessRefusal
      readonly because: string
    }

export interface ContraindicationAccessRequest {
  readonly role: Role
  readonly employeeId: string
  /**
   * The therapist ids assigned to this client's appointments, as the caller's query found them.
   *
   * A list rather than a boolean, so the decision is made here and not by a caller writing
   * `assigned: rows.length > 0` — which is the query returning every appointment rather than this
   * employee's, and it reads identically at the call site.
   */
  readonly assignedTherapistIds: readonly string[]
}

export interface ContraindicationAccess {
  readonly flags: ContraindicationAccessDecision
  /** The intake answers and the treatment notes: the DETAIL behind a flag. */
  readonly note: ContraindicationAccessDecision
}

/**
 * Two decisions, taken together, because the interesting reader is the one for whom they differ.
 *
 * A receptionist gets the flags and is refused the note. That single asymmetry is what ADR 0010's boundary
 * is for and what this whole unit serves: the front desk can route a booking without reading a health
 * record. `FIELD_GROUPS` has said so since F07; what this adds is the second half nothing had expressed.
 *
 * ## Why the assignment scope is on the THERAPIST and not on the front desk
 *
 * A therapist's justification for opening a client's record is the appointment they are about to deliver,
 * and it names one client. So an unassigned therapist is refused BOTH — not merely the note — because a flag
 * set is still a disclosure about somebody they have no reason to be looking at, and the therapist is the
 * role that can also read the note, so the narrower scope belongs on the wider read.
 *
 * A receptionist's justification is the booking they are taking, and it does not name a client in advance: a
 * walk-in at the door has no appointment to be assigned to. Scoping the front desk the same way would make
 * it impossible to route the one client the scope matters most for, and a control that cannot be complied
 * with is a control somebody removes. What bounds the receptionist instead is the read itself: eight
 * booleans, no note, and `clinical_note:read` refused by name.
 *
 * Pure: no session, no query, no clock. The caller supplies the role and the assignment its query found,
 * which is what lets the whole matrix be proved without a database.
 */
export function resolveContraindicationAccess(
  request: ContraindicationAccessRequest,
): ContraindicationAccess {
  const assigned = request.assignedTherapistIds.includes(request.employeeId)
  const notAssigned = (what: string): ContraindicationAccessDecision => ({
    permitted: false,
    refusal: 'therapist_not_assigned',
    because:
      'this therapist is not assigned to any appointment for this client, so there is nothing they are ' +
      `about to deliver that reading ${what} would inform. A therapist reads the client in front of them`,
  })

  const flags: ContraindicationAccessDecision = !can(request.role, 'clinical_flags:read')
    ? {
        permitted: false,
        refusal: 'flags_not_permitted_for_role',
        because: `the role "${request.role}" does not hold clinical_flags:read`,
      }
    : request.role === 'therapist' && !assigned
      ? notAssigned('the flags')
      : { permitted: true }

  const note: ContraindicationAccessDecision = !can(request.role, 'clinical_note:read')
    ? {
        permitted: false,
        refusal: 'note_not_permitted_for_role',
        because:
          `the role "${request.role}" may see THAT a flag is set and not what is behind it. The detail is ` +
          'an intake answer or a treatment note, and reading one needs clinical_note:read and a step-up ' +
          're-authentication of its own (ADR 0031)',
      }
    : request.role === 'therapist' && !assigned
      ? notAssigned('a note')
      : { permitted: true }

  return { flags, note }
}

/**
 * The widest reader a surface with no admin session will serve (W-SYS-01).
 *
 * `receptionist`, and the choice is what makes `?role=` safe to take from a query string. There is no admin
 * session yet, exactly as every route under `/compliance`, `/hr`, `/settings` and `/clients` records, so a
 * screen has to be told who is reading. `?employee=` is safe on the intake route for a reason that does not
 * transfer — that read is refused by the DATABASE without a step-up grant, so naming somebody else buys
 * nothing — but a ROLE **is** the permission, so taking one at face value would be an escalation with a
 * query string.
 *
 * A receptionist holds `clinical_flags:read` and not `clinical_note:read`. Intersecting every claimed role
 * with this one therefore means no query string can unlock the detail behind a marker, while a claimed role
 * that is NARROWER than this still gets its own refusal — which is what keeps the screen honest about the
 * matrix rather than showing everybody the same page.
 */
export const CONTRAINDICATION_SESSIONLESS_CEILING_ROLE: Role = 'receptionist'

/**
 * Two access decisions, reduced to the narrower of the two, per scope.
 *
 * `claimed.permitted ? ceiling : claimed` rather than an `&&` of booleans, because a refusal has to arrive
 * with its own reason: a caller told only "no" cannot tell "your job title does not cover this" from "you
 * are not assigned to this client", and those have different remedies. When the claim is permitted the
 * ceiling's verdict is returned whole, reason included; when the claim is refused the claim's is, because
 * the narrower of the two is the one that already said no.
 *
 * Pure, and in `@berelax/core` rather than inside the route, so the property that matters — **this can only
 * narrow** — is provable without a server. A version of it that lived in the handler was testable only by
 * serving the page, which is how a ceiling comes to be removed by somebody who could not see it being
 * tested.
 */
export function narrowContraindicationAccess(
  claimed: ContraindicationAccess,
  ceiling: ContraindicationAccess,
): ContraindicationAccess {
  const narrower = (
    a: ContraindicationAccessDecision,
    b: ContraindicationAccessDecision,
  ): ContraindicationAccessDecision => (a.permitted ? b : a)
  return {
    flags: narrower(claimed.flags, ceiling.flags),
    note: narrower(claimed.note, ceiling.note),
  }
}

// ------------------------------------------------------------------------------------------------
// The copy that goes beside a flag
// ------------------------------------------------------------------------------------------------

/**
 * What each flag is called on a screen, and what the reader should do about it.
 *
 * Both halves go through the publication lexicon under the profile in force
 * ({@link lintContraindicationCopy}), which is the `Y1-licence` decision made checkable: unconfirmed
 * resolves to the wellness vocabulary, so no label names a staff title the profile does not permit and no
 * action line claims a medical effect. The action lines say *ask* and *avoid*; none of them says what to do
 * about a condition, because that would be advice this business is not licensed to give.
 *
 * `action` is deliberately the same for every reader. It tells somebody to have a conversation, which is
 * the one safe thing a boolean can justify.
 */
export const CONTRAINDICATION_FLAG_LABELS: Readonly<Record<ContraindicationFlagKey, string>> =
  Object.freeze({
    pregnancy: 'Pregnancy',
    recent_surgery: 'Recent surgery',
    cardiovascular: 'Heart or circulation',
    skin_condition: 'Skin condition',
    allergy_present: 'Allergy on record',
    blood_thinners: 'Blood thinners',
    acute_injury: 'Recent injury',
    requires_consultation: 'Consultation needed',
  })

export const CONTRAINDICATION_FLAG_ACTIONS: Readonly<Record<ContraindicationFlagKey, string>> =
  Object.freeze({
    pregnancy: 'Confirm the room, the position and the pressure with the client before you begin.',
    recent_surgery: 'Ask which area, and do not work over it until the client has been asked.',
    cardiovascular: 'Ask before any heat, sauna or strong pressure.',
    skin_condition: 'Ask which area to avoid, and check the oils and balms against the answer.',
    allergy_present: 'Check the oils and balms on the trolley against what the client has said.',
    blood_thinners: 'Keep to light pressure until the client has been asked.',
    acute_injury: 'Ask which area, and avoid it until the client has been asked.',
    requires_consultation:
      'An answer on this form could not be read as yes or no. Ask the client before the appointment.',
  })

/** A copy finding with the flag and the half of the pair it came from, so a refusal can name it. */
export interface ContraindicationCopyFinding extends PublicNameFinding {
  readonly flag: ContraindicationFlagKey
  readonly at: 'label' | 'action'
}

/**
 * Every reason this module's copy may not be shown under the profile in force.
 *
 * The full lint and not the question lint: a flag label ASSERTS. "Pregnancy" beside a client's name is the
 * business saying something, not asking it, so ADR 0031's one-rule exemption for an interrogative does not
 * apply here and `banned_claim_term` is checked like every other rule.
 */
export function lintContraindicationCopy(
  policy: CompliancePolicy,
): readonly ContraindicationCopyFinding[] {
  const findings: ContraindicationCopyFinding[] = []
  for (const flag of CONTRAINDICATION_FLAG_KEYS) {
    for (const at of ['label', 'action'] as const) {
      const text =
        at === 'label' ? CONTRAINDICATION_FLAG_LABELS[flag] : CONTRAINDICATION_FLAG_ACTIONS[flag]
      for (const finding of lintPublicDisplayName(text, policy)) {
        findings.push({ ...finding, flag, at })
      }
    }
  }
  return Object.freeze(findings)
}
