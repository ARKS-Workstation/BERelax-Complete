import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN_NAV, adminNavFor, adminNavLocate, can, PERMISSIONS, ROLES } from '@berelax/core'
import { describe, expect, it } from 'vitest'

/**
 * The admin sidebar, held against the application it claims to navigate.
 *
 * `ADMIN_NAV` lives in `packages/core` because visibility is decided by the permission matrix, and it
 * carries paths as literals — the admin is deliberately outside `routes/registry.ts`, which is for
 * documents that exist in both locales with canonical URLs. That leaves exactly one thing a type system
 * cannot catch and this file exists for: **a link to a path nobody serves.** A sidebar is the one place a
 * dead link is invisible, because the reader assumes the screen is simply empty.
 *
 * It runs in `apps/web` rather than `packages/core` on purpose: the check needs the filesystem, and the
 * purity gate is entitled to refuse a `node:fs` import inside core.
 */

const ADMIN_ROOT = join(import.meta.dirname, '..', 'app', '(admin)')

/** The route handler a path is served by, or null. `/till/cash-up` → `(admin)/till/cash-up/route.ts`. */
function handlerFor(href: string): string | null {
  const candidate = join(ADMIN_ROOT, href.replace(/^\//, ''), 'route.ts')
  return existsSync(candidate) ? candidate : null
}

describe('ADMIN_NAV', () => {
  it('links only to paths this application serves', () => {
    const dead = ADMIN_NAV.flatMap((group) => group.items)
      .filter((item) => handlerFor(item.href) === null)
      .map((item) => `${item.href} (${item.label})`)
    expect(dead, 'nav items whose route handler is not on disk').toEqual([])
  })

  it('names a permission the matrix defines, for every item', () => {
    const unknown = ADMIN_NAV.flatMap((group) => group.items)
      .filter((item) => !(PERMISSIONS as readonly string[]).includes(item.permission))
      .map((item) => `${item.href} → ${item.permission}`)
    expect(unknown).toEqual([])
  })

  it('has no duplicate href within a group and no empty group', () => {
    for (const group of ADMIN_NAV) {
      const hrefs = group.items.map((item) => item.href)
      expect(new Set(hrefs).size, `group ${group.id} repeats an href`).toBe(hrefs.length)
      expect(group.items.length, `group ${group.id} is empty`).toBeGreaterThan(0)
    }
    const ids = ADMIN_NAV.map((group) => group.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  /*
   * The pairing that matters, in both directions. A menu is not an authorisation boundary — the route's
   * `guardAdminRoute` and `assertCan` are — but a menu that showed a receptionist the payroll link would
   * invite a click that ends in a refusal and would disclose what exists. So: every item a role can see
   * is one `can()` agrees it may, and an item it cannot see is one `can()` refuses.
   */
  it('shows a role exactly the items the matrix permits', () => {
    for (const role of ROLES) {
      const visible = adminNavFor(role).flatMap((group) => group.items)
      for (const item of visible) {
        expect(
          can(role, item.permission),
          `${role} sees ${item.href} without ${item.permission}`,
        ).toBe(true)
      }
      const hiddenButPermitted = ADMIN_NAV.flatMap((group) => group.items)
        .filter((item) => can(role, item.permission))
        .filter((item) => !visible.some((shown) => shown.href === item.href))
      expect(
        hiddenButPermitted.map((item) => item.href),
        `hidden from ${role} despite access`,
      ).toEqual([])
    }
  })

  it('gives the owner something in every group and a therapist a short menu', () => {
    // The floor ADR 0002 asks for: if `can()` or the registry broke, `adminNavFor` would return nothing
    // for everybody and every assertion above would pass over an empty set.
    expect(adminNavFor('owner').length).toBe(ADMIN_NAV.length)
    const therapist = adminNavFor('therapist').flatMap((group) => group.items)
    expect(therapist.length).toBeGreaterThan(0)
    expect(therapist.length).toBeLessThan(ADMIN_NAV.flatMap((group) => group.items).length)
  })

  describe('adminNavLocate', () => {
    it('resolves a row screen to the item it belongs under', () => {
      // Longest prefix, not equality. `/till/cash-up` must not resolve to `/till`, and a client's own
      // page must land somewhere rather than nowhere.
      expect(adminNavLocate('/till/cash-up')?.item.href).toBe('/till/cash-up')
      expect(adminNavLocate('/till')?.item.href).toBe('/till')
      expect(adminNavLocate('/hr/leave/abc')?.item.href).toBe('/hr/leave')
      expect(adminNavLocate('/compliance/unverified')?.item.href).toBe('/compliance/unverified')
    })

    it('answers null for a path the menu does not cover', () => {
      expect(adminNavLocate('/login')).toBeNull()
      expect(adminNavLocate('/')).toBeNull()
    })
  })
})
