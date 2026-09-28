import { createHash } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { ReviewIntakeStatus } from '../schema/reviews.ts'
import type { UnitOfWork } from '../tx.ts'
import { recordManualReview } from './reviews.ts'

/**
 * The fallback intake's writes: the forwarded email, and the daily Places aggregate (G-REV-02).
 *
 * ## Why the forwarded email gets a row even when it parsed perfectly
 *
 * Because the failure this whole path exists to remove is *the owner forwarded a review and nothing
 * happened*. An inbound message that produced a review row and no record of itself cannot answer "did my
 * forward arrive", which is the first question anybody asks of an email address. So both outcomes are rows,
 * and they store different things: a `needs_paste` row keeps the bytes because a person has to read them,
 * and a `parsed` row keeps only their digest because the `google_reviews` row is the record and a second copy
 * of the reviewer's words would drift (0048's argument for a fingerprint rather than a copy).
 *
 * ## Why the digest is computed here and not by the caller
 *
 * It is the one derivation in this file, and having it in one place is what makes the digest of a parsed row
 * and the digest of a refused row the same function of the same bytes. A caller-supplied digest would be two
 * implementations, and the failure mode — a digest computed over a trimmed copy — is invisible: the column
 * would hold a valid-looking sha256 of something that is not what arrived.
 *
 * ## Why nothing here reads a clock
 *
 * Every instant is an argument. The tripwire and the nudge are both asserted on a frozen clock, and the
 * trading date a reading counts against is resolved by the caller on `business_day` — trading runs
 * 11:00-02:00 Asia/Dubai, so a reading taken at 01:30 belongs to the previous trading date and a `current_date`
 * here would be the wrong number for nine hours either side of midnight.
 */

/** sha256, lower-case hex, over the UTF-8 bytes of the body exactly as it arrived. */
export function rawBodyDigest(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex')
}

/** The UTF-8 byte length. Bytes rather than code points — a template change is often an encoding change. */
export function rawBodyByteLength(rawBody: string): number {
  return Buffer.byteLength(rawBody, 'utf8')
}

export interface ParsedForwardInput {
  readonly connectionId: string
  readonly placeId: string
  /** The template shape that read it, from `packages/core`'s closed set. */
  readonly templateId: string
  readonly rawBody: string
  readonly receivedAtIso: string
  readonly rating: number
  readonly comment: string | null
  readonly reviewerDisplayName: string
  /** The instant the review is recorded against. See `email-parse.ts` on why it is the arrival. */
  readonly reviewedAtIso: string
}

export interface RecordedForward {
  readonly intakeId: string
  /** The review the forward produced, or `null` on the refusal path. */
  readonly reviewId: string | null
  readonly status: ReviewIntakeStatus
}

/**
 * Records a forwarded notification that parsed, and the review it describes.
 *
 * `recordManualReview` with `source: 'email_parse'` rather than a second insert: that function owns the
 * rating check, the star-only normalisation and the `google_review.recorded` audit row, and a second copy of
 * any of them would be a second path that has to be kept in step. The intake row is written in the same
 * transaction, so a review with no record of where it came from is not a state the database can hold.
 */
