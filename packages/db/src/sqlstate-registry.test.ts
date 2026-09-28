import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  blankSqlComments,
  liveDefinitions,
  liveRaisesByCode,
  MIGRATIONS_DIR,
  PRIVATE_SQLSTATES,
  readMigrationCorpus,
} from './sqlstate-registry.ts'

/**
 * The registry is fit to allocate from: every entry is well formed, and the allowlist it replaced is gone.
 *
 * `sqlstate-uniqueness.test.ts` asserts the three directions the registry is checked in. This file asserts
 * the properties that make it usable as an allocator by somebody who has never read it — a code they can
 * pattern-match, a sentence that says what the refusal is, a migration and a translator path that resolve
 * — plus the two things that would let the old convention back in: a second allowlist, and a scanner that
 * reads prose as code.
 */
const corpus = readMigrationCorpus()

/** Every first-party source file, tests included, keyed by repo-relative path. */
function sourceFiles(roots = ['packages', 'apps', 'scripts']): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (['node_modules', 'dist', '.next'].includes(entry.name)) continue
        walk(path)
      } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
        found.push(path)
      }
    }
  }
  for (const root of roots) walk(root)
  return found.sort()
}

/** The files declaring `const <name>`, which is what a list of codes looks like whatever it is called. */
const declaring = (name: string): string[] =>
  sourceFiles().filter((path) => readFileSync(path, 'utf8').includes(`const ${name}`))

