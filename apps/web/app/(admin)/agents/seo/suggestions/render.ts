import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import { ADMIN_SHELL_CSS, renderAdminChromeClose, renderAdminChromeOpen } from '@berelax/ui/admin'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../../src/components/admin/google-reauth-banner.ts'
import {
  SEO_SUGGESTIONS_FIELDS,
  SEO_SUGGESTIONS_PATH,
  type SeoSuggestionsView,
  type SuggestionCardView,
} from './view.ts'

/**
 * *SEO suggestions* — the queue a human acts on (G-SEO-05).
 *
 * Pure: a view in, a document out. No database, no clock — the instant the page was read at arrives on the
 * view and is printed, which is what lets two repeat runs produce identical screenshots.
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * The manifest's `files` list names `page.tsx`, and this is a `route.ts` + `render.ts` + `handler.ts` +
 * `view.ts` instead. Every admin surface in this build has made the same choice and records the same
 * reason: `apps/web/src/routes/registry.ts` requires every **document** to be served in BOTH locales, so a
 * `page.tsx` here would need an Arabic admin document that W-SYS-01 has not built, and it would join a
 * screenshot matrix whose RTL half has to be a real Arabic route. The three HR screens, the two settings
 * screens, the diary, the pipeline board, the quick-book screen and the review paste form all give this
 * reason. The manifest carries a NOTE saying so.
 *
 * ## The diff is the screen
 *
 * What a person has to decide is *should this sentence replace that sentence*, so the before and the after
 * sit next to each other, region by region, verbatim and escaped. Everything else on the card — the lint
 * version, the provider, the cost in fils, the token counts — is there because the question *"why is the
 * agent proposing this and what did it cost"* has to be answerable without opening a database.
 *
 * The refused suggestions get their own section rather than being hidden. A refusal is the security-
 * relevant half of this queue: an escalation attempt is already an `audit_event` with `operation = denied`,
 * and this is where a person sees that it happened at all.
 *
 * ## No JavaScript
 *
 * One `<form method="post">` per action, which works with scripting disabled. On an admin surface that
 * matters more than anywhere else: the operator is making a publishing decision, and a script that failed
 * to load would turn it into a support call.
 */

/** Every colour is a token. `pnpm colours` refuses a literal hex outside the token layer (brief rule 11). */
const SUGGESTIONS_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-7) 0 var(--space-3); }
  h3 { font-size: 1rem; margin: 0 0 var(--space-2); }
  p { margin: 0 0 var(--space-5); }
  .policy, .refusal, .done {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  ul.queue { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  ul.queue li {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-inline-start: var(--space-2) solid var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-5);
  }
  dl.meta { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0 0 var(--space-5); }
  dl.meta dt { font-weight: 600; }
  dl.meta dd { margin: 0; }
  table.diff { width: 100%; border-collapse: collapse; margin: 0 0 var(--space-5); }
  table.diff th, table.diff td {
    text-align: start;
    vertical-align: top;
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--color-hairline);
  }
  table.diff th { font-weight: 600; }
  table.diff td.copy { white-space: pre-wrap; word-break: break-word; }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-3); }
  /* 48px, because docs/08 §4's floor is the TARGET: a publishing decision taken on a phone must not be a
     tap somebody misses. */
  button {
    font: inherit;
    font-weight: 600;
    min-height: 3rem;
    padding: var(--space-3) var(--space-7);
    border: 0;
    border-radius: var(--radius-1);
    background: var(--color-ink);
    color: var(--color-ground);
  }
  ul.rules { margin: 0; padding-inline-start: var(--space-7); }
  code { font-family: ui-monospace, monospace; }
  .empty { color: var(--color-ink-muted); }
