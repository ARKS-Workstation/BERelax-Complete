import { AppError } from '@berelax/shared'
import type { Actor } from '../audit.ts'
import type { Sql } from '../connection.ts'
import type { JournalEntryInput } from '../repositories/journal.ts'
import { postJournalEntry } from '../repositories/journal.ts'
import type { UnitOfWork } from '../tx.ts'
import { withUnitOfWork } from '../tx.ts'

/**
 * The redemption, the transfer that is refused, and the expiry exposure — the three writes M-TILL-10 owns.
 *
 * ## `redeemPackage` draws the balance down and releases the liability
 *
 * The posting arrives as a {@link JournalEntryInput} rather than being built here, `sellPackage`'s and
 * `finaliseCheckout`'s reason: `packages/db` may never import `packages/core`, a posting rule is
 * arithmetic, and `packages/fixtures/src/package-redemption.ts` is the mapping that holds the two halves in
 * step. This file therefore spells no account code at all: `2050`, `4020` and `2030` appear in ZG008's SQL
 * and in `@berelax/core`, and nothing here needs to read one — unlike `sell-package.ts`, which has to name
 * `2050` once because it reads the liability back.
 *
 * What it does NOT take from the caller is the figure. The release is
 * `package_release_through_fils(value, total, redeemed)` — one expression, in `0083_package_redemption.sql`
 * — and this function reads it back out of the database with the balance ROW LOCKED, compares the caller's
 * figure against it, and refuses a disagreement before anything is written. Three reasons, and the third is
 * the one that matters:
 *
 *   1. the caller computed its figure from a balance it read BEFORE the lock, so under concurrency its
 *      `sessionsRedeemed` may already be stale;
 *   2. a caller that never came through `@berelax/core` has no figure worth trusting at all;
 *   3. ZG009 would catch it at COMMIT — and by then the journal entry, the audit row and the outbox event
 *      have all been written for a release that never happened.
 *
 * ## The lock is the concurrency answer, and the CHECK is the backstop
 *
 * `select … for update` on the balance is what makes two parallel redemptions of the last session leave
 * exactly one winner: the second blocks until the first commits, then reads `sessions_redeemed` AFTER it and
 * is refused — by this function's own arithmetic if a session remains to be argued about, and by
 * `package_balance_cannot_overdraw` (0078) if none does. Both, deliberately. Without the lock the two would
 * read the same `sessions_redeemed`, compute the SAME session's share twice, and both succeed: the ceiling
 * would still hold, and the balance would have released one session's share twice and be unable ever to
 * release its last. That is not a hypothetical about locks; it is what the release formula being a function
 * of `sessions_redeemed` makes true.
 *
 * ## `transferPackageBalance` refuses, and the refusal is the feature
 *
 * **[UNVERIFIED] Y9-package-policy** provisionally makes a package NON-transferable, and `transferable` is
 * snapshotted onto the sale, so a transfer is refused by reading the row. The refusal writes an
 * `audit_event` — the acceptance line asks for it, and it is the only evidence a refused attempt leaves,
 * because a refused write leaves no row.
 *
 * It is NOT a database rule and that is a real limitation rather than an omission: a transfer is
 * `update package_sale set customer_id = …`, byte for byte the statement a customer MERGE issues, which
 * 0078 permits for exactly that reason. No trigger can tell the two apart, so a guard in SQL would either
 * refuse the merge it exists to permit or permit the transfer it exists to refuse.
 *
 * It takes a `Sql` rather than a `UnitOfWork` for a reason the acceptance line forces: a refused attempt
 * inside the caller's transaction writes NO audit row, because the throw rolls it back. See the function.
 */

/**
 * The SQLSTATEs `0083_package_redemption.sql` raises.
 *
 * Class 'ZG', continuing 0078's with numbers it does not use. The same class as another file on purpose:
 * 0078 moved off 'ZP' because 0056_consent.sql raises ZP001-ZP003 and two different DOMAINS sharing a class
 * makes one translator answer for the other's refusal. This is the same domain read by the same caller, and
 * these six codes are disjoint from 0078's six — so {@link packageRedemptionError} and `packageError`
 * partition ZG between them and neither can claim the other's code.
 */
