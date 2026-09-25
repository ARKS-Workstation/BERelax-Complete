import {
  type ConnectionSnapshot,
  deriveConnectionHealth,
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type Instant,
  instantFromIso,
  reauthIncidentKey,
} from '@berelax/core'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { createMemoryReauthNoticeStore } from './notice-store.ts'
import {
  type ReauthLadderDeps,
  type ReauthSendRequest,
  type ReauthSubject,
  reauthIncidentFor,
  runReauthLadder,
  runReauthLadderFor,
} from './reauth-ladder.ts'

/**
 * G-CONN-08 — the ladder as a pass, against a store that refuses a duplicate the way the index does.
 *
 * Everything here is COUNTED. "Some notifications were sent" is satisfied by a pass that emails everybody
 * on every run, which is the failure this unit exists to prevent as much as silence is — so every
 * assertion below is a number, and the two that matter most are a 2 (one owner, one manager, per incident)
 * and a 0 (a healthy connection).
 *
 * The sender is a recording stub rather than the real choke point, for the boundary reason:
 * `messaging-providers-only-inside-a-transport` forbids this package reaching an email provider, and the
 * choke point is wired in `apps/worker`. What is asserted here is the decision and the recording; what the
 * worker's own suite asserts is that the sender it supplies goes through `deliverMessage`.
 */

const NOW = instantFromIso('2026-09-25T10:00:00.000Z')
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const CONNECTION = 'connection-gconn08'
const ACCOUNT = 'google-admin@example.invalid'
const INCIDENT = { key: reauthIncidentKey(77), openedAt: NOW }

function snapshot(overrides: Partial<ConnectionSnapshot> = {}): ConnectionSnapshot {
  return {
    status: 'active',
    consentAt: (NOW - 30 * DAY) as Instant,
    lastOkAt: (NOW - HOUR) as Instant,
    grantedScopes: [GOOGLE_SCOPE_BUSINESS_MANAGE, GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY],
    capabilities: [
      { capability: 'gbp_reviews', health: 'ok' },
      { capability: 'gsc', health: 'ok' },
    ],
    consentScreenInTesting: false,
    gbpAccessGranted: true,
    ...overrides,
  }
}

const subject = (overrides: Partial<ConnectionSnapshot> = {}, at: Instant = NOW): ReauthSubject => {
  const shape = snapshot(overrides)
  return {
    connectionId: CONNECTION,
    googleEmail: ACCOUNT,
    health: deriveConnectionHealth(shape, at),
    lastOkAt: shape.lastOkAt,
    consentAt: shape.consentAt,
  }
}

interface Harness {
  readonly deps: ReauthLadderDeps
  readonly requests: ReauthSendRequest[]
  readonly store: ReturnType<typeof createMemoryReauthNoticeStore>
}

/** Every dependency wired to something that records. `origin` and `recipientForRole` are overridable. */
function harness(
  options: {
    readonly smsEnabled?: boolean
    readonly cap?: number
    readonly origin?: string | null
    readonly recipient?: ReauthLadderDeps['recipientForRole']
    readonly refuse?: boolean
    readonly incident?: typeof INCIDENT | null
  } = {},
): Harness {
  const requests: ReauthSendRequest[] = []
  const store = createMemoryReauthNoticeStore(
    options.incident === null ? {} : { [CONNECTION]: options.incident ?? INCIDENT },
  )
  const deps: ReauthLadderDeps = {
    store,
    async send(request) {
      requests.push(request)
      return options.refuse === true ? { kind: 'refused' } : { kind: 'sent', messageId: null }
    },
    // `.invalid` is reserved by RFC 2606 and can never resolve, so a fixture address cannot become a real
    // one. No invented person (brief rule 10): the local part is the ROLE.
    recipientForRole: options.recipient ?? ((role) => `${role}@example.invalid`),
    origin: options.origin === undefined ? 'https://admin.example.invalid' : options.origin,
    cap: options.cap ?? 5,
    smsEnabled: options.smsEnabled ?? false,
    spellInstant: (instant) => `spelled-${instant}`,
  }
  return { deps, requests, store }
}

