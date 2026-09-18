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
