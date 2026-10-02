import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The rows behind a card-on-file mandate: record one, revoke one, read its state, log an attempt.
 *
 * **Rows only.** Whether a charge is authorised — on file, unexpired, unrevoked, within its cap, and
 * whether any fee policy exists at all — is `packages/core/src/payments/fee-policy.ts`, because
 * `packages/db` must never import `packages/core` (brief rule 4). So the rule is stated twice, once in
 * each language, and `packages/fixtures/src/mandate.itest.ts` is the one package that may import both and
 * is where the two are held equal. The drift that matters is one direction only: a database still
 * accepting what the TypeScript gate had started refusing, so a test asserting a refusal would be
 * satisfied by the wrong layer.
 *
 * ## There is no update path and no revoke-by-edit, and that is the module
 *
 * `payment_mandate` is append-only (ZY421, every UPDATE and DELETE, for every role including the owner),
 * because the row is EVIDENCE: it says a specific person was shown a specific disclosure and agreed to a
 * specific maximum. {@link revokeMandate} therefore INSERTS a row into `payment_mandate_revocation` and
 * does not touch the mandate — and the function is named for what the business did rather than for what
 * the statement is, because "revoke" is the word an operator uses and `insertMandateRevocation` would hide
 * the one fact a reader needs, which is that nothing is edited.
 *
 * ## No account code and no fee figure appears in this file
 *
 * Deliberately, and `scripts/test-gates.mjs` block 166 plants a literal to prove it: a fee figure written
 * here would be a fee policy stored in a repository, where nobody looking for a policy would find it, and
 * an account code written here would be a second statement of a mapping the chart already holds.
 */

/**
 * Every rule `0134_payment_mandate.sql` refuses by, as the code it raises.
 *
 * Stated HERE and not in the migration's comments, for `DEPOSIT_SQLSTATE`'s reason one subject along: a
 * caller branches on a RULE, and two homes for "the rules this table refuses by" is the arrangement in
 * which a caller checks one list and misses the other.
 */
export const MANDATE_SQLSTATE = {
  /** A mandate, a revocation or a charge attempt was UPDATEd or DELETEd. */
  recordIsAppendOnly: 'ZY421',
  /** The mandate claims an agreement against words that are not on file. */
  wordingIsNotOnFile: 'ZY422',
  /** The stored token reference is card-shaped — a 13-to-19-digit Luhn-valid run. */
  tokenIsCardShaped: 'ZY423',
  /** The attempt asks for more than the cap the customer agreed to. */
  exceedsCap: 'ZY424',
  /** The mandate was expired or revoked at the attempt's own instant. */
  notActiveAtAttempt: 'ZY425',
  /** No cancellation or no-show fee policy is on file, so nothing may be recorded as charged. */
  noFeePolicyOnFile: 'ZY426',
} as const

export type MandateRule = keyof typeof MANDATE_SQLSTATE

const sqlStateOf = (error: unknown): string | null => {
  if (typeof error !== 'object' || error === null) return null
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string') return code
  const carried = (error as { details?: { sqlState?: unknown } }).details?.sqlState
  return typeof carried === 'string' ? carried : null
}

/**
 * A mandate refusal as a typed `AppError`, or null when the error is not one of ours.
 *
 * Matched on the five-character SQLSTATE alone, never on the message and never on the class: the class no
 * longer identifies a file (ADR 0043), so `startsWith('ZY')` would claim other units' refusals as this
 * one's.
 *
 * `notActiveAtAttempt` is `conflict`, `exceedsCap` and `noFeePolicyOnFile` are `validation`, and the rest
 * are `invariant_violated`. The split is the honest one: an absent or withdrawn authority is a state the
 * request collided with, a figure or a missing policy is something an operator asked for and will be told
 * no about, and the rest are states a correct caller cannot produce.
 */
