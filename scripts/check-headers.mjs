#!/usr/bin/env node
/**
 * The security headers are on every response, every inline script carries a nonce, every unauthenticated
 * endpoint takes a ceiling, and every cookie is declared (H-HARD-01).
 *
 * ## Why a scan and not five tests
 *
 * Every claim this unit makes is about a SET that grows: every response, every inline script, every public
 * endpoint, every cookie. A test asserts something about the members that exist when it is written, and
 * the member the claim is really about is the one somebody adds next month — a new admin screen with an
 * inline script, a new unauthenticated POST, a sixth cookie. None of those breaks a test; each of them
 * breaks the claim.
 *
 * `security-headers.test.ts` holds the claims a unit test CAN make — the header set is total over the
 * three route groups, the policy's shape, the cookie flags against the real builders' output — and
 * `security-headers.itest.ts` holds the one that needs a browser, which is that a violation is REFUSED.
 * This file holds the claims about the set, with six rules, each with a known-bad fixture in gate block
 * 197 that asserts rejection BY NAME.
 *
 * ## The rules
 *
 *  1. `unauthenticated-endpoint-without-a-ceiling` — a route classified as an unauthenticated write that
 *     does not call `takeRateLimit`, or calls it with a scope the policy table does not hold.
 *  2. `api-route-without-a-classification` — an `app/api` route in neither list. The direction that makes
 *     rule 1 mean anything: without it, an endpoint added tomorrow is simply not looked at.
 *  3. `csp-is-report-only` — `content-security-policy-report-only` in anything that serves a header. A
 *     report-only policy is not enforcement; it is a mailing list.
 *  4. `inline-script-without-a-nonce` — a `<script` written into an admin document that neither goes
 *     through `inlineScriptTag(` nor carries `nonce=`. Under a nonce policy such a script does not run,
 *     so this rule catches a silently dead feature as well as a hole.
 *  5. `set-cookie-builder-without-a-declaration` — a file assembling cookie attributes that
 *     `COOKIE_DECLARATIONS` has no row for, or a declared builder that no longer exists.
 *  6. `proxy-return-without-the-header-set` — a `return` in `proxy.ts`'s `proxy()` that does not go
 *     through `secured(`. Every return path is a response a browser acts on, redirects included.
 *
 * It also fails if its own lists have gone stale, which is the vacuity guard every scan in this directory
 * carries: a declared file that does not exist, a scope that is not a policy, a cookie row whose builder
 * has moved. A scan of nothing passes, and a scan of nothing is the failure mode to design against.
 *
 * Usage: `node scripts/check-headers.mjs`
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { COOKIE_DECLARATIONS, cookieTableProblems } from '../apps/web/src/security/cookies.ts'
import { RATE_LIMIT_POLICIES } from '../packages/shared/src/rate-limit.ts'
import { stripNonCode } from './lib/strip-non-code.mjs'

/** The rule names. Each is what a failure prints, and what gate block 197 asserts on. */
const RULE_NO_CEILING = 'unauthenticated-endpoint-without-a-ceiling'
const RULE_UNCLASSIFIED = 'api-route-without-a-classification'
const RULE_REPORT_ONLY = 'csp-is-report-only'
const RULE_BARE_SCRIPT = 'inline-script-without-a-nonce'
const RULE_UNDECLARED_COOKIE = 'set-cookie-builder-without-a-declaration'
const RULE_UNSECURED_RETURN = 'proxy-return-without-the-header-set'
const RULE_STALE = 'header-scan-is-stale'

const ROOT = join(import.meta.dirname, '..')
const API_ROOT = 'apps/web/app/api'
const PROXY = 'apps/web/proxy.ts'
const INLINE_HELPER = 'apps/web/src/security/inline-script.ts'

