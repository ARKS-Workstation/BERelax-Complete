# ADR 0089 — a reversal is a dated event, and the refund cap is THREE figures

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** Y-PAY-08
- **Covers:** docs/01 decisions — none. It stands on ADR 0007 (integer fils, the VAT-inclusive gross
  authoritative), ADR 0008 (append-only tables), ADR 0017 (the journal has no edit; corrections are dated
  reversals), ADR 0043 (a refusal is identified by all five characters of its SQLSTATE), ADR 0056
  (`payment_intent`'s exhaustive lifecycle, and only a gateway transaction may move it), ADR 0057 (a
  liability that accumulates is recorded cumulatively and the live figure is a view), ADR 0064 (a statement
  line is a directed sum over a partition of the chart), ADR 0070 (an unattributable figure is a refusal,
  never a zero) and ADR 0077 (a deposit refund is capped at the balance held, for the same reason as here).

## Decision

**A chargeback is a third party's decision arriving late, so it is recorded as a dated EVENT with its own
journal entry and never as an edit to the payment it is about. It posts to `1045 Disputed card receipts`
while the dispute is open, and a won dispute is the DATED REVERSAL of that entry, so the pair nets to
nought on that account to the fils.**

**And what remains refundable is `captured - refunded - chargedBackNet`: three figures, not two. The cap
is a DATABASE refusal (`ZY433`) and not a screen's validation.**

## Why a chargeback cannot be an edit

The obvious implementation is `payment_intent.captured_fils = captured_fils - disputed`. It is refused on
two independent grounds, and the second is the one that generalises.

Mechanically, `captured_fils` is a projection of the append-only `payment_intent_transaction` rows, held
equal to them at commit by `ZY163`. The subtraction cannot be written without also fabricating a
transaction row, which is a lie about a gateway event.

Substantively, **the capture happened.** Restating it would leave the sale's own journal entry explaining
money the header says was never taken, and nothing in the database would say which of the two had been
edited. The same argument is what `pnpm no-invoice-mutation` enforces one table along for `invoice` and
`credit_note`: an issued document is corrected by a credit note, never edited.

So a dispute is a `chargeback` row with its own `received_at`, its own `trading_date` and its own entry,
and the repository that writes it contains no write to `payment_intent` at all.

## Why a clearing account, and why the partition has to be total

At the moment a chargeback lands, the business has not lost the money — it has lost the use of it while
somebody else decides. Posting straight to an expense recognises a loss that may be reversed next month and
leaves nothing to reverse WITH when the dispute is won, so the win would have to be posted as income.
Posting nowhere leaves `1030 Gateway clearing` carrying money the acquirer has removed.

`1045` is therefore a new account, and deliberately not folded into `1030`/`1040`. A clearing balance is
money the business WILL receive; a disputed receipt is money it MAY receive. A reader of the balance sheet
who cannot see the two apart cannot check either against its own source, which is ADR 0064's argument for a
partition and ADR 0077's argument for `2045` one liability along. It gets its own balance-sheet line and
its own cash-flow line for the same reason.

`kind` is `{received, won, lost}` and `ZY434` keeps the partition total: a resolution with no received
event before it would credit a balance the account never held, and a second resolution would unwind it
twice and leave it negative. That is what makes `1045` a clearing account rather than a place figures
accumulate.

`ZY436` holds a won dispute's entry to being the reversal of its received entry, and the pair to nought on
`1045`. It is read over `journal_line` rather than by comparing the two amounts, because **two entries can
each balance perfectly while moving different amounts on one account** — which is the only way the identity
can fail. A hand-built mirror entry would be correct today and would be exactly where the two drifted the
day a partial resolution existed; `reverseEntry` in `@berelax/core` swaps the sides and leaves the absolute
fils untouched, so a reversal cannot round differently from its original.

## Why the refund cap is three figures

`payment_intent` carries `check (refunded_fils <= captured_fils)`. That check is satisfied by an intent
whose money an acquirer has already taken back: AED 100 captured, AED 100 charged back, nothing refunded —
and AED 100 still reads as refundable. The business refunds money it no longer has, and the figure
reconciles at both ends.

