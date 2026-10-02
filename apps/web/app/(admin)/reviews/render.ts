import { safeText } from '@berelax/core'
import { FALLBACK_MODE_NOTE, reviewsBanner, reviewsDocumentHead } from './document.ts'
import {
  type QueueDirection,
  type QueueRow,
  REVIEWS_QUEUE_PARAMS,
  REVIEWS_QUEUE_PATH,
  type ReviewQueueStage,
  type ReviewsQueueView,
  reviewPath,
} from './view.ts'

/**
 * *Reviews* — the approval queue (G-REV-06, docs/10 §6).
 *
 * Pure: a view in, a document out. No database, no clock — the instant the page was read at arrives on
 * the view and is printed, which is what lets two repeat captures produce identical bytes.
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * The manifest's `files` list names `page.tsx`, and this is `route.ts` + `handler.ts` + `render.ts` +
 * `view.ts` instead. Every admin surface in this build has made the same choice and records the same
 * reason: `apps/web/src/routes/registry.ts` requires every **document** to be served in BOTH locales, so a
 * `page.tsx` here would need an Arabic admin document that W-SYS-01 has not built, and it would join a
 * screenshot matrix whose RTL half has to be a real Arabic route. The three HR screens, the two settings
 * screens, the diary, the pipeline board, the Messages inbox, the template editor, the duplicate queue,
 * the quick-book screen and the paste form one directory along all give this reason. The manifest carries
 * a NOTE saying so.
 *
 * ## The list is a list
 *
 * No reply text and no review text on this page, deliberately. A queue is read to decide which item to
 * open, and a page that printed every draft would be a page nobody scrolls — and it would put a reviewer's
 * words about this business into a second place for no gain. What is here is the rating, the reviewer label
 * as Google shows it, the date, where the item stands, and **why it is escalated in plain English**.
 *
 * ## There is no auto-send control, on this page or the next
 *
 * Not because the feature is unfinished: because docs/07 §4 permits an auto-sent reply only for a 4-5 star
 * review with no free text, no named individual and no escalation term, in API mode, after a cooling-off
 * delay, with auto-send deliberately enabled by the owner — and there is no API access (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api). A
 * review that reaches this queue is a review a human answers. Nothing on either screen posts a reply, and
 * nothing on either screen offers to: the only writes are *Approve* (which lints) and *Marked as posted*
 * (which records a claim). `reviews-queue-render.test.ts` asserts that absence against the fixture that
 * carries a stored `auto_send` verdict, which is the only version of the assertion that is not vacuous.
 */

/**
 * What the screen says for each stage. A `Record` over the union, so a new stage must be worded.
 *
 * Exported so `reviews-queue-render.test.ts` can assert the property that matters about these sentences
 * rather than about one render of them: **no sentence here asserts that a reply is public.** This build
 * cannot observe the listing (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api), so the one about a manual posting attributes it to whoever said
 * so, and there is no `posted`, `published` or `live` stage for it to be worded as.
 */
export const STAGE_SENTENCE: Readonly<Record<ReviewQueueStage, string>> = {
  awaiting_a_draft: 'waiting for a draft',
  quarantined: 'no draft — the model’s answer was quarantined',
  awaiting_approval: 'drafted, waiting for a human to approve it',
  approved_not_yet_posted: 'approved — not yet claimed as posted',
  claimed_as_posted: 'a named person says they posted it',
  submitted_to_the_api: 'submitted through the API',
}

const stars = (rating: number): string => `${rating} star${rating === 1 ? '' : 's'}`

/** `?dir=rtl` carried onto every link, so the mirrored render stays mirrored as somebody navigates it. */
export function withDirection(path: string, direction: QueueDirection): string {
  if (direction !== 'rtl') return path
  return `${path}${path.includes('?') ? '&' : '?'}${REVIEWS_QUEUE_PARAMS.dir}=rtl`
}

/**
 * The escalation reason, in plain English, as the acceptance line asks for it.
 *
 * Two things, because they are two different facts (see `@berelax/core`'s `escalation-reason.ts`): the
 * ROW of the docs/07 §4 table that took the decision, and what is actually IN the review. A three-star
 * review mentioning a refund carries `rating_below_auto_send_band`, so an owner told only the rule would
 * be told about the rating and never about the refund.
 */
export function escalationHtml(row: Pick<QueueRow, 'escalation'>): string {
  const { escalation } = row
  const reasons =
    escalation.reasons.length === 0
      ? ''
      : `<ul class="reasons">${escalation.reasons
          .map(
            (reason) =>
              `<li data-reason="${safeText(reason.category)}"><strong>${safeText(reason.phrase)}</strong>` +
              ` — ${safeText(reason.why)}` +
              (reason.terms.length === 0
                ? ''
                : ` (${reason.terms.map((term) => `<code>${safeText(term)}</code>`).join(', ')})`) +
              '</li>',
          )
          .join('')}</ul>`
  const lexicon =
    escalation.lexiconVersion === null
      ? '<p class="empty">The escalation terms this verdict was judged against are not a list this ' +
        'build holds, so what the review mentions is not reported here rather than being re-read ' +
        'against today’s list.</p>'
      : ''
  return (
    `<div class="escalation" data-verdict="${safeText(escalation.verdict)}"` +
    ` data-rule="${safeText(escalation.rule ?? 'none')}">` +
    `<p><strong>${escalation.verdict === 'auto_send' ? 'Needs approval' : 'Escalated'}:</strong> ` +
    `${safeText(escalation.why)}.</p>${reasons}${lexicon}</div>`
  )
}

