/**
 * The add-to-calendar file, and the discretion rule built into the function that writes it.
 *
 * docs/06 D2: *"An SMS preview reading 'Reminder: your Deep Tissue massage with Maria tomorrow at 3pm' is
 * visible to anyone holding the client's phone. **Do:** discreet message templates by default, with the
 * detail behind a link. **Same logic for calendar invite titles**"*. A calendar entry is worse than an SMS
 * in one respect that is easy to miss: it persists. A message scrolls away; an event sits in a shared
 * family calendar, on a work laptop's notification, and in whatever the phone syncs to, with its SUMMARY
 * as the visible line — for as long as the customer keeps it.
 *
 * `packages/messaging` states the rule for message bodies as a list of variables no transactional template
 * may declare, and asserts it over the corpus. That list cannot be reused here: `core` may not import
 * `messaging` (`core-must-not-import-infrastructure`), and a second copy of the *words* would drift. So
 * the rule is expressed the other way round and more strongly — as a **property of the produced file**.
 * {@link buildAppointmentIcs} is given the values it must not emit and returns a refusal naming them if it
 * finds one anywhere in the output, so the discretion rule is enforced by the code that writes the file
 * rather than by a reviewer noticing that a caller passed the wrong string. A test that only checked the
 * SUMMARY would pass on a DESCRIPTION carrying the therapist's name, which syncs to the same places.
 *
 * ## Why this is in `core` and not beside the route
 *
 * It is a pure function of its inputs — every instant is an argument, `DTSTAMP` included — so it is
 * checkable without a server, a browser or a database, which is where an escaping rule and a folding rule
 * belong. RFC 5545's TEXT escaping and its 75-octet line folding are both the kind of thing that is
 * subtly wrong for a year: an unescaped comma in a location truncates the value at the comma in some
 * clients and is accepted in others, so the failure is "the event looks right in my calendar".
 */

/** The result of writing a calendar file: the bytes, or the values that could not be withheld. */
export type IcsResult =
  | { readonly ok: true; readonly ics: string }
  | {
      readonly ok: false
      /** The withheld values that appeared in the output, in the order they were declared. */
      readonly leaked: readonly string[]
    }

export interface IcsAppointment {
  /**
   * The event's globally unique id. The booking or appointment id, never a generated one.
   *
   * RFC 5545 uses UID to decide whether an imported file is a NEW event or an update to one already in
   * the calendar. A fresh id on every download means a customer who taps add-to-calendar twice has two
   * appointments in their diary — which then both fire a reminder, and one of them is for a booking that
   * was rescheduled.
   */
  readonly uid: string
  /** When this file was produced. An argument, because core reads no clock. */
  readonly dtstampAt: number
  readonly startsAt: number
  readonly endsAt: number
  /**
   * The visible line. Discreet by construction: see the module header.
   *
   * The caller supplies it because the words are the locale's, and {@link buildAppointmentIcs} checks it
   * against {@link withhold} rather than trusting it.
   */
  readonly summary: string
  /** The body. Same check applies: it syncs to the same places the summary does. */
  readonly description: string
  /** The premises, from the premises row. Never a literal. */
  readonly location: string
  /** Where the customer manages the booking, or null when there is nowhere to send them yet. */
  readonly url: string | null
  /**
   * The values this file must not contain: the treatment's public name, its style, the therapist's label.
   *
   * Supplied by the caller because only the caller knows them, and required rather than optional: an
   * optional list defaults to empty, and an empty list makes every assertion about discretion pass. A
   * caller with genuinely nothing to withhold passes an empty array and says so at the call site.
   */
  readonly withhold: readonly string[]
}

/** The product identifier. One constant, so two callers cannot produce two dialects of the same file. */
export const ICS_PRODUCT_ID = '-//BE RELAX//booking//EN'

/** `YYYYMMDDTHHMMSSZ`, which is RFC 5545's UTC form. */
export function icsInstant(epochMs: number): string {
  // `toISOString` and not `Intl`: this is a wire format in UTC, not a wall clock for a reader, and the
  // premises' zone is deliberately absent. A floating local time would be read by a calendar in the
  // device's own zone, so a booking made in Dubai and opened on a laptop still set to London would
  // appear four hours out — the one failure mode of a calendar file that nobody reports as a bug.
  return `${new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')}`
}

