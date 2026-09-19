import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DOCUMENTED_ROW_SUBJECT,
  DOCUMENTED_ROWS,
  REVIEW_ESCALATION_CATEGORIES,
  REVIEW_ROUTING_ROWS,
  REVIEW_ROUTING_RULES,
  REVIEW_ROUTING_VERDICTS,
} from '@berelax/core'
import { schema } from '@berelax/db'
import { describe, expect, it } from 'vitest'

/**
 * G-REV-03 — the routing table against the document it implements, and the two vocabularies against
 * each other.
 *
 * ## Why this test is here and not in `packages/core`
 *
 * It reads a file and it imports both `@berelax/core` and `@berelax/db`. `packages/core` may do neither —
 * the purity gate forbids `node:fs` there, and the dependency direction is core ← db — so
 * `packages/fixtures` is the only package permitted to hold the pair. That is the same reason
 * `therapist-eligibility.itest.ts` lives here.
 *
 * ## What it proves that a test inside core cannot
 *
 * 1. **The row count.** The acceptance criterion is that the number of cases implemented equals the number
 *    of rows in the docs/07 §4 table, "so a row cannot be silently dropped". The only way to assert that
 *    is to read the table. A constant `4` in a test beside a constant `4` in a module is two typists
 *    agreeing.
 * 2. **The subject of each row**, verbatim. A row reworded in the document to mean something else — "3–5
 *    star" for "4–5 star" — is a change to a safety control, and it fails here rather than being noticed
 *    by whoever reads the file next.
 * 3. **The seven categories**, parsed out of row 3's own cell rather than retyped, so the lexicon's
 *    category list and the document's list cannot drift.
 * 4. **The verdict vocabulary**, which `packages/core` and `packages/db` each spell once because neither
 *    may import the other. Two hand-kept lists of one vocabulary, held together the way
 *    `EXCLUSION_REASONS` and `ELIGIBILITY_EXCLUSION_REASONS` are.
 */

/** Relative to this file, so the test does not depend on the working directory a runner chose. */
const DOC = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'docs',
  '07-frontend-and-agents-requirements.md',
)

/** The header that identifies the safety routing table, and nothing else in the document. */
const TABLE_HEADER = '| Review | Handling |'

/** One parsed row: the two cells, trimmed. */
interface DocRow {
  readonly review: string
  readonly handling: string
}

/**
 * The rows of the docs/07 §4 safety routing table.
 *
 * Found by its header rather than by a section heading and a row offset: a paragraph inserted above the
 * table would silently shift an offset, and the failure would look like a reworded cell.
 */
function safetyRoutingRows(): readonly DocRow[] {
  const lines = readFileSync(DOC, 'utf8').split('\n')
  const header = lines.findIndex((line) => line.trim() === TABLE_HEADER)
  if (header === -1) {
    throw new Error(
      `${DOC} no longer contains the safety routing table header "${TABLE_HEADER}". ` +
        'Every assertion in this file would otherwise be vacuous, so this is an error rather than an ' +
        'empty result.',
    )
  }
  const rows: DocRow[] = []
  // The separator row is `|---|---|`; data rows follow until the first line that is not a table row.
  for (const line of lines.slice(header + 2)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) break
    const cells = trimmed.split('|').slice(1, -1)
    if (cells.length !== 2) break
    rows.push({ review: (cells[0] ?? '').trim(), handling: (cells[1] ?? '').trim() })
  }
  return rows
}

