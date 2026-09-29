import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Which suite may remove which rows, and the scan that derives the question rather than remembering it.
 *
 * ## The defect
 *
 * The integration suites run sequentially against ONE database in an order no file controls, and a suite
 * that empties a table empties it for every suite that runs afterwards **and for every later run against
 * that database**. `pnpm db:apply` refuses a populated database, so nothing short of rebuilding brings the
 * rows back; and a PARTLY emptied database looks seeded, because a fixture loader that finds rows in its
 * table leaves it alone. It has bitten this build three times:
 *
 *  1. `customer-identity.itest.ts` and `otp-route.itest.ts` held `delete from customer` with no predicate.
 *     That removed the four customers the consent loader creates, and `sell-package.itest.ts` skipped all
 *     21 of its cases with "the seed creates customers".
 *  2. M-TILL-13 measured 140 tables where 153 were expected, and every suite downstream answered about a
 *     salon that was missing its rota.
 *  3. The first one hid behind a second defect for weeks: the bare delete raised on an `ON DELETE RESTRICT`
 *     foreign key while an earlier suite leaked a child row, so it never completed and the seeded customers
 *     survived by accident. Six files ordered their own cleanup around that hazard and wrote it down.
 *
 * `seeded-row-deletes.test.ts` was the narrow guard: one table, by name, in one shape. This is the general
 * answer, and ADR 0050 is the decision it implements.
 *
 * ## The rule
 *
 * **A suite may remove rows it created. Anything wider is DECLARED.** Concretely, every unqualified
 * `delete`/`truncate` in a test file is one of:
 *
 *  - **scoped** — it carries a predicate, so it can only reach rows the suite can name; or
 *  - **declared** in {@link DECLARED_UNQUALIFIED}, naming the file, the tables and why.
 *
 * The offending set is DERIVED by scanning the suites. It is never a written list of known sites, because a
 * written list is satisfied by the sites somebody happened to notice: the 67 statements this unit was opened
 * for were the remainder after two were fixed, and a check against that remainder would have passed the
 * sixty-eighth.
 *
 * ## What this module cannot decide, and what does
 *
 * A declaration is a claim, and two of them are checked elsewhere because nothing static can check them:
 *
 *  - That a `kind: 'owns'` suite really owns the table — `packages/fixtures/src/seeded-tables.itest.ts`
 *    derives the SEEDED tables from the seed's own loaders and refuses a declaration that claims to own one
 *    unless it names the loader that puts the rows back.
 *  - That a `kind: 'refused'` statement really is refused — the integration run's own invariant
 *    (`packages/harness/src/seeded-rows.ts`, wired as this suite's `globalSetup`) reads the seeded rows
 *    before the run and again after it, so a statement that removed one fails the run that did it rather
 *    than the next one.
 */

/** Where test files live. Both roots, because `apps/web` and `apps/worker` hold suites too. */
const ROOTS = ['packages', 'apps']

/** This module, and the suite that runs it. See {@link crossFileRestatements}. */
const MODULE = 'packages/db/src/suite-table-ownership.ts'
export const GUARD_SUITE = 'packages/db/src/seeded-row-deletes.test.ts'

/** A `delete` or `truncate` in a test file that names its tables and nothing else. */
export interface UnqualifiedSite {
  readonly file: string
  /** 1-based, and the line the LITERAL opens on — a statement is not a line. */
  readonly line: number
  readonly kind: 'delete' | 'truncate'
  /** Lowercased, schema-qualified where the statement qualified it: `clinical.treatment_note`. */
  readonly tables: readonly string[]
  /** The statement, whitespace collapsed, for a failure message that points at something. */
  readonly statement: string
}

import {
  DECLARED_UNQUALIFIED,
  type DeclaredUnqualified,
  NEVER_DECLARABLE,
} from './suite-table-declarations.ts'

export {
  DECLARED_UNQUALIFIED,
  type DeclaredKind,
  type DeclaredUnqualified,
  NEVER_DECLARABLE,
  restorableTables,
} from './suite-table-declarations.ts'

/**
 * Modules that are test code by PURPOSE and not by filename, scanned as if they were suites.
 *
 * `packages/fixtures/src/invoice-family.ts` is the case that forced this, and it is the right shape rather
 * than an exception. Sixteen suites each restated the invoice and package family table lists; migration 0097
 * gave `commission_line` a foreign key to both `invoice` and `package_redemption`, every one of those lists
 * went stale at once, and four suites failed in their own teardowns. The lists now live once, in that module,
 * behind `truncateInvoiceFamily` and `truncatePackageFamily` — which is this unit's own principle applied to
 * the statement rather than to the declaration.
 *
 * But it moves the statement OUT of a `*.itest.ts`, and a scan that walks test files by filename stops seeing
 * it: sixteen declarations went stale in one merge and the shared statement they described became unguarded.
 * Naming the module here is what keeps the rule covering the statement wherever it lives. An entry that does
 * not exist is a failure rather than a silent skip, because a support module removed or renamed is exactly
 * how the scan would go quiet.
 */
export const TEST_SUPPORT_MODULES: readonly string[] = Object.freeze([
  'packages/fixtures/src/invoice-family.ts',
  // H-MIG-01's conformance target teardown, here for the same reason and at one table rather than six: both
  // of that unit's integration files need to start from an empty conformance target, and the statement lives
  // once in `clearProbeEntities`. It is predicate-scoped, so it needs no declaration —
  // but it would be invisible to this scan if the module were not named here, which is the hazard the
  // paragraph above is about.
  'packages/migration/src/conformance/probe-importer.ts',
])

/** Every file the rule applies to: the test files, plus the support modules they delegate cleanup to. */
export function scannedFiles(): string[] {
  return [...testFiles(), ...TEST_SUPPORT_MODULES.filter((module) => existsSync(module))]
}

/** Support modules that have been renamed or removed out from under a declaration. */
export function missingSupportModules(): string[] {
  return TEST_SUPPORT_MODULES.filter((module) => !existsSync(module))
}

/** Every test file under the roots, repository-relative. */
export function testFiles(): string[] {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        out.push(...walk(path))
        continue
      }
      if (/\.(itest|test)\.ts$/.test(entry)) out.push(path)
    }
    return out
  }
  return ROOTS.flatMap((root) => walk(root))
}

