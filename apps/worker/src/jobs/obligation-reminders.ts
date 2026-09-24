/**
 * M-VAT-11 — the compliance calendar's daily pass, the per-notice send, and the rebuild.
 *
 * docs/04 §9: "Obligation definitions (statutory, recurring or event-driven) generate dated instances
 * with multi-step reminders, escalation if unacknowledged, and evidence attachment." M-VAT-10 built the
 * dated instances and left the cron to this file by name. Three jobs, and the shape is B-MSG-03's:
 *
 *   * `compliance.obligation-calendar` (cron) generates the next twelve months of occurrences, plans the
 *     reminders and escalations for the open ones, and hands every notice whose date has arrived to the
 *     queue below. All three steps are idempotent, so a reclaimed pass, a retry and a manual re-run all
 *     produce the same rows.
 *   * `compliance.send-obligation-notice` takes **a notice id and nothing else** — no body, no recipient,
 *     no template id. Everything is re-read under the notice's row lock and the invalidation key is
 *     compared against the key the occurrence's CURRENT due date derives. A payload carrying the body
 *     would be the damaging bug B-MSG-03 removed, wearing a compliance hat: a notice telling the owner a
 *     licence expires on a date the calendar no longer holds.
 *   * `compliance.rebuild-obligation-notices` re-plans the notices when either ladder setting changes,
 *     which is the F09 registry's `rerunJobs` doing the job its comment was written for.
 *
 * ## Why nothing is queued in advance
 *
 * Because the rows did not move. A worker outage means the first pass after the restart finds every notice
 * whose date has passed, and each one is answered — sent with a recorded note, or skipped with a recorded
 * reason. 0060's `obligation_notice_terminal_is_settled` makes the third outcome, a notice that quietly
 * ends in no state at all, unstorable.
 *
 * ## What this pass will NOT do today, and why that is visible rather than hidden
 *
 * It sends nothing, on a correctly configured production worker, because **no table in this build holds a
 * staff contact detail**. `recipientForRole` is an injected seam whose shipped value returns `null` for
 * every role — the same arrangement `send-scheduled-step.ts` has with `magicLink`, and for the same reason:
 * inventing a UAE mobile for the owner would be brief rule 15 exactly, a plausible value indistinguishable
 * from a configured one, and worse than a blank because a renewal notice sent to somebody else's phone is
 * a compliance disclosure. So every due notice is SKIPPED with `no_recipient_on_file` recorded on its row:
 * visible on the calendar, countable in a report, and not a notice nobody can trace.
 *
 * The integration suite injects a resolver, which is what exercises the gate, the outbox and the message
 * row end to end. Where the real contact detail comes from is P-HR's employment record or a settings
 * screen, and the manifest NOTE records it.
 */
