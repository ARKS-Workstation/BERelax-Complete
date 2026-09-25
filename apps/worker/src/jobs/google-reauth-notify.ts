import type { Config } from '@berelax/config'
import {
  ASIA_DUBAI,
  type Instant,
  instantToIso,
  type ReauthNoticeKind,
  type ReauthNoticeRole,
  reauthLadderCap,
  toLocal,
} from '@berelax/core'
import { createPostgresMessageStore, readCurrentTemplate, readSetting, type Sql } from '@berelax/db'
import {
  createPostgresConnectionStore,
  createPostgresReauthNoticeStore,
  type ReauthLadderDeps,
  type ReauthPassResult,
  type ReauthRecipientResolver,
  type ReauthSender,
  type ReauthSubject,
  runReauthLadder,
  spellDate,
} from '@berelax/google'
import {
  type DeliveryDeps,
  deliverMessage,
  InMemoryOutbox,
  type MessageId,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import {
  DEFAULT_GOOGLE_REAUTH_REPEAT_CAP,
  GOOGLE_REAUTH_REPEAT_CAP_SETTING_KEY,
  GOOGLE_REAUTH_SMS_SETTING_KEY,
  GOOGLE_REAUTH_TEMPLATE_KEYS,
  SITE_ORIGIN_ENV,
  siteOriginFrom,
} from '@berelax/shared'

/**
 * The escalating re-auth notice pass: the sending half of G-CONN-08.
 *
 * ## Why it has no cron of its own
 *
 * Because it would be a second poller looking for work the 03:00 deep check has already done. G-CONN-06's
 * pass derives every connection's health, records what it found, and computed the notification decision
 * while saying outright that it sends nothing — *"the Resend templates, the T-48h predictive email and the
 * one-per-incident reactive email are that unit's"*. This is that unit's, and it runs on the back of that
 * pass: one cron, one `agent_definition` row, one heartbeat. A second cron would need its own agent row
 * for the watchdog to mean anything, and it would wake up to ask a question the first one had just
 * answered.
 *
 * The daily cadence is also exactly the ladder's: the rungs after the first are 24 hours apart, so *"once
 * a day until the cap"* is *"once per deep check"*.
 *
 * ## What it does NOT do, and both are honest rather than unfinished
 *
 * `recipientForRole` answers `null` for every role in the shipped runtime — the same value
 * `obligationNoticeRuntimeFor` ships and for the same reason: no table in this build holds a staff email
 * address or phone number, and a plausible one is worse than a blank (brief rule 15). Every due rung is
 * then recorded as skipped with `no_recipient_on_file`, which is a row on the connection an operator can
 * read, and the ladder moves on to the next rung rather than retrying this one against a unique index that
 * would refuse it.
 *
 * And nothing here writes an SMS unless `google.reauth_sms_enabled` says so, which it does not by default.
 * The row still records `channel_disabled`, because a switch whose state leaves no trace is a switch
 * nobody can prove was off.
 */

/** The English a body needs. Injected nowhere: the pass spells its own instants in the owner's zone. */
function spellInstant(instant: Instant): string {
  const { date, time } = toLocal(instant, ASIA_DUBAI)
  return `${spellDate(date)} at ${time} (${ASIA_DUBAI})`
}

/** The template a kind is sent from, per channel. Email always; SMS only for the reactive notice. */
const TEMPLATE_KEY: Readonly<Record<ReauthNoticeKind, string>> = GOOGLE_REAUTH_TEMPLATE_KEYS

/**
 * The shipped recipient resolver: null for every role, on every channel.
 *
 * Exported so a test can assert that it is null rather than reading this file and believing it, and so the
 * one place that changes when a staff contact table lands is here.
 */
export const NO_STAFF_CONTACT_ON_FILE: ReauthRecipientResolver = () => null

/**
 * The sender: one notice, through the messaging choke point.
 *
 * Through `deliverMessage` and never a provider: `messaging-providers-only-inside-a-transport` is the
 * boundary, and the choke point is also what makes the message a row, a cost and a delivery receipt rather
 * than a call nobody can account for. A refusal — a gate refusal, or F03's staging diversion, which is the
 * ORDINARY outcome off production — comes back as `refused` rather than as a throw, because the ladder
 * records it and carries on.
 *
 * The idempotency key is derived from the incident and the rung, so a second attempt at the same rung
 * computes the same key, the fake derives the same provider message id from it, and
 * `message_provider_id_unique` refuses the second row — a third layer under the ladder's own dedupe and
 * migration 0075's unique index.
 */
export function reauthSenderFor(sql: Sql, config: Config): ReauthSender {
  const now = (): string => new Date().toISOString()
  const sms = createSmsalaTransport({ config, now })
  const send: SendContext = {
    appEnv: config.APP_ENV,
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox: new InMemoryOutbox(),
    clock: { now: () => Date.now() as Instant },
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      // The same three fail-closed evaluators every other runtime wires, for the same reason: a re-auth
      // notice is TRANSACTIONAL, so the gate returns before any of them is read, and a promotional send
      // through this runtime fails closed rather than going out unevaluated.
      evaluators: {
        hasConsent: () => {
          throw new Error('No consent store yet (C-CRM-03). Promotional sends fail closed.')
        },
        isSuppressed: () => {
          throw new Error(
            'This runtime prefetches no suppression logs (C-CRM-04). Promotional sends fail closed.',
          )
        },
        frequencyCapReached: () => {
          throw new Error('No frequency store yet (C-AUTO-03). Promotional sends fail closed.')
        },
      },
    },
  }
  const delivery: DeliveryDeps = {
    store: createPostgresMessageStore(sql),
    send,
    // The queue is the thing that waits. A retry inside the pass would hold a Google connection's row for
    // the length of the declared backoff.
    waitUntil: async () => {},
  }

  return async (request) => {
    const template = await readCurrentTemplate(sql, {
      key: TEMPLATE_KEY[request.kind],
      channel: request.channel,
      // English only, and deliberately: a re-auth notice goes to a member of staff in a role, and no table
      // in this build records which language that person reads. The Arabic variant is seeded and will be
      // selected the day a staff locale exists; guessing one per role would be a guess about a person.
      locale: 'en',
    })
    if (template === undefined) return { kind: 'refused' }
    const values: Record<string, string> =
      request.kind === 'reactive'
        ? { since: request.whenLabel, link: request.reconnectUrl }
        : { expires: request.whenLabel, link: request.reconnectUrl }
    // The SMS variant declares no `link` (one Arabic segment is 70 UCS-2 units), and the renderer refuses a
    // value it did not declare — so the values are narrowed to what this variant asks for rather than
    // handed a superset.
    const narrowed = Object.fromEntries(
      template.variables.filter((name) => name in values).map((name) => [name, values[name] ?? '']),
    )
    const outcome = await deliverMessage(delivery, {
      templateId: template.templateId,
      id: `google-reauth-${request.step}-${request.toRole}-${request.channel}-${request.connectionId}` as MessageId,
      template: {
        key: template.templateKey,
        channel: request.channel,
        locale: 'en',
        body: template.body,
        variables: [...template.variables],
        messageClass: 'transactional',
        approvalState: 'approved',
      },
      values: narrowed,
      recipient: request.recipient,
    })
    if (outcome.kind !== 'sent' && outcome.kind !== 'held' && outcome.kind !== 'failed') {
      return { kind: 'refused' }
    }
    return { kind: 'sent', messageId: outcome.message.id }
  }
}

