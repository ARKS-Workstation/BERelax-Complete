import { parseConfig } from '@berelax/config'
import {
  decideFrequencyCap,
  type FrequencyCap,
  type FrequencyCapDecision,
  frequencyCapGateEvaluator,
  frequencyCapsFrom,
  frequencyLedgerHorizonSeconds,
  type Instant,
  instantFromIso,
  instantToIso,
  PROVISIONAL_FREQUENCY_CAPS,
  unionByNaturalKey,
  unreachableOptOutPhrasesIn,
} from '@berelax/core'
import {
  applyMergeParticipant,
  createConnection,
  type FrequencyLedgerAttribution,
  type FrequencySourceKind,
  MERGE_PARTICIPANTS,
  type MergeParticipant,
  mergeCoverage,
  readCountedSendsByContact,
  readFrequencyLedger,
  readSetting,
  recordFrequencyCapRefusal,
  recordSendWithLedger,
  type Sql,
  unconfirmedAssumptionRows,
} from '@berelax/db'
import {
  type ClassifiedTemplate,
  costOf,
  InMemoryOutbox,
  idempotencyKeyFor,
  type MessageId,
  outboundMessageFor,
  PROVISIONAL_SENDER_IDS,
  resolveSenderIdentity,
  type SendContext,
  type SendResult,
  sendMessage,
  TDRA_PROMOTIONAL_WINDOW,
  vendorFor,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ensureMessageTemplate } from './message-lifecycle.ts'
import { assertSynthetic, syntheticPerson } from './synthetic.ts'

/**
 * C-AUTO-03 — the frequency ledger, the global cap, and the merge that must not reset it.
 *
 * ## What is real here and what is stubbed, stated rather than left to be inferred
 *
 * The FREQUENCY evaluator is wired for real, all the way through: the caps are read from `app_setting`,
 * the ledger is read from `frequency_ledger`, the decision is `decideFrequencyCap` in `@berelax/core`, the
 * evaluator is `frequencyCapGateEvaluator`, and the send goes through the real `sendMessage` choke point
 * against the real fake SMSala transport. So a refusal here is `evaluateGate` refusing with
 * `refused_frequency_cap`, not this file deciding not to call anything.
 *
 * `hasConsent` and `isSuppressed` are stubbed to their permissive answers, and that is deliberate: they
 * are C-CRM-03's and C-CRM-04's, proven in `consent.itest.ts` and `suppression.itest.ts` over their own
 * cross products, and a send refused for a second reason would make every assertion here vacuous — the
 * cap would never be reached and every case would pass.
 *
 * ## Why the interpreter is absent and what stands in for it
 *
 * C-AUTO-07 owns the flow interpreter and C-AUTO-10 owns campaigns; neither exists. So
 * {@link attemptPromotionalSend} is the composition those two will make — read caps, read ledger, decide,
 * send, record — written here because `packages/fixtures` is the only package that may import both halves.
 * The two FLOWS are real rows in `flow`, `flow_definition` and `flow_enrolment`, so "one contact enrolled
 * in two flows" is a fact in the database rather than a label in a test; the CAMPAIGN is a `source_kind`
 * and a `source_ref` with no table behind it, which is exactly what 0080 says about `source_ref` having no
 * foreign key, and the absence of a `campaign` table is asserted below so the deferral is visible here and
 * not only in the manifest.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind (brief
 * rule 12). Every read here is narrowed to this file's own contacts and its own per-run `source_ref`s, and
 * nothing is asserted as a total. The contacts are on the unallocated `+971 59` prefix in a band nothing
 * else uses (9601 upward: `merge.itest.ts` holds 9501-9503, the consent loader 9101-9104, the suppression
 * loader 9201-9203, and `crm-pipeline.itest.ts` a band from 4411).
 *
 * Every instant is in 2099 and at 10:00Z, which is 14:00 Asia/Dubai — inside the 07:00-21:00 promotional
 * window, so the gate's queueing branch is never what a case is measuring. `message` rows cannot be
 * deleted (an ON DELETE RESTRICT out of an append-only receipt table), so nothing here cleans up: the
 * per-run ids are what keep a second run from colliding.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`.slice(0, 9)

/** 14:00 Asia/Dubai on 1 May 2099, well inside the promotional window. */
const T0_ISO = '2099-05-01T10:00:00.000Z'
const T0 = instantFromIso(T0_ISO)

/**
 * The one promotional body, so the template row and every message row cannot come to disagree.
 *
 * It carries NO "Reply STOP", and that is a rule rather than a preference. Every SMS this business sends
 * leaves from a TDRA-registered ALPHANUMERIC sender ID, which cannot receive an inbound message, so
 * "Reply STOP to opt out" tells somebody who wants the messages to stop that they have a way to stop them
 * and sends them into a void — `unreachableOptOutPhrasesIn` in `@berelax/core` is the rule and C-CRM-07's
 * `preference-centre.itest.ts` scans the whole corpus for it.
 *
 * The first version of this line said exactly that, and the template row it writes is PERMANENT (a
 * `message` row references it ON DELETE RESTRICT), so this fixture put an offending body into the corpus
 * every one of its runs and broke that scan 34 minutes into a verify, in a file this unit does not touch.
 * The case below asserts the body here rather than leaving it to the corpus scan: a fixture should fail
 * its own suite in six seconds, not somebody else's in half an hour.
 */
const PROMO_BODY = 'A treat for you at BE RELAX this week.'

const CAPS = PROVISIONAL_FREQUENCY_CAPS
const weekCap = CAPS.find((cap) => cap.key === 'week') as FrequencyCap
const monthCap = CAPS.find((cap) => cap.key === 'month') as FrequencyCap

/**
 * A per-RUN band of synthetic numbers, ten slots wide, well above every fixed band in the suite.
 *
 * Per run and not fixed, and this is the defect the first version of this file had. `frequency_ledger`
 * rows CANNOT be deleted — the application role has no DELETE (0080) and a counted row is a send that
 * happened — so a second run of this file against the same database found its fixed contacts already
 * carrying the first run's sends. Four cases failed: the cap was already spent before the first attempt,
 * the day-7 boundary had three sends in its window instead of two, and the merge worked example counted
 * four rows instead of two. Every one of them a true measurement of a contact this file had not set up.
 *
 * Per-run `send_key`s were not enough, because what a cap reads is the CONTACT and not the key. So the
 * contact is per run too. The band starts at 9,000,000 — the fixed bands in this suite are all four
 * digits (`generateSalon`'s 1-140, the CRM suites' 4411 upward, the consent and suppression loaders'
 * 9101-9203, `merge.itest.ts`'s 9501-9503) — and `assertBandIsClear` below refuses one that could reach
 * them.
 */
const BAND_BASE = 9_000_000 + (Number(RUN) % 90_000) * 10

