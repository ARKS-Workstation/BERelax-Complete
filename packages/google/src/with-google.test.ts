import { generateKek } from '@berelax/clinical'
import { fixedClock, type GoogleCapability, instantFromIso } from '@berelax/core'
import { createCallLog } from '@berelax/providers/call-log'
import {
  FAILURE_MODES,
  type FailureMode,
  FailureScript,
  failureError,
} from '@berelax/providers/failure'
import { createFakeBusinessProfile, createFakeGoogleOAuth } from '@berelax/providers/google'
import { AppError } from '@berelax/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  CONSUMERS,
  type ConsumerDeclaration,
  type DeclaredCapability,
  declarationFor,
  indexByCapability,
  isDeclaredCapability,
} from './consumers.ts'
import {
  capabilityHealthFor,
  classifyGoogleError,
  DEGRADES,
  FAILURE_MODE_CLASS,
  GOOGLE_ERROR_CLASSES,
  type GoogleErrorClass,
  isRetryableGoogleError,
  upstreamFingerprint,
} from './errors.ts'
import { connectionRecord, createMemoryConnectionStore } from './memory-store.ts'
import { connectionBinding, sealToken } from './token-store.ts'
import {
  type GoogleErrorSink,
  type GoogleLogLine,
  type WithGoogleDeps,
  withGoogle,
} from './with-google.ts'

/**
 * G-CONN-03 — the chokepoint, the taxonomy and declared degradation.
 *
 * The test in here that is most likely to pass for the wrong reason is the leak detector, so it carries a
 * control that deliberately logs the token: a detector pointed at the wrong surface reports zero for ever,
 * and zero is exactly what a passing test looks like.
 */
const KEK = generateKek('v1')
const NOW_ISO = '2026-09-18T10:00:00.000Z'
const CONNECTION_ID = '01920000-0000-7000-8000-00000000000a'
const SUB = '104729518362094771533'

/**
 * Long, distinctive and shaped like Google's, so a partial leak is still visible.
 *
 * Google's refresh tokens begin `1//`, which is also why the comment stripper in
 * `scripts/check-google-token-chokepoint.mjs` has to leave a `//` inside a string alone.
 */
const REFRESH_TOKEN = '1//09-FIXTURE-refresh-token-that-must-never-be-logged'

const binding = connectionBinding({ connectionId: CONNECTION_ID, googleSub: SUB })

const RESOURCE: Readonly<Record<GoogleCapability, Record<string, unknown>>> = {
  gbp_reviews: { account: 'accounts/1', location: 'locations/2', placeId: 'ChIJ-fixture' },
  gbp_location: { account: 'accounts/1', location: 'locations/2', placeId: 'ChIJ-fixture' },
  gbp_performance: { account: 'accounts/1', location: 'locations/2', placeId: 'ChIJ-fixture' },
  gsc: { siteUrl: 'https://berelax.ae/' },
}

/** Everything a call emitted, on every surface a token could reach. */
interface Capture {
  readonly lines: GoogleLogLine[]
  readonly breadcrumbs: unknown[]
  readonly captured: { readonly error: unknown; readonly context: unknown }[]
}

function newCapture(): Capture {
  return { lines: [], breadcrumbs: [], captured: [] }
}

function sink(capture: Capture): GoogleErrorSink {
  return {
    addBreadcrumb(crumb) {
      capture.breadcrumbs.push(crumb)
    },
    captureException(error, context) {
      capture.captured.push({ error, context })
    },
  }
}

/**
 * Counts occurrences of a secret across **every** captured surface.
 *
 * The six docs/10 §4 names: a log line at any level, an error message, a serialised stack trace, a Sentry
 * breadcrumb, a row and a job payload. The first four are here; the row is refused by a CHECK constraint
 * and asserted in `with-google.itest.ts`, and the payload is G-CONN-04's.
 *
 * A stack is serialised explicitly rather than left to `JSON.stringify`, which omits `message` and `stack`
 * on an Error — a detector that only stringified would look at `{}` and report zero.
 */
