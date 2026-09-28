/**
 * The three node kinds that act outside the run, one module each (C-AUTO-07).
 *
 * `FLOW_NODE_KINDS` has eight members and five of them change nothing a contact can see — a trigger, a
 * delay, a condition, a split and an exit are all decisions the interpreter takes about where to go next,
 * and `planFlowStep` in `@berelax/core` takes them with no I/O at all. What is left is the three that reach
 * out of the run, and each of them is here because its failure modes are its own:
 *
 *   - `message.ts` — the only one that talks to a vendor, and therefore the only one the idempotency token,
 *     the compliance gate and the frequency ledger are about;
 *   - `tag.ts` — an insert that must be idempotent without a token, because a tag a contact already carries
 *     is not a second tag;
 *   - `stage.ts` — a call into `moveCard`, which is C-AUTO-08's write and the only moment an
 *     `action_stage` node's stage can be checked against a board that changes.
 *
 * `NodeEffect` is the shape all three return, and it is deliberately the set of columns a `flow_step_log`
 * row carries: a node that produced an effect nobody could write down would be an effect nobody can explain.
 */
export { type NodeContext, type NodeEffect, noEffect } from './effect.ts'
export { executeMessageNode, type MessageNodeDeps } from './message.ts'
export { executeStageNode } from './stage.ts'
export { executeTagNode } from './tag.ts'
