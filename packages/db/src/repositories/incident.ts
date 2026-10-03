import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The incident register's one writer (H-HARD-07).
 *
 * Three tables, three functions, and the filing is where the whole unit lives.
 *
 * ## Why filing an incident and dating its duties is ONE transaction
 *
 * Because a personal-data-breach row is a statutory clock that has started. If the duties were dated in
 * a second transaction, a failure between the two would leave a breach on file with nothing counting —
 * and that is not a state anybody would notice, because the register would look complete and the
 * calendar would simply have no entry. The database refuses it rather than trusting this module:
 * `incident_breach_duties_dated` is a DEFERRED constraint trigger, so a transaction that filed a breach
 * and dated fewer than both duties raises `ZY524` at COMMIT, whatever path it took. Deferred because the
 * `obligation_instance` rows cannot exist before the incident they reference, so an immediate check
 * would refuse every correct filing.
 *
 * That makes this module's correctness checkable rather than assumed, which is the point: a second
 * writer added later gets the same refusal.
 *
 * ## Why the deadline arrives as an argument
 *
 * `breachNotificationDeadline` is in `@berelax/core` and `packages/db` may never import it (ADR 0001).
 * That is the right way round here rather than an obstacle: the deadline depends on a `provisional`
 * setting and on a civil-zone calculation, and neither belongs in a query. The caller reads the period,
 * computes the deadline and hands over both the instant and the date — so this module cannot quietly
 * disagree with the pure function about when a notification was due, and the one date in the calendar
 * and the one instant on the record came from the same computation.
 *
 * ## Why there is no update function
 *
 * `incident`, `incident_addendum` and `incident_notification` all refuse UPDATE and DELETE (ZY521, ZY522,
 * ZY523). The question a register is asked is what was known WHEN, and an edited row reads identically
 * whether a figure was known at filing or written in last week. {@link addIncidentAddendum} is the
 * correction mechanism, and a correction to a correction is another addendum.
 */

/** The fields a filer supplies for every incident, breach or not. */
export interface FileIncidentArgs {
  readonly reference: string
  readonly incidentClass: string
  /** ISO 8601, or null where the filer does not know when it happened. */
  readonly occurredAtIso: string | null
  /** ISO 8601. THE CLOCK — every deadline derives from this and never from the filing. */
  readonly discoveredAtIso: string
  readonly recordedByRole: string
  readonly recordedByLabel: string
  readonly summary: string
  readonly location: string
  readonly immediateAction: string
  readonly measuresProposed?: string | null
  readonly peopleAffectedCount: number
  readonly injuryReported: boolean
  readonly emergencyServicesAttended: boolean
  readonly claimAnticipated: boolean
  /** Fils (ADR 0007). `null` where unknown, and never 0 — an insurer reads a zero as a claim. */
  readonly estimatedLossFils?: bigint | null
  /** Required exactly when the class is `personal_data_breach`; refused otherwise, by CHECK. */
  readonly breach?: BreachFields
  /**
   * The dated duties, which a breach filing must carry and a non-breach filing must not.
   *
   * Computed by `breachNotificationDeadline` in `@berelax/core` and passed in, so this module and the
   * pure function cannot disagree about when a notification was due.
   */
  readonly duties?: readonly DutyToDate[]
}

export interface BreachFields {
  readonly personalDataCategories: readonly string[]
  readonly dataSubjectsAffectedEstimate: number
  readonly recordsAffectedEstimate: number
  readonly likelyConsequences: string
  readonly crossBorderTransfer: boolean
}

/** One duty to date against this incident: the obligation's key and the civil date it falls due. */
export interface DutyToDate {
  readonly obligationKey: string
  /** `YYYY-MM-DD`, from `breachNotificationDeadline().dueOn`. */
  readonly dueOn: string
}

export interface FiledIncident {
  readonly incidentId: string
  readonly reference: string
  /** The instance ids created, in the order the duties were given. */
  readonly obligationInstanceIds: readonly string[]
}