function occurrences(capture: Capture, secret: string): number {
  const serialised: string[] = []
  for (const line of capture.lines) {
    serialised.push(line.level, line.message, JSON.stringify(line))
  }
  for (const crumb of capture.breadcrumbs) serialised.push(JSON.stringify(crumb))
  for (const { error, context } of capture.captured) {
    serialised.push(JSON.stringify(context))
    serialised.push(String(error))
    if (error instanceof Error) {
      serialised.push(error.message, error.stack ?? '')
      let cause: unknown = (error as { cause?: unknown }).cause
      while (cause !== undefined && cause !== null) {
        serialised.push(String(cause))
        if (cause instanceof Error) serialised.push(cause.message, cause.stack ?? '')
        cause = (cause as { cause?: unknown }).cause
      }
    }
    if (error instanceof AppError) serialised.push(JSON.stringify(error.details))
  }
  return serialised.filter((text) => text.includes(secret)).length
}

interface Harness {
  readonly deps: WithGoogleDeps
  readonly oauthFailures: FailureScript
  readonly apiFailures: FailureScript
  readonly capture: Capture
  readonly store: ReturnType<typeof createMemoryConnectionStore>
  readonly profile: ReturnType<typeof createFakeBusinessProfile>
  readonly providerLog: ReturnType<typeof createCallLog>
  correlation: number
}

function harness(
  options: {
    readonly status?: 'active' | 'needs_reauth'
    readonly capabilities?: readonly GoogleCapability[]
    readonly withResource?: boolean
  } = {},
): Harness {
  const capture = newCapture()
  // Two scripts, not one. `accessTokenFor` calls `oauth.refresh` before the body runs, so a single script
  // would have the token refresh swallow the failure meant for the API call — and the taxonomy case would
  // silently become a different one.
  const oauthFailures = new FailureScript()
  const apiFailures = new FailureScript()
  const providerLog = createCallLog(() => NOW_ISO)

  const store = createMemoryConnectionStore([
    connectionRecord({
      id: CONNECTION_ID,
      googleSub: SUB,
      googleEmail: 'google-admin@berelax.ae',
      refreshToken: sealToken(KEK, binding, REFRESH_TOKEN),
      consentAt: instantFromIso('2026-09-17T10:00:00.000Z'),
      status: options.status ?? 'active',
      statusReason: options.status === 'needs_reauth' ? 'invalid_grant' : null,
    }),
  ])
  for (const capability of options.capabilities ?? ['gbp_reviews']) {
    store.putCapability({
      connectionId: CONNECTION_ID,
      capability,
      resourceRef: (options.withResource ?? true) ? RESOURCE[capability] : null,
      health: 'unknown',
      isPrimary: true,
    })
  }

  const self: Harness = {
    oauthFailures,
    apiFailures,
    capture,
    store,
    providerLog,
    correlation: 0,
    profile: createFakeBusinessProfile({
      log: providerLog,
      failures: apiFailures,
      now: () => NOW_ISO,
    }),
    deps: {
      store,
      oauth: createFakeGoogleOAuth({
        log: providerLog,
        failures: oauthFailures,
        now: () => NOW_ISO,
        sub: SUB,
      }),
      kek: KEK,
      clock: fixedClock(NOW_ISO),
      logger: {
        log(line) {
          capture.lines.push(line)
        },
      },
      errors: sink(capture),
      newCorrelationId: () => {
        self.correlation += 1
        return `corr-${String(self.correlation).padStart(3, '0')}`
      },
    },
  }
  return self
}

let h: Harness

beforeEach(() => {
  h = harness()
})

