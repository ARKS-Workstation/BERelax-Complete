import { loadConfig } from '@berelax/config'
import {
  type FrequencyCap,
  frequencyCapsFrom,
  type Instant,
  PROVISIONAL_FREQUENCY_CAPS,
  suppressionKeyNormaliser,
} from '@berelax/core'
import {
  loadSuppressionPeppers,
  publishEvent,
  readCurrentTemplate,
  readSetting,
  type Sql,
  type SuppressionKeying,
  type UnitOfWork,
} from '@berelax/db'
import {
  costOf,
  InMemoryOutbox,
  PROVISIONAL_SENDER_IDS,
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
export function messageNodeDepsFor(sql: Sql): MessageNodeDeps {
  const config = loadConfig()
  const now = (): string => new Date().toISOString()
  const sms = createSmsalaTransport({ config, now })

  return {
    sendContextFor: ({ evaluators }): SendContext => ({
      appEnv: config.APP_ENV,
      outboundAllowlist: config.OUTBOUND_ALLOWLIST,
      senderIds: PROVISIONAL_SENDER_IDS,
      transports: [sms.transport],
      outbox: new InMemoryOutbox(),
      clock: { now: () => Date.now() as Instant },
      gate: {
        // Still a literal `false`: making it a real audited read is C-AUTO-05's, which owns the switch and
        // the record of who engaged it. Stated rather than left to be inferred, because a `false` that
        // looks like a read is the switch nobody notices is not wired.
        marketingKillSwitch: false,
        promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
        evaluators,
      },
    }),
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
