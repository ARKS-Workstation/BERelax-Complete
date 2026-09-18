import {
  buildTaxDocument,
  filsFrom,
  formatAmount,
  formatMoney,
  instantFromIso,
  money,
  PLACEHOLDER_TRN,
  type StoredDocument,
  TrnNotConfigured,
  vatIfReDerivedFromTotal,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  type IssuedInvoice,
  issueInvoice,
  readInvoice,
  type Sql,
  withUnitOfWork,
  Y11_VAT_INVOICE_FIELDS,
} from '@berelax/db'
import { createPdfRenderer, type PdfRenderer, renderTaxDocumentPdf } from '@berelax/pdf'
import { arabicFallbacksFor, extractPdfText, findLine, visualLines } from '@berelax/pdf/testing'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { FIXTURE_TRN, invoiceFixture, TWO_LINES_AT_ELEVEN_FILS } from './invoice.ts'
import { syntheticPerson } from './synthetic.ts'

/**
 * The whole path, end to end: `@berelax/core` derives, `@berelax/db` stores, `@berelax/pdf` prints, and
 * the figures on the paper are the figures in the row.
 *
 * This lives in `packages/fixtures` because it is the one package allowed to depend on `@berelax/db`,
 * `@berelax/core` and `@berelax/pdf` at once — `packages/core` may import `@berelax/shared` and nothing
 * else, and the dependency between core and db runs db to core. Two things can only be proved from here:
 *
 *   1. **`IssuedInvoice` really is a `StoredDocument`.** Core declares the stored shape structurally
 *      rather than importing it, so the assignment below is the only thing keeping the two definitions
 *      from drifting — and it is a type error the day they do, not a runtime surprise.
 *   2. **The document states what the database stored.** Every column in the Y11 superset is looked for
 *      on the rendered page by the value the row actually holds, and the test names the requirement it
 *      could not find. Paired with the control: a figure one fils out is looked for and must be absent.
 *
 * And the question this unit exists to answer honestly: with the real `legal_entity` row as the
 * migration seeds it, which forms can be issued *today*. The answer is asserted rather than asserted
 * about — the TRN is read out of the database, not written into the test.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const TILL: Actor = {
  kind: 'staff',
  id: '44444444-4444-4444-4444-444444444444',
  label: 'Till',
}

/** 01:30 on the 19th is inside the 18th's 11:00-02:00 session, so the tax point is the 18th. */
const SUPPLY_AT_0130 = instantFromIso('2026-09-19T01:30:00+04:00')
/** The invoice is written the next day, at noon. */
const ISSUED_AT_NOON = instantFromIso('2026-09-19T12:00:00+04:00')

/** Customer 0042, whose number is on the unallocated 059 prefix and cannot reach a handset. */
const PERSON = syntheticPerson(42)

const sql: Sql = createConnection({ url, max: 4 })
let renderer: PdfRenderer
let customerId: string

beforeAll(async () => {
  renderer = await createPdfRenderer()
}, 120_000)

afterAll(async () => {
  // Leave no invoice behind that references this file's customer, and no customer behind either.
  // `invoice.customer_id` is ON DELETE RESTRICT, and both `apps/web/src/otp-route.itest.ts` and
  // `customer-identity.itest.ts` clear the table with a bare `delete from customer` in their own setup —
  // so an invoice left pointing at this row would fail THEIR foreign key, in a suite that runs
  // sequentially against one database in an order no file controls. That is hazard 12 in the
  // contributing brief, and it is why the truncate is here as well as in beforeEach: beforeEach leaves
  // the last test's rows standing.
  await sql.unsafe('truncate invoice_line, invoice')
  await sql`delete from customer where phone_e164 = ${PERSON.phone}`
  await renderer?.close()
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
  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PERSON.phone}, 'front_desk')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = customer?.id ?? ''
})

/**
 * Issues one document and reads it back.
 *
 * Read back rather than used as returned: the printed document has to be the row as it will be read in
 * five years' time, not the object the writer happened to build.
 */
