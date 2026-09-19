/**
 * The kitchen sink: every layout primitive and every container-query component, on one route.
 *
 * ## Why this page exists
 *
 * Nothing in W-SYS-02 can be proved by reading source. A grid template is a claim about five computed
 * track widths; a measure is a claim about the ratio of an element's width to its own `ch`; a container
 * query is a claim about what happens at 340px of *container* on a 1440px viewport. All of them are
 * checked against this route by `apps/web/src/kitchen-sink.itest.ts`, driving a real `next start`.
 *
 * It is also the page you look at when a token changes, which is the other half of its job: the
 * screenshot harness's specimen shows the system as static HTML, and this shows it as the components the
 * site is actually built from.
 *
 * ## What it deliberately does not contain
 *
 * **No therapist has a name.** Nineteen photographs and zero names is the real launch state, and a
 * therapist publishes a display name only once an admin has set one and recorded a photography consent
 * (ADR 0020). `TherapistCard` takes `displayName` as optional and this page passes none, so the page
 * shows what the site looks like on day one rather than a happy path that hides the guard.
 *
 * Prices are the real menu from docs/13 §4 — gross, VAT-inclusive, integer fils underneath (ADR 0007).
 *
 * It sits in a `(dev)` group inside `(en)` because it is an English document and the locale belongs to
 * the document: there are two root layouts, `(en)` and `(ar)`, and every rule in `theme/arabic.css` is
 * inherited from `<html>`. `robots` is `noindex` because this is a development surface, not a page.
 */
import { aed, formatMoney } from '@berelax/core'
import { DesignSystemStyles, Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import { NapBlock, ServiceRow, SlotGrid, TherapistCard } from '@berelax/ui/patterns'
import type { Metadata } from 'next'
import { readPageFacts } from '../../../../src/facts/page-facts.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import {
  MotionGallery,
  type MotionGalleryCopy,
  MotionHeader,
} from '../../../_dev/motion-gallery.tsx'
import { NAP_COPY_EN } from '../../../_dev/nap-copy.ts'
import { PrimitiveGallery, type PrimitiveGalleryCopy } from '../../../_dev/primitive-gallery.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'
import { portraits } from './portraits.ts'

/**
 * Rendered per request, not prerendered, since W-SITE-02.
 *
 * The NAP block below reads the `premises` row, and a statically prerendered copy of this page would bake
 * the address into the build output — the staleness the row exists to remove. It is the one document in the
 * registry that can afford this: nobody outside the team ever requests it, so the cost of rendering it per
 * request is zero and the benefit is that the gallery shows the address the database actually holds.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Kitchen sink — the BE RELAX design system',
  description: 'Every layout primitive and container-query component on one route.',
  // `robots` and the alternate set both come from the registry entry: `indexable: false` is declared
  // once, so a development surface cannot become indexable by a page forgetting to restate it.
  ...routeMetadata('kitchen-sink', 'en'),
}

/** The Asian menu at 60 minutes, from docs/13 §4. Gross, VAT-inclusive. */
const MENU = [
  { name: 'Normal Massage', minutes: 60, price: aed(200), style: 'Asian' },
  { name: 'Hot Oil / Balm Massage', minutes: 60, price: aed(250), style: 'Asian' },
  { name: 'Morocco Bath or Jacuzzi', minutes: 60, price: aed(300), style: 'Asian' },
] as const

/**
 * Eight start times, as a layout specimen for `SlotGrid`.
 *
 * Deliberately **not** the trading hours. They used to begin at the opening time, which made this page a
 * second place the opening time was written down — the duplication `packages/db/src/seed/premises.test.ts`
 * greps for, and the reason this file was on its exemption list until W-SITE-02. What the grid needs is
 * eight plausible labels of the right shape to lay out at three, four and six columns; what time the
 * premises opens is a fact about the business and is rendered below, from the row, by `NapBlock`.
 *
 * Which start is bookable is B-AVAIL's question (`close - duration - turnaround`), and answering it here
 * would be a third copy of the hours plus a rota this page does not have.
 */
const SLOTS = [
  { label: '12:30', available: true },
  { label: '14:00', available: true, selected: true },
  { label: '15:30', available: false },
  { label: '17:00', available: true },
  { label: '18:30', available: true },
  { label: '20:00', available: true },
  { label: '21:30', available: true },
  { label: '23:00', available: true },
] as const

