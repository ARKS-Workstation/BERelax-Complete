import { loadConfig } from '@berelax/config'
import { instantFromIso, resolveContraindicationAccess } from '@berelax/core'
import {
  createConnection,
  readAssignedTherapistIds,
  readContraindicationFlags,
  type Sql,
} from '@berelax/db'
import { AppError, isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../../src/components/admin/google-reauth-source.ts'
import { requireAdminPrincipal } from '../../../../../src/session.ts'
import { type FlagsOutcome, type FlagsRenderDirection, renderFlagsPageHtml } from './render.ts'

/**
 * `GET /clients/[id]/flags` — the boolean-only crossing, on a screen (C-CRM-09).
 *
 * The route is a join and nothing else: `@berelax/db` reads the view, `@berelax/core` decides who may see
 * what, and `render.ts` owns the document.
 *
 * ## It holds no key, and it cannot reach the clinical schema
 *
 * That is the whole difference from `/clients/[id]/intake` one directory along, which needs a clinical
 * credential nobody has configured and says so rather than working round it. This page reads
 * `public.customer_contraindication_flags` over `DATABASE_URL`, which is `berelax_app` — the role migration
 * 0009 revokes every clinical privilege from. So it works in production today, and there is no code path
 * here that could be given a key: `CLINICAL_KEK` is not read, `@berelax/clinical` is not imported, and the
 * only query against a clinical table is the view's own, which runs as the view's owner because it is
 * declared `security_invoker = false`.
 *
 * ## The reader comes from the SESSION, and the receptionist ceiling has come off (W-SYS-11)
 *
 * This route used to take `?employee=` and `?role=` from the query string, because there was no admin
 * session — and it was safe only because the claimed role was intersected with a receptionist ceiling in
 * `@berelax/core`, which holds `clinical_flags:read` and not `clinical_note:read`. No query string could
 * unlock the detail behind a marker, and the comment here promised that "when the session lands, the
 * ceiling comes off and `role` and `employee` come from it".
 *
 * That is this change, and the one thing that must not happen while making it is for a narrowing to become
 * a widening. It does not, and the reason is worth stating precisely, because "the ceiling was removed"
 * sounds exactly like the defect:
 *
 *   - The ceiling existed because the role was **claimed**. A role is the permission, so taking one at face
 *     value from a query string would have been an escalation with a query string, and intersecting it with
 *     a fixed ceiling was what made that impossible.
 *   - The role is now **authenticated**: it comes from `staff_credential` by way of a live `staff_session`,
 *     reached from an opaque 32-byte cookie that carries no payload for an attacker to edit. So the
 *     narrowing is replaced by authentication, not by nothing.
 *   - Keeping the ceiling would now be the defect in the other direction: an assigned therapist holds
 *     `clinical_note:read` legitimately, and a receptionist ceiling would refuse them their own permission
 *     for ever — a screen that lies about the matrix.
 *
 * The property that replaces it is **the query string cannot change the answer**, and it holds structurally
 * rather than by intersection: nothing here reads `role` or `employee` from the URL at all.
 * `apps/web/src/session.itest.ts` asserts it the only way that means anything — by appending
 * `?role=owner&employee=<somebody else>` to an authenticated receptionist's request and requiring the
 * response to be byte-for-byte identical.
 *
 * `@berelax/core` keeps `narrowContraindicationAccess` and `CONTRAINDICATION_SESSIONLESS_CEILING_ROLE`,
 * which this route no longer calls. They are C-CRM-09's, they are pure, they have their own tests and gate
 * case 111o proves the narrowing fires; deleting another unit's tested primitive to tidy up after this one
 * is not this unit's business.
 */
export const dynamic = 'force-dynamic'

/**
 * The mirror of the intake route's guard, and it exists because this page's central claim is falsifiable.
 *
 * This page must NEVER need a clinical privilege. It reads a `security_invoker = false` view whose staleness
 * function is `SECURITY DEFINER`, so `berelax_app` reaches neither the clinical schema nor anything in it.
 * If that ever stops being true — the function loses `SECURITY DEFINER`, or its EXECUTE grant, or the view
 * is replaced by one that selects the table directly — the symptom is `permission denied for schema
 * clinical` in a 503, and an operator reading that looks for a bug in a query. It is not a bug in the query:
 * it is the property this whole page rests on having been lost, one migration at a time.
 *
 * This is exactly how the defect was found during the build, and it was found by running one statement as
 * `berelax_app` rather than as the owner a test pool connects as. The remedy is NEVER to grant `berelax_app`
 * access to the clinical schema: that would delete the boundary instead of fixing the page.
 */
const CLINICAL_PRIVILEGE_LEAKED =
  'ContraindicationCrossingNotBooleanOnly: this page read something in the clinical schema over the ' +
  'application credential, which migration 0009 denies it. This page must never need a clinical privilege ' +
  'at all: it selects from public.customer_contraindication_flags, a security_invoker = false view whose ' +
  'staleness function is SECURITY DEFINER with a pinned search_path (migration 0084). One of those three ' +
  'properties has been lost. Do NOT grant berelax_app access to the clinical schema to make this page ' +
  'work — that deletes the boundary ADR 0010 built rather than fixing the page.'

/** Postgres `insufficient_privilege`. The code, not the message, because the message is localised. */
const INSUFFICIENT_PRIVILEGE = '42501'

const isPrivilegeDenied = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === INSUFFICIENT_PRIVILEGE

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } catch (error) {
    if (isPrivilegeDenied(error)) {
      throw new AppError('invariant_violated', CLINICAL_PRIVILEGE_LEAKED, { cause: error })
    }
    throw error
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const { id: customerId } = await context.params
    // `?dir=rtl` is the ONLY query parameter this route reads, and it is a presentation axis rather than a
    // permission: it mirrors the layout so the direction half of the accessibility matrix can be audited
    // without inventing an Arabic admin surface. `role` and `employee` are deliberately not read here or
    // anywhere below — see the header.
    const direction: FlagsRenderDirection = url.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr'

    const html = await withSql(async (sql) => {
      // The guard first, before any read of this client. A refused reader must cause no query at all: one
      // whose timing or whose error could say whether there is a row is a disclosure, and there is nothing
      // this page could do with the answer anyway.
      const authorised = await requireAdminPrincipal(sql, request, new Date().toISOString())
      if ('response' in authorised) return authorised.response
      const { principal } = authorised

      const chrome = await adminChromeFor({
        sql,
        now: instantFromIso(new Date().toISOString()),
        request,
      })
      const assignedTherapistIds = await readAssignedTherapistIds(sql, customerId)
      // One decision, for the authenticated role and the authenticated employee. No intersection with a
      // ceiling, because there is no claimed role left to narrow — see the header for why that is not the
      // widening it resembles.
      const access = resolveContraindicationAccess({
        role: principal.role,
        employeeId: principal.employeeId,
        assignedTherapistIds,
      })

      // Not read at all when the flags are refused. A refused reader must not cause a query whose timing or
      // whose error could tell them whether there is a row, and there is nothing this page could do with
      // the answer.
      const flags = access.flags.permitted ? await readContraindicationFlags(sql, customerId) : null
      const outcome: FlagsOutcome =
        flags === null ? { kind: 'not_derived' } : { kind: 'flags', flags }

      return renderFlagsPageHtml({
        chrome,
        customerId,
        direction,
        role: principal.role,
        employeeId: principal.employeeId,
        access,
        outcome,
      })
    })

    // The guard's redirect travels back through `withSql` as a Response rather than being thrown, so it is
    // returned unchanged here. A throw would be caught by the `catch` below and rendered as "the markers
    // could not be read", which is a different claim from "you are not signed in" and would send an
    // operator looking for an outage.
    if (html instanceof Response) return html

    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error) {
    // A refused parameter is the caller's, a failed read is not, and the two must not answer the same way.
    // A REFUSED READER is neither: it is rendered as a page, above, because "you may not see this" is
    // information the operator needs on the screen they are on.
    const isRequest = error instanceof TypeError
    const message = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
    return new Response(`The client markers could not be read: ${message}\n`, {
      status: isRequest ? 400 : 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
