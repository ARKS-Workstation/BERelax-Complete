#!/usr/bin/env node
/**
 * The PAN-never-touched gate: the half of SAQ-A that no type, no test and no import rule can express.
 *
 * Y-PAY-03's whole subject is an **absence** — no primary account number is ever touched by this system — and
 * an absence cannot be proved by anything passing. A suite that asserts "the audit row does not contain a card
 * number" passes on the day a card number could not possibly reach it and on the day it can, because on that
 * day nobody has run the card through yet. So the claim is defended by things that FAIL when it stops holding,
 * and this is the static one: seven rules, each with a known-bad fixture in gate block 145 that asserts
 * rejection BY NAME (ADR 0003).
 *
 * Card entry lives entirely in the gateway's cross-origin hosted fields. Four consequences follow, and each
 * one is a thing a later commit can quietly undo:
 *
 *   1. **No field this build renders may accept a card number.** An `autocomplete="cc-number"`, or an input
 *      named `cvv`, added to any admin screen or any CMS collection, is a SAQ-A checkout becoming a SAQ-A-EP
 *      one — a change of compliance scope made by a line of markup that reviews as an improvement. Rules 1
 *      and 2.
 *   2. **No request this build makes may carry one.** Every payments transport reads its body through ONE
 *      boundary, `authoriseCheckout`, whose first act is `assertNoCardData`. A second transport that reads a
 *      body its own way is the failure: one endpoint checks and the other does not, and the second is the one
 *      somebody adds in six months for a different client. Rules 3 and 4.
 *   3. **There is ONE definition of what a card number looks like.** A second Luhn check or a second PAN
 *      pattern is a second policy, and the second policy is the one that misses the spelling with spaces in it
 *      — or, worse, the one that disagrees with migration 0117 so a refusal arrives from the wrong layer.
 *      Rule 5. The migration is the ONE declared second statement and its agreement is held by
 *      `packages/fixtures/src/card-shape-agreement.itest.ts`.
 *   4. **No log, audit row, outbox event or error message may be able to contain one.** Every payments module
 *      that writes to a sink passes what it writes through `redactCardData`. Rule 6. The runtime half is the
 *      sweep in `apps/web/src/checkout.itest.ts`, which drives a Luhn-valid test PAN through the checkout and
 *      full-text scans `audit_event`, `outbox_event`, the message outbox and the served response.
 *
 * Rule 7 is about the policy that keeps the frame a frame: the checkout's content-security policy has ONE
 * builder, and no gateway origin is written as a literal anywhere — because no gateway has been chosen and a
 * plausible-looking vendor domain is indistinguishable from a configured one (brief rule 15).
 *
 * ## What this deliberately does NOT claim
 *
 * It cannot tell a three-digit number in a field called `note` from any other three-digit number, and neither
 * can anything else. A CVV has no shape: three or four digits is also every fils amount under a hundred
 * dirhams, every OTP and every year. What is defended is that no field EXISTS to put one in, that nothing
 * renders an input that accepts one, and that a field named after one is refused the moment it appears. That
 * is the honest boundary of the mechanism and it is stated here rather than left to be discovered.
 *
 * Usage: `node scripts/check-saq-a.mjs`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { stripNonCode } from './lib/strip-non-code.mjs'

const ROOTS = ['apps', 'packages']
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.cjs'])
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'artifacts'])

const RULES = {
  autocomplete: 'saq-a-no-card-autocomplete-in-our-own-markup',
  cardField: 'saq-a-no-card-field-in-our-own-forms',
  oneBoundary: 'saq-a-payments-transport-reads-its-body-through-one-boundary',
  contractFields: 'saq-a-checkout-contract-names-no-card-data',
  oneDetector: 'saq-a-card-shape-has-one-definition',
  redactedSinks: 'saq-a-payments-sink-writes-go-through-the-redactor',
  onePolicy: 'saq-a-checkout-policy-has-one-builder-and-no-literal-origin',
}

/** This file and the gate suite necessarily contain every construct these rules forbid. */
const SELF = 'scripts/check-saq-a.mjs'
const GATE_SUITE = 'scripts/test-gates.mjs'

