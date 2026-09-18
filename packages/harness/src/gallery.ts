/**
 * The gallery: every capture on one page, grouped so the comparisons that matter are adjacent.
 *
 * docs/12 §5 asks for review to be *one link on a phone*. That shapes the layout more than it sounds:
 * the point is not to display twelve images, it is to put light beside dark and LTR beside RTL at the
 * same viewport, because those are the pairs where a defect shows up as a difference rather than as
 * something you would have to already know was wrong.
 *
 * The critique findings sit above the images they came from. A gallery that shows only pictures asks
 * the reviewer to spot the 2.90:1 text themselves; one that shows only findings asks them to trust a
 * list. Both together is the thing that works.
 *
 * Self-contained HTML with the images inlined, so it can be published as a private Artifact and
 * opened on a phone with no server and no asset paths to get wrong.
 */
import { safeText } from '@berelax/core'
import { tokensCss } from '@berelax/ui'
import type { Capture } from './capture.ts'
import { type Finding, summarise, uniqueFindings } from './critique.ts'
import { type Direction, THEMES, type Theme, VIEWPORTS } from './matrix.ts'

function dataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`
}

function findingRow(finding: Finding): string {
  return [
    `<li class="finding finding--${finding.severity}">`,
    `<span class="rule">${safeText(finding.rule)}</span>`,
    `<code>${safeText(finding.where)}</code>`,
    `<span class="detail">${safeText(finding.detail)}</span>`,
    '</li>',
  ].join('')
}

function cell(
  captures: readonly Capture[],
  viewportName: string,
  theme: Theme,
  direction: Direction,
): string {
  const capture = captures.find(
    (candidate) =>
      candidate.target.viewport.name === viewportName &&
      candidate.target.theme === theme &&
      candidate.target.direction === direction,
  )
  if (capture === undefined)
    return '<figure class="cell cell--missing"><figcaption>missing</figcaption></figure>'
  const defects = capture.findings.filter((finding) => finding.severity === 'defect').length
  return [
    '<figure class="cell">',
    `<figcaption>${theme} · ${direction}${defects > 0 ? ` · <span class="badge">${defects} defect${defects === 1 ? '' : 's'}</span>` : ''}</figcaption>`,
    `<img src="${dataUrl(capture.png)}" alt="${safeText(`${capture.target.page} at ${viewportName}, ${theme}, ${direction}`)}" loading="lazy">`,
    '</figure>',
  ].join('')
}

export interface GalleryOptions {
  readonly title: string
  /** Shown in the header so a reviewer knows which build they are looking at. */
  readonly subtitle: string
}

/** Builds the gallery from every capture, grouped by page and then by viewport. */
export function renderGalleryHtml(captures: readonly Capture[], options: GalleryOptions): string {
  const pages = [...new Set(captures.map((capture) => capture.target.page))].sort()
  const findings = uniqueFindings(
    captures.map((capture) => ({
      page: capture.target.page,
      viewport: capture.target.viewport,
      theme: capture.target.theme,
      direction: capture.target.direction,
      findings: capture.findings,
    })),
  )
  const counts = summarise(
    captures.map((capture) => ({
      page: capture.target.page,
      viewport: capture.target.viewport,
      theme: capture.target.theme,
      direction: capture.target.direction,
      findings: capture.findings,
    })),
  )

  const sections = pages.map((page) => {
    const forPage = captures.filter((capture) => capture.target.page === page)
    const viewportBlocks = VIEWPORTS.map((viewport) => {
      const cells = THEMES.flatMap((theme) =>
        (['ltr', 'rtl'] as const).map((direction) =>
          cell(forPage, viewport.name, theme, direction),
        ),
      )
      return [
        '<section class="viewport">',
        `<h3>${safeText(viewport.name)} <span class="muted">${viewport.width}px — ${safeText(viewport.why)}</span></h3>`,
        `<div class="grid">${cells.join('')}</div>`,
        '</section>',
      ].join('')
    })
    return [
      `<article class="page"><h2>${safeText(page)}</h2>`,
      ...viewportBlocks,
      '</article>',
    ].join('')
  })

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeText(options.title)}</title>
<style>
${tokensCss()}
/* The gallery is a page in this system, so it uses the system's tokens. An earlier version hardcoded
   its own greys and the colour gate caught it, which is the gate working on the tool that watches
   for exactly this. */
* { box-sizing: border-box; }
body { margin: 0; background: var(--color-ground); color: var(--color-ink); font: 16px/1.5 system-ui, sans-serif; }
.wrap { max-width: 1400px; margin-inline: auto; padding: 24px 16px 64px; }
h1 { font-size: 1.5rem; margin: 0 0 4px; }
.subtitle { color: var(--color-ink-2); margin: 0 0 24px; }
.summary { border: 1px solid var(--color-hairline); border-radius: var(--radius-2); padding: 16px; margin-block-end: 32px; background: var(--color-surface); }
.summary h2 { font-size: 1rem; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-ink-2); }
.findings { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.finding { display: grid; grid-template-columns: max-content max-content 1fr; gap: 10px; align-items: baseline; font-size: 0.875rem; }
@media (max-width: 640px) { .finding { grid-template-columns: 1fr; gap: 2px; } }
.finding .rule { font-weight: 600; }
.finding--defect .rule { color: var(--color-danger); }
.finding--warning .rule { color: var(--color-accent-gold); }
.finding code { color: var(--color-ink-2); }
.clean { color: var(--color-ink-2); margin: 0; }
article.page { margin-block-end: 48px; }
article.page > h2 { font-size: 1.25rem; border-bottom: 1px solid var(--color-hairline); padding-block-end: 8px; }
.viewport h3 { font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-ink-2); margin: 24px 0 8px; }
.viewport h3 .muted { text-transform: none; letter-spacing: 0; font-weight: 400; }
/* Light beside dark, LTR beside RTL, at one viewport — the four cells where a defect reads as a
   difference rather than as something you had to already know. */
.grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
@media (max-width: 900px) { .grid { grid-template-columns: repeat(2, 1fr); } }
figure.cell { margin: 0; border: 1px solid var(--color-hairline); border-radius: var(--radius-1); overflow: hidden; background: var(--color-surface); }
figure.cell figcaption { font-size: 0.75rem; padding: 6px 8px; color: var(--color-ink-2); border-bottom: 1px solid var(--color-hairline); }
.badge { color: var(--color-danger); font-weight: 600; }
figure.cell img { display: block; width: 100%; height: auto; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${safeText(options.title)}</h1>
  <p class="subtitle">${safeText(options.subtitle)}</p>

  <div class="summary">
    <h2>Self-critique — ${counts.defects} defect(s), ${counts.warnings} warning(s)</h2>
    ${
      findings.length === 0
        ? '<p class="clean">Nothing found. Every rule in docs/08 that this pass can check, passes.</p>'
        : `<ul class="findings">${findings.map(findingRow).join('')}</ul>`
    }
  </div>

  ${sections.join('')}
</div>
</body>
</html>`
}
