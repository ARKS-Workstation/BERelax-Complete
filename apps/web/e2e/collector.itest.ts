import { DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { COLLECT_PATH, collectBatchSchema } from '@berelax/shared'
import { INTERACTION_DEDUPE_MS } from '@berelax/ui/analytics'
import { type Browser, type BrowserContext, chromium, type Page, type Request } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_TEST_IDS } from '../app/_analytics/collector-fixture.tsx'

/**
 * A-FIRST-06 — the collector in a real browser, against the BUILT application.
 *
 * Every claim here needs a browser, and `packages/ui/src/analytics/collector.test.ts` has already taken
 * everything that does not: the 300 ms arithmetic, the batch split, the offline queue and the stability of
 * a client event id across a retry are decisions over instants and are driven there with a counter for a
 * clock. What is left is the half that cannot be faked without faking the thing under test:
 *
 *   - **One event per declared interaction.** A count of `sendBeacon` calls produced by a real `click` on
 *     a real element whose attributes were rendered by the server and read by the bundled collector. The
 *     module graph here is the one `next build` produced, which is also what `pnpm budgets` weighs.
 *   - **A double click is one event.** Two real `click` events a few milliseconds apart, which is what a
 *     browser emits for a `dblclick` — the thing the window exists for.
 *   - **The offline flush.** `context.setOffline(true)` is the only way to make `navigator.onLine` false
 *     and `sendBeacon` lie about delivery at the same time, which is the pair the queue exists for.
 *   - **No origin but our own.** Request interception over everything the document fetched. This is a
 *     property of the BUNDLE rather than of the import graph: `pnpm egress`'s rule 6 says no module names
 *     an analytics destination, and this says nothing the page actually loads reaches one.
 *   - **Nothing before `load`.** Timed in the page, against the page's own `loadEventStart`.
 *
 * ## Why the suite serves `/collector` as well as `/book`
 *
 * `/book` is the product and declares exactly one interaction, because the desk telephone is the only
 * element on it the taxonomy has an event for. `/collector` declares one element per declarable event, so
 * "a taxonomy-valid name" is a claim about the whole vocabulary rather than about one call to action.
 *
 * ## Why `/api/collect` is fulfilled rather than left to the real route
 *
 * The subject is what the BROWSER posts. The route's own behaviour — the consent gate, the four caps, the
 * rate limiter, the `Set-Cookie` — is `apps/web/app/api/collect/collect.itest.ts`'s and is proved against
 * a real PostgreSQL there. Fulfilling here keeps this file from depending on a consent cookie it would
 * have to mint, keeps the assertions on the bytes, and writes no row — so a counter another suite reads is
 * not moved by this one.
 *
 * ## Why nothing in this file sleeps for a fixed interval
 *
 * A beacon is asynchronous and the island's first flush rides the `load` event, so every count here is a
 * count of something that has not necessarily happened yet. The first version took a snapshot immediately
 * after `goto` and asserted on it; the entry page view arrived in the middle of the clicks, and FIVE cases
 * failed in ways that each pointed at the collector rather than at the suite. So every count is taken
 * through {@link Instrumented.settle}, which polls for the number of batches the case is waiting for and
 * fails by saying how many arrived — and `hide()` returns only once the flush it asked for has landed.
 */

const DATABASE = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!DATABASE)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const FIXTURE_ROUTE = '/collector'
const BOOK_ROUTE = '/book'

/**
 * The `/book` URL that renders the desk telephone, which is the route's one declared interaction.
 *
 * `/book` bare renders the `needs-treatment` named state and no call to action at all — the first version
 * of this suite asserted on the anchor there and found none, which is a fact about the page rather than
 * about the collector. The telephone belongs to the edge states, and the cheapest reachable one is
 * `no-trading-days`: a `?date=` the trading calendar does not reach leaves `selectedDate` null, which is
 * docs/09 §3's own enumerated state. The year is deliberately far out so no seeding window can ever reach
 * it.
 *
 * The query is also what makes the page view's path worth asserting: the island is given the ROUTE's path
 * by the server, so the event carries `/book` and not `/book?date=…` — `pathSchema` forbids a query string
 * because origination is resolved once per session, and a query on every page view would be a second copy
 * of `gclid` with a shorter retention and no reader.
 */
const BOOK_EDGE_STATE = '/book?date=2099-01-01'

/** How long a flush may take to land before the absence of it is a failure rather than a wait. */
const FLUSH_WITHIN_MS = 5_000

let server: WebServer
let browser: Browser
let BASE = ''

/** One posted batch, parsed through the server's own envelope. */
interface Posted {
  readonly batch: ReturnType<typeof collectBatchSchema.parse>
}

