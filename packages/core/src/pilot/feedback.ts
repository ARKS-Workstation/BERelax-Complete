import {
  PILOT_FEEDBACK_CATEGORY_VALUES,
  type PilotFeedbackCategoryDefinition,
  pilotFeedbackCategory,
  pilotFixUnitId,
} from '@berelax/shared'

/**
 * Pilot feedback, captured against a CLOSED taxonomy and turned into manifest fix units.
 *
 * Pure, and in `@berelax/core` for the ordinary reason: `scripts/pilot-feedback-to-units.mjs` is the
 * door a person runs it through and is a thin wrapper, so the decision about what becomes a unit is in
 * one testable function rather than in a script nothing exercises.
 *
 * ## Why two of the eight categories produce NO unit
 *
 * `not_a_defect` and `device_or_hardware` are recorded, counted, and generate nothing — and
 * `not_a_defect` is the category that earns the taxonomy. Without it every item becomes a fix unit, the
 * build acquires work from each expectation nobody had set, and the first response to a backlog like
 * that is to stop recording feedback. `device_or_hardware` produces nothing for a different reason: a
 * receipt printer or an OTP autofill is not something this build can change (Y14-devices), so a unit for
 * it would be a unit nobody could do.
 *
 * Both are REPORTED per item rather than dropped. An item that silently produced no unit is an item
 * whoever reported it will raise again.
 *
 * ## Why the taxonomy is closed and an unknown category is a refusal
 *
 * The thing reading the category is a generator that writes a unit into the build's plan. A free category
 * would be a unit title nobody planned; an unknown one answered with a default would file somebody's
 * complaint under the wrong heading and generate the wrong work. So an unknown category is refused by
 * name, with the eight it could have been.
 */

export interface PilotFeedbackItem {
  /** Stable, from the capture surface. It is what a generated unit's provenance points back at. */
  readonly id: string
  readonly category: string
  /** One line, in the reporter's words. It becomes the unit's title. */
  readonly summary: string
  /** Who reported it, as they identify themselves. A claim, like every pilot figure. */
  readonly reportedBy: string
  /** The screen or step it is about. Free text: the pilot is where this build finds out. */
  readonly surface: string
}

export interface PilotFixUnit {
  readonly id: string
  readonly title: string
  readonly category: string
  readonly surface: string
  readonly feedbackId: string
  readonly reportedBy: string
}

export interface PilotFeedbackNotAUnit {
  readonly feedbackId: string
  readonly category: string
  readonly summary: string
  /** Why this category produces no unit, from the taxonomy itself rather than restated here. */
  readonly reason: string
}

export interface PilotFeedbackPlan {
  readonly units: readonly PilotFixUnit[]
  readonly notUnits: readonly PilotFeedbackNotAUnit[]
  /** Items refused, with why. A refused item is never silently absent from both lists. */
  readonly refused: readonly { readonly at: number; readonly reason: string }[]
}

const REFUSALS = {
  unknownCategory: 'pilot-feedback-category-must-be-one-of-the-taxonomy',
  idMissing: 'pilot-feedback-item-must-have-an-id',
  summaryMissing: 'pilot-feedback-item-must-have-a-summary',
  reporterMissing: 'pilot-feedback-item-must-name-who-reported-it',
  duplicateId: 'pilot-feedback-item-ids-must-be-unique',
} as const

export const PILOT_FEEDBACK_REFUSALS = REFUSALS

/**
 * Plans the fix units for a feedback log.
 *
 * The ordinal a unit's id takes is its position among the items that BECOME units, not its position in
 * the log — so a log with a `not_a_defect` item third does not leave a gap at `H-PILOT-03`. A gap would
 * read as a unit somebody deleted.
 */
export function planPilotFeedback(items: readonly unknown[]): PilotFeedbackPlan {
  const units: PilotFixUnit[] = []
  const notUnits: PilotFeedbackNotAUnit[] = []
  const refused: { at: number; reason: string }[] = []
  const seen = new Set<string>()

  for (const [at, raw] of items.entries()) {
    const item = raw as Partial<PilotFeedbackItem>
    const trimmed = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const id = trimmed(item.id)
    if (id.length === 0) {
      refused.push({ at, reason: REFUSALS.idMissing })
      continue
    }
    if (seen.has(id)) {
      refused.push({ at, reason: `${REFUSALS.duplicateId}: ${id}` })
      continue
    }
    seen.add(id)
    const summary = trimmed(item.summary)
    if (summary.length === 0) {
      refused.push({ at, reason: `${REFUSALS.summaryMissing}: ${id}` })
      continue
    }
    const reportedBy = trimmed(item.reportedBy)
    if (reportedBy.length === 0) {
      refused.push({ at, reason: `${REFUSALS.reporterMissing}: ${id}` })
      continue
    }
    const definition: PilotFeedbackCategoryDefinition | null = pilotFeedbackCategory(
      trimmed(item.category),
    )
    if (definition === null) {
      refused.push({
        at,
        reason:
          `${REFUSALS.unknownCategory}: ${id} is "${trimmed(item.category)}", and the taxonomy is ` +
          `${PILOT_FEEDBACK_CATEGORY_VALUES.join(', ')}`,
      })
      continue
    }
    if (!definition.fixUnit) {
      notUnits.push({
        feedbackId: id,
        category: definition.category,
        summary,
        reason: definition.reason,
      })
      continue
    }
    units.push({
      id: pilotFixUnitId(units.length + 1),
      title: summary,
      category: definition.category,
      surface: trimmed(item.surface),
      feedbackId: id,
      reportedBy,
    })
  }

  return {
    units: Object.freeze(units),
    notUnits: Object.freeze(notUnits),
    refused: Object.freeze(refused),
  }
}

/**
 * The manifest fragment for one planned unit, as YAML.
 *
 * Hand-rendered rather than serialised through a library, because `packages/core` may import nothing but
 * `@berelax/shared` — and because the fragment is four lines whose shape `build/manifest.yaml` fixes.
 * Every value a reporter typed is quoted and its quotes doubled, so a summary containing one cannot
 * produce a file that parses as something else.
 */
export function pilotFixUnitYaml(unit: PilotFixUnit): string {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  return [
    `  - id: ${unit.id}`,
    `    title: ${quote(unit.title)}`,
    `    owner: claude`,
    `    status: todo`,
    `    size: S`,
    `    pilot_feedback:`,
    `      id: ${quote(unit.feedbackId)}`,
    `      category: ${unit.category}`,
    `      surface: ${quote(unit.surface)}`,
    `      reported_by: ${quote(unit.reportedBy)}`,
    `    depends_on:`,
    `    - H-MIG-10`,
  ].join('\n')
}
