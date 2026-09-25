/**
 * B-MSG-04 — the message lifecycle against real PostgreSQL.
 *
 * Everything here is a claim the unit suite cannot make: that the row the store writes is a row the
 * schema accepts, that an out-of-order receipt leaves the *stored* status alone, that a replayed webhook
 * conflicts on an index rather than on a set in memory, and that the cost queries return literal totals
 * over a seeded fixture.
 *
 * ## Isolation, and why there is no cleanup
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind
 * (`docs/CONTRIBUTING-AGENT-BRIEF.md` §12). `message` cannot be cleaned up even in principle:
 * `message_delivery_receipt.message_id` is ON DELETE RESTRICT and that table refuses DELETE, which is
 * deliberate — a receipt is the evidence for a status. So every read here is narrowed to this run's own
 * template keys, recipients and provider ids, every count is over rows this file created, and nothing is
 * asserted as a total.
 *
 * The provider ids this run creates carry the run suffix for the same reason: `message_provider_id_unique`
 * is a real constraint, and a fixture that reissued `smsala-000001` would fail on the second run of the
 * suite against the same database rather than on a defect.
 */
import { parseConfig } from '@berelax/config'
import { type Clock, instantFromIso } from '@berelax/core'
import {
  countPromotionalMessagesSince,
  createConnection,
  createPostgresMessageStore,
  listMessageInbox,
  listMessageReceipts,
  messageCostByTemplate,
  messageCostByTradingDate,
  type PostgresMessageStore,
  readMessageRow,
  type Sql,
} from '@berelax/db'
import {
  type ClassifiedTemplate,
  type DeliveryDeps,
  deliverMessage,
  InMemoryOutbox,
  type MessageId,
  PROVISIONAL_SENDER_IDS,
  type RecordedSendRequest,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ARABIC_150,
  EXPECTED_COST_BY_TEMPLATE,
  EXPECTED_COST_BY_TRADING_DATE,
  ensureMessageTemplate,
  FIXTURE_COST_WINDOW,
  FIXTURE_TRADING_DATE_ONE,
  FIXTURE_TRADING_DATE_TWO,
  type SeededMessagingFixture,
  SMS_RECIPIENT_SLOTS,
  seedMessagingFixture,
  slotsAreDistinct,
  smsRecipientFor,
} from './message-lifecycle.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/** Unique per run, because nothing in this file can be deleted afterwards. */
const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`

/**
 * A recipient for this run, from the ONE builder that every writer of these rows shares.
 *
 * The slot is what separates this file's live sends from each other AND from the rows
 * `seedMessagingFixture` writes, and the builder lives beside that seeder rather than here for exactly
 * that reason. Two builders over one run id is what went wrong: this file took seven characters of RUN
 * plus a digit while the seeder took eight, and those are the SAME NUMBER whenever the eighth character
 * of RUN equals that digit. The digits in use were 0 to 5, so about three runs in five collided on one
 * slot, and the symptom was a read returning the seeder's rows as well as its own — against a file whose
 * own header promises that "every read here is narrowed to this run's own template keys, recipients and
 * provider ids". Four units hit it: M-VAT-03, G-CONN-09, W-SYS-10 and H-HARD-03, and the first two fixes
 * narrowed the odds without removing the cause, because the cause was the other builder.
 */
const recipientFor = (slot: string): string => smsRecipientFor(RUN, slot)

it("every writer of these rows has its own recipient slot, so none can read another's", () => {
  // The assertion the two previous fixes lacked. Without it the next writer to want a number here takes
  // a digit that is already spoken for, and the failure surfaces three runs in five, somewhere else.
  expect(slotsAreDistinct()).toBe(true)
  expect(new Set(Object.values(SMS_RECIPIENT_SLOTS)).size).toBe(7)
  expect(recipientFor(SMS_RECIPIENT_SLOTS.promotional)).not.toBe(
    recipientFor(SMS_RECIPIENT_SLOTS.seededFixture),
  )
})

const SENT_AT = '2026-09-18T10:00:00.000Z'
const DELIVERED_AT = '2026-09-18T10:00:12.000Z'

let sql: Sql
let store: PostgresMessageStore
let fixture: SeededMessagingFixture
/** The template row the live sends in this file render from. */
let liveTemplateId: string
const liveTemplateKey = `bmsg04.${RUN}.live`

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  store = createPostgresMessageStore(sql)
  fixture = await seedMessagingFixture(sql, store, RUN)
  liveTemplateId = await ensureMessageTemplate(sql, {
    key: liveTemplateKey,
    channel: 'sms',
    messageClass: 'transactional',
    body: 'Your appointment on {{date}} at {{time}} is confirmed. {{link}}',
    subject: null,
  })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/** One accepted SMS row, with a provider id unique to this run. */
async function sentMessage(suffix: string, costFils = 9, segments = 1) {
  const providerMessageId = `smsala-${RUN}-${suffix}`
  const row = await store.recordSend(
    {
      templateId: fixture.smsTemplateId,
      channel: 'sms',
      messageClass: 'transactional',
      locale: 'en',
      vendor: 'smsala',
      recipient: recipientFor(SMS_RECIPIENT_SLOTS.seededShape),
      senderId: 'BERELAX',
      subject: null,
      body: 'Your appointment is confirmed.',
      bodyHtml: null,
      encoding: 'GSM-7',
      segments,
      costFils,
    },
    { kind: 'accepted', providerMessageId, segments, costFils, atIso: SENT_AT },
    SENT_AT,
  )
  return { row, providerMessageId }
}

const receiptFor = (
  providerMessageId: string,
  overrides: Partial<Parameters<PostgresMessageStore['applyReceipt']>[0]> = {},
) => ({
  vendor: 'smsala',
  providerMessageId,
  vendorStatus: 'delivered',
  mapped: 'delivered' as const,
  occurredAtIso: DELIVERED_AT,
  reason: null,
  ...overrides,
})

describe('acceptance — the row carries the lifecycle, and a DLR cannot move it backwards', () => {
  it('stores provider id, status, segments and cost, and starts at sent', async () => {
    const { row, providerMessageId } = await sentMessage('a')
    const stored = await readMessageRow(sql, row.id)
    expect(stored).toMatchObject({
      status: 'sent',
      providerMessageId,
      segments: 1,
      costFils: 9,
      attempts: 1,
      nextAttemptAtIso: null,
    })
  })

  it('does not regress when delivered arrives before sent, asserted on the final stored value', async () => {
    const { row, providerMessageId } = await sentMessage('b')
    // Delivered first, then the accepted receipt that was queued behind it. This is the normal order
    // for a webhook, not the exotic one.
    const first = await store.applyReceipt(receiptFor(providerMessageId))
    const second = await store.applyReceipt(
      receiptFor(providerMessageId, {
        vendorStatus: 'accepted',
        mapped: 'sent',
        occurredAtIso: SENT_AT,
      }),
    )
    expect(first).toMatchObject({ kind: 'applied', status: 'delivered' })
    expect(second).toMatchObject({ kind: 'ignored', reason: 'status_would_not_advance' })
    // The final stored value, which is what the acceptance criterion names.
    expect((await readMessageRow(sql, row.id))?.status).toBe('delivered')
    // Both receipts are on record: a delta over this message's own rows, which is the only count that
    // is stable in a shared database.
    const receipts = await listMessageReceipts(sql, row.id)
    expect(receipts.map((r) => [r.vendorStatus, r.applied])).toEqual([
      ['accepted', false],
      ['delivered', true],
    ])
  })

  it('keeps the first terminal state, and the database refuses a regression by name', async () => {
    const { row, providerMessageId } = await sentMessage('c')
    await store.applyReceipt(receiptFor(providerMessageId))
    const late = await store.applyReceipt(
      receiptFor(providerMessageId, {
        vendorStatus: 'expired',
        mapped: 'failed',
        occurredAtIso: '2026-09-18T12:00:00.000Z',
        reason: 'Absent subscriber',
      }),
    )
    expect(late).toMatchObject({ kind: 'ignored', reason: 'status_would_not_advance' })
    expect((await readMessageRow(sql, row.id))?.status).toBe('delivered')

    // And the guard is not only in the repository. A writer that never came through it — a migration, a
    // psql session at 2am — is refused by the trigger, by name.
    await expect(
      sql`update message set status = 'sent'::message_status where id = ${row.id}`,
    ).rejects.toThrow(/message_status_must_not_regress/)
    // The control: an UPDATE that does not touch the status is not refused, so the trigger is a
    // regression guard rather than a read-only table.
    await expect(
      sql`update message set last_failure_detail = 'a note' where id = ${row.id}`,
    ).resolves.toBeDefined()
  })

  it('is idempotent under a replayed webhook: one transition, one receipt, one charge', async () => {
    const { row, providerMessageId } = await sentMessage('d')
    const before = await readMessageRow(sql, row.id)
    const outcomes = []
    for (let i = 0; i < 3; i += 1) {
      outcomes.push(await store.applyReceipt(receiptFor(providerMessageId)))
    }
    expect(outcomes.map((o) => o.kind)).toEqual(['applied', 'replayed', 'replayed'])
    // One receipt row, not three: the second and third conflicted on
    // message_delivery_receipt_replay_unique.
    expect(await listMessageReceipts(sql, row.id)).toHaveLength(1)
    const after = await readMessageRow(sql, row.id)
    expect(after?.status).toBe('delivered')
    // Unchanged by a delivery, replayed or not. A receipt is not a send.
    expect(after?.costFils).toBe(before?.costFils)
    expect(after?.segments).toBe(before?.segments)
    expect(after?.attempts).toBe(before?.attempts)
  })

  it('records an unrecognised vendor status without reading it as delivered', async () => {
    const { row, providerMessageId } = await sentMessage('e')
    const ignored = await store.applyReceipt(
      receiptFor(providerMessageId, { vendorStatus: 'DELIVRD', mapped: null }),
    )
    expect(ignored).toMatchObject({ kind: 'ignored', reason: 'vendor_status_unrecognised' })
    expect((await readMessageRow(sql, row.id))?.status).toBe('sent')
    const [receipt] = await listMessageReceipts(sql, row.id)
    expect(receipt).toMatchObject({
      vendorStatus: 'DELIVRD',
      mappedStatus: null,
      applied: false,
      ignoredReason: 'vendor_status_unrecognised',
    })
    // The control: a word it does recognise, on the same message, does advance it. Without this, a
    // store that ignored everything would pass the lines above.
    const applied = await store.applyReceipt(
      receiptFor(providerMessageId, { occurredAtIso: '2026-09-18T10:30:00.000Z' }),
    )
    expect(applied).toMatchObject({ kind: 'applied', status: 'delivered' })
  })

  it('names a receipt for a message it never sent, rather than inventing one', async () => {
    const outcome = await store.applyReceipt(receiptFor(`smsala-${RUN}-never-sent`))
    expect(outcome).toEqual({
      kind: 'unknown_message',
      providerMessageId: `smsala-${RUN}-never-sent`,
    })
  })

  it('carries a delivery failure as its own reason, not as a transport failure', async () => {
    const { row, providerMessageId } = await sentMessage('f')
    await store.applyReceipt(
      receiptFor(providerMessageId, {
        vendorStatus: 'expired',
        mapped: 'failed',
        reason: 'Absent subscriber',
      }),
    )
    const stored = await readMessageRow(sql, row.id)
    expect(stored?.status).toBe('failed')
    // A rate limit and an absent subscriber are different pieces of work. The vendor's own word is on
    // the receipt; the row says which KIND of failure this was.
    expect(stored?.lastFailureReason).toBe('delivery_reported_failed')
    const [entry] = await listMessageInbox(sql, {
      recipient: recipientFor(SMS_RECIPIENT_SLOTS.seededShape),
      limit: 200,
    })
    expect(entry).toBeDefined()
  })
})

// --- the send path, with retries, through the real store -----------------------------------------

const SMS_TEMPLATE = (key: string): ClassifiedTemplate => ({
  key,
  messageClass: 'transactional',
  approvalState: 'approved',
  channel: 'sms',
  locale: 'en',
  body: 'Your appointment on {{date}} at {{time}} is confirmed. {{link}}',
  variables: ['date', 'time', 'link'],
})

interface LiveHarness {
  readonly deps: DeliveryDeps
  readonly sms: ReturnType<typeof createSmsalaTransport>
  readonly waits: string[]
}

function liveHarness(): LiveHarness {
  let nowIso = SENT_AT
  const config = parseConfig({
    APP_ENV: 'production',
    DATABASE_URL: url as string,
  })
  const sms = createSmsalaTransport({ config, now: () => nowIso })
  const waits: string[] = []
  const clock: Clock = { now: () => instantFromIso(nowIso) }
  const send: SendContext = {
    appEnv: 'production',
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox: new InMemoryOutbox(),
    clock,
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators: {
        hasConsent: () => true,
        isSuppressed: () => false,
        frequencyCapReached: () => false,
      },
    },
  }
  return {
    deps: {
      store,
      send,
      waitUntil: async (iso) => {
        waits.push(iso)
        nowIso = iso
      },
    },
    sms,
    waits,
  }
}

let liveSequence = 0
function liveRequest(recipient: string): RecordedSendRequest {
  liveSequence += 1
  return {
    // The idempotency key is `templateKey:id`, and the fake derives the provider message id from it —
    // so a per-run id here is what keeps `message_provider_id_unique` honest across suite runs.
    id: `bmsg04-${RUN}-${liveSequence}` as MessageId,
    templateId: liveTemplateId,
    template: SMS_TEMPLATE(liveTemplateKey),
    values: { date: '19 Sep', time: '21:00', link: 'https://be.relax/b/7' },
    recipient,
  }
}

describe('acceptance — every fake send is in the inbox, and a failure retries to a declared cap', () => {
  it('finds the inbox row a send just produced, with body, encoding, segments, cost and status', async () => {
    const recipient = recipientFor(SMS_RECIPIENT_SLOTS.inboxRead)
    const harness = liveHarness()
    const outcome = await deliverMessage(harness.deps, liveRequest(recipient))
    expect(outcome.kind).toBe('sent')
    if (outcome.kind !== 'sent') return

    // Narrowed to this send's recipient, because the inbox reader is global by design.
    const entries = await listMessageInbox(sql, { recipient, limit: 200 })
    // A send that produced no inbox row fails HERE. That is the criterion: there is no invisible path.
    expect(entries).toHaveLength(1)
    const [entry] = entries
    expect(entry).toMatchObject({
      templateKey: liveTemplateKey,
      channel: 'sms',
      vendor: 'smsala',
      encoding: 'GSM-7',
      status: 'sent',
      attempts: 1,
      providerMessageId: outcome.message.providerMessageId,
      senderId: 'BERELAX',
    })
    expect(entry?.body).toContain('19 Sep')
    expect(entry?.segments).toBeGreaterThanOrEqual(1)
    expect(entry?.costFils).toBeGreaterThanOrEqual(1)
    // The provider really was called, so "there is a row" is not a row written by nothing.
    expect(
      harness.sms.calls.forProvider('smsala').filter((c) => c.outcome === 'success'),
    ).toHaveLength(1)
    // The control on the reader: a template nobody has sent returns nothing, so the filter filters.
    expect(await listMessageInbox(sql, { templateKey: `bmsg04.${RUN}.never` })).toEqual([])
  })

  it('attempts a rejection once and a rate limit three times, both ending failed', async () => {
    const rejectedRecipient = recipientFor(SMS_RECIPIENT_SLOTS.rejected)
    const rejected = liveHarness()
    rejected.sms.failures.transactional.failAlways('rejected')
    const first = await deliverMessage(rejected.deps, liveRequest(rejectedRecipient))
    expect(first.kind).toBe('failed')
    if (first.kind !== 'failed') return
    const rejectedRow = await readMessageRow(sql, first.message.id)
    expect(rejectedRow).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastFailureReason: 'provider_rejected',
      nextAttemptAtIso: null,
      // Never accepted, so no vendor id — and the row is still visible.
      providerMessageId: null,
    })
    expect(rejected.waits).toEqual([])

    const limitedRecipient = recipientFor(SMS_RECIPIENT_SLOTS.rateLimited)
    const limited = liveHarness()
    limited.sms.failures.transactional.failAlways('rate_limited')
    const second = await deliverMessage(limited.deps, liveRequest(limitedRecipient))
    expect(second.kind).toBe('failed')
    if (second.kind !== 'failed') return
    expect(await readMessageRow(sql, second.message.id)).toMatchObject({
      status: 'failed',
      attempts: 3,
      lastFailureReason: 'provider_rate_limited',
      nextAttemptAtIso: null,
    })
    // The declared backoff, each wait measured from the failure it follows.
    expect(limited.waits).toEqual(['2026-09-18T10:01:00.000Z', '2026-09-18T10:06:00.000Z'])
    expect(limited.sms.calls.forProvider('smsala')).toHaveLength(3)
    // Exact counts per failure mode, side by side: the two differ, so neither is a cap applied to both.
    expect(rejectedRow?.attempts).not.toBe(3)
  })

  it('leaves a retryable failure queued with its next attempt, which the schema only allows there', async () => {
    const recipient = recipientFor(SMS_RECIPIENT_SLOTS.retryable)
    const harness = liveHarness()
    harness.sms.failures.transactional.failNext('rate_limited', 1)
    // One wait, then the provider recovers: the row passes through queued with a next_attempt_at, and
    // `message_retry_only_while_queued` is what makes that state unambiguous.
    const outcome = await deliverMessage(harness.deps, liveRequest(recipient))
    expect(outcome.kind).toBe('sent')
    if (outcome.kind !== 'sent') return
    expect(await readMessageRow(sql, outcome.message.id)).toMatchObject({
      status: 'sent',
      attempts: 2,
      // Cleared on success: a sent message with a pending retry would be sent twice.
      nextAttemptAtIso: null,
    })
    expect(harness.waits).toEqual(['2026-09-18T10:01:00.000Z'])
  })
})

// --- the frequency cap ---------------------------------------------------------------------------

describe('acceptance — a delivery receipt cannot un-count a message against the frequency cap', () => {
  it('counts a promotional message from the moment it was sent, whatever happens to it after', async () => {
    const recipient = recipientFor(SMS_RECIPIENT_SLOTS.promotional)
    const promotionalTemplateId = await ensureMessageTemplate(sql, {
      key: `bmsg04.${RUN}.promo`,
      channel: 'sms',
      // The template's class, and it has to be `promotional` because the message rows below are. This
      // fixture used to create the template as `transactional` and record promotional messages against
      // it; `message_class_matches_its_template` (ZM004, migration 0061) refuses that now.
      messageClass: 'promotional',
      body: 'Two treatments for one this week.',
      subject: null,
    })
    const ids: string[] = []
    for (const [index, suffix] of ['p1', 'p2'].entries()) {
      const providerMessageId = `smsala-${RUN}-${suffix}`
      const row = await store.recordSend(
        {
          templateId: promotionalTemplateId,
          channel: 'sms',
          messageClass: 'promotional',
          locale: 'en',
          vendor: 'smsala',
          recipient,
          senderId: 'AD-BERELAX',
          subject: null,
          body: 'Two treatments for one this week.',
          bodyHtml: null,
          encoding: 'GSM-7',
          segments: 1,
          costFils: 9,
        },
        {
          kind: 'accepted',
          providerMessageId,
          segments: 1,
          costFils: 9,
          atIso: `2026-09-1${index + 4}T10:00:00.000Z`,
        },
        `2026-09-1${index + 4}T10:00:00.000Z`,
      )
      ids.push(row.id)
      // One delivered and one failed, so the "unchanged" assertion below is not unchanged because
      // nothing happened.
      await store.applyReceipt({
        vendor: 'smsala',
        providerMessageId,
        vendorStatus: index === 0 ? 'delivered' : 'expired',
        mapped: index === 0 ? 'delivered' : 'failed',
        occurredAtIso: `2026-09-1${index + 4}T10:05:00.000Z`,
        reason: index === 0 ? null : 'Absent subscriber',
      })
    }

    const since = '2026-09-10T00:00:00.000Z'
    expect(await countPromotionalMessagesSince(sql, { recipient, sinceIso: since })).toBe(2)
    // The control that the statuses really moved: one is delivered, one is failed. If the count above
    // were status-filtered it would read 1, and a DLR pass would have bought another marketing send.
    const entries = await listMessageInbox(sql, { recipient, limit: 200 })
    expect(entries.map((entry) => entry.status).sort()).toEqual(['delivered', 'failed'])
    expect(ids).toHaveLength(2)
    // And a transactional message to the same number does not count against a marketing cap.
    await sentMessage('t1')
    expect(await countPromotionalMessagesSince(sql, { recipient, sinceIso: since })).toBe(2)
  })
})

// --- the cost queries ----------------------------------------------------------------------------

describe('acceptance — cost per day and per template match a literal expected total', () => {
  const window = () => ({
    ...FIXTURE_COST_WINDOW,
    templateKeys: [fixture.smsTemplateKey, fixture.emailTemplateKey],
  })

  it('groups by trading date, so a 01:30 send belongs to the previous trading day', async () => {
    const rows = await messageCostByTradingDate(sql, window())
    expect(rows).toEqual([...EXPECTED_COST_BY_TRADING_DATE])
    // Stated separately, because the literal above is only meaningful if the reader knows which rows
    // landed where: the first trading date holds two messages and four segments, and the second of
    // those two was sent at 21:30Z — 01:30 on the NEXT calendar day in Dubai.
    const arabic = fixture.messages.find((message) => message.segments === 3)
    expect(arabic?.sentAtIso).toBe('2099-03-01T21:30:00.000Z')
    const dubaiDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(
      new Date(arabic?.sentAtIso ?? ''),
    )
    expect(dubaiDate).toBe(FIXTURE_TRADING_DATE_TWO)
    const first = rows.find((row) => row.tradingDate === FIXTURE_TRADING_DATE_ONE)
    expect(first?.segments).toBe(4)
  })

  it('reports a send made outside every trading window rather than dropping it', async () => {
    const rows = await messageCostByTradingDate(sql, window())
    const outside = rows.find((row) => row.tradingDate === null)
    // An inner join would omit this row entirely, and the day's total would be short by 12 fils with
    // nothing to show why.
    expect(outside).toEqual({ tradingDate: null, messages: 1, segments: 1, costFils: 12 })
    const total = rows.reduce((sum, row) => sum + row.costFils, 0)
    // 126 and not six times one rate: three English segments at 12 fils and the Arabic body's three at
    // 30 (C-AUTO-02's per-encoding price table). The same total the per-template grouping produces.
    expect(total).toBe(126)
  })

  it('prices the Arabic body at three segments, the worked example B-MSG-01 states', async () => {
    expect(ARABIC_150).toHaveLength(150)
    const [entry] = await listMessageInbox(sql, {
      templateKey: fixture.smsTemplateKey,
      limit: 200,
      status: 'sent',
    })
    expect(entry).toBeDefined()
    const arabic = (
      await listMessageInbox(sql, { templateKey: fixture.smsTemplateKey, limit: 200 })
    ).find((row) => row.locale === 'ar')
    expect(arabic).toMatchObject({ encoding: 'UCS-2', segments: 3, costFils: 90 })
    // The control: the English body on the same template is one segment at 12 fils, so 90 is about
    // Arabic rather than about this template — three segments instead of one, each at the dearer
    // unicode rate, which is the figure docs/04 §5 asks an author to see before they send.
    const english = (
      await listMessageInbox(sql, { templateKey: fixture.smsTemplateKey, limit: 200 })
    ).find((row) => row.locale === 'en')
    expect(english).toMatchObject({ encoding: 'GSM-7', segments: 1, costFils: 12 })
  })

  it('groups by template key, so an email costs nothing and an SMS costs its segments', async () => {
    const rows = await messageCostByTemplate(sql, window())
    expect(rows).toEqual([
      { templateKey: fixture.emailTemplateKey, ...EXPECTED_COST_BY_TEMPLATE.email },
      { templateKey: fixture.smsTemplateKey, ...EXPECTED_COST_BY_TEMPLATE.sms },
    ])
  })

  it('narrows to the templates it was asked for, and not to every message in the database', async () => {
    // The control on the window: the same query with only the email template returns only its row.
    const rows = await messageCostByTemplate(sql, {
      ...FIXTURE_COST_WINDOW,
      templateKeys: [fixture.emailTemplateKey],
    })
    expect(rows).toEqual([
      { templateKey: fixture.emailTemplateKey, ...EXPECTED_COST_BY_TEMPLATE.email },
    ])
    // And a window that ends before the fixture's first send contains nothing, so the bounds bind.
    expect(
      await messageCostByTemplate(sql, {
        fromIso: '2099-01-01T00:00:00.000Z',
        toIso: '2099-02-01T00:00:00.000Z',
        templateKeys: [fixture.smsTemplateKey, fixture.emailTemplateKey],
      }),
    ).toEqual([])
  })
})

// --- the append-only guarantee -------------------------------------------------------------------

describe('a receipt is evidence', () => {
  it('cannot be updated, deleted, or orphaned by deleting its message', async () => {
    const { row, providerMessageId } = await sentMessage('g')
    await store.applyReceipt(receiptFor(providerMessageId))
    await expect(
      sql`update message_delivery_receipt set applied = false where message_id = ${row.id}`,
    ).rejects.toThrow(/append-only/)
    await expect(
      sql`delete from message_delivery_receipt where message_id = ${row.id}`,
    ).rejects.toThrow(/append-only/)
    // And the message it belongs to cannot be deleted either — which is why every read in this file is
    // narrowed rather than cleaned up.
    await expect(sql`delete from message where id = ${row.id}`).rejects.toThrow(
      /message_delivery_receipt_message_id_fkey/,
    )
  })
})
