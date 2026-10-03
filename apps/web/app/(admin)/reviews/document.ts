import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  ADMIN_BANNER_CSS,
  type AdminChrome,
  renderAdminBanner,
} from '../../../src/components/admin/google-reauth-banner.ts'
import type { QueueDirection } from './view.ts'

/**
 * The shell both approval-queue documents share (G-REV-06).
 *
 * ONE copy of the stylesheet and one copy of the `<head>`, because the two screens are photographed in the
 * same twelve cells and a second copy of either would mean the queue and the detail view could drift into
 * different type scales, different hairlines and different dark-mode grounds — which a screenshot matrix
 * reports as twelve unexplained diffs rather than as one edit somebody forgot to make twice.
 *
 * Pure: a view in, a string out. No clock and no database, which is what lets a repeat capture be
 * byte-identical.
 */

/** Every colour is a token. `pnpm colours` refuses a literal hex outside the token layer (brief rule 11). */
export const REVIEWS_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 62rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-7) 0 var(--space-3); }
  h3 { font-size: 1rem; margin: var(--space-5) 0 var(--space-2); }
  p { margin: 0 0 var(--space-5); }
  .card, .refusal, .done, .policy, .escalation {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  .refusal, .done, .policy, .escalation {
    background: var(--color-surface-sand);
    border-color: var(--color-border);
    border-inline-start-width: var(--space-2);
  }
  form { display: grid; gap: var(--space-5); }
  label { display: grid; gap: var(--space-2); font-weight: 600; }
  textarea, select {
    font: inherit;
    padding: var(--space-3);
    min-height: 3rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-ink);
  }
  textarea { min-height: 9rem; }
  /* 48px, because docs/08 §4's floor is the TARGET: the whole control has to be thumb-sized, not the
     glyph inside it. The queue is read at the front desk on a phone. */
  button, .action {
    font: inherit;
    font-weight: 600;
    min-height: 3rem;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-7);
    border: 1px solid var(--color-ink);
    border-radius: var(--radius-1);
    background: var(--color-ink);
    color: var(--color-ground);
    justify-self: start;
    text-decoration: none;
  }
  .action.secondary { background: var(--color-surface); color: var(--color-ink); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin: 0 0 var(--space-5); }
  ul.queue, ul.reasons { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  ul.queue li {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-inline-start: var(--space-2) solid var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-3) var(--space-5);
  }
  ul.reasons { gap: var(--space-3); }
  ul.reasons li { padding: 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--space-2) var(--space-5); margin: 0; }
  dt { font-weight: 600; }
  dd { margin: 0; }
  pre {
    margin: var(--space-3) 0 0;
    padding: var(--space-3);
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--color-ground);
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-1);
    font-family: ui-monospace, monospace;
    font-size: 0.875rem;
  }
  code { font-family: ui-monospace, monospace; }
  .empty { color: var(--color-ink-muted); }
  .stage { font-weight: 600; }
`

/**
 * The `<head>` and the opening of the document.
 *
 * `dir` comes from the view and the language does not: this is an English admin document mirrored, which
 * is a layout axis rather than a locale. The duplicate queue and the leave screen record the same choice
 * for the same reason — the registry requires every *document* to be served in both locales, so a real
 * Arabic admin surface is W-SYS-01's and not something to invent inside an accessibility matrix.
 *
 * No brand in the title: docs/09's brand-collision rule forbids the bare brand in any title, and
 * `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
 */
export function reviewsDocumentHead(title: string, direction: QueueDirection): readonly string[] {
  return [
    '<!doctype html>',
    `<html lang="en" dir="${direction}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    `<title>${safeText(title)} — reviews admin</title>`,
    `<style>${tokensCss()}${REVIEWS_CSS}${ADMIN_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
  ]
}

/** The Google re-auth banner every `(admin)` document that emits a doctype has to render (G-CONN-08). */
export const reviewsBanner = (chrome: AdminChrome): string => renderAdminBanner(chrome)

/**
 * The paragraph that says what this screen can and cannot know, on every page of it.
 *
 * Not decoration. The one thing an owner must not take from this queue is that pressing a button put a
 * reply on Google: there is no Business Profile API access in this build (docs/10 §4, OPEN-QUESTIONS Y3-gbp-api), so nothing here can
 * observe the listing, and `posted_manually_at` records a CLAIM. A screen that said "posted" without
 * saying who said so, and on what evidence, would be the screen that makes the row read as an
 * observation.
 */
export const FALLBACK_MODE_NOTE =
  'The Business Profile API is not approved for this listing, so nothing here can read or write Google. ' +
  'A reply is drafted, linted and approved in this system, and then a person pastes it into Google ' +
  'themselves and records that they did. “Marked as posted” is that person’s statement, with their name ' +
  'and the time against it — never an observation of the listing.'
