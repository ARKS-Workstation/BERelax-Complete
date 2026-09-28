#!/usr/bin/env node
/**
 * There is no way to file a tax return from this codebase, and this is the proof rather than the promise.
 *
 * docs/01 decision 13 and ADR 0017: *"No auto-file capability in the codebase — absent, not disabled"*,
 * with the reason stated as *"a flag keeping auto-file off will eventually be switched on by a future
 * maintainer"*. docs/04 §4 repeats it. Both are prose, and prose is what this file replaces: an absence is
 * a claim about what the build CANNOT do, so the only honest form of it is a check that FAILS on the day
 * the ability appears. ADR 0052 records the decision; this is the mechanism.
 *
 * Four scans, each answering a question the others cannot:
 *
 *   1. **The name, everywhere.** No identifier in the tree may be one a filing path would be called.
 *      Repository-wide rather than over the tax estate, because a submission helper is exactly the kind
 *      of thing that gets written next to the thing that needs it — a route, a job, a script — and a scan
 *      bounded to `packages/core/src/tax` would be blind to every one of those places.
 *   2. **The network-capable globals, over the tax estate.** `fetch` is a global, so
 *      `tax-and-filing-must-not-reach-the-network` in `.dependency-cruiser.cjs` cannot see it at all: a
 *      module graph has nothing to draw an edge to. This is the half of that rule the module graph cannot
 *      hold, and the payments rule records the same division of labour two rules above it.
 *   3. **The export reads no credentials.** `zoho-export.ts` may not touch `process`, the environment or
 *      `@berelax/config`. The acceptance line is that the export "succeeds with no environment variables
 *      or credentials set", and `zoho-export.itest.ts` runs it with the environment emptied — this is the
 *      structural half, because a behavioural test proves it for the path it took and a scan proves it for
 *      the file.
 *   4. **The boundary rule still covers the estate.** The list of modules is written down HERE and the
 *      rule is written down THERE, so the failure mode is one of them being narrowed while the other still
 *      names the file. The rule's own `from.path` is read out of the config and required to match every
 *      file this script scans.
 *
 * ## What this cannot catch, stated rather than left to be found
 *
 * A grep over names catches the honest addition and not a determined evasion: `submitVatReturn` has `Vat`
 * between the two words the pattern joins, and `e-file` spelled with a hyphen is not in the pattern at all.
 * That is not an argument for a cleverer regex — it is why the pattern is only one of the four scans. What
 * closes the hole is scan 2 and the boundary rule: a filing path has to reach the network under SOME name,
 * and reaching the network is what neither of those permits. The pattern is deliberately the one the
 * acceptance criterion names, character for character, rather than a wider one this script invented.
 *
 * The known-bad fixtures are in `scripts/test-gates.mjs` block 130.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const require = createRequire(import.meta.url)

const problems = []

/** The rule names a known-bad fixture asserts against, so a case fails BY NAME and not by exit code. */
const RULES = {
  identifier: 'no-autofile-identifier',
  networkGlobal: 'no-autofile-network-global',
  credentials: 'no-autofile-export-reads-no-credentials',
  oneWay: 'no-autofile-export-is-one-way',
  throughTheDoor: 'no-autofile-export-goes-through-the-filing-door',
  boundary: 'no-autofile-boundary-covers-the-estate',
}

/**
 * The forbidden identifier pattern, character for character as M-VAT-09's acceptance line states it.
 *
 * Not widened, and the restraint is deliberate: this pattern is a SPECIFICATION, quoted in ADR 0052 and in
 * the manifest, and a script that quietly enforced something broader would make the two disagree in the
 * direction nobody checks. Where it is porous is written down in the header above and in the ADR.
 */
const FORBIDDEN_IDENTIFIER = /(auto[_-]?file|submitReturn|fta[_-]?api|efile|file[_-]?return)/i

/**
 * This gate's own name, which is a reference TO the prohibition and not an instance of it.
 *
 * `scripts/test-no-autofile.mjs` and the `pnpm no-autofile` step are the check; every comment, gate case and
 * CI line that cites them contains the token, and the first run of this scan flagged the module the gate
 * protects for naming its own gate. Exempting the FILE would have been the wrong fix — it is the one file
 * where a filing capability would be most at home — so the exemption is this token and only when it is the
 * whole token: `autofileSomething` and `test-no-autofile-and-submit` are both still violations.
 */
