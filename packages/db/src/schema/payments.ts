import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { invoice } from './invoice.ts'
import { account, journalEntry } from './ledger.ts'
import { tenderType } from './payment.ts'

/**
 * The gateway side of taking money: one intent per authorisation attempt, and the append-only rows behind
 * its figures. Mirrors `0106_payment_intent.sql`.
 *
 * ## Not to be confused with `./payment.ts`, which is the other half
 *
 * `payment.ts` holds `tender_type`, `payment` and `refund`: what was TENDERED against an issued invoice,
 * keyed in at the till by somebody holding the money. This file holds what a GATEWAY was asked to do. The
 * two are different tables on purpose and the plural in this filename is the only thing distinguishing
 * them, so it is worth saying which is which: a `payment` row always names a document and always means the
 * money is in hand; a `payment_intent` may name neither, because an authorisation is a reservation and a
 * declined one is money that never moved at all.
 *
 * The vocabulary IS shared, and that is 0105's decision rather than a coincidence: `payment_intent.instrument`
 * is a `tender_type.code`, so there is one map from instrument to posting account for both halves. ZY165
 * additionally refuses an instrument whose `tender_type.adapter` is not `gateway` — an intent for `cash`
 * would authorise money that is already in the drawer, and `finaliseCheckout` has already posted it.
 *
 * ## Nothing writes through Drizzle, and the two things that means here
 *
 * The mirror exists so `pnpm db:drift` can compare it with the database in both directions (ADR 0006). So
 * the three constraints worth a reader's attention are mirrored as `check(...)` for documentation and the
 * five plpgsql refusals are NOT, because a trigger has no Drizzle expression — they are ZY161 to ZY165 and
 * `packages/db/src/repositories/payment-intent.ts` is where a caller meets them as typed errors.
 *
 * `amount_fils` and the three header figures are `mode: 'bigint'` for `payment.amount_fils`'s reason: the
 * driver returns bigint as a string precisely so an amount cannot silently lose precision, and a mirror
 * that re-introduced a JS number here would undo that for the columns a payout reconciliation matches to
 * the fils.
 */
