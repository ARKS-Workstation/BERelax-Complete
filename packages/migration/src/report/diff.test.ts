import { describe, expect, it } from 'vitest'
import {
  checkRecordedRun,
  checkRecordedRuns,
  DRY_RUN_RULES,
  diffReconciliationReports,
  MINIMUM_RECORDED_DRY_RUNS,
  parseRecordedDryRun,
  REMINTED_FIELDS,
  type RecordedDryRun,
} from './diff.ts'
import {
  RECONCILIATION_REPORT_SCHEMA,
  type ReconciliationReport,
  reportContentDigest,
  varianceOf,
} from './generate.ts'

/**
 * H-MIG-09's gate, with a control against every rule.
 *
 * Each rule here is one the gate must be able to FAIL by, so each has a case that constructs the bad
 * input and asserts the rule by name. A gate whose known-bad fixture is only "the file is missing" is a
 * gate that has never been seen to fail for the reason it exists (ADR 0003).
 */

const source = (over: Partial<ReconciliationReport['sources'][number]> = {}) => ({
  importer: 'customers',
  importerVersion: '1',
  sourceFile: 'corpus/contacts.tsv',
  sourceFileHash: 'a1b2',
  runId: '01a0ff89-0000-7000-8000-000000000001',
  mode: 'live',
  state: 'completed',
  recordRelation: 'public.imported_contact',
  sourceRows: 12,
  appliedRows: 12,
  skippedRows: 0,
  rejectedRows: 0,
  pendingRows: 0,
  importedRows: 12,
  sourceTotalFils: null,
  importedTotalFils: null,
  totalBasis: 'none_by_construction' as const,
  unreadableMoneyCells: 0,
  quarantinedRows: 4,
  ...over,
})

const report = (over: Partial<ReconciliationReport> = {}): ReconciliationReport => ({
  schema: RECONCILIATION_REPORT_SCHEMA,
  sources: [source()],
  liability: {
    outstandingPackageLiabilityFils: 0,
    packageDeferredRevenueFils: 0,
    reconstructedPackages: 0,
    fullyDrawnPackages: 0,
    leaveOpeningBalanceHundredths: 0,
    leaveOpeningBalanceEmployees: 0,
    leaveOpeningBalanceProvisional: 0,
    leaveLiabilityFils: null,
    leaveLiabilityBasis: 'unattributable',
    leaveLiabilityOpenQuestionId: 'Y8-staff',
  },
  dedup: {
    contactRecords: 12,
    contactsCreated: 6,
    contactsMatched: 2,
    contactsQuarantined: 4,
    distinctContactKeys: 12,
    repeatedContactKeys: 0,
    consentClaimsDiscarded: 2,
  },
  quarantine: [
    {
      relation: 'public.imported_contact',
      recordId: '01a0ff89-0000-7000-8000-00000000000a',
      reason: 'unsupported_country',
      importer: 'customers',
      sourceFile: 'corpus/contacts.tsv',
      sourceLine: 7,
      contentHash: 'deadbeef',
      runId: '01a0ff89-0000-7000-8000-000000000001',
    },
  ],
  quarantineCounts: [{ relation: 'public.imported_contact', enumerated: 1, counted: 1 }],
  variances: [
    varianceOf({
      subject: 'customers/a1b2/rows',
      measure: 'rows',
      sourceFigure: 12,
      importedFigure: 12,
    }),
  ],
  unexplainedVariances: 0,
  ...over,
})

const recorded = (runNumber: number, over: Partial<ReconciliationReport> = {}): RecordedDryRun => {
  const built = report(over)
  return {
    runNumber,
    generatedAt: `2026-10-0${runNumber}T08:00:00.000Z`,
    contentDigest: reportContentDigest(built),
    report: built,
    importersRun: [{ importer: 'customers', sourceFile: 'corpus/contacts.tsv' }],
    importersNotRun: [],
    postImportChecks: [{ name: 'money invariants', command: 'pnpm money-invariants', ok: true }],
  }
}

