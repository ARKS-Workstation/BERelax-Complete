import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createConnection, type Sql } from '@berelax/db'
import { createFixturePrincipal } from '@berelax/fixtures'
import { installAdminBrowserCookie, installAdminCookie } from '@berelax/harness/admin-session'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import {
  CARD_DATA_REDACTED,
  CHECKOUT_FIELDS,
  permittedOrigins,
  SECRET_FIELD_REDACTED,
} from '@berelax/payments'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Y-PAY-03 — the SAQ-A checkout in a real browser, and the PAN sweep over every sink (the acceptance list).
 *
 * The band `checkout` in `@berelax/harness/ports` is this file's (brief rules 18 and 19).
 *
 * ## The three claims no unit test can make, and why each needs this file
 *
 * **The card field is inside a CROSS-ORIGIN iframe.** "Cross-origin" is not a property of the markup — an
 * `<iframe src>` pointing at our own origin renders identically — it is `frame.contentDocument === null` in a
 * browser enforcing the same-origin policy. So the suite stands a STAND-IN GATEWAY ORIGIN up in front of the
 * application: a plain `node:http` server, on its own port, serving a card-entry document that DOES contain a
 * card input. The application is then told to point its frame at it, and the browser is asked whether it can
 * read it. The answer has to be no.
 *
 * That stand-in is the honest shape of the thing: under ADR 0022 every external service is a port with a fake,
 * and the gateway's card-entry document is the one part of a hosted-fields integration that is not code in this
 * repository at all. Its port comes from the KERNEL (`listen(0)`) rather than from the band, because an
 * ephemeral port cannot collide with anything and drawing a second port from the band would be the arithmetic
 * rule 18 forbids. It is a DIFFERENT PORT from the application's, which is what makes it a different origin:
 * an origin is (scheme, host, port), so `http://127.0.0.1:<a>` and `http://127.0.0.1:<b>` are as
 * cross-origin as two domains.
 *
 * **No card number reaches any sink.** A Luhn-valid test PAN and a CVV are driven at the token endpoint, and
 * then `audit_event`, `outbox_event`, the `message` outbox and the served response are full-text scanned for
 * both. A sink is scanned even when the request was refused — especially then, because the refusal is the
 * thing that writes.
 *
 * **The content-security policy is on the response.** A header is a property of a served response, and the
 * policy's whole job is to be sent.
 *
 * ## What is NOT here
 *
 * The policy's exact string, the origin count and the directive that must not include `'self'` are
 * `packages/payments/src/hosted-fields.test.ts`'s; the document's bytes are `checkout-render.test.ts`'s; the
 * detector and the redactor are `redaction.test.ts`'s; and the agreement between the TypeScript rule and
 * migration 0117's SQL one is `packages/fixtures/src/card-shape-agreement.itest.ts`'s. This file makes only the
 * claims that need a browser, a server and a database.
 *
 * ## Nothing here can be emptied
 *
 * `payment_intent` and `payment_intent_transaction` refuse DELETE through `ZY161`, and `audit_event` and
 * `outbox_event` are append-only (ADR 0008). So every count is a DELTA scoped to this run's token and no
 * assertion is a total (brief rule 9).
 */

const RUN = `ypay03-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const CHECKOUT_PATH = '/checkout'
const TOKEN_PATH = '/api/v1/payments/token'

/**
 * The Luhn-valid test number every payment library ships, and a security code beside it.
 *
 * Not a real card and not capable of being one: it is the documented test value, it belongs to nobody, and it
 * exists precisely so that a detector can be exercised without a real PAN. `737` is a three-digit CVV shape —
 * unlike the PAN it has no shape a detector could recognise, which is why the CVV half of the rule is a FIELD
 * NAME refusal rather than a value scan (see `packages/payments/src/redaction.ts`).
 */
const TEST_PAN = '4111111111111111'
const TEST_CVV = '737'

/** The card-entry document the stand-in gateway origin serves. It HAS a card input; that is the point. */
const GATEWAY_CARD_DOCUMENT = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Card details</title></head>
<body>
<form>
<label for="gateway-pan">Card number
<input type="text" id="gateway-pan" name="cardNumber" autocomplete="cc-number" inputmode="numeric"></label>
<label for="gateway-csc">Security code
<input type="text" id="gateway-csc" name="cvv" autocomplete="cc-csc" inputmode="numeric"></label>
</form>
</body></html>
`

