import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import {
  type AdminChrome,
  GOOGLE_REAUTH_BANNER_CSS,
  renderAdminBanner,
} from '../../../../src/components/admin/google-reauth-banner.ts'
import {
  PASTE_RATINGS,
  REVIEWS_PASTE_FIELDS,
  REVIEWS_PASTE_PATH,
  type ReviewsPasteView,
} from './view.ts'

/**
 * *Paste a review* — the intake path that always works (G-REV-02, docs/10 §6).
 *
 * Pure: a view in, a document out. No database, no clock — the instant the page was read at arrives on the
 * view and is printed, which is what lets two repeat runs produce identical screenshots.
 *
 * ## Why a route handler and not a `page.tsx`
 *
 * The manifest's `files` list names `page.tsx`, and this is a `route.ts` + `render.ts` + `handler.ts` instead.
 * Every admin surface in this build has made the same choice and records the same reason:
 * `apps/web/src/routes/registry.ts` requires every **document** to be served in BOTH locales, so a `page.tsx`
 * here would need an Arabic admin document that W-SYS-01 has not built, and it would join a screenshot matrix
 * whose RTL half has to be a real Arabic route. The three HR screens, the two settings screens, the diary, the
 * pipeline board and the quick-book screen all give this reason. The manifest carries a NOTE saying so.
 *
 * ## One form, one submission
 *
 * The acceptance line is *"completes in one form submission (e2e asserts a single POST)"*, and the shape that
 * delivers it is the plainest one: a single `<form method="post">` with no JavaScript at all. No preview step,
 * no confirm step, no fetch. The form works with scripting disabled, which on an admin surface matters more
 * than anywhere else — the operator is doing ninety seconds of typing and a script that failed to load would
 * turn that into a support call.
 *
 * The response to a successful POST is a **303 to this same page** with the new review's id in the query. That
 * is still one POST: a redirect is a GET. It is also what stops a reload re-posting the form, which on this
 * page would file the same review twice under two ids — `google_review_id` is NULL on a pasted row, so nothing
 * in the database would refuse the duplicate.
 *
 * ## The queue is on the page, and it shows the bytes
 *
 * A `needs_paste` item is a job for a person, and the only thing that makes it doable is the forwarded body
 * exactly as it arrived (migration 0094). So the queue renders it verbatim inside a `<pre>` — escaped through
 * `safeText`, because the body is untrusted input from an anonymous inbound address and this is the one place
 * in the system where it is shown to a human.
 */

/** Every colour is a token. `pnpm colours` refuses a literal hex outside the token layer (brief rule 11). */
const PASTE_CSS = `
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
  p { margin: 0 0 var(--space-5); }
  .card, .refusal, .done, .policy {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
    margin: 0 0 var(--space-5);
  }
  .refusal, .done, .policy {
    background: var(--color-surface-sand);
    border-color: var(--color-border);
    border-inline-start-width: var(--space-2);
  }
  form { display: grid; gap: var(--space-5); }
  label { display: grid; gap: var(--space-2); font-weight: 600; }
  input[type="text"], input[type="date"], textarea, select {
    font: inherit;
    padding: var(--space-3);
    min-height: 3rem;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-ink);
  }
  textarea { min-height: 8rem; }
  fieldset {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    padding: var(--space-3) var(--space-5) var(--space-5);
    margin: 0;
  }
  legend { font-weight: 600; padding: 0 var(--space-2); }
  .ratings { display: flex; flex-wrap: wrap; gap: var(--space-5); }
  /* 48px, because docs/08 §4's floor is the TARGET and the label is the target: clicking the word "4
     stars" selects the radio, so the whole row has to be thumb-sized and not just the control in it. */
  .ratings label {
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    font-weight: 400;
    min-height: 3rem;
    padding-inline-end: var(--space-2);
  }
  .ratings input { min-width: 1.5rem; min-height: 1.5rem; }
  button {
    font: inherit;
    font-weight: 600;
    min-height: 3rem;
    padding: var(--space-3) var(--space-7);
    border: 0;
    border-radius: var(--radius-1);
    background: var(--color-ink);
    color: var(--color-ground);
    justify-self: start;
  }
  ul.queue { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  ul.queue li {
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-inline-start: var(--space-2) solid var(--color-border);
    border-radius: var(--radius-2);
    padding: var(--space-3) var(--space-5);
  }
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
`

function listingControl(view: ReviewsPasteView): string {
  const { connection, placeId } = REVIEWS_PASTE_FIELDS
  const only = view.listings[0]
  if (view.listings.length === 1 && only !== undefined) {
    // One listing, which is what this business has. Hidden inputs rather than a select with one option: a
    // control with one choice is a control that cannot be got wrong and should not ask.
    return (
      `<input type="hidden" name="${connection}" value="${safeText(only.connectionId)}">` +
      `<input type="hidden" name="${placeId}" value="${safeText(only.placeId)}">` +
      `<p>Filing against <code>${safeText(only.placeId)}</code>, connected as ` +
      `${safeText(only.googleEmail)}.</p>`
    )
  }
  // Two connections is a real configuration (docs/10 §2: the account that owns the listing need not be the
  // one verified on the site), and the value carries BOTH ids because migration 0020's trigger refuses a
  // place that is not a resource of its connection — so the pair has to travel together.
  return (
    `<label for="paste-connection">Listing` +
    `<select id="paste-connection" name="${connection}" required>` +
    `<option value="">Choose a listing</option>` +
    view.listings
      .map(
        (listing) =>
          `<option value="${safeText(listing.connectionId)}"` +
          `${listing.connectionId === view.form.connection ? ' selected' : ''}>` +
          `${safeText(listing.placeId)} (${safeText(listing.googleEmail)})</option>`,
      )
      .join('') +
    '</select></label>' +
    `<input type="hidden" name="${placeId}" value="${safeText(view.form.placeId)}">`
  )
}

