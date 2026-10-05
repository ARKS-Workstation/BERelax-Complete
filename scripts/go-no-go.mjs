#!/usr/bin/env node
/**
 * The release go/no-go check: six requirements, every one UNMET until a fact in this repository or this
 * database clears it.
 *
 * `node scripts/go-no-go.mjs`. H-MIG-11, and docs/11 §5 step 24, whose gate for this whole step is
 * three words: *every external item cleared*.
 *
 * ## It is NOT in `pnpm verify`, deliberately
 *
 * It exits non-zero today and it is supposed to: no penetration test has been performed, forty-eight
 * external items are open, and no milestone unit exists for M3. Putting it in `verify` would make every
 * commit fail on business facts nobody can fix in code, and the first response to a check like that is
 * to delete it. So it is run by a person before a cutover, which is the only moment its answer matters
 * — exactly as `pnpm go-live:payments` and `pnpm go-live:security` are, for the same reason.
 *
 * ## It is THIN, and every requirement is answered by a check that ALREADY has a fixture
 *
 * The verdict, the requirement list and the rendering are `packages/core/src/release/go-no-go.ts`. What
 * is here is fact gathering, and three of the six facts are gathered by RUNNING the gate that already
 * owns them — `check-drill-age.mjs`, `go-live-security.mjs`, `check-dry-runs.mjs` — rather than by
 * re-deriving their judgements. That is deliberate and it is the difference between this script and a
 * release checklist: a re-derivation here would be a second statement of the maximum drill age, the
 * blocking severities and the minimum of three, and the copy that drifted would be the one the release
 * gate read. Each of those three gates also already has its own known-bad fixture (ADR 0003), so
 * nothing in this file has to prove them again.
 *
 * ## Why an absent fact blocks
 *
 * A release gate's failure mode is not saying the wrong thing: it is saying nothing and being read as a
 * pass. So a requirement whose source is missing, whose bound was never configured or whose list came
 * back empty is reported `unknown`, and `unknown` blocks exactly as hard as a refusal. See the module
 * note on `releaseGoNoGoVerdict`.
 *
 * ## Flags
 *
 *   --findings <path>        read the six findings from a JSON file instead of gathering them. This
 *                           exists for one reason, and it is ADR 0003's: the acceptance line asks that
 *                           "a fixture with exactly one unmet item names that item and no other", and
 *                           five of the six requirements cannot be CLEARED in this repository today —
 *                           no engagement has been performed and no milestone unit exists for M3. It
 *                           is `check-dry-runs.mjs --dir`'s device: the only way the cleared path and
 *                           the one-unmet path can be seen at all.
 *   --register <path>        the findings register (default artifacts/security/findings.json)
 *   --drill-report <path>    the restore drill report (default artifacts/drills/restore-report.json)
 *   --runs-dir <path>        the recorded dry runs (default artifacts/migration)
 *   --manifest <path>        build/manifest.yaml
 *   --open-questions <path>  docs/OPEN-QUESTIONS.md
 *   --no-database            report `unknown` for the settings requirement rather than connecting
 *
 * ## Exit codes
 *
 *   0  every requirement met. This build may go live as far as the repository can tell.
 *   1  any requirement unmet or unanswered. Every problem names its rule and its requirement id, so a
 *      gate case can assert the rule rather than a non-zero exit (ADR 0003).
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import postgres from 'postgres'
import { provisionalSettings } from '../packages/config/src/settings/registry.ts'
import {
  GO_NO_GO_REQUIREMENTS,
  releaseGoNoGoVerdict,
  renderReleaseGoNoGo,
} from '../packages/core/src/release/go-no-go.ts'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}

const MANIFEST = flag('manifest', 'build/manifest.yaml')
const OPEN_QUESTIONS = flag('open-questions', 'docs/OPEN-QUESTIONS.md')
const REGISTER = flag('register', 'artifacts/security/findings.json')
const DRILL_REPORT = flag('drill-report', 'artifacts/drills/restore-report.json')
const RUNS_DIR = flag('runs-dir', 'artifacts/migration')
const noDatabase = argv.includes('--no-database')

/** The seven milestones docs/00 §5 names. A declared list, because the manifest is not their index. */
const MILESTONES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7']

/** Runs a check and keeps its own output, which is what the finding's detail is made of. */
function runCheck(command, args) {
  const child = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  })
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim()
  return { ok: child.status === 0, status: child.status, output }
}

