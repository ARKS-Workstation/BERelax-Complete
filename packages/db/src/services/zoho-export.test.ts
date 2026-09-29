import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import type { VatReturnForFiling } from './vat-return-signoff.ts'
import * as service from './zoho-export.ts'
import {
  renderZohoVatReturn,
  ZOHO_EXPORT_FORMAT_VERSION,
  ZOHO_EXPORT_SURFACE,
  zohoExportFilename,
} from './zoho-export.ts'

/**
 * M-VAT-09 — the bytes of the Zoho Books export, and the figures they state.
 *
 * ## Why the bytes are a committed file
 *
 * The acceptance line is that the export's "totals reconcile to the snapshot box values to the fils", and
 * the deliverable is a file somebody hands to an accountant. So the contract is the BYTES, and a test that
 * asserted a few fields of an object would leave the thing actually delivered unchecked — a reordered
 * section, a lost line, a `1000` that became `1000.0` and a CRLF that a hash then reports as a different
 * file are all invisible to a field-by-field assertion and all obvious in a diff of
 * `zoho-export.fixture.csv`.
 *
 * `renderZohoVatReturn` takes the filing row and nothing else — no clock, no user — so the fixture can be
 * exact rather than masked. That is the property that makes the recorded file hash mean anything at all,
 * and it is asserted here rather than assumed: the same input renders the same bytes twice.
 *
 * ## Why this file is a unit test and not part of the integration suite
 *
 * Every figure in the file comes out of `snapshot_json`, and a snapshot's content hash, engine signature
 * and period are whatever the database it was taken in happened to hold. A byte-exact fixture cannot be
 * taken against that. So the DIVISION IS: this file owns the bytes, over a hand-built filing row; and
 * `zoho-export.itest.ts` owns the refusal, the audit row, the cleared environment and the reconciliation
 * of these totals against `vat_return_box_figure` in real PostgreSQL. Neither claim is provable where the
 * other one lives.
 *
 * ## The hand-built filing row is the bypass `ZOHO_EXPORT_SURFACE` names, used deliberately
 *
 * `renderZohoVatReturn` takes a `VatReturnForFiling`, and the only thing in this repository that produces
 * one is `vat_return_for_filing()`, which raises `ZY055` for a return nobody has signed. {@link filing}
 * below fabricates one — including a finalisation instant — and that is exactly the reach the surface entry
 * for that function describes rather than a hole this file found. Nothing is bypassed by it: the bytes of a
 * CSV are not a filing, and the one thing that RECORDS an export having happened is the `audit_event`
 * written by `exportVatReturnForZoho`, which cannot be reached except through the door.
 * `zoho-export.itest.ts` drives the renderer from a row the DATABASE produced and requires the same bytes,
 * so the two halves are held together rather than asserted separately.
 */

const FIXTURE = join(import.meta.dirname, 'zoho-export.fixture.csv')

/**
 * A snapshot of the shape `canonicaliseVat201WorkingPapers` produces.
 *
 * Amounts are decimal STRINGS, which is not a convenience of this fixture: `bigint` has no JSON
 * representation and the canonical form converts every one of them, so a reader that expected numbers
 * would be reading a shape the database never stores.
 *
 * Two boxes, one each side, so the totals have something to be a sum OF — a single-sided paper would make
 * `net_tax_due_fils` equal to `output_tax_fils` and the subtraction untested. The figures split exactly at
 * 5%: 20,000 net bears 1,000 of tax.
 */
const snapshot = (
  boxes: readonly Record<string, unknown>[],
  reasons: readonly Record<string, unknown>[] = [
    {
      detail: 'every box carries is_provisional while the VAT201 numbering is unconfirmed',
      openQuestionId: 'Y11-vat201-boxes',
      reason: 'box_numbering_unconfirmed',
    },
  ],
) => JSON.stringify({ boxes, notFileableReasons: reasons })

