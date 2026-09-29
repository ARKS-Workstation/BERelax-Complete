#!/usr/bin/env node
/**
 * The half of the private-document choke point that no type and no import rule can express (W-SYS-14).
 *
 * The unit's title is its specification: **one place every private document goes through.** Every statutory
 * document this build writes used to go somewhere else — `writeTaxDocumentPdf()` took a `path` and called
 * `writeFileSync`, so a filed tax invoice was readable by anybody who learned the path and nothing recorded
 * a read — and the reason it stayed that way through three units is that nothing failed when it was ignored.
 * M-TILL-12 deferred private storage to M-TILL-13 and M-VAT-11; both went `done` without owning it.
 *
 * So the claim that NOTHING reaches a private document another way can only be made by something that fails
 * when a second path appears. Reviewing call sites is not that. This is, in five rules, each with a
 * known-bad fixture in `scripts/test-gates.mjs` that asserts rejection BY NAME (ADR 0003).
 *
 * ## What the existing guards already do, and the four holes they leave
 *
 * `pnpm boundaries` closes import edges and `pnpm db:conventions` proves the append-only trigger pairs
 * exist. Neither can see:
 *
 *   1. **A second INSERT.** `registerPrivateDocument` writes the register row and its `audit_event`
 *      together, and `authoriseAndRecordDocumentFetch` burns the nonce and audits in one transaction. A
 *      second `insert into private_document` anywhere is a document with no audit row; a second
 *      `insert into private_document_fetch` is a fetch that bypasses neither trigger — they are on the table
 *      — but whose audit row nobody wrote. Both look exactly like working code.
 *   2. **A caller-chosen path.** `writeTaxDocumentPdf` still exists, because the golden-comparison suite and
 *      the fixture script legitimately want bytes in a file they can diff. What must not exist is a
 *      PRODUCTION caller, and that is a fact about which files name it.
 *   3. **A second verifier.** `verify` on a document signer decides whether a link is genuine. A second call
 *      site is a second policy, and the second policy is the one that accepts an expired link because
 *      somebody wrote `>` instead of `>=`.
 *   4. **The class catalogue disagreeing with the migration.** `PRIVATE_DOCUMENT_CLASSES` in `@berelax/core`
 *      and `private_document_class_is_known()` in `0101` are the same closed set written twice, because SQL
 *      cannot read TypeScript. A class in one and not the other is either a document nobody can store or a
 *      document nobody can read, and neither fails anywhere else.
 *
 * Usage: `node scripts/check-private-documents.mjs`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOTS = ['packages', 'apps', 'scripts']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs'])
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'artifacts'])

/**
 * The two files that necessarily contain every construct these rules forbid.
 *
 * This one names them in its prose and in its patterns. `scripts/test-gates.mjs` holds the KNOWN-BAD
 * FIXTURES for these very rules (ADR 0003) — a `insert into private_document` string, a `signer.verify(`
 * call — and a gate that condemned its own fixtures would be unsatisfiable. Block 129 also drives migration
 * 0101 as `psql` probes inside `begin/rollback`, which are inserts by construction.
 *
 * The same pair `check-send-chokepoint.mjs` exempts, for the same reason and in the same shape. It is a real
 * hole and a small one: nothing in either file runs in production, and `withFixture`/`withEditedFile` restore
 * whatever they touch.
 */
const SELF = 'scripts/check-private-documents.mjs'
const GATE_SUITE = 'scripts/test-gates.mjs'
const EXEMPT = new Set([SELF, GATE_SUITE])

/** The one module that writes either table, and the one that verifies a signature. */
const REPOSITORY = 'packages/db/src/repositories/private-document.ts'
const ROUTE = 'apps/web/app/(admin)/documents/[id]/route.ts'
const CORE_CATALOGUE = 'packages/core/src/documents/private-document.ts'
const MIGRATION = 'packages/db/migrations/0101_private_document.sql'

const RULES = {
  register: 'private-document-register-is-the-one-writer',
  fetchLog: 'private-document-fetch-is-recorded-in-one-place',
  callerPath: 'private-document-must-not-be-written-to-a-caller-path',
  oneVerifier: 'private-document-signature-verified-in-one-place',
  classesAgree: 'private-document-classes-agree',
}

/**
 * Files permitted to `insert into` either table, with the reason each is there.
 *
 * Keyed by table, because "this file may write private documents" is too coarse: the repository may write
 * both, and a THIRD table appearing here later must be argued for separately.
 */
const PERMITTED_INSERTS = new Map([
  [
    'private_document',
    new Map([
      [
        REPOSITORY,
        'THE register writer. `registerPrivateDocument` writes the row and its audit_event in one ' +
          'transaction, so a document that exists is a document somebody can account for.',
      ],
    ]),
  ],
  [
    'private_document_fetch',
    new Map([
      [
        REPOSITORY,
        'THE fetch recorder. `authoriseAndRecordDocumentFetch` burns the nonce and writes the audit row ' +
          'in one transaction: if ZY111 fires, neither exists.',
      ],
    ]),
  ],
])

