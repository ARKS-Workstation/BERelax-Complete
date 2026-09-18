#!/usr/bin/env node
/**
 * The offline half of dependency vulnerability scanning.
 *
 * **Split, deliberately.** `pnpm audit` has to reach registry.npmjs.org, and `pnpm verify` runs on
 * every unit by every agent — behind a proxy, in a sandbox, on a plane. A gate that needs the network
 * is a gate that gets commented out, and then the check nobody runs is indistinguishable from the
 * check that does not exist. So: this gate matches the resolved graph against `build/advisories.json`,
 * a dated snapshot committed to the repository, and CI runs `pnpm audit:online` separately against the
 * live advisory database. When the online step reports something new, it is written into the snapshot
 * and either fixed or accepted here — which also means the snapshot is a record of what this
 * repository has been told about itself, rather than a cache.
 *
 * What it checks:
 *
 *  - **The resolved graph**, from `pnpm-lock.yaml`. `dompurify@3.4.8` carries four advisories and is
 *    six edges from anything declared, inside Payload's admin editor; nothing in a workspace manifest
 *    mentions it.
 *  - **Declared specifiers**, from every workspace manifest, at the floor of the range. A manifest that
 *    asks for a version already known to be vulnerable is caught before `pnpm install` resolves it.
 *  - **The allowlist's own hygiene.** Every entry needs a dated `expires`; an entry with no expiry, an
 *    expired entry, and an expiry further out than `maxHorizonDays` all fail. An entry for a
 *    **critical** advisory fails outright: a date does not make a critical finding acceptable, and the
 *    remedy is to remove the dependency.
 *
 * Usage: `node scripts/check-dependencies.mjs [--snapshot build/advisories.json]
 *        [--allowlist build/advisory-allowlist.json]`
 * The flags exist so the known-bad fixtures can run the real graph against an empty or malformed
 * allowlist. `pnpm deps` and CI pass no flags.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, readLockfile, resolveClosure, workspaceManifests } from './lib/dependency-graph.mjs'

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const SNAPSHOT_PATH = flag('snapshot', 'build/advisories.json')
const ALLOWLIST_PATH = flag('allowlist', 'build/advisory-allowlist.json')

/**
 * ADR 0003's floor. `pnpm boundaries` once cruised zero modules and reported success; a lockfile
 * reader that silently resolved nothing would report a clean tree for exactly the same reason.
 */
const MINIMUM_GRAPH = 400

const snapshot = JSON.parse(readFileSync(join(ROOT, SNAPSHOT_PATH), 'utf8'))
const allowlist = JSON.parse(readFileSync(join(ROOT, ALLOWLIST_PATH), 'utf8'))
const advisories = [...(snapshot.observed ?? []), ...(snapshot.neverAgain ?? [])]
const entries = allowlist.entries ?? []
const problems = []

const TODAY = new Date().toISOString().slice(0, 10)
const DATE = /^\d{4}-\d{2}-\d{2}$/
const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000)

/** A version as a comparable triple, plus whether it carries a prerelease tag. */
function parseVersion(text) {
  const trimmed = String(text).trim().replace(/^v/, '')
  const [core, ...rest] = trimmed.split('-')
  const parts = core.split('.').map((part) => Number.parseInt(part, 10))
  return {
    triple: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0],
    prerelease: rest.length > 0,
  }
}

