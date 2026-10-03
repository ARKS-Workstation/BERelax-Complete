import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildEgressPayload, CONSENT_GATED_TARGETS, consentGatedTargetsOn } from '@berelax/core'
import { ANALYTICS_CONSENT_COOKIE, CONSENT_SIGNAL_SEPARATOR } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a plain `.mjs` helper with a JSDoc signature and no declaration file. Imported
// rather than reimplemented: a second comment stripper in a test is a second set of edge cases, and the
// one in `scripts/lib` is the one every source-scanning gate in this repository already trusts.
import { stripNonCode } from '../../../scripts/lib/strip-non-code.mjs'
import {
  CLIENT_TAGS,
  type ClientTag,
  DATA_LAYER_CONSENT_EVENT,
  DATA_LAYER_CONVERSION_EVENT,
  loadPermittedTags,
  type TagLoaderHost,
} from '../app/(public)/_components/tag-loader.tsx'

/**
 * The tag loader's one decision, which is that it has none (A-MEAS-04).
 *
 * ## What this file asserts, and what the browser suite asserts instead
 *
 * Here: the gate is the ONLY thing consulted, the payload cannot carry a name, and the module's own text
 * contains none of the things a second consent authority would need. All of it is a pure call of
 * `loadPermittedTags` against a host whose cookie this file supplies, so every case is a cookie in and an
 * injection or a refusal out.
 *
 * In `tags-and-vitals.itest.ts`: that a real browser agrees — no request to the tag before a grant, a
 * request after one in the same page session, and nothing in `dataLayer` but category codes. A string
 * comparison cannot tell a module that calls the gate from one that calls the gate and then also reads an
 * attribute, which is why the scan below is paired with a browser.
 *
 * ## The scan, and why it is a scan
 *
 * ADR 0076's rule is that `gateConsent` is the one statement. A test can assert the loader's ANSWERS
 * agree with the gate for every input it has, and that is still satisfied by a loader that agrees today
 * and reads `data-consent` as a shortcut tomorrow. So the module's source is read and asserted to contain
 * no second authority: no `data-consent`, no `process.env`, no setting key, no second gate. That is the
 * same mechanism `consent-gate-arch.test.ts` applies to the gate's own estate, applied to its call site.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const LOADER = join(HERE, '..', 'app', '(public)', '_components', 'tag-loader.tsx')
const SOURCE = readFileSync(LOADER, 'utf8')

/**
 * The loader's source with its comments blanked, for the forbidden-construct scan below.
 *
 * `stripNonCode` is `scripts/lib/strip-non-code.mjs`, the helper every source-scanning gate in this
 * repository uses, and its own header records why: *"a rule explained in its own doc comment must not be
 * reported as a violation of itself"*. It is not a hypothetical here either — the first version of the
 * scan below flagged `data-consent` in the sentence explaining why `data-consent` must never be read.
 * Blanking preserves length and newlines, so a reported position still points at the file.
 */
const CODE = stripNonCode(SOURCE)

const FIXTURE: ClientTag = { id: 'fixture', target: 'analytics_tag', src: '/_fixture/tag.js' }
const ADVERTISING: ClientTag = { id: 'ads', target: 'advertising_tag', src: '/_fixture/ads.js' }

/** A cookie carrying exactly these signals, spelled the way the consent endpoint spells it. */
const cookieWith = (...signals: readonly string[]): string =>
  `${ANALYTICS_CONSENT_COOKIE}=${signals.join(CONSENT_SIGNAL_SEPARATOR)}`

interface Recorded {
  readonly host: TagLoaderHost
  readonly injected: string[]
  readonly pushed: Readonly<Record<string, unknown>>[]
}

function recordingHost(cookie: string | null): Recorded {
  const injected: string[] = []
  const pushed: Readonly<Record<string, unknown>>[] = []
  return {
    injected,
    pushed,
    host: {
      cookie: () => cookie,
      loaded: (tag) => injected.includes(tag.id),
      inject: (tag) => {
        injected.push(tag.id)
      },
      push: (entry) => {
        pushed.push(entry)
      },
    },
  }
}

