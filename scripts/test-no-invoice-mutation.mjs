#!/usr/bin/env node
/**
 * An issued document is never edited, voided or deleted — proved by construction over the whole tree.
 *
 * docs/04 §4: "Credit notes only for corrections. Never edit or delete an issued invoice." `invoice`
 * and `credit_note` are append-only in the database (ZI003 and ZD009, from BEFORE triggers that fire
 * for every role including the owner), `berelax_app` holds no UPDATE or DELETE on either, and
 * `packages/db/src/repositories/invoice.test.ts` enumerates one module's exports.
 *
 * None of those closes the hole this gate closes. A per-module test only covers the module it imports,
 * so a `voidInvoice` added to `packages/core/src/money/` would be checked by nothing; and a mutating
 * STATEMENT — `update invoice set ...` in a repository, a route, a script — is refused at run time by a
 * trigger, which means it is found by whoever runs that path rather than by the build.
 *
 * So there are two scans, and they answer different questions:
 *
 *   1. **The export surface of the money modules.** No exported symbol may carry a mutating verb as one
 *      of its name segments. Read from SOURCE rather than by importing, precisely so a module that no
 *      test imports is still covered.
 *   2. **Mutating SQL against the document tables, anywhere in the tree.** `update invoice`,
 *      `delete from credit_note_line` and their relatives, in `.ts`, `.tsx`, `.sql` and `.mjs` alike.
 *
 * The known-bad fixtures are in `scripts/test-gates.mjs` block 93.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const problems = []

/**
 * The document tables. UPDATE and DELETE against any of them is refused, always.
 *
 * `invoice_appointment` is deliberately absent: it is a link table 0063 owns, and a checkout that
 * changes which appointment a document bills is M-TILL-06's business rather than a correction to the
 * document. The four here are the ones whose rows a customer holds a copy of.
 */
const DOCUMENT_TABLES = ['invoice', 'invoice_line', 'credit_note', 'credit_note_line']

/**
 * Verb stems that may not appear as a segment of an exported name.
 *
 * Copied deliberately from `packages/db/src/repositories/invoice.test.ts` rather than shared: that file
 * is a vitest unit test and this is a node script with no import of the workspace, and a module they
 * both imported would have to live in a package one of them may not depend on. The two lists agreeing
 * is asserted below, which is cheaper than the dependency and fails if either drifts.
 *
 * **Stems, and segmented matching.** A substring match for `edit` flags `creditNote` — the one
 * correction path that must exist — and a whole-word match for `delete` misses `softDeleted`.
 */
const FORBIDDEN_VERB_STEMS = ['updat', 'edit', 'void', 'delet', 'amend', 'cancel']

/** The file that holds the same list, so a drift between the two is a failure rather than a surprise. */
const STEM_TWIN = 'packages/db/src/repositories/invoice.test.ts'

/**
 * The money estate: every module where a correction path could plausibly be written.
 *
 * Declared rather than inferred from a pattern. "Everything under packages" would drag in the booking
 * lifecycle, which legitimately cancels appointments, and an allowance broad enough to let that through
 * would let a `voidInvoice` through beside it.
 */
const MONEY_DIRS = [
  'packages/core/src/money',
  'packages/core/src/checkout',
  'packages/core/src/ledger',
  'packages/core/src/tax',
]
const MONEY_FILES = [
  'packages/db/src/repositories/invoice.ts',
  'packages/db/src/repositories/journal.ts',
  'packages/db/src/repositories/numbering.ts',
  'packages/db/src/services/checkout-finalise.ts',
  'packages/db/src/services/issue-credit-note.ts',
  'packages/db/src/adapters/manual-payment.ts',
]

/**
 * Where a mutating statement against a document table is legitimate, and why each one is.
 *
 * Declared with a reason for `check-gate-registry.mjs`'s reason: "it is in a test file" is exactly the
 * condition a smuggled mutation also satisfies, so an allowance that guessed would let the defect
 * through as an exception. Each of these exists to make the refusal FIRE, and each asserts the
 * SQLSTATE it gets back.
 */
const MUTATION_ALLOWED = new Map([
  [
    'packages/db/src/repositories/invoice.itest.ts',
    'probes ZI003 by issuing the UPDATE and the DELETE and asserting the SQLSTATE of each',
  ],
  [
    'packages/db/src/services/issue-credit-note.itest.ts',
    'probes ZD009 the same way, and the invoice half of it for the note it corrects',
  ],
  [
    'scripts/test-gates.mjs',
    'holds the known-bad fixtures for this gate, which must contain the strings it rejects',
  ],
  [
    'scripts/test-no-invoice-mutation.mjs',
    'this file: the patterns it searches for are written out in it',
  ],
])

