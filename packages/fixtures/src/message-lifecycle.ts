/**
 * The seeded messaging fixture: two templates, five sent messages, and two trading days.
 *
 * It exists so the cost aggregates can be asserted against **literal** expected totals rather than
 * against a second computation of the same sum — a test that re-derives the answer it is checking will
 * agree with the query however wrong both are.
 *
 * ## Why every name and instant is per run
 *
 * The integration suite runs sequentially against one database, `message` rows are protected from
 * deletion by an ON DELETE RESTRICT foreign key out of an append-only table, and other units will send
 * messages. So nothing here is a singleton and nothing is a total: the template keys carry a per-run
 * suffix and every read the tests do is narrowed to them. That is the isolation rule in
 * `docs/CONTRIBUTING-AGENT-BRIEF.md` §12 — narrow what the code under test can see, rather than delete
 * rows a foreign key protects.
 *
 * ## Why the trading dates are in 2099
 *
 * `business_day` is keyed by trading date and is shared: two fixtures that both ensure 2026-03-01 with
 * different hours are a race, and `business-days.itest.ts` deletes the whole table. A far-future pair of
 * dates cannot collide with a fixture about the salon's real calendar, and the rows are ensured with
 * `on conflict do nothing` so a re-run of this file is not a second set of hours.
 *
 * ## The instants, and the one that matters
 *
 * Trading runs 11:00–02:00 Asia/Dubai, so trading date D opens at `D 07:00Z` and closes at `D 22:00Z`.
 * One of the five messages is sent at **01:30 Dubai**, which is inside the session that began the
 * previous day — so it belongs to the *previous* trading date. A report that grouped by calendar date
 * would split one evening across two days, and a report that inner-joined the calendar would drop the
 * message sent at 09:00 while the salon was shut. Both are asserted.
 */

import type { MessageToRecord, PostgresMessageStore, Sql } from '@berelax/db'
import { costOf } from '@berelax/messaging'

/** Trading date one. Opens 11:00 Dubai, closes 02:00 the next morning. */
export const FIXTURE_TRADING_DATE_ONE = '2099-03-01'
export const FIXTURE_TRADING_DATE_TWO = '2099-03-02'

/** The window every fixture read is bounded by, so no other unit's message can land inside it. */
export const FIXTURE_COST_WINDOW = {
  fromIso: '2099-03-01T00:00:00.000Z',
  toIso: '2099-03-04T00:00:00.000Z',
} as const

/**
 * A 150-character Arabic body.
 *
 * B-MSG-01's worked example: one Arabic character forces the whole body to UCS-2, where a segment holds
 * 70 characters (67 once concatenated) rather than 160 — so 150 characters is exactly 3 segments. The
 * body is built rather than typed so the count is verifiable by reading the code.
 */
export const ARABIC_150 = 'ت'.repeat(150)

/*
  Every SMS recipient this fixture and its suite write, from ONE builder, because two builders over one
  run id is a defect that hides for weeks and then fails about three runs in five.

  It was two: this module addressed its seeded messages to `+9715${run.slice(0, 8)}` while
  `message-lifecycle.itest.ts` addressed its live sends to `+9715${RUN.slice(0, 7)}` plus a
  distinguishing digit — and those are the SAME NUMBER whenever the eighth character of the run id
  happens to equal that digit. The digits in use were 0 to 5, so six runs in ten collided on one slot,
  and the symptom was a test reading the fixture's rows as well as its own: five or six statuses where it
  asserts two. Four separate units hit it. The first two fixes narrowed the odds — eight characters to
  seven, then one shared helper inside the itest — without removing the cause, because the cause is the
  OTHER builder, in this file.

  So: one function, a fixed-width run component, and a declared slot per writer. A collision is now
  impossible rather than unlikely, and `slotsAreDistinct` is asserted by the suite so a writer that helps
  itself to an existing slot fails a test rather than a Tuesday.
*/
export const SMS_RECIPIENT_SLOTS = {
  /** The messages `seedMessagingFixture` writes. */
  seededFixture: '9',
  /**
   * `message-lifecycle.itest.ts`'s live sends, one slot each, named for the test that writes it. The
   * names matter as much as the digits: a slot whose name does not say who owns it is one the next
   * writer reuses.
   */
  seededShape: '0',
  inboxRead: '1',
  rejected: '2',
  rateLimited: '3',
  retryable: '4',
  promotional: '5',
} as const

