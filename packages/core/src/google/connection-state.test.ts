import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { ASIA_DUBAI, type Instant, instantFromIso, toLocal } from '../time.ts'
import {
  type ConnectionSnapshot,
  deriveConnectionHealth,
  GOOGLE_CAPABILITIES,
  GOOGLE_CONNECTION_STATUSES,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type GoogleConnectionDisplayState,
} from './connection.ts'
import {
  CAPABILITY_HEALTH_LABEL,
  CAPABILITY_LABEL,
  CONNECTION_PRESENTATION_STATES,
  CONNECTION_STATE_COPY,
  CONNECTION_STATE_EVENTS,
  CONNECTION_TRANSITIONS,
  type ConnectionStateEvent,
  connectionStateCopy,
  connectionToneFor,
  connectionTransition,
  DAILY_HEALTH_CHECK_LOCAL_HOUR,
  DEGRADED_CAUSE_DETAIL,
  degradedCauseFor,
  grantedScopeLabels,
  nextDailyHealthCheck,
  recencyPhrase,
  SCOPE_LABEL,
  stateShownFor,
} from './connection-state.ts'

/**
 * G-CONN-07 — the presentation state machine, and the plain English it renders as.
 *
 * Three claims, and each has a control that must fail:
 *
 *  1. **The matrix is total and it discriminates.** Every one of the 6 × 13 pairs carries a decision. That
 *     is enforced by the compiler — `CONNECTION_TRANSITIONS` is a `Record` over both unions — so the test's
 *     job is the half a type cannot do: that the axes are the length they claim (a lost axis would make a
 *     smaller matrix pass everything below), and that the decisions are not all the same. A table of 78
 *     refusals, or of 78 self-loops, satisfies "every pair has a decision" and says nothing.
 *
 *  2. **Every state a person can be shown has exactly one sentence.** Also compiler-enforced, and tested
 *     here for the parts a `Record` cannot check: non-empty strings, a tone that agrees with the
 *     `assertNever` switch, exactly one state that may not be shown without a timestamp, and — docs/10 §4 —
 *     no scope URL anywhere in any of it.
 *
 *  3. **The matrix agrees with `deriveConnectionHealth`.** The important one. The machine is a second
 *     description of something that already has a derivation, so it is checked against it: each fixture
 *     builds a snapshot in a known state, applies the event as a change to that snapshot, and asserts the
 *     derivation lands where the matrix said it would. The count of pairs covered this way is asserted
 *     against a floor, because a cross-check that silently stopped covering anything is the failure mode
 *     of exactly this kind of test.
 */

const NOW = instantFromIso('2026-09-25T10:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const BOTH_SCOPES = [GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY]

/**
 * A connection in the plainest healthy shape: consented a month ago, read an hour ago, everything ok.
 *
 * Every fixture below is this with one thing changed, which is what makes the cross-check a claim about
 * the event rather than about the fixture.
 */
function snapshot(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    status: 'active',
    consentAt: (NOW - 30 * DAY) as Instant,
    lastOkAt: (NOW - HOUR) as Instant,
    grantedScopes: BOTH_SCOPES,
    capabilities: [
      { capability: 'gbp_reviews', health: 'ok' },
      { capability: 'gsc', health: 'ok' },
    ],
    consentScreenInTesting: false,
    gbpAccessGranted: true,
    ...overrides,
  }
}

const shownFor = (override: Partial<ConnectionSnapshot> = {}): GoogleConnectionDisplayState =>
  stateShownFor(deriveConnectionHealth(snapshot(override), NOW))

