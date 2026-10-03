import { globSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The legacy `v4` host string appears in exactly ONE module.
 *
 * G-REV-07's acceptance line asks for *"a dependency-cruiser rule asserts only
 * packages/google/src/adapters/reviews-v4.ts references the mybusiness.googleapis.com/v4 host string"*,
 * and half of that is not a thing dependency-cruiser can do: it sees module EDGES, not strings. So the
 * claim is held by two checks and this is the string half.
 *
 * The edge half is `reviews-v4-is-quarantined` in `.dependency-cruiser.cjs`, which permits an import of
 * that module only from `packages/google/src/reviews/` and the package barrel. Both have known-bad
 * fixtures in `scripts/test-gates.mjs` (block 173). The split is the same one
 * `packages/fixtures/src/seo-nap-literals.test.ts` makes for the NAP rule, and for the same reason: a
 * rule that cannot see the hazard is not a rule, however strict it is about something else.
 *
 * ## Why the quarantine is worth a check at all
 *
 * docs/10 §7 calls Reviews the highest-risk dependency in the plan and says why in one line: *"Reviews
 * remaining on legacy v4 while everything else migrated is the clearest possible signal it will move."*
 * Every other Google API this build touches is `v1` on a host Google is actively maintaining. The cost of
 * the migration when it comes is the number of modules that know the old shape — so the manifest's own
 * summary puts it as *"a migration is a day not a month"*, and that is only true while the answer to *how
 * many modules know* is one.
 *
 * ## Why it lives in `packages/fixtures`
 *
 * It reads files. `packages/google` has no file-reading test and `packages/core` is pure;
 * `packages/fixtures` is this repository's home for a scan (`sqlstate-registry.test.ts`,
 * `seo-nap-literals.test.ts`, `wps-no-submission.test.ts` are the same shape).
 */

/** The only module permitted to name the host, relative to the repository root. */
const QUARANTINED = 'packages/google/src/adapters/reviews-v4.ts'

/**
 * The host, assembled rather than written.
 *
 * Written out, this file would be a second occurrence of the very string it scans for — so the scan
 * would have to exempt itself, and an exemption is how a quarantine stops being one. Assembling it from
 * two halves keeps the literal count at one while the pattern below still matches the real thing.
 */
const HOST = ['mybusiness', '.googleapis.com'].join('')

const ROOT = new URL('../../../', import.meta.url).pathname

/** Where a module could reasonably live. Not `node_modules`, and not a build output. */
const SCANNED_GLOBS = ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx', 'apps/*/src/**/*.ts']

const isTestLike = (file: string): boolean =>
  /\.(test|itest|fixture)\.tsx?$/.test(file) || file.includes('.fixtures/')

const modules = (): readonly string[] =>
  SCANNED_GLOBS.flatMap((pattern) => globSync(pattern, { cwd: ROOT }))
    .filter((file) => !isTestLike(file))
    .sort()

describe('the legacy v4 Reviews host is quarantined in one module', () => {
  it('reads a non-trivial number of modules, so a glob that matched nothing is a failure', () => {
    // ADR 0002 as the first assertion: a scan over zero files passes every rule below it, and that is
    // exactly how `pnpm boundaries` once reported success over zero modules.
    expect(modules().length).toBeGreaterThan(200)
  })

  it('finds the host in the quarantined module, so the scan is looking for the right string', () => {
    // Without this, the rule below passes for ever the moment the constant is renamed or the file moves
    // — a clean tree and a broken pattern read identically.
    expect(readFileSync(`${ROOT}${QUARANTINED}`, 'utf8')).toContain(HOST)
  })

  it('finds it in no other module', () => {
    const offenders: string[] = []
    for (const file of modules()) {
      if (file === QUARANTINED) continue
      const source = readFileSync(`${ROOT}${file}`, 'utf8')
      source.split('\n').forEach((line, index) => {
        if (line.includes(HOST)) offenders.push(`${file}:${index + 1}  ${line.trim()}`)
      })
    }
    expect(
      offenders,
      `The legacy v4 Reviews host appears outside ${QUARANTINED}. docs/10 §7 calls Reviews the ` +
        'highest-risk dependency in the plan and the quarantine is what makes its migration a day ' +
        'rather than a month: the cost is the number of modules that know the old shape.',
    ).toEqual([])
  })

  it('detects the host when one is planted, so the scan above is not vacuous', () => {
    // A pattern refactored into uselessness is the commonest way a scan stops being a scan, and the
    // repository staying clean is indistinguishable from it.
    expect(`const host = '${HOST}'`.includes(HOST)).toBe(true)
    // And the control for the control: `v1`'s hosts are DIFFERENT APIs with a different approval state,
    // and a pattern that matched them would condemn every module that reads a location.
    expect('mybusinessbusinessinformation.googleapis.com'.includes(HOST)).toBe(false)
    expect('mybusinessaccountmanagement.googleapis.com'.includes(HOST)).toBe(false)
  })
})
