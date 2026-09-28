import { randomUUID } from 'node:crypto'
import {
  agentPrincipal,
  publicationCanonicalContent,
  publicationWeightRefusals,
  resolvedPermissionsOf,
  SEO_AGENT_PRINCIPAL,
  staffPrincipal,
} from '@berelax/core'
import { createConnection, readCompliancePolicy, type Sql } from '@berelax/db'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { getPayload, type Payload } from 'payload'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import config from '../payload.config.ts'
import { homeBudgetLimit } from './home/budget.ts'
import {
  assessPublication,
  criticalResourcesIn,
  documentBytes,
  measureCriticalPath,
  PUBLICATION_ENDPOINT,
} from './publication/publish-gate.ts'

/**
 * W-SITE-10 — the publish endpoint, driven against the built application.
 *
 * Three of this unit's acceptance lines are claims about an HTTP response and cannot be checked anywhere
 * else:
 *
 *   - *"an explicit publish attempt with that credential returns 403 — a permission-layer denial, not a
 *     prompt refusal"*. A policy test proves the SEO agent's grant set; only a request proves the endpoint
 *     consults it. The set assertion is made here as well, because a 403 from an endpoint that refuses
 *     everybody would satisfy the request half on its own.
 *   - *"a known-bad page fails the publish gate by rule name"* (ADR 0003). The rule names are in the 422
 *     body, and a caller branches on them rather than on a sentence.
 *   - *"measures rendered critical-path weight … and refuses an over-budget page with the measured
 *     number"*. The measurement is of a document this server rendered, and the figure the response carries
 *     is the figure the database row then stores.
 *
 * ## Why the oversized fixture is a lowered budget over a REAL page, and not a fabricated measurement
 *
 * `apps/web/src/home.itest.ts` settled this and records the argument: it measures the running application,
 * asserts it is inside the real limits, and then re-judges *the same measurement* against lowered ones —
 * *"so the failure it proves carries the bytes and nodes the page actually has. Feeding a made-up
 * measurement to the real limits would prove the arithmetic and not the wiring, and the wiring is what
 * silently stops working."* The same shape is used here, against the same `publicationWeightRefusals` the
 * endpoint calls, so the refusal this file proves carries this application's real critical-path weight.
 *
 * The endpoint itself takes its budget from `homeBudgetLimit('critical-above-fold')` and from nowhere else,
 * which is asserted directly against the response body: no env var lowers it, no request field overrides it,
 * and there is no development bypass to assert the absence of.
 *
 * ## Isolation
 *
 * Every surface carries a per-run suffix and every account a per-run email, so nothing here asserts a total
 * over a shared table (CONTRIBUTING-AGENT-BRIEF §12). The `cms_user` rows are deleted in `afterAll`; the
 * three publication tables refuse DELETE for every role, which is the property under test, so their rows
 * stay — a few per run, under surfaces nothing else reads.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * Assigned in `beforeAll`, because the port is ACQUIRED rather than drawn: `startWebServer` binds a
 * candidate from this suite's band and draws again if another worktree holds it. Computing the origin at
 * module scope is what made a collision present as `next start exited with 1` with the reason discarded.
 */
let BASE = ''
let server: WebServer
let payload: Payload
let sql: Sql

const RUN = randomUUID().slice(0, 8)
const PASSWORD = 'a-long-enough-test-password'
/** The approver's display name. A label, in the shape `Therapist 07` uses — never a plausible person. */
const APPROVER = 'Approver 01'
const surfaceFor = (name: string): string => `pages/w-site-10-http-${name}-${RUN}`

/** The route whose document is weighed. `/` is the only one guaranteed to exist in every build. */
const PAGE = '/'

/** Copy that passes the lint. Every refusal case below starts here and changes one thing. */
const CLEAN = [
  { region: 'title', text: 'What to expect on a first visit' },
  { region: 'body', text: 'The desk takes your booking and shows you to the room.' },
]

/** A page a licensed spa may not publish. Two rules, in two regions, so the body names both. */
const KNOWN_BAD = [
  { region: 'title', text: 'How massage cures sciatica' },
  { region: 'body', text: 'Visit our clinic and ask the doctor which oil suits you.' },
]

interface PublishResponse {
  readonly status: number
  readonly body: Record<string, unknown>
}

