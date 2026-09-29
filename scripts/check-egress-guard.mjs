#!/usr/bin/env node
/**
 * The half of the egress guard that no type and no import rule can express.
 *
 * A-MEAS-01's title is its specification: *opaque category codes with an enumerating test*. The enumerating
 * test is `packages/core/src/analytics/egress-guard.test.ts`, and the seeded rows behind it are
 * `packages/fixtures/src/egress-catalogue.itest.ts`. Both are claims about the guard's own behaviour. What
 * neither can say is that nothing goes ROUND it — docs/01 decision 14 and ADR 0018 are about what leaves the
 * building, and "nothing else builds an external payload" is only a claim if something FAILS on the day a
 * second builder appears. Reviewing call sites is not that. So this file is that, in seven rules, each with a
 * known-bad fixture in `scripts/test-gates.mjs` block 137 that asserts rejection BY NAME.
 *
 * ## What the type already does, and the four things it cannot
 *
 * `EgressPayload` is branded with a `unique symbol`, so it cannot be produced by writing an object literal:
 * the symbol has no runtime value and nothing satisfies the type by accident. That is the hard half, and a
 * type genuinely holds it. It leaves four things a type is blind to:
 *
 *   1. **A cast.** `{} as unknown as EgressPayload` satisfies the brand perfectly, and an adapter under
 *      deadline will write one. Rule 1 is that the one cast which mints a payload is the one inside the
 *      builder.
 *   2. **The projection turning into a spread.** `return { ...carried } as unknown as EgressPayload`
 *      typechecks, and every drop counter would report zero while every field travelled. This is the rule
 *      about two positions in one file, the shape `check-send-chokepoint.mjs` uses for the choke point's
 *      order.
 *   3. **A code spelled at a call site.** `categoryCode: 'SVV_11'` is a second assignment that nothing holds
 *      equal to the table, and the symptom is two categories reported as one. Rule 3.
 *   4. **A name getting INTO the guard.** "No service name can ever leave the building" is cheapest to
 *      enforce one step earlier: the guard is never handed one. Rule 4 keeps the name-bearing column
 *      identifiers out of the two modules, so there is nothing to drop by mistake.
 *
 * Rules 5 and 6 are the network half. `fetch` is a global, so `.dependency-cruiser.cjs` cannot see it at all
 * — a module graph has nothing to draw an edge to — which is the same division of labour
 * `tax-and-filing-must-not-reach-the-network` records with `scripts/test-no-autofile.mjs`. Rule 7 keeps the
 * dispatchable event types derived from the funnel rather than copied out of it.
 *
 * ## Why the destination hosts are a rule when the repository contains none
 *
 * Rule 6 matches zero things today, and that is the point rather than a defect: it is the rule that fires on
 * the day somebody posts to `google-analytics.com` from a module that is not a declared adapter.
 * `DECLARED_ADAPTERS` is deliberately EMPTY — A-MEAS-03 owns the adapters and does not exist yet — so the
 * rule is currently "no module in this repository names an analytics destination", which is both true and
 * worth keeping true. Its control is its gate fixture, exactly as `test-no-autofile.mjs`'s network-global
 * scan has to be.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOTS = ['packages', 'apps', 'scripts']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.sql'])
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'artifacts'])

/** The one module that mints a branded payload, and the module that holds the mapping. */
const GUARD = 'packages/core/src/analytics/egress-guard.ts'
const CODES = 'packages/core/src/analytics/category-codes.ts'
/** The two modules rules 4 and 5 are about. Named rather than inferred from a directory that grows. */
const GUARD_ESTATE = [GUARD, CODES]

/** The funnel vocabulary, read out of its one home so rule 7 cannot drift from it. */
const TAXONOMY = 'packages/shared/src/analytics/taxonomy.ts'

/** Files that carry these patterns as DATA. Scanning either would make the gate report itself. */
const EXEMPT = new Set(['scripts/check-egress-guard.mjs', 'scripts/test-gates.mjs'])

/**
 * The rule names a known-bad fixture asserts against, so a case fails BY NAME and not by exit code.
 */
