import { loadConfig } from '@berelax/config'
import {
  CONTRAINDICATION_SESSIONLESS_CEILING_ROLE,
  instantFromIso,
  narrowContraindicationAccess,
  ROLES,
  type Role,
  resolveContraindicationAccess,
} from '@berelax/core'
import {
  createConnection,
  readAssignedTherapistIds,
  readContraindicationFlags,
  type Sql,
} from '@berelax/db'
import { AppError, isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../../src/components/admin/google-reauth-source.ts'
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
 * ## `?role=` can only NARROW, and that is what makes it safe to take from a query
 *
 * There is no admin session until W-SYS-01, exactly as every route under `/compliance`, `/hr`, `/settings`
 * and `/clients` records. `?employee=` is the same shape the intake route takes and is safe there for a
 * reason that does not transfer: that read is refused by the DATABASE without a step-up grant, so naming
 * somebody else buys nothing. A role is different — a role IS the permission — so taking one from a query
 * would be an escalation with a query string.
 *
 * So the role is used to narrow and never to widen. The decision is taken for the claimed role and then
 * intersected with {@link CEILING_ROLE}'s, which holds `clinical_flags:read` and not `clinical_note:read`.
 * Every consequence follows from that one line:
 *
 *   - `?role=therapist` does not unlock the detail, because the ceiling refuses it.
 *   - `?role=therapist` still has to be ASSIGNED to see the flags, because that half comes from the
 *     database rather than from the query, and a narrowing this route cannot undo.
 *   - `?role=marketer` is refused everything, which is the claimed role narrowing the ceiling.
 *
 * When the session lands, the ceiling comes off and `role` and `employee` come from it. Nothing else
 * changes, which is the point of taking them as arguments now.
 */
export const dynamic = 'force-dynamic'

/**
 * The widest reader this page will serve until there is a session.
 *
 * Both the ceiling and the narrowing live in `@berelax/core`, not here, so the property that matters — this
 * can only NARROW — is proved by a pure test rather than by serving the page. A ceiling whose only test
 * needs a server is a ceiling somebody removes without ever seeing it fail.
 */
const CEILING_ROLE: Role = CONTRAINDICATION_SESSIONLESS_CEILING_ROLE

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value)

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

const required = (url: URL, name: string): string => {
  const value = url.searchParams.get(name)?.trim() ?? ''
  if (value.length === 0) {
    // A TypeError, because the error branch below maps it to 400: this is the caller's request being
    // incomplete rather than a failure to read.
    throw new TypeError(
      `?${name}= is required. A clinical marker is shown to somebody, and there is no default reader.`,
    )
  }
  return value
}

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const { id: customerId } = await context.params
    const employeeId = required(url, 'employee')
    const claimedRole = url.searchParams.get('role')?.trim() ?? CEILING_ROLE
    if (!isRole(claimedRole)) {
      // Deny by default, including for an unknown role STRING — `canReadFieldGroup`'s lesson from P-HR-01,
      // one layer up. A 400 rather than a silent fall back to the ceiling: falling back would serve a page
      // to a caller whose role nobody recognised, and the caller would never learn their role was a typo.
      throw new TypeError(
        `?role=${claimedRole} is not a role this system knows (${ROLES.join(', ')}). An unrecognised ` +
          'role is refused rather than treated as the narrowest one, so a typo cannot be mistaken for a ' +
          'permission decision.',
      )
    }
    const direction: FlagsRenderDirection = url.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr'

    const html = await withSql(async (sql) => {
      const chrome = await adminChromeFor({
        sql,
        now: instantFromIso(new Date().toISOString()),
        request,
      })
      const assignedTherapistIds = await readAssignedTherapistIds(sql, customerId)
      const access = narrowContraindicationAccess(
        resolveContraindicationAccess({ role: claimedRole, employeeId, assignedTherapistIds }),
        resolveContraindicationAccess({ role: CEILING_ROLE, employeeId, assignedTherapistIds }),
      )

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
        role: claimedRole,
        employeeId,
        access,
        outcome,
      })
    })

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
