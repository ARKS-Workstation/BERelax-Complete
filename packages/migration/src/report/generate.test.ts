import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PROBE_IMPORTER_NAME, PROBE_TARGET } from '../conformance/probe-importer.ts'
import { VISITS_IMPORTER_NAME, VISITS_IMPORTER_TARGETS } from '../importers/appointments/import.ts'
import {
  CUSTOMERS_IMPORTER_NAME,
  CUSTOMERS_IMPORTER_TARGETS,
} from '../importers/customers/import.ts'
import {
  DECLARED_OPENING_PAYLOAD_KEYS,
  OPENING_IMPORTER_NAME,
  OPENING_IMPORTER_TARGETS,
} from '../importers/ledger/opening-balances.ts'
import { PACKAGES_IMPORTER_NAME, PACKAGES_IMPORTER_TARGETS } from '../importers/packages/import.ts'
import { WORKBOOK_PAYLOAD_KEYS } from '../importers/packages/workbook.ts'
import { STAFF_IMPORTER_NAME, STAFF_IMPORTER_TARGETS } from '../importers/staff/import.ts'
import {
  IMPORT_RECORDS,
  QUARANTINE_RELATIONS,
  RECONCILIATION_REPORT_SCHEMA,
  type ReconciliationReport,
  readMoney,
  reconciliationExitStatus,
  recordReconciliationRun,
  reportContentBytes,
  reportContentDigest,
  SOURCE_TOTALS,
  unexplainedVarianceCount,
  VARIANCE_CAUSES,
  varianceOf,
} from './generate.ts'

/**
 * H-MIG-08's arithmetic, with a control against every claim.
 *
 * Everything in this file is pure: the variance decomposition, the residual, the exit status and the
 * two coverage maps. What needs a database — the readings themselves, the determinism of two runs and
 * the planted discrepancy — is in `packages/fixtures/src/migration-reconciliation.itest.ts`, because
 * every one of those claims is a claim about PostgreSQL.
 */

const EMPTY: ReconciliationReport = {
  schema: RECONCILIATION_REPORT_SCHEMA,
  sources: [],
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
    contactRecords: 0,
    contactsCreated: 0,
    contactsMatched: 0,
    contactsQuarantined: 0,
    distinctContactKeys: 0,
    repeatedContactKeys: 0,
    consentClaimsDiscarded: 0,
  },
  quarantine: [],
  quarantineCounts: [],
  variances: [],
  unexplainedVariances: 0,
}

describe('the variance decomposition', () => {
  it('subtracts each named cause and leaves the residual as unexplained', () => {
    const variance = varianceOf({
      subject: 'packages/abc/rows',
      measure: 'rows',
      sourceFigure: 10,
      importedFigure: 6,
      explained: [
        { cause: 'rejected_rows', figure: 2 },
        { cause: 'skipped_already_imported', figure: 1 },
        { cause: 'pending_rows', figure: 0 },
      ],
    })
    expect(variance.variance).toBe(4)
    // THE control the whole unit rests on. Three of the four rows are accounted for and the fourth is
    // the one somebody has to go and find — a report that said "there were rejections" would call this
    // explained.
    expect(variance.unexplained).toBe(1)
    // A cause of 0 is not listed: an explanation of nothing makes a variance look partly accounted for.
    expect(variance.explained.map((entry) => entry.cause)).toEqual([
      'rejected_rows',
      'skipped_already_imported',
    ])
  })

  it('reports zero unexplained when the causes account for the whole variance', () => {
    const variance = varianceOf({
      subject: 'packages/abc/fils',
      measure: 'fils',
      sourceFigure: 415_000,
      importedFigure: 400_000,
      explained: [{ cause: 'rejected_rows', figure: 15_000 }],
    })
    expect(variance.unexplained).toBe(0)
  })

  it('keeps the sign, because the two directions are different incidents', () => {
    // More imported than the file holds is a row nothing attests to; fewer is a row that did not land.
    // An absolute residual would make the first indistinguishable from the second.
    expect(
      varianceOf({ subject: 's', measure: 'rows', sourceFigure: 3, importedFigure: 4 }).unexplained,
    ).toBe(-1)
  })

  it('refuses a fractional contribution rather than rounding it', () => {
    // The rounding allowance this unit exists to refuse, arriving as a contribution rather than as a
    // tolerance. Money is integer fils (ADR 0007), so 0.5 of a fil is not a smaller error — it is a
    // different kind of claim.
    expect(() =>
      varianceOf({
        subject: 's',
        measure: 'fils',
        sourceFigure: 10,
        importedFigure: 9,
        explained: [{ cause: 'rejected_rows', figure: 0.5 }],
      }),
    ).toThrow(/not an integer/)
  })

  it('names exactly the three row states that can account for a variance', () => {
    // A fourth cause would have to be a fourth state of a staged row, and there is none. Held as a
    // literal list so that adding one is a deliberate act with this test in front of it.
    expect([...VARIANCE_CAUSES]).toEqual([
      'rejected_rows',
      'skipped_already_imported',
      'pending_rows',
    ])
  })
})

