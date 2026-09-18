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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

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

const run = (cmd, args) => {
  try {
    return {
      failed: false,
      output: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    }
  } catch (err) {
    return { failed: true, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/**
 * Writes a known-bad fixture, runs something against it, and removes it in a `finally`.
 *
 * The `finally` is the point. A fixture left behind fails every subsequent gate in this file with a
 * violation that has nothing to do with the case being tested, and the first person to see it spends an
 * hour on the wrong bug. It has happened.
 */
const withFixture = (path, contents, body) => {
  // Refuse a path that already exists. This helper ENDS by deleting the file, which is right for a
  // fixture it created and destructive for anything tracked — and the failure is silent, because the
  // deletion happens in a `finally` after the assertion has already passed. It was pointed at
  // `build/manifest.yaml` once and deleted it; every unit's status went with it, and the only symptom
  // was an unrelated-looking control failing several cases later. Use `withEditedFile` for a file that
  // is supposed to survive.
  if (existsSync(path)) {
    throw new Error(
      `withFixture would DELETE the existing file ${path} when it finishes. Use withEditedFile, which ` +
        'restores the original bytes instead.',
    )
  }
  writeFileSync(path, contents.endsWith('\n') ? contents : `${contents}\n`)
  try {
    return body()
  } finally {
    rmSync(path, { force: true })
  }
}

/**
 * Temporarily replace the contents of a file that must still be there afterwards.
 *
 * `edit` receives the original text and returns the broken version. The original **bytes** are written
 * back — not a re-serialisation — so a restore cannot quietly reformat a file the next gate then reads.
 */
const withEditedFile = (path, edit, body) => {
  const original = readFileSync(path)
  writeFileSync(path, edit(original.toString()))
  try {
    return body()
  } finally {
    writeFileSync(path, original)
  }
}

/**
 * Asserts a gate rejected a fixture **by the rule written for it**.
 *
 * A bare non-zero exit is not enough: a fixture can be rejected by an unrelated rule while the one
 * under test has quietly stopped matching anything, and the gate then reports PASS forever. ADR 0003.
 */
const checkRejectedBy = (name, result, rule) => {
  check(
    name,
    result.failed && result.output.includes(rule),
    result.failed
      ? `exited non-zero but did not report ${rule}:\n${result.output}`
      : `exited zero; nothing was rejected:\n${result.output}`,
  )
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

// 9. A hand-edited palette token must fail the palette gate.
{
  const f = 'packages/ui/src/tokens/palette.generated.ts'
  const original = readFileSync(f, 'utf8')
  // The failure this guards is a designer nudging a hex by eye. The value still looks like gold; it
  // no longer meets 4.62:1, and nothing else in the system would notice.
  writeFileSync(f, original.replace("'accent-gold': '#946A32'", "'accent-gold': '#C08A43'"))
  const { failed } = runExpectingFailure('python3', ['scripts/palette.py'])
  writeFileSync(f, original)
  check('palette gate rejects a hand-edited token', failed)
}

// 10. A stale generated stylesheet must fail the tokens gate.
{
  const f = 'packages/ui/src/tokens/tokens.css'
  const original = readFileSync(f, 'utf8')
  writeFileSync(f, `${original}\n:root { --color-ink: #000000; }\n`)
  const { failed } = runExpectingFailure('pnpm', ['exec', 'tsx', 'scripts/emit-tokens.mjs'])
  writeFileSync(f, original)
  check('tokens gate rejects a hand-edited generated stylesheet', failed)
}

const COLOURS = ['scripts/check-colour-tokens.mjs']

// 11. An un-tokened colour must fail the colour gate.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__.ts',
    'export const css = `.x { color: #123456; }`',
    () => run('node', COLOURS),
  )
  checkRejectedBy('colour gate rejects an un-tokened colour', result, '[no-untokened-colour]')
}

// 11b. The prototype gold as a literal, which is the exact hex docs/08 names. Separate from 11 because
// it is also the value rule 2 is about, and a rule that caught it as "some hex" would be indistinguishable
// from one that understood it.
{
  const result = withFixture(
    'apps/web/app/__gate_fixture__.css',
    '.promise { color: #C08A43; }',
    () => run('node', COLOURS),
  )
  checkRejectedBy(
    'colour gate rejects a literal brand gold under apps/web',
    result,
    '[no-untokened-colour]',
  )
}

// 11c. The control for 11b. The same colour, as a token, on a property that carries no text, must pass —
// otherwise rule 1 is just "no gold anywhere" and the decorative half of the palette is unusable.
{
  const result = withFixture(
    'apps/web/app/__gate_fixture__.css',
    '.rule { background: var(--color-decor-gold); block-size: 1px; }',
    () => run('node', COLOURS),
  )
  check(
    'colour gate allows the decorative gold as a background',
    !result.failed,
    `rejected a legitimate decorative use:\n${result.output}`,
  )
}

// 12. The decorative brand gold on a text-bearing property must fail the colour gate.
{
  // 2.90:1. This is the specific mistake the whole classification exists to prevent.
  const result = withFixture(
    'packages/ui/src/__gate_fixture__.ts',
    'export const css = `.x { color: var(--color-decor-gold); }`',
    () => run('node', COLOURS),
  )
  checkRejectedBy(
    'colour gate rejects the decorative gold on a text-bearing property',
    result,
    '[decor-gold-never-carries-text]',
  )
}

// 13. A Tailwind default palette utility must fail the colour gate.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__.tsx',
    ['export const cls = ', '  "rounded p-2 " + "text-slate-700"'].join('\n'),
    () => run('node', COLOURS),
  )
  checkRejectedBy(
    'colour gate rejects a Tailwind default palette utility',
    result,
    '[no-tailwind-default-palette]',
  )
}

// 13b. The same rule, in the app, spelled the way it actually arrives: a class attribute copied from a
// snippet. `--color-*: initial` means `bg-red-500` produces no colour at all, so the page renders with a
// transparent background and nothing reports anything.
{
  const result = withFixture(
    'apps/web/app/__gate_fixture__.tsx',
    'export const Bad = () => <div className="rounded bg-red-500 p-4">sale</div>',
    () => run('node', COLOURS),
  )
  checkRejectedBy(
    'colour gate rejects bg-red-500 under apps/web',
    result,
    '[no-tailwind-default-palette]',
  )
}

// 13c. The display serif below the `lg` step, in CSS.
{
  const result = withFixture(
    'apps/web/app/__gate_fixture__.css',
    '.quote {\n  font-family: var(--font-display);\n  font-size: 0.875rem;\n}',
    () => run('node', COLOURS),
  )
  checkRejectedBy(
    'colour gate rejects the display serif below the lg step',
    result,
    '[no-display-font-below-lg]',
  )
}

// 13d. The same mistake as utilities, which is how it will actually be written.
{
  const result = withFixture(
    'apps/web/app/__gate_fixture__.tsx',
    'export const Bad = () => <p className="font-display text-sm">Al Zahiyah</p>',
    () => run('node', COLOURS),
  )
  checkRejectedBy(
    'colour gate rejects the display serif at a small text utility',
    result,
    '[no-display-font-below-lg]',
  )
}

// 13e. The control for 13c and 13d. The display face at and above `lg` is the whole reason it is in the
// system, so a rule that rejected it there would be a rule nobody could ship with.
{
  const result = withFixture(
    'apps/web/app/__gate_fixture__.css',
    '.quote {\n  font-family: var(--font-display);\n  font-size: var(--text-xl);\n}',
    () => run('node', COLOURS),
  )
  check(
    'colour gate allows the display serif at the xl step',
    !result.failed,
    `rejected a legitimate display use:\n${result.output}`,
  )
}

// 13f. dependency-cruiser must actually see apps/web. ADR 0002 is here because a toolchain change
// reduced the cruise to zero modules and reported success; a rule set that examines nothing passes every
// rule. The count is asserted against the app specifically, not against the repository total, because
// packages alone would keep the total comfortably non-zero.
{
  const result = run('pnpm', [
    'exec',
    'depcruise',
    '--config',
    '.dependency-cruiser.cjs',
    '--output-type',
    'json',
    'apps/web',
  ])
  let modules = 0
  try {
    modules = JSON.parse(result.output).modules.filter((m) =>
      m.source.startsWith('apps/web/'),
    ).length
  } catch {
    modules = 0
  }
  check(
    'boundaries cruise reaches apps/web',
    modules > 0,
    `cruised ${modules} modules under apps/web — a green tick on zero modules is ADR 0002`,
  )
}

// 14. A locked decision with no ADR must fail the coverage gate.
{
  const f = 'docs/01-scope-and-decisions.md'
  const original = readFileSync(f, 'utf8')
  // Inserted into the decisions table itself, not appended to the file: a row after the table is a
  // row the parser correctly ignores, and a fixture that tests the parser's blind spot tests nothing.
  const anchor = '| 1 | Repo shape'
  writeFileSync(
    f,
    original.replace(anchor, `| 99 | Gate fixture | A decision nobody recorded | — |\n${anchor}`),
  )
  const { failed } = runExpectingFailure('node', ['scripts/check-adr-coverage.mjs'])
  writeFileSync(f, original)
  check('ADR gate rejects a locked decision with no record', failed)
}

// 15. An ADR the index does not link must fail the same gate.
{
  const f = 'docs/adr/README.md'
  const original = readFileSync(f, 'utf8')
  writeFileSync(f, original.replace('(0021-catalogue-shape-and-packages-only.md)', '(missing.md)'))
  const { failed } = runExpectingFailure('node', ['scripts/check-adr-coverage.mjs'])
  writeFileSync(f, original)
  check('ADR gate rejects a record the index does not link', failed)
}

// 16. A stale progress ledger must fail.
{
  const f = 'docs/PROGRESS.md'
  const original = readFileSync(f, 'utf8')
  writeFileSync(f, original.replace('units complete', 'units complete (edited by hand)'))
  const { failed } = runExpectingFailure('python3', ['scripts/progress.py', '--check'])
  writeFileSync(f, original)
  check('progress gate rejects a hand-edited ledger', failed)
}

// 17. A changed fixture salon must fail the fixture gate.
{
  const f = 'packages/fixtures/src/salon.ts'
  const original = readFileSync(f, 'utf8')
  // One digit. Every committed screenshot was taken against the old dataset, and without this gate
  // the only symptom would be a gallery that diffs everywhere for no apparent reason.
  writeFileSync(
    f,
    original.replace(
      'export const DEFAULT_SEED = 20260918',
      'export const DEFAULT_SEED = 20260919',
    ),
  )
  const { failed } = runExpectingFailure('pnpm', ['exec', 'tsx', 'scripts/fixture-digest.mjs'])
  writeFileSync(f, original)
  check('fixture gate rejects a changed fixture salon', failed)
}

// 18. A design defect must fail the critique pass.
{
  // The non-compliant specimen exists for exactly this: body text on the 2.90:1 brand gold, a
  // measure with no cap, a 32px touch target and a physical margin. If the pass reports it clean,
  // the pass is decoration.
  const f = 'scripts/__gate_fixture__.mjs'
  writeFileSync(
    f,
    [
      "import { FIXTURE_NOW } from '../packages/fixtures/src/clock.ts'",
      "import { createCaptureHarness, critiqueResults } from '../packages/harness/src/capture.ts'",
      "import { summarise } from '../packages/harness/src/critique.ts'",
      "import { renderNonCompliantSpecimenHtml } from '../packages/harness/src/non-compliant.ts'",
      'const harness = await createCaptureHarness({ nowMs: FIXTURE_NOW })',
      'try {',
      "  const captures = await harness.capture({ name: 'bad', html: renderNonCompliantSpecimenHtml })",
      '  const counts = summarise(critiqueResults(captures))',
      '  if (counts.defects === 0) process.exit(0)',
      "  console.error(counts.defects + ' defect(s)')",
      '  process.exit(1)',
      '} finally { await harness.close() }',
      '',
    ].join('\n'),
  )
  const { failed } = runExpectingFailure('pnpm', ['exec', 'tsx', f])
  rmSync(f, { force: true })
  check('critique pass reports a deliberately non-compliant page as a defect', failed)
}

// 19. A media asset without a focal point must fail the media gate.
{
  const f = 'assets/media/manifest.json'
  const original = readFileSync(f, 'utf8')
  const manifest = JSON.parse(original)
  // The portraits are full-length at ratios from 0.461 to 0.799. Without a focal point a 4:5 crop
  // takes the torso and leaves the face out of frame — a defect that is invisible in code.
  const portrait = manifest.assets.find((asset) => asset.slot === 'therapist-portrait')
  delete portrait.focalX
  delete portrait.focalY
  writeFileSync(f, `${JSON.stringify(manifest, null, 2)}\n`)
  const { failed } = runExpectingFailure('node', ['scripts/check-media.mjs'])
  writeFileSync(f, original)
  check('media gate rejects a cropped asset with no focal point', failed)
}

// 20. An accessibility violation must fail the axe gate.
{
  // The same non-compliant specimen. axe reports its 2.90:1 body text as a serious colour-contrast
  // violation, independently of the critique pass — two implementations disagreeing would be a
  // finding, and both agreeing is what makes either worth running.
  const f = 'scripts/__gate_fixture__.mjs'
  writeFileSync(
    f,
    [
      "import { FIXTURE_NOW } from '../packages/fixtures/src/clock.ts'",
      "import { uniqueViolations } from '../packages/harness/src/accessibility.ts'",
      "import { accessibilityResults, createCaptureHarness } from '../packages/harness/src/capture.ts'",
      "import { renderNonCompliantSpecimenHtml } from '../packages/harness/src/non-compliant.ts'",
      'const harness = await createCaptureHarness({ nowMs: FIXTURE_NOW })',
      'try {',
      "  const captures = await harness.capture({ name: 'bad', html: renderNonCompliantSpecimenHtml })",
      '  const violations = uniqueViolations(accessibilityResults(captures))',
      '  if (violations.length === 0) process.exit(0)',
      "  console.error(violations.length + ' violation(s)')",
      '  process.exit(1)',
      '} finally { await harness.close() }',
      '',
    ].join('\n'),
  )
  const { failed } = runExpectingFailure('pnpm', ['exec', 'tsx', f])
  rmSync(f, { force: true })
  check('axe reports an inaccessible page as a violation', failed)
}

// 21. An uncovered file in packages/core must breach the coverage threshold.
{
  // packages/core carries a higher floor than the rest, because it is pure domain logic: money,
  // time, business day, authorisation. Thirty uncovered statements there take it under 95%.
  const f = 'packages/core/src/__gate_fixture__.ts'
  const lines = ['export function uncovered(n: number): number {', '  let total = 0']
  for (let i = 0; i < 30; i += 1) lines.push(`  if (n > ${i}) total += ${i}`)
  lines.push('  return total', '}', '')
  writeFileSync(f, lines.join('\n'))
  const { failed } = runExpectingFailure('pnpm', [
    'exec',
    'vitest',
    'run',
    '-c',
    'vitest.config.ts',
    '--coverage.enabled',
  ])
  rmSync(f, { force: true })
  check('coverage thresholds reject an uncovered file in packages/core', failed)
}

// 22. A breached byte budget must fail.
{
  const f = 'build/budgets.json'
  const original = readFileSync(f, 'utf8')
  const config = JSON.parse(original)
  // Payload weight never regresses in one visible step. It regresses eight kilobytes at a time.
  const tokens = config.budgets.find((budget) => budget.id === 'tokens-css')
  tokens.maxBytes = 256
  writeFileSync(f, `${JSON.stringify(config, null, 2)}\n`)
  const { failed } = runExpectingFailure('pnpm', ['exec', 'tsx', 'scripts/check-budgets.mjs'])
  writeFileSync(f, original)
  check('byte budgets reject an oversized artifact', failed)
}

// 23. The business-day suite must pass under a hostile process timezone.
{
  // Asia/Dubai has no DST, which makes a fixed +04:00 offset tempting and wrong: the assumption
  // survives every test until the day somebody runs the worker in another region. Kiritimati is
  // UTC+14 and Los Angeles is UTC-7, so a resolver that read the process timezone anywhere would
  // return a different trading date in one of them.
  let broke = false
  for (const tz of ['UTC', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    try {
      execFileSync(
        'pnpm',
        ['exec', 'vitest', 'run', '-c', 'vitest.config.ts', 'packages/core/src/business-day'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TZ: tz } },
      )
    } catch {
      broke = true
      console.log(`      failed under TZ=${tz}`)
    }
  }
  check('business-day resolution is identical under UTC, UTC+14 and UTC-7', !broke)
}

// 24. `Date` and `Intl` under packages/core/src/ledger must fail the purity gate — and the same code
//     must still be allowed elsewhere in core, or the ledger rule is not the thing doing the work.
{
  const outside = 'packages/core/src/__gate_fixture__.ts'
  const inside = 'packages/core/src/ledger/__gate_fixture__.ts'
  const source = (call) => `export const derived = ${call}`

  const cases = [
    ["new Date('2026-10-02T00:00:00Z').getUTCDay()", 'a Date built from a string'],
    [
      "new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(0)",
      'an Intl zone lookup',
    ],
  ]

  for (const [call, label] of cases) {
    // The control first. `packages/core/src/time.ts` needs exactly these two calls to render an
    // injected instant as wall-clock time in a named zone, so the general rule bans only the clock
    // *reads* — `Date.now()` and an argument-less `new Date()`. If purity rejected this fixture outside
    // the ledger as well, case 4 would already cover it and the ledger rule would be dead weight.
    const general = withFixture(outside, source(call), () =>
      run('node', ['scripts/check-core-purity.mjs']),
    )
    check(`purity gate allows ${label} elsewhere in packages/core`, !general.failed, general.output)

    // A ledger entry carries a LocalDate its caller already resolved on business_day. Re-deriving it
    // here disagrees with the caller for the nine hours either side of midnight and files the 01:30
    // sale under the wrong trading day.
    const scoped = withFixture(inside, source(call), () =>
      run('node', ['scripts/check-core-purity.mjs']),
    )
    check(`purity gate rejects ${label} under packages/core/src/ledger`, scoped.failed)
  }
}

// 25/26. Ledger amounts are branded integer fils, and the type system must say so. Both fixtures assert
//        on the *message*, not merely on a non-zero exit: a fixture that stopped compiling for an
//        unrelated reason would otherwise keep this gate green forever.
{
  const f = 'packages/core/src/ledger/__gate_fixture__.ts'
  const fixture = (imports, amount) =>
    [
      ...imports,
      "import { localDate } from '../time.ts'",
      "import { ACCOUNTS, STANDARD_SPA_CHART } from './chart-of-accounts.ts'",
      "import { credit, debit, entryId, postEntry } from './entry.ts'",
      'export const entry = postEntry(',
      '  {',
      "    entryId: entryId('JE-FIXTURE'),",
      "    entryDate: localDate('2026-10-02'),",
      "    narrative: 'fixture',",
      "    source: 'sale',",
      '    lines: [',
      `      debit(ACCOUNTS.cashInDrawer, ${amount}),`,
      `      credit(ACCOUNTS.treatmentRevenue, ${amount}),`,
      '    ],',
      '  },',
      '  STANDARD_SPA_CHART,',
      ')',
    ].join('\n')

  const typeErrors = [
    {
      name: 'tsc rejects a fractional amount passed to postEntry',
      // `IntegerLiteral<1.5>` is `never`, because `${1.5}` is "1.5" and that does not extend
      // `${bigint}`. AED 1.50 in fils is 150; a float in a money column surfaces during a VAT
      // reconciliation, by which point it is history.
      source: fixture(["import { aed } from '../money.ts'"], 'aed(1.5)'),
      expect: "Argument of type '1.5' is not assignable to parameter of type 'never'",
    },
    {
      name: 'tsc rejects a bare number passed to postEntry',
      // A bare number carries no currency and no statement about what unit it is in. Half the world's
      // money bugs are a figure in the wrong unit.
      source: fixture([], '15_000'),
      expect: "Argument of type 'number' is not assignable to parameter of type 'Money'",
    },
  ]

  for (const { name, source, expect: wanted } of typeErrors) {
    const { failed, output } = withFixture(f, source, () =>
      run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json']),
    )
    check(name, failed && output.includes(wanted), output)
  }
}

// 27. A malformed cron declaration must fail the job-registry gate, and a `boss.schedule` outside the
//      registry must fail it too. Both are invisible at runtime: pg-boss accepts a bad expression and
//      never fires it, and a schedule created outside the registry is never unscheduled when the job is
//      removed — it keeps firing from an upserted row nothing in the codebase mentions.
{
  const JOBS = ['exec', 'tsx', 'scripts/check-job-registry.mjs']

  {
    // Six fields. The plausible mistake: somebody writes a seconds field out of habit, and `0 0 3 * * *`
    // read as five fields is nonsense rather than a daily 03:00 job.
    const result = withFixture(
      'apps/worker/src/__gate_fixture__.ts',
      ['export const job = {', "  name: 'gate-fixture',", "  cron: '0 0 3 * * *',", '}'].join('\n'),
      () => run('pnpm', JOBS),
    )
    checkRejectedBy(
      'job gate rejects a 6-field cron declaration',
      result,
      '[invalid-cron-declaration]',
    )
  }

  {
    const result = withFixture(
      'apps/worker/src/__gate_fixture__.ts',
      [
        'export async function register(boss) {',
        "  await boss.schedule('gate-fixture', '0 3 * * *')",
        '}',
      ].join('\n'),
      () => run('pnpm', JOBS),
    )
    checkRejectedBy(
      'job gate rejects a schedule declared outside the registry',
      result,
      '[no-schedule-outside-the-registry]',
    )
  }

  {
    // A cron with no agent. G-AGT-01: without an agent_definition row a scheduled job has no declared
    // interval and no budget, so nothing is watching it and nothing is capping it. The fixture is a
    // declaration in the registry itself, because that is the only place the rule can see the pairing.
    const registry = 'apps/worker/src/registry.ts'
    const original = readFileSync(registry, 'utf8')
    let result
    try {
      writeFileSync(
        registry,
        original.replace(
          "    agent: 'agent_watchdog',",
          '    // gate fixture: the agent declaration removed',
        ),
      )
      result = run('pnpm', JOBS)
    } finally {
      writeFileSync(registry, original)
    }
    checkRejectedBy('job gate rejects a cron with no agent', result, '[cron-without-an-agent]')
  }

  {
    // The control. A valid declaration that does not schedule anything must pass, or the cases above
    // are satisfied by a gate that rejects every file it sees.
    const result = withFixture(
      'apps/worker/src/__gate_fixture__.ts',
      ['export const job = {', "  name: 'gate-fixture',", "  cron: '*/15 * * * *',", '}'].join(
        '\n',
      ),
      () => run('pnpm', JOBS),
    )
    check(
      'job gate allows a valid cron declaration',
      !result.failed,
      `rejected a legitimate declaration:\n${result.output}`,
    )
  }
}

// 27/28. The review delivery shape. `posted_at` on a review table must fail the schema-conventions
//        gate, and the identical column must still be allowed on a table that is not a review — or the
//        rule is banning a word rather than protecting a decision.
{
  const f = 'packages/db/migrations/__gate_fixture__.sql'
  const table = (name) =>
    [`create table ${name} (`, '  id uuid primary key,', '  posted_at timestamptz', ');'].join('\n')

  // The known-bad case. One `posted_at` reads identically whether the system submitted the reply through
  // the API or a human pasted it into Google and said so, which is the only question anybody asks of that
  // column afterwards — and it has no room for the API's separate acknowledgement. docs/10 §6 calls this
  // out as a decision that must be right on day one.
  const overloaded = withFixture(f, table('review_gate_fixture'), () =>
    run('node', ['scripts/check-schema-conventions.mjs']),
  )
  checkRejectedBy(
    'schema conventions reject posted_at on a review table',
    overloaded,
    'review-no-overloaded-posted-at',
  )

  // The control, which must PASS. `posted_at` is an honest name on a table that posts something, and a
  // gate that banned the string everywhere would prove nothing about the review decision while blocking
  // unrelated migrations.
  const elsewhere = withFixture(f, table('outbox_gate_fixture'), () =>
    run('node', ['scripts/check-schema-conventions.mjs']),
  )
  check(
    'schema conventions allow posted_at on a table that is not a review',
    !elsewhere.failed,
    elsewhere.output,
  )
}

