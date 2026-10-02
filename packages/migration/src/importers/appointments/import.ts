import type { SuppressionPepper, UnitOfWork, VisitQuarantine } from '@berelax/db'
import {
  IMPORT_CONTACT_KEY_KINDS,
  importContactHmac,
  insertMigratedVisit,
  recordImportedAppointment,
  resolveVisitTargets,
} from '@berelax/db'
import { AppError } from '@berelax/shared'
import type { ImporterDefinition, RowVerdict, StagedSourceRow } from '../../framework.ts'
import type { ImportedEntity } from '../../provenance.ts'
import type { ContactNormaliser } from '../customers/dedup.ts'
import type { VisitCell } from './workbook.ts'
import { parseVisitWorkbook, VISIT_OUTCOMES } from './workbook.ts'

/**
 * The visit-history importer — H-MIG-05, and the unit whose whole subject is the DIFFERENCE between a
 * reconstructed visit and a booking.
 *
 * ## The one sentence
 *
 * **A migrated appointment is not a booking anybody can change.** It is a treatment that was delivered
 * under the previous arrangement: nobody is going to arrive for it, no transition of the live machine
 * applies to it, and no money is owed on it. The flag 0130 adds exists so the availability solver and the
 * appointment-status machine can tell one from the other, and ZY361 plus ZY366 are what make the
 * distinction a property of the schema rather than a convention — a migrated row that enters the live
 * status machine is the defect those two prevent.
 *
 * Everything else here follows from that, and from the three things this import must NOT disturb.
 *
 * ## It contributes zero to the P&L, by construction and not by a filter
 *
 * The period before this system started is accounted for by H-MIG-07's opening balances. Counting these
 * visits as revenue as well would count that period twice, on a trial balance that would still balance
 * perfectly. So this importer writes no invoice, no payment and no journal entry: a statement line is a
 * directed sum over `journal_line` (ADR 0064), and a visit that is not in the ledger contributes nothing
 * to any line of it. The row carries `vat_rate_bp = 0` and `vat_fils = 0` for ADR 0069's reason, stated
 * one subject along: this system does not post output tax on a supply made before its books opened, and a
 * tax figure sitting on the row for a tax point outside these books is a figure somebody adds up.
 *
 * A filter — `where not migrated` in the revenue queries — was the obvious alternative and it is worse in
 * the specific way this repository keeps paying for: it is a claim restated in every reader, and the
 * reader that is forgotten is the one that reports revenue this business never took.
 *
 * ## It DOES appear in the visit history and in the retention cohorts
 *
 * Which is why the rows go in `appointment` rather than in a table of their own. `reporting.fact_appointment`
 * is a view over `appointment` joined to `booking`, the cohort activity is read from it, and a client's
 * record is read from the same rows — so a second table would mean a `union all` in every one of those
 * readers and a shorter history than this business has wherever one was missed.
 *
 * ## It is judged by the same invariants as a live booking
 *
 * `appointment_therapist_no_overlap` (an EXCLUDE over therapist and period, 0024) and
 * `assert_room_capacity` judge the imported rows exactly as they judge live ones, which is what makes "no
 * double-booked therapist, no room over capacity" a checkable claim about the imported dataset rather than
 * an assertion about this file. Nothing in the database judges the session CLOSE, so that one is enforced
 * at resolution time against `business_day.closes_at` — see `resolveVisitTargets`.
 *
 * Therapist overlap WITHIN one file is caught earlier, by {@link planVisitImport}, and the reason is the
 * report rather than the constraint: the exclusion constraint fires on the second insert and stops the run
 * with one conflict named, while the plan can see all the rows at once and name every clash in the report
 * so the file is corrected in one pass (ADR 0065). A clash against a row ALREADY in the database is left
 * to the constraint, deliberately — it means a date is wrong, and it is not something this file can be
 * corrected to agree with.
 *
 * ## The ledger stages a keyed digest and never the number
 *
 * ADR 0072, and it is this unit's constraint as much as H-MIG-04's: `import_row.payload` is kept for ever
 * and is invisible to every erasure probe. So the staged payload carries `HMAC-SHA256(json(e164), pepper)`
 * under H-MIG-04's OWN key kinds — the same kinds, so the digest of a person's number is the same value
 * `imported_contact` holds and the two records are joinable — and `apply` gets the plaintext from the plan
 * this run's `parse` built, exactly as `applyContactRow` does and for the reason recorded there.
 *
 * ## It creates no customer
 *
 * A number that resolves to no `customer` is QUARANTINED, not created. H-MIG-04 is the door a person
 * enters this database through: it is where the consent floor is enforced, where `created_via = 'import'`
 * is set and where the contact record that ZY273 holds to the facts is written. Creating a customer here
 * would be a second door into the same table with none of that, and the dependency on H-MIG-04 would stop
 * being real.
 */

