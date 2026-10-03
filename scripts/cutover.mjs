#!/usr/bin/env node
/**
 * The cutover: one scripted sequence, a dry-run mode that must leave every table checksum unchanged,
 * and a measured window recorded as an artefact that is re-judged rather than read.
 *
 * ```
 * node scripts/cutover.mjs --dry-run --out artifacts/cutover/dry-run-1.json
 * node scripts/cutover.mjs --verify artifacts/cutover/dry-run-1.json
 * node scripts/cutover.mjs --execute                      # stops at the first operator step
 * ```
 *
 * H-MIG-11. [docs/runbooks/cutover.md](../docs/runbooks/cutover.md) is the procedure a person reads;
 * this is the part of it a script can perform.
 *
 * ## Three modes, and why the default is the rehearsal
 *
 *   * **`--dry-run`** (the default) performs every step that is a script's and does not write,
 *     checksums every table before and after, and records the window. It is the default because the
 *     mode that writes should be the one somebody has to ask for.
 *   * **`--verify <path>`** re-judges a recorded run from its own figures, by the same functions the
 *     run applied. The gate and the run therefore cannot come to disagree about what a clean rehearsal
 *     means — `check-drill-age.mjs`'s arrangement, one subject over.
 *   * **`--execute`** performs the writing steps too, and STOPS at the first step that is an
 *     operator's. Five of the eleven are: nothing here can stop a process, choose where the only copy
 *     of this business goes, record a decision only a named person may take, or open the doors.
 *     `--from <step-id>` resumes after one.
 *
 * ## Why the checksums are the dry run's evidence
 *
 * "This mode is read-only" is a claim about every statement the sequence issues, including the ones
 * inside the gates it shells out to. The cheap way to make it is to read the code; the honest way is to
 * checksum every ordinary table before and after and compare, naming the table that moved.
 * `import_staging.content_checksum` is the one implementation of a table checksum in this repository
 * (`packages/migration/src/checksum.ts`), so there is no second answer to *did this table change*.
 *
 * ## Why the recorded window is a FLOOR and says so
 *
 * The steps that take the time are the ones a dry run does not perform. A total presented as an
 * estimate of the real cutover would be a figure this build invented about an event nobody has
 * scheduled (brief rule 15, `Y13-cutover-date`), so `coversEveryStep` is recorded, DERIVED from the
 * step records rather than trusted, and the rendering prints the warning whenever it is false.
 *
 * ## Exit codes
 *
 *   0  the run is clean, or `--verify` found no problem.
 *   1  any rule broken. Every failure names the rule (ADR 0003).
 *   2  the command could not run: no database, a bad argument.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import postgres from 'postgres'
import {
  CUTOVER_RULES,
  CUTOVER_STEPS,
  canonicalCutoverRun,
  cutoverRunProblems,
  renderCutoverRun,
} from '../packages/core/src/release/cutover.ts'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const verifyPath = flag('verify')
const execute = argv.includes('--execute')
const outPath = flag('out')
const from = flag('from')

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

// ------------------------------------------------------------------------------------------------
// --verify: re-judge a recorded run
// ------------------------------------------------------------------------------------------------

if (verifyPath !== null) {
  if (!existsSync(verifyPath)) {
    console.error(`[${CUTOVER_RULES.malformed}] ${verifyPath} does not exist.`)
    process.exit(1)
  }
  let record
  try {
    record = JSON.parse(readFileSync(verifyPath, 'utf8'))
  } catch (error) {
    console.error(
      `[${CUTOVER_RULES.malformed}] ${verifyPath} is not readable JSON: ${error.message}`,
    )
    process.exit(1)
  }
  const problems = []
  if (record?.runVersion !== 1) {
    console.error(
      `[${CUTOVER_RULES.malformed}] ${verifyPath} is run version ${String(record?.runVersion)} and ` +
        'this build reads version 1.',
    )
    process.exit(1)
  }
  const recomputed = sha256(canonicalCutoverRun(record))
  if (recomputed !== record.digest) {
    // Reported and then NOT returned on, deliberately: a hand edit to one checksum has to be visible
    // as the rule it breaks as well as as a broken digest, and stopping here would print only the
    // digest. Every other rule is still judged below.
    problems.push({
      rule: CUTOVER_RULES.digestMismatch,
      detail:
        `${verifyPath} digests to ${recomputed} and records ${record.digest}. A figure was edited by ` +
        'hand; recomputing the digest means running the sequence again, which is what makes "the ' +
        'artefact says it was clean" and "it was clean" the same claim',
    })
  }
  problems.push(...cutoverRunProblems(record))
  console.log(renderCutoverRun(record, problems))
  process.exit(problems.length === 0 ? 0 : 1)
}

// ------------------------------------------------------------------------------------------------
// The run
// ------------------------------------------------------------------------------------------------

const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL']
if (url === undefined || url === '') {
  console.error('DATABASE_URL or TEST_DATABASE_URL is required: the checksums are read from it.')
  process.exit(2)
}

const sql = postgres(url, { max: 2 })

/**
 * Every ordinary, permanent table in the schemas this build owns, with its checksum.
 *
 * Derived from the catalogue rather than declared, because a declared list is the second statement that
 * drifts — and the table it would stop covering is whichever one a migration added last. Views,
 * partitions, temporary and unlogged relations are excluded: a view has no rows of its own and an
 * unlogged table is not evidence.
 */
