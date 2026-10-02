import { describe, expect, it } from 'vitest'
import {
  CHARGEBACK_CLEARING_ACCOUNT,
  chargebackLostEntry,
  chargebackNetEffectFils,
  chargebackReceivedEntry,
  chargebackWonEntry,
  chargedBackNetFils,
} from '../ledger/chargeback.ts'
import { STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import type { EntryId, JournalEntry } from '../ledger/entry.ts'
import { creditTotalFils, debitTotalFils, entryId } from '../ledger/entry.ts'
import type { LocalDate } from '../time.ts'
import { localDate } from '../time.ts'
import { isRefundPermitted, refundableFils } from './refund.ts'

/**
 * The acceptance line, as a property: **debits equal credits after every step, and refunded never exceeds
 * captured, over 1,000 random capture / partial-refund / chargeback / chargeback-reversal sequences.**
 *
 * ## Why a property and not a table of cases
 *
 * The failure this is against is not an arithmetic slip in one shape. It is that a sequence of four
 * independently-correct operations can arrive at a position that is impossible — and which of the
 * orderings does it depends on how the cap is written. AED 100 captured, AED 60 refunded, AED 60 charged
 * back: each step satisfies `refunded <= captured` and the business has given back AED 120 of AED 100.
 * A table of cases would contain the orderings somebody thought of.
 *
 * ## The generator is weighted, and the test COUNTS whether it could disagree
 *
 * Brief rule 22, and it is the part of this file worth reading. A generator drawing amounts uniformly
 * from a wide range almost never produces a sequence that reaches the cap at all — so the property would
 * hold for a completely uncapped implementation in most runs, and the visible symptom would be a gate
 * reporting the rule as missing. So amounts are drawn from a range deliberately close to the capture, the
 * suite counts how many generated sequences actually PRESSED against the cap, and asserts that count
 * against a floor that was MEASURED rather than guessed.
 *
 * The floor is set well under the observed minimum over repeated runs, because a floor set just under the
 * observed minimum becomes its own flake.
 */

const CHART = STANDARD_SPA_CHART
const DAY: LocalDate = localDate('2099-06-01')
const NEXT_DAY: LocalDate = localDate('2099-06-03')

/** Mulberry32. A seeded PRNG so a failure is reproducible from the seed printed in the message. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Step =
  | { readonly kind: 'capture'; readonly fils: number }
  | { readonly kind: 'refund'; readonly fils: number }
  | { readonly kind: 'chargeback'; readonly fils: number; readonly ref: string }
  | { readonly kind: 'chargeback_won'; readonly ref: string }

interface Position {
  capturedFils: number
  refundedFils: number
  /** Every dispute event so far, so `chargedBackNetFils` is the only thing that nets them. */
  disputes: { readonly kind: 'received' | 'won' | 'lost'; readonly amountFils: number }[]
  openDisputes: { readonly ref: string; readonly fils: number }[]
  entries: JournalEntry[]
  /** The received entry per dispute ref, so a win is the reversal of the right one. */
  receivedEntries: Map<string, JournalEntry>
}

/**
 * One random sequence, applied. Every step that the cap would refuse is SKIPPED rather than forced, which
 * is what makes this a model of a correct caller — and the count of skips is what proves the cap bit.
 */
