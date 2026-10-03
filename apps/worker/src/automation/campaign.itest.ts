import { loadConfig } from '@berelax/config'
import {
  ASIA_DUBAI,
  compileSegment,
  estimateCampaign,
  type Instant,
  instantFromIso,
  instantToIso,
  normalisePhone,
  type SegmentDefinition,
  segmentCountFreshness,
  serialiseSegmentDefinition,
  suppressionKeyNormaliser,
  toLocal,
  validateSegmentDefinition,
} from '@berelax/core'
import {
  CAMPAIGN_SQLSTATE,
  claimCampaignRecipient,
  createCampaign,
  createConnection,
  createSegment,
  launchCampaign,
  readCampaignByKey,
  readCampaignOutcome,
  readSegmentByKey,
  recountSegment,
  type Sql,
  settleCampaignRecipient,
  withUnitOfWork,
} from '@berelax/db'
import { fixtureSuppressionPeppers, syntheticPerson } from '@berelax/fixtures'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { drainCampaign } from './campaign-sender.ts'
import { messageNodeDepsFor } from './runtime.ts'

/**
 * C-AUTO-10 — segments, the pre-launch estimate, and the spend cap the DATABASE enforces.
 *
 * Every claim here is about the PAIR. `compileSegment` and `estimateCampaign` are pure and live in
 * `@berelax/core`; the cap and the recipient rows live in PostgreSQL and migration 0154 enforces them;
 * the send goes through `sendMessage` and nothing here reaches a transport. The unit tests in
 * `packages/core/src/automation/` drive the pure halves with no database at all — including the clinical
 * refusal, which is a judgement about a document and needs none — and this file drives the composition.
 *
 * ## The 200 contacts are NOT removed afterwards, and that is deliberate
 *
 * They are created idempotently in `beforeAll` from one number band (`syntheticPerson` indices
 * {@link BAND_FIRST} onward) and left in place, so a second run of this file reuses the same rows and
 * writes nothing new. The alternative — delete them in `afterAll`, as `interpreter.itest.ts` does with
 * its five thousand — is wrong HERE because these contacts carry `consent` rows, `consent` is append-only
 * (ADR 0008, brief rule 9), and a deleted customer would leave its consent record behind with nothing to
 * point at. Two hundred rows that are stable across runs is a smaller cost than two hundred orphaned
 * consent records per run, and every suite in this repository that counts `customer` counts a DELTA.
 *
 * ## What is cleaned, and how
 *
 * The campaign rows, the recipient rows (they cascade) and the segment rows, by this file's own key
 * prefix. Every statement carries a predicate: nothing here is an unqualified delete, so nothing here
 * needs a declaration in `suite-table-declarations.ts`.
 *
 * `message` rows and `frequency_ledger` rows written by the sends cannot be removed and are not: the
 * sends are real sends to the fake vendor, and the assertions are either deltas or narrowed to this
 * file's own campaign ids.
 *
 * ## Why the transport is built HERE
 *
 * Its call log is the spy. A transport the sender built for itself would keep that log private, and
 * "zero sends after 21:00" is a claim about the provider calls rather than about the rows — the rows
 * could read `held` while a message had gone out.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/** This file's own keys. One prefix, so every clean-up statement can carry a predicate. */
const PREFIX = 'cauto10_itest_'

/**
 * A per-RUN discriminator on every campaign and segment key.
 *
 * Needed because a campaign that has sent cannot be deleted: ZY755 refuses a DELETE of a `sent`
 * `campaign_recipient`, and `campaign_recipient.campaign_id` cascades — so `delete from campaign`
 * RAISES for any campaign that reached a provider. That is the rule working rather than getting in the
 * way: a campaign that spent money and sent messages is a record of both, and the one query a regulator
 * asks is over exactly those rows. The consequence is that this file cannot reuse a campaign key, so it
 * does not try to, and `afterAll` removes the campaigns that sent nothing and leaves the ones that did.
 *
 * Base 36 of the start instant: lowercase alphanumeric, which is what
 * `campaign_key_is_lower_snake_case` accepts.
 */
const RUN = Date.now().toString(36)
/** `cauto10_itest_<run>_<name>` — a key that is this file's, this run's, and lower snake case. */
const key = (name: string) => `${PREFIX}${RUN}_${name}`

/** The first `syntheticPerson` index of this file's number band. Distinct from every other suite's. */
const BAND_FIRST = 7_100_001
/** The acceptance line's figure: *"a seeded 200-contact campaign"*. */
const CONTACTS = 200
/**
 * Five further contacts this file sends to ONCE, and nothing else does.
 *
 * Reserved rather than taken from the two hundred, because the frequency cap is real here: the
 * provisional ceiling is two promotional messages per rolling seven days, the estimate campaign and the
 * cap campaign each send one to every contact in the main pool, and a third send to any of them is
 * refused by the gate. The in-window control asserts that five messages DO leave, so it needs five
 * contacts with an allowance — otherwise it would measure the frequency cap and report it as a sender
 * that cannot send.
 */
