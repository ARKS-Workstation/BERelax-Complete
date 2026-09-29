# ADR 0055 — a payment adapter is what the conformance suite accepts, and every declared inability is a refusal

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** Y-PAY-01
- **Covers:** docs/01 decisions — none. This is the payments-shaped consequence of decision 32
  ([ADR 0022](0022-provider-ports-and-fakes.md)) and of ADR 0007's money rule; it locks the mechanism, not
  a new scope decision.

## Decision

**The `PaymentGateway` port is pure types and pure state logic in `packages/core/src/payments`. An
implementation of it is an *adapter* only once `runPaymentGatewayConformance` accepts it. The suite runs
against every adapter the registry builds, from one definition, and every capability an adapter declares
`false` is a REFUSAL the suite demands rather than a case it skips.**

Three consequences fall out of that sentence, and each is enforced rather than intended:

1. **`packages/payments` is the only place an adapter is constructed**, and the only place
   `PAYMENT_PROVIDER` is read. `payment-gateway-adapters-only-through-the-registry` in
   `.dependency-cruiser.cjs` is the enforcement, with the package barrel deliberately re-exporting no
   constructor — a re-export defeats a module-matching rule completely, which is the loophole
   `messaging-providers-only-inside-a-transport` found the hard way.
2. **A gateway on another minor-unit convention converts at its own edge and nowhere else**, and a
   conversion that cannot be made exactly refuses instead of rounding ([ADR 0007](0007-money-and-business-day-primitives.md)).
3. **The intent's lifecycle is one declared table**, total over (state × event), and ordering is resolved
   from the gateway's own instants before the fold — so the answer is a function of the set of events and
   not of the order they were delivered in.

## Why a conformance suite rather than an interface

`tsc` cannot tell an adapter that records a movement from one that returns a well-shaped object and writes
nothing. Both satisfy `PaymentGateway`. The second one demos perfectly, passes every test written against
its own return values, and takes money without posting anything — which presents as a reconciliation short
by every transaction, months later, with no error anywhere to point at.

ADR 0022 already made this argument for the provider fakes and answered it with three rules asserted over
the registry. This is the same argument where the stakes are money rather than a message, so the contract is
longer: nineteen rules, covering the movement record, the injected clock, idempotency, the amount
invariants, the transition table, the minor-unit edge, and both directions of all five capability flags.

## The part worth arguing: a capability flag is not an exemption

The obvious way to write this suite is to check partial refunds *if the adapter says it supports them*. That
is how a capability flag becomes the mechanism by which an adapter opts out of the contract — and the first
adapter to do it would be the real one, in production, on the path nobody had exercised. A till that
answered a void with success while the cash was still in the drawer would report a payment as cancelled and
pass a suite that had skipped the case.

So every flag is checked in both directions. `supportsVoid: false` means a void must be **refused**;
`emitsEvents: false` means the stream must be **empty** after a capture that would otherwise have filled it;
`hasExternalService: false` means an armed failure must change **nothing**. The report therefore carries one
result per declared rule for every candidate, and the test asserts that count — a rule cannot be silently
skipped, because there is no code path that skips one.

The manual till adapter declares three of the five `false`, which is what makes this more than a design
argument: four of the inverse branches are exercised by a real, shipped adapter on every run.

## Why the suite is a runner and not a `describe` block

A suite of `it(...)` cases can assert that an adapter conforms. It cannot assert that an adapter **fails** a
named rule, and that direction is the whole of [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md):
*a conformance suite nothing has ever failed is a suite that conforms to nothing.*

So `runPaymentGatewayConformance` returns a per-rule report, and
`packages/payments/src/conformance/fixtures/saboteur.ts` is a fourth implementation of the port with exactly
one thing broken at a time — nineteen defects, one per rule, plus `'none'`. `suite.test.ts` asserts that
`'none'` **conforms**, that each defect fails **exactly** the set of rules it breaks, and that the set
contains the rule the defect exists to break. Set equality rather than membership, because an expectation
updated to whatever the suite currently reports is an expectation that can drift off its own subject.

