#!/usr/bin/env node
/**
 * Every secret this system holds must be declared, with a rotation procedure somebody can follow.
 *
 * `pnpm secrets` (H-HARD-02) answers "is a credential committed". This answers the question that
 * matters the morning after one is: **what does somebody actually do about it?** A leak is a
 * rotation, a rotation is a procedure, and a procedure nobody wrote down is a procedure invented
 * under pressure at 02:00 by whoever is awake.
 *
 * So the rule is not "document your secrets". It is narrower and checkable: **a secret-shaped
 * environment variable that the code reads must be classified in `build/secret-inventory.json`** — as
 * key material, as a version label, or as explicitly not a secret with a reason. Adding a new
 * credential to the code therefore fails the build until its rotation is written, which is the only
 * moment when the person who knows how it works is still looking at it.
 *
 * ## What this deliberately does not do
 *
 * It does not read any value, from any environment, ever. It reads names out of source files. A gate
 * that loaded the real environment to check a secret's shape would be a gate that could print one.
 *
 * It does not check that a rotation has *happened*. `rotatePeriodDays` is a declared policy, not a
 * measured age: the last-rotated date lives in the secret store, not in the repository, and a date
 * committed here would be stale the first time somebody rotated without editing a JSON file — which
 * is a gate that teaches people to distrust it. H-HARD-04's drill report is the shape for a measured
 * staleness check, and it needs a machine-readable source this one does not have.
 *
 * Usage: `node scripts/check-secret-rotation.mjs [--inventory build/secret-inventory.json]`
 * The flag exists so the known-bad fixtures can exercise the inventory's own rules; `pnpm rotation`
 * and CI pass no flags.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const INVENTORY_PATH = flag('inventory', 'build/secret-inventory.json')
const RUNBOOK_PATH = 'docs/runbooks/key-rotation.md'
const ENV_EXAMPLE_PATH = '.env.example'
const CONFIG_SCHEMA_PATH = 'packages/config/src/env.ts'

/**
 * An environment variable name that holds, or could hold, a credential.
 *
 * Shape-based rather than a hand-kept list, because a hand-kept list is exactly what this gate exists
 * to replace. `…_URL` is in it because a database URL carries a password; the escape for a URL that
 * does not is a `notSecrets` entry with a reason, which is reviewable.
 */
const SECRET_SHAPED =
  /(^|_)(SECRETS?|PASSWORD|PASSWD|CREDENTIALS?|KEK|DSN|TOKEN)($|_)|(PRIVATE|ACCESS|API)_?KEY($|_)|(^|_)URL$/

/** Kinds whose value is a key that gets rotated by re-wrapping rather than by re-collection. */
const KEK_KIND = 'kek'

const KINDS = new Set([
  KEK_KIND,
  'database-credential',
  'signing-key',
  'oauth-client-secret',
  'telemetry-key',
  'stored-credential',
])

/** Tracked files plus untracked-but-not-ignored ones, so a fixture written into the tree is read. */
function scannableFiles() {
  const listed = execFileSync(
    'git',
    ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return listed
    .split('\0')
    .filter((path) => path !== '')
    .filter((path) => ['.ts', '.tsx', '.mjs', '.js', '.cjs'].includes(extname(path).toLowerCase()))
}

const read = (path) => {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch {
    return null
  }
}

/** `process.env.FOO`, `process.env['FOO']`, `process.env["FOO"]`. */
const ENV_READ = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\])/g

/** Where each referenced name was seen, so a finding is actionable. */
function referencedEnvNames(files) {
  const seen = new Map()
  const note = (name, where) => {
    if (name === undefined) return
    const existing = seen.get(name)
    if (existing === undefined) seen.set(name, [where])
    else if (!existing.includes(where)) existing.push(where)
  }

  for (const file of files) {
    const text = read(file)
    if (text === null) continue
    for (const match of text.matchAll(ENV_READ)) note(match[1] ?? match[2], file)
  }

  // `.env.example` is the operator-facing contract; a name documented there but read nowhere is still
  // a name somebody will set, so it counts as referenced.
  const example = read(ENV_EXAMPLE_PATH)
  if (example !== null) {
    for (const line of example.split('\n')) {
      const match = /^\s*([A-Z][A-Z0-9_]*)=/.exec(line)
      if (match !== null) note(match[1], ENV_EXAMPLE_PATH)
    }
  }

  // The config schema is where the repository says every key is declared, so it is a source too: a
  // key declared there and classified nowhere here is the divergence this pairing prevents.
  const configSchema = read(CONFIG_SCHEMA_PATH)
  if (configSchema !== null) {
    for (const match of configSchema.matchAll(/^\s{4}([A-Z][A-Z0-9_]*)\s*:\s*z\./gm)) {
      note(match[1], CONFIG_SCHEMA_PATH)
    }
  }
  return seen
}

