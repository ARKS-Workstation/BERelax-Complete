#!/usr/bin/env node
/**
 * Proves the gates fire.
 *
 * ADR 0002: a passing check that examined nothing is worse than a failing check. TypeScript 7
 * silently reduced `pnpm boundaries` to zero modules while reporting success, and only a
 * deliberate-violation test caught it. Every gate therefore needs a known-bad fixture.
 *
 * This covers: the unit runner, the typechecker, the linter, and the CI workflow's completeness.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    failures += 1
    if (detail) console.log(`      ${detail.split('\n').slice(0, 8).join('\n      ')}`)
  }
}

const runExpectingFailure = (cmd, args) => {
  try {
    execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { failed: false, output: '' }
  } catch (err) {
    return { failed: true, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

// 1. A failing unit test must fail the runner.
{
  const f = 'packages/core/src/__gate_fixture__.test.ts'
  writeFileSync(
    f,
    [
      "import { expect, it } from 'vitest'",
      "it('deliberately fails', () => {",
      '  expect(1).toBe(2)',
      '})',
      '',
    ].join('\n'),
  )
  const { failed } = runExpectingFailure('pnpm', [
    'exec',
    'vitest',
    'run',
    '-c',
    'vitest.config.ts',
  ])
  rmSync(f, { force: true })
  check('vitest fails the build on a failing test', failed)
}

// 2. A type error must fail the typechecker.
{
  const f = 'packages/core/src/__gate_fixture__.ts'
  writeFileSync(f, ['export const broken: number = "not a number"', ''].join('\n'))
  const { failed } = runExpectingFailure('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'])
  rmSync(f, { force: true })
  check('tsc fails the build on a type error', failed)
}

// 3. A lint error must fail the linter.
{
  const f = 'packages/core/src/__gate_fixture__.ts'
  // noExplicitAny is configured as an error in biome.json.
  writeFileSync(f, ['export function bad(x: any) {', '  return x', '}', ''].join('\n'))
  const { failed } = runExpectingFailure('pnpm', ['exec', 'biome', 'check', f])
  rmSync(f, { force: true })
  check('biome fails the build on an explicit any', failed)
}

// 4. A clock read in packages/core must fail the purity gate.
{
  const f = 'packages/core/src/__gate_fixture__.ts'
  writeFileSync(f, ['export const now = () => Date.now()', ''].join('\n'))
  const { failed } = runExpectingFailure('node', ['scripts/check-core-purity.mjs'])
  rmSync(f, { force: true })
  check('purity gate rejects a clock read in packages/core', failed)
}

// 5. A Drizzle column with no database counterpart must fail the drift gate.
{
  const f = 'packages/db/src/schema/__gate_fixture__.ts'
  writeFileSync(
    f,
    [
      "import { pgTable, text } from 'drizzle-orm/pg-core'",
      "export const ghost = pgTable('ghost_table', { phantom: text('phantom') })",
      '',
    ].join('\n'),
  )
  const { failed } = runExpectingFailure('node', ['scripts/check-schema-drift.mjs'])
  rmSync(f, { force: true })
  check('drift gate rejects a Drizzle table the database does not have', failed)
}

// 6. A naive timestamp column must fail the conventions gate.
{
  const f = 'packages/db/src/schema/__gate_fixture__.ts'
  writeFileSync(
    f,
    [
      "import { pgTable, timestamp } from 'drizzle-orm/pg-core'",
      "export const naive = pgTable('naive_table', { at: timestamp('at') })",
      '',
    ].join('\n'),
  )
  const { failed } = runExpectingFailure('node', ['scripts/check-schema-conventions.mjs'])
  rmSync(f, { force: true })
  check('conventions gate rejects a timestamp without withTimezone', failed)
}

// 7. A literal bidi override in source must fail the invisible-character gate.
{
  const f = 'packages/core/src/__gate_fixture__.ts'
  // A Trojan Source specimen. The override is built from its codepoint rather than typed, because
  // this file is itself scanned by the gate it is testing.
  const override = String.fromCodePoint(0x202e)
  writeFileSync(f, [`export const label = "Ahmed${override}"`, ''].join('\n'))
  const { failed } = runExpectingFailure('node', ['scripts/check-invisible-chars.mjs'])
  rmSync(f, { force: true })
  check('invisible-character gate rejects a literal bidi override in source', failed)
}

// 8. A zero-width space must fail the same gate. Different hazard, same scan.
{
  const f = 'packages/core/src/__gate_fixture__.ts'
  writeFileSync(f, [`export const sneaky = "a${String.fromCodePoint(0x200b)}b"`, ''].join('\n'))
  const { failed } = runExpectingFailure('node', ['scripts/check-invisible-chars.mjs'])
  rmSync(f, { force: true })
  check('invisible-character gate rejects a zero-width space in source', failed)
}

// 9. The CI workflow must actually run every gate. Dropping one here is a silent loss of coverage.
{
  const wf = readFileSync('.github/workflows/ci.yml', 'utf8')
  const required = [
    'pnpm lint',
    'pnpm typecheck',
    'pnpm boundaries',
    'pnpm boundaries:test',
    'pnpm purity',
    'pnpm invisibles',
    'pnpm palette',
    'pnpm test',
    'pnpm test:integration',
    'pnpm db:migrate:dry',
    'pnpm db:drift',
    'pnpm db:conventions',
    'pnpm gates:test',
    'postgres:16',
  ]
  const missing = required.filter((r) => !wf.includes(r))
  check(
    'CI workflow runs every gate',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : '',
  )
}

if (failures > 0) {
  console.error(`\n${failures} gate(s) did not fire. A gate that does not fail is not a gate.`)
  process.exit(1)
}
console.log('\nAll gates fire.')
