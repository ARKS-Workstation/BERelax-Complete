/**
 * The compliance gate, as one barrel: the decision, the window, and the edge wiring.
 *
 * ## Why the gate's body is in `decide.ts` and this file re-exports it
 *
 * It was in this file, and that was a defect — caught by reading `vitest.config.ts` rather than by any
 * check, which is why it is written down here. The coverage configuration excludes `**\/index.ts`, because
 * a barrel is a list of re-exports and counting it either inflates the number or invites a test of the
 * list. Perfectly right for a barrel, and it meant that moving `gate.ts` to `gate/index.ts` silently
 * removed the PROMOTIONAL COMPLIANCE GATE from the coverage floor entirely — the one module in this package
 * whose uncovered branch is a promotional SMS to somebody who opted out.
 *
 * Nothing would have failed. The suites all pass, `pnpm coverage` would have reported a number that had
 * quietly stopped being about the gate, and the floor would have been satisfied by everything else in
 * `packages/messaging`. So the body lives in `decide.ts`, where the floor counts it, and this file is what
 * the exclusion is actually for.
 *
 * The three modules and the line between them:
 *
 *   - `decide.ts` — `evaluateGate`, the decision every promotional send passes through, and the evaluator
 *     wrapper that turns a throw or a non-boolean into `blocked_unevaluable` rather than into permission;
 *   - `window.ts` — the promotional window as a SETTING (its bounded change rule, read by the admin surface
 *     as well as by the gate) and the adaptor onto the pure rule in `@berelax/core`;
 *   - `wire.ts` — the edge wiring: the three real evaluators assembled over one prefetch at one instant;
 *   - `kill-switch.ts` — C-AUTO-05's marketing kill switch: the promotional-only parameter type that makes
 *     "structurally cannot touch transactional traffic" a compile error rather than a comment, the
 *     non-production default, who may toggle it, and the held/refused classification a recipient list is
 *     counted in.
 *
 * `evaluatePromotionalGate` is deliberately NOT re-exported here. It is exported from `decide.ts` so its
 * promotional-only parameter can be asserted by a test, and keeping it out of the barrel keeps `evaluateGate`
 * the only way into the gate that autocomplete offers — the alternative is an entry point that skips step 1.
 */

export {
  evaluateGate,
  type GateAttempt,
  type GateContext,
  type GateDecision,
  type GateEvaluatorName,
  type GateEvaluators,
  type GateRefusal,
  type PromotionalOutboundMessage,
} from './decide.ts'
export {
  assertMayToggleMessagingControl,
  type KillSwitchVerdict,
  killSwitchVerdict,
  MARKETING_KILL_SWITCH_REASON,
  type MarketingKillSwitchSource,
  type MarketingKillSwitchState,
  PROMOTIONAL_HOLD_REASONS,
  type PromotionalOnly,
  type PromotionalSendDisposition,
  type PromotionalSendingBanner,
  type PromotionalSendingBannerState,
  promotionalSendDisposition,
  promotionalSenderSuspensionSuspected,
  promotionalSendingBanner,
  resolveMarketingKillSwitch,
} from './kill-switch.ts'
export {
  asPromotionalWindow,
  assertPromotionalWindowChange,
  type DatedPromotionalOverride,
  decideSendWindow,
  MAX_QUEUED_PROMOTIONAL_STALENESS_SECONDS,
  nextPromotionalWindowOpen,
  PROMOTIONAL_WINDOW_SETTING_KEY,
  type PromotionalWindow,
  type SendWindowQuestion,
  TDRA_PROMOTIONAL_WINDOW,
  withinPromotionalWindow,
} from './window.ts'
export {
  type GateEvaluatorSources,
  type PromotionalGateReads,
  promotionalGateEvaluators,
} from './wire.ts'