/** GitHub's heading slug, near enough: lower-cased, punctuation dropped, spaces hyphenated. */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')

function runbookAnchors() {
  const text = read(RUNBOOK_PATH)
  if (text === null) return null
  const anchors = new Set()
  for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) anchors.add(slug(match[1]))
  return anchors
}

const problems = []
const inventoryText = read(INVENTORY_PATH)
if (inventoryText === null) {
  console.error(`${INVENTORY_PATH} is missing. Every secret must be declared somewhere.`)
  process.exit(1)
}
const inventory = JSON.parse(inventoryText)
const entries = inventory.entries ?? []
const notSecrets = inventory.notSecrets ?? []

// --- the inventory's own hygiene ---------------------------------------------------------------

/** name -> how it is classified, so a name classified twice is a finding rather than a coin toss. */
const classified = new Map()
const classify = (name, as, at) => {
  if (typeof name !== 'string' || name === '') return
  const existing = classified.get(name)
  if (existing !== undefined) {
    problems.push(
      `${INVENTORY_PATH}  [secret-classified-twice] \`${name}\` is classified as ` +
        `${existing.as} (${existing.at}) and again as ${as} (${at}). One name, one classification`,
    )
    return
  }
  classified.set(name, { as, at })
}

for (const [index, entry] of entries.entries()) {
  const at = `${INVENTORY_PATH}[${index}]`
  const id = typeof entry.id === 'string' ? entry.id : `(entry ${index})`

  if (!KINDS.has(entry.kind)) {
    problems.push(
      `${at}  [unknown-secret-kind] \`${id}\` declares kind "${entry.kind}"; known kinds are ` +
        `${[...KINDS].sort().join(', ')}`,
    )
  }
  for (const field of ['stored', 'holds', 'owner']) {
    if (typeof entry[field] !== 'string' || entry[field].trim().length < 20) {
      problems.push(
        `${at}  [secret-entry-incomplete] \`${id}\` needs a \`${field}\` a reviewer can disagree with`,
      )
    }
  }

  // A rotation period is a policy, and a policy with no number is a preference. The upper bound is
  // deliberate: "every three years" is indistinguishable from never for a business this size.
  if (!Number.isInteger(entry.rotatePeriodDays) || entry.rotatePeriodDays < 1) {
    problems.push(
      `${at}  [rotation-period-missing] \`${id}\` needs \`rotatePeriodDays\` as a positive integer`,
    )
  } else if (entry.rotatePeriodDays > 1095) {
    problems.push(
      `${at}  [rotation-period-missing] \`${id}\` declares ${entry.rotatePeriodDays} days; anything ` +
        'beyond three years is a rotation nobody will ever perform',
    )
  }

  // A rotation that causes an outage and does not say so is a rotation somebody runs at 20:00 on a
  // Friday. Trading runs 11:00 to 02:00, so "outside hours" is a narrow window and has to be planned.
  if (entry.zeroDowntime !== true && entry.zeroDowntime !== false) {
    problems.push(`${at}  [secret-entry-incomplete] \`${id}\` must state \`zeroDowntime\``)
  } else if (
    entry.zeroDowntime === false &&
    (typeof entry.outage !== 'string' || entry.outage.trim().length < 20)
  ) {
    problems.push(
      `${at}  [outage-not-described] \`${id}\` is not zero-downtime and does not say what breaks ` +
        'while it is rotated',
    )
  }

  // A key-encrypting key with nowhere to keep the outgoing version cannot be rotated without an
  // outage: discard the old key before every row is re-wrapped and those rows are unreadable, which
  // is the failure this whole unit exists to make impossible.
  if (entry.kind === KEK_KIND) {
    for (const field of ['versionEnv', 'retiredEnv', 'retiredVersionEnv']) {
      if (typeof entry[field] !== 'string' || entry[field] === '') {
        problems.push(
          `${at}  [kek-must-retain-retired-versions] \`${id}\` needs \`${field}\`: a KEK whose ` +
            'retired version has nowhere to live cannot be rotated without making rows unreadable',
        )
      }
    }
  }

  classify(entry.env, 'key material', at)
  classify(entry.retiredEnv, 'retired key material', at)
  classify(entry.versionEnv, 'a version label', at)
  classify(entry.retiredVersionEnv, 'a version label', at)
}

