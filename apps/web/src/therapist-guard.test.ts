import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The guard exists ONCE, and the three consumers reach it rather than restating it.
 *
 * W-SITE-06's acceptance line in so many words. It is a source scan rather than a behavioural test, and
 * the reason is what the defect looks like: a second copy of "may this therapist be published" is not a
 * wrong answer, it is a RIGHT answer in two places that will stop agreeing — and the day they disagree the
 * sitemap and the structured data describe different staff, with every behavioural test still green
 * because each half is internally consistent.
 *
 * Here rather than in `packages/core` because it reads files across the repository, which `pnpm purity`
 * refuses inside that package: core may not do I/O, and that includes its tests.
 */

const ROOT = join(import.meta.dirname, '..', '..', '..')
const GUARD = 'packages/core/src/seo/therapist-publishable.ts'
const PREDICATE = 'isTherapistPublishable'

/**
 * The files that may hold the name-and-consent conjunction, and why each one may.
 *
 * Declared rather than inferred, because "it is not the guard" is exactly the condition a second guard
 * also satisfies. Two entries and a sentence each:
 *
 *   - `packages/core/src/hr/employee.ts` is P-HR-01's `isEmployeePublishable`, the mirror of the GENERATED
 *     column `employee.is_publishable`. It is a claim about what the DATABASE computes rather than about
 *     whether a page may be published, both have to exist, and `therapist-publishable.test.ts` asserts
 *     they agree over all four combinations of the pair — and DISAGREE for a retired therapist, which is
 *     the reason there are two. Its own test holds the same property from the other side.
 *   - this file, which quotes the conjunction in the control for the scan.
 */
const CONJUNCTION_EXEMPT: readonly string[] = [
  GUARD,
  'packages/core/src/hr/employee.ts',
  'packages/core/src/hr/employee.test.ts',
  'apps/web/src/therapist-guard.test.ts',
]

const CONSUMERS: readonly { readonly what: string; readonly file: string }[] = [
  // The route handler reaches it through `dispositionOf`, which is the adapter plus the guard; the file
  // calls `therapistDisposition` and `isTherapistPublishable` and nothing else decides.
  { what: 'the route handler', file: 'apps/web/src/therapists/read.ts' },
  { what: 'the sitemap builder', file: 'apps/web/src/therapists/sitemap.ts' },
  { what: 'the schema builder', file: 'packages/core/src/seo/jsonld/content.ts' },
]

function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/** Every `.ts`/`.tsx` under the directories a publication decision could hide in. */
function sourceFiles(): readonly string[] {
  const roots = [
    'apps/web/src',
    'apps/web/app',
    'packages/core/src',
    'packages/db/src',
    'packages/hr/src',
  ]
  const found: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(ROOT, directory))) {
      if (entry === 'node_modules') continue
      const relative = `${directory}/${entry}`
      if (statSync(join(ROOT, relative)).isDirectory()) {
        walk(relative)
        continue
      }
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) found.push(relative)
    }
  }
  for (const root of roots) walk(root)
  return found
}

describe('the therapist publishing guard exists once', () => {
  it('is defined in exactly one file', () => {
    const definitions = sourceFiles().filter((file) =>
      read(file).includes(`export function ${PREDICATE}`),
    )
    expect(definitions).toEqual([GUARD])
  })

  it('is called by the route handler, the sitemap builder and the schema builder', () => {
    for (const consumer of CONSUMERS) {
      expect(read(consumer.file), `${consumer.what} (${consumer.file})`).toContain(PREDICATE)
    }
    // Non-vacuous: three distinct files, so a copy-paste that pointed all three at one path would fail.
    expect(new Set(CONSUMERS.map((consumer) => consumer.file)).size).toBe(3)
  })

  it('the equality with the generated-column mirror is asserted, which is what the exemption rests on', () => {
    // The exemption above is only safe while something holds the two statements equal. This is the
    // assertion that the assertion exists: without it, adding a file to `CONJUNCTION_EXEMPT` would be a
    // way to turn the scan off.
    const guardTest = read('packages/core/src/seo/therapist-publishable.test.ts')
    expect(guardTest).toContain('isEmployeePublishable')
    expect(guardTest).toContain('generatedIsPublishableFor')
  })

  it('has no second implementation spelled as the conjunction the generated column uses', () => {
    /*
      `employee.is_publishable` is GENERATED as `display_name is not null and photo_consent`, and the
      obvious TypeScript spelling of that conjunction is the second guard this scan exists to refuse. It is
      obvious BECAUSE it looks equivalent, and it is not: it misses retirement (a departed therapist 301s
      rather than 200s) and it misses a portrait with no alt text.
    */
    const conjunctions = [
      /displayName\s*!==\s*null\s*&&\s*[\w.]*[pP]hotoConsent/,
      /[\w.]*photoConsent\s*&&\s*[\w.]*displayName\s*!==\s*null/,
      /[\w.]*isPublishable\s*&&\s*[\w.]*retiredAt\s*===\s*null/,
    ]
    const offenders = sourceFiles().filter((file) => {
      if (CONJUNCTION_EXEMPT.includes(file)) return false
      const text = read(file)
      return conjunctions.some((pattern) => pattern.test(text))
    })
    expect(offenders).toEqual([])
    // The control: the patterns really match the shape they are about, so an empty result means absence
    // rather than a regex that cannot fire.
    expect(
      conjunctions.some((pattern) =>
        pattern.test('const ok = row.displayName !== null && row.photoConsent'),
      ),
    ).toBe(true)
  })
})

/** The three columns ADR 0020's guard is computed from, and the statement that could write them. */
const EMPLOYEE_PUBLICATION_COLUMNS: readonly string[] = [
  'display_name =',
  'public_slug =',
  'photo_consent =',
]
const UPDATE_EMPLOYEE = /update\s+employee\b/

describe('one writer sets a display name, a consent and a slug', () => {
  const WRITER = 'packages/hr/src/therapist-publication.ts'

  it('nothing else writes any of the three columns', () => {
    /*
      0157 deliberately has no deferred trigger forcing a display-name rename to leave a 301, where 0029
      has one for a service slug. The migration's header says why: 0029 needed the database because the
      CMS, the seed and a psql session all write `service`, and nothing but this module writes a display
      name. That claim is only true while this scan passes — which is what makes it a check rather than a
      comment.
    */
    const offenders = sourceFiles().filter((file) => {
      if (file === WRITER) return false
      // A test fixture may write them: a suite proving the guard has to be able to publish somebody.
      if (file.endsWith('.test.ts') || file.endsWith('.itest.ts')) return false
      // `update employee` AND one of the columns, in the same file, rather than the column name alone.
      // `customer.display_name` and `merge` both hold the string `display_name =` legitimately, and a scan
      // that flagged them would be turned off rather than fixed — which is how a check stops being one.
      const text = read(file)
      if (!UPDATE_EMPLOYEE.test(text)) return false
      return EMPLOYEE_PUBLICATION_COLUMNS.some((column) => text.includes(column))
    })
    expect(offenders).toEqual([])
  })

  it('the writer really writes all three, which is the control', () => {
    const text = read(WRITER)
    expect(UPDATE_EMPLOYEE.test(text)).toBe(true)
    for (const column of EMPLOYEE_PUBLICATION_COLUMNS) expect(text, column).toContain(column)
  })
})