/** One contact per case, so no case can be made to pass or fail by another's ledger. */
const PEOPLE = {
  threeSources: syntheticPerson(BAND_BASE + 1),
  boundary: syntheticPerson(BAND_BASE + 2),
  transaction: syntheticPerson(BAND_BASE + 3),
  mergeSurvivor: syntheticPerson(BAND_BASE + 4),
  mergeLoser: syntheticPerson(BAND_BASE + 5),
  transactional: syntheticPerson(BAND_BASE + 6),
  capRaised: syntheticPerson(BAND_BASE + 7),
  /**
   * A SECOND merge pair, for the shared-send case, and the separate pair is the point.
   *
   * The first version of that case reused the pair above and asserted `rowsMoved === 0`. It measured 1,
   * because that pair already held the previous case's two DISTINCT sends, one of which has no conflict on
   * the survivor and therefore moves. The assertion said "one send recorded against both records is
   * counted once" and was measuring "how many of this contact's rows moved" - different questions the
   * moment the contact has any other history. A fresh pair makes the claim and the measurement the same
   * thing.
   */
  sharedSurvivor: syntheticPerson(BAND_BASE + 8),
  sharedLoser: syntheticPerson(BAND_BASE + 9),
} as const

const SOURCES = {
  flowA: `cauto03_${RUN}_winback`,
  flowB: `cauto03_${RUN}_birthday`,
  campaign: `cauto03_${RUN}_february`,
} as const

let sql: Sql
let templateId: string
let templateKey: string
/**
 * A second template, transactional, because `message_class_matches_its_template` (ZM004, 0061) refuses a
 * transactional message row pointing at a promotional template - and rightly: the class on a message is a
 * copy of the template's taken at send time, and a copy that disagrees with its source makes every count,
 * gate and report read one of the two at random. The first version of the transactional case reused the
 * promotional template and was refused by the database, which is that constraint doing its job.
 */
let transactionalTemplateId: string
let transactionalTemplateKey: string
let contactIds: Record<keyof typeof PEOPLE, string>
let sms: ReturnType<typeof createSmsalaTransport>
let liveCaps: readonly FrequencyCap[]

/** The promotional template every send in this file renders. `AD-` identity, by 0061's biconditional. */
const TEMPLATE = (key: string): ClassifiedTemplate => ({
  key,
  messageClass: 'promotional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: PROMO_BODY,
  variables: [],
})

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  templateKey = `cauto03.${RUN}.promo`
  templateId = await ensureMessageTemplate(sql, {
    key: templateKey,
    channel: 'sms',
    messageClass: 'promotional',
    body: PROMO_BODY,
    subject: null,
  })
  transactionalTemplateKey = `cauto03.${RUN}.tx`
  transactionalTemplateId = await ensureMessageTemplate(sql, {
    key: transactionalTemplateKey,
    channel: 'sms',
    messageClass: 'transactional',
    body: 'Your appointment is confirmed.',
    subject: null,
  })

  const entries = Object.entries(PEOPLE) as [keyof typeof PEOPLE, { phone: string }][]
  for (const [, person] of entries) {
    await sql`
      insert into customer (phone_e164, created_via) values (${person.phone}, 'front_desk')
      on conflict (phone_e164) do nothing
    `
  }
  const ids: Partial<Record<keyof typeof PEOPLE, string>> = {}
  for (const [name, person] of entries) {
    const [row] = await sql<{ id: string }[]>`
      select id from customer where phone_e164 = ${person.phone}
    `
    if (row === undefined) throw new Error(`fixture contact ${name} is missing`)
    ids[name] = row.id
  }
  contactIds = ids as Record<keyof typeof PEOPLE, string>

  // The two flows, and the enrolment rows that make "enrolled in two flows" a fact in the database.
  // Written with SQL rather than through `publishFlowDefinition`, for `merge.itest.ts`'s reason: what is
  // under test is the cap, not the publish path, and that function takes a validator injected from core.
  for (const flowKey of [SOURCES.flowA, SOURCES.flowB]) {
    const [flow] = await sql<{ id: string }[]>`
      insert into flow (flow_key, title, created_by)
      values (${flowKey}, ${`C-AUTO-03 fixture flow ${flowKey}`}, 'frequency-ledger.itest.ts')
      returning id
    `
    const flowId = flow?.id ?? ''
    await sql`
      insert into flow_definition (flow_id, version, dsl_version, definition, published_by)
      values (
        ${flowId}::uuid, 1, 1,
        '{"dslVersion":1,"nodes":[{"id":"n1","kind":"exit","reason":"fixture"}]}'::jsonb,
        'frequency-ledger.itest.ts'
      )
    `
    await sql`
      insert into flow_enrolment (flow_id, definition_version, customer_id, created_by)
      values (${flowId}::uuid, 1, ${contactIds.threeSources}::uuid, 'frequency-ledger.itest.ts')
    `
  }

  const config = parseConfig({ APP_ENV: 'production', DATABASE_URL: url })
  sms = createSmsalaTransport({ config, now: () => T0_ISO })

  // The caps as the DATABASE holds them, not as this file believes them: a case asserting against
  // `PROVISIONAL_FREQUENCY_CAPS` while the send path read something else would pass while disagreeing.
  liveCaps = frequencyCapsFrom({
    week: await readSetting(sql, weekCap.settingKey),
    month: await readSetting(sql, monthCap.settingKey),
  })
})

afterAll(async () => {
  await sql?.end()
})

// ------------------------------------------------------------------------------------------------
// The composition C-AUTO-07 and C-AUTO-10 will make
// ------------------------------------------------------------------------------------------------

interface Attempt {
  readonly contactId: string
  readonly recipient: string
  readonly source: FrequencyLedgerAttribution['sourceKind']
  readonly sourceRef: string
  readonly nowIso: string
  /** Distinguishes one attempt from another for the same contact. Part of `send_key`. */
  readonly attemptId: string
  readonly messageClass?: 'transactional' | 'promotional'
}

interface AttemptResult {
  readonly result: SendResult
  readonly decision: FrequencyCapDecision
  readonly messageId: string | null
  readonly ledgerRowId: string | null
}

/**
 * One promotional send attempt, end to end: read, decide, send through the gate, record.
 *
 * `decideFrequencyCap` is called twice for a refusal — once inside the evaluator the gate consults, once
 * to name the bound cap on the ledger row — and that is safe in a way two IMPLEMENTATIONS would not be:
 * it is a pure function over the same instants, the same `now` and the same caps, so the two calls cannot
 * disagree. What the gate reduces to a boolean is recovered rather than recomputed differently.
 */
