# ADR 0077 — a deposit is APPOINTMENT-SCOPED, and it is a liability until the treatment is delivered

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** Y-PAY-06
- **Covers:** docs/01 decisions — none; ADR 0021 already covers decision 19b (*"packages only"*, and *"a
  deposit is not a prepaid product"*) and this is the mechanism that makes that sentence enforceable rather
  than asserted. It stands on ADR 0007 (integer fils, the VAT-inclusive gross authoritative), ADR 0017 (the
  journal has no edit), ADR 0043 (a refusal is identified by all five characters of its SQLSTATE), ADR 0056
  (only a gateway transaction may move a payment intent), ADR 0057 (a liability that accumulates is recorded
  cumulatively and the balance is a view) and ADR 0064 (a statement line is a directed sum over a partition
  of the chart).

## Decision

**A deposit is money received against ONE appointment. It is credited to `2045 Customer deposits held` at
its whole gross, UNSPLIT, and it recognises no revenue and charges no output VAT until the invoice for that
appointment is issued. It is applied at checkout as a TENDER — `deposit_on_account`, debiting 2045 — and it
cannot be applied to a document that does not bill its own appointment, nor moved into a package.**

**And the VAT treatment is an open question, `Y11-vat-deposit`, which this unit opened. No rate is applied
to a deposit anywhere in this build.**

## Why the scope is the decision, and not a convention

The alternative is a payment on account: a balance held against a CUSTOMER, applicable to any invoice. It is
a smaller schema — no appointment column, no join through `invoice_appointment`, no trigger — and it is what
most till systems have.

It makes three questions unanswerable, and they are the three questions a deposit exists to answer.

- **What does a cancellation refund?** With a scope, all of this appointment's balance, and the appointment
  names itself. Without one, some share of a pooled balance, under a policy nobody has written, decided
  while a customer is on the telephone.
- **Which document released it?** With a scope, the one that bills the appointment — and `invoice_appointment`
  already holds *"an appointment appears on at most one issued document, ever"* (0063), so the answer is
  exact. Without one, whichever invoice the operator picked, which is a reconciliation that needs a person's
  memory.
- **What happens to a balance nobody comes back for?** With a scope, nothing: there is no balance that is not
  against an appointment, and an appointment is cancelled, delivered or refunded. Without one, it is
  breakage — a revenue-recognition event with a VAT consequence and an expiry policy, which is the third
  prepaid product docs/01 decision 19b declines.

So the scope is `ZY305` (an `applied` movement must name a document that bills its own appointment) and
`ZY306` (no entry may move 2045 against `2050`/`2055`), in the database, for every role. `assertDepositRedeemable`
in `@berelax/core` is the same pair in TypeScript. The TypeScript protects the one path that goes through it;
the triggers protect every path there is, including a `psql` prompt — which is 0018's reason for restating
the normal-balance rule as a CHECK, applied one subject along.

`ZY306` is deliberately on `journal_line` and not on this unit's own table, because the conversion decision
19b forbids writes no deposit movement at all. It is an entry debiting 2045 and crediting 2050. It balances,
it has a narrative, and it has quietly created a second deferred-revenue path on the same money under a
second answer to `Y11-vat-package`.

## Why `2045` is a new account and not `2050`

`2050 Deferred revenue — packages` has the right type, the right side and the right meaning in English:
customer money held before a supply. Reusing it costs no migration.

Decision 19b's own argument is why not. The reason 19b admits packages and nothing else is that *"one prepaid
product means one deferred-revenue path, one liability account, one migration artefact and one VAT
date-of-supply question to settle with the accountant."* The outstanding package liability is a FIGURE:
R-REP-05 reports it, H-MIG-03 reconciles it to a reconstruction workbook, and ADR 0071 records that its
per-session gross ties to 2050 by an algebraic identity. Putting deposits into that account makes one figure
answer two questions, and nothing on a `journal_line` row says which kind of money it was — so neither answer
is checkable afterwards and the error is permanent, because the journal has no edit (ADR 0017).

The classification is this build's and is marked as such: `chart_of_accounts` carries `Y8-coa` as its own
provisional marker precisely so an accountant reading the database can see that the chart is an assumption.
2045 rather than a code past 2090 so that it sits with the other liabilities for customer money — 2040 tips,
2050 packages, 2055 vouchers — which is where somebody looking for it will look.

**Consequence.** ADR 0064's partition rule means a new account is a new statement LINE or the balance sheet
stops being a partition of the chart — which is how this decision was found, by `statements.test.ts` refusing
to load. `customer_deposits` on the balance sheet and `movement_in_customer_deposits` in operating cash flow
are separate lines rather than folded into the deferred-revenue line, for exactly the reason the account is
separate: a reader who cannot see the two apart cannot check either against its own source.

## Why applying a deposit is a TENDER KIND

0105 settled this question's general form — *"reuse a word when it means the same thing, and do not reuse one
when it does not"* — so the question is what `payment` has to mean.

`payment` is one SETTLEMENT against an issued document. Three things in this schema read those rows and
nothing else: `ZT001`, the ceiling that stops a document being overpaid; `invoice_payable_fils`, the
outstanding figure a receivable is chased on; and `TenderPostingDisagrees` in `finaliseCheckout`, which holds
the tenders and the journal entry to one story. A deposit released outside that vocabulary would be a SECOND
answer to how much of a document is paid — and the first answer, the one every report reads, would say the
invoice was owed in full for ever.

So `deposit_on_account` is the fifth `tender_type`. It is the only one whose posting account is not an asset,
and that is the point rather than an oddity: every other kind debits an asset because money is arriving, and
this one debits a liability because a liability the business already recorded is being discharged. The
arithmetic in `checkoutPosting` is unchanged — it debits whatever account the kind names.

**Consequences, all three of which were found by a check rather than by review.**

- `packages/core/src/money/tender.test.ts` asserted that every tender kind posts to an account the chart
  types as `asset`. That was true of four collections and is not a rule anybody decided; it is now stated as
  the four plus this one named account, rather than relaxed to "asset or liability" — which would also accept
  a tender debiting `2040 Tips payable`, and a gratuity owed to a therapist settling a document is a worse
  defect than the one the assertion was written for.
- `createManualGateway`'s `serves` list is held equal to `tender_type.adapter = 'manual'` in both directions
  by `gateway-tender.itest.ts`, so the kind had to be added there too. A kind the till can offer and no
  gateway can take is what `NoGatewayServesInstrument` refuses.
- `gives_change` is `false` and it is load-bearing: `cash_session` selects the cash tenders by that column
  and never by the literal `'cash'` (0076), so a `true` here would add every deposit release to the expected
  drawer count and leave each cash-up short by it.

## Why the deposit is held UNSPLIT, and why that is an open question rather than a rate

A payment received before a supply can be a date of supply in its own right. Whether it is, is a tax-agent
question. `Y11-vat-package` asks it one subject along for a prepaid package and its provisional answer on file
is *"at redemption; deferred-revenue liability on sale"*.

This unit takes that answer's SHAPE and not its words, and opens **`Y11-vat-deposit`** for the difference. A
deposit is not a package: it has no balance, no expiry and no redemption schedule, and ADR 0057 records why
one column may not serve two questions — *"two figures that happen to be equal"* clear the Unconfirmed
Assumptions panel for an answer nobody gave.

So the liability is the whole gross, with no net and no VAT figure on the row at all, and `ZY303` refuses an
entry that recognises revenue or charges output VAT on a receipt or a refund. It is `ZG005`'s shape for
`package_sale`, deliberately, and it measures the TOTAL movement — debits plus credits — rather than the net,
because a posting that credited `4010` and debited the contra `4095` by the same figure nets to zero and has
recognised revenue on a deposit.

**The consequence is the one that makes it worth doing this way:** if the answer moves the date of supply to
the receipt, `ZY303`'s predicate changes and no table does. There is no net and no VAT figure on a deposit
row to have been wrong, so the correction is a new entry rather than a restatement of every deposit ever
taken. `vat201_box_mapping` carries 2045 as `out_of_scope` with 2050's own wording, and that is not the same
claim: the open question decides which ENTRY is posted, not whether an account holding money owed feeds a
box — 0078 records the identical separation for `ZG005`.

## The cumulative balance is the primitive, and the chain is checked

ADR 0057's decision, inherited: `deposit_movement` carries `held_before_fils` and `held_after_fils` on every
row — the whole liability either side of the movement — with `amount_fils` as its magnitude and the kind as
its direction. The per-row identity is a CHECK, because all three columns are on the row. `ZY304` is the part
a CHECK cannot see: `held_before_fils` must be the previous movement's `held_after_fils`, the sequence must be
contiguous, and the first movement must open at zero. Without it each row is internally consistent — 9,000
less 1,000 is 8,000 whatever came before — and the sequence says whatever anybody wrote.

Nothing here rounds, so there is no residue to accumulate and ADR 0057's original argument does not apply
directly. The shape is kept because it is what lets `applyDepositToInvoice` answer in terms of a BALANCE
rather than of a history, and because the live figure is then a view over rows nobody has edited
(`appointment_deposit_balance`) rather than a stored column with two answers to compare the day a customer
disputes one. An appointment with no movement is ABSENT from that view rather than zero: *"no deposit was ever
taken"* and *"a deposit was taken and returned"* are different facts and the second one has rows.

**Rejected: a `deposit` header row above the movements.** It is a second statement of a balance the movements
already determine, which is ADR 0057's rejection of a stored running balance, one subject along.

**Rejected: a `transferred` movement kind.** There is no appointment a deposit may move to, so the kind would
be a vocabulary with nothing allowed to write it — the member a later reader assumes is in use, which is
C-AUTO-04's argument and brief rule 15's shape for an enum.

## What is refunded on a cancellation, and what is not decided

`cancellationCharge()` in `packages/core/src/lifecycle/cancellation-policy.ts` answers zero for every input
and is, in its own words, *"the single seam a fee policy arrives through"*. `Y9-windows` is *"24h window; no
fee charged, flagged only"*. So a deposit is refunded IN FULL on either side of the window, and the
subtraction in `depositRefundOnCancellation` is real arithmetic over a figure that is currently zero rather
than a branch returning the balance — a branch would be a retention policy of "never", written where a later
reader would have to find it in order to change it.

The retention is CAPPED at the balance. That is not defensive clutter: an uncapped subtraction returns a
negative refund the day a fee exceeds a deposit, and a negative refund posts as money arriving from a
cancellation.

`inside_window` and `window_hours` are RECORDED on the refund row rather than re-derived. Y-PAY-07 owns the
no-show and late-cancellation fee path and needs the verdict that was actually made, not one recomputed from
two timestamps and a setting that has since moved. And the retained part is deliberately posted NOWHERE: today
it is always zero, and the day a fee exists it is revenue or other income under a classification nobody has
been asked for — crediting `4090` on this build's own reading would be a figure nobody approved landing in a
VAT box.

## Which services require a deposit, and how much, is not expressible here

`Y9-deposits` asks *"which services require a deposit, what percentage, and whether first-time clients
prepay"*. Nothing in the handover answers any of the three.

The module therefore ships DISABLED behind `payments.deposit_enabled` — `false`, OWNER_ONLY, audited, flagged
provisional against that id so it appears on the Unconfirmed Assumptions panel — and `payments.deposit_percent_bp`
is `0`, which is `build/manifest.yaml`'s own provisional value for this unit (*"no services enrolled, 0% of
gross"*) rather than a rate chosen here. `depositDueFils` REFUSES when the flag is off instead of answering
zero, because *"no deposit because the module is off"* and *"no deposit is due under the policy"* are different
facts and `Y9-commission` records what conflating them costs.

**There is no per-service enrolment table, and that is the decision.** The SHAPE of the answer is unknown as
well as the figure: a deposit could be a percentage of the service, a flat fee per booking, a first-time-customer
rule or a per-service enrolment, and a column for one of those is an invented policy the engine would then
apply to the wrong quantity. That is ADR 0057's argument for having no `cap_fils` column, and ADR 0066's for
leaving a carry-over policy unexpressible: answering this may need a unit rather than a value.

The one figure this unit does choose is a ROUNDING DIRECTION, and it is chosen down. Of the two available
errors only one is the business's to make: a fil too little costs the salon a fil, and a fil too much is money
taken from a customer that no agreed policy asked for. Nothing turns on it while the percentage is zero, and
it is written down so that the day a rate is agreed the direction is a decision somebody can disagree with
rather than an artefact of whichever helper was to hand.

## Consequences somebody will have to live with

- **A fifth tender kind is in four packages' literals.** `TENDER_KINDS` and `TENDER_ACCOUNT` in
  `packages/core/src/checkout/posting.ts`, `TENDER_TYPES` in `packages/core/src/money/tender.ts`, the
  `tender_type` row in migration 0124, and `SERVES` in `packages/payments/src/adapters/manual.ts`. Three
  checks hold them equal — `tender.test.ts` by typecheck, `payment.itest.ts` and `gateway-tender.itest.ts`
  in both directions against the database — so a sixth kind fails rather than drifts. That is the price of
  having one vocabulary for settlement instead of two.
- **`deposit_movement` is in the shared family teardown.** It references `invoice`, so `truncateInvoiceFamily`
  and `truncateDocumentFamily` both name it, and `invoice-family.itest.ts` derives the closure from
  `pg_constraint` and fails when a written list and the schema disagree. A future table pointing at
  `deposit_movement` has to be added there too.
- **The deposit's checkout wiring has nowhere to land yet.** Nothing in this build finalises a checkout
  through a route: `finaliseCheckout` is driven from `packages/fixtures`, the `/checkout` screen is Y-PAY-03's
  hosted-fields authorisation surface, and M-TILL-07's NOTE records that a partial tender at checkout is
  still refused. `apps/web/app/(admin)/checkout/apply-deposit.ts` is therefore the DECISION — what is due,
  what tender to present, which targets are refused — and the write that uses it arrives with the till
  screen. `build/manifest.yaml` carries the NOTE.
- **`appointment_deposit_balance` has no foreign key to `appointment`.** `invoice_appointment` carries the
  same decision for the same stated reason (0063): PostgreSQL refuses `truncate appointment` while a
  referencing table is absent from the statement, and four suites truncate it by list. The cost is that a
  deposit movement can outlive its appointment row in a test database; the alternative is four suites failing
  in teardown, after their assertions had passed, with a sentence about PostgreSQL rather than about the thing
  under test.
