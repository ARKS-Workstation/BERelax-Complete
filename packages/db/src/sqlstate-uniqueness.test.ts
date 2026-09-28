import { describe, expect, it } from 'vitest'
import {
  collisions,
  liveRaisesByCode,
  PRIVATE_SQLSTATES,
  readMigrationCorpus,
  readTranslatorCorpus,
  registryProblems,
  SQLSTATE_REGISTRY_RULES,
  translatorsByCode,
} from './sqlstate-registry.ts'

/**
 * No private SQLSTATE stands for two rules, and no code is raised that the registry does not hold.
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
 * ## What this file is now, and what it was
 *
 * It used to hold `KNOWN_COLLISIONS`, a dated allowlist of thirteen codes each naming the two rules it
 * stood for, tolerated because adopting a rule against thirteen violations by disabling the rule would
 * have been worse than not having it. W-SYS-12 resolved all thirteen and the map is DELETED rather than
 * emptied, so the allowlist cannot be re-grown: there is no longer anywhere to put an exception.
 *
 * Two things the allowlist got wrong, and both are the reason the detector is now a measurement:
 *
 *   * It keyed on **which FILES contain a code**, which cannot tell a superseded definition from a second
 *     rule. `create or replace` means the file that DEFINED a function is often not the file whose
 *     definition executes, so ZB001, ZB002 and ZV002 were listed as collisions when each is ONE rule whose
 *     function was later replaced — three of thirteen entries describing something that did not exist.
 *   * Its ZL002 entry read "0018 raises it from the shared function, 0073 from its caller". 0073 does not
 *     raise it from a caller; it `create or replace`s the shared function. The one entry that correctly
 *     said "ONE rule, two places" was wrong about which two places, in a file whose subject is a claim
 *     standing for something other than what it measures.
 *
 * So the derivation lives in `sqlstate-registry.ts` and is shared with `pnpm sqlstate` rather than written
 * twice, and it resolves each raising function to its LIVE definition before comparing. `ZL002` then needs
 * no exception at all: one function, one rule, and the two call sites that reach it are driven end to end
 * by `packages/fixtures/src/sqlstate-allocation.itest.ts`, which asserts they report the same rule.
 *
 * ## The three directions
 *
 * A new collision fails. A registry entry that no longer describes a refusal fails — the direction the
 * allowlist had, which is what lets the registry SHRINK. And a code raised with no entry fails, which is
 * the direction the allowlist could not have: it is what stops the next unit taking a code silently.
 */
const corpus = readMigrationCorpus()
const raises = liveRaisesByCode(corpus)

describe('a private SQLSTATE stands for exactly one rule', () => {
  it('scans a corpus big enough for an empty result to mean something', () => {
    // ADR 0002: a check that examined nothing passes. Floors well under the real figures and far above
    // zero, so a glob that stopped matching fails here rather than reporting that all is well.
    expect(corpus.size).toBeGreaterThan(60)
    expect(raises.size).toBeGreaterThan(80)
    expect(PRIVATE_SQLSTATES.length).toBeGreaterThan(80)
  })

  it('raises no code from two migrations', () => {
    expect(
      collisions(raises),
      "a private SQLSTATE collision. Two rules sharing a code means one file's translator reports the " +
        "other file's refusal, and a probe asserting the code passes when the statement bounced off " +
        'something else. Take a code nobody raises — the next free subclass of the class your rule ' +
        'belongs in, registered in sqlstate-registry.ts. There is no allowlist to add it to.',
    ).toEqual([])
  })

  it('every entry in the registry still describes a refusal some migration raises', () => {
    // The direction that makes the registry safe to keep, inherited from the allowlist it replaced: once
    // a code stops being raised its entry must be deleted, or the registry silently becomes permission to
    // use that code for something else.
    const stale = registryProblems({ registry: PRIVATE_SQLSTATES, raises, translators: new Map() })
      .filter((problem) => problem.rule === SQLSTATE_REGISTRY_RULES.staleEntry)
      .map((problem) => problem.detail)
    expect(
      stale,
      'these codes are registered and no migration raises them — delete the entries, because an entry ' +
        'that no longer describes a refusal is permission to create a different one on the same code',
    ).toEqual([])
  })

  it('every code a migration raises has a registry entry', () => {
    // The direction the allowlist could not have had, and the one the acceptance calls the registry
    // direction: a unit that raises a code without registering it fails here rather than at the merge
    // where a second unit has already taken it.
    const unregistered = registryProblems({
      registry: PRIVATE_SQLSTATES,
      raises,
      translators: new Map(),
    })
      .filter((problem) => problem.rule === SQLSTATE_REGISTRY_RULES.unregisteredCode)
      .map((problem) => problem.detail)
    expect(unregistered, 'raised and unregistered').toEqual([])
  })

  it('the whole registry agrees with the migrations and the translators', () => {
    // Everything `pnpm sqlstate` checks, asserted here too, because the suite runs on every change and
    // the script runs at a named step: a unit that renames a trigger function should not have to reach
    // the verify chain to find out that the registry now describes a function nobody has.
    expect(
      registryProblems({
        registry: PRIVATE_SQLSTATES,
        raises,
        translators: translatorsByCode(readTranslatorCorpus()),
      }).map((problem) => `[${problem.rule}] ${problem.detail}`),
    ).toEqual([])
  })
})

