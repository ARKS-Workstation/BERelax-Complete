import { safeText } from '@berelax/core'
import type { CropBoxes, FocalSweepEntry } from '@berelax/media/crop-preview'
import type { RungVerdict } from '@berelax/media/derivative-set'
import { CROP_NAMES, CROPS, type CropName } from '@berelax/media/ladders'
import type { PublicationRefusal } from '@berelax/media/slots'
import type { DerivativeSetRef, PictureSource } from '@berelax/media/srcset'
import { fallbackDimensions, fallbackSrcFor } from '@berelax/media/srcset'
import { tokensCss } from '@berelax/ui'
import { formatBytes, weightBadgeHtml, weightState } from './weight-badge.ts'

/**
 * The breakpoint preview: the real crop, at real widths, from the real derivative URLs.
 *
 * docs/07 §2 ("Media as settings") asks for exactly one thing here — "editors see the real crop at real
 * breakpoints before publishing" — and every word of it is load-bearing.
 *
 *   - **Real crop.** The crop windows come from `cropRectFor`, the function the derivative job extracts
 *     with, through a server-evaluated sweep (see `@berelax/media/crop-preview` for why a sweep and not a
 *     script that recomputes the rectangle in the browser).
 *   - **Real breakpoints.** Each row lays out at its true CSS width, so the browser runs its own `srcset`
 *     selection over the real ladder. Nothing here tells the browser which rung to take, which is why the
 *     integration test can assert the reported rung against `currentSrc`.
 *   - **Real derivative URLs.** The `srcset` is `pictureSourcesFor`'s — the same call the production
 *     component makes — and the two rendered strings are asserted equal in
 *     `apps/web/src/breakpoint-preview.itest.ts`, with a lookalike as the control.
 *   - **Before publishing.** The publish control is disabled, with the reasons named, when any rung is over
 *     its slot's budget or the alt text fails validation — and `POST /api/v1/media/publish` refuses the same
 *     attempt on its own, so the UI is never the only guard.
 *
 * ## Zero third-party origins
 *
 * Asserted by the integration test, and true by construction rather than by luck. The tokens are inlined
 * with `tokensCss()` — a route handler cannot reference the build's hashed stylesheet, and the token layer
 * is the one place literal colours may exist (`pnpm colours`). The type stack is `system-ui`, so there is
 * no `@font-face` and no font file: the admin does not need the brand's display face to report a byte
 * count, and a webfont on the one page whose subject is measuring requests would be absurd as well as
 * wrong. Every image is a same-origin derivative path served by `app/m/...`. No analytics, no icon font,
 * no CDN.
 *
 * ## Why this is a string and not JSX
 *
 * Two reasons stacked. W-SITE-01's registry requires every *document* to be served in both locales, so a
 * `page.tsx` here would need an Arabic admin document and would join a screenshot matrix whose RTL half must
 * be a real Arabic route — while this unit's acceptance asks for three viewports times two themes. And a
 * handler returns a **status code**, which is what "403 for the receptionist" is. Having settled on a
 * handler, Next 16.3.5 then refuses `react-dom/server` anywhere in the app graph ("You're importing a
 * component that imports react-dom/server"), so the bytes are assembled here. `render.ts` beside the
 * Messages inbox is the same decision for the same reasons.
 *
 * That leaves two renderers for one `<picture>` — this and `src/components/media/slot-picture.tsx` — and
 * that is *why the acceptance criterion is worth asserting*: they share `pictureSourcesFor` and nothing
 * else, so a `srcset` they both produce being byte-identical is evidence rather than a tautology.
 */

/** One row of the preview: a CSS width, the rung a browser picks for it, and that rung's weight. */
export interface PreviewRow {
  readonly cssWidth: number
  readonly verdict: RungVerdict
  /** The height the row's frame reserves, from the slot's own ratio. */
  readonly frameHeight: number
}

