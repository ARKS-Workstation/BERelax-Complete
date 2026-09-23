import type { Sql } from '../connection.ts'

/**
 * The two reads the public home page makes that no other read answers: who is on the roster, and which
 * reviews may be quoted.
 *
 * Both are deliberately **narrow and public-facing**, and neither duplicates an existing read:
 *
 *   - `readEligibleTherapists` (`queries/availability.ts`) answers "who may take this appointment on this
 *     trading date", which is a different question with a different answer: it needs credentials, skills,
 *     shifts and room compatibility, and it excludes every one of the nineteen today because none has a
 *     credential row. A therapist grid that showed only bookable therapists would be empty, which is a
 *     true statement about availability and a false one about the business.
 *   - `listReviewQueue` (`repositories/reviews.ts`) answers "what does an operator have to reply to",
 *     which is the opposite selection from "what may be shown to a customer": the queue exists to surface
 *     the rows *without* a reply.
 *
 * ## Why the roster read carries the publication guard rather than filtering on it
 *
 * `employee.is_publishable` is GENERATED as `display_name is not null and photo_consent` (0050, and the
 * guard 0030 refused to ship without). A read that filtered on it would return the empty set today and the
 * home page would have no team section at all — but docs/13 §8 states the launch state exactly: *"every
 * therapist renders as an unlinked photo card reading Name not yet published"*. So the rows come back with
 * the flag, and the **page** decides what a row without it may render: a label, never a name, and no link.
 * The guard is therefore visible on the surface that has to honour it rather than hidden in a `where`.
 */

/** One therapist, as a public page may know them. No name unless an admin has set one. */
export interface PublicTherapistRow {
  /** `Therapist 07` — the internal handle, and the only thing that tells two unnamed cards apart. */
  readonly staffReference: string
  /** NULL for all nineteen (`Y12-names`). Never rendered as a name when `isPublishable` is false. */
  readonly displayName: string | null
  /** The recorded act, not a tick: 0050 refuses `true` without a recorded at/by pair. */
  readonly photoConsent: boolean
  /** GENERATED from the two above. Nothing may write it, and nothing here tries. */
  readonly isPublishable: boolean
  /** `asian_style` / `arabic_style`, sorted. Provisional against `Y8-staff`; the rows say so. */
  readonly skills: readonly string[]
}

/**
 * Everyone currently employed, in roster order.
 *
 * `current_date` rather than the trading date, and the difference is deliberate. ADR 0009 and brief rule 7
 * make the trading date first-class because a 01:30 appointment belongs to the previous trading day — that
 * is a claim about an *appointment*, and `resolveTradingDate` lives in `@berelax/core`, which
 * `packages/db` may not import (the dependency runs the other way). This read answers "who works here",
 * whose only boundary is the day somebody's contract ends; being on a photo grid for two extra hours after
 * midnight is not a booking decision. The eligibility read is the one that resolves a trading date, and it
 * does so from a date its caller supplies.
 */
export async function readPublicTherapists(sql: Sql): Promise<readonly PublicTherapistRow[]> {
  const rows = await sql<
    {
      staff_reference: string
      display_name: string | null
      photo_consent: boolean
      is_publishable: boolean
      skills: string[] | null
    }[]
  >`
    select e.staff_reference,
           e.display_name,
           e.photo_consent,
           e.is_publishable,
           (select array_agg(s.skill::text order by s.skill)
              from employee_skill s where s.employee_id = e.id) as skills
      from employee e
     where e.employed_from <= current_date
       and (e.employed_until is null or e.employed_until >= current_date)
     order by e.staff_reference
  `
  return rows.map((row) => ({
    staffReference: row.staff_reference,
    displayName: row.display_name,
    photoConsent: row.photo_consent,
    isPublishable: row.is_publishable,
    skills: row.skills ?? [],
  }))
}

/**
 * A review a public page may quote.
 *
 * `readonly` in spirit and narrow on purpose. docs/09 §"Schema types" states the rule this selection
 * exists to satisfy — *"surface genuine reviews, do not mark up your own testimonials as review
 * snippets"* — and the two conditions are what make a row genuine rather than ours:
 *
 *   - **`google_review_id is not null`.** The review exists on Google, under an id anybody can check. A
 *     pasted or email-parsed row with no id is a transcription somebody in this business typed, which is
 *     precisely the self-serving testimonial the rule forbids publishing as a review.
 *   - **a comment with words in it.** A star-only review is common (docs/10 §7) and has nothing to quote.
 *
 * Nothing here aggregates. An `AggregateRating` needs a `reviewCount` behind it or it is invalid
 * (`packages/core/src/seo/jsonld/validate.ts` refuses one), and this build publishes no rating at all —
 * see `apps/web/src/home/content.ts`.
 */
export interface PublicReviewRow {
  readonly id: string
  /** Google's own id, so a reader or an auditor can find the review this quotes. */
  readonly googleReviewId: string
  readonly rating: number
  readonly commentText: string
  /** Google's display name, verbatim. Frequently `A Google user`, which is published as it stands. */
  readonly reviewerDisplayName: string
  readonly reviewedAt: string
}

/** Every quotable review, newest first. Empty today, and the emptiness is the data rather than a stub. */
export async function readPublicReviews(sql: Sql): Promise<readonly PublicReviewRow[]> {
  const rows = await sql<
    {
      id: string
      google_review_id: string
      rating: number
      comment_text: string
      reviewer_display_name: string
      reviewed_at: Date
    }[]
  >`
    select id, google_review_id, rating, comment_text, reviewer_display_name, reviewed_at
      from google_reviews
     where google_review_id is not null
       and comment_text is not null
       and length(btrim(comment_text)) > 0
     order by reviewed_at desc, id desc
  `
  return rows.map((row) => ({
    id: row.id,
    googleReviewId: row.google_review_id,
    rating: Number(row.rating),
    commentText: row.comment_text.trim(),
    reviewerDisplayName: row.reviewer_display_name,
    reviewedAt: new Date(row.reviewed_at).toISOString(),
  }))
}
