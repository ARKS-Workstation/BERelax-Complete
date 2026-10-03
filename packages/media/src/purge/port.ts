/**
 * The CDN purge port — the interface a real CDN adapter will implement, with its outbox.
 *
 * ## Why this is in `@berelax/media` and not in `@berelax/providers`
 *
 * Because of what gets purged. docs/09 §5's interconnection map puts *"CDN purge · new immutable URL"* on
 * the **hero media** row, and W-SYS-05's media URLs are content-addressed: `/m/<mediaId>/<hash>/<name>`
 * never needs purging, because a changed file is a changed URL. What DOES need purging is everything that
 * is not content-addressed — the HTML of a page, the sitemap, `robots.txt` — and the reason the port lives
 * beside the media layer anyway is that the media layer is where "which URL does this byte live at" is
 * decided, and a purge is a statement about exactly that.
 *
 * ## Shaped around a CDN, not around the fake (docs/12 §1.1)
 *
 * **A purge is asynchronous and eventually consistent.** Every CDN accepts the request and completes it
 * across its edges over seconds to minutes, so `purge` returns *accepted* and never *purged*. A port that
 * returned "done" would make the publish pipeline claim something no CDN promises, and the test built on
 * it would pass while a stale page was still being served.
 *
 * **Paths, not URLs, and never a wildcard by default.** A purge-everything is one API call and it is the
 * call that empties the cache of a site under load; `purgeAll` is therefore a separate method so that
 * using it is a visible decision in a diff.
 *
 * **There is no CDN.** docs/05 names none and nothing is deployed, so the only implementation today is the
 * fake. The port exists now because the publish pipeline has to be able to say *what it purged* from the
 * commit that writes it — the acceptance criterion names the purge as one of five artefacts — and a
 * pipeline with the purge left out is one where adding it later means touching the loop again.
 */

/** One purge request: the paths, and the reason, which the outbox records. */
export interface PurgeRequest {
  /** Absolute paths on the site, each beginning with `/`. Never a full URL; see the header. */
  readonly paths: readonly string[]
  /** Why — `service published`, `therapist archived`. An outbox entry nobody can account for is noise. */
  readonly reason: string
  /**
   * Deduplication key over the path set.
   *
   * Same argument as IndexNow's: a retried publish must purge once. A CDN would accept a second purge
   * harmlessly, which is exactly why the key matters — without it the outbox count is not a measurement
   * of anything and the idempotency claim cannot be asserted.
   */
  readonly idempotencyKey: string
}

export type PurgeOutcome =
  | {
      readonly kind: 'accepted'
      readonly pathCount: number
      /** True when this set had already been purged and nothing was sent again. */
      readonly deduplicated: boolean
    }
  | { readonly kind: 'rejected'; readonly detail: string }

/** One recorded purge, whether accepted, deduplicated or refused. */
export interface PurgeOutboxEntry {
  readonly idempotencyKey: string
  readonly paths: readonly string[]
  readonly reason: string
  readonly outcome: PurgeOutcome
  readonly requestedAtIso: string
}

export interface PurgePort {
  readonly name: string
  purge(request: PurgeRequest): Promise<PurgeOutcome>
  /**
   * Purge the whole zone. A separate method so that using it is visible in a diff.
   *
   * Takes a reason and nothing else: there is no path set to record, which is the point — the reason is
   * the only thing that will explain, six weeks later, why the cache was emptied during a Friday evening.
   */
  purgeAll(reason: string): Promise<PurgeOutcome>
  /** Every purge this port has been asked for, in order — the visible outbox. See IndexNow's port. */
  outbox(): Promise<readonly PurgeOutboxEntry[]>
}