/** The one module that defines the shape, the refusal and the redactor. */
const DETECTOR = 'packages/payments/src/redaction.ts'
/** The one module that reads a payments submission. */
const BOUNDARY = 'packages/payments/src/checkout.ts'
/** The one module that builds the checkout's content-security policy. */
const POLICY = 'packages/payments/src/hosted-fields.ts'

/**
 * Files permitted to contain a `cc-` autocomplete token or a card-named form control, with the reason.
 *
 * ONE entry, and it is the fixture the cross-origin proof needs: `checkout.itest.ts` stands a stand-in gateway
 * origin up on its own port and serves a card-entry document from it, because "the card field is inside a
 * cross-origin iframe" is `frame.contentDocument === null` in a real browser and cannot be asserted against a
 * frame with no card field in it. That document is served from a DIFFERENT ORIGIN by a server that is not this
 * application, which is exactly what it stands for (ADR 0022: every external service is a port with a fake).
 */
const PERMITTED_CARD_MARKUP = new Map([
  [
    'apps/web/src/checkout.itest.ts',
    'The stand-in GATEWAY origin. Its card-entry document is served from a different origin by a plain ' +
      'node:http server, and it exists so that "the page cannot read the card field" is asserted against a ' +
      'frame that HAS one — without it the central claim of the unit would be vacuous.',
  ],
])

/**
 * Files permitted to state the card shape a second time, with the reason.
 *
 * ONE entry, and it is the deliberate second statement: SQL cannot read TypeScript, so migration 0117 writes
 * `luhn_check()` and `is_card_shaped()` out again. The brief's rule is that a second statement of a fact
 * drifts and the check that holds the two equal ships in the same commit —
 * `packages/fixtures/src/card-shape-agreement.itest.ts` drives `CARD_SHAPE_PROBES` through both and requires
 * identical verdicts. The `.sql` file is not scanned by this gate (it reads source modules), so this entry
 * exists to record the exemption rather than to grant one.
 */
const PERMITTED_SECOND_STATEMENTS = new Map([
  [
    'packages/db/migrations/0117_card_shape_refusal.sql',
    'The database half. Held equal to the TypeScript by card-shape-agreement.itest.ts, in this commit.',
  ],
])

/**
 * Payments transports: a route module that takes a payment. Each must reach the one boundary.
 *
 * Matched by PATH shape rather than listed, so an endpoint added later is covered on the day it exists. That is
 * the whole point of the rule: a list would be a second copy of the filesystem and the entry nobody adds is
 * the endpoint that skips the refusal.
 */
const IS_PAYMENTS_TRANSPORT = (file) =>
  /^apps\/web\/app\/.*\/payments\/.*\/(?:route|handler)\.tsx?$/.test(file) ||
  /^apps\/web\/app\/.*\/checkout\/(?:route|handler)\.tsx?$/.test(file)

/** How a transport is allowed to read a submission: through the boundary, or through the refusal itself. */
const REACHES_BOUNDARY = /\bauthoriseCheckout\b|\bassertNoCardData\b|\bparseCheckoutSubmission\b/

/** A transport that reads a body at all. One that reads none has nothing to route through the boundary. */
const READS_A_BODY =
  /\brequest\.(?:json|text|formData)\s*\(|\bnew URLSearchParams\s*\(|\bCheckoutBody\b/

/** The autocomplete tokens the HTML specification defines for card data. */
const CARD_AUTOCOMPLETE = [
  'cc-number',
  'cc-csc',
  'cc-exp',
  'cc-exp-month',
  'cc-exp-year',
  'cc-name',
  'cc-given-name',
  'cc-family-name',
  'cc-additional-name',
  'cc-type',
]

/**
 * Field names that hold card data, normalised. The same vocabulary as `CARD_DATA_FIELD_NAMES`.
 *
 * Read from the detector module rather than restated, so the two cannot disagree: a name added there is
 * refused in markup on the same commit. A parse failure is a FAILURE and not a skip — a gate that could not
 * find what it compares reports agreement it never measured (ADR 0002).
 */
function cardFieldNames(problems) {
  const text = readFileSync(DETECTOR, 'utf8')
  const block =
    /export const CARD_DATA_FIELD_NAMES: readonly string\[\] = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(
      text,
    )
  if (block === null) {
    problems.push(
      `[${RULES.cardField}] CARD_DATA_FIELD_NAMES could not be read out of ${DETECTOR}. A gate that cannot ` +
        'find what it compares reports agreement it never measured (ADR 0002), so this is a failure rather ' +
        'than a skip.',
    )
    return []
  }
  const names = [...block[1].matchAll(/'([a-z0-9]+)'/g)].map((match) => match[1])
  if (names.length < 10) {
    problems.push(
      `[${RULES.cardField}] only ${names.length} card field name(s) parsed out of ${DETECTOR}; the list did ` +
        'not read. Every comparison below would pass over almost nothing.',
    )
  }
  return names
}

const normalise = (name) => name.toLowerCase().replaceAll(/[\s_-]/g, '')

function sourceFiles() {
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (EXTENSIONS.has(extname(entry.name))) found.push(path)
    }
  }
  for (const root of ROOTS) {
    try {
      if (statSync(root).isDirectory()) walk(root)
    } catch {
      // A root that is not there is a repository shape this gate does not know; the count control below
      // reports it rather than passing quietly.
    }
  }
  return found.sort()
}

