/**
 * The template editor's authoring-time cost preview, as HTML.
 *
 * docs/04 §5: "Compute encoding, segments and cost at authoring time and show it to whoever writes the
 * copy." This is the showing. An author types a body and sees, before anything is saved or sent, which
 * alphabet it will go out in, how many segments that is, what the segments cost and which character made
 * it expensive.
 *
 * Pure: a body in, a document out. No database, no clock, no `new Date()` — the figures are a function of
 * the body and nothing else, which is what lets `apps/web/src/template-editor-render.test.ts` assert them
 * without a server and what makes two consecutive renders of one body identical.
 *
 * ## Why a route handler and not a page
 *
 * The same reason B-MSG-04's inbox gives one directory along: W-SITE-01's registry is in exact bijection
 * with the filesystem and requires every *document* to be served in **both** locales, so a `page.tsx`
 * here would need an Arabic admin document and the admin shell that renders it — W-SYS-01's work — and it
 * would join a screenshot matrix whose RTL half must be a real Arabic route. This surface is English-only
 * on purpose: it is a tool for whoever writes the copy, and the copy it prices is in either language.
 *
 * ## Why the browser asks the server for every figure
 *
 * The inline script does no arithmetic. It sends the body and paints the numbers that came back, because
 * a second implementation of GSM-7 detection in a browser script is exactly the drift this unit exists to
 * prevent: the author would be shown one price and the invoice would carry another, and the two would
 * agree for every body anybody tested. `packages/core/src/messaging` is the only place that arithmetic
 * exists, and `smsCost` is the only place the rate does.
 */
import { type SmsCostPreview, safeText, smsCost, smsUnitsOf } from '@berelax/core'
import { tokensCss } from '@berelax/ui'

/**
 * The body the editor opens with: docs/04 §5's worked example, 150 Arabic characters.
 *
 * One letter repeated, which is what makes the count checkable by reading rather than by trusting a
 * paragraph of prose — and the same spelling as `ARABIC_150` in `packages/fixtures`, which
 * `apps/web/src/template-editor.itest.ts` asserts against so the screen and the committed fixture cannot
 * drift into two different worked examples.
 */
export const WORKED_EXAMPLE_BODY = 'ت'.repeat(150)

/** The page's own styles. Colours are tokens only; there is no literal in this file. */
const EDITOR_CSS = `
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
  h2 { font-size: 1.125rem; margin: 0 0 var(--space-3); }
  p { margin: 0 0 var(--space-5); max-width: 42rem; }
  .stub {
    border: 1px solid var(--color-border);
    border-inline-start-width: var(--space-2);
    border-radius: var(--radius-2);
    background: var(--color-surface-sand);
    padding: var(--space-5);
    margin: 0 0 var(--space-7);
  }
  form { display: grid; gap: var(--space-5); margin: 0 0 var(--space-7); }
  label { font-weight: 600; }
  textarea {
    width: 100%;
    min-height: 9rem;
    padding: var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface);
    color: var(--color-ink);
    font: 0.9375rem/1.6 ui-monospace, monospace;
    resize: vertical;
  }
  button {
    justify-self: start;
    min-height: 3rem;
    min-width: 3rem;
    padding: var(--space-3) var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-1);
    background: var(--color-surface-raised);
    color: var(--color-ink);
    font: inherit;
  }
  dl.figures {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: var(--space-5);
    margin: 0 0 var(--space-5);
    padding: var(--space-5);
    background: var(--color-surface);
    border: 1px solid var(--color-hairline);
    border-radius: var(--radius-2);
  }
  dl.figures div { margin: 0; }
  dl.figures dt { color: var(--color-ink-2); font-size: 0.875rem; }
  dl.figures dd { margin: 0; font-size: 1.25rem; font-variant-numeric: tabular-nums; }
  .forced { margin: 0 0 var(--space-5); color: var(--color-ink-2); }
  .provisional {
    /* Gold for an unconfirmed figure, the same signal the compliance dashboard gives an unconfirmed
       section, so one unverified thing does not look like two different kinds of notice. */
    border-inline-start: var(--space-1) solid var(--color-accent-gold);
    padding-inline-start: var(--space-3);
    color: var(--color-ink-2);
  }
  pre.split {
    margin: 0;
    padding: var(--space-5);
    background: var(--color-ground-sunk);
    border-radius: var(--radius-1);
    white-space: pre-wrap;
    word-break: break-word;
    font: 0.9375rem/1.6 ui-monospace, monospace;
  }
`

