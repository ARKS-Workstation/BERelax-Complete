/**
 * The mandate service: where the pure gate in `@berelax/core` and the append-only rows in `@berelax/db`
 * meet (Y-PAY-07).
 *
 * ## It constructs no adapter and reaches no gateway, and today it cannot
 *
 * `payment-gateway-adapters-only-through-the-registry` is satisfied rather than exempted: every function
 * here takes the seams it needs as arguments. More to the point, there is nothing to reach —
 * `PENDING['card-gateway']` means no gateway has been chosen, no merchant account exists and no MCC has
 * been assigned, so {@link recordMandateAgreement} records that a mandate exists somewhere else and
 * {@link attemptFeeCharge} refuses before any network call could be made.
 *
 * ## Why the gate is asked TWICE, in two languages
 *
 * {@link attemptFeeCharge} calls `assertFeeChargeable` from `@berelax/core` and then writes a
 * `mandate_charge_attempt` row whose INSERT is judged again by ZY424, ZY425 and ZY426. That is a second
 * statement of one rule and it is deliberate, in the one direction that is safe: the TypeScript gate
 * refuses first so the caller gets a named error it can show somebody, and the database gate refuses
 * whatever the caller did — including a caller that has not been written yet, a repair script, or a
 * `psql` session. A screen's validation is not a refusal; it is a request that the caller be polite.
 *
 * The drift between the two is held shut by `packages/fixtures/src/mandate.itest.ts`, which is the only
 * package that may import both, and the direction it watches is the dangerous one: the database still
 * accepting what the gate had started refusing.
 *
 * ## The attempt is recorded even when it is refused
 *
 * "We tried to charge this customer and the system stopped us" is a fact an operator needs. So the refusal
 * is caught, the attempt is logged with the outcome that names which rule fired, and the error is then
 * rethrown — in that order, because a log written after the rethrow is a log nobody writes.
 */
import {
  assertFeeChargeable,
  type FeeChargePolicy,
  FeeExceedsMandateCap,
  type Instant,
  MandateExpired,
  type MandateRecord,
  MandateRevoked,
  mandateStateAt,
  NoFeePolicyOnFile,
  NoMandateOnFile,
} from '@berelax/core'
import { AppError } from '@berelax/shared'

/**
 * What this service needs from the database, as functions.
 *
 * Declared as a seam rather than imported, which is `CheckoutDeps`'s arrangement one subject along: it
 * keeps `@berelax/payments` free of a `@berelax/db` dependency, and it is what lets the pure tests drive
 * every branch of {@link attemptFeeCharge} without a PostgreSQL.
 */
export interface MandateDeps {
  /** Every mandate on file for this customer, newest agreement first, with its state. */
  readonly mandatesForCustomer: (customerId: string) => Promise<readonly StoredMandate[]>
  /** Records a mandate. Returns its id. ZY422 and ZY423 may refuse. */
  readonly recordMandate: (input: MandateAgreement) => Promise<string>
  /** Inserts the revocation row. Never edits the mandate — ZY421 refuses that. */
  readonly revokeMandate: (input: {
    readonly mandateId: string
    readonly revokedAtIso: string
    readonly revokedBy: 'customer' | 'staff' | 'gateway'
    readonly reason?: string
  }) => Promise<void>
  /** Logs one attempt, refused or not. ZY424, ZY425 and ZY426 may refuse. */
  readonly logChargeAttempt: (input: {
    readonly mandateId: string
    readonly appointmentId: string
    readonly reason: 'no_show' | 'late_cancellation'
    readonly requestedFils: number
    readonly outcome: ChargeOutcome
    readonly attemptedAtIso: string
    readonly tradingDate: string
  }) => Promise<string>
  /** Whether a fee policy is on file, as the DATABASE answers it. */
  readonly feePolicyIsOnFile: () => Promise<boolean>
}

/** A mandate as the rows give it: epoch milliseconds, because `@berelax/db` may not name `Instant`. */
export interface StoredMandate {
  readonly mandateId: string
  readonly customerId: string
  readonly gateway: string
  readonly capFils: number
  readonly wordingVersion: string
  readonly agreedAtMs: number
  readonly expiresAtMs: number
  readonly revokedAtMs: number | null
}

