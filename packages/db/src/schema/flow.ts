import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'
import { customer } from './customer.ts'

/**
 * Drizzle mirror of 0070_flow_definition_and_enrolment.sql. SQL-first (ADR 0006); `pnpm db:drift` keeps
 * it honest.
 *
 * Four things the mirror cannot say, and every one of them will bite somebody who builds a write from
 * these definitions rather than calling `packages/db/src/repositories/flow.ts`:
 *
 *   - **`flowDefinition` is append-only.** UPDATE and DELETE are revoked from `berelax_app` AND refused by
 *     a BEFORE trigger for every role including the owner (ZF001). `db.update(flowDefinition)` typechecks
 *     perfectly and raises at run time, which is the correct outcome: an edit is `publishFlowDefinition`
 *     writing version N+1.
 *   - **`flowEnrolment`'s pin is immutable.** `flowId` and `definitionVersion` may not change on an
 *     existing row (ZF002); `status`, `endedAt` and `endedReason` may, because the interpreter has to be
 *     able to finish an enrolment. The type system cannot express "these two columns only".
 *   - **`nodeCount` is GENERATED ALWAYS.** Passing a value for it makes Postgres raise, which is right: it
 *     is `jsonb_array_length(definition -> 'nodes')` and a caller-supplied one would be a second opinion
 *     about a document the row already holds.
 *   - **The live version is `max(version)`, not a column.** There is deliberately no `flow.liveVersion`
 *     to disagree with the rows, and no `status` on a definition: which version is current is derived,
 *     and which versions still GOVERN is answered by the enrolments that pin them.
 *
 * `flowEnrolment.flowId` carries no separate foreign key to `flow`, and that is not an omission: the
 * composite key `flow_enrolment_pins_a_definition_version` already guarantees a version row, and a
 * version row already guarantees its flow. A second constraint on the same column would be a second
 * thing to keep in step.
 */

/** Whether an enrolment is running, finished at an exit node, or was ended early. */
export const flowEnrolmentStatus = pgEnum('flow_enrolment_status', [
  'active',
  'completed',
  'cancelled',
])

/** One automation flow. The definition is not here; every published version of it is a row below. */
export const flow = pgTable(
  'flow',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    /** The stable machine key an enrolment API is called with. UNIQUE. */
    flowKey: text('flow_key').notNull(),
    title: text('title').notNull(),
    /** Defaults to FALSE: publishing a version is drawing a flow, enabling it is a separate decision. */
    isActive: boolean('is_active').notNull().default(false),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('flow_key_unique').on(t.flowKey),
    check('flow_key_is_lower_snake_case', sql`${t.flowKey} ~ '^[a-z][a-z0-9_]{0,63}$'`),
  ],
)

/** One PUBLISHED version of one flow. Immutable: see the note above. */
export const flowDefinition = pgTable(
  'flow_definition',
  {
    flowId: uuid('flow_id')
      .notNull()
      .references(() => flow.id),
    /** Counts an operator's edits from 1. The number an enrolment pins. */
    version: integer('version').notNull(),
    /** `FLOW_DSL_VERSION` in `@berelax/shared`, held to the document's own field by a CHECK. */
    dslVersion: integer('dsl_version').notNull(),
    /** The document, in the canonical sorted-key form `serialiseFlowDefinition` produces. */
    definition: jsonb('definition').notNull(),
    /** GENERATED ALWAYS from the document. Not writable. */
    nodeCount: integer('node_count').notNull(),
    publishedBy: text('published_by').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'flow_definition_pkey', columns: [t.flowId, t.version] }),
    index('flow_definition_published_at_idx').on(t.flowId, t.publishedAt.desc()),
    check('flow_definition_version_is_positive', sql`${t.version} >= 1`),
    check('flow_definition_node_count_within_maximum', sql`${t.nodeCount} between 1 and 60`),
  ],
)

/** One enrolment of one contact on one PINNED version. The pin is the whole point of the table. */
export const flowEnrolment = pgTable(
  'flow_enrolment',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    flowId: uuid('flow_id').notNull(),
    /** NOT NULL, so no reference can quietly follow `max(version)`. Immutable once written (ZF002). */
    definitionVersion: integer('definition_version').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customer.id, { onDelete: 'cascade' }),
    status: flowEnrolmentStatus('status').notNull().default('active'),
    enrolledAt: timestamp('enrolled_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endedReason: text('ended_reason'),
    createdBy: text('created_by').notNull(),
  },
  (t) => [
    /** THE pin: a composite foreign key to the exact version row. */
    foreignKey({
      columns: [t.flowId, t.definitionVersion],
      foreignColumns: [flowDefinition.flowId, flowDefinition.version],
      name: 'flow_enrolment_pins_a_definition_version',
    })
      .onUpdate('restrict')
      .onDelete('restrict'),
    index('flow_enrolment_version_idx').on(t.flowId, t.definitionVersion),
    index('flow_enrolment_customer_idx').on(t.customerId),
    check(
      'flow_enrolment_ended_matches_status',
      sql`(${t.status} = 'active') = (${t.endedAt} is null)`,
    ),
  ],
)
