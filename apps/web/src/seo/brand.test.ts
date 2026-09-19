import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROUTES } from '../routes/registry.ts'
import { BARE_BRAND_RULE, bareBrandFindings, brandIsQualified } from './brand.ts'

/**
 * The bare brand must not reach a title, an Open Graph title or a schema name.
 *
 * docs/09 §"The brand collision": *"Always the full name 'Be Relax Massage Center and Spa', never the bare
 * brand, in titles, schema, GBP and every citation."* `berelax.com` is an international airport-spa chain
 * with an outlet in the same city, so a bare-brand title is a citation that reinforces the wrong entity.
 *
 * Two halves, because the risk arrives two ways. The **literals** somebody types into a template are checked
 * by the scan below. The **values** the graph publishes come from the premises and `legal_entity` rows, so
 * they are checked where the rows are read: `structured-data.itest.ts` applies `brandIsQualified` to the
 * `name` and `legalName` of the real emitted graph.
 *
 * The shared document title in `app/_document/shell.tsx` is covered by the scan rather than by an import,
 * and not for want of trying: `apps/web/tsconfig.json` sets `jsx: "preserve"`, so vitest cannot parse a
 * `.tsx` from this application. The assertion below therefore checks that the scan really visits that file
 * and that the file really mentions the brand — so the rule is exercised on the one title every page falls
 * back to rather than merely declared over it.
 */
const SCANNED_ROOTS = [join('apps', 'web'), join('packages', 'ui')]
const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'artifacts', '.turbo'])

/**
 * The lines that carry a title.
 *
 * Deliberately narrow. The acceptance criterion names `<title>`, `og:title` and a schema `name`, and a scan
 * of every string in the application would fire on the prose of a design-system gallery — which is body
 * copy, not a citation, and a rule that refuses body copy is a rule somebody switches off. What is scanned
 * is the handful of places a *title* is written: a `Metadata` object, an `<title>` element, an Open Graph or
 * Twitter title, and a schema `name`.
 */
const TITLE_PATTERNS: readonly RegExp[] = [
  /(?:^|[^a-zA-Z])title\s*:/,
  /<title[\s>]/,
  /og:title/,
  /twitter:title/,
  /(?:^|[^a-zA-Z])(?:name|alternateName)\s*:\s*['"`]/,
]

/*
 * `legalName` is deliberately absent from the patterns above.
 *
 * `schema.org/legalName` is the registered entity — `legal_entity.legal_name`, the name on the trade licence
 * and on every tax invoice — and docs/09's rule is about the name the business is *called*: an assistant
 * citing the entity reads `name`. The registered name does not contain "Massage Center" and cannot be made
 * to; rewriting it to satisfy an SEO rule would put a name on a tax document that no registry holds.
 * `structured-data.itest.ts` asserts the exemption from the other side — that the published `legalName` is
 * exactly the row's value, unmodified.
 */

/**
 * Files that may carry a bare-brand title, and why.
 *
 * A **closed** list, and — unlike a hand-maintained one — it is checked against the registry: every entry
 * must be a route the registry declares `indexable: false`. The reason a development surface is exempt is
 * not that it is less important but that it cannot be cited: a `noindex, nofollow, noarchive` response is
 * never in an index, so no assistant can read its title and describe the airport spa from it. An exemption
 * for an indexable page fails the test below rather than being argued about in review.
 */
const EXEMPT: readonly { readonly path: string; readonly routeId: string; readonly why: string }[] =
  [
    {
      path: join('apps', 'web', 'app', '(en)', '(dev)', 'kitchen-sink', 'page.tsx'),
      routeId: 'kitchen-sink',
      why: 'the design-system gallery: `indexable: false`, so its title is in no index and can be cited by nothing',
    },
    {
      path: join('apps', 'web', 'app', '(ar)', 'ar', 'kitchen-sink', 'page.tsx'),
      routeId: 'kitchen-sink',
      why: 'the Arabic gallery, same registry entry and the same noindex header',
    },
    // Found by this gate's first run, which is the best evidence it works. B-MSG-04's Messages inbox is an
    // HTML page served by a handler, and its `<title>` reads "BE RELAX admin" — a bare brand, on a route the
    // registry declares `indexable: false` and the proxy serves `noindex, nofollow, noarchive`. It is a
    // back-office screen the owner reads, not a citation, and rewriting it to the full trading name would
    // make an internal page say something it does not mean.
    {
      path: join('apps', 'web', 'app', '(admin)', 'settings', 'messages', 'render.ts'),
      routeId: 'messages-inbox',
      why: 'the admin Messages inbox title: an internal back-office screen, noindex, and cited by nothing',
    },
  ]

const isTestFile = (path: string) => /\.(?:test|itest)\.(?:ts|tsx)$/.test(path)

function sourceFiles(): readonly string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (SKIPPED_DIRS.has(entry)) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (SCANNED_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full)
    }
  }
  for (const root of SCANNED_ROOTS) walk(root)
  return found
}

interface Finding {
  readonly file: string
  readonly line: number
  readonly excerpt: string
}

function bareBrandTitles(
  files: readonly string[],
  options: { readonly respectExemptions?: boolean } = {},
): readonly Finding[] {
  const respect = options.respectExemptions ?? true
  const exempt = new Set(EXEMPT.map((entry) => entry.path.split(sep).join('/')))
  const findings: Finding[] = []
  for (const file of files) {
    const relativePath = relative('.', file).split(sep).join('/')
    if (respect && (exempt.has(relativePath) || isTestFile(relativePath))) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (!TITLE_PATTERNS.some((pattern) => pattern.test(line))) return
        for (const finding of bareBrandFindings(line)) {
          findings.push({ file: relativePath, line: index + 1, excerpt: finding.excerpt })
        }
      })
  }
  return findings
}

