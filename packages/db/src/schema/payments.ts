import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { account } from './ledger.ts'
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
