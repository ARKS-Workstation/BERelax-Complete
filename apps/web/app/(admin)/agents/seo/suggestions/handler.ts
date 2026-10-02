import { can, type Role, staffPrincipal } from '@berelax/core'
import {
  approveSeoSuggestion,
  openSeoSuggestions,
  publicationPosition,
  publicationRecordById,
  type SeoSuggestionRow,
  type Sql,
  seoSuggestionById,
  seoSuggestionRefusalOf,
} from '@berelax/db'
import {
  applySeoSuggestion,
  rollbackSeoSuggestion,
  suggestionApplyRefusalOf,
} from '@berelax/google'
import { isAppError } from '@berelax/shared'
import type { AdminChrome } from '../../../../../src/components/admin/google-reauth-banner.ts'
import { renderSeoSuggestionsHtml } from './render.ts'
import {
  actionsFor,
  regionDiff,
  SEO_SUGGESTION_ACTIONS,
  SEO_SUGGESTIONS_FIELDS,
  SEO_SUGGESTIONS_PATH,
  type SeoSuggestionAction,
  type SeoSuggestionsRefusal,
  type SeoSuggestionsView,
  type SuggestionCardView,
} from './view.ts'

/**
 * The SEO suggestions queue: approve, apply, roll back. G-SEO-05.
 *
 * ## Why this screen exists at all, when the suggestions are rows in a table
 *
 * Because applying one is *a human action*, and the whole unit rests on that. The agent cannot publish —
 * `seo-agent-must-not-reach-a-publish-path` keeps its code away from the chokepoint and the permission
 * layer refuses its principal — so the only path from a proposal to a live page is a person reading the
 * before and the after and deciding. A queue nobody can act on would make the cage a way of doing nothing.
 *
 * ## Two authorisations, and they are not the same check
 *
 * `guardAdminRoute` (in `route.ts`) answers *is there a session*. `can(role, 'content:publish')` answers
 * *may this role publish*, and `performPublication` inside `applySeoSuggestion` answers it AGAIN at the
 * policy layer with a `Principal`. The duplication is deliberate and is not belt-and-braces: this one
 * greys a button and refuses a POST with a readable sentence, and that one is the guarantee — it is what
 * refuses the agent, and it would refuse this screen too if somebody wired a receptionist's session to it.
 *
 * A query parameter may never choose a principal, a role or a permission (W-SYS-11, and a
 * repository-wide scan refuses it). The role comes from the session row; the only thing the form carries
 * is which suggestion and which of three actions.
 *
 * ## The weight measurement is CARRIED FORWARD, and that is a decision
 *
 * 0093 requires a published record to carry `measured_critical_path_bytes` and the budget it was judged
 * against (`ZZ005`), and this screen cannot measure a page: the figure belongs to whatever rendered it.
 * Inventing one would be a measurement nobody took — brief rule 15's hazard, with a number instead of an
 * address. So the figures come from the surface's current published record, which is the honest answer for
 * a title-and-meta change: those bytes are in the document either way, and a copy edit of this size does
 * not move the critical path. A surface whose live record carries no measurement is refused by name
 * (`no_measurement_to_carry_forward`) rather than defaulted, because that state means the ledger has a
 * hole in it and publishing over it would fill the hole with a guess.
 */

/** The permission every action on this screen requires. `content:publish` is `publish` and `unpublish`. */
export const SEO_SUGGESTIONS_PERMISSION = 'content:publish' as const

/** How many refused suggestions the screen shows. The security-relevant half of the queue. */
const REFUSAL_WINDOW = 10

export interface SuggestionsPrincipal {
  /** `employee.id`, a uuid — what `publication_approval.approver_user_id` records. */
  readonly id: string
  /** The employment record's internal handle. An audit label that names no person (ADR 0020). */
  readonly staffReference: string
  readonly role: Role
}

export interface SuggestionsRequest {
  readonly searchParams: URLSearchParams
  readonly body: URLSearchParams | null
  readonly principal: SuggestionsPrincipal
  /**
   * The Google re-auth banner's state, read by the caller.
   *
   * On the request and not fetched here, exactly as the paste form takes it: it needs the database and a
   * clock, and this handler is the part the suite drives with an injected clock. G-CONN-08 requires every
   * admin document to carry the banner and `google-reauth-banner.test.ts` walks the tree to say so.
   */
  readonly chrome: AdminChrome
}

export interface SuggestionsDeps {
  readonly sql: Sql
  readonly now: () => Date
}

