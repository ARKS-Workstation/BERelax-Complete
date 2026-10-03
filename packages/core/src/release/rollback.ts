/**
 * What a rollback cannot undo, as DATA, and the rule that holds the runbook to saying so.
 *
 * H-MIG-11. The acceptance line is *"a content test asserts the rollback section declares issued tax
 * invoices and sent messages irreversible"*, and the four subjects below are stated here once so that
 * two readers can be held to them: `packages/migration/src/cutover-runbook.test.ts`, which asserts the
 * document declares each one, and `scripts/rollback.mjs`, which PRINTS them to whoever is about to roll
 * back and refuses to run if the document has stopped declaring one.
 *
 * ## Why the list is here and the prose is in the runbook
 *
 * The two halves are different artefacts. What a rollback cannot undo is a fact about this system's
 * design — append-only tax documents with a gap-free sequence behind them (ADR 0023), an outbox that
 * reached a real person, append-only audit rows (ADR 0008), an erasure that was an erasure — and it has
 * to be checkable. How to explain that to somebody at 8pm on a Friday is prose, and prose does not
 * belong in a TypeScript array.
 *
 * So each subject carries the WORDS the document must contain rather than the sentence it must be. A
 * runbook is allowed to phrase a warning differently; it is not allowed to drop one, and the failure
 * mode of this whole document set is quiet — the remaining three read like a complete list.
 */

/** Rule names, printed verbatim by the script so a gate case can assert the rule (ADR 0003). */
export const ROLLBACK_RULES = {
  runbookMissing: 'rollback-runbook-missing',
  /** A subject the rollback section no longer declares. */
  subjectNotDeclared: 'rollback-runbook-does-not-declare-an-irreversible-subject',
  /** No section about irreversibility at all: every subject check below would then be about nothing. */
  sectionMissing: 'rollback-runbook-has-no-irreversible-section',
  /** The export script's own claim: it issues nothing but SELECTs. */
  tableChanged: 'rollback-export-changed-a-table',
} as const

export interface IrreversibleSubject {
  readonly id: string
  readonly label: string
  /** Why it cannot be undone, in one sentence, for the script's output. */
  readonly why: string
  /**
   * Phrases the rollback section must contain, each lower-cased for the comparison.
   *
   * Several per subject, and ALL of them required: one word would keep matching a section rewritten to
   * say something else, which is the vacuity this check exists to refuse. `invoice` alone appears in a
   * sentence about issuing one.
   */
  readonly phrases: readonly string[]
}

/**
 * The four, in the order the runbook states them.
 *
 * Two are the acceptance line's own — issued tax documents and sent messages — and the other two are in
 * the same section for the same reason, so a check that covered only the two named would pass over a
 * section that had lost the other half of its subject.
 */
export const IRREVERSIBLE_SUBJECTS: readonly IrreversibleSubject[] = Object.freeze([
  Object.freeze({
    id: 'issued-tax-documents',
    label: 'Issued tax documents',
    why:
      'an invoice and a credit note are append-only with a gap-free sequence behind them. A document ' +
      'issued from this system exists, is numbered, and is the business’s record whatever the ' +
      'business does next. A correction is a credit note, not a withdrawal.',
    phrases: Object.freeze(['tax document', 'credit note', 'append-only']),
  }),
  Object.freeze({
    id: 'sent-messages',
    label: 'Messages that were sent',
    why: 'anything the outbox published reached a real person. There is no recall.',
    phrases: Object.freeze(['sent', 'no recall']),
  }),
  Object.freeze({
    id: 'audit-rows',
    label: 'Audit rows',
    why:
      'append-only by design, and that is the point: the record of what this system did while it was ' +
      'in use survives the decision to stop using it.',
    phrases: Object.freeze(['audit rows']),
  }),
  Object.freeze({
    id: 'erasures',
    label: 'Erasures',
    why:
      'a customer erased in this system was erased here, and a restore brings erased data back — ' +
      'which is a separate decision with its own obligations.',
    phrases: Object.freeze(['erase']),
  }),
])

/** The heading the section must have, matched case-insensitively on its words. */
export const IRREVERSIBLE_SECTION_PHRASE = 'what a rollback cannot undo'

export interface RollbackProblem {
  readonly rule: string
  readonly detail: string
}

/**
 * Every subject the rollback runbook has stopped declaring.
 *
 * Takes the document's text rather than reading a file, so `packages/core` stays pure and the SAME
 * function judges the real runbook (from the script) and a deliberately broken copy of it (from the
 * test). Without the second, a matcher that silently matched nothing would report four passes while
 * examining nothing (ADR 0002, ADR 0003).
 */
export function rollbackRunbookProblems(
  markdown: string,
  where: string,
): readonly RollbackProblem[] {
  const problems: RollbackProblem[] = []
  const lower = markdown.toLowerCase()
  if (!lower.includes(IRREVERSIBLE_SECTION_PHRASE)) {
    // The floor. Every subject check below is a substring search over this document, and a search over
    // the wrong document, or over one whose section has gone, would find the phrases scattered in prose
    // about something else.
    problems.push({
      rule: ROLLBACK_RULES.sectionMissing,
      detail:
        `${where} has no section headed "${IRREVERSIBLE_SECTION_PHRASE}". The four subjects below are ` +
        'then matched against whatever prose happens to be in the document, which is not the same claim',
    })
    return problems
  }
  for (const subject of IRREVERSIBLE_SUBJECTS) {
    const absent = subject.phrases.filter((phrase) => !lower.includes(phrase))
    if (absent.length > 0) {
      problems.push({
        rule: ROLLBACK_RULES.subjectNotDeclared,
        detail:
          `${where} no longer declares "${subject.label}": the phrase(s) ` +
          `[${absent.join(', ')}] are not in it. ${subject.why} The sentence around the gap still ` +
          'reads correctly, which is why nothing else would notice',
      })
    }
  }
  return problems
}
