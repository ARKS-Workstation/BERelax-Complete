import { describe, expect, it } from 'vitest'
import { LOCALES } from '../i18n/locales.ts'
import {
  allContentPaths,
  arabicPathOf,
  CONTENT_CHANGE_KINDS,
  CONTENT_ROUTES_BY_KIND,
  contentRevalidationPathsFor,
  runContentRevalidation,
} from './content.ts'

/**
 * W-SITE-07 — the CMS publish loop, checked without a server.
 *
 * The mistake this catches is a forgotten locale. `/faq` revalidated and `/ar/faq` left serving yesterday's
 * answer is invisible to anybody reading English, and an integration test that fetched the paths the report
 * named could not see it either — it would fetch the ones that were revalidated. So the decision is a pure
 * function and this is where it is judged, exactly as `revalidate/catalogue.test.ts` judges the other half.
 */

describe('acceptance — every kind of content change invalidates both locales of every page it touches', () => {
  it('revalidates both locales, for every kind', () => {
    for (const kind of CONTENT_CHANGE_KINDS) {
      const paths = contentRevalidationPathsFor(kind)
      expect(paths.length, kind).toBeGreaterThan(0)
      // Two locales, so exactly half of the paths carry the Arabic prefix. Counting rather than listing: the
      // point is that no page is revalidated in one language only.
      const arabic = paths.filter((path) => path === '/ar' || path.startsWith('/ar/'))
      expect(arabic.length, `${kind}: ${paths.join(', ')}`).toBe(paths.length / LOCALES.length)
      for (const id of CONTENT_ROUTES_BY_KIND[kind]) {
        expect(paths, `${kind} misses the Arabic ${id}`).toContain(arabicPathOf(id))
      }
    }
  })

  it('moves the pages an FAQ change is about, and no others', () => {
    expect(contentRevalidationPathsFor('faq')).toEqual(['/faq', '/ar/faq'])
    // The control, and the reason the kinds are separate: publishing one answer must not rebuild eighteen
    // documents, and a single endpoint that invalidated everything would make the loop's cost proportional to
    // the size of the site rather than to the change.
    expect(contentRevalidationPathsFor('faq')).not.toContain('/spa')
  })

  it('moves every page that renders the premises row when that row changes', () => {
    const paths = contentRevalidationPathsFor('premises')
    for (const path of ['/spa', '/ar/spa', '/contact', '/ar/contact', '/about', '/ar/about']) {
      expect(paths, path).toContain(path)
    }
    // And not the pages that do not: `/faq` and `/journal` render no address, no telephone number and no
    // opening time, so revalidating them on a premises change would be work with no change to show.
    expect(paths).not.toContain('/faq')
    expect(paths).not.toContain('/journal')
  })

  it('names a path for every route in the table, and every path is a real registry path', () => {
    // `pathFor(routeById(id), locale)` throws for an id the registry does not hold and for a locale a route is
    // not served in, so this is also the assertion that the table cannot name a route that has been renamed
    // away. A direct `/faq` literal in the table would not have failed.
    expect(() => allContentPaths()).not.toThrow()
    expect(allContentPaths().every((path) => path.startsWith('/'))).toBe(true)
    expect(new Set(allContentPaths()).size).toBe(allContentPaths().length)
  })
})

describe('one run invalidates what it reports, and reports what it invalidated', () => {
  it('calls revalidatePath once per path and returns them', async () => {
    const called: string[] = []
    const report = await runContentRevalidation('premises', {
      revalidatePath: (path) => called.push(path),
    })
    expect([...called].sort()).toEqual([...report.paths].sort())
    expect(report.kind).toBe('premises')
    // The control: a run that reported paths it had not invalidated would pass an assertion on `report.paths`
    // alone, which is how a publish loop reports success while nothing moved.
    expect(called.length).toBe(contentRevalidationPathsFor('premises').length)
  })

  it('is exhaustive over the declared kinds', () => {
    // A fifth kind added to the union without a row in the table is a lookup that returns undefined and a run
    // that invalidates nothing while reporting success.
    for (const kind of CONTENT_CHANGE_KINDS) {
      expect(CONTENT_ROUTES_BY_KIND[kind], kind).toBeDefined()
      expect(CONTENT_ROUTES_BY_KIND[kind].length, kind).toBeGreaterThan(0)
    }
    expect(Object.keys(CONTENT_ROUTES_BY_KIND).sort()).toEqual([...CONTENT_CHANGE_KINDS].sort())
  })
})
