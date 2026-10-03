import { readFileSync } from 'node:fs'
import { CUTOVER_STEPS, ROLLBACK_RULES, rollbackRunbookProblems } from '@berelax/core'
import { describe, expect, it } from 'vitest'

/**
 * The cutover and rollback runbooks, parsed rather than trusted. H-MIG-11.
 *
 * `pnpm docs-set`'s runbook checker already holds the front matter, the commands, the paths and the
 * environment variables of every runbook to the repository. What it cannot check is whether a runbook
 * is still ABOUT its subject: the front matter is complete, every path exists, and the one paragraph
 * that mattered is gone. Two claims therefore live here and nowhere else:
 *
 *   1. **The rollback section declares what a rollback cannot undo** — the acceptance line's *"issued
 *      tax invoices and sent messages irreversible"*, plus the audit rows and the erasures that are in
 *      the same section for the same reason.
 *   2. **The cutover runbook covers the sequence the code declares** — every step id in
 *      `CUTOVER_STEPS`, so a step added to the sequence without a word in the document fails here. A
 *      runbook that lists eight of eleven steps reads like a complete procedure.
 *
 * Both are paired with a control over a deliberately broken copy of the document, because both are
 * substring searches and a search over the wrong file finds nothing while reporting passes
 * (ADR 0002, ADR 0003). `rollbackRunbookProblems` takes the TEXT rather than a path for exactly that
 * reason: the same function judges the real document here and the broken one below.
 *
 * It lives in `packages/fixtures` because that is the one package that may import both `@berelax/core`
 * and `@berelax/db` (brief rule 4). It is NOT in `packages/migration`, which deliberately depends on
 * neither `@berelax/core` nor anything that would let it: its own module note says so. And it is not in
 * `packages/core`, which may not read a file at all (`pnpm purity`).
 */

const ROLLBACK_PATH = new URL('../../../docs/runbooks/cutover-rollback.md', import.meta.url)
const CUTOVER_PATH = new URL('../../../docs/runbooks/cutover.md', import.meta.url)
const ROLLBACK = readFileSync(ROLLBACK_PATH, 'utf8')
const CUTOVER = readFileSync(CUTOVER_PATH, 'utf8')

/** Every ATX heading, in document order. */
function headings(markdown: string): readonly string[] {
  return markdown
    .split('\n')
    .map((line) => /^#{1,6}\s+(.*\S)\s*$/.exec(line)?.[1])
    .filter((heading): heading is string => heading !== undefined)
}

describe('the documents are the ones this test is about', () => {
  it('reads two non-empty runbooks with front matter, which is the control for every search below', () => {
    for (const [name, text] of [
      ['cutover-rollback.md', ROLLBACK],
      ['cutover.md', CUTOVER],
    ] as const) {
      expect(text.length, name).toBeGreaterThan(2000)
      expect(text.startsWith('---\n'), name).toBe(true)
      expect(headings(text).length, name).toBeGreaterThan(3)
    }
  })
})

describe('the rollback runbook declares what a rollback cannot undo', () => {
  it('declares all four irreversible subjects', () => {
    expect(rollbackRunbookProblems(ROLLBACK, 'docs/runbooks/cutover-rollback.md')).toEqual([])
  })

  it('states the two the acceptance line names in words, not by implication', () => {
    const lower = ROLLBACK.toLowerCase()
    // Quoted from the document rather than paraphrased, so a reader can check the mapping by eye.
    expect(lower).toContain('issued tax documents')
    expect(lower).toContain('a correction is a credit note')
    expect(lower).toContain('messages that were sent')
    expect(lower).toContain('there is no recall')
  })

  it('puts them in a section of their own, which the cutover runbook sends a reader to', () => {
    expect(headings(ROLLBACK).some((heading) => /what a rollback cannot undo/i.test(heading))).toBe(
      true,
    )
    expect(CUTOVER).toContain('cutover-rollback.md')
  })

  it('fails over a copy with the tax-document paragraph removed — the control', () => {
    const broken = ROLLBACK.replace(/credit note/gi, 'void')
    const problems = rollbackRunbookProblems(broken, 'fixture')
    expect(problems.map((problem) => problem.rule)).toEqual([ROLLBACK_RULES.subjectNotDeclared])
    expect(problems[0]?.detail).toContain('Issued tax documents')
  })

  it('fails over a copy with the no-recall sentence removed, which is the other named half', () => {
    const broken = ROLLBACK.replace(/no recall/gi, 'a recall process')
    expect(rollbackRunbookProblems(broken, 'fixture').map((problem) => problem.rule)).toEqual([
      ROLLBACK_RULES.subjectNotDeclared,
    ])
  })
})

describe('the cutover runbook covers the sequence the code declares', () => {
  it('names every step id in CUTOVER_STEPS', () => {
    const absent = CUTOVER_STEPS.filter((step) => !CUTOVER.includes(step.id))
    // Not a general prose check: the step ids are the strings `scripts/cutover.mjs` prints when it
    // stops, so a reader who has just been told "stopped at stop-the-worker" has to be able to find
    // that string in the document.
    expect(
      absent.map((step) => step.id),
      'a step the sequence declares and the runbook does not mention',
    ).toEqual([])
  })

  it('says which steps are an operator’s and that nothing here performs them', () => {
    const operatorSteps = CUTOVER_STEPS.filter((step) => step.agent === 'operator')
    expect(operatorSteps.length).toBeGreaterThan(0)
    expect(CUTOVER.toLowerCase()).toContain('nothing in this repository can do')
    for (const step of operatorSteps) expect(CUTOVER, step.id).toContain(step.id)
  })

  it('tells a reader that the go/no-go exits non-zero today and why that is correct', () => {
    // The sentence that stops the first reader from treating the refusal as a broken script.
    expect(CUTOVER).toContain('exits non-zero today and is supposed to')
  })

  it('fails over a copy with a step removed — the control for the search above', () => {
    const removed = CUTOVER_STEPS[3]
    expect(removed).toBeDefined()
    const broken = CUTOVER.replaceAll(removed?.id ?? '', 'a-step-nobody-named')
    expect(
      CUTOVER_STEPS.filter((step) => !broken.includes(step.id)).map((step) => step.id),
    ).toEqual([removed?.id])
  })
})