/** Every slot is one digit and no two writers share one. Asserted, not assumed. */
export function slotsAreDistinct(): boolean {
  const slots = Object.values(SMS_RECIPIENT_SLOTS)
  return slots.every((slot) => /^[0-9]$/.test(slot)) && new Set(slots).size === slots.length
}

/**
 * A UAE mobile in E.164 for one writer in one run: `+9715`, seven digits of the run id, and the slot.
 *
 * The run component is padded rather than sliced alone, because a run id is `${process.pid}` plus an
 * unpadded `Math.floor(Math.random() * 1e6)` and can therefore be shorter than seven characters — which
 * would produce a number too short to be a UAE mobile, a second flake waiting behind the first.
 */
export function smsRecipientFor(run: string, slot: string): string {
  if (!/^[0-9]$/.test(slot)) {
    throw new Error(`a recipient slot must be a single digit, not ${JSON.stringify(slot)}`)
  }
  return `+9715${run.slice(0, 7).padStart(7, '0')}${slot}`
}

export interface SeededMessage {
  readonly id: string
  readonly templateKey: string
  readonly providerMessageId: string
  readonly sentAtIso: string
  readonly segments: number
  readonly costFils: number
}

export interface SeededMessagingFixture {
  readonly run: string
  readonly smsTemplateKey: string
  readonly emailTemplateKey: string
  readonly smsTemplateId: string
  readonly emailTemplateId: string
  readonly messages: readonly SeededMessage[]
}

/**
 * The totals this fixture is built to produce, stated rather than computed.
 *
 * Per trading date: the 01:30 send joins the *first* date, and the 09:00 send joins no date at all
 * because the salon was shut — it is reported under a null trading date rather than dropped.
 */
export const EXPECTED_COST_BY_TRADING_DATE = [
  { tradingDate: FIXTURE_TRADING_DATE_ONE, messages: 2, segments: 4, costFils: 36 },
  { tradingDate: FIXTURE_TRADING_DATE_TWO, messages: 2, segments: 1, costFils: 9 },
  { tradingDate: null, messages: 1, segments: 1, costFils: 9 },
] as const

/**
 * Per template: four SMS messages worth six segments, and one email worth nothing.
 *
 * Six and not four, which is the whole reason this total is stated rather than computed: three of the
 * four English-and-Arabic bodies are one segment each and the Arabic one is **three**, because a segment
 * holds 70 UCS-2 characters rather than 160 GSM-7 ones. 6 x 9 fils is 54, and the per-trading-date rows
 * above sum to the same 54 — two independent groupings of one set of rows, which is what makes either
 * literal worth asserting.
 */
export const EXPECTED_COST_BY_TEMPLATE = {
  sms: { messages: 4, segments: 6, costFils: 54 },
  email: { messages: 1, segments: 0, costFils: 0 },
} as const

/** The five sends, in the order they are seeded. */
const PLAN = [
  {
    channel: 'sms' as const,
    locale: 'en' as const,
    body: 'Your appointment is confirmed. Manage it: https://be.relax/b/1',
    // 12:00 Dubai on the first trading date.
    sentAtIso: '2099-03-01T08:00:00.000Z',
  },
  {
    channel: 'sms' as const,
    locale: 'ar' as const,
    body: ARABIC_150,
    // 01:30 Dubai on the 2nd, which is inside the session that opened on the 1st.
    sentAtIso: '2099-03-01T21:30:00.000Z',
  },
  {
    channel: 'email' as const,
    locale: 'en' as const,
    body: 'Your tax invoice INV-2099 is attached.',
    // 12:00 Dubai on the second trading date.
    sentAtIso: '2099-03-02T08:00:00.000Z',
  },
  {
    channel: 'sms' as const,
    locale: 'en' as const,
    body: 'A reminder of your appointment tomorrow.',
    // 13:00 Dubai on the second trading date.
    sentAtIso: '2099-03-02T09:00:00.000Z',
  },
  {
    channel: 'sms' as const,
    locale: 'en' as const,
    body: 'Your therapist is running ten minutes late.',
    // 09:00 Dubai on the 3rd: the salon opens at 11:00 and there is no trading day seeded for it, so
    // this message belongs to no trading date. It still cost money.
    sentAtIso: '2099-03-03T05:00:00.000Z',
  },
] as const