/**
 * The unauthenticated endpoints and the scope each takes.
 *
 * One scope per CLASS of endpoint rather than per URL: `/api/v1/book` and `/api/v1/bookings` are the same
 * operation under two spellings and share `booking`, because two ceilings over one operation is two ways
 * to be wrong about it.
 */
const LIMITED_ENDPOINTS = {
  'apps/web/app/api/collect/route.ts': 'collect',
  'apps/web/app/api/v1/book/route.ts': 'booking',
  'apps/web/app/api/v1/bookings/route.ts': 'booking',
  'apps/web/app/api/v1/consent/analytics/route.ts': 'consent',
  'apps/web/app/api/v1/payments/intent/route.ts': 'payment_intent',
  'apps/web/app/api/webhooks/payments/route.ts': 'payment_webhook',
  'apps/web/app/api/whatsapp/route.ts': 'whatsapp_ref',
}

/**
 * The endpoints that take no ceiling, and what stands in front of each instead.
 *
 * A closed vocabulary of GATES, not a list of excuses: `admin_session` is `guardAdminRoute` or a handler
 * that requires a principal, `shared_secret` and `capability_token` are a secret in the request compared
 * in constant time, and `read_only` writes nothing. A sixth kind of answer would have to be added here
 * and argued, which is the point — `unauthenticated_write` is not in the vocabulary, because an
 * unauthenticated write is what rule 1 is about.
 *
 * A brute-force ceiling on the two token-gated endpoints is the next increment and is `Y13-rate-limits`'
 * second half; it is NOT claimed here. What is claimed is that the endpoint has a gate, and it does.
 */
const EXEMPT_ENDPOINTS = {
  'apps/web/app/api/v1/otp/route.ts': {
    gate: 'own_rate_limit',
    why:
      'A-FIRST-02 already holds both ceilings — OTP_MAX_REQUESTS_PER_PHONE = 3 and ' +
      'OTP_MAX_REQUESTS_PER_IP = 10 in packages/db/src/repositories/otp.ts — counted over otp_challenge ' +
      'rows inside issueOtpChallenge, with an otp.rate_limited audit row and a test per ceiling. That ' +
      'state is in PostgreSQL and survives a restart, which is what acceptance line 5 asks for. ' +
      'H-HARD-01 added a second per-IP counter with the same figure in a second table and removed it: ' +
      'two counters that agree today disagree the first time one is tuned.',
    /** Named so the exemption is CHECKED. A renamed constant fails the scan rather than aging quietly. */
    provenBy: ['packages/db/src/repositories/otp.ts', 'OTP_MAX_REQUESTS_PER_IP'],
  },
  'apps/web/app/api/facts/route.ts': {
    gate: 'read_only',
    why:
      'A GET that writes nothing: the canonical fact sheet, assembled from the `premises` row. Cacheable ' +
      'by construction, so a flood is answered by whatever sits in front of it rather than by the ' +
      'database — and a ceiling on a public fact sheet would rate-limit the crawlers docs/09 wants it read ' +
      'by.',
  },
  'apps/web/app/api/v1/media/publish/route.ts': {
    gate: 'admin_session',
    why: 'The guard is the first statement of `handler.ts`: no principal, no publish, 503 fail-closed.',
  },
  'apps/web/app/api/v1/payments/token/route.ts': {
    gate: 'admin_session',
    why: '`guardAdminRoute(request)` is the first statement, and the audit actor is the signed-in member.',
  },
  'apps/web/app/api/v1/preferences/route.ts': {
    gate: 'capability_token',
    why:
      'A signed capability in the query string — `?c=<contact>&t=<token>` — compared before anything is ' +
      'read or written. Unauthenticated in the sense that no session is involved, gated in the sense ' +
      'that matters.',
  },
  'apps/web/app/api/v1/publication/publish/route.ts': {
    gate: 'admin_session',
    why: 'The guard is the first statement of `handler.ts`, and the SEO agent gets a 403 from it.',
  },
  'apps/web/app/api/v1/reviews/inbound/route.ts': {
    gate: 'shared_secret',
    why:
      'A shared secret compared in constant time, with the same 401 for a wrong length as for a wrong ' +
      'secret. Unset in every environment today, which means the endpoint answers nothing rather than ' +
      'answering anybody.',
  },
}

