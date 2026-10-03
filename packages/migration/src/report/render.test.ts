import { describe, expect, it } from 'vitest'
import {
  RECONCILIATION_REPORT_SCHEMA,
  type ReconciliationReport,
  recordReconciliationRun,
  varianceOf,
} from './generate.ts'
import {
  ABSENT,
  renderReconciliationReport,
  renderReconciliationRun,
  reportFigures,
} from './render.ts'

/**
 * The fifth acceptance line: the machine-readable and human-readable forms come from ONE source, and
 * the test is what holds them equal.
 *
 * The comparison is deliberately not "the renderer mentions the fields I remembered to list". It counts
 * the LEAVES of the machine-readable form, independently of the renderer, and requires the human form to
 * carry one line per leaf with that leaf's value in it. A field added to the report with no change to
 * `render.ts` therefore stays covered, and a renderer that dropped a section fails by the count.
 */

const REPORT: ReconciliationReport = {
  schema: RECONCILIATION_REPORT_SCHEMA,
  sources: [
    {
      importer: 'packages',
      importerVersion: '1',
      sourceFile: 'packages.tsv',
      sourceFileHash: 'a1b2',
      runId: 'run-1',
      mode: 'live',
      state: 'completed',
      recordRelation: 'public.imported_package_sale',
      sourceRows: 4,
      appliedRows: 3,
      skippedRows: 0,
      rejectedRows: 1,
      pendingRows: 0,
      importedRows: 3,
      sourceTotalFils: 415_000,
      importedTotalFils: 400_000,
      totalBasis: 'measured',
      unreadableMoneyCells: 1,
      quarantinedRows: 0,
    },
    {
      importer: 'customers',
      importerVersion: '1',
      sourceFile: 'contacts.tsv',
      sourceFileHash: 'c3d4',
      runId: 'run-2',
      mode: 'live',
      state: 'completed',
      recordRelation: 'public.imported_contact',
      sourceRows: 2,
      appliedRows: 2,
      skippedRows: 0,
      rejectedRows: 0,
      pendingRows: 0,
      importedRows: 2,
      sourceTotalFils: null,
      importedTotalFils: null,
      totalBasis: 'none_by_construction',
      unreadableMoneyCells: 0,
      quarantinedRows: 1,
    },
  ],
  liability: {
    outstandingPackageLiabilityFils: 300_000,
    packageDeferredRevenueFils: 300_000,
    reconstructedPackages: 3,
    fullyDrawnPackages: 1,
    leaveOpeningBalanceHundredths: 1_250,
    leaveOpeningBalanceEmployees: 2,
    leaveOpeningBalanceProvisional: 1,
    leaveLiabilityFils: null,
    leaveLiabilityBasis: 'unattributable',
    leaveLiabilityOpenQuestionId: 'Y8-staff',
  },
  dedup: {
    contactRecords: 2,
    contactsCreated: 1,
    contactsMatched: 0,
    contactsQuarantined: 1,
    distinctContactKeys: 2,
    repeatedContactKeys: 0,
    consentClaimsDiscarded: 1,
  },
  quarantine: [
    {
      relation: 'public.imported_contact',
      recordId: 'rec-1',
      reason: 'unsupported_country',
      importer: 'customers',
      sourceFile: 'contacts.tsv',
      sourceLine: 7,
      contentHash: 'deadbeef',
      runId: 'run-2',
    },
  ],
  quarantineCounts: [{ relation: 'public.imported_contact', enumerated: 1, counted: 1 }],
  variances: [
    varianceOf({
      subject: 'packages/a1b2/rows',
      measure: 'rows',
      sourceFigure: 4,
      importedFigure: 3,
      explained: [{ cause: 'rejected_rows', figure: 1 }],
    }),
  ],
  unexplainedVariances: 0,
}

/** The leaves of the machine-readable form, counted without asking the renderer. */
function leaves(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.length === 0 ? ['(none)'] : value.flatMap((item) => leaves(item))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).flatMap((item) => leaves(item))
  }
  if (value === null) return [ABSENT]
  if (typeof value === 'boolean') return [value ? 'yes' : 'no']
  return [String(value)]
}

describe('the two forms', () => {
  it('states one figure per leaf of the machine-readable form', () => {
    expect(reportFigures(REPORT).map((figure) => figure.value)).toEqual(leaves(REPORT))
  })

  it('renders every one of those figures into the human-readable form', () => {
    const text = renderReconciliationReport(REPORT)
    for (const figure of reportFigures(REPORT)) {
      expect(text, figure.path).toContain(`${figure.path} = ${figure.value}`)
    }
  })

  it('does not pass vacuously: a figure the report does not hold is absent from the text', () => {
    // The control. The assertion above is a containment check, which an all-containing string would
    // satisfy; this is what says the text is about THIS report.
    const text = renderReconciliationReport(REPORT)
    expect(text).not.toContain('sourceRows = 99')
    expect(text).not.toContain('liability.leaveLiabilityFils = 0')
  })

  it('renders an absent figure as a dash and never as a zero', () => {
    const text = renderReconciliationReport(REPORT)
    expect(text).toContain(`liability.leaveLiabilityFils = ${ABSENT}`)
    expect(text).toContain('liability.leaveLiabilityBasis = unattributable')
    // ADR 0070 in one character: a zero here would read as a workforce owed nothing for accrued leave.
    expect(ABSENT).not.toBe('0')
  })

  it('says a list is empty rather than rendering nothing for it', () => {
    const text = renderReconciliationReport({ ...REPORT, quarantine: [] })
    // A section that renders nothing is indistinguishable from a section somebody forgot.
    expect(text).toContain('quarantine = (none)')
  })

  it('states the verdict in words, both ways', () => {
    expect(renderReconciliationReport(REPORT)).toContain(
      'VERDICT: every variance is tied to a named cause.',
    )
    const failing = renderReconciliationReport({ ...REPORT, unexplainedVariances: 2 })
    expect(failing).toContain('VERDICT: 2 variance(s) no named cause accounts for.')
  })
})

describe('the run instant', () => {
  it('appears in the header and nowhere in the body', () => {
    const run = recordReconciliationRun(REPORT, new Date('2026-10-03T08:00:00.000Z'))
    const text = renderReconciliationRun(run)
    expect(text).toContain('generated-at: 2026-10-03T08:00:00.000Z')
    expect(renderReconciliationReport(run.report)).not.toContain('2026-10-03')
  })

  it('leaves the body byte-identical between two runs over one report', () => {
    const first = recordReconciliationRun(REPORT, new Date('2026-10-03T08:00:00.000Z'))
    const second = recordReconciliationRun(REPORT, new Date('2026-11-01T23:59:59.000Z'))
    expect(renderReconciliationReport(first.report)).toBe(renderReconciliationReport(second.report))
    expect(renderReconciliationRun(first)).not.toBe(renderReconciliationRun(second))
  })
})
