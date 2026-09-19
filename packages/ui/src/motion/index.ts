/**
 * The motion system's pure half.
 *
 * Only `.ts` is re-exported here, and the omission is structural rather than tidy: the two islands are
 * `.tsx`, the root typecheck project has neither `jsx` nor the DOM lib, and its `include` is
 * `packages/**\/*.ts`. A barrel that named them would drag React into every project that imports a
 * duration — and, worse, would make `@berelax/ui` a barrel whose import pulls a client reference for
 * both islands into any page's module graph. That is the defect W-SYS-09 recorded against
 * `@berelax/ui/primitives`, and the island budget in `build/budgets.json` is what would notice it here.
 *
 * The islands are reached at `@berelax/ui/motion/reveal` and `@berelax/ui/motion/header-condense`, one
 * narrow subpath each, and `pnpm layout` fails the build if either is imported other than dynamically.
 */

export {
  MOTION_FALLBACK_ATTRIBUTE,
  MOTION_FALLBACK_FAILSAFE_MS,
  MOTION_READY_ATTRIBUTE,
  motionBootstrapScript,
  SCROLL_TIMELINE_PROPERTY,
  SCROLL_TIMELINE_VALUE,
  scrollTimelineSupported,
} from './bootstrap.ts'
export {
  cssDurationForDistance,
  DURATION_CEILING_MS,
  DURATION_FLOOR_MS,
  DURATION_PER_PIXEL_MS,
  durationForDistance,
} from './duration.ts'
export type { ObservedElement, ObservedEntry, Observer, ObserverFactory } from './observe.ts'
export {
  CONDENSED_ATTRIBUTE,
  condenseWhileSentinelIsOffScreen,
  REVEAL_ROOT_MARGIN,
  REVEAL_SELECTOR,
  REVEALED_ATTRIBUTE,
  revealOnFirstIntersection,
} from './observe.ts'
export type { Stagger } from './stagger.ts'
export {
  STAGGER_MAX_CHILDREN,
  STAGGER_STEP_LARGE_MS,
  STAGGER_STEP_SMALL_MS,
  STAGGER_TOTAL_CAP_MS,
  staggerChildVars,
  staggerContainerVars,
  staggerDelayMs,
  staggerFor,
} from './stagger.ts'
