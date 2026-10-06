import { readFileSync } from 'node:fs'
import { MONTH_RECONCILIATION_LINE_IDS } from '@berelax/db'
import { WORKED_EXAMPLE_EXPECTATIONS } from '@berelax/fixtures'
import { describe, expect, it } from 'vitest'
import {
  formatFils,
  type ReconciliationLineView,
  type ReconciliationView,
  renderMonthReconciliationHtml,
} from '../app/(admin)/accounts/reconciliation/render.ts'

/**
 * The reconciliation screen, rendered from rows and nothing else (M-VAT-12).
 *
 * Pure, so what it can prove is what a browser suite cannot: that the page shows every line the report
 * carries, that a variance is shown AS a variance, that a line making no claim is not shown as a tick, and
 * that the fils figure survives beside the dirham one. `apps/web/src/compliance.itest.ts` is the precedent
 * for the split — the served bytes are the integration suite's business, and the decisions are here.
 */

const CHROME = {
  googleReauth: null,
  sendBacklog: null,
  // `owner` is the widest menu, so this fixture can never hide a sidebar link an assertion looks for.
  role: 'owner' as const,
} as unknown as ReconciliationView['chrome']

const line = (
  id: string,
  overrides: Partial<ReconciliationLineView> = {},
): ReconciliationLineView => ({
  id,
  kind: 'identity',
  measure: 'fils',
  claim: `The claim of ${id}`,
  left: { label: 'documents', fils: '42000', rowsExamined: 3 },
  right: { label: 'ledger', fils: '42000', rowsExamined: 6 },
  variance: '0',
  derivedFrom: 'trialBalanceMovement (M-VAT-01)',
  ...overrides,
})

const view = (overrides: Partial<ReconciliationView> = {}): ReconciliationView => ({
  chrome: CHROME,
  periodId: '2200-01',
  startsOn: '2200-01-01',
  endsOn: '2200-01-31',
  closed: true,
  lockedPeriodId: 'MVAT12-2200-01',
  sourceAsOf: '2200-02-01T06:00:00.000Z',
  lines: MONTH_RECONCILIATION_LINE_IDS.map((id) => line(id)),
  unexplainedVarianceLines: [],
  examinedRows: 31,
  notExportableReasons: [],
  caveats: ['3 of 5 VAT201 box numbers are placeholders ([UNVERIFIED] Y11-vat201-boxes)'],
  ...overrides,
})

