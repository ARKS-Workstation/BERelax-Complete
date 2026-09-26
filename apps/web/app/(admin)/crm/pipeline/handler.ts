import {
  type Actor,
  moveCard,
  type PipelineRefusal,
  pipelineRefusalOf,
  readPipelineBoard,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import type { AdminChrome } from '../../../../src/components/admin/google-reauth-banner.ts'
import {
  type PipelineOutcome,
  type PipelineView,
  pipelineAnnouncement,
  type RenderDirection,
  renderPipelineHtml,
} from './render.ts'

/**
 * `/crm/pipeline` — the pipeline board (C-AUTO-08, docs/03 §5).
 *
 * The handler rather than the route binding, so `apps/web/src/pipeline.itest.ts` can drive it directly
 * against a real PostgreSQL with an injected clock. That is not a convenience: a move's instant is written
 * into two rows that a deferred trigger compares for equality, and an instant cannot be frozen behind a
 * `next start`. The diary next door takes the same split for the same reason.
 *
 * ## One read, and it is the acceptance criterion
 *
 * `readPipelineBoard` is ONE statement for every column and every card. A query per column is the obvious
 * implementation, and B-UI-03 proved it wrong for the calendar's two axes: six round trips can disagree
 * with each other, because a card moved between the second and the fifth appears twice or not at all.
 * `pipeline.itest.ts` counts the statements by wrapping `Sql`, which is how the claim is made about the
 * code that runs rather than about the code somebody read.
 *
 * ## POST answers in the shape it was asked in
 *
 * The inline script sends JSON and is answered JSON with a STATUS — 409 for a column that has been archived
 * under the reader's feet, which is what the optimistic card is reverted by. A `<form>` sends
 * `application/x-www-form-urlencoded` and is answered with a 303 back to the board carrying the outcome in
 * the query string, so the screen works with JavaScript off. One handler, one transaction, two envelopes.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, exactly as the credentials
 * screen, the reassignment queue, the compliance calendar, the Messages inbox and the duplicate queue all
 * record. The actor is therefore the SURFACE and not a person: `Pipeline board`, stated rather than
 * invented, because `pipeline_stage_transition_actor_is_stated` refuses a placeholder and a plausible name
 * would be indistinguishable from a real one (brief rule 15). Every move is attributable to the screen it
 * was made on, and W-SYS-01 replaces the label with the signed-in operator.
 */

/** The actor a move is recorded under until there is a session. Stated, never invented. */
export const PIPELINE_ACTOR: Actor = { kind: 'staff', label: 'Pipeline board' }

/** The OPEN-QUESTIONS row the six provisional columns are tracked under. The page cites it. */
export const PIPELINE_VOCABULARY_OPEN_QUESTION = 'Y9-crm-pipeline'

export interface PipelineDepsForHandler {
  readonly sql: Sql
  /** Injected, so the suite can freeze it. A move's instant goes into two rows that are compared. */
  readonly now: () => Date
}

export interface PipelineReadRequest {
  readonly searchParams: URLSearchParams
  readonly chrome: AdminChrome
}

export interface PipelineWriteRequest {
  readonly searchParams: URLSearchParams
  readonly body: Record<string, unknown> | URLSearchParams
  readonly wantsJson: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STAGE_KEY = /^[a-z][a-z0-9_]{0,47}$/

/**
 * The HTTP status each refusal answers with, as a table.
 *
 * A table and not a conditional, because the 409 is an acceptance criterion and a conditional is where the
 * one case that matters comes to share a branch with something else. 409 is "the board you dragged on is
 * out of date" — the column was archived, or the card is already there — and 404 is "that thing does not
 * exist", which is a bad request rather than a race.
 */
const STATUS_FOR: Record<PipelineRefusal, number> = {
  stage_not_found: 404,
  customer_not_found: 404,
  stage_archived: 409,
  card_already_in_stage: 409,
  order_is_not_a_permutation: 409,
  stage_entry_flow_refused: 409,
  stage_entry_flow_not_triggered_by_stage_entry: 409,
}

/**
 * What the page SAYS for each refusal, in one place.
 *
 * On the page rather than the repository's message, for two reasons. The repository's sentence explains a
 * decision to whoever reads a log; this one tells somebody at a front desk what just happened and what to
 * do. And the no-JavaScript path carries only the refusal NAME across a 303 — the message has to be
 * reproducible from the name alone, or the sentence after a redirect would differ from the sentence after a
 * fetch, which is two wordings for one outcome.
 */
const SENTENCE_FOR: Record<PipelineRefusal, string> = {
  stage_not_found: 'there is no such column. Reload the board.',
  customer_not_found: 'there is no such card. Reload the board.',
  stage_archived:
    'that column has been archived since this board was loaded, so the card has gone back where it ' +
    'was. Reload the board to see the columns as they are now.',
  card_already_in_stage: 'the card is already in that column, so nothing has moved.',
  order_is_not_a_permutation: 'the column order offered is not a permutation of the columns.',
  stage_entry_flow_refused:
    'the column starts a flow and the enrolment was refused, so the move has been rolled back with it.',
  stage_entry_flow_not_triggered_by_stage_entry:
    'the column starts a flow whose published version is not triggered by a stage entry. Fix the ' +
    'column in settings, or publish a version whose trigger is the stage entry.',
}

function page(html: string, status = 200): Response {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // Never cached. A cached board outlives the board: a card moved five minutes ago would still be
      // drawn in its old column, which is the one failure a board must not have.
      'cache-control': 'no-store',
    },
    status,
  })
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    status,
  })
}

