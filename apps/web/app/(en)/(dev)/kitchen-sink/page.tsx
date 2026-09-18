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
import { ServiceRow, SlotGrid, TherapistCard } from '@berelax/ui/patterns'
import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { PrimitiveGallery, type PrimitiveGalleryCopy } from '../../../_dev/primitive-gallery.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'
import { portraits } from './portraits.ts'

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

/** Trading runs 11:00 to 02:00, so the first start is 11:00. */
const SLOTS = [
  { label: '11:00', available: true },
  { label: '12:30', available: true },
  { label: '14:00', available: true, selected: true },
  { label: '15:30', available: false },
  { label: '17:00', available: true },
  { label: '18:30', available: true },
  { label: '20:00', available: true },
  { label: '21:30', available: true },
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
      'Trading runs from 11:00 until 02:00, so the last start is earlier than the closing time by the ' +
      'length of the treatment.',
    close: 'Close',
  },
}

export default function KitchenSinkPage() {
  return (
    <main>
      <DesignSystemStyles />
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
            A massage centre on Al Meena Street in Al Zahiyah, Abu Dhabi, open every day from 11am
            until 2am. The grid below repeats one asymmetry — a twelve-rem column on one side of the
            measure and a twenty-rem column on the other — rather than inventing a layout per
            section, which is what makes eleven pages look like one site.
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
