import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { MergeParticipant } from '../merge-participants.ts'
import { MERGE_PARTICIPANTS } from '../merge-participants.ts'
import { withUnitOfWork } from '../tx.ts'
import { type ConsentLogRead, readConsentLog } from './consent.ts'
import type { MergeCustomersArgs, MergeTableReport } from './merge.ts'
import { MERGE_AUDIT_ACTIONS, mergeCustomers } from './merge.ts'

/**
 * The merge preview (C-CRM-06): what a person is shown before they authorise a merge.
 *
 * ## The whole design in one sentence
 *
 * The preview is the REAL merge, performed inside a transaction that is always rolled back — because a
 * preview computed by a second piece of code that describes what the merge would do is a different answer
 * wearing the same label, and the day the two disagree the screen is a lie and nothing fails.
 *
 * {@link MERGE_UNDER_PREVIEW} is the function this module calls, and it is `mergeCustomers` itself rather
 * than a copy or a re-implementation. `packages/fixtures/src/merge-preview.itest.ts` asserts that BY
 * REFERENCE — `expect(MERGE_UNDER_PREVIEW).toBe(mergeCustomers)` — and not by comparing two behaviours,
 * because two behaviours agreeing today is exactly the evidence a preview that has drifted also produces.
 *
 * ## A preview must not write, and the merge writes before it moves anything
 *
 * 0069's repository inserts `merge_record` BEFORE it re-points a single row — deliberately, because that
 * unique index is where two concurrent merges of one pair serialise. So a preview that reused the merge
 * path naively would tombstone a customer nobody had approved merging: the row would be there, the pair
 * would answer `already_merged` for ever, and the reviewer would never have pressed the button.
 *
 * The separation is therefore NOT "the preview avoids the writes". It is:
 *
 *   1. **Every write happens** — `merge_record`, `merge_record_table`, the re-pointed rows, the copied
 *      consent log, the `audit_event` — inside one transaction, so every CHECK, every trigger and every
 *      unique index fires exactly as it will when the merge is authorised. A preview that skipped the
 *      writes could not report a refusal the database would have raised.
 *   2. **The transaction cannot commit.** The only way out of it carrying an answer is
 *      {@link PreviewRolledBack}, thrown after the state has been read; `sql.begin` rolls back on a throw
 *      and re-raises. There is no code path that returns normally from inside the transaction, which is
 *      what makes the rollback structural rather than remembered.
 *
 * ### What stops the separation rotting
 *
 * Three things, and the first two are what a future editor would have to defeat deliberately:
 *
 *   - **The only `return` inside the transaction body is a `throw`.** Turning the throw into a return
 *      makes the preview COMMIT, which is the one edit that reintroduces the defect. Gate case 95c is
 *      exactly that mutant, and the integration suite's row-count deltas are what go red.
 *   - **This module contains no write statement of its own.** `merge-preview.test.ts` reads this file and
 *      asserts that no `insert`, `update` or `delete` appears in it, with `merge.ts` as the control that
 *      the pattern matches something. So the writes a preview performs can only be the merge's, and a
 *      preview that started doing its own bookkeeping fails a unit test rather than a review.
 *   - **The deltas are measured from inside and asserted from outside.** {@link MergePreview.wouldWrite}
 *      is counted INSIDE the transaction, so a preview that quietly performed no merge reports zeros and
 *      the suite fails; the same counts taken outside afterwards must be unchanged, so a preview that
 *      committed fails too. Neither assertion can pass vacuously on its own.
 *
 * ## What the preview is allowed to read that the merge does not
 *
 * The survivor's consent log, twice: as it is now and as the merge would leave it. That is the reviewer's
 * real question — "what will this person's marketing state be afterwards" — and it is the one thing the
 * merge's own report cannot answer, because `merge_record_table` counts rows and consent is resolved from
 * them by `resolveConsent` in `@berelax/core`, which this package may not import. So the log travels out
 * in `ConsentLogRead`, the shape that function takes, and the screen and the tests fold it themselves.
 *
 * ## One consequence of being the real merge, stated rather than discovered
 *
 * A preview takes the same locks the merge does, for as long as it runs: the `merge_record` insert claims
 * `merge_record_one_merge_per_loser`, and the re-pointed rows are locked until the rollback. So two people
 * previewing ONE pair at the same time serialise — the second waits for the first to roll back, which is
 * milliseconds — and a preview running while somebody authorises that same pair will find the tombstone and
 * answer `already_merged`. Both are the correct answers rather than costs of this design: the alternative is
 * a preview that reads while a merge writes, and reports row counts nobody will see again.
 */

