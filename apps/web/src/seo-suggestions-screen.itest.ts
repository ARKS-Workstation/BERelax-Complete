import { randomUUID } from 'node:crypto'
import { publicationCanonicalContent, SEO_SUGGESTION_LINT_VERSION } from '@berelax/core'
import {
  approveSeoSuggestion,
  createConnection,
  insertSeoSuggestion,
  publicationContentHash,
  publishSurface,
  recordApproval,
  recordDraft,
  recordLintPass,
  type SeoSuggestionRow,
  type Sql,
  type SuggestionRegion,
  seoSuggestionById,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  handleSeoSuggestionsRead,
  handleSeoSuggestionsWrite,
  type SuggestionsPrincipal,
} from '../app/(admin)/agents/seo/suggestions/handler.ts'
import {
  SEO_SUGGESTIONS_FIELDS,
  SEO_SUGGESTIONS_PATH,
} from '../app/(admin)/agents/seo/suggestions/view.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * The suggestions screen's decisions, driven directly with a frozen clock (G-SEO-05).
 *
 * The handler and not the route, for the reason every other admin screen gives: the route is the
 * connection, the session, the clock and the two verbs, and the decisions are what need a chosen instant.
 * `apps/web/src/admin-guard.test.ts` is what proves the route is behind a session, and
 * `routes/registry.test.ts` is what proves it is declared and noindex — neither is re-asserted here.
 *
 * Isolation: every surface carries a per-run suffix, so no assertion is a total over a shared table.
 * Nothing is deleted — `seo_suggestion` refuses it (`ZY402`) and so do the publication tables.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

let sql: Sql
const RUN = randomUUID().slice(0, 8)
const surfaceFor = (name: string): string => `pages/g-seo-05-screen-${name}-${RUN}`
const AT = new Date('2026-03-01T10:00:00.000Z')
const BUDGET = 250 * 1024
const MEASURED = 120 * 1024

/** No banner: the connection needs no re-auth in this fixture, and the chrome is the caller's input. */
const CHROME: AdminChrome = { googleReauth: null, returnTo: SEO_SUGGESTIONS_PATH }

const OWNER: SuggestionsPrincipal = {
  // A uuid, because `publication_approval.approver_user_id` records `employee.id`.
  id: '00000000-0000-7000-8000-00000000f001',
  // The employment record's handle. An audit label that names no person (ADR 0020, brief rule 10).
  staffReference: 'Employee 0007',
  role: 'owner',
}
const RECEPTIONIST: SuggestionsPrincipal = { ...OWNER, role: 'receptionist' }

const BEFORE: readonly SuggestionRegion[] = Object.freeze([
  { region: 'title', text: 'Deep Tissue' },
])
const AFTER: readonly SuggestionRegion[] = Object.freeze([
  { region: 'title', text: 'Deep tissue massage in Al Zahiyah — 60 or 90 minutes' },
])

const sha = async (regions: readonly SuggestionRegion[]): Promise<string> =>
  await publicationContentHash(sql, publicationCanonicalContent([...regions]))

async function freshRunId(): Promise<string> {
  const [row] = await sql<{ runId: string }[]>`
    insert into agent_run (agent_key, started_at, finished_at, outcome, cost_fils)
    values ('seo_agent', ${AT}, ${AT}, 'succeeded', 0) returning run_id as "runId"
  `
  if (row === undefined) throw new Error('agent_run insert returned no row')
  return row.runId
}

async function publishLive(surface: string, regions: readonly SuggestionRegion[]): Promise<void> {
  const contentSha256 = await sha(regions)
  await recordDraft(sql, {
    surface,
    contentSha256,
    recordedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Employee 0007',
  })
  const lint = await recordLintPass(sql, {
    surface,
    contentSha256,
    termsChecked: 12,
    lintedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Employee 0007',
  })
  const approval = await recordApproval(sql, {
    surface,
    lintPassId: lint.lintPassId,
    contentSha256,
    approverUserId: OWNER.id,
    approverDisplayName: OWNER.staffReference,
    approverRole: 'owner',
    approvedAt: AT,
  })
  await publishSurface(sql, {
    surface,
    lintPassId: lint.lintPassId,
    approvalId: approval.approvalId,
    contentSha256,
    measuredCriticalPathBytes: MEASURED,
    criticalPathBudgetBytes: BUDGET,
    recordedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Employee 0007',
  })
}

async function storeProposed(surface: string): Promise<SeoSuggestionRow> {
  return await insertSeoSuggestion(sql, {
    runId: await freshRunId(),
    surface,
    state: 'proposed',
    beforeRegions: BEFORE,
    beforeContentSha256: await sha(BEFORE),
    afterRegions: AFTER,
    afterContentSha256: await sha(AFTER),
    lintVersion: SEO_SUGGESTION_LINT_VERSION,
    lintTermsChecked: 12,
    refusedRules: [],
    llmProvider: 'deepseek',
    inputTokens: 900,
    outputTokens: 60,
    costFils: 3,
    proposedAt: AT,
  })
}

const deps = () => ({ sql, now: () => AT })

