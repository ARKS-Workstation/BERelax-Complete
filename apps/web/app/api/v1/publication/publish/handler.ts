import { loadConfig } from '@berelax/config'
import {
  agentPrincipal,
  deniedPermissionOf,
  type Principal,
  type PublishedCopyRegion,
  performPublication,
  principalLabel,
  staffPrincipal,
} from '@berelax/core'
import {
  createConnection,
  publishSurface,
  readCompliancePolicy,
  recordApproval,
  recordDraft,
  recordLintPass,
  type Sql,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { assessMediaForPublication } from '../../../../../src/media/publish-gate.ts'
import { appPayload, principalForRequest } from '../../../../../src/payload/request-principal.ts'
import {
  assessPublication,
  type PublicationAssessment,
  type PublicationGateRefusal,
  type ResourceFetcher,
  slotRefusalOf,
} from '../../../../../src/publication/publish-gate.ts'

/**
 * `POST /api/v1/publication/publish` — the one door to the public (W-SITE-10).
 *
 * **This endpoint refuses on its own.** It does not trust a flag an admin screen set, it does not take the
 * measured weight from the request body, and it does not take the content hash from the caller: it reads
 * the profile in force, lints the copy it was given, fetches and weighs the rendered document, and then
 * writes through `packages/db`, where migration 0093 refuses anything the gate would have let past. A
 * `curl` gets exactly the same answer as the button, which is what "the UI is never the only guard" has to
 * mean.
 *
 * ## The authorisation is the permission layer's and nothing else
 *
 * `performPublication` from `@berelax/core/access/publication.ts` is the chokepoint G-SEO-02 built, and the
 * effect is passed INTO it — so there is no statement after a refusal and a refusal cannot be a no-op. The
 * route does not name a role anywhere. `PrincipalDenied` becomes 403 by TYPE, through
 * `deniedPermissionOf`, not by matching a sentence.
 *
 * That is what makes the SEO agent's denial a permission-layer denial rather than a prompt refusal: the
 * agent's grant list holds `catalogue:read`, `report:read` and `seo_suggestion:propose`, `content:publish`
 * is not in it, and `assertPrincipalMay` refuses before `apply` is reached. Nothing here knows the agent
 * exists.
 *
 * ## How the caller is identified, and why a named principal can only NARROW
 *
 * W-SYS-11 is building the real admin session and this route will read it from there. Until it lands there
 * are two ways in, resolved in ONE function so the day the session arrives changes this function and no
 * route's authorisation:
 *
 *   * **A Payload session**, through `principalForRequest`, which is this application's only real session
 *     and which narrows the user to a role the F07 matrix knows.
 *   * **A declared agent principal named in the request** (`principal=system:seo_agent`). Taking that from
 *     a request is safe for a stronger reason than `?role=` is on the clinical-flags route: a role IS a
 *     permission, so taking one from a query would be an escalation, but an AGENT principal resolves
 *     through its own closed grant list (`AGENT_PRINCIPAL_GRANTS`) and never through a role. Every declared
 *     principal's list is narrower than every role's on this permission — none of them holds
 *     `content:publish` — so claiming to be one can only ever lose capability. An undeclared id is `null`
 *     and is refused as unauthenticated rather than defaulted, which is the deny-by-default half.
 *
 * A session and a named principal together is refused: a request that presents both is a request whose
 * author does not know which one they meant, and picking one for them is how an escalation gets written.
 *
 * ## Status codes
 *
 * 401 unauthenticated · 403 the permission layer refused · 400 the request is malformed · 422 the page is
 * refused on its merits (the lint, a slot, the weight) · 409 the state machine or the database refused the
 * write · 200 published. 422 rather than 400 for a refused page, exactly as the media endpoint decided: the
 * request is well formed and the caller is entitled to make it, and the fix is lighter copy or a lighter
 * photograph rather than a re-read of the endpoint's shape.
 */

/** The action this endpoint performs, in the vocabulary `PUBLICATION_ACTIONS` declares. */
const ACTION = 'publish' as const

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

interface PublishBody {
  readonly surface: string
  readonly path: string
  readonly regions: readonly PublishedCopyRegion[]
  /** The media rows whose alt text and slot budgets are checked. Ids, never bytes; see the header. */
  readonly slotMediaIds: readonly string[]
  readonly principal: string | null
  readonly approverDisplayName: string | null
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * The body, or null.
 *
 * JSON only. The media endpoint accepts a form as well because its `<form>` has to work with scripting
 * off; this one carries a region list and a slot array, which no `<form>` produces, so accepting one would
 * be a second parser for a shape nobody submits.
 */
async function bodyOf(request: Request): Promise<PublishBody | null> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const surface = asString(record['surface'])
  const path = asString(record['path'])
  if (surface === null || path === null || !path.startsWith('/')) return null
  const regions = Array.isArray(record['regions'])
    ? record['regions']
        .filter(
          (entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object',
        )
        .map((entry) => ({
          region: asString(entry['region']) ?? '',
          text: typeof entry['text'] === 'string' ? entry['text'] : '',
        }))
        .filter((entry) => entry.region !== '')
    : []
  if (regions.length === 0) return null
  const slotMediaIds = Array.isArray(record['slotMediaIds'])
    ? record['slotMediaIds'].map((id) => asString(id)).filter((id): id is string => id !== null)
    : []
  return {
    surface,
    path,
    regions,
    slotMediaIds,
    principal: asString(record['principal']),
    approverDisplayName: asString(record['approverDisplayName']),
  }
}

/** Who is asking, and who they are as far as the audit trail is concerned. */
interface Caller {
  readonly principal: Principal
  /** The approver's id and snapshot. Null for an agent, which cannot approve anything. */
  readonly approver: {
    readonly userId: string
    readonly displayName: string
    readonly role: string
  } | null
  /**
   * The principal as Payload's access layer reads it, or null.
   *
   * The spread of the `CmsPrincipal` and NOT a second `payload.auth()` call — the same thing the media
   * publish endpoint passes (`assessMediaForPublication(payload, mediaId, { ...principal })`), so a role
   * that may not read media cannot learn an image's alt text and byte weights by asking this endpoint.
   */
  readonly cmsUser: unknown
}

/**
 * The caller, resolved in one place. See the header on why a named principal can only narrow.
 *
 * Returns `undefined` for "nobody" and a string for "a request that presented two identities", which the
 * route reports as 400 rather than choosing between them.
 */
async function callerOf(
  request: Request,
  named: string | null,
  approverDisplayName: string | null,
): Promise<Caller | undefined | 'ambiguous'> {
  const session = await principalForRequest(request)
  if (session !== null && named !== null) return 'ambiguous'
  if (session !== null) {
    return {
      principal: staffPrincipal(session.role),
      cmsUser: { ...session },
      approver: {
        userId: session.id,
        // The snapshot. Supplied by the caller because the session does not carry a display name yet
        // (W-SYS-11), and refused rather than defaulted when it is absent: `publication_approval`'s CHECK
        // rejects a placeholder, and a default here would be this repository inventing a staff name.
        displayName: approverDisplayName ?? '',
        role: session.role,
      },
    }
  }
  if (named === null) return undefined
  const agent = agentPrincipal(named)
  // `null` for an id the registry does not declare. Deny by default: a typo buys nothing, and a principal
  // that is refused everything would read as "the cage works" (`agentPrincipal`'s own header).
  return agent === null ? undefined : { principal: agent, approver: null, cmsUser: null }
}

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Fetches a resource from this same server. See `publish-gate.ts` on why the page is fetched rather than
 * re-rendered, and why nothing about the weight comes from the request body.
 *
 * Only the DOCUMENT's failure is fatal: a 404 on a preload target is a rendering defect for
 * `hero-lcp.itest.ts` and `pnpm media` to report, and refusing a publish for it here would attribute it to
 * the weight budget. `measureCriticalPath` counts such a resource as zero.
 */
function resourceFetcher(request: Request, documentPath: string): ResourceFetcher {
  const origin = new URL(request.url).origin
  return async (path: string) => {
    const response = await fetch(new URL(path, origin), { headers: { 'accept-language': 'en' } })
    if (!response.ok) {
      throw new Error(
        `[publication-document-unavailable] ${path} answered ${response.status}, so there is nothing to ` +
          `weigh${path === documentPath ? '' : ' for this resource'}. A page that cannot be rendered ` +
          'cannot be published.',
      )
    }
    return {
      contentType: response.headers.get('content-type') ?? '',
      body: Buffer.from(await response.arrayBuffer()),
    }
  }
}

/**
 * The slot refusals for the media rows this page names, through `assessMediaForPublication`.
 *
 * The SAME function the media publish endpoint calls: the alt-text rules and the per-slot byte budgets are
 * W-SYS-09's, they are measured off the objects in the bucket, and a second reading of them here would be
 * the second implementation `publish-gate.ts`'s header is about. A row that does not exist contributes
 * nothing rather than throwing — a page naming a deleted image is a page with one fewer image, and the
 * weight check still weighs whatever the document actually references.
 */
async function slotRefusalsFor(
  mediaIds: readonly string[],
  user: unknown,
): Promise<readonly PublicationGateRefusal[]> {
  if (mediaIds.length === 0) return []
  const payload = await appPayload()
  const out: PublicationGateRefusal[] = []
  for (const mediaId of mediaIds) {
    const assessment = await assessMediaForPublication(payload, mediaId, user)
    if (assessment === null) continue
    for (const refusal of assessment.refusals) out.push(slotRefusalOf(refusal))
  }
  return out
}

export async function handlePublish(request: Request): Promise<Response> {
  const body = await bodyOf(request)
  if (body === null) {
    return json(
      {
        error: 'invalid_request',
        message:
          'surface, an absolute path and a non-empty regions array are required. The regions are the copy ' +
          'the approval is given for, so a publish with none is a publish of nothing.',
      },
      400,
    )
  }

  const caller = await callerOf(request, body.principal, body.approverDisplayName)
  if (caller === 'ambiguous') {
    return json(
      {
        error: 'invalid_request',
        message:
          'The request presented both a signed-in session and a named principal. Choosing between them ' +
          'is how an escalation gets written, so neither is used.',
      },
      400,
    )
  }
  if (caller === undefined) {
    return json(
      {
        error: 'unauthenticated',
        message:
          'This endpoint needs a signed-in admin session, or a principal the registry declares. An ' +
          'unrecognised principal is refused rather than treated as one with no permissions.',
      },
      401,
    )
  }

  try {
    return await withSql(async (sql) => {
      // THE authorisation. The effect is passed in, so there is no statement after a refusal — and nothing
      // in this file names a role or a permission for the answer to be compared against.
      return await performPublication({
        principal: caller.principal,
        action: ACTION,
        apply: async () => await publish(sql, request, body, caller),
      })
    })
  } catch (error) {
    const permission = deniedPermissionOf(error)
    if (permission !== null) {
      return json(
        {
          error: 'forbidden',
          principal: principalLabel(caller.principal),
          permission,
          message:
            `${principalLabel(caller.principal)} may not ${permission}. This is the permission layer ` +
            'refusing, not a policy the caller was asked to respect: publication is denied to every ' +
            'principal whose grant list does not hold it (docs/07 §3).',
        },
        403,
      )
    }
    const message = error instanceof Error ? error.message : String(error)
    // The state machine's and the database's refusals are the caller's problem and are reported as such.
    // Anything else is a bug and must not be flattened into a 409 that reads like a rejected page.
    const conflict =
      isAppError(error) &&
      (message.includes('publication_transition_refused') ||
        message.includes('PublicationTransitionNotPermitted') ||
        message.includes('PublicationRecordImmutable') ||
        message.includes('PublicationCorrectionMustSupersede') ||
        message.includes('PublicationOverWeightBudget') ||
        message.includes('publication_revert_target') ||
        message.includes('publication_profile_absent'))
    if (conflict) return json({ error: 'publication_conflict', message }, 409)
    if (message.includes('[publication-document-unavailable]')) {
      return json({ error: 'not_publishable', message }, 409)
    }
    return json({ error: 'unexpected', message }, 503)
  }
}

/**
 * The effect: assess, then write the whole sequence.
 *
 * Four records for one publish, because each state is a fact somebody may have to reconstruct later: the
 * draft the copy arrived as, the lint that passed on that exact content, the approval a named person gave
 * for that exact hash, and the publication. `recordLintPass` and `recordApproval` each write their own
 * record and audit row in their own transaction, and `publishSurface` writes the fourth with the audit row
 * 0093 will not commit without.
 */
async function publish(
  sql: Sql,
  request: Request,
  body: PublishBody,
  caller: Caller,
): Promise<Response> {
  const policy = await readCompliancePolicy(sql)
  const assessment: PublicationAssessment = await assessPublication(
    { sql, policy, fetchResource: resourceFetcher(request, body.path) },
    {
      surface: body.surface,
      path: body.path,
      regions: body.regions,
      // Resolved from the rows rather than read from the body; see `slotRefusalsFor`. The gate re-runs
      // `publicationRefusals` over this list and would find nothing, so the refusals are merged below
      // instead of round-tripped through it.
      slotImages: [],
    },
  )
  const slotRefusals = await slotRefusalsFor(body.slotMediaIds, caller.cmsUser)
  const refusalsFound = [...assessment.refusals, ...slotRefusals]
  if (refusalsFound.length > 0) {
    return json(
      {
        error: 'publication_refused',
        surface: body.surface,
        contentSha256: assessment.contentSha256,
        // The rule names, so a caller branches on them, and the messages, which carry the measured
        // figures. A refusal that said only "refused" would send an editor back to guess which of their
        // two problems it was.
        rules: refusalsFound.map((refusal) => refusal.rule),
        measuredBytes: refusalsFound.map((refusal) => refusal.measuredBytes),
        messages: refusalsFound.map((refusal) => refusal.message),
        measuredCriticalPathBytes: assessment.measuredCriticalPathBytes,
        criticalPathBudgetBytes: assessment.criticalPathBudgetBytes,
      },
      422,
    )
  }
  const approver = caller.approver
  if (approver === null || approver.displayName === '') {
    // An agent reaching here would already have been refused by the permission layer; a session with no
    // display name has not. Refused rather than defaulted, because the only value that would satisfy a
    // default is the name of a person (brief rule 10, and `JOURNAL_POSTS.byline`'s help text).
    return json(
      {
        error: 'invalid_request',
        message:
          'approverDisplayName is required: the approval snapshots the approver’s display name beside ' +
          'their id so a later rename cannot rewrite who approved what, and there is no default a ' +
          'template may invent. W-SYS-11’s session will supply it.',
      },
      400,
    )
  }

  const now = new Date()
  // Always a draft first, whether or not the surface has been here before. Every arrow forward starts from
  // draft (`PUBLICATION_TRANSITIONS`), and a surface already published is no exception: the content being
  // published now is new, so the hash is new, and the approval that covered the live version does not
  // cover it. A branch that skipped this for a fresh surface would be two paths for one sequence.
  await recordDraft(sql, {
    surface: body.surface,
    contentSha256: assessment.contentSha256,
    recordedAt: now,
    actorKind: 'staff',
    actorLabel: approver.displayName,
  })
  const { lintPassId } = await recordLintPass(sql, {
    surface: body.surface,
    contentSha256: assessment.contentSha256,
    termsChecked: assessment.termsChecked,
    lintedAt: now,
    actorKind: 'staff',
    actorLabel: approver.displayName,
  })
  const { approvalId } = await recordApproval(sql, {
    surface: body.surface,
    lintPassId,
    contentSha256: assessment.contentSha256,
    approverUserId: approver.userId,
    approverDisplayName: approver.displayName,
    approverRole: approver.role,
    approvedAt: now,
  })
  const published = await publishSurface(sql, {
    surface: body.surface,
    lintPassId,
    approvalId,
    contentSha256: assessment.contentSha256,
    measuredCriticalPathBytes: assessment.measuredCriticalPathBytes,
    criticalPathBudgetBytes: assessment.criticalPathBudgetBytes,
    recordedAt: now,
    actorKind: 'staff',
    actorLabel: approver.displayName,
  })
  return json(
    {
      published: true,
      surface: body.surface,
      recordId: published.recordId,
      lintPassId,
      approvalId,
      contentSha256: assessment.contentSha256,
      termsChecked: assessment.termsChecked,
      regulatoryProfileVersion: assessment.profileVersion,
      measuredCriticalPathBytes: assessment.measuredCriticalPathBytes,
      criticalPathBudgetBytes: assessment.criticalPathBudgetBytes,
    },
    200,
  )
}
