import {
  type CredentialAssessment,
  type CredentialPolicy,
  evaluateCredentialsOn,
  type HeldCredential,
  localDate,
} from '@berelax/core'
import {
  type Actor,
  businessDayAt,
  type ClearedReassignmentFlag,
  clearReassignmentFlags,
  flagAppointmentsForReassignment,
  type RaisedReassignmentFlag,
  type ReassignmentFlagInput,
  readCredentialPolicy,
  readEmployeeCredentials,
  readReassignmentCandidates,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * The nightly credential sweep (P-HR-03).
 *
 * The availability query already refuses to offer a therapist whose mandatory credentials have lapsed —
 * `tp_credential` in `packages/db/src/repositories/eligibility.ts` computes `any_missing` and
 * `any_expired` and the pool reports `credential_missing` / `credential_expired`. That protects every
 * booking taken from tomorrow onwards and does nothing at all for the ones already in the diary, which
 * is the gap this pass exists to close: a licence that lapses on Tuesday leaves a therapist with three
 * weeks of confirmed appointments they may no longer deliver, and until somebody looks at the rota
 * nothing in the system says so.
 *
 * ## What it does, and the three things it must never do
 *
 * It raises `appointment_reassignment_flag` on every FUTURE appointment whose therapist is not credential
 * eligible on **that appointment's trading date**, and clears the flag again once they are. And:
 *
 *   - **it never cancels.** `cancelled_by_salon` tells a customer their booking is gone when the
 *     intention is to keep it, and B-LIFE-01 makes it terminal;
 *   - **it never unassigns.** `appointment.therapist_id` is NOT NULL (0024) and, more to the point,
 *     `holds_resources` is GENERATED from the status, so releasing the appointment would hand the slot
 *     to somebody else while a human is still deciding;
 *   - **it never touches `appointment.status`**, so `appointment_status_history` records no transition
 *     that did not happen and no appointment reaches `no_show` or `cancelled_by_salon` as a side effect.
 *
 * Deciding who takes the appointment instead is P-HR-04's. This pass produces the work queue and the
 * evidence; it does not resolve anything.
 *
 * ## The date every comparison is made against is the APPOINTMENT's trading date
 *
 * Not the sweep instant, and this is the decision the whole pass turns on. A labour card expiring in
 * three weeks does not make tonight's appointment unservable and does make the one a month out
 * unservable, so judging every appointment at "now" would flag nothing until the morning after the
 * expiry — by which point the therapist has kept a month of bookings the booking page had already
 * stopped offering. Judging each appointment at its own trading date is also the only reading that
 * AGREES with availability, whose SQL compares `expires_on < trading_date` for the date being offered.
 * `evaluateCredentialsOn` is the shared rule; `credentialVerdict` — the availability port's own
 * predicate — is the same call with the detail discarded.
 *
 * Trading runs 11:00–02:00 (0011), so "the appointment's trading date" is not the calendar date of its
 * start: a document valid through the 18th covers the 18th's 01:30 appointment, whose calendar date is
 * the 19th. The trading date is a stored column on `appointment` precisely so no caller re-derives it.
 *
 * ## The window, and why it is read from `business_day`
 *
 * "Future" starts at the sweep instant and the window's trading-date floor comes from
 * {@link businessDayAt} — the calendar's own `opens_at`/`closes_at` — never from the instant's calendar
 * date. At 00:30 the session in force opened yesterday, so tonight's 01:30 appointment carries
 * yesterday's trading date; a floor of `date(at)` would skip it, which is the two hours of every trading
 * day in which a therapist whose card lapsed at local midnight keeps their bookings.
 *
 * ## Idempotent because the database says so
 *
 * `appointment_reassignment_flag_one_live_per_appointment` is a partial unique index and the insert is
 * `on conflict do nothing`, so a second pass on the same business day inserts nothing, returns nothing,
 * and therefore writes no second audit row and publishes no second event. The outbox key is
 * `appointment.needs_reassignment:<appointment id>:<detected trading date>`, so even a pass whose
 * transaction is retried after the flag committed cannot enqueue a duplicate. Nothing is remembered in
 * this module: 0031 records what that costs — a job holding "already flagged" in its own state raises a
 * second copy the first time that state is lost.
 */

/** The `agent_definition` this pass reports to. Seeded by 0058; `assertRegistry` refuses a cron without one. */
export const CREDENTIAL_SWEEP_AGENT = 'credential_sweep'

/** The staff notification. One per newly flagged appointment, naming the document type. */
export const CREDENTIAL_REASSIGNMENT_EVENT = 'appointment.needs_reassignment'
/** Published when a renewal puts the appointment back in order, so the queue's own state travels too. */
export const CREDENTIAL_REASSIGNMENT_CLEARED_EVENT = 'appointment.reassignment_cleared'

/** `actor_id` is a uuid column; the label is where a name goes. */
const ACTOR: Actor = { kind: 'system', label: 'credential.sweep' }

export interface CredentialSweepResult {
  /** The trading date the pass was made for — the session the instant belongs to. */
  readonly asOf: string
  /** True when the instant was inside that session's own hours, which a nightly pass is not. */
  readonly withinTradingHours: boolean
  /** Future appointments considered. Reported even when zero, so "nothing wrong" is not "nothing ran". */
  readonly considered: number
  /** Flags this pass raised. Empty on a second pass of the same day, which is the acceptance criterion. */
  readonly flagged: readonly RaisedReassignmentFlag[]
  /** Flags this pass cleared because the therapist is eligible again. */
  readonly cleared: readonly ClearedReassignmentFlag[]
  /** The `regulatory_profile` version the mandatory set was read from. */
  readonly profileVersion: number
}

/**
 * One pass, for the business day containing `atIso`.
 *
 * `atIso` is injected rather than read, so the pass is reproducible: the integration suite drives it at a
 * frozen clock and asserts that the second run flags nothing, which is exactly what a job reading
 * `new Date()` could not be asked.
 */
export async function runCredentialSweep(sql: Sql, atIso: string): Promise<CredentialSweepResult> {
  const day = await businessDayAt(sql, atIso)
  if (day === null) {
    throw new AppError(
      'invariant_violated',
      `The credential sweep ran at ${atIso} and business_day holds no trading session at or before ` +
        'it, so there is no trading date to floor the window at and none to date the flags on. ' +
        'Generate the trading calendar (generateBusinessDays) first: flooring the window with the ' +
        "instant's own calendar date would skip every appointment after midnight, whose trading date " +
        'is the day before.',
    )
  }

  // Read ONCE, outside the loop, and the profile version is carried onto every flag. The mandatory set
  // is append-only and versioned (ADR 0008): a pass that re-read it per therapist could judge the first
  // half of the roster against one answer and the second half against another, and no flag would say
  // which.
  const policy = await readCredentialPolicy(sql)
  const candidates = await readReassignmentCandidates(sql, {
    fromTradingDate: day.tradingDate,
    fromInstant: atIso,
  })

  const credentials = await heldByTherapist(
    sql,
    candidates.map((candidate) => candidate.therapistId),
  )

  const toFlag: ReassignmentFlagInput[] = []
  const toClear: string[] = []
  for (const candidate of candidates) {
    const blocking = blockingCredential({
      credentials: credentials.get(candidate.therapistId) ?? [],
      policy,
      tradingDate: candidate.tradingDate,
    })
    if (blocking === undefined) {
      // Eligible for THIS appointment's trading date. Any live flag is withdrawn — which is the whole of
      // "renewing the document before the appointment unflags it on the next sweep", with no manual step:
      // the renewal is a new `employee_document` row and this pass reads the latest expiry per type.
      toClear.push(candidate.appointmentId)
      continue
    }
    toFlag.push({
      appointmentId: candidate.appointmentId,
      therapistId: candidate.therapistId,
      appointmentTradingDate: candidate.tradingDate,
      reason: blocking.status === 'MISSING' ? 'credential_missing' : 'credential_expired',
      documentType: blocking.documentType,
      // MISSING has no date to carry: there is no document. The database refuses the other pairing
      // (appointment_reassignment_flag_expiry_matches_reason).
      documentExpiresOn: blocking.status === 'MISSING' ? null : blocking.expiresOn,
      regulatoryProfileVersion: policy.profileVersion,
      detectedOn: day.tradingDate,
    })
  }

  // One transaction for the rows, the audit and the events. Any two of the three committing without the
  // third is the bug `UnitOfWork` exists to make impossible: a flag with no audit row is a decision
  // nobody can account for, and an event with no flag notifies staff about a queue entry that is not
  // there.
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const flagged = await flagAppointmentsForReassignment(uow.sql, toFlag)
    const cleared = await clearReassignmentFlags(uow.sql, {
      appointmentIds: toClear,
      clearedOn: day.tradingDate,
    })

    for (const flag of flagged) {
      await uow.audit.record({
        action: 'appointment.needs_reassignment',
        entityType: 'appointment',
        entityId: flag.appointmentId,
        operation: 'create',
        // No `before`, because nothing changed on the appointment — which is the claim this pass makes
        // about itself, recorded rather than asserted.
        after: {
          flagId: flag.flagId,
          reason: flag.reason,
          documentType: flag.documentType,
          documentExpiresOn: flag.documentExpiresOn,
          therapistId: flag.therapistId,
          appointmentTradingDate: flag.appointmentTradingDate,
          regulatoryProfileVersion: flag.regulatoryProfileVersion,
          detectedOn: flag.detectedOn,
        },
      })
      await uow.publish({
        eventType: CREDENTIAL_REASSIGNMENT_EVENT,
        aggregateType: 'appointment',
        aggregateId: flag.appointmentId,
        payload: {
          therapistId: flag.therapistId,
          appointmentTradingDate: flag.appointmentTradingDate,
          reason: flag.reason,
          // The document type is the point of the notification. "A credential lapsed" is the message
          // the recipient cannot act on; "the labour card expired on the 31st" is a renewal.
          documentType: flag.documentType,
          documentExpiresOn: flag.documentExpiresOn,
          detectedOn: flag.detectedOn,
          regulatoryProfileVersion: flag.regulatoryProfileVersion,
        },
        // Keyed on the appointment and the sweep's TRADING date, so a pass whose transaction is retried
        // after the flag committed enqueues nothing, and a genuine second lapse on a later day can still
        // notify.
        idempotencyKey: `${CREDENTIAL_REASSIGNMENT_EVENT}:${flag.appointmentId}:${flag.detectedOn}`,
      })
    }

    for (const flag of cleared) {
      await uow.audit.record({
        action: 'appointment.reassignment_cleared',
        entityType: 'appointment',
        entityId: flag.appointmentId,
        operation: 'update',
        after: {
          flagId: flag.flagId,
          reason: flag.reason,
          documentType: flag.documentType,
          clearedOn: day.tradingDate,
        },
      })
      await uow.publish({
        eventType: CREDENTIAL_REASSIGNMENT_CLEARED_EVENT,
        aggregateType: 'appointment',
        aggregateId: flag.appointmentId,
        payload: {
          therapistId: flag.therapistId,
          appointmentTradingDate: flag.appointmentTradingDate,
          documentType: flag.documentType,
          clearedOn: day.tradingDate,
        },
        idempotencyKey: `${CREDENTIAL_REASSIGNMENT_CLEARED_EVENT}:${flag.appointmentId}:${day.tradingDate}`,
      })
    }

    return {
      asOf: day.tradingDate,
      withinTradingHours: day.isOpen,
      considered: candidates.length,
      flagged,
      cleared,
      profileVersion: policy.profileVersion,
    }
  })
}

