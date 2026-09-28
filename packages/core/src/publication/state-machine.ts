import { AppError } from '@berelax/shared'

/**
 * The publication state machine, as a pure decision (W-SITE-10).
 *
 * ## This is the mirror, not the enforcement
 *
 * `packages/db/migrations/0093_publication.sql` is where the machine is enforced: a CHECK for the evidence
 * rule (which answers an UPDATE as well as an INSERT, and still answers when a restore has triggers off)
 * and a trigger for the ordering (which can read the previous row, and which a CHECK cannot). This module
 * exists so a screen can grey a button and a service can refuse before it writes — never so a caller can
 * decide instead of the database.
 *
 * That makes it the kind of second statement the build is wary of, so the two are asserted against each
 * other rather than reviewed: `packages/fixtures/src/publication-control-plane.itest.ts` walks EVERY
 * (from, to) pair from {@link PUBLICATION_TRANSITIONS} through a real INSERT and requires this table and
 * that trigger to agree on all of them, in both directions. A pair this table permits and the database
 * refuses fails, and so does a pair this table refuses and the database accepts.
 *
 * ## Why any state may return to `draft`
 *
 * Because an approval is given for a content HASH, and editing the copy changes the hash. Every arrow
 * forward is one step, and the arrow back is always to the start — there is no "back to approved", because
 * the thing that was approved no longer exists. This is also what makes a live page revisable: `published`
 * returns to `draft` like everything else.
 *
 * ## Why `published -> published` exists at all
 *
 * A correction and a revert are the same shape: the page changes without passing back through draft,
 * because what it changes TO has already been linted and approved. Both are therefore a second published
 * record, and both must name the record they supersede — which is what keeps "what was live on that date"
 * answerable, and what {@link PublicationTransitionRefusal}'s `correction_must_supersede` is about.
 */

/** The four states. Mirrored by `publication_record.state`'s CHECK, asserted equal behaviourally. */
export const PUBLICATION_STATES = ['draft', 'lint_passed', 'approved', 'published'] as const
export type PublicationState = (typeof PUBLICATION_STATES)[number]

/** A surface with no record at all. Spelled rather than `null` so it can key the transition table. */
export const UNRECORDED = 'unrecorded' as const
export type PublicationOrigin = PublicationState | typeof UNRECORDED

/**
 * Which states may follow which, keyed by the state the surface is in.
 *
 * A total record rather than a `switch` with a `default`, so adding a state to {@link PUBLICATION_STATES}
 * without deciding its arrows is a type error — and a `default` arm in a table like this one is how a state
 * comes to be governed by whichever branch happened to be the fallback
 * (`PERMISSION_FOR_PUBLICATION_ACTION` in `../access/publication.ts` says the same thing about actions).
 */
export const PUBLICATION_TRANSITIONS: Readonly<
  Record<PublicationOrigin, readonly PublicationState[]>
> = Object.freeze({
  unrecorded: Object.freeze(['draft'] as const),
  draft: Object.freeze(['draft', 'lint_passed'] as const),
  lint_passed: Object.freeze(['draft', 'approved'] as const),
  approved: Object.freeze(['draft', 'published'] as const),
  published: Object.freeze(['draft', 'published'] as const),
})

/** Every reason a transition is refused, by name. A reworded message is not a reworded rule. */
export const PUBLICATION_TRANSITION_REFUSALS = [
  'transition_not_permitted',
  'approved_without_lint_pass',
  'published_without_lint_pass',
  'published_without_approval',
  'published_without_weight_measurement',
  'correction_must_supersede',
  'correction_supersedes_the_wrong_record',
  'supersedes_outside_a_correction',
] as const
export type PublicationTransitionRefusal = (typeof PUBLICATION_TRANSITION_REFUSALS)[number]

/** What the record being written carries. Ids are opaque here: this module compares, it does not read. */
export interface PublicationEvidence {
  readonly lintPassId: string | null
  readonly approvalId: string | null
  /** What the publish-time weight check measured. `null` is "not measured", which a publish may not be. */
  readonly measuredCriticalPathBytes: number | null
  /** The record this one supersedes, for a correction or a revert. */
  readonly supersedesId: string | null
}

/** The surface as it stands: the state of its newest record, and the id of that record. */
export interface PublicationPosition {
  readonly state: PublicationOrigin
  /** The newest record's id, or null when there is none. What a correction must name. */
  readonly currentRecordId: string | null
}

export type DecidedPublicationTransition =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'refused'
      readonly refusal: PublicationTransitionRefusal
      /** What could have been written from here, so a message can offer the next legal step. */
      readonly permitted: readonly PublicationState[]
      readonly why: string
    }

const refused = (
  refusal: PublicationTransitionRefusal,
  permitted: readonly PublicationState[],
  why: string,
): DecidedPublicationTransition => ({ kind: 'refused', refusal, permitted, why })

