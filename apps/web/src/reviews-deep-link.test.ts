import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { placeReviewsDeepLink } from '@berelax/google'
import { describe, expect, it } from 'vitest'

/**
 * G-REV-06 — the deep link is DERIVED, and no listing identifier is a literal anywhere in the build.
 *
 * The acceptance line: *"a grep test asserts no literal place id, CID or maps URL path containing a
 * listing identifier appears anywhere in `apps/` or `packages/`, and the rendered link is reconstructed
 * from the stored placeId."*
 *
 * ## Why this is worth a repository scan rather than a review
 *
 * A hard-coded listing link is the defect that keeps working. It opens the right business for months, and
 * then the owner connects the account that actually administers the listing (docs/10 §2 says it need not
 * be the one verified on the site), or the agency that still holds it hands it over, or a second branch
 * arrives — and from that moment the *Copy reply* screen sends somebody to paste a reply on **another
 * business's reviews**. Nothing fails. The argument is on `placeReviewsDeepLink` itself, and migration
 * 0020 denormalises `place_id` onto every review row so that the link can be built from the row that is
 * being replied to rather than from configuration.
 *
 * ## What the scan looks for, and what it deliberately permits
 *
 * Three rules, each failing by its own name so a gate's known-bad fixture can assert which one it broke
 * (ADR 0003):
 *
 *   - `deep-link-literal-place-id` — a Google place id written out in source. Place ids begin `ChIJ`, and
 *     every one in this repository is a visibly-fake fixture; this rule says a fixture is all one may be.
 *   - `deep-link-identifier-in-a-url` — a Maps or Search URL carrying an identifier in the source text:
 *     `query_place_id=<something>`, `cid=<something>`, `/maps/place/<something>`, a `g.page` short link
 *     or a `ludocid`. A template whose identifier is an interpolation is not one.
 *   - `deep-link-second-template` — a Maps or Search URL built anywhere other than the two functions that
 *     are allowed to build one. Two templates is two answers to "where is this listing", and the day they
 *     disagree the wrong one is whichever screen nobody checked.
 *
 * **Test files and named fakes are exempt, and that is the one judgement here.** A test needs an id and a
 * fake needs a listing; what matters is that neither is in a code path a person follows. The exemption is
 * by FILE SHAPE — `*.test.ts`, `*.itest.ts`, `fake-*.ts`, anything under `packages/fixtures/` — rather
 * than by an allowlist of paths, because an allowlist of paths is a list somebody adds a line to.
 *
 * The scan is a unit test rather than a `scripts/` gate so it needs no new `pnpm verify` step (which
 * would also need an entry in gate case 29's array). It runs in the suite `pnpm verify` already runs.
 */

const ROOTS = ['apps', 'packages']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.sql'])
const SKIP_DIRECTORIES = new Set([
  '.claude',
  'node_modules',
  'dist',
  '.next',
  'artifacts',
  'coverage',
])

/**
 * The two functions permitted to build a Maps URL, and why there are two rather than one.
 *
 * `placeReviewsDeepLink` (G-REV-02) is the reviews link docs/10 §6 names and the one this unit's screens
 * render. `mapsLinkFor` (G-CONN-07) is the listing-picker's "see what you picked" link, a different URL
 * form for a different question, and it predates this scan.
 *
 * That IS a second statement of how to reach a listing and it is recorded as one rather than quietly
 * permitted: G-REV-06 found it, did not repair it — another unit's file, and this unit passes without
 * touching it — and reports it. What this list makes impossible is a THIRD.
 */
const PERMITTED_URL_BUILDERS = new Set([
  'packages/google/src/adapters/places-aggregate.ts',
  'packages/google/src/capability-resolver.ts',
])

/**
 * `premises-links.ts` builds a Maps search and a directions URL from the premises ADDRESS.
 *
 * Not a listing identifier and not an alternative to the two above: it answers "how do I get there" from
 * the address a human reads on the page, and there is no place id, cid or listing reference in it. It is
 * named here so the permitted set stays about IDENTIFIERS rather than about the string `google.com/maps`.
 */
const ADDRESS_ONLY_LINKS = new Set(['packages/shared/src/premises-links.ts'])

/** A place-id literal: `ChIJ` and at least four more characters of an id. */
const PLACE_ID_LITERAL = /ChIJ[\w-]{4,}/
/** An identifier baked into a URL. Each alternative needs a character of the identifier to follow. */
const IDENTIFIER_IN_URL =
  /(query_place_id=[A-Za-z0-9_-]|[?&]cid=[A-Za-z0-9]|ludocid=[A-Za-z0-9]|\/maps\/place\/[A-Za-z0-9]|g\.page\/[A-Za-z0-9])/
/** A Maps or Search URL of any form. */
const MAPS_URL =
  /https:\/\/(www\.)?google\.com\/(maps|search)|https:\/\/(maps|g)\.(google\.com|page)/

function sourceFiles(): readonly string[] {
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (SKIP_DIRECTORIES.has(entry)) continue
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
        continue
      }
      const dot = entry.lastIndexOf('.')
      if (dot === -1 || !EXTENSIONS.has(entry.slice(dot))) continue
      found.push(path)
    }
  }
  for (const root of ROOTS) walk(root)
  return found
}