function ratings(view: ReviewsPasteView): string {
  return (
    '<fieldset class="ratings-set"><legend>Rating</legend><div class="ratings">' +
    PASTE_RATINGS.map(
      (rating) =>
        `<label for="paste-rating-${rating}">` +
        `<input type="radio" id="paste-rating-${rating}" name="${REVIEWS_PASTE_FIELDS.rating}" ` +
        `value="${rating}" required` +
        `${view.form.rating === String(rating) ? ' checked' : ''}>` +
        `${rating} star${rating === 1 ? '' : 's'}</label>`,
    ).join('') +
    '</div></fieldset>'
  )
}

function queue(view: ReviewsPasteView): string {
  if (view.queue.length === 0) {
    return (
      '<p class="empty">Nothing is waiting. A forwarded notification that this build could not read ' +
      'appears here with its message exactly as it arrived, so it can be typed in below.</p>'
    )
  }
  return `<ul class="queue">${view.queue
    .map(
      (item) =>
        `<li><p><strong>Received ${safeText(item.receivedAtIso)}</strong> — ` +
        `<code>${safeText(item.refusal)}</code>: ${safeText(item.refusalSentence)} ` +
        `(${item.rawBodyBytes} bytes)</p>` +
        // The bytes, escaped. Untrusted input from an anonymous address, shown to a human on purpose.
        `<pre>${safeText(item.rawBody)}</pre>` +
        `<p><a href="${REVIEWS_PASTE_PATH}?${REVIEWS_PASTE_FIELDS.intake}=${encodeURIComponent(item.id)}">` +
        'Paste this one</a></p></li>',
    )
    .join('')}</ul>`
}

export function renderReviewsPasteHtml(
  view: ReviewsPasteView & { readonly chrome: AdminChrome },
): string {
  const f = REVIEWS_PASTE_FIELDS
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title: docs/09's brand-collision rule forbids the bare brand in any title, and
    // `apps/web/src/seo/brand.test.ts` scans every title-bearing line in `apps/web` for it.
    '<title>Paste a review — reviews admin</title>',
    `<style>${tokensCss()}${PASTE_CSS}${GOOGLE_REAUTH_BANNER_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    renderAdminBanner(view.chrome),
    '<h1>Paste a review</h1>',
    '<div class="policy">',
    `<p><strong>Read at ${safeText(view.readAtIso)}.</strong> This is the intake path that always works. ` +
      'The Business Profile API is not approved yet, so nothing polls Google for reviews — a review reaches ' +
      'this system because somebody forwarded the notification email or typed it in here, and a reply is ' +
      'drafted from the row either way.</p>',
    view.actorLabel === null
      ? ''
      : `<p>Recorded against <strong>${safeText(view.actorLabel)}</strong>, which is what the audit row ` +
        'names.</p>',
    '</div>',
    view.refusal === null
      ? ''
      : `<div class="refusal"><p><strong>Not saved.</strong> ${safeText(view.refusal.sentence)}</p></div>`,
    view.created === null
      ? ''
      : `<div class="done"><p><strong>Saved.</strong> A ${view.created.rating}-star review` +
        `${view.created.starOnly ? ' with no text' : ''} is recorded as <code>` +
        `${safeText(view.created.reviewId)}</code>.` +
        (view.created.intakeResolved ? ' The forwarded message it came from is closed.' : '') +
        '</p></div>',
    '<h2>The review</h2>',
    '<div class="card">',
    `<form method="post" action="${REVIEWS_PASTE_PATH}">`,
    listingControl(view),
    view.form.intake === ''
      ? ''
      : `<input type="hidden" name="${f.intake}" value="${safeText(view.form.intake)}">`,
    ratings(view),
    `<label for="paste-reviewer">Reviewer, exactly as Google shows it` +
      `<input type="text" id="paste-reviewer" name="${f.reviewer}" required maxlength="200" ` +
      `value="${safeText(view.form.reviewer)}" ` +
      'placeholder="A Google user"></label>',
    `<label for="paste-reviewed-on">Date on the review` +
      `<input type="date" id="paste-reviewed-on" name="${f.reviewedOn}" required ` +
      `value="${safeText(view.form.reviewedOn)}"></label>`,
    `<label for="paste-comment">The review text, or leave it empty for a star-only review` +
      `<textarea id="paste-comment" name="${f.comment}" rows="8">${safeText(view.form.comment)}` +
      '</textarea></label>',
    '<button type="submit">Save the review</button>',
    '</form>',
    '</div>',
    '<h2>Forwarded messages nothing could read</h2>',
    queue(view),
    '</main>',
    '</body>',
    '</html>',
  ].join('')
}
