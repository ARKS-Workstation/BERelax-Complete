import { AppError } from '@berelax/shared'

/**
 * Internal truth against what was pushed (A-MEAS-07).
 *
 * ## Why the ANSWER is a discriminated union and not a number
 *
 * The acceptance line is *"when the difference is non-zero the revenue-by-source panel renders an explicit
 * unreconciled state and the API returns Unreconciled rather than a number"*, and that is the whole design.
 * A reconciliation that answered `differenceFils: 12_505` would be rendered by a panel the same way a
 * reconciliation answering `0` is — a figure, in a box — and the one thing a reader has to be told is that
 * the figures on this screen cannot be trusted today. ADR 0073 made the same decision for the KPI
 * registry, and ADR 0002 is the general rule: *a report that cannot distinguish "no conversions" from
 * "conversions we failed to attribute" is worse than no report.*
 *
 * So {@link reconcileDispatches} returns `{ kind: 'reconciled', … }` or `{ kind: 'unreconciled', … }`, and
 * the unreconciled variant **has no revenue figure on it at all**. That is not tidiness: a caller that
 * could read a number off it would read it, and the panel would render it beside a warning nobody looks
 * at twice.
 *
 * ## The three classifications, and the one that is not a discrepancy
 *
 * - `missing` — this business has a conversion and the platform was never successfully told. A `queued` or
 *   `failed` dispatch is MISSING and not a fourth state: the pass runs after the day has closed and the
 *   consumer drains every five minutes, so a row still owed at that point is a conversion the platform
 *   does not have, whatever the reason.
 * - `duplicate` — it was told twice, and the item carries BOTH dispatch ids, because "there is a
 *   duplicate" is not actionable and "these two rows are the same conversion" is.
 * - `intentionally_not_pushed` — the visitor did not grant the signal the destination requires, 0125 wrote
 *   the suppression, and the push correctly never happened. **It is not a discrepancy.** A reconciliation
 *   that counted it as missing would report a growing number of entirely correct refusals as a fault,
 *   every day, for ever — and the first response to a number like that is to make it go away.
 *
 * ## The fourth difference, which is reported separately rather than squeezed into the three
 *
 * A dispatch whose event id has no internal conversion behind it is the other direction, and it is the
 * more alarming one: a platform was told about a conversion this business cannot produce from its own
 * records. It is NOT one of the three classifications — the unit's vocabulary is the three — so it is
 * carried on its own list, {@link DispatchReconciliationUnreconciled.pushedWithoutInternalTruth}, and it
 * makes the day unreconciled. Folding it into `duplicate` would have been the convenient lie; leaving it
 * out would have been the silent one.
 *
 * ## Pure
 *
 * No clock, no I/O, no configuration. The pass reads both sides and asks this; the database stores what it
 * answers; the panel renders it. Nothing holds a second copy of the arithmetic, which matters more here
 * than anywhere: this module's whole subject is two sides of one figure disagreeing.
 */

export const DISPATCH_DIFFERENCE_KINDS = [
  'missing',
  'duplicate',
  'intentionally_not_pushed',
] as const
export type DispatchDifferenceKind = (typeof DISPATCH_DIFFERENCE_KINDS)[number]

/** The states a dispatch row may be in (0125 and 0137). Mirrored rather than imported: core sees no db. */
export const DISPATCH_STATES = [
  'queued',
  'sent',
  'suppressed',
  'cancelled_consent_withdrawn',
  'failed',
  /**
   * 0151, A-MEAS-06: a dispatch whose retry budget ran out. Terminal in the sense `sent` is.
   *
   * It arrived exactly the way the comment below says a sixth state would: the `Record`s stopped
   * compiling and this module refused the state by name until somebody decided what it counts as.
   */
  'dead_letter',
] as const
export type DispatchState = (typeof DISPATCH_STATES)[number]

/**
 * Which states count as HAVING BEEN PUSHED, as a total map rather than a predicate.
 *
 * A `Record` over the union with no default branch, so a sixth state stops this module compiling until
 * somebody decides what it means. The alternative — `state === 'sent'` — is the same answer today and is
 * the shape that silently classified a new state as missing the day one arrived.
 */
export const DISPATCH_STATE_WAS_PUSHED: Readonly<Record<DispatchState, boolean>> = Object.freeze({
  queued: false,
  sent: true,
  suppressed: false,
  cancelled_consent_withdrawn: false,
  failed: false,
  /*
   * A dead letter was NOT pushed, and it is the most certain `missing` of the six.
   *
   * ADR 0093 already decided that a `queued` or `failed` dispatch is `missing` rather than a fourth
   * state, because the pass runs after the day has closed and the five-minute consumer has had time to
   * drain. A dead letter is that conclusion reached by the consumer itself: it has given up, so there is
   * no later pass that could change the answer.
   */
  dead_letter: false,
})

/**
 * Which states are a DELIBERATE refusal rather than an absence, as a total map.
 *
 * Both of 0125's refusal states, and they are deliberately both here: a dispatch nobody was ever permitted
 * to send and one cancelled because the visitor changed their mind are different facts, and both are the
 * system working.
 */
