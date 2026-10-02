import { parseConfig } from '@berelax/config'
import { isAppError } from '@berelax/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { FAILURE_MODES, type FailureMode, failureModeOf } from './failure.ts'
import { PLACES_AGGREGATE_FIELD_MASK, PLACES_FIXTURE_PLACE_ID } from './google/fake-places.ts'
import { DEEPSEEK, MINIMAX } from './llm/named-fakes.ts'
import { notImplemented } from './not-implemented.ts'
import { BUILT_LLM_PROVIDERS, createProviders, type Providers } from './registry.ts'

/**
 * H02 conformance: the contract every fake must satisfy, asserted for all of them at once.
 *
 * The important property of this file is that it is **not a list of per-provider tests**. It walks
 * the registry, so a fake added in a later unit is held to the same rules without anyone remembering
 * to add it here — and a fake that quietly returns `{ ok: true }` fails the build rather than passing
 * a demo.
 *
 * Three rules, from docs/12 §1:
 *
 *   1. No success without a record in the visible call log. *A stub must never look like it works.*
 *   2. Every declared failure mode can be armed, and produces an error that names it.
 *   3. Selection is configuration. `real` resolves to something, and that something refuses loudly
 *      rather than degrading to the fake.
 */

const CLOCK = '2026-09-18T10:00:00.000Z'

function fakeConfig() {
  return parseConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/berelax_test',
  })
}

/**
 * One successful call per provider, with the arguments that call actually takes.
 *
 * Written as data rather than as separate tests so the rules below iterate over it. Adding a
 * provider means adding a row; forgetting to means the completeness assertion fails.
 */
interface Exercise {
  /**
   * The registry key, or `llmFor:<name>` for an adapter reached through the selector.
   *
   * `llmFor` is a selector rather than a provider, so it cannot be exercised as one — and exempting it
   * would let the DeepSeek and MiniMax fakes behind it escape all three rules, which is the hole this
   * file exists to close. So the completeness assertion covers the registry's providers **and** every
   * name `llmFor` resolves, and each of those is a row here.
   */
  readonly key: string
  readonly provider: string
  readonly call: (providers: Providers) => Promise<unknown>
}

/** The prompt shape the review generator sends. Any string would do; this is the real one. */
const SELECTION_PROMPT =
  'ALLOWED_ASPECTS: treatment, team, cleanliness\nSelect the aspects the reviewer cared about.'

