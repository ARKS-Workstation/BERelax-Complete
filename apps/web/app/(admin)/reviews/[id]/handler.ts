import { getReview, type QueuedReview, type Sql } from '@berelax/db'
import {
  approveReply,
  markReplyPostedManually,
  placeReviewsDeepLink,
  replyDeliveryRefusalRulesOf,
} from '@berelax/google'
import {
  actorLabelOf,
  directionFrom,
  html,
  listingFor,
  outcomeFrom,
  queueActorFor,
  REFUSAL_SENTENCES,
  REFUSAL_STATUS,
  type ReviewsQueueDeps,
  type ReviewsQueueRequest,
  readOnDateOf,
  refuseUnauthorised,
} from '../handler.ts'
import { listReviewListings } from '../listings.ts'
import { reviewDetailFrom } from '../queue-row.ts'
import {
  APPROVE_LANGUAGES,
  type ApproveLanguage,
  REVIEWS_APPROVE_FIELDS,
  REVIEWS_QUEUE_PARAMS,
  type ReviewDetailView,
  type ReviewsQueueRefusal,
  reviewPath,
} from '../view.ts'
import { renderReviewDetailHtml } from './render.ts'

/**
 * One review: the read, the approval, and the claim (G-REV-06, docs/10 §6).
 *
 * The handler rather than the route binding, so the integration suite can drive every refusal against a
 * real PostgreSQL with an injected clock — and the refusals are the content of this file.
 *
 * ## The approval is refused by the SERVER, and the lint is G-REV-05's
 *
 * The acceptance line is explicit: *"a hand-edited draft containing a banned claim cannot be approved, and
 * the e2e asserts the approve control is refused by the server action, not merely disabled in the
 * client."* So the control is never disabled: the form posts, `approveReply` lints the posted bytes
 * through the one `lint(` expression on the send path (ADR 0063), and a refusal comes back as 422 with
 * every rule named. Nothing is stored.
 *
 * `approveReply` takes the POSTED bytes rather than `reply_draft`, which is G-REV-05's decision restated:
 * an owner edits the draft before approving it, so the bytes that are judged have to be the bytes that go
 * out. That is also why **there is no copy control before an approval** — see `./render.ts`.
 *
 * ## The review has to be one of OUR listings, and that is checked here
 *
 * `getReview` is by id and is not scoped: a uuid typed into the address bar would otherwise reach any row
 * in the table. The row's `(connection_id, place_id)` is intersected with `listReviewListings`, and a
 * review outside it is `unknown_review` — a 404, because for this screen it does not exist. A reply
 * approved against another connection's review is a reply posted as the wrong business (docs/10 §2).
 */

/** The id out of the dynamic segment. Trimmed, never parsed: it is an opaque key to `getReview`. */
export const reviewIdFrom = (segment: string | undefined): string => (segment ?? '').trim()

const languageFrom = (value: string): ApproveLanguage | null =>
  (APPROVE_LANGUAGES as readonly string[]).includes(value) ? (value as ApproveLanguage) : null

/** The review, but only when it belongs to a listing this system manages. */
async function reviewInScope(sql: Sql, id: string): Promise<QueuedReview | undefined> {
  if (id === '') return undefined
  const review = await getReview(sql, id)
  if (review === undefined) return undefined
  const listings = await listReviewListings(sql)
  const mine = listings.some(
    (listing) => listing.connectionId === review.connectionId && listing.placeId === review.placeId,
  )
  return mine ? review : undefined
}

export interface ReviewDetailRequest extends ReviewsQueueRequest {
  /** The `[id]` segment, exactly as the router resolved it. */
  readonly reviewId: string
}

/**
 * What the textarea starts from.
 *
 * After a refusal: what the owner typed, so a refused approval never throws away an edit. Otherwise the
 * bytes already approved if there are any — an owner reopening the screen should see what they approved
 * and not the machine's original sentence — and the machine's draft if there are not.
 */
function editingText(review: QueuedReview | undefined, typed: string | null): string {
  if (typed !== null) return typed
  return review?.replyApprovedText ?? review?.replyDraft ?? ''
}

