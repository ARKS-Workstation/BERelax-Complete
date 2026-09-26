#!/usr/bin/env node
/**
 * Every step of `pnpm verify` except `gates:test`, DERIVED from the verify chain rather than listed.
 *
 * ## Why this exists
 *
 * A unit agent runs the cheap steps and its own gate block instead of the two-hour full gate suite (brief
 * rule 29). The first version of that instruction was a hand-written list of steps in the agent preamble,
 * and a hand-written list is a second statement of what `pnpm verify` runs — so it drifted immediately. It
 * omitted `pnpm secrets`, and a unit shipped a 43-character mixed-case token literal in a test that the
 * credential scanner flags `[high-entropy-assigned-secret]`. The unit's own checks were green, the
 * integrating verify died at step 7 of 38, and the cost was a fresh database, a web build and a run.
 *
 * So the list is read out of `package.json` at run time and there is nothing to keep in step. Adding a
 * step to `verify` adds it here; the only thing this knows on its own is which step is too expensive to
 * run per unit.
 *
 * ## Why it refuses rather than assuming
 *
 * If `gates:test` is not the chain's last step, the assumption behind "run everything else, then your own
 * block" no longer holds — something now runs after the gate suite and would be skipped silently. That is
 * the failure this whole arrangement exists to avoid, so it exits non-zero and says so.
 *
 * usage: node scripts/verify-except-gates.mjs [--print]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const SKIP = 'gates:test'
const chain = JSON.parse(readFileSync('package.json', 'utf8')).scripts?.verify
if (typeof chain !== 'string') {
  console.error('package.json has no `verify` script to read the step list out of.')
  process.exit(2)
}
const steps = chain.split('&&').map((s) => s.trim().replace(/^pnpm\s+/, ''))
if (steps.at(-1) !== SKIP) {
  console.error(
    `\`pnpm verify\` no longer ends with \`${SKIP}\` — its last step is \`${steps.at(-1)}\`. This script ` +
      'runs every step except that one on the assumption it is last, and a step added after it would be ' +
      'skipped without anybody noticing. Fix this script, or move the step.',
  )
  process.exit(2)
}
const run = steps.slice(0, -1)
if (process.argv.includes('--print')) {
  console.log(run.join('\n'))
  process.exit(0)
}
console.log(`${run.length} of ${steps.length} verify steps (everything but \`${SKIP}\`)`)
for (const [index, step] of run.entries()) {
  process.stdout.write(`\n──── ${index + 1}/${run.length}  pnpm ${step}\n`)
  try {
    execFileSync('pnpm', [step], { stdio: 'inherit' })
  } catch {
    console.error(
      `\nFAILED at step ${index + 1} of ${run.length}: \`pnpm ${step}\`. The chain stops here, as ` +
        '`pnpm verify` would.',
    )
    process.exit(1)
  }
}
console.log(
  `\nAll ${run.length} steps passed. \`pnpm ${SKIP}\` was NOT run — run your own gate block with`,
)
console.log(
  "`pnpm gates:only --only '// <n>a' --only '// 79a' --only '// 88.' --only '// 89.' --only '// 90.'`",
)