export interface BreakpointPreviewView {
  readonly media: DerivativeSetRef
  readonly slotLabel: string
  /** Null for an image the row declares decorative; the empty string is a different thing. */
  readonly alt: string | null
  readonly decorative: boolean
  readonly filename: string | null
  readonly source: {
    readonly width: number
    readonly height: number
    readonly bytes: number
    readonly key: string
  }
  readonly focal: { readonly x: number; readonly y: number }
  /**
   * The crop windows at the row's own focal point.
   *
   * Computed from the stored focal point rather than read out of `sweep`, because the sweep is indexed by
   * whole percentage points and a row's focalX is a number: a row at 45.5 would index `sweep[45.5]`, find
   * nothing, and the preview would open showing a zero-sized crop box. The slider starts at the rounded
   * value and moves through the sweep from there.
   */
  readonly initialBoxes: CropBoxes
  readonly rows: readonly PreviewRow[]
  readonly sources: readonly PictureSource[]
  readonly sweep: readonly FocalSweepEntry[]
  readonly refusals: readonly PublicationRefusal[]
  /** Whether the signed-in role holds `content:publish` at all. */
  readonly publishPermitted: boolean
  readonly publishPermissionNote: string
  readonly storageKind: string
  readonly publishEndpoint: string
}

/**
 * The preview's own styles.
 *
 * Colours are tokens only — there is no literal in this file, which is what `pnpm colours` requires of
 * everything outside the token layer. `--fit` is the scale each frame is drawn at; the inline script sets it
 * from the container's width, and 1 is the fallback so the page is clipped rather than broken with
 * scripting off.
 */
const PREVIEW_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  /*
   * The scrollbar gutter is reserved whether or not there is a scrollbar.
   *
   * Not cosmetic: the inline script scales each frame by \`box.clientWidth / declared\`, and
   * \`clientWidth\` shrinks by the scrollbar's width the moment the page becomes tall enough to need one
   * — which depends on the heights that same script just set. That is a layout feedback loop, and its
   * symptom is a screenshot that is not byte-identical on a repeat run, because a measurement taken before
   * the scrollbar appeared produces a fractionally different scale. Reserving the gutter makes the
   * measurement invariant.
   */
  html { scrollbar-gutter: stable; }
  body {
    margin: 0;
    padding: var(--space-7) var(--gutter);
    background: var(--color-ground);
    color: var(--color-ink);
    font: 1rem/1.55 system-ui, sans-serif;
  }
  main { max-width: 68rem; margin: 0 auto; }
  h1 { font-size: 1.5rem; line-height: 1.25; margin: 0 0 var(--space-3); }
  h2 { font-size: 1.125rem; margin: var(--space-7) 0 var(--space-3); }
  h3 { font-size: 1rem; margin: 0 0 var(--space-3); color: var(--color-ink-2); }
  p { margin: 0 0 var(--space-5); }
  code { font-family: ui-monospace, monospace; font-size: 0.8125rem; overflow-wrap: anywhere; }
  dl.facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
    gap: var(--space-3) var(--space-5);
    margin: 0 0 var(--space-7);
  }
  dl.facts dt { color: var(--color-ink-2); font-size: 0.875rem; }
  dl.facts dd { margin: 0; }
  ol.rungs { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
  li.rung {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
  }
  li.rung[data-state="over"] {
    border-color: var(--color-danger);
    border-inline-start-width: var(--space-2);
  }
  .rung-head {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3) var(--space-5);
    align-items: baseline;
    margin-bottom: var(--space-3);
  }
  .rung-width { font-weight: 600; font-variant-numeric: tabular-nums; }
  .rung-served { color: var(--color-ink-2); font-variant-numeric: tabular-nums; }
  .weight { display: inline-flex; flex-wrap: wrap; gap: var(--space-3); align-items: baseline; }
  .weight-figure { font-variant-numeric: tabular-nums; }
  .weight-note { font-size: 0.875rem; color: var(--color-ink-2); }
  /*
   * The over-budget state is carried by weight, a border and the words "over budget", not by red text.
   *
   * Two reasons, and the second is measured. WCAG 1.4.1 first: colour alone must never be the only signal,
   * and an editor with a red-green deficiency reads this page for exactly one thing. Then the contrast. The
   * danger token is derived to 4.5:1 against each theme's GROUND -- scripts/palette.py derives it against
   * DARK_GROUND -- and these cards sit on the raised surface, which in dark mode is lighter than the ground.
   * The same token measures about 4.07:1 there, so 14px danger-coloured text on this card would be an AA
   * failure the palette gate cannot see, because the gate measures against the ground. The ink therefore
   * stays ink and the danger token is used for borders, where 3:1 is the requirement.
   */
  .weight-over .weight-figure { font-weight: 700; }
  .over-flag {
    display: inline-block;
    border: var(--space-1) solid var(--color-danger);
    border-radius: var(--radius-1);
    color: var(--color-ink);
    padding: 0 var(--space-3);
    font-size: 0.8125rem;
    font-weight: 700;
  }
  .viewportbox { overflow: hidden; background: var(--color-surface-sand); }
  .frame { transform-origin: top left; transform: scale(var(--fit, 1)); }
  .frame picture { display: block; width: 100%; }
  .frame img { display: block; width: 100%; height: auto; }
  .crops {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
    gap: var(--space-5);
  }
  .cropcard {
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
  }
  .cropframe {
    position: relative;
    width: 100%;
    background: var(--color-surface-clay);
    border: 1px solid var(--color-border);
  }
  .cropwindow {
    position: absolute;
    inset-inline-start: var(--box-left, 0%);
    inset-block-start: var(--box-top, 0%);
    width: var(--box-width, 100%);
    height: var(--box-height, 100%);
    border: var(--space-1) solid var(--color-accent-teal);
  }
  .crop-numbers { display: block; margin-top: var(--space-3); font-variant-numeric: tabular-nums; }
  .focal { margin: var(--space-5) 0; }
  .focal input[type="range"] { width: 100%; max-width: 24rem; display: block; min-height: 48px; }
  form.publish {
    margin: var(--space-7) 0 0;
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    padding: var(--space-5);
  }
  form.publish button {
    /* 48px, which docs/08 states as the rule rather than as the result of padding arithmetic. */
    min-height: 48px;
    min-width: 48px;
    padding: 0 var(--space-5);
    border-radius: var(--radius-1);
    border: 1px solid var(--color-border-strong);
    background: var(--color-surface-raised);
    color: var(--color-ink);
    font: inherit;
    font-weight: 600;
  }
  form.publish button[disabled] {
    background: var(--color-surface-clay);
    color: var(--color-ink-2);
    border-color: var(--color-hairline);
  }
  ul.refusals { margin: 0 0 var(--space-5); padding: 0; list-style: none; display: grid; gap: var(--space-3); }
  ul.refusals li {
    color: var(--color-ink);
    border-inline-start: var(--space-1) solid var(--color-danger);
    padding-inline-start: var(--space-3);
  }
  .empty {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
  }
