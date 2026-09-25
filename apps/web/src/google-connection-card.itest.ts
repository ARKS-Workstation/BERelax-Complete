import type { Instant } from '@berelax/core'
import { instantFromIso } from '@berelax/core'
import { createConnection, type Sql, withUnitOfWork, writeSetting } from '@berelax/db'
import type { SealedToken } from '@berelax/google'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { renderIntegrationsPage } from '../app/(admin)/settings/integrations/connection-card.ts'
import { integrationsView } from '../app/(admin)/settings/integrations/handler.ts'
import { POST as testConnectionRoute } from '../app/(admin)/settings/integrations/test-connection/route.ts'

/**
 * G-CONN-07 — the connection card, against a real database and a real DOM.
 *
 * What is here is everything that cannot be decided by reading source: the claims about a parsed document,
 * the accessibility audit, and the reproducibility of the render. The claims about the renderer's branches
 * are in `google-connection-card.test.ts`, which runs in milliseconds and needs neither.
 *
 * ## Why a real DOM rather than a substring match
 *
 * Two of the acceptance lines are absence claims, and absence is what a substring assertion gets wrong.
 * `expect(html).not.toContain('googleapis.com/auth/')` is the easy half; *"the healthy label never appears
 * without a timestamp"* and *"the tripwire element is absent"* are satisfied by an element rendered with
 * `hidden` on it, by one inside an HTML comment, and by a page that failed to render at all.
 * `document.querySelector(...) === null` beside a positive control is the claim, so both are made against a
 * parser.
 *
 * ## Why no server, and therefore no port band
 *
 * `connection-card.ts` is pure and `handler.ts` takes its instant as an argument, so `page.setContent`
 * renders the exact bytes the route serves — at a frozen clock, five days after a consent, which is the
 * only way to assert what a tripwire says *before* anything has gone wrong. There is nothing between the
 * renderer and the assertion, no `next start`, no port to draw and no temp root to leave behind (brief
 * rules 18 and 19). `apps/web/src/manage-booking.itest.ts` does the same for the same reason.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave connections behind
 * (brief rule 12) — `google-oauth.itest.ts` and `google-health-fragment.itest.ts` both create some. So
 * every assertion narrows the page to this file's own connection with `connectionId`, which narrows what
 * the code under test can *see* rather than deleting rows a foreign key protects:
 * `google_reviews.connection_id` is ON DELETE RESTRICT. The absence assertions are made over the narrowed
 * document, which is the stronger direction.
 *
 * The four settings this file writes are global, so `afterAll` puts every one of them back to its declared
 * default — a published consent screen or an approved Business Profile inherited by a later suite would
 * silence exactly the checks those suites exist to make.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const PUBLISHING_STATUS = 'google.consent_screen_publishing_status'
const GBP_ACCESS = 'google.business_profile_access_granted'
const SUBMITTED_ON = 'google.business_profile_application_submitted_on'
const QUOTA_URL = 'google.cloud_quota_page_url'

const SUB = 'sub-google-connection-card'
const ACCOUNT = 'google-admin@berelax.ae'
/** 18:00 Gulf time, so the seven-day expiry falls on a date a UTC rendering would get wrong. */
const CONSENT_ISO = '2026-09-18T14:00:00.000Z'
const CONSENT = instantFromIso(CONSENT_ISO)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
/** Two hours after the last successful call, so the recency phrase is a known string. */
const NOW = (CONSENT + 5 * DAY) as Instant
const LAST_OK = (NOW - 2 * HOUR) as Instant

const PLACE_ID = 'ChIJ-gconn07-card-fixture'
const SITE_URL = 'sc-domain:berelaxmassage.com'
/** A listing title and address as the picker would have recorded them, named as fixtures. */
const LISTING_TITLE = 'Be Relax fixture listing'
const LISTING_ADDRESS = 'A postal address recorded by the picker fixture'

/**
 * A sealed-token shape, built by hand and never opened.
 *
 * The card makes **no Google call** — that is its design, so it still renders on the day the grant dies —
 * so nothing here needs a token that decrypts. `sealToken` lives behind the chokepoint and this file may
 * not name it; `SealedToken` is a type, and a type decrypts nothing.
 */
