import { safeText } from '@berelax/core'
import { FALLBACK_MODE_NOTE, reviewsBanner, reviewsDocumentHead } from '../document.ts'
import { escalationHtml, withDirection } from '../render.ts'
import {
  APPROVE_LANGUAGES,
  markPostedPath,
  REVIEWS_APPROVE_FIELDS,
  REVIEWS_QUEUE_PATH,
  type ReviewDetailView,
  reviewPath,
} from '../view.ts'

/**
 * One review's approval screen: the draft, *Copy reply*, the deep link, *Marked as posted* (G-REV-06).
 *
 * Pure: a view in, a document out. Every claim this file makes about the world arrives on the view.
 *
 * ## Copy reply is a send path, so it copies bytes the SERVER has linted
 *
 * The bytes this control puts on a clipboard leave the system and are published under the business's name.
 * A reply that reached a clipboard without passing the linter would defeat G-REV-05 completely while every
 * assertion about `deliverApprovedReply` went on passing — so there is **no copy control for an unapproved
 * reply at all**. The textarea an owner edits is not copyable by this screen; what *Copy reply* copies is
 * `reply_approved_text`, a column nothing can write without having gone through `approveReply`, which runs
 * the same `lint(` expression the delivery runs (ADR 0063).
 *
 * The script therefore reads a `readonly` textarea the server filled, by `data-testid`, and never the
 * editable one. That is the whole of its logic, and it is why the two textareas have different ids rather
 * than one being toggled: a single element whose contents change between states is the shape in which a
 * copy control eventually copies the wrong thing.
 *
 * It degrades: the approved text is in a visible, selectable, `readonly` textarea, so an owner with
 * scripting off selects it and copies it themselves. `navigator.clipboard` is used when the browser has
 * it and `document.execCommand('copy')` over the same selection otherwise, because the first is unavailable
 * on an insecure origin and the second has been removed from none.
 *
 * ## The deep link is reconstructed, never stored and never configured
 *
 * `placeReviewsDeepLink(review.placeId)` in `@berelax/google`, from the place id denormalised onto the
 * review row by migration 0020. The link arrives on the view already built, because this file is pure and
 * the argument for building it from the row is on that function: a link built from CONFIGURATION keeps
 * working after the configuration is re-pointed at another listing, and then it sends the owner to the
 * wrong business's reviews. `pnpm gates:only --only '// 158a'` is the scan that keeps any form of that
 * URL out of first-party source.
 *
 * ## Marked as posted says whose statement it is
 *
 * There is no API access (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api), so nothing here has seen the reply on Google. The control is labelled
 * as a statement, the confirmation names the person who made it, and the record of it is refused by
 * migration 0128 unless an `audit_event` in the same transaction attributes it to a named staff actor.
 * The word "published" appears nowhere on this screen, and neither does "sent".
 */

/** The inline script. ES5 by house style, and it copies the SERVER's approved text and nothing else. */
const COPY_SCRIPT = `
  var source = document.querySelector('[data-testid="reply-approved"]')
  var button = document.querySelector('[data-testid="reply-copy"]')
  var said = document.querySelector('[data-testid="reply-copied"]')
  if (source !== null && button !== null) {
    button.addEventListener('click', function () {
      /*
        The textarea the SERVER filled with reply_approved_text, never the editable draft. A copy control
        that read the editable field would put unlinted bytes on a clipboard, which is the one thing this
        screen exists to make impossible.
      */
      var text = source.value
      var done = function () { if (said !== null) said.hidden = false }
      if (navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
        navigator.clipboard.writeText(text).then(done, function () { fallback() })
        return
      }
      fallback()
      function fallback() {
        /*
          execCommand over a real selection of the same element. Reached on an insecure origin, where
          navigator.clipboard does not exist at all — and the admin is served over plain HTTP in
          development, so this is the ordinary path there rather than a curiosity.
        */
        source.removeAttribute('readonly')
        source.focus()
        source.setSelectionRange(0, source.value.length)
        try { document.execCommand('copy') } catch (error) { /* the selection is the fallback */ }
        source.setAttribute('readonly', 'readonly')
        done()
      }
    })
  }
`

