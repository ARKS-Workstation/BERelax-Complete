import { AppError, type TemplateApprovalState } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The two writes that move a template: its approval state, and its class.
 *
 * Both are refused by the database before they reach here — migration 0061's ZM001, ZM002 and ZM003 —
 * and this module exists to turn those refusals into values a caller can branch on. A screen that has
 * to read a PostgreSQL error message to tell "you cannot approve a draft in one step" from "you cannot
 * edit approved words" is a screen whose behaviour changes when somebody rewords a raise.
 *
 * ## Why the rules are in SQL and the mapping is here, rather than the rules being here
 *
 * The same argument migration 0056 makes about its CHECKs and 0057 about its allowlist. A rule in this
 * module is reachable only by callers that come through it, and the writers that matter most are the
 * ones that do not: a data migration, a restored dump, a psql session at 2am, and the admin surface
 * somebody writes next year. A trigger is reachable by all of them. The cost is an error message with
 * no context, and this module is what supplies the context.
 *
 * ## What is deliberately NOT here
 *
 * A reader. `readCurrentTemplate` in `../seed/templates.ts` is the one, and a second query for the same
 * rows would be two readings of "which words are current" — which is the defect this whole unit is
 * about, in a different column.
 */

/** The SQLSTATEs migration 0061 raises. A caller branches on these, never on prose. */
export const TEMPLATE_SQLSTATE = {
  /** An UPDATE tried to change `message_template.message_class`. */
  classImmutable: 'ZM001',
  /** An approval state moved along an edge the state machine does not have. */
  approvalTransition: 'ZM002',
  /** An approved variant's words, channel, locale or care-window flag changed while approved. */
  approvedWordsFrozen: 'ZM003',
  /** A `message` row's class disagrees with the template version it points at. */
  messageClassMismatch: 'ZM004',
} as const

export type TemplateSqlstate = (typeof TEMPLATE_SQLSTATE)[keyof typeof TEMPLATE_SQLSTATE]

/** Every reason one of these writes is refused, as a value. */
export const TEMPLATE_REFUSALS = [
  'template_variant_not_found',
  'template_approval_transition_refused',
  'template_approved_words_frozen',
  'template_not_found',
  'template_already_that_class',
] as const
export type TemplateRefusal = (typeof TEMPLATE_REFUSALS)[number]

const sqlstateOf = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

/** The named refusal carried on an error this module raised, or null. */
export function templateRefusalOf(err: unknown): TemplateRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' && (TEMPLATE_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as TemplateRefusal)
    : null
}

function refuse(
  refusal: TemplateRefusal,
  message: string,
  details: Record<string, unknown>,
): never {
  throw new AppError(refusal === 'template_variant_not_found' ? 'not_found' : 'conflict', message, {
    details: { ...details, refusal },
  })
}

export interface ApprovalChange {
  readonly templateId: string
  readonly channel: string
  readonly locale: string
  readonly to: TemplateApprovalState
}

/**
 * Moves one variant's approval state, or refuses.
 *
 * Deliberately not an "approve" and a "reject" and a "submit": one write, one column, and the edge set
 * lives in `template_approval_transition_allowed`. Three named methods would be three places for the
 * fourth edge to be forgotten.
 */
export async function setTemplateApproval(
  sql: Sql,
  change: ApprovalChange,
): Promise<TemplateApprovalState> {
  try {
    const [row] = await sql<{ approval_state: TemplateApprovalState }[]>`
      update message_template_variant
         set approval_state = ${change.to}::template_approval
       where template_id = ${change.templateId}
         and channel = ${change.channel}::message_channel
         and locale = ${change.locale}
      returning approval_state
    `
    if (row === undefined) {
      refuse(
        'template_variant_not_found',
        `No ${change.channel}/${change.locale} variant of template ${change.templateId} to approve.`,
        { change },
      )
    }
    return row.approval_state
  } catch (error) {
    if (sqlstateOf(error) === TEMPLATE_SQLSTATE.approvalTransition) {
      refuse(
        'template_approval_transition_refused',
        `A template variant may not move to '${change.to}' from the state it is in. Nothing reaches ` +
          'approved except from pending, so a draft cannot be approved in one step and a rejection ' +
          'cannot be approved without being re-authored first.',
        { change, sqlstate: TEMPLATE_SQLSTATE.approvalTransition },
      )
    }
    if (sqlstateOf(error) === TEMPLATE_SQLSTATE.approvedWordsFrozen) {
      refuse(
        'template_approved_words_frozen',
        'An approved template variant may not be edited in place. Move it to draft first: an approval ' +
          'belongs to the words it was granted for.',
        { change, sqlstate: TEMPLATE_SQLSTATE.approvedWordsFrozen },
      )
    }
    throw error
  }
}

export interface Reclassification {
  readonly templateKey: string
  readonly to: 'transactional' | 'promotional'
  /** The new version's purpose line. The old one described a different kind of message. */
  readonly purpose: string
  readonly actor: { readonly kind: 'staff' | 'system'; readonly label: string }
}

/**
 * The only path that changes a template's class.
 *
 * Runs inside its own transaction so the actor set with `set_config(..., true)` is local to it: a
 * transaction-local setting that leaked into the next statement on a pooled connection would attribute
 * somebody else's write to this actor, which is worse than attributing it to nobody.
 *
 * Returns the id of the NEW version. Every carried-over variant lands in `draft` and an
 * `message_template.reclassified` audit row is written naming the actor — both inside the same
 * transaction, so a reclassification that rolled back leaves no audit row claiming it happened.
 */
export async function reclassifyTemplate(
  sql: Sql,
  change: Reclassification,
): Promise<{ readonly templateId: string }> {
  try {
    return await sql.begin(async (tx) => {
      await tx`select set_config('berelax.audit_actor_kind', ${change.actor.kind}, true)`
      await tx`select set_config('berelax.audit_actor_label', ${change.actor.label}, true)`
      const [row] = await tx<{ id: string }[]>`
        select reclassify_template(
          ${change.templateKey}, ${change.to}::message_class, ${change.purpose}
        )::text as id
      `
      if (row === undefined) {
        throw new AppError(
          'invariant_violated',
          `reclassify_template returned no row for '${change.templateKey}'.`,
        )
      }
      return { templateId: row.id }
    })
  } catch (error) {
    const state = sqlstateOf(error)
    if (state === '02000') {
      refuse('template_not_found', `No current template with key '${change.templateKey}'.`, {
        change,
      })
    }
    if (state === '23001') {
      refuse(
        'template_already_that_class',
        `Template '${change.templateKey}' is already ${change.to}. A reclassification that changed ` +
          'nothing would still supersede the current version and reset every approval, which is a ' +
          'template taken out of service by a no-op.',
        { change },
      )
    }
    throw error
  }
}
