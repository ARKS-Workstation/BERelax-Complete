/**
 * The committed flow-definition corpus: twelve valid documents and twelve invalid ones, each invalid one
 * paired with the rule it must be refused BY.
 *
 * Why a list rather than a directory read. `packages/core` may not do I/O — `core-must-be-pure` forbids
 * `node:fs` from every module here, tests included — so the corpus reaches a core test as static imports.
 * That is not a workaround: it makes the pairing of a document with its expected rule a typechecked fact
 * rather than a filename convention, and a corpus file added without a rule beside it does not compile.
 *
 * The bytes are asserted separately. `packages/fixtures/src/flow-corpus.test.ts` may read files, and it
 * asserts three things this list cannot: that every `.json` in the directory appears here (so a file
 * cannot be added and left unexercised), that each valid file's bytes are EXACTLY what
 * `serialiseFlowDefinition` produces for it, and that the count is twelve and twelve.
 */
import type { FlowRule } from '../../../src/automation/dsl.ts'
import invalid01 from './invalid-01-unknown-node-kind.json' with { type: 'json' }
import invalid02 from './invalid-02-dangling-edge.json' with { type: 'json' }
import invalid03 from './invalid-03-missing-trigger.json' with { type: 'json' }
import invalid04 from './invalid-04-promotional-action-on-transactional-template.json' with {
  type: 'json',
}
import invalid05 from './invalid-05-dead-end-node.json' with { type: 'json' }
import invalid06 from './invalid-06-cycle-with-no-bounded-exit.json' with { type: 'json' }
import invalid07 from './invalid-07-accumulated-delay-over-the-maximum.json' with { type: 'json' }
import invalid08 from './invalid-08-duplicate-node-id.json' with { type: 'json' }
import invalid09 from './invalid-09-two-triggers.json' with { type: 'json' }
import invalid10 from './invalid-10-unreachable-node.json' with { type: 'json' }
import invalid11 from './invalid-11-condition-with-one-branch.json' with { type: 'json' }
import invalid12 from './invalid-12-node-count-over-the-maximum.json' with { type: 'json' }
import valid01 from './valid-01-post-visit-review-request.json' with { type: 'json' }
import valid02 from './valid-02-review-request-split-test.json' with { type: 'json' }
import valid03 from './valid-03-no-show-stage-move.json' with { type: 'json' }
import valid04 from './valid-04-bounded-nurture-loop.json' with { type: 'json' }
import valid05 from './valid-05-reminder-before-visit.json' with { type: 'json' }
import valid06 from './valid-06-therapist-change-notice.json' with { type: 'json' }
import valid07 from './valid-07-vip-visit-tag.json' with { type: 'json' }
import valid08 from './valid-08-arabic-locale-review.json' with { type: 'json' }
import valid09 from './valid-09-lifecycle-lapsed-confirmation.json' with { type: 'json' }
import valid10 from './valid-10-dormancy-at-the-delay-ceiling.json' with { type: 'json' }
import valid11 from './valid-11-four-way-split.json' with { type: 'json' }
import valid12 from './valid-12-sixty-node-ceiling.json' with { type: 'json' }

export interface ValidFlowFixture {
  readonly file: string
  readonly document: unknown
}

export interface InvalidFlowFixture extends ValidFlowFixture {
  /** The rule this document must be refused by. Asserted by NAME, never by "it was refused". */
  readonly rule: FlowRule
  /** Why this document is the interesting version of that rule. */
  readonly why: string
}

export const VALID_FLOW_FIXTURES: readonly ValidFlowFixture[] = Object.freeze([
  { file: 'valid-01-post-visit-review-request.json', document: valid01 },
  { file: 'valid-02-review-request-split-test.json', document: valid02 },
  { file: 'valid-03-no-show-stage-move.json', document: valid03 },
  { file: 'valid-04-bounded-nurture-loop.json', document: valid04 },
  { file: 'valid-05-reminder-before-visit.json', document: valid05 },
  { file: 'valid-06-therapist-change-notice.json', document: valid06 },
  { file: 'valid-07-vip-visit-tag.json', document: valid07 },
  { file: 'valid-08-arabic-locale-review.json', document: valid08 },
  { file: 'valid-09-lifecycle-lapsed-confirmation.json', document: valid09 },
  { file: 'valid-10-dormancy-at-the-delay-ceiling.json', document: valid10 },
  { file: 'valid-11-four-way-split.json', document: valid11 },
  { file: 'valid-12-sixty-node-ceiling.json', document: valid12 },
])

