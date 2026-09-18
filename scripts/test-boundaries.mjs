#!/usr/bin/env node
/**
 * Proves the boundary rules actually fail, not just that they are configured.
 *
 * A lint rule nobody has seen fail is a lint rule that might not work. This writes a
 * deliberately illegal import into packages/core, asserts dependency-cruiser rejects it
 * by name, and always removes the fixture afterwards.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const CASES = [
  {
    rule: 'core-must-not-import-db',
    file: 'packages/core/src/__boundary_fixture__.ts',
    source: [
      "import { SCHEMA_VERSION } from '@berelax/db'",
      'export const illegal = SCHEMA_VERSION',
      '',
    ].join('\n'),
  },
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/__boundary_fixture__.ts',
    source: [
      "import { readFileSync } from 'node:fs'",
      'export const illegal = readFileSync',
      '',
    ].join('\n'),
  },
  {
    rule: 'core-must-not-import-infrastructure',
    file: 'packages/core/src/__boundary_fixture__.ts',
    source: [
      // packages/pdf drives a browser. core reaching it would make pricing logic need Chromium.
      "import { fontFaceCss } from '@berelax/pdf'",
      'export const illegal = fontFaceCss',
      '',
    ].join('\n'),
  },
  {
    rule: 'db-must-not-import-core',
    file: 'packages/db/src/__boundary_fixture__.ts',
    source: [
      "import { assertNever } from '@berelax/core'",
      'export const illegal = assertNever',
      '',
    ].join('\n'),
  },
]

let failures = 0

for (const { rule, file, source } of CASES) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, source)
  let output = ''
  let exitCode = 0
  try {
    output = execFileSync(
      'pnpm',
      ['exec', 'depcruise', '--config', '.dependency-cruiser.cjs', 'packages', 'apps'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  } catch (err) {
    exitCode = err.status ?? 1
    output = `${err.stdout ?? ''}${err.stderr ?? ''}`
  } finally {
    rmSync(file, { force: true })
  }

  const caught = exitCode !== 0 && output.includes(rule)
  console.log(
    `${caught ? 'PASS' : 'FAIL'}  ${rule} — violation ${caught ? 'rejected' : 'NOT rejected'}`,
  )
  if (!caught) {
    failures += 1
    console.log(`      exit=${exitCode}\n${output.split('\n').slice(0, 20).join('\n')}`)
  }
}

if (failures > 0) {
  console.error(`\n${failures} boundary rule(s) did not reject their violation.`)
  process.exit(1)
}
console.log('\nAll boundary rules reject their violations.')