function runSequence(
  random: () => number,
  steps: number,
): { position: Position; pressed: number; reachedCap: boolean } {
  const position: Position = {
    capturedFils: 0,
    refundedFils: 0,
    disputes: [],
    openDisputes: [],
    entries: [],
    receivedEntries: new Map(),
  }
  let pressed = 0
  let reachedCap = false
  let nextEntry = 0

  // The first step is always a capture, because nothing can be refunded or disputed before one, and a
  // generator that produced leading refunds would spend most of its budget on steps that do nothing.
  position.capturedFils = 1_000 + Math.floor(random() * 50_000)

  for (let i = 0; i < steps; i += 1) {
    const draw = random()
    const remaining = refundableFils({
      capturedFils: position.capturedFils,
      refundedFils: position.refundedFils,
      chargedBackFils: chargedBackNetFils(position.disputes),
    }) as number

    // Weighted TOWARDS the remaining amount, which is brief rule 22's whole point: an amount drawn from
    // 1..50,000 against a capture of 50,000 presses the cap almost never.
    const amount = Math.max(1, Math.floor(remaining * (0.3 + random() * 0.9)))

    let step: Step
    if (draw < 0.4) step = { kind: 'refund', fils: amount }
    else if (draw < 0.75) step = { kind: 'chargeback', fils: amount, ref: `D-${i}` }
    else if (position.openDisputes.length > 0) {
      const open = position.openDisputes[Math.floor(random() * position.openDisputes.length)]
      step = { kind: 'chargeback_won', ref: (open as { ref: string }).ref }
    } else step = { kind: 'refund', fils: amount }

    if (step.kind === 'refund' || step.kind === 'chargeback') {
      if (step.fils > remaining) {
        // The cap refused it. THIS is the branch the property is about, and counting it is what stops the
        // whole suite going vacuous against an uncapped implementation.
        pressed += 1
        reachedCap = true
        continue
      }
      if (step.fils === remaining) reachedCap = true
    }

    if (step.kind === 'refund') {
      position.refundedFils += step.fils
      continue
    }

    if (step.kind === 'chargeback') {
      nextEntry += 1
      const entry = chargebackReceivedEntry(
        {
          entryId: entryId(`PROP-CB-${nextEntry}`) as EntryId,
          entryDate: DAY,
          intentRef: 'intent-under-test',
          disputeRef: step.ref,
          amountFils: step.fils,
        },
        CHART,
      )
      position.entries.push(entry)
      position.receivedEntries.set(step.ref, entry)
      position.disputes.push({ kind: 'received', amountFils: step.fils })
      position.openDisputes.push({ ref: step.ref, fils: step.fils })
      continue
    }

    const received = position.receivedEntries.get(step.ref)
    if (received === undefined) continue
    nextEntry += 1
    const won = chargebackWonEntry(received, NEXT_DAY, {
      entryId: entryId(`PROP-CB-${nextEntry}-R`) as EntryId,
      disputeRef: step.ref,
    })
    position.entries.push(won)
    const open = position.openDisputes.find((d) => d.ref === step.ref)
    position.disputes.push({ kind: 'won', amountFils: open?.fils ?? 0 })
    position.openDisputes = position.openDisputes.filter((d) => d.ref !== step.ref)
  }

  return { position, pressed, reachedCap }
}