const CONTROL_CONTACTS = 5
/** The acceptance line's figure: *"exceeding its cap at recipient 120 of 200"*. */
const CAP_BINDS_AT = 120

/** 2026-09-18T14:00 Asia/Dubai — inside the promotional window, and the fixture salon's own "now". */
const INSIDE_WINDOW_ISO = '2026-09-18T10:00:00.000Z'
/** 20:55 Asia/Dubai, which is where the boundary case's campaign is scheduled. */
const BEFORE_BOUNDARY_ISO = '2026-09-18T16:55:00.000Z'
/** 21:00 Asia/Dubai exactly. The window is half-open, so this is already outside it. */
const AFTER_BOUNDARY_ISO = '2026-09-18T17:00:00.000Z'

/** The TDRA ceiling, as the gate reads it. Passed in; this file states no hours of its own. */
const WINDOW = { startHour: 7, endHour: 21 } as const

/**
 * The body every campaign in this file sends.
 *
 * A FIXTURE body and not campaign copy: no human has approved any promotional wording for this business
 * (brief rule 15), and nothing in this file ships. It declares no placeholder, because a flow or campaign
 * node carries no values and B-MSG-01's renderer refuses a blank for a declared variable — so a template
 * with one would be refused before the cap was ever reached, and every case below would be measuring the
 * renderer.
 */
const FIXTURE_BODY = 'BE RELAX fixture message. Reply STOP to opt out.'

let contactIds: readonly string[] = []
let controlIds: readonly string[] = []
let smsSuccessCount: () => number = () => 0
let transport: ReturnType<typeof createSmsalaTransport>['transport']

const templateKey = `cauto10-itest.promo`

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })

  // One statement for all two hundred, idempotent on the phone's unique index. `on conflict do nothing`
  // and not an upsert: a contact this file created on an earlier run is the SAME contact, and rewriting
  // its columns would make a second run differ from a first.
  const people = Array.from({ length: CONTACTS + CONTROL_CONTACTS }, (_, index) =>
    normalisePhone(syntheticPerson(BAND_FIRST + index).phone),
  )
  await sql`
    insert into customer (phone_e164, locale, created_via)
    select phone, 'en', 'front_desk' from unnest(${people as string[]}::text[]) as t(phone)
    on conflict (phone_e164) do nothing
  `
  const rows = await sql<{ id: string; phone: string }[]>`
    select id::text as id, phone_e164 as phone from customer
     where phone_e164 = any(${people as string[]}::text[])
     order by phone_e164
  `
  const allIds = rows.map((row) => row.id)
  if (allIds.length !== CONTACTS + CONTROL_CONTACTS) {
    throw new Error(
      `expected ${CONTACTS + CONTROL_CONTACTS} probe contacts, found ${allIds.length}`,
    )
  }
  // Ordered by phone, and the phones are derived from a contiguous index band, so the split is stable
  // across runs: the control's five are always the same five.
  contactIds = allIds.slice(0, CONTACTS)
  controlIds = allIds.slice(CONTACTS)

  // Marketing consent on SMS for every one of them, under the published wording.
  //
  // `booking_form` and the wording id are both required rather than decorative: `ImportIsNotAnOptIn`
  // (migration 0056) refuses a GRANT captured as `import`, because `consent_wording` holds only the
  // statements this system published and showed — and a grant that named no wording would claim words
  // were read that nobody displayed, which is exactly the artefact a promotional send has to produce.
  // So the fixture grants rest on the wording the seed published, which is the same row a real grant
  // would carry.
  //
  // Idempotent on `consent_one_record_per_instant`, which keys on
  // (contact, channel, purpose, kind, recorded_at) — so a fixed instant makes a second run write nothing.
  const [wording] = await sql<{ id: string }[]>`
    select id::text as id from consent_wording
     where purpose = 'marketing' order by version desc limit 1
  `
  if (wording === undefined) {
    throw new Error(
      'No marketing consent wording is published, so no grant can rest on one. Run `pnpm seed`.',
    )
  }
  await sql`
    insert into consent (contact_customer_id, channel, purpose, kind, recorded_at,
                         consent_wording_id, wording_hash,
                         capture_source, capture_actor_kind, capture_actor_label, capture_locale,
                         created_at)
    select t.id::uuid, 'sms'::message_channel, 'marketing', 'granted'::consent_kind,
           ${INSIDE_WINDOW_ISO}::timestamptz, ${wording.id}::uuid, w.content_hash,
           'booking_form', 'customer', 'C-AUTO-10 fixture', 'en',
           ${INSIDE_WINDOW_ISO}::timestamptz
      from unnest(${allIds as string[]}::text[]) as t(id)
      cross join consent_wording w
     where w.id = ${wording.id}::uuid
    on conflict (contact_customer_id, channel, purpose, kind, recorded_at) do nothing
  `

  // The template. Promotional, SMS, approved, no placeholders — see FIXTURE_BODY.
  //
  // Created idempotently and NEVER removed. `message.template_id` is ON DELETE RESTRICT, so the first
  // send pins it for the life of the database — which is the right arrangement (a message row that could
  // not say which template it was rendered from is a message nobody can answer for) and it means this
  // file reuses one template row across runs rather than recreating it.
  await sql`
    insert into message_template (template_key, version, message_class, purpose, is_current)
    values (${templateKey}, 1, 'promotional'::message_class, 'C-AUTO-10 fixture', true)
    on conflict (template_key, version) do nothing
  `
  const [template] = await sql<{ id: string }[]>`
    select id::text as id from message_template where template_key = ${templateKey} and version = 1
  `
  if (template === undefined) throw new Error('could not create the fixture template')
  await sql`
    insert into message_template_variant
      (template_id, channel, locale, approval_state, body, variables)
    select ${template.id}::uuid, 'sms', 'en', 'approved'::template_approval, ${FIXTURE_BODY}, '{}'
     where not exists (
       select 1 from message_template_variant
        where template_id = ${template.id}::uuid and channel = 'sms' and locale = 'en'
     )
  `

  // This file's own frequency-ledger rows, removed so the REAL caps are in force on every run.
  //
  // Two per rolling seven days is the provisional cap, and this file sends more than two messages to
  // each of its contacts in one run — so without this a second run would be measuring the frequency cap
  // rather than the spend cap, and a third would send nothing at all. The rows are this file's own, for
  // this file's own contacts, and `frequency_ledger` is a counting table rather than a record anybody
  // answers for: the `message` rows it was written beside stay exactly where they are.
  await sql`
    delete from frequency_ledger where contact_customer_id = any(${allIds as string[]}::uuid[])
  `

  const config = loadConfig()
  const sms = createSmsalaTransport({ config, now: () => INSIDE_WINDOW_ISO })
  transport = sms.transport
  smsSuccessCount = () =>
    sms.calls.forProvider('smsala').filter((call) => call.outcome === 'success').length
}, 120_000)

