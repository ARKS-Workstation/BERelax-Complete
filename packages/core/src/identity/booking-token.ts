import { CONTRAINDICATION_FLAG_KEYS } from '@berelax/shared'
import { digestsEqual } from '../consent/optout-token.ts'
import { type Instant, instantToIso } from '../time.ts'

/**
 * The manage-booking token's pure half (B-UI-05): what a token looks like, when it dies, and what a
 * presented one grants.
 *
 * ## It is a stored grant, and the shape is not a third one
 *
 * `booking_session` (0062) holds the SHA-256 of 32 CSPRNG bytes and no column holds the token;
 * `optout_grant` (0064) does the same with an expiry on the row and revocation by DELETE. This is the
 * third table of that shape and it invents nothing: 32 bytes from a CSPRNG, only the digest stored,
 * expiry on the row, revocation by DELETE. The three reasons M-VAT-11 recorded for a stored grant over a
 * signature hold here too — no eighth signing secret to rotate at 02:00, revocation is a DELETE rather
 * than a key rotation that breaks every other link, and the row records that the link existed.
 *
 * Nothing here mints a token: 32 bytes from a CSPRNG is `randomBytes`, and `packages/core` reads no
 * ambient source of anything. Minting is `packages/db/src/repositories/booking-token.ts`'s, beside the
 * row it writes.
 *
 * ## Why the token is lower-case hex and NOT base64url
 *
 * `optout_grant`'s token is base64url, 43 characters, and copying that here would produce links that
 * break in a way nothing would attribute to the encoding. The difference is where the token sits: the
 * opt-out token is a QUERY parameter, and this one is a PATH SEGMENT — `/booking/<token>` (docs/09 §1).
 *
 * `apps/web/src/routes/canonical.ts` lower-cases the whole path and 301s to the result, because a page is
 * one URL however it is spelled. A mixed-case token in a path segment is therefore destroyed by the
 * site's own canonicalisation: the reader follows a perfectly ordinary permanent redirect and lands on a
 * token that no longer matches the digest, which is indistinguishable from a forged link — and it would
 * fail for every customer, every time, with a 404 whose cause is two modules away.
 *
 * Lower-case hex is invariant under that lower-casing. It is 64 characters where base64url is 43, and
 * that is 21 characters of SMS the shortening would have bought (`booking.reminder` is one segment with
 * a short link and more with a long one) — a real cost, paid deliberately, because a link that works is
 * worth more than a link that is cheap. A shortener is the answer to the length and it is nobody's unit
 * yet: `packages/messaging/src/template-corpus.test.ts` renders the corpus against `brlx.ae/b/AbCdEf`,
 * which is what that answer will look like.
 *
 * ## Every refusal answers the same thing
 *
 * {@link BOOKING_TOKEN_NOT_FOUND} is one frozen object and there is deliberately no way to return a
 * different body for a different reason. An expired token, a revoked one, a mistyped one and a forged one
 * are all one response — the acceptance criterion's "a response body identical to a genuinely unknown
 * token", and the reason is the same oracle argument `OPT_OUT_NOT_FOUND` makes: a caller who can tell
 * "expired" from "never existed" can test whether a given booking was ever reminded about. The named
 * reasons below are for the SERVER's log and for the `audit_event` row.
 */

/**
 * How many random bytes a token carries, and what that is in lower-case hex.
 *
 * 32 bytes is 256 bits, so the token is not guessable and there is no rate limit beside it pretending to
 * be what makes it safe. Hex rather than base64url: see the header.
 */
export const BOOKING_TOKEN_BYTES = 32
/** 64 characters: two hex digits per byte, and no padding to omit. */
export const BOOKING_TOKEN_LENGTH = 64
const BOOKING_TOKEN_SHAPE = /^[0-9a-f]{64}$/

/**
 * How long a token lives past the treatment: 24 hours after the appointment ENDS.
 *
 * The acceptance criterion names the rule rather than a TTL, and the difference matters. A fixed TTL from
 * issue would have to be longer than the longest lead time in the book — a booking taken six weeks out
 * needs a link that still works on the night — so it would also be a credential that outlives the
 * appointment by six weeks. Anchoring to the END instead makes the link's life a property of the thing it
 * is about: it is alive for as long as there is anything to change, plus one day for the customer who
 * wants to look at what they had.
 *
 * Twenty-four hours and not zero, because the reminder that carried the link is read after the treatment
 * as often as before it, and a link that is dead the moment the massage finishes is a customer who thinks
 * the salon has deleted their booking.
 */