async function attemptPromotionalSend(attempt: Attempt): Promise<AttemptResult> {
  const now = instantFromIso(attempt.nowIso)
  const caps = liveCaps
  const horizon = (now - frequencyLedgerHorizonSeconds(caps) * 1000) as Instant
  const countedByContact = await readCountedSendsByContact(sql, {
    contactCustomerIds: [attempt.contactId],
    sinceIso: instantToIso(horizon),
    untilIso: attempt.nowIso,
  })
  const countedAt = (countedByContact.get(attempt.contactId) ?? []) as readonly Instant[]
  const messageClass = attempt.messageClass ?? 'promotional'
  const decision = decideFrequencyCap({ messageClass, now, countedAt, caps, countedSince: horizon })

  const send: SendContext = {
    appEnv: 'production',
    outboundAllowlist: [],
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox: new InMemoryOutbox(),
    clock: { now: () => now },
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators: {
        // C-CRM-03's and C-CRM-04's, stubbed permissive — see the header.
        hasConsent: () => true,
        isSuppressed: () => false,
        frequencyCapReached: frequencyCapGateEvaluator({
          countedAt: new Map([[attempt.recipient, countedAt]]),
          at: now,
          caps,
          countedSince: horizon,
        }),
      },
    },
  }

  // The template and the row it records against BOTH follow the class, because
  // `message_class_matches_its_template` (ZM004) refuses a row whose class disagrees with its template's
  // — and that constraint is right: the class on a message is a copy taken at send time, and a copy that
  // disagrees with its source makes every count, gate and report read one of the two at random.
  const isPromotional = messageClass === 'promotional'
  const usedTemplateKey = isPromotional ? templateKey : transactionalTemplateKey
  const usedTemplateId = isPromotional ? templateId : transactionalTemplateId
  const template: ClassifiedTemplate = isPromotional
    ? TEMPLATE(usedTemplateKey)
    : {
        key: usedTemplateKey,
        messageClass: 'transactional',
        approvalState: 'approved',
        channel: 'sms',
        locale: 'en',
        body: 'Your appointment is confirmed.',
        variables: [],
      }
  const request = {
    id: `cauto03-${RUN}-${attempt.attemptId}` as MessageId,
    template,
    values: {},
    recipient: attempt.recipient,
  }
  const result = await sendMessage(send, request)
  const outbound = outboundMessageFor(request)
  const sendKey = idempotencyKeyFor(outbound)
  const attribution: FrequencyLedgerAttribution = {
    contactCustomerId: attempt.contactId,
    sourceKind: attempt.source,
    sourceRef: attempt.sourceRef,
    sendKey,
  }

  if (result.kind === 'sent') {
    const cost = costOf('sms', outbound.body)
    const identity = resolveSenderIdentity(PROVISIONAL_SENDER_IDS, outbound)
    const recorded = await recordSendWithLedger(sql, {
      message: {
        templateId: usedTemplateId,
        channel: 'sms',
        messageClass,
        locale: 'en',
        vendor: vendorFor('sms'),
        recipient: attempt.recipient,
        senderId: identity.kind === 'identity' ? identity.identity.value : null,
        subject: null,
        body: outbound.body,
        bodyHtml: null,
        encoding: cost.encoding,
        segments: cost.segments,
        costFils: cost.costFils,
      },
      outcome: {
        kind: 'accepted',
        providerMessageId: result.providerMessageId,
        segments: result.segments,
        costFils: result.costFils,
        atIso: attempt.nowIso,
      },
      queuedAtIso: attempt.nowIso,
      attemptedAtIso: attempt.nowIso,
      attribution,
    })
    return {
      result,
      decision,
      messageId: recorded.message.id,
      ledgerRowId: recorded.ledgerRowId,
    }
  }

  if (result.kind === 'blocked' && result.reason === 'refused_frequency_cap') {
    if (decision.kind !== 'capped') {
      throw new Error(
        'the gate refused for the cap and the decision says otherwise, which cannot happen: the ' +
          'evaluator and the record read the same pure function over the same inputs',
      )
    }
    const ledgerRowId = await recordFrequencyCapRefusal(sql, {
      attribution,
      channel: 'sms',
      attemptedAtIso: attempt.nowIso,
      boundCap: {
        key: decision.bound.cap.key,
        limit: decision.bound.cap.limit,
        windowSeconds: decision.bound.cap.windowSeconds,
        countInWindow: decision.bound.countInWindow,
      },
    })
    return { result, decision, messageId: null, ledgerRowId }
  }

  return { result, decision, messageId: null, ledgerRowId: null }
}

/**
 * Seeds a COUNTED send directly, for a history a case needs to start from.
 *
 * `sourceKind` is DERIVED from the ref rather than hard-coded. It was the literal `'campaign'` for every
 * row, including the ones whose ref is one of this file's two flow keys — so a seeded row said a campaign
 * spent the allowance and named a flow. Nothing asserted on it, which is the point: the
 * `frequency_ledger_source_idx` read exists to answer "what did this journey spend", and a fixture that
 * lies to it quietly is a fixture the next case built on that read will be debugged against.
 */
async function seedCountedSend(args: {
  readonly contactId: string
  readonly recipient: string
  readonly atIso: string
  readonly sendKey: string
  readonly sourceRef: string
}): Promise<void> {
  const sourceKind: FrequencySourceKind = args.sourceRef === SOURCES.campaign ? 'campaign' : 'flow'
  // Through the real writer, so the seeded history is a shape the production path can produce: a ledger
  // row asserted against by hand-written SQL could carry a combination the constraints refuse.
  const recorded = await recordSendWithLedger(sql, {
    message: {
      templateId,
      channel: 'sms',
      messageClass: 'promotional',
      locale: 'en',
      vendor: 'smsala',
      // The contact's own number, not one derived from the send key. A derived number is a second
      // recipient builder over one run id, which is the collision `message-lifecycle.ts` records at
      // length: two builders agree until the run id makes them agree, and then a read sees another
      // writer's rows.
      recipient: args.recipient,
      senderId: 'AD-BERELAX',
      subject: null,
      body: PROMO_BODY,
      bodyHtml: null,
      encoding: 'GSM-7',
      segments: 1,
      costFils: 12,
    },
    outcome: {
      kind: 'accepted',
      providerMessageId: `smsala-${RUN}-${args.sendKey}`,
      segments: 1,
      costFils: 12,
      atIso: args.atIso,
    },
    queuedAtIso: args.atIso,
    attemptedAtIso: args.atIso,
    attribution: {
      contactCustomerId: args.contactId,
      sourceKind,
      sourceRef: args.sourceRef,
      sendKey: args.sendKey,
    },
  })
  if (recorded.ledgerRowId === null) throw new Error('the seeded send wrote no ledger row')
}

const ledgerFor = async (contactId: string) => await readFrequencyLedger(sql, contactId)

/**
 * Successful SMS calls the fake vendor has taken so far.
 *
 * The log is built once and shared by every case in this file, so it is only ever read as a DELTA: a
 * total would be a number that changes when a case is added above.
 */
