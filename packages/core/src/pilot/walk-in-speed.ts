import { WALK_IN_SPEED_BUDGET_MS, WALK_IN_SPEED_PERCENTILE } from '@berelax/shared'

/**
 * The front-desk speed requirement, as arithmetic over measured samples.
 *
 * Pure, and separate from the browser suite that produces the samples, for the reason brief rule 23
 * gives: a wall-clock assertion measures the MACHINE, not the code. The suite cannot be run on every
 * machine and must not be believed on a loaded one, so everything that can be decided without a browser
 * is decided here and has a test — the percentile, the verdict, and above all what happens when there is
 * no measurement at all.
 *
 * ## Why "not measured" is a VERDICT and not a pass
 *
 * `artifacts/pilot/walk-in-speed.json` is a committed report, and the dangerous state for it is a run
 * that produced no samples. A report whose `p95Ms` was `0` would pass the ten-second budget with room to
 * spare; one whose field was absent would read, to anything that checks it, exactly like a report nobody
 * had got round to generating. So {@link walkInSpeedVerdict} answers `not_measured` with the machine it
 * would have been measured on named, and that is a distinct value from `within_budget` — which is
 * ADR 0070's rule applied to a latency instead of a cost.
 *
 * ## Why the percentile is nearest-rank and the floor on the sample count is explicit
 *
 * Nearest-rank (the smallest sample at or above the pth position) rather than an interpolation: an
 * interpolated p95 over twelve samples is a number between two observations that nothing observed, and
 * the claim is about what the desk waited. The sample floor is stated because a p95 over one sample IS
 * that sample: {@link MINIMUM_WALK_IN_SAMPLES} is 20, which is the smallest count at which the 95th
 * percentile is not simply the maximum, and a report with fewer is `not_measured` rather than optimistic.
 */

export const MINIMUM_WALK_IN_SAMPLES = 20

export type WalkInSpeedVerdict =
  | {
      readonly kind: 'within_budget'
      readonly p95Ms: number
      readonly samples: number
      readonly budgetMs: number
    }
  | {
      readonly kind: 'over_budget'
      readonly p95Ms: number
      readonly samples: number
      readonly budgetMs: number
    }
  | {
      readonly kind: 'not_measured'
      readonly samples: number
      readonly budgetMs: number
      readonly reason: string
    }

/**
 * The nearest-rank percentile of a sample set, in milliseconds.
 *
 * Refuses an empty set rather than answering 0, which is the whole subject of this module one level down.
 */
export function percentileMs(samples: readonly number[], percentile: number): number | null {
  if (samples.length === 0) return null
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) return null
  const ordered = [...samples].sort((left, right) => left - right)
  // Nearest rank: ceil(p/100 * n), 1-based, clamped into the set. For n = 20 and p = 95 that is the
  // 19th of 20 — not the maximum, which is what the sample floor exists to guarantee.
  const rank = Math.max(1, Math.ceil((percentile / 100) * ordered.length))
  return ordered[Math.min(rank, ordered.length) - 1] ?? null
}

export function walkInSpeedVerdict(
  samples: readonly number[],
  options: { readonly budgetMs?: number; readonly percentile?: number } = {},
): WalkInSpeedVerdict {
  const budgetMs = options.budgetMs ?? WALK_IN_SPEED_BUDGET_MS
  const percentile = options.percentile ?? WALK_IN_SPEED_PERCENTILE
  if (samples.length < MINIMUM_WALK_IN_SAMPLES) {
    return {
      kind: 'not_measured',
      samples: samples.length,
      budgetMs,
      reason:
        `${samples.length} sample(s), and ${MINIMUM_WALK_IN_SAMPLES} are needed before a ` +
        `${percentile}th percentile is anything but the slowest observation. Reported as not measured ` +
        'rather than as a figure, because a p95 over three bookings would pass or fail on one of them.',
    }
  }
  const p95Ms = percentileMs(samples, percentile)
  if (p95Ms === null) {
    return {
      kind: 'not_measured',
      samples: samples.length,
      budgetMs,
      reason: `the ${percentile}th percentile could not be taken over the samples supplied.`,
    }
  }
  return {
    kind: p95Ms <= budgetMs ? 'within_budget' : 'over_budget',
    p95Ms,
    samples: samples.length,
    budgetMs,
  }
}
