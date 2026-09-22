#!/usr/bin/env node
/**
 * packages/core must be pure: no I/O, no ambient globals, no clock.
 *
 * `pnpm boundaries` catches forbidden *imports*, but ambient globals are not imports — `process.env`
 * and `Date.now()` are reachable anywhere once @types/node is in scope. This closes that hole.
 *
 * Why the clock matters: every calculation in core (availability, VAT, leave accrual, commission)
 * must be reproducible from its inputs. A hidden `new Date()` makes a test pass today and fail in
 * Ramadan, and makes an availability bug impossible to reproduce.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOT = 'packages/core/src'

const FORBIDDEN = [
  { re: /\bprocess\s*\./g, why: 'process is ambient I/O; pass configuration in as an argument' },
  { re: /\bDate\.now\s*\(/g, why: 'reading the clock; inject a Clock and pass the instant in' },
  {
    re: /\bnew\s+Date\s*\(\s*\)/g,
    why: 'reading the clock; inject a Clock and pass the instant in',
  },
  { re: /\bMath\.random\s*\(/g, why: 'non-determinism; inject the value or a seeded generator' },
  { re: /\bfetch\s*\(/g, why: 'network I/O has no place in core' },
  { re: /\bglobalThis\b/g, why: 'ambient state; pass it in' },
  { re: /\bconsole\s*\./g, why: 'core must not log; return a result and let the caller decide' },
]

/**
 * Directories that are stricter than the rest of core.
 *
 * The rules above ban *reading* the clock and nothing more, because they have to: `packages/core/src/
 * time.ts` legitimately calls `new Date(instant)` and `Intl.DateTimeFormat` to render an **injected**
 * instant as wall-clock time in a named zone. Both are deterministic there and both are necessary.
 *
 * The ledger is different, and the general rule is not enough for it. A journal entry carries a
 * `LocalDate` that its caller already resolved on `business_day` — trading runs 11:00 to 02:00, so a
 * 01:30 sale belongs to the previous trading date. Any `Date` or `Intl` in the ledger would be
 * re-deriving that date from a calendar date, which silently disagrees with the caller for the nine
 * hours either side of midnight, and puts the takings on the wrong day. There is no legitimate use to
 * balance against, so the whole surface is banned here rather than only the clock reads.
 *
 * The checkout basket is the second such directory, for a narrower version of the same reason stated on
 * its entry below: it takes no date at all.
 */
const SCOPED = [
  {
    // The checkout basket takes no date at all: every figure on it was snapshotted by somebody else,
    // and the one date a checkout needs — the tax point — is resolved from `business_day` by
    // `resolveTaxPoint` before it ever reaches a document. A `Date` here could only be a second
    // opinion about the trading day the caller already resolved, and trading runs 11:00-02:00, so the
    // two disagree for the nine hours either side of midnight and the takings land on the wrong day.
    root: join(ROOT, 'checkout'),
    forbidden: [
      {
        re: /\bDate\b/g,
        why: 'the basket needs no date; the tax point is resolved on business_day by its caller',
      },
      {
        re: /\bIntl\b/g,
        why: 'no timezone or locale lookup in the till; money is formatted at the edge, not here',
      },
    ],
  },
  {
    root: join(ROOT, 'ledger'),
    forbidden: [
      {
        re: /\bDate\b/g,
        why: 'the ledger takes dates as LocalDate from its caller; re-deriving one moves the 01:30 sale to the wrong trading day',
      },
      {
        re: /\bIntl\b/g,
        why: 'no timezone or locale lookup in the ledger; YYYY-MM-DD compares and sorts as a string',
      },
    ],
  },
]

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const p = join(dir, entry)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

const rulesFor = (file) => [
  ...FORBIDDEN,
  ...SCOPED.filter((scope) => file.startsWith(`${scope.root}/`)).flatMap((s) => s.forbidden),
]

let violations = 0
for (const file of walk(ROOT)) {
  const code = stripNonCode(readFileSync(file, 'utf8'), { blankStrings: true })
  const rules = rulesFor(file)
  code.split('\n').forEach((line, i) => {
    for (const { re, why } of rules) {
      re.lastIndex = 0
      if (re.test(line)) {
        console.log(`${file}:${i + 1}  ${line.trim()}`)
        console.log(`    -> ${why}`)
        violations += 1
      }
    }
  })
}

if (violations > 0) {
  console.error(`\n${violations} purity violation(s) in packages/core. See docs/adr/0001.`)
  process.exit(1)
}
const scopedFiles = walk(ROOT).filter((f) => SCOPED.some((scope) => f.startsWith(`${scope.root}/`)))
console.log(
  `packages/core is pure (${walk(ROOT).length} files checked, ` +
    `${scopedFiles.length} of them under the no-Date/no-Intl rule for ` +
    `${SCOPED.map((scope) => scope.root).join(' and ')}).`,
)