import { loadConfig } from '@berelax/config'
import {
  ASIA_DUBAI,
  complianceAsOfDate,
  decideObligationNotice,
  type HoursForDate,
  type Instant,
  type LocalDate,
  localDate,
  localTime,
  type ObligationCadence,
  type ObligationClass,
  type ObligationSubjectScope,
  obligationInstancePlan,
  obligationNoticeOffsetsFrom,
  obligationNoticePlanFor,
  ROLES,
  type Role,
} from '@berelax/core'
import {
  type Actor,
  type ClaimedNotice,
  claimObligationNotice,
  createConnection,
  createPostgresMessageStore,
  dueObligationNotices,
  generateObligationInstances,
  OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
  OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
  type PlannedObligationNoticeRow,
  planObligationNotices,
  readCredentialSubjects,
  readCurrentTemplate,
  readObligationDefinitions,
  readObligationEscalationOffsets,
  readObligationNoticeSubjects,
  readObligationReminderOffsets,
  readTradingHoursAround,
  recordNoticeSent,
  recordNoticeSkipped,
  type Sql,
  supersedePendingNotices,
  withUnitOfWork,
} from '@berelax/db'
import {
  type DeliveryDeps,
  deliverMessage,
  InMemoryOutbox,
  type MessageId,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import {
  AppError,
  COMPLIANCE_CALENDAR_AGENT,
  REBUILD_OBLIGATION_NOTICES_JOB as REBUILD_JOB_NAME,
} from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/** Twelve months, which is what M-VAT-10's acceptance criterion asks the generator to cover. */
export const OBLIGATION_HORIZON_MONTHS = 12

/**
 * The ceiling on the therapist list a per-therapist obligation generates for.
 *
 * Bounded because the read is bounded, and asserted rather than trusted: a per-therapist obligation that
 * generated occurrences for only the first N therapists would leave the rest with no occurrence at all,
 * and a BLOCKING obligation with no occurrence never blocks — a compliance control that is missing rather
 * than failing. {@link therapistIdsFor} throws if the list comes back full.
 */
const THERAPIST_LIMIT = 500

/** The template a notice kind sends. Two keys, because the two messages say different things. */
const TEMPLATE_KEYS = {
  reminder: 'compliance.obligation_reminder',
  escalation: 'compliance.obligation_escalation',
} as const

/**
 * Where a notice for a role is sent, or `null`.
 *
 * The injected seam whose shipped value is absent. See this module's header: no table in this build holds
 * a staff phone number or address, and a plausible one reads as configured. A notice for a role with no
 * contact detail is SKIPPED with `no_recipient_on_file` recorded, which is a row somebody can look at.
 */
export type ComplianceRecipientResolver = (role: Role) => string | null

export interface ObligationNoticeRuntime {
  readonly sql: Sql
  /**
   * `deliverMessage`'s dependencies over a GIVEN connection, for the reason `send-scheduled-step.ts`
   * gives: the drain holds the notice's row lock for the length of the send, and the message row has to
   * commit with the notice's settlement or not at all. A store bound to the pool would leave a `message`
   * row for a notice still marked pending, and the next pass would send it again.
   */
  readonly deliveryFor: (sql: Sql) => DeliveryDeps
  readonly recipientForRole: ComplianceRecipientResolver
}

/**
 * Trading hours for the instant, as `complianceAsOfDate` needs them.
 *
 * Composed HERE and not in `packages/db`, because the composition needs both packages and neither may
 * import the other: the rows are `readTradingHoursAround`'s and the rule that picks which row contains the
 * instant is `resolveTradingDate`'s. `apps/web/src/collections/journal-posts.ts` does the same six lines
 * for the publish guard, and `apps/web/src/compliance/as-of.ts` for the two screens — three callers rather
 * than a shared helper, because the only package allowed to hold both halves is `packages/fixtures`, which
 * is test-only.
 */
export async function complianceAsOf(sql: Sql, atIso: string): Promise<LocalDate> {
  const atMs = Date.parse(atIso)
  const hours = await readTradingHoursAround(sql, atMs)
  const hoursFor: HoursForDate = (date) => {
    const row = hours.find((entry) => entry.tradingDate === date)
    return row === undefined
      ? undefined
      : { open: localTime(row.open), close: localTime(row.close) }
  }
  return complianceAsOfDate(atMs as Instant, hoursFor, ASIA_DUBAI)
}

/** The employees a per-therapist obligation generates an occurrence for, each. */
async function therapistIdsFor(sql: Sql, asOf: LocalDate): Promise<readonly string[]> {
  const subjects = await readCredentialSubjects(sql, { limit: THERAPIST_LIMIT, asOf })
  if (subjects.length >= THERAPIST_LIMIT) {
    throw new AppError(
      'invariant_violated',
      `[obligation-therapist-list-truncated] ${subjects.length} employees came back at the ceiling of ` +
        `${THERAPIST_LIMIT}, so the list may be short. A per-therapist obligation generated over a ` +
        'truncated list leaves the remaining therapists with no occurrence, and a blocking obligation ' +
        'with no occurrence never blocks — which is a compliance control that is missing rather than one ' +
        'that is failing.',
      { details: { returned: subjects.length, limit: THERAPIST_LIMIT } },
    )
  }
  // `readCredentialSubjects` rather than a second employment-period predicate here. It answers exactly
  // "which employees are employed on this date", which is the set a per-therapist obligation generates
  // for, and two spellings of that predicate would disagree the first time somebody changed one.
  return subjects.map((subject) => subject.employeeId)
}

/** Both ladders, normalised, read per pass rather than captured at boot. */
export async function ladderFor(sql: Sql): Promise<{
  readonly reminderOffsetsDays: readonly number[]
  readonly escalationOffsetsDays: readonly number[]
}> {
  return {
    reminderOffsetsDays: obligationNoticeOffsetsFrom(
      await readObligationReminderOffsets(sql),
      OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
    ),
    escalationOffsetsDays: obligationNoticeOffsetsFrom(
      await readObligationEscalationOffsets(sql),
      OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
    ),
  }
}

const ACTOR: Actor = { kind: 'system', label: 'compliance.obligation-calendar' }

function asRole(value: string, where: string): Role {
  if (!(ROLES as readonly string[]).includes(value)) {
    throw new AppError(
      'invariant_violated',
      `[obligation-owner-role-unknown] ${where} names '${value}', which is not a role in the F07 matrix. ` +
        'A notice addressed to it names nobody accountable, and an escalation nobody is accountable for ' +
        'is decoration. 0052 CHECKs this column against the same eight labels, so this is unreachable ' +
        'through the schema and is refused rather than coerced.',
      { details: { value, where } },
    )
  }
  return value as Role
}

export interface CalendarPassResult {
  readonly asOf: LocalDate
  readonly occurrencesPlanned: number
  readonly occurrencesInserted: number
  readonly noticesPlanned: number
  readonly noticesInserted: number
  readonly due: readonly { readonly id: string }[]
  /** Occurrences whose declared owner has nobody above it, so no escalation was planned. Reported. */
  readonly withoutEscalation: readonly string[]
}

/**
 * The daily pass: generate the occurrences, plan their notices, list what is due.
 *
 * Generation and planning are separate steps over separate tables and both are idempotent, so the pass is
 * safe to repeat — which is what makes "proven by repeated job runs" a property of the schema rather than
 * of the pass being careful. The due list is RETURNED rather than enqueued here, so a test can assert what
 * the sweep hands over without starting pg-boss.
 */
export async function runComplianceCalendar(
  sql: Sql,
  input: {
    readonly atIso: string
    readonly horizonMonths?: number
    /**
     * Narrows the pass to named obligations.
     *
     * For the integration suite, and for the reason the two screens take `?key=`: the suite runs
     * sequentially against ONE database and earlier files leave rows behind, so a test narrows what the
     * code under test can SEE rather than deleting rows a foreign key protects. A pass that planned
     * notices over another suite's occurrences would be writing into another unit's territory, and the
     * rows it left would be indistinguishable from that unit's own.
     */
    readonly keys?: readonly string[]
  },
): Promise<CalendarPassResult> {
  const asOf = await complianceAsOf(sql, input.atIso)
  const months = input.horizonMonths ?? OBLIGATION_HORIZON_MONTHS
  const all = await readObligationDefinitions(sql)
  const narrowed = input.keys
  const definitions = narrowed === undefined ? all : all.filter((row) => narrowed.includes(row.key))
  const therapistIds = await therapistIdsFor(sql, asOf)

  const occurrencePlan = obligationInstancePlan({
    definitions: definitions.map((row) => ({
      key: row.key,
      title: row.title,
      obligationClass: row.obligationClass as ObligationClass,
      cadence: row.cadence as ObligationCadence,
      subjectScope: row.subjectScope as ObligationSubjectScope,
      ownerRole: asRole(row.ownerRole, `obligation "${row.key}"`),
      blockingEffect: row.blockingEffect,
      evidenceRequired: row.evidenceRequired,
      isUnverified: row.isUnverified,
      ...(row.anchorOn === undefined ? {} : { anchorOn: localDate(row.anchorOn) }),
      ...(row.openQuestionId === undefined ? {} : { openQuestionId: row.openQuestionId }),
    })),
    from: asOf,
    months,
    therapistIds,
  })
  const generated = await generateObligationInstances(sql, [...occurrencePlan])

  const { reminderOffsetsDays, escalationOffsetsDays } = await ladderFor(sql)
  const subjects = await readObligationNoticeSubjects(
    sql,
    narrowed === undefined ? {} : { keys: [...narrowed] },
  )
  const noticePlan: PlannedObligationNoticeRow[] = []
  const withoutEscalation: string[] = []
  for (const subject of subjects) {
    const plan = obligationNoticePlanFor({
      instanceId: subject.instanceId,
      dueOn: localDate(subject.dueOn),
      ownerRole: asRole(subject.ownerRole, `obligation "${subject.obligationKey}"`),
      reminderOffsetsDays,
      escalationOffsetsDays,
    })
    if (plan.escalationAbsence === 'no_role_above') withoutEscalation.push(subject.obligationKey)
    for (const notice of plan.notices) {
      noticePlan.push({
        obligationInstanceId: subject.instanceId,
        step: notice.step,
        kind: notice.kind,
        toRole: notice.toRole,
        notifyOn: notice.notifyOn,
        invalidationKey: notice.invalidationKey,
      })
    }
  }
  const planned = await withUnitOfWork(sql, ACTOR, (uow) => planObligationNotices(uow, noticePlan))

  return {
    asOf,
    occurrencesPlanned: generated.planned,
    occurrencesInserted: generated.inserted,
    noticesPlanned: planned.planned,
    noticesInserted: planned.inserted,
    due: await dueObligationNotices(sql, {
      asOf,
      ...(narrowed === undefined ? {} : { keys: [...narrowed] }),
    }),
    withoutEscalation,
  }
}

/**
 * Re-plans the notices of every open occurrence under the ladders now in force.
 *
 * Superseded FIRST, then planned, and the order is load-bearing for the reason `rebuildScheduledSteps`
 * gives: `obligation_notice_one_pending_per_step` is partial on `state = 'pending'`, so a plan that ran
 * first would conflict with the row it is replacing and do nothing — silently, because the insert is
 * `on conflict do nothing`. This order is the difference between a rebuild and a no-op that reports
 * success.
 *
 * It covers occurrences generated BEFORE the setting changed, which is the half a new ladder applied at
 * generation time would miss: twelve months of calendar left on the old timing.
 */
export async function rebuildObligationNotices(
  sql: Sql,
  input: { readonly atIso: string; readonly keys?: readonly string[] },
): Promise<{
  readonly occurrences: number
  readonly superseded: number
  readonly planned: number
}> {
  const { reminderOffsetsDays, escalationOffsetsDays } = await ladderFor(sql)
  const subjects = await readObligationNoticeSubjects(
    sql,
    input.keys === undefined ? {} : { keys: [...input.keys] },
  )
  return await withUnitOfWork(sql, ACTOR, async (uow) => {
    let superseded = 0
    let planned = 0
    for (const subject of subjects) {
      superseded += await supersedePendingNotices(uow, {
        instanceId: subject.instanceId,
        atIso: input.atIso,
      })
      const plan = obligationNoticePlanFor({
        instanceId: subject.instanceId,
        dueOn: localDate(subject.dueOn),
        ownerRole: asRole(subject.ownerRole, `obligation "${subject.obligationKey}"`),
        reminderOffsetsDays,
        escalationOffsetsDays,
      })
      const written = await planObligationNotices(
        uow,
        plan.notices.map((notice) => ({
          obligationInstanceId: subject.instanceId,
          step: notice.step,
          kind: notice.kind,
          toRole: notice.toRole,
          notifyOn: notice.notifyOn,
          invalidationKey: notice.invalidationKey,
        })),
        // `rebuild`, which is what makes this pass a recovery rather than a duplicate of the daily one: a
        // ladder that was skipped for a reason since fixed — a missing contact detail, an unapproved
        // template — is planned again over the settled rows, and a step already SENT is still refused.
        'rebuild',
      )
      planned += written.inserted
    }
    return { occurrences: subjects.length, superseded, planned }
  })
}

/** What one drain did. Every outcome is a row state, which is the point. */
export type NoticeDrainOutcome =
  | { readonly kind: 'sent'; readonly messageId: string; readonly stalenessNote: string | null }
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'deferred'; readonly why: string }
  /** Already settled: another drain of the same id, or the calendar got there first. */
  | { readonly kind: 'already_settled'; readonly state: string }
  | { readonly kind: 'not_found' }

