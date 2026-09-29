import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * P-HR-12 — there is no way to SEND a wage file from this repository, and this is what keeps it that way.
 *
 * ## Absent, not disabled
 *
 * docs/04 §4 states the rule for VAT201 and gives the reason in six words: the codebase contains no auto-file
 * capability, *"absent, not disabled, because a future maintainer will eventually switch a flag on"*. A wage
 * file is the sharper case. Filing one against an establishment id this build invented would not be a bug
 * that gets fixed in the next release — it would be a payment instruction issued under somebody else's
 * registration, and the only structural defence is that the code to issue it does not exist.
 *
 * `exportWpsFile` in `@berelax/hr` therefore returns a STRING. What happens to the string is a human
 * downloading it and giving it to their bank, and there is deliberately no step after that in software.
 *
 * ## Why a scan and not a code review
 *
 * The way this regresses is not somebody deliberately adding a submission endpoint. It is a later unit
 * wiring "upload the file" into an admin screen because that is the obvious next feature, and a reviewer
 * agreeing because it looks like a convenience. A scan fails the build; a convention does not.
 *
 * Three rules, each with its own failure mode:
 *
 *   1. **No module that knows about WPS performs network I/O.** The narrowest true statement, and the one
 *      that catches the realistic regression: a `fetch` added to the file that already builds the bytes.
 *   2. **No URL anywhere names a wage-file or bank-submission host.** Catches a constant parked in a config
 *      module far from the WPS code, which rule 1 would not see.
 *   3. **No dependency is a bank or payment-file SDK.** Catches the shape where the network call is inside
 *      somebody else's package and rule 1 sees only an import.
 *
 * Gate block 132 plants a fixture that breaks rule 1 and asserts this file fails, because a scan that has
 * never been seen to fail may not be a scan at all (ADR 0003).
 *
 * It lives in `@berelax/fixtures` because that package may depend on everything and is where the
 * cross-cutting assertions live; it needs no database, so it is a unit test.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..')
const SCANNED = ['packages', 'apps', 'scripts']

/** This file names every forbidden pattern, so it is not evidence of one. */
const isScanItself = (file: string): boolean => file.endsWith('wps-no-submission.test.ts')

/**
 * The gate suite, exempt from RULE 1 ALONE, and the exemption is narrow on purpose.
 *
 * `scripts/test-gates.mjs` is the file whose job is to contain the patterns every other file must not: it
 * plants deliberately broken fixtures and asserts that the checks catch them, which is ADR 0003. Block 132
 * names `packages/core/src/hr/wps-sif.ts` as a path — so the word is in its code whatever it is called —
 * and an unrelated block has carried a `fetch(` fixture since long before this unit. Rule 1 therefore
 * reported the gate file, for its own fixtures, and the suite failed for nothing in the build.
 *
 * Exempt from rule 1 only. Rule 2 still covers it, which is why block 132 assembles its fixture URL from
 * parts rather than writing the host out — a literal submission URL has no business in the repository even
 * in a gate. And `scripts/` stays in scope for every other file: a submit path could perfectly well live in
 * a script, which is the scope this exemption is careful not to give up.
 */
const isGateSuite = (file: string): boolean => file.endsWith(join('scripts', 'test-gates.mjs'))

/**
 * The OTHER checks, exempt from rule 1 alone and for the same reason the gate suite is.
 *
 * Two checks fired on each other's text at the batch merge, which is the sharpest instance of this rule's own
 * subject that has appeared. `scripts/test-no-autofile.mjs` (M-VAT-09) forbids a filing capability and carries
 * `/\bfetch\s*\(/` and `/\bXMLHttpRequest\b/` as the patterns it searches FOR; it then had to name
 * `wps-sif.ts` in an allowance, because this unit's own header quotes the sentence that scan enforces. At that
 * moment it became "a module that knows about WPS and reaches the network" — with no network call in it at
 * all, only two regular expressions and a reason.
 *
 * The alternative was to reword the allowance so it does not say WPS, and that is appeasing a check by editing
 * prose until the regexp is satisfied: the sentence explaining WHY a wage file is a string would be the thing
 * sacrificed to a pattern. A file whose declared job is to search for these strings is exempt by NAME, not by
 * shape, and `the-exemptions-are-used` below asserts each one still matches a file that exists — so an
 * exemption kept for a check somebody deleted fails here rather than widening this scan silently.
 */