interface Literal {
  /** 1-based line the literal opens on. */
  readonly line: number
  readonly text: string
}

const QUOTES = new Set(["'", '"', '`'])

/**
 * Every string and template literal in a TypeScript source, comments excluded and concatenations joined.
 *
 * Three things this has to get right, and each one is a site the check would otherwise miss or invent.
 *
 * **Comments are dropped, not searched.** Six files describe this hazard in prose, and one of them quotes
 * `delete from customer` inside a sentence explaining what another file used to do.
 *
 * **A `+` concatenation is ONE literal.** Every suite that truncates the invoice family writes it as
 * `'truncate refund, checkout_finalisation, payment, ' + 'invoice_appointment, invoice_line, invoice'`,
 * because the list does not fit in a hundred columns. A scan that read the halves separately would report
 * the first three tables and silently miss the three that matter most — `invoice` refuses DELETE for every
 * role, so it is the one table in that statement whose removal cannot be undone by re-inserting.
 *
 * **An interpolation becomes a placeholder, not a join.** `${TWIN_ROOM_CODE}` collapsing to nothing would
 * turn `where code = ${code}` into `where code =` and, worse, could splice two identifiers into one word.
 */
export function sqlLiterals(source: string): Literal[] {
  const out: Literal[] = []
  let index = 0
  let line = 1
  const newlines = (from: number, to: number): number =>
    (source.slice(from, to).match(/\n/g) ?? []).length

  while (index < source.length) {
    const char = source[index] as string
    if (char === '\n') {
      line += 1
      index += 1
      continue
    }
    if (source.startsWith('//', index) || source.startsWith('/*', index)) {
      const next = skipTrivia(source, index)
      line += newlines(index, next)
      // A trivia run always advances at least past the `//` or `/*`; `index + 2` is the floor for the one
      // case it cannot — an unterminated `/*` at the end of the file, where `skipTrivia` returns the length.
      index = Math.max(next, index + 2)
      continue
    }
    if (!QUOTES.has(char)) {
      index += 1
      continue
    }
    const openedAt = line
    let text = ''
    let at = index
    // Every literal joined to this one by `+`, however many lines it spans.
    for (;;) {
      const read = readLiteral(source, at)
      text += read.text
      line += newlines(at, read.next)
      const afterPlus = concatenatedAt(source, read.next)
      if (afterPlus === undefined) {
        index = read.next
        break
      }
      line += newlines(read.next, afterPlus)
      at = afterPlus
    }
    out.push({ line: openedAt, text })
  }
  return out
}