async function post(body: unknown, cookie?: string): Promise<PublishResponse> {
  const response = await fetch(`${BASE}${PUBLICATION_ENDPOINT}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const request = (
  surface: string,
  regions: readonly { readonly region: string; readonly text: string }[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  surface,
  path: PAGE,
  regions,
  approverDisplayName: APPROVER,
  ...extra,
})

/** Signs in over HTTP and returns the session cookie, so the route sees Payload's own session. */
async function signIn(role: string): Promise<string> {
  const email = `wsite10-${role}-${RUN}@berelax.test`
  await payload.delete({ collection: 'cms_user', where: { email: { equals: email } } })
  await payload.create({
    collection: 'cms_user',
    data: { email, password: PASSWORD, role },
    overrideAccess: true,
  })
  const response = await fetch(`${BASE}/cms-api/cms_user/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!response.ok) throw new Error(`login for ${role} answered ${response.status}`)
  const body = (await response.json()) as { readonly token?: string }
  if (typeof body.token !== 'string') throw new Error(`login for ${role} returned no token`)
  return `payload-token=${body.token}`
}

const cookies = new Map<string, string>()

beforeAll(async () => {
  payload = await getPayload({ config })
  sql = createConnection({ url, max: 4 })
  server = await startWebServer({
    suite: 'publication',
    cwd: new URL('..', import.meta.url).pathname,
    readyWithinMs: 120_000,
    env: {
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
      MEDIA_STORAGE: 'fake',
      // The same secret the in-process Payload above signs the session with. Without it the spawned server
      // rejects every cookie this file presents and every assertion reads as a 401.
      PAYLOAD_SECRET:
        process.env['PAYLOAD_SECRET'] ?? 'berelax-placeholder-payload-secret-not-for-serving',
    },
  })
  BASE = server.origin
  for (const role of ['owner', 'manager', 'marketer']) {
    cookies.set(role, await signIn(role))
  }
}, 300_000)

afterAll(async () => {
  for (const role of ['owner', 'manager', 'marketer']) {
    await payload?.delete?.({
      collection: 'cms_user',
      where: { email: { equals: `wsite10-${role}-${RUN}@berelax.test` } },
    })
  }
  await payload?.destroy?.()
  await sql?.end({ timeout: 5 })
  await server?.stop()
})

// ------------------------------------------------------------------------------------------------

describe('acceptance — the SEO agent is refused at the permission layer', () => {
  it('holds no publish permission in its resolved grant set', () => {
    // The set assertion, enumerated. Made here as well as in `seo-agent.policy.test.ts` because a 403 from
    // an endpoint that refuses everybody would satisfy the request half below on its own, and this is the
    // half that says the denial is about a capability rather than about the endpoint being shut.
    const agent = agentPrincipal(SEO_AGENT_PRINCIPAL)
    expect(agent).not.toBeNull()
    if (agent === null) return
    expect([...resolvedPermissionsOf(agent)].sort()).toEqual([
      'catalogue:read',
      'report:read',
      'seo_suggestion:propose',
    ])
    expect(resolvedPermissionsOf(agent)).not.toContain('content:publish')
    expect(resolvedPermissionsOf(staffPrincipal('owner'))).toContain('content:publish')
  })

  it('returns 403 for an explicit publish attempt with that credential', async () => {
    const refused = await post(
      request(surfaceFor('seo-agent'), CLEAN, { principal: SEO_AGENT_PRINCIPAL }),
    )
    expect(refused.status).toBe(403)
    expect(refused.body['error']).toBe('forbidden')
    // The permission is named, so the refusal is traceable to the matrix rather than to a branch in the
    // route — and a reworded message is not a reworded rule.
    expect(refused.body['permission']).toBe('content:publish')
    expect(String(refused.body['principal'])).toContain(SEO_AGENT_PRINCIPAL)
    // Nothing was written. A 403 that had already published would be the worst outcome available.
    const [rows] = await sql<{ n: number }[]>`
      select count(*)::int as n from publication_record where surface = ${surfaceFor('seo-agent')}
    `
    expect(rows?.n).toBe(0)
  }, 60_000)

  it('refuses a marketer too, and by the same permission — the denial is not about agents', async () => {
    // `content:publish` is the owner's alone in the F07 matrix (`packages/cms/src/access.ts` says so), and
    // a marketer holds `content:write`. Asserting it here is what stops the case above being read as a
    // special rule about agent principals.
    const refused = await post(
      request(surfaceFor('marketer'), CLEAN),
      cookies.get('marketer') as string,
    )
    expect(refused.status).toBe(403)
    expect(refused.body['permission']).toBe('content:publish')
  }, 60_000)

  it('refuses an unauthenticated request and an undeclared principal, without publishing', async () => {
    const anonymous = await post(request(surfaceFor('anon'), CLEAN))
    expect(anonymous.status).toBe(401)
    // Deny by default for a principal id the registry does not declare: a typo buys nothing, and a
    // principal that was refused everything would read as "the cage works".
    const typo = await post(request(surfaceFor('typo'), CLEAN, { principal: 'system:seo_agents' }))
    expect(typo.status).toBe(401)
    // And a request presenting BOTH a session and a named principal, which is refused rather than
    // resolved: choosing between them is how an escalation gets written.
    const both = await post(
      request(surfaceFor('both'), CLEAN, { principal: SEO_AGENT_PRINCIPAL }),
      cookies.get('owner') as string,
    )
    expect(both.status).toBe(400)
  }, 60_000)
})

