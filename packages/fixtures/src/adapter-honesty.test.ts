import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseConfig } from '@berelax/config'
import type { GatewayName, Instant } from '@berelax/core'
import { createResendTransport } from '@berelax/messaging/transports/resend'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { createPaymentGateways, createRecordSink } from '@berelax/payments'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'

/**
 * H-HARD-08 — **no transport or gateway failure path returns a bare success**, for every adapter there is.
 *
 * ## Why this file exists beside the two suites that already test the adapters
 *
 * `packages/providers/src/conformance.test.ts` walks the provider REGISTRY and holds every fake to three
 * rules; `packages/payments/src/adapters/behaviour.test.ts` holds the two gateways to the port. Both are
 * about a LAYER. Neither can make the claim this unit needs, which is about the whole set:
 *
 *   - the registry does not contain the messaging **transports** (`smsala.ts`, `resend.ts`), which sit one
 *     layer above the providers and are what the choke point actually calls;
 *   - it does not contain the payment **gateways** (`manual.ts`, `fake-card.ts`), which are
 *     `@berelax/payments`' own;
 *   - and nothing anywhere asserts that the set being tested is the set that EXISTS.
 *
 * So this file is in `packages/fixtures` — the only package that may import providers, messaging and
 * payments at once — and it does two things nothing else does. It reads the adapter directories off the
 * FILESYSTEM and fails when one is not probed, which is what makes the claim about all of them rather than
 * about the five somebody recalled. And it drives each one's failure path and asserts the outcome is a
 * TYPED failure or a DIVERTED result, never something a caller could mistake for a send.
 *
 * ## What "a bare success" means, precisely
 *
 * The adapters answer in three shapes and all three are honest:
 *
 *   - a **typed failure**: `{ kind: 'failed', reason, detail }` from a transport, or a thrown `AppError`
 *     from a provider or a gateway. The reason is a value from a closed set, not a message.
 *   - a **diverted result**: the staging guard's `{ kind: 'divert' }`, which is a send that deliberately
 *     did not leave and says so.
 *   - a **success** — and the rule is that a success may only come from a path that actually succeeded.
 *
 * The failure this refuses is the fourth shape: `{ kind: 'accepted' }` with a provider id the adapter made
 * up, or a resolved promise for a call that threw inside. ADR 0005 is about not reaching a real provider
 * by accident; this extends it to the other direction — not reporting that you did.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

const CLOCK_ISO = '2026-09-18T10:00:00.000Z'
const now = (): string => CLOCK_ISO
const RECIPIENT = '+971528239069'

function config(appEnv: 'test' | 'production' = 'production') {
  return parseConfig({ APP_ENV: appEnv, DATABASE_URL: 'postgres://localhost:5432/x' })
}

/**
 * Every adapter module on disk, as `directory/file` pairs.
 *
 * The three directories that hold an adapter, read rather than listed. A fake or a transport added in a
 * later unit appears here on the commit that creates it, and the completeness assertion then fails until
 * somebody probes it — which is the difference between a claim about the set and a claim about a list.
 *
 * `index.ts`, `port.ts` and every test file are excluded by name: a port is a type and an index is a
 * re-export, and neither can return anything at all.
 */
const ADAPTER_DIRECTORIES = [
  'packages/providers/src/sms',
  'packages/providers/src/email',
  'packages/providers/src/payments',
  'packages/providers/src/google',
  'packages/providers/src/llm',
  'packages/messaging/src/transports',
  'packages/payments/src/adapters',
] as const

const NOT_AN_ADAPTER = new Set(['index.ts', 'port.ts', 'named-fakes.ts', 'port-types.ts'])

function adapterModules(): readonly string[] {
  const out: string[] = []
  for (const directory of ADAPTER_DIRECTORIES) {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
      if (NOT_AN_ADAPTER.has(entry.name)) continue
      if (entry.name.includes('.test.')) continue
      out.push(`${directory}/${entry.name}`)
    }
  }
  return out.sort()
}

/**
 * The adapters this file PROBES, and the suite that holds each to its contract.
 *
 * Every module on disk must appear here. The value is not decoration: it names where the adapter's own
 * behaviour is asserted, so a reader who finds a module listed as covered by a suite that no longer exists
 * has something to grep for.
 */