const IS_TEST = (file) => /\.(?:test|itest)\.tsx?$/.test(file)

const problems = []

/**
 * Every scanned file, with comments blanked and string CONTENTS intact.
 *
 * Strings survive because the markup this gate reads IS a string — `autocomplete="off"` lives inside a
 * template literal — and blanking them would blank the only thing there is to read. Comments are blanked for
 * `strip-non-code.mjs`'s own reason: a rule explained in a doc comment must not be reported as a violation of
 * itself, which is not hypothetical — every file in this unit explains what `cc-number` is.
 */
const codeOf = new Map()
for (const file of sourceFiles()) {
  if (file === SELF || file === GATE_SUITE) continue
  codeOf.set(file, stripNonCode(readFileSync(file, 'utf8')))
}

// The control comes first. Every rule below is a scan, and a scan over nothing reports success (ADR 0002).
if (codeOf.size < 200) {
  problems.push(
    `[${RULES.autocomplete}] only ${codeOf.size} source file(s) were scanned, which means the walk failed. ` +
      'Every rule below would pass over almost nothing.',
  )
}

const FIELD_NAMES = cardFieldNames(problems)

// --- rule 1: no card autocomplete token in our own markup ---------------------------------------
for (const [file, code] of codeOf) {
  if (PERMITTED_CARD_MARKUP.has(file)) continue
  // A test may NAME the token it forbids — `checkout-render.test.ts` asserts the document does not contain
  // one, and condemning it would make the rule unassertable. The hole this leaves is narrow and is stated
  // rather than hidden: a card field inside a file named `*.test.tsx` is not rendered by the application, and
  // the markup rules are about files that render. Gate block 145 plants its fixture in a SHIPPED file.
  if (IS_TEST(file)) continue
  const found = CARD_AUTOCOMPLETE.filter((token) => code.includes(token))
  if (found.length === 0) continue
  problems.push(
    `${file}  [${RULES.autocomplete}] names the card autocomplete token(s) ${found.join(', ')}. Card entry ` +
      "happens entirely inside the gateway's cross-origin hosted fields, so no field this build renders may " +
      'accept a card number, an expiry or a security code. A field here is not a feature: it changes this ' +
      "system's PCI scope from SAQ-A to SAQ-A-EP, and it does it in a line of markup that reviews as an " +
      'improvement. See ADR 0067.',
  )
}

// --- rule 2: no form control named after card data ----------------------------------------------
for (const [file, code] of codeOf) {
  if (PERMITTED_CARD_MARKUP.has(file) || IS_TEST(file)) continue
  /*
    A form control's `name`, or a Payload collection field's `name`, whose value is card data.

    Two shapes, because there are two ways a field reaches a browser in this build. `name="cvv"` inside a
    `<input>` is the admin screens'; `{ name: 'cvv', type: 'text' }` is a CMS collection's, and the catalogue
    boundary gate found the same shape mattering for a `price` field — a Payload field is rendered by Payload's
    own admin, which this repository does not control the markup of.

    The `<input` prefix is required for the first shape: a bare /name="…"/ also matches `<meta name="robots">`
    and every `name:` in a data structure, and the first version of the equivalent scan in
    `checkout-render.test.ts` reported two meta tags as form fields.
  */
  const offenders = new Set()
  for (const match of code.matchAll(/<(?:input|select|textarea)\b[^>]*\bname="([^"]+)"/g)) {
    if (FIELD_NAMES.includes(normalise(match[1]))) offenders.add(match[1])
  }
  for (const match of code.matchAll(/\bname:\s*'([A-Za-z0-9_-]+)'/g)) {
    if (FIELD_NAMES.includes(normalise(match[1]))) offenders.add(match[1])
  }
  if (offenders.size === 0) continue
  problems.push(
    `${file}  [${RULES.cardField}] declares the field(s) ${[...offenders].join(', ')}, which hold card data. ` +
      'There is no field in this build for a card number, an expiry or a security code, and there must not ' +
      "be: the gateway's hosted fields collect them in a document this application cannot read. A field " +
      'named after card data is refused whether or not anything ever puts a value in it — the field is the ' +
      'defect. See ADR 0067.',
  )
}

