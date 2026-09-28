import type { AppEnv } from '@berelax/config'
import { loadConfig } from '@berelax/config'
import {
  type FrequencyCap,
  frequencyCapsFrom,
  instantFromIso,
  PROVISIONAL_FREQUENCY_CAPS,
  suppressionKeyNormaliser,
} from '@berelax/core'
import {
  loadSuppressionPeppers,
  publishEvent,
  readCurrentTemplate,
  readMessagingControls,
  readSetting,
  type Sql,
  type SuppressionKeying,
  type UnitOfWork,
} from '@berelax/db'
import {
  type ClassRoutedTransport,
  costOf,
  InMemoryOutbox,
  type MarketingKillSwitchState,
  PROVISIONAL_SENDER_IDS,
  resolveMarketingKillSwitch,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import type { MessageChannel } from '@berelax/shared'
import type { MessageNodeDeps } from './nodes/message.ts'

/**
 * The interpreter's dependencies, assembled from configuration (C-AUTO-07).
 *
 * Separate from `interpreter.ts` for the reason `send-scheduled-step.ts` separates
 * `scheduledStepRuntimeFor` from the drain: `JOB_REGISTRY` is a module constant `pnpm jobs` enumerates
 * without a database, so a handler's dependencies cannot be constructor arguments — and a test has to be
 * able to supply a runtime of its own without loading the worker's configuration.
 *
 * ## Three differences from every other runtime in this worker, and each is the point of this unit
 *
 *   - **The gate's three evaluators are REAL.** Every other runtime in `apps/worker` wires three that throw,
 *     because none of them has a recipient list to prefetch for. A flow run is one contact, so the list is
 *     one entry and the prefetch is cheap — which is why the promotional path is finally exercisable end to
 *     end here rather than fail-closed.
 *   - **The caps are read from `app_setting`, per send.** Not captured at boot: `Y9-frequency-cap` is
 *     answered by an audited settings change with no deploy, and a value captured at boot would go on
 *     enforcing yesterday's figure while every screen showed today's.
 *   - **The suppression keying is LAZY.** `loadSuppressionPeppers` refuses loudly when the environment has
 *     none, and a worker that could not boot without a marketing pepper would be a worker that cannot send
 *     a booking reminder. Resolved at the first promotional send instead, so the failure is one send
 *     refused `blocked_unevaluable` naming `isSuppressed` — the gate failing closed, which is its job.
 */
export function messageNodeDepsFor(
  sql: Sql,
  options: {
    /**
     * The transport to send through, for a caller that has to be able to SEE what the vendor was asked.
     *
     * Injected rather than always built here, because the fake's call log is what makes "zero provider
     * calls" measurable — and a transport built inside this function would have a call log the caller
     * cannot reach, so a spy on a second instance would be a spy on nothing. `run.ts` passes none and gets
     * the configured one, which is the shipped path.
     */
    readonly transport?: ClassRoutedTransport
    /**
     * The environment this runtime behaves as, overriding `APP_ENV`.
     *
     * One value, used by BOTH the staging send guard and the kill switch's non-production default, so the two
     * cannot disagree about which environment this is. It exists for `buildTestInterpreterRuntime`, which has
     * to run as production for F03's guard to let the transport be reached at all — and which used to achieve
     * that by patching `appEnv` on the SendContext after the fact. That patch worked and would have been a
     * latent defect the moment a second thing was derived from the environment: C-AUTO-05's kill switch is
     * that second thing, and with the patch it would have read `test`, engaged, and refused every promotional
     * flow send in the interpreter's own suite.
     */
    readonly appEnv?: AppEnv
  } = {},
): MessageNodeDeps {
  const config = loadConfig()
  const appEnv = options.appEnv ?? config.APP_ENV
  const now = (): string => new Date().toISOString()
  const transport = options.transport ?? createSmsalaTransport({ config, now }).transport

  return {
    sendContextFor: ({ evaluators, atIso, marketingKillSwitch }): SendContext => ({
      appEnv,
      outboundAllowlist: config.OUTBOUND_ALLOWLIST,
      senderIds: PROVISIONAL_SENDER_IDS,
      transports: [transport],
      outbox: new InMemoryOutbox(),
      // The TICK's instant, from the job context, and never the wall clock. Every other instant in a run
      // comes from there, and a gate reading `Date.now()` would answer the window question about the moment
      // the process is running rather than the moment the run reached the node.
      clock: { now: () => instantFromIso(atIso) },
      gate: {
        // No longer a literal. C-AUTO-05 owns the switch, and the value arrives from `marketingKillSwitchFor`
        // below — one home (`messaging_control`), read per message, never captured at boot.
        marketingKillSwitch,
        promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
        evaluators,
      },
    }),
    /**
     * The switch, read from `messaging_control` for a promotional message and NOT read at all otherwise.
     *
     * The conditional is the point and it is not an optimisation. `readMessagingControls` REFUSES a missing
     * control row rather than answering "disengaged" — which is right, because answering "disengaged" for a
     * row somebody deleted would silently restart promotional sending — and a refusal is a throw. An
     * unconditional read would therefore make an unreadable marketing control table stop a booking
     * confirmation, which is the marketing-problem-becomes-operational-outage failure ADR 0016 exists to
     * remove and the exact thing this unit's acceptance line forbids.
     *
     * So the transactional answer is produced without touching the database at all, and the gate would ignore
     * it in any case (`evaluateGate` returns `allow` on its first line). Two independent layers, and this is
     * the one that holds when the database is the thing that is broken.
     */
    marketingKillSwitchFor: async ({ sql: connection, messageClass }) => {
      if (messageClass === 'transactional') return TRANSACTIONAL_TRAFFIC_HAS_NO_KILL_SWITCH
      const controls = await readMessagingControls(connection)
      return resolveMarketingKillSwitch({
        stored: controls.marketing_kill_switch.engaged,
        appEnv,
      })
    },
    // The provisional pair until `capsFor` is called with a connection; see `interpreterCaps`.
    caps: PROVISIONAL_FREQUENCY_CAPS,
    suppressionKeying: (): SuppressionKeying => ({
      peppers: loadSuppressionPeppers(config),
      normalise: suppressionKeyNormaliser,
    }),
    priceTemplate: async ({ templateKey, channel }) => {
      // Priced from the BODY by the same `costOf` the choke point uses, and read in the locale a quotation
      // is given in. A second derivation would make a dry run's plan disagree with the invoice it predicts.
      const template = await readCurrentTemplate(sql, { key: templateKey, channel, locale: 'en' })
      if (template === undefined) return null
      const priced = costOf(channel, template.body)
      return { encoding: priced.encoding, segments: priced.segments, costFils: priced.costFils }
    },
  }
}

/**
 * The answer for a transactional message: there is no kill switch on this path.
 *
 * A named constant rather than an inline object literal, so the one place it is produced can be found by
 * grep and so it reads as a statement rather than as a default somebody forgot to fill in.
 */
const TRANSACTIONAL_TRAFFIC_HAS_NO_KILL_SWITCH: MarketingKillSwitchState = Object.freeze({
  engaged: false,
  source: 'disengaged',
})

/**
 * The caps as the DATABASE holds them, read per send rather than captured at boot.
 *
 * `frequencyCapsFrom` builds them from `PROVISIONAL_FREQUENCY_CAPS` so the order and the window lengths come
 * from one place — a caller assembling its own array could reorder the breaches and change which cap is
 * reported — and `assertFrequencyCapLimit` refuses 0, null and 'unlimited' on the way through, which is what
 * makes "no cap" unreachable through a settings change (`Y9-frequency-cap`).
 */
export async function interpreterCaps(sql: Sql): Promise<readonly FrequencyCap[]> {
  const limits: Record<string, unknown> = {}
  for (const cap of PROVISIONAL_FREQUENCY_CAPS) {
    limits[cap.key] = await readSetting(sql, cap.settingKey)
  }
  return frequencyCapsFrom(limits as Parameters<typeof frequencyCapsFrom>[0])
}

/**
 * The alert a halted run owes somebody, as an outbox event in the halt's own transaction.
 *
 * An outbox event rather than a direct notification, which is ADR 0008's rule and matters here for a reason
 * of its own: the alert has to be durable WITH the halt. Raised after the commit it is an alert a crash
 * loses, and the halt is the one state nobody discovers by watching the flow work.
 */
export async function raiseLoopDetectedAlert(
  uow: UnitOfWork,
  input: { readonly runId: string; readonly flowKey: string; readonly detail: string },
): Promise<void> {
  await publishEvent(uow.sql, {
    eventType: 'automation.flow_run_loop_detected',
    aggregateType: 'flow_run',
    aggregateId: input.runId,
    payload: { flowKey: input.flowKey, runId: input.runId, detail: input.detail },
    // Derived from the RUN and not from a random value, which is `publishEvent`'s own instruction: a run
    // halts once, so a replayed tick that somehow reached the halt again records the same business fact
    // rather than a second alert about one flow.
    idempotencyKey: `automation.flow_run_loop_detected:${input.runId}`,
  })
}

/** The channels a flow may send on today. `sms` alone: no email or WhatsApp transport is contracted. */
export const FLOW_SENDABLE_CHANNELS: readonly MessageChannel[] = Object.freeze(['sms'])
