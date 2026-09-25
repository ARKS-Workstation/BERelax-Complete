import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ConnectionSnapshot,
  deriveConnectionHealth,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type Instant,
  instantFromIso,
  type ReauthBannerView,
  reauthBannerFor,
} from '@berelax/core'
import { RECONNECT_SCREEN_PATH } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { RECONNECT_PATH } from '../app/(admin)/settings/integrations/handler.ts'
import {
  GOOGLE_REAUTH_BANNER_ATTRIBUTE,
  GOOGLE_REAUTH_BANNER_CSS,
  reconnectHrefFor,
  renderAdminBanner,
  renderGoogleReauthBanner,
} from './components/admin/google-reauth-banner.ts'

/**
 * G-CONN-08 — the banner is on every admin document, and the broken one has nothing to press.
 *
 * ## The bijection, and why there is no exemption list
 *
 * The acceptance line asks for the banner on three sampled admin routes; the unit's summary asks for it on
 * *every* admin page. Sampling three would be satisfied by wiring three and leaving seven, so the claim
 * made here is the whole one: every file under `app/(admin)` that emits a DOCUMENT calls
 * `renderAdminBanner`. The list is read off the filesystem, so a new admin document fails this test by name
 * on the day it is written — there is nothing to add it to and nothing to forget.
 *
 * Two controls beside it, because a walk that found nothing would pass: the count has a floor, and a file
 * in the same tree that is NOT a document must not call the renderer.
 *
 * ## What "non-dismissible" is asserted as here, and what is left to the itest
 *
 * Here: the bytes. The broken banner contains no control of any kind — no `<details>`, no `<summary>`, no
 * `<button>`, no `<form>`, no `<script>`, no `hidden`, no `id` for a stylesheet or a script to target — and
 * no code path in the renderer can return the empty string for a broken state.
 *
 * In `google-reauth-banner.itest.ts`: that a real browser agrees. A substring assertion cannot tell an
 * element that is in the document from one the page's own CSS has collapsed to nothing, and `display: none`
 * added to the stylesheet is exactly the dismissal this file could not see.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ADMIN = join(HERE, '..', 'app', '(admin)')

const NOW = instantFromIso('2026-09-25T10:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function snapshot(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    status: 'active',
    consentAt: (NOW - 30 * DAY) as Instant,
    lastOkAt: (NOW - HOUR) as Instant,
    grantedScopes: [GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
    capabilities: [
      { capability: 'gbp_reviews', health: 'ok' },
      { capability: 'gsc', health: 'ok' },
    ],
    consentScreenInTesting: false,
    gbpAccessGranted: true,
    ...overrides,
  }
}

const bannerFor = (overrides: Partial<ConnectionSnapshot>) =>
  reauthBannerFor({
    health: deriveConnectionHealth(snapshot(overrides), NOW),
    connectionId: 'connection-1',
    googleEmail: 'google-admin@example.invalid',
  })

/**
 * The banner a fixture must have produced, or a failure naming the fixture.
 *
 * `reauthBannerFor` is nullable and three cases below need a non-null one. A `?? ({} as never)` would make
 * a broken fixture render an empty banner and pass, which is the vacuous pass ADR 0003 is about.
 */
function required(banner: ReturnType<typeof reauthBannerFor>, what: string): ReauthBannerView {
  if (banner === null) throw new Error(`the ${what} fixture produced no banner`)
  return banner
}

const BROKEN = renderGoogleReauthBanner(bannerFor({ status: 'needs_reauth' }), '/calendar')
const DEGRADED = renderGoogleReauthBanner(
  bannerFor({ capabilities: [{ capability: 'gsc', health: 'permission_missing' }] }),
  '/calendar',
)

/** Every `.ts` under `app/(admin)`, recursively. Paths relative to that directory, for a readable failure. */
function adminFiles(directory: string = ADMIN, prefix = ''): readonly string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const next = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...adminFiles(next, join(prefix, entry.name)))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      out.push(join(prefix, entry.name))
  }
  return out
}

const source = (file: string): string => readFileSync(join(ADMIN, file), 'utf8')
/** A DOCUMENT emitter: a file that writes a doctype. A fragment, a handler and a route do not. */
const isDocument = (file: string): boolean => source(file).includes('<!doctype html>')

