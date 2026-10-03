/**
 * The parallel run's shared vocabulary: the window's two setting keys, the cutover decision's two
 * values, the pilot feedback taxonomy, and the front-desk speed budget.
 *
 * In `@berelax/shared` because three packages need the same names and none of them may import the
 * others: `@berelax/config` declares the settings, `@berelax/db` reads them and writes the rows the
 * triggers judge, and `scripts/pilot-feedback-to-units.mjs` turns a feedback item into a manifest unit.
 * A second spelling anywhere is a reader that silently falls back to a declared default — which for the
 * window would be invisible, because the fallback is a date.
 */

/**
 * The parallel-run window, which has NO default and is two settings rather than one.
 *
 * Two and not one because the run has a start and an end and both decide which days the comparison is
 * about: before the start the system was not recording, after the end the paper sheet was not, and in
 * both cases "the paper and the system agree" is a statement about which of the two was switched off.
 *
 * No date, because a plausible cutover date in this build would be indistinguishable from a configured
 * one the day somebody read it (brief rule 15) — and unlike a threshold, a date cannot be chosen as "the
 * strictest safe option": every candidate is equally made up. So both settings default to the EMPTY
 * STRING until {@link PARALLEL_RUN_WINDOW_OPEN_QUESTION_ID} is answered, and the reconciliation refuses
 * to run rather than reconciling zero days, because "0 days, no variance" reads exactly like a parallel
 * run in which everything agreed.
 *
 * Blank and not null: `app_setting.value` is `not null` and the seeder writes one row per definition, so
 * a null-defaulted setting is one that cannot be seeded at all. Blank is also the better value on its own
 * terms — brief rule 15's own words are that blank is visibly unanswered where plausible is
 * indistinguishable from configured.
 */
export const PARALLEL_RUN_WINDOW_START_SETTING_KEY = 'migration.parallel_run_window_start'
export const PARALLEL_RUN_WINDOW_END_SETTING_KEY = 'migration.parallel_run_window_end'

/** Both, for a panel or a test that has to prove neither was forgotten. */
export const PARALLEL_RUN_WINDOW_SETTING_KEYS = [
  PARALLEL_RUN_WINDOW_START_SETTING_KEY,
  PARALLEL_RUN_WINDOW_END_SETTING_KEY,
] as const

export const PARALLEL_RUN_WINDOW_OPEN_QUESTION_ID = 'Y8-parallel-run-window'

/** The open question the pilot itself stands against. An owner verification task, not a code change. */
export const PILOT_OPEN_QUESTION_ID = 'Y12-pilot'
/** Real-device results. Recorded as ABSENT rather than assumed passing. */
export const PILOT_DEVICE_OPEN_QUESTION_ID = 'Y14-devices'

/**
 * What a cutover decision can say, and there are exactly two answers.
 *
 * Nothing in this build computes which: no trigger derives it from the variance rows, no view
 * recommends one and no job writes one. Whether a business goes live on this system or back to paper is
 * not a function of a variance count, and a mechanism here would be this build deciding it from a rule
 * nobody wrote down. The names exist so a column, a screen and a test cannot disagree about the two.
 */
export const PARALLEL_RUN_DECISIONS = ['proceed', 'roll_back'] as const
export type ParallelRunDecisionValue = (typeof PARALLEL_RUN_DECISIONS)[number]

/**
 * The CLOSED taxonomy a pilot feedback item is captured against, and what each category does next.
 *
 * Closed, because the thing that reads it is a generator that turns an item into a manifest unit: a free
 * category would be a unit title nobody planned, and an item nobody could file would be one somebody
 * describes in a message instead. Y12-pilot's wording is "report what the front desk complains about",
 * and these seven are the shapes a complaint about a front desk takes.
 *
 * **`not_a_defect` is the one that earns the taxonomy.** Without it every item becomes a fix unit, which
 * means the build acquires work from each expectation nobody had set — and the first response to a
 * backlog like that is to stop recording feedback. An item in that category is recorded, counted, and
 * generates NO unit; `fixUnit` is false and `scripts/pilot-feedback-to-units.mjs` says so per item
 * rather than silently dropping it.
 *
 * `device_or_hardware` generates no unit either, and for a different reason: a receipt printer, an OTP
 * autofill or an SMS arriving on a UAE handset is not something this build can change
 * ({@link PILOT_DEVICE_OPEN_QUESTION_ID}), so a unit for it would be a unit nobody could do.
 */
