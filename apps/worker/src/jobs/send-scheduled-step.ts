/**
 * B-MSG-03 — the due sweep, the per-step send, and the rebuild.
 *
 * ## Why three jobs and not one delayed job per reminder
 *
 * The obvious design is `boss.send('reminder', payload, { startAfter: 24 hours })` at confirmation time.
 * It is the bug the manifest calls the most damaging in the domain. The job carries a body written about a
 * period the appointment may no longer hold, pg-boss has no notion of a job that should no longer run, and
 * on the evening it fires the customer is told to come to an appointment that was moved a week ago. She
 * arrives on the wrong day, the room has been sold, and nothing recorded a fault.
 *
 * So the schedule is a `scheduled_step` ROW, and:
 *
 *   * `messaging.scheduled-step-sweep` (cron) finds the pending rows whose send instant has passed and
 *     hands each one to the queue below. Nothing is queued in advance, which is what makes a **six-hour
 *     worker outage** self-healing rather than a lost batch: the rows did not move, so the first sweep
 *     after the restart finds all of them.
 *   * `messaging.send-scheduled-step` takes **a step id and nothing else** — no body, no phone number, no
 *     template id. Everything is re-read under the step's row lock, and the invalidation key is compared
 *     against the key the appointment's CURRENT period derives. A payload carrying the body would be the
 *     delayed job again in a different costume; a payload carrying the recipient would put a customer's
 *     phone number in `pgboss.job`, which is a table with a seven-day retention and no access control of
 *     its own.
 *   * `messaging.rebuild-scheduled-steps` re-plans the forward book when the reminder-timing setting
 *     changes, which is the F09 registry's `rerunJobs` field doing the job its comment was written for.
 *
 * ## Every drained step reaches a terminal state, or stays honestly pending
 *
 * The acceptance criterion is that a step whose send time passed during an outage is "either sent with a
 * recorded staleness note or skipped with a recorded reason code", and that no step ends in a silent
 * unrecorded state. Three things hold that:
 *
 *   1. `decideScheduledStep` in `@berelax/core` returns three verdicts and two of them write.
 *   2. 0051's `scheduled_step_terminal_is_settled` makes a row that left `pending` without a `settled_at`
 *      unstorable, so the silent state is refused by the database rather than looked for by a test.
 *   3. The third verdict, `defer`, leaves the row `pending` — which is the record that it is not due yet,
 *      and is only reachable for a step whose send instant has NOT passed.
 *
 * ## Why the send goes through `deliverMessage`
 *
 * Because B-MSG-02 built one choke point and B-MSG-04 built the row, and a second send path here would
 * bypass the sender-ID class routing, the promotional gates, the staging guard and the message row at
 * once. What this file adds is the step's own idempotency: the `SendRequest.id` is derived from the STEP,
 * so a second drain of the same step computes the same idempotency key, the fake derives the same provider
 * message id from it, and `message_provider_id_unique` refuses the second row — three layers under the
 * step's own `state = 'pending'` guard.
 */
import { loadConfig } from '@berelax/config'
import {
  BOOKING_TOKEN_PURPOSES,
  bookingTokenExpiry,
  decideScheduledStep,
  type Instant,
  reminderOffsetsFrom,
  reminderPlanFor,
  type ScheduledStepSkipReason,
} from '@berelax/core'
import {
  type Actor,
  type ClaimedStep,
  claimScheduledStep,
  createConnection,
  createPostgresMessageStore,
  dueScheduledSteps,
  mintBookingManageGrant,
  type PlannedStep,
  readCurrentTemplate,
  readReminderOffsets,
  rebuildScheduledSteps,
  recordStepSent,
  recordStepSkipped,
  type ScheduledStepPlanner,
  type Sql,
  type UnitOfWork,
  withUnitOfWork,
} from '@berelax/db'
import {
  type ClassifiedTemplate,
  classifyTemplateRow,
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
  manageBookingLink,
  REBUILD_SCHEDULED_STEPS_JOB as REBUILD_JOB_NAME,
  SITE_ORIGIN_ENV,
  siteOriginFrom,
} from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The template a step type sends.
 *
 * A function rather than a map because the step type carries its offset (`reminder_24h`), so every
 * reminder whatever its timing resolves to the one shipped `booking.reminder` template. `null` for a
 * label nothing sends, which is recorded as `content_unavailable` rather than guessed at.
 */
