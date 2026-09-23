/**
 * Deterministic duplicate scoring for two client records, and the two thresholds that act on it.
 *
 * Duplicates are guaranteed in a phone-first business. The same person is `+971501234567` at the desk,
 * `0501234567` on the WhatsApp export and `050 123 45 67` in the paper diary, and every one of those
 * becomes its own row the moment something writes without normalising. So detection has to exist, and
 * the only question is what shape it takes.
 *
 * ## Why a table and not a weighted sum
 *
 * Every score this module returns is a cell of {@link AGREEMENT_SCORES}: a phone class crossed with a
 * label class, in integer per-mille. Three reasons, in order of how much they matter.
 *
 *   1. **A human has to be able to predict it.** The owner is being asked to accept that some pairs
 *      merge without anybody looking. That is only acceptable if the rule can be read off a page, and
 *      "0.55 × phone + 0.45 × name, thresholded" cannot: nobody can say which pairs it merges without
 *      running it.
 *   2. **It is exactly reviewable in a diff.** Moving a cell is one line and it is obvious what moved.
 *      A weight change moves every score at once, which is how a threshold quietly stops meaning what
 *      it was agreed to mean.
 *   3. **Integers, so the score is the same value forever.** The committed golden file holds exact
 *      scores (`packages/core/test/fixtures/duplicate-pairs.json`). Per-mille integers divided by 1000
 *      round-trip through a JSON file and through a `numeric` column unchanged; a sum of floating-point
 *      products does not, and the test that pins it would fail on a machine rather than on a change.
 *
 * The cost is that the score carries less information than the underlying similarity — 0.94 says
 * "same number, label agrees in part" and not "0.9417". That is the right trade for a number whose
 * only two consumers are a threshold and a human reading a review queue.
 *
 * ## The conservative asymmetry, stated once
 *
 * A false merge is far more expensive than a missed one. Merging two people puts one person's
 * contraindications, package balance and consent state onto the other, and C-CRM-05's merge keeps a
 * tombstone precisely because the operation cannot be undone by hand. A missed duplicate costs a
 * second row and a receptionist's puzzlement. Every cell below is set from that asymmetry, which is
 * why **the auto-merge band is reachable only with an identical phone number**: the strongest label
 * agreement in the world cannot merge two different numbers without a human, and a typo'd number with
 * an identical label reaches review and stops there.
 *
 * Two real cases decided the two corners that look wrong at first glance:
 *
 *   - *Same number, different label* (0.72 — review, never auto-merge). One phone, two records, two
 *     labels is a couple who book on one handset, a hotel concierge, or a mother booking for a
 *     daughter. Phone-first identity says they are the same contact; the labels say they are not. A
 *     human decides, and the pair is surfaced rather than merged.
 *   - *Consecutive numbers, near-identical labels* (0.84 — review). Families here buy numbers in a
 *     block, so `…0042` and `…0043` with labels one character apart are two siblings at least as often
 *     as they are one person typed twice.
 *
 * ## Purity
 *
 * Nothing here reads a clock, a random source or an environment: a pair scored today scores the same
 * in a year, which is what makes the golden file a regression test rather than a snapshot of a mood.
 * `pnpm purity` and dependency-cruiser's `core-must-be-pure` both cover this directory, and case 71 of
 * `scripts/test-gates.mjs` proves each of them fires on it.
 */
import { normaliseNameForMatching } from '../identity/normalise-phone.ts'
import { crmPhoneKey } from './phone.ts'

// ------------------------------------------------------------------------------------------------
// The two signals
// ------------------------------------------------------------------------------------------------

/**
 * How two contact numbers agree.
 *
 * `identical` means the same canonical E.164 — which already covers every spelling of one number,
 * because {@link crmPhoneKey} normalises before this classification happens. There is deliberately no
 * class for "the same national number written with and without its country code": that is not a near
 * match, it is the *same* key, and inventing a weaker class for it would have made the normaliser's
 * job look optional.
 *
 * The three typo classes are the mistakes a number actually arrives with — one digit wrong, two
 * adjacent digits swapped, one digit dropped or added — and they are separate values rather than one
 * `near` because they do not carry the same weight of evidence and because a reviewer reading a queue
 * wants to know which one it was.
 */
export const PHONE_AGREEMENTS = [
  'identical',
  'one_digit_apart',
  'digits_transposed',
  'one_digit_shifted',
  'different',
  /** At least one side has no number this system can key. Not a weak match — an absent signal. */
  'unknown',
] as const
export type PhoneAgreement = (typeof PHONE_AGREEMENTS)[number]

/** How two record labels agree, after folding. See {@link labelSimilarityPerMille}. */
export const LABEL_AGREEMENTS = ['identical', 'near', 'partial', 'different', 'unknown'] as const
export type LabelAgreement = (typeof LABEL_AGREEMENTS)[number]