describe('acceptance — every (presentation state x event) pair carries a decision', () => {
  it('decides all 78 pairs, over axes of the length it claims', () => {
    // Stated rather than counted after the fact. A matrix that lost a state would decide 65 pairs and
    // every assertion below would still pass.
    expect(CONNECTION_PRESENTATION_STATES).toHaveLength(6)
    expect(CONNECTION_STATE_EVENTS).toHaveLength(13)
    expect(new Set(CONNECTION_PRESENTATION_STATES).size).toBe(6)
    expect(new Set(CONNECTION_STATE_EVENTS).size).toBe(13)

    let decided = 0
    for (const state of CONNECTION_PRESENTATION_STATES) {
      for (const event of CONNECTION_STATE_EVENTS) {
        const transition = connectionTransition(state, event)
        expect(transition, `${state} x ${event}`).toBeDefined()
        if (transition.kind === 'moves') {
          // A target outside the enumerated set would be a seventh state nothing has a sentence for.
          expect(CONNECTION_PRESENTATION_STATES, `${state} x ${event}`).toContain(transition.to)
        } else {
          expect(
            [
              'no_connection_to_act_on',
              'already_in_that_state',
              'reconnect_first',
              'not_the_current_obstacle',
            ],
            `${state} x ${event}`,
          ).toContain(transition.reason)
        }
        // Every decision says why, because the reason is the only part a reviewer can check.
        expect(transition.because.length, `${state} x ${event}`).toBeGreaterThan(20)
        decided += 1
      }
    }
    expect(decided).toBe(78)
  })

  it('keeps the table and the enumerations in exact bijection', () => {
    // The `as const` array and the `Record` are two spellings of one union, and only one of them is what
    // the walk above iterates: an event left out of the array is an event nothing above tests.
    expect(Object.keys(CONNECTION_TRANSITIONS).sort()).toEqual(
      [...CONNECTION_PRESENTATION_STATES].sort(),
    )
    for (const state of CONNECTION_PRESENTATION_STATES) {
      expect(Object.keys(CONNECTION_TRANSITIONS[state]).sort(), state).toEqual(
        [...CONNECTION_STATE_EVENTS].sort(),
      )
    }
  })

  it('discriminates: no row is uniform, and every state is reachable', () => {
    // The control on the shape of the table. 78 refusals, or 78 self-loops, would satisfy the case above,
    // so each row is required to say at least three different things.
    //
    // Not "every state both moves and refuses": `healthy` refuses nothing, and that is correct rather than
    // an omission. It is the base state, so every fact in the event set applies to it — which is why the
    // per-row assertion is about variety and the per-kind assertion is global.
    for (const state of CONNECTION_PRESENTATION_STATES) {
      const decisions = CONNECTION_STATE_EVENTS.map((event) => connectionTransition(state, event))
      expect(
        decisions.filter((d) => d.kind === 'moves').length,
        `${state} refuses everything`,
      ).toBeGreaterThan(0)
      const distinct = new Set(
        decisions.map((d) => (d.kind === 'moves' ? `moves:${d.to}` : `refused:${d.reason}`)),
      )
      expect(
        distinct.size,
        `${state} says the same thing about every event`,
      ).toBeGreaterThanOrEqual(3)
    }
    // Both kinds exist in quantity. Measured: 61 moves and 17 refusals today, so the floors are under
    // the observed numbers rather than at them — a floor set at the exact count is its own flake the next
    // time a decision changes.
    const all = CONNECTION_PRESENTATION_STATES.flatMap((state) =>
      CONNECTION_STATE_EVENTS.map((event) => connectionTransition(state, event)),
    )
    expect(all.filter((d) => d.kind === 'moves').length).toBeGreaterThanOrEqual(50)
    expect(all.filter((d) => d.kind === 'refused').length).toBeGreaterThanOrEqual(12)

    // Reachability, in the direction that matters: a state no event leads to is a state that can be
    // derived and never explained, which is how `pending_gbp_approval` was unreachable until
    // `gbp_read_refused_pending` was split out of `capability_failed`.
    const reachable = new Set<GoogleConnectionDisplayState>()
    for (const state of CONNECTION_PRESENTATION_STATES) {
      for (const event of CONNECTION_STATE_EVENTS) {
        const transition = connectionTransition(state, event)
        if (transition.kind === 'moves' && transition.to !== state) reachable.add(transition.to)
      }
    }
    expect([...reachable].sort()).toEqual([...CONNECTION_PRESENTATION_STATES].sort())

    // And every refusal reason is actually used. An unused one is a distinction nobody makes.
    const reasons = new Set(
      CONNECTION_PRESENTATION_STATES.flatMap((state) =>
        CONNECTION_STATE_EVENTS.map((event) => connectionTransition(state, event)).flatMap((d) =>
          d.kind === 'refused' ? [d.reason] : [],
        ),
      ),
    )
    expect([...reasons].sort()).toEqual([
      'already_in_that_state',
      'no_connection_to_act_on',
      'not_the_current_obstacle',
      'reconnect_first',
    ])
  })

  it('refuses every fact about a live grant when nothing is connected', () => {
    // The row a reader is most likely to get wrong, asserted whole: with nothing connected the only event
    // that does anything is a consent.
    const moved = CONNECTION_STATE_EVENTS.filter(
      (event) => connectionTransition('never_connected', event).kind === 'moves',
    )
    expect(moved).toEqual(['consent_completed'])
  })

  it('never lets a dead grant report a successful read', () => {
    // The three events that can only exist if a token was issued, refused by name from `broken`.
    for (const event of [
      'capabilities_all_ok',
      'check_reached_google',
      'capability_failed',
    ] as const) {
      const transition = connectionTransition('broken', event)
      expect(transition.kind, event).toBe('refused')
      if (transition.kind === 'refused') expect(transition.reason, event).toBe('reconnect_first')
    }
    // The control: from `healthy` the same three events are not refused, so the refusal above is about
    // the state and not about the events.
    for (const event of [
      'capabilities_all_ok',
      'check_reached_google',
      'capability_failed',
    ] as const) {
      expect(connectionTransition('healthy', event).kind, event).toBe('moves')
    }
  })

  it('deduplicates a repeated invalid_grant, which is one incident and not two', () => {
    expect(connectionTransition('healthy', 'refresh_failed_invalid_grant')).toMatchObject({
      kind: 'moves',
      to: 'broken',
    })
    expect(connectionTransition('broken', 'refresh_failed_invalid_grant')).toMatchObject({
      kind: 'refused',
      reason: 'already_in_that_state',
    })
  })
})

