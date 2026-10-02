import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The allocator for private SQLSTATEs: one entry per code, and a gate that proves the entry true.
 *
 * ## What a private SQLSTATE is for, and what went wrong
 *
 * Every refusal in this schema carries a code in the private range so a caller can branch on the RULE
 * rather than on a message, and every translator in `packages/db` matches on the code ALONE. So a code
 * standing for two rules breaks three things at once and none of them loudly: a translator reports one
 * file's refusal as the other's, with a plausible message and the wrong cause; a probe asserting the code
 * passes when the statement bounced off something else entirely; and the test meant to prove a rule fires
 * proves only that SOMETHING did.
 *
 * Thirteen codes were shared when W-SYS-12 started, and the cause was a convention with no allocator: a
 * unit picked a CLASS by reading the migrations it could see, and units in flight cannot see each other.
 * Four migrations claimed `ZY001` in one afternoon. `ZA` through `ZZ` are all in use — 0093 took the last
 * free class — so the convention had not merely become awkward, it had run out.
 *
 * The decision, recorded in ADR 0043: **the class stops identifying a migration file. A refusal is
 * identified by all FIVE characters, two unrelated rules may share a class and must never share a code,
 * and this file allocates them.** `ZZ` plus the unused subclasses of every existing class are then enough
 * for the units that remain.
 *
 * ## Why an entry per code rather than a range per file
 *
 * A range per file is what the classes were, one level down, and it fails the same way: a range is a claim
 * about what a file WILL use, and nothing compares it to what the file does use. An entry names one code
 * and one rule, and `scripts/check-sqlstate-registry.mjs` fails in five directions:
 *
 *   1. two entries sharing a code;
 *   2. a code raised by a migration with no entry;
 *   3. an entry naming a code no migration raises — the direction that lets this registry SHRINK, and
 *      what the allowlist it replaced had, because an entry that no longer describes anything is
 *      permission to re-create what it described;
 *   4. an entry whose migration, raising functions or translators disagree with the tree;
 *   5. one code raised from two different migrations' live definitions, which is the collision itself.
 *
 * Only `rule` is prose. Every other field is a claim the gate proves against the migrations and the
 * source tree, so a rename or a move fails the build instead of leaving a registry that reads correctly
 * and describes something else.
 *
 * ## Allocating a code
 *
 * Read the entries for the class your rule belongs in, take the next free subclass, add the entry, raise
 * it. There is no reservation step and nothing to ask for: a code two units both take fails direction 1 or
 * 5 in whichever tree merges second, which is the failure this file exists to make loud rather than to
 * prevent by agreement.
 */
export interface PrivateSqlState {
  /** The five characters. Private range: `Z` plus a letter, plus three digits. */
  readonly code: string
  /**
   * The rule, in one sentence: what the database refuses.
   *
   * The one field the gate cannot verify, which is why it is one sentence about the REFUSAL rather than a
   * description of the function. Two entries whose sentences are identical is a smell the registry test
   * reports, because one rule with two codes is the same defect as one code with two rules.
   */
  readonly rule: string
  /**
   * The four digits of the migration whose LIVE definition raises it.
   *
   * Live, not first: `create or replace` means the file that DEFINED a function is often not the file
   * whose definition executes. Four of the thirteen "collisions" this unit inherited were one rule whose
   * function had been replaced, counted twice because the detector keyed on which files contain the code.
   */
  readonly migration: string
  /** The function(s) in that live definition that raise it. `(do block)` for a raise outside a function. */
  readonly raisedBy: readonly string[]
  /**
   * The module(s) that turn it into a typed refusal, repo-relative — and `[]` when nothing does.
   *
   * `[]` is not an omission to be filled in with something plausible: it says the refusal reaches its
   * caller as a raw `postgres.js` error, which is a fact about this tree that was invisible before the
   * registry existed. 38 of these codes had none when this file was written, and `pnpm sqlstate` prints
   * the figure on every run rather than leaving it to be read out of a comment. The gate checks `[]` in both directions, so a
   * translator added later fails the build until the entry names it.
   */
  readonly translators: readonly string[]
}

/** The rule names every direction fails by, so a known-bad fixture can assert the one it broke (ADR 0003). */
export const SQLSTATE_REGISTRY_RULES = {
  duplicateEntry: 'sqlstate-registry-holds-one-entry-per-code',
  unregisteredCode: 'sqlstate-registry-covers-every-raised-code',
  staleEntry: 'sqlstate-registry-entry-still-describes-a-refusal',
  entryDisagrees: 'sqlstate-registry-entry-matches-the-migrations',
  twoRules: 'one-private-sqlstate-stands-for-one-rule',
  outOfOrder: 'sqlstate-registry-is-read-in-ascending-code-order',
} as const

export const MIGRATIONS_DIR = 'packages/db/migrations'

/**
 * Where a translator may live: every first-party module, minus the tests and minus this file.
 *
 * This file is excluded because it holds every code as a literal, so including it would make every entry
 * its own translator. The tests are excluded because a probe asserting a code is not a layer that
 * reports it — that distinction is the whole reason `translators: []` is allowed to be empty.
 */
export const TRANSLATOR_ROOTS = ['packages', 'apps'] as const
const NOT_A_TRANSLATOR = /\.(test|itest)\.ts$|sqlstate-registry\.ts$/

/** ------------------------------------------------------------------------------------------------
 * The derivation. Pure over a corpus, so a test can hand it a corpus that DOES collide (ADR 0002).
 * ------------------------------------------------------------------------------------------------ */

/**
 * A migration with its `--` and nested block comments blanked, newlines and string literals intact.
 *
 * The gate has to read CODE rather than prose, and in this repository that is not a theoretical
 * distinction: `0099_sqlstate_reallocation.sql` explains itself with the line ``errcode = 'ZT001'`` inside
 * a comment, and a scanner that saw it would report a collision in the file that resolved nine of them.
 * Strings survive because `errcode = '…'` IS a string — blanking them, which is what the schema-convention
 * scanner does for the opposite reason, would blank the only thing this reads.
 */
export function blankSqlComments(sql: string): string {
  let out = ''
  let depth = 0
  let inString = false
  let i = 0
  while (i < sql.length) {
    const two = sql.slice(i, i + 2)
    if (depth > 0) {
      if (two === '/*') {
        depth += 1
        out += '  '
        i += 2
      } else if (two === '*/') {
        depth -= 1
        out += '  '
        i += 2
      } else {
        out += sql[i] === '\n' ? '\n' : ' '
        i += 1
      }
      continue
    }
    if (inString) {
      out += sql[i]
      if (sql[i] === "'") inString = false
      i += 1
      continue
    }
    if (sql[i] === "'") {
      inString = true
      out += sql[i]
      i += 1
      continue
    }
    if (two === '/*') {
      depth = 1
      out += '  '
      i += 2
      continue
    }
    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }
    out += sql[i]
    i += 1
  }
  return out
}

/** One place a private SQLSTATE is raised from. */
export interface RaiseSite {
  readonly code: string
  /** The four digits of the file the raise is written in. */
  readonly migration: string
  /** The enclosing function, or `(do block)` for a raise outside one. */
  readonly fn: string
}