/**
 * Everything on file, by employee, for the therapists this pass is about.
 *
 * One read for the whole set rather than one per therapist: the pass touches every future appointment,
 * and a query per row makes the cost of a quiet night grow with the size of the diary rather than with
 * the number of problems.
 */
async function heldByTherapist(
  sql: Sql,
  therapistIds: readonly string[],
): Promise<ReadonlyMap<string, readonly HeldCredential[]>> {
  const unique = [...new Set(therapistIds)]
  const held = new Map<string, HeldCredential[]>()
  if (unique.length === 0) return held
  for (const row of await readEmployeeCredentials(sql, unique)) {
    const list = held.get(row.employeeId) ?? []
    list.push({
      documentType: row.documentType,
      expiresOn: row.expiresOn === null ? null : localDate(row.expiresOn),
    })
    held.set(row.employeeId, list)
  }
  return held
}

/**
 * The worst credential blocking this therapist on this trading date, or `undefined` when none is.
 *
 * `blocking` is ordered worst-first by `CREDENTIAL_STATUSES`, in which MISSING is worse than EXPIRED —
 * the same precedence the availability SQL gets from putting its `any_missing` arm ahead of
 * `any_expired`, and the same one `credentialVerdict` reproduces. They are different remedies: MISSING is
 * a document nobody has filed and EXPIRED is a renewal, and one label for both sends whoever reads the
 * notification to the wrong place.
 *
 * The whole policy is passed through, including `nonExpiringTypes`: a type the profile declares
 * non-expiring is VALID on the strength of the row existing, which is what the availability SQL's
 * `expires_on is not null and expires_on < trading_date` already says for every row the database
 * permits (0054's header makes that argument in full).
 */
function blockingCredential(args: {
  readonly credentials: readonly HeldCredential[]
  readonly policy: CredentialPolicy
  readonly tradingDate: string
}): CredentialAssessment | undefined {
  const { blocking } = evaluateCredentialsOn({
    credentials: args.credentials,
    policy: args.policy,
    asOfDate: localDate(args.tradingDate),
  })
  return blocking[0]
}
