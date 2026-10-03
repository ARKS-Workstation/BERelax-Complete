/**
 * What the till says when it could not do something (H-HARD-08).
 *
 * ## The rule this module exists to make checkable
 *
 * **The till says what it could not do, and never that it succeeded.** The salon's wifi will drop
 * mid-checkout — that is the unit's premise, not a hypothetical — and the failure mode that matters is not
 * the one where nothing happens. It is the one where something happened and the screen says the wrong thing
 * about it.
 *
 * There are exactly three states a terminal can be in when a card payment's request does not come back, and
 * they are not the same fact. {@link TILL_FAILURE_STATES} names them, {@link TILL_FAILURE_SENTENCES} is the
 * one sentence each shows, and {@link tillFailureSentenceProblems} refuses a sentence that claims more than
 * the state supports.
 *
 * ## Why an offline QUEUE is the defect and not the feature
 *
 * The obvious thing to build is offline tolerance: hold the payment locally, send it when the network comes
 * back, show the operator a tick. Every word of that is wrong here.
 *
 * A queued money movement is a **promise this system cannot keep**. The browser holding it can be closed,
 * the device can be swapped, the till can be cashed up and the day closed — and when the queue finally
 * drains it authorises a card for a customer who left two hours ago, against an invoice somebody has since
 * voided, into an accounting period that may be locked (M-VAT-06). Worse, the tick the operator saw is a
 * claim the system made on behalf of a gateway it never reached: *"paid"* is the one word a till must not
 * say on its own authority.
 *
 * So there is no queue, and `scripts/check-offline-money.mjs` is what keeps there being none: it refuses a
 * browser store, an offline API or a deferred-send construct anywhere on the money path, with a known-bad
 * fixture in gate block 196 proving it fires.
 *
 * ## What replaces it: a reference, and a claim a human makes later
 *
 * The attempt already carries an **idempotency key**, minted per attempt and put in the form before the
 * operator touches anything (`handleCheckoutRead`). {@link tillAttemptReference} turns it into something a
 * person can write on paper and read back over a phone. That is the whole offline story:
 *
 *   1. the operator writes the reference down and takes payment the way the salon took payment before this
 *      system existed — ADR 0107's position, that the paper side is a NAMED PERSON'S CLAIM;
 *   2. the day sheet (`/day-sheet/print`) is printed in advance, so the floor knows what it is delivering
 *      without the network;
 *   3. when the network returns, somebody looks the reference up and records what actually happened.
 *
 * Step 3 is a human act with an actor, and `parallel_run_paper_count` (0153, ZY742) is the shape a paper
 * claim already takes in this build: a row whose value is that a named person stood behind it. This module
 * adds no table, because the claim it needs is one that table already models.
 */

/**
 * The three states, and they are three because they are three different facts.
 *
 * `did_not_leave_this_terminal` is the benign one: the request never reached the server, so nothing moved
 * anywhere and the operator may simply try again. `unknown_whether_it_completed` is the dangerous one and
 * the reason this module exists: the request left and no answer came back, so the money may have moved and
 * this terminal cannot tell. `refused_before_the_money_moved` is the server's own answer arriving intact.
 *
 * A design with two states — "it worked" and "it did not" — collapses the first two into the second, which
 * is the lie: an operator told "it did not work" takes payment again, and the customer is charged twice.
 */
export const TILL_FAILURE_STATES = [
  'did_not_leave_this_terminal',
  'unknown_whether_it_completed',
  'refused_before_the_money_moved',
] as const

export type TillFailureState = (typeof TILL_FAILURE_STATES)[number]

/**
 * The one sentence each state shows.
 *
 * Written here rather than in the renderer for the reason the descriptor's privacy claim gives (ADR 0110):
 * the wording IS the product. A sentence assembled at a call site is a sentence somebody paraphrases, and
 * the paraphrase of "we do not know whether this completed" is "it did not work".
 */
export const TILL_FAILURE_SENTENCES: Readonly<Record<TillFailureState, string>> = Object.freeze({
  did_not_leave_this_terminal:
    'This terminal could not reach the system, so the request never left it and no payment was taken ' +
    'anywhere. Nothing is recorded and nothing is waiting: try again when the connection is back.',
  unknown_whether_it_completed:
    'The request left this terminal and no answer came back, so WHETHER THE PAYMENT WAS TAKEN IS NOT ' +
    'KNOWN HERE. Do not tell the customer it failed and do not take payment again. Write the reference ' +
    'below down, and look it up on the payments screen once the connection is back: the attempt carries ' +
    'that reference, so a repeat of the same attempt cannot charge twice.',
  refused_before_the_money_moved:
    'The system answered and refused this payment, so no money moved. The reason is on the screen above ' +
    'and the amount can be corrected and submitted again.',
})