const cardOf = (row: SeoSuggestionRow): SuggestionCardView => ({
  id: row.id,
  surface: row.surface,
  state: row.state,
  proposedAtIso: row.proposedAtIso,
  lintVersion: row.lintVersion,
  llmProvider: row.llmProvider,
  costFils: row.costFils,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  refusedRules: row.refusedRules,
  regions: regionDiff(row.beforeRegions, row.afterRegions),
  actions: actionsFor(row),
})

/** The refused rows, newest first. Read separately because they are not in the open queue. */
async function recentRefusals(sql: Sql): Promise<readonly SuggestionCardView[]> {
  const rows = await sql<{ id: string }[]>`
    select id from seo_suggestion where state = 'refused'
    order by proposed_at desc, id desc limit ${REFUSAL_WINDOW}
  `
  const cards: SuggestionCardView[] = []
  for (const row of rows) {
    const full = await seoSuggestionById(sql, row.id)
    if (full !== null) cards.push(cardOf(full))
  }
  return cards
}

async function viewFor(
  request: SuggestionsRequest,
  deps: SuggestionsDeps,
  outcome: {
    readonly refusal: SeoSuggestionsRefusal | null
    readonly refusalDetail: string | null
    readonly done: SeoSuggestionAction | null
  },
): Promise<SeoSuggestionsView> {
  const open = await openSeoSuggestions(deps.sql)
  const permitted = can(request.principal.role, SEO_SUGGESTIONS_PERMISSION)
  return {
    readAtIso: deps.now().toISOString(),
    actorLabel: request.principal.staffReference,
    // The actions are greyed from the SAME predicate the POST refuses on, not a second spelling of it.
    // A screen offering a button the POST refuses is the defect `mayPerformPublication` exists to avoid,
    // one layer out.
    cards: open.map((row) => {
      const card = cardOf(row)
      return permitted ? card : { ...card, actions: [] }
    }),
    refusals: await recentRefusals(deps.sql),
    refusal: outcome.refusal,
    refusalDetail: outcome.refusalDetail,
    done: outcome.done,
  }
}

function page(view: SeoSuggestionsView & { readonly chrome: AdminChrome }, status = 200): Response {
  return new Response(renderSeoSuggestionsHtml(view), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  })
}

/** The queue, and the line after a 303. */
export async function handleSeoSuggestionsRead(
  request: SuggestionsRequest,
  deps: SuggestionsDeps,
): Promise<Response> {
  const done = SEO_SUGGESTION_ACTIONS.find((action) => request.searchParams.get('done') === action)
  return page({
    ...(await viewFor(request, deps, { refusal: null, refusalDetail: null, done: done ?? null })),
    chrome: request.chrome,
  })
}

/**
 * One action on one suggestion, then a 303 back to this page.
 *
 * A redirect and not a rendered response, so a reload cannot re-post: approving twice is harmless
 * (`ZY402` refuses the second move) and APPLYING twice is not — the second apply would find the live
 * content no longer matching the stored before-state and refuse, which is the right answer arrived at by
 * the wrong route. One POST, one 303.
 */