// 26b. The catalogue constraints, as known-bad fixtures against real PostgreSQL.
//
// B-CAT-03's rules are database rules — a UNIQUE, two composite foreign keys and four CHECKs — and a
// constraint is only a gate once something has been seen to bounce off it. Each probe below is a statement
// the database must refuse **by the name of the rule written for it**: a bare non-zero exit is also what a
// typo in a column name produces, and the rule under test would then be dead while this file reported PASS
// for ever (ADR 0003).
//
// Every probe runs inside `begin; … ; rollback;`, so a probe that is wrongly *accepted* leaves nothing
// behind either — and the `finally` sweeps the four tables by marker regardless, because a fixture left in
// the catalogue fails every later gate with an error about the wrong thing.
{
  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  const ASIAN_NORMAL =
    "(select id from service where style = 'asian' and treatment_key = 'normal_massage')"
  const MARKER = 'gate fixture'

  const psqlProbe = (statement) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      dbUrl ?? '',
      '-c',
      `begin; ${statement}; rollback;`,
    ])

  // Written as data so the rule name sits next to the statement that must trip it. Anything added here
  // states its own rule, which is the only form of this test that cannot drift into "something failed".
  const probes = [
    {
      name: 'catalogue gate rejects a ninth service duplicating a (style, treatment_key) pair',
      rule: 'service_style_treatment_key_unique',
      sql:
        'insert into service (style, treatment_key, slug, internal_name, public_display_name, ' +
        "turnaround_minutes) values ('asian', 'normal_massage', 'gate-fixture-duplicate', 'Gate', " +
        "'Gate', 20)",
    },
    {
      name: 'catalogue gate rejects a compatibility row for a service that does not exist',
      rule: 'service_room_type_compat_service_fk',
      sql:
        'insert into service_room_type_compat (service_style, service_treatment_key, room_type) ' +
        "values ('asian', 'gate_fixture_ghost', 'standard')",
    },
    {
      name: 'catalogue gate rejects a resource shape demanding an incompatible room type',
      rule: 'service_resource_shape_room_type_compat_fk',
      sql:
        'insert into service_resource_shape (service_style, service_treatment_key, shape, ' +
        'therapists_required, rooms_required, min_room_capacity, required_room_type, ' +
        "therapist_buffer_minutes, provisional_note) values ('asian', 'morocco_bath_jacuzzi', " +
        `'couple', 2, 1, 2, 'couples', 10, '${MARKER}')`,
    },
    {
      name: 'catalogue gate rejects a couple shape that fits in a single room',
      rule: 'service_resource_shape_couple_holds_two',
      sql:
        'insert into service_resource_shape (service_style, service_treatment_key, shape, ' +
        'therapists_required, rooms_required, min_room_capacity, required_room_type, ' +
        "therapist_buffer_minutes, provisional_note) values ('arabic', 'massage_with_shaving', " +
        `'couple', 2, 1, 1, 'standard', 10, '${MARKER}')`,
    },
    {
      name: 'catalogue gate rejects a zero price',
      rule: 'service_variant_price_positive',
      sql:
        'insert into service_variant (service_id, duration_minutes, gross_price_fils, ' +
        `provisional_note) values (${ASIAN_NORMAL}, 60, 0, '${MARKER}')`,
    },
    {
      name: 'catalogue gate rejects a duration the price list has no column for',
      rule: 'service_variant_duration_allowed',
      sql:
        'insert into service_variant (service_id, duration_minutes, gross_price_fils, ' +
        `provisional_note) values (${ASIAN_NORMAL}, 50, 20000, '${MARKER}')`,
    },
    {
      name: 'catalogue gate rejects a provisional value that names no open question',
      rule: 'service_provisional_names_a_question',
      sql:
        'insert into service (style, treatment_key, slug, internal_name, public_display_name, ' +
        "turnaround_minutes, is_provisional) values ('asian', 'gate_fixture_unflagged', " +
        "'gate-fixture-unflagged', 'Gate', 'Gate', 20, true)",
    },
  ]

  try {
    if (!dbUrl) {
      check(
        'catalogue constraints reject their known-bad fixtures',
        false,
        'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
      )
    } else {
      for (const { name, rule, sql: statement } of probes) {
        checkRejectedBy(name, psqlProbe(statement), rule)
      }

      // The controls, and the reason the seven above mean anything: the same tables accept a legitimate
      // row. Without these, a broken connection string or a renamed table would reject every probe and
      // this gate would report seven passes while examining nothing.
      const legitimateVariant = psqlProbe(
        'insert into service_variant (service_id, duration_minutes, gross_price_fils, ' +
          `provisional_note) values (${ASIAN_NORMAL}, 45, 17000, '${MARKER}')`,
      )
      check(
        'catalogue gate accepts a 45-minute variant at a positive price',
        !legitimateVariant.failed,
        `rejected a legitimate variant:\n${legitimateVariant.output}`,
      )

      // A room type the service has a compatibility row for. Massage with Shaving is seeded standard-only,
      // so this is the shape foreign key being satisfied rather than bypassed.
      const legitimateShape = psqlProbe(
        'insert into service_resource_shape (service_style, service_treatment_key, shape, ' +
          'therapists_required, rooms_required, min_room_capacity, required_room_type, ' +
          "therapist_buffer_minutes, provisional_note) values ('arabic', 'massage_with_shaving', " +
          `'four_hands', 2, 1, 1, 'standard', 10, '${MARKER}')`,
      )
      check(
        'catalogue gate accepts a shape whose room type the service is compatible with',
        !legitimateShape.failed,
        `rejected a legitimate resource shape:\n${legitimateShape.output}`,
      )
    }
  } finally {
    if (dbUrl) {
      run('psql', [
        '--no-psqlrc',
        '-q',
        dbUrl,
        '-c',
        `delete from service_variant where provisional_note = '${MARKER}'; ` +
          `delete from service_resource_shape where provisional_note = '${MARKER}'; ` +
          "delete from service where slug like 'gate-fixture%';",
      ])
    }
  }
}

// 28. An append-only table that only half keeps its promise must fail the conventions gate.
//     ADR 0017's journal is enforced by a PAIR of BEFORE triggers, and the pair is where the defect
//     hides: you write one, copy it for the other event, and forget to change the word. The table then
//     documents a guarantee it half keeps, and the missing half is invisible in review precisely
//     because the comment says otherwise. Four fixtures: three defects and the control that passes.
{
  const f = 'packages/db/migrations/9999__gate_fixture__.sql'
  const RULE = 'append-only-table-must-refuse-update-and-delete'
  const TABLE = 'gate_fixture_event_log'

  const refusal = (event) =>
    [
      `create trigger ${TABLE}_no_${event} before ${event} on ${TABLE}`,
      '  for each row execute function refuse_journal_change();',
    ].join('\n')

  const fixture = ({ extraColumn = '', triggers = [] }) =>
    [
      '-- Known-bad fixture written by scripts/test-gates.mjs. Removed in a finally.',
      `create table ${TABLE} (`,
      '  id          bigint      generated always as identity primary key,',
      `  occurred_at timestamptz not null default now()${extraColumn === '' ? '' : ','}`,
      extraColumn,
      ');',
      `comment on table ${TABLE} is`,
      "  'Append-only: UPDATE and DELETE raise. A deliberate fixture, never applied to a database.';",
      ...triggers,
    ]
      .filter((line) => line !== '')
      .join('\n')

  const cases = [
    {
      name: 'conventions gate rejects an append-only table with no refusal trigger at all',
      source: fixture({}),
      rule: `${RULE}: ${TABLE} is documented as raising on UPDATE and DELETE, but no BEFORE UPDATE trigger`,
    },
    {
      // The copy-paste defect, in the shape it actually arrives: DELETE covered, UPDATE forgotten.
      name: 'conventions gate rejects an append-only table whose UPDATE trigger is missing',
      source: fixture({ triggers: [refusal('delete')] }),
      rule: `${RULE}: ${TABLE} is documented as raising on UPDATE and DELETE, but no BEFORE UPDATE trigger`,
    },
    {
      // What arrives when a mutable table's definition is copied to make the next log.
      name: 'conventions gate rejects an updated_at column on an append-only table',
      source: fixture({
        extraColumn: '  updated_at  timestamptz not null default now()',
        triggers: [refusal('update'), refusal('delete')],
      }),
      rule: `${RULE}: ${TABLE} is append-only and has an updated_at column`,
    },
    {
      name: 'conventions gate rejects a set_updated_at trigger on an append-only table',
      source: fixture({
        triggers: [
          refusal('update'),
          refusal('delete'),
          `create trigger ${TABLE}_updated_at before update on ${TABLE}`,
          '  for each row execute function set_updated_at();',
        ],
      }),
      rule: `${RULE}: ${TABLE} is append-only and carries a set_updated_at trigger`,
    },
  ]

  for (const { name, source, rule } of cases) {
    const result = withFixture(f, source, () =>
      run('node', ['scripts/check-schema-conventions.mjs']),
    )
    checkRejectedBy(name, result, rule)
  }

  // The control. The same table, correctly enforced, must PASS — otherwise the four cases above would
  // be satisfied by a gate that rejected every append-only table, including the three real ones.
  const correct = withFixture(
    f,
    fixture({ triggers: [refusal('update'), refusal('delete')] }),
    () => run('node', ['scripts/check-schema-conventions.mjs']),
  )
  check(
    'conventions gate accepts an append-only table that refuses both UPDATE and DELETE',
    !correct.failed,
    correct.output,
  )
}

const LAYOUT = ['scripts/check-layout-rules.mjs']

// 26a. (B-LIFE-02) The OTP route must not reach an SMS provider directly.
//
//      The rule already exists — `messaging-providers-only-inside-a-transport`, with its fixture in
//      scripts/test-boundaries.mjs pointed at packages/messaging. This case points it at the place the
//      temptation actually lives: an API route that needs to send one SMS and is three lines from
//      importing SMSala to do it. Bypassing `sendMessage` there would skip the sender-ID class rule,
//      the promotional gate, the campaign cap and the staging guard at once, which in a non-production
//      run means a real code to a real handset. Asserted BY RULE NAME: a fixture rejected by some other
//      rule would leave this one free to stop matching.
{
  const result = withFixture(
    'apps/web/app/api/v1/otp/__gate_fixture__.ts',
    ["import { SMSALA } from '@berelax/providers'", 'export const illegal = SMSALA'].join('\n'),
    () =>
      run('pnpm', ['exec', 'depcruise', '--config', '.dependency-cruiser.cjs', 'packages', 'apps']),
  )
  checkRejectedBy(
    'boundaries reject an SMS provider import from the OTP route',
    result,
    'messaging-providers-only-inside-a-transport',
  )
}

// 26b. (B-LIFE-02) The control for 26a: the choke point itself must remain importable from a route.
//
//      Without this, the rule above is indistinguishable from "apps may not send messages", and the
//      only way to satisfy that reading is to send them from somewhere worse.
{
  const result = withFixture(
    'apps/web/app/api/v1/otp/__gate_fixture__.ts',
    [
      "import { sendMessage } from '@berelax/messaging'",
      'export const legitimate = sendMessage',
    ].join('\n'),
    () =>
      run('pnpm', ['exec', 'depcruise', '--config', '.dependency-cruiser.cjs', 'packages', 'apps']),
  )
  check(
    'boundaries allow the sendMessage choke point in an API route',
    !result.failed,
    `rejected the legitimate send path:\n${result.output}`,
  )
}

// The Google consent scope set is closed by the TYPE SYSTEM, and the type is the gate (G-CONN-02).
//
// `business.manage` has no read-only variant — the scope that reads reviews also rewrites the address
// and the opening hours — so the consent screen is the only place the owner limits what this system can
// do to their Google presence. A future unit adding a scope "while it is in there" is the realistic way
// that gets widened, and a code review is a weak defence against a one-line array change.
//
// So `REQUESTED_GOOGLE_SCOPES` is typed as `readonly GoogleRequestedScope[]`, a union of exactly the two
// scopes docs/10 §3 permits, and `buildAuthorizationRequest` accepts nothing else. These fixtures prove
// the compiler rejects the two additions that would actually be attempted, and — the case that makes the
// other two mean something — that a permitted scope written out as a bare string still compiles.
{
  const f = 'packages/google/src/oauth/__gate_fixture__.ts'
  const fixture = (scope) =>
    [
      "import { fixedClock } from '@berelax/core'",
      "import { createCallLog } from '@berelax/providers/call-log'",
      "import { FailureScript } from '@berelax/providers/failure'",
      "import { createFakeGoogleOAuth } from '@berelax/providers/google'",
      "import { buildAuthorizationRequest } from './consent.ts'",
      "const at = '2026-09-18T10:00:00.000Z'",
      'const oauth = createFakeGoogleOAuth({',
      '  log: createCallLog(() => at),',
      '  failures: new FailureScript(),',
      '  now: () => at,',
      '})',
      'export const request = buildAuthorizationRequest(',
      '  { oauth, clock: fixedClock(at) },',
      `  { scopes: ['${scope}'] },`,
      ')',
    ].join('\n')

  const rejected = "is not assignable to type 'GoogleRequestedScope'"
  const widenings = [
    [
      'the read-write Search Console scope',
      'https://www.googleapis.com/auth/webmasters',
      // Nine characters from the scope we do want, and all it buys is sitemap submission — a one-time
      // manual action in the Search Console UI.
    ],
    [
      'a Gmail scope',
      'https://www.googleapis.com/auth/gmail.readonly',
      // Worse than unnecessary: Google ties password-change revocation to refresh tokens carrying Gmail
      // scopes, so adding one turns an invalidation cause that does not apply to us into one that does.
    ],
  ]

  for (const [label, scope] of widenings) {
    const result = withFixture(f, fixture(scope), () =>
      run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json']),
    )
    checkRejectedBy(`tsc rejects ${label} in the Google authorization request`, result, rejected)
  }

  // The control. If tsc rejected this too, the union would be broken rather than strict, and both cases
  // above would be passing for the wrong reason.
  const permitted = withFixture(
    f,
    fixture('https://www.googleapis.com/auth/webmasters.readonly'),
    () => run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json']),
  )
  check(
    'tsc accepts the read-only Search Console scope, so the union is strict and not broken',
    !permitted.failed,
    permitted.output,
  )
}

// 26a. A direction selector inside a keyframes block. It is not even valid there, so the animation
//      plays unmirrored and nothing reports anything: the RTL page slides in from the wrong side.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__.css',
    [
      '@keyframes gate-fixture-slide {',
      '  from { transform: translateX(32px); }',
      '  [dir="rtl"] & { transform: translateX(-32px); }',
      '}',
    ].join('\n'),
    () => run('node', LAYOUT),
  )
  checkRejectedBy(
    'layout gate rejects a direction selector inside @keyframes',
    result,
    '[no-rtl-inside-keyframes]',
  )
}

// 26b. The same animation authored twice, as a name suffix. This is the shape it actually ships in.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__.css',
    '@keyframes gate-fixture-reveal-rtl {\n  from { transform: translateX(-32px); }\n}',
    () => run('node', LAYOUT),
  )
  checkRejectedBy(
    'layout gate rejects a per-direction copy of one animation',
    result,
    '[no-mirrored-keyframes-pair]',
  )
}

// 26c. And as a direction rule that swaps which animation plays.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__.css',
    '[dir="rtl"] .gate-fixture {\n  animation-name: gate-fixture-mirrored;\n}',
    () => run('node', LAYOUT),
  )
  checkRejectedBy(
    'layout gate rejects an RTL rule that selects a different animation',
    result,
    '[no-mirrored-keyframes-pair]',
  )
}

// 26d. The control for 26a-26c: the mechanism docs/08 §5 actually specifies. One keyframe set whose
//      inline distance is multiplied by --dir, and an RTL rule that sets something other than an
//      animation. If this were rejected the whole direction multiplier would be unusable.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__.css',
    [
      '@keyframes gate-fixture-good {',
      '  from { transform: translateX(calc(var(--move-lg) * var(--dir))); }',
      '  to { transform: translateX(0); }',
      '}',
      '[dir="rtl"] .gate-fixture { text-align: start; }',
    ].join('\n'),
    () => run('node', LAYOUT),
  )
  check(
    'layout gate allows one keyframe set mirrored by var(--dir)',
    !result.failed,
    `rejected the mechanism docs/08 §5 specifies:\n${result.output}`,
  )
}

// 26e. A page breakpoint inside a container-query component. The card is used four-across on the home
//      page, in the measure column of a treatment page and in a 300px admin rail — three widths at one
//      viewport, so a @media rule is right in one place and wrong in two.
{
  const result = withFixture(
    'packages/ui/src/patterns/__gate_fixture__.tsx',
    'export const CSS = `@media (min-width: 768px) { .be-card__link { grid-template-columns: 1fr 1fr; } }`',
    () => run('node', LAYOUT),
  )
  checkRejectedBy(
    'layout gate rejects a viewport breakpoint in a container-query component',
    result,
    '[no-media-query-in-container-component]',
  )
}

// 26f. The control for 26e. The same rule as a container query is the correct spelling.
{
  const result = withFixture(
    'packages/ui/src/patterns/__gate_fixture__.tsx',
    'export const CSS = `@container therapist-card (min-width: 340px) { .be-card__link { grid-template-columns: 1fr 1fr; } }`',
    () => run('node', LAYOUT),
  )
  check(
    'layout gate allows a container query in a container-query component',
    !result.failed,
    `rejected a legitimate @container rule:\n${result.output}`,
  )
}

// 26g. A second shadow. docs/08 §2 specifies exactly one, and a system stops being flat at the first
//      hand-rolled `0 2px 6px`. The fixture is named as an overlay so that only rule 4 can fire.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__-dialog.css',
    '.gate-fixture-dialog { box-shadow: 0 2px 6px var(--color-ink); }',
    () => run('node', LAYOUT),
  )
  checkRejectedBy(
    'layout gate rejects a shadow that is not the overlay token',
    result,
    '[shadow-must-use-overlay-token]',
  )
}

// 26h. The one shadow, on something that does not float. A card has a hairline and a surface already.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__.css',
    '.be-card { box-shadow: var(--shadow-overlay); }',
    () => run('node', LAYOUT),
  )
  checkRejectedBy(
    'layout gate rejects the overlay shadow outside an overlay component',
    result,
    '[shadow-only-in-overlay-components]',
  )
}

// 26i. A shadow in the dark theme, where `--shadow-overlay` is already `none`: at best dead code, at
//      worst a literal that defeats the token. On a dark ground a shadow reads as a smudge.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__-sheet.css',
    ':root[data-theme="dark"] .gate-fixture-sheet { box-shadow: var(--shadow-overlay); }',
    () => run('node', LAYOUT),
  )
  checkRejectedBy(
    'layout gate rejects a shadow inside a dark-theme block',
    result,
    '[no-shadow-in-dark-theme]',
  )
}

// 26j. The control for 26g-26i. The overlay token, on an overlay, in the light theme, is the one
//      elevation the system has — and a gate that rejected it would ban the dialog.
{
  const result = withFixture(
    'packages/ui/src/__gate_fixture__-dialog.css',
    '.gate-fixture-dialog { box-shadow: var(--shadow-overlay); border-radius: var(--radius-3); }',
    () => run('node', LAYOUT),
  )
  check(
    'layout gate allows the overlay shadow on an overlay component',
    !result.failed,
    `rejected the one legitimate elevation:\n${result.output}`,
  )
}

const TOUCH = ['exec', 'tsx', 'scripts/check-touch-targets.mjs']

// 26k. A 32px button must fail the touch-target audit **by name**. This is what `padding: 4px 10px`
//      produces, it looks deliberate, and it is a mis-tap on a phone at half past midnight on the one
//      page that takes a booking. docs/08 §4 puts the mobile floor at 48px.
{
  const result = withFixture(
    'scripts/__gate_fixture__.html',
    [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><title>fixture</title></head>',
      '<body><main><button type="button" style="width:32px;height:32px">Book</button></main></body>',
      '</html>',
    ].join('\n'),
    () => run('pnpm', [...TOUCH, 'scripts/__gate_fixture__.html']),
  )
  checkRejectedBy('touch-target gate rejects a 32px button', result, '[touch-target-too-small]')
}

// 26l. Two targets that are each big enough and 4px apart. Size alone passes this, which is why the
//      gap is a separate rule: a thumb aimed at the join lands on whichever one it lands on.
{
  const result = withFixture(
    'scripts/__gate_fixture__.html',
    [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><title>fixture</title></head>',
      '<body><main style="display:flex;gap:4px;padding:40px">',
      '<button type="button" style="width:48px;height:48px">11:00</button>',
      '<button type="button" style="width:48px;height:48px">12:30</button>',
      '</main></body></html>',
    ].join('\n'),
    () => run('pnpm', [...TOUCH, 'scripts/__gate_fixture__.html']),
  )
  checkRejectedBy(
    'touch-target gate rejects a 4px gap between targets',
    result,
    '[touch-target-gap]',
  )
}

// 26m. The control for 26k and 26l. Two 48x48 targets 12px apart is the slot grid, and it has to pass
//      at both floors or the gate is unshippable.
{
  const result = withFixture(
    'scripts/__gate_fixture__.html',
    [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><title>fixture</title></head>',
      '<body><main style="display:flex;gap:12px;padding:40px">',
      '<button type="button" style="width:88px;height:48px">11:00</button>',
      '<button type="button" style="width:88px;height:48px">12:30</button>',
      '</main></body></html>',
    ].join('\n'),
    () => run('pnpm', [...TOUCH, 'scripts/__gate_fixture__.html']),
  )
  check(
    'touch-target gate allows 48x48 targets 12px apart',
    !result.failed,
    `rejected a compliant pair:\n${result.output}`,
  )
}

// 28b. Nothing may be posted before the books open (M-VAT-05), and the opening entry itself may.
//
//       The rule is a trigger rather than a check in each of the five posting paths (invoice, bill, credit
//       note, payment, redemption), because a rule enforced in five places has five chances to be
//       forgotten — and the one that is forgotten is the one that posts into the period the opening
//       balances already summarise, so the figure is counted twice. Both cases run against real
//       PostgreSQL inside `begin ... rollback`, because a trigger is only a gate once something has been
//       seen to bounce off it.
{
  const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
  const psql = (statements) => run('psql', ['-v', 'ON_ERROR_STOP=1', url, '-c', statements])

  if (url === '') {
    // Loudly, not silently. A gate that skips when its environment is absent is the ADR 0002 failure.
    check(
      'opening-balance guard rejects a backdated posting',
      false,
      'TEST_DATABASE_URL is not set',
    )
  } else {
    // A date far enough back that nothing else in any database this runs against has imported there —
    // the unique key is on (entity, date), and a shared development database will already hold the real
    // import. `opening_date_for` takes the **earliest**, so this row is the binding floor inside the
    // transaction whatever else exists, which is exactly what the two cases below need.
    const opening = `
      begin;
      insert into legal_entity (id, legal_name, trading_name)
        values (1, 'gate fixture', 'gate fixture') on conflict (id) do nothing;
      insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('JE-GATE-OPEN', '2020-01-01', 'gate fixture opening', 'opening_balance');
      insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('JE-GATE-OPEN', 1, '1010', 100, 0), ('JE-GATE-OPEN', 2, '3010', 0, 100);
      insert into opening_balance_import
        (legal_entity_id, opening_date, entry_id, total_debit_fils, total_credit_fils, imported_by)
        values (1, '2020-01-01', 'JE-GATE-OPEN', 100, 100, 'gate');
    `

    const backdated = psql(`${opening}
      insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('JE-GATE-EARLY', '2019-12-31', 'a sale before the books open', 'sale');
      rollback;
    `)
    checkRejectedBy(
      'opening-balance guard rejects a backdated posting',
      backdated,
      'BeforeOpeningBalance',
    )

    // The control, which must succeed. A guard that refused everything would satisfy the case above and
    // make the system unusable on its first trading day — and the opening entry itself predates the import
    // row that creates the guard, so it has to be possible at all.
    const onOpeningDay = psql(`${opening}
      insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('JE-GATE-OK', '2020-01-01', 'a sale on the opening date', 'sale');
      insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values ('JE-GATE-OK', 1, '1010', 50, 0), ('JE-GATE-OK', 2, '4010', 0, 50);
      rollback;
    `)
    check(
      'opening-balance guard allows a posting on the opening date',
      !onOpeningDay.failed,
      `refused a legitimate posting on the opening date:\n${onOpeningDay.output}`,
    )
  }
}

// 28a. W-SYS-05's media reference rules. Both are decisions that a single import silently reverses: a
//       blurhash dependency undoes the flat-OKLCH placeholder, and one hard-coded `/originals/` or Spaces
//       hostname undoes both the consent boundary on the private bucket and the same-origin requirement
//       the requests-to-LCP budget depends on.
{
  const MEDIA = ['scripts/check-media.mjs']
  const f = 'packages/media/src/__gate_fixture__.ts'

  {
    const result = withFixture(
      f,
      ["import { decode } from 'blurhash'", 'export const placeholder = decode'].join('\n'),
      () => run('node', MEDIA),
    )
    checkRejectedBy('media gate rejects a blurhash in source', result, '[no-blurhash]')
  }

  {
    // The dependency half, which is the one that matters: a package.json is where a blurhash actually
    // arrives. Written inside `packages/media/src` because `withFixture` needs an existing directory, and
    // removed by its `finally` — nothing resolves modules out of that directory during this gate.
    const result = withFixture(
      'packages/media/src/package.json',
      JSON.stringify({ name: 'gate-fixture', dependencies: { blurhash: '2.0.5' } }),
      () => run('node', MEDIA),
    )
    checkRejectedBy('media gate rejects a blurhash dependency', result, '[no-blurhash]')
  }

  {
    const result = withFixture(
      f,
      'export const hero = `/originals/0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f.jpg`',
      () => run('node', MEDIA),
    )
    checkRejectedBy(
      'media gate rejects a URL that reaches a private original',
      result,
      '[no-private-origin-url]',
    )
  }

  {
    const result = withFixture(
      f,
      "export const hero = 'https://berelax-media.fra1.cdn.digitaloceanspaces.com/hero.avif'",
      () => run('node', MEDIA),
    )
    checkRejectedBy('media gate rejects a Spaces CDN hostname', result, '[no-private-origin-url]')
  }

  {
    // The first control. A legitimate media URL — same-origin, content-addressed — must pass, or the four
    // cases above are satisfied by a gate that rejects every file it is shown.
    const result = withFixture(
      f,
      'export const hero = `/m/0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f/9f86d081884c7d65/hero-mobile-1080.avif`',
      () => run('node', MEDIA),
    )
    check(
      'media gate allows a content-addressed same-origin derivative URL',
      !result.failed,
      `rejected a legitimate media URL:\n${result.output}`,
    )
  }

  {
    // The second control, and it is the exemption rather than a happy path. `url.test.ts` and
    // `port.test.ts` assert that a private path is *rejected* by the parser and by the header helper, which
    // means they have to contain one. A rule without this exemption would make those tests impossible to
    // write — the failure mode `check-job-registry.mjs` documents for the 6-field cron in `worker.itest.ts`.
    const result = withFixture(
      'packages/media/src/__gate_fixture__.itest.ts',
      'export const privateKey = `/originals/0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f.jpg`',
      () => run('node', MEDIA),
    )
    check(
      'media gate exempts a test that has to contain a private path',
      !result.failed,
      `rejected a test file:\n${result.output}`,
    )
  }
}