const SELF_REFERENCE = new Set(['no-autofile', 'test-no-autofile'])

/**
 * Files exempt from scan 1, and why each one is.
 *
 * Declared with a reason for `check-gate-registry.mjs`'s reason, and `no-invoice-mutation`'s: "it is a
 * script" or "it is a comment" is exactly the condition a smuggled filing helper also satisfies, so an
 * allowance that guessed would let the defect through as an exception. Every entry is asserted to be USED
 * at the bottom of this file, because an exemption that excuses nothing is a hole waiting for the next
 * thing written there.
 */
const IDENTIFIER_ALLOWED = new Map([
  ['scripts/test-no-autofile.mjs', 'this file: the pattern it searches for is written out in it'],
  [
    'scripts/test-gates.mjs',
    'holds the known-bad fixtures for this gate, which must contain the strings it rejects',
  ],
  [
    'packages/db/migrations/0052_obligation.sql',
    'states in a comment that the system "contains no auto-file capability" — the sentence this gate ' +
      'is the enforcement of, and a migration is a record of what was applied rather than a file to edit',
  ],
])

/**
 * The tax estate: every module where a filing capability would have to be written to be any use.
 *
 * Named rather than inferred from a pattern, and the same list is the `from` of
 * `tax-and-filing-must-not-reach-the-network`. Scan 4 is what holds the two equal. `packages/core/src/tax`
 * is walked because it is a directory that grows; the three db modules are named because they are the
 * working paper, the sealed return and the export — the whole path a figure travels from the ledger to the
 * file an accountant is handed.
 */
const ESTATE_DIRS = ['packages/core/src/tax']
const ESTATE_FILES = [
  'packages/db/src/queries/vat201-working-papers.ts',
  'packages/db/src/services/vat-return-signoff.ts',
  'packages/db/src/services/zoho-export.ts',
]

/** The one module that produces the export bytes. Scans 3 and 4 are about this file in particular. */
const EXPORT_MODULE = 'packages/db/src/services/zoho-export.ts'

/** The boundary rule whose `from` must still cover the estate, read out of the config by scan 4. */
const BOUNDARY_CONFIG = '.dependency-cruiser.cjs'
const BOUNDARY_RULE = 'tax-and-filing-must-not-reach-the-network'
/**
 * A path the rule must NOT claim, so scan 4 measures TARGETING and not merely a regex that matched.
 *
 * `manual-payment.ts` has its own network prohibition two rules above this one. A `from.path` widened to
 * `^packages/` would satisfy "covers the estate" while saying nothing about whether the estate is what it
 * is aimed at, and a rule that covers everything is the shape `pnpm boundaries` was reduced to the one time
 * it silently stopped working (ADR 0002).
 */
const BOUNDARY_MUST_NOT_CLAIM = 'packages/db/src/adapters/manual-payment.ts'

/**
 * Network-capable globals. A module graph is blind to every one of them.
 *
 * `fetch(` rather than `fetch` on its own: the word appears in prose all over this repository — the SEO
 * agent's inputs are "fetched competitor HTML" in three separate comments — and a gate that fires on a
 * comment is a gate somebody switches off.
 */
