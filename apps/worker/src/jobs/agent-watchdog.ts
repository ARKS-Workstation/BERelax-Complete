import { evaluateAgentHealth, type Instant, isOverdue } from '@berelax/core'
import { agentsWithHeartbeat, deadLetteredDispatches, raiseAlert, type Sql } from '@berelax/db'
import type { SenderIdentityResolution, SenderIdRegistry } from '@berelax/messaging'
import { PROMOTIONAL_SENDER_PREFIX, resolveSenderIdentity } from '@berelax/messaging'
import type { MessageClass } from '@berelax/shared'

/**
 * The watchdog pass.
 *
 * Reads every agent, evaluates each against its own declared interval, and raises one alert per unbroken
 * silence. The arithmetic is `evaluateAgentHealth` in `@berelax/core` — pure, clock injected, and tested
 * at the boundary — and this module does the reading and the writing.
 *
 * It watches itself, and that is not an oversight. A watchdog that stops running is the one failure the
 * watchdog cannot report, so it has an `agent_definition` row like everything else and its own heartbeat
 * goes stale if it stops. Something outside this process has to notice that, which is the alerting
 * ladder in H-HARD-05; what this unit guarantees is that the evidence exists.
 *
 * ## The dead-letter count travels WITH the alert (A-MEAS-06)
 *
 * A dead-letter queue nothing reads is the same defect one level down from a watchdog nothing watches:
 * the row exists, the failure is recorded, and nobody is told. Two things read it — the agent console
 * (`apps/web/app/(admin)/agents/queries.ts`) and this pass, which puts the count into the alert detail so
 * that an operator woken about a silent dispatcher is told in the same breath how many conversions have
 * given up. The count is taken ONCE per pass rather than per agent: it is a property of the queue, not of
 * an agent, and a per-agent read would be ten identical queries whose answers could differ.
 *
 * ## Why the alert's message class is declared here, as a constant
 *
 * An agent alert is operational traffic about a system fault. It is TRANSACTIONAL, and
 * {@link AGENT_ALERT_MESSAGE_CLASS} is the one statement of that — so when a send path exists it reads a
 * declaration rather than choosing. `SENDER_IDENTITY_ROUTES` is then what makes the `AD-` sender
 * unreachable for it: the promotional identity is registered with that prefix and the transactional slot
 * is refused if it carries one (`transactional_carries_ad_prefix`), so a promotional identity cannot
 * carry this traffic even if a call site asked. {@link agentAlertSenderIdentity} is that resolution,
 * taking the class from the constant and leaving no parameter for a caller's preference.
 *
 * Nothing in this build SENDS an agent alert to a person: there is no on-call contact on file
 * (`Y13-oncall`) and the alert is an `agent_alert` row plus an outbox event. The class is declared anyway,
 * for the reason 0125 gives the other way round — a decision taken at the point a send exists is a
 * decision taken under pressure, and this one has an answer now.
 */
/**
 * The class an agent alert travels as. Operational traffic about a system fault, never marketing.
 *
 * A constant and not a literal at a call site, because the whole point of `SENDER_IDENTITY_ROUTES` being
 * total over (class x channel) is that the class is a declaration about the TRAFFIC rather than a
 * parameter a sender picks.
 */
export const AGENT_ALERT_MESSAGE_CLASS: MessageClass = 'transactional'

/**
 * The identity an agent alert would leave from, resolved from the class alone.
 *
 * There is no parameter for a class or a preference: the class is {@link AGENT_ALERT_MESSAGE_CLASS}, and
 * `resolveSenderIdentity` refuses a registry whose transactional slot carries the `AD-` prefix
 * (`transactional_carries_ad_prefix`) — so an agent alert cannot be sent under the promotional sender id
 * by any configuration this build accepts, and the refusal is typed rather than a fallback to the other
 * slot. A fallback is precisely what `sender-identity.ts` exists to prevent.
 */
export function agentAlertSenderIdentity(
  registry: SenderIdRegistry,
  channel: 'sms' | 'email' | 'whatsapp' = 'sms',
): SenderIdentityResolution {
  return resolveSenderIdentity(registry, {
    messageClass: AGENT_ALERT_MESSAGE_CLASS,
    channel,
  })
}

/** Whether a resolved identity carries the promotional prefix. Asserted, never assumed. */
export function identityIsPromotional(resolution: SenderIdentityResolution): boolean {
  return (
    resolution.kind === 'identity' &&
    resolution.identity.value.startsWith(PROMOTIONAL_SENDER_PREFIX)
  )
}

export interface WatchdogResult {
  readonly checked: number
  readonly overdue: readonly string[]
  /** Agents whose alert was newly inserted. Excludes an incident already alerted on. */
  readonly raised: readonly string[]
  readonly disabled: readonly string[]
  /** Dispatches that have given up, counted once per pass. See the header. */
  readonly deadLettered: number
}

export async function runWatchdog(sql: Sql, now: Instant): Promise<WatchdogResult> {
  const agents = await agentsWithHeartbeat(sql)
  // Once per pass, not once per agent: the queue is not an agent's property, and ten identical reads
  // could return ten different answers while the pass was running.
  const deadLetters = await deadLetteredDispatches(sql, { limit: 200 })
  const overdue: string[] = []
  const raised: string[] = []
  const disabled: string[] = []

  for (const agent of agents) {
    const health = evaluateAgentHealth(
      {
        agentKey: agent.agentKey,
        enabled: agent.enabled,
        enabledSince: agent.enabledSince as Instant,
        expectedIntervalSeconds: agent.expectedIntervalSeconds,
        lastSuccessAt: agent.heartbeat.lastSuccessAt as Instant | undefined,
      },
      now,
    )

    if (health.kind === 'disabled') {
      disabled.push(agent.agentKey)
      continue
    }
    if (!isOverdue(health)) continue

    overdue.push(agent.agentKey)
    const inserted = await raiseAlert(sql, {
      agentKey: agent.agentKey,
      incidentKey: health.incidentKey,
      silentForSeconds: health.silentForSeconds,
      raisedAtIso: new Date(now).toISOString(),
      detail: {
        displayName: agent.displayName,
        expectedIntervalSeconds: agent.expectedIntervalSeconds,
        // The last outcome distinguishes the two shapes of silence an operator has to act on
        // differently: `failed` means read a stack trace, null means nothing has run at all.
        lastOutcome: agent.heartbeat.lastOutcome ?? null,
        lastError: agent.heartbeat.lastError ?? null,
        consecutiveFailures: agent.heartbeat.consecutiveFailures,
        // The fourth heartbeat field (0151). An operator reading "last run two minutes ago" cannot tell
        // a slow agent from a stopped one without it.
        nextRunAt:
          agent.heartbeat.nextRunAt === undefined
            ? null
            : new Date(agent.heartbeat.nextRunAt).toISOString(),
        // Carried on every alert, so somebody woken about a silent dispatcher is told in the same breath
        // how many conversions have permanently given out.
        deadLetteredDispatches: deadLetters.length,
      },
    })
    if (inserted) raised.push(agent.agentKey)
  }

  return { checked: agents.length, overdue, raised, disabled, deadLettered: deadLetters.length }
}