const STANDARD_RATED = {
  boxNo: 1,
  displayOrder: 10,
  isProvisional: true,
  label: 'Standard-rated supplies',
  lineCount: 2,
  netSuppliesFils: '20000',
  openQuestionId: 'Y11-vat201-boxes',
  side: 'output',
  taxFils: '1000',
}
const RECOVERABLE_INPUT = {
  boxNo: 10,
  displayOrder: 30,
  isProvisional: true,
  label: 'Recoverable input VAT',
  lineCount: 1,
  netSuppliesFils: '8000',
  openQuestionId: 'Y11-vat201-boxes',
  side: 'input',
  taxFils: '400',
}

/**
 * A filing row, as `vat_return_for_filing()` hands one back.
 *
 * The hashes are fixed strings of the right SHAPE rather than real sha256 values, and that is the honest
 * choice for a unit fixture: recomputing them here would make this file a second implementation of the
 * hash, and the itest is where a real one is checked against the database's own CHECK.
 */
const filing = (overrides: Partial<VatReturnForFiling> = {}): VatReturnForFiling => ({
  returnId: '0199a3c8-0000-7000-8000-000000000001',
  periodId: 'FIXTURE-2126-Q3',
  startsOn: '2126-07-01',
  endsOn: '2126-09-30',
  version: 1,
  contentHash: 'a'.repeat(64),
  engineSignature: 'b'.repeat(64),
  formatVersion: 'vat201-wp1',
  snapshotJson: snapshot([STANDARD_RATED, RECOVERABLE_INPUT]),
  finalisedAt: new Date('2126-10-05T08:00:00.000Z'),
  ...overrides,
})

/** The `AppError` a call threw, so `details` can be asserted rather than message text. */
function refusalOf(body: () => unknown): AppError {
  try {
    body()
  } catch (err) {
    return err as AppError
  }
  throw new Error('expected a refusal; the call returned')
}

/** The `boxes` section of the rendered file, back out of the text. A second path to the same figures. */
function parsedBoxSection(csv: string): readonly (readonly string[])[] {
  const lines = csv.split('\n')
  const from = lines.indexOf('section,boxes')
  const to = lines.indexOf('section,totals')
  if (from === -1 || to === -1) throw new Error('the rendered file has no boxes or totals section')
  // +2 skips the section marker and the column header; -1 drops the blank line before the next section.
  return lines.slice(from + 2, to - 1).map((entry) => entry.split(','))
}

const csvValue = (csv: string, key: string): string => {
  const found = csv.split('\n').find((entry) => entry.startsWith(`${key},`))
  if (found === undefined) throw new Error(`the rendered file has no "${key}" line`)
  return found.slice(key.length + 1)
}