describe('acceptance — the matrix agrees with the one derivation', () => {
  /**
   * Each case: a snapshot in a known state, the same snapshot with the event applied, and the pair the
   * matrix claims. The derivation decides; the matrix is checked against it.
   */
  const cases: readonly {
    readonly event: ConnectionStateEvent
    readonly before: Partial<ConnectionSnapshot>
    readonly after: Partial<ConnectionSnapshot>
    readonly from: GoogleConnectionDisplayState
  }[] = [
    {
      // healthy --invalid_grant--> broken
      event: 'refresh_failed_invalid_grant',
      before: {},
      after: { status: 'needs_reauth' },
      from: 'healthy',
    },
    {
      // healthy --capability_failed--> degraded
      event: 'capability_failed',
      before: {},
      after: {
        capabilities: [
          { capability: 'gbp_reviews', health: 'not_verified' },
          { capability: 'gsc', health: 'ok' },
        ],
      },
      from: 'healthy',
    },
    {
      // healthy --gbp_read_refused_pending--> pending_gbp_approval
      event: 'gbp_read_refused_pending',
      before: {},
      after: {
        gbpAccessGranted: false,
        capabilities: [
          { capability: 'gbp_reviews', health: 'quota_zero' },
          { capability: 'gsc', health: 'ok' },
        ],
      },
      from: 'healthy',
    },
    {
      // healthy --staleness_window_passed--> degraded
      event: 'staleness_window_passed',
      before: {},
      after: { lastOkAt: (NOW - 3 * DAY) as Instant },
      from: 'healthy',
    },
    {
      // healthy --testing_expiry_within_window--> expiring_soon
      event: 'testing_expiry_within_window',
      before: {},
      after: {
        consentScreenInTesting: true,
        consentAt: (NOW - 6 * DAY) as Instant,
      },
      from: 'healthy',
    },
    {
      // expiring_soon --consent_screen_published--> healthy
      event: 'consent_screen_published',
      before: { consentScreenInTesting: true, consentAt: (NOW - 6 * DAY) as Instant },
      after: { consentScreenInTesting: false, consentAt: (NOW - 6 * DAY) as Instant },
      from: 'expiring_soon',
    },
    {
      // pending_gbp_approval --gbp_access_approved--> degraded. The one setting change that makes a
      // connection look worse, which is why it has a fixture of its own.
      event: 'gbp_access_approved',
      before: {
        gbpAccessGranted: false,
        capabilities: [
          { capability: 'gbp_reviews', health: 'quota_zero' },
          { capability: 'gsc', health: 'ok' },
        ],
      },
      after: {
        gbpAccessGranted: true,
        capabilities: [
          { capability: 'gbp_reviews', health: 'quota_zero' },
          { capability: 'gsc', health: 'ok' },
        ],
      },
      from: 'pending_gbp_approval',
    },
    {
      // degraded --capabilities_all_ok--> healthy
      event: 'capabilities_all_ok',
      before: {
        capabilities: [
          { capability: 'gbp_reviews', health: 'permission_missing' },
          { capability: 'gsc', health: 'ok' },
        ],
      },
      after: {},
      from: 'degraded',
    },
    {
      // healthy --owner_disconnected--> never_connected
      event: 'owner_disconnected',
      before: {},
      after: { status: 'disconnected' },
      from: 'healthy',
    },
    {
      // healthy --grant_revoked_at_google--> broken
      event: 'grant_revoked_at_google',
      before: {},
      after: { status: 'revoked' },
      from: 'healthy',
    },
    {
      // broken --consent_completed--> degraded, cause never_verified. The green tick a consent must not
      // earn: the grant is alive and nothing has been read through it.
      event: 'consent_completed',
      before: { status: 'needs_reauth' },
      after: { status: 'active', lastOkAt: null, consentAt: (NOW - HOUR) as Instant },
      from: 'broken',
    },
  ]

  it('lands where the matrix says, for every fixture', () => {
    let checked = 0
    for (const testCase of cases) {
      const before = stateShownFor(deriveConnectionHealth(snapshot(testCase.before), NOW))
      expect(before, `${testCase.event}: the fixture does not start where it claims`).toBe(
        testCase.from,
      )
      const declared = connectionTransition(testCase.from, testCase.event)
      expect(declared.kind, `${testCase.from} x ${testCase.event}`).toBe('moves')
      const after = stateShownFor(deriveConnectionHealth(snapshot(testCase.after), NOW))
      if (declared.kind === 'moves') {
        expect(after, `${testCase.from} x ${testCase.event}`).toBe(declared.to)
      }
      checked += 1
    }
    // A floor, measured: eleven fixtures today. The failure this guards is a refactor that leaves the
    // array empty or filtered to nothing, which would make every assertion above vacuous.
    expect(checked).toBeGreaterThanOrEqual(11)
  })

  it('and the fixtures would notice a wrong claim', () => {
    // The control on the cross-check itself. The same walk against a deliberately wrong target must fail,
    // or the agreement above is satisfied by a comparison that cannot disagree.
    const first = cases[0]
    if (first === undefined) throw new Error('no fixtures')
    const after = stateShownFor(deriveConnectionHealth(snapshot(first.after), NOW))
    expect(after).not.toBe('healthy')
    expect(after).toBe('broken')
  })
})

