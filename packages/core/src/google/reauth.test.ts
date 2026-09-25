import {
  AppError,
  MAX_GOOGLE_REAUTH_LADDER_STEPS,
  REAUTH_REASSURANCE_SENTENCE,
} from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import {
  type ConnectionSnapshot,
  deriveConnectionHealth,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type GoogleConnectionDisplayState,
} from './connection.ts'
import {
  CONNECTION_PRESENTATION_STATES,
  CONNECTION_STATE_COPY,
  stateShownFor,
} from './connection-state.ts'
import {
  carriesReassurance,
  expiryIncidentKey,
  pageReauthBanner,
  parseReturnPath,
  REAUTH_BANNER_RULES,
  REAUTH_INCIDENT_KEY_PATTERN,
  REAUTH_LADDER,
  REAUTH_LADDER_RUNGS,
  REAUTH_LADDERS,
  REAUTH_NOTICE_KINDS,
  REAUTH_NOTICE_ROLES,
  REAUTH_NOTICE_STEP_PATTERN,
  REAUTH_SKIP_REASONS,
  type ReauthLadderRung,
  reauthBannerFor,
  reauthIncidentKey,
  reauthLadderCap,
  reauthLadderFor,
  reauthNoticeRunFor,
  reauthNoticeStep,
  stalenessIncidentKey,
} from './reauth.ts'

/**
 * G-CONN-08 — the banner that cannot be dismissed, and the ladder that cannot climb for ever.
 *
 * Four claims, each with the control that must fail beside it:
 *
 *  1. **The banner is a function of the stored state and of nothing else.** Every presentation state has a
 *     banner decision (a `Record`, so the compiler insists), and exactly two of them carry one. The control
 *     is the set: a table where every state showed a banner, or none did, satisfies "every state has a
 *     decision" and says nothing.
 *
 *  2. **`broken` is not dismissible and `degraded` is.** Asserted on the view rather than on markup, which
 *     is where the renderer's own suite takes over. The control is that the two differ — a `dismissible`
 *     that was hard-coded either way would pass one half of this and fail the other.
 *
 *  3. **The ladder is finite.** Counted, not asserted qualitatively: `reauthLadderFor` returns exactly the
 *     cap at every cap from 1 to the ceiling, the cap outside that range is REFUSED, and every declared
 *     rung actually appears in a plan — so a rung added to the union that the planner never reaches fails
 *     here rather than being dead code somebody trusts.
 *
 *  4. **A healthy connection produces no notice at all.** The control on the whole ladder, and it is
 *     counted too: `due.length` is zero and the skip reason names the state. Without it every assertion
 *     below is satisfied by a pass that emails everybody about everything.
 */

