import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { instantFromIso } from '@berelax/core'
import type { ReauthNoticeDecision, ReauthPassResult } from '@berelax/google'
import { describe, expect, it } from 'vitest'
import {
  NO_STAFF_CONTACT_ON_FILE,
  reauthNotifyLogLine,
  runReauthNotifyPass,
  SCHEDULED_REAUTH_NOTIFY,
} from './google-reauth-notify.ts'

/**
 * G-CONN-08 — the sending half, at the seams a unit test can hold.
 *
 * Three claims, and none of them needs a database:
 *
 *  1. **The 03:00 pass and the notice pass are ONE call.** The ladder's cadence after its first rung is
 *     daily, which is the deep check's cadence, so a second cron would be a second poller asking a question
 *     the first had just answered. The identity is asserted rather than reviewed — G-CONN-07's arrangement
 *     for `TEST_CONNECTION_PASS` — and a lookalike control proves the assertion can fail.
 *  2. **The shipped recipient resolver answers null, for every role and every channel.** That is the
 *     honest value and not an omission: no table in this build holds a staff address, and a plausible one
 *     is worse than a blank (brief rule 15). A resolver that answered something would send a business
 *     credential notice to an address somebody typed in to make a test pass.
 *  3. **The log line counts, per role, including zero.** The counts are the evidence that the ladder ran;
 *     a log that says nothing when nothing was sent says the same thing as a job that never ran.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const HEALTH_MODULE = join(HERE, 'google-connection-health.ts')

describe('the notice pass and the nightly check are one call', () => {
  it('exports the exact reference the handler invokes', () => {
    expect(SCHEDULED_REAUTH_NOTIFY).toBe(runReauthNotifyPass)
    // The control: a lookalike must NOT be the reference, or the assertion above is satisfied by any two
    // functions with the same shape.
    const lookalike: typeof runReauthNotifyPass = async (sql, config, checked, now) =>
      await runReauthNotifyPass(sql, config, checked, now)
    expect(SCHEDULED_REAUTH_NOTIFY).not.toBe(lookalike)
  })

  it('is invoked by the 03:00 handler, which is the half a reference cannot prove', () => {
    // Read from source, because `apps/worker`'s handler needs a database, a KEK and three Google fakes to
    // run — and what is being asserted is not what it does but THAT it does it. Gate 100 removes the call
    // and watches this rule fail by name.
    const health = readFileSync(HEALTH_MODULE, 'utf8')
    expect(health).toContain("from './google-reauth-notify.ts'")
    expect(health).toContain('await SCHEDULED_REAUTH_NOTIFY(')
    // And the handler must not have grown its own cron for it: a second `agent_definition` row and a
    // second heartbeat is the arrangement this deliberately avoids.
    expect(health).not.toContain('google.reauth-notify')
  })
})

describe('the shipped recipient resolver', () => {
  it('answers null for every role on every channel', () => {
    for (const role of ['owner', 'manager'] as const) {
      for (const channel of ['email', 'sms'] as const) {
        expect(NO_STAFF_CONTACT_ON_FILE(role, channel), `${role}/${channel}`).toBeNull()
      }
    }
  })
})

describe('the log line', () => {
  const decision = (
    toRole: ReauthNoticeDecision['toRole'],
    channel: ReauthNoticeDecision['channel'],
  ): ReauthNoticeDecision => ({
    connectionId: 'c1',
    incidentKey: 'reauth:1',
    kind: 'reactive',
    step: 'reactive_0h',
    rungIndex: 1,
    toRole,
    channel,
    dueAt: instantFromIso('2026-09-25T10:00:00.000Z'),
    decidedAt: instantFromIso('2026-09-25T10:00:00.000Z'),
    messageId: null,
    skippedReason: null,
  })

  it('counts per role, and says zero rather than nothing', () => {
    const empty: ReauthPassResult = {
      at: instantFromIso('2026-09-25T10:00:00.000Z'),
      connections: [],
      sent: 0,
      skipped: 0,
    }
    expect(reauthNotifyLogLine(empty)).toBe(
      'google-reauth.notify 2026-09-25T10:00:00.000Z: 0 connection(s), 0 sent (owner=0 manager=0), ' +
        '0 recorded as not sent',
    )
  })

  it('reports the owner and the manager separately, which is the acceptance line', () => {
    const result: ReauthPassResult = {
      at: instantFromIso('2026-09-25T10:00:00.000Z'),
      connections: [
        {
          connectionId: 'c1',
          incidentKey: 'reauth:1',
          kind: 'reactive',
          sent: [decision('owner', 'email'), decision('manager', 'email')],
          skipped: [{ ...decision('owner', 'sms'), skippedReason: 'channel_disabled' }],
          skippedWholly: null,
        },
      ],
      sent: 2,
      skipped: 1,
    }
    expect(reauthNotifyLogLine(result)).toContain('2 sent (owner=1 manager=1)')
    expect(reauthNotifyLogLine(result)).toContain('1 recorded as not sent')
  })
})
