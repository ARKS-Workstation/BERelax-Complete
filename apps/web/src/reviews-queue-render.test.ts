import { explainReviewEscalation, REVIEW_ESCALATION_LEXICON_VERSION } from '@berelax/core'
import type { QueuedReview } from '@berelax/db'
import { placeReviewsDeepLink } from '@berelax/google'
import { describe, expect, it } from 'vitest'
import { renderReviewDetailHtml } from '../app/(admin)/reviews/[id]/render.ts'
import { queueRowFrom, reviewDetailFrom, stageOf } from '../app/(admin)/reviews/queue-row.ts'
import { renderReviewsQueueHtml, STAGE_SENTENCE } from '../app/(admin)/reviews/render.ts'
import {
  REVIEW_QUEUE_STAGES,
  type ReviewDetailView,
  type ReviewsQueueView,
} from '../app/(admin)/reviews/view.ts'

/**
 * G-REV-06 — the two approval-queue documents, rendered from views a test builds.
 *
 * Here and not in the integration suite because every claim below is about the DOCUMENT, and three of
 * them are about rows a database should not be made to hold: a review carrying a stored `auto_send`
 * verdict, a review whose lexicon version this build cannot resolve, and a delivered review whose record
 * is closed. The served-response claims — the status codes, the clipboard, axe, the screenshots — are in
 * `reviews-queue.itest.ts`, which needs a browser for all four.
 *
 * Every absence assertion here is paired with a control that proves the query would have found something
 * (brief rule 3). `expect(html).not.toContain(x)` over a page that was never going to contain `x` is the
 * assertion that passes for ever.
 */

const PLACE = 'ChIJ_render_fixture_place'
const VERSION = REVIEW_ESCALATION_LEXICON_VERSION

/** A row as `listReviewQueue` returns one. Every field explicit, so a widened type fails here first. */
function row(overrides: Partial<QueuedReview> = {}): QueuedReview {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    connectionId: '22222222-2222-4222-8222-222222222222',
    placeId: PLACE,
    googleReviewId: null,
    source: 'paste',
    deliveryMode: 'manual',
    rating: 1,
    comment: 'One star. I asked for a refund and nobody answered.',
    // A record label of the family `packages/fixtures/src/synthetic.ts` argues for, not an invented
    // person (brief rule 15). It is what Google shows when a reviewer has no public name.
    reviewerDisplayName: 'A Google user',
    reviewedAtIso: '2026-09-20T06:00:00.000Z',
    replyDraft:
      'Thank you for telling us. Please contact the salon directly so we can look into it.',
    submittedAtIso: null,
    confirmedAtIso: null,
    postedManuallyAtIso: null,
    routingVerdict: 'escalate',
    routingRuleId: 'rating_escalates',
    routingLexiconVersion: VERSION,
    routedAtIso: '2026-09-20T07:00:00.000Z',
    replyDraftSkeletonId: 'apology',
    replyDraftAspects: [],
    replyDraftLanguage: 'en',
    replyDraftPromptVersion: 'g-rev-04-1',
    replyDraftPromptFingerprint: 'f'.repeat(64),
    replyDraftGeneratedAtIso: '2026-09-20T07:01:00.000Z',
    draftQuarantineReason: null,
    draftQuarantinedAtIso: null,
    replyApprovedText: null,
    replyLintVersion: null,
    replyLintContentSha256: null,
    replyLintPassedAtIso: null,
    ...overrides,
  }
}

const queueView = (overrides: Partial<ReviewsQueueView> = {}): ReviewsQueueView => ({
  chrome: { googleReauth: null, returnTo: '/reviews' },
  direction: 'ltr',
  readOnDate: '2026-09-21',
  listings: [{ connectionId: 'c', placeId: PLACE, googleEmail: 'owner@example.test' }],
  listing: { connectionId: 'c', placeId: PLACE, googleEmail: 'owner@example.test' },
  scope: 'open',
  total: 1,
  rows: [queueRowFrom(row())],
  refusal: null,
  outcome: null,
  actorLabel: 'Reviews approval — employee 1 (owner)',
  ...overrides,
})

const detailView = (
  source: QueuedReview = row(),
  overrides: Partial<ReviewDetailView> = {},
): ReviewDetailView => ({
  chrome: { googleReauth: null, returnTo: '/reviews' },
  direction: 'ltr',
  readOnDate: '2026-09-21',
  listing: { connectionId: 'c', placeId: PLACE, googleEmail: 'owner@example.test' },
  review: reviewDetailFrom(source),
  deepLink: placeReviewsDeepLink(source.placeId),
  editing: source.replyDraft ?? '',
  language: 'en',
  refusal: null,
  lintRules: [],
  outcome: null,
  actorLabel: 'Reviews approval — employee 1 (owner)',
  ...overrides,
})