const RULES = {
  brand: 'egress-brand-minted-outside-the-guard',
  projection: 'egress-projection-walks-the-allowlist',
  codeLiteral: 'egress-category-code-literal-outside-the-table',
  name: 'egress-guard-holds-a-catalogue-name',
  network: 'egress-guard-reaches-the-network',
  destination: 'analytics-destination-outside-the-declared-adapters',
  eventTypes: 'egress-event-type-is-derived-from-the-funnel',
}

/**
 * Where a category code may be written as a literal, and why each place may.
 *
 * Every entry is asserted to have been SEEN to contain one at the bottom of this file. An allowance that
 * excuses nothing is a hole waiting for the next thing written there — `IDENTIFIER_ALLOWED` in
 * `scripts/test-no-autofile.mjs` carries the same control for the same reason.
 */
const CODE_LITERAL_ALLOWED = new Map([
  [
    CODES,
    'the table itself: this is the one statement of which code stands for which catalogue thing, and the ' +
      'rule exists to keep it the only one',
  ],
  [
    'packages/core/src/analytics/egress-guard.test.ts',
    'asserts the serialised BYTES of a payload, which a field-by-field assertion cannot do — a reordered ' +
      'or renamed field is invisible to one, and two adapters serialising differently are two payloads ' +
      "for A-MEAS-03's deduplication",
  ],
])

/**
 * Modules that may name an analytics destination host, and why.
 *
 * EMPTY, and it stays that way until A-MEAS-03 writes the GA4 and Meta adapters. An entry here is the
 * declaration that a module is a door out of the building, which is a diff somebody has to justify — the
 * whole difference between a guard and a convention.
 */
const DECLARED_ADAPTERS = new Map([])

/**
 * Sibling CHECKS that legitimately hold egress-shaped text, exempted from rule 6 by name.
 *
 * This is not a courtesy. Two of the existing scans have already fired on each other's pattern text:
 * `scripts/test-no-autofile.mjs` carries `/\bfetch\s*\(/` and `/\bXMLHttpRequest\b/` as the patterns it
 * searches FOR, and the WPS no-submission scan read it as a module that knows about the wage file and
 * reaches the network — a file with no network call in it at all. The fix there was this: exempt the
 * siblings BY NAME with the reason, rather than rewording prose until a regexp is satisfied, which is
 * appeasing a check instead of fixing it.
 *
 * Rule 6 is the rule with that exposure, because a check ABOUT analytics egress has to name the hosts. The
 * control is DIFFERENT from the one on {@link CODE_LITERAL_ALLOWED} and the difference is deliberate: these
 * entries are allowed to match nothing — none of them names a destination host today — so the control is
 * that each still resolves to a file that EXISTS. A renamed or deleted sibling then fails loudly here
 * instead of silently leaving the exemption pointed at nothing, which is how an allowance outlives the
 * thing it was written for.
 */
const CHECKS_THAT_CARRY_EGRESS_PATTERNS = new Map([
  [
    'scripts/test-no-autofile.mjs',
    'holds the network-capable globals as the patterns it searches for over the tax estate (M-VAT-09), ' +
      'and is the file whose text already caused this exact collision once',
  ],
  [
    'packages/fixtures/src/wps-no-submission.test.ts',
    'holds the network patterns and the submission-host shapes it forbids for the wage file (P-HR-12)',
  ],
  [
    'scripts/check-send-chokepoint.mjs',
    'the outbound-message choke point: its subject is what may leave and by which path (C-AUTO-04)',
  ],
  [
    'scripts/check-google-token-chokepoint.mjs',
    'the Google token choke point, whose subject is a Google credential and the calls it authorises',
  ],
])

/**
 * A test may hold whatever it needs to drive the guard, and must be able to.
 *
 * Rule 1 is the exception: a test that CASTS to `EgressPayload` forges one, and the branded-output claim
 * A-MEAS-03's adapters will rely on is exactly the claim a forged payload makes vacuous. So rule 1 covers
 * tests too, and the only cast in the repository is the one in the builder.
 */
const isTest = (file) => /\.(test|itest)\.ts$/.test(file)