/**
 * Words a till's failure sentence may never contain, with the reason each is forbidden.
 *
 * The forbidden set is about CLAIMS and not about tone. Each of these words tells an operator that
 * something is in hand when the one thing this module exists to say is that it is not:
 *
 *   - `queued`, `pending sync`, `will be sent`, `will retry` — a promise about a future send;
 *   - `saved offline`, `offline mode` — a claim that a store holds the money movement;
 *   - `paid`, `succeeded`, `complete` — the gateway's answer, asserted by a terminal that did not get it.
 *
 * `tillFailureSentenceProblems` is the check, and it runs over the shipped sentences rather than over a
 * fixture, so the table above cannot acquire one of these words without a test failing.
 */
export const TILL_FORBIDDEN_FAILURE_PHRASES = [
  // `queue` and not `queued` as well: the shorter one subsumes the longer, and two overlapping entries
  // make one offending sentence produce two reports — which the test caught while asserting that each
  // phrase is reported exactly once. A list whose entries overlap is a list whose count means nothing.
  'queue',
  'pending sync',
  'will be sent',
  'will retry',
  'retry later',
  'saved offline',
  'offline mode',
  'stored locally',
  'has been paid',
  'payment succeeded',
  'payment complete',
] as const

/**
 * The phrases in `sentences` that a till may not say, as `state: phrase` pairs.
 *
 * Returned rather than thrown so a test prints every problem at once, and so the empty array is the
 * assertion. The comparison is case-insensitive and on the whole phrase, because `queue` as a substring of
 * `queueing` is the same claim while `queue` inside a word like `queueless` is not something anybody writes.
 */
export function tillFailureSentenceProblems(
  sentences: Readonly<Record<string, string>> = TILL_FAILURE_SENTENCES,
): readonly string[] {
  const problems: string[] = []
  for (const [state, sentence] of Object.entries(sentences)) {
    const lowered = sentence.toLowerCase()
    for (const phrase of TILL_FORBIDDEN_FAILURE_PHRASES) {
      if (lowered.includes(phrase)) {
        problems.push(
          `${state}: the sentence contains "${phrase}", which claims something this terminal cannot ` +
            'know. A till says what it could not do and never that it succeeded.',
        )
      }
    }
  }
  return problems
}

/**
 * The attempt's reference, as a person reads it out.
 *
 * Derived from the idempotency key the attempt already carries, so there is no second identifier to go
 * wrong: the thing written on paper and the thing that makes a repeat safe are the same value. Grouped in
 * fours and upper-cased, which is what makes a sixteen-character string transcribable over a phone — and
 * the grouping is presentational only, so {@link tillAttemptKeyFrom} reverses it exactly.
 *
 * Twelve characters of the key, not all of it. A full uuid read aloud is misread; twelve hex characters
 * leave 2^48 values, which is more than a salon will ever take in payments, and the key itself is still the
 * authority — this is a handle for finding the attempt, not a replacement for it.
 */
export function tillAttemptReference(idempotencyKey: string): string {
  const cleaned = idempotencyKey
    .replace(/[^0-9a-zA-Z]/g, '')
    .toUpperCase()
    .slice(0, 12)
  const groups: string[] = []
  for (let index = 0; index < cleaned.length; index += 4) {
    groups.push(cleaned.slice(index, index + 4))
  }
  return groups.join('-')
}

/** The reference's own characters, so a lookup can match what somebody typed back in. */
export function tillAttemptKeyFrom(reference: string): string {
  return reference.replace(/[^0-9a-zA-Z]/g, '').toUpperCase()
}

/**
 * What a human does when the till cannot reach the system, in order.
 *
 * Steps and not prose, because this is read standing up with a customer waiting. Step 4 is the one that
 * makes the rest safe and it is the one a design with an offline queue does not have: somebody RECORDS,
 * later, what actually happened — which is ADR 0107's paper claim, an act with a named actor behind it,
 * rather than a drain of a queue nobody watched.
 */
export const PAPER_FALLBACK_STEPS: readonly string[] = Object.freeze([
  'Write down the reference shown on this screen, the amount and the time.',
  'Take payment the way the salon took payment before this system existed, and give the customer a ' +
    'hand-written receipt. The card terminal, if there is one, is its own device and is not this screen.',
  'Use the printed day sheet for the rest of the shift: it lists every treatment for this trading day, ' +
    'including the ones after midnight, and it was printed before the connection went.',
  'When the connection is back, look the reference up on the payments screen BEFORE taking payment again, ' +
    'and record what happened as a claim with your name on it. Nothing in this system will have recorded ' +
    'it for you, and nothing was waiting to.',
])