/**
 * The interactive controls of a rendered document, as a set.
 *
 * Split at `<script>` first, and that is the defect this helper exists because of: the inline copy script
 * NAMES every selector it uses, so `html.includes('data-testid="reply-copy"')` is true on a page that
 * renders no copy button at all. The first version of the absence assertions below passed for the wrong
 * reason in one direction and failed for the wrong reason in the other.
 */
function controlsOf(html: string): readonly string[] {
  const body = html.split('<script>')[0] ?? ''
  return [...body.matchAll(/data-testid="([^"]+)"/g)].map((match) => match[1] ?? '').sort()
}

describe('acceptance — an escalated review shows the matched rule in plain English', () => {
  it('names the rule and what is in the review, for a one-star fixture', () => {
    const html = renderReviewDetailHtml(detailView(row()))
    // The rule's own sentence, from the docs/07 §4 table. Not re-worded on the screen.
    expect(html).toContain('a one- or two-star review is always escalated to a human')
    // And what the text mentions, which the rule id does not say.
    expect(html).toContain('mentions a refund')
    expect(html).toContain('data-reason="refund"')
    expect(html).toContain('data-rule="rating_escalates"')
  })

  it('names the refund for a refund-mentioning fixture whose rating is not escalating', () => {
    // Four stars, so `rating_escalates` cannot be the rule. docs/07 §4 row 3 is.
    const refund = row({
      rating: 4,
      comment: 'Four stars for the room but I am still waiting for a refund on the second session.',
      routingRuleId: 'escalation_term_present',
    })
    const html = renderReviewDetailHtml(detailView(refund))
    expect(html).toContain('data-rule="escalation_term_present"')
    expect(html).toContain('mentions a refund')
    // The control: a four-star review with nothing in it shows NO reason list, so the phrase above is
    // produced by the text rather than printed on every page.
    const quiet = renderReviewDetailHtml(
      detailView(
        row({
          rating: 4,
          comment: 'Four stars. The room was quiet.',
          routingRuleId: 'free_text_present',
        }),
      ),
    )
    expect(quiet).not.toContain('mentions a refund')
    expect(quiet).not.toContain('data-reason=')
    expect(quiet).toContain('data-rule="free_text_present"')
  })

  it('says it cannot report the categories when the stored lexicon version is unknown', () => {
    const stale = row({ routingLexiconVersion: '1999-01-01' })
    const html = renderReviewDetailHtml(detailView(stale))
    expect(html).toContain('not a list this build holds')
    expect(html).not.toContain('data-reason="refund"')
    // The control, and the whole point: the same text under the version the verdict names DOES report it.
    expect(renderReviewDetailHtml(detailView(row()))).toContain('data-reason="refund"')
  })
})