export const VISITS_IMPORTER_NAME = 'appointments'

/**
 * The importer's own version, recorded on every run.
 *
 * `1`: nothing has read a visit history before. H-MIG-01 says what the version is for — an imported
 * figure that disagrees with what somebody believes has to be traceable to the CODE that read it as well
 * as to the row it came from — and for this importer the code's resolution IS the figure: which trading
 * date a 01:30 treatment landed on, and which service variant a slug and a duration chose, are decisions
 * made here.
 */
export const VISITS_IMPORTER_VERSION = '1'

/**
 * The tables this importer writes, schema-qualified and complete: ZY194 refuses provenance for anything
 * not in this list, and the report's before/after checksums are taken over exactly it.
 *
 * `imported_appointment` is first because it is the row that ALWAYS exists — 0119's and 0121's
 * arrangement — and here it is also what makes a quarantined line expressible at all.
 */
export const VISITS_IMPORTER_TARGETS: readonly string[] = Object.freeze([
  'public.imported_appointment',
  'public.booking',
  'public.appointment',
])

/**
 * The keys a staged visit payload may carry, and NOT ONE MORE.
 *
 * The structural half of ADR 0072's answer for this importer: the staging ledger keeps
 * `import_row.payload` for ever and no erasure reaches it, so a payload carrying anything beyond these
 * refuses the whole file rather than being imported and kept. `customerPhone` is the key whose absence is
 * the point — the number lives in `customer.phone_e164` and nowhere else.
 */
export const MINIMISED_VISIT_PAYLOAD_KEYS = [
  'contactHmac',
  'pepperVersion',
  'startedAt',
  'finishedAt',
  'durationMinutes',
  'serviceSlug',
  'therapistStaffReference',
  'roomCode',
  'outcome',
  'grossChargedFils',
] as const

export type MinimisedVisitPayloadKey = (typeof MINIMISED_VISIT_PAYLOAD_KEYS)[number]

export interface StagedVisitPayload {
  readonly contactHmac: string
  readonly pepperVersion: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly durationMinutes: number
  readonly serviceSlug: string
  readonly therapistStaffReference: string
  readonly roomCode: string
  readonly outcome: string
  readonly grossChargedFils: number
}

/**
 * Every reason a staged visit payload is refused, and every one of them is about the ROW'S OWN TEXT.
 *
 * A rejection fails the WHOLE FILE and imports nothing (ADR 0065), which is the right severity for these:
 * a mistyped instant, a duration that contradicts the period, an outcome that is not a finished visit and
 * a price that is not integer fils are all the file having been filled in wrongly, and the report naming
 * every bad line at once is what lets it be corrected in one pass rather than nine.
 *
 * A line that is well-formed and names a therapist, a room or a service this database does not hold is a
 * QUARANTINE instead — `VISIT_QUARANTINES` in `@berelax/db` — because that is a fact about the catalogue
 * rather than about the spreadsheet. The two lists are deliberately in different packages: the quarantine
 * vocabulary is checked by `imported_appointment`'s CHECK and so belongs beside the SQL, and naming either
 * list twice would be the second statement of a fact that drifts.
 *
 * Named values rather than message strings, for H-MIG-02's reason: a rejection is asserted by name in this
 * unit's tests, printed beside a line number for a person to act on, and branched on by nothing that can
 * read prose.
 */