The control matters as much as the defects. Without `'none'` passing, every rejection could be explained by
the fixture being generally shoddy, and the rules would be measuring the fixture rather than the defect —
which is the gap that let three commits in this build capture a gate fixture's value as the real one.

Being a plain function also means the suite is callable outside vitest: from a gate case, or from a
boot-time check on the day there is a real adapter.

## Why `card_online` joined the tender registry instead of the port bringing its own vocabulary

The port has to say which instrument an intent is for. The cheap answer is an enum on the port — and the H02
provider fakes already carry one (`'cash' | 'card_terminal' | 'card_online'`). It costs no migration.

It is also a second answer to "where does card money go", with a second posting-account map beside it. A
disagreement between two such maps does not present as a type error; it presents as a bank reconciliation out
by every gateway batch, with two plausible sources. M-TILL-07 had already left the room: `tender_type.adapter`
carries the closed set `('manual', 'gateway')` under the note *"All three are `manual` today, which is the
honest answer: the gateway does not exist. This is the column Y-PAY's types will differ on"*, and migration
0018 seeded account `1030 Payment gateway clearing`, which nothing had debited.

So migration 0105 inserts one row, the port's instrument type IS `TenderKind`, and there is one map from
instrument to account. `1030` and not `1040`, though both clear card money that has not arrived: the terminal
settles in batches against a merchant statement and the gateway pays out on its own schedule net of processor
fees against a payout file, so one account holding both streams reconciles against neither on its own.

## Consequences somebody has to live with

- **Two payment ports exist in the tree.** H02's `PaymentProvider` in `packages/providers/src/payments`
  predates this chain and nothing outside that package consumes it — `Providers.till` and `Providers.cards`
  have no callers. It is left in place rather than removed, because removing it edits another unit's
  deliverable and its own conformance test; the duplication is recorded here and in the manifest NOTE so
  that whoever wires the intent surface retires it rather than choosing between the two by accident. What
  IS shared is deliberate: the reference markers that steer the fake into its 3DS and declined paths, the
  `FailureScript`, and `notImplemented`, each imported by subpath because the providers barrel is banned
  outside a transport.

- **The fake gateway reports thousandths, not fils.** No gateway has been chosen and the MCC is unanswered
  (OPEN-QUESTIONS `Y7-mcc`), so the real convention is unknown and nothing here guesses it. What is known
  is that a build where every adapter spoke fils would ship ADR 0007's edge-conversion requirement
  untested: the conversion functions would have no caller and the conformance rule would pass vacuously.
  The fake therefore stores thousandths and converts at its edge. **This is a property of a fake and not a
  claim about any acquirer**, and the real adapter will declare whatever its gateway actually uses.

- **`captured` is an absorbing state.** A captured intent can never be voided, never fails, and stays
  `captured` however much comes back, because refund fullness is an amount fact and not a state — that is
  what lets the table be asserted total over the enum product, which is Y-PAY-02's exhaustiveness test. The
  cost is that "absorbing" and "inert" are different words here, and the first test written for it expected
  `['failed', 'voided']` and was wrong about the table.

- **The two shipped adapters duplicate their intent map and their balance arithmetic.** A shared invariant
  kernel would mean the conformance suite ran one implementation twice and reported it as two passes, which
  is the vacuity the suite exists against. What IS shared is the port's argument guards in
  `@berelax/core/payments/guards.ts` — and they are shared because the saboteur deliberately does not call
  them, so each of those rules has been seen to fail.

- **No private SQLSTATE was allocated.** The band `ZY151`-`ZY160` issued to this unit is wholly unused:
  migration 0105 adds no rule that can be broken. The refusals this unit is about are TypeScript's, the
  conformance suite's and two dependency-cruiser rules'.