describe('the CONSUMERS table is the only place a consumer names what it needs', () => {
  it('matches docs/10 §2 row for row', () => {
    expect(CONSUMERS.reviewAutoresponder.capability).toBe('gbp_reviews')
    expect(CONSUMERS.reviewAutoresponder.degradesTo).toBe('draft_only')
    expect(CONSUMERS.seoAgent.capability).toBe('gsc')
    expect(CONSUMERS.seoAgent.degradesTo).toBe('disabled')
    expect(CONSUMERS.localSeoChecker.capability).toBe('gbp_location')
    expect(CONSUMERS.localSeoChecker.degradesTo).toBe('manual_snapshot')
  })

  it('refuses two consumers declaring one capability, because the mode would resolve by iteration order', () => {
    const colliding: Record<string, ConsumerDeclaration> = {
      reviewAutoresponder: CONSUMERS.reviewAutoresponder,
      secondReviewThing: { ...CONSUMERS.reviewAutoresponder, degradesTo: 'disabled' },
    }
    expect(() => indexByCapability(colliding)).toThrow(AppError)
  })

  it('accepts the shipped table, so the refusal above is strictness and not breakage', () => {
    // The control. A guard that rejected everything would make the collision case pass for free.
    expect(() => indexByCapability(CONSUMERS)).not.toThrow()
    expect(indexByCapability(CONSUMERS).size).toBe(3)
  })

  it('refuses a capability no consumer declares, rather than inventing a degraded mode for it', () => {
    expect(isDeclaredCapability('gbp_performance')).toBe(false)
    expect(() => declarationFor('gbp_performance')).toThrow(AppError)
    // The control: the three declared ones resolve.
    for (const capability of ['gbp_reviews', 'gsc', 'gbp_location'] as const) {
      expect(isDeclaredCapability(capability)).toBe(true)
      expect(declarationFor(capability).capability).toBe(capability)
    }
  })
})

describe('the error taxonomy', () => {
  it('maps every fake fault code to exactly one named class', () => {
    for (const mode of FAILURE_MODES) {
      const classified = classifyGoogleError(failureError('google-business-profile', mode))
      expect(GOOGLE_ERROR_CLASSES).toContain(classified)
      expect(classified).toBe(FAILURE_MODE_CLASS[mode])
    }
  })

  it('reaches every one of the seven classes from some fake fault code', () => {
    // The control that makes the case above mean something. A classifier that returned one constant would
    // satisfy "maps to exactly one class" perfectly, and this is what catches it.
    const reached = new Set(
      FAILURE_MODES.map((mode) => classifyGoogleError(failureError('x', mode))),
    )
    expect([...reached].sort()).toEqual([...GOOGLE_ERROR_CLASSES].sort())
  })

  it('maps an unmapped upstream code to TransientUpstream rather than swallowing it', () => {
    const unheardOf = new AppError('provider_unavailable', 'the upstream said something new', {
      details: { upstreamCode: 'MOON_PHASE_UNSUPPORTED' },
    })
    expect(classifyGoogleError(unheardOf)).toBe('TransientUpstream')
    // And a bare object with a code, which is how a Node-level failure arrives.
    expect(classifyGoogleError({ code: 'ECONNRESET' })).toBe('TransientUpstream')
    expect(classifyGoogleError('a string nobody expected')).toBe('TransientUpstream')
  })

  it('does not classify a code it DOES know as TransientUpstream', () => {
    // The pair for the case above: without it, a classifier hard-wired to TransientUpstream passes.
    expect(classifyGoogleError({ code: 'ADMIN_POLICY_ENFORCED' })).toBe('AdminPolicyEnforced')
    expect(
      classifyGoogleError(
        new AppError('forbidden', 'nope', { details: { reason: 'google_reauth_required' } }),
      ),
    ).toBe('GoogleReauthRequired')
    expect(classifyGoogleError({ reason: 'dailyLimitExceeded' })).toBe('QuotaZero')
  })

  it('keeps the retry decision separate from the class name', () => {
    // TransientUpstream is a residue, not a promise about retryability: `rejected` lands there and is
    // final. A caller reading the class name as a retry policy would spin on it.
    expect(FAILURE_MODE_CLASS.rejected).toBe('TransientUpstream')
    expect(isRetryableGoogleError(failureError('x', 'rejected'))).toBe(false)
    expect(isRetryableGoogleError(failureError('x', 'server_error'))).toBe(true)
    expect(isRetryableGoogleError(failureError('x', 'invalid_grant'))).toBe(false)
  })

  it('fingerprints what failed without carrying anything that could be a secret', () => {
    expect(upstreamFingerprint(failureError('google-business-profile', 'quota_exhausted'))).toEqual(
      {
        upstreamKind: 'AppError',
        errorKind: 'rate_limited',
        failureMode: 'quota_exhausted',
        sqlState: null,
      },
    )
    // The value that would have named this unit's own hour of debugging: 53300 is too_many_connections,
    // raised when another worktree's integration suite holds the server's connections.
    const pgish = Object.assign(new Error('connection failure'), { code: '53300' })
    expect(upstreamFingerprint(pgish).sqlState).toBe('53300')
    expect(upstreamFingerprint('a thrown string').upstreamKind).toBe('string')
  })

  it('refuses a token-shaped code, which is why the guard is a pattern and not a truncation', () => {
    // THE control on the fingerprint. The first 64 characters of a bearer token are still most of a
    // token, so a length cap would not have been safe; five uppercase alphanumerics cannot be one.
    const leaky = Object.assign(new Error('upstream'), {
      code: '1//09-a-refresh-token-in-a-code-field',
    })
    const fingerprint = upstreamFingerprint(leaky)
    expect(fingerprint.sqlState).toBeNull()
    expect(JSON.stringify(fingerprint)).not.toContain('1//09')
    // …and a plausible-looking but wrong-shaped SQLSTATE is refused too, so the pattern does work.
    expect(
      upstreamFingerprint(Object.assign(new Error('x'), { code: '533000' })).sqlState,
    ).toBeNull()
  })

  it('writes capability health only where the failure is evidence about the capability', () => {
    expect(capabilityHealthFor('AccessNotGranted')).toBe('quota_zero')
    expect(capabilityHealthFor('QuotaZero')).toBe('quota_zero')
    expect(capabilityHealthFor('ListingNotVerified')).toBe('not_verified')
    expect(capabilityHealthFor('AdminPolicyEnforced')).toBe('permission_missing')
    // A blip says nothing about the capability, and a dead grant says nothing about it either.
    expect(capabilityHealthFor('RateLimited')).toBeNull()
    expect(capabilityHealthFor('TransientUpstream')).toBeNull()
    expect(capabilityHealthFor('GoogleReauthRequired')).toBeNull()
  })
})

