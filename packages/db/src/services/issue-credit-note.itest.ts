import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import {
  type IssuedInvoice,
  type IssueInvoiceInput,
  issueInvoice,
} from '../repositories/invoice.ts'
import type { JournalEntryInput } from '../repositories/journal.ts'
import { lockAccountingPeriod, readJournalEntry } from '../repositories/journal.ts'
import { findNumberingGaps } from '../repositories/numbering.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  CREDIT_NOTE_SQLSTATE,
  type CreditNoteLineInput,
  type IssueCreditNoteInput,
  type IssuedCreditNote,
  isCreditNoteAppendOnly,
  isCreditNotePeriodLocked,
  isOverCredited,
  issueCreditNote,
  readCreditNote,
  readCreditNoteByDisplayNumber,
  readCreditNotesForInvoice,
} from './issue-credit-note.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The credit note, against a real PostgreSQL.
 *
 * Everything asserted here is a database rule: grants, refusal triggers, three immediate triggers, four
 * deferred ones, a composite foreign key and three UNIQUEs. None of them can be tested against a mock,
 * and each is only a rule once something has been seen to bounce off it — so every probe asserts the
 * SQLSTATE or the named constraint, never "an error was raised" (ADR 0003).
 *
 * `packages/db` may not import `packages/core`, so every amount here is written as an integer with the
 * arithmetic spelled out in a comment. The pair — core deriving the reversal and this service storing
 * it — is exercised in `packages/fixtures/src/credit-note.itest.ts`, which is the package allowed to
 * depend on both.
 */

/** Fifteen digits. A test value: the real TRN is unknown (Y1-trn) and the placeholder is refused. */
const TEST_TRN = '100123456700003'

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

/**
 * A supply in September, credited in October: two different VAT periods, on purpose.
 *
 * In 2097, and the year is the isolation rather than decoration. `journal.itest.ts` locks and unlocks
 * real periods across 2026 and its `beforeEach` deletes EVERY row of `period_lock`, so whatever its last
 * period-lock case created survives into every file that runs after it — and `repositories` sorts before
 * `services`. A credit note dated in 2026-10 would then be refused by a lock this file never made, in
 * every case at once, with a message about a period no assertion here mentions. That is hazard 12 in the
 * brief: a suite that assumes it is the only writer of a shared table. 2097 is written by nobody.
 */
const SUPPLY_DATE = '2097-09-18'
const CREDIT_DATE = '2097-10-04'

/**
 * Three units at 1000 fils gross: line gross 3000, net = 3000 - round(3000 * 5 / 105) = 3000 - 143 =
 * 2857, VAT 143.
 *
 * A quantity of three rather than one because the cumulative ceiling is about PART of a line: with a
 * quantity of one, "credited more than invoiced" and "credited twice" are the same statement and the
 * partial case could not be written at all.
 */
const QUANTITY = 3
const UNIT_GROSS = 1000
const RATE_BP = 500
const LINE_GROSS = 3000
const LINE_NET = 2857
const LINE_VAT = 143

/** One of the three units: 1000 gross, net = 1000 - round(1000 * 5 / 105) = 1000 - 48 = 952, VAT 48. */
const ONE_UNIT_GROSS = 1000
const ONE_UNIT_NET = 952
const ONE_UNIT_VAT = 48

/** Entry ids have to be unique across the whole append-only journal, which nobody truncates here. */
const RUN = `cn-itest-${Date.now()}`
let entrySeq = 0
function nextEntryId(): string {
  entrySeq += 1
  return `${RUN}-${entrySeq}`
}

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })
})

afterAll(async () => {
  await sql?.unsafe(`delete from period_lock where reason like '${RUN}%'`)
  await sql?.end({ timeout: 5 })
})

/**
 * Empties the document tables and puts the series counters back.
 *
 * `truncate` as the OWNER, which is the one statement that fires no row-level DELETE trigger —
 * `berelax_app` holds no TRUNCATE at all, which is asserted below, so this is the test credential doing
 * something the application cannot.
 *
 * Every table that references another in the list is NAMED, because PostgreSQL refuses a truncate while
 * a referencing table is missing from the statement. `credit_note_line` and `credit_note` come first,
 * and `refund` is here because `refund.credit_note_id` became a real foreign key in 0072 — which is the
 * reference 0068 deferred to this unit. `invoice` itself carries no incoming key FROM `credit_note`
 * (0072's header says why), so the invoice half of this list is unchanged from what 0068 left.
 */
/**
 * The truncate above, named so the table list is stated ONCE.
 *
 * The outbox-collision case below reproduces what `beforeEach` does between tests, and a second copy of
 * this list is exactly the defect the comment above warns about: the next table to reference one of
 * these would be added to one copy and missed in the other.
 */
const truncateDocuments = () =>
  sql.unsafe(
    'truncate credit_note_line, credit_note, refund, checkout_finalisation, payment, ' +
      'invoice_appointment, invoice_line, invoice',
  )