describe('acceptance — the DOM contains no auto-send control', () => {
  /**
   * Every control the detail screen may render, as a set.
   *
   * The assertion is about the SET and not about the absence of a word, and that is the second attempt:
   * the first scanned the document for `auto-send`, which the docs/07 §4 table's own rule sentences
   * contain in prose — `quiet_high_rating_may_auto_send`'s `why` ends "with auto-send deliberately enabled
   * by the owner". A page explaining why a reply may NOT be auto-sent has to be able to say the words.
   *
   * So the measurement is: these are the controls, an auto-send affordance would be one more, and the set
   * is read off the rendered body with the inline script's own selectors excluded.
   */
  const DETAIL_CONTROLS = [
    'reply-approve',
    'reply-approved',
    'reply-copied',
    'reply-copy',
    'reply-deep-link',
    'reply-draft',
    'reply-language',
    'reply-mark-posted',
    'review-text',
  ] as const

  const approved = (overrides: Partial<QueuedReview> = {}) =>
    row({
      replyApprovedText: 'Thank you for telling us. Please contact the salon directly.',
      replyLintVersion: 'g-rev-05-send-path-1',
      replyLintContentSha256: 'b'.repeat(64),
      replyLintPassedAtIso: '2026-09-21T05:00:00.000Z',
      ...overrides,
    })

  it('renders only declared controls, for a one-star and a refund-mentioning fixture', () => {
    for (const fixture of [
      approved(),
      approved({
        rating: 5,
        comment: 'Five stars but please refund the extra charge.',
        routingRuleId: 'escalation_term_present',
      }),
    ]) {
      const controls = controlsOf(renderReviewDetailHtml(detailView(fixture)))
      // The control that makes the comparison meaningful: the page really does render controls, so an
      // empty set would fail here rather than satisfy the subset assertion below.
      expect(controls.length, String(fixture.routingRuleId)).toBeGreaterThan(4)
      for (const control of controls) {
        expect(
          DETAIL_CONTROLS,
          `declared-controls-only ${String(fixture.routingRuleId)}: ${control}`,
        ).toContain(control)
      }
    }
  })

  it('renders no control that sends, even for a row carrying a stored auto_send verdict', () => {
    /*
      The version of this assertion that is not vacuous. docs/07 §4's one permissive row exists, and a row
      written by a build with auto-send enabled in API mode could carry it — so "this screen never offers
      to send" has to be a claim about THAT row and not only about the escalated ones, where there was
      never a question.
    */
    const permitted = approved({
      rating: 5,
      comment: null,
      routingVerdict: 'auto_send',
      routingRuleId: 'quiet_high_rating_may_auto_send',
      replyDraft: 'Thank you for the rating. We look forward to welcoming you back.',
    })
    const html = renderReviewDetailHtml(detailView(permitted))
    // The explanation reports the stored verdict honestly rather than hiding it...
    expect(
      explainReviewEscalation({
        comment: permitted.comment,
        routingRuleId: permitted.routingRuleId,
        routingLexiconVersion: permitted.routingLexiconVersion,
      }).verdict,
    ).toBe('auto_send')
    expect(html).toContain('data-verdict="auto_send"')
    // ...and the screen still demands approval, and still renders only the declared controls.
    expect(html).toContain('Needs approval')
    for (const control of controlsOf(html)) {
      expect(DETAIL_CONTROLS, `declared-controls-only: ${control}`).toContain(control)
    }
    // Every form on the page posts to this review or to its mark-posted endpoint. Nothing else.
    const actions = [...html.matchAll(/<form[^>]*action="([^"]*)"/g)].map((match) => match[1] ?? '')
    expect(actions.length).toBeGreaterThan(0)
    for (const action of actions) {
      expect(action).toMatch(/^\/reviews\/[^/]+(\/mark-posted)?(\?dir=rtl)?$/)
    }
    // And the queue page carries no form and no control at all: it is a list of links.
    const queue = renderReviewsQueueHtml(queueView({ rows: [queueRowFrom(permitted)] }))
    expect(queue).toContain('Open this review')
    expect(queue).not.toContain('<form')
    expect(controlsOf(queue)).toEqual([])
  })
})

describe('acceptance — the deep link is reconstructed from the stored placeId', () => {
  /** The `href` as the browser would read it. `safeText` escapes the `&`s of a query string. */
  const deepLinkIn = (html: string): string | null => {
    const found = /data-testid="reply-deep-link" href="([^"]*)"/.exec(html)
    return found === null ? null : (found[1] ?? '').replaceAll('&amp;', '&')
  }

  const stamped = (overrides: Partial<QueuedReview> = {}) =>
    row({
      replyApprovedText: 'Thank you.',
      replyLintVersion: 'g-rev-05-send-path-1',
      replyLintContentSha256: 'a'.repeat(64),
      replyLintPassedAtIso: '2026-09-21T05:00:00.000Z',
      ...overrides,
    })

  it('renders exactly what placeReviewsDeepLink builds, from the row', () => {
    // Byte-identical to the one implementation of this URL in the build. A second template would be a
    // second answer to "where is this listing", and gate 158a is the scan that keeps one out of source.
    expect(deepLinkIn(renderReviewDetailHtml(detailView(stamped())))).toBe(
      placeReviewsDeepLink(PLACE),
    )
    // The place id is in the link because it is on the ROW: change the row, change the link. Without this
    // the assertion above would pass against a link built from anything that happened to equal PLACE.
    const other = 'ChIJ_render_fixture_other'
    expect(deepLinkIn(renderReviewDetailHtml(detailView(stamped({ placeId: other }))))).toBe(
      placeReviewsDeepLink(other),
    )
    expect(
      deepLinkIn(renderReviewDetailHtml(detailView(stamped({ placeId: other })))),
    ).not.toContain(PLACE)
  })

  it('renders no link at all when there is no review, rather than a link to nothing', () => {
    const missing = renderReviewDetailHtml(detailView(row(), { review: null, deepLink: null }))
    expect(deepLinkIn(missing)).toBeNull()
    expect(controlsOf(missing)).toEqual([])
  })
})