async function viewFor(
  deps: ReviewsQueueDeps,
  request: ReviewDetailRequest,
  extra: {
    readonly refusal: ReviewsQueueRefusal | null
    readonly lintRules: readonly string[]
    readonly reveal: boolean
    readonly typed: string | null
    readonly language: ApproveLanguage | null
  },
): Promise<ReviewDetailView> {
  const review = extra.reveal ? await reviewInScope(deps.sql, request.reviewId) : undefined
  const listings = extra.reveal ? await listReviewListings(deps.sql) : []
  return {
    chrome: request.chrome,
    direction: directionFrom(request.searchParams),
    readOnDate: readOnDateOf(deps),
    listing: listingFor(listings, new URLSearchParams()),
    review: review === undefined ? null : reviewDetailFrom(review),
    // Built from the STORED place id, by `@berelax/google`'s one implementation of this URL. Never
    // configured and never stored: a link built from configuration keeps working after the configuration
    // is re-pointed at another listing, and then it sends the owner to the wrong business's reviews.
    deepLink: review === undefined ? null : placeReviewsDeepLink(review.placeId),
    editing: editingText(review, extra.typed),
    language: extra.language ?? (review?.replyDraftLanguage === 'ar' ? 'ar' : 'en'),
    refusal:
      extra.refusal === null
        ? null
        : { name: extra.refusal, sentence: REFUSAL_SENTENCES[extra.refusal] },
    lintRules: extra.lintRules,
    outcome: extra.reveal ? outcomeFrom(request.searchParams) : null,
    actorLabel: actorLabelOf(request.principal),
  }
}

const render = async (
  deps: ReviewsQueueDeps,
  request: ReviewDetailRequest,
  extra: Parameters<typeof viewFor>[2],
  status = 200,
): Promise<Response> => html(renderReviewDetailHtml(await viewFor(deps, request, extra)), status)

const NOTHING_TYPED = { typed: null, language: null } as const

export async function handleReviewDetailRead(
  request: ReviewDetailRequest,
  deps: ReviewsQueueDeps,
): Promise<Response> {
  const refused = refuseUnauthorised(request.principal)
  if (refused !== null) {
    return await render(
      deps,
      request,
      { refusal: refused, lintRules: [], reveal: false, ...NOTHING_TYPED },
      REFUSAL_STATUS[refused],
    )
  }
  const review = await reviewInScope(deps.sql, request.reviewId)
  if (review === undefined) {
    // `reveal: true` deliberately: the caller is entitled to this screen, there is simply no such review.
    // The page it gets says so and shows nothing else, because there is nothing else to show.
    return await render(
      deps,
      request,
      { refusal: 'unknown_review', lintRules: [], reveal: true, ...NOTHING_TYPED },
      REFUSAL_STATUS.unknown_review,
    )
  }
  return await render(deps, request, {
    refusal: null,
    lintRules: [],
    reveal: true,
    ...NOTHING_TYPED,
  })
}

/** 303 back to this screen, which is what stops a reload re-posting an approval. */
function seeOther(reviewId: string, request: ReviewDetailRequest, done: string): Response {
  const query = new URLSearchParams({ [REVIEWS_QUEUE_PARAMS.done]: done })
  if (directionFrom(request.searchParams) === 'rtl') {
    query.set(REVIEWS_QUEUE_PARAMS.dir, 'rtl')
  }
  return new Response(null, {
    status: 303,
    headers: {
      location: `${reviewPath(reviewId)}?${query.toString()}`,
      'cache-control': 'no-store',
    },
  })
}