/**
 * Renders one notice, or says why it cannot.
 *
 * Returns `null` for every missing input rather than throwing, because each of them is a fact to RECORD: a
 * role with no contact detail, a template nobody has approved in that locale. A throw here would burn a
 * pg-boss retry on a condition that will not change in sixty seconds and would leave the row pending with
 * nothing written against it.
 *
 * The body names the obligation KEY and its due date and nothing else about the business. It carries no
 * licence number, no permit number and no TRN: those are Y1-trn and Y1-licence, nothing on file holds one,
 * and an SMS is read by whoever is holding the phone.
 */
async function noticeContentFor(
  sql: Sql,
  notice: ClaimedNotice,
  recipientForRole: ComplianceRecipientResolver,
): Promise<
  | {
      readonly kind: 'ready'
      readonly templateId: string
      readonly templateKey: string
      readonly body: string
      readonly variables: readonly string[]
      readonly recipient: string
      readonly values: Readonly<Record<string, string>>
    }
  | { readonly kind: 'missing'; readonly what: 'recipient' | 'content' }
> {
  const recipient = recipientForRole(asRole(notice.toRole, `notice ${notice.id}`))
  if (recipient === null || recipient.trim() === '') return { kind: 'missing', what: 'recipient' }
  const key = TEMPLATE_KEYS[notice.kind]
  // English only, and deliberately: a compliance notice goes to a member of staff in a role, and no
  // table in this build records which language that person reads. The Arabic variant is seeded and will
  // be selected the day a staff locale exists; guessing one per role would be a guess about a person.
  const template = await readCurrentTemplate(sql, { key, channel: 'sms', locale: 'en' })
  if (template === undefined) return { kind: 'missing', what: 'content' }
  return {
    kind: 'ready',
    templateId: template.templateId,
    templateKey: template.templateKey,
    body: template.body,
    variables: template.variables,
    recipient,
    values: {
      obligation: notice.obligationKey,
      date: notice.dueOn,
      role: notice.toRole,
    },
  }
}

