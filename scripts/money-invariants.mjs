#!/usr/bin/env node
/**
 * Runs the money invariant suite, and refuses an invariant that nothing proves any more.
 *
 * The seven claims are `MONEY_INVARIANTS` in `vitest.integration.config.ts`, which says why the registry
 * is a registry of EXISTING tests rather than a new suite. This file is the runner, and it exists because
 * `pnpm test:integration` and `pnpm coverage` reach those tests only through a glob: delete one, rename
 * it, or wrap it in `describe.skip` and the run is one test shorter with nothing saying which of the seven
 * claims has stopped being made. That is ADR 0002's shape — a check that examined nothing while reporting
 * success — applied to the claims a tax authority asks about.
 *
 * ## Three refusals, cheapest first
 *
 *   * **`[money-invariant-unresolved]`** — a registered file is not on disk, or does not contain its
 *     marker clause. A static read, so a renamed test fails in milliseconds rather than after the suite.
 *   * **`[money-invariant-failed]`** — a runner exited non-zero. The invariant is stated and it is false.
 *   * **`[money-invariant-examined-nothing]`** — every file ran, every runner exited zero, and ZERO
 *     PASSED tests matched some invariant's marker. This is the one the other two cannot catch: a test
 *     that is present in the source, skipped at run time, and therefore examined nothing.
 *
 * The third is why the count comes from the RUNNER's report and not from the source. `describe.skip`,
 * `it.todo`, a `beforeAll` that returns early and a conditional `it.skipIf` all leave the marker in the
 * file, and the first version of this check — a grep for the clause — passed over every one of them.
 *
 * ## Why it runs two runners
 *
 * `net + vat === gross` is a property over generated amounts and needs nothing started; `UPDATE on
 * journal_line raises ZL001` needs real PostgreSQL. The two configs have different `include` globs, so a
 * unit file handed to the integration runner matches nothing and vitest reports "no test files found" —
 * which is a different failure from the claim being gone, and would have been reported as one. Each
 * registry entry therefore names its config, and the files are grouped by it.
 *
 * See docs/adr/0074-the-money-invariants-are-a-named-set.md.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MONEY_INVARIANTS } from '../vitest.integration.config.ts'

/** The ids M-VAT-13's first acceptance line names, in its order. A second statement, held equal below. */
const DECLARED_IDS = [
  'LEDGER_BALANCES',
  'VAT_ROUND_TRIP',
  'JOURNAL_APPEND_ONLY',
  'NUMBERING_GAP_FREE',
  'PACKAGE_LIABILITY_IDENTITY',
  'CASH_SESSION_BUSINESS_DAY',
  'VAT_BOX_PARTITION',
]

const CONFIGS = {
  unit: 'vitest.config.ts',
  integration: 'vitest.integration.config.ts',
}

/**
 * Every name vitest reports as PASSED, read out of its JSON report.
 *
 * `--reporter=json` with `--outputFile` rather than stdout: the default reporter also writes to stdout and
 * the two interleave, so a parse of stdout fails on a run that said everything right. `assertionResults`
 * carries `fullName` (the describe path plus the test name) and `status`, which is what makes a SKIPPED
 * test distinguishable from a passing one — the whole point of counting here instead of grepping source.
 */
