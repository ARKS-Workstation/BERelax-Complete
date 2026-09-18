import { sql } from 'drizzle-orm'
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

export const messageClass = pgEnum('message_class', ['transactional', 'promotional'])
export const messageChannel = pgEnum('message_channel', ['sms', 'email', 'whatsapp'])
export const templateApproval = pgEnum('template_approval', [
  'draft',
  'pending',
  'approved',
  'rejected',
])

/**
 * A message template.
 *
 * `messageClass` lives here rather than on the send call, and a database trigger refuses to change
 * it. A class chosen per send puts the compliance decision at the least reviewed point in the system
 * — inside a loop, at 9pm. See ADR 0016.
 */
export const messageTemplate = pgTable(
  'message_template',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    templateKey: text('template_key').notNull(),
    version: integer('version').notNull(),
    messageClass: messageClass('message_class').notNull(),
    purpose: text('purpose').notNull(),
    isCurrent: boolean('is_current').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [unique('message_template_template_key_version_key').on(t.templateKey, t.version)],
)

/**
 * One row per channel per locale.
 *
 * Adding WhatsApp is an INSERT. That is the whole point of carrying `category`, `approvalState` and
 * `customerCareWindow` before any of them is used: retrofitting them into a flat SMS-shaped table
 * means touching every send path in the system.
 */
export const messageTemplateVariant = pgTable(
  'message_template_variant',
  {
    id: uuid('id').primaryKey().default(sql`uuid_generate_v7()`),
    templateId: uuid('template_id')
      .notNull()
      .references(() => messageTemplate.id, { onDelete: 'cascade' }),
    channel: messageChannel('channel').notNull(),
    locale: text('locale').notNull(),
    /** WhatsApp's own taxonomy. Null for channels that have none. */
    category: text('category'),
    approvalState: templateApproval('approval_state').notNull(),
    /**
     * WhatsApp allows free-form replies only within 24 hours of the customer's last message. Outside
     * it, only an approved template may be sent.
     */
    customerCareWindow: boolean('customer_care_window').notNull(),
    subject: text('subject'),
    body: text('body').notNull(),
    /** Declared variables. A placeholder outside this list fails to render rather than blanking. */
    variables: text('variables').array().notNull(),
    encoding: text('encoding'),
    segments: smallint('segments'),
    costFils: integer('cost_fils'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    unique('message_template_variant_template_id_channel_locale_key').on(
      t.templateId,
      t.channel,
      t.locale,
    ),
    index('message_template_variant_channel_idx').on(t.channel, t.approvalState),
  ],
)