describe('which incident a connection is in', () => {
  it('keys a dead grant on the event row that recorded it', async () => {
    const { deps } = harness()
    const incident = await reauthIncidentFor(deps.store, subject({ status: 'needs_reauth' }))
    expect(incident).toEqual(INCIDENT)
  })

  it('keys an approaching Testing expiry on the expiry instant, 48 hours before it', async () => {
    const { deps } = harness()
    const target = subject({ consentScreenInTesting: true, consentAt: (NOW - 6 * DAY) as Instant })
    const incident = await reauthIncidentFor(deps.store, target)
    expect(incident?.key).toBe(
      `expiry:${new Date(target.health.testingExpiresAt ?? 0).toISOString()}`,
    )
    expect(incident?.openedAt).toBe((target.health.testingExpiresAt ?? 0) - 2 * DAY)
  })

  it('keys staleness on the instant the window closed, so a quiet month is one incident', async () => {
    const { deps } = harness()
    const first = await reauthIncidentFor(
      deps.store,
      subject({ lastOkAt: (NOW - 3 * DAY) as Instant }),
    )
    // The same connection a week later. `lastOkAt` has not moved, so the key must not either.
    const later = await reauthIncidentFor(
      deps.store,
      subject({ lastOkAt: (NOW - 3 * DAY) as Instant }, (NOW + 7 * DAY) as Instant),
    )
    expect(first?.key).toBe(`stale:${new Date(NOW - DAY).toISOString()}`)
    expect(later?.key).toBe(first?.key)
  })

  it('has no incident for a healthy connection', async () => {
    const { deps } = harness()
    expect(await reauthIncidentFor(deps.store, subject())).toBeNull()
  })
})