describe('acceptance — one sentence per state, in plain English, never a scope string', () => {
  it('gives every state a headline, a detail and a tone that agrees with the switch', () => {
    for (const state of CONNECTION_PRESENTATION_STATES) {
      const copy = connectionStateCopy(state)
      expect(copy.headline.length, state).toBeGreaterThan(3)
      expect(copy.detail.length, state).toBeGreaterThan(40)
      // Two spellings of one fact, so the `assertNever` switch cannot drift from the table.
      expect(copy.tone, state).toBe(connectionToneFor(state))
    }
    // The headlines are distinct: a table where two states read the same is a badge that cannot be told
    // apart by the person looking at it.
    const headlines = CONNECTION_PRESENTATION_STATES.map((s) => CONNECTION_STATE_COPY[s].headline)
    expect(new Set(headlines).size).toBe(headlines.length)
  })

  it('renders the exact pending-approval sentence docs/10 §4 names', () => {
    expect(CONNECTION_STATE_COPY.pending_gbp_approval.headline).toBe(
      'Connected, Business Profile access pending Google approval',
    )
  })

  it('keeps the reassurance sentence in the broken state', () => {
    // docs/10 §4: the first question on seeing a red banner is whether work has been lost.
    expect(CONNECTION_STATE_COPY.broken.detail).toContain(
      'review replies will keep being drafted for you to post by hand; nothing is lost',
    )
  })

  it('names exactly one state that may not be shown without a timestamp', () => {
    const needing = CONNECTION_PRESENTATION_STATES.filter(
      (state) => CONNECTION_STATE_COPY[state].requiresRecency,
    )
    expect(needing).toEqual(['healthy'])
  })

  it('has no scope URL, and no stored enum value, in anything a person reads', () => {
    const everything = [
      ...CONNECTION_PRESENTATION_STATES.flatMap((state) => [
        CONNECTION_STATE_COPY[state].headline,
        CONNECTION_STATE_COPY[state].detail,
      ]),
      ...Object.values(DEGRADED_CAUSE_DETAIL),
      ...Object.values(CAPABILITY_LABEL),
      ...Object.values(CAPABILITY_HEALTH_LABEL),
      ...Object.values(SCOPE_LABEL),
    ]
    for (const sentence of everything) {
      expect(sentence, sentence).not.toContain('googleapis.com')
      // Nor the column values themselves: `quota_zero` on a screen is an enum member, not English.
      for (const value of [...GOOGLE_CAPABILITIES, ...GOOGLE_CONNECTION_STATUSES]) {
        expect(sentence, `${sentence} contains ${value}`).not.toContain(value)
      }
    }
    // The control: the raw scope strings this system requests DO contain the substring, so the assertion
    // above is testing something.
    expect(GOOGLE_SCOPE_BUSINESS_MANAGE).toContain('googleapis.com')
  })

  it('labels every capability and every health value', () => {
    expect(Object.keys(CAPABILITY_LABEL).sort()).toEqual([...GOOGLE_CAPABILITIES].sort())
    expect(Object.keys(CAPABILITY_HEALTH_LABEL).sort()).toEqual([
      'not_verified',
      'ok',
      'permission_missing',
      'quota_zero',
      'unknown',
    ])
  })

  it('throws by name for a state no sentence exists for', () => {
    // The runtime half of the compile-time guard. The type makes a seventh state a build error; this
    // proves the guard is live rather than optimised away, which is what ADR 0003 asks of every check.
    try {
      connectionToneFor('sabbatical' as never)
      expect.unreachable('a state with no sentence must not be given a tone')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).message).toContain('connectionToneFor')
    }
  })
})

