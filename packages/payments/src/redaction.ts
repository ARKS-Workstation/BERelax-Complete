import { AppError } from '@berelax/shared'

/**
 * The one place this build knows what a card number looks like, and the one place it refuses one.
 *
 * Y-PAY-03's subject is an ABSENCE — *no primary account number is ever touched by this system* — and an
 * absence cannot be proved by a passing assertion. It can only be defended by something that FAILS on the
 * day the absence stops holding, which is why this module is small, why it is the only implementation of
 * the shape, and why `scripts/check-saq-a.mjs` refuses a second one anywhere in the tree.
 *
 * ## Three jobs, and they are deliberately different jobs
 *
 * **{@link cardShapedRuns} says what a card number looks like.** A 13-to-19-digit run that passes the Luhn
 * check, after single spaces and hyphens BETWEEN digits are removed — because `4111 1111 1111 1111` is how a
 * human pastes one and `4111111111111111` is how a machine sends it, and a detector that saw only the second
 * would be satisfied by a form somebody typed into.
 *
 * **{@link assertNoCardData} refuses a request** that carries one, or that carries a FIELD NAMED after card
 * data, and it is called before anything else on the payments request path. The two halves are not the same
 * rule and neither subsumes the other; see below.
 *
 * **{@link redactCardData} makes a value safe for a sink** — a log line, an `audit_event` payload, an
 * `outbox_event` payload, an error message, a Sentry breadcrumb. Refusing is the right answer to a REQUEST
 * and the wrong answer to a log line: a logger that threw would lose the record of the very refusal that
 * matters most. So the sink path redacts and the request path refuses, and the ONE thing both share is this
 * file's idea of the shape.
 *
 * ## Why a CVV is refused by NAME and a PAN by SHAPE
 *
 * A PAN has a shape: a 13-19 digit Luhn-valid run occurs in about one in ten random digit strings of that
 * length, and essentially never in this system's own data — `payment_intent.requested_fils` tops out around
 * ten digits, a UAE `phone_e164` is twelve, and a uuid's longest digit run is twelve. A CVV has no shape at
 * all: it is three or four digits, which is also every fils amount under a hundred dirhams, every OTP and
 * every year. A shape rule for a CVV would either refuse the whole system's traffic or refuse nothing.
 *
 * So the CVV is refused by the NAME of the field that would carry it ({@link CARD_DATA_FIELD_NAMES}), which
 * is a rule about our own request contract rather than about arbitrary text — and it is enforceable exactly
 * because this build's checkout has no such field: under SAQ-A the CVV is typed into the gateway's own
 * cross-origin document and never arrives here at all. A request that presents one is, by construction, not
 * a request this build's checkout made.
 *
 * That is the honest statement of the limit, and it is worth stating plainly: **a three-digit number in a
 * field called `note` cannot be told from any other three-digit number, by this module or by anything else.**
 * What is defended is that no field exists to put it in, that nothing renders an input that accepts it (the
 * SAQ-A gate's form rules), and that the value would be refused the moment it were named.
 *
 * ## Why the refusal message never contains the value
 *
 * Every refusal here names the PATH and the RULE and never the offending text. That is not tidiness. A
 * refusal is logged, and a refusal that quoted the digits it refused would put a PAN into the log stream by
 * the very act of keeping it out of the database — which is the failure mode this unit exists to prevent,
 * arriving through the door marked "safety". Migration 0117 takes the same decision one layer down and for a
 * sharper reason: a CHECK constraint would have been the obvious way to refuse card-shaped text in
 * `payment_intent.reference`, and PostgreSQL appends `DETAIL: Failing row contains (…)` to a CHECK
 * violation — so the constraint that kept the PAN out of the column would have written it into the server
 * log. See ADR 0067.
 */

/** What replaces a card-shaped run. Fixed text, so a scan can assert redaction happened rather than infer it. */
export const CARD_DATA_REDACTED = '[redacted:card-shaped-digits]'

