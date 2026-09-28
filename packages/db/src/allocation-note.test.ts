import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The migration ledger states which numbers are held EXACTLY ONCE.
 *
 * ## The defect, four times in one day
 *
 * `packages/db/src/index.ts` carries a paragraph per migration and, at the end, one note saying which numbers
 * have landed, which are held by units in flight, and which is next. Every unit branches with that note in its
 * tree and comes back having edited it, so every merge conflicts on it — and the safe-looking resolution,
 * keeping both sides, silently doubles it. At one point six copies existed, four of them describing held
 * numbers that had landed weeks of work earlier. The stalest of them named 83 as the next free number four
 * merges after 83 was applied.
 *
 * It is the drift this file's own rule is about: a second statement of a fact is a statement that will
 * disagree with the first. Collapsing them by hand four times was the evidence that a rule nothing checks
 * gets broken again, so this is the check.
 *
 * ## Why the shape rather than the content
 *
 * This case does NOT verify that the note is accurate — gate case 90a already walks the migrations that exist
 * on disk, which is the mechanical check on the numbers, and a second implementation of that walk here would
 * be one more thing to drift. What nothing checked is that there is one note at all. So: exactly one opening,
 * and the file's `SCHEMA_VERSION` agrees with the highest migration on disk, which is the one figure a merge
 * can get wrong by taking the lower side.
 */
const LEDGER = join('packages', 'db', 'src', 'index.ts')
const MIGRATIONS = join('packages', 'db', 'migrations')

describe('the migration ledger', () => {
  it('states the held numbers exactly once, however many branches edited it', () => {
    const source = readFileSync(LEDGER, 'utf8')
    const openings = source.match(/^\/\/ Every number allocated through /gm) ?? []
    expect(
      openings.length,
      'the allocation note is duplicated or gone. A merge that hits this paragraph must EDIT the one note, ' +
        'not keep both sides — keeping both is how six copies came to exist, four of them describing ' +
        'numbers that had already landed. If the wording changed, change this pattern with it in the same ' +
        'commit rather than letting the check go quiet.',
    ).toBe(1)
  })

  it('carries a SCHEMA_VERSION equal to the highest migration on disk', async () => {
    const { readdirSync } = await import('node:fs')
    const numbers = readdirSync(MIGRATIONS)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => Number.parseInt(file.slice(0, 4), 10))
      .filter((n) => Number.isFinite(n))
    expect(
      numbers.length,
      'no migrations were read, so this case is measuring nothing',
    ).toBeGreaterThan(50)
    const highest = Math.max(...numbers)

    const declared = /export const SCHEMA_VERSION = (\d+) as const/.exec(
      readFileSync(LEDGER, 'utf8'),
    )
    expect(
      declared,
      'SCHEMA_VERSION is no longer declared in the shape this case reads',
    ).not.toBeNull()
    expect(
      Number(declared?.[1]),
      'SCHEMA_VERSION disagrees with the highest migration on disk. On a merge this means the LOWER side ' +
        'was taken — the branch that had not seen the newer migration — which is the one way this constant ' +
        'goes backwards.',
    ).toBe(highest)
  })
})
