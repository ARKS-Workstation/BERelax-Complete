import { createHash, randomUUID } from 'node:crypto'
import { ALERT_OBSERVERS, createConnection, type Sql } from '@berelax/db'
import { createFixturePrincipal, FIXTURE_NOW } from '@berelax/fixtures'
import {
  blockingViolations,
  type Capture,
  type CaptureHarness,
  createCaptureHarness,
  DIRECTIONS,
  describeViolation,
  THEMES,
  VIEWPORTS,
} from '@berelax/harness'
import { alertDefinition } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { POST } from '../app/(admin)/agents/kill-switch/route.ts'
import {
  agentConsoleScreen,
  agentCosts,
  agentPendingApprovals,
  REVIEW_REPLY_AGENT_KEY,
  SEO_SUGGESTION_AGENT_KEY,
} from '../app/(admin)/agents/queries.ts'
import { KILL_SWITCH_FIELDS, renderAgentConsoleHtml } from '../app/(admin)/agents/render.ts'
import { AGENTS_TOGGLE_PERMISSION, GET } from '../app/(admin)/agents/route.ts'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The agent console against a real database and a real browser (G-AGT-02).
 *
 * ## What only this file can assert
 *
 * That the console is GENERATED. `agent-console-render.test.ts` renders whatever array it is handed, so
 * it cannot tell a row count derived from `agent_definition` from a hand-written list. Here the array
 * comes from a real query, a fixture agent is inserted, and the rendered row count is asserted to
 * increment — which is the acceptance line's first claim and is the one claim a pure render cannot make.
 *
 * It is also the only place the pending-approval counts can be held against a SQL `count(*)`, the cost
 * against real `agent_run` rows, and the kill switch's audit delta against `audit_event`.
 *
 * ## Isolation
 *
 * The fixture agent, its heartbeat and its runs are inserted inside a transaction that is always rolled
 * back, for the reason `agent-console.itest.ts` records about its own dead letter: these are rows a
 * foreign key protects and a later run would accumulate. The kill-switch cases are driven against the
 * COMMITTED database because the route opens its own connection — so they act on a seeded agent and put
 * its switch back, and every assertion about `audit_event` is a DELTA (ADR 0008).
 */
let sql: Sql
let harness: CaptureHarness
let tradingDate = ''
let captures: Capture[] = []
let recaptures: Capture[] = []

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const [day] = await sql<{ tradingDate: string }[]>`
    select trading_date::text as "tradingDate"
      from business_day
     where closes_at <= now()
     order by closes_at desc, trading_date desc
     limit 1
  `
  if (day === undefined) {
    throw new Error('the trading calendar holds no day that has closed; run `pnpm seed`')
  }
  tradingDate = day.tradingDate
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
  await harness?.close()
})

/**
 * A fixture agent, its heartbeat and `runs` finished runs, inside a transaction that is rolled back.
 *
 * The heartbeat is inserted as well as the definition, deliberately: `agentsWithHeartbeat` INNER JOINs
 * the two, and 0021's convention is that an agent brings its heartbeat row in its own migration — an
 * agent without one is invisible to the watchdog as well as to this console, which `pnpm jobs` refuses.
 * A fixture that inserted only a definition would be testing the join rather than the console.
 */
async function withFixtureAgent<T>(
  options: {
    readonly runs?: readonly { readonly costFils: number; readonly outcome: string }[]
    readonly budgetFilsPerRun?: number
    readonly killSwitch?: boolean
    readonly lastError?: string | null
    readonly consecutiveFailures?: number
  },
  body: (tx: Sql, agentKey: string) => Promise<T>,
): Promise<T> {
  let carried: T | undefined
  const sentinel = `G-AGT-02 rolled this agent fixture back ${randomUUID()}`
  const agentKey = `fixture_agent_${randomUUID().slice(0, 8)}`
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Sql
      await tx`
        insert into agent_definition
          (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run,
           enabled, kill_switch)
        values (${agentKey}, 'Fixture agent',
                'A fixture, so the console can be shown to come from the registry.',
                900, ${options.budgetFilsPerRun ?? 0}, true, ${options.killSwitch ?? false})
      `
      await tx`
        insert into agent_heartbeat
          (agent_key, last_run_at, last_success_at, next_run_at, last_outcome, last_error,
           consecutive_failures)
        values (${agentKey}, now(), now(), now() + interval '15 minutes',
                ${(options.consecutiveFailures ?? 0) > 0 ? 'failed' : 'succeeded'},
                ${options.lastError ?? null}, ${options.consecutiveFailures ?? 0})
      `
      for (const run of options.runs ?? []) {
        await tx`
          insert into agent_run (agent_key, started_at, finished_at, outcome, cost_fils, trading_date)
          values (${agentKey}, now() - interval '1 minute', now(), ${run.outcome},
                  ${run.costFils}, ${tradingDate}::date)
        `
      }
      carried = await body(tx, agentKey)
      throw new Error(sentinel)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== sentinel) throw error
  }
  if (carried === undefined) throw new Error('the fixture body returned nothing')
  return carried
}

