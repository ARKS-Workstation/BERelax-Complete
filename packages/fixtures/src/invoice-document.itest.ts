import {
  instantFromIso,
  isPlaceholderText,
  PLACEHOLDER_TRN,
  requireIssuerTrn,
  TrnNotConfigured,
  vatIfReDerivedFromTotal,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  type IssueInvoiceInput,
  issueInvoice,
  readInvoiceByDisplayNumber,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { ELEVEN_FILS_EXPECTED, FIXTURE_ISSUER, FIXTURE_TRN, invoiceFixture } from './invoice.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The pair: `@berelax/core` derives, `@berelax/db` stores, and the two agree.
 *
 * This lives in `packages/fixtures` because `packages/db` must never import `packages/core` — the
 * dependency runs the other way — and fixtures is the package allowed to depend on both. The same
 * reason `ledger-chart.itest.ts` lives here.
 *
 * What it proves that neither package can prove alone:
 *
 *   - the document stores the VAT core **summed** from the lines, and the figure a re-derivation from
 *     the document total would produce appears on no column of the stored document;
 *   - the tax point stored is the **trading** date `resolveTradingDate` resolved for a 01:30 supply,
 *     and it is not the issue date;
 *   - the placeholder TRN the migration seeds is the exact string core's validator refuses, and both
 *     layers refuse it;
 *   - `is_placeholder_text()` in SQL and `isPlaceholderText()` in TypeScript agree, which they have to,
 *     because the CHECK constraint holds for a psql session and the validator explains the refusal
 *     before the insert is attempted.
 */

const TILL: Actor = {
  kind: 'staff',
  id: '44444444-4444-4444-4444-444444444444',
  label: 'Till',
}

/** 01:30 on the 19th is inside the 18th's 11:00-02:00 session, so the tax point is the 18th. */
const SUPPLY_AT_0130 = instantFromIso('2026-09-19T01:30:00+04:00')
/** The invoice is written the next day, at noon. */
const ISSUED_AT_NOON = instantFromIso('2026-09-19T12:00:00+04:00')

const sql: Sql = createConnection({ url, max: 4 })

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  // `truncate` as the owner: the one statement that fires no row-level DELETE trigger, which is how
  // journal.itest.ts resets an append-only table too. berelax_app holds no TRUNCATE.
  await sql.unsafe('truncate invoice_line, invoice')
  await sql`
    update document_series
       set next_number = 1, period_key = '', prefix = 'TI-', padding = 5, reset_policy = 'annual'
     where code = 'TAX-INV'
  `
})

const elevenFils = () => invoiceFixture({ supplyAt: SUPPLY_AT_0130, issuedAt: ISSUED_AT_NOON })

const issue = (input: IssueInvoiceInput) =>
  withUnitOfWork(sql, TILL, (uow) => issueInvoice(uow, input))

