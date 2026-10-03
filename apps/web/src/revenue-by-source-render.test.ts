import {
  conversionValueFromFils,
  type DispatchReconciliation,
  reconcileDispatches,
  UNRECONCILED,
  UNRECONCILED_PANEL_SENTENCE,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  REVENUE_BY_SOURCE_CSS,
  type RevenueBySourceEntry,
  renderRevenueBySource,
  revenueBySourceApiValue,
} from '../app/(admin)/analytics/panels/revenue-by-source.ts'

/**
 * The revenue-by-source panel, at BOTH layers (A-MEAS-07).
 *
 * The acceptance line is *"when the difference is non-zero the revenue-by-source panel renders an explicit
 * unreconciled state and the API returns `Unreconciled` rather than a number — asserted at both layers"*,
 * and this file is both halves: `revenueBySourceApiValue` is the API's answer and `renderRevenueBySource`
 * is the document's bytes.
 *
 * Every "the markup does not contain X" case is paired with a control proving the search would FIND X,
 * because an absence is exactly what a broken search reports — the convention `checkout-render.test.ts`
 * states for the same reason.
 */

const DESTINATION = 'analytics_measurement_push'
const OTHER = 'advertising_conversion_push'

const reconciled = (destination = DESTINATION): DispatchReconciliation =>
  reconcileDispatches({
    destination,
    internal: [{ eventId: 'event-01', valueFils: 32_010 }],
    pushed: [{ eventId: 'event-01', dispatchId: 'dispatch-01', state: 'sent', valueFils: 32_010 }],
  })

const unreconciled = (destination = DESTINATION): DispatchReconciliation =>
  reconcileDispatches({
    destination,
    internal: [
      { eventId: 'event-01', valueFils: 32_010 },
      { eventId: 'event-02', valueFils: 12_505 },
    ],
    pushed: [{ eventId: 'event-01', dispatchId: 'dispatch-01', state: 'sent', valueFils: 32_010 }],
  })

const entry = (reconciliation: DispatchReconciliation, figure?: string): RevenueBySourceEntry =>
  figure === undefined ? { reconciliation } : { reconciliation, figure }

describe('the API layer', () => {
  it('answers the formatted figure for a reconciled destination', () => {
    expect(revenueBySourceApiValue(entry(reconciled(), conversionValueFromFils(32_010)))).toBe(
      '320.10',
    )
  })

  it('answers Unreconciled rather than a number when the figures disagree', () => {
    // Even when a figure is handed in, which is the case that matters: a caller holding a number must not
    // be able to get it past this layer for a day whose figures do not agree.
    expect(revenueBySourceApiValue(entry(unreconciled(), '320.10'))).toBe(UNRECONCILED)
    expect(revenueBySourceApiValue(entry(unreconciled(), '320.10'))).not.toMatch(/\d/)
  })

  it('answers Unreconciled rather than a zero for a reconciled destination with no figure', () => {
    // `0.00` is a real figure and would read as "this source produced no revenue", which is the exact
    // confusion ADR 0002 is about.
    expect(revenueBySourceApiValue(entry(reconciled()))).toBe(UNRECONCILED)
  })
})

describe('the document layer', () => {
  it('renders the figure for a reconciled destination, which is the control', () => {
    const markup = renderRevenueBySource({
      businessDay: '2026-10-21',
      entries: [entry(reconciled(), conversionValueFromFils(32_010))],
    })
    expect(markup).toContain('data-state="reconciled"')
    expect(markup).toContain('320.10')
    expect(markup).toContain('revenue-by-source__figure')
  })

  it('renders NO figure and no figure element at all when the day is unreconciled', () => {
    const markup = renderRevenueBySource({
      businessDay: '2026-10-21',
      entries: [entry(unreconciled(), '320.10')],
    })
    expect(markup).toContain('data-state="unreconciled"')
    expect(markup).toContain(UNRECONCILED)
    expect(markup).toContain(UNRECONCILED_PANEL_SENTENCE)
    // Not a figure in amber, not a figure with an asterisk: no figure, and no element for a stylesheet to
    // reveal one in. The control above proves this search finds the figure when it is there.
    expect(markup).not.toContain('revenue-by-source__figure')
    expect(markup).not.toContain('320.10')
    expect(markup).not.toContain('125.05')
  })

  it('names every discrepancy by its event id and its kind', () => {
    const markup = renderRevenueBySource({
      businessDay: '2026-10-21',
      entries: [entry(unreconciled())],
    })
    expect(markup).toContain('data-kind="missing"')
    expect(markup).toContain('event-02')
    // And NOT the conversion that was pushed correctly, which would make the list unreadable on a real day.
    expect(markup).not.toContain('>missing: event-01<')
  })

  it('renders the destination whose figures DISAGREE beside the one whose figures agree', () => {
    // The failure this case is about: a screen that shows the destination that reconciled and quietly
    // omits the one that did not.
    const markup = renderRevenueBySource({
      businessDay: '2026-10-21',
      entries: [
        entry(reconciled(DESTINATION), conversionValueFromFils(32_010)),
        entry(unreconciled(OTHER)),
      ],
    })
    expect(markup).toContain(`data-destination="${DESTINATION}"`)
    expect(markup).toContain(`data-destination="${OTHER}"`)
    expect(markup).toContain('data-state="reconciled"')
    expect(markup).toContain('data-state="unreconciled"')
  })

  it('names a push with no internal record behind it, which is the other direction', () => {
    const result = reconcileDispatches({
      destination: DESTINATION,
      internal: [],
      pushed: [
        { eventId: 'event-09', dispatchId: 'dispatch-09', state: 'sent', valueFils: 32_010 },
      ],
    })
    const markup = renderRevenueBySource({ businessDay: '2026-10-21', entries: [entry(result)] })
    expect(markup).toContain('data-kind="pushed_without_internal_truth"')
    expect(markup).toContain('event-09')
  })

  it('escapes what it renders, because a destination id and an event id arrive as data', () => {
    const result = reconcileDispatches({
      destination: DESTINATION,
      internal: [{ eventId: '<script>alert(1)</script>', valueFils: 1 }],
      pushed: [],
    })
    const markup = renderRevenueBySource({ businessDay: '2026-10-21', entries: [entry(result)] })
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('&lt;script&gt;')
  })

  it('is byte-identical for two renders of one view, which is what makes a screenshot diffable', () => {
    const view = {
      businessDay: '2026-10-21',
      entries: [entry(unreconciled())],
    }
    expect(renderRevenueBySource(view)).toBe(renderRevenueBySource(view))
  })
})

describe('the stylesheet', () => {
  it('keys off the state attribute and holds no literal colour', () => {
    expect(REVENUE_BY_SOURCE_CSS).toContain("[data-state='unreconciled']")
    // `pnpm colours` refuses a literal hex outside the token layer; asserted here as well, because this
    // file's own failure would otherwise arrive as a repository-wide gate naming a different unit.
    expect(REVENUE_BY_SOURCE_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(REVENUE_BY_SOURCE_CSS).not.toMatch(/\b(rgb|hsl|oklch)\(/)
  })
})