/**
 * The two similarity boundaries, in per-mille, and the measurements behind them.
 *
 * `NEAR` is 800 because of one measurement: `Customer 0042` against `Customer 0043` scores **750**.
 * Those are two different records in this system's own labelling, and a boundary below 750 would put
 * them in `near`, which crossed with an identical phone number is 0.98 — an automatic merge of two
 * different people from a shared family handset. The boundary is set above the highest similarity two
 * *deliberately different* labels have been measured at, and the golden fixture holds that pair so
 * that lowering it fails the build.
 *
 * `PARTIAL` is 450, below the 500 that one mistyped word in a two-word label measures at
 * (`Custumer 0042` against `Customer 0042` is 647; a single-word label with one letter wrong is 500)
 * and above the 428 that two entirely different serials measure at.
 *
 * Both are per-mille integers compared with `>=`, so the boundary is exact rather than a float
 * comparison that depends on how the number was computed.
 */
export const LABEL_NEAR_THRESHOLD = 800
export const LABEL_PARTIAL_THRESHOLD = 450

// ------------------------------------------------------------------------------------------------
// Label similarity: the same measure pg_trgm computes, computed here
// ------------------------------------------------------------------------------------------------

/**
 * Trigrams of a folded label, exactly as `pg_trgm` extracts them.
 *
 * Two leading spaces and one trailing space per word, set semantics, which is what
 * `show_trgm('0042 customer')` returns. Matching it is not an aesthetic choice: the candidate query in
 * `packages/db/src/repositories/duplicate-candidates.ts` finds pairs with the `%` operator against a
 * trigram index, and this module then scores them. If the two definitions of "similar" disagreed,
 * the database would hand up candidates the scorer dismisses and — far worse — withhold pairs the
 * scorer would have merged, with nothing failing anywhere.
 * `packages/fixtures/src/crm-duplicates.itest.ts` asserts the agreement against a real PostgreSQL over
 * a table of label pairs, because two implementations of one formula is the situation brief rule 12 is
 * about and the only honest answer to it is a test that compares them.
 *
 * The input is expected to be folded by {@link normaliseNameForMatching} first: accents and Arabic
 * orthography are folded in TypeScript because `unaccent` is STABLE and so cannot appear in an index
 * (migration 0019 states that decision), which is what makes `name_match_key` the column the trigram
 * index is built on.
 */
export function labelTrigrams(folded: string): ReadonlySet<string> {
  const trigrams = new Set<string>()
  for (const word of folded.split(' ')) {
    if (word.length === 0) continue
    const padded = `  ${word} `
    for (let index = 0; index + 3 <= padded.length; index += 1) {
      trigrams.add(padded.slice(index, index + 3))
    }
  }
  return trigrams
}

/**
 * Jaccard similarity of two labels' trigram sets, in per-mille, rounded half-up.
 *
 * Jaccard — shared over union — because that is what `similarity()` computes: `count / (len1 + len2 -
 * count)`. Dice would be the other obvious choice and would disagree with the index, which is the one
 * property this function is not allowed to have.
 *
 * Two labels that fold to nothing are 0 rather than 1000. Empty and empty is not agreement, it is two
 * records with no label, and that is what {@link classifyLabelAgreement} reports as `unknown`.
 */
export function labelSimilarityPerMille(left: string, right: string): number {
  const a = labelTrigrams(normaliseNameForMatching(left))
  const b = labelTrigrams(normaliseNameForMatching(right))
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const trigram of a) if (b.has(trigram)) shared += 1
  const union = a.size + b.size - shared
  // Integer arithmetic throughout: `Math.round(1000 * shared / union)` in floating point would put the
  // committed golden scores at the mercy of the order the division happens in.
  return Math.round((shared * 1000) / union)
}

// ------------------------------------------------------------------------------------------------
// Classifying a pair
// ------------------------------------------------------------------------------------------------

const digitsOf = (value: string): string => value.replace(/\D/g, '')

/** True when `shorter` is `longer` with exactly one digit removed. */
function isOneDeletionApart(longer: string, shorter: string): boolean {
  let index = 0
  let skipped = false
  for (let position = 0; position < longer.length; position += 1) {
    if (longer[position] === shorter[index]) {
      index += 1
      continue
    }
    if (skipped) return false
    skipped = true
  }
  return index === shorter.length
}

/**
 * Which of {@link PHONE_AGREEMENTS} describes two contact numbers.
 *
 * Symmetric by construction: every comparison below is on a pair of sets or on a length-ordered pair,
 * never on "the first argument". The property test in `duplicate-score.property.test.ts` proves it
 * over generated input rather than over the cases listed here.
 */