// 28b. W-SYS-05's derivative byte budget. docs/08 §8 caps the hero poster at 95KB on the 4:5 crop and
//       170KB on the 16:9 crop, and no derivative is committed — so `pnpm budgets` builds them with the
//       same encoder the job uses and measures. The fixture below replaces the hero original with a
//       high-entropy one, which is the only way this budget can be seen to fail.
{
  const hero = 'assets/media/photos/hero-team.jpg'
  const original = readFileSync(hero)
  // An SVG, deliberately: `withFixture` writes text, and sharp identifies a source by its content rather
  // than its extension, so a `.jpg` holding an `feTurbulence` fill renders as dense noise. Noise is what
  // an oversized fixture needs — AVIF at q52 spends about 214KB on this at the widest mobile rung against
  // a 95KB budget. Restored in the `finally`; `pnpm media` also fails on a leftover, because the manifest
  // records this file's exact byte count.
  const noise = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1100">',
    '<filter id="n">',
    '<feTurbulence type="fractalNoise" baseFrequency="0.2" numOctaves="1" seed="7"/>',
    '</filter>',
    '<rect width="1400" height="1100" filter="url(#n)"/>',
    '</svg>',
  ].join('')
  let result
  try {
    writeFileSync(hero, noise)
    result = run('pnpm', ['budgets'])
  } finally {
    writeFileSync(hero, original)
  }
  checkRejectedBy(
    'budget gate rejects an oversized hero derivative',
    result,
    '[over-budget] hero-avif-mobile',
  )
  // The measured byte count, not a rounded kilobyte: the first question anybody asks of a breached budget
  // is by how much, and a budget that reported only "over" would send them to run it again by hand.
  check(
    'budget gate reports the measured byte count',
    /\[over-budget] hero-avif-mobile: measured \d{6} bytes against a budget of 97280 bytes/.test(
      result.output,
    ),
    result.output,
  )
  // The control. A gate that failed everything would satisfy both assertions above, so the same run must
  // still report the unrelated budgets as passing.
  check(
    'budget gate still passes the budgets the fixture did not touch',
    result.output.includes('PASS  Design tokens stylesheet') &&
      result.output.includes('PASS  A one-page tax invoice'),
    result.output,
  )
}

// 28a-28l. (B-CAT-04) The price resolution chain: the purity of packages/core/src/pricing, and the
// price_list rules against real PostgreSQL.
//
// Two gates, one unit. The purity of `pricing` is scoped the way the ledger's is in case 24 and for a
// related reason: `resolvePrice` produces the figure that gets snapshotted onto an appointment and
// defended to a customer months later, so it has to be recomputable from its arguments alone. A clock
// read there would answer "what did this cost on the 3rd of March" with today's menu.
//
// The price_list rules are database rules — an EXCLUDE USING gist and four CHECKs — and a constraint is
// only a gate once something has been seen to bounce off it. Each probe states the rule that must reject
// it, because a bare non-zero exit is also what a typo in a column name produces (ADR 0003).
//
// B-CAT-03 did not seed the 32 prices, so there is no service_variant row to hang a price list off:
// every probe creates its own inside `begin; … ; rollback;` and leaves nothing behind.
{
  const PRICING_FIXTURE = 'packages/core/src/pricing/__gate_fixture__.ts'

  // 28a. A clock read inside packages/core/src/pricing must fail the purity gate, by the reason the
  //      rule gives rather than by a bare non-zero exit.
  {
    const result = withFixture(
      PRICING_FIXTURE,
      'export const priceNow = (): string => new Date().toISOString()',
      () => run('node', ['scripts/check-core-purity.mjs']),
    )
    checkRejectedBy(
      'purity gate rejects a clock read in packages/core/src/pricing',
      result,
      'inject a Clock and pass the instant in',
    )
  }

  // 28b. The control for 28a. Taking the effective date as an argument is the whole design, and a gate
  //      that rejected it would make the module unwritable.
  {
    const result = withFixture(
      PRICING_FIXTURE,
      'export const priceOn = (on: string): string => on',
      () => run('node', ['scripts/check-core-purity.mjs']),
    )
    check(
      'purity gate allows a pricing module whose effective date is an argument',
      !result.failed,
      `rejected the mechanism B-CAT-04 specifies:\n${result.output}`,
    )
  }

  const priceDbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  // Two variants and one price list row, created inside the probe transaction. `provisional_note` is
  // the handle rather than a new column: it is unconstrained while `is_provisional` stays false.
  const PRICE_SETUP =
    'insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note) ' +
    "values ((select id from service where style = 'asian' and treatment_key = 'normal_massage'), " +
    "60, 20000, 'gate fixture 60'), " +
    "((select id from service where style = 'asian' and treatment_key = 'normal_massage'), " +
    "90, 30000, 'gate fixture 90'); " +
    'insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to) ' +
    "values ((select id from service_variant where provisional_note = 'gate fixture 60'), 18000, " +
    "'gate fixture', '2027-03-01', '2027-03-31');"
  const VARIANT_60 = "(select id from service_variant where provisional_note = 'gate fixture 60')"
  const VARIANT_90 = "(select id from service_variant where provisional_note = 'gate fixture 90')"
  const priceProbe = (statement, extraArgs = []) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      ...extraArgs,
      priceDbUrl ?? '',
      '-c',
      `begin; ${PRICE_SETUP} ${statement}; rollback;`,
    ])
  const priceListInsert = (variant, gross, from, to, label = "'gate fixture'") =>
    'insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to) ' +
    `values (${variant}, ${gross}, ${label}, ${from}, ${to})`

  const priceProbes = [
    {
      name: 'price_list gate rejects a second row overlapping the first for one variant',
      rule: 'price_list_no_overlap',
      sql: priceListInsert(VARIANT_60, 19000, "'2027-03-15'", "'2027-04-15'"),
    },
    {
      // The inclusive upper bound. With '[)' this would be accepted and the 31st would have two prices.
      name: 'price_list gate rejects a row starting on the last day of an existing one',
      rule: 'price_list_no_overlap',
      sql: priceListInsert(VARIANT_60, 19000, "'2027-03-31'", "'2027-04-30'"),
    },
    {
      name: 'price_list gate rejects a zero price',
      rule: 'price_list_gross_positive',
      sql: priceListInsert(VARIANT_90, 0, "'2027-06-01'", 'null'),
    },
    {
      name: 'price_list gate rejects a window that ends before it starts',
      rule: 'price_list_valid_to_not_before_from',
      sql: priceListInsert(VARIANT_90, 18000, "'2027-06-30'", "'2027-06-01'"),
    },
    {
      name: 'price_list gate rejects a price list with no label',
      rule: 'price_list_label_nonempty',
      sql: priceListInsert(VARIANT_90, 18000, "'2027-06-01'", 'null', "'   '"),
    },
    {
      name: 'price_list gate rejects a provisional price that names no open question',
      rule: 'price_list_provisional_names_a_question',
      sql:
        'insert into price_list (service_variant_id, gross_price_fils, label, valid_from, valid_to, ' +
        `is_provisional) values (${VARIANT_90}, 18000, 'gate fixture', '2027-06-01', null, true)`,
    },
    {
      // A fractional price, on the path that actually refuses one. The application writes through bind
      // parameters, where the bigint input function parses the text; a quoted literal takes the same
      // path, which is why this probe is spelled '250.5' and not 250.5. See 28l for what the bare
      // numeric literal does instead.
      name: 'price_list gate rejects a fractional price on the input-function path',
      rule: 'invalid input syntax for type bigint',
      sql: priceListInsert(VARIANT_90, "'250.5'", "'2027-06-01'", 'null'),
    },
  ]

  if (!priceDbUrl) {
    check(
      'price_list constraints reject their known-bad fixtures',
      false,
      'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
    )
  } else {
    for (const { name, rule, sql: statement } of priceProbes) {
      checkRejectedBy(name, priceProbe(statement), rule)
    }

    // 28j. The first control. Without it the seven probes above are satisfied by a table nobody can
    //      write to at all, which also has no overlapping rows.
    const abutting = priceProbe(priceListInsert(VARIANT_60, 19000, "'2027-04-01'", "'2027-04-30'"))
    check(
      'price_list gate accepts a row that starts the day after the last one ended',
      !abutting.failed,
      `rejected a legitimate price change:\n${abutting.output}`,
    )

    // 28k. The second control, and the one that proves the constraint is scoped per variant. A
    //      60-minute and a 90-minute treatment change price on the same day as a matter of course.
    const otherVariant = priceProbe(
      priceListInsert(VARIANT_90, 28000, "'2027-03-15'", "'2027-04-15'"),
    )
    check(
      'price_list gate accepts the same period for a different service_variant',
      !otherVariant.failed,
      `rejected a price change on a second variant:\n${otherVariant.output}`,
    )

    // 28l. The trap, asserted rather than described. Written into the statement text, 250.5 is a
    //      NUMERIC constant and the assignment cast to bigint rounds it — silently, to 251. So the
    //      fractional probe above has to use the input-function path: a gate that probed with a bare
    //      literal would report that the rejection works while nothing was ever refused.
    const roundedLiteral = priceProbe(
      `${priceListInsert(VARIANT_90, 250.5, "'2027-06-01'", 'null')}; ` +
        "select gross_price_fils from price_list where valid_from = '2027-06-01'",
      ['-At'],
    )
    check(
      'a fractional price written as a numeric literal is rounded, not rejected',
      !roundedLiteral.failed && roundedLiteral.output.includes('251'),
      `expected 250.5 to be stored as 251:\n${roundedLiteral.output}`,
    )
  }
}

// 26n. (B-AVAIL-02) No migration may materialise availability.
//
//       The availability solver answers from the trading window, the appointments, the blocks and the
//       closures every time it is asked, and B-AVAIL-02's last acceptance line is the *negative* schema
//       assertion that keeps it that way: no slot table, no availability cache, no materialised view of
//       either. A stored copy is the attractive version — one indexed read for the booking page — and it
//       is stale from the next block, closure, shift change or walk-in, so the page offers a slot the
//       floor cannot deliver and the front desk hears about it from the customer.
//
//       Asserted BY RULE NAME against `no-precomputed-slot-table` in check-schema-conventions.mjs. A
//       bare non-zero exit would also be what a typo in the fixture produces, and the rule could then be
//       dead while this file reported PASS for ever (ADR 0003). Two controls, because the word "slot"
//       appears throughout these migrations' prose and a rule that banned the word would be unshippable.
{
  const f = 'packages/db/migrations/9999__gate_fixture_availability__.sql'
  const CONVENTIONS = ['scripts/check-schema-conventions.mjs']
  const RULE = 'no-precomputed-slot-table'

  const cases = [
    {
      name: 'conventions gate rejects a precomputed slot table',
      source: [
        '-- Known-bad fixture written by scripts/test-gates.mjs. Removed in a finally.',
        'create table availability_slot (',
        '  id         uuid        primary key,',
        '  room_id    uuid        not null,',
        '  starts_at  timestamptz not null',
        ');',
      ].join('\n'),
      rule: `${RULE}: table "availability_slot"`,
    },
    {
      // The same idea wearing a cache's clothes, which is how it usually arrives: nobody proposes a slot
      // table, they propose caching the answer.
      name: 'conventions gate rejects a materialised availability cache',
      source: 'create materialized view availability_cache as select 1 as one;',
      rule: `${RULE}: materialized view "availability_cache"`,
    },
    {
      // A plain view is the third costume. It is not stale, but it is the schema claiming to own the
      // question, and the next step is always to materialise it for speed.
      name: 'conventions gate rejects a view of bookable slots',
      source: 'create view bookable_slots as select 1 as one;',
      rule: `${RULE}: view "bookable_slots"`,
    },
  ]

  for (const { name, source, rule } of cases) {
    const result = withFixture(f, source, () => run('node', CONVENTIONS))
    checkRejectedBy(name, result, rule)
  }

  // Control 1. The migrations talk about slots constantly — 0012 explains why a maintenance block "must
  // never make a single slot unavailable" — so a rule that read comments would fire on the sentence
  // explaining why it exists.
  const prose = withFixture(
    f,
    [
      '-- A maintenance block never makes a single slot unavailable.',
      'create table gate_fixture_note (',
      '  id     uuid primary key,',
      '  reason text not null',
      ');',
      'comment on table gate_fixture_note is',
      "  'Explains why no precomputed slot table exists. A fixture, never applied to a database.';",
    ].join('\n'),
    () => run('node', CONVENTIONS),
  )
  check(
    'conventions gate allows a migration whose prose mentions slots',
    !prose.failed,
    `rejected a table named for something else entirely:\n${prose.output}`,
  )

  // Control 2. Availability has legitimate *inputs* in the schema — hours, closures, blocks, shifts —
  // and a rule that banned the stem would block the tables the solver reads from.
  const inputs = withFixture(
    f,
    ['create table gate_fixture_availability_note (', '  id uuid primary key', ');'].join('\n'),
    () => run('node', CONVENTIONS),
  )
  check(
    'conventions gate allows an availability input table that stores no answers',
    !inputs.failed,
    `rejected a table that holds inputs rather than computed slots:\n${inputs.output}`,
  )
}

// The Google token chokepoint (G-CONN-03), in the two halves it actually splits into.
//
// The refresh token is the second-most-valuable secret in this system after the clinical DEK, and the
// scope it carries has no read-only variant: the token that reads reviews also rewrites the address and
// the opening hours (docs/10 §3). So "who may hold a plaintext token" is worth a gate rather than a
// convention — and the interesting part is that ONE gate cannot express it.
//
//   - dependency-cruiser sees module-to-module edges. It can close the import path to the accessors in
//     token-store.ts, and that is all it can do: it cannot see an identifier and it cannot see the string
//     `refresh_token_ct` inside a query.
//   - So the other three rules live in scripts/check-google-token-chokepoint.mjs, which scans source.
//
// And the loophole that shaped both. A rule matching a MODULE is defeated by a re-export: exactly how
// `messaging-providers-only-inside-a-transport` came to ban the providers barrel, because
// `import { SMSALA } from '@berelax/providers'` reached SMSala while naming nothing forbidden. Here the
// barrel could not be banned — it is the package entry point the consent route legitimately imports — so
// the accessors were removed from it instead, and case (b) is what holds that shut.
{
  // (a) The dependency-cruiser half: a value import of the token accessors from a module that is not one
  //     of the five permitted to hold a plaintext token. Asserted BY RULE NAME, because a fixture
  //     rejected by some unrelated rule would leave this one free to stop matching anything.
  const result = withFixture(
    'packages/google/src/__gate_fixture__.ts',
    [
      "import { connectionBinding, openToken } from './token-store.ts'",
      'export const decrypt = openToken',
      'export const bind = connectionBinding',
    ].join('\n'),
    () =>
      run('pnpm', ['exec', 'depcruise', '--config', '.dependency-cruiser.cjs', 'packages', 'apps']),
  )
  checkRejectedBy(
    'boundaries reject a token accessor import from outside the Google token modules',
    result,
    'google-tokens-only-in-with-google',
  )
}

{
  // (a-control) The same module, importing the same file for the TYPE of the five sealed columns, must
  //             pass. `SealedToken` decrypts nothing, and connection-store, memory-store and
  //             postgres-store all move those columns without ever holding a key. Without this case the
  //             rule above is indistinguishable from "nothing may mention a token", and the only way to
  //             satisfy that reading is to move the type somewhere worse.
  const result = withFixture(
    'packages/google/src/__gate_fixture__.ts',
    [
      "import type { SealedToken } from './token-store.ts'",
      'export type Sealed = SealedToken',
    ].join('\n'),
    () =>
      run('pnpm', ['exec', 'depcruise', '--config', '.dependency-cruiser.cjs', 'packages', 'apps']),
  )
  check(
    'boundaries allow a type-only import of the sealed-column shape',
    !result.failed,
    `rejected a type-only import:\n${result.output}`,
  )
}

{
  // (b) The re-export loophole, held shut by the type system rather than by a boundary rule. The
  //     accessors are no longer exported from packages/google/src/index.ts, so reaching them through the
  //     package barrel — the move dependency-cruiser could not have seen — does not compile.
  const result = withFixture(
    'packages/google/src/__gate_fixture__.ts',
    ["import { openToken } from '@berelax/google'", 'export const leak = openToken'].join('\n'),
    () => run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json']),
  )
  checkRejectedBy(
    'tsc rejects reaching the token accessor through the @berelax/google barrel',
    result,
    "has no exported member 'openToken'",
  )
}

{
  // (c) A token column named in a query outside the store whose job is those columns. A SELECT of
  //     refresh_token_ct somewhere else is a SELECT that intends to decrypt it somewhere else.
  const result = withFixture(
    'packages/db/src/repositories/__gate_fixture__.ts',
    [
      'export const query =',
      "  'select refresh_token_ct, access_token_ct from google_connections where id = $1'",
    ].join('\n'),
    () => run('node', ['scripts/check-google-token-chokepoint.mjs']),
  )
  checkRejectedBy(
    'the chokepoint gate rejects a token column named outside the store',
    result,
    'google-token-columns-outside-the-token-modules',
  )
}

{
  // (d) An accessor identifier outside the token modules. This is the half dependency-cruiser cannot do
  //     at all — a rule matching an identifier is not something it can express — which is the whole
  //     reason a source-scanning gate exists beside the boundary rule.
  const result = withFixture(
    'apps/web/app/api/v1/__gate_fixture__.ts',
    ['export function handler(sealToken: unknown) {', '  return sealToken', '}'].join('\n'),
    () => run('node', ['scripts/check-google-token-chokepoint.mjs']),
  )
  checkRejectedBy(
    'the chokepoint gate rejects a token accessor identifier outside the token modules',
    result,
    'google-token-accessor-outside-the-token-modules',
  )
}

{
  // (e) docs/10 §4 asks for this rule by name: *a CI lint rule fails the build on any template literal
  //     containing the token variable*. A template literal is how a token reaches a log line, a URL, an
  //     error message and a job payload, and it is the one leak that is invisible in review because the
  //     interpolation reads like a variable rather than like a secret.
  const result = withFixture(
    'packages/google/src/__gate_fixture__.ts',
    [
      'export const line = (accessToken: string, refreshToken: string) =>',
      // Assembled rather than written out, because a literal `${…}` inside a plain string is
      // itself a Biome warning (noTemplateCurlyInString) — and the fixture has to reach disk as a
      // real template literal, not as an escaped one.
      `  \`refreshed with ${'$'}{refreshToken} to get ${'$'}{accessToken}\``,
    ].join('\n'),
    () => run('node', ['scripts/check-google-token-chokepoint.mjs']),
  )
  checkRejectedBy(
    'the chokepoint gate rejects a plaintext token in a template literal',
    result,
    'google-token-in-a-template-literal',
  )
}

{
  // (e-control) The same shape, interpolating a SEALED column instead. Every parameterised query in
  //             postgres-store.ts looks like this, so a rule that condemned it would condemn the correct
  //             code — and a gate that condemns the correct code is a gate somebody deletes.
  const result = withFixture(
    'packages/google/src/__gate_fixture__.ts',
    [
      "import type { SealedToken } from './token-store.ts'",
      `export const bytes = (sealed: SealedToken) => \`ct=${'$'}{sealed.ct} kid=${'$'}{sealed.kid}\``,
    ].join('\n'),
    () => run('node', ['scripts/check-google-token-chokepoint.mjs']),
  )
  check(
    'the chokepoint gate allows a sealed column interpolated into a query',
    !result.failed,
    `rejected a sealed-column interpolation:\n${result.output}`,
  )
}

// W-SYS-08 — the catalogue/CMS boundary. Four rules, each with the fixture written for it, plus the
//            controls. The boundary is the point of the unit: a CMS that owns price ends up being the
//            second place a price lives, and the second place is the one the owner forgets to change.
{
  const CMS = ['exec', 'tsx', 'scripts/check-cms-boundary.mjs']
  const FIXTURE = 'apps/web/src/collections/__gate_fixture__.ts'
  const descriptor = (slug, fields) =>
    [
      'export const GATE_FIXTURE = {',
      `  slug: '${slug}',`,
      '  fields: [',
      ...fields.map(([name, type]) => `    { name: '${name}', type: '${type}' },`),
      '  ],',
      '}',
    ].join('\n')

  {
    // The spelling it would actually arrive in. Nobody adds a field called `price`; they add `price_from`
    // because the treatment page needs a number beside the prose and the join felt like overkill.
    const result = withFixture(FIXTURE, descriptor('pages', [['price_from', 'text']]), () =>
      run('pnpm', CMS),
    )
    checkRejectedBy(
      'cms boundary gate rejects a catalogue-owned field on a CMS collection',
      result,
      '[no-catalogue-field-in-cms]',
    )
  }

  {
    // A Payload `relationship` is a foreign key. Across this line it couples the catalogue's migration
    // chain to Payload's, which are deployed separately — see packages/db/migrations/0023.
    const result = withFixture(
      FIXTURE,
      descriptor('service_narrative', [['catalogue_service_id', 'relationship']]),
      () => run('pnpm', CMS),
    )
    checkRejectedBy(
      'cms boundary gate rejects a cross-boundary reference declared as a relationship',
      result,
      '[catalogue-reference-must-be-a-plain-uuid]',
    )
  }

  {
    // A therapist has no display name until an admin sets one, and the place it is set is the employee
    // record. A second home for it is the one that reaches a public page unapproved.
    const result = withFixture(
      FIXTURE,
      descriptor('therapist_narrative', [['display_name', 'text']]),
      () => run('pnpm', CMS),
    )
    checkRejectedBy(
      'cms boundary gate rejects a name-shaped field on therapist_narrative',
      result,
      '[therapist-narrative-carries-no-name]',
    )
  }

  {
    // The control for the three above. The same file, the same shapes, spelled legitimately: a UUID
    // reference as plain text, prose, and a name-shaped field on a collection that is not about a
    // therapist. A gate that rejected this would be a gate nobody could author a collection under.
    const result = withFixture(
      FIXTURE,
      [
        descriptor('service_narrative', [
          ['catalogue_service_id', 'uuidRef'],
          ['aftercare', 'textarea'],
        ]),
        descriptor('pages', [['name', 'text']]).replace('GATE_FIXTURE', 'GATE_FIXTURE_TWO'),
      ].join('\n'),
      () => run('pnpm', CMS),
    )
    check(
      'cms boundary gate allows a legitimately declared collection',
      !result.failed,
      `rejected a legitimate declaration:\n${result.output}`,
    )
  }

  {
    // The site stylesheet inside the admin's route group. `globals.css` clears Tailwind's colour,
    // spacing, radius and font namespaces with `: initial`; Payload's admin brings its own reset and its
    // own custom properties. Whichever lands second wins, and the symptom is an admin with no spacing.
    const result = withFixture(
      'apps/web/app/(payload)/__gate_fixture__.tsx',
      "import '../globals.css'\n\nexport const GateFixture = () => null",
      () => run('pnpm', CMS),
    )
    checkRejectedBy(
      'cms boundary gate rejects the site stylesheet inside the (payload) group',
      result,
      '[payload-admin-must-not-load-the-site-stylesheet]',
    )
  }

  {
    // The same rule in the other direction, which is the one that would reach a customer: Payload's admin
    // stylesheet imported by a public page overrides the site's own reset on every route that renders it.
    const result = withFixture(
      'apps/web/app/(en)/__gate_fixture__.tsx',
      "import '@payloadcms/next/css'\n\nexport const GateFixture = () => null",
      () => run('pnpm', CMS),
    )
    checkRejectedBy(
      'cms boundary gate rejects the admin stylesheet outside the (payload) group',
      result,
      '[payload-admin-must-not-load-the-site-stylesheet]',
    )
  }

  {
    // The type-level half, mutation-tested on the shipped model rather than on a fixture file.
    //
    // `packages/cms/src/documents.ts` derives `ServiceNarrativeDocument` from this descriptor, and
    // `boundary.test.ts` pins it with `// @ts-expect-error` on `narrative.price`. Add a `price` field and
    // that directive becomes UNUSED — TS2578 — which is the only way to prove the assertion is still
    // asserting something. A `@ts-expect-error` over an expression that has stopped being an error is
    // indistinguishable from one over an expression that never was.
    const model = 'packages/cms/src/collections/service-narrative.ts'
    const anchor = "    { name: 'slug', type: 'slug', label: 'URL slug', required: true },"
    const original = readFileSync(model, 'utf8')
    let typecheck
    let gate
    try {
      const mutated = original.replace(
        anchor,
        `    { name: 'price', type: 'text', label: 'Price' },\n${anchor}`,
      )
      if (mutated === original) throw new Error(`the anchor line is no longer in ${model}`)
      writeFileSync(model, mutated)
      typecheck = run('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json'])
      gate = run('pnpm', CMS)
    } finally {
      writeFileSync(model, original)
    }
    check(
      'a price field in the content model leaves the boundary @ts-expect-error unused (TS2578)',
      typecheck.failed && typecheck.output.includes('TS2578'),
      typecheck.output,
    )
    checkRejectedBy(
      'cms boundary gate rejects a price field added to the shipped content model',
      gate,
      '[no-catalogue-field-in-cms]',
    )
  }
}