const UNNAMED = 'Name not yet published'

/**
 * The primitive set's copy, in English.
 *
 * Copy belongs to the route because the route is the locale; the gallery's structure belongs to
 * `_dev/primitive-gallery.tsx`, which `/ar/kitchen-sink` renders with the Arabic copy. Two routes, one
 * component, so the twelve-render axe sweep is auditing one page in two directions rather than two
 * pages.
 */
const PRIMITIVE_COPY: PrimitiveGalleryCopy = {
  buttons: {
    primary: 'Book a treatment',
    quiet: 'See the menu',
    ghost: 'Call the desk',
    withIcon: 'Choose a date',
    // The icon-only button's whole accessible name. `Button` does not compile without it.
    iconOnly: 'Search treatments',
    disabled: 'Fully booked today',
  },
  nav: { label: 'On this page', today: 'Available today', hours: 'Treatments' },
  chips: ['Asian', 'Arabic', '60 minutes'],
  panel: {
    title: 'A panel, at two pixels',
    body:
      'The corner radius is the most visible decision in docs/08 §7: a 2px corner on a warm ground ' +
      'with a hairline border reads as printed matter, and 12px reads as an application. shadcn ships ' +
      'this card at 12px and its badge fully rounded; both are replaced rather than themed.',
  },
  fields: {
    mobile: 'Mobile number',
    mobileHint: 'The booking is confirmed to this number by SMS.',
    notes: 'Anything the therapist should know',
    notesPlaceholder: 'Pressure, injuries, preferences',
    duration: 'Duration',
    durations: [
      { value: '45', label: '45 minutes' },
      { value: '60', label: '60 minutes' },
      { value: '90', label: '90 minutes' },
      { value: '120', label: '120 minutes' },
    ],
    durationDefault: '60',
  },
  popover: {
    trigger: 'What is included?',
    label: 'What is included in the price',
    body:
      'Every price is the gross amount including VAT, and the amount charged. VAT is derived from it ' +
      'rather than added to it, so the figure never changes on the invoice.',
  },
  dialog: {
    trigger: 'Cancellation policy',
    title: 'Cancelling a booking',
    description:
      'A booking can be moved or cancelled up to two hours before it starts, at the desk or by ' +
      'replying to the confirmation message.',
    close: 'Close',
  },
  sheet: {
    trigger: 'Choose a start time',
    title: 'Start times available today',
    description:
      'The session crosses midnight, so the last start is earlier than the closing time by the length ' +
      'of the booking. The hours themselves are below, read from the premises record.',
    close: 'Close',
  },
}

/**
 * The motion system's copy. W-SYS-04.
 *
 * The price is the 60-minute hot oil treatment from docs/13 §4, formatted rather than typed, because the
 * element it sits in is the one the reduced-motion cross-fade is proved against and a number that has
 * changed is the commonest thing a cross-fade communicates.
 */
const MOTION_COPY: MotionGalleryCopy = {
  brand: 'BE RELAX',
  scrolled: 'Scroll: the header condenses',
  heading: 'Motion',
  body:
    'Five durations, four easings, three movement distances and one stagger, all of them tokens. ' +
    'Movement is a distance multiplied by a direction, so nothing is authored twice for Arabic; how ' +
    'long a movement takes is a function of how far it goes; and reduced motion is one override in ' +
    'the token layer rather than a branch in each component.',
  groups: {
    small: 'Six siblings, stepping 40ms',
    large: 'Ten siblings, stepping 24ms',
    capped: 'Fourteen siblings, which animate as one group',
  },
  row: 'Row',
  crossfade:
    'Movement is zero under reduced motion and this cross-fade is not: a price that changes without ' +
    'one is a price nobody saw change.',
  price: formatMoney(aed(250)),
  reveal:
    'This paragraph arrived on a scroll-driven timeline — no JavaScript, no observer, and nothing ' +
    'above the fold at opacity zero.',
}

