import { e164IdentityResult } from '@berelax/core'
import {
  buildContactWorkbook,
  CONTACT_HEADER,
  type ContactNormaliser,
} from '@berelax/migration/importers/customers'
import { assertSynthetic, syntheticPerson } from './synthetic.ts'

/**
 * The contact lists H-MIG-04's suite imports, and the one place a spelling of a fixture number is written.
 *
 * ## Why the fixture is GENERATED rather than committed
 *
 * The acceptance line is "a 2,000-row fixture with 12% planted duplicates yields the expected distinct
 * count", and the two figures have to be derivable from the file rather than asserted beside it: a
 * committed file whose duplicate count drifted from the number in the test would make the case pass while
 * measuring the wrong thing. {@link buildContactList} returns the bytes AND what is in them, computed by
 * the same loop, so the expected count is a property of the generator rather than a literal in a suite.
 *
 * It also has to be unique per EXECUTION. `customer.phone_e164` is UNIQUE, so a second run over the same
 * numbers resolves every line to the customer the first run created — `matched`, not `created` — and a
 * suite with fixed numbers would assert 1,760 creations once and zero for ever after. Green the first
 * time, red afterwards, and about nothing. So the numbers are drawn from a per-execution base, which is
 * the arrangement `package-liability.itest.ts` and `rights.itest.ts` both need and for the same reason.
 *
 * ## Every number is synthetic and is asserted to be
 *
 * `syntheticPerson` derives a number on `+971 59`, which is NOT an allocated UAE mobile prefix, and
 * {@link assertSynthetic} fails the build if one lands on a real prefix or collides with any of the
 * business's own numbers. That guarantee matters more here than anywhere else in the build: this is the
 * only fixture that creates customers in bulk, and a two-thousand-line list of numbers that could ring
 * real handsets is the one fixture somebody would eventually send a message to.
 *
 * The two numbers H-MIG-04's acceptance line names are therefore deliberately NOT in any list this module
 * builds. They are the business's own, from docs/13 §3 (`WHATSAPP_CANDIDATES` and
 * `PREMISES_NAP.phoneLandline`), and `REAL_BUSINESS_NUMBERS` names both: a fixture may NORMALISE them,
 * which is what proves the acceptance, and may not create a customer from one. They are not spelled out
 * here either, for the reason `premises.test.ts`'s `nap-literal-outside-the-seed` rule exists — the seed
 * and the test files are the only places a NAP literal belongs, and this is neither.
 *
 * ## Why the spellings are a list and not a formatter
 *
 * `CONTACT_SPELLINGS` is what a phone contact export actually contains: a trunk prefix, no trunk prefix,
 * `+971`, `00971`, spaces, brackets, Arabic-Indic digits, and the non-breaking space a WhatsApp paste
 * carries. Each entry is a function of the canonical number, so a list of 1,760 numbers written through
 * them exercises the normaliser over every spelling rather than over whichever one somebody typed into a
 * fixture — and a planted duplicate is the SAME number in a DIFFERENT spelling, which is the only kind of
 * duplicate worth planting: two identical lines would be caught by comparing strings.
 */

/** The normaliser the importer is built with in every suite. Named once so no caller wires a different one. */
export const contactNormaliser: ContactNormaliser = (raw) => {
  const result = e164IdentityResult(raw)
  return result.ok
    ? { ok: true, e164: result.e164, messageable: result.messageable }
    : { ok: false, reason: result.reason }
}

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩'

/** `+971590000042` -> `590000042`. The national significant number, which every spelling is built from. */
const nsnOf = (e164: string): string => e164.replace('+971', '')

/**
 * How a contact list spells one number. Every entry must normalise back to the number it was built from,
 * and `customer-import.test.ts` asserts exactly that over the whole list rather than trusting it.
 */
export const CONTACT_SPELLINGS: readonly ((e164: string) => string)[] = Object.freeze([
  (e164) => e164,
  (e164) => `0${nsnOf(e164)}`,
  (e164) => {
    const nsn = nsnOf(e164)
    return `0${nsn.slice(0, 2)} ${nsn.slice(2, 5)} ${nsn.slice(5)}`
  },
  (e164) => `00971${nsnOf(e164)}`,
  (e164) => {
    const nsn = nsnOf(e164)
    return `971 ${nsn.slice(0, 2)} ${nsn.slice(2, 5)} ${nsn.slice(5)}`
  },
  (e164) => {
    const nsn = nsnOf(e164)
    return `(0${nsn.slice(0, 2)}) ${nsn.slice(2, 5)}-${nsn.slice(5)}`
  },
  // An Arabic-locale contact list. The same number, in the digits somebody actually typed.
  (e164) =>
    `0${nsnOf(e164)}`
      .split('')
      .map((digit) => ARABIC_INDIC[Number(digit)] ?? digit)
      .join(''),
  // A WhatsApp paste. U+00A0 is invisible on screen and is a different string.
  (e164) => `+971 ${nsnOf(e164)}`,
])