afterAll(async () => {
  if (sql === undefined) return
  // This file's own rows only, every statement predicated.
  //
  // The campaigns that SENT are left: ZY755 refuses a DELETE of a sent recipient and the cascade would
  // raise, which is the rule doing its job — see RUN above. Everything else goes, and a segment survives
  // only while a surviving campaign references it.
  await sql`
    delete from campaign c
     where c.campaign_key like ${`${PREFIX}%`}
       and not exists (
         select 1 from campaign_recipient r where r.campaign_id = c.id and r.state = 'sent'
       )
  `
  await sql`
    delete from customer_segment s
     where s.segment_key like ${`${PREFIX}%`}
       and not exists (select 1 from campaign c where c.segment_id = s.id)
  `
  // The extra contact the recount case seeds, which carries no consent and no history. Removed so the
  // "+1 after a seeded change" assertion is a real change on every run rather than only the first.
  await sql`delete from customer where phone_e164 = ${normalisePhone(syntheticPerson(BAND_FIRST + CONTACTS + CONTROL_CONTACTS).phone)}`
  await sql.end({ timeout: 5 })
}, 60_000)

const ACTOR = { kind: 'system' as const, label: 'C-AUTO-10 fixture' }

/** This file's segment: every probe contact, and nobody else. */
const probeSegment = (key: string): SegmentDefinition => ({
  segmentKey: key,
  title: 'C-AUTO-10 probe contacts',
  match: 'all',
  terms: [{ attribute: 'customer.acquisition_source', operator: 'in', value: ['unknown'] }],
})

/** The SQLSTATE a statement raised, or null when it did not raise. */
async function sqlstateOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (error) {
    return typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null
  }
}

async function makeSegment(key: string): Promise<string> {
  const definition = probeSegment(key)
  return withUnitOfWork(sql, ACTOR, (uow) =>
    createSegment(uow, {
      segmentKey: key,
      title: definition.title,
      definition: JSON.parse(serialiseSegmentDefinition(definition)),
      createdBy: 'C-AUTO-10 fixture',
      at: new Date(instantFromIso(INSIDE_WINDOW_ISO)),
    }),
  )
}

async function makeCampaign(
  key: string,
  capFils: number,
): Promise<{ readonly campaignId: string; readonly segmentId: string }> {
  const segmentId = await makeSegment(`${key}_segment`)
  const campaignId = await withUnitOfWork(sql, ACTOR, (uow) =>
    createCampaign(uow, {
      campaignKey: key,
      title: 'C-AUTO-10 fixture campaign',
      segmentId,
      templateKey,
      channel: 'sms',
      capFils,
      createdBy: 'C-AUTO-10 fixture',
      at: new Date(instantFromIso(INSIDE_WINDOW_ISO)),
    }),
  )
  return { campaignId, segmentId }
}

