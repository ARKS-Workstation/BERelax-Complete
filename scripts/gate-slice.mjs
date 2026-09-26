#!/usr/bin/env node
/**
 * Run a SUBSET of `scripts/test-gates.mjs`: its preamble plus the named top-level blocks.
 *
 * ## Why this exists
 *
 * `pnpm gates:test` takes about two hours and spawns roughly 1,250 nested `vitest`, `tsc` and
 * `depcruise` children. A batch of five units used to pay for that six times — once per unit agent, to
 * re-prove 1,200 cases about other people's units, and once at the integrating merge, which is the only
 * run that can see whether the units compose. This runs one unit's own block plus the harness blocks, so
 * an agent's loop is minutes instead of hours; `pnpm verify` still runs the whole suite and is still the
 * only arbiter for an integrated tree.
 *
 * ## Why it slices the real file rather than keeping a copy
 *
 * Every hand-copied subset written during this build drifted from `scripts/test-gates.mjs` the moment the
 * real file changed, and a subset that has drifted is a check that measures something other than what it
 * claims — the defect this whole suite exists to catch. So the preamble and the blocks are read out of the
 * committed file on every run and nothing is stored.
 *
 * ## Why it refuses rather than running nothing
 *
 * A selector is a way to run FEWER cases, so the failure mode it introduces is running zero of them and
 * reporting success (ADR 0002). Every prefix must match exactly one block opening: a name that matches
 * none, or more than one, exits non-zero and says which. CI never passes `--only`, and gate case 3c
 * asserts that a name matching nothing is refused.
 *
 * usage: node scripts/gate-slice.mjs --only '// 92.' [--only '// 89.'] [--keep]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GATES = 'scripts/test-gates.mjs'
/** A top-level block opening: a line-initial comment naming its case number. */
const OPENING = /^\/\/ \d+[a-z]?[.-]/

const prefixes = []
let keep = false
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i]
  if (arg === '--keep') {
    keep = true
  } else if (arg === '--only') {
    const value = process.argv[i + 1]
    if (value === undefined) {
      console.error('--only needs a block opening, for example: --only "// 92."')
      process.exit(2)
    }
    prefixes.push(value)
    i += 1
  } else if (arg.startsWith('--only=')) {
    prefixes.push(...arg.slice('--only='.length).split(',').filter(Boolean))
  } else {
    console.error(`unknown argument ${arg}. usage: node ${process.argv[1]} --only '// 92.'`)
    process.exit(2)
  }
}
if (prefixes.length === 0) {
  console.error(
    `no --only given. This runs a SUBSET of ${GATES}; to run all of it use \`pnpm gates:test\`, which ` +
      'is what CI and `pnpm verify` run.',
  )
  process.exit(2)
}

const lines = readFileSync(GATES, 'utf8').split('\n')
const openings = lines.flatMap((line, index) => (OPENING.test(line) ? [index] : []))
if (openings.length === 0) {
  console.error(`${GATES} has no numbered block openings, so the slicer cannot address anything.`)
  process.exit(2)
}

const picked = []
for (const prefix of prefixes) {
  const matches = openings.filter((index) => lines[index].startsWith(prefix))
  if (matches.length !== 1) {
    const near = openings
      .map((index) => lines[index].slice(0, 60))
      .filter((text) => text.includes(prefix.replace(/^\/\/ /, '').replace(/[.-]$/, '')))
      .slice(0, 6)
    console.error(
      `--only ${JSON.stringify(prefix)} matched ${matches.length} block openings in ${GATES}, and it ` +
        'has to match exactly one: a selector that matches nothing would run nothing and exit 0, which ' +
        'is a gate suite reporting success over an empty set.' +
        (near.length > 0 ? `\nDid you mean one of:\n  ${near.join('\n  ')}` : ''),
    )
    process.exit(2)
  }
  const start = matches[0]
  const end = openings.find((index) => index > start) ?? lines.length
  picked.push({ prefix, body: lines.slice(start, end) })
}

const dir = mkdtempSync(join(tmpdir(), 'gate-slice-'))
// Named so a process list can SEE it. The commit guard that decides whether a worktree is safe to commit
// matches `scripts/test-gates.mjs` as an argv element, and a slice used to run as `<tmp>/slice.mjs` — so
// the guard reported "no gate run live" while a slice was mutating tracked files, which is precisely the
// state it exists to refuse. It cost a contaminated control and a mutation left in a shipped file.
const out = join(dir, 'gate-slice-run.mjs')
const preamble = lines.slice(0, openings[0])
writeFileSync(
  out,
  [
    ...preamble,
    ...picked.flatMap((p) => p.body),
    '',
    'process.exit(failures === 0 ? 0 : 1)',
    '',
  ].join('\n'),
)
console.log(
  `running ${picked.length} block(s) of ${GATES}: ` +
    picked.map((p) => `${p.prefix.trim()} (${p.body.length} lines)`).join(', '),
)
try {
  execFileSync(process.execPath, [out], { stdio: 'inherit' })
} catch {
  if (!keep) rmSync(dir, { recursive: true, force: true })
  process.exit(1)
}
if (keep) console.log(`slice kept at ${out}`)
else rmSync(dir, { recursive: true, force: true })
