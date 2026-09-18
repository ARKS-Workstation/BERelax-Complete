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
  writeFileSync(path, contents.endsWith('\n') ? contents : `${contents}\n`)
  try {
    return body()
  } finally {
    rmSync(path, { force: true })
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
    'pnpm palette',
    'pnpm tokens',
    'pnpm colours',
    'pnpm jobs',
    'pnpm adr',
    'pnpm progress:check',
    'pnpm media',
    'pnpm fixtures',
    'pnpm fonts',
    'pnpm critique',
    'pnpm a11y',
    'pnpm coverage',
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