describe('the private SQLSTATE registry', () => {
  it('covers enough of the schema for the assertions below to mean anything', () => {
    // ADR 0002. 144 entries across 26 classes when this was written; floors far below that and far above
    // zero, so an import that resolved to an empty array fails here.
    expect(PRIVATE_SQLSTATES.length).toBeGreaterThan(80)
    expect(new Set(PRIVATE_SQLSTATES.map((entry) => entry.code.slice(0, 2))).size).toBeGreaterThan(
      20,
    )
  })

  it('holds well-formed codes in the private range, each once, in order', () => {
    const codes = PRIVATE_SQLSTATES.map((entry) => entry.code)
    for (const code of codes) expect(code).toMatch(/^Z[A-Z][0-9]{3}$/)
    expect(new Set(codes).size, 'a code appears once').toBe(codes.length)
    // Sorted, because the file is read to find the next free subclass of a class. An unsorted registry is
    // one a person allocating from scans by eye and gets wrong.
    expect(codes).toEqual([...codes].sort())
  })

  it('states one rule per entry, as a sentence, and no two entries state the same rule', () => {
    for (const entry of PRIVATE_SQLSTATES) {
      expect(entry.rule.length, `${entry.code} has a rule sentence`).toBeGreaterThan(30)
      expect(entry.rule, `${entry.code} ends its sentence`).toMatch(/\.$/)
      expect(entry.rule, `${entry.code} starts its sentence`).toMatch(/^[A-Z“'`]/)
      expect(entry.raisedBy.length, `${entry.code} names what raises it`).toBeGreaterThan(0)
    }
    // One rule with two codes is the same defect as one code with two rules, one direction over. This
    // cannot catch two sentences that MEAN the same thing, and says so rather than implying otherwise.
    const rules = PRIVATE_SQLSTATES.map((entry) => entry.rule)
    expect(new Set(rules).size, 'two entries state the identical rule').toBe(rules.length)
  })

  it('names a migration that exists and translator paths that exist', () => {
    for (const entry of PRIVATE_SQLSTATES) {
      expect(
        [...corpus.keys()].some((file) => file.startsWith(entry.migration)),
        `${entry.code} names migration ${entry.migration}, which is not on disk`,
      ).toBe(true)
      for (const path of entry.translators) {
        expect(existsSync(path), `${entry.code} names ${path}, which does not exist`).toBe(true)
        expect(
          readFileSync(path, 'utf8'),
          `${entry.code} names ${path}, which does not hold the code`,
        ).toContain(`'${entry.code}'`)
      }
    }
  })

  it('the nine codes W-SYS-12 moved are one migration, and each is a different rule from the code it left', () => {
    // The unit's own claim, asserted against the registry rather than restated: each pair is two rules that
    // shared one code, and they now differ in code, in rule and in the function that raises them. The
    // migration number is DERIVED — a merge that renumbers 0094 must not have to edit a test as well.
    const pairs = [
      ['ZT001', 'ZT005'],
      ['ZT002', 'ZT006'],
      ['ZT003', 'ZT007'],
      ['ZU001', 'ZU008'],
      ['ZU002', 'ZU009'],
      ['ZU003', 'ZU010'],
      ['ZW001', 'ZW006'],
      ['ZW002', 'ZW007'],
      ['ZX001', 'ZX006'],
    ] as const
    const entry = (code: string) => PRIVATE_SQLSTATES.find((candidate) => candidate.code === code)
    const movedTo = new Set<string>()
    for (const [kept, moved] of pairs) {
      const before = entry(kept)
      const after = entry(moved)
      expect(before, `${kept} is registered`).toBeDefined()
      expect(after, `${moved} is registered`).toBeDefined()
      expect(before?.rule, `${kept} and ${moved} are different rules`).not.toBe(after?.rule)
      expect(
        before?.raisedBy.some((fn) => after?.raisedBy.includes(fn)),
        `${kept} and ${moved} are raised by different functions`,
      ).toBe(false)
      movedTo.add(after?.migration ?? '')
    }
    expect(movedTo.size, 'one migration moved all nine sides').toBe(1)
  })

  it('has no allowlist to add an exception to', () => {
    // `KNOWN_COLLISIONS` was deleted rather than emptied, which is an acceptance line and not a tidy-up: an
    // empty allowlist is a place to put the next collision, and the thirteen it held arrived one merge at a
    // time. Scanned over the whole first-party tree, because the identifier coming back ANYWHERE — most
    // likely in a second copy of this detector — is the failure, not its coming back in one named file.
    //
    // Read off disk rather than through `git grep`: a new module is untracked until it is committed, so a
    // git-based scan would answer differently before and after the commit that added it, and the control
    // below is what makes a scan that finds nothing distinguishable from a scan that reads nothing.
    expect(declaring('KNOWN_COLLISIONS'), 'the allowlist, or a second copy of it, is back').toEqual(
      [],
    )
    expect(declaring('PRIVATE_SQLSTATES'), 'the control: the scan does find a declaration').toEqual(
      ['packages/db/src/sqlstate-registry.ts'],
    )
  })
})

describe('the scanner reads code, not prose', () => {
  it('blanks line comments, nested block comments and nothing else', () => {
    // Asserted as length-preserving blanking rather than against a literal run of spaces: a hand-counted
    // expectation is the kind that gets adjusted until it passes.
    const line = "select 1; -- errcode = 'ZZ998'\nselect 2;"
    const blanked = blankSqlComments(line)
    expect(blanked).toMatch(/^select 1; +\nselect 2;$/)
    expect(blanked, 'the commented code is gone').not.toContain('ZZ998')
    expect(blanked, 'and the file keeps its length, so offsets still line up').toHaveLength(
      line.length,
    )

    // PostgreSQL block comments NEST, so the depth is counted rather than matched — a `/*` inside a comment
    // that ended the comment early would leave the rest of a migration parsed as code.
    const nested = "/* a /* nested */ comment */ select 'kept';"
    expect(blankSqlComments(nested).trim()).toBe("select 'kept';")
    expect(blankSqlComments(nested)).toHaveLength(nested.length)

    // A `--` INSIDE a string is not a comment, and several refusal messages contain one. Blanking from it
    // would silently swallow the rest of the line, including an `errcode` on it.
    expect(blankSqlComments("raise exception 'a -- b' using errcode = 'ZZ997';")).toBe(
      "raise exception 'a -- b' using errcode = 'ZZ997';",
    )
    // Line numbers survive, so a caller reporting a site still points at the line a reader has open.
    expect(blankSqlComments('a\n-- b\nc').split('\n')).toHaveLength(3)
  })

  it('resolves a replaced function to the migration that replaced it', () => {
    // The measurement the whole unit turns on, asserted on the real corpus at the four places it matters.
    // Each of these is ONE rule whose function moved, and each was listed as a collision by the detector
    // this replaced.
    const live = liveDefinitions(corpus)
    expect(live.get('raise_if_period_locked')).toBe('0073_period_close.sql')
    expect(live.get('assert_room_capacity')).toBe('0038_booking_transaction.sql')
    expect(live.get('assert_bill_totals_match_lines')).toBe('0039_reverse_charge.sql')
    expect(live.get('payment_within_the_document')).toBe('0083_package_redemption.sql')
    // And the nine this unit replaced, which is what makes the moved codes live rather than merely written.
    for (const fn of [
      'refuse_merge_record_change',
      'assert_merge_survivor_is_live',
      'merge_survivor_of',
      'assert_pipeline_card_move_is_recorded',
      'refuse_pipeline_transition_change',
      'assert_pipeline_stage_positions_are_gapless',
      'refuse_published_rota_change',
      'refuse_rota_change_request_edit',
      'assert_promotional_window_is_a_narrowing',
    ]) {
      expect(live.get(fn), `${fn}'s live definition`).toBe('0094_sqlstate_reallocation.sql')
    }
  })

  it('attributes every raise in the real corpus to a named function', () => {
    // `(do block)` is the scanner's answer for a raise outside a function, and it is deliberately not an
    // error: plpgsql permits one, and silently attributing it to the previous function would be worse. No
    // migration has one today, so this is the assertion that says so rather than leaving it assumed.
    const sites = [...liveRaisesByCode(corpus).values()].flat()
    expect(sites.length).toBeGreaterThan(150)
    expect(sites.filter((site) => site.fn === '(do block)')).toEqual([])
    expect(MIGRATIONS_DIR).toBe('packages/db/migrations')
  })
})
