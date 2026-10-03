/**
 * The IndexNow port — the interface the real adapter will implement.
 *
 * IndexNow is the one search-engine API this build can use without an account: a POST naming the URLs
 * that changed, authenticated by a **key the site publishes itself** at `https://<host>/<key>.txt`. Bing,
 * Yandex, Seznam and Naver share the endpoint; Google does not participate, which is why the sitemap's
 * `lastmod` is the signal that matters to Google and this is the one that matters to everybody else.
 *
 * ## Shaped around the provider, not around the fake (docs/12 §1.1)
 *
 * Three things make it IndexNow-shaped rather than generic:
 *
 *   - **The key is a credential AND a published file.** It is not a secret — anybody can fetch it — so it
 *     is a SETTING rather than an environment secret, and the adapter cannot be constructed without one.
 *   - **A submission is a SET of URLs**, capped by the protocol at 10,000 per request, and the provider's
 *     answer is about the set rather than about each URL. So `submit` takes `urls` and returns one
 *     outcome; a per-URL result would be a shape the provider cannot fill.
 *   - **A rejection is ordinary.** An unverified key answers 403 and a malformed body 422, and neither is
 *     an exception in the operational sense: the publish succeeded and the ping did not. So the outcome is
 *     a value, `accepted` or `rejected` with a reason, and `last_error` on the agent row is where it
 *     surfaces (docs/09 §5's agent console). A thrown error is reserved for not being able to ask at all.
 */

/** The hosts IndexNow serves. One endpoint; the key is verified against the host it names. */
export const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'

/** The protocol's own cap on one submission. A set larger than this is split by the caller. */
export const INDEXNOW_MAX_URLS = 10_000

export interface IndexNowSubmission {
  /** The host the key is published on, without a scheme. The provider rejects a mismatch. */
  readonly host: string
  /** Absolute URLs on that host. Deduplicated and sorted by the caller so a retry is identical. */
  readonly urls: readonly string[]
  /**
   * Deduplication key over the URL SET, not over one URL.
   *
   * The acceptance criterion is *"a retried publish yields one ping per changed URL set"*, which is a
   * statement about the set: publishing the same service twice must not ping twice, and publishing a
   * second service must ping again even though one URL is shared. The key is therefore derived from the
   * sorted set by the caller, and the provider is what enforces it.
   */
  readonly idempotencyKey: string
}

/** Why a submission was refused. The provider's own vocabulary, not this build's. */
export type IndexNowRejection =
  /** The key is not published at `https://<host>/<key>.txt`, or does not match. HTTP 403. */
  | 'key_not_verified'
  /** A URL in the set is not on `host`. HTTP 422. */
  | 'url_not_on_host'
  /** Too many submissions in too short a window. HTTP 429. */
  | 'rate_limited'
  /** Anything the adapter could not classify. */
  | 'unknown'

export type IndexNowOutcome =
  | {
      readonly kind: 'accepted'
      /** How many URLs the provider took. Equal to the set unless it deduplicated. */
      readonly urlCount: number
      /** True when this set had already been submitted and nothing was sent again. */
      readonly deduplicated: boolean
    }
  | { readonly kind: 'rejected'; readonly reason: IndexNowRejection; readonly detail: string }

export interface IndexNowProvider {
  readonly name: string
  submit(submission: IndexNowSubmission): Promise<IndexNowOutcome>
  /**
   * Every call this provider has been asked to make, in order — the VISIBLE outbox.
   *
   * Part of the port and not of the fake, which is deliberate. The acceptance criterion is *"the fake
   * writes every call to the visible outbox"*, and the reason it is on the interface is that the real
   * adapter has to answer the same question: *did we actually ping, and with what?* is asked by an
   * operator about production, not only by a test about a fake. The real adapter answers it from the rows
   * it persists.
   */
  outbox(): Promise<readonly IndexNowOutboxEntry[]>
}

/** One recorded submission, whether it was accepted, deduplicated or refused. */
export interface IndexNowOutboxEntry {
  readonly idempotencyKey: string
  readonly host: string
  readonly urls: readonly string[]
  readonly outcome: IndexNowOutcome
  readonly submittedAtIso: string
}