/**
 * The inline script.
 *
 * One job: send the body on every keystroke and paint what comes back. It computes no encoding, no
 * segment count and no price — see the module header. Two details that are not decoration:
 *
 *  - **The sequence guard.** A fast typist has several requests in flight, and they do not have to answer
 *    in order. Painting a late answer to an early keystroke would leave the figures describing a body the
 *    author has already changed, which is the one thing a preview must never do. So only the answer to
 *    the most recent request is painted.
 *  - **`data-preview-renders` on `<html>`.** It counts paints, which is how the integration test knows the
 *    figures were replaced **in the same document** rather than by a form submission that reloaded the
 *    page — a navigation would reset the counter to zero and lose the evidence.
 */
const EDITOR_SCRIPT = `
  const form = document.getElementById('editor')
  const field = document.getElementById('body')
  const root = document.documentElement
  let latest = 0
  async function refresh() {
    const sequence = latest + 1
    latest = sequence
    let data
    try {
      const response = await fetch(location.pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: field.value }),
      })
      if (!response.ok) throw new Error(String(response.status))
      data = await response.json()
    } catch (error) {
      root.dataset.previewError = String(error && error.message ? error.message : error)
      return
    }
    if (sequence !== latest) return
    for (const key of Object.keys(data)) {
      const node = document.querySelector('[data-figure="' + key + '"]')
      if (node) node.textContent = data[key]
    }
    root.dataset.previewRenders = String(Number(root.dataset.previewRenders || '0') + 1)
  }
  field.addEventListener('input', refresh)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    refresh()
  })
`

export interface PreviewFigures {
  readonly encoding: string
  readonly segments: string
  readonly units: string
  readonly remaining: string
  readonly cost: string
  readonly forced: string
  /**
   * Where the body breaks, as one block of text.
   *
   * One string rather than a list of elements, and that is not a presentation choice. Every figure on this
   * page is repainted by setting `textContent`, so anything the server renders as MARKUP cannot be
   * repainted — it would sit under the new numbers still describing the previous body, which is the stale
   * figure this screen exists not to show. The first version of this page rendered the split as an `<ol>`
   * and had exactly that defect.
   */
  readonly split: string
}

/**
 * The figures, as the strings that go on the screen.
 *
 * Formatted here rather than in the browser, so the script that paints them holds no rule of its own —
 * including the one about what "no characters forced it" reads like when the list is empty.
 */
export function previewFigures(body: string): PreviewFigures {
  return previewFiguresFrom(smsCost('smsala', body))
}

/** The same figures from a cost already computed, so one render does not price the body twice. */
function previewFiguresFrom(cost: SmsCostPreview): PreviewFigures {
  const { segmentation } = cost
  return {
    encoding: segmentation.encoding,
    segments: String(segmentation.segments),
    // Units, named for what they are in the encoding the body is actually in: septets are not characters
    // once an extension character is in the body, and code units are not characters once an emoji is.
    units:
      segmentation.encoding === 'GSM-7'
        ? `${segmentation.units} septets`
        : `${segmentation.units} code units`,
    remaining: String(segmentation.remaining),
    // Integer fils, spelled as fils. Money is never a float (ADR 0007), so it is never formatted as one.
    cost: `${cost.total.fils} fils`,
    forced:
      segmentation.forcedBy.length === 0
        ? 'nothing — this body is inside the GSM-7 alphabet'
        : segmentation.forcedBy.join(' '),
    split: splitText(cost),
  }
}

/**
 * The parts, with a rule between them, so an author can see which sentence pushed the message over.
 *
 * "Three segments" is a number; the split is the reason for it, and moving one sentence is often a third
 * off the bill. The unit count per part is what makes the boundary explainable rather than arbitrary —
 * and it is in septets or code units, because a GSM-7 part of 150 characters can be 153 septets.
 */