async function tableChecksums() {
  const tables = await sql`
    select n.nspname as schema, c.relname as name
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and c.relpersistence = 'p'
       and n.nspname in ('public', 'import_staging')
     order by 1, 2
  `
  const checksums = []
  for (const table of tables) {
    const relation = `${table['schema']}.${table['name']}`
    const [row] = await sql`
      select import_staging.content_checksum(${relation}::regclass) as checksum
    `
    checksums.push({ relation, checksum: row?.['checksum'] ?? '' })
  }
  return checksums
}

/** Runs one command, keeping its output for the failure message. */
function runCommand(command) {
  const [head, ...rest] = command.split(' ')
  const child = spawnSync(head, rest, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
  return {
    status: child.status ?? 1,
    output: `${child.stdout ?? ''}${child.stderr ?? ''}`.trim(),
  }
}

const startedAt = Date.now()
const startedAtIso = new Date(startedAt).toISOString()

let before
try {
  before = await tableChecksums()
} catch (error) {
  console.error(`The table walk failed, so no checksum claim can be made: ${error.message}`)
  await sql.end({ timeout: 5 })
  process.exit(2)
}

const records = []
let stopped = null
let resuming = from !== null

for (const step of CUTOVER_STEPS) {
  if (resuming) {
    if (step.id === from) resuming = false
    else {
      records.push({
        id: step.id,
        performed: false,
        durationMs: null,
        skippedReason: `--from ${from}: this step is before the one the run resumed at`,
        exitCode: null,
      })
      continue
    }
  }
  if (stopped !== null) {
    records.push({
      id: step.id,
      performed: false,
      durationMs: null,
      skippedReason: `the sequence stopped at ${stopped}`,
      exitCode: null,
    })
    continue
  }
  if (step.agent === 'operator') {
    records.push({
      id: step.id,
      performed: false,
      durationMs: null,
      skippedReason:
        'an operator performs this step; nothing in this repository can. See ' +
        'docs/runbooks/cutover.md',
      exitCode: null,
    })
    if (execute) stopped = step.id
    continue
  }
  if (!execute && step.writes) {
    records.push({
      id: step.id,
      performed: false,
      durationMs: null,
      skippedReason: 'this step writes, and this is a dry run',
      exitCode: null,
    })
    continue
  }
  const at = Date.now()
  let status = 0
  for (const command of step.commands) {
    const result = runCommand(command)
    status = result.status
    console.log(`--- ${step.id}: ${command} (exit ${status}) ---`)
    if (result.output !== '') console.log(result.output)
    if (status !== 0) break
  }
  records.push({
    id: step.id,
    performed: true,
    durationMs: Date.now() - at,
    skippedReason: null,
    exitCode: status,
  })
  if (status !== 0 && execute) stopped = step.id
}

let after
try {
  after = await tableChecksums()
} finally {
  await sql.end({ timeout: 5 })
}

const finishedAt = Date.now()
const beforeByRelation = new Map(before.map((entry) => [entry.relation, entry.checksum]))
const afterByRelation = new Map(after.map((entry) => [entry.relation, entry.checksum]))
const relations = [...new Set([...beforeByRelation.keys(), ...afterByRelation.keys()])].sort()
const tableChecksumRecords = relations.map((relation) => ({
  table: relation,
  // A relation that appeared or vanished during the run is recorded as `absent`, which differs from
  // its own checksum and is therefore caught by the same rule as a row that changed.
  before: beforeByRelation.get(relation) ?? 'absent',
  after: afterByRelation.get(relation) ?? 'absent',
}))

const run = {
  runVersion: 1,
  mode: execute ? 'execute' : 'dry_run',
  startedAtIso,
  finishedAtIso: new Date(finishedAt).toISOString(),
  measuredOverMs: finishedAt - startedAt,
  coversEveryStep: records.every((record) => record.performed),
  // Declared by the person running it, and `agent_container` by default: every figure this repository
  // has measured so far came off a shared four-core container, and a default of `chosen_machine` would
  // make the honest case the one somebody has to remember (ADR 0126).
  measuredOn: argv.includes('--chosen-machine') ? 'chosen_machine' : 'agent_container',
  steps: records,
  tableChecksums: tableChecksumRecords,
  digest: '',
}
run.digest = sha256(canonicalCutoverRun(run))

const problems = cutoverRunProblems(run)
console.log('')
console.log(renderCutoverRun(run, problems))

if (outPath !== null) {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${JSON.stringify(run, null, 2)}\n`)
  console.log(`\nRecorded to ${outPath}.`)
}

if (stopped !== null) {
  console.error(
    `\nThe sequence stopped at ${stopped}. That is not a failure of this script: see ` +
      'docs/runbooks/cutover.md for what a person does there, and resume with --from <next-step-id>.',
  )
}

process.exit(problems.length === 0 ? 0 : 1)