export async function recordParsedForward(
  uow: UnitOfWork,
  input: ParsedForwardInput,
): Promise<RecordedForward> {
  const review = await recordManualReview(uow, {
    connectionId: input.connectionId,
    placeId: input.placeId,
    source: 'email_parse',
    rating: input.rating,
    comment: input.comment,
    reviewerDisplayName: input.reviewerDisplayName,
    reviewedAtIso: input.reviewedAtIso,
  })
  const [row] = await uow.sql<{ id: string }[]>`
    insert into review_intake_email (
      connection_id, place_id, status, template_id, raw_body_sha256, raw_body_bytes,
      review_id, received_at
    ) values (
      ${input.connectionId}, ${input.placeId}, 'parsed', ${input.templateId},
      ${rawBodyDigest(input.rawBody)}, ${rawBodyByteLength(input.rawBody)},
      ${review.id}, ${input.receivedAtIso}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'Parsed intake insert returned no row')
  }
  await uow.audit.record({
    action: 'review_intake.parsed',
    entityType: 'review_intake_email',
    entityId: row.id,
    operation: 'create',
    after: {
      template_id: input.templateId,
      review_id: review.id,
      raw_body_sha256: rawBodyDigest(input.rawBody),
      raw_body_bytes: rawBodyByteLength(input.rawBody),
    },
  })
  return { intakeId: row.id, reviewId: review.id, status: 'parsed' }
}

export interface NeedsPasteInput {
  readonly connectionId: string
  readonly placeId: string
  /** Why nothing could be read, from `packages/core`'s closed set. */
  readonly refusal: string
  /** The forwarded body. Stored exactly as given — see the column comment in migration 0094. */
  readonly rawBody: string
  readonly receivedAtIso: string
}

/**
 * Records a forwarded notification nothing could read, with its bytes intact.
 *
 * The body is passed through to the column with no transformation of any kind. That is the acceptance line —
 * *retaining the raw body verbatim, asserted by comparing stored bytes to the fixture* — and it is why this
 * function does not trim, normalise line endings, or strip the markup a mangled template arrives wrapped in:
 * every one of those would be a helpful edit that makes the assertion fail, which is the point of asserting
 * it that way round.
 *
 * The audit row carries the digest and the byte count and NOT the body. `audit_event` is append-only
 * (ADR 0008), so a body written into it could never be removed — and the body is already on a row that can
 * be.
 */
export async function recordNeedsPasteForward(
  uow: UnitOfWork,
  input: NeedsPasteInput,
): Promise<RecordedForward> {
  const digest = rawBodyDigest(input.rawBody)
  const bytes = rawBodyByteLength(input.rawBody)
  const [row] = await uow.sql<{ id: string }[]>`
    insert into review_intake_email (
      connection_id, place_id, status, refusal, raw_body, raw_body_sha256, raw_body_bytes, received_at
    ) values (
      ${input.connectionId}, ${input.placeId}, 'needs_paste', ${input.refusal},
      ${input.rawBody}, ${digest}, ${bytes}, ${input.receivedAtIso}
    )
    returning id
  `
  if (row === undefined) {
    throw new AppError('invariant_violated', 'needs_paste intake insert returned no row')
  }
  await uow.audit.record({
    action: 'review_intake.needs_paste',
    entityType: 'review_intake_email',
    entityId: row.id,
    operation: 'create',
    // The digest and the size, never the body: this table is append-only and the body is not.
    after: { refusal: input.refusal, raw_body_sha256: digest, raw_body_bytes: bytes },
  })
  return { intakeId: row.id, reviewId: null, status: 'needs_paste' }
}

export interface AwaitingPasteItem {
  readonly id: string
  readonly connectionId: string
  readonly placeId: string
  readonly refusal: string
  readonly rawBody: string
  readonly rawBodySha256: string
  readonly rawBodyBytes: number
  readonly receivedAtIso: string
}

/** The intake queue: forwards still waiting for a person, oldest first. */
export async function listAwaitingPaste(
  sql: Sql,
  args: { readonly connectionId: string; readonly limit?: number },
): Promise<readonly AwaitingPasteItem[]> {
  const rows = await sql<
    {
      id: string
      connection_id: string
      place_id: string
      refusal: string
      raw_body: string
      raw_body_sha256: string
      raw_body_bytes: number
      received_at: Date
    }[]
  >`
    select id::text as id, connection_id::text as connection_id, place_id, refusal, raw_body,
           raw_body_sha256, raw_body_bytes, received_at
    from review_intake_email
    where connection_id = ${args.connectionId}::uuid
      and status = 'needs_paste'
      and resolved_at is null
    order by received_at asc, id asc
    limit ${args.limit ?? 50}
  `
  return rows.map((row) => ({
    id: row.id,
    connectionId: row.connection_id,
    placeId: row.place_id,
    refusal: row.refusal,
    rawBody: row.raw_body,
    rawBodySha256: row.raw_body_sha256,
    rawBodyBytes: row.raw_body_bytes,
    receivedAtIso: row.received_at.toISOString(),
  }))
}

/** One item, for the paste form that was opened from it. */
export async function getAwaitingPasteItem(
  sql: Sql,
  id: string,
): Promise<AwaitingPasteItem | undefined> {
  const rows = await sql<
    {
      id: string
      connection_id: string
      place_id: string
      refusal: string
      raw_body: string
      raw_body_sha256: string
      raw_body_bytes: number
      received_at: Date
    }[]
  >`
    select id::text as id, connection_id::text as connection_id, place_id, refusal, raw_body,
           raw_body_sha256, raw_body_bytes, received_at
    from review_intake_email
    where id = ${id}::uuid and status = 'needs_paste' and resolved_at is null
  `
  const row = rows[0]
  if (row === undefined) return undefined
  return {
    id: row.id,
    connectionId: row.connection_id,
    placeId: row.place_id,
    refusal: row.refusal,
    rawBody: row.raw_body,
    rawBodySha256: row.raw_body_sha256,
    rawBodyBytes: row.raw_body_bytes,
    receivedAtIso: row.received_at.toISOString(),
  }
}

export type IntakeResolutionOutcome = 'resolved' | 'already_resolved_or_absent'

/**
 * Closes a `needs_paste` item against the review somebody typed for it.
 *
 * The `resolved_at is null` predicate is in the UPDATE rather than in a preceding read, because two operators
 * can open the same item: a check-then-write has a window exactly wide enough for the second one to land in,
 * and the loser would silently re-point the item at their own review. `already_resolved_or_absent` is a
 * normal outcome the screen reports, not an error.
 */
export async function resolveIntakeWithReview(
  uow: UnitOfWork,
  args: {
    readonly intakeId: string
    readonly reviewId: string
    readonly resolvedAtIso: string
  },
): Promise<IntakeResolutionOutcome> {
  const updated = await uow.sql<{ id: string }[]>`
    update review_intake_email
    set review_id = ${args.reviewId}::uuid, resolved_at = ${args.resolvedAtIso}::timestamptz
    where id = ${args.intakeId}::uuid and status = 'needs_paste' and resolved_at is null
    returning id
  `
  if (updated.length === 0) return 'already_resolved_or_absent'
  await uow.audit.record({
    action: 'review_intake.resolved',
    entityType: 'review_intake_email',
    entityId: args.intakeId,
    operation: 'update',
    after: { review_id: args.reviewId, resolved_at: args.resolvedAtIso },
  })
  return 'resolved'
}

export interface PlaceAggregateRow {
  readonly id: string
  readonly observedOn: string
  readonly observedAtIso: string
  readonly ratingTenths: number | null
  readonly reviewCount: number | null
  readonly curatedReviewsDiscarded: number
  readonly reportedNewReviews: number | null
  readonly notifiedMessageId: string | null
}

/**
 * The newest reading for this listing strictly before `beforeTradingDate`.
 *
 * Strictly before, because the tripwire compares today's reading with the last one taken on a different
 * trading date. `<=` would compare today's reading with itself the moment it had been written, and the
 * difference would always be zero — a tripwire that could never fire, and green.
 */
export async function readPreviousPlaceAggregate(
  sql: Sql,
  args: {
    readonly connectionId: string
    readonly placeId: string
    readonly beforeTradingDate: string
  },
): Promise<PlaceAggregateRow | undefined> {
  const rows = await sql<
    {
      id: string
      observed_on: string
      observed_at: Date
      rating_tenths: number | null
      review_count: number | null
      curated_reviews_discarded: number
      reported_new_reviews: number | null
      notified_message_id: string | null
    }[]
  >`
    select id::text as id, observed_on::text as observed_on, observed_at, rating_tenths, review_count,
           curated_reviews_discarded, reported_new_reviews, notified_message_id::text as notified_message_id
    from google_place_aggregate
    where connection_id = ${args.connectionId}::uuid
      and place_id = ${args.placeId}
      and observed_on < ${args.beforeTradingDate}::date
    order by observed_on desc
    limit 1
  `
  const row = rows[0]
  if (row === undefined) return undefined
  return {
    id: row.id,
    observedOn: row.observed_on,
    observedAtIso: row.observed_at.toISOString(),
    ratingTenths: row.rating_tenths,
    reviewCount: row.review_count,
    curatedReviewsDiscarded: row.curated_reviews_discarded,
    reportedNewReviews: row.reported_new_reviews,
    notifiedMessageId: row.notified_message_id,
  }
}

export interface PlaceAggregateReadingInput {
  readonly connectionId: string
  readonly placeId: string
  /** The trading date the reading counts against, resolved by the caller on `business_day`. */
  readonly observedOn: string
  readonly observedAtIso: string
  readonly ratingTenths: number | null
  readonly reviewCount: number | null
  readonly curatedReviewsDiscarded: number
}

export type AggregateWriteOutcome =
  | { readonly kind: 'recorded'; readonly readingId: string }
  /** A reading already exists for this listing on this trading date. The pass does nothing further. */
  | { readonly kind: 'already_read_today' }

/**
 * Records one aggregate reading.
 *
 * `on conflict do nothing` on `(connection_id, place_id, observed_on)` rather than a read-then-write: two
 * passes can overlap — pg-boss reclaims an expired job — and the loser of a check-then-insert throws inside a
 * cron nobody is watching. It is also the tripwire's idempotency: a second pass on one trading date reaches
 * `already_read_today`, sends nothing, and cannot email the owner about the same reviews twice.
 */
export async function recordPlaceAggregateReading(
  uow: UnitOfWork,
  input: PlaceAggregateReadingInput,
): Promise<AggregateWriteOutcome> {
  const inserted = await uow.sql<{ id: string }[]>`
    insert into google_place_aggregate (
      connection_id, place_id, observed_on, observed_at, rating_tenths, review_count,
      curated_reviews_discarded
    ) values (
      ${input.connectionId}, ${input.placeId}, ${input.observedOn}::date,
      ${input.observedAtIso}::timestamptz, ${input.ratingTenths}, ${input.reviewCount},
      ${input.curatedReviewsDiscarded}
    )
    on conflict (connection_id, place_id, observed_on) do nothing
    returning id
  `
  const row = inserted[0]
  if (row === undefined) return { kind: 'already_read_today' }
  await uow.audit.record({
    action: 'google_place_aggregate.read',
    entityType: 'google_place_aggregate',
    entityId: row.id,
    operation: 'create',
    after: {
      place_id: input.placeId,
      observed_on: input.observedOn,
      rating_tenths: input.ratingTenths,
      review_count: input.reviewCount,
      curated_reviews_discarded: input.curatedReviewsDiscarded,
    },
  })
  return { kind: 'recorded', readingId: row.id }
}

/**
 * Records what the tripwire told the owner about a reading.
 *
 * `messageId` is nullable even here: F03's staging guard diverts every send to the local outbox off
 * production and writes no `message` row, which on a staging worker is the ORDINARY outcome — the same
 * allowance migration 0075 had to make for the re-auth ladder.
 */
export async function recordAggregateNotification(
  uow: UnitOfWork,
  args: {
    readonly readingId: string
    readonly reportedNewReviews: number
    readonly messageId: string | null
  },
): Promise<void> {
  if (!Number.isInteger(args.reportedNewReviews) || args.reportedNewReviews <= 0) {
    throw new AppError(
      'validation',
      `A count tripwire notification reports a positive whole number of new reviews, received ` +
        `${String(args.reportedNewReviews)}. An email saying "0 new reviews" is the one this pass must ` +
        'never send.',
    )
  }
  await uow.sql`
    update google_place_aggregate
    set reported_new_reviews = ${args.reportedNewReviews},
        notified_message_id = ${args.messageId}::uuid
    where id = ${args.readingId}::uuid
  `
  await uow.audit.record({
    action: 'google_place_aggregate.notified',
    entityType: 'google_place_aggregate',
    entityId: args.readingId,
    operation: 'update',
    after: { reported_new_reviews: args.reportedNewReviews, message_id: args.messageId },
  })
}

/**
 * How many reviews were REPORTED for this listing in `[sinceIso, untilIso)`.
 *
 * "Reported" means a `google_reviews` row exists, and it is defined here once so the Monday nudge and
 * anything that later asks the same question get the same answer. Counted in SQL, never read through a
 * capped reader: a `limit` is right for a panel and wrong for a count, and a subtraction between two capped
 * reads is how `settings-store.itest.ts` came to measure three changes as zero.
 *
 * A `needs_paste` intake item is deliberately NOT a report. It is a review that is still unrecorded, which
 * is a reason to nudge rather than a reason to stay quiet — the nudge's whole job is to get somebody to deal
 * with it.
 */
export async function countReviewsReportedBetween(
  sql: Sql,
  args: {
    readonly connectionId: string
    readonly placeId: string
    readonly sinceIso: string
    readonly untilIso: string
  },
): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n
    from google_reviews
    where connection_id = ${args.connectionId}::uuid
      and place_id = ${args.placeId}
      and created_at >= ${args.sinceIso}::timestamptz
      and created_at < ${args.untilIso}::timestamptz
  `
  return Number(rows[0]?.n ?? '0')
}