describe('the export bytes are the contract', () => {
  it('renders the committed fixture, byte for byte', () => {
    const rendered = renderZohoVatReturn(filing()).csv
    expect(rendered).toBe(readFileSync(FIXTURE, 'utf8'))
    // The control, and it is the whole reason the fixture is worth having: ONE FILS of difference must
    // produce different bytes. Without it this case passes for a renderer that returns a constant, which
    // is the exact failure ADR 0002 is about.
    const nudged = renderZohoVatReturn(
      filing({
        snapshotJson: snapshot([{ ...STANDARD_RATED, taxFils: '1001' }, RECOVERABLE_INPUT]),
      }),
    ).csv
    expect(nudged).not.toBe(rendered)
  })

  it('renders the same bytes twice, because nothing in it reads a clock or an environment', () => {
    const first = renderZohoVatReturn(filing()).csv
    const second = renderZohoVatReturn(filing()).csv
    expect(second).toBe(first)
    // And the control for what "the same input" means: a different FINALISATION is a different artefact.
    // A renderer that ignored its argument would pass the assertion above perfectly.
    const later = renderZohoVatReturn(
      filing({ finalisedAt: new Date('2126-10-06T08:00:00.000Z') }),
    ).csv
    expect(later).not.toBe(first)
  })

  it('states the format tag, the snapshot hash and that nothing has been filed', () => {
    const csv = renderZohoVatReturn(filing()).csv
    expect(csvValue(csv, 'export_format_version')).toBe(ZOHO_EXPORT_FORMAT_VERSION)
    expect(csvValue(csv, 'working_paper_format_version')).toBe('vat201-wp1')
    expect(csvValue(csv, 'snapshot_content_hash')).toBe('a'.repeat(64))
    expect(csvValue(csv, 'engine_signature')).toBe('b'.repeat(64))
    expect(csvValue(csv, 'amount_unit')).toBe('fils')
    // The sentence a reader who has never seen ADR 0017 needs. Asserted because it is the one line in the
    // file whose absence nobody downstream would notice.
    expect(csvValue(csv, 'nothing_here_has_been_filed')).toContain('no capability to file a return')
  })

  it('carries no TRN, registered name, address or authority reference', () => {
    const csv = renderZohoVatReturn(filing()).csv.toLowerCase()
    // Brief rule 15: a plausible one of any of these is worse than a blank, because blank is visibly
    // unanswered. None of them is answerable today, so none of them is in the file.
    for (const forbidden of ['trn', 'tax registration', 'licence', 'license', 'address', 'fta']) {
      expect(csv).not.toContain(forbidden)
    }
    // The control: the words the file DOES have to contain, so the assertion above is not passing because
    // the file is empty.
    expect(csv).toContain('standard-rated supplies')
    expect(csv).toContain('net_tax_due_fils')
  })
})

describe('the totals reconcile to the snapshot box figures, to the fils', () => {
  it('sums each side and subtracts, over the rendered text rather than the object', () => {
    const { csv, totals } = renderZohoVatReturn(filing())
    // Summed from the TEXT — a second path to the same figures, so a totals line that disagreed with the
    // rows above it would fail here. Column order: box_no, label, side, net, tax, ...
    const rows = parsedBoxSection(csv)
    expect(rows.length).toBe(2)
    const sum = (which: string, column: number) =>
      rows
        .filter((cells) => cells[2] === which)
        .reduce((into, cells) => into + BigInt(cells[column] ?? '0'), 0n)
    expect(csvValue(csv, 'output_net_supplies_fils')).toBe(String(sum('output', 3)))
    expect(csvValue(csv, 'output_tax_fils')).toBe(String(sum('output', 4)))
    expect(csvValue(csv, 'input_net_supplies_fils')).toBe(String(sum('input', 3)))
    expect(csvValue(csv, 'input_tax_fils')).toBe(String(sum('input', 4)))
    expect(csvValue(csv, 'net_tax_due_fils')).toBe(String(sum('output', 4) - sum('input', 4)))
    // The figures themselves, so the case is not satisfied by two zeroes agreeing.
    expect(totals.outputTaxFils).toBe(1_000n)
    expect(totals.inputTaxFils).toBe(400n)
    expect(totals.netTaxDueFils).toBe(600n)
  })

  it('reports a repayment as a negative figure rather than clamping it', () => {
    // Input tax above output tax is a repayment period, not an error. A total floored at zero would be a
    // figure this module invented, on the one artefact where that matters most.
    const { totals } = renderZohoVatReturn(
      filing({
        snapshotJson: snapshot([
          { ...STANDARD_RATED, taxFils: '100' },
          { ...RECOVERABLE_INPUT, taxFils: '400' },
        ]),
      }),
    )
    expect(totals.netTaxDueFils).toBe(-300n)
  })

  it('is exact where a number would not be: figures past the safe-integer range', () => {
    // `netSuppliesFils` arrives as a decimal string precisely so this is expressible. Read as a `number`
    // the second figure loses its last digits, which is how trial-balance.ts recorded a four-fils
    // difference appearing out of nothing.
    const huge = '9007199254740993'
    const { totals, csv } = renderZohoVatReturn(
      filing({ snapshotJson: snapshot([{ ...STANDARD_RATED, netSuppliesFils: huge }]) }),
    )
    expect(totals.outputNetSuppliesFils).toBe(BigInt(huge))
    expect(csv).toContain(huge)
    // The control: this is the figure a `number` would have produced instead.
    expect(csv).not.toContain('9007199254740992')
  })
})