function runConfig(configFile, files) {
  const reportDir = mkdtempSync(join(tmpdir(), 'berelax-money-invariants-'))
  const reportFile = join(reportDir, 'report.json')
  try {
    const result = spawnSync(
      'pnpm',
      [
        'exec',
        'vitest',
        'run',
        '-c',
        configFile,
        // BOTH reporters. `json` is what the examined count is read from, and it writes to a FILE, so a
        // run with only that reporter prints almost nothing — a failing money invariant in CI would say
        // "the runner exited non-zero" and not which test. `default` keeps the human output on stdout,
        // and `--outputFile` applies to the reporter that writes files.
        '--reporter=default',
        '--reporter=json',
        `--outputFile=${reportFile}`,
        ...files,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
    )
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (!existsSync(reportFile)) {
      return { failed: true, output, passed: [], noReport: true }
    }
    const report = JSON.parse(readFileSync(reportFile, 'utf8'))
    const passed = []
    const failed = []
    for (const suite of report.testResults ?? []) {
      for (const assertion of suite.assertionResults ?? []) {
        const name = assertion.fullName ?? assertion.title ?? ''
        if (assertion.status === 'passed') passed.push(name)
        else if (assertion.status === 'failed') failed.push(name)
      }
    }
    return { failed: result.status !== 0, output, passed, failedNames: failed, noReport: false }
  } finally {
    rmSync(reportDir, { recursive: true, force: true })
  }
}

/**
 * The registry held to its own declaration, before anything is read off disk.
 *
 * The controls come first. Every verdict below is a difference against the registry, and a difference
 * against an empty registry is empty — so a config that silently stopped exporting the seven would
 * report success having run nothing at all.
 */
function checkRegistryShape() {
  const ids = MONEY_INVARIANTS.map((invariant) => invariant.id)
  if (ids.join('|') === DECLARED_IDS.join('|')) return null
  return (
    '[money-invariant-registry-incomplete] vitest.integration.config.ts registers ' +
    `${ids.join(', ') || '(nothing)'} and M-VAT-13's acceptance line names ${DECLARED_IDS.join(', ')}, ` +
    'in that order. One of the seven claims the money invariant suite is accountable for has been ' +
    'added, removed or reordered without the other list moving.'
  )
}

/**
 * The static half: a file that is gone, or a marker clause that no longer appears in it.
 *
 * Refused BEFORE any runner starts, because a renamed test should cost a file read rather than the
 * suite — and because vitest handed a file it cannot find reports "no test files found", which is a
 * message about the runner rather than about the claim that stopped being made.
 */
function resolveRegistry() {
  const problems = []
  const byConfig = new Map(Object.keys(CONFIGS).map((config) => [config, new Set()]))
  for (const invariant of MONEY_INVARIANTS) {
    if (invariant.tests.length === 0) {
      problems.push(
        `[money-invariant-unresolved] ${invariant.id} registers no test at all, so "${invariant.claim}" ` +
          'is a claim this build makes and does not check.',
      )
      continue
    }
    for (const test of invariant.tests) {
      const bucket = byConfig.get(test.config)
      if (!bucket) {
        problems.push(
          `[money-invariant-unresolved] ${invariant.id} names config "${test.config}", which is not ` +
            `one of ${Object.keys(CONFIGS).join(', ')}.`,
        )
      } else if (!existsSync(test.file)) {
        problems.push(
          `[money-invariant-unresolved] ${invariant.id} names ${test.file}, which is not on disk. ` +
            `"${invariant.claim}" rests on ${invariant.oneStatement}, and nothing now proves it.`,
        )
      } else if (!readFileSync(test.file, 'utf8').includes(test.nameContains)) {
        problems.push(
          `[money-invariant-unresolved] ${invariant.id}: ${test.file} no longer contains the clause ` +
            `"${test.nameContains}". Either the test was renamed — re-point the marker in ` +
            'vitest.integration.config.ts — or the claim has gone, which is the case this refusal ' +
            'exists for.',
        )
      } else {
        bucket.add(test.file)
      }
    }
  }
  return { problems, byConfig }
}

/**
 * Both runners, grouped by config in the order the configs are declared, so the pure suite fails
 * before the one that needs a database.
 */
function runRunners(byConfig) {
  const problems = []
  const passed = []
  for (const [config, configFile] of Object.entries(CONFIGS)) {
    const files = [...(byConfig.get(config) ?? [])].sort()
    if (files.length === 0) continue
    console.log(`Money invariants: ${files.length} ${config} file(s) — ${files.join(', ')}`)
    const result = runConfig(configFile, files)
    passed.push(...result.passed)
    if (result.failed || result.noReport) {
      const named = (result.failedNames ?? []).map((name) => `\n    - ${name}`).join('')
      problems.push(
        `[money-invariant-failed] the ${config} runner exited non-zero over ${files.join(', ')}` +
          `${result.noReport ? ' and wrote no JSON report, so nothing it found was read' : ''}.` +
          `${named === '' ? '' : ` The failing test(s):${named}`}\n` +
          result.output,
      )
    }
  }
  return { problems, passed }
}

/**
 * The count that cannot be read from source: how many PASSED tests each marker matched.
 *
 * `describe.skip`, `it.todo`, a `beforeAll` that returns early and a conditional `it.skipIf` all leave
 * the marker in the file and the exit code at zero. The first version of this check was a grep for the
 * clause and passed over every one of them.
 */
function censusExamined(passed) {
  const problems = []
  for (const invariant of MONEY_INVARIANTS) {
    for (const test of invariant.tests) {
      const matched = passed.filter((name) => name.includes(test.nameContains)).length
      console.log(
        `  ${invariant.id.padEnd(28)} ${String(matched).padStart(3)} passing test(s) match ` +
          `"${test.nameContains.slice(0, 60)}"`,
      )
      if (matched === 0) {
        problems.push(
          `[money-invariant-examined-nothing] ${invariant.id}: the clause "${test.nameContains}" is ` +
            `in ${test.file} and ZERO passing tests matched it, so "${invariant.claim}" was not ` +
            'examined by this run. A skipped test, a `describe.skip` or a `beforeAll` that returned ' +
            'early all look exactly like this and all leave the marker in the file, which is why the ' +
            `count comes from the runner's report. The rule rests on ${invariant.oneStatement}.`,
        )
      }
    }
  }
  return problems
}

function report(problems) {
  console.log('')
  for (const problem of problems) console.log(`FAIL  ${problem}`)
  console.log(`\n${problems.length} problem(s)`)
  return 1
}

function main() {
  const shape = checkRegistryShape()
  if (shape) return report([shape])

  const { problems: unresolved, byConfig } = resolveRegistry()
  if (unresolved.length > 0) return report(unresolved)

  const { problems: failures, passed } = runRunners(byConfig)
  const problems = [...failures, ...censusExamined(passed)]
  if (problems.length > 0) return report(problems)

  console.log(
    `\nAll ${MONEY_INVARIANTS.length} money invariants were examined and hold: ` +
      `${MONEY_INVARIANTS.map((invariant) => invariant.claim).join('; ')}.`,
  )
  return 0
}

process.exit(main())