/** A page with everything it asked the network for, and everything it posted to `/api/collect`. */
interface Instrumented {
  readonly page: Page
  readonly context: BrowserContext
  readonly posted: Posted[]
  /** Every request URL the document made, in order. The origin assertion reads this. */
  readonly requested: string[]
  /** Requests interception REFUSED for naming another origin. Empty is the only acceptable answer. */
  readonly foreign: string[]
  /** Waits until at least `batches` have been posted, and fails saying how many arrived. */
  readonly settle: (batches: number) => Promise<void>
  /** Dispatches a real `visibilitychange` to `hidden` and waits for the flush it asks for. */
  readonly hide: (expectedBatches?: number) => Promise<void>
  /** `performance.now()` for each `sendBeacon` the page made, measured in the page. */
  readonly beaconTimes: () => Promise<readonly number[]>
  readonly close: () => Promise<void>
}

/**
 * Opens one page with request interception installed BEFORE it navigates, and waits for its page view.
 *
 * On the context rather than the page, because the island's first flush happens at the `load` event and a
 * route registered after `goto` would miss it.
 */
async function instrument(path: string): Promise<Instrumented> {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 } })
  // esbuild's `keepNames` rewrites every named function as `__name(fn, 'fn')`, and Playwright serialises
  // the COMPILED source of a callback into a page where that helper does not exist. Every browser suite in
  // this repository installs this for the same reason.
  await context.addInitScript({
    content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
  })
  /*
   * `navigator.sendBeacon`, wrapped to record WHEN each call happened on the page's own clock.
   *
   * The deferral to `load` cannot be read off the network: Resource Timing has no entry for a request
   * Playwright fulfils, and the interception's own timestamps are this process's clock rather than the
   * document's. A wrapper that records `performance.now()` and delegates changes no behaviour and puts the
   * measurement in the same time base as `loadEventStart`, which is the only base the comparison is
   * meaningful in.
   */
  await context.addInitScript({
    content: [
      'globalThis.__berelaxBeacons = [];',
      'const original = navigator.sendBeacon?.bind(navigator);',
      'if (original !== undefined) {',
      '  navigator.sendBeacon = (url, data) => {',
      '    globalThis.__berelaxBeacons.push(performance.now());',
      '    return original(url, data);',
      '  };',
      '}',
    ].join('\n'),
  })

  const posted: Posted[] = []
  const requested: string[] = []
  const foreign: string[] = []

  const read = (request: Request): void => {
    const url = request.url()
    requested.push(url)
    if (!url.startsWith(`${BASE}${COLLECT_PATH}`)) return
    const body = request.postData()
    expect(body, 'a collect request with no body').not.toBeNull()
    // Through the SERVER's envelope, so a batch this suite reports on is a batch `/api/collect` would
    // read. An assertion over `JSON.parse` alone would pass on a body the route refuses as
    // `invalid_envelope`, which is the one failure that loses every event in it.
    posted.push({ batch: collectBatchSchema.parse(JSON.parse(body ?? '{}')) })
  }

  await context.route('**/*', async (route) => {
    const request = route.request()
    read(request)
    if (!request.url().startsWith(BASE)) {
      // Refused rather than allowed through, so a collector that reached a third party would fail here
      // instead of quietly succeeding on a machine with a network.
      foreign.push(request.url())
      await route.abort('blockedbyclient')
      return
    }
    if (request.url().startsWith(`${BASE}${COLLECT_PATH}`)) {
      await route.fulfill({ status: 204, body: '' })
      return
    }
    await route.continue()
  })

  const page = await context.newPage()
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' })

  const settle = async (batches: number): Promise<void> => {
    const deadline = Date.now() + FLUSH_WITHIN_MS
    while (posted.length < batches && Date.now() < deadline) await page.waitForTimeout(50)
    expect(
      posted.length,
      `waited ${FLUSH_WITHIN_MS}ms for ${batches} batch(es) on ${path}`,
    ).toBeGreaterThanOrEqual(batches)
  }

  const rig: Instrumented = {
    page,
    context,
    posted,
    requested,
    foreign,
    settle,
    hide: async (expectedBatches?: number) => {
      await page.evaluate(() => {
        // `visibilityState` is read-only, so the property is redefined for the duration of the dispatch.
        // The collector reads it rather than trusting the event, because a `visibilitychange` to VISIBLE is
        // a tab coming back and is not a flush.
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        })
        document.dispatchEvent(new Event('visibilitychange'))
      })
      if (expectedBatches === undefined) {
        // Nothing to wait FOR — the case is asserting that nothing arrives — so one turn of the event loop
        // plus a short settle is all there is. Short on purpose: a long sleep here would make a suite that
        // waits for an absence the slowest file in the run.
        await page.waitForTimeout(300)
        return
      }
      await settle(expectedBatches)
    },
    beaconTimes: async () =>
      await page.evaluate(
        () => (globalThis as unknown as { __berelaxBeacons: number[] }).__berelaxBeacons,
      ),
    close: async () => {
      await context.close()
    },
  }

  // Every page the island is on queues its own page view at mount and flushes it at `load`, so a rig is
  // not ready to be counted against until that batch has landed. Doing it here rather than in five cases
  // is what makes "a click posted no batch of its own" a statement about clicks.
  await settle(1)
  return rig
}

