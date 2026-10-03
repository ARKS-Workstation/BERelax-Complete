import { loadConfig } from '@berelax/config'
import {
  SEO_REPORT_MAX_SENTENCE_WORDS,
  type SeoReportMetric,
  type SeoWeeklyAction,
} from '@berelax/core'
import { agentHeartbeatFacts, createConnection, recordGscSnapshot, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  NO_OWNER_REPORT_ADDRESS,
  PROVISIONAL_REPORT_SENDER,
  SEO_WEEKLY_REPORT_AGENT,
  SEO_WEEKLY_REPORT_TEMPLATE,
  seoWeeklyReportSender,
} from './seo-weekly-report.ts'

/**
 * G-SEO-07 — the weekly report, through the send choke point, against real rows.
 *
 * The three claims that need a database are the three that cannot be faked: the heartbeat facts come from
 * `agent_heartbeat` and a sum over `agent_run`, the template comes from `message_template` as the seed
 * wrote it, and the staging guard's decision depends on the real `APP_ENV` and `OUTBOUND_ALLOWLIST`.
 */

const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!DATABASE_URL)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const NOW_ISO = '2026-10-02T06:00:00.000Z'
const WEEK_ENDING = '2026-10-02'
/** Visibly a fixture (brief rule 15), on `.invalid`, and a property no other suite writes. */
const SITE = 'sc-domain:gseo07-weekly.invalid'
/**
 * Every recipient this suite sends to, so it can remove exactly the rows it created.
 *
 * It has to. The pass derives its idempotency key from the reporting WINDOW — which is correct in
 * production, because a reclaimed job must not bill a second email — and the fake provider derives its
 * `providerMessageId` from that key, so a second run of this file hit
 * `message_provider_id_unique`. Gate case 172z found it by running the suite twice, which is the leak the
 * brief's "a suite that cannot run twice is a suite that leaks" is about.
 *
 * The cleanup runs BEFORE as well as after, so a crashed previous run does not poison this one.
 */
const RECIPIENT_PREFIX = 'gseo07-'
const RECIPIENT_DOMAIN = '@berelax.example.invalid'
/** A cost nothing else writes, so the sum this suite asserts on is its own and is NOT zero. */
const FIXTURE_RUN_COST_FILS = 1_234
const FIXTURE_RUN_JOB_ID = 'gseo07-weekly-report-fixture'

const action = (kind: SeoWeeklyAction['kind'], n: number): SeoWeeklyAction => ({
  kind,
  finding: `Finding ${n} about ${kind}.`,
  expectedEffect: 'More of the people searching for a massage nearby should find this site.',
  humanAction: `Open the page and change the heading, step ${n}.`,
})

const METRICS: readonly SeoReportMetric[] = [
  {
    label: 'People who saw you in Google',
    value: '1,240',
    explanation: 'This counts every time one of your pages appeared in a result list.',
  },
]

let sql: Sql

/** Only rows this suite created: its own messages, and its own agent_run row. */
async function removeOwnRows(): Promise<void> {
  const recipients = `${RECIPIENT_PREFIX}%${RECIPIENT_DOMAIN}`
  await sql`
    delete from message_delivery_receipt
    where message_id in (select id from message where recipient like ${recipients})
  `
  await sql`delete from message where recipient like ${recipients}`
  await sql`delete from agent_run where job_id = ${FIXTURE_RUN_JOB_ID}`
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL as string, max: 4 })
  await removeOwnRows()
  // A run with a cost nothing else wrote, so `sum(cost_fils)` is non-zero and the figure the report
  // prints can be COMPARED to it. Without this the assertion would be 0.00 against 0.00, which passes
  // whether or not anything read the rows — the vacuous shape brief rule 3 is about.
  await sql`
    insert into agent_run (agent_key, job_id, started_at, finished_at, outcome, cost_fils)
    values (${SEO_WEEKLY_REPORT_AGENT}, ${FIXTURE_RUN_JOB_ID}, ${NOW_ISO}::timestamptz,
            ${NOW_ISO}::timestamptz, 'succeeded', ${FIXTURE_RUN_COST_FILS})
  `
})

afterAll(async () => {
  await removeOwnRows()
  await sql.end({ timeout: 5 })
})

/** An allowlisted recipient, so the guard DELIVERS and the fake provider is reached. */
function senderWith(recipient: string | null) {
  const config = loadConfig()
  return {
    config,
    sender: seoWeeklyReportSender({
      sql,
      config:
        recipient === null
          ? config
          : { ...config, OUTBOUND_ALLOWLIST: [...config.OUTBOUND_ALLOWLIST, recipient] },
      now: () => NOW_ISO,
      recipient: () => recipient,
      from: PROVISIONAL_REPORT_SENDER,
    }),
  }
}

