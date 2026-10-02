# ADR 0067 — "no card number touches this build" is a scan that FAILS, never an assertion that passes; and the refusal names the column, never the value

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** Y-PAY-03
- **Covers:** docs/01 decisions — none. This is the checkout-shaped consequence of
  [ADR 0022](0022-provider-ports-and-fakes.md)'s port-and-fake rule and of
  [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md); it locks a mechanism, not a new scope decision.

## Decision

**Card entry happens entirely inside the gateway's cross-origin hosted fields, and the claim that no primary
account number reaches this build is defended by four things that FAIL when it stops holding — never by an
assertion that passes. Where a refusal is safe it is the DATABASE's (migration 0117, `ZY231`); where a refusal
would be worse than the leak it is a REDACTOR plus a scan. And every refusal, at every layer, names the column
or the field and never the value.**

The four defences, and what each one is against:

| Defence | What it catches | What it cannot |
|---|---|---|
| `pnpm saq-a` — seven static rules, fixtures in gate block 145 | a `cc-` autocomplete token or a card-named field in anything this build renders; a payments transport that reads a body outside the one boundary; a second definition of the card shape; a payments sink write that skips the redactor; a second policy builder; a literal gateway origin | anything at runtime |
| `assertNoCardData` at the request boundary | a card-shaped value, or a field NAMED after card data, in any payments request — 400, before a statement is issued | a three-digit number in a field called `note` |
| `ZY231` (migration 0117) | a card-shaped `reference`, `idempotency_key`, `gateway_intent_id` or `gateway_event_id`, from any writer, including one that skipped the boundary | `audit_event` and `outbox_event` — deliberately (below) |
| the sweep in `checkout.itest.ts` | a Luhn-valid test PAN reaching `audit_event`, `outbox_event`, the message outbox or a served response | a sink nobody thought to query |

## Why the absence needs a gate at all

An absence is the one claim a passing test cannot make. "The audit row does not contain a card number" passes
on the day a card number could not possibly reach that row and on the day it can, because on that day nobody
has run a card through yet. The test does not become wrong; it becomes *uninformative*, and nothing announces
the transition.

So the question this unit had to answer was not "is there a card number in the database" but **"what fails on
the day one could get there?"** Each of the seven static rules is one answer, and each has a known-bad fixture
that has been seen to fire (ADR 0003). The one worth reading twice is rule 1: an `autocomplete="cc-number"` on
an admin screen moves this system from SAQ-A to SAQ-A-EP — a change of PCI scope — in a line of markup that
reviews as an improvement, because it makes the screen work when the frame fails to load.

The gate found two live defects on its first run against this unit's own tree, which is the argument for it
made better than any reasoning could. The checkout's own `route.ts` parsed the form body itself and handed the
result on, so there were two readers of a payments submission where the design said one. And Y-PAY-02's
`/api/v1/payments/intent` refused no card data at all: it takes two free-text fields a caller chooses,
`reference` and `idempotencyKey`, and passed both to a row and to an `audit_event` payload. Neither was
visible in review, both are fixed here, and neither would have been found by a test of the checkout.

## The refusal must not quote what it refused, and that is why 0117 is a trigger

A `CHECK` constraint is the obvious way to refuse card-shaped text in `payment_intent.reference`. It is the
wrong way, and the reason is mechanical rather than stylistic. PostgreSQL reports a check violation as:

```
ERROR:  new row for relation "payment_intent" violates check constraint "payment_intent_reference_not_card_shaped"
DETAIL:  Failing row contains (019a…, 4111111111111111, …).
```

The constraint that kept the card number out of the column writes it into the server log, and from there into
wherever logs ship. **The guard would create the disclosure it exists to prevent, on the path everybody agrees
is the safe one.** So the rule is a trigger raising a message we write, which names the table and the column
and stops there — and that is also the reason the refusal needs a private SQLSTATE at all (ADR 0043): the prose
is deliberately uninformative, so a caller has to be able to branch on the code.

The same rule runs all the way up. `CardDataRefused`'s message lists paths and no values. The token endpoint's
400 returns paths and no values, including for the caller that sent them — a response is a value logged twice,
once by us and once by whatever the client writes down, and the second copy is the one we cannot see. A
`JSON.parse` failure is reported without the parser's own message, because `SyntaxError` quotes the offending
input. And a refused submission is not echoed back into the re-rendered form, which would have put the number
in the HTML of the response that refused it.

## Why `audit_event` and `outbox_event` get a redactor and NOT a trigger

This is the part of the decision somebody will want to reverse, so the measurement is here. "No audit row may
be able to contain a card number" is the strongest-sounding version of the rule and it is refused on grounds
that are arithmetic rather than aesthetic.

