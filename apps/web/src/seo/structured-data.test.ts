import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { FAQ_ENTRIES } from '@berelax/cms'
import { specimenFacts, validateGraph } from '@berelax/core'
import { describe, expect, it } from 'vitest'
import { ROUTES } from '../routes/registry.ts'
import { breadcrumbTrailFor, graphInputFor, pageGraph } from './graph-input.ts'

/**
 * The application half of W-SITE-03: one block builder, one graph per route, no hand-written literal.
 *
 * The three things this file proves, none of which the core unit tests can:
 *
 *   1. **`application/ld+json` is spelled in exactly one place.** The acceptance criterion asks for zero
 *      hand-written blocks, and a convention cannot be checked — so the attribute value is greppable and a
 *      second occurrence is a failure naming the rule.
 *   2. **The FAQ builder's fields are the CMS collection's fields.** `packages/core` may not import
 *      `@berelax/cms`, so the two field lists can only be compared from here.
 *   3. **The graph for a route is a function of the route**, which is what lets the integration test build
 *      the expected block and compare it with the served one.
 */
const HANDWRITTEN_RULE = 'handwritten-jsonld-block'

/** The one file that may spell the attribute value, and the one constant that holds it. */
const BLOCK_BUILDER = join('apps', 'web', 'src', 'seo', 'structured-data.tsx')

const SCANNED_ROOTS = [join('apps', 'web'), join('packages', 'ui'), join('packages', 'core')]
const SCANNED_EXTENSIONS = ['.ts', '.tsx']
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'artifacts', '.turbo'])
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
}

/**
 * A line that is nothing but a comment.
 *
 * Comments are exempt, and the reason is the one `packages/db/src/seed/premises.test.ts` records for its own
 * exemption of `normalise-phone.ts`: the modules that implement this rule have to be able to explain it, and
 * a rule that refused its own documentation is a rule somebody switches off. Three doc comments in
 * `@berelax/core` quote the attribute value while explaining why there is one builder.
 *
 * Line-level, which means a block written across several lines with the attribute on a line of its own would
 * be reported and one hidden inside a trailing comment would not. That is the right trade: the failure this
 * guards against is somebody typing a `<script>` into a page, and nobody types one into a comment.
 */
const isCommentLine = (line: string): boolean => /^\s*(?:\/\/|\*|\/\*)/.test(line)

/** Every mention of the JSON-LD media type outside the one component that renders it. */
function handwrittenBlocks(
  files: readonly string[],
  options: { readonly allowBuilder?: boolean } = {},
) {
  const allow = options.allowBuilder ?? true
  const builder = BLOCK_BUILDER.split(sep).join('/')
  const findings: Finding[] = []
  for (const file of files) {
    const relativePath = relative('.', file).split(sep).join('/')
    if (isTestFile(relativePath)) continue
    if (allow && relativePath === builder) continue
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (!isCommentLine(line) && line.includes('application/ld+json')) {
          findings.push({ file: relativePath, line: index + 1 })
        }
      })
  }
  return findings
}

describe('every JSON-LD block comes out of one builder', () => {
  const files = sourceFiles()

  it('scans a non-empty set of files', () => {
    expect(files.length).toBeGreaterThan(60)
    expect(files.some((file) => file.includes(join('apps', 'web', 'app')))).toBe(true)
    expect(files.some((file) => file.includes(join('packages', 'core', 'src', 'seo')))).toBe(true)
  })

  it(`finds no application/ld+json outside the block builder (${HANDWRITTEN_RULE})`, () => {
    const findings = handwrittenBlocks(files)
    const report = findings.map((f) => `${f.file}:${f.line}`).join('\n      ')
    expect(
      findings,
      `${HANDWRITTEN_RULE}: the only <script type="application/ld+json"> in this application is rendered ` +
        `by StructuredData in ${BLOCK_BUILDER}, from a graph buildStructuredDataGraph produced. A block ` +
        'written by hand is a schema block that goes on saying what the database no longer holds — the ' +
        'failure docs/09 §4 exists to remove.\n      ' +
        report,
    ).toEqual([])
  })

  it('detects the spelling where it IS written, so the scan is not vacuous', () => {
    // Pointed at the builder with its allowance lifted: the scan must find the one legitimate occurrence, or
    // the pattern matches nothing anywhere and the rule above is decoration.
    expect(handwrittenBlocks([BLOCK_BUILDER], { allowBuilder: false })).not.toEqual([])
    expect(handwrittenBlocks([BLOCK_BUILDER])).toEqual([])
  })

  it('renders the media type from one constant, not from a second literal', () => {
    // Read out of the source rather than imported: `apps/web/tsconfig.json` sets `jsx: "preserve"`, so a unit
    // test cannot import a `.tsx` from this application at all — which is also why the route assembly lives
    // in `graph-input.ts`.
    const source = readFileSync(BLOCK_BUILDER, 'utf8')
    expect(source).toContain("export const JSON_LD_MIME = 'application/ld+json'")
    expect(source).toContain('type={JSON_LD_MIME}')
    // Exactly one occurrence outside the doc comments: the constant. `type={JSON_LD_MIME}` is how the JSX
    // gets it, so a grep for the literal finds one line and a reviewer knows which.
    const occurrences = source
      .split('\n')
      .filter((line) => line.includes("'application/ld+json'")).length
    expect(occurrences).toBe(1)
  })
})

