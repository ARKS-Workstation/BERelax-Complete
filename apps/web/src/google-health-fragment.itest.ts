import type { Instant } from '@berelax/core'
import { instantFromIso } from '@berelax/core'
import { createConnection, type Sql, withUnitOfWork, writeSetting } from '@berelax/db'
import { type SealedToken, TESTING_EXPIRY_TRIPWIRE } from '@berelax/google'
import { type Browser, chromium } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { googleHealthFragment } from '../app/(admin)/settings/integrations/google/health/handler.ts'

/**
 * G-CONN-06 — the Testing-expiry tripwire, asserted against a real DOM in both branches.
 *
 * The acceptance line: *with `publishing_status=testing` the settings surface renders `consent_at + 7 days`
 * as a dated expiry string; with `publishing_status=production` the tripwire element is absent from the
 * DOM — asserted in both branches.*
 *
 * **Why a real DOM and not a substring match.** The second half is the half that matters, and it is the
 * half a string assertion gets wrong: `expect(html).not.toContain('tripwire')` passes for a fragment that
 * rendered the element with `hidden` on it, for one that rendered it inside an HTML comment, and for one
 * that failed to render anything at all. `document.querySelector(...) === null` is the claim, so the claim
 * is made against a parser. Chromium is already a dependency of this app's other integration tests and is
 * used with the same flags.
 *
 * **Why the handler and not the route.** The handler takes its instant as an argument, which is what lets
 * the fragment be rendered at a frozen clock five days after a consent — the whole point of a tripwire is
 * what it says before anything has gone wrong, and a route reading `Date.now()` could not be asked. The
 * split is the one `app/api/v1/otp` already uses.
 *
 * **Scoping.** The fragment lists every connection, and the integration suite runs sequentially against
 * one database where earlier files leave connections behind. So the presence assertions are scoped to this
 * file's own `section[data-google-connection="…"]`, and the absence assertion is made over the whole
 * document — which is the stronger direction and is unaffected by leftovers.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const PUBLISHING_STATUS = 'google.consent_screen_publishing_status'
const SUB = 'sub-google-health-fragment'
/** 18:00 Gulf time, so the seven-day expiry falls on a date the UTC rendering would get wrong. */
const CONSENT_ISO = '2026-09-18T14:00:00.000Z'
const CONSENT = instantFromIso(CONSENT_ISO)
const DAY = 24 * 60 * 60 * 1000

/**
 * A sealed-token shape, built by hand and never opened.
 *
 * The fragment makes **no Google call** — that is its design, so the tripwire still renders on the day the
 * grant dies — so nothing here needs a token that decrypts. `sealToken` is behind the chokepoint and this
 * file may not name it; `SealedToken` is a type, and a type decrypts nothing.
 */
const TOKEN: SealedToken = {
  ct: Buffer.from([0]),
  nonce: Buffer.from([0]),
  wrappedKey: Buffer.from([0]),
  kid: 'v1',
  aadFingerprint: 'not-a-real-fingerprint',
}

let sql: Sql
let browser: Browser
let connectionId = ''

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  browser = await chromium.launch({ args: ['--no-sandbox', '--font-render-hinting=none'] })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  // Back to the strict default, so no later suite inherits a published consent screen from this file.
  await setPublishingStatus('testing')
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from google_connections where google_sub = ${SUB}`
  const [row] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp, consent_at, status)
    values (${SUB}, 'google-admin@berelax.ae',
            array['https://www.googleapis.com/auth/webmasters.readonly'],
            ${TOKEN.ct}, ${TOKEN.nonce}, ${TOKEN.wrappedKey}, ${TOKEN.kid}, ${TOKEN.aadFingerprint},
            ${new Date(CONSENT)}, 'active')
    returning id
  `
  connectionId = row?.id ?? ''
  await sql`
    insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary)
    values (${connectionId}, 'gsc', ${sql.json({ siteUrl: 'sc-domain:berelaxmassage.com' })}, 'ok', true)
  `
})

async function setPublishingStatus(value: 'testing' | 'production'): Promise<void> {
  // Through `writeSetting`, not an INSERT: it validates against the declared schema and records the change
  // in the append-only history, which is the path an admin takes. A hand-written row would let this test
  // store a value the settings registry would have refused.
  await withUnitOfWork(sql, { kind: 'system', label: 'gconn06-fragment-itest' }, (uow) =>
    writeSetting(uow, {
      key: PUBLISHING_STATUS,
      value,
      role: 'owner',
      actorLabel: 'gconn06-fragment-itest',
    }),
  )
}

async function fragmentAt(days: number): Promise<string> {
  const now = (CONSENT + days * DAY) as Instant
  return (await googleHealthFragment({ sql, now })).html
}

