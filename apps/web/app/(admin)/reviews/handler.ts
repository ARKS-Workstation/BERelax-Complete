import { ASIA_DUBAI, can, type Instant, type Permission, type Role, toLocal } from '@berelax/core'
import { type Actor, listReviewQueue, type Sql } from '@berelax/db'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'
import { listReviewListings, type ReviewListing } from './listings.ts'
import { queueRowFrom } from './queue-row.ts'
import { renderReviewsQueueHtml } from './render.ts'
import {
  QUEUE_SCOPES,
  type QueueDirection,
  type QueueScope,
  REVIEWS_QUEUE_OUTCOMES,
  REVIEWS_QUEUE_PARAMS,
  type ReviewsQueueOutcome,
  type ReviewsQueueRefusal,
  type ReviewsQueueView,
} from './view.ts'

/**
 * *Reviews* — the approval queue's read (G-REV-06, docs/10 §6).
 *
 * The handler rather than the route binding, so `apps/web/src/reviews-queue.itest.ts` can drive it with an
 * injected clock against a real PostgreSQL, and so the parts both screens share are stated once.
 *
 * ## Authorisation is server-side, through the matrix, twice
 *
 *   1. The admin session, through `guardAdminRoute` in the route binding (W-SYS-11): the cookie carries 32
 *      random bytes and no role, and the role is reached by a join on every request (ADR 0039).
 *   2. `can(role, 'review:reply_approve')` — the F07 matrix in `@berelax/core`, which is where every
 *      permission decision in this system is made.
 *
 * There is deliberately **no `?role=` parameter** anywhere on these screens, and no `?employee=`: a
 * repository-wide scan refuses one (W-SYS-11), and a screen that WRITES must not be the route that fails
 * it. `?dir=rtl` chooses a layout and `?connection=`/`?place=` choose which listing to show — none of them
 * chooses a principal, a role or a permission, and the listing pair is intersected with the listings this
 * system actually manages rather than trusted.
 *
 * The GET is gated as well as the writes. The queue shows a reviewer's words about this business and the
 * sentence a machine proposes to answer them with, which is not something a role without the authority to
 * approve one needs to read.
 */

/**
 * The permission the whole approval queue requires.
 *
 * `review:reply_approve`, added to the F07 catalogue by this unit and granted to the owner alone. Its
 * entry carries the argument; the short version is that this is the control that puts a sentence on a
 * public page under the business's name, and docs/07 §4 reserves that for somebody with the authority to
 * say it.
 */
export const REVIEWS_QUEUE_PERMISSION: Permission = 'review:reply_approve'

/** What the screens say for each refusal, BY NAME. A `Record` over the union, so a new name is worded. */
export const REFUSAL_SENTENCES: Readonly<Record<ReviewsQueueRefusal, string>> = {
  unreadable_request:
    'That is not a submission this screen could have sent. Open the review again from the queue.',
  unauthenticated: 'This screen needs a signed-in admin session.',
  forbidden:
    'Your role may not approve a reply. A reply is published under the business’s name on a public ' +
    'listing, and docs/07 §4 reserves approving one for somebody with the authority to say it.',
  unknown_review:
    'There is no such review on any listing this system manages. A review filed against another ' +
    'connection would be a reply posted as the wrong business.',
  reply_missing: 'Type the reply. An empty approval would approve nothing.',
  language_not_offered:
    'Choose the language the reply is written in. The linter checks the claim from both sides, so it is ' +
    'not a way round the rule.',
  reply_refused_by_the_linter:
    'The linter refused this reply, by the rules listed below. It was NOT approved and nothing was ' +
    'stored: the same rules run on every reply in both delivery modes (ADR 0063).',
  nothing_approved_to_post:
    'Nothing has been approved for this review, so there is nothing a person could have pasted into ' +
    'Google. Approve a reply first — that is the step that produces the bytes “Copy reply” copies.',
  already_posted:
    'Somebody has already recorded that they posted this reply. A second claim would not be a second ' +
    'posting, and the record of the first one is not editable (migration 0128).',
  write_refused: 'The database refused the write.',
}