export const BOOKING_TOKEN_GRACE_SECONDS = 24 * 60 * 60

/**
 * What a token may be minted for. One value, and a column rather than an implied constant.
 *
 * The same single-purpose argument 0064 makes, and here the second purpose is nearer than it was there: a
 * clinical-intake link and a receipt link are both things a salon sends a customer, and a token whose
 * purpose was implicit would be valid for both of them retroactively — which is how a link that lets
 * somebody move an appointment becomes a link that hands over their intake form.
 */
export const BOOKING_TOKEN_PURPOSES = ['manage_booking'] as const
export type BookingTokenPurpose = (typeof BOOKING_TOKEN_PURPOSES)[number]

/** Every reason a presented token grants nothing. For the server's log, never for the response. */
export const BOOKING_TOKEN_REFUSALS = [
  /** No token was presented at all. */
  'token_absent',
  /** Not the shape a token has, so nothing was looked up. See {@link bookingTokenShape}. */
  'token_malformed',
  /** Well-formed and no grant holds its digest: mistyped, forged, revoked, or swept. */
  'token_unknown',
  /** The grant exists and its expiry has passed. */
  'token_expired',
  /** A valid grant, minted for a different purpose than the one being redeemed. */
  'token_not_for_this_purpose',
  /** The grant names a booking that no longer has a live appointment to manage. */
  'booking_not_manageable',
] as const
export type BookingTokenRefusal = (typeof BOOKING_TOKEN_REFUSALS)[number]

/**
 * The one response every refusal produces. Frozen, and there is no variant of it.
 *
 * `status` is carried alongside so that no call site gets to choose one. The acceptance criterion is
 * response-body equality between an altered token and an unknown one, and the way that breaks is a route
 * that grew a second branch — a 410 for "expired", a body naming the booking that was not found — each of
 * which is one line and each of which is an oracle.
 */
export const BOOKING_TOKEN_NOT_FOUND = Object.freeze({
  status: 404 as const,
  body: Object.freeze({ error: 'not_found' as const }),
})

export type BookingTokenShapeResult =
  | { readonly ok: true; readonly token: string }
  | {
      readonly ok: false
      readonly reason: Extract<BookingTokenRefusal, 'token_absent' | 'token_malformed'>
    }

/**
 * Whether a presented string could be a token at all.
 *
 * Checked before anything is looked up: a malformed token costs one regex rather than a query, so a flood
 * of rubbish cannot be turned into a flood of database round trips. It is also the only refusal that can
 * be decided without I/O, which is why it is here and the rest of the decision takes the grant as an
 * argument.
 *
 * The length is exact rather than a minimum, for `optOutTokenShape`'s reason: a token is always 64
 * characters because it is always 32 bytes, and a range would accept a truncated paste, which would then
 * be looked up, miss, and be indistinguishable from a forgery in the log.
 *
 * Upper-case hex is REFUSED rather than folded. `ABCD…` is not this token with its case corrected — it is
 * a URL that has not been through the canonicalisation the site applies to every path, and accepting it
 * would hide that for ever behind a link that works. The canonical spelling is the only spelling.
 */
export function bookingTokenShape(presented: string | null | undefined): BookingTokenShapeResult {
  if (presented === null || presented === undefined || presented.trim() === '') {
    return { ok: false, reason: 'token_absent' }
  }
  if (!BOOKING_TOKEN_SHAPE.test(presented)) return { ok: false, reason: 'token_malformed' }
  return { ok: true, token: presented }
}

/**
 * When a token minted for an appointment ending at `endsAt` stops working.
 *
 * Pure arithmetic over an argument, so the four assertions the acceptance criterion asks for are made
 * under a frozen clock rather than against a machine. The appointment's END and not its start: a
 * treatment that has begun is still a treatment a customer may want to look at.
 */
export function bookingTokenExpiry(endsAtMs: number): number {
  return endsAtMs + BOOKING_TOKEN_GRACE_SECONDS * 1000
}

/**
 * Epoch milliseconds as ISO-8601, through the one formatter this package has.
 *
 * The cast is the boundary made explicit in one place rather than at each call site: the values arrive as
 * primitives because the port they cross is spelled in primitives, and `instantToIso` takes the branded
 * type because everything else in `packages/core` does.
 */