/**
 * Cells no normaliser can read, one per reason `E164_IDENTITY_REJECTIONS` names — and PER EXECUTION.
 *
 * The nonce is not decoration. A quarantined line stages the digest of the CELL rather than of a number
 * (there is no number), so a fixed cell keys identically on every run — and the framework's idempotence
 * then SKIPS it, because a completed run has already applied that content. A suite with fixed unreadable
 * cells asserts four quarantines on its first run and zero for ever afterwards: green once, then red about
 * nothing. The readable numbers already carry a per-execution base for the same reason; these had to as
 * well, and the integration suite found it the second time it ran.
 *
 * Each cell still produces exactly the reason it names, with the nonce inside it rather than beside it:
 *
 *   - `empty` is a run of dashes, which is what a contacts export writes where it has no number.
 *     `phoneTokens` strips `-` as a separator, so the cell reaches the normaliser with no digits in it.
 *     It is NOT whitespace: a line whose every cell is blank is a BLANK LINE to `parseContactWorkbook`,
 *     dropped with the spacers and the trailing newline, so a whitespace-only cell would not be a
 *     quarantined row at all and this fixture would report one more line than the file has.
 *   - `not_digits` is prose, which is what somebody types when there is no number to copy.
 *   - `unsupported_country` is a `+999` number, which is an ITU-reserved country code and therefore
 *     reaches nobody.
 *   - `wrong_length` is a UAE mobile prefix with the wrong number of digits after it.
 *
 * The nonce a caller passes should be a full `Date.now()` rather than a bounded remainder: every cell here
 * carries the whole of it, so two runs collide only if they start in the same millisecond.
 */
export function unreadableCells(
  nonce: number,
): readonly { readonly cell: string; readonly reason: string }[] {
  const n = Math.abs(Math.trunc(nonce))
  const digits = String(n)
  return Object.freeze([
    Object.freeze({ cell: separatorsEncoding(n), reason: 'empty' }),
    Object.freeze({ cell: `ask at the front desk (list ${digits})`, reason: 'not_digits' }),
    // `+999` is an ITU-reserved country code, so this cannot be a number that reaches anybody — and the
    // nonce can be as long as it likes, because `unsupported_country` is decided by the country code and
    // not by the length. A real foreign range would bound the nonce and reintroduce the collision.
    Object.freeze({ cell: `+999 ${digits} 0123`, reason: 'unsupported_country' }),
    // A UAE mobile prefix with the wrong number of digits after it: `5` is only valid at nine national
    // digits, so `525` plus the nonce is `wrong_length` whatever the nonce is.
    Object.freeze({ cell: `0525${digits}`, reason: 'wrong_length' }),
  ])
}

/**
 * The nonce written in separator characters, which is how an `empty` cell can be unique per execution.
 *
 * `phoneTokens` in `@berelax/core` strips `[\s()[\].\-–—/]` before anything is parsed, so a cell built
 * only from those characters reaches the normaliser with no digits in it and is `empty` — whatever its
 * length and whichever of them it holds. Base five over five of those characters therefore encodes an
 * arbitrary nonce into a cell that still means "there is no number here".
 *
 * The obvious alternative, a fixed `-`, is what this replaced: it keys identically on every run, so the
 * framework's idempotence skipped it and the quarantine assertion dropped from four to three without
 * anything being wrong with the import. Encoding the nonce in the LENGTH alone (`'-'.repeat(n)`) would
 * also work and would put a thousand dashes in a fixture file.
 */
function separatorsEncoding(nonce: number): string {
  const alphabet = ['-', '.', '/', '(', ')'] as const
  let left = nonce
  let out = ''
  do {
    out = `${alphabet[left % alphabet.length] ?? '-'}${out}`
    left = Math.floor(left / alphabet.length)
  } while (left > 0)
  return out
}

/** The reasons {@link unreadableCells} plants, whatever nonce it is given. */
export const UNREADABLE_REASONS: readonly string[] = Object.freeze(
  unreadableCells(0).map((entry) => entry.reason),
)