async function issueAndRead(
  lines?: readonly { descriptionEn: string; quantity: number; unitGrossFils: number }[],
): Promise<IssuedInvoice> {
  const { input } = invoiceFixture({
    supplyAt: SUPPLY_AT_0130,
    issuedAt: ISSUED_AT_NOON,
    customerId,
    ...(lines === undefined ? {} : { lines }),
  })
  const issued = await withUnitOfWork(sql, TILL, (uow) => issueInvoice(uow, input))
  const stored = await readInvoice(sql, issued.id)
  if (stored === null) throw new Error('the document just issued cannot be read back')
  return stored
}

/** The document, rendered, with its text as displayed and whitespace collapsed. */
async function renderText(
  stored: StoredDocument,
  form: 'tax_invoice' | 'receipt',
): Promise<string> {
  const bytes = await renderTaxDocumentPdf(renderer, {
    stored,
    form,
    locale: 'en',
    arabic: arabicFallbacksFor(stored),
  })
  const pages = await extractPdfText(bytes)
  return visualLines(pages).join(' ').replace(/\s+/g, ' ')
}

describe('the stored shape and the printed shape are the same shape', () => {
  it('an IssuedInvoice is a StoredDocument, which is a compile-time claim', async () => {
    const issued = await issueAndRead()
    // The assignment IS the assertion: `@berelax/core` declares StoredDocument structurally so that it
    // can stay pure, and this line is what makes that safe. Remove a column from one side and this file
    // stops compiling.
    const stored: StoredDocument = issued
    expect(stored.displayNumber).toBe(issued.displayNumber)
    expect(stored.lines.length).toBe(issued.lines.length)
    // And the view built from it carries the stored figures unchanged, not re-derived ones.
    const view = buildTaxDocument(stored, { form: 'tax_invoice' })
    expect(view.totals.net.fils).toBe(issued.netTotalFils)
    expect(view.totals.vat.fils).toBe(issued.vatTotalFils)
    expect(view.totals.gross.fils).toBe(issued.grossTotalFils)
    expect(view.lines.map((line) => line.vat.fils)).toEqual(issued.lines.map((l) => l.vatFils))
  })
})

/**
 * The printed representation of one stored column.
 *
 * Money columns are printed as bare grouped figures in the table and with `AED` in the totals block, so
 * both spellings are accepted for an amount; everything else is printed as stored.
 */
function printedFor(field: { table: string; column: string }, stored: IssuedInvoice): string[] {
  const amount = (fils: number) => [
    formatAmount(money(filsFrom(fils))),
    formatMoney(money(filsFrom(fils))),
  ]
  const firstLine = stored.lines[0]
  if (firstLine === undefined) throw new Error('the stored document has no lines')
  switch (`${field.table}.${field.column}`) {
    case 'invoice.document_kind':
      // The words identifying the document, which is the title rather than the enum value.
      return ['Tax Invoice']
    case 'invoice.issuer_legal_name':
      return [stored.issuerLegalName]
    case 'invoice.issuer_trading_name':
      return [stored.issuerTradingName]
    case 'invoice.issuer_address_snapshot':
      return stored.issuerAddressSnapshot.split('\n')
    case 'invoice.issuer_emirate':
      return [stored.issuerEmirate]
    case 'invoice.issuer_trn':
      return [stored.issuerTrn]
    case 'invoice.number':
      // Printed inside the display number, which is the string a customer quotes.
      return [String(stored.number).padStart(5, '0')]
    case 'invoice.display_number':
      return [stored.displayNumber]
    case 'invoice.series_code':
      return [stored.seriesCode]
    case 'invoice.period_key':
      return [stored.periodKey]
    case 'invoice.issue_date':
      return [stored.issueDate]
    case 'invoice.tax_point_date':
      return [stored.taxPointDate]
    case 'invoice.customer_name_snapshot':
      return [stored.customerNameSnapshot]
    case 'invoice.currency':
      return [stored.currency]
    case 'invoice.net_total':
      return amount(stored.netTotalFils)
    case 'invoice.vat_total':
      return amount(stored.vatTotalFils)
    case 'invoice.gross_total':
      return amount(stored.grossTotalFils)
    case 'invoice_line.description_en':
      // Word by word: the name is longer than its column and wraps, and where the column broke it is
      // not a fact about the document.
      return firstLine.descriptionEn.split(' ').filter((word) => word.length > 2)
    case 'invoice_line.quantity':
      return [String(firstLine.quantity)]
    case 'invoice_line.unit_gross_fils':
      return amount(firstLine.unitGrossFils)
    case 'invoice_line.line_gross_fils':
      return amount(firstLine.lineGrossFils)
    case 'invoice_line.line_net_fils':
      return amount(firstLine.netFils)
    case 'invoice_line.vat_rate_bp':
      return [`${firstLine.vatRateBp / 100}%`]
    case 'invoice_line.line_vat_fils':
      return amount(firstLine.vatFils)
    default:
      throw new Error(
        `Y11_VAT_INVOICE_FIELDS carries ${field.table}.${field.column}, which this test does not know ` +
          'how to look for on the page. Add it, or the field is not being checked.',
      )
  }
}