const iso = (at: number): string => instantToIso(at as Instant)

/** A grant as `@berelax/db` reads it back. The digest, never the token. */
export interface StoredBookingGrant {
  readonly grantId: string
  /** Lower-case hex of the sha256 of the token. The only representation of it that is stored. */
  readonly tokenSha256Hex: string
  readonly bookingId: string
  readonly purpose: string
  /**
   * Epoch milliseconds, and deliberately a plain `number` rather than an `Instant`.
   *
   * This shape crosses the package boundary: `packages/db` declares the decision as an injected port and
   * may not import this package, so the port is spelled in primitives — the same reason
   * `StoredOptOutGrant.expiresAt` is. A caller holding an `Instant` still passes it unchanged.
   */
  readonly expiresAt: number
}

export type BookingTokenDecision =
  | {
      readonly kind: 'granted'
      readonly grantId: string
      readonly bookingId: string
      readonly expiresAtIso: string
    }
  | { readonly kind: 'refused'; readonly reason: BookingTokenRefusal; readonly detail: string }

/**
 * What a presented token grants, given the grant a lookup on its digest found.
 *
 * Pure, and the grant arrives as an argument for the reason `decideOptOutAccess`'s does: `packages/db`
 * may not import `packages/core`, so the repository declares this decision as an injected PORT and the
 * composition happens at the route, which may import both.
 *
 * `presentedDigestHex` is compared against the stored digest even though the lookup already matched on
 * it. That is not redundant: the lookup's equality is PostgreSQL's, over a `text` column, and what that
 * comparison does about collation, padding and short-circuiting is not this module's to assume. The
 * second comparison is the one whose behaviour is pinned by a test, and it is `digestsEqual` from
 * C-CRM-04 rather than a second comparator — one implementation, one proof that it does not short
 * circuit.
 *
 * There is no `requestedBookingId` parameter, and its absence is the decision `decideOptOutAccess`'s
 * `token_not_for_this_contact` makes from the other side. The opt-out URL names the contact as well as
 * the token, so the two halves can disagree and a mismatch has to be refused. This URL names only the
 * token: the grant IS the statement of which booking is being managed, so there is no second half to
 * disagree with it and no way for a template loop to pair one customer's link with another's booking.
 * "A token grants access to exactly one booking" is therefore a property of the row rather than a check
 * here, and `booking_manage_grant.booking_id` being NOT NULL with one row per token is what carries it.
 */
export function decideBookingTokenAccess(input: {
  readonly grant: StoredBookingGrant | null
  readonly presentedDigestHex: string
  readonly expectedPurpose: BookingTokenPurpose
  /** Epoch milliseconds. A plain `number` for the reason {@link StoredBookingGrant.expiresAt} states. */
  readonly at: number
}): BookingTokenDecision {
  const grant = input.grant
  if (grant === null) {
    return {
      kind: 'refused',
      reason: 'token_unknown',
      detail: 'No grant holds this token digest: mistyped, forged, revoked, or already swept.',
    }
  }
  if (!digestsEqual(grant.tokenSha256Hex, input.presentedDigestHex)) {
    // Reachable only if the lookup returned a row whose digest is not the one asked for, which means the
    // query and this decision disagree about what "equal" is. Refused as unknown rather than raised: the
    // requester learns nothing either way, and the server's log carries the reason.
    return {
      kind: 'refused',
      reason: 'token_unknown',
      detail:
        'The grant found for this digest stores a different one. The lookup and the comparison ' +
        'disagree about equality, which is a fault in the query rather than in the token.',
    }
  }
  if (grant.purpose !== input.expectedPurpose) {
    return {
      kind: 'refused',
      reason: 'token_not_for_this_purpose',
      detail:
        `This grant was minted for '${grant.purpose}' and is being redeemed for ` +
        `'${input.expectedPurpose}'. A single-purpose token is the whole reason the purpose is a column.`,
    }
  }
  if (grant.expiresAt <= input.at) {
    return {
      kind: 'refused',
      reason: 'token_expired',
      detail:
        `This grant expired at ${iso(grant.expiresAt)}, before ${iso(input.at)}. Expiry is inclusive ` +
        'of the boundary: a link is dead at its expiry instant, not one millisecond after it.',
    }
  }
  return {
    kind: 'granted',
    grantId: grant.grantId,
    bookingId: grant.bookingId,
    expiresAtIso: iso(grant.expiresAt),
  }
}