const NETWORK_GLOBALS = [
  { rule: 'fetch(', re: /(?<![\w$.])fetch\s*\(/ },
  { rule: 'globalThis.fetch', re: /globalThis\s*\.\s*fetch/ },
  { rule: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/ },
  { rule: 'WebSocket', re: /\bWebSocket\b/ },
  { rule: 'EventSource', re: /\bEventSource\b/ },
  { rule: 'sendBeacon', re: /\bsendBeacon\b/ },
]

/** Credential and environment reaches. The export takes its arguments and reads nothing ambient. */
const CREDENTIAL_REACHES = [
  { rule: 'process.env', re: /process\s*\.\s*env/ },
  { rule: 'process', re: /(?<![\w$.])process(?![\w$])/ },
  { rule: '@berelax/config', re: /@berelax\/config/ },
]

/**
 * The door the export must come through, and the two shapes of going round it.
 *
 * `vat_return_for_filing()` raises `ZY055` for a return that is not signed and final — on a READ, which is
 * the only layer that can refuse an operation whose whole content is reading. So the export must reach the
 * figures THROUGH it, and the way it would stop doing that is not a deleted check: it is one raw query. A
 * `select … from vat_return` in this module answers the same question without the refusal, and the base
 * table is deliberately readable because a preparer has to see what they are about to sign (0095's header).
 *
 * So the module holds no SQL at all. That is a stronger claim than "no SQL against those tables" and a much
 * easier one to check: there is no query to inspect, no table list to keep in step, and any read it makes is
 * necessarily through a function that can refuse.
 */
const SQL_REACHES = [
  { rule: 'uow.sql`', re: /\buow\s*\.\s*sql\s*[`<]/ },
  { rule: 'sql`', re: /(?<![\w$.])sql\s*[`<]/ },
  { rule: 'sql.unsafe', re: /\bsql\s*\.\s*unsafe\b/ },
]
/** And the door has to be USED, or the rule above passes for a module that reads nothing at all. */
const DOOR_CALL = 'vatReturnForFiling('

/**
 * Name segments that would make the export two-way.
 *
 * The acceptance line is "the module exposes no read path from Zoho", and this is the enumeration of its
 * export surface that makes it a check. Stems rather than whole words, for `no-invoice-mutation`'s reason:
 * `importing` and `imported` are the same reach as `import`.
 */
const INBOUND_VERB_STEMS = ['import', 'fetch', 'pull', 'poll', 'download', 'receive', 'sync']

/** Every file under `dir`, recursively. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist' || name === '.git') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

/**
 * The segments of an identifier, as `[start, end)` ranges over the ORIGINAL string.
 *
 * Ranges rather than the substrings, because what scan 1 needs is not "which words are in this name" but
 * "does the match line up with them". A substring match for `efile` hits `writeFileSync` at the `e` that
 * ends `write`, `sourceFiles` at the `e` that ends `source` and `parseCaptureFilename` at the `e` that ends
 * `Capture` — three names this repository uses 40-odd times between them. Anchoring the match to a segment
 * boundary at BOTH ends is what tells `efile` apart from `…eFile…`, and it is why this is not a `grep`.
 */
function segmentRanges(token) {
  const ranges = []
  let start = -1
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i]
    if (ch === '_' || ch === '-') {
      if (start !== -1) ranges.push([start, i])
      start = -1
      continue
    }
    if (start === -1) {
      start = i
      continue
    }
    const previous = token[i - 1]
    const next = token[i + 1]
    // A camel boundary is two shapes, not one: `fileReturn` (lower then upper) and `FTAApi` (upper then
    // upper-followed-by-lower). Without the second, an acronym prefix swallows the word after it.
    const isBoundary =
      /[A-Z]/.test(ch) &&
      (/[a-z0-9]/.test(previous) ||
        (/[A-Z]/.test(previous) && next !== undefined && /[a-z]/.test(next)))
    if (isBoundary) {
      ranges.push([start, i])
      start = i
    }
  }
  if (start !== -1) ranges.push([start, token.length])
  return ranges
}

/**
 * The forbidden term an identifier carries, or undefined.
 *
 * The match must begin where a segment begins and end where a segment ends. See {@link segmentRanges}.
 */
function forbiddenTermIn(token) {
  const match = FORBIDDEN_IDENTIFIER.exec(token)
  if (match === null) return undefined
  const from = match.index
  const to = from + match[0].length
  const ranges = segmentRanges(token)
  const aligned = ranges.some(([start]) => start === from) && ranges.some(([, end]) => end === to)
  return aligned ? match[0] : undefined
}

/**
 * The identifier-shaped tokens in a blob of text.
 *
 * `-` is a token character although no JavaScript identifier contains one, and that is the case the
 * hyphen is here for: a route path (`/api/auto-file`), a CSS class and a kebab-cased SQL label are all
 * places a filing capability can be named, and `auto[_-]?file` in the pattern says the spelling counts.
 */
const tokensOf = (text) => text.match(/[A-Za-z0-9_$-]+/g) ?? []

/**
 * The names a module exports, read from source.
 *
 * Copied from `scripts/test-no-invoice-mutation.mjs` rather than shared, for the reason stated there: both
 * are node scripts with no import of the workspace, and a module they both imported would have to live in a
 * package one of them may not depend on.
 */
function exportedNames(source) {
  const names = new Set()
  const declaration =
    /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of source.matchAll(declaration)) names.add(match[1])
  for (const list of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of list[1].split(',')) {
      const text = entry.trim().replace(/^type\s+/, '')
      if (text === '') continue
      const parts = text.split(/\s+as\s+/)
      const name = (parts.at(-1) ?? '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name)
    }
  }
  return names
}

