/**
 * Theme and direction resolution, as pure functions.
 *
 * The rules are small and the failure modes are not. Both are stated once here and consumed by the
 * provider, the server layout and the inline script, so a page rendered on the server and the same
 * page after hydration cannot disagree about which theme it is in — which is the flash every
 * theme-switching site has and nobody wants.
 */

import type { Theme } from '../tokens/palette.ts'

export type { Theme }

/** `system` means "no attribute", so the media query decides. */
export type ThemePreference = Theme | 'system'
export type Direction = 'ltr' | 'rtl'
export type Locale = 'en' | 'ar'

export const THEME_ATTRIBUTE = 'data-theme'
export const THEME_STORAGE_KEY = 'berelax:theme'
/** WCAG 2.2.2: the reader's pause choice is remembered. docs/08 §6. */
export const MOTION_STORAGE_KEY = 'berelax:motion'

/** Arabic is the only right-to-left locale this system serves. */
export function directionFor(locale: Locale): Direction {
  return locale === 'ar' ? 'rtl' : 'ltr'
}

/**
 * The attribute value for a preference.
 *
 * `system` renders **no attribute**, so the `prefers-color-scheme` media query in the token
 * stylesheet decides. Writing `data-theme="light"` for a system preference would pin the page to
 * light on a dark device, which is the opposite of what "system" means.
 */
export function themeAttributeFor(preference: ThemePreference): Theme | undefined {
  return preference === 'system' ? undefined : preference
}

/**
 * The script that runs before first paint.
 *
 * It exists for one reason: a stored preference lives in `localStorage`, the server cannot read it,
 * and a page that corrects itself after hydration flashes the wrong theme for a frame. Setting the
 * attribute in a blocking inline script is the only way to get it right on the first paint.
 *
 * It is deliberately tiny and deliberately total — a `try` around the storage read, because
 * `localStorage` throws in a private window and a theme script that throws takes the page with it.
 */
export function themeBootstrapScript(): string {
  return (
    `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
    `if(t==='light'||t==='dark')document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},t);}catch(e){}})()`
  )
}