export const INVALID_FLOW_FIXTURES: readonly InvalidFlowFixture[] = Object.freeze([
  {
    file: 'invalid-01-unknown-node-kind.json',
    document: invalid01,
    rule: 'flow-dsl-unknown-node-kind',
    why:
      'A kind nobody interprets is a step nobody takes, and a union error would name every field of ' +
      'all eight kinds instead of the one thing that is wrong.',
  },
  {
    file: 'invalid-02-dangling-edge.json',
    document: invalid02,
    rule: 'flow-dsl-dangling-edge',
    why: 'An edge to a node that is not there: the builder deleted the step and left the wire.',
  },
  {
    file: 'invalid-03-missing-trigger.json',
    document: invalid03,
    rule: 'flow-dsl-missing-trigger',
    why: 'A flow with no way in can never run, and the enrolment API would have nothing to enrol against.',
  },
  {
    file: 'invalid-04-promotional-action-on-transactional-template.json',
    document: invalid04,
    rule: 'flow-dsl-message-class-mismatch',
    why:
      'The laundering C-AUTO-01 exists to prevent, attempted from the editor: promotional intent on a ' +
      'transactional template leaves from the wrong sender identity with no opt-out route.',
  },
  {
    file: 'invalid-05-dead-end-node.json',
    document: invalid05,
    rule: 'flow-analysis-non-terminal-node-has-no-outgoing-edge',
    why: 'An enrolment that reaches the tag is neither running nor finished, and nothing can say which.',
  },
  {
    file: 'invalid-06-cycle-with-no-bounded-exit.json',
    document: invalid06,
    rule: 'flow-analysis-cycle-has-no-bounded-exit',
    why:
      'The mirror image of valid-04: the same loop with nothing leaving it, so an enrolment that ' +
      'enters can never finish.',
  },
  {
    file: 'invalid-07-accumulated-delay-over-the-maximum.json',
    document: invalid07,
    rule: 'flow-analysis-accumulated-delay-exceeds-maximum',
    why: 'valid-10 plus one minute. The boundary is asserted from both sides or it is not asserted.',
  },
  {
    file: 'invalid-08-duplicate-node-id.json',
    document: invalid08,
    rule: 'flow-dsl-duplicate-node-id',
    why:
      'Every edge naming the id is ambiguous, and one of the two nodes is unreachable with nothing ' +
      'saying so.',
  },
  {
    file: 'invalid-09-two-triggers.json',
    document: invalid09,
    rule: 'flow-dsl-more-than-one-trigger',
    why: 'Two entry points mean the pinned version cannot say which way an enrolment came in.',
  },
  {
    file: 'invalid-10-unreachable-node.json',
    document: invalid10,
    rule: 'flow-analysis-unreachable-node',
    why: 'The published flow does less than the picture of it suggests.',
  },
  {
    file: 'invalid-11-condition-with-one-branch.json',
    document: invalid11,
    rule: 'flow-analysis-condition-branch-missing',
    why: 'A condition answers both ways; the missing answer is half the audience with nowhere to go.',
  },
  {
    file: 'invalid-12-node-count-over-the-maximum.json',
    document: invalid12,
    rule: 'flow-dsl-node-count-exceeds-maximum',
    why: 'valid-12 plus one node. The other side of the same boundary.',
  },
])

/** Every fixture, valid and invalid, for the tests that treat the corpus as one set. */
export const FLOW_FIXTURES: readonly ValidFlowFixture[] = Object.freeze([
  ...VALID_FLOW_FIXTURES,
  ...INVALID_FLOW_FIXTURES,
])

/**
 * The template registry the corpus is authored against: the CURRENT classes of the seeded templates.
 *
 * Nine keys, and only `review.request` is promotional, because that is the template estate `pnpm seed`
 * actually creates (B-MSG-01, C-AUTO-01). `packages/fixtures/src/flow-corpus.itest.ts` reads the same
 * facts out of `message_template` and asserts this list agrees with the database, so a corpus authored
 * against a template that does not exist — or against a class somebody has since changed — fails rather
 * than validating against a registry of its own invention.
 */
export const CORPUS_TEMPLATES = Object.freeze([
  { templateKey: 'auth.otp', messageClass: 'transactional' },
  { templateKey: 'booking.cancelled', messageClass: 'transactional' },
  { templateKey: 'booking.confirmed', messageClass: 'transactional' },
  { templateKey: 'booking.reminder', messageClass: 'transactional' },
  { templateKey: 'booking.therapist_changed', messageClass: 'transactional' },
  { templateKey: 'compliance.obligation_escalation', messageClass: 'transactional' },
  { templateKey: 'compliance.obligation_reminder', messageClass: 'transactional' },
  { templateKey: 'invoice.issued', messageClass: 'transactional' },
  { templateKey: 'review.request', messageClass: 'promotional' },
] as const)