const post = async (principal: SuggestionsPrincipal, body: Record<string, string>) =>
  await handleSeoSuggestionsWrite(
    {
      searchParams: new URLSearchParams(),
      body: new URLSearchParams(body),
      principal,
      chrome: CHROME,
    },
    deps(),
  )

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('the suggestions queue', () => {
  it('renders the diff, the lint version and the cost, and says what it is acting as', async () => {
    const surface = surfaceFor('read')
    await storeProposed(surface)
    const response = await handleSeoSuggestionsRead(
      { searchParams: new URLSearchParams(), body: null, principal: OWNER, chrome: CHROME },
      deps(),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // A publishing queue must never be cached: a stale copy would offer an Apply button for a decision
    // somebody else has already taken.
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
    const html = await response.text()
    expect(html).toContain(surface)
    expect(html).toContain('Deep tissue massage in Al Zahiyah')
    expect(html).toContain(SEO_SUGGESTION_LINT_VERSION)
    // The audit label, which is the employment handle and never a person's name (ADR 0020).
    expect(html).toContain('Employee 0007')
    // The Approve button is offered, which is what makes the role refusal below a measurement rather
    // than a coincidence.
    expect(html).toContain('>Approve<')
  })

  it('offers no action to a role that does not hold content:publish', async () => {
    const surface = surfaceFor('greyed')
    await storeProposed(surface)
    const response = await handleSeoSuggestionsRead(
      { searchParams: new URLSearchParams(), body: null, principal: RECEPTIONIST, chrome: CHROME },
      deps(),
    )
    const html = await response.text()
    expect(html).toContain(surface)
    // The queue is still readable — the refusal is about publishing, not about looking — and no button
    // is offered. The screen is greyed from the SAME predicate the POST refuses on.
    expect(html).not.toContain('>Approve<')
  })

  it('refuses the POST from that role, by name', async () => {
    const row = await storeProposed(surfaceFor('forbidden'))
    const response = await post(RECEPTIONIST, {
      [SEO_SUGGESTIONS_FIELDS.suggestion]: row.id,
      [SEO_SUGGESTIONS_FIELDS.action]: 'approve',
    })
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('forbidden')
    // And nothing moved. A refusal that threw after acting would satisfy "it refused" and nothing else.
    expect((await seoSuggestionById(sql, row.id))?.state).toBe('proposed')
  })

  it('approves, applies and rolls back in one POST each, answering 303', async () => {
    const surface = surfaceFor('round-trip')
    await publishLive(surface, BEFORE)
    const row = await storeProposed(surface)
    const before = row.beforeContentSha256

    const approved = await post(OWNER, {
      [SEO_SUGGESTIONS_FIELDS.suggestion]: row.id,
      [SEO_SUGGESTIONS_FIELDS.action]: 'approve',
    })
    expect(approved.status).toBe(303)
    expect(approved.headers.get('location')).toBe(`${SEO_SUGGESTIONS_PATH}?done=approve`)

    const applied = await post(OWNER, {
      [SEO_SUGGESTIONS_FIELDS.suggestion]: row.id,
      [SEO_SUGGESTIONS_FIELDS.action]: 'apply',
    })
    expect(applied.status).toBe(303)
    const [liveAfterApply] = await sql<{ contentSha256: string }[]>`
      select content_sha256 as "contentSha256" from publication_record
       where surface = ${surface} order by seq desc limit 1
    `
    expect(liveAfterApply?.contentSha256).toBe(row.afterContentSha256)

    const rolledBack = await post(OWNER, {
      [SEO_SUGGESTIONS_FIELDS.suggestion]: row.id,
      [SEO_SUGGESTIONS_FIELDS.action]: 'rollback',
    })
    expect(rolledBack.status).toBe(303)
    const [liveNow] = await sql<{ contentSha256: string }[]>`
      select content_sha256 as "contentSha256" from publication_record
       where surface = ${surface} order by seq desc limit 1
    `
    // Byte-for-byte, through the screen rather than through the service functions.
    expect(liveNow?.contentSha256).toBe(before)
    expect((await seoSuggestionById(sql, row.id))?.state).toBe('rolled_back')
  }, 30_000)

  it('refuses an apply whose stored before-state is no longer live, with a sentence an operator can act on', async () => {
    const surface = surfaceFor('stale')
    await publishLive(surface, AFTER)
    const row = await storeProposed(surface)
    await approveSeoSuggestion(sql, row.id)
    const response = await post(OWNER, {
      [SEO_SUGGESTIONS_FIELDS.suggestion]: row.id,
      [SEO_SUGGESTIONS_FIELDS.action]: 'apply',
    })
    expect(response.status).toBe(409)
    const html = await response.text()
    expect(html).toContain('before_state_is_not_live')
    expect(html).toContain('Re-run the pass')
  })

  it('refuses an unknown action and an unknown suggestion by name', async () => {
    const row = await storeProposed(surfaceFor('absent-id'))
    const badAction = await post(OWNER, {
      [SEO_SUGGESTIONS_FIELDS.suggestion]: row.id,
      [SEO_SUGGESTIONS_FIELDS.action]: 'publish',
    })
    expect(badAction.status).toBe(400)
    expect(await badAction.text()).toContain('unknown_action')
    const badId = await post(OWNER, {
      [SEO_SUGGESTIONS_FIELDS.suggestion]: '00000000-0000-7000-8000-0000000000ff',
      [SEO_SUGGESTIONS_FIELDS.action]: 'approve',
    })
    expect(badId.status).toBe(404)
    expect(await badId.text()).toContain('unknown_suggestion')
  })

  it('ignores the query string entirely for the decision', async () => {
    /*
     * W-SYS-11: a query parameter may never choose a principal, a role or a permission, and a
     * repository-wide scan refuses one. This is the behavioural half: a `?role=owner` on a receptionist's
     * request changes nothing, and `?suggestion=` is not read at all.
     */
    const row = await storeProposed(surfaceFor('query'))
    const response = await handleSeoSuggestionsWrite(
      {
        searchParams: new URLSearchParams({ role: 'owner', suggestion: row.id, action: 'approve' }),
        body: new URLSearchParams(),
        principal: RECEPTIONIST,
        chrome: CHROME,
      },
      deps(),
    )
    // The empty BODY is what it answers about, not the fully-populated query string.
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('unreadable_request')
    expect((await seoSuggestionById(sql, row.id))?.state).toBe('proposed')
  })
})
