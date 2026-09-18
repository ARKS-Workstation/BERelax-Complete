/**
 * What the primitive set promises, as values a test can read and a component must obey.
 *
 * ## Why this is a `.ts` file when everything beside it is `.tsx`
 *
 * The root typecheck project (`tsconfig.json`) includes `packages/**\/*.ts` and has neither `jsx` nor
 * the DOM lib — that absence is what stops a `document.querySelector` compiling inside
 * `packages/core`. So a `.tsx` file here is invisible to `pnpm typecheck`, which is exactly what
 * `@berelax/ui/layout` and `@berelax/ui/patterns` rely on.
 *
 * This file is deliberately on the other side of that line. Everything in it is framework-free — no
 * React import, no JSX, no DOM — so `pnpm typecheck` compiles it, and `contract.test.ts` beside it can
 * assert at the type level that **an icon-only button with no `aria-label` does not compile**. That
 * assertion has to live somewhere the repository's own typechecker looks, or it is a claim rather than
 * a check: `@ts-expect-error` that stops erroring is `TS2578`, and a build failure.
 *
 * It is also published as its own subpath, `@berelax/ui/primitives/contract`, so a Node test can read
 * these numbers without loading React, Radix and Lucide through the barrel.
 *
 * The geometry lives here for the same reason. `docs/08 §4` states four radii against the things that
 * wear them and `§7` states one stroke width and two icon sizes; a component that arrives at those
 * numbers through its own padding arithmetic is a component nobody can check, so the numbers are
 * written once, consumed by the CSS, and asserted against the document by `contract.test.ts`.
 */

import type { RADIUS } from '../tokens/scale.ts'

/**
 * Lucide's stroke weight. docs/08 §7.
 *
 * 1.5 rather than Lucide's default 2: the interface is set in a 17px humanist sans on warm paper, and
 * a 2px stroke beside it reads as a different, heavier system.
 */
export const ICON_STROKE_WIDTH = 1.5

/**
 * The two icon sizes, by where the icon is. docs/08 §7: 20px in UI, 24px in nav.
 *
 * Two sizes and not a scale: an icon that can be any size is an icon that will be six sizes, and the
 * optical weight of a 1.5px stroke changes with the box it is drawn in.
 */
export const ICON_SIZE = { ui: 20, nav: 24 } as const

export type IconPlacement = keyof typeof ICON_SIZE

/**
 * The floor for any control a phone keyboard can focus.
 *
 * iOS Safari zooms the viewport when a focused `input`, `select` or `textarea` computes below 16px,
 * and it does not zoom back out. On a booking form that is a page the customer has to pinch their way
 * out of, mid-transaction. The body step is 17px, so nothing here needs a special size — this is the
 * number the assertion in `apps/web/src/primitives.itest.ts` holds every form primitive to.
 */
export const MIN_FORM_FONT_SIZE_PX = 16

/**
 * Which radius each kind of thing wears. docs/08 §4, as a mapping rather than a sentence.
 *
 * `satisfies` ties every value to a real key of `RADIUS`, so renaming a token breaks this file rather
 * than silently emitting `var(--radius-undefined)`.
 */
export const RADIUS_ROLE = {
  card: '1',
  input: '1',
  chip: '1',
  button: '2',
  select: '2',
  dialog: '3',
  sheet: '3',
  handle: 'handle',
} as const satisfies Record<string, keyof typeof RADIUS>

export type RadiusRole = keyof typeof RADIUS_ROLE

/**
 * The `var()` a component writes, so the stylesheet and the assertion cannot disagree.
 *
 * The CSS references the custom property rather than the value: the token is what the page resolves,
 * and a component that inlined `8px` would keep its corners when the token moved.
 */
export function radiusVarFor(role: RadiusRole): string {
  return `var(--radius-${RADIUS_ROLE[role]})`
}

/**
 * The labelling contract: **a control that shows only an icon must carry an `aria-label`.**
 *
 * docs/08 §1 lists "icon-only buttons without labels" among the things this system does not do, and
 * every audit finds one anyway, because the omission looks like nothing at all in JSX — `<Button
 * icon="close" />` is shorter than the correct version and renders a button a screen reader announces
 * as "button".
 *
 * A discriminated union makes it a compile error instead of an audit finding:
 *
 * - the **icon-only** branch requires `aria-label` and forbids children;
 * - the **labelled** branch requires children — visible text *is* the accessible name — and leaves
 *   `aria-label` optional for the cases where the visible text is not the whole story.
 *
 * `{ icon }` alone satisfies neither branch, so it does not compile. Generic over the icon and child
 * types so this file needs no React import and stays inside the root typecheck project; `button.tsx`
 * instantiates it as `IconLabelling<IconName, ReactNode>`.
 */
export type IconLabelling<Icon, Children> =
  | {
      readonly icon: Icon
      /** Nothing visible to read, which is why the label below is not optional. */
      readonly children?: never
      readonly 'aria-label': string
    }
  | {
      readonly icon?: Icon
      readonly children: Children
      readonly 'aria-label'?: string
    }
