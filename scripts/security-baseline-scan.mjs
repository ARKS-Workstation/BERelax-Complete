#!/usr/bin/env node
/**
 * The automated unauthenticated baseline scan, which stands in until a penetration test is booked.
 *
 * H-HARD-10, `pnpm security-scan --target <origin>`. The engagement is `Y13-pentest` and has not
 * happened; the register ships live and empty, and this is what puts anything in it in the meantime.
 *
 * ## What it probes, and why the target list is DERIVED
 *
 * The admin paths come from `apps/web/src/routes/registry.ts` through `requiresAdminSession`, not from
 * a list in this file. A hand-written list is right the day it is written and then misses the route
 * added next week — which is the only route an attacker would find interesting, because it is the one
 * nobody has looked at. `ADMIN_UNGUARDED_PATHS` is excluded by name rather than by its handler's
 * behaviour, for the reason that constant exists: the sign-in route legitimately answers 200.
 *
 * Dynamic segments are skipped. A path containing `[mediaId]` is not a URL, and substituting a value
 * would be inventing one — the scan would then report on whatever that invented id resolves to.
 *
 * Everything else is a declared probe list in `packages/core/src/security/baseline.ts` with the
 * judgement beside it: the five secret paths, the three required headers, the two unhashed source-map
 * paths, and the `Server` header.
 *
 * ## Why the judgement is not in this file
 *
 * `baselineFindings` is pure and has a test per probe, including the two-sided one that matters: a
 * well-behaved origin produces NO findings. A scanner that reported something for every response would
 * satisfy any test that only ever pointed it at something broken, and this is the unit whose whole
 * acceptance line is "proving the scan is not passing on nothing" (ADR 0003).
 * `packages/fixtures/src/security-baseline-scan.itest.ts` is the other half: it starts a deliberately
 * vulnerable origin and asserts this scan finds exactly the holes in it.
 *
 * Usage: `tsx scripts/security-baseline-scan.mjs --target http://127.0.0.1:3000 [--json] [--import]`
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { ADMIN_UNGUARDED_PATHS, requiresAdminSession } from '../apps/web/src/routes/admin-routes.ts'
import { ROUTES } from '../apps/web/src/routes/registry.ts'
import {
  baselineReport,
  MINIMUM_BASELINE_OBSERVATIONS,
  REQUIRED_SECURITY_HEADERS,
  SECRET_FILE_PATHS,
  SOURCE_MAP_PROBE_PATHS,
} from '../packages/core/src/security/baseline.ts'
import { FINDING_RULES } from '../packages/core/src/security/findings.ts'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}

const target = flag('target')
const asJson = argv.includes('--json')
const doImport = argv.includes('--import')
const registerPath = flag('register', 'artifacts/security/findings.json')

if (target === null) {
  console.error('--target <origin> is required: a scan with no target examines nothing.')
  process.exit(2)
}

/** The admin paths, derived from the registry and never listed here. */
const adminPaths = ROUTES.map((route) => route.path)
  .filter((path) => requiresAdminSession(path))
  .filter((path) => !ADMIN_UNGUARDED_PATHS.includes(path))
  // A path with a dynamic segment is not a URL; substituting a value would be inventing one.
  .filter((path) => !path.includes('['))
  .sort()

if (adminPaths.length === 0) {
  console.error(
    `[${FINDING_RULES.registerExaminedNothing}] the route registry yielded no guarded admin path, so ` +
      '"no admin route is reachable without a session" would be a claim about no routes (ADR 0002).',
  )
  process.exit(1)
}

const headerBag = (headers) => {
  const bag = {}
  for (const [name, value] of headers.entries()) bag[name.toLowerCase()] = value
  return bag
}

async function probe(kind, path) {
  const url = new URL(path, target).toString()
  let response
  try {
    response = await fetch(url, {
      redirect: 'manual',
      // No cookie, no authorization header: the whole point is what an unauthenticated caller sees.
      headers: { 'user-agent': 'berelax-security-baseline' },
    })
  } catch (error) {
    // A connection failure is NOT a clean probe. Reporting it as "nothing found" is how a scan against
    // a server that was not running comes to look like a scan that found nothing wrong.
    throw new Error(`${url} could not be reached: ${error.message ?? error}`)
  }
  const body = response.body === null ? '' : (await response.text()).slice(0, 400)
  return {
    kind,
    path,
    status: response.status,
    headers: headerBag(response.headers),
    bodyExcerpt: body,
  }
}

const observations = []
for (const path of adminPaths) {
  observations.push(await probe('admin_route_unauthenticated', path))
}
for (const path of SECRET_FILE_PATHS) {
  observations.push(await probe('secret_file_exposed', path))
}
for (const path of SOURCE_MAP_PROBE_PATHS) {
  observations.push(await probe('source_map_published', path))
}
observations.push(await probe('security_headers_absent', '/'))
observations.push(await probe('server_version_disclosed', '/'))

const report = baselineReport(observations)

if (asJson) {
  console.log(JSON.stringify({ target, ...report }, null, 2))
} else {
  console.log(
    `Baseline scan of ${target}: ${report.observations} observation(s) over ${adminPaths.length} ` +
      `guarded admin path(s), ${SECRET_FILE_PATHS.length} secret path(s), ` +
      `${SOURCE_MAP_PROBE_PATHS.length} source-map path(s) and ${REQUIRED_SECURITY_HEADERS.length} ` +
      `required header(s). ${report.findings.length} finding(s).`,
  )
  for (const finding of report.findings) {
    console.log(`  [${finding.severity}] ${finding.kind} ${finding.path}: ${finding.detail}`)
  }
}

if (doImport) {
  /*
    Imported with a STABLE id derived from the probe and the path, so a second scan of the same hole
    updates nothing rather than adding a second row. Status `open` and never anything else: a scanner
    may raise a finding and may not triage one, because triaging is a judgement and the closing rule
    requires evidence a scanner does not have.
  */
  const register = JSON.parse(readFileSync(registerPath, 'utf8'))
  const existing = new Set(register.findings.map((finding) => finding.id))
  const added = []
  for (const finding of report.findings) {
    const id = `BL-${finding.kind}-${finding.path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}`
    if (existing.has(id)) continue
    added.push({
      id,
      title: `${finding.kind} on ${finding.path}`,
      severity: finding.severity,
      status: 'open',
      source: 'automated_baseline',
      detail: finding.detail,
      surface: finding.path,
      raisedAtIso: new Date().toISOString(),
    })
  }
  register.findings = [...register.findings, ...added]
  writeFileSync(registerPath, `${JSON.stringify(register, null, 2)}\n`)
  console.log(`Imported ${added.length} new finding(s) into ${registerPath} as open.`)
}

if (report.examinedNothing) {
  console.error(
    `\n[${FINDING_RULES.registerExaminedNothing}] only ${report.observations} observation(s), below ` +
      `the floor of ${MINIMUM_BASELINE_OBSERVATIONS}. A scan that made no request found nothing, and ` +
      'reporting that as clean is the green tick over zero modules (ADR 0002).',
  )
  process.exit(1)
}

const blocking = report.findings.filter((finding) =>
  ['critical', 'high'].includes(finding.severity),
)
if (blocking.length > 0) {
  console.error(`\n${blocking.length} finding(s) of blocking severity.`)
  process.exit(1)
}