export const PACKAGE_REDEMPTION_SQLSTATE = {
  /** A redemption row was UPDATEd or DELETEd. */
  immutableRedemption: 'ZG007',
  /** The entry is not the release posting: wrong day, wrong account, wrong figure. At COMMIT. */
  postingNotTheRelease: 'ZG008',
  /** The balance's drawdown disagrees with its redemptions, or with the release formula. At COMMIT. */
  drawdownDisagrees: 'ZG009',
  /** A redemption dated after the sale's `expires_on`. */
  expired: 'ZG010',
  /** An appointment is both redeemed and stated as a chargeable line on a document. */
  alreadyCharged: 'ZG011',
  /** The payments against a package sale do not equal its price. At COMMIT. */
  paymentsDisagree: 'ZG012',
} as const

/** `23505`: two redemptions of one appointment, or two tenders numbered the same. */
const UNIQUE_VIOLATION = '23505'
/** `23514`: a CHECK refused the row — the two 0078 ceilings and the VAT-above-gross rule live here. */
const CHECK_VIOLATION = '23514'

const sqlState = (err: unknown): string | undefined => {
  const code = (err as { code?: unknown } | null)?.code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } } | null)?.details?.sqlState
  return typeof carried === 'string' ? carried : undefined
}

const constraintOf = (err: unknown): string | undefined => {
  const named = err as { constraint_name?: unknown; constraint?: unknown } | null
  if (typeof named?.constraint_name === 'string') return named.constraint_name
  if (typeof named?.constraint === 'string') return named.constraint
  const carried = (err as { details?: { constraint?: unknown } } | null)?.details?.constraint
  return typeof carried === 'string' ? carried : undefined
}

/**
 * Raised when a treatment is delivered after the package's validity has run out.
 *
 * The acceptance line's error, and it carries what happens to the money because that is part of the answer
 * rather than a footnote: under the provisional `retained` policy the balance stays where it is and the
 * salon still owes it, so the front desk's next move is to ask a manager rather than to tell the customer
 * their money is gone.
 *
 * The wording deliberately shares no phrase with ZG010's in SQL. Both layers refuse this, and when two
 * layers' messages share a phrase, deleting one of them leaves its suite green with the other answering
 * instead — M-TILL-11 measured exactly that and a gate reported a pass over a check that had been removed.
 * This names what the customer is told; ZG010 names what it would do to a VAT return.
 */
export class PackageExpired extends AppError {
  readonly expiresOn: string
  readonly onDate: string
  readonly balanceRetained: boolean
  constructor(expiresOn: string, onDate: string, policy: 'retained' | 'forfeited') {
    const retained = policy === 'retained'
    super(
      'validation',
      `PackageExpired: this package ran out on ${expiresOn} and the treatment is on ${onDate}. ` +
        (retained
          ? 'The unredeemed balance is kept rather than written off, so nothing has been lost and a ' +
            'manager can decide what to honour. [UNVERIFIED] Y9-package-policy.'
          : 'The terms this package was sold under forfeit an unredeemed balance at expiry.'),
      { userFacing: true, details: { expiresOn, onDate, policy, balanceRetained: retained } },
    )
    this.name = 'PackageExpired'
    this.expiresOn = expiresOn
    this.onDate = onDate
    this.balanceRetained = retained
  }
}

/** Raised when the balance named does not exist, or its sale does not. */
export class PackageBalanceUnavailable extends AppError {
  constructor(balanceId: string, why: string) {
    super('validation', `PackageBalanceUnavailable: balance "${balanceId}" ${why}`, {
      userFacing: true,
      details: { balanceId, why },
    })
    this.name = 'PackageBalanceUnavailable'
  }
}

/**
 * Raised when the caller's release figure is not the one the formula gives for the point the LOCKED balance
 * has reached.
 *
 * A separate class from {@link PackageBalanceUnavailable} because the remedy differs: this one is
 * "re-read the balance and try again", which is exactly what a caller whose read lost a race should do.
 */
