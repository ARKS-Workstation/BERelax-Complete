import type { CmsPrincipal } from '@berelax/cms'
import {
  ASIA_DUBAI,
  can,
  fromLocal,
  type Instant,
  instantToIso,
  localDate,
  localTime,
  type Permission,
  REVIEW_EMAIL_PARSE_REFUSAL_REASONS,
  type ReviewEmailParseRefusal,
  type Role,
} from '@berelax/core'
import {
  type Actor,
  getAwaitingPasteItem,
  listAwaitingPaste,
  listReviewIntakeTargets,
  recordManualReview,
  resolveIntakeWithReview,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import type { AdminChrome } from '../../../../src/components/admin/google-reauth-banner.ts'
import { renderReviewsPasteHtml } from './render.ts'
import {
  PASTE_RATINGS,
  type PasteForm,
  type PasteListingOption,
  type PasteQueueItem,
  REVIEWS_PASTE_FIELDS,
  REVIEWS_PASTE_PATH,
  type ReviewsPasteRefusal,
  type ReviewsPasteView,
} from './view.ts'

/**
 * *Paste a review* — the read and the one write (G-REV-02, docs/10 §6).
 *
 * The handler rather than the route binding, so `apps/web/src/reviews-paste.itest.ts` can drive it against a
 * real PostgreSQL with an injected clock. That is not a convenience: the row this screen writes carries an
 * instant derived from a typed date, and the refusal for a date in the future needs "now" to be a value a test
 * can choose.
 *
 * ## Authorisation is server-side, through the matrix, and it survives W-SYS-11
 *
 * Two checks, in this order, and neither of them is in the render:
 *
 *   1. `principalForRequest` — Payload's own session, verified by Payload. It is the ONLY real session this
 *      application has (`apps/web/src/payload/request-principal.ts`), and it is a session rather than a query
 *      parameter: the cookie is signed, the row is loaded, and `principalFrom` narrows the stored role to one
 *      the F07 matrix knows or treats it as absent.
 *   2. `can(role, REVIEWS_PASTE_PERMISSION)` — the F07 matrix in `@berelax/core`, which is where every
 *      permission decision in this system is made.
 *
 * There is deliberately **no `?role=` parameter** here, and that is the decision this unit had to get right.
 * Several screens in this build narrow a claimed role from the query string because they have no session to
 * read; W-SYS-11 is in flight to remove exactly that, and its first acceptance line is a repository-wide scan
 * for `?role=` used to choose a principal. A form that WRITES must not be the route that fails that scan. The
 * cost is real and is stated rather than worked around: this screen is reachable only by somebody who has
 * signed into the Payload admin, because that is the only sign-in that exists today. When W-SYS-11 lands,
 * `principalForRequest` is the function that changes and nothing here does.
 *
 * No development bypass, no default user, no env-var escape hatch: an unauthenticated request gets 401 and an
 * unauthorised one gets 403, in both verbs, and the GET is refused as well as the POST — the queue shows a
 * forwarded review's full text, which is a customer's words about this business and not a public page.
 *
 * ## Why the date is required and the time is not asked for
 *
 * `google_reviews.reviewed_at` is NOT NULL and reconciliation matches a pasted row to an API row on *reviewer
 * name + rating + date* (migration 0020), read in a named zone. So the date is the field that has to be right,
 * and it is typed rather than defaulted: defaulting it to today would file every review pasted on a Monday as
 * having been left on that Monday, and reconciliation would then match nothing.
 *
 * The TIME is not asked for because the listing does not show one. The instant stored is the START of the typed
 * date in Asia/Dubai, so the date part read back in that zone is exactly what was typed — which is the only
 * property reconciliation needs. A midday time would look more precise and be equally invented.
 */

/**
 * The permission the paste form requires.
 *
 * `review:record`, added to the F07 catalogue by this unit and granted to the front desk. Recording a review
 * somebody has already published is data entry at the desk — docs/10 §6 measures it in ninety seconds — and it
 * is deliberately NOT the permission that approves a REPLY: a reply is published under the business's name on a
 * public listing and needs a human with the authority to say it (docs/07 §4), which is a separate decision
 * G-REV-05 owns.
 */
export const REVIEWS_PASTE_PERMISSION: Permission = 'review:record'

/** What the screen says for each refusal, BY NAME. A `Record` over the union, so a new name must be worded. */
const REFUSAL_SENTENCES: Readonly<Record<ReviewsPasteRefusal, string>> = {
  unreadable_request:
    'That is not a submission this form could have sent. Start again from the form below.',
  unauthenticated: 'This screen needs a signed-in admin session.',
  forbidden: 'Your role may not record a review.',
  unknown_listing:
    'That is not a listing this system manages. Choose one from the list — a review filed against ' +
    'another connection would be a reply posted to the wrong business.',
  rating_not_offered: 'Choose a rating between 1 and 5 stars.',
  reviewer_missing:
    'Type the reviewer name exactly as Google shows it, including "A Google user" when that is what it ' +
    'says. It is what reconciliation matches on when API access arrives.',
  reviewed_on_missing:
    'Type the date on the review. It is not today unless the review is from today, and it is what ' +
    'reconciliation matches on.',
  reviewed_on_not_a_date: 'That is not a date this form could read. Use the date picker.',
  reviewed_on_in_the_future:
    'That date has not happened yet. A review cannot have been left tomorrow, so this is a typo rather ' +
    'than a review.',
  intake_already_resolved:
    'That forwarded message has already been dealt with by somebody else. The review was NOT saved, ' +
    'because saving it would have been a second copy of the same review.',
  write_refused: 'The database refused the review.',
}

export interface ReviewsPasteDeps {
  readonly sql: Sql
  /** Injected, so the suite can freeze it. The future-date refusal and the row's instant both use it. */
  readonly now: () => Instant
}

export interface ReviewsPasteRequest {
  readonly searchParams: URLSearchParams
  readonly chrome: AdminChrome
  /** The POST body, or `null` for a GET. */
  readonly body: URLSearchParams | null
  /** Payload's own session, or `null`. Resolved by the route binding. */
  readonly principal: CmsPrincipal | null
  readonly requestId: string | null
}

const field = (source: URLSearchParams | null, name: string): string =>
  (source?.get(name) ?? '').trim()

/** The submitted form, echoed back so no refusal throws away what somebody typed. */
function formOf(body: URLSearchParams | null, params: URLSearchParams): PasteForm {
  const f = REVIEWS_PASTE_FIELDS
  return {
    connection: field(body, f.connection),
    placeId: field(body, f.placeId),
    rating: field(body, f.rating),
    reviewer: field(body, f.reviewer),
    reviewedOn: field(body, f.reviewedOn),
    // Never trimmed: it is a customer's words, and leading whitespace is theirs. `normaliseComment` in the
    // repository decides only whether it is empty.
    comment: body?.get(f.comment) ?? '',
    // The intake id travels in the POST body when the form was opened from a queue item, and in the query
    // string when the link was followed.
    intake:
      field(body, f.intake) === '' ? (params.get(f.intake) ?? '').trim() : field(body, f.intake),
  }
}

/** `audit_event.actor_id` is a uuid column. See {@link pasteActorFor} for why that is checked here. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The actor the audit row names.
 *
 * The principal's own id and role, from the verified session. Not a label naming the SURFACE — which is what
 * the diary, the pipeline board and the quick-book screen all record, correctly, because they have no session
 * to read — and not an invented receptionist's name, which brief rule 15 forbids and which would be
 * indistinguishable from a real one in the trail.
 *
 * The id is carried only when it is a UUID, and that is not defensiveness for its own sake. `audit_event.
 * actor_id` is a `uuid` column; Payload's id shape is a configuration choice and is an integer in a default
 * setup. A non-uuid id would make every paste a 500 from the audit insert — which is how this was found, by
 * a handler test whose fixture principal had a readable id. The LABEL always names the principal, so the row
 * identifies the actor either way, which is what the acceptance line needs.
 */
export function pasteActorFor(principal: CmsPrincipal): Actor {
  const label = `Reviews paste — cms_user ${principal.id} (${principal.role})`
  return UUID.test(principal.id)
    ? { kind: 'staff', id: principal.id, label }
    : { kind: 'staff', label }
}

/**
 * The view, with everything the caller is entitled to see and nothing else.
 *
 * `reveal` is `false` for an authorisation refusal, and it is not a nicety. The first version of this file
 * rendered the same page for every refusal, and the 401 document then carried the forwarded review's full
 * text, the connection id and the Google account email — the e2e caught it, which is the whole reason that
 * assertion is about the BYTES of the body rather than about the status code. A page that says "you may not
 * see this" must not be the page that shows it.
 */
async function viewFor(
  deps: ReviewsPasteDeps,
  request: ReviewsPasteRequest,
  extra: {
    readonly refusal: ReviewsPasteRefusal | null
    readonly created: ReviewsPasteView['created']
    readonly reveal: boolean
  },
): Promise<ReviewsPasteView & { readonly chrome: AdminChrome }> {
  const listings = extra.reveal ? await listingsFor(deps.sql) : []
  const form = formOf(request.body, request.searchParams)
  const only = listings[0]
  return {
    chrome: request.chrome,
    readAtIso: instantToIso(deps.now()),
    listings,
    queue: extra.reveal ? await queueFor(deps.sql, listings) : [],
    form:
      // Pre-fill the single listing so a GET renders the hidden inputs the form needs. With two listings the
      // operator chooses, and an unchosen select is the honest starting state.
      listings.length === 1 && only !== undefined && form.connection === ''
        ? { ...form, connection: only.connectionId, placeId: only.placeId }
        : form,
    refusal:
      extra.refusal === null
        ? null
        : { name: extra.refusal, sentence: REFUSAL_SENTENCES[extra.refusal] },
    created: extra.created,
    actorLabel:
      request.principal === null ? null : (pasteActorFor(request.principal).label ?? null),
  }
}

async function listingsFor(sql: Sql): Promise<readonly PasteListingOption[]> {
  const targets = await listReviewIntakeTargets(sql)
  if (targets.length === 0) return []
  const rows = await sql<{ id: string; google_email: string }[]>`
    select id::text as id, google_email from google_connections
    where id = any(${sql.array(targets.map((target) => target.connectionId))}::uuid[])
  `
  const emails = new Map(rows.map((row) => [row.id, row.google_email]))
  return targets.map((target) => ({
    connectionId: target.connectionId,
    placeId: target.placeId,
    googleEmail: emails.get(target.connectionId) ?? 'unknown account',
  }))
}

async function queueFor(
  sql: Sql,
  listings: readonly PasteListingOption[],
): Promise<readonly PasteQueueItem[]> {
  const items: PasteQueueItem[] = []
  for (const listing of listings) {
    for (const row of await listAwaitingPaste(sql, { connectionId: listing.connectionId })) {
      items.push({
        id: row.id,
        refusal: row.refusal,
        // The words come from `packages/core`'s table rather than from a copy here: a bare code is not a
        // thing to act on, and two spellings of the reason would drift.
        refusalSentence:
          REVIEW_EMAIL_PARSE_REFUSAL_REASONS[row.refusal as ReviewEmailParseRefusal] ??
          'the reason recorded on this item is not one this build knows',
        receivedAtIso: row.receivedAtIso,
        rawBodyBytes: row.rawBodyBytes,
        rawBody: row.rawBody,
      })
    }
  }
  return items
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** The status each refusal answers with. A refusal that answered 200 would be a form that looked saved. */
const REFUSAL_STATUS: Readonly<Record<ReviewsPasteRefusal, number>> = {
  unreadable_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  unknown_listing: 400,
  rating_not_offered: 400,
  reviewer_missing: 400,
  reviewed_on_missing: 400,
  reviewed_on_not_a_date: 400,
  reviewed_on_in_the_future: 400,
  // The item was taken by somebody else between the read and the write. The request was fine.
  intake_already_resolved: 409,
  write_refused: 503,
}

/**
 * The guard both verbs run, in one place.
 *
 * One function rather than two copies, because two copies of an authorisation check is how a GET comes to be
 * open while the POST is closed — and this GET shows a forwarded review's full text.
 */
function refuseUnauthorised(principal: CmsPrincipal | null): ReviewsPasteRefusal | null {
  if (principal === null) return 'unauthenticated'
  if (!can(principal.role satisfies Role, REVIEWS_PASTE_PERMISSION)) return 'forbidden'
  return null
}

export async function handleReviewsPasteRead(
  request: ReviewsPasteRequest,
  deps: ReviewsPasteDeps,
): Promise<Response> {
  const refused = refuseUnauthorised(request.principal)
  if (refused !== null) {
    return html(
      renderReviewsPasteHtml(
        await viewFor(deps, request, { refusal: refused, created: null, reveal: false }),
      ),
      REFUSAL_STATUS[refused],
    )
  }
  const createdId = (request.searchParams.get('created') ?? '').trim()
  const createdRating = Number(request.searchParams.get('rating') ?? '')
  const created =
    createdId === '' || !PASTE_RATINGS.includes(createdRating)
      ? null
      : {
          reviewId: createdId,
          rating: createdRating,
          starOnly: request.searchParams.get('starOnly') === '1',
          intakeResolved: request.searchParams.get('intakeResolved') === '1',
        }
  return html(
    renderReviewsPasteHtml(await viewFor(deps, request, { refusal: null, created, reveal: true })),
  )
}

export async function handleReviewsPasteWrite(
  request: ReviewsPasteRequest,
  deps: ReviewsPasteDeps,
): Promise<Response> {
  const refused = refuseUnauthorised(request.principal)
  const principal = request.principal
  if (refused !== null || principal === null) {
    return html(
      renderReviewsPasteHtml(
        await viewFor(deps, request, {
          refusal: refused ?? 'unauthenticated',
          created: null,
          reveal: false,
        }),
      ),
      REFUSAL_STATUS[refused ?? 'unauthenticated'],
    )
  }

  // A field-level refusal is shown to somebody who IS entitled to the page, so it renders the whole of it —
  // the queue and what they typed. Only the authorisation refusals above hide it.
  const refuse = async (name: ReviewsPasteRefusal): Promise<Response> =>
    html(
      renderReviewsPasteHtml(
        await viewFor(deps, request, { refusal: name, created: null, reveal: true }),
      ),
      REFUSAL_STATUS[name],
    )

  const form = formOf(request.body, request.searchParams)
  if (request.body === null || [...request.body.keys()].length === 0) {
    return await refuse('unreadable_request')
  }

  // The (connection, place) PAIR has to be one this system manages, and both halves are checked against the
  // same list. Migration 0020's trigger refuses a place that is not a resource of its connection, so a
  // mismatched pair would be a 500 from the database; refusing it here makes it a sentence the desk can act on.
  const listings = await listingsFor(deps.sql)
  const listing = listings.find(
    (candidate) =>
      candidate.connectionId === form.connection &&
      (form.placeId === '' || candidate.placeId === form.placeId),
  )
  if (listing === undefined) return await refuse('unknown_listing')

  const rating = Number(form.rating)
  if (!PASTE_RATINGS.includes(rating)) return await refuse('rating_not_offered')
  if (form.reviewer === '') return await refuse('reviewer_missing')
  if (form.reviewedOn === '') return await refuse('reviewed_on_missing')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.reviewedOn)) return await refuse('reviewed_on_not_a_date')

  // The start of the typed date in Asia/Dubai. See the header: the listing shows no time, so the instant is
  // the one whose DATE part in that zone is exactly what was typed, and nothing more is claimed.
  let reviewedAt: Instant
  try {
    reviewedAt = fromLocal(localDate(form.reviewedOn), localTime('00:00'), ASIA_DUBAI)
  } catch {
    return await refuse('reviewed_on_not_a_date')
  }
  if (reviewedAt > deps.now()) return await refuse('reviewed_on_in_the_future')

  // The intake item, read before the write so the refusal is a sentence rather than a foreign-key error. The
  // resolution itself re-checks `resolved_at is null` inside the UPDATE, which is what closes the window two
  // operators on the same item would otherwise race through.
  const intake = form.intake === '' ? undefined : await getAwaitingPasteItem(deps.sql, form.intake)
  if (form.intake !== '' && intake === undefined) return await refuse('intake_already_resolved')

  const actor = pasteActorFor(principal)
  const context = request.requestId === null ? {} : { requestId: request.requestId }
  let reviewId = ''
  let intakeResolved = false
  const starOnly = form.comment.trim() === ''
  // ONE transaction: the review, its audit row and the intake resolution commit together or not at all. An
  // intake item closed against a review that rolled back is a job somebody will never see again.
  await withUnitOfWork(
    deps.sql,
    actor,
    async (uow) => {
      const review = await recordManualReview(uow, {
        connectionId: listing.connectionId,
        placeId: listing.placeId,
        // `paste`, and not `manual`. Both are in migration 0020's vocabulary and they are different facts:
        // `paste` is this form, `manual` is a row somebody created another way. Which one it was is the
        // question an audit of the intake path asks.
        source: 'paste',
        rating,
        comment: starOnly ? null : form.comment,
        reviewerDisplayName: form.reviewer,
        reviewedAtIso: instantToIso(reviewedAt),
      })
      reviewId = review.id
      if (intake !== undefined) {
        const outcome = await resolveIntakeWithReview(uow, {
          intakeId: intake.id,
          reviewId: review.id,
          resolvedAtIso: instantToIso(deps.now()),
        })
        intakeResolved = outcome === 'resolved'
      }
    },
    context,
  )

  // 303 to this same page. Still ONE POST — a redirect is a GET — and it is what stops a reload re-posting
  // the form, which here would file the same review twice: `google_review_id` is NULL on a pasted row, so
  // nothing in the database would refuse the duplicate.
  const query = new URLSearchParams({
    created: reviewId,
    rating: String(rating),
    ...(starOnly ? { starOnly: '1' } : {}),
    ...(intakeResolved ? { intakeResolved: '1' } : {}),
  })
  return new Response(null, {
    status: 303,
    headers: { location: `${REVIEWS_PASTE_PATH}?${query.toString()}`, 'cache-control': 'no-store' },
  })
}
