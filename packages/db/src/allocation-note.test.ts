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

  it('says which number is next free in one place only, in any wording', () => {
    /*
      The first version of this case counted one PHRASING — the note's own opening line — and M-VAT-08 then
      found THREE further next-free claims that it could not see, because they sat inside per-migration
      paragraphs in different words: "88 is the next number nobody holds" buried in the prose for 0083, and
      two more naming 93 and 94. All three were false. A check keyed on how a claim is worded lets the same
      claim through in other words, which is the defect class this repository keeps paying for, one level up
      from the code it was written to guard.

      So this reads for the CLAIM. Every sentence that nominates a next-free number has to be the one in the
      note; anywhere else it is a second statement of a fact that moves every time a migration lands.

      And it requires a NUMBER next to the phrase, which the second version of this case did not. Reading for
      the phrase alone flagged two sentences that say "which number is next free is stated ONCE, in the note"
      — pointers AT the single statement, the opposite of the defect. That is the third check I have written
      today whose claim was wider than the thing it was guarding, after a scoped `delete from customer` read
      as unqualified and a supersede control that supplied one missing column of three. The pattern in all
      three: I wrote what was easy to match instead of what I meant.
    */
    const source = readFileSync(LEDGER, 'utf8')
    const claims = [
      ...source.matchAll(
        // `first` as well as `next`, because the note itself says "100 is the first number nobody holds" and
        // the vacuity floor below caught the pattern matching nothing at all — which is the whole reason that
        // floor is there. A claim is a number beside a phrase nominating one, whichever of the two words it
        // reaches for.
        /\b\d{2,3}\b[^.\n]{0,40}?(?:is the (?:next|first) (?:number|free)|(?:next|first) number nobody holds)|(?:next|first) (?:free number|number nobody holds)[^.\n]{0,40}?\b\d{2,3}\b/gi,
      ),
    ]
    const note = source.indexOf('// Every number allocated through')
    expect(
      note,
      'the allocation note is missing, so there is nothing to measure against',
    ).toBeGreaterThan(-1)
    const noteEnd = source.indexOf('export const SCHEMA_VERSION', note)

    // The whole LINE the claim sits on, with its line number — the first version sliced a fixed window
    // around the match and printed `[ '/' ]`, which told a reader nothing about where to look.
    const lineStarts = [...source.matchAll(/\n/g)].map((m) => m.index ?? 0)
    const lineOf = (at: number): number => lineStarts.filter((start) => start < at).length + 1
    const outside = claims
      .map((match) => match.index ?? 0)
      .filter((at) => at < note || at > noteEnd)
      .map((at) => {
        const from = source.lastIndexOf('\n', at) + 1
        const to = source.indexOf('\n', at)
        return `index.ts:${lineOf(at)}: ${source.slice(from, to === -1 ? undefined : to).trim()}`
      })
    expect(
      outside,
      'a next-free number is nominated outside the single allocation note. Delete it and let the note say ' +
        'it: a per-migration paragraph that names the next free number is true on the day it is written and ' +
        'false the next time anything lands.',
    ).toEqual([])
    expect(
      claims.length,
      'no next-free claim was found at all, so this case measured nothing',
    ).toBeGreaterThan(0)
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