describe('every admin document carries the banner', () => {
  const files = adminFiles()
  const documents = files.filter(isDocument)

  it('finds admin documents at all, which is the non-vacuity control', () => {
    // A floor rather than an exact number: the count goes up when somebody builds an admin screen, and a
    // test that had to be edited for that would be edited without being read. Ten exist as this is written.
    expect(documents.length).toBeGreaterThanOrEqual(9)
    expect(files.length).toBeGreaterThan(documents.length)
  })

  it('calls renderAdminBanner in every one of them', () => {
    const missing = documents.filter((file) => !source(file).includes('renderAdminBanner('))
    expect(
      missing,
      'an admin document that renders no Google re-auth banner: an operator on it would not be told the ' +
        'connection is dead. Add `renderAdminBanner(view.chrome)` after <main> and an `AdminChrome` to ' +
        'its view.',
    ).toEqual([])
  })

  it('does NOT call it from the files that are not documents, so the walk discriminates', () => {
    // Without this the assertion above is satisfied by a search string that matches everything, and by a
    // walk that classified every file as a document.
    const notDocuments = files.filter((file) => !isDocument(file))
    const callers = notDocuments.filter((file) => source(file).includes('renderAdminBanner('))
    expect(callers).toEqual([])
    expect(notDocuments.length).toBeGreaterThan(0)
  })

  it('emits the banner inside <main>, where a landmark can hold it', () => {
    for (const file of documents) {
      const text = source(file)
      const banner = text.indexOf('renderAdminBanner(')
      const main = text.indexOf("'<main>'")
      // Both present, and the banner after the opening of `<main>`: a region outside every landmark is
      // reachable by a screen reader only through "all content", which for a warning is not good enough.
      expect(main, `${file} opens no <main>`).toBeGreaterThan(-1)
      expect(banner, `${file} renders the banner before <main>`).toBeGreaterThan(main)
    }
  })
})