/** The same report with every reminted key changed, as a fresh database would produce. */
const reminted = (base: ReconciliationReport, suffix: string): ReconciliationReport => ({
  ...base,
  sources: base.sources.map((entry) => ({ ...entry, runId: `${entry.runId}-${suffix}` })),
  quarantine: base.quarantine.map((entry) => ({
    ...entry,
    recordId: `${entry.recordId}-${suffix}`,
    runId: `${entry.runId}-${suffix}`,
  })),
})

describe('the report diff', () => {
  it('classifies a changed surrogate key as reminted and nothing else', () => {
    const base = report()
    const diff = diffReconciliationReports(base, reminted(base, 'b'))
    expect(diff.material).toEqual([])
    // Counted rather than merely absent, so "no differences at all" — which a diff that walked nothing
    // would also report — is distinguishable from "only the keys moved".
    expect(diff.reminted.map((entry) => entry.path)).toEqual([
      'quarantine.0.recordId',
      'quarantine.0.runId',
      'sources.0.runId',
    ])
  })

  it('reports a changed count as material and names its path', () => {
    const diff = diffReconciliationReports(
      report(),
      report({ sources: [source({ importedRows: 11 })] }),
    )
    expect(diff.material.map((entry) => entry.path)).toContain('sources.0.importedRows')
    expect(diff.material[0]?.left).toBe('12')
    expect(diff.material[0]?.right).toBe('11')
  })

  it('reports a figure that appeared or vanished as material even in a reminted field', () => {
    // A quarantine row that appeared is not a reminted key, whatever the name of the field that differs.
    const base = report()
    const diff = diffReconciliationReports(base, report({ quarantine: [] }))
    expect(diff.reminted).toEqual([])
    expect(diff.material.some((entry) => entry.path.endsWith('.recordId'))).toBe(true)
  })

  it('does not excuse a changed hash, which is opaque hex like the keys it does excuse', () => {
    /*
      The control on REMINTED_FIELDS being a NAME list rather than a shape test. `sourceFileHash` and
      `contentHash` are the two values whose changing matters most — a source file that is not the file
      the last run imported — and a "looks like a uuid or a hash" rule would have excused both.
    */
    expect(REMINTED_FIELDS).not.toContain('sourceFileHash')
    expect(REMINTED_FIELDS).not.toContain('contentHash')
    const diff = diffReconciliationReports(
      report(),
      report({ sources: [source({ sourceFileHash: 'ffff' })] }),
    )
    expect(diff.material.map((entry) => entry.path)).toContain('sources.0.sourceFileHash')
  })
})

describe('one recorded run', () => {
  it('passes when its digest matches and nothing is unexplained', () => {
    expect(checkRecordedRun(recorded(1))).toEqual([])
  })

  it('fails when a figure was edited by hand without re-recording', () => {
    // The edit nobody would notice, and the reason the digest is stored at all.
    const tampered = {
      ...recorded(1),
      report: report({
        unexplainedVariances: 0,
        dedup: { ...report().dedup, contactsMatched: 99 },
      }),
    }
    expect(checkRecordedRun(tampered).map((problem) => problem.rule)).toContain(
      DRY_RUN_RULES.digestMatchesReport,
    )
  })

  it('fails on an unexplained variance and names the subject', () => {
    const bad = report({
      variances: [
        varianceOf({
          subject: 'customers/a1b2/rows',
          measure: 'rows',
          sourceFigure: 12,
          importedFigure: 11,
        }),
      ],
      unexplainedVariances: 1,
    })
    const problems = checkRecordedRun({
      ...recorded(1),
      report: bad,
      contentDigest: reportContentDigest(bad),
    })
    expect(problems.map((problem) => problem.rule)).toContain(DRY_RUN_RULES.noUnexplainedVariance)
    expect(problems[0]?.detail).toContain('customers/a1b2/rows')
  })

  it('fails on a run whose post-import check did not pass', () => {
    // A clean report over a database whose invariant census failed is the shape the fourth acceptance
    // line is about: the import reconciled and the books are still wrong.
    expect(
      checkRecordedRun({
        ...recorded(1),
        postImportChecks: [
          { name: 'money invariants', command: 'pnpm money-invariants', ok: false },
        ],
      }).map((problem) => problem.rule),
    ).toContain(DRY_RUN_RULES.postImportChecksPassed)
    // And a run that recorded no verdict at all, which would satisfy the line by saying nothing.
    expect(
      checkRecordedRun({ ...recorded(1), postImportChecks: [] }).map((problem) => problem.rule),
    ).toContain(DRY_RUN_RULES.postImportChecksPassed)
  })

  it('fails on a run that ran no importer at all', () => {
    // ADR 0002: a dry run of nothing has no variance and satisfies every check above it.
    expect(
      checkRecordedRun({ ...recorded(1), importersRun: [] }).map((problem) => problem.rule),
    ).toContain(DRY_RUN_RULES.statesAnImporter)
  })
})

