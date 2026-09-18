import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  INVOICE_SQLSTATE,
  type IssueInvoiceInput,
  invoiceError,
  isInvoiceAppendOnly,
  isInvoiceTotalsDisagreement,
  issueInvoice,
  readInvoice,
  readInvoiceByDisplayNumber,
  Y11_VAT_INVOICE_FIELDS,
} from './invoice.ts'
import { findNumberingGaps } from './numbering.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The invoice document, against a real PostgreSQL.
 *
 * Everything asserted here is a database rule: grants, refusal triggers, a deferred constraint
 * trigger, four CHECKs and two UNIQUEs. None of them can be tested against a mock, and each of them is
 * only a rule once something has been seen to bounce off it — so every probe asserts the SQLSTATE or
 * the named constraint, never "an error was raised" (ADR 0003).
 *
 * `packages/db` may not import `packages/core`, so the amounts here are written as integers with the
 * arithmetic spelled out in a comment. The pair — core deriving and this repository storing — is
 * exercised in `packages/fixtures/src/invoice-document.itest.ts`, which is the package allowed to
 * depend on both.
 */

/** Fifteen digits. A test value: the real TRN is unknown (Y1-trn) and the placeholder is refused. */
const TEST_TRN = '100123456700003'
/** A UAE mobile prefix that is not allocated, so the number cannot ring anybody. */
const SYNTHETIC_PHONE = '+971590000042'

const TILL: Actor = {
  kind: 'staff',
  id: '44444444-4444-4444-4444-444444444444',
  label: 'Till',
}

const ISSUER = {
  legalName: 'BE RELAX SPA - L.L.C - O.P.C',
  tradingName: 'BE RELAX - Massage Center and Spa',
  trn: TEST_TRN,
  addressSnapshot: '250 Al Meena Street\nTower Block A/B, M-Floor\nAl Zahiyah, Abu Dhabi',
  emirate: 'Abu Dhabi',
} as const

/** A supply on the 18th, invoiced on the 19th. The dates are three different facts. */
const TAX_POINT = '2026-09-18'
const ISSUE_DATE = '2026-09-19'

/**
 * Two lines at 11 fils gross. Per line: net 10, VAT 1, because 11 - round(11 * 20 / 21) = 11 - 10 = 1.
 * The document therefore carries VAT of **2**. Splitting the 22-fils total gives 22 - round(22 * 20 /
 * 21) = 22 - 21 = **1**, which is the number that must appear nowhere on the header.
 */
const ELEVEN_FILS_VAT_PER_LINE = 1
const ELEVEN_FILS_DOCUMENT_VAT = 2
const ELEVEN_FILS_RE_DERIVED_VAT = 1

function twoElevens(overrides: Partial<IssueInvoiceInput> = {}): IssueInvoiceInput {
  return {
    documentKind: 'tax_invoice',
    seriesCode: 'TAX-INV',
    issuer: ISSUER,
    customer: { nameSnapshot: 'Customer 0042' },
    issueDate: ISSUE_DATE,
    issueTradingDate: ISSUE_DATE,
    taxPointDate: TAX_POINT,
    lines: [
      {
        descriptionEn: 'Asian Normal Massage, 60 minutes',
        quantity: 1,
        unitGrossFils: 11,
        vatRateBp: 500,
        netFils: 10,
        vatFils: ELEVEN_FILS_VAT_PER_LINE,
      },
      {
        descriptionEn: 'Asian Normal Massage, 60 minutes',
        quantity: 1,
        unitGrossFils: 11,
        vatRateBp: 500,
        netFils: 10,
        vatFils: ELEVEN_FILS_VAT_PER_LINE,
      },
    ],
    netTotalFils: 20,
    vatTotalFils: ELEVEN_FILS_DOCUMENT_VAT,
    grossTotalFils: 22,
    ...overrides,
  }
}

/** A scratch schema for the known-bad shape this unit refused, so the probes can be seen to fire. */
const SCRATCH = 'invoice_itest'

let sql: Sql
let testStartedAt: Date

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })
  await sql.unsafe(`drop schema if exists ${SCRATCH} cascade`)
  await sql.unsafe(`create schema ${SCRATCH}`)
  // The defect this unit exists to prevent, built deliberately: a document whose VAT is a GENERATED
  // column re-deriving from the document total. The scans below are run against it as their control,
  // because a scan that has stopped looking reports a clean invoice table for ever.
  await sql.unsafe(`
    create table ${SCRATCH}.rederiving_document (
      display_number text primary key,
      net_total   fils_nonneg not null,
      gross_total fils_nonneg not null,
      vat_total   fils_nonneg not null
        generated always as (gross_total - round(gross_total * 20.0 / 21.0)::bigint) stored
    )
  `)
})