const templateKeyFor = (stepType: string): string | null =>
  stepType.startsWith('reminder_') ? 'booking.reminder' : null

/**
 * What the reminder body needs that no table holds: the magic link.
 *
 * `booking.reminder` declares `{{time}}` and `{{link}}`, and B-MSG-01's renderer refuses a blank for a
 * declared variable — deliberately, because "Reminder: your booking tomorrow at 19:00. Details or changes:
 * " sends successfully and is reported as delivered. The link is a per-booking expiring magic link
 * (docs/06 D2).
 *
 * **B-UI-05 wired it.** The seam stayed and its shipped value was `() => null` for as long as the page did
 * not exist: B-UI-02 and B-MSG-03 both refused to mint a link to a 404, because "a link to a 404 in a
 * reminder is a customer who thinks the salon has lost their booking". `scheduledStepRuntimeFor` now mints
 * one, and a step whose link cannot be built is still SKIPPED with `content_unavailable` — the seam is what
 * makes that state reachable in a test, and it is what keeps a mint failure from sending a blank.
 *
 * ## Why it takes the unit of work, and why it is async
 *
 * Minting a link WRITES: `booking_manage_grant` holds the sha256 of 32 CSPRNG bytes and no column holds the
 * token, so the only way to have a token is to insert its digest. Taking the drain's own `UnitOfWork` rather
 * than a pool connection is what makes the grant durable with the send or not at all — a link minted for a
 * reminder that rolled back is a live credential for a message nobody received, and a link that committed
 * while the message did not is worse: the customer never learns it exists and it stays valid until the
 * appointment ends.
 *
 * `endsAtMs` is here because the expiry is a property of the APPOINTMENT: `bookingTokenExpiry` is the
 * treatment's end plus 24 hours (B-UI-05). Passing the period rather than letting the builder re-read it
 * keeps the value the one the drain already read under the step's row lock.
 */
export type MagicLinkBuilder = (input: {
  readonly uow: UnitOfWork
  readonly bookingId: string
  readonly appointmentId: string
  /** The treatment's end, epoch milliseconds, as the step row carries it. */
  readonly endsAtMs: number
  /** The instant the drain is running at, so the grant's `issued_at` is the drain's clock and not `now()`. */
  readonly atIso: string
}) => Promise<string | null>

export interface ScheduledStepRuntime {
  readonly sql: Sql
  /**
   * `deliverMessage`'s dependencies, built over a GIVEN connection rather than captured once.
   *
   * A factory and not a value, and the reason is the transaction. The drain holds the step's row lock for
   * the length of the send, and the message row has to commit with the step's settlement or not at all —
   * a store bound to the pool would write the message in its own transaction, so a drain that rolled back
   * afterwards would leave a `message` row for a step still marked pending, which the next sweep would
   * send again. That is the same "durable together" rule the outbox pattern is built on (ADR 0008).
   */
  readonly deliveryFor: (sql: Sql) => DeliveryDeps
  readonly magicLink: MagicLinkBuilder
  /** The plan, bound to the reminder offsets in force. Read per pass, never captured at boot. */
  readonly planner: (sql: Sql) => Promise<ScheduledStepPlanner>
}

/** What one drain did. Every outcome is a row state, which is the point. */
export type DrainOutcome =
  | { readonly kind: 'sent'; readonly messageId: string; readonly stalenessNote: string | null }
  | { readonly kind: 'skipped'; readonly reason: ScheduledStepSkipReason }
  | { readonly kind: 'deferred'; readonly why: string }
  /** The step was already settled: another drain of the same id, or the lifecycle got there first. */
  | { readonly kind: 'already_settled'; readonly state: string }
  | { readonly kind: 'not_found' }

const ACTOR: Actor = { kind: 'system', label: 'messaging.send-scheduled-step' }

