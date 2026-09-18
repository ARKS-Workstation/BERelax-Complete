/**
 * Masking a recipient for a screen.
 *
 * The admin Messages inbox is screenshotted — the gallery is published as a link somebody opens on a
 * phone (H04), and every fake's call log already masks for the same reason. A full mobile number and a
 * full email address are personal data, and a screenshot is the one artefact that leaves the system
 * with no access control on it at all.
 *
 * Pure, and in `core` rather than in the route, because two surfaces mask: the inbox renders it and the
 * provider call log formats its own summaries. Two maskings of one value is the version where one of
 * them keeps the last six digits.
 *
 * The rule is "enough to recognise, not enough to reach": the last four digits of a phone number,
 * because that is what the front desk reads back to a customer, and the first character plus the domain
 * of an address, because the domain is what tells an operator whether a bounce is one mailbox or a whole
 * company.
 */

/** Last four digits only, with the rest replaced rather than dropped. */
export function maskPhone(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length <= 4) return trimmed
  return `…${trimmed.slice(-4)}`
}

/** First character of the local part, plus the domain. */
export function maskEmail(value: string): string {
  const trimmed = value.trim()
  const at = trimmed.lastIndexOf('@')
  if (at <= 0) return maskPhone(trimmed)
  return `${trimmed.slice(0, 1)}***${trimmed.slice(at)}`
}

/**
 * Masks a recipient the way its channel needs.
 *
 * Dispatched on the channel rather than on whether the string contains an `@`, because a sniffed shape
 * is a guess that gets the one case wrong that matters: a malformed recipient. `'sms'` and
 * `'whatsapp'` are numbers, `'email'` is an address, and an unknown channel is masked as a number —
 * the stricter of the two, since it keeps four characters rather than a domain.
 */
export function maskRecipient(channel: string, value: string): string {
  return channel === 'email' ? maskEmail(value) : maskPhone(value)
}
