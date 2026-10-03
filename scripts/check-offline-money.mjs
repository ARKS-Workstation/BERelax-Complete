#!/usr/bin/env node
/**
 * Nothing on the money path may hold a money movement to try later (H-HARD-08).
 *
 * ## The claim, and why no type can make it
 *
 * The salon's wifi will drop mid-checkout. The obvious response is offline tolerance: hold the payment in
 * the browser, send it when the connection comes back, show the operator a tick. Every word of that is
 * wrong here, and the reason is in `packages/core/src/checkout/honest-failure.ts` at length — a queued
 * money movement is a promise this system cannot keep, and the tick is a claim the terminal makes on behalf
 * of a gateway it never reached.
 *
 * "Nobody will build that" is not a check. `.dependency-cruiser.cjs` cannot see it, because `localStorage`
 * is not a module; `tsc` cannot see it, because the DOM lib declares it; and a review cannot see it,
 * because the diff that introduces it looks like resilience work and arrives with a changelog entry about
 * the wifi. So it is a scan over the money path, with four rules, each with a known-bad fixture in gate
 * block 196 that asserts rejection BY NAME.
 *
 * ## Why a PATH list rather than the whole repository
 *
 * Because browser storage is legitimate elsewhere. `apps/web/app/api/collect` is the analytics collector
 * and A-FIRST-06's consent bootstrap genuinely remembers a choice in the browser; a repository-wide ban
 * would be a rule somebody turns off within the week, which is the failure mode `check-send-chokepoint.mjs`
 * records for a rule on the bare name `send`.
 *
 * The money path is what this unit is about: the checkout and till screens, the payments package, the
 * payment API routes, and the three repositories that write an invoice, a journal entry or a payment
 * intent. {@link MONEY_PATHS} names them and {@link MONEY_WRITE_FILES} is asserted to exist, so a renamed
 * repository fails the gate rather than silently leaving it scanning nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripNonCode } from './lib/strip-non-code.mjs'

/** The rule names. Each is what a failure prints, and what gate block 196 asserts on. */
const RULE_BROWSER_STORE = 'money-path-holds-no-browser-store'
const RULE_OFFLINE_API = 'money-path-reads-no-offline-api'
const RULE_DEFERRED_SEND = 'money-path-defers-no-send'
const RULE_FAILURE_VOCABULARY = 'till-failure-sentence-claims-nothing-it-cannot-know'

/**
 * Where the money is decided, taken and recorded.
 *
 * Directories are walked recursively; files are read as named. The list is small on purpose — see the
 * header on why this is not a repository-wide rule.
 */
const MONEY_PATHS = [
  'apps/web/app/(admin)/checkout',
  'apps/web/app/(admin)/till',
  'apps/web/app/api/v1/payments',
  'packages/payments/src',
  'packages/core/src/checkout',
]

/**
 * The three repositories that write a money row, named so a rename fails the gate.
 *
 * `MONEY_WRITE_FILES` is checked for EXISTENCE before it is scanned. A path list that silently matched
 * nothing is the shape in which this gate becomes decoration: it would pass for ever while the invoice
 * writer sat somewhere else.
 */
const MONEY_WRITE_FILES = [
  'packages/db/src/repositories/invoice.ts',
  'packages/db/src/repositories/journal.ts',
  'packages/db/src/repositories/payment-intent.ts',
]

/** Files that carry these patterns as DATA. Scanning either would make the gate report itself. */
const EXEMPT = new Set(['scripts/check-offline-money.mjs', 'scripts/test-gates.mjs'])

const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js'])
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', '.claude'])

/**
 * A browser store, by the accessor rather than by a word.
 *
 * `window.localStorage`, `globalThis.sessionStorage` and a bare `indexedDB.open` all match; the word
 * "storage" in a sentence does not, because `stripNonCode` has already removed the comments and the rule
 * requires a property access or a call.
 */
