import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_PATH,
  CONSENT_MODE_SIGNALS,
  grantedConsentSignals,
} from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CONSENT_ANSWER_ATTRIBUTE,
  CONSENT_BANNER_ID,
  CONSENT_NO_SIGNALS_TOKEN,
  CONSENT_STATE_ATTRIBUTE,
  consentBootstrapScript,
} from '../app/(public)/_components/consent-banner.tsx'

/**
 * The consent banner's inline bootstrap, held against the shared cookie parse (A-MEAS-02).
 *
 * ## Why this file exists at all
 *
 * A blocking inline script cannot import a module, so it carries a second parse of a format
 * `cookieValue` in `@berelax/shared` already parses. A second statement of a fact drifts, and the drift
 * here is not visible: the two would disagree only on the inputs nobody writes down — a cookie called
 * `berelax_consent_version`, a value that is only whitespace, a name that is a suffix of another — and
 * the symptom would be a banner that reappears for somebody who answered it, or worse, one that stays
 * hidden for somebody who did not.
 *
 * So the script is RUN here, in a context with a fabricated `document`, and what it extracts is compared
 * with what the shared parse reads from the same bytes. That is the check the convention asks for in the
 * same commit as the duplication.
 *
 * ## Why apps/web is the only place it can live
 *
 * The script is `apps/web`'s and the parse is `@berelax/shared`'s. `packages/*` may not import an app
 * (`nothing-imports-an-app`), so the equality can only be asserted from here — the same arrangement
 * `breakpoint-capture.test.ts` records for the breakpoint bands.
 *
 * ## What the script does NOT decide, asserted
 *
 * It never answers "may a tag load". That is `mayLoadClientTag`, over the cookie, in
 * `packages/core/src/analytics/consent-gate.ts` — one gate asked in one place. The last case here is the
 * assertion that this script names no vendor, no host and no gate decision of its own.
 */

/** What one run of the script observed. */
interface Run {
  /** The value the script set on `<html>`, or null when it set nothing. */
  readonly attribute: string | null
  /** The click listener it registered, if any. */
  readonly listener: ((event: unknown) => void) | null
  readonly posts: { readonly url: string; readonly body: unknown; readonly keepalive: boolean }[]
}

/**
 * Runs the real script string against a fabricated document.
 *
 * `new Function` with the globals the script touches passed in as parameters, so nothing here depends on
 * a DOM implementation and the test runs in the `node` environment the unit suite uses. The script is the
 * production string — not a re-typed copy — which is the whole point: a re-typed copy would be a THIRD
 * statement of the parse.
 */
function runScript(cookie: string, options: { readonly ok?: boolean } = {}): Run {
  const attributes = new Map<string, string>()
  const posts: Run['posts'] = []
  let listener: ((event: unknown) => void) | null = null
  const document = {
    cookie,
    documentElement: {
      lang: 'en',
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value)
      },
    },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      if (type === 'click') listener = handler
    },
  }
  const fetchStub = (url: string, init: { body: string; keepalive?: boolean }) => {
    posts.push({
      url,
      body: JSON.parse(init.body),
      keepalive: init.keepalive === true,
    })
    return Promise.resolve({ ok: options.ok !== false })
  }
  // The subject under test IS a script string, and running the real one is the only way to prove the bootstrap behaves. `new Function` rather than `eval`, and the suppression that named `noGlobalEval` was removed at the P-HR-14 merge: biome does not raise that rule here, and an unused suppression is itself an error.
  new Function('document', 'fetch', consentBootstrapScript())(document, fetchStub)
  return {
    // Getters, not values. The listener fires AFTER this function has returned — that is what a delegated
    // click handler is — so a snapshot taken here is always empty, and the first version of this helper
    // took one: the grant case reported zero posts for a script that had posted correctly. Reading
    // through a getter means the assertions see what the script did rather than what it had done by the
    // time it was installed.
    get attribute() {
      return attributes.get(CONSENT_STATE_ATTRIBUTE) ?? null
    },
    listener,
    posts,
  }
}