/**
 * A test or a Playwright spec, for rule 6 alone.
 *
 * `.spec.ts` is in here deliberately and before it was needed. A-MEAS-02's acceptance line is *"Playwright
 * with request interception: zero requests to googletagmanager.com, google-analytics.com,
 * connect.facebook.net or facebook.com occur before a recorded consent"* — so that spec has to NAME the
 * hosts, and naming them there is the enforcement rather than a leak. Without this it would be flagged by
 * rule 6 and its author would have to declare a test file as an ADAPTER, which is the wrong word, or widen
 * the rule. A gate that makes the next unit choose between a false declaration and switching it off is a
 * gate that gets switched off (the `readFileSync` lesson from M-VAT-09, ADR 0052).
 *
 * Rule 1 deliberately does NOT use this: a test that casts to `EgressPayload` forges one, and the
 * branded-output claim A-MEAS-03's adapters rely on is exactly the claim a forged payload makes vacuous.
 */
const isTestOrSpec = (file) => isTest(file) || /\.spec\.ts$/.test(file)

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) yield full
  }
}

const violations = []
const record = (rule, file, line, detail) =>
  violations.push({ rule, where: `${file}:${line}`, detail })

const lineOf = (code, index) => code.slice(0, index).split('\n').length

/** A cast to the branded type, in either of the two spellings that compile. */
const BRAND_MINT = /\bas\s+(?:unknown\s+as\s+)?EgressPayload\b/g

/**
 * A code as it appears in source, in ANY of the places one really does.
 *
 * Not `'${code}'`. The first version of this rule looked for the single-quoted spelling only, and its own
 * used-check caught it within a minute: the enumerating test asserts the serialised BYTES of a payload, so
 * the code it contains is inside a JSON string — `"categoryCode":"SVV_02"` — in DOUBLE quotes, nested in a
 * single-quoted literal. The allowance for that file therefore excused nothing and the scanner refused the
 * tree, which is the control doing exactly its job. A rule that had shipped with the narrow pattern would
 * have reported a clean scan while being unable to see a code in the one shape a serialised payload puts it
 * in — and that is the shape an adapter would copy.
 *
 * So the boundary is "not an identifier character either side", which finds it in a single-quoted literal, a
 * double-quoted one, a template literal and a JSON blob alike, while refusing `SVV_020` and `MY_SVV_02X`.
 */
const codeReach = (code) => new RegExp(`(?<![A-Za-z0-9_])${code}(?![A-Za-z0-9_])`)

/**
 * Column identifiers that carry a NAME, in both the SQL and the camel spellings the repository uses.
 *
 * The point of rule 4 is that the guard cannot be handed one, so a name has nowhere to arrive from. Matched
 * with strings KEPT, because `'publicDisplayName'` as a key in an object literal is the same reach as the
 * identifier — and with comments blanked, because both modules discuss these columns at length and a gate
 * that reports its own documentation is a gate somebody switches off.
 */
const NAME_BEARING = [
  'internalName',
  'internal_name',
  'publicDisplayName',
  'public_display_name',
  'menuLabel',
  'menu_label',
  'templateKey',
  'template_key',
  'provisionalNote',
  'provisional_note',
  'resourceRequirement',
  'resource_requirement',
]

/**
 * Network-capable globals. A module graph is blind to every one of them.
 *
 * `fetch(` as a CALL rather than the bare word, for the reason `test-no-autofile.mjs` states: the word
 * appears in prose all over this repository, and a gate that fires on a comment is a gate somebody switches
 * off. Comments are blanked before these run anyway; the call shape is belt and braces on the one that
 * matters most.
 */