describe('the rendered order is a property of the figures, not of the parser', () => {
  it('orders boxes by display order whatever order the snapshot lists them in', () => {
    const forward = renderZohoVatReturn(
      filing({ snapshotJson: snapshot([STANDARD_RATED, RECOVERABLE_INPUT]) }),
    ).csv
    const reversed = renderZohoVatReturn(
      filing({ snapshotJson: snapshot([RECOVERABLE_INPUT, STANDARD_RATED]) }),
    ).csv
    expect(reversed).toBe(forward)
    expect(parsedBoxSection(forward).map((cells) => cells[0])).toEqual(['1', '10'])
    // The control: the ORDER FIELD is what decides it, so changing that must change the file. Without
    // this, a renderer that sorted by nothing at all would pass the assertion above.
    const moved = renderZohoVatReturn(
      filing({
        snapshotJson: snapshot([STANDARD_RATED, { ...RECOVERABLE_INPUT, displayOrder: 5 }]),
      }),
    ).csv
    expect(parsedBoxSection(moved).map((cells) => cells[0])).toEqual(['10', '1'])
  })

  it('quotes a field that would otherwise break the row, and leaves a plain one alone', () => {
    const csv = renderZohoVatReturn(
      filing({
        snapshotJson: snapshot([
          { ...STANDARD_RATED, label: 'Supplies, standard-rated (the "5%" band)' },
        ]),
      }),
    ).csv
    expect(csv).toContain('1,"Supplies, standard-rated (the ""5%"" band)",output,20000,1000,')
    // The control: an ordinary label is NOT quoted, so the case is about RFC 4180 rather than about a
    // renderer that quotes everything — which would still be correct CSV and would make the fixture's
    // every column unreadable at a glance.
    expect(renderZohoVatReturn(filing()).csv).toContain('1,Standard-rated supplies,output,')
  })
})

describe('the filename says which return the file on the disk is of', () => {
  it('carries the period, the version and the head of the content hash', () => {
    expect(zohoExportFilename(filing())).toBe(`vat201-FIXTURE-2126-Q3-v1-${'a'.repeat(12)}.csv`)
    // A second version of the same period is a different file. Two returns of one quarter that shared a
    // filename is the case this is here for — an amendment overwriting the thing it amends on somebody's
    // desktop.
    expect(zohoExportFilename(filing({ version: 2 }))).not.toBe(zohoExportFilename(filing()))
    expect(zohoExportFilename(filing({ contentHash: 'c'.repeat(64) }))).not.toBe(
      zohoExportFilename(filing()),
    )
  })

  it('cannot be turned into a path by a period id somebody typed', () => {
    const named = zohoExportFilename(filing({ periodId: '../../etc/2126 Q3' }))
    expect(named).not.toContain('/')
    expect(named).toBe(`vat201-.._.._etc_2126_Q3-v1-${'a'.repeat(12)}.csv`)
  })
})