const BROWSER_STORE =
  /\b(?:localStorage|sessionStorage|indexedDB|caches)\s*[.[]|\bopenDatabase\s*\(|\bnew\s+BroadcastChannel\b/

/**
 * An offline API: the three ways a page asks whether it is connected, and the two ways it defers work.
 *
 * `navigator.onLine` is the detection, `online`/`offline` event registration is the reaction, and
 * `serviceWorker` plus `SyncManager`/`BackgroundSync` are the mechanisms that would carry a payment across
 * the gap. A service worker is the one that matters most: it survives the tab.
 */
const OFFLINE_API =
  /\bnavigator\s*\.\s*(?:onLine|serviceWorker)\b|\bserviceWorker\s*\.\s*register\b|\bSyncManager\b|\bBackgroundSync\b|addEventListener\s*\(\s*['"`](?:online|offline)['"`]/

/**
 * A deferred send: a money movement handed to something that will happen later.
 *
 * `setTimeout` around a gateway CALL, and the shapes a hand-rolled retry queue takes. The names are the
 * discriminator rather than the mechanism, because the mechanism is ordinary JavaScript: what makes it a
 * defect is that the thing deferred is a PAYMENT.
 *
 * The window after `setTimeout(` is `[\s\S]{0,120}?` and not `[^)]*`, which is what the first version
 * had and what gate 196c caught: the commonest spelling is `setTimeout(() => capture(), 60_000)`, and a
 * character class excluding `)` stops at the arrow's own empty parameter list — so the rule read every
 * deferred call in that shape as clean. A bounded any-character window spans it, and the trailing `\(`
 * requires a CALL rather than a mention, so a comment naming `capture` is not matched.
 */
const DEFERRED_SEND =
  /\b(?:pendingPayments|paymentQueue|queuedPayments|offlineQueue|retryQueue|deferredPayments|outboxPayments)\b|\bsetTimeout\s*\([\s\S]{0,120}?\b(?:authorise|capture|refund|charge)\s*\(/i

/** Every scannable file under a directory, recursively. */
function walk(directory, out = []) {
  if (!existsSync(directory)) return out
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const next = join(directory, entry.name)
    if (entry.isDirectory()) walk(next, out)
    else if (EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) out.push(next)
  }
  return out
}

const problems = []
const record = (rule, file, line, detail) => {
  problems.push({ rule, file, line, detail })
}

// --- the path list must actually name things ----------------------------------------------------
for (const path of [...MONEY_PATHS, ...MONEY_WRITE_FILES]) {
  if (!existsSync(path)) {
    record(
      'money-path-list-is-stale',
      'scripts/check-offline-money.mjs',
      0,
      `${path} is on the money-path list and is not on disk, so this gate is scanning less than it ` +
        'claims. A path list that silently matched nothing is how a scan becomes decoration — fix the ' +
        'list, not the expectation.',
    )
  }
}

const files = [
  ...MONEY_PATHS.flatMap((path) =>
    existsSync(path) && statSync(path).isDirectory() ? walk(path) : existsSync(path) ? [path] : [],
  ),
  ...MONEY_WRITE_FILES.filter((file) => existsSync(file)),
].filter((file) => !EXEMPT.has(file))

for (const file of files) {
  // Tests and gate fixtures are scanned too, deliberately: a suite that asserts an offline queue works is
  // a suite whose subject is the defect, and the one exemption this gate has is for the two files that
  // carry these patterns as data.
  const code = stripNonCode(readFileSync(file, 'utf8'))
  code.split('\n').forEach((line, index) => {
    if (BROWSER_STORE.test(line)) {
      record(
        RULE_BROWSER_STORE,
        file,
        index + 1,
        'a browser store on the money path. A payment held in localStorage, sessionStorage, IndexedDB or ' +
          'a Cache is a money movement this system has promised to make and cannot: the tab closes, the ' +
          'device is swapped, the day is cashed up, and the queue drains into a locked period. The till ' +
          'says what it could not do (packages/core/src/checkout/honest-failure.ts); it does not hold the ' +
          'payment.',
      )
    }
    if (OFFLINE_API.test(line)) {
      record(
        RULE_OFFLINE_API,
        file,
        index + 1,
        'an offline API on the money path. navigator.onLine, an online/offline listener and a service ' +
          'worker are the three ways a page comes to believe it can carry a payment across a gap. The ' +
          "checkout runs no script at all — ADR 0013, and script-src 'none' on the document — so this " +
          'could only be the beginning of an offline queue.',
      )
    }
    if (DEFERRED_SEND.test(line)) {
      record(
        RULE_DEFERRED_SEND,
        file,
        index + 1,
        'a deferred payment on the money path. An authorisation, capture or refund handed to a timer or a ' +
          'named queue is a charge that happens after the customer has left, against an invoice somebody ' +
          'may have voided. A gateway call is made while somebody is standing there or it is not made.',
      )
    }
  })
}

// --- the shipped failure sentences claim nothing they cannot know --------------------------------
/*
  Read out of the module as TEXT rather than imported, for the reason `check-send-chokepoint.mjs` gives
  about its own parse: this is a Node script in a repository whose packages ship TypeScript source, so
  importing `@berelax/core` here would need a transpiler the other 50 verify steps do not pay for. The
  equivalence is held by `packages/core/src/checkout/honest-failure.test.ts`, which runs the same rule over
  the real objects — and by the vacuity guard below, which refuses a parse that found no sentences.
*/
const HONEST_FAILURE = 'packages/core/src/checkout/honest-failure.ts'
if (existsSync(HONEST_FAILURE)) {
  const source = readFileSync(HONEST_FAILURE, 'utf8')
  const table = /TILL_FAILURE_SENTENCES[^=]*=\s*Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(source)
  const phrases = /TILL_FORBIDDEN_FAILURE_PHRASES\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(source)
  const forbidden = [...(phrases?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1])
  if (table === null || forbidden.length === 0) {
    record(
      'till-failure-table-is-unreadable',
      HONEST_FAILURE,
      0,
      'the sentence table or the forbidden-phrase list could not be read out of this file, so the ' +
        'vocabulary rule below is checking nothing. The anchor has gone stale against the real source.',
    )
  } else {
    const body = table[1].toLowerCase()
    for (const phrase of forbidden) {
      // The phrase must not appear in a VALUE. The list itself lives elsewhere in the file, so matching
      // the table's body only is what keeps the rule from reporting the list that defines it.
      if (body.includes(phrase)) {
        record(
          RULE_FAILURE_VOCABULARY,
          HONEST_FAILURE,
          0,
          `a shipped till failure sentence contains "${phrase}", which claims something the terminal ` +
            'cannot know. A till says what it could not do and never that it succeeded.',
        )
      }
    }
  }
}

if (problems.length > 0) {
  const byRule = new Map()
  for (const problem of problems) {
    byRule.set(problem.rule, [...(byRule.get(problem.rule) ?? []), problem])
  }
  for (const [rule, found] of byRule) {
    console.error(`\n  ${rule}`)
    for (const problem of found) {
      console.error(`    ${problem.file}:${problem.line}  ${problem.detail}`)
    }
  }
  console.error(
    `\n${problems.length} violation(s). An offline tolerance that silently queues a money movement is ` +
      'the defect this gate exists to refuse: the operator sees a tick, the customer leaves, and the ' +
      'charge lands hours later or never. H-HARD-08, ADR 0118.',
  )
  process.exit(1)
}

console.log(
  `Nothing on the money path holds a payment to try later: ${files.length} file(s) scanned across ` +
    `${MONEY_PATHS.length} path(s) and ${MONEY_WRITE_FILES.length} money-write repositor(y/ies), no ` +
    'browser store, no offline API and no deferred gateway call, and every shipped till failure sentence ' +
    'claims only what the terminal can know.',
)