/** What replaces the value of a field named after card data or a single-use instrument token. */
export const SECRET_FIELD_REDACTED = '[redacted:secret-field]'

/** The shortest and longest PAN an ISO/IEC 7812 issuer identification number can sit in front of. */
export const PAN_MIN_DIGITS = 13
export const PAN_MAX_DIGITS = 19

/**
 * Field names this build's request bodies may never carry, whatever their value.
 *
 * Lower-cased and stripped of `_` and `-` before comparison, so `card_number`, `cardNumber` and `CardNumber`
 * are one entry. Names rather than a regular expression over names, because a pattern like `/card/` would
 * refuse `cardholder_present` and `card_online` — the tender kind this whole path is about — and a rule that
 * refuses the system's own vocabulary is a rule somebody turns off.
 */
export const CARD_DATA_FIELD_NAMES: readonly string[] = Object.freeze([
  'pan',
  'cardnumber',
  'ccnumber',
  'accountnumber',
  'primaryaccountnumber',
  'cvv',
  'cvv2',
  'cvc',
  'cvc2',
  'csc',
  'cid',
  'securitycode',
  'cardsecuritycode',
  'expiry',
  'expirydate',
  'expmonth',
  'expyear',
  'cardexpiry',
  'track1',
  'track2',
  'trackdata',
  'magstripe',
])

/**
 * Field names whose value is a bearer credential rather than cardholder data.
 *
 * Not refused — the hosted-fields token is the one thing the browser is SUPPOSED to send us — but redacted
 * before any sink sees it. A single-use token is not a PAN and is not protected by SAQ-A; it is still a
 * credential that authorises one charge, so a log aggregator holding it for a retention period is a hole
 * with a shorter fuse rather than no hole.
 */
export const SECRET_FIELD_NAMES: readonly string[] = Object.freeze([
  'instrumenttoken',
  'hostedfieldstoken',
  'gatewayclienttoken',
  'paymentmethodnonce',
])

/** `Card_Number` and `cardNumber` are the same name for this module's purposes. */
export const normaliseFieldName = (name: string): string =>
  name.toLowerCase().replaceAll(/[\s_-]/g, '')

/**
 * The Luhn check, over a string of digits only.
 *
 * Exported because {@link cardShapedRuns} is not the only caller worth having: migration 0117 states this
 * arithmetic a second time in plpgsql, because SQL cannot read TypeScript, and
 * `packages/fixtures/src/card-shape-agreement.itest.ts` drives {@link CARD_SHAPE_PROBES} through both and
 * requires identical verdicts (brief: a second statement of a fact drifts, so the check that holds the two
 * equal ships in the same commit).
 */
export function isLuhnValid(digits: string): boolean {
  if (digits.length === 0 || /\D/.test(digits)) return false
  let sum = 0
  let double = false
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    // `digits` is all digits, checked above, so the parse cannot be NaN.
    let value = digits.charCodeAt(index) - 48
    if (double) {
      value *= 2
      if (value > 9) value -= 9
    }
    sum += value
    double = !double
  }
  return sum % 10 === 0
}