describe('acceptance — a known-bad page fails the publish gate by rule name', () => {
  it('answers 422 naming banned_claim_term and unpermitted_staff_title', async () => {
    const refused = await post(
      request(surfaceFor('known-bad'), KNOWN_BAD),
      cookies.get('owner') as string,
    )
    expect(refused.status).toBe(422)
    expect(refused.body['error']).toBe('publication_refused')
    const rules = refused.body['rules'] as readonly string[]
    // BY RULE NAME (ADR 0003): a 422 alone would be satisfied by a gate that refused for any reason.
    expect(rules).toContain('banned_claim_term')
    expect(rules).toContain('unpermitted_staff_title')
    // And the offending phrases reach the editor, in the region they were found in.
    const messages = (refused.body['messages'] as readonly string[]).join('\n')
    expect(messages).toContain('"cure"')
    expect(messages).toContain('"clinic"')
    expect(messages).toContain('"doctor"')
    expect(messages).toContain('title:')
    expect(messages).toContain('body:')
    // Nothing was published, and nothing was recorded as linted: a refused lint writes no pass.
    const [records] = await sql<{ n: number }[]>`
      select count(*)::int as n from publication_record where surface = ${surfaceFor('known-bad')}
    `
    expect(records?.n).toBe(0)
    const [passes] = await sql<{ n: number }[]>`
      select count(*)::int as n from publication_lint_pass where surface = ${surfaceFor('known-bad')}
    `
    expect(passes?.n).toBe(0)
  }, 60_000)

  it('publishes the same page once the claims are gone', async () => {
    // The control, and the case that makes every refusal above mean something: a gate that refused
    // everything would pass this whole file except for this test.
    const surface = surfaceFor('clean')
    const published = await post(request(surface, CLEAN), cookies.get('owner') as string)
    expect(published.status).toBe(200)
    expect(published.body['published']).toBe(true)
    expect(String(published.body['contentSha256'])).toMatch(/^[0-9a-f]{64}$/)
    // The hash is of the exact content, computed the same way `@berelax/core` canonicalises it.
    const [expected] = await sql<{ digest: string }[]>`
      select encode(sha256(convert_to(${publicationCanonicalContent(CLEAN)}, 'UTF8')), 'hex') as digest
    `
    expect(published.body['contentSha256']).toBe(expected?.digest)

    // The four records, in order, with the evidence chained through them.
    const rows = await sql<
      { state: string; lintPassId: string | null; approvalId: string | null; hash: string }[]
    >`
      select state, lint_pass_id as "lintPassId", approval_id as "approvalId",
             content_sha256 as hash
        from publication_record where surface = ${surface} order by seq asc
    `
    expect(rows.map((row) => row.state)).toEqual(['draft', 'lint_passed', 'approved', 'published'])
    expect(rows.every((row) => row.hash === published.body['contentSha256'])).toBe(true)
    expect(rows[3]?.lintPassId).toBe(published.body['lintPassId'])
    expect(rows[3]?.approvalId).toBe(published.body['approvalId'])

    // The approval snapshot, written from the session rather than invented, and the role it held.
    const [approval] = await sql<{ name: string; role: string; userId: string }[]>`
      select approver_display_name as name, approver_role as role, approver_user_id as "userId"
        from publication_approval where id = ${String(published.body['approvalId'])}::uuid
    `
    expect(approval?.name).toBe(APPROVER)
    expect(approval?.role).toBe('owner')
    expect(approval?.userId.length).toBeGreaterThan(0)

    // The lint pass records the profile in force and the number of terms it compared against.
    const policy = await readCompliancePolicy(sql)
    expect(published.body['regulatoryProfileVersion']).toBe(policy.profileVersion)
    expect(Number(published.body['termsChecked'])).toBeGreaterThan(policy.bannedClaimTerms.length)
  }, 120_000)

  it('refuses a publish with no approver name rather than inventing one', async () => {
    // Brief rule 10: the only value a default could supply here is the name of a person. Refused at the
    // route as well as by the CHECK, because the route is where the person can be told.
    const refused = await post(
      { surface: surfaceFor('nameless'), path: PAGE, regions: CLEAN },
      cookies.get('owner') as string,
    )
    expect(refused.status).toBe(400)
    expect(String(refused.body['message'])).toContain('approverDisplayName')
  }, 60_000)
})

