import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACCOUNTS, accountFor, STANDARD_SPA_CHART } from '@berelax/core'
import {
  ACCOUNT_CODE_PATTERN,
  DEFAULT_GRATUITY_EXPENSE_ACCOUNT,
  DEFAULT_GRATUITY_LIABILITY_ACCOUNT,
  DEFAULT_GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT,
  GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY,
  GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY,
  GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT_SETTING_KEY,
} from '@berelax/shared'
import { getDefinition } from '@berelax/config'
import { describe, expect, it } from 'vitest'

/**
 * P-HR-13 — the gratuity posting rule names no account code, and the three defaults are the chart's.
 *
 * ## The two claims, and why they need this package
 *
 * `@berelax/config` declares the three account-code settings and may not import `@berelax/core`; `@berelax/core`
 * holds the chart those codes must exist in. So the default in the registry and the account in the chart are
 * two spellings of one code with nothing holding them equal — and `@berelax/fixtures` is the one package
 * allowed to import both, which is the same device the registry's `OWNER_ACCOUNTANT` list uses to stay equal
 * to the F07 permission matrix.
 *
 *   1. **Each default IS the chart's account**, and the account is of the right TYPE. A renumbered account
 *      then fails the build here rather than leaving a setting pointing at a code the chart no longer has —
 *      which would surface as a foreign-key violation from a monthly cron, months later.
 *   2. **No account code literal appears in the posting rule or in the job.** This is the acceptance
 *      criterion verbatim, and it is a scan rather than a convention because of how it regresses: not
 *      somebody deliberately hard-coding 2070, but a later unit adding a second posting and spelling the
 *      code inline because that is shorter than threading a setting through. A scan fails the build; a
 *      reviewer agrees that it looks fine.
 *
 * The chart is PROVISIONAL against `Y8-coa` — 0018 makes it a row rather than a constant precisely so an
 * accountant can map an existing chart — so a code written into a posting rule would be this build deciding
 * a classification, in a journal where changing it later means restating history (ADR 0017).
 *
 * Gate block 135 plants a code into the job and asserts this file fails, because a scan that has never been
 * seen to fail may not be a scan at all (ADR 0003).
 *
 * No database: a unit test.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..')

/** The two modules that may not name an account code. */
const POSTING_RULE = 'packages/core/src/hr/gratuity.ts'
const JOB = 'apps/worker/src/jobs/gratuity-accrual.ts'

const sourceOf = (file: string): string => readFileSync(join(ROOT, file), 'utf8')

/**
 * Everything that is not code, blanked: both kinds of comment and every string literal.
 *
 * A character walk rather than three `replace` calls, which is `scripts/check-schema-conventions.mjs`'s own
 * recorded reason: its two-`replace` version missed a case and refused a migration for a floating-point type
 * that was inside a comment. Here the direction that matters is the opposite one — a code mentioned in a
 * DOC COMMENT ("defaults to 2070") must not fail the scan, because the comments are where this file's own
 * reasoning is written and a scan that forbade explaining itself would be deleted by the first person it
 * annoyed.
 */
function codeOnly(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const two = source.slice(i, i + 2)
    if (two === '//') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (two === '/*') {
      i += 2
      while (i < source.length && source.slice(i, i + 2) !== '*/') i += 1
      i += 2
      continue
    }
    const ch = source[i] as string
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      // A blank of the same shape, so line and column numbers in a failure still point somewhere useful.
      out += '""'
      continue
    }
    out += ch
    i += 1
  }
  return out
}

/**
 * Four consecutive digits that are not part of a longer number and carry no numeric separator.
 *
 * Bounded both sides so `17_300`, `2678400` and `12` cannot match, and so a year in a date string cannot —
 * strings are blanked before this runs anyway. An account code in this chart is exactly four digits
 * (`account.code`'s own CHECK in 0018), which is what makes the shape recognisable at all.
 */
const ACCOUNT_CODE_LITERAL = /(?<![\d_.])\d{4}(?![\d_])/g

const literalsIn = (file: string): readonly string[] => [
  ...codeOnly(sourceOf(file)).matchAll(ACCOUNT_CODE_LITERAL),
].map((match) => match[0])