describe('declared degradation, not throwing', () => {
  const DECLARED: readonly (readonly [DeclaredCapability, string])[] = [
    ['gbp_reviews', 'draft_only'],
    ['gsc', 'disabled'],
    ['gbp_location', 'manual_snapshot'],
  ]

  for (const [capability, mode] of DECLARED) {
    it(`resolves ${capability} to ${mode} under access_not_granted, and does not throw`, async () => {
      const local = harness({ capabilities: [capability] })
      local.apiFailures.failAlways('access_not_granted')

      const outcome = await withGoogle(local.deps, capability, async () =>
        local.profile.listReviews('locations/2'),
      )

      expect(outcome.kind).toBe('degraded')
      if (outcome.kind !== 'degraded') throw new Error('unreachable')
      expect(outcome.mode).toBe(mode)
      expect(outcome.cause).toBe('AccessNotGranted')
      expect(outcome.capability).toBe(capability)
    })
  }

  it('none of the three throws, asserted as one statement over all three', async () => {
    // Asserted separately from the per-capability cases because "did not throw" is the claim docs/10 §4
    // actually makes, and a per-case `expect(...).toBe('degraded')` would still pass if one of them
    // threw and the runner reported the other two.
    const results = await Promise.allSettled(
      DECLARED.map(async ([capability]) => {
        const local = harness({ capabilities: [capability] })
        local.apiFailures.failAlways('access_not_granted')
        return withGoogle(local.deps, capability, async () => local.profile.listReviews('x'))
      }),
    )
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled'])
  })

  it('degrades a dead grant rather than throwing, and never re-consents on its own', async () => {
    const local = harness({ status: 'needs_reauth' })
    const outcome = await withGoogle(local.deps, 'gbp_reviews', async () => 'unreachable')
    expect(outcome.kind).toBe('degraded')
    if (outcome.kind !== 'degraded') throw new Error('unreachable')
    expect(outcome.cause).toBe('GoogleReauthRequired')
    expect(outcome.mode).toBe('draft_only')
  })

  it('throws for a rate limit, so the queue retries instead of degrading for a minute', async () => {
    h.apiFailures.failAlways('rate_limited')
    await expect(
      withGoogle(h.deps, 'gbp_reviews', async () => h.profile.listReviews('x')),
    ).rejects.toThrow(AppError)
    // The control for the degradation cases: if everything degraded, none of them would mean anything.
    expect(DEGRADES.RateLimited).toBe(false)
    expect(DEGRADES.AccessNotGranted).toBe(true)
  })

  it('degrades when nothing is connected, because the fallback is the launch mode', async () => {
    const empty = createMemoryConnectionStore([])
    const outcome = await withGoogle(
      { ...h.deps, store: empty },
      'gbp_reviews',
      async () => 'unreachable',
    )
    expect(outcome.kind).toBe('degraded')
    if (outcome.kind !== 'degraded') throw new Error('unreachable')
    expect(outcome.cause).toBe('NotConnected')
    expect(outcome.connectionId).toBeNull()
  })

  it('degrades when a capability exists but no resource has been selected on it', async () => {
    const local = harness({ withResource: false })
    const outcome = await withGoogle(local.deps, 'gbp_reviews', async () => 'unreachable')
    expect(outcome.kind).toBe('degraded')
    if (outcome.kind !== 'degraded') throw new Error('unreachable')
    expect(outcome.cause).toBe('ResourceNotSelected')
  })

  it('passes the resolved resource and a token to the body on the happy path', async () => {
    const outcome = await withGoogle(h.deps, 'gbp_reviews', async (context) => {
      expect(context.resourceRef).toEqual(RESOURCE.gbp_reviews)
      expect(context.accessToken).toMatch(/^fake-access-/)
      expect(context.correlationId).toBe('corr-001')
      return (await h.profile.listReviews('locations/2')).length
    })
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') throw new Error('unreachable')
    expect(outcome.value).toBeGreaterThan(0)
    expect(outcome.consumer).toBe('reviewAutoresponder')
  })
})