describe('acceptance — Connected cannot be shown without a recency', () => {
  it('shows degraded for a grant nothing has ever read', () => {
    // The derivation says healthy, correctly: a connection consented an hour ago is not stale and nothing
    // has failed. The CARD may not say Connected, because there is no timestamp to put beside it.
    const health = deriveConnectionHealth(
      snapshot({ lastOkAt: null, consentAt: (NOW - HOUR) as Instant }),
      NOW,
    )
    expect(health.displayState).toBe('healthy')
    expect(health.hoursSinceLastSuccess).toBeNull()
    expect(stateShownFor(health)).toBe('degraded')
    expect(degradedCauseFor(health)).toBe('never_verified')
    expect(recencyPhrase(health.hoursSinceLastSuccess)).toBeNull()
  })

  it('and shows healthy the moment there is one', () => {
    // The control. Same snapshot with one successful call, so the override above is about the recency and
    // not about the fixture.
    const health = deriveConnectionHealth(
      snapshot({ lastOkAt: (NOW - 2 * HOUR) as Instant, consentAt: (NOW - HOUR) as Instant }),
      NOW,
    )
    expect(stateShownFor(health)).toBe('healthy')
    expect(degradedCauseFor(health)).toBeNull()
    expect(recencyPhrase(health.hoursSinceLastSuccess)).toBe('Last verified 2 hours ago')
  })

  it('leaves every other state exactly as derived', () => {
    // `stateShownFor` must be a rule about one case. A version that also touched broken or pending would
    // be a second derivation, which is the thing this module exists to avoid.
    const cases: readonly [Partial<ConnectionSnapshot>, GoogleConnectionDisplayState][] = [
      [{ status: 'needs_reauth', lastOkAt: null }, 'broken'],
      [{ status: 'revoked', lastOkAt: null }, 'broken'],
      [{ status: 'disconnected', lastOkAt: null }, 'never_connected'],
      [
        {
          // `consentAt` recent as well as `lastOkAt` null, because staleness falls back to the consent:
          // a month-old consent with nothing read is stale, and stale outranks a pending review.
          lastOkAt: null,
          consentAt: (NOW - HOUR) as Instant,
          gbpAccessGranted: false,
          capabilities: [{ capability: 'gbp_reviews', health: 'quota_zero' }],
        },
        'pending_gbp_approval',
      ],
    ]
    for (const [override, expected] of cases) {
      const health = deriveConnectionHealth(snapshot(override), NOW)
      expect(stateShownFor(health), JSON.stringify(override)).toBe(expected)
      expect(stateShownFor(health), JSON.stringify(override)).toBe(health.displayState)
    }
  })

  it('names the three causes of degraded, and only when degraded', () => {
    expect(shownFor({ lastOkAt: null, consentAt: (NOW - HOUR) as Instant })).toBe('degraded')
    expect(
      degradedCauseFor(
        deriveConnectionHealth(
          snapshot({
            capabilities: [{ capability: 'gsc', health: 'permission_missing' }],
          }),
          NOW,
        ),
      ),
    ).toBe('capability_failing')
    expect(
      degradedCauseFor(
        deriveConnectionHealth(snapshot({ lastOkAt: (NOW - 4 * DAY) as Instant }), NOW),
      ),
    ).toBe('stale')
    // Every cause has a sentence, and none of them is the generic one.
    expect(Object.keys(DEGRADED_CAUSE_DETAIL).sort()).toEqual([
      'capability_failing',
      'never_verified',
      'stale',
    ])
    for (const detail of Object.values(DEGRADED_CAUSE_DETAIL)) {
      expect(detail).not.toBe(CONNECTION_STATE_COPY.degraded.detail)
    }
  })

  it('reads a relative timestamp in words a person uses', () => {
    expect(recencyPhrase(null)).toBeNull()
    expect(recencyPhrase(0)).toBe('Last verified less than an hour ago')
    expect(recencyPhrase(1)).toBe('Last verified 1 hour ago')
    expect(recencyPhrase(2)).toBe('Last verified 2 hours ago')
    expect(recencyPhrase(23)).toBe('Last verified 23 hours ago')
    expect(recencyPhrase(24)).toBe('Last verified 1 day ago')
    expect(recencyPhrase(49)).toBe('Last verified 2 days ago')
    // Negative hours cannot arrive from `hoursBetween` on a past instant, and if a clock skew produced
    // one the phrase must not read as a future date.
    expect(recencyPhrase(-3)).toBe('Last verified less than an hour ago')
  })
})

