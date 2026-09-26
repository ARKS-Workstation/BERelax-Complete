import { z } from 'zod'

/**
 * The WhatsApp ref code: its shape, and the two settings the ref loop is governed by.
 *
 * In `@berelax/shared` because three layers need the same answer to "is this a code at all" and none of
 * them may import the others: `@berelax/core` decides the capture OUTCOME from it, `@berelax/db` stores it
 * under a CHECK constraint spelled from the same pattern, and `apps/web`'s render puts it in the input's
 * `pattern` attribute so the browser refuses a malformed one before a round trip. Three copies of one
 * regular expression is three chances for the page to accept what the column then refuses.
 *
 * ## Why four characters, and why these characters
 *
 * Four because the code is read aloud across a counter or copied off a phone screen, and because it is a
 * booking-side join key rather than a secret: it identifies a conversation the customer is already in, and
 * guessing one attributes a booking to somebody else's conversation rather than disclosing anything. (It
 * does mean the code space is small — 32^4 — which is why `whatsapp_ref.ref_code` is a primary key and a
 * code is never reissued: A-FIRST cannot hand the same four characters to two conversations.)
 *
 * The alphabet deliberately omits **I, O, 0 and 1**. Those are the four characters a person reading a code
 * off a screen confuses, and the confusion is not recoverable later: a booking attributed to the wrong
 * conversation is indistinguishable from one attributed to the right one.
 *
 * And {@link normaliseWhatsappRefCode} does **not** fold `0` onto `O` or `1` onto `I`, which is the
 * obvious next step and is wrong. Folding is a guess about what the operator meant, and the thing being
 * guessed at is an attribution: a fold that lands on a real code produces a confident, wrong join, where
 * refusing to fold produces `unknown_code` — a visible warning, the booking taken, and the attribution
 * honestly unknown (Y9-crm-source's argument for `unknown` being the default). Case IS folded, because
 * upper and lower case are the same character and no alphabet here contains both.
 */

/** How many characters a code has. One number, so the pattern and the CHECK cannot disagree. */
export const WHATSAPP_REF_CODE_LENGTH = 4

/**
 * The characters a code may contain: A-Z and 2-9, less I, O, 0 and 1.
 *
 * Spelled as a string rather than derived from ranges, so the exclusions are visible to a reader instead
 * of being an arithmetic consequence they have to work out.
 */
export const WHATSAPP_REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * The character-class body, shared by the JavaScript pattern, the HTML `pattern` attribute and the SQL
 * CHECK. `A-HJ-NP-Z2-9` is {@link WHATSAPP_REF_ALPHABET} as ranges; `whatsapp-ref.test.ts` asserts the two
 * describe the same set, which is the only way a hand-written range set stays true to the alphabet.
 */
export const WHATSAPP_REF_CODE_CLASS = 'A-HJ-NP-Z2-9'

/**
 * The canonical rule as a `RegExp`. Anchored at both ends: a code is the whole value, never a substring.
 *
 * This is the STORED form — what `whatsapp_ref.ref_code`'s CHECK constraint allows and what
 * {@link normaliseWhatsappRefCode} answers. Upper case only, because a code stored in two cases is a code
 * that does not join to itself.
 */
export const WHATSAPP_REF_CODE_PATTERN = new RegExp(
  `^[${WHATSAPP_REF_CODE_CLASS}]{${WHATSAPP_REF_CODE_LENGTH}}$`,
)

/**
 * The character class a FIELD may accept, which is the canonical one plus its lower case.
 *
 * Deliberately wider than {@link WHATSAPP_REF_CODE_CLASS}, and the difference is a defect this unit shipped
 * and then found in a browser. An HTML `pattern` is CASE SENSITIVE, so the canonical class refused `qb34` —
 * and a code pasted off a phone arrives in whatever case the phone had it. The browser then blocked the
 * submit with its own validation bubble, no request was made, and the failure presented as a check that
 * produced neither an assignment nor a refusal: a page that silently did nothing.
 *
 * Accepting both cases is safe because the server folds case before it compares: the field accepts exactly
 * what {@link normaliseWhatsappRefCode} can turn into a canonical code, which `whatsapp-ref.test.ts` asserts
 * as a property over the whole class rather than as a pair of examples. Widening it any further would be a
 * field that accepts what the column then refuses.
 */