`

/**
 * The inline script.
 *
 * Two jobs, both presentation: index the precomputed crop sweep when the focalX slider moves, and scale each
 * frame so a 1600px row fits a 390px screen. It computes nothing about the media — every crop rectangle it
 * applies was produced by `cropRectFor` on the server, which is why this is not a second implementation of
 * the crop.
 *
 * `data-focal-repaints` on `<html>` is how the integration test knows the re-crop happened **in the same
 * render**: it increments on every repaint, and a navigation would reset it to 1 and lose the sentinel the
 * test sets on `window`.
 */
const PREVIEW_SCRIPT = `
(function () {
  var data = document.getElementById('focal-sweep');
  var slider = document.getElementById('focalX');
  var root = document.documentElement;
  if (data === null || slider === null) return;
  var sweep = JSON.parse(data.textContent || '[]');
  var source = {
    width: Number(root.getAttribute('data-source-width')),
    height: Number(root.getAttribute('data-source-height'))
  };
  var repaints = 0;

  function paint() {
    var entry = sweep[Number(slider.value)];
    if (entry === undefined) return;
    var label = document.getElementById('focalX-value');
    if (label !== null) label.textContent = entry.focalX + '%';
    var cards = document.querySelectorAll('[data-crop-box]');
    for (var i = 0; i < cards.length; i += 1) {
      var card = cards[i];
      var box = entry.boxes[card.getAttribute('data-crop-box')];
      if (box === undefined) continue;
      card.setAttribute('data-crop-left', String(box.left));
      card.setAttribute('data-crop-top', String(box.top));
      card.setAttribute('data-crop-width', String(box.width));
      card.setAttribute('data-crop-height', String(box.height));
      var pane = card.querySelector('.cropwindow');
      if (pane !== null) {
        pane.style.setProperty('--box-left', (box.left / source.width) * 100 + '%');
        pane.style.setProperty('--box-top', (box.top / source.height) * 100 + '%');
        pane.style.setProperty('--box-width', (box.width / source.width) * 100 + '%');
        pane.style.setProperty('--box-height', (box.height / source.height) * 100 + '%');
      }
      var numbers = card.querySelector('.crop-numbers');
      if (numbers !== null) {
        numbers.textContent =
          box.width + ' x ' + box.height + ' px, taken at ' + box.left + ', ' + box.top;
      }
    }
    repaints += 1;
    root.setAttribute('data-focal-repaints', String(repaints));
  }

  // Returns whether it wrote a height, so \`settle\` can run it until it stops writing one.
  function fit() {
    var changed = false;
    var boxes = document.querySelectorAll('.viewportbox');
    for (var i = 0; i < boxes.length; i += 1) {
      var box = boxes[i];
      var frame = box.querySelector('.frame');
      if (frame === null) continue;
      var declared = Number(frame.getAttribute('data-css-width'));
      var height = Number(frame.getAttribute('data-css-height'));
      var scale = Math.min(1, box.clientWidth / declared);
      var next = Math.round(height * scale) + 'px';
      frame.style.setProperty('--fit', String(scale));
      if (box.style.height !== next) {
        box.style.height = next;
        changed = true;
      }
    }
    return changed;
  }

  /*
    Fit until nothing moves, then say so on the root element.

    Two reasons, and the first is about the page rather than the test. Writing a height can add or remove
    the page's scrollbar, which changes every box's \`clientWidth\`, which changes the scale that was just
    written — a feedback loop whose visible symptom is a frame scaled to the wrong width. The
    \`scrollbar-gutter: stable\` above removes the loop in a browser that honours it; this makes the page
    correct in one that does not.

    It is NOT true, as this comment claimed until it cost three agents a verify run each, that "each pass
    either writes nothing or converges". A pass can write and not converge: the loop capped at four passes
    and then set the flag anyway, so a page mid-oscillation announced itself settled. Two fixed points,
    alternating per load — \`settle\` also runs again on \`load\`, so which one you got depended on parity —
    and a full-page screenshot that differed by a strip. It presented as
    \`[screenshot-never-stabilised] light-390\`, the narrowest cell with the most frames to fit and so the
    likeliest to toggle. A cycle is now DETECTED, by recognising a height set we have already written, and
    reported on \`data-preview-unsettled\` rather than hidden behind a claim of success.

    The second is that \`data-preview-settled\` gives a caller an observable fact to wait for — and it is a
    fact only because it is now absent when the fit did not converge. The
    integration test's byte-identical assertion previously waited two animation frames, which is a guess
    about how long layout takes: it held when the file ran alone and failed under the load of a full
    \`pnpm verify\`, photographing a layout mid-settle on one pass and settled on the next. A flag that is
    absent until no layout write is pending cannot be raced.
  */
  // Every box's written height, as one string, so a repeat can be recognised.
  function heights() {
    var boxes = document.querySelectorAll('.viewportbox');
    var out = [];
    for (var i = 0; i < boxes.length; i += 1) out.push(boxes[i].style.height || 'auto');
    return out.join(',');
  }

  function settle() {
    root.removeAttribute('data-preview-settled');
    root.removeAttribute('data-preview-unsettled');
    var seen = [];
    // 12 rather than 4. The cap is now only a backstop: what distinguishes a page that needs a few passes
    // from one that never converges is a REPEATED state, not a pass count, and the old cap was low enough
    // that the two looked identical.
    while (seen.length < 12) {
      if (!fit()) {
        root.setAttribute('data-preview-settled', '1');
        root.setAttribute('data-preview-passes', String(seen.length));
        return;
      }
      var state = heights();
      if (seen.indexOf(state) !== -1) {
        // A state we have already written means a cycle, and a cycle never ends. Say so instead of
        // claiming to have settled: the whole value of the flag is that a caller can trust it.
        root.setAttribute(
          'data-preview-unsettled',
          'oscillating after ' + seen.length + ' passes: ' + seen.concat([state]).join(' -> '),
        );
        return;
      }
      seen.push(state);
    }
    root.setAttribute('data-preview-unsettled', 'no convergence in 12 passes: ' + seen.join(' -> '));
  }

  slider.addEventListener('input', paint);
  paint();
  settle();
  // Again once the images have decoded: \`fit\` reads \`clientWidth\`, and an image that arrives after the
  // script ran changes the layout it measured. This is the event the late arrival lands before.
  window.addEventListener('load', settle);
  window.addEventListener('resize', settle);
})();
`

/**
 * The preview's own `<picture>`, from the sources the production component also renders from.
 *
 * Two deliberate differences from production, and both are the reason a preview is a preview.
 *
 * **`sizes` is the row's CSS width**, not the layout's. That is what pins the browser's rung selection to
 * the breakpoint under examination; on the page itself the hero is full-bleed and `sizes` is `100vw`.
 *
 * **The `media` attribute is dropped, and the crop is chosen here instead.** This is not a shortcut, and it
 * was found by a failing assertion rather than reasoned out in advance. A `<source media>` query is
 * evaluated against the **viewport**, not against the element's width — so seven frames in one 1440px-wide
 * admin window all match `(min-width: 768px)`, and every row shows the 16:9 crop including the three
 * labelled 360, 390 and 414. That is not a subtle wrongness: it is a preview of the phone that never shows
 * the phone's photograph, and it looks entirely plausible. The crop is therefore resolved from the ladder's
 * own media query by `cropForViewportWidth` and the row offers that crop's three formats — so the browser
 * still negotiates the format and still picks the rung. The only thing it no longer decides is the crop,
 * because here it cannot decide it correctly.
 *
 * `loading="eager"` and `decoding="sync"`, which production uses only for the LCP element. Every frame on
 * this page is the subject, and a lazily loaded one below the fold makes a full-page screenshot depend on
 * how far the page happened to be scrolled — which is a repeat run that is not byte-identical.
 *
 * The `srcset` strings are untouched, and they are what the integration test compares with the production
 * component's.
 */
function previewPictureHtml(view: BreakpointPreviewView, cssWidth: number, crop: CropName): string {
  const box = fallbackDimensions()
  const alt = view.decorative ? '' : (view.alt ?? '')
  const sources = view.sources
    .filter((source) => source.crop === crop)
    .map(
      (source) =>
        `<source type="${source.type}" srcset="${safeText(source.srcset)}" ` +
        `sizes="${cssWidth}px">`,
    )
    .join('')
  return (
    '<picture class="slot-picture" data-slot="' +
    `${safeText(view.media.slot)}" data-crop="${crop}">${sources}` +
    `<img src="${safeText(fallbackSrcFor(view.media))}" alt="${safeText(alt)}" ` +
    `width="${box.width}" height="${box.height}" decoding="sync" loading="eager">` +
    '</picture>'
  )
}