/**
 * The merge function the preview runs. Exported so a test can assert the identity rather than the effect.
 *
 * A `const` alias and not a wrapper: a wrapper would be a second function, and `toBe` against a wrapper
 * proves only that the wrapper is the wrapper. The alias is the assertion's subject and the call below is
 * its only use, so the reference a test checks is the reference that runs.
 */
export const MERGE_UNDER_PREVIEW = mergeCustomers

/** Row counts a preview would have written, measured inside the transaction that then rolled back. */
export interface MergePreviewWrites {
  readonly mergeRecords: number
  readonly mergeRecordTables: number
  readonly auditEvents: number
}

export interface MergePreviewPair {
  readonly survivorCustomerId: string
  readonly loserCustomerId: string
}

export type MergePreview =
  | {
      readonly kind: 'preview'
      readonly survivorCustomerId: string
      readonly loserCustomerId: string
      /** Per participant, what the merge did: before, after, moved, inserted, retained and why. */
      readonly tables: readonly MergeTableReport[]
      /** The survivor's consent log as it stands. The control on the pair below. */
      readonly survivorConsentBefore: ConsentLogRead
      /** The survivor's consent log as the merge would leave it. */
      readonly survivorConsentAfter: ConsentLogRead
      /** What would have been written, counted from inside. Zero anywhere here is a preview that did nothing. */
      readonly wouldWrite: MergePreviewWrites
      /** Always true, and it is a statement about this answer rather than a flag: see the header. */
      readonly rolledBack: true
    }
  | {
      readonly kind: 'already_merged'
      readonly mergeRecordId: string
      readonly survivorCustomerId: string
      readonly loserCustomerId: string
      readonly mergedAtIso: string
    }

/**
 * The only way out of the preview's transaction, and therefore the only way it ends.
 *
 * Carrying the answer on the error rather than assigning it to a variable outside is deliberate: a
 * variable would still be set if the body later returned instead of throwing, and the preview would then
 * report the same answer having COMMITTED it. Here there is no answer without a rollback.
 */
class PreviewRolledBack extends Error {
  constructor(readonly preview: MergePreview) {
    super(PREVIEW_ROLLBACK_MESSAGE)
    this.name = 'PreviewRolledBack'
  }
}

/** Named, so a stray sentinel escaping this module is recognisable rather than a mystery error. */
export const PREVIEW_ROLLBACK_MESSAGE = 'merge preview: rolling back, as every preview does'

async function countRows(sql: Sql, statement: Promise<{ n: string }[]>): Promise<number> {
  void sql
  const [row] = await statement
  return Number(row?.n ?? '0')
}

/**
 * The three counts that say a merge was performed. Taken twice, and subtracted.
 *
 * `audit_event` is append-only and only grows, so a delta is the only honest reading of it (brief rule 9)
 * — and the same is true of `merge_record` by construction. Counted in SQL rather than through any capped
 * reader, for the reason `settings-store.itest.ts` recorded: a limit is right for a panel and wrong for a
 * count.
 */
