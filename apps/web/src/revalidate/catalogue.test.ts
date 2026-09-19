import { describe, expect, it } from 'vitest'
import { LOCALES } from '../i18n/locales.ts'
import {
  CATALOGUE_ARTEFACTS,
  CATALOGUE_CHANGE_KINDS,
  revalidationPathsFor,
  runCatalogueRevalidation,
} from './catalogue.ts'

/**
 * W-SITE-05 — the publish loop's decision, without a server.
 *
 * The acceptance criterion is *"one integration test asserting all five artefacts changed"*, and
 * `treatments.itest.ts` is that test. This is the other half and it catches a different mistake: the
 * integration test proves the loop works for the paths it was given, and **this** proves it was given the
 * right ones. A forgotten `/ar`, a forgotten `/pricing` or a forgotten retired path would leave a stale page
 * cached with the old price — and the integration test, which fetches the paths the report names, would not
 * notice, because it would be checking the ones that were revalidated.
 */
describe('acceptance — one catalogue change invalidates every page that renders it', () => {
  const change = { kind: 'price', slug: 'asian-normal-massage' } as const

  it('covers the treatment page, the index and /pricing, in both locales', () => {
    const paths = revalidationPathsFor(change)
    // Six paths: three pages, two locales. Enumerated rather than counted, because the mistake to catch is a
    // missing member and a count would pass on a duplicate.
    expect([...paths].sort()).toEqual([
      '/ar/pricing',
      '/ar/treatments',
      '/ar/treatments/asian-normal-massage',
      '/pricing',
      '/treatments',
      '/treatments/asian-normal-massage',
    ])
    // The Arabic half is half the site. A loop that revalidated only the default locale would leave every
    // Arabic page serving the old price, and nothing on the English side would look wrong.
    for (const locale of LOCALES) {
      expect(
        paths.some((path) =>
          locale === 'ar' ? path.startsWith('/ar/') : !path.startsWith('/ar/'),
        ),
        locale,
      ).toBe(true)
    }
    expect(new Set(paths).size).toBe(paths.length)
  })

  it('adds the retired path after a rename, and only then', () => {
    const renamed = revalidationPathsFor({
      kind: 'slug',
      slug: 'asian-normal-massage',
      previousSlug: 'asian-normal',
    })
    // The cached copy at the old URL is a 200 with the old name: left alone, the rename has not happened for
    // anybody who had that link, which is exactly the traffic the redirect exists for.
    expect(renamed).toContain('/treatments/asian-normal')
    expect(renamed).toContain('/ar/treatments/asian-normal')
    expect(renamed).toHaveLength(8)
    // A "rename" to the same slug adds nothing, rather than a path equal to one already in the set.
    expect(
      revalidationPathsFor({
        kind: 'slug',
        slug: 'asian-normal-massage',
        previousSlug: 'asian-normal-massage',
      }),
    ).toHaveLength(6)
  })

  it('names all five artefacts on every kind of change', async () => {
    for (const kind of CATALOGUE_CHANGE_KINDS) {
      const revalidated: string[] = []
      const report = await runCatalogueRevalidation(
        { kind, slug: 'asian-normal-massage' },
        { revalidatePath: (path) => revalidated.push(path) },
      )
      // Five, by name. "Four out of five is a fail" is the criterion's own phrasing: the artefact nobody
      // remembers is `/pricing` or the sitemap's lastmod, and a report that listed four would be a job that
      // said "done".
      //
      // The literal list is asserted FIRST and the count second, which is not a style choice: comparing the
      // report against `CATALOGUE_ARTEFACTS` cannot catch an artefact dropped from that constant — both sides
      // move together — and a bare `toHaveLength(5)` fails with a number rather than a name. The gate that
      // deletes `sitemap-lastmod` from the constant reads this output for the name, so the name has to be in
      // it (ADR 0003).
      for (const artefact of [
        'treatment-page',
        'treatments-index',
        'pricing-page',
        'offer-json-ld',
        'sitemap-lastmod',
      ]) {
        expect(report.artefacts, `${kind} is missing ${artefact}`).toContain(artefact)
      }
      expect(report.artefacts, `${kind}: five artefacts, sitemap-lastmod included`).toHaveLength(5)
      expect([...report.artefacts].sort(), kind).toEqual([...CATALOGUE_ARTEFACTS].sort())
      // And it actually called the injected revalidator, once per path. A report is a claim; this is the act.
      expect([...revalidated].sort(), kind).toEqual([...report.paths].sort())
    }
  })

  it('publishes no pattern to revalidate', async () => {
    // `revalidatePath('/treatments/[slug]')` invalidates nothing at all: it is not a path Next holds a cache
    // entry for. `fillParams` throws rather than producing one, which is what this asserts.
    const revalidated: string[] = []
    await runCatalogueRevalidation(
      { kind: 'display_name', slug: 'asian-normal-massage' },
      { revalidatePath: (path) => revalidated.push(path) },
    )
    for (const path of revalidated) expect(path, path).not.toContain('[')
    expect(revalidated.length).toBeGreaterThan(0)
  })
})
