import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The write path and the one translator for a reconstructed visit history (H-MIG-05, migration 0130).
 *
 * `packages/migration` may import this package and `@berelax/shared` and nothing else first-party, so
 * every statement this import issues against `appointment`, `booking` and `imported_appointment` is here
 * — the same arrangement `import-contacts.ts` holds for H-MIG-04 and `import-package-liability.ts` for
 * H-MIG-03. The importer decides WHAT a line means; this file is the only thing that knows how a
 * migrated appointment is spelled in SQL.
 *
 * ## Nothing here invents a resource
 *
 * {@link resolveVisitTargets} answers with an id or with a NAMED reason it could not, and it never
 * answers with a nearest match, a default room or a placeholder therapist. The acceptance line is
 * "quarantined with a reason rather than assigned to a placeholder", and the placeholder therapist is the
 * specific thing it forbids: a treatment somebody else performed, filed against a named person, enters
 * their commission base (P-HR-11), their utilisation and the figure their performance is read off.
 *
 * The employment window is part of resolution and not a separate check, which is the one decision in this
 * file somebody would simplify away. A staff reference that resolves to an employee who had not started —
 * or had already left — on the day of the visit is a reference that has been REUSED, and importing it
 * would file somebody else's work against the person who holds the reference now. Resolution therefore
 * asks "who held this reference on that trading date", which has no answer rather than a wrong one.
 */

/** The SQLSTATEs `packages/db/migrations/0130_appointment_migrated.sql` raises. */
export const APPOINTMENT_IMPORT_SQLSTATE = {
  /** A migrated appointment's status, period, therapist, room, service or price was changed. */
  migratedAppointmentIsNotLive: 'ZY361',
  /** The `migrated` flag was set or cleared on an existing appointment. */
  migratedFlagIsImmutable: 'ZY362',
  /** A migrated appointment no imported-appointment record names. Raised at COMMIT. */
  migratedAppointmentIsUnattested: 'ZY363',
  /** An imported-appointment record was updated or deleted. */
  importedAppointmentImmutable: 'ZY364',
  /** An imported-appointment record names an appointment that is not migrated. Raised at COMMIT. */
  importedAppointmentNamesALiveBooking: 'ZY365',
  /** A migrated appointment ends in the future. */
  migratedAppointmentIsNotHistory: 'ZY366',
} as const

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Translates a refusal from 0130 into an `AppError`, or `null` for anything else.
 *
 * The match is on SQLSTATE alone, for `refusals.ts`'s reason: matching on the message would make the
 * translation depend on wording, and a reworded message would silently stop translating — after which the
 * caller that reads "this visit is reconstructed history" as an unknown failure is the caller that retries
 * the transition.
 *
 * The KINDS are chosen by what the caller has to go and do:
 *
 *   - `forbidden` for ZY361, ZY362 and ZY364 — the statement will never be permitted, for any caller,
 *     with any data. A reconstructed visit is corrected by importing the corrected file (ADR 0061).
 *   - `validation` for ZY366 — the file being imported carries a date that is not in the past, which is
 *     a cell somebody can go and look at.
 *   - `invariant_violated` for ZY363 and ZY365 — this code, not the person running the import, produced a
 *     migrated row with no record behind it or a record pointing at a live booking. A validation failure
 *     would send whoever reads it to the spreadsheet, which is the one place the defect is not.
 */
export function appointmentImportError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  const details = { sqlState: code }
  switch (code) {
    case APPOINTMENT_IMPORT_SQLSTATE.migratedAppointmentIsNotLive:
    case APPOINTMENT_IMPORT_SQLSTATE.migratedFlagIsImmutable:
    case APPOINTMENT_IMPORT_SQLSTATE.importedAppointmentImmutable:
      return new AppError('forbidden', message, { details })
    case APPOINTMENT_IMPORT_SQLSTATE.migratedAppointmentIsNotHistory:
      return new AppError('validation', message, { details })
    case APPOINTMENT_IMPORT_SQLSTATE.migratedAppointmentIsUnattested:
    case APPOINTMENT_IMPORT_SQLSTATE.importedAppointmentNamesALiveBooking:
      return new AppError('invariant_violated', message, { details })
    default:
      return null
  }
}