let sql: Sql
let server: WebServer
let gatewayOrigin: Server
let browser: Browser
let BASE = ''
let FRAME_ORIGIN = ''
let restoreAdminFetch: (() => void) | undefined
let restoreAdminBrowser: (() => void) | undefined
let principal: Awaited<ReturnType<typeof createFixturePrincipal>> | undefined

/** Starts the stand-in gateway origin on a kernel-assigned port and returns its origin. */
async function startGatewayOrigin(): Promise<{ server: Server; origin: string }> {
  const instance = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(GATEWAY_CARD_DOCUMENT)
  })
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address() as AddressInfo
  return { server: instance, origin: `http://127.0.0.1:${String(address.port)}` }
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })

  // The checkout is behind `guardAdminRoute`, so the suite mints a session and presents the cookie (brief:
  // a query parameter may never choose a principal, and a repository-wide scan refuses one).
  principal = await createFixturePrincipal(sql, { role: 'owner', enrolTotp: true })

  const gateway = await startGatewayOrigin()
  gatewayOrigin = gateway.server
  FRAME_ORIGIN = gateway.origin

  // Started AFTER the stand-in origin, because the application is told its origin through the environment and
  // the port is not known until the kernel has assigned one.
  server = await startWebServer({
    suite: 'checkout',
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN: FRAME_ORIGIN,
      PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN: FRAME_ORIGIN,
    },
  })
  BASE = server.origin

  const token = principal.sessionToken
  if (token === null) throw new Error('The fixture principal has no session token to present.')
  restoreAdminFetch = installAdminCookie({
    origin: BASE,
    cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
  })
  restoreAdminBrowser = installAdminBrowserCookie(chromium, {
    origin: BASE,
    name: ADMIN_SESSION_COOKIE,
    token,
  })
  browser = await chromium.launch()
}, 180_000)

afterAll(async () => {
  restoreAdminBrowser?.()
  restoreAdminFetch?.()
  await browser?.close()
  await server?.stop()
  await new Promise<void>((resolve) => {
    if (gatewayOrigin === undefined) return resolve()
    gatewayOrigin.close(() => resolve())
  })
  // The principal's rows are this suite's own and are removed. The `payment_intent` rows are NOT: ZY161 pins
  // them and nothing here may delete them (brief rule 9).
  await principal?.cleanup()
  await sql?.end()
})

const postToken = async (body: unknown): Promise<Response> =>
  await fetch(`${BASE}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const goodBody = (name: string) => ({
  [CHECKOUT_FIELDS.instrumentToken]: `tok_${RUN}_${name}`,
  [CHECKOUT_FIELDS.amountFils]: 20_000,
  [CHECKOUT_FIELDS.reference]: `${RUN}/INV-${name}`,
  [CHECKOUT_FIELDS.idempotencyKey]: `${RUN}-${name}`,
})

const intentCount = async (): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from payment_intent where idempotency_key like ${`${RUN}%`}
  `
  return Number(row?.n ?? 0)
}