// 27a-27b. The accessibility gate, on a document that breaks two rules, asserted **by rule id**.
//
//      This is the case that says `pnpm a11y` examined a rendered accessibility tree rather than a
//      file. A count would not: any change to the page moves a count, and a gate whose evidence is a
//      number reports PASS the day its rule stops matching. `button-name` and `color-contrast` are the
//      two rule ids, and the fixture contains exactly one defect for each.
//
//      The colours are the token values written out, because a fixture page carries no stylesheet:
//      `#C08A43` is `--color-decor-gold` and `#FDFAF5` is `--color-ground`. That pair measures 2.90:1,
//      which is the ratio `decor-gold-never-carries-text` in `pnpm colours` exists to prevent and the
//      reason the darkened `--color-accent-gold` (4.62:1) is what text uses. Writing them here rather
//      than in a `.ts` or `.css` file under packages/ or apps/ is also what keeps `pnpm colours` out of
//      this: its exemption list is by single file path, and a fixture that lives in `scripts/` for the
//      length of one gate run needs no entry in it.
{
  const result = withFixture(
    'scripts/__gate_fixture__.html',
    [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><title>fixture</title></head>',
      '<body style="background:#FDFAF5"><main>',
      // An icon and nothing else: no text, no aria-label, no title. A screen reader announces "button".
      '<button type="button" style="width:48px;height:48px">',
      '<svg width="20" height="20" aria-hidden="true" focusable="false"></svg>',
      '</button>',
      '<p style="color:#C08A43;background:#FDFAF5;font-size:17px">',
      'Body copy on the decorative gold, which measures 2.90:1 against the ground.',
      '</p>',
      '</main></body></html>',
    ].join('\n'),
    () =>
      run('pnpm', ['exec', 'tsx', 'scripts/accessibility.mjs', 'scripts/__gate_fixture__.html']),
  )
  checkRejectedBy('a11y gate rejects a button with no accessible name', result, '[button-name]')
  checkRejectedBy('a11y gate rejects body text at 2.90:1', result, '[color-contrast]')
}

// 27c. The control for 27a-27b. The same two elements, labelled and on the ink colour, must pass — a
//      gate that fails every document is not measuring anything, and this is the render that says the
//      two rejections above came from the defects rather than from the harness.
{
  const result = withFixture(
    'scripts/__gate_fixture__.html',
    [
      '<!doctype html>',
      '<html lang="en"><head><meta charset="utf-8"><title>fixture</title></head>',
      '<body style="background:#FDFAF5"><main>',
      '<button type="button" aria-label="Search treatments" style="width:48px;height:48px">',
      '<svg width="20" height="20" aria-hidden="true" focusable="false"></svg>',
      '</button>',
      // #26241F is --color-ink: 13.7:1 on the ground, which is what body copy actually uses.
      '<p style="color:#26241F;background:#FDFAF5;font-size:17px">Body copy on the ink colour.</p>',
      '</main></body></html>',
    ].join('\n'),
    () =>
      run('pnpm', ['exec', 'tsx', 'scripts/accessibility.mjs', 'scripts/__gate_fixture__.html']),
  )
  check(
    'a11y gate allows a labelled button and body copy on the ink colour',
    !result.failed,
    `rejected a compliant document:\n${result.output}`,
  )
}

// 27d. Lucide imported anywhere but the icon wrapper. docs/08 §7 asks for one wrapped `<Icon>` at
//      strokeWidth 1.5, 20px UI / 24px nav; a direct import gets Lucide's defaults instead — stroke 2
//      at 24px — and nothing about that looks wrong in a diff.
{
  const result = withFixture(
    'packages/ui/src/primitives/__gate_fixture__.tsx',
    ["import { X } from 'lucide-react'", 'export const glyph = X'].join('\n'),
    () =>
      run('pnpm', ['exec', 'depcruise', '--config', '.dependency-cruiser.cjs', 'packages', 'apps']),
  )
  checkRejectedBy(
    'boundary gate rejects a Lucide import outside packages/ui/src/icon.tsx',
    result,
    'no-lucide-outside-the-icon-wrapper',
  )
}

// 27e. The control for 27d, and it is not a formality: the rule was configured, green and **dead** when
//      it was written, because `options.exclude` matched `(^|/)(dist|\.next|\.claude)/` and every
//      installed package ships from `dist/` — so the dependency was dropped before any rule saw it. The
//      fixture above reported nothing at all. Reaching the same glyph through the wrapper has to pass,
//      or the rule bans the one legitimate path to an icon.
{
  const result = withFixture(
    'packages/ui/src/primitives/__gate_fixture__.tsx',
    ["import { Icon } from '../icon.tsx'", 'export const glyph = Icon'].join('\n'),
    () =>
      run('pnpm', ['exec', 'depcruise', '--config', '.dependency-cruiser.cjs', 'packages', 'apps']),
  )
  check(
    'boundary gate allows an icon reached through the wrapper',
    !result.failed,
    `rejected the wrapper itself:\n${result.output}`,
  )
}

// 26p. (B-AVAIL-01) The booking and appointment concurrency constraints, as known-bad fixtures
//      against real PostgreSQL.
//
// These rules are database rules — an exclusion constraint, three CHECKs, a foreign key and two
// triggers that raise — and a constraint is only a gate once something has been seen to bounce off
// it. Each probe below is a statement the database must refuse **by the name of the rule written for
// it**: a bare non-zero exit is also what a typo in a column name produces, and the rule under test
// would then be dead while this file reported PASS for ever (ADR 0003).
//
// Every probe runs inside `begin; … ; rollback;`, so a probe that is wrongly *accepted* leaves
// nothing behind either. The room-capacity probes need `set constraints all immediate` to make the
// deferred trigger fire without committing — which is also, incidentally, a second proof that the
// trigger really is deferred: an immediate one would have raised at the INSERT before that statement
// was reached.
{
  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  const MARKER = 'gate fixture'
  const TWIN = 'gate-fixture-twin'
  const DATE = "'2099-04-01'"
  const BOOKING = "'40000000-0000-4000-8000-000000000004'"
  const CUSTOMER = "(select id from customer where phone_e164 = '+971500000199')"
  const VARIANT =
    '(select v.id from service_variant v join service s on s.id = v.service_id ' +
    "where s.style = 'asian' and s.treatment_key = 'normal_massage' limit 1)"
  const COUPLES = "(select id from rooms where code = 'room-couples')"
  const TWIN_ROOM = `(select id from rooms where code = '${TWIN}')`
  const THERAPIST = (suffix) => `'40000000-0000-4000-8000-0000000000${suffix}'::uuid`
  const slot = (from, to, bounds = '[)') =>
    `tstzrange('2099-04-01 ${from}:00:00+00','2099-04-01 ${to}:00:00+00','${bounds}')`

  // Fixtures the probes hang off, created inside the same rolled-back transaction. A capacity-2
  // room of type `standard`, because 0012's `rooms_couples_holds_two` refuses any couples room below
  // capacity 2 — testing the reduction against the seeded couples room would be rejected by that
  // rule instead, and `capacity_below_committed` could have been dead for ever.
  const setup = [
    `insert into customer (phone_e164, created_via) values ('+971500000199', 'guest_booking')
       on conflict (phone_e164) do nothing`,
    `insert into business_day (trading_date, opens_at, closes_at, source)
       values (${DATE}, '2099-04-01 07:00:00+00', '2099-04-01 22:00:00+00', 'weekly')
       on conflict (trading_date) do nothing`,
    `insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
       select s.id, 45, 17000, '${MARKER}' from service s
        where s.style = 'asian' and s.treatment_key = 'normal_massage'
       on conflict (service_id, duration_minutes) do nothing`,
    `insert into rooms (code, name, room_type, capacity, display_order, notes)
       values ('${TWIN}', 'Gate twin', 'standard', 2, 91, '${MARKER}')
       on conflict (code) do nothing`,
    `insert into booking (id, customer_id, source, notes)
       values (${BOOKING}, ${CUSTOMER}, 'front_desk', '${MARKER}')`,
  ].join('; ')

  const appointment = ({ room, therapist, period, status = 'confirmed', price = 20000 }) =>
    'insert into appointment (booking_id, trading_date, service_variant_id, shape, therapist_id, ' +
    `room_id, period, status, gross_price_fils) values (${BOOKING}, ${DATE}, ${VARIANT}, 'solo', ` +
    `${therapist}, ${room}, ${period}, '${status}', ${price})`

  const psqlProbe = (statement) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      dbUrl ?? '',
      '-c',
      `begin; ${setup}; ${statement}; rollback;`,
    ])

  // Written as data so the rule name sits next to the statement that must trip it. Anything added
  // here states its own rule, which is the only form of this test that cannot drift into "something
  // failed".
  const probes = [
    {
      name: 'booking gate rejects two overlapping appointments for one therapist',
      rule: 'appointment_therapist_no_overlap',
      // Two different rooms on purpose: the therapist is the constraint, not the room.
      sql: [
        appointment({ room: COUPLES, therapist: THERAPIST('01'), period: slot('19', '20') }),
        appointment({ room: TWIN_ROOM, therapist: THERAPIST('01'), period: slot('19', '20') }),
      ].join('; '),
    },
    {
      name: 'booking gate rejects an inclusive upper bound on a period',
      rule: 'appointment_period_half_open',
      sql: appointment({
        room: TWIN_ROOM,
        therapist: THERAPIST('01'),
        period: slot('19', '20', '[]'),
      }),
    },
    {
      name: 'booking gate rejects an empty period, which upper > lower cannot catch',
      rule: 'appointment_period_bounded',
      // An empty range has null bounds, so `upper(period) > lower(period)` is NULL and passes. This
      // is the probe that proves the two constraints are not one redundant pair.
      sql: appointment({
        room: TWIN_ROOM,
        therapist: THERAPIST('01'),
        period: slot('19', '19'),
      }),
    },
    {
      name: 'booking gate rejects a zero snapshotted price',
      rule: 'appointment_price_positive',
      sql: appointment({
        room: TWIN_ROOM,
        therapist: THERAPIST('01'),
        period: slot('19', '20'),
        price: 0,
      }),
    },
    {
      name: 'booking gate rejects an appointment on a date the premises does not trade',
      rule: 'appointment_trading_date_fkey',
      sql: appointment({
        room: TWIN_ROOM,
        therapist: THERAPIST('01'),
        period: slot('19', '20'),
      }).replace(`${DATE},`, "'2099-12-25',"),
    },
    {
      name: 'booking gate rejects a third overlapping appointment in the capacity-2 couples room',
      rule: 'room_over_capacity',
      sql: [
        appointment({ room: COUPLES, therapist: THERAPIST('01'), period: slot('19', '20') }),
        appointment({ room: COUPLES, therapist: THERAPIST('02'), period: slot('19', '20') }),
        appointment({ room: COUPLES, therapist: THERAPIST('03'), period: slot('19', '20') }),
        'set constraints all immediate',
      ].join('; '),
    },
    {
      name: 'booking gate rejects reducing rooms.capacity below overlapping commitments',
      rule: 'capacity_below_committed',
      sql: [
        appointment({ room: TWIN_ROOM, therapist: THERAPIST('01'), period: slot('19', '20') }),
        appointment({ room: TWIN_ROOM, therapist: THERAPIST('02'), period: slot('19', '20') }),
        `update rooms set capacity = 1 where code = '${TWIN}'`,
      ].join('; '),
    },
    {
      name: 'booking gate rejects a status-history row that transitions to the same status',
      rule: 'appointment_status_history_is_a_change',
      sql:
        'insert into appointment_status_history (appointment_id, from_status, to_status) values ' +
        `(${THERAPIST('09')}, 'confirmed', 'confirmed')`,
    },
    {
      name: 'booking gate rejects an UPDATE of appointment_status_history, for the owner too',
      rule: 'appointment_status_history is append-only',
      sql: [
        appointment({ room: TWIN_ROOM, therapist: THERAPIST('01'), period: slot('19', '20') }),
        "update appointment_status_history set to_status = 'completed' " +
          `where appointment_id in (select id from appointment where booking_id = ${BOOKING})`,
      ].join('; '),
    },
  ]

  try {
    if (!dbUrl) {
      check(
        'booking constraints reject their known-bad fixtures',
        false,
        'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
      )
    } else {
      for (const { name, rule, sql: statement } of probes) {
        checkRejectedBy(name, psqlProbe(statement), rule)
      }

      // The controls, and the reason the nine above mean anything: the same tables accept the
      // legitimate row. Without these, a broken connection string or a renamed table would reject
      // every probe and this gate would report nine passes while examining nothing.
      const abutting = psqlProbe(
        [
          appointment({ room: TWIN_ROOM, therapist: THERAPIST('01'), period: slot('19', '20') }),
          appointment({ room: TWIN_ROOM, therapist: THERAPIST('01'), period: slot('20', '21') }),
        ].join('; '),
      )
      check(
        'booking gate accepts two appointments abutting at a boundary for one therapist',
        !abutting.failed,
        `rejected a legitimate abutting pair — the half-open bound is not working:\n${abutting.output}`,
      )

      // Two rows in the capacity-2 couples room, with the deferred check forced to run. This is the
      // couples booking the whole unit exists to allow.
      const couplesPair = psqlProbe(
        [
          appointment({ room: COUPLES, therapist: THERAPIST('01'), period: slot('19', '20') }),
          appointment({ room: COUPLES, therapist: THERAPIST('02'), period: slot('19', '20') }),
          'set constraints all immediate',
        ].join('; '),
      )
      check(
        'booking gate accepts the two appointments of a couples booking in the capacity-2 room',
        !couplesPair.failed,
        `rejected a legitimate couples booking:\n${couplesPair.output}`,
      )

      // The same reduction as the probe above, with the two appointments at different times of one
      // evening. A guard counting the day's total rather than the overlap would refuse this, and an
      // admin who cannot correct a room's capacity is worse off than one with no guard at all.
      const reducible = psqlProbe(
        [
          appointment({ room: TWIN_ROOM, therapist: THERAPIST('01'), period: slot('19', '20') }),
          appointment({ room: TWIN_ROOM, therapist: THERAPIST('02'), period: slot('21', '22') }),
          `update rooms set capacity = 1 where code = '${TWIN}'`,
        ].join('; '),
      )
      check(
        'booking gate allows a capacity reduction when the appointments do not overlap',
        !reducible.failed,
        `refused a legitimate capacity reduction:\n${reducible.output}`,
      )

      // A cancelled appointment releases its therapist and its room, which is the correction the
      // front desk makes most often. Without the partial predicate on the exclusion constraint this
      // is the statement that would be refused.
      const rebooked = psqlProbe(
        [
          appointment({ room: COUPLES, therapist: THERAPIST('01'), period: slot('19', '20') }),
          "update appointment set status = 'cancelled_by_customer' " +
            `where booking_id = ${BOOKING}`,
          appointment({ room: COUPLES, therapist: THERAPIST('01'), period: slot('19', '20') }),
          'set constraints all immediate',
        ].join('; '),
      )
      check(
        'booking gate accepts re-booking the period a cancellation freed',
        !rebooked.failed,
        `refused a re-booking of a cancelled slot:\n${rebooked.output}`,
      )
    }
  } finally {
    if (dbUrl) {
      // Every probe above rolls back, so this sweeps nothing in the ordinary case. It is here for
      // the case a probe is wrongly ACCEPTED and its transaction is still rolled back by psql — and
      // because a fixture left in the booking tables would fail every later gate with an error about
      // the wrong thing. appointment_status_history is deliberately absent: it refuses a DELETE from
      // every role including the owner, and no probe commits a row into it.
      run('psql', [
        '--no-psqlrc',
        '-q',
        dbUrl,
        '-c',
        `delete from booking_idempotency where booking_id = ${BOOKING}; ` +
          `delete from appointment where booking_id = ${BOOKING}; ` +
          `delete from booking where notes = '${MARKER}'; ` +
          `delete from rooms where code = '${TWIN}'; ` +
          `delete from service_variant where provisional_note = '${MARKER}'; ` +
          `delete from business_day where trading_date = ${DATE}; ` +
          "delete from customer where phone_e164 = '+971500000199';",
      ])
    }
  }
}

// 26n. (M-TILL-04) The invoice document's constraints, as known-bad fixtures against real PostgreSQL.
//
// Every rule this unit adds is a database rule: four CHECKs on the issuer snapshot, two that reconcile
// amounts, a composite foreign key, two UNIQUEs, a pair of refusal triggers and a DEFERRED constraint
// trigger. A constraint is only a gate once something has been seen to bounce off it, so each probe
// below states the rule it must trip and `checkRejectedBy` fails if the rejection came from anything
// else — a bare non-zero exit is also what a typo in a column name produces (ADR 0003).
//
// `VERBOSITY=verbose` so the SQLSTATE and the constraint name are both in psql's output: the CHECKs are
// asserted by constraint name, and the two trigger rules by their own codes, ZI001 and ZI003.
//
// Every probe runs inside `begin; … ; rollback;`, which is also the only way the append-only cases can
// be written at all: `invoice` refuses DELETE for every role including the owner, so a fixture row that
// committed could not be swept afterwards. The `finally` sweeps by marker anyway, with the two DELETE
// triggers disabled inside its own transaction and re-enabled before it commits — because "it rolled
// back" and "we checked" are different facts.
{
  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  const MARKER = 'GATE-INVOICE'
  // Fifteen digits. A gate value: the real TRN is unknown (Y1-trn) and the seeded placeholder is the
  // subject of the first probe below.
  const GATE_TRN = '100123456700003'

  const psqlProbe = (statements) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-v',
      'VERBOSITY=verbose',
      '-q',
      dbUrl ?? '',
      '-c',
      `begin; ${statements}; rollback;`,
    ])

  /** The header insert, with any field overridden. The defaults are a document that is accepted. */
  const header = (overrides = {}) => {
    const v = {
      kind: "'tax_invoice'",
      series: "'TAX-INV'",
      period: "'GATE'",
      number: '900001',
      display: `'${MARKER}-0001'`,
      legalName: "'BE RELAX SPA - L.L.C - O.P.C'",
      tradingName: "'BE RELAX - Massage Center and Spa'",
      trn: `'${GATE_TRN}'`,
      address: "'250 Al Meena Street'",
      emirate: "'Abu Dhabi'",
      customer: "'Customer 0042'",
      issue: "'2026-09-19'",
      taxPoint: "'2026-09-18'",
      net: '20',
      vat: '2',
      gross: '22',
      ...overrides,
    }
    return (
      'insert into invoice (document_kind, series_code, period_key, number, display_number, ' +
      'issuer_legal_name, issuer_trading_name, issuer_trn, issuer_address_snapshot, issuer_emirate, ' +
      'customer_name_snapshot, issue_date, tax_point_date, net_total, vat_total, gross_total) values (' +
      `${v.kind}, ${v.series}, ${v.period}, ${v.number}, ${v.display}, ${v.legalName}, ` +
      `${v.tradingName}, ${v.trn}, ${v.address}, ${v.emirate}, ${v.customer}, ${v.issue}::date, ` +
      `${v.taxPoint}::date, ${v.net}, ${v.vat}, ${v.gross})`
    )
  }

  /** Two lines at 11 fils gross: net 10 and VAT 1 each, so the document's VAT is 2. */
  const twoLines = (lineVat = '1', lineNet = '10') =>
    'insert into invoice_line (invoice_id, line_no, description_en, quantity, unit_gross_fils, ' +
    `vat_rate_bp, line_net_fils, line_vat_fils) select id, n, 'Rounding probe', 1, 11, 500, ` +
    `${lineNet}, ${lineVat} from invoice, generate_series(1, 2) as n ` +
    `where display_number = '${MARKER}-0001'`

  const probes = [
    {
      name: 'invoice gate rejects the seeded Y1-trn placeholder as the issuer TRN',
      rule: 'invoice_issuer_trn_is_fifteen_digits',
      sql: header({ trn: "'TRN-PENDING-Y1-TRN'" }),
    },
    {
      name: 'invoice gate rejects a placeholder issuer legal name',
      rule: 'invoice_issuer_name_not_placeholder',
      sql: header({ legalName: "'[CONFIRM]'" }),
    },
    {
      name: 'invoice gate rejects a placeholder issuer address',
      rule: 'invoice_issuer_address_not_placeholder',
      sql: header({ address: "'Address TBC'" }),
    },
    {
      // NOT NULL rather than the CHECK, asserted by the column the message names. The CHECK refuses a
      // NULL too, and only because is_placeholder_text() is deliberately not STRICT: a strict function
      // returns NULL for NULL, and a CHECK whose expression is NULL passes.
      name: 'invoice gate rejects a NULL issuer TRN, naming the column',
      rule: 'null value in column "issuer_trn"',
      sql: header({ trn: 'null' }),
    },
    {
      name: 'invoice gate rejects a header whose net and VAT do not add up to its gross',
      rule: 'invoice_totals_reconcile',
      sql: header({ net: '21' }),
    },
    {
      name: 'invoice gate rejects a line whose net and VAT do not add up to its gross',
      rule: 'invoice_line_totals_reconcile',
      sql: `${header()}; ${twoLines('2')}`,
    },
    {
      name: 'invoice gate rejects a tax point after the date of issue',
      rule: 'invoice_tax_point_not_after_issue',
      sql: header({ issue: "'2026-09-18'", taxPoint: "'2026-09-19'" }),
    },
    {
      // The composite foreign key to document_series (code, document_kind). Without it a tax invoice
      // could be numbered out of the credit-note range, and the range a VAT return reads would hold
      // two kinds of document.
      name: 'invoice gate rejects a tax invoice numbered out of the credit-note series',
      rule: 'invoice_series_kind_fk',
      sql: header({ series: "'CR-NOTE'" }),
    },
    {
      name: 'invoice gate rejects a duplicate display number',
      rule: 'invoice_display_number_unique',
      sql: `${header()}; ${header({ number: '900002' })}`,
    },
    {
      name: 'invoice gate rejects the same number twice in one series period',
      rule: 'invoice_series_period_number_unique',
      sql: `${header()}; ${header({ display: `'${MARKER}-0002'` })}`,
    },
    {
      // THE central rule. The header states 1 — what splitting the 22-fils document total gives — while
      // its two lines sum to 2. Both inserts succeed; `set constraints all immediate` forces the
      // deferred trigger to run without committing, which is also what leaves nothing behind.
      name: 'invoice gate rejects VAT re-derived from the document total, at COMMIT',
      rule: 'ZI001',
      sql: `${header({ net: '21', vat: '1' })}; ${twoLines()}; set constraints all immediate`,
    },
    {
      name: 'invoice gate rejects a document committed with no lines',
      rule: 'ZI002',
      sql: `${header({ net: '0', vat: '0', gross: '0' })}; set constraints all immediate`,
    },
    {
      name: 'invoice gate rejects an UPDATE of an issued invoice',
      rule: 'ZI003',
      sql:
        `${header()}; ${twoLines()}; ` +
        `update invoice set notes = 'corrected' where display_number = '${MARKER}-0001'`,
    },
    {
      name: 'invoice gate rejects a DELETE of an issued invoice',
      rule: 'ZI003',
      sql: `${header()}; ${twoLines()}; delete from invoice where display_number = '${MARKER}-0001'`,
    },
    {
      name: 'invoice gate rejects an UPDATE of an issued invoice line',
      rule: 'ZI003',
      sql: `${header()}; ${twoLines()}; update invoice_line set line_vat_fils = 0 where line_no = 1`,
    },
  ]

  try {
    if (!dbUrl) {
      check(
        'invoice constraints reject their known-bad fixtures',
        false,
        'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
      )
    } else {
      for (const { name, rule, sql: statements } of probes) {
        checkRejectedBy(name, psqlProbe(statements), rule)
      }

      // The control, and the reason the fifteen probes above mean anything: the correct document is
      // ACCEPTED, including by the deferred trigger. Without it, a broken connection string or a
      // renamed column would reject every probe and this gate would report fifteen passes while
      // examining nothing.
      const accepted = psqlProbe(`${header()}; ${twoLines()}; set constraints all immediate`)
      check(
        'invoice gate accepts two lines at 11 fils with a document VAT of 2',
        !accepted.failed,
        `rejected the document this unit exists to store:\n${accepted.output}`,
      )

      // The second control: the accepted document and the ZI001 one differ in the document VAT and in
      // nothing else, so that probe is about the re-derivation rather than about anything else in the
      // statement.
      const reDerived = psqlProbe(
        `${header({ net: '21', vat: '1' })}; ${twoLines()}; set constraints all immediate`,
      )
      check(
        'the accepted and rejected documents differ only in the document VAT',
        reDerived.failed && !accepted.failed,
        'both probes must not have the same outcome, or the rule under test is not what is tripping',
      )
    }
  } finally {
    if (dbUrl) {
      // `invoice` refuses DELETE for every role, so the sweep disables the two DELETE triggers and
      // re-enables them before committing. Scoped to the marker, and a no-op when every probe rolled
      // back as intended — which is the point of running it.
      run('psql', [
        '--no-psqlrc',
        '-q',
        dbUrl,
        '-c',
        'begin; ' +
          'alter table invoice disable trigger invoice_no_delete; ' +
          'alter table invoice_line disable trigger invoice_line_no_delete; ' +
          'delete from invoice_line where invoice_id in ' +
          `(select id from invoice where display_number like '${MARKER}-%'); ` +
          `delete from invoice where display_number like '${MARKER}-%'; ` +
          'alter table invoice enable trigger invoice_no_delete; ' +
          'alter table invoice_line enable trigger invoice_line_no_delete; ' +
          'commit;',
      ])
    }
  }
}