/** A file a test, a named fake or a fixture corpus may hold a listing identifier in. See the header. */
function isFixtureFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    name.endsWith('.test.ts') ||
    name.endsWith('.itest.ts') ||
    name.endsWith('.test.tsx') ||
    name.startsWith('fake-') ||
    // A fixture CORPUS is a shipped module and still a fixture: `notification-fixtures.ts` holds the
    // forwarded Google emails G-REV-02's parser is measured against, and one of them quotes a listing.
    // Matched by shape rather than by path, because a path allowlist is a list somebody adds a line to.
    name.endsWith('-fixtures.ts') ||
    path.includes('.fixtures/') ||
    path.startsWith('packages/fixtures/')
  )
}

/** Every finding, as `<rule> <path>` so a failure message names the rule and the file. */
function deepLinkFindings(
  files: readonly string[],
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): readonly string[] {
  const findings: string[] = []
  for (const path of files) {
    if (isFixtureFile(path)) continue
    const text = read(path)
    if (PLACE_ID_LITERAL.test(text)) {
      findings.push(`deep-link-literal-place-id ${path}`)
    }
    if (IDENTIFIER_IN_URL.test(text)) {
      findings.push(`deep-link-identifier-in-a-url ${path}`)
    }
    if (MAPS_URL.test(text) && !PERMITTED_URL_BUILDERS.has(path) && !ADDRESS_ONLY_LINKS.has(path)) {
      findings.push(`deep-link-second-template ${path}`)
    }
  }
  return findings
}

describe('acceptance — no listing identifier is a literal in apps/ or packages/', () => {
  it('finds nothing, over a corpus big enough for the absence to mean something', () => {
    const files = sourceFiles()
    // ADR 0002: a scan that read nothing reports a clean run. The floor is well under what was measured
    // when this was written (about 1,400 files) and far above zero.
    expect(files.length).toBeGreaterThan(600)
    // And the exemption really does exempt something, so the rules below are not passing because every
    // file was skipped.
    expect(files.filter((path) => isFixtureFile(path)).length).toBeGreaterThan(100)
    expect(files.filter((path) => !isFixtureFile(path)).length).toBeGreaterThan(300)
    expect(deepLinkFindings(files)).toEqual([])
  })

  it('reports each rule by name against a file that breaks it', () => {
    // The control, and the only thing that makes the emptiness above a measurement (ADR 0003). The corpus
    // is three synthetic paths and a reader this test supplies, so nothing is written to disk — a gate
    // fixture left in a real source directory is what brief rule 13 is about.
    const corpus = {
      'packages/made-up/literal.ts': "const place = 'ChIJ_hard_coded_listing'",
      'packages/made-up/url.ts':
        "const link = 'https://www.google.com/maps/search/?api=1&query_place_id=ChIJabc'",
      // Built by concatenation so this file holds no `${` inside a plain string, which biome refuses.
      'packages/made-up/second.ts': `const link = \`https://www.google.com/search?q=$\{name}\``,
    } as const
    const findings = deepLinkFindings(
      Object.keys(corpus),
      (path) => corpus[path as keyof typeof corpus],
    )
    expect(findings).toContain('deep-link-literal-place-id packages/made-up/literal.ts')
    expect(findings).toContain('deep-link-identifier-in-a-url packages/made-up/url.ts')
    expect(findings).toContain('deep-link-second-template packages/made-up/second.ts')
  })

  it('permits the one template with no identifier in it, and a test file with one', () => {
    // The other direction: the rules must not fire on the shipped builder, whose URL ends at an
    // interpolation, nor on a test file. Without this the scan could be a rule that refuses everything.
    const permitted = {
      'packages/google/src/adapters/places-aggregate.ts':
        'return `https://www.google.com/maps/search/?api=1&query=Google&query_place_id=' +
        '$' +
        '{encodeURIComponent(placeId)}`',
      'packages/google/src/reviews/some.itest.ts': "const PLACE = 'ChIJ_fixture_place'",
    } as const
    expect(
      deepLinkFindings(Object.keys(permitted), (path) => permitted[path as keyof typeof permitted]),
    ).toEqual([])
  })
})

describe('acceptance — the rendered link is reconstructed from the stored placeId', () => {
  it('is a documented template with one variable, and the variable is the argument', () => {
    // Asserted against the function the screens call, which is the only thing that makes the scan above
    // worth having: a build with no literal link and no derivation would pass the scan and render nothing.
    const link = placeReviewsDeepLink('ChIJ_derivation_probe')
    expect(link).toContain('ChIJ_derivation_probe')
    // Two different ids give two different links, so the id is read rather than decorative.
    expect(link).not.toBe(placeReviewsDeepLink('ChIJ_derivation_probe_two'))
    // An opaque id is percent-encoded, because this build must assume nothing about its alphabet.
    expect(placeReviewsDeepLink('a b&c')).toContain('a%20b%26c')
    // And a blank one is refused rather than building a link to nothing.
    expect(() => placeReviewsDeepLink('   ')).toThrow(/stored placeId/)
  })
})