/**
 * Files permitted to name `writeTaxDocumentPdf`, with the reason each is there.
 *
 * A test and a fixture script legitimately want bytes in a file they can diff. Production code takes
 * `storeTaxDocumentPdf`, which puts into the private bucket and returns a receipt the register can be given.
 */
const PERMITTED_CALLER_PATH_WRITERS = new Map([
  [
    'packages/pdf/src/render-document.ts',
    'Where it is DEFINED, and where its doc comment says it is for a fixture or a script.',
  ],
  [
    'packages/pdf/src/index.ts',
    'The package barrel. Exporting it is what lets a script reach it; the rule is about callers.',
  ],
  [
    'packages/pdf/src/documents/tax-document.itest.ts',
    'The golden comparison. It writes two renders to temp files and diffs their bytes, which is the one ' +
      'thing a byte store cannot be asked to do.',
  ],
  [CORE_CATALOGUE, 'Names it in prose, as the hole this unit closes.'],
  [
    'packages/db/src/index.ts',
    "The migration ledger's paragraph for 0101 names it in prose, as the hole the migration closes.",
  ],
  [ROUTE, 'Names it in prose, as the hole this route closes.'],
  ['apps/web/src/routes/registry.ts', 'Names it in prose, in the route entry.'],
  [SELF, 'This gate, which names it in order to forbid it.'],
  [
    GATE_SUITE,
    'The known-bad fixture for this very rule. See EXEMPT — a gate cannot condemn its own evidence.',
  ],
])

/** Files permitted to verify a document signature. */
const PERMITTED_VERIFIERS = new Map([
  [
    ROUTE,
    'THE document route. The only place a signature decides anything, which is what stops a second ' +
      'expiry comparison existing somewhere with the sign the wrong way round.',
  ],
  [
    'packages/media/src/storage/signing.ts',
    'Where `verify` is DEFINED. The rule is about call sites.',
  ],
  [
    'packages/media/src/storage/signing.test.ts',
    'The suite that proves every refusal fires. It must call it — a gate that forbade the test would be ' +
      'a gate that forbade the evidence.',
  ],
  [
    'packages/media/src/storage/fake.test.ts',
    'The adapter suite, which verifies the query its own `sign` produced.',
  ],
  [
    'apps/web/src/documents.itest.ts',
    'The integration suite, which mints links the way the screen that offers a download will.',
  ],
  [SELF, 'This gate.'],
  [
    GATE_SUITE,
    'The known-bad fixture for this rule, which is the only reason the rule is not still dead.',
  ],
])

const problems = []

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.claude') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      yield* walk(full)
    } else if (EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      yield full
    }
  }
}

const sourceFiles = []
for (const root of ROOTS) {
  try {
    if (!statSync(root).isDirectory()) continue
  } catch {
    continue
  }
  sourceFiles.push(...walk(root))
}

/**
 * Every file's code with comments blanked and string CONTENTS preserved.
 *
 * Contents preserved, because the constructs this gate looks for live INSIDE strings: an
 * `insert into private_document` is in a tagged template, and a rule that blanked string contents would see
 * none of them. Comments blanked, because this file's own prose names every one of them — the colour gate's
 * first run flagged the Tailwind class names in the sentence explaining why Tailwind class names are
 * forbidden, and `stripNonCode` exists for that.
 */
const codeOf = new Map()
for (const file of sourceFiles) {
  try {
    codeOf.set(file, stripNonCode(readFileSync(file, 'utf8')))
  } catch {
    // Unreadable is not a finding: a file that vanished between the walk and the read is a race with
    // another worktree's gate fixtures, and reporting it would be a flake rather than a defect.
  }
}

// --- rules 1 and 2: one writer per table --------------------------------------------------------
for (const [table, permitted] of PERMITTED_INSERTS) {
  const rule = table === 'private_document' ? RULES.register : RULES.fetchLog
  // `insert into <table>` with any whitespace, and NOT `private_document_fetch` when looking for
  // `private_document`: a word boundary alone would match the longer name, so the register's pattern
  // requires the name to end there.
  const pattern = new RegExp(`insert\\s+into\\s+${table}(?![a-z0-9_])`, 'i')
  for (const [file, code] of codeOf) {
    if (!pattern.test(code)) continue
    if (permitted.has(file)) continue
    if (EXEMPT.has(file)) continue
    problems.push(
      `${file}  [${rule}] writes ${table} directly. Go through ${REPOSITORY}: it writes the row and its ` +
        'audit_event in ONE transaction, so a document that exists is a document somebody can account ' +
        `for and a fetch that was authorised is a fetch that was recorded. Permitted today: ${[
          ...permitted.keys(),
        ].join(', ')}`,
    )
  }
}

