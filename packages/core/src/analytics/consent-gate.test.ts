import { CONSENT_MODE_SIGNALS, type ConsentModeSignal } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  type AnalyticsConsentState,
  CONSENT_GATE_SURFACES,
  CONSENT_GATED_TARGET_IDS,
  consentGatedTarget,
  consentGatedTargetsOn,
  consentStateFromClaimedSignals,
  consentStateFromSessionRow,
  DISPATCH_SUPPRESSION_REASONS,
  deniedAnalyticsConsentState,
  gateConsent,
  mayLoadClientTag,
  SESSION_CONSENT_COLUMNS,
} from './consent-gate.ts'

/**
 * The consent gate (A-MEAS-02), and the two things a gate has to be shown about itself.
 *
 * ## 1. It must not open by accident, in any of the four ways it could
 *
 * An absent record, an unreadable record, a record whose signal names nobody defined, and a boolean
 * column that arrived as a string. Each of those is a shape some real driver, some real JSON and some
 * real fixture produces, and each of them would be a SILENT grant: nothing errors, the tag loads, the
 * push goes out, and the only evidence is in somebody else's ad account. So they are cases, not a
 * paragraph — including the one that reads as paranoia, `'f'`, which is what a boolean column reads back
 * as under one of the query shapes in this stack and which is truthy.
 *
 * ## 2. It must be MONOTONE, which is the property a case cannot show
 *
 * Granting a signal can never turn a permitted target into a refused one, and denying one can never turn
 * a refused target into a permitted one. That is the claim an inverted comparison breaks, and the reason
 * it has to be a property rather than a table is that a table of expected answers is the implementation
 * written twice: the same mistake in both columns reads as agreement. A property over the ORDER relation
 * between two states tests something no row of a table states.
 *
 * Brief rule 22 is why the property counts its own cases. A generator that drew two independent random
 * subsets would almost never produce a PAIR that disagrees — most pairs are both refused — so the
 * property would hold for a completely inverted gate while examining nothing. The generator therefore
 * builds the second state by adding exactly one signal to the first, and weights the first towards "one
 * signal short of this target's requirement", which is the only shape in which adding one flips the
 * answer. The share of flipping cases is MEASURED and asserted against a floor, and both outcomes are
 * asserted to have occurred.
 */

const stateOf = (...signals: ConsentModeSignal[]): AnalyticsConsentState => new Set(signals)

/** Every target id, as a tuple for `fc.constantFrom`, read out of the table rather than written again. */
const TARGET_IDS = CONSENT_GATED_TARGET_IDS as readonly [string, ...string[]]

describe('the table of gated targets', () => {
  it('requires at least one signal of every target, which is the fail-closed shape', () => {
    // A target requiring nothing would be permitted by the empty state — a visitor who pressed "no".
    for (const id of CONSENT_GATED_TARGET_IDS) {
      expect(consentGatedTarget(id)?.requires.length, id).toBeGreaterThan(0)
    }
    // The control: the enumeration is not empty. Every assertion above holds for a table of nothing,
    // which is ADR 0002's subject and how `pnpm boundaries` once reported success over zero modules.
    expect(CONSENT_GATED_TARGET_IDS.length).toBeGreaterThan(3)
  })

  it('names only real Consent Mode v2 signals, so nothing here is an invented one', () => {
    for (const id of CONSENT_GATED_TARGET_IDS) {
      for (const signal of consentGatedTarget(id)?.requires ?? []) {
        expect(CONSENT_MODE_SIGNALS as readonly string[], `${id} requires ${signal}`).toContain(
          signal,
        )
      }
    }
    // And the vocabulary is Google's four, in Consent Mode's own order. A fifth name added here would be
    // a signal this build made up, which no outbound tag would be keyed on.
    expect([...CONSENT_MODE_SIGNALS]).toEqual([
      'ad_storage',
      'ad_user_data',
      'ad_personalization',
      'analytics_storage',
    ])
  })

  it('covers both surfaces, because a gate for one of them is half a gate', () => {
    for (const surface of CONSENT_GATE_SURFACES) {
      expect(consentGatedTargetsOn(surface).length, surface).toBeGreaterThan(0)
    }
    // The partition is total: every target is on one of the two surfaces and none is on neither.
    expect(
      CONSENT_GATE_SURFACES.flatMap((surface) => consentGatedTargetsOn(surface)).toSorted(),
    ).toEqual([...CONSENT_GATED_TARGET_IDS].toSorted())
  })

  it('maps every signal to a session column, totally', () => {
    // A missing entry would make `consentStateFromSessionRow` read that signal as denied for ever, so
    // every dispatch needing it would be suppressed while every test about suppression still passed.
    for (const signal of CONSENT_MODE_SIGNALS) {
      expect(SESSION_CONSENT_COLUMNS[signal], signal).toMatch(/^consent_[a-z_]+$/)
    }
    // Injective: two signals sharing a column would make one of them unreadable.
    expect(new Set(Object.values(SESSION_CONSENT_COLUMNS)).size).toBe(CONSENT_MODE_SIGNALS.length)
  })
})

