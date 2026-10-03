import { describe, expect, it } from 'vitest'
import {
  canonicalDrillReport,
  DRILL_REPORT_RULES,
  DRILL_REPORT_VERSION,
  type DrillReport,
  drillReportProblems,
  drillRunProblems,
  RESTORE_DRILL_RULES,
  readBackFailures,
  reconcileRowCounts,
} from './restore-drill.ts'

const PREFIX_DIGEST = 'a'.repeat(64)

/** A report of a drill that proved what a drill can prove here. Every case below spoils one field. */
const report = (overrides: Partial<DrillReport> = {}): DrillReport => ({
  reportVersion: DRILL_REPORT_VERSION,
  runAtIso: '2026-10-03T09:00:00.000Z',
  machine: {
    platform: 'linux',
    cpus: 4,
    totalMemoryBytes: 16_000_000_000,
    loadAverage1m: 3.1,
    postgresVersion: '16.13',
    measuredOn: 'agent_container',
  },
  source: { database: 'berelax_probe', migrationCount: 3, migrationPrefixDigest: PREFIX_DIGEST },
  backup: {
    tool: 'pg_dump',
    format: 'custom',
    byteLength: 2_000_000,
    tocEntries: 900,
    startedAtIso: '2026-10-03T09:00:00.000Z',
    finishedAtIso: '2026-10-03T09:00:04.000Z',
    durationMs: 4000,
  },
  restore: {
    tool: 'pg_restore',
    startedAtIso: '2026-10-03T09:00:05.000Z',
    finishedAtIso: '2026-10-03T09:00:12.000Z',
    durationMs: 7000,
    exitCode: 0,
  },
  pitr: {
    configured: false,
    walLevel: 'replica',
    archiveMode: 'off',
    reason: 'no WAL archive is configured on this server',
  },
  verification: {
    tablesCompared: 130,
    rowsCompared: 42_000,
    mismatches: [],
    derivedViews: [],
    readBacks: [{ claim: 'the legal entity singleton', expected: 'one row', actual: 'one row' }],
    suite: { name: 'restore-drill.itest.ts', ran: true, exitCode: 0, skippedReason: null },
    invariants: { name: 'money-invariants', ran: true, exitCode: 0, skippedReason: null },
  },
  dataLossWindowMs: 8000,
  objectives: {
    rpoSeconds: null,
    rtoSeconds: null,
    backupRetentionDays: null,
    drillMaxAgeDays: null,
    openQuestionId: 'Y13-rpo-rto',
  },
  notProved: ['no restore onto different hardware'],
  digest: 'b'.repeat(64),
  ...overrides,
})

const rules = (problems: readonly { rule: string }[]) => problems.map((problem) => problem.rule)

describe('row-count reconciliation', () => {
  it('reports a table that came back short, and the one that did not come back at all', () => {
    const mismatches = reconcileRowCounts(
      [
        { table: 'public.invoice', rows: 188 },
        { table: 'public.appointment', rows: 250 },
        { table: 'public.room', rows: 5 },
      ],
      [
        { table: 'public.invoice', rows: 187 },
        { table: 'public.room', rows: 5 },
      ],
    )
    expect(mismatches).toEqual([
      { table: 'public.invoice', source: 188, restored: 187 },
      { table: 'public.appointment', source: 250, restored: null },
    ])
  })

  // The direction nobody expects, and the one that matters most: a table in the restore and not in the
  // source means the target was NOT created from nothing, so every count in the report is a comparison
  // against somebody else's rows.
  it('reports a table present in the restore and absent from the source', () => {
    expect(reconcileRowCounts([], [{ table: 'public.leftover', rows: 1 }])).toEqual([
      { table: 'public.leftover', source: null, restored: 1 },
    ])
  })

  it('agrees when the two sides agree, and does not report a reordering', () => {
    const left = [
      { table: 'public.a', rows: 1 },
      { table: 'public.b', rows: 2 },
    ]
    expect(reconcileRowCounts(left, [...left].reverse())).toEqual([])
  })
})

describe('read-back', () => {
  it('fails a row that came back different, absent, or with nothing to compare against', () => {
    const failures = readBackFailures([
      { claim: 'equal', expected: 'x', actual: 'x' },
      { claim: 'different', expected: 'x', actual: 'y' },
      { claim: 'absent', expected: 'x', actual: null },
      { claim: 'no expectation', expected: null, actual: 'y' },
    ])
    expect(failures.map((entry) => entry.claim)).toEqual(['different', 'absent', 'no expectation'])
  })
})

