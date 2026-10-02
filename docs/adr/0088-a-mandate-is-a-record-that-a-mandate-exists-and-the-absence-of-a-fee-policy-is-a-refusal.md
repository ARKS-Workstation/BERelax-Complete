# ADR 0088 — a mandate is a RECORD that a mandate exists, and the absence of a fee policy is a REFUSAL

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** Y-PAY-07
- **Covers:** docs/01 decisions — none. It stands on ADR 0007 (integer fils, the VAT-inclusive gross
  authoritative), ADR 0008 (append-only tables), ADR 0017 (the journal has no edit), ADR 0043 (a refusal is
  identified by all five characters of its SQLSTATE), ADR 0056 (only a gateway transaction may move a
  payment intent), ADR 0057 (a liability that accumulates is recorded cumulatively and the live figure is a
  view), ADR 0067 (the SAQ-A division of labour: structural where a refusal is safe, scanned where it is
  not), ADR 0070 (an unattributable figure is a refusal and never a zero) and ADR 0077 (a deposit is
  appointment-scoped, and `cancellationCharge()` is the one seam a fee would arrive through).

## Decision

**A card-on-file mandate is a RECORD THAT A MANDATE EXISTS AT A GATEWAY — which disclosure the customer was
shown, when they agreed, what maximum they agreed to, and the gateway's opaque handle — and never a stored
instrument. The row is append-only, because it is evidence of what a person consented to. And the fee
charge path EXISTS and refuses: no charge may be recorded while no fee policy is on file, and the absence
of a policy is a refusal and never a charge of zero fils.**

## Why a mandate is paperwork and not an instrument

There is no chosen gateway, no merchant account and no MCC (`PENDING['card-gateway']`), so there is no
token to hold and no scheme to name. But the shape would be wrong even once there is one.

Under SAQ-A, card entry happens entirely inside the gateway's cross-origin hosted fields and nothing in
this build may hold a primary account number. The tempting middle ground is the set of fragments that each
look harmless: a last-four to show the customer which card is on file, an expiry month so the front desk
can warn them it is about to lapse, a scheme so the icon is right, a BIN for a fee calculation somebody
will want later. Each is individually defensible. The set of them is a cardholder data environment, and
nobody decides to build one — it accretes a column at a time, each addition reviewed on its own merits.

So `payment_mandate` has no such column, and `ZY423` makes the absence structural rather than
conventional: a `token_reference` that is card-shaped — a 13-to-19-digit Luhn-valid run — is refused. The
shape is 0117's `is_card_shaped()`, **called and not restated**, because `pnpm saq-a` refuses a second Luhn
check anywhere in the tree and the second detector is the one that misses the spelling with spaces in it.

`ZY423` is a separate code from `ZY231` rather than a branch added to `refuse_card_shaped_payment_text()`
by `create or replace`, and the reason is not cosmetic: the two are different rules over one shape — free
text a PERSON typed, against a value a GATEWAY returned — with different remedies, and `create or replace`
would put one function's body in two migration files, so whichever reads second silently wins.

## Why the mandate row is append-only, and what that forces

The row says a specific person was shown specific words at a specific instant and agreed to a specific
maximum. An UPDATE on it would restate what somebody consented to, after the fact, with nothing left saying
what they actually consented to — and the field it would restate is the cap, which is the entire content of
the agreement. So `ZY421` refuses UPDATE and DELETE for every role including the owner, which is ADR 0008's
argument for `audit_event` applied to the one row whose edit a customer would dispute.

That makes `revoked_at` on the row impossible, and the consequence is the shape of the schema. A revocation
is a SECOND act by the same person at a later instant, so it is a second row:
`payment_mandate_revocation`, append-only on the same terms, keyed ON the mandate id so a mandate cannot be
revoked twice. The live state is the view `payment_mandate_status` over the dates and that row — ADR 0057's
shape one subject along from `appointment_deposit_balance`.

A stored `state` column was the alternative and it fails in a specific, dated way: nothing runs at the
instant a mandate expires, so a stored state reads `active` for ever unless a job sweeps it, and the charge
path would then read `active` from an authority that lapsed in March.

