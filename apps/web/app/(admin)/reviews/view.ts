import type { ReviewEscalationExplanation } from '@berelax/core'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'

/**
 * The approval queue's vocabulary: the paths, the field names, the refusals and the two views (G-REV-06).
 *
 * One module for both screens, for the reason `REVIEWS_PASTE_FIELDS` next door gives: the queue, the
 * detail view, their two renders, their handlers and the e2e all need the same strings, and a literal in
 * six files is six chances for one of them to be the typo that makes a field arrive empty. The e2e drives
 * the real controls by these names, so a renamed field fails a test rather than a screen.
 */

/** The queue. One constant, so a link, a form `action` and the registry entry cannot disagree. */
export const REVIEWS_QUEUE_PATH = '/reviews'

/** One review's approval screen. `${REVIEW_PATH_PREFIX}${id}` — the registry declares `/reviews/[id]`. */
export const REVIEW_PATH_PREFIX = '/reviews/'

/** The POST that records a named human's claim to have pasted the reply into Google. */
export const MARK_POSTED_SEGMENT = '/mark-posted'

/** The path of one review's detail screen. */
export const reviewPath = (id: string): string => `${REVIEW_PATH_PREFIX}${encodeURIComponent(id)}`

/** The path of one review's *Marked as posted* endpoint. */
export const markPostedPath = (id: string): string => `${reviewPath(id)}${MARK_POSTED_SEGMENT}`

/**
 * The query parameters both screens read.
 *
 * `dir` mirrors the layout and is a LAYOUT axis rather than a locale — the device the duplicate queue and
 * the leave screen use, and why the accessibility matrix can have a direction half without an Arabic admin
 * document existing. Nothing here chooses a principal, a role or a permission: that is a repository-wide
 * refusal (W-SYS-11) and this screen writes.
 */
export const REVIEWS_QUEUE_PARAMS = {
  dir: 'dir',
  /** Which listing to show, when this system manages more than one. Both halves travel together. */
  connection: 'connection',
  place: 'place',
  /** Set after a successful approval or claim, so the page after the 303 says what happened. */
  done: 'done',
  /**
   * `open` (the default) or `all`.
   *
   * The queue is a WORKLIST, so by default it holds the reviews that still need somebody: anything not
   * yet claimed as posted or submitted through the API. docs/10 §6's own sentence is that the owner
   * "clicks *Marked as posted*", and the thing that makes that step worth taking is that the item then
   * leaves the list — a queue that keeps every review it has ever seen is a queue nobody reaches the
   * bottom of, and on a listing with a hundred reviews the five that need a reply would be invisible.
   *
   * `all` is a link on the page rather than a hidden parameter, because "where did it go" has to be
   * answerable: a finished review is still readable, and its approved text is still what somebody may
   * need to paste again.
   */
  show: 'show',
} as const

/** What the queue lists. See {@link REVIEWS_QUEUE_PARAMS.show}. */
export const QUEUE_SCOPES = ['open', 'all'] as const
export type QueueScope = (typeof QUEUE_SCOPES)[number]

/** `ltr` or `rtl`. A layout axis; see {@link REVIEWS_QUEUE_PARAMS}. */
export type QueueDirection = 'ltr' | 'rtl'

/**
 * The fields the approval form posts.
 *
 * `reply` is the only one that carries content, and it is the bytes the owner is approving — which may not
 * be the machine's draft. G-REV-05's `deliverApprovedReply` takes the approved text as an argument for
 * exactly this reason, so the bytes that are judged are the bytes that go out.
 *
 * There is deliberately no field for the delivery mode, the verdict, the lint version or the hash. The
 * mode is the intake path's answer (0020), the verdict is the routing table's (G-REV-03), and the version
 * and the hash are produced by the linter — a form field for any of them would be a way to claim a lint
 * pass that never happened.
 */
export const REVIEWS_APPROVE_FIELDS = {
  reply: 'reply',
  /** The language the approver says the reply is in. The linter checks the claim from both sides. */
  language: 'language',
} as const

/** The languages the approval form offers, which is what the linter can identify. */
export const APPROVE_LANGUAGES = ['en', 'ar'] as const
export type ApproveLanguage = (typeof APPROVE_LANGUAGES)[number]

/** Why a request was refused, by name. A closed set, so a refusal with no wording is a type error. */
export const REVIEWS_QUEUE_REFUSALS = [
  'unreadable_request',
  'unauthenticated',
  'forbidden',
  'unknown_review',
  'reply_missing',
  'language_not_offered',
  'reply_refused_by_the_linter',
  'nothing_approved_to_post',
  'already_posted',
  'write_refused',
] as const
export type ReviewsQueueRefusal = (typeof REVIEWS_QUEUE_REFUSALS)[number]

/** What happened, for the page after the 303. A closed set for the same reason as the refusals. */
export const REVIEWS_QUEUE_OUTCOMES = ['approved', 'posted'] as const
export type ReviewsQueueOutcome = (typeof REVIEWS_QUEUE_OUTCOMES)[number]

