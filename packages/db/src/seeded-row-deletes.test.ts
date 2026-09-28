import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * No suite removes every row of `customer`, because four of them belong to the seed.
 *
 * ## The defect this is against
 *
 * `customer-identity.itest.ts` and `otp-route.itest.ts` both held `delete from customer` with no
 * predicate, in a `beforeEach` and an `afterAll`. That removes the four customers `pnpm seed` creates —
 * not for the rest of the file, but permanently, for every suite that runs afterwards and for every later
 * run against the same database. `sell-package.itest.ts` reads a seeded customer and skipped all 21 of its
 * cases with "the seed creates customers; run `pnpm seed` before the integration suite", and roughly
 * fourteen files read that table.
 *
 * It stayed invisible for a long time because another suite's leaked rows made the offending cleanup raise
 * on an `ON DELETE RESTRICT` foreign key, so the delete never completed. Six files carry comments
 * describing the hazard and ordering their own cleanup around it. Fixing the leak is what let the delete
 * succeed, which is the ordinary way a masked defect surfaces: the mask was the accident.
 *
 * **A suite may delete what it created. It may not delete what it found.**
 *
 * ## What this case does and does not measure
 *
 * It measures one table: `customer`. It is not a general rule about seeded data, and it does not pretend
 * to be — 67 unqualified `delete`/`truncate` statements exist across the integration suites, against
 * `premises`, `business_day`, `app_setting`, `message_template`, `premises_hours` and others, and sorting
 * the legitimate ones (a suite that owns a table outright, or `truncate`s the invoice family as its owner
 * because `invoice` refuses DELETE for every role) from the harmful ones is per-site judgement across
 * dozens of files. That is W-SYS-13 in the manifest. This case holds the line where the damage is proven.
 *
 * The allowlist is EMPTY and must stay that way. A suite that needs an empty `customer` table is a suite
 * that needs its own rows scoped, which both offenders now do: one by the two `phone_match_key`s it
 * creates, one by the two number bands it creates in.
 */
const ROOTS = ['packages', 'apps']

/** Every test file, integration or unit, under the roots — excluding this one. */
const SELF = join('packages', 'db', 'src', 'seeded-row-deletes.test.ts')

function testFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...testFiles(path))
      continue
    }
    if (/\.(itest|test)\.ts$/.test(entry)) out.push(path)
  }
  return out
}

/**
 * The file with its comments blanked, so a file DESCRIBING the hazard is not accused of it.
 *
 * Six files quote `delete from customer` inside prose. Newlines are preserved so a reported line number
 * still points at the statement.
 */
function withoutComments(source: string): string {
  let out = ''
  let index = 0
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code'
  while (index < source.length) {
    const rest = source.slice(index)
    const char = source[index] as string
    if (state === 'code') {
      if (rest.startsWith('//')) {
        state = 'line'
        index += 2
        continue
      }
      if (rest.startsWith('/*')) {
        state = 'block'
        index += 2
        continue
      }
      if (char === "'") state = 'single'
      else if (char === '"') state = 'double'
      else if (char === '`') state = 'template'
      out += char
      index += 1
      continue
    }
    if (state === 'line') {
      if (char === '\n') {
        state = 'code'
        out += char
      }
      index += 1
      continue
    }
    if (state === 'block') {
      if (rest.startsWith('*/')) {
        state = 'code'
        index += 2
        continue
      }
      if (char === '\n') out += char
      index += 1
      continue
    }
    // Inside a string or template: copy through, and let a backslash escape the next character.
    if (char === '\\') {
      out += source.slice(index, index + 2)
      index += 2
      continue
    }
    if (
      (state === 'single' && char === "'") ||
      (state === 'double' && char === '"') ||
      (state === 'template' && char === '`')
    ) {
      state = 'code'
    }
    out += char
    index += 1
  }
  return out
}

/** `delete from customer` / `truncate … customer …` with nothing narrowing it. */
const UNQUALIFIED = [
  /delete\s+from\s+customer\s*(?:`|;|$)/im,
  /truncate\s+(?:table\s+)?(?:[a-z_]+\s*,\s*)*customer\b/im,
]

describe('the seeded customers survive every suite', () => {
  it('finds no unqualified delete of the customer table, and reads enough files to mean it', () => {
    const files = ROOTS.flatMap((root) => testFiles(root)).filter((file) => file !== SELF)
    expect(
      files.length,
      'the scan found almost no test files, so a pass here would mean nothing',
    ).toBeGreaterThan(200)

    const offenders = files.filter((file) => {
      const code = withoutComments(readFileSync(file, 'utf8'))
      return UNQUALIFIED.some((pattern) => pattern.test(code))
    })
    expect(
      offenders,
      'a suite removes every row of `customer`, including the four the seed creates. Scope the delete to ' +
        'the rows this suite created — by its own `phone_match_key`s or its own number band — the way ' +
        'customer-identity.itest.ts and otp-route.itest.ts do',
    ).toEqual([])
  })

  it('reads code and not prose, so the files that describe the hazard are not accused of it', () => {
    // The control for the scan above, both directions, on strings this case owns.
    const prose = '// `delete from customer` is what customer-identity.itest.ts used to do\n'
    const statement = 'await sql`delete from customer`\n'
    expect(UNQUALIFIED.some((pattern) => pattern.test(withoutComments(prose)))).toBe(false)
    expect(UNQUALIFIED.some((pattern) => pattern.test(withoutComments(statement)))).toBe(true)
    // And a scoped delete is not an offence, which is the distinction the whole case rests on.
    const scoped = 'await sql`delete from customer where phone_match_key = any (${keys}::text[])`\n'
    expect(UNQUALIFIED.some((pattern) => pattern.test(withoutComments(scoped)))).toBe(false)
  })
})