/**
 * Where the literal joined to this one by `+` opens, or `undefined` when there is none.
 *
 * Separate from {@link sqlLiterals} for the cognitive-complexity ceiling, and it reads better for it: the
 * concatenation rule is one question with one answer.
 */
function concatenatedAt(source: string, after: number): number | undefined {
  const afterLiteral = skipTrivia(source, after)
  if (source[afterLiteral] !== '+') return undefined
  const afterPlus = skipTrivia(source, afterLiteral + 1)
  return QUOTES.has(source[afterPlus] as string) ? afterPlus : undefined
}

/** Reads one literal starting at its opening quote. Returns its text and the index after the close. */
function readLiteral(source: string, start: number): { text: string; next: number } {
  const quote = source[start] as string
  let text = ''
  let i = start + 1
  while (i < source.length) {
    const char = source[i] as string
    if (char === '\\') {
      // The escaped character itself, so a `\'` cannot close the literal and a `\n` does not become a
      // newline that the whitespace collapse would then hide a keyword behind.
      text += source.slice(i + 1, i + 2)
      i += 2
      continue
    }
    if (char === quote) return { text, next: i + 1 }
    if (quote === '`' && char === '$' && source[i + 1] === '{') {
      const close = skipInterpolation(source, i + 2)
      // `?` is what postgres.js sends anyway, so the text still reads as SQL. Spaced on both sides because
      // collapsing the interpolation to nothing could splice the identifiers either side into one word.
      //
      // The first IDENTIFIER of the expression is kept with it, and that is not decoration. A statement whose
      // table list is interpolated — `truncate ${INVOICE_FAMILY_TABLES.join(', ')}` — has no table names in
      // its text at all, so a scan that dropped the expression could not see the statement and could not say
      // it could not see it. Keeping the name is what lets the list be resolved where it is written.
      const expression = source.slice(i + 2, close - 1)
      const identifier = /[A-Za-z_$][\w$]*/.exec(expression)?.[0] ?? ''
      i = close
      text += ` ?${identifier} `
      continue
    }
    text += char
    i += 1
  }
  return { text, next: i }
}

/** From just inside a `${`, the index after its matching `}`. Literals inside it are skipped whole. */
function skipInterpolation(source: string, from: number): number {
  let depth = 1
  let i = from
  while (i < source.length && depth > 0) {
    const char = source[i] as string
    if (char === '{') depth += 1
    else if (char === '}') depth -= 1
    else if (QUOTES.has(char)) {
      i = readLiteral(source, i).next
      continue
    }
    i += 1
  }
  return i
}

/** From `at`, skips whitespace and comments. Returns the first index that is neither. */
function skipTrivia(source: string, at: number): number {
  let i = at
  while (i < source.length) {
    const char = source[i] as string
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      i += 1
      continue
    }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      i = end === -1 ? source.length : end
      continue
    }
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i)
      i = end === -1 ? source.length : end + 2
      continue
    }
    return i
  }
  return i
}

/**
 * The tables a `delete`/`truncate` names, or `undefined` when the statement is not one or carries a
 * predicate.
 *
 * **`statement` must START with the keyword**, and that is what makes this read code rather than prose.
 * Six files describe the hazard in comments, which are already gone, but a dozen more describe it in test
 * NAMES and privilege lists — `it('refuses DELETE from the application role')`,
 * `revoke truncate on ${table} from berelax_app`, `it('has no TRUNCATE grant on bill_line')`. Every one of
 * those has the keyword in the middle of something else. Requiring statement position keeps them out
 * without a list of phrases to ignore, which is the form of exception that goes stale.
 */