describe('the state resolvers, every one of which fails closed', () => {
  it('grants nothing for an absent, empty or unreadable record', () => {
    for (const absent of [null, undefined, '', 'granted', 0, 1, true, Number.NaN, {}, []]) {
      expect([...consentStateFromClaimedSignals(absent)], String(absent)).toEqual([])
      expect([...consentStateFromSessionRow(absent)], String(absent)).toEqual([])
    }
    expect([...deniedAnalyticsConsentState()]).toEqual([])
  })

  it('discards a signal name nobody defined rather than reading it as a grant', () => {
    // `analytics_storage_denied` is the shape `grantedConsentSignals` already refuses one package over: a
    // substring test would read it as granting `analytics_storage`, which is the opposite of what it says.
    expect([
      ...consentStateFromClaimedSignals([
        'analytics_storage_denied',
        'AD_STORAGE',
        'ad storage',
        '',
        null,
        42,
      ]),
    ]).toEqual([])
    // And it keeps the ones that ARE signals, so the case above is about rejection and not about a
    // resolver that returns nothing whatever it is given.
    expect([...consentStateFromClaimedSignals(['ad_storage', 'nonsense'])]).toEqual(['ad_storage'])
  })

  it('reads ONLY the boolean true from a session row, never a truthy string', () => {
    const column = SESSION_CONSENT_COLUMNS.ad_user_data
    // The dangerous half: `'f'` is a non-empty string and therefore truthy, and it is what a boolean
    // column reads back as under one of the query shapes in this stack. A truthiness test would read a
    // FALSE column as consent.
    for (const falsey of ['f', 'false', 'FALSE', '0', 0, 1, 'true', 't', null, undefined]) {
      expect([...consentStateFromSessionRow({ [column]: falsey })], String(falsey)).toEqual([])
    }
    // And the control: the one value that does grant it.
    expect([...consentStateFromSessionRow({ [column]: true })]).toEqual(['ad_user_data'])
  })
})

