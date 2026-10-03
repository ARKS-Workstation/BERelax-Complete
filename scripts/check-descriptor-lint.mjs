#!/usr/bin/env node
/**
 * The statement descriptor, judged wherever it appears — the stored setting AND the source tree.
 *
 * Y-PAY-10. `lintStatementDescriptor` in `@berelax/core` is the judgement, and this script is the half a
 * function cannot make: a claim about what is NOT in the repository.
 *
 * ## Why a scan and not only a test
 *
 * The descriptor has one legitimate home — `payments.statement_descriptor`, an F09 setting whose value is
 * a marker the schema refuses until an acquirer is chosen (`Y7-descriptor`). The failure mode is not a bad
 * value in that setting; it is a descriptor somewhere ELSE. A string literal in a checkout handler, a
 * default in a provider adapter, a fallback in a receipt renderer: each is individually defensible, each
 * reads as a sensible default, and the one place it is read is a line on a customer's bank statement that
 * says what they bought.
 *
 * So there are two rules, and the second is the one that needs a scanner:
 *
 *   1. **The stored descriptor passes the lint**, judged through the same function the application uses,
 *      against the configured limit. Run against the F09 registry's declared defaults rather than against
 *      a database, because this gate runs in CI with no database and the declared default is what a fresh
 *      deploy would hold.
 *   2. **No descriptor-shaped literal exists outside the permitted modules.** A descriptor is an
 *      upper-case short string next to a word like `descriptor`, `statement` or `softDescriptor`, which is
 *      what every payment SDK calls the field — so the discriminator is the FIELD NAME rather than the
 *      shape of the value, and what it catches is an assignment rather than a mention.
 *
 * ## Why the permitted list is small and carries reasons
 *
 * `PERMITTED_DESCRIPTOR_SOURCES` is three entries: the setting's declaration, the lint itself and this
 * file. A new entry is a diff somebody has to justify, which is the whole difference between a gate and a
 * convention — the same argument `check-send-chokepoint.mjs` makes about its four permitted sends.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  getDefinition,
  PROVISIONAL_STATEMENT_DESCRIPTOR,
  PROVISIONAL_STATEMENT_DESCRIPTOR_LIMIT,
  STATEMENT_DESCRIPTOR_LIMIT_SETTING_KEY,
  STATEMENT_DESCRIPTOR_SETTING_KEY,
} from '../packages/config/src/settings/registry.ts'
import {
  DESCRIPTOR_BLOCKED_TERMS,
  isPlaceholderDescriptor,
  lintStatementDescriptor,
} from '../packages/core/src/payments/descriptor.ts'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOTS = ['packages', 'apps', 'scripts']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs'])
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'artifacts'])

/**
 * Where a statement descriptor may be written, and why each may.
 *
 * Keyed by file, because "this package may hold one" is too coarse: `registry.ts` declares the setting
 * and its marker, and if `@berelax/config` grew a second descriptor by another name that would be a
 * second value for a screen to read.
 */
const PERMITTED_DESCRIPTOR_SOURCES = new Map([
  [
    'packages/config/src/settings/registry.ts',
    'The F09 declaration. Its value is PROVISIONAL_STATEMENT_DESCRIPTOR, a marker is_placeholder_text() ' +
      'refuses, and rule 1 below judges it through the same lint the application uses.',
  ],
  [
    'packages/core/src/payments/descriptor.ts',
    'The lint itself, which holds the blocking lexicon. The terms here are the ones a descriptor may ' +
      'NOT contain, which is the opposite of a descriptor.',
  ],
  [
    'scripts/check-descriptor-lint.mjs',
    'This file, which carries the discriminators as data. Scanning it would make the gate report itself.',
  ],
])

/** A test may write a descriptor to drive the lint, and must be able to. A test ships nowhere. */
const isTest = (file) => /\.(test|itest|property\.test)\.ts$/.test(file)