export function classifyPhoneAgreement(
  left: string | null | undefined,
  right: string | null | undefined,
): PhoneAgreement {
  if (left === null || left === undefined || right === null || right === undefined) return 'unknown'
  const a = crmPhoneKey(left)
  const b = crmPhoneKey(right)
  // A number this system cannot key is an absent signal, not a weak one. Comparing the raw spellings
  // instead would make `02 123 4567` and `02 123 4568` — two different landlines — look identical to
  // within one digit, on a value neither side agreed was a number.
  if (!a.ok || !b.ok) return 'unknown'
  if (a.e164 === b.e164) return 'identical'

  const left164 = digitsOf(a.e164)
  const right164 = digitsOf(b.e164)
  if (left164.length === right164.length) {
    const differing: number[] = []
    for (let index = 0; index < left164.length; index += 1) {
      if (left164[index] !== right164[index]) differing.push(index)
    }
    if (differing.length === 1) return 'one_digit_apart'
    const [first, second] = differing
    if (
      differing.length === 2 &&
      first !== undefined &&
      second !== undefined &&
      second === first + 1 &&
      left164[first] === right164[second] &&
      left164[second] === right164[first]
    ) {
      return 'digits_transposed'
    }
    return 'different'
  }
  const [longer, shorter] =
    left164.length > right164.length ? [left164, right164] : [right164, left164]
  if (longer.length - shorter.length === 1 && isOneDeletionApart(longer, shorter)) {
    return 'one_digit_shifted'
  }
  return 'different'
}

/** Which of {@link LABEL_AGREEMENTS} describes two record labels. */
export function classifyLabelAgreement(
  left: string | null | undefined,
  right: string | null | undefined,
): LabelAgreement {
  if (left === null || left === undefined || right === null || right === undefined) return 'unknown'
  const a = normaliseNameForMatching(left)
  const b = normaliseNameForMatching(right)
  // Punctuation and whitespace alone fold to nothing, and a key built from nothing would agree with
  // every other label that folded to nothing.
  if (a.length === 0 || b.length === 0) return 'unknown'
  if (a === b) return 'identical'
  const similarity = labelSimilarityPerMille(left, right)
  if (similarity >= LABEL_NEAR_THRESHOLD) return 'near'
  if (similarity >= LABEL_PARTIAL_THRESHOLD) return 'partial'
  return 'different'
}

// ------------------------------------------------------------------------------------------------
// The table
// ------------------------------------------------------------------------------------------------

/**
 * Every (phone × label) pair and the score it produces, in per-mille. Total, by construction.
 *
 * Read the rows as evidence about the number and the columns as evidence about the label. The three
 * shapes worth stating in words, because they are the decisions and not the arithmetic:
 *
 *   - **Only the `identical` row reaches 0.95.** A number is the identity in this business (ADR 0014);
 *     a label is a courtesy the front desk sometimes types. No amount of label agreement merges two
 *     different numbers without a human.
 *   - **`identical` + `different` is 0.72, not 0.20.** One handset, two labels is the shared-phone
 *     case. It is surfaced for review because phone-first identity says these rows are probably one
 *     contact, and it is kept out of the auto band because the labels say they are probably not one
 *     person.
 *   - **`different` + `identical` is 0.71.** The same person with a new number, which happens on every
 *     SIM change, is worth a human's attention and nothing more: two labels reading `Customer 0042` on
 *     two unrelated numbers is equally likely to be two records nobody named.
 */
export const AGREEMENT_SCORES: Readonly<
  Record<PhoneAgreement, Readonly<Record<LabelAgreement, number>>>
> = Object.freeze({
  identical: Object.freeze({
    identical: 1000,
    near: 980,
    partial: 940,
    different: 720,
    unknown: 960,
  }),
  // A digit wrong and a digit swapped carry the same weight: both are one keystroke, and neither is
  // more evidence than the other.
  one_digit_apart: Object.freeze({
    identical: 900,
    near: 840,
    partial: 640,
    different: 180,
    unknown: 420,
  }),
  digits_transposed: Object.freeze({
    identical: 900,
    near: 840,
    partial: 640,
    different: 180,
    unknown: 420,
  }),
  // Slightly weaker than a substitution: a dropped digit also changes the length, which is what a
  // truncated paste looks like, and a truncated paste is somebody else's number as often as it is a
  // mistyped one.
  one_digit_shifted: Object.freeze({
    identical: 880,
    near: 820,
    partial: 600,
    different: 160,
    unknown: 380,
  }),
  different: Object.freeze({
    identical: 710,
    near: 560,
    partial: 300,
    different: 0,
    unknown: 40,
  }),
  unknown: Object.freeze({
    identical: 680,
    near: 520,
    partial: 260,
    different: 20,
    unknown: 0,
  }),
})