// 26q. (B-AVAIL-03) The resource shapes the database will actually accept.
//
// `assign-shape.ts` chooses the `(therapists[], room)` tuple, and the only useful definition of a
// correct choice is one the booking transaction can commit. Two rules of
// `0024_appointment_constraints.sql` decide that, and both are counted in **appointment rows** because
// that is what the table stores — one row per therapist:
//
//   - `appointment_room_capacity`, the deferred trigger, counts the rows holding a room at the busiest
//     instant of the written row's own period and refuses a peak above `rooms.capacity`. A Four Hands
//     is ONE client and TWO rows, so it needs TWO places in the room whatever `min_room_capacity` says.
//     That is why `roomPlacesRequired` is `max(minRoomCapacity, therapistsRequired)` and not the client
//     count, and the first probe below is the failure a client-count implementation ships:
//     `room_over_capacity`, raised at COMMIT, after the customer has been told yes.
//   - `appointment_therapist_no_overlap` refuses one therapist twice over one period, so the "pair" of
//     a two-therapist shape has to be two different people. `assignShape` de-duplicates its pool for
//     this reason, and the second probe is what happens when it does not.
//
// Each probe names the rule that must reject it: a bare non-zero exit is also what a typo in a column
// name produces, and the rule under test would then be dead while this file reported PASS for ever
// (ADR 0003). Both controls matter. Without the first, the capacity probe is satisfied by a database
// that refuses two rows per booking outright — which would make Couple Massage unbookable too. Without
// the second, it is satisfied by a database that refuses everything in a capacity-1 room, and Morocco
// Bath lives in one.
//
// Every probe runs inside `begin; … ; rollback;` and creates its own rooms, so none of it depends on
// the provisional inventory 0012 seeded and B-CAT-06 will replace.
{
  const shapeDbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  const SHAPE_MARKER = 'gate fixture shape'
  const SINGLE = 'gate-fixture-shape-single'
  const TWIN2 = 'gate-fixture-shape-twin'
  const WET_ROOM = 'gate-fixture-shape-wet'
  const SHAPE_DATE = "'2099-04-02'"
  const SHAPE_BOOKING = "'40000000-0000-4000-8000-000000000005'"
  const SHAPE_CUSTOMER = "(select id from customer where phone_e164 = '+971500000197')"
  const SHAPE_VARIANT =
    '(select v.id from service_variant v join service s on s.id = v.service_id ' +
    "where s.style = 'asian' and s.treatment_key = 'normal_massage' limit 1)"
  const roomRef = (code) => `(select id from rooms where code = '${code}')`
  const SHAPE_THERAPIST = (suffix) => `'40000000-0000-4000-8000-0000000000${suffix}'::uuid`
  const shapeSlot = (from, to) =>
    `tstzrange('2099-04-02 ${from}:00:00+00','2099-04-02 ${to}:00:00+00','[)')`

  // Three rooms of this unit's own: the capacity-1 standard room the seeded inventory is made of, a
  // capacity-2 standard room (capacity is data, so an owner can have one), and a capacity-1 wet room.
  const shapeSetup = [
    `insert into customer (phone_e164, created_via) values ('+971500000197', 'guest_booking')
       on conflict (phone_e164) do nothing`,
    `insert into business_day (trading_date, opens_at, closes_at, source)
       values (${SHAPE_DATE}, '2099-04-02 07:00:00+00', '2099-04-02 22:00:00+00', 'weekly')
       on conflict (trading_date) do nothing`,
    `insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
       select s.id, 60, 20000, '${SHAPE_MARKER}' from service s
        where s.style = 'asian' and s.treatment_key = 'normal_massage'
       on conflict (service_id, duration_minutes) do nothing`,
    `insert into rooms (code, name, room_type, capacity, display_order, notes) values
       ('${SINGLE}',   'Gate single', 'standard', 1, 92, '${SHAPE_MARKER}'),
       ('${TWIN2}',    'Gate twin 2', 'standard', 2, 93, '${SHAPE_MARKER}'),
       ('${WET_ROOM}', 'Gate wet',    'wet',      1, 94, '${SHAPE_MARKER}')
       on conflict (code) do nothing`,
    `insert into booking (id, customer_id, source, notes)
       values (${SHAPE_BOOKING}, ${SHAPE_CUSTOMER}, 'front_desk', '${SHAPE_MARKER}')`,
  ].join('; ')

  const shapeAppointment = ({ room, therapist, shape, period }) =>
    'insert into appointment (booking_id, trading_date, service_variant_id, shape, therapist_id, ' +
    `room_id, period, status, gross_price_fils) values (${SHAPE_BOOKING}, ${SHAPE_DATE}, ` +
    `${SHAPE_VARIANT}, '${shape}', ${therapist}, ${room}, ${period}, 'confirmed', 20000)`

  const shapeProbe = (statement) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      shapeDbUrl ?? '',
      '-c',
      `begin; ${shapeSetup}; ${statement}; rollback;`,
    ])

  // The two therapists of one Four Hands, in one room, over one period — the tuple `assignShape`
  // produces, written out as the two rows B-AVAIL-06 will insert.
  const fourHandsRows = (room) => [
    shapeAppointment({
      room,
      therapist: SHAPE_THERAPIST('b1'),
      shape: 'four_hands',
      period: shapeSlot('19', '20'),
    }),
    shapeAppointment({
      room,
      therapist: SHAPE_THERAPIST('b2'),
      shape: 'four_hands',
      period: shapeSlot('19', '20'),
    }),
  ]

  if (!shapeDbUrl) {
    check(
      'resource-shape assignment is feasible against its constraints',
      false,
      'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
    )
  } else {
    // Probe 1. The reason `roomPlacesRequired` counts rows rather than clients.
    checkRejectedBy(
      'shape gate rejects a Four Hands in a capacity-1 room, which its client count permits',
      shapeProbe([...fourHandsRows(roomRef(SINGLE)), 'set constraints all immediate'].join('; ')),
      'room_over_capacity',
    )

    // Probe 2. The reason `assignShape` de-duplicates the pool instead of trusting it.
    checkRejectedBy(
      'shape gate rejects a two-therapist shape that is one therapist listed twice',
      shapeProbe(
        [
          shapeAppointment({
            room: roomRef(TWIN2),
            therapist: SHAPE_THERAPIST('b1'),
            shape: 'four_hands',
            period: shapeSlot('19', '20'),
          }),
          shapeAppointment({
            room: roomRef(TWIN2),
            therapist: SHAPE_THERAPIST('b1'),
            shape: 'four_hands',
            period: shapeSlot('19', '20'),
          }),
        ].join('; '),
      ),
      'appointment_therapist_no_overlap',
    )

    // Control 1. The same two rows in a capacity-2 room commit, so probe 1 is about the one missing
    // place and not about two rows per booking, the `four_hands` value or the room's type.
    const twoPlaces = shapeProbe(
      [...fourHandsRows(roomRef(TWIN2)), 'set constraints all immediate'].join('; '),
    )
    check(
      'shape gate accepts the same Four Hands in a room with two places',
      !twoPlaces.failed,
      `refused a Four Hands the room had room for:\n${twoPlaces.output}`,
    )

    // Control 2. Morocco Bath is one therapist in the single capacity-1 wet room, and it has to remain
    // bookable — otherwise probe 1 is satisfied by a rule that refuses every capacity-1 room.
    const moroccoBath = shapeProbe(
      [
        shapeAppointment({
          room: roomRef(WET_ROOM),
          therapist: SHAPE_THERAPIST('b1'),
          shape: 'solo',
          period: shapeSlot('19', '20'),
        }),
        'set constraints all immediate',
      ].join('; '),
    )
    check(
      'shape gate accepts a Morocco Bath alone in the capacity-1 wet room',
      !moroccoBath.failed,
      `refused the one shape a capacity-1 room exists for:\n${moroccoBath.output}`,
    )

    // Every probe above rolls back, so this sweeps nothing in the ordinary case. It is here for the
    // case a probe is wrongly accepted, and because a room or a booking left behind fails a later gate
    // with an error about something else entirely.
    run('psql', [
      '--no-psqlrc',
      '-q',
      shapeDbUrl,
      '-c',
      `delete from appointment where booking_id = ${SHAPE_BOOKING}; ` +
        `delete from booking where notes = '${SHAPE_MARKER}'; ` +
        `delete from rooms where notes = '${SHAPE_MARKER}'; ` +
        `delete from service_variant where provisional_note = '${SHAPE_MARKER}'; ` +
        `delete from business_day where trading_date = ${SHAPE_DATE}; ` +
        "delete from customer where phone_e164 = '+971500000197';",
    ])
  }
}

// 30a-30e. (W-SITE-01) The route registry is in exact bijection with the filesystem.
//
// The registry drives the sitemap, the hreflang set, the robots policy and the screenshot matrix, and
// none of those notices a route that is missing from it: a page absent from the sitemap is not a build
// error, a page with no hreflang is not a build error, and a page nobody screenshots is not a build
// error. `apps/web/src/routes/registry.test.ts` is what turns all four into one, so it is the check that
// has to have been seen to fail — in both directions and in both locales, because the Arabic tree is a
// second root layout under a second route group and a scanner that quietly stopped at `(en)` would
// report a clean bijection over half the site.
//
// Every fixture here is a file in the real `app/` directory, removed in a `finally`. The directories are
// made and removed with the `run` helper rather than with `node:fs` imports, so the whole case is
// contiguous and nothing above it changes.
{
  const registrySuite = [
    'exec',
    'vitest',
    'run',
    '-c',
    'vitest.config.ts',
    'apps/web/src/routes/registry.test.ts',
  ]
  const fixturePage = [
    '/** A deliberately unregistered route. scripts/test-gates.mjs writes and removes this. */',
    'export default function GateFixturePage() {',
    '  return null',
    '}',
    '',
  ].join('\n')

  // 30a. An English page with no registry entry.
  {
    const dir = 'apps/web/app/(en)/(public)/gate-fixture-route'
    run('mkdir', ['-p', dir])
    try {
      const result = withFixture(`${dir}/page.tsx`, fixturePage, () => run('pnpm', registrySuite))
      checkRejectedBy(
        'route registry gate rejects an English route with no registry entry',
        result,
        'route-without-registry-entry',
      )
    } finally {
      run('rm', ['-rf', dir])
    }
  }

  // 30b. The same in the Arabic tree, which is a different route group and a different root layout.
  {
    const dir = 'apps/web/app/(ar)/ar/gate-fixture-route'
    run('mkdir', ['-p', dir])
    try {
      const result = withFixture(`${dir}/page.tsx`, fixturePage, () => run('pnpm', registrySuite))
      checkRejectedBy(
        'route registry gate rejects an Arabic route with no registry entry',
        result,
        'route-without-registry-entry',
      )
    } finally {
      run('rm', ['-rf', dir])
    }
  }

  // 30c. Two files resolving to one URL. A route group contributes nothing to the path, so
  // `app/(ar)/page.tsx` and `app/(en)/(public)/page.tsx` are both `/` — which the bijection cannot see,
  // because a set does not count duplicates, and which Next reports only after a minute of compiling.
  {
    const result = withFixture('apps/web/app/(ar)/page.tsx', fixturePage, () =>
      run('pnpm', registrySuite),
    )
    checkRejectedBy(
      'route registry gate rejects two files resolving to one URL',
      result,
      'route-declared-twice',
    )
  }

  // 30d. The other direction: an entry in the registry whose route file is gone. The file is parked
  // beside itself and moved back in the `finally` — a registry that claims a route the site does not
  // serve puts a URL in the sitemap that answers 404, which is the failure nobody sees until Search
  // Console reports it.
  {
    const route = 'apps/web/app/(ar)/ar/kitchen-sink/page.tsx'
    const parked = `${route}.gate-fixture-parked`
    run('mv', [route, parked])
    let result
    try {
      result = run('pnpm', registrySuite)
    } finally {
      run('mv', [parked, route])
    }
    checkRejectedBy(
      'route registry gate rejects a registry entry whose route file is gone',
      result,
      'registry-entry-without-route',
    )
  }

  // 30e. The control for all four, and the proof that every fixture above was cleaned up: with the
  // files back where they belong the suite passes. Without this, a fixture left behind would fail every
  // later run with a bijection error about a route nobody added.
  {
    const result = run('pnpm', registrySuite)
    check(
      'the route registry suite passes once every fixture is removed',
      !result.failed,
      result.output,
    )
  }
}

// 26r. (M-VAT-01) The purchase constraints, as known-bad fixtures against real PostgreSQL.
//
// The rule this unit exists to enforce is that a supplier with no TRN cannot support a recoverable
// input claim, while a bill from one stays postable. It is enforced three times over — a row-level
// CHECK on `bill`, a trigger on `bill_line`, and the deferred totals trigger that makes the header
// agree with its lines — and each layer is probed here separately, because each covers a hole the
// others leave and a passing check that has never been seen to fail may not be a check at all.
//
// Every probe asserts the **name of the rule written for it**, a constraint name or one of the ZV
// SQLSTATEs. A bare non-zero exit is also what a typo in a column name produces, and the rule under
// test would then be dead while this file reported PASS for ever (ADR 0003).
//
// Every probe runs inside `begin; … ; rollback;`, so a probe that is wrongly *accepted* leaves nothing
// behind — which matters more here than elsewhere: `bill` and `bill_line` refuse DELETE for every role
// including the owner, so a committed fixture could not be swept up afterwards by anything.
//
// The deferred triggers need `set constraints all immediate` to fire without committing, which is also
// a second proof that they really are deferred: an immediate trigger would have raised at the INSERT
// before that statement was reached.
{
  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  // After the provisional opening date (2026-09-01) and before any period this suite's siblings lock,
  // so a refusal below is the rule under test rather than ZL002 or ZL004.
  const DATE = "'2026-09-18'"
  const TRN = "'000000000000003'"
  const WITH_TRN = 'gate-fixture-registered'
  const NO_TRN = 'gate-fixture-unregistered'

  const supplier = (code, trn) =>
    `insert into supplier (code, legal_name) values ('${code}', 'gate fixture supplier'); ` +
    'insert into supplier_tax_profile (supplier_id, residency, place_of_supply_rule, trn) ' +
    `select supplier_id, 'domestic', 'domestic_uae', ${trn} from supplier where code = '${code}'`

  // Two suppliers, identical but for the TRN. That pair is the whole subject of the unit: the same bill
  // is recoverable from one and cost from the other.
  const setup = [supplier(WITH_TRN, TRN), supplier(NO_TRN, 'null')].join('; ')

  /**
   * A bill with its journal entry, and optionally one line.
   *
   * `number` is distinct per call and `display_number` derived from it, so a probe is refused by the
   * rule it names rather than by `bill_internal_number_unique` — which is a real constraint and the
   * wrong one to be testing by accident.
   */
  const bill = ({
    n,
    code = WITH_TRN,
    reference = `GATE-${n}`,
    net = 20000,
    gross = 21000,
    recoverable = 1000,
    billDate = DATE,
    dueDate = DATE,
    line = null,
  }) => {
    const entryId = `JE-GATE-BILL-${n}`
    const statements = [
      'insert into journal_entry (entry_id, entry_date, narrative, source) values ' +
        `('${entryId}', ${DATE}, 'gate fixture bill', 'supplier_bill')`,
      'insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils) values ' +
        `('${entryId}', 1, '6010', ${gross}, 0), ('${entryId}', 2, '2010', 0, ${gross})`,
      'insert into bill (supplier_id, supplier_reference, series_code, period_key, number, ' +
        'display_number, bill_date, due_date, entry_id, net_fils, gross_fils, ' +
        'recoverable_input_vat_fils, received_by) select supplier_id, ' +
        `'${reference}', 'SUPP-BILL', '', ${900000 + n}, 'BILL-GATE-${n}', ${billDate}, ${dueDate}, ` +
        `'${entryId}', ${net}, ${gross}, ${recoverable}, 'gate' from supplier where code = '${code}'`,
    ]
    if (line !== null) {
      const {
        treatment = 'standard_recoverable',
        rate = 500,
        lineNet = net,
        lineGross = gross,
        lineRecoverable = recoverable,
      } = line
      statements.push(
        'insert into bill_line (bill_id, line_no, description, expense_account_code, tax_treatment, ' +
          'vat_rate_bp, net_fils, gross_fils, recoverable_input_vat_fils) select bill_id, 1, ' +
          `'Gate fixture line', '6010', '${treatment}', ${rate}, ${lineNet}, ${lineGross}, ` +
          `${lineRecoverable} from bill where supplier_reference = '${reference}'`,
      )
    }
    return statements.join('; ')
  }

  const psqlProbe = (statement) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      dbUrl ?? '',
      '-c',
      `begin; ${setup}; ${statement}; rollback;`,
    ])

  // Written as data so the rule name sits next to the statement that must trip it.
  const probes = [
    {
      name: 'purchases gate rejects the same supplier invoice entered twice',
      rule: 'bill_supplier_reference_unique',
      // The duplicate every accounts-payable process exists to catch: paid twice, VAT claimed twice.
      sql: [bill({ n: 1, reference: 'GATE-DUP' }), bill({ n: 2, reference: 'GATE-DUP' })].join(
        '; ',
      ),
    },
    {
      name: 'purchases gate rejects a recoverable claim on a bill whose supplier holds no TRN',
      rule: 'bill_recoverable_needs_a_trn',
      // The header claim, refused by the row-level CHECK. `supplier_trn` is set by the snapshot trigger
      // from the profile, so the claim is refused however the caller filled the column in.
      sql: bill({ n: 3, code: NO_TRN }),
    },
    {
      name: 'purchases gate rejects a recoverable LINE under a bill with no supplier TRN',
      rule: 'InputVatWithoutSupplierTrn',
      // The line-level half, which the CHECK above cannot see: a header summary of zero with a
      // recoverable line beneath it.
      sql: bill({
        n: 4,
        code: NO_TRN,
        net: 20000,
        gross: 20000,
        recoverable: 0,
        line: {
          treatment: 'standard_recoverable',
          lineNet: 20000,
          lineGross: 21000,
          lineRecoverable: 1000,
        },
      }),
    },
    {
      name: 'purchases gate rejects a claim on a line whose treatment cannot carry one',
      rule: 'bill_line_recoverable_matches_treatment',
      sql: bill({
        n: 5,
        net: 20000,
        gross: 20000,
        recoverable: 0,
        line: {
          treatment: 'no_trn_not_recoverable',
          rate: 0,
          lineNet: 20000,
          lineGross: 20000,
          lineRecoverable: 1000,
        },
      }),
    },
    {
      name: 'purchases gate rejects VAT on a line that is not standard-rated',
      rule: 'bill_line_only_a_standard_rated_line_carries_vat',
      // An exempt supply has no VAT to carve out. A gross above net on one is an amount the preparer
      // has mis-described, and it is the description that decides what is claimed.
      sql: bill({
        n: 6,
        recoverable: 0,
        line: {
          treatment: 'exempt',
          rate: 0,
          lineNet: 20000,
          lineGross: 21000,
          lineRecoverable: 0,
        },
      }),
    },
    {
      name: 'purchases gate rejects a VAT rate on a line that cannot carry VAT',
      rule: 'bill_line_rate_matches_treatment',
      sql: bill({
        n: 7,
        net: 20000,
        gross: 20000,
        recoverable: 0,
        line: {
          treatment: 'zero_rated',
          rate: 500,
          lineNet: 20000,
          lineGross: 20000,
          lineRecoverable: 0,
        },
      }),
    },
    {
      name: 'purchases gate rejects a bill header that disagrees with its lines, at COMMIT',
      rule: 'BillTotalsDoNotMatchLines',
      sql: [
        bill({
          n: 8,
          net: 20000,
          gross: 20000,
          recoverable: 0,
          line: {
            treatment: 'no_trn_not_recoverable',
            rate: 0,
            lineNet: 19000,
            lineGross: 19000,
            lineRecoverable: 0,
          },
        }),
        'set constraints all immediate',
      ].join('; '),
    },
    {
      name: 'purchases gate rejects a bill with no lines at all',
      rule: 'BillTotalsDoNotMatchLines',
      // A different hole in the same rule: a bill with no lines fires no line trigger, so without the
      // header's own constraint trigger it would commit as a demand for money with no stated reason.
      sql: [bill({ n: 9 }), 'set constraints all immediate'].join('; '),
    },
    {
      name: 'purchases gate rejects a supplier with no tax profile, at COMMIT',
      rule: 'SupplierHasNoTaxProfile',
      sql: [
        "insert into supplier (code, legal_name) values ('gate-fixture-orphan', 'gate fixture')",
        'set constraints all immediate',
      ].join('; '),
    },
    {
      name: 'purchases gate rejects an offshore supplier holding a UAE TRN',
      rule: 'supplier_tax_profile_offshore_holds_no_uae_trn',
      sql:
        "insert into supplier (code, legal_name) values ('gate-fixture-offshore', 'gate fixture'); " +
        'insert into supplier_tax_profile (supplier_id, residency, place_of_supply_rule, trn) ' +
        `select supplier_id, 'offshore', 'imported_services_reverse_charge', ${TRN} ` +
        "from supplier where code = 'gate-fixture-offshore'",
    },
    {
      name: 'purchases gate rejects a domestic supplier marked for the reverse charge',
      rule: 'supplier_tax_profile_rule_matches_residency',
      // 'domestic' plus a reverse charge would self-account for VAT the supplier already charged and
      // then claim it twice.
      sql:
        "insert into supplier (code, legal_name) values ('gate-fixture-rule', 'gate fixture'); " +
        'insert into supplier_tax_profile (supplier_id, residency, place_of_supply_rule, trn) ' +
        "select supplier_id, 'domestic', 'imported_services_reverse_charge', null " +
        "from supplier where code = 'gate-fixture-rule'",
    },
    {
      name: 'purchases gate rejects a due date behind the invoice date',
      rule: 'bill_due_not_before_bill_date',
      // A due date behind the invoice makes a brand-new bill overdue on arrival, and the aging report is
      // read by whoever is about to pay somebody.
      sql: bill({ n: 10, dueDate: "'2026-09-17'" }),
    },
    {
      name: 'purchases gate rejects an UPDATE of a bill line, for the owner too',
      rule: 'bill_line is append-only',
      // The tax treatment of a filed line is not editable: reclassifying it after the return that
      // included it would change a filed figure with no trace.
      sql: [
        bill({ n: 11, line: {} }),
        "update bill_line set tax_treatment = 'exempt' where description = 'Gate fixture line'",
      ].join('; '),
    },
    {
      name: 'purchases gate rejects a DELETE of a bill, for the owner too',
      rule: 'bill is append-only',
      sql: [
        bill({ n: 12, line: {} }),
        "delete from bill where supplier_reference = 'GATE-12'",
      ].join('; '),
    },
  ]

  if (!dbUrl) {
    check(
      'purchase constraints reject their known-bad fixtures',
      false,
      'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
    )
  } else {
    for (const { name, rule, sql: statement } of probes) {
      checkRejectedBy(name, psqlProbe(statement), rule)
    }

    // The controls, and the reason the fourteen above mean anything: the same tables accept the
    // legitimate row. Without these, a broken connection string or a renamed table would reject every
    // probe and this gate would report fourteen passes while examining nothing.
    const recoverable = psqlProbe(
      [bill({ n: 20, line: {} }), 'set constraints all immediate'].join('; '),
    )
    check(
      'purchases gate accepts a recoverable bill from a supplier with a TRN',
      !recoverable.failed,
      `rejected a legitimate recoverable bill:\n${recoverable.output}`,
    )

    // The other half of the unit's point: a bill from an unregistered supplier is POSTABLE, and claims
    // nothing. A guard that refused it would satisfy the probes above and leave the bookkeeper entering
    // half the purchase ledger in a spreadsheet.
    const noTrnPostable = psqlProbe(
      [
        bill({
          n: 21,
          code: NO_TRN,
          net: 20000,
          gross: 20000,
          recoverable: 0,
          line: {
            treatment: 'no_trn_not_recoverable',
            rate: 0,
            lineNet: 20000,
            lineGross: 20000,
            lineRecoverable: 0,
          },
        }),
        'set constraints all immediate',
      ].join('; '),
    )
    check(
      'purchases gate accepts a bill from a supplier with no TRN, claiming nothing',
      !noTrnPostable.failed,
      `refused a legitimate bill from an unregistered supplier:\n${noTrnPostable.output}`,
    )

    // The aging buckets, from the SQL function the report groups by. Read back rather than merely
    // executed: a function that returned the same bucket for every date would satisfy "it ran".
    const buckets = run('psql', [
      '--no-psqlrc',
      '-At',
      dbUrl,
      '-c',
      "select string_agg(payables_aging_bucket(date '2026-06-01', date '2026-06-01' + n), ',') " +
        'from generate_series(0, 91, 91) as days(n)',
    ])
    check(
      'purchases gate reads the aging buckets from the database, and they differ across a boundary',
      !buckets.failed &&
        buckets.output.includes('current') &&
        buckets.output.includes('days_over_90'),
      `the aging bucket function did not answer both sides of a boundary:\n${buckets.output}`,
    )

    // Our own numbering series exists and is the never-resetting one, which is what makes a bill dated
    // in a closed year postable after one dated in the next.
    const series = run('psql', [
      '--no-psqlrc',
      '-At',
      dbUrl,
      '-c',
      "select prefix || ':' || reset_policy from document_series where code = 'SUPP-BILL'",
    ])
    check(
      'purchases gate finds the supplier-bill numbering series, resetting never',
      !series.failed && series.output.trim() === 'BILL-:never',
      `the SUPP-BILL series is missing or resets: ${series.output}`,
    )
  }
}