export interface MandateAgreement {
  readonly customerId: string
  readonly gateway: string
  readonly tokenReference: string
  readonly wordingVersion: string
  readonly wordingSha256: string
  readonly capFils: number
  readonly agreedAtIso: string
  readonly expiresAtIso: string
  readonly tradingDate: string
}

/** The four outcomes `mandate_charge_attempt.outcome` admits. Exhaustive, so a caller cannot invent one. */
export const CHARGE_OUTCOMES = [
  'refused_no_policy',
  'refused_cap',
  'refused_not_active',
  'charged',
] as const
export type ChargeOutcome = (typeof CHARGE_OUTCOMES)[number]

/**
 * The outcome each refusal maps to, as a value.
 *
 * A `Map` keyed on the error constructor rather than a chain of `instanceof` in a function body, for one
 * measured reason: a sixth refusal added to `@berelax/core` with no entry here would fall through an
 * `if`-chain to `refused_no_policy` and be logged as the wrong rule, and a missing entry in a map is
 * `undefined` — which {@link outcomeForRefusal} turns into a throw rather than into a plausible default.
 */
const OUTCOME_FOR_REFUSAL = new Map<unknown, ChargeOutcome>([
  [FeeExceedsMandateCap, 'refused_cap'],
  [MandateExpired, 'refused_not_active'],
  [MandateRevoked, 'refused_not_active'],
  [NoFeePolicyOnFile, 'refused_no_policy'],
])

/**
 * The outcome to log for a refusal, or a throw.
 *
 * {@link NoMandateOnFile} is deliberately absent from the map: there is no mandate, so there is no row to
 * hang an attempt off and nothing to log. An attempt against a mandate that does not exist is not an
 * attempt the system made — it is a request that never reached one.
 */
export function outcomeForRefusal(error: unknown): ChargeOutcome {
  const found = OUTCOME_FOR_REFUSAL.get((error as { constructor?: unknown })?.constructor)
  if (found !== undefined) return found
  throw new AppError(
    'invariant_violated',
    'outcomeForRefusal: this refusal has no recorded charge outcome, so the attempt would be logged ' +
      'under the wrong rule. A refusal added to @berelax/core needs an entry in OUTCOME_FOR_REFUSAL in ' +
      'the same commit — a default here would record a cap breach as a missing policy.',
    { details: { refusal: (error as { name?: unknown })?.name ?? typeof error } },
  )
}

/** The mandate the gate should judge, or `null` when the customer has none. Newest agreement wins. */
export function activeMandateAmong(
  stored: readonly StoredMandate[],
  at: Instant,
): MandateRecord | null {
  // Newest FIRST and the first active one wins, rather than "the only active one": a customer may have
  // agreed a second mandate before the first lapsed, and refusing because two are live would refuse a
  // customer for having been asked twice. The repository orders by `agreed_at desc` and this re-sorts
  // rather than trusting it, because an order a caller relies on and does not state is an order a later
  // query changes silently.
  const newestFirst = [...stored].sort((a, b) => b.agreedAtMs - a.agreedAtMs)
  for (const row of newestFirst) {
    const record = mandateRecordFrom(row)
    if (mandateStateAt(record, at) === 'active') return record
  }
  return null
}

/** A stored row as the pure gate's record. Epoch milliseconds are branded on this side of the boundary. */
export function mandateRecordFrom(row: StoredMandate): MandateRecord {
  return {
    mandateId: row.mandateId,
    customerId: row.customerId,
    gateway: row.gateway,
    // The token reference is deliberately NOT carried into the pure record. The gate never needs it, and
    // a field nothing reads is a field that ends up in a log line (ADR 0067).
    tokenReference: '',
    wordingVersion: row.wordingVersion,
    wordingSha256: '',
    capFils: row.capFils,
    agreedAt: row.agreedAtMs as Instant,
    expiresAt: row.expiresAtMs as Instant,
    revokedAt: row.revokedAtMs === null ? null : (row.revokedAtMs as Instant),
  }
}