describe('Copy reply copies the approved bytes and nothing else', () => {
  it('renders no copy control at all before an approval', () => {
    const html = renderReviewDetailHtml(detailView(row()))
    // Read off the rendered BODY, because the inline script names every selector it uses - see
    // `controlsOf`. The first version of this assertion was satisfied by the script.
    expect(controlsOf(html)).not.toContain('reply-copy')
    expect(controlsOf(html)).not.toContain('reply-approved')
    expect(html).toContain('Nothing has been approved yet')
    // The control: the editable draft IS on the page, so the absences above are about the copy control
    // and not about an empty render.
    expect(controlsOf(html)).toContain('reply-draft')
  })

  it('reads the server-filled readonly textarea, never the editable one', () => {
    const approved = row({
      replyApprovedText: 'Thank you for telling us. Please contact the salon directly.',
      replyLintVersion: 'g-rev-05-send-path-1',
      replyLintContentSha256: 'b'.repeat(64),
      replyLintPassedAtIso: '2026-09-21T05:00:00.000Z',
    })
    const html = renderReviewDetailHtml(detailView(approved))
    expect(controlsOf(html)).toContain('reply-copy')
    expect(controlsOf(html)).toContain('reply-approved')
    expect(html).toContain('Thank you for telling us. Please contact the salon directly.')
    // The script's source element is the APPROVED textarea. Asserted on the script, because that one
    // string is what decides which bytes reach a clipboard.
    const script = html.split('<script>')[1] ?? ''
    // Labelled, because gate 158d breaks exactly this line and a gate's known-bad fixture has to fail
    // by the NAME of the rule rather than by a diff of two selectors (ADR 0003).
    expect(script, 'copy-reads-the-approved-text').toContain('[data-testid="reply-approved"]')
    expect(script, 'copy-reads-the-approved-text').not.toContain('[data-testid="reply-draft"]')
    // The approved textarea is readonly, so the bytes on the page are the bytes the server stored.
    expect(html).toMatch(/id="reply-approved"[^>]*readonly/)
    // The stamp is shown, because those two fields are what make the decision reproducible later.
    expect(html).toContain('g-rev-05-send-path-1')
    expect(html).toContain('b'.repeat(64))
  })
})

describe('Marked as posted is presented as a claim, never as an observation', () => {
  it('names no stage that asserts a reply is public, and attributes the one about posting', () => {
    /*
      The vocabulary rather than one render of it. A scan of the document for the word "published" was the
      first attempt and it was wrong in both directions: the approval label legitimately says "as it will
      be published", and a page could claim an observation without ever using that word. What IS checkable
      is the closed set of stages and the sentence each one is worded with.
    */
    expect(REVIEW_QUEUE_STAGES).not.toContain('posted')
    expect(REVIEW_QUEUE_STAGES).not.toContain('published')
    expect(REVIEW_QUEUE_STAGES).not.toContain('live')
    expect(STAGE_SENTENCE.claimed_as_posted, 'the-claim-names-who-said-so').toMatch(/says they/)
    for (const stage of REVIEW_QUEUE_STAGES) {
      expect(STAGE_SENTENCE[stage], stage).not.toMatch(/\bis (published|live)\b/)
    }
    // The control: the sentences are not all the same cautious string, so the match above is a property
    // of the one about posting rather than of every entry.
    expect(STAGE_SENTENCE.awaiting_approval).not.toMatch(/says they/)
  })

  it('labels the control as a statement and says the build cannot read Google', () => {
    const approved = row({
      replyApprovedText: 'Thank you.',
      replyLintVersion: 'v',
      replyLintContentSha256: 'c'.repeat(64),
      replyLintPassedAtIso: '2026-09-21T05:00:00.000Z',
    })
    const html = renderReviewDetailHtml(detailView(approved))
    expect(controlsOf(html)).toContain('reply-mark-posted')
    expect(html).toContain('I have posted this reply')
    expect(html).toContain('it does not check Google, because this build cannot')
    // And the note on every page of this screen says whose statement it is.
    expect(html).toContain('never an observation of the listing')
  })

  it('attributes the claim to a person once it is made, and closes the record', () => {
    const posted = row({
      replyApprovedText: 'Thank you.',
      replyLintVersion: 'v',
      replyLintContentSha256: 'c'.repeat(64),
      replyLintPassedAtIso: '2026-09-21T05:00:00.000Z',
      postedManuallyAtIso: '2026-09-21T05:30:00.000Z',
    })
    const html = renderReviewDetailHtml(detailView(posted))
    expect(html).toContain('A named person has recorded that they pasted this reply into Google')
    expect(html).toContain('2026-09-21T05:30:00.000Z')
    // No second claim, and no further editing: the record is closed and the page names the rule.
    expect(controlsOf(html)).not.toContain('reply-mark-posted')
    expect(controlsOf(html)).not.toContain('reply-draft')
    expect(html).toContain('migration 0128 refuses')
    // Copy reply survives, because those bytes are still what somebody may need to paste again.
    expect(controlsOf(html)).toContain('reply-copy')
  })
})

