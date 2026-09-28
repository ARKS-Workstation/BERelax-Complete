import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '@berelax/config'
import {
  type CustomerMergeSubject,
  planCustomerMerge,
  scoreDuplicatePair,
  validateFlowDefinition,
} from '@berelax/core'
import {
  type Actor,
  applyCustomerTag,
  type CustomerMergePlanInput,
  countNodeEffects,
  createConnection,
  enrolOnLiveVersion,
  flowRefusalOf,
  mergeCustomers,
  publishFlowDefinition,
  readContactStepLog,
  readCurrentConsentWording,
  readCustomerMergeSubject,
  readFlowRun,
  readRunStepLog,
  recordConsent,
  type Sql,
  setFlowActive,
  type UnitOfWork,
  withUnitOfWork,
} from '@berelax/db'
import { syntheticPerson } from '@berelax/fixtures'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import {
  FLOW_NODE_OUTCOMES,
  FLOW_RUN_MODES,
  FLOW_RUN_STATUSES,
  MAX_ACTIVE_ENROLMENTS_PER_FLOW,
  MAX_FLOW_NODE_EXECUTIONS,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestInterpreterRuntime } from '../testing/flow-runtime.ts'
import {
  type FlowTickData,
  type InterpreterRuntime,
  projectFlowDryRun,
  runFlowTick,
  startRunAndQueueFirstTick,
} from './interpreter.ts'
import { STORABLE_TAG } from './nodes/index.ts'

/**
 * C-AUTO-07 — the interpreter's acceptance lines, against a real PostgreSQL and the real fake vendor.
 *
 * Every claim here is a claim about the PAIR: `planFlowStep` is pure and lives in `@berelax/core`, the rows
 * live in PostgreSQL and `@berelax/db` writes them, the compliance decision is `@berelax/messaging`'s gate,
 * and the composition is this worker's. `packages/core/src/automation/step-plan.test.ts` drives the planner
 * with no database at all; this drives the whole thing.
 *
 * ## What is real here, stated rather than left to be inferred
 *
 * The gate's three evaluators are REAL: the consent log is read with `readConsentLogs` and folded by
 * `resolveConsent`, the suppression list with `readSuppressionLogs` under the fixture pepper, the frequency
 * ledger with `readCountedSendsByContact`, and the caps come from `app_setting`. The transport is the fake
 * SMSala, built HERE and injected, which is what makes "zero provider calls" measurable — a transport built
 * inside the runtime would keep its call log to itself, so a spy on a second instance would be a spy on
 * nothing.
 *
 * The one thing that is NOT real is the queue: `enqueueTick` is a spy, so a case can assert what was queued
 * and for what instant without waiting for pg-boss to poll. What the spy cannot prove is that the enqueue is
 * TRANSACTIONAL, and `worker.itest.ts` is where that property is proved for every job in the registry —
 * `run.ts` wires this one through `transactionalEnqueue` exactly as it wires the others.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind (brief
 * rule 12). Every flow key is namespaced to this file, every read is narrowed to this file's own runs, and
 * nothing is asserted as a total. The contacts are on the unallocated `+971 59` prefix in a band nothing else
 * uses: `flow-versioning.itest.ts` holds 60_001-60_400 and `crm-pipeline.itest.ts` 60_501 upward, so this
 * file takes 61_001 upward and its five-thousand-enrolment case takes 62_001-67_000 and removes them again.
 *
 * `message` rows cannot be deleted (an ON DELETE RESTRICT out of an append-only receipt table) and
 * `flow_step_log` refuses DELETE for every role (ZY001), so nothing here cleans those up: every assertion is
 * narrowed to a run id this run of the suite created, which is what makes a second run append rather than
 * collide.
 *
 * Every instant is in 2099. 10:00Z is 14:00 Asia/Dubai — inside the 07:00-21:00 promotional window, so the
 * gate's queueing branch is never what a case is measuring unless it says so; the window case uses 22:00Z,
 * which is 02:00 the next day in Dubai and is the case the window rule's own header calls the interesting one.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ACTOR: Actor = { kind: 'staff', label: 'Manager (fixture)' }
const PUBLISHED_BY = 'cauto07 itest'

/** One key per concern, all namespaced to this file. */
const KEYS = {
  send: 'cauto07_send',
  loop: 'cauto07_loop',
  window: 'cauto07_window',
  dry: 'cauto07_dry',
  cap: 'cauto07_cap',
  merge: 'cauto07_merge',
  tag: 'cauto07_tag',
  kill: 'cauto07_kill',
} as const

/** The template this file publishes: promotional, approved, and declaring NO variables. */
const TEMPLATE_KEY = 'cauto07.promo'

const CONTACT_BAND_FIRST = 61_001
const CONTACTS = 22
const CAP_BAND_FIRST = 62_001

/** Inside the promotional window: 10:00Z is 14:00 Asia/Dubai. */
const INSIDE_WINDOW_ISO = '2099-03-04T10:00:00.000Z'
/** Outside it: 22:00Z is 02:00 Asia/Dubai on the 5th, and the next opening is 07:00 Dubai the same day. */
const OUTSIDE_WINDOW_ISO = '2099-03-04T22:00:00.000Z'
/** 07:00 Asia/Dubai on the 5th, which is what the gate answers for the instant above. */
const NEXT_WINDOW_OPEN_ISO = '2099-03-05T03:00:00.000Z'
/** Far enough ahead that every one-minute delay in the looping flow has already elapsed. */
const LONG_AFTER_ISO = '2100-03-04T10:00:00.000Z'

const published = new Map<string, { flowId: string; version: number }>()

let sql: Sql
let runtime: InterpreterRuntime
const queued: { readonly data: FlowTickData; readonly startAfterSeconds: number | undefined }[] = []
const alerts: { readonly runId: string; readonly flowKey: string }[] = []
let contactIds: string[] = []
let marketingWordingId: string
let marketingWordingHash: string
let smsCalls: () => number
let templates: {
  readonly templateKey: string
  readonly messageClass: 'transactional' | 'promotional'
}[]

const asManager = <T>(body: (uow: UnitOfWork) => Promise<T>): Promise<T> =>
  withUnitOfWork(sql, ACTOR, body)

const validate = (candidate: unknown) => validateFlowDefinition(candidate, { templates })

// ------------------------------------------------------------------------------------------------
// The documents this file publishes
// ------------------------------------------------------------------------------------------------

/** trigger -> message -> exit. The shortest flow that sends something. */
const sendFlow = (key: string): unknown => ({
  dslVersion: 1,
  key,
  title: 'One message and out',
  nodes: [
    { id: 'entered', kind: 'trigger', event: 'manual' },
    {
      id: 'tell_them',
      kind: 'action_message',
      messageClass: 'promotional',
      templateKey: TEMPLATE_KEY,
      channel: 'sms',
    },
    { id: 'done', kind: 'exit', reason: 'goal_met' },
  ],
  edges: [
    { branch: 'default', from: 'entered', to: 'tell_them' },
    { branch: 'default', from: 'tell_them', to: 'done' },
  ],
})