describe('a snapshot this module cannot read is refused, never rendered half', () => {
  const cases = [
    { what: 'text that is not JSON', json: 'not json at all', field: 'parseable JSON' },
    { what: 'a JSON array', json: '[]', field: 'a JSON object' },
    { what: 'no boxes', json: JSON.stringify({ notFileableReasons: [] }), field: 'a boxes array' },
    {
      what: 'no reasons',
      json: JSON.stringify({ boxes: [] }),
      field: 'a notFileableReasons array',
    },
    {
      what: 'an amount as a number',
      json: snapshot([{ ...STANDARD_RATED, taxFils: 1000 }]),
      field: 'a box tax figure as a decimal string',
    },
    {
      what: 'a fractional line count',
      json: snapshot([{ ...STANDARD_RATED, lineCount: 1.5 }]),
      field: 'a box line count as an integer',
    },
    {
      what: 'a side outside the two',
      json: snapshot([{ ...STANDARD_RATED, side: 'both' }]),
      field: 'a box side of "output" or "input"',
    },
    {
      what: 'a missing provisional flag',
      json: snapshot([{ ...STANDARD_RATED, isProvisional: undefined }]),
      field: 'a box provisional flag',
    },
  ]

  for (const { what, json, field } of cases) {
    it(`refuses ${what}, naming the field`, () => {
      const refusal = refusalOf(() => renderZohoVatReturn(filing({ snapshotJson: json })))
      expect(refusal.name).toBe('ZohoExportSnapshotUnreadable')
      // By FIELD, not merely "it threw": an assertion on the class alone would pass for a typo in the
      // parser, which is how a test for a refusal ends up testing nothing.
      expect(refusal.details['field']).toBe(field)
      expect(refusal.details['returnId']).toBe(filing().returnId)
    })
  }

  it('is invariant_violated rather than validation, because the bytes are hashed', () => {
    const refusal = refusalOf(() => renderZohoVatReturn(filing({ snapshotJson: '{}' })))
    // `validation` would tell whoever clicked export that they typed something wrong. `snapshot_json` is
    // tied to `content_hash` by a CHECK and the row is append-only, so nobody typed this.
    expect(refusal.kind).toBe('invariant_violated')
  })

  it('renders an empty paper rather than refusing one', () => {
    // Zero boxes is a legitimate period — a quarter with no trading — and must not be confused with a
    // snapshot this module cannot read. The totals are zero and the file still states its own identity.
    const { csv, totals } = renderZohoVatReturn(filing({ snapshotJson: snapshot([], []) }))
    expect(totals.netTaxDueFils).toBe(0n)
    expect(csvValue(csv, 'period_id')).toBe('FIXTURE-2126-Q3')
    expect(parsedBoxSection(csv)).toEqual([])
  })
})

describe('the export surface is enumerated, so a new function must be classified', () => {
  it('matches the module and names exactly one path that needs a signed return', () => {
    // From the real module namespace rather than a hand-written list, M-VAT-08's arrangement: a function
    // added here cannot arrive without somebody deciding in writing whether it may see an unsigned
    // return. Lower-case names only — the classes and constant objects are not paths that export one.
    const exported = Object.entries(service)
      .filter(([name, value]) => typeof value === 'function' && /^[a-z]/.test(name))
      .map(([name]) => name)
      .sort()
    expect(exported.length).toBeGreaterThan(2)
    expect(ZOHO_EXPORT_SURFACE.map((entry) => entry.export).sort()).toEqual(exported)
    // Every entry says WHY, because a classification with no reason is one nobody can review.
    expect(ZOHO_EXPORT_SURFACE.every((entry) => entry.why.length > 30)).toBe(true)
    // And exactly one requires a signed return. A second arriving without its own behavioural case in
    // the integration suite fails here rather than passing silently.
    expect(
      ZOHO_EXPORT_SURFACE.filter((entry) => entry.requiresSignedReturn).map(
        (entry) => entry.export,
      ),
    ).toEqual(['exportVatReturnForZoho'])
  })

  it('offers no function whose name is a read back from the accounting package', () => {
    // The structural half is `scripts/test-no-autofile.mjs`, which scans this module's source. This is the
    // same claim made over the loaded namespace, so a re-export from somewhere else would be caught too.
    const inbound = /^(import|fetch|pull|poll|download|receive|sync)/
    const reads = Object.keys(service).filter((name) => inbound.test(name))
    expect(reads).toEqual([])
    // The control: the matcher must be able to see such a name at all.
    expect(inbound.test('importFromZoho')).toBe(true)
  })
})
