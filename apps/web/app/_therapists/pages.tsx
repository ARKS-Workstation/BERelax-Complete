/**
 * The bodies of the two therapist pages, rendered once and served in two locales.
 *
 * The folder is `_therapists`, with the underscore: Next excludes an underscore-prefixed folder from
 * routing entirely, so these components contribute no URL and the registry's bijection with the filesystem
 * is unaffected (`src/routes/discover.ts` skips them for the same reason).
 *
 * ## What these components may and may not do
 *
 * They render. Every decision — which card carries an anchor, whether a "Book with" action exists, what a
 * skill is called in this language — is made in `src/therapists/content.ts` and arrives as a prop, because
 * a `.tsx` in this application cannot be imported by a unit test (`jsx: "preserve"`). The guard is not
 * re-applied here: a component that re-derived "may this therapist be published" would be a second answer
 * to the question ADR 0020 exists to have one answer to.
 */
import type { TherapistPageRow } from '@berelax/db'
import type { Facts } from '@berelax/shared'
import { DesignSystemStyles, Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import { TherapistCard } from '@berelax/ui/patterns'
import { type Locale, localisedPath } from '../../src/i18n/locales.ts'
import { type TherapistIndexCard, therapistsIndexPath } from '../../src/therapists/content.ts'
import type { TherapistsCopy } from '../../src/therapists/copy-shape.ts'
import type { TherapistAvailability } from '../../src/therapists/read.ts'
import { Breadcrumb } from '../_routes/breadcrumb.tsx'

export interface TherapistsIndexBodyProps {
  readonly cards: readonly TherapistIndexCard[]
  readonly copy: TherapistsCopy
  readonly locale: Locale
}

/**
 * The index: one card per therapist on the roster, and nineteen of them carry no anchor.
 *
 * The emptiness of `href` is the publication guard made visible, and `TherapistCard` renders **no anchor
 * element at all** rather than a disabled one — an `<a>` with no `href` is still announced as a link by
 * some screen readers, and `href="#"` is a link that scrolls the page.
 */
export function TherapistsIndexBody({ cards, copy, locale }: TherapistsIndexBodyProps) {
  return (
    <main>
      <DesignSystemStyles />
      <Section as="header">
        <Grid>
          <GridCell span="wide">
            <Breadcrumb
              locale={locale}
              label={copy.index.title}
              trail={[{ label: copy.home, href: localisedPath('/', locale) }]}
              currentLabel={copy.index.title}
            />
            <Measure cap="h1" as="h1" className="text-3xl">
              {copy.index.title}
            </Measure>
            <Measure cap="body" as="p">
              {copy.index.lede}
            </Measure>
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell span="wide" as="ul" className="be-home__cards">
            {cards.length === 0 ? <li>{copy.index.empty}</li> : null}
            {cards.map((card) => (
              <li key={card.reference}>
                {/*
                  `portrait` is absent for every one of the nineteen and the absence is a guard rather than
                  a gap: the card reserves the slot's 4:5 box and paints it in the palette-matched
                  placeholder `therapist-portrait` declares (W-SYS-09), so the photograph arrives later
                  with no layout shift. Serving a portrait would need both a built derivative and a
                  recorded photography consent, and there is neither (Y12-photos, Y12-consent-photo).
                */}
                <TherapistCard
                  reference={card.reference}
                  unnamedLabel={copy.index.unnamedTherapist}
                  {...(card.displayName === undefined ? {} : { displayName: card.displayName })}
                  {...(card.href === undefined ? {} : { href: card.href })}
                  {...(card.qualifications === undefined
                    ? {}
                    : { qualifications: card.qualifications })}
                />
              </li>
            ))}
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}

export interface TherapistBodyProps {
  readonly facts: Facts
  readonly row: TherapistPageRow
  /** The display name, passed in rather than read off the row: the route has already run the guard. */
  readonly displayName: string
  readonly knowsAbout: readonly string[]
  readonly languages: readonly string[]
  readonly qualifications: string | undefined
  readonly availability: TherapistAvailability | null
  readonly bookHref: string | null
  readonly copy: TherapistsCopy
  readonly locale: Locale
}

/**
 * One therapist: the portrait box, what they are trained in, what they speak, and a way to book them.
 *
 * `displayName` is a REQUIRED prop of this component and is not read off the row, which is deliberate: the
 * only way to render this page is to have already resolved the guard, so a caller cannot reach it with an
 * unnamed therapist and have the component quietly render an empty heading.
 */
export function TherapistBody({
  row,
  displayName,
  knowsAbout,
  languages,
  qualifications,
  availability,
  bookHref,
  copy,
  locale,
}: TherapistBodyProps) {
  return (
    <main>
      <DesignSystemStyles />
      <Section as="header">
        <Grid>
          <GridCell span="wide">
            <Breadcrumb
              locale={locale}
              label={copy.index.title}
              trail={[
                { label: copy.home, href: localisedPath('/', locale) },
                { label: copy.index.title, href: therapistsIndexPath(locale) },
              ]}
              currentLabel={displayName}
            />
            <Measure cap="h1" as="h1" className="text-3xl">
              {displayName}
            </Measure>
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell>
            <TherapistCard
              reference={row.staffReference}
              unnamedLabel={copy.index.unnamedTherapist}
              displayName={displayName}
              {...(qualifications === undefined ? {} : { qualifications })}
            />
          </GridCell>
          <GridCell>
            <Measure cap="body" as="div">
              <h2>{copy.detail.specialisms}</h2>
              <ul data-therapist="knows-about">
                {knowsAbout.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <h2>{copy.detail.languages}</h2>
              {languages.length === 0 ? (
                <p data-therapist="languages-unknown">{copy.detail.languagesUnknown}</p>
              ) : (
                <ul data-therapist="languages">
                  {languages.map((language) => (
                    <li key={language}>{language}</li>
                  ))}
                </ul>
              )}
              {bookHref === null ? null : (
                <p>
                  <a className="be-action" data-therapist="book-with" href={bookHref}>
                    {copy.detail.bookWith(displayName)}
                  </a>
                </p>
              )}
            </Measure>
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell span="wide">
            <h2>{copy.detail.availability}</h2>
            {availability === null ? (
              <p data-therapist="no-variant">{copy.detail.noVariant}</p>
            ) : availability.alternatives === null ? (
              <ul data-therapist="slots">
                {availability.starts.map((startsAt) => (
                  <li key={startsAt}>{new Date(startsAt).toISOString()}</li>
                ))}
              </ul>
            ) : (
              /*
                docs/09 §3: "No availability is a designed state, not an empty one." All three parts are
                present together — the nearest days, the same treatment with another therapist, and the
                waitlist join — because two of three is a designed state with a hole in it, and
                `therapists.itest.ts` asserts the region by these three attributes rather than by its
                heading.
              */
              <section data-therapist="alternatives">
                <h3>{copy.detail.alternatives.title}</h3>
                <p>{copy.detail.alternatives.lede}</p>
                <h4>{copy.detail.alternatives.nearestDays}</h4>
                {availability.alternatives.nearestDays.length === 0 ? (
                  <p data-alternatives="nearest-days-empty">{copy.detail.alternatives.noDays}</p>
                ) : (
                  <ul data-alternatives="nearest-days">
                    {availability.alternatives.nearestDays.map((day) => (
                      <li key={day.tradingDate}>{day.tradingDate}</li>
                    ))}
                  </ul>
                )}
                <h4>{copy.detail.alternatives.otherTherapists}</h4>
                {availability.alternatives.otherTherapists.length === 0 ? (
                  <p data-alternatives="other-therapists-empty">
                    {copy.detail.alternatives.noTherapists}
                  </p>
                ) : (
                  <ul data-alternatives="other-therapists">
                    {availability.alternatives.otherTherapists.map((other) => (
                      <li key={other.therapistId}>{String(other.slotCount)}</li>
                    ))}
                  </ul>
                )}
                <h4>{copy.detail.alternatives.waitlist}</h4>
                {availability.alternatives.waitlist.eligible ? (
                  <p data-alternatives="waitlist">{copy.detail.alternatives.waitlist}</p>
                ) : (
                  <p data-alternatives="waitlist-refused">
                    {copy.detail.alternatives.waitlistRefused(
                      availability.alternatives.waitlist.reason ?? 'unknown',
                    )}
                  </p>
                )}
              </section>
            )}
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}