describe('the broken banner has nothing to press', () => {
  it('renders, and says it is not dismissible', () => {
    expect(BROKEN).toContain(`${GOOGLE_REAUTH_BANNER_ATTRIBUTE}="broken"`)
    expect(BROKEN).toContain('data-dismissible="false"')
    expect(BROKEN).toContain('Needs re-authorising')
    expect(BROKEN).toContain('nothing is lost')
  })

  it('contains no control, no script and nothing addressable by name', () => {
    for (const forbidden of [
      '<details',
      '<summary',
      '<button',
      '<form',
      '<script',
      'onclick',
      'hidden',
      'id=',
      'data-action="dismiss',
      'aria-hidden',
    ]) {
      expect(BROKEN, `the broken banner contains ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('cannot be turned off by anything the render is given', () => {
    // Every value the renderer takes, at both extremes. None of them may produce the empty string for a
    // broken connection — which is the whole of "non-dismissible": there is no input that removes it.
    const broken = bannerFor({ status: 'needs_reauth' })
    for (const returnTo of [
      '/calendar',
      '/',
      '/settings/integrations?dismiss=1',
      '/x?banner=off',
    ]) {
      expect(renderGoogleReauthBanner(broken, returnTo)).not.toBe('')
      expect(renderGoogleReauthBanner(broken, returnTo)).toContain('data-dismissible="false"')
    }
    const anonymous = reauthBannerFor({
      health: deriveConnectionHealth(snapshot({ status: 'revoked' }), NOW),
    })
    expect(renderGoogleReauthBanner(anonymous, '/calendar')).toContain('data-dismissible="false"')
  })

  it('carries no CSS that could collapse it', () => {
    // The rules the renderer's own stylesheet ships. The itest asserts the stronger claim — that a real
    // browser lays it out with a non-zero box — and this is the cheap half that names the mechanism.
    for (const forbidden of [
      'display: none',
      'display:none',
      'visibility:',
      'opacity: 0',
      'max-height',
    ]) {
      expect(GOOGLE_REAUTH_BANNER_CSS, `the banner CSS contains ${forbidden}`).not.toContain(
        forbidden,
      )
    }
    // And the control: the stylesheet is not empty, so the absence assertions are about something.
    expect(GOOGLE_REAUTH_BANNER_CSS).toContain('.google-reauth {')
  })
})

describe('the degraded banner may be collapsed and cannot stay collapsed', () => {
  it('renders exactly one native collapse, open', () => {
    expect(DEGRADED).toContain('data-dismissible="true"')
    expect(DEGRADED).toContain('<details open>')
    expect(DEGRADED).toContain('data-action="dismiss-google-reauth"')
    // One control, not two: a second would be a second thing to get wrong.
    expect(DEGRADED.match(/<summary/g)?.length).toBe(1)
  })

  it('needs no script, which is what stops the collapse outliving the response', () => {
    // These documents ship no client bundle. `<details>` collapses without one, and nothing records that
    // it happened — so the next admin page the operator opens renders it expanded. That is the acceptance
    // line's "reappears after a client-side navigation", held by there being nowhere for a dismissal to
    // live rather than by code that puts the banner back.
    expect(DEGRADED).not.toContain('<script')
    expect(DEGRADED).not.toContain('localStorage')
    expect(DEGRADED).not.toContain('document.cookie')
  })

  it('differs from the broken banner in exactly the thing under test', () => {
    // The control on both blocks: a renderer that emitted the same markup for both states would satisfy
    // every positive assertion above.
    expect(DEGRADED).not.toBe(BROKEN)
    expect(DEGRADED).toContain('<details')
    expect(BROKEN).not.toContain('<details')
  })
})

describe('the banner is absent where it must be', () => {
  it('renders the empty string for a healthy connection', () => {
    expect(renderGoogleReauthBanner(bannerFor({}), '/calendar')).toBe('')
    expect(renderAdminBanner({ googleReauth: null, returnTo: '/calendar' })).toBe('')
  })

  it('renders nothing for the expiring and the pending-approval states', () => {
    // Amber and expected. A red band on every admin page for the six weeks of a Business Profile access
    // review, or for the seven days after every consent, is how a real fault comes to be ignored.
    const expiring = bannerFor({
      consentScreenInTesting: true,
      consentAt: (NOW - 6 * DAY) as Instant,
    })
    const pending = bannerFor({
      gbpAccessGranted: false,
      capabilities: [{ capability: 'gbp_reviews', health: 'quota_zero' }],
    })
    expect(renderGoogleReauthBanner(expiring, '/calendar')).toBe('')
    expect(renderGoogleReauthBanner(pending, '/calendar')).toBe('')
  })
})

describe('where Reconnect goes', () => {
  it('starts the consent route G-CONN-07 declares, carrying the page it was pressed on', () => {
    const href = reconnectHrefFor(
      required(bannerFor({ status: 'needs_reauth' }), 'broken'),
      '/calendar?date=2026-09-25',
    )
    // Spelled once: the card's own constant and this builder must name the same route, or the banner sends
    // the owner somewhere the registry does not serve.
    expect(href.startsWith(`${RECONNECT_PATH}?`)).toBe(true)
    expect(RECONNECT_PATH.startsWith(RECONNECT_SCREEN_PATH)).toBe(true)
    const query = new URLSearchParams(href.slice(href.indexOf('?') + 1))
    expect(query.get('connectionId')).toBe('connection-1')
    expect(query.get('returnTo')).toBe('/calendar?date=2026-09-25')
  })

  it('omits the connection when the page is about several of them', () => {
    const anonymous = reauthBannerFor({
      health: deriveConnectionHealth(snapshot({ status: 'needs_reauth' }), NOW),
    })
    const href = reconnectHrefFor(required(anonymous, 'anonymous broken'), '/calendar')
    expect(new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('connectionId')).toBeNull()
  })

  it('escapes what it is given, in the link and in the account', () => {
    const hostile = reauthBannerFor({
      health: deriveConnectionHealth(snapshot({ status: 'needs_reauth' }), NOW),
      connectionId: 'a"><script>alert(1)</script>',
      googleEmail: '<img src=x onerror=alert(1)>',
    })
    const html = renderGoogleReauthBanner(hostile, '/calendar?a="b')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;')
  })
})

/** The document walk is also the thing that keeps this file honest about where it lives. */
it('reads the admin tree it claims to, so a moved directory fails here', () => {
  expect(relative(HERE, ADMIN).includes('(admin)')).toBe(true)
  expect(adminFiles().length).toBeGreaterThan(10)
})