describe('the card field is inside a cross-origin iframe', () => {
  let page: Page

  beforeAll(async () => {
    page = await (await browser.newContext()).newPage()
    await page.goto(`${BASE}${CHECKOUT_PATH}`, { waitUntil: 'load' })
  })

  it('renders exactly one frame, served from the gateway origin and not ours', async () => {
    const frames = await page.locator('iframe').all()
    expect(frames).toHaveLength(1)
    const src = await frames[0]?.getAttribute('src')
    expect(src).toBe(`${FRAME_ORIGIN}/`)
    expect(new URL(src as string).origin).not.toBe(new URL(BASE).origin)
  })

  it('cannot read the frame’s document, which is what cross-origin MEANS', async () => {
    // The assertion the whole unit rests on, and the only form in which it is a fact: the same-origin policy,
    // enforced by a real browser, on a real frame. A substring assertion over the served HTML cannot make it.
    const reachable = await page.evaluate(() => {
      const frame = document.querySelector('iframe') as HTMLIFrameElement | null
      if (frame === null) return 'no-frame'
      try {
        return frame.contentDocument === null ? 'opaque' : 'readable'
      } catch {
        return 'threw'
      }
    })
    expect(reachable === 'opaque' || reachable === 'threw', `frame was ${reachable}`).toBe(true)
  })

  it('the control: the frame really does contain a card input, so the opacity is about the origin', async () => {
    // Without this, "the page cannot read the card field" is satisfied by a frame with no card field in it.
    // Read through Playwright's own frame access, which is not bound by the page's same-origin policy.
    const frame = page.frames().find((candidate) => candidate.url().startsWith(FRAME_ORIGIN))
    expect(frame, 'the gateway frame did not load').toBeDefined()
    if (frame === undefined) return
    expect(await frame.locator('input[autocomplete="cc-number"]').count()).toBe(1)
    expect(await frame.locator('input[autocomplete="cc-csc"]').count()).toBe(1)
  })

  it('has no same-origin input for a card number, a security code or an expiry', async () => {
    // The page's OWN document only. `page.locator` would descend into frames, and the gateway's frame is
    // supposed to have those inputs — a scan that saw them would report the gateway's document as ours.
    const sameOrigin = await page.evaluate(() =>
      [...document.querySelectorAll('input')]
        .map((input) => input.getAttribute('autocomplete') ?? '')
        .filter((value) => value.startsWith('cc-')),
    )
    expect(sameOrigin, 'the checkout renders a card field of its own').toEqual([])
    // The control: the page DOES have inputs, so the filter ran over something.
    expect(await page.locator('input').count()).toBeGreaterThanOrEqual(4)
  })

  it('loads no script of its own', async () => {
    expect(await page.locator('script').count()).toBe(0)
  })
})

describe('no declared route renders a card field', () => {
  it('scans every declared admin route in a browser and finds none', async () => {
    // The acceptance line says *"on any declared route"*. The route registry is what declares them, and the
    // ones worth opening are the admin documents: a public page has no card field to render and a handler
    // under `/api` has no document. This walks the checkout and the till — the two money screens — plus the
    // diary, because a card field added to a shared component would appear on every admin document at once.
    const page = await (await browser.newContext()).newPage()
    try {
      for (const path of [CHECKOUT_PATH, '/till', '/calendar', '/packages']) {
        const response = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' })
        expect(response?.status(), path).toBeLessThan(400)
        const offenders = await page.evaluate(() =>
          [...document.querySelectorAll('input, select, textarea')]
            .map(
              (field) =>
                `${field.getAttribute('autocomplete') ?? ''}|${field.getAttribute('name') ?? ''}`,
            )
            .filter((value) =>
              /(^|\|)cc-|(^|\|)(pan|cvv|cvc|csc|cardnumber|securitycode)$/i.test(value),
            ),
        )
        expect(offenders, `${path} renders a card field`).toEqual([])
      }
    } finally {
      await page.close()
    }
  }, 60_000)
})

describe('the content-security policy on the served response', () => {
  it('names the gateway origin and permits no other', async () => {
    const response = await fetch(`${BASE}${CHECKOUT_PATH}`)
    expect(response.status).toBe(200)
    const policy = response.headers.get('content-security-policy')
    expect(policy).not.toBeNull()
    expect(policy).toContain(`frame-src ${FRAME_ORIGIN}`)
    expect(policy).toContain(`script-src ${FRAME_ORIGIN}`)
    // Exactly one origin here, because this deployment's frame and script origins are the same stand-in.
    expect(permittedOrigins(policy as string)).toEqual([FRAME_ORIGIN])
  })

  it('is not cached and not indexed', async () => {
    const response = await fetch(`${BASE}${CHECKOUT_PATH}`)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
  })
})

