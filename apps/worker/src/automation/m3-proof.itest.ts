import { loadConfig } from '@berelax/config'
import {
  composeJourney,
  delayStep,
  exitStep,
  type FlowTemplateFact,
  messageStep,
  normalisePhone,
  suppressionKeyNormaliser,
  templateRefFor,
  validateFlowDefinition,
} from '@berelax/core'
import {
  type Actor,
  applyPreferenceCentreChange,
  createConnection,
  enrolOnLiveVersion,
  recordSuppression,
  type Sql,
  type SuppressionKeying,
  seedStockFlows,
  setFlowActive,
  toggleMessagingControl,
  withUnitOfWork,
} from '@berelax/db'
import { fixtureSuppressionPeppers, syntheticPerson } from '@berelax/fixtures'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTestInterpreterRuntime } from '../testing/flow-runtime.ts'
import { runFlowTick, startRunAndQueueFirstTick } from './interpreter.ts'

/**
 * **MILESTONE M3**, as one integration test, with every assertion on ROWS.
 *
 * docs/00's own wording: *booking event → automation enrolment → consented SMS sent → opt-out honoured →
 * suppression blocks the next send*. C-AUTO-11's acceptance line adds the clause that decides the shape —
 * *"all assertions on rows not logs"* — and the second line adds the control: the same chain with the
 * marketing kill switch engaged must send nothing promotional and still deliver the transactional
 * message.
 *
 * ## `booking.created` is not a trigger event, and that is reported rather than worked around
 *
 * `FLOW_TRIGGER_EVENTS` in `schemas/flow.ts` is appointment-level: `appointment.confirmed`,
 * `appointment.completed` and six others. There is no booking-level event, so a journey cannot be entered
 * by `booking.created` as such, and the chain below is entered by `appointment.completed` — which is the
 * booking event this journey is about. The absence is a finding about the DSL's vocabulary; it is recorded
 * here, in `journeys.ts`, and in C-AUTO-11's manifest NOTE.
 *
 * ## Why the journey is this file's and not one of the three seeded ones
 *
 * M3 is a proof of the CHAIN, and the chain needs a promotional message that actually leaves. The only
 * promotional template this build ships is `review.request`, which ships `draft` *precisely* so that its
 * words cannot reach a customer until somebody with the authority to approve marketing copy has done so
 * (`templates.ts` says so in as many words). So the three seeded journeys cannot demonstrate a successful
 * promotional send, and they should not be able to. This file brings its own approved templates — fixture
 * copy, which ships nowhere — and composes its journey through the SAME `composeJourney` the stock ones
 * use, so M3 is not a second DSL.
 *
 * ## The contacts are not removed; the flow and its runs are
 *
 * The contacts carry `consent` rows and `consent` is append-only (ADR 0008), so they are created
 * idempotently from one number band and left, as `campaign.itest.ts` does. `flow_definition` is
 * append-only too, so the M3 flow is published once per run under a per-run key and left; its enrolments
 * and runs cascade when the enrolment goes.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

const MARKER = 'cauto11_m3'
/**
 * A FIXED key, and the flow is published through `seedStockFlows` rather than `publishFlowDefinition`.
 *
 * The first version of this file used a per-run key, on the grounds that `flow_definition` is append-only
 * and a key cannot be reused. It can: `seedStockFlows` compares the stored jsonb with the composed
 * document and publishes only when they differ, which is the same mechanism the three stock journeys are
 * seeded by. A per-run key left one flow row and one definition row behind on EVERY run, in a table
 * nothing in this repository can clean up — and the count of them was the only evidence. One key, one
 * version, for ever.
 */
const FLOW_KEY = `${MARKER}_proof`

/**
 * This file's number band. Three contacts, and the third one is the acceptance clause's own word.
 *
 * 0 runs the chain, 1 is the kill-switch control, and 2 is suppressed WITHOUT a withdrawal — see the
 * third case for why that is a separate contact and not a repeat.
 */
const BAND_FIRST = 7_300_001
const CONTACTS = 3

/** 14:00 Asia/Dubai — inside the promotional window, which is 07:00-21:00. */
const INSIDE_WINDOW_ISO = '2026-09-18T10:00:00.000Z'
/** Two hours later, still inside the window. Where the second node is reached. */
const LATER_INSIDE_WINDOW_ISO = '2026-09-18T12:00:00.000Z'