export interface ReviewIntakeTarget {
  readonly connectionId: string
  readonly placeId: string
}

/**
 * Every listing the fallback intake is about: a connection with a `gbp_reviews` capability carrying a
 * `placeId`.
 *
 * Read from the capability rather than from configuration, which is the point: the deep link and the intake
 * scoping are both keyed on the stored place id (docs/10 §6), and a configured one keeps working after the
 * capability is re-pointed at another listing — sending the owner to the wrong business's reviews.
 *
 * `health` is deliberately NOT filtered. In fallback mode every `gbp_reviews` capability is
 * `permission_missing` (that is what Y3-gbp-api means), and a pass that required `ok` would do nothing at all
 * on the only configuration this build ships with.
 *
 * Ordered by connection id so two passes read the listings in the same order, which is what stops a
 * concurrency test's outcome depending on a scan order.
 */
export async function listReviewIntakeTargets(sql: Sql): Promise<readonly ReviewIntakeTarget[]> {
  const rows = await sql<{ connection_id: string; place_id: string }[]>`
    select c.connection_id::text as connection_id, c.resource_ref ->> 'placeId' as place_id
    from google_capabilities c
    join google_connections g on g.id = c.connection_id
    where c.capability = 'gbp_reviews'
      and c.resource_ref ->> 'placeId' is not null
      and g.status <> 'disconnected'
    order by c.connection_id, place_id
  `
  return rows.map((row) => ({ connectionId: row.connection_id, placeId: row.place_id }))
}