// G-CONN-04 — the cached access token is six columns or none of them, and the set of modules that may
//             hold a plaintext token did not grow to make the refresh lock possible.
//
// The CHECK is the backstop under the one write this unit adds. `recordRefresh` sets the five sealed
// columns and `access_expires_at` in a single statement, so a partial write is impossible by
// construction — but "impossible by construction" is a claim about today's SQL, and the next person to
// add a column or a convenience update is who this constraint is for. A half-written cache does not fail
// where it was written: it decrypts to a wrong-key error, hours later, on the cron job, and the five
// sealed columns are exactly the kind of thing a hand-written UPDATE sets four of.
//
// Every probe runs inside `begin; … ; rollback;`, so a probe that is wrongly ACCEPTED leaves nothing
// behind either — and each asserts the rule BY NAME, because a bare non-zero exit is also what a typo in
// a column name produces, and the constraint under test would then be dead while this file reported PASS
// for ever (ADR 0003).
{
  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  const RULE = 'google_connections_access_token_complete'
  const SUB = 'sub-gate-fixture-access-token-complete'
  // Not a token and not pretending to be one: these rows never leave the rolled-back transaction, and
  // what is under test is the CHECK's arity rather than anything cryptographic.
  const BYTES = "'\\x00'::bytea"
  const seed =
    'insert into google_connections (google_sub, google_email, granted_scopes, refresh_token_ct, ' +
    'refresh_token_nonce, refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp) values ' +
    `('${SUB}', 'google-admin@berelax.ae', array['openid'], ${BYTES}, ${BYTES}, ${BYTES}, 'v1', 'fp')`
  const update = (assignments) =>
    `update google_connections set ${assignments} where google_sub = '${SUB}'`
  // All six, together. The complete write, and the shape every legitimate caller uses.
  const ALL_SIX =
    `access_token_ct = ${BYTES}, access_token_nonce = ${BYTES}, ` +
    `access_token_wrapped_key = ${BYTES}, access_token_kid = 'v1', ` +
    "access_token_aad_fp = 'fp', access_expires_at = now() + interval '1 hour'"

  const psqlProbe = (statement) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      dbUrl ?? '',
      '-c',
      `begin; ${seed}; ${statement}; rollback;`,
    ])

  const probes = [
    {
      name: 'google gate rejects a cached access token written as one column',
      // The mistake in its likeliest form: somebody caches the ciphertext and means to come back for
      // the rest. The row is then undecryptable and says nothing about why.
      sql: update(`access_token_ct = ${BYTES}`),
    },
    {
      name: 'google gate rejects an access-token expiry with no token behind it',
      // The sixth column is part of the same all-or-nothing, and this is the direction that would
      // otherwise make a connection look freshly refreshed with nothing to present.
      sql: update("access_expires_at = now() + interval '1 hour'"),
    },
    {
      name: 'google gate rejects clearing four of the five sealed columns',
      // What a re-consent looks like if it forgets one column. `recordConsent` nulls all six precisely
      // because of this.
      sql: [
        update(ALL_SIX),
        update(
          'access_token_ct = null, access_token_nonce = null, access_token_wrapped_key = null, ' +
            'access_token_kid = null',
        ),
      ].join('; '),
    },
  ]

  if (!dbUrl) {
    check(
      'google connection constraints reject their known-bad fixtures',
      false,
      'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
    )
  } else {
    for (const { name, sql: statement } of probes) {
      checkRejectedBy(name, psqlProbe(statement), RULE)
    }

    // The controls, and the reason the three above mean anything: the same column set accepts the
    // legitimate write in BOTH of its legitimate shapes. Without these, a renamed table or a broken
    // connection string would reject every probe and this gate would report three passes while
    // examining nothing.
    const complete = psqlProbe(update(ALL_SIX))
    check(
      'google gate accepts all six access-token columns written together',
      !complete.failed,
      `rejected the write recordRefresh makes:\n${complete.output}`,
    )

    const cleared = psqlProbe(
      [
        update(ALL_SIX),
        update(
          'access_token_ct = null, access_token_nonce = null, access_token_wrapped_key = null, ' +
            'access_token_kid = null, access_token_aad_fp = null, access_expires_at = null',
        ),
      ].join('; '),
    )
    check(
      'google gate accepts clearing all six together, which is what a re-consent does',
      !cleared.failed,
      `rejected the write recordConsent makes:\n${cleared.output}`,
    )
  }
}

{
  // The other half of this unit, and it is a regression pin rather than a fixture: G-CONN-04 added a
  // module that serialises the refresh, and it deliberately did NOT join the list of modules allowed to
  // hold a plaintext Google token. It obtains an AccessTokenGrant from lifecycle.ts and hands it back to
  // withGoogle, naming no accessor and importing token-store.ts not at all — so the allow-list stays at
  // the five modules G-CONN-03 left it at.
  //
  // Widening an allow-list is the cheapest way to make a boundary rule stop meaning anything, and it
  // happens one deliberate exception at a time. If a later change does need token-refresh.ts on either
  // list, this case is what makes that an explicit decision instead of a diff nobody reads. The
  // known-bad direction is already covered: cases (a) and (d) above write a sixth module that reaches
  // the accessors and assert both gates reject it by name.
  const scanner = readFileSync('scripts/check-google-token-chokepoint.mjs', 'utf8')
  const cruiser = readFileSync('.dependency-cruiser.cjs', 'utf8')
  const allowList = scanner.slice(
    scanner.indexOf('const TOKEN_MODULES'),
    scanner.indexOf('COLUMN_MODULES'),
  )
  const rule = cruiser.slice(
    cruiser.indexOf('google-tokens-only-in-with-google'),
    cruiser.indexOf('dependencyTypesNot', cruiser.indexOf('google-tokens-only-in-with-google')),
  )
  check(
    'the Google token allow-list was not widened for the refresh lock',
    allowList.length > 0 &&
      rule.length > 0 &&
      !allowList.includes('token-refresh') &&
      !rule.includes('token-refresh'),
    'packages/google/src/token-refresh.ts appears in a token allow-list. It holds the advisory lock, ' +
      'not a key: it must not name openToken, sealToken, rewrapToken or connectionBinding, and must ' +
      'not import token-store.ts. If the refresh itself has moved into it, say so and move the ' +
      'allow-list deliberately.',
  )
}

// 28m-28af. (B-CAT-05) The catalogue mutation guard rails, and the purity of the compliance lexicon.
//
// Two gates again, and for the same division as B-CAT-04's: one module in `packages/core` that must stay
// pure, and a set of rules that only PostgreSQL can enforce.
//
// The lexicon is the pure half. It decides whether a public display name may be shown to a customer, and
// the licence-dependent part of that decision — the banned claim terms, the permitted staff titles — is
// read from `regulatory_profile` by the caller and passed in. A clock read there would be a lint whose
// answer depended on when it ran; a `process.env` read would be a compliance rule configured by whoever
// starts the process.
//
// The database half is the guard rails of 0029: three publish preconditions raising three distinct
// codes, two deferred constraint triggers, one write-time trigger with three refusals of its own, a
// CHECK and a foreign key two levels down. Each probe states the rule that must reject it, because a
// bare non-zero exit is also what a typo in a column name produces (ADR 0003) — and because these
// refusals are the difference between an admin screen that says which of three things to fix and one
// that says "could not publish".
//
// The deferred probes run `set constraints all immediate` first, exactly as the booking gate does: it
// makes the trigger fire without committing, and it is incidentally a second proof that the trigger
// really is deferred, since an immediate one would have raised at the UPDATE before that line was
// reached.
//
// Every probe runs inside `begin; … ; rollback;`, so a probe that is wrongly *accepted* leaves nothing
// behind either.
{
  const COMPLIANCE_FIXTURE = 'packages/core/src/compliance/__gate_fixture__.ts'

  // 28m. A clock read in the compliance lexicon must fail the purity gate, by the reason the rule
  //      gives rather than by a bare non-zero exit.
  {
    const result = withFixture(
      COMPLIANCE_FIXTURE,
      'export const lintedAt = (): string => new Date().toISOString()',
      () => run('node', ['scripts/check-core-purity.mjs']),
    )
    checkRejectedBy(
      'purity gate rejects a clock read in packages/core/src/compliance',
      result,
      'inject a Clock and pass the instant in',
    )
  }

  // 28n. And an environment read, which is the likelier mistake in this module: a banned-term list is
  //      exactly the sort of thing somebody reaches for `process.env` to override.
  {
    const result = withFixture(
      COMPLIANCE_FIXTURE,
      "export const extraTerms = (): string => process.env['BANNED_TERMS'] ?? ''",
      () => run('node', ['scripts/check-core-purity.mjs']),
    )
    checkRejectedBy(
      'purity gate rejects an environment read in packages/core/src/compliance',
      result,
      'pass configuration in as an argument',
    )
  }

  // 28o. The control for both. The profile arrives as an argument — that is the whole design, and a gate
  //      that rejected it would make the module unwritable.
  {
    const result = withFixture(
      COMPLIANCE_FIXTURE,
      [
        'export const refusesClaim = (name: string, banned: readonly string[]): boolean =>',
        '  banned.some((term) => name.toLowerCase().includes(term))',
      ].join('\n'),
      () => run('node', ['scripts/check-core-purity.mjs']),
    )
    check(
      'purity gate allows a lexicon whose term list is an argument',
      !result.failed,
      `rejected the mechanism B-CAT-05 specifies:\n${result.output}`,
    )
  }

  const catUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  const CAT_MARKER = 'gate fixture bcat05'
  const KEY = 'bcat05_gate'
  const BARE = 'bcat05_gate_bare'
  const PATH = "'/treatments/bcat05-gate'"
  const BARE_PATH = "'/treatments/bcat05-gate-bare'"
  const LEGACY = "'/treatments/bcat05-gate-legacy'"
  const SECOND = "'/treatments/bcat05-gate-second'"

  const service = (key, slug, order) =>
    'insert into service (style, treatment_key, slug, internal_name, public_display_name, ' +
    `turnaround_minutes, display_order) values ('asian', '${key}', '${slug}', 'Gate fixture', ` +
    `'Normal Massage (Asian)', 20, ${order})`
  const compat = (key) =>
    'insert into service_room_type_compat (service_style, service_treatment_key, room_type) ' +
    `values ('asian', '${key}', 'standard')`
  const shape = (key) =>
    'insert into service_resource_shape (service_style, service_treatment_key, shape, ' +
    'therapists_required, rooms_required, min_room_capacity, required_room_type, ' +
    `therapist_buffer_minutes) values ('asian', '${key}', 'solo', 1, 1, 1, 'standard', 10)`
  const variant = (key) =>
    'insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note) ' +
    `select id, 60, 20000, '${CAT_MARKER}' from service where treatment_key = '${key}'`
  const redirect = (source, target, reason = "'gate fixture'", status = 301) =>
    'insert into redirect_map (source_path, target_path, status_code, reason) values ' +
    `(${source}, ${target}, ${status}, ${reason})`
  const publish = (key) => `update service set published_at = now() where treatment_key = '${key}'`

  // One complete service, published, plus one with nothing attached so each publish precondition can
  // be the only thing missing. Both inside the same rolled-back transaction as the probe.
  const CAT_SETUP = [
    service(KEY, 'bcat05-gate', 97),
    compat(KEY),
    shape(KEY),
    variant(KEY),
    publish(KEY),
    service(BARE, 'bcat05-gate-bare', 96),
  ].join('; ')

  // `set constraints all immediate` is only issued by the probes that need it, because it also makes
  // every other deferred constraint in the transaction fire at statement end.
  const catProbe = (statement, extraArgs = []) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      ...extraArgs,
      catUrl ?? '',
      '-c',
      `begin; ${CAT_SETUP}; ${statement}; rollback;`,
    ])
  const deferred = (statement) => `set constraints all immediate; ${statement}`

  // What a committed probe leaves behind, in the guard rails' own order reversed: the redirect rows go
  // first, because deleting a service something still points at is refused by ZC005 — the rule this
  // block has just finished proving.
  const CAT_SWEEP =
    "delete from redirect_map where source_path like '/treatments/bcat05-gate%' " +
    "or target_path like '/treatments/bcat05-gate%' " +
    "or source_path = '/product-category/bcat05-gate'; " +
    `delete from booking where notes = '${CAT_MARKER}'; ` +
    `delete from service_variant where provisional_note = '${CAT_MARKER}'; ` +
    "delete from service where treatment_key like 'bcat05_gate%'; " +
    "delete from service_room_type_compat where service_treatment_key like 'bcat05_gate%'; " +
    "delete from business_day where trading_date = '2099-07-01'; " +
    "delete from customer where phone_e164 = '+971500000198';"

  // The one probe that has to COMMIT. `set constraints all immediate` cannot serve here: it would fire
  // the deferred trigger at the end of the UPDATE, which is precisely the state the trigger is deferred
  // to tolerate. So the control commits for real — which is also the only way to see the deferred check
  // ACCEPT a transaction — and the `finally` below sweeps what it left.
  const catCommit = (statement, extraArgs = []) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      ...extraArgs,
      catUrl ?? '',
      '-c',
      // The sweep runs in the same invocation, after the COMMIT. A fixture left committed would fail
      // every later probe in this block with a unique violation about the wrong thing — which is
      // exactly what it did the first time this control was written.
      `begin; ${CAT_SETUP}; ${statement}; commit; ${CAT_SWEEP}`,
    ])

  const catProbes = [
    // --- publishing: three preconditions, three names ------------------------------------------
    {
      name: 'catalogue gate rejects publishing a service no room type may deliver',
      rule: 'service_publish_without_compat_row',
      sql: publish(BARE),
    },
    {
      name: 'catalogue gate rejects publishing a service with no resource shape',
      rule: 'service_publish_without_resource_shape',
      sql: `${compat(BARE)}; ${publish(BARE)}`,
    },
    {
      name: 'catalogue gate rejects publishing a service with no priced variant',
      rule: 'service_publish_without_priced_variant',
      sql: `${compat(BARE)}; ${shape(BARE)}; ${publish(BARE)}`,
    },
    {
      // Archiving withdraws publication in the same statement; the pair together is not a state the
      // site could render sensibly.
      name: 'catalogue gate rejects a service that is archived and published at once',
      rule: 'service_archived_is_not_published',
      sql: `update service set published_at = now(), archived_at = now() where treatment_key = '${KEY}'`,
    },
    // --- the slug change and its 301 -----------------------------------------------------------
    {
      name: 'catalogue gate rejects a slug change that leaves no redirect',
      rule: 'slug_change_without_redirect',
      sql: deferred(`update service set slug = 'bcat05-gate-moved' where treatment_key = '${KEY}'`),
    },
    {
      // The 301 has to point at where the service ENDED the transaction. A row naming the intermediate
      // slug of a double rename is a hop to a path that never existed publicly.
      name: 'catalogue gate rejects a 301 left pointing at an intermediate slug',
      rule: 'slug_change_without_redirect',
      sql: deferred(
        `update service set slug = 'bcat05-gate-mid' where treatment_key = '${KEY}'; ` +
          `${redirect(PATH, "'/treatments/bcat05-gate-mid'")}; ` +
          `update service set slug = 'bcat05-gate-final' where treatment_key = '${KEY}'`,
      ),
    },
    {
      name: 'catalogue gate rejects a redirect to a slug no live service answers on',
      rule: 'redirect_target_unresolved',
      sql: redirect(LEGACY, "'/treatments/bcat05-gate-no-such-thing'"),
    },
    {
      name: 'catalogue gate rejects a redirect to an archived service',
      rule: 'redirect_target_unresolved',
      sql:
        `update service set published_at = null, archived_at = now() where treatment_key = '${KEY}'; ` +
        redirect(LEGACY, PATH),
    },
    {
      name: 'catalogue gate rejects archiving a service a redirect still points at',
      rule: 'redirect_target_unresolved',
      sql: deferred(
        `${redirect(LEGACY, PATH)}; ` +
          `update service set published_at = null, archived_at = now() where treatment_key = '${KEY}'`,
      ),
    },
    {
      name: 'catalogue gate rejects deleting a service a redirect still points at',
      rule: 'redirect_target_unresolved',
      sql: deferred(
        `${redirect(LEGACY, PATH)}; delete from service where treatment_key = '${KEY}'`,
      ),
    },
    {
      // A -> B -> C. One more rename and the oldest URL costs three hops, which is where crawlers stop.
      name: 'catalogue gate rejects a redirect chain rather than collapsing it silently',
      rule: 'redirect_chain_not_collapsed',
      sql: `${redirect(LEGACY, PATH)}; ${redirect(SECOND, LEGACY)}`,
    },
    {
      name: 'catalogue gate rejects a redirect from a page that still answers',
      rule: 'redirect_source_still_live',
      sql: redirect(PATH, "'/treatments'"),
    },
    {
      name: 'catalogue gate rejects a redirect to itself',
      rule: 'redirect_map_not_self',
      sql: redirect("'/product-tag/bcat05-gate'", "'/product-tag/bcat05-gate'"),
    },
    {
      name: 'catalogue gate rejects a relative source path',
      rule: 'redirect_map_source_path_absolute',
      sql: redirect("'treatments/bcat05-gate-legacy'", PATH),
    },
    {
      // A 302 on a permanent rename asks every crawler to keep the old URL, which is the opposite of
      // what the redirect is for.
      name: 'catalogue gate rejects a temporary redirect status',
      rule: 'redirect_map_status_permanent',
      sql: redirect(LEGACY, PATH, "'gate fixture'", 302),
    },
    {
      name: 'catalogue gate rejects a redirect with no stated reason',
      rule: 'redirect_map_reason_nonempty',
      sql: redirect(LEGACY, PATH, "'   '"),
    },
    {
      name: 'catalogue gate rejects two redirects from one path',
      rule: 'redirect_map_source_path_key',
      sql: `${redirect(LEGACY, PATH)}; ${redirect(LEGACY, BARE_PATH)}`,
    },
  ]

  if (!catUrl) {
    check(
      'catalogue guard rails reject their known-bad fixtures',
      false,
      'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
    )
  } else {
    try {
      for (const { name, rule, sql: statement } of catProbes) {
        checkRejectedBy(name, catProbe(statement), rule)
      }

      // 28ab. The refusal an owner actually meets: a service with a booking cannot be deleted. Asserted
      //       by the foreign key's own name, because the statement fails two levels down — the delete
      //       cascades into service_variant and is refused by `appointment` (0024 ON DELETE RESTRICT).
      const BOOKED = [
        "insert into customer (phone_e164, created_via) values ('+971500000198', 'guest_booking')",
        `insert into business_day (trading_date, opens_at, closes_at, source) values
         ('2099-07-01', '2099-07-01 07:00:00+00', '2099-07-01 22:00:00+00', 'weekly')
         on conflict (trading_date) do nothing`,
        `insert into booking (id, customer_id, source, notes) values
         ('50000000-0000-4000-8000-000000000005',
          (select id from customer where phone_e164 = '+971500000198'), 'front_desk', '${CAT_MARKER}')`,
        `insert into appointment (booking_id, trading_date, service_variant_id, shape, therapist_id,
          room_id, period, status, gross_price_fils) values
         ('50000000-0000-4000-8000-000000000005', '2099-07-01',
          (select id from service_variant where provisional_note = '${CAT_MARKER}'), 'solo',
          '50000000-0000-4000-8000-0000000000a1'::uuid,
          (select id from rooms where code = 'room-1'),
          tstzrange('2099-07-01 19:00:00+00','2099-07-01 20:00:00+00','[)'), 'confirmed', 20000)`,
      ].join('; ')
      checkRejectedBy(
        'catalogue gate rejects deleting a service that has an appointment',
        catProbe(`${BOOKED}; delete from service where treatment_key = '${KEY}'`),
        'appointment_service_variant_id_fkey',
      )

      // 28ac. The first control, and the one that matters most: the whole correct rename sequence must
      //       commit. Without it every probe above is satisfied by a table nobody can rename anything in.
      const renamed = catCommit(
        `update service set slug = 'bcat05-gate-renamed' where treatment_key = '${KEY}'; ` +
          `update redirect_map set target_path = '/treatments/bcat05-gate-renamed' ` +
          `  where target_path = ${PATH}; ` +
          `${redirect(PATH, "'/treatments/bcat05-gate-renamed'", "'slug change'")}; ` +
          `select 'redirects=' || count(*) from redirect_map where source_path = ${PATH} ` +
          `  and target_path = '/treatments/bcat05-gate-renamed'`,
        ['-At'],
      )
      check(
        'catalogue gate accepts a slug change that writes its 301 in the same transaction',
        !renamed.failed && renamed.output.includes('redirects=1'),
        `refused the sequence B-CAT-05 specifies:\n${renamed.output}`,
      )

      // 28ad. Publishing a service that has all three preconditions, and the bookable index agreeing.
      const published = catProbe(
        `${compat(BARE)}; ${shape(BARE)}; ${variant(BARE)}; ${publish(BARE)}; ` +
          `select 'bookable=' || count(*) from service where published_at is not null ` +
          `  and archived_at is null and treatment_key in ('${KEY}', '${BARE}')`,
        ['-At'],
      )
      check(
        'catalogue gate accepts publishing a service with a compat row, a shape and a price',
        !published.failed && published.output.includes('bookable=2'),
        `refused a service that meets every precondition:\n${published.output}`,
      )

      // 28ae. Archiving takes the service out of the bookable set and is accepted — the action the owner
      //       actually wants when they reach for delete.
      const archived = catProbe(
        `update service set published_at = null, archived_at = now() where treatment_key = '${KEY}'; ` +
          `select 'bookable=' || count(*) from service where published_at is not null ` +
          `  and archived_at is null and treatment_key = '${KEY}'`,
        ['-At'],
      )
      check(
        'catalogue gate accepts archiving a published service, which leaves the bookable set',
        !archived.failed && archived.output.includes('bookable=0'),
        `refused an archive, or left the service bookable:\n${archived.output}`,
      )

      // 28af. The last two controls: a legitimate legacy redirect onto a live page, and deleting a
      //       service nobody ever booked. Without the second, `service_has_appointments` is satisfied by
      //       a table from which nothing can ever be deleted.
      const legacy = catProbe(
        redirect("'/product-category/bcat05-gate'", PATH, "'baseline import'"),
      )
      check(
        'catalogue gate accepts a legacy redirect onto a live treatment page',
        !legacy.failed,
        `refused the row W-SITE-09's importer writes:\n${legacy.output}`,
      )
      const unbooked = catProbe(`delete from service where treatment_key = '${BARE}'`)
      check(
        'catalogue gate accepts deleting a service nobody ever booked',
        !unbooked.failed,
        `refused a delete that nothing depends on:\n${unbooked.output}`,
      )
    } finally {
      // Insurance. Every probe rolls back and the committing control sweeps itself, so in the ordinary
      // case this deletes nothing — it is here for the probe that is wrongly ACCEPTED, whose rows would
      // otherwise fail every later gate with an error about something else entirely.
      run('psql', ['--no-psqlrc', '-q', catUrl, '-c', CAT_SWEEP])
    }
  }
}