describe('nothing loads without the signal the gate requires', () => {
  it('refuses every tag when there is no cookie at all', () => {
    const recorded = recordingHost(null)
    const pass = loadPermittedTags(recorded.host, [FIXTURE, ADVERTISING])
    expect(pass.injected).toEqual([])
    expect(pass.refused).toEqual(['fixture', 'ads'])
    expect(recorded.pushed).toEqual([])
  })

  it('refuses every tag under an explicit denial', () => {
    // The endpoint writes a cookie carrying no signals for a denial, which is a different fact from no
    // cookie and must reach the same answer.
    const recorded = recordingHost(cookieWith())
    expect(loadPermittedTags(recorded.host, [FIXTURE, ADVERTISING]).injected).toEqual([])
  })

  it('refuses an unreadable cookie rather than treating it as a grant', () => {
    for (const cookie of ['', 'berelax_consent', 'berelax_consent=', 'nonsense', '=;;=']) {
      const recorded = recordingHost(cookie)
      expect(loadPermittedTags(recorded.host, [FIXTURE]).injected, cookie).toEqual([])
    }
  })

  it('refuses the advertising tag under an analytics-only grant', () => {
    // The whole value of the gate's table: `advertising_tag` needs ad_storage AND ad_user_data, and the
    // weaker grant is the one a visitor who read the banner carefully gave.
    const recorded = recordingHost(cookieWith('analytics_storage'))
    const pass = loadPermittedTags(recorded.host, [FIXTURE, ADVERTISING])
    expect(pass.injected).toEqual(['fixture'])
    expect(pass.refused).toEqual(['ads'])
  })
})

describe('a tag loads once the gate permits it', () => {
  it('injects it, and pushes the consent state before the script', () => {
    const recorded = recordingHost(cookieWith('analytics_storage'))
    const pass = loadPermittedTags(recorded.host, [FIXTURE])
    expect(pass.injected).toEqual(['fixture'])
    // The push happens before the injection, because a tag that reads the data layer on its first line
    // must find the consent state already there.
    expect(recorded.pushed[0]).toEqual({
      event: DATA_LAYER_CONSENT_EVENT,
      target: 'analytics_tag',
      missing: [],
    })
  })

  it('does not inject twice, however many times the gate is re-asked', () => {
    // The loader re-asks the gate on a bounded poll, because a grant given in the same page session is
    // recorded by the endpoint's response and is not in the cookie at the moment the button is pressed.
    // Re-asking must not re-inject.
    const recorded = recordingHost(cookieWith('analytics_storage'))
    for (let pass = 0; pass < 5; pass += 1) loadPermittedTags(recorded.host, [FIXTURE])
    expect(recorded.injected).toEqual(['fixture'])
    expect(recorded.pushed).toHaveLength(1)
  })

  it('injects nothing for the empty catalogue, which is what this build ships', () => {
    // `CLIENT_TAGS` is empty: no measurement id, container id or pixel id has been issued and no
    // analytics host appears anywhere in this repository (Y5-client-tags). Asserted, so the day somebody
    // adds one is the day this test is edited and the open question is answered in the same commit.
    expect(CLIENT_TAGS).toEqual([])
    const recorded = recordingHost(cookieWith('analytics_storage', 'ad_storage', 'ad_user_data'))
    expect(loadPermittedTags(recorded.host, CLIENT_TAGS).injected).toEqual([])
  })

  it('covers exactly the gate’s client-tag surface and nothing on the server surface', () => {
    // A loader handed a server destination's id would be gated on `ad_user_data` alone and would inject
    // an advertising tag for a visitor who granted that and refused `ad_storage`. The gate refuses it;
    // this is the assertion that the two tag targets this module declares are the two the gate calls
    // client tags, so neither list can grow without the other.
    expect([...consentGatedTargetsOn('client_tag')].toSorted()).toEqual(
      ['advertising_tag', 'analytics_tag'].toSorted(),
    )
    const server = Object.entries(CONSENT_GATED_TARGETS)
      .filter(([, target]) => target.surface === 'server_dispatch')
      .map(([id]) => id)
    expect(server.length).toBeGreaterThan(0)
    for (const id of server) {
      const recorded = recordingHost(cookieWith('analytics_storage', 'ad_storage', 'ad_user_data'))
      // Cast at the call site only: the TYPE already refuses this, and the runtime refusal is what the
      // gate contributes for an id that arrived as data.
      const pass = loadPermittedTags(recorded.host, [
        { id, target: id as 'analytics_tag', src: '/x.js' },
      ])
      expect(pass.injected, id).toEqual([])
    }
  })
})