export default async function KitchenSinkPage() {
  // Fail-soft: `null` when the singleton has not been seeded in this database. See `readPageFacts`.
  const source = await readPageFacts()
  const facts = source?.facts ?? null
  /*
    The structured data, from the same read as the NAP block below.

    This route is where W-SITE-03's graph is *rendered*, and the reason is the one its registry entry already
    gives for the NAP block: a JSON-LD block built from the premises row can only be right on a route that
    reads the row **per request**, and this is the one document in the registry that is `force-dynamic`. `/`
    is statically prerendered, so its metadata and its markup are evaluated during `next build`, where there
    is no database by design — CI runs the build before `pnpm db:apply`. A build-time read would bake a graph
    that nothing could then correct, which is a hand-written schema block with extra steps. W-SITE-04 renders
    the public home page under ISR and puts the block there, where a revalidation propagates a correction.

    `includeCatalogue` is true because this page renders the menu, and because it is the surface the 32 price
    points are proved against: `apps/web/src/seo/structured-data.itest.ts` fetches this route, parses the
    block out of the served HTML and matches every Offer against the catalogue rows.
  */
  const graph =
    source === null
      ? null
      : pageGraph({
          id: 'kitchen-sink',
          locale: 'en',
          facts: source.facts,
          licenceClass: source.licenceClass,
          breadcrumb: { home: 'Home', page: 'Kitchen sink' },
          includeCatalogue: true,
        })
  return (
    <main>
      {graph === null ? null : <StructuredData graph={graph} />}
      <DesignSystemStyles />
      <MotionHeader copy={MOTION_COPY} />
      <RouteNav id="kitchen-sink" locale="en" />

      <Section as="header">
        <Grid>
          <p className="text-eyebrow text-ink-2 uppercase">BE RELAX — design system</p>
          <Measure cap="h1" as="h1" className="text-3xl">
            Come in tense. Leave light.
          </Measure>
          <Measure cap="lede" className="text-lg text-ink-2">
            One asymmetric grid, one measure, one focus ring and three components that answer to
            their own width rather than to the viewport. Everything on this page is the system;
            nothing on it is a mock-up that agrees with the system today.
          </Measure>
          <Measure cap="body">
            A massage and spa centre in Abu Dhabi. Where it is and when it opens are rendered
            further down from the one record that holds them, never typed into this page. The grid
            below repeats one asymmetry — a twelve-rem column on one side of the measure and a
            twenty-rem column on the other — rather than inventing a layout per section, which is
            what makes eleven pages look like one site.
          </Measure>
          <GridCell>
            <div className="be-actions">
              <a className="be-action" href="#slots">
                Book a treatment
              </a>
              <a className="be-action be-action--quiet" href="#menu">
                See the menu
              </a>
            </div>
          </GridCell>
        </Grid>
      </Section>

      <Section surface="sand">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            The measure, in three roles
          </Measure>
          <Measure cap="display" as="blockquote" className="font-display text-2xl">
            Eighteen characters is a pull quote.
          </Measure>
          <Measure cap="body">
            The body measure is sixty-eight characters, the lede fifty-six and an h1 twenty-six, and
            each cap is set in ch units on the element itself, so it resolves against that element's
            own font. A pixel width would be right for one of the three and quietly wrong for the
            other two, and the symptom is a line that runs to ninety characters on one route with
            nothing in the stylesheet to explain it.
          </Measure>
        </Grid>
      </Section>

      <Section id="menu">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            Treatments
          </Measure>
          <GridCell span="wide">
            {MENU.map((item) => (
              <ServiceRow
                key={item.name}
                name={item.name}
                meta={`${item.style} · ${item.minutes} minutes`}
                price={formatMoney(item.price)}
                action={{ label: 'Book', href: '#slots' }}
              />
            ))}
          </GridCell>
          <Measure cap="body" className="text-sm text-ink-2">
            All prices include VAT. A row is a container-query component: below 420px of container
            it stacks, and at 420px it becomes one line. That threshold is the row's, not the page's
            — the same row appears in the measure column here and in a 300px rail in the admin.
          </Measure>
        </Grid>
      </Section>

      <Section surface="sunk" id="slots">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            Available today
          </Measure>
          <div data-reveal>
            <SlotGrid slots={SLOTS} ariaLabel="Start times available today" />
          </div>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            Our therapists
          </Measure>
          <GridCell span="wide" as="ul" className="grid list-none gap-8 p-0 md:grid-cols-3">
            {portraits(3).map((portrait) => (
              <li key={portrait.index}>
                <TherapistCard
                  unnamedLabel={UNNAMED}
                  reference={`Therapist ${String(portrait.index + 1).padStart(2, '0')}`}
                  href="#slots"
                  portrait={{
                    src: `/kitchen-sink/portrait/${portrait.index}`,
                    objectPosition: portrait.objectPosition,
                  }}
                  qualifications="Asian · Arabic"
                  services="Normal, hot oil and Morocco bath"
                />
              </li>
            ))}
          </GridCell>
          <Measure cap="body" className="text-sm text-ink-2">
            No card carries a name, because no therapist has one until an admin sets it and records
            a photography consent. The photographs are the business's own, cropped to 4:5 around a
            focal point declared per image: they are full-length shots, and a centre crop takes the
            torso.
          </Measure>
        </Grid>
      </Section>

      <Section surface="surface">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            Controls
          </Measure>
          <GridCell>
            <div className="grid gap-6">
              <label className="be-field">
                <span className="be-field__label">Mobile number</span>
                <input className="be-field__input" type="tel" name="mobile" autoComplete="tel" />
              </label>
              <label className="be-field">
                <span className="be-field__label">Duration</span>
                <select className="be-field__select" name="duration" defaultValue="60">
                  <option value="45">45 minutes</option>
                  <option value="60">60 minutes</option>
                  <option value="90">90 minutes</option>
                  <option value="120">120 minutes</option>
                </select>
              </label>
            </div>
          </GridCell>
          <GridCell>
            <details className="be-disclosure">
              <summary className="be-disclosure__summary">What is included in the price?</summary>
              <Measure cap="body">
                Every price is the gross amount including VAT, and the amount you are charged. VAT
                is derived from it rather than added to it, so the figure never changes on the
                invoice.
              </Measure>
            </details>
            <details className="be-disclosure">
              <summary className="be-disclosure__summary">
                Can I ask for a specific therapist?
              </summary>
              <Measure cap="body">
                Same-gender matching is on by default and can be changed at the desk. A named
                request is possible once a therapist has a published profile.
              </Measure>
            </details>
          </GridCell>
        </Grid>
      </Section>

      {/*
        The page ground, deliberately, and not the sand band this section first used.

        `.be-action--quiet` is teal on transparent, and `packages/ui/src/tokens/palette.generated.ts`
        measures every accent against `--color-ground` only: teal is 5.73:1 there in light and 4.64:1 in
        dark. On `--color-surface-sand` in dark (#231F1A) the same colour is 4.07:1, under the 4.5:1 body
        threshold — and `apps/web/src/primitives.itest.ts` caught it, as a serious axe colour-contrast
        violation on the map and directions links at `/kitchen-sink dark ltr 390px`. The two links stay
        quiet actions, because four gold actions in a row is not a design, and the band moves to the
        ground where the measured figure applies. A quiet action on a sand band is a token question for
        W-SYS-03 rather than something to work around per page.
      */}
      <Section id="nap">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            Where we are
          </Measure>
          <GridCell span="wide">
            {facts === null ? (
              <Measure cap="body" className="text-sm text-ink-2">
                The premises record has not been loaded into this database, so there is nothing to
                render. Run the seed. Nothing on this page invents an address to fill the gap.
              </Measure>
            ) : (
              <NapBlock copy={NAP_COPY_EN} facts={facts} />
            )}
          </GridCell>
          <Measure cap="body" className="text-sm text-ink-2">
            Every line of that block — the street, the district and its other names, the numbers,
            the session and the note about parking — comes from one database row, and the same row
            is published as JSON at /api/facts and summarised at /llms.txt. The WhatsApp line says
            no number is published because two different ones appear on this business's older web
            properties and neither has been confirmed; a block that picked one would be
            indistinguishable from a block that knew.
          </Measure>
        </Grid>
      </Section>

      <Section surface="sand" id="motion">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            {MOTION_COPY.heading}
          </Measure>
          <GridCell span="wide">
            <MotionGallery copy={MOTION_COPY} />
          </GridCell>
        </Grid>
      </Section>

      <Section id="primitives">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            Primitives
          </Measure>
          <Measure cap="body">
            The shadcn set over Radix, re-geometried: 48px targets rather than 36, a 2px corner on
            cards and inputs and 8px on buttons and selects, 17px controls rather than 14px, and one
            shadow that only the three overlays wear. The dialog, the sheet, the popover and the
            select menu portal into the document body, so their direction comes from
            DirectionProvider rather than from an ancestor.
          </Measure>
          <GridCell span="wide">
            <PrimitiveGallery copy={PRIMITIVE_COPY} />
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}
