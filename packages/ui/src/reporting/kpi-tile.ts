import { type GATED_FIGURE_STATES, type GatedFigure, safeText } from '@berelax/core'

/**
 * The KPI tile: the one place a reported figure becomes bytes (R-REP-07).
 *
 * # The acceptance line, and why it is a property of this file rather than a test over it
 *
 * *"the KPI tile component's props accept only a discriminated union with no numeric fallback branch, so
 * no code path reaches a number without a passing check"*. Two halves:
 *
 *   * **The props.** {@link KpiTileProps}`.figure` is `GatedFigure<string>` — `@berelax/core`'s union,
 *     imported and not restated. Only its `value` state carries a `value` field at all, so there is no
 *     `number` and no `string` on any refusal for this renderer to print. A caller holding a refusal
 *     cannot hand this function a figure, because it has none to hand.
 *   * **The branches.** {@link renderKpiTile} switches over {@link GATED_FIGURE_STATES} and the only
 *     branch that emits the figure is `value`. There is no `default:`, so a state added to the union is
 *     a `pnpm typecheck` failure naming this file rather than a tile that silently renders nothing — and
 *     there is no `??`, no `|| 0` and no `Number(` anywhere in it. `kpi-tile.test.ts` renders every
 *     state and asserts that no refusal's bytes contain a digit outside its own prose, which is the
 *     half a type cannot make.
 *
 * # Why the figure arrives already published
 *
 * `figure` is `GatedFigure<string>` and not `GatedFigure<KpiResult>`: the decimal string is produced by
 * `publishGatedFigure` in `@berelax/core`, which takes the `value` state and nothing else. So the
 * formatting decision — how many places a unit publishes to — stays with the registry that owns the
 * unit, and this module cannot round a figure differently from the API that served it. A tile that
 * formatted its own number would be a second answer to "what does this figure read as", and the symptom
 * is a screenshot that disagrees with an export.
 *
 * # Markup and not a React component, which is the estate's existing shape
 *
 * `apps/web/src/routes/registry.ts` is in bijection with the filesystem and requires every *document* to
 * be served in both locales, so an admin page is a route handler returning bytes — the arrangement the
 * Google re-auth banner, the Messages inbox, the compliance calendar, the month reconciliation and the
 * five HR screens all record in their own headers. A `.tsx` tile would be a component with no document
 * to live in.
 *
 * # Why this is in `@berelax/ui` and NOT re-exported from its barrel
 *
 * It is the design system's component and it belongs with the tokens it is coloured from. It reaches
 * `@berelax/core` for the union and for `safeText`, which is a new edge for this package — so it is
 * exported at `@berelax/ui/reporting` and deliberately absent from `src/index.ts`. A barrel export would
 * pull `@berelax/core` into every module that imports a colour token, including the client islands whose
 * weight `build/budgets.json` holds to 2KB and 3KB.
 */

/** A row the tile prints under a refusal: which check refused, and what it said. */
export interface KpiTileRefusalRow {
  readonly label: string
  readonly detail: string
}

export interface KpiTileProps {
  /** The registered KPI id, for the drill-down link and for the arch scan that checks it is registered. */
  readonly kpiId: string
  readonly label: string
  /** The formula the registry rendered. Printed always, including under a refusal. */
  readonly formula: string
  /** The unit, as a word a reader can see beside the figure. */
  readonly unit: string
  /**
   * The figure, already published, or one of the seven refusals.
   *
   * `GatedFigure<string>` and not a union of this module's own: a second statement of "may this be
   * printed" would drift in the direction that prints something.
   */
  readonly figure: GatedFigure<string>
  /** Where the tile drills to, or `null` for a figure with no drill-down. */
  readonly drillDownHref: string | null
}

/** The attribute the tile's state is published as, so a test and a stylesheet name it once. */
export const KPI_TILE_STATE_ATTRIBUTE = 'data-kpi-state'

/**
 * How each state reads to somebody looking at the screen.
 *
 * A total `Record` over the union's own state list, so a state added in `core` and forgotten here is a
 * `pnpm typecheck` failure. A `string` lookup with a fallback would have rendered the new state as
 * whatever the fallback said — which for a refusal is the one direction that must not be guessed.
 */
const STATE_HEADLINE: Readonly<Record<(typeof GATED_FIGURE_STATES)[number], string>> =
  Object.freeze({
    value: '',
    no_denominator: 'No denominator',
    no_data: 'No data',
    not_attributable: 'Not attributable',
    unreconciled: 'Unreconciled',
    stale: 'Stale',
    unattested: 'Unattested',
  })

/** Every refusal state's headline, so a caller can label an API response the way the tile does. */
export const kpiStateHeadline = (state: (typeof GATED_FIGURE_STATES)[number]): string =>
  STATE_HEADLINE[state]

const list = (rows: readonly KpiTileRefusalRow[]): string =>
  rows.length === 0
    ? ''
    : `<ul class="kpi-tile__refusals">${rows
        .map(
          (row) =>
            `<li><span class="kpi-tile__check">${safeText(row.label)}</span> ${safeText(row.detail)}</li>`,
        )
        .join('')}</ul>`

const names = (what: string, entries: readonly string[]): string =>
  entries.length === 0
    ? ''
    : `<p class="kpi-tile__named">${safeText(what)}: ${entries
        .map((entry) => safeText(entry))
        .join(', ')}</p>`