describe('the three account-code settings are the chart’s accounts', () => {
  it.each([
    [
      GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY,
      DEFAULT_GRATUITY_EXPENSE_ACCOUNT,
      ACCOUNTS.gratuityExpense,
      'expense',
    ],
    [
      GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY,
      DEFAULT_GRATUITY_LIABILITY_ACCOUNT,
      ACCOUNTS.gratuityLiability,
      'liability',
    ],
    [
      GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT_SETTING_KEY,
      DEFAULT_GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT,
      ACCOUNTS.wagesPayable,
      'liability',
    ],
  ])('%s defaults to the chart’s %s, an account of type %s', (key, shared, chartCode, type) => {
    // Three spellings held equal: the shared constant, the registry default, and the chart.
    expect(shared).toBe(chartCode as string)
    expect(getDefinition(key).defaultValue).toBe(shared)
    // And the account EXISTS in the chart and is of the type the posting rule needs. ZY173 checks the type
    // at the database; this checks it at the settings layer, where the answer is available before a cron
    // has run for a month.
    expect(accountFor(STANDARD_SPA_CHART, chartCode).type).toBe(type)
  })

  it('each default is the four-digit shape the settings schema and account.code both require', () => {
    for (const code of [
      DEFAULT_GRATUITY_EXPENSE_ACCOUNT,
      DEFAULT_GRATUITY_LIABILITY_ACCOUNT,
      DEFAULT_GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT,
    ]) {
      expect(ACCOUNT_CODE_PATTERN.test(code)).toBe(true)
    }
    // The control: the pattern must actually reject something, or the loop above proves nothing about it.
    for (const bad of ['203', '20700', 'abcd', '', '2_070']) {
      expect(ACCOUNT_CODE_PATTERN.test(bad)).toBe(false)
    }
  })

  it('the three settings are distinct keys pointing at distinct accounts', () => {
    const keys = new Set([
      GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY,
      GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY,
      GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT_SETTING_KEY,
    ])
    expect(keys.size).toBe(3)
    // Distinct accounts too: an expense and a liability collapsed onto one code would produce an entry that
    // balances perfectly and states nothing, which is M-TILL's recorded lesson about the gateway and
    // terminal clearing accounts sharing one.
    const codes = new Set([
      DEFAULT_GRATUITY_EXPENSE_ACCOUNT,
      DEFAULT_GRATUITY_LIABILITY_ACCOUNT,
      DEFAULT_GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT,
    ])
    expect(codes.size).toBe(3)
  })

  it('all three are compliance-locked and flagged provisional against the chart’s open question', () => {
    for (const key of [
      GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY,
      GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY,
      GRATUITY_SETTLEMENT_PAYABLE_ACCOUNT_SETTING_KEY,
    ]) {
      const definition = getDefinition(key)
      expect(definition.tier).toBe('compliance_locked')
      // The provisional marker is the whole reason these are settings: an account classification this build
      // chose must appear on the Unconfirmed Assumptions panel, or it is indistinguishable from one an
      // accountant agreed.
      expect(definition.provisional?.openQuestionId).toBe('Y8-coa')
      expect(definition.audited).toBe(true)
    }
  })
})