describe('the data layer cannot carry a name, a price or any free text', () => {
  it('pushes only the fields A-MEAS-01’s guard projects', () => {
    const { payload } = buildEgressPayload({
      ref: { kind: 'package_template' },
      eventType: 'paid',
      quantity: 1,
      valueFils: 26_250,
    })
    const recorded = recordingHost(cookieWith('analytics_storage'))
    loadPermittedTags(recorded.host, [FIXTURE], [payload])
    const conversion = recorded.pushed.find(
      (entry) => entry['event'] === DATA_LAYER_CONVERSION_EVENT,
    )
    expect(conversion).toBeDefined()
    expect(Object.keys(conversion ?? {}).toSorted()).toEqual(
      ['categoryCode', 'currency', 'event', 'eventType', 'quantity', 'valueFils'].toSorted(),
    )
    // No name, and not because this test looked for one: the guard takes a catalogue REF and has no
    // parameter a name could arrive in.
    expect(JSON.stringify(conversion)).not.toMatch(/massage|deep|tissue|aroma/i)
  })

  it('never pushes the cookie’s raw value, which is a string the loader did not parse', () => {
    const cookie = `${cookieWith('analytics_storage')}; be_junk=whatever-a-visitor-put-here`
    const recorded = recordingHost(cookie)
    loadPermittedTags(recorded.host, [FIXTURE])
    const pushed = JSON.stringify(recorded.pushed)
    expect(pushed).not.toContain('whatever-a-visitor-put-here')
    expect(pushed).not.toContain(cookie)
    /*
      A `name=value` pair of any kind, which is the general form of the leak.

      The first version of this case asserted the pushed JSON did not contain
      `ANALYTICS_CONSENT_COOKIE`, and it failed against a module doing exactly the right thing: the data
      layer's own event name is `berelax_consent_state`, which has the cookie's name as a substring. A
      substring test over a name is not the claim — the claim is that no cookie PAIR travels — so the
      assertion is about the shape and the event name is asserted whole, below.
    */
    expect(pushed).not.toMatch(/[a-z_]+=[^"]/)
    expect(recorded.pushed[0]?.['event']).toBe(DATA_LAYER_CONSENT_EVENT)
  })
})

describe('there is no second consent authority in this module (ADR 0076)', () => {
  it('calls the one gate and nothing that could answer the same question', () => {
    expect(CODE).toContain('mayLoadClientTag')
    for (const forbidden of [
      // The banner's attribute. It exists so the CSS can hide the banner before first paint, and a loader
      // reading it would be a second authority on consent.
      'data-consent',
      'getAttribute',
      'documentElement',
      // Configuration. `consent-gate-arch.test.ts` asserts no setting key and no environment variable can
      // reach the gate's estate; a call site that read one would route round that.
      'process.env',
      'loadConfig',
      'readSetting',
      // A second decision, written out.
      'granted',
      'consentStateFrom',
      'gateConsent(',
    ]) {
      expect(CODE, `the tag loader names ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('names no analytics destination host, which the egress guard refuses outside an adapter', () => {
    for (const host of ['googletagmanager', 'google-analytics', 'facebook', 'connect.facebook']) {
      expect(CODE.toLowerCase(), `the tag loader names ${host}`).not.toContain(host)
    }
    // The control: the scan is over a file with content in it, so the absences above are about something
    // — and over CODE rather than prose, so blanking the comments did not blank the module.
    expect(CODE.length).toBeGreaterThan(2000)
    expect(CODE).toContain('export function loadPermittedTags')
  })

  it('imports the type from the barrel on its own statement, which is what keeps it out of the chunk', () => {
    // A type imported on the same line as a value drags the whole package into the client chunk — the
    // defect that cost A-FIRST-06 98KB. `import type` is erased, so this is a claim about bytes.
    expect(SOURCE).toContain("import type { EgressPayload } from '@berelax/core'")
    expect(SOURCE).toContain("from '@berelax/core/analytics/consent-gate'")
    // And the barrel is never a VALUE import here, which is the thing that would undo it.
    expect(SOURCE).not.toMatch(/^import \{[^}]*\} from '@berelax\/core'$/m)
  })
})
