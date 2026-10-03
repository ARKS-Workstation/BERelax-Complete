'use client'

// A SEPARATE `import type` statement, on purpose. `@berelax/core` has no subpath for the egress guard, so
// this names the barrel — and a type imported on the same line as a value drags the whole package into
// this module's client chunk, which is the defect that cost A-FIRST-06 98KB. `import type` is erased
// entirely, so the barrel is never in the graph.
import type { EgressPayload } from '@berelax/core'
import { mayLoadClientTag } from '@berelax/core/analytics/consent-gate'
import { useEffect } from 'react'

/**
 * The consent-gated tag loader (A-MEAS-04): the one thing that may put a third-party script on a page.
 *
 * ## It does not decide anything (ADR 0076)
 *
 * `mayLoadClientTag` is the ONE statement of whether a tag may load, and this module calls it. It is the
 * function's client-tag call site exactly as `consent-gate.ts`'s header describes it — gated on the
 * `berelax_consent` cookie, in the browser — and there is nothing here that reads a flag, a setting, an
 * environment variable or an attribute instead. In particular it **does not read `data-consent`**: that
 * attribute exists so the CSS can hide the banner before first paint, and a loader reading it would be a
 * second authority on consent, which is the defect A-MEAS-02 is shaped to prevent.
 *
 * The consequence worth stating: if the gate is ever wrong, it is wrong in one place, and the dispatch
 * writer and this loader are wrong together. That is the point. Two gates that agreed on the day they
 * were written and disagreed six months later is the failure that produces an outbound push for a visitor
 * who said no while the on-page tag correctly refuses.
 *
 * ## Why the catalogue is empty
 *
 * {@link CLIENT_TAGS} holds nothing. No GA4 measurement id, no container id and no pixel id has been
 * issued to this business, and no analytics host appears anywhere in this repository — `DECLARED_ADAPTERS`
 * in `scripts/check-egress-guard.mjs` is still empty and the egress guard refuses a module that names one.
 * A plausible-looking `G-XXXXXXX` here would be indistinguishable from a configured one (brief rule 15),
 * and a tag loader pointed at a container nobody owns is worse than none: it would load, it would fail
 * silently, and the dashboard would be "configured".
 *
 * So the MECHANISM is what this unit ships, and the tags are a PROP. `Y5-client-tags` in
 * `docs/OPEN-QUESTIONS.md` is where the missing ids are recorded, and filling them in is one edit to that
 * array. The fixture route `/tag-loader` passes a first-party tag, which is what makes the acceptance
 * line *"a tag that DOES load after a grant, and none before it"* assertable against something rather
 * than against an empty list (ADR 0003).
 *
 * ## Why the payload cannot carry a service name
 *
 * `conversions` is `readonly EgressPayload[]`, and `EgressPayload` is phantom-branded in
 * `packages/core/src/analytics/egress-guard.ts`: the only way to obtain one is `buildEgressPayload`, which
 * projects through A-MEAS-01's field allowlist and maps every service to an opaque category code. So "no
 * service name, no price string and no free text in `dataLayer`" is a TYPE and not a review: a plain
 * object cannot be passed here at all.
 */

/** Which of the gate's client-tag targets a tag is. The gate refuses a server destination's id. */
export type ClientTagTarget = 'analytics_tag' | 'advertising_tag'

export interface ClientTag {
  /** Stable, and the value of `data-tag` on the injected script, so a suite can name it. */
  readonly id: string
  readonly target: ClientTagTarget
  /** The script's URL. Absolute for a vendor, site-relative for the fixture. */
  readonly src: string
}

/**
 * Every tag this build loads: none.
 *
 * Empty, and the emptiness is the honest state rather than an omission — see the header. The TYPE is what
 * makes filling it in cheap and reviewable, and `tag-loader.test.ts` asserts it is empty so that the day
 * somebody adds one is the day the open question is answered in the same commit.
 */
export const CLIENT_TAGS: readonly ClientTag[] = []

/** The attribute the injected script carries, so the interception spec can name what it found. */
export const TAG_SCRIPT_ATTRIBUTE = 'data-tag'

/** The global the tag pushes into, and the event name a consent push carries. */
export const DATA_LAYER_NAME = 'dataLayer'
/*
 * `berelax_consent_state` and not `berelax_consent`, which was the first spelling and collided with
 * `ANALYTICS_CONSENT_COOKIE` — the cookie's own name. `tag-loader.test.ts` caught it: the case asserting
 * that the cookie's raw value never reaches the data layer could not distinguish the cookie's name from
 * this event's, so it failed against a module that was doing exactly the right thing. Two different
 * facts had one spelling.
 */
export const DATA_LAYER_CONSENT_EVENT = 'berelax_consent_state'
export const DATA_LAYER_CONVERSION_EVENT = 'berelax_conversion'

/**
 * How often, and for how long, the gate is re-asked after the page has loaded.
 *
 * A visitor who answers the banner has granted consent **in the same page session**, and the cookie that
 * carries it is set by the consent endpoint's own response — so at the moment the button is pressed there
 * is nothing for the gate to read yet. Something has to look again.
 *
 * It is a bounded poll of the ONE gate rather than a listener on the banner, and both halves of that are
 * deliberate. A listener would have to import the banner's attribute from the banner's module, which
 * would pull a server component and its stylesheet into this client chunk; and it would miss a grant
 * given in another tab, which sets the same cookie for this one. Fifteen seconds at half-second intervals
 * is thirty calls to a pure function reading `document.cookie` — and it stops the moment every tag is in,
 * which for the empty catalogue is immediately.
 */
