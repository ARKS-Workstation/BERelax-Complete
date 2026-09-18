/**
 * Browser globals the harness touches inside the page, typed locally.
 *
 * Same reasoning as `packages/pdf/src/page-globals.ts`: adding `"dom"` to the project's `lib` would
 * hand `document` and `window` to `packages/core`, whose entire constraint is that it cannot reach a
 * runtime, and the purity gate watches for Node globals rather than browser ones. Types only; they
 * erase, so a `page.evaluate` callback may reference them.
 */

export interface HarnessElement {
  readonly tagName: string
  readonly id: string
  readonly className: string
  readonly textContent: string | null
  getBoundingClientRect(): {
    readonly width: number
    readonly height: number
    readonly top: number
    readonly left: number
  }
  readonly parentElement: HarnessElement | null
  getAttribute(name: string): string | null
  closest(selector: string): HarnessElement | null
}

export interface HarnessStyle {
  getPropertyValue(property: string): string
}

export interface HarnessStyleSheet {
  /** Throws on a cross-origin sheet, which is why every read of it is guarded. */
  readonly cssRules: ArrayLike<{ readonly cssText: string }>
}

export interface HarnessDocument {
  readonly fonts: { readonly ready: Promise<unknown> }
  readonly styleSheets: ArrayLike<HarnessStyleSheet> & Iterable<HarnessStyleSheet>
  readonly documentElement: HarnessElement & { setAttribute(name: string, value: string): void }
  readonly body: HarnessElement
  querySelectorAll(selector: string): ArrayLike<HarnessElement> & Iterable<HarnessElement>
  getElementById(id: string): HarnessElement | null
}

export interface PageGlobalsForHarness {
  document: HarnessDocument
  Math: { random(): number }
  Date: DateConstructor
  getComputedStyle(element: HarnessElement): HarnessStyle
  devicePixelRatio: number
}