/**
 * Drains one notice: lock it, re-read the occurrence, decide, then settle the row.
 *
 * One unit of work per notice, and the row is locked for the whole of it — including the send. A lock
 * released before the transport call would let a completion or an acknowledgement settle the notice while
 * a message was in flight, and the message would then belong to no notice. The consequence is that an
 * acknowledgement arriving mid-send WAITS, which is the right answer: an SMS cannot be un-sent.
 *
 * The `SendRequest.id` is derived from the NOTICE, so a second drain computes the same idempotency key,
 * the fake derives the same provider message id from it and `message_provider_id_unique` refuses the
 * second row — three layers under the notice's own `state = 'pending'` guard and 0060's
 * `obligation_notice_one_send_per_step`.
 */
export async function drainObligationNotice(
  runtime: ObligationNoticeRuntime,
  input: { readonly noticeId: string; readonly atIso: string },
): Promise<NoticeDrainOutcome> {
  const asOf = await complianceAsOf(runtime.sql, input.atIso)
  return await withUnitOfWork(runtime.sql, ACTOR, async (uow) => {
    const notice = await claimObligationNotice(uow.sql, input.noticeId)
    if (notice === undefined) return { kind: 'not_found' }
    if (notice.state !== 'pending') {
      // The first layer of "one message per (instance, step)". The other three are the idempotency key,
      // `message_provider_id_unique` and `obligation_notice_one_send_per_step`; this one is the cheap one,
      // and it is the one that stops a second transport call being made at all.
      return { kind: 'already_settled', state: notice.state }
    }

    const content = await noticeContentFor(uow.sql, notice, runtime.recipientForRole)
    const verdict = decideObligationNotice({
      notice: {
        instanceId: notice.instanceId,
        step: notice.step,
        kind: notice.kind,
        invalidationKey: notice.invalidationKey,
        notifyOn: localDate(notice.notifyOn),
      },
      occurrence: {
        dueOn: localDate(notice.dueOn),
        status: notice.status,
        acknowledged: notice.acknowledged,
      },
      asOf,
      contentAvailable: content.kind === 'ready',
      ...(content.kind === 'missing' ? { missing: content.what } : {}),
    })

    if (verdict.kind === 'defer') return { kind: 'deferred', why: verdict.why }
    if (verdict.kind === 'skip') {
      await recordNoticeSkipped(uow, {
        noticeId: notice.id,
        reason: verdict.reason,
        atIso: input.atIso,
      })
      return { kind: 'skipped', reason: verdict.reason }
    }
    if (content.kind !== 'ready') {
      // Unreachable: `contentAvailable` was false, so the verdict above was a skip. Thrown rather than
      // treated as a send, because a caller cannot act on "we sent something we could not render".
      throw new AppError(
        'invariant_violated',
        `notice ${notice.id} was cleared to send with no content. decideObligationNotice must refuse a ` +
          'notice whose message cannot be built.',
      )
    }

    const outcome = await deliverMessage(runtime.deliveryFor(uow.sql), {
      templateId: content.templateId,
      id: `obligation-notice-${notice.id}` as MessageId,
      template: {
        key: content.templateKey,
        channel: 'sms',
        locale: 'en',
        body: content.body,
        variables: [...content.variables],
        messageClass: 'transactional',
        // `ClassifiedTemplate` gained this in 0061 (C-AUTO-01): the send path refuses a template whose
        // words nobody has approved, so it has to be stated rather than assumed. The row this content came
        // from is read through `readCurrentTemplate`, which no longer filters on the approval state — it
        // returns the row carrying it, so the refusal names `template_not_approved` instead of collapsing
        // into "there is no template". These are the shipped compliance notices and ship approved.
        approvalState: 'approved',
      },
      values: content.values,
      recipient: content.recipient,
    })

    if (outcome.kind !== 'sent' && outcome.kind !== 'held' && outcome.kind !== 'failed') {
      // A gate refusal or a staging diversion writes no message row (B-MSG-04's stated rule), so there is
      // nothing to point the notice at. Recorded as `send_refused` rather than left pending: a notice that
      // stayed pending would be re-swept every day for ever. A distinct reason from `content_unavailable`
      // because a diversion is the ORDINARY outcome on a staging worker.
      await recordNoticeSkipped(uow, {
        noticeId: notice.id,
        reason: 'send_refused',
        atIso: input.atIso,
      })
      return { kind: 'skipped', reason: 'send_refused' }
    }

    await recordNoticeSent(uow, {
      noticeId: notice.id,
      messageId: outcome.message.id,
      stalenessNote: verdict.stalenessNote,
      atIso: input.atIso,
    })
    return {
      kind: 'sent',
      messageId: outcome.message.id,
      stalenessNote: verdict.stalenessNote,
    }
  })
}