const EXERCISES: readonly Exercise[] = [
  {
    key: 'sms',
    provider: 'smsala',
    call: (p) =>
      p.sms.send({
        recipient: '+971528239069',
        body: 'Your appointment is confirmed for 8pm.',
        senderId: { value: 'BERELAX', messageClass: 'transactional' },
        messageClass: 'transactional',
        idempotencyKey: `sms-${Math.random()}`,
      }),
  },
  {
    key: 'email',
    provider: 'resend',
    call: (p) =>
      p.email.send({
        to: { address: 'customer@example.com' },
        from: { address: 'bookings@berelax.example' },
        subject: 'Your appointment',
        html: '<p>Confirmed</p>',
        text: 'Confirmed',
        messageClass: 'transactional',
        idempotencyKey: `email-${Math.random()}`,
      }),
  },
  { key: 'googleOAuth', provider: 'google-oauth', call: (p) => p.googleOAuth.exchangeCode('code') },
  {
    key: 'businessProfile',
    provider: 'google-business-profile',
    call: (p) => p.businessProfile.listReviews('locations/123'),
  },
  {
    key: 'searchConsole',
    provider: 'google-search-console',
    call: (p) =>
      p.searchConsole.queryAnalytics({
        siteUrl: 'https://berelax.example',
        startDate: '2026-09-01',
        endDate: '2026-09-15',
      }),
  },
  {
    key: 'places',
    provider: 'google-places',
    call: (p) =>
      p.places.getPlace({
        placeId: PLACES_FIXTURE_PLACE_ID,
        fieldMask: [...PLACES_AGGREGATE_FIELD_MASK],
      }),
  },
  {
    key: 'llm',
    provider: 'fake-llm',
    call: (p) =>
      p.llm.complete({
        purpose: 'review_reply',
        prompt: 'Draft a reply to a five-star review praising the room.',
        locale: 'en',
        maxOutputTokens: 200,
        idempotencyKey: `llm-${Math.random()}`,
      }),
  },
  {
    key: 'llmFor:fake',
    provider: 'fake-llm',
    call: (p) =>
      p.llmFor('fake').complete({
        purpose: 'review_reply',
        prompt: SELECTION_PROMPT,
        locale: 'en',
        maxOutputTokens: 200,
        idempotencyKey: `llm-fake-${Math.random()}`,
      }),
  },
  {
    key: `llmFor:${DEEPSEEK}`,
    provider: DEEPSEEK,
    call: (p) =>
      p.llmFor(DEEPSEEK).complete({
        purpose: 'review_reply',
        prompt: SELECTION_PROMPT,
        locale: 'en',
        maxOutputTokens: 200,
        idempotencyKey: `llm-deepseek-${Math.random()}`,
      }),
  },
  {
    key: `llmFor:${MINIMAX}`,
    provider: MINIMAX,
    call: (p) =>
      p.llmFor(MINIMAX).complete({
        purpose: 'review_reply',
        prompt: SELECTION_PROMPT,
        locale: 'en',
        maxOutputTokens: 200,
        idempotencyKey: `llm-minimax-${Math.random()}`,
      }),
  },
]

let providers: Providers

beforeEach(() => {
  providers = createProviders({ config: fakeConfig(), now: () => CLOCK })
})

describe('the registry covers every provider the system uses', () => {
  it('exercises every provider on the registry, so none can opt out of the rules below', () => {
    const exercised = new Set(EXERCISES.map((exercise) => exercise.key))
    const onRegistry = (Object.keys(providers) as (keyof Providers)[]).filter(
      (key) => key !== 'calls' && key !== 'failures' && key !== 'llmFor',
    )
    // The providers, plus every name the selector resolves. Both halves, and the size, so a provider
    // added to either place without a row here fails rather than opting out.
    const expected = [...onRegistry, ...BUILT_LLM_PROVIDERS.map((name) => `llmFor:${name}`)]
    expect([...exercised].sort()).toEqual([...expected].sort())
  })
})

describe('rule 1 — no fake returns success without writing to the visible call log', () => {
  for (const exercise of EXERCISES) {
    it(`${exercise.provider} records its successful call`, async () => {
      expect(providers.calls.size).toBe(0)
      await exercise.call(providers)
      const recorded = providers.calls.forProvider(exercise.provider)
      expect(recorded.length, `${exercise.provider} returned success silently`).toBeGreaterThan(0)
      expect(recorded[0]?.outcome).toBe('success')
      // The summary is what an operator reads on the Messages screen. An empty one is a blank row.
      expect(recorded[0]?.summary.length ?? 0).toBeGreaterThan(10)
    })
  }

  it('timestamps every record from the injected clock, so the log is reproducible', async () => {
    await EXERCISES[0]?.call(providers)
    expect(providers.calls.all()[0]?.occurredAtIso).toBe(CLOCK)
  })

  it('numbers records in call order, so the inbox has a stable sort', async () => {
    await EXERCISES[0]?.call(providers)
    await EXERCISES[1]?.call(providers)
    expect(providers.calls.all().map((call) => call.sequence)).toEqual([1, 2])
  })
})