export const VISIT_REJECTIONS = {
  payloadNotMinimised: 'staged-payload-must-carry-only-the-minimised-keys',
  digestNotKeyed: 'staged-visit-digest-must-be-a-keyed-hmac',
  pepperVersionMissing: 'staged-visit-digest-must-name-the-pepper-that-keyed-it',
  startedAtNotAnInstant: 'started-at-must-be-an-iso-instant-with-an-offset',
  finishedAtNotAnInstant: 'finished-at-must-be-an-iso-instant-with-an-offset',
  finishedAtNotAfterStartedAt: 'finished-at-must-be-after-started-at',
  durationNotWholeMinutes: 'duration-minutes-must-be-a-positive-whole-number',
  durationDisagreesWithThePeriod: 'duration-minutes-must-equal-finished-at-minus-started-at',
  serviceSlugMissing: 'service-slug-must-be-stated',
  therapistReferenceMissing: 'therapist-staff-reference-must-be-stated',
  roomCodeMissing: 'room-code-must-be-stated',
  outcomeNotAFinishedVisit: 'outcome-must-be-a-finished-visit',
  grossNotIntegerFils: 'gross-charged-must-be-whole-fils',
  grossNotPositive: 'gross-charged-must-be-positive',
  therapistOverlapsAnotherLine: 'therapist-is-already-on-another-line-at-that-time',
} as const

export type VisitRejection = (typeof VISIT_REJECTIONS)[keyof typeof VISIT_REJECTIONS]

/** Every reason, for a test that has to prove none was forgotten and none is unreachable. */
export const VISIT_REJECTION_REASONS: readonly VisitRejection[] = Object.freeze(
  Object.values(VISIT_REJECTIONS),
)

const HMAC = /^[a-f0-9]{64}$/

/**
 * An ISO 8601 instant that STATES its offset.
 *
 * `Date.parse` accepts `2026-06-02T22:30:00` and reads it as local time, which in this process is
 * whatever `TZ` happens to be — so a file of offset-less instants would import to a different trading
 * date on a developer's machine and on the server, and nothing would report it. The offset is therefore
 * part of the cell's shape and a missing one is a named rejection.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/

const MINIMISED = new Set<string>(MINIMISED_VISIT_PAYLOAD_KEYS)

const instantOf = (value: unknown): number | null => {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Judges one staged payload. Not one cell: by the time anything reaches here the number has been
 * normalised and keyed, and a cell that could not be read is carrying its own rejection from the plan.
 */
const stated = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0

/**
 * The digest and the pepper label, which are this code's own work rather than a person's.
 *
 * Split out of {@link validateStagedVisit} to keep each half under the complexity Biome allows, and the
 * split is along a real seam: a payload failing one of these did not come from `planVisitImport` at all,
 * while a payload failing one of the cell rules came from a cell somebody can go and correct.
 */
function validateStagedKeying(payload: Readonly<Record<string, unknown>>): RowVerdict {
  for (const key of Object.keys(payload)) {
    if (!MINIMISED.has(key)) return { ok: false, reason: VISIT_REJECTIONS.payloadNotMinimised }
  }
  const hmac = payload['contactHmac']
  if (typeof hmac !== 'string' || !HMAC.test(hmac)) {
    return { ok: false, reason: VISIT_REJECTIONS.digestNotKeyed }
  }
  if (!stated(payload['pepperVersion'])) {
    return { ok: false, reason: VISIT_REJECTIONS.pepperVersionMissing }
  }
  return { ok: true }
}

/** The two instants and the duration that must agree with them. ADR 0065's self-contradiction rule. */
function validateStagedPeriod(payload: Readonly<Record<string, unknown>>): RowVerdict {
  const startedAt = instantOf(payload['startedAt'])
  if (startedAt === null) return { ok: false, reason: VISIT_REJECTIONS.startedAtNotAnInstant }
  const finishedAt = instantOf(payload['finishedAt'])
  if (finishedAt === null) return { ok: false, reason: VISIT_REJECTIONS.finishedAtNotAnInstant }
  if (finishedAt <= startedAt) {
    return { ok: false, reason: VISIT_REJECTIONS.finishedAtNotAfterStartedAt }
  }
  const duration = payload['durationMinutes']
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration <= 0) {
    return { ok: false, reason: VISIT_REJECTIONS.durationNotWholeMinutes }
  }
  // The two instants and the duration come off one diary line, so this is the only cross-check there is
  // on either of them.
  if ((finishedAt - startedAt) / 60_000 !== duration) {
    return { ok: false, reason: VISIT_REJECTIONS.durationDisagreesWithThePeriod }
  }
  return { ok: true }
}