export async function handleReviewApprove(
  request: ReviewDetailRequest,
  deps: ReviewsQueueDeps,
): Promise<Response> {
  const refused = refuseUnauthorised(request.principal)
  const principal = request.principal
  if (refused !== null || principal === null) {
    const name = refused ?? 'unauthenticated'
    return await render(
      deps,
      request,
      { refusal: name, lintRules: [], reveal: false, ...NOTHING_TYPED },
      REFUSAL_STATUS[name],
    )
  }

  const body = request.body
  if (body === null || [...body.keys()].length === 0) {
    return await render(
      deps,
      request,
      { refusal: 'unreadable_request', lintRules: [], reveal: true, ...NOTHING_TYPED },
      REFUSAL_STATUS.unreadable_request,
    )
  }
  // Never trimmed on the way in beyond the emptiness test: it is the text that will be published, and
  // the linter measures the rendered reply. `renderFinalReply` is the one thing that composes it.
  const typed = body.get(REVIEWS_APPROVE_FIELDS.reply) ?? ''
  const language = languageFrom((body.get(REVIEWS_APPROVE_FIELDS.language) ?? '').trim())
  const refuse = async (name: ReviewsQueueRefusal, rules: readonly string[] = []) =>
    await render(
      deps,
      request,
      { refusal: name, lintRules: rules, reveal: true, typed, language },
      REFUSAL_STATUS[name],
    )

  const review = await reviewInScope(deps.sql, request.reviewId)
  if (review === undefined) return await refuse('unknown_review')
  if (typed.trim() === '') return await refuse('reply_missing')
  if (language === null) return await refuse('language_not_offered')

  try {
    await approveReply(
      {
        sql: deps.sql,
        actor: queueActorFor(principal),
        // No signature, because nobody has said what this business signs its replies with:
        // OPEN-QUESTIONS Y9-reply-signature, which G-REV-05 opened and which this unit does NOT answer
        // with a plausible sign-off. The mechanism is G-REV-05's `renderFinalReply` and the cap is
        // measured over it either way; a sign-off invented here would publish under the owner's name.
        signature: null,
      },
      { reviewId: review.id, approvedReply: typed, language },
    )
  } catch (error) {
    const rules = replyDeliveryRefusalRulesOf(error)
    // A lint refusal is the ONE failure this screen explains rather than reports: the owner has something
    // to fix and the rule names say what. Anything else is a 503 — see the route binding.
    if (rules === null) throw error
    return await refuse('reply_refused_by_the_linter', rules)
  }
  return seeOther(review.id, request, 'approved')
}

/**
 * *Marked as posted* — a named human's claim that they pasted the approved reply into Google.
 *
 * It re-lints, because `markReplyPostedManually` does: between approval and this call the row sits
 * editable by design and the regulatory profile and the staff roster are both live rows. A reply that has
 * stopped being publishable is refused here with its rules named rather than recorded as posted because it
 * once passed.
 *
 * It is a POST to its own endpoint rather than a second button on the approval form, because it is a
 * different claim about a different thing and the manifest names the route. The audit row it writes is
 * what makes the claim attributable, and migration 0128's ZY341 refuses the write without one.
 */
export async function handleReviewMarkPosted(
  request: ReviewDetailRequest,
  deps: ReviewsQueueDeps,
): Promise<Response> {
  const refused = refuseUnauthorised(request.principal)
  const principal = request.principal
  if (refused !== null || principal === null) {
    const name = refused ?? 'unauthenticated'
    return await render(
      deps,
      request,
      { refusal: name, lintRules: [], reveal: false, ...NOTHING_TYPED },
      REFUSAL_STATUS[name],
    )
  }
  const refuse = async (name: ReviewsQueueRefusal, rules: readonly string[] = []) =>
    await render(
      deps,
      request,
      { refusal: name, lintRules: rules, reveal: true, ...NOTHING_TYPED },
      REFUSAL_STATUS[name],
    )

  const review = await reviewInScope(deps.sql, request.reviewId)
  if (review === undefined) return await refuse('unknown_review')
  if (review.replyApprovedText === null) return await refuse('nothing_approved_to_post')
  // Read before the write so the second claim is a sentence rather than a constraint name. The write
  // itself is still the floor: 0128's ZY342 refuses a change to an already-set posting instant, so two
  // operators racing on the same review cannot both have their claim recorded.
  if (review.postedManuallyAtIso !== null) return await refuse('already_posted')

  try {
    await markReplyPostedManually({ sql: deps.sql, actor: queueActorFor(principal) }, review.id)
  } catch (error) {
    const rules = replyDeliveryRefusalRulesOf(error)
    if (rules === null) throw error
    return await refuse('reply_refused_by_the_linter', rules)
  }
  return seeOther(review.id, request, 'posted')
}