const successfulSmsCalls = (): number =>
  sms.calls.forProvider('smsala').filter((call) => call.outcome === 'success').length

// ------------------------------------------------------------------------------------------------
// Two flows and a campaign in one hour
// ------------------------------------------------------------------------------------------------

describe('the fixture copy and the fixture band', () => {
  it('promises no opt-out that does not exist, in the body this file makes permanent', () => {
    // The template row this file writes cannot be deleted, so its body joins the corpus C-CRM-07 scans
    // for ever. Asserted HERE so a regression fails in six seconds in the file that caused it, rather
    // than in `preference-centre.itest.ts` 34 minutes into a verify — which is what happened.
    expect(unreachableOptOutPhrasesIn(PROMO_BODY)).toEqual([])
    // The control on the predicate, not on the body: a scan that had stopped matching would pass the
    // line above for any copy at all.
    expect(unreachableOptOutPhrasesIn('Offers. Reply STOP to end.')).not.toEqual([])
  })

  it('is undialable, ten slots wide, and clear of every fixed band in the suite', () => {
    // `assertSynthetic` is the guarantee that matters most: every number is on the unallocated +971 59
    // prefix and is none of the business's own, checked at the point of creation rather than intended.
    for (const person of Object.values(PEOPLE)) assertSynthetic(person)
    // Ten distinct slots, so no two cases in this file share a contact.
    const phones = Object.values(PEOPLE).map((person) => person.phone)
    expect(new Set(phones).size).toBe(phones.length)
    // And clear of the four-digit bands the other suites hold. 10,000 rather than the highest of them,
    // because the check has to keep holding when somebody adds a band this file has never heard of.
    expect(BAND_BASE, 'above every four-digit fixture band').toBeGreaterThanOrEqual(10_000)
    expect(BAND_BASE + 9, 'inside the seven digits a UAE mobile serial has').toBeLessThan(
      10_000_000,
    )
  })
})