/**
 * Files an incident and dates its duties, in one transaction.
 *
 * Takes a {@link UnitOfWork} rather than a `Sql`, so the `audit_event` row and the register row commit
 * or roll back together: an incident nobody is attributed to is a register nobody is accountable for,
 * and the audit trail is where "who filed this" is already recorded for every other act.
 */
export async function fileIncident(
  uow: UnitOfWork,
  args: FileIncidentArgs,
): Promise<FiledIncident> {
  const breach = args.breach
  const [row] = await uow.sql<{ id: string }[]>`
    insert into incident (
      reference, incident_class, occurred_at, discovered_at,
      recorded_by_role, recorded_by_label,
      summary, location, immediate_action, measures_proposed,
      people_affected_count, injury_reported, emergency_services_attended, claim_anticipated,
      estimated_loss_fils,
      personal_data_categories, data_subjects_affected_estimate, records_affected_estimate,
      likely_consequences, cross_border_transfer
    ) values (
      ${args.reference},
      ${args.incidentClass}::incident_class,
      ${args.occurredAtIso === null ? null : args.occurredAtIso}::timestamptz,
      ${args.discoveredAtIso}::timestamptz,
      ${args.recordedByRole},
      ${args.recordedByLabel},
      ${args.summary},
      ${args.location},
      ${args.immediateAction},
      ${args.measuresProposed ?? null},
      ${args.peopleAffectedCount},
      ${args.injuryReported},
      ${args.emergencyServicesAttended},
      ${args.claimAnticipated},
      ${args.estimatedLossFils === undefined || args.estimatedLossFils === null ? null : String(args.estimatedLossFils)},
      ${breach === undefined ? null : (breach.personalDataCategories as string[])},
      ${breach?.dataSubjectsAffectedEstimate ?? null},
      ${breach?.recordsAffectedEstimate ?? null},
      ${breach?.likelyConsequences ?? null},
      ${breach?.crossBorderTransfer ?? null}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'The incident row was not created and the insert did not raise.',
    )
  }

  const instanceIds: string[] = []
  for (const duty of args.duties ?? []) {
    const [instance] = await uow.sql<{ id: string }[]>`
      insert into obligation_instance (obligation_id, due_on, incident_id)
      select o.id, ${duty.dueOn}::date, ${row.id}::uuid
        from obligation o
       where o.key = ${duty.obligationKey}
      returning id
    `
    if (instance === undefined) {
      // A duty naming an obligation the calendar does not hold would otherwise insert nothing and
      // leave ZY524 to fire at COMMIT with a count, which names the symptom rather than the cause.
      throw new AppError(
        'validation',
        `No obligation is registered under the key "${duty.obligationKey}", so its deadline could not ` +
          'be dated. The two breach duties are seeded by migration 0142.',
      )
    }
    instanceIds.push(instance.id)
  }

  await uow.audit.record({
    action: 'incident.filed',
    entityType: 'incident',
    entityId: row.id,
    operation: 'create',
    // The reference, the class and the two instants. Deliberately NOT the summary: `audit_event` is
    // append-only (ADR 0008) and read by staff, and an incident's narrative can name a client.
    after: {
      reference: args.reference,
      incidentClass: args.incidentClass,
      discoveredAt: args.discoveredAtIso,
      dutiesDated: instanceIds.length,
    },
  })

  return { incidentId: row.id, reference: args.reference, obligationInstanceIds: instanceIds }
}

export interface AddendumArgs {
  readonly incidentId: string
  /** ISO 8601. When this was LEARNED, supplied rather than defaulted — see the migration's comment. */
  readonly addedAtIso: string
  readonly addedByRole: string
  readonly addedByLabel: string
  readonly body: string
  /** The incident column this corrects, or null for an addendum that only adds. */
  readonly correctsField?: string | null
}

/** The only way to add information to a filed incident. */
export async function addIncidentAddendum(
  uow: UnitOfWork,
  args: AddendumArgs,
): Promise<{ readonly addendumId: string }> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into incident_addendum (
      incident_id, added_at, added_by_role, added_by_label, body, corrects_field
    ) values (
      ${args.incidentId}::uuid, ${args.addedAtIso}::timestamptz, ${args.addedByRole},
      ${args.addedByLabel}, ${args.body}, ${args.correctsField ?? null}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'The addendum row was not created and the insert did not raise.',
    )
  }
  await uow.audit.record({
    action: 'incident.addendum_added',
    entityType: 'incident',
    entityId: args.incidentId,
    operation: 'create',
    after: { addendumId: row.id, correctsField: args.correctsField ?? null },
  })
  return { addendumId: row.id }
}

export interface NotificationArgs {
  readonly incidentId: string
  readonly party: string
  /** ISO 8601. Refused by ZY525 if it precedes the discovery it answers. */
  readonly notifiedAtIso: string
  readonly notifiedByRole: string
  readonly notifiedByLabel: string
  readonly channel: string
  readonly contentSummary: string
}

/** Records that somebody was told. Append-only: when they were told is the fact the clock rests on. */
export async function recordIncidentNotification(
  uow: UnitOfWork,
  args: NotificationArgs,
): Promise<{ readonly notificationId: string }> {
  const [row] = await uow.sql<{ id: string }[]>`
    insert into incident_notification (
      incident_id, party, notified_at, notified_by_role, notified_by_label, channel, content_summary
    ) values (
      ${args.incidentId}::uuid, ${args.party}::incident_notified_party,
      ${args.notifiedAtIso}::timestamptz, ${args.notifiedByRole}, ${args.notifiedByLabel},
      ${args.channel}, ${args.contentSummary}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'The notification row was not created and the insert did not raise.',
    )
  }
  await uow.audit.record({
    action: 'incident.notification_recorded',
    entityType: 'incident',
    entityId: args.incidentId,
    operation: 'create',
    after: { party: args.party, notifiedAt: args.notifiedAtIso, channel: args.channel },
  })
  return { notificationId: row.id }
}