/** One listing this system manages, as the queue scopes itself to it. */
export interface QueueListing {
  readonly connectionId: string
  readonly placeId: string
  readonly googleEmail: string
}

/**
 * Where one review stands, as a closed set rather than a derived sentence in two renders.
 *
 * `posted` is the END of fallback mode and it is named for what it is: somebody SAID they posted it. There
 * is no `published` and no `live`, because this build cannot observe either (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api) — see the detail
 * render on why that distinction is on the screen and not only in a comment.
 */
export const REVIEW_QUEUE_STAGES = [
  'awaiting_a_draft',
  'quarantined',
  'awaiting_approval',
  'approved_not_yet_posted',
  'claimed_as_posted',
  'submitted_to_the_api',
] as const
export type ReviewQueueStage = (typeof REVIEW_QUEUE_STAGES)[number]

/** One review as the queue lists it. Carries no reply text: the list is a list. */
export interface QueueRow {
  readonly id: string
  readonly rating: number
  /** `true` for a review with no comment text at all — docs/10 §7 records these as common. */
  readonly starOnly: boolean
  readonly reviewerDisplayName: string
  readonly reviewedAtIso: string
  readonly stage: ReviewQueueStage
  /** The stored verdict explained, from `@berelax/core`. Never re-routed here. */
  readonly escalation: ReviewEscalationExplanation
}

export interface ReviewsQueueView {
  /** Which reviews are listed, and the count the other scope would have shown. */
  readonly scope: QueueScope
  /** How many reviews this listing has in total, so the page can say what `open` is hiding. */
  readonly total: number
  /**
   * The Google re-auth banner's view (G-CONN-08), typed rather than `unknown`.
   *
   * The paste form next door types this `unknown` and reassembles it in the render signature, which is
   * where a hand-built fixture for THIS screen first went wrong: `{ reauth: null }` satisfied `unknown`
   * and threw inside the banner at render time, in a test whose subject was something else entirely.
   */
  readonly chrome: AdminChrome
  readonly direction: QueueDirection
  /**
   * The local DATE the page was read on, in the business zone — not the instant.
   *
   * A date and not an instant because of this unit's own screenshot criterion: *zero pixel diff on an
   * unchanged rerun*. A page printing the instant it was read at cannot be photographed twice, and
   * `captureUntilStable` reports exactly that — "every capture differed, with no digest repeating, which
   * is what a clock reaching the render produces". It was an instant first and this is what it cost.
   *
   * The claim worth printing is the one a date makes anyway: this is today's queue and not a cached copy
   * of last week's. The route also answers `no-store`, which is the half a reader cannot see.
   */
  readonly readOnDate: string
  readonly listings: readonly QueueListing[]
  /** The listing being shown, or `null` when this system manages none. */
  readonly listing: QueueListing | null
  readonly rows: readonly QueueRow[]
  readonly refusal: { readonly name: ReviewsQueueRefusal; readonly sentence: string } | null
  readonly outcome: ReviewsQueueOutcome | null
  /** The signed-in operator, as the audit row records them. `null` on the unauthenticated page. */
  readonly actorLabel: string | null
}

/** One review as the detail screen shows it. */
export interface ReviewDetailView {
  readonly chrome: AdminChrome
  readonly direction: QueueDirection
  /** The local date the page was read on. See `ReviewsQueueView.readOnDate` on why it is not an instant. */
  readonly readOnDate: string
  readonly listing: QueueListing | null
  readonly review: {
    readonly id: string
    readonly rating: number
    readonly starOnly: boolean
    readonly comment: string | null
    readonly reviewerDisplayName: string
    readonly reviewedAtIso: string
    readonly placeId: string
    readonly source: string
    readonly deliveryMode: string
    readonly stage: ReviewQueueStage
    readonly escalation: ReviewEscalationExplanation
    /** The machine's draft (0048), or `null`. What the textarea starts from. */
    readonly draft: string | null
    /** Why no draft was produced, when the model's answer showed signs of having been steered. */
    readonly quarantineReason: string | null
    /** The bytes a human approved and *Copy reply* copies, or `null` before an approval. */
    readonly approvedText: string | null
    readonly lintVersion: string | null
    readonly contentSha256: string | null
    readonly postedManuallyAtIso: string | null
    readonly submittedAtIso: string | null
  } | null
  /** The Google deep link, reconstructed from the STORED place id. `null` when there is no review. */
  readonly deepLink: string | null
  /** What the textarea holds, which after a refusal is what the owner typed rather than the draft. */
  readonly editing: string
  readonly language: ApproveLanguage
  readonly refusal: { readonly name: ReviewsQueueRefusal; readonly sentence: string } | null
  /** Every rule the linter named, when the refusal is a lint refusal. Empty otherwise. */
  readonly lintRules: readonly string[]
  readonly outcome: ReviewsQueueOutcome | null
  readonly actorLabel: string | null
}

/** The ratings a review can carry. 1-5, and the database CHECK is the same set. */
export const REVIEW_RATINGS: readonly number[] = Object.freeze([1, 2, 3, 4, 5])