/**
 * The two bodies this file sends.
 *
 * FIXTURE copy and not shipped copy: no human has approved any promotional wording for this business
 * (brief rule 15), and nothing in this file ships. Neither declares a placeholder, because a flow node
 * carries no values and B-MSG-01's renderer refuses a blank for a declared variable — a template with one
 * would be refused before the gate was reached, and every case below would be measuring the renderer.
 */
const PROMO_BODY = 'BE RELAX fixture offer. Reply STOP to opt out.'
const TXN_BODY = 'BE RELAX fixture booking note. No action needed.'

const PROMO_KEY = `${MARKER}.promo`
const TXN_KEY = `${MARKER}.txn`

const ACTOR: Actor = { kind: 'system', label: 'C-AUTO-11 M3 fixture' }
const KEYING = (): SuppressionKeying => ({
  peppers: fixtureSuppressionPeppers(process.env),
  normalise: suppressionKeyNormaliser,
})

let contactIds: readonly string[] = []
let flowId = ''
let pinnedVersion = 0
let runtime: Awaited<ReturnType<typeof buildRuntime>>
let smsSuccessCount: () => number = () => 0

const contact = (index: number): string => {
  const id = contactIds[index]
  if (id === undefined) throw new Error(`no probe contact at ${index}`)
  return id
}

