# ADR 0079 — a WhatsApp ref code is a lifetime, a uuid and an attribution the database proved

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** A-FIRST-07
- **Covers:** docs/01 decisions — none of its own. It is a mechanism under ADR 0018 (the measurement plan,
  which requires ref-capture rate to be *reported*), beside ADR 0045 (the analytics schema and its 90-day
  retention), ADR 0046 (the event taxonomy), ADR 0058 (origination) and ADR 0066 (nothing identified is
  written before consent). It completes the schema migration 0079 created for B-UI-04, which deferred three
  decisions in writing to "the unit that owns the conversation".

## Context

The WhatsApp ref code is how a conversation in an application this system cannot read is tied to a booking
that happened in a browser. Four characters are shown to a customer, carried in a prefilled message, read
back across a counter and typed into a field. It is the only join between the two halves of the funnel, and
`Y12-ref-loop` asks the question the whole mechanism stands on: whether the front desk will type it at all.

Migration 0079 (B-UI-04) built the booking side — the codes table, the per-booking capture row, the two
CHECK constraints that make an invented attribution unrepresentable — and deliberately left three things
open, naming the unit that would close them:

- the handle the code is bound to is `text` and opaque, because "the handle is whatever the unit that owns
  the conversation says it is";
- there is no lifetime at all, so a code is claimable for ever;
- nothing composes the `wa.me` link, because `premises.phone_whatsapp` holds a placeholder
  `is_placeholder_text()` refuses (`Y1-nap`) and `packages/shared/src/premises-links.ts` carried a paragraph
  arguing that a builder "would exist to be called".

Each of those is a decision rather than a gap, and each has an obvious resolution that is wrong in a way a
later reader would have to reconstruct.

## Decision

### A code has a stored lifetime, and it is never recycled

`whatsapp_ref.expires_at` is `not null`, stamped at issue from `booking.whatsapp_ref_ttl_days`
(`Y12-ref-ttl`, provisionally seven days), and the claim path compares against it.

**The expiry is stored and not recomputed.** `issued_at + ttl` evaluated at claim time is the simpler
spelling and it is wrong: answering `Y12-ref-ttl` would retroactively move the recorded outcome of bookings
already taken — a booking filed as `ref_expired` in March reading as `matched` in April with no row having
changed. The expiry is a property of the code **as issued**, because the artefact it governs, the message in
the customer's chat, was composed once.

**An expired code is not reissued.** This is the step a TTL invites and it is the one thing the schema must
refuse. The code lives in the customer's chat history, not in our database: handing `7K2Q` to a second
conversation makes a two-week-old message attribute a booking to a stranger's session. `ref_code` therefore
stays the primary key with no expiry in it, so the unique index refuses a collision inside the window and
outside it alike, and `issueWhatsappRef` redraws, eight times, and then refuses rather than lengthening the
code — a code of a different shape would match neither the field, the column nor the desk.

**An expired code still takes the booking.** It records `ref_expired` and keeps the code. The ref field may
never block a booking, and "the desk pasted a code we issued three weeks ago" is a finding about our TTL
rather than a mistake at the counter — which is why the row keeps the evidence.

### The alphabet loses `U`, and the argument is 0079's own taken one step further

0079 excluded I, O, 0 and 1 as "the four characters a person reading a code off a phone screen confuses".
With those gone, a misread of `L` as `1` or `I` produces a value that is not a code at all: it fails the
CHECK, fails the field's pattern, and resolves to `unknown_code` — a visible warning and an honestly unknown
attribution. **`U` misread as `V` is the only remaining pair in which the wrong character is itself in the
alphabet**, so that misread produces a different *valid* code and the booking is credited to somebody else's
conversation. That is the failure 0079's whole paragraph is about, and it was still reachable. `L` goes with
`U` because they are one convention — Crockford's base32 exclusion set — and because an attempt wasted on
`L`/`1` is an attempt the customer does not get back.

The code space falls from 1,048,576 to 810,000. It was safe to narrow now and will not be later: the table
is still empty, so no issued code is retrospectively refused by a CHECK the column no longer admits.

### `session_reference` is a uuid, and the type is the PII decision

Every other column on that row is one step from a person — the code is read off a phone and typed in at a
counter — so a `text` handle is a column a later unit, an import or a backfill could put a phone number, an
email address or a name into with nothing to notice. A blacklist CHECK cannot close it: a regex refusing a
run of six digits refuses most uuids as well, because a hex string is six consecutive decimal digits
somewhere about four fifths of the time. The guard is therefore **positive** — the only value the column
accepts is a uuid, and a uuid cannot be a contact detail. The code itself is already structurally incapable
of carrying one, because `mintWhatsappRefCode` takes no input at all.

