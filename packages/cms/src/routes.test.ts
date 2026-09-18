import { describe, expect, it } from 'vitest'
import {
  CMS_ROBOTS_TAG,
  CMS_ROUTE_PREFIXES,
  cmsRoutesIn,
  isCmsRoute,
  PAYLOAD_ADMIN_ROUTE,
  PAYLOAD_API_ROUTE,
} from './routes.ts'

describe('acceptance — the CMS route surface is enumerated', () => {
  it('is the admin and its API, and nothing else', () => {
    expect([...CMS_ROUTE_PREFIXES]).toEqual([PAYLOAD_ADMIN_ROUTE, PAYLOAD_API_ROUTE])
  })

  it('does not take /api, which the application needs', () => {
    // Payload's default API route is `/api`. `/api/facts` is a documented public endpoint (docs/09) and
    // Payload's route is a catch-all, so the default would put a catch-all in one root layout group and a
    // static sibling in another.
    expect([...CMS_ROUTE_PREFIXES]).not.toContain('/api')
    expect(isCmsRoute('/api/facts')).toBe(false)
  })

  it('claims the prefix and everything under it', () => {
    for (const path of [
      '/admin',
      '/admin/',
      '/admin/collections/pages',
      '/admin/login',
      '/cms-api',
      '/cms-api/pages',
      '/cms-api/graphql',
    ]) {
      expect(isCmsRoute(path), path).toBe(true)
    }
  })

  it('claims nothing that merely begins with the same letters', () => {
    // The control. `startsWith('/admin')` alone would swallow a legitimate public page and quietly
    // noindex it — which is the kind of bug that is only found in Search Console, months later.
    for (const path of ['/administration', '/admin-guide', '/cms-apix', '/', '/spa', '/journal']) {
      expect(isCmsRoute(path), path).toBe(false)
    }
  })

  it('finds CMS routes in a list of public ones, for W-SITE-01 and W-SITE-10 to assert on', () => {
    expect(cmsRoutesIn(['/', '/spa', '/journal'])).toEqual([])
    expect(cmsRoutesIn(['/', '/admin', '/cms-api/pages'])).toEqual(['/admin', '/cms-api/pages'])
  })

  it('serves all three robots directives, not just noindex', () => {
    expect(CMS_ROBOTS_TAG).toContain('noindex')
    // nofollow stops a crawler walking from a login page into every collection listing; noarchive stops a
    // cached copy of a screen full of unpublished copy outliving the page.
    expect(CMS_ROBOTS_TAG).toContain('nofollow')
    expect(CMS_ROBOTS_TAG).toContain('noarchive')
  })
})