export const isMigratedAppointmentNotLiveRefusal = (err: unknown): boolean =>
  sqlState(err) === APPOINTMENT_IMPORT_SQLSTATE.migratedAppointmentIsNotLive

/**
 * Every reason a well-formed line names something this database cannot resolve.
 *
 * A closed vocabulary of short lower-case names, matching `imported_appointment.quarantine_reason`'s
 * CHECK, for H-MIG-02's reason: a quarantine is asserted by name in a test, printed beside a line number
 * for somebody to act on, and branched on by nothing that can read prose.
 *
 * They are QUARANTINES and not rejections, and the split is deliberate. A rejection is about the row's own
 * text and fails the whole file (ADR 0065), because a malformed visit history is a file that was filled in
 * wrongly. A quarantine is about this database: the line is well-formed and names a therapist, a room or a
 * service that is not here, which is a fact about the catalogue and the staff list rather than about the
 * spreadsheet — and refusing the file for it would mean no history could be imported until every room the
 * business has ever used had been re-created.
 */
export const VISIT_QUARANTINES = {
  /** The number resolves to no `customer`. H-MIG-04's contact list has not been imported, or not this row. */
  customerNotImported: 'customer_not_imported',
  /** No employee holds this staff reference. */
  therapistReferenceUnknown: 'therapist_reference_unknown',
  /** An employee holds it, but not on the day of the visit — so the reference has been reused. */
  therapistNotEmployedThen: 'therapist_not_employed_then',
  /** No room carries this code. */
  roomCodeUnknown: 'room_code_unknown',
  /** No service variant has this slug at this duration. */
  serviceNotInTheCatalogue: 'service_not_in_the_catalogue',
  /** The instant falls in no trading session: `business_day` has no row covering it. */
  tradingDateIsNotASession: 'trading_date_is_not_a_session',
  /** The treatment plus its turnaround would end after the session closes. */
  runsPastCloseWithTurnaround: 'runs_past_close_with_turnaround',
  /** The service is a Four Hands or a couple's treatment. See `resolveVisitTargets`. */
  shapeIsNotSolo: 'shape_is_not_solo',
} as const

export type VisitQuarantine = (typeof VISIT_QUARANTINES)[keyof typeof VISIT_QUARANTINES]

/** Every reason, for a test that has to prove none was forgotten and none is unreachable. */
export const VISIT_QUARANTINE_REASONS: readonly VisitQuarantine[] = Object.freeze(
  Object.values(VISIT_QUARANTINES),
)

export interface VisitTargetRequest {
  /** The holder's number in E.164. It is never staged — see the importer's `parse`. */
  readonly phoneE164: string
  readonly serviceSlug: string
  readonly durationMinutes: number
  readonly therapistStaffReference: string
  readonly roomCode: string
  /** ISO 8601 with an offset. The instant the treatment began. */
  readonly startedAt: string
  /** ISO 8601 with an offset. The instant it finished. */
  readonly finishedAt: string
}

export interface ResolvedVisitTargets {
  readonly customerId: string
  readonly serviceVariantId: string
  readonly therapistId: string
  readonly roomId: string
  readonly tradingDate: string
  readonly shape: string
  readonly turnaroundMinutes: number
  readonly therapistBufferMinutes: number
}

export type VisitResolution =
  | { readonly ok: true; readonly targets: ResolvedVisitTargets }
  | { readonly ok: false; readonly reason: VisitQuarantine }

const unresolved = (reason: VisitQuarantine): VisitResolution => ({ ok: false, reason })