export function validateStagedVisit(payload: Readonly<Record<string, unknown>>): RowVerdict {
  const keying = validateStagedKeying(payload)
  if (!keying.ok) return keying
  const period = validateStagedPeriod(payload)
  if (!period.ok) return period

  if (!stated(payload['serviceSlug'])) {
    return { ok: false, reason: VISIT_REJECTIONS.serviceSlugMissing }
  }
  if (!stated(payload['therapistStaffReference'])) {
    return { ok: false, reason: VISIT_REJECTIONS.therapistReferenceMissing }
  }
  if (!stated(payload['roomCode'])) {
    return { ok: false, reason: VISIT_REJECTIONS.roomCodeMissing }
  }
  if (typeof payload['outcome'] !== 'string' || !VISIT_OUTCOMES.includes(payload['outcome'])) {
    return { ok: false, reason: VISIT_REJECTIONS.outcomeNotAFinishedVisit }
  }

  const gross = payload['grossChargedFils']
  if (typeof gross !== 'number' || !Number.isInteger(gross)) {
    return { ok: false, reason: VISIT_REJECTIONS.grossNotIntegerFils }
  }
  // Zero is refused rather than admitted, for ADR 0070's reason one subject along: a zero price reads as
  // a treatment given away, and it is indistinguishable from a figure nobody filled in.
  if (gross <= 0) return { ok: false, reason: VISIT_REJECTIONS.grossNotPositive }

  return { ok: true }
}

/** The staged payload, read back from `jsonb` with its keys typed. */
function readStaged(payload: Readonly<Record<string, unknown>>): StagedVisitPayload {
  const verdict = validateStagedVisit(payload)
  if (!verdict.ok) {
    throw new AppError(
      'invariant_violated',
      `A staged visit payload reached apply that staging should have refused (${verdict.reason}). ` +
        'Validation happens over every row before anything is applied, so reaching here means a payload ' +
        'was written into the ledger by something other than this importer.',
      { details: { reason: verdict.reason } },
    )
  }
  return {
    contactHmac: payload['contactHmac'] as string,
    pepperVersion: payload['pepperVersion'] as string,
    startedAt: payload['startedAt'] as string,
    finishedAt: payload['finishedAt'] as string,
    durationMinutes: payload['durationMinutes'] as number,
    serviceSlug: payload['serviceSlug'] as string,
    therapistStaffReference: payload['therapistStaffReference'] as string,
    roomCode: payload['roomCode'] as string,
    outcome: payload['outcome'] as string,
    grossChargedFils: payload['grossChargedFils'] as number,
  }
}

export interface VisitsImporterOptions {
  /**
   * The suppression pepper, injected. The digest staged in the ledger is keyed under it.
   *
   * Required, with no default and no fallback — H-MIG-04's reason: an unpeppered digest of a UAE mobile is
   * a phone number with extra steps (ADR 0064: the mobile space is small enough to enumerate). It must
   * also be the SAME pepper H-MIG-04 ran under, or the digests will not be the values `imported_contact`
   * holds and the two records will not join.
   */
  readonly pepper: SuppressionPepper
  /** `e164IdentityResult` from `@berelax/core`, injected. See `../customers/dedup.ts` on why. */
  readonly normalise: ContactNormaliser
}

/** One line, staged: the payload the ledger keeps, and the plaintext it deliberately does not. */
export interface StagedVisit {
  readonly lineNumber: number
  readonly payload: StagedVisitPayload
  /** The canonical number, for `apply` and for nothing that writes. `null` for an unreadable cell. */
  readonly e164: string | null
}

export interface VisitImportPlan {
  readonly rows: readonly StagedSourceRow[]
  /** Digest -> the number it was computed over. Never written anywhere. */
  readonly plaintextByHmac: ReadonlyMap<string, string>
  /** Lines the plan itself refuses, by name, before the database is touched. */
  readonly rejections: readonly { readonly lineNumber: number; readonly reason: VisitRejection }[]
  /**
   * The {@link visitClashKey} of every line in {@link rejections}, so `validate` can recognise one.
   *
   * The framework hands `validate` a payload and no line number (H-MIG-01's shape), so a file-scoped
   * verdict has to be reachable from the payload's own values. A set of keys rather than a scan of
   * `rejections` at every call: the alternative is quadratic in the file, and a visit history is the one
   * import that is thousands of lines long rather than tens.
   */
  readonly clashKeys: ReadonlySet<string>
  /** Lines whose number could not be read at all, so the file names a person nothing can resolve. */
  readonly unreadableNumbers: number
}