/** Every file under `dir`, recursively. */
function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist' || name === '.git') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else out.push(path)
  }
  return out
}

/** `readInvoiceByDisplayNumber` -> ['read', 'invoice', 'by', 'display', 'number']. */
function segmentsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter((segment) => segment !== '')
}

/** The forbidden stem a name carries, or undefined. */
function mutatingVerbIn(name) {
  for (const segment of segmentsOf(name)) {
    const stem = FORBIDDEN_VERB_STEMS.find((verb) => segment.startsWith(verb))
    if (stem !== undefined) return stem
  }
  return undefined
}

/**
 * The names a module exports, read from source.
 *
 * Both spellings, because a re-export is how a symbol reaches a caller without a declaration anywhere
 * near it: `export function x`, `export const x`, `export class x`, `export interface x`, `export type
 * x`, and the braced list of `export { a, b as c } from '...'` — where the name that matters is the one
 * on the RIGHT of `as`, since that is what a caller writes.
 */
function exportedNames(source) {
  const names = new Set()
  const declaration =
    /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm
  for (const match of source.matchAll(declaration)) names.add(match[1])
  for (const list of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of list[1].split(',')) {
      const text = entry.trim().replace(/^type\s+/, '')
      if (text === '') continue
      const parts = text.split(/\s+as\s+/)
      const name = (parts.at(-1) ?? '').trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') names.add(name)
    }
  }
  return names
}

// --- 1. the export surface of the money modules -------------------------------------------------
const moneyFiles = [...MONEY_DIRS.flatMap((dir) => walk(dir)), ...MONEY_FILES].filter(
  (path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.itest.ts'),
)

let namesScanned = 0
for (const path of moneyFiles) {
  const source = readFileSync(path, 'utf8')
  for (const name of exportedNames(source)) {
    namesScanned += 1
    const verb = mutatingVerbIn(name)
    if (verb === undefined) continue
    problems.push(
      `${path}  no-invoice-mutation: exports "${name}", whose name carries "${verb}". An issued ` +
        'document is corrected by a credit note, never edited — so the new function is the defect, ' +
        'not this gate.',
    )
  }
}

// --- 2. mutating SQL against a document table, anywhere ----------------------------------------
/**
 * `update <table>` and `delete from <table>`.
 *
 * Anchored on whitespace after the verb, which is what keeps every legitimate spelling out of it:
 * `revoke update, delete on invoice` has a comma, `revoke update (display_number) on invoice` has a
 * parenthesis, and `create trigger invoice_no_update before update on invoice` has `on`. All three
 * appear in `0026_invoice.sql` and none of them is a mutation.
 */
const MUTATION_PATTERNS = DOCUMENT_TABLES.flatMap((table) => [
  { rule: `update ${table}`, re: new RegExp(`\\bupdate\\s+${table}\\b`, 'i') },
  { rule: `delete from ${table}`, re: new RegExp(`\\bdelete\\s+from\\s+${table}\\b`, 'i') },
])

const scanned = ['packages', 'apps', 'scripts'].flatMap((root) => walk(root))
const sources = scanned.filter((path) => /\.(ts|tsx|mjs|sql)$/.test(path))

let linesScanned = 0
/** Which declared probes were actually seen to contain one, so a dead allowance cannot linger. */
const allowancesUsed = new Set()
for (const path of sources) {
  const allowed = MUTATION_ALLOWED.has(path)
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const [index, line] of lines.entries()) {
    linesScanned += 1
    for (const { rule, re } of MUTATION_PATTERNS) {
      if (!re.test(line)) continue
      if (allowed) {
        allowancesUsed.add(path)
        continue
      }
      problems.push(
        `${path}:${index + 1}  no-invoice-mutation: "${rule}". An issued document is append-only ` +
          '(ZI003 / ZD009): a correction is a credit note on its own series, with its own reversing ' +
          'journal entry. If this statement is a probe that asserts the refusal, add the file to ' +
          'MUTATION_ALLOWED with a reason.',
      )
    }
  }
}