// ------------------------------------------------------------------------------------------------
// Thresholds and verdicts
// ------------------------------------------------------------------------------------------------

export const DUPLICATE_VERDICTS = ['auto_merge', 'review', 'distinct'] as const
export type DuplicateVerdict = (typeof DUPLICATE_VERDICTS)[number]

/**
 * The two thresholds, and the fact that nobody has agreed them yet.
 *
 * 0.95 and 0.70 are this build's choice, deliberately conservative, and they are provisional in the
 * sense docs/12 §1 uses: an owner decision is outstanding (`Y9-dedup-thresholds` in
 * docs/OPEN-QUESTIONS.md). They are constants here rather than settings rows because nothing reads a
 * setting for them yet — the merge that acts on the auto band is C-CRM-05's — and a settings key that
 * no code consults is a knob that lies about what it controls. {@link duplicateVerdict} takes the pair
 * as an argument precisely so that the unit which does act on them can inject the owner's numbers
 * without this module changing.
 *
 * No value in {@link AGREEMENT_SCORES} sits exactly on either threshold. That is deliberate: a cell
 * equal to a threshold makes every assertion about the band depend on how `>=` treats a float that was
 * arrived at by division, which is a defect waiting for a rounding change rather than a decision.
 */
export const DUPLICATE_AUTO_MERGE_THRESHOLD = 0.95
export const DUPLICATE_REVIEW_THRESHOLD = 0.7
export const DUPLICATE_THRESHOLDS_OPEN_QUESTION = 'Y9-dedup-thresholds'

export interface DuplicateThresholds {
  readonly autoMerge: number
  readonly review: number
}

export const PROVISIONAL_DUPLICATE_THRESHOLDS: DuplicateThresholds = Object.freeze({
  autoMerge: DUPLICATE_AUTO_MERGE_THRESHOLD,
  review: DUPLICATE_REVIEW_THRESHOLD,
})

/** Which band a score falls in. Fails toward `review`: an out-of-order pair of thresholds raises. */
export function duplicateVerdict(
  score: number,
  thresholds: DuplicateThresholds = PROVISIONAL_DUPLICATE_THRESHOLDS,
): DuplicateVerdict {
  if (!(thresholds.autoMerge > thresholds.review)) {
    // An auto-merge threshold at or below the review threshold merges everything a human was meant to
    // look at. There is no safe interpretation of it, so it is an error rather than a clamp.
    throw new RangeError(
      `[duplicate-thresholds] autoMerge (${thresholds.autoMerge}) must be above review ` +
        `(${thresholds.review}): the auto band cannot include pairs the review band exists to show.`,
    )
  }
  if (score >= thresholds.autoMerge) return 'auto_merge'
  if (score >= thresholds.review) return 'review'
  return 'distinct'
}

// ------------------------------------------------------------------------------------------------
// Scoring a pair
// ------------------------------------------------------------------------------------------------

/**
 * One side of a pair: whatever the record holds, in whatever spelling it holds it.
 *
 * `label` and not `name`, and the distinction is load-bearing. This system invents no names (ADR
 * 0020): a customer with no display name is `Customer 0042`, and that is what `customer.display_name`
 * holds for most rows. The field is what the record says, which may be a label, may be a name an admin
 * typed, and is very often null.
 */
export interface DuplicateSubject {
  readonly phone: string | null
  readonly label: string | null
}

export interface DuplicateScore {
  /** 0..1 with three decimals, which is {@link scorePerMille} divided by 1000 and nothing else. */
  readonly score: number
  /** The cell of {@link AGREEMENT_SCORES} this pair landed in. The authoritative figure. */
  readonly scorePerMille: number
  readonly phone: PhoneAgreement
  readonly label: LabelAgreement
  readonly verdict: DuplicateVerdict
}

/**
 * Scores one pair. Deterministic, symmetric, and total over every input including two empty records.
 *
 * Both properties are proved rather than asserted — `duplicate-score.property.test.ts` runs the
 * symmetry over generated pairs and the repeat-evaluation invariance over a thousand calls — because
 * they are the two properties a reviewer of a merge queue relies on without knowing they do: a pair
 * that scores differently depending on which record the query happened to return first is a queue
 * whose contents change when the ordering does.
 */
export function scoreDuplicatePair(
  a: DuplicateSubject,
  b: DuplicateSubject,
  thresholds: DuplicateThresholds = PROVISIONAL_DUPLICATE_THRESHOLDS,
): DuplicateScore {
  const phone = classifyPhoneAgreement(a.phone, b.phone)
  const label = classifyLabelAgreement(a.label, b.label)
  const scorePerMille = AGREEMENT_SCORES[phone][label]
  const score = scorePerMille / 1000
  return { score, scorePerMille, phone, label, verdict: duplicateVerdict(score, thresholds) }
}