/** `?dir=rtl` mirrors the layout. A direction axis rather than a locale — see `render.ts`. */
export function directionFrom(params: URLSearchParams): RenderDirection {
  return params.get('dir') === 'rtl' ? 'rtl' : 'ltr'
}

/**
 * The outcome a 303 carried back, or null.
 *
 * A refusal NAME and never a sentence in the URL: a sentence in a query string is a sentence anybody can
 * put there, and the page would print it. The name is checked against the table above, so a value nobody
 * declared reads as no outcome at all rather than as an unknown refusal.
 */
function outcomeFrom(params: URLSearchParams): PipelineOutcome | null {
  const moved = params.get('moved')
  if (moved !== null && STAGE_KEY.test(moved)) {
    return { kind: 'moved', toStageKey: moved, label: moved }
  }
  const refusal = params.get('refusal')
  if (refusal !== null && Object.hasOwn(SENTENCE_FOR, refusal)) {
    const named = refusal as PipelineRefusal
    return { kind: 'refused', refusal: named, message: SENTENCE_FOR[named] }
  }
  return null
}

/** The board, rendered. One read; nothing here decides anything a row does not say. */
export async function handlePipelineRead(
  request: PipelineReadRequest,
  deps: PipelineDepsForHandler,
): Promise<Response> {
  const board = await readPipelineBoard(deps.sql)
  const view: PipelineView = {
    chrome: request.chrome,
    board,
    direction: directionFrom(request.searchParams),
    vocabularyOpenQuestion: PIPELINE_VOCABULARY_OPEN_QUESTION,
    outcome: outcomeFrom(request.searchParams),
  }
  return page(renderPipelineHtml(view))
}

const fieldOf = (body: Record<string, unknown> | URLSearchParams, name: string): string => {
  const raw = body instanceof URLSearchParams ? body.get(name) : body[name]
  return typeof raw === 'string' ? raw : ''
}

/** Where a form POST comes back to, carrying the outcome as a NAME. */
function backTo(params: URLSearchParams, outcome: { moved?: string; refusal?: string }): string {
  const next = new URLSearchParams()
  if (params.get('dir') === 'rtl') next.set('dir', 'rtl')
  if (outcome.moved !== undefined) next.set('moved', outcome.moved)
  if (outcome.refusal !== undefined) next.set('refusal', outcome.refusal)
  const query = next.toString()
  return query === '' ? '/crm/pipeline' : `/crm/pipeline?${query}`
}

/**
 * One move, in one transaction, answered in the shape it was asked in.
 *
 * The 400 for a malformed id is deliberately NOT a refusal name: `stage_not_found` for a value that is not
 * a stage key at all would send a caller looking for a column somebody deleted. A shape error and a
 * missing row are different problems with different next steps.
 */
export async function handlePipelineWrite(
  request: PipelineWriteRequest,
  deps: PipelineDepsForHandler,
): Promise<Response> {
  const customerId = fieldOf(request.body, 'customerId')
  const toStageKey = fieldOf(request.body, 'toStageKey')
  if (!UUID.test(customerId) || !STAGE_KEY.test(toStageKey)) {
    const message =
      'That is not a move this board can read: a move names a card by its contact id and a column by ' +
      'its key.'
    return request.wantsJson
      ? json({ ok: false, refusal: 'unreadable_move', announcement: message }, 400)
      : // `text/plain` and deliberately NOT a document. Every file under `app/(admin)` that emits a
        // doctype has to render the Google re-auth banner (G-CONN-08), and `google-reauth-banner.test.ts`
        // walks the tree to say so - correctly, because an admin PAGE that says nothing while the grant is
        // dead is the failure that check exists to catch. A one-sentence refusal for a body the board
        // itself could not have sent is not a page, and dressing it as one would put a second, bannerless
        // copy of the shell in this file.
        new Response(`${message}\n`, {
          status: 400,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        })
  }

  try {
    const outcome = await withUnitOfWork(deps.sql, PIPELINE_ACTOR, (uow) =>
      moveCard(uow, {
        customerId,
        toStageKey,
        actor: PIPELINE_ACTOR,
        at: deps.now(),
      }),
    )
    const announcement = pipelineAnnouncement({
      kind: 'moved',
      toStageKey: outcome.toStageKey,
      label: outcome.toStageKey,
    })
    return request.wantsJson
      ? json({
          ok: true,
          refusal: null,
          announcement,
          fromStageKey: outcome.fromStageKey,
          toStageKey: outcome.toStageKey,
          occurredAt: outcome.occurredAtIso,
          enrolledOnFlow: outcome.enrolment === null ? null : outcome.enrolment.pinnedVersion,
        })
      : // 303 and a relative `location`, not `Response.redirect`: that helper requires an ABSOLUTE URL and
        // would make this handler need to know its own origin, which it does not and must not — the origin
        // behind a proxy is not the one the request arrived on. 303 rather than 302, because the next
        // request must be a GET whatever this one was.
        new Response(null, {
          status: 303,
          headers: {
            location: backTo(request.searchParams, { moved: outcome.toStageKey }),
            'cache-control': 'no-store',
          },
        })
  } catch (error) {
    const refusal = pipelineRefusalOf(error)
    if (refusal === null) throw error
    const outcome: PipelineOutcome = {
      kind: 'refused',
      refusal,
      message: SENTENCE_FOR[refusal],
    }
    return request.wantsJson
      ? json(
          {
            ok: false,
            refusal,
            announcement: pipelineAnnouncement(outcome),
            detail: isAppError(error) ? error.message : null,
          },
          STATUS_FOR[refusal],
        )
      : new Response(null, {
          status: 303,
          headers: {
            location: backTo(request.searchParams, { refusal }),
            'cache-control': 'no-store',
          },
        })
  }
}