export interface ContactListOptions {
  /**
   * The first `syntheticPerson` index this list draws from.
   *
   * Callers pass a per-execution value — see the module note. The suite's own band is stated there rather
   * than here, because a band is a fact about which fixtures coexist and this module builds a list for
   * whoever asks.
   */
  readonly baseIndex: number
  /** How many distinct people the list is about. */
  readonly distinct: number
  /** How many lines repeat a number an earlier line named, in a different spelling. */
  readonly duplicates?: number
  /** Every nth line claims a marketing consent. `1` makes every line claim one. */
  readonly claimEvery?: number
  /** Unreadable cells to plant, from {@link unreadableCells}. */
  readonly unreadable?: readonly { readonly cell: string; readonly reason: string }[]
}

export interface ContactListFixture {
  /** The file, header and preamble included, exactly as an importer receives it. */
  readonly sourceText: string
  /** The canonical numbers, in the order they first appear. The import's distinct count. */
  readonly numbers: readonly string[]
  /** Data lines, including repeats and unreadable cells. */
  readonly lines: number
  readonly duplicates: number
  readonly quarantined: number
  readonly claims: number
  /** How many of the distinct numbers nothing can send to. Zero here: every number is a `59` mobile. */
  readonly unmessageable: number
}

/**
 * Builds one contact list and says what is in it.
 *
 * The two counts a suite asserts — distinct and duplicates — come out of this loop rather than out of a
 * literal, so a change to the generator cannot leave a suite asserting the old shape. The duplicate lines
 * are INTERLEAVED rather than appended, because a repeat that always comes after every first occurrence
 * would never exercise the one ordering that matters: `resolveOrCreateImportedCustomer` decides `created`
 * or `matched` by whether the insert conflicted, and a file whose repeats are all at the end would behave
 * identically if that decision were made by counting lines.
 */
export function buildContactList(options: ContactListOptions): ContactListFixture {
  const duplicates = options.duplicates ?? 0
  const unreadable = options.unreadable ?? []
  const claimEvery = options.claimEvery ?? 0

  const numbers: string[] = []
  for (let at = 0; at < options.distinct; at += 1) {
    const person = syntheticPerson(options.baseIndex + at)
    // At the point of creation, which is the arrangement `synthetic.ts` describes: a guarantee asserted
    // once in a test somebody may later delete is not a guarantee.
    assertSynthetic(person)
    numbers.push(person.phone)
  }

  /** Interleaving: after every `gap` first occurrences, repeat one of the numbers already written. */
  const gap =
    duplicates === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(1, Math.floor(options.distinct / duplicates))
  const rows: string[] = []
  let planted = 0
  for (const [at, e164] of numbers.entries()) {
    rows.push(spell(e164, at))
    if (planted < duplicates && at > 0 && at % gap === 0) {
      // A DIFFERENT spelling of a number already in the file. Two identical lines would be a duplicate
      // anything could find by comparing strings; this one is only visible to the normaliser.
      const repeated = numbers[at - 1] ?? e164
      rows.push(spell(repeated, at + CONTACT_SPELLINGS.length - 1))
      planted += 1
    }
  }
  // Any repeats the interleaving could not place — a `distinct` smaller than `duplicates` — go at the end
  // rather than being silently dropped, so the count this fixture reports is always the count in the file.
  while (planted < duplicates) {
    const e164 = numbers[planted % numbers.length] ?? ''
    rows.push(spell(e164, planted + 1))
    planted += 1
  }
  for (const entry of unreadable) rows.push(entry.cell)

  let claims = 0
  const lines = rows.map((cell, at) => {
    const claim = claimEvery > 0 && at % claimEvery === 0
    if (claim) claims += 1
    // Tab separated and unquoted, which is the file's dialect: the claim column is written even when it is
    // empty, because a row with one cell and a row with two empty cells are different lines to a parser.
    return `${cell}\t${claim ? 'yes' : ''}`
  })

  return {
    sourceText: `${buildContactWorkbook()}${lines.join('\n')}\n`,
    numbers: Object.freeze([...numbers]),
    lines: lines.length,
    duplicates: planted,
    quarantined: unreadable.length,
    claims,
    unmessageable: 0,
  }
}

/** One number in one of the spellings, chosen by position so a list exercises all of them. */
function spell(e164: string, at: number): string {
  const spelling = CONTACT_SPELLINGS[at % CONTACT_SPELLINGS.length]
  return spelling === undefined ? e164 : spelling(e164)
}

/** The header a filled list must carry, re-exported so a suite asserting the file's shape has one name. */
export const CONTACT_LIST_HEADER = CONTACT_HEADER