const inboundVerbIn = (name) => {
  for (const [start, end] of segmentRanges(name)) {
    const segment = name.slice(start, end).toLowerCase()
    const stem = INBOUND_VERB_STEMS.find((verb) => segment.startsWith(verb))
    if (stem !== undefined) return stem
  }
  return undefined
}

// --- 1. the name, everywhere ---------------------------------------------------------------------
const scanned = ['packages', 'apps', 'scripts'].flatMap((root) => walk(root))
const sources = scanned.filter((path) => /\.(ts|tsx|mjs|sql)$/.test(path))

let tokensScanned = 0
/** Which declared allowances were actually seen to contain one, so a dead exemption cannot linger. */
const allowancesUsed = new Set()
for (const path of sources) {
  const allowed = IDENTIFIER_ALLOWED.has(path)
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const [index, line] of lines.entries()) {
    for (const token of tokensOf(line)) {
      tokensScanned += 1
      if (SELF_REFERENCE.has(token.toLowerCase())) continue
      const term = forbiddenTermIn(token)
      if (term === undefined) continue
      if (allowed) {
        allowancesUsed.add(path)
        continue
      }
      problems.push(
        `${path}:${index + 1}  ${RULES.identifier}: "${token}" carries "${term}". This codebase has no ` +
          'capability to file a tax return and the absence is structural (ADR 0017, ADR 0052): the ' +
          'taxable person carries the liability, and a capability held back by a flag is one a future ' +
          'maintainer switches on. If this name is a known-bad fixture or a comment about the absence, ' +
          'add the file to IDENTIFIER_ALLOWED with a reason.',
      )
    }
  }
}

// --- 2, 3, 4. the estate ------------------------------------------------------------------------
const estate = [...ESTATE_DIRS.flatMap((dir) => walk(dir)), ...ESTATE_FILES].filter(
  (path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.itest.ts'),
)

for (const path of estate) {
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const [index, line] of lines.entries()) {
    for (const { rule, re } of NETWORK_GLOBALS) {
      if (!re.test(line)) continue
      problems.push(
        `${path}:${index + 1}  ${RULES.networkGlobal}: "${rule}". ` +
          `${BOUNDARY_RULE} cannot see a global — a module graph has nothing to draw an edge to — so ` +
          'this scan is the half of that rule the boundary gate cannot hold. The tax modules reach no ' +
          'network under any name.',
      )
    }
    if (path !== EXPORT_MODULE) continue
    for (const { rule, re } of CREDENTIAL_REACHES) {
      if (!re.test(line)) continue
      problems.push(
        `${path}:${index + 1}  ${RULES.credentials}: "${rule}". The export takes everything it needs as ` +
          'an argument and reads nothing ambient: its acceptance line is that it "succeeds with no ' +
          'environment variables or credentials set", and a module that reads one has somewhere for a ' +
          'credential to arrive.',
      )
    }
  }
}

/** The export surface of the one module that produces the bytes, which must be one-way. */
let exportsScanned = 0
{
  const source = readFileSync(EXPORT_MODULE, 'utf8')
  for (const [index, text] of source.split('\n').entries()) {
    for (const { rule, re } of SQL_REACHES) {
      if (!re.test(text)) continue
      problems.push(
        `${EXPORT_MODULE}:${index + 1}  ${RULES.throughTheDoor}: "${rule}". The export reaches the ` +
          'figures through vat_return_for_filing(), which raises ZY055 for a return that is not signed ' +
          'and final. A raw query answers the same question without the refusal, and `vat_return` is ' +
          'deliberately readable because a preparer has to see what they are about to sign.',
      )
    }
  }
  if (!source.includes(DOOR_CALL)) {
    problems.push(
      `${EXPORT_MODULE} never calls ${DOOR_CALL} (${RULES.throughTheDoor}). The rule above is satisfied ` +
        'by a module that reads nothing at all, so the door has to be seen to be used: without this, an ' +
        'export rewritten to take its figures from its caller would pass every scan here.',
    )
  }
  for (const name of exportedNames(source)) {
    exportsScanned += 1
    const verb = inboundVerbIn(name)
    if (verb === undefined) continue
    problems.push(
      `${EXPORT_MODULE}  ${RULES.oneWay}: exports "${name}", whose name carries "${verb}". The export ` +
        'is one-way by construction: nothing is read back from the accounting package, so there is no ' +
        'path by which a figure it holds can become a figure this system reports.',
    )
  }
}

