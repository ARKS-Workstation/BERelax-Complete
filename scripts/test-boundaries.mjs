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
  // packages/core/src/pricing resolves money. B-CAT-04's acceptance asks dependency-cruiser to prove it
  // reaches no database and no I/O, and the reason is narrower than tidiness: the resolver is the
  // function whose answer gets snapshotted onto an appointment and later defended to a customer. A
  // pricing module that read a row, a file or an environment variable would produce a figure that could
  // not be recomputed from the arguments it was given, and the snapshot would be the only evidence of a
  // number nobody can reproduce. Each forbidden shape is a separate case, because the pure rule's
  // `to.path` is one alternation and a typo in one branch is invisible while the others still fire.
  {
    rule: 'core-must-not-import-db',
    file: 'packages/core/src/pricing/__boundary_fixture__.ts',
    source: ["import { schema } from '@berelax/db'", 'export const illegal = schema', ''].join(
      '\n',
    ),
  },
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/pricing/__boundary_fixture__.ts',
    // The installed driver, not a bare uninstalled name: resolving into node_modules is the branch the
    // ledger fixture caught as dead, and a price list read straight from Postgres is exactly how this
    // module would stop being pure.
    source: ["import postgres from 'postgres'", 'export const illegal = postgres', ''].join('\n'),
  },
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/pricing/__boundary_fixture__.ts',
    source: [
      "import { readFileSync } from 'node:fs'",
      'export const illegal = readFileSync',
      '',
    ].join('\n'),
  },
  {
    rule: 'core-must-not-import-infrastructure',
    file: 'packages/core/src/pricing/__boundary_fixture__.ts',
    // packages/config reads the environment. A VAT rate or a rounding rule taken from configuration
    // rather than from an argument is the same defect as a clock read: the same input would price
    // differently on a different machine.
    source: [
      "import { loadConfig } from '@berelax/config'",
      'export const illegal = loadConfig',
      '',
    ].join('\n'),
  },
  // packages/core/src/checkout is the till's arithmetic: what a customer is charged, what is
  // discounted and what tax is due on the difference. M-TILL-05's acceptance asks dependency-cruiser to
  // prove it reaches no database, no I/O and no framework, and the reason is the same one the ledger
  // has: the basket's figures end up on a tax invoice that cannot be edited afterwards, so every one of
  // them must be reproducible from the arguments the basket was given. A basket that read
  // `service_variant` would re-price a treatment already delivered, which is precisely what the
  // snapshot exists to prevent — and the import would be the shortest way to do it. Each forbidden
  // shape is a separate case, because the pure rule's `to.path` is one alternation and a typo in one
  // branch is invisible while the others still fire.
  {
    rule: 'core-must-not-import-db',
    file: 'packages/core/src/checkout/__boundary_fixture__.ts',
    source: [
      "import { issueInvoice } from '@berelax/db'",
      'export const illegal = issueInvoice',
      '',
    ].join('\n'),
  },
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/checkout/__boundary_fixture__.ts',
    // The installed driver, not a bare uninstalled name: resolving into node_modules is the branch the
    // ledger fixture caught as dead. A till that read the price list itself would answer a disputed
    // figure with today's menu.
    source: ["import postgres from 'postgres'", 'export const illegal = postgres', ''].join('\n'),
  },
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/checkout/__boundary_fixture__.ts',
    // The framework half of the criterion. A basket that could reach `next/server` could read a request
    // — and then the same basket would total differently depending on who asked.
    source: [
      "import { NextResponse } from 'next/server'",
      'export const illegal = NextResponse',
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
  // B-AVAIL-04 asks dependency-cruiser to prove that packages/core holds only the eligibility PORT and
  // packages/db holds the implementation. Both directions are fixtures, and the scoped paths matter:
  // the rules' `from.path` is a prefix and the generic fixtures above sit at the package root, so a
  // rule that had stopped matching anything below `availability/` or `repositories/` would still be
  // reported as firing. The pull is real in both directions — the port's natural implementation reads
  // five tables, and the SQL implementation's natural home for the rules is the pure module that
  // already states them — which is exactly why the seam is a type rather than an import.
  {
    rule: 'core-must-not-import-db',
    file: 'packages/core/src/availability/__boundary_fixture__.ts',
    source: [
      "import { readEligibleTherapists } from '@berelax/db'",
      'export const illegal = readEligibleTherapists',
      '',
    ].join('\n'),
  },
  {
    rule: 'core-must-be-pure',
    file: 'packages/core/src/availability/__boundary_fixture__.ts',
    // The installed driver, not a bare uninstalled name: resolving into node_modules is the branch the
    // ledger fixture caught as dead. An availability solver that read its own shifts and leave would be
    // a solver whose answer cannot be reproduced from its arguments, which is the whole reason the pool
    // is injected.
    source: ["import postgres from 'postgres'", 'export const illegal = postgres', ''].join('\n'),
  },
  {
    rule: 'db-must-not-import-core',
    file: 'packages/db/src/repositories/__boundary_fixture__.ts',
    // `resolveTherapistPool` is the pure rule the SQL mirrors, so importing it here is the shortcut a
    // reader reaches for the first time the two look like duplication. It would invert the dependency
    // and make @berelax/db the thing that decides availability.
    source: [
      "import { resolveTherapistPool } from '@berelax/core'",
      'export const illegal = resolveTherapistPool',
      '',
    ].join('\n'),
  },
  // M-TILL-07 asks dependency-cruiser to prove the payment adapters reach no HTTP client. Both halves
  // of the rule's `to` alternation are asserted separately, because it is a single expression and a typo
  // in one branch is invisible while the other still fires — which is the defect the ledger fixture
  // above caught for `core-must-be-pure`. The pull is real: a gateway adapter is the natural next file
  // in this directory, and the boundary this keeps is that it does NOT go here.
  {
    rule: 'payments-must-not-reach-the-network',
    file: 'packages/db/src/adapters/__boundary_fixture__.ts',
    source: ["import { request } from 'node:https'", 'export const illegal = request', ''].join(
      '\n',
    ),
  },
  {
    rule: 'payments-must-not-reach-the-network',
    // A socket rather than an HTTP client: the same hazard one layer down, and the shape a "just check
    // the terminal is reachable" probe arrives in.
    file: 'packages/db/src/adapters/__boundary_fixture__.ts',
    source: ["import { connect } from 'node:net'", 'export const illegal = connect', ''].join('\n'),
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
  // The directory is part of the case identity: four cases share `core-must-be-pure`, and without the
  // scope in the line the output cannot say which of them ran.
  const scope =
    /packages\/core\/src\/(ledger|pricing|availability|checkout)\//.exec(file)?.[1] ??
    /packages\/db\/src\/(repositories|adapters)\//.exec(file)?.[1]
  console.log(
    `${caught ? 'PASS' : 'FAIL'}  ${rule} — ${scope === undefined ? '' : `${scope}: `}` +
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