describe('the exit status', () => {
  it('is 0 when nothing is unexplained and 1 when anything is', () => {
    expect(reconciliationExitStatus(EMPTY)).toBe(0)
    expect(reconciliationExitStatus({ ...EMPTY, unexplainedVariances: 1 })).toBe(1)
    // 1 and not 2: an exit status is not a count, and the two agree at 0 and 1 and would diverge at 2.
    expect(reconciliationExitStatus({ ...EMPTY, unexplainedVariances: 7 })).toBe(1)
  })

  it('counts the variances no cause accounts for, not the contributions', () => {
    const variances = [
      varianceOf({ subject: 'a', measure: 'rows', sourceFigure: 1, importedFigure: 1 }),
      varianceOf({ subject: 'b', measure: 'rows', sourceFigure: 2, importedFigure: 1 }),
      varianceOf({ subject: 'c', measure: 'fils', sourceFigure: 5, importedFigure: 3 }),
    ]
    expect(unexplainedVarianceCount(variances)).toBe(2)
  })
})

describe('the compared content', () => {
  it('holds no instant anywhere, so two runs over one report compare equal', () => {
    const first = recordReconciliationRun(EMPTY, new Date('2026-10-03T08:00:00.000Z'))
    const second = recordReconciliationRun(EMPTY, new Date('2026-10-04T19:30:00.000Z'))
    expect(first.generatedAt).not.toBe(second.generatedAt)
    // The claim: the instants differ and the compared content does not.
    expect(reportContentBytes(first.report)).toBe(reportContentBytes(second.report))
    expect(first.contentDigest).toBe(second.contentDigest)
    // The control. If the digest ignored the report's content it would also be equal here, so a
    // different report must produce a different digest.
    expect(reportContentDigest({ ...EMPTY, unexplainedVariances: 1 })).not.toBe(first.contentDigest)
  })

  it('does not carry generatedAt inside the report', () => {
    const run = recordReconciliationRun(EMPTY, new Date('2026-10-03T08:00:00.000Z'))
    expect(JSON.stringify(run.report)).not.toContain('2026-10-03')
    expect(JSON.stringify(run.report)).not.toContain('generatedAt')
  })
})