/**
 * Every card-shaped run in a piece of text, as the digits alone.
 *
 * ## The separator rule, and the UUID that broke the first version of it
 *
 * A single space or hyphen between two digit groups joins them, which is what makes `4111-1111-1111-1111` and
 * `4111 1111 1111 1111` the same candidate as the bare digits. Two separators in a row do not: `12 - 3456…`
 * is two numbers beside each other in prose, and joining them would invent a candidate nobody wrote.
 *
 * **A group longer than {@link MAX_GROUPED_DIGITS} never takes part in a join**, and that clause is the whole
 * of a real defect. The first version of this function simply deleted every separator between two digits, and
 * a UUID whose hex happens to be all digits — `00000000-0000-7000-8000-000000000000` — therefore joined into
 * one 33-digit run, which contains Luhn-valid windows by the dozen. So the payments endpoint answered 400 to
 * a request whose only sin was a numeric intent id. It was found by Y-PAY-02's own route suite, which asserts
 * a 404 for an intent that does not exist and got a 400, and it would have refused a measurable fraction of
 * every uuid this system passes around: a uuid's hex characters are digits five times in eight, so a
 * meaningful share of real ids join across two or three of their four hyphens into a run long enough to
 * contain a valid window.
 *
 * Six is the bound because card numbers are grouped in fours, and the longest group in any published card
 * format is the six in American Express's 4-6-5. A uuid's groups are 8-4-4-4-12, so its two long groups
 * cannot join to anything and the three fours in the middle reach twelve digits — one below the floor. That is
 * not a coincidence to rely on, which is why both uuid shapes are in {@link CARD_SHAPE_PROBES}.
 *
 * Then every chain is taken and every window of {@link PAN_MIN_DIGITS} to
 * {@link PAN_MAX_DIGITS} digits inside it is Luhn-checked. Windows rather than whole runs, and this is the
 * part that is easy to get wrong in the direction that matters: a PAN pasted inside a longer digit string —
 * a reference number with the card appended, a concatenated form value — is exactly the shape a whole-run
 * check misses, and it is the shape an accident produces. The cost is that a long run of digits has many
 * windows and about one in ten is Luhn-valid by chance, so a 40-digit number will usually be reported. That
 * is the safe direction for a refusal: this build has no legitimate 40-digit number, and a false refusal at
 * the payments boundary is a 400 somebody reads, where a false acceptance is a PAN in a database.
 *
 * Deduplicated, so a repeated number is reported once.
 *
 * **The cost of the window scan, measured.** Because a 16-digit run contains ten 13-to-19-digit windows and
 * each is Luhn-valid about one time in ten, roughly two thirds of arbitrary 16-digit runs contain one: a
 * sample of 200,000 random runs beginning `4` left 67,054 with no card-shaped window, so 66.5% were reported.
 * A number of PAN length is therefore usually refused whether or not its OWN check digit passes. That is
 * stated rather than smoothed over because it decides how the negative controls in {@link CARD_SHAPE_PROBES}
 * have to be written — a 13-digit run has exactly one window, so it is the length at which Luhn alone decides
 * — and because the alternative design is worse here. Checking only the whole run would make
 * `INV-0042<PAN>` and `<PAN>9` invisible, and those are precisely the shapes an accidental paste produces.
 */
export function cardShapedRuns(text: string): readonly string[] {
  const found = new Set<string>()
  for (const run of digitChains(text)) {
    if (run.length < PAN_MIN_DIGITS) continue
    const longest = Math.min(run.length, PAN_MAX_DIGITS)
    for (let length = PAN_MIN_DIGITS; length <= longest; length += 1) {
      for (let start = 0; start + length <= run.length; start += 1) {
        const candidate = run.slice(start, start + length)
        if (isLuhnValid(candidate)) found.add(candidate)
      }
    }
  }
  return [...found]
}

/**
 * The longest group of digits that may be joined to its neighbour across a separator.
 *
 * Six, because every published card format groups in fours except American Express's 4-6-5. A longer group is
 * not part of a human-written card number, and treating it as one is what made an all-digit uuid read as a
 * PAN — see {@link cardShapedRuns}. Mirrored in migration 0117's `is_card_shaped()`, and
 * `packages/fixtures/src/card-shape-agreement.itest.ts` holds the two equal over {@link CARD_SHAPE_PROBES}.
 */
export const MAX_GROUPED_DIGITS = 6

/**
 * Every run of digits, with groups joined across a single separator where both are short enough.
 *
 * Returned as the digits alone. A group too long to be card grouping is its own chain rather than being
 * dropped, because a bare unseparated PAN is exactly that: one group of sixteen.
 */