describe('two flows and one campaign firing in the same hour', () => {
  it('is enrolled in two real flows, and the campaign table is C-AUTO-10 deferred rather than assumed', async () => {
    const [enrolments] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from flow_enrolment e join flow f on f.id = e.flow_id
       where e.customer_id = ${contactIds.threeSources}::uuid
         and f.flow_key in (${SOURCES.flowA}, ${SOURCES.flowB})
    `
    expect(Number(enrolments?.n ?? '0'), 'enrolled in two flows, in the database').toBe(2)
    // The deferral, visible here rather than only in the manifest. When C-AUTO-10 lands its table this
    // case turns red and the `source_ref` comment in 0080 is what a reader of it should follow.
    const [campaign] = await sql<{ n: string }[]>`
      select count(*)::text as n from information_schema.tables
       where table_schema = 'public' and table_name = 'campaign'
    `
    expect(Number(campaign?.n ?? '0'), 'campaigns are C-AUTO-10 (source_ref has no FK)').toBe(0)
  })

  it('spends the whole weekly allowance and then refuses, naming the cap that bound it', async () => {
    // No history: with the cap at 2 the first two attempts send and the third is refused. This half
    // proves the cap binds at the COUNT it declares — a cap that refused the second attempt, or the
    // fourth, would satisfy "one send and two refusals" just as well.
    const attempts = [
      { source: 'flow' as const, sourceRef: SOURCES.flowA, attemptId: 'three-1' },
      { source: 'flow' as const, sourceRef: SOURCES.flowB, attemptId: 'three-2' },
      { source: 'campaign' as const, sourceRef: SOURCES.campaign, attemptId: 'three-3' },
    ]
    const callsBefore = successfulSmsCalls()
    const results = []
    for (const attempt of attempts) {
      results.push(
        await attemptPromotionalSend({
          contactId: contactIds.threeSources,
          recipient: PEOPLE.threeSources.phone,
          nowIso: T0_ISO,
          ...attempt,
        }),
      )
    }

    expect(results.map((r) => r.result.kind)).toEqual(['sent', 'sent', 'blocked'])
    const third = results[2]?.result
    expect(third?.kind === 'blocked' && third.reason).toBe('refused_frequency_cap')

    const ledger = await ledgerFor(contactIds.threeSources)
    expect(ledger.filter((row) => row.outcome === 'sent')).toHaveLength(2)
    const refusals = ledger.filter((row) => row.outcome === 'frequency_capped')
    expect(refusals).toHaveLength(1)
    // The cap that bound it, with the numbers it bound on — which is what makes the refusal answerable.
    expect(refusals[0]).toMatchObject({
      boundCapKey: 'week',
      boundCapLimit: 2,
      boundCapWindowSeconds: weekCap.windowSeconds,
      boundCapCount: 2,
      sourceKind: 'campaign',
      sourceRef: SOURCES.campaign,
      countedAtIso: null,
      messageId: null,
    })
    // The refusal is NOT counted, and this is the assertion the whole `counted_at` design exists for. A
    // second read after the refusal must see two counted sends and not three: a ledger that counted its
    // own refusals would refuse this contact for ever, each refusal extending its own window.
    const counted = await readCountedSendsByContact(sql, {
      contactCustomerIds: [contactIds.threeSources],
      sinceIso: '2099-04-01T00:00:00.000Z',
      untilIso: T0_ISO,
    })
    expect(
      counted.get(contactIds.threeSources),
      'the refusal is not counted: two counted sends, not three',
    ).toHaveLength(2)
    // The provider was really called twice and not three times, so "two sent" is not two rows written by
    // nothing — and the third attempt never reached a transport at all.
    //
    // A DELTA across the three attempts, not a total. The fake's call log is built once in `beforeAll`
    // and shared, so it accumulates across every case in this file: the first version of this line read
    // `toBeGreaterThanOrEqual(2)`, which is true of three calls as well as of two and therefore measured
    // nothing about the sentence above it.
    expect(successfulSmsCalls() - callsBefore, 'two provider calls from three attempts').toBe(2)
  })

  it('produces exactly ONE send from the three when one allowance is already spent', async () => {
    // The acceptance line's literal shape. It needs a contact whose week already holds one counted send,
    // because the provisional cap OPEN-QUESTIONS records is 2 per week (`Y9-frequency-cap`) rather than
    // the 1 the manifest's own `provisional:` field guessed at — see this unit's manifest NOTE. Nothing
    // about the cap is confirmed; what is recorded is which unconfirmed figure the build is using.
    const contactId = contactIds.capRaised
    await seedCountedSend({
      contactId,
      recipient: PEOPLE.capRaised.phone,
      atIso: '2099-04-29T10:00:00.000Z',
      sendKey: `cauto03-${RUN}-prior`,
      sourceRef: SOURCES.campaign,
    })

    const results = []
    for (const attempt of [
      { source: 'flow' as const, sourceRef: SOURCES.flowA, attemptId: 'one-1' },
      { source: 'flow' as const, sourceRef: SOURCES.flowB, attemptId: 'one-2' },
      { source: 'campaign' as const, sourceRef: SOURCES.campaign, attemptId: 'one-3' },
    ]) {
      results.push(
        await attemptPromotionalSend({
          contactId,
          recipient: PEOPLE.capRaised.phone,
          nowIso: T0_ISO,
          ...attempt,
        }),
      )
    }

    expect(results.map((r) => r.result.kind)).toEqual(['sent', 'blocked', 'blocked'])
    const ledger = await ledgerFor(contactId)
    // One prior seeded send, one new send, two refusals.
    expect(ledger.filter((row) => row.outcome === 'sent')).toHaveLength(2)
    const refusals = ledger.filter((row) => row.outcome === 'frequency_capped')
    expect(refusals).toHaveLength(2)
    for (const refusal of refusals) {
      expect(refusal.boundCapKey, 'each refusal names the cap that bound it').toBe('week')
      expect(refusal.boundCapLimit).toBe(2)
      expect(refusal.boundCapCount).toBe(2)
    }
    // The two refused attempts came from DIFFERENT sources, which is the point of a global cap: a
    // per-campaign cap would have let each of the three send once.
    expect(refusals.map((row) => row.sourceRef).sort()).toEqual(
      [SOURCES.campaign, SOURCES.flowB].sort(),
    )
  })
})

// ------------------------------------------------------------------------------------------------
// The rolling window against a frozen clock
// ------------------------------------------------------------------------------------------------

describe('the rolling window, against a frozen clock and to the second', () => {
  it('blocks an attempt at day 6 and permits one at day 7 exactly', async () => {
    const contactId = contactIds.boundary
    // Two sends at day 0, one second apart, because the cap is 2. The second is what makes the day-7
    // assertion about SECONDS: at day 7 exactly the first has aged out and the second has not.
    await seedCountedSend({
      contactId,
      recipient: PEOPLE.boundary.phone,
      atIso: T0_ISO,
      sendKey: `cauto03-${RUN}-boundary-a`,
      sourceRef: SOURCES.flowA,
    })
    await seedCountedSend({
      contactId,
      recipient: PEOPLE.boundary.phone,
      atIso: '2099-05-01T10:00:01.000Z',
      sendKey: `cauto03-${RUN}-boundary-b`,
      sourceRef: SOURCES.flowA,
    })

    const day7Iso = instantToIso((T0 + weekCap.windowSeconds * 1000) as Instant)
    const oneSecondBefore = instantToIso((T0 + weekCap.windowSeconds * 1000 - 1000) as Instant)

    const atDaySix = await attemptPromotionalSend({
      contactId,
      recipient: PEOPLE.boundary.phone,
      source: 'flow',
      sourceRef: SOURCES.flowA,
      nowIso: '2099-05-07T10:00:00.000Z',
      attemptId: 'boundary-day6',
    })
    expect(atDaySix.result.kind, 'day 6: both sends still inside the window').toBe('blocked')

    const justBefore = await attemptPromotionalSend({
      contactId,
      recipient: PEOPLE.boundary.phone,
      source: 'flow',
      sourceRef: SOURCES.flowA,
      nowIso: oneSecondBefore,
      attemptId: 'boundary-before',
    })
    expect(justBefore.result.kind, 'one second before day 7: still two in the window').toBe(
      'blocked',
    )

    const atDaySeven = await attemptPromotionalSend({
      contactId,
      recipient: PEOPLE.boundary.phone,
      source: 'flow',
      sourceRef: SOURCES.flowA,
      nowIso: day7Iso,
      attemptId: 'boundary-day7',
    })
    expect(atDaySeven.result.kind, 'day 7 exactly: the older send has aged out').toBe('sent')
    expect(atDaySeven.decision.kind).toBe('permitted')

    // Asserted to the second and not to the calendar week: 2099-05-01 and 2099-05-08 are in different
    // ISO weeks, so a calendar-week implementation would have permitted the day-6 attempt too — which is
    // the defect this boundary exists to refuse.
    expect(new Date(day7Iso).toISOString()).toBe('2099-05-08T10:00:00.000Z')
    expect(atDaySix.decision.kind === 'capped' && atDaySix.decision.bound.cap.key).toBe('week')
  })

  it('the month cap outlives the week cap, and binds on its own', async () => {
    const contactId = contactIds.boundary
    // Four more sends spread across the month, each outside the week window at the reading instant, so
    // the week cap has headroom and the month cap is the one that refuses. Six counted sends in thirty
    // days: the two above plus these four.
    for (const [index, iso] of [
      '2099-04-14T10:00:00.000Z',
      '2099-04-17T10:00:00.000Z',
      '2099-04-20T10:00:00.000Z',
      '2099-04-23T10:00:00.000Z',
    ].entries()) {
      await seedCountedSend({
        contactId,
        recipient: PEOPLE.boundary.phone,
        atIso: iso,
        sendKey: `cauto03-${RUN}-month-${index}`,
        sourceRef: SOURCES.flowB,
      })
    }

    // 2099-05-11: the day-0 pair and the day-7 send are all more than 7 days old, so the week window
    // holds nothing; the 30-day window still holds all seven.
    const attempt = await attemptPromotionalSend({
      contactId,
      recipient: PEOPLE.boundary.phone,
      source: 'flow',
      sourceRef: SOURCES.flowB,
      nowIso: '2099-05-11T10:00:00.000Z',
      attemptId: 'month-bound',
    })
    expect(attempt.result.kind).toBe('blocked')
    expect(attempt.decision.kind === 'capped' && attempt.decision.bound.cap.key).toBe('month')
    expect(
      attempt.decision.kind === 'capped' && attempt.decision.breaches.map((b) => b.cap.key),
    ).toEqual(['month'])
    const refusal = (await ledgerFor(contactId)).find((row) => row.sendKey.includes('month-bound'))
    expect(refusal?.boundCapKey).toBe('month')
    expect(refusal?.boundCapLimit).toBe(monthCap.limit)
    expect(refusal?.boundCapWindowSeconds).toBe(monthCap.windowSeconds)
  })
})

// ------------------------------------------------------------------------------------------------
// Transactional traffic
// ------------------------------------------------------------------------------------------------

describe('transactional traffic', () => {
  it('sends with the cap fully spent, and writes no ledger row', async () => {
    const contactId = contactIds.transactional
    await seedCountedSend({
      contactId,
      recipient: PEOPLE.transactional.phone,
      atIso: T0_ISO,
      sendKey: `cauto03-${RUN}-tx-a`,
      sourceRef: SOURCES.campaign,
    })
    await seedCountedSend({
      contactId,
      recipient: PEOPLE.transactional.phone,
      // A SECOND before T0, not a second after it. The first version seeded T0 and T0+1s and then read
      // the cap at T0 — where the second send is in the FUTURE and correctly counted by nothing, so the
      // promotional control at the end of this case was permitted and the case failed. The rule was
      // right; the fixture was asserting against a cap state it had not actually created.
      atIso: '2099-05-01T09:59:59.000Z',
      sendKey: `cauto03-${RUN}-tx-b`,
      sourceRef: SOURCES.campaign,
    })
    const before = await ledgerFor(contactId)

    const transactional = await attemptPromotionalSend({
      contactId,
      recipient: PEOPLE.transactional.phone,
      source: 'flow',
      sourceRef: SOURCES.flowA,
      nowIso: T0_ISO,
      attemptId: 'tx-send',
      messageClass: 'transactional',
    })
    expect(transactional.result.kind, 'a transactional send with the cap spent').toBe('sent')
    expect(transactional.ledgerRowId, 'and no ledger row').toBeNull()
    expect(transactional.decision.kind).toBe('not_counted')

    // A DELTA rather than a total (brief rule 9's shape): the ledger only grows.
    const after = await ledgerFor(contactId)
    expect(after.length - before.length).toBe(0)
    // The control beside it: the SAME contact, the same instant, promotional — refused. Without this the
    // case above is satisfied by a cap that was never spent.
    const promotional = await attemptPromotionalSend({
      contactId,
      recipient: PEOPLE.transactional.phone,
      source: 'flow',
      sourceRef: SOURCES.flowA,
      nowIso: T0_ISO,
      attemptId: 'tx-control',
    })
    expect(promotional.result.kind).toBe('blocked')
    expect((await ledgerFor(contactId)).length - after.length).toBe(1)
  })
})

// ------------------------------------------------------------------------------------------------
// One transaction
// ------------------------------------------------------------------------------------------------

describe('the ledger row and the message row are one transaction', () => {
  it('writes neither when the transaction fails after the provider call', async () => {
    const contactId = contactIds.transaction
    const before = await ledgerFor(contactId)
    const [messagesBefore] = await sql<{ n: string }[]>`
      select count(*)::text as n from message where template_id = ${templateId}::uuid
    `

    // The failure injected where it really happens: after the transport answered and before the commit.
    // The transport is MODELLED rather than called — the `accepted` outcome below with its provider message
    // id is exactly what `sendMessage` hands the writer once the vendor has said yes — because what is
    // under test is the two rows, and the case beside this one drives the real fake vendor end to end.
    // `recordSendWithLedger` joins a transaction the caller already has, so a throw here is the shape a
    // killed worker or a lost connection produces: the vendor has sent the SMS and the rows never land.
    const BOOM = 'cauto03 injected failure after the provider call'
    let thrown: unknown
    try {
      await sql.begin(async (tx) => {
        const recorded = await recordSendWithLedger(tx as unknown as Sql, {
          message: {
            templateId,
            channel: 'sms',
            messageClass: 'promotional',
            locale: 'en',
            vendor: 'smsala',
            recipient: PEOPLE.transaction.phone,
            senderId: 'AD-BERELAX',
            subject: null,
            body: PROMO_BODY,
            bodyHtml: null,
            encoding: 'GSM-7',
            segments: 1,
            costFils: 12,
          },
          outcome: {
            kind: 'accepted',
            providerMessageId: `smsala-${RUN}-divergence`,
            segments: 1,
            costFils: 12,
            atIso: T0_ISO,
          },
          queuedAtIso: T0_ISO,
          attemptedAtIso: T0_ISO,
          attribution: {
            contactCustomerId: contactId,
            sourceKind: 'flow',
            sourceRef: SOURCES.flowA,
            sendKey: `cauto03-${RUN}-divergence`,
          },
        })
        // Both rows exist INSIDE the transaction, which is what makes the rollback below meaningful: a
        // case that never wrote them would pass against a function that writes nothing at all.
        expect(recorded.message.id).toBeTruthy()
        expect(recorded.ledgerRowId).toBeTruthy()
        throw new Error(BOOM)
      })
    } catch (error) {
      thrown = error
    }
    expect((thrown as Error | undefined)?.message).toBe(BOOM)

    // Neither row survived. The two agree — both absent — rather than diverging.
    expect(await ledgerFor(contactId)).toHaveLength(before.length)
    const [messagesAfter] = await sql<{ n: string }[]>`
      select count(*)::text as n from message where template_id = ${templateId}::uuid
    `
    expect(Number(messagesAfter?.n ?? '0')).toBe(Number(messagesBefore?.n ?? '0'))
    // And nothing is left holding the provider id, so a retry can use it again.
    const [orphan] = await sql<{ n: string }[]>`
      select count(*)::text as n from message
       where provider_message_id = ${`smsala-${RUN}-divergence`}
    `
    expect(Number(orphan?.n ?? '0')).toBe(0)

    // The control: the same write WITHOUT the throw leaves both rows, and they name each other.
    const committed = await attemptPromotionalSend({
      contactId,
      recipient: PEOPLE.transaction.phone,
      source: 'flow',
      sourceRef: SOURCES.flowA,
      nowIso: T0_ISO,
      attemptId: 'divergence-control',
    })
    expect(committed.result.kind).toBe('sent')
    const entry = (await ledgerFor(contactId)).find((row) => row.id === committed.ledgerRowId)
    expect(entry?.messageId, 'the ledger row names the message row').toBe(committed.messageId)
    expect(entry?.countedAtIso).toBe(T0_ISO)
  })

  it('opens its own transaction when handed the POOL, so a refused ledger row takes the message with it', async () => {
    // The other half of "one transaction", and the half a caller reaches by accident. Given a transaction
    // this joins it; given the POOL it must open one — and if it did not, the message row would land, the
    // ledger insert would be refused, and the two would diverge with the message counted by nothing.
    //
    // The refusal is a blank `send_key`, which `frequency_ledger_send_key_is_stated` rejects. A constraint
    // rather than an injected throw, because what has to be covered is the path where the SECOND statement
    // fails on its own: an injected throw could be placed anywhere, and a caller does not get to choose
    // where Postgres refuses.
    const contactId = contactIds.transaction
    const providerMessageId = `smsala-${RUN}-poolpath`
    const before = await ledgerFor(contactId)
    let refused: unknown
    try {
      await recordSendWithLedger(sql, {
        message: {
          templateId,
          channel: 'sms',
          messageClass: 'promotional',
          locale: 'en',
          vendor: 'smsala',
          recipient: PEOPLE.transaction.phone,
          senderId: 'AD-BERELAX',
          subject: null,
          body: PROMO_BODY,
          bodyHtml: null,
          encoding: 'GSM-7',
          segments: 1,
          costFils: 12,
        },
        outcome: {
          kind: 'accepted',
          providerMessageId,
          segments: 1,
          costFils: 12,
          atIso: T0_ISO,
        },
        queuedAtIso: T0_ISO,
        attemptedAtIso: T0_ISO,
        attribution: {
          contactCustomerId: contactId,
          sourceKind: 'flow',
          sourceRef: SOURCES.flowA,
          sendKey: '   ',
        },
      })
    } catch (error) {
      refused = error
    }
    expect((refused as { constraint_name?: string } | undefined)?.constraint_name).toBe(
      'frequency_ledger_send_key_is_stated',
    )
    // The message row went with it. Without the transaction this is 1, and the message is a promotional
    // send the cap will never see.
    const [orphan] = await sql<{ n: string }[]>`
      select count(*)::text as n from message where provider_message_id = ${providerMessageId}
    `
    expect(Number(orphan?.n ?? '0'), 'no message row survived the refused ledger row').toBe(0)
    expect(await ledgerFor(contactId)).toHaveLength(before.length)
  })

  it('refuses to re-date or un-count a send, with ZW002, and lets the contact be re-pointed', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from frequency_ledger
       where contact_customer_id = ${contactIds.transaction}::uuid and counted_at is not null
       limit 1
    `
    const id = row?.id ?? ''
    expect(id, 'a counted row to try to edit').toBeTruthy()

    const sqlstateOf = async (statement: Promise<unknown>): Promise<string | null> =>
      await statement.then(
        () => null,
        (error: unknown) =>
          typeof (error as { code?: unknown }).code === 'string'
            ? (error as { code: string }).code
            : null,
      )

    expect(
      await sqlstateOf(
        sql`update frequency_ledger set counted_at = counted_at - interval '1 day' where id = ${id}::uuid`,
      ),
    ).toBe('ZW002')
    expect(
      await sqlstateOf(sql`update frequency_ledger set counted_at = null where id = ${id}::uuid`),
    ).toBe('ZW002')
    expect(
      await sqlstateOf(
        sql`update frequency_ledger set send_key = 'rewritten' where id = ${id}::uuid`,
      ),
    ).toBe('ZW002')
    // The control, and it is the half the merge depends on: re-pointing the contact is permitted. A
    // trigger that refused every UPDATE would make `union_dedupe` impossible and every merge refuse.
    expect(
      await sqlstateOf(sql`
        update frequency_ledger set contact_customer_id = ${contactIds.mergeSurvivor}::uuid
         where id = ${id}::uuid
      `),
    ).toBeNull()
    await sql`
      update frequency_ledger set contact_customer_id = ${contactIds.transaction}::uuid
       where id = ${id}::uuid
    `
  })
})

