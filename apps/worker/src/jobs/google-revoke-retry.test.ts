import { APP_ENVS, isProduction, parseConfig } from '@berelax/config'
import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { JOB_REGISTRY } from '../registry.ts'
import {
  announceRevokeRetry,
  GOOGLE_REVOKE_RETRY_JOB,
  GOOGLE_REVOKE_RETRY_QUEUE,
  REVOKE_RETRY_ACTOR,
  revokeOAuthFor,
} from './google-revoke-retry.ts'

/**
 * G-CONN-09 — the environment guard at the revocation seam, and the shape of the retry queue.
 *
 * ## Why the environment guard is re-asserted here and not only in `packages/config`
 *
 * Because at *this* seam the consequence is different in kind. Everywhere else a real provider outside
 * production means a real message to a real client — bad, visible, and recoverable with an apology. Here it
 * means **a staging deploy revoking the production owner's Google grant**: the review autoresponder, the
 * SEO agent and the consistency check all stop at once, and the only fix is the owner re-consenting, which
 * needs the owner. The mirror case is worse still: a revocation sent to a *stand-in* is reported as
 * success, after which the disconnect erases the only credential that could have performed it for real.
 *
 * So both layers are driven, and the point of driving both is that no configuration of them reaches Google:
 * `parseConfig` refuses `GOOGLE_PROVIDER=real` outside `APP_ENV=production`, and `revokeOAuthFor` refuses it
 * even *inside* production while no real adapter exists. Each has a control, because a refusal that refuses
 * everything proves nothing about what it was meant to refuse.
 *
 * The sweep itself is proved in `packages/google/src/disconnect.test.ts`, which is where the store and the
 * sealing live. There is nothing to gain from re-driving it through a one-line delegate here, and reaching
 * the token accessors from this package to build a fixture would mean importing across a boundary that
 * exists to stop exactly that.
 */

const base = { APP_ENV: 'development', DATABASE_URL: 'postgres://u:p@localhost:5432/db' }

/** What a production configuration selecting the real provider would have to look like. */
const productionReal = {
  ...base,
  APP_ENV: 'production',
  GOOGLE_PROVIDER: 'real',
  GOOGLE_OAUTH_CLIENT_ID: 'gate-fixture.apps.googleusercontent.com',
  // Not a credential and not shaped like one. `parseConfig` only requires the key to be present, and a
  // plausible-looking secret in a test file is what the brief's rule 15 refuses: blank is visibly
  // unanswered, plausible is indistinguishable from configured.
  GOOGLE_OAUTH_CLIENT_SECRET: 'unset-see-H-HARD-03',
}

describe('the process refuses to boot with GOOGLE_PROVIDER=real outside production', () => {
  for (const env of APP_ENVS.filter((e) => !isProduction(e))) {
    it(`refuses APP_ENV=${env}`, () => {
      // Asserted by the key in the message rather than by a bare throw: `parseConfig` reports every problem
      // at once, so a throw alone could just as easily be about a missing DATABASE_URL.
      expect(() => parseConfig({ ...base, APP_ENV: env, GOOGLE_PROVIDER: 'real' })).toThrow(
        /GOOGLE_PROVIDER=real is refused/,
      )
    })
  }

  it('the control: the same configuration with the fake provider boots in every environment', () => {
    // Without this, the loop above is satisfied by a `parseConfig` that refuses everything.
    for (const env of APP_ENVS) {
      expect(() => parseConfig({ ...base, APP_ENV: env, GOOGLE_PROVIDER: 'fake' })).not.toThrow()
    }
  })

  it('the control: production with the real provider and its credentials DOES parse', () => {
    // The guard is about the environment, not about the value. If this threw, the loop above would be
    // proving that `real` is refused everywhere — a different and much weaker claim, and one that would go
    // on passing after somebody made the real adapter work.
    expect(() => parseConfig(productionReal)).not.toThrow()
  })
})