async function buildRuntime(transport: ReturnType<typeof createSmsalaTransport>['transport']) {
  return buildTestInterpreterRuntime({
    sql,
    transport,
    spies: { queued: [], alerts: [] },
  })
}

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })

  const people = Array.from({ length: CONTACTS }, (_, index) =>
    normalisePhone(syntheticPerson(BAND_FIRST + index).phone),
  )
  await sql`
    insert into customer (phone_e164, locale, created_via)
    select phone, 'en', 'front_desk' from unnest(${people as string[]}::text[]) as t(phone)
    on conflict (phone_e164) do nothing
  `
  const rows = await sql<{ id: string }[]>`
    select id::text as id from customer
     where phone_e164 = any(${people as string[]}::text[]) order by phone_e164
  `
  contactIds = rows.map((row) => row.id)
  if (contactIds.length !== CONTACTS) {
    throw new Error(`expected ${CONTACTS} probe contacts, found ${contactIds.length}`)
  }

  // Marketing consent on SMS for both, resting on the published wording: `ImportIsNotAnOptIn` (0056)
  // refuses a grant that names none. Idempotent on `consent_one_record_per_instant`.
  const [wording] = await sql<{ id: string }[]>`
    select id::text as id from consent_wording
     where purpose = 'marketing' order by version desc limit 1
  `
  if (wording === undefined)
    throw new Error('no marketing consent wording is published; run pnpm seed')
  await sql`
    insert into consent (contact_customer_id, channel, purpose, kind, recorded_at,
                         consent_wording_id, wording_hash, capture_source, capture_actor_kind,
                         capture_actor_label, capture_locale, created_at)
    select t.id::uuid, 'sms'::message_channel, 'marketing', 'granted'::consent_kind,
           ${INSIDE_WINDOW_ISO}::timestamptz, ${wording.id}::uuid, w.content_hash,
           'booking_form', 'customer', ${`${MARKER} fixture`}, 'en', ${INSIDE_WINDOW_ISO}::timestamptz
      from unnest(${contactIds as string[]}::text[]) as t(id)
      cross join consent_wording w
     where w.id = ${wording.id}::uuid
    on conflict (contact_customer_id, channel, purpose, kind, recorded_at) do nothing
  `

  // The two templates, created idempotently and never removed: `message.template_id` is ON DELETE
  // RESTRICT, so the first send pins them for the life of the database.
  for (const [key, messageClass, body] of [
    [PROMO_KEY, 'promotional', PROMO_BODY],
    [TXN_KEY, 'transactional', TXN_BODY],
  ] as const) {
    await sql`
      insert into message_template (template_key, version, message_class, purpose, is_current)
      values (${key}, 1, ${messageClass}::message_class, 'C-AUTO-11 M3 fixture', true)
      on conflict (template_key, version) do nothing
    `
    const [template] = await sql<{ id: string }[]>`
      select id::text as id from message_template where template_key = ${key} and version = 1
    `
    if (template === undefined) throw new Error(`could not create the fixture template ${key}`)
    await sql`
      insert into message_template_variant
        (template_id, channel, locale, approval_state, body, variables)
      select ${template.id}::uuid, 'sms', 'en', 'approved'::template_approval, ${body}, '{}'
       where not exists (
         select 1 from message_template_variant
          where template_id = ${template.id}::uuid and channel = 'sms' and locale = 'en'
       )
    `
  }

  // This file's own frequency-ledger rows, removed so the REAL caps are in force on every run.
  //
  // Two promotional messages per rolling seven days is the provisional cap, and this file sends up to two
  // to each of its contacts in one run — so without this a second run would be measuring the frequency
  // cap rather than the suppression, and the refusal under test would arrive as `refused_frequency_cap`.
  // It did, on the first run of this suite, which is the failure worth having met: a refusal is only
  // evidence of the rule it names. The rows are this file's own and `frequency_ledger` is a counting
  // table rather than a record anybody answers for; the `message` rows stay where they are.
  await sql`
    delete from frequency_ledger where contact_customer_id = any(${contactIds as string[]}::uuid[])
  `

  // THE journey, composed through the same typed composer the three stock ones use.
  const templates: readonly FlowTemplateFact[] = [
    { templateKey: PROMO_KEY, messageClass: 'promotional' },
    { templateKey: TXN_KEY, messageClass: 'transactional' },
  ]
  const promo = templateRefFor(templates, 'promotional', PROMO_KEY)
  const txn = templateRefFor(templates, 'transactional', TXN_KEY)
  if (promo === null || txn === null) throw new Error('the fixture registry must mint both refs')

  const journey = composeJourney({
    key: FLOW_KEY,
    title: 'M3 proof',
    description:
      'The M3 chain: a booking event enrols the contact, a transactional note leaves, a consented ' +
      'promotional SMS passes the gate inside the window, and a second promotional node is reached ' +
      'later so an opt-out between the two has something to block.',
    trigger: {
      id: 'completed',
      event: 'appointment.completed',
      note: 'FLOW_TRIGGER_EVENTS has no booking-level event; see this file and journeys.ts.',
    },
    steps: {
      // Transactional, and FIRST: the kill-switch control asserts that this one still leaves while the
      // two promotional nodes do not, which is the whole of C-AUTO-05's structural claim.
      confirm: messageStep({ template: txn, channel: 'sms' }),
      offer: messageStep({ template: promo, channel: 'sms' }),
      wait: delayStep({ minutes: 60 }),
      follow_up: messageStep({ template: promo, channel: 'sms' }),
      done: exitStep({ reason: 'completed' }),
    },
    edges: {
      'completed:default': 'confirm',
      'confirm:default': 'offer',
      'offer:default': 'wait',
      'wait:default': 'follow_up',
      'follow_up:default': 'done',
    },
  })

  const verdict = validateFlowDefinition(journey, { templates })
  if (!verdict.ok) {
    throw new Error(
      `the M3 journey is not a valid document: ${verdict.refusals.map((r) => r.rule).join(', ')}`,
    )
  }

  // Published through the SEEDER, not through `publishFlowDefinition` directly: the seeder compares the
  // stored document with the composed one and publishes only on a difference, so running this file a
  // hundred times leaves one version. See FLOW_KEY.
  await seedStockFlows(sql, {
    flows: [{ flowKey: FLOW_KEY, title: 'M3 proof', definition: journey }],
    validate: (candidate) => validateFlowDefinition(candidate, { templates }),
    publishedAtIso: INSIDE_WINDOW_ISO,
    publishedBy: 'C-AUTO-11 M3 fixture',
  })
  const [flow] = await sql<{ id: string; version: number }[]>`
    select f.id::text as id,
           (select max(d.version) from flow_definition d where d.flow_id = f.id) as version
      from flow f where f.flow_key = ${FLOW_KEY}
  `
  if (flow === undefined) throw new Error('the M3 flow was not published')
  flowId = flow.id
  pinnedVersion = flow.version
  await withUnitOfWork(sql, ACTOR, (uow) => setFlowActive(uow, FLOW_KEY, true))

  const config = loadConfig()
  const sms = createSmsalaTransport({ config, now: () => INSIDE_WINDOW_ISO })
  smsSuccessCount = () =>
    sms.calls.forProvider('smsala').filter((call) => call.outcome === 'success').length
  runtime = await buildRuntime(sms.transport)
}, 180_000)

afterAll(async () => {
  if (sql === undefined) return
  // The enrolments and their runs, by this file's own flow. `flow_definition` and `message` cannot be
  // removed and are not; the flow row is left with its one version, which is why the key carries a
  // per-run discriminator.
  await sql`
    delete from flow_enrolment where flow_id = ${flowId === '' ? null : flowId}::uuid
  `
  await sql.end({ timeout: 5 })
}, 60_000)