describe('what the report covers', () => {
  const IMPORTER_TARGETS: Readonly<Record<string, readonly string[]>> = {
    [PACKAGES_IMPORTER_NAME]: PACKAGES_IMPORTER_TARGETS,
    [CUSTOMERS_IMPORTER_NAME]: CUSTOMERS_IMPORTER_TARGETS,
    [VISITS_IMPORTER_NAME]: VISITS_IMPORTER_TARGETS,
    [STAFF_IMPORTER_NAME]: STAFF_IMPORTER_TARGETS,
    [OPENING_IMPORTER_NAME]: OPENING_IMPORTER_TARGETS,
    [PROBE_IMPORTER_NAME]: [PROBE_TARGET],
  }

  it('has a record relation for every importer in the build', () => {
    // An importer with no entry would have its rows reconciled against nothing, and the file would read
    // as fully imported — which `generateReconciliationReport` refuses at runtime, and this is what
    // stops the refusal ever being reached.
    expect(Object.keys(IMPORT_RECORDS).sort()).toEqual(Object.keys(IMPORTER_TARGETS).sort())
  })

  it('names a record relation the importer actually declares as a target', () => {
    for (const [importer, record] of Object.entries(IMPORT_RECORDS)) {
      expect(IMPORTER_TARGETS[importer], importer).toContain(record.relation)
    }
  })

  it('sums the source total out of a key the importer actually stages', () => {
    const declared: Readonly<Record<string, readonly string[]>> = {
      [PACKAGES_IMPORTER_NAME]: WORKBOOK_PAYLOAD_KEYS,
      [OPENING_IMPORTER_NAME]: DECLARED_OPENING_PAYLOAD_KEYS,
    }
    // A renamed cell is a test failure here instead of a total that silently reads zero, which is the
    // failure this whole unit is arranged against.
    expect(Object.keys(SOURCE_TOTALS).sort()).toEqual(Object.keys(declared).sort())
    for (const [importer, total] of Object.entries(SOURCE_TOTALS)) {
      for (const key of total.payloadKeys) {
        expect(declared[importer], `${importer}.${key}`).toContain(key)
      }
    }
  })

  it('declares a money column exactly for the importers whose source states money', () => {
    const withMoney = Object.entries(IMPORT_RECORDS)
      .filter(([, record]) => record.moneyColumn !== null)
      .map(([importer]) => importer)
      .sort()
    expect(withMoney).toEqual(Object.keys(SOURCE_TOTALS).sort())
  })

  it('enumerates quarantines only from relations that can hold one', () => {
    // `imported_package_sale` and `opening_balance_import` are absent because a reconstruction workbook
    // and an opening trial balance are all-or-nothing on validity (ADR 0065): a bad line is rejected at
    // staging and no record row is written at all.
    expect([...QUARANTINE_RELATIONS]).toEqual([
      'public.imported_contact',
      'public.imported_appointment',
      'public.imported_staff_row',
    ])
    for (const relation of QUARANTINE_RELATIONS) {
      expect(Object.values(IMPORT_RECORDS).map((record) => record.relation)).toContain(relation)
    }
  })
})

describe('a staged money cell', () => {
  it('is refused on an applied row and tolerated on a rejected one', () => {
    // The asymmetry, asserted through the real reader. A rejected row's price cell is frequently WHY it
    // was rejected (`price-not-integer-fils` is one of H-MIG-02's named rejections), so a report that
    // threw on it could not describe a failed import at all; an applied row's cell passed `validate`, so
    // an unreadable value there is a disagreement between the validator and this reader.
    const total = SOURCE_TOTALS[PACKAGES_IMPORTER_NAME]
    expect(total).toBeDefined()
    expect(() => total?.of({ pricePaidFils: '400.00' })).toThrow(/whole number of fils/)
  })

  it('refuses a decimal rather than reading a hundredth of it', () => {
    const total = SOURCE_TOTALS[PACKAGES_IMPORTER_NAME]
    expect(total).toBeDefined()
    expect(total?.of({ pricePaidFils: '40000' })).toBe(40_000)
    // `Number('40000.00')` is 40000 and an integer: a cell written in dirhams-and-cents would reconcile
    // at a hundredth of its value. H-MIG-07's recorded defect, in the column that decides a liability.
    expect(() => total?.of({ pricePaidFils: '400.00' })).toThrow(/whole number of fils/)
    expect(() => total?.of({})).toThrow(/whole number of fils/)
  })

  it('refuses an opening payload with no lines rather than totalling zero', () => {
    const total = SOURCE_TOTALS[OPENING_IMPORTER_NAME]
    expect(total?.of({ lines: [{ debitFils: 3 }, { debitFils: 4 }] })).toBe(7)
    expect(() => total?.of({ openingDate: '2026-10-01' })).toThrow(/carried no .lines. array/)
  })
})