/** trigger -> delay(30) -> message -> exit. The delay is what lands the send outside the window. */
const delayedSendFlow = (key: string): unknown => ({
  dslVersion: 1,
  key,
  title: 'Wait, then tell them',
  nodes: [
    { id: 'entered', kind: 'trigger', event: 'manual' },
    { id: 'settle', kind: 'delay', minutes: 30 },
    {
      id: 'tell_them',
      kind: 'action_message',
      messageClass: 'promotional',
      templateKey: TEMPLATE_KEY,
      channel: 'sms',
    },
    { id: 'done', kind: 'exit', reason: 'goal_met' },
  ],
  edges: [
    { branch: 'default', from: 'entered', to: 'settle' },
    { branch: 'default', from: 'settle', to: 'tell_them' },
    { branch: 'default', from: 'tell_them', to: 'done' },
  ],
})

/**
 * A loop the static analyser PASSES and a non-VIP contact never leaves.
 *
 * It has a delay (so `flow-analysis-cycle-has-no-delay` is satisfied) and an escape from which an exit is
 * reachable (so `flow-analysis-cycle-has-no-bounded-exit` is), which is exactly the shape the execution cap
 * exists as a backstop for: a legal graph whose facts keep sending one contact round it.
 */
const loopingFlow = (key: string): unknown => ({
  dslVersion: 1,
  key,
  title: 'Nurture until they are a VIP',
  nodes: [
    { id: 'entered', kind: 'trigger', event: 'manual' },
    { id: 'beat', kind: 'delay', minutes: 1 },
    { id: 'vip_yet', kind: 'condition', test: { fact: 'is_vip', operator: 'is_true' } },
    // A MESSAGE node and not a tag, so the acceptance line's own words are what is measured: "delivering
    // the same job 50 times produces exactly one message row and 49 typed duplicate outcomes". Reaching
    // one node fifty times inside one run is the same arrival the queue produces and a cheaper one to drive.
    {
      id: 'touch',
      kind: 'action_message',
      messageClass: 'promotional',
      templateKey: TEMPLATE_KEY,
      channel: 'sms',
    },
    { id: 'done', kind: 'exit', reason: 'goal_met' },
  ],
  edges: [
    { branch: 'default', from: 'entered', to: 'beat' },
    { branch: 'default', from: 'beat', to: 'vip_yet' },
    { branch: 'true', from: 'vip_yet', to: 'done' },
    { branch: 'false', from: 'vip_yet', to: 'touch' },
    { branch: 'default', from: 'touch', to: 'beat' },
  ],
})

/** trigger -> tag -> exit. The tag is lower snake_case, which is what the DSL permits. */
const taggingFlow = (key: string): unknown => ({
  dslVersion: 1,
  key,
  title: 'Tag and out',
  nodes: [
    { id: 'entered', kind: 'trigger', event: 'manual' },
    { id: 'touch', kind: 'action_tag', tag: 'cauto07_touch' },
    { id: 'done', kind: 'exit', reason: 'completed' },
  ],
  edges: [
    { branch: 'default', from: 'entered', to: 'touch' },
    { branch: 'default', from: 'touch', to: 'done' },
  ],
})

/** trigger -> exit. Nothing happens, which is what the enrolment cases need. */
const emptyFlow = (key: string): unknown => ({
  dslVersion: 1,
  key,
  title: 'Enrol and leave',
  nodes: [
    { id: 'entered', kind: 'trigger', event: 'manual' },
    { id: 'done', kind: 'exit', reason: 'completed' },
  ],
  edges: [{ branch: 'default', from: 'entered', to: 'done' }],
})

// ------------------------------------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------------------------------------

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  // The template this file sends. Inserted with SQL rather than driven through the approval state machine,
  // which is C-AUTO-01's and is proved in `message-template.itest.ts`: what is under test here is the
  // interpreter. `approved` on INSERT is legal — 0061's state-machine trigger is on UPDATE — and the variant
  // declares NO variables, because a flow node carries no values to render one with.
  await sql`
    insert into message_template (template_key, version, message_class, purpose, is_current)
    values (
      ${TEMPLATE_KEY}, 1, 'promotional',
      'A promotional message with no variables, so a flow node can send it with nothing to render.', true
    )
    on conflict do nothing
  `
  await sql`
    insert into message_template_variant (
      template_id, channel, locale, approval_state, body, variables, encoding, segments, cost_fils
    )
    select t.id, 'sms', 'en', 'approved',
           'A short note from the salon. Reply STOP to opt out.', '{}'::text[], 'GSM-7', 1, 12
      from message_template t where t.template_key = ${TEMPLATE_KEY}
    on conflict do nothing
  `

  const rows = await sql<{ template_key: string; message_class: string }[]>`
    select template_key, message_class::text as message_class
      from message_template where is_current = true
  `
  templates = rows.map((row) => ({
    templateKey: row.template_key,
    messageClass: row.message_class as 'transactional' | 'promotional',
  }))

  // The probe contacts are REMOVED and recreated, which is this file's whole isolation strategy and is
  // worth the paragraph.
  //
  // Almost everything a case here measures is keyed on a contact and accumulates: a consent grant, a
  // `frequency_ledger` row (2 per rolling 7 days is the cap, so the second run of this suite would refuse
  // every promotional send and every case would fail for a reason that has nothing to do with the
  // interpreter — that is how this paragraph came to be written), a tag, an enrolment. None of those tables
  // can be cleared: `frequency_ledger` and `consent` are append-only to the application role, and brief
  // rule 9 says a test must not try to DELETE from one.
  //
  // Deleting the CONTACT is the one move that is not a violation of that: `frequency_ledger`,
  // `flow_enrolment`, `customer_tag` and `customer_preference` all CASCADE from `customer` by design, so the
  // rows go with the person rather than being edited behind their back. `consent` deliberately has no
  // foreign key (0056), so its records outlive the identity they are about — which is correct, and harmless
  // here because the recreated contacts get new uuids and therefore no consent at all until this file grants
  // it. `flow_run` and `flow_step_log` survive too, for the reason 0091 states: neither hangs off `customer`.
  await sql`
    delete from customer
     where phone_e164 between ${syntheticPerson(CONTACT_BAND_FIRST).phone}
       and ${syntheticPerson(CONTACT_BAND_FIRST + CONTACTS - 1).phone}
  `
  // Generated in SQL and PAIRED with `syntheticPerson` on the read, so the two cannot drift into a band
  // another suite owns.
  await sql`
    insert into customer (phone_e164, created_via)
    select '+97159' || lpad((${CONTACT_BAND_FIRST} + g - 1)::text, 7, '0'), 'front_desk'
      from generate_series(1, ${CONTACTS}) as g
    on conflict (phone_e164) do nothing
  `
  const contacts = await sql<{ id: string }[]>`
    select id from customer
     where phone_e164 between ${syntheticPerson(CONTACT_BAND_FIRST).phone}
       and ${syntheticPerson(CONTACT_BAND_FIRST + CONTACTS - 1).phone}
     order by phone_e164
  `
  contactIds = contacts.map((row) => row.id)
  if (contactIds.length !== CONTACTS) {
    throw new Error(`expected ${CONTACTS} probe contacts, found ${contactIds.length}`)
  }

  const wording = await readCurrentConsentWording(sql, 'marketing')
  if (wording === null) {
    throw new Error('No marketing consent wording is published. Run `pnpm seed` (brief rule 24).')
  }
  marketingWordingId = wording.id
  marketingWordingHash = wording.contentHashHex

  // Every contact in this file opts IN, so a refusal in any case below is that case's own doing and never a
  // missing grant — the hazard `frequency-ledger.itest.ts` names about a second refusal making every
  // assertion vacuous.
  for (const contactId of contactIds) await asManager((uow) => grantMarketing(uow, contactId))

  for (const [key, document] of [
    [KEYS.send, sendFlow(KEYS.send)],
    [KEYS.loop, loopingFlow(KEYS.loop)],
    [KEYS.window, delayedSendFlow(KEYS.window)],
    [KEYS.dry, sendFlow(KEYS.dry)],
    [KEYS.cap, emptyFlow(KEYS.cap)],
    [KEYS.merge, sendFlow(KEYS.merge)],
    [KEYS.tag, taggingFlow(KEYS.tag)],
    [KEYS.kill, sendFlow(KEYS.kill)],
  ] as const) {
    published.set(key, await publishAndEnable(key, document))
  }

  const config = loadConfig()
  // The transport is built HERE so its call log is reachable: that log is the spy the dry-run and window
  // cases read, and a transport the runtime built for itself would keep it private.
  const sms = createSmsalaTransport({ config, now: () => INSIDE_WINDOW_ISO })
  smsCalls = () =>
    sms.calls.forProvider('smsala').filter((call) => call.outcome === 'success').length

  // The SAME wiring the kill probe uses, from one factory: a probe that assembled its own runtime would be
  // a probe about a different composition, and "the replay sends nothing" would be a claim about two
  // systems rather than about one.
  runtime = await buildTestInterpreterRuntime({
    sql,
    transport: sms.transport,
    spies: { queued, alerts },
  })
}, 120_000)