/**
 * Resolves one line's customer, service, therapist, room and trading date, or names why it could not.
 *
 * The trading date comes from `business_day` and not from arithmetic, which is the acceptance line "an
 * imported appointment starting at 01:30 resolves to the previous business_day, asserted against the
 * business_day primitive". The table holds `[opens_at, closes_at)` per trading date — 11:00 to 02:00 for
 * this business — so the instant 01:30 on the 3rd is inside the 2nd's row and the containment query IS the
 * resolution. `resolveTradingDate` in `@berelax/core` is the same rule stated as a function over a weekly
 * pattern and dated overrides, and `business-days.itest.ts` is what holds the two equal; this package may
 * not import `@berelax/core` at all, so reading the table is not a shortcut around the primitive, it is
 * the primitive. It also means the answer is the row the foreign key will demand, which arithmetic would
 * only usually agree with.
 *
 * The window is half-open on both sides, matching `tradingBounds`: a treatment starting exactly at close
 * belongs to no session, which is the off-by-one that produces a therapist rostered for a shift that has
 * finished.
 *
 * Only `solo` shapes resolve. A Four Hands is two appointment rows sharing a `delivery_id` and a couple's
 * treatment is two clients in one room, and the previous arrangement's records do not say which rows went
 * together — so reconstructing one would mean choosing a pairing, and `assert_delivery_is_coherent`
 * (ZB004) would then be judging a grouping this code invented. Deferred to H-MIG-11 rather than guessed.
 */