// --- rule 3: every payments transport reads its body through the one boundary --------------------
{
  const transports = [...codeOf.keys()].filter((file) => IS_PAYMENTS_TRANSPORT(file))
  if (transports.length < 3) {
    problems.push(
      `[${RULES.oneBoundary}] only ${transports.length} payments transport(s) were found, so the rule ` +
        'matched almost nothing. The path pattern has gone stale against the app directory.',
    )
  }
  for (const file of transports) {
    const code = codeOf.get(file) ?? ''
    if (!READS_A_BODY.test(code)) continue
    if (REACHES_BOUNDARY.test(code)) continue
    problems.push(
      `${file}  [${RULES.oneBoundary}] reads a request body and does not reach authoriseCheckout, ` +
        'parseCheckoutSubmission or assertNoCardData. Every payments transport reads its body through ONE ' +
        'boundary whose first act is the card-data refusal. Two transports for one submission is how one of ' +
        'them comes to read a body its own way and skip the refusal — and the one that skips it is the one ' +
        'somebody adds later for a different client. See ADR 0067.',
    )
  }
}

// --- rule 4: the checkout contract names no card data -------------------------------------------
{
  const text = readFileSync(BOUNDARY, 'utf8')
  const block = /export const CHECKOUT_FIELDS = \{([\s\S]*?)\} as const/.exec(text)
  if (block === null) {
    problems.push(
      `[${RULES.contractFields}] CHECKOUT_FIELDS could not be read out of ${BOUNDARY}. A gate that cannot ` +
        'find what it compares reports agreement it never measured (ADR 0002).',
    )
  } else {
    const declared = [...block[1].matchAll(/^\s*([A-Za-z0-9_]+):\s*'([^']+)',/gm)].map((m) => m[2])
    if (declared.length === 0) {
      problems.push(
        `[${RULES.contractFields}] CHECKOUT_FIELDS parsed EMPTY, so the check below reads nothing.`,
      )
    }
    const offenders = declared.filter((name) => FIELD_NAMES.includes(normalise(name)))
    if (offenders.length > 0) {
      problems.push(
        `${BOUNDARY}  [${RULES.contractFields}] the checkout contract declares ${offenders.join(', ')}, ` +
          'which is card data. The markup rules above stop a card field being RENDERED; this stops one ' +
          'being accepted, which is the other half — a field nothing renders is still a field a `curl` can ' +
          'fill in.',
      )
    }
  }
}

// --- rule 5: the card shape has one definition --------------------------------------------------
for (const [file, code] of codeOf) {
  if (file === DETECTOR || PERMITTED_SECOND_STATEMENTS.has(file)) continue
  /*
    A second statement of the shape, in either of the two forms it takes.

    A LUHN walk: the doubling-and-casting-out-nines step is unmistakable — `* 2` followed by `- 9` within a
    few lines, or a `% 10 === 0` beside either. A PAN PATTERN: a character class of digits with a 13-to-19
    length quantifier.

    Deliberately narrow. A rule matching "any `% 10`" would condemn every modulo in the build and be turned
    off within the week, which is `check-send-chokepoint.mjs`'s argument for discriminating on SHAPE rather
    than on a name. What is caught is the specific arithmetic nobody writes by accident.
  */
  const luhn = /\*\s*2\b[\s\S]{0,200}?-\s*9\b[\s\S]{0,200}?%\s*10/.test(code)
  const pattern = /\\d\{1[3-9],\s*1[3-9]\}|\[0-9\]\{1[3-9],\s*1[3-9]\}/.test(code)
  if (!luhn && !pattern) continue
  // A test may assert against the detector's answers; it may not implement one. This distinction is what
  // stops the rule from condemning `redaction.test.ts`, which carries the numbers and not the arithmetic.
  problems.push(
    `${file}  [${RULES.oneDetector}] states the card-number shape a second time (${luhn ? 'a Luhn walk' : 'a PAN pattern'}). ` +
      `There is ONE definition, in ${DETECTOR}. A second is a second policy, and the second policy is the ` +
      'one that misses the spelling with spaces in it — or that disagrees with migration 0117, so a refusal ' +
      'arrives from the wrong layer and nothing says which. The migration is the one declared second ' +
      'statement and its agreement is held by packages/fixtures/src/card-shape-agreement.itest.ts.',
  )
}

