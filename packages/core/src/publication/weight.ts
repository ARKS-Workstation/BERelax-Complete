/**
 * The publish-time synthetic weight check (W-SITE-10, docs/08 §8 enforcement layer 3).
 *
 * docs/08 §8 names three independent layers and this is the third: *"Publish — a synthetic weight check
 * inside the existing draft → lint → approval → publication record plane, so an editor's oversized photo
 * fails BEFORE publication rather than a week later in CrUX."* The field layer is `web-vitals` and the CI
 * layer is `scripts/check-budgets.mjs` plus `apps/web/src/home.itest.ts`. Any of the three failing is a
 * red build.
 *
 * ## Why "synthetic", and what that changes
 *
 * The CI layer measures a real browser against a real `next start`: `encodedBodySize` per resource,
 * `renderBlockingStatus`, the LCP entry. A publish happens inside a request handler, where there is no
 * browser and where starting one would make a publish take a minute. So this layer composes the same
 * number from parts that are each already known at publish time — the rendered document's compressed
 * bytes, the encoded bytes of the renditions in the bucket, and the fonts and stylesheets the route puts
 * on its critical path — and judges the sum.
 *
 * It is therefore a slightly conservative estimate of the browser's figure rather than a second
 * definition of it. That distinction is why the two layers do not replace each other: this one fires
 * before the page is public and cannot see the paint; the CI one sees the paint and fires after the commit.
 *
 * ## The budget is an argument, and that is not indirection
 *
 * `packages/core` may not import `apps/web`, where docs/08 §8's table is stated once
 * (`apps/web/src/home/budget.ts`, `HOME_BUDGET`). So the caller passes the figure in, exactly as
 * `CompliancePolicy` is passed to the lexicon, and `apps/web/src/publication/publish-gate.ts` reads it
 * from `homeBudgetLimit('critical-above-fold')`. Restating 250 KB here would be a second statement of a
 * documented number, and the two would be compared by nobody.
 *
 * ## Why every refusal carries the measured number
 *
 * `scripts/check-budgets.mjs` recorded the reason and `apps/web/src/home/budget.ts` repeated it: *"the
 * first question anybody asks of a breached budget is by how much"*. A refusal that says only "over
 * budget" sends an editor back to render the page twice to find out; one that says `measured 287,104 bytes
 * against 256,000` is already the diagnosis, and it is the sentence the schema then stores the figure
 * beside (`publication_record.measured_critical_path_bytes`).
 */

/** The rules, by name, in the bracketed style every media and budget refusal in this repo uses. */
export const PUBLICATION_WEIGHT_RULES = [
  'publication-over-critical-path-budget',
  'publication-critical-path-not-measured',
] as const
export type PublicationWeightRule = (typeof PUBLICATION_WEIGHT_RULES)[number]

/**
 * The parts of a page's critical path, as the publish gate can know them.
 *
 * Three components rather than one total, because a refusal that named only the sum would tell an editor
 * the page is heavy and not which half to cut — and docs/08 §8's cut order is entirely about which half.
 */
export interface PublicationWeightSubject {
  readonly surface: string
  /** The rendered document, compressed the way it is served. Never its raw length. */
  readonly documentBytes: number
  /**
   * The stylesheets, fonts and scripts the document puts on its critical path.
   *
   * The caller's measurement, because which resources those are is a property of the document and is read
   * off the build, not guessed here.
   */
  readonly criticalAssetBytes: number
  /**
   * The served bytes of the images on the critical path — the LCP image and anything the head preloads.
   *
   * At the phone rung, because docs/08 §8 states the 250 KB figure in a mobile column and the mobile
   * column is the tighter one. `maxServedBytes` in `@berelax/media/derivative-set` is where the caller
   * gets it, which is the same function `apps/web/src/media/publish-gate.ts` measures a slot with — one
   * measurement of a rendition's weight, not two.
   */
  readonly criticalImageBytes: number
}

