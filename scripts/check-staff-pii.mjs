#!/usr/bin/env node
/**
 * Refuses a staff identity number or bank account that could be a real person's.
 *
 * `pnpm secrets` answers "is a credential committed" and `pnpm rotation` answers "when one leaks, what
 * does somebody do at 02:00". Neither covers this, and the difference is not academic: **an Emirates ID
 * cannot be rotated.** A leaked API key is replaced in a console; a leaked identity number belongs to a
 * person for life, and no procedure anywhere in this repository can undo committing one. So the control
 * has to be the one that runs before it happens.
 *
 * It is also why the rule is not "do not commit real data". Migration 0050 and
 * `packages/hr/src/staff-secret.ts` put every real number behind AES-256-GCM, and the risk that remains
 * is the *fixture*: the nineteen therapists are real people (`Y8-staff`, `Y12-consent-photo`), somebody
 * writing a test needs an Emirates ID to seal, and the natural thing to reach for is a plausible one.
 * Brief rule 15 is the argument — "a plausible value is worse than a blank one: blank is visibly
 * unanswered, and plausible is indistinguishable from configured" — and for an identity number the
 * plausible value is worse still, because it may be somebody's.
 *
 * ## The checkable rule
 *
 * Both of these formats carry a **check digit**, which is what makes the rule mechanical rather than a
 * matter of judgement:
 *
 *   - a UAE IBAN is `AE` + 2 ISO 13616 check digits + 19 digits, and the check digits are a mod-97
 *     residue over the rearranged string. A value that passes it is a structurally valid account number.
 *   - an Emirates ID is `784-YYYY-NNNNNNN-C`, fifteen digits whose last is a Luhn check digit over the
 *     first fourteen. A value that passes it is a structurally valid identity number.
 *
 * So: **a committed value that passes its own check digit is refused, and one that fails is allowed.**
 * A fixture author has a rule they can follow ("break the check digit, and say in a comment that you
 * did"), and the gate cannot be satisfied by a value that might belong to somebody. The inverse matters
 * as much: a gate that refused every IBAN-shaped string would be switched off the first time a test
 * needed one, and then there would be no gate at all — the same argument
 * `scripts/check-secrets.mjs` makes for keeping its general rule narrow.
 *
 * ## What it deliberately does not do
 *
 * It never prints the matched value. A gate that echoed an identity number would have put another copy
 * of it in the CI log, the agent transcript and a terminal scrollback — three more than existed before
 * it ran, and this is the one class of value that cannot be rotated afterwards. It reports the path, the
 * line, the rule and the length.
 *
 * It scopes the IBAN rule to **AE**. A Wage Protection System file pays UAE accounts, and a rule over
 * every ISO country code would match base64 integrity hashes in `pnpm-lock.yaml` by the thousand: two
 * upper-case letters followed by digits is a common accident, and a gate with false positives is a gate
 * people learn to ignore. If a foreign account ever has to be stored, widen this then — with the
 * country in the reason.
 *
 * The **seed output** half of the acceptance criterion is not here and cannot be: it needs a database.
 * `packages/hr/src/employee.itest.ts` reads the seeded tables back as text and asserts the same two
 * shapes are absent, which is the same rule applied to rows rather than to files.
 *
 * Usage: `node scripts/check-staff-pii.mjs`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

/**
 * Binary and rendered artefacts. A JPEG whose bytes happen to spell `784` followed by twelve digits is
 * not a committed identity number, and reporting a byte offset inside a photograph of somebody is how a
 * gate teaches people to ignore it.
 */
const SKIP_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.gif',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.webm',
  '.zip',
  '.gz',
  '.y4m',
])

/** ISO 13616 mod-97. True when the value is a structurally valid IBAN. */
function ibanCheckDigitsPass(iban) {
  const compact = iban.replace(/\s+/g, '').toUpperCase()
  if (compact.length < 15 || compact.length > 34) return false
  // The first four characters move to the end, then letters become numbers (A = 10 … Z = 35).
  const rearranged = compact.slice(4) + compact.slice(0, 4)
  let remainder = 0
  for (const character of rearranged) {
    const value = /[0-9]/.test(character)
      ? character
      : String(character.charCodeAt(0) - 'A'.charCodeAt(0) + 10)
    // Digit at a time, because a 34-character IBAN as one integer overflows a JS number.
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97
  }
  return remainder === 1
}