// --- the controls, which come before the verdict ------------------------------------------------
// Every assertion above is over a scan, and a scan that read nothing reports no problems. Each of
// these is a fact about the tree that must hold, so a parser that stopped working fails here rather
// than reporting success for ever (ADR 0002).
if (moneyFiles.length < 10) {
  problems.push(
    `read only ${moneyFiles.length} money module(s): the module list did not resolve, so the export ` +
      'surface was not scanned.',
  )
}
if (namesScanned < 100) {
  problems.push(
    `read only ${namesScanned} exported name(s) from ${moneyFiles.length} module(s): the export ` +
      'parser did not match, so nothing was judged.',
  )
}
if (linesScanned < 100_000) {
  problems.push(`read only ${linesScanned} line(s) of source: the tree walk did not resolve.`)
}
// The matcher has to DISCRIMINATE. Without this, a segmenter that returned an empty array would report
// an empty list of offenders for ever — the exact shape of a gate that has quietly died.
for (const name of ['voidInvoice', 'updateInvoice', 'softDeleteInvoice', 'INVOICE_UPDATE_SQL']) {
  if (mutatingVerbIn(name) === undefined) {
    problems.push(`the name matcher no longer flags "${name}", so it flags nothing.`)
  }
}
// And it must not flag the one correction path that has to exist. `credit` contains `edit`.
for (const name of ['creditNote', 'issueCreditNote', 'CREDIT_NOTE_SQLSTATE', 'avoidable']) {
  if (mutatingVerbIn(name) !== undefined) {
    problems.push(`the name matcher flags "${name}", which is a name a correction path needs.`)
  }
}
// The SQL matcher, against the two spellings it exists for and the three it must ignore.
for (const text of ['update invoice set x = 1', 'delete from credit_note_line where true']) {
  if (!MUTATION_PATTERNS.some(({ re }) => re.test(text))) {
    problems.push(`the SQL matcher no longer flags "${text}", so it flags nothing.`)
  }
}
for (const text of [
  'revoke update, delete on invoice, invoice_line from berelax_app',
  'revoke update (display_number, number) on invoice from berelax_app',
  'create trigger invoice_no_update before update on invoice',
]) {
  if (MUTATION_PATTERNS.some(({ re }) => re.test(text))) {
    problems.push(
      `the SQL matcher flags "${text}", which is a grant or a trigger and not a mutation.`,
    )
  }
}
// A declared allowance that matches nothing is a hole waiting for a mutation to be dropped into it: the
// file was renamed, or the probe it excused was deleted, and the exemption outlived both. So each one
// has to be USED.
for (const [path, reason] of MUTATION_ALLOWED) {
  if (allowancesUsed.has(path)) continue
  problems.push(
    `${path} is in MUTATION_ALLOWED ("${reason}") and contains no mutating statement, so the ` +
      'allowance excuses nothing and would silently excuse the next thing written there. Remove it.',
  )
}
// The twin list in the unit test has to say the same thing. Two lists of forbidden verbs that disagree
// is one list plus a hole, and the hole is in whichever of the two is shorter.
{
  const twin = readFileSync(STEM_TWIN, 'utf8')
  const declared = /const FORBIDDEN_VERB_STEMS = \[([^\]]*)\]/.exec(twin)?.[1] ?? ''
  const stems = [...declared.matchAll(/'([^']+)'/g)].map((match) => match[1])
  const missing = FORBIDDEN_VERB_STEMS.filter((stem) => !stems.includes(stem))
  const extra = stems.filter((stem) => !FORBIDDEN_VERB_STEMS.includes(stem))
  if (stems.length === 0) {
    problems.push(
      `could not read FORBIDDEN_VERB_STEMS from ${STEM_TWIN}, so the two lists are unheld.`,
    )
  }
  if (missing.length > 0 || extra.length > 0) {
    problems.push(
      `the forbidden-verb lists disagree: ${STEM_TWIN} is missing ${missing.join(', ') || 'nothing'} ` +
        `and carries ${extra.join(', ') || 'nothing'} this gate does not.`,
    )
  }
}

if (problems.length > 0) {
  console.error(`No-invoice-mutation — ${problems.length} problem(s):`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(
  `No invoice mutation: ${namesScanned} exported name(s) across ${moneyFiles.length} money module(s) ` +
    `carry no mutating verb, and ${linesScanned} line(s) of source hold no UPDATE or DELETE against ` +
    `${DOCUMENT_TABLES.join(', ')} outside the ${MUTATION_ALLOWED.size} declared probe(s).`,
)
