/**
 * The gate's edge wiring: the three real evaluators, assembled from one prefetch, in one place.
 *
 * ## Why this exists, and what it replaces
 *
 * `evaluateGate` asks three questions about stored state — consent, suppression, the frequency cap — and it
 * asks them SYNCHRONOUSLY, because a gate that awaited per message would issue three queries per recipient
 * and a campaign of four thousand would be twelve thousand round trips. So each answer comes from a map
 * prefetched for the recipients the run is about, and each of the three has a builder in `@berelax/core`
 * that closes over one: `consentGateEvaluator` (C-CRM-03), `suppressionGateEvaluator` (C-CRM-04) and
 * `frequencyCapGateEvaluator` (C-AUTO-03).
 *
 * Until this module, assembling those three was the caller's job, and every caller that had not got a
 * recipient list to prefetch for wired three evaluators that THROW — five runtimes, five copies, each with
 * a paragraph explaining which store it was not reading. C-AUTO-03 named this unit as the one that does the
 * wiring: *"the GATE's own `frequencyCapReached` wiring at the application edge is C-AUTO-04's; what this
 * unit supplies is the evaluator and the prefetch"*. This is it, and it wires all three rather than the one,
 * because three builders assembled in one function is the only arrangement in which the ORDER and the
 * failure behaviour cannot differ between two campaign senders.
 *
 * ## Why a missing recipient throws, and why that is the whole design
 *
 * All three builders throw for a recipient their prefetch has no entry for, and `evaluateGate` turns that
 * into `blocked_unevaluable` naming which one. The distinction is between "the store was read and this
 * recipient is clear" and "the store was not read about this recipient at all", and it is the difference
 * between a campaign that works and one that reports a clean run having sent to everybody it knew least
 * about. This function therefore does not fill a gap with a default, and there is no option to.
 *
 * ## What it deliberately does NOT do
 *
 * It does not read the database. The prefetch is the caller's — `readConsentLogs`, `readSuppressionLogs`
 * and the ledger read all live in `@berelax/db`, which this package may not import — and the caller is
 * where the recipient list exists. What this module owns is the assembly: one instant for all three, the
 * purpose validated once, and the cap set and horizon that the ledger read has to agree with.
 */
import {
  type ConsentLog,
  consentGateEvaluator,
  type FrequencyCap,
  frequencyCapGateEvaluator,
  frequencyLedgerHorizonSeconds,
  type Instant,
  instantToIso,
  PROVISIONAL_FREQUENCY_CAPS,
  type SuppressionLog,
  suppressionGateEvaluator,
} from '@berelax/core'
import { AppError } from '@berelax/shared'
import type { GateEvaluators } from './decide.ts'

/** One prefetched read per store, each keyed exactly as `message.recipient` spells it. */
export interface PromotionalGateReads {
  /** From `readConsentLogs`. Plaintext recipient keys; `Map`, so `__proto__` is not an answer. */
  readonly consentLogs: ReadonlyMap<string, ConsentLog>
  /** From `readSuppressionLogs`. Plaintext keys, not the HMAC — see `SuppressionEvaluatorInput`. */
  readonly suppressionLogs: ReadonlyMap<string, SuppressionLog>
  /** From the frequency ledger: every `counted_at` inside the horizon, per recipient. */
  readonly ledgerCountedAt: ReadonlyMap<string, readonly Instant[]>
  /**
   * The earliest instant `ledgerCountedAt` was read from.
   *
   * Required, not optional, and it is the guard against the one silent way a correct cap under-counts: a
   * read whose horizon is newer than the widest cap's window start is missing every send between the two,
   * and the answer looks entirely plausible. `decideFrequencyCap` refuses a horizon that does not reach.
   */
  readonly ledgerReadFrom: Instant
}

export interface GateEvaluatorSources {
  readonly reads: PromotionalGateReads
  /** The consent purpose this run is gated on. Validated once, here, not per message. */
  readonly purpose: string
  /** The instant all three evaluators decide at. One instant, so the three cannot disagree. */
  readonly at: Instant
  /** The caps, read from settings. Defaults to the provisional set (`Y9-frequency-cap`). */
  readonly caps?: readonly FrequencyCap[]
}

/**
 * The three real evaluators over one prefetch.
 *
 * One `at` for all three and not a clock each, which matters more than it looks: consent can expire, a
 * suppression can be withdrawn and a ledger window rolls, so three evaluators reading three instants can
 * answer about three different moments — and the combination that lets a message through is the one where
 * each read happened to be on the permissive side of its own boundary.
 *
 * The ledger horizon is checked HERE as well as inside `decideFrequencyCap`, and the duplication is the
 * point: the refusal inside core arrives per message, on the first promotional send of a run, after the
 * consent and suppression prefetches have already been paid for. Refusing at assembly time makes a short
 * ledger read a configuration error at the place the read was configured.
 */
export function promotionalGateEvaluators(sources: GateEvaluatorSources): GateEvaluators {
  const caps = sources.caps ?? PROVISIONAL_FREQUENCY_CAPS
  const horizonSeconds = frequencyLedgerHorizonSeconds(caps)
  const required = (sources.at - horizonSeconds * 1000) as Instant
  if (sources.reads.ledgerReadFrom > required) {
    throw new AppError(
      'invariant_violated',
      `The frequency ledger was read from ${instantToIso(sources.reads.ledgerReadFrom)}, which does not ` +
        `reach back to ${instantToIso(required)} — the start of the widest cap's window ` +
        `(${horizonSeconds / 86_400} days). Every send between those two instants is missing from the ` +
        'count, so the cap would permit a send it should refuse and nothing about the answer would look ' +
        'wrong. Read from frequencyLedgerHorizonSeconds().',
      {
        details: {
          readFrom: instantToIso(sources.reads.ledgerReadFrom),
          mustReachBackTo: instantToIso(required),
          horizonSeconds,
        },
      },
    )
  }

  return {
    hasConsent: consentGateEvaluator({
      logs: sources.reads.consentLogs,
      purpose: sources.purpose,
      at: sources.at,
    }),
    isSuppressed: suppressionGateEvaluator({
      logs: sources.reads.suppressionLogs,
      at: sources.at,
    }),
    frequencyCapReached: frequencyCapGateEvaluator({
      countedAt: sources.reads.ledgerCountedAt,
      at: sources.at,
      caps,
      countedSince: sources.reads.ledgerReadFrom,
    }),
  }
}
