/**
 * The bodies of the three catalogue-derived pages, rendered once and served in two locales.
 *
 * Six route files and three components, for the reason the kitchen sink already works this way
 * (`app/_dev/primitive-gallery.tsx`): the structure of a page is one thing and the language of a page is
 * another. Two copies of the treatment page would be two places the price table, the heading shape and the
 * breadcrumb could drift, and the RTL half of every assertion would be testing a different component from the
 * LTR half — which is the failure `/ar` exists to catch rather than to duplicate.
 *
 * The folder is `_treatments`, with the underscore: Next excludes an underscore-prefixed folder from routing
 * entirely, so these components contribute no URL and the registry's bijection with the filesystem is
 * unaffected (`src/routes/discover.ts` skips them for the same reason).
 *
 * ## What these components may and may not do
 *
 * They render. They do not read: the fact sheet arrives as a prop, already parsed by `factsSchema`, and every
 * figure in it has been through the money helper. They contain no price, no address, no telephone number and
 * no opening time — `no-price-literals.test.ts` and `packages/db/src/seed/premises.test.ts` both assert that,
 * from opposite directions.
 */

import type { Facts } from '@berelax/shared'
import { DesignSystemStyles, Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import { PriceTable, type PriceTableGroup } from '@berelax/ui/patterns'
import { type Locale, localisedPath } from '../../src/i18n/locales.ts'
import {
  type CatalogueService,
  type MenuCopy,
  menuSections,
  priceCellFor,
  priceRowId,
  type TreatmentCopy,
  treatmentSections,
} from '../../src/treatments/content.ts'
import { QuestionSections } from './sections.tsx'

/*
 * The three paths these pages link to each other with.
 *
 * Spelled from the registry's own paths through `localisedPath`, which is the one place a locale becomes a
 * URL. They are literals here rather than `pathFor(routeById(...))` calls because these are components and a
 * registry lookup per render is a lookup per render; `registry.test.ts`'s bijection is what keeps the spelling
 * honest, and `revalidationPathsFor` builds the same paths from the entries so a moved route fails there.
 */
const indexPath = (locale: Locale): string => localisedPath('/treatments', locale)
const pricingPath = (locale: Locale): string => localisedPath('/pricing', locale)
const treatmentPath = (locale: Locale, slug: string): string =>
  localisedPath(`/treatments/${slug}`, locale)

/**
 * The visible trail, matching the `BreadcrumbList` in the JSON-LD.
 *
 * Both are built from the same labels, because a trail a reader can click and a trail a crawler reads that
 * disagree is worse than either alone: the schema block would claim a hierarchy the page does not have.
 */
function Breadcrumb({
  locale,
  label,
  trail,
  currentLabel,
}: {
  readonly locale: Locale
  /** The accessible name of the nav, in this locale. */
  readonly label: string
  readonly trail: readonly { readonly label: string; readonly href: string }[]
  readonly currentLabel: string
}) {
  return (
    <nav aria-label={label}>
      <ol className="be-actions">
        {trail.map((step) => (
          <li key={step.href}>
            <a href={step.href} lang={locale}>
              {step.label}
            </a>
          </li>
        ))}
        <li aria-current="page">{currentLabel}</li>
      </ol>
    </nav>
  )
}

export interface TreatmentBodyProps {
  readonly facts: Facts
  readonly service: CatalogueService
  readonly copy: TreatmentCopy
  readonly locale: Locale
}

/**
 * One treatment: the name, the four priced durations, and six answered questions.
 *
 * The durations are **rows in a table**, which is the decision the acceptance criterion's phrasing exists to
 * protect: "durations are rows, not routes". A route per duration would be 32 near-duplicate pages, each
 * competing with the other three for the same query and each having to repeat everything this page says.
 */
export function TreatmentBody({ facts, service, copy, locale }: TreatmentBodyProps) {
  const sections = treatmentSections({ facts, service, locale }, copy)
  const groups: readonly PriceTableGroup[] = [
    {
      name: service.name,
      rows: service.variants.map((variant) => ({
        id: priceRowId(service.slug, variant.durationMinutes),
        label: copy.durationLabel(variant.durationMinutes),
        amount: priceCellFor(variant),
      })),
    },
  ]
  return (
    <main>
      <DesignSystemStyles />
      <Section as="header">
        <Grid>
          <GridCell span="wide">
            <Breadcrumb
              locale={locale}
              label={copy.index}
              trail={[
                { label: copy.home, href: localisedPath('/', locale) },
                { label: copy.index, href: indexPath(locale) },
              ]}
              currentLabel={service.name}
            />
            <Measure cap="h1" as="h1" className="text-3xl">
              {service.name}
            </Measure>
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell>
            <Measure cap="body" as="div">
              <QuestionSections
                sections={sections}
                extras={{
                  // The table goes under the question it answers. `priceCellFor` is the money helper and the
                  // only way a figure reaches this page.
                  'how-much-does-it-cost': (
                    <PriceTable
                      caption={copy.table.caption(service.name)}
                      labelHeading={copy.table.duration}
                      amountHeading={copy.table.amount}
                      groups={groups}
                    />
                  ),
                }}
              />
            </Measure>
            <p>
              <a className="be-action be-action--quiet" href={pricingPath(locale)}>
                {copy.seeAllPrices}
              </a>
            </p>
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}

export interface MenuBodyProps {
  readonly facts: Facts
  readonly copy: MenuCopy
  readonly locale: Locale
}

/**
 * The treatments index: every published treatment, each linking to its own page.
 *
 * Deliberately **no prices**. The price of a treatment is four figures, not one, and a "from" figure here
 * would be a fifth rendering of a catalogue row whose only purpose is to be compared with the four on the page
 * it links to. `/pricing` is the page that compares them, and it is one link away.
 */
export function TreatmentsIndexBody({ facts, copy, locale }: MenuBodyProps) {
  return (
    <main>
      <DesignSystemStyles />
      <Section as="header">
        <Grid>
          <GridCell span="wide">
            <Breadcrumb
              locale={locale}
              label={copy.title}
              trail={[{ label: copy.home, href: localisedPath('/', locale) }]}
              currentLabel={copy.title}
            />
            <Measure cap="h1" as="h1" className="text-3xl">
              {copy.title}
            </Measure>
            <Measure cap="lede">{copy.lede}</Measure>
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell span="wide">
            <ul>
              {facts.catalogue.services.map((service) => (
                <li key={service.slug}>
                  <a href={treatmentPath(locale, service.slug)}>
                    {copy.seeTreatment(service.name)}
                  </a>
                  {/* The durations, as the catalogue holds them. No figure: see the note above. */}
                  <span>
                    {service.variants
                      .map((variant) => copy.durationLabel(variant.durationMinutes))
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell>
            <Measure cap="body" as="div">
              <QuestionSections sections={menuSections(facts, copy)} />
            </Measure>
            <p>
              <a className="be-action be-action--quiet" href={pricingPath(locale)}>
                {copy.pricingTitle}
              </a>
            </p>
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}

/**
 * `/pricing`: all 32 price points in one table, plus the three offerings that have no figure.
 *
 * One table with a group header per treatment rather than eight tables, because the page exists to be read
 * down a single column — and because that is the shape docs/09 §"LLM SEO" asks for ("tables for comparable
 * facts") and the shape an assistant extracts without guessing which heading a figure belongs to.
 */
export function PricingBody({ facts, copy, locale }: MenuBodyProps) {
  const groups: readonly PriceTableGroup[] = facts.catalogue.services.map((service) => ({
    name: service.name,
    rows: service.variants.map((variant) => ({
      id: priceRowId(service.slug, variant.durationMinutes),
      label: copy.durationLabel(variant.durationMinutes),
      amount: priceCellFor(variant),
    })),
  }))
  return (
    <main>
      <DesignSystemStyles />
      <Section as="header">
        <Grid>
          <GridCell span="wide">
            <Breadcrumb
              locale={locale}
              label={copy.pricingTitle}
              trail={[
                { label: copy.home, href: localisedPath('/', locale) },
                { label: copy.title, href: indexPath(locale) },
              ]}
              currentLabel={copy.pricingTitle}
            />
            <Measure cap="h1" as="h1" className="text-3xl">
              {copy.pricingTitle}
            </Measure>
            <Measure cap="lede">{copy.pricingLede}</Measure>
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell span="wide">
            <PriceTable
              caption={copy.table.caption(facts.catalogue.pricePointCount)}
              labelHeading={copy.table.duration}
              amountHeading={copy.table.amount}
              groups={groups}
            />
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell>
            <Measure cap="body" as="div">
              <QuestionSections
                sections={menuSections(facts, copy)}
                extras={{
                  'what-is-priced-on-request': (
                    <ul>
                      {facts.catalogue.onRequest.map((offering) => (
                        <li key={offering.label}>
                          {/* The label and the words "price on request" — never a figure. `price_on_request`
                              has no price column at all (0032), and the provisional derivation the manifest
                              once proposed was reversed by B-CAT-06 precisely so that nothing could quote
                              it. Y9-poa-prices is the open question. */}
                          <strong>{offering.label}</strong>: {copy.priceOnRequest}
                        </li>
                      ))}
                    </ul>
                  ),
                }}
              />
            </Measure>
            <p>
              <a className="be-action be-action--quiet" href={indexPath(locale)}>
                {copy.title}
              </a>
            </p>
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}