const TOKEN: SealedToken = {
  ct: Buffer.from([0]),
  nonce: Buffer.from([0]),
  wrappedKey: Buffer.from([0]),
  kid: 'v1',
  aadFingerprint: 'not-a-real-fingerprint',
}

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
}

/** Three viewports and two themes. No direction axis, and the header says why. */
const CELLS: readonly Cell[] = [390, 768, 1440].flatMap((width) =>
  (['light', 'dark'] as const).map((theme) => ({
    width,
    height: width === 390 ? 844 : 900,
    theme,
  })),
)

let sql: Sql
let browser: Browser
let connectionId = ''

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 120_000)

afterAll(async () => {
  await browser?.close()
  await setSetting(PUBLISHING_STATUS, 'testing')
  await setSetting(GBP_ACCESS, false)
  await setSetting(SUBMITTED_ON, '')
  await setSetting(QUOTA_URL, '')
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from google_connections where google_sub = ${SUB}`
  const [row] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp, consent_at, status,
       last_ok_at, last_checked_at)
    values (${SUB}, ${ACCOUNT},
            array['https://www.googleapis.com/auth/business.manage',
                  'https://www.googleapis.com/auth/webmasters.readonly'],
            ${TOKEN.ct}, ${TOKEN.nonce}, ${TOKEN.wrappedKey}, ${TOKEN.kid}, ${TOKEN.aadFingerprint},
            ${new Date(CONSENT)}, 'active', ${new Date(LAST_OK)}, ${new Date(LAST_OK)})
    returning id
  `
  connectionId = row?.id ?? ''
  for (const [capability, ref] of [
    [
      'gbp_reviews',
      { account: 'accounts/fixture', location: 'locations/fixture', placeId: PLACE_ID },
    ],
    [
      'gbp_location',
      { account: 'accounts/fixture', location: 'locations/fixture', placeId: PLACE_ID },
    ],
    ['gsc', { siteUrl: SITE_URL }],
  ] as const) {
    await sql`
      insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary)
      values (${connectionId}, ${capability}, ${sql.json(ref)}, 'ok', true)
    `
  }
  // The owner-confirmed snapshot, in the shape the picker writes it — which is what `confirmedListing`
  // reads, so the card shows the listing through the same path production does.
  await sql`
    insert into google_connection_events
      (connection_id, google_sub, event, actor_kind, actor_label, detail)
    values (${connectionId}, ${SUB}, 'capability_changed', 'staff', 'gconn07-card-itest',
            ${sql.json({
              capability: 'gbp_location',
              source: 'picker',
              placeId: PLACE_ID,
              title: LISTING_TITLE,
              address: LISTING_ADDRESS,
            })})
  `
  await setSetting(PUBLISHING_STATUS, 'production')
  await setSetting(GBP_ACCESS, true)
  await setSetting(SUBMITTED_ON, '')
  await setSetting(QUOTA_URL, '')
})

async function setSetting(key: string, value: unknown): Promise<void> {
  // Through `writeSetting`, not an INSERT: it validates against the declared schema and records the change
  // in the append-only history, which is the path an admin takes. A hand-written row would let this file
  // store a value the registry would have refused — and both new settings exist precisely to refuse one.
  await withUnitOfWork(sql, { kind: 'system', label: 'gconn07-card-itest' }, (uow) =>
    writeSetting(uow, { key, value, role: 'owner', actorLabel: 'gconn07-card-itest' }),
  )
}

async function cardHtml(options: { readonly now?: Instant } = {}): Promise<string> {
  const view = await integrationsView({ sql, now: options.now ?? NOW, connectionId })
  return renderIntegrationsPage(view)
}