/** The cap and the SMS switch, read once per pass. */
export async function reauthLadderSettings(
  sql: Sql,
): Promise<{ readonly cap: number; readonly smsEnabled: boolean }> {
  const stored = await readSetting(sql, GOOGLE_REAUTH_REPEAT_CAP_SETTING_KEY)
  // Refused rather than coerced, then defaulted only for an ABSENT row: a cap of 500 in the settings table
  // is something to fix, and silently clamping it would hide the thing that needs fixing. An absent row is
  // a database that predates the setting, which is not the same fact.
  const cap = reauthLadderCap(
    typeof stored === 'number' ? stored : DEFAULT_GOOGLE_REAUTH_REPEAT_CAP,
  )
  return { cap, smsEnabled: (await readSetting(sql, GOOGLE_REAUTH_SMS_SETTING_KEY)) === true }
}

/**
 * Everything the ladder needs, assembled from the database and the environment.
 *
 * `origin` comes from `siteOriginFrom`, which validates it and throws on a malformed value rather than
 * falling back — the reason that file gives: a deep link built from `https:/berelax` is not a smaller
 * problem than no deep link, it is the same problem with nothing to alert on.
 */
export async function reauthLadderDepsFor(sql: Sql, config: Config): Promise<ReauthLadderDeps> {
  const { cap, smsEnabled } = await reauthLadderSettings(sql)
  return {
    store: createPostgresReauthNoticeStore(sql),
    send: reauthSenderFor(sql, config),
    recipientForRole: NO_STAFF_CONTACT_ON_FILE,
    origin: siteOriginFrom(process.env[SITE_ORIGIN_ENV]),
    cap,
    smsEnabled,
    spellInstant,
  }
}