function parseStatement(statement: string): ParsedStatement | undefined {
  const table = '[a-z_][a-z_0-9]*(?:\\.[a-z_][a-z_0-9]*)?'
  const list = `${table}(?:\\s*,\\s*${table})*`
  const interpolated = /^(delete\s+from|truncate(?:\s+table)?)\s+\?([A-Za-z_$][\w$]*)/i.exec(
    statement,
  )
  if (interpolated !== null) {
    // A statement whose tables are interpolated. Its scope cannot be read from its own text, so it is a site
    // whose table list has to be RESOLVED — see `resolveList`. Unresolved is a finding and never a skip: a
    // truncate the scan cannot read is exactly how a suite would evade this rule, deliberately or not.
    return {
      kind: /^truncate/i.test(interpolated[1] as string) ? 'truncate' : 'delete',
      tables: [],
      statement: statement.trim(),
      listName: interpolated[2] as string,
    }
  }
  const match = new RegExp(`^(delete\\s+from|truncate(?:\\s+table)?)\\s+(${list})`, 'i').exec(
    statement,
  )
  if (match === null) return undefined
  const kind = /^truncate/i.test(match[1] as string) ? 'truncate' : 'delete'
  const tables = (match[2] as string).split(/\s*,\s*/).map((name) => name.toLowerCase())
  const rest = statement.slice(match[0].length)
  if (kind === 'delete') {
    // A predicate, with or without the alias PostgreSQL allows between the table and the `where`:
    // `delete from obligation_instance i where …` and `delete from outbox_event e where …` are both scoped,
    // and the first version of this check called them offences. `using` is the join form of the same thing.
    if (/^(?:\s+(?:as\s+)?[a-z_][a-z_0-9]*)?\s+(where|using)\b/i.test(rest)) return undefined
  }
  return { kind, tables, statement: statement.trim() }
}

/** `file\u0000table`, the key both directions of the coverage check compare on. */
const pairKey = (file: string, table: string): string => `${file}\u0000${table}`

/** Every (file, table) pair the declarations cover. */
export function declaredPairs(
  declarations: readonly DeclaredUnqualified[] = DECLARED_UNQUALIFIED,
): Map<string, DeclaredUnqualified> {
  const out = new Map<string, DeclaredUnqualified>()
  for (const entry of declarations) {
    for (const table of entry.tables) out.set(pairKey(entry.file, table), entry)
  }
  return out
}

/**
 * A (file, table) pair declared twice.
 *
 * Refused, so the table stays auditable: two entries for one pair means two reasons for one thing, and the
 * reader cannot tell which one the site in front of them is covered by. A file that both owns a table and
 * probes it — `journal.itest.ts` and `journal_line` — gets ONE entry whose reason says both.
 */
export function duplicateDeclarations(
  declarations: readonly DeclaredUnqualified[] = DECLARED_UNQUALIFIED,
): string[] {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const entry of declarations) {
    for (const table of entry.tables) {
      const key = `${entry.file} \u2192 ${table}`
      if (seen.has(key)) duplicates.push(key)
      seen.add(key)
    }
  }
  return duplicates
}

/** Sites that are neither scoped nor declared — the offences. */
export function undeclaredSites(
  sites: readonly UnqualifiedSite[],
  declarations: readonly DeclaredUnqualified[] = DECLARED_UNQUALIFIED,
): { site: UnqualifiedSite; table: string }[] {
  const declared = declaredPairs(declarations)
  const out: { site: UnqualifiedSite; table: string }[] = []
  for (const site of sites) {
    for (const table of site.tables) {
      if (!declared.has(pairKey(site.file, table))) out.push({ site, table })
    }
  }
  return out
}

/**
 * Declarations that no longer describe anything.
 *
 * The direction that lets the table SHRINK. A declaration left behind after its statement was scoped is
 * standing permission for the next author to put an unqualified one back, which is how the allowlist this
 * unit replaced grew in the first place.
 */
export function staleDeclarations(
  sites: readonly UnqualifiedSite[],
  declarations: readonly DeclaredUnqualified[] = DECLARED_UNQUALIFIED,
): string[] {
  const live = new Set<string>()
  for (const site of sites) for (const table of site.tables) live.add(pairKey(site.file, table))
  const out: string[] = []
  for (const entry of declarations) {
    for (const table of entry.tables) {
      if (!live.has(pairKey(entry.file, table))) out.push(`${entry.file} \u2192 ${table}`)
    }
  }
  return out
}

/** A comment in one test file that describes what ANOTHER test file removes. */
export interface CrossFileRestatement {
  readonly file: string
  readonly line: number
  /** The other test file the comment names. */
  readonly names: string
  readonly excerpt: string
}

/**
 * Comments that document another suite's cleanup, which is a statement that drifts when that suite is fixed.
 *
 * It happened to every one of them. Nine files across `packages/fixtures`, `packages/db` and `apps/web`
 * ordered their own cleanup around `customer-identity.itest.ts` and `otp-route.itest.ts` clearing the
 * `customer` table, and wrote that down in the present tense. Both statements were then scoped — so every
 * one of those sentences now describes something that does not happen, in a file whose own reason for its
 * own cleanup has to be reconstructed from it.
 *
 * The check is deliberately NARROW: the two wordings that actually drifted, and only when the comment names
 * another test file. It is not a prose detector and cannot become one without becoming a check about
 * English. What makes it worth having is the DERIVED half — a restatement is allowed only while the file it
 * names really does hold an unqualified site on that table, so the sentence fails at the moment the other
 * file is fixed rather than years later when somebody reads it.
 */
