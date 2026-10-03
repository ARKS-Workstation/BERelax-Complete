import { buildEgressPayload } from '@berelax/core'
import type { Locale } from '@berelax/ui'
import { type ClientTag, TagLoader } from '../(public)/_components/tag-loader.tsx'
import WebVitalsIsland from './web-vitals.client.tsx'

/**
 * The tag-loader fixture's body, shared by both locales (A-MEAS-04).
 *
 * ## Why this route exists at all
 *
 * `CLIENT_TAGS` is empty — no measurement id, container id or pixel id has been issued to this business
 * and no analytics host appears anywhere in this repository — so the loader on a real page has nothing to
 * load, and an interception spec run against one would assert "no tag loaded" about a page with no tag
 * declared. That is the vacuous pass ADR 0003 is about: it would hold for ever, including on the day the
 * gate broke.
 *
 * So this page declares ONE tag, and it is first-party: `src` is a site-relative path nothing serves, and
 * the spec intercepts it and fulfils it with its own script. That makes the acceptance line *"a tag that
 * DOES load after a grant, and none before it in the same page session"* a claim about a real request
 * through the real loader — and it does it without naming a vendor host, which
 * `scripts/check-egress-guard.mjs` rule 6 refuses outside a declared adapter.
 *
 * ## Why the conversion payload is built here
 *
 * `buildEgressPayload` is A-MEAS-01's guard and the only way to obtain an `EgressPayload`. Building one on
 * this page is what gives the interception spec something to find in `dataLayer` — and what it finds is a
 * category code, a quantity and an event type, because that is all the guard's field allowlist projects.
 * A service name cannot be here: the guard takes a catalogue REF and never a name.
 */

/** The fixture tag's path. Nothing serves it; the spec intercepts it. */
export const FIXTURE_TAG_SRC = '/_fixture/analytics-tag.js'
export const FIXTURE_TAG_ID = 'fixture-analytics'

export const FIXTURE_TAGS: readonly ClientTag[] = [
  { id: FIXTURE_TAG_ID, target: 'analytics_tag', src: FIXTURE_TAG_SRC },
]

/**
 * A click handler that takes long enough to be an INP measurement.
 *
 * ## Why a fixture has to be slow on purpose
 *
 * INP is the delay between an interaction and the next paint, and `PerformanceObserver` only reports an
 * `event` entry past a duration threshold — 40 ms, which is the figure web-vitals v4 uses and which
 * `INP_DURATION_THRESHOLD_MS` states once. An ordinary click on a loaded page finishes in well under
 * that, so a browser suite clicking a real button gets no `event` entry and therefore no INP: the
 * assertion would pass or fail on how busy the machine was, which is the flake brief rule 23 is about.
 *
 * So this fixture makes ONE interaction deliberately slow, and that is what a fixture is for. The
 * alternative was making a real page slow, which is not a thing to do to a booking form.
 *
 * It is an inline STRING and not a module, for the shell's reason: a client module here would be bytes
 * on `tag-loader-client-js`'s budget, and this is test scaffolding rather than product code. It touches
 * no network, reads no cookie and decides nothing.
 */
const SLOW_INTERACTION_SCRIPT =
  '(function(){try{document.addEventListener("click",function(e){' +
  'var t=e.target&&e.target.closest?e.target.closest(\'[data-fixture="interact"]\'):null;' +
  'if(!t)return;var until=Date.now()+120;while(Date.now()<until){}' +
  // The mutation forces the next paint, which is the instant INP measures to. Without it the browser may
  // have nothing to repaint and the entry's duration stays at the event's own processing time.
  't.setAttribute("data-fixture-pressed",String(Date.now()));' +
  '},false)}catch(e){}})()'

export interface TagLoaderFixtureCopy {
  readonly heading: string
  readonly lede: string
  readonly interactLabel: string
  readonly shiftLabel: string
}

export function TagLoaderFixture({
  copy,
  locale,
}: {
  readonly copy: TagLoaderFixtureCopy
  readonly locale: Locale
}) {
  // One conversion, built through the guard. `ref` is a catalogue reference and not a name, which is why
  // the payload cannot carry one.
  const { payload } = buildEgressPayload({
    ref: { kind: 'package_template' },
    eventType: 'paid',
    quantity: 1,
    valueFils: 26_250,
  })
  return (
    <main>
      <h1>{copy.heading}</h1>
      <p>{copy.lede}</p>
      {/*
        A control to press and an element that moves, so the browser has an interaction to measure and a
        layout shift to attribute. Without them INP and CLS are absent on this page and the two assertions
        about them would be assertions about nothing.
      */}
      <button type="button" data-fixture="interact">
        {copy.interactLabel}
      </button>
      <p data-fixture="shift">{copy.shiftLabel}</p>
      {/*
        The slow interaction, inline. See `SLOW_INTERACTION_SCRIPT`: an ordinary click finishes under the
        40 ms threshold a `PerformanceObserver` reports `event` entries above, so without this there is no
        INP to assert and the case would pass or fail on how busy the machine was.
      */}
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant in this module, never user input, and inline because a client module here would be bytes on a budget
        dangerouslySetInnerHTML={{ __html: SLOW_INTERACTION_SCRIPT }}
      />
      <TagLoader tags={FIXTURE_TAGS} conversions={[payload]} />
      <WebVitalsIsland path={locale === 'ar' ? '/ar/tag-loader' : '/tag-loader'} />
    </main>
  )
}