// --- rule 6: a payments sink write goes through the redactor -------------------------------------
for (const [file, code] of codeOf) {
  if (!file.startsWith('packages/payments/src/') || IS_TEST(file)) continue
  // `uow.audit.record(` and `uow.publish(` are the two sinks `@berelax/db` offers, and a payments module that
  // reaches either is writing something derived from a request. It must name the redactor.
  if (!/\baudit\.record\s*\(|\bpublish\s*\(/.test(code)) continue
  if (/\bredactCardData\b|\bredactedMessage\b|\bredactText\b/.test(code)) continue
  problems.push(
    `${file}  [${RULES.redactedSinks}] writes to an audit_event or an outbox_event and names no redactor. ` +
      'Every payments payload that reaches a sink passes through redactCardData. This is the half migration ' +
      '0117 deliberately does NOT do: a trigger on audit_event would refuse a legitimate write about one ' +
      'long digit run in ten — a TRN, an IBAN, an E.164 number — and an audit write that can be refused is ' +
      'an audit trail with a hole in it. Structural where a refusal is safe, redacted where it is not. See ' +
      'ADR 0067.',
  )
}

// --- rule 7: one policy builder, and no literal gateway origin ----------------------------------
for (const [file, code] of codeOf) {
  if (file === POLICY || IS_TEST(file)) continue
  if (/\bframe-src\b|\bscript-src\b/.test(code)) {
    problems.push(
      `${file}  [${RULES.onePolicy}] writes a frame-src or script-src directive. The checkout's ` +
        `content-security policy has ONE builder, checkoutContentSecurityPolicy in ${POLICY}, so a test can ` +
        'state the whole expected string and a gate can break it. A policy assembled in a handler is a ' +
        'policy nothing can assert the value of, which is how a directive comes to be widened by a line ' +
        'that looks like configuration.',
    )
  }
}
for (const [file, code] of codeOf) {
  if (IS_TEST(file)) continue
  if (!file.startsWith('packages/payments/src/') && !file.includes('/checkout/')) continue
  const literals = [...code.matchAll(/'(https?:\/\/[^']+)'/g)].map((match) => match[1])
  if (literals.length === 0) continue
  problems.push(
    `${file}  [${RULES.onePolicy}] holds the literal origin(s) ${literals.join(', ')}. No gateway has been ` +
      'chosen, no merchant account exists (OPEN-QUESTIONS Y7-gateway, Y7-hosted-fields) and brief rule 15 ' +
      'refuses a plausible one: a hard-coded vendor domain is indistinguishable from a configured one, and ' +
      'the day somebody reads it as configured is the day a checkout frames a domain nobody owns. The ' +
      'origins are PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN and PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN, with no ' +
      'default, and the unconfigured state renders a refusal instead of a frame.',
  )
}

if (problems.length > 0) {
  console.error(`SAQ-A: ${problems.length} problem(s).\n\n${problems.join('\n\n')}\n`)
  process.exit(1)
}

console.log(
  `SAQ-A holds: ${codeOf.size} source file(s) scanned against ${FIELD_NAMES.length} card field name(s) and ` +
    `${CARD_AUTOCOMPLETE.length} card autocomplete token(s); no rendered card field, one submission ` +
    'boundary, one card-shape definition, every payments sink write redacted, and one policy builder with no ' +
    'literal gateway origin.',
)
