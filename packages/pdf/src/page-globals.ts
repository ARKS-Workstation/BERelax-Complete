/**
 * The browser globals this package touches inside `page.evaluate`, typed locally.
 *
 * The obvious fix for "Cannot find name 'document'" is to add `"dom"` to the project's `lib`. That
 * would also hand `document`, `window` and `localStorage` to `packages/core`, whose whole
 * constraint is that it cannot reach a runtime — and the purity gate watches for Node globals, not
 * browser ones, so nothing would catch it. Declaring the handful of shapes needed here keeps the
 * types where the browser actually is.
 *
 * These are types only. They erase at compile time, so a `page.evaluate` callback may reference them
 * even though it may not reference any runtime value from this module.
 */

export interface PageElement {
  getBoundingClientRect(): { readonly width: number; readonly height: number }
}

export interface PageDocument {
  /** Resolves when every declared `@font-face` has loaded, or failed to. */
  readonly fonts: { readonly ready: Promise<unknown> }
  getElementById(id: string): PageElement | null
}

/** `globalThis` as seen from inside the page. Cast to this at the top of an evaluate callback. */
export interface PageGlobals {
  readonly document: PageDocument
}