async function writeCounts(sql: Sql, pair: MergePreviewPair): Promise<MergePreviewWrites> {
  return {
    mergeRecords: await countRows(
      sql,
      sql<{ n: string }[]>`
        select count(*)::text as n from merge_record
         where loser_customer_id = ${pair.loserCustomerId}::uuid
      `,
    ),
    mergeRecordTables: await countRows(
      sql,
      sql<{ n: string }[]>`
        select count(*)::text as n from merge_record_table t
          join merge_record r on r.id = t.merge_record_id
         where r.loser_customer_id = ${pair.loserCustomerId}::uuid
      `,
    ),
    auditEvents: await countRows(
      sql,
      sql<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where action = ${MERGE_AUDIT_ACTIONS.merged} and entity_id = ${pair.loserCustomerId}
      `,
    ),
  }
}

/**
 * Runs the real merge and rolls it back, returning what it did.
 *
 * The arguments are the merge's own ({@link MergeCustomersArgs}), unchanged and not a subset: a preview
 * asked with a different reason, a different actor or a different instant from the merge that follows is a
 * preview of a different operation — `merge_record`'s CHECKs refuse a placeholder actor and a placeholder
 * reason, so a preview that supplied its own would be exercising constraints the real call never sees.
 *
 * A pair that has already been merged comes back as `already_merged` rather than as a preview of nothing:
 * the merge answers that way and the screen has to be able to say so.
 */
export async function previewCustomerMerge(
  sql: Sql,
  args: MergeCustomersArgs,
  participants: readonly MergeParticipant[] = MERGE_PARTICIPANTS,
): Promise<MergePreview> {
  const pair: MergePreviewPair = {
    survivorCustomerId: args.plan.survivorId,
    loserCustomerId: args.plan.loserId,
  }
  try {
    await withUnitOfWork(sql, { kind: args.actorKind, label: args.actorLabel }, async (uow) => {
      const before = await writeCounts(uow.sql, pair)
      const survivorConsentBefore = await readConsentLog(uow.sql, pair.survivorCustomerId)

      const outcome = await MERGE_UNDER_PREVIEW(uow, args, participants)
      if (outcome.kind === 'already_merged') {
        throw new PreviewRolledBack({
          kind: 'already_merged',
          mergeRecordId: outcome.mergeRecordId,
          survivorCustomerId: outcome.survivorCustomerId,
          loserCustomerId: outcome.loserCustomerId,
          mergedAtIso: outcome.mergedAtIso,
        })
      }

      const after = await writeCounts(uow.sql, pair)
      throw new PreviewRolledBack({
        kind: 'preview',
        survivorCustomerId: outcome.survivorCustomerId,
        loserCustomerId: outcome.loserCustomerId,
        tables: outcome.tables,
        survivorConsentBefore,
        survivorConsentAfter: await readConsentLog(uow.sql, outcome.survivorCustomerId),
        wouldWrite: {
          mergeRecords: after.mergeRecords - before.mergeRecords,
          mergeRecordTables: after.mergeRecordTables - before.mergeRecordTables,
          auditEvents: after.auditEvents - before.auditEvents,
        },
        rolledBack: true,
      })
    })
  } catch (error) {
    if (error instanceof PreviewRolledBack) return error.preview
    // Every other error is the merge's own refusal — a `distinct` pair, a tombstoned survivor, a
    // participant whose key no unique index backs — and it belongs to the caller unchanged. A preview
    // that swallowed one would show a screen for a merge the database will not perform.
    throw error
  }
  // Unreachable while the body above throws on both paths, which is the invariant this whole module is
  // built on — so it is stated rather than assumed. A transaction that returned normally has COMMITTED a
  // merge nobody authorised, and saying that out loud is worth more than a comment.
  throw new AppError(
    'invariant_violated',
    'previewCustomerMerge’s transaction completed without throwing its rollback sentinel, which means ' +
      'the merge it performed was COMMITTED. A preview that commits tombstones a customer nobody ' +
      'approved merging: see this module’s header on why the only exit is a throw.',
    { details: { survivorId: args.plan.survivorId, loserId: args.plan.loserId } },
  )
}
