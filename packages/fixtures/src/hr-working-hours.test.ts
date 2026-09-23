import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UPLIFT_BUCKETS, WORKED_MINUTE_BUCKETS } from '@berelax/core'
import { describe, expect, it } from 'vitest'

/**
 * P-HR-05 — the rate figures are DATA, proved by reading the source of the code that uses them.
 *
 * The acceptance criterion is that each bucket's multiplier is read from the versioned rate table and
 * that no multiplier literal appears in the function body. That is a statement about the *text* of two
 * modules, so this test reads them. It lives in `packages/fixtures` for the reason
 * `review-routing-table.test.ts` gives: `packages/core` may not import `node:fs` — the purity gate forbids
 * it — so a test that reads a file cannot live beside the file it reads.
 *
 * ## Why the scan is wider than the criterion
 *
 * The criterion says "the function body". This scans **both whole modules**, because a constant declared
 * at the top of the file and used in the body is the same defect one line further away, and it is the
 * form the mistake actually takes: nobody writes `minutes * 1.25` inline, they write
 * `const OVERTIME = 1.25` and feel tidy about it.
 *
 * Two rules, and each catches a different spelling of the same defect:
 *
 *   1. **No decimal literal at all.** Every quantity in this unit is a whole number of minutes or of
 *      basis points, so a number with a decimal point can only be a rate — `1.25`, `1.5`, `0.5` — or a
 *      float where ADR 0007 requires an integer. Both are refused by the same rule.
 *   2. **No integer literal in the basis-point range**, other than a short allowlist of structural
 *      bounds. A future rule set with a 200% public-holiday uplift would arrive as `20000`, which no list
 *      of today's figures would have caught.
 *
 * ## The control
 *
 * Both rules are run again over the same sources with a rate literal spliced in, and both must report it.
 * A scan whose regular expression stopped matching — because the modules were renamed, because the strip
 * dropped the whole file — would otherwise report a clean pass having examined nothing, which is ADR
 * 0003's whole subject.
 */
const REPO = join(import.meta.dirname, '..', '..', '..')

const SPLITTER = join(REPO, 'packages', 'core', 'src', 'hr', 'working-hours.ts')
const RATES = join(REPO, 'packages', 'core', 'src', 'hr', 'rates.ts')
const MIRROR = join(REPO, 'packages', 'db', 'src', 'schema', 'hr.ts')

/**
 * Comments, string literals and template literals blanked, so the prose explaining why 1.25 is not in the
 * code does not read as 1.25 being in the code. That mistake has been made in this repository before —
 * `check-schema-conventions.mjs` records reporting the word "timestamp" in a sentence about timestamps.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/**
 * Structural integers that are allowed to be four or five digits, each with a reason.
 *
 * `60000` is milliseconds in a minute, which is a unit conversion and not a rate. `10080` is the minutes
 * in a week, a bound on a column. Neither could be mistaken for a multiplier, and both are in the sources
 * today — an allowlist that had to be relaxed later would be the first sign this rule had stopped being
 * about rates.
 */
const STRUCTURAL = new Set([60_000, 10_080])

/** The rate literals found in a source, as strings, with the rule each broke. */
function rateLiteralsIn(source: string): readonly string[] {
  const code = codeOnly(source)
  const found: string[] = []
  for (const match of code.matchAll(/\b\d[\d_]*\.\d+\b/g)) {
    found.push(`decimal literal ${match[0]}`)
  }
  for (const match of code.matchAll(/\b\d[\d_]*\b/g)) {
    const value = Number(match[0].replace(/_/g, ''))
    if (Number.isInteger(value) && value >= 10_000 && !STRUCTURAL.has(value)) {
      found.push(`basis-point-sized literal ${match[0]}`)
    }
  }
  return found
}

describe('the working-hours multipliers are data and not code', () => {
  const splitter = readFileSync(SPLITTER, 'utf8')
  const rates = readFileSync(RATES, 'utf8')

  it('holds no rate literal in the splitter or in the rate module', () => {
    expect(rateLiteralsIn(splitter), 'packages/core/src/hr/working-hours.ts').toEqual([])
    expect(rateLiteralsIn(rates), 'packages/core/src/hr/rates.ts').toEqual([])
  })

  it('reads every multiplier through `multiplierBp` on the rule set it was given', () => {
    // Without this the rule above is satisfied by a module that mentions no numbers because it computes
    // nothing. Both files must actually reach for the rate table's field.
    expect(splitter).toContain('multiplierBp')
    expect(rates).toContain('rules.multiplierBp[bucket]')
  })

  it('catches a rate literal spliced into either spelling, which is the control', () => {
    const asConstant = splitter.replace(
      'export function workedMinutes(',
      'const OVERTIME_BP = 12500\nexport function workedMinutes(',
    )
    expect(asConstant).not.toBe(splitter)
    expect(rateLiteralsIn(asConstant)).toContain('basis-point-sized literal 12500')

    const asDecimal = rates.replace(
      'export function isWithinNightWindow(',
      'const NIGHT = 1.5\nexport function isWithinNightWindow(',
    )
    expect(asDecimal).not.toBe(rates)
    expect(rateLiteralsIn(asDecimal)).toContain('decimal literal 1.5')
  })

  it('does not blank a literal that is merely NEXT to a comment or a string', () => {
    // The second control, on the stripper rather than on the scan: a strip that swallowed too much would
    // make every source look clean. `12500` here is code, and the comment and the string beside it are not.
    const sample = "const a = 12500 // 1.25 in basis points\nconst b = 'the 15000 night rate'\n"
    expect(rateLiteralsIn(sample)).toEqual(['basis-point-sized literal 12500'])
  })
})

describe('the bucket vocabulary is spelled once per side', () => {
  const mirror = readFileSync(MIRROR, 'utf8')

  /** `publicHoliday` -> `public_holiday_multiplier_bp`, the column 0059 creates. */
  const columnFor = (bucket: string): string =>
    `${bucket.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_multiplier_bp`

  it('gives every bucket in @berelax/core a multiplier column in the Drizzle mirror', () => {
    expect(WORKED_MINUTE_BUCKETS.length).toBe(4)
    for (const bucket of WORKED_MINUTE_BUCKETS) {
      expect(mirror, `${bucket} has no column`).toContain(`'${columnFor(bucket)}'`)
    }
    // `ordinary` is in the list on purpose: it is pinned to the base rate by a CHECK and stored anyway,
    // so the splitter reads all four from the row and holds no rate of its own.
    expect(UPLIFT_BUCKETS).toEqual(['publicHoliday', 'night', 'overtime'])
  })

  it('finds nothing for a bucket that does not exist, which is the control', () => {
    expect(mirror).not.toContain(`'${columnFor('weekend')}'`)
  })
})
