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
 * does mean the code space is small — 30^4 — which is why `whatsapp_ref.ref_code` is a primary key and a
 * code is never reissued: A-FIRST cannot hand the same four characters to two conversations.)
 *
 * The alphabet deliberately omits **I, L, O, U, 0 and 1**, and the six are omitted for two different
 * reasons that are worth keeping apart.
 *
 * **I, O, 0 and 1** are the pairs a person confuses reading a code off a screen, and B-UI-04 excluded them
 * because the confusion is not recoverable later: a booking attributed to the wrong conversation is
 * indistinguishable from one attributed to the right one.
 *
 * **U went because of that argument taken one step further, and A-FIRST-07 is where it was taken.** With
 * I, O, 0 and 1 already out, a misread of `L` as `1` or `I` produces a value that is not a code at all, so
 * it resolves to `unknown_code` — a visible warning and an honestly unknown attribution. `U` misread as
 * `V` is the only remaining pair where the wrong character is ITSELF in the alphabet, so the misread
 * produces a different VALID code: the one case left that can still attribute a booking to somebody else's
 * conversation. `L` goes with it because it is the other half of the same convention (this is Crockford's
 * base32 exclusion set) and because an attempt wasted on `L`/`1` is an attempt the customer does not get
 * back, even though it cannot misattribute.
 *
 * The cost is the code space: 810,000 rather than 1,048,576. That is orders of magnitude more codes than
 * this business will issue, and `issueWhatsappRef` redraws on a collision.
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
 * The characters a code may contain: A-Z and 2-9, less I, L, O, U, 0 and 1.
 *
 * Spelled as a string rather than derived from ranges, so the exclusions are visible to a reader instead
 * of being an arithmetic consequence they have to work out.
 */
export const WHATSAPP_REF_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'

/**
 * The character-class body, shared by the JavaScript pattern, the HTML `pattern` attribute and the SQL
 * CHECK. `A-HJKM-NP-TV-Z2-9` is {@link WHATSAPP_REF_ALPHABET} as ranges; `whatsapp-ref.test.ts` asserts the two
 * describe the same set, which is the only way a hand-written range set stays true to the alphabet.
 */
export const WHATSAPP_REF_CODE_CLASS = 'A-HJKM-NP-TV-Z2-9'

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
export const WHATSAPP_REF_INPUT_CLASS = 'A-HJKM-NP-TV-Za-hjkm-np-tv-z2-9'

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

/**
 * `booking.whatsapp_ref_ttl_days` — how long a code stays claimable.
 *
 * **Y12-ref-ttl**, and seven days is the provisional answer. It is a setting and not a constant for the
 * reason {@link WHATSAPP_REF_EXPECTED_SETTING_KEY} is one: nobody has measured how long a WhatsApp
 * conversation takes to become a booking, and the answer reaches the code without a deploy in either
 * direction.
 *
 * ## Why seven days rather than "no expiry", which is the simpler option
 *
 * A code with no expiry is a join key for ever. The four characters sit in the customer's chat history,
 * and a year later the desk can still type them in and attribute a booking to a conversation nobody
 * remembers — against an analytics session that the 90-day retention purge removed months earlier. So the
 * question is not whether to expire but what the window is, and seven days is the direction that fails
 * SAFELY: an expiry that is too short records `ref_expired`, which keeps the code, takes the booking and
 * shows up as a visible count somebody can act on, where an expiry that is too long produces confident
 * attributions nobody can check.
 *
 * The figure is read ONCE, at issue, and stamped on the row as `whatsapp_ref.expires_at`. Answering this
 * question therefore governs codes issued afterwards and never rewrites the recorded outcome of a booking
 * already taken — see migration 0127's header.
 */
export const WHATSAPP_REF_TTL_SETTING_KEY = 'booking.whatsapp_ref_ttl_days'
/** Seven days. See {@link WHATSAPP_REF_TTL_SETTING_KEY} for why an expiry exists at all. */
export const PROVISIONAL_WHATSAPP_REF_TTL_DAYS = 7
/** The OPEN-QUESTIONS row the lifetime is tracked under, distinct from the loop's own. */
export const WHATSAPP_REF_TTL_OPEN_QUESTION = 'Y12-ref-ttl'

/**
 * The first line of the prefilled WhatsApp message: `Ref: <code>`.
 *
 * One spelling, in the package all three sides may import, because the loop is a round trip through a
 * channel this system cannot read: the customer sees this line, pastes or reads out what follows the
 * colon, and the desk types it into a field validated by {@link WHATSAPP_REF_CODE_PATTERN}. A second
 * spelling of the prefix on either side would produce a message whose code the desk cannot find.
 */
export const WHATSAPP_REF_MESSAGE_PREFIX = 'Ref: '

/**
 * The prefilled message body, with the ref line first.
 *
 * The ref line is FIRST and not last, and that is the only ordering that works: WhatsApp shows the
 * beginning of a prefilled message in the compose box, a customer who edits before sending edits the end,
 * and a code below three lines of greeting is a code that gets deleted.
 *
 * `body` is optional and empty by default, which is a deliberate refusal rather than an unfinished
 * feature. Any greeting is customer-facing copy, it would have to exist in both locales (W-SITE owns the
 * public copy and the Arabic of it), and a prefilled sentence the customer has to delete before typing
 * their actual question is worse than no sentence. The parameter exists so that adding the copy later is a
 * call site rather than a change to the composer.
 */
export function whatsappRefMessage(refCode: string, body = ''): string {
  const ref = `${WHATSAPP_REF_MESSAGE_PREFIX}${refCode}`
  return body.trim() === '' ? ref : `${ref}\n${body.trim()}`
}
