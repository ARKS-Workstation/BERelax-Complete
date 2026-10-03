import { readFileSync } from 'node:fs'
import { GATED_FIGURE_STATES, type GatedFigure, type GateRefusal } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  KPI_TILE_CSS,
  KPI_TILE_STATE_ATTRIBUTE,
  type KpiTileProps,
  kpiStateHeadline,
  renderKpiTile,
} from './kpi-tile.ts'

/**
 * R-REP-07's arch acceptance line, over the tile itself.
 *
 * *"the KPI tile component's props accept only a discriminated union with no numeric fallback branch, so
 * no code path reaches a number without a passing check"*. A type cannot be asserted at runtime and a
 * source scan cannot prove a type, so the claim is made from both ends:
 *
 *   * **the bytes** — every one of the seven states is rendered and the published figure is required to
 *     be absent from all six refusals, with the `value` case as the control that the search string is
 *     one the renderer can produce at all;
 *   * **the source** — the module is read and required to contain no `??`, no `|| 0`, no `Number(` and no
 *     `default:` in its switch, and to write `figure.value` exactly once. Each of those is a way a
 *     fallback gets added by somebody fixing a blank tile, and none of them is visible in a type.
 *
 * The scan is counted, so a renamed file or a rewritten switch is a failing test rather than a scan that
 * quietly matched nothing (ADR 0003).
 */

const SOURCE_PATH = new URL('./kpi-tile.ts', import.meta.url).pathname
const SOURCE = readFileSync(SOURCE_PATH, 'utf8')

/**
 * The source with its comments removed.
 *
 * Every scan below reads this and not {@link SOURCE}, so the prose explaining a forbidden construct is
 * not itself a violation and the sentence naming `figure.value` is not a second write of it. Both traps
 * are recorded ones: `check-send-chokepoint.mjs` exempts itself for the first and the SQL-template scan
 * in `kpi-arch.test.ts` carries a regex built around the second.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** The figure the `value` state publishes. Distinctive, so its absence elsewhere means something. */
const PUBLISHED = '1234.5678'

const refusal = (label: string, detail: string): GateRefusal => ({
  checkId: 'ledger_vs_facts',
  label,
  detail,
})

/** One figure per state, so the renderer is exercised over the whole union. */
const FIGURES: Readonly<Record<(typeof GATED_FIGURE_STATES)[number], GatedFigure<string>>> =
  Object.freeze({
    value: { state: 'value', value: PUBLISHED },
    no_denominator: { state: 'no_denominator', why: 'the salon was shut every day in the window' },
    no_data: {
      state: 'no_data',
      why: 'a figure this KPI reads was not available',
      missingFigures: ['variableCostFils'],
    },
    not_attributable: {
      state: 'not_attributable',
      why: 'no per-unit cost basis exists',
      missing: ['consumables'],
      openQuestionIds: ['Y9-unit-cost-basis'],
    },
    unreconciled: {
      state: 'unreconciled',
      why: 'one reconciliation check gating this figure does not hold',
      refusedBy: [refusal('Revenue facts against the journal', 'a variance of 1 fils')],
    },
    stale: {
      state: 'stale',
      why: 'the views this figure is read from are older than the staleness window',
      refusedBy: [refusal('View freshness', 'the oldest view is 1561 minutes old')],
    },
    unattested: {
      state: 'unattested',
      why: 'a check gating this figure has never run',
      refusedBy: [refusal('Conversion dispatch reconciliation', 'no pass has produced a reading')],
    },
  })

const props = (figure: GatedFigure<string>): KpiTileProps => ({
  kpiId: 'room_utilisation',
  label: 'Room utilisation',
  formula: 'room_occupied_minutes ÷ available_room_minutes',
  unit: 'ratio',
  figure,
  drillDownHref: '/reports/data-quality?check=ledger_vs_facts',
})