const stars = (rating: number): string => `${rating} star${rating === 1 ? '' : 's'}`

/** What the page says after a successful write on THIS screen. A `Record`, so a new outcome is worded. */
const OUTCOME_SENTENCE = {
  approved:
    'Approved, and the text below is the exact bytes the linter cleared. Copy it, paste it into Google ' +
    'with the link beside it, and then record that you did.',
  posted:
    'Recorded. This review now carries your name and the time against the statement that you pasted the ' +
    'reply into Google.',
} as const

function reviewFacts(view: ReviewDetailView): string {
  const review = view.review
  if (review === null) return ''
  return (
    '<dl>' +
    `<dt>Rating</dt><dd>${stars(review.rating)}${review.starOnly ? ' (no text)' : ''}</dd>` +
    `<dt>Reviewer</dt><dd>${safeText(review.reviewerDisplayName)}</dd>` +
    `<dt>Left</dt><dd>${safeText(review.reviewedAtIso)}</dd>` +
    `<dt>How it reached us</dt><dd>${safeText(review.source)}</dd>` +
    `<dt>Delivery mode</dt><dd>${safeText(review.deliveryMode)}</dd>` +
    `<dt>Listing</dt><dd><code>${safeText(review.placeId)}</code></dd>` +
    '</dl>'
  )
}

function reviewText(view: ReviewDetailView): string {
  const review = view.review
  if (review === null) return ''
  if (review.comment === null) {
    return (
      '<p class="empty">A star-only review: the reviewer left no text. docs/10 §7 records these as ' +
      'common, and a reply to one says nothing about a treatment because there is nothing to answer.</p>'
    )
  }
  // The reviewer's own words, escaped, shown once. Untrusted input: it is a prompt-injection surface
  // (G-REV-04 fences it inside one delimited region) and this is where a human reads it.
  return `<pre data-testid="review-text">${safeText(review.comment)}</pre>`
}

/** The editable draft and the server-side approve control. Absent once the reply has been delivered. */
function approveForm(view: ReviewDetailView): string {
  const review = view.review
  if (review === null) return ''
  if (review.postedManuallyAtIso !== null || review.submittedAtIso !== null) {
    return (
      '<p class="empty">This reply has been delivered, so its record is closed: migration 0128 refuses ' +
      'a change to the approved text, its digest or the delivery instant. A reply that was wrong is ' +
      'corrected by posting a new one on Google, not by editing what this row says was posted.</p>'
    )
  }
  const f = REVIEWS_APPROVE_FIELDS
  const rules =
    view.lintRules.length === 0
      ? ''
      : `<ul class="reasons">${view.lintRules
          .map((rule) => `<li data-rule="${safeText(rule)}"><code>${safeText(rule)}</code></li>`)
          .join('')}</ul>`
  return (
    `<form method="post" action="${withDirection(reviewPath(review.id), view.direction)}">` +
    `<label for="reply-draft">The reply, as it will be published` +
    `<textarea id="reply-draft" data-testid="reply-draft" name="${f.reply}" rows="8" required>` +
    `${safeText(view.editing)}</textarea></label>` +
    `<label for="reply-language">The language it is written in` +
    `<select id="reply-language" data-testid="reply-language" name="${f.language}">` +
    APPROVE_LANGUAGES.map(
      (language) =>
        `<option value="${language}"${language === view.language ? ' selected' : ''}>` +
        `${language === 'en' ? 'English' : 'Arabic'}</option>`,
    ).join('') +
    '</select></label>' +
    rules +
    '<button type="submit" data-testid="reply-approve">Approve this reply</button>' +
    '</form>'
  )
}

