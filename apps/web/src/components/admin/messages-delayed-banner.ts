import { escapeHtml } from '@berelax/core'

/**
 * The "messages are delayed" banner, on every admin document.
 *
 * ## Why it is here and not a `.tsx` in `app/(admin)/_components/`
 *
 * The manifest names a `.tsx` component; this application has none for an admin surface and the reason is
 * structural rather than stylistic. `apps/web/src/routes/registry.ts` is in exact bijection with the
 * filesystem and requires every *document* to be served in both locales, so an admin `page.tsx` would need
 * an Arabic admin document and a root layout to render it, and it would join a screenshot matrix whose RTL
 * half must be a real Arabic route. Four units have now found this and reached the same shape:
 * `route.ts` plus `render.ts`, with shared markup in `apps/web/src/components/admin/`. The Google re-auth
 * banner is the precedent and it is one file along.
 *
 * ## Why the banner and the alert cannot disagree
 *
 * This file renders; it decides nothing. `readSendBacklogBanner` evaluates the `send_backlog` entry in
 * `ALERT_REGISTRY` through the SAME `evaluateAlert` the worker's alert pass uses, against the same
 * observer and the same threshold setting. So "the banner is up" and "the alert is firing" are one fact
 * read twice rather than two facts that agree today — which is the brief's rule about a second statement
 * of a fact, and the failure it prevents is specific: a banner with its own `queued > 20` would still be
 * showing after somebody raised the threshold, or absent after they lowered it.
 *
 * ## Why there is no dismiss control
 *
 * The same argument the re-auth banner makes for its `broken` state. What is being said is *do not tell a
 * client their confirmation has gone out*, and a receptionist who dismissed it an hour ago is exactly the
 * person who will. There is no `<button>`, no `<details>`, no `hidden` attribute and no `[id]` here, so
 * there is nothing for a script or a stylesheet to target by name — and these documents ship no client
 * bundle at all, so a banner that depended on script would be absent exactly when script was.
 */

/** The banner's styles. Tokens only; `pnpm colours` rejects a literal hex outside the token layer. */
export const MESSAGES_DELAYED_BANNER_CSS = `
  .messages-delayed {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-inline-start-color: var(--color-ink);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    color: var(--color-ink);
    padding: var(--space-4) var(--space-5);
    margin: 0 0 var(--space-6);
  }
  .messages-delayed h2 {
    font-size: 1.0625rem;
    line-height: 1.3;
    font-weight: 600;
    margin: 0 0 var(--space-2);
  }
  .messages-delayed p { margin: 0 0 var(--space-3); }
  .messages-delayed p:last-child { margin-bottom: 0; }
`

/** The attribute a test queries for, and the rule name the gate fixtures are caught by. */
export const MESSAGES_DELAYED_BANNER_ATTRIBUTE = 'data-messages-delayed'

/**
 * What the banner needs, or `null` when the backlog is inside its threshold.
 *
 * Both figures, not just the verdict. A banner that said only "messages are delayed" leaves a reader with
 * no way to tell a blip from a stoppage, and the threshold is on it so somebody who thinks the banner is
 * noise can see which setting to change rather than asking for the banner to be removed.
 */
export interface SendBacklogView {
  readonly queued: number
  readonly threshold: number
}

/**
 * The banner, or the empty string.
 *
 * The count is rendered as a number this build computed and not as a figure anybody supplied, so there is
 * nothing here to escape beyond the defensive `escapeHtml` on the interpolations — which stays, because a
 * renderer that is safe only because of its current callers is one refactor from not being.
 */
export function renderMessagesDelayedBanner(view: SendBacklogView | null): string {
  if (view === null) return ''
  const plural = view.queued === 1 ? 'message is' : 'messages are'
  return (
    `<section class="messages-delayed" ${MESSAGES_DELAYED_BANNER_ATTRIBUTE}="${escapeHtml(
      String(view.queued),
    )}" data-threshold="${escapeHtml(String(view.threshold))}" role="region" ` +
    'aria-label="Message sending is delayed">' +
    '<h2>Messages are delayed</h2>' +
    `<p>${escapeHtml(String(view.queued))} ${plural} queued and no provider has accepted ` +
    'them yet. Do not tell a client that their confirmation or reminder has been sent.</p>' +
    `<p>The alert fires at ${escapeHtml(String(view.threshold))}. This banner clears by itself once ` +
    'the queue drains — there is nothing to dismiss.</p>' +
    '</section>'
  )
}
