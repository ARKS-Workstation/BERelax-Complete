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
  // The ledger is the one directory in core whose purity has a statutory consequence: an append-only
  // journal that reached for a driver, a framework or the filesystem would be recording figures
  // derived from something other than its arguments, and the entries cannot be edited afterwards.
  // Each of the four forbidden shapes is asserted separately, because the rule's `to.path` is a
  // single alternation and a typo in one branch is invisible while the other three still fire.
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/ledger/__boundary_fixture__.ts',
    source: [
      "import { pgTable } from 'drizzle-orm/pg-core'",
      'export const illegal = pgTable',
      '',
    ].join('\n'),
  },
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/ledger/__boundary_fixture__.ts',
    source: ["import pg from 'pg'", 'export const illegal = pg', ''].join('\n'),
  },
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/ledger/__boundary_fixture__.ts',
    source: [
      "import { NextResponse } from 'next/server'",
      'export const illegal = NextResponse',
      '',
    ].join('\n'),
  },
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/ledger/__boundary_fixture__.ts',
    source: [
      "import { readFileSync } from 'node:fs'",
      'export const illegal = readFileSync',
      '',
    ].join('\n'),
  },
  {
    rule: 'messaging-providers-only-inside-a-transport',
    // A feature reaching SMSala directly bypasses the sender-ID class rule, the promotional gate and
    // the staging send guard at once. packages/messaging is the closest legal caller there is — one
    // directory away from src/transports — so it is the fixture most likely to be waved through.
    file: 'packages/messaging/src/__boundary_fixture__.ts',
    source: [
      "import { SMSALA } from '@berelax/providers'",
      'export const illegal = SMSALA',
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
  // The first import line is what distinguishes cases that share a rule name.
  const what = source.split('\n')[0]
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
    `${caught ? 'PASS' : 'FAIL'}  ${rule} — ${file.includes('/ledger/') ? 'ledger: ' : ''}` +
      `${what} ${caught ? 'rejected' : 'NOT rejected'}`,
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