describe('the full name, never the bare brand', () => {
  const files = sourceFiles()

  it('scans a non-empty set of files, so a pass cannot mean "found nothing to look at"', () => {
    // ADR 0002's failure mode: a layout change reduces the scan to zero files and the gate reports success
    // for ever.
    expect(files.length).toBeGreaterThan(30)
    expect(files.some((file) => file.includes(join('apps', 'web', 'app')))).toBe(true)
    expect(files.some((file) => file.includes(join('packages', 'ui', 'src')))).toBe(true)
  })

  it(`finds no bare-brand title in apps/web or packages/ui (${BARE_BRAND_RULE})`, () => {
    const findings = bareBrandTitles(files)
    const report = findings.map((f) => `${f.file}:${f.line} — ${f.excerpt}`).join('\n      ')
    expect(
      findings,
      `${BARE_BRAND_RULE}: docs/09 §"The brand collision" requires the full name "Be Relax Massage Center ` +
        'and Spa" in every title and every schema name, because berelax.com is an international ' +
        'airport-spa chain with an outlet in the same city and the bare brand is unwinnable.\n      ' +
        report,
    ).toEqual([])
  })

  it('detects a bare-brand title where one IS written, so the scan is not vacuous', () => {
    // The two kitchen-sink pages are exempt and both carry one. With the exemptions lifted the scan must
    // find them, which is what proves the patterns match the spellings they were written for.
    const found = bareBrandTitles(
      EXEMPT.map((entry) => entry.path),
      { respectExemptions: false },
    )
    expect(found.length).toBeGreaterThanOrEqual(1)
    // And with the exemptions respected it says nothing about them, which the assertion above relies on.
    expect(bareBrandTitles(EXEMPT.map((entry) => entry.path))).toEqual([])
  })

  it('exempts only routes the registry declares non-indexable', () => {
    // The exemption's whole justification: a `noindex, nofollow, noarchive` response is in no index, so its
    // title can be cited by nothing. An exemption for an indexable page has no such justification.
    for (const entry of EXEMPT) {
      expect(() => statSync(entry.path), `${entry.path} is exempt but absent`).not.toThrow()
      expect(entry.why.length, entry.path).toBeGreaterThan(20)
      const route = ROUTES.find((candidate) => candidate.id === entry.routeId)
      expect(route, `${entry.routeId} is not a registry route`).toBeDefined()
      expect(route?.indexable, `${entry.routeId} is indexable and may not be exempt`).toBe(false)
    }
  })

  it('exercises the rule on the shared document title, which every page falls back to', () => {
    // The scan passing is not enough on its own: it would also pass over a file that mentioned no brand. So
    // this asserts the file IS in the scan, that its title line DOES mention the brand, and that the line
    // satisfies the rule — which together mean the rule was applied to the string an assistant reads when a
    // route sets no title of its own.
    const shell = join('apps', 'web', 'app', '_document', 'shell.tsx')
    expect(files.map((file) => relative('.', file).split(sep).join('/'))).toContain(
      shell.split(sep).join('/'),
    )
    const titleLines = readFileSync(shell, 'utf8')
      .split('\n')
      .filter((line) => TITLE_PATTERNS.some((pattern) => pattern.test(line)))
      .filter((line) => /be\s*relax/i.test(line))
    expect(titleLines.length).toBeGreaterThan(0)
    for (const line of titleLines) expect(brandIsQualified(line), line).toBe(true)
  })
})

describe('the rule itself', () => {
  it('accepts every spelling of the full name that is actually used', () => {
    for (const good of [
      'BE RELAX — Massage Center and Spa',
      'Be Relax Massage Center and Spa',
      'be relax massage centre',
      'Book at BE RELAX, Massage Center and Spa, Abu Dhabi',
      'Hot oil massage | BE RELAX — Massage Center and Spa',
      // No mention of the brand at all is not a violation: the rule is about how the brand is written.
      'Treatments and prices',
    ]) {
      expect(brandIsQualified(good), good).toBe(true)
    }
  })

  it('refuses the bare brand, and the near-misses that read as it', () => {
    for (const bad of [
      'BE RELAX',
      'Be Relax Abu Dhabi',
      'Be Relax Spa',
      'BeRelax — Spa and Massage Center',
      'Kitchen sink — the BE RELAX design system',
      'Welcome to Be Relax, the best massage in Al Zahiyah',
    ]) {
      expect(brandIsQualified(bad), bad).toBe(false)
    }
  })

  it('reports every occurrence, so one message names every edit', () => {
    const findings = bareBrandFindings('Be Relax and Be Relax again, both bare')
    expect(findings).toHaveLength(2)
    expect(findings[0]?.rule).toBe(BARE_BRAND_RULE)
    expect(findings[0]?.excerpt.startsWith('Be Relax')).toBe(true)
  })

  it('does not let a word between the halves count as qualified', () => {
    // "Be Relax is a massage center" mentions both, and the brand is standing alone in it.
    expect(brandIsQualified('Be Relax is a massage center')).toBe(false)
    // And a gap wide enough to hold one: the separator class allows four characters, which is what ` — `
    // and `, ` need.
    expect(brandIsQualified('Be Relax        Massage Center')).toBe(false)
  })
})