describe('the gate', () => {
  it('permits a target exactly when every required signal is present', () => {
    const advertising = consentGatedTarget('advertising_tag')
    const required = advertising?.requires ?? []
    expect([...required].toSorted()).toEqual(['ad_storage', 'ad_user_data'])
    // Both: permitted. `?? []` rather than a non-null assertion, which biome refuses — and it is the
    // better spelling anyway: a missing entry makes the assertion above fail by name instead of making
    // this one throw a TypeError three lines later.
    expect(gateConsent({ target: 'advertising_tag', state: stateOf(...required) })).toMatchObject({
      permitted: true,
      missing: [],
      reason: null,
    })
    // One of the two: refused, and the refusal NAMES the one that is missing — `every`, not `some`,
    // because a target needing either of two signals is permitted by the weaker grant, and the weaker
    // grant is the one a visitor who read the banner carefully gave.
    expect(gateConsent({ target: 'advertising_tag', state: stateOf('ad_storage') })).toMatchObject({
      permitted: false,
      missing: ['ad_user_data'],
      reason: 'consent_denied',
    })
  })

  it('refuses a target the table does not name, with every signal reported missing', () => {
    // The fail-open an id typo would reach: an unknown target has nothing to require, so a gate that
    // folded `requires ?? []` into `every` would permit it. A typo is exactly how a new destination
    // arrives.
    const decision = gateConsent({ target: 'ga4', state: stateOf(...CONSENT_MODE_SIGNALS) })
    expect(decision.permitted).toBe(false)
    expect(decision.missing).toEqual([...CONSENT_MODE_SIGNALS].toSorted())
    expect(decision.reason).toBe('consent_denied')
  })

  it('keeps `missing` empty exactly when permitted, for every target and every state', () => {
    // The invariant, not a description. It is what makes `missing.length === 0` — the branch a caller
    // writes instead of reading `permitted` — safe, and it is the thing this gate got wrong first: an
    // unknown target under a full grant came back `{ permitted: false, missing: [] }`.
    let seenPermitted = 0
    let seenRefused = 0
    for (const target of [...CONSENT_GATED_TARGET_IDS, 'ga4', '', 'analytics_tag ']) {
      for (const state of [
        stateOf(),
        stateOf('analytics_storage'),
        stateOf('ad_storage'),
        stateOf('ad_storage', 'ad_user_data'),
        stateOf(...CONSENT_MODE_SIGNALS),
      ]) {
        const decision = gateConsent({ target, state })
        expect(decision.missing.length === 0, `${target} / ${[...state].join('+')}`).toBe(
          decision.permitted,
        )
        if (decision.permitted) seenPermitted += 1
        else seenRefused += 1
      }
    }
    // Both outcomes occurred, so the loop is not satisfied by a gate that always refuses.
    expect(seenPermitted).toBeGreaterThan(0)
    expect(seenRefused).toBeGreaterThan(0)
  })

  it('names its refusal with the value a suppression row records', () => {
    // The reason is not prose: `analytics_dispatch.reason` is CHECKed against these two values, so a
    // third spelling here would be a row the database refuses.
    const refused = gateConsent({ target: 'advertising_conversion_push', state: stateOf() })
    expect(DISPATCH_SUPPRESSION_REASONS as readonly string[]).toContain(refused.reason)
    expect(refused.reason).toBe('consent_denied')
  })
})

describe('the client-tag composition', () => {
  const COOKIE = 'berelax_consent'

  it('loads a tag only when the cookie grants what it needs', () => {
    expect(mayLoadClientTag('analytics_tag', `${COOKIE}=analytics_storage`).permitted).toBe(true)
    expect(mayLoadClientTag('advertising_tag', `${COOKIE}=analytics_storage`).permitted).toBe(false)
    expect(mayLoadClientTag('advertising_tag', `${COOKIE}=ad_storage,ad_user_data`).permitted).toBe(
      true,
    )
  })

  it('refuses every tag for an absent, empty or no-signals cookie', () => {
    for (const header of [null, '', `${COOKIE}=`, `${COOKIE}=none`, 'other=1']) {
      for (const target of consentGatedTargetsOn('client_tag')) {
        expect(mayLoadClientTag(target, header).permitted, `${target} / ${header}`).toBe(false)
      }
    }
    // The control: the same targets DO load for a full grant, so the loop above is about the cookie and
    // not about a composition that refuses everything.
    for (const target of consentGatedTargetsOn('client_tag')) {
      expect(
        mayLoadClientTag(target, `${COOKIE}=${[...CONSENT_MODE_SIGNALS].join(',')}`).permitted,
        target,
      ).toBe(true)
    }
  })

  it('refuses a SERVER destination asked for as a client tag', () => {
    // Not pedantry: `advertising_conversion_push` requires `ad_user_data` alone, so a loader that passed
    // its id would inject an advertising tag for a visitor who granted that and refused `ad_storage`.
    const decision = mayLoadClientTag(
      'advertising_conversion_push',
      `${COOKIE}=${[...CONSENT_MODE_SIGNALS].join(',')}`,
    )
    expect(decision.permitted).toBe(false)
    expect(decision.missing).toEqual([...CONSENT_MODE_SIGNALS].toSorted())
  })

  it('reads the cookie by EQUALITY on the name, never by prefix', () => {
    // `berelax_consent_version` must not be read as the consent cookie. Inherited from
    // `grantedConsentSignals`, asserted here because this is the composition a tag loader calls.
    expect(mayLoadClientTag('analytics_tag', `${COOKIE}_version=analytics_storage`).permitted).toBe(
      false,
    )
  })
})