const NETWORK_GLOBALS = [
  { rule: 'fetch(', re: /(?<![\w$.])fetch\s*\(/ },
  { rule: 'globalThis.fetch', re: /globalThis\s*\.\s*fetch/ },
  { rule: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { rule: 'WebSocket', re: /\bWebSocket\b/ },
  { rule: 'EventSource', re: /\bEventSource\b/ },
  { rule: 'sendBeacon', re: /\bsendBeacon\b/ },
]

/**
 * The hosts a conversion payload would be posted to.
 *
 * Assembled from parts rather than written out, for the reason the WPS gate fixture assembles its URL from
 * parts: a literal destination has no business being greppable as a working endpoint in a repository whose
 * whole claim is that nothing posts to one. It also keeps this file from matching itself if the EXEMPT set
 * is ever narrowed.
 */
const DESTINATION_HOSTS = [
  // The separators are PARTS, not a join. The first version of this list joined every host on `\\.` — so it
  // spelled `google.analytics.com`, and the real Measurement Protocol host is `google-analytics.com` with a
  // HYPHEN. Rule 6 therefore did not fire on a planted `https://www.google-analytics.com/mp/collect`, and
  // the scanner reported a clean tree: a rule that cannot see the one endpoint it exists for. Nothing in the
  // scanner's own controls could catch that, because the pattern and any sample built from the same array
  // agree with each other whatever the array says — which is why gate case 137m plants that exact URL.
  ['google', '-', 'analytics', '.', 'com'],
  ['googletagmanager', '.', 'com'],
  ['analytics', '.', 'google', '.', 'com'],
  ['connect', '.', 'facebook', '.', 'net'],
  ['graph', '.', 'facebook', '.', 'com'],
].map((parts) => {
  const host = parts.join('')
  return { host, re: new RegExp(host.replace(/\./g, '\\.'), 'i') }
})

/** Every code the table declares, read OUT of it so this scan cannot drift from the mapping. */
function declaredCodes() {
  const source = readFileSync(CODES, 'utf8')
  const open = source.indexOf('export const EGRESS_CATEGORY_CODES = [')
  const close = open === -1 ? -1 : source.indexOf('] as const', open)
  if (open === -1 || close === -1) return []
  return [...source.slice(open, close).matchAll(/'([A-Z]+_[0-9]{2,})'/g)].map((match) => match[1])
}

/** Every funnel stage, read out of its one home so rule 7 measures against the real tuple. */
function funnelStages() {
  const source = readFileSync(TAXONOMY, 'utf8')
  const open = source.indexOf('export const FUNNEL_STAGES = [')
  const close = open === -1 ? -1 : source.indexOf('] as const', open)
  if (open === -1 || close === -1) return []
  return [...source.slice(open, close).matchAll(/^\s*'([a-z_]+)',\s*$/gm)].map((match) => match[1])
}

const CODES_DECLARED = declaredCodes()
const STAGES = funnelStages()

let scanned = 0
let brandMintsInTheGuard = 0
/** Which declared code-literal allowances were seen to contain one, so a dead allowance cannot linger. */
const codeAllowancesUsed = new Set()
let estateRead = 0

for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }
  for (const file of walk(root)) {
    if (EXEMPT.has(file)) continue
    scanned += 1
    const source = readFileSync(file, 'utf8')
    /** Comments blanked, string CONTENTS blanked. For rules about what a module DOES. */
    const code = stripNonCode(source, { blankStrings: true })
    /**
     * Comments blanked, strings KEPT. Rules 3, 4 and 6 need it: `blankStrings` turns `'SVV_11'` into
     * `'xxxxxx'`, so a rule looking for a code literal would match nothing in the whole tree while
     * reporting a clean scan — ADR 0002's failure inside the check written to prevent a different one.
     * `check-send-chokepoint.mjs`'s control-table rule carries the same note.
     */
    const codeWithStrings = stripNonCode(source)

    // 1. The brand is minted once. A cast is what a type cannot refuse.
    for (const match of code.matchAll(BRAND_MINT)) {
      if (file === GUARD) {
        brandMintsInTheGuard += 1
        continue
      }
      record(
        RULES.brand,
        file,
        lineOf(code, match.index),
        'this casts to EgressPayload, which forges a payload the egress guard never built. The brand is a ' +
          '`unique symbol` precisely so that an object literal cannot satisfy it — a cast is the one way ' +
          `round that, and ${GUARD} contains the only one. A forged payload has had no field allowlist ` +
          'applied, so it can carry a service name, an intake answer or a price on a non-terminal event, ' +
          "and A-MEAS-03's adapters accept it because the type says it is fine. Call buildEgressPayload().",
      )
    }

    // 3. A code spelled anywhere but the table is a second assignment nothing holds equal to it.
    if (CODE_LITERAL_ALLOWED.has(file)) {
      if (CODES_DECLARED.some((declared) => codeReach(declared).test(codeWithStrings))) {
        codeAllowancesUsed.add(file)
      }
    } else {
      for (const declared of CODES_DECLARED) {
        const at = codeWithStrings.search(codeReach(declared))
        if (at === -1) continue
        record(
          RULES.codeLiteral,
          file,
          lineOf(codeWithStrings, at),
          `'${declared}' is a category code written outside ${CODES}, which is a second statement of what ` +
            'it stands for. The two disagree the first time the table is renumbered, and the symptom is ' +
            'not an error: it is two categories reported as one in an ad platform, so one appears never to ' +
            'convert while the other over-reports. Call categoryCodeFor(ref).',
        )
      }
    }

    // 6. A door out of the building, outside the declared adapters. See the header for why this matches
    //    nothing today and is still a rule.
    if (
      !DECLARED_ADAPTERS.has(file) &&
      !CHECKS_THAT_CARRY_EGRESS_PATTERNS.has(file) &&
      !isTestOrSpec(file)
    ) {
      for (const { host, re } of DESTINATION_HOSTS) {
        const found = re.exec(codeWithStrings)
        if (found === null) continue
        record(
          RULES.destination,
          file,
          lineOf(codeWithStrings, found.index),
          `this names ${host}, which is a door out of the building. Every payload that leaves through one ` +
            'is built by the egress guard and carries an opaque category code (ADR 0018: a conversion ' +
            'event naming a treatment is a disclosure). A-MEAS-03 owns the adapters; if this module is ' +
            'one, add it to DECLARED_ADAPTERS with the reason. If it is a CHECK about egress, add it to ' +
            'CHECKS_THAT_CARRY_EGRESS_PATTERNS instead.',
        )
      }
    }
  }
}

