import { suppressionKeyNormaliser } from '@berelax/core'
import type { Sql, UnitOfWork } from '@berelax/db'
import { fixtureSuppressionPeppers } from '@berelax/fixtures'
import type { ClassRoutedTransport } from '@berelax/messaging'
import type { FlowTickData, InterpreterRuntime } from '../automation/interpreter.ts'
import { interpreterCaps, messageNodeDepsFor } from '../automation/runtime.ts'

/**
 * The interpreter runtime a test drives, assembled ONCE and used by two processes.
 *
 * `interpreter.itest.ts` runs in the vitest worker and `flow-kill-probe.ts` runs in a child that is about
 * to be SIGKILLed, and both have to wire the interpreter exactly the same way — a probe that built its own
 * runtime would be a probe about a different composition, and "the replay sends nothing" would be a claim
 * about two systems. So the wiring lives here, in `src/testing`, beside `harness.ts`, which is in this
 * directory for the same reason: it is a harness module and `apps/worker` is outside the coverage floor.
 *
 * Three things it changes from the shipped runtime, each stated out loud:
 *
 *   - **`appEnv: 'production'`.** F03's staging guard DIVERTS every outbound message outside production and a
 *     diverted send writes no message row, so every case would measure the guard rather than the gate. The
 *     gate still runs first (`check-send-chokepoint.mjs` asserts that order for every case, not just the
 *     driven ones), so the compliance path is exercised as it is in production; what changes is only that
 *     the transport is reached.
 *
 *     It is now passed to `messageNodeDepsFor` rather than patched onto the SendContext afterwards, and
 *     C-AUTO-05 is why: the marketing kill switch is engaged in every non-production environment, resolved
 *     from the runtime's `APP_ENV`, so a patch applied after the fact would have left the switch reading
 *     `test` — engaged — and refused every promotional send in `interpreter.itest.ts` while the SendContext
 *     said `production`. One value, used by the guard and the switch, so the two cannot disagree about which
 *     environment this is.
 *   - **The suppression pepper is the fixture's.** `loadSuppressionPeppers(config)` refuses loudly when the
 *     environment has none, and every row keyed under the fixture pepper says `fixture` in
 *     `suppression.pepper_version` — the column that exists to say which pepper keyed a row.
 *   - **The queue is a spy.** A test asserts WHAT was queued and for what instant without waiting for
 *     pg-boss to poll. `run.ts` wires the real `transactionalEnqueue`, and `worker.itest.ts` is where the
 *     transactional property is proved for every job in the registry.
 */
export interface TestRuntimeSpies {
  readonly queued: { readonly data: FlowTickData; readonly startAfterSeconds: number | undefined }[]
  readonly alerts: { readonly runId: string; readonly flowKey: string }[]
}

export async function buildTestInterpreterRuntime(args: {
  readonly sql: Sql
  readonly transport: ClassRoutedTransport
  readonly spies: TestRuntimeSpies
}): Promise<InterpreterRuntime> {
  const base = messageNodeDepsFor(args.sql, {
    transport: args.transport,
    appEnv: 'production',
  })
  return {
    sql: args.sql,
    messageDeps: {
      ...base,
      caps: await interpreterCaps(args.sql),
      suppressionKeying: () => ({
        peppers: fixtureSuppressionPeppers(process.env),
        normalise: suppressionKeyNormaliser,
      }),
    },
    enqueueTick: async (_uow, data, options) => {
      args.spies.queued.push({ data, startAfterSeconds: options?.startAfterSeconds })
      return 'spy-job'
    },
    alertLoopDetected: async (uow: UnitOfWork, input) => {
      args.spies.alerts.push({ runId: input.runId, flowKey: input.flowKey })
      // The real outbox row as well, in the halt's own transaction, so the alert this unit owes is asserted
      // as a durable row rather than only as the spy's memory of a call.
      await uow.sql`
        insert into outbox_event (event_type, aggregate_type, aggregate_id, payload, idempotency_key)
        values (
          'automation.flow_run_loop_detected', 'flow_run', ${input.runId},
          ${uow.sql.json({ flowKey: input.flowKey } as never)},
          ${`automation.flow_run_loop_detected:${input.runId}`}
        )
        on conflict (idempotency_key) do nothing
      `
    },
  }
}