describe('the page shows the whole report', () => {
  it('renders one row per line the report declares, and names each one', () => {
    const html = renderMonthReconciliationHtml(view())
    for (const id of MONTH_RECONCILIATION_LINE_IDS) {
      expect(html, id).toContain(`<code>${id}</code>`)
    }
    // The vacuity floor: eleven lines, so a render that dropped the table body would fail here rather
    // than passing because the ids happen to appear in a heading somewhere.
    expect(html.match(/<tbody>/g)).toHaveLength(1)
    expect(MONTH_RECONCILIATION_LINE_IDS).toHaveLength(
      Object.keys(WORKED_EXAMPLE_EXPECTATIONS).length,
    )
  })

  it('names the function each figure came from, on every line', () => {
    const html = renderMonthReconciliationHtml(
      view({
        lines: [
          line('output_tax_against_the_vat201_box', {
            derivedFrom: 'vat201Boxes and vat201BoxForGrouping (M-VAT-07)',
          }),
        ],
      }),
    )
    // The one thing a reviewer does with this page is pick a line and ask where the number is from.
    expect(html).toContain('from vat201Boxes and vat201BoxForGrouping (M-VAT-07)')
  })

  it('shows a variance AS a variance, with the word and not only the colour', () => {
    const out = renderMonthReconciliationHtml(
      view({
        lines: [line('payments_less_refunds_against_tender_accounts', { variance: '-42000' })],
        unexplainedVarianceLines: ['payments_less_refunds_against_tender_accounts'],
      }),
    )
    expect(out).toContain('out by −AED 420.00')
    expect(out).toContain('1 line(s) do not hold')
    expect(out).toContain('may not be handed to the tax agent')
    // The control, which is the half that matters: the SAME page with the variance at zero must say the
    // opposite, or the banner is a decoration that says "do not hold" whatever the figures are.
    const holds = renderMonthReconciliationHtml(view())
    expect(holds).toContain('Every line holds')
    expect(holds).not.toContain('do not hold')
    // And the colour is never the only signal: each dot is aria-hidden and the word is in the text, so the
    // verdict reads the same to a colour-blind reviewer and to a screen reader.
    expect(out).toContain('dot-variance" aria-hidden="true"')
    expect(holds).toContain('dot-holds" aria-hidden="true"')
  })

  it('shows a `stated` line as claiming nothing, not as a tick', () => {
    const html = renderMonthReconciliationHtml(
      view({
        lines: [
          line('treasury_movements_excluded_from_receipts', { kind: 'stated', variance: '0' }),
        ],
      }),
    )
    expect(html).toContain('reported, nothing claimed')
    // The control: a `stated` line and an `identity` line that both hold must not render the same verdict,
    // or a figure nothing checked is shown with the same tick as one that was checked.
    expect(html).not.toContain('>holds</span>')
  })

  it('prints the row count it examined, because a month with nothing in it also has no variance', () => {
    expect(renderMonthReconciliationHtml(view({ examinedRows: 31 }))).toContain(
      '31 row(s) were examined',
    )
  })

  it('separates what is unconfirmed from what does not add up', () => {
    const html = renderMonthReconciliationHtml(view())
    expect(html).toContain('What is not confirmed')
    expect(html).toContain('Y11-vat201-boxes')
    // Stated as NOT a variance, on the page. "Nobody has confirmed this box number" and "this does not add
    // up" have different remedies, and a screen adding them together shows red on a month that reconciles.
    expect(html).toContain('None of these is a variance')
    expect(html).toContain('Every line holds')
  })

  it('says whether the figures are as filed, and refuses to call an open month exportable', () => {
    const closed = renderMonthReconciliationHtml(view())
    expect(closed).toContain('read as at <strong>2200-02-01T06:00:00.000Z</strong>')
    expect(closed).toContain('<code>MVAT12-2200-01</code>')
    expect(closed).toContain('Exportable.')

    const open = renderMonthReconciliationHtml(
      view({
        closed: false,
        lockedPeriodId: null,
        notExportableReasons: ['the period ending 2200-01-31 is not closed'],
      }),
    )
    expect(open).toContain('The period is <strong>open</strong>')
    expect(open).toContain('Not exportable.')
    expect(open).toContain('is not closed')
    expect(open).not.toContain('>Exportable.')
  })

  it('shows no TRN, no customer name and no phone number', () => {
    const html = renderMonthReconciliationHtml(view())
    // Nothing on this page needs a TRN and none is on file (Y1-trn). Fifteen consecutive digits is the
    // shape of one, and a UAE mobile is the shape of the other.
    expect(html).not.toMatch(/\d{15}/)
    expect(html).not.toMatch(/\+971/)
    expect(html.toLowerCase()).not.toContain('customer 0')
  })
})

