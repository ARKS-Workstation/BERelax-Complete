/**
 * The shared event identity (A-MEAS-03).
 *
 * The acceptance line is *"the same booking yields one event_id used by both the client tag and the server
 * push; a test asserts equality and that the id is stable across retries"*. There are two shapes that make
 * that true and only one of them works for every conversion this business takes.
 *
 * ## Why the id is DERIVED on both sides rather than minted once and handed over
 *
 * The obvious design is: the server mints a random id, writes it on the dispatch row, and renders it into
 * the page so the on-page tag sends the same one. It fails on three of this build's own cases:
 *
 *   - **A walk-in has no page.** A-MEAS-05 uploads a conversion for a treatment delivered two days ago to
 *     somebody who never used the website. There is no request to render an id into.
 *   - **A phone booking has no page either**, and `action_source` is `phone_call` precisely because of it.
 *   - **A corrected value is a second statement, not an edit** (A-MEAS-05). The corrected dispatch needs
 *     its OWN identity, derived from facts, or the correction deduplicates against the figure it corrects
 *     and is silently discarded by the platform.
 *
 * So both surfaces compute the id from facts they already hold: what KIND of thing converted, WHICH one,
 * and at which funnel stage. No clock, no randomness, no counter. Stability across a retry then holds by
 * construction rather than by a call site remembering to reuse a value — which is the property the
 * acceptance line actually needs, since a retried dispatch that re-minted its id is a second conversion.
 *
 * ## Why it is a digest and not the aggregate id with a prefix
 *
 * `booking:0193f2c1-…:paid` would be a perfectly stable id and it is refused for the reason ADR 0059
 * gives about the whole payload: this value travels to an ad platform, and a business identifier that
 * leaves the building is a join key into our own records for whoever holds it. A digest is opaque, and it
 * is also fixed-width, which matters because both platforms cap the field.
 *
 * The digest is over a CANONICAL form with explicit separators, not a concatenation. `'book' + 'ing1'` and
 * `'booking' + '1'` are the same string, so a concatenation makes two different conversions collide — and
 * a collision is not an error anywhere: it is one conversion reported instead of two, for ever.
 *
 * ## The stage is part of the id, and that is the non-obvious half
 *
 * One booking contributes several funnel events — `booking_created`, `confirmed`, `attended`, `paid` — and
 * each is a separate conversion to a platform. An id over the aggregate alone would make all four one
 * event, so three of them would be discarded as duplicates and the campaign would appear to produce
 * bookings that never got paid. The stage is therefore in the canonical form, and `funnelStageSchema`
 * parses it rather than a plain `string` being interpolated: a stage this build does not have is a
 * refusal, because the id for it would be stable, unique and meaningless.
 */
import { createHash } from 'node:crypto'
import { AppError, type FunnelStage, funnelStageSchema } from '@berelax/shared'

/**
 * What kind of thing converted.
 *
 * A closed vocabulary rather than a free string, because the kind is one of two inputs that keep two
 * different aggregates with the same uuid apart — and a typo in a free string produces a different, valid,
 * stable id, which is a conversion nobody can reconcile.
 *
 * `credit_note` is here because A-MEAS-05 pushes a negative value for one, and it needs an identity of its
 * own: a credit note that shared its invoice's id would deduplicate against the sale it reverses.
 */
export const ANALYTICS_AGGREGATE_KINDS = ['booking', 'invoice', 'credit_note', 'package'] as const
export type AnalyticsAggregateKind = (typeof ANALYTICS_AGGREGATE_KINDS)[number]

/**
 * The separator, and why it is a character no uuid, kind or stage can contain.
 *
 * `|` is not in the uuid alphabet, not in `ANALYTICS_AGGREGATE_KINDS` and not in `FUNNEL_STAGES` — all
 * three are asserted in `event-id.test.ts`, in both directions, because a separator that can appear inside
 * a field is not a separator: it lets two distinct inputs produce one canonical form.
 */
export const EVENT_ID_SEPARATOR = '|'

/** How many hex characters of the digest the id carries. */
export const EVENT_ID_LENGTH = 32

export interface AnalyticsEventSubject {
  readonly kind: AnalyticsAggregateKind
  /** The aggregate's own id. A uuid in every current case; typed as text because the digest does not care. */
  readonly aggregateId: string
  readonly stage: FunnelStage
}

/**
 * The canonical form the digest is taken over. Exported so the test can assert the separator claim.
 *
 * A blank aggregate id is REFUSED rather than hashed. `''` is a perfectly valid input to SHA-256 and would
 * produce one stable id shared by every conversion whose aggregate id failed to load — so every booking in
 * a broken run would be reported as one conversion, which is a figure rather than an error.
 */
export function analyticsEventCanonicalForm(subject: AnalyticsEventSubject): string {
  const aggregateId = subject.aggregateId.trim()
  if (aggregateId.length === 0) {
    throw new AppError(
      'validation',
      'An analytics event id was asked for with a blank aggregate id. The digest of a blank id is ' +
        'stable and shared, so every conversion in a run whose ids failed to load would be reported as ' +
        'one event — a wrong figure rather than an error.',
      { details: { kind: subject.kind, stage: subject.stage } },
    )
  }
  if (aggregateId.includes(EVENT_ID_SEPARATOR)) {
    throw new AppError(
      'validation',
      `An aggregate id containing ${EVENT_ID_SEPARATOR} would let two distinct conversions produce one ` +
        'canonical form, which is one conversion reported instead of two, for ever.',
      { details: { aggregateId } },
    )
  }
  // Parsed rather than interpolated: a stage this build does not have would yield an id that is stable,
  // unique and about nothing.
  const stage = funnelStageSchema.parse(subject.stage)
  if (!(ANALYTICS_AGGREGATE_KINDS as readonly string[]).includes(subject.kind)) {
    throw new AppError(
      'validation',
      `${JSON.stringify(subject.kind)} is not one of ${ANALYTICS_AGGREGATE_KINDS.join(' | ')}. A free ` +
        'string here would make a typo a different, valid, stable id — a conversion nobody can reconcile.',
      { details: { kind: subject.kind } },
    )
  }
  return [subject.kind, aggregateId, stage].join(EVENT_ID_SEPARATOR)
}

/**
 * The event id for one conversion. Pure, total over its declared inputs, and the same on both surfaces.
 *
 * Truncated to {@link EVENT_ID_LENGTH} hex characters — 128 bits. Both platforms cap the field well below
 * a full SHA-256, and 128 bits is the width at which a collision over this business's lifetime of
 * conversions is not a thing anybody has to think about. The truncation is stated rather than left to a
 * magic `slice`, because shortening it later would silently re-identify every event already pushed.
 */
export function analyticsEventId(subject: AnalyticsEventSubject): string {
  return createHash('sha256')
    .update(analyticsEventCanonicalForm(subject), 'utf8')
    .digest('hex')
    .slice(0, EVENT_ID_LENGTH)
}
