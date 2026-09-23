import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  decideScheduledStep,
  invalidationKeyFor,
  reminderPlanFor,
  type ScheduledStepPeriod,
  type ScheduledStepSkipReason,
} from './invalidation-key.ts'

/**
 * B-MSG-03 — 2,000 randomised sequences of reschedule and cancel operations, and one invariant:
 *
 *   **zero messages are sent for any step whose `invalidation_key` does not match the key the
 *   appointment's current period derives.**
 *
 * The manifest calls the bug this removes "the most damaging bug in the domain", which is why it is tested
 * as an invariant over generated histories rather than as a handful of cases. A hand-written case proves
 * the shape somebody thought of; the interesting failures are the shapes nobody did — reschedule, cancel,
 * reschedule back to the original period, two reschedules inside one reminder window, a confirmation after
 * a cancellation.
 *
 * ## The oracle knows what went IN, so it never re-derives a key
 *
 * This is the design decision that makes the run worth anything. The model records, for every step it
 * creates, the period it was created FOR — as two plain numbers — and the oracle's question is
 * `builtFor === current`, a comparison of the model's own bookkeeping. It never calls
 * {@link invalidationKeyFor}. An oracle that derived the key would be a second copy of the function under
 * test and would agree with it however wrong both were, which is the failure mode ADR 0002 describes one
 * layer up.
 *
 * ## The controls, because a property suite that cannot fail asserts nothing (brief rule 3)
 *
 * Four, and each is a different way this file could be green while proving nothing:
 *
 *   1. **A deliberately stale key IS detected.** A step whose stored key is the key of a period one minute
 *      away must be refused, with `invalidation_key_stale` by name. Without this, a decider that refused
 *      everything would satisfy the invariant perfectly.
 *   2. **A matching key IS sent.** The run must produce sends. Without this, the same do-nothing decider
 *      passes again from the other direction — and so does a generator that never makes a step due.
 *   3. **Two mutant deciders are caught by the same oracle.** One drops the key check (the bug itself);
 *      one compares only the appointment id, which is what a "key" that forgot the period looks like.
 *      Both must produce violations over the same generated histories.
 *   4. **Every sequence shape is generated.** The run asserts it produced reschedules, cancels, reschedules
 *      BACK to a period already used, late sends, deferred steps, and — the one that makes the rest mean
 *      anything — histories in which the period moved and the steps were left behind. A generator that
 *      only ever applied correct operations would satisfy the invariant with nothing in it, because a
 *      correct lifecycle never leaves a stale pending step. See the `drift` operation.
 */
const SEQUENCES = 2_000
const SEED = 20260921

/** The offsets every history plans over. Two, so a sequence can invalidate one step and not the other. */
const OFFSETS_HOURS = [24, 2] as const
const HOUR_MS = 3_600_000

const APPOINTMENT = '7a5b39c1-0000-4000-8000-0000000cafe1'

/** One `scheduled_step` row, as the model holds it. */
interface ModelStep {
  readonly stepType: string
  readonly invalidationKey: string
  readonly sendAtMs: number
  /**
   * The period this step was created for, remembered as data.
   *
   * This is the oracle's whole knowledge, and it is knowledge about the INPUT: the model wrote the step
   * while the appointment held this period. Nothing here reads the key to find it out.
   */
  readonly builtFor: ScheduledStepPeriod
  state: 'pending' | 'superseded' | 'cancelled'
}

interface Model {
  period: ScheduledStepPeriod
  /** `appointment.holds_resources`: false once cancelled. */
  live: boolean
  readonly steps: ModelStep[]
}

type Operation =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'reschedule'; readonly shiftHours: number }
  | { readonly kind: 'cancel' }
  /**
   * The defect, generated deliberately: the period moves and the steps are left where they were.
   *
   * Without this operation the property is worth nothing, and the reason is worth stating. A correct
   * lifecycle never leaves a stale PENDING step — `reschedule` supersedes them and inserts new ones — so a
   * model that only ever applied correct operations would generate 2,000 histories in which the key check
   * had nothing to refuse, and the "no key check at all" mutant below would pass.
   *
   * So the histories include the failure the key exists for: a writer that moved the appointment and knew
   * nothing about its reminders. Those writers are real — a direct `update appointment set period`, a
   * future lifecycle path whose author did not know this table existed, a sweep — and 0051's deferred
   * trigger catches only the half of it SQL can see (a step now due at or after the start), because the
   * key is derived in this package and the database cannot derive it. The decider is what catches all of
   * it, and this operation is what proves it does.
   */
  | { readonly kind: 'drift'; readonly shiftHours: number }