export const paymentIntent = pgTable(
  'payment_intent',
  {
    id: uuid('id').primaryKey(),
    /**
     * The CALLER's key, unique across the table. This is the unique idempotency key on the public surface.
     *
     * The row is inserted — and therefore the key claimed — BEFORE the gateway is called, which is what
     * makes a replay return the first intent without the adapter being reached at all. A key generated on
     * this side could not deduplicate a retry, because the retry would generate a second one.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    /**
     * Which gateway answered. Deliberately not a foreign key: the gateway set is configuration
     * (`PAYMENT_PROVIDER`, read only in `packages/payments/src/registry.ts`), so a table of gateway names
     * would be a second answer to which ones exist — and one a deploy could not change.
     */
    gateway: text('gateway').notNull(),
    /**
     * The gateway's own id, NULL until it answers.
     *
     * A real state and not a gap: an intent whose key was claimed and whose authorisation never returned is
     * exactly what Y-PAY-05 reconciles. A NOT NULL here would have forced the gateway call to happen before
     * the key was claimed, which is the ordering that lets two concurrent callers both authorise.
     *
     * Not unique per gateway. `unique (gateway, gateway_intent_id)` was written, applied and removed: a
     * gateway intent id is unique within a MERCHANT ACCOUNT, no account has been chosen (`Y7-mcc`), and the
     * H02 fake numbers its intents from 1 per process — so the second run of `payment-intent.itest.ts`
     * against one database collided on ids the first run had stored and nothing could delete. The
     * migration's column note has the whole argument and what it means Y-PAY-05 now owns.
     */
    gatewayIntentId: text('gateway_intent_id'),
    /** One of `PAYMENT_INTENT_STATES` in `@berelax/core`; the CHECK mirrors that enum. */
    state: text('state').notNull(),
    /** A `tender_type.code` whose `adapter` is `gateway` (ZY165). */
    instrument: text('instrument')
      .notNull()
      .references(() => tenderType.code),
    /** Snapshotted at authorisation, never joined to afterwards. `payment.posting_account_code`'s rule. */
    postingAccountCode: text('posting_account_code')
      .notNull()
      .references(() => account.code),
    /**
     * What was ASKED for, which is not what was reserved.
     *
     * A declined authorisation reserved nothing and its `authorised_fils` is 0. Without this column a
     * declined intent would be indistinguishable from one nobody ever sent, and "how much did we try to
     * take" is the first question a customer complaint asks.
     */
    requestedFils: bigint('requested_fils', { mode: 'bigint' }).notNull(),
    /**
     * The three figures, each a projection of {@link paymentIntentTransaction} and each held equal to it at
     * COMMIT by ZY163 — MAX over the `authorised` rows, SUM over `captured` and `refunded`.
     *
     * The maximum is not a typo. A gateway increasing a reservation reports the new TOTAL rather than the
     * increment, so summing authorisation rows would double the ceiling every capture is checked against.
     */
    authorisedFils: bigint('authorised_fils', { mode: 'bigint' }).notNull(),
    capturedFils: bigint('captured_fils', { mode: 'bigint' }).notNull(),
    refundedFils: bigint('refunded_fils', { mode: 'bigint' }).notNull(),
    /**
     * The invoice or booking this belongs to. Text and not a key: an intent is authorised before there is a
     * document (a deposit on a booking), so a reference to one would have to be nullable — and a nullable
     * reference to a document that does not exist yet is not the fact this column records.
     */
    reference: text('reference').notNull(),
    /**
     * The append-only row that last moved this intent, and the whole of ADR 0056 in one column.
     *
     * ZY162 requires every UPDATE changing the state or any figure to advance this to a NEW row belonging
     * to this intent. A caller holding nothing but a browser's claim of success has no row to name and
     * therefore cannot move the intent — which is why that rule is in the database rather than in a route
     * handler, where it would be one `if` away from being skipped and the skip would be invisible.
     */
    lastTransactionId: uuid('last_transaction_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('payment_intent_one_intent_per_key').on(table.idempotencyKey),
    check(
      'payment_intent_captured_within_authorised',
      sql`${table.capturedFils} <= ${table.authorisedFils}`,
    ),
    check(
      'payment_intent_refunded_within_captured',
      sql`${table.refundedFils} <= ${table.capturedFils}`,
    ),
    // The one case ZY162's trigger cannot see: a row INSERTed straight into a non-initial state fires no
    // UPDATE, so "an intent that has moved names the row that moved it" is a constraint as well as a rule.
    check(
      'payment_intent_initial_state_has_no_transaction',
      sql`(${table.state} = 'requires_authorisation') = (${table.lastTransactionId} is null)`,
    ),
    index('payment_intent_reference_idx').on(table.reference),
    index('payment_intent_gateway_intent_idx').on(table.gateway, table.gatewayIntentId),
  ],
)

export const paymentIntentTransaction = pgTable(
  'payment_intent_transaction',
  {
    id: uuid('id').primaryKey(),
    paymentIntentId: uuid('payment_intent_id')
      .notNull()
      .references(() => paymentIntent.id),
    /**
     * The gateway's stable event id, unique per intent.
     *
     * A webhook stream is at-least-once, so this is what makes the second delivery of one capture unable to
     * write a second row — the same identity `reduceIntent` in `@berelax/core` deduplicates on, so the
     * stored rows and the folded projection agree by construction rather than by care.
     */
    gatewayEventId: text('gateway_event_id').notNull(),
    /**
     * The event type, which is the row's kind. The CHECK mirrors `PAYMENT_INTENT_EVENTS` in `@berelax/core`.
     *
     * There is a row for EVERY event and not only for the ones that move money, and that is what makes
     * ZY162 total: `action_required` and `authorisation_failed` move an intent's state while moving
     * nothing, so a movements-only table would have left those two transitions with no row to name and the
     * rule with an exemption — which would itself have been a second copy, in plpgsql, of which events move
     * money.
     */
    gatewayEventType: text('gateway_event_type').notNull(),
    /** Strictly positive for the three money events, exactly zero for the other three. */
    amountFils: bigint('amount_fils', { mode: 'bigint' }).notNull(),
    /** The GATEWAY's instant, carried from the event. Never ours, so a rebuilt projection converges. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /**
     * The idempotency key of the call or delivery that produced this row, so an operator can find it in the
     * gateway's own log. Not unique here: one call's snapshot can legitimately carry several events.
     */
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('payment_intent_transaction_one_row_per_event').on(
      table.paymentIntentId,
      table.gatewayEventId,
    ),
    // `INTENT_EVENT_CARRIES_AMOUNT` in `@berelax/core`, as schema. Both directions matter: a zero-fils
    // capture reads as a settled movement for nothing, and a `voided` row with a figure reads as a partial
    // release, which does not exist.
    check(
      'payment_intent_transaction_amount_matches_event',
      sql`case when ${table.gatewayEventType} in ('authorised', 'captured', 'refunded')
               then ${table.amountFils} > 0 else ${table.amountFils} = 0 end`,
    ),
    index('payment_intent_transaction_intent_idx').on(table.paymentIntentId, table.occurredAt),
  ],
)

/**
 * The deposit liability, as the differences that made it. Mirrors `0124_deposit.sql` (Y-PAY-06).
 *
 * In this file rather than in `./payment.ts` for the reason the module note draws: `payment.ts` holds
 * what was TENDERED against an issued document, and a deposit movement is neither a tender nor against a
 * document — a receipt happens before there is one and a refund happens because there will not be one.
 * It sits beside `payment_intent` because that is where the money a deposit is taken with arrives
 * (0106: *"an intent is authorised before there is a document (a deposit on a booking)"*), and
 * `paymentIntentId` is the column that joins the two.
 *
 * The seven CHECK constraints are mirrored for documentation; the six plpgsql refusals are not, because a
 * trigger has no Drizzle expression. They are `ZY301` to `ZY306` and
 * `packages/db/src/repositories/deposit.ts` is where a caller meets them as typed errors.
 *
 * The three fils columns are `mode: 'bigint'` for `payment.amountFils`'s reason: the driver returns bigint
 * as a string precisely so a money figure cannot lose precision in transit, and a mirror that put a JS
 * number back would undo that for the balance a cancellation refunds in full.
 */
export const depositMovement = pgTable(
  'deposit_movement',
  {
    id: uuid('id').primaryKey(),
    /**
     * The ONE appointment this money was taken for. No foreign key, deliberately.
     *
     * `invoice_appointment.appointment_id` carries the same decision for the same reason (0063):
     * PostgreSQL refuses `truncate appointment` while a referencing table is absent from the statement,
     * and four suites truncate it by list — a key here would break all four in teardown, after their
     * assertions had passed.
     */
    appointmentId: uuid('appointment_id').notNull(),
    /** Position in this appointment's own history, from 1. `ZY304` walks it. */
    seq: integer('seq').notNull(),
    /** `DEPOSIT_MOVEMENT_KINDS` in `@berelax/core`. There is no `transferred`; see 0124 §6. */
    kind: text('kind').notNull(),
    /** The WHOLE liability either side of this movement (ADR 0057), with its magnitude beside it. */
    heldBeforeFils: bigint('held_before_fils', { mode: 'bigint' }).notNull(),
    heldAfterFils: bigint('held_after_fils', { mode: 'bigint' }).notNull(),
    amountFils: bigint('amount_fils', { mode: 'bigint' }).notNull(),
    /** Mandatory and a real key: money moving with no entry behind it makes 2045 unexplainable. */
    journalEntryId: text('journal_entry_id')
      .notNull()
      .references(() => journalEntry.entryId),
    /** The document this movement settled. Required for `applied`, refused for the other two. */
    invoiceId: uuid('invoice_id').references(() => invoice.id),
    /** How the money arrived or left. NULL for `applied`: no money moves at an application. */
    tenderKind: text('tender_kind').references(() => tenderType.code),
    paymentIntentId: uuid('payment_intent_id').references(() => paymentIntent.id),
    tradingDate: date('trading_date').notNull(),
    /** The cancellation verdict, on a refund row only. Y-PAY-07 reads it rather than re-deriving it. */
    insideWindow: boolean('inside_window'),
    windowHours: smallint('window_hours'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('deposit_movement_one_row_per_position').on(table.appointmentId, table.seq),
    check('deposit_movement_seq_positive', sql`${table.seq} >= 1`),
    check('deposit_movement_kind_known', sql`${table.kind} in ('received', 'applied', 'refunded')`),
    check('deposit_movement_amount_positive', sql`${table.amountFils} > 0`),
    check(
      'deposit_movement_window_bounded',
      sql`${table.windowHours} is null or ${table.windowHours} between 0 and 168`,
    ),
    // ADR 0057's identity, per row: the closing balance is the opening balance moved by exactly the
    // amount, in the direction the KIND says — never the sign of a column (0018's argument).
    check(
      'deposit_movement_balance_moves_by_its_amount',
      sql`${table.heldAfterFils} = case when ${table.kind} = 'received'
               then ${table.heldBeforeFils} + ${table.amountFils}
               else ${table.heldBeforeFils} - ${table.amountFils} end`,
    ),
    check(
      'deposit_movement_cannot_overdraw',
      sql`${table.kind} = 'received' or ${table.amountFils} <= ${table.heldBeforeFils}`,
    ),
    check(
      'deposit_movement_applied_names_its_document',
      sql`(${table.invoiceId} is not null) = (${table.kind} = 'applied')`,
    ),
    check(
      'deposit_movement_money_moves_only_in_or_out',
      sql`(${table.tenderKind} is not null) = (${table.kind} in ('received', 'refunded'))`,
    ),
    check(
      'deposit_movement_is_not_tendered_as_itself',
      sql`${table.tenderKind} is null or ${table.tenderKind} <> 'deposit_on_account'`,
    ),
    check(
      'deposit_movement_intent_needs_a_tender',
      sql`${table.paymentIntentId} is null or ${table.tenderKind} is not null`,
    ),
    check(
      'deposit_movement_window_is_a_refund_verdict',
      sql`(${table.insideWindow} is null) = (${table.kind} <> 'refunded')
          and (${table.windowHours} is null) = (${table.kind} <> 'refunded')`,
    ),
    index('deposit_movement_appointment_idx').on(table.appointmentId, table.seq.desc()),
    index('deposit_movement_trading_date_idx').on(table.tradingDate, table.kind),
  ],
)

/**
 * The card-on-file mandate: the paperwork, and no instrument. Mirrors `0134_payment_mandate.sql`.
 *
 * There is deliberately no `lastFour`, no `expiryMonth`, no `scheme` and no `bin` column here, and the
 * absence is the point rather than an omission: each of those is a fragment of card data, each is
 * individually defensible, and the set of them is a cardholder data environment this build is not in
 * (ADR 0067). `tokenReference` is the gateway's opaque handle and ZY423 refuses a card-shaped value, which
 * is a trigger and therefore has no Drizzle expression.
 *
 * There is also no `state` column and no `revokedAt`, which is ADR 0057's shape: the state is the view
 * `payment_mandate_status` over the dates and the revocation row. A stored state would read `active` for
 * ever after an expiry, because nothing runs at the instant a mandate lapses.
 */
export const paymentMandate = pgTable(
  'payment_mandate',
  {
    id: uuid('id').primaryKey(),
    customerId: uuid('customer_id').notNull(),
    /** Free text, not an enum: no gateway has been chosen (`PENDING['card-gateway']`). */
    gateway: text('gateway').notNull(),
    /** The gateway's OPAQUE handle. ZY423 refuses a 13-to-19-digit Luhn-valid run. */
    tokenReference: text('token_reference').notNull(),
    /** WHICH disclosure the customer was shown. A version, never the words. */
    wordingVersion: text('wording_version').notNull(),
    /** sha256 of the words shown, lowercase hex. ZY422 refuses the hash of the empty string. */
    wordingSha256: text('wording_sha256').notNull(),
    /** The per-charge maximum the customer agreed to. ZY424 holds every attempt to it. */
    capFils: bigint('cap_fils', { mode: 'bigint' }).notNull(),
    agreedAt: timestamp('agreed_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    tradingDate: date('trading_date').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('payment_mandate_cap_positive', sql`${table.capFils} > 0`),
    check('payment_mandate_expires_after_agreement', sql`${table.expiresAt} > ${table.agreedAt}`),
    index('payment_mandate_customer_idx').on(table.customerId, table.agreedAt.desc()),
  ],
)

/**
 * A revocation, as its own append-only row.
 *
 * The primary key IS the mandate id, so a mandate cannot be revoked twice — a second revocation would be
 * a statement about an authority that no longer existed. It is a separate TABLE rather than a column
 * because `payment_mandate` is append-only (ZY421) and a `revoked_at` column there would be an UPDATE,
 * which is the one thing the evidence rule forbids.
 */
export const paymentMandateRevocation = pgTable('payment_mandate_revocation', {
  mandateId: uuid('mandate_id')
    .primaryKey()
    .references(() => paymentMandate.id),
  revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull(),
  /** `customer`, `staff` or `gateway`. Which one changes what may be said to the customer next. */
  revokedBy: text('revoked_by').notNull(),
  reason: text('reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
})

/**
 * Every attempt to charge a fee against a mandate, including — especially — the ones the database stopped.
 *
 * A refusal with no row is a refusal nothing can count, which is why `refused_no_policy`,
 * `refused_cap` and `refused_not_active` are members of `outcome` rather than an absence of a row.
 * ZY426 is what makes "the charge path ships disabled" a statement PostgreSQL enforces: no row here can
 * read `charged` while `cancellation_fee_policy_on_file()` answers false, which it does.
 */
export const mandateChargeAttempt = pgTable(
  'mandate_charge_attempt',
  {
    id: uuid('id').primaryKey(),
    mandateId: uuid('mandate_id')
      .notNull()
      .references(() => paymentMandate.id),
    /** Plain uuid, NO foreign key — `deposit_movement.appointment_id`'s reason, four suites truncate it. */
    appointmentId: uuid('appointment_id').notNull(),
    /** `no_show` or `late_cancellation`. Judged by different people at different moments. */
    reason: text('reason').notNull(),
    requestedFils: bigint('requested_fils', { mode: 'bigint' }).notNull(),
    outcome: text('outcome').notNull(),
    paymentIntentId: uuid('payment_intent_id').references(() => paymentIntent.id),
    attemptedAt: timestamp('attempted_at', { withTimezone: true }).notNull(),
    tradingDate: date('trading_date').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('mandate_charge_attempt_requested_positive', sql`${table.requestedFils} > 0`),
    check(
      'mandate_charge_attempt_reason_known',
      sql`${table.reason} in ('no_show', 'late_cancellation')`,
    ),
    check(
      'mandate_charge_attempt_outcome_known',
      sql`${table.outcome} in ('refused_no_policy', 'refused_cap', 'refused_not_active', 'charged')`,
    ),
    check(
      'mandate_charge_attempt_intent_is_a_charge',
      sql`(${table.paymentIntentId} is null) = (${table.outcome} <> 'charged')`,
    ),
    index('mandate_charge_attempt_mandate_idx').on(table.mandateId, table.attemptedAt.desc()),
  ],
)

/**
 * A card dispute, as the events that made it. Mirrors `0135_chargeback.sql`.
 *
 * There is deliberately no `resolved` boolean and no `outcome` column on a single row per dispute: a
 * chargeback is a THIRD PARTY'S DECISION ARRIVING LATE, so each notice is its own row with its own
 * `received_at`, its own `trading_date` and its own journal entry. A single mutable row would be an edit
 * to a dated event, which is the one thing this table exists to make impossible.
 *
 * Nothing here writes to `payment_intent`. `captured_fils` is a projection of the append-only transaction
 * rows (ZY163) and the capture HAPPENED, so reducing it would leave the sale's own entry explaining money
 * the header says was never taken.
 *
 * The four refusals that are triggers have no Drizzle expression: ZY431 (append-only), ZY432 (the trading
 * date is the business day containing the instant), ZY433 (refunded plus charged-back-net never exceeds
 * captured), ZY434 (a resolution follows a received dispute, once), ZY435 (nothing to dispute on an
 * uncaptured intent) and ZY436 (a won dispute's entry reverses its received entry, to the fils).
 */
export const chargeback = pgTable(
  'chargeback',
  {
    id: uuid('id').primaryKey(),
    paymentIntentId: uuid('payment_intent_id')
      .notNull()
      .references(() => paymentIntent.id),
    /** The ACQUIRER's identifier, so two notices about one dispute are one dispute. */
    disputeRef: text('dispute_ref').notNull(),
    /** `CHARGEBACK_KINDS` in `@berelax/core`. A total partition, and ZY434 keeps it so. */
    kind: text('kind').notNull(),
    amountFils: bigint('amount_fils', { mode: 'bigint' }).notNull(),
    /** When the NOTICE arrived. What an operator disputes. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    /** The business day it belongs to. ZY432 holds it to `business_day` — the 01:30 rule. */
    tradingDate: date('trading_date').notNull(),
    /** Mandatory and a real key: a dispute with no entry makes 1045 unexplainable. */
    journalEntryId: text('journal_entry_id')
      .notNull()
      .references(() => journalEntry.entryId),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    unique('chargeback_one_row_per_dispute_event').on(table.disputeRef, table.kind),
    check('chargeback_amount_positive', sql`${table.amountFils} > 0`),
    check('chargeback_kind_known', sql`${table.kind} in ('received', 'won', 'lost')`),
    index('chargeback_intent_idx').on(table.paymentIntentId, table.receivedAt),
    index('chargeback_trading_date_idx').on(table.tradingDate, table.kind),
  ],
)