/** Enrol one contact and start their run, returning the run id. */
async function enrolAndStart(customerId: string, atIso: string): Promise<string> {
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const enrolment = await enrolOnLiveVersion(uow, {
      flowKey: FLOW_KEY,
      customerId,
      createdBy: 'C-AUTO-11 M3 fixture',
      at: new Date(atIso),
    })
    return startRunAndQueueFirstTick(runtime, uow, {
      enrolmentId: enrolment.enrolmentId,
      flowId,
      definitionVersion: enrolment.pinnedVersion,
      maxNodeExecutions: 60,
      atIso,
    })
  })
}

/**
 * One tick, and the kind it answered.
 *
 * ONE and not a loop, which is a fact about the interpreter worth stating: `runFlowTick` executes nodes
 * until it meets a wait, a pause or an exit, and answers `advanced` for the wait — with the instant the
 * run may resume at. Re-ticking at the SAME instant meets the same wait again, so a drain loop at one
 * instant advances for ever. The QUEUE is what iterates in production (`enqueueTick` with
 * `startAfterSeconds`), and this file is the queue: it ticks once per instant it wants to be at.
 *
 * The first version of this helper looped at one instant and advanced sixty times, which is the failure
 * it is worth having met: a loop whose exit depends on time moving, driven at a frozen clock, has no exit.
 */
async function tick(runId: string, atIso: string): Promise<string> {
  const result = await runFlowTick(runtime, { runId, atIso })
  return result.kind
}

/** Every step this run recorded, oldest first. ROWS, which is the acceptance line's own word. */
async function stepsOf(runId: string): Promise<
  readonly {
    nodeId: string
    outcome: string
    templateKey: string | null
    gateDecision: string | null
    consentRecordId: string | null
    messageId: string | null
  }[]
> {
  return sql`
    select node_id as "nodeId", outcome::text as outcome, template_key as "templateKey",
           gate_decision as "gateDecision", consent_record_id as "consentRecordId",
           message_id::text as "messageId"
      from flow_step_log
     where flow_run_id = ${runId}::uuid
     order by recorded_at, id
  `
}