/**
 * The controls. Every assertion above says "nothing is wrong", and that is exactly the shape that passes
 * when the detector has stopped detecting.
 *
 * The corpus is synthetic on purpose. There is no longer a real collision to point at — that was the
 * unit's job — so a control that asserted "the scan sees ZW001 raised twice" would have to be deleted with
 * the last collision, which is the moment the detector stops being watched. A fabricated corpus can hold
 * every case the real tree must never hold again.
 */
describe('the detector detects', () => {
  const fn = (name: string, code: string) =>
    `create function ${name}() returns trigger\nlanguage plpgsql\nas $$\nbegin\n  raise exception 'x' using errcode = '${code}';\nend $$;\n`

  it('sees a collision when two migrations raise one code from two functions', () => {
    const synthetic = new Map([
      ['0001_a.sql', fn('rule_one', 'ZZ900')],
      ['0002_b.sql', fn('rule_two', 'ZZ900')],
    ])
    expect(collisions(liveRaisesByCode(synthetic))).toEqual([
      'ZZ900 (0001:rule_one, 0002:rule_two)',
    ])
  })

  it('does NOT see a collision when the later migration REPLACES the function', () => {
    // ZL002's shape, and ZB001's, ZB002's and ZV002's: one rule, raised from one function, whose
    // definition moved. This is the case the allowlist got wrong three times out of four, and the reason
    // the three above need no migration and no exception.
    const synthetic = new Map([
      ['0001_a.sql', fn('one_rule', 'ZZ901')],
      [
        '0002_b.sql',
        fn('one_rule', 'ZZ901').replace('create function', 'create or replace function'),
      ],
    ])
    const byCode = liveRaisesByCode(synthetic)
    expect(collisions(byCode)).toEqual([])
    // And the live site is the REPLACEMENT, not the original — otherwise "no collision" would be right
    // for the wrong reason.
    expect(byCode.get('ZZ901')).toEqual([{ code: 'ZZ901', migration: '0002', fn: 'one_rule' }])
  })

  it('sees one code raised from several functions in ONE migration as one rule', () => {
    // ZU002's shape: three functions in 0076 raise it for one subject. A detector that keyed on the
    // function rather than the migration would demand two more migrations to satisfy it, about nothing.
    const synthetic = new Map([['0003_c.sql', fn('a_row', 'ZZ902') + fn('another_row', 'ZZ902')]])
    expect(collisions(liveRaisesByCode(synthetic))).toEqual([])
    expect(liveRaisesByCode(synthetic).get('ZZ902')).toHaveLength(2)
  })

  it('reads code and not prose: a commented-out raise is not a raise', () => {
    // Not hypothetical, and the reason the scanner blanks comments. 0099's own header explains itself with
    // `errcode = 'ZT001'` written inside a `--` comment; a scanner reading the file as text would report
    // the migration that resolved nine collisions as having created one.
    const commented = new Map([
      ['0004_d.sql', `-- the old code was errcode = 'ZZ903'\n${fn('live_rule', 'ZZ904')}`],
      ['0005_e.sql', `/* errcode = 'ZZ903' */\n${fn('other_rule', 'ZZ905')}`],
    ])
    const byCode = liveRaisesByCode(commented)
    expect([...byCode.keys()].sort()).toEqual(['ZZ904', 'ZZ905'])
    // The control on the control: the real 0099 header carries that line, so the real scan must not hold
    // a ZT001 raise in 0099. If comment blanking regressed, this is where it shows.
    expect(corpus.get('0099_sqlstate_reallocation.sql')).toContain("errcode = 'ZT001'")
    expect((raises.get('ZT001') ?? []).map((site) => site.migration)).toEqual(['0083'])
  })

  it.each([
    [
      SQLSTATE_REGISTRY_RULES.duplicateEntry,
      [...PRIVATE_SQLSTATES, PRIVATE_SQLSTATES[0] as (typeof PRIVATE_SQLSTATES)[number]],
    ],
    [SQLSTATE_REGISTRY_RULES.unregisteredCode, PRIVATE_SQLSTATES.slice(1)],
  ])('registryProblems reports %s', (rule, registry) => {
    // Each direction shown to fire on a registry that breaks it and only it. The remaining two directions
    // are covered below, and all five have a known-bad fixture in scripts/test-gates.mjs block 121.
    const found = registryProblems({ registry, raises, translators: new Map() }).map((p) => p.rule)
    expect(found).toContain(rule)
  })

  it('registryProblems reports a stale entry and an entry that disagrees', () => {
    const stale = registryProblems({
      registry: [
        {
          code: 'ZZ999',
          rule: 'nothing raises this',
          migration: '0093',
          raisedBy: ['nobody'],
          translators: [],
        },
      ],
      raises,
      translators: new Map(),
    })
    expect(stale.map((problem) => problem.rule)).toContain(SQLSTATE_REGISTRY_RULES.staleEntry)

    const first = PRIVATE_SQLSTATES[0] as (typeof PRIVATE_SQLSTATES)[number]
    const wrong = registryProblems({
      registry: [{ ...first, migration: '0001', raisedBy: ['not_the_function'] }],
      raises,
      translators: new Map(),
    })
    expect(wrong.map((problem) => problem.rule)).toContain(SQLSTATE_REGISTRY_RULES.entryDisagrees)
  })
})