`is_card_shaped` reports a 13-to-19-digit Luhn-valid run, and about one arbitrary run in ten of that length is
Luhn-valid — measured: of 200,000 random 16-digit runs, 66.5% contained at least one Luhn-valid 13-to-19-digit
window. Those two payloads carry the whole build's data, and it includes a fifteen-digit TRN, an IBAN whose
BBAN can be sixteen digits or more (P-HR-12's WPS file) and E.164 numbers up to fifteen digits. A trigger there
would refuse legitimate writes, and **an audit write that can be refused is an audit trail with a hole in it** —
a worse failure than the one being prevented, and one that would be discovered as a 500 on an unrelated screen.

So: structural where a refusal is safe, redacted where it is not. `redactCardData` before every sink, rule 6 of
`pnpm saq-a` refusing a payments module that writes to a sink and names no redactor, and the full-text sweep as
the runtime evidence. The asymmetry is the decision, and it is the honest one.

## Why a CVV is refused by NAME and a PAN by SHAPE

A PAN has a shape. A CVV has none: three or four digits is also every fils amount under a hundred dirhams,
every OTP and every year. A shape rule for a CVV would refuse the whole system's traffic or refuse nothing.

So the CVV half of the rule is a field-NAME refusal, and it is enforceable exactly because this build's
checkout has no such field: under SAQ-A the security code is typed into the gateway's own document, so a request
that presents one is by construction not a request this build's checkout made. The limit is stated plainly
rather than left to be discovered: **a three-digit number in a field called `note` cannot be told from any other
three-digit number, by this build or by anything else.** What is defended is that no field exists to put one in,
that nothing renders an input that accepts one, and that a field named after one is refused the moment it
appears — whether or not anything ever puts a value in it, because the field is the defect.

## The alternative that was rejected: check it in the handler and stop there

That is what the endpoint does anyway, and as the ONLY guard it fails in the three ways
[ADR 0056](0056-only-a-gateway-transaction-row-may-move-a-payment-intent.md) already paid for one layer down.
It is one `if` away from being skipped and the skip is silent. A second writer does not have to know the rule
exists — Y-PAY-04's webhook, Y-PAY-05's reconciliation and Y-PAY-06's refund screen are three more writers of
these tables, in three worktrees that cannot see each other. And the evidence of the bug is the record that is
missing.

## The consequences somebody has to live with

- **There is no card gateway configured, so `/checkout` cannot take a card, and that is the shipped state.**
  `PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN` and `PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN` have no default, are not
  derived from each other, and are refused as plaintext in production. Unconfigured is a first-class answer:
  the screen renders a refusal naming the settings and `Y7-hosted-fields`, the submit control is disabled, and
  the policy becomes `frame-src 'none'; script-src 'none'`. A checkout that cannot take a card is the strictest
  safe option; one pointed at a guessed vendor origin is brief rule 15's exact failure, and what it produces is
  a checkout framing a domain nobody owns.

- **`script-src` does not include `'self'`, so the checkout may never carry a first-party script.** That is the
  one directive that is an argument rather than a default, and it is the one that will be inconvenient: the day
  somebody wants analytics on the checkout, or a form helper, or a session recorder, the policy refuses it. That
  is the intent — each of those is how a hosted-fields integration is actually broken in the wild, and each
  would look like ordinary front-end work. `style-src` DOES allow `'unsafe-inline'`, because every admin
  document in this build delivers its stylesheet in a `<style>` element; the asymmetry is safe only because
  there is no same-origin card input for CSS to read, and that absence is what rules 1 and 2 defend.

- **The card shape is stated twice and the check that holds the two equal is part of the deal.**
  `cardShapedRuns` in TypeScript and `is_card_shaped` in plpgsql, because SQL cannot read TypeScript.
  `CARD_SHAPE_PROBES` is the corpus, stated once, and
  `packages/fixtures/src/card-shape-agreement.itest.ts` drives every entry through both. The direction the
  drift would take is the dangerous one: a database still accepting what the boundary had started refusing, so
  a test asserting the refusal is satisfied by the wrong layer.

- **The detector refuses about two thirds of arbitrary 16-digit numbers, and that is the chosen direction.**
  Every 13-to-19-digit window inside a digit run is checked, because a card number pasted inside a longer
  string is the shape an accident produces and a whole-run check misses it. The cost is false positives on long
  digit runs; the benefit is that `INV-0042<PAN>` is caught. At the payments boundary a false refusal is a 400
  somebody reads and a false acceptance is a PAN in a database, so the asymmetry decides it. It is also why the
  negative controls in the corpus are 13 digits — one window, so Luhn alone decides — plus one MEASURED
  16-digit value, since a negative at that length has to be searched for rather than written by changing a
  check digit.

- **The hosted-fields token is forwarded and never written down.** `AuthoriseRequest.instrumentToken` travels
  through `createPaymentIntent` into the adapter and stops. There is no column for it, it is in
  `SECRET_FIELD_NAMES` so every sink redacts it, and what the movement record carries is a BOOLEAN saying
  whether one was presented — because that record IS the operator-visible payments screen, and a movement row
  holding a live charge credential is a credential in every screenshot. The boolean is what makes "the checkout
  actually forwarded the token" assertable: a checkout that stopped would authorise against nothing and look
  identical from every other angle.

- **The cross-origin claim needs a second server in the integration suite, for ever.** "The card field is
  inside a cross-origin iframe" is `frame.contentDocument === null` in a real browser, and it cannot be
  asserted against a frame with no card field in it. So `apps/web/src/checkout.itest.ts` stands a stand-in
  gateway origin up on a kernel-assigned port and serves a card-entry document from it — the one file in this
  repository that legitimately contains `autocomplete="cc-number"`, exempted by name in
  `scripts/check-saq-a.mjs` with that reason. Removing the exemption would make the central claim of the unit
  unassertable; widening it to anything else would make the gate decorative.