/**
 * Every field the manage-booking page may print, as a closed list.
 *
 * The acceptance criterion is *"the page renders only fields on a declared allowlist"*, and a declared
 * allowlist is only worth something if it is the thing the page actually reads. So this is not
 * documentation of the view: `ManageBookingView` in
 * `apps/web/app/(public)/booking/[token]/render.ts` is keyed on this union, so a field added to the view
 * without being declared here does not typecheck, and a field declared here that the renderer ignores is
 * caught by the render suite's enumeration.
 *
 * ## What is absent, and why each absence is a decision
 *
 * **Every clinical field.** `contraindication`, an intake answer, a therapist's note: ADR 0010's boundary
 * is that a receptionist cannot read a clinical note, and this page is reached by anybody holding a link
 * out of an SMS — a phone on a table in a café. docs/06 D2 is about exactly this surface: the detail goes
 * behind the link, and clinical detail does not go behind THIS link.
 *
 * **Any name.** The customer has none recorded in the ordinary case (ADR 0020, brief rule 10) and the
 * therapist has none until an admin sets one, so a field for either would print an invented value or an
 * id. It is also unnecessary: the reader of this page knows who they are, and the one thing they cannot
 * be shown is somebody else.
 *
 * **The price.** Not a privacy decision but a correctness one: the amount owed is the till's answer
 * (docs/03 §2) and a figure printed here from `appointment.gross_price_fils` would be the quote rather
 * than the bill — right until the first discount, and then wrong on a page the customer keeps.
 */
export const MANAGE_BOOKING_FIELDS = [
  /** The booking's own id, shown so a telephone call can be about a specific booking. */
  'bookingReference',
  /** The trading date the appointment is filed under, as `resolveTradingDate` resolved it. */
  'tradingDate',
  /** Treatment start and end, ISO-8601 in the business zone. One zone, printed. */
  'startsAtIso',
  'endsAtIso',
  /** The treatment as sold: the service name and its duration. */
  'serviceName',
  'durationMinutes',
  /** The lifecycle status, from `appointment.status`. */
  'status',
  /** Whether the cancellation window has closed, and the window that was judged. */
  'insideCancellationWindow',
  'cancellationWindowHours',
  /** When the link itself dies, so a reader is not surprised by it. */
  'linkExpiresAtIso',
] as const
export type ManageBookingField = (typeof MANAGE_BOOKING_FIELDS)[number]

/**
 * Field names a manage-booking response must never contain, as lower-case substrings.
 *
 * The negative half of the allowlist, and it exists because the positive half cannot catch the failure
 * this criterion is about: a renderer that dumped a row it was handed would satisfy "every declared field
 * is present" and leak everything else. So the response body is also searched for these, and the list is
 * here rather than in the test because the words are the domain's — `packages/clinical` and the intake
 * form name them — and a list in one test is a list the next surface does not get.
 */
export const CLINICAL_FIELD_MARKERS = [
  'contraindication',
  'clinical',
  'intake',
  'allergy',
  'allergies',
  'medication',
  'pregnan',
  'diagnos',
  'medical',
  'health',
  'injury',
  'consent_wording',
  /**
   * Every key of the closed flag set (C-CRM-09), SPREAD rather than typed out.
   *
   * Enumerating the eight keys against the hand-written list above found four of them absent:
   * `recent_surgery`, `cardiovascular`, `skin_condition` and `requires_consultation` matched no marker,
   * so a response body naming any of them passed the sweep. `pregnancy` matched `pregnan`,
   * `allergy_present` matched `allergy` and `acute_injury` matched `injury`, which is exactly how a
   * hand-kept list comes to be half right and read as whole.
   *
   * Derived rather than copied, so a ninth key is refused by this guard on the commit that adds it rather
   * than on the commit that remembers to. And the keys are safe as substring markers in a way that the
   * English words they contain are not: the marker is the whole snake_case key, so `requires_consultation`
   * cannot be tripped by a treatment called "Consultation" the way a bare `consultation` would — which is
   * the false positive that gets a sweep like this switched off.
   */
  ...CONTRAINDICATION_FLAG_KEYS,
] as const