afterAll(async () => {
  await sql?.unsafe(`drop schema if exists ${SCRATCH} cascade`)
  await sql?.end({ timeout: 5 })
})

/**
 * Empties the two tables and puts the series counters back.
 *
 * `truncate` as the OWNER, which is the one statement that fires no row-level DELETE trigger — the
 * same reason `journal.itest.ts` resets this way. `berelax_app` holds no TRUNCATE at all, which is
 * asserted below, so this is not a hole in the append-only guarantee; it is the test credential doing
 * something the application cannot.
 */
beforeEach(async () => {
  await sql.unsafe('truncate invoice_line, invoice')
  await sql`
    update document_series
       set next_number = 1, period_key = '', prefix = 'TI-', padding = 5, reset_policy = 'annual'
     where code = 'TAX-INV'
  `
  await sql`delete from customer where phone_e164 = ${SYNTHETIC_PHONE}`
  testStartedAt = new Date()
})

/** The SQLSTATE of a rejected promise, or undefined. Never "an error was raised". */
async function stateOf(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string }> {
  try {
    await promise
    return { code: undefined, message: 'the statement succeeded' }
  } catch (err) {
    const direct = (err as { code?: unknown }).code
    const translated = (err as { details?: { sqlState?: unknown } }).details?.sqlState
    const code = typeof direct === 'string' ? direct : translated
    return {
      code: typeof code === 'string' ? code : undefined,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

const issue = (input: IssueInvoiceInput) =>
  withUnitOfWork(sql, TILL, (uow) => issueInvoice(uow, input))

/** Runs `body` as the application role, in its own transaction. */
async function asApplicationRole<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`set local role berelax_app`
    return body(tx as unknown as Sql)
  }) as Promise<T>
}

