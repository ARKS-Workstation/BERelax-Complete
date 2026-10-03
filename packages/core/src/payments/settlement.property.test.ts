import { describe, expect, it } from 'vitest'
import { ACCOUNTS, STANDARD_SPA_CHART } from '../ledger/chart-of-accounts.ts'
import { entryId, imbalanceFils } from '../ledger/entry.ts'
import type { Money } from '../money.ts'
import { filsFrom, money } from '../money.ts'
import { reverseChargeOn } from '../tax/reverse-charge.ts'
import type { LocalDate } from '../time.ts'
import { localDate } from '../time.ts'
import type {
  SettlementFile,
  SettlementLine,
  SettlementLineKind,
  SettlementTie,
} from './settlement.ts'
import {
  reconcileSettlementBatch,
  SETTLEMENT_LINE_PAYOUT_SIGN,
  SETTLEMENT_LINE_TIES_LOCALLY,
  settlementBatchEntry,
} from './settlement.ts'

/**
 * The acceptance line as a property: **a settlement reconciles to the fils or it names a variance, over
 * 600 random payout files — and the answer never depends on the order the lines arrived in.**
 *
 * ## Why a property and not a table
 *
 * The failure this is against is not a slip in one shape. A reconciler is a sum over lines of five kinds
 * with two signs, matched by a key that can repeat legitimately (one reference carries a capture line and
 * a tip line), and the mistakes available are order-dependence and a sign applied in one of the two
 * places the totals are computed. Both are invisible in a fixture whose lines happen to be in file order
 * and whose signs happen to cancel. A table of cases contains the shapes somebody thought of.
 *
 * ## The generator is weighted, and the test COUNTS whether it could disagree
 *
 * Brief rule 22's recorded failure: a generator that cannot produce an input the property could fail on
 * makes every run pass over one shape, and the property then holds for a completely broken
 * implementation. Two things here could go vacuous and both are counted:
 *
 * - **a file with fewer than two lines cannot be permuted**, so the order-independence claim is empty for
 *   it. The generator draws three to eight lines and the run counts how many files had at least two.
 * - **a file with no line that TIES locally cannot be perturbed**, so the one-fils claim is empty. The
 *   generator always draws at least one capture and the run counts the perturbable files.
 *
 * The floors below are MEASURED over this generator rather than guessed, and are set well under the
 * observed figures — a floor set just under an observed minimum becomes its own flake.
 */

const CHART = STANDARD_SPA_CHART
const SETTLED_ON: LocalDate = localDate('2099-07-15')

/**
 * Integer FILS, not dirhams.
 *
 * `aedFrom` multiplies by a hundred — it takes major units — and this suite's first draft used it for a
 * fils figure, which made every generated file disagree with its own ties by a factor of a hundred. The
 * property caught it on seed 1, which is the whole reason it exists; the sibling unit suite's fee
 * assertion had the same mistake and did NOT catch it, because it compared the result against the same
 * object it had built.
 */
const inFils = (value: number): Money => money(filsFrom(value))

/** A seeded 32-bit LCG. Deterministic, so a failure names a seed somebody can replay. */
const rng = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 4_294_967_296
  }
}

const TIEING_KINDS: readonly SettlementLineKind[] = ['capture', 'refund', 'chargeback', 'tip']

interface Generated {
  readonly file: SettlementFile
  readonly ties: readonly SettlementTie[]
}

/**
 * One random file whose lines all tie, with the declared net computed from the SIGNS table.
 *
 * The declared net is deliberately computed here, in the test, from `SETTLEMENT_LINE_PAYOUT_SIGN` rather
 * than from the reconciler's own total — so the identity has an independently-derived right-hand side.
 * Reading it off the result would make the property `x === x`.
 */
function generate(seed: number): Generated {
  const random = rng(seed)
  const lines: SettlementLine[] = []
  const ties: SettlementTie[] = []
  const count = 3 + Math.floor(random() * 6)

  // Always one capture, so every file has something the one-fils perturbation can reach.
  const amounts: { kind: SettlementLineKind; reference: string; fils: number }[] = [
    { kind: 'capture', reference: `intent-${seed}-0`, fils: 1_000 + Math.floor(random() * 90_000) },
  ]
  // At MOST one fee line, because a batch carries one processor charge and every fee line carries the
  // batch's OWN reference — so a second one is a legitimate `duplicate_line` refusal rather than a file
  // the property should expect to reconcile. The generator drawing two was this suite's second defect,
  // found on seed 9.
  let feeDrawn = false
  for (let index = 1; index < count; index += 1) {
    const draw = random()
    // Weighted towards the kinds that tie, because a file of nothing but fee lines exercises neither
    // claim — one fee line in roughly six is enough to keep the fee path in the population.
    const wantsFee = draw >= 0.84 && !feeDrawn
    if (wantsFee) feeDrawn = true
    const kind: SettlementLineKind = wantsFee
      ? 'fee'
      : (TIEING_KINDS[Math.floor(random() * TIEING_KINDS.length)] ?? 'capture')
    amounts.push({
      kind,
      reference: kind === 'fee' ? `batch-${seed}` : `intent-${seed}-${index}`,
      fils: 1 + Math.floor(random() * 40_000),
    })
  }

  let declared = 0
  for (const [index, row] of amounts.entries()) {
    lines.push({
      lineNo: index + 1,
      kind: row.kind,
      reference: row.reference,
      amount: inFils(row.fils),
    })
    declared += SETTLEMENT_LINE_PAYOUT_SIGN[row.kind] * row.fils
    if (SETTLEMENT_LINE_TIES_LOCALLY[row.kind]) {
      ties.push({ kind: row.kind, reference: row.reference, localFils: row.fils })
    }
  }

  return {
    file: {
      batchReference: `batch-${seed}`,
      contentSha256: seed.toString(16).padStart(64, '0'),
      settledOn: SETTLED_ON,
      declaredNetFils: declared,
      lines,
    },
    ties,
  }
}