/** The status each refusal answers with. A refusal that answered 200 would be a screen that looked saved. */
export const REFUSAL_STATUS: Readonly<Record<ReviewsQueueRefusal, number>> = {
  unreadable_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  unknown_review: 404,
  reply_missing: 400,
  language_not_offered: 400,
  // The request was well formed and the reply is not publishable. 422 rather than 400: the owner has
  // something to fix and the rules below say what, which a 400 reads as a malformed submission.
  reply_refused_by_the_linter: 422,
  nothing_approved_to_post: 409,
  already_posted: 409,
  write_refused: 503,
}

/** A staff principal as the admin session resolves it. The role decides; the id is the audit key. */
export interface QueuePrincipal {
  readonly id: string
  readonly role: Role
}

export interface ReviewsQueueDeps {
  readonly sql: Sql
  /** Injected, so the suite can freeze it. The page prints the instant it was read at. */
  readonly now: () => Instant
}

export interface ReviewsQueueRequest {
  readonly searchParams: URLSearchParams
  readonly chrome: AdminChrome
  /** The POST body, or `null` for a GET. */
  readonly body: URLSearchParams | null
  readonly principal: QueuePrincipal | null
  readonly requestId: string | null
}

/** `audit_event.actor_id` is a `uuid` column, which is why the shape is checked rather than assumed. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The actor every row this screen writes names.
 *
 * The signed-in principal's own id and role, from the admin session — not a label naming the SURFACE,
 * which is what the diary, the pipeline board and the quick-book screen correctly record because they have
 * no session to read, and not an invented name, which brief rule 15 forbids.
 *
 * The id is carried only when it is a UUID, which is not defensiveness for its own sake: a non-uuid id
 * would make every approval a 500 from the audit insert. It matters more here than on the paste form,
 * because **migration 0128's ZY341 refuses a *Marked as posted* write whose audit row carries no
 * `actor_id`** — so a principal with a readable id would not produce a mis-attributed claim, it would
 * produce a refused one, which is the right direction for a floor to fail in.
 */
export function queueActorFor(principal: QueuePrincipal): Actor {
  const label = `Reviews approval — employee ${principal.id} (${principal.role})`
  return UUID.test(principal.id)
    ? { kind: 'staff', id: principal.id, label }
    : { kind: 'staff', label }
}

/** The guard both verbs and both screens run, in one place. Two copies is how a GET comes to be open. */
export function refuseUnauthorised(principal: QueuePrincipal | null): ReviewsQueueRefusal | null {
  if (principal === null) return 'unauthenticated'
  if (!can(principal.role satisfies Role, REVIEWS_QUEUE_PERMISSION)) return 'forbidden'
  return null
}

export const directionFrom = (params: URLSearchParams): QueueDirection =>
  params.get(REVIEWS_QUEUE_PARAMS.dir) === 'rtl' ? 'rtl' : 'ltr'

/**
 * Which reviews to list. `open` unless `?show=all`.
 *
 * Anything that is not one of the two is `open`, which is the cautious direction here for once: a
 * mistyped parameter showing the worklist is a page somebody can act on, where showing everything is a
 * page on which the five reviews that need a reply are lost among a hundred that do not.
 */
export const scopeFrom = (params: URLSearchParams): QueueScope =>
  (QUEUE_SCOPES as readonly string[]).includes(params.get(REVIEWS_QUEUE_PARAMS.show) ?? '')
    ? ((params.get(REVIEWS_QUEUE_PARAMS.show) ?? 'open') as QueueScope)
    : 'open'

/** A review still needs somebody unless a delivery has been recorded against it. */
const isOpen = (stage: string): boolean =>
  stage !== 'claimed_as_posted' && stage !== 'submitted_to_the_api'

export const outcomeFrom = (params: URLSearchParams): ReviewsQueueOutcome | null => {
  const value = params.get(REVIEWS_QUEUE_PARAMS.done) ?? ''
  return (REVIEWS_QUEUE_OUTCOMES as readonly string[]).includes(value)
    ? (value as ReviewsQueueOutcome)
    : null
}