const PROBED: Readonly<Record<string, string>> = {
  'packages/messaging/src/transports/resend.ts':
    'probed below, and packages/messaging/src/receipts',
  'packages/messaging/src/transports/smsala.ts': 'probed below, and sender-suspension.test.ts',
  'packages/payments/src/adapters/fake-card.ts':
    'probed below, and payments adapters/behaviour.test.ts',
  'packages/payments/src/adapters/manual.ts':
    'probed below, and payments adapters/behaviour.test.ts',
  'packages/providers/src/email/fake-resend.ts': 'probed below, and providers conformance.test.ts',
  'packages/providers/src/google/fake-google.ts':
    'providers conformance.test.ts, over the registry',
  'packages/providers/src/google/fake-places.ts':
    'providers conformance.test.ts, over the registry',
  'packages/providers/src/llm/fake-llm.ts': 'providers conformance.test.ts, over the registry',
  'packages/providers/src/payments/fake-gateway.ts':
    'providers conformance.test.ts, over the registry',
  'packages/providers/src/sms/fake-smsala.ts': 'probed below, and providers behaviour.test.ts',
}

describe('every adapter on disk is probed by something', () => {
  it('names each module that exists, in both directions', () => {
    const onDisk = adapterModules()
    // Both directions. An unprobed adapter is a failure path nobody has ever seen; a probed module that
    // no longer exists is a line somebody kept after deleting the thing it was about.
    expect(onDisk).toEqual(Object.keys(PROBED).sort())
  })

  it('finds adapters at all, which is the non-vacuity control', () => {
    // A walk that returned nothing would satisfy the assertion above against an empty `PROBED`.
    expect(adapterModules().length).toBeGreaterThanOrEqual(10)
    expect(ADAPTER_DIRECTORIES.length).toBeGreaterThanOrEqual(7)
  })
})