describe('the drill run', () => {
  it('passes a run that restored, reconciled and read a row back', () => {
    expect(drillRunProblems(report())).toEqual([])
  })

  it('refuses a run that compared no tables, naming the rule', () => {
    const problems = drillRunProblems(
      report({ verification: { ...report().verification, tablesCompared: 0 } }),
    )
    expect(rules(problems)).toContain(RESTORE_DRILL_RULES.examinedNothing)
  })

  // ADR 0002 in this unit's own subject, and the dispatch's words: a drill that does not read a row
  // back proves that two commands exited zero.
  it('refuses a run that read no row back out of the restored database', () => {
    const problems = drillRunProblems(
      report({ verification: { ...report().verification, readBacks: [] } }),
    )
    expect(rules(problems)).toContain(RESTORE_DRILL_RULES.examinedNothing)
  })

  it('refuses a backup whose table of contents is empty', () => {
    const problems = drillRunProblems(report({ backup: { ...report().backup, tocEntries: 0 } }))
    expect(rules(problems)).toContain(RESTORE_DRILL_RULES.backupEmpty)
  })

  it('refuses a row-count mismatch and a failed read-back separately', () => {
    const base = report().verification
    expect(
      rules(
        drillRunProblems(
          report({
            verification: {
              ...base,
              mismatches: [{ table: 'public.invoice', source: 188, restored: 0 }],
            },
          }),
        ),
      ),
    ).toContain(RESTORE_DRILL_RULES.rowCountMismatch)
    expect(
      rules(
        drillRunProblems(
          report({
            verification: {
              ...base,
              readBacks: [
                { claim: 'the legal entity singleton', expected: 'one row', actual: null },
              ],
            },
          }),
        ),
      ),
    ).toContain(RESTORE_DRILL_RULES.readBackFailed)
  })

  it('refuses a suite that ran against the restored database and failed', () => {
    const problems = drillRunProblems(
      report({
        verification: {
          ...report().verification,
          suite: { name: 'restore-drill.itest.ts', ran: true, exitCode: 1, skippedReason: null },
        },
      }),
    )
    expect(rules(problems)).toContain(RESTORE_DRILL_RULES.suiteFailed)
  })
})

describe('the committed evidence', () => {
  const good = report()
  const base = {
    report: good,
    recomputedDigest: good.digest,
    migrationsOnDisk: 5,
    prefixDigestOnDisk: PREFIX_DIGEST,
    nowIso: '2026-10-04T09:00:00.000Z',
    maxAgeDays: null,
  } as const

  it('accepts a recorded drill whose migration set is still a prefix of the tree', () => {
    expect(drillReportProblems(base)).toEqual([])
  })

  it('refuses an absent artefact by name', () => {
    expect(rules(drillReportProblems({ ...base, report: null }))).toEqual([
      DRILL_REPORT_RULES.missing,
    ])
  })

  // The edit nobody would notice: a mismatch list from one entry to none. Recomputing the digest means
  // running the drill, which means performing the restore.
  it('refuses a hand-edited figure through the digest', () => {
    expect(rules(drillReportProblems({ ...base, recomputedDigest: 'c'.repeat(64) }))).toContain(
      DRILL_REPORT_RULES.digestMismatch,
    )
  })

  it('refuses a report that claims no limitations', () => {
    expect(rules(drillReportProblems({ ...base, report: report({ notProved: [] }) }))).toContain(
      DRILL_REPORT_RULES.malformed,
    )
  })

  it('refuses evidence about a migration that has since been changed', () => {
    expect(rules(drillReportProblems({ ...base, prefixDigestOnDisk: 'd'.repeat(64) }))).toContain(
      DRILL_REPORT_RULES.staleSchema,
    )
  })

  // The whole argument for a prefix rule rather than a calendar: appending a migration does not make
  // yesterday's restore untrue, so a unit that adds one does not have to re-run the drill to be green.
  it('does NOT refuse evidence merely because migrations have been appended since', () => {
    expect(drillReportProblems({ ...base, migrationsOnDisk: 400 })).toEqual([])
  })

  it('refuses a report older than a configured maximum age, and judges nothing when none is set', () => {
    const later = { ...base, nowIso: '2026-12-01T09:00:00.000Z' }
    expect(drillReportProblems(later)).toEqual([])
    expect(rules(drillReportProblems({ ...later, maxAgeDays: 30 }))).toContain(
      DRILL_REPORT_RULES.tooOld,
    )
    // And the figure may come from the artefact instead of the flag, which is how a decided figure
    // takes effect without every caller passing it.
    expect(
      rules(
        drillReportProblems({
          ...later,
          report: report({ objectives: { ...good.objectives, drillMaxAgeDays: 30 } }),
        }),
      ),
    ).toContain(DRILL_REPORT_RULES.tooOld)
  })

  it('refuses a report where nothing was run against the restored database', () => {
    const problems = drillReportProblems({
      ...base,
      report: report({
        verification: {
          ...good.verification,
          suite: {
            name: 'restore-drill.itest.ts',
            ran: false,
            exitCode: null,
            skippedReason: 'off',
          },
          invariants: {
            name: 'money-invariants',
            ran: false,
            exitCode: null,
            skippedReason: 'off',
          },
        },
      }),
    })
    expect(rules(problems)).toContain(DRILL_REPORT_RULES.didNotVerify)
  })

  it('refuses a report written in a format this build does not read', () => {
    expect(rules(drillReportProblems({ ...base, report: report({ reportVersion: 99 }) }))).toEqual([
      DRILL_REPORT_RULES.malformed,
    ])
  })
})

describe('the report digest', () => {
  it('ignores key order and the digest field itself, so a re-serialisation is not a hand edit', () => {
    const ordered = canonicalDrillReport(report())
    // The same report with every key in the opposite order and a different `digest` value, which is
    // what a re-serialisation by another code path looks like.
    const reversed = Object.fromEntries(
      Object.entries({ ...report(), digest: 'z'.repeat(64) }).reverse(),
    ) as unknown as DrillReport
    const shuffled = canonicalDrillReport(reversed)
    expect(shuffled).toBe(ordered)
    expect(ordered).not.toContain('"digest"')
  })

  it('changes when any figure changes', () => {
    expect(canonicalDrillReport(report({ dataLossWindowMs: 9000 }))).not.toBe(
      canonicalDrillReport(report()),
    )
  })
})