export class PackageReleaseDisagrees extends AppError {
  readonly expectedFils: number
  readonly offeredFils: number
  constructor(balanceId: string, expectedFils: number, offeredFils: number, at: string) {
    super(
      'conflict',
      `PackageReleaseDisagrees: redeeming ${at} out of balance "${balanceId}" releases ` +
        `${expectedFils} fils and the posting released ${offeredFils}. The release is ` +
        'package_release_through_fils of the balance as it stands now, and the balance may have moved ' +
        'since the posting was built — re-read it and post again.',
      { details: { balanceId, expectedFils, offeredFils, at } },
    )
    this.name = 'PackageReleaseDisagrees'
    this.expectedFils = expectedFils
    this.offeredFils = offeredFils
  }
}

/** Raised when a balance is transferred to another customer while the sale is non-transferable. */
export class PackageNotTransferable extends AppError {
  constructor(packageSaleId: string, fromCustomerId: string, toCustomerId: string) {
    super(
      'forbidden',
      `PackageNotTransferable: package sale ${packageSaleId} was sold non-transferable, so its balance ` +
        `may not move from customer ${fromCustomerId} to ${toCustomerId}. [UNVERIFIED] ` +
        'Y9-package-policy: a movable balance is both a fraud path and a data-protection question ' +
        'nobody has been asked, so the provisional answer is the one that cannot lose the business ' +
        'money. A customer MERGE still re-points the sale, because that is one person and not two.',
      { userFacing: true, details: { packageSaleId, fromCustomerId, toCustomerId } },
    )
    this.name = 'PackageNotTransferable'
  }
}

/**
 * Translates a PostgreSQL error raised by `0083_package_redemption.sql` into an `AppError`, or `null` if it
 * is not one of ours.
 *
 * Exported because three of the six refusals arrive from `COMMIT`, which no function in this module
 * executes. The match is on SQLSTATE only, `packageError`'s reason: matching on the message would make the
 * translation depend on wording, and this is precisely the path where an unrecognised failure gets retried.
 *
 * A caller wraps both translators, in either order — they share a class and no code:
 *
 * ```ts
 * try {
 *   await withUnitOfWork(sql, actor, (uow) => redeemPackage(uow, input))
 * } catch (err) {
 *   throw packageRedemptionError(err) ?? packageError(err) ?? journalError(err) ?? err
 * }
 * ```
 */
export function packageRedemptionError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case PACKAGE_REDEMPTION_SQLSTATE.immutableRedemption:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case PACKAGE_REDEMPTION_SQLSTATE.expired:
    case PACKAGE_REDEMPTION_SQLSTATE.alreadyCharged:
      return new AppError('validation', message, { userFacing: true, details: { sqlState: code } })
    case PACKAGE_REDEMPTION_SQLSTATE.postingNotTheRelease:
    case PACKAGE_REDEMPTION_SQLSTATE.drawdownDisagrees:
    case PACKAGE_REDEMPTION_SQLSTATE.paymentsDisagree:
      // `invariant_violated` and not `validation`: a caller cannot fix any of these by prompting the user
      // differently. Some rule produced a release that does not describe what happened, and the correct
      // response is to fail the transaction.
      return new AppError('invariant_violated', message, { details: { sqlState: code } })
    case UNIQUE_VIOLATION:
      return isAppointmentAlreadyRedeemed(err)
        ? new AppError(
            'conflict',
            'This treatment has already been redeemed against a package. One appointment is one ' +
              `delivery, so it draws down one entitlement. ${message}`,
            { userFacing: true, details: { constraint: constraintOf(err) } },
          )
        : null
    case CHECK_VIOLATION:
      return isBalanceOverdrawn(err)
        ? new AppError(
            'conflict',
            'There are no sessions left on this package, or no value left to release against it. The ' +
              `ceiling is the database's, so a second tap cannot get past it. ${message}`,
            { userFacing: true, details: { constraint: constraintOf(err) } },
          )
        : null
    default:
      return null
  }
}

/** Two redemptions of one appointment. The refusal a double tap at the till gets. */
export function isAppointmentAlreadyRedeemed(err: unknown): boolean {
  return (
    sqlState(err) === UNIQUE_VIOLATION &&
    constraintOf(err) === 'package_redemption_appointment_once'
  )
}