/**
 * The four values that identify one line of a visit history: whose visit, when it ran, and whose work.
 *
 * Not the line number, which `validate` is not given. Two lines agreeing on all four ARE the same visit
 * typed twice, which is itself an overlap — so a key that cannot tell them apart loses nothing.
 */
export const visitClashKey = (fields: Readonly<Record<string, unknown>>): string =>
  JSON.stringify([
    fields['contactHmac'],
    fields['startedAt'],
    fields['finishedAt'],
    fields['therapistStaffReference'],
  ])

interface Occupancy {
  readonly reference: string
  readonly from: number
  readonly to: number
  readonly lineNumber: number
}

/**
 * Normalises and keys ONE cell, producing the payload that may be staged and the plaintext it may not.
 *
 * The digest is `importContactHmac`'s under H-MIG-04's `number` kind for a cell that read as a number and
 * its `cell` kind for one that did not — deliberately the same two kinds, so a visit's digest is the value
 * `imported_contact` already holds for that person and the index on both tables is the join. A cell that
 * could not be read is still staged, keyed as it stands, because the line is evidence that a visit exists
 * whose holder nothing can identify; it quarantines at apply with `customer_not_imported`, which is true
 * of it in the only sense that matters.
 *
 * The two numeric cells go through {@link wholeOrNaN} and NOT through `Number(…)`, and the difference is
 * a fils-scale defect rather than a style question — it was found by the rejection vocabulary's own
 * completeness test, which could not reach `grossNotIntegerFils`. `Number('250.00')` is 250, an integer,
 * so a cell written as dirhams-and-cents would have imported as **250 fils** — two dirhams fifty — on a
 * row that passed every check. A strict run of digits is the only cell shape this column admits, and
 * anything else becomes NaN and is refused by name.
 */

/**
 * A cell that is a run of digits, or NaN.
 *
 * NaN rather than a throw or a null, because `validateStagedVisit` is where every cell-shaped refusal is
 * named and a second refusal path here would be a second vocabulary. A blank cell is NaN too, which the
 * validator reports as "must be a positive whole number" — the right sentence for somebody looking at an
 * empty cell in a spreadsheet.
 */
export const wholeOrNaN = (cell: string): number => {
  const trimmed = cell.trim()
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN
}
export function stageVisitCell(options: VisitsImporterOptions, cell: VisitCell): StagedVisit {
  const normalised = options.normalise(cell.phoneAsListed)
  const contactHmac = normalised.ok
    ? importContactHmac(options.pepper, IMPORT_CONTACT_KEY_KINDS.number, normalised.e164)
    : importContactHmac(options.pepper, IMPORT_CONTACT_KEY_KINDS.cell, cell.phoneAsListed)
  return {
    lineNumber: cell.lineNumber,
    e164: normalised.ok ? normalised.e164 : null,
    payload: {
      contactHmac,
      pepperVersion: options.pepper.version,
      startedAt: cell.startedAt,
      finishedAt: cell.finishedAt,
      durationMinutes: wholeOrNaN(cell.durationMinutes),
      serviceSlug: cell.serviceSlug,
      therapistStaffReference: cell.therapistStaffReference,
      roomCode: cell.roomCode,
      outcome: cell.outcome,
      grossChargedFils: wholeOrNaN(cell.grossChargedFils),
    },
  }
}

/**
 * The line numbers of every pair of lines that puts one therapist in two places at once.
 *
 * The file's own half of `appointment_therapist_no_overlap`. It compares BARE periods, exactly as the
 * constraint's `period WITH &&` does — not padded ones, because the constraint is what this mirrors and a
 * stricter in-file rule would refuse files the database would accept. BOTH lines of a clash are returned,
 * because a report that named one would have the person correct it and find the other on the next run.
 *
 * A line whose instants do not parse is skipped rather than compared: it is already a rejection by name
 * from `validateStagedVisit`, and `Date.parse` of a bad cell is NaN, which makes every comparison false
 * and would silently exclude the line from the clash pass without saying so.
 */