describe('MILESTONE M3 — event to enrolment to consented send to opt-out to suppression', () => {
  it('runs the whole chain, with every assertion on rows', async () => {
    const customerId = contact(0)
    const before = smsSuccessCount()

    // 1. THE EVENT ENROLS THE CONTACT. Asserted as a row carrying a PINNED version, which is the whole
    //    point of the enrolment table: nothing re-resolves it afterwards.
    const runId = await enrolAndStart(customerId, INSIDE_WINDOW_ISO)
    const [enrolment] = await sql<{ status: string; definitionVersion: number }[]>`
      select status::text as status, definition_version as "definitionVersion"
        from flow_enrolment where flow_id = ${flowId}::uuid and customer_id = ${customerId}::uuid
    `
    expect(enrolment?.status).toBe('active')
    expect(enrolment?.definitionVersion).toBe(pinnedVersion)

    // 2. THE CONSENTED PROMOTIONAL SMS PASSES THE GATE INSIDE THE WINDOW. The tick runs the
    //    transactional node, then the promotional one, then pauses at the delay.
    // `advanced`: the tick ran the transactional node, then the promotional one, and then met the
    // 60-minute wait — which it queues a later tick for rather than sleeping on.
    expect(await tick(runId, INSIDE_WINDOW_ISO)).toBe('advanced')
    const first = await stepsOf(runId)
    const offer = first.find((step) => step.nodeId === 'offer')
    const confirm = first.find((step) => step.nodeId === 'confirm')
    // `executed`, which is `flow_node_outcome`'s word for "the effect happened": the vocabulary is
    // executed / duplicate / held / refused / no_effect, and a message that left is an executed node
    // carrying a message id. The id is what distinguishes it from a node that did something else.
    expect(confirm?.outcome).toBe('executed')
    expect(offer?.outcome).toBe('executed')
    expect(offer?.templateKey).toBe(PROMO_KEY)
    // The consent record the send rested on, as a row. "Which consent did this go out under" is one
    // query, which is the same claim C-AUTO-10's campaign_recipient constraint makes.
    expect(offer?.consentRecordId).not.toBeNull()
    expect(offer?.messageId).not.toBeNull()
    // Two provider calls, measured on the vendor's own log rather than on the rows: a row saying `sent`
    // over a message that never left is exactly what this assertion is for.
    expect(smsSuccessCount() - before).toBe(2)

    // 3. THE CONTACT OPTS OUT THROUGH THE PREFERENCE CENTRE LINK. The real write, over the whole grid,
    //    with the fixture keying — not a hand-inserted suppression row, because the thing being proved
    //    is that the path a customer's link actually opens blocks the next send.
    const optOut = await withUnitOfWork(sql, ACTOR, (uow) =>
      applyPreferenceCentreChange(uow, KEYING(), {
        contactCustomerId: customerId,
        action: 'unsubscribe',
        recipient: normalisePhone(syntheticPerson(BAND_FIRST).phone),
        keyKind: 'phone',
        locale: 'en',
        decidedAtIso: LATER_INSIDE_WINDOW_ISO,
      }),
    )
    // The ROW, not the call's own report. `recordSuppression` is idempotent on
    // (key_kind, key_hmac, kind, recorded_at), so a second run of this file at the same frozen instant
    // answers `recorded: false` about a row that is correctly already there — asserting the report
    // would make this suite pass once and fail for ever after.
    const [suppression] = await sql<{ kind: string; source: string }[]>`
      select kind::text as kind, source::text as source from suppression
       where id = ${optOut.suppressionId}::uuid
    `
    expect(suppression?.kind).toBe('suppressed')
    expect(suppression?.source).toBe('preference_centre')
    // And the withdrawal the same change wrote, which is what actually refuses the next send.
    const [withdrawal] = await sql<{ kind: string }[]>`
      select kind::text as kind from consent
       where contact_customer_id = ${customerId}::uuid and channel = 'sms' and purpose = 'marketing'
       order by recorded_at desc, id desc limit 1
    `
    expect(withdrawal?.kind).toBe('withdrawn')

    // 4. THE NEXT SCHEDULED NODE IS BLOCKED.
    const afterOptOut = smsSuccessCount()
    expect(await tick(runId, LATER_INSIDE_WINDOW_ISO)).toBe('finished')
    const second = await stepsOf(runId)
    const followUp = second.find((step) => step.nodeId === 'follow_up')
    expect(followUp?.outcome).toBe('refused')
    // And the recorded reason is `refused_no_consent`, NOT `refused_suppressed` — which is a finding
    // about the preference centre rather than a defect in either.
    //
    // An opt-out over the whole grid is TWO writes: a consent withdrawal for every send-gating purpose
    // on every channel, and a suppression row against the recipient. `evaluateGate` reads consent
    // before suppression, so the withdrawal is what refuses first and the suppression never gets a
    // chance to. Both facts are asserted — the suppression row above, the refusal here — and the third
    // case below is the one that proves the gate's `refused_suppressed` path with a contact who is
    // suppressed and whose consent still stands. C-AUTO-11's acceptance line names the word
    // 'suppressed'; this is where the two readings of it are written down.
    expect(followUp?.gateDecision).toBe('refused_no_consent')
    // No message row, and no provider call. A refusal that still reached the vendor is the defect.
    expect(followUp?.messageId).toBeNull()
    expect(smsSuccessCount() - afterOptOut).toBe(0)
  }, 180_000)
})

