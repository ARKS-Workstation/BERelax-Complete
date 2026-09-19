/**
 * Stagger: the delay between siblings, and the point at which siblings stop animating at all.
 *
 * docs/08 §5: 40ms for six or fewer, 24ms for seven to twelve, **total capped at 240ms**, and above
 * twelve the container animates once and the children do not.
 *
 * ## Where the two numbers disagree, and which one wins
 *
 * The step and the total cap are not independent: the last child's delay is `(count - 1) × step`, so
 * twelve siblings at 24ms would finish arriving 264ms after the first. The cap wins and the step is
 * reduced to 21ms, because the cap is the constraint a *reader* perceives — the interval between two
 * rows is barely distinguishable at 21ms versus 24ms, while a list that keeps arriving for a third of a
 * second after it was asked for reads as slow. docs/08 §5 should say that the step is a target and the
 * total is a limit.
 *
 * ## Why twelve is a cliff rather than a taper
 *
 * A thirty-row list staggered at any interval is a progress bar the reader did not ask for, and the
 * last row arrives long after the eye has moved on. Above twelve the whole container carries one
 * animation: the group arrives, which is what the motion was communicating in the first place.
 *
 * Pure: no DOM, no React, no clock. The CSS half is `[data-stagger] > *` in `motion/tokens.css`, which
 * multiplies the `--stagger` token by the group's `--stagger-scale` and each child's `--stagger-index`.
 * That indirection is what makes reduced motion free — the token override sets `--stagger: 0ms` and every
 * delay in the document becomes zero without a component branching on anything. It is also why the
 * container carries a *scale* rather than a step: see `staggerContainerVars`.
 */

/** The step docs/08 §5 asks for at six siblings or fewer. */
export const STAGGER_STEP_SMALL_MS = 40

/** The step from seven siblings up, before the total cap is applied. */
export const STAGGER_STEP_LARGE_MS = 24

/** The last child must have arrived by this point, however many siblings there are. */
export const STAGGER_TOTAL_CAP_MS = 240

/** Above this many siblings the container animates once and the children do not. */
export const STAGGER_MAX_CHILDREN = 12

export interface Stagger {
  /** The delay between one sibling and the next, in milliseconds. Zero when children do not animate. */
  readonly delayMs: number
  /**
   * False above twelve siblings: the caller animates the container instead and gives no child an
   * index. It is returned rather than inferred at the call site so the decision is made in one place.
   */
  readonly animateChildren: boolean
}

/**
 * The stagger for a sibling count.
 *
 * 6 → 40ms, 10 → 24ms, 12 → 21ms (the total cap biting), 13 → no child animation at all.
 */
export function staggerFor(count: number): Stagger {
  if (count > STAGGER_MAX_CHILDREN) return { delayMs: 0, animateChildren: false }
  const step = count <= 6 ? STAGGER_STEP_SMALL_MS : STAGGER_STEP_LARGE_MS
  // `count - 1`, because the *last* child's delay is what the cap is about. Dividing by `count` looks
  // like the same thing and is not: it under-uses the budget at every size and still leaves the step
  // wrong at twelve.
  const spans = Math.max(1, count - 1)
  return {
    delayMs: Math.min(step, Math.floor(STAGGER_TOTAL_CAP_MS / spans)),
    animateChildren: true,
  }
}

/** The delay the nth child of a staggered group actually waits, in milliseconds. */
export function staggerDelayMs(index: number, count: number): number {
  const { delayMs, animateChildren } = staggerFor(count)
  return animateChildren ? delayMs * index : 0
}

/**
 * Custom properties for the container of a staggered group.
 *
 * ## Why this is a unitless scale and not the step in milliseconds
 *
 * The obvious version sets `--stagger: 24ms` on the container. It was written that way, and the browser
 * assertion in `apps/web/src/motion.itest.ts` caught what is wrong with it: an inline custom property on
 * the container **shadows the token**, so the reduced-motion override on `:root` never reaches the
 * children and a reader who asked for no motion still gets a list arriving over a fifth of a second. The
 * failure is silent — the delays are right in every other respect — and it is exactly the per-component
 * branch docs/08 §5 sets out to avoid, arrived at by accident.
 *
 * So the container carries how much the group *compresses* the base step, as a number, and the step
 * itself stays in the token layer where one override can zero it: `--stagger: 40ms` at six siblings or
 * fewer, scaled by 0.6 at ten and 0.525 at twelve. `0ms × anything` is `0ms`.
 *
 * The key type is `--${string}` rather than React's `CSSProperties` for two reasons: this module is in
 * the root typecheck project, which has no React types and no DOM lib (see `packages/ui/src/index.ts`),
 * and a map whose keys are all custom properties is assignable to a `style` prop while a
 * `Record<string, string>` is not — every real CSS property in `CSSProperties` has a narrower type than
 * `string`, so a bare string index signature collides with all of them.
 *
 * An empty object above twelve siblings, so nothing sets a scale on a group whose children carry no
 * index — a factor nobody multiplies is a value somebody will later mistake for the delay in force.
 */
export function staggerContainerVars(count: number): Record<`--${string}`, string> {
  const { delayMs, animateChildren } = staggerFor(count)
  if (!animateChildren) return {}
  return { '--stagger-scale': String(delayMs / STAGGER_STEP_SMALL_MS) }
}

/**
 * Custom properties for one child of a staggered group.
 *
 * Empty above twelve siblings: no index means the `calc()` in `motion/tokens.css` falls back to `0`, so
 * every child's delay is zero and the container's single animation is the whole effect.
 */
export function staggerChildVars(index: number, count: number): Record<`--${string}`, string> {
  return staggerFor(count).animateChildren ? { '--stagger-index': String(index) } : {}
}