describe('the tile renders every state the union declares', () => {
  it('publishes the attribute for each one, and nothing else', () => {
    const states = GATED_FIGURE_STATES.map((state) => {
      const html = renderKpiTile(props(FIGURES[state]))
      expect(html).toContain(`${KPI_TILE_STATE_ATTRIBUTE}="${state}"`)
      return state
    })
    // The control: seven states, each rendered. A union member added in `core` and not covered here
    // would fail the `Record` above at `pnpm typecheck` rather than be skipped silently.
    expect(states.length).toBe(7)
    expect(new Set(states).size).toBe(7)
  })

  it('prints the figure for `value` and for nothing else', () => {
    const measured = renderKpiTile(props(FIGURES.value))
    // The control first: the search string is one the renderer really does produce.
    expect(measured).toContain(PUBLISHED)
    expect(measured).toContain('kpi-tile__figure')
    for (const state of GATED_FIGURE_STATES) {
      if (state === 'value') continue
      const html = renderKpiTile(props(FIGURES[state]))
      expect(html, `${state} rendered the published figure`).not.toContain(PUBLISHED)
      expect(html, `${state} rendered a figure element`).not.toContain('kpi-tile__figure')
    }
  })

  it('names the refusal in words as well as in an attribute', () => {
    // Colour alone is not a distinction a greyscale print, a colour-blind reader or a pixel diff can
    // read, so each refusal carries a headline.
    for (const state of GATED_FIGURE_STATES) {
      if (state === 'value') continue
      expect(renderKpiTile(props(FIGURES[state]))).toContain(kpiStateHeadline(state))
      expect(kpiStateHeadline(state).trim()).not.toBe('')
    }
    expect(kpiStateHeadline('value')).toBe('')
  })

  it('carries the formula and the check that refused, under every state', () => {
    for (const state of GATED_FIGURE_STATES) {
      const html = renderKpiTile(props(FIGURES[state]))
      // The formula is on the tile even when the figure is refused: a reader asking "what would this
      // have been" needs the definition, and a refusal that hid it would be a blank box.
      expect(html).toContain('available_room_minutes')
      expect(html).toContain('data-kpi-id="room_utilisation"')
    }
    const unreconciled = renderKpiTile(props(FIGURES.unreconciled))
    expect(unreconciled).toContain('Revenue facts against the journal')
    expect(unreconciled).toContain('a variance of 1 fils')
  })

  it('omits the drill-down when there is none, and escapes the one there is', () => {
    expect(renderKpiTile({ ...props(FIGURES.value), drillDownHref: null })).not.toContain('<a href')
    const hostile = renderKpiTile({
      ...props(FIGURES.value),
      drillDownHref: '/x?a="b"><script>alert(1)</script>',
      label: '<img src=x onerror=alert(1)>',
    })
    expect(hostile).not.toContain('<script>alert(1)</script>')
    expect(hostile).not.toContain('<img src=x')
    expect(hostile).toContain('&lt;')
  })
})

describe('no numeric fallback branch exists in the source', () => {
  it('reads the module it claims to', () => {
    // The floor. A scan over an empty string passes every absence assertion below.
    expect(SOURCE.length).toBeGreaterThan(2_000)
    expect(CODE.length).toBeGreaterThan(1_000)
    expect(SOURCE).toContain('export function renderKpiTile')
    expect(SOURCE_PATH.endsWith('packages/ui/src/reporting/kpi-tile.ts')).toBe(true)
  })

  it('writes the figure exactly once', () => {
    // Once, in the `value` branch. Twice would mean a second place a number is emitted from, which is
    // where a refusal's "would have been" figure gets printed beside the warning.
    expect(CODE.split('figure.value').length - 1).toBe(1)
  })

  it('has no fallback operator and no numeric coercion', () => {
    for (const forbidden of ['??', '|| 0', 'Number(', 'parseFloat', 'toFixed', 'default:']) {
      expect(CODE, `the tile source contains ${forbidden}`).not.toContain(forbidden)
    }
    // And the control: a construct the file DOES contain, so the absence assertions are about a string
    // search that works.
    expect(CODE).toContain('switch (figure.state)')
  })

  it('colours nothing with a literal and distinguishes a refusal by more than hue', () => {
    expect(KPI_TILE_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(KPI_TILE_CSS).toContain('var(--color-danger)')
    // A border width as well as a colour, on each refusal state, for the same reason the admin banner
    // carries a word: hue alone is not a distinction every reader has.
    expect(KPI_TILE_CSS).toContain('border-inline-start-width')
  })
})
