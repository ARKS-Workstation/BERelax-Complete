import { can, type Role } from '@berelax/core'
import type { Sql } from '@berelax/db'
import {
  type GbpConsistencyDeps,
  type GbpManualSnapshot,
  type GbpSnapshotDay,
  type GbpSnapshotPrice,
  recordManualSnapshot,
  runGbpConsistencyCheck,
} from '@berelax/google'
import { isAppError } from '@berelax/shared'
import type { AdminChrome } from '../../../../../src/components/admin/google-reauth-banner.ts'
import { renderGbpSnapshotHtml } from './render.ts'
import {
  GBP_SNAPSHOT_FIELDS,
  GBP_SNAPSHOT_PATH,
  GBP_SNAPSHOT_PERMISSION,
  type GbpSnapshotRefusal,
  type GbpSnapshotView,
} from './view.ts'

/**
 * `GET`/`POST /agents/seo/gbp-snapshot` — the consistency check and the claim behind it (G-SEO-06).
 *
 * ## Why the screen exists when the checker is a function
 *
 * Because the degraded mode has to be a WORKING feature, which is docs/10 §6's rule for the whole Google
 * surface: *"A fallback designed as something you hope not to need is a fallback you never finish."*
 * There is no Business Profile API access in this build (docs/10 §4, `Y3-gbp-api`), so the manual
 * snapshot is not an edge case — it is the ordinary path, and a checker with no way to be given a
 * snapshot would be a feature with nothing to compare. The suggestions queue one directory along records
 * the same argument in its own terms: a queue nobody can act on makes the cage a way of doing nothing.
 *
 * ## Two authorisations, and they are not the same check
 *
 * `guardAdminRoute` (in `route.ts`) answers *is there a session*. `can(role, 'integration:connect')`
 * answers *may this role record a claim about the listing*. The GET is readable to any admin session —
 * a divergence is something a manager should be able to see — and the POST is refused by name, with the
 * fields rendered read-only from the SAME predicate rather than a second spelling of it. A screen
 * offering a button the POST refuses is the defect the suggestions handler names one layer out.
 *
 * A query parameter may never choose a principal, a role or a permission (W-SYS-11, and a
 * repository-wide scan refuses it). The role comes from the session row.
 *
 * ## The instant is the person's, and it is not defaulted
 *
 * `observed-at` is when they say they looked, and a blank one is refused rather than filled in with
 * `now()`. The snapshot's whole value is that it is attributable — *who said so and when* — and a
 * timestamp this build chose would be the system's claim wearing a person's attribution (the brief's
 * rule 15 applied to a provenance rather than to a figure).
 */

export interface GbpSnapshotPrincipal {
  /** The employment record's internal handle. An audit label that names no person (ADR 0020). */
  readonly staffReference: string
  readonly role: Role
}

export interface GbpSnapshotRequest {
  readonly searchParams: URLSearchParams
  readonly body: URLSearchParams | null
  readonly principal: GbpSnapshotPrincipal
  /** The Google re-auth banner's state, read by the caller. G-CONN-08 requires it on every admin page. */
  readonly chrome: AdminChrome
}

export interface GbpSnapshotDeps {
  readonly sql: Sql
  readonly now: () => Date
  /** The checker's Google dependencies, built by the caller. Injected so a suite can drive both arms. */
  readonly checker: Omit<GbpConsistencyDeps, 'sql' | 'actor'>
}

function page(view: GbpSnapshotView & { readonly chrome: AdminChrome }, status = 200): Response {
  return new Response(renderGbpSnapshotHtml(view), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  })
}

async function viewFor(
  request: GbpSnapshotRequest,
  deps: GbpSnapshotDeps,
  snapshot: GbpManualSnapshot | undefined,
  outcome: {
    readonly refusal: GbpSnapshotRefusal | null
    readonly refusalDetail: string | null
    readonly recorded: boolean
  },
): Promise<GbpSnapshotView> {
  const checked = await runGbpConsistencyCheck(
    {
      ...deps.checker,
      sql: deps.sql,
      actor: { kind: 'staff', label: request.principal.staffReference },
    },
    snapshot === undefined ? {} : { snapshot },
  )
  return {
    readAtIso: deps.now().toISOString(),
    actorLabel: request.principal.staffReference,
    provenance: checked.provenance,
    mode: checked.mode,
    form: checked.form,
    findings: checked.report?.findings ?? [],
    compared: checked.report !== null,
    refusal: outcome.refusal,
    refusalDetail: outcome.refusalDetail,
    recorded: outcome.recorded,
    mayRecord: can(request.principal.role, GBP_SNAPSHOT_PERMISSION),
  }
}

/** The comparison as it stands, and the line after a 303. */
export async function handleGbpSnapshotRead(
  request: GbpSnapshotRequest,
  deps: GbpSnapshotDeps,
): Promise<Response> {
  return page({
    ...(await viewFor(request, deps, undefined, {
      refusal: null,
      refusalDetail: null,
      recorded: request.searchParams.get('done') === 'recorded',
    })),
    chrome: request.chrome,
  })
}