describe('every failure that affects a capability is recorded where a human reads it', () => {
  it('appends a connection event naming the capability, the class and the degraded mode', async () => {
    h.apiFailures.failAlways('access_not_granted')
    const before = h.store.events().length
    await withGoogle(h.deps, 'gbp_reviews', async () => h.profile.listReviews('x'))
    // A delta, never a total: the refresh that preceded the call wrote its own event.
    const added = h.store.events().slice(before)
    const failure = added.find((event) => event.event === 'health_check_failed')
    expect(failure?.detail).toMatchObject({
      capability: 'gbp_reviews',
      consumer: 'reviewAutoresponder',
      errorClass: 'AccessNotGranted',
      degradedTo: 'draft_only',
      source: 'withGoogle',
      // What the class alone cannot say: which shape of error produced it.
      upstreamKind: 'AppError',
      errorKind: 'forbidden',
      failureMode: 'access_not_granted',
      sqlState: null,
    })
  })

  it('moves the capability health so the panel stops showing it as fine', async () => {
    h.apiFailures.failAlways('not_verified')
    await withGoogle(h.deps, 'gbp_reviews', async () => h.profile.listReviews('x'))
    const [capability] = await h.store.capabilitiesFor(CONNECTION_ID)
    expect(capability?.health).toBe('not_verified')
  })

  it('leaves the health alone for a rate limit, which is evidence of nothing', async () => {
    // The control for the case above. A ledger that downgraded health on every failure would paint a
    // working capability amber on the strength of one throttled call.
    h.apiFailures.failAlways('rate_limited')
    await expect(
      withGoogle(h.deps, 'gbp_reviews', async () => h.profile.listReviews('x')),
    ).rejects.toThrow()
    const [capability] = await h.store.capabilitiesFor(CONNECTION_ID)
    expect(capability?.health).toBe('unknown')
    // …but the failure is still recorded, because the dashboard has to be able to show it happened.
    expect(h.store.events().some((event) => event.event === 'health_check_failed')).toBe(true)
  })
})

