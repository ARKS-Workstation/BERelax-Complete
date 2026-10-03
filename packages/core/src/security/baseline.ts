/**
 * The automated baseline scan's probes and judgement, as a pure function over observed responses.
 *
 * H-HARD-10. The engagement is not booked (`Y13-pentest`), so this stands in — and a stand-in that
 * reported nothing would be worse than no scan at all, which is why the suite that exercises it points
 * it at a deliberately vulnerable fixture origin and asserts it finds exactly the holes that are there
 * (ADR 0003).
 *
 * ## Why the vulnerable route is a FIXTURE ORIGIN and not a route in `apps/web`
 *
 * The acceptance line asks for "an intentionally vulnerable fixture route". Putting one inside
 * `apps/web` would mean a route that deliberately bypasses `guardAdminRoute` living in the application
 * that gets deployed — refused by this repository's own admin-guard scan, and a real hole the day
 * somebody's `NODE_ENV` check went the wrong way. A plain `node:http` origin serving the same shapes
 * proves the same thing about the scanner and cannot ship. `apps/web/src/checkout.itest.ts` already
 * does exactly this for the card-entry origin, on a kernel-assigned port for brief rule 18's reason.
 *
 * ## Why an admin route answering 200 is a finding whatever the body says
 *
 * The tempting rule is "an unauthenticated admin page must not contain admin data". It cannot be
 * checked from outside: `200` with `text/html`, `noindex` and `no-store` is **exactly what the sign-in
 * page answers**, and a check asserting only those passed for weeks against a document with nothing to
 * do with its subject. So the rule here is about the STATUS: an admin path with no session must answer
 * a redirect to the sign-in route, or 401, 403 or 404. A 200 is a finding, and the one false positive
 * that rule can produce — an application that renders its sign-in form in place at 200 — is a design
 * this build does not have and would be a deliberate change to the guard.
 */

/** The probe kinds, closed. Each is a different question and a different severity. */
export const BASELINE_PROBE_KINDS = [
  'admin_route_unauthenticated',
  'secret_file_exposed',
  'security_headers_absent',
  'source_map_published',
  'server_version_disclosed',
] as const
export type BaselineProbeKind = (typeof BASELINE_PROBE_KINDS)[number]

/** The paths that are probed for an exposed secret. Each is a real deployment mistake, not a guess. */
export const SECRET_FILE_PATHS: readonly string[] = Object.freeze([
  '/.env',
  '/.env.local',
  '/.env.production',
  '/.git/config',
  '/package.json',
])

/**
 * Where a published source map would be, as a declared list.
 *
 * Declared because the real ones are content-hashed and a scanner cannot enumerate them: these are the
 * two unhashed paths a misconfigured build serves, and a finding here means source maps are being
 * published rather than that these two files exist.
 */
export const SOURCE_MAP_PROBE_PATHS: readonly string[] = Object.freeze([
  '/_next/static/chunks/main.js.map',
  '/_next/static/css/app.css.map',
])

/** The headers a document must carry. Absence of any one is a single finding naming them. */
export const REQUIRED_SECURITY_HEADERS: readonly string[] = Object.freeze([
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
])

/** What the scanner saw. Header names are lower-cased by the caller. */
export interface Observation {
  readonly kind: BaselineProbeKind
  readonly path: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** The first bytes of the body, for a finding's detail. Never asserted on; see the module header. */
  readonly bodyExcerpt: string
}

export interface BaselineFinding {
  readonly kind: BaselineProbeKind
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'informational'
  readonly path: string
  readonly detail: string
}

/** Statuses an unauthenticated request to a guarded path may legitimately answer. */
const GUARDED_STATUSES: readonly number[] = Object.freeze([301, 302, 303, 307, 308, 401, 403, 404])

/**
 * Every finding the observations support. Pure, total, and it answers an empty list for a clean origin.
 *
 * The empty answer is the half the suite has to prove as well: a scanner that reports a finding for
 * every response is a scanner whose output means nothing, and it would satisfy a test that only ever
 * pointed it at something broken.
 */
export function baselineFindings(observations: readonly Observation[]): readonly BaselineFinding[] {
  const findings: BaselineFinding[] = []
  for (const seen of observations) {
    switch (seen.kind) {
      case 'admin_route_unauthenticated': {
        if (GUARDED_STATUSES.includes(seen.status)) break
        findings.push({
          kind: seen.kind,
          severity: 'critical',
          path: seen.path,
          detail:
            `answered ${seen.status} to a request carrying no session cookie. An admin path must ` +
            'redirect to the sign-in route or refuse; the body is not the test, because the sign-in ' +
            `page itself answers 200 with text/html. First bytes: ${seen.bodyExcerpt.slice(0, 120)}`,
        })
        break
      }
      case 'secret_file_exposed': {
        if (seen.status !== 200) break
        findings.push({
          kind: seen.kind,
          severity: 'critical',
          path: seen.path,
          detail:
            `answered 200. A deployment serving this path hands out whatever it contains, and for ` +
            `three of the five probed paths that is a credential. First bytes: ${seen.bodyExcerpt.slice(0, 120)}`,
        })
        break
      }
      case 'security_headers_absent': {
        if (seen.status !== 200) break
        const missing = REQUIRED_SECURITY_HEADERS.filter(
          (header) => seen.headers[header] === undefined,
        )
        if (missing.length === 0) break
        findings.push({
          kind: seen.kind,
          severity: 'medium',
          path: seen.path,
          detail: `carries no ${missing.join(', ')}`,
        })
        break
      }
      case 'source_map_published': {
        if (seen.status !== 200) break
        findings.push({
          kind: seen.kind,
          severity: 'low',
          path: seen.path,
          detail:
            'a source map is served, which publishes the original sources of whatever bundle it ' +
            'belongs to. Not a credential, and it does make every other finding cheaper to look for',
        })
        break
      }
      case 'server_version_disclosed': {
        const server = seen.headers['server']
        if (server === undefined || !/\d/.test(server)) break
        findings.push({
          kind: seen.kind,
          severity: 'informational',
          path: seen.path,
          detail: `the Server header names a version: "${server}"`,
        })
        break
      }
      default:
        break
    }
  }
  return findings
}

/**
 * The floor. A scan that made no request found nothing, and reporting "no findings" for it is the green
 * tick over zero modules that ADR 0002 exists about, said about a security scan.
 */
export const MINIMUM_BASELINE_OBSERVATIONS = 5

export interface BaselineReport {
  readonly observations: number
  readonly findings: readonly BaselineFinding[]
  readonly examinedNothing: boolean
}

export function baselineReport(observations: readonly Observation[]): BaselineReport {
  return {
    observations: observations.length,
    findings: baselineFindings(observations),
    examinedNothing: observations.length < MINIMUM_BASELINE_OBSERVATIONS,
  }
}