/**
 * Scan 4: the boundary rule's own `from`, applied to the estate.
 *
 * The config is REQUIRED rather than parsed out of its own text, and the first version of this scan is why.
 * A text scrape returned `vat201-working-papers\\.ts` — the two characters the file contains, because a JS
 * string literal's `\\.` is one backslash in the value — so `new RegExp` on it demanded a literal backslash
 * in the path, matched none of the three db modules, and reported the rule as not covering files it covers
 * perfectly well. The config is a CommonJS module of plain data with no side effects; requiring it gets the
 * REAL `from`, and there is no escaping, no bracket-matching and no next-rule bleed to get wrong.
 *
 * `pathNot` is applied too, and in dependency-cruiser's own order: a rule whose `from.path` matched every
 * estate file while its `pathNot` excluded them all would be exactly the dead rule this scan exists to
 * find.
 */
let boundaryCovers = 0
{
  /** @type {{ forbidden?: readonly { name?: string, from?: { path?: string, pathNot?: string } }[] }} */
  const config = require(resolve(process.cwd(), BOUNDARY_CONFIG))
  const rule = (config.forbidden ?? []).find((entry) => entry.name === BOUNDARY_RULE)
  const declared = rule?.from?.path
  if (rule === undefined) {
    problems.push(
      `${BOUNDARY_CONFIG} has no rule named ${BOUNDARY_RULE}, so the tax estate is covered by nothing ` +
        `(${RULES.boundary}).`,
    )
  } else if (typeof declared !== 'string' || declared === '') {
    problems.push(
      `${BOUNDARY_RULE} in ${BOUNDARY_CONFIG} declares no from.path, so it applies to every module or to ` +
        `none and either way it is not the rule this scan is about (${RULES.boundary}).`,
    )
  } else {
    const from = new RegExp(declared)
    const exempt = rule.from?.pathNot === undefined ? null : new RegExp(rule.from.pathNot)
    const covers = (path) => from.test(path) && !(exempt?.test(path) ?? false)
    for (const path of estate) {
      if (covers(path)) {
        boundaryCovers += 1
        continue
      }
      problems.push(
        `${path} is in this script's estate and is NOT covered by ${BOUNDARY_RULE} in ` +
          `${BOUNDARY_CONFIG}, so it may import an HTTP client with nothing refusing it ` +
          `(${RULES.boundary}).`,
      )
    }
    if (covers(BOUNDARY_MUST_NOT_CLAIM)) {
      problems.push(
        `${BOUNDARY_RULE} also covers ${BOUNDARY_MUST_NOT_CLAIM}, which has its own network ` +
          'prohibition. A rule broad enough to claim everything says nothing about whether it is aimed ' +
          `at the tax estate (${RULES.boundary}).`,
      )
    }
  }
}

