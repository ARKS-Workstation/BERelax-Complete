import { Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import type { HeroPauseControlCopy } from '@berelax/ui/media/pause-control'
import type { ReactElement } from 'react'
import { HeroMedia } from '../../src/components/media/hero-media.tsx'
import { HERO_VIDEO_OPEN_QUESTION, heroDemoMedia } from '../../src/media/hero-demo-asset.ts'

/**
 * The hero demo: the one surface where W-SYS-07's claims are things a browser can be asked about.
 *
 * None of this unit is decidable from source. "The largest-contentful-paint entry's element is the
 * `<img>`" is a claim about a `PerformanceObserver`; "at that moment the video has no `currentSrc`" is a
 * claim about two elements at one instant; "the head contains exactly two art-directed preloads" is a
 * claim about what React hoisted; and the cross-fade, the tap-to-play reveal and the slow-connection hold
 * are claims about what happens over seconds. `apps/web/src/hero-lcp.itest.ts` drives all of them against
 * a real `next start`.
 *
 * ## Why a route of its own, when W-SYS-04 deliberately did not take one
 *
 * The motion system put its specimen on the kitchen sink because a reveal has to be below the fold and a
 * header has to be at the top of something long enough to scroll — both of which that route already had.
 * This unit needs the opposite: a page whose **above-the-fold region contains nothing but the hero**. Two
 * of its criteria are about what is above the fold at first paint (no running animation, no computed
 * opacity below 1) and one is about which element wins LCP, and the kitchen sink's condensing header is a
 * scroll-driven animation on an above-the-fold element. Adding the hero there would have made the
 * entrance-animation ban a test of the header.
 *
 * So the cost is paid deliberately: one registry entry, two documents, twelve more screenshot cells.
 *
 * ## What is on it, and what is not
 *
 * The hero, then prose. No header, no sticky bar, no reveal — anything else above the fold would be
 * another thing the ban assertion was measuring. The prose is below the fold on a phone, where it is the
 * explanation for whoever opens this route to look at the thing rather than to test it.
 */
export interface HeroDemoCopy {
  readonly eyebrow: string
  readonly heading: string
  readonly lede: string
  /** The photograph's alt text. The hero is the one image on a page nobody scrolls past. */
  readonly alt: string
  readonly control: HeroPauseControlCopy
  readonly statesHeading: string
  readonly states: string
  readonly footageHeading: string
  /** What this document says about the missing footage. Printed, never implied. */
  readonly footage: string
}

export function HeroDemo({ copy }: { copy: HeroDemoCopy }): ReactElement {
  const media = heroDemoMedia()
  return (
    <>
      {/*
        First, and outside any band. A hero is full-bleed: `Section` would put the page gutter around it,
        and the LCP element would then be narrower than the viewport on the device the whole budget is
        written for.
      */}
      <HeroMedia
        poster={media.poster}
        video={media.video}
        copy={{ alt: copy.alt, control: copy.control }}
      />
      <Section as="header">
        <Grid>
          <p className="text-eyebrow text-ink-2 uppercase">{copy.eyebrow}</p>
          <Measure cap="h1" as="h1" className="text-3xl">
            {copy.heading}
          </Measure>
          <Measure cap="lede" className="text-lg text-ink-2">
            {copy.lede}
          </Measure>
        </Grid>
      </Section>
      <Section surface="sand">
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            {copy.statesHeading}
          </Measure>
          <Measure cap="body">{copy.states}</Measure>
        </Grid>
      </Section>
      <Section>
        <Grid>
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            {copy.footageHeading}
          </Measure>
          <Measure cap="body">{copy.footage}</Measure>
          <GridCell span="wide">
            {/*
              The four URLs, printed. A page that says "these paths 404" and does not show them is a page
              nobody can check: this is the one place the island's input is visible without a debugger,
              and it is how a reader sees that the addresses are the pipeline's own.
            */}
            <ul className="text-sm text-ink-2">
              <li>
                <code>{HERO_VIDEO_OPEN_QUESTION}</code>
              </li>
              <li>
                <code>{media.video.mediaId}</code> / <code>{media.video.contentHash}</code>
              </li>
            </ul>
          </GridCell>
        </Grid>
      </Section>
    </>
  )
}