// ------------------------------------------------------------------------------------------------
// The merge
// ------------------------------------------------------------------------------------------------

describe('the merge registry, and the worked example', () => {
  it('registers frequency_ledger as a union_dedupe participant, exactly once', async () => {
    const coverage = await mergeCoverage(sql)
    const rows = coverage.filter((row) => row.table === 'frequency_ledger')
    // The completeness case in merge.itest.ts fails on an unregistered table; this says which way it is
    // registered, which is the decision — an entry switched to an allowlist would satisfy "registered"
    // while letting a merge hand the contact a fresh allowance.
    expect(rows.map((row) => [row.column, row.status, row.strategy])).toEqual([
      ['contact_customer_id', 'participant', 'union_dedupe'],
    ])
    // Exactly one entry in the registry, checked here rather than by eye: a clean auto-merge once left a
    // DUPLICATE entry in `merge-participants.ts`, which is legal TypeScript that would have made every
    // merge refuse. `registry()` in that file now throws at module load; this is the assertion that the
    // participant this unit added is the only one for its table.
    expect(
      MERGE_PARTICIPANTS.filter((p) => p.table === 'frequency_ledger').map((p) => p.registeredBy),
    ).toEqual(['C-AUTO-03'])
    const keys = MERGE_PARTICIPANTS.map((p) => `${p.schema}.${p.table}.${p.column}`)
    expect(new Set(keys).size, 'no participant is registered twice').toBe(keys.length)
  })

  it('yields a survivor count of exactly 2 from one in-window send on each record', async () => {
    const participant = MERGE_PARTICIPANTS.find(
      (p) => p.table === 'frequency_ledger',
    ) as MergeParticipant
    const survivorId = contactIds.mergeSurvivor
    const loserId = contactIds.mergeLoser

    await seedCountedSend({
      contactId: survivorId,
      recipient: PEOPLE.mergeSurvivor.phone,
      atIso: T0_ISO,
      sendKey: `cauto03-${RUN}-merge-survivor`,
      sourceRef: SOURCES.flowA,
    })
    await seedCountedSend({
      contactId: loserId,
      recipient: PEOPLE.mergeLoser.phone,
      atIso: '2099-05-02T10:00:00.000Z',
      sendKey: `cauto03-${RUN}-merge-loser`,
      sourceRef: SOURCES.flowB,
    })

    // Rolled back: `merge_record` makes a second merge of one pair `already_merged`, so a committed merge
    // here would make this file pass once and answer differently for ever after (merge.itest.ts's
    // `probe`, for the same reason).
    const ROLLBACK = 'cauto03 merge rollback'
    let report: Awaited<ReturnType<typeof applyMergeParticipant>> | undefined
    try {
      await sql.begin(async (tx) => {
        report = await applyMergeParticipant(tx as unknown as Sql, participant, {
          survivorCustomerId: survivorId,
          loserCustomerId: loserId,
          mergedAtIso: '2099-05-03T10:00:00.000Z',
        })
        throw new Error(ROLLBACK)
      })
    } catch (error) {
      if ((error as Error).message !== ROLLBACK) throw error
    }

    // TWO. Never 1, which would drop a row and hand the merged contact a fresh allowance; never 4, which
    // would count each set twice and silence them for a fortnight on the strength of one message.
    expect(report?.rowsAfterSurvivor).toBe(2)
    expect(report?.rowsMoved).toBe(1)
    expect(report?.rowsRetainedOnLoser).toBe(0)
    expect(report?.strategy).toBe('union_dedupe')

    // The pure rule the SQL implements, on the same worked example — the two halves asserted together
    // because each alone permits an implementation that is wrong in the other direction.
    const key = (row: { sendKey: string }) => row.sendKey
    expect(
      unionByNaturalKey([{ sendKey: 'a' }], [{ sendKey: 'b' }], key).keptCount,
      'two different sends count twice',
    ).toBe(2)
    expect(
      unionByNaturalKey([{ sendKey: 'a' }], [{ sendKey: 'a' }], key).keptCount,
      'one send recorded against both records counts once',
    ).toBe(1)

    // And the rolled-back merge really was rolled back, so nothing here leaks into a later file.
    const survivorLedger = await ledgerFor(survivorId)
    expect(survivorLedger.filter((row) => row.outcome === 'sent')).toHaveLength(1)
  })

  it('counts one send recorded against BOTH records once, and says why the row stayed', async () => {
    const participant = MERGE_PARTICIPANTS.find(
      (p) => p.table === 'frequency_ledger',
    ) as MergeParticipant
    // Its OWN pair, with no other history — see the note on `sharedSurvivor`. With the pair above, the
    // previous case's two distinct sends are still on the loser, one of them moves, and `rowsMoved` then
    // answers a different question from the one this case asks.
    const survivorId = contactIds.sharedSurvivor
    const loserId = contactIds.sharedLoser
    // The at-least-once case 0080's header names: one physical message, a job replayed against the
    // contact id a merge had already moved, so the SAME send_key is recorded against both records.
    const shared = `cauto03-${RUN}-merge-shared`
    const ROLLBACK = 'cauto03 shared rollback'
    let report: Awaited<ReturnType<typeof applyMergeParticipant>> | undefined
    try {
      await sql.begin(async (tx) => {
        const tsql = tx as unknown as Sql
        for (const contactId of [survivorId, loserId]) {
          await tsql`
            insert into frequency_ledger (
              contact_customer_id, outcome, counted_at, attempted_at, channel,
              message_id, source_kind, source_ref, send_key
            )
            select ${contactId}::uuid, 'sent', ${T0_ISO}::timestamptz, ${T0_ISO}::timestamptz,
                   'sms'::message_channel, m.id, 'flow'::frequency_source_kind, ${SOURCES.flowA},
                   ${shared}
              from message m
             where m.template_id = ${templateId}::uuid
             order by m.created_at
             limit 1
          `
        }
        report = await applyMergeParticipant(tsql, participant, {
          survivorCustomerId: survivorId,
          loserCustomerId: loserId,
          mergedAtIso: '2099-05-03T10:00:00.000Z',
        })
        throw new Error(ROLLBACK)
      })
    } catch (error) {
      if ((error as Error).message !== ROLLBACK) throw error
    }

    // The survivor already held that send_key, so the loser's copy is the same message twice: it stays
    // where it is, counted once, and the report says why.
    expect(report?.rowsBeforeSurvivor, 'one row each, and nothing else').toBe(1)
    expect(report?.rowsBeforeLoser).toBe(1)
    expect(report?.rowsMoved).toBe(0)
    expect(report?.rowsRetainedOnLoser).toBe(1)
    expect(report?.retainedReason).toContain('Counted once')
    // ONE after the merge, not two: the cap reads one message, which is what happened. The contrast with
    // the case above — two distinct sends giving two — is the whole of `union_dedupe`, and either half
    // alone permits an implementation that is wrong in the other direction.
    expect(report?.rowsAfterSurvivor).toBe(1)
  })
})