/**
 * Where an inline `<script>` must be nonced: the ADMIN estate, and only it.
 *
 * `apps/web/app/_document/shell.tsx` writes three inline scripts into every PUBLIC document and none of
 * them carries a nonce, deliberately: the public group's `script-src` is `'self' 'unsafe-inline'` because
 * Next's App Router emits its own un-nonced bootstrap script into every page, so a nonce there would make
 * `'unsafe-inline'` ignored and take the framework's own script down with it. That is `Y13-public-csp`,
 * it is written up at length in `apps/web/src/security/headers.ts`, and it is the reason this rule is
 * scoped rather than repository-wide. A rule that reported twelve things, nine of them correct, is a rule
 * somebody turns off.
 */
const SCRIPT_ROOTS = ['apps/web/app/(admin)', 'apps/web/src/components/admin']

/** Files that serve a header and must not serve a report-only policy. */
const HEADER_ROOTS = [
  'apps/web/app',
  'apps/web/src',
  'apps/web/proxy.ts',
  'apps/web/next.config.ts',
]

/** @type {{ rule: string, file: string, line: number, detail: string }[]} */
const problems = []
const record = (rule, file, line, detail) => problems.push({ rule, file, line, detail })

const read = (relative) => readFileSync(join(ROOT, relative), 'utf8')

/** Every file under a root, or the root itself when it is a file. */
function walk(relative, suffixes = ['.ts', '.tsx']) {
  const absolute = join(ROOT, relative)
  if (!existsSync(absolute)) return []
  if (statSync(absolute).isFile()) return [relative]
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const child = `${relative}/${entry.name}`
    if (entry.isDirectory()) found.push(...walk(child, suffixes))
    else if (suffixes.some((suffix) => entry.name.endsWith(suffix))) found.push(child)
  }
  return found
}

const isTest = (file) => file.endsWith('.test.ts') || file.endsWith('.itest.ts')
const lineOf = (text, index) => text.slice(0, index).split('\n').length

// -----------------------------------------------------------------------------------------------
// Rules 1 and 2 — every api route is classified, and an unauthenticated write takes its ceiling
// -----------------------------------------------------------------------------------------------
const apiRoutes = walk(API_ROOT).filter((file) => file.endsWith('/route.ts'))
if (apiRoutes.length === 0) {
  record(
    RULE_STALE,
    API_ROOT,
    0,
    'no api routes found; this scan would pass against an empty estate',
  )
}