/** One incident's duties, with the instant each was notified — or null where nobody has been told. */
export interface IncidentDutyRow {
  readonly obligationKey: string
  readonly dueOn: string
  readonly status: string
  readonly notifiedAt: string | null
}

/**
 * The duties dated against one incident, and when the matching party was told.
 *
 * The join from an obligation key to a notified party is spelled here because there is nothing to
 * derive it from: that `pdpl_breach_notification` is answered by telling the `supervisory_authority`
 * and `pdpl_breach_subject_notification` by telling the `data_subjects` is knowledge, not structure —
 * the same argument `unconfirmedAssumptionRows` makes for its singleton column mapping. Deciding
 * whether the notification was TIMELY is `notificationWasTimely` in `@berelax/core`, which compares
 * instants; this query does not, because `packages/db` may not import it and a second comparison would
 * be a second answer.
 */
export async function incidentDuties(
  sql: Sql,
  incidentId: string,
): Promise<readonly IncidentDutyRow[]> {
  return await sql<IncidentDutyRow[]>`
    select o.key as "obligationKey",
           oi.due_on::text as "dueOn",
           oi.status::text as status,
           -- ISO 8601 with an explicit Z, never a plain text cast. A timestamptz cast to text
           -- renders 2026-10-01 09:00:00+00, which the Date constructor refuses outright, and the
           -- symptom is a RangeError wherever the caller eventually parses it -- naming neither the
           -- cast nor the column. notificationWasTimely in @berelax/core takes an ISO string, so
           -- producing one here is what keeps the format out of every call site.
           --
           -- No backticks in this comment, deliberately: it is inside a tagged template literal, so
           -- one would END the template. That is a syntax error forty lines later in a different
           -- construct, and it cost a seed run to find.
           to_char((select min(n.notified_at)
              from incident_notification n
             where n.incident_id = oi.incident_id
               and n.party = case o.key
                               when 'pdpl_breach_notification' then 'supervisory_authority'
                               when 'pdpl_breach_subject_notification' then 'data_subjects'
                             end::incident_notified_party) at time zone 'UTC'
             , 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "notifiedAt"
      from obligation_instance oi
      join obligation o on o.id = oi.obligation_id
     where oi.incident_id = ${incidentId}::uuid
     order by oi.due_on, o.key
  `
}