afterAll(async () => {
  if (sql === undefined) return
  // The cap case's five thousand contacts, in case it failed part way through. Enrolments cascade with them.
  await sql`
    delete from customer where phone_e164 between ${syntheticPerson(CAP_BAND_FIRST).phone}
      and ${syntheticPerson(CAP_BAND_FIRST + MAX_ACTIVE_ENROLMENTS_PER_FLOW - 1).phone}
  `
  await sql.end({ timeout: 5 })
}, 60_000)

async function publishAndEnable(
  key: string,
  document: unknown,
): Promise<{ flowId: string; version: number }> {
  const result = await asManager((uow) =>
    publishFlowDefinition(
      uow,
      { flowKey: key, title: 'C-AUTO-07 probe', definition: document, publishedBy: PUBLISHED_BY },
      { validate },
    ),
  )
  await asManager((uow) => setFlowActive(uow, key, true))
  return { flowId: result.flowId, version: result.version }
}

async function grantMarketing(uow: UnitOfWork, contactId: string): Promise<void> {
  await recordConsent(uow, {
    contactCustomerId: contactId,
    channel: 'sms',
    purpose: 'marketing',
    kind: 'granted',
    recordedAtIso: '2099-01-01T08:00:00.000Z',
    wordingId: marketingWordingId,
    wordingHashHex: marketingWordingHash,
    capture: {
      source: 'front_desk',
      actorKind: 'staff',
      actorLabel: 'Receptionist (fixture)',
      locale: 'en',
    },
  })
}

const flowOf = (key: string): { flowId: string; version: number } => {
  const entry = published.get(key)
  if (entry === undefined) throw new Error(`the fixture did not publish ${key}`)
  return entry
}

const contact = (index: number): string => {
  const id = contactIds[index]
  if (id === undefined) throw new Error(`no probe contact at ${index}`)
  return id
}

/** Enrols one contact and starts its run, returning the run id. */
async function enrolAndStart(key: string, contactId: string, atIso: string): Promise<string> {
  const { flowId } = flowOf(key)
  return await asManager(async (uow) => {
    const enrolment = await enrolOnLiveVersion(uow, {
      flowKey: key,
      customerId: contactId,
      createdBy: PUBLISHED_BY,
      at: new Date(atIso),
    })
    return await startRunAndQueueFirstTick(runtime, uow, {
      enrolmentId: enrolment.enrolmentId,
      flowId,
      definitionVersion: enrolment.pinnedVersion,
      maxNodeExecutions: MAX_FLOW_NODE_EXECUTIONS,
      atIso,
    })
  })
}