/**
 * The tile's body: the figure, or the refusal and what refused it.
 *
 * Exhaustive over the union with no `default:`. The `value` branch is the only one that writes
 * `figure.value`, and the six others have nothing numeric on them to write.
 */
function body(figure: GatedFigure<string>, unit: string): string {
  switch (figure.state) {
    case 'value':
      return (
        `<p class="kpi-tile__figure">${safeText(figure.value)}` +
        `<span class="kpi-tile__unit">${safeText(unit)}</span></p>`
      )
    case 'no_denominator':
      return `<p class="kpi-tile__why">${safeText(figure.why)}</p>`
    case 'no_data':
      return (
        `<p class="kpi-tile__why">${safeText(figure.why)}</p>` +
        names('Figures not read', [...figure.missingFigures])
      )
    case 'not_attributable':
      return (
        `<p class="kpi-tile__why">${safeText(figure.why)}</p>` +
        names('Not attributable', [...figure.missing]) +
        names('Open questions', [...figure.openQuestionIds])
      )
    case 'unreconciled':
    case 'stale':
    case 'unattested':
      return `<p class="kpi-tile__why">${safeText(figure.why)}</p>${list(figure.refusedBy)}`
  }
}

/**
 * One tile.
 *
 * The state is on the element as `data-kpi-state`, which is what a screenshot diff, an axe run and the
 * integration suite all read — a colour alone would be a claim only a human could check, and a tile that
 * went green while reading `Unreconciled` would pass a pixel diff on a grey screenshot.
 */
export function renderKpiTile(props: KpiTileProps): string {
  const headline = STATE_HEADLINE[props.figure.state]
  const drill =
    props.drillDownHref === null
      ? ''
      : `<p class="kpi-tile__drill"><a href="${safeText(props.drillDownHref)}">Show the rows behind this</a></p>`
  return (
    `<article class="kpi-tile" ${KPI_TILE_STATE_ATTRIBUTE}="${props.figure.state}" ` +
    `data-kpi-id="${safeText(props.kpiId)}">` +
    `<h3 class="kpi-tile__label">${safeText(props.label)}</h3>` +
    (headline === '' ? '' : `<p class="kpi-tile__headline">${safeText(headline)}</p>`) +
    body(props.figure, props.unit) +
    `<p class="kpi-tile__formula"><code>${safeText(props.formula)}</code></p>` +
    drill +
    '</article>'
  )
}

/**
 * The tile's stylesheet.
 *
 * Every colour is a token (`pnpm colours` refuses a literal hex outside the token layer). The font sizes
 * are `TYPE_SCALE`'s own values written as literals, which is what the two admin banners already do:
 * `tokens.css` emits no `--font-size-*` custom property, so a `var()` here would resolve to nothing and
 * the tile would render at the browser default — the failure mode of referring to a token that is not
 * emitted rather than to one that is wrong.
 *
 * The
 * refusal states are distinguished by a border and a label rather than by colour alone — a tile whose
 * only difference from a figure is its hue is a tile that reads as a figure in a greyscale print, to a
 * colour-blind reader, and in a visual-regression baseline.
 */
export const KPI_TILE_CSS = `
  .kpi-tile {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-2);
    background: var(--color-surface);
    color: var(--color-ink);
    padding: var(--space-4) var(--space-5);
  }
  .kpi-tile__label {
    font-size: 0.875rem;
    color: var(--color-ink-2);
    margin: 0 0 var(--space-2);
  }
  .kpi-tile__figure {
    font-size: 1.875rem;
    margin: 0;
  }
  .kpi-tile__unit {
    font-size: 0.875rem;
    color: var(--color-ink-2);
    margin-inline-start: var(--space-2);
  }
  .kpi-tile__headline {
    font-size: 1.0625rem;
    margin: 0 0 var(--space-2);
    color: var(--color-ink);
  }
  .kpi-tile__why,
  .kpi-tile__named { margin: 0 0 var(--space-2); color: var(--color-ink-2); }
  /*
    ink-2 and not ink-3, and the reason is a MEASUREMENT rather than taste: axe reported
    color-contrast as SERIOUS on this element in all twelve cells of the matrix. ink-3 on a surface
    is under 4.5:1, and a formula in a code element at the body size is normal text. Found by
    running apps/web/e2e/dashboards.itest.ts; the string-level tile suite could not see it, because
    a contrast ratio is a property of two rendered colours.

    No backticks in this comment, deliberately: it lives INSIDE a template literal, and a backtick
    here closes the string. That cost a web build.
  */
  .kpi-tile__formula { margin: var(--space-3) 0 0; color: var(--color-ink-2); }
  .kpi-tile__refusals { margin: 0 0 var(--space-2); padding-inline-start: var(--space-5); }
  .kpi-tile__check { color: var(--color-ink); }
  .kpi-tile[${KPI_TILE_STATE_ATTRIBUTE}="unreconciled"],
  .kpi-tile[${KPI_TILE_STATE_ATTRIBUTE}="unattested"] {
    border-color: var(--color-danger);
    border-inline-start-width: var(--space-2);
  }
  .kpi-tile[${KPI_TILE_STATE_ATTRIBUTE}="stale"],
  .kpi-tile[${KPI_TILE_STATE_ATTRIBUTE}="no_data"],
  .kpi-tile[${KPI_TILE_STATE_ATTRIBUTE}="no_denominator"],
  .kpi-tile[${KPI_TILE_STATE_ATTRIBUTE}="not_attributable"] {
    border-color: var(--color-border-strong);
    border-inline-start-width: var(--space-2);
  }
`