describe('the revocation seam refuses the real provider even in production', () => {
  it('throws rather than revoking against a stand-in', () => {
    const config = parseConfig(productionReal)
    try {
      revokeOAuthFor(config)
      expect.unreachable('a real revocation must not resolve to a stand-in')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).details['reason']).toBe('google_revoke_provider_unavailable')
      // The message has to say that nothing happened. An operator who reads "failed" and assumes the
      // revocation went through is the person who then erases the credential by hand.
      expect((error as AppError).message).toContain('Nothing was revoked')
    }
  })

  it('the control: the fake provider resolves, and its revocation endpoint answers', async () => {
    const oauth = revokeOAuthFor(parseConfig({ ...base, GOOGLE_PROVIDER: 'fake' }))
    await expect(oauth.revoke('1//09-fixture-token')).resolves.toBe('revoked')
    // And a second revocation of the same token is the idempotent answer rather than a failure — which is
    // what makes re-running a half-finished disconnect safe.
    await expect(oauth.revoke('1//09-fixture-token')).resolves.toBe('already_revoked')
  })

  it('a revoked grant can no longer be refreshed, so the fake is not merely recording the call', async () => {
    const oauth = revokeOAuthFor(parseConfig({ ...base, GOOGLE_PROVIDER: 'fake' }))
    await oauth.revoke('1//09-fixture-token-2')
    await expect(oauth.refresh('1//09-fixture-token-2')).rejects.toThrow(/invalid_grant/)
  })
})

describe('the retry queue', () => {
  it('is registered, and has no cron because the disconnect announces it', () => {
    const registered = JOB_REGISTRY.find((job) => job.name === GOOGLE_REVOKE_RETRY_QUEUE)
    expect(registered).toBeDefined()
    // A cron would need an `agent_definition` with a heartbeat the watchdog joins to, and it would be a
    // poller looking for work an enqueue already announced. `assertRegistry` enforces the first half of
    // that, and `worker.itest.ts` asserts the registered set equals this registry in both directions.
    expect(registered?.cron).toBeUndefined()
    expect(registered?.agent).toBeUndefined()
  })

  it('retries for about a day, because a live grant is not a thing to stop chasing', () => {
    // Three attempts at thirty seconds is the house default and is wrong here: a Google outage outlasts it,
    // and what is left behind is a grant with business.manage on the listing held by somebody who has left.
    expect(GOOGLE_REVOKE_RETRY_JOB.retryLimit).toBeGreaterThanOrEqual(10)
    expect(GOOGLE_REVOKE_RETRY_JOB.retryBackoff).toBe(true)
    expect(GOOGLE_REVOKE_RETRY_JOB.retryDelaySeconds).toBeGreaterThanOrEqual(30)
  })

  it('names itself as the actor, so the audit row does not read "system" and nothing else', () => {
    expect(REVOKE_RETRY_ACTOR.kind).toBe('system')
    expect(REVOKE_RETRY_ACTOR.label).toBe(GOOGLE_REVOKE_RETRY_QUEUE)
  })

  it('announces itself with the connection id and nothing else', async () => {
    // docs/10 §4 names a pg-boss job payload as one of the six places a token must never appear: a job is
    // a row, and rows reach query logs, pg_stat_statements, backups and the job table's own retention.
    const sent: { queue: string; data: unknown; options: { singletonKey: string } }[] = []
    const announce = announceRevokeRetry(async (queue, data, options) => {
      sent.push({ queue, data, options })
    })
    const id = '01920000-0000-7000-8000-0000000000e1'
    await announce(id)
    expect(sent).toEqual([
      {
        queue: GOOGLE_REVOKE_RETRY_QUEUE,
        data: { connectionId: id },
        // Keyed on the connection, so three clicks against a Google outage queue one retry rather than
        // three that each revoke the same token.
        options: { singletonKey: id },
      },
    ])
    expect(Object.keys(sent[0]?.data as object)).toEqual(['connectionId'])
  })
})