export function mandateError(error: unknown): AppError | null {
  const state = sqlStateOf(error)
  if (state === null) return null
  const known = (Object.entries(MANDATE_SQLSTATE) as [MandateRule, string][]).find(
    ([, code]) => code === state,
  )
  if (known === undefined) return null
  const [rule] = known
  const kind =
    rule === 'notActiveAtAttempt'
      ? ('conflict' as const)
      : rule === 'exceedsCap' || rule === 'noFeePolicyOnFile'
        ? ('validation' as const)
        : ('invariant_violated' as const)
  return new AppError(
    kind,
    error instanceof Error ? error.message : `Mandate rule ${rule} refused the statement`,
    { details: { sqlState: state, rule } },
  )
}

/** Is this error the named mandate refusal? For a caller that branches on one rule. */
export function isMandateRule(error: unknown, rule: MandateRule): boolean {
  return sqlStateOf(error) === MANDATE_SQLSTATE[rule]
}

// ---------------------------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------------------------

/** A mandate and its state NOW, as `payment_mandate_status` reports it. */
export interface MandateStatusRow {
  readonly mandateId: string
  readonly customerId: string
  readonly gateway: string
  readonly capFils: number
  readonly wordingVersion: string
  readonly agreedAtMs: number
  readonly expiresAtMs: number
  readonly revokedAtMs: number | null
  readonly state: string
}

export interface RecordMandateInput {
  readonly customerId: string
  readonly gateway: string
  /** The gateway's opaque handle. ZY423 refuses a card-shaped value. */
  readonly tokenReference: string
  readonly wordingVersion: string
  /** Lowercase hex sha256 of the words shown. ZY422 refuses the hash of the empty string. */
  readonly wordingSha256: string
  readonly capFils: number
  readonly agreedAtIso: string
  readonly expiresAtIso: string
  readonly tradingDate: string
}

/**
 * Records that a mandate exists at a gateway. Returns its id.
 *
 * It takes a `tradingDate` rather than resolving one, which is the arrangement every money write in this
 * build uses: a trading date computed inside a write is a second opinion about which business day the
 * agreement belongs to, and 01:30 belongs to the previous one.
 */
export async function recordMandate(sql: Sql, input: RecordMandateInput): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into payment_mandate (
      customer_id, gateway, token_reference, wording_version, wording_sha256,
      cap_fils, agreed_at, expires_at, trading_date
    ) values (
      ${input.customerId}::uuid, ${input.gateway}, ${input.tokenReference},
      ${input.wordingVersion}, ${input.wordingSha256}, ${input.capFils},
      ${input.agreedAtIso}::timestamptz, ${input.expiresAtIso}::timestamptz,
      ${input.tradingDate}::date
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'recordMandate inserted no row and did not raise.')
  }
  return row.id
}

/**
 * Revokes a mandate by INSERTING the revocation. Nothing is edited.
 *
 * The primary key is the mandate id, so a second revocation is a unique violation rather than a silent
 * overwrite — a mandate cannot be revoked twice, because the second revocation would be a statement about
 * an authority that no longer existed.
 */
export async function revokeMandate(
  sql: Sql,
  input: {
    readonly mandateId: string
    readonly revokedAtIso: string
    readonly revokedBy: 'customer' | 'staff' | 'gateway'
    readonly reason?: string
  },
): Promise<void> {
  await sql`
    insert into payment_mandate_revocation (mandate_id, revoked_at, revoked_by, reason)
    values (
      ${input.mandateId}::uuid, ${input.revokedAtIso}::timestamptz,
      ${input.revokedBy}, ${input.reason ?? null}
    )
  `
}

/**
 * The mandates on file for one customer, newest agreement first, each with its state NOW.
 *
 * The state comes from the VIEW and is not recomputed here. A second computation of it in this file would
 * be the drift ADR 0057 is about: the view reads the dates, and a repository that reasoned about them
 * again would eventually disagree with the trigger that judges an attempt.
 */