// --- the controls, which come before the verdict ------------------------------------------------
// Every scan above reports nothing when it reads nothing, which is the exact shape of a gate that has
// quietly died (ADR 0002). Each of these is a fact about the tree that must hold.
if (sources.length < 500) {
  problems.push(`read only ${sources.length} source file(s): the tree walk did not resolve.`)
}
if (tokensScanned < 500_000) {
  problems.push(`read only ${tokensScanned} identifier(s): the tokeniser did not match.`)
}
if (estate.length < 5) {
  problems.push(
    `read only ${estate.length} tax module(s): the estate list did not resolve, so scans 2, 3 and 4 ` +
      'judged almost nothing.',
  )
}
if (boundaryCovers < estate.length) {
  problems.push(
    `${BOUNDARY_RULE} was seen to cover only ${boundaryCovers} of ${estate.length} tax module(s), so the ` +
      'boundary half of this unit is not held over all of them.',
  )
}
// The self-reference exception has to stay EXACT, or it becomes the hole it was written to avoid.
for (const token of ['autofile', 'auto-file', 'no-autofile-and-submit', 'autofileReturn']) {
  if (SELF_REFERENCE.has(token.toLowerCase())) {
    problems.push(
      `SELF_REFERENCE excuses "${token}", which is a capability rather than a citation of this gate.`,
    )
  }
}
if (exportsScanned < 5) {
  problems.push(
    `read only ${exportsScanned} export(s) from ${EXPORT_MODULE}: the export parser did not match, so ` +
      'the one-way claim was not checked.',
  )
}
// The matcher has to DISCRIMINATE, in both directions, and the second list is the one that earns its
// place: every one of those names is in this repository, and a substring matcher flags all four.
for (const name of [
  'autoFile',
  'auto_file',
  'auto-file',
  'autofile',
  'submitReturn',
  'ftaApi',
  'FTA_API',
  'efile',
  'fileReturn',
  'file_return',
]) {
  if (forbiddenTermIn(name) === undefined) {
    problems.push(`the identifier matcher no longer flags "${name}", so it flags nothing.`)
  }
}
for (const name of [
  'writeFileSync',
  'readFileSync',
  'sourceFiles',
  'captureFilename',
  'parseCaptureFilename',
  'profileId',
  'zoho-export',
  'vatReturnForFiling',
]) {
  if (forbiddenTermIn(name) !== undefined) {
    problems.push(
      `the identifier matcher flags "${name}", which is a name this repository legitimately uses.`,
    )
  }
}
// And the one-way matcher, the same way round: `snapshotJson` must not read as a reach for `sync`.
for (const name of ['importFromZoho', 'fetchReturn', 'pollStatus', 'syncLedger']) {
  if (inboundVerbIn(name) === undefined) {
    problems.push(`the one-way matcher no longer flags "${name}", so it flags nothing.`)
  }
}
for (const name of ['exportVatReturnForZoho', 'renderZohoVatReturn', 'ZOHO_EXPORT_SURFACE']) {
  if (inboundVerbIn(name) !== undefined) {
    problems.push(`the one-way matcher flags "${name}", which is a name the export needs.`)
  }
}
// And the SQL matcher, which is the one that would most easily become a no-op: the shapes it exists for,
// and the shapes it must tolerate — a comment naming the function, and the argument being PASSED to it.
for (const text of [
  'const [row] = await uow.sql`select 1`',
  'const rows = await sql<{ n: string }[]>`select 1 as n`',
  'const columns = sql.unsafe(ROW_COLUMNS)',
]) {
  if (!SQL_REACHES.some(({ re }) => re.test(text))) {
    problems.push(`the SQL matcher no longer flags "${text}", so it flags nothing.`)
  }
}
for (const text of [
  'const filing = await vatReturnForFiling(uow.sql, input.returnId)',
  ' * and the refusal is ZY055 raised inside vat_return_for_filing().',
]) {
  if (SQL_REACHES.some(({ re }) => re.test(text))) {
    problems.push(`the SQL matcher flags "${text}", which the export legitimately contains.`)
  }
}
// A declared allowance that matches nothing is a hole waiting for a filing helper to be dropped into it:
// the file was renamed, or the comment it excused was rewritten, and the exemption outlived both.
for (const [path, reason] of IDENTIFIER_ALLOWED) {
  if (allowancesUsed.has(path)) continue
  problems.push(
    `${path} is in IDENTIFIER_ALLOWED ("${reason}") and carries no forbidden identifier, so the ` +
      'allowance excuses nothing and would silently excuse the next thing written there. Remove it.',
  )
}

if (problems.length > 0) {
  console.error(`No auto-file — ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(
  `No auto-file: ${tokensScanned} identifier(s) across ${sources.length} source file(s) carry none of ` +
    `${FORBIDDEN_IDENTIFIER.source} outside the ${IDENTIFIER_ALLOWED.size} declared allowance(s); ` +
    `${estate.length} tax module(s) reach no network global, all of them covered by ${BOUNDARY_RULE}; ` +
    `and ${exportsScanned} export(s) of ${EXPORT_MODULE} offer no read path back.`,
)
