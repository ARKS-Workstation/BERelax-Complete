#!/usr/bin/env node
/**
 * Every gate in `pnpm verify` is registered in the case that checks CI runs it.
 *
 * `scripts/test-gates.mjs` case 29 holds a hand-maintained list of steps and asserts each appears in
 * `.github/workflows/ci.yml`. Another block asserts the reverse — that every `run:` step in the workflow is
 * named in that list. Neither consults `package.json`, and that is the hole: a gate added to the `verify`
 * chain and to CI but never registered sits OUTSIDE the protection while looking like it is inside it, and
 * could be dropped from CI later with nothing failing. Since stopping exactly that is the case's whole
 * purpose, the gap is worse than an ordinary missing check.
 *
 * There was no live gap when this was written — 36 verify steps, all registered. The point is that there
 * could be one tomorrow and nothing would say so.
 *
 * It is a separate script rather than another case inside `test-gates.mjs` for one practical reason: its own
 * known-bad fixture has to edit `package.json`, and a case inside that file cannot recursively run the file
 * it lives in. A gate whose fixture cannot be written is a gate nobody has seen fail (ADR 0003).
 */
import { readFileSync } from 'node:fs'

const PACKAGE_JSON = 'package.json'
const GATES = 'scripts/test-gates.mjs'

/**
 * Steps CI runs that have no `pnpm verify` entry, and why each one is legitimately absent.
 *
 * Declared rather than inferred: "it is not in verify" is exactly the condition an unregistered gate also
 * satisfies, so an allowance that guessed would let the defect through as an exception.
 */
const CI_ONLY = new Map([
  ['pnpm audit:online', 'reaches the network, so it runs in CI and not in a local verify'],
  [
    'pnpm --filter @berelax/web build',
    'verify does not build the web app; CI does it before the suites',
  ],
  [
    'pnpm db:apply',
    'CI starts from an empty database; a local verify runs against one already migrated',
  ],
  ['pnpm seed', 'the catalogue routes prerender from the database, so CI seeds before the build'],
  ['postgres:16', 'a service container, not a step'],
])

/** The `verify` chain, split on `&&` exactly as the shell would. */
function verifySteps() {
  const scripts = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).scripts
  const verify = scripts?.verify
  if (typeof verify !== 'string' || verify.length === 0) {
    throw new Error(`${PACKAGE_JSON} has no "verify" script for this check to read`)
  }
  return verify
    .split('&&')
    .map((step) => step.trim())
    .filter((step) => step.length > 0)
}

/**
 * The registered steps, read out of case 29's `required` array.
 *
 * Two things this has to get right, and the first version got both wrong.
 *
 * The slice ends at a closing bracket ON ITS OWN LINE, not at the first `]` in the text — the array's
 * comments mention things like `52k-52l` and a bare `indexOf(']')` cut the list off six entries in, which
 * then reported twenty-two registered gates as missing.
 *
 * And the entry pattern is anchored to a whole line. A bare /'([^']+)'/ matches from the apostrophe in
 * "H-HARD-02's" to the next one, so the array's prose became forty extra "entries". An entry is a line
 * that is nothing but a quoted string and a comma; a comment line starts with `//` and cannot match.
 */
function registeredSteps() {
  const text = readFileSync(GATES, 'utf8')
  const anchor = text.indexOf('// 29.')
  if (anchor === -1) throw new Error(`${GATES} has no "// 29." block for this check to read`)
  const open = text.indexOf('const required = [', anchor)
  const close = open === -1 ? -1 : text.indexOf('\n  ]', open)
  if (open === -1 || close === -1) {
    throw new Error(`${GATES} case 29 has no "const required = [...]" array for this check to read`)
  }
  return [...text.slice(open, close).matchAll(/^\s*'([^']+)',\s*$/gm)].map((match) => match[1])
}

function main() {
  const steps = verifySteps()
  const registered = registeredSteps()

  // The controls come first. Every assertion below is over a difference of two lists, and a difference
  // against an empty list is empty — so a parser that silently read nothing would report success.
  const problems = []
  if (steps.length < 20) {
    problems.push(
      `read only ${steps.length} steps from ${PACKAGE_JSON}: the verify chain did not parse`,
    )
  }
  if (registered.length < 20) {
    problems.push(
      `read only ${registered.length} entries from ${GATES} case 29: the array did not parse`,
    )
  }

  for (const step of steps) {
    if (!registered.includes(step)) {
      problems.push(
        `"${step}" is in pnpm verify and is not registered in ${GATES} case 29, so nothing would notice ` +
          'if it were dropped from CI. Add it to that array.',
      )
    }
  }

  for (const entry of registered) {
    if (steps.includes(entry) || CI_ONLY.has(entry)) continue
    problems.push(
      `"${entry}" is registered in ${GATES} case 29 but is neither a pnpm verify step nor a declared ` +
        'CI-only step. Either it was removed from verify and the registration is now dead, or it belongs ' +
        `in CI_ONLY in ${import.meta.url.split('/').pop()} with a reason.`,
    )
  }

  if (problems.length > 0) {
    for (const problem of problems) console.log(`FAIL  ${problem}`)
    console.log(`\n${problems.length} problem(s)`)
    return 1
  }
  console.log(
    `Gate registry holds: ${steps.length} pnpm verify step(s) all registered in ${GATES} case 29, ` +
      `and ${CI_ONLY.size} declared CI-only step(s) accounted for.`,
  )
  return 0
}

process.exit(main())