/** The treatment always lasts 45 minutes; only where it sits moves. */
const periodAt = (startsAtMs: number): ScheduledStepPeriod => ({
  startsAtMs,
  endsAtMs: startsAtMs + 45 * 60_000,
})

const BASE_START = Date.parse('2099-12-04T15:00:00.000Z')

const samePeriod = (a: ScheduledStepPeriod, b: ScheduledStepPeriod): boolean =>
  a.startsAtMs === b.startsAtMs && a.endsAtMs === b.endsAtMs

/**
 * Applies one operation, exactly as the repository does.
 *
 * `confirm` builds the plan for every step type with no pending row — 0051's partial unique index means
 * there can be at most one, so a repeat confirmation adds nothing. `reschedule` supersedes every pending
 * step, moves the period and plans again, which is the only shape that exists: nothing edits a step's key
 * or its send instant in place. `cancel` settles every pending step and ends the appointment.
 */
function apply(model: Model, operation: Operation): void {
  if (operation.kind === 'cancel') {
    for (const step of model.steps) if (step.state === 'pending') step.state = 'cancelled'
    model.live = false
    return
  }
  if (!model.live) return
  if (operation.kind === 'drift') {
    // The period moves and nothing is superseded. Deliberately, and nothing is planned either: this
    // models a writer that does not know `scheduled_step` exists.
    model.period = periodAt(model.period.startsAtMs + operation.shiftHours * HOUR_MS)
    return
  }
  if (operation.kind === 'reschedule') {
    for (const step of model.steps) if (step.state === 'pending') step.state = 'superseded'
    model.period = periodAt(model.period.startsAtMs + operation.shiftHours * HOUR_MS)
  }
  const pending = new Set(
    model.steps.filter((step) => step.state === 'pending').map((step) => step.stepType),
  )
  for (const planned of reminderPlanFor({
    appointmentId: APPOINTMENT,
    period: model.period,
    offsetsHours: [...OFFSETS_HOURS],
  })) {
    if (pending.has(planned.stepType)) continue
    model.steps.push({
      stepType: planned.stepType,
      invalidationKey: planned.invalidationKey,
      sendAtMs: planned.sendAtMs,
      builtFor: model.period,
      state: 'pending',
    })
  }
}

/** A decider, so the mutants can be run through the same harness as the real one. */
type Decider = typeof decideScheduledStep

/** What one drain of one step did, in the vocabulary the oracle checks. */
type Outcome =
  | { readonly kind: 'sent'; readonly stale: boolean }
  | { readonly kind: 'skipped'; readonly reason: ScheduledStepSkipReason }
  | { readonly kind: 'deferred' }
  | { readonly kind: 'not_pending' }

/**
 * One drain, plus the oracle's own knowledge about it.
 *
 * An intersection rather than `interface extends`, because `Outcome` is a union and a union cannot be
 * extended — and the union is the point: narrowing on `kind` is what lets the check below read the outcome
 * without a cast.
 */
type DrainRecord = Outcome & {
  /** Whether the step's own recorded period is the appointment's current one. The oracle's knowledge. */
  readonly matchesByModel: boolean
}

/**
 * Drains every step of a finished history at one instant, through the decider under test.
 *
 * The instant is generated rather than fixed, so a run covers "before either step is due", "between the
 * two", "after both" and "after the treatment has started".
 */
function drain(model: Model, atMs: number, decide: Decider): readonly DrainRecord[] {
  return model.steps.map((step) => {
    const matchesByModel = samePeriod(step.builtFor, model.period)
    if (step.state !== 'pending') return { kind: 'not_pending', matchesByModel }
    const verdict = decide({
      step: {
        appointmentId: APPOINTMENT,
        stepType: step.stepType,
        invalidationKey: step.invalidationKey,
        sendAtMs: step.sendAtMs,
      },
      appointment: { period: model.period, holdsResources: model.live },
      atMs,
      contentAvailable: true,
    })
    if (verdict.kind === 'send') {
      return { kind: 'sent', stale: verdict.stalenessNote !== null, matchesByModel }
    }
    if (verdict.kind === 'defer') return { kind: 'deferred', matchesByModel }
    return { kind: 'skipped', reason: verdict.reason, matchesByModel }
  })
}