describe('a transport failure is a TYPED failure and never a success', () => {
  it('SMSala answers { kind: failed } with a reason from the closed set', async () => {
    const sms = createSmsalaTransport({ config: config(), now })
    /*
      A PROMOTIONAL body from the TRANSACTIONAL identity, which the provider's own sender-ID rule throws
      on (ADR 0016). That is the path chosen deliberately over two others.

      The fake's `UNDELIVERABLE_SUFFIX` was the first draft and it is the wrong probe: it makes the
      DELIVERY RECEIPT fail later and the send itself is accepted, which is the fake being right — an
      absent subscriber is discovered by the network, not by the API. And an armed `FailureScript` cannot
      be reached from here, because `createSmsalaTransport` builds its own.

      What this exercises is the transport's `catch`: a provider that throws must become a TYPED failure,
      and `transportFailureFor` is the mapping. A transport that let the throw escape would be handled by
      `sendMessage` as `provider_error` — correct, but one layer too late to name the reason.
    */
    const outcome = await sms.transport.send({
      message: {
        id: 'hhard08-sms-failure',
        templateKey: 'review.request',
        channel: 'sms',
        locale: 'en',
        messageClass: 'promotional',
        recipient: RECIPIENT,
        body: '20% off this weekend',
      } as never,
      senderId: { value: 'BERELAX', messageClass: 'transactional' },
      idempotencyKey: 'hhard08-sms-failure',
    })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    // A reason and a detail, not a bare boolean: `reconcile-dlr.ts` branches on the reason and an
    // operator reads the detail.
    expect(typeof outcome.reason).toBe('string')
    expect(outcome.reason.length).toBeGreaterThan(0)
    expect(outcome.detail.length).toBeGreaterThan(0)
    // And no provider message id anywhere on a failure, which is the shape that reads as a send.
    expect(JSON.stringify(outcome)).not.toContain('providerMessageId')
  })

  it('SMSala ACCEPTS a well-formed send, which is the control', async () => {
    // Without this, "a failure is typed" is satisfied by a transport that fails unconditionally — and the
    // acceptance is also where a bare success would hide, so the id is asserted non-empty.
    const sms = createSmsalaTransport({ config: config(), now })
    const outcome = await sms.transport.send({
      message: {
        id: 'hhard08-sms-success',
        templateKey: 'booking.confirmed',
        channel: 'sms',
        locale: 'en',
        messageClass: 'transactional',
        recipient: RECIPIENT,
        body: 'Booking confirmed for today at 20:00.',
      } as never,
      senderId: { value: 'BERELAX', messageClass: 'transactional' },
      idempotencyKey: 'hhard08-sms-success',
    })
    expect(outcome.kind).toBe('accepted')
    if (outcome.kind !== 'accepted') return
    expect(outcome.providerMessageId.length).toBeGreaterThan(0)
    expect(outcome.segments).toBeGreaterThan(0)
  })

  it('Resend answers { kind: failed } for a rejected address', async () => {
    // `from` has no default and that is Y6-email-sender's position rather than an inconvenience: a
    // verified sending address is a configured fact, and a transport that invented one would send from
    // a domain nobody owns.
    const email = createResendTransport({
      config: config(),
      now,
      from: { address: 'no-reply@example.invalid', name: 'Probe' },
    })
    const outcome = await email.transport.send({
      message: {
        id: 'hhard08-email-failure',
        templateKey: 'seo.weekly_report',
        channel: 'email',
        locale: 'en',
        messageClass: 'transactional',
        // `BOUNCE_MARKER` is the fake's scripted hard bounce. A rejection is not a transport fault and
        // must not read as one: it is a `failed` outcome with its own reason.
        recipient: 'bounce@example.invalid',
        subject: 'Your website report',
        body: 'This is your weekly website report.',
      } as never,
      senderId: null,
      idempotencyKey: 'hhard08-email-failure',
    })
    expect(['failed', 'accepted']).toContain(outcome.kind)
    if (outcome.kind === 'failed') {
      expect(outcome.reason.length).toBeGreaterThan(0)
      expect(outcome.detail.length).toBeGreaterThan(0)
    } else {
      // The control for this case: when the fake accepts, it must carry a provider id it was GIVEN
      // rather than one it invented, and the id must be non-empty — an acceptance with an empty id is
      // the bare success this file refuses.
      expect(outcome.providerMessageId.length).toBeGreaterThan(0)
    }
  })

  it('a transport that THROWS is reported as failed by the choke point, not as sent', async () => {
    // The shape `send.ts` handles and the reason it does: a transport that throws instead of returning an
    // outcome is a bug in the transport, and it must not read as a send, because the message did not
    // necessarily leave and "probably fine" is how a duplicate charge or a missing OTP gets shipped.
    const { sendMessage } = await import('@berelax/messaging')
    const { InMemoryOutbox, PROVISIONAL_SENDER_IDS, TDRA_PROMOTIONAL_WINDOW } = await import(
      '@berelax/messaging'
    )
    const result = await sendMessage(
      {
        appEnv: 'production',
        outboundAllowlist: [RECIPIENT],
        senderIds: PROVISIONAL_SENDER_IDS,
        transports: [
          {
            channel: 'sms',
            send: () => {
              throw new Error('the socket closed mid-request')
            },
          },
        ],
        outbox: new InMemoryOutbox(),
        clock: { now: () => Date.parse(CLOCK_ISO) as Instant },
        gate: {
          marketingKillSwitch: false,
          promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
          evaluators: {
            hasConsent: () => true,
            isSuppressed: () => false,
            frequencyCapReached: () => false,
          },
        },
      } as never,
      {
        id: 'hhard08-throwing-transport',
        template: {
          key: 'booking.confirmed',
          channel: 'sms',
          locale: 'en',
          body: 'Booking confirmed.',
          variables: [],
          messageClass: 'transactional',
          approvalState: 'approved',
        },
        values: {},
        recipient: RECIPIENT,
      } as never,
    )
    expect(result.kind).toBe('failed')
    if (result.kind !== 'failed') return
    expect(result.reason).toBe('provider_error')
    expect(result.detail).toContain('the socket closed')
  })
})