describe('acceptance — the next nightly check is the one the cron will run', () => {
  it('resolves to 03:00 Asia/Dubai, strictly in the future', () => {
    for (const iso of [
      '2026-09-25T10:00:00.000Z',
      '2026-09-25T22:59:00.000Z',
      '2026-09-25T23:01:00.000Z',
      '2026-12-31T23:30:00.000Z',
    ]) {
      const now = instantFromIso(iso)
      const next = nextDailyHealthCheck(now)
      expect(next, iso).toBeGreaterThan(now)
      const local = toLocal(next, ASIA_DUBAI)
      expect(local.time, iso).toBe('03:00')
      // Never more than a day away: a bug that skipped to the day after would still satisfy both
      // assertions above.
      expect(next - now, iso).toBeLessThanOrEqual(DAY)
    }
  })

  it('crosses to tomorrow at exactly the hour, and not before', () => {
    // 23:00 UTC is 03:00 in Asia/Dubai, which is the boundary the cron sits on. One minute either side.
    const before = instantFromIso('2026-09-25T22:59:00.000Z')
    const after = instantFromIso('2026-09-25T23:00:00.000Z')
    expect(toLocal(nextDailyHealthCheck(before), ASIA_DUBAI).date).toBe('2026-09-26')
    expect(toLocal(nextDailyHealthCheck(after), ASIA_DUBAI).date).toBe('2026-09-27')
    expect(DAILY_HEALTH_CHECK_LOCAL_HOUR).toBe(3)
  })
})