export async function mandatesForCustomer(
  sql: Sql,
  customerId: string,
): Promise<readonly MandateStatusRow[]> {
  return await sql<MandateStatusRow[]>`
    select mandate_id                                        as "mandateId",
           customer_id                                       as "customerId",
           gateway,
           cap_fils::bigint                                  as "capFils",
           wording_version                                   as "wordingVersion",
           (extract(epoch from agreed_at) * 1000)::bigint    as "agreedAtMs",
           (extract(epoch from expires_at) * 1000)::bigint   as "expiresAtMs",
           (extract(epoch from revoked_at) * 1000)::bigint   as "revokedAtMs",
           state
      from payment_mandate_status
     where customer_id = ${customerId}::uuid
     order by agreed_at desc
  `
}

export interface ChargeAttemptInput {
  readonly mandateId: string
  readonly appointmentId: string
  readonly reason: 'no_show' | 'late_cancellation'
  readonly requestedFils: number
  /**
   * What the system answered.
   *
   * `charged` is refused by `ZY426` while no fee policy is on file, which is every call today. The caller
   * passes it anyway when that is what it intended, and the refusal is the proof that the path is
   * disabled — a caller that pre-emptively downgraded its own outcome to `refused_no_policy` would make
   * the database rule unreachable and the gate case about it a report on nothing (ADR 0003).
   */
  readonly outcome: 'refused_no_policy' | 'refused_cap' | 'refused_not_active' | 'charged'
  readonly paymentIntentId?: string | null
  readonly attemptedAtIso: string
  readonly tradingDate: string
}

/** Logs one charge attempt, including a refused one. Returns its id. */
export async function logChargeAttempt(sql: Sql, input: ChargeAttemptInput): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into mandate_charge_attempt (
      mandate_id, appointment_id, reason, requested_fils, outcome,
      payment_intent_id, attempted_at, trading_date
    ) values (
      ${input.mandateId}::uuid, ${input.appointmentId}::uuid, ${input.reason},
      ${input.requestedFils}, ${input.outcome},
      ${input.paymentIntentId ?? null}, ${input.attemptedAtIso}::timestamptz,
      ${input.tradingDate}::date
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'logChargeAttempt inserted no row and did not raise.')
  }
  return row.id
}

/**
 * Whether a cancellation or no-show fee policy is on file, as the DATABASE answers it.
 *
 * `false`, from `cancellation_fee_policy_on_file()`. Read rather than assumed so the pairing suite can
 * hold it equal to `PROVISIONAL_FEE_POLICY.onFile` in `@berelax/core` — the two statements of this one
 * fact are in two languages and the drift between them is the one that would let a fee be charged.
 */
export async function feePolicyIsOnFile(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ onFile: boolean }[]>`
    select cancellation_fee_policy_on_file() as "onFile"
  `
  return row?.onFile === true
}

/**
 * How many payment intents and journal entries exist for one appointment.
 *
 * Here rather than in a suite because the acceptance line is "creates zero payment intents and zero
 * journal entries, asserted by row counts", and a count written inline in a test is a count the next test
 * writes differently. Counted in SQL and not by reading rows and taking `.length`, which is
 * `settings-store.itest.ts`'s recorded defect: a capped reader pinned both sides of a subtraction and
 * three recorded changes read as zero.
 */
export async function noShowPostingFootprint(
  sql: Sql,
  appointmentId: string,
): Promise<{ readonly paymentIntents: number; readonly journalEntries: number }> {
  const [row] = await sql<{ intents: string; entries: string }[]>`
    select (
             select count(*) from payment_intent pi
              where pi.reference = ${appointmentId}
           ) as intents,
           (
             select count(*) from journal_entry je
              where je.narrative like ${`%${appointmentId}%`}
           ) as entries
  `
  return {
    paymentIntents: Number(row?.intents ?? 0),
    journalEntries: Number(row?.entries ?? 0),
  }
}