describe('the stage is derived in one place and named for what it is', () => {
  it('reads from the end of life backwards', () => {
    expect(stageOf(row({ replyDraft: null }))).toBe('awaiting_a_draft')
    expect(stageOf(row({ replyDraft: null, draftQuarantineReason: 'response_absent' }))).toBe(
      'quarantined',
    )
    expect(stageOf(row())).toBe('awaiting_approval')
    expect(stageOf(row({ replyApprovedText: 'x' }))).toBe('approved_not_yet_posted')
    expect(
      stageOf(row({ replyApprovedText: 'x', postedManuallyAtIso: '2026-09-21T05:30:00.000Z' })),
    ).toBe('claimed_as_posted')
    // A delivered row is delivered whatever else is on it, which is why the order is the content.
    expect(
      stageOf(
        row({
          replyDraft: null,
          draftQuarantineReason: 'response_absent',
          submittedAtIso: '2026-09-21T05:30:00.000Z',
        }),
      ),
    ).toBe('submitted_to_the_api')
  })

  it('says a person CLAIMED it, and the queue prints that sentence', () => {
    const posted = row({ replyApprovedText: 'x', postedManuallyAtIso: '2026-09-21T05:30:00.000Z' })
    const queue = renderReviewsQueueHtml(queueView({ rows: [queueRowFrom(posted)] }))
    expect(queue).toContain('a named person says they posted it')
    // The control: the same page for an unapproved review says something else, so the sentence above is
    // the stage's and not the page's.
    expect(renderReviewsQueueHtml(queueView())).toContain('waiting for a human to approve it')
  })
})

describe('the mirrored render is a layout axis', () => {
  it('flips dir and carries ?dir=rtl onto every link, with the same language', () => {
    const rtl = renderReviewsQueueHtml(queueView({ direction: 'rtl' }))
    expect(rtl).toContain('<html lang="en" dir="rtl">')
    expect(rtl).toContain('?dir=rtl')
    // The control: the LTR render carries neither, so the flip is produced by the view.
    const ltr = renderReviewsQueueHtml(queueView())
    expect(ltr).toContain('<html lang="en" dir="ltr">')
    expect(ltr).not.toContain('dir=rtl')
  })

  it('posts the approval back to the mirrored URL, so a refusal stays mirrored', () => {
    const rtl = renderReviewDetailHtml(detailView(row(), { direction: 'rtl' }))
    expect(rtl).toMatch(/<form method="post" action="\/reviews\/[^"]+\?dir=rtl"/)
  })
})

describe('an authorisation refusal reveals nothing', () => {
  it('shows neither the reviewer, the review text nor the draft', () => {
    // The shape the paste form next door got wrong first: its 401 document carried the forwarded review's
    // full text, the connection id and the Google account email. Here the view is built with `reveal:
    // false`, so there is no review on it at all — and this asserts the DOCUMENT, because that is what a
    // refused caller receives.
    const refused = renderReviewDetailHtml(
      detailView(row(), {
        review: null,
        deepLink: null,
        listing: null,
        editing: '',
        actorLabel: null,
        refusal: { name: 'forbidden', sentence: 'Your role may not approve a reply.' },
      }),
    )
    expect(refused).toContain('data-refusal="forbidden"')
    expect(refused).not.toContain('A Google user')
    expect(refused).not.toContain('refund')
    expect(refused).not.toContain(PLACE)
    // The control: the authorised render DOES contain all three, so the absences are the refusal's.
    const allowed = renderReviewDetailHtml(detailView(row()))
    expect(allowed).toContain('A Google user')
    expect(allowed).toContain('refund')
    expect(allowed).toContain(PLACE)
  })
})