describe('acceptance 1 — the rendered tax invoice carries every Y11 field, by name', () => {
  it('states every column the superset enumerates, naming any it cannot find', async () => {
    const stored = await issueAndRead([
      {
        descriptionEn: 'Arabic Hot Oil Balm Massage 90 minutes',
        quantity: 1,
        unitGrossFils: 40_000,
      },
      { descriptionEn: 'Asian Normal Massage 45 minutes', quantity: 2, unitGrossFils: 17_000 },
    ])
    const text = await renderText(stored, 'tax_invoice')

    // Structured, not a formatted string parsed back out of itself: the requirements carry their own
    // brackets and full stops, so picking the column out of a message is how a genuinely missing field
    // would get misfiled as an amount-spelling miss and the test would pass.
    const missing: { requirement: string; column: string; needle: string }[] = []
    for (const field of Y11_VAT_INVOICE_FIELDS) {
      for (const needle of printedFor(field, stored)) {
        if (!text.toLowerCase().includes(needle.toLowerCase())) {
          missing.push({ requirement: field.requirement, column: field.column, needle })
        }
      }
    }

    // An amount contributes two acceptable spellings — the bare figure the table prints and the one the
    // totals block prints with the currency code — so one of the two missing is expected and both
    // missing is the failure.
    const amountColumns = [
      'net_total',
      'vat_total',
      'gross_total',
      'unit_gross_fils',
      'line_gross_fils',
      'line_net_fils',
      'line_vat_fils',
    ]
    const describe = (entry: (typeof missing)[number]) =>
      `${entry.requirement} (${entry.column}): ${entry.needle}`
    expect(
      missing
        .filter((entry) => !amountColumns.includes(entry.column))
        .map(describe)
        .join('\n'),
    ).toBe('')
    for (const column of amountColumns) {
      const both = missing.filter((entry) => entry.column === column)
      expect(
        both.length,
        `${column} appears on the page in neither spelling: ${both.map(describe).join(', ')}`,
      ).toBeLessThan(2)
    }
    // The control on the accounting itself: something was actually looked for. A Y11 column this test
    // does not know how to look for throws from printedFor(), so the count is the whole superset.
    expect(Y11_VAT_INVOICE_FIELDS.length).toBeGreaterThan(20)
  }, 120_000)

  it('the control — a figure one fils out is not on the page', async () => {
    const stored = await issueAndRead()
    const text = await renderText(stored, 'tax_invoice')
    expect(text).toContain(formatAmount(money(filsFrom(stored.grossTotalFils))))
    expect(text).not.toContain(formatAmount(money(filsFrom(stored.grossTotalFils + 1))))
    expect(text).not.toContain(formatAmount(money(filsFrom(stored.grossTotalFils - 1))))
  }, 120_000)

  it('prints the summed VAT of the stored eleven-fils document, not the re-derived one', async () => {
    const stored = await issueAndRead(TWO_LINES_AT_ELEVEN_FILS)
    expect(stored.vatTotalFils).toBe(2)
    const text = await renderText(stored, 'tax_invoice')
    const summed = formatMoney(money(filsFrom(stored.vatTotalFils)))
    const reDerived = formatMoney(vatIfReDerivedFromTotal(money(filsFrom(stored.grossTotalFils))))
    expect(text.replace(/\u00a0/g, ' ')).toContain(summed.replace(/\u00a0/g, ' '))
    expect(text.replace(/\u00a0/g, ' ')).not.toContain(reDerived.replace(/\u00a0/g, ' '))
    // The control: the re-derived figure's digits ARE on the page, twice, as each line's own VAT — so
    // the scan is distinguishing where they legitimately appear rather than failing to find them.
    expect(text.split(formatAmount(money(filsFrom(1)))).length - 1).toBe(2)
  }, 120_000)
})