describe('structured logging and the correlation id', () => {
  it('gives every line of one call the same id, and one group per call', async () => {
    h.apiFailures.failNext('access_not_granted')
    await withGoogle(h.deps, 'gbp_reviews', async () => h.profile.listReviews('x'))
    await withGoogle(h.deps, 'gbp_reviews', async () => h.profile.listReviews('x'))
    await withGoogle(h.deps, 'gbp_reviews', async () => h.profile.listReviews('x'))

    const groups = new Map<string, GoogleLogLine[]>()
    for (const line of h.capture.lines) {
      groups.set(line.correlationId, [...(groups.get(line.correlationId) ?? []), line])
    }

    expect(groups.size).toBe(3)
    for (const lines of groups.values()) {
      expect(lines.length).toBeGreaterThanOrEqual(2)
      expect(new Set(lines.map((line) => line.capability))).toEqual(new Set(['gbp_reviews']))
      expect(new Set(lines.map((line) => line.consumer))).toEqual(new Set(['reviewAutoresponder']))
      // The connection id is null on the opening line — nothing has been resolved yet — and the
      // connection's own id afterwards. Asserting "always present" would be asserting a lie.
      expect(new Set(lines.map((line) => line.connectionId))).toEqual(
        new Set([null, CONNECTION_ID]),
      )
    }
  })

  it('detects a line that escaped its call, so the grouping above cannot pass vacuously', () => {
    const stray: GoogleLogLine = {
      level: 'info',
      message: 'a line with nobody to belong to',
      correlationId: 'corr-999',
      capability: 'gbp_reviews',
      consumer: 'reviewAutoresponder',
      connectionId: CONNECTION_ID,
      fields: {},
    }
    const lines = [...h.capture.lines, stray]
    expect(new Set(lines.map((line) => line.correlationId)).size).toBe(
      new Set(h.capture.lines.map((line) => line.correlationId)).size + 1,
    )
  })
})