It is still called `session_reference` and still has **no foreign key** to `analytics.session`. Retention
purges a session at 90 days (ADR 0045) and an attribution has to outlive the session it is about, so neither
`cascade` (which would delete the code, and then be refused by the capture row's own `restrict`) nor
`restrict` (which would stop the retention pass) is available. A name promising a key would be a lie about
which of the two rows is allowed to disappear.

### An attribution is refused by the database, not only by the rule

`booking_whatsapp_ref_capture.attributed_session_id` is the originating session, present for `matched` and
for nothing else. It is on the capture row and not on `booking`, for the reason 0079 rejected a
`whatsapp_ref` column there: an attribution is a property of the booking rather than of the person, the
capture row is already 1:1 with the booking and carries no customer id, and a nullable column on `booking`
would mean both "no session" and "a session we could not prove". The first- and last-touch columns on
`booking` and `customer` remain A-FIRST-08's, which joins from here for a desk booking.

Three CHECK constraints state what one row can state: the code is present for exactly the three outcomes in
which it resolved, the typed text for `unknown_code` alone, the attribution for `matched` alone. The two
facts that live on **another** row cannot be a CHECK, and they are two private SQLSTATEs:

- **ZY331** — a `matched` row naming a code whose lifetime had run out. A `conflict` to a caller, because it
  would have been accepted an hour earlier and the remedy is a different outcome on the same booking.
- **ZY332** — a `matched` row naming a session the code was not issued into. An `invariant_violated`,
  because this code and not the person at the counter constructed it.

`decideRefCapture` already refuses both, and that is the rule. It does not hold for anything else that can
write the row, and the failure is the invisible kind: a booking credited to a conversation nobody proved
reads exactly like one credited correctly.

### No number, no code — and the capture rate is two measures, never one

`whatsappLinkFor` answers a union: a link, or `unavailable` carrying `Y1-nap`. There is no return value a
page could render by accident, which is strictly stronger than the previous absence of a builder — the
absence stopped a builder being written and could not stop a caller writing `` `https://wa.me/${number}` ``
inline, which is the same defect with no name on it.

`GET /api/whatsapp` therefore **mints no code at all** when the number is unanswered. That is the decision
and not a side effect: `codes_issued` is the denominator of the capture rate, and a code minted into a
message nobody can send would make our own missing configuration read as a front-desk failure. The same
applies to a visitor with no consent and to a session idle past the thirty-minute window: no session, no
code, because the code exists to tie a conversation to a browser session and a code bound to nothing is a
denominator with no numerator possible.

The rate itself is **two different measures that must never be averaged**. `refCaptureRate` divides matched
*bookings* by bookings taken at the desk and asks "is the desk filling the field". `refIssueCaptureRate`
divides claimed *codes* by codes issued and asks "does a conversation become a booking". A desk that pastes
every code it is given scores 100% on the first and 4% on the second, and both figures are correct. They are
two functions with two result types rather than one function with a flag.

The issue-side figures are `analytics.daily_ref_capture`, a fourth rollup beside the three of ADR 0045 and
**not** rows in `analytics.daily_funnel` — A-FIRST-01 deferred the shape here, because a code issue is not
one of the eight funnel steps, carries no origination tuple, and "claimed" is not an `excluded`. The row is
keyed on `analytics.session`'s own (trading date, basis) pair, and `codes_claimed` is paired with the day the
**code** was issued: dividing today's claims by today's issues mixes cohorts and can exceed 1, and a capture
rate of 140% is arithmetic nobody can act on.

## Consequences

- **The TTL is a knob with one reader, and a short one is the safe direction.** Answering `Y12-ref-ttl`
  governs codes issued afterwards and nothing already recorded. A value too short is visible as a
  `ref_expired` count; too long is invisible.
- **A dead unclaimed code is not purged, and that is handed on.** A code a booking names must survive, which
  the capture row's `on delete restrict` enforces. A code that expired with nothing referencing it has no
  purpose and should eventually go, but a nightly pass needs an agent row and a job — it goes to A-FIRST-09
  with the nightly rollups, and `whatsapp_ref_expires_at_idx` exists as the predicate it will need.
  `whatsapp_ref` is in `public`, so ADR 0045's `analytics.retention_policy` does not cover it and its absence
  from that list is not an omission.
- **The rollup is recomputed on every write, so there is no nightly pass to miss.** Both figures are
  `count(*)` out of the two tables in one statement, so two runs produce identical rows, a figure that went
  wrong converges on the next call, and there is no state in which the rollup and the tables disagree and
  both look right. The cost is one upsert inside each issuing and claiming transaction.
- **This unit adds no WhatsApp provider, credential or sender id, and that is the shape rather than a
  deferral.** The message is composed as a URL and sent by the customer's own client, so there is no
  outbound call to make and nothing to authenticate. The server-side WhatsApp send stays `unregistered` in
  `SENDER_IDENTITY_ROUTES` (ADR 0016).
- **Two things now have to be true in two places, and each has the check that holds them equal.** The
  alphabet is spelled as a string and as a range class (`whatsapp-ref.test.ts` compares the sets by
  exhaustive enumeration), and the expiry boundary is `<=` in TypeScript and `<=` in plpgsql (the unit test
  asserts the instant itself is expired, which is the only shared edge).