async function inPage<T>(html: string, body: (page: Page) => Promise<T>, cell?: Cell): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cell?.width ?? 1440, height: cell?.height ?? 900 },
    deviceScaleFactor: 1,
    colorScheme: cell?.theme ?? 'light',
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  try {
    const page = await context.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

describe('acceptance — the rendered card contains no scope string', () => {
  it('finds zero googleapis.com/auth/ substrings, and the English labels instead', async () => {
    const html = await cardHtml()
    const seen = await inPage(html, (page) =>
      page.evaluate(() => ({
        // The whole document, markup included: an href or a data attribute carrying a scope URL would be
        // invisible to a check over textContent alone.
        markup: document.documentElement.outerHTML,
        text: document.body.textContent ?? '',
        scopes: [...document.querySelectorAll('[data-scopes] li')].map(
          (node) => node.textContent ?? '',
        ),
      })),
    )
    expect(seen.markup).not.toContain('googleapis.com/auth/')
    expect(seen.markup).not.toContain('googleapis.com')
    // Two granted scopes, each rendered as its English sentence from the lookup table.
    expect(seen.scopes).toHaveLength(2)
    expect(seen.scopes.join(' ')).toContain('no read-only version of this permission')
    expect(seen.scopes.join(' ')).toContain('Read Search Console performance figures')
    // The control: the stored row really does hold the scope URLs, so the absence above is the card's
    // doing rather than an empty grant.
    const [stored] = await sql<{ scopes: string[] }[]>`
      select granted_scopes as scopes from google_connections where id = ${connectionId}
    `
    expect(stored?.scopes.join(' ')).toContain('googleapis.com/auth/')
    expect(seen.text).toContain(ACCOUNT)
  }, 120_000)
})

describe('acceptance — Connected cannot render without a recency', () => {
  it('shows the healthy headline beside a relative timestamp', async () => {
    const seen = await inPage(await cardHtml(), (page) =>
      page.evaluate(() => {
        const card = document.querySelector('[data-google-connection]')
        return {
          state: card?.getAttribute('data-connection-state') ?? null,
          headline:
            card?.querySelector('[data-connection-headline="healthy"]')?.textContent ?? null,
          recency: card?.querySelector('[data-recency]')?.getAttribute('data-recency') ?? null,
        }
      }),
    )
    expect(seen.state).toBe('healthy')
    expect(seen.headline).toBe('Connected')
    expect(seen.recency).toBe('Last verified 2 hours ago')
  }, 120_000)

  it('renders the degraded state instead when last_ok_at is NULL', async () => {
    // The derivation says healthy — a connection consented five days ago with nothing read is not stale by
    // the 48-hour window, because staleness falls back to the consent. The CARD may not say Connected,
    // because there is no timestamp to put beside it: docs/10 §4's "Connected with no recency is exactly
    // how silent failure hides".
    await sql`update google_connections set last_ok_at = null where id = ${connectionId}`
    const seen = await inPage(await cardHtml({ now: (CONSENT + HOUR) as Instant }), (page) =>
      page.evaluate(() => {
        const card = document.querySelector('[data-google-connection]')
        return {
          state: card?.getAttribute('data-connection-state') ?? null,
          derived: card?.getAttribute('data-derived-state') ?? null,
          // Absence, over the whole document rather than the card: a headline rendered anywhere is the
          // thing being refused.
          healthyHeadlines: document.querySelectorAll('[data-connection-headline="healthy"]')
            .length,
          recency: card?.querySelector('[data-recency]')?.getAttribute('data-recency') ?? null,
          cards: document.querySelectorAll('[data-google-connection]').length,
        }
      }),
    )
    expect(seen.derived).toBe('healthy')
    expect(seen.state).toBe('degraded')
    expect(seen.healthyHeadlines).toBe(0)
    expect(seen.recency).toBe('never')
    // And the page rendered: "no healthy headline" must not be satisfiable by an empty document.
    expect(seen.cards).toBe(1)
  }, 120_000)
})

describe('acceptance — the amber pending state', () => {
  async function pending(settings: { submittedOn: string; quotaUrl: string }): Promise<string> {
    // `access_not_granted` as the stored health, which is what the daily pass writes for a refused
    // Business Profile read while the access application is pending: `quota_zero`.
    await sql`
      update google_capabilities set health = 'quota_zero'
       where connection_id = ${connectionId} and capability in ('gbp_reviews', 'gbp_location')
    `
    await setSetting(GBP_ACCESS, false)
    await setSetting(SUBMITTED_ON, settings.submittedOn)
    await setSetting(QUOTA_URL, settings.quotaUrl)
    return await cardHtml()
  }

  it('renders the exact sentence, the stored submission date and the quota link', async () => {
    const html = await pending({
      submittedOn: '2026-09-01',
      quotaUrl: 'https://console.example.test/quotas/business-profile',
    })
    const seen = await inPage(html, (page) =>
      page.evaluate(() => {
        const card = document.querySelector('[data-google-connection]')
        const paragraph = card?.querySelector('[data-pending-approval]') ?? null
        const link = paragraph?.querySelector('a')
        return {
          state: card?.getAttribute('data-connection-state') ?? null,
          headline: card?.querySelector('[data-connection-headline]')?.textContent?.trim() ?? null,
          submittedOn: paragraph?.getAttribute('data-submitted-on') ?? null,
          quotaLink: paragraph?.getAttribute('data-quota-link') ?? null,
          href: link?.getAttribute('href') ?? null,
          text: paragraph?.textContent ?? '',
        }
      }),
    )
    expect(seen.state).toBe('pending_gbp_approval')
    expect(seen.headline).toBe('Connected, Business Profile access pending Google approval')
    expect(seen.submittedOn).toBe('2026-09-01')
    expect(seen.quotaLink).toBe('set')
    expect(seen.href).toBe('https://console.example.test/quotas/business-profile')
    // The figures approval is observable as, in the words docs/10 §1 uses.
    expect(seen.text).toContain('from 0 to 300 requests per minute')
  }, 120_000)

  it('says the date is not recorded and renders no link when neither is configured', async () => {
    // Brief rule 15 on the screen it matters most: a plausible date is indistinguishable from a recorded
    // one, and a Cloud console URL written from memory opens the wrong project or nothing at all.
    const html = await pending({ submittedOn: '', quotaUrl: '' })
    const seen = await inPage(html, (page) =>
      page.evaluate(() => {
        const paragraph = document.querySelector('[data-pending-approval]')
        return {
          submittedOn: paragraph?.getAttribute('data-submitted-on') ?? null,
          quotaLink: paragraph?.getAttribute('data-quota-link') ?? null,
          anchors: paragraph?.querySelectorAll('a').length ?? -1,
          text: paragraph?.textContent ?? '',
        }
      }),
    )
    expect(seen.submittedOn).toBe('not-recorded')
    expect(seen.quotaLink).toBe('unset')
    expect(seen.anchors).toBe(0)
    expect(seen.text).toContain('has not been recorded')
    expect(seen.text).toContain('APIs and services')
  }, 120_000)

  it('leaves the paragraph out of the DOM once access is approved', async () => {
    // The control on the whole state, and the transition the machine calls the one setting change that
    // makes a connection look worse: the identical refusal is a fault the moment Google says access is
    // granted, so the amber paragraph goes and the degraded state arrives.
    await pending({ submittedOn: '2026-09-01', quotaUrl: '' })
    await setSetting(GBP_ACCESS, true)
    const seen = await inPage(await cardHtml(), (page) =>
      page.evaluate(() => ({
        paragraphs: document.querySelectorAll('[data-pending-approval]').length,
        state:
          document
            .querySelector('[data-google-connection]')
            ?.getAttribute('data-connection-state') ?? null,
      })),
    )
    expect(seen.paragraphs).toBe(0)
    expect(seen.state).toBe('degraded')
  }, 120_000)
})

describe('acceptance — the Testing expiry tripwire, in both branches', () => {
  it('renders the dated expiry while the consent screen is in Testing', async () => {
    await setSetting(PUBLISHING_STATUS, 'testing')
    const seen = await inPage(await cardHtml(), (page) =>
      page.evaluate(() => {
        const element = document.querySelector('[data-tripwire="google-testing-expiry"]')
        return {
          expiresOn: element?.getAttribute('data-expires-on') ?? null,
          text: element?.textContent ?? '',
        }
      }),
    )
    // 14:00 UTC on the 18th is 18:00 Gulf time; seven days later is the 25th where the owner is standing.
    expect(seen.expiresOn).toBe('2026-09-25')
    expect(seen.text).toContain('25 September 2026')
  }, 120_000)

  it('leaves the element out of the DOM once it is published', async () => {
    await setSetting(PUBLISHING_STATUS, 'production')
    const seen = await inPage(await cardHtml(), (page) =>
      page.evaluate(() => ({
        tripwires: document.querySelectorAll('[data-tripwire]').length,
        cards: document.querySelectorAll('[data-google-connection]').length,
      })),
    )
    expect(seen.tripwires).toBe(0)
    expect(seen.cards).toBe(1)
  }, 120_000)
})

describe('acceptance — Test connection refuses rather than reporting a success it has not earned', () => {
  /** The route, called directly. No server, for the reason the header gives. */
  const post = async (body: BodyInit | null, type: string): Promise<Response> =>
    await testConnectionRoute(
      new Request('http://localhost/settings/integrations/test-connection', {
        method: 'POST',
        headers: { 'content-type': type },
        ...(body === null ? {} : { body }),
      }),
    )

  it('answers 400 when no connection is named', async () => {
    // "Whichever connection sorts first" is how a second account gets tested and the first one reported —
    // the failure mode `with-google.itest.ts` records for `resolveTarget`.
    const response = await post('connectionId=', 'application/x-www-form-urlencoded')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, reason: 'connection_id_required' })
  })

  it('answers 503 by name when no key is available to open the stored token', async () => {
    // The case that matters: with no KEK the check CANNOT establish anything, and the one answer it must
    // never give is `ok`. A named 503 is what a settings screen can act on; a 200 with `ok: false` would
    // say the connection is broken, which is a different claim and the wrong one.
    const before = process.env['GOOGLE_TOKEN_KEK']
    delete process.env['GOOGLE_TOKEN_KEK']
    try {
      const response = await post(
        `connectionId=${connectionId}`,
        'application/x-www-form-urlencoded',
      )
      expect(response.status).toBe(503)
      const body = (await response.json()) as { ok: boolean; reason: string }
      expect(body.ok).toBe(false)
      expect(body.reason).toBe('google_token_kek_absent')
    } finally {
      if (before === undefined) delete process.env['GOOGLE_TOKEN_KEK']
      else process.env['GOOGLE_TOKEN_KEK'] = before
    }
  })

  it('answers a named refusal for a connection nothing holds, and never ok', async () => {
    // The control on the shape of the answer: a completed check reports 200 with `ok: false` and a reason
    // from the closed set, which is what distinguishes "the check ran and found a problem" from "the check
    // could not run". `connection_not_found` is the one case reachable without a key that opens.
    const before = process.env['GOOGLE_TOKEN_KEK']
    // A generated 32-byte key, so the deps assemble. It opens nothing — this file may not seal a token
    // (the chokepoint allows five modules, none of them here), which is exactly why the SUCCESS path of
    // Test connection is asserted in `packages/google/src/health/test-connection.test.ts` instead.
    process.env['GOOGLE_TOKEN_KEK'] = Buffer.alloc(32, 7).toString('base64')
    try {
      const response = await post(
        JSON.stringify({ connectionId: '01920000-0000-7000-8000-00000000ffff' }),
        'application/json',
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as { ok: boolean; reason: string }
      expect(body.ok).toBe(false)
      expect(body.reason).toBe('connection_not_found')
    } finally {
      if (before === undefined) delete process.env['GOOGLE_TOKEN_KEK']
      else process.env['GOOGLE_TOKEN_KEK'] = before
    }
  })
})

