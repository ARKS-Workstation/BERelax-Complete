import { describe, expect, it } from 'vitest'
import * as invoiceRepository from './invoice.ts'

/**
 * The export surface of the invoice repository, asserted rather than agreed.
 *
 * An issued invoice is never corrected: a correction is a credit note, a separate document with its
 * own statutory series (docs/04 §4). That is a rule about what functions may *exist*, so it is
 * enforced by enumerating the module's exports — a convention written in a comment is one that a
 * future `voidInvoice` passes.
 *
 * This is a unit test on purpose. The grants and the refusal triggers are asserted against a real
 * PostgreSQL in `invoice.itest.ts`; what is checked here is the TypeScript surface, which is the layer
 * a caller actually reaches for, and it is checked with nothing running.
 */

/**
 * Verb stems that may not appear as a segment of an exported name.
 *
 * **Stems, and segmented matching, both for the same reason.** A substring match for `edit` flags
 * `creditNote` — the one correction path that must exist — and a whole-word match for `delete` misses
 * `softDeleted`. So a name is split into its camelCase and SNAKE_CASE segments and each segment is
 * tested for a stem prefix: `delet` catches delete, deleted and deleting, and `credit` does not begin
 * with `edit`.
 *
 * The first four are the ones M-TILL-04 names. `amend` and `cancel` are here because they are what
 * somebody reaches for when `update` has already been refused.
 */
const FORBIDDEN_VERB_STEMS = ['updat', 'edit', 'void', 'delet', 'amend', 'cancel'] as const

/** `readInvoiceByDisplayNumber` -> ['read', 'invoice', 'by', 'display', 'number']. */
function segmentsOf(name: string): readonly string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter((segment) => segment !== '')
}

/** The forbidden stem a name carries, or undefined. */
function mutatingVerbIn(name: string): string | undefined {
  for (const segment of segmentsOf(name)) {
    const stem = FORBIDDEN_VERB_STEMS.find((verb) => segment.startsWith(verb))
    if (stem !== undefined) return stem
  }
  return undefined
}

describe('the invoice repository exports no way to change an issued document', () => {
  it('exports nothing named update, edit, void or delete', () => {
    const offending = Object.keys(invoiceRepository)
      .map((name) => ({ name, verb: mutatingVerbIn(name) }))
      .filter((found) => found.verb !== undefined)
      .map((found) => `${found.name} (matches "${found.verb}")`)

    expect(
      offending,
      'An issued invoice is corrected by a credit note, never edited. If this fails, the new ' +
        'function is the defect, not this test.',
    ).toEqual([])
  })

  it('the control: the same check DOES flag those names', () => {
    // Without this, a matcher that had stopped matching anything — a regex typo, a segmenter that
    // returned an empty array — would report an empty list of offenders for ever, which is exactly
    // the shape of a gate that has quietly died (ADR 0003).
    const wouldBeRejected = [
      'updateInvoice',
      'editInvoiceLine',
      'voidInvoice',
      'deleteInvoice',
      'softDeleteInvoice',
      'INVOICE_UPDATE_SQL',
      'amendIssuedInvoice',
      'cancelInvoice',
      'invoiceUpdated',
    ]
    for (const name of wouldBeRejected) {
      expect(mutatingVerbIn(name), `${name} must be rejected`).toBeDefined()
    }
  })

  it('the second control: it does NOT flag the names a correction path needs', () => {
    // `creditNote` is the whole reason the match is segmented rather than a substring search: 'credit'
    // contains 'edit'. A check that banned it would ban the one documented way to fix an invoice.
    for (const name of [
      'creditNote',
      'issueCreditNote',
      'readInvoice',
      'CREDIT_NOTE_SERIES',
      'avoidable',
    ]) {
      expect(mutatingVerbIn(name), `${name} must be allowed`).toBeUndefined()
    }
  })

  it('enumerates a surface that is actually there', () => {
    // The third control. `Object.keys` of a module that failed to load, or of the wrong module, is
    // empty — and an empty surface satisfies the verb ban trivially.
    const exported = Object.keys(invoiceRepository)
    expect(exported.length).toBeGreaterThan(5)
    expect(typeof invoiceRepository.issueInvoice).toBe('function')
    expect(typeof invoiceRepository.readInvoice).toBe('function')
    expect(typeof invoiceRepository.readInvoiceByDisplayNumber).toBe('function')
    expect(typeof invoiceRepository.invoiceError).toBe('function')
    // Exactly one writer. Everything else reads, classifies an error, or is data.
    const writers = exported.filter((name) => segmentsOf(name)[0] === 'issue')
    expect(writers).toEqual(['issueInvoice'])
  })
})

describe('the Y11-vat-invoice field list', () => {
  it('names a column for every requirement, with no duplicates', () => {
    const fields = invoiceRepository.Y11_VAT_INVOICE_FIELDS
    expect(fields.length).toBeGreaterThan(20)
    const keys = fields.map((f) => `${f.table}.${f.column}`)
    expect(new Set(keys).size).toBe(keys.length)
    for (const field of fields) {
      expect(field.requirement).not.toBe('')
      expect(['invoice', 'invoice_line']).toContain(field.table)
    }
    // The list has to reach both tables, or "per-line VAT amount" would be satisfiable by a header
    // column and the whole point of per-line derivation would be missing from the list.
    expect(new Set(fields.map((f) => f.table))).toEqual(new Set(['invoice', 'invoice_line']))
  })

  it('carries the fields docs/04 §4 names, and the ones the PDF already renders', () => {
    const columns = new Set(
      invoiceRepository.Y11_VAT_INVOICE_FIELDS.map((f) => `${f.table}.${f.column}`),
    )
    for (const required of [
      'invoice.issuer_legal_name',
      'invoice.issuer_address_snapshot',
      'invoice.issuer_trn',
      'invoice.display_number',
      'invoice.issue_date',
      'invoice.tax_point_date',
      'invoice.customer_name_snapshot',
      'invoice.net_total',
      'invoice.vat_total',
      'invoice.gross_total',
      'invoice_line.description_en',
      'invoice_line.quantity',
      'invoice_line.unit_gross_fils',
      'invoice_line.vat_rate_bp',
      'invoice_line.line_vat_fils',
    ]) {
      expect(columns, `${required} is a mandatory field`).toContain(required)
    }
    // The control: a column nobody declared is absent, so `toContain` is testing the set rather than
    // passing on everything.
    expect(columns).not.toContain('invoice.issuer_legal_name_ar')
  })
})
