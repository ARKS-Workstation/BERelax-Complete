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

/**
 * The one tree OUTSIDE `packages/core` this gate reads, and why it has to.
 *
 * A-FIRST-02's event taxonomy and funnel vocabulary live in `packages/shared/src/analytics`, and they are
 * there for a boundary reason rather than a convenience: `packages/db` holds the `analytics` schema whose
 * `funnel_step.stage` and `funnel_step.excluded_reason` are those exact words, and `db` must never import
 * `core` (ADR 0001). `shared` is the only package all of the readers may depend on.
 *
 * The acceptance line for that unit is "these modules import nothing beyond @berelax/shared and never
 * read the clock", and this script is the half that sees a clock read at all — `pnpm boundaries` sees
 * imports and cannot see `Date.now()`, because a global is not a dependency. Scanning only
 * `packages/core` would have left the taxonomy's purity asserted in a comment and measured nowhere,
 * which is ADR 0002's defect: the claim would have been wider than the measurement.
 *
 * It is one directory and not all of `packages/shared` deliberately. Widening the gate to the whole
 * package is a bigger decision than one unit should take on its own — several modules there are settings
 * readers and windows whose purity nobody has argued for — and a rule applied to code nobody examined is
 * how a gate acquires exceptions.
 */
const ANALYTICS_TAXONOMY = 'packages/shared/src/analytics'

/** Every tree scanned, in the order the summary names them. */
const ROOTS = [ROOT, ANALYTICS_TAXONOMY]

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
    // The messaging estate's authoring-time figures take no instant at all. What an SMS body costs is a
    // function of the body: its alphabet, its segment count and the rate per segment. A `Date` here
    // could only be a second opinion about *when* the figure was computed, and a preview whose number
    // depends on when it was asked for cannot be checked against the invoice it is supposed to predict —
    // which is the whole of docs/04 §5's requirement. `Intl` is deliberately NOT banned, unlike the two
    // scopes below: `segments.ts` walks grapheme clusters with `Intl.Segmenter` so a surrogate pair is
    // never split across a segment boundary, and that is a table lookup over the argument and nothing
    // else. The retry policy in this directory is a declared table of waits in seconds and needs no
    // clock either, which is why the whole directory is in scope rather than the two new files.
    root: join(ROOT, 'messaging'),
    forbidden: [
      {
        re: /\bDate\b/g,
        why: 'the cost of a body is a function of the body; a preview that reads an instant cannot be checked against the invoice it predicts',
      },
    ],
  },
  {
    // The event taxonomy and the funnel vocabulary take no date at all, and the reason is narrower than
    // the general clock rule. The funnel is bucketed on `business_day` — trading runs 11:00 to 02:00, so
    // a payment at 01:30 belongs to the previous trading date — and that resolution happens ONCE, in
    // `packages/core/src/analytics/funnel.ts`, from an instant its caller passes in. A `Date` here could
    // only be a second opinion about which day an event landed on, and the two disagree for the nine
    // hours either side of midnight: the takings would be counted on one day and the funnel on another.
    // `Intl` goes with it for the ledger's reason — there is no zone or locale lookup to make in a list
    // of words, and a stage name is not rendered here.
    root: ANALYTICS_TAXONOMY,
    forbidden: [
      {
        re: /\bDate\b/g,
        why: 'the taxonomy takes no date; the trading day is resolved once, in core/analytics/funnel.ts, from an injected instant',
      },
      {
        re: /\bIntl\b/g,
        why: 'no timezone or locale lookup in a vocabulary; a stage name is stored, not rendered',
      },
    ],
  },
  {
    // The review estate takes every instant as an argument, and G-REV-02 made the general rule not enough for
    // it. `email-parse.ts` reads a forwarded email and reports the instant the forward ARRIVED; `routing.ts`
    // takes the clock instant so a verdict can be reproduced from the stored lexicon version; `prompt-builder.ts`
    // has to be byte-identical across runs for the approval queue's screenshots to be diffable. A `new
    // Date(instant)` here would be legitimate-looking and would be the one thing that makes a draft or a
    // verdict depend on when it was asked for rather than on what it was asked about — and the general rule
    // permits it, because `time.ts` needs it. `Intl` goes for the same reason the ledger's does: a locale or
    // zone lookup in here would be a second opinion about a date the caller already resolved.
    root: join(ROOT, 'reviews'),
    forbidden: [
      {
        re: /\bDate\b/g,
        why: 'the review estate takes every instant as an argument; a Date here makes a verdict or a draft depend on when it was asked for',
      },
      {
        re: /\bIntl\b/g,
        why: 'no zone or locale lookup in the review estate; the language is an argument and the instant is already resolved',
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

/** Every file this run examined, kept so the summary can report a COUNT rather than a claim. */
const scanned = ROOTS.flatMap(walk)

let violations = 0
for (const file of scanned) {
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
  console.error(
    `\n${violations} purity violation(s) in ${ROOTS.join(' / ')}. See docs/adr/0001 and docs/adr/0046.`,
  )
  process.exit(1)
}

// A gate that examined nothing must not print a green tick (ADR 0002), and the way this one could reach
// zero is a root that has been renamed or emptied — `walk` of a missing directory throws, but a directory
// holding no `.ts` file returns silently. The floor is deliberately per-root rather than a total, because
// a total is satisfied by `packages/core` alone and the analytics tree is the root this check was widened
// for.
for (const root of ROOTS) {
  const inRoot = scanned.filter((file) => file.startsWith(`${root}/`))
  if (inRoot.length === 0) {
    console.error(
      `${root} contributed no files to the purity scan, so this gate would have passed over it. ` +
        'Either the directory moved and ROOTS is stale, or it holds no TypeScript.',
    )
    process.exit(1)
  }
}

const scopedFiles = scanned.filter((f) => SCOPED.some((scope) => f.startsWith(`${scope.root}/`)))
console.log(
  `${ROOTS.join(' and ')} are pure (${scanned.length} files checked, ` +
    // "a scoped rule" rather than "the no-Date/no-Intl rule": messaging bans Date and keeps Intl, and a
    // summary that named the other two scopes' rule for all three would be a line stating something
    // untrue about a gate.
    `${scopedFiles.length} of them under a scoped rule, for ` +
    `${SCOPED.map((scope) => scope.root).join(' and ')}).`,
)