export async function resolveVisitTargets(
  sql: Sql,
  request: VisitTargetRequest,
): Promise<VisitResolution> {
  const day = await sql<{ tradingDate: string; closesAt: Date }[]>`
    select trading_date::text as "tradingDate", closes_at as "closesAt"
      from business_day
     where opens_at <= ${request.startedAt}::timestamptz
       and closes_at > ${request.startedAt}::timestamptz
  `
  const session = day[0]
  if (session === undefined) return unresolved(VISIT_QUARANTINES.tradingDateIsNotASession)

  const customer = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = ${request.phoneE164}
  `
  const customerId = customer[0]?.id
  if (customerId === undefined) return unresolved(VISIT_QUARANTINES.customerNotImported)

  const variant = await sql<
    {
      id: string
      shape: string
      turnaroundMinutes: number
      therapistBufferMinutes: number
      therapistsRequired: number
      roomsRequired: number
    }[]
  >`
    select v.id,
           rs.shape::text              as shape,
           s.turnaround_minutes        as "turnaroundMinutes",
           rs.therapist_buffer_minutes as "therapistBufferMinutes",
           rs.therapists_required      as "therapistsRequired",
           rs.rooms_required           as "roomsRequired"
      from service_variant v
      join service s on s.id = v.service_id
      join service_resource_shape rs
        on rs.service_style = s.style and rs.service_treatment_key = s.treatment_key
     where s.slug = ${request.serviceSlug}
       and v.duration_minutes = ${request.durationMinutes}
  `
  const service = variant[0]
  if (service === undefined) return unresolved(VISIT_QUARANTINES.serviceNotInTheCatalogue)
  if (
    service.shape !== 'solo' ||
    Number(service.therapistsRequired) !== 1 ||
    Number(service.roomsRequired) !== 1
  ) {
    return unresolved(VISIT_QUARANTINES.shapeIsNotSolo)
  }

  // The turnaround is the room's, so the session has to hold the treatment AND the changeover after it.
  // `assert_room_capacity` and `appointment_therapist_no_overlap` judge the overlap between imported rows;
  // nothing in the database judges the close, so this is where "nothing past close once turnaround is
  // counted" is enforced for an import — and it is enforced against the session's own `closes_at`, which
  // is the same column `tradingBounds` derives.
  const endsWithTurnaround = new Date(
    new Date(request.finishedAt).getTime() + Number(service.turnaroundMinutes) * 60_000,
  )
  if (endsWithTurnaround.getTime() > session.closesAt.getTime()) {
    return unresolved(VISIT_QUARANTINES.runsPastCloseWithTurnaround)
  }

  const employee = await sql<{ id: string; employedThen: boolean }[]>`
    select id,
           (employed_from <= ${session.tradingDate}::date
            and (employed_until is null or employed_until >= ${session.tradingDate}::date))
             as "employedThen"
      from employee
     where staff_reference = ${request.therapistStaffReference}
  `
  const therapist = employee[0]
  if (therapist === undefined) return unresolved(VISIT_QUARANTINES.therapistReferenceUnknown)
  if (!therapist.employedThen) return unresolved(VISIT_QUARANTINES.therapistNotEmployedThen)

  const room = await sql<{ id: string }[]>`select id from rooms where code = ${request.roomCode}`
  const roomId = room[0]?.id
  if (roomId === undefined) return unresolved(VISIT_QUARANTINES.roomCodeUnknown)

  return {
    ok: true,
    targets: {
      customerId,
      serviceVariantId: service.id,
      therapistId: therapist.id,
      roomId,
      tradingDate: session.tradingDate,
      shape: service.shape,
      turnaroundMinutes: Number(service.turnaroundMinutes),
      therapistBufferMinutes: Number(service.therapistBufferMinutes),
    },
  }
}

export interface MigratedVisitInput {
  readonly targets: ResolvedVisitTargets
  readonly startedAt: string
  readonly finishedAt: string
  /** One of the four terminal labels `appointment_migrated_is_finished` admits. */
  readonly status: string
  /** What the previous arrangement's record says was charged, VAT-inclusive, in integer fils. */
  readonly grossFils: number
}

export interface InsertedMigratedVisit {
  readonly bookingId: string
  readonly appointmentId: string
}

/**
 * Inserts one reconstructed visit: a booking row and the appointment on it.
 *
 * **One booking per visit, and not one per customer-day.** The previous arrangement's records do not say
 * which visits were taken as one booking, so grouping them would be inventing a fact the CRM reads — and
 * the ungrouped reading is the one that cannot be wrong in the direction that matters: two bookings where
 * there was one understates nothing about the person's history, while one booking where there were two
 * would make a reconstructed `booking` row claim a multi-appointment visit nobody can check.
 *
 * `source = 'import'` is 0130's fifth value and the reason is in the migration: all four live channels
 * would be an invented fact about how a real customer booked.
 *
 * The whole gross goes to `net_fils` with `vat_rate_bp = 0` and `vat_fils = 0`, which
 * `appointment_migrated_posts_no_vat` also demands. ADR 0069 settled it one subject along: this system
 * does not post output VAT on a supply made before its books opened, and a tax figure sitting on the row
 * for a tax point outside these books is a figure somebody eventually adds up. Nothing is posted to the
 * ledger here at all — no invoice, no payment, no journal entry — which is why a migrated appointment
 * contributes zero to every line of every statement (ADR 0064: a line is a directed sum over
 * `journal_line`).
 */
export async function insertMigratedVisit(
  uow: UnitOfWork,
  input: MigratedVisitInput,
): Promise<InsertedMigratedVisit> {
  const { targets } = input
  const bookings = await uow.sql<{ id: string }[]>`
    insert into booking (customer_id, source) values (${targets.customerId}::uuid, 'import')
    returning id
  `
  const bookingId = bookings[0]?.id
  if (bookingId === undefined) {
    throw new AppError(
      'invariant_violated',
      'The booking insert for a reconstructed visit returned no row, which cannot happen for an ' +
        'INSERT ... RETURNING that did not raise.',
    )
  }

  const appointments = await uow.sql<{ id: string }[]>`
    insert into appointment (
      booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
      gross_price_fils, net_fils, vat_fils, vat_rate_bp, turnaround_minutes,
      therapist_buffer_minutes, room_places, migrated
    ) values (
      ${bookingId}::uuid,
      ${targets.tradingDate}::date,
      ${targets.serviceVariantId}::uuid,
      ${targets.shape}::service_shape,
      ${targets.therapistId}::uuid,
      ${targets.roomId}::uuid,
      tstzrange(${input.startedAt}::timestamptz, ${input.finishedAt}::timestamptz, '[)'),
      ${input.status}::appointment_status,
      ${input.grossFils},
      ${input.grossFils},
      0,
      0,
      ${targets.turnaroundMinutes},
      ${targets.therapistBufferMinutes},
      1,
      true
    )
    returning id
  `
  const appointmentId = appointments[0]?.id
  if (appointmentId === undefined) {
    throw new AppError(
      'invariant_violated',
      'The appointment insert for a reconstructed visit returned no row, which cannot happen for an ' +
        'INSERT ... RETURNING that did not raise.',
    )
  }
  return { bookingId, appointmentId }
}

export interface ImportedAppointmentInput {
  /** From `importContactHmac`. Never a number. */
  readonly contactHmac: string
  readonly pepperVersion: string
  readonly outcome: 'imported' | 'quarantined'
  /** Required for `quarantined` and refused for `imported`, by CHECK. */
  readonly quarantineReason?: VisitQuarantine | null
  /** Required for `imported` and refused for `quarantined`, by CHECK. */
  readonly appointmentId?: string | null
}

/**
 * Records what one line of a reconstructed visit history became.
 *
 * One row per staged line, always — 0119's and 0121's arrangement, and the framework's reason: a staged
 * row that reaches `applied` having recorded no entity cannot COMMIT (ZY196), and the line that recorded
 * nothing is precisely the line somebody has to go and look at. It is also what makes ZY363 able to be a
 * refusal rather than a convention: every migrated appointment has exactly one of these behind it.
 *
 * Nothing is audited here. The framework already writes one `migration.row.imported` audit row per staged
 * row naming every entity that row produced, and `imported_appointment.outcome` is the column ZY365 holds
 * to those same facts — a third statement would drift from both, which is the reason `import-contacts.ts`
 * records for its own three absences.
 */
export async function recordImportedAppointment(
  uow: UnitOfWork,
  input: ImportedAppointmentInput,
): Promise<string> {
  const reason = input.quarantineReason ?? null
  const appointmentId = input.appointmentId ?? null
  const rows = await uow.sql<{ id: string }[]>`
    insert into imported_appointment
      (contact_hmac, pepper_version, outcome, quarantine_reason, appointment_id)
    values (
      ${input.contactHmac}, ${input.pepperVersion}, ${input.outcome}, ${reason},
      ${appointmentId}::uuid
    )
    returning id
  `
  const id = rows[0]?.id
  if (id === undefined) {
    throw new AppError(
      'invariant_violated',
      'The imported-appointment insert returned no row, which cannot happen for an INSERT ... RETURNING ' +
        'that did not raise. Treated as a failure rather than ignored: the alternative is an applied row ' +
        'whose provenance nobody holds an id for.',
    )
  }
  return id
}

export interface ImportedAppointmentCounts {
  readonly imported: number
  readonly quarantined: number
}

/**
 * The counts an import report is read off.
 *
 * Counted in SQL rather than by reading rows into the process, for `settings-store.itest.ts`'s recorded
 * reason: this table only grows, so a capped reader would pin both sides of a delta at its limit and three
 * recorded imports would read as zero. Totals rather than a per-run scope, because a suite asserts a
 * DELTA across an import (brief rule 9).
 */
export async function readImportedAppointmentCounts(sql: Sql): Promise<ImportedAppointmentCounts> {
  const rows = await sql<{ imported: string; quarantined: string }[]>`
    select count(*) filter (where outcome = 'imported')::text    as imported,
           count(*) filter (where outcome = 'quarantined')::text as quarantined
      from imported_appointment
  `
  const row = rows[0]
  return {
    imported: Number(row?.imported ?? '0'),
    quarantined: Number(row?.quarantined ?? '0'),
  }
}
