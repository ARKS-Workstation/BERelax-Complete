import {
  type Instant,
  instantToIso,
  parseReviewNotificationEmail,
  type ReviewEmailParseResult,
} from '@berelax/core'
import {
  listReviewIntakeTargets,
  type RecordedForward,
  recordNeedsPasteForward,
  recordParsedForward,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { AppError } from '@berelax/shared'

/**
 * The forwarded-notification intake: the pure parse joined to the write (G-REV-02, docs/10 §6).
 *
 * ## Why this lives in `packages/google`
 *
 * Because it is a PAIR. `parseReviewNotificationEmail` is in `@berelax/core` and cannot reach a database;
 * `recordParsedForward` is in `@berelax/db` and may not import core (ADR 0001). This package already depends
 * on both — the same argument `review-routing.itest.ts` and `generate-draft.ts` make for themselves — so the
 * composition happens here and can be exercised end to end against real PostgreSQL.
 *
 * ## The one decision this function makes, and it is the whole unit
 *
 * A body the parser could not read does **not** throw and does **not** get guessed at. It becomes a
 * `needs_paste` row carrying the bytes exactly as they arrived, which is a job for a person that takes ninety
 * seconds with the paste form (docs/10 §6). docs/10 predicts the template change that causes it — Google's
 * notification email is not an API surface and will change with no notice — so this is the ordinary path
 * rather than an error path, and it is why there is no `catch` anywhere in here.
 *
 * ## Untrusted at the boundary
 *
 * The body is anonymous input: anybody who learns the inbound address can send to it, and the reviewer of a
 * real review can write anything into a real review. So the extracted text is DATA, all the way through — it
 * reaches a model only inside `buildReviewReplyPrompt`'s one delimited region (G-REV-04), and it reaches a
 * human only through `safeText` on the paste screen. Nothing in this function interprets it, shortens it or
 * decides anything from its content beyond the rating and the reviewer the template labelled.
 *
 * ## What is deliberately NOT here: the HTTP transport
 *
 * Nothing in this build can RECEIVE an email. Resend inbound needs a verified receiving domain and a signing
 * secret, neither of which exists (Y6-email-sender for the domain, `Y8-inbound-review-address` for the
 * address and the secret). `apps/web/app/api/v1/reviews/inbound/route.ts` is the endpoint that calls this, and
 * it **refuses every request** until the secret is configured rather than accepting an unauthenticated one —
 * an open inbound endpoint that feeds an LLM pipeline is the injection path docs/10 §7 names about Pub/Sub,
 * and the same argument applies here.
 */

/** One inbound delivery, as the transport hands it over. */
export interface InboundReviewEmail {
  /** The message body, exactly as received. Never modified on any path. */
  readonly rawBody: string
  /** When the forward arrived. Injected — see `email-parse.ts` on why the parse needs it. */
  readonly receivedAt: Instant
}

/** Which listing an inbound forward is about, or why that could not be decided. */
export type InboundListingResolution =
  | { readonly kind: 'listing'; readonly connectionId: string; readonly placeId: string }
  /** No connection manages a listing, so there is nothing to file a review against. */
  | { readonly kind: 'no_listing_configured' }
  /** More than one, and a forwarded email carries nothing that says which. See below. */
  | { readonly kind: 'ambiguous'; readonly placeIds: readonly string[] }

/**
 * The listing a forwarded email is about.
 *
 * With one connection this is unambiguous, and one is what this business has. With two — a real configuration,
 * because the account that owns the listing need not be the one verified on the site (docs/10 §2) — it is
 * **refused** rather than guessed: Google's notification email carries no place id, so picking the first
 * connection would file one listing's review under the other's, and migration 0020's trigger exists precisely
 * because a filter cannot undo that once the row is wrong. The forward then has to be pasted, which is the
 * same answer an unreadable body gets and is already a path somebody uses.
 */
export async function resolveInboundListing(sql: Sql): Promise<InboundListingResolution> {
  const targets = await listReviewIntakeTargets(sql)
  const only = targets[0]
  if (only === undefined) return { kind: 'no_listing_configured' }
  if (targets.length > 1) {
    return { kind: 'ambiguous', placeIds: targets.map((target) => target.placeId) }
  }
  return { kind: 'listing', connectionId: only.connectionId, placeId: only.placeId }
}

export interface RecordedInboundForward extends RecordedForward {
  /** The parse the row was written from, so a caller can report the refusal or the template by name. */
  readonly parse: ReviewEmailParseResult
}

/**
 * Records one inbound forward: a review on the parsed path, a paste request on the other.
 *
 * `actor` is the caller's, and it is `system` for the endpoint: the forward was sent by the owner's mail
 * client and processed by a machine, so a staff label would name somebody who did not do it. The audit row
 * carries the digest and the byte count rather than the body — `audit_event` is append-only (ADR 0008), so a
 * body written into it could never be removed, and the body is already on a row that can be.
 *
 * One transaction per forward, because the review and the intake row that says where it came from must commit
 * together: a review with no provenance is a row nobody can account for, and an intake row pointing at a
 * review that rolled back is worse.
 */
export async function recordInboundReviewEmail(
  deps: {
    readonly sql: Sql
    readonly actor: { readonly kind: 'system'; readonly label: string }
  },
  args: InboundReviewEmail & { readonly connectionId: string; readonly placeId: string },
): Promise<RecordedInboundForward> {
  const parse = parseReviewNotificationEmail(args.rawBody, { receivedAt: args.receivedAt })
  const receivedAtIso = instantToIso(args.receivedAt)

  if (parse.kind === 'needs_paste') {
    const recorded = await withUnitOfWork(deps.sql, deps.actor, (uow) =>
      recordNeedsPasteForward(uow, {
        connectionId: args.connectionId,
        placeId: args.placeId,
        refusal: parse.refusal,
        // The bytes the parser was handed, which are the bytes the transport received. Not
        // `parse.rawBody.trim()` and not a re-join: the acceptance line compares the stored column with the
        // fixture's own bytes, so any tidying on this line fails that test rather than passing it.
        rawBody: parse.rawBody,
        receivedAtIso,
      }),
    )
    return { ...recorded, parse }
  }

  const recorded = await withUnitOfWork(deps.sql, deps.actor, (uow) =>
    recordParsedForward(uow, {
      connectionId: args.connectionId,
      placeId: args.placeId,
      templateId: parse.template,
      rawBody: args.rawBody,
      receivedAtIso,
      rating: parse.rating,
      comment: parse.commentText,
      reviewerDisplayName: parse.reviewerDisplayName,
      // The instant the parse reported, which for every template this build knows is the arrival — no
      // notification template carries the instant the reviewer left the review, and the parse says so with
      // `reviewedAtSource` rather than pretending otherwise.
      reviewedAtIso: instantToIso(parse.reviewedAt),
    }),
  )
  return { ...recorded, parse }
}

/** The actor an inbound forward is recorded under. `system`: a machine read an email nobody was watching. */
export const INBOUND_REVIEW_ACTOR = {
  kind: 'system',
  label: 'Review notification intake',
} as const

/**
 * The whole delivery: resolve the listing, then record.
 *
 * Separate from {@link recordInboundReviewEmail} so a test can hand that function a listing it created and
 * assert the write, while this one is what the endpoint calls. It throws for a listing it cannot decide,
 * because the endpoint has to answer something a sender can act on and there is nothing useful it could do
 * with a row filed against a guess.
 */
export async function deliverInboundReviewEmail(
  deps: { readonly sql: Sql },
  email: InboundReviewEmail,
): Promise<RecordedInboundForward> {
  const listing = await resolveInboundListing(deps.sql)
  if (listing.kind === 'no_listing_configured') {
    throw new AppError(
      'invariant_violated',
      '[review-inbound-no-listing] No Google connection manages a listing, so there is nothing to file a ' +
        'forwarded review against. Connect the listing first (docs/10 §5).',
    )
  }
  if (listing.kind === 'ambiguous') {
    throw new AppError(
      'invariant_violated',
      `[review-inbound-ambiguous-listing] ${listing.placeIds.length} listings are managed and a forwarded ` +
        'notification carries no place id, so this build cannot say which one the review is on. Paste it ' +
        'instead — filing it against a guess would put the reply on the wrong business.',
      { details: { placeIds: [...listing.placeIds] } },
    )
  }
  return await recordInboundReviewEmail(
    { sql: deps.sql, actor: INBOUND_REVIEW_ACTOR },
    { ...email, connectionId: listing.connectionId, placeId: listing.placeId },
  )
}