// --- the jobs -----------------------------------------------------------------------------------

/**
 * The runtime, supplied at boot.
 *
 * A module-level binding for the reason `setScheduledStepRuntime` is: `JOB_REGISTRY` is a module constant
 * `pnpm jobs` enumerates without a database, so a handler's dependencies cannot be constructor arguments.
 */
let configured: ObligationNoticeRuntime | undefined

export function setObligationNoticeRuntime(runtime: ObligationNoticeRuntime): void {
  configured = runtime
}

function runtime(job: string): ObligationNoticeRuntime {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${job} ran before setObligationNoticeRuntime() supplied the connection, the send context and the ` +
        'recipient resolver. run.ts calls it before startWorkers().',
    )
  }
  return configured
}

/** The per-notice payload. One field, and that is the point. */
export interface SendObligationNoticeData {
  readonly noticeId: string
}

export type ObligationNoticeEnqueue = (data: SendObligationNoticeData) => Promise<string | null>

let sweepEnqueue: ObligationNoticeEnqueue | undefined

export function setObligationNoticeEnqueue(enqueue: ObligationNoticeEnqueue): void {
  sweepEnqueue = enqueue
}

/** What one pass handed over. */
export interface NoticeSweepResult {
  readonly due: number
  readonly queued: number
  /** Exactly what was handed to the queue, so a test can assert what the payload does NOT contain. */
  readonly payloads: readonly SendObligationNoticeData[]
}

/**
 * Hands each due notice to the queue. Separated from the handler so the payload can be asserted.
 *
 * The payload is built HERE and nowhere else, from one field: a queue row carrying a recipient would put a
 * staff phone number in `pgboss.job`, which is a table with a seven-day retention and no access control of
 * its own, and one carrying the body would be a message about a deadline that may have moved.
 */
export async function sweepDueNotices(
  due: readonly { readonly id: string }[],
  enqueue: ObligationNoticeEnqueue,
): Promise<NoticeSweepResult> {
  const payloads: SendObligationNoticeData[] = []
  let queued = 0
  for (const notice of due) {
    const payload: SendObligationNoticeData = { noticeId: notice.id }
    payloads.push(payload)
    const id = await enqueue(payload)
    if (id !== null) queued += 1
  }
  return { due: due.length, queued, payloads }
}

async function calendarHandler(_data: never, context: JobContext): Promise<void> {
  const deps = runtime('compliance.obligation-calendar')
  const enqueue = sweepEnqueue
  if (enqueue === undefined) {
    throw new AppError(
      'invariant_violated',
      'compliance.obligation-calendar ran before setObligationNoticeEnqueue() supplied a queue. Without ' +
        'one the pass would report a tidy zero over a work list it never handed anywhere.',
    )
  }
  const result = await runComplianceCalendar(deps.sql, { atIso: context.now() })
  const swept = await sweepDueNotices(result.due, enqueue)
  console.log(
    `compliance.obligation-calendar ${result.asOf}: ${result.occurrencesInserted} of ` +
      `${result.occurrencesPlanned} occurrence(s) written, ${result.noticesInserted} of ` +
      `${result.noticesPlanned} notice(s) planned, ${swept.due} due, ${swept.queued} queued` +
      (result.withoutEscalation.length === 0
        ? ''
        : ` — no role above the owner for ${[...new Set(result.withoutEscalation)].sort().join(', ')}`),
  )
}

export const COMPLIANCE_CALENDAR_JOB: JobDefinition<never> = {
  name: 'compliance.obligation-calendar',
  purpose:
    'Generates the next twelve months of obligation occurrences, plans the reminders and escalations for ' +
    'the open ones, and hands every notice whose date has arrived to compliance.send-obligation-notice. ' +
    'All three steps are idempotent, so a repeated run writes nothing — which is what makes a reclaimed ' +
    'pass and a manual re-run safe (M-VAT-11, docs/04 §9).',
  // 02:30 Asia/Dubai. After trading closes at 02:00, so the pass resolves a trading date for a session
  // that has ENDED — inside trading hours the calendar's as-of date is still the previous trading date,
  // and a pass that ran at 23:00 would plan the next day's notices against yesterday. Before
  // audit.ensure-partitions at 03:00 and the four nightly Google and cost passes, none of which it
  // contends with: this one reads two small tables and writes two.
  cron: '30 2 * * *',
  agent: COMPLIANCE_CALENDAR_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 120,
  retryBackoff: true,
  // One plan over twelve months plus two idempotent inserts and one indexed read. Five minutes is
  // generous; a pass still running past it is blocked on a lock rather than slow, and reclaiming it is
  // safe — every step of it writes nothing the second time.
  expireInSeconds: 300,
  handler: calendarHandler,
}

async function sendHandler(data: SendObligationNoticeData, context: JobContext): Promise<void> {
  const deps = runtime('compliance.send-obligation-notice')
  const outcome = await drainObligationNotice(deps, {
    noticeId: data.noticeId,
    atIso: context.now(),
  })
  // Logged for every outcome including the quiet ones, because "nothing happened" from a drain that found
  // no row reads exactly like a drain that sent a message.
  console.log(
    `compliance.send-obligation-notice ${context.now()}: notice ${data.noticeId} -> ${outcome.kind}` +
      (outcome.kind === 'skipped' ? ` (${outcome.reason})` : '') +
      (outcome.kind === 'sent' && outcome.stalenessNote !== null ? ' (late)' : ''),
  )
}

export const SEND_OBLIGATION_NOTICE_JOB: JobDefinition<SendObligationNoticeData> = {
  name: 'compliance.send-obligation-notice',
  purpose:
    'Sends one compliance notice, after re-reading the occurrence under the notice row lock and refusing ' +
    'any notice whose invalidation_key no longer matches the occurrence due date. The payload is a ' +
    'notice id and nothing else: a body in a queue is a message about a deadline that may have moved, ' +
    'and a recipient in a queue is a staff phone number in pgboss.job.',
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // One short transaction plus one transport call. Two minutes is generous; a drain still running past it
  // is blocked on the notice's row lock, and reclaiming it is safe — the second attempt finds the row
  // already settled and sends nothing.
  expireInSeconds: 120,
  handler: sendHandler,
}

/** The rebuild's payload: nothing. Both ladders apply to every open occurrence, not to a window. */
export type RebuildObligationNoticesData = Record<string, never>

async function rebuildHandler(
  _data: RebuildObligationNoticesData,
  context: JobContext,
): Promise<void> {
  const deps = runtime(REBUILD_JOB_NAME)
  const result = await rebuildObligationNotices(deps.sql, { atIso: context.now() })
  console.log(
    `${REBUILD_JOB_NAME} ${context.now()}: ${result.occurrences} open occurrence(s), ` +
      `${result.superseded} notice(s) superseded, ${result.planned} planned`,
  )
}

/**
 * The rebuild's definition.
 *
 * Its name is `REBUILD_OBLIGATION_NOTICES_JOB` from `@berelax/shared`, not a literal: the F09 registry
 * names this job in `rerunJobs` on both ladder settings, and a registry naming one string while the worker
 * registers another would declare a rebuild that never runs, with nothing to say so.
 */
export const REBUILD_OBLIGATION_NOTICES_JOB: JobDefinition<RebuildObligationNoticesData> = {
  name: REBUILD_JOB_NAME,
  purpose:
    'Re-plans the notices of every open obligation occurrence under the reminder and escalation ladders ' +
    'now in force. Announced by the settings change that made the old plan wrong (F09 rerunJobs), so it ' +
    'has no schedule — and it covers the twelve months already in the calendar, which is the half a new ' +
    'ladder applied at generation time would miss.',
  retryLimit: 3,
  retryDelaySeconds: 120,
  retryBackoff: true,
  // One locking read over the open occurrences plus two statements each. Ten minutes is generous; a
  // reclaimed pass is safe, because superseding and planning the same occurrence twice produces the same
  // rows.
  expireInSeconds: 600,
  handler: rebuildHandler,
}

/**
 * The shipped runtime, built from the environment.
 *
 * `recipientForRole` answers null for every role, and that is the honest shipped value rather than an
 * oversight: see this module's header. Until a staff contact detail exists on file, a due notice is
 * SKIPPED with `no_recipient_on_file` recorded on its row — visible on the calendar, countable in a
 * report, and not a renewal notice sent to a number somebody typed in to make the test pass.
 */
export function obligationNoticeRuntimeFor(sql: Sql): ObligationNoticeRuntime {
  const config = loadConfig()
  const now = (): string => new Date().toISOString()
  const sms = createSmsalaTransport({ config, now })
  const send: SendContext = {
    appEnv: config.APP_ENV,
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox: new InMemoryOutbox(),
    clock: { now: () => Date.now() as Instant },
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      // The same three fail-closed evaluators B-MSG-03's runtime wires, for the same reason: the consent and
      // suppression stores exist (C-CRM-03, C-CRM-04) and both evaluators are built over logs PREFETCHED for
      // a recipient list, which this runtime does not have; the frequency store is C-AUTO-03's and is still
      // absent. A compliance notice is transactional, so the gate returns before any of the three is read.
      evaluators: {
        hasConsent: () => {
          throw new Error('No consent store yet (C-CRM-03). Promotional sends fail closed.')
        },
        isSuppressed: () => {
          throw new Error(
            'This runtime prefetches no suppression logs (C-CRM-04 stores them; the evaluator needs the ' +
              'recipient list). Promotional sends fail closed.',
          )
        },
        frequencyCapReached: () => {
          throw new Error('No frequency store yet (C-AUTO-03). Promotional sends fail closed.')
        },
      },
    },
  }
  return {
    sql,
    deliveryFor: (connection) => ({
      store: createPostgresMessageStore(connection),
      send,
      // A retry inside the drain would hold the notice's row lock for the length of the declared backoff.
      // The queue is the thing that waits: a failed attempt leaves the row pending and the next pass hands
      // it back, which is the same wait without a held lock.
      waitUntil: async () => {},
    }),
    recipientForRole: () => null,
  }
}

/** A connection for the three jobs that need one outside a request. */
export function obligationNoticeConnection(): Sql {
  return createConnection({ url: loadConfig().DATABASE_URL, max: 4 })
}