const DEFINITION = /^\s*create (?:or replace )?function ([a-z0-9_]+(?:\.[a-z0-9_]+)?)\s*\(/
const BODY_OPEN = /\bas \$([a-z0-9_]*)\$/
const DO_OPEN = /^\s*do\s+\$([a-z0-9_]*)\$/
const RAISED = /errcode = '([A-Z0-9]{5})'/g

/** Every `create [or replace] function` in the corpus, mapped to the LAST file that defines it. */
export function liveDefinitions(corpus: ReadonlyMap<string, string>): Map<string, string> {
  const live = new Map<string, string>()
  for (const file of [...corpus.keys()].sort()) {
    for (const line of blankSqlComments(corpus.get(file) ?? '').split('\n')) {
      const match = DEFINITION.exec(line)
      if (match?.[1] !== undefined) live.set(match[1], file)
    }
  }
  return live
}

/**
 * Every raise site in the corpus, with the raise sites of SUPERSEDED definitions dropped.
 *
 * Dropping them is the measurement that tells one rule raised in two places from two rules sharing a
 * code, and it replaces a thirteen-entry allowlist four of whose entries were wrong about which they were.
 */
export function liveRaiseSites(corpus: ReadonlyMap<string, string>): RaiseSite[] {
  const live = liveDefinitions(corpus)
  const sites: RaiseSite[] = []
  for (const file of [...corpus.keys()].sort()) {
    const lines = blankSqlComments(corpus.get(file) ?? '').split('\n')
    let fn: string | null = null
    let pending: string | null = null
    let tag: string | null = null
    for (const line of lines) {
      if (tag === null) {
        const definition = DEFINITION.exec(line)
        if (definition?.[1] !== undefined) pending = definition[1]
        const doBlock = DO_OPEN.exec(line)
        const body = BODY_OPEN.exec(line)
        if (doBlock?.[1] !== undefined) {
          tag = doBlock[1]
          fn = '(do block)'
        } else if (body?.[1] !== undefined) {
          tag = body[1]
          fn = pending ?? '(do block)'
          pending = null
        }
        // A body opened and closed on one line leaves nothing open.
        if (tag !== null && line.split(`$${tag}$`).length > 2) {
          tag = null
          fn = null
        }
      } else if (line.includes(`$${tag}$`)) {
        tag = null
        fn = null
      }
      for (const match of line.matchAll(RAISED)) {
        const code = match[1] as string
        const raiser = fn ?? '(do block)'
        if (raiser !== '(do block)' && live.get(raiser) !== file) continue
        sites.push({ code, migration: file.slice(0, 4), fn: raiser })
      }
    }
  }
  return sites
}

/** The live raise sites, grouped by code. */
export function liveRaisesByCode(corpus: ReadonlyMap<string, string>): Map<string, RaiseSite[]> {
  const byCode = new Map<string, RaiseSite[]>()
  for (const site of liveRaiseSites(corpus)) {
    const seen = byCode.get(site.code)
    if (seen === undefined) byCode.set(site.code, [site])
    else seen.push(site)
  }
  return byCode
}

/** Codes whose live raise sites span more than one migration: one code standing for two rules. */
export function collisions(byCode: ReadonlyMap<string, RaiseSite[]>): string[] {
  return [...byCode.entries()]
    .filter(([, sites]) => new Set(sites.map((site) => site.migration)).size > 1)
    .map(
      ([code, sites]) =>
        `${code} (${[...new Set(sites.map((site) => `${site.migration}:${site.fn}`))].sort().join(', ')})`,
    )
    .sort()
}

/** Which first-party modules hold each code as a literal, keyed by code. */
export function translatorsByCode(
  modules: ReadonlyMap<string, string>,
): Map<string, readonly string[]> {
  const byCode = new Map<string, string[]>()
  for (const [path, text] of [...modules.entries()].sort()) {
    for (const match of text.matchAll(/'([A-Z0-9]{5})'/g)) {
      const code = match[1] as string
      if (!/^Z[A-Z][0-9]{3}$/.test(code)) continue
      const seen = byCode.get(code)
      if (seen === undefined) byCode.set(code, [path])
      else if (!seen.includes(path)) seen.push(path)
    }
  }
  return byCode
}

/** One way the registry and the tree disagree, named by the rule it breaks. */
export interface RegistryProblem {
  readonly rule: string
  readonly detail: string
}

/**
 * Every disagreement between the registry and the tree, in the six directions.
 *
 * Pure, and takes the derived facts as arguments rather than reading them, so the known-bad fixtures can
 * be a corpus rather than an edit to a shipped file — and so a direction that has never been seen to fire
 * can be seen to fire on something (ADR 0003).
 */
export function registryProblems(input: {
  readonly registry: readonly PrivateSqlState[]
  readonly raises: ReadonlyMap<string, RaiseSite[]>
  readonly translators: ReadonlyMap<string, readonly string[]>
}): RegistryProblem[] {
  const { registry, raises, translators } = input
  const problems: RegistryProblem[] = []
  const rules = SQLSTATE_REGISTRY_RULES

  // The order direction, and the reason it is HERE rather than only in the suite that reads this file.
  //
  // This array is read as a SEQUENCE: the next unit to need a band finds it by reading down the codes, so
  // an entry in the wrong place hides a free band and offers an occupied one. `sqlstate-registry.test.ts`
  // has always held that claim — and `pnpm sqlstate` did NOT, so the cheap gate in every agent's loop
  // passed while the expensive one failed. Three merges broke this file in exactly that gap, each from a
  // keep-both resolution that put an incoming band after the codes it sorts before. Two gates disagreeing
  // about one file is the defect this registry exists to prevent, one level up.
  //
  // It names the PAIR rather than printing a sorted list, because the fix is to move one entry and a
  // sorted list invites a reformat of the whole file — which is how a merge loses somebody else's band.
  for (let i = 1; i < registry.length; i += 1) {
    const previous = registry[i - 1]
    const current = registry[i]
    if (previous === undefined || current === undefined) continue
    if (current.code < previous.code) {
      problems.push({
        rule: rules.outOfOrder,
        detail: `${current.code} is entered after ${previous.code}. This array is read down to find the next free band, so an entry out of place hides a free one and offers an occupied one — move the entry, never renumber the code.`,
      })
    }
  }

  const seen = new Set<string>()
  for (const entry of registry) {
    if (seen.has(entry.code)) {
      problems.push({
        rule: rules.duplicateEntry,
        detail: `${entry.code} has more than one entry. A code is an identity: two entries for one code is two rules sharing it, written down.`,
      })
    }
    seen.add(entry.code)
  }

  for (const [code, sites] of [...raises.entries()].sort()) {
    if (seen.has(code)) continue
    problems.push({
      rule: rules.unregisteredCode,
      detail: `${code} is raised by ${[...new Set(sites.map((s) => s.migration))].join(', ')} and has no registry entry. Add one, or take a code nobody holds.`,
    })
  }

  for (const entry of registry) {
    const sites = raises.get(entry.code)
    if (sites === undefined || sites.length === 0) {
      problems.push({
        rule: rules.staleEntry,
        detail: `${entry.code} is registered ("${entry.rule}") and no migration raises it. Delete the entry — one that no longer describes a refusal is permission to create a different one on the same code.`,
      })
      continue
    }
    const migrations = [...new Set(sites.map((site) => site.migration))].sort()
    if (migrations.length === 1 && migrations[0] !== entry.migration) {
      problems.push({
        rule: rules.entryDisagrees,
        detail: `${entry.code} says migration ${entry.migration}; its live definition is in ${migrations[0]}.`,
      })
    }
    const actual = [...new Set(sites.map((site) => site.fn))].sort()
    const claimed = [...entry.raisedBy].sort()
    if (actual.join(',') !== claimed.join(',')) {
      problems.push({
        rule: rules.entryDisagrees,
        detail: `${entry.code} says it is raised by ${claimed.join(', ') || '(nothing)'}; the live definitions raise it from ${actual.join(', ')}.`,
      })
    }
    const actualTranslators = [...(translators.get(entry.code) ?? [])].sort()
    const claimedTranslators = [...entry.translators].sort()
    if (actualTranslators.join(',') !== claimedTranslators.join(',')) {
      problems.push({
        rule: rules.entryDisagrees,
        detail: `${entry.code} says its translator(s) are ${claimedTranslators.join(', ') || '(none)'}; the modules holding the code are ${actualTranslators.join(', ') || '(none)'}.`,
      })
    }
  }

  for (const line of collisions(raises)) {
    problems.push({
      rule: rules.twoRules,
      detail: `${line} — one code, two migrations' live definitions. A translator matching it reports one refusal as the other, and a probe asserting it passes on a statement it never touched.`,
    })
  }

  return problems
}

/** ------------------------------------------------------------------------------------------------
 * The I/O. Separate from the derivation so the derivation stays testable with nothing on disk.
 * ------------------------------------------------------------------------------------------------ */

/** Every migration, keyed by file name. */
export function readMigrationCorpus(dir: string = MIGRATIONS_DIR): Map<string, string> {
  const corpus = new Map<string, string>()
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql'))) {
    corpus.set(file, readFileSync(join(dir, file), 'utf8'))
  }
  return corpus
}

/** Every first-party module a translator could live in, keyed by repo-relative path. */
export function readTranslatorCorpus(
  roots: readonly string[] = TRANSLATOR_ROOTS,
): Map<string, string> {
  const modules = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.next')
          continue
        walk(path)
      } else if (/\.tsx?$/.test(entry.name) && !NOT_A_TRANSLATOR.test(path)) {
        modules.set(path, readFileSync(path, 'utf8'))
      }
    }
  }
  for (const root of roots) walk(root)
  return modules
}

/** ------------------------------------------------------------------------------------------------
 * The registry.
 *
 * Ordered by code, which is the order somebody allocating reads it in. A class is a grouping and nothing
 * more: `ZT` holds the payment tender's rules AND the customer merge's, `ZU` the cash session's AND the
 * pipeline's, and that is the decision rather than an accident of it.
 * ------------------------------------------------------------------------------------------------ */