// --- rule 3: no production caller of the caller-chosen path -------------------------------------
for (const [file, code] of codeOf) {
  if (!/\bwriteTaxDocumentPdf\b/.test(code)) continue
  if (PERMITTED_CALLER_PATH_WRITERS.has(file)) continue
  // A script or a test may have bytes in a file it can diff. Production code may not.
  if (file.startsWith('scripts/') || /\.(?:test|itest)\.tsx?$/.test(file)) continue
  problems.push(
    `${file}  [${RULES.callerPath}] names writeTaxDocumentPdf, which writes a statutory document to a ` +
      'path the caller chooses — readable by anybody who learns it, with no audit row for a read. That is ' +
      'the hole W-SYS-14 was added to close. Production code takes storeTaxDocumentPdf, which puts into ' +
      'the private bucket and returns a receipt registerPrivateDocument can be given.',
  )
}

// --- rule 4: one verifier -----------------------------------------------------------------------
for (const [file, code] of codeOf) {
  /*
    A `.verify(` on a receiver whose NAME contains `sign` — `signer.verify(`, `documentSigner?.verify(`,
    `appDocumentUrlSigner().verify(`.

    The receiver and not the bare name, because `verifyTotp`, `verifyPassword` and `verifyStructuredData` are
    different functions with their own choke points and condemning them here would get this rule turned off
    within the week. That is `check-send-chokepoint.mjs`'s argument for discriminating on shape rather than on
    a name.

    The leading `[\w$]*` may be EMPTY, and the lookbehind is what makes that safe. The first version of this
    pattern opened with `[A-Za-z_$][\w$]*`, which forces a character BEFORE `sign` — so it matched
    `documentSigner.verify(` and missed `signer.verify(`, the spelling the route actually uses. It was
    written, run against a fixture, and reported nothing: a rule with no reachable violation, found by
    probing it rather than by reading it.
  */
  if (!/(?<![\w$])[\w$]*[sS]ign[\w$]*\s*(?:\(\s*\))?\s*\??\.\s*verify\s*\(/.test(code)) {
    continue
  }
  if (PERMITTED_VERIFIERS.has(file) || EXEMPT.has(file)) continue
  problems.push(
    `${file}  [${RULES.oneVerifier}] verifies a document signature. There is ONE place that decides ` +
      `whether a link is genuine (${ROUTE}); a second is a second policy, and the second policy is the ` +
      'one that accepts an expired link because somebody wrote the comparison the other way round.',
  )
}

// --- rule 5: the class catalogue and the migration agree ----------------------------------------
{
  const core = readFileSync(CORE_CATALOGUE, 'utf8')
  const migration = readFileSync(MIGRATION, 'utf8')

  const coreBlock = /export const PRIVATE_DOCUMENT_CLASSES = \[([\s\S]*?)\] as const/.exec(core)
  const sqlBlock = /p_document_class in \(([\s\S]*?)\)/.exec(migration)
  if (coreBlock === null || sqlBlock === null) {
    problems.push(
      `[${RULES.classesAgree}] the class list could not be read from ` +
        `${coreBlock === null ? CORE_CATALOGUE : MIGRATION}. A gate that cannot find what it compares ` +
        'reports agreement it never measured (ADR 0002), so this is a failure rather than a skip.',
    )
  } else {
    const names = (block) => [...block.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort()
    const fromCore = names(coreBlock[1])
    const fromSql = names(sqlBlock[1])
    if (fromCore.length === 0 || fromSql.length === 0) {
      problems.push(
        `[${RULES.classesAgree}] one of the two class lists parsed EMPTY (core ${fromCore.length}, sql ` +
          `${fromSql.length}), so the comparison below would pass over nothing.`,
      )
    } else if (fromCore.join(',') !== fromSql.join(',')) {
      const onlyCore = fromCore.filter((name) => !fromSql.includes(name))
      const onlySql = fromSql.filter((name) => !fromCore.includes(name))
      problems.push(
        `[${RULES.classesAgree}] PRIVATE_DOCUMENT_CLASSES and private_document_class_is_known() disagree. ` +
          `Only in ${CORE_CATALOGUE}: ${onlyCore.join(', ') || '(none)'}. Only in ${MIGRATION}: ` +
          `${onlySql.join(', ') || '(none)'}. A class in one and not the other is either a document ` +
          'nobody can store or a document nobody can read, and nothing else in this build would say so.',
      )
    }
  }
}

if (problems.length > 0) {
  console.error(
    `Private document choke point: ${problems.length} problem(s).\n\n${problems.join('\n')}\n`,
  )
  process.exit(1)
}

console.log(
  `Private document choke point: ${codeOf.size} source file(s) scanned; one register writer, one fetch ` +
    'recorder, one signature verifier, no caller-chosen document path, and the class catalogue agrees with ' +
    'migration 0101.',
)