export function crossFileRestatements(
  files: readonly string[] = sourceFiles(),
  sites: readonly UnqualifiedSite[] = unqualifiedSites(),
): CrossFileRestatement[] {
  const index = restatementIndex(sites)
  const out: CrossFileRestatement[] = []
  for (const file of files) {
    const self = file.split('\\').join('/')
    // The guard itself is exempt, and only the guard. This module and the suite that runs it have to be
    // able to state the defect they exist for, naming the two files that held it — and a rule whose own
    // statement of its own history is a violation of it is a rule nobody can write down.
    if (self === MODULE || self === GUARD_SUITE) continue
    for (const block of commentBlocks(readFileSync(self, 'utf8'))) {
      // Per SENTENCE, and the block is joined before it is split so a wrapped phrase survives. Per BLOCK
      // over-matches by a mile: a file header is one block, and every one that credits a sibling suite
      // somewhere and mentions a truncate somewhere else was reported — 39 findings for 10 real ones.
      for (const sentence of block.text.split(/(?<=[.;:])\s+|\s+-\s+/)) {
        const named = restatedIn(sentence, self, index)
        if (named !== undefined) {
          out.push({ file: self, line: block.line, names: named, excerpt: sentence.slice(0, 160) })
        }
      }
    }
  }
  return out
}

interface RestatementIndex {
  /** Tables each file removes without a predicate, keyed by repository-relative path. */
  readonly liveByFile: ReadonlyMap<string, ReadonlySet<string>>
  /** Paths sharing a basename, so a comment naming `foo.itest.ts` can be resolved. */
  readonly byBasename: ReadonlyMap<string, readonly string[]>
  /**
   * Every table any site names, plus the never-declarable ones.
   *
   * The gate on the captured word, and it is not decoration: `/truncate\s+(\w+)/` over the sentence
   * "`invoice` refuses DELETE, so truncate is the only legal removal" captures `is`, and two files were
   * reported for a cross-reference to a sibling's reasoning that says nothing about any table. Derived from
   * the scan rather than listed, so it grows with the suites.
   */
  readonly known: ReadonlySet<string>
}

function restatementIndex(sites: readonly UnqualifiedSite[]): RestatementIndex {
  const liveByFile = new Map<string, Set<string>>()
  const known = new Set<string>(NEVER_DECLARABLE)
  for (const site of sites) {
    const tables = liveByFile.get(site.file) ?? new Set<string>()
    for (const table of site.tables) {
      tables.add(table)
      known.add(table)
    }
    liveByFile.set(site.file, tables)
  }
  const byBasename = new Map<string, string[]>()
  for (const path of liveByFile.keys()) {
    const base = path.split('/').at(-1) as string
    byBasename.set(base, [...(byBasename.get(base) ?? []), path])
  }
  return { liveByFile, byBasename, known }
}