function rungRowHtml(view: BreakpointPreviewView, row: PreviewRow): string {
  const state = weightState(row.verdict)
  const { rendition } = row.verdict
  return (
    `<li class="rung" data-testid="rung-${row.cssWidth}" data-css-width="${row.cssWidth}" ` +
    `data-state="${state}">` +
    '<div class="rung-head">' +
    `<span class="rung-width">${row.cssWidth} CSS px</span>` +
    `<span class="rung-served">${rendition.crop} crop, ${rendition.width} x ${rendition.height} ` +
    `rung, ${rendition.format}</span>` +
    weightBadgeHtml(row.verdict) +
    (state === 'over'
      ? `<span class="over-flag" data-testid="over-${row.cssWidth}">over budget</span>`
      : '') +
    '</div>' +
    '<div class="viewportbox">' +
    `<div class="frame" data-css-width="${row.cssWidth}" data-css-height="${row.frameHeight}" ` +
    `style="width:${row.cssWidth}px">` +
    previewPictureHtml(view, row.cssWidth, rendition.crop) +
    '</div></div></li>'
  )
}

function cropCardHtml(view: BreakpointPreviewView, crop: CropName): string {
  const box = view.initialBoxes[crop]
  const percent = (value: number, of: number): string => `${(value / of) * 100}%`
  return (
    `<div class="cropcard" data-crop-box="${crop}" data-testid="crop-${crop}" ` +
    `data-crop-left="${box.left}" data-crop-top="${box.top}" ` +
    `data-crop-width="${box.width}" data-crop-height="${box.height}">` +
    `<h3>${crop} — ${CROPS[crop].ratio.join(':')}</h3>` +
    // The source frame's own shape, from the measured original. A percentage block-end padding resolves
    // against the container's width, which is the one way to reserve an arbitrary ratio without stating
    // one — and no literal ratio appears here, which `pnpm media` requires.
    `<div class="cropframe" style="padding-block-end:${percent(view.source.height, view.source.width)}">` +
    `<div class="cropwindow" style="--box-left:${percent(box.left, view.source.width)};` +
    `--box-top:${percent(box.top, view.source.height)};` +
    `--box-width:${percent(box.width, view.source.width)};` +
    `--box-height:${percent(box.height, view.source.height)}"></div>` +
    '</div>' +
    `<span class="crop-numbers">${box.width} x ${box.height} px, taken at ${box.left}, ` +
    `${box.top}</span>` +
    '</div>'
  )
}