/**
 * The subjects for a pass: every connection the deep check just looked at, with the two instants the
 * predictive incident keys are derived from.
 *
 * Read back through the connection store rather than carried on the check's result, because `lastOkAt` and
 * `consentAt` are columns the pass may just have moved — and a staleness incident key computed from a stale
 * copy of `lastOkAt` would be a different key, which is a second notice about one incident.
 */
export async function reauthSubjectsFor(
  sql: Sql,
  checked: readonly {
    readonly connectionId: string
    readonly googleEmail: string
    readonly health: ReauthSubject['health']
  }[],
): Promise<readonly ReauthSubject[]> {
  const store = createPostgresConnectionStore(sql)
  const subjects: ReauthSubject[] = []
  for (const entry of checked) {
    const connection = await store.load(entry.connectionId)
    if (connection === null) continue
    subjects.push({
      connectionId: entry.connectionId,
      googleEmail: entry.googleEmail,
      health: entry.health,
      lastOkAt: connection.lastOkAt,
      consentAt: connection.consentAt,
    })
  }
  return subjects
}

/**
 * The pass, as the 03:00 handler calls it.
 *
 * Exported as this exact reference so the identity is assertable rather than reviewable — the arrangement
 * G-CONN-07 used for `TEST_CONNECTION_PASS` and `SCHEDULED_DEEP_CHECK`, and for the same reason: two
 * functions that are supposed to be one are two functions that will drift.
 */
export async function runReauthNotifyPass(
  sql: Sql,
  config: Config,
  checked: readonly {
    readonly connectionId: string
    readonly googleEmail: string
    readonly health: ReauthSubject['health']
  }[],
  now: Instant,
): Promise<ReauthPassResult> {
  return await runReauthLadder(
    await reauthLadderDepsFor(sql, config),
    await reauthSubjectsFor(sql, checked),
    now,
  )
}

/** The reference the deep-check handler invokes. Asserted identical to the pass above. */
export const SCHEDULED_REAUTH_NOTIFY: typeof runReauthNotifyPass = runReauthNotifyPass

/** One line per pass, counts included when they are zero — the evidence, rather than the silence. */
export function reauthNotifyLogLine(result: ReauthPassResult): string {
  const roles: readonly ReauthNoticeRole[] = ['owner', 'manager']
  const byRole = roles
    .map(
      (role) =>
        `${role}=${result.connections.reduce(
          (total, outcome) => total + outcome.sent.filter((d) => d.toRole === role).length,
          0,
        )}`,
    )
    .join(' ')
  return (
    `google-reauth.notify ${instantToIso(result.at)}: ${result.connections.length} connection(s), ` +
    `${result.sent} sent (${byRole}), ${result.skipped} recorded as not sent`
  )
}