describe('acceptance — the weight check measures the rendered page, before publication', () => {
  it('measures a real document and reports the figure it judged against', async () => {
    const surface = surfaceFor('weight')
    const published = await post(request(surface, CLEAN), cookies.get('owner') as string)
    expect(published.status).toBe(200)
    const measured = Number(published.body['measuredCriticalPathBytes'])
    const budget = Number(published.body['criticalPathBudgetBytes'])
    // The control on the measurement, before anything is concluded from it: a gate that measured zero would
    // find every page inside every budget, which is the failure ADR 0002 is about.
    expect(measured).toBeGreaterThan(0)
    // The budget is docs/08 §8's figure, read from the one place it is stated. Not a constant in the route,
    // not an environment variable, and not a field of the request.
    expect(budget).toBe(homeBudgetLimit('critical-above-fold'))
    expect(measured).toBeLessThanOrEqual(budget)
    // And the figure is STORED, so the row explains its own verdict and a publish that skipped the check
    // has nothing to write (0093's CHECK).
    const [row] = await sql<{ measured: number; budget: number }[]>`
      select measured_critical_path_bytes as measured, critical_path_budget_bytes as budget
        from publication_record where surface = ${surface} and state = 'published'
    `
    expect(Number(row?.measured)).toBe(measured)
    expect(Number(row?.budget)).toBe(budget)
  }, 120_000)

  it('refuses this very page, with its real bytes, once the budget is lowered under it', async () => {
    // The oversized fixture, in `home.itest.ts`'s shape: the real measurement of the real page, re-judged
    // against a lowered budget. The bytes in the refusal are this application's own, which is what makes the
    // failure about the wiring rather than about the arithmetic.
    const subject = { surface: surfaceFor('oversize'), path: PAGE }
    const measurement = await measureCriticalPath(async (path) => {
      const response = await fetch(`${BASE}${path}`, { headers: { 'accept-language': 'en' } })
      if (!response.ok) throw new Error(`${path} answered ${response.status}`)
      return {
        contentType: response.headers.get('content-type') ?? '',
        body: Buffer.from(await response.arrayBuffer()),
      }
    }, subject)

    // The measurement has real parts. Each asserted separately, because a sum that was right for the wrong
    // reason — the document counted twice, the resources counted as zero — would pass a total.
    expect(measurement.documentBytes).toBeGreaterThan(1000)
    expect(measurement.criticalAssetBytes).toBeGreaterThan(0)

    const real = homeBudgetLimit('critical-above-fold')
    const total =
      measurement.documentBytes + measurement.criticalAssetBytes + measurement.criticalImageBytes
    expect(publicationWeightRefusals(measurement, real)).toEqual([])
    const lowered = total - 1
    const refusals = publicationWeightRefusals(measurement, lowered)
    expect(refusals.map((refusal) => refusal.rule)).toEqual([
      'publication-over-critical-path-budget',
    ])
    expect(refusals[0]?.measuredBytes).toBe(total)
    // The measured number in the refusal, which is the acceptance criterion's own words.
    expect(refusals[0]?.message).toContain(String(total))
    expect(refusals[0]?.message).toContain(String(lowered))
  }, 120_000)

  it('reads the critical path out of the document rather than being told it', async () => {
    // The set the measurement weighs, asserted against the real document. Every `<link rel=stylesheet>` and
    // every `<link rel=preload>`, which is the same definition `home/budget.ts` states and `home.itest.ts`
    // measures in a browser — so the two layers are comparable rather than merely both present.
    const response = await fetch(`${BASE}${PAGE}`, { headers: { 'accept-language': 'en' } })
    const html = await response.text()
    const resources = criticalResourcesIn(html)
    expect(resources.length).toBeGreaterThan(0)
    // Nothing is counted twice, and nothing is a data URI.
    expect(new Set(resources.map((resource) => resource.href)).size).toBe(resources.length)
    expect(resources.every((resource) => !resource.href.startsWith('data:'))).toBe(true)
    // The document's own weight is compressed, not raw: docs/08 §8's figures are gzip figures, and
    // measuring an uncompressed document against one of them is not a measurement.
    expect(documentBytes(html)).toBeLessThan(Buffer.byteLength(html, 'utf8'))
    // The discriminator: a document with no critical resources yields none, so the count above is about
    // this page rather than about a regex that matches anything.
    expect(criticalResourcesIn('<html><head><title>x</title></head><body>y</body></html>')).toEqual(
      [],
    )
  }, 60_000)

  it('composes W-SYS-09’s slot refusals into the same list as a claim and a weight breach', async () => {
    // The slot half of the gate, through the gate. The RULES are W-SYS-09's and its own suites prove them
    // against real derivative ladders; what is unproven there is that this plane REPORTS them, with the
    // measured weight, beside a claim. So an oversized hero goes through `assessPublication` itself rather
    // than through `publicationRefusals` directly — a test of the mapping alone would pass with the gate's
    // call to it deleted.
    const policy = await readCompliancePolicy(sql)
    const fetchResource = async (path: string) => {
      const response = await fetch(`${BASE}${path}`, { headers: { 'accept-language': 'en' } })
      if (!response.ok) throw new Error(`${path} answered ${response.status}`)
      return {
        contentType: response.headers.get('content-type') ?? '',
        body: Buffer.from(await response.arrayBuffer()),
      }
    }
    const heavy = await assessPublication(
      { sql, policy, fetchResource },
      {
        surface: surfaceFor('slot'),
        path: PAGE,
        regions: KNOWN_BAD,
        slotImages: [
          {
            slot: 'hero',
            alt: 'Treatment room with a linen-draped bed, a stone basin and a single orchid stem',
            servedBytes: { mobile: 240_000, desktop: 460_000 },
          },
        ],
      },
    )
    const rules = heavy.refusals.map((refusal) => refusal.rule)
    // One list, three sources: the lint's rule names and the slot's, together, so an editor is told about
    // both in one pass rather than after two renders.
    expect(rules).toContain('banned_claim_term')
    expect(rules).toContain('media-slot-over-byte-budget')
    const slot = heavy.refusals.find((refusal) => refusal.rule === 'media-slot-over-byte-budget')
    expect(slot?.where).toBe('slot:hero')
    expect(slot?.measuredBytes).toBe(240_000)
    // The control: an in-budget image with good alt text on compliant copy produces nothing at all, so the
    // composition is not turning everything into a refusal.
    const clean = await assessPublication(
      { sql, policy, fetchResource },
      {
        surface: surfaceFor('slot-clean'),
        path: PAGE,
        regions: CLEAN,
        slotImages: [
          {
            slot: 'hero',
            alt: 'Treatment room with a linen-draped bed, a stone basin and a single orchid stem',
            servedBytes: { mobile: 60_000, desktop: 120_000 },
          },
        ],
      },
    )
    expect(clean.refusals).toEqual([])
  }, 90_000)
})

describe('the state machine holds over HTTP too', () => {
  it('publishes the same surface twice, and the second publish starts a new sequence', async () => {
    const surface = surfaceFor('twice')
    expect((await post(request(surface, CLEAN), cookies.get('owner') as string)).status).toBe(200)
    const second = await post(
      request(surface, [...CLEAN, { region: 'body', text: 'A second paragraph.' }]),
      cookies.get('owner') as string,
    )
    expect(second.status).toBe(200)
    const rows = await sql<{ state: string }[]>`
      select state from publication_record where surface = ${surface} order by seq asc
    `
    // Eight records: the four of the first publish, then four more. A published surface returns to draft
    // because the new copy has a new hash and the first approval does not cover it.
    expect(rows.map((row) => row.state)).toEqual([
      'draft',
      'lint_passed',
      'approved',
      'published',
      'draft',
      'lint_passed',
      'approved',
      'published',
    ])
  }, 180_000)
})