/** Luhn over the fifteen digits. True when the value is a structurally valid Emirates ID. */
function emiratesIdCheckDigitPasses(digits) {
  const compact = digits.replace(/\D+/g, '')
  if (compact.length !== 15) return false
  let sum = 0
  // Right to left: every second digit is doubled, and a doubled digit over 9 has 9 subtracted.
  for (const [offset, character] of [...compact].reverse().entries()) {
    const digit = Number(character)
    if (offset % 2 === 0) {
      sum += digit
      continue
    }
    const doubled = digit * 2
    sum += doubled > 9 ? doubled - 9 : doubled
  }
  return sum % 10 === 0
}

/**
 * Each rule is a shape plus a check digit, and `refuses` is the reason rather than a restatement.
 *
 * The separators matter for the IBAN: `AE00 0000 0000 0000 0000 000` — groups of four — is the
 * conventional print format and the one somebody pastes off a bank letter, so a rule that only matched
 * the compact form would miss exactly the value most likely to arrive by copy and paste.
 *
 * That example is written with `AE00` and zeros on purpose, and the first draft of this file was not: it
 * carried a realistic-looking spaced IBAN as an illustration, and this gate's own first run rejected the
 * gate. Which is the rule working — a documentation example is a committed value like any other.
 */
const RULES = [
  {
    name: 'plaintext-iban',
    // AE plus 21 digits, optionally in groups of four. Word-bounded at the start so `MAE07…` is not a
    // match, and the trailing boundary excludes a longer digit run.
    pattern: /\bAE(?:\d[\s-]?){21}(?![\d])/g,
    passes: (match) => ibanCheckDigitsPass(match),
    refuses:
      'a structurally valid UAE IBAN. Every real account number lives in ' +
      'employee_bank_detail.detail_ct under STAFF_PII_KEK and nowhere else (migration 0050). For a ' +
      'fixture, break the mod-97 check digits — AE00 followed by any digits can never be a real IBAN, ' +
      'because 00 is not a producible residue — and say in a comment that you did',
  },
  {
    name: 'plaintext-emirates-id',
    // 784-YYYY-NNNNNNN-C and the bare fifteen-digit form. Both are what an HR file holds.
    pattern: /\b784[\s-]?\d{4}[\s-]?\d{7}[\s-]?\d\b/g,
    passes: (match) => emiratesIdCheckDigitPasses(match),
    refuses:
      'a structurally valid Emirates ID. This is the one value in this system that cannot be ' +
      'rotated: it belongs to a person for life, so a committed one is permanent. Every real number ' +
      'lives in employee_document.number_ct under STAFF_PII_KEK (migration 0050). For a fixture, break ' +
      'the Luhn check digit and say in a comment that you did',
  },
]

/** Tracked files plus untracked-but-not-ignored ones, so a fixture written into the tree is scanned. */
function scannableFiles() {
  const listed = execFileSync(
    'git',
    ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return listed
    .split('\0')
    .filter((path) => path !== '')
    .filter((path) => !SKIP_EXTENSIONS.has(extname(path).toLowerCase()))
}

const files = scannableFiles()
const findings = []
let candidates = 0

for (const file of files) {
  let text
  try {
    text = readFileSync(join(ROOT, file), 'utf8')
  } catch {
    continue
  }
  if (text.includes('\0')) continue
  for (const [index, line] of text.split('\n').entries()) {
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        candidates += 1
        if (!rule.passes(match[0])) continue
        findings.push({
          file,
          line: index + 1,
          rule: rule.name,
          length: match[0].length,
          refuses: rule.refuses,
        })
      }
    }
  }
}

const problems = findings.map(
  (finding) =>
    `${finding.file}:${finding.line}  [${finding.rule}] ${finding.length} characters — ` +
    finding.refuses,
)

// ADR 0003's failure mode: a scan that examined nothing reports success. `git ls-files` returning an
// empty list — the wrong working directory, a broken checkout — must fail rather than pass.
if (files.length < 100) {
  problems.push(
    `[nothing-scanned] only ${files.length} files were readable; this repository has hundreds`,
  )
}

if (problems.length > 0) {
  console.error('Staff PII scan failed:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    `\n${problems.length} problem(s). The matched values are deliberately not printed: an identity ` +
      'number cannot be rotated, and echoing one here would put another copy of it in the CI log.',
  )
  process.exit(1)
}

console.log(
  `No real-shaped staff PII in ${files.length} scannable files: ${RULES.length} rules, ` +
    `${candidates} shaped value(s) examined and every one fails its own check digit.`,
)