function digitChains(text: string): readonly string[] {
  const groups = [...text.matchAll(/\d+/g)].map((match) => ({
    digits: match[0],
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0,
  }))
  const chains: string[] = []
  let current = ''
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]
    if (group === undefined) continue
    if (current === '') current = group.digits
    const next = groups[index + 1]
    const separator = next === undefined ? '' : text.slice(group.end, next.start)
    const joins =
      next !== undefined &&
      (separator === ' ' || separator === '-') &&
      group.digits.length <= MAX_GROUPED_DIGITS &&
      next.digits.length <= MAX_GROUPED_DIGITS
    if (joins) current += next.digits
    else {
      chains.push(current)
      current = ''
    }
  }
  return chains
}

/** Does this text hold something shaped like a card number? */
export const containsCardNumber = (text: string): boolean => cardShapedRuns(text).length > 0

/** Where in a request body a refusal was found. Dotted, with array indices, so a 400 can name it. */
export type CardDataPath = string

export interface CardDataFinding {
  readonly path: CardDataPath
  /**
   * WHY it was refused, and never WHAT was refused.
   *
   * `card_shaped_value` is a Luhn-valid 13-19 digit run; `card_data_field_name` is a field this build's
   * contract has no room for. Two reasons rather than one because the remedies differ: the first is a value
   * in the wrong place, and the second is a request the checkout did not make.
   */
  readonly reason: 'card_shaped_value' | 'card_data_field_name'
}

/**
 * Raised when a request body carries card data, or a field named after it.
 *
 * `validation` rather than `forbidden`: the caller is entitled to make a request and this body is not one we
 * can read. The web boundary turns it into a 400 and creates nothing.
 *
 * The message names every path and no value, for the reason in this module's header.
 */
export class CardDataRefused extends AppError {
  readonly findings: readonly CardDataFinding[]
  constructor(where: string, findings: readonly CardDataFinding[]) {
    super(
      'validation',
      `CardDataRefused: ${where} carries card data and is refused without being read further. ` +
        `${findings.map((finding) => `${finding.path} (${finding.reason})`).join(', ')}. ` +
        "Card entry under SAQ-A happens entirely inside the gateway's cross-origin hosted fields, so no " +
        'request this build makes carries a card number, an expiry or a security code — only the opaque ' +
        'single-use token the gateway hands the browser. The offending values are deliberately absent from ' +
        'this message: a refusal that quoted them would put them in the log it was written to keep them out ' +
        'of. See ADR 0067.',
      { details: { where, findings: findings.map((finding) => ({ ...finding })) } },
    )
    this.name = 'CardDataRefused'
    this.findings = findings
  }
}

/**
 * Every place in a JSON-ish value that must not be there. Empty for a body this build can read.
 *
 * Numbers are inspected as well as strings, and that is not belt-and-braces: a 13-to-15-digit PAN is inside
 * `Number.MAX_SAFE_INTEGER`, so `{"pan": 4111111111111}` round-trips through `JSON.parse` as a number and a
 * string-only walk would pass it straight through. Keys are inspected before values, so a field named after
 * card data is refused even when its value is absent, null or empty — a form that HAS the field is the
 * defect, whatever this particular submission put in it.
 */
export function cardDataFindings(
  value: unknown,
  at: CardDataPath = '',
): readonly CardDataFinding[] {
  const here = at === '' ? '(body)' : at
  if (typeof value === 'string') {
    return containsCardNumber(value) ? [{ path: here, reason: 'card_shaped_value' }] : []
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) && containsCardNumber(String(value))
      ? [{ path: here, reason: 'card_shaped_value' }]
      : []
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => cardDataFindings(entry, `${at}[${index}]`))
  }
  if (typeof value === 'object' && value !== null) {
    const findings: CardDataFinding[] = []
    for (const [key, entry] of Object.entries(value)) {
      const path = at === '' ? key : `${at}.${key}`
      if (CARD_DATA_FIELD_NAMES.includes(normaliseFieldName(key))) {
        findings.push({ path, reason: 'card_data_field_name' })
        // Not descended into: the field is the defect and its value must not be walked, reported on, or
        // otherwise picked up and carried around by this function.
        continue
      }
      findings.push(...cardDataFindings(entry, path))
    }
    return findings
  }
  return []
}

