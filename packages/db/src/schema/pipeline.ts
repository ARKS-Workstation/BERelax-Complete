import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { customer } from './customer.ts'
import { flow } from './flow.ts'

/**
 * Drizzle mirror of 0077_pipeline.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps it honest.
 *
 * Five things the mirror cannot say, and every one of them will bite somebody who builds a write from
 * these definitions rather than calling `packages/db/src/repositories/pipeline.ts`:
 *
 *   - **A stage change is refused unless the move is recorded.** `customer_pipeline_card_records_every_move`
 *     is a DEFERRED constraint trigger: at COMMIT it requires a `pipelineStageTransition` row for exactly
 *     this move — same contact, same from, same to, and `occurredAt` equal to the card's `stageEnteredAt`.
 *     `db.update(customerPipelineCard).set({ stageKey })` typechecks perfectly and raises ZU001 when the
 *     transaction commits, which is the correct outcome: a move is `moveCard`, which writes both rows.
 *   - **Positions are gapless, and the rule is a table-level one.** `displayOrder` is 1..n over every row
 *     including the archived ones; `pipeline_stage_positions_are_gapless` (ZU003) is a deferred constraint
 *     trigger, and the UNIQUE below is `deferrable initially deferred` — which is what lets a reorder pass
 *     through the intermediate states every shuffle has. Neither property is expressible here.
 *   - **`pipelineStageTransition` is append-only.** UPDATE and DELETE raise ZU002 for every role including
 *     the owner, and both are revoked from `berelax_app` along with TRUNCATE.
 *   - **`pipelineStageTransition.customerId` is NOT a foreign key**, and that is 0056's decision for
 *     `consent` rather than an omission: a cascade would fire the refusal trigger and make
 *     `delete from customer` impossible, and the log must outlive the erasure of the identity it is about.
 *     There is therefore no `.references()` on it and there must not be one.
 *   - **A stage key is immutable once a card has entered it.** Every reference to `pipelineStage.stageKey`
 *     is ON UPDATE RESTRICT, because a cascade into the transition log would be an UPDATE on a table that
 *     refuses one.
 *
 * `customerPipelineCard`'s primary key is the customer id ALONE, which is the statement that one person is
 * in one column: two cards for one person are unrepresentable rather than a rule the board has to remember
 * while it renders.
 */

/** The board's columns, in order. The vocabulary is a table for 0053's reason, not an enum. */
export const pipelineStage = pgTable(
  'pipeline_stage',
  {
    stageKey: text('stage_key').primaryKey(),
    /** 1..n over every row, archived ones included. Unique (deferred) and gapless (ZU003). */
    displayOrder: smallint('display_order').notNull(),
    /** What the column means. Required: a stage nobody can define is two stages in one column. */
    description: text('description').notNull(),
    isProvisional: boolean('is_provisional').notNull().default(false),
    openQuestionId: text('open_question_id'),
    provisionalNote: text('provisional_note'),
    /** When the column left the board. The row and its position stay. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    /** The flow entry to this stage enrols the contact on, through `enrolOnLiveVersion`, or null. */
    entryFlowKey: text('entry_flow_key').references(() => flow.flowKey, { onUpdate: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    /** DEFERRED in the SQL, which Drizzle cannot express. A reorder needs it; see the note above. */
    unique('pipeline_stage_display_order_unique').on(t.displayOrder),
    check('pipeline_stage_display_order_is_positive', sql`${t.displayOrder} >= 1`),
    check('pipeline_stage_key_is_lower_snake_case', sql`${t.stageKey} ~ '^[a-z][a-z0-9_]{0,47}$'`),
    check(
      'pipeline_stage_provenance',
      sql`(${t.isProvisional} and ${t.openQuestionId} is not null) or not ${t.isProvisional}`,
    ),
  ],
)

/** Every move of a card between columns. Append-only: see the note above. */
export const pipelineStageTransition = pgTable(
  'pipeline_stage_transition',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** A plain uuid. NOT a foreign key, deliberately — see the note above. */
    customerId: uuid('customer_id').notNull(),
    /** NULL when the card was created in `toStageKey`: there was no column it came from. */
    fromStageKey: text('from_stage_key'),
    toStageKey: text('to_stage_key').notNull(),
    actorKind: text('actor_kind').notNull(),
    actorLabel: text('actor_label').notNull(),
    /** From the caller's clock, never `now()`: an ordering asserted against the server clock is untestable. */
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.fromStageKey],
      foreignColumns: [pipelineStage.stageKey],
      name: 'pipeline_stage_transition_from_stage_key_fkey',
    }).onUpdate('restrict'),
    foreignKey({
      columns: [t.toStageKey],
      foreignColumns: [pipelineStage.stageKey],
      name: 'pipeline_stage_transition_to_stage_key_fkey',
    }).onUpdate('restrict'),
    /** What makes the card's deferred check answerable by exactly one row. */
    unique('pipeline_stage_transition_one_per_instant').on(
      t.customerId,
      t.toStageKey,
      t.occurredAt,
    ),
    index('pipeline_stage_transition_customer_idx').on(t.customerId, t.occurredAt.desc()),
    index('pipeline_stage_transition_stage_idx').on(t.toStageKey, t.occurredAt.desc()),
    check(
      'pipeline_stage_transition_goes_somewhere',
      sql`${t.fromStageKey} is null or ${t.fromStageKey} <> ${t.toStageKey}`,
    ),
    check(
      'pipeline_stage_transition_actor_kind_known',
      sql`${t.actorKind} in ('staff', 'customer', 'system', 'agent')`,
    ),
  ],
)

/** Where one contact is on the board. One row per person: the customer id IS the primary key. */
export const customerPipelineCard = pgTable(
  'customer_pipeline_card',
  {
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'cascade' }),
    stageKey: text('stage_key').notNull(),
    /** Equal to the `occurredAt` of the transition that put the card here. Checked at COMMIT. */
    stageEnteredAt: timestamp('stage_entered_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'customer_pipeline_card_pkey', columns: [t.customerId] }),
    foreignKey({
      columns: [t.stageKey],
      foreignColumns: [pipelineStage.stageKey],
      name: 'customer_pipeline_card_stage_key_fkey',
    }).onUpdate('restrict'),
    index('customer_pipeline_card_stage_idx').on(t.stageKey, t.stageEnteredAt),
  ],
)