const operations = fc.array(
  fc.oneof(
    { weight: 2, arbitrary: fc.constant<Operation>({ kind: 'confirm' }) },
    {
      weight: 5,
      arbitrary: fc
        // Includes the negative shifts that move an appointment EARLIER, and pairs that cancel out — which
        // is how a reschedule-and-reschedule-back history is generated rather than hand-written.
        .integer({ min: -6, max: 6 })
        .filter((hours) => hours !== 0)
        .map<Operation>((shiftHours) => ({ kind: 'reschedule', shiftHours })),
    },
    { weight: 1, arbitrary: fc.constant<Operation>({ kind: 'cancel' }) },
    {
      weight: 3,
      arbitrary: fc
        .integer({ min: -6, max: 6 })
        .filter((hours) => hours !== 0)
        .map<Operation>((shiftHours) => ({ kind: 'drift', shiftHours })),
    },
  ),
  { minLength: 1, maxLength: 8 },
)

/** The instant the drain happens at, spread around the original treatment. */
const drainInstant = fc
  .integer({ min: -30 * 60, max: 6 * 60 })
  .map((minutesFromStart) => BASE_START + minutesFromStart * 60_000)

/** The counters the replay and the judgement both increment. Mutable, which `RunSummary` is not. */
interface Counters {
  sent: number
  staleSends: number
  staleDetections: number
  reschedules: number
  cancels: number
  rescheduledBack: number
  deferred: number
  drifts: number
}

interface RunSummary {
  readonly violations: string[]
  readonly sent: number
  readonly staleSends: number
  readonly staleDetections: number
  readonly reschedules: number
  readonly cancels: number
  readonly rescheduledBack: number
  readonly deferred: number
  readonly drifts: number
}

/**
 * Runs the whole property over one decider and reports what happened.
 *
 * The violations list is what the invariant is about; the counts are what stop the invariant being
 * satisfied vacuously.
 */
function runProperty(decide: Decider): RunSummary {
  const summary: RunSummary = {
    violations: [],
    sent: 0,
    staleSends: 0,
    staleDetections: 0,
    reschedules: 0,
    cancels: 0,
    rescheduledBack: 0,
    deferred: 0,
    drifts: 0,
  }
  const counters = summary as Counters

  /*
    `fc.assert` THROWS on the first counterexample, which is what makes the real run report a shrunk
    sequence — and which would make the two mutant runs below throw instead of returning the violations
    they are supposed to produce. Caught here so that `violations` is the single thing every caller
    asserts on: a real regression still gets fast-check's shrinking (in the run output), and the
    assertion that fails is the one naming the invariant rather than a stack inside the library.
  */
  try {
    fc.assert(
      fc.property(operations, drainInstant, (sequence, atMs) => {
        const model = replay(sequence, counters)
        judge(drain(model, atMs, decide), { sequence, atMs }, counters, summary.violations)
        return summary.violations.length === 0
      }),
      { numRuns: SEQUENCES, seed: SEED },
    )
  } catch {
    // Swallowed on purpose: every caller asserts on `violations`, which is already populated.
  }
  return summary
}

/**
 * Replays one generated history against the model, counting the shapes it really produced.
 *
 * A function of its own rather than the body of the property, and the reason is a number `pnpm lint`
 * reports: the property with the replay and the judgement inline scored 42 against a ceiling of 20, and a
 * generated-history test nobody can read is a test nobody maintains.
 */
function replay(sequence: readonly Operation[], counters: Counters): Model {
  const model: Model = { period: periodAt(BASE_START), live: true, steps: [] }
  const periodsSeen: ScheduledStepPeriod[] = [model.period]
  apply(model, { kind: 'confirm' })
  for (const operation of sequence) {
    const before = model.period
    apply(model, operation)
    if (operation.kind === 'cancel') counters.cancels += 1
    if (operation.kind === 'drift' && model.live) counters.drifts += 1
    if (operation.kind !== 'reschedule' || !model.live) continue
    counters.reschedules += 1
    const seenBefore = periodsSeen.some((period) => samePeriod(period, model.period))
    if (!samePeriod(before, model.period) && seenBefore) counters.rescheduledBack += 1
    periodsSeen.push(model.period)
  }
  return model
}

/**
 * The invariant and its mirror image, over one drained history.
 *
 * Both directions, because one alone is satisfiable by a decider that does nothing: a step the model says
 * is STALE must not be sent, and a step the model says is CURRENT must not be refused as stale.
 */
