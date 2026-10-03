import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * No NAP literal in the SEO analyses: the name, address, phone and hours come from the premises row.
 *
 * G-SEO-04's acceptance line, as the scan it asks for: *"NAP consistency is compared against the premises
 * row only: a grep test asserts no literal address, phone number or opening-hour string appears in any
 * file under packages/core/src/seo/."*
 *
 * ## Why this is a scan and not a code review
 *
 * "NAP consistency" means comparing what the site publishes against what the business is, and the only
 * authority for what the business is is `premises` (0003) by way of the facts payload. A module holding
 * its own copy of the address is a module that answers "consistent" about itself — and the failure is
 * silent, permanent and exactly the one the whole analysis exists to find. docs/09's NAP section is about
 * the same hazard one layer out: the address on the website, the address on the Google profile and the
 * address in the directory listings drift because each is a copy.
 *
 * A copy is also brief rule 15's hazard: a plausible-looking address written into a comparison is
 * indistinguishable from a configured one, and the first person to read it treats it as the answer.
 *
 * ## Why it lives in `packages/fixtures`
 *
 * It reads files. `packages/core` is pure — no I/O — and a scan of core's own source from inside core
 * would be the one test in the package that opens a file. `packages/fixtures` may depend on both core and
 * db, which is what makes it this repository's home for a scan (`sqlstate-registry.test.ts`,
 * `wps-no-submission.test.ts` and `write-path.test.ts` are the same shape).
 *
 * ## The two declared exemptions, and why each is asserted to be LIVE
 *
 * An exemption nothing checks is a hole that widens. Both of these are asserted to still match something,
 * so the day a file stops containing the literal the exemption covers, this test fails and the exemption
 * is deleted deliberately rather than inherited for ever.
 *
 *   - **`jsonld/specimen.ts`** holds the specimen payload: `1 Specimen Road`, `+97120000000`. Those are
 *     visibly specimens rather than plausible facts, which is the entire reason that file exists, and the
 *     graph tests and the CI gate both build from it.
 *   - **`jsonld/business.ts`** holds `START_OF_DAY` and `END_OF_DAY` — `00:00`, `23:59`, `24:00` — which
 *     are the schema.org encodings the midnight-crossing split needs, not this premises' hours.
 *
 * Tests and the worked-example fixture are out of scope: a test states the input it is asserting on, and
 * `analyses.worked-examples.fixture.ts` is a reviewed hand-computed expectation whose own header says it
 * is deliberately not exported.
 */

/**
 * The directories this scan walks, and why there are two.
 *
 * G-SEO-04's acceptance line names `packages/core/src/seo/`. G-SEO-06's names *"the checker or its write
 * adapter"*, which live in `packages/google` — and they are the two modules in this build with the
 * strongest reason to hold a copy of the hours, because comparing the premises against the Google profile
 * is literally what one of them does. A scan that covered only core would have reported a clean tree while
 * the module whose whole subject is NAP consistency answered "consistent" about its own literal.
 *
 * The google half is a FILE LIST rather than a directory walk, deliberately. `packages/google/src/seo/`
 * holds G-SEO-01's snapshot passes and G-SEO-05's drafting pass, none of which is about NAP, and widening
 * the walk to them would be a rule whose failures are mostly about modules it was not written for — the
 * shape `seo-site-analysis-must-take-the-untrusted-envelope` records as worse than no rule. The pair of
 * files is asserted to EXIST below, so a rename does not quietly empty the list.
 */
const ROOTS = [
  { root: new URL('../../core/src/seo/', import.meta.url).pathname, files: 'walk' as const },
  {
    root: new URL('../../google/src/', import.meta.url).pathname,
    files: ['seo/gbp-consistency.ts', 'adapters/business-information-write.ts'],
  },
]

const ROOT = ROOTS[0]?.root as string

/** One thing a module may not hold a literal of, and the pattern that finds it. */
const FORBIDDEN: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  {
    what: 'a telephone number',
    // E.164 or a national form with a UAE country code. Six digits after the code, so a year or a port
    // number cannot match: `+9712` alone is not a number anybody would mistake for one.
    pattern: /\+?971[\s-]?\d[\s-]?\d{3}[\s-]?\d{4}|\+971\d{6,}/,
  },
  {
    what: 'a street address',
    // One to three capitalised words between the number and the thoroughfare, because a real one has
    // them: `250 Al Meena Street` is three, and a pattern allowing one matched `1 Specimen Road` and
    // nothing a UAE address looks like — which is how a scan passes against the only literal that matters.
    pattern:
      /\b\d+[A-Za-z]?\s+(?:[A-Z][A-Za-z]+\s+){1,3}(Street|Road|Avenue|Boulevard|Lane|St\b|Rd\b)/,
  },
  {
    what: 'an opening-hour time',
    pattern: /['"`][0-2]\d:[0-5]\d['"`]/,
  },
]

/**
 * Files this scan does not read, each with the literal that justifies it.
 *
 * The `justifiedBy` pattern is not decoration: the test asserts the file still matches it, so an exemption
 * that has gone stale is a failure rather than a permission nobody can see the reason for any more.
 */
