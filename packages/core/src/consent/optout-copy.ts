/**
 * The words no template of this business may contain, because the mechanism they name does not exist.
 *
 * ## Why this is a rule and not a style preference
 *
 * Every SMS this business sends leaves from a TDRA-registered ALPHANUMERIC sender ID, which reads `BERELAX`
 * and **cannot receive an inbound message** (docs/04 §5). There is no number for a reply to arrive at. So a
 * body reading "Reply STOP to unsubscribe" does not merely fail to work: it tells somebody who wants the
 * messages to stop that they have a way to stop them, sends them into a void, and leaves this business able
 * to say it offered an opt-out while having offered none. The link to the preference centre is the only
 * functional opt-out there is, which is the whole reason C-CRM-04 built the token service and C-CRM-07 built
 * the page.
 *
 * The failure mode is what makes it worth a check rather than a comment. Nothing raises. The message sends,
 * one segment, correctly rendered, through an approved template — and the only evidence that anything is
 * wrong is a complaint from somebody who tried to stop and could not, arriving weeks later at a regulator
 * rather than at us.
 *
 * ## Why the phrases and not a word
 *
 * "STOP" alone appears in ordinary copy — a stop, a bus stop, `non-stop` — and a check that fired on it
 * would be turned off. These two are the shapes the instruction actually takes, and they are matched
 * case-insensitively because "reply stop" is the same promise in lower case. Latin, and matched in EVERY
 * locale's body, because an SMS keyword is Latin even inside an Arabic sentence: the Arabic templates are
 * exactly where somebody would copy the convention in from another market without anybody reading it.
 */

/** The instructions a template may not carry. Matched case-insensitively; see the header. */
export const UNREACHABLE_OPT_OUT_PHRASES = ['Reply STOP', 'STOP to'] as const
export type UnreachableOptOutPhrase = (typeof UNREACHABLE_OPT_OUT_PHRASES)[number]

/**
 * Which forbidden instructions a piece of copy contains, in declaration order. Empty is the only pass.
 *
 * Returns the phrases rather than a boolean so a failure message can print what was found and where the
 * caller can say which template it was in — a scan over a corpus that answered `false` would name the
 * corpus and not the row.
 */
export function unreachableOptOutPhrasesIn(text: string): readonly UnreachableOptOutPhrase[] {
  const haystack = text.toLowerCase()
  return UNREACHABLE_OPT_OUT_PHRASES.filter((phrase) => haystack.includes(phrase.toLowerCase()))
}