`

const fils = (amount: number): string => `${(amount / 100).toFixed(2)} AED`

function renderDiff(card: SuggestionCardView): string {
  return [
    '<table class="diff">',
    '<thead><tr><th scope="col">Region</th><th scope="col">Now</th><th scope="col">Proposed</th></tr></thead>',
    '<tbody>',
    ...card.regions.map(
      (row) =>
        `<tr><th scope="row"><code>${safeText(row.region)}</code></th>` +
        `<td class="copy">${row.before === '' ? '<span class="empty">(none)</span>' : safeText(row.before)}</td>` +
        `<td class="copy">${row.after === '' ? '<span class="empty">(none)</span>' : safeText(row.after)}</td></tr>`,
    ),
    '</tbody></table>',
  ].join('')
}

function renderCard(card: SuggestionCardView): string {
  const f = SEO_SUGGESTIONS_FIELDS
  return [
    '<li>',
    `<h3><code>${safeText(card.surface)}</code> — ${safeText(card.state)}</h3>`,
    '<dl class="meta">',
    `<dt>Proposed</dt><dd>${safeText(card.proposedAtIso)}</dd>`,
    `<dt>Judged by</dt><dd><code>${safeText(card.lintVersion)}</code></dd>`,
    `<dt>Drafted by</dt><dd>${safeText(card.llmProvider)}</dd>`,
    `<dt>Cost</dt><dd>${safeText(fils(card.costFils))} (${card.inputTokens} in, ${card.outputTokens} out)</dd>`,
    '</dl>',
    renderDiff(card),
    card.refusedRules.length === 0
      ? ''
      : [
          '<p>Refused by:</p><ul class="rules">',
          ...card.refusedRules.map((rule) => `<li><code>${safeText(rule)}</code></li>`),
          '</ul>',
        ].join(''),
    card.actions.length === 0
      ? ''
      : [
          '<div class="actions">',
          ...card.actions.map(
            (action) =>
              `<form method="post" action="${SEO_SUGGESTIONS_PATH}">` +
              `<input type="hidden" name="${f.suggestion}" value="${safeText(card.id)}">` +
              `<input type="hidden" name="${f.action}" value="${action}">` +
              `<button type="submit">${action === 'rollback' ? 'Roll back' : action === 'apply' ? 'Apply' : 'Approve'}</button>` +
              '</form>',
          ),
          '</div>',
        ].join(''),
    '</li>',
  ].join('')
}

export function renderSeoSuggestionsHtml(
  view: SeoSuggestionsView & { readonly chrome: AdminChrome },
): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's brand-collision rule forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>SEO suggestions — agents admin</title>',
    `<style>${tokensCss()}${ADMIN_SHELL_CSS}${SUGGESTIONS_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    renderAdminChromeOpen({
      title: 'Suggestions',
      path: '/agents/seo/suggestions',
      role: view.chrome.role,
      staffReference: view.chrome.staffReference,
    }),
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>SEO suggestions</h1>',
    '<div class="policy">',
    `<p><strong>Read at ${safeText(view.readAtIso)}.</strong> The agent proposes; publishing is yours. ` +
      'Each card shows the copy as it stands and the copy proposed, the rule set that judged it, and what ' +
      'the draft cost. Applying one records a named approval against the exact content hash and keeps the ' +
      'previous version, so it can be rolled back to the byte.</p>',
    `<p>Acting as <strong>${safeText(view.actorLabel)}</strong>, which is what the approval row names.</p>`,
    '</div>',
    view.done === null ? '' : `<p class="done">Done: ${safeText(view.done)}.</p>`,
    view.refusal === null
      ? ''
      : [
          '<div class="refusal">',
          `<p><strong>Refused: <code>${safeText(view.refusal)}</code></strong></p>`,
          view.refusalDetail === null ? '' : `<p>${safeText(view.refusalDetail)}</p>`,
          '</div>',
        ].join(''),
    '<h2>Waiting for a decision</h2>',
    view.cards.length === 0
      ? '<p class="empty">Nothing is waiting. The nightly pass files suggestions here when it finds any.</p>'
      : `<ul class="queue">${view.cards.map(renderCard).join('')}</ul>`,
    '<h2>Refused by the lint or the screen</h2>',
    '<p>These were never shown for approval. A refusal here is an escalation attempt or a claim the ' +
      'licence does not permit, and each one is already recorded in the audit trail.</p>',
    view.refusals.length === 0
      ? '<p class="empty">Nothing has been refused.</p>'
      : `<ul class="queue">${view.refusals.map(renderCard).join('')}</ul>`,
    '</main>',
    renderAdminChromeClose(),
    '</body>',
    '</html>',
  ].join('\n')
}