describe('acceptance — publishing_status=testing renders the dated expiry', () => {
  it('puts the tripwire element in the DOM, carrying consent_at + 7 days', async () => {
    await setPublishingStatus('testing')
    const html = await fragmentAt(5)

    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.setContent(`<!doctype html><html lang="en"><body>${html}</body></html>`)
      const tripwire = await page.evaluate(
        ({ id, selector }: { id: string; selector: string }) => {
          const section = document.querySelector(`[data-google-connection="${id}"]`)
          const element = section?.querySelector(selector) ?? null
          return element === null
            ? null
            : {
                expiresOn: element.getAttribute('data-expires-on'),
                warningDue: element.getAttribute('data-warning-due'),
                text: element.textContent ?? '',
                // The whole document, so a scope URL anywhere would be caught rather than only in this node.
                documentText: document.body.textContent ?? '',
              }
        },
        { id: connectionId, selector: `[data-tripwire="${TESTING_EXPIRY_TRIPWIRE}"]` },
      )

      if (tripwire === null) throw new Error('the tripwire element is not in the DOM')
      // 14:00 UTC on the 18th is 18:00 Gulf time; seven days later is the 25th where the owner is standing.
      expect(tripwire.expiresOn).toBe('2026-09-25')
      expect(tripwire.text).toContain('25 September 2026')
      expect(tripwire.text).toContain('Asia/Dubai')
      // Day five is inside the 48-hour window, so the predictive warning is due — which is the ordering the
      // whole tripwire exists for: the date is shown before anything is broken.
      expect(tripwire.warningDue).toBe('true')
      // docs/10 §4: plain English, never a scope string.
      expect(tripwire.documentText).not.toContain('googleapis.com/auth/')
    } finally {
      await context.close()
    }
  }, 120_000)

  it('shows the date on day one too, long before any threshold is crossed', async () => {
    // The point of a *rendered date* rather than an alert threshold: on day one nothing is due, and the
    // owner can still publish the consent screen. An element that only appeared at T-48h would be a
    // notification, not a tripwire.
    await setPublishingStatus('testing')
    const html = await fragmentAt(1)
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.setContent(`<!doctype html><html lang="en"><body>${html}</body></html>`)
      const seen = await page.evaluate(
        ({ id, selector }: { id: string; selector: string }) => {
          const element = document
            .querySelector(`[data-google-connection="${id}"]`)
            ?.querySelector(selector)
          return element === null || element === undefined
            ? null
            : {
                expiresOn: element.getAttribute('data-expires-on'),
                warningDue: element.getAttribute('data-warning-due'),
              }
        },
        { id: connectionId, selector: `[data-tripwire="${TESTING_EXPIRY_TRIPWIRE}"]` },
      )
      expect(seen?.expiresOn).toBe('2026-09-25')
      expect(seen?.warningDue).toBeNull()
    } finally {
      await context.close()
    }
  }, 120_000)
})

describe('acceptance — publishing_status=production leaves the tripwire out of the DOM', () => {
  it('finds no tripwire element anywhere in the document', async () => {
    await setPublishingStatus('production')
    const html = await fragmentAt(5)

    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.setContent(`<!doctype html><html lang="en"><body>${html}</body></html>`)
      const counts = await page.evaluate(
        ({ id, selector }: { id: string; selector: string }) => ({
          // Absent, not hidden. `querySelector` returning null is the claim; a `hidden` attribute, an HTML
          // comment or a display rule would all satisfy a substring assertion and none of them is absence.
          tripwires: document.querySelectorAll(selector).length,
          // And the surface itself still rendered, so "no tripwire" cannot be satisfied by an empty page —
          // which is exactly what a thrown setting or a broken query would produce.
          sections: document.querySelectorAll('[data-google-connection]').length,
          mine: document.querySelectorAll(`[data-google-connection="${id}"]`).length,
        }),
        { id: connectionId, selector: `[data-tripwire="${TESTING_EXPIRY_TRIPWIRE}"]` },
      )
      expect(counts.tripwires).toBe(0)
      expect(counts.mine).toBe(1)
      expect(counts.sections).toBeGreaterThanOrEqual(1)
    } finally {
      await context.close()
    }
  }, 120_000)

  it('and the same document with the consent screen in Testing does have one', async () => {
    // The pair, in one test, so the two branches cannot both be passing for the same reason — a selector
    // typo would make the absence assertion above pass for ever.
    await setPublishingStatus('testing')
    const withFuse = await fragmentAt(5)
    await setPublishingStatus('production')
    const withoutFuse = await fragmentAt(5)

    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      const count = async (html: string): Promise<number> => {
        await page.setContent(`<!doctype html><html lang="en"><body>${html}</body></html>`)
        return page.evaluate(
          (selector: string) => document.querySelectorAll(selector).length,
          `[data-tripwire="${TESTING_EXPIRY_TRIPWIRE}"]`,
        )
      }
      expect(await count(withFuse)).toBeGreaterThanOrEqual(1)
      expect(await count(withoutFuse)).toBe(0)
    } finally {
      await context.close()
    }
  }, 120_000)
})

describe('the fragment reads stored rows and makes no Google call', () => {
  it('renders the recency beside the state, because Connected with no recency hides failure', async () => {
    await setPublishingStatus('testing')
    await sql`
      update google_connections set last_ok_at = ${new Date(CONSENT + 5 * DAY - 2 * 60 * 60 * 1000)}
      where id = ${connectionId}
    `
    const fragment = await googleHealthFragment({ sql, now: (CONSENT + 5 * DAY) as Instant })
    expect(fragment.html).toContain('data-connection-recency="2"')
    expect(fragment.publishingStatus).toBe('testing')
    expect(fragment.connections).toBeGreaterThanOrEqual(1)
  }, 60_000)

  it('refuses a publishing status it cannot interpret rather than rendering a page with no fuse', async () => {
    // The strict branch, and the reason it is a refusal: the only two values an unknown status could be
    // coerced to are the one that shows the expiry and the one that hides it, and silently choosing the
    // second would report a connection with a live seven-day fuse as having none.
    await sql`
      insert into app_setting (key, value, tier) values (${PUBLISHING_STATUS}, '"internal"'::jsonb, 'operational')
      on conflict (key) do update set value = '"internal"'::jsonb
    `
    await expect(googleHealthFragment({ sql, now: CONSENT })).rejects.toThrow(
      /not a publishing status/,
    )
    await setPublishingStatus('testing')
  }, 60_000)
})