/** Every event across every batch a page posted, in the order it was sent. */
const eventsOf = (rig: Instrumented) => rig.posted.flatMap((entry) => entry.batch.events)

beforeAll(async () => {
  server = await startWebServer({
    suite: 'collector',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: FIXTURE_ROUTE,
    readyWithinMs: 90_000,
    env: {
      // Both, declared rather than assumed: `/book` calls `loadConfig()`, and a local run that exported
      // only TEST_DATABASE_URL gets a 503 that reads like a broken route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: DATABASE,
    },
  })
  BASE = server.origin
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 240_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
})

describe('acceptance — each declared interaction produces exactly one event with a valid name', () => {
  it('posts one event per declared control on the fixture page, and none for the undeclared one', async () => {
    const rig = await instrument(FIXTURE_ROUTE)
    try {
      const clicked = [
        FIXTURE_TEST_IDS.whatsapp,
        FIXTURE_TEST_IDS.call,
        FIXTURE_TEST_IDS.book,
        FIXTURE_TEST_IDS.service,
        FIXTURE_TEST_IDS.price,
        // The control, and it is the assertion that stops every one above passing against a listener that
        // tracks every click on the page.
        FIXTURE_TEST_IDS.undeclared,
      ]
      const beforeClicks = rig.posted.length
      for (const testId of clicked) await rig.page.getByTestId(testId).click()
      // Nothing is posted on a click: the queue waits for a flush, which is what makes one visit one
      // request rather than one request per tap.
      expect(rig.posted.length, 'a click posted a batch of its own').toBe(beforeClicks)

      await rig.hide(beforeClicks + 1)
      const events = eventsOf(rig)
      // The page view the island queues at mount, then the six declared interactions, in click order.
      expect(events.map((event) => event.name)).toEqual([
        'page_view',
        'cta_click',
        'cta_click',
        'cta_click',
        'service_viewed',
        'price_viewed',
      ])
      expect(events[0]?.payload).toEqual({ path: FIXTURE_ROUTE, entry: true })
      expect(events[1]?.payload).toEqual({ target: 'whatsapp', path: FIXTURE_ROUTE })
      expect(events[2]?.payload).toEqual({ target: 'call', path: FIXTURE_ROUTE })
      expect(events[3]?.payload).toEqual({ target: 'book', path: FIXTURE_ROUTE })
      expect(events[4]?.payload).toEqual({
        style: 'asian',
        treatment: 'normal_massage',
        path: FIXTURE_ROUTE,
      })
      expect(events[5]?.payload).toEqual({
        style: 'arabic',
        treatment: 'hot_oil_balm_massage',
        path: FIXTURE_ROUTE,
      })
      /*
       * `whatsapp_ref_shown` is NOT in that list, and its absence is an assertion.
       *
       * It was declared on a sixth button until this case refused it: the collector adds `path` to every
       * declared interaction, `whatsappRefShownPayloadSchema` is a `strictObject` holding `refCode` alone,
       * and `collectBatchSchema.parse` above is the server's own envelope — so the batch came back with a
       * payload `/api/collect` refuses as `invalid_event_payload`. The constraint is now a build-time rule
       * (`event-attribute-declares-an-event-with-no-page-field`), and the event belongs to the imperative
       * door, where A-FIRST-07 will raise it.
       */
      expect(events.map((event) => event.name)).not.toContain('whatsapp_ref_shown')

      // Exactly one event each: every client event id is distinct, which is what `/api/collect`'s unique
      // index holds and what makes a retry safe.
      const ids = events.map((event) => event.clientEventId)
      expect(new Set(ids).size).toBe(ids.length)
      // And the interaction count the envelope carries is the five declared clicks, not the six events
      // and not the seven controls that were clicked.
      expect(rig.posted.at(-1)?.batch.interactionCount).toBe(5)
    } finally {
      await rig.close()
    }
  }, 60_000)

  it('takes one event for a double click on one control', async () => {
    const rig = await instrument(FIXTURE_ROUTE)
    try {
      // A real `dblclick`, which emits two `click` events a few milliseconds apart — the thing the window
      // is for. `INTERACTION_DEDUPE_MS` is imported rather than written, so this case cannot assert a
      // window the product does not have.
      expect(INTERACTION_DEDUPE_MS).toBeGreaterThan(0)
      const before = rig.posted.length
      await rig.page.getByTestId(FIXTURE_TEST_IDS.twice).dblclick()
      await rig.hide(before + 1)

      const clicks = eventsOf(rig).filter((event) => event.name === 'cta_click')
      expect(clicks).toHaveLength(1)
      expect(clicks[0]?.payload).toEqual({ target: 'book', path: FIXTURE_ROUTE })

      // The control: the same control clicked again AFTER the window is a second interaction, so the
      // assertion above is not satisfied by a collector that tracks a control once per page.
      await rig.page.waitForTimeout(INTERACTION_DEDUPE_MS + 50)
      const settled = rig.posted.length
      await rig.page.getByTestId(FIXTURE_TEST_IDS.twice).click()
      await rig.hide(settled + 1)
      expect(eventsOf(rig).filter((event) => event.name === 'cta_click')).toHaveLength(2)
    } finally {
      await rig.close()
    }
  }, 60_000)
})