/**
 * The payments request boundary. Called FIRST, before a body is read for anything else.
 *
 * `where` names the endpoint, so a 400 says which contract refused and a log says so too.
 */
export function assertNoCardData(value: unknown, where: string): void {
  const findings = cardDataFindings(value)
  if (findings.length > 0) throw new CardDataRefused(where, findings)
}

/**
 * The same value with every card-shaped run and every secret field's value replaced.
 *
 * For a SINK, never for a request: see this module's header on why the two paths differ. Keys are preserved
 * — a redactor that dropped them would hide the shape of what it redacted, and an operator reading an audit
 * row needs to know a field was present and unreadable rather than absent.
 *
 * A field named after card data is redacted here rather than refused, and its NAME is kept. The name is the
 * evidence: `{"cvv": "[redacted:secret-field]"}` on an audit row is a request somebody made that this build
 * has no field for, which is worth seeing.
 */
export function redactCardData(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (typeof value === 'number') {
    return Number.isInteger(value) && containsCardNumber(String(value)) ? CARD_DATA_REDACTED : value
  }
  if (Array.isArray(value)) return value.map((entry) => redactCardData(entry))
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      const name = normaliseFieldName(key)
      if (CARD_DATA_FIELD_NAMES.includes(name)) {
        out[key] = SECRET_FIELD_REDACTED
      } else if (SECRET_FIELD_NAMES.includes(name)) {
        out[key] = SECRET_FIELD_REDACTED
      } else {
        out[key] = redactCardData(entry)
      }
    }
    return out
  }
  return value
}

/** One string with every card-shaped run replaced. The sink-facing half for a log line or a message. */
export function redactText(text: string): string {
  let out = text
  for (const run of cardShapedRuns(text)) {
    out = out.replaceAll(run, CARD_DATA_REDACTED)
    // The separated spellings too, because `cardShapedRuns` joined them before matching and the ORIGINAL
    // text still holds the spaces or hyphens. Without this, `4111 1111 1111 1111` was detected and then not
    // replaced — the exact shape of bug that makes a redactor report success having changed nothing.
    for (const separator of [' ', '-']) {
      out = out.replaceAll(groupedSpellings(run, separator), CARD_DATA_REDACTED)
    }
  }
  return out
}

/**
 * A regular expression matching one digit run written with single separators anywhere inside it.
 *
 * Built from the run rather than from a general pattern so that only the digits actually found are replaced:
 * a general `/[\d -]{13,}/` would eat the space between two innocent numbers on either side of it.
 */
function groupedSpellings(run: string, separator: string): RegExp {
  const escaped = separator === '-' ? '\\-' : separator
  return new RegExp([...run].join(`[${escaped}]?`), 'g')
}

/**
 * A safe message for anything that leaves the payments path as text: an error, a summary, a log line.
 *
 * Takes `unknown` because the things that end up in a message are an `Error`, an `AppError`, a string and
 * occasionally a rejected value nobody typed. Everything becomes one redacted line.
 */
export function redactedMessage(error: unknown): string {
  if (typeof error === 'string') return redactText(error)
  if (error instanceof Error) return redactText(error.message)
  return redactText(String(error))
}

/**
 * The corpus that holds this module and migration 0117's `is_card_shaped()` equal.
 *
 * Stated ONCE, here, and driven through both implementations by
 * `packages/fixtures/src/card-shape-agreement.itest.ts`. Two copies of a corpus would be two corpora within
 * a month, and the direction the drift would take is the dangerous one: a database still accepting what the
 * request boundary had started refusing, so the refusal a test asserts arrives from the wrong layer.
 *
 * Every entry says why it is here. The `false` entries are the load-bearing half — a detector that refused
 * everything would satisfy every `true` case in this list and break every write in the build.
 */