/**
 * Reads a submitted form into a snapshot, or returns the refusal by name.
 *
 * Exported so the integration suite can assert the parse without driving a server, and because the
 * field names come from the CHECKER's own form — a reader has to be able to see that this function reads
 * the names `manualSnapshotForm` wrote rather than a second set.
 */
export function snapshotFromForm(
  body: URLSearchParams,
  claimedBy: string,
):
  | { readonly snapshot: GbpManualSnapshot }
  | { readonly refusal: GbpSnapshotRefusal; readonly detail: string } {
  const observedAt = (body.get(GBP_SNAPSHOT_FIELDS.observedAt) ?? '').trim()
  if (observedAt === '') {
    return {
      refusal: 'nothing_transcribed',
      detail:
        'Say when you looked at the profile. A snapshot with no instant on it cannot be told from a ' +
        'reading this system took, and a time chosen for you would be exactly that.',
    }
  }
  const parsed = new Date(observedAt)
  if (Number.isNaN(parsed.getTime())) {
    return {
      refusal: 'unreadable_value',
      detail: `"${observedAt}" is not a date and time this build can read.`,
    }
  }

  const days: GbpSnapshotDay[] = []
  const prices: GbpSnapshotPrice[] = []
  for (const [name, value] of body.entries()) {
    const open = /^open-(\d)$/.exec(name)
    const price = /^price-(.+)-(\d+)$/.exec(name)
    if (open !== null) {
      const dayOfWeek = Number(open[1])
      const closeText = (body.get(`close-${dayOfWeek}`) ?? '').trim()
      const closed = body.get(`closed-${dayOfWeek}`) === 'yes'
      const openText = value.trim()
      if (closed) {
        days.push({ dayOfWeek, closed: true })
        continue
      }
      // A row left entirely blank is a row the person could not see, which the screen says is allowed.
      // A HALF-filled one is refused by the checker by name rather than compared as midnight.
      if (openText === '' && closeText === '') continue
      days.push({ dayOfWeek, openText, closeText })
      continue
    }
    if (price !== null && value.trim() !== '') {
      prices.push({
        serviceKey: price[1] as string,
        durationMinutes: Number(price[2]),
        grossAedText: value.trim(),
      })
    }
  }

  if (days.length === 0 && prices.length === 0) {
    return {
      refusal: 'nothing_transcribed',
      detail: 'Every field was blank, so there is nothing to compare the site against.',
    }
  }
  return {
    snapshot: { claimedBy, claimedAtIso: parsed.toISOString(), days, prices },
  }
}

/**
 * Records one claim, then a 303 back to this page.
 *
 * A redirect and not a rendered response, so a reload cannot record a second claim about the same look
 * at the profile. `audit_event` is append-only (ADR 0008), so a duplicate would be permanent and would
 * make *how many times has somebody checked this* unanswerable.
 */
export async function handleGbpSnapshotWrite(
  request: GbpSnapshotRequest,
  deps: GbpSnapshotDeps,
): Promise<Response> {
  const refuse = async (
    refusal: GbpSnapshotRefusal,
    detail: string,
    status: number,
  ): Promise<Response> =>
    page(
      {
        ...(await viewFor(request, deps, undefined, {
          refusal,
          refusalDetail: detail,
          recorded: false,
        })),
        chrome: request.chrome,
      },
      status,
    )

  if (!can(request.principal.role, GBP_SNAPSHOT_PERMISSION)) {
    // 403 with the reason readable. A refusal an operator cannot read is a refusal they raise a ticket
    // about, which is the lesson gate case 164n records for the suggestions screen.
    return await refuse(
      'forbidden',
      `Recording what the Google listing shows needs ${GBP_SNAPSHOT_PERMISSION}, which the ` +
        `${request.principal.role} role does not hold.`,
      403,
    )
  }

  const body = request.body
  if (body === null || [...body.keys()].length === 0) {
    return await refuse('unreadable_request', 'The submission carried no form fields.', 400)
  }

  const read = snapshotFromForm(body, request.principal.staffReference)
  if ('refusal' in read) return await refuse(read.refusal, read.detail, 400)

  try {
    // The comparison runs FIRST, so a transcription the checker refuses is never recorded: an
    // `audit_event` is append-only, and a claim nobody could compare would sit in the trail for ever.
    await viewFor(request, deps, read.snapshot, {
      refusal: null,
      refusalDetail: null,
      recorded: false,
    })
    await recordManualSnapshot(
      { sql: deps.sql, actor: { kind: 'staff', label: request.principal.staffReference } },
      read.snapshot,
    )
  } catch (error) {
    const detail = isAppError(error) ? error.message : 'Unexpected'
    return await refuse(
      isAppError(error) && error.kind === 'validation' ? 'unreadable_value' : 'write_refused',
      detail,
      isAppError(error) && error.kind === 'validation' ? 400 : 500,
    )
  }

  return new Response(null, {
    status: 303,
    headers: { location: `${GBP_SNAPSHOT_PATH}?done=recorded`, 'cache-control': 'no-store' },
  })
}