describe('what the pass sends', () => {
  it('sends NOTHING for a healthy connection, and records no row', async () => {
    const { deps, requests, store } = harness()
    const outcome = await runReauthLadderFor(deps, subject(), NOW)
    expect(requests.length).toBe(0)
    expect(outcome.sent.length).toBe(0)
    expect(outcome.skipped.length).toBe(0)
    expect(outcome.skippedWholly).toBe('connection_is_healthy')
    // The control that matters: a healthy connection leaves NO evidence either, so the table cannot fill
    // up with rows about connections nobody needs to be told about.
    expect(store.all().length).toBe(0)
  })

  it('sends exactly one owner email and one manager email on the first pass', async () => {
    const { deps, requests } = harness()
    const outcome = await runReauthLadderFor(deps, subject({ status: 'needs_reauth' }), NOW)
    const emails = requests.filter((request) => request.channel === 'email')
    expect(emails.length).toBe(2)
    expect(emails.map((request) => request.toRole).sort()).toEqual(['manager', 'owner'])
    expect(outcome.sent.length).toBe(2)
    expect(outcome.sent.map((decision) => decision.step)).toEqual(['reactive_0h', 'reactive_0h'])
  })

  it('deduplicates: fifty passes inside one incident still produce two emails', async () => {
    const { deps, requests } = harness()
    const target = subject({ status: 'needs_reauth' })
    // Fifty failed jobs inside one incident, which is the acceptance line's wording. Fifty PASSES is the
    // stronger version of it: each one re-reads what has been decided and each one has the chance to send.
    for (let pass = 0; pass < 50; pass += 1) {
      await runReauthLadderFor(deps, target, (NOW + pass * 60 * 1000) as Instant)
    }
    expect(requests.filter((request) => request.channel === 'email').length).toBe(2)
  })

  it('repeats at +24h, then daily, and stops dead at the cap', async () => {
    const { deps, requests } = harness({ cap: 5 })
    const target = subject({ status: 'needs_reauth' })
    const hoursSent: number[] = []
    for (let hour = 0; hour <= 8 * 24; hour += 1) {
      const before = requests.length
      await runReauthLadderFor(deps, target, (NOW + hour * HOUR) as Instant)
      for (let i = before; i < requests.length; i += 1) hoursSent.push(hour)
    }
    // Two emails per rung — owner and manager — at 0, 24, 48, 72 and 96 hours, and nothing at all after.
    expect(hoursSent).toEqual([0, 0, 24, 24, 48, 48, 72, 72, 96, 96])
    expect(requests.length).toBe(10)
  })

  it('honours a lower cap, so the setting is what stops it rather than the code', async () => {
    const { deps, requests } = harness({ cap: 2 })
    const target = subject({ status: 'needs_reauth' })
    for (let hour = 0; hour <= 8 * 24; hour += 1) {
      await runReauthLadderFor(deps, target, (NOW + hour * HOUR) as Instant)
    }
    expect(requests.length).toBe(4)
  })

  it('sends one predictive notice per expiry instant and never a second', async () => {
    const { deps, requests } = harness()
    const target = subject({ consentScreenInTesting: true, consentAt: (NOW - 6 * DAY) as Instant })
    for (let hour = 0; hour <= 48; hour += 1) {
      await runReauthLadderFor(deps, target, (NOW + hour * HOUR) as Instant)
    }
    expect(requests.length).toBe(2)
    expect(requests.every((request) => request.kind === 'predictive')).toBe(true)
    // The deadline, not the send time: an email that said "due to stop working today" would be describing
    // its own delivery.
    expect(requests[0]?.whenLabel).toBe(`spelled-${target.health.testingExpiresAt}`)
  })

  it('treats a re-consent as a new incident, because the expiry instant moves', async () => {
    const { deps, requests } = harness()
    const first = subject({ consentScreenInTesting: true, consentAt: (NOW - 6 * DAY) as Instant })
    await runReauthLadderFor(deps, first, NOW)
    expect(requests.length).toBe(2)
    // Re-consented: a new seven-day fuse, a different expiry instant, and therefore a warning that is
    // allowed to fire again when THAT one comes into view.
    const second = subject(
      { consentScreenInTesting: true, consentAt: (NOW + DAY) as Instant },
      (NOW + 6 * DAY) as Instant,
    )
    await runReauthLadderFor(deps, second, (NOW + 6 * DAY) as Instant)
    expect(requests.length).toBe(4)
    expect(new Set(requests.map((request) => request.step)).size).toBe(1)
  })

  it('carries an absolute deep link naming the connection', async () => {
    const { deps, requests } = harness()
    await runReauthLadderFor(deps, subject({ status: 'needs_reauth' }), NOW)
    for (const request of requests) {
      expect(request.reconnectUrl).toBe(
        `https://admin.example.invalid/settings/integrations?connectionId=${CONNECTION}`,
      )
    }
  })
})