// 31a-31af. (H-HARD-02) The four supply-chain gates: credentials, dependency advisories, outbound
// licences and container policy. Each rule is asserted **by name**, because a bare non-zero exit is
// also what a typo in a path produces, and the four of them together are then run clean and timed
// against a declared budget — `pnpm verify` is run on every unit by every agent, so a scan that costs
// two minutes costs that on every future unit.
{
  // --- the credential scan ----------------------------------------------------------------------
  //
  // `AKIA` + `IOSFODNN7EXAMPLE` is AWS's own documentation example key. It has the exact shape the rule
  // matches and cannot be mistaken for a real credential, which is the only kind of fixture a secret
  // gate may carry: a plausible one would be a credential committed to this repository.
  //
  // It is assembled at runtime rather than written as one literal; so is the high-entropy fixture
  // below, and the managed-database URL is split across two. Do not join any of them up: `pnpm secrets`
  // scans every tracked file including this one, and a credential-shaped literal here would make the
  // gate report itself. The alternative — an allowlist entry exempting this file — would leave a blind
  // spot in the one file every agent edits.
  const FAKE_AWS_KEY = `AKIA${'IOSFODNN7EXAMPLE'}`
  const secretFixture = 'packages/core/src/__gate_fixture__.ts'
  {
    const result = withFixture(secretFixture, `export const key = '${FAKE_AWS_KEY}'`, () =>
      run('node', ['scripts/check-secrets.mjs']),
    )
    checkRejectedBy('secret scan rejects an AWS access key id', result, '[aws-access-key-id]')
    // The gate must report the path and the rule and nothing else. A scanner that echoes its finding
    // has turned one file somebody can rotate into a CI log, an agent transcript and a scrollback.
    check(
      'secret scan never prints the value it matched',
      !result.output.includes(FAKE_AWS_KEY),
      `the matched credential appeared in the gate's own output:\n${result.output}`,
    )
    check(
      'secret scan reports the path it found it in',
      result.output.includes(secretFixture),
      `a finding with no path is not actionable:\n${result.output}`,
    )
  }

  // A DigitalOcean managed-database URL: public host, and the password is the whole database.
  {
    const result = withFixture(
      secretFixture,
      "export const url = 'postgres://doadmin:EXAMPLE-NOT-A-REAL-PASSWORD@" +
        "db-postgresql-fra1-00000-do-user-0-0.b.db.ondigitalocean.com:25060/defaultdb'",
      () => run('node', ['scripts/check-secrets.mjs']),
    )
    checkRejectedBy(
      'secret scan rejects a reachable database URL carrying a password',
      result,
      '[database-url-with-password]',
    )
  }

  // The control for it, and the reason the rule is worth having: the same shape on loopback is the
  // documented local development credential, which appears in .env.example, in the CI workflow and in
  // the agent brief. Exempting those three paths would have exempted whatever lands in them next.
  {
    const result = withFixture(
      secretFixture,
      "export const url = 'postgres://berelax:berelax@127.0.0.1:5432/berelax_dev'",
      () => run('node', ['scripts/check-secrets.mjs']),
    )
    check(
      'secret scan accepts the loopback development credential',
      !result.failed,
      `a database nobody outside the machine can reach is not a secret:\n${result.output}`,
    )
  }

  // The general rule, for the credential no provider pattern anticipated. The value says what it is
  // and is still a single base64url encoding of 40-odd high-entropy characters, which is what the rule
  // actually tests — it must not fire on `password: 'a-long-enough-test-password'`.
  {
    const result = withFixture(
      secretFixture,
      `export const apiKey = 'NOT_A_SECRET_${'Zq7Z4pKfW2mNvB8xTr5LsJd1HgYc'}'`,
      () => run('node', ['scripts/check-secrets.mjs']),
    )
    checkRejectedBy(
      'secret scan rejects a high-entropy value assigned to a credential name',
      result,
      '[high-entropy-assigned-secret]',
    )
  }

  // An exemption nobody can review, and an exemption that no longer covers anything. The second is the
  // dangerous one: it silently covers whatever arrives at that path next.
  {
    const allowlist = 'build/__gate_fixture_secret_allowlist__.json'
    const result = withFixture(
      allowlist,
      JSON.stringify({
        entries: [{ rule: 'aws-access-key-id', path: 'packages/core/src/nothing-here.ts' }],
      }),
      () => run('node', ['scripts/check-secrets.mjs', '--allowlist', allowlist]),
    )
    checkRejectedBy(
      'secret scan rejects an allowlist entry with no reason',
      result,
      '[allowlist-entry-without-reason]',
    )
    checkRejectedBy(
      'secret scan rejects an allowlist entry that no longer matches anything',
      result,
      '[stale-allowlist-entry]',
    )
  }

  // --- dependency advisories --------------------------------------------------------------------
  //
  // With nothing accepted, the five advisories this repository really carries must be reported. This is
  // the probe that proves the walk reaches transitive reality: dompurify is six edges from anything
  // anybody declared, inside Payload's admin editor.
  {
    const allowlist = 'build/__gate_fixture_advisory_allowlist__.json'
    const result = withFixture(
      allowlist,
      JSON.stringify({ maxHorizonDays: 365, entries: [] }),
      () => run('node', ['scripts/check-dependencies.mjs', '--allowlist', allowlist]),
    )
    checkRejectedBy(
      'advisory gate reports an unaccepted advisory in the resolved graph',
      result,
      '[unaccepted-advisory]',
    )
    check(
      'advisory gate names the transitive package and its path, not just a count',
      result.output.includes('dompurify@3.4.8') && result.output.includes('monaco-editor'),
      `the finding has to be traceable to a dependency edge:\n${result.output}`,
    )
  }

  // A fixture workspace package declaring a version with a known critical advisory. `mkdir` through the
  // `run` helper rather than a new import, and `rm -rf` in the `finally`: a workspace directory left
  // behind would fail later gates with an error about the wrong thing.
  {
    const directory = 'packages/__gate_fixture_pkg__'
    run('mkdir', ['-p', directory])
    try {
      const manifest = `${directory}/package.json`
      const critical = withFixture(
        manifest,
        JSON.stringify({
          name: '@berelax/gate-fixture',
          private: true,
          dependencies: { minimist: '0.0.8' },
        }),
        () => run('node', ['scripts/check-dependencies.mjs']),
      )
      checkRejectedBy(
        'advisory gate rejects a declared dependency with a critical advisory',
        critical,
        '[critical-advisory]',
      )
      check(
        'advisory gate names the advisory it matched',
        critical.output.includes('GHSA-xvch-5gv4-984h'),
        `a finding with no advisory id cannot be looked up:\n${critical.output}`,
      )

      // The same directory, for the two workspace-manifest rules the licence policy owns. A workspace
      // package of a closed-source product grants nobody an outbound licence, and `private: true` is
      // what stops one being published by accident.
      const granted = withFixture(
        manifest,
        JSON.stringify({ name: '@berelax/gate-fixture', private: true, license: 'AGPL-3.0-only' }),
        () => run('node', ['scripts/check-licences.mjs']),
      )
      checkRejectedBy(
        'licence gate rejects a workspace package that grants an outbound licence',
        granted,
        '[workspace-licence-grant]',
      )
      const publishable = withFixture(
        manifest,
        JSON.stringify({ name: '@berelax/gate-fixture' }),
        () => run('node', ['scripts/check-licences.mjs']),
      )
      checkRejectedBy(
        'licence gate rejects a workspace package that is not private',
        publishable,
        '[private-workspace-package]',
      )
    } finally {
      run('rm', ['-rf', directory])
    }
  }

  // The allowlist's own rules. Accepting a live vulnerability is a decision with a shelf life, so an
  // entry with no expiry, an expired one, and one dated past the policy horizon are all refused — and a
  // critical advisory cannot be accepted at all, because no date makes it acceptable.
  {
    const reason =
      'a deliberately long reason string, because the gate refuses an entry whose reason is too ' +
      'short to disagree with'
    const cases = [
      {
        name: 'an allowlist entry with no expiry',
        rule: '[allowlist-entry-without-expiry]',
        entry: { id: 'GHSA-67mh-4wv8-2f99', package: 'esbuild', reason },
      },
      {
        name: 'an expired allowlist entry',
        rule: '[allowlist-entry-expired]',
        entry: { id: 'GHSA-67mh-4wv8-2f99', package: 'esbuild', expires: '2024-01-01', reason },
      },
      {
        name: 'an allowlist entry dated past the policy horizon',
        rule: '[allowlist-expiry-too-far]',
        entry: { id: 'GHSA-67mh-4wv8-2f99', package: 'esbuild', expires: '2099-01-01', reason },
      },
      {
        name: 'an allowlist entry for a critical advisory',
        rule: '[critical-advisory-cannot-be-accepted]',
        entry: { id: 'GHSA-xvch-5gv4-984h', package: 'minimist', expires: '2026-12-01', reason },
      },
    ]
    const allowlist = 'build/__gate_fixture_advisory_allowlist__.json'
    for (const probe of cases) {
      const result = withFixture(
        allowlist,
        JSON.stringify({ maxHorizonDays: 365, entries: [probe.entry] }),
        () => run('node', ['scripts/check-dependencies.mjs', '--allowlist', allowlist]),
      )
      checkRejectedBy(`advisory gate rejects ${probe.name}`, result, probe.rule)
    }
  }

  // --- outbound licences ------------------------------------------------------------------------
  //
  // Both probes run the **real** graph against a modified policy, which is what makes them mean
  // something: `@img/sharp-libvips-<platform>` is LGPL-3.0-or-later and is genuinely shipped, four
  // edges below packages/media's `sharp`. With its acceptance removed the gate must find it; with the
  // LGPL family reclassified as strong copyleft it must refuse it outright.
  {
    const policy = JSON.parse(readFileSync('build/licence-policy.json', 'utf8'))
    const fixture = 'build/__gate_fixture_licence_policy__.json'
    const unaccepted = withFixture(fixture, JSON.stringify({ ...policy, accepted: [] }), () =>
      run('node', ['scripts/check-licences.mjs', '--policy', fixture]),
    )
    checkRejectedBy(
      'licence gate finds the unaccepted copyleft dependency this product really ships',
      unaccepted,
      '[unaccepted-weak-copyleft]',
    )
    check(
      'licence gate names the package and the path it ships through',
      unaccepted.output.includes('@img/sharp-libvips') &&
        unaccepted.output.includes('packages/media'),
      `a licence finding with no dependency path cannot be acted on:\n${unaccepted.output}`,
    )

    const asStrong = withFixture(
      fixture,
      JSON.stringify({
        ...policy,
        weakCopyleft: policy.weakCopyleft.filter((id) => id !== 'LGPL-3.0-or-later'),
        strongCopyleft: [...policy.strongCopyleft, 'LGPL-3.0-or-later'],
      }),
      () => run('node', ['scripts/check-licences.mjs', '--policy', fixture]),
    )
    checkRejectedBy(
      'licence gate refuses strong copyleft in the shipped closure',
      asStrong,
      '[strong-copyleft-in-shipped-closure]',
    )
  }

  // A copyleft fixture *dependency*, injected into the pnpm store: an AGPL-3.0-only package unpacked
  // into node_modules that the lockfile does not explain. It has to be refused twice — once for being on
  // disk with nothing in the lockfile accounting for it, and once for the licence, because code on disk
  // is what gets copied into an image whether or not a lockfile mentions it.
  {
    const store = 'node_modules/.pnpm/gate-fixture-copyleft@1.0.0'
    const directory = `${store}/node_modules/gate-fixture-copyleft`
    run('mkdir', ['-p', directory])
    try {
      const injected = withFixture(
        `${directory}/package.json`,
        JSON.stringify({
          name: 'gate-fixture-copyleft',
          version: '1.0.0',
          license: 'AGPL-3.0-only',
        }),
        () => run('node', ['scripts/check-licences.mjs']),
      )
      checkRejectedBy(
        'licence gate refuses a copyleft fixture dependency unpacked into the store',
        injected,
        '[strong-copyleft-in-shipped-closure]',
      )
      checkRejectedBy(
        'licence gate refuses a package the lockfile does not account for',
        injected,
        '[package-outside-the-lockfile-graph]',
      )
    } finally {
      run('rm', ['-rf', store])
    }
  }

  // --- container policy -------------------------------------------------------------------------
  //
  // There is no Dockerfile in this repository yet — apps/worker/Dockerfile belongs to W-SYS-06 — so the
  // image vulnerability scan is deferred. These fixtures prove the rules that do not need an image are
  // live, including the Dockerfile rules, so the first Dockerfile is held to them on the commit that
  // adds it rather than six months later.
  {
    const compose = 'docker-compose.gate-fixture.yml'
    const service = (image) => `services:\n  probe:\n    image: ${image}\n`
    const cases = [
      { name: 'an image on a moving tag', image: 'postgres:latest', rule: '[unpinned-image-tag]' },
      {
        name: 'a PostgreSQL major the managed database does not run',
        image: 'postgres:15-alpine',
        rule: '[postgres-major-mismatch]',
      },
      { name: 'an undeclared base image', image: 'redis:7-alpine', rule: '[undeclared-image]' },
    ]
    for (const probe of cases) {
      const result = withFixture(compose, service(probe.image), () =>
        run('node', ['scripts/check-container.mjs']),
      )
      checkRejectedBy(`container gate rejects ${probe.name}`, result, probe.rule)
    }

    const dockerfile = 'apps/worker/Dockerfile.gate-fixture'
    const result = withFixture(dockerfile, 'FROM node:22\nCOPY .env ./\nRUN echo build\n', () =>
      run('node', ['scripts/check-container.mjs']),
    )
    checkRejectedBy(
      'container gate rejects a base image with no digest',
      result,
      '[unpinned-base-image]',
    )
    checkRejectedBy(
      'container gate rejects an image whose final stage is root',
      result,
      '[container-runs-as-root]',
    )
    checkRejectedBy(
      'container gate rejects a .env copied into a layer',
      result,
      '[env-file-copied-into-image]',
    )
    checkRejectedBy(
      'container gate rejects an undeclared Dockerfile',
      result,
      '[dockerfile-not-declared]',
    )

    // And the deferral cannot be quietly forgotten: the moment a Dockerfile the policy records as
    // `not-yet-created` exists, the gate demands the policy — and with it the image vulnerability scan —
    // be revisited. Asserted against a fixture policy pointing at the fixture path, deliberately not by
    // writing apps/worker/Dockerfile: that is a real file W-SYS-06 will author, and a harness that
    // created and then deleted it could destroy work in progress.
    const containerPolicy = JSON.parse(readFileSync('build/container-policy.json', 'utf8'))
    const policyFixture = 'build/__gate_fixture_container_policy__.json'
    const appeared = withFixture(
      policyFixture,
      JSON.stringify({
        ...containerPolicy,
        dockerfiles: [{ path: dockerfile, unit: 'W-SYS-06', status: 'not-yet-created' }],
      }),
      () =>
        withFixture(
          dockerfile,
          'FROM node:22-slim@sha256:' +
            '0000000000000000000000000000000000000000000000000000000000000000\nUSER node\n',
          () => run('node', ['scripts/check-container.mjs', '--policy', policyFixture]),
        ),
    )
    checkRejectedBy(
      'container gate demands the policy be updated when the deferred Dockerfile appears',
      appeared,
      '[dockerfile-appeared]',
    )
  }

  // --- the completeness property, and the cost ---------------------------------------------------
  //
  // Case 29 below is what makes deleting a gate a build failure. These read its list out of this file
  // rather than restating it, so they cannot pass against a list that has stopped containing these
  // four. `'postgres:16'` is that list's last entry and appears nowhere else after it.
  {
    const workflow = readFileSync('.github/workflows/ci.yml', 'utf8')
    const { scripts } = JSON.parse(readFileSync('package.json', 'utf8'))
    const source = readFileSync('scripts/test-gates.mjs', 'utf8')
    const marker = source.lastIndexOf("'postgres:16'")
    const listing = source.slice(source.lastIndexOf('[', marker), source.indexOf(']', marker))
    const required = [...listing.matchAll(/'([^']+)'/g)].map((match) => match[1])
    check(
      "the completeness check's own list is readable from source",
      required.length > 20 && required.includes('pnpm gates:test'),
      `read ${required.length} entries: ${required.join(', ')}`,
    )

    // Everything `pnpm verify` runs must have a CI step. Derived from package.json, so unlike a
    // hand-maintained list it cannot drift: adding a gate to `verify` and forgetting CI fails here.
    const missingFromCI = scripts.verify
      .split('&&')
      .map((part) => part.trim())
      .filter((command) => !workflow.includes(`run: ${command}\n`))
    check(
      'every gate in pnpm verify has a step in the CI workflow',
      missingFromCI.length === 0,
      `not run by CI: ${missingFromCI.join(', ')}`,
    )

    // And the converse, which keeps case 29 honest: every package.json script the workflow runs must be
    // registered there, or deleting its step would be a silent loss of coverage.
    const unregistered = [...workflow.matchAll(/^\s+run: pnpm ([\w:-]+)$/gm)]
      .map((match) => match[1])
      .filter((name) => Object.hasOwn(scripts, name))
      .filter((name) => !required.includes(`pnpm ${name}`))
    check(
      'every gate the workflow runs is registered with the completeness check',
      unregistered.length === 0,
      `run by CI but not asserted by case 29: ${unregistered.join(', ')}`,
    )

    for (const gate of ['pnpm secrets', 'pnpm deps', 'pnpm licences', 'pnpm container']) {
      const without = workflow.replace(`run: ${gate}\n`, 'run: true\n')
      const missing = required.filter((entry) => !without.includes(entry))
      check(
        `removing \`${gate}\` from the workflow fails the completeness check`,
        missing.includes(gate),
        missing.length === 0
          ? `case 29's list did not notice ${gate} was gone`
          : `it reported ${missing.join(', ')} instead`,
      )
    }
  }

  // The declared time budget. Each gate is run clean — which is also the control for every probe above,
  // since a gate that rejected everything would fail here — and timed. The budgets are several times the
  // measured cost so a slow CI filesystem does not fail the build, and low enough that a scanner which
  // grew a network call or a full-tree parse would.
  {
    const budgets = [
      ['secrets', 'scripts/check-secrets.mjs', 8],
      ['deps', 'scripts/check-dependencies.mjs', 8],
      ['licences', 'scripts/check-licences.mjs', 8],
      ['container', 'scripts/check-container.mjs', 5],
    ]
    let total = 0
    for (const [name, script, budget] of budgets) {
      const started = Date.now()
      const result = run('node', [script])
      const seconds = (Date.now() - started) / 1000
      total += seconds
      check(
        `pnpm ${name} passes on this tree in ${seconds.toFixed(2)}s, within its ${budget}s budget`,
        !result.failed && seconds <= budget,
        result.failed
          ? `the gate failed on a clean tree:\n${result.output}`
          : `took ${seconds.toFixed(2)}s, over the ${budget}s budget`,
      )
    }
    check(
      `the four supply-chain gates add ${total.toFixed(2)}s to pnpm verify, within the 25s budget`,
      total <= 25,
      `${total.toFixed(2)}s is more than pnpm verify should spend on supply-chain scanning`,
    )
  }
}

// 28ag-28an. (G-CONN-05) The picker's addressing scheme is enforced by the database, and the set of
//            modules allowed to hold a plaintext Google token did not grow to make the picker possible.
//
// A selection fills the **primary** capability row: `update google_capabilities set resource_ref = … where
// connection_id = … and capability = … and is_primary`. That is a single-row address only because two
// indexes from migration 0016 say so, and both are easy to believe without checking:
//
//   - `google_capability_one_primary` — at most one primary per (connection_id, capability). Without it the
//     update touches an arbitrary number of rows and the review autoresponder resolves whichever the plan
//     read first, which is how a reply reaches the wrong listing.
//   - `google_capability_resource_unique` — (connection_id, capability, resource_ref) with **NULLS NOT
//     DISTINCT**, so a second resource-less row cannot exist either. That is the half a reader skips: the
//     row a consent leaves behind has `resource_ref` null, and two of them would make "the row the picker
//     fills" ambiguous before any resource was ever chosen.
//
// And the event a selection writes carries the chosen `placeId` into an append-only row that is mirrored
// into `audit_event`, so `google_connection_events_no_token` is the constraint standing between a
// convenient debugging line and a bearer credential in a query log.
//
// Every probe runs inside `begin; … ; rollback;`, so one that is wrongly ACCEPTED leaves nothing behind
// either, and each asserts its rule BY NAME — a bare non-zero exit is also what a typo in a column name
// produces, and the constraint under test would then be dead while this file reported PASS for ever
// (ADR 0003).
{
  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  const SUB = 'sub-gate-fixture-picker-selection'
  // Not a token and not pretending to be one: these rows never leave the rolled-back transaction, and what
  // is under test is the indexes' arity rather than anything cryptographic.
  const BYTES = "'\\x00'::bytea"
  const seed =
    'insert into google_connections (google_sub, google_email, granted_scopes, refresh_token_ct, ' +
    'refresh_token_nonce, refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp) values ' +
    `('${SUB}', 'google-admin@berelax.ae', array['openid'], ${BYTES}, ${BYTES}, ${BYTES}, 'v1', 'fp')`

  // The shape `completeGoogleConsent` leaves: one primary row per capability, no resource chosen yet.
  const REF = `'{"account":"accounts/1","location":"locations/2","placeId":"ChIJ-gate-fixture"}'::jsonb`
  const OTHER_REF = `'{"account":"accounts/1","location":"locations/9","placeId":"ChIJ-gate-fixture-other"}'::jsonb`
  const capabilityRow = (ref, primary) =>
    'insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary) ' +
    `select id, 'gbp_reviews', ${ref}, 'unknown', ${primary} from google_connections ` +
    `where google_sub = '${SUB}'`
  const eventRow = (detail) =>
    'insert into google_connection_events (connection_id, google_sub, event, actor_kind, actor_label, ' +
    `detail) select id, google_sub, 'capability_changed', 'staff', 'gate fixture', ${detail}::jsonb ` +
    `from google_connections where google_sub = '${SUB}'`

  // The write the picker makes, wrapped so the probe fails unless it addressed exactly one row. An update
  // that matched none would otherwise be reported as success by psql, which is the one outcome that would
  // make every assertion in this block vacuous.
  const selectOneRow =
    'do $$ declare touched int; begin ' +
    'update google_capabilities set resource_ref = ' +
    REF +
    ", verified_at = now() where capability = 'gbp_reviews' and is_primary and connection_id = " +
    `(select id from google_connections where google_sub = '${SUB}'); ` +
    'get diagnostics touched = row_count; ' +
    "if touched <> 1 then raise exception 'the selection addressed % rows, not one', touched; end if; " +
    'end $$'

  const psqlProbe = (...statements) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      dbUrl ?? '',
      '-c',
      `begin; ${seed}; ${statements.join('; ')}; rollback;`,
    ])

  if (!dbUrl) {
    check(
      'google capability selection constraints reject their known-bad fixtures',
      false,
      'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
    )
  } else {
    // 28ag. The same resource registered twice under one capability.
    checkRejectedBy(
      'picker gate rejects the same listing registered twice for one capability',
      psqlProbe(capabilityRow(REF, 'true'), capabilityRow(REF, 'false')),
      'google_capability_resource_unique',
    )

    // 28ah. Two resource-less rows — the NULLS NOT DISTINCT half, and the one a reader skips. This is the
    //       state a consent would leave twice if it ran twice, and it is what would make "the primary row
    //       the picker fills" ambiguous before any listing was chosen.
    checkRejectedBy(
      'picker gate rejects two resource-less rows for one capability, nulls not distinct',
      psqlProbe(capabilityRow('null', 'true'), capabilityRow('null', 'false')),
      'google_capability_resource_unique',
    )

    // 28ai. Two primary rows. The selection addresses `where is_primary`, so this is the constraint that
    //       makes that address single-valued.
    checkRejectedBy(
      'picker gate rejects a second primary row for one capability',
      psqlProbe(capabilityRow(REF, 'true'), capabilityRow(OTHER_REF, 'true')),
      'google_capability_one_primary',
    )

    // 28aj. A selection event carrying a token. The tempting debugging line at 2am, refused by constraint
    //       rather than by code review — rows reach query logs, pg_stat_statements, backups and pg-boss
    //       payloads (docs/10 §4).
    checkRejectedBy(
      'picker gate rejects a selection event whose payload carries a token',
      psqlProbe(
        capabilityRow(REF, 'true'),
        eventRow(`'{"capability":"gbp_reviews","accessToken":"ya29.gate-fixture"}'`),
      ),
      'google_connection_events_no_token',
    )

    // The controls. Without them a renamed table or a broken connection string would reject all four probes
    // above and this gate would report four passes while examining nothing.
    //
    // 28ak. A DIFFERENT resource as a second, non-primary row is legitimate: docs/10 §2 models several
    //       locations per account on purpose, and a gate that refused it would be describing a singleton.
    const second = psqlProbe(capabilityRow(REF, 'true'), capabilityRow(OTHER_REF, 'false'))
    check(
      'picker gate accepts a second location under one capability when only one is primary',
      !second.failed,
      `rejected the many-resources shape migration 0016 exists to allow:\n${second.output}`,
    )

    // 28al. The selection write itself, and it must touch exactly one row.
    const selected = psqlProbe(capabilityRow('null', 'true'), selectOneRow)
    check(
      'picker gate accepts the selection write and confirms it addresses exactly one row',
      !selected.failed,
      `the update the picker makes was refused or matched the wrong number of rows:\n${selected.output}`,
    )

    // 28am. The event the picker really writes, with the placeId and the actor and no token key.
    const legitimate = psqlProbe(
      capabilityRow(REF, 'true'),
      eventRow(
        `'{"capability":"gbp_reviews","source":"picker","placeId":"ChIJ-gate-fixture",` +
          `"account":"accounts/1","location":"locations/2","correlationId":"corr-gate-fixture"}'`,
      ),
    )
    check(
      'picker gate accepts the selection event the picker writes, placeId and all',
      !legitimate.failed,
      `the CHECK refused a payload with no token in it:\n${legitimate.output}`,
    )
  }
}