/**
 * Renders the reminder for one step, or says why it cannot.
 *
 * Returns `null` for every missing input rather than throwing, because each of them is a fact to RECORD:
 * a booking with no customer row, a template nobody has approved in that locale, a link this build cannot
 * mint. A throw here would burn a pg-boss retry on a condition that will not change in sixty seconds and
 * would leave the row pending with nothing written against it.
 *
 * A skip is terminal, and the thing that makes that safe rather than destructive is the rebuild:
 * `scheduled_step_one_pending_step_per_type` is partial on `state = 'pending'`, so a SKIPPED step leaves
 * the (appointment, step type) pair free and `buildScheduledSteps` inserts a fresh pending row over it.
 * A whole forward book skipped because somebody had not run `pnpm seed` is therefore recovered by
 * `messaging.rebuild-scheduled-steps`, which is the same pass a timing change runs — not by editing rows.
 */
async function reminderContentFor(
  uow: UnitOfWork,
  step: ClaimedStep,
  magicLink: MagicLinkBuilder,
  atIso: string,
): Promise<{
  readonly templateId: string
  readonly recipient: string
  readonly values: Readonly<Record<string, string>>
  /**
   * The template as `classifyTemplateRow` narrowed it: the words, the channel, the locale, the approval
   * state and the CLASS, all read off the row.
   *
   * It used to be four loose fields plus the literal `messageClass: 'transactional'` at the call site
   * below. That was true of `booking.reminder` and it was a hole all the same — `reclassify_template` can
   * make any template promotional, and a restated class sends promotional content from the transactional
   * identity with every gate skipped, because `evaluateGate` returns `allow` on its first line for a
   * message that says it is transactional. C-AUTO-01.
   */
  readonly template: ClassifiedTemplate
} | null> {
  if (step.recipient === null) return null
  const key = templateKeyFor(step.stepType)
  if (key === null) return null
  const locale = step.locale === 'ar' ? 'ar' : 'en'
  const template = await readCurrentTemplate(uow.sql, { key, channel: 'sms', locale })
  if (template === undefined) return null
  // The template is read BEFORE the link is minted, and the order is load-bearing: a step with no approved
  // template is skipped with `content_unavailable`, and minting first would leave a live credential behind
  // for a message that was never going to be sent.
  const link = await magicLink({
    uow,
    bookingId: step.bookingId,
    appointmentId: step.appointmentId,
    endsAtMs: step.endsAtMs,
    atIso,
  })
  if (link === null || link.trim() === '') return null

  // The treatment start as wall-clock time in the business zone. `Intl` rather than string arithmetic,
  // because 19:00 Dubai is 15:00 UTC and a reminder that told the customer the UTC time would be four
  // hours wrong every single day.
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dubai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(step.startsAtMs))

  // Narrowed by `@berelax/messaging`, never asserted here. `readCurrentTemplate` returns the vocabulary
  // columns as `string` because `packages/db` has no reason to hold those unions, and a label this build
  // cannot read is a label whose permissions it does not know — so the step is skipped with
  // `content_unavailable` rather than sent under a guess.
  const classified = classifyTemplateRow({ ...template, locale })
  if (classified.kind !== 'template') return null

  return {
    templateId: template.templateId,
    recipient: step.recipient,
    values: { time, link },
    template: classified.template,
  }
}

/**
 * Drains one step: lock it, re-read the appointment, decide, then settle the row.
 *
 * One unit of work per step, and the row is locked for the whole of it — including the send. That is
 * deliberate: a lock released before the transport call would let the lifecycle settle the step while a
 * message was in flight, and the message would then belong to no step. The consequence is that a
 * cancellation arriving mid-send WAITS for the send to finish, which is the right answer — an SMS cannot
 * be un-sent — and it is bounded by the provider's own timeout and by `expireInSeconds` on the queue below.
 *
 * It writes no `audit_event` row and no outbox event, and both absences are decisions. `audit_event`
 * answers "who did that" about a human action (0005); a reminder has no actor but a schedule, and the
 * record of it is the `scheduled_step` row plus the `message` row it points at — two rows that say more
 * than an audit line would. An outbox event would be a domain fact nothing consumes: the message lifecycle
 * B-MSG-04 owns already carries every state a reader wants, and an event emitted for nobody is a row that
 * makes a queue look busier than the system is.
 */