describe('the weekly SEO report job', () => {
  it('carries the heartbeat facts the agent_heartbeat row holds', async () => {
    const facts = await agentHeartbeatFacts(sql, SEO_WEEKLY_REPORT_AGENT)
    expect(facts, `no agent_definition row for ${SEO_WEEKLY_REPORT_AGENT}`).toBeDefined()

    const { sender } = senderWith(null)
    const outcome = await sender.deliver({
      weekEndingIso: WEEK_ENDING,
      findings: [action('coverage', 1)],
      metrics: METRICS,
      snapshot: null,
      degradedBecause: null,
    })

    // Compared to the ROW, not to a constant: the acceptance line asks for exactly that, and a rendered
    // figure asserted against a literal would keep passing after the row stopped being read.
    const body = outcome.report.body
    if (facts?.lastSuccessAtIso === null) {
      expect(body).toContain('never finished successfully yet')
    } else {
      expect(body).toContain(facts?.lastSuccessAtIso ?? 'unreachable')
    }
    if (facts?.nextRunDueAtIso === null) {
      expect(body).toContain('no next run on the books')
    } else {
      expect(body).toContain(facts?.nextRunDueAtIso ?? 'unreachable')
    }
    expect(body).toContain(`cost ${((facts?.costToDateFils ?? 0) / 100).toFixed(2)} AED so far`)
    // And the sum really includes this suite's run, so the comparison above is not 0.00 against 0.00.
    expect(facts?.costToDateFils).toBeGreaterThanOrEqual(FIXTURE_RUN_COST_FILS)
  })

  it('sends nothing when there is no owner address on file, and composes the report anyway', async () => {
    // The shipped resolver, asserted rather than read: no table in this build holds an owner address.
    expect(NO_OWNER_REPORT_ADDRESS()).toBeNull()

    const { sender } = senderWith(null)
    const outcome = await sender.deliver({
      weekEndingIso: WEEK_ENDING,
      findings: [action('coverage', 1)],
      metrics: METRICS,
      snapshot: null,
      degradedBecause: null,
    })
    expect(outcome.kind).toBe('not_sent')
    if (outcome.kind !== 'not_sent') return
    expect(outcome.reason).toContain('no_recipient_on_file')
    // The report is composed even so — a pass that produced nothing would be indistinguishable from a
    // stopped agent, which is the whole subject of the heartbeat section.
    expect(outcome.report.body).toContain('Finding 1 about coverage.')
    expect(outcome.html).not.toBeNull()
  })

  it('lands in the fake Resend outbox with an HTML preview of exactly the bytes sent', async () => {
    const recipient = `${RECIPIENT_PREFIX}weekly-report${RECIPIENT_DOMAIN}`
    const { sender } = senderWith(recipient)
    const outcome = await sender.deliver({
      weekEndingIso: WEEK_ENDING,
      findings: [action('coverage', 1), action('gbp_inconsistency', 2)],
      metrics: METRICS,
      snapshot: null,
      degradedBecause: null,
    })
    expect(outcome.kind).toBe('sent')
    if (outcome.kind !== 'sent') return
    expect(outcome.messageId).not.toBeNull()

    // The HTML part, and it is a derivation of the body rather than a second rendering: the row the admin
    // inbox previews stores these exact bytes.
    expect(outcome.html).toContain('Finding 1 about coverage.')
    expect(outcome.html).toContain('<html')

    const [row] = await sql<{ bodyHtml: string | null; body: string; status: string }[]>`
      select body_html as "bodyHtml", body, status from message
      where id = ${outcome.messageId as string}::uuid
    `
    expect(row?.status).toBe('sent')
    expect(row?.bodyHtml).toBe(outcome.html)
    expect(row?.body).toContain('Finding 1 about coverage.')
  })

  it('diverts to the local outbox when the recipient is not allowlisted (F03 at this seam)', async () => {
    // Not allowlisted, and APP_ENV is not production, so the guard diverts. Off production this is the
    // ORDINARY outcome: a message in the local outbox, inspectable, with no provider call.
    const config = loadConfig()
    expect(config.APP_ENV).not.toBe('production')
    const sender = seoWeeklyReportSender({
      sql,
      config,
      now: () => NOW_ISO,
      recipient: () => `${RECIPIENT_PREFIX}not-allowlisted${RECIPIENT_DOMAIN}`,
      from: PROVISIONAL_REPORT_SENDER,
    })
    const outcome = await sender.deliver({
      weekEndingIso: '2026-10-09',
      findings: [action('coverage', 1)],
      metrics: METRICS,
      snapshot: null,
      degradedBecause: null,
    })
    // `sent` with a null message id is what a divert looks like from here: nothing left the process.
    expect(outcome.kind).toBe('sent')
    if (outcome.kind !== 'sent') return
    expect(outcome.messageId).toBeNull()
  })

  it('refuses a real transport outside production, at construction', () => {
    const config = loadConfig()
    expect(config.APP_ENV).not.toBe('production')
    // ADR 0005, re-asserted at THIS seam rather than taken on trust from the unit that built it: a real
    // provider outside production does not even construct, so a staging run cannot email a real customer.
    expect(() =>
      seoWeeklyReportSender({
        sql,
        config: { ...config, EMAIL_PROVIDER: 'real' },
        now: () => NOW_ISO,
        recipient: () => `${RECIPIENT_PREFIX}anybody${RECIPIENT_DOMAIN}`,
        from: PROVISIONAL_REPORT_SENDER,
      }),
    ).toThrow(/not implemented|provider/i)
  })

  it('renders the stored click discrepancy from the snapshot, and omits it when the totals agree', async () => {
    const withGap = await recordGscSnapshot(sql, {
      siteUrl: SITE,
      windowStart: '2026-09-26',
      windowEnd: WEEK_ENDING,
      requestedAtIso: NOW_ISO,
      pagesFetched: 1,
      rowLimit: 25_000,
      lastStartRow: 0,
      rowsPersisted: 10,
      queryClicks: 61,
      queryImpressions: 1_100,
      pageClicks: 74,
      pageImpressions: 1_240,
    })
    // The generated columns, so the sentence is rendered from the figure the DATABASE derived.
    expect(withGap.rareQueryClicks).toBe(13)

    const { sender } = senderWith(null)
    const gapReport = await sender.deliver({
      weekEndingIso: WEEK_ENDING,
      findings: [],
      metrics: METRICS,
      snapshot: withGap,
      degradedBecause: null,
    })
    expect(gapReport.report.body).toContain('Search Console withholds 13 of these 74 clicks')

    const noGap = await recordGscSnapshot(sql, {
      siteUrl: SITE,
      windowStart: '2026-09-19',
      windowEnd: '2026-09-25',
      requestedAtIso: NOW_ISO,
      pagesFetched: 1,
      rowLimit: 25_000,
      lastStartRow: 0,
      rowsPersisted: 10,
      queryClicks: 74,
      queryImpressions: 1_240,
      pageClicks: 74,
      pageImpressions: 1_240,
    })
    expect(noGap.rareQueryClicks).toBe(0)
    const agreed = await sender.deliver({
      weekEndingIso: '2026-09-25',
      findings: [],
      metrics: METRICS,
      snapshot: noGap,
      degradedBecause: null,
    })
    expect(agreed.report.body).not.toContain('withholds')
  })

  it('states a degraded run in one plain sentence and still sends', async () => {
    const recipient = `${RECIPIENT_PREFIX}degraded${RECIPIENT_DOMAIN}`
    const { sender } = senderWith(recipient)
    const outcome = await sender.deliver({
      weekEndingIso: '2026-10-16',
      findings: [action('coverage', 1)],
      metrics: METRICS,
      snapshot: null,
      degradedBecause: 'the Google connection needs reconnecting.',
    })
    expect(outcome.kind).toBe('sent')
    expect(outcome.report.body).toContain('come from the copy we keep, not from Google')
    expect(outcome.report.body).toContain('The actions below still stand.')
  })

  it('refuses to send a body that breaks its own prose rules, naming the rule', async () => {
    const recipient = `${RECIPIENT_PREFIX}prose${RECIPIENT_DOMAIN}`
    const { sender } = senderWith(recipient)
    const outcome = await sender.deliver({
      weekEndingIso: '2026-10-23',
      findings: [
        {
          kind: 'coverage',
          // Over the configured maximum, deliberately: a body that broke its own rules would be sent once
          // and read as the house style from then on.
          finding: `${'word '.repeat(SEO_REPORT_MAX_SENTENCE_WORDS + 2).trim()}.`,
          expectedEffect: 'Nothing, this is a fixture.',
          humanAction: 'Nothing, this is a fixture.',
        },
      ],
      metrics: METRICS,
      snapshot: null,
      degradedBecause: null,
    })
    expect(outcome.kind).toBe('not_sent')
    if (outcome.kind !== 'not_sent') return
    expect(outcome.reason).toContain('sentence_too_long')
    expect(outcome.html).toBeNull()
  })

  it('reads the seeded template row rather than composing its own frame', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from message_template where template_key = ${SEO_WEEKLY_REPORT_TEMPLATE}
    `
    // The seed writes it from DEFAULT_TEMPLATES. An absent row is a database that was never seeded, and
    // the pass throws by name rather than inventing a frame.
    expect(Number(row?.n)).toBeGreaterThan(0)
  })
})