// --- 2, 4, 5, 7. the guard estate ----------------------------------------------------------------
for (const path of GUARD_ESTATE) {
  if (!existsSync(path)) {
    record(
      RULES.name,
      path,
      1,
      'is in GUARD_ESTATE and does not exist, so rules 4, 5 and 7 judged nothing.',
    )
    continue
  }
  estateRead += 1
  const source = readFileSync(path, 'utf8')
  const code = stripNonCode(source, { blankStrings: true })
  const codeWithStrings = stripNonCode(source)

  // 4. A name cannot leave a guard it never reaches.
  for (const identifier of NAME_BEARING) {
    const at = codeWithStrings.indexOf(identifier)
    if (at === -1) continue
    record(
      RULES.name,
      path,
      lineOf(codeWithStrings, at),
      `this names ${identifier}, which carries a service name, a menu label or an owner-authored key. The ` +
        'guard maps KEYS and enum members to codes and is never handed a name — that is why CatalogueRef ' +
        'has no name field. A name in scope here is a name that can be copied into a payload by the next ' +
        'edit, and "no service name leaves the building" is cheapest to hold one step earlier: nothing ' +
        'brings one in.',
    )
  }

  // 5. The guard decides what may leave. It never leaves with it.
  for (const { rule, re } of NETWORK_GLOBALS) {
    const found = re.exec(code)
    if (found === null) continue
    record(
      RULES.network,
      path,
      lineOf(code, found.index),
      `"${rule}" reaches the network from the guard. packages/core is pure and this is the half ` +
        'core-must-be-pure cannot hold: a global is not an import, so a module graph has nothing to draw ' +
        'an edge to. The guard judges a payload; a transmitting guard is a guard whose own output nothing ' +
        'else had to accept.',
    )
  }

  // 7. The dispatchable event types are the funnel's, derived.
  for (const stage of STAGES) {
    const at = codeWithStrings.search(new RegExp(`(?<![A-Za-z0-9_])${stage}(?![A-Za-z0-9_])`))
    if (at === -1) continue
    record(
      RULES.eventTypes,
      path,
      lineOf(codeWithStrings, at),
      `'${stage}' is a funnel stage written as a literal. EGRESS_EVENT_TYPES is FUNNEL_STAGES and ` +
        'FUNNEL_TERMINAL_STAGE is read from it, so a ninth stage moves the dispatchable set and the value ' +
        'rule with it (ADR 0046). A literal is the second statement of the order that module exists to ' +
        'prevent, and the two coming apart means the funnel and the ad platforms disagree about what a ' +
        'conversion is.',
    )
  }
}