describe('rule 2 — every fake can be made to fail on demand', () => {
  /**
   * Every exercise, because every provider left here HAS an external service that can fail.
   *
   * This was `EXERCISES.filter((e) => e.key !== 'till')` while H02's manual till provider was in the
   * registry: cash at the desk has nothing to call, so it had no provider failure to inject. Y-PAY-02 retired
   * `Providers.till` and `Providers.cards` (the `@berelax/payments` registry owns payments now), and the
   * filter is removed rather than left excluding a key nothing declares — a predicate that can no longer
   * match anything is a filter that has quietly stopped filtering, which is the shape of check this suite
   * exists to refuse. The till adapter that IS real is `createManualGateway` in `@berelax/payments`, and its
   * `hasExternalService: false` is held to a REFUSAL by that package's conformance suite rather than to an
   * exemption (ADR 0055).
   */
  const INJECTABLE = EXERCISES

  for (const exercise of INJECTABLE) {
    for (const mode of FAILURE_MODES) {
      it(`${exercise.provider} fails with ${mode} when armed`, async () => {
        providers.failures.failNext(mode)
        await expect(exercise.call(providers)).rejects.toThrow()
        try {
          providers.failures.clear().failNext(mode)
          await exercise.call(providers)
          expect.unreachable('the armed failure did not fire')
        } catch (error) {
          expect(isAppError(error)).toBe(true)
          expect(failureModeOf(error)).toBe(mode)
        }
      })
    }
  }

  it('records the failure in the log too, so a failed send is visible and not merely thrown', async () => {
    providers.failures.failNext('rate_limited')
    await expect(EXERCISES[0]?.call(providers)).rejects.toThrow()
    const recorded = providers.calls.forProvider('smsala')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.outcome).toBe('failure')
  })

  it('arms a finite number of calls, so a retry path can be tested', async () => {
    providers.failures.failNext('rate_limited', 2)
    await expect(EXERCISES[0]?.call(providers)).rejects.toThrow()
    await expect(EXERCISES[0]?.call(providers)).rejects.toThrow()
    await expect(EXERCISES[0]?.call(providers)).resolves.toBeDefined()
  })

  it('arms every call until cleared, so a dead end can be tested', async () => {
    providers.failures.failAlways('invalid_grant')
    await expect(providers.googleOAuth.refresh('rt')).rejects.toThrow(/invalid_grant/)
    await expect(providers.googleOAuth.refresh('rt')).rejects.toThrow(/invalid_grant/)
    providers.failures.clear()
    await expect(providers.googleOAuth.refresh('rt')).resolves.toBeDefined()
  })

  it('never fires a failure nobody armed', async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(EXERCISES[0]?.call(providers)).resolves.toBeDefined()
    }
  })

  it('distinguishes retryable failures from terminal ones', async () => {
    const terminal: FailureMode[] = ['rejected', 'invalid_grant', 'access_not_granted']
    for (const mode of terminal) {
      providers.failures.clear().failNext(mode)
      try {
        await providers.googleOAuth.exchangeCode('code')
        expect.unreachable('expected a failure')
      } catch (error) {
        expect(isAppError(error) && error.details['retryable']).toBe(false)
      }
    }
  })
})