describe("MILESTONE M3 — a suppressed contact whose consent still stands is refused 'suppressed'", () => {
  it('records the blocked attempt with the reason the acceptance line names', async () => {
    const customerId = contact(2)
    const recipient = normalisePhone(syntheticPerson(BAND_FIRST + 2).phone)

    // Suppressed and NOT withdrawn, which is the whole point of this case: the preference centre writes
    // both, so the chain above can only ever show the consent refusal. A suppression on its own is a
    // real state — a vendor-reported STOP, a complaint, a bounce — and it is the state the gate's
    // `isSuppressed` evaluator exists for.
    const suppressed = await withUnitOfWork(sql, ACTOR, (uow) =>
      recordSuppression(uow, KEYING(), {
        keyKind: 'phone',
        recipient,
        // One of the six the schema permits, and the one a reported STOP is: a complaint is a decision
        // the recipient made, which is what `suppression_unsuppression_has_a_decision_behind_it` is about.
        source: 'complaint',
        reason: 'M3: a reported STOP, which withdraws no consent record.',
        actorKind: 'system',
        actorLabel: 'C-AUTO-11 M3 fixture',
        recordedAtIso: INSIDE_WINDOW_ISO,
        contactCustomerId: customerId,
      }),
    )
    expect(suppressed.row.kind).toBe('suppressed')

    // The control: consent is still GRANTED, so a refusal here can only be the suppression.
    const [consent] = await sql<{ kind: string }[]>`
      select kind::text as kind from consent
       where contact_customer_id = ${customerId}::uuid and channel = 'sms' and purpose = 'marketing'
       order by recorded_at desc, id desc limit 1
    `
    expect(consent?.kind).toBe('granted')

    const before = smsSuccessCount()
    const runId = await enrolAndStart(customerId, INSIDE_WINDOW_ISO)
    expect(await tick(runId, INSIDE_WINDOW_ISO)).toBe('advanced')

    const steps = await stepsOf(runId)
    const offer = steps.find((step) => step.nodeId === 'offer')
    const confirm = steps.find((step) => step.nodeId === 'confirm')
    // The transactional node still leaves — a suppression is a marketing decision.
    expect(confirm?.outcome).toBe('executed')
    expect(offer?.outcome).toBe('refused')
    // THE word the acceptance line names, asserted whole and as the word.
    expect(offer?.gateDecision).toBe('refused_suppressed')
    expect(offer?.gateDecision).toContain('suppressed')
    expect(offer?.messageId).toBeNull()
    // One provider call, not two.
    expect(smsSuccessCount() - before).toBe(1)
  }, 180_000)
})

describe('MILESTONE M3 — the same chain with the marketing kill switch engaged', () => {
  it('sends nothing promotional and still delivers the transactional message', async () => {
    const customerId = contact(1)

    // The switch, from its ONE home, with an actor and a reason — `toggleMessagingControl` writes the
    // audit row in the same transaction, which is what makes a stopped sender attributable.
    await withUnitOfWork(sql, ACTOR, (uow) =>
      toggleMessagingControl(uow, {
        controlKey: 'marketing_kill_switch',
        engaged: true,
        role: 'owner',
        actorLabel: 'C-AUTO-11 M3 fixture',
        reason: 'M3 control: proving the switch cannot reach transactional traffic.',
        at: Date.parse(INSIDE_WINDOW_ISO),
      }),
    )

    try {
      const before = smsSuccessCount()
      const runId = await enrolAndStart(customerId, INSIDE_WINDOW_ISO)
      expect(await tick(runId, INSIDE_WINDOW_ISO)).toBe('advanced')

      const steps = await stepsOf(runId)
      const confirm = steps.find((step) => step.nodeId === 'confirm')
      const offer = steps.find((step) => step.nodeId === 'offer')

      // THE transactional message still leaves. This is the assertion C-AUTO-05's acceptance line is
      // about — "structurally cannot touch transactional traffic" — and the one that would break if the
      // switch were ever read above `evaluateGate`'s transactional return.
      expect(confirm?.outcome).toBe('executed')
      expect(confirm?.messageId).not.toBeNull()

      // And nothing promotional does.
      expect(offer?.outcome).toBe('refused')
      expect(offer?.messageId).toBeNull()
      // The gate's own word for it. `marketing_kill_switch` and not `refused_marketing_stopped`:
      // `evaluateGate` names the CONTROL that refused, which is what makes the refusal attributable to
      // the switch somebody engaged rather than to a general stoppage.
      expect(offer?.gateDecision).toBe('marketing_kill_switch')

      // One provider call, not two. Measured on the vendor's log, because that is where "nothing
      // promotional was sent" is a fact rather than a reading of our own rows.
      expect(smsSuccessCount() - before).toBe(1)

      const promotionalMessages = await sql<{ n: string }[]>`
        select count(*)::text as n from flow_step_log
         where flow_run_id = ${runId}::uuid and template_key = ${PROMO_KEY}
           and message_id is not null
      `
      expect(Number(promotionalMessages[0]?.n ?? '-1')).toBe(0)
    } finally {
      // Off again, whatever happened: the switch is shared state and a suite that left it engaged would
      // refuse every promotional send in every later file.
      await withUnitOfWork(sql, ACTOR, (uow) =>
        toggleMessagingControl(uow, {
          controlKey: 'marketing_kill_switch',
          engaged: false,
          role: 'owner',
          actorLabel: 'C-AUTO-11 M3 fixture',
          reason: 'M3 control finished: releasing the switch for every later suite.',
          at: Date.parse(LATER_INSIDE_WINDOW_ISO),
        }),
      )
    }
  }, 180_000)
})