describe('issuing', () => {
  it('allocates the number inside the document transaction and stores it unchanged', async () => {
    const issued = await issue(twoElevens())
    expect(issued.number).toBe(1)
    expect(issued.displayNumber).toBe('TI-2026-00001')
    expect(issued.periodKey).toBe('2026')
    expect(issued.lines.map((l) => l.lineNo)).toEqual([1, 2])
    // The line total is generated by the database, so the caller never supplied it and cannot
    // disagree with it.
    expect(issued.lines.map((l) => l.lineGrossFils)).toEqual([11, 11])

    const stored = await readInvoice(sql, issued.id)
    expect(stored?.displayNumber).toBe('TI-2026-00001')
    expect(stored?.currency).toBe('AED')
    // Control: a document that was never issued reads back as null rather than an empty shape, so the
    // assertions above cannot be passing against something fabricated.
    expect(await readInvoice(sql, '00000000-0000-7000-8000-000000000000')).toBeNull()
    expect(await readInvoiceByDisplayNumber(sql, 'TI-2026-09999')).toBeNull()
    expect((await readInvoiceByDisplayNumber(sql, 'TI-2026-00001'))?.id).toBe(issued.id)
  })

  it('consumes no number when the document transaction rolls back', async () => {
    // M-TILL-03's claim, now provable against the real table: the allocation is inside the insert
    // transaction, so a failure returns the number to the pool instead of leaving a hole.
    await expect(
      withUnitOfWork(sql, TILL, async (uow) => {
        await issueInvoice(uow, twoElevens())
        throw new Error('the card was declined')
      }),
    ).rejects.toThrow(/card was declined/)

    const [series] = await sql<{ next_number: string }[]>`
      select next_number from document_series where code = 'TAX-INV'
    `
    expect(Number(series?.next_number)).toBe(1)
    expect(await readInvoiceByDisplayNumber(sql, 'TI-2026-00001')).toBeNull()

    // The control: the next issue takes number 1, which is only true if the rollback released it.
    const issued = await issue(twoElevens())
    expect(issued.displayNumber).toBe('TI-2026-00001')
  })

  it('writes an audit row per issue, counted as a delta', async () => {
    const issued = await issue(twoElevens())
    const [row] = await sql<{ n: string; operation: string }[]>`
      select count(*)::text as n, min(operation) as operation from audit_event
      where entity_type = 'invoice' and entity_id = ${issued.id}
        and occurred_at >= ${testStartedAt}
    `
    // A delta from a timestamp taken in beforeEach, never a total: audit_event is append-only, so a
    // total would differ on every re-run.
    expect(Number(row?.n)).toBe(1)
    expect(row?.operation).toBe('create')

    // The control: an id nothing was issued under has no audit row, so the count is counting.
    const [none] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
      where entity_type = 'invoice' and entity_id = '00000000-0000-7000-8000-000000000000'
    `
    expect(Number(none?.n)).toBe(0)
  })

  it('refuses a document with no lines before it allocates a number', async () => {
    await expect(issue(twoElevens({ lines: [] }))).rejects.toThrow(/at least one line/)
    const [series] = await sql<{ next_number: string }[]>`
      select next_number from document_series where code = 'TAX-INV'
    `
    expect(Number(series?.next_number)).toBe(1)
  })

  it('refuses a tax invoice numbered out of the credit-note series', async () => {
    // The composite foreign key to document_series (code, document_kind). Without it a credit note
    // could be numbered out of TAX-INV, and the range a VAT return reads would hold two kinds of
    // document.
    const failure = await stateOf(issue(twoElevens({ seriesCode: 'CR-NOTE' })))
    expect(failure.code).toBe('23503')
    expect(failure.message).toContain('invoice_series_kind_fk')
  })

  it('the numbering gap report runs against the real table and finds nothing', async () => {
    // M-TILL-03 parameterised findNumberingGaps by relation because no document table existed yet.
    // This is that table.
    for (let i = 0; i < 5; i += 1) await issue(twoElevens())
    expect(await findNumberingGaps(sql, 'invoice')).toEqual([])

    // The control, and the reason the empty result above means anything: the report DOES report a
    // hole. Number 3 is removed with BOTH refusal triggers disabled — which only the owner can do —
    // inside a transaction that is then rolled back, so the invoice range is intact afterwards and the
    // triggers are re-enabled by the rollback rather than by a statement that could be forgotten.
    let gaps: readonly { missingBefore: number }[] = []
    const rollback = new Error('rollback the gap probe')
    await sql
      .begin(async (tx) => {
        await tx`alter table invoice disable trigger invoice_no_delete`
        await tx`alter table invoice_line disable trigger invoice_line_no_delete`
        await tx`delete from invoice_line where invoice_id in (select id from invoice where number = 3)`
        await tx`delete from invoice where number = 3`
        gaps = await findNumberingGaps(tx as unknown as Sql, 'invoice')
        throw rollback
      })
      .catch((err) => {
        if (err !== rollback) throw err
      })
    expect(gaps.map((g) => g.missingBefore)).toEqual([1])

    // And afterwards: five documents, no gap, and the triggers still refuse.
    expect(await findNumberingGaps(sql, 'invoice')).toEqual([])
    expect((await stateOf(sql`delete from invoice where number = 3`)).code).toBe(
      INVOICE_SQLSTATE.appendOnly,
    )
  })
})

describe('the document total is the sum of its lines', () => {
  /** Every money column of the header, by name: the `fils_nonneg` domain is what marks one. */
  async function headerMoneyColumns(
    relation: string,
    displayNumber: string,
  ): Promise<Record<string, number>> {
    const [schema, table] = relation.includes('.')
      ? relation.split('.')
      : (['public', relation] as const)
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${schema ?? 'public'} and table_name = ${table ?? ''}
        and domain_name = 'fils_nonneg'
      order by ordinal_position
    `
    const [row] = await sql<{ doc: Record<string, string> }[]>`
      select to_jsonb(t) as doc from ${sql(relation)} t where t.display_number = ${displayNumber}
    `
    const found: Record<string, number> = {}
    for (const { column_name } of columns) {
      found[column_name] = Number(row?.doc[column_name])
    }
    return found
  }

  /** Generated columns whose expression mentions the document total. */
  async function generatedFromTotal(relation: string): Promise<readonly string[]> {
    const [schema, table] = relation.includes('.')
      ? relation.split('.')
      : (['public', relation] as const)
    const rows = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${schema ?? 'public'} and table_name = ${table ?? ''}
        and is_generated = 'ALWAYS'
        and generation_expression ilike '%gross_total%'
    `
    return rows.map((r) => r.column_name)
  }

  it('stores 2 for two lines at 11 fils, and the re-derived 1 is nowhere on the document', async () => {
    const issued = await issue(twoElevens())
    expect(issued.vatTotalFils).toBe(ELEVEN_FILS_DOCUMENT_VAT)

    const money = await headerMoneyColumns('invoice', issued.displayNumber)
    expect(money).toEqual({ net_total: 20, vat_total: 2, gross_total: 22 })

    // The assertion the criterion actually asks for. A stored vat_total of 2 beside a column that
    // yields 1 is the defect, and it is invisible to a test that only reads vat_total — so every money
    // column of the document is read and none of them may hold the re-derived figure.
    expect(Object.values(money)).not.toContain(ELEVEN_FILS_RE_DERIVED_VAT)
    expect(await generatedFromTotal('invoice')).toEqual([])

    // The lines legitimately carry 1 each — that IS the per-line VAT — which is why the scan is
    // scoped to the header.
    expect(issued.lines.map((l) => l.vatFils)).toEqual([1, 1])
  })

  it('the control: both scans DO fire against a document that re-derives', async () => {
    // Without this, a `domain_name` filter that matched nothing and an `ilike` that matched nothing
    // would satisfy the case above for ever while examining no columns at all (ADR 0003).
    await sql.unsafe(`
      insert into ${SCRATCH}.rederiving_document (display_number, net_total, gross_total)
      values ('RD-00001', 20, 22)
    `)
    const money = await headerMoneyColumns(`${SCRATCH}.rederiving_document`, 'RD-00001')
    expect(money['vat_total']).toBe(ELEVEN_FILS_RE_DERIVED_VAT)
    expect(Object.values(money)).toContain(ELEVEN_FILS_RE_DERIVED_VAT)
    expect(await generatedFromTotal(`${SCRATCH}.rederiving_document`)).toEqual(['vat_total'])
  })

  it('rejects a header whose VAT was re-derived, at COMMIT and not before', async () => {
    const failure = await stateOf(
      sql.begin(async (tx) => {
        // The header states 1 — the figure a re-derivation from the 22-fils total produces.
        const [row] = await tx<{ id: string }[]>`
          insert into invoice (
            document_kind, series_code, period_key, number, display_number,
            issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot,
            issuer_emirate, customer_name_snapshot, issue_date, tax_point_date,
            net_total, vat_total, gross_total
          ) values (
            'tax_invoice', 'TAX-INV', '2026', 1, 'TI-2026-00001',
            ${ISSUER.legalName}, ${ISSUER.tradingName}, ${TEST_TRN}, ${ISSUER.addressSnapshot},
            'Abu Dhabi', 'Customer 0042', ${ISSUE_DATE}::date, ${TAX_POINT}::date,
            21, ${ELEVEN_FILS_RE_DERIVED_VAT}, 22
          ) returning id
        `
        const id = row?.id ?? ''
        // Each insert SUCCEEDS. That is the shape being proved: an immediate trigger would have
        // rejected the header before its lines existed, which is every invoice ever issued.
        for (const lineNo of [1, 2]) {
          await tx`
            insert into invoice_line (
              invoice_id, line_no, description_en, quantity, unit_gross_fils, vat_rate_bp,
              line_net_fils, line_vat_fils
            ) values (${id}, ${lineNo}, 'Asian Normal Massage', 1, 11, 500, 10, 1)
          `
        }
        const [count] = await tx<{ n: string }[]>`
          select count(*)::text as n from invoice_line where invoice_id = ${id}
        `
        expect(Number(count?.n)).toBe(2)
      }),
    )

    expect(failure.code).toBe(INVOICE_SQLSTATE.totalsDisagree)
    expect(failure.message).toContain('InvoiceTotalsDisagree')
    expect(failure.message).toContain('states vat_total 1 fils')
    expect(failure.message).toContain('sum to 2 fils')
    expect(isInvoiceTotalsDisagreement({ code: failure.code })).toBe(true)
    expect(invoiceError({ code: failure.code })?.kind).toBe('invariant_violated')
    // The control for the classifier: the append-only code is a different failure, and a predicate
    // that returned true for everything would make every catch block treat them the same.
    expect(isInvoiceTotalsDisagreement({ code: INVOICE_SQLSTATE.appendOnly })).toBe(false)
    expect(invoiceError({ code: '42P01' })).toBeNull()

    // Nothing committed, so the re-derived document does not exist.
    expect(await readInvoiceByDisplayNumber(sql, 'TI-2026-00001')).toBeNull()
  })

  it('rejects a document committed with no lines', async () => {
    const failure = await stateOf(
      sql`
        insert into invoice (
          document_kind, series_code, period_key, number, display_number,
          issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot,
          issuer_emirate, customer_name_snapshot, issue_date, tax_point_date,
          net_total, vat_total, gross_total
        ) values (
          'tax_invoice', 'TAX-INV', '2026', 7, 'TI-2026-00007',
          ${ISSUER.legalName}, ${ISSUER.tradingName}, ${TEST_TRN}, ${ISSUER.addressSnapshot},
          'Abu Dhabi', 'Customer 0042', ${ISSUE_DATE}::date, ${TAX_POINT}::date, 0, 0, 0
        )
      `,
    )
    expect(failure.code).toBe(INVOICE_SQLSTATE.withoutLines)
    expect(failure.message).toContain('InvoiceWithoutLines')
  })

  it('the control: the correct totals commit', async () => {
    // The three refusals above mean nothing unless the right document is accepted.
    const issued = await issue(twoElevens())
    expect(issued.netTotalFils + issued.vatTotalFils).toBe(issued.grossTotalFils)
  })
})

describe('the issuer snapshot must be real', () => {
  const header = (overrides: Record<string, string | null>) => {
    const values = {
      issuer_legal_name: ISSUER.legalName,
      issuer_trn: TEST_TRN,
      issuer_address_snapshot: ISSUER.addressSnapshot,
      ...overrides,
    }
    return sql`
      insert into invoice (
        document_kind, series_code, period_key, number, display_number,
        issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot,
        issuer_emirate, customer_name_snapshot, issue_date, tax_point_date,
        net_total, vat_total, gross_total
      ) values (
        'tax_invoice', 'TAX-INV', '2026', 11, 'TI-2026-00011',
        ${values.issuer_legal_name}, ${ISSUER.tradingName}, ${values.issuer_trn},
        ${values.issuer_address_snapshot},
        'Abu Dhabi', 'Customer 0042', ${ISSUE_DATE}::date, ${TAX_POINT}::date, 20, 2, 22
      )
    `
  }

  const cases: readonly [string, Record<string, string | null>, string][] = [
    [
      'the seeded Y1-trn placeholder',
      { issuer_trn: 'TRN-PENDING-Y1-TRN' },
      'invoice_issuer_trn_is_fifteen_digits',
    ],
    [
      'a TRN that is not fifteen digits',
      { issuer_trn: '12345' },
      'invoice_issuer_trn_is_fifteen_digits',
    ],
    [
      'a placeholder legal name',
      { issuer_legal_name: '[CONFIRM]' },
      'invoice_issuer_name_not_placeholder',
    ],
    ['a blank legal name', { issuer_legal_name: '   ' }, 'invoice_issuer_name_not_placeholder'],
    [
      'a placeholder address',
      { issuer_address_snapshot: 'Address TBC' },
      'invoice_issuer_address_not_placeholder',
    ],
    ['a NULL TRN', { issuer_trn: null }, 'null value in column "issuer_trn"'],
    ['a NULL legal name', { issuer_legal_name: null }, 'null value in column "issuer_legal_name"'],
    [
      'a NULL address',
      { issuer_address_snapshot: null },
      'null value in column "issuer_address_snapshot"',
    ],
  ]

  for (const [what, overrides, rule] of cases) {
    it(`refuses ${what}, by name`, async () => {
      const failure = await stateOf(header(overrides))
      expect(failure.message).toContain(rule)
      // A bare non-zero result is also what a typo in a column name produces, so the SQLSTATE is
      // asserted too: 23514 is a CHECK, 23502 a NOT NULL.
      expect(failure.code).toBe(rule.startsWith('null value') ? '23502' : '23514')
    })
  }

  it('the control: a real name, address and TRN are accepted', async () => {
    // Without this the eight refusals above are indistinguishable from "an invoice never validates",
    // which is the state the placeholder TRN is deliberately in and the state the real one must leave.
    const issued = await issue(twoElevens())
    expect(issued.issuerTrn).toBe(TEST_TRN)
    expect(issued.issuerLegalName).toBe(ISSUER.legalName)
  })

  it('the placeholder TRN is what legal_entity actually holds, so nothing can be issued yet', async () => {
    const [entity] = await sql<{ trn: string | null }[]>`select trn from legal_entity where id = 1`
    expect(entity?.trn).toBe('TRN-PENDING-Y1-TRN')
    // And it is refused if it reaches the document, which is the point of seeding it at all.
    const failure = await stateOf(header({ issuer_trn: entity?.trn ?? null }))
    expect(failure.code).toBe('23514')
  })
})

describe('the tax point is stored separately from the issue date', () => {
  it('a supply on D invoiced on D+1 keeps tax_point_date = D', async () => {
    const issued = await issue(twoElevens())
    expect(issued.taxPointDate).toBe(TAX_POINT)
    expect(issued.issueDate).toBe(ISSUE_DATE)
    // The control: they are genuinely different values, so a schema that stored one date twice would
    // fail here rather than pass both assertions.
    expect(issued.taxPointDate).not.toBe(issued.issueDate)

    const stored = await readInvoice(sql, issued.id)
    expect(stored?.taxPointDate).toBe(TAX_POINT)
    expect(stored?.issueDate).toBe(ISSUE_DATE)
  })

  it('refuses a tax point after the issue date', async () => {
    const failure = await stateOf(
      issue(twoElevens({ issueDate: TAX_POINT, taxPointDate: ISSUE_DATE })),
    )
    expect(failure.code).toBe('23514')
    expect(failure.message).toContain('invoice_tax_point_not_after_issue')
  })

  it('accepts a document raised while the premises was shut, with no trading date of issue', async () => {
    // 10:00 is in the daytime gap, so the invoice belongs to no trading date. Storing the calendar
    // date there instead would put it in a cash-up it was never part of.
    const { issueTradingDate, ...raisedWhileShut } = twoElevens()
    // The base fixture carries one; this case is the same document with the property absent rather
    // than present and undefined, which is the distinction exactOptionalPropertyTypes exists for.
    expect(issueTradingDate).toBe(ISSUE_DATE)
    const issued = await issue(raisedWhileShut)
    expect(issued.issueTradingDate).toBeNull()
    // The number is then allocated against the issue date, which is what keeps allocation moving
    // forward.
    expect(issued.periodKey).toBe('2026')
  })
})

describe('append-only', () => {
  it('UPDATE and DELETE raise ZI003 for the owner, on both tables', async () => {
    const issued = await issue(twoElevens())

    for (const statement of [
      sql`update invoice set notes = 'corrected' where id = ${issued.id}`,
      sql`delete from invoice where id = ${issued.id}`,
      sql`update invoice_line set line_vat_fils = 0 where invoice_id = ${issued.id}`,
      sql`delete from invoice_line where invoice_id = ${issued.id}`,
    ]) {
      const failure = await stateOf(statement)
      expect(failure.code).toBe(INVOICE_SQLSTATE.appendOnly)
      expect(failure.message).toContain('append-only')
      expect(failure.message).toContain('credit note')
      expect(isInvoiceAppendOnly({ code: failure.code })).toBe(true)
      expect(invoiceError({ code: failure.code })?.kind).toBe('forbidden')
    }

    // The document is still there, unchanged: the refusals refused rather than half-applied.
    const stored = await readInvoice(sql, issued.id)
    expect(stored?.notes).toBeNull()
    expect(stored?.lines.map((l) => l.vatFils)).toEqual([1, 1])
  })

  it('the application role is refused by the GRANT, before the trigger is reached', async () => {
    const issued = await issue(twoElevens())
    for (const statement of ['update invoice set notes = $1', 'delete from invoice']) {
      const failure = await stateOf(
        asApplicationRole((tx) => tx.unsafe(statement.replace('$1', `'x'`))),
      )
      // 42501, not ZI003. The privilege layer refuses first, which is why both layers are asserted:
      // the trigger is what protects the owner, and the owner is the role a privilege cannot bind.
      expect(failure.code).toBe('42501')
      expect(invoiceError({ code: failure.code })?.kind).toBe('forbidden')
    }
    expect(await readInvoice(sql, issued.id)).not.toBeNull()

    // The control: the application role CAN append, which is the privilege it is supposed to hold.
    const appended = await asApplicationRole(async (tx) => {
      const rows = await tx<{ display_number: string }[]>`
        insert into invoice (
          document_kind, series_code, period_key, number, display_number,
          issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot,
          issuer_emirate, customer_name_snapshot, issue_date, tax_point_date,
          net_total, vat_total, gross_total
        ) values (
          'tax_invoice', 'TAX-INV', '2026', 99, 'TI-2026-00099',
          ${ISSUER.legalName}, ${ISSUER.tradingName}, ${TEST_TRN}, ${ISSUER.addressSnapshot},
          'Abu Dhabi', 'Customer 0042', ${ISSUE_DATE}::date, ${TAX_POINT}::date, 20, 2, 22
        ) returning display_number
      `
      await tx`
        insert into invoice_line (
          invoice_id, line_no, description_en, quantity, unit_gross_fils, vat_rate_bp,
          line_net_fils, line_vat_fils
        )
        select id, 1, 'Asian Normal Massage', 2, 11, 500, 20, 2 from invoice
        where display_number = 'TI-2026-00099'
      `
      return rows[0]?.display_number
    })
    expect(appended).toBe('TI-2026-00099')
  })

  it('information_schema shows the application role holds SELECT and INSERT and nothing else', async () => {
    const rows = await sql<{ table_name: string; privilege_type: string }[]>`
      select table_name, privilege_type from information_schema.role_table_grants
      where grantee = 'berelax_app' and table_schema = 'public'
        and table_name in ('invoice', 'invoice_line')
      order by table_name, privilege_type
    `
    const held = rows.map((r) => `${r.table_name}.${r.privilege_type}`)
    expect(held.sort()).toEqual([
      'invoice.INSERT',
      'invoice.SELECT',
      'invoice_line.INSERT',
      'invoice_line.SELECT',
    ])

    // The control: the same query DOES find an UPDATE grant where one exists. Without it, a query
    // shape that could never return 'UPDATE' would satisfy the assertion above.
    const mutable = await sql<{ privilege_type: string }[]>`
      select privilege_type from information_schema.role_table_grants
      where grantee = 'berelax_app' and table_schema = 'public' and table_name = 'app_setting'
        and privilege_type = 'UPDATE'
    `
    expect(mutable.map((r) => r.privilege_type)).toEqual(['UPDATE'])
  })

  it('holds no UPDATE on display_number in particular, so no code path can renumber', async () => {
    // M-TILL-03's format-change criterion depends on this: changing a series prefix must not renumber
    // an issued document, and it cannot, because the string is not writable at all.
    const [privileges] = await sql<
      { display_number: boolean; number: boolean; truncate: boolean; select: boolean }[]
    >`
      select has_column_privilege('berelax_app', 'invoice', 'display_number', 'UPDATE') as display_number,
             has_column_privilege('berelax_app', 'invoice', 'number', 'UPDATE') as number,
             has_table_privilege('berelax_app', 'invoice', 'TRUNCATE') as truncate,
             has_column_privilege('berelax_app', 'invoice', 'display_number', 'SELECT') as select
    `
    expect(privileges?.display_number).toBe(false)
    expect(privileges?.number).toBe(false)
    // TRUNCATE is the one statement that fires no row-level DELETE trigger, so the grant is the only
    // layer that can refuse it.
    expect(privileges?.truncate).toBe(false)
    // The control: SELECT on the same column IS held, so the three falses are not a role that cannot
    // see the table at all.
    expect(privileges?.select).toBe(true)
  })

  it('a format change leaves every issued display_number byte-identical', async () => {
    const before = await issue(twoElevens())
    await sql`update document_series set prefix = 'INV/', padding = 8 where code = 'TAX-INV'`
    const after = await readInvoice(sql, before.id)
    expect(after?.displayNumber).toBe('TI-2026-00001')
    // The control: the change did take effect, for the NEXT document.
    const next = await issue(twoElevens())
    expect(next.displayNumber).toBe('INV/2026-00000002')
  })
})

describe('the Y11-vat-invoice superset is applied, not just declared', () => {
  async function missingNotNull(
    fields: readonly { table: string; column: string }[],
  ): Promise<readonly string[]> {
    const problems: string[] = []
    for (const field of fields) {
      const [column] = await sql<{ is_nullable: string }[]>`
        select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = ${field.table}
          and column_name = ${field.column}
      `
      if (!column) problems.push(`${field.table}.${field.column} does not exist`)
      else if (column.is_nullable !== 'NO')
        problems.push(`${field.table}.${field.column} is nullable`)
    }
    return problems
  }

  it('every mandatory field is a NOT NULL column that exists', async () => {
    expect(await missingNotNull(Y11_VAT_INVOICE_FIELDS)).toEqual([])
  })

  it('the control: the same probe reports a missing column and a nullable one', async () => {
    // Without this, a probe whose query returned nothing would report an empty problem list for every
    // field, and the criterion would be satisfied by a table with no columns at all.
    expect(
      await missingNotNull([
        { table: 'invoice', column: 'issuer_vat_number_that_does_not_exist' },
        // Genuinely nullable, and deliberately so: a walk-in consumer has no TRN, and a tax invoice
        // to a consumer is still a tax invoice.
        { table: 'invoice', column: 'customer_trn' },
        { table: 'invoice', column: 'issuer_legal_name_ar' },
      ]),
    ).toEqual([
      'invoice.issuer_vat_number_that_does_not_exist does not exist',
      'invoice.customer_trn is nullable',
      'invoice.issuer_legal_name_ar is nullable',
    ])
  })

  it('the numbering columns are unique in both the ways that matter', async () => {
    const issued = await issue(twoElevens())
    const duplicateNumber = await stateOf(sql`
      insert into invoice (
        document_kind, series_code, period_key, number, display_number,
        issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot,
        issuer_emirate, customer_name_snapshot, issue_date, tax_point_date,
        net_total, vat_total, gross_total
      ) values (
        'tax_invoice', 'TAX-INV', ${issued.periodKey}, ${issued.number}, 'TI-2026-99999',
        ${ISSUER.legalName}, ${ISSUER.tradingName}, ${TEST_TRN}, ${ISSUER.addressSnapshot},
        'Abu Dhabi', 'Customer 0042', ${ISSUE_DATE}::date, ${TAX_POINT}::date, 20, 2, 22
      )
    `)
    expect(duplicateNumber.code).toBe('23505')
    expect(duplicateNumber.message).toContain('invoice_series_period_number_unique')

    const duplicateString = await stateOf(sql`
      insert into invoice (
        document_kind, series_code, period_key, number, display_number,
        issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot,
        issuer_emirate, customer_name_snapshot, issue_date, tax_point_date,
        net_total, vat_total, gross_total
      ) values (
        'tax_invoice', 'TAX-INV', ${issued.periodKey}, 500, ${issued.displayNumber},
        ${ISSUER.legalName}, ${ISSUER.tradingName}, ${TEST_TRN}, ${ISSUER.addressSnapshot},
        'Abu Dhabi', 'Customer 0042', ${ISSUE_DATE}::date, ${TAX_POINT}::date, 20, 2, 22
      )
    `)
    expect(duplicateString.code).toBe('23505')
    expect(duplicateString.message).toContain('invoice_display_number_unique')
    expect(invoiceError({ code: '23505' })?.kind).toBe('conflict')
  })
})

describe('the customer link is provenance, and the financial record outlives it', () => {
  it('refuses to delete a customer who holds an invoice', async () => {
    const [customer] = await sql<{ id: string }[]>`
      insert into customer (phone_e164, display_name, created_via)
      values (${SYNTHETIC_PHONE}, 'Customer 0042', 'front_desk')
      returning id
    `
    const customerId = customer?.id ?? ''
    const issued = await issue(
      twoElevens({ customer: { customerId, nameSnapshot: 'Customer 0042' } }),
    )
    expect(issued.customerId).toBe(customerId)

    const failure = await stateOf(sql`delete from customer where id = ${customerId}`)
    // `on delete restrict`, not `set null`: a five-year financial record outlives an erasure request,
    // which anonymises the CRM identity instead (docs/04 §4). And a cascading SET NULL would be an
    // UPDATE on an append-only table, refused with a message about the wrong thing.
    expect(failure.code).toBe('23503')

    // The control: a customer with no invoice can be deleted, so the refusal is about the invoice.
    const [other] = await sql<{ id: string }[]>`
      insert into customer (phone_e164, created_via) values ('+971590000043', 'front_desk')
      returning id
    `
    await sql`delete from customer where id = ${other?.id ?? ''}`
    const [gone] = await sql<{ n: string }[]>`
      select count(*)::text as n from customer where id = ${other?.id ?? ''}
    `
    expect(Number(gone?.n)).toBe(0)
  })

  it('stores a record label rather than a name, for a document with no customer record', async () => {
    const issued = await issue(twoElevens())
    expect(issued.customerId).toBeNull()
    expect(issued.customerNameSnapshot).toBe('Customer 0042')
  })
})