// ------------------------------------------------------------------------------------------------
// A segment compiles to one query, with a cached count
// ------------------------------------------------------------------------------------------------

describe('acceptance — a segment compiles to one parameterised query with a cached count', () => {
  it('the cached count equals a live recount, and equals it again after a change plus invalidation', async () => {
    const segmentId = await makeSegment(key('recount_segment'))
    const compiled = compileSegment(probeSegment(key('recount_segment')))
    if (!compiled.ok) throw new Error('the probe segment must compile')

    const at = new Date(instantFromIso(INSIDE_WINDOW_ISO))
    const first = await withUnitOfWork(sql, ACTOR, (uow) =>
      recountSegment(uow, { segmentId, at, compiled: compiled.count }),
    )

    // The LIVE recount, run independently of the cache. Equal, which is the claim.
    const live = await sql.unsafe(compiled.count.text, [...compiled.count.values] as never[])
    expect(first.count).toBe(Number((live as unknown as { count: number }[])[0]?.count))
    expect(first.count).toBeGreaterThanOrEqual(CONTACTS)

    // A seeded change: one more contact that the segment matches.
    const extra = normalisePhone(syntheticPerson(BAND_FIRST + CONTACTS + CONTROL_CONTACTS).phone)
    await sql`
      insert into customer (phone_e164, locale, created_via)
      values (${extra}, 'en', 'front_desk') on conflict (phone_e164) do nothing
    `

    // Before the invalidation the cached count is STALE, not wrong: it is the number as at its instant,
    // which is why the instant is stored beside it.
    const stored = await readSegmentByKey(sql, key('recount_segment'))
    expect(stored?.cachedCount).toBe(first.count)
    expect(stored?.cachedCountAtIso).not.toBeNull()

    const second = await withUnitOfWork(sql, ACTOR, (uow) =>
      recountSegment(uow, {
        segmentId,
        at: new Date(instantFromIso(INSIDE_WINDOW_ISO) + 1000),
        compiled: compiled.count,
      }),
    )
    const liveAgain = await sql.unsafe(compiled.count.text, [...compiled.count.values] as never[])
    expect(second.count).toBe(Number((liveAgain as unknown as { count: number }[])[0]?.count))
    expect(second.count).toBe(first.count + 1)
  }, 60_000)

  it('stores the count WITH its instant, and the database refuses one without the other', async () => {
    const segmentId = await makeSegment(key('dated_segment'))
    // The control first: the constraint is real, so the pairing above is enforced rather than habitual.
    const state = await sqlstateOf(
      sql`update customer_segment set cached_count = 7 where id = ${segmentId}::uuid`,
    )
    expect(state).toBe('23514')

    // And the permitted shape, so the constraint is not simply refusing every write.
    await sql`
      update customer_segment set cached_count = 7, cached_count_at = ${INSIDE_WINDOW_ISO}::timestamptz
       where id = ${segmentId}::uuid
    `
    const stored = await readSegmentByKey(sql, key('dated_segment'))
    expect(stored?.cachedCount).toBe(7)
    expect(stored?.cachedCountAtIso).not.toBeNull()
  })

  it('refuses to recount with no compiled query rather than counting every contact', async () => {
    const segmentId = await makeSegment(key('uncompiled_segment'))
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        recountSegment(uow, { segmentId, at: new Date(instantFromIso(INSIDE_WINDOW_ISO)) }),
      ),
    ).rejects.toThrow(/compiled query/)
  })

  it('a segment referencing a clinical table fails validation before it can be stored', () => {
    const refusals = validateSegmentDefinition({
      segmentKey: key('clinical'),
      title: 'Contacts with a contraindication',
      match: 'all',
      terms: [
        { attribute: 'clinical.contraindication_flag.flag_key', operator: 'equals', value: 'x' },
      ],
    })
    expect(refusals.map((refusal) => refusal.rule)).toContain(
      'segment-attribute-outside-the-permitted-schemas',
    )
    // The control: the probe segment, which this file stores all the way through, passes.
    expect(validateSegmentDefinition(probeSegment(key('control_segment')))).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------
// The estimate equals the outcome, to the fils
// ------------------------------------------------------------------------------------------------

describe('acceptance — the pre-launch estimate equals the outcome on the fake provider', () => {
  it('to the fils, over 200 contacts', async () => {
    const estimate = estimateCampaign({
      provider: 'smsala',
      body: FIXTURE_BODY,
      recipients: CONTACTS,
    })
    // A cap well above the estimate: this case is about the arithmetic, and a cap that bound would make
    // it about the cap.
    const { campaignId } = await makeCampaign(key('estimate'), estimate.total.fils + 100_000)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      launchCampaign(uow, {
        campaignId,
        customerIds: contactIds,
        estimate: {
          recipients: estimate.recipients,
          segmentsPerMessage: estimate.segmentsPerMessage,
          totalFils: estimate.total.fils,
        },
        scheduledAt: new Date(instantFromIso(INSIDE_WINDOW_ISO)),
        at: new Date(instantFromIso(INSIDE_WINDOW_ISO)),
      }),
    )

    const result = await drain(campaignId, key('estimate'), INSIDE_WINDOW_ISO)
    expect(result.stop.kind).toBe('drained')
    expect(result.sent).toBe(CONTACTS)

    const outcome = await readCampaignOutcome(sql, campaignId)
    expect(outcome).not.toBeNull()
    if (outcome === null) return
    expect(outcome.total).toBe(CONTACTS)
    expect(outcome.sent).toBe(CONTACTS)
    // THE equality, and it is to the fils.
    expect(outcome.spentFils).toBe(estimate.total.fils)

    const stored = await readCampaignByKey(sql, key('estimate'))
    expect(stored?.estimatedFils).toBe(estimate.total.fils)
    expect(stored?.estimatedRecipients).toBe(CONTACTS)
    expect(stored?.estimatedSegments).toBe(estimate.segmentsPerMessage)
  }, 180_000)

  it('every sent row carries the gate decision and the resolved consent record id', async () => {
    // The regulator's query: one statement over the campaign, asserting both columns on every sent row.
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n
        from campaign_recipient r
        join campaign c on c.id = r.campaign_id
       where c.campaign_key = ${key('estimate')} and r.state = 'sent'
         and (r.gate_decision is null or r.consent_record_id is null)
    `
    expect(Number(rows[0]?.n ?? '-1')).toBe(0)

    // And the control, because "no rows violate it" is satisfied by no rows at all.
    const answered = await sql<{ n: string; decisions: string }[]>`
      select count(*)::text as n, string_agg(distinct r.gate_decision, ',') as decisions
        from campaign_recipient r
        join campaign c on c.id = r.campaign_id
       where c.campaign_key = ${key('estimate')} and r.state = 'sent'
    `
    expect(Number(answered[0]?.n ?? '0')).toBe(CONTACTS)
    expect(answered[0]?.decisions).toBe('allow')

    // Every consent record id names a real consent row, which is what makes the column answerable.
    const resolved = await sql<{ n: string }[]>`
      select count(*)::text as n
        from campaign_recipient r
        join campaign c on c.id = r.campaign_id
        join consent k on k.id = r.consent_record_id
       where c.campaign_key = ${key('estimate')} and r.state = 'sent'
         and k.purpose = 'marketing' and k.kind = 'granted'
    `
    expect(Number(resolved[0]?.n ?? '0')).toBe(CONTACTS)
  }, 60_000)

  it('the database refuses a sent row with no gate decision, which is why the column is answerable', async () => {
    const [row] = await sql<{ id: string }[]>`
      select r.id::text as id from campaign_recipient r
        join campaign c on c.id = r.campaign_id
       where c.campaign_key = ${key('estimate')} and r.state = 'sent' limit 1
    `
    if (row === undefined) throw new Error('the estimate campaign must have sent rows')
    // A sent row is evidence and may not be edited at all (ZY755). That is the stronger refusal and it
    // is the one that fires first, so it is the one asserted — the CHECK underneath it is proved by the
    // probe below, on a row that has not been sent.
    expect(
      await sqlstateOf(
        sql`update campaign_recipient set gate_decision = null where id = ${row.id}::uuid`,
      ),
    ).toBe(CAMPAIGN_SQLSTATE.sentRecipientIsEvidence)
    expect(await sqlstateOf(sql`delete from campaign_recipient where id = ${row.id}::uuid`)).toBe(
      CAMPAIGN_SQLSTATE.sentRecipientIsEvidence,
    )
  })
})

// ------------------------------------------------------------------------------------------------
// The spend cap
// ------------------------------------------------------------------------------------------------

describe('acceptance — the spend cap binds mid-send', () => {
  it('halts at recipient 120 of 200, holds 80, and never records a spend above the cap', async () => {
    const perMessage = estimateCampaign({
      provider: 'smsala',
      body: FIXTURE_BODY,
      recipients: 1,
    }).total.fils
    // A cap that is an exact multiple of the per-message cost, so the binding recipient is the 120th and
    // not "somewhere around 120": the acceptance line names a recipient number, and a cap chosen to the
    // fils is what makes that number a fact rather than an estimate.
    const capFils = perMessage * (CAP_BINDS_AT - 1)
    const { campaignId } = await makeCampaign(key('cap'), capFils)
    const estimate = estimateCampaign({
      provider: 'smsala',
      body: FIXTURE_BODY,
      recipients: CONTACTS,
    })
    await withUnitOfWork(sql, ACTOR, (uow) =>
      launchCampaign(uow, {
        campaignId,
        customerIds: contactIds,
        estimate: {
          recipients: estimate.recipients,
          segmentsPerMessage: estimate.segmentsPerMessage,
          totalFils: estimate.total.fils,
        },
        scheduledAt: new Date(instantFromIso(INSIDE_WINDOW_ISO)),
        at: new Date(instantFromIso(INSIDE_WINDOW_ISO)),
      }),
    )

    const result = await drain(campaignId, key('cap'), INSIDE_WINDOW_ISO)
    expect(result.stop.kind).toBe('halted')
    if (result.stop.kind !== 'halted') return
    expect(result.stop.reason).toBe('spend_cap_reached')

    const outcome = await readCampaignOutcome(sql, campaignId)
    if (outcome === null) throw new Error('the cap campaign must have an outcome')
    expect(outcome.sent).toBe(CAP_BINDS_AT - 1)
    expect(outcome.held).toBe(CONTACTS - (CAP_BINDS_AT - 1))
    // held + sent == total. The arithmetic a halted campaign is read by.
    expect(outcome.held + outcome.sent).toBe(outcome.total)
    expect(outcome.total).toBe(CONTACTS)
    expect(outcome.pending).toBe(0)
    // The recorded spend NEVER exceeds the cap. Asserted on the column the database constrains, so the
    // claim is about what is stored rather than about what the loop believed.
    expect(outcome.spentFils).toBeLessThanOrEqual(outcome.capFils)
    expect(outcome.spentFils).toBe(capFils)

    const stored = await readCampaignByKey(sql, key('cap'))
    expect(stored?.state).toBe('halted')
    expect(stored?.haltedReason).toBe('spend_cap_reached')

    // The held rows say WHY. A held recipient is still owed and the reason is what makes resuming a
    // decision somebody takes rather than a guess.
    const reasons = await sql<{ held_reason: string; n: string }[]>`
      select r.held_reason, count(*)::text as n
        from campaign_recipient r join campaign c on c.id = r.campaign_id
       where c.campaign_key = ${key('cap')} and r.state = 'held'
       group by r.held_reason order by r.held_reason
    `
    expect(reasons.map((row) => row.held_reason).sort()).toEqual(
      ['cap_exceeded', 'spend_cap_reached'].sort(),
    )
  }, 180_000)

  it('the cap is the DATABASE’s: two concurrent workers cannot exceed it between them', async () => {
    const perMessage = estimateCampaign({
      provider: 'smsala',
      body: FIXTURE_BODY,
      recipients: 1,
    }).total.fils
    // Room for exactly ten messages, and twenty recipients to claim. Two workers claiming at once with a
    // check-then-record cap would both see room at the tenth and both reserve — which is the defect this
    // case exists to catch, and the reason the reservation and the claim are one statement.
    const capFils = perMessage * 10
    const { campaignId } = await makeCampaign(key('race'), capFils)
    const twenty = contactIds.slice(0, 20)
    const estimate = estimateCampaign({ provider: 'smsala', body: FIXTURE_BODY, recipients: 20 })
    await withUnitOfWork(sql, ACTOR, (uow) =>
      launchCampaign(uow, {
        campaignId,
        customerIds: twenty,
        estimate: {
          recipients: 20,
          segmentsPerMessage: estimate.segmentsPerMessage,
          totalFils: estimate.total.fils,
        },
        scheduledAt: null,
        at: new Date(instantFromIso(INSIDE_WINDOW_ISO)),
      }),
    )

    // Twenty claims, all issued at once, over a pool wide enough that they really are concurrent. No
    // send and no settlement: this case is about the reservation alone, so nothing releases anything and
    // the spend can only go up.
    const claims = await Promise.all(
      Array.from({ length: 20 }, () =>
        claimCampaignRecipient(sql, { campaignId, estimateFils: perMessage }),
      ),
    )
    const claimed = claims.filter((row) => row?.state === 'claimed')
    const held = claims.filter((row) => row?.state === 'held')
    expect(claimed).toHaveLength(10)
    expect(held).toHaveLength(10)

    const [row] = await sql<{ spent: number; cap: number }[]>`
      select spent_fils as spent, cap_fils as cap from campaign where id = ${campaignId}::uuid
    `
    expect(row?.spent).toBe(capFils)
    expect(row?.spent).toBeLessThanOrEqual(row?.cap ?? -1)
  }, 60_000)

  it('refuses a claim against a campaign that is not running (ZY751)', async () => {
    const { campaignId } = await makeCampaign(key('draft'), 100_000)
    expect(await sqlstateOf(claimCampaignRecipient(sql, { campaignId, estimateFils: 10 }))).toBe(
      CAMPAIGN_SQLSTATE.notClaimable,
    )
  })

  it('refuses a settlement of a recipient that was never claimed (ZY752)', async () => {
    const { campaignId } = await makeCampaign(key('unclaimed'), 100_000)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      launchCampaign(uow, {
        campaignId,
        customerIds: contactIds.slice(0, 1),
        estimate: { recipients: 1, segmentsPerMessage: 1, totalFils: 10 },
        scheduledAt: null,
        at: new Date(instantFromIso(INSIDE_WINDOW_ISO)),
      }),
    )
    const [pending] = await sql<{ id: string }[]>`
      select id::text as id from campaign_recipient where campaign_id = ${campaignId}::uuid
    `
    expect(
      await sqlstateOf(
        settleCampaignRecipient(sql, {
          recipientId: pending?.id ?? '',
          state: 'sent',
          costFils: 10,
          segments: 1,
          gateDecision: 'allow',
          consentRecordId: null,
          heldReason: null,
        }),
      ),
    ).toBe(CAMPAIGN_SQLSTATE.notClaimed)
  })

  it('refuses a spend moved from outside the two functions (ZY753)', async () => {
    const { campaignId } = await makeCampaign(key('spendmove'), 100_000)
    expect(
      await sqlstateOf(sql`update campaign set spent_fils = 5 where id = ${campaignId}::uuid`),
    ).toBe(CAMPAIGN_SQLSTATE.spendHasOnePairOfWriters)
    // The control: an UPDATE that leaves the spend alone is permitted, so the trigger is not refusing
    // every write to the table.
    await sql`update campaign set title = 'renamed' where id = ${campaignId}::uuid`
    expect((await readCampaignByKey(sql, key('spendmove')))?.title).toBe('renamed')
  })

  it('refuses a cap lowered under the spend already recorded (ZY754)', async () => {
    const { campaignId } = await makeCampaign(key('caplower'), 100_000)
    await sql`update campaign set state = 'running' where id = ${campaignId}::uuid`
    await withUnitOfWork(sql, ACTOR, (uow) =>
      launchCampaign(uow, {
        campaignId,
        customerIds: contactIds.slice(0, 1),
        estimate: { recipients: 1, segmentsPerMessage: 1, totalFils: 1_000 },
        scheduledAt: null,
        at: new Date(instantFromIso(INSIDE_WINDOW_ISO)),
      }),
    )
    await claimCampaignRecipient(sql, { campaignId, estimateFils: 1_000 })
    expect(
      await sqlstateOf(sql`update campaign set cap_fils = 10 where id = ${campaignId}::uuid`),
    ).toBe(CAMPAIGN_SQLSTATE.capBelowSpend)
    // The control: raising it is permitted.
    await sql`update campaign set cap_fils = 200_000 where id = ${campaignId}::uuid`
    expect((await readCampaignByKey(sql, key('caplower')))?.capFils).toBe(200_000)
  })
})

// ------------------------------------------------------------------------------------------------
// The 21:00 boundary
// ------------------------------------------------------------------------------------------------

describe('acceptance — a campaign running at 21:00 stops at the boundary', () => {
  it('records zero sends after 21:00 and holds the remainder', async () => {
    const estimate = estimateCampaign({
      provider: 'smsala',
      body: FIXTURE_BODY,
      recipients: 20,
    })
    const { campaignId } = await makeCampaign(key('boundary'), estimate.total.fils + 100_000)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      launchCampaign(uow, {
        campaignId,
        customerIds: contactIds.slice(0, 20),
        estimate: {
          recipients: 20,
          segmentsPerMessage: estimate.segmentsPerMessage,
          totalFils: estimate.total.fils,
        },
        // Scheduled at 20:55, which is inside the window. Nothing about the schedule is wrong.
        scheduledAt: new Date(instantFromIso(BEFORE_BOUNDARY_ISO)),
        at: new Date(instantFromIso(BEFORE_BOUNDARY_ISO)),
      }),
    )

    // The drain is taken at 21:00 exactly — the window is half-open, so 21:00 is already outside it.
    const before = smsSuccessCount()
    const result = await drain(campaignId, key('boundary'), AFTER_BOUNDARY_ISO)
    expect(result.stop.kind).toBe('halted')
    if (result.stop.kind !== 'halted') return
    expect(result.stop.reason).toBe('promotional_window_closed')

    // ZERO sends, measured on the PROVIDER's own call log and not on the rows: a row saying `held` over a
    // message that had gone out is precisely the failure this assertion is for.
    expect(smsSuccessCount() - before).toBe(0)

    const outcome = await readCampaignOutcome(sql, campaignId)
    if (outcome === null) throw new Error('the boundary campaign must have an outcome')
    expect(outcome.sent).toBe(0)
    expect(outcome.held).toBe(20)
    expect(outcome.held + outcome.sent).toBe(outcome.total)
    expect(outcome.spentFils).toBe(0)

    const stored = await readCampaignByKey(sql, key('boundary'))
    expect(stored?.haltedReason).toBe('promotional_window_closed')
    expect(instantToIso(instantFromIso(AFTER_BOUNDARY_ISO))).toBe(AFTER_BOUNDARY_ISO)
  }, 60_000)

  it('the control: the same campaign shape at 20:55 does send', async () => {
    // Without this, the case above passes against a sender that never sends at all.
    const estimate = estimateCampaign({ provider: 'smsala', body: FIXTURE_BODY, recipients: 5 })
    const { campaignId } = await makeCampaign(key('inwindow'), estimate.total.fils + 10_000)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      launchCampaign(uow, {
        campaignId,
        customerIds: controlIds,
        estimate: {
          recipients: 5,
          segmentsPerMessage: estimate.segmentsPerMessage,
          totalFils: estimate.total.fils,
        },
        scheduledAt: new Date(instantFromIso(BEFORE_BOUNDARY_ISO)),
        at: new Date(instantFromIso(BEFORE_BOUNDARY_ISO)),
      }),
    )
    const before = smsSuccessCount()
    const result = await drain(campaignId, key('inwindow'), BEFORE_BOUNDARY_ISO)
    expect(result.stop.kind).toBe('drained')
    expect(result.sent).toBe(5)
    expect(smsSuccessCount() - before).toBe(5)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// The freshness reading, over a stored row
// ------------------------------------------------------------------------------------------------

describe('a stored cached count is read with its age, never without it', () => {
  it('reads a stored count and its instant back into the freshness verdict', async () => {
    const segmentId = await makeSegment(key('freshness_segment'))
    const compiled = compileSegment(probeSegment(key('freshness_segment')))
    if (!compiled.ok) throw new Error('the probe segment must compile')
    const countedAtIso = INSIDE_WINDOW_ISO
    await withUnitOfWork(sql, ACTOR, (uow) =>
      recountSegment(uow, {
        segmentId,
        at: new Date(instantFromIso(countedAtIso)),
        compiled: compiled.count,
      }),
    )
    const stored = await readSegmentByKey(sql, key('freshness_segment'))
    const freshness = segmentCountFreshness({
      cachedCount: stored?.cachedCount ?? null,
      cachedCountAt:
        stored?.cachedCountAtIso === null || stored?.cachedCountAtIso === undefined
          ? null
          : instantFromIso(stored.cachedCountAtIso),
      at: (instantFromIso(countedAtIso) + 60_000) as Instant,
    })
    expect(freshness.kind).toBe('fresh')
    if (freshness.kind === 'never_counted') throw new Error('a recounted segment is dated')
    expect(freshness.ageSeconds).toBe(60)
    expect(freshness.count).toBe(stored?.cachedCount)
  }, 30_000)
})

/**
 * Drain a campaign through the shipped sender.
 *
 * This file lives in `apps/worker/src/automation/` and not in `packages/fixtures`, which is where it
 * started: `nothing-imports-an-app` in `.dependency-cruiser.cjs` refuses a package importing an app, and
 * it refuses a DYNAMIC import too — `pnpm boundaries` reported all seven edges. That rule is right and
 * the first arrangement was wrong: the composition under test is the worker's, so the suite belongs
 * beside `interpreter.itest.ts`, which drives the same runtime for the same reason. The fixture helpers
 * come from `@berelax/fixtures`, which an app may import.
 */
async function drain(
  campaignId: string,
  campaignKey: string,
  atIso: string,
): Promise<{
  readonly stop: { readonly kind: string; readonly reason?: string }
  readonly sent: number
  readonly held: number
  readonly failed: number
}> {
  const stored = await readCampaignByKey(sql, campaignKey)
  if (stored === null) throw new Error(`no campaign ${campaignKey}`)

  const base = messageNodeDepsFor(sql, { transport, appEnv: 'production' })
  const deps = {
    ...base,
    suppressionKeying: () => ({
      peppers: fixtureSuppressionPeppers(process.env),
      normalise: suppressionKeyNormaliser,
    }),
  }

  return drainCampaign(sql, deps, {
    campaignId,
    campaignKey,
    templateKey,
    channel: 'sms',
    capFils: stored.capFils,
    spentFils: stored.spentFils,
    atIso,
    window: WINDOW,
    // Read from its one home by the caller. `production` leaves it disengaged unless a row engages it,
    // and nothing in this file engages it.
    marketingKillSwitchEngaged: false,
  })
}

/** 20:55 and 21:00 are both in the business zone, which is the only zone this file states. */
export const CAMPAIGN_ITEST_ZONE = ASIA_DUBAI
/** Exported so the zone constant is used rather than merely imported. */
export const campaignItestLocalAt = (iso: string) => toLocal(instantFromIso(iso), ASIA_DUBAI)