/**
 * Whether this record may be appended to this surface.
 *
 * The order of the checks is the order of the database's layers, deliberately: the ordering first (the
 * trigger), then the evidence (the CHECKs), then the supersession (the trigger again). A caller that
 * reports the first refusal therefore reports the one a direct INSERT would have hit, so a message from
 * this module and a SQLSTATE from the database never disagree about which rule stopped a write.
 */
export function decidePublicationTransition(
  position: PublicationPosition,
  to: PublicationState,
  evidence: PublicationEvidence,
): DecidedPublicationTransition {
  const permitted = PUBLICATION_TRANSITIONS[position.state]
  if (!permitted.includes(to)) {
    return refused(
      'transition_not_permitted',
      permitted,
      `the surface is ${position.state}, so it cannot move to ${to}. The sequence is ` +
        'draft -> lint_passed -> approved -> published, one step at a time, and any state may return to ' +
        'draft because editing the copy invalidates the hash the approval was given for',
    )
  }
  if (to === 'approved' && evidence.lintPassId === null) {
    return refused(
      'approved_without_lint_pass',
      permitted,
      'an approval is given for content that passed the lint, so the record has to cite the pass. ' +
        'Approving unlinted copy is the whole failure this plane exists against',
    )
  }
  if (to === 'published' && evidence.lintPassId === null) {
    return refused(
      'published_without_lint_pass',
      permitted,
      'a published record must cite the lint pass its content passed. Without it nothing says the copy ' +
        'was ever checked against the profile in force',
    )
  }
  if (to === 'published' && evidence.approvalId === null) {
    return refused(
      'published_without_approval',
      permitted,
      'a published record must cite a named approval. docs/07 §3 makes publication a human act, and an ' +
        'approval nothing cites is an approval of nothing in particular',
    )
  }
  if (to === 'published' && evidence.measuredCriticalPathBytes === null) {
    return refused(
      'published_without_weight_measurement',
      permitted,
      'a published record must carry the critical-path weight the publish-time check measured. docs/08 ' +
        '§8 makes that check one of three independent layers, and a record with no figure is a publish ' +
        'that skipped it',
    )
  }
  const isCorrection = position.state === 'published' && to === 'published'
  if (isCorrection && evidence.supersedesId === null) {
    return refused(
      'correction_must_supersede',
      permitted,
      'the surface is already published, so this record is a correction or a revert and must name the ' +
        'record it supersedes. Two published records with nothing between them are two unrelated claims ' +
        'about one page',
    )
  }
  if (
    isCorrection &&
    evidence.supersedesId !== null &&
    evidence.supersedesId !== position.currentRecordId
  ) {
    return refused(
      'correction_supersedes_the_wrong_record',
      permitted,
      `it supersedes ${evidence.supersedesId}, which is not the record currently live ` +
        `(${String(position.currentRecordId)}). Superseding an older record leaves the live one ` +
        'unaccounted for, which reads in the ledger as two pages published at once',
    )
  }
  if (!isCorrection && evidence.supersedesId !== null) {
    return refused(
      'supersedes_outside_a_correction',
      permitted,
      'only a published record following a published record supersedes anything; anywhere else the ' +
        'column would record a replacement that did not happen',
    )
  }
  return { kind: 'allowed' }
}

/** Raised by the writer rather than reaching the database and coming back as a SQLSTATE. */
export class PublicationTransitionRefused extends AppError {
  readonly code = 'publication_transition_refused' as const
  readonly refusal: PublicationTransitionRefusal
  constructor(
    surface: string,
    to: PublicationState,
    decision: Extract<DecidedPublicationTransition, { kind: 'refused' }>,
  ) {
    super(
      'invariant_violated',
      `'${surface}' cannot become ${to}: ${decision.refusal} — ${decision.why}. Permitted from here: ` +
        `${decision.permitted.join(', ')}.`,
      {
        userFacing: true,
        details: {
          code: 'publication_transition_refused',
          surface,
          to,
          refusal: decision.refusal,
          permitted: decision.permitted,
        },
      },
    )
    this.name = 'PublicationTransitionRefused'
    this.refusal = decision.refusal
  }
}

/** Throws unless the record may be appended. */
export function assertPublicationTransition(
  surface: string,
  position: PublicationPosition,
  to: PublicationState,
  evidence: PublicationEvidence,
): void {
  const decision = decidePublicationTransition(position, to, evidence)
  if (decision.kind === 'refused') {
    throw new PublicationTransitionRefused(surface, to, decision)
  }
}

/** The refusal a throw carries, or null — so a caller branches without matching on a message. */
export function publicationTransitionRefusalOf(
  error: unknown,
): PublicationTransitionRefusal | null {
  return error instanceof PublicationTransitionRefused ? error.refusal : null
}