describe('acceptance — axe reports nothing serious or critical, in six renders', () => {
  it('audits the card at 390/768/1440 x light/dark, and each render is the cell it claims', async () => {
    // Six, stated rather than counted after the fact: a matrix that lost an axis would report a pass over
    // three renders.
    expect(CELLS).toHaveLength(6)
    const html = await cardHtml()
    const luminance: Record<string, number> = {}
    let audited = 0
    for (const cell of CELLS) {
      const where = `${cell.width} ${cell.theme}`
      const seen = await inPage(
        html,
        async (page) => {
          const result = await auditPage(page, {
            page: '/settings/integrations',
            viewport: {
              name: String(cell.width),
              width: cell.width,
              height: cell.height,
              scale: 1,
              why: 'G-CONN-07 acceptance',
            },
            theme: cell.theme,
            direction: 'ltr',
          })
          return {
            violations: result.violations,
            width: await page.evaluate(() => globalThis.innerWidth),
            lum: await page.evaluate(() => {
              const colour = globalThis.getComputedStyle(document.body).backgroundColor
              const parts = colour.match(/\d+(\.\d+)?/g)?.map(Number) ?? [255, 255, 255]
              return 0.2126 * (parts[0] ?? 0) + 0.7152 * (parts[1] ?? 0) + 0.0722 * (parts[2] ?? 0)
            }),
          }
        },
        cell,
      )
      expect(seen.width, `${where}: viewport`).toBe(cell.width)
      luminance[where] = seen.lum
      const blocking = blockingViolations(seen.violations)
      expect(
        blocking.map(describeViolation),
        `${where}: ${blocking.length} serious/critical violation(s)`,
      ).toEqual([])
      audited += 1
    }
    expect(audited).toBe(6)
    // The theme axis is real: the dark cell resolved a darker ground at every width. Without this, six
    // identical light renders would satisfy every assertion above.
    for (const width of [390, 768, 1440]) {
      expect(luminance[`${width} dark`], `${width}: dark is darker than light`).toBeLessThan(
        luminance[`${width} light`] ?? 0,
      )
    }
  }, 600_000)

  it('reports the two defects a known-bad version of this card has, by rule id', async () => {
    // The control on the audit itself (ADR 0003): a sweep that reported zero because axe never ran would
    // pass the case above for ever. The two failures docs/08 fences off are injected into the DOM.
    const violations = await inPage(await cardHtml(), async (page) => {
      await page.evaluate(() => {
        const button = document.createElement('button')
        button.type = 'button'
        document.body.append(button)
        const text = document.createElement('p')
        text.textContent = 'Reconnect this account'
        // The decorative gold on the sand surface: 2.90:1, and the reason --color-decor-gold never
        // carries text. Read from the token layer rather than typed, so this file states no colour.
        const root = globalThis.getComputedStyle(document.documentElement)
        text.style.color = root.getPropertyValue('--color-decor-gold')
        text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
        document.body.append(text)
      })
      const result = await auditPage(page, {
        page: '/settings/integrations (known-bad)',
        viewport: { name: '390', width: 390, height: 844, scale: 1, why: 'the control' },
        theme: 'light',
        direction: 'ltr',
      })
      return result.violations
    })
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
    expect(blockingViolations(violations).map((violation) => violation.id)).toContain('button-name')
  }, 300_000)
})