/**
 * The drawdown ceilings, which 0078 declared with the columns.
 *
 * Both names, because a redemption moves both: `package_balance_cannot_overdraw` is the entitlement and
 * `package_balance_cannot_overrelease` is the money, and a caller that recognised only one would report the
 * other as an unknown failure and retry it.
 */
export function isBalanceOverdrawn(err: unknown): boolean {
  const constraint = constraintOf(err)
  return (
    sqlState(err) === CHECK_VIOLATION &&
    (constraint === 'package_balance_cannot_overdraw' ||
      constraint === 'package_balance_cannot_overrelease')
  )
}

// --- the redemption ------------------------------------------------------------------------------

export interface RedeemPackageInput {
  /** The `package_balance` row being drawn down. */
  readonly packageBalanceId: string
  /** The appointment delivered. One appointment, one redemption (`package_redemption_appointment_once`). */
  readonly appointmentId: string
  /** Whole entitlements consumed. One treatment normally consumes one. */
  readonly units: number
  /** The BUSINESS DAY, `YYYY-MM-DD`, resolved with `resolveTradingDate`. Never a calendar date. */
  readonly tradingDate: string
  /** The gross released, from core's `releaseForSessions`. Checked against the LOCKED balance, not trusted. */
  readonly releasedFils: number
  /** The tax inside it, from core's `splitGross`. `net_fils` is generated as the difference. */
  readonly vatFils: number
  /** The rate applied, snapshotted so a rate change cannot restate a filed release. */
  readonly vatRateBp: number
  /** Already balanced by `postEntry`. Mapped field for field from core's `JournalEntry`. */
  readonly journal: JournalEntryInput
}

export interface RedeemedPackage {
  readonly redemptionId: string
  readonly packageSaleId: string
  readonly entryId: string
  readonly releasedFils: number
  readonly netFils: number
  readonly vatFils: number
  /** The balance AFTER this redemption. Read back, never computed here. */
  readonly sessionsRedeemed: number
  readonly sessionsTotal: number
  readonly releasedThroughFils: number
  /** What `2050` still holds for the whole sale after this release. */
  readonly saleUnreleasedFils: number
}

