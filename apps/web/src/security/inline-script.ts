import { escapeHtml } from '@berelax/core'

/**
 * The one way an admin document emits an inline `<script>` (H-HARD-01).
 *
 * ## Why a helper and not seven copies of one attribute
 *
 * Seven documents in this estate carry an inline script, and under the admin group's
 * `script-src 'nonce-…'` policy every one of them has to carry the nonce. Seven copies of
 * `nonce="${escapeHtml(...)}"` is seven places to get the escaping wrong and seven places for the
 * attribute to be forgotten — and the forgotten one fails at runtime in a browser, not at build.
 *
 * So there is one function, and `apps/web/src/security-headers.test.ts` walks the admin estate and
 * refuses a bare `<script>` opening anywhere in it. The scan is what makes this load-bearing: a helper
 * nothing is obliged to use is a convention.
 *
 * ## Why the nonce is escaped although it is base64
 *
 * `mintCspNonce` produces base64, which contains `+`, `/` and `=` and nothing an attribute value cares
 * about. The escape is here anyway for the reason `breakpoint-preview.ts` gives about its own JSON escape:
 * the day this carries a value from somewhere else is the day it matters, and an attribute built by string
 * concatenation with no escape is the shape a reviewer stops looking at.
 *
 * ## The empty nonce is deliberate and is the fail-closed case
 *
 * `undefined` renders `nonce=""`, which matches no `'nonce-…'` source, so the script does not run. That
 * happens exactly when no proxy set the header — a handler driven directly by a test — and it is the right
 * answer: a document whose script silently ran without a nonce would mean the policy was not being
 * applied, which is the thing this unit exists to refuse.
 */
export function inlineScriptTag(nonce: string | undefined, source: string): string {
  return `<script nonce="${escapeHtml(nonce ?? '')}">${source}</script>`
}