/** `1.2.6-rc.1` sorts *below* `1.2.6`, so a prerelease of a fix is not mistaken for the fix. */
function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (let i = 0; i < 3; i += 1) {
    const l = left.triple[i] ?? 0
    const r = right.triple[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  if (left.prerelease === right.prerelease) return 0
  return left.prerelease ? -1 : 1
}

/**
 * Advisory ranges only, which is why this is fifty lines and not a semver dependency: GitHub states
 * them as comparators (`<0.2.4`, `>=1.0.0 <1.2.6`, `=3.3.6`), joined by spaces for AND and `||` for
 * OR. It never emits `^` or `~`, and a malformed range is refused below rather than quietly matching
 * nothing.
 */
const COMPARATOR = /^(<=|>=|<|>|=)?\s*([0-9][0-9A-Za-z.+-]*)$/
function satisfies(version, range) {
  return range.split('||').some((clause) => {
    const comparators = clause.trim().split(/\s+/).filter(Boolean)
    if (comparators.length === 0) return false
    return comparators.every((text) => {
      const parsed = text.match(COMPARATOR)
      if (parsed === null) return false
      const order = compareVersions(version, parsed[2])
      switch (parsed[1] ?? '=') {
        case '<':
          return order < 0
        case '<=':
          return order <= 0
        case '>':
          return order > 0
        case '>=':
          return order >= 0
        default:
          return order === 0
      }
    })
  })
}

const rangeIsParseable = (range) =>
  String(range)
    .split('||')
    .every((clause) => {
      const comparators = clause.trim().split(/\s+/).filter(Boolean)
      return comparators.length > 0 && comparators.every((text) => COMPARATOR.test(text))
    })

for (const [index, advisory] of advisories.entries()) {
  const at = `${SNAPSHOT_PATH}[${index}]`
  if (
    typeof advisory.id !== 'string' ||
    typeof advisory.package !== 'string' ||
    typeof advisory.severity !== 'string'
  ) {
    problems.push(`${at}  [malformed-advisory] needs \`id\`, \`package\` and \`severity\``)
    continue
  }
  if (!rangeIsParseable(advisory.vulnerable)) {
    problems.push(
      `${at}  [malformed-advisory] ${advisory.id}'s \`vulnerable\` range ` +
        `${JSON.stringify(advisory.vulnerable)} is not a comparator set this gate can evaluate — ` +
        'it would silently match nothing',
    )
  }
}

if (!DATE.test(snapshot.capturedAt ?? '')) {
  problems.push(`${SNAPSHOT_PATH}  [malformed-advisory] \`capturedAt\` must be a YYYY-MM-DD date`)
} else if (snapshot.capturedAt > TODAY) {
  problems.push(
    `${SNAPSHOT_PATH}  [snapshot-captured-in-the-future] \`capturedAt\` is ${snapshot.capturedAt}`,
  )
}

// --- the resolved graph, and the declared specifiers ------------------------------------------------

const lock = readLockfile()
const graph = resolveClosure(lock, [...lock.importers.keys()], { includeDev: true })
if (graph.found.size < MINIMUM_GRAPH) {
  problems.push(
    `[empty-graph] the lockfile resolved to ${graph.found.size} packages, below the floor of ` +
      `${MINIMUM_GRAPH}. The walk is broken, not the tree.`,
  )
}

const findings = []
for (const advisory of advisories) {
  if (!rangeIsParseable(advisory.vulnerable)) continue
  for (const [id, { name, version, trail }] of graph.found) {
    if (name !== advisory.package || !satisfies(version, advisory.vulnerable)) continue
    findings.push({
      advisory,
      where: 'pnpm-lock.yaml',
      subject: id,
      how: `resolved via ${trail.join(' > ')}`,
    })
  }
}

/** The floor of a specifier: what `^1.2.0` could resolve to at its lowest. Ranges and tags are skipped. */
function specifierFloor(specifier) {
  const text = String(specifier).trim()
  if (text === '' || /^(workspace:|catalog:|npm:|file:|link:|git|https?:)/.test(text))
    return undefined
  if (/^[*x]$|^latest$/i.test(text)) return undefined
  if (text.includes('||') || text.includes(' - ')) return undefined
  const floor = text.replace(/^[~^>=<v\s]+/, '')
  return /^\d+\.\d+/.test(floor) ? floor : undefined
}

for (const { path, manifest } of workspaceManifests()) {
  const declared = new Map()
  for (const group of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, specifier] of Object.entries(manifest[group] ?? {})) {
      declared.set(`${group}/${name}`, { name, specifier })
    }
  }
  for (const [, { name, specifier }] of declared) {
    const floor = specifierFloor(specifier)
    if (floor === undefined) continue
    for (const advisory of advisories) {
      if (advisory.package !== name || !rangeIsParseable(advisory.vulnerable)) continue
      if (!satisfies(floor, advisory.vulnerable)) continue
      findings.push({
        advisory,
        where: path,
        subject: `${name}@${specifier}`,
        how: `declared specifier, whose floor ${floor} is inside the vulnerable range`,
      })
    }
  }
}