describe('acceptance — events queued while offline flush later, with no duplication', () => {
  it('posts nothing while offline and then exactly one batch of distinct ids', async () => {
    const rig = await instrument(FIXTURE_ROUTE)
    try {
      // The page view of the entry page has already been flushed at `load` — `instrument` waits for it.
      // Everything after this point is what the queue has to survive.
      const sentBeforeOutage = eventsOf(rig).length
      expect(sentBeforeOutage).toBeGreaterThan(0)
      const batchesBeforeOutage = rig.posted.length

      await rig.context.setOffline(true)
      await rig.page.getByTestId(FIXTURE_TEST_IDS.whatsapp).click()
      await rig.page.getByTestId(FIXTURE_TEST_IDS.call).click()
      await rig.page.getByTestId(FIXTURE_TEST_IDS.book).click()
      await rig.hide()
      // `navigator.sendBeacon` answers TRUE while offline — it has accepted the payload into its own queue,
      // which is not delivery — so a collector that read its answer as delivery would have cleared the
      // queue here and lost all three.
      expect(eventsOf(rig)).toHaveLength(sentBeforeOutage)

      await rig.context.setOffline(false)
      await rig.hide(batchesBeforeOutage + 1)

      const events = eventsOf(rig)
      const clicks = events.filter((event) => event.name === 'cta_click')
      expect(clicks.map((event) => event.payload)).toEqual([
        { target: 'whatsapp', path: FIXTURE_ROUTE },
        { target: 'call', path: FIXTURE_ROUTE },
        { target: 'book', path: FIXTURE_ROUTE },
      ])
      const ids = events.map((event) => event.clientEventId)
      expect(new Set(ids).size, 'an id arrived twice, so the flush duplicated an event').toBe(
        ids.length,
      )

      // And a further flush posts nothing at all: the queue was cleared by the acceptance, not by the
      // attempt. Together with the distinct ids above, that is the no-duplication claim in both
      // directions — nothing sent twice, and nothing left behind to be sent again later.
      const settled = rig.posted.length
      await rig.hide()
      expect(rig.posted.length).toBe(settled)
    } finally {
      await rig.close()
    }
  }, 90_000)
})

describe('acceptance — the collector contacts no origin other than the sites own', () => {
  it('requests nothing off-origin on the fixture route or on /book', async () => {
    for (const route of [FIXTURE_ROUTE, BOOK_ROUTE]) {
      const rig = await instrument(route)
      try {
        await rig.page
          .getByTestId(FIXTURE_TEST_IDS.whatsapp)
          .click({ timeout: 2_000 })
          .catch(() => {
            // `/book` has no fixture control. The navigation and the page view are what matter here.
          })
        await rig.hide()
        expect(rig.foreign, `${route} reached another origin`).toEqual([])
        // The control: the recorder saw a non-trivial number of requests, so "none were foreign" is a
        // statement about a page that loaded rather than about an empty list.
        expect(rig.requested.length, `${route} fetched nothing`).toBeGreaterThan(1)
        for (const url of rig.requested) {
          expect(url.startsWith(BASE), `${route} requested ${url}`).toBe(true)
        }
      } finally {
        await rig.close()
      }
    }
  }, 120_000)
})

