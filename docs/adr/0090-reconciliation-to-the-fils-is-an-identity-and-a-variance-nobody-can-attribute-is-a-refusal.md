# ADR 0090 — reconciliation to the fils is an IDENTITY, and a variance nobody can attribute is a REFUSAL

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** Y-PAY-09
- **Covers:** docs/01 decisions — none. It stands on ADR 0007 (integer fils, the VAT-inclusive gross
  authoritative), ADR 0008 (append-only tables), ADR 0017 (the journal has no edit), ADR 0043 (a refusal
  is identified by all five characters of its SQLSTATE), ADR 0056 (only a gateway transaction may move a
  payment intent), ADR 0064 (a statement line is a directed sum over a partition of the chart, and the
  journal's own date has no key to `business_day`), ADR 0070 (an unattributable figure is a refusal, never
  a zero), ADR 0088 (the absence of a policy is a refusal) and ADR 0089 (a chargeback is a dated event
  posting to `1045`).

## Decision

**A settlement line either TIES to a figure this build already holds, or it is a NAMED variance. There
is no tolerance, there is nowhere in the schema or the module to add one, and a difference that belongs
to no line refuses the batch rather than being posted as a balancing figure.**

**A batch is POSTED — with a journal entry and no variance — or QUARANTINED — with at least one variance
and no journal entry. Never both, in either direction.** Migration 0136 raises `ZY441`–`ZY447`;
`packages/core/src/payments/settlement.ts` returns the four differences that must each be nought.

**And a settlement posts no revenue and no tips payable.** A payout is a cash movement: the sale was
recognised at its own tax point and the gratuity became a liability when the till took it.

## Why a tolerance is the dangerous parameter, not a convenience

An acquirer's file disagreeing with our records by a few fils is either a rounding difference somebody
has to explain or money that went somewhere. **Those two are the same number.** A tolerance of five fils
reconciles both, silently, on every batch, and what it leaves behind is a balance on `1030 Gateway
clearing` that grows by a little every payout and ties to nothing.

The error is invisible in the way that matters: the importer produces an entry that **balances**, because
the plug is on both sides of it. Debits equal credits, the trial balance is clean, every report adds up,
and the only evidence is a clearing account nobody looks at until a year-end.

This is ADR 0070's argument about a cost component, one subject along. A zero substituted for an unknown
cost reports the highest possible margin and is indistinguishable from a cost that was genuinely nil; a
difference absorbed by a tolerance is indistinguishable from no difference. So the identity is stated
twice — as four figures in `@berelax/core` that must each be nought, and as `ZY442` in SQL — with the
pairing check shipping in the same commit, because the second statement of a fact drifts.

`ZY447` is the same rule from the other side: a variance row claiming a difference of **nought** fils is
refused, because that is the shape a tolerance takes when somebody writes one — the difference recorded,
and the batch treated as reconciled anyway.

## Why posted and quarantined are exclusive

The tempting shape is one batch, an entry, and variance rows beside it: *posted, with exceptions*. It is
refused on one ground, and it is the ground that generalises. **A batch with a journal entry is a batch
the bank reconciliation treats as answered**, and a variance row beside it is a note nobody is obliged to
read. The exception then lives in a table while the money has been accounted for, which is the state the
whole unit exists to prevent.

So `ZY443` is a biconditional, checked in both directions: a posted batch has an entry and no variance; a
quarantined batch has a variance and no entry. And `ZY446` requires the quarantined batch's `audit_event`
to have been written in the **same transaction** — 0093 `ZZ004`'s argument, and what makes the acceptance
line "quarantined and ALERTED rather than force-matched" a database fact. An audit row written afterwards
in a second transaction is not the same guarantee: the quarantine can commit and the alert can fail, and
the only evidence that a payout went unmatched would be the payout.

**Nothing is force-matched.** A line whose reference answers to nothing is `no_local_record` and
quarantines. The alternative — match it to the nearest payment of the same amount — posts perfectly and
reconciles against the wrong invoice for ever.

## Why a settlement posts no revenue, and why the TIP is tied rather than posted

Two acceptance lines are the same claim read from two directions: a capture settling two days later must
not move revenue between business days, and a card tip must reach a liability and never revenue. Both
hold because **the settlement entry touches `1020`, `1030`, `6080` and the two reverse-charge accounts
and nothing else**. `assertNoRevenueOrTipPosting` reads the chart rather than a list of codes, so an
account added to the revenue group is covered the day it is added.

The tip is the line worth explaining, because the obvious implementation double-counts. The till already
debited the clearing account for the **whole** card tender — invoice gross plus gratuity — and credited
`2040 Tips payable` with the gratuity (`packages/core/src/checkout/posting.ts`). A settlement that
credited `2040` again would record one obligation twice, and the second copy would be indistinguishable
from a tip nobody had posted. So the tip line's job here is the **tie**:
`SETTLEMENT_LINE_TIE_ACCOUNT.tip` is `2040`, `ZY445` holds every line to the account its kind declares,
and the money itself is released from the clearing account along with the capture it arrived inside.