/** The first line of a check's output that names a rule, or its first line. For a one-line detail. */
function firstRule(output) {
  const named = output.split('\n').find((line) => /^\[[a-z0-9-]+\]/.test(line.trim()))
  return (named ?? output.split('\n')[0] ?? '').trim()
}

// ------------------------------------------------------------------------------------------------
// The manifest, read by line scan
// ------------------------------------------------------------------------------------------------

/**
 * `blocked_on_owner` ids, the milestone each unit declares, and each unit's status.
 *
 * A line scan rather than a YAML parse, for `scripts/test-gates.mjs` case 101's reason: this workspace
 * has no YAML dependency and `build/manifest.yaml` is twenty thousand lines of two-space-indented
 * mapping with one shape. The floors below are what stop a scan that stopped matching from reporting a
 * cleaner answer than the last run.
 */
function readManifest(path) {
  const lines = readFileSync(path, 'utf8').split('\n')
  const units = []
  let unit = null
  let inBlocked = false
  for (const line of lines) {
    const id = /^ {2}- id: (\S+)\s*$/.exec(line)
    if (id) {
      unit = { id: id[1], status: null, milestone: null, blockedOnOwner: [] }
      units.push(unit)
      inBlocked = false
      continue
    }
    if (unit === null) continue
    const status = /^ {4}status: (\S+)\s*$/.exec(line)
    if (status) {
      unit.status = status[1]
      inBlocked = false
      continue
    }
    const milestone = /^ {4}milestone: (\S+)\s*$/.exec(line)
    if (milestone) {
      unit.milestone = milestone[1]
      inBlocked = false
      continue
    }
    if (/^ {4}blocked_on_owner:\s*$/.test(line)) {
      inBlocked = true
      continue
    }
    if (inBlocked) {
      const item = /^ {4}- (\S+)\s*$/.exec(line)
      if (item) {
        unit.blockedOnOwner.push(item[1])
        continue
      }
      inBlocked = false
    }
  }
  return units
}

/**
 * Every open question's id with its status, and the ids the Resolved table holds.
 *
 * The Resolved table has four columns and no Status column — the answer and the date take its place —
 * so membership of that table IS the status. Section E has three columns and no status either: those
 * are owner verification tasks, and a task with nowhere to record a status is not a cleared one.
 */