export const DISPATCH_STATE_WAS_REFUSED_ON_PURPOSE: Readonly<Record<DispatchState, boolean>> =
  Object.freeze({
    queued: false,
    sent: false,
    suppressed: true,
    cancelled_consent_withdrawn: true,
    failed: false,
    /*
     * NOT a deliberate refusal, and the distinction is the one `intentionally_not_pushed` rests on.
     *
     * A suppression is the VISITOR's refusal and the push correctly never happened; a dead letter is this
     * build failing to deliver a conversion it was permitted to send. Counting it here would hide a
     * permanent delivery failure inside the one classification A-MEAS-07 deliberately keeps out of the
     * difference — which is the exact shape of the defect ADR 0093 warns about from the other direction.
     */
    dead_letter: false,
  })

/** One conversion this business says it took. The internal side of the comparison. */
export interface InternalConversion {
  readonly eventId: string
  /** Integer fils, signed: a void and a credit note are negative statements (A-MEAS-05). */
  readonly valueFils: number
}

/** One dispatch row, as the queue holds it. The pushed side of the comparison. */
export interface PushedDispatch {
  readonly eventId: string
  readonly dispatchId: string
  readonly state: DispatchState
  /** The figure the payload carried, integer fils, signed. Read off the stored payload, never rebuilt. */
  readonly valueFils: number
}

export type DispatchDifference =
  | { readonly kind: 'missing'; readonly eventId: string; readonly valueFils: number }
  | {
      readonly kind: 'duplicate'
      readonly eventId: string
      /** Both rows, and the first two in id order when a conversion was pushed more than twice. */
      readonly dispatchId: string
      readonly otherDispatchId: string
      readonly valueFils: number
    }
  | {
      readonly kind: 'intentionally_not_pushed'
      readonly eventId: string
      /** The suppression row that records the refusal, which is why 0125 writes one. */
      readonly dispatchId: string
      readonly state: DispatchState
    }

export interface DispatchReconciliationCounts {
  readonly internalCount: number
  readonly pushedCount: number
  readonly missingCount: number
  readonly duplicateCount: number
  readonly intentionallyNotPushedCount: number
}

export interface DispatchReconciliationReconciled extends DispatchReconciliationCounts {
  readonly kind: 'reconciled'
  readonly destination: string
  /**
   * The figure, in integer fils, and it exists on THIS variant only.
   *
   * The unreconciled variant carries no revenue figure at all, which is what stops a caller reading one
   * off it and rendering it beside a warning nobody looks at twice.
   */
  readonly pushedFils: number
  /** The suppressions, which are not discrepancies and are still named. */
  readonly intentionallyNotPushed: readonly DispatchDifference[]
}

export interface DispatchReconciliationUnreconciled {
  readonly kind: 'unreconciled'
  readonly destination: string
  readonly counts: DispatchReconciliationCounts
  /** Every difference, classified. Ordered: missing, then duplicate, then the suppressions. */
  readonly differences: readonly DispatchDifference[]
  /**
   * Signed, in integer fils: what this business took minus what the platform was told.
   *
   * On the unreconciled variant this is the SIZE OF THE DISAGREEMENT and never a revenue figure, which is
   * why it is named `differenceFils` and why `pushedFils` is absent from this variant entirely.
   */
  readonly differenceFils: number
  /** Dispatches with no internal conversion behind them. See the module header: the other direction. */
  readonly pushedWithoutInternalTruth: readonly string[]
}

export type DispatchReconciliation =
  | DispatchReconciliationReconciled
  | DispatchReconciliationUnreconciled

/** The one question a panel asks. A function rather than a field, so neither side can set it directly. */
export const isUnreconciled = (
  result: DispatchReconciliation,
): result is DispatchReconciliationUnreconciled => result.kind === 'unreconciled'

/**
 * Compares one destination's internal truth against what it was told.
 *
 * Total over its inputs and never throwing on a disagreement — a disagreement is the ANSWER. It throws
 * only for an input that is not a figure at all, because a fractional fils on either side is a float
 * arriving from upstream and the difference it produces would be a number nobody can reconcile.
 */