describe('an unreadable money cell', () => {
  const total = { of: (payload: unknown) => wholeOrThrow(payload) }
  function wholeOrThrow(payload: unknown): number {
    const value = (payload as { fils?: unknown }).fils
    if (typeof value === 'number') return value
    throw new Error('unreadable')
  }

  it('is tolerated on a rejected row and refused on every other state', () => {
    // The ONE tolerance in this unit, and it is one branch of one function. A rejected row's cell is
    // frequently WHY it was rejected, so a report that threw could not describe a failed import at all.
    expect(readMoney(total, { state: 'rejected', payload: {} })).toBeNull()
    expect(readMoney(total, { state: 'rejected', payload: { fils: 7 } })).toBe(7)
    // An applied row's cell passed `validate`, so an unreadable value there is a disagreement between
    // the validator and this reader — and reporting it as 0 would make the file total quietly smaller
    // than the file.
    for (const state of ['applied', 'skipped', 'pending']) {
      expect(() => readMoney(total, { state, payload: {} }), state).toThrow(/unreadable/)
    }
  })
})

describe('the hand-over template', () => {
  const TEMPLATE = 'artifacts/migration/reconciliation-run-template.json'

  it('states the shape and not one figure', () => {
    /*
      Brief rule 15, checked rather than trusted. A plausible row count or variance in this file would
      be indistinguishable from a measured one the day somebody read it, and this artefact is the
      hand-over shape — the thing a reader opens to find out what the report will say.

      Every leaf under `report` must be null, or one of the three values that are facts about the SHAPE
      rather than about any database: the schema number, and the two strings that say why the leave
      liability has no figure.
    */
    const parsed = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as Record<string, unknown>
    expect(parsed['generatedAt']).toBeNull()
    expect(parsed['contentDigest']).toBeNull()
    const allowed = new Set<unknown>([
      null,
      RECONCILIATION_REPORT_SCHEMA,
      'unattributable',
      'Y8-staff',
    ])
    const leaves: { path: string; value: unknown }[] = []
    const walk = (value: unknown, path: string): void => {
      if (Array.isArray(value)) {
        // An empty list is the only list this file may hold: a populated one would be invented rows.
        expect(value, path).toHaveLength(0)
        return
      }
      if (typeof value === 'object' && value !== null) {
        for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`)
        return
      }
      leaves.push({ path, value })
    }
    walk(parsed['report'], 'report')
    // The control: a walk that reached nothing would make the assertion below vacuous.
    expect(leaves.length).toBeGreaterThan(14)
    for (const { path, value } of leaves) {
      expect(allowed, `${path} = ${JSON.stringify(value)}`).toContain(value)
    }
  })

  it('declares the same keys the report does', () => {
    const parsed = JSON.parse(readFileSync(TEMPLATE, 'utf8')) as {
      report: Record<string, unknown>
    }
    // A template that has drifted from the type is a hand-over document describing a report nobody
    // generates. `EMPTY` is typed, so a field added to the report appears here and must appear there.
    expect(Object.keys(parsed.report).sort()).toEqual(Object.keys(EMPTY).sort())
    expect(Object.keys(parsed.report['liability'] as object).sort()).toEqual(
      Object.keys(EMPTY.liability).sort(),
    )
    expect(Object.keys(parsed.report['dedup'] as object).sort()).toEqual(
      Object.keys(EMPTY.dedup).sort(),
    )
  })
})