function publishFormHtml(view: BreakpointPreviewView): string {
  const blocked = view.refusals.length > 0 || !view.publishPermitted
  const reasons =
    view.refusals.length === 0
      ? ''
      : '<p data-testid="publish-blocked-reason">This image cannot be published. The same attempt is ' +
        `refused by <code>${safeText(view.publishEndpoint)}</code> on its own, so this button is not ` +
        'the guard.</p><ul class="refusals">' +
        view.refusals
          .map((refusal) => `<li data-rule="${refusal.rule}">${safeText(refusal.message)}</li>`)
          .join('') +
        '</ul>'
  const permission = view.publishPermitted
    ? ''
    : `<p data-testid="publish-permission-note">${safeText(view.publishPermissionNote)}</p>`
  return (
    `<form class="publish" method="post" action="${safeText(view.publishEndpoint)}">` +
    '<h2>Publish</h2>' +
    `<input type="hidden" name="mediaId" value="${safeText(view.media.mediaId)}">` +
    reasons +
    permission +
    `<button type="submit" data-testid="publish"${blocked ? ' disabled aria-disabled="true"' : ''}>` +
    'Publish this image</button>' +
    '</form>'
  )
}

function factsHtml(view: BreakpointPreviewView): string {
  const altText = view.decorative
    ? 'declared decorative — announces nothing'
    : view.alt === null || view.alt === ''
      ? 'none recorded'
      : view.alt
  return (
    '<dl class="facts">' +
    `<div><dt>Slot</dt><dd data-testid="slot">${safeText(view.slotLabel)}</dd></div>` +
    `<div><dt>Media id</dt><dd><code data-testid="media-id">${safeText(view.media.mediaId)}</code>` +
    '</dd></div>' +
    '<div><dt>Content address</dt><dd><code data-testid="content-hash">' +
    `${safeText(view.media.contentHash)}</code></dd></div>` +
    `<div><dt>Original</dt><dd data-testid="source">${view.source.width} x ${view.source.height} px, ` +
    `${safeText(formatBytes(view.source.bytes))}</dd></div>` +
    `<div><dt>Alt text</dt><dd data-testid="alt">${safeText(altText)}</dd></div>` +
    `<div><dt>Bucket</dt><dd data-testid="storage-kind">${safeText(view.storageKind)}</dd></div>` +
    '</dl>'
  )
}

