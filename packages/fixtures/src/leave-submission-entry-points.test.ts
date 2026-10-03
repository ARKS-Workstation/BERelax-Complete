import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * P-HR-14 — both leave submission entry points call ONE function, proved by reading the source.
 *
 * ## Why a source scan and not a test that calls both
 *
 * The acceptance line is *"a leave request submitted from the portal enters the same validator as the
 * admin path, asserted by a test showing both entry points call one function"*. A test that drove both
 * routes and compared their answers would prove they AGREE TODAY, which is not the claim: two code paths
 * that agree today are exactly what the line exists to refuse, because the second one stops agreeing the
 * day somebody adds a rule to the first.
 *
 * What makes them one validator is that there is one function and nothing else writes a leave request. So
 * that is what is asserted, in both directions:
 *
 *   1. every entry point imports `submitLeaveRequest`;
 *   2. **no application file calls `writeLeaveRequest`** — the repository insert — except through it.
 *
 * The second is the load-bearing half. Without it, a third route could appear next week with its own
 * balance check and its own probation rule, and this file would still pass.
 *
 * ## The controls
 *
 * Three, because a scan that found nothing would satisfy both claims perfectly:
 *
 *   - the entry-point list is non-empty and both named files exist;
 *   - the scan DOES see a direct `writeLeaveRequest(` call when one is planted in a string, which is what
 *     proves the pattern matches at all;
 *   - `submitLeaveRequest` itself is found calling `writeLeaveRequest`, so the one permitted caller is
 *     real rather than a name nothing uses.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')

/** The one function that may insert a leave request, and the one file it may be called from. */
const VALIDATOR = 'submitLeaveRequest'
const REPOSITORY_INSERT = 'writeLeaveRequest'
const PERMITTED_CALLER = join('packages', 'hr', 'src', 'staff-portal.ts')

/** The repository that DEFINES the insert. It names the function to export it; that is not a call. */
const DEFINITION = join('packages', 'db', 'src', 'repositories', 'leave-request.ts')
const BARREL = join('packages', 'db', 'src', 'index.ts')

/**
 * The route files that submit a leave request.
 *
 * Named rather than discovered, and the reason is the direction of the claim: a discovered list says "the
 * files that mention it", and what has to be true is that THESE TWO screens — the portal and the admin
 * filing path — both go through the validator. A new third entry point is caught by the other half of the
 * scan, which refuses a direct repository call anywhere.
 */
const ENTRY_POINTS = [
  join('apps', 'web', 'app', '(admin)', 'hr', 'me', 'route.ts'),
  join('apps', 'web', 'app', '(admin)', 'hr', 'leave', 'route.ts'),
]

const read = (relativePath: string): string => readFileSync(join(ROOT, relativePath), 'utf8')

/** Every `.ts`/`.tsx` under a directory, recursively, excluding build output and dependencies. */
function sourceFiles(directory: string, prefix = ''): readonly string[] {
  const out: string[] = []
  for (const entry of readdirSync(join(ROOT, directory, prefix), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'dist') continue
    const next = join(prefix, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(directory, next))
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
      out.push(join(directory, next))
  }
  return out
}

/**
 * A CALL to the name, not a mention of it.
 *
 * `writeLeaveRequest(` with an opening parenthesis, so an import, a re-export and a sentence in a comment
 * are not matched. That distinction is what keeps the barrel and the repository's own export list out of
 * the answer without either being exempted by name.
 */
const callsRepositoryInsert = (text: string): boolean =>
  new RegExp(String.raw`\b${REPOSITORY_INSERT}\s*\(`).test(text)

/** The files the rule applies to: application code, not tests and not fixtures. */
const APPLICATION_ROOTS = ['apps/web/app', 'apps/web/src', 'apps/worker/src', 'packages']

function applicationFiles(): readonly string[] {
  const out: string[] = []
  for (const root of APPLICATION_ROOTS) {
    for (const file of sourceFiles(root)) {
      const base = file.split('/').at(-1) ?? ''
      // Tests and fixtures legitimately insert a leave request directly: `hr-leave-approval.itest.ts`
      // and `apps/web/src/leave-approval.itest.ts` both need a PENDING row to approve, and neither is a
      // submission path a therapist can reach. Excluded by SHAPE — the filename — rather than by a list,
      // so a third suite needs no edit here and a third ROUTE cannot hide in one.
      if (base.endsWith('.test.ts') || base.endsWith('.itest.ts') || base.endsWith('.test.tsx'))
        continue
      out.push(file)
    }
  }
  return out
}

describe('the leave submission entry points', () => {
  it('both exist and both reach the one validator', () => {
    expect(ENTRY_POINTS.length).toBeGreaterThanOrEqual(2)
    for (const entry of ENTRY_POINTS) {
      const text = read(entry)
      expect(
        text,
        `leave-request-has-one-validator: ${entry} does not import ${VALIDATOR}`,
      ).toContain(VALIDATOR)
      expect(text, `${entry} imports it from somewhere other than @berelax/hr`).toContain(
        "from '@berelax/hr'",
      )
      // And neither reaches the repository itself, which is the half that matters: an entry point could
      // import the validator and still write its own row beside it.
      expect(
        callsRepositoryInsert(text),
        `${entry} calls ${REPOSITORY_INSERT} directly as well`,
      ).toBe(false)
    }
  })

  it('has exactly one application caller of the repository insert', () => {
    const callers = applicationFiles()
      .filter((file) => callsRepositoryInsert(read(file)))
      .map((file) => relative('.', file))
      .filter((file) => file !== DEFINITION && file !== BARREL)
    expect(
      callers,
      'leave-request-has-one-validator: a leave request may only be inserted through ' +
        'submitLeaveRequest in @berelax/hr, which is where ' +
        'the balance, the probation rule and the leave year are judged. A second insert is a second ' +
        'validator, and the second one is the one that stops agreeing.',
    ).toEqual([PERMITTED_CALLER])
  })

  it('finds the permitted caller really calling it, which is the first control', () => {
    // Without this, the assertion above is satisfied by a pattern that matches nothing and a list with
    // one name in it that nothing uses.
    expect(callsRepositoryInsert(read(PERMITTED_CALLER))).toBe(true)
    expect(read(PERMITTED_CALLER)).toContain(`export async function ${VALIDATOR}`)
  })

  it('sees a planted direct call, which is the second control', () => {
    // The pattern itself, exercised against text that must match and text that must not. Without this a
    // typo in the regular expression would make the whole file pass about nothing — which is the vacuous
    // pass ADR 0003 is about.
    expect(callsRepositoryInsert('await writeLeaveRequest(sql, { employeeId })')).toBe(true)
    expect(callsRepositoryInsert('writeLeaveRequest  (sql, {})')).toBe(true)
    // A mention is not a call: an import, a re-export and a sentence about it.
    expect(callsRepositoryInsert("import { writeLeaveRequest } from '@berelax/db'")).toBe(false)
    expect(callsRepositoryInsert('// writeLeaveRequest is the repository insert')).toBe(false)
  })

  it('scans enough files for the answer to mean something, which is the third control', () => {
    // A floor on the walk. An `applicationFiles()` that returned nothing — a renamed directory, a throw
    // swallowed somewhere — would make the one-caller assertion pass with an empty list.
    expect(applicationFiles().length).toBeGreaterThan(400)
  })
})
