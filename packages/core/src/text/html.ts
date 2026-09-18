/**
 * HTML text helpers.
 *
 * Pure string work, kept in core so the PDF renderer, the transactional email templates and the web
 * layer all escape and isolate the same way. Nothing here touches a DOM or a framework.
 */

import { isolateAuto, isolateLtr, isolateRtl, stripBidiControls } from './bidi.ts'

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Escapes text for interpolation into element content or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char)
}

/**
 * Escapes untrusted text and strips bidi controls from it.
 *
 * This is the function every customer-supplied value goes through. Escaping alone stops markup
 * injection; it does nothing about a U+202E that silently reverses the rest of the line.
 */
export function safeText(text: string): string {
  return escapeHtml(stripBidiControls(text))
}

export type Direction = 'ltr' | 'rtl' | 'auto'

/**
 * Renders an isolated run as a `<bdi>` element.
 *
 * `<bdi>` is the HTML spelling of an isolate, and it is the right one for a document: it survives an
 * HTML minifier and a CSS `direction` change, and it leaves no stray control characters in text the
 * reader copies out of the finished PDF. Plain-text channels — SMS, an email text part — use
 * {@link isolateLtr} and friends instead, because there are no tags to carry the meaning.
 */
export function bdi(text: string, dir: Direction = 'auto'): string {
  return `<bdi dir="${dir}">${safeText(text)}</bdi>`
}

/**
 * Isolates a run in plain text, choosing the control from the declared direction.
 *
 * Kept next to {@link bdi} so a caller switching channel changes one word, not the whole approach.
 */
export function isolatePlain(text: string, dir: Direction = 'auto'): string {
  if (dir === 'ltr') return isolateLtr(text)
  if (dir === 'rtl') return isolateRtl(text)
  return isolateAuto(text)
}