const shuffle = <T>(items: readonly T[], random: () => number): T[] => {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const a = copy[index]
    const b = copy[swap]
    if (a !== undefined && b !== undefined) {
      copy[index] = b
      copy[swap] = a
    }
  }
  return copy
}

describe('settlement reconciliation, as a property', () => {
  it('reconciles every well-formed file, is order-independent, and names a variance for every one-fils change', () => {
    const RUNS = 600
    let permutable = 0
    let perturbable = 0
    let withFee = 0
    let postable = 0

    for (let seed = 1; seed <= RUNS; seed += 1) {
      const { file, ties } = generate(seed)
      const forwards = reconcileSettlementBatch(file, ties)

      // 1. A file every line of which ties, whose declared net is the signed sum, reconciles.
      expect(forwards.reconciled, `seed ${seed} did not reconcile`).toBe(true)
      expect(forwards.identities.declaredVersusLinesFils).toBe(0)

      // 2. Order-independence, over a real permutation.
      if (file.lines.length >= 2) {
        permutable += 1
        const shuffled = shuffle(file.lines, rng(seed + 7_919))
        const backwards = reconcileSettlementBatch({ ...file, lines: shuffled }, ties)
        expect(backwards.identities, `seed ${seed} depends on line order`).toEqual(
          forwards.identities,
        )
        expect(backwards.totals).toEqual(forwards.totals)
      }

      // 3. The entry balances, and reaches no revenue account.
      const feeFils = forwards.totals.fees.fils
      if (feeFils > 0) withFee += 1
      const entry = settlementBatchEntry({
        reconciliation: forwards,
        entryId: entryId(`settlement-prop-${seed}`),
        entryDate: SETTLED_ON,
        chart: CHART,
        ...(feeFils > 0
          ? {
              feeTax: {
                treatment: 'imported_services_reverse_charge' as const,
                reverseCharge: reverseChargeOn(inFils(feeFils), 'recoverable'),
              },
            }
          : {}),
      })
      postable += 1
      expect(imbalanceFils(entry.lines), `seed ${seed} posts an unbalanced entry`).toBe(0)
      for (const row of entry.lines) {
        expect(row.account).not.toBe(ACCOUNTS.tipsPayable)
      }

      // 4. A one-fils change to any line that ties must be NAMED. Not "the batch fails" — the report
      //    has to say which line, which is what the acceptance criterion asks for.
      const target = file.lines.findIndex((row) => SETTLEMENT_LINE_TIES_LOCALLY[row.kind])
      if (target >= 0) {
        perturbable += 1
        const victim = file.lines[target]
        if (victim !== undefined) {
          const altered = reconcileSettlementBatch(
            {
              ...file,
              lines: file.lines.map((row, at) =>
                at === target ? { ...row, amount: inFils(row.amount.fils + 1) } : row,
              ),
            },
            ties,
          )
          expect(altered.reconciled, `seed ${seed} accepted a one-fils change`).toBe(false)
          const named = altered.variances.find(
            (variance) => variance.lineNo === victim.lineNo && variance.kind === 'amount_disagrees',
          )
          expect(named, `seed ${seed} did not name line ${victim.lineNo}`).toBeDefined()
          expect(named?.differenceFils).toBe(1)
        }
      }
    }

    // The vacuity floors, MEASURED over seeds 1..600 with this generator rather than guessed. The run
    // that set them observed 600 permutable, 600 perturbable, 600 postable and 246 carrying a fee line;
    // the floors are well under those, because a floor set just below an observed minimum becomes its
    // own flake (brief rule 22). The generator is deterministic, so these are exact rather than typical.
    expect(permutable, 'no file could be permuted: the order claim is vacuous').toBeGreaterThan(400)
    expect(
      perturbable,
      'no file could be perturbed: the one-fils claim is vacuous',
    ).toBeGreaterThan(400)
    expect(postable, 'no file produced an entry: the balance claim is vacuous').toBeGreaterThan(400)
    expect(
      withFee,
      'no file carried a fee: the reverse-charge path is never exercised',
    ).toBeGreaterThan(120)
    // Six hundred reconciliations, each with a permutation, an entry and a perturbation. About a second
    // alone, and the explicit timeout is brief rule 21: the default 5,000 ms is what a loaded machine
    // takes a correctness test over.
  }, 30_000)
})