function judge(
  records: readonly DrainRecord[],
  history: { readonly sequence: readonly Operation[]; readonly atMs: number },
  counters: Counters,
  violations: string[],
): void {
  for (const record of records) {
    if (record.kind === 'deferred') counters.deferred += 1
    if (record.kind === 'sent') {
      counters.sent += 1
      if (record.stale) counters.staleSends += 1
      // THE invariant. `matchesByModel` is the model's own bookkeeping about the period each step was
      // written for; nothing in this comparison derives a key.
      if (!record.matchesByModel) {
        violations.push(
          'a message was sent for a step built over a period the appointment no longer holds ' +
            `(sequence ${JSON.stringify(history.sequence)}, drained at ` +
            `${new Date(history.atMs).toISOString()})`,
        )
      }
    }
    if (record.kind === 'skipped' && record.reason === 'invalidation_key_stale') {
      counters.staleDetections += 1
      if (record.matchesByModel) {
        violations.push(
          "a step built over the appointment's CURRENT period was refused as stale " +
            `(sequence ${JSON.stringify(history.sequence)})`,
        )
      }
    }
  }
}

describe(`the invalidation key over ${SEQUENCES} randomised reschedule and cancel sequences`, () => {
  const summary = runProperty(decideScheduledStep)

  it('sends zero messages for a step whose key does not match the current period', () => {
    expect(summary.violations).toEqual([])
  })

  it('did enough for the invariant to mean something', () => {
    // Every one of these is a way the assertion above could have been vacuous.
    expect(summary.sent, 'no message was ever sent, so nothing was ever at risk').toBeGreaterThan(0)
    expect(
      summary.staleDetections,
      'no stale step was ever detected, so the check may never have run',
    ).toBeGreaterThan(0)
    expect(summary.reschedules, 'no sequence rescheduled anything').toBeGreaterThan(0)
    expect(summary.cancels, 'no sequence cancelled anything').toBeGreaterThan(0)
    expect(
      summary.drifts,
      'no sequence moved the period without invalidating its steps, so the key check had nothing to ' +
        'refuse and the mutants below would pass',
    ).toBeGreaterThan(0)
    expect(
      summary.rescheduledBack,
      'no sequence rescheduled back to a period it had already used, which is the case where the key ' +
        'of a superseded step re-derives',
    ).toBeGreaterThan(0)
    expect(summary.deferred, 'no step was ever drained before it was due').toBeGreaterThan(0)
    expect(
      summary.staleSends,
      'no send was ever late, so the outage path was never taken',
    ).toBeGreaterThan(0)
  })

  it('detects a deliberately stale key, by name', () => {
    // The control the brief asks for, stated as its own case rather than left to the generator: a step
    // whose key belongs to a period ONE MINUTE away from the appointment's.
    const period = periodAt(BASE_START)
    const nudged = periodAt(BASE_START + 60_000)
    const answer = decideScheduledStep({
      step: {
        appointmentId: APPOINTMENT,
        stepType: 'reminder_24h',
        invalidationKey: invalidationKeyFor({
          appointmentId: APPOINTMENT,
          stepType: 'reminder_24h',
          period: nudged,
        }),
        sendAtMs: period.startsAtMs - 24 * HOUR_MS,
      },
      appointment: { period, holdsResources: true },
      atMs: period.startsAtMs - 24 * HOUR_MS,
      contentAvailable: true,
    })
    expect(answer.kind).toBe('skip')
    expect(answer.kind === 'skip' && answer.reason).toBe('invalidation_key_stale')
  })
})

describe('the oracle can fail', () => {
  /** The bug itself: a decider that never compares the key. */
  const noKeyCheck: Decider = (request) => {
    if (!request.appointment.holdsResources) {
      return { kind: 'skip', reason: 'appointment_not_live', why: 'mutant' }
    }
    if (request.atMs >= request.appointment.period.startsAtMs) {
      return { kind: 'skip', reason: 'send_window_missed', why: 'mutant' }
    }
    if (request.atMs < request.step.sendAtMs) return { kind: 'defer', why: 'mutant' }
    return { kind: 'send', stalenessNote: null, lateByMinutes: 0 }
  }

  /** A "key" that forgot the period: it compares the appointment and the step type and nothing else. */
  const keyWithoutThePeriod: Decider = (request) => {
    const expected = `${request.step.stepType}:${request.step.appointmentId}`
    const stored = request.step.invalidationKey.split('/')[0]?.replace(/:[^:]*$/, '') ?? ''
    if (stored !== expected) {
      return { kind: 'skip', reason: 'invalidation_key_stale', why: 'mutant' }
    }
    return noKeyCheck(request)
  }

  it('reports violations for a decider that does not check the key at all', () => {
    expect(runProperty(noKeyCheck).violations.length).toBeGreaterThan(0)
  })

  it('reports violations for a key that compares everything except the period', () => {
    expect(runProperty(keyWithoutThePeriod).violations.length).toBeGreaterThan(0)
  })
})