describe('a card number is refused at the schema boundary and creates no intent', () => {
  it('answers 400 with card_data_refused and writes no intent', async () => {
    const before = await intentCount()
    const response = await postToken({
      ...goodBody('pan'),
      [CHECKOUT_FIELDS.reference]: `${RUN}/INV-pan ${TEST_PAN}`,
    })
    expect(response.status).toBe(400)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['error']).toBe('card_data_refused')
    expect(body['created']).toBe(false)
    expect(body['paths']).toEqual(['reference'])
    // A DELTA of zero. The acceptance line is "creates no intent".
    expect(await intentCount()).toBe(before)
  })

  it('answers 400 for a field named after card data, whatever its value', async () => {
    const before = await intentCount()
    const response = await postToken({ ...goodBody('cvv'), cvv: TEST_CVV })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('card_data_refused')
    expect(await intentCount()).toBe(before)
  })

  it('the control: the same body without the card data authorises', async () => {
    // Without this, both 400s above are satisfied by an endpoint that refuses everything.
    const before = await intentCount()
    const response = await postToken(goodBody('clean'))
    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    expect(body['created']).toBe(true)
    expect(body['outcome']).toBe('created')
    expect(body['state']).toBe('authorised')
    expect(await intentCount()).toBe(before + 1)
    // The token reached the gateway. A checkout that stopped forwarding it would authorise against nothing
    // and look identical from every other angle.
    expect(body['paymentIntentId']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('an unauthenticated request reaches neither the boundary nor the gateway', async () => {
    // The deferral Y-PAY-02 handed this unit. `guardAdminRoute` is the first statement, so the refusal comes
    // before any body is read — which is also why the response is the admin 303 rather than a JSON 400.
    const before = await intentCount()
    const response = await fetch(`${BASE}${TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${ADMIN_SESSION_COOKIE}=not-a-session`,
      },
      body: JSON.stringify(goodBody('unauthenticated')),
      redirect: 'manual',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('/login')
    expect(await intentCount()).toBe(before)
  })
})

describe('the PAN appears in zero sinks', () => {
  /**
   * Everything the run wrote, as one searchable string.
   *
   * Scoped to rows this run could have produced: `audit_event` and `outbox_event` are append-only and shared,
   * so a total would sweep every other suite's rows and a match would name the wrong file. The window is the
   * suite's own start instant, which is what makes this a DELTA over a table nothing can empty.
   */
  const sinkText = async (since: string): Promise<string> => {
    const audit = await sql<{ payload: string }[]>`
      select coalesce(before_state::text, '') || coalesce(after_state::text, '') || action ||
             coalesce(entity_id, '') as payload
        from audit_event where occurred_at >= ${since}::timestamptz
    `
    const outbox = await sql<{ payload: string }[]>`
      select payload::text || event_type || aggregate_id || idempotency_key as payload
        from outbox_event where occurred_at >= ${since}::timestamptz
    `
    const messages = await sql<{ payload: string }[]>`
      select body || coalesce(subject, '') || coalesce(body_html, '') || recipient as payload
        from message where created_at >= ${since}::timestamptz
    `
    const intents = await sql<{ payload: string }[]>`
      select idempotency_key || reference || coalesce(gateway_intent_id, '') as payload
        from payment_intent where idempotency_key like ${`${RUN}%`}
    `
    return [...audit, ...outbox, ...messages, ...intents].map((row) => row.payload).join('\n')
  }

  it('drives a PAN and a CVV through the checkout and finds neither in any sink', async () => {
    const since = new Date(Date.now() - 1000).toISOString()

    // The refusal path, which is the one that WRITES: `authoriseCheckout` audits a refused submission, so this
    // is where a leak would come from rather than the happy path.
    await postToken({
      ...goodBody('sweep'),
      [CHECKOUT_FIELDS.reference]: `${RUN}/INV-sweep ${TEST_PAN}`,
      cvv: TEST_CVV,
    })
    // And the accepted path, so the sweep covers a real authorisation's audit row, its outbox events and the
    // intent's own columns.
    await postToken(goodBody('sweep-ok'))

    const text = await sinkText(since)
    // Non-vacuity: the sweep read SOMETHING. A query that returned nothing would satisfy every assertion
    // below, which is exactly the failure ADR 0002 is about.
    expect(text.length, 'the sink sweep read nothing').toBeGreaterThan(200)
    expect(text).toContain(RUN)

    expect(text.includes(TEST_PAN), 'a sink holds the PAN').toBe(false)
    expect(text.includes(TEST_CVV), 'a sink holds the CVV').toBe(false)
    // The token is not cardholder data and is still a bearer credential for one charge. It is redacted, so it
    // must not be in a sink either.
    expect(text.includes(`tok_${RUN}_sweep-ok`), 'a sink holds the instrument token').toBe(false)

    // The refusal WAS audited, which is what makes the three assertions above about redaction rather than
    // about a path that wrote nothing at all.
    const [audited] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
       where action = 'payment.checkout_refused' and occurred_at >= ${since}::timestamptz
    `
    expect(Number(audited?.n ?? 0)).toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('the control: the sweep can find a planted PAN in the text it searches', () => {
    // Every assertion above is "the text does not contain the PAN". Without this they are all satisfied by a
    // search that can never match.
    expect(`prefix ${TEST_PAN} suffix`.includes(TEST_PAN)).toBe(true)
  })

  it('the refusal the caller receives repeats no value either', async () => {
    const response = await postToken({
      ...goodBody('echo'),
      [CHECKOUT_FIELDS.reference]: `${RUN} ${TEST_PAN}`,
      cvv: TEST_CVV,
    })
    const text = await response.text()
    expect(text).not.toContain(TEST_PAN)
    expect(text).not.toContain(TEST_CVV)
    // The control: it DOES name the field, so the assertions above are about the values.
    expect(text).toContain('reference')
  })

  it('redacts rather than refuses on the sink path, which is a different rule', async () => {
    // The two halves of the module, shown to be different: a REQUEST carrying card data is refused, and a
    // SINK receiving it is redacted. A logger that threw would lose the record of the very refusal that
    // matters most, so the markers exist and are asserted to be the ones a scan can look for.
    expect(CARD_DATA_REDACTED).not.toBe(SECRET_FIELD_REDACTED)
    const [row] = await sql<{ payload: string }[]>`
      select after_state::text as payload from audit_event
       where action = 'payment.checkout_refused' order by occurred_at desc limit 1
    `
    expect(row?.payload ?? '').toContain('card_data_refused')
  })
})

describe('the screen takes a payment and a reload does not take a second', () => {
  it('authorises from the form and replays on a repeat of the same key', async () => {
    // Y-PAY-02's acceptance property, on this screen: `idempotencyKey` is minted when the page is READ, so
    // re-posting the form replays the key and the gateway is not called again. That is why this POST answers
    // 200 with the document rather than a 303.
    const before = await intentCount()
    const body = new URLSearchParams({
      [CHECKOUT_FIELDS.instrumentToken]: `tok_${RUN}_form`,
      [CHECKOUT_FIELDS.amountFils]: '41000',
      [CHECKOUT_FIELDS.reference]: `${RUN}/INV-form`,
      [CHECKOUT_FIELDS.idempotencyKey]: `${RUN}-form`,
    })
    const first = await fetch(`${BASE}${CHECKOUT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    expect(first.status).toBe(200)
    const firstText = await first.text()
    expect(firstText).toContain('Authorisation requested')
    expect(await intentCount()).toBe(before + 1)

    const second = await fetch(`${BASE}${CHECKOUT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    expect(second.status).toBe(200)
    expect(await second.text()).toContain('Already recorded')
    // The DELTA is still one. A second intent would mean the key did not deduplicate.
    expect(await intentCount()).toBe(before + 1)
  }, 60_000)

  it('renders the refusal on the page for an amount that is not integer fils', async () => {
    const before = await intentCount()
    const response = await fetch(`${BASE}${CHECKOUT_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        [CHECKOUT_FIELDS.instrumentToken]: `tok_${RUN}_frac`,
        [CHECKOUT_FIELDS.amountFils]: '200.5',
        [CHECKOUT_FIELDS.reference]: `${RUN}/INV-frac`,
        [CHECKOUT_FIELDS.idempotencyKey]: `${RUN}-frac`,
      }).toString(),
    })
    // 200 with the refusal on the document, not a 4xx: the caller here is a person reading a page, and a 400
    // with a body in it is a page a proxy may replace. The 400 belongs on the JSON twin, which is asserted
    // above.
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('whole number of fils')
    expect(await intentCount()).toBe(before)
  })
})