export const WHATSAPP_REF_INPUT_CLASS = 'A-HJ-NP-Za-hj-np-z2-9'

/**
 * The whole pattern for the HTML `pattern` attribute (no delimiters, no anchors — the browser anchors it).
 *
 * Built from {@link WHATSAPP_REF_INPUT_CLASS} and NOT from the canonical class. See that constant for why.
 */
export const WHATSAPP_REF_CODE_HTML_PATTERN = `[${WHATSAPP_REF_INPUT_CLASS}]{${WHATSAPP_REF_CODE_LENGTH}}`

/**
 * A raw field value as a code, or `null` when it is not one.
 *
 * `null` for blank as well as for malformed, because the two are different states to the page and the same
 * state to everything below it: neither is a code, and only the page has to tell "the desk left it empty"
 * from "the desk typed something that cannot be a code". `decideRefCapture` in `@berelax/core` is where
 * that distinction is made, from the raw value and this answer together.
 */
export function normaliseWhatsappRefCode(raw: string): string | null {
  const upper = raw.trim().toUpperCase()
  return WHATSAPP_REF_CODE_PATTERN.test(upper) ? upper : null
}

/** True when the value is a code, after trimming and case folding. */
export function isWhatsappRefCode(raw: string): boolean {
  return normaliseWhatsappRefCode(raw) !== null
}

export const whatsappRefCodeSchema = z.string().regex(WHATSAPP_REF_CODE_PATTERN)

/**
 * `booking.front_desk_min_lead_minutes` — the notice the DESK needs, as distinct from the notice an
 * online booking needs.
 *
 * Provisional against **Y9-lead**, whose question is "minimum **online** booking lead time" in so many
 * words, and whose provisional value of 120 minutes is `booking.min_lead_minutes`. Applying that figure at
 * the counter would make this screen unable to do the one thing it exists for — a walk-in standing at the
 * desk cannot be booked in two hours' time — so the desk figure is a setting of its own rather than a
 * reuse of one whose question was about a different channel.
 *
 * Zero is the provisional value, and the argument that it is the *safe* direction rather than the
 * convenient one is this: the availability engine still refuses a start with no free therapist and no free
 * room, so a zero desk lead cannot produce a booking the salon cannot deliver — only an imminent one,
 * which is a person at the counter the desk can decline. The other direction is not symmetrical: a
 * two-hour desk lead cannot be discovered by a test that asserts "some slot is offered", because a slot
 * two hours out is a slot.
 *
 * It is a SETTING and not a constant precisely because it is unconfirmed: the answer to Y9-lead reaches
 * it without a deploy, in either direction, and the Unconfirmed Assumptions panel lists it until somebody
 * answers.
 */
export const FRONT_DESK_MIN_LEAD_SETTING_KEY = 'booking.front_desk_min_lead_minutes'
/** Zero minutes. See {@link FRONT_DESK_MIN_LEAD_SETTING_KEY} for why zero is the strict reading here. */
export const PROVISIONAL_FRONT_DESK_MIN_LEAD_MINUTES = 0

/**
 * `booking.whatsapp_ref_expected` — whether the front desk is expected to paste the ref code at all.
 *
 * This is **Y12-ref-loop** as a value the code reads, and `false` is the provisional answer because
 * nobody has said the desk will do it. What it controls is one thing and it is not the field: the field is
 * present and prominent either way. It controls what a capture RATE is allowed to claim. At `false`, a 0%
 * rate is reported as *the ref loop is unconfirmed* rather than as *the desk is failing to capture*, and
 * the funnel reports the gap instead of inventing the join; at `true`, the same 0% is a process failure
 * somebody should be told about.
 *
 * A knob nothing consults would be a lie about what is configurable (the brief's warning), so the one
 * consumer is named here: `refCaptureRate` in `@berelax/core` takes it as an argument and returns a
 * different `claim`.
 */
export const WHATSAPP_REF_EXPECTED_SETTING_KEY = 'booking.whatsapp_ref_expected'
/** False. Nobody has said the desk will paste the code — that is the whole of Y12-ref-loop. */
export const PROVISIONAL_WHATSAPP_REF_EXPECTED = false

/** The OPEN-QUESTIONS row the whole ref loop is tracked under. Cited on the screen and in the panel. */
export const WHATSAPP_REF_OPEN_QUESTION = 'Y12-ref-loop'