/**
 * An ASSIGNMENT to a descriptor field, which is what a configured descriptor looks like in every SDK.
 *
 * The field name is the discriminator and not the value's shape, for a reason worth stating: a short
 * upper-case string is also a currency code, an emirate, a tender kind and half the enum labels in this
 * build, so a rule on the value would condemn the catalogue and be switched off within the week. What a
 * descriptor actually is, is the thing somebody puts in the field the processor reads.
 */
const DESCRIPTOR_ASSIGNMENT =
  /\b(statementDescriptor|softDescriptor|soft_descriptor|statement_descriptor|descriptor)\s*[:=]\s*(['"`])([^'"`]{1,64})\2/g

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) yield full
  }
}

const violations = []
const record = (rule, where, detail) => violations.push({ rule, where, detail })

// ------------------------------------------------------------------------------------------------
// Rule 1 — the declared descriptor passes the lint
// ------------------------------------------------------------------------------------------------
{
  const descriptor = getDefinition(STATEMENT_DESCRIPTOR_SETTING_KEY).defaultValue
  const limit = getDefinition(STATEMENT_DESCRIPTOR_LIMIT_SETTING_KEY).defaultValue
  const verdict = lintStatementDescriptor({ descriptor, limit })

  // Today the declared default is a MARKER, so the expected verdict is a refusal naming
  // `descriptor-not-configured` — and that is the state this gate has to be able to describe without
  // failing the build, because it is the shipped state. What it must NOT accept is a descriptor that is
  // configured AND bad.
  const refusals = verdict.ok ? [] : verdict.refusals.map((refusal) => refusal.rule)
  const unconfigured =
    refusals.includes('descriptor-not-configured') ||
    refusals.includes('descriptor-limit-not-configured')

  if (!verdict.ok && !unconfigured) {
    record(
      'declared-descriptor-fails-the-lint',
      'packages/config/src/settings/registry.ts',
      `the declared statement descriptor is configured and refused: ${verdict.refusals
        .map((refusal) => `${refusal.rule} — ${refusal.detail}`)
        .join('; ')}`,
    )
  }

  // The CONTROL, and it comes with the rule rather than after it: the lint must be seen to reject
  // something. A gate whose only assertion is "the shipped value is fine" passes against a lint that
  // accepts everything (ADR 0002, ADR 0003).
  const control = lintStatementDescriptor({ descriptor: 'BR SPA AUH', limit: 22 })
  const controlRules = control.ok ? [] : control.refusals.map((refusal) => refusal.rule)
  if (!controlRules.includes('descriptor-contains-a-blocked-term')) {
    record(
      'descriptor-lint-accepts-a-blocked-term',
      'packages/core/src/payments/descriptor.ts',
      'the lint accepted "BR SPA AUH", which contains "spa" — the descriptor Y-PAY-10’s manifest ' +
        'entry proposed, and the reason it was refused under brief rule 15. A lint that accepts it is ' +
        'not a lint.',
    )
  }
  const tooLong = lintStatementDescriptor({ descriptor: 'A'.repeat(30), limit: 22 })
  const tooLongRules = tooLong.ok ? [] : tooLong.refusals.map((refusal) => refusal.rule)
  if (!tooLongRules.includes('descriptor-exceeds-provider-limit')) {
    record(
      'descriptor-lint-accepts-an-overlong-descriptor',
      'packages/core/src/payments/descriptor.ts',
      'the lint accepted a 30-character descriptor against a limit of 22. A descriptor over the limit ' +
        'is not refused by the processor — it is TRUNCATED, and what goes is the end of the line.',
    )
  }
  if (!isPlaceholderDescriptor(PROVISIONAL_STATEMENT_DESCRIPTOR)) {
    record(
      'declared-descriptor-is-not-a-marker',
      'packages/config/src/settings/registry.ts',
      `PROVISIONAL_STATEMENT_DESCRIPTOR is "${PROVISIONAL_STATEMENT_DESCRIPTOR}", which ` +
        'is_placeholder_text() does not refuse — so it is a value that reads as configured. Brief rule ' +
        '15: a provisional value carries a marker the schema refuses.',
    )
  }
  if (PROVISIONAL_STATEMENT_DESCRIPTOR_LIMIT !== 0) {
    record(
      'declared-descriptor-limit-is-a-length',
      'packages/config/src/settings/registry.ts',
      `PROVISIONAL_STATEMENT_DESCRIPTOR_LIMIT is ${PROVISIONAL_STATEMENT_DESCRIPTOR_LIMIT}, which is a ` +
        'length somebody could believe an acquirer agreed to. Zero is the sentinel precisely because it ' +
        'is not a legal length.',
    )
  }
}