describe('the set of recorded runs', () => {
  const three = () => {
    const base = report()
    const second = reminted(base, 'b')
    const third = reminted(base, 'c')
    return [
      { ...recorded(1), report: base, contentDigest: reportContentDigest(base) },
      { ...recorded(2), report: second, contentDigest: reportContentDigest(second) },
      { ...recorded(3), report: third, contentDigest: reportContentDigest(third) },
    ]
  }

  it('passes on three runs that differ only in a reminted key', () => {
    expect(checkRecordedRuns(three())).toEqual([])
  })

  it('fails while fewer than three exist', () => {
    expect(MINIMUM_RECORDED_DRY_RUNS).toBe(3)
    expect(checkRecordedRuns(three().slice(0, 2)).map((problem) => problem.rule)).toContain(
      DRY_RUN_RULES.threeRunsRecorded,
    )
    expect(checkRecordedRuns([]).map((problem) => problem.rule)).toContain(
      DRY_RUN_RULES.threeRunsRecorded,
    )
  })

  it('fails when two consecutive runs disagree about a figure', () => {
    const runs = three()
    const drifted = report({ sources: [source({ quarantinedRows: 3 })] })
    runs[1] = { ...runs[1], report: drifted, contentDigest: reportContentDigest(drifted) } as never
    const problems = checkRecordedRuns(runs)
    expect(problems.map((problem) => problem.rule)).toContain(DRY_RUN_RULES.consecutiveRunsAgree)
    expect(problems.map((problem) => problem.detail).join(' ')).toContain(
      'sources.0.quarantinedRows',
    )
  })

  it('compares in run-number order rather than in file order', () => {
    // A set handed over in the wrong order would otherwise diff run 3 against run 1 and report the
    // difference between them as the difference between consecutive runs.
    const [first, second, third] = three()
    expect(checkRecordedRuns([third, first, second] as never)).toEqual([])
  })
})

describe('parsing a recorded run', () => {
  it('refuses a file that is not one rather than reading fields off it loosely', () => {
    // Every check in this module reads a field. A loose parse makes them all pass over `undefined`.
    expect(() => parseRecordedDryRun('{}', 'x.json')).toThrow(/runNumber is not a number/)
    expect(() => parseRecordedDryRun('[]', 'x.json')).toThrow(/runNumber is not a number/)
    expect(() => parseRecordedDryRun('null', 'x.json')).toThrow(/not an object/)
    expect(() =>
      parseRecordedDryRun(JSON.stringify({ ...recorded(1), importersNotRun: 'none' }), 'x.json'),
    ).toThrow(/importersNotRun is not an array/)
    expect(() =>
      parseRecordedDryRun(JSON.stringify({ ...recorded(1), postImportChecks: 1 }), 'x.json'),
    ).toThrow(/postImportChecks is not an array/)
  })

  it('accepts one the driver wrote', () => {
    expect(parseRecordedDryRun(JSON.stringify(recorded(1)), 'x.json').runNumber).toBe(1)
  })
})