/** The other test file this sentence wrongly describes as removing rows, or `undefined`. */
function restatedIn(sentence: string, self: string, index: RestatementIndex): string | undefined {
  for (const named of sentence.matchAll(/([\w.-]+\.(?:itest|test)\.ts)/g)) {
    const base = named[1] as string
    if (self.endsWith(`/${base}`)) continue
    // The two wordings that drifted: a statement quoted at another file, and "clears the … table".
    const quoted = /(?:delete\s+from|truncate)\s+`?([a-z_][a-z_0-9]*)/i.exec(sentence)?.[1]
    const clears = /clears the (?:whole )?`?([a-z_][a-z_0-9]*)`?\s*table/i.exec(sentence)?.[1]
    const table = [quoted, clears]
      .map((word) => word?.toLowerCase())
      .find((word) => word !== undefined && index.known.has(word))
    if (table === undefined) continue
    const targets = index.byBasename.get(base) ?? []
    if (targets.some((target) => index.liveByFile.get(target)?.has(table) === true)) continue
    return base
  }
  return undefined
}

interface CommentBlock {
  readonly line: number
  readonly text: string
}

/**
 * Comments as BLOCKS, each one line of text.
 *
 * Per-block and not per-line, because the wording that drifted wraps: "clears the whole `customer`" ends a
 * line and "table between its cases" begins the next, and a line-at-a-time scan found neither half. Four
 * files were missed that way, and they were four of the ones the acceptance is about.
 */
export function commentBlocks(source: string): CommentBlock[] {
  const out: CommentBlock[] = []
  const lines = source.split('\n')
  let current: { line: number; parts: string[] } | undefined
  let inBlock = false
  for (const [index, raw] of lines.entries()) {
    const text = raw.trim()
    const starts = text.startsWith('/*')
    const isComment = inBlock || starts || text.startsWith('//') || text.startsWith('*')
    if (isComment) {
      const stripped = text.replace(/^\/\*+|^\/\/+|^\*+\/?|\*\/$/g, '').trim()
      current = current ?? { line: index + 1, parts: [] }
      current.parts.push(stripped)
      inBlock = (inBlock || starts) && !text.includes('*/')
      continue
    }
    if (current !== undefined) {
      out.push({ line: current.line, text: current.parts.join(' ').replace(/\s+/g, ' ').trim() })
      current = undefined
    }
  }
  if (current !== undefined) {
    out.push({ line: current.line, text: current.parts.join(' ').replace(/\s+/g, ' ').trim() })
  }
  return out
}

/** Every TypeScript source under the roots, test or not. */
export function sourceFiles(): string[] {
  const walk = (dir: string): string[] => {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue
      const path = join(dir, entry)
      if (statSync(path).isDirectory()) {
        out.push(...walk(path))
        continue
      }
      if (/\.tsx?$/.test(entry)) out.push(path)
    }
    return out
  }
  return ROOTS.flatMap((root) => walk(root))
}

/**
 * Every unqualified site in ONE source, which is the entry point the controls drive.
 *
 * Exported so `seeded-row-deletes.test.ts` can assert both directions against strings it owns rather than
 * against a copy of this parser. A control that re-implements what it controls is not a control: it passes
 * while the real scan is broken, which is the shape of vacuous test ADR 0002 is about.
 */
type ParsedStatement = Omit<UnqualifiedSite, 'file' | 'line'> & { readonly listName?: string }

/**
 * The tables a named `readonly string[]` in the same source holds, or `undefined`.
 *
 * Deliberately one idiom and not an evaluator: a frozen array of string literals, which is how both of this
 * repository's shared truncate lists are written. Anything else is left UNRESOLVED and reported, because a
 * resolver that guessed would be worse than one that says it cannot tell — this whole unit exists because a
 * check that quietly covers less than it claims reads exactly like a repository with no problems.
 */
export function resolveList(source: string, name: string): string[] | undefined {
  const declaration = new RegExp(
    `\\b${name}\\s*(?::[^=]*)?=\\s*(?:Object\\.freeze\\()?\\[([^\\]]*)\\]`,
  ).exec(source)
  if (declaration === null) return undefined
  const entries = [...(declaration[1] as string).matchAll(/'([a-z_][a-z_0-9]*)'/g)].map(
    (entry) => entry[1] as string,
  )
  return entries.length > 0 ? entries : undefined
}

/** What a site whose list could not be resolved is declared as. */
export const UNRESOLVED_LIST = '<unresolved-list>'

export function unqualifiedInSource(source: string, file = '<inline>'): UnqualifiedSite[] {
  const out: UnqualifiedSite[] = []
  for (const literal of sqlLiterals(source)) {
    // Whitespace collapsed before the keyword test, because a statement is not a line: the predicate of
    // a correctly scoped delete is usually on the next one, and a check that stopped at the newline
    // reported it as an offence. C-AUTO-07 hit that and reformatted its own SQL onto one line rather
    // than argue with the check, which is a check making people write worse code.
    for (const segment of literal.text.split(';')) {
      const parsed = parseStatement(segment.replace(/\s+/g, ' ').trim())
      if (parsed === undefined) continue
      const { listName, ...site } = parsed
      const tables =
        listName === undefined ? site.tables : (resolveList(source, listName) ?? [UNRESOLVED_LIST])
      out.push({ file, line: literal.line, ...site, tables })
    }
  }
  return out
}

/** Every unqualified site in the repository's test files, derived by scanning them. */
export function unqualifiedSites(files: readonly string[] = testFiles()): UnqualifiedSite[] {
  return files.flatMap((file) =>
    unqualifiedInSource(readFileSync(file, 'utf8'), file.split('\\').join('/')),
  )
}