const NOW = instantFromIso('2026-09-25T10:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const BOTH_SCOPES = [GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY]

/** Consented a month ago, read an hour ago, everything working. Every fixture is this, changed once. */
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

/** The health record for a snapshot, through the real derivation rather than hand-built. */
const healthOf = (overrides: Partial<ConnectionSnapshot> = {}, at: Instant = NOW) =>
  deriveConnectionHealth(snapshot(overrides), at)

/** A snapshot per presentation state, so a claim about the table is a claim about reachable states. */
const STATE_FIXTURES: Readonly<Record<GoogleConnectionDisplayState, Partial<ConnectionSnapshot>>> =
  {
    never_connected: { status: 'disconnected' },
    healthy: {},
    expiring_soon: { consentScreenInTesting: true, consentAt: (NOW - 6 * DAY) as Instant },
    degraded: { capabilities: [{ capability: 'gsc', health: 'permission_missing' }] },
    pending_gbp_approval: {
      gbpAccessGranted: false,
      capabilities: [{ capability: 'gbp_reviews', health: 'quota_zero' }],
    },
    broken: { status: 'needs_reauth' },
  }

describe('the re-auth banner', () => {
  it('decides for every presentation state, and shows on exactly two of them', () => {
    // The `Record` makes the table total. What it cannot check is that the decisions DISCRIMINATE: a table
    // of six `show: true` entries would put a red banner on every admin page of a working business.
    const shows = CONNECTION_PRESENTATION_STATES.filter((state) => REAUTH_BANNER_RULES[state].show)
    expect([...shows].sort()).toEqual(['broken', 'degraded'])
    expect(Object.keys(REAUTH_BANNER_RULES).sort()).toEqual(
      [...CONNECTION_PRESENTATION_STATES].sort(),
    )
  })

  it('renders for each state exactly as the table says, over real derivations', () => {
    for (const state of CONNECTION_PRESENTATION_STATES) {
      const health = healthOf(STATE_FIXTURES[state])
      // The fixture has to reach the state, or the assertion below is about the wrong row.
      expect(stateShownFor(health), `fixture for ${state}`).toBe(state)
      const banner = reauthBannerFor({
        health,
        connectionId: 'c1',
        googleEmail: 'a@example.invalid',
      })
      if (REAUTH_BANNER_RULES[state].show) expect(banner?.state).toBe(state)
      else expect(banner).toBeNull()
    }
  })

  it('makes broken non-dismissible and degraded dismissible, and the two differ', () => {
    const broken = reauthBannerFor({ health: healthOf({ status: 'needs_reauth' }) })
    const degraded = reauthBannerFor({ health: healthOf(STATE_FIXTURES.degraded) })
    expect(broken?.dismissible).toBe(false)
    expect(degraded?.dismissible).toBe(true)
    // The control. A hard-coded `dismissible` satisfies one of the two assertions above.
    expect(broken?.dismissible).not.toBe(degraded?.dismissible)
  })

  it('reads stateShownFor, so a grant nothing has read yet still carries a banner', () => {
    // The case G-CONN-07 named: consented ten minutes ago, nothing read. The derivation says healthy —
    // correctly, nothing should email anybody — and the card and the banner show degraded.
    const health = healthOf({ consentAt: (NOW - 10 * 60 * 1000) as Instant, lastOkAt: null })
    expect(health.displayState).toBe('healthy')
    expect(REAUTH_BANNER_RULES[health.displayState].show).toBe(false)
    const banner = reauthBannerFor({ health })
    expect(banner?.state).toBe('degraded')
    expect(banner?.dismissible).toBe(true)
  })

  it('quotes the card rather than rewording it, and carries the reassurance for broken', () => {
    const banner = reauthBannerFor({ health: healthOf({ status: 'needs_reauth' }) })
    expect(banner?.headline).toBe(CONNECTION_STATE_COPY.broken.headline)
    expect(banner?.detail).toBe(CONNECTION_STATE_COPY.broken.detail)
    expect(carriesReassurance(banner?.detail ?? '')).toBe(true)
    // The control: the sentence is not in every state's copy, so the predicate discriminates.
    expect(carriesReassurance(CONNECTION_STATE_COPY.healthy.detail)).toBe(false)
    expect(REAUTH_REASSURANCE_SENTENCE.length).toBeGreaterThan(40)
  })

  it('never renders a scope URL, for any state that renders at all', () => {
    for (const state of CONNECTION_PRESENTATION_STATES) {
      const banner = reauthBannerFor({ health: healthOf(STATE_FIXTURES[state]) })
      if (banner === null) continue
      expect(`${banner.headline} ${banner.detail}`).not.toContain('googleapis.com/auth/')
    }
  })
})

describe('the banner for a page with several connections', () => {
  const connection = (id: string, overrides: Partial<ConnectionSnapshot>) => ({
    connectionId: id,
    googleEmail: `${id}@example.invalid`,
    health: healthOf(overrides),
  })

  it('lets the worst state win, so a degraded connection cannot hide a broken one', () => {
    const banner = pageReauthBanner([
      connection('a', STATE_FIXTURES.degraded),
      connection('b', { status: 'needs_reauth' }),
    ])
    expect(banner?.state).toBe('broken')
    expect(banner?.dismissible).toBe(false)
    // And in the other order, so the answer does not depend on which row arrived first.
    const reversed = pageReauthBanner([
      connection('b', { status: 'needs_reauth' }),
      connection('a', STATE_FIXTURES.degraded),
    ])
    expect(reversed?.state).toBe('broken')
  })

  it('names no account when two connections are in the same state', () => {
    const one = pageReauthBanner([connection('a', { status: 'needs_reauth' })])
    expect(one?.connectionId).toBe('a')
    const two = pageReauthBanner([
      connection('a', { status: 'needs_reauth' }),
      connection('b', { status: 'revoked' }),
    ])
    expect(two?.state).toBe('broken')
    expect(two?.connectionId).toBeNull()
    expect(two?.googleEmail).toBeNull()
  })

  it('answers null for a page whose connections are all fine, and for no connections at all', () => {
    expect(pageReauthBanner([])).toBeNull()
    expect(
      pageReauthBanner([connection('a', {}), connection('b', STATE_FIXTURES.expiring_soon)]),
    ).toBeNull()
  })
})

describe('the escalating ladder', () => {
  it('refuses a cap outside the declared range rather than clamping it', () => {
    for (const bad of [0, -1, MAX_GOOGLE_REAUTH_LADDER_STEPS + 1, 1.5, Number.NaN]) {
      expect(() => reauthLadderCap(bad), `cap ${bad}`).toThrow(AppError)
    }
    for (let cap = 1; cap <= MAX_GOOGLE_REAUTH_LADDER_STEPS; cap += 1) {
      expect(reauthLadderCap(cap)).toBe(cap)
    }
  })

  it('produces exactly the cap for the reactive ladder, at every cap', () => {
    for (let cap = 1; cap <= MAX_GOOGLE_REAUTH_LADDER_STEPS; cap += 1) {
      const plan = reauthLadderFor({ kind: 'reactive', openedAt: NOW, cap })
      expect(plan.length, `cap ${cap}`).toBe(cap)
    }
  })

  it('produces exactly one predictive notice however large the cap is', () => {
    for (let cap = 1; cap <= MAX_GOOGLE_REAUTH_LADDER_STEPS; cap += 1) {
      const plan = reauthLadderFor({ kind: 'predictive', openedAt: NOW, cap })
      expect(plan.length, `cap ${cap}`).toBe(1)
      expect(plan[0]?.afterHours).toBe(0)
    }
  })

  it('is 0, 24 then daily, with unique labels and a strictly increasing clock', () => {
    const plan = reauthLadderFor({ kind: 'reactive', openedAt: NOW, cap: 5 })
    expect(plan.map((notice) => notice.afterHours)).toEqual([0, 24, 48, 72, 96])
    expect(plan.map((notice) => notice.step)).toEqual([
      'reactive_0h',
      'reactive_24h',
      'reactive_48h',
      'reactive_72h',
      'reactive_96h',
    ])
    expect(new Set(plan.map((notice) => notice.step)).size).toBe(plan.length)
    expect(plan.map((notice) => notice.rungIndex)).toEqual([1, 2, 3, 4, 5])
    for (let i = 1; i < plan.length; i += 1) {
      expect((plan[i]?.dueAt ?? 0) > (plan[i - 1]?.dueAt ?? 0)).toBe(true)
    }
    expect(plan.at(-1)?.dueAt).toBe(NOW + 4 * DAY)
  })

  it('reaches every declared rung, so a rung nothing plans fails here', () => {
    const reached = new Set<ReauthLadderRung>()
    for (const kind of REAUTH_NOTICE_KINDS) {
      for (const notice of reauthLadderFor({
        kind,
        openedAt: NOW,
        cap: MAX_GOOGLE_REAUTH_LADDER_STEPS,
      })) {
        reached.add(notice.rung)
      }
    }
    expect([...reached].sort()).toEqual([...REAUTH_LADDER_RUNGS].sort())
    // And each declared rung is actually named by a ladder: a rung with a spec that no kind stands on is
    // as dead as a rung with no spec, and the `Record` can only catch the second.
    const named = new Set(REAUTH_NOTICE_KINDS.flatMap((kind) => [...REAUTH_LADDERS[kind]]))
    expect([...named].sort()).toEqual([...REAUTH_LADDER_RUNGS].sort())
  })

  it('declares a reason for every rung, and only one of them repeats', () => {
    for (const rung of REAUTH_LADDER_RUNGS) {
      expect(REAUTH_LADDER[rung].because.length, rung).toBeGreaterThan(40)
    }
    const repeating = REAUTH_LADDER_RUNGS.filter(
      (rung) => REAUTH_LADDER[rung].repeatEveryHours !== null,
    )
    expect(repeating).toEqual(['daily_thereafter'])
    // The repeating rung must be LAST, which is what makes the plan monotonic with no sort.
    expect(REAUTH_LADDER_RUNGS.at(-1)).toBe('daily_thereafter')
  })

  it('names every step in the pattern the migration restates, and refuses one it cannot', () => {
    for (const kind of REAUTH_NOTICE_KINDS) {
      for (const notice of reauthLadderFor({
        kind,
        openedAt: NOW,
        cap: MAX_GOOGLE_REAUTH_LADDER_STEPS,
      })) {
        expect(REAUTH_NOTICE_STEP_PATTERN.test(notice.step), notice.step).toBe(true)
      }
    }
    expect(() => reauthNoticeStep('reactive', -1)).toThrow(AppError)
    expect(() => reauthNoticeStep('reactive', 10_000)).toThrow(AppError)
    expect(() => reauthNoticeStep('reactive', 1.5)).toThrow(AppError)
    // The control on the pattern: it must reject something, or every assertion above is vacuous.
    expect(REAUTH_NOTICE_STEP_PATTERN.test('reactive_0009h')).toBe(false)
    expect(REAUTH_NOTICE_STEP_PATTERN.test('urgent_0h')).toBe(false)
  })

  it('builds an incident key per cause, and all three match the pattern', () => {
    const keys = [
      reauthIncidentKey(4231),
      expiryIncidentKey((NOW + 2 * DAY) as Instant),
      stalenessIncidentKey((NOW - DAY) as Instant),
    ]
    expect(keys).toEqual([
      'reauth:4231',
      'expiry:2026-09-27T10:00:00.000Z',
      'stale:2026-09-24T10:00:00.000Z',
    ])
    for (const key of keys) expect(REAUTH_INCIDENT_KEY_PATTERN.test(key), key).toBe(true)
    // The control: an unprefixed key is refused, so the pattern is doing work.
    expect(REAUTH_INCIDENT_KEY_PATTERN.test('4231')).toBe(false)
    expect(REAUTH_INCIDENT_KEY_PATTERN.test('reauth:')).toBe(false)
  })
})

describe('what a run decides', () => {
  const incident = { key: reauthIncidentKey(1), openedAt: NOW }
  const run = (args: {
    readonly health: ReturnType<typeof healthOf>
    readonly now?: Instant
    readonly sent?: readonly string[]
    readonly cap?: number
  }) =>
    reauthNoticeRunFor({
      health: args.health,
      incident,
      now: args.now ?? NOW,
      cap: args.cap ?? 5,
      alreadySentSteps: args.sent ?? [],
    })

  it('sends NOTHING for a healthy connection, counted', () => {
    const verdict = run({ health: healthOf() })
    expect(verdict.kind).toBe('skip')
    expect(verdict.kind === 'skip' ? verdict.reason : null).toBe('connection_is_healthy')
    // Counted rather than asserted qualitatively: a `send` with an empty `due` would read as "some were
    // sent" to any test that only looked at the verdict's shape.
    expect(verdict.kind === 'send' ? verdict.due.length : 0).toBe(0)
  })

  it('sends nothing for a degraded connection whose failure is not a dead grant', () => {
    // A failing capability is amber on the card and is NOT a re-auth: the grant works, and a re-auth email
    // would send the owner through a consent flow that fixes nothing.
    const health = healthOf({ capabilities: [{ capability: 'gsc', health: 'permission_missing' }] })
    expect(health.displayState).toBe('degraded')
    expect(health.notify).toBeNull()
    expect(run({ health }).kind).toBe('skip')
  })

  it('sends nothing for the amber pending-approval state', () => {
    const health = healthOf(STATE_FIXTURES.pending_gbp_approval)
    expect(health.displayState).toBe('pending_gbp_approval')
    expect(run({ health }).kind).toBe('skip')
  })

  it('sends one rung to both roles on the first pass of a dead grant', () => {
    const verdict = run({ health: healthOf({ status: 'needs_reauth' }) })
    expect(verdict.kind).toBe('send')
    if (verdict.kind !== 'send') return
    expect(verdict.noticeKind).toBe('reactive')
    expect(verdict.due.map((notice) => notice.step)).toEqual(['reactive_0h'])
    expect(verdict.roles).toEqual(['owner', 'manager'])
    expect(REAUTH_NOTICE_ROLES).toEqual(['owner', 'manager'])
  })

  it('deduplicates: fifty passes inside one incident leave exactly one rung due', () => {
    const health = healthOf({ status: 'needs_reauth' })
    let sent: string[] = []
    let sends = 0
    for (let pass = 0; pass < 50; pass += 1) {
      const verdict = run({ health, sent })
      if (verdict.kind !== 'send') continue
      sends += verdict.due.length
      sent = [...sent, ...verdict.due.map((notice) => notice.step)]
    }
    expect(sends).toBe(1)
    expect(sent).toEqual(['reactive_0h'])
  })

  it('fires the repeat at +24h and then daily, and stops at the cap', () => {
    const health = healthOf({ status: 'needs_reauth' })
    let sent: string[] = []
    const sentAtHour: number[] = []
    // Hour by hour for six days, which is past the five-rung cap: the ladder has to STOP rather than go
    // on producing a notice every day for as long as the loop runs.
    for (let hour = 0; hour <= 6 * 24; hour += 1) {
      const verdict = run({ health, now: (NOW + hour * HOUR) as Instant, sent })
      if (verdict.kind !== 'send') continue
      for (let i = 0; i < verdict.due.length; i += 1) sentAtHour.push(hour)
      sent = [...sent, ...verdict.due.map((notice) => notice.step)]
    }
    expect(sentAtHour).toEqual([0, 24, 48, 72, 96])
    expect(sent.length).toBe(5)
    const after = run({ health, now: (NOW + 6 * DAY) as Instant, sent })
    expect(after.kind === 'skip' ? after.reason : null).toBe('ladder_cap_reached')
  })

  it('tells a live ladder from a spent one, and both from a clock that runs ahead', () => {
    const health = healthOf({ status: 'needs_reauth' })
    // Three hours in, first rung sent. The dedupe reason, and the one an operator reads as "they have
    // been told about this and the ladder is still running".
    const live = run({ health, now: (NOW + 3 * HOUR) as Instant, sent: ['reactive_0h'] })
    expect(live.kind === 'skip' ? live.reason : null).toBe('already_notified_for_this_step')
    // Every step recorded: the ladder has finished rather than paused, which is the distinction the
    // ordering in `reauthNoticeRunFor` exists to keep — a spent ladder also satisfies "nothing new is due".
    const spent = run({
      health,
      now: (NOW + 5 * DAY) as Instant,
      sent: ['reactive_0h', 'reactive_24h', 'reactive_48h', 'reactive_72h', 'reactive_96h'],
    })
    expect(spent.kind === 'skip' ? spent.reason : null).toBe('ladder_cap_reached')
    // And the third: an incident recorded by Postgres `now()` a few seconds ahead of the pass's own
    // instant. Nothing is due, nothing has been sent, and the ladder is not spent.
    const ahead = reauthNoticeRunFor({
      health,
      incident: { key: reauthIncidentKey(9), openedAt: (NOW + 5 * 1000) as Instant },
      now: NOW,
      cap: 5,
      alreadySentSteps: [],
    })
    expect(ahead.kind === 'skip' ? ahead.reason : null).toBe('no_rung_is_due_yet')
  })

  it('catches up rather than losing rungs after a worker outage', () => {
    // Three days down. Three rungs are due at once, and sending one per pass would stretch the ladder
    // across the outage and then across three more days.
    const verdict = run({
      health: healthOf({ status: 'needs_reauth' }),
      now: (NOW + 3 * DAY) as Instant,
    })
    expect(verdict.kind === 'send' ? verdict.due.map((n) => n.step) : []).toEqual([
      'reactive_0h',
      'reactive_24h',
      'reactive_48h',
      'reactive_72h',
    ])
  })

  it('sends one predictive notice for an approaching expiry and never a second', () => {
    const expiring = healthOf(STATE_FIXTURES.expiring_soon)
    expect(expiring.notify).toBe('predictive_warning')
    const first = reauthNoticeRunFor({
      health: expiring,
      incident: { key: expiryIncidentKey(expiring.testingExpiresAt ?? NOW), openedAt: NOW },
      now: NOW,
      cap: 5,
      alreadySentSteps: [],
    })
    expect(first.kind === 'send' ? first.due.map((n) => n.step) : []).toEqual(['predictive_0h'])
    const again = reauthNoticeRunFor({
      health: expiring,
      incident: { key: expiryIncidentKey(expiring.testingExpiresAt ?? NOW), openedAt: NOW },
      now: (NOW + 5 * DAY) as Instant,
      cap: 5,
      alreadySentSteps: ['predictive_0h'],
    })
    expect(again.kind === 'skip' ? again.reason : null).toBe('ladder_cap_reached')
  })

  it('sends a predictive notice for staleness, which is the other computable warning', () => {
    const stale = healthOf({ lastOkAt: (NOW - 3 * DAY) as Instant })
    expect(stale.stale).toBe(true)
    expect(stale.notify).toBe('predictive_warning')
    const verdict = reauthNoticeRunFor({
      health: stale,
      incident: {
        key: stalenessIncidentKey((NOW - DAY) as Instant),
        openedAt: (NOW - DAY) as Instant,
      },
      now: NOW,
      cap: 5,
      alreadySentSteps: [],
    })
    expect(verdict.kind === 'send' ? verdict.due.length : 0).toBe(1)
  })

  it('skips when there is no incident to climb, even for a broken connection', () => {
    // The pass could not find the event that opened the incident. Emailing anyway would mean emailing on
    // every pass for ever, because there would be nothing to key "already sent" on.
    const verdict = reauthNoticeRunFor({
      health: healthOf({ status: 'needs_reauth' }),
      incident: null,
      now: NOW,
      cap: 5,
      alreadySentSteps: [],
    })
    expect(verdict.kind).toBe('skip')
  })

  it('keeps the skip vocabulary closed and distinct', () => {
    expect(new Set(REAUTH_SKIP_REASONS).size).toBe(REAUTH_SKIP_REASONS.length)
    expect(REAUTH_SKIP_REASONS).toContain('no_recipient_on_file')
    expect(REAUTH_SKIP_REASONS).toContain('channel_disabled')
  })
})

describe('the return path a reconnect comes back to', () => {
  it('accepts a same-origin admin path, with its query', () => {
    expect(parseReturnPath('/calendar')).toBe('/calendar')
    expect(parseReturnPath('/calendar?date=2026-09-25')).toBe('/calendar?date=2026-09-25')
    expect(parseReturnPath('  /settings/messages  ')).toBe('/settings/messages')
  })

  it('refuses everything that could leave this origin', () => {
    for (const bad of [
      '//evil.example/x',
      'https://evil.example/x',
      'http://evil.example',
      '/x\\@evil.example',
      'javascript:alert(1)',
      '/calendar#top',
      'calendar',
      '',
      '   ',
      `/x${'y'.repeat(250)}`,
      '/x\nLocation: https://evil.example',
      null,
      undefined,
    ]) {
      expect(parseReturnPath(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