/** Ensures the two trading days this fixture's instants fall inside. */
async function ensureTradingDays(sql: Sql): Promise<void> {
  for (const tradingDate of [FIXTURE_TRADING_DATE_ONE, FIXTURE_TRADING_DATE_TWO]) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        ${tradingDate}::date,
        (${tradingDate}::date + time '11:00') at time zone 'Asia/Dubai',
        (${tradingDate}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
        'weekly'
      )
      on conflict (trading_date) do nothing
    `
  }
}

/**
 * Creates one template and its single variant, and returns the template id.
 *
 * Exported because the itest also needs a template row for the sends it drives through the real choke
 * point: a message row's `template_id` has to point at the template whose key the send rendered, or the
 * per-template cost report would attribute it to another one.
 */
export async function ensureMessageTemplate(
  sql: Sql,
  args: { key: string; channel: 'sms' | 'email'; body: string; subject: string | null },
): Promise<string> {
  const [template] = await sql<{ id: string }[]>`
    insert into message_template (template_key, version, message_class, purpose, is_current)
    values (${args.key}, 1, 'transactional', 'B-MSG-04 cost fixture', true)
    returning id
  `
  if (template === undefined) throw new Error(`Could not create template ${args.key}`)
  await sql`
    insert into message_template_variant
      (template_id, channel, locale, approval_state, subject, body, variables)
    values (
      ${template.id}, ${args.channel}::message_channel, 'en', 'approved',
      ${args.subject}, ${args.body}, '{}'::text[]
    )
  `
  return template.id
}

/**
 * Seeds the fixture through the real store, not with hand-written INSERTs.
 *
 * The point of seeding through `recordSend` is that the fixture exercises the write path the system
 * uses: if a constraint refuses one of these rows, the fixture fails rather than the report being
 * asserted against a shape production cannot produce.
 */
export async function seedMessagingFixture(
  sql: Sql,
  store: PostgresMessageStore,
  run: string,
): Promise<SeededMessagingFixture> {
  await ensureTradingDays(sql)
  const smsTemplateKey = `bmsg04.${run}.sms`
  const emailTemplateKey = `bmsg04.${run}.email`
  const smsTemplateId = await ensureMessageTemplate(sql, {
    key: smsTemplateKey,
    channel: 'sms',
    body: 'Your appointment is confirmed.',
    subject: null,
  })
  const emailTemplateId = await ensureMessageTemplate(sql, {
    key: emailTemplateKey,
    channel: 'email',
    body: 'Your tax invoice is attached.',
    subject: 'Your tax invoice',
  })

  const messages: SeededMessage[] = []
  for (const [index, plan] of PLAN.entries()) {
    const cost = costOf(plan.channel, plan.body)
    const isEmail = plan.channel === 'email'
    // Shaped like a vendor id and unique per run: `message_provider_id_unique` is real, and a fixture
    // that reissued one would fail on the second run of the suite against the same database.
    const providerMessageId = isEmail ? `resend-${run}-${index}` : `smsala-${run}-${index}`
    const message: MessageToRecord = {
      templateId: isEmail ? emailTemplateId : smsTemplateId,
      channel: plan.channel,
      messageClass: 'transactional',
      locale: plan.locale,
      vendor: isEmail ? 'resend' : 'smsala',
      recipient: isEmail
        ? `guest-${run}@example.com`
        : smsRecipientFor(run, SMS_RECIPIENT_SLOTS.seededFixture),
      senderId: isEmail ? null : 'BERELAX',
      subject: isEmail ? 'Your tax invoice' : null,
      body: plan.body,
      bodyHtml: isEmail ? `<!doctype html><html><body><p>${plan.body}</p></body></html>` : null,
      encoding: cost.encoding,
      segments: cost.segments,
      costFils: cost.costFils,
    }
    const row = await store.recordSend(
      message,
      {
        kind: 'accepted',
        providerMessageId,
        segments: cost.segments,
        costFils: cost.costFils,
        atIso: plan.sentAtIso,
      },
      plan.sentAtIso,
    )
    messages.push({
      id: row.id,
      templateKey: isEmail ? emailTemplateKey : smsTemplateKey,
      providerMessageId,
      sentAtIso: plan.sentAtIso,
      segments: row.segments,
      costFils: row.costFils,
    })
  }

  return { run, smsTemplateKey, emailTemplateKey, smsTemplateId, emailTemplateId, messages }
}
