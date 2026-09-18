#!/usr/bin/env node
/**
 * Two rules about scheduled work, neither of which a runtime check can cover.
 *
 * **1. `invalid-cron-declaration`.** Every `cron:` literal in a job declaration is a 5-field expression.
 * `assertRegistry` checks this at import time, which is the right place — but a job in a module nothing
 * has imported yet is a job whose cron has never been validated, and the symptom of a malformed one is
 * that pg-boss accepts it and it simply never fires. A static scan sees every declaration whether or not
 * anything imported it. The validator is imported from the worker rather than reimplemented, so the gate
 * and the runtime cannot disagree.
 *
 * **2. `no-schedule-outside-the-registry`.** `boss.schedule` and `boss.createQueue` appear only in
 * `apps/worker/src/registry.ts`. The registry exists so that "every cron this system runs" is one array
 * a person can read, and so that a job removed from it is unscheduled rather than left firing from an
 * upserted row nothing in the codebase mentions. A `boss.schedule(...)` in the module that owns a feature
 * defeats both, and it is the shape every codebase drifts towards.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { assertRegistry, isValidCron, JOB_REGISTRY } from '../apps/worker/src/registry.ts'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOTS = ['apps', 'packages']
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next'])
/** The one file allowed to talk to pg-boss's scheduling API. */
const REGISTRY = 'apps/worker/src/registry.ts'
/**
 * The harness drives a queue directly on purpose, and so does any test.
 *
 * A test is exempt from both rules, not out of laziness: `worker.itest.ts` *contains* a 6-field cron and
 * an out-of-range hour, deliberately, as the fixtures proving the validator rejects them. A gate that
 * flagged them would make the only test of this rule impossible to write. Nothing in a test file is ever
 * scheduled, so there is nothing to protect there.
 */
const EXEMPT = /(\.test\.ts|\.itest\.ts)$/
const SCHEDULING_EXEMPT = [REGISTRY, 'apps/worker/src/testing/harness.ts']

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
    else if (full.endsWith('.ts')) yield full
  }
}

const violations = []
let scanned = 0

for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }
  for (const file of walk(root)) {
    // Comments blanked, strings kept: a cron expression IS a string, and the prose explaining one would
    // otherwise be scanned as a declaration.
    if (EXEMPT.test(file)) continue
    const text = stripNonCode(readFileSync(file, 'utf8'), { lineComments: true })
    scanned += 1

    for (const [index, line] of text.split('\n').entries()) {
      const at = `${file}:${index + 1}`

      for (const match of line.matchAll(/\bcron:\s*'([^']*)'/g)) {
        const expression = match[1] ?? ''
        if (isValidCron(expression)) continue
        violations.push(
          `${at}  [invalid-cron-declaration] '${expression}' is not a 5-field cron expression — ` +
            'pg-boss accepts a malformed one and then never fires it',
        )
      }

      if (SCHEDULING_EXEMPT.some((exempt) => file.endsWith(exempt))) continue
      for (const match of line.matchAll(/\.(schedule|createQueue|unschedule)\s*\(/g)) {
        violations.push(
          `${at}  [no-schedule-outside-the-registry] '${match[1]}(' — declare the job in ` +
            `${REGISTRY} instead. A schedule created here is not unscheduled when the job is removed, ` +
            'and is a cron nothing in the codebase mentions.',
        )
      }
    }
  }
}

// And the registry's own declarations, through the same validator the worker uses at boot.
try {
  assertRegistry(JOB_REGISTRY)
} catch (error) {
  violations.push(
    `${REGISTRY}  [invalid-job-declaration] ${error instanceof Error ? error.message : String(error)}`,
  )
}

if (violations.length > 0) {
  console.error('Job registry violations:\n')
  for (const violation of violations) console.error(`  ${violation}`)
  console.error(`\n${violations.length} violation(s).`)
  process.exit(1)
}

const crons = JOB_REGISTRY.filter((job) => job.cron !== undefined).length
console.log(
  `Job declarations hold across ${scanned} source files: ${JOB_REGISTRY.length} job(s), ` +
    `${crons} cron(s), every schedule declared in the registry.`,
)
