/**
 * The committed fixture page for the collector (A-FIRST-06), rendered once and served in two locales.
 *
 * ## Why a route in the application and not an HTML file in a test directory
 *
 * The acceptance line asks for *"Playwright on /book and a committed fixture page"*, and the two have
 * different jobs. `/book` proves the collector works where the product actually uses it, and it declares
 * exactly one interaction — the desk telephone — because that is the only element on it the taxonomy has an
 * event for. This page declares one element for **every** event that can be declared by attribute, which
 * is what makes *"each declared interaction produces exactly one event with a taxonomy-valid name"* a
 * statement about the whole vocabulary rather than about the one call to action that exists today.
 *
 * It has to be a real route because the thing under test is the BUNDLED collector: a static HTML file
 * served by the suite would exercise a copy compiled by the test runner, with a different module graph,
 * different dead-code elimination and no `page_client-reference-manifest.js` for `pnpm budgets` to weigh.
 * `build/budgets.json`'s `collector-client-js` entry measures exactly this route's client JavaScript beyond
 * the shared layout, which is the acceptance line's 3KB — and it is the right measurement because this page
 * ships nothing else: no picker, no dialog, no motion island.
 *
 * ## Why every attribute is written out as a literal
 *
 * It is tempting to compose them — `{[TRACK_EVENT_ATTRIBUTE]: 'cta_click', [trackPayloadAttribute('target')]: 'whatsapp'}`
 * spread onto the element — and that is exactly the shape this design refuses. An attribute name or value
 * behind an expression is invisible to `scripts/check-event-attributes.mjs`, which is a text scan because
 * the claim is about what the markup SAYS; a composed declaration would silently stop being checked, on the
 * page with more declarations than any other. The derivation still has one statement —
 * `trackPayloadAttribute` in `@berelax/ui/analytics`, which the runtime reader uses — and the checker is
 * what holds these literals equal to it: an attribute no derivation produces is rejected by name. ADR 0078.
 *
 * ## Why every VALUE comes from a declared vocabulary
 *
 * `asian`, `normal_massage`, `arabic` and `hot_oil_balm_massage` are members of `TREATMENT_STYLES` and
 * `TREATMENT_KEYS`; the three call-to-action targets are `CTA_TARGETS`; the ref code satisfies
 * `WHATSAPP_REF_CODE_PATTERN`. The checker parses each value through its field's own Zod schema, so a value
 * the catalogue does not have fails the build here first.
 *
 * ## Why `whatsapp_ref_shown` is NOT declared here
 *
 * It was, on a button, and the browser suite refused it with the server's own envelope: every payload
 * schema is a `strictObject`, `whatsappRefShownPayloadSchema` has `refCode` and nothing else, and the
 * collector adds `path` to every declared interaction — so the event arrived with an unknown extra
 * property and `/api/collect` refuses the whole thing as `invalid_event_payload`. A tag that renders,
 * works, and produces a 400 nobody is watching.
 *
 * It is not an interaction either: A-FIRST-07 raises it when a ref code is RENDERED, through
 * `trackCollectorEvent`, which is the door for the events that are not page-located. The constraint is now
 * a build-time rule — `event-attribute-declares-an-event-with-no-page-field` — so the mistake cannot be
 * made again on any surface, and the `refCode` attribute derivation is exercised by
 * `attributes.test.ts` and by the checker's own control instead of by markup.
 */