export async function drainScheduledStep(
  runtime: ScheduledStepRuntime,
  input: { readonly stepId: string; readonly atIso: string },
): Promise<DrainOutcome> {
  return await withUnitOfWork(runtime.sql, ACTOR, async (uow) => {
    const step = await claimScheduledStep(uow.sql, input.stepId)
    if (step === undefined) return { kind: 'not_found' }
    if (step.state !== 'pending') {
      // The first layer of "draining the same step twice produces exactly one message row". The other
      // two are the idempotency key and `message_provider_id_unique`; this one is the cheap one, and it
      // is the one that stops a second transport call being made at all.
      return { kind: 'already_settled', state: step.state }
    }

    const atMs = Date.parse(input.atIso)
    const content = await reminderContentFor(uow, step, runtime.magicLink, input.atIso)
    const verdict = decideScheduledStep({
      step: {
        appointmentId: step.appointmentId,
        stepType: step.stepType,
        invalidationKey: step.invalidationKey,
        sendAtMs: Date.parse(step.sendAtIso),
      },
      appointment: {
        period: { startsAtMs: step.startsAtMs, endsAtMs: step.endsAtMs },
        holdsResources: step.holdsResources,
      },
      atMs,
      contentAvailable: content !== null,
    })

    if (verdict.kind === 'defer') return { kind: 'deferred', why: verdict.why }
    if (verdict.kind === 'skip') {
      await recordStepSkipped(uow, {
        stepId: step.id,
        reason: verdict.reason,
        atIso: input.atIso,
      })
      return { kind: 'skipped', reason: verdict.reason }
    }
    if (content === null) {
      // Unreachable: `contentAvailable` was false, so the verdict above was a skip. Thrown rather than
      // treated as a send, because a caller cannot act on "we sent something we could not render".
      throw new AppError(
        'invariant_violated',
        `step ${step.id} was cleared to send with no content. decideScheduledStep must refuse a step ` +
          'whose message cannot be built.',
      )
    }

    const outcome = await deliverMessage(runtime.deliveryFor(uow.sql), {
      templateId: content.templateId,
      // Derived from the STEP, so a second drain computes the same idempotency key — which is what makes
      // the fake reissue the same provider message id and `message_provider_id_unique` refuse the second
      // row. A random id here would make a double drain two messages.
      id: `step-${step.id}` as MessageId,
      // Whole, from the row. Nothing here restates the class, the channel or the approval state — and
      // the reader no longer filters unapproved variants out either, so the choke point refuses one with
      // `template_not_approved` and the step records `send_refused` instead of the misleading
      // `content_unavailable` a missing row produces.
      template: content.template,
      values: content.values,
      recipient: content.recipient,
    })

    if (outcome.kind !== 'sent' && outcome.kind !== 'held' && outcome.kind !== 'failed') {
      // A gate refusal or a staging diversion writes no message row (B-MSG-04's stated rule), so there is
      // nothing to point the step at. Recorded as `send_refused` rather than left pending: the reason the
      // message did not leave is in the SendResult, and a step that stayed pending would be re-swept every
      // fifteen minutes for ever. A distinct reason from `content_unavailable` because a diversion is the
      // ORDINARY outcome on a staging worker, and a report that called it a rendering failure would send
      // somebody to look at the template.
      await recordStepSkipped(uow, {
        stepId: step.id,
        reason: 'send_refused',
        atIso: input.atIso,
      })
      return { kind: 'skipped', reason: 'send_refused' }
    }

    // `sent` means THIS STEP PRODUCED A MESSAGE, which is true for a `failed` attempt and for one `held`
    // for the promotional window too: a vendor was asked, or a row exists carrying the instant it may
    // leave at. Whether it ARRIVED is `message.status`, and B-MSG-04 owns that lifecycle — giving the step
    // a `failed` state of its own would be two sources for one fact, and the one that fell behind would be
    // this one.
    await recordStepSent(uow, {
      stepId: step.id,
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

/** The plan, bound to whatever the reminder-timing setting says right now. */
export async function plannerFrom(sql: Sql): Promise<ScheduledStepPlanner> {
  const offsetsHours = reminderOffsetsFrom(await readReminderOffsets(sql))
  return (input): readonly PlannedStep[] =>
    reminderPlanFor({
      appointmentId: input.appointmentId,
      period: input.period,
      offsetsHours,
    })
}

// --- the jobs -----------------------------------------------------------------------------------

/**
 * The runtime, supplied at boot.
 *
 * A module-level binding for the reason `setReceiptSources` and `setMediaStorage` are: `JOB_REGISTRY` is a
 * module constant `pnpm jobs` enumerates without a database, so a handler's dependencies cannot be
 * constructor arguments.
 */
let configured: ScheduledStepRuntime | undefined

export function setScheduledStepRuntime(runtime: ScheduledStepRuntime): void {
  configured = runtime
}

function runtime(job: string): ScheduledStepRuntime {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${job} ran before setScheduledStepRuntime() supplied the connection, the send context and the ` +
        'magic-link builder. run.ts calls it before startWorkers().',
    )
  }
  return configured
}

/** The per-step payload. One field, and that is the acceptance criterion. */
export interface SendScheduledStepData {
  readonly stepId: string
}

async function sendHandler(data: SendScheduledStepData, context: JobContext): Promise<void> {
  const deps = runtime('messaging.send-scheduled-step')
  const outcome = await drainScheduledStep(deps, { stepId: data.stepId, atIso: context.now() })
  // Logged for every outcome including the quiet ones, because "nothing happened" from a drain that
  // found no row reads exactly like a drain that sent a message.
  console.log(
    `messaging.send-scheduled-step ${context.now()}: step ${data.stepId} -> ${outcome.kind}` +
      (outcome.kind === 'skipped' ? ` (${outcome.reason})` : '') +
      (outcome.kind === 'sent' && outcome.stalenessNote !== null ? ' (late)' : ''),
  )
}

export const SEND_SCHEDULED_STEP_JOB: JobDefinition<SendScheduledStepData> = {
  name: 'messaging.send-scheduled-step',
  purpose:
    'Sends one scheduled step, after re-reading the appointment under the step row lock and refusing ' +
    'any step whose invalidation_key no longer matches the appointment period. The payload is a step ' +
    'id and nothing else: a body in a queue is a message about a world that may have changed.',
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // One short transaction plus one transport call. Two minutes is generous; a drain still running past
  // it is blocked on the step's row lock, and reclaiming it is safe — the second attempt finds the row
  // already settled and sends nothing.
  expireInSeconds: 120,
  handler: sendHandler,
}

/**
 * How the sweep hands a step to the queue.
 *
 * Injected rather than built here, because building a `PgBoss` inside a handler is how a job ends up with
 * a second connection pool, and because a test has to be able to watch what the sweep queued without
 * starting pg-boss. Returns the job id, or `null` when `singletonKey` discarded it.
 */
export type ScheduledStepEnqueue = (data: SendScheduledStepData) => Promise<string | null>

let sweepEnqueue: ScheduledStepEnqueue | undefined

export function setScheduledStepEnqueue(enqueue: ScheduledStepEnqueue): void {
  sweepEnqueue = enqueue
}

/** What one sweep pass handed over. */
export interface SweepResult {
  readonly due: number
  readonly queued: number
  /** Exactly what was handed to the queue, so a test can assert what the payload does NOT contain. */
  readonly payloads: readonly SendScheduledStepData[]
}

/**
 * Hands each due step to the queue. Separated from the handler so the payload can be asserted.
 *
 * The acceptance criterion is that "no pg-boss job payload contains message body, phone number or
 * template id — the queue only carries a step id", and this is where that is decided. It takes the work
 * list rather than reading it, so the claim is checkable in the unit suite as well as against a real
 * `pgboss.job` row: a payload is built HERE and nowhere else, from one field.
 */
export async function sweepDueSteps(
  due: readonly { readonly id: string }[],
  enqueue: ScheduledStepEnqueue,
): Promise<SweepResult> {
  const payloads: SendScheduledStepData[] = []
  let queued = 0
  for (const step of due) {
    const payload: SendScheduledStepData = { stepId: step.id }
    payloads.push(payload)
    const id = await enqueue(payload)
    if (id !== null) queued += 1
  }
  return { due: due.length, queued, payloads }
}

/**
 * The sweep's handler.
 *
 * It runs every fifteen minutes, matching `reminder_scheduler`'s declared interval in 0021 — which is what
 * makes the watchdog's "no success within twice its interval" alert mean something for this job. Each due
 * step is enqueued with `singletonKey` set to the step id (in `run.ts`, which owns the queue), so a sweep
 * overlapping the previous one does not queue the same step twice; the step's own `state = 'pending'` guard
 * is what makes it harmless when it does anyway.
 */
async function sweepHandler(_data: never, context: JobContext): Promise<void> {
  const deps = runtime('messaging.scheduled-step-sweep')
  const enqueue = sweepEnqueue
  if (enqueue === undefined) {
    throw new AppError(
      'invariant_violated',
      'messaging.scheduled-step-sweep ran before setScheduledStepEnqueue() supplied a queue. Without ' +
        'one the sweep would report a tidy zero over a work list it never handed anywhere.',
    )
  }
  const due = await dueScheduledSteps(deps.sql, { atIso: context.now() })
  const result = await sweepDueSteps(due, enqueue)
  console.log(
    `messaging.scheduled-step-sweep ${context.now()}: ${result.due} due step(s), ` +
      `${result.queued} queued`,
  )
}

export const SCHEDULED_STEP_SWEEP_JOB: JobDefinition<never> = {
  name: 'messaging.scheduled-step-sweep',
  purpose:
    'Finds every pending scheduled_step whose send instant has passed and hands each one to ' +
    'messaging.send-scheduled-step. Nothing is queued in advance, which is what makes a worker outage ' +
    'self-healing: the rows did not move, so the first sweep after a restart finds all of them.',
  // Every fifteen minutes, which is `reminder_scheduler`'s declared interval (0021).
  cron: '*/15 * * * *',
  agent: 'reminder_scheduler',
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // One indexed read plus one enqueue per due step. Five minutes is generous; a pass still running past
  // it is blocked rather than slow, and the next sweep finds whatever it did not reach.
  expireInSeconds: 300,
  handler: sweepHandler,
}

/** The rebuild's payload: the horizon, so a caller can rebuild part of the book. */
export interface RebuildScheduledStepsData {
  readonly fromIso?: string
  readonly toIso?: string
}

async function rebuildHandler(data: RebuildScheduledStepsData, context: JobContext): Promise<void> {
  const deps = runtime(REBUILD_JOB_NAME)
  const planner = await deps.planner(deps.sql)
  const result = await withUnitOfWork(deps.sql, ACTOR, (uow) =>
    rebuildScheduledSteps(
      uow,
      {
        fromIso: data.fromIso ?? context.now(),
        ...(data.toIso === undefined ? {} : { toIso: data.toIso }),
      },
      { plan: planner },
    ),
  )
  console.log(
    `${REBUILD_JOB_NAME} ${context.now()}: ${result.appointments} forward ` +
      `appointment(s), ${result.superseded} step(s) superseded, ${result.built} built`,
  )
}

/**
 * The rebuild's definition.
 *
 * Its name is `REBUILD_SCHEDULED_STEPS_JOB` from `@berelax/shared`, not a literal: the F09 registry names
 * this job in `rerunJobs` on `booking.reminder_offsets_hours`, and a registry naming one string while the
 * worker registers another would declare a rebuild that never runs, with nothing to say so. One constant,
 * two readers, and `scheduled-step.test.ts` asserts the registry's `rerunJobs` resolves to a registered
 * queue.
 */
export const REBUILD_SCHEDULED_STEPS_JOB: JobDefinition<RebuildScheduledStepsData> = {
  name: REBUILD_JOB_NAME,
  purpose:
    'Re-plans the pending steps of every forward booking under the reminder set now in force. ' +
    'Announced by the settings change that made the old plan wrong (F09 rerunJobs), so it has no ' +
    'schedule — and it covers bookings taken BEFORE the change, which is the half a new default applied ' +
    'at confirmation time would miss.',
  retryLimit: 3,
  retryDelaySeconds: 120,
  retryBackoff: true,
  // One locking read over the forward book plus two statements per appointment. Ten minutes is generous
  // for a salon this size; a pass still running past it is blocked rather than slow, and a reclaimed pass
  // is safe — superseding and rebuilding the same appointment twice produces the same rows.
  expireInSeconds: 600,
  handler: rebuildHandler,
}

/**
 * The magic link, as the shipped builder mints it (B-UI-05).
 *
 * Inside the drain's own transaction, so the grant and the message are durable together — see
 * {@link MagicLinkBuilder} for what each of the two half-failures would cost.
 *
 * The expiry is `bookingTokenExpiry(endsAtMs)` from `@berelax/core` and is NOT computed here: it is the
 * appointment's end plus 24 hours, and a second copy of that rule in the worker would be the copy nobody
 * tested under a frozen clock. `mintBookingManageGrant` refuses an expiry at or before the issue by name,
 * which is what an appointment that has already finished produces — so a step somehow drained after its
 * treatment ended is SKIPPED with `content_unavailable` rather than sent with a dead link.
 *
 * The origin is `SITE_ORIGIN` through `siteOriginFrom`, the same rule `apps/web/src/routes/alternates.ts`
 * reads: `packages/shared/src/site-origin.ts` records why one rule in the leaf rather than two readers with
 * two fallbacks. A malformed `SITE_ORIGIN` therefore THROWS here rather than sending a broken link, and the
 * throw is a pg-boss retry on a condition a deploy fixes — which is the right direction for a value that
 * would otherwise reach a customer.
 */
export const shippedMagicLink: MagicLinkBuilder = async (input) => {
  const purpose = BOOKING_TOKEN_PURPOSES[0]
  if (purpose === undefined) return null
  const expiresAt = bookingTokenExpiry(input.endsAtMs)
  // A grant that would be born dead is not minted at all. The repository refuses it by name and a refusal
  // would abort the drain's transaction, turning "this reminder is too late to be useful" into "the
  // reminder job is broken".
  if (expiresAt <= Date.parse(input.atIso)) return null
  const grant = await mintBookingManageGrant(input.uow, {
    bookingId: input.bookingId,
    purpose,
    issuedAtIso: input.atIso,
    expiresAtIso: new Date(expiresAt).toISOString(),
  })
  return manageBookingLink(siteOriginFrom(process.env[SITE_ORIGIN_ENV]), grant.token)
}

/**
 * The shipped runtime, built from the environment.
 *
 * `magicLink` is {@link shippedMagicLink} since B-UI-05. It answered `null` for as long as
 * `/booking/[token]` did not exist, and a due reminder was SKIPPED with `content_unavailable` recorded on
 * its row — which is still what happens when a link cannot be minted, so the honest state did not go away
 * when the page landed.
 */
export function scheduledStepRuntimeFor(sql: Sql): ScheduledStepRuntime {
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
      // The same three fail-closed evaluators B-LIFE-02's route wires, for the same reason: the consent and
      // suppression stores exist (C-CRM-03, C-CRM-04) and both evaluators are built over logs PREFETCHED for
      // a recipient list, which this runtime does not have; the frequency store is C-AUTO-03's and is still
      // absent. A reminder is transactional, so the gate returns before any of the three is read.
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
      // A retry inside the drain would hold the step's row lock for the length of the declared backoff.
      // The queue is the thing that waits: a failed attempt leaves the row pending and the next sweep
      // hands it back, which is the same wait without a held lock.
      waitUntil: async () => {},
    }),
    magicLink: shippedMagicLink,
    planner: plannerFrom,
  }
}

/** A connection for the two jobs that need one outside a request. */
export function scheduledStepConnection(): Sql {
  return createConnection({ url: loadConfig().DATABASE_URL, max: 4 })
}