describe('no account code literal reaches the posting rule or the job', () => {
  it.each([[POSTING_RULE], [JOB]])('%s names no four-digit account code in code', (file) => {
    expect(literalsIn(file)).toEqual([])
  })

  it('the scan can see a code, so an empty result means something', () => {
    // The control, in memory. ADR 0003 wants a known-bad FIXTURE and gate block 135 plants one in the real
    // job; this is the cheaper half, and it is here because the expensive half cannot run in a unit test.
    // Without it, a `codeOnly` that returned the empty string would make both cases above pass for ever.
    const planted = codeOnly("const liability = accountCode('2070')\n")
    expect([...planted.matchAll(ACCOUNT_CODE_LITERAL)]).toHaveLength(0)
    const inCode = codeOnly('const liability = 2070\n')
    expect([...inCode.matchAll(ACCOUNT_CODE_LITERAL)].map((m) => m[0])).toEqual(['2070'])
  })

  it('a code in a COMMENT is allowed, because the reasoning is written in the comments', () => {
    const commented = codeOnly('// defaults to 2070 Gratuity liability\nconst x = 1\n')
    expect([...commented.matchAll(ACCOUNT_CODE_LITERAL)]).toHaveLength(0)
    // And the control for THAT: the same digits outside a comment are still caught, so the exemption is
    // about comments and not about the digits.
    expect([...codeOnly('const x = 2070\n').matchAll(ACCOUNT_CODE_LITERAL)]).toHaveLength(1)
  })

  it('does not mistake a separated numeric or a longer run of digits for an account code', () => {
    for (const source of ['const n = 17_300', 'const n = 2678400', 'const n = 377_580', 'const n = 12']) {
      expect([...codeOnly(`${source}\n`).matchAll(ACCOUNT_CODE_LITERAL)]).toHaveLength(0)
    }
  })

  it('the posting rule still names the accounts it uses, as ARGUMENTS', () => {
    // The other half of the claim: "no literal" is satisfied by a module that posts to no accounts at all.
    // `GratuityAccounts` is how the codes arrive, so its presence is what says the resolution happens.
    const source = sourceOf(POSTING_RULE)
    expect(source).toContain('export interface GratuityAccounts')
    expect(source).toContain('readonly expense: AccountCode')
    expect(source).toContain('readonly liability: AccountCode')
  })

  it('the job resolves both accounts from the settings registry by key', () => {
    const source = sourceOf(JOB)
    expect(source).toContain('GRATUITY_EXPENSE_ACCOUNT_SETTING_KEY')
    expect(source).toContain('GRATUITY_LIABILITY_ACCOUNT_SETTING_KEY')
    expect(source).toContain('readSetting')
  })
})

describe('no gratuity FIGURE is written in code either (brief rule 15)', () => {
  /**
   * The rate, the bands, the divisor and the cap.
   *
   * docs/04 §7 says only that gratuity is an accruing balance-sheet liability accrued monthly, so every
   * figure is a `gratuity_rule` column flagged provisional against `Y9-gratuity`. The scan is narrow on
   * purpose: it names the FIELDS rather than looking for the numbers 21 and 30, because those are ordinary
   * integers that appear legitimately in date arithmetic, and a scan for them would either be defeated by
   * `20 + 1` or would forbid `daysInMonth`.
   *
   * So the claim is structural: the engine reads every figure off the rules object, and a figure it did NOT
   * read off the rules object would have to be named here to be used at all.
   */
  const FIGURE_FIELDS = [
    'daysPerYearFirstBand',
    'daysPerYearAfterBand',
    'bandBoundaryYears',
    'dailyWageDaysDivisor',
    'probationMonths',
    'accruesDuringProbation',
    'unpaidLeaveDaysExcluded',
    'wageBasis',
  ] as const

  it('every figure the engine uses is read off the rules object', () => {
    const source = sourceOf(POSTING_RULE)
    for (const field of FIGURE_FIELDS) {
      expect(source).toContain(`rules.${field}`)
    }
  })

  it('there is no cap field at all, in the engine or in the rule type', () => {
    // Deliberately absent rather than nullable: the SHAPE of a cap is as unknown as its number, so a column
    // would be a place to put a figure the engine would then apply to the wrong quantity. If a later unit
    // answers Y9-gratuity with a cap, this assertion is what makes them change the ADR rather than add a
    // field quietly.
    const source = sourceOf(POSTING_RULE)
    for (const spelling of ['capFils', 'capMonths', 'capDays', 'maximumFils']) {
      expect(source).not.toContain(spelling)
    }
  })

  it('the job assigns every figure from the ROW and never from a literal', () => {
    /*
     * The first version of this case asserted the job did not MENTION the figure fields, and it was wrong
     * about its own subject: `asRules` maps a `gratuity_rule` row onto the engine's rules and has to name
     * every field to do it. Naming them there is the mapping, which is exactly where they belong.
     *
     * So the claim is the one that is actually true and actually worth making: every field is assigned
     * `row.<field>`, and no field is assigned a numeric or boolean literal. A job that spread a literal over
     * a version would be a policy change nothing records — the thing versioning the row exists to prevent —
     * and it would look entirely reasonable in review.
     */
    const code = codeOnly(sourceOf(JOB))
    for (const field of FIGURE_FIELDS) {
      expect(code, `${field} must be mapped from the row`).toContain(`row.${field}`)
      // No `field: 21`, `field: true` or `field: false` anywhere.
      expect(code).not.toMatch(new RegExp(`${field}\\s*:\\s*(?:\\d|true\\b|false\\b)`))
    }
  })
})