const OTHER_CHECKS: readonly string[] = [
  join('scripts', 'test-no-autofile.mjs'),
  join('scripts', 'check-send-chokepoint.mjs'),
  join('scripts', 'check-private-documents.mjs'),
]

const isOtherCheck = (file: string): boolean => OTHER_CHECKS.some((name) => file.endsWith(name))

function sources(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name)) found.push(full)
    }
  }
  for (const dir of SCANNED) walk(join(ROOT, dir))
  return found
}

/**
 * Words that mean "this module is about the wage file".
 *
 * The boundaries are `(?:^|[^a-z0-9])` and `(?:[^a-z0-9]|$)` rather than `\b`, and that is a correction
 * rather than a style: `\b` does not match between `WPS` and `_`, because an underscore is a word
 * character — so `\bwps\b` failed to find `WPS_EMPLOYER_ID`, which is how every identifier in this
 * repository is actually spelled. The control case below is what caught it.
 *
 * `sif` is three letters and appears inside ordinary identifiers — `classifier`, `verSIFied` — so the
 * boundary matters in the other direction too: a substring match would flag half the repository, which is a
 * scan that gets deleted rather than fixed.
 */
const ABOUT_WPS = /(?:^|[^a-z0-9])(?:wps|mohre|sif)(?:[^a-z0-9]|$)|wage protection/i

