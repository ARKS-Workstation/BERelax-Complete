/**
 * Publication: the state machine and the publish-time weight check (W-SITE-10).
 *
 * Both are pure and both are mirrors of a layer that enforces them elsewhere — the machine of migration
 * 0093's CHECK and trigger, the weight check of docs/08 §8's budget table. Each module's header says which
 * layer is authoritative and how the pair is asserted to agree, because a mirror nobody compares is the
 * second statement of a fact that drifts.
 *
 * `../access/publication.ts` is the third member of the subject and is deliberately not re-exported from
 * here: it is the authorisation chokepoint, it is exported from the barrel already, and
 * `.dependency-cruiser.cjs` names its PATH in the rule that keeps the SEO agent away from a publish path.
 * A second spelling of that path would be a second thing for that rule to have to know about.
 */

export * from './content.ts'
export * from './state-machine.ts'
export * from './weight.ts'