function queueRow(row: QueueRow, direction: QueueDirection): string {
  return (
    `<li data-review="${safeText(row.id)}">` +
    `<p><strong>${stars(row.rating)}</strong>${row.starOnly ? ' (no text)' : ''} from ` +
    `${safeText(row.reviewerDisplayName)}, left ${safeText(row.reviewedAtIso)}. ` +
    `<span class="stage">${safeText(STAGE_SENTENCE[row.stage])}</span>.</p>` +
    escalationHtml(row) +
    `<p><a class="action secondary" href="${withDirection(reviewPath(row.id), direction)}">` +
    `Open this review</a></p></li>`
  )
}

function listingControl(view: ReviewsQueueView): string {
  if (view.listings.length <= 1) {
    return view.listing === null
      ? '<p class="empty">No Google listing is connected, so there is no queue to show. Connect one ' +
          'under Settings → Integrations.</p>'
      : `<p>Showing <code>${safeText(view.listing.placeId)}</code>, connected as ` +
          `${safeText(view.listing.googleEmail)}.</p>`
  }
  // Two connections is a real configuration (docs/10 §2: the account that owns the listing need not be the
  // one verified on the site), and the pair of ids travels together because a queue scoped to one half
  // would be the other listing's reviews — which is a reply posted as the wrong business.
  return (
    '<p>Listings:</p><ul class="reasons">' +
    view.listings
      .map((listing) => {
        const query = new URLSearchParams({
          [REVIEWS_QUEUE_PARAMS.connection]: listing.connectionId,
          [REVIEWS_QUEUE_PARAMS.place]: listing.placeId,
        })
        const href = withDirection(`${REVIEWS_QUEUE_PATH}?${query.toString()}`, view.direction)
        const current = listing.placeId === view.listing?.placeId
        return (
          // Every link on these screens carries the touch floor as a CLASS rather than arriving at a
          // size through padding — see the detail render's back link, which failed `pnpm touch-targets`
          // in all four cells before this was a rule here.
          `<li><a class="action secondary" href="${href}">${safeText(listing.placeId)}</a> ` +
          `(${safeText(listing.googleEmail)})${current ? ' — showing this one' : ''}</li>`
        )
      })
      .join('') +
    '</ul>'
  )
}

/** What the page says after a successful write. A `Record`, so a new outcome must be worded. */
const OUTCOME_SENTENCE = {
  approved:
    'Approved. The reply below is the exact text that was linted — copy it, paste it into Google, and ' +
    'then record that you did.',
  posted:
    'Recorded. Your name and the time are against the statement that you pasted the reply into Google.',
} as const

/**
 * What the worklist is hiding, and the link to see it.
 *
 * "Where did it go" has to be answerable on the page. A review that somebody has claimed as posted leaves
 * the worklist — which is what makes *Marked as posted* worth clicking — and its approved text is still
 * what they may need to paste again, so the way back is a link rather than a parameter to know about.
 */
function scopeNote(view: ReviewsQueueView): string {
  const hidden = view.total - view.rows.length
  if (view.scope === 'all') {
    return (
      `<p><a class="action secondary" href="${withDirection(REVIEWS_QUEUE_PATH, view.direction)}">` +
      `Back to the ones that need somebody</a><br>This is all ${view.total} on this listing.</p>`
    )
  }
  if (hidden <= 0) {
    return '<p class="empty">Everything this listing has is on this list.</p>'
  }
  const all = `${REVIEWS_QUEUE_PATH}?${REVIEWS_QUEUE_PARAMS.show}=all`
  return (
    `<p>${hidden} review${hidden === 1 ? '' : 's'} ${hidden === 1 ? 'is' : 'are'} finished with and not ` +
    `shown.<br><a class="action secondary" href="${withDirection(all, view.direction)}">` +
    `Show all ${view.total}</a></p>`
  )
}

export function renderReviewsQueueHtml(view: ReviewsQueueView): string {
  return [
    ...reviewsDocumentHead('Reviews', view.direction),
    reviewsBanner(view.chrome),
    '<h1>Reviews</h1>',
    '<div class="policy">',
    `<p><strong>The queue as at ${safeText(view.readOnDate)} (Asia/Dubai).</strong> ` +
      `${FALLBACK_MODE_NOTE}</p>`,
    view.actorLabel === null
      ? ''
      : `<p>Signed in as <strong>${safeText(view.actorLabel)}</strong>, which is what every row this ` +
        'screen writes will name.</p>',
    '</div>',
    view.refusal === null
      ? ''
      : `<div class="refusal" data-refusal="${safeText(view.refusal.name)}">` +
        `<p><strong>Nothing was changed.</strong> ${safeText(view.refusal.sentence)}</p></div>`,
    view.outcome === null
      ? ''
      : `<div class="done" data-outcome="${safeText(view.outcome)}"><p>` +
        `${safeText(OUTCOME_SENTENCE[view.outcome])}</p></div>`,
    '<div class="card">',
    listingControl(view),
    '</div>',
    `<h2>${view.scope === 'all' ? 'Every review' : 'The queue'}</h2>`,
    scopeNote(view),
    view.rows.length === 0
      ? '<p class="empty">Nothing is waiting. A review reaches this queue because somebody pasted it in ' +
        'or forwarded the notification email — nothing polls Google.</p>'
      : `<ul class="queue">${view.rows.map((row) => queueRow(row, view.direction)).join('')}</ul>`,
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