// 28an. (G-CONN-05) The token allow-list did not grow for the picker, and the pin is not vacuous.
//
// The picker is a consumer: it obtains its token from `withGoogle` and never sees a ciphertext, so none of
// the three modules it added may appear on either allow-list. Widening one is the cheapest way to make a
// boundary rule stop meaning anything, and it happens one deliberate exception at a time — G-CONN-04 pinned
// the list for the refresh lock for exactly this reason, and this is the same pin for the three new modules.
//
// The second half is what keeps it honest: the modules are asserted to EXIST. A pin that only checks
// absence passes trivially once the files are deleted or renamed, which is the failure mode of every
// allow-list assertion written the obvious way.
{
  const scanner = readFileSync('scripts/check-google-token-chokepoint.mjs', 'utf8')
  const cruiser = readFileSync('.dependency-cruiser.cjs', 'utf8')
  const allowList = scanner.slice(
    scanner.indexOf('const TOKEN_MODULES'),
    scanner.indexOf('COLUMN_MODULES'),
  )
  const rule = cruiser.slice(
    cruiser.indexOf('google-tokens-only-in-with-google'),
    cruiser.indexOf('dependencyTypesNot', cruiser.indexOf('google-tokens-only-in-with-google')),
  )
  const pickerModules = [
    'packages/google/src/capability-resolver.ts',
    'packages/google/src/adapters/account-management.ts',
    'packages/google/src/adapters/business-information.ts',
    'packages/google/src/adapters/search-console.ts',
  ]
  const named = pickerModules.filter(
    (module) =>
      allowList.includes(module) ||
      allowList.includes(module.replace('packages/google/src/', '')) ||
      rule.includes(module.replace('packages/google/src/', '').replace('.ts', '')),
  )
  check(
    'the Google token allow-list was not widened for the picker',
    allowList.length > 0 && rule.length > 0 && named.length === 0,
    named.length === 0
      ? 'the allow-list or the dependency-cruiser rule could not be read out of source'
      : `${named.join(', ')} appears in a token allow-list. The picker goes through withGoogle and holds ` +
          'no key: if that has changed, move the allow-list deliberately and say so.',
  )
  const missing = pickerModules.filter((module) => {
    try {
      readFileSync(module, 'utf8')
      return false
    } catch {
      return true
    }
  })
  check(
    'the picker modules this pin is about are actually on disk',
    missing.length === 0,
    `absent, so the pin above proved nothing: ${missing.join(', ')}`,
  )
}

// 32. `meta.units_total` is a second count of the units, and a second count is a future disagreement.
//
// It read 206 against a file holding 207 for long enough that nobody could say which number was wrong,
// and nothing noticed: `pnpm progress:check` counted the list and ignored the metadata. The number is
// what a planning figure gets quoted from, so the gate is that the two agree.
{
  const manifest = readFileSync('build/manifest.yaml', 'utf8')
  const declared = /^\s*units_total:\s*(\d+)/m.exec(manifest)?.[1]
  check(
    'the manifest declares a unit total at all',
    declared !== undefined,
    'meta.units_total is gone — the check below cannot fail, which makes it not a check',
  )
  const result = withEditedFile(
    'build/manifest.yaml',
    (text) =>
      text.replace(/^(\s*units_total:\s*)(\d+)/m, (_m, lead, n) => `${lead}${Number(n) + 1}`),
    () => run('python3', ['scripts/progress.py', '--check']),
  )
  checkRejectedBy(
    'progress gate rejects a unit total that disagrees with the units',
    result,
    'units_total',
  )
  // The control: the real file passes. Without it a broken script would satisfy the probe above.
  const real = run('python3', ['scripts/progress.py', '--check'])
  check(
    'progress gate accepts the committed manifest and ledger',
    !real.failed,
    `rejected the committed pair:\n${real.output}`,
  )
}

// 26s. (M-VAT-04) The recurring cost register's constraints, as known-bad fixtures against real
//      PostgreSQL.
//
// The register exists to catch two failures nothing else in the system can see: a cost that stops
// arriving, and a cost that changes. Both become rows here — an expected period, the bill matched to it,
// and the alert raised when one of those is missing or wrong — and every probe below is a way of getting
// one of those rows into a state that would make the register lie about a month.
//
// Every probe asserts the **name of the rule written for it**: a constraint name, or one of the ZR
// SQLSTATEs. A bare non-zero exit is also what a typo in a column name produces, and the rule under test
// would then be dead while this file reported PASS for ever (ADR 0003).
//
// Every probe runs inside `begin; … ; rollback;`, which matters more here than elsewhere:
// `recurring_cost_instance`, `recurring_cost_match` and `recurring_cost_alert` refuse DELETE for every
// role including the owner, so a committed fixture could not be swept up afterwards by anything.
{
  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  // After the provisional opening date (2026-09-01) and inside the frozen clock's month, so a refusal
  // below is the rule under test rather than ZL002 or ZL004.
  const DATE = "'2026-09-18'"
  const TRN = "'000000000000003'"
  const SUPPLIER_A = 'rc-gate-landlord'
  const SUPPLIER_B = 'rc-gate-laundry'
  const COST_A = 'rc-gate-rent'
  const COST_B = 'rc-gate-laundry-cost'

  const supplier = (code) =>
    `insert into supplier (code, legal_name) values ('${code}', 'gate fixture supplier'); ` +
    'insert into supplier_tax_profile (supplier_id, residency, place_of_supply_rule, trn) ' +
    `select supplier_id, 'domestic', 'domestic_uae', ${TRN} from supplier where code = '${code}'`

  /**
   * A recurring cost definition. Every column is spelled out rather than defaulted, because the point of
   * several probes below is that the schema HAS no default for the tolerance or the expectation shape.
   */
  const cost = ({
    code,
    supplierCode = SUPPLIER_A,
    account = "'6010'",
    cadence = "'monthly'",
    first = "'2026-01-01'",
    final = 'null',
    kind = "'fixed'",
    amount = '2100000',
    min = 'null',
    max = 'null',
    tolerance = '0',
  }) =>
    'insert into recurring_cost (code, description, supplier_id, expense_account_code, tax_treatment, ' +
    'cadence, first_due_date, final_due_date, cost_kind, expected_amount_fils, expected_min_fils, ' +
    `expected_max_fils, variance_tolerance_bp) select '${code}', 'Gate fixture cost', supplier_id, ` +
    `${account}, 'standard_recoverable', ${cadence}, ${first}, ${final}, ${kind}, ${amount}, ${min}, ` +
    `${max}, ${tolerance} from supplier where code = '${supplierCode}'`

  /** One expected period, with the expectation snapshotted onto it. */
  const instance = ({
    costCode = COST_A,
    period = "'2026-09'",
    due = "'2026-09-01'",
    kind = "'fixed'",
    amount = '2100000',
    min = 'null',
    max = 'null',
    tolerance = '0',
  }) =>
    'insert into recurring_cost_instance (recurring_cost_id, period_key, due_date, cost_kind, ' +
    'expected_amount_fils, expected_min_fils, expected_max_fils, variance_tolerance_bp) select ' +
    `recurring_cost_id, ${period}, ${due}, ${kind}, ${amount}, ${min}, ${max}, ${tolerance} ` +
    `from recurring_cost where code = '${costCode}'`

  /**
   * A posted bill with its journal entry and one line, so the header agrees with the lines and the
   * deferred totals trigger would accept it too. `number` is distinct per call so a probe is refused by
   * the rule it names rather than by `bill_internal_number_unique`.
   */
  const bill = ({ n, supplierCode = SUPPLIER_A, reference }) => {
    const entryId = `JE-RC-GATE-${n}`
    return [
      'insert into journal_entry (entry_id, entry_date, narrative, source) values ' +
        `('${entryId}', ${DATE}, 'gate fixture recurring bill', 'supplier_bill')`,
      'insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils) values ' +
        `('${entryId}', 1, '6010', 20000, 0), ('${entryId}', 2, '1080', 1000, 0), ` +
        `('${entryId}', 3, '2010', 0, 21000)`,
      'insert into bill (supplier_id, supplier_reference, series_code, period_key, number, ' +
        'display_number, bill_date, due_date, entry_id, net_fils, gross_fils, ' +
        'recoverable_input_vat_fils, received_by) select supplier_id, ' +
        `'${reference}', 'SUPP-BILL', '', ${960000 + n}, 'BILL-RCGATE-${n}', ${DATE}, ${DATE}, ` +
        `'${entryId}', 20000, 21000, 1000, 'gate' from supplier where code = '${supplierCode}'`,
      'insert into bill_line (bill_id, line_no, description, expense_account_code, tax_treatment, ' +
        'vat_rate_bp, net_fils, gross_fils, recoverable_input_vat_fils) select bill_id, 1, ' +
        "'Gate fixture line', '6010', 'standard_recoverable', 500, 20000, 21000, 1000 " +
        `from bill where supplier_reference = '${reference}'`,
    ].join('; ')
  }

  const match = ({ costCode = COST_A, period = "'2026-09'", reference }) =>
    'insert into recurring_cost_match (recurring_cost_id, period_key, bill_id, matched_by) ' +
    `select c.recurring_cost_id, ${period}, b.bill_id, 'gate' from recurring_cost c, bill b ` +
    `where c.code = '${costCode}' and b.supplier_reference = '${reference}'`

  const alert = ({
    costCode = COST_A,
    period = "'2026-09'",
    kind = "'variance_over_tolerance'",
    delta = '1000',
    tolerance = '0',
  }) =>
    'insert into recurring_cost_alert (recurring_cost_id, period_key, alert_kind, delta_fils, ' +
    `tolerance_fils, raised_for_date) select recurring_cost_id, ${period}, ${kind}, ${delta}, ` +
    `${tolerance}, ${DATE} from recurring_cost where code = '${costCode}'`

  // Two suppliers, two costs, three periods and three bills: enough for every probe below to be refused
  // by the rule it names rather than by a missing row.
  const setup = [
    supplier(SUPPLIER_A),
    supplier(SUPPLIER_B),
    cost({ code: COST_A }),
    cost({ code: COST_B, supplierCode: SUPPLIER_B, account: "'6050'", amount: '63000' }),
    instance({}),
    instance({ period: "'2026-10'", due: "'2026-10-01'" }),
    instance({ costCode: COST_B }),
    bill({ n: 1, reference: 'RC-GATE-1' }),
    bill({ n: 2, reference: 'RC-GATE-2' }),
    bill({ n: 3, supplierCode: SUPPLIER_B, reference: 'RC-GATE-3' }),
  ].join('; ')

  const psqlProbe = (statement) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      dbUrl ?? '',
      '-c',
      `begin; ${setup}; ${statement}; rollback;`,
    ])

  /** Reads a value back with the fixtures in place, then rolls them away. */
  const psqlRead = (statement) =>
    run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      dbUrl ?? '',
      '-c',
      `begin; ${setup}; ${statement}; rollback;`,
    ])

  // Written as data so the rule name sits next to the statement that must trip it.
  const probes = [
    {
      name: 'recurring cost gate rejects a variable cost with no expected range',
      rule: 'recurring_cost_variable_needs_an_expected_range',
      // A variable cost moves by design, so a single number would be wrong every period; with no band
      // there is nothing to be inside and nothing is ever normal.
      sql: cost({ code: 'rc-gate-no-range', kind: "'variable'", amount: 'null' }),
    },
    {
      name: 'recurring cost gate rejects a fixed cost with no expected amount',
      rule: 'recurring_cost_fixed_needs_an_expected_amount',
      sql: cost({ code: 'rc-gate-no-amount', amount: 'null' }),
    },
    {
      name: 'recurring cost gate rejects a definition that states both expectation shapes',
      rule: 'recurring_cost_fixed_needs_an_expected_amount',
      // The halfway row is worse than either missing one: whichever non-null column a reader reached for
      // first would decide the variance, and two readers would disagree about the same bill.
      sql: cost({ code: 'rc-gate-both', min: '210000', max: '525000' }),
    },
    {
      name: 'recurring cost gate rejects an inverted expected range',
      rule: 'recurring_cost_range_is_ordered',
      // Every bill is then simultaneously above the maximum and below the minimum, so every period
      // alerts and the alert means nothing.
      sql: cost({
        code: 'rc-gate-inverted',
        kind: "'variable'",
        amount: 'null',
        min: '525000',
        max: '210000',
        tolerance: '500',
      }),
    },
    {
      name: 'recurring cost gate rejects a zero expectation',
      rule: 'recurring_cost_expected_amount_positive',
      // Zero is a missing amount, not a free contract: it forecasts nothing and makes every arriving
      // bill a total variance while the definition still looks complete.
      sql: cost({ code: 'rc-gate-zero', amount: '0' }),
    },
    {
      name: 'recurring cost gate rejects a tolerance that is not a fraction',
      rule: 'recurring_cost_variance_tolerance_bp_check',
      sql: cost({ code: 'rc-gate-tolerance', tolerance: '10001' }),
    },
    {
      name: 'recurring cost gate rejects an anchor whose day is missing from some months',
      rule: 'recurring_cost_anchor_day_is_in_every_month',
      // `date + interval '1 month'` clamps the 31st to the 28th, so such an anchor produces a series
      // whose day of the month wanders and cannot be compared period to period.
      sql: cost({ code: 'rc-gate-anchor', first: "'2026-01-31'" }),
    },
    {
      name: 'recurring cost gate rejects a contract that ends before it starts',
      rule: 'recurring_cost_ends_after_it_starts',
      sql: cost({ code: 'rc-gate-ended', final: "'2025-12-01'" }),
    },
    {
      name: 'recurring cost gate rejects a second expected period for one cost and month',
      rule: 'recurring_cost_instance_one_per_period',
      // The idempotency the nightly pass depends on. Without it a daily cron produces a second September
      // every night, and the missing-cost alert fires for a period that was in fact billed.
      sql: instance({}),
    },
    {
      name: 'recurring cost gate rejects a period whose key disagrees with its due date',
      rule: 'recurring_cost_instance_period_matches_due_date',
      // A generator bug filing October's expectation under September would make the missing-cost alert
      // fire for a month that was billed and stay silent for the one that was not.
      sql: instance({ period: "'2026-11'", due: "'2026-10-01'" }),
    },
    {
      name: 'recurring cost gate rejects a half-filled expectation snapshot',
      rule: 'recurring_cost_instance_variable_needs_an_expected_range',
      // The snapshot is what the variance is actually computed from, so the shape rules are restated on
      // it rather than inherited from the definition.
      sql: instance({
        period: "'2026-12'",
        due: "'2026-12-01'",
        kind: "'variable'",
        amount: 'null',
      }),
    },
    {
      name: 'recurring cost gate rejects a second bill matched to one expected period',
      rule: 'recurring_cost_match_one_per_period',
      sql: [match({ reference: 'RC-GATE-1' }), match({ reference: 'RC-GATE-2' })].join('; '),
    },
    {
      name: 'recurring cost gate rejects one bill satisfying two expected periods',
      rule: 'recurring_cost_match_one_per_bill',
      // Otherwise one invoice could be used to silence two different missing-cost alerts.
      sql: [
        match({ reference: 'RC-GATE-1' }),
        match({ period: "'2026-10'", reference: 'RC-GATE-1' }),
      ].join('; '),
    },
    {
      name: 'recurring cost gate rejects a bill matched to a cost somebody else bills',
      rule: 'MatchedBillFromAnotherSupplier',
      // The mis-keystroke this guard exists for: the laundry invoice matched to the rent reports a large
      // false variance, silences the rent's missing-cost alert and leaves the laundry looking unbilled.
      sql: match({ reference: 'RC-GATE-3' }),
    },
    {
      name: 'recurring cost gate rejects a second alert of the same kind for one period',
      rule: 'recurring_cost_alert_once_per_period_and_kind',
      // This constraint is what makes a daily pass raise once per incident. Without it one unbilled
      // August produces 365 alerts, and the 365th is the one nobody reads.
      sql: [alert({}), alert({})].join('; '),
    },
    {
      name: 'recurring cost gate rejects a missing-cost alert carrying a delta',
      rule: 'recurring_cost_alert_variance_carries_a_delta',
      // Nothing arrived, so there is nothing to differ from. A delta here invites the reader to treat an
      // absence as a difference.
      sql: alert({ kind: "'missing_cost'" }),
    },
    {
      name: 'recurring cost gate rejects a variance alert whose delta is zero',
      rule: 'recurring_cost_alert_variance_delta_is_not_zero',
      sql: alert({ delta: '0' }),
    },
    {
      name: 'recurring cost gate rejects a delta with no tolerance beside it',
      rule: 'recurring_cost_alert_delta_and_tolerance_travel_together',
      // The alert has to explain itself: a difference with no threshold beside it cannot be judged.
      sql: alert({ tolerance: 'null' }),
    },
    {
      name: 'recurring cost gate rejects an UPDATE of an expected period, for the owner too',
      rule: 'recurring_cost_instance is append-only',
      // Re-stating what a period expected would silently rewrite a variance somebody has already been
      // told about.
      sql:
        'update recurring_cost_instance set expected_amount_fils = 9900000 ' +
        "where period_key = '2026-09'",
    },
    {
      name: 'recurring cost gate rejects a DELETE of an alert, for the owner too',
      rule: 'recurring_cost_alert is append-only',
      sql: [alert({}), 'delete from recurring_cost_alert'].join('; '),
    },
    {
      name: 'recurring cost gate rejects a cadence the schedule cannot step',
      rule: 'UnknownRecurringCadence',
      // A SQL `case` with no `else` would return NULL here, and a NULL does not fail: it makes every due
      // date NULL and the cost vanishes from the forecast, which is the failure the register exists for.
      sql: "select recurring_cost_period_months('fortnightly')",
    },
  ]

  if (!dbUrl) {
    check(
      'recurring cost constraints reject their known-bad fixtures',
      false,
      'TEST_DATABASE_URL or DATABASE_URL is required — this gate fails rather than skips',
    )
  } else {
    for (const { name, rule, sql: statement } of probes) {
      checkRejectedBy(name, psqlProbe(statement), rule)
    }

    // The controls, and the reason the twenty-one above mean anything: the same tables accept the
    // legitimate rows. Without these, a broken connection string or a renamed table would reject every
    // probe and this gate would report twenty-one passes while examining nothing.
    const legitimate = psqlProbe(
      [
        cost({
          code: 'rc-gate-good-variable',
          kind: "'variable'",
          amount: 'null',
          min: '210000',
          max: '525000',
          tolerance: '500',
        }),
        instance({
          costCode: 'rc-gate-good-variable',
          kind: "'variable'",
          amount: 'null',
          min: '210000',
          max: '525000',
          tolerance: '500',
        }),
        match({ reference: 'RC-GATE-1' }),
        alert({}),
        alert({ kind: "'missing_cost'", delta: 'null', tolerance: 'null' }),
        'set constraints all immediate',
      ].join('; '),
    )
    check(
      'recurring cost gate accepts a fixed cost, a variable cost, a match and both alert kinds',
      !legitimate.failed,
      `rejected the rows the register writes every night:\n${legitimate.output}`,
    )

    // The variance, read back from the database rather than merely executed: a function that returned the
    // same verdict for every input would satisfy "it ran". Both sides of the boundary — a bill exactly ON
    // the tolerance is within it, and one fils past is not.
    const variance = run('psql', [
      '--no-psqlrc',
      '-At',
      dbUrl,
      '-c',
      "select string_agg(v.delta_fils || ':' || v.tolerance_fils || ':' || v.over_tolerance, ',' " +
        'order by g.gross) ' +
        'from unnest(array[2100000, 2121000, 2121001]::bigint[]) as g(gross) ' +
        "cross join lateral recurring_cost_variance('fixed', 2100000, null, null, 100, g.gross) as v",
    ])
    check(
      'recurring cost gate reads the variance from the database, within and over the same boundary',
      !variance.failed &&
        variance.output.trim() === '0:21000:false,21000:21000:false,21001:21000:true',
      `the variance function did not answer both sides of its tolerance boundary:\n${variance.output}`,
    )

    // And the variable shape, where the expectation is a band and the reference is the edge that was
    // crossed. Inside the band the verdict must be zero, which is what stops a seasonal cost alerting
    // every month.
    const band = run('psql', [
      '--no-psqlrc',
      '-At',
      dbUrl,
      '-c',
      "select string_agg(v.delta_fils || ':' || v.over_tolerance, ',' order by g.gross) " +
        'from unnest(array[210000, 525000, 551250, 551251]::bigint[]) as g(gross) ' +
        "cross join lateral recurring_cost_variance('variable', null, 210000, 525000, 500, g.gross) as v",
    ])
    check(
      'recurring cost gate reads a variable cost as zero variance anywhere inside its band',
      !band.failed && band.output.trim() === '0:false,0:false,26250:false,26251:true',
      `the variance function did not treat the declared band as normal:\n${band.output}`,
    )

    // The forward schedule R-REP consumes, read back: exactly twelve occurrences of a monthly cost over
    // twelve months whatever day of the month it falls on, and the prudent figure for each.
    const schedule = psqlRead(
      "select count(*) || ':' || sum(expected_fils) " +
        "from recurring_cost_forward_schedule('2026-09-18', 12) where code = '" +
        COST_A +
        "'",
    )
    check(
      'recurring cost gate reads twelve monthly occurrences and their total from the forward schedule',
      !schedule.failed && schedule.output.includes('12:25200000'),
      `the forward schedule did not answer twelve periods of the fixture rent:\n${schedule.output}`,
    )

    // And it is computed from the definitions rather than from generated periods, so a forecast cannot
    // quietly shorten to wherever the nightly pass last got to.
    const withoutPeriods = run('psql', [
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      dbUrl,
      '-c',
      'begin; ' +
        supplier('rc-gate-forecast-only') +
        '; ' +
        cost({ code: 'rc-gate-forecast-only', supplierCode: 'rc-gate-forecast-only' }) +
        "; select 'occurrences=' || count(*) from recurring_cost_forward_schedule('2026-09-18', 12) " +
        "where code = 'rc-gate-forecast-only'; rollback;",
    ])
    check(
      'recurring cost gate reads a forecast for a cost with no generated periods at all',
      !withoutPeriods.failed && withoutPeriods.output.includes('occurrences=12'),
      'the forecast depends on the generator having run, so a horizon can silently shorten:\n' +
        withoutPeriods.output,
    )

    // The cron's agent row. `pnpm jobs` refuses a cron with no agent statically; this is the half that
    // needs a database, and without the row the watchdog would never check the pass at all.
    const agent = run('psql', [
      '--no-psqlrc',
      '-At',
      dbUrl,
      '-c',
      "select d.expected_interval_seconds || ':' || (h.agent_key is not null) from agent_definition d " +
        'left join agent_heartbeat h on h.agent_key = d.agent_key ' +
        "where d.agent_key = 'recurring_cost_register'",
    ])
    check(
      'recurring cost gate finds the register agent, with a heartbeat row the watchdog can join to',
      !agent.failed && agent.output.trim() === '86400:true',
      `the recurring_cost_register agent is missing or has no heartbeat: ${agent.output}`,
    )
  }
}

// 29. The CI workflow must actually run every gate. Dropping one here is a silent loss of coverage.
{
  const wf = readFileSync('.github/workflows/ci.yml', 'utf8')
  const required = [
    'pnpm lint',
    'pnpm typecheck',
    'pnpm boundaries',
    'pnpm boundaries:test',
    'pnpm purity',
    'pnpm invisibles',
    // H-HARD-02's four offline supply-chain gates, plus the online audit that runs in CI only. They are
    // registered here because the properties in that unit's block read THIS array: one of them asserts
    // that every `run:` step in the workflow is named here, so a CI step nobody registered fails the
    // build rather than passing unnoticed.
    'pnpm secrets',
    'pnpm deps',
    'pnpm licences',
    'pnpm container',
    'pnpm audit:online',
    'pnpm palette',
    'pnpm tokens',
    'pnpm colours',
    'pnpm cms',
    'pnpm chokepoint',
    'pnpm layout',
    'pnpm jobs',
    'pnpm adr',
    'pnpm progress:check',
    'pnpm media',
    'pnpm fixtures',
    'pnpm fonts',
    'pnpm critique',
    'pnpm a11y',
    'pnpm touch-targets',
    'pnpm coverage',
    'pnpm --filter @berelax/web build',
    'pnpm test:integration',
    'pnpm db:migrate:dry',
    'pnpm db:drift',
    'pnpm db:conventions',
    'pnpm budgets',
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