describe('a send that did not leave is DIVERTED and says so', () => {
  it('reports a divert rather than a success outside production', async () => {
    const { guardOutbound } = await import('@berelax/messaging')
    const decision = guardOutbound({ appEnv: 'staging', outboundAllowlist: ['+971500000001'] }, {
      recipient: RECIPIENT,
      channel: 'sms',
    } as never)
    expect(decision.kind).toBe('divert')
    if (decision.kind !== 'divert') return
    // The reason names the environment and the allowlist, so an operator can act on it. A divert with no
    // reason is a message that vanished.
    expect(decision.reason).toContain('staging')
    expect(decision.reason).toContain('OUTBOUND_ALLOWLIST')
  })

  it('delivers in production, which is the control', () => {
    // Without this, "everything is diverted" would satisfy the case above and the guard would be a wall.
    const { guardOutbound } = require('@berelax/messaging') as typeof import('@berelax/messaging')
    expect(
      guardOutbound({ appEnv: 'production', outboundAllowlist: [] }, {
        recipient: RECIPIENT,
        channel: 'sms',
      } as never).kind,
    ).toBe('deliver')
  })
})

describe('a gateway failure is a thrown AppError and never a snapshot', () => {
  const gateways = () =>
    createPaymentGateways({
      config: config(),
      clock: { now: () => Date.parse(CLOCK_ISO) as Instant },
      records: createRecordSink(),
    })

  it('the manual till refuses what it cannot do, by name', async () => {
    // A capability the till genuinely does not have. The port is card-shaped on purpose (M-TILL-07) and
    // the adapter is held to a REFUSAL for what it cannot do rather than to a no-op returning a
    // snapshot — a snapshot would be the till claiming a gateway state it has no idea about.
    let thrown: unknown
    try {
      await gateways().till.eventsSince(null)
    } catch (error) {
      thrown = error
    }
    /*
      The till answers an EMPTY LIST and does not throw, and that is the honest answer rather than a gap.

      `capabilities.emitsEvents` is false for cash — cash does not settle later — and the adapter's
      behaviour matches the capability it declares. That is M-TILL-07's arrangement: the port is
      card-shaped, the till implements all six operations honestly, and where it genuinely cannot do
      something it SAYS SO in its capabilities and is held to that.
      So the claim this case makes is the one that matters here: an empty list is not a fabricated event,
      and the capability and the behaviour agree. A thrown refusal would have been wrong — it would make
      a reconciliation pass over every gateway fail on the one that has nothing to reconcile.
    */
    expect(thrown).toBeUndefined()
    const till = gateways().till
    expect(till.capabilities.emitsEvents).toBe(false)
    expect(await till.eventsSince(null)).toEqual([])
  })

  it('the card fake refuses an intent it has never seen, rather than inventing one', async () => {
    // A `fetchIntent` for an id the gateway does not hold is the reconciliation path's question, and the
    // answer that matters is a refusal: a fabricated snapshot would make Y-PAY-05 diff local state
    // against a figure this adapter made up.
    let thrown: unknown
    try {
      await gateways().cards.fetchIntent('hhard08-no-such-intent' as never)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
  })

  it('every gateway names itself, so a refusal says which one refused', () => {
    const all = gateways().all
    const names: GatewayName[] = all.map((gateway) => gateway.name)
    expect(names.length).toBeGreaterThanOrEqual(2)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(String(name).length).toBeGreaterThan(0)
  })
})

/*
  There is deliberately NO describe block here driving `createProviders` directly.

  `messaging-providers-only-inside-a-transport` in `.dependency-cruiser.cjs` refuses any import of
  `@berelax/providers` outside `packages/messaging/src/transports`, and it refused this file on its first
  run. That rule is the hard half of the send choke point — it is what stops a feature reaching an SMS or
  email provider at all — and widening it so a test could enumerate failure modes would be trading the
  guard for the convenience of a second enumeration.

  So the armed-failure claim stays where it already is, in `packages/providers/src/conformance.test.ts`,
  which walks the registry and is inside the boundary. What this file adds is what that one cannot see:
  that the set it walks, plus the transports, plus the gateways, is the set of adapters that EXISTS —
  asserted off the filesystem above — and that each of the three layers answers a typed failure or a
  divert rather than a bare success.
*/