export const CARD_SHAPE_PROBES: readonly {
  readonly text: string
  readonly cardShaped: boolean
  readonly why: string
}[] = Object.freeze([
  {
    text: '4111111111111111',
    cardShaped: true,
    why: 'the sixteen-digit Luhn-valid test number every payment library ships; the base case',
  },
  {
    text: '4111 1111 1111 1111',
    cardShaped: true,
    why: 'the same number as a human pastes it. A detector that misses this is satisfied by a typed form',
  },
  {
    text: '4111-1111-1111-1111',
    cardShaped: true,
    why: 'and as a hyphenated form value',
  },
  {
    text: 'INV-2026-0042 4111111111111111',
    cardShaped: true,
    why: 'a PAN appended to a reference, which is what an accidental paste into one field looks like',
  },
  {
    text: '3782 822463 10005',
    cardShaped: true,
    why:
      'the American Express test number in its own 4-6-5 grouping. The positive that keeps the ' +
      'six-digit bound on MAX_GROUPED_DIGITS honest: a bound of four would be enough for every other card ' +
      'format and would miss this one, and nothing else in the corpus would have said so',
  },
  {
    text: '4111111111112',
    cardShaped: false,
    why:
      'THIRTEEN digits and Luhn-invalid, which is the length at which Luhn alone decides: a 13-digit run ' +
      'holds exactly one window, so this is the clean proof that the check digit is load-bearing and that ' +
      'the rule is not "any long run of digits"',
  },
  {
    text: '1111111111111111',
    cardShaped: false,
    why:
      'sixteen ones: no 13-to-19-digit window inside it is Luhn-valid. MEASURED rather than assumed — ' +
      'two thirds of arbitrary 16-digit runs DO contain a valid window (see cardShapedRuns), so a negative ' +
      'control at this length has to be searched for rather than written by changing a check digit',
  },
  {
    text: '971559990132',
    cardShaped: false,
    why:
      'a UAE phone number in E.164 without the plus: twelve digits, below the floor. Audit payloads are ' +
      'full of these, and refusing one would refuse the build own traffic',
  },
  {
    text: '20000',
    cardShaped: false,
    why: 'a fils amount. Every payments payload carries several',
  },
  {
    text: '019a3f5c-0b2d-7c9e-8f01-2d3e4f5a6b7c',
    cardShaped: false,
    why: 'a uuid v7. Its longest digit run is twelve, which is why the floor is thirteen and not twelve',
  },
  {
    text: '00000000-0000-7000-8000-000000000000',
    cardShaped: false,
    why:
      'THE defect. A uuid whose hex is all digits: the first version of the detector deleted every ' +
      'separator between two digits, joined this into one 33-digit run, and refused it — so the payments ' +
      'endpoint answered 400 to a request whose only sin was a numeric intent id. Found by Y-PAY-02 own ' +
      'route suite asserting a 404 and getting a 400. The fix is that a digit group longer than six never ' +
      'joins, so the 8 and the 12 stand alone and the three fours reach twelve digits, one below the floor',
  },
  {
    text: '01932f45-1234-7890-8123-456789012345',
    cardShaped: false,
    why:
      'the same hazard with digits that are not all zeroes, so the case above cannot be passing because ' +
      'Luhn happens to like a run of zeroes. A uuid hex character is a digit five times in eight, so this ' +
      'shape is not rare: it is a measurable fraction of every id this system passes around',
  },
  {
    text: '2026-09-29T11:30:00.000Z',
    cardShaped: false,
    why: 'an instant. Separated digit groups that must not be joined across a non-separator',
  },
  {
    text: '123456789012345678901234',
    cardShaped: true,
    why:
      'a long digit run. Twenty-four digits contain many 13-to-19 windows and about one in ten is ' +
      'Luhn-valid, so a long number is usually refused. Deliberately the safe direction: this build has no ' +
      'legitimate twenty-four-digit number, and the window scan is what catches a PAN inside a longer string',
  },
  {
    text: '',
    cardShaped: false,
    why: 'the empty string. A detector that threw or reported true here would refuse every blank column',
  },
])
