import { type NoShowOutcome, noShowOutcome, PROVISIONAL_FEE_POLICY } from '@berelax/core'
import { feePolicyIsOnFile, noShowPostingFootprint, type Sql } from '@berelax/db'

/**
 * The no-show fee pass (Y-PAY-07). **It charges nothing, and proving that is its whole job.**
 *
 * A job that does nothing is an odd thing to ship, so the reason is worth stating plainly: the shape this
 * unit has to prevent is a fee path that is "disabled" by not existing. An absent mechanism is re-invented
 * by whoever next needs one, in whatever module they happen to be in, with whatever figure seems
 * reasonable that afternoon — and the figure would then be in the books as a decision nobody made. So the
 * mechanism exists, in one place, and it refuses.
 *
 * What a no-show produces under the provisional policy is a FLAG and the figure it was judged against
 * (0049), and nothing else: no payment intent, no invoice, no fee row, no journal entry. The flag itself is
 * B-LIFE-01's `appointment.status = 'no_show'`, written by the front desk through the transition path and
 * not by this job — this job's subject is what happens to MONEY afterwards, which is nothing.
 *
 * ## Why it ASSERTS the zero rather than simply not writing
 *
 * The acceptance line is "a no-show flags the appointment and creates zero payment intents and zero
 * journal entries, asserted by row counts". A job that satisfied that by containing no INSERT would
 * satisfy it vacuously — and would go on satisfying it after somebody added one somewhere else, because
 * nothing was counting. So the pass COUNTS, in SQL, and reports the two figures it found. If either is
 * non-zero the pass has discovered that something in this build is charging for a no-show, which is the
 * one outcome worth waking somebody for.
 *
 * ## Why it checks the database's answer against the pure one
 *
 * `cancellation_fee_policy_on_file()` in migration 0134 and `PROVISIONAL_FEE_POLICY.onFile` in
 * `@berelax/core` are the same fact written twice, in two languages, because SQL cannot read TypeScript. A
 * second statement of a fact drifts, and the direction it would drift in is the dangerous one: a database
 * that had started permitting a charge while the module still refused, so a test asserting the refusal
 * would be satisfied by the wrong layer. The pass reads both and refuses to report a clean run if they
 * disagree.
 */
export interface NoShowFeeResult {
  readonly appointmentId: string
  readonly outcome: NoShowOutcome
  /** What the DATABASE says about the policy. Compared with the module's answer, not trusted over it. */
  readonly feePolicyOnFileInDatabase: boolean
  /** Counted in SQL. Both must be zero under the provisional policy. */
  readonly paymentIntentsFound: number
  readonly journalEntriesFound: number
  /** Non-empty when this pass found something it must not have found. One sentence per finding. */
  readonly findings: readonly string[]
}

export async function runNoShowFeePass(sql: Sql, appointmentId: string): Promise<NoShowFeeResult> {
  const inDatabase = await feePolicyIsOnFile(sql)
  const footprint = await noShowPostingFootprint(sql, appointmentId)
  const outcome = noShowOutcome({ appointmentId, policy: PROVISIONAL_FEE_POLICY })

  const findings: string[] = []

  if (inDatabase !== PROVISIONAL_FEE_POLICY.onFile) {
    findings.push(
      `the database answers cancellation_fee_policy_on_file() = ${inDatabase} and @berelax/core ` +
        `answers ${PROVISIONAL_FEE_POLICY.onFile}. These are the same fact written in two languages ` +
        '(migration 0134 and packages/core/src/payments/fee-policy.ts) and they have drifted. Until they ' +
        'agree, one layer is permitting what the other refuses and no assertion about the fee path means ' +
        'anything.',
    )
  }

  if (footprint.paymentIntents !== 0) {
    findings.push(
      `${footprint.paymentIntents} payment intent(s) exist for appointment ${appointmentId}. Under the ` +
        'provisional policy (Y9-windows: 24h window, no fee charged, flagged only) a no-show posts ' +
        'nothing, so something in this build is attempting to take money for one.',
    )
  }

  if (footprint.journalEntries !== 0) {
    findings.push(
      `${footprint.journalEntries} journal entr(ies) name appointment ${appointmentId}. A no-show ` +
        'recognises nothing and owes nothing, so an entry here is either a fee nobody agreed or a ' +
        'reversal of one.',
    )
  }

  return {
    appointmentId,
    outcome,
    feePolicyOnFileInDatabase: inDatabase,
    paymentIntentsFound: footprint.paymentIntents,
    journalEntriesFound: footprint.journalEntries,
    findings: Object.freeze(findings),
  }
}