beforeEach(async () => {
  await truncateDocuments()
  await sql`
    update document_series set next_number = 1, period_key = ''
     where code in ('TAX-INV', 'CR-NOTE')
  `
  // Every lock this file's YEAR could contain, not only the ones it made. A lock left behind by an
  // earlier file in the same run — `journal.itest.ts` leaves whatever its last period-lock case created —
  // would refuse every credit note below with a message about a period nothing here mentions. Scoped to
  // 2097 so it cannot remove a lock another suite is relying on.
  await sql`delete from period_lock where starts_on >= '2097-01-01' and ends_on <= '2097-12-31'`
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

function invoiceInput(overrides: Partial<IssueInvoiceInput> = {}): IssueInvoiceInput {
  return {
    documentKind: 'tax_invoice',
    seriesCode: 'TAX-INV',
    issuer: ISSUER,
    customer: { nameSnapshot: 'Customer 0042' },
    issueDate: SUPPLY_DATE,
    issueTradingDate: SUPPLY_DATE,
    taxPointDate: SUPPLY_DATE,
    lines: [
      {
        descriptionEn: 'Asian Normal Massage, 60 minutes',
        quantity: QUANTITY,
        unitGrossFils: UNIT_GROSS,
        vatRateBp: RATE_BP,
        netFils: LINE_NET,
        vatFils: LINE_VAT,
      },
    ],
    netTotalFils: LINE_NET,
    vatTotalFils: LINE_VAT,
    grossTotalFils: LINE_GROSS,
    ...overrides,
  }
}

async function issueTestInvoice(
  overrides: Partial<IssueInvoiceInput> = {},
): Promise<IssuedInvoice> {
  return withUnitOfWork(sql, TILL, (uow) => issueInvoice(uow, invoiceInput(overrides)))
}

/**
 * A reversal, written out as integers.
 *
 * Dr 4010 the net credited, Dr 2030 the VAT credited, Cr 1050 the gross. This is what
 * `creditNoteReversal` in `@berelax/core` builds for a document with one revenue account; it is spelled
 * out here because `packages/db` may not import that module, and the two are held equal in
 * `packages/fixtures/src/credit-note.itest.ts`.
 */
function reversal(options: {
  entryId: string
  entryDate?: string
  source?: string
  netFils: number
  vatFils: number
  grossFils: number
  liabilityFils?: number
  reverses?: string | null
}): JournalEntryInput {
  const lines = [
    { accountCode: '4010', debitFils: options.netFils, creditFils: 0 },
    { accountCode: '2030', debitFils: options.vatFils, creditFils: 0 },
    { accountCode: '1050', debitFils: 0, creditFils: options.liabilityFils ?? options.grossFils },
  ]
  return {
    entryId: options.entryId,
    entryDate: options.entryDate ?? CREDIT_DATE,
    narrative: `Credit note reversal, ${options.grossFils} fils`,
    source: options.source ?? 'reversal',
    reverses: options.reverses ?? null,
    lines,
  }
}

function creditNoteInput(
  invoiceId: string,
  overrides: Partial<IssueCreditNoteInput> = {},
): IssueCreditNoteInput {
  const entryId = nextEntryId()
  const line: CreditNoteLineInput = {
    invoiceLineNo: 1,
    descriptionEn: 'Asian Normal Massage, 60 minutes',
    quantity: QUANTITY,
    unitGrossFils: UNIT_GROSS,
    vatRateBp: RATE_BP,
    netFils: LINE_NET,
    vatFils: LINE_VAT,
  }
  return {
    invoiceId,
    seriesCode: 'CR-NOTE',
    issuer: ISSUER,
    customer: { nameSnapshot: 'Customer 0042' },
    issueDate: CREDIT_DATE,
    issueTradingDate: CREDIT_DATE,
    taxPointDate: CREDIT_DATE,
    reason: 'The therapist delivered the wrong treatment',
    lines: [line],
    netTotalFils: LINE_NET,
    vatTotalFils: LINE_VAT,
    grossTotalFils: LINE_GROSS,
    reversal: reversal({
      entryId,
      netFils: LINE_NET,
      vatFils: LINE_VAT,
      grossFils: LINE_GROSS,
    }),
    ...overrides,
  }
}

/** One unit of the three, so the line keeps two units of headroom under the ceiling. */
function partialNoteInput(
  invoiceId: string,
  overrides: Partial<IssueCreditNoteInput> = {},
): IssueCreditNoteInput {
  const entryId = nextEntryId()
  return creditNoteInput(invoiceId, {
    lines: [
      {
        invoiceLineNo: 1,
        descriptionEn: 'Asian Normal Massage, 60 minutes',
        quantity: 1,
        unitGrossFils: ONE_UNIT_GROSS,
        vatRateBp: RATE_BP,
        netFils: ONE_UNIT_NET,
        vatFils: ONE_UNIT_VAT,
      },
    ],
    netTotalFils: ONE_UNIT_NET,
    vatTotalFils: ONE_UNIT_VAT,
    grossTotalFils: ONE_UNIT_GROSS,
    reversal: reversal({
      entryId,
      netFils: ONE_UNIT_NET,
      vatFils: ONE_UNIT_VAT,
      grossFils: ONE_UNIT_GROSS,
    }),
    ...overrides,
  })
}

async function issueNote(
  input: IssueCreditNoteInput,
  connection: Sql = sql,
): Promise<IssuedCreditNote> {
  return withUnitOfWork(connection, TILL, (uow) => issueCreditNote(uow, input))
}

describe('issuing a credit note', () => {
  it('draws from CR-NOTE, not from the invoice range, and reads back with its lines', async () => {
    const invoice = await issueTestInvoice()
    const note = await issueNote(creditNoteInput(invoice.id))

    expect(invoice.displayNumber).toBe('TI-2097-00001')
    // The credit-note counter is its own: 0013 made it a separate row precisely so 'CN-00042' is the
    // forty-second credit note rather than a number that depends on invoice volume.
    expect(note.displayNumber).toBe('CN-2097-00001')
    expect(note.seriesCode).toBe('CR-NOTE')
    expect(note.number).toBe(1)

    const stored = await readCreditNote(sql, note.id)
    expect(stored?.displayNumber).toBe('CN-2097-00001')
    expect(stored?.grossTotalFils).toBe(LINE_GROSS)
    expect(stored?.lines).toHaveLength(1)
    expect(stored?.lines[0]?.invoiceLineNo).toBe(1)
    expect(stored?.lines[0]?.lineGrossFils).toBe(LINE_GROSS)
    // The control: the same row is found by the identifier printed on the paper, which is UNIQUE.
    const byNumber = await readCreditNoteByDisplayNumber(sql, 'CN-2097-00001')
    expect(byNumber?.id).toBe(note.id)
    expect(await readCreditNoteByDisplayNumber(sql, 'CN-2097-00002')).toBeNull()
  })

  it('snapshots the issuer on the NOTE rather than joining, and carries the same constraints', async () => {
    const invoice = await issueTestInvoice()
    const note = await issueNote(creditNoteInput(invoice.id))
    expect(note.issuerTrn).toBe(TEST_TRN)
    expect(note.issuerLegalName).toBe(ISSUER.legalName)

    // Each refusal by the CHECK that produces it. A placeholder TRN is the value the schema exists to
    // refuse: blank is visibly unanswered and plausible is indistinguishable from configured.
    const placeholder = await stateOf(
      issueNote(
        creditNoteInput(invoice.id, { issuer: { ...ISSUER, legalName: '[confirm] legal name' } }),
      ),
    )
    expect(placeholder.code).toBe('23514')
    expect(placeholder.message).toContain('credit_note_issuer_name_not_placeholder')

    const shortTrn = await stateOf(
      issueNote(creditNoteInput(invoice.id, { issuer: { ...ISSUER, trn: '10012345670000' } })),
    )
    expect(shortTrn.code).toBe('23514')
    expect(shortTrn.message).toContain('credit_note_issuer_trn_is_fifteen_digits')

    const blankCustomer = await stateOf(
      issueNote(creditNoteInput(invoice.id, { customer: { nameSnapshot: '   ' } })),
    )
    expect(blankCustomer.code).toBe('23514')
    expect(blankCustomer.message).toContain('credit_note_customer_name_present')

    const noReason = await stateOf(issueNote(creditNoteInput(invoice.id, { reason: '  ' })))
    expect(noReason.code).toBe('23514')
    expect(noReason.message).toContain('credit_note_reason_present')
  })

  it('cannot be numbered out of the invoice range', async () => {
    const invoice = await issueTestInvoice()
    // `credit_note_series_kind_fk` is 0026's composite key pointed the other way: the series must exist
    // AND be a series for credit notes.
    const wrongSeries = await stateOf(
      issueNote(creditNoteInput(invoice.id, { seriesCode: 'TAX-INV' })),
    )
    expect(wrongSeries.code).toBe('23503')
    expect(wrongSeries.message).toContain('credit_note_series_kind_fk')
  })

  it('names the invoice it corrects, and refuses one that does not exist', async () => {
    const missing = await stateOf(
      issueNote(creditNoteInput('00000000-0000-4000-8000-000000000001')),
    )
    expect(missing.code).toBe(CREDIT_NOTE_SQLSTATE.withoutInvoice)
    expect(missing.message).toContain('CreditNoteWithoutInvoice')
  })

  it('may not be dated before the supply it corrects', async () => {
    const invoice = await issueTestInvoice()
    const entryId = nextEntryId()
    const backdated = await stateOf(
      issueNote(
        creditNoteInput(invoice.id, {
          issueDate: '2097-09-17',
          issueTradingDate: '2097-09-17',
          taxPointDate: '2097-09-17',
          reversal: reversal({
            entryId,
            entryDate: '2097-09-17',
            netFils: LINE_NET,
            vatFils: LINE_VAT,
            grossFils: LINE_GROSS,
          }),
        }),
      ),
    )
    expect(backdated.code).toBe(CREDIT_NOTE_SQLSTATE.beforeTheSupply)
    expect(backdated.message).toContain('CreditNoteBeforeTheSupply')
  })

  it('appends an event per note even when a counter reset repeats the display number', async () => {
    // The same case `invoice.itest.ts` carries, for the same reason. `beforeEach` truncates
    // `credit_note` and puts BOTH counters back to 1 with an empty period key, so every test here
    // issues `CN-00001`; `outbox_event` is not in that truncate, so until this commit every note after
    // the first to reuse a number collided on `on conflict (idempotency_key) do nothing` and vanished,
    // with `publishEvent` returning null into a call site that discards it.
    const firstInvoice = await issueTestInvoice()
    const first = await issueNote(partialNoteInput(firstInvoice.id))
    await truncateDocuments()
    await sql`
      update document_series set next_number = 1, period_key = ''
       where code in ('TAX-INV', 'CR-NOTE')
    `
    const secondInvoice = await issueTestInvoice()
    const second = await issueNote(partialNoteInput(secondInvoice.id))

    // The control: the collision condition was reproduced. Without it the case passes when the reset
    // quietly failed and the two notes simply carried different numbers.
    expect(
      second.displayNumber,
      'the reset did not repeat the number, so this case proved nothing',
    ).toBe(first.displayNumber)
    expect(second.id).not.toBe(first.id)

    const events = await sql<{ aggregate_id: string }[]>`
      select aggregate_id
        from outbox_event
       where event_type = 'credit_note.issued'
         and aggregate_id = any(${sql.array([first.id, second.id])})
    `
    expect([...events.map((row) => row.aggregate_id)].sort()).toEqual([first.id, second.id].sort())
  })
})

describe('the reversal is dated on the credit note, not on the invoice', () => {
  it('posts in the note’s period when that is a later one', async () => {
    const invoice = await issueTestInvoice()
    const note = await issueNote(creditNoteInput(invoice.id))

    const entry = await readJournalEntry(sql, note.journalEntryId)
    // The acceptance line, asserted on the entry_date and on the period it falls in.
    expect(entry?.entryDate).toBe(CREDIT_DATE)
    expect(entry?.entryDate).not.toBe(invoice.taxPointDate)
    expect(entry?.entryDate.slice(0, 7)).toBe('2097-10')
    expect(invoice.taxPointDate.slice(0, 7)).toBe('2097-09')
    expect(entry?.source).toBe('reversal')

    // The stored note and its entry agree, which is what ZD011 refuses to let drift.
    expect(note.taxPointDate).toBe(entry?.entryDate)
  })

  it('refuses a reversal dated on any other date, classified as anything else, or off by a fils', async () => {
    const invoice = await issueTestInvoice()

    // Each of the three is refused before a statutory number is allocated, which is why the message is
    // the service's rather than ZD011's — and ZD011 checks the same three at COMMIT for the statement
    // that does not come through this module.
    const misdated = await stateOf(
      issueNote(
        creditNoteInput(invoice.id, {
          reversal: reversal({
            entryId: nextEntryId(),
            entryDate: '2097-10-05',
            netFils: LINE_NET,
            vatFils: LINE_VAT,
            grossFils: LINE_GROSS,
          }),
        }),
      ),
    )
    expect(misdated.message).toContain('A correction posts in the period the NOTE falls in')

    const misclassified = await stateOf(
      issueNote(
        creditNoteInput(invoice.id, {
          reversal: reversal({
            entryId: nextEntryId(),
            source: 'adjustment',
            netFils: LINE_NET,
            vatFils: LINE_VAT,
            grossFils: LINE_GROSS,
          }),
        }),
      ),
    )
    expect(misclassified.message).toContain('classified as "adjustment"')

    const wrongAmount = await stateOf(
      issueNote(
        creditNoteInput(invoice.id, {
          reversal: reversal({
            entryId: nextEntryId(),
            netFils: LINE_NET,
            vatFils: LINE_VAT,
            grossFils: LINE_GROSS,
            liabilityFils: LINE_GROSS - 1,
          }),
        }),
      ),
    )
    expect(wrongAmount.message).toContain('two statements of one amount')

    // The control: no number was consumed by any of the three, so the next note is still number 1.
    const note = await issueNote(creditNoteInput(invoice.id))
    expect(note.displayNumber).toBe('CN-2097-00001')
  })

  it('refuses a reversal that reverses another document’s entry', async () => {
    const invoice = await issueTestInvoice()
    // A checkout writes `checkout_finalisation`, and then the invoice HAS an entry for the reversal to
    // name. Written directly here: finalising a checkout is M-TILL-06's service and this probe is about
    // the link, not about the checkout.
    const saleEntry = nextEntryId()
    // One transaction, because 0018's balance check is DEFERRED to COMMIT: a bare `sql\`...\`` commits
    // by itself, so the header would reach that commit with no lines and raise about 0 line(s) rather
    // than setting up anything.
    await sql.begin(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${saleEntry}, ${SUPPLY_DATE}::date, 'The sale', 'sale')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${saleEntry}, 1, '1010', ${LINE_GROSS}, 0),
               (${saleEntry}, 2, '4010', 0, ${LINE_NET}),
               (${saleEntry}, 3, '2030', 0, ${LINE_VAT})
      `
      await tx`
        insert into checkout_finalisation
          (idempotency_key, request_fingerprint, basket_id, invoice_id, journal_entry_id,
           trading_date, tender_total_fils)
        values (${`${RUN}-key`}, 'fp', 'basket-1', ${invoice.id}, ${saleEntry},
                ${SUPPLY_DATE}::date, ${LINE_GROSS})
      `
    })

    const wrong = await stateOf(
      issueNote(
        creditNoteInput(invoice.id, {
          reversal: reversal({
            entryId: nextEntryId(),
            netFils: LINE_NET,
            vatFils: LINE_VAT,
            grossFils: LINE_GROSS,
            reverses: null,
          }),
        }),
      ),
    )
    expect(wrong.message).toContain('corrects that document instead of this one')

    // The control: naming the right entry is accepted, and the stored reversal carries the link.
    const note = await issueNote(
      creditNoteInput(invoice.id, {
        reversal: reversal({
          entryId: nextEntryId(),
          netFils: LINE_NET,
          vatFils: LINE_VAT,
          grossFils: LINE_GROSS,
          reverses: saleEntry,
        }),
      }),
    )
    const entry = await readJournalEntry(sql, note.journalEntryId)
    expect(entry?.reverses).toBe(saleEntry)
  })
})

describe('the cumulative credited quantity is capped at the invoiced quantity', () => {
  it('two parallel full credit notes for one line: exactly one succeeds', async () => {
    const invoice = await issueTestInvoice()

    // Two CONNECTIONS, not two transactions on one: a single connection serialises them by itself and
    // the case would prove nothing about the lock. Each holds the advisory lock the trigger takes until
    // it commits, so the loser reads the winner's committed rows and the sum becomes a ceiling rather
    // than a report.
    const a = createConnection({ url, max: 2 })
    const b = createConnection({ url, max: 2 })
    try {
      const both = await Promise.allSettled([
        issueNote(creditNoteInput(invoice.id), a),
        issueNote(creditNoteInput(invoice.id), b),
      ])
      const fulfilled = both.filter((outcome) => outcome.status === 'fulfilled')
      const rejected = both.filter((outcome) => outcome.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)

      const reason = (rejected[0] as PromiseRejectedResult).reason
      // By the rule's NAME, not by "an error was raised": a unique violation on the display number
      // would also reject exactly one of the two and would prove nothing about the ceiling.
      expect(isOverCredited(reason)).toBe(true)
      expect(String((reason as Error).message)).toContain('CreditNoteOverCredits')

      // And the survivor is the only note on the document.
      const notes = await readCreditNotesForInvoice(sql, invoice.id)
      expect(notes).toHaveLength(1)
      expect(notes[0]?.lines[0]?.quantity).toBe(QUANTITY)
    } finally {
      await a.end({ timeout: 5 })
      await b.end({ timeout: 5 })
    }
  })

  it('credits part of a line, twice, and refuses the fourth unit of three', async () => {
    const invoice = await issueTestInvoice()
    await issueNote(partialNoteInput(invoice.id))
    await issueNote(partialNoteInput(invoice.id))
    await issueNote(partialNoteInput(invoice.id))
    // Three of three credited. The control is the three successes above: a trigger that refused
    // everything would satisfy the assertion below and nothing else.
    const fourth = await stateOf(issueNote(partialNoteInput(invoice.id)))
    expect(fourth.code).toBe(CREDIT_NOTE_SQLSTATE.overCredits)
    expect(fourth.message).toContain('was invoiced 3 and would now be credited 4')
  })

  it('refuses a credit at a different unit price or rate, and a full credit that re-derives its VAT', async () => {
    const invoice = await issueTestInvoice()

    const cheaper = await stateOf(
      issueNote(
        partialNoteInput(invoice.id, {
          lines: [
            {
              invoiceLineNo: 1,
              descriptionEn: 'Asian Normal Massage, 60 minutes',
              quantity: 1,
              unitGrossFils: 999,
              vatRateBp: RATE_BP,
              // 999 - round(999 * 5 / 105) = 999 - 48 = 951.
              netFils: 951,
              vatFils: 48,
            },
          ],
          netTotalFils: 951,
          vatTotalFils: 48,
          grossTotalFils: 999,
          reversal: reversal({
            entryId: nextEntryId(),
            netFils: 951,
            vatFils: 48,
            grossFils: 999,
          }),
        }),
      ),
    )
    expect(cheaper.code).toBe(CREDIT_NOTE_SQLSTATE.priceDisagrees)
    expect(cheaper.message).toContain('CreditNotePriceDisagrees')

    // The 11-fils case, the other way up. A FULL credit of three units at 1000 must carry the LINE's
    // VAT of 143 — the figure splitting the 3000 total gives — and not 3 × 48 = 144, which is what
    // re-deriving per unit produces.
    const rederived = await stateOf(
      issueNote(
        creditNoteInput(invoice.id, {
          lines: [
            {
              invoiceLineNo: 1,
              descriptionEn: 'Asian Normal Massage, 60 minutes',
              quantity: QUANTITY,
              unitGrossFils: UNIT_GROSS,
              vatRateBp: RATE_BP,
              netFils: 2856,
              vatFils: 144,
            },
          ],
          netTotalFils: 2856,
          vatTotalFils: 144,
          grossTotalFils: LINE_GROSS,
          reversal: reversal({
            entryId: nextEntryId(),
            netFils: 2856,
            vatFils: 144,
            grossFils: LINE_GROSS,
          }),
        }),
      ),
    )
    expect(rederived.code).toBe(CREDIT_NOTE_SQLSTATE.priceDisagrees)
    expect(rederived.message).toContain('CreditNoteFullCreditDisagrees')

    // The control: the line's own figures ARE accepted, so the refusals above are about the numbers
    // rather than about crediting at all.
    await expect(issueNote(creditNoteInput(invoice.id))).resolves.toMatchObject({
      vatTotalFils: LINE_VAT,
    })
  })

  it('refuses a line the invoice does not have', async () => {
    const invoice = await issueTestInvoice()
    const ghost = await stateOf(
      issueNote(
        partialNoteInput(invoice.id, {
          lines: [
            {
              invoiceLineNo: 2,
              descriptionEn: 'A line that was never invoiced',
              quantity: 1,
              unitGrossFils: ONE_UNIT_GROSS,
              vatRateBp: RATE_BP,
              netFils: ONE_UNIT_NET,
              vatFils: ONE_UNIT_VAT,
            },
          ],
        }),
      ),
    )
    expect(ghost.code).toBe(CREDIT_NOTE_SQLSTATE.withoutInvoiceLine)
    expect(ghost.message).toContain('which has no such line')
  })

  it('refuses a header whose totals disagree with its lines, at COMMIT', async () => {
    const invoice = await issueTestInvoice()
    // The header states one unit and the line credits one unit at a DIFFERENT figure, so the deferred
    // trigger is the only thing that can see the disagreement: both statements succeed.
    const disagreeing = await stateOf(
      issueNote(
        partialNoteInput(invoice.id, {
          netTotalFils: 951,
          vatTotalFils: 48,
          grossTotalFils: 999,
          reversal: reversal({
            entryId: nextEntryId(),
            netFils: 951,
            vatFils: 48,
            grossFils: 999,
          }),
        }),
      ),
    )
    expect(disagreeing.code).toBe(CREDIT_NOTE_SQLSTATE.totalsDisagree)
    expect(disagreeing.message).toContain('CreditNoteTotalsDisagree')
  })
})

describe('a locked period', () => {
  it('refuses the note and names the earliest OPEN date', async () => {
    const invoice = await issueTestInvoice()
    await withUnitOfWork(sql, TILL, (uow) =>
      lockAccountingPeriod(uow, {
        periodId: `${RUN}-2097-10`,
        startsOn: '2097-10-01',
        endsOn: '2097-10-31',
        reason: `${RUN} probe`,
        lockedByActorKind: 'system',
      }),
    )
    await withUnitOfWork(sql, TILL, (uow) =>
      lockAccountingPeriod(uow, {
        periodId: `${RUN}-2097-11`,
        startsOn: '2097-11-01',
        endsOn: '2097-11-30',
        reason: `${RUN} probe`,
        lockedByActorKind: 'system',
      }),
    )

    const refused = await stateOf(issueNote(creditNoteInput(invoice.id)))
    expect(refused.code).toBe(CREDIT_NOTE_SQLSTATE.periodLocked)
    expect(isCreditNotePeriodLocked({ code: refused.code })).toBe(true)
    // The locked period, because the person has to know why — and the earliest OPEN date, because that
    // is the only thing they can act on. `raise_if_period_locked` (0018) names the first alone, and a
    // message that stopped at "October is locked" sends somebody to November, which is also shut.
    expect(refused.message).toContain(`${RUN}-2097-10`)
    expect(refused.message).toContain('The earliest open date is 2097-12-01')

    // The control: the same note dated on that open date is accepted, so the refusal is about the lock
    // rather than about the document.
    const entryId = nextEntryId()
    const accepted = await issueNote(
      creditNoteInput(invoice.id, {
        issueDate: '2097-12-01',
        issueTradingDate: '2097-12-01',
        taxPointDate: '2097-12-01',
        reversal: reversal({
          entryId,
          entryDate: '2097-12-01',
          netFils: LINE_NET,
          vatFils: LINE_VAT,
          grossFils: LINE_GROSS,
        }),
      }),
    )
    expect(accepted.taxPointDate).toBe('2097-12-01')
  })
})

describe('the CR-NOTE range', () => {
  it('has no gaps and no duplicates after rollbacks, and never interleaves with TAX-INV', async () => {
    const invoice = await issueTestInvoice()
    const second = await issueTestInvoice()

    // Eight notes of one unit each across two documents, with four transactions rolled back in
    // between. A rollback must consume no number: the counter's row lock is inside the document's
    // transaction, which is the whole of M-TILL-03 (ADR 0023).
    for (let i = 0; i < 2; i += 1) {
      await issueNote(partialNoteInput(invoice.id))
      await issueNote(partialNoteInput(second.id))
      await stateOf(
        withUnitOfWork(sql, TILL, async (uow) => {
          await issueCreditNote(uow, partialNoteInput(invoice.id))
          throw new Error('rolled back on purpose')
        }),
      )
      await stateOf(
        withUnitOfWork(sql, TILL, async (uow) => {
          await issueCreditNote(uow, partialNoteInput(second.id))
          throw new Error('rolled back on purpose')
        }),
      )
    }

    const numbers = await sql<{ display_number: string }[]>`
      select display_number from credit_note order by number
    `
    expect(numbers.map((row) => row.display_number)).toEqual([
      'CN-2097-00001',
      'CN-2097-00002',
      'CN-2097-00003',
      'CN-2097-00004',
    ])

    // M-TILL-03's gap report, run against this table. `relation` is a parameter of it precisely because
    // "the document tables do not exist yet (M-TILL-04 adds `invoice`, and credit notes follow it)".
    expect(await findNumberingGaps(sql, 'credit_note')).toEqual([])
    // The control: the report is not blind. The invoice range is intact too, and both are non-empty.
    expect(await findNumberingGaps(sql, 'invoice')).toEqual([])
    expect(numbers.length).toBeGreaterThan(0)

    // The two ranges do not interleave: two invoices and four notes, each counted from 1 in its own
    // series.
    const invoices = await sql<{ display_number: string }[]>`
      select display_number from invoice order by number
    `
    expect(invoices.map((row) => row.display_number)).toEqual(['TI-2097-00001', 'TI-2097-00002'])
  })

  it('a gap IS reported when one exists, so the zero above is a finding', async () => {
    const invoice = await issueTestInvoice()
    await issueNote(partialNoteInput(invoice.id))
    // Number 2 skipped by hand, as the owner. Nothing in the application can do this — `berelax_app`
    // holds no INSERT on `document_series` and no UPDATE on its counter — which is why the hole has to
    // be made from outside to prove the report sees one.
    await sql`update document_series set next_number = 3 where code = 'CR-NOTE'`
    await issueNote(partialNoteInput(invoice.id))

    const gaps = await findNumberingGaps(sql, 'credit_note')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.seriesCode).toBe('CR-NOTE')
  })
})

describe('a credit note is append-only', () => {
  it('refuses UPDATE and DELETE on both tables, for every role including the owner', async () => {
    const invoice = await issueTestInvoice()
    const note = await issueNote(creditNoteInput(invoice.id))

    for (const statement of [
      sql`update credit_note set reason = 'a better reason' where id = ${note.id}`,
      sql`delete from credit_note where id = ${note.id}`,
      sql`update credit_note_line set quantity = 1 where credit_note_id = ${note.id}`,
      sql`delete from credit_note_line where credit_note_id = ${note.id}`,
    ]) {
      const refused = await stateOf(statement)
      expect(refused.code).toBe(CREDIT_NOTE_SQLSTATE.appendOnly)
      expect(isCreditNoteAppendOnly({ code: refused.code })).toBe(true)
      // The remedy in the message is the one that applies HERE. `refuse_invoice_change` says "correct
      // an issued invoice with a credit note", which is the wrong instruction for a credit note.
      expect(refused.message).toContain('re-invoicing the supply')
    }

    // The control: the row is still there and unchanged, so the refusals above were refusals rather
    // than statements that quietly matched nothing.
    const stored = await readCreditNote(sql, note.id)
    expect(stored?.reason).toBe('The therapist delivered the wrong treatment')
    expect(stored?.lines[0]?.quantity).toBe(QUANTITY)
  })

  it('the application role holds no UPDATE, DELETE or TRUNCATE on either table', async () => {
    const privileges = await sql<
      { table_name: string; update: boolean; delete: boolean; truncate: boolean; select: boolean }[]
    >`
      select t.table_name,
             has_table_privilege('berelax_app', t.table_name, 'UPDATE')   as update,
             has_table_privilege('berelax_app', t.table_name, 'DELETE')   as delete,
             has_table_privilege('berelax_app', t.table_name, 'TRUNCATE') as truncate,
             has_table_privilege('berelax_app', t.table_name, 'SELECT')   as select
        from (values ('credit_note'), ('credit_note_line')) as t(table_name)
    `
    expect(privileges).toHaveLength(2)
    for (const row of privileges) {
      expect(row.update, `${row.table_name} UPDATE`).toBe(false)
      expect(row.delete, `${row.table_name} DELETE`).toBe(false)
      expect(row.truncate, `${row.table_name} TRUNCATE`).toBe(false)
      // The control: SELECT IS granted, so the three falses above are revocations rather than a query
      // about a table the role cannot see at all.
      expect(row.select, `${row.table_name} SELECT`).toBe(true)
    }
  })
})

describe('the refund now has to name a credit note that exists and covers it', () => {
  /** A cash payment of the whole document, so a refund has something to give back. */
  async function payInFull(invoiceId: string): Promise<void> {
    await sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                           trading_date)
      values (${invoiceId}, 1, 'cash', '1010', ${LINE_GROSS}, ${SUPPLY_DATE}::date)
    `
  }

  async function refund(
    invoiceId: string,
    creditNoteId: string,
    amountFils: number,
    refundNo = 1,
  ): Promise<void> {
    await sql`
      insert into refund (invoice_id, credit_note_id, refund_no, tender_kind, posting_account_code,
                          amount_fils, trading_date)
      values (${invoiceId}, ${creditNoteId}, ${refundNo}, 'cash', '1010', ${amountFils},
              ${CREDIT_DATE}::date)
    `
  }

  it('refuses a refund whose credit note does not exist, and carries the key 0068 could not add', async () => {
    const invoice = await issueTestInvoice()
    await payInFull(invoice.id)
    const dangling = await stateOf(
      refund(invoice.id, '00000000-0000-4000-8000-0000000000c1', LINE_GROSS),
    )
    // ZD010 rather than a foreign-key violation, and that ORDER is the useful one: the BEFORE INSERT
    // trigger runs before the key is checked, so the caller gets a sentence instead of
    // `violates foreign key constraint`. The key is still what makes the reference true against every
    // path — including one that dropped the trigger — so its existence is asserted as schema.
    expect(dangling.code).toBe(CREDIT_NOTE_SQLSTATE.refundNoteMismatch)
    expect(dangling.message).toContain('RefundWithoutCreditNote')

    const keys = await sql<{ conname: string; target: string }[]>`
      select c.conname, t.relname as target
        from pg_constraint c
        join pg_class r on r.oid = c.conrelid
        join pg_class t on t.oid = c.confrelid
       where c.contype = 'f' and r.relname = 'refund' and t.relname = 'credit_note'
    `
    expect(keys.map((row) => row.conname)).toEqual(['refund_authorised_by_credit_note'])

    // The control: the same query over a table pair that has no key between them returns nothing, so
    // the row above is a finding rather than a query that matches anything.
    const none = await sql<{ conname: string }[]>`
      select c.conname
        from pg_constraint c
        join pg_class r on r.oid = c.conrelid
        join pg_class t on t.oid = c.confrelid
       where c.contype = 'f' and r.relname = 'credit_note' and t.relname = 'invoice'
    `
    expect(none).toEqual([])
  })

  it('refuses a refund whose credit note corrects a different document', async () => {
    const mine = await issueTestInvoice()
    const other = await issueTestInvoice()
    await payInFull(other.id)
    const note = await issueNote(creditNoteInput(mine.id))

    const mismatched = await stateOf(refund(other.id, note.id, LINE_GROSS))
    expect(mismatched.code).toBe(CREDIT_NOTE_SQLSTATE.refundNoteMismatch)
    expect(mismatched.message).toContain('RefundCreditNoteIsForAnotherDocument')
  })

  it('caps the refunds against one note at what it credits, at COMMIT', async () => {
    const invoice = await issueTestInvoice()
    await payInFull(invoice.id)
    // A PARTIAL note, crediting one of the three units: 1000 fils credited against 3000 applied. The
    // full note would make the two ceilings coincide, and the case below proves ZT004 wins when they
    // do — so this one has to leave room under ZT004 to be about ZD012 at all.
    const note = await issueNote(partialNoteInput(invoice.id))
    expect(note.grossTotalFils).toBe(ONE_UNIT_GROSS)

    // Two refunds in ONE transaction, which is why the ceiling is deferred: a refund split across two
    // tender forms is two statements, and a per-statement check would refuse the second before the
    // first had finished.
    const over = await stateOf(
      sql.begin(async (tx) => {
        await tx`
          insert into refund (invoice_id, credit_note_id, refund_no, tender_kind,
                              posting_account_code, amount_fils, trading_date)
          values (${invoice.id}, ${note.id}, 1, 'cash', '1010', 600, ${CREDIT_DATE}::date)
        `
        await tx`
          insert into refund (invoice_id, credit_note_id, refund_no, tender_kind,
                              posting_account_code, amount_fils, trading_date)
          values (${invoice.id}, ${note.id}, 2, 'cash', '1010', 401, ${CREDIT_DATE}::date)
        `
      }),
    )
    expect(over.code).toBe(CREDIT_NOTE_SQLSTATE.refundExceedsNote)
    expect(over.message).toContain('RefundExceedsCreditNote')

    // The control: the same split, one fils lower, is accepted — so the ceiling is the note's gross
    // rather than a refusal of split refunds.
    await sql.begin(async (tx) => {
      await tx`
        insert into refund (invoice_id, credit_note_id, refund_no, tender_kind,
                            posting_account_code, amount_fils, trading_date)
        values (${invoice.id}, ${note.id}, 1, 'cash', '1010', 600, ${CREDIT_DATE}::date)
      `
      await tx`
        insert into refund (invoice_id, credit_note_id, refund_no, tender_kind,
                            posting_account_code, amount_fils, trading_date)
        values (${invoice.id}, ${note.id}, 2, 'cash', '1010', 400, ${CREDIT_DATE}::date)
      `
    })
    const refunded = await sql<{ total: string }[]>`
      select coalesce(sum(amount_fils), 0) as total from refund where credit_note_id = ${note.id}
    `
    expect(Number(refunded[0]?.total)).toBe(ONE_UNIT_GROSS)
  })

  it('leaves 0068’s ZT004 reaching the caller first when both ceilings break', async () => {
    const invoice = await issueTestInvoice()
    const note = await issueNote(creditNoteInput(invoice.id))
    // Nothing was paid, so refunding anything breaks ZT004, and 3001 also breaks ZD012. PostgreSQL
    // fires the AFTER triggers of one event in alphabetical order by trigger name, and
    // `refund_not_more_than_was_paid` sorts before `refund_within_its_credit_note` — deliberately, so
    // the refusal a caller reads is the one about money rather than the one about paperwork. 0068's
    // gate probe asserts ZT004 by name and this keeps it true.
    const both = await stateOf(refund(invoice.id, note.id, LINE_GROSS + 1))
    expect(both.code).toBe('ZT004')
    expect(both.message).toContain('RefundExceedsPayments')
  })
})

describe('what a credit note does and does not change about settlement', () => {
  it('reports credited and receivable, and leaves outstanding as ZT001’s own quantity', async () => {
    const invoice = await issueTestInvoice()
    await sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                           trading_date)
      values (${invoice.id}, 1, 'cash', '1010', ${LINE_GROSS}, ${SUPPLY_DATE}::date)
    `
    const beforeNote = await sql<
      { outstanding_fils: string; credited_fils: string; receivable_fils: string }[]
    >`
      select outstanding_fils, credited_fils, receivable_fils
        from invoice_settlement where invoice_id = ${invoice.id}
    `
    expect(Number(beforeNote[0]?.outstanding_fils)).toBe(0)
    expect(Number(beforeNote[0]?.credited_fils)).toBe(0)
    expect(Number(beforeNote[0]?.receivable_fils)).toBe(0)

    await issueNote(creditNoteInput(invoice.id))

    const afterNote = await sql<
      { outstanding_fils: string; credited_fils: string; receivable_fils: string }[]
    >`
      select outstanding_fils, credited_fils, receivable_fils
        from invoice_settlement where invoice_id = ${invoice.id}
    `
    // The decision 0068 asked this unit to take: ZT001 and its `outstanding_fils` are left alone, so an
    // honest payment already reconciled against a counted drawer does not become an overpayment.
    expect(Number(afterNote[0]?.outstanding_fils)).toBe(0)
    expect(Number(afterNote[0]?.credited_fils)).toBe(LINE_GROSS)
    // NEGATIVE: the business holds 3000 fils it owes back. That is the figure 0068's NOTE asked for —
    // gross - credited - applied + refunded — and the reason it is a new column rather than a
    // redefinition of the old one.
    expect(Number(afterNote[0]?.receivable_fils)).toBe(-LINE_GROSS)

    await sql`
      insert into refund (invoice_id, credit_note_id, refund_no, tender_kind, posting_account_code,
                          amount_fils, trading_date)
      select ${invoice.id}, id, 1, 'cash', '1010', ${LINE_GROSS}, ${CREDIT_DATE}::date
        from credit_note where invoice_id = ${invoice.id}
    `
    const afterRefund = await sql<{ receivable_fils: string; refunded_fils: string }[]>`
      select receivable_fils, refunded_fils from invoice_settlement where invoice_id = ${invoice.id}
    `
    expect(Number(afterRefund[0]?.refunded_fils)).toBe(LINE_GROSS)
    expect(Number(afterRefund[0]?.receivable_fils)).toBe(0)
  })

  it('does NOT refuse a payment against a credited document, and says so in the view', async () => {
    const invoice = await issueTestInvoice()
    await issueNote(creditNoteInput(invoice.id))

    // The deliberate absence, asserted rather than assumed. 0072 adds no second ceiling on `payment`:
    // an IMMEDIATE one would steal ZT001's refusal (its condition with no credit note IS ZT001's, and
    // ZT001 is deferred) and a DEFERRED one would refuse a transaction that pays a document and credits
    // it together, which is the ordinary end state reached in one transaction by a fixture or an import.
    // So the money ceiling is exactly what 0068 made it.
    await expect(
      sql`
        insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                             trading_date)
        values (${invoice.id}, 1, 'cash', '1010', 1, ${SUPPLY_DATE}::date)
      `,
    ).resolves.toBeDefined()

    // What makes it visible instead: payable 3000 - credited 3000 - applied 1 + refunded 0 = -1, so the
    // figure says the business owes the customer the one fils it should not have taken. A till that
    // offers to take payment without reading this is M-TILL-13's to fix; see the NOTE on M-TILL-08.
    const [row] = await sql<{ credited_fils: string; receivable_fils: string }[]>`
      select credited_fils, receivable_fils from invoice_settlement where invoice_id = ${invoice.id}
    `
    expect(Number(row?.credited_fils)).toBe(LINE_GROSS)
    expect(Number(row?.receivable_fils)).toBe(-1)

    // The control: on an UNCREDITED document of the same shape the same figure is zero, so the negative
    // above is the credit note showing rather than the column always being negative.
    const clean = await issueTestInvoice()
    await sql`
      insert into payment (invoice_id, tender_no, tender_kind, posting_account_code, amount_fils,
                           trading_date)
      values (${clean.id}, 1, 'cash', '1010', 1, ${SUPPLY_DATE}::date)
    `
    const [cleanRow] = await sql<{ receivable_fils: string }[]>`
      select receivable_fils from invoice_settlement where invoice_id = ${clean.id}
    `
    expect(Number(cleanRow?.receivable_fils)).toBe(LINE_GROSS - 1)
  })
})