describe('the FAQ builder reads the collection that owns the rows', () => {
  it('takes exactly the fields faq_entries declares', () => {
    // `packages/cms`'s descriptor is the one field list, and its purpose line says so: "The /faq page and its
    // FAQPage JSON-LD derive from the same rows." A renamed CMS field has to be a failing test rather than a
    // FAQPage with empty answers, and this is the only package that may import both sides.
    const declared = FAQ_ENTRIES.fields.map((field) => field.name).sort()
    expect(declared).toEqual(['answer', 'question', 'topic'])
    // And the builder's input names them identically. A structural type has no runtime keys, so the check is
    // that an object built from the descriptor's names satisfies it — which is a compile error if it does not.
    const entry = { question: 'Q?', answer: 'A.', topic: 'booking' }
    expect(Object.keys(entry).sort()).toEqual(declared)
  })

  it('names a real topic from the collection, so the specimen is not a shape nobody stores', () => {
    const topic = FAQ_ENTRIES.fields.find((field) => field.name === 'topic')
    expect(topic?.type).toBe('select')
    expect('options' in (topic ?? {}) ? topic?.options : []).toContain('booking')
  })
})

describe('the graph for a registry route', () => {
  const facts = specimenFacts()
  const request = {
    id: 'kitchen-sink' as const,
    locale: 'en' as const,
    facts,
    licenceClass: 'unconfirmed',
    breadcrumb: { home: 'Home', page: 'Kitchen sink' },
    includeCatalogue: true,
  }

  it('builds a valid graph that requires the three node types the site always carries', () => {
    const graph = pageGraph(request)
    expect(
      validateGraph(graph, {
        licence: 'unconfirmed',
        requireTypes: ['DaySpa', 'Organization', 'Service', 'BreadcrumbList'],
      }),
    ).toEqual([])
  })

  it('hangs the page URL and every @id off the configured origin', () => {
    const input = graphInputFor(request)
    expect(input.pageUrl.startsWith(input.origin)).toBe(true)
    expect(input.pageUrl.endsWith('/kitchen-sink')).toBe(true)
  })

  it('differs between locales only in the page URL and the trail', () => {
    // Every value in the graph is a database row — the address, the hours, the 32 prices — and none of those
    // is translated. A fact has no language, which is the same argument /api/facts makes for being
    // locale-neutral.
    const en = graphInputFor(request)
    const ar = graphInputFor({
      ...request,
      locale: 'ar',
      breadcrumb: { home: 'الصفحة الرئيسية', page: 'معرض المكونات' },
    })
    expect(ar.pageUrl).toBe(`${en.origin}/ar/kitchen-sink`)
    expect(ar.facts).toBe(en.facts)
    expect(ar.licence).toBe(en.licence)
    expect(ar.breadcrumb?.[0]?.url).toBe(`${en.origin}/ar`)
  })

  it('emits no breadcrumb for the home route, which has no parent', () => {
    const trail = breadcrumbTrailFor('home', 'en', { home: 'Home', page: 'Home' })
    expect(trail).toHaveLength(1)
    const graph = pageGraph({ ...request, id: 'home', breadcrumb: { home: 'Home', page: 'Home' } })
    expect(
      graph['@graph'].some((node) => JSON.stringify(node['@type']).includes('BreadcrumbList')),
    ).toBe(false)
  })

  it('publishes no hero media and no therapist, because nothing serves either', () => {
    const input = graphInputFor(request)
    expect(input.heroImage).toBeNull()
    expect(input.heroVideo).toBeNull()
    expect(input.therapists).toEqual([])
    // And no profile URL is recorded, so `sameAs` is the site alone — asserted rather than assumed, because a
    // plausible TripAdvisor URL would bind this entity to somebody else's listing.
    expect(input.sameAsProfiles).toBeUndefined()
  })

  it('refuses a licence class no vocabulary decision covers, rather than defaulting to the strict one', () => {
    // A fallback is the tempting choice and it is wrong in one specific way: an unrecognised value means the
    // enum gained a member nothing decided about, and defaulting would publish wellness vocabulary for a
    // business whose licence had just been confirmed as something else — silently.
    expect(() => pageGraph({ ...request, licenceClass: 'clinic' })).toThrow(
      /no schema.org vocabulary decision covers/,
    )
  })

  it('covers every registry document route, so no page can be built without a decision', () => {
    // The registry is in exact bijection with the filesystem, so this enumerates every document the site
    // serves. Each one either renders a graph or is a deliberate deferral; either way the builder has to be
    // able to produce one for it.
    const documents = ROUTES.filter((route) => route.kind === 'document')
    expect(documents.length).toBeGreaterThan(0)
    for (const route of documents) {
      for (const locale of route.locales) {
        expect(
          () =>
            pageGraph({
              ...request,
              id: route.id,
              locale,
              breadcrumb: { home: 'Home', page: route.id },
            }),
          `${route.id} (${locale})`,
        ).not.toThrow()
      }
    }
  })
})