describe('acceptance — the console is generated from the registry', () => {
  it('grows a row when an agent_definition row is inserted, with no code change', async () => {
    const before = await agentConsoleScreen(sql, { tradingDate, googleState: 'healthy' })
    const after = await withFixtureAgent(
      {},
      async (tx) => await agentConsoleScreen(tx, { tradingDate, googleState: 'healthy' }),
    )
    expect(after.rows).toHaveLength(before.rows.length + 1)

    // And the RENDERED count, which is the figure the acceptance line is about: a query that grew and a
    // page that did not would satisfy the assertion above.
    const html = renderAgentConsoleHtml({
      chrome: {
        googleReauth: null,
        sendBacklog: null,
        role: 'owner' as const,
        returnTo: '/agents',
      },
      screen: after,
      mayToggle: true,
      direction: 'ltr',
    })
    expect(html).toContain(`data-agent-count="${after.rows.length}"`)
    expect([...html.matchAll(/data-agent="/g)]).toHaveLength(after.rows.length)
    // The non-vacuity control: there were rows before, so "one more" is a difference against something.
    expect(before.rows.length).toBeGreaterThan(10)
  }, 120_000)

  it('names the fixture agent’s own purpose, so the row is about the row', async () => {
    const screen = await withFixtureAgent(
      {},
      async (tx) => await agentConsoleScreen(tx, { tradingDate, googleState: 'healthy' }),
    )
    const fixture = screen.rows.find((row) => row.agentKey.startsWith('fixture_agent_'))
    expect(fixture?.purpose).toContain('so the console can be shown to come from the registry')
  }, 120_000)
})

describe('acceptance — pending-approval counts match a SQL count exactly', () => {
  it('counts 3 pending review drafts and 5 pending SEO suggestions', async () => {
    const counted = await withSeededQueues(async (tx) => {
      const pending = await agentPendingApprovals(tx)
      const [drafts] = await tx<{ n: string }[]>`
        select count(*)::text as n
          from google_reviews
         where reply_draft is not null
           and reply_approved_text is null
           and draft_quarantine_reason is null
      `
      const [suggestions] = await tx<{ n: string }[]>`
        select count(*)::text as n from seo_suggestion where state = 'proposed'
      `
      return {
        pending,
        drafts: Number(drafts?.n ?? 0),
        suggestions: Number(suggestions?.n ?? 0),
      }
    })
    // Exactly, against the same count(*) — not against a literal, which would be a third statement of
    // the figure and would drift from whatever else the shared database holds.
    expect(counted.pending.get(REVIEW_REPLY_AGENT_KEY)).toBe(counted.drafts)
    expect(counted.pending.get(SEO_SUGGESTION_AGENT_KEY)).toBe(counted.suggestions)
    // And the fixture's own contribution, which is the acceptance line's three and five.
    expect(counted.drafts).toBeGreaterThanOrEqual(3)
    expect(counted.suggestions).toBeGreaterThanOrEqual(5)
  }, 120_000)

  it('gives an agent with no queue no number at all', async () => {
    const screen = await agentConsoleScreen(sql, { tradingDate, googleState: 'healthy' })
    const rollups = screen.rows.find((row) => row.agentKey === 'nightly_rollups')
    expect(rollups?.pending).toBeNull()
    // The control: an agent WITH a queue has one, so the null above is a shape rather than an absence of
    // data everywhere.
    const autoresponder = screen.rows.find((row) => row.agentKey === REVIEW_REPLY_AGENT_KEY)
    expect(autoresponder?.pending).not.toBeNull()
  }, 120_000)
})

describe('acceptance — cost is measured in fils against the budget', () => {
  it('sums agent_run.cost_fils for the trading date and derives the ceiling', async () => {
    const cost = await withFixtureAgent(
      {
        budgetFilsPerRun: 2_000,
        runs: [
          { costFils: 1_980, outcome: 'succeeded' },
          { costFils: 500, outcome: 'succeeded' },
        ],
      },
      async (tx, agentKey) => (await agentCosts(tx, { tradingDate })).get(agentKey),
    )
    expect(cost).toBeDefined()
    expect(cost?.spent.fils).toBe(2_480)
    expect(cost?.runs).toBe(2)
    // 2,000 per run × 2 runs. A derivation, which the screen says is one — Y13-agent-period-budget.
    expect(cost?.ceiling.fils).toBe(4_000)
    expect(cost?.share).toBe(620)
    // The worst run spent 1,980 of 2,000, which is 99% — the warning variant's own threshold.
    expect(cost?.worstRunShare).toBe(990)
  }, 120_000)

  it('has no share for an agent with a nought budget, rather than 100%', async () => {
    const cost = await withFixtureAgent(
      { budgetFilsPerRun: 0, runs: [{ costFils: 0, outcome: 'succeeded' }] },
      async (tx, agentKey) => (await agentCosts(tx, { tradingDate })).get(agentKey),
    )
    expect(cost?.share).toBeNull()
    expect(cost?.worstRunShare).toBeNull()
  }, 120_000)

  it('counts a run by its TRADING date and not by the calendar', async () => {
    // A run on a different trading date must not be in today's figure. The trading date is a column the
    // run carries, so this is a claim about the query's grouping rather than about a timestamp cast.
    const cost = await withFixtureAgent({ budgetFilsPerRun: 100 }, async (tx, agentKey) => {
      await tx`
        insert into agent_run (agent_key, started_at, finished_at, outcome, cost_fils, trading_date)
        select ${agentKey}, now(), now(), 'succeeded', 9_999, b.trading_date
          from business_day b
         where b.trading_date < ${tradingDate}::date
         order by b.trading_date desc
         limit 1
      `
      return (await agentCosts(tx, { tradingDate })).get(agentKey)
    })
    expect(cost?.runs).toBe(0)
    expect(cost?.spent.fils).toBe(0)
  }, 120_000)
})

describe('acceptance — the reason is the agent’s, and a broken connection says two things', () => {
  it('pauses the autoresponder and degrades the SEO agent under one broken connection', async () => {
    const screen = await agentConsoleScreen(sql, { tradingDate, googleState: 'broken' })
    const autoresponder = screen.rows.find((row) => row.agentKey === REVIEW_REPLY_AGENT_KEY)
    const seo = screen.rows.find((row) => row.agentKey === SEO_SUGGESTION_AGENT_KEY)
    expect(autoresponder?.reason.kind).toBe('google_paused')
    expect(seo?.reason.kind).toBe('google_degraded')
    // The control: with a healthy connection neither reason is a Google one, so the two above are the
    // STATE's answer rather than the table's unconditionally.
    const healthy = await agentConsoleScreen(sql, { tradingDate, googleState: 'healthy' })
    for (const key of [REVIEW_REPLY_AGENT_KEY, SEO_SUGGESTION_AGENT_KEY]) {
      const row = healthy.rows.find((candidate) => candidate.agentKey === key)
      expect(row?.reason.kind, key).not.toBe('google_paused')
      expect(row?.reason.kind, key).not.toBe('google_degraded')
    }
  }, 120_000)

  it('prints the agent’s own last_error for a failure', async () => {
    const reason = await withFixtureAgent(
      { consecutiveFailures: 3, lastError: 'ETIMEDOUT reading the payout file' },
      async (tx, agentKey) => {
        const screen = await agentConsoleScreen(tx, { tradingDate, googleState: 'healthy' })
        return screen.rows.find((row) => row.agentKey === agentKey)?.reason
      },
    )
    expect(reason?.kind).toBe('failing')
    expect(reason?.kind === 'failing' ? reason.text : '').toBe('ETIMEDOUT reading the payout file')
  }, 120_000)
})

describe('acceptance — the kill switch is audited and refused by role', () => {
  const request = (token: string | null, body: Record<string, string>): Request => {
    if (token === null) throw new Error('the fixture principal was minted without a session')
    return new Request('https://example.invalid/agents/kill-switch', {
      method: 'POST',
      headers: {
        cookie: `${ADMIN_SESSION_COOKIE}=${token}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body).toString(),
    })
  }

  const auditCount = async (): Promise<number> => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = 'agent_kill_switch.set'
    `
    return Number(row?.n ?? 0)
  }

  it('writes an audit row naming the actor and the agent, and moves the switch', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'owner' })
    try {
      const before = await auditCount()
      const response = await POST(
        request(principal.sessionToken, {
          [KILL_SWITCH_FIELDS.agentKey]: 'nightly_rollups',
          [KILL_SWITCH_FIELDS.desired]: 'on',
        }),
      )
      expect(response.status).toBe(303)
      expect(await auditCount()).toBe(before + 1)
      const [row] = await sql<
        { actorId: string; entityId: string; operation: string; after: unknown }[]
      >`
        select actor_id::text as "actorId", entity_id as "entityId", operation, after_state as after
          from audit_event
         where action = 'agent_kill_switch.set'
         order by occurred_at desc, id desc
         limit 1
      `
      expect(row?.actorId).toBe(principal.employeeId)
      expect(row?.entityId).toBe('nightly_rollups')
      expect(row?.operation).toBe('update')
      expect(row?.after).toMatchObject({ role: 'owner' as const, desired: 'on' })
      const [agent] = await sql<{ killSwitch: boolean }[]>`
        select kill_switch as "killSwitch" from agent_definition where agent_key = 'nightly_rollups'
      `
      expect(agent?.killSwitch).toBe(true)
    } finally {
      // Put it back, because this one is committed: the route opens its own connection, so there is no
      // transaction to roll back. `desired` being a STATE rather than a toggle is what makes this safe.
      await sql`update agent_definition set kill_switch = false where agent_key = 'nightly_rollups'`
      await principal.cleanup()
    }
  }, 120_000)

  it('is idempotent, because the body carries a state and not a flip', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'owner' })
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await POST(
          request(principal.sessionToken, {
            [KILL_SWITCH_FIELDS.agentKey]: 'nightly_rollups',
            [KILL_SWITCH_FIELDS.desired]: 'on',
          }),
        )
        expect(response.status).toBe(303)
      }
      const [agent] = await sql<{ killSwitch: boolean }[]>`
        select kill_switch as "killSwitch" from agent_definition where agent_key = 'nightly_rollups'
      `
      // A toggle would have put it back. Two operators on the console at once is the ordinary case.
      expect(agent?.killSwitch).toBe(true)
    } finally {
      await sql`update agent_definition set kill_switch = false where agent_key = 'nightly_rollups'`
      await principal.cleanup()
    }
  }, 120_000)

  it('refuses a receptionist, records the refusal, and changes nothing', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'receptionist' })
    try {
      const before = await auditCount()
      const response = await POST(
        request(principal.sessionToken, {
          [KILL_SWITCH_FIELDS.agentKey]: 'nightly_rollups',
          [KILL_SWITCH_FIELDS.desired]: 'on',
        }),
      )
      expect(response.status).toBe(403)
      expect(await response.text()).toContain(AGENTS_TOGGLE_PERMISSION)
      // A DELTA, because `audit_event` is append-only (ADR 0008): a total would pass on a fresh database
      // and fail on the second run of this file.
      expect(await auditCount()).toBe(before + 1)
      const [row] = await sql<{ operation: string }[]>`
        select operation from audit_event
         where action = 'agent_kill_switch.set'
         order by occurred_at desc, id desc limit 1
      `
      expect(row?.operation).toBe('denied')
      const [agent] = await sql<{ killSwitch: boolean }[]>`
        select kill_switch as "killSwitch" from agent_definition where agent_key = 'nightly_rollups'
      `
      expect(agent?.killSwitch).toBe(false)
    } finally {
      await principal.cleanup()
    }
  }, 120_000)

  it('refuses an agent the registry does not hold, and writes nothing about it', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'owner' })
    try {
      const before = await auditCount()
      const response = await POST(
        request(principal.sessionToken, {
          [KILL_SWITCH_FIELDS.agentKey]: 'no_such_agent',
          [KILL_SWITCH_FIELDS.desired]: 'on',
        }),
      )
      expect(response.status).toBe(404)
      // No audit row about an agent that does not exist, which is why the existence check precedes the
      // write rather than relying on an UPDATE that matches nothing.
      expect(await auditCount()).toBe(before)
    } finally {
      await principal.cleanup()
    }
  }, 120_000)

  it('redirects a sessionless POST and refuses a body that is not form-encoded', async () => {
    const anonymous = await POST(
      new Request('https://example.invalid/agents/kill-switch', { method: 'POST', body: '' }),
    )
    expect(anonymous.status).toBe(303)
    const principal = await createFixturePrincipal(sql, { role: 'owner' })
    try {
      const malformed = await POST(
        new Request('https://example.invalid/agents/kill-switch', {
          method: 'POST',
          headers: {
            cookie: `${ADMIN_SESSION_COOKIE}=${principal.sessionToken ?? ''}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ agent: 'nightly_rollups', desired: 'on' }),
        }),
      )
      expect(malformed.status).toBe(400)
      expect(await malformed.text()).toContain('desired state and never a toggle')
    } finally {
      await principal.cleanup()
    }
  }, 120_000)
})

describe('acceptance — the console answers, with noindex, and refuses a role without report:read', () => {
  it('serves the document to an owner', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'owner' })
    try {
      const response = await GET(
        new Request('https://example.invalid/agents', {
          headers: { cookie: `${ADMIN_SESSION_COOKIE}=${principal.sessionToken ?? ''}` },
        }),
      )
      expect(response.status).toBe(200)
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
      const html = await response.text()
      expect(html).toContain('data-agent-count=')
      expect(html).toContain('<form method="post"')
      expect(html).not.toContain('An error occurred')
    } finally {
      await principal.cleanup()
    }
  }, 120_000)

  it('renders no kill-switch control for a role that may read and not toggle', async () => {
    // The accountant holds `report:read` and not `agent:configure`, which is the pair that makes the
    // two permissions a real distinction rather than one check written twice.
    const principal = await createFixturePrincipal(sql, { role: 'accountant' })
    try {
      const response = await GET(
        new Request('https://example.invalid/agents', {
          headers: { cookie: `${ADMIN_SESSION_COOKIE}=${principal.sessionToken ?? ''}` },
        }),
      )
      expect(response.status).toBe(200)
      const html = await response.text()
      expect(html).not.toContain('<form method="post"')
      expect(html).toContain('needs the agent:configure permission')
    } finally {
      await principal.cleanup()
    }
  }, 120_000)

  it('answers 403 to a therapist, who holds neither permission', async () => {
    const principal = await createFixturePrincipal(sql, { role: 'therapist' })
    try {
      const response = await GET(
        new Request('https://example.invalid/agents', {
          headers: { cookie: `${ADMIN_SESSION_COOKIE}=${principal.sessionToken ?? ''}` },
        }),
      )
      expect(response.status).toBe(403)
    } finally {
      await principal.cleanup()
    }
  }, 120_000)
})

describe('acceptance — the settlement alert H-HARD-05 deferred', () => {
  it('observes a batch that does not tie, and nothing when every batch ties', async () => {
    const entry = alertDefinition('unreconciled_settlement_batch')
    expect(entry.threshold.kind).toBe('structural')
    expect(entry.threshold.kind === 'structural' ? entry.threshold.value : 0).toBe(1)

    const before = await ALERT_OBSERVERS.unreconciled_settlement_batch(sql, {
      nowIso: new Date(FIXTURE_NOW).toISOString(),
      tradingDate,
    })

    const after = await withQuarantinedBatch(
      async (tx) =>
        await ALERT_OBSERVERS.unreconciled_settlement_batch(tx, {
          nowIso: new Date(FIXTURE_NOW).toISOString(),
          tradingDate,
        }),
    )
    // A DELTA, because the shared database may already hold one.
    expect(after.observed).toBe(before.observed + 1)
    expect(after.incidentKey).not.toBe('none')
    // The incident key is the OLDEST untied batch's id, so it is stable while that batch is untied —
    // which is what makes the notification idempotent across passes.
    expect(after.detail['batches']).toBeDefined()
    expect(after.detail['quarantinedIntentExceptions']).toBeDefined()
  }, 120_000)
})

describe('acceptance — axe, and a pixel diff of zero on a second run', () => {
  beforeAll(async () => {
    const whole = await agentConsoleScreen(sql, { tradingDate, googleState: 'broken' })
    /*
      A representative SUBSET and not all thirty-two rows, and the reason is a limit rather than a
      preference: `createCaptureHarness` screenshots `fullPage`, thirty-two cards is about 13,000 CSS
      pixels, and at `deviceScaleFactor: 2` that is past Chromium's own texture limit — the first run of
      this file failed with `Unable to capture screenshot`, which names neither the height nor the scale.
      Six rows is also the better specimen: the matrix is about the LAYOUT in two directions and two
      themes, and twenty-six more identical cards test the same CSS twenty-six more times.
      `data-agent-count` is what the row-count claim is asserted on, and that is a different case against
      the whole screen.
    */
    const screen = { ...whole, rows: whole.rows.slice(0, 6) }
    expect(screen.rows.length).toBeGreaterThan(3)
    const source = {
      name: 'agent-console',
      html: (options: { direction: 'ltr' | 'rtl'; theme: 'light' | 'dark' }) =>
        renderAgentConsoleHtml({
          chrome: {
            googleReauth: null,
            sendBacklog: null,
            role: 'owner' as const,
            returnTo: '/agents',
          },
          screen,
          mayToggle: true,
          direction: options.direction,
        }),
    }
    harness = await createCaptureHarness({ nowMs: FIXTURE_NOW })
    captures = await harness.capture(source)
    recaptures = await harness.capture(source)
  }, 300_000)

  it('captures three viewports, two themes and two directions', () => {
    expect(captures).toHaveLength(VIEWPORTS.length * THEMES.length * DIRECTIONS.length)
    expect(captures).toHaveLength(12)
  })

  it('reports no serious or critical violation in any cell', () => {
    expect(
      captures.flatMap((capture) => blockingViolations(capture.violations)).map(describeViolation),
    ).toEqual([])
  })

  it('produces byte-identical images on an unchanged rerun', () => {
    expect(recaptures.map((capture) => hash(capture.png))).toEqual(
      captures.map((capture) => hash(capture.png)),
    )
  })

  it('renders every cell differently, so no axis of the matrix is decorative', () => {
    const hashes = captures.map((capture) => hash(capture.png))
    expect(new Set(hashes).size).toBe(hashes.length)
  })
})

/**
 * Three pending review drafts and five pending SEO suggestions, rolled back.
 *
 * The rows are built on the seed's own connection and listing, because `google_reviews.connection_id` is
 * `ON DELETE RESTRICT` and inventing a connection would be a row later suites read. `seo_suggestion`
 * needs a page and two content digests, which are `sha256` by CHECK — so they are computed rather than
 * typed, and a typed digest of the wrong length would be refused by the database.
 */
async function withSeededQueues<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  const sentinel = `G-AGT-02 rolled this queue fixture back ${randomUUID()}`
  const digest = (seed: string): string => createHash('sha256').update(seed).digest('hex')
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Sql
      /*
        The connection is CREATED here and not looked up: nothing is seeded into `google_connections`,
        and the first version of this fixture selected from a table whose name it had guessed. Created
        rather than reused for a second reason even when one exists — `with-google.itest.ts` records it
        from the other side: `resolveTarget` scans every connection serving a capability and orders by
        id, so a fixture that attached rows to somebody else's connection would change which one sorts
        first for every suite in the run.

        The token columns are a stand-in rather than a credential: `ciphertext-stand-in` is not a wrapped
        key and nothing can be signed in with it, which `scripts/check-secrets.mjs` is entitled to ask
        about. The whole row is rolled back.
      */
      const stand = Buffer.from('ciphertext-stand-in')
      const [connection] = await tx<{ id: string }[]>`
        insert into google_connections
          (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
           refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
        values (${`${sentinel}-sub`}, 'owner@example.invalid',
                ${tx.array(['https://www.googleapis.com/auth/business.manage'] as never)},
                ${stand}, ${stand}, ${stand}, 'v1', 'fp-stand-in')
        returning id::text as id
      `
      if (connection === undefined) {
        throw new Error('inserting a fixture google connection returned no row')
      }
      const placeId = `${sentinel}-place`
      /*
        The capability row, and it is not optional: a trigger refuses a `google_reviews` row whose
        `place_id` is not a `gbp_reviews` resource of its connection — "is not a gbp_reviews resource of
        connection …", which is what the first run of this fixture was told. The listing a review belongs
        to is a fact about the connection rather than a string on the review, which is the same rule
        `listReviewQueue` records from the other side: a queue scoped by connection alone would return
        another listing's reviews and have the owner replying as the wrong business.
      */
      await tx`
        insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary)
        values (${connection.id}::uuid, 'gbp_reviews', ${tx.json({ placeId } as never)}, 'ok', true)
      `
      /*
        A LABEL and not a name. Brief rule 10: no invented names of people, and synthetic.ts labels a
        customer "Customer 0042" for exactly this reason. `reviewer_display_name` is NOT NULL, so the
        column has to carry something and a plausible one would be a person this business does not have.

        It is a JS comment and not an SQL one inside the template below, which is where the first version
        put it: the sentence contained backticks, they terminated the template literal, and the failure
        was four parse errors naming an octal literal.
      */
      const reviewerLabel = (n: number): string => `Customer ${String(n + 1).padStart(4, '0')}`
      /*
`escalate`, which is both what the schema permits here and what this fixture actually represents.

        The vocabulary is two words — `google_reviews_routing_verdict_known` names `auto_send` and
        `escalate` — and `google_reviews_autosend_needs_api_delivery` refuses `auto_send` on a review
        whose `delivery_mode` is `manual`. That constraint is right and it caught a fixture that was
        wrong about its own subject: a drafted reply WAITING FOR A PERSON is the escalate path by
        definition, and a row claiming `auto_send` would have been a row the console counted as pending
        while the schema said it was going out by itself.

        The routing columns are a biconditional too, for the provenance columns' reason below: a verdict
        with no rule and no lexicon version cannot be audited.

        Both of these are JS comments. An SQL comment inside the template literal below is how the first
        two versions of this fixture failed — twice, with the same defect: the sentences contained
        backticks, which terminated the literal, and the failure was a parse error pointing at a column
        in the middle of a comment.
      */
      /*
        Every provenance column together, which `google_reviews_draft_provenance_together` requires as a
        biconditional: a draft either carries the skeleton, the aspects, the language, the prompt version,
        the fingerprint and the instant, or it carries none of them. The constraint is G-REV's and the
        reason it is a biconditional rather than six nullable columns is that a draft whose provenance is
        half recorded cannot be audited — which is what the first run of this fixture produced.
      */
      for (let n = 0; n < 3; n += 1) {
        await tx`
          insert into google_reviews
            (connection_id, place_id, google_review_id, source, delivery_mode, rating, comment_text,
             reviewer_display_name, reviewed_at, reply_draft, reply_draft_skeleton_id,
             reply_draft_aspects, reply_draft_language, reply_draft_prompt_version,
             reply_draft_prompt_fingerprint, reply_draft_generated_at, routing_verdict,
             routing_rule_id, routing_lexicon_version, routed_at)
          values (${connection.id}::uuid, ${placeId},
                  ${`${sentinel}-review-${n}`}, 'paste', 'manual', 5,
                  'A fixture review, so a drafted reply has something to be about.',
                  ${reviewerLabel(n)},
                  now() - interval '2 days', 'A fixture draft awaiting approval.',
                  'fixture-skeleton', ${tx.array(['cleanliness'] as never)}, 'en',
                  'fixture-1', 'fixture-fingerprint', now(),
                  'escalate', 'fixture-rule', 'fixture-lexicon-1', now())
        `
      }
      /*
        A suggestion belongs to an `agent_run` — `seo_suggestion.run_id` is a foreign key to it — so the
        fixture creates the run as well. That is the shape rather than an inconvenience: a proposal with
        no run is a proposal nothing accounted for, and the run carries the tokens and the cost the
        proposal was produced at, which is the same figure the console's money column reads.

        The digests are COMPUTED and must differ from each other (`seo_suggestion_changes_something`) and
        be 64 hex characters (`..._is_sha256`). `lint_terms_checked` must be positive — a suggestion
        nothing linted is not a suggestion — and the provider and lint version are refused by
        `is_placeholder_text`, so neither may be a stand-in.

        The `rollback_descriptor` is a CLAIM and not a blob: ZY401 requires `method: publication_revert`
        and a `surface` equal to this row's, which is what makes "rollback is exact" a database fact. A
        descriptor that said nothing would be a rollback nobody can perform, discovered at the moment
        somebody needs it — and the first version of this fixture wrote one, which the trigger named.
      */
      const [run] = await tx<{ runId: string }[]>`
        insert into agent_run (agent_key, started_at, finished_at, outcome, cost_fils, trading_date)
        values (${SEO_SUGGESTION_AGENT_KEY}, now() - interval '1 minute', now(), 'succeeded', 0,
                ${tradingDate}::date)
        returning run_id::text as "runId"
      `
      if (run === undefined) throw new Error('inserting a fixture agent run returned no row')
      for (let n = 0; n < 5; n += 1) {
        await tx`
          insert into seo_suggestion
            (run_id, surface, state, proposed_at, before_regions, before_content_sha256,
             after_regions, after_content_sha256, rollback_descriptor, lint_version,
             lint_terms_checked, llm_provider, input_tokens, output_tokens, cost_fils)
          values (${run.runId}::uuid, ${`/fixture-${n}`}, 'proposed', now(),
                  ${tx.json([{ region: 'meta_description', text: 'before' }] as never)},
                  ${digest(`${sentinel}-before-${n}`)},
                  ${tx.json([{ region: 'meta_description', text: 'after' }] as never)},
                  ${digest(`${sentinel}-after-${n}`)},
                  ${tx.json({ method: 'publication_revert', surface: `/fixture-${n}` } as never)},
                  'lint-fixture-1', 1, 'fixture-provider', 10, 20, 0)
        `
      }
      carried = await body(tx)
      throw new Error(sentinel)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== sentinel) throw error
  }
  if (carried === undefined) throw new Error('the queue fixture body returned nothing')
  return carried
}

/** One quarantined settlement batch with a variance, rolled back. */
async function withQuarantinedBatch<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  const sentinel = `G-AGT-02 rolled this settlement fixture back ${randomUUID()}`
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Sql
      const [batch] = await tx<{ id: string }[]>`
        insert into settlement_batch
          (id, batch_reference, content_sha256, settled_on, declared_net_fils, lines_net_fils, state,
           journal_entry_id, imported_at)
        values (uuid_generate_v7(), ${`FIXTURE-${randomUUID().slice(0, 8)}`},
                ${createHash('sha256').update(sentinel).digest('hex')},
                ${tradingDate}::date, 100000, 99000, 'quarantined', null, now())
        returning id::text as id
      `
      if (batch === undefined)
        throw new Error('inserting a fixture settlement batch returned no row')
      await tx`
        insert into settlement_variance
          (id, batch_id, settlement_line_id, kind, file_fils, local_fils, difference_fils, explanation,
           created_at)
        values (uuid_generate_v7(), ${batch.id}::uuid, null, 'unattributable', 100000, 99000, 1000,
                'A fixture difference belonging to no line.', now())
      `
      carried = await body(tx)
      throw new Error(sentinel)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== sentinel) throw error
  }
  if (carried === undefined) throw new Error('the settlement fixture body returned nothing')
  return carried
}