for (const route of apiRoutes) {
  const scope = LIMITED_ENDPOINTS[route]
  const exempt = EXEMPT_ENDPOINTS[route]
  if (scope === undefined && exempt === undefined) {
    record(
      RULE_UNCLASSIFIED,
      route,
      1,
      'is in neither LIMITED_ENDPOINTS nor EXEMPT_ENDPOINTS. Every endpoint under /api is either ' +
        'rate-limited or has a named gate in front of it. Decide which, in scripts/check-headers.mjs.',
    )
    continue
  }
  if (scope !== undefined && exempt !== undefined) {
    record(RULE_STALE, route, 1, 'is classified as both limited and exempt.')
    continue
  }
  if (exempt !== undefined) {
    if (exempt.why.length < 80) {
      record(
        RULE_STALE,
        route,
        1,
        `is exempt with a ${exempt.why.length}-character reason. That is a label; write the argument.`,
      )
    }
    /*
      An `own_rate_limit` exemption is the one that could rot silently: it says the ceiling lives
      somewhere else, and nothing would notice the day it stopped. So it names the file and the constant,
      and both are checked. The other gate kinds are structural — a guard, a secret, a read — and are
      asserted by the suites that own them.
    */
    if (exempt.gate === 'own_rate_limit') {
      const [file, symbol] = exempt.provenBy ?? []
      if (file === undefined || symbol === undefined) {
        record(RULE_STALE, route, 1, 'claims own_rate_limit and names no file and constant.')
      } else if (!existsSync(join(ROOT, file))) {
        record(
          RULE_NO_CEILING,
          route,
          1,
          `names ${file} as its ceiling, and that file does not exist.`,
        )
      } else if (!new RegExp(`\\b${symbol}\\b`).test(read(file))) {
        record(
          RULE_NO_CEILING,
          route,
          1,
          `claims its ceiling is ${symbol} in ${file}, and that constant is no longer there. The ` +
            'endpoint is now unlimited, or the limit moved and nothing says where.',
        )
      }
    }
    continue
  }
  if (RATE_LIMIT_POLICIES[scope] === undefined) {
    record(
      RULE_STALE,
      route,
      1,
      `is declared scope "${scope}", which RATE_LIMIT_POLICIES does not hold.`,
    )
    continue
  }
  const source = stripNonCode(read(route))
  if (!source.includes('takeRateLimit')) {
    record(
      RULE_NO_CEILING,
      route,
      1,
      `is an unauthenticated endpoint declared scope "${scope}" and does not call takeRateLimit. An ` +
        'unmeasured limit is a guess; an absent one is a bill.',
    )
    continue
  }
  if (!new RegExp(`scope:\\s*'${scope}'`).test(source)) {
    record(
      RULE_NO_CEILING,
      route,
      lineOf(source, source.indexOf('takeRateLimit')),
      `takes a ceiling under a scope other than the declared "${scope}".`,
    )
  }
}

for (const route of Object.keys({ ...LIMITED_ENDPOINTS, ...EXEMPT_ENDPOINTS })) {
  if (!existsSync(join(ROOT, route))) {
    record(
      RULE_STALE,
      route,
      0,
      'is classified by this scan and does not exist. Renamed, or deleted?',
    )
  }
}

// -----------------------------------------------------------------------------------------------
// Rule 3 — the policy is ENFORCED
// -----------------------------------------------------------------------------------------------
for (const root of HEADER_ROOTS) {
  for (const file of walk(root)) {
    if (isTest(file)) continue
    const source = stripNonCode(read(file))
    const index = source.toLowerCase().indexOf('content-security-policy-report-only')
    if (index !== -1) {
      record(
        RULE_REPORT_ONLY,
        file,
        lineOf(source, index),
        'serves a report-only policy. A report-only header is not enforcement — the browser runs the ' +
          'script and posts a note about it — so a CSP is only real if a violation is REFUSED.',
      )
    }
  }
}