/** A breached budget, with both numbers and the sentence that prints them. */
export interface PublicationWeightRefusal {
  readonly rule: PublicationWeightRule
  readonly surface: string
  /** The figure measured, in bytes. `null` only for `publication-critical-path-not-measured`. */
  readonly measuredBytes: number | null
  readonly budgetBytes: number
  readonly message: string
}

const KIB = 1024
const kb = (bytes: number): string => `${(bytes / KIB).toFixed(1)}KB`

/**
 * The critical-path weight of one page: the document plus everything the document puts in front of its
 * largest paint.
 *
 * A sum and not a maximum. `apps/web/src/home/budget.ts` measures the same thing the same way —
 * "the encoded bytes of the document plus the encoded bytes of every resource on its critical path" —
 * and the two agreeing about the arithmetic is what lets the CI layer and this layer be compared at all.
 */
export function criticalPathBytes(subject: PublicationWeightSubject): number {
  return subject.documentBytes + subject.criticalAssetBytes + subject.criticalImageBytes
}

/**
 * Every weight reason this page may not be published, with the measured number.
 *
 * Findings rather than a throw, so a caller merges them with the lint's and the slot registry's and
 * reports one refusal — the reason `judgeHomeBudget` returns a list and `overlappingBands` before it.
 *
 * A subject whose parts are all zero is refused by `publication-critical-path-not-measured` rather than
 * accepted, and that rule is the whole reason this function cannot be satisfied by a gate that stopped
 * measuring: a page weighing nothing is inside every budget, so "0 bytes" has to be the loudest answer
 * here rather than the quietest (ADR 0002).
 *
 * `>` and not `>=`: a page exactly at the budget is inside it. docs/08 §8 writes "≤".
 */
export function publicationWeightRefusals(
  subject: PublicationWeightSubject,
  budgetBytes: number,
): readonly PublicationWeightRefusal[] {
  const measured = criticalPathBytes(subject)
  if (measured <= 0) {
    return Object.freeze([
      {
        rule: 'publication-critical-path-not-measured' as const,
        surface: subject.surface,
        measuredBytes: null,
        budgetBytes,
        message:
          `[publication-critical-path-not-measured] ${subject.surface}: the critical path measured 0 ` +
          'bytes, which no rendered page does. A page that weighs nothing is inside every budget, so ' +
          'this is refused rather than passed: the document, the critical assets and the critical image ' +
          `were ${subject.documentBytes}, ${subject.criticalAssetBytes} and ` +
          `${subject.criticalImageBytes} bytes. Publication is refused until the check has something to ` +
          'judge — docs/08 §8 makes the publish-time weight check one of three layers, and a layer that ' +
          'measures nothing is not one of them.',
      },
    ])
  }
  if (measured <= budgetBytes) return Object.freeze([])
  return Object.freeze([
    {
      rule: 'publication-over-critical-path-budget' as const,
      surface: subject.surface,
      measuredBytes: measured,
      budgetBytes,
      message:
        `[publication-over-critical-path-budget] ${subject.surface}: measured ${kb(measured)} ` +
        `(${measured} bytes) on the critical path against a budget of ${kb(budgetBytes)} ` +
        `(${budgetBytes} bytes), over by ${kb(measured - budgetBytes)} ` +
        `(${measured - budgetBytes} bytes). The document is ${subject.documentBytes}, the critical ` +
        `stylesheets, fonts and scripts ${subject.criticalAssetBytes}, and the critical image ` +
        `${subject.criticalImageBytes}. docs/08 §8's cut order starts with the desktop AV1 rendition ` +
        'and ends with poster quality; raising the budget is not on it.',
    },
  ])
}

/** The refusals as one printable block, or the empty string. What an assertion compares against ''. */
export function formatPublicationWeightRefusals(
  refusals: readonly PublicationWeightRefusal[],
): string {
  return refusals.map((refusal) => refusal.message).join('\n')
}