describe('acceptance — the same card photographed twice is byte-identical', () => {
  it('captures six cells twice with zero pixel diff', async () => {
    const html = await cardHtml()
    let compared = 0
    for (const cell of CELLS) {
      const shot = async (): Promise<Uint8Array> =>
        await inPage(
          html,
          async (page) => {
            const { png } = await captureUntilStable(
              async () => await page.screenshot({ fullPage: true }),
              { label: `integrations ${cell.width} ${cell.theme}` },
            )
            return png
          },
          cell,
        )
      // Two independent browser contexts, so the comparison is about the page rather than about one
      // context's cache.
      const first = await shot()
      const second = await shot()
      expect(
        Buffer.compare(Buffer.from(first), Buffer.from(second)),
        `${cell.width} ${cell.theme}`,
      ).toBe(0)
      expect(first.byteLength, `${cell.width} ${cell.theme}: empty image`).toBeGreaterThan(1000)
      compared += 1
    }
    expect(compared).toBe(6)
  }, 600_000)

  it('and a changed card produces different bytes', async () => {
    // The control. "Byte-identical" is worth nothing unless a real change is visible, and the change used
    // is the one this unit is about: the same connection with nothing read yet renders amber.
    const cell = CELLS[0]
    if (cell === undefined) throw new Error('no cells')
    const healthy = await cardHtml()
    await sql`update google_connections set last_ok_at = null where id = ${connectionId}`
    const degraded = await cardHtml({ now: (CONSENT + HOUR) as Instant })
    const shot = async (html: string): Promise<Uint8Array> =>
      await inPage(html, async (page) => await page.screenshot({ fullPage: true }), cell)
    expect(
      Buffer.compare(Buffer.from(await shot(healthy)), Buffer.from(await shot(degraded))),
    ).not.toBe(0)
  }, 300_000)
})