describe('rule 3 — provider selection is configuration, not code', () => {
  it('defaults every provider to the fake', () => {
    const config = fakeConfig()
    expect(config.SMS_PROVIDER).toBe('fake')
    expect(config.EMAIL_PROVIDER).toBe('fake')
    expect(config.GOOGLE_PROVIDER).toBe('fake')
    expect(config.PAYMENT_PROVIDER).toBe('fake')
    expect(config.LLM_PROVIDER).toBe('fake')
  })

  it('refuses a real provider outside production before the registry is even reached', () => {
    // ADR 0005. This is the guarantee that a staging run cannot message a real customer.
    expect(() =>
      parseConfig({
        APP_ENV: 'staging',
        DATABASE_URL: 'postgres://localhost/berelax',
        SMS_PROVIDER: 'real',
      }),
    ).toThrow(/only production may use real providers/i)
  })

  it('resolves real to a named adapter that refuses, rather than falling back to the fake', () => {
    // A silent fallback is the worst outcome available: a production deploy that looks connected
    // and sends nothing.
    expect(() =>
      createProviders({
        config: parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://localhost/berelax',
          SMS_PROVIDER: 'real',
        }),
        now: () => CLOCK,
      }),
    ).toThrow(/real smsala adapter is not implemented/i)
  })

  it('refuses a prototype key without naming undefined as the unit that builds it', () => {
    // `PENDING` is an object literal, so `PENDING['toString']` is a function off the prototype and not
    // `undefined`. A plain lookup therefore took the branch that names a unit and a prerequisite, and
    // named `undefined` as both — the one failure this message exists to prevent, in the message itself.
    // The key is the value of a `*_PROVIDER` variable an operator sets, so it is outside input.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      try {
        notImplemented(key)
        expect.unreachable('expected a refusal')
      } catch (error) {
        expect(isAppError(error)).toBe(true)
        if (isAppError(error)) {
          expect(error.kind).toBe('provider_unavailable')
          expect(error.message).toContain('No real adapter has been built for it.')
          expect(error.message, key).not.toContain('undefined')
          expect(error.details['unit'], key).toBeUndefined()
        }
      }
    }
    // The control: a key that IS in the table still names its unit, so the guard did not swallow the
    // branch it protects.
    try {
      notImplemented('smsala')
      expect.unreachable('expected a refusal')
    } catch (error) {
      if (isAppError(error)) expect(String(error.details['unit'])).toBe('B-MSG')
    }
  })

  it('names the unit and the prerequisite in the refusal, so the message is actionable', () => {
    // Driven through SMS_PROVIDER since Y-PAY-02 retired `Providers.cards`: this registry no longer reads
    // `PAYMENT_PROVIDER` at all, so posing the question with that key would have asserted something about
    // whichever OTHER provider happened to refuse first. The payments half of the same claim is
    // `packages/payments/src/registry.test.ts`, which asserts it for `PAYMENT_PROVIDER` specifically — and
    // gate case 133v is the known-bad fixture that keeps it there. What is asserted here is that the
    // mechanism names a unit and a prerequisite at all, which is a property of `notImplemented`.
    //
    // GOOGLE_PROVIDER was tried first and threw `validation` rather than `provider_unavailable`: real Google
    // needs credentials this configuration does not carry, so it is refused before the registry names a
    // pending integration. SMS is the key whose real adapter is genuinely just unbuilt.
    try {
      createProviders({
        config: parseConfig({
          APP_ENV: 'production',
          DATABASE_URL: 'postgres://localhost/berelax',
          SMS_PROVIDER: 'real',
        }),
        now: () => CLOCK,
      })
      expect.unreachable('expected a refusal')
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      if (isAppError(error)) {
        expect(error.kind).toBe('provider_unavailable')
        expect(String(error.details['unit'])).not.toBe('')
        expect(String(error.details['needs'])).not.toBe('')
      }
    }
  })

  it('shares one call log across every provider, so the admin has one inbox', async () => {
    // BY KEY and not by index. This read `EXERCISES[0]` and `EXERCISES[7]`, and when Y-PAY-02 retired the
    // two payment exercises `[7]` silently became undefined — `await undefined?.call(...)` is a no-op, so the
    // set would have held ONE provider and the case would have failed naming the wrong thing. An index into
    // a table other units append to is a reference that moves without being edited.
    const byKey = (key: string) => EXERCISES.find((exercise) => exercise.key === key)
    const first = byKey('sms')
    const second = byKey('llm')
    expect(first, 'the sms exercise is gone').toBeDefined()
    expect(second, 'the llm exercise is gone').toBeDefined()
    await first?.call(providers)
    await second?.call(providers)
    const providerNames = new Set(providers.calls.all().map((call) => call.provider))
    expect(providerNames.size).toBe(2)
  })
})
