import { sql } from 'drizzle-orm'
import { boolean, date, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of 0095_vat_return.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Seven things the mirror cannot say, and every one of them will bite somebody who assembles a write from
 * these definitions rather than calling `packages/db/src/services/vat-return-signoff.ts`:
 *
 *   - **All three tables are append-only, for every role including the owner.** BEFORE triggers raise
 *     `ZY051` on UPDATE and DELETE, and `update`/`delete`/`truncate` are revoked from `berelax_app` as
 *     well. `db.update(vatReturn)` typechecks and raises at run time, which is correct: a filed VAT return
 *     is a statement made on a date about a period. A return that was wrong is corrected by a NEW version
 *     naming the one it supersedes and saying why.
 *   - **`content_hash` is not a column you choose.** A CHECK requires it to equal
 *     `encode(sha256(convert_to(snapshot_json, 'UTF8')), 'hex')` — the same value `vat201ContentHash()`
 *     computes in TypeScript over the same bytes — so a hash of anything but the stored bytes cannot be
 *     stored. It holds during a restore with triggers off, and any reader can reproduce it.
 *   - **`period_id`, `starts_on`, `ends_on`, `closed_period_id`, `format_version`, `trial_balance_hash`
 *     and `fileable` are all ALSO inside `snapshot_json`**, and two CHECKs compare each column against its
 *     own value in the hashed bytes. They are columns so a return can be looked up by period without
 *     parsing JSON; they cannot drift from the snapshot, which is the thing duplication usually costs.
 *   - **`fileable = true` is impossible while the snapshot refuses filing.**
 *     `vat_return_fileable_only_when_nothing_in_it_refuses_filing` reads the hashed bytes: a
 *     `notFileableReasons` entry or a box marked `isProvisional` refuses it. Every box is provisional today
 *     (0089, [UNVERIFIED] Y11-vat201-boxes), so the honest answer is always `false` and the row says why.
 *   - **The FIGURES are not a table.** `vat_return_box_figure` and `vat_return_not_fileable_reason` are
 *     VIEWS over `snapshot_json` — they touch `vat_return` and nothing else, so a figure cannot move when
 *     the ledger does. A second copy of a figure would be a second statement of a fact, which drifts, and
 *     nothing in SQL could prove it had not. Views are not mirrored here; `pnpm db:drift` compares BASE
 *     TABLEs only, and the SQL is the authority either way.
 *   - **A sign-off is two DIFFERENT people in a permitted role.** `unique (return_id, signatory_user_id)`
 *     is the storage layer and `ZY052` (`SamePersonSignOff`) is the sentence; `signatory_role` is CHECKed
 *     against `vat_return_signing_roles()` — the one place the permitted set is written down — with `ZY053`
 *     beside it. Deny by default: `manager`, `receptionist`, `therapist`, `marketer`, `auditor` and
 *     `system` are refused by not being in that function.
 *   - **An unsigned return cannot be marked final or read for filing.** `ZY055`, from a BEFORE INSERT
 *     trigger on `vat_return_finalisation` and from `vat_return_for_filing()`, both of which read
 *     `vat_return_sign_off_state()` — the only reader of that question. And every sign-off and finalisation
 *     needs an `audit_event` in the SAME transaction, checked at COMMIT by a `deferrable initially
 *     deferred` constraint trigger (`ZY057`).
 *
 * `snapshotted_at`, `signed_at` and `finalised_at` have NO default, like `consent.recordedAt`,
 * `rights_request.receivedAt` and `publication_record.recordedAt`: they come from an injected clock,
 * because every ordering assertion in this area is made under a frozen one and a column defaulting to
 * `now()` cannot be frozen.
 */

export const vatReturn = pgTable(
  'vat_return',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The identifier an accountant recognises: '2026-08', '2026-Q3'. Never an outbox or audit key. */
    periodId: text('period_id').notNull(),
    startsOn: date('starts_on').notNull(),
    /** The last day OF the period, not the first day after it. */
    endsOn: date('ends_on').notNull(),
    /** 1 for the return as first snapshotted, 2 for the first amendment. An amendment is a NEW ROW. */
    version: integer('version').notNull(),
    /** The version this one replaces. Exactly the rows with `version > 1` carry it (ZY054). */
    supersedesId: uuid('supersedes_id'),
    /** Why it was amended. Required exactly when `supersedes_id` is set, and non-blank. */
    amendmentReason: text('amendment_reason'),
    /**
     * The `period_lock` that covered the period, from `periodStatusOn`.
     *
     * NOT a foreign key. A `period_lock` row can be deleted and a `vat_return` row cannot, so a reference
     * from here would pin every lock it names for ever — 0086's releasable-pin test. The evidence is
     * `trial_balance_hash`, which needs no row to stay true.
     */
    closedPeriodId: text('closed_period_id').notNull(),
    /** The canonical form's own tag, `vat201-wp1`. A future form is INCOMPARABLE, not merely unequal. */
    formatVersion: text('format_version').notNull(),
    /** `vat201_engine_signature()`: the sha256 of the seven engine functions' definitions. */
    engineSignature: text('engine_signature').notNull(),
    /** `period_trial_balance_hash(ends_on)` — M-VAT-06's evidence about the LEDGER, not about this row. */
    trialBalanceHash: text('trial_balance_hash').notNull(),
    /** sha256 of `snapshot_json`, by CHECK. The value `vat201ContentHash()` computes. */
    contentHash: text('content_hash').notNull(),
    /**
     * THE SNAPSHOT: exactly the bytes `canonicaliseVat201WorkingPapers()` produced.
     *
     * `text` and not `jsonb`, because `jsonb` normalises whitespace, drops duplicate keys and reorders, so
     * the bytes read back would not be the bytes that were hashed and `content_hash` could not be checked
     * against them. The views cast to `jsonb` to read it, which changes nothing stored.
     */
    snapshotJson: text('snapshot_json').notNull(),
    /** The paper's own verdict, and it may not be improved on. See the header. */
    fileable: boolean('fileable').notNull(),
    preparedByActorKind: text('prepared_by_actor_kind').notNull(),
    preparedByActorLabel: text('prepared_by_actor_label').notNull(),
    snapshottedAt: timestamp('snapshotted_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('vat_return_period_idx').on(table.periodId, table.version),
    index('vat_return_window_idx').on(table.endsOn, table.startsOn),
    index('vat_return_supersedes_idx').on(table.supersedesId),
  ],
)

export const vatReturnSignOff = pgTable(
  'vat_return_sign_off',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    returnId: uuid('return_id').notNull(),
    /** `preparer` or `reviewer`. One row each per return, and they must be two different people. */
    capacity: text('capacity').notNull(),
    /**
     * Who signed. Not a foreign key to a staff table: the record of a signature outlives the record of the
     * person (0085's reasoning for `rights_request.subject_customer_id`, 0093's for
     * `publication_approval.approver_user_id`).
     */
    signatoryUserId: text('signatory_user_id').notNull(),
    /** Snapshotted at signing, so a later rename cannot rewrite who signed (0026's reason). */
    signatoryDisplayName: text('signatory_display_name').notNull(),
    /** The role they held then, CHECKed against `vat_return_signing_roles()`. Deny by default. */
    signatoryRole: text('signatory_role').notNull(),
    signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('vat_return_sign_off_signatory_idx').on(table.signatoryUserId, table.signedAt),
    index('vat_return_sign_off_return_idx').on(table.returnId, table.capacity),
  ],
)

export const vatReturnFinalisation = pgTable('vat_return_finalisation', {
  id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
  /** One per return, by UNIQUE. Refused by ZY055 unless both capacities have signed. */
  returnId: uuid('return_id').notNull(),
  finalisedAt: timestamp('finalised_at', { withTimezone: true }).notNull(),
  actorKind: text('actor_kind').notNull(),
  actorLabel: text('actor_label').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