export async function redeemPackage(
  uow: UnitOfWork,
  input: RedeemPackageInput,
): Promise<RedeemedPackage> {
  if (input.journal.source !== 'package_redemption') {
    // `source` is carried rather than inferred from the accounts, `sellPackage`'s reason: a release filed
    // under `sale` would be indistinguishable from a treatment paid for on the day in every report that
    // groups by it — including the one that proves the deferred-revenue balance fell for a reason.
    throw new AppError(
      'validation',
      `redeemPackage was handed a journal entry whose source is "${input.journal.source}". A redemption ` +
        'posts under "package_redemption": a cash treatment and a prepaid one produce revenue on ' +
        'different accounts and are answered differently when a customer asks.',
      { details: { source: input.journal.source } },
    )
  }
  if (!Number.isInteger(input.units) || input.units < 1) {
    throw new AppError(
      'validation',
      `redeemPackage was asked to redeem ${input.units} session(s). A redemption of nothing is not a ` +
        'redemption, and the smallest thing a treatment consumes is one entitlement.',
      { details: { units: input.units } },
    )
  }
  if (input.vatFils < 0 || input.vatFils > input.releasedFils) {
    throw new AppError(
      'validation',
      `redeemPackage was handed ${input.vatFils} fils of VAT inside a release of ` +
        `${input.releasedFils} fils. net_fils is generated as the difference, so a VAT figure above the ` +
        'gross would make the supply negative.',
      { details: { vatFils: input.vatFils, releasedFils: input.releasedFils } },
    )
  }

  /**
   * The balance, LOCKED, and the release the formula gives for the point it has actually reached.
   *
   * `for update` on `package_balance` and nothing else in the join: locking the sale as well would
   * serialise every redemption of every line of one package, and two lines of one course are two
   * entitlements a till may draw on at once. The `for update of b` syntax is what says which.
   *
   * `package_release_through_fils` is called here rather than the arithmetic repeated, and that is the
   * whole point of the function existing: the figure this compares against is the SAME expression ZG009
   * checks at COMMIT, so the two cannot disagree about what a session is worth.
   */
  const [balance] = await uow.sql<
    {
      balanceId: string
      packageSaleId: string
      sessionsTotal: number
      sessionsRedeemed: number
      valueFils: string
      releasedFils: string
      expectedReleaseFils: string
      expectedThroughFils: string
      expiresOn: string
      unredeemedBalancePolicy: 'retained' | 'forfeited'
    }[]
  >`
    select b.id as "balanceId", b.package_sale_id as "packageSaleId",
           b.sessions_total as "sessionsTotal", b.sessions_redeemed as "sessionsRedeemed",
           b.value_fils as "valueFils", b.released_fils as "releasedFils",
           (package_release_through_fils(b.value_fils, b.sessions_total,
                                         least(b.sessions_redeemed + ${input.units}, b.sessions_total))
            - package_release_through_fils(b.value_fils, b.sessions_total, b.sessions_redeemed))
             as "expectedReleaseFils",
           package_release_through_fils(b.value_fils, b.sessions_total,
                                        least(b.sessions_redeemed + ${input.units}, b.sessions_total))
             as "expectedThroughFils",
           s.expires_on::text as "expiresOn",
           s.unredeemed_balance_policy as "unredeemedBalancePolicy"
      from package_balance b
      join package_sale s on s.id = b.package_sale_id
     where b.id = ${input.packageBalanceId}::uuid
       for update of b
  `
  if (balance === undefined) {
    throw new PackageBalanceUnavailable(
      input.packageBalanceId,
      'is not an entitlement this system holds, so there is nothing to draw down.',
    )
  }

  if (balance.sessionsRedeemed + input.units > balance.sessionsTotal) {
    // Refused here as well as by `package_balance_cannot_overdraw`, and the reason is the same one the
    // ceiling exists for: by the time the CHECK fires the journal entry has been written. The CHECK is
    // still what makes it true — this is the message, and that is the rule.
    throw new AppError(
      'conflict',
      `redeemPackage was asked for ${input.units} more session(s) of a balance with ` +
        `${balance.sessionsTotal - balance.sessionsRedeemed} left. There is nothing further to draw on: ` +
        'the customer bought ' +
        `${balance.sessionsTotal} and has taken ${balance.sessionsRedeemed}.`,
      {
        userFacing: true,
        details: {
          balanceId: balance.balanceId,
          sessionsTotal: balance.sessionsTotal,
          sessionsRedeemed: balance.sessionsRedeemed,
          units: input.units,
        },
      },
    )
  }

  // Expiry, against the STORED `expires_on` and the redemption's own business day. No arithmetic: 0078
  // generates the column and a second derivation here would be a second answer about when a customer's
  // money runs out. ZG010 refuses the same thing in SQL, in different words.
  if (input.tradingDate > balance.expiresOn) {
    throw new PackageExpired(balance.expiresOn, input.tradingDate, balance.unredeemedBalancePolicy)
  }

  const expected = Number(balance.expectedReleaseFils)
  if (expected !== input.releasedFils) {
    throw new PackageReleaseDisagrees(
      balance.balanceId,
      expected,
      input.releasedFils,
      `session ${balance.sessionsRedeemed + 1}${input.units > 1 ? `-${balance.sessionsRedeemed + input.units}` : ''} of ${balance.sessionsTotal}`,
    )
  }

  await postJournalEntry(uow, input.journal)

  const [redemption] = await uow.sql<{ id: string; netFils: string }[]>`
    insert into package_redemption (
      package_balance_id, appointment_id, sessions_redeemed, released_fils, vat_fils, vat_rate_bp,
      trading_date, journal_entry_id
    ) values (
      ${input.packageBalanceId}::uuid, ${input.appointmentId}::uuid, ${input.units},
      ${input.releasedFils}, ${input.vatFils}, ${input.vatRateBp}, ${input.tradingDate}::date,
      ${input.journal.entryId}
    )
    returning id, net_fils as "netFils"
  `
  if (redemption === undefined) {
    throw new AppError('invariant_violated', 'package_redemption insert returned no row')
  }

  /**
   * The drawdown. Exactly two columns, which is exactly what `berelax_app` holds UPDATE on (0078).
   *
   * `released_fils = package_release_through_fils(...)` and not `released_fils + ${input.releasedFils}`:
   * setting it from the formula makes the stored figure the formula's by construction rather than by
   * addition, so ZG009's third equality cannot be broken by a caller and an accumulated drift has nowhere
   * to come from. The caller's figure has already been checked against the difference above, so the two
   * statements agree — and if they somehow did not, ZG009 refuses at COMMIT.
   */
  await uow.sql`
    update package_balance
       set sessions_redeemed = sessions_redeemed + ${input.units},
           released_fils = package_release_through_fils(
             value_fils, sessions_total, sessions_redeemed + ${input.units})
     where id = ${input.packageBalanceId}::uuid
  `

  const [after] = await uow.sql<
    { sessionsRedeemed: number; releasedFils: string; saleUnreleasedFils: string }[]
  >`
    select b.sessions_redeemed as "sessionsRedeemed", b.released_fils as "releasedFils",
           x.unreleased_fils as "saleUnreleasedFils"
      from package_balance b
      join package_expiry_exposure x on x.package_sale_id = b.package_sale_id
     where b.id = ${input.packageBalanceId}::uuid
  `
  if (after === undefined) {
    throw new AppError('invariant_violated', 'package_balance update left no row to read')
  }

  await uow.audit.record({
    action: 'package.redeemed',
    entityType: 'package_redemption',
    entityId: redemption.id,
    operation: 'create',
    after: {
      packageBalanceId: input.packageBalanceId,
      packageSaleId: balance.packageSaleId,
      appointmentId: input.appointmentId,
      tradingDate: input.tradingDate,
      units: input.units,
      releasedFils: input.releasedFils,
      netFils: Number(redemption.netFils),
      vatFils: input.vatFils,
      entryId: input.journal.entryId,
      sessionsRedeemed: after.sessionsRedeemed,
      sessionsTotal: balance.sessionsTotal,
    },
  })

  return {
    redemptionId: redemption.id,
    packageSaleId: balance.packageSaleId,
    entryId: input.journal.entryId,
    releasedFils: input.releasedFils,
    netFils: Number(redemption.netFils),
    vatFils: input.vatFils,
    sessionsRedeemed: after.sessionsRedeemed,
    sessionsTotal: balance.sessionsTotal,
    releasedThroughFils: Number(after.releasedFils),
    saleUnreleasedFils: Number(after.saleUnreleasedFils),
  }
}