// ------------------------------------------------------------------------------------------------
// Rule 2 — no descriptor-shaped literal outside the permitted modules
// ------------------------------------------------------------------------------------------------
let scanned = 0
let permittedSeen = 0

for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }
  for (const file of walk(root)) {
    scanned += 1
    const permitted = PERMITTED_DESCRIPTOR_SOURCES.has(file)
    const source = readFileSync(file, 'utf8')
    // Strings KEPT: the whole rule is about a string literal. Comments blanked, so a descriptor
    // mentioned in a comment — which this file's own header does — is not a violation.
    const code = stripNonCode(source)
    const lineOf = (index) => code.slice(0, index).split('\n').length

    for (const match of code.matchAll(DESCRIPTOR_ASSIGNMENT)) {
      if (permitted) {
        permittedSeen += 1
        continue
      }
      if (isTest(file)) continue
      record(
        'statement-descriptor-outside-its-one-home',
        `${file}:${lineOf(match.index)}`,
        `${match[1]} = ${match[2]}${match[3]}${match[2]} writes a statement descriptor outside ` +
          '`payments.statement_descriptor`. A descriptor has one home because it has one reader: the ' +
          "line on a cardholder's bank statement. A literal here is a value no settings screen shows, " +
          'no audit row records and no lint judged — and the thing it decides is whether a shared ' +
          'statement says what somebody bought. Read it with `readStatementDescriptor` from ' +
          '`@berelax/db` and judge it with `lintStatementDescriptor` from `@berelax/core`.',
      )
    }
  }
}

/**
 * The control, and it comes before the verdict.
 *
 * Rule 2 is "nothing matched outside the allowlist", and nothing matches outside the allowlist when
 * nothing matches at all. ADR 0002's green tick on zero modules: if the discriminator stops matching — a
 * rename, a formatting change that puts the value on the next line — this file reports success about a
 * repository it did not read. So the permitted assignments are COUNTED, and a count below the number of
 * declared sources that really hold one is a failure of the scanner rather than a pass for the tree.
 */
if (scanned < 100 || permittedSeen < 1) {
  console.error(
    `The descriptor scanner did not read what it thinks it read: ${scanned} file(s) scanned and ` +
      `${permittedSeen} permitted descriptor assignment(s) found, which must be at least one — ` +
      `${STATEMENT_DESCRIPTOR_SETTING_KEY}'s own declaration holds it. Check the ` +
      'DESCRIPTOR_ASSIGNMENT discriminator against packages/config/src/settings/registry.ts.',
  )
  process.exit(1)
}

if (violations.length > 0) {
  console.error('Statement descriptor violations:\n')
  for (const violation of violations) {
    console.error(`  ${violation.rule}`)
    console.error(`    ${violation.where}  ${violation.detail}`)
  }
  console.error(
    `\n${violations.length} violation(s). A statement descriptor is the one line about a visit that ` +
      'appears on an account somebody else may share: it names the business and never the treatment, ' +
      'and it does not conceal that a payment was made, its amount or its date.',
  )
  process.exit(1)
}

console.log(
  `The statement descriptor has one home: ${scanned} files scanned across ${ROOTS.join(', ')}, ` +
    `${permittedSeen} permitted assignment(s) accounted for across ` +
    `${PERMITTED_DESCRIPTOR_SOURCES.size} declared source(s), the declared default is a marker ` +
    `is_placeholder_text() refuses, and the lint was seen to reject a blocked term and an overlong ` +
    `value (${DESCRIPTOR_BLOCKED_TERMS.length} blocked terms).`,
)
