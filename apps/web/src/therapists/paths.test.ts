import { THERAPIST_INDEX_PATH, therapistPathFor } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import { localisedPath } from '../i18n/locales.ts'
import { fillParams, pathFor, routeById } from '../routes/registry.ts'
import { therapistPath, therapistsIndexPath } from './content.ts'

/**
 * The two spellings of the `/therapists` prefix, held equal.
 *
 * `packages/db` has to spell the path to write a `redirect_map` row; the route registry has to spell it
 * because it IS the URL space. That is a fact stated twice, and the brief's rule is that a second
 * statement of a fact drifts unless the check that holds them equal lands in the same commit. This is that
 * check — the same shape as `catalogue.itest.ts`'s assertion that `servicePath()` and SQL's
 * `treatment_path()` agree.
 */
describe('the therapist paths are the registry paths', () => {
  it('the index path is the registry entry', () => {
    expect(THERAPIST_INDEX_PATH).toBe(pathFor(routeById('therapists'), 'en'))
    expect(therapistsIndexPath('en')).toBe(THERAPIST_INDEX_PATH)
    expect(therapistsIndexPath('ar')).toBe(localisedPath(THERAPIST_INDEX_PATH, 'ar'))
  })

  it('a therapist page path is the registry pattern with the slug filled in', () => {
    const pattern = pathFor(routeById('therapist'), 'en')
    expect(therapistPathFor('a-name')).toBe(fillParams(pattern, { slug: 'a-name' }))
    expect(therapistPath('en', 'a-name')).toBe(therapistPathFor('a-name'))
    expect(therapistPath('ar', 'a-name')).toBe(
      fillParams(pathFor(routeById('therapist'), 'ar'), { slug: 'a-name' }),
    )
  })

  it('the index is the prefix of a therapist page, which is what makes the 301 target reachable', () => {
    // `archiveTherapist` redirects a retired therapist's page to the index. If the two were spelled
    // differently the redirect would land on a 404 — "a 404 with extra steps", which is 0029's own phrase
    // for the thing it refuses.
    expect(therapistPathFor('a-name').startsWith(`${THERAPIST_INDEX_PATH}/`)).toBe(true)
  })
})