// --- the transfer that is refused ----------------------------------------------------------------

export interface TransferPackageBalanceInput {
  readonly packageSaleId: string
  readonly toCustomerId: string
  /** Why the front desk is asking. Recorded on the audit row whether it succeeds or not. */
  readonly reason: string
}

export interface TransferredPackage {
  readonly packageSaleId: string
  readonly fromCustomerId: string
  readonly toCustomerId: string
}

/**
 * Moves a package sale to another customer, or refuses.
 *
 * ## It takes a `Sql` and not a `UnitOfWork`, and that is forced rather than a preference
 *
 * The acceptance line is "the refused attempt writes an audit_event", and a refused attempt inside the
 * caller's transaction writes nothing: `withUnitOfWork` wraps the callback in `sql.begin`, so a throw rolls
 * the audit row back with everything else. The first version of this function did exactly that — it wrote
 * the row, then threw, and the row was gone; the itest's delta assertion read zero and is what caught it.
 *
 * So the refusal's evidence is written in its OWN transaction, which commits, and the throw happens after.
 * That means this function owns its transaction boundary, which almost nothing else in `packages/db` does —
 * and it has to, because "the evidence survives the refusal" cannot be a property of code that runs inside
 * the transaction being refused. A caller wrapping this in its own `withUnitOfWork` would defeat it, which
 * is why the signature makes that impossible to do by accident.
 *
 * ## Why it is not a database rule
 *
 * A transfer is `update package_sale set customer_id = …`, byte for byte the statement a customer MERGE
 * issues, which 0078 permits for exactly that reason. No trigger can tell the two apart, so a guard in SQL
 * would either refuse the merge it exists to permit or permit the transfer it exists to refuse. The refusal
 * is therefore this layer's, and `packages/fixtures/src/package-redemption.itest.ts` asserts BOTH halves:
 * the transfer refused, and the merge's own statement still accepted as `berelax_app`.
 *
 * The permitted branch is not dead code: `transferable` is a snapshotted term and a version published after
 * the owner answers Y9-package-policy may well set it true.
 */
