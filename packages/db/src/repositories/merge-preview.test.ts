import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mergeCustomers } from './merge.ts'
import { MERGE_UNDER_PREVIEW, previewCustomerMerge } from './merge-preview.ts'

/**
 * The two structural claims C-CRM-06's preview rests on, checked without a database.
 *
 * Both are about the SOURCE rather than about behaviour, and that is the point. A preview that agrees with
 * the merge today is exactly what a preview that has drifted also looks like from the outside, so the
 * agreement is asserted as an identity — the same function object — and the separation that keeps the
 * preview from writing is asserted as the absence of any write in this module.
 *
 * `packages/fixtures/src/merge-preview.itest.ts` is where the behaviour is proved against real PostgreSQL:
 * that the merge really happens inside the preview's transaction, and that nothing survives it.
 */

const READ = (file: string): string => readFileSync(new URL(file, import.meta.url), 'utf8')

/**
 * A SQL write statement, in the spellings this repository writes them.
 *
 * Statements and not words: this module's own header explains that 0069 "inserts `merge_record` before it
 * moves a row", and a scan for the word `insert` would match that sentence and report a defect in a
 * comment. `insert into`, `update … set` and `delete from` are the three forms a postgres.js template can
 * carry, and `merge.ts` and `crm.ts` together are the control that proves the pattern matches something —
 * two files, because `merge.ts` deliberately deletes nothing.
 */
const WRITE_STATEMENTS = [
  /\binsert\s+into\b/i,
  /\bupdate\s+[a-z_][a-z0-9_]*\s+set\b/i,
  /\bdelete\s+from\b/i,
] as const

describe('the preview runs the merge itself', () => {
  it('names the merge function BY REFERENCE, not by a copy of it', () => {
    // The assertion this unit turns on. A bespoke "what the merge would do" function would pass every
    // behavioural test the day it was written and diverge on the first change to either side.
    expect(MERGE_UNDER_PREVIEW).toBe(mergeCustomers)
    // The control: identity is being tested, not truthiness. A different exported function from the same
    // area is not the merge, so a `toBe` that had been softened to a `toBeDefined` would fail here.
    expect(MERGE_UNDER_PREVIEW).not.toBe(previewCustomerMerge)
  })

  it('calls the merge through that reference and nowhere else', () => {
    const source = READ('./merge-preview.ts')
    // One call site, through the alias. A second direct `mergeCustomers(` call would mean the identity
    // above no longer says anything about what runs.
    expect(source.match(/MERGE_UNDER_PREVIEW\(/g) ?? []).toHaveLength(1)
    expect(source.match(/\bmergeCustomers\(/g) ?? []).toHaveLength(0)
  })
})

describe('a preview writes nothing of its own', () => {
  it('contains no write statement, so every write it performs is the merge’s', () => {
    const source = READ('./merge-preview.ts')
    const found = WRITE_STATEMENTS.filter((pattern) => pattern.test(source)).map(String)
    expect(
      found,
      'merge-preview.ts issues a write of its own. Every write in a preview must come from the merge ' +
        'function itself, or the preview is describing an operation nobody will perform.',
    ).toEqual([])
  })

  it('and the scan can fail: every pattern matches a repository that really writes', () => {
    // The control (ADR 0003). Without it the assertion above passes for a regex that matches nothing,
    // which is how a source scan becomes a test that cannot fail.
    //
    // Two control files, because `merge.ts` DELETES NOTHING — a merge leaves the loser as a tombstone and
    // its module header says so — and a single control would have had this case asserting that the delete
    // pattern matches a file that correctly contains no delete. `crm.ts` removes a customer tag.
    const controls = [READ('./merge.ts'), READ('./crm.ts')]
    for (const pattern of WRITE_STATEMENTS) {
      expect(
        controls.some((source) => pattern.test(source)),
        `${String(pattern)} matches neither merge.ts nor crm.ts, so it would match nothing anywhere`,
      ).toBe(true)
    }
  })

  it('leaves the transaction only by throwing, which is what rolls it back', () => {
    const source = READ('./merge-preview.ts')
    // `sql.begin` rolls back on a throw and commits on a return, so the body inside `withUnitOfWork`
    // must not be able to return. Both exits are `throw new PreviewRolledBack(`; a `return` there is the
    // one edit that makes a preview commit a merge nobody authorised, and gate case 95c is that mutant.
    expect(source.match(/throw new PreviewRolledBack\(/g) ?? []).toHaveLength(2)
    const body = source.slice(
      source.indexOf('await withUnitOfWork('),
      source.indexOf('} catch (error) {'),
    )
    expect(body.length).toBeGreaterThan(200)
    expect(body).not.toMatch(/\breturn\b/)
  })
})