const EXEMPT: readonly {
  readonly file: string
  readonly why: string
  readonly justifiedBy: RegExp
}[] = [
  {
    file: 'jsonld/specimen.ts',
    why: 'the specimen payload, whose values are visibly specimens rather than plausible facts',
    // The landline, NOT `Specimen Road`. The address appears twice in that file — as `line1` and inside
    // `oneLine` — so a pattern matching it stayed live after an edit to either, and gate case 163p
    // reported the exemption as still justified when it was not. One occurrence, so one edit kills it.
    justifiedBy: /e164: '\+97120000000'/,
  },
  {
    file: 'jsonld/business.ts',
    why: "START_OF_DAY and END_OF_DAY, which are schema.org's day boundaries and not this premises' hours",
    justifiedBy: /'23:59'/,
  },
]

const sourceFiles = (): readonly string[] =>
  globSync('**/*.ts', { cwd: ROOT })
    .filter((file) => !file.endsWith('.test.ts'))
    .filter((file) => !file.endsWith('.fixture.ts'))
    .filter((file) => !file.includes('.fixtures/'))
    .sort()

/** Every file the scan reads, as `{root, file}` pairs, across both declared roots. */
const scanned = (): readonly { readonly root: string; readonly file: string }[] => {
  const all: { root: string; file: string }[] = []
  for (const entry of ROOTS) {
    if (entry.files === 'walk') {
      for (const file of sourceFiles()) all.push({ root: entry.root, file })
    } else {
      for (const file of entry.files) all.push({ root: entry.root, file })
    }
  }
  return all
}

describe('the SEO analyses and the GBP checker hold no NAP literal', () => {
  it('reads a non-trivial number of modules, so a glob that matched nothing is a failure', () => {
    // ADR 0002 as the first assertion: a scan over zero files passes every rule below it, and that is
    // exactly how `pnpm boundaries` once reported success over zero modules.
    expect(sourceFiles().length).toBeGreaterThan(10)
    expect(scanned().length).toBeGreaterThan(sourceFiles().length)
  })

  it('reads every named file, so a rename does not quietly empty the google half', () => {
    // A named file list is only a scan while the files are there. A rename would otherwise turn this
    // half into zero assertions, which reads exactly like a clean tree.
    for (const entry of scanned()) {
      expect(
        readFileSync(`${entry.root}${entry.file}`, 'utf8').length,
        `${entry.file} is named by this scan and could not be read. Fix the list rather than leaving ` +
          'a rule that walks nothing.',
      ).toBeGreaterThan(0)
    }
  })

  it('names only exemptions that still need one', () => {
    for (const exemption of EXEMPT) {
      const source = readFileSync(`${ROOT}${exemption.file}`, 'utf8')
      expect(
        exemption.justifiedBy.test(source),
        `${exemption.file} is exempt for "${exemption.why}" and no longer contains the literal that ` +
          'justified it. Delete the exemption rather than keeping a permission nobody can see a reason for.',
      ).toBe(true)
    }
  })

  const exempt = new Set(EXEMPT.map((entry) => entry.file))

  for (const forbidden of FORBIDDEN) {
    it(`holds no literal of ${forbidden.what}`, () => {
      const offenders: string[] = []
      for (const entry of scanned()) {
        if (exempt.has(entry.file)) continue
        const source = readFileSync(`${entry.root}${entry.file}`, 'utf8')
        const lines = source.split('\n')
        lines.forEach((line, index) => {
          if (forbidden.pattern.test(line))
            offenders.push(`${entry.file}:${index + 1}  ${line.trim()}`)
        })
      }
      expect(
        offenders,
        `${forbidden.what} is written into an SEO analysis. The premises row (0003) is the only ` +
          'authority for the name, address, phone and hours, and a module holding its own copy answers ' +
          '"consistent" about itself.',
      ).toEqual([])
    })

    it(`detects ${forbidden.what} when one is present, so the scan above is not vacuous`, () => {
      /*
       * The known-bad half, inline. Three patterns that have never been seen to match anything are three
       * patterns that may no longer match anything — a regular expression refactored into uselessness is
       * the commonest way a scan like this stops being a scan, and the repository staying clean is
       * indistinguishable from the pattern being broken.
       */
      const planted: Readonly<Record<string, string>> = {
        'a telephone number': "const phone = '+971501234567'",
        'a street address': "const where = '250 Al Meena Street'",
        'an opening-hour time': "const opens = '11:00'",
      }
      const line = planted[forbidden.what]
      expect(line, `no planted line for ${forbidden.what}`).toBeDefined()
      expect(forbidden.pattern.test(line as string)).toBe(true)
      // And the control for the control: the pattern must NOT match an ordinary line of this codebase,
      // or the scan above would fail for every file and the exemption list would grow to cover the tree.
      expect(forbidden.pattern.test('export function coverageAnomalies(input, config) {')).toBe(
        false,
      )
    })
  }
})
