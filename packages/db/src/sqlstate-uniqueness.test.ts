import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * No private SQLSTATE is raised by two migrations for two DIFFERENT rules.
 *
 * ## The defect, and why nothing else catches it
 *
 * Every refusal in this schema carries a private SQLSTATE so a caller can branch on the RULE rather than
 * on a message, and every `…Error()` translator in `packages/db` matches on the code alone. So when two
 * unrelated rules share a code, three things break at once and none of them fails loudly: a translator
 * reports one file's refusal as the other's, with a plausible message and the wrong cause; a probe
 * asserting the code passes when the statement bounced off something else entirely; and the test that was
 * supposed to prove a rule fires proves only that SOMETHING did.
 *
 * `0080_frequency_ledger.sql`'s own header says it: a shared code makes "a probe asserting it pass when
 * the statement bounced off something else entirely."
 *
 * Nothing checked this, because the allocation is a convention with no allocator. Each unit picks a class
 * by reading the migrations it can see, and units in flight cannot see each other — the same failure that
 * produced two suites sharing port band 9700 and two branches claiming one migration number, except those
 * have an allocator now and this did not.
 *
 * ## What is and is not a collision
 *
 * A class appearing in two files is NOT one. `ZG001-ZG006` are 0078's and `ZG007-ZG012` are 0083's, which
 * is one subject continuing its own family correctly, and `ZL002` is raised from 0018's function and
 * 0073's caller, which is ONE rule raised in two places. Sharing is fine; what must never happen is one
 * CODE standing for two different rules.
 *
 * This test therefore keys on the exact five characters and holds a dated allowlist of the collisions that
 * already exist, each naming both rules. **The allowlist may only ever shrink.** A new collision fails
 * immediately; an existing one is tolerated with its reason recorded and an owner named, because adopting a
 * rule against thirteen existing violations by disabling the rule would be worse than not having it.
 */
const MIGRATIONS = 'packages/db/migrations'

/**
 * Codes already shared when this check was written, with the two rules each one stands for.
 *
 * Every entry is a latent defect, not an exemption on the merits. Reallocating them needs a namespace
 * decision, a migration per offender to `create or replace` its functions, and every translator and probe
 * updated with it. That is unit-sized and is **W-SYS-12** in the manifest, which is where the namespace
 * decision is taken: the CLASS stops identifying a migration file, a refusal is identified by all five
 * characters, and the registry allocates them. Until that unit lands, `ZZ` is the only free class — `ZY`
 * went to 0085 when C-CRM-09 and C-CRM-10 turned out to have taken `ZA` in worktrees that could not see
 * each other, which this check caught on the first run after that merge and is the reason it exists.
 *
 * This sentence used to say the work was "recorded as such in the manifest" when nothing in the manifest
 * owned it. The file was added to catch a code standing for two rules; it carried a claim standing for
 * nothing, six lines under the paragraph explaining why an unallocated convention drifts.
 *
 * REMOVE an entry when its collision is resolved. Never add one.
 */
const KNOWN_COLLISIONS: ReadonlyMap<string, string> = new Map([
  ['ZB001', '0024 and 0038'],
  ['ZB002', '0024 and 0038'],
  ['ZL002', '0018 raises it from the shared function, 0073 from its caller — ONE rule, two places'],
  ['ZT001', '0068 tender, 0069 customer merge, 0083 package redemption'],
  ['ZT002', '0068 tender and 0069 customer merge'],
  ['ZT003', '0068 tender and 0069 customer merge'],
  ['ZU001', '0076 cash session and 0077 pipeline — unrelated rules'],
  ['ZU002', '0076 cash session and 0077 pipeline — unrelated rules'],
  ['ZU003', '0076 cash session and 0077 pipeline — unrelated rules'],
  ['ZV002', '0028, 0034 and 0039'],
  [
    'ZW001',
    '0080 "the cap must be a whole number >= 1" and 0081 "rota_version carrying supersedes_id"',
  ],
  ['ZW002', '0080 frequency ledger and 0081 rota version'],
  [
    'ZX001',
    '0086 "an attendance row is append-only" and 0087 "the Ramadan window may only narrow"',
  ],
])

const RAISED = /errcode = '([A-Z0-9]{5})'/g

function codesByMigration(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const text = readFileSync(join(MIGRATIONS, file), 'utf8')
    for (const match of text.matchAll(RAISED)) {
      const code = match[1] as string
      const seen = out.get(code) ?? new Set<string>()
      seen.add(file.split('_')[0] as string)
      out.set(code, seen)
    }
  }
  return out
}

describe('a private SQLSTATE stands for exactly one rule', () => {
  const byCode = codesByMigration()

  it('scans a corpus big enough for an empty result to mean something', () => {
    // ADR 0002: a check that examined nothing passes. Floors well under the real figures and far above
    // zero, so a glob that stopped matching fails here rather than reporting that all is well.
    expect(readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).length).toBeGreaterThan(60)
    expect(byCode.size).toBeGreaterThan(80)
  })

  it('raises no code from two migrations except the ones already known', () => {
    const shared = [...byCode.entries()]
      .filter(([, files]) => files.size > 1)
      .map(([code, files]) => `${code} (${[...files].sort().join(', ')})`)
      .sort()
    const unexpected = shared.filter((line) => !KNOWN_COLLISIONS.has(line.slice(0, 5)))
    expect(
      unexpected,
      "a new private SQLSTATE collision. Two rules sharing a code means one file's translator reports " +
        "the other file's refusal, and a probe asserting the code passes when the statement bounced off " +
        'something else. Take a code nobody raises — and if the class is exhausted, say so rather than ' +
        'reusing one.',
    ).toEqual([])
  })

  it('the allowlist only shrinks: every entry in it is still a real collision', () => {
    // The other direction, and the one that makes the allowlist safe to keep. Once a collision is fixed
    // its entry must be deleted, or the list silently becomes permission to re-collide on that code.
    const stale = [...KNOWN_COLLISIONS.keys()].filter((code) => (byCode.get(code)?.size ?? 0) < 2)
    expect(
      stale,
      'these codes are in KNOWN_COLLISIONS and are no longer shared — delete them from the list, ' +
        'because an entry that no longer describes a collision is permission to create one',
    ).toEqual([])
  })

  it('the control: the scan DOES see a collision when one exists', () => {
    // Without this, the first case passes when `RAISED` stops matching and `byCode` is empty of duplicates
    // for the wrong reason. `ZW001` is known to be raised by two migrations, so the scan must say so.
    expect(byCode.get('ZW001')?.size ?? 0).toBeGreaterThan(1)
    // And a code raised by exactly one migration must not be reported as shared.
    const singles = [...byCode.entries()].filter(([, f]) => f.size === 1)
    expect(singles.length).toBeGreaterThan(70)
  })
})