/** Ways a module reaches the network. Matched as CALLS, not as words in prose. */
const NETWORK = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\baxios\b/,
  /\bgot\s*\(/,
  /from\s+['"]node:https?['"]/,
  /from\s+['"]undici['"]/,
  /\bhttps?\.request\s*\(/,
  /\bnavigator\.sendBeacon\b/,
]

/**
 * A URL that would be a submission endpoint.
 *
 * Deliberately narrow: it must be an `http(s)://` URL whose HOST names a wage-file or bank-submission
 * subject. A pattern matching the word anywhere near a URL would flag documentation links, and a gate
 * everybody has learned to ignore is worse than none.
 */
/**
 * The file with its COMMENTS removed, for the rules that are about what a module DOES.
 *
 * Needed because the first version of rule 1 flagged `apps/web/src/session.itest.ts`, which mentions "the
 * WPS export" in one sentence of prose explaining which unit first serves a salary figure — and which calls
 * `fetch` because it drives a real server. A module that mentions the wage file in a comment is not a
 * module that submits one, and a scan that says it is gets ignored, then deleted.
 *
 * Block comments and whole-line comments only. A trailing `// ...` after code is left in, deliberately:
 * stripping it needs a real tokeniser to avoid eating the `//` inside `https://`, and prose long enough to
 * mention WPS does not live at the end of a code line. The consequence is a scan that can still produce a
 * false positive in one narrow shape, which is the right direction for this particular check to err.
 */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
    .join('\n')
}

const SUBMISSION_URL =
  /https?:\/\/[^\s'"`]*(?:wps|mohre|wageprotection|salaryfile|sif-upload|iso20022|swift)[^\s'"`]*/i

describe('there is no WPS or bank submission path in this repository', () => {
  it('scans a non-trivial number of files, so an empty walk cannot pass', () => {
    // ADR 0002: a scan whose failure mode is "found nothing, reported success" is not a scan.
    expect(sources().length).toBeGreaterThan(500)
  })

  it('the-exemptions-are-used: every exempt check still exists', () => {
    // Without this, an exemption outlives the check it was written for and quietly widens the scan above —
    // the same failure mode as a stale allowance in the scan that caused this exemption to exist.
    const all = sources()
    for (const name of OTHER_CHECKS) {
      expect(
        all.some((file) => file.endsWith(name)),
        `${name} is exempt from rule 1 and no longer exists`,
      ).toBe(true)
    }
  })

  it('finds no module that knows about WPS and also reaches the network', () => {
    const offenders: string[] = []
    for (const file of sources()) {
      if (isScanItself(file) || isGateSuite(file) || isOtherCheck(file)) continue
      const text = codeOnly(readFileSync(file, 'utf8'))
      if (!ABOUT_WPS.test(text)) continue
      const reached = NETWORK.filter((pattern) => pattern.test(text))
      if (reached.length > 0) {
        offenders.push(`${file.slice(ROOT.length + 1)} — ${reached.map(String).join(', ')}`)
      }
    }
    expect(
      offenders,
      'a module that knows about the WPS file also reaches the network. There is no submission path in ' +
        'this build and there must not be one: a wage file filed against an establishment id this build ' +
        'invented is a payment instruction under somebody else’s registration, and "absent, not ' +
        'disabled" is docs/04 §4’s rule for exactly this. `exportWpsFile` returns a string; a ' +
        'human gives it to their bank.',
    ).toEqual([])
  })

  it('finds no URL naming a wage-file or bank-submission host', () => {
    const offenders: string[] = []
    for (const file of sources()) {
      if (isScanItself(file)) continue
      const match = SUBMISSION_URL.exec(readFileSync(file, 'utf8'))
      if (match !== null) offenders.push(`${file.slice(ROOT.length + 1)} — ${match[0]}`)
    }
    expect(
      offenders,
      'a URL names a wage-file or bank-submission host. Rule 1 would not catch a constant parked in a ' +
        'config module away from the WPS code, which is why this rule is separate.',
    ).toEqual([])
  })

  it('declares no bank or payment-file SDK as a dependency', () => {
    /*
      The third shape: the network call inside somebody else's package, where rule 1 sees only an import and
      the import looks like any other.
    */
    const banned = /(?:^|[-/@])(?:wps|mohre|sif|iso20022|swift|sepa|pain001|bankfile)(?:[-/]|$)/i
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (entry.name !== 'package.json') continue
        const manifest = JSON.parse(readFileSync(full, 'utf8')) as {
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        for (const name of [
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.devDependencies ?? {}),
        ]) {
          if (banned.test(name)) offenders.push(`${full.slice(ROOT.length + 1)} — ${name}`)
        }
      }
    }
    walk(join(ROOT, 'packages'))
    walk(join(ROOT, 'apps'))
    offenders.push(
      ...(() => {
        const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        return [
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.devDependencies ?? {}),
        ]
          .filter((name) => banned.test(name))
          .map((name) => `package.json — ${name}`)
      })(),
    )
    expect(offenders, 'a bank or payment-file SDK is a dependency of this build').toEqual([])
  })

  it('the patterns can FAIL, so the three assertions above are not passing over nothing', () => {
    /*
      The control, in all three directions, against strings rather than against the tree. Brief rule 3: an
      assertion that something is absent needs a demonstration that its detector can find the thing.
    */
    expect(ABOUT_WPS.test('const WPS_EMPLOYER_ID = 1')).toBe(true)
    expect(ABOUT_WPS.test('const classifier = 1'), 'the `sif` word boundary is not holding').toBe(
      false,
    )
    expect(NETWORK.some((pattern) => pattern.test('await fetch(url)'))).toBe(true)
    expect(NETWORK.some((pattern) => pattern.test(codeOnly('// we do not fetch anything')))).toBe(
      false,
    )
    // And the narrowing that rule 1 needs: a WPS mention in prose beside a real fetch is not an offender.
    expect(
      ABOUT_WPS.test(codeOnly(' * explains the WPS export\nawait fetch(url)')),
      'a prose-only WPS mention still reads as a module about the wage file',
    ).toBe(false)
    expect(SUBMISSION_URL.test("const u = 'https://wps.example-bank.ae/upload'")).toBe(true)
    expect(SUBMISSION_URL.test("const u = 'https://example.com/docs'")).toBe(false)
    // And the exemption is exactly one file, not a directory: every other script stays in rule 1's reach.
    expect(isGateSuite(join('scripts', 'test-gates.mjs'))).toBe(true)
    expect(isGateSuite(join('scripts', 'seed.mjs'))).toBe(false)
  })
})