export function therapistClashes(cells: readonly VisitCell[]): readonly number[] {
  const occupied: Occupancy[] = []
  const clashing = new Set<number>()
  for (const cell of cells) {
    const from = Date.parse(cell.startedAt)
    const to = Date.parse(cell.finishedAt)
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue
    const reference = cell.therapistStaffReference
    if (reference.length === 0) continue
    for (const held of occupied) {
      if (held.reference !== reference) continue
      if (held.from < to && from < held.to) {
        clashing.add(held.lineNumber)
        clashing.add(cell.lineNumber)
      }
    }
    occupied.push({ reference, from, to, lineNumber: cell.lineNumber })
  }
  return [...clashing].sort((a, b) => a - b)
}

/**
 * Stages every line and names the clashes one file can see.
 *
 * Two passes rather than one, and they are separated because they answer different kinds of question:
 * {@link stageVisitCell} is about a cell, {@link therapistClashes} is about the file. Biome's complexity
 * limit is what made the split happen, and the split is the right shape anyway — each half is testable
 * without the other.
 */
export function planVisitImport(
  options: VisitsImporterOptions,
  cells: readonly VisitCell[],
): VisitImportPlan {
  if (typeof options.normalise !== 'function') {
    throw new AppError(
      'invariant_violated',
      'No phone normaliser was injected, so nothing produced a comparable contact key. Wire ' +
        '`e164IdentityResult` from @berelax/core. There is no fallback on purpose: an un-normalised key ' +
        'matches no customer, and because the plaintext never reaches the ledger no constraint can ' +
        'catch it — every line would quarantine as `customer_not_imported` and the file would look ' +
        'like a history of people this database has never heard of.',
    )
  }

  const rows: StagedSourceRow[] = []
  const plaintextByHmac = new Map<string, string>()
  const byLine = new Map<number, StagedVisitPayload>()
  let unreadableNumbers = 0

  for (const cell of cells) {
    const staged = stageVisitCell(options, cell)
    if (staged.e164 === null) unreadableNumbers += 1
    else plaintextByHmac.set(staged.payload.contactHmac, staged.e164)
    // Spread, so the row carries an object literal rather than the interface: `StagedSourceRow.payload`
    // is `Readonly<Record<string, unknown>>` and an interface without an index signature is not
    // assignable to it. `planContactImport` does the same, for the same reason.
    rows.push({ lineNumber: staged.lineNumber, payload: { ...staged.payload } })
    byLine.set(staged.lineNumber, staged.payload)
  }

  const rejections: { lineNumber: number; reason: VisitRejection }[] = []
  const clashKeys = new Set<string>()
  for (const lineNumber of therapistClashes(cells)) {
    rejections.push({ lineNumber, reason: VISIT_REJECTIONS.therapistOverlapsAnotherLine })
    const payload = byLine.get(lineNumber)
    if (payload !== undefined) clashKeys.add(visitClashKey({ ...payload }))
  }

  return { rows, plaintextByHmac, rejections, clashKeys, unreadableNumbers }
}

/**
 * Applies one staged visit line.
 *
 * Two outcomes and one shape: every line produces exactly one `imported_appointment` record, and a line
 * that RESOLVED produces the booking and the appointment beside it. That is what
 * `import_provenance_one_per_target` forces — no two lines may claim provenance on one row — and what
 * ZY196 forces, since an applied row that recorded nothing cannot COMMIT. ZY363 then holds the other
 * direction: a migrated appointment with no record behind it cannot COMMIT either.
 */
