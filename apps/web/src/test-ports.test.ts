import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_PORT_BANDS, type TestSuiteName } from '@berelax/harness/ports'
import { describe, expect, it } from 'vitest'

/**
 * Every server-starting suite draws its port from the registry, and from a band no other suite draws from.
 *
 * `@berelax/harness/ports` proves the bands do not overlap. That proof is worth nothing if a suite can go on
 * picking a port for itself, which is how the overlaps it fixed arose: eleven suites each chose a band and
 * recorded the neighbours' in a comment, and by the eleventh, three pairs were sharing one. The symptom is
 * not a flake. The second `next start` cannot bind, exits, and the suite's own wait-for-server loop then
 * answers from the *other* suite's server — so the assertions run against a different build and the run
 * reports on code the file under test does not contain, in either direction.
 *
 * So this scans the source. It is a text scan because the claim is about what the files say, not about what
 * a particular run happened to do: a suite that computes its own port is wrong even on a machine where
 * nothing else is listening.
 */

const WEB_SRC = new URL('.', import.meta.url).pathname

/** An integer port added to a random offset — the shape every suite used before the registry existed. */
const INLINE_PORT = /\b\d{4}\s*\+\s*Math\.floor\(\s*Math\.random\(\)/

/**
 * A literal port in an HTTP loopback URL, the other way to pin one.
 *
 * `http://` on purpose. A bare `127.0.0.1:` followed by four digits also matches the `:5432` in a
 * Postgres URL, and a suite writing its database connection out in full is doing nothing wrong.
 */
const LITERAL_URL_PORT = /http:\/\/127\.0\.0\.1:\d{4}\b/

/**
 * How a suite claims its band: `startWebServer({ suite: 'name' })`, or a bare `testPort('name')` for a
 * suite that needs the number without the server.
 *
 * It was only the second form until `packages/harness/src/server.ts` took ownership of the child process,
 * the temp root and the port ACQUISITION. A pattern that still matched only `testPort` would have read every
 * converted suite as claiming nothing, and then reported all eleven bands as declared-and-unused — the
 * assertion below would have failed loudly, which is the good case, but it would have been failing about the
 * wrong thing.
 */
const BAND_CLAIM = /\btestPort\(\s*'([^']+)'\s*\)|\bsuite:\s*'([^']+)'/g

/**
 * The same pattern without `g`, for presence.
 *
 * A global regex carries `lastIndex` across calls, so the same `.test()` in a loop answers true,
 * false, true for identical inputs. `matchAll` is safe — it works on a clone — but `.test()` is not,
 * and a filter over a dozen files would silently skip every other one.
 */
const HAS_BAND_CLAIM = /\btestPort\(\s*'[^']+'\s*\)|\bsuite:\s*'[^']+'/

/** A suite starts a server when it asks the harness for one, or — no longer permitted — spawns its own. */
const STARTS_SERVER = /\bstartWebServer\(|\b(?:spawn|execFile)\(/

/**
 * A suite spawning `next start` for itself, which is now a defect rather than the norm.
 *
 * Eleven files each did this and drifted: three discarded the child's output entirely, so a port collision
 * arrived as `next start exited with 1` with the reason thrown away; none removed the temp root Next leaves
 * under `os.tmpdir()`, which reached 10,539 directories and 25 GB in one session. `startWebServer` owns all
 * of it, and this pattern is what stops the twelfth file going back to a private copy.
 */
const PRIVATE_NEXT_SPAWN = /\bspawn(?:Sync)?\(\s*'pnpm'[\s\S]{0,120}?'next'[\s\S]{0,40}?'start'/

function itestFiles(dir: string): readonly string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...itestFiles(path))
    else if (entry.name.endsWith('.itest.ts')) found.push(path)
  }
  return found.sort()
}

const FILES = itestFiles(WEB_SRC).map((path) => ({
  path: path.slice(WEB_SRC.length),
  text: readFileSync(path, 'utf8'),
}))

/** A scan over nothing passes every assertion below, so the count is the control (ADR 0003). */
const EXPECTED_MINIMUM_FILES = 12

describe('integration suite ports', () => {
  it('finds the suites to scan', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(EXPECTED_MINIMUM_FILES)
  })

  it('never computes a port inline', () => {
    const offenders = FILES.filter((file) => INLINE_PORT.test(file.text)).map((file) => file.path)
    expect(offenders, 'these compute their own port; take one from startWebServer instead').toEqual(
      [],
    )
  })

  it('never writes a loopback port as a literal', () => {
    const offenders = FILES.filter((file) => LITERAL_URL_PORT.test(file.text)).map(
      (file) => file.path,
    )
    expect(
      offenders,
      'a fixed port answers from another worktree; take one from startWebServer instead',
    ).toEqual([])
  })

  it('draws every port from a band the registry declares', () => {
    const unknown: string[] = []
    for (const file of FILES) {
      for (const [, viaCall, viaOption] of file.text.matchAll(BAND_CLAIM)) {
        const suite = viaCall ?? viaOption
        if (suite !== undefined && !(suite in TEST_PORT_BANDS))
          unknown.push(`${file.path} -> ${suite}`)
      }
    }
    expect(unknown, 'no band is declared for these').toEqual([])
  })

  it('gives each band exactly one suite, in both directions', () => {
    // Files, not occurrences. A suite's own prose cites `testPort('content')` while explaining why the band
    // is not the file's to choose, and counting that as a second claimant reported the file as clashing with
    // itself — which is what the first version of this test did.
    const claimants = new Map<string, Set<string>>()
    for (const file of FILES) {
      for (const [, viaCall, viaOption] of file.text.matchAll(BAND_CLAIM)) {
        const suite = viaCall ?? viaOption
        if (suite === undefined) continue
        const files = claimants.get(suite) ?? new Set<string>()
        files.add(file.path)
        claimants.set(suite, files)
      }
    }
    const shared = [...claimants.entries()]
      .filter(([, files]) => files.size > 1)
      .map(([suite, files]) => `${suite} is drawn by ${[...files].sort().join(' and ')}`)
    expect(shared, 'two files sharing a band share a port').toEqual([])

    // The other direction. A band nothing claims is not harmless: it is usually a file that was renamed,
    // and the next suite added takes the name it sees free rather than the band that is actually free.
    const orphans = (Object.keys(TEST_PORT_BANDS) as readonly TestSuiteName[]).filter(
      (suite) => !claimants.has(suite),
    )
    expect(orphans, 'these bands are declared and unused').toEqual([])
  })

  it('starts the application through the harness and never with its own spawn', () => {
    const offenders = FILES.filter((file) => PRIVATE_NEXT_SPAWN.test(file.text)).map(
      (file) => file.path,
    )
    expect(
      offenders,
      'these spawn `next start` themselves; startWebServer owns the port, the temp root and the teardown',
    ).toEqual([])
  })

  it('gives a band to every suite that starts a server', () => {
    const unbanded = FILES.filter(
      (file) => STARTS_SERVER.test(file.text) && !HAS_BAND_CLAIM.test(file.text),
    ).map((file) => file.path)
    expect(unbanded, 'these spawn a server without drawing a port from the registry').toEqual([])
  })
})
