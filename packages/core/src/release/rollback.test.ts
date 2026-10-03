import { describe, expect, it } from 'vitest'
import {
  IRREVERSIBLE_SECTION_PHRASE,
  IRREVERSIBLE_SUBJECTS,
  ROLLBACK_RULES,
  rollbackRunbookProblems,
} from './rollback.ts'

/**
 * The rule that holds a rollback runbook to declaring what a rollback cannot undo.
 *
 * Every assertion here is paired with its control, because the check is a set of substring searches and
 * a search over the wrong document finds nothing — which is four passes while examining nothing
 * (ADR 0002, ADR 0003). The real document is asserted against this same function in
 * `packages/migration/src/cutover-runbook.test.ts`; what is proved here is that the function can FAIL.
 */

/** A minimal document that satisfies every subject. The control for every refusal below. */
const COMPLETE = `
# Runbook — rollback

## What a rollback cannot undo

- Issued tax document: an invoice and a credit note are append-only with a sequence behind them. A
  correction is a credit note.
- Messages that were sent reached a real person. There is no recall.
- Audit rows are append-only and survive the decision to stop.
- A customer we erase here is erased here.
`

const rules = (markdown: string): readonly string[] =>
  rollbackRunbookProblems(markdown, 'fixture').map((problem) => problem.rule)

describe('the declared subjects', () => {
  it('names the four, each with words a document must contain and a reason to print', () => {
    expect(IRREVERSIBLE_SUBJECTS.map((subject) => subject.id)).toEqual([
      'issued-tax-documents',
      'sent-messages',
      'audit-rows',
      'erasures',
    ])
    for (const subject of IRREVERSIBLE_SUBJECTS) {
      expect(subject.phrases.length, subject.id).toBeGreaterThan(0)
      expect(subject.why.length, subject.id).toBeGreaterThan(40)
      for (const phrase of subject.phrases) {
        // Lower-cased, because the comparison lower-cases the document and not the phrase. A capital
        // here would make that subject unmatchable and the check would fire on a correct runbook.
        expect(phrase, subject.id).toBe(phrase.toLowerCase())
      }
    }
  })
})

describe('the runbook rule', () => {
  it('accepts a document that declares all four', () => {
    expect(rules(COMPLETE)).toEqual([])
  })

  it('refuses a document with no irreversible section at all — the floor', () => {
    const problems = rollbackRunbookProblems('# Runbook\n\nSome prose.\n', 'fixture')
    expect(problems.map((problem) => problem.rule)).toEqual([ROLLBACK_RULES.sectionMissing])
    expect(problems[0]?.detail).toContain(IRREVERSIBLE_SECTION_PHRASE)
  })

  it('refuses each subject individually when its words go, naming that subject and no other', () => {
    // One removal per subject, because a check that only ever saw all four missing at once would pass
    // over a document that had lost exactly one — which is how this document set rots: the remaining
    // three read like a complete list.
    for (const subject of IRREVERSIBLE_SUBJECTS) {
      const phrase = subject.phrases[0] ?? ''
      const broken = COMPLETE.replace(new RegExp(phrase, 'gi'), 'something else')
      const problems = rollbackRunbookProblems(broken, 'fixture')
      expect(
        problems.map((problem) => problem.rule),
        subject.id,
      ).toEqual([ROLLBACK_RULES.subjectNotDeclared])
      expect(problems[0]?.detail, subject.id).toContain(subject.label)
      expect(problems[0]?.detail, subject.id).toContain(phrase)
    }
  })

  it('requires EVERY phrase of a subject, not just one of them', () => {
    // `invoice` alone appears in any sentence about issuing one, so the tax-document subject needs the
    // credit note and the append-only claim too: a section rewritten to say an invoice can be voided
    // would otherwise still match.
    const broken = COMPLETE.replace(/credit note/gi, 'void')
    expect(rules(broken)).toEqual([ROLLBACK_RULES.subjectNotDeclared])
  })

  it('is case-insensitive about the document, which is prose somebody edits', () => {
    expect(rules(COMPLETE.toUpperCase())).toEqual([])
  })
})
