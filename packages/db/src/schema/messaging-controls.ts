import { sql } from 'drizzle-orm'
import { boolean, check, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Drizzle mirror of `packages/db/migrations/0098_messaging_controls.sql` (C-AUTO-05).
 *
 * Hand-written, because migrations are SQL-first (ADR 0006), and kept honest by `pnpm db:drift`, which
 * compares this declaration against the live database in both directions.
 *
 * The rules that are **not** expressible here and therefore live only in the migration:
 *
 *   - `messaging_control_is_answerable_on_insert` / `…_on_update`, the pair of BEFORE triggers that turn the
 *     three CHECKs below into sentences somebody can act on — which key, which role, what was missing;
 *   - `messaging_control_is_undeletable`, the BEFORE DELETE trigger that raises `ZY084`. A DELETE of the
 *     kill-switch row is a DISENGAGEMENT with no direction, no actor and no reason, because no UPDATE
 *     happened for an audit row to hang off. It is the one route to a stopped campaign quietly restarting;
 *   - the `revoke insert, delete, truncate … from berelax_app` that holds the same door one layer earlier.
 *
 * The two seeded rows are part of the migration rather than of `pnpm seed`, so no reader ever needs a default
 * for a missing row — a default in the reader would be a second statement of the switch's state.
 */
export const messagingControl = pgTable(
  'messaging_control',
  {
    /** `marketing_kill_switch` or `promotional_sender_suspended`. There is deliberately no third. */
    controlKey: text('control_key').primaryKey(),
    /**
     * The OPERATOR's decision, and only that.
     *
     * The provisional rule that the kill switch is engaged in every non-production environment is a property
     * of `APP_ENV`, applied by `resolveMarketingKillSwitch` in `@berelax/messaging`. Storing it would let a
     * row switch it off, and would make staging's row disagree with production's for a reason no column
     * explains.
     */
    engaged: boolean('engaged').notNull(),
    changedAt: timestamp('changed_at', { withTimezone: true }).notNull(),
    changedBy: text('changed_by').notNull(),
    /** Refused unless it may toggle: `owner` and `manager`, the two roles holding `settings:write`. */
    changedByRole: text('changed_by_role').notNull(),
    reason: text('reason').notNull(),
    /**
     * `engage` or `disengage`. Derivable from `engaged` and stored anyway, because the pair is what the
     * console renders and what the audit row must agree with; the CHECK ties them so it cannot drift.
     */
    direction: text('direction').notNull(),
  },
  (t) => [
    check(
      'messaging_control_key_is_promotional_only',
      sql`messaging_control_is_promotional_only(${t.controlKey})`,
    ),
    check(
      'messaging_control_role_may_toggle',
      sql`messaging_control_role_may_toggle(${t.changedByRole})`,
    ),
    check('messaging_control_reason_is_stated', sql`btrim(${t.reason}) <> ''`),
    check('messaging_control_changed_by_is_stated', sql`btrim(${t.changedBy}) <> ''`),
    check(
      'messaging_control_direction_matches_state',
      sql`${t.direction} = case when ${t.engaged} then 'engage' else 'disengage' end`,
    ),
    index('messaging_control_engaged_idx').on(t.controlKey).where(sql`${t.engaged}`),
  ],
)