import CollectorIsland from '@berelax/ui/analytics/collector-island'
import { DesignSystemStyles, Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import type { ReactElement } from 'react'
import { type Locale, localisedPath } from '../../src/i18n/locales.ts'
import { routeById } from '../../src/routes/registry.ts'
import { RouteNav } from '../_routes/route-nav.tsx'

export interface CollectorFixtureCopy {
  readonly eyebrow: string
  readonly heading: string
  readonly lede: string
  readonly interactionsHeading: string
  /** The accessible name of each declared control. */
  readonly whatsapp: string
  readonly call: string
  readonly book: string
  readonly service: string
  readonly price: string
  readonly twiceHeading: string
  readonly twice: string
  readonly twiceLabel: string
  readonly undeclared: string
}

/**
 * This route's id, which is also where its PATH comes from.
 *
 * The island needs the path stated by the server, and it is read out of the registry rather than written
 * here — `routeById` is already on this page through `RouteNav`, and `routeMetadata` in the two page files
 * reads the same table, so the lookup costs nothing and there is no second spelling of `/collector` to keep
 * in step. A literal would have needed a test holding the two equal; a derivation needs none.
 */
const ROUTE_ID = 'collector'

/** The `data-testid` the browser suite finds each control by. Written once, read by both sides. */
export const FIXTURE_TEST_IDS = {
  whatsapp: 'collector-cta-whatsapp',
  call: 'collector-cta-call',
  book: 'collector-cta-book',
  service: 'collector-service-viewed',
  price: 'collector-price-viewed',
  twice: 'collector-twice',
  undeclared: 'collector-undeclared',
} as const

export function CollectorFixture({
  copy,
  locale,
}: {
  readonly copy: CollectorFixtureCopy
  readonly locale: Locale
}): ReactElement {
  return (
    <>
      <DesignSystemStyles />
      <Section>
        <Grid>
          <GridCell span="wide">
            <Measure cap="lede" as="div">
              <p>{copy.eyebrow}</p>
              <h1>{copy.heading}</h1>
              <p>{copy.lede}</p>
            </Measure>
          </GridCell>
        </Grid>
      </Section>

      <Section as="div">
        <Grid>
          <GridCell span="wide">
            <h2>{copy.interactionsHeading}</h2>
            <p className="be-actions">
              <button
                className="be-action"
                type="button"
                data-testid={FIXTURE_TEST_IDS.whatsapp}
                data-berelax-event="cta_click"
                data-berelax-target="whatsapp"
              >
                {copy.whatsapp}
              </button>
              <button
                className="be-action"
                type="button"
                data-testid={FIXTURE_TEST_IDS.call}
                data-berelax-event="cta_click"
                data-berelax-target="call"
              >
                {copy.call}
              </button>
              <button
                className="be-action"
                type="button"
                data-testid={FIXTURE_TEST_IDS.book}
                data-berelax-event="cta_click"
                data-berelax-target="book"
              >
                {copy.book}
              </button>
              <button
                className="be-action"
                type="button"
                data-testid={FIXTURE_TEST_IDS.service}
                data-berelax-event="service_viewed"
                data-berelax-style="asian"
                data-berelax-treatment="normal_massage"
              >
                {copy.service}
              </button>
              <button
                className="be-action"
                type="button"
                data-testid={FIXTURE_TEST_IDS.price}
                data-berelax-event="price_viewed"
                data-berelax-style="arabic"
                data-berelax-treatment="hot_oil_balm_massage"
              >
                {copy.price}
              </button>
            </p>
          </GridCell>
        </Grid>
      </Section>

      <Section as="div">
        <Grid>
          <GridCell span="wide">
            <h2>{copy.twiceHeading}</h2>
            <Measure cap="body">{copy.twice}</Measure>
            <p className="be-actions">
              {/*
                The double-click target, and the control beside it.

                `collector-twice` is clicked twice inside the window and must produce one event;
                `collector-undeclared` carries no attribute at all and must produce none — which is the
                assertion that stops the first one passing against a listener that tracks every click on
                the page. It declares `cta_click`/`book` like the third button above, deliberately: the
                dedupe window is a window on ONE control, so two elements carrying the same payload must
                still be two interactions.
              */}
              <button
                className="be-action"
                type="button"
                data-testid={FIXTURE_TEST_IDS.twice}
                data-berelax-event="cta_click"
                data-berelax-target="book"
              >
                {copy.twiceLabel}
              </button>
              <button className="be-action" type="button" data-testid={FIXTURE_TEST_IDS.undeclared}>
                {copy.undeclared}
              </button>
            </p>
          </GridCell>
        </Grid>
      </Section>

      <RouteNav id={ROUTE_ID} locale={locale} />
      <CollectorIsland path={localisedPath(routeById(ROUTE_ID).path, locale)} />
    </>
  )
}