for (const [index, entry] of notSecrets.entries()) {
  const at = `${INVENTORY_PATH}.notSecrets[${index}]`
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
    problems.push(
      `${at}  [not-a-secret-without-reason] \`${entry.name ?? '?'}\` needs a reason a reviewer can ` +
        'disagree with',
    )
  }
  classify(entry.name, 'not a secret', at)
}

// --- the runbook must actually hold each procedure ---------------------------------------------

const anchors = runbookAnchors()
if (anchors === null) {
  problems.push(`[runbook-missing] ${RUNBOOK_PATH} does not exist`)
} else {
  for (const [index, entry] of entries.entries()) {
    const at = `${INVENTORY_PATH}[${index}]`
    const target = entry.rotation
    if (typeof target !== 'string' || !target.startsWith(`${RUNBOOK_PATH}#`)) {
      problems.push(
        `${at}  [rotation-procedure-missing] \`${entry.id ?? index}\` must point \`rotation\` at a ` +
          `heading in ${RUNBOOK_PATH}`,
      )
      continue
    }
    const fragment = target.slice(RUNBOOK_PATH.length + 1)
    if (!anchors.has(fragment)) {
      problems.push(
        `${at}  [rotation-procedure-missing] \`${entry.id ?? index}\` points at "#${fragment}", ` +
          `which is not a heading in ${RUNBOOK_PATH}`,
      )
    }
  }
}

// --- every secret-shaped name the code reads must be classified --------------------------------

const files = scannableFiles()
const referenced = referencedEnvNames(files)

for (const [name, where] of [...referenced].sort()) {
  if (!SECRET_SHAPED.test(name)) continue
  if (classified.has(name)) continue
  problems.push(
    `${where[0]}  [undeclared-secret] \`${name}\` looks like a credential and is not in ` +
      `${INVENTORY_PATH}. Declare it with a rotation procedure, or list it under notSecrets with a ` +
      'reason. Seen in: ' +
      where.slice(0, 3).join(', '),
  )
}

// A declared secret nothing reads lingers in the secret store for ever, and the first person to find
// it cannot tell whether removing it breaks production. Scoped to `env` — a KEK's retired slot is read
// by rotation tooling that may not exist yet, and its own rule above covers it.
for (const [index, entry] of entries.entries()) {
  if (typeof entry.env !== 'string') continue
  if (referenced.has(entry.env)) continue
  problems.push(
    `${INVENTORY_PATH}[${index}]  [declared-secret-unused] \`${entry.env}\` is declared and read ` +
      'nowhere. A secret nobody reads is a secret nobody rotates',
  )
}

// ADR 0003's failure mode: a scan that examined nothing reports success.
if (files.length < 100) {
  problems.push(
    `[nothing-scanned] only ${files.length} source files were readable; this repository has hundreds`,
  )
}
if (entries.length === 0) {
  problems.push(
    '[nothing-declared] the inventory has no entries; this system holds several secrets',
  )
}

if (problems.length > 0) {
  console.error('Secret rotation inventory failed:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\n${problems.length} problem(s).`)
  process.exit(1)
}

const keks = entries.filter((entry) => entry.kind === KEK_KIND).length
console.log(
  `Secret rotation inventory: ${entries.length} secret(s) declared (${keks} key-encrypting), ` +
    `${notSecrets.length} name(s) classified as not a secret, ` +
    `${referenced.size} environment name(s) read across ${files.length} source files.`,
)