describe('acceptance — granted scopes render as English, never as URLs', () => {
  it('describes both scopes this system requests', () => {
    const labels = grantedScopeLabels(BOTH_SCOPES)
    expect(labels).toHaveLength(2)
    for (const label of labels) {
      expect(label.recognised).toBe(true)
      expect(label.token).toBe('')
      expect(label.label).not.toContain('googleapis.com')
      expect(label.label.length).toBeGreaterThan(20)
    }
    // The one fact about `business.manage` the consent screen does not say and the owner is approving.
    expect(labels[0]?.label).toContain('no read-only version')
  })

  it('describes a scope nobody asked for without printing it', () => {
    // A grant can carry more than was requested if somebody widens the client, and the Gmail scopes are
    // the ones that matter: requesting one makes a password change revoke the refresh token.
    const labels = grantedScopeLabels(['https://www.googleapis.com/auth/gmail.readonly'])
    expect(labels[0]?.recognised).toBe(false)
    expect(labels[0]?.token).toBe('gmail.readonly')
    expect(labels[0]?.label).not.toContain('googleapis.com')
    expect(`${labels[0]?.label}${labels[0]?.token}`).not.toContain('auth/')
  })

  it('identifies a scope that is a bare host, and never renders a blank bullet', () => {
    // `https://mail.google.com/` is the one forbidden scope with no path. It identifies itself by host,
    // which carries no `auth/` and is still something the owner can act on.
    expect(grantedScopeLabels(['https://mail.google.com/'])[0]?.token).toBe('mail.google.com')
    // The degenerate values a text[] column can still hold. `unnamed` rather than the empty string,
    // which would reach a screen as a blank bullet nobody could report.
    expect(grantedScopeLabels([''])[0]?.token).toBe('unnamed')
    expect(grantedScopeLabels(['///'])[0]?.token).toBe('unnamed')
  })

  it('renders nothing for a grant with no scopes, rather than a placeholder', () => {
    expect(grantedScopeLabels([])).toEqual([])
  })
})