// -----------------------------------------------------------------------------------------------
// Rule 4 — every inline script carries a nonce
// -----------------------------------------------------------------------------------------------
let scriptsSeen = 0
let helperCalls = 0
for (const root of SCRIPT_ROOTS) {
  for (const file of walk(root)) {
    if (isTest(file) || file === INLINE_HELPER) continue
    // Comments blanked and string CONTENTS kept: the tag is written inside a template literal, so
    // `blankStrings` would erase the thing being looked for — but a doc comment explaining what the
    // nonce is for is prose, and reporting it would be the colour gate's first-run mistake again.
    const source = stripNonCode(read(file))
    helperCalls += [...source.matchAll(/\binlineScriptTag\(/g)].length
    for (const match of source.matchAll(/<script(?![a-zA-Z-])([^>]*)>/g)) {
      scriptsSeen += 1
      const attributes = match[1] ?? ''
      // `src=` is an external script; the nonce policy covers it through `'strict-dynamic'` and a URL is
      // not an injection vector the way an inline body is.
      if (/\bsrc\s*=/.test(attributes)) continue
      if (/\bnonce\s*=/.test(attributes)) continue
      // A DATA BLOCK is not a script. A `<script>` whose `type` is not a JavaScript MIME type is never
      // executed — the HTML spec calls it a data block and the browser hands its text to whatever asks
      // for it — so `script-src` does not apply and a nonce on it would mean nothing. Two of these are
      // load-bearing here: the focal-sweep JSON the media preview reads, and `application/ld+json`,
      // which is what `pnpm structured-data` exists to check. Demanding a nonce on them would be
      // demanding a nonce on a `<pre>`.
      if (/\btype\s*=\s*["'](?:application|text)\/(?!javascript|ecmascript)/.test(attributes))
        continue
      record(
        RULE_BARE_SCRIPT,
        file,
        lineOf(source, match.index ?? 0),
        'writes an inline <script> with no nonce. Under the admin policy this script does not run, so ' +
          'this is a dead feature as well as a hole. Emit it through inlineScriptTag(nonce, source).',
      )
    }
  }
}
/*
  The vacuity guard, and it counts the HELPER rather than the tags.

  A document that emits its script through `inlineScriptTag(nonce, source)` writes no `<script` literal at
  all, so rule 4 finds nothing in it — which is the arrangement working, not the rule failing. What would
  be a failure is an admin estate where neither appears: no literal tags and no helper calls means either
  the estate stopped having inline scripts (in which case this unit's nonce is decoration) or both patterns
  moved and this scan is looking at the wrong directories.
*/
if (scriptsSeen + helperCalls === 0) {
  record(
    RULE_STALE,
    SCRIPT_ROOTS.join(', '),
    0,
    'no inline <script> tags and no inlineScriptTag() calls found anywhere in the admin estate. Either ' +
      'the estate changed shape or this rule stopped matching, and a rule that matches nothing reports ' +
      'nothing.',
  )
}
if (!existsSync(join(ROOT, INLINE_HELPER))) {
  record(
    RULE_STALE,
    INLINE_HELPER,
    0,
    'is the one way an inline script is emitted, and it has moved.',
  )
}

// -----------------------------------------------------------------------------------------------
// Rule 5 — every cookie builder is declared
// -----------------------------------------------------------------------------------------------
for (const problem of cookieTableProblems()) {
  record(RULE_STALE, 'apps/web/src/security/cookies.ts', 0, problem)
}

const declaredBuilders = new Set(COOKIE_DECLARATIONS.map((declaration) => declaration.builder))
for (const builder of declaredBuilders) {
  if (!existsSync(join(ROOT, builder))) {
    record(RULE_STALE, builder, 0, 'is a declared cookie builder and does not exist.')
  }
}
for (const root of ['apps/web/app', 'apps/web/src']) {
  for (const file of walk(root)) {
    if (isTest(file)) continue
    // Comments blanked, for the reason rule 4 gives: `cookies.ts` explains what `SameSite=Lax` is and
    // would otherwise be reported as an undeclared cookie builder by the file that declares them all.
    const source = stripNonCode(read(file))
    // The shape of a cookie builder: a `SameSite=` attribute written into a header value. Narrow on
    // purpose — `set-cookie` also appears in readers, in tests and in prose, and a rule on the header
    // NAME would report all three.
    const index = source.search(/['"`]SameSite=/)
    if (index === -1) continue
    if (declaredBuilders.has(file)) continue
    record(
      RULE_UNDECLARED_COOKIE,
      file,
      lineOf(source, index),
      'assembles a Set-Cookie and has no row in COOKIE_DECLARATIONS. Declare its flags and, for each ' +
        'flag it does not carry, why — the claim this unit makes is that NO cookie in the app escapes ' +
        'those flags, and an undeclared cookie is the one the claim is about.',
    )
  }
}

// -----------------------------------------------------------------------------------------------
// Rule 6 — every response the proxy constructs carries the header set
// -----------------------------------------------------------------------------------------------
/*
  Matched on the CONSTRUCTOR and not on the `return`, because the first draft of this rule missed the
  mutation it was written for.

  `proxy()` has a cross-line ternary — `return trimmed === pathname ? secured(…) : secured(…)` — and a rule
  anchored on `return` reads only `trimmed === pathname`, which constructs nothing. So removing `secured(`
  from the `:` branch passed, which is a rule that reports nothing about the one edit a refactor would
  really make.

  Every response in this file is built by one of five expressions, and every one of them is written on a
  line that also calls `secured(`. That is the shape the rule holds: a line that constructs a response and
  does not secure it. It would miss a response secured two statements later through a local, which is a
  shape this file does not use and which the rule's own failure message names, so the next person adding one
  is told rather than silently exempted.
*/
{
  const source = stripNonCode(read(PROXY))
  const start = source.indexOf('export function proxy(')
  if (start === -1) {
    record(
      RULE_STALE,
      PROXY,
      0,
      'has no `export function proxy(`. Next 16.3 names this export `proxy`; if it moved, this rule ' +
        'is scanning nothing.',
    )
  } else {
    // The function body runs to the next top-level declaration. `proxy()` is followed by `passThrough`,
    // and reading to the end of the file would pull that helper's own constructors in.
    const after = source.indexOf('\nfunction ', start + 1)
    const body = source.slice(start, after === -1 ? source.length : after)
    const CONSTRUCTORS =
      /NextResponse\.(?:redirect|next|json|rewrite)\(|new Response\(|redirectTo\(|passThrough\(/
    let secured = 0
    for (const [offset, line] of body.split('\n').entries()) {
      if (!CONSTRUCTORS.test(line)) continue
      if (line.includes('secured(')) {
        secured += 1
        continue
      }
      record(
        RULE_UNSECURED_RETURN,
        PROXY,
        lineOf(source, start) + offset,
        `constructs a response without securing it on the same line — \`${line.trim()}\`. Every ` +
          'response this file produces is one a browser acts on, redirects included: an HSTS header ' +
          'missing from the 301 that sends a first-time visitor from http:// is the one place it would ' +
          'have mattered. Wrap it in secured(), or, if it is secured elsewhere, make that visible here.',
      )
    }
    if (secured === 0) {
      record(
        RULE_STALE,
        PROXY,
        lineOf(source, start),
        'secures no response at all; rule 6 matches nothing.',
      )
    }
  }
}

// -----------------------------------------------------------------------------------------------
if (problems.length > 0) {
  const byRule = new Map()
  for (const problem of problems) {
    byRule.set(problem.rule, [...(byRule.get(problem.rule) ?? []), problem])
  }
  for (const [rule, found] of byRule) {
    console.error(`\n  ${rule}`)
    for (const problem of found) {
      console.error(`    ${problem.file}:${problem.line}  ${problem.detail}`)
    }
  }
  console.error(
    `\n${problems.length} violation(s). A header set that is on most responses, a nonce policy with one ` +
      'un-nonced script in it, or an unauthenticated endpoint with no ceiling are each the whole hole: ' +
      'the attacker finds the one, not the many. H-HARD-01, ADR 0119.',
  )
  process.exit(1)
}

console.log(
  `Headers, CSP, ceilings and cookies hold: ${apiRoutes.length} api route(s) classified ` +
    `(${Object.keys(LIMITED_ENDPOINTS).length} rate-limited across ` +
    `${new Set(Object.values(LIMITED_ENDPOINTS)).size} scope(s), ` +
    `${Object.keys(EXEMPT_ENDPOINTS).length} behind a named gate), ${helperCalls} nonced inline ` +
    `script(s) and ${scriptsSeen} literal <script> tag(s) in the admin estate with nothing executable ` +
    `un-nonced, ${COOKIE_DECLARATIONS.length} cookie(s) declared, no report-only policy, and every ` +
    'return path in proxy.ts carries the header set.',
)
