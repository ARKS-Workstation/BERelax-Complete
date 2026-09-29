-- 0105 — the gateway's tender type: the fourth row in a registry built for it, and nothing else.
--
-- Y-PAY-01. This file creates no table, no column, no constraint, no function and no SQLSTATE. It inserts
-- ONE row into `tender_type`, and the whole of its argument is that 0068 already decided what that row
-- would look like. That migration's `adapter` column carries the closed set `('manual', 'gateway')` and
-- the note: "All three are `manual` today, which is the honest answer: the gateway does not exist. This is
-- the column Y-PAY's types will differ on." 0018 seeded account `1030 Payment gateway clearing` in the
-- same anticipatory spirit and nothing has debited it since.
--
-- So there is no new mechanism here. What there is instead is the answer to a question the build could
-- otherwise have got wrong in a way that is expensive to undo: does an online card payment reuse the
-- tender vocabulary, or does the gateway port bring its own?
--
-- ## Why the vocabulary is reused rather than duplicated
--
-- The gateway port needs to say which instrument an intent is for. The tempting alternative is a
-- `PaymentMethod` enum on the port — 'cash' | 'card_terminal' | 'card_online', which is in fact what the
-- H02 provider fakes already carry — and it is tempting because it costs no migration. It is also a second
-- answer to "where does card money go": two enumerations, two spellings of the same three instruments, and
-- one posting-account map per enumeration. The first symptom of a disagreement between them is not a type
-- error. It is a bank reconciliation that is out by every gateway batch, found weeks later, with two
-- plausible sources.
--
-- `tender_type` is the registry the posting rule reads, `payment.posting_account_code` is snapshotted from
-- it, and `packages/fixtures/src/payment.itest.ts` holds it equal to `TENDER_ACCOUNT` in @berelax/core in
-- BOTH directions. Adding the kind here means the gateway port's instrument type IS `TenderKind`, there is
-- one map from instrument to account, and this row is what makes the equality hold — without it that test
-- fails on direction 1 the moment core declares the kind, which is the right way round for a registry
-- whose whole purpose is to be the single vocabulary.
--
-- ## Why 1030 and not 1040
--
-- Both are clearing accounts for card money that has not arrived, so one account for both looks tidy. It
-- cannot be reconciled, though, and that is the point of a clearing account: the terminal settles in
-- batches against a merchant statement, the gateway pays out on its own schedule net of processor fees
-- against a payout file, and Y-PAY-09 has to match each to the fils. A single account holding both streams
-- reconciles against neither statement on its own, and the residue after matching one is indistinguishable
-- from an error in the other.
--
-- ## What this row deliberately does NOT enable
--
-- Nothing can take a `card_online` tender yet, and that is structural rather than pending. `finaliseCheckout`
-- debits tender accounts directly against revenue in one transaction because the customer paid in full at
-- the counter; there is no gateway call in it and no path to one. The gateway adapters live in
-- `@berelax/payments`, are constructed only by that package's registry, and `PAYMENT_PROVIDER=real` is
-- refused outside production by `parseConfig` (ADR 0005) — so the only gateway any environment can reach
-- today is the H02 fake. The row exists so that the vocabulary, the posting account and the adapter name
-- are decided once, in the open, before eight units start writing against them.
--
-- No private SQLSTATE is allocated. The band `ZY151`-`ZY160` was issued to this unit and is left entirely
-- unused: this file adds no rule that can be broken, and ADR 0043's gate refuses a registry entry that no
-- migration raises. The refusals this unit is actually about are TypeScript's and the conformance suite's.

begin;

-- `on conflict do nothing` for 0018's reason: re-applying a migration must be safe, and this is the one
-- statement in the file. It is also the honest shape for a seed — a `card_online` row that already exists
-- was put there by this file on an earlier run, and there is nothing here that could legitimately differ.
insert into tender_type (
  code, label, posting_account_code, gives_change, requires_reference, settles_immediately,
  adapter, sort_order
) values
  -- 1030 Payment gateway clearing. `requires_reference` is the strongest of the four rows: the reference is
  -- the gateway's own intent id, and an online card payment without one cannot be tied to a payout line, a
  -- webhook or a dispute — the only three ways this money is ever heard about again. `gives_change` is
  -- false, so `tender_type_change_needs_immediate_settlement` is satisfied rather than skirted: a gateway
  -- authorises an amount, and a surplus on one is a mis-keyed figure, not a twenty-dirham note.
  ('card_online', 'Card — online', '1030', false, true, false, 'gateway', 4)
on conflict (code) do nothing;

commit;