describe('a thousand random capture / refund / chargeback / reversal sequences', () => {
  it('leaves debits equal to credits after every step, and refunded never over captured', () => {
    const SEQUENCES = 1_000
    let sequencesThatPressedTheCap = 0
    let totalRefusals = 0
    let entriesChecked = 0

    for (let seed = 1; seed <= SEQUENCES; seed += 1) {
      const random = rng(seed)
      const { position, pressed, reachedCap } = runSequence(random, 6)
      if (reachedCap) sequencesThatPressedTheCap += 1
      totalRefusals += pressed

      // 1. Every entry balances. Asserted per entry rather than over the total, because two unbalanced
      //    entries can sum to a balanced pair — which is how an imbalance survives a trial balance.
      for (const entry of position.entries) {
        entriesChecked += 1
        expect(debitTotalFils(entry.lines), `seed ${seed}: entry ${entry.entryId}`).toBe(
          creditTotalFils(entry.lines),
        )
      }

      // 2. The position is possible. `refunded + chargedBackNet <= captured` is the identity ZY433
      //    states over the rows, and this is the same one over the model.
      const netDisputed = chargedBackNetFils(position.disputes) as number
      expect(
        position.refundedFils + netDisputed,
        `seed ${seed}: refunded ${position.refundedFils} + disputed ${netDisputed} over captured ` +
          `${position.capturedFils}`,
      ).toBeLessThanOrEqual(position.capturedFils)

      // 3. Nothing further is refundable than what remains, and the remainder is never negative.
      const remaining = refundableFils({
        capturedFils: position.capturedFils,
        refundedFils: position.refundedFils,
        chargedBackFils: netDisputed,
      }) as number
      expect(remaining, `seed ${seed}`).toBeGreaterThanOrEqual(0)
      expect(
        isRefundPermitted({
          intentRef: 'intent-under-test',
          state: 'captured',
          capturedFils: position.capturedFils,
          refundedFils: position.refundedFils,
          chargedBackFils: netDisputed,
          requestedFils: remaining + 1,
        }),
        `seed ${seed}: one fil over the remainder must be refused`,
      ).toBe(false)
    }

    // The vacuity floor, MEASURED and not guessed. Over seeds 1..1,000 with six steps each this run
    // observed 764 sequences pressing the cap, 1,210 individual refusals and 2,212 entries built. The
    // floors are 200/200/500 — well under the measured figures, because a floor set just below the
    // observed minimum becomes its own flake (brief rule 22). The generator is seeded, so the figures are
    // the same on every machine; the slack is for the day somebody changes the step count.
    expect(
      sequencesThatPressedTheCap,
      `only ${sequencesThatPressedTheCap} of ${SEQUENCES} sequences reached the cap, so the property ` +
        'would hold for an UNCAPPED implementation. Weight the generator towards the remaining amount.',
    ).toBeGreaterThan(200)
    expect(totalRefusals).toBeGreaterThan(200)
    // And entries were actually built, so assertion 1 is not a loop over an empty list.
    expect(entriesChecked).toBeGreaterThan(500)
    // A control on the control: the generator must also produce sequences that did NOT press the cap,
    // or it is only exercising the refusal.
    expect(sequencesThatPressedTheCap).toBeLessThan(SEQUENCES)
    // Explicit, because 1,000 sequences times six steps on a loaded four-core box is not instant and a
    // correctness test must not carry an implicit performance budget (brief rule 21).
  }, 30_000)

  it('unwinds a won dispute to nought on the clearing account, to the fils', () => {
    // The acceptance line's own words, over the same generator rather than over one hand-picked amount:
    // a won dispute's pair of entries moves nothing net on 1045, whatever the amount was.
    let checked = 0
    for (let seed = 1; seed <= 200; seed += 1) {
      const amount = 1 + Math.floor(rng(seed)() * 99_999)
      const received = chargebackReceivedEntry(
        {
          entryId: entryId(`NET-${seed}`) as EntryId,
          entryDate: DAY,
          intentRef: 'intent-under-test',
          disputeRef: `D-${seed}`,
          amountFils: amount,
        },
        CHART,
      )
      const won = chargebackWonEntry(received, NEXT_DAY, { disputeRef: `D-${seed}` })
      expect(chargebackNetEffectFils([received, won]), `seed ${seed}`).toBe(0)
      checked += 1
    }
    expect(checked).toBe(200)

    // The control, and it is the one that matters: a LOST dispute must NOT net to zero on 1045 — it
    // clears the account the other way, into bad debt. Without this, the assertion above is satisfied by
    // a function that always answers nought.
    const received = chargebackReceivedEntry(
      {
        entryId: entryId('NET-LOST') as EntryId,
        entryDate: DAY,
        intentRef: 'intent-under-test',
        disputeRef: 'D-LOST',
        amountFils: 7_500,
      },
      CHART,
    )
    expect(chargebackNetEffectFils([received])).toBe(7_500)
    const lost = chargebackLostEntry(
      {
        entryId: entryId('NET-LOST-W') as EntryId,
        entryDate: NEXT_DAY,
        intentRef: 'intent-under-test',
        disputeRef: 'D-LOST',
        amountFils: 7_500,
      },
      CHART,
    )
    // A lost dispute also returns 1045 to nought — it has to, or the clearing account accumulates — but
    // by a different route, and the pair is not a reversal.
    expect(chargebackNetEffectFils([received, lost])).toBe(0)
    expect(lost.lines.some((l) => l.account === CHARGEBACK_CLEARING_ACCOUNT)).toBe(true)
    expect(lost.source).toBe('adjustment')
    expect(lost.reverses).toBeNull()
  })
})