/** How many distinct messages one run produced. Narrowed to the run, never a total (brief rule 12). */
async function messagesFor(runId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(distinct s.message_id)::text as n from flow_step_log s
     where s.flow_run_id = ${runId}::uuid and s.message_id is not null
  `
  return Number(row?.n ?? '0')
}

// ------------------------------------------------------------------------------------------------
// The vocabularies
// ------------------------------------------------------------------------------------------------

describe('the run vocabularies in SQL and in code are the same lists', () => {
  it('agrees with pg_enum in both directions on all three', async () => {
    const labelsOf = async (type: string): Promise<string[]> => {
      const rows = await sql<{ label: string }[]>`
        select e.enumlabel as label from pg_enum e join pg_type t on t.oid = e.enumtypid
         where t.typname = ${type} order by e.enumsortorder
      `
      return rows.map((row) => row.label)
    }
    // Ordered lists, because `flow_node_outcome`'s order is the order a report groups by. Two empty lists
    // would agree perfectly, so the sizes are asserted as well.
    expect(await labelsOf('flow_run_mode')).toEqual([...FLOW_RUN_MODES])
    expect(await labelsOf('flow_run_status')).toEqual([...FLOW_RUN_STATUSES])
    expect(await labelsOf('flow_node_outcome')).toEqual([...FLOW_NODE_OUTCOMES])
    expect(FLOW_NODE_OUTCOMES.length).toBeGreaterThan(4)
    expect(FLOW_RUN_STATUSES.length).toBeGreaterThan(3)
  })
})

// ------------------------------------------------------------------------------------------------
// Idempotency
// ------------------------------------------------------------------------------------------------

describe('acceptance — delivering the same job 50 times produces one message and 49 duplicates', () => {
  it('sends once, and the other 49 deliveries send nothing', async () => {
    const contactId = contact(0)
    const runId = await enrolAndStart(KEYS.send, contactId, INSIDE_WINDOW_ISO)

    const before = smsCalls()
    expect((await runFlowTick(runtime, { runId, atIso: INSIDE_WINDOW_ISO })).kind).toBe('finished')
    expect(await messagesFor(runId)).toBe(1)

    for (let delivery = 2; delivery <= 50; delivery += 1) {
      const again = await runFlowTick(runtime, { runId, atIso: INSIDE_WINDOW_ISO })
      expect(again.kind, `delivery ${delivery}`).toBe('already_ended')
    }
    expect(await messagesFor(runId), 'still exactly one message row').toBe(1)
    expect(smsCalls() - before, 'the vendor was asked exactly once').toBe(1)
    expect(await countNodeEffects(sql, runId), 'one token for the one node that sent').toBe(1)
  }, 60_000)

  it('the token itself is the mechanism: one message row and 49 typed duplicates', async () => {
    // The layer the case above cannot see: it ends the run, so a status check would satisfy it. Here the
    // SAME message node is reached fifty times inside ONE run of a looping flow, and every arrival after the
    // first records the typed `duplicate` — which comes from `flow_node_effect_once_per_contact` returning
    // no row, not from a status and not from a caught exception whose message mentions uniqueness.
    const runId = await enrolAndStart(KEYS.loop, contact(1), INSIDE_WINDOW_ISO)
    const before = smsCalls()
    await runFlowTick(runtime, { runId, atIso: LONG_AFTER_ISO })

    const log = await readRunStepLog(sql, runId)
    const arrivals = log.filter((row) => row.nodeId === 'touch')
    // The loop runs to the 200-execution ceiling in one tick, which is three nodes a pass.
    expect(
      arrivals.length,
      'the loop reached the message node at least fifty times',
    ).toBeGreaterThanOrEqual(50)
    expect(arrivals[0]?.outcome, 'the first arrival executed').toBe('executed')
    expect(
      arrivals.slice(1, 50).map((row) => row.outcome),
      '49 further arrivals at the same node, every one a typed duplicate',
    ).toEqual(Array.from({ length: 49 }, () => 'duplicate'))
    expect(await messagesFor(runId), 'exactly one message row').toBe(1)
    expect(smsCalls() - before, 'the vendor was asked exactly once').toBe(1)
    // ONE token, not three: a delay and a condition change nothing outside the run, so neither claims one.
    // The token is the record of a SIDE EFFECT, and there is exactly one node here that has one.
    expect(
      await countNodeEffects(sql, runId),
      'one token, for the one node with a side effect',
    ).toBe(1)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// The kill
// ------------------------------------------------------------------------------------------------

describe('acceptance — the side effect and its token commit with the job, and a kill loses both', () => {
  it('SIGKILLs a real worker after the vendor answered, then replays and sends no second message', async () => {
    const runId = await enrolAndStart(KEYS.kill, contact(19), INSIDE_WINDOW_ISO)
    const evidence = join(process.env['TMPDIR'] ?? '/tmp', `cauto07-kill-${randomUUID()}.json`)

    // A REAL process, really killed, from inside `transport.send` and after the acceptance came back. A
    // thrown error would not do: an aborted transaction and a killed connection both roll back, but a throw
    // also unwinds through `sendMessage`, which turns an unexpected transport failure into a recorded
    // `failed` outcome — a different test about a different thing.
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/worker/src/testing/flow-kill-probe.ts',
        runId,
        INSIDE_WINDOW_ISO,
        evidence,
      ],
      { encoding: 'utf8', env: process.env, timeout: 60_000 },
    )
    expect(
      child.signal,
      `the probe was meant to be SIGKILLed; it exited ${String(child.status)}:\n${child.stderr}`,
    ).toBe('SIGKILL')

    // The vendor WAS asked, which only the evidence file can say: everything the tick was going to write
    // afterwards was inside the transaction the kill destroyed.
    const asked = JSON.parse(readFileSync(evidence, 'utf8')) as {
      idempotencyKey: string
      providerMessageId: string | null
      outcome: string
    }
    expect(asked.outcome, 'the fake accepted the message before the kill').toBe('accepted')
    expect(asked.providerMessageId).toBeTruthy()
    rmSync(evidence, { force: true })

    // And NOTHING committed. This is the acceptance line's "same transaction": the message row, the
    // idempotency token, the frequency ledger row, the step log row and the next tick all went together.
    expect(await messagesFor(runId), 'no message row survived the kill').toBe(0)
    expect(await countNodeEffects(sql, runId), 'no idempotency token survived it either').toBe(0)
    expect(await readRunStepLog(sql, runId), 'and no step log row').toHaveLength(0)
    const stalled = await readFlowRun(sql, runId)
    expect(
      stalled?.status,
      'the run is still owed, which is what makes a replay the right answer',
    ).toBe('running')
    expect(stalled?.cursorNodeId, 'and its cursor never moved').toBeNull()

    // The replay, in this process. One message row, one token, one vendor call.
    const before = smsCalls()
    expect((await runFlowTick(runtime, { runId, atIso: INSIDE_WINDOW_ISO })).kind).toBe('finished')
    expect(await messagesFor(runId)).toBe(1)
    expect(await countNodeEffects(sql, runId)).toBe(1)
    expect(smsCalls() - before, 'the replay asked the vendor once').toBe(1)

    // THE assertion, and the chain it stands on. The replay asked for the SAME message: the provider id it
    // was given is byte-identical to the one the killed process was given, because both derived it from the
    // same (flow_run, node, channel, contact) idempotency key. A vendor handed the same key twice sends
    // once — `packages/providers/src/behaviour.test.ts` proves that of the fake directly, and it is SMSala's
    // own contract — so exactly one message left.
    //
    // What this case cannot prove is the suppression itself across the two processes: the fake's memory of a
    // key lives in the memory of a process that no longer exists. Said out loud rather than glossed, because
    // asserting "no second message" from one process would be a weaker thing under a stronger name.
    const [row] = await sql<{ providerMessageId: string | null }[]>`
      select m.provider_message_id as "providerMessageId" from message m
       where m.id = (select message_id from flow_step_log
                      where flow_run_id = ${runId}::uuid and message_id is not null limit 1)
    `
    expect(row?.providerMessageId, 'the replay asked for the same message, not a new one').toBe(
      asked.providerMessageId,
    )

    // And a second replay sends nothing at all, which is the token layer doing its job now that it exists.
    expect((await runFlowTick(runtime, { runId, atIso: INSIDE_WINDOW_ISO })).kind).toBe(
      'already_ended',
    )
    expect(await messagesFor(runId)).toBe(1)
    expect(smsCalls() - before).toBe(1)
  }, 120_000)
})

// ------------------------------------------------------------------------------------------------
// The tag node, and the vocabulary disagreement it found
// ------------------------------------------------------------------------------------------------

describe('a tag the database will not store is a recorded refusal, not a dead-lettered job', () => {
  it('records tag_not_storable and carries on, with the grammar in the row', async () => {
    // The defect this case exists for: the DSL's `action_tag.tag` is lower snake_case and
    // `customer_tag.tag` is kebab-case, so NO string satisfies both — a flow an operator draws validates,
    // publishes, and then cannot write its tag. Found by running the interpreter, which is the first thing
    // in this build that writes a tag from a flow. The reconciliation belongs to C-AUTO-09 (a NOTE in the
    // manifest says so); what is asserted here is that the failure is a row somebody can read.
    const runId = await enrolAndStart(KEYS.tag, contact(18), INSIDE_WINDOW_ISO)
    expect((await runFlowTick(runtime, { runId, atIso: INSIDE_WINDOW_ISO })).kind).toBe('finished')
    const step = (await readRunStepLog(sql, runId)).find((row) => row.nodeId === 'touch')
    expect(step?.outcome).toBe('refused')
    expect(step?.gateDecision).toBe('tag_not_storable')
    expect(step?.detail).toContain('customer_tag_tag_check')
    // And the flow carried on to its exit rather than stopping, which is what "recorded, not raised" means.
    expect((await readRunStepLog(sql, runId)).at(-1)?.nodeKind).toBe('exit')
  }, 60_000)

  it('the copy of the grammar matches the live CHECK, and the writer works under it', async () => {
    // The copy in `tag.ts` is a second statement of a fact, so it is held to the first: the CHECK itself,
    // read from the catalogue. A renamed or widened constraint fails here rather than being discovered by a
    // flow that stopped tagging.
    const [live] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'customer_tag_tag_check'
    `
    expect(live?.def, 'the constraint still exists under that name').toBeTruthy()
    expect(live?.def).toContain(STORABLE_TAG.source)

    // And the control: the writer DOES store a tag the grammar accepts, so the refusal above is the
    // grammar and not a writer that never worked.
    const contactId = contact(19)
    expect(
      await applyCustomerTag(sql, { customerId: contactId, tag: 'cauto07-touch' }),
      'a kebab-case tag is stored',
    ).toBe(true)
    expect(
      await applyCustomerTag(sql, { customerId: contactId, tag: 'cauto07-touch' }),
      'and applying it twice is a no-op rather than a second row',
    ).toBe(false)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// The loop bound
// ------------------------------------------------------------------------------------------------

describe('acceptance — a self-referencing flow halts at the cap with loop_detected', () => {
  it('halts at exactly the configured ceiling, marks the enrolment and raises an alert', async () => {
    const runId = await enrolAndStart(KEYS.loop, contact(2), INSIDE_WINDOW_ISO)
    await runFlowTick(runtime, { runId, atIso: LONG_AFTER_ISO })

    const run = await readFlowRun(sql, runId)
    expect(run?.status).toBe('loop_detected')
    // INSIDE the bound, and exactly at it. Not `toBeLessThanOrEqual`, which a run that halted after three
    // executions would also satisfy — and that is a different defect.
    expect(run?.nodeExecutions).toBe(MAX_FLOW_NODE_EXECUTIONS)
    expect(run?.maxNodeExecutions).toBe(MAX_FLOW_NODE_EXECUTIONS)
    expect(run?.endedReason).toBe('loop_detected')

    const [enrolment] = await sql<{ status: string; endedReason: string | null }[]>`
      select status::text as status, ended_reason as "endedReason" from flow_enrolment
       where id = (select enrolment_id from flow_run where id = ${runId}::uuid)
    `
    expect(enrolment?.status).toBe('cancelled')
    expect(enrolment?.endedReason).toBe('loop_detected')

    expect(alerts.map((alert) => alert.runId)).toContain(runId)
    const [event] = await sql<{ n: string }[]>`
      select count(*)::text as n from outbox_event
       where event_type = 'automation.flow_run_loop_detected' and aggregate_id = ${runId}
    `
    expect(Number(event?.n), 'the alert is durable with the halt, not only in the spy').toBe(1)
  }, 60_000)

  it('the control: a contact the condition releases finishes without halting', async () => {
    // Without this, "it halts" would also be true of an interpreter that halted every run. The same
    // document and the same ceiling, with the one fact the condition tests flipped.
    const contactId = contact(3)
    await sql`update customer set is_vip = true, vip_since = now() where id = ${contactId}::uuid`
    const runId = await enrolAndStart(KEYS.loop, contactId, INSIDE_WINDOW_ISO)
    await runFlowTick(runtime, { runId, atIso: LONG_AFTER_ISO })
    const run = await readFlowRun(sql, runId)
    expect(run?.status).toBe('completed')
    expect(run?.nodeExecutions).toBeLessThan(MAX_FLOW_NODE_EXECUTIONS)
    expect(run?.endedReason).toBe('goal_met')
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// The enrolment API
// ------------------------------------------------------------------------------------------------

describe('acceptance — one active enrolment per contact, and a named per-flow cap', () => {
  it('yields a typed already_enrolled outcome and no second row', async () => {
    const contactId = contact(4)
    const enrol = () =>
      asManager((uow) =>
        enrolOnLiveVersion(uow, {
          flowKey: KEYS.cap,
          customerId: contactId,
          createdBy: PUBLISHED_BY,
          at: new Date(INSIDE_WINDOW_ISO),
        }),
      )
    const first = await enrol()
    expect(first.outcome).toBe('enrolled')
    const second = await enrol()
    expect(second.outcome).toBe('already_enrolled')
    // The SAME enrolment, not a second one: the ids are what a caller goes on to start a run with, so a
    // fresh id here would be two runs of one flow for one person.
    expect(second.enrolmentId).toBe(first.enrolmentId)
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from flow_enrolment
       where customer_id = ${contactId}::uuid
         and flow_id = ${flowOf(KEYS.cap).flowId}::uuid
         and status = 'active'
    `
    expect(Number(count?.n), 'one active enrolment, whatever the caller asked for').toBe(1)
  })

  it('refuses the enrolment past the cap by name, and lifts again when the flow empties', async () => {
    // The REAL bound, not an injected one: `MAX_ACTIVE_ENROLMENTS_PER_FLOW` is written once, so the only
    // honest way to reach it is to fill the flow. Five thousand contacts and five thousand enrolments in two
    // statements, then removed — the customers cascade their enrolments away (0070's reason for the cascade).
    const { flowId, version } = flowOf(KEYS.cap)
    await sql`
      insert into customer (phone_e164, created_via)
      select '+97159' || lpad((${CAP_BAND_FIRST} + g - 1)::text, 7, '0'), 'front_desk'
        from generate_series(1, ${MAX_ACTIVE_ENROLMENTS_PER_FLOW}) as g
      on conflict (phone_e164) do nothing
    `
    await sql`
      insert into flow_enrolment (flow_id, definition_version, customer_id, enrolled_at, created_by)
      select ${flowId}::uuid, ${version}, c.id, ${INSIDE_WINDOW_ISO}::timestamptz, ${PUBLISHED_BY}
        from customer c
       where c.phone_e164 between ${syntheticPerson(CAP_BAND_FIRST).phone}
         and ${syntheticPerson(CAP_BAND_FIRST + MAX_ACTIVE_ENROLMENTS_PER_FLOW - 1).phone}
      on conflict (flow_id, customer_id) where ended_at is null do nothing
    `
    const [active] = await sql<{ n: string }[]>`
      select count(*)::text as n from flow_enrolment
       where flow_id = ${flowId}::uuid and status = 'active'
    `
    expect(Number(active?.n), 'the flow is at or over its ceiling').toBeGreaterThanOrEqual(
      MAX_ACTIVE_ENROLMENTS_PER_FLOW,
    )

    const fresh = contact(5)
    let caught: unknown
    try {
      await asManager((uow) =>
        enrolOnLiveVersion(uow, {
          flowKey: KEYS.cap,
          customerId: fresh,
          createdBy: PUBLISHED_BY,
          at: new Date(INSIDE_WINDOW_ISO),
        }),
      )
    } catch (error) {
      caught = error
    }
    // By NAME, and the name is the one `crm-pipeline.itest.ts` already injects an enroller raising in order
    // to prove a refusal travels out of `moveCard` unchanged. Same string, on purpose.
    expect(flowRefusalOf(caught)).toBe('flow_enrolment_cap_reached')
    expect(String(caught)).toContain(String(MAX_ACTIVE_ENROLMENTS_PER_FLOW))

    // The control: the same contact on a DIFFERENT flow is accepted, so the refusal is a cap on one flow and
    // not a cap on the contact.
    const elsewhere = await asManager((uow) =>
      enrolOnLiveVersion(uow, {
        flowKey: KEYS.dry,
        customerId: fresh,
        createdBy: PUBLISHED_BY,
        at: new Date(INSIDE_WINDOW_ISO),
      }),
    )
    expect(elsewhere.outcome).toBe('enrolled')

    await sql`
      delete from customer where phone_e164 between ${syntheticPerson(CAP_BAND_FIRST).phone}
        and ${syntheticPerson(CAP_BAND_FIRST + MAX_ACTIVE_ENROLMENTS_PER_FLOW - 1).phone}
    `
    // And it LIFTS, which is what makes it a cap on ACTIVE enrolments rather than a permanent ceiling on the
    // flow — a flow that had run a million times would otherwise become unenrollable for ever.
    const after = await asManager((uow) =>
      enrolOnLiveVersion(uow, {
        flowKey: KEYS.cap,
        customerId: contact(6),
        createdBy: PUBLISHED_BY,
        at: new Date(INSIDE_WINDOW_ISO),
      }),
    )
    expect(after.outcome).toBe('enrolled')
  }, 180_000)
})

// ------------------------------------------------------------------------------------------------
// The dry run
// ------------------------------------------------------------------------------------------------

describe('acceptance — a dry run writes a full projected step log and sends nothing', () => {
  it('projects every node for every contact, with zero message rows and zero provider calls', async () => {
    const audience = [contact(7), contact(8), contact(9)].map((customerId) => ({ customerId }))
    const { flowId, version } = flowOf(KEYS.dry)

    const [before] = await sql<{ n: string }[]>`select count(*)::text as n from message`
    const callsBefore = smsCalls()

    const result = await projectFlowDryRun(runtime, {
      flowId,
      definitionVersion: version,
      definition: sendFlow(KEYS.dry),
      audience,
      maxNodeExecutions: MAX_FLOW_NODE_EXECUTIONS,
      atIso: INSIDE_WINDOW_ISO,
    })

    const [after] = await sql<{ n: string }[]>`select count(*)::text as n from message`
    // ROW COUNTS and a SPY on the transport, which is what the acceptance line asks for by name. Either one
    // alone is satisfiable by a test that never built a send at all.
    expect(Number(after?.n) - Number(before?.n), 'zero message rows').toBe(0)
    expect(smsCalls() - callsBefore, 'zero provider calls').toBe(0)

    const log = await readRunStepLog(sql, result.runId)
    // A row per (contact, node) over the whole graph: three nodes, three contacts.
    expect(log).toHaveLength(9)
    expect(new Set(log.map((row) => row.contactCustomerId))).toEqual(
      new Set(audience.map((member) => member.customerId)),
    )
    expect(result.audienceSize).toBe(3)
    expect(result.projectedRowsOmitted).toBe(0)

    // The message node's projected row carries the planned channel, the template, the planned instant and
    // the costing — the facts the acceptance line names, with the resolved audience BEING the contact column.
    const projectedSend = log.find((row) => row.nodeId === 'tell_them')
    expect(projectedSend?.channel).toBe('sms')
    expect(projectedSend?.templateKey).toBe(TEMPLATE_KEY)
    expect(projectedSend?.plannedAtIso).toBe(INSIDE_WINDOW_ISO)
    expect(projectedSend?.encoding).toBe('GSM-7')
    expect(projectedSend?.segments).toBe(1)
    expect(projectedSend?.costFils).toBeGreaterThan(0)
    // And NO message: the row is a plan.
    expect(projectedSend?.messageId).toBeNull()

    const run = await readFlowRun(sql, result.runId)
    expect(run?.mode).toBe('dry_run')
    expect(run?.projectedAudienceSize).toBe(3)
    expect(run?.projectedRowsOmitted).toBe(0)
  }, 60_000)

  it('reports the overflow rather than truncating the plan in silence', async () => {
    const audience = [contact(7), contact(8), contact(9)].map((customerId) => ({ customerId }))
    const { flowId, version } = flowOf(KEYS.dry)
    const result = await projectFlowDryRun(runtime, {
      flowId,
      definitionVersion: version,
      definition: sendFlow(KEYS.dry),
      audience,
      maxNodeExecutions: MAX_FLOW_NODE_EXECUTIONS,
      atIso: INSIDE_WINDOW_ISO,
      maxProjectedRows: 4,
    })
    expect(result.projectedRows).toBeLessThanOrEqual(4)
    // A NON-ZERO figure, which is the whole line: a plan trimmed to four rows without saying so is an
    // operator reading the plan of a campaign they are not about to send.
    expect(result.projectedRowsOmitted).toBeGreaterThan(0)
    expect(result.audienceSize, 'the audience is reported whole').toBe(3)
    const run = await readFlowRun(sql, result.runId)
    expect(run?.projectedRowsOmitted).toBe(result.projectedRowsOmitted)
  }, 60_000)

  it('the DATABASE refuses a dry run that tries to leave a side effect behind', async () => {
    // The guarantee is not the projection's care. ZY003 fires for every role including the owner, so "zero
    // message rows" holds for a `psql` session too — and both halves of the trigger are driven.
    const { flowId, version } = flowOf(KEYS.dry)
    const result = await projectFlowDryRun(runtime, {
      flowId,
      definitionVersion: version,
      definition: sendFlow(KEYS.dry),
      audience: [{ customerId: contact(7) }],
      maxNodeExecutions: MAX_FLOW_NODE_EXECUTIONS,
      atIso: INSIDE_WINDOW_ISO,
    })
    const token = await raised(sql`
      insert into flow_node_effect (flow_run_id, node_id, channel, contact_customer_id, claimed_at)
      values (${result.runId}::uuid, 'tell_them', 'sms', ${contact(7)}::uuid, now())
    `)
    expect(sqlstateOf(token)).toBe('ZY003')

    // And a step log row naming a message. The message is a real one from an earlier case, which is what
    // makes the refusal about the DRY RUN rather than about a dangling reference.
    const [existing] = await sql<{ id: string }[]>`
      select id from message order by queued_at desc limit 1
    `
    // A real message id, because a NULL one would satisfy the refusal for the wrong reason: the trigger
    // only fires on a dry-run row that NAMES a message, so a null would pass and prove nothing.
    if (existing === undefined)
      throw new Error('no message row to reference; an earlier case must send one')
    const named = await raised(sql`
      insert into flow_step_log (
        flow_run_id, flow_id, definition_version, node_id, node_kind, branch, outcome,
        contact_customer_id, message_id, planned_at
      ) values (
        ${result.runId}::uuid, ${flowId}::uuid, ${version}, 'tell_them', 'action_message', 'default',
        'executed', ${contact(7)}::uuid, ${existing.id}::uuid, now()
      )
    `)
    expect(sqlstateOf(named)).toBe('ZY003')

    // The control: the same token insert against a LIVE run is accepted, so ZY003 is about the mode and not
    // about the statement.
    const liveRunId = await enrolAndStart(KEYS.dry, contact(10), INSIDE_WINDOW_ISO)
    await sql`
      insert into flow_node_effect (flow_run_id, node_id, channel, contact_customer_id, claimed_at)
      values (${liveRunId}::uuid, 'probe_node', 'sms', ${contact(10)}::uuid, now())
    `
    expect(await countNodeEffects(sql, liveRunId)).toBe(1)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// The window
// ------------------------------------------------------------------------------------------------

describe('acceptance — a delay landing outside the window is released at the next opening', () => {
  it('holds the message, pauses on the gate instant, and sends it at the opening', async () => {
    // The run starts at 01:30 Dubai and the delay is 30 minutes, so the send lands at 02:00 Dubai — inside
    // trading hours (11:00-02:00) and outside the promotional window, which is the case the window rule's
    // own header calls the interesting one.
    const startIso = '2099-03-04T21:30:00.000Z'
    const runId = await enrolAndStart(KEYS.window, contact(11), startIso)

    queued.length = 0
    expect((await runFlowTick(runtime, { runId, atIso: startIso })).kind).toBe('advanced')
    expect(queued.at(-1)?.startAfterSeconds, 'the next tick is queued for the delay target').toBe(
      30 * 60,
    )

    const before = smsCalls()
    queued.length = 0
    expect((await runFlowTick(runtime, { runId, atIso: OUTSIDE_WINDOW_ISO })).kind).toBe('paused')
    expect(smsCalls() - before, 'the vendor was not asked outside the window').toBe(0)

    const heldLog = (await readRunStepLog(sql, runId)).filter((row) => row.nodeId === 'tell_them')
    expect(heldLog.at(-1)?.outcome).toBe('held')
    expect(heldLog.at(-1)?.gateDecision).toBe('queued_for_window')
    // THE assertion: the release instant is the GATE's — the next opening of the promotional window — and
    // not anything this interpreter computed. 07:00 Asia/Dubai on the 5th.
    const held = await readFlowRun(sql, runId)
    expect(held?.resumeAtIso).toBe(NEXT_WINDOW_OPEN_ISO)
    expect(
      held?.cursorNodeId,
      'the cursor stays on the held node, or nothing comes back to it',
    ).toBe('tell_them')
    expect(queued.at(-1)?.startAfterSeconds).toBe(5 * 60 * 60)

    // The release. One message row, MOVED rather than created.
    expect((await runFlowTick(runtime, { runId, atIso: NEXT_WINDOW_OPEN_ISO })).kind).toBe(
      'finished',
    )
    expect(await messagesFor(runId), 'one message row across the hold and the release').toBe(1)
    expect(smsCalls() - before, 'the vendor was asked once, at the opening').toBe(1)
    const [message] = await sql<{ status: string }[]>`
      select m.status::text as status from message m
       where m.id = (select message_id from flow_step_log
                      where flow_run_id = ${runId}::uuid and message_id is not null limit 1)
    `
    expect(message?.status).toBe('sent')
  }, 60_000)

  it('the control: the same flow inside the window sends without being held', async () => {
    // Without this, "it was held" would also be true of an interpreter that held everything — and of one
    // whose gate was unreachable. The same document, a start instant whose delay lands at 14:30 Dubai.
    const runId = await enrolAndStart(KEYS.window, contact(12), INSIDE_WINDOW_ISO)
    await runFlowTick(runtime, { runId, atIso: INSIDE_WINDOW_ISO })
    const outcome = await runFlowTick(runtime, { runId, atIso: '2099-03-04T10:31:00.000Z' })
    expect(outcome.kind).toBe('finished')
    const log = (await readRunStepLog(sql, runId)).filter((row) => row.nodeId === 'tell_them')
    expect(log.map((row) => row.outcome)).toEqual(['executed'])
    expect(log[0]?.gateDecision).toBe('allow')
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// The step log
// ------------------------------------------------------------------------------------------------

describe('acceptance — why did this contact get this message is one query', () => {
  it('answers from one SELECT, with the version, node, consent record and gate decision', async () => {
    const contactId = contact(13)
    const runId = await enrolAndStart(KEYS.send, contactId, INSIDE_WINDOW_ISO)
    await runFlowTick(runtime, { runId, atIso: INSIDE_WINDOW_ISO })

    const sent = (await readRunStepLog(sql, runId)).find((row) => row.messageId !== null)
    const messageId = sent?.messageId
    if (messageId === undefined || messageId === null) {
      throw new Error('the run sent nothing to ask about')
    }

    // ONE statement, COUNTED rather than asserted by reading the source: a wrapper around `Sql` that counts
    // every statement the reader issues. C-AUTO-08's device for the pipeline board's one read.
    const counting = countingSql(sql)
    const answer = await readContactStepLog(counting.sql, {
      contactCustomerId: contactId,
      messageId,
    })
    expect(counting.count(), 'one SELECT and no more').toBe(1)

    expect(answer).toHaveLength(1)
    const row = answer[0]
    // The four facts the acceptance line names, each a column on the row rather than a second query.
    expect(row?.definitionVersion).toBe(flowOf(KEYS.send).version)
    expect(row?.nodeId).toBe('tell_them')
    expect(row?.consentRecordId, 'the consent record the gate rested on').not.toBeNull()
    expect(row?.gateDecision).toBe('allow')
    expect(row?.flowKey, 'the key a human reads instead of a uuid').toBe(KEYS.send)

    // The consent record is the one `resolveConsent` names — the NEWEST applicable — and not just any row
    // for this contact, so a writer that stored the first record would fail here.
    const [newest] = await sql<{ id: string }[]>`
      select id from consent
       where contact_customer_id = ${contactId}::uuid and channel = 'sms' and purpose = 'marketing'
       order by recorded_at desc, id desc limit 1
    `
    expect(row?.consentRecordId).toBe(newest?.id)

    // The control: the counter DOES see more than one statement, so "one" is a measurement and not a
    // constant. Without it a proxy that counted nothing would pass the assertion above.
    const twice = countingSql(sql)
    await readContactStepLog(twice.sql, { contactCustomerId: contactId })
    await readContactStepLog(twice.sql, { contactCustomerId: contactId })
    expect(twice.count()).toBe(2)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// The merge
// ------------------------------------------------------------------------------------------------

describe('acceptance — a contact merged mid-run continues on the survivor exactly once', () => {
  it('continues the loser’s run on the survivor and sends one message', async () => {
    // WHICH of the two survives is `planCustomerMerge`'s decision and not this file's: it resolves the
    // pair from the records themselves (C-CRM-05), so the fixture asks and then enrols the loser. A test
    // that named the survivor itself would be asserting against its own guess.
    const pair = await planFor(sql, contact(14), contact(15))
    const survivorId = pair.plan.survivorId
    const loserId = pair.loserId
    const runId = await enrolAndStart(KEYS.merge, loserId, INSIDE_WINDOW_ISO)
    const before = smsCalls()

    await asManager(async (uow) => {
      await mergeCustomers(uow, {
        plan: pair.plan,
        mergedAtIso: INSIDE_WINDOW_ISO,
        reason: 'One person, two records: the same handset was entered twice at the front desk.',
        actorKind: 'staff',
        actorLabel: 'Manager (fixture)',
      })
    })

    // The enrolment moved and its run followed it: nothing about the run had to be touched, because the run
    // hangs off the enrolment and `flow_run.enrolment_id` is immutable (ZY004).
    const [owner] = await sql<{ customerId: string }[]>`
      select e.customer_id as "customerId" from flow_enrolment e
       where e.id = (select enrolment_id from flow_run where id = ${runId}::uuid)
    `
    expect(owner?.customerId, 'the enrolment moved to the survivor').toBe(survivorId)

    expect((await runFlowTick(runtime, { runId, atIso: INSIDE_WINDOW_ISO })).kind).toBe('finished')
    expect(await messagesFor(runId), 'exactly one message').toBe(1)
    expect(smsCalls() - before, 'the vendor was asked exactly once').toBe(1)

    // ON THE SURVIVOR: the step log and the token both name it, so a replay computes the survivor's key and
    // finds the token rather than sending again.
    const log = await readRunStepLog(sql, runId)
    expect(new Set(log.map((row) => row.contactCustomerId))).toEqual(new Set([survivorId]))
    const [token] = await sql<{ contactCustomerId: string }[]>`
      select contact_customer_id as "contactCustomerId" from flow_node_effect
       where flow_run_id = ${runId}::uuid
    `
    expect(token?.contactCustomerId).toBe(survivorId)

    // EXACTLY once: the replay sends nothing.
    expect((await runFlowTick(runtime, { runId, atIso: INSIDE_WINDOW_ISO })).kind).toBe(
      'already_ended',
    )
    expect(await messagesFor(runId)).toBe(1)
    expect(smsCalls() - before).toBe(1)
  }, 60_000)

  it('cancels the run when the survivor was already enrolled, rather than sending twice', async () => {
    // The other half, and the one the partial unique index creates: the survivor already holds an active
    // enrolment on this flow, so `flow_enrolment_one_active_per_contact` refuses the re-point and the
    // loser's enrolment is RETAINED on the tombstone. Continuing it would send the survivor the same node a
    // second time, so the tick cancels with `contact_merged_away`.
    const pair = await planFor(sql, contact(16), contact(17))
    const survivorId = pair.plan.survivorId
    const loserId = pair.loserId
    const survivorRun = await enrolAndStart(KEYS.merge, survivorId, INSIDE_WINDOW_ISO)
    const loserRun = await enrolAndStart(KEYS.merge, loserId, INSIDE_WINDOW_ISO)
    const before = smsCalls()

    await asManager(async (uow) => {
      await mergeCustomers(uow, {
        plan: pair.plan,
        mergedAtIso: INSIDE_WINDOW_ISO,
        reason: 'One person, two records: the same handset was entered twice at the front desk.',
        actorKind: 'staff',
        actorLabel: 'Manager (fixture)',
      })
    })

    const [retained] = await sql<{ customerId: string }[]>`
      select e.customer_id as "customerId" from flow_enrolment e
       where e.id = (select enrolment_id from flow_run where id = ${loserRun}::uuid)
    `
    expect(retained?.customerId, 'the loser’s enrolment stayed on the tombstone').toBe(loserId)

    const halted = await runFlowTick(runtime, { runId: loserRun, atIso: INSIDE_WINDOW_ISO })
    expect(halted.kind).toBe('halted')
    const run = await readFlowRun(sql, loserRun)
    expect(run?.status).toBe('cancelled')
    expect(run?.endedReason).toBe('contact_merged_away')
    expect(await messagesFor(loserRun), 'the abandoned run sent nothing').toBe(0)

    // And the survivor's OWN run is untouched and still sends once, which is the "exactly once" the line is
    // about: one contact, one flow, one message.
    expect(
      (await runFlowTick(runtime, { runId: survivorRun, atIso: INSIDE_WINDOW_ISO })).kind,
    ).toBe('finished')
    expect(await messagesFor(survivorRun)).toBe(1)
    expect(smsCalls() - before, 'one send across both runs').toBe(1)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------

/** The error a statement raised, or null. `expect(...).rejects` cannot hand back the SQLSTATE. */
async function raised(work: Promise<unknown>): Promise<unknown> {
  try {
    await work
    return null
  } catch (error) {
    return error
  }
}

const sqlstateOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code

/**
 * A wrapper that counts the statements a reader issues.
 *
 * "One query" is a claim about the number of round trips, and the only way to assert it is to count them:
 * reading the source proves the source, and a source that looks like one query can still be two. C-AUTO-08
 * used the same device for the pipeline board and B-UI-03 for the admin calendar's two axes.
 */
function countingSql(inner: Sql): { readonly sql: Sql; readonly count: () => number } {
  let issued = 0
  const proxy = new Proxy(inner as unknown as (...args: unknown[]) => unknown, {
    apply(target, thisArg, args) {
      issued += 1
      return Reflect.apply(target, thisArg, args)
    },
  })
  return { sql: proxy as unknown as Sql, count: () => issued }
}

/**
 * The plan a merge of two of this file's contacts makes, from the real scorer, and which of them loses.
 *
 * The plan decides the survivor — `planCustomerMerge` resolves the pair from the records themselves
 * (C-CRM-05) — so the caller is handed both ids rather than being asked to guess. A fixture that named the
 * survivor and then asserted the plan agreed would be asserting against its own guess.
 */
async function planFor(
  tx: Sql,
  a: string,
  b: string,
): Promise<{ readonly plan: CustomerMergePlanInput; readonly loserId: string }> {
  const first = await readCustomerMergeSubject(tx, a)
  const second = await readCustomerMergeSubject(tx, b)
  if (first === null || second === null) throw new Error('a fixture contact is missing')
  // One number scored against ITSELF, which is what the fixture represents: two spellings of one handset,
  // the only shape C-CRM-02's table lets `auto_merge` act on. `merge.itest.ts` does the same and says why.
  const person = syntheticPerson(CONTACT_BAND_FIRST)
  const score = scoreDuplicatePair(
    { phone: person.phone, label: person.label },
    { phone: person.phone, label: person.label },
  )
  const decision = planCustomerMerge(
    first as CustomerMergeSubject,
    second as CustomerMergeSubject,
    score,
    'auto_merge',
  )
  if (decision.kind !== 'plan') throw new Error(`the fixture pair was refused: ${decision.refusal}`)
  expect([a, b], 'the plan names one of the pair as the survivor').toContain(decision.survivorId)
  return {
    plan: decision satisfies CustomerMergePlanInput,
    loserId: decision.survivorId === a ? b : a,
  }
}