describe('a fils figure reaches the reader without being rounded', () => {
  it('renders dirhams and fils from the integer, by string arithmetic', () => {
    expect(formatFils('42000')).toBe('AED 420.00')
    expect(formatFils('0')).toBe('AED 0.00')
    expect(formatFils('1')).toBe('AED 0.01')
    expect(formatFils('-42000')).toBe('−AED 420.00')
    expect(formatFils('123456789')).toBe('AED 1,234,567.89')
  })

  it('renders a figure above 2^53 exactly, which is what Number could not do', () => {
    // 9_007_199_254_740_993 fils is 2^53 + 1. `Number` cannot hold it and rounds to …992, so a page that
    // parsed the string would print a figure one fil below the one in the ledger. Absurd as a balance and
    // the whole reason every figure here is a string: `queries/trial-balance.ts` records the four fils a
    // `number` invented out of a ledger that balanced, at exactly this magnitude.
    expect(formatFils('9007199254740993')).toBe('AED 90,071,992,547,409.93')
    expect(String(Number('9007199254740993'))).toBe('9007199254740992')
  })

  it('keeps the integer beside the dirham figure on every row', () => {
    const html = renderMonthReconciliationHtml(
      view({ lines: [line('invoices_less_credit_notes_against_revenue_and_output_vat')] }),
    )
    // A reviewer comparing this page against a `psql` session needs the row counts and the labels, and the
    // dirham figure is a rendering of the integer rather than the figure itself.
    expect(html).toContain('AED 420.00')
    expect(html).toContain('3 row(s) read')
    expect(html).toContain('6 row(s) read')
  })
})

/**
 * The route's own decisions, read off its source.
 *
 * A scan and not a request, because these are claims about what the handler CANNOT do and the only layer
 * that can see them is the text. A served response proves the route answers; it cannot prove that the
 * route has no default month, which is the decision a reader of a cited link depends on. The mutants in
 * gate block 131 are what stop this being a scan that has never fired.
 */
describe('the route decides the period from the request and never from a clock', () => {
  const source = readFileSync(
    new URL('../app/(admin)/accounts/reconciliation/route.ts', import.meta.url),
    'utf8',
  )

  it('requires ?period= and answers 400 rather than defaulting to a month', () => {
    expect(source).toContain("url.searchParams.get('period')")
    expect(source).toContain('status: 400')
    // The SHAPE, not just the status: a missing parameter has to yield no period. A default supplied to
    // `periodFrom` leaves `status: 400` in the file and makes the branch dead code, which is what gate case
    // 131v plants — and the first version of this scan, which looked only for the status, reported a pass
    // about a route that had acquired a default month.
    expect(source).toContain('requested === null ? null : periodFrom(requested)')
    // No fallback operator may reach `periodFrom`: a `??` or a `||` there is a default month in disguise.
    expect(source).not.toMatch(/periodFrom\([^)]*(\?\?|\|\|)/)
    // The control: no month may be derived from the clock. `Date.now()` is permitted for the `?at=`
    // instant an OPEN period is read at and for nothing else, so the month must never be built from it.
    expect(source).not.toMatch(/periodFrom\(\s*new Date\(/)
    expect(source).not.toMatch(/getMonth\(\)|getFullYear\(\)/)
  })

  it('guards the session as its first statement, and mutates nothing', () => {
    expect(source).toContain('const authorised = await guardAdminRoute(request)')
    // Read-only: a GET that wrote an audit row would have to name an actor, and a GET has none to name.
    // The export is a POST and belongs with the unit that has a signed-in principal (see the route header).
    expect(source).not.toContain('export async function POST')
    // A CALL and not the name: the route's own header explains at length why the export is not here, so a
    // scan for the bare identifier would fire on the paragraph that says it is absent. Gate case 131u
    // plants the call and requires this to notice, which is what distinguishes the two.
    expect(source).not.toMatch(/exportMonthReconciliation\(/)
  })

  it('carries every figure to the page as a string, never through Number', () => {
    // `String(bigint)` is exact at any magnitude; `Number(bigint)` rounds above 2^53. A page about money
    // may not round on the way to the reader, and this is the one seam where the conversion happens.
    expect(source).toContain('String(line.left.fils)')
    expect(source).toContain('String(line.right.fils)')
    expect(source).toContain('String(line.variance)')
    expect(source).not.toMatch(/Number\(line\./)
  })

  it('computes no figure of its own, and reorders no line', () => {
    // The page is the report. A route that filtered or sorted the lines would be a second opinion about
    // what reconciles, and a route that summed anything would be the second derivation the whole unit is
    // arranged to avoid.
    expect(source).not.toMatch(/\.filter\(|\.sort\(|\.reduce\(/)
    expect(source).toContain('report.lines.map(')
  })
})