describe('the bootstrap extracts the same cookie the shared parse reads', () => {
  it('agrees with grantedConsentSignals on every generated cookie string', () => {
    const RUNS = 400
    let set = 0
    let unset = 0
    /*
     * The pieces a real `document.cookie` is made of, weighted towards the ones that could disagree.
     *
     * Brief rule 22: a generator of random junk would almost never produce the consent cookie at all, so
     * the property would hold for a script that read nothing. The name is drawn from a small set that
     * includes the real one, a PREFIX collision (`berelax_consent_version`) and a SUFFIX one
     * (`x_berelax_consent`), which are the two shapes an `includes` or a `startsWith` gets wrong.
     */
    const name = fc.constantFrom(
      ANALYTICS_CONSENT_COOKIE,
      `${ANALYTICS_CONSENT_COOKIE}_version`,
      `x_${ANALYTICS_CONSENT_COOKIE}`,
      'berelax_visitor',
      'berelax_admin',
    )
    const value = fc.constantFrom(
      '',
      ' ',
      CONSENT_NO_SIGNALS_TOKEN,
      'analytics_storage',
      'ad_storage,ad_user_data',
      [...CONSENT_MODE_SIGNALS].join(','),
      'analytics_storage_denied',
      'ANALYTICS_STORAGE',
      'a'.repeat(50),
    )
    fc.assert(
      fc.property(
        fc.array(fc.tuple(name, value), { minLength: 0, maxLength: 4 }),
        fc.boolean(),
        (pairs, spaced) => {
          const header = pairs.map(([n, v]) => `${n}=${v}`).join(spaced ? '; ' : ';')
          const run = runScript(header)
          if (run.attribute === null) unset += 1
          else set += 1
          const fromScript = grantedConsentSignals(
            run.attribute === null ? null : `${ANALYTICS_CONSENT_COOKIE}=${run.attribute}`,
          )
          const fromShared = grantedConsentSignals(header)
          // The two parses see the same cookie, so they grant the same signals. This is the equality the
          // duplication is only acceptable with.
          return (
            fromScript.size === fromShared.size &&
            [...fromShared].every((signal) => fromScript.has(signal))
          )
        },
      ),
      { numRuns: RUNS },
    )
    /*
     * Both outcomes occurred.
     *
     * Without this the property is satisfied by a script that never sets the attribute at all — every
     * comparison would then be `empty === empty` and the file would prove nothing. Five consecutive runs
     * MEASURED 95, 92, 93, 99 and 90 of 400 with the attribute set (22.5% to 24.8%), the rest without;
     * the floor is RUNS/8 — 50, a little over half the lowest observed — because a floor just under the
     * minimum becomes its own flake, and both sides get the same floor so neither outcome can vanish.
     */
    expect(set, 'the script never saw a consent cookie, so nothing was compared').toBeGreaterThan(
      RUNS / 8,
    )
    expect(
      unset,
      'the script set the attribute for every input, including the empty one',
    ).toBeGreaterThan(RUNS / 8)
  }, 30_000)

  it('sets nothing for no cookie, an empty value, or a lookalike name', () => {
    expect(runScript('').attribute).toBeNull()
    expect(runScript(`${ANALYTICS_CONSENT_COOKIE}=`).attribute).toBeNull()
    expect(runScript(`${ANALYTICS_CONSENT_COOKIE}=   `).attribute).toBeNull()
    // Compared by EQUALITY and never by prefix. `berelax_consent_version` read as this cookie would hide
    // the banner from somebody who has answered nothing.
    expect(runScript(`${ANALYTICS_CONSENT_COOKIE}_version=2`).attribute).toBeNull()
    // The control: it DOES see the real one, so the four above are about rejection.
    expect(runScript(`${ANALYTICS_CONSENT_COOKIE}=analytics_storage`).attribute).toBe(
      'analytics_storage',
    )
  })

  it('treats a decision that grants nothing as a decision, which the gate does not', () => {
    // The whole reason the no-signals token exists. The banner must not reappear for somebody who
    // pressed "no"; the gate must grant them nothing. One cookie, two readers, two different questions.
    const run = runScript(`${ANALYTICS_CONSENT_COOKIE}=${CONSENT_NO_SIGNALS_TOKEN}`)
    expect(run.attribute).toBe(CONSENT_NO_SIGNALS_TOKEN)
    expect(
      grantedConsentSignals(`${ANALYTICS_CONSENT_COOKIE}=${CONSENT_NO_SIGNALS_TOKEN}`).size,
    ).toBe(0)
  })
})

