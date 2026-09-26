import {
  type BreakageExposure,
  BreakagePolicyUnanswered,
  breakageExposure,
  type ExpiringPackage,
  filsFrom,
  localDate,
  money,
} from '@berelax/core'
import { type Actor, readExpiredPackages, type Sql, withUnitOfWork } from '@berelax/db'

/**
 * The daily pass over packages whose validity has run out — and it posts NOTHING.
 *
 * That is the whole design and it needs the argument written out, because a job called "package expiry"
 * that writes no journal entry looks like a job somebody forgot to finish.
 *
 * **[UNVERIFIED] Y9-package-policy**, provisionally `retained` and not `forfeited`:
 *
 *   - `forfeited` would mean the salon keeps the money and owes nothing, so the unreleased part of `2050
 *     Deferred revenue — packages` becomes income and expiry IS a journal entry — breakage.
 *   - `retained` means the customer is STILL OWED the treatments. The liability is real. An entry moving
 *     `2050` into revenue would recognise money the business owes, on a VAT box, for a supply that has not
 *     happened — and reversing it when the owner says "of course we honour it" means amending a filed
 *     return.
 *
 * So under the provisional answer **breakage is a measurement and not a posting**, and what this pass
 * produces is that measurement: how much money is sitting in `2050` against entitlements nobody can draw on
 * any more. Which is exactly the figure the owner needs in order to answer Y9-package-policy at all, so the
 * job is not a placeholder for the real one — it is the thing that makes the question answerable.
 *
 * It is NOT a no-op that returns success (docs/12 §1's first prohibition). It reads, it measures, and it
 * writes an `audit_event` carrying the figure, which is what a human or a report reads afterwards. What it
 * does not do is claim to have written off anything.
 *
 * ## A sale sold under `forfeited` terms is refused, loudly
 *
 * `unredeemed_balance_policy` is snapshotted per SALE (0078), so a sale already made keeps the answer it was
 * sold under. `forfeited` is not the default and a sale can only carry it because somebody typed it in — and
 * posting its breakage needs an account that does not exist (`4050` is the VOUCHER account and a package is
 * a different product on the same VAT box) plus an answer to whether forfeited consideration is a supply at
 * all, which neither Y9-package-policy nor Y11-vat-package settles.
 *
 * So the pass raises {@link BreakagePolicyUnanswered} per such sale rather than guessing. It measures the
 * retained ones FIRST and writes the audit row before raising, so one unanswerable sale does not hide the
 * measurement for the rest — and the raise is what puts the question in front of somebody, which a silent
 * skip would not.
 *
 * ## Why it takes its instant as an argument
 *
 * `runPackageExpirySweep(sql, actor, atIso)` and not a clock read inside. The integration suite drives it at
 * the frozen clock and asks the one question a job reading the machine's date cannot be asked: what did the
 * sweep see on a given day. A pass that read `new Date()` would also make its own test's expected figures
 * change tomorrow.
 *
 * The business day is resolved from the instant by the CALLER of `readExpiredPackages` — here, by taking the
 * calendar date of the instant in the business timezone. That is deliberately the *calendar* date and not
 * `resolveTradingDate`: an expiry is a property of a date on a contract, not of a trading session, and
 * `expires_on` is generated from a trading date plus whole months (0078). A sweep that ran at 01:00 and
 * resolved a trading date would ask about yesterday, and report a package that expired at midnight as still
 * live for one more pass.
 */

/** The `agent_definition` this pass reports to. Seeded by 0083; `assertRegistry` refuses a cron without one. */
export const PACKAGE_EXPIRY_AGENT = 'package_expiry'

/** Who the audit row is attributed to. `system`, because no person asked for a nightly measurement. */
export const PACKAGE_EXPIRY_ACTOR: Actor = { kind: 'system', label: 'package.expiry' }

export interface PackageExpirySweepResult {
  /** The business date the sweep asked about, `YYYY-MM-DD`. */
  readonly asAt: string
  readonly exposure: BreakageExposure
  /** Always zero. Read off `exposure` rather than restated, so the two cannot disagree. */
  readonly journalEntriesPosted: 0
  /** The sales that could not be answered, in the order they were found. */
  readonly unanswerable: readonly string[]
}

/**
 * The calendar date of an instant in the business timezone.
 *
 * `Intl` and not string slicing off the ISO: the instant is UTC and the business is at UTC+4, so an
 * 22:00 UTC sweep is already the next day locally and slicing would ask about yesterday. This lives in the
 * worker rather than in `@berelax/core` because core may not touch `Intl` at all
 * (`scripts/check-core-purity.mjs`), and `resolveTradingDate` is the wrong function here for the reason in
 * the header.
 */
function businessDateOf(atIso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dubai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(atIso))
}

export async function runPackageExpirySweep(
  sql: Sql,
  actor: Actor,
  atIso: string,
): Promise<PackageExpirySweepResult> {
  const asAt = businessDateOf(atIso)
  const rows = await readExpiredPackages(sql, asAt)

  const mapped: readonly ExpiringPackage[] = rows.map((row) => ({
    packageSaleId: row.packageSaleId,
    expiresOn: localDate(row.expiresOn),
    unredeemedBalancePolicy: row.unredeemedBalancePolicy,
    soldGross: money(filsFrom(row.soldGrossFils)),
    releasedGross: money(filsFrom(row.releasedFils)),
    unreleasedGross: money(filsFrom(row.unreleasedFils)),
  }))
  // The classification is `@berelax/core`'s and not restated here: the reader already filtered on
  // `expires_on < asAt`, and `breakageExposure` filters again on the same rule plus "something still owed".
  // Two filters of one rule, which is fine because the SECOND one is the statement of it — the SQL filter is
  // an index-usable narrowing and this is the decision.
  const exposure = breakageExposure(mapped, localDate(asAt))

  await withUnitOfWork(sql, actor, async (uow) => {
    await uow.audit.record({
      action: 'package.expiry_swept',
      entityType: 'package_sale',
      // The sweep is about a SET of sales, so it has no single entity. The date is the identity of the
      // pass, which is what a reader looks one up by.
      entityId: asAt,
      operation: 'read',
      after: {
        asAt,
        expired: exposure.expired.length,
        retained: exposure.retainedCount,
        awaitingPolicy: exposure.awaitingPolicy.length,
        unreleasedFils: exposure.unreleasedFils,
        // Stated on the row, not only in a comment: this is the fact a reader of the audit trail needs,
        // and "no entry was posted" is invisible unless something says it.
        journalEntriesPosted: exposure.journalEntriesPosted,
        policy: 'retained (provisional)',
        openQuestion: 'Y9-package-policy',
      },
    })
  })

  const unanswerable = exposure.awaitingPolicy.map((row) => row.packageSaleId)
  if (exposure.awaitingPolicy.length > 0) {
    const [first] = exposure.awaitingPolicy
    if (first !== undefined) {
      // The audit row above is already written and committed, so the measurement survives this throw. That
      // ordering is the point: a raise before the write would lose the figure for every retained sale
      // because of one sale nobody can answer for.
      throw new BreakagePolicyUnanswered(first.packageSaleId, first.unreleasedGross.fils)
    }
  }

  return { asAt, exposure, journalEntriesPosted: exposure.journalEntriesPosted, unanswerable }
}