/**
 * Which listing to show: the one asked for, intersected with the ones this system manages.
 *
 * Both halves of the pair have to match, and the pair is looked up rather than trusted. Migration 0020's
 * trigger refuses a place that is not a resource of its connection, so a mismatched pair would otherwise
 * be a 500 from the database — and a queue scoped to half a pair would be the other listing's reviews,
 * which is a reply posted as the wrong business (docs/10 §2).
 *
 * With nothing asked for, the FIRST listing. Not "all of them": `listReviewQueue` has no unscoped overload
 * for exactly this reason, and a merged queue would put two businesses' reviews in one list.
 */
export function listingFor(
  listings: readonly ReviewListing[],
  params: URLSearchParams,
): ReviewListing | null {
  const connection = (params.get(REVIEWS_QUEUE_PARAMS.connection) ?? '').trim()
  const place = (params.get(REVIEWS_QUEUE_PARAMS.place) ?? '').trim()
  if (connection === '' && place === '') return listings[0] ?? null
  return (
    listings.find(
      (candidate) =>
        (connection === '' || candidate.connectionId === connection) &&
        (place === '' || candidate.placeId === place),
    ) ?? null
  )
}

export const actorLabelOf = (principal: QueuePrincipal | null): string | null =>
  principal === null ? null : (queueActorFor(principal).label ?? null)

/**
 * The local date in the business zone, which is what both screens print.
 *
 * Shared by the two handlers so there is one answer to "when was this read", and a date rather than an
 * instant for the reason on `ReviewsQueueView.readOnDate`.
 */
export const readOnDateOf = (deps: ReviewsQueueDeps): string => toLocal(deps.now(), ASIA_DUBAI).date

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

async function viewFor(
  deps: ReviewsQueueDeps,
  request: ReviewsQueueRequest,
  extra: {
    readonly refusal: ReviewsQueueRefusal | null
    readonly reveal: boolean
  },
): Promise<ReviewsQueueView> {
  /*
    `reveal` is `false` for an authorisation refusal, and it is not a nicety. The paste form next door
    rendered the same page for every refusal and its 401 document then carried a forwarded review's full
    text, the connection id and the Google account email. The same mistake here would be worse: this page
    also carries what a machine has proposed to say in public.
  */
  const listings = extra.reveal ? await listReviewListings(deps.sql) : []
  const listing = extra.reveal ? listingFor(listings, request.searchParams) : null
  const all =
    listing === null
      ? []
      : (
          await listReviewQueue(deps.sql, {
            connectionId: listing.connectionId,
            placeId: listing.placeId,
          })
        ).map(queueRowFrom)
  const scope = scopeFrom(request.searchParams)
  // Filtered here and not in SQL, deliberately: `listReviewQueue` is the one read of this table and the
  // stage is derived from the row in ONE place (`stageOf`). A `where` clause here would be a second
  // statement of which rows are finished, in a language that cannot call that function.
  const rows = scope === 'all' ? all : all.filter((row) => isOpen(row.stage))
  return {
    chrome: request.chrome,
    direction: directionFrom(request.searchParams),
    readOnDate: readOnDateOf(deps),
    listings,
    listing,
    scope,
    total: all.length,
    rows,
    refusal:
      extra.refusal === null
        ? null
        : { name: extra.refusal, sentence: REFUSAL_SENTENCES[extra.refusal] },
    outcome: extra.reveal ? outcomeFrom(request.searchParams) : null,
    actorLabel: actorLabelOf(request.principal),
  }
}

export async function handleReviewsQueueRead(
  request: ReviewsQueueRequest,
  deps: ReviewsQueueDeps,
): Promise<Response> {
  const refused = refuseUnauthorised(request.principal)
  if (refused !== null) {
    return html(
      renderReviewsQueueHtml(await viewFor(deps, request, { refusal: refused, reveal: false })),
      REFUSAL_STATUS[refused],
    )
  }
  return html(renderReviewsQueueHtml(await viewFor(deps, request, { refusal: null, reveal: true })))
}