export const GRANT_POLL_MS = 500
export const GRANT_POLL_WINDOW_MS = 15_000

/** What the loader needs of a browser. Injected, so the decision and the injection are both testable. */
export interface TagLoaderHost {
  /** The document's cookie string, or null. The gate's only input. */
  readonly cookie: () => string | null
  /** True once the tag is on the page. Called before every injection, so a re-ask cannot double-inject. */
  readonly loaded: (tag: ClientTag) => boolean
  /** Appends the script. Called at most once per tag. */
  readonly inject: (tag: ClientTag) => void
  /** Pushes one entry onto the data layer. */
  readonly push: (entry: Readonly<Record<string, unknown>>) => void
}

/** What one pass of the loader did, so a test can assert the sequence rather than the end state. */
export interface TagLoadPass {
  readonly injected: readonly string[]
  readonly refused: readonly string[]
}

/**
 * One pass: for every declared tag, ask the gate and inject what it permits.
 *
 * Pure in the sense that matters — every effect goes through {@link TagLoaderHost} — so the browser half
 * below has no decision in it. The order is the catalogue's, and the consent push happens BEFORE the
 * script is appended: a tag that read the data layer on its first line must find the consent state
 * already there, or it will have run for one tick in the default state, which for an advertising tag is
 * the tick that sets a cookie.
 */
export function loadPermittedTags(
  host: TagLoaderHost,
  tags: readonly ClientTag[],
  conversions: readonly EgressPayload[] = [],
): TagLoadPass {
  const injected: string[] = []
  const refused: string[] = []
  for (const tag of tags) {
    const decision = mayLoadClientTag(tag.target, host.cookie())
    if (!decision.permitted) {
      refused.push(tag.id)
      continue
    }
    if (host.loaded(tag)) continue
    // The signals the gate was satisfied by, and nothing else. Not the cookie's raw value: that is a
    // string this module did not parse, and putting it on the data layer would publish whatever a visitor
    // put in their own cookie jar to a third party.
    host.push({ event: DATA_LAYER_CONSENT_EVENT, target: tag.target, missing: decision.missing })
    for (const conversion of conversions) {
      // Spread, so the phantom brand — which is a type and not a property — cannot be looked for by a
      // tag, and so the entry is a plain object the data layer can serialise. Every field on it came
      // through A-MEAS-01's allowlist.
      host.push({ event: DATA_LAYER_CONVERSION_EVENT, ...conversion })
    }
    host.inject(tag)
    injected.push(tag.id)
  }
  return { injected, refused }
}

/** The browser's `TagLoaderHost`, built once per mount. */
function browserHost(): TagLoaderHost {
  return {
    cookie: () => {
      try {
        return document.cookie
      } catch {
        // A document with cookies blocked. The gate reads an absent cookie as a denial, which is the
        // correct degraded state: no consent is recorded, so nothing may load.
        return null
      }
    },
    loaded: (tag) => document.querySelector(`script[${TAG_SCRIPT_ATTRIBUTE}="${tag.id}"]`) !== null,
    inject: (tag) => {
      const script = document.createElement('script')
      script.async = true
      script.src = tag.src
      script.setAttribute(TAG_SCRIPT_ATTRIBUTE, tag.id)
      document.head.appendChild(script)
    },
    push: (entry) => {
      const holder = globalThis as unknown as Record<string, unknown[]>
      const layer = holder[DATA_LAYER_NAME]
      if (Array.isArray(layer)) layer.push(entry)
      else holder[DATA_LAYER_NAME] = [entry]
    },
  }
}

/**
 * The island. Renders nothing; injects after `load` and never before first paint.
 *
 * `load` and not `useEffect` alone: an effect runs after hydration, which on a fast connection is before
 * the largest contentful paint has settled, and a third-party script appended there competes with the
 * page's own resources for exactly the bandwidth the LCP needs. The acceptance line is *"never before
 * first paint"*, and after `load` is the strongest available form of it — there is no request to be in
 * any chain until the page has finished loading its own.
 */
export function TagLoader({
  tags = CLIENT_TAGS,
  conversions = [],
}: {
  readonly tags?: readonly ClientTag[]
  readonly conversions?: readonly EgressPayload[]
}) {
  useEffect(() => {
    if (tags.length === 0) return
    const host = browserHost()
    let timer: ReturnType<typeof setInterval> | null = null
    let deadline = 0

    const pass = (): void => {
      const result = loadPermittedTags(host, tags, conversions)
      if (result.refused.length === 0 && timer !== null) {
        clearInterval(timer)
        timer = null
      }
    }

    const start = (): void => {
      pass()
      deadline = Date.now() + GRANT_POLL_WINDOW_MS
      if (timer !== null) return
      timer = setInterval(() => {
        pass()
        if (Date.now() >= deadline && timer !== null) {
          clearInterval(timer)
          timer = null
        }
      }, GRANT_POLL_MS)
    }

    // Returning to the tab is the other moment a grant may have arrived — in another tab, against the
    // same cookie — and it re-arms the window rather than relying on the first one still being open.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') start()
    }

    if (document.readyState === 'complete') start()
    else window.addEventListener('load', start, { once: true })
    document.addEventListener('visibilitychange', onVisible, false)

    return () => {
      window.removeEventListener('load', start)
      document.removeEventListener('visibilitychange', onVisible, false)
      if (timer !== null) clearInterval(timer)
    }
  }, [tags, conversions])

  return null
}