/**
 * 2. The projection, which is a statement about positions in ONE file.
 *
 * Read from the source rather than asserted in a test for the reason `check-send-chokepoint.mjs` gives about
 * the choke point's order: a behavioural test proves it for the cases it drives, and the mutation that
 * matters here leaves a system that WORKS. Replace the allowlist walk with `...carried` and every existing
 * case still passes — the payload has all the fields it is asserted to have — while every rogue field
 * travels and every drop counter reports zero.
 */
{
  const code = stripNonCode(readFileSync(GUARD, 'utf8'), { blankStrings: true })

  /**
   * The BUILDER's body, not the whole file — and this is a correction, not tidiness.
   *
   * `for (const field of EGRESS_PAYLOAD_FIELDS) {` appears three times in this module: the builder walks the
   * allowlist to project, the serialiser walks it to order the output, and the permitted-vocabulary helper
   * walks it to collect tokens. The first version of this rule used `indexOf` over the whole file, so
   * deleting the builder's walk would have moved the match onto the SERIALISER's — and the rule would have
   * reported the builder as fine while it no longer projected anything. That is brief rule 20's defect
   * ("three gate cases have now edited the wrong construct") arriving inside the scanner meant to prevent
   * its class, and it is why the walk is COUNTED inside the slice rather than found in the file.
   */
  const entry = code.indexOf('export function buildEgressPayload(')
  const bodyEnd = entry === -1 ? -1 : code.indexOf('\n}\n', entry)
  const body = entry === -1 || bodyEnd === -1 ? '' : code.slice(entry, bodyEnd)

  const at = (needle) => body.indexOf(needle)
  const WALK = 'for (const field of EGRESS_PAYLOAD_FIELDS) {'
  const walkAt = at(WALK)
  const walks = body.split(WALK).length - 1
  const requiredAt = at('for (const required of REQUIRED_EGRESS_FIELDS) {')
  const mintAt = at('as unknown as EgressPayload')

  if (body.length < 400) {
    record(
      RULES.projection,
      GUARD,
      1,
      `buildEgressPayload's body could not be read (${body.length} bytes), so every position check below ` +
        'judged nothing. The function was renamed, or its closing brace is no longer at column zero.',
    )
  } else if (walks !== 1) {
    record(
      RULES.projection,
      GUARD,
      walkAt === -1 ? 1 : lineOf(body, walkAt),
      `the builder walks EGRESS_PAYLOAD_FIELDS ${walks} time(s) and must walk it exactly ONCE. Zero means ` +
        'the payload is no longer a projection of the allowlist — whatever it copies now, it is not what ' +
        'this tuple names — and more than one means there are two projections, of which the second is the ' +
        'one that eventually disagrees.',
    )
  } else {
    const missing = [
      ['for (const required of REQUIRED_EGRESS_FIELDS) {', requiredAt],
      ['as unknown as EgressPayload', mintAt],
    ].filter(([, index]) => index === -1)

    if (missing.length > 0) {
      record(
        RULES.projection,
        GUARD,
        1,
        `the builder no longer contains ${missing.map(([name]) => name).join(', ')}. Each is part of what ` +
          'makes a payload a projection rather than a copy: the allowlist is WALKED, the three required ' +
          'fields are proved present, and the brand is minted once at the end. One that is gone is not a ' +
          'refactor.',
      )
    } else if (!(walkAt < requiredAt && requiredAt < mintAt)) {
      record(
        RULES.projection,
        GUARD,
        lineOf(body, Math.min(walkAt, mintAt)),
        'the three steps are out of order. The required order is walk the allowlist -> prove the required ' +
          'fields are present -> mint. A mint before the walk is a payload branded before it was ' +
          `projected. Found at walk=${walkAt}, required=${requiredAt}, mint=${mintAt}.`,
      )
    }
  }

  // The spread ban is over the WHOLE module, not the slice: the serialiser is the other place an extra own
  // key could reach the wire, and `[...permitted]` is not one of these shapes, so nothing legitimate is hit.
  for (const spread of ['...carried', '...candidate', '...subject', '...input', 'Object.assign(']) {
    const found = code.indexOf(spread)
    if (found === -1) continue
    record(
      RULES.projection,
      GUARD,
      lineOf(code, found),
      `\`${spread}\` copies fields into the payload without the allowlist deciding. That is the mutation ` +
        'this rule exists for, and it leaves a system that works: every field a test asserts is present is ' +
        'still present, so no existing case notices, while every rogue field travels and every drop count ' +
        'reads zero. Walk EGRESS_PAYLOAD_FIELDS.',
    )
  }
}