The view and the trigger ask DIFFERENT questions and both are needed. The view answers "what is the state
now", at `now()`. The trigger judges an attempt at `new.attempted_at`, never at `now()`, because a
revocation recorded after an attempt does not make that attempt retrospectively unauthorised and an
attempt replayed by an importer must be judged by the authority that was in force when it happened. The
integration suite found this distinction the hard way, which is why it now has a case of its own.

## Why the charge path exists at all, when it refuses every input

`cancellationCharge()` answers zero for every input. `Y9-windows` says "24h window; no fee charged, flagged
only". The owner has agreed no fee policy and the business holds no merchant account. So the honest reading
is that there is nothing to build.

That reading is wrong, and the reason is the one this whole record is about. **A fee path that is
"disabled" by not existing is re-invented by whoever next needs one** — in whatever module they happen to
be in, with whatever figure seems reasonable that afternoon, and the figure is then in the books as a
decision nobody made. The mechanism therefore exists, in one place, and refuses; and the refusal is
enforced by PostgreSQL rather than by a module, because a second call site would not read the module.

`ZY426` is that sentence: no `mandate_charge_attempt` row may read `charged` while
`cancellation_fee_policy_on_file()` answers false, which it does. The figure is an ARGUMENT everywhere —
nothing in this unit derives a fee — and `cancellation_fee_policy_on_file()` reads no setting at all,
because a function falling back to false over a missing row would make "the policy is off" and "nobody has
recorded a policy" indistinguishable, which is exactly ADR 0070's conflation one layer down.

**And the refusal must not become a zero.** This is the decision, stated as the thing a reviewer would
otherwise simplify away. A gate that answered `0 fils` instead of throwing would compile, balance, and
report a fee that had been correctly worked out to be nothing. Y9-commission recorded the identical mistake
in its own words: a run that produced no lines was reported as no commission being due. So
`noShowOutcome` carries `feeFils: null` and not `feeFils: 0` — a zero is a figure and gets summed; the
absence of one refuses to be.

## Why the order of the refusals is the reverse of the obvious one

`assertFeeChargeable` checks the mandate, its state and its cap BEFORE it checks whether a policy exists,
and migration 0134 does the same on the row. Putting the policy gate first is the obvious simplification
and it is refused here: with it, every one of this unit's five acceptance refusals collapses into one
"no policy on file" message, and the cap rule and the revocation rule become code nobody has ever seen run.
ADR 0003 is why that matters — a refusal nobody has seen fire is not a refusal — and gate case 166c is the
known-bad fixture that makes the ordering a property of the build rather than a preference.

## The consequences somebody will have to live with

**The rule is stated twice, in two languages.** `packages/core/src/payments/fee-policy.ts` and migration
0134 both hold it, because `packages/db` may not import `packages/core` and SQL cannot read TypeScript.
`packages/fixtures/src/mandate.itest.ts` is the only package that may import both and is where they are
held equal. The direction that matters is one: a database that had started permitting what the module
refuses, so a test asserting the refusal would be satisfied by the wrong layer.

**Refused attempts are rows.** `mandate_charge_attempt` records every attempt including the ones the
database stopped, because "we tried to charge this customer and the system refused" is a fact an operator
needs and a refusal nothing counts is a refusal nothing can audit. The cost is a table that grows with
failures rather than with successes, which is unusual and deliberate.

**Enabling the path is a decision and not an edit.** `payments.cancellation_fee_charging_enabled` is named
in `@berelax/core` as the setting that would have to move, with the audit trail `app_setting` carries — but
no such row exists, and `cancellation_fee_policy_on_file()` does not read it. Turning the path on therefore
requires answering `Y9-windows`, writing the disclosure wording, choosing a gateway, and changing the
function and this record. That is more friction than a feature flag, and it is the right amount for a
capability that takes money from a customer who is not present.

**No mandate can be recorded against unwritten words.** `ZY422` refuses the sha256 of the empty string and
a placeholder version marker, so until a disclosure is written and approved the only mandates this build
can hold are ones whose wording version is a real string somebody chose. That is a deliberate obstacle:
brief rule 15's position is that a plausible-looking value is worse than a blank one, because blank is
visibly unanswered.