describe('the gate is monotone in the consent state', () => {
  /**
   * A state that is one signal short of what `target` needs, for the half of the generator that can
   * flip. Which signal is withheld is drawn, so the property is not about one of them.
   */
  const oneShort = (target: string, withhold: number): AnalyticsConsentState => {
    const required = consentGatedTarget(target)?.requires ?? CONSENT_MODE_SIGNALS
    const dropped = required[withhold % required.length]
    return new Set(CONSENT_MODE_SIGNALS.filter((signal) => signal !== dropped))
  }

  it('never refuses more when a signal is ADDED, and the flipping cases are counted', () => {
    const RUNS = 600
    let flipped = 0
    let unchanged = 0
    fc.assert(
      fc.property(
        fc.constantFrom(...TARGET_IDS),
        fc.subarray([...CONSENT_MODE_SIGNALS]),
        fc.constantFrom(...CONSENT_MODE_SIGNALS),
        fc.nat(),
        fc.boolean(),
        (target, drawn, added, withhold, nearMiss) => {
          // Weighted towards states that CAN disagree. Two independent subsets would leave the expected
          // number of flipping pairs near zero, and the property would hold for an inverted gate while
          // examining nothing (brief rule 22).
          const before = nearMiss ? oneShort(target, withhold) : new Set(drawn)
          const after = new Set([...before, added])
          const a = gateConsent({ target, state: before })
          const b = gateConsent({ target, state: after })
          if (a.permitted === b.permitted) unchanged += 1
          else flipped += 1
          // Monotone: adding a signal may turn a refusal into a permission and may never do the reverse.
          return !(a.permitted && !b.permitted)
        },
      ),
      { numRuns: RUNS },
    )
    // Both outcomes occurred, so the property examined the relation rather than one side of it.
    expect(flipped, 'no generated pair ever changed the answer').toBeGreaterThan(0)
    expect(unchanged, 'every generated pair changed the answer').toBeGreaterThan(0)
    /*
     * The vacuity floor, MEASURED rather than hoped for.
     *
     * The near-miss half of the generator is drawn with probability 1/2 and flips whenever the added
     * signal is the withheld one, which is one of four — so the expected share is about an eighth, and
     * five consecutive runs of this file MEASURED 117, 126, 119, 107 and 113 of 600: 17.8% to 21.0%,
     * which is above the back-of-envelope eighth because the unweighted half also flips whenever its
     * drawn subset happens to be one signal short.
     *
     * A floor just under the observed minimum becomes its own flake, so it is RUNS/24 — 25, about 4% —
     * which is a fifth of the measured rate and far above anything an unweighted generator reaches.
     */
    expect(flipped, 'too few generated pairs could disagree for this to be a test').toBeGreaterThan(
      RUNS / 24,
    )
  }, 30_000)

  it('catches a gate whose comparison is inverted, which is what makes the property non-vacuous', () => {
    // The known-bad control ADR 0003 asks for, in-process. `inverted` permits a target when a required
    // signal is MISSING, which is the single-character mistake the property exists to catch.
    const inverted = (target: string, state: AnalyticsConsentState): boolean => {
      const required = consentGatedTarget(target)?.requires ?? []
      return required.some((signal) => !state.has(signal))
    }
    let caught = 0
    for (const target of CONSENT_GATED_TARGET_IDS) {
      const required = consentGatedTarget(target)?.requires ?? []
      const before = new Set(required.slice(1))
      const after = new Set(required)
      if (inverted(target, before) && !inverted(target, after)) caught += 1
    }
    expect(caught, 'the inverted gate was not caught by the monotonicity relation').toBeGreaterThan(
      0,
    )
  })
})