function head(): string {
  return (
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Breakpoint preview — Be Relax Massage Center and Spa admin</title>' +
    // Belt as well as the braces the proxy puts on the response, which is what a crawler honours.
    '<meta name="robots" content="noindex, nofollow, noarchive">' +
    `<style>${tokensCss()}${PREVIEW_CSS}</style>`
  )
}

export function renderBreakpointPreviewHtml(view: BreakpointPreviewView): string {
  const blocked = view.refusals.length > 0 || !view.publishPermitted
  const over = view.rows.filter((row) => weightState(row.verdict) === 'over').length
  return [
    '<!doctype html>',
    `<html lang="en" dir="ltr" data-source-width="${view.source.width}" `,
    `data-source-height="${view.source.height}" data-focal-repaints="0" `,
    `data-over-budget-rungs="${over}" data-publish-blocked="${blocked}">`,
    `<head>${head()}</head>`,
    '<body><main>',
    '<h1>Breakpoint preview</h1>',
    '<p>The real crop at real widths, from the derivative URLs this image is actually served from. ',
    'Every request on this page is same-origin: the images come from the public bucket through ',
    '<code>/m/…</code>, the styles are inlined, and there is no web font.</p>',
    factsHtml(view),
    '<h2>Per breakpoint</h2>',
    '<p>Each frame lays out at its own CSS width, so the browser runs its own <code>srcset</code> ',
    'selection over the real ladder — nothing here tells it which rung to take. The weight is the size ',
    'of the object in the bucket, not an estimate. Every rung and weight below is what a browser at a ',
    'device pixel ratio of <strong>1</strong> requests; a 2x or 3x screen of the same CSS width is served ',
    'the next rung up.</p>',
    `<ol class="rungs">${view.rows.map((row) => rungRowHtml(view, row)).join('')}</ol>`,
    '<h2>The srcset, as the page will carry it</h2>',
    '<p>Built by <code>pictureSourcesFor</code> in <code>@berelax/media/srcset</code> — the same call ',
    'the production component makes. Two builders would be two ladders, and an editor would approve a ',
    'crop the site does not serve.</p>',
    '<dl class="facts">',
    view.sources
      .map(
        (source) =>
          `<div><dt>${source.crop} / ${source.format}</dt><dd><code ` +
          `data-testid="srcset-${source.crop}-${source.format}">${safeText(source.srcset)}` +
          '</code></dd></div>',
      )
      .join(''),
    '</dl>',
    '<h2>Crop windows</h2>',
    '<p>The rectangle the derivative job extracts before it resizes, at both ladder ratios. Moving ',
    'focalX re-crops them without leaving the page; the numbers are source pixels, from ',
    '<code>cropRectFor</code>.</p>',
    '<div class="focal">',
    `<label for="focalX">focalX <output id="focalX-value">${view.focal.x}%</output></label>`,
    `<input type="range" id="focalX" name="focalX" min="0" max="100" step="1" `,
    // Rounded, because the slider's steps are whole percentage points and the sweep is indexed by them.
    `value="${Math.round(view.focal.x)}">`,
    `<p>focalY is ${view.focal.y}% and is a form field on the image itself: a sweep over both axes is `,
    'ten thousand rectangles, which is a megabyte of JSON to make the second slider as instant as the ',
    'first.</p>',
    '</div>',
    `<div class="crops">${CROP_NAMES.map((crop) => cropCardHtml(view, crop)).join('')}</div>`,
    '<script type="application/json" id="focal-sweep">',
    // `</script>` cannot appear inside the JSON — the numbers and the crop names are the only content —
    // but the escape is here anyway, because the day this carries a string is the day it matters.
    JSON.stringify(view.sweep).replace(/</g, '\\u003c'),
    '</script>',
    publishFormHtml(view),
    '</main>',
    `<script>${PREVIEW_SCRIPT}</script>`,
    '</body></html>',
  ].join('')
}