function splitText(cost: SmsCostPreview): string {
  const { parts, encoding } = cost.segmentation
  if (parts.length === 0) return 'nothing to send yet'
  if (parts.length === 1) return 'one segment — nothing is split'
  return parts
    .map(
      (part, index) =>
        `— segment ${index + 1} of ${parts.length}, ${smsUnitsOf(part, encoding)} units —\n${part}`,
    )
    .join('\n')
}

function figure(label: string, key: keyof PreviewFigures, value: string): string {
  return (
    `<div><dt>${safeText(label)}</dt>` + `<dd data-figure="${key}">${safeText(value)}</dd></div>`
  )
}

export function renderEditorHtml(body: string): string {
  const cost = smsCost('smsala', body)
  const figures = previewFiguresFrom(cost)
  return [
    '<!doctype html>',
    '<html lang="en" dir="ltr" data-preview-renders="0">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    // No brand in the title, deliberately. docs/09 §"The brand collision" requires the full name "Be
    // Relax Massage Center and Spa" wherever the brand appears in a title, because berelax.com is an
    // international airport-spa chain with an outlet in this city and a bare-brand title is a citation for
    // the wrong entity — `apps/web/src/seo/brand.test.ts` enforces it and caught "BE RELAX admin" here on
    // this unit's first verify. The full trading name on an internal authoring tool would say something it
    // does not mean, and no mention at all is not a violation: the rule is about how the brand is written.
    '<title>Template editor — admin</title>',
    `<style>${tokensCss()}${EDITOR_CSS}</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>Template editor</h1>',
    '<div class="stub">',
    '<p><strong>Nothing here is saved.</strong> This surface prices a body and does not create a ' +
      'template: creating one is a write, there is no admin session to record an author against until ' +
      'W-SYS-01, and a variant created without one would be words nobody can be shown to have approved. ' +
      'When the create path lands it must insert at <code>draft</code> and reach <code>approved</code> ' +
      'through <code>setTemplateApproval</code>, which is the path migration 0061 fences.</p>',
    '</div>',
    '<p>The box opens on the worked example from <code>docs/04-uae-compliance.md</code> §5: a 150-' +
      'character Arabic body. It is three segments, because one Arabic character forces the whole ' +
      'message to UCS-2 at 70 characters a segment (67 once concatenated) rather than GSM-7’s 160. ' +
      'The same 150 characters in English are one. Type over it to price your own copy.</p>',
    '<form id="editor" method="post">',
    '<label for="body">Message body</label>',
    `<textarea id="body" name="body" rows="6" spellcheck="false">${safeText(body)}</textarea>`,
    // A submit button, because the figures have to be reachable without JavaScript: the form posts to
    // this same route and the server renders the page again with them filled in.
    '<button type="submit">Price this body</button>',
    '</form>',
    '<h2>What it will cost</h2>',
    '<dl class="figures">',
    figure('Encoding', 'encoding', figures.encoding),
    figure('Segments', 'segments', figures.segments),
    figure('Length', 'units', figures.units),
    figure('Units free', 'remaining', figures.remaining),
    figure('Cost per recipient', 'cost', figures.cost),
    '</dl>',
    `<p class="forced">Forced to UCS-2 by: <span data-figure="forced">${safeText(
      figures.forced,
    )}</span></p>`,
    // The rate is provisional and says so on the screen showing the total. brief rule 15: a number
    // nothing marks as unconfirmed is indistinguishable from a configured one.
    `<p class="provisional">The rate is provisional: no SMSala rate card is on file, tracked as <code>${safeText(
      cost.provisionalUntil,
    )}</code> in <code>docs/OPEN-QUESTIONS.md</code>. The segment count is not provisional — it is ` +
      '3GPP TS 23.038 and will not change.</p>',
    '<h2>How it splits</h2>',
    `<pre class="split" data-figure="split">${safeText(figures.split)}</pre>`,
    '</main>',
    `<script>${EDITOR_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('')
}