So the remainder is `captured - refunded - chargedBackNet`, stated once in `refundableFils` and once in
`ZY433`, and held equal by `packages/fixtures/src/chargeback.itest.ts`.

The trigger is attached to BOTH `chargeback` and `payment_intent`, because either side can break the
identity. **The second ordering is the one that matters and the one a rule on the refund path alone would
miss entirely:** a customer refunded in good faith who then disputes the original charge anyway. The
integration suite drives exactly that case.

Y-PAY-06 recorded the same mistake without a third party in it: an uncapped subtraction returns a NEGATIVE
refund the day a fee exceeds a deposit, which posts as money arriving from a cancellation. This is that
mistake with an acquirer in the middle.

An unresolved dispute and a LOST one count the same way, and a won one gives the money back. "We might get
it back" is not money the business can refund to somebody else in the meantime.

## Why the trading date is checked and not merely computed

Trading runs 11:00–02:00, so an acquirer's notice at 01:30 belongs to the PREVIOUS trading date. The caller
resolves it with `resolveTradingDate`; `ZY432` checks the answer against `business_day` in SQL, because the
two derivations are independent and the drift between them is invisible in every report. A notice
attributed to the calendar date lands in a cash-up for a session that had not started, and the two days'
card totals are then wrong by the same amount in opposite directions — an error that reconciles perfectly
at every level except the one it is wrong at.

A notice at an instant in no session is REFUSED rather than attributed to the nearest day. That is ADR
0070's reading and it is not a fallback: of the two available errors only one is detectable afterwards. A
refusal names the notice and stops the import; a substituted date reconciles against a day nothing happened
on. What a notice outside trading hours should belong to is a stated decision somebody has to make, not one
a trigger makes quietly.

## The consequences somebody will have to live with

**Two deferred triggers, and a probe that cannot use a savepoint.** `ZY433` and `ZY436` are
`deferrable initially deferred`, so they fire at COMMIT — a probe inside a savepoint that is rolled back
never reaches either, because the rollback discards the pending check. Every case for those two runs
inside a real transaction. It cost the suite a run before it was written down, and it will cost the next
unit one if that unit copies a savepoint-based probe.

**The journal is never emptied, so this unit's suite leaves entries behind.** Nothing truncates the
journal (ADR 0017, and 0078 says so where it makes `package_sale.journal_entry_id` a real key). Every
assertion in `chargeback.itest.ts` is therefore scoped to its own entry ids and reads `1045` per entry
rather than as an account balance — which is the shape the brief's own three recorded cases of
cross-suite interference ask for.

**A chargeback adds no member to `payment_intent`'s lifecycle.** ADR 0056's state table is exhaustive and
this unit did not widen it. A dispute is not a gateway movement of the intent: the intent's own history
says what the gateway did to the money, and the dispute says what happened to the money afterwards. The
cost is that a reader of the intent alone cannot see that it was disputed, and the remedy is
`chargeback_position`, which is a join rather than a column.

**`refundableFils` and `assertRefundPermitted` are NOT `assertRefundable`,** which already exists in
`state.ts` and does the narrower job over an intent's own amounts. Two functions and not one: the narrow
one is what the gateway port's caller needs before it asks for a refund, and the wide one is what the
ledger needs before it posts one — and the wide one cannot live in `state.ts`, which knows nothing about
disputes. Anyone adding a third dimension to the cap has to change the wide one and `ZY433` in the same
commit.

**The ingest path is not here.** A chargeback arrives by webhook, and Y-PAY-04 (signature verification,
replay protection, idempotent handlers) is not built. `isChargebackRedelivery` and the
`(dispute_ref, kind)` unique constraint are the properties that handler will need — a redelivery is a
named refusal it can answer 200 to rather than a bare `23505` it cannot tell from the intent's own
idempotency key — but nothing routes a notice into this table yet.