export const PRIVATE_SQLSTATES: readonly PrivateSqlState[] = [
  {
    code: 'ZA001',
    rule: 'A contraindication flag row must name the template version its source submission was captured under.',
    migration: '0084',
    raisedBy: ['clinical.enforce_contraindication_provenance'],
    translators: [],
  },
  {
    code: 'ZA002',
    rule: 'A contraindication flag row must cite a submission belonging to the same customer.',
    migration: '0084',
    raisedBy: ['clinical.enforce_contraindication_provenance'],
    translators: [],
  },
  {
    code: 'ZB001',
    rule: 'A room may not hold more overlapping client places at any instant than its capacity.',
    migration: '0038',
    raisedBy: ['assert_room_capacity'],
    translators: [
      'packages/db/src/repositories/create-booking.ts',
      'packages/db/src/repositories/reassignment.ts',
    ],
  },
  {
    code: 'ZB002',
    rule: "A room's capacity may not be reduced below the client places already committed in it.",
    migration: '0038',
    raisedBy: ['assert_room_capacity_covers_commitments'],
    translators: [],
  },
  {
    code: 'ZB003',
    rule: 'Appointment status history is append-only: a wrong status is corrected by a further transition.',
    migration: '0024',
    raisedBy: ['refuse_appointment_history_change'],
    translators: [],
  },
  {
    code: 'ZB004',
    rule: 'The resource-holding rows of one delivery must describe one delivery, not several.',
    migration: '0038',
    raisedBy: ['assert_delivery_is_coherent'],
    translators: [
      'packages/db/src/repositories/create-booking.ts',
      'packages/db/src/repositories/reassignment.ts',
    ],
  },
  {
    code: 'ZC001',
    rule: 'A service may not be published when no room type can deliver it.',
    migration: '0029',
    raisedBy: ['assert_service_publishable'],
    translators: ['packages/db/src/repositories/catalogue.ts'],
  },
  {
    code: 'ZC002',
    rule: 'A service may not be published with no resource shape stating what one delivery needs.',
    migration: '0029',
    raisedBy: ['assert_service_publishable'],
    translators: ['packages/db/src/repositories/catalogue.ts'],
  },
  {
    code: 'ZC003',
    rule: 'A service may not be published with no priced duration.',
    migration: '0029',
    raisedBy: ['assert_service_publishable'],
    translators: ['packages/db/src/repositories/catalogue.ts'],
  },
  {
    code: 'ZC004',
    rule: "A service's slug may not change without leaving a 301 from the old path.",
    migration: '0029',
    raisedBy: ['assert_slug_change_left_a_working_redirect'],
    translators: ['packages/db/src/repositories/catalogue.ts'],
  },
  {
    code: 'ZC005',
    rule: 'A redirect must point at a path a live service answers on.',
    migration: '0029',
    raisedBy: [
      'assert_delete_left_no_dead_redirect',
      'assert_redirect_is_one_hop_to_a_live_page',
      'assert_slug_change_left_a_working_redirect',
    ],
    translators: ['packages/db/src/repositories/catalogue.ts'],
  },
  {
    code: 'ZC006',
    rule: 'A redirect must be one hop: its target may not itself redirect.',
    migration: '0029',
    raisedBy: ['assert_redirect_is_one_hop_to_a_live_page'],
    translators: ['packages/db/src/repositories/catalogue.ts'],
  },
  {
    code: 'ZC007',
    rule: 'A redirect may not lead away from a path a live service still answers on.',
    migration: '0029',
    raisedBy: ['assert_redirect_is_one_hop_to_a_live_page'],
    translators: ['packages/db/src/repositories/catalogue.ts'],
  },
  {
    code: 'ZD001',
    rule: 'A credit note must name an invoice that exists.',
    migration: '0072',
    raisedBy: ['credit_note_corrects_a_real_invoice'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD002',
    rule: 'A credit note may not be dated before the supply it corrects.',
    migration: '0072',
    raisedBy: ['credit_note_corrects_a_real_invoice'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD003',
    rule: 'Walking forward for the earliest open accounting date must reach one within a thousand periods.',
    migration: '0072',
    raisedBy: ['credit_note_corrects_a_real_invoice', 'earliest_open_date_from'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD004',
    rule: 'A credit note line must belong to a credit note that exists.',
    migration: '0072',
    raisedBy: ['credit_note_line_within_the_invoiced_quantity'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD005',
    rule: 'A credit note line must credit at the price and VAT rate the invoice line was sold at.',
    migration: '0072',
    raisedBy: ['credit_note_line_within_the_invoiced_quantity'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD006',
    rule: 'A supply may not be credited for more than it was invoiced.',
    migration: '0072',
    raisedBy: ['credit_note_line_within_the_invoiced_quantity'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD007',
    rule: "A credit note's totals must be the sum of its lines.",
    migration: '0072',
    raisedBy: ['assert_credit_note_totals_match_lines'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD008',
    rule: 'A credit note must have at least one line.',
    migration: '0072',
    raisedBy: ['assert_credit_note_totals_match_lines'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD009',
    rule: 'A credit note is append-only: a note issued in error is answered by re-invoicing the supply.',
    migration: '0072',
    raisedBy: ['refuse_credit_note_change'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD010',
    rule: 'A refund against a credit note must name a credit note that exists.',
    migration: '0072',
    raisedBy: ['refund_credit_note_is_for_this_document'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD011',
    rule: "A credit note's reversing journal entry must be dated in the period the note falls in.",
    migration: '0072',
    raisedBy: ['credit_note_reversal_is_dated_on_the_note'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZD012',
    rule: 'Refunds against one credit note may not exceed what it credits.',
    migration: '0072',
    raisedBy: ['refund_within_the_credit_note'],
    translators: ['packages/db/src/services/issue-credit-note.ts'],
  },
  {
    code: 'ZE001',
    rule: 'An accounting period may not be closed while its trial balance does not balance.',
    migration: '0073',
    raisedBy: ['assert_period_closeable'],
    translators: ['packages/db/src/services/period-close.ts'],
  },
  {
    code: 'ZE002',
    rule: 'An accounting period may not be closed while documents dated in it are unposted.',
    migration: '0073',
    raisedBy: ['assert_period_closeable'],
    translators: ['packages/db/src/services/period-close.ts'],
  },
  {
    code: 'ZF001',
    rule: 'A published flow definition is append-only: an edit is a new version.',
    migration: '0070',
    raisedBy: ['refuse_flow_definition_change'],
    translators: ['packages/db/src/repositories/flow.ts'],
  },
  {
    code: 'ZF002',
    rule: 'An enrolment may not be re-pinned onto another flow version once it is running.',
    migration: '0070',
    raisedBy: ['refuse_flow_enrolment_repin'],
    translators: ['packages/db/src/repositories/flow.ts'],
  },
  {
    code: 'ZG001',
    rule: 'A package template version and a package sale are immutable: an edit is version + 1.',
    migration: '0078',
    raisedBy: ['package_row_is_immutable', 'package_sale_terms_are_immutable'],
    translators: ['packages/db/src/services/sell-package.ts'],
  },
  {
    code: 'ZG002',
    rule: "A package sale's snapshotted terms must match the template version it names, unless it is a reconstruction held to its workbook row instead (0119).",
    migration: '0119',
    raisedBy: ['package_sale_terms_match_version'],
    translators: ['packages/db/src/services/sell-package.ts'],
  },
  {
    code: 'ZG003',
    rule: 'A package template line may not name an archived service.',
    migration: '0078',
    raisedBy: ['package_template_line_service_not_archived'],
    translators: ['packages/db/src/services/sell-package.ts'],
  },
  {
    code: 'ZG004',
    rule: 'A package template version must have at least one line.',
    migration: '0078',
    raisedBy: ['package_template_version_has_lines'],
    translators: ['packages/db/src/services/sell-package.ts'],
  },
  {
    code: 'ZG005',
    rule: "A package sale's journal entry must be dated on the sale's own business day and post deferred revenue.",
    migration: '0078',
    raisedBy: ['package_sale_posts_deferred_revenue_only'],
    translators: ['packages/db/src/services/sell-package.ts'],
  },
  {
    code: 'ZG006',
    rule: 'A package sale must open one balance per line of the version it names, summing to the price.',
    migration: '0078',
    raisedBy: ['package_balance_shares_sum_to_the_price'],
    translators: ['packages/db/src/services/sell-package.ts'],
  },
  {
    code: 'ZG007',
    rule: 'A package redemption is immutable: the correction is a reversing entry and a new redemption.',
    migration: '0083',
    raisedBy: ['package_redemption_is_immutable'],
    translators: ['packages/db/src/services/redeem-package.ts'],
  },
  {
    code: 'ZG008',
    rule: "A redemption's release entry must be dated on the business day the treatment was delivered.",
    migration: '0083',
    raisedBy: ['package_redemption_posts_the_release'],
    translators: ['packages/db/src/services/redeem-package.ts'],
  },
  {
    code: 'ZG009',
    rule: 'A release-through figure may not be computed from a NULL value, total or redeemed count.',
    migration: '0083',
    raisedBy: ['package_balance_drawdown_matches_its_redemptions', 'package_release_through_fils'],
    translators: ['packages/db/src/services/redeem-package.ts'],
  },
  {
    code: 'ZG010',
    rule: 'A redemption must be inside the validity of the sale its balance belongs to.',
    migration: '0083',
    raisedBy: ['package_redemption_is_in_time'],
    translators: ['packages/db/src/services/redeem-package.ts'],
  },
  {
    code: 'ZG011',
    rule: 'An appointment already charged on an invoice may not also be redeemed from a package.',
    migration: '0083',
    raisedBy: ['invoice_appointment_not_redeemed', 'package_redemption_not_charged'],
    translators: ['packages/db/src/services/redeem-package.ts'],
  },
  {
    code: 'ZG012',
    rule: 'A payment against a package sale must name a sale that exists and equal what it draws down.',
    migration: '0083',
    raisedBy: ['payment_within_the_document'],
    translators: ['packages/db/src/services/redeem-package.ts'],
  },
  {
    code: 'ZH001',
    rule: 'A leave movement is append-only: a correction is a further movement.',
    migration: '0066',
    raisedBy: ['refuse_leave_movement_change'],
    translators: [],
  },
  {
    code: 'ZI001',
    rule: "An invoice's totals must be the sum of its lines.",
    migration: '0026',
    raisedBy: ['assert_invoice_totals_match_lines'],
    translators: ['packages/db/src/repositories/invoice.ts'],
  },
  {
    code: 'ZI002',
    rule: 'An invoice must have at least one line.',
    migration: '0026',
    raisedBy: ['assert_invoice_totals_match_lines'],
    translators: ['packages/db/src/repositories/invoice.ts'],
  },
  {
    code: 'ZI003',
    rule: 'An issued invoice is append-only: it is corrected with a credit note, never by editing it.',
    migration: '0026',
    raisedBy: ['refuse_invoice_change'],
    translators: ['packages/db/src/repositories/invoice.ts'],
  },
  {
    code: 'ZJ001',
    rule: 'An intake form template is immutable: an edit is the next version for its locale.',
    migration: '0082',
    raisedBy: ['clinical.forbid_intake_template_edit'],
    translators: [],
  },
  {
    code: 'ZJ002',
    rule: "A new intake template must be numbered above its locale's current version.",
    migration: '0082',
    raisedBy: ['clinical.enforce_intake_template_version'],
    translators: [],
  },
  {
    code: 'ZJ003',
    rule: 'An intake answer may not be stored without a live treatment consent against that template wording.',
    migration: '0082',
    raisedBy: ['clinical.enforce_intake_consent'],
    translators: [],
  },
  {
    code: 'ZJ004',
    rule: 'An intake submission must claim the version its template is actually at.',
    migration: '0082',
    raisedBy: ['clinical.enforce_intake_submission_version'],
    translators: [],
  },
  {
    code: 'ZJ005',
    rule: 'A real intake payload may not be stored while the residency question is open.',
    migration: '0082',
    raisedBy: ['clinical.enforce_intake_residency'],
    translators: [],
  },
  {
    code: 'ZJ006',
    rule: 'A step-up grant is immutable except for its revocation.',
    migration: '0082',
    raisedBy: ['clinical.forbid_step_up_grant_edit'],
    translators: [],
  },
  {
    code: 'ZK001',
    rule: 'Nothing may be sealed while no KEK version is active.',
    migration: '0043',
    raisedBy: ['clinical.enforce_sealed_row_writes'],
    translators: [],
  },
  {
    code: 'ZK002',
    rule: 'A sealed row may not have its ciphertext, nonce or identity changed by an update.',
    migration: '0043',
    raisedBy: ['clinical.enforce_sealed_row_writes'],
    translators: [],
  },
  {
    code: 'ZK003',
    rule: 'A re-wrap onto a new KEK must actually rewrite the wrapped data key.',
    migration: '0043',
    raisedBy: ['clinical.enforce_sealed_row_writes'],
    translators: [],
  },
  {
    code: 'ZK005',
    rule: 'A retired KEK version may not be reactivated: rotation is one-way.',
    migration: '0043',
    raisedBy: ['clinical.forbid_kek_reactivation'],
    translators: [],
  },
  {
    code: 'ZL001',
    rule: 'The journal is append-only: a posting is corrected with a dated reversal.',
    migration: '0018',
    raisedBy: ['refuse_journal_change'],
    translators: ['packages/db/src/repositories/journal.ts'],
  },
  {
    code: 'ZL002',
    rule: 'Nothing may be posted, punched or dated into a locked accounting period.',
    migration: '0073',
    raisedBy: ['raise_if_period_locked'],
    translators: [
      'packages/db/src/repositories/journal.ts',
      'packages/db/src/repositories/timesheet.ts',
    ],
  },
  {
    code: 'ZL003',
    rule: 'A journal entry must have at least two lines and balance.',
    migration: '0018',
    raisedBy: ['assert_entry_balanced'],
    translators: ['packages/db/src/repositories/journal.ts'],
  },
  {
    code: 'ZL004',
    rule: 'Nothing may be posted dated before the day the books open.',
    migration: '0027',
    raisedBy: ['refuse_entry_before_opening'],
    translators: ['packages/db/src/services/opening-balances.ts'],
  },
  {
    code: 'ZM001',
    rule: "A message template's class is immutable: a reclassification is a new version.",
    migration: '0061',
    raisedBy: ['refuse_message_class_change'],
    translators: ['packages/db/src/repositories/message-template.ts'],
  },
  {
    code: 'ZM002',
    rule: 'An approval state may only move along a declared transition.',
    migration: '0061',
    raisedBy: ['refuse_template_variant_change'],
    translators: ['packages/db/src/repositories/message-template.ts'],
  },
  {
    code: 'ZM003',
    rule: 'An approved template variant may not be edited in place.',
    migration: '0061',
    raisedBy: ['refuse_template_variant_change'],
    translators: ['packages/db/src/repositories/message-template.ts'],
  },
  {
    code: 'ZM004',
    rule: "A message's class must match the template it names, and the template must exist.",
    migration: '0061',
    raisedBy: ['assert_message_class_matches_template'],
    translators: ['packages/db/src/repositories/message-template.ts'],
  },
  {
    code: 'ZN001',
    rule: 'An obligation reminder must be addressed to the role the obligation declares as its owner.',
    migration: '0060',
    raisedBy: ['assert_obligation_notice_names_an_accountable_role'],
    translators: ['packages/db/src/services/obligation-notice.ts'],
  },
  {
    code: 'ZN002',
    rule: 'A settled obligation notice may not be resurrected.',
    migration: '0060',
    raisedBy: ['refuse_obligation_notice_resurrection'],
    translators: ['packages/db/src/services/obligation-notice.ts'],
  },
  {
    code: 'ZO001',
    rule: 'An obligation may only be completed as the role that owns it.',
    migration: '0052',
    raisedBy: ['assert_obligation_completion_is_permitted'],
    translators: ['packages/db/src/services/obligation.ts'],
  },
  {
    code: 'ZO002',
    rule: 'An obligation that requires evidence may not be completed without an attachment.',
    migration: '0052',
    raisedBy: ['assert_obligation_completion_is_permitted'],
    translators: ['packages/db/src/services/obligation.ts'],
  },
  {
    code: 'ZO003',
    rule: 'Whether an obligation blocks, and what it blocks, is not configuration: only its due date may change.',
    migration: '0052',
    raisedBy: ['refuse_obligation_shape_change'],
    translators: ['packages/db/src/services/obligation.ts'],
  },
  {
    code: 'ZO004',
    rule: 'Obligation evidence is append-only: a corrected attachment is a new row.',
    migration: '0052',
    raisedBy: ['refuse_obligation_evidence_change'],
    translators: ['packages/db/src/services/obligation.ts'],
  },
  {
    code: 'ZP001',
    rule: 'Consent wording is append-only: the exact words shown are what a consent record proves.',
    migration: '0056',
    raisedBy: ['refuse_consent_wording_change'],
    translators: ['packages/db/src/repositories/consent.ts'],
  },
  {
    code: 'ZP002',
    rule: 'A consent record must name wording that carries a content hash.',
    migration: '0056',
    raisedBy: ['assert_consent_wording_hash'],
    translators: ['packages/db/src/repositories/consent.ts'],
  },
  {
    code: 'ZP003',
    rule: 'Consent is append-only: a withdrawal or a correction is a new row.',
    migration: '0056',
    raisedBy: ['refuse_consent_change'],
    translators: ['packages/db/src/repositories/consent.ts'],
  },
  {
    code: 'ZQ001',
    rule: 'Suppression is append-only: coming off the list is a new row with its own actor and reason.',
    migration: '0064',
    raisedBy: ['refuse_suppression_change'],
    translators: ['packages/db/src/repositories/suppression.ts'],
  },
  {
    code: 'ZR001',
    rule: "A recurring cost's period history is append-only.",
    migration: '0031',
    raisedBy: ['refuse_recurring_cost_history_change'],
    translators: ['packages/db/src/services/recurring-cost.ts'],
  },
  {
    code: 'ZR002',
    rule: 'A bill matched to a recurring cost must be from the supplier that cost is billed by.',
    migration: '0031',
    raisedBy: ['assert_matched_bill_is_from_the_cost_supplier'],
    translators: ['packages/db/src/services/recurring-cost.ts'],
  },
  {
    code: 'ZR003',
    rule: 'A recurring cost cadence this schedule cannot step is refused rather than guessed.',
    migration: '0031',
    raisedBy: ['recurring_cost_period_months'],
    translators: ['packages/db/src/services/recurring-cost.ts'],
  },
  {
    code: 'ZS002',
    rule: 'A sealed staff row may not have its ciphertext, nonce or identity changed by an update.',
    migration: '0050',
    raisedBy: ['enforce_staff_sealed_row_writes'],
    translators: [],
  },
  {
    code: 'ZS003',
    rule: 'A staff re-wrap onto a new key version must actually rewrite the wrapped key.',
    migration: '0050',
    raisedBy: ['enforce_employee_document_sealed_writes', 'enforce_staff_sealed_row_writes'],
    translators: [],
  },
  {
    code: 'ZS004',
    rule: 'An employee document carrying a sealed number may not be moved to another employee.',
    migration: '0050',
    raisedBy: ['enforce_employee_document_sealed_writes'],
    translators: [],
  },
  {
    code: 'ZS005',
    rule: "An employee document's recorded sealed number may not be cleared back to NULL.",
    migration: '0050',
    raisedBy: ['enforce_employee_document_sealed_writes'],
    translators: [],
  },
  {
    code: 'ZS006',
    rule: 'Whether a staff document expires may not be left unstated while no regulatory profile is in force.',
    migration: '0054',
    raisedBy: ['enforce_employee_document_expiry_is_declared'],
    translators: [],
  },
  {
    code: 'ZT001',
    rule: 'A payment may not take a document above what it is payable for.',
    migration: '0083',
    raisedBy: ['payment_within_the_document'],
    translators: ['packages/db/src/adapters/manual-payment.ts'],
  },
  {
    code: 'ZT002',
    rule: 'A tender kind that gives no change may not record any.',
    migration: '0068',
    raisedBy: ['tender_row_matches_its_type'],
    translators: ['packages/db/src/adapters/manual-payment.ts'],
  },
  {
    code: 'ZT003',
    rule: 'A tender kind that requires a reference may not be recorded without one.',
    migration: '0068',
    raisedBy: ['tender_row_matches_its_type'],
    translators: ['packages/db/src/adapters/manual-payment.ts'],
  },
  {
    code: 'ZT004',
    rule: 'A refund may not exceed what was applied to the document.',
    migration: '0068',
    raisedBy: ['refund_within_the_payments'],
    translators: ['packages/db/src/adapters/manual-payment.ts'],
  },
  {
    code: 'ZT005',
    rule: 'A merge record and its per-table reports are append-only: an un-merge is a new operation.',
    migration: '0099',
    raisedBy: ['refuse_merge_record_change'],
    translators: ['packages/db/src/repositories/merge.ts'],
  },
  {
    code: 'ZT006',
    rule: 'The survivor of a new merge may not itself be a tombstone.',
    migration: '0099',
    raisedBy: ['assert_merge_survivor_is_live'],
    translators: ['packages/db/src/repositories/merge.ts'],
  },
  {
    code: 'ZT007',
    rule: 'Resolving a merge chain may not take more than 32 hops, which would mean the cycle guard is gone.',
    migration: '0099',
    raisedBy: ['merge_survivor_of'],
    translators: ['packages/db/src/repositories/merge.ts'],
  },
  {
    code: 'ZU001',
    rule: 'A cash session may not be closed with no counted amount.',
    migration: '0076',
    raisedBy: ['cash_session_is_closeable'],
    translators: ['packages/db/src/services/cash-session.ts'],
  },
  {
    code: 'ZU002',
    rule: 'A counted and closed cash session, and the cash movements behind it, refuse every edit.',
    migration: '0076',
    raisedBy: [
      'cash_drop_session_is_open',
      'refuse_cash_movement_change',
      'refuse_closed_cash_session_change',
    ],
    translators: ['packages/db/src/services/cash-session.ts'],
  },
  {
    code: 'ZU003',
    rule: 'A cash session or its adjustment may not be dated in a locked accounting period.',
    migration: '0076',
    raisedBy: ['cash_session_adjustment_is_postable', 'cash_session_is_closeable'],
    translators: ['packages/db/src/services/cash-session.ts'],
  },
  {
    code: 'ZU004',
    rule: 'A cash session that balanced exactly may not name a variance journal entry.',
    migration: '0076',
    raisedBy: ['cash_session_variance_is_posted'],
    translators: ['packages/db/src/services/cash-session.ts'],
  },
  {
    code: 'ZU005',
    rule: "A cash session's snapshotted figures must equal the rows they summarise.",
    migration: '0076',
    raisedBy: ['cash_session_reconciles_to_the_rows'],
    translators: ['packages/db/src/services/cash-session.ts'],
  },
  {
    code: 'ZU006',
    rule: 'Cash may not be recorded against a business day whose drawer has already been counted.',
    migration: '0076',
    raisedBy: ['refuse_cash_after_the_count'],
    translators: ['packages/db/src/services/cash-session.ts'],
  },
  {
    code: 'ZU007',
    rule: 'A cash session adjustment must name a cash session that exists.',
    migration: '0076',
    raisedBy: ['cash_session_adjustment_is_postable'],
    translators: ['packages/db/src/services/cash-session.ts'],
  },
  {
    code: 'ZU008',
    rule: "A pipeline card's stage may not change without a transition row recording exactly that move.",
    migration: '0099',
    raisedBy: ['assert_pipeline_card_move_is_recorded'],
    translators: ['packages/db/src/repositories/pipeline.ts'],
  },
  {
    code: 'ZU009',
    rule: 'The pipeline stage transition log is append-only: a correction is a new move.',
    migration: '0099',
    raisedBy: ['refuse_pipeline_transition_change'],
    translators: ['packages/db/src/repositories/pipeline.ts'],
  },
  {
    code: 'ZU010',
    rule: 'Pipeline stage positions must be 1..n with no duplicate and no gap.',
    migration: '0099',
    raisedBy: ['assert_pipeline_stage_positions_are_gapless'],
    translators: ['packages/db/src/repositories/pipeline.ts'],
  },
  {
    code: 'ZV001',
    rule: 'A line may not claim input VAT when the supplier held no TRN at the time of the bill.',
    migration: '0028',
    raisedBy: ['assert_recoverable_line_has_a_tax_invoice'],
    translators: ['packages/db/src/services/post-bill.ts'],
  },
  {
    code: 'ZV002',
    rule: "A bill's header totals must equal the sum of its lines, and it must have lines.",
    migration: '0039',
    raisedBy: ['assert_bill_totals_match_lines'],
    translators: ['packages/db/src/services/post-bill.ts'],
  },
  {
    code: 'ZV003',
    rule: 'A supplier with no tax profile has an unstated residency and may not be billed from.',
    migration: '0028',
    raisedBy: ['assert_supplier_has_tax_profile', 'bill_supplier_tax_snapshot'],
    translators: ['packages/db/src/services/post-bill.ts'],
  },
  {
    code: 'ZV004',
    rule: 'A purchase document is append-only: a wrong bill is answered by a reversal and a fresh bill.',
    migration: '0028',
    raisedBy: ['refuse_purchase_document_change'],
    translators: ['packages/db/src/services/post-bill.ts'],
  },
  {
    code: 'ZV005',
    rule: 'A line may not claim input VAT on an account classified as blocked for recovery.',
    migration: '0034',
    raisedBy: ['assert_line_matches_account_recoverability'],
    translators: ['packages/db/src/services/post-bill.ts'],
  },
  {
    code: 'ZV006',
    rule: 'A line treated as blocked input VAT must sit on an account classified as blocked.',
    migration: '0034',
    raisedBy: ['assert_line_matches_account_recoverability'],
    translators: ['packages/db/src/services/post-bill.ts'],
  },
  {
    code: 'ZV007',
    rule: 'A line claiming reverse-charge input VAT must sit on an account classified for it.',
    migration: '0039',
    raisedBy: ['assert_reverse_charge_matches_place_of_supply'],
    translators: ['packages/db/src/services/post-bill.ts'],
  },
  {
    code: 'ZV008',
    rule: 'An imported service must account for reverse-charge VAT on both sides.',
    migration: '0039',
    raisedBy: ['assert_reverse_charge_matches_place_of_supply'],
    translators: ['packages/db/src/services/post-bill.ts'],
  },
  {
    code: 'ZW001',
    rule: 'The marketing frequency cap must be a whole number of at least 1 and cannot be switched off.',
    migration: '0080',
    raisedBy: ['assert_frequency_cap_is_a_real_cap'],
    translators: [],
  },
  {
    code: 'ZW002',
    rule: 'A counted send may not be re-dated or un-counted: a later success is a new row.',
    migration: '0080',
    raisedBy: ['assert_frequency_ledger_count_is_immutable'],
    translators: [],
  },
  {
    code: 'ZW003',
    rule: 'A rota version whose assignments are unchanged from the one it supersedes may not be published.',
    migration: '0081',
    raisedBy: ['refuse_unchanged_rota_version'],
    translators: [],
  },
  {
    code: 'ZW004',
    rule: 'A rota publication notice is append-only: it is the record that somebody was told.',
    migration: '0081',
    raisedBy: ['refuse_rota_publication_notice_edit'],
    translators: [],
  },
  {
    code: 'ZW005',
    rule: "A rota version's number and period must follow from the version it supersedes.",
    migration: '0081',
    raisedBy: ['assert_rota_version_sequence'],
    translators: [],
  },
  {
    code: 'ZW006',
    rule: 'A published rota version and its assignments are immutable: an edit is a new version.',
    migration: '0099',
    raisedBy: ['refuse_published_rota_change'],
    translators: [],
  },
  {
    code: 'ZW007',
    rule: 'A rota change request is append-only: a refused request is answered by a new request.',
    migration: '0099',
    raisedBy: ['refuse_rota_change_request_edit'],
    translators: [],
  },
  {
    code: 'ZX001',
    rule: 'Attendance is append-only: a punch is corrected by a dated attendance_correction.',
    migration: '0086',
    raisedBy: ['refuse_attendance_change'],
    translators: ['packages/db/src/repositories/timesheet.ts'],
  },
  {
    code: 'ZX002',
    rule: 'Attendance punches must alternate: two clock-ins with no clock-out between them are refused.',
    migration: '0086',
    raisedBy: ['assert_attendance_punch_alternates'],
    translators: ['packages/db/src/repositories/timesheet.ts'],
  },
  {
    code: 'ZX003',
    rule: 'A punch that belongs to no trading date, even widened by the grace rule, is refused.',
    migration: '0086',
    raisedBy: ['assert_attendance_trading_date'],
    translators: ['packages/db/src/repositories/timesheet.ts'],
  },
  {
    code: 'ZX004',
    rule: 'A punch inside an approved timesheet period is refused: payroll has already paid those minutes.',
    migration: '0086',
    raisedBy: ['assert_attendance_period_not_approved'],
    translators: ['packages/db/src/repositories/timesheet.ts'],
  },
  {
    code: 'ZX005',
    rule: 'A timesheet may only be approved against a rota version whose period covers it.',
    migration: '0086',
    raisedBy: ['assert_timesheet_approval_follows'],
    translators: ['packages/db/src/repositories/timesheet.ts'],
  },
  {
    code: 'ZX006',
    rule: 'The promotional send window may only ever be narrowed inside 07:00-21:00, and must actually open.',
    migration: '0099',
    raisedBy: ['assert_promotional_window_is_a_narrowing'],
    translators: [],
  },
  {
    code: 'ZY001',
    rule: 'A rights request may not be deleted: the record is the evidence it was answered in time.',
    migration: '0085',
    raisedBy: ['refuse_rights_request_rewrite'],
    translators: ['packages/db/src/repositories/rights.ts'],
  },
  {
    code: 'ZY002',
    rule: "A rights request's deadline columns may not change.",
    migration: '0085',
    raisedBy: ['refuse_rights_request_rewrite'],
    translators: ['packages/db/src/repositories/rights.ts'],
  },
  {
    code: 'ZY003',
    rule: 'A rights request may not leave a terminal state.',
    migration: '0085',
    raisedBy: ['refuse_rights_request_rewrite'],
    translators: ['packages/db/src/repositories/rights.ts'],
  },
  {
    code: 'ZY004',
    rule: 'A rights resolution, its per-class accounting and its export log are append-only.',
    migration: '0085',
    raisedBy: ['refuse_rights_record_change'],
    translators: ['packages/db/src/repositories/rights.ts'],
  },
  {
    code: 'ZY005',
    rule: 'A DEK destruction record is append-only: it is the record that health data was destroyed.',
    migration: '0085',
    raisedBy: ['clinical.refuse_dek_destruction_change'],
    translators: ['packages/db/src/repositories/rights.ts'],
  },
  {
    code: 'ZY006',
    rule: 'Clinical data may only be destroyed or counted under an in-progress erasure request naming that customer.',
    migration: '0085',
    raisedBy: [
      'public.clinical_erasure_census',
      'public.delete_customer_contraindications',
      'public.destroy_customer_deks',
    ],
    translators: ['packages/db/src/repositories/rights.ts'],
  },
  {
    code: 'ZY007',
    rule: 'Workflow rows may only be removed under an in-progress erasure request naming that customer.',
    migration: '0085',
    raisedBy: ['public.erase_customer_workflow_rows'],
    translators: [],
  },
  {
    code: 'ZY008',
    rule: 'The workflow erasure function refuses a table it does not statically remove rows from.',
    migration: '0085',
    raisedBy: ['public.erase_customer_workflow_rows'],
    translators: [],
  },
  {
    code: 'ZY009',
    rule: 'Every account must carry exactly one VAT201 box mapping saying whether it feeds the return.',
    migration: '0089',
    raisedBy: ['vat201_mapping_is_complete'],
    translators: [],
  },
  {
    code: 'ZY010',
    rule: 'A VAT201 measure must be one the account type can hold.',
    migration: '0089',
    raisedBy: ['vat201_measure_matches_the_account'],
    translators: [],
  },
  {
    code: 'ZY011',
    rule: 'The flow step log is append-only: it is what "why did this contact get this message" is answered from.',
    migration: '0091',
    raisedBy: ['refuse_flow_step_log_change'],
    translators: ['packages/db/src/repositories/flow-run.ts'],
  },
  {
    code: 'ZY012',
    rule: 'A flow node effect may not be deleted, nor updated except by a merge re-pointing its contact.',
    migration: '0091',
    raisedBy: ['refuse_flow_node_effect_change'],
    translators: ['packages/db/src/repositories/flow-run.ts'],
  },
  {
    code: 'ZY013',
    rule: 'A dry run may not leave a side effect or claim an idempotency token.',
    migration: '0091',
    raisedBy: ['refuse_dry_run_side_effect'],
    translators: ['packages/db/src/repositories/flow-run.ts'],
  },
  {
    code: 'ZY014',
    rule: "A flow run's mode and enrolment may not change once it exists.",
    migration: '0091',
    raisedBy: ['refuse_flow_run_reidentification'],
    translators: ['packages/db/src/repositories/flow-run.ts'],
  },
  // ZY015-ZY020 are P-HR-09's, ADOPTED as inventory rather than reallocated: 0092 had already raised them in
  // a worktree this unit could not see, and a class cannot be recalled from a branch that has shipped it.
  {
    code: 'ZY015',
    rule: 'A leave approval and its override rows are append-only: a withdrawal is a cancellation row.',
    migration: '0092',
    raisedBy: ['refuse_leave_approval_record_edit'],
    translators: [],
  },
  {
    code: 'ZY016',
    rule: 'A leave-conflict override may be taken only by the owner or a manager.',
    migration: '0092',
    raisedBy: ['refuse_unauthorised_leave_override'],
    translators: [],
  },
  {
    code: 'ZY017',
    rule: 'A leave-approval delegation whose window never opens is refused when it is written.',
    migration: '0092',
    raisedBy: ['refuse_unusable_leave_delegation'],
    translators: [],
  },
  {
    code: 'ZY018',
    rule: "An approval may not cite another deputy's delegation, or one whose window it falls outside.",
    migration: '0092',
    raisedBy: ['assert_leave_approval_matches_request'],
    translators: [],
  },
  {
    code: 'ZY019',
    rule: 'An approval record may only exist against a leave request whose status is approved.',
    migration: '0092',
    raisedBy: ['assert_leave_approval_matches_request'],
    translators: [],
  },
  {
    code: 'ZY020',
    rule: 'A full day of leave is stored over its trading session, never over calendar midnight.',
    migration: '0092',
    raisedBy: ['assert_leave_period_is_not_calendar_bounded'],
    translators: [],
  },
  // ZY051-ZY057 are M-VAT-07's and M-VAT-08's, adopted as inventory on the same terms as ZY015-ZY020: 0095
  // had already raised them, a filed return is the last thing to move a refusal code under, and the class
  // stopped identifying a file at 0091. They were allocated in the wave before this registry existed, which is
  // why they arrive here as a merge rather than through `pnpm sqlstate`.
  {
    code: 'ZY051',
    rule: 'A filed VAT return, its lines and its sign-offs are append-only for every role, the owner included.',
    migration: '0095',
    raisedBy: ['refuse_vat_return_change'],
    translators: ['packages/db/src/services/vat-return-signoff.ts'],
  },
  {
    code: 'ZY052',
    rule: 'The two signatures on a VAT return must be two different people.',
    migration: '0095',
    raisedBy: ['assert_vat_return_sign_off_is_a_second_person'],
    translators: ['packages/db/src/services/vat-return-signoff.ts'],
  },
  {
    code: 'ZY053',
    rule: 'A VAT return may only be signed in a role permitted to sign it, deny-by-default.',
    migration: '0095',
    raisedBy: ['assert_vat_return_sign_off_is_a_second_person'],
    translators: ['packages/db/src/services/vat-return-signoff.ts'],
  },
  {
    code: 'ZY054',
    rule: 'An amendment restates one period as the next version, naming the version in force and why.',
    migration: '0095',
    raisedBy: ['assert_vat_return_amendment'],
    translators: ['packages/db/src/services/vat-return-signoff.ts'],
  },
  {
    code: 'ZY055',
    rule: 'A VAT return may not be marked final, or read for filing, until two different people have signed it.',
    migration: '0095',
    raisedBy: ['assert_vat_return_is_signed_off', 'vat_return_for_filing'],
    translators: ['packages/db/src/services/vat-return-signoff.ts'],
  },
  {
    code: 'ZY056',
    rule: 'The VAT201 engine signature must hash exactly the functions the catalogue names, no more and no fewer.',
    migration: '0095',
    raisedBy: ['vat201_engine_signature'],
    translators: ['packages/db/src/services/vat-return-signoff.ts'],
  },
  {
    code: 'ZY057',
    rule: 'A VAT return sign-off must write its audit_event in the same transaction that commits it.',
    migration: '0095',
    raisedBy: ['assert_vat_return_act_is_audited'],
    translators: ['packages/db/src/services/vat-return-signoff.ts'],
  },
  // ZY061-ZY066 are A-FIRST-01's, on the same adoption terms. Five of the six are about the analytics schema
  // refusing to report success over nothing: a row with no partition, a table with no retention policy, a
  // policy naming no table, a bounds read of a relation that is not partitioned, and a look-ahead that creates
  // none.
  {
    code: 'ZY061',
    rule: 'An analytics row for a month with no partition is refused, never kept in a default partition.',
    migration: '0096',
    raisedBy: ['analytics.refuse_uncovered_insert'],
    translators: [],
  },
  {
    code: 'ZY062',
    rule: 'Every base table in the analytics schema must have a retention_policy row saying what retention does to it.',
    migration: '0096',
    raisedBy: ['analytics.run_retention'],
    translators: [],
  },
  {
    code: 'ZY063',
    rule: 'A retention policy may only name a base table that exists in the analytics schema.',
    migration: '0096',
    raisedBy: ['analytics.run_retention'],
    translators: [],
  },
  {
    code: 'ZY064',
    rule: 'Partition bounds may only be read for a relation that is a partition.',
    migration: '0096',
    raisedBy: ['analytics.partition_bounds'],
    translators: [],
  },
  {
    code: 'ZY065',
    rule: 'A collected analytics event is append-only: retention drops whole partitions and never edits a row.',
    migration: '0096',
    raisedBy: ['analytics.refuse_event_mutation'],
    translators: [],
  },
  {
    code: 'ZY066',
    rule: 'A partition look-ahead must be forward: a negative one creates nothing while reporting success.',
    migration: '0096',
    raisedBy: ['analytics.ensure_partitions'],
    translators: [],
  },
  // ZY071-ZY077 are P-HR-11's, adopted as inventory on the same terms as the three bands above: 0097 was
  // written in a worktree that predates this registry, and it took a subclass RANGE under 0091's rule rather
  // than a class. ZY078-ZY080 of its allocated band are unused and are NOT registered — an entry for a code
  // nothing raises is what the stale-entry direction refuses, and it would be permission to invent a second
  // rule on the same code later.
  {
    code: 'ZY071',
    rule: 'A published commission rule version and its bands are immutable for every role, the owner included.',
    migration: '0097',
    raisedBy: ['refuse_commission_rule_change'],
    translators: ['packages/db/src/repositories/commission.ts'],
  },
  {
    code: 'ZY072',
    rule: 'A commission run and its lines are append-only: a run that is wrong is a new run.',
    migration: '0097',
    raisedBy: ['refuse_commission_run_change'],
    translators: ['packages/db/src/repositories/commission.ts'],
  },
  {
    code: 'ZY073',
    rule: "A rule version's bands must cover the value range from zero upwards, ascending and without a gap.",
    migration: '0097',
    raisedBy: ['assert_commission_bands_cover_from_zero'],
    translators: ['packages/db/src/repositories/commission.ts'],
  },
  {
    code: 'ZY074',
    rule: 'A commission run header must equal the sum of its lines at COMMIT.',
    migration: '0097',
    raisedBy: ['assert_commission_run_matches_its_lines'],
    translators: ['packages/db/src/repositories/commission.ts'],
  },
  {
    code: 'ZY075',
    rule: 'A commission run may only name a rule version that had commenced over the period it covers.',
    migration: '0097',
    raisedBy: ['assert_commission_run_version_had_commenced'],
    translators: ['packages/db/src/repositories/commission.ts'],
  },
  {
    code: 'ZY076',
    rule: "A run over a closed period must read its figures as of that period's lock, never as of now.",
    migration: '0097',
    raisedBy: ['assert_commission_run_reads_the_lock'],
    translators: ['packages/db/src/repositories/commission.ts'],
  },
  {
    code: 'ZY077',
    rule: "Every line's band, rate and figure must follow from the version the run pins.",
    migration: '0097',
    raisedBy: ['assert_commission_line_follows_its_rule', 'commission_fils_for'],
    translators: ['packages/db/src/repositories/commission.ts'],
  },
  // ZY081-ZY084 are C-AUTO-05's, on the same adoption terms. Four codes and not one because each has its own
  // runbook answer, which is 0061's argument for a private code at all.
  {
    code: 'ZY081',
    rule: 'A messaging control row may only name a key in the closed set of controls.',
    migration: '0098',
    raisedBy: ['refuse_messaging_control_change'],
    translators: [],
  },
  {
    code: 'ZY082',
    rule: 'A messaging control may only be toggled by a role permitted to toggle it.',
    migration: '0098',
    raisedBy: ['refuse_messaging_control_change'],
    translators: [],
  },
  {
    code: 'ZY083',
    rule: 'A messaging control may not be toggled without a reason.',
    migration: '0098',
    raisedBy: ['refuse_messaging_control_change'],
    translators: [],
  },
  {
    code: 'ZY084',
    rule: 'A messaging control row may not be DELETEd: removal is a disengagement no audit event would record.',
    migration: '0098',
    raisedBy: ['refuse_messaging_control_delete'],
    translators: [],
  },
  {
    code: 'ZY111',
    rule: 'A single-use private document may not be fetched a second time with the same signature.',
    migration: '0101',
    raisedBy: ['assert_single_use_document_not_replayed'],
    translators: ['packages/db/src/repositories/private-document.ts'],
  },
  {
    code: 'ZY112',
    rule: 'The private-document register and its fetch log are append-only: UPDATE and DELETE raise.',
    migration: '0101',
    raisedBy: ['refuse_private_document_rewrite'],
    translators: [],
  },
  {
    code: 'ZY113',
    rule: "A private document's class must be one @berelax/core's catalogue declares.",
    migration: '0101',
    raisedBy: ['assert_private_document_class_known'],
    translators: [],
  },
  // ZY141-ZY150 are P-HR-12's, all ten of the band. Ten codes and not one because each has a different
  // runbook answer — "correct it with a new run", "complete the run first", "record an attendance
  // correction" and "name a liability account" are four different things to go and do, which is 0061's
  // argument for a private code at all.
  {
    code: 'ZY141',
    rule: 'A completed payroll run may not be updated, and no payroll run may be deleted.',
    migration: '0104',
    raisedBy: ['refuse_completed_payroll_run_change'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  {
    code: 'ZY142',
    rule: 'A draft payroll run may only be completed, never otherwise edited.',
    migration: '0104',
    raisedBy: ['refuse_payroll_run_draft_edit'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  {
    code: 'ZY143',
    rule: 'A second payroll run over a period must name the completed run it corrects, over that same period.',
    migration: '0104',
    raisedBy: ['assert_payroll_correction_names_its_original'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  {
    code: 'ZY144',
    rule: 'A payslip, tip, deduction or WPS export row may not be updated or deleted.',
    migration: '0104',
    raisedBy: ['refuse_payroll_record_change'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  {
    code: 'ZY145',
    rule: 'A payroll run may not cover a period whose approved timesheets count an INCOMPLETE presence.',
    migration: '0104',
    raisedBy: ['assert_payroll_run_over_closed_attendance'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  {
    code: 'ZY146',
    rule: 'A tip must be owed against an account whose type is liability, never revenue.',
    migration: '0104',
    raisedBy: ['assert_tip_is_owed_as_a_liability'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  {
    code: 'ZY147',
    rule: "A payslip's commission figure must name the run and rule version that produced it.",
    migration: '0104',
    raisedBy: ['assert_payslip_commission_is_pinned'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  {
    code: 'ZY148',
    rule: 'A payslip may not be added to a payroll run that has already been completed.',
    migration: '0104',
    raisedBy: ['assert_payslip_run_is_open'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  {
    code: 'ZY149',
    rule: "A WPS export must name a completed run and declare that run's own count and total.",
    migration: '0104',
    raisedBy: ['assert_wps_export_names_a_completed_run'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  {
    code: 'ZY150',
    rule: "A completed payroll run's payslip count and net total must equal its payslips.",
    migration: '0104',
    raisedBy: ['assert_completed_payroll_run_matches_its_payslips'],
    translators: ['packages/db/src/repositories/payroll.ts'],
  },
  // ZY161-ZY165 are Y-PAY-02's, five of the band ZY161-ZY170. Five and not one because each has a different
  // runbook answer: "write a new row", "find the gateway movement that justifies this", "your figures
  // disagree with your rows", "this is a redelivery, answer 200" and "that tender is taken at the desk" are
  // five different things to go and do, which is 0061's argument for a private code at all. ZY166-ZY170 are
  // unused and deliberately absent: an entry for a code no migration raises is direction 3.
  {
    code: 'ZY161',
    rule: 'A payment intent transaction row may not be updated or deleted.',
    migration: '0106',
    raisedBy: ['refuse_payment_intent_transaction_change'],
    translators: ['packages/db/src/repositories/payment-intent.ts'],
  },
  {
    code: 'ZY162',
    rule: "A payment intent's state or figures may change only by naming a new transaction row of its own.",
    migration: '0106',
    raisedBy: ['assert_payment_intent_moves_with_a_transaction'],
    translators: ['packages/db/src/repositories/payment-intent.ts'],
  },
  {
    code: 'ZY163',
    rule: "A payment intent's three figures must equal the sum of its append-only transaction rows.",
    migration: '0106',
    raisedBy: ['assert_payment_intent_matches_its_transactions'],
    translators: ['packages/db/src/repositories/payment-intent.ts'],
  },
  {
    code: 'ZY164',
    rule: 'One gateway event may be recorded against one payment intent only once.',
    migration: '0106',
    raisedBy: ['refuse_duplicate_payment_intent_event'],
    translators: ['packages/db/src/repositories/payment-intent.ts'],
  },
  {
    code: 'ZY165',
    rule: "A payment intent's instrument must be a tender kind whose adapter is the gateway.",
    migration: '0106',
    raisedBy: ['assert_payment_intent_instrument_is_a_gateway_kind'],
    translators: ['packages/db/src/repositories/payment-intent.ts'],
  },
  // ZY171-ZY177 are P-HR-13's, of the ZY171-ZY180 band; ZY178-ZY180 are left free. Seven and not one
  // because each names a different thing to go and do — among them "correct it with a reversal", "wait for
  // the period to close", "post the journal entry first", "end the employment first", "recompute the
  // liability" and "record a punch correction instead" — which is 0061's argument for a private code at
  // all.
  {
    code: 'ZY171',
    rule: 'A gratuity accrual, settlement or closed-period labour adjustment row may not be updated or deleted.',
    migration: '0107',
    raisedBy: ['refuse_gratuity_record_change'],
    translators: ['packages/db/src/repositories/gratuity.ts'],
  },
  {
    code: 'ZY172',
    rule: 'A correcting gratuity accrual must supersede one over the same employee and the same month.',
    migration: '0107',
    raisedBy: ['assert_gratuity_correction_names_its_original'],
    translators: ['packages/db/src/repositories/gratuity.ts'],
  },
  {
    code: 'ZY173',
    rule: "A gratuity accrual's entry must be a two-line gratuity_accrual posting debiting an expense account and crediting a liability account for the accrued amount.",
    migration: '0107',
    raisedBy: ['assert_gratuity_accrual_is_posted'],
    translators: ['packages/db/src/repositories/gratuity.ts'],
  },
  {
    code: 'ZY174',
    rule: 'A gratuity accrual for an open month is dated at its month end, and one for a locked month names that lock and is dated outside every lock.',
    migration: '0107',
    raisedBy: ['assert_gratuity_accrual_period'],
    translators: ['packages/db/src/repositories/gratuity.ts'],
  },
  {
    code: 'ZY175',
    rule: "A gratuity settlement must discharge exactly the employee's live accrued liability.",
    migration: '0107',
    raisedBy: ['assert_gratuity_settlement_clears_the_liability'],
    translators: ['packages/db/src/repositories/gratuity.ts'],
  },
  {
    code: 'ZY176',
    rule: 'A gratuity settlement may only be recorded for an employee whose employment has ended, and must snapshot that date.',
    migration: '0107',
    raisedBy: ['assert_gratuity_settlement_is_for_a_leaver'],
    translators: ['packages/db/src/repositories/gratuity.ts'],
  },
  {
    code: 'ZY177',
    rule: 'A closed-period labour adjustment must name the locked period containing the work and carry an entry dated outside every lock.',
    migration: '0107',
    raisedBy: ['assert_closed_period_labour_adjustment'],
    translators: ['packages/db/src/repositories/gratuity.ts'],
  },
  // ZY181-ZY185 are R-REP-01's, of the band ZY181-ZY190; ZY186-ZY190 are free and deliberately absent, for
  // the reason direction 3 of `pnpm sqlstate` gives. They were placed AFTER H-MIG-01's ZY191 block by a
  // merge that had nothing to conflict over — 0110's block and 0111's were added in one batch, in different
  // regions of this file — and `sqlstate-registry.test.ts` reads the file as a sequence, so the whole
  // registry was out of order on one silent auto-merge. Moved, never renumbered.
  {
    code: 'ZY181',
    rule: 'The reporting registry and the catalogue must declare the same set of materialised views.',
    migration: '0110',
    raisedBy: ['reporting.assert_views_are_refreshable'],
    translators: [],
  },
  {
    code: 'ZY182',
    rule: 'Every materialised view in the reporting schema must carry a unique index over plain columns, so a refresh can be concurrent.',
    migration: '0110',
    raisedBy: ['reporting.assert_views_are_refreshable'],
    translators: [],
  },
  {
    code: 'ZY183',
    rule: 'A reporting refresh may only name a view the registry declares.',
    migration: '0110',
    raisedBy: ['reporting.registered_or_refuse'],
    translators: [],
  },
  {
    code: 'ZY184',
    rule: 'A reporting refresh run is append-only.',
    migration: '0110',
    raisedBy: ['reporting.refuse_refresh_run_change'],
    translators: [],
  },
  {
    code: 'ZY185',
    rule: 'Every row of a reporting fact must be keyed on a trading date the business_day calendar holds.',
    migration: '0110',
    raisedBy: ['reporting.assert_business_day_keys'],
    translators: [],
  },
  // ZY191-ZY199 are H-MIG-01's, of the band ZY191-ZY200; ZY200 is left free and deliberately absent, because
  // an entry for a code no migration raises is direction 3. Nine and not one because every one of them names
  // a different thing to go and do — "resume the run that is already open", "correct it with a new import",
  // "re-open the run", "declare the table you are writing", "a corrected import is a new import", "record
  // where this row came from", "you have excluded every column", "finish the rows that are still pending" and
  // "provenance cannot address that relation" — which is 0061's argument for a private code at all. The two
  // that carry the unit's whole point are ZY196 and ZY198: the first is what makes "a row without provenance
  // cannot be inserted" a property of the database, and the second is the only rule in that schema whose
  // being absent LOSES DATA while reporting success, because a completed run with pending rows makes every
  // later import skip them as already imported.
  {
    code: 'ZY191',
    rule: 'A second live import run of the same importer and source file may not be open while one is still running.',
    migration: '0111',
    raisedBy: ['import_staging.assert_one_open_run'],
    translators: ['packages/migration/src/refusals.ts'],
  },
  {
    code: 'ZY192',
    rule: "A staged import row's run, line, hash and payload are fixed, its outcome may be reached only once, and it may not be deleted.",
    migration: '0111',
    raisedBy: ['import_staging.refuse_import_row_change'],
    translators: ['packages/migration/src/refusals.ts'],
  },
  {
    code: 'ZY193',
    rule: 'No row may be staged against an import run that has already finished.',
    migration: '0111',
    raisedBy: ['import_staging.assert_run_still_open'],
    translators: ['packages/migration/src/refusals.ts'],
  },
  {
    code: 'ZY194',
    rule: 'An import provenance row must name a target table the run declared.',
    migration: '0111',
    raisedBy: ['import_staging.assert_target_was_declared'],
    translators: ['packages/migration/src/refusals.ts'],
  },
  {
    code: 'ZY195',
    rule: 'An import provenance row may not be updated or deleted.',
    migration: '0111',
    raisedBy: ['import_staging.refuse_provenance_change'],
    translators: ['packages/migration/src/refusals.ts'],
  },
  {
    code: 'ZY196',
    rule: 'A staged import row may not be committed in the applied state without a provenance row naming it.',
    migration: '0111',
    raisedBy: ['import_staging.assert_applied_row_has_provenance'],
    translators: ['packages/migration/src/refusals.ts'],
  },
  {
    code: 'ZY197',
    rule: 'A content checksum must cover at least one column of its relation.',
    migration: '0111',
    raisedBy: ['import_staging.content_checksum'],
    translators: ['packages/migration/src/refusals.ts'],
  },
  {
    code: 'ZY198',
    rule: 'An import run may not be completed while any of its rows is still pending.',
    migration: '0111',
    raisedBy: ['import_staging.assert_run_has_no_pending_rows'],
    translators: ['packages/migration/src/refusals.ts'],
  },
  {
    code: 'ZY199',
    rule: 'A provenance coverage read must be over a relation with a single-column primary key.',
    migration: '0111',
    raisedBy: ['import_staging.unprovenanced_row_ids'],
    translators: ['packages/migration/src/refusals.ts'],
  },
  // ZY221 and ZY222 are A-FIRST-05's, of the band ZY221-ZY230; the other eight are left free and
  // deliberately absent, because an entry for a code no migration raises is direction 3. Two and not one
  // because each names a different thing to go and do: the first is "that count is the only evidence a
  // pre-consent visit happened, so do not lower it", and the second is "say which kind of date this is".
  // Both are refusals whose absence would be SILENT and would move a published figure — a denominator
  // quietly revised down, and nine hours a day of browsing counted as daytime trade — which is ADR 0043's
  // test for whether a rule earns a private code rather than an anonymous 23514.
  {
    code: 'ZY221',
    rule: 'An identifier-free pre-consent landing count may not be deleted, lowered, or moved to another day or route.',
    migration: '0116',
    raisedBy: ['analytics.refuse_pre_consent_landing_loss'],
    translators: ['packages/db/src/repositories/analytics.ts'],
  },
  {
    code: 'ZY222',
    rule: "A session's trading-date basis must agree with the business day it names: started_at is inside that day's open window exactly when the basis is `trading`.",
    migration: '0116',
    raisedBy: ['analytics.assert_session_trading_basis'],
    translators: ['packages/db/src/repositories/analytics.ts'],
  },
  {
    code: 'ZY231',
    rule: 'A payments column may not hold text shaped like a card number.',
    migration: '0117',
    raisedBy: ['refuse_card_shaped_payment_text'],
    translators: ['packages/db/src/repositories/payment-intent.ts'],
  },
  // ZY251-ZY258 are H-MIG-03's, of the band ZY251-ZY260; ZY259 and ZY260 are left free and deliberately
  // absent, because an entry for a code no migration raises is direction 3. Eight and not one because each
  // names a different thing to go and do — "a correction is a new file, a new hash and a new signature",
  // "state the expiry the holder's own copy carries", "that is not what this sale's terms say", "the remedy
  // is a reversing entry and a new sale", "import again against the file that was signed for", "the sale
  // does not say what the workbook says" and "this sale is held to nothing at all". The two that carry the
  // unit's whole point are ZY256 and ZY258: the first is the acceptance line "the sign-off is stored
  // immutably against the hash of the file it attests to", read from the row's own provenance because
  // `apply` is handed no run and no hash and could only guess; the second is what makes it impossible to
  // mark a sale `reconstructed` — which exempts it from 0078's ZG002 — and then be held to nothing in its
  // place, which is the one hole exempting another unit's constraint could leave.
  {
    code: 'ZY251',
    rule: 'An owner import sign-off may not be updated or deleted.',
    migration: '0119',
    raisedBy: ['import_staging.refuse_sign_off_change'],
    translators: ['packages/db/src/services/import-package-liability.ts'],
  },
  {
    code: 'ZY252',
    rule: "A reconstructed package sale must state the expiry its holder's own copy carries.",
    migration: '0119',
    raisedBy: ['package_sale_expiry_is_derived_or_stated'],
    translators: ['packages/db/src/services/import-package-liability.ts'],
  },
  {
    code: 'ZY253',
    rule: "A package sale that is not a reconstruction may not state an expiry other than its terms'.",
    migration: '0119',
    raisedBy: ['package_sale_expiry_is_derived_or_stated'],
    translators: ['packages/db/src/services/import-package-liability.ts'],
  },
  {
    code: 'ZY254',
    rule: "A package sale's expiry may not be changed after the fact.",
    migration: '0119',
    raisedBy: ['package_sale_expiry_is_immutable'],
    translators: ['packages/db/src/services/import-package-liability.ts'],
  },
  {
    code: 'ZY255',
    rule: 'A package reconstruction record may not be updated or deleted.',
    migration: '0119',
    raisedBy: ['refuse_imported_package_change'],
    translators: ['packages/db/src/services/import-package-liability.ts'],
  },
  {
    code: 'ZY256',
    rule: "A package reconstruction's sign-off must attest to the hash of the file its own provenance names.",
    migration: '0119',
    raisedBy: ['imported_package_sign_off_attests_to_its_file'],
    translators: ['packages/db/src/services/import-package-liability.ts'],
  },
  {
    code: 'ZY257',
    rule: "A reconstructed package sale's liability, session count and expiry must be the figures the reconstruction attests to.",
    migration: '0119',
    raisedBy: ['imported_package_matches_its_sale'],
    translators: ['packages/db/src/services/import-package-liability.ts'],
  },
  {
    code: 'ZY258',
    rule: "A package sale marked as a reconstruction must carry the reconstruction record that attests to it, and an opening drawdown must be the release formula's figure.",
    migration: '0119',
    raisedBy: ['package_sale_reconstruction_is_attested'],
    translators: ['packages/db/src/services/import-package-liability.ts'],
  },
  // ZY271-ZY273 are H-MIG-04's, of the band ZY271-ZY280; ZY274 through ZY280 are left free and
  // deliberately absent, because an entry for a code no migration raises is direction 3. Three and not one
  // because each names a different thing to go and do — "import the contact with no consent and capture it
  // at the next booking", "a correction is a new import against the corrected file", and "this code wrote a
  // record that does not describe what it did".
  //
  // ZY271 is the one that carries the unit. It is the consent floor as a property of the DATABASE: "every
  // imported customer gets marketing_consent = false with no flag able to change it" is a claim about an
  // importer's options, and a later unit, a job or a psql session can falsify it without touching the
  // importer at all. There is no `marketing_consent` column — 0056 made consent an append-only log, so the
  // floor is the ABSENCE of a row — and the only enforceable statement of an absence is a refusal.
  //
  // ZY273 is this unit's ZY256: the count every acceptance line is read off is `outcome = 'created'`, and a
  // record saying `created` with no customer behind it would report an import of people who are not in the
  // database while satisfying ZY196, because the record itself carries provenance.
  {
    code: 'ZY271',
    rule: 'A granted consent for a send-gating purpose may not be captured by an import.',
    migration: '0121',
    raisedBy: ['refuse_imported_promotional_consent'],
    translators: ['packages/db/src/services/import-contacts.ts'],
  },
  {
    code: 'ZY272',
    rule: 'An imported-contact record may not be updated or deleted.',
    migration: '0121',
    raisedBy: ['refuse_imported_contact_change'],
    translators: ['packages/db/src/services/import-contacts.ts'],
  },
  {
    code: 'ZY273',
    rule: "An imported-contact record must name a staged source row and its outcome must be that row's.",
    migration: '0121',
    raisedBy: ['assert_imported_contact_outcome'],
    translators: ['packages/db/src/services/import-contacts.ts'],
  },
  // ZY341-ZY342 are G-REV-06's, of the band ZY341-ZY350; ZY343 through ZY350 are left free and
  // deliberately absent, because an entry for a code no migration raises is direction 3.
  //
  // ZY341 is the one that carries the unit. There is no Business Profile API access in this build (ADR
  // 0005), so nothing in it has ever SEEN a reply on the listing: `posted_manually_at` records that a
  // person said they pasted one into Google. A claim with no claimant is not evidence of anything, and the
  // claimant is not a second column — it is the `audit_event` row, which this code refuses to let the
  // delivery commit without. ZZ004's shape, for ZZ004's reason.
  //
  // ZY342 is what G-REV-05 deferred here by name: the stored digest exists to be COMPARED, and a hash that
  // can be rewritten to match edited text is evidence of nothing. It bites only once a delivery timestamp
  // is set, because before that an owner may re-approve an edited reply and the append-only trail keeps
  // every hash they approved.
  {
    code: 'ZY341',
    rule: 'A manual posting of a reply must be attributed to a named staff actor by an audit_event in the same transaction.',
    migration: '0128',
    raisedBy: ['assert_manual_post_is_a_claim'],
    translators: ['packages/db/src/repositories/reviews.ts'],
  },
  {
    code: 'ZY342',
    rule: "A delivered reply's lint stamp and its delivery instant may not change.",
    migration: '0128',
    raisedBy: ['refuse_delivered_reply_change'],
    translators: ['packages/db/src/repositories/reviews.ts'],
  },
  {
    code: 'ZZ001',
    rule: 'A lint pass, an approval and a publication record are append-only.',
    migration: '0093',
    raisedBy: ['refuse_publication_record_change'],
    translators: ['packages/db/src/repositories/publication.ts'],
  },
  {
    code: 'ZZ002',
    rule: 'A publication state must follow the one before it on that surface.',
    migration: '0093',
    raisedBy: ['assert_publication_transition'],
    translators: ['packages/db/src/repositories/publication.ts'],
  },
  {
    code: 'ZZ003',
    rule: 'A publication over an already-published surface must name the record it supersedes.',
    migration: '0093',
    raisedBy: ['assert_publication_transition'],
    translators: ['packages/db/src/repositories/publication.ts'],
  },
  {
    code: 'ZZ004',
    rule: 'A published record must have written its audit_event in the same transaction.',
    migration: '0093',
    raisedBy: ['assert_publication_audited'],
    translators: ['packages/db/src/repositories/publication.ts'],
  },
  {
    code: 'ZZ005',
    rule: 'A surface may not be published over its measured critical-path weight budget.',
    migration: '0093',
    raisedBy: ['assert_publication_within_weight_budget'],
    translators: ['packages/db/src/repositories/publication.ts'],
  },
]