// --- the controls, which come before the verdict -------------------------------------------------
// Every rule above is "nothing matched outside the allowlist", and nothing matches outside the allowlist
// when nothing matches at all (ADR 0002, ADR 0003). Each of these is a fact about the tree that must hold.
const problems = []
if (scanned < 100) {
  problems.push(
    `read only ${scanned} source file(s) across ${ROOTS.join(', ')}: the walk did not resolve.`,
  )
}
if (CODES_DECLARED.length < 40) {
  problems.push(
    `parsed only ${CODES_DECLARED.length} category code(s) out of ${CODES}: the EGRESS_CATEGORY_CODES ` +
      'parser did not match, so rule 3 searched for almost nothing.',
  )
}
if (STAGES.length < 8) {
  problems.push(
    `parsed only ${STAGES.length} funnel stage(s) out of ${TAXONOMY}: the FUNNEL_STAGES parser did not ` +
      'match, so rule 7 searched for almost nothing.',
  )
}
if (brandMintsInTheGuard !== 1) {
  problems.push(
    `${GUARD} mints a branded payload ${brandMintsInTheGuard} time(s) and must mint exactly ONE. Zero ` +
      'means the discriminator has gone stale and rule 1 is searching for a spelling nothing uses; more ' +
      'than one means there is a second construction inside the guard, and the second one is the one that ' +
      'eventually skips the allowlist.',
  )
}
if (estateRead !== GUARD_ESTATE.length) {
  problems.push(
    `read ${estateRead} of ${GUARD_ESTATE.length} guard module(s): rules 4, 5 and 7 judged less than the ` +
      'estate they claim to cover.',
  )
}
for (const [path, reason] of CODE_LITERAL_ALLOWED) {
  if (codeAllowancesUsed.has(path)) continue
  problems.push(
    `${path} is in CODE_LITERAL_ALLOWED ("${reason}") and contains no category code literal, so the ` +
      'allowance excuses nothing and would silently excuse the next thing written there. Remove it.',
  )
}
// The sibling exemptions take the OTHER control, and the difference is the point — see the map's header.
// They are allowed to match nothing; they are not allowed to point at nothing.
for (const [path, reason] of CHECKS_THAT_CARRY_EGRESS_PATTERNS) {
  if (existsSync(path)) continue
  problems.push(
    `${path} is in CHECKS_THAT_CARRY_EGRESS_PATTERNS ("${reason}") and does not exist. The sibling check ` +
      'was renamed or removed, and an exemption pointed at nothing is how an allowance outlives the thing ' +
      'it was written for — the next file to take that path inherits it. Update the entry or drop it.',
  )
}
for (const [path, reason] of DECLARED_ADAPTERS) {
  if (existsSync(path)) continue
  problems.push(`${path} is in DECLARED_ADAPTERS ("${reason}") and does not exist.`)
}
// And the matchers have to DISCRIMINATE, in both directions. The second list is the one that earns its
// place: `HTTP_200` and `ZY055` are the shapes a code-shaped rule would flag if it matched the PATTERN
// instead of the declared set, and this repository is full of the second one.
for (const shouldMatch of [CODES_DECLARED[0], CODES_DECLARED[CODES_DECLARED.length - 1]]) {
  if (shouldMatch === undefined || !/^[A-Z]+_[0-9]{2,}$/.test(shouldMatch)) {
    problems.push(`the code parser returned ${String(shouldMatch)}, which is not a category code.`)
  }
}
// The code REACH, in both directions. Every positive is a spelling this repository actually contains — the
// JSON one is the spelling whose absence made the first version of rule 3 unable to see a code at all.
for (const spelling of [
  "'SVV_02'",
  '"SVV_02"',
  '"categoryCode":"SVV_02"',
  '`SVV_02`',
  ' SVV_02,',
]) {
  if (!codeReach('SVV_02').test(spelling)) {
    problems.push(
      `the code matcher no longer finds SVV_02 in ${spelling}, so rule 3 finds nothing.`,
    )
  }
}
for (const spelling of ['SVV_020', 'MY_SVV_02X', 'xSVV_02', 'SVV_02X']) {
  if (codeReach('SVV_02').test(spelling)) {
    problems.push(
      `the code matcher finds SVV_02 inside ${spelling}, which is a different token — a rule that matches ` +
        'a code as a substring reports files that have nothing to do with this unit.',
    )
  }
}
// The destination hosts must be hostnames and their patterns must match them. This does NOT prove the list
// is complete — a pattern and a sample built from the same array cannot disagree, which is how the missing
// hyphen got through — so the completeness control is gate case 137m, which plants a real endpoint.
if (DESTINATION_HOSTS.length < 5) {
  problems.push(
    `only ${DESTINATION_HOSTS.length} destination host(s) declared: the assembly did not run.`,
  )
}
for (const { host, re } of DESTINATION_HOSTS) {
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) {
    problems.push(`"${host}" is not a hostname, so the parts it was assembled from are wrong.`)
  }
  if (!re.test(`https://www.${host}/collect`)) {
    problems.push(`the pattern for ${host} does not match a URL naming it, so rule 6 cannot fire.`)
  }
}
// Rule 6's file matcher, both ways. The spec suffix is the one that matters: it is not needed yet, so
// nothing else would notice if it stopped working.
for (const exempt of ['a.test.ts', 'a.itest.ts', 'apps/web/e2e/consent.spec.ts']) {
  if (!isTestOrSpec(exempt))
    problems.push(`rule 6 no longer exempts ${exempt}, so a spec cannot name a host.`)
}
for (const covered of ['apps/web/app/api/collect/route.ts', 'scripts/seed.mjs', 'a.spec.tsx']) {
  if (isTestOrSpec(covered)) {
    problems.push(
      `rule 6 exempts ${covered}, which is shipped code — the rule then covers almost nothing.`,
    )
  }
}
for (const shouldNotMatch of ['HTTP_200', 'ZY055', 'ZY191', 'SVC_99', 'PKG_00']) {
  if (CODES_DECLARED.includes(shouldNotMatch)) {
    problems.push(
      `the declared code set contains ${shouldNotMatch}, which is a private SQLSTATE, an HTTP status or an ` +
        'undeclared code — rule 3 would then report files that have nothing to do with this unit.',
    )
  }
}