describe('the bootstrap posts the decision it was asked for', () => {
  const click = (answer: string | null) => ({
    target: {
      closest: (selector: string) =>
        selector === `[${CONSENT_ANSWER_ATTRIBUTE}]` && answer !== null
          ? { getAttribute: () => answer }
          : null,
    },
  })

  it('posts every signal for a grant and none for a denial', async () => {
    const granted = runScript('')
    granted.listener?.(click('granted'))
    await Promise.resolve()
    expect(granted.posts).toHaveLength(1)
    expect(granted.posts[0]?.url).toBe(ANALYTICS_CONSENT_PATH)
    expect(granted.posts[0]?.keepalive, 'a navigation would cancel a non-keepalive post').toBe(true)
    expect(granted.posts[0]?.body).toEqual({
      decision: 'granted',
      granted: [...CONSENT_MODE_SIGNALS],
      locale: 'en',
      surface: 'consent_banner',
    })

    const denied = runScript('')
    denied.listener?.(click('denied'))
    await Promise.resolve()
    expect(denied.posts[0]?.body).toEqual({
      decision: 'denied',
      granted: [],
      locale: 'en',
      surface: 'consent_banner',
    })
  })

  it('posts nothing for a click that is not on an answer control', () => {
    const run = runScript('')
    run.listener?.(click(null))
    expect(run.posts).toEqual([])
  })

  it('leaves the banner up when the write fails, which keeps the gate closed', async () => {
    /*
     * The degraded state has to be the safe one. If the POST fails there is no record and no cookie, so
     * the attribute must NOT be set: the banner stays, the visitor is asked again, and
     * `mayLoadClientTag` goes on refusing. An optimistic attribute would hide the banner while nothing
     * had been recorded, which is the one outcome worse than asking twice.
     */
    const run = runScript('', { ok: false })
    run.listener?.(click('granted'))
    await Promise.resolve()
    await Promise.resolve()
    expect(run.attribute).toBeNull()
  })
})

describe('the bootstrap decides nothing about a vendor', () => {
  it('names no destination host and no vendor, anywhere in the emitted string', () => {
    /*
     * The script ships on every public page, which makes it the last place a destination host should
     * appear — and `scripts/check-egress-guard.mjs` rule 6 refuses one in any module outside a declared
     * adapter, so this is the runtime half of a check that already covers the source.
     *
     * Assembled from parts rather than written out, which is the arrangement that scanner uses on its own
     * host list and for the same reason: a literal destination has no business being greppable as a
     * working endpoint in a repository whose whole claim is that nothing posts to one.
     */
    const script = consentBootstrapScript()
    for (const parts of [
      ['google', '-', 'analytics', '.', 'com'],
      ['googletagmanager', '.', 'com'],
      ['connect', '.', 'facebook', '.', 'net'],
      ['facebook', '.', 'com'],
      ['gtag'],
      ['dataLayer'],
      ['fbq'],
    ]) {
      expect(script.toLowerCase(), `the bootstrap names ${parts.join('')}`).not.toContain(
        parts.join('').toLowerCase(),
      )
    }
    // The control: the pattern DOES catch what it looks for, so a clean result means a clean script
    // rather than a comparison that stopped matching.
    expect('https://www.googletagmanager.com/gtm.js'.includes('googletagmanager.com')).toBe(true)
  })

  it('posts to one path and reads one cookie, both from the shared constants', () => {
    const script = consentBootstrapScript()
    expect(script).toContain(JSON.stringify(ANALYTICS_CONSENT_PATH))
    expect(script).toContain(JSON.stringify(ANALYTICS_CONSENT_COOKIE))
    expect(script).toContain(JSON.stringify(CONSENT_STATE_ATTRIBUTE))
    // Small enough to be inline before paint. The shared-layout client-JS budget is 4096 bytes and this
    // is not a module at all, so it is outside that budget — which is exactly why it must stay small
    // rather than grow into one.
    expect(script.length, 'an inline blocking script this size belongs in a module').toBeLessThan(
      2_048,
    )
    // And the banner it governs is named once, so the CSS, the script and the suite agree.
    expect(CONSENT_BANNER_ID).toBe('be-consent')
  })
})
