import { writeFileSync } from 'node:fs'
import { loadConfig } from '@berelax/config'
import { createConnection } from '@berelax/db'
import type { ClassRoutedTransport, TransportOutcome, TransportRequest } from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { runFlowTick } from '../automation/interpreter.ts'
import { buildTestInterpreterRuntime } from './flow-runtime.ts'

/**
 * A worker that is KILLED between the provider call and the commit (C-AUTO-07).
 *
 * The acceptance line is exact: *"the node side effect and its idempotency row commit in the same
 * transaction as the pg-boss job; killing the worker between the provider call and the commit and then
 * replaying asserts no second message is sent"*. A thrown error would not do — an aborted transaction and a
 * killed connection both roll back, but a throw also unwinds through `sendMessage`, which turns an
 * unexpected transport failure into a recorded `failed` outcome rather than into a lost transaction. So this
 * is a REAL process, really SIGKILLed, from inside `transport.send` and after the vendor has answered.
 *
 * ## What it leaves behind, and why a file
 *
 * The evidence has to survive the kill, and the one thing that cannot survive it is a database write inside
 * the tick's transaction — that is the whole point of the test. So the provider's answer is written to a
 * FILE, outside any transaction, immediately before the kill. The parent reads it to prove two things it
 * could not otherwise know: that the vendor really was asked, and what id it issued.
 *
 * ## What the parent can then prove, and what it cannot
 *
 * It CAN prove that the transaction rolled back whole (no message row, no idempotency token, the run still
 * running with its cursor unmoved), and that the replay produces exactly one message row whose provider id
 * is BYTE-IDENTICAL to the one this process was given. That identity is the chain: the same four-part
 * idempotency key produces the same key at the vendor, and a vendor handed the same key twice sends once —
 * which `packages/providers/src/behaviour.test.ts` proves of the fake directly and which is SMSala's own
 * contract.
 *
 * It CANNOT prove the suppression itself across the two processes, because the fake's memory of a key is in
 * the memory of a process that no longer exists. That is stated here rather than glossed: the suppression is
 * proved where it lives, and what this proves is that the replay asks for the same message rather than a new
 * one. The alternative — asserting "no second message" from a single process — would be asserting a weaker
 * thing under a stronger name.
 *
 * Run as: `node --import tsx apps/worker/src/testing/flow-kill-probe.ts <runId> <atIso> <evidencePath>`.
 */
async function main(): Promise<void> {
  const [runId, atIso, evidencePath] = process.argv.slice(2)
  if (runId === undefined || atIso === undefined || evidencePath === undefined) {
    throw new Error('usage: flow-kill-probe.ts <runId> <atIso> <evidencePath>')
  }
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  const inner = createSmsalaTransport({ config, now: () => atIso }).transport

  /**
   * The transport that answers and then dies.
   *
   * The kill is INSIDE `send`, after `await inner.send(...)` has returned an acceptance, so the vendor has
   * been asked and nothing the tick was going to write afterwards — the message row, the idempotency token,
   * the frequency ledger row, the step log row, the next tick's job row — has been committed.
   */
  const killing: ClassRoutedTransport = {
    channel: inner.channel,
    async send(request: TransportRequest): Promise<TransportOutcome> {
      const outcome = await inner.send(request)
      writeFileSync(
        evidencePath,
        `${JSON.stringify({
          idempotencyKey: request.idempotencyKey,
          providerMessageId: outcome.kind === 'accepted' ? outcome.providerMessageId : null,
          outcome: outcome.kind,
        })}\n`,
      )
      // SIGKILL and not `process.exit`: an exit runs handlers and would let postgres.js close the socket
      // politely, which a killed worker does not. The server rolls the uncommitted transaction back when
      // the connection dies, which is exactly the state this test is about.
      process.kill(process.pid, 'SIGKILL')
      // Unreachable. Returned so the type is honest about what `send` promises.
      return outcome
    },
  }

  const runtime = await buildTestInterpreterRuntime({
    sql,
    transport: killing,
    spies: { queued: [], alerts: [] },
  })
  await runFlowTick(runtime, { runId, atIso })
  // Also unreachable: the tick cannot return, because the transport killed the process. Reported rather
  // than ignored, because a probe that finished is a probe that proved nothing.
  await sql.end({ timeout: 1 })
  console.error(
    'flow-kill-probe: the tick RETURNED, so nothing was killed and no vendor was asked.',
  )
  process.exit(3)
}

await main()