if (problems.length > 0) {
  console.error('Egress guard scanner did not read what it thinks it read:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    `\n${problems.length} problem(s). Every rule here is a difference against an allowlist, and a ` +
      'difference against nothing is empty — so this is reported as a failure rather than as a clean tree.',
  )
  process.exit(1)
}

if (violations.length > 0) {
  console.error('Egress guard violations:\n')
  for (const violation of violations) {
    console.error(`  ${violation.rule}`)
    console.error(`    ${violation.where}  ${violation.detail}`)
  }
  console.error(
    `\n${violations.length} violation(s). A conversion event naming a treatment is a health disclosure ` +
      'to Google or Meta (docs/01 decision 14, ADR 0018), and "Arabic Hot Oil Massage" is commercially ' +
      'sensitive on its own (docs/03).',
  )
  process.exit(1)
}

console.log(
  `Every external analytics payload is built by the egress guard: ${scanned} files scanned across ` +
    `${ROOTS.join(', ')}, ${CODES_DECLARED.length} category code(s) written only in ${CODES} and ` +
    `${CODE_LITERAL_ALLOWED.size - 1} declared reader(s), the brand minted once in ${GUARD} after the ` +
    `allowlist walk, ${GUARD_ESTATE.length} guard module(s) holding no catalogue name and reaching no ` +
    `network global, ${STAGES.length} funnel stage(s) derived rather than copied, and ` +
    `${DECLARED_ADAPTERS.size} declared adapter(s) naming a destination host ` +
    `(${CHECKS_THAT_CARRY_EGRESS_PATTERNS.size} sibling check(s) exempted by name).`,
)
