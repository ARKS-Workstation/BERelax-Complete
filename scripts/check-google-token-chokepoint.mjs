#!/usr/bin/env node
/**
 * The half of the Google token chokepoint that dependency-cruiser cannot express.
 *
 * G-CONN-03's chokepoint has two halves, and keeping them straight is the point of this file existing at
 * all rather than the rule being written once and believed:
 *
 *   - **`google-tokens-only-in-with-google`** in `.dependency-cruiser.cjs` closes the *import path* to the
 *     token accessors. That is a module-to-module edge, which is the only kind of thing dependency-cruiser
 *     sees. It cannot see an identifier and it cannot see a string inside a query.
 *   - **this script** closes the three things that are text: a token *column name* in a query written
 *     somewhere other than the store, an *accessor identifier* reached some other way, and the mistake
 *     docs/10 §4 asks for by name — *"a CI lint rule fails the build on any template literal containing
 *     the token variable"*.
 *
 * Each of the three has its own rule name, and `scripts/test-gates.mjs` writes a violating fixture for each
 * and asserts rejection **by that name**. A fixture rejected by some other rule would leave the one under
 * test free to stop matching anything, which is how `pnpm boundaries` once passed while cruising nothing
 * (ADR 0003).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['packages', 'apps', 'scripts']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs', '.sql'])
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'artifacts'])

/**
 * The modules that may hold a plaintext Google token.
 *
 * The same list as the dependency-cruiser rule's, deliberately: two lists would drift, and the day they
 * drift is the day one of them is quietly relaxed to match the other.
 */
const TOKEN_MODULES = new Set([
  'packages/google/src/token-store.ts',
  'packages/google/src/with-google.ts',
  'packages/google/src/lifecycle.ts',
  'packages/google/src/rewrap.ts',
  'packages/google/src/oauth/reconnect.ts',
])

/** The modules that may name a token column, because their job is to move those columns. */
const COLUMN_MODULES = new Set([
  'packages/db/migrations/0016_google_connection.sql',
  'packages/db/src/schema/google.ts',
  'packages/google/src/postgres-store.ts',
])

/**
 * Files that carry these strings as **data** rather than as code.
 *
 * Both of them exist to prove the rules fire: this scanner holds the patterns, and the gate harness holds
 * the known-bad fixtures it writes to disk. Scanning either would make the gate report itself.
 */
const EXEMPT = new Set(['scripts/check-google-token-chokepoint.mjs', 'scripts/test-gates.mjs'])

/** The five sealed columns, for each of the two tokens. */
const TOKEN_COLUMNS = [
  'refresh_token_ct',
  'refresh_token_nonce',
  'refresh_token_wrapped_key',
  'refresh_token_kid',
  'refresh_token_aad_fp',
  'access_token_ct',
  'access_token_nonce',
  'access_token_wrapped_key',
  'access_token_kid',
  'access_token_aad_fp',
]

/** The functions that turn a stored ciphertext into a bearer credential, and the AAD that binds it. */
const TOKEN_ACCESSORS = ['openToken', 'sealToken', 'rewrapToken', 'connectionBinding']

/**
 * The identifiers that ARE a plaintext token, for the template-literal rule.
 *
 * Matched only when the interpolated expression *ends* with one of them, so `${write.refreshToken.ct}` —
 * a sealed column being passed as a query parameter — is not a violation while `${tokens.accessToken}` is.
 * Without that distinction the rule condemns every parameterised query in the store, and a rule that
 * condemns the correct code is a rule somebody deletes.
 */
const TOKEN_VALUE_IDENTIFIERS = [
  'accessToken',
  'refreshToken',
  'access_token',
  'refresh_token',
  'idToken',
  'id_token',
]

const isTest = (file) => /\.(test|itest)\.ts$/.test(file)

/**
 * Removes comments, so prose describing the rule is not a violation of it.
 *
 * `//` preceded by a colon is left alone, because that is a URL rather than a comment — and the scopes,
 * the endpoints and the fixture tokens in this codebase are full of them. A `//` inside a string literal
 * that is not a URL still truncates the line, which can only ever cause this scanner to look at less than
 * it might have; the template-literal rule therefore runs on the RAW text, because that is the rule where
 * a missed line would be a missed secret.
 */
function withoutComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/--.*$/, '').replace(/(?<!:)\/\/.*$/, ''))
    .join('\n')
}

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
const record = (rule, file, line, detail) =>
  violations.push({ rule, where: `${file}:${line}`, detail })

/** Every `${…}` in every template literal, with the line it sits on. */
function* interpolations(text) {
  const pattern = /`(?:\\.|[^`\\])*`/gs
  for (const match of text.matchAll(pattern)) {
    const line = text.slice(0, match.index).split('\n').length
    for (const inner of match[0].matchAll(/\$\{([^{}]*)\}/g)) {
      yield { expression: inner[1].trim(), line }
    }
  }
}

let scanned = 0

for (const root of ROOTS) {
  try {
    statSync(root)
  } catch {
    continue
  }
  for (const file of walk(root)) {
    if (EXEMPT.has(file)) continue
    scanned += 1
    const raw = readFileSync(file, 'utf8')
    const code = withoutComments(raw)
    const lineOf = (index) => code.slice(0, index).split('\n').length

    // 1. A token column named outside the modules whose job is those columns. A query selecting
    //    refresh_token_ct anywhere else is a query that intends to decrypt it somewhere else.
    if (!COLUMN_MODULES.has(file) && !isTest(file)) {
      for (const column of TOKEN_COLUMNS) {
        const pattern = new RegExp(`\\b${column}\\b`, 'g')
        for (const match of code.matchAll(pattern)) {
          record(
            'google-token-columns-outside-the-token-modules',
            file,
            lineOf(match.index),
            `${column} — the sealed columns are moved by packages/google/src/postgres-store.ts and nowhere else`,
          )
        }
      }
    }

    // 2. An accessor identifier outside the token modules. This is the half dependency-cruiser cannot
    //    do at all: a rule matching an identifier is not a thing it can express.
    if (!TOKEN_MODULES.has(file) && !isTest(file)) {
      for (const accessor of TOKEN_ACCESSORS) {
        const pattern = new RegExp(`\\b${accessor}\\b`, 'g')
        for (const match of code.matchAll(pattern)) {
          record(
            'google-token-accessor-outside-the-token-modules',
            file,
            lineOf(match.index),
            `${accessor} — consumers go through withGoogle(), which is what makes degradation and the failure ledger possible`,
          )
        }
      }
    }

    // 3. docs/10 §4, asked for by name. A template literal is how a token reaches a log line, a URL, an
    //    error message and a job payload, and it is the one shape of leak that is invisible in review
    //    because the interpolation reads like a variable rather than like a secret. Runs on the RAW
    //    text and applies to EVERY file, including the token modules themselves — they are the ones
    //    holding a plaintext token, so they are where the mistake would actually be made.
    for (const { expression, line } of interpolations(raw)) {
      const leaks = TOKEN_VALUE_IDENTIFIERS.some((name) =>
        new RegExp(`(?:^|[.\\s(!])${name}$`).test(expression),
      )
      if (leaks) {
        record(
          'google-token-in-a-template-literal',
          file,
          line,
          `\${${expression}} interpolates a plaintext token. It may not appear in a log line at any level, an error message, a Sentry breadcrumb, a URL or a pg-boss payload (docs/10 §4).`,
        )
      }
    }
  }
}

if (violations.length > 0) {
  console.error('Google token chokepoint violations:\n')
  for (const violation of violations) {
    console.error(`  ${violation.rule}`)
    console.error(`    ${violation.where}  ${violation.detail}`)
  }
  console.error(
    `\n${violations.length} violation(s). The refresh token is a durable bearer credential for ` +
      'control of the business Google presence, and the scope it carries also rewrites the address ' +
      'and the opening hours (docs/10 §3).',
  )
  process.exit(1)
}

console.log(
  `Google tokens stay inside the chokepoint: ${scanned} files scanned across ${ROOTS.join(', ')}, ` +
    `${TOKEN_MODULES.size} module(s) may hold a plaintext token.`,
)