export async function handleSeoSuggestionsWrite(
  request: SuggestionsRequest,
  deps: SuggestionsDeps,
): Promise<Response> {
  const body = request.body
  if (body === null || [...body.keys()].length === 0) {
    return page(
      {
        ...(await viewFor(request, deps, {
          refusal: 'unreadable_request',
          refusalDetail: 'The submission carried no form fields.',
          done: null,
        })),
        chrome: request.chrome,
      },
      400,
    )
  }
  if (!can(request.principal.role, SEO_SUGGESTIONS_PERMISSION)) {
    return page(
      {
        ...(await viewFor(request, deps, {
          refusal: 'forbidden',
          refusalDetail: `The ${request.principal.role} role does not hold ${SEO_SUGGESTIONS_PERMISSION}.`,
          done: null,
        })),
        chrome: request.chrome,
      },
      403,
    )
  }

  const action = SEO_SUGGESTION_ACTIONS.find(
    (candidate) => candidate === body.get(SEO_SUGGESTIONS_FIELDS.action),
  )
  if (action === undefined) {
    return page(
      {
        ...(await viewFor(request, deps, {
          refusal: 'unknown_action',
          refusalDetail: 'The action must be one of approve, apply or rollback.',
          done: null,
        })),
        chrome: request.chrome,
      },
      400,
    )
  }
  const suggestionId = body.get(SEO_SUGGESTIONS_FIELDS.suggestion) ?? ''
  const suggestion = /^[0-9a-f-]{36}$/.test(suggestionId)
    ? await seoSuggestionById(deps.sql, suggestionId)
    : null
  if (suggestion === null) {
    return page(
      {
        ...(await viewFor(request, deps, {
          refusal: 'unknown_suggestion',
          refusalDetail: 'No suggestion with that id.',
          done: null,
        })),
        chrome: request.chrome,
      },
      404,
    )
  }

  const refused = async (
    refusal: SeoSuggestionsRefusal,
    detail: string,
    status: number,
  ): Promise<Response> =>
    page(
      {
        ...(await viewFor(request, deps, { refusal, refusalDetail: detail, done: null })),
        chrome: request.chrome,
      },
      status,
    )

  try {
    if (action === 'approve') {
      await approveSeoSuggestion(deps.sql, suggestion.id)
    } else {
      const measurement = await measurementToCarryForward(deps.sql, suggestion)
      if (measurement === null) {
        return await refused(
          'no_measurement_to_carry_forward',
          `The live record of '${suggestion.surface}' carries no measured critical-path weight, so a ` +
            'publication over it would have to invent one.',
          409,
        )
      }
      const principal = staffPrincipal(request.principal.role)
      const now = deps.now()
      if (action === 'apply') {
        await applySeoSuggestion(deps.sql, {
          principal,
          suggestionId: suggestion.id,
          approver: {
            userId: request.principal.id,
            // The employment record's handle, which is the audit label this build uses everywhere a
            // person would otherwise be named (ADR 0020, brief rule 10). It is snapshotted onto
            // `publication_approval`, so a later rename cannot rewrite who approved what.
            displayName: request.principal.staffReference,
            role: request.principal.role,
          },
          measuredCriticalPathBytes: measurement.measured,
          criticalPathBudgetBytes: measurement.budget,
          now,
        })
      } else {
        await rollbackSeoSuggestion(deps.sql, {
          principal,
          suggestionId: suggestion.id,
          actorLabel: request.principal.staffReference,
          measuredCriticalPathBytes: measurement.measured,
          criticalPathBudgetBytes: measurement.budget,
          now,
        })
      }
    }
  } catch (error) {
    const translated = refusalFor(error)
    return await refused(translated.refusal, translated.detail, translated.status)
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: `${SEO_SUGGESTIONS_PATH}?done=${action}`,
      'cache-control': 'no-store',
    },
  })
}

/**
 * The named refusal, sentence and status for an error the write path raised.
 *
 * A table rather than a chain of `if`s in the handler, and not only for the complexity score: each arm is
 * a sentence an operator reads, and a `default` that swallowed one of the named refusals would turn an
 * actionable "the page has changed, re-run the pass" into a 500. The three apply refusals and the one
 * transition refusal are the only ones reachable from here; anything else is a bug and says so.
 */
function refusalFor(error: unknown): {
  readonly refusal: SeoSuggestionsRefusal
  readonly detail: string
  readonly status: number
} {
  switch (suggestionApplyRefusalOf(error)) {
    case 'suggestion_before_state_is_not_live':
      return {
        refusal: 'before_state_is_not_live',
        detail:
          'The page has changed since this suggestion was drafted. Re-run the pass rather than applying ' +
          'it: the stored before-state is what a rollback restores, and it is no longer what is live.',
        status: 409,
      }
    case 'suggestion_fails_the_lint':
      return {
        refusal: 'fails_the_lint',
        detail:
          'The drafted copy does not pass the banned-claims lint against the regulatory profile in force.',
        status: 409,
      }
    case 'suggestion_has_no_restorable_record':
      return {
        refusal: 'no_restorable_record',
        detail:
          'No earlier published record of this surface carries the stored before-state, so there is ' +
          'nothing to restore.',
        status: 409,
      }
    default:
      break
  }
  if (seoSuggestionRefusalOf(error) === 'seo_suggestion_transition_not_permitted') {
    return {
      refusal: 'transition_not_permitted',
      detail: 'Somebody has already acted on this suggestion. Reload the queue.',
      status: 409,
    }
  }
  return {
    refusal: 'write_refused',
    detail: isAppError(error) ? error.message : 'Unexpected',
    status: 500,
  }
}

/**
 * The surface's current published measurement, or null when it has none.
 *
 * Read from the record that is live rather than from the suggestion, because the suggestion knows nothing
 * about bytes. See the module header for why it is carried forward rather than defaulted.
 */
async function measurementToCarryForward(
  sql: Sql,
  suggestion: SeoSuggestionRow,
): Promise<{ readonly measured: number; readonly budget: number } | null> {
  const position = await publicationPosition(sql, suggestion.surface)
  if (position.currentRecordId === null) return null
  const record = await publicationRecordById(sql, position.currentRecordId)
  if (
    record === null ||
    record.measuredCriticalPathBytes === null ||
    record.criticalPathBudgetBytes === null
  ) {
    return null
  }
  return { measured: record.measuredCriticalPathBytes, budget: record.criticalPathBudgetBytes }
}