// --- the allowlist ----------------------------------------------------------------------------------

const live = new Set()
const horizon = allowlist.maxHorizonDays ?? 365
for (const [index, entry] of entries.entries()) {
  const at = `${ALLOWLIST_PATH}[${index}]`
  const label = `${entry.id ?? '?'} (${entry.package ?? '?'})`
  const advisory = advisories.find((candidate) => candidate.id === entry.id)
  if (advisory === undefined) {
    problems.push(
      `${at}  [unknown-allowlist-entry] ${label} is not in ${SNAPSHOT_PATH} — an entry that names no ` +
        'advisory accepts nothing and hides the fact that nothing is being accepted',
    )
    continue
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 40) {
    problems.push(
      `${at}  [allowlist-entry-without-reason] ${label} needs a reason naming the path and why it is ` +
        'unreachable or unfixable',
    )
  }
  if (!DATE.test(entry.expires ?? '')) {
    problems.push(
      `${at}  [allowlist-entry-without-expiry] ${label} has no dated \`expires\` (YYYY-MM-DD). ` +
        'Accepting a live vulnerability is a decision with a shelf life.',
    )
  } else if (entry.expires < TODAY) {
    problems.push(
      `${at}  [allowlist-entry-expired] ${label} expired on ${entry.expires}, ` +
        `${days(entry.expires, TODAY)} day(s) ago — fix it, or re-review and re-date it`,
    )
  } else if (days(TODAY, entry.expires) > horizon) {
    problems.push(
      `${at}  [allowlist-expiry-too-far] ${label} expires ${entry.expires}, ` +
        `${days(TODAY, entry.expires)} days out; the policy's horizon is ${horizon} days`,
    )
  }
  if (advisory.severity === 'critical') {
    problems.push(
      `${at}  [critical-advisory-cannot-be-accepted] ${label} is critical. No date makes that ` +
        'acceptable; the remedy is to remove or replace the dependency.',
    )
    continue
  }
  live.add(entry.id)
  if (!findings.some((finding) => finding.advisory.id === entry.id)) {
    problems.push(
      `${at}  [stale-allowlist-entry] ${label} no longer matches anything in the graph — delete it ` +
        'rather than leave it covering a future reintroduction',
    )
  }
}

for (const finding of findings) {
  const { advisory } = finding
  if (advisory.severity === 'critical') {
    problems.push(
      `${finding.where}  [critical-advisory] ${finding.subject} matches ${advisory.id} ` +
        `(critical) — ${advisory.title}. ${finding.how}. Patched ${advisory.patched}.`,
    )
    continue
  }
  if (!live.has(advisory.id)) {
    problems.push(
      `${finding.where}  [unaccepted-advisory] ${finding.subject} matches ${advisory.id} ` +
        `(${advisory.severity}) — ${advisory.title}. ${finding.how}. Patched ${advisory.patched}. ` +
        `Fix it, or add a dated entry to ${ALLOWLIST_PATH}.`,
    )
  }
}

if (problems.length > 0) {
  console.error('Dependency advisory gate failed:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    `\n${problems.length} problem(s). ${SNAPSHOT_PATH} was captured ${snapshot.capturedAt}; the ` +
      'always-current check is the `pnpm audit:online` step in CI.',
  )
  process.exit(1)
}

const accepted = findings.filter((finding) => live.has(finding.advisory.id))
console.log(
  `Advisories clear: ${advisories.length} in the snapshot (captured ${snapshot.capturedAt}, ` +
    `${days(snapshot.capturedAt, TODAY)} days ago) against ${graph.found.size} resolved packages ` +
    `and ${workspaceManifests().length} workspace manifests. ${accepted.length} finding(s) ` +
    `accepted with a dated expiry: ` +
    `${[...new Set(accepted.map((finding) => `${finding.advisory.id} ${finding.subject}`))].join(', ')}.`,
)