describe('which forms the real business profile can issue today', () => {
  async function seededIssuer(): Promise<StoredDocument> {
    const [row] = await sql<
      { legal_name: string; trading_name: string; trn: string | null; emirate: string }[]
    >`select legal_name, trading_name, trn, emirate from legal_entity where id = 1`
    if (row === undefined) throw new Error('legal_entity has no row')
    const stored = await issueAndRead()
    // The issuer as the database actually holds it — read, not written into the test. Everything else is
    // a document that really was issued.
    return {
      ...stored,
      issuerLegalName: row.legal_name,
      issuerTradingName: row.trading_name,
      issuerTrn: row.trn ?? '',
      issuerEmirate: row.emirate,
    }
  }

  it('the seeded TRN is the placeholder, so neither invoice form can be issued', async () => {
    const stored = await seededIssuer()
    expect(stored.issuerTrn).toBe(PLACEHOLDER_TRN)
    for (const form of ['tax_invoice', 'simplified_invoice'] as const) {
      expect(() => buildTaxDocument(stored, { form })).toThrow(TrnNotConfigured)
    }
  }, 120_000)

  it('the receipt can be, because it states no TRN — and the page proves it does not', async () => {
    const stored = await seededIssuer()
    const text = await renderText(stored, 'receipt')
    expect(text).toContain(stored.issuerTradingName)
    expect(text).toContain('It is not a tax invoice')
    expect(text).not.toContain(PLACEHOLDER_TRN)
    // Not merely absent because the string is odd-looking: the label is absent too, so there is no TRN
    // field on the document at all.
    expect(text).not.toContain('TRN')
  }, 120_000)

  it('and the same row with a real TRN issues the full form — what Y1-trn unblocks', async () => {
    // The fixture TRN rather than a second invented number: packages/fixtures flags exactly one, and
    // only legal_entity.trn reaches a real document.
    const stored = await seededIssuer()
    const configured: StoredDocument = { ...stored, issuerTrn: FIXTURE_TRN }
    expect(() => buildTaxDocument(configured, { form: 'tax_invoice' })).not.toThrow()
    const text = await renderText(configured, 'tax_invoice')
    expect(text).toContain(FIXTURE_TRN)
  }, 120_000)
})

describe('the stored document and the printed document agree line for line', () => {
  it('every line prints its own stored net, VAT and gross on one row', async () => {
    const stored = await issueAndRead([
      { descriptionEn: 'Probe one', quantity: 1, unitGrossFils: 40_000 },
      { descriptionEn: 'Probe two', quantity: 3, unitGrossFils: 11 },
    ])
    const bytes = await renderTaxDocumentPdf(renderer, {
      stored,
      form: 'tax_invoice',
      locale: 'en',
      arabic: arabicFallbacksFor(stored),
    })
    const pages = await extractPdfText(bytes)
    for (const line of stored.lines) {
      const row = findLine(pages, formatAmount(money(filsFrom(line.lineGrossFils))))
      expect(row, `no row carrying line ${line.lineNo}`).toBeDefined()
      const visual = (row?.visual ?? '').replace(/\u00a0/g, ' ')
      expect(visual).toContain(formatAmount(money(filsFrom(line.netFils))))
      expect(visual).toContain(formatAmount(money(filsFrom(line.vatFils))))
      expect(visual).toContain(String(line.quantity))
    }
    // The three-at-11-fils line: 33 gross carrying 2 fils of VAT, rounded on the LINE gross. Rounding
    // per unit would claim 3, and that figure must be nowhere near this document.
    const threeAtEleven = stored.lines.find((line) => line.quantity === 3)
    expect(threeAtEleven?.vatFils).toBe(2)
  }, 120_000)
})