/**
 * The document an image with no derivatives yet gets.
 *
 * A normal condition, not an error: `derivative_manifest` is empty until `media.build-derivatives` runs, and
 * nothing enqueues it yet (the NOTE on W-SYS-09 records why). Saying so is the honest answer — a preview
 * that rendered seven broken `<img>` elements would look like a broken page instead of an unfinished
 * pipeline, and one that invented a URL would be a 404 the browser resolves by showing nothing.
 */
export function renderMissingDerivativesHtml(input: {
  readonly mediaId: string
  readonly slotLabel: string
  readonly missing: readonly string[]
  readonly storageKind: string
}): string {
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr" data-publish-blocked="true">',
    `<head>${head()}</head>`,
    '<body><main>',
    '<h1>Breakpoint preview</h1>',
    '<div class="empty" data-testid="no-derivatives">',
    `<p>No derivative has been built for <code>${safeText(input.mediaId)}</code> in the `,
    `${safeText(input.slotLabel)} slot, so there is nothing to preview yet. ${input.missing.length} `,
    `of the ladder’s renditions are absent from the ${safeText(input.storageKind)} bucket.</p>`,
    '<p>The <code>media.build-derivatives</code> job produces them from the original. Until it has run, ',
    'this page shows you this rather than seven broken images.</p>',
    '</div></main></body></html>',
  ].join('')
}