describe('acceptance — the collector is not in the LCP critical request chain', () => {
  it('posts nothing until the load event, timed on the pages own clock', async () => {
    const rig = await instrument(FIXTURE_ROUTE)
    try {
      const loadEventStart = await rig.page.evaluate(() => {
        const navigation = performance.getEntriesByType('navigation')[0] as
          | PerformanceNavigationTiming
          | undefined
        return navigation?.loadEventStart ?? 0
      })
      const beacons = await rig.beaconTimes()

      // The load event happened — without this the comparison below is against zero and holds trivially.
      expect(loadEventStart).toBeGreaterThan(0)
      // And the page really posted something, so "none before load" is not a statement about an empty list.
      expect(beacons.length, 'the page posted nothing at all').toBeGreaterThan(0)
      for (const at of beacons) {
        expect(at, 'a collect request started before the load event').toBeGreaterThanOrEqual(
          loadEventStart,
        )
      }
    } finally {
      await rig.close()
    }
  }, 60_000)

  it('references every build chunk without blocking, in the served HTML', async () => {
    /*
     * The mechanical reason the collector is out of the critical request chain. Lighthouse's chain is the
     * render-blocking, high-priority requests the DOCUMENT discovers, so two things have to be true of the
     * served bytes and both are asserted: no `/_next/static` script is loaded synchronously, and no script
     * is preloaded at anything but low priority.
     *
     * Against the served HTML rather than against the DOM, because `document.scripts` includes everything
     * the runtime added afterwards — which is every chunk Next loads on demand, and which would make this
     * pass whatever the HTML said.
     *
     * `noModule` is accepted beside `async` and `defer`, and it is not a loophole: a `noModule` script is
     * never fetched or executed by a browser that supports modules, which is every browser this
     * application supports and every browser Lighthouse runs. Next emits exactly one, its legacy guard.
     *
     * Lighthouse CI itself does not exist in this repository: `lighthouse/budget.json` and
     * `lighthouserc.cjs` are W-SITE-11's, which is why this unit changes no Lighthouse budget. B-UI-02's
     * `src/book/budget.ts` records the same deferral for the same reason.
     */
    const html = await (await fetch(`${BASE}${FIXTURE_ROUTE}`)).text()
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1] ?? '')
    const chunks = scripts.filter((attributes) => attributes.includes('/_next/static/'))
    expect(chunks.length, 'the served HTML references no build chunk at all').toBeGreaterThan(0)
    for (const attributes of chunks) {
      expect(
        /\basync\b|\bdefer\b|\bnoModule\b/.test(attributes),
        `a blocking build-chunk script: <script ${attributes}>`,
      ).toBe(true)
    }

    const scriptPreloads = [...html.matchAll(/<link\b([^>]*as="script"[^>]*)>/g)].map(
      (match) => match[1] ?? '',
    )
    for (const attributes of scriptPreloads) {
      expect(
        /fetchPriority="low"/i.test(attributes),
        `a script preloaded above low priority: <link ${attributes}>`,
      ).toBe(true)
    }
  }, 30_000)
})

describe('acceptance — /book, which is the route the funnel is about', () => {
  it('reports the entry page view and the one interaction the route declares', async () => {
    const rig = await instrument(BOOK_EDGE_STATE)
    try {
      const entry = eventsOf(rig)[0]
      expect(entry?.name).toBe('page_view')
      // The ROUTE's path, not the URL the browser is on: the query is deliberately absent.
      expect(entry?.payload).toEqual({ path: BOOK_ROUTE, entry: true })

      // `dispatchEvent` and not `click`: the element is a `tel:` anchor and a real click asks the browser
      // to hand the page to an external protocol handler, which in a headless run is a navigation nobody
      // can observe and in a headed one is a dialog. The collector listens in the capture phase, so what
      // it sees is this event either way — which is the reason the listener is on the way DOWN.
      const anchors = rig.page.locator('a[data-berelax-event="cta_click"]')
      // Exactly one, which is also the claim that `/book` declares exactly one interaction: a second
      // declared anchor appearing on this route would make the count below ambiguous rather than wrong.
      expect(await anchors.count()).toBe(1)
      const before = rig.posted.length
      await anchors.first().dispatchEvent('click')
      await rig.hide(before + 1)

      const clicks = eventsOf(rig).filter((event) => event.name === 'cta_click')
      expect(clicks).toHaveLength(1)
      expect(clicks[0]?.payload).toEqual({ target: 'call', path: BOOK_ROUTE })
    } finally {
      await rig.close()
    }
  }, 90_000)
})