export interface PilotFeedbackCategoryDefinition {
  readonly category: string
  /** One line, as it appears on the capture form. */
  readonly label: string
  /** Does an item in this category become a manifest fix unit? */
  readonly fixUnit: boolean
  /** Why not, for the two that do not. Empty for the five that do. */
  readonly reason: string
}

export const PILOT_FEEDBACK_CATEGORIES: readonly PilotFeedbackCategoryDefinition[] = Object.freeze([
  Object.freeze({
    category: 'too_many_steps',
    label: 'It takes more taps or screens than it should',
    fixUnit: true,
    reason: '',
  }),
  Object.freeze({
    category: 'wrong_default',
    label: 'A field starts on the wrong value and has to be changed every time',
    fixUnit: true,
    reason: '',
  }),
  Object.freeze({
    category: 'missing_information',
    label: 'Something the desk needs is not on the screen',
    fixUnit: true,
    reason: '',
  }),
  Object.freeze({
    category: 'wrong_information',
    label: 'Something on the screen is wrong or out of date',
    fixUnit: true,
    reason: '',
  }),
  Object.freeze({
    category: 'too_slow',
    label: 'It is slower than doing it on paper',
    fixUnit: true,
    reason: '',
  }),
  Object.freeze({
    category: 'wording_unclear',
    label: 'The words on the screen do not mean what they say',
    fixUnit: true,
    reason: '',
  }),
  Object.freeze({
    category: 'device_or_hardware',
    label: 'The printer, the handset or the card reader',
    fixUnit: false,
    reason:
      `not something this build can change — see ${PILOT_DEVICE_OPEN_QUESTION_ID}. A unit for it would ` +
      'be a unit nobody could do',
  }),
  Object.freeze({
    category: 'not_a_defect',
    label: 'It works as intended and nobody had said so',
    fixUnit: false,
    reason:
      'the answer is training or a note, not code. Without this category every item becomes a fix unit, ' +
      'the build acquires work from each expectation nobody had set, and the first response to a backlog ' +
      'like that is to stop recording feedback',
  }),
])

export const PILOT_FEEDBACK_CATEGORY_VALUES: readonly string[] = Object.freeze(
  PILOT_FEEDBACK_CATEGORIES.map((entry) => entry.category),
)

/** The categories that become a manifest unit, and the two that do not. */
export const PILOT_FEEDBACK_FIX_CATEGORIES: readonly string[] = Object.freeze(
  PILOT_FEEDBACK_CATEGORIES.filter((entry) => entry.fixUnit).map((entry) => entry.category),
)

export function pilotFeedbackCategory(category: string): PilotFeedbackCategoryDefinition | null {
  return PILOT_FEEDBACK_CATEGORIES.find((entry) => entry.category === category) ?? null
}

/** The id prefix a generated fix unit takes. One series, so two generators cannot collide. */
export const PILOT_FIX_UNIT_PREFIX = 'H-PILOT'

/** `H-PILOT-07`. Two digits, so the ids sort as text in the order they were issued. */
export const pilotFixUnitId = (ordinal: number): string =>
  `${PILOT_FIX_UNIT_PREFIX}-${String(ordinal).padStart(2, '0')}`

/**
 * The front-desk speed requirement: a walk-in bookable in under ten seconds at the 95th percentile.
 *
 * The figure is the specification's, not this build's. What is NOT here is a machine: the acceptance line
 * says "on the seeded dataset" and names no hardware, and brief rule 23 is the reason that matters — a
 * wall-clock assertion measures the machine rather than the code, and a p95 measured in an agent
 * container with six other agents on four cores is a figure about the container. So
 * `artifacts/pilot/walk-in-speed.json` records a measurement with the machine it was taken on, and
 * records it as ABSENT when no run has taken one, which is this unit's own provisional note:
 * real-device results recorded as absent, not assumed passing.
 */
export const WALK_IN_SPEED_BUDGET_MS = 10_000
export const WALK_IN_SPEED_PERCENTILE = 95