/** *Copy reply*, the deep link and *Marked as posted*. Rendered only once a lint pass is on the row. */
function approvedPanel(view: ReviewDetailView): string {
  const review = view.review
  if (review === null) return ''
  const approved = review.approvedText
  if (approved === null) {
    return (
      '<p class="empty">Nothing has been approved yet, so there is nothing to copy. docs/10 §6 makes ' +
      'human approval mandatory: the bytes this screen copies are the bytes a linter cleared, and until ' +
      'one has there are none.</p>'
    )
  }
  const posted = review.postedManuallyAtIso !== null
  const link = view.deepLink
  return (
    '<div class="card">' +
    `<label for="reply-approved">The approved reply, byte for byte` +
    `<textarea id="reply-approved" data-testid="reply-approved" rows="8" readonly>` +
    `${safeText(approved)}</textarea></label>` +
    '<div class="actions">' +
    '<button type="button" data-testid="reply-copy">Copy reply</button>' +
    (link === null
      ? ''
      : `<a class="action secondary" data-testid="reply-deep-link" href="${safeText(link)}" ` +
        'target="_blank" rel="noreferrer noopener">Open this listing on Google</a>') +
    '</div>' +
    '<p data-testid="reply-copied" hidden>Copied. Paste it into the reply box on Google.</p>' +
    `<p class="empty">Cleared by rule set <code>${safeText(review.lintVersion ?? 'unknown')}</code>; ` +
    `digest <code>${safeText(review.contentSha256 ?? 'unknown')}</code>. Those two are what let the ` +
    'decision be re-run later against the rules that took it.</p>' +
    (posted
      ? `<p><strong>A named person has recorded that they pasted this reply into Google at ` +
        `${safeText(review.postedManuallyAtIso ?? '')}.</strong> That is their statement. Nothing in ` +
        'this build can read the listing, so there is no confirmation to show beside it — the audit ' +
        'trail is where their name is.</p>'
      : `<form method="post" action="${withDirection(markPostedPath(review.id), view.direction)}">` +
        '<p>Once you have pasted it into Google, record that you did. This writes your name and the ' +
        'time against the statement — it does not check Google, because this build cannot.</p>' +
        '<button type="submit" data-testid="reply-mark-posted">I have posted this reply</button>' +
        '</form>') +
    '</div>'
  )
}

function quarantinePanel(view: ReviewDetailView): string {
  const reason = view.review?.quarantineReason ?? null
  if (reason === null) return ''
  return (
    `<div class="escalation" data-quarantine="${safeText(reason)}"><p><strong>No draft was kept.</strong> ` +
    `The model’s answer was quarantined as <code>${safeText(reason)}</code> (G-REV-04), so there is no ` +
    'machine sentence to start from. Write the reply yourself in the box below — it goes through the ' +
    'same linter either way.</p></div>'
  )
}

export function renderReviewDetailHtml(view: ReviewDetailView): string {
  const review = view.review
  return [
    ...reviewsDocumentHead(
      review === null ? 'Review' : `Review — ${stars(review.rating)}`,
      view.direction,
    ),
    reviewsBanner(view.chrome),
    // `.action secondary` and not a bare anchor: docs/08 §4's floor is 48x48px on a phone and
    // `pnpm touch-targets` measures the LAID-OUT box, so a navigational link in a paragraph is 19px tall
    // and fails. It failed here first, on both directions and both viewports.
    `<p><a class="action secondary" href="${withDirection(REVIEWS_QUEUE_PATH, view.direction)}">` +
      'Back to the queue</a></p>',
    '<h1>One review</h1>',
    '<div class="policy">',
    `<p><strong>Read on ${safeText(view.readOnDate)} (Asia/Dubai).</strong> ${FALLBACK_MODE_NOTE}</p>`,
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
    review === null
      ? '<p class="empty">There is no such review on any listing this system manages.</p>'
      : [
          '<div class="card">',
          reviewFacts(view),
          '</div>',
          escalationHtml({ escalation: review.escalation }),
          '<h2>What the reviewer wrote</h2>',
          reviewText(view),
          quarantinePanel(view),
          '<h2>The reply</h2>',
          '<div class="card">',
          approveForm(view),
          '</div>',
          '<h2>Posting it</h2>',
          approvedPanel(view),
        ].join(''),
    '</main>',
    `<script>${COPY_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('')
}
