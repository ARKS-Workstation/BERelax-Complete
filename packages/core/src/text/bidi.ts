/**
 * Bidirectional text isolation (UAX #9).
 *
 * Every Arabic string this system emits — an invoice line, an SMS reminder, a booking
 * confirmation — carries Latin runs inside it: a reference like `INV-2026-000123`, a price like
 * `AED 350.00`, a phone number like `+971 2 555 0199`. Latin numerals are deliberate; see
 * `formatMoney` and docs/08 §7.
 *
 * The Unicode Bidirectional Algorithm resolves such a run against the *paragraph* direction, not
 * against the run. Inside a right-to-left paragraph a leading `+` is a neutral that lands to the
 * right of the digits, so `+971 2 555 0199` is displayed as `971 2 555 0199+` — a phone number the
 * customer cannot dial. Wrapping the run in an isolate gives it its own paragraph-like scope, so it
 * is laid out left-to-right internally and placed as one opaque unit inside the Arabic line.
 *
 * The second half of this module is a security boundary rather than a typographic one. The
 * *override* and *embedding* controls (U+202A–U+202E) are unbalanced by design: a single U+202E in
 * a customer's name reorders every character after it, which is enough to make an invoice display a
 * different amount from the one stored. Untrusted text is stripped, never trusted to be balanced.
 *
 * Pure: no I/O, no clock. Used by the PDF renderer, by outbound messaging, and by the web layer.
 */

/** LEFT-TO-RIGHT ISOLATE (U+2066). Opens a scope laid out left-to-right. */
export const LRI = '\u2066'
/** RIGHT-TO-LEFT ISOLATE (U+2067). */
export const RLI = '\u2067'
/** FIRST STRONG ISOLATE (U+2068) — direction taken from the first strong character inside. */
export const FSI = '\u2068'
/** POP DIRECTIONAL ISOLATE (U+2069). Closes the nearest open isolate. */
export const PDI = '\u2069'

/** LEFT-TO-RIGHT MARK (U+200E); a zero-width strong LTR character. */
export const LRM = '\u200e'
/** RIGHT-TO-LEFT MARK (U+200F). */
export const RLM = '\u200f'

/**
 * Embedding and override controls, U+202A to U+202E.
 *
 * These are the dangerous ones: unlike isolates they leak past their intended scope when
 * unbalanced, and an override reorders characters that have no business being reordered.
 */
const OVERRIDES_AND_EMBEDDINGS = ['\u202a', '\u202b', '\u202c', '\u202d', '\u202e'] as const

const ISOLATES = [LRI, RLI, FSI, PDI] as const

/** Every bidi format control, isolates included. */
export const BIDI_CONTROLS: readonly string[] = [...ISOLATES, ...OVERRIDES_AND_EMBEDDINGS, LRM, RLM]

const CONTROL_PATTERN = /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g
const UNSAFE_CONTROL_PATTERN = /[\u202a-\u202e]/

/**
 * Strong right-to-left characters: Hebrew, Arabic, Syriac, Thaana, N'Ko, and the Arabic
 * presentation forms. Any of these makes a string's paragraph direction RTL under UAX #9 rule P2.
 */
const STRONG_RTL_PATTERN =
  /[\u0590-\u05ff\u0600-\u07bf\u0860-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]|[\u{10e60}-\u{10e7e}]/u

/**
 * A run that reads left-to-right: Latin letters, digits, and the neutrals that bind them.
 *
 * An interior space is part of the run only when an alphanumeric follows it, so `AED 350.00` and
 * `+971 2 555 0199` each stay whole while the space separating a run from an Arabic word is not
 * swallowed. A leading `+` or `#` belongs to the run it introduces — the `+` of a dialling code is
 * precisely the character UAX #9 would otherwise strand on the wrong side.
 */
const LATIN_RUN_PATTERN =
  /[+#]?[A-Za-z0-9](?:[A-Za-z0-9.,:;/@#()%+'"-]|[ \u00a0](?=[A-Za-z0-9+#]))*/gu

/** Punctuation a greedy match may have taken from the sentence rather than from the run. */
const TRAILING_NEUTRALS = /['"@#+.,:;/-]+$/

interface Run {
  /** The part that must stay in left-to-right order. */
  readonly core: string
  /** Sentence punctuation that trailed it, which belongs outside the isolate. */
  readonly tail: string
}

function splitRun(run: string): Run {
  const match = TRAILING_NEUTRALS.exec(run)
  if (match === null) return { core: run, tail: '' }
  return { core: run.slice(0, match.index), tail: match[0] }
}

/** True when the string contains a character that forces right-to-left paragraph direction. */
export function hasStrongRtl(text: string): boolean {
  return STRONG_RTL_PATTERN.test(text)
}

function wrap(open: string, text: string, close = PDI): string {
  // Already isolated by exactly this pair — wrapping again would nest pointlessly and make the
  // string harder to compare in tests and logs.
  if (text.startsWith(open) && text.endsWith(close)) return text
  return `${open}${text}${close}`
}

/**
 * Isolates a left-to-right run for safe embedding in right-to-left text.
 *
 * Use it for references, amounts, phone numbers, times, URLs and email addresses inside an Arabic
 * sentence. The returned string is longer by two characters that render as nothing.
 */
export function isolateLtr(text: string): string {
  return wrap(LRI, text)
}

/** Isolates a right-to-left run for safe embedding in left-to-right text. */
export function isolateRtl(text: string): string {
  return wrap(RLI, text)
}

/**
 * Isolates a run whose direction is not known at call time — a customer name, a therapist name, a
 * free-text note. The renderer takes the direction from the first strong character inside.
 */
export function isolateAuto(text: string): string {
  return wrap(FSI, text)
}

/**
 * Removes every bidi format control.
 *
 * Apply to all untrusted text before interpolating it into a document, a message or a filename.
 * Stripping is the only safe treatment: an unbalanced override cannot be repaired without guessing
 * what the author meant, and guessing is what the attack relies on.
 */
export function stripBidiControls(text: string): string {
  return text.replace(CONTROL_PATTERN, '')
}

/** True when the text carries an override or embedding control, which untrusted text never should. */
export function hasUnsafeBidiControls(text: string): boolean {
  return UNSAFE_CONTROL_PATTERN.test(text)
}

/**
 * True when a string mixes right-to-left text with a Latin run and has not been isolated.
 *
 * This is the predicate a template check uses: an Arabic message body containing `AED 350.00` with
 * no isolate in sight is a display bug waiting to reach a customer's handset.
 */
export function needsIsolation(text: string): boolean {
  if (!hasStrongRtl(text)) return false
  const latin = text.match(LATIN_RUN_PATTERN)
  if (latin === null) return false
  // A single alphanumeric character cannot be reordered relative to itself.
  if (!latin.some((run) => splitRun(run).core.length > 1)) return false
  return !ISOLATES.some((control) => text.includes(control))
}

/**
 * Isolates every Latin run in a right-to-left string.
 *
 * A convenience for text assembled outside the template system — imported message copy, an
 * operator-typed note. Prefer isolating at the interpolation site, where the run's role is known.
 */
export function isolateLatinRuns(text: string): string {
  if (!hasStrongRtl(text)) return text
  return text.replace(LATIN_RUN_PATTERN, (match) => {
    const { core, tail } = splitRun(match)
    return core.length > 1 ? `${isolateLtr(core)}${tail}` : match
  })
}