/**
 * RFC 5545 §3.3.11 TEXT escaping.
 *
 * Backslash first, or the escapes inserted for the other three would themselves be escaped. The order is
 * the whole of the correctness here, and getting it wrong produces a file that imports without complaint
 * and shows `Dubai\, UAE`.
 */
export function escapeIcsText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\r\n', '\\n')
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\n')
}

/**
 * RFC 5545 §3.1 content-line folding: 75 **octets**, continued with CRLF and one space.
 *
 * Octets and not characters, which is why this counts encoded length rather than `string.length`. An
 * Arabic description is two or three bytes per character in UTF-8, so a limit applied to characters folds
 * at over 200 bytes — and a client that enforces the limit truncates the line. Counting the other way
 * round (bytes, folding mid-character) would split a multi-byte sequence and produce mojibake, so the walk
 * below is per code point and stops before the limit rather than at it.
 */
export function foldIcsLine(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line
  const folded: string[] = []
  let current = ''
  let octets = 0
  // The continuation limit is one lower, because the leading space counts toward the 75.
  let limit = 75
  for (const codePoint of line) {
    const size = encoder.encode(codePoint).length
    if (octets + size > limit) {
      folded.push(current)
      current = ''
      octets = 1
      limit = 74
    }
    current += codePoint
    octets += size
  }
  folded.push(current)
  return folded.join('\r\n ')
}

/**
 * The values that appear in a produced file, in declaration order.
 *
 * Case-insensitive and over the WHOLE file rather than over the SUMMARY: a therapist's name in the
 * description reaches the same lock screen. Blank entries are ignored, because a caller with no published
 * therapist name has `null` for it and turning that into `''` would report every file as leaking.
 */
export function icsDiscretionBreaches(ics: string, withhold: readonly string[]): readonly string[] {
  const haystack = ics.toLowerCase()
  return withhold.filter((value) => {
    const needle = value.trim().toLowerCase()
    return needle !== '' && haystack.includes(needle)
  })
}

/**
 * One appointment as an iCalendar file, or a refusal naming what could not be withheld.
 *
 * A refusal rather than a throw, and rather than a silently redacted file. The caller is a confirmation
 * page: a throw there is a 500 on the one screen a customer has just paid attention to, and a redaction
 * would hide a defect in the copy behind a file that looked fine. A named refusal lets the page render
 * everything else and say that the calendar file is unavailable — which is visible, and fixable.
 *
 * `METHOD:PUBLISH` and no `ORGANIZER`, which together are what make this a file the customer adds to
 * their own calendar rather than an invitation from the salon. An invitation would put the premises'
 * mailbox in the customer's diary and invite a reply nobody reads.
 */
export function buildAppointmentIcs(appointment: IcsAppointment): IcsResult {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${ICS_PRODUCT_ID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${appointment.uid}`,
    `DTSTAMP:${icsInstant(appointment.dtstampAt)}`,
    `DTSTART:${icsInstant(appointment.startsAt)}`,
    `DTEND:${icsInstant(appointment.endsAt)}`,
    `SUMMARY:${escapeIcsText(appointment.summary)}`,
    `DESCRIPTION:${escapeIcsText(appointment.description)}`,
    `LOCATION:${escapeIcsText(appointment.location)}`,
    // `OPAQUE`: the time is busy. `TRANSPARENT` would let a calendar schedule a meeting over it, which is
    // the opposite of what somebody adding a spa appointment to their diary is asking for.
    'TRANSP:OPAQUE',
  ]
  if (appointment.url !== null) lines.push(`URL:${escapeIcsText(appointment.url)}`)
  lines.push('END:VEVENT', 'END:VCALENDAR')

  // CRLF, which RFC 5545 requires. A file with bare newlines is accepted by several clients and rejected
  // by others, so the failure is one customer in five reporting that the button does nothing.
  const ics = `${lines.map(foldIcsLine).join('\r\n')}\r\n`

  // Checked on the OUTPUT, after escaping and folding, because that is the only string that can leak. A
  // check on the inputs would pass a summary assembled from two fields neither of which contained the
  // name on its own.
  const leaked = icsDiscretionBreaches(ics, appointment.withhold)
  return leaked.length > 0 ? { ok: false, leaked } : { ok: true, ics }
}