That is a deviation from the acceptance line's wording — *"the card tip posts to a tips-payable
liability"* — and it is recorded as one in the manifest. The posting the line asks for exists and is the
till's; what a settlement can add is the **proof** that the figure the acquirer paid over for the
gratuity is the figure the liability holds, to the fils. A second posting would be the defect.

A chargeback line is likewise released from `1030` and **not** from `1045 Disputed card receipts`, which
reads backwards until you follow the money: ADR 0089's received entry has already moved the amount out of
`1030` and into `1045`, so the clearing balance this batch pays over is already net of it, and `1045` is
discharged by the dispute's own resolution. Crediting it here would unwind the claim the moment the
acquirer took the money — the one thing that partition is total in order to prevent.

## What the tip's figure is read from, and the case it cannot answer

`employee_tip` is keyed on employee, trading date and cash session and carries no payment and no intent,
so "the tip on this gateway capture" cannot be looked up. It does not have to be: `invoice_payable_fils()`
(migration 0068) is already `invoice.gross_total` **plus** *"the gratuity this document's own posting
collected … read from the entry rather than carried in a second column, so the two cannot disagree"*. So
the figure a tip line is checked against **is** the credit to `2040` on the invoice's own checkout entry,
reached through `payment.reference` — which `TENDER_TYPES.card_online` already says is the gateway's
intent id, *"and a `card_online` payment without one cannot be tied to a payout line, a webhook or a
dispute"*.

Three cases, and the third is the cost:

- one tender on the invoice — the whole gratuity rode in on the card, exact;
- several tenders and no gratuity on the ticket — a measured nought;
- several tenders and a gratuity among them — **the apportionment between tenders is recorded nowhere**,
  so the figure is null and the line quarantines. Not apportioned pro rata: that is a policy decision
  disguised as a calculation, and ADR 0070 refused the same arithmetic for a cost component.

## Nothing here invents a figure

No fee rate, no interchange figure, no MCC, no gateway name and no settlement delay
(OPEN-QUESTIONS `Y7-gateway`, `Y7-mcc`, `Y7-card-fee`). **The fee is whatever the file says it is**, and
the only claim made about it is `ZY442`: a fee inflated by one fils makes the lines disagree with the
declared net and refuses the batch. `ZY444` requires a fee line to tie to **nothing at all**, in both
directions, because a local figure for one could only have come from a rate this build invented (brief
rule 15). An "expected fee" computed from a rate would feed a check that failed on every real batch or
passed on every wrong one.

The settlement **date** is the same: `settled_on` arrives on the file, `journal_entry.entry_date` is that
date, and nothing anywhere derives one date from the other. `settled_on` deliberately has no key to
`business_day` — a payout lands on days the premises were shut, which is `journal_entry.entry_date`'s own
decision (ADR 0064) — while `chargeback.trading_date` does carry one, because a dispute notice belongs in
a day's card totals and a bank movement belongs to no session.

## What this costs

- **There is no real settlement file and there cannot be one, so every test runs against a fixture whose
  provenance is written down.** `apps/worker/src/jobs/settlement-import.itest.ts` builds a till ticket the
  way the till builds one — an invoice, a `checkout_finalisation` entry crediting `2040`, one
  `card_online` payment whose reference is the gateway intent id, a real refund transaction and a real
  `chargeback` row — and then writes the payout file an acquirer *would* have sent for it. The fee is a
  stated figure, the processor is a `supplier` row carrying `SUPPLIER_FIXTURE_PREFIX`, and the settlement
  date is a second constant rather than a derivation.
- **The import is a queue with no cron, and therefore no `agent_definition`.** An import is announced by
  the file that arrived; a schedule would be a poller looking for work an enqueue already named
  (W-SYS-05's argument). Y-PAY-05's reconciliation job is the one with a cron and brings its own agent row.
- **`declared_net_fils` and `lines_net_fils` are signed `bigint` rather than the `fils_nonneg` domain**,
  because an acquirer bills the business in a period whose chargebacks exceed its captures. A
  non-negative column would have made that batch unrecordable, or recordable with the sign dropped —
  which posts the same figure the other way round and balances.
- **A fee whose processor is not named is quarantined, not posted at a guessed treatment.** A `supplier`
  row with no `supplier_tax_profile` cannot exist at all (0039's own deferred trigger), so the reachable
  absence is an import that names no supplier — and defaulting it to domestic drops the reverse charge on
  every offshore batch while the return still balances, which is why docs/04 §4 calls that the obligation
  most commonly missed at this size.
- **The admin settlement screen named in the manifest is not built**, and the reconciliation report it
  would render is `readSettlementVariances` plus the batch rows. Reasons, stated rather than implied:
  there is no `(admin)/money` section in this tree at all, so the page would be a new admin area with its
  route-registry entry, its guard and its navigation — and none of the five acceptance lines needs a
  screen ("the report names the offending line" is satisfied by the variance rows, which carry the line
  number, both figures and the explanation an operator reads). It is handed on in the manifest.
