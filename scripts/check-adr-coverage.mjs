#!/usr/bin/env node
/**
 * Every locked decision must be recorded in an ADR, and every ADR must point at real decisions.
 *
 * `docs/01` is a table of decisions with a one-line rationale. That is the right shape for reading
 * the whole set at a glance and the wrong shape for the argument behind any one of them — a table
 * cell cannot hold the alternative that was rejected, or the consequence that will be felt in two
 * years by someone who was not here. The ADRs hold that, and this gate is what stops the two from
 * diverging: adding a row to the table without writing the record fails the build.
 *
 * It runs both ways on purpose. An ADR claiming to cover decision 47 when the table stops at 31 is
 * the same class of rot, arriving from the other direction.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DECISIONS_DOC = 'docs/01-scope-and-decisions.md'
const ADR_DIR = 'docs/adr'

/** Table rows look like: `| 19b | Prepaid products | … | … |`. Ids are numbers, sometimes suffixed. */
const DECISION_ROW = /^\|\s*(\d+[a-z]?)\s*\|\s*([^|]+?)\s*\|/
const COVERS_LINE = /^- \*\*Covers:\*\*\s*(.+)$/m

/** `0007-money-and-business-day-primitives.md`. The index is not one of these. */
const NUMBERED_RECORD = /^\d{4}-.+\.md$/

function lockedDecisions() {
  const text = readFileSync(DECISIONS_DOC, 'utf8')
  const found = new Map()
  let inTable = false
  for (const line of text.split('\n')) {
    // The decisions table is the one whose header names a Decision column.
    if (/^\|\s*#\s*\|/.test(line)) inTable = true
    else if (inTable && !line.startsWith('|')) inTable = false
    if (!inTable) continue
    const match = DECISION_ROW.exec(line)
    if (match?.[1] === undefined || match[1] === '#') continue
    found.set(match[1], match[2] ?? '')
  }
  return found
}

function adrCoverage() {
  const covered = new Map()
  // Only numbered records. README.md is the index, not a decision.
  const files = readdirSync(ADR_DIR)
    .filter((name) => NUMBERED_RECORD.test(name))
    .sort()
  const problems = []
  for (const name of files) {
    const text = readFileSync(join(ADR_DIR, name), 'utf8')
    const match = COVERS_LINE.exec(text)
    if (match?.[1] === undefined) {
      problems.push(`${ADR_DIR}/${name} has no "- **Covers:**" line`)
      continue
    }
    const value = match[1]
    if (value.includes('none')) continue
    const ids = [...value.matchAll(/\b(\d+[a-z]?)\b/g)].map((m) => m[1]).filter((id) => id !== '01')
    if (ids.length === 0) {
      problems.push(`${ADR_DIR}/${name} lists no decision and does not say "none"`)
      continue
    }
    for (const id of ids) {
      const existing = covered.get(id)
      covered.set(id, existing === undefined ? [name] : [...existing, name])
    }
  }
  return { covered, problems, count: files.length }
}

const decisions = lockedDecisions()
const { covered, problems, count } = adrCoverage()

for (const [id] of covered) {
  if (!decisions.has(id)) {
    problems.push(
      `ADR(s) ${covered.get(id)?.join(', ')} cover decision ${id}, which ${DECISIONS_DOC} does not list`,
    )
  }
}

const uncovered = [...decisions.keys()].filter((id) => !covered.has(id))
for (const id of uncovered) {
  problems.push(`decision ${id} (${decisions.get(id)}) has no ADR`)
}

// The index is a document like any other, so it rots like any other.
const index = readFileSync(join(ADR_DIR, 'README.md'), 'utf8')
for (const name of readdirSync(ADR_DIR).filter((entry) => NUMBERED_RECORD.test(entry))) {
  if (!index.includes(`(${name})`)) {
    problems.push(`docs/adr/README.md does not link ${name}`)
  }
}

if (problems.length > 0) {
  console.error('ADR coverage problems:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    `\n${problems.length} problem(s). Every locked decision needs a record of why, not just a ` +
      'table cell saying what.',
  )
  process.exit(1)
}

console.log(`${count} ADRs cover all ${decisions.size} locked decisions in ${DECISIONS_DOC}.`)