/** Records that a mandate exists at a gateway. The gateway is not called: there is not one. */
export async function recordMandateAgreement(
  deps: MandateDeps,
  agreement: MandateAgreement,
): Promise<string> {
  return await deps.recordMandate(agreement)
}

/** Revokes a mandate by writing the revocation row. ZY421 refuses an edit to the mandate itself. */
export async function revokeMandateAgreement(
  deps: MandateDeps,
  input: {
    readonly mandateId: string
    readonly revokedAtIso: string
    readonly revokedBy: 'customer' | 'staff' | 'gateway'
    readonly reason?: string
  },
): Promise<void> {
  await deps.revokeMandate(input)
}

export interface FeeChargeAttempt {
  readonly customerId: string
  readonly appointmentId: string
  readonly reason: 'no_show' | 'late_cancellation'
  /**
   * The figure, in fils. **An ARGUMENT, from `cancellationCharge()` or from a policy that does not exist.**
   *
   * This module does not derive it and must not: a fee figure computed in the one place a fee is charged
   * is a fee policy written where nobody would look for one (brief rule 15).
   */
  readonly requestedFils: number
  readonly at: Instant
  readonly tradingDate: string
}

/**
 * Attempts a fee charge. **Refuses every input this build can produce, and records the attempt.**
 *
 * The sequence is: resolve the mandate, ask the pure gate, log what happened, rethrow. The log is written
 * BEFORE the rethrow because a log after a rethrow is a log nobody writes — and it is written through
 * `logChargeAttempt`, whose INSERT is judged again by the database, so a refusal the TypeScript gate
 * somehow missed is refused there instead and the attempt is simply not recorded.
 *
 * It returns `never` in practice today and is typed as returning the attempt id, which is not a
 * contradiction worth removing: the signature is the one a fee policy would need, and narrowing it to
 * `Promise<never>` would make enabling the path a type change in every caller rather than a settings
 * change in one place.
 */
export async function attemptFeeCharge(
  deps: MandateDeps,
  attempt: FeeChargeAttempt,
  policy: FeeChargePolicy,
): Promise<string> {
  const stored = await deps.mandatesForCustomer(attempt.customerId)
  const mandate = activeMandateAmong(stored, attempt.at)

  // The mandate the gate judges and the mandate the attempt is logged against must be the same row, so
  // when there is no ACTIVE one the most recent mandate of any state is what the attempt hangs off. A
  // revoked mandate is still a row; `activeMandateAmong` returning null and `stored` being empty are
  // different facts, and only the second one means there is nothing to log.
  const mostRecent = [...stored].sort((a, b) => b.agreedAtMs - a.agreedAtMs)[0]

  try {
    assertFeeChargeable({
      mandate: mandate ?? (mostRecent === undefined ? null : mandateRecordFrom(mostRecent)),
      customerId: attempt.customerId,
      requestedFils: attempt.requestedFils,
      at: attempt.at,
      policy,
    })
  } catch (error) {
    if (error instanceof NoMandateOnFile || mostRecent === undefined) throw error
    await deps.logChargeAttempt({
      mandateId: mostRecent.mandateId,
      appointmentId: attempt.appointmentId,
      reason: attempt.reason,
      requestedFils: attempt.requestedFils,
      outcome: outcomeForRefusal(error),
      attemptedAtIso: new Date(attempt.at as number).toISOString(),
      tradingDate: attempt.tradingDate,
    })
    throw error
  }

  // Unreachable while `cancellation_fee_policy_on_file()` answers false, and reachable by construction the
  // day it does not. ZY426 is the second gate on this line: a caller that reached here with a policy the
  // database does not have gets the INSERT refused rather than the charge made.
  if (mostRecent === undefined) throw new NoMandateOnFile(attempt.customerId)
  return await deps.logChargeAttempt({
    mandateId: mostRecent.mandateId,
    appointmentId: attempt.appointmentId,
    reason: attempt.reason,
    requestedFils: attempt.requestedFils,
    outcome: 'charged',
    attemptedAtIso: new Date(attempt.at as number).toISOString(),
    tradingDate: attempt.tradingDate,
  })
}