describe('the token never leaks', () => {
  /**
   * Every taxonomy case, driven end to end.
   *
   * `invalid_grant` is armed on the OAuth fake because that is where it actually happens — the refresh
   * fails and the body never runs — and separately on the API fake, because a 401 from a Google API is a
   * different code path reaching the same class.
   */
  const UNMAPPED = 'an unmapped upstream code'
  const CASES: readonly (readonly [string, (h: Harness) => void, GoogleErrorClass | null])[] = [
    [
      'invalid_grant at refresh',
      (x) => x.oauthFailures.failAlways('invalid_grant'),
      'GoogleReauthRequired',
    ],
    ...FAILURE_MODES.map(
      (mode: FailureMode) =>
        [
          `${mode} from the API`,
          (x: Harness) => x.apiFailures.failAlways(mode),
          FAILURE_MODE_CLASS[mode],
        ] as const,
    ),
    [UNMAPPED, () => {}, 'TransientUpstream'],
    // The happy path belongs in the sweep too: a token that leaks only when the call SUCCEEDS is the
    // one a suite of failure cases would never see.
    ['a successful call', () => {}, null],
  ]

  it('drives every taxonomy case and finds the fixture token on no surface at any level', async () => {
    const seenAccessTokens: string[] = []
    const capture = newCapture()
    const classes = new Set<GoogleErrorClass>()

    for (const [label, arm, expected] of CASES) {
      const local = harness()
      arm(local)
      // Everything a call emits goes into ONE capture, so the assertion is over the whole run rather than
      // over the last case — a per-case assertion would be satisfied by a leak in any earlier one.
      const shared: WithGoogleDeps = {
        ...local.deps,
        logger: {
          log(line) {
            capture.lines.push(line)
          },
        },
        errors: sink(capture),
      }

      let observed: GoogleErrorClass | null = null
      try {
        const outcome = await withGoogle(shared, 'gbp_reviews', async (context) => {
          seenAccessTokens.push(context.accessToken)
          if (label === UNMAPPED) {
            throw new AppError('provider_unavailable', 'upstream said something new', {
              details: { upstreamCode: 'MOON_PHASE_UNSUPPORTED' },
            })
          }
          return local.profile.listReviews('locations/2')
        })
        if (outcome.kind === 'degraded') observed = outcome.cause as GoogleErrorClass
      } catch (error) {
        observed = (error as AppError).details['errorClass'] as GoogleErrorClass
      }

      expect([label, observed]).toEqual([label, expected])
      if (observed !== null) classes.add(observed)
    }

    // Every class was actually exercised, so "zero occurrences" is a statement about all seven rather
    // than about whichever ones happened to run.
    for (const errorClass of GOOGLE_ERROR_CLASSES) expect([...classes]).toContain(errorClass)
    expect(seenAccessTokens.length).toBeGreaterThan(0)

    expect(occurrences(capture, REFRESH_TOKEN)).toBe(0)
    for (const accessToken of seenAccessTokens) {
      expect(occurrences(capture, accessToken)).toBe(0)
    }
    // Not even a prefix of it. A truncated token is still most of a token.
    expect(occurrences(capture, REFRESH_TOKEN.slice(0, 20))).toBe(0)
  })

  it('catches a deliberately logged token, so a detector looking in the wrong place cannot pass', () => {
    // THE control. Without it, a detector that serialised the wrong field would report zero for ever and
    // the case above would be a test that cannot fail.
    const capture = newCapture()
    capture.lines.push({
      level: 'debug',
      message: `refreshing with ${REFRESH_TOKEN}`,
      correlationId: 'corr-control',
      capability: 'gbp_reviews',
      consumer: 'reviewAutoresponder',
      connectionId: CONNECTION_ID,
      fields: {},
    })
    expect(occurrences(capture, REFRESH_TOKEN)).toBeGreaterThan(0)
  })

  it('catches a token hidden in a log line FIELD rather than in its message', () => {
    const capture = newCapture()
    capture.lines.push({
      level: 'info',
      message: 'google call started',
      correlationId: 'corr-control',
      capability: 'gbp_reviews',
      consumer: 'reviewAutoresponder',
      connectionId: CONNECTION_ID,
      fields: { debugging: { nested: REFRESH_TOKEN } },
    })
    expect(occurrences(capture, REFRESH_TOKEN)).toBeGreaterThan(0)
  })

  it('catches a token in a breadcrumb, in a stack trace and in a cause chain', () => {
    const capture = newCapture()
    capture.breadcrumbs.push({ category: 'google', message: `token=${REFRESH_TOKEN}` })
    expect(occurrences(capture, REFRESH_TOKEN)).toBe(1)

    const withCause = new AppError('provider_unavailable', 'wrapped', {
      cause: new Error(`upstream rejected ${REFRESH_TOKEN}`),
    })
    capture.captured.push({ error: withCause, context: { tags: {} } })
    // The cause chain is the one a naive detector misses: the outer message is clean.
    expect(withCause.message).not.toContain(REFRESH_TOKEN)
    expect(occurrences(capture, REFRESH_TOKEN)).toBeGreaterThan(1)
  })

  it('keeps the token out of the provider call log too', async () => {
    // The surface a detector pointed only at its own logger would never look at — and the one that was
    // leaking: the OAuth fake recorded the refresh token in its call-log detail, which the admin pane
    // renders and the screenshot harness photographs.
    await withGoogle(h.deps, 'gbp_reviews', async () => h.profile.listReviews('x'))
    const serialised = JSON.stringify(h.providerLog.all())
    expect(serialised).not.toContain(REFRESH_TOKEN)
    expect(serialised.length).toBeGreaterThan(2)
  })
})