export function reconcileDispatches(input: {
  readonly destination: string
  readonly internal: readonly InternalConversion[]
  readonly pushed: readonly PushedDispatch[]
}): DispatchReconciliation {
  for (const conversion of input.internal) {
    assertWholeFils(conversion.valueFils, 'internal conversion', conversion.eventId)
  }
  for (const dispatch of input.pushed) {
    assertWholeFils(dispatch.valueFils, 'dispatch', dispatch.eventId)
  }

  /** Every dispatch for one event id, in id order, so "the first two" is a decision and not an accident. */
  const byEvent = new Map<string, PushedDispatch[]>()
  for (const dispatch of input.pushed) {
    const seen = byEvent.get(dispatch.eventId)
    if (seen === undefined) byEvent.set(dispatch.eventId, [dispatch])
    else seen.push(dispatch)
  }
  for (const rows of byEvent.values()) rows.sort((a, b) => a.dispatchId.localeCompare(b.dispatchId))

  const missing: DispatchDifference[] = []
  const duplicate: DispatchDifference[] = []
  const suppressed: DispatchDifference[] = []
  let internalFils = 0
  let pushedFils = 0
  let pushedCount = 0

  const internalIds = new Set<string>()
  for (const conversion of input.internal) {
    internalIds.add(conversion.eventId)
    internalFils += conversion.valueFils
    const rows = byEvent.get(conversion.eventId) ?? []
    const delivered = rows.filter((row) => DISPATCH_STATE_WAS_PUSHED[row.state])
    const refused = rows.filter((row) => DISPATCH_STATE_WAS_REFUSED_ON_PURPOSE[row.state])

    if (delivered.length > 1) {
      /*
       * A duplicate is counted ONCE and its value counted once, not once per row. The platform's figure is
       * the sum over the ids it has seen, so a conversion delivered twice under one id is one conversion
       * to it as well — the duplicate is a defect in this build's records, and double-counting it here
       * would make the money difference report a disagreement that does not exist.
       */
      const [first, second] = delivered as [PushedDispatch, PushedDispatch, ...PushedDispatch[]]
      duplicate.push({
        kind: 'duplicate',
        eventId: conversion.eventId,
        dispatchId: first.dispatchId,
        otherDispatchId: second.dispatchId,
        valueFils: first.valueFils,
      })
      pushedFils += first.valueFils
      pushedCount += 1
      continue
    }
    const only = delivered[0]
    if (only !== undefined) {
      pushedFils += only.valueFils
      pushedCount += 1
      continue
    }
    const refusal = refused[0]
    if (refusal !== undefined) {
      /*
       * Classified and NOT counted as a discrepancy, and the value is deliberately left out of both sides
       * of the difference: the conversion happened and the push correctly did not, so a difference that
       * carried it would be a permanent, entirely correct disagreement — and a permanent disagreement is a
       * number somebody eventually suppresses.
       */
      suppressed.push({
        kind: 'intentionally_not_pushed',
        eventId: conversion.eventId,
        dispatchId: refusal.dispatchId,
        state: refusal.state,
      })
      internalFils -= conversion.valueFils
      continue
    }
    missing.push({ kind: 'missing', eventId: conversion.eventId, valueFils: conversion.valueFils })
  }

  const pushedWithoutInternalTruth: string[] = []
  for (const [eventId, rows] of byEvent) {
    if (internalIds.has(eventId)) continue
    if (!rows.some((row) => DISPATCH_STATE_WAS_PUSHED[row.state])) continue
    pushedWithoutInternalTruth.push(eventId)
    for (const row of rows.filter((candidate) => DISPATCH_STATE_WAS_PUSHED[candidate.state])) {
      pushedFils += row.valueFils
      pushedCount += 1
    }
  }
  pushedWithoutInternalTruth.sort()

  const counts: DispatchReconciliationCounts = {
    internalCount: input.internal.length,
    pushedCount,
    missingCount: missing.length,
    duplicateCount: duplicate.length,
    intentionallyNotPushedCount: suppressed.length,
  }
  const differenceFils = internalFils - pushedFils

  if (
    differenceFils === 0 &&
    missing.length === 0 &&
    duplicate.length === 0 &&
    pushedWithoutInternalTruth.length === 0
  ) {
    return {
      kind: 'reconciled',
      destination: input.destination,
      ...counts,
      pushedFils,
      intentionallyNotPushed: suppressed,
    }
  }
  return {
    kind: 'unreconciled',
    destination: input.destination,
    counts,
    differences: [...missing, ...duplicate, ...suppressed],
    differenceFils,
    pushedWithoutInternalTruth,
  }
}

function assertWholeFils(valueFils: number, side: string, eventId: string): void {
  if (Number.isInteger(valueFils)) return
  throw new AppError(
    'invariant_violated',
    `A ${side} for event ${eventId} carries ${valueFils} fils, which is not a whole number. Money is ` +
      'integer fils (ADR 0007), and a fractional fils on either side of this comparison produces a ' +
      'difference nobody can reconcile against the journal.',
    { details: { side, eventId, valueFils } },
  )
}

/**
 * The sentence a panel renders instead of a figure, as a value rather than as copy in a component.
 *
 * Here and not in the panel because `apps/web/src/revenue-by-source-render.test.ts` asserts the BYTES of
 * the rendered document, and a sentence spelled in both places is the second statement of a fact that
 * drifts — with the drifting copy on the screen somebody reads.
 */
export const UNRECONCILED_PANEL_SENTENCE =
  'Revenue by source is unreconciled for this day: what this business recorded and what the advertising ' +
  'destinations were told do not agree, so no figure is shown. The differences are listed by conversion.'

/** The one word an API answers in place of a number. Read by the panel and by the handler. */
export const UNRECONCILED = 'Unreconciled' as const
