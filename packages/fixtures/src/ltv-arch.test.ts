import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  codeOnly,
  FORBIDDEN_FORECAST_CONSTRUCTS,
  LTV_ARCH_RULES,
  LTV_PATH_ENTRY_MODULES,
  type LtvArchFinding,
  ltvArchFindings,
  ltvPathClosure,
} from './ltv-arch.ts'

/**
 * The arch test: no forecasting, regression or projection code participates in the LTV path.
 *
 * Every case here pairs a claim with the control that must fail (brief rule 3), and the controls are
 * all of one shape because a scan is the one kind of check that passes most convincingly when it has
 * stopped working: an empty closure, a blanked pattern table and a renamed import each produce zero
 * findings and a green tick. So the real tree is asserted clean, and then each way the scan could have
 * been blind is produced deliberately and required to be noticed.
 */

/** Reads a repository-relative module, or `null`. The one piece of I/O; the rule takes it injected. */
const read = (modulePath: string): string | null => {
  try {
    return readFileSync(modulePath, 'utf8')
  } catch {
    return null
  }
}

/** A closure over modules supplied by hand, so a case can plant whatever it likes. */
const readFrom =
  (modules: Record<string, string>) =>
  (modulePath: string): string | null =>
    modules[modulePath] ?? null

const rulesOf = (findings: readonly LtvArchFinding[]): readonly string[] => [
  ...new Set(findings.map((finding) => finding.rule)),
]

describe('the LTV path', () => {
  it('holds no forecasting construct in the real tree', () => {
    expect(
      ltvArchFindings({
        read,
        // Named rather than left to the walk: these are the modules the figure's arithmetic goes
        // through, so a closure that no longer reaches one is a scan that has shrunk.
        mustReach: [
          'packages/core/src/reporting/cohorts.ts',
          'packages/core/src/reporting/cac.ts',
          'packages/core/src/reporting/kpi-expression.ts',
          'packages/core/src/reporting/contribution-margin.ts',
        ],
      }),
    ).toEqual([])
  })

  it('reaches the modules the figure is actually computed through', () => {
    const closure = ltvPathClosure({ read })
    // The vacuity control for the whole file. A closure of two modules would mean the walk stopped at
    // the entries, and every clean result below would then be about two files.
    expect(closure.length).toBeGreaterThanOrEqual(6)
    for (const entry of LTV_PATH_ENTRY_MODULES) expect(closure).toContain(entry)
    expect(closure).toContain('packages/core/src/reporting/kpi-expression.ts')
    expect(closure).toContain('packages/core/src/reporting/contribution-margin.ts')
    // It follows a `../` import out of the reporting directory, which is how the month arithmetic is
    // reached — so a forecast hidden one directory up is still on the path.
    expect(closure).toContain('packages/core/src/money/recurring-schedule.ts')
    expect(closure).toContain('packages/core/src/hr/leave-accrual.ts')
    // And it stops at the package boundary rather than wandering into `@berelax/shared`, which is the
    // bound the module's header states.
    expect(closure.every((modulePath) => modulePath.startsWith('packages/core/src/'))).toBe(true)
  })

  it('fires on a planted forecast, by the name of the rule', () => {
    const planted = ltvArchFindings({
      entries: ['a.ts'],
      read: readFrom({
        'a.ts': "import { x } from './b.ts'\nexport const value = () => x\n",
        'b.ts':
          'export const x = 1\n' +
          'export function projectedLifetimeValue(observed: number): number {\n' +
          '  return forecastFrom(observed)\n' +
          '}\n',
      }),
    })
    expect(rulesOf(planted)).toContain('ltv-path-holds-no-forecasting-construct')
    // Reported against the module it is IN and not against the entry, because a forecast two imports
    // away is the case the closure exists for.
    expect(planted.some((finding) => finding.module === 'b.ts')).toBe(true)
  })

  it('fires on each construct in the declared table', () => {
    const samples: readonly string[] = [
      'export const v = extrapolateValue(cohort)',
      'export const decayCurve = 1',
      'export const churnRateBp = 1',
      'export const v = Math.pow(base, months)',
      "import { regressionFit } from './stats.ts'",
    ]
    expect(samples).toHaveLength(FORBIDDEN_FORECAST_CONSTRUCTS.length)
    for (const sample of samples) {
      const findings = ltvArchFindings({
        entries: ['x.ts'],
        read: readFrom({ 'x.ts': `${sample}\n` }),
      })
      expect(
        findings.filter((finding) => finding.rule === 'ltv-path-holds-no-forecasting-construct'),
        `"${sample}" was not reported`,
      ).not.toEqual([])
    }
  })

  it('does not fire on prose that explains why there is no forecast', () => {
    // The failure `stripNonCode`'s own header records, one subject along: the colour gate's first run
    // flagged the Tailwind class names in the sentence explaining why Tailwind class names are
    // forbidden. The modules on this path have to carry this unit's whole argument, so a scan that
    // could not read past a comment would have had to be turned off.
    const findings = ltvArchFindings({
      entries: ['x.ts'],
      read: readFrom({
        'x.ts':
          '/**\n' +
          ' * No forecast, no regression and no projection participates in this figure.\n' +
          ' * Not Math.pow(1 + churnRate, months), and not a decayCurve of any kind.\n' +
          ' * **Four things**, and the first is what the other three are for.\n' +
          ' */\n' +
          '// const decayRate = 0.1 would be refused, which is why it is written here as a comment\n' +
          'export const realised = (a: bigint, b: bigint) => a / b\n',
      }),
    })
    expect(findings).toEqual([])
  })

  it('blanks a comment and keeps the line numbers', () => {
    const source = 'const a = 1\n// const decayRate = 2\nconst b = 3\n'
    const stripped = codeOnly(source)
    expect(stripped.split('\n')).toHaveLength(source.split('\n').length)
    expect(stripped).toContain('const a = 1')
    expect(stripped).toContain('const b = 3')
    expect(stripped).not.toContain('decayRate')
    // And the control: a construct in CODE survives, so the stripper is not simply blanking the file.
    expect(codeOnly('const decayRate = 2\n')).toContain('decayRate')
  })

  it('reports an empty closure rather than passing over it', () => {
    // The one way a scan of this shape is green and dead. An entry that cannot be read — renamed,
    // moved, deleted — produces no modules and therefore no construct findings.
    const findings = ltvArchFindings({ entries: ['does-not-exist.ts'], read: () => null })
    expect(rulesOf(findings)).toEqual(['ltv-path-closure-reaches-its-own-modules'])
  })

  it('reports a closure that no longer reaches a module it is meant to', () => {
    const findings = ltvArchFindings({
      entries: ['a.ts'],
      read: readFrom({ 'a.ts': 'export const v = 1\n' }),
      mustReach: ['b.ts'],
    })
    expect(rulesOf(findings)).toEqual(['ltv-path-closure-reaches-its-own-modules'])
    expect(findings[0]?.detail).toContain('b.ts')
  })

  it('names every rule it can report', () => {
    expect([...LTV_ARCH_RULES]).toEqual([
      'ltv-path-closure-reaches-its-own-modules',
      'ltv-path-holds-no-forecasting-construct',
    ])
  })
})