function readOpenQuestions(path) {
  const rows = new Map()
  let section = null
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      section = heading[1]
      continue
    }
    if (!line.startsWith('|')) continue
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())
    const id = (cells[0] ?? '').replace(/[*`]/g, '').trim()
    if (id === '' || id === 'ID' || id.startsWith('---')) continue
    if (section === 'Resolved') {
      rows.set(id, 'resolved')
      continue
    }
    // Five columns: ID, question, provisional value, status, blocks. Three: an owner task with no
    // status column at all, which is reported as such rather than defaulted either way.
    rows.set(id, cells.length >= 5 ? (cells[cells.length - 2] ?? '') : 'no status column')
  }
  return rows
}

// ------------------------------------------------------------------------------------------------
// The six facts
// ------------------------------------------------------------------------------------------------

function externalItemsCleared() {
  if (!existsSync(MANIFEST) || !existsSync(OPEN_QUESTIONS)) {
    return { state: 'unknown', detail: `${MANIFEST} or ${OPEN_QUESTIONS} is not on disk` }
  }
  const units = readManifest(MANIFEST)
  const questions = readOpenQuestions(OPEN_QUESTIONS)
  const items = new Map()
  for (const unit of units) {
    for (const id of unit.blockedOnOwner) {
      const owners = items.get(id) ?? []
      items.set(id, [...owners, unit.id])
    }
  }
  if (items.size === 0 || questions.size === 0) {
    // The floor. Both lists are read by pattern, and a difference against an empty one is empty — so a
    // scan that stopped matching would report every external item cleared.
    return {
      state: 'unknown',
      detail:
        `read ${items.size} external item(s) out of ${MANIFEST} and ${questions.size} row(s) out of ` +
        `${OPEN_QUESTIONS}. One of the two scans matched nothing, so "every item cleared" would be a ` +
        'claim about nothing',
    }
  }
  const unrecorded = []
  const open = []
  for (const [id, owners] of [...items].sort()) {
    const status = questions.get(id)
    if (status === undefined) {
      unrecorded.push(`${id} (named by ${owners.join(', ')})`)
    } else if (status !== 'resolved') {
      open.push(id)
    }
  }
  if (unrecorded.length === 0 && open.length === 0) {
    return { state: 'met', detail: `all ${items.size} external item(s) are recorded as resolved` }
  }
  return {
    state: unrecorded.length > 0 && open.length === 0 ? 'unknown' : 'unmet',
    detail:
      `${open.length} of ${items.size} external item(s) are not resolved` +
      (open.length === 0 ? '' : `: ${open.join(', ')}`) +
      (unrecorded.length === 0
        ? ''
        : `. ${unrecorded.length} named by a unit with no row in ${OPEN_QUESTIONS} at all: ` +
          unrecorded.join('; ')),
  }
}

function milestonesDemonstrated() {
  if (!existsSync(MANIFEST)) return { state: 'unknown', detail: `${MANIFEST} is not on disk` }
  const units = readManifest(MANIFEST)
  if (units.length === 0) {
    return {
      state: 'unknown',
      detail: `read no unit at all out of ${MANIFEST}: the scan is wrong, so every milestone would read as undemonstrated`,
    }
  }
  const undemonstrated = []
  for (const milestone of MILESTONES) {
    const claiming = units.filter((unit) => unit.milestone === milestone)
    if (claiming.length === 0) {
      undemonstrated.push(`${milestone}: no unit in the manifest declares this milestone`)
      continue
    }
    const unfinished = claiming.filter((unit) => unit.status !== 'done')
    if (unfinished.length > 0) {
      undemonstrated.push(
        `${milestone}: ${unfinished.map((unit) => `${unit.id} is ${unit.status}`).join(', ')}`,
      )
    }
  }
  return undemonstrated.length === 0
    ? { state: 'met', detail: `every one of ${MILESTONES.join(', ')} has a done unit behind it` }
    : { state: 'unmet', detail: undemonstrated.join('; ') }
}

function restoreDrillCurrent() {
  const age = runCheck('node', ['scripts/check-drill-age.mjs', '--report', DRILL_REPORT])
  if (!age.ok) {
    return {
      state: 'unmet',
      detail: `check-drill-age refused the report: ${firstRule(age.output)}`,
    }
  }
  // The drill gate enforces the calendar bound only when one has been CONFIGURED, and there is
  // deliberately no default (ADR 0123: how often a restore must be rehearsed is part of the same
  // unanswered question as the RPO and the RTO). A release gate cannot treat an unenforced bound as a
  // met requirement: "newer than the maximum age" is then a comparison against nothing.
  let configured = null
  let openQuestionId = ''
  try {
    const report = JSON.parse(readFileSync(DRILL_REPORT, 'utf8'))
    configured = report?.objectives?.drillMaxAgeDays ?? null
    openQuestionId = report?.objectives?.openQuestionId ?? ''
  } catch (error) {
    return { state: 'unknown', detail: `${DRILL_REPORT} is not readable: ${error.message}` }
  }
  if (configured === null) {
    return {
      state: 'unknown',
      detail:
        `the drill passes every rule it can enforce, and no maximum age is configured in ` +
        `${DRILL_REPORT} (objectives.drillMaxAgeDays is null, ${openQuestionId}). How often a restore ` +
        'must be rehearsed is the owner’s answer, and until it exists "newer than the maximum age" ' +
        'is a comparison against nothing',
    }
  }
  return {
    state: 'met',
    detail: `the recorded drill is clean and within the configured maximum age of ${configured} day(s)`,
  }
}

function securityFindingsClear() {
  const result = runCheck('node', ['scripts/go-live-security.mjs', '--register', REGISTER])
  return result.ok
    ? { state: 'met', detail: 'go-live-security returns go over the findings register' }
    : { state: 'unmet', detail: `go-live-security says no-go: ${firstRule(result.output)}` }
}

function threeCleanDryRuns() {
  if (!existsSync(RUNS_DIR)) {
    return { state: 'unknown', detail: `${RUNS_DIR} does not exist, so no dry run is recorded` }
  }
  const recorded = readdirSync(RUNS_DIR).filter((name) => /^run-\d+\.json$/.test(name)).length
  // `pnpm exec tsx` and not `node`: this one gate reaches into `packages/migration`, whose module
  // graph node's own type stripping will not load. The other two run under plain node.
  const result = runCheck('pnpm', ['exec', 'tsx', 'scripts/check-dry-runs.mjs', '--dir', RUNS_DIR])
  return result.ok
    ? { state: 'met', detail: `${recorded} recorded dry run(s), every one clean` }
    : { state: 'unmet', detail: `check-dry-runs refused the set: ${firstRule(result.output)}` }
}

async function provisionalSettingsConfirmed() {
  const declared = provisionalSettings()
  if (declared.length === 0) {
    return {
      state: 'unknown',
      detail:
        'the settings registry declares no provisional setting at all. That is what a registry whose ' +
        'provisional marker stopped being read looks like, and it would clear this requirement by ' +
        'examining nothing',
    }
  }
  if (noDatabase) {
    return {
      state: 'unknown',
      detail: `--no-database: ${declared.length} provisional setting(s) declared and none was checked`,
    }
  }
  const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL']
  if (url === undefined || url === '') {
    return {
      state: 'unknown',
      detail:
        'DATABASE_URL is not set, so whether a provisional value is still in place was not checked. ' +
        `${declared.length} setting(s) are declared provisional in packages/config`,
    }
  }
  const sql = postgres(url, { max: 2 })
  try {
    const keys = declared.map((setting) => setting.key)
    /*
     * `any(${keys})` and NOT `any(${sql.array(keys)})`, which is what this was and what made this
     * requirement read UNKNOWN on every run: postgres.js sends `sql.array()` as a parameter of unknown
     * type and PostgreSQL answers `op ANY/ALL (array) requires array on right side`. A plain JS array is
     * the form the driver infers an element type for. The failure was invisible because an unreadable
     * requirement is reported as UNKNOWN — which blocks a release exactly as hard as a refusal, so the
     * verdict was right while its reason was a bug in the query.
     */
    const rows = await sql`
      select key, is_provisional from app_setting where key = any(${keys})
    `
    const byKey = new Map(rows.map((row) => [row['key'], row['is_provisional']]))
    const unconfirmed = []
    for (const setting of declared) {
      const stored = byKey.get(setting.key)
      if (stored === undefined)
        unconfirmed.push(`${setting.key} (no row; ${setting.openQuestionId})`)
      else if (stored === true) unconfirmed.push(`${setting.key} (${setting.openQuestionId})`)
    }
    return unconfirmed.length === 0
      ? {
          state: 'met',
          detail: `all ${declared.length} provisional setting(s) carry a confirmed row`,
        }
      : {
          state: 'unmet',
          detail:
            `${unconfirmed.length} of ${declared.length} provisional setting(s) are unconfirmed: ` +
            unconfirmed.join(', '),
        }
  } catch (error) {
    return { state: 'unknown', detail: `the settings query failed: ${error.message}` }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

// ------------------------------------------------------------------------------------------------
// Gather, judge, print
// ------------------------------------------------------------------------------------------------

const fixture = flag('findings')
let findings
if (fixture !== null) {
  if (!existsSync(fixture)) {
    console.error(`--findings ${fixture} does not exist.`)
    process.exit(1)
  }
  findings = JSON.parse(readFileSync(fixture, 'utf8'))
  if (!Array.isArray(findings)) {
    console.error(`--findings ${fixture} must hold an array of { id, state, detail }.`)
    process.exit(1)
  }
  console.log(`findings read from ${fixture} rather than gathered.\n`)
} else {
  const gathered = [
    ['external-items-cleared', externalItemsCleared()],
    ['milestones-demonstrated', milestonesDemonstrated()],
    ['restore-drill-current', restoreDrillCurrent()],
    ['security-findings-clear', securityFindingsClear()],
    ['three-clean-dry-runs', threeCleanDryRuns()],
    ['provisional-settings-confirmed', await provisionalSettingsConfirmed()],
  ]
  findings = gathered.map(([id, fact]) => ({ id, state: fact.state, detail: fact.detail }))
}

const verdict = releaseGoNoGoVerdict(findings)
console.log(renderReleaseGoNoGo(verdict))
if (!verdict.go) {
  console.error(
    `\n${verdict.problems.length} problem(s) across ${GO_NO_GO_REQUIREMENTS.length} requirement(s). ` +
      'Nothing here can be fixed by a deploy: every one of these is a fact about the business or about ' +
      'evidence somebody has to produce.',
  )
}
process.exit(verdict.go ? 0 : 1)