describe('acceptance — table completeness against docs/07 §4', () => {
  it('finds the table, and finds rows in it', () => {
    // The control on the parser. A parser that returned nothing would satisfy every "no row is wrong"
    // assertion below, which is the shape of ADR 0002's green tick on zero modules.
    const rows = safetyRoutingRows()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.review.length, row.review).toBeGreaterThan(5)
      expect(row.handling.length, row.review).toBeGreaterThan(10)
    }
  })

  it('implements exactly as many documented rows as the table has', () => {
    expect(DOCUMENTED_ROWS).toHaveLength(safetyRoutingRows().length)
  })

  it('names each row by the subject the document gives it, in order', () => {
    const rows = safetyRoutingRows()
    DOCUMENTED_ROWS.forEach((id, index) => {
      expect(rows[index]?.review, `row ${id}`).toBe(DOCUMENTED_ROW_SUBJECT[id])
    })
  })

  it('implements every documented row with at least one rule, and no rule with no row', () => {
    const rows = safetyRoutingRows()
    for (const id of DOCUMENTED_ROWS) {
      const implementing = REVIEW_ROUTING_RULES.filter(
        (rule) => REVIEW_ROUTING_ROWS[rule].documentedRow === id,
      )
      expect(implementing.length, `docs row ${id}: ${rows[id - 1]?.review ?? ''}`).toBeGreaterThan(
        0,
      )
    }
    // And nothing claims a row the document does not have.
    for (const rule of REVIEW_ROUTING_RULES) {
      const id = REVIEW_ROUTING_ROWS[rule].documentedRow
      if (id !== null) expect(DOCUMENTED_ROWS, rule).toContain(id)
    }
  })

  it('reads the handling of each row and checks the verdict it implies', () => {
    const rows = safetyRoutingRows()
    // Row 1 is the only one whose handling permits a send, and the document says so twice — "May
    // auto-send" and "Default off". Both are asserted, because the second is the sentence that makes the
    // setting's default a documented requirement rather than a choice.
    expect(rows[0]?.handling).toContain('May auto-send')
    expect(rows[0]?.handling).toContain('Default off')
    expect(rows[0]?.handling).toContain('only in API mode')
    expect(rows[0]?.handling).toContain('cooling-off delay')

    // Rows 2, 3 and 4 all say escalate, and every rule implementing them says escalate too.
    expect(rows[1]?.handling).toContain('Never auto-sent')
    for (const index of [1, 2, 3]) {
      expect(rows[index]?.handling, `row ${index + 1}`).toContain('escalated')
      const id = DOCUMENTED_ROWS[index]
      const implementing = REVIEW_ROUTING_RULES.filter(
        (rule) => REVIEW_ROUTING_ROWS[rule].documentedRow === id,
      )
      for (const rule of implementing) {
        expect(REVIEW_ROUTING_ROWS[rule].verdict, rule).toBe('escalate')
      }
    }
  })

  it('takes the seven escalation categories from row 3 rather than retyping them', () => {
    const cell = safetyRoutingRows()[2]?.review ?? ''
    expect(cell).toContain('Any mention of')
    // "injury, illness, pain, staff conduct, refunds, hygiene, or legal threat" -> seven snake_case names.
    const listed = cell
      .replace(/^Any mention of\s*/, '')
      // The Oxford-comma branch first: ", or " must be one separator, or the last item parses as
      // "or legal threat" and the assertion below fails on a word the document never wrote.
      .split(/,\s*or\s+|,\s*|\s+or\s+/)
      .map((part) => part.trim().toLowerCase().replace(/\s+/g, '_'))
      .filter((part) => part.length > 0)
      // The document writes the plural; the category is singular, because a row carries one of them.
      .map((part) => (part === 'refunds' ? 'refund' : part))
    expect(listed).toHaveLength(7)
    expect([...REVIEW_ESCALATION_CATEGORIES]).toEqual(listed)
  })
})

describe('acceptance — the verdict vocabulary is one vocabulary in two packages', () => {
  it('agrees between packages/core and packages/db', () => {
    // `packages/db` may not import `packages/core`, so these are two hand-kept lists. A value on one side
    // only is a verdict the database refuses and the router emits, or the reverse — either way a review
    // that cannot be recorded, discovered at a write rather than at a typecheck.
    expect([...schema.REVIEW_ROUTING_VERDICTS]).toEqual([...REVIEW_ROUTING_VERDICTS])
  })

  it('has exactly two members, and the permissive one is named the same on both sides', () => {
    expect(REVIEW_ROUTING_VERDICTS).toHaveLength(2)
    expect(schema.REVIEW_ROUTING_VERDICTS).toContain('auto_send')
    expect(schema.REVIEW_ROUTING_VERDICTS).toContain('escalate')
  })
})