export async function transferPackageBalance(
  sql: Sql,
  actor: Actor,
  input: TransferPackageBalanceInput,
): Promise<TransferredPackage> {
  const [sale] = await sql<{ id: string; customerId: string; transferable: boolean }[]>`
    select id, customer_id as "customerId", transferable
      from package_sale where id = ${input.packageSaleId}::uuid
  `
  if (sale === undefined) {
    throw new PackageBalanceUnavailable(
      input.packageSaleId,
      'names no package sale, so there is no balance to move.',
    )
  }
  if (sale.customerId === input.toCustomerId) {
    throw new AppError(
      'validation',
      `transferPackageBalance was asked to move package sale ${input.packageSaleId} to the customer ` +
        'who already holds it. A transfer to the same person is a mis-keyed customer, and writing it ' +
        'would put an audit row on the record of a movement that did not happen.',
      { details: { packageSaleId: input.packageSaleId, toCustomerId: input.toCustomerId } },
    )
  }

  if (!sale.transferable) {
    // Its OWN transaction, which COMMITS, and only then the throw. See the header: the evidence of a
    // refused attempt cannot live inside the transaction that is being refused.
    await withUnitOfWork(sql, actor, async (uow) => {
      await uow.audit.record({
        action: 'package.transfer_refused',
        entityType: 'package_sale',
        entityId: input.packageSaleId,
        operation: 'update',
        before: { customerId: sale.customerId, transferable: false },
        after: {
          attemptedCustomerId: input.toCustomerId,
          reason: input.reason,
          refusedBecause: 'the package was sold non-transferable',
          openQuestion: 'Y9-package-policy',
        },
      })
    })
    throw new PackageNotTransferable(input.packageSaleId, sale.customerId, input.toCustomerId)
  }

  return withUnitOfWork(sql, actor, async (uow) => {
    // Re-read under the row lock inside the transaction that writes: the read above answered "may this
    // move at all", and between the two another transaction may have re-pointed the customer — a merge
    // legitimately does. Writing `input.toCustomerId` over a stale `before` would record a movement from
    // a person who no longer holds it.
    const [locked] = await uow.sql<{ customerId: string; transferable: boolean }[]>`
      select customer_id as "customerId", transferable from package_sale
       where id = ${input.packageSaleId}::uuid for update
    `
    if (locked === undefined || !locked.transferable) {
      throw new PackageNotTransferable(input.packageSaleId, sale.customerId, input.toCustomerId)
    }
    await uow.sql`
      update package_sale set customer_id = ${input.toCustomerId}::uuid
       where id = ${input.packageSaleId}::uuid
    `
    await uow.audit.record({
      action: 'package.transferred',
      entityType: 'package_sale',
      entityId: input.packageSaleId,
      operation: 'update',
      before: { customerId: locked.customerId },
      after: { customerId: input.toCustomerId, reason: input.reason },
    })
    return {
      packageSaleId: input.packageSaleId,
      fromCustomerId: locked.customerId,
      toCustomerId: input.toCustomerId,
    }
  })
}

// --- readers -------------------------------------------------------------------------------------

export interface PackageExposureRow {
  readonly packageSaleId: string
  readonly customerId: string
  readonly soldOn: string
  readonly expiresOn: string
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  readonly soldGrossFils: number
  readonly releasedFils: number
  /** What `2050` still holds for this sale. Under `retained` it is a debt and not breakage. */
  readonly unreleasedFils: number
  readonly sessionsTotal: number
  readonly sessionsRedeemed: number
}

/**
 * The sales whose validity had run out on or before `asAt`, and what is still unreleased against them.
 *
 * `asAt` is an argument and the view reads no clock, for the reason the frozen clock exists: a reader that
 * asked the machine what day it is could not answer "what did the sweep see on the 1st" on the 2nd.
 *
 * `onlyOwing` defaults true, because a fully drawn-down expired package is not exposure — it is a package
 * somebody used. Passing false is what a report listing every expiry needs.
 */