/** Every `fils_nonneg` column of the stored header, by name. */
async function headerAmounts(displayNumber: string): Promise<Record<string, number>> {
  const columns = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'invoice' and domain_name = 'fils_nonneg'
    order by ordinal_position
  `
  const [row] = await sql<{ doc: Record<string, string> }[]>`
    select to_jsonb(i) as doc from invoice i where i.display_number = ${displayNumber}
  `
  const amounts: Record<string, number> = {}
  for (const { column_name } of columns) amounts[column_name] = Number(row?.doc[column_name])
  return amounts
}

describe('the two-lines-at-11-fils document, derived by core and stored by db', () => {
  it('stores the summed 2, and the re-derived 1 is on no column of the document', async () => {
    const { input, tax } = elevenFils()
    const issued = await issue(input)

    // Stored equals derived, figure for figure — not stored equals a literal somebody typed twice.
    expect(issued.vatTotalFils).toBe(tax.vat.fils)
    expect(issued.netTotalFils).toBe(tax.net.fils)
    expect(issued.grossTotalFils).toBe(tax.gross.fils)
    expect(issued.vatTotalFils).toBe(ELEVEN_FILS_EXPECTED.documentVatFils)

    const reDerived = vatIfReDerivedFromTotal(tax.gross).fils
    expect(reDerived).toBe(ELEVEN_FILS_EXPECTED.reDerivedVatFils)
    expect(reDerived).not.toBe(tax.vat.fils)

    // The assertion the criterion asks for. Every money column of the document is read, and none of
    // them holds the re-derived figure: a stored vat_total of 2 beside a column yielding 1 is the
    // defect, and a test that only read vat_total could not see it.
    const amounts = await headerAmounts(issued.displayNumber)
    expect(amounts).toEqual({ net_total: 20, vat_total: 2, gross_total: 22 })
    expect(Object.values(amounts)).not.toContain(reDerived)

    // The control for the scan itself: it finds the value when the value is there. 1 IS on the lines,
    // legitimately, because 1 fils is each line's own VAT — which is why the scan is scoped to the
    // header rather than to the document as a whole.
    const lineVat = await sql<{ line_vat_fils: string }[]>`
      select line_vat_fils from invoice_line
      where invoice_id = ${issued.id} order by line_no
    `
    expect(lineVat.map((l) => Number(l.line_vat_fils))).toEqual([1, 1])
  })

  it('round-trips every per-line figure core derived', async () => {
    const { input, tax } = elevenFils()
    const issued = await issue(input)
    const stored = await readInvoiceByDisplayNumber(sql, issued.displayNumber)

    expect(stored?.lines.map((l) => l.netFils)).toEqual(tax.lines.map((l) => l.net.fils))
    expect(stored?.lines.map((l) => l.vatFils)).toEqual(tax.lines.map((l) => l.vat.fils))
    expect(stored?.lines.map((l) => l.lineGrossFils)).toEqual(tax.lines.map((l) => l.gross.fils))
    expect(stored?.lines.map((l) => l.vatRateBp)).toEqual(tax.lines.map((l) => l.rateBp))
    // The control: the stored document is not an empty shell that agrees with everything.
    expect(stored?.lines.length).toBe(2)
    expect(stored?.issuerAddressSnapshot.split('\n')).toEqual(FIXTURE_ISSUER.addressLines)
  })
})

describe('the tax point stored is the one resolveTradingDate resolved', () => {
  it('a 01:30 supply invoiced at noon the next day stores the previous trading date', async () => {
    const { input, taxPoint } = elevenFils()
    const issued = await issue(input)

    expect(taxPoint.taxPointDate).toBe('2026-09-18')
    expect(issued.taxPointDate).toBe(taxPoint.taxPointDate)
    expect(issued.issueDate).toBe('2026-09-19')
    // The claim, on the stored row: a supply on trading day D invoiced on D+1 keeps its tax point at D.
    expect(issued.taxPointDate).not.toBe(issued.issueDate)

    const [row] = await sql<{ tax_point_date: string; issue_date: string }[]>`
      select tax_point_date::text as tax_point_date, issue_date::text as issue_date
      from invoice where id = ${issued.id}
    `
    expect(row?.tax_point_date).toBe('2026-09-18')
    expect(row?.issue_date).toBe('2026-09-19')
  })

  it('the control: a supply and an invoice inside one session store the same date twice', async () => {
    // Without this, a schema that put the calendar date in both columns would fail the case above and a
    // schema that put the PREVIOUS date in both would pass it. Both have to be wrong.
    const sameSession = invoiceFixture({
      supplyAt: instantFromIso('2026-09-18T20:00:00+04:00'),
      issuedAt: instantFromIso('2026-09-18T20:05:00+04:00'),
    })
    const issued = await issue(sameSession.input)
    expect(issued.taxPointDate).toBe('2026-09-18')
    expect(issued.issueDate).toBe('2026-09-18')
  })
})

describe('the seeded placeholder TRN', () => {
  async function seededTrn(): Promise<string | null> {
    const [row] = await sql<{ trn: string | null }[]>`select trn from legal_entity where id = 1`
    return row?.trn ?? null
  }

  it('is the exact string core refuses, so the two cannot drift apart', async () => {
    // A placeholder the validator does not recognise is worse than no placeholder at all, because it
    // reads as configured.
    expect(await seededTrn()).toBe(PLACEHOLDER_TRN)
    expect(() => requireIssuerTrn(PLACEHOLDER_TRN)).toThrow(TrnNotConfigured)
  })

  it('is refused by core before the insert, and by the database if it ever reached one', async () => {
    const seeded = await seededTrn()
    // Layer one: the caller cannot even build the input.
    expect(() =>
      invoiceFixture({
        supplyAt: SUPPLY_AT_0130,
        issuedAt: ISSUED_AT_NOON,
        issuer: { ...FIXTURE_ISSUER, trn: seeded ?? '' },
      }),
    ).toThrow(TrnNotConfigured)

    // Layer two: the CHECK constraint, which holds for a psql session and for any future repository.
    const { input } = elevenFils()
    const forced: IssueInvoiceInput = {
      ...input,
      issuer: { ...input.issuer, trn: seeded ?? '' },
    }
    await expect(issue(forced)).rejects.toThrow(/invoice_issuer_trn_is_fifteen_digits/)
    expect(await readInvoiceByDisplayNumber(sql, 'TI-2026-00001')).toBeNull()
  })

  it('the control: the correct TRN passes both layers and the document issues', async () => {
    // Without this, the two refusals above are indistinguishable from "an invoice never validates",
    // which is exactly the state Y1-trn leaves the system in and the state answering it must end.
    const issued = await issue(elevenFils().input)
    expect(issued.issuerTrn).toBe(FIXTURE_TRN)
    expect(requireIssuerTrn(FIXTURE_TRN)).toBe(FIXTURE_TRN)
    expect(issued.displayNumber).toBe('TI-2026-00001')
  })
})

describe('is_placeholder_text agrees with isPlaceholderText', () => {
  /**
   * Spellings the two implementations must classify identically.
   *
   * The list is deliberately mixed: the seeded TRN, each marker in isolation, a marker inside a longer
   * value, casing and padding variants, and — the half that makes it a test — four values that are not
   * placeholders at all. A comparison over placeholders only would pass for a function that returned
   * true unconditionally.
   */
  const SPELLINGS: readonly string[] = [
    PLACEHOLDER_TRN,
    '[CONFIRM]',
    'Address to be confirmed',
    'TBC',
    '  tbd  ',
    'Pending owner confirmation',
    'placeholder',
    'Not Configured',
    'unknown',
    'TODO: ask the owner',
    'XXX',
    '',
    '   ',
    // Not placeholders. Each is a value a real document carries.
    'BE RELAX SPA - L.L.C - O.P.C',
    '250 Al Meena Street',
    FIXTURE_TRN,
    'Customer 0042',
  ]

  it('classifies every spelling the same way in SQL and in TypeScript', async () => {
    const rows = await sql<{ value: string; flagged: boolean }[]>`
      select v.value, is_placeholder_text(v.value) as flagged
      from unnest(${sql.array(SPELLINGS as string[])}::text[]) as v(value)
    `
    expect(rows.length).toBe(SPELLINGS.length)
    for (const row of rows) {
      expect(row.flagged, `SQL and TypeScript disagree about "${row.value}"`).toBe(
        isPlaceholderText(row.value),
      )
    }

    // The two controls. The list must contain both answers, or "they agree" is satisfied by a pair of
    // functions that always return the same constant.
    const flagged = rows.filter((r) => r.flagged).length
    expect(flagged).toBeGreaterThan(10)
    expect(flagged).toBeLessThan(SPELLINGS.length)
  })

  it('and both say NULL is a placeholder, which is what stops the CHECK passing on a NULL', async () => {
    // is_placeholder_text is deliberately not STRICT: a strict function returns NULL for NULL, a CHECK
    // whose expression is NULL is satisfied, and the constraint would accept the very NULL it refuses.
    const [row] = await sql<{ flagged: boolean | null }[]>`
      select is_placeholder_text(null) as flagged
    `
    expect(row?.flagged).toBe(true)
    expect(isPlaceholderText(null)).toBe(true)
  })
})