async function applyVisitRow(
  uow: UnitOfWork,
  payload: Readonly<Record<string, unknown>>,
  plan: () => VisitImportPlan,
): Promise<readonly ImportedEntity[]> {
  const staged = readStaged(payload)

  const quarantine = async (reason: VisitQuarantine): Promise<readonly ImportedEntity[]> => {
    const id = await recordImportedAppointment(uow, {
      contactHmac: staged.contactHmac,
      pepperVersion: staged.pepperVersion,
      outcome: 'quarantined',
      quarantineReason: reason,
    })
    return [{ table: 'imported_appointment', id }]
  }

  /*
    The plaintext number, from the plan this run's `parse` built — and the only place in this import where
    it exists outside `customer.phone_e164`.

    `apply` is handed a unit of work and a payload and nothing else (H-MIG-01's shape), and the payload
    carries a digest rather than a number, so the number has to come from the parse of the file this run
    is about. That is sound on every path the framework has: `runImport` parses before it stages, before
    it resumes and before a dry run, and a resumed run is the SAME run over the SAME file hash.

    A digest the plan does not hold is a cell that could not be read as a number — the plan keys those
    under the `cell` kind and records no plaintext for them — so it quarantines as a visit whose holder
    nothing can identify rather than throwing. That is the difference from `applyContactRow`, which
    throws: there, an unresolvable digest could only be a payload from another file, because a quarantined
    contact line carries its reason in the payload. Here the reason is not in the payload at all, so the
    absence of a plaintext IS the reason.
  */
  const e164 = plan().plaintextByHmac.get(staged.contactHmac)
  if (e164 === undefined) return quarantine('customer_not_imported')

  const resolution = await resolveVisitTargets(uow.sql, {
    phoneE164: e164,
    serviceSlug: staged.serviceSlug,
    durationMinutes: staged.durationMinutes,
    therapistStaffReference: staged.therapistStaffReference,
    roomCode: staged.roomCode,
    startedAt: staged.startedAt,
    finishedAt: staged.finishedAt,
  })
  if (!resolution.ok) return quarantine(resolution.reason)

  const inserted = await insertMigratedVisit(uow, {
    targets: resolution.targets,
    startedAt: staged.startedAt,
    finishedAt: staged.finishedAt,
    status: staged.outcome,
    grossFils: staged.grossChargedFils,
  })
  const id = await recordImportedAppointment(uow, {
    contactHmac: staged.contactHmac,
    pepperVersion: staged.pepperVersion,
    outcome: 'imported',
    appointmentId: inserted.appointmentId,
  })
  return [
    { table: 'imported_appointment', id },
    { table: 'booking', id: inserted.bookingId },
    { table: 'appointment', id: inserted.appointmentId },
  ]
}

/**
 * Builds the visit-history importer, and the plan one run shares.
 *
 * Stateful across `parse` and `apply`, which is H-MIG-04's arrangement for the same reason: the plan
 * carries the one thing that must not be written down, the map from a digest to the number it was
 * computed over. `parse` replaces the plan rather than adding to it, so two files in one process cannot
 * resolve through each other, and `apply` before any `parse` throws by name rather than resolving
 * nothing.
 *
 * `validate` carries the plan's own rejections too, which is why it is a closure here rather than
 * `validateStagedVisit` itself: the therapist-overlap claim is about the FILE and not about one payload,
 * so it cannot be judged from a payload alone — the same shape H-MIG-02's validator takes for its own
 * file-scoped claim.
 */
export function visitsImporter(options: VisitsImporterOptions): ImporterDefinition {
  let plan: VisitImportPlan | null = null
  const current = (): VisitImportPlan => {
    if (plan === null) {
      throw new AppError(
        'invariant_violated',
        'The visit importer was asked to apply a row before it had parsed a file. The plaintext number ' +
          'for a staged digest comes from the parse of the file being imported, so there is nothing to ' +
          'resolve through — and resolving through a previous file would attach this visit to another ' +
          "file's customer.",
      )
    }
    return plan
  }

  return {
    name: VISITS_IMPORTER_NAME,
    version: VISITS_IMPORTER_VERSION,
    targetTables: VISITS_IMPORTER_TARGETS,
    parse: (sourceText: string): readonly StagedSourceRow[] => {
      plan = planVisitImport(options, parseVisitWorkbook(sourceText))
      return plan.rows
    },
    validate: (payload: Readonly<Record<string, unknown>>): RowVerdict => {
      const verdict = validateStagedVisit(payload)
      if (!verdict.ok) return verdict
      // The file-scoped claim, recognised from the payload's own values — see `visitClashKey`.
      if (plan?.clashKeys.has(visitClashKey(payload)) !== true) return { ok: true }
      return { ok: false, reason: VISIT_REJECTIONS.therapistOverlapsAnotherLine }
    },
    apply: (uow: UnitOfWork, payload: Readonly<Record<string, unknown>>) =>
      applyVisitRow(uow, payload, current),
  }
}

/**
 * What an import of this file WOULD do, without a database and without staging anything.
 *
 * The forecast `scripts/migrate-visits.mjs --plan` prints and the dry run reports beside the framework's
 * own report: how many lines there are, how many name a number nothing can read, and which lines clash
 * with each other. Exported separately from the importer because it answers a question somebody asks
 * BEFORE deciding to import at all.
 */
export function planVisitHistory(
  options: VisitsImporterOptions,
  sourceText: string,
): VisitImportPlan {
  return planVisitImport(options, parseVisitWorkbook(sourceText))
}