// ------------------------------------------------------------------------------------------------
// The cap is a provisional setting that cannot be switched off
// ------------------------------------------------------------------------------------------------

describe('the cap values as settings', () => {
  it('appear in the Unconfirmed Assumptions query under Y9-frequency-cap', async () => {
    const listed = await unconfirmedAssumptionRows(sql)
    const caps = listed.filter(
      (row) => row.source === 'app_setting' && row.reference.startsWith('messaging.frequency_cap_'),
    )
    expect(caps.map((row) => row.reference).sort()).toEqual([
      'messaging.frequency_cap_per_month',
      'messaging.frequency_cap_per_week',
    ])
    for (const cap of caps) {
      expect(cap.openQuestionId, 'each names the question that answers it').toBe('Y9-frequency-cap')
      expect(cap.note ?? '', 'and says what was assumed').toMatch(/rolling/)
    }
    // The values the SEND path reads, through the same reader it uses — not a second copy of the two
    // figures, which is how a panel comes to show a cap the gate is not applying.
    expect(await readSetting(sql, weekCap.settingKey)).toBe(2)
    expect(await readSetting(sql, monthCap.settingKey)).toBe(6)
    // The control: the panel does not list a confirmed value. `theme.accent` is seeded and not
    // provisional, so a query returning every row would include it.
    expect(listed.map((row) => row.reference)).not.toContain('theme.accent')
  })

  it('refuses 0, null and "unlimited" in the database, with a readable message', async () => {
    const attempt = async (value: string): Promise<{ code: string | null; message: string }> =>
      await sql
        .unsafe(
          `update app_setting set value = '${value}'::jsonb
            where key = 'messaging.frequency_cap_per_week'`,
        )
        .then(
          () => ({ code: null, message: '' }),
          (error: unknown) => ({
            code: (error as { code?: string }).code ?? null,
            message: (error as { message?: string }).message ?? '',
          }),
        )

    for (const value of ['0', 'null', '"unlimited"', '2.5', '-1']) {
      const refused = await attempt(value)
      expect(refused.code, `${value} is refused`).toBe('ZW001')
      expect(refused.message, 'and says where the off switch really is').toContain(
        'marketing kill switch',
      )
      expect(refused.message).toContain('Y9-frequency-cap')
    }

    // The control, in a transaction that is rolled back so the suite's cap is left as it was: a real
    // value is accepted, or the five refusals above are satisfied by a rule that refuses everything.
    const ROLLBACK = 'cauto03 cap rollback'
    try {
      await sql.begin(async (tx) => {
        await tx`
          update app_setting set value = '3'::jsonb where key = 'messaging.frequency_cap_per_week'
        `
        const [row] = await tx<{ value: number }[]>`
          select value from app_setting where key = 'messaging.frequency_cap_per_week'
        `
        expect(row?.value).toBe(3)
        throw new Error(ROLLBACK)
      })
    } catch (error) {
      if ((error as Error).message !== ROLLBACK) throw error
    }
    const [unchanged] = await sql<{ value: number }[]>`
      select value from app_setting where key = 'messaging.frequency_cap_per_week'
    `
    expect(unchanged?.value, 'the suite leaves the cap as it found it').toBe(2)
  })

  it('refuses the same three with triggers off, because a restore runs that way', async () => {
    const ROLLBACK = 'cauto03 replica rollback'
    let code: string | null = null
    let constraint: string | null = null
    try {
      await sql.begin(async (tx) => {
        await tx`set local session_replication_role = replica`
        try {
          await tx`
            update app_setting set value = '0'::jsonb
             where key = 'messaging.frequency_cap_per_week'
          `
        } catch (error) {
          code = (error as { code?: string }).code ?? null
          constraint = (error as { constraint_name?: string }).constraint_name ?? null
        }
        throw new Error(ROLLBACK)
      })
    } catch (error) {
      if ((error as Error).message !== ROLLBACK) throw error
    }
    // 23514 is a CHECK violation: the trigger is off, and the constraint beside it still refuses.
    expect(code).toBe('23514')
    expect(constraint).toBe('app_setting_frequency_cap_cannot_be_switched_off')
  })
})
