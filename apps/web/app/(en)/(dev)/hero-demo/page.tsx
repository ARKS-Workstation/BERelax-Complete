import { DesignSystemStyles } from '@berelax/ui/layout'
import type { Metadata } from 'next'
import { STAND_IN_NOTE } from '../../../../src/media/hero-demo-asset.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { HeroDemo, type HeroDemoCopy } from '../../../_dev/hero-demo.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'

/**
 * The hero demo, in English. W-SYS-07.
 *
 * A development surface, so `indexable: false` in the registry — which is where the `robots` directive and
 * the alternate set both come from, so a dev route cannot become indexable by a page forgetting to restate
 * it.
 *
 * `force-dynamic` because the component reads the committed photograph's bytes to compute its content
 * address. Prerendered, that address would be baked at build time, and replacing the photograph would
 * leave a page pointing at the derivatives of the previous one — which is precisely the staleness a
 * content-addressed URL exists to make impossible.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Hero media — the LCP-safe poster and the attach island',
  description:
    'The technique that makes a video hero free: a real img as the LCP element, and a video with no src ' +
    'and no poster until after LCP.',
  ...routeMetadata('hero-demo', 'en'),
}

const COPY: HeroDemoCopy = {
  eyebrow: 'BE RELAX — media system',
  heading: 'The hero is a photograph until it is free.',
  lede:
    'The largest element on this page is a real img inside an art-directed picture: 4:5 below 768px, ' +
    '16:9 above it, preloaded per breakpoint at high priority. The video above it ships with no src and ' +
    'no poster, so it is not a candidate for largest contentful paint at all. An island attaches the ' +
    'source after the page has loaded, and only then.',
  alt:
    'Five therapists in sage-green uniforms seated together in the reception lounge, with a lit candle ' +
    'and dried flowers behind them.',
  control: {
    pause: 'Pause the background video',
    play: 'Play the background video',
  },
  statesHeading: 'When the video is never attached',
  states:
    'Under reduced motion the island attaches nothing and offers no control: there is no moving content, ' +
    'so there is nothing to pause, and a play button would ask a reader who has already set the ' +
    'preference to set it again. The same under reduced transparency. On a connection measured under ' +
    '600 kbit/s from this page’s own resource timings — not from navigator.connection, which Safari does ' +
    'not have — the still remains and the bytes are never requested. If the reader pauses the loop, that ' +
    'choice is remembered and the control comes back as play on the next visit.',
  footageHeading: 'There is no footage yet',
  footage: STAND_IN_NOTE,
}

export default function HeroDemoPage() {
  return (
    <main>
      <DesignSystemStyles />
      <HeroDemo copy={COPY} />
      <RouteNav id="hero-demo" locale="en" />
    </main>
  )
}