describe('what the pass refuses, and what it records for it', () => {
  it('records no_recipient_on_file rather than inventing an address', async () => {
    // The SHIPPED resolver. Nothing in this build holds a staff address, and a plausible one would be
    // indistinguishable from a configured one (brief rule 15).
    const { deps, requests } = harness({ recipient: () => null })
    const outcome = await runReauthLadderFor(deps, subject({ status: 'needs_reauth' }), NOW)
    expect(requests.length).toBe(0)
    expect(outcome.sent.length).toBe(0)
    const reasons = outcome.skipped.map((decision) => decision.skippedReason)
    expect(reasons.filter((reason) => reason === 'no_recipient_on_file').length).toBe(2)
    // And the ladder MOVES ON: the next rung is still attempted a day later, rather than this one being
    // retried for ever against an index that would refuse the row.
    const next = await runReauthLadderFor(
      deps,
      subject({ status: 'needs_reauth' }),
      (NOW + DAY) as Instant,
    )
    expect(next.skipped.map((decision) => decision.step)).toEqual([
      'reactive_24h',
      'reactive_24h',
      'reactive_24h',
      'reactive_24h',
    ])
  })

  it('records no_reconnect_link_configured rather than emailing a relative path', async () => {
    const { deps, requests } = harness({ origin: null })
    const outcome = await runReauthLadderFor(deps, subject({ status: 'needs_reauth' }), NOW)
    expect(requests.filter((request) => request.channel === 'email').length).toBe(0)
    expect(
      outcome.skipped.filter((d) => d.skippedReason === 'no_reconnect_link_configured').length,
    ).toBe(2)
  })

  it('records send_refused when the choke point declined, which is normal off production', async () => {
    const { deps } = harness({ refuse: true })
    const outcome = await runReauthLadderFor(deps, subject({ status: 'needs_reauth' }), NOW)
    expect(outcome.sent.length).toBe(0)
    expect(outcome.skipped.filter((d) => d.skippedReason === 'send_refused').length).toBe(2)
  })

  it('leaves the SMSala side empty while the setting is off, and says so on the row', async () => {
    const { deps, requests } = harness({ smsEnabled: false })
    const outcome = await runReauthLadderFor(deps, subject({ status: 'needs_reauth' }), NOW)
    // THE assertion: nothing at all was handed to the SMS side.
    expect(requests.filter((request) => request.channel === 'sms').length).toBe(0)
    // And the switch left a trace. A switch whose state leaves no row is a switch nobody can prove was off.
    expect(outcome.skipped.filter((d) => d.skippedReason === 'channel_disabled').length).toBe(2)
    expect(outcome.skipped.every((d) => d.channel === 'sms')).toBe(true)
  })

  it('sends by SMS as well once the setting is on, which is the control on the assertion above', async () => {
    const { deps, requests } = harness({ smsEnabled: true })
    await runReauthLadderFor(deps, subject({ status: 'needs_reauth' }), NOW)
    expect(requests.filter((request) => request.channel === 'sms').length).toBe(2)
    expect(requests.filter((request) => request.channel === 'email').length).toBe(2)
  })

  it('sends nothing when no event recorded the incident', async () => {
    const { deps, requests, store } = harness({ incident: null })
    const outcome = await runReauthLadderFor(deps, subject({ status: 'needs_reauth' }), NOW)
    expect(requests.length).toBe(0)
    expect(store.all().length).toBe(0)
    expect(outcome.skippedWholly).toBe('connection_is_healthy')
  })
})

describe('the store refuses a duplicate the way the index does', () => {
  it('throws on a second row for the same rung, role and channel', async () => {
    const store = createMemoryReauthNoticeStore()
    const decision = {
      connectionId: CONNECTION,
      incidentKey: INCIDENT.key,
      kind: 'reactive' as const,
      step: 'reactive_0h',
      rungIndex: 1,
      toRole: 'owner' as const,
      channel: 'email' as const,
      dueAt: NOW,
      decidedAt: NOW,
      messageId: null,
      skippedReason: null,
    }
    await store.record(decision)
    await expect(store.record(decision)).rejects.toThrow(AppError)
    // The control: the same rung to the OTHER role is a different row and is accepted.
    await store.record({ ...decision, toRole: 'manager' })
    expect(store.all().length).toBe(2)
  })
})

describe('a pass over several connections', () => {
  it('counts what it did, including zero', async () => {
    const { deps } = harness()
    const result = await runReauthLadder(
      deps,
      [subject(), subject({ status: 'needs_reauth' })],
      NOW,
    )
    expect(result.connections.length).toBe(2)
    expect(result.sent).toBe(2)
    // Two SMS rows for the disabled channel on the broken connection, and nothing for the healthy one.
    expect(result.skipped).toBe(2)
    const healthy = result.connections[0]
    expect(healthy?.sent.length).toBe(0)
    expect(healthy?.skipped.length).toBe(0)
  })
})