export async function readExpiredPackages(
  sql: Sql,
  asAt: string,
  options: { readonly onlyOwing?: boolean } = {},
): Promise<readonly PackageExposureRow[]> {
  const onlyOwing = options.onlyOwing ?? true
  const rows = await sql<
    {
      packageSaleId: string
      customerId: string
      soldOn: string
      expiresOn: string
      unredeemedBalancePolicy: 'retained' | 'forfeited'
      soldGrossFils: string
      releasedFils: string
      unreleasedFils: string
      sessionsTotal: string
      sessionsRedeemed: string
    }[]
  >`
    select package_sale_id as "packageSaleId", customer_id as "customerId",
           sold_on::text as "soldOn", expires_on::text as "expiresOn",
           unredeemed_balance_policy as "unredeemedBalancePolicy",
           sold_gross_fils as "soldGrossFils", released_fils as "releasedFils",
           unreleased_fils as "unreleasedFils", sessions_total as "sessionsTotal",
           sessions_redeemed as "sessionsRedeemed"
      from package_expiry_exposure
     where expires_on < ${asAt}::date
       and (${!onlyOwing} or unreleased_fils > 0)
     order by expires_on, package_sale_id
  `
  return rows.map((row) => ({
    packageSaleId: row.packageSaleId,
    customerId: row.customerId,
    soldOn: row.soldOn,
    expiresOn: row.expiresOn,
    unredeemedBalancePolicy: row.unredeemedBalancePolicy,
    soldGrossFils: Number(row.soldGrossFils),
    releasedFils: Number(row.releasedFils),
    unreleasedFils: Number(row.unreleasedFils),
    sessionsTotal: Number(row.sessionsTotal),
    sessionsRedeemed: Number(row.sessionsRedeemed),
  }))
}

export interface PackageLiability {
  /** What every package sale took, in total. */
  readonly soldGrossFils: number
  /** What every redemption has released out of `2050`. */
  readonly releasedFils: number
  /** `sold - released`: what the liability should hold. */
  readonly outstandingFils: number
  /** What `2050` actually holds in the LEDGER, as at `asAt`. Read separately, on purpose. */
  readonly ledgerBalanceFils: number
}

/**
 * The identity the acceptance line is about: the deferred-revenue liability equals the sold gross minus the
 * redeemed gross.
 *
 * `outstandingFils` comes from the package ROWS and `ledgerBalanceFils` from `journal_line`, deliberately by
 * two different routes. A reader that derived both from the same place would compare a value to itself and
 * report agreement for a ledger that had never been posted to — which is the defect M-TILL-11 shipped in its
 * expectedFloat control, reported as PASS. The caller asserts they are equal; this function only measures.
 *
 * Scoped to entries whose `source` is a package one, because `2050` is a real account and nothing stops a
 * manual adjustment landing on it: an identity over the whole account would be wrong the first time an
 * accountant posted one, and the claim being made is about what this unit and M-TILL-09 wrote.
 */
export async function readPackageLiability(sql: Sql, asAt: string): Promise<PackageLiability> {
  const [row] = await sql<
    {
      soldGrossFils: string
      releasedFils: string
      ledgerBalanceFils: string
    }[]
  >`
    select
      coalesce((select sum(price_fils) from package_sale where trading_date <= ${asAt}::date), 0)::text
        as "soldGrossFils",
      coalesce((select sum(released_fils) from package_redemption
                 where trading_date <= ${asAt}::date), 0)::text as "releasedFils",
      coalesce((select sum(l.credit_fils - l.debit_fils)
                  from journal_line l
                  join journal_entry e on e.entry_id = l.entry_id
                 where l.account_code = '2050'
                   and e.entry_date <= ${asAt}::date
                   and e.source in ('package_sale', 'package_redemption')), 0)::text
        as "ledgerBalanceFils"
  `
  const sold = Number(row?.soldGrossFils ?? 0)
  const released = Number(row?.releasedFils ?? 0)
  return {
    soldGrossFils: sold,
    releasedFils: released,
    outstandingFils: sold - released,
    ledgerBalanceFils: Number(row?.ledgerBalanceFils ?? 0),
  }
}
