-- 0124 — the deposit: money received against ONE appointment, held as a liability until it is delivered.
--
-- Y-PAY-06. One account, one tender type, one append-only table and six refusals. ADR 0077 is the decision
-- and `packages/core/src/payments/deposit.ts` is the arithmetic. What this file is for is the half of that
-- arithmetic a `psql` prompt can reach.
--
-- ## 1. Why `2045 Customer deposits held` is a NEW account and not `2050`
--
-- docs/03 §7: *"A deposit is a liability."* So the money is credited somewhere, and `2050 Deferred revenue
-- — packages` is the near-enough code sitting right there with the right type and the right side.
--
-- It is the wrong one, and docs/01 decision 19b says why in its own words: a deposit *"is not a prepaid
-- product — it is a part-payment against one specific booking, with no balance, no expiry and no redemption
-- schedule, so it does not reintroduce a second deferred-revenue path"*. The whole reason 19b admits
-- packages and nothing else is that *"one prepaid product means one deferred-revenue path, one liability
-- account, one migration artefact and one VAT date-of-supply question to settle with the accountant"*.
-- Posting a deposit to 2050 would put a second kind of money into that one figure — the outstanding
-- package liability R-REP-05 reports and H-MIG-03 reconciles to a reconstruction workbook — and neither
-- figure would be checkable afterwards, because nothing on a `journal_line` says which kind it was.
--
-- The classification is [UNVERIFIED], like every other row in this chart: `chart_of_accounts` carries
-- `Y8-coa` as its own provisional marker (0018) precisely so that an accountant reading the database can
-- see the classification is an assumption. 2045 and not a code past 2090 so that it sits with the other
-- liabilities for customer money — 2040 tips, 2050 packages, 2055 vouchers — which is where somebody
-- looking for it will look. `vat_box` is NULL, and null is a DECISION here rather than a gap: see §3.
--
-- The chart is GENERATED from `STANDARD_SPA_CHART` in `packages/core/src/ledger/chart-of-accounts.ts` and
-- `packages/fixtures/src/ledger-chart.itest.ts` compares every field of every account in both directions,
-- so this INSERT and that constant cannot drift.
--
-- ## 2. Why applying a deposit is a TENDER KIND and not a mechanism of its own
--
-- `tender_type` is the registry of ways the business takes money, and a deposit release takes none: the
-- money arrived earlier, as cash, a transfer or a `card_online` authorisation. 0105's rule for this exact
-- decision is *"reuse a word when it means the same thing, and do not reuse one when it does not"*, so the
-- question is what the word has to mean.
--
-- `payment` is "one SETTLEMENT against an issued document". Three things in this schema read those rows and
-- nothing else: `ZT001`, the ceiling that stops a document being overpaid; `invoice_payable_fils`, the
-- outstanding figure a receivable is chased on; and `TenderPostingDisagrees` in `finaliseCheckout`, which
-- holds the tenders and the journal entry to one story. A deposit released outside that vocabulary would be
-- a second answer to how much of a document is paid — and the first answer, the one every report reads,
-- would say the invoice is owed in full for ever.
--
-- So `deposit_on_account` is a fifth `tender_type`, debiting 2045. It is the only row whose posting account
-- is not an asset, and that is the point rather than an oddity: every other kind debits an asset because
-- money is arriving, and this one debits a liability because a liability the business already recorded is
-- being discharged. `gives_change` is false and is load-bearing — `cash_session` selects the cash tenders
-- by that column and never by the literal `'cash'` (0076), so a true here would add a deposit release to
-- every expected drawer count and leave each cash-up short by it.
--
-- `adapter` is `manual`: a person at the till applies it, and `ZY165` already refuses a `payment_intent`
-- whose instrument is not a `gateway` kind — which is what stops a deposit RELEASE being presented to a
-- gateway as a second authorisation of money that has already been taken.
--
-- ## 3. The VAT treatment is an OPEN QUESTION and no rate is applied here
--
-- A payment received before a supply can be a date of supply in its own right. Whether it is, is a
-- tax-agent question, and it is **`Y11-vat-deposit`** in docs/OPEN-QUESTIONS.md — opened by this unit,
-- cross-referencing `Y11-vat-package`, which asks the same thing one subject along for a prepaid package
-- and whose provisional answer on file is *"at redemption; deferred-revenue liability on sale"*.
--
-- This unit takes that answer's SHAPE and not its words: the deposit is held at its whole gross, UNSPLIT,
-- and the invoice carries the entire net/VAT split when the treatment is delivered. Holding it unsplit is
-- what makes the other answer a new entry rather than a restatement — there is no net and no VAT figure on
-- a deposit row to have been wrong. `ZY303` is that reading as a refusal: a receipt or a refund may move
-- nothing on any revenue account and nothing on `2030 Output VAT payable`. It is `ZG005`'s shape for
-- `package_sale`, deliberately, and it measures the TOTAL movement — debits plus credits — rather than the
-- net, because a posting that credited `4010` and debited the contra `4095` by the same figure nets to zero
-- and has recognised revenue on a deposit.
--
-- If the answer moves the date of supply to the receipt, `ZY303`'s predicate changes and no table does.
--
-- ## 4. The cumulative balance is the primitive (ADR 0057), and the chain is checked
--
-- `deposit_movement` carries `held_before_fils` and `held_after_fils` on every row: the WHOLE liability
-- either side of the movement, with `amount_fils` as its magnitude. ADR 0057 argues the direction — the
-- cumulative figure is the quantity and a movement is its difference — and the per-row identity is a CHECK
-- rather than a trigger because all three columns are on the row. `ZY304` is the part a CHECK cannot see:
-- `held_before_fils` must be the PREVIOUS row's `held_after_fils`, and the first movement must start from
-- zero. Without it each row is internally consistent and the sequence says whatever anybody wrote.
--
-- The balance itself is the VIEW `appointment_deposit_balance` and not a stored column on `appointment`,
-- which is ADR 0057's rejection of a stored running balance: a second statement of a sum the rows already
-- make, with two answers to compare the day a customer disputes one.
--
-- ## 5. Appointment-scoped, which is two refusals and not a convention
--
--   * **`ZY305`** — an `applied` movement must name a document that bills THIS appointment. The join is
--     `invoice_appointment`, which already holds "an appointment appears on at most one issued document,
--     ever" (0063), so the refusal is exact rather than approximate.
--   * **`ZY306`** — no journal entry may move `2045` and `2050`/`2055` at once, in either direction. This
--     is the conversion decision 19b forbids, refused where it would actually happen: a deposit "becoming
--     a package" is an entry debiting 2045 and crediting 2050, and nothing about such an entry looks
--     wrong — it balances, it has a narrative, and it has quietly created a second deferred-revenue path
--     on the same money under a second answer to Y11-vat-package.
--
-- Both are also TypeScript refusals in `assertDepositRedeemable`. The TypeScript protects the one path that
-- goes through it; the triggers protect every path there is.
--
-- ## 6. What is deliberately NOT here
--
-- **No foreign key to `appointment`.** `invoice_appointment.appointment_id` has none for a stated reason
-- (0063): PostgreSQL refuses `truncate appointment` while a referencing table is absent from the statement,
-- and four suites truncate it by list. A key here would break all four, in teardown, after their
-- assertions had passed — which is the least useful place in a run for that sentence to appear. The column
-- is indexed and the view groups on it; what a key would add is a guarantee that the four suites cannot
-- afford.
--
-- **No `transferred` movement kind, and no `deposit` table above the movements.** There is no appointment a
-- deposit may move to, so a kind for it would be a vocabulary with nothing allowed to write it — which is
-- the member a later reader assumes is in use (brief rule 15's shape for an enum). And a header row would
-- be a second place to record a balance the movements already determine.
--
-- **No percentage, no per-service enrolment and no rule table.** `Y9-deposits` asks *which* services
-- require a deposit and at *what* percentage, and nothing in the handover answers either. The module ships
-- DISABLED behind `payments.deposit_enabled` (false, OWNER_ONLY, flagged provisional against that id, so it
-- is on the Unconfirmed Assumptions panel) and `payments.deposit_percent_bp` is 0 — which is
-- `build/manifest.yaml`'s own provisional value for this unit, *"no services enrolled, 0% of gross"*, and
-- not a rate this build chose. There is no enrolment TABLE because the SHAPE of the answer is unknown as
-- well as the figure: a deposit could be a percentage of the service, a flat fee, a first-time-customer
-- rule or a per-service enrolment, and a column for one of those is an invented policy the engine would
-- apply to the wrong quantity. That is ADR 0057's argument for having no `cap_fils` column, one subject
-- along, and ADR 0066's for leaving a carry-over policy unexpressible.
--
-- **No refund of a late cancellation's fee, and no retention posting.** `cancellationCharge()` in
-- `packages/core/src/lifecycle/cancellation-policy.ts` answers zero for every input and is, in its own
-- words, *"the single seam a fee policy arrives through"*. `Y9-windows`: *"24h window; no fee charged,
-- flagged only"*. So a deposit is refunded in full on either side of the window, the subtraction is real
-- arithmetic over a figure that is currently zero, and `inside_window` is RECORDED on the refund row so
-- Y-PAY-07 — which owns the no-show and late-cancellation fee path — reads a fact rather than re-deriving
-- it from two timestamps and a setting that may have moved since.
--
-- ---------------------------------------------------------------------------------------------
-- Six private SQLSTATEs, `ZY301`-`ZY306`, of the band `ZY301`-`ZY310` issued to this unit. Allocated
-- through `packages/db/src/sqlstate-registry.ts` and not by reading the migrations a worktree can see
-- (ADR 0043). `ZY307`-`ZY310` are unused and are NOT registered: an entry for a code no migration raises is
-- what direction 3 of that gate refuses, and that is the direction which lets the registry shrink.
--
--   ZY301  a deposit_movement row was UPDATEd or DELETEd
--   ZY302  a movement's journal entry does not move 2045 by exactly this movement, in its direction
--   ZY303  a deposit receipt or refund recognised revenue or charged output VAT
--   ZY304  a movement's opening balance is not the previous movement's closing balance
--   ZY305  an applied movement names a document that does not bill its appointment
--   ZY306  a journal entry moved the deposit account against package or voucher deferred revenue
-- ---------------------------------------------------------------------------------------------

begin;

-- ------------------------------------------------------------------------------------------------
-- 2045 Customer deposits held
-- ------------------------------------------------------------------------------------------------

-- GENERATED from STANDARD_SPA_CHART in packages/core/src/ledger/chart-of-accounts.ts, not retyped;
-- `on conflict do nothing` so re-applying is safe (0018's shape).
insert into account (chart_id, code, name, type, normal_balance, contra, vat_box, input_vat_recoverable)
values ('standard-spa-uae', '2045', 'Customer deposits held', 'liability', 'credit', false, null, false)
on conflict (code) do nothing;

-- Every account carries exactly one `vat201_box_mapping` row or `ZY009` refuses the transaction, and this
-- one is `out_of_scope` with `2050 Deferred revenue — packages`'s own wording: a balance-sheet liability is
-- not a supply, whichever end of the transaction the supply turns out to be at.
--
-- That is not the same claim as §3's. `Y11-vat-deposit` decides whether the RECEIPT is a date of supply,
-- and the answer changes which ENTRY is posted — whether 2030 is credited when the money arrives — not
-- whether an account holding money owed feeds a box. 0078 records the identical separation for the
-- identical reason: *"if the answer moves it to the sale, ZG005's predicate changes and no table does."*
-- An `unallocated` row here would put a figure with nowhere to go on the working papers and make the
-- return unfileable over a question about a different account's entry.
--
-- `open_question_id` is therefore null, and the constraint requires it to be: an allocated row carrying a
-- question id would keep a settled account on the Unconfirmed Assumptions panel for ever (0089).
insert into vat201_box_mapping (account_code, disposition, box_no, measure, contribution, note)
values ('2045', 'out_of_scope', null, null, null,
        'Feeds no VAT201 box. A balance-sheet liability: what is owed is not a supply. Whether receiving '
        'a deposit is itself a date of supply is Y11-vat-deposit, open, and answering it changes the '
        'entry posted when the money arrives rather than this attribution.')
on conflict (account_code) do nothing;

-- `2045` appears in exactly one place in SQL that a caller can read, so the pair with
-- `ACCOUNTS.customerDepositsHeld` in @berelax/core can be asserted in ONE assertion rather than wherever
-- the literal happened to be typed. `tips_payable_account_code()` (0068) is the same arrangement one
-- account along, and `packages/fixtures/src/deposit.itest.ts` makes the assertion with a control proving
-- it would notice a disagreement.
create function customer_deposit_account_code() returns text
  language sql immutable parallel safe
  as $$ select '2045'::text $$;

comment on function customer_deposit_account_code() is
  'The account a deposit is credited to while the treatment it pays for is undelivered. Stated once so '
  'the ZY302/ZY303/ZY306 predicates and @berelax/core''s ACCOUNTS.customerDepositsHeld can be compared '
  'in one place (packages/fixtures/src/deposit.itest.ts).';

-- ------------------------------------------------------------------------------------------------
-- the fifth tender type: how a deposit already held settles a document
-- ------------------------------------------------------------------------------------------------

insert into tender_type (
  code, label, posting_account_code, gives_change, requires_reference, settles_immediately,
  adapter, sort_order
) values
  -- `gives_change` false: see §2 — a true here lands a deposit release in every expected drawer count.
  -- `requires_reference` true for `card_online`'s reason: the reference is the movement this release
  -- discharges, and a release naming nothing could not be tied back to the appointment whose money it was.
  -- `settles_immediately` true because the money IS in hand; false would be the claim that it is still to
  -- arrive, which is the opposite of what a deposit is.
  ('deposit_on_account', 'Deposit already paid', '2045', false, true, true, 'manual', 5)
on conflict (code) do nothing;

-- ------------------------------------------------------------------------------------------------
-- deposit_movement — the liability, as the differences that made it
-- ------------------------------------------------------------------------------------------------

create table deposit_movement (
  id                uuid        primary key default uuid_generate_v7(),
  -- Plain uuid, NO foreign key. See §6: `truncate appointment` would break in four suites.
  appointment_id    uuid        not null,
  -- Position in this appointment's own history, from 1. Unique with the appointment, so two movements
  -- cannot occupy one position and leave the order to whatever the planner returned (0063's reason for
  -- payment.tender_no, and here it is load-bearing rather than cosmetic: ZY304 walks this sequence).
  seq               integer     not null
                      constraint deposit_movement_seq_positive check (seq >= 1),
  kind              text        not null
                      constraint deposit_movement_kind_known
                      check (kind in ('received', 'applied', 'refunded')),
  -- The WHOLE liability either side of this movement (ADR 0057), with the magnitude beside it. The
  -- direction is the KIND and never the sign of a column, for 0018's reason: a negative credit and a
  -- positive debit both balance while only one of them is what the poster meant.
  held_before_fils  fils_nonneg not null,
  held_after_fils   fils_nonneg not null,
  amount_fils       fils_nonneg not null
                      constraint deposit_movement_amount_positive check (amount_fils > 0),
  -- MANDATORY and a real foreign key. Money moving with no entry behind it is the state that makes the
  -- 2045 balance unexplainable, and nothing truncates the journal, so the key costs nothing (0078's
  -- argument for package_sale.journal_entry_id).
  journal_entry_id  text        not null references journal_entry (entry_id),
  -- The document this movement settled. Required for `applied` and refused for the other two, because a
  -- receipt happens before there is a document and a refund happens because there will not be one.
  invoice_id        uuid        references invoice (id),
  -- How the money arrived or left. NULL for `applied`: no money moves at an application — a liability is
  -- discharged against a document, and a tender kind there would read as a second collection.
  tender_kind       text        references tender_type (code),
  -- The gateway intent the money came in on, when it came in on one. 0106 says an intent "is authorised
  -- before there is a document (a deposit on a booking)", which is this row.
  payment_intent_id uuid        references payment_intent (id),
  -- The BUSINESS DAY, resolved by the caller. Trading runs 11:00-02:00, so a 01:30 deposit belongs to the
  -- previous trading date and the cash-up that reconciles it cuts here.
  trading_date      date        not null,
  -- Recorded only on a refund: whether the cancellation arrived inside the window, and the window that
  -- judged it. Y-PAY-07 reads these rather than re-deriving them; see §6.
  inside_window     boolean,
  window_hours      smallint
                      constraint deposit_movement_window_bounded
                      check (window_hours is null or window_hours between 0 and 168),
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),

  constraint deposit_movement_one_row_per_position unique (appointment_id, seq),

  -- ADR 0057's identity, per row. A receipt adds to the liability and the other two discharge it, and
  -- the closing balance is the opening balance moved by exactly the amount — so a row cannot claim a
  -- movement of one figure and a balance change of another.
  constraint deposit_movement_balance_moves_by_its_amount check (
    held_after_fils = case when kind = 'received'
                           then held_before_fils + amount_fils
                           else held_before_fils - amount_fils end
  ),
  -- An application or a refund may not discharge more than is held. `fils_nonneg` on
  -- `held_after_fils` would catch it with a domain violation naming no constraint a caller could
  -- recognise (0068 measured exactly that on payment.applied_fils), so the named rule is the authority.
  constraint deposit_movement_cannot_overdraw check (
    kind = 'received' or amount_fils <= held_before_fils
  ),
  -- A document for an application and no document otherwise.
  constraint deposit_movement_applied_names_its_document check (
    (invoice_id is not null) = (kind = 'applied')
  ),
  -- Money moves on a receipt and on a refund, and nowhere else.
  constraint deposit_movement_money_moves_only_in_or_out check (
    (tender_kind is not null) = (kind in ('received', 'refunded'))
  ),
  -- A deposit received "as a deposit" would debit 2045 and credit 2045: the liability unchanged, the row
  -- written, and the money never collected at all.
  constraint deposit_movement_is_not_tendered_as_itself check (
    tender_kind is null or tender_kind <> 'deposit_on_account'
  ),
  -- An intent is a gateway's record of a collection, so it belongs only where a collection happened.
  constraint deposit_movement_intent_needs_a_tender check (
    payment_intent_id is null or tender_kind is not null
  ),
  -- Both window columns or neither, and only on a refund. Half a verdict is the shape that survives a
  -- review as "already answered" (0018's argument for the provisional pair).
  constraint deposit_movement_window_is_a_refund_verdict check (
    (inside_window is null) = (kind <> 'refunded')
    and (window_hours is null) = (kind <> 'refunded')
  )
);

comment on table deposit_movement is
  'Every movement of the deposit liability held against one appointment, in order. Append-only: UPDATE '
  'and DELETE raise (ZY301), for every role including the owner, because the rows ARE the liability and '
  'a figure that is wrong is a NEW movement. The balance is the view appointment_deposit_balance and not '
  'a stored column, which is ADR 0057''s rejection of a second statement of a sum the rows already make.';
comment on column deposit_movement.appointment_id is
  'The ONE appointment this money was taken for. No foreign key, deliberately: PostgreSQL refuses '
  '`truncate appointment` while a referencing table is absent from the statement and four suites '
  'truncate it by list (0055, 0058, 0021, 0024) - invoice_appointment.appointment_id carries the same '
  'decision for the same reason.';
comment on column deposit_movement.held_after_fils is
  'The WHOLE liability held against this appointment after this movement (ADR 0057). ZY304 holds it to '
  'the next row''s opening balance, so the sequence cannot say whatever anybody wrote.';
comment on column deposit_movement.tender_kind is
  'How the money arrived or left. NULL for an application: no money moves when a liability is '
  'discharged against a document, and a tender kind there would read as a second collection.';
comment on column deposit_movement.inside_window is
  'Whether the cancellation that produced this refund arrived inside the cancellation window. Recorded '
  'rather than re-derived: Y-PAY-07 owns the fee path and needs the verdict that was actually made, not '
  'one recomputed from two timestamps and a setting that has since moved. [UNVERIFIED] Y9-windows.';

create index deposit_movement_appointment_idx on deposit_movement (appointment_id, seq desc);
create index deposit_movement_trading_date_idx on deposit_movement (trading_date, kind);
create index deposit_movement_invoice_idx on deposit_movement (invoice_id) where invoice_id is not null;
create unique index deposit_movement_one_row_per_entry on deposit_movement (journal_entry_id);

revoke update, delete, truncate on deposit_movement from berelax_app;

-- ------------------------------------------------------------------------------------------------
-- appointment_deposit_balance — the liability, as a sum over rows nobody has edited
-- ------------------------------------------------------------------------------------------------

-- ADR 0057's shape: the live figure is a VIEW over the movements, not a column somebody has to remember
-- to update. `employee_gratuity_liability` is the same decision one subject along.
--
-- `distinct on` rather than a `max(seq)` subquery so the planner reads the (appointment_id, seq desc)
-- index once instead of twice. The balance is the LAST row's closing figure and not a sum of movements,
-- because ZY304 already holds the chain together: re-adding the differences would be a second derivation
-- of a figure the rows state, which is the drift this whole file is arranged against.
create view appointment_deposit_balance as
select distinct on (m.appointment_id)
       m.appointment_id,
       m.held_after_fils as held_fils,
       m.seq             as movements,
       m.kind            as last_movement,
       m.occurred_at     as as_of
  from deposit_movement m
 order by m.appointment_id, m.seq desc;

comment on view appointment_deposit_balance is
  'The deposit liability currently held against each appointment, from the last movement''s closing '
  'balance. An appointment with no movement is ABSENT rather than zero: "no deposit was ever taken" and '
  '"a deposit was taken and returned" are different facts and the second one has rows.';

grant select on appointment_deposit_balance to berelax_app;

-- ------------------------------------------------------------------------------------------------
-- ZY301 — a movement row is append-only
-- ------------------------------------------------------------------------------------------------

create function refuse_deposit_movement_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'DepositMovementIsAppendOnly: % on deposit_movement is refused. These rows ARE the liability held '
    'against an appointment, and each one names the journal entry that moved it - editing one would '
    'restate a balance the ledger has already explained, and deleting one would leave the entry with '
    'nothing it moved. A figure that is wrong is a NEW movement.',
    tg_op
    using errcode = 'ZY301';
end $$;

comment on function refuse_deposit_movement_change() is
  'Raises ZY301 for every UPDATE and DELETE on deposit_movement, for EVERY role including the owner. '
  'The remedy is always a new movement, never an edit.';

create trigger deposit_movement_no_update before update on deposit_movement
  for each row execute function refuse_deposit_movement_change();
create trigger deposit_movement_no_delete before delete on deposit_movement
  for each row execute function refuse_deposit_movement_change();

-- ------------------------------------------------------------------------------------------------
-- ZY302 / ZY303 — the entry IS the movement, and a deposit recognises nothing
-- ------------------------------------------------------------------------------------------------

-- DEFERRED, for 0018's reason: the entry, its lines and this row are separate INSERT statements, so an
-- immediate trigger would reject the legal sequence.
create function deposit_movement_matches_its_entry() returns trigger
language plpgsql as $$
declare
  deposit_account text := customer_deposit_account_code();
  entry_day       date;
  moved           bigint;
  expected        bigint;
  revenue         bigint;
  output_vat      bigint;
begin
  select e.entry_date into entry_day from journal_entry e where e.entry_id = new.journal_entry_id;
  if entry_day <> new.trading_date then
    raise exception
      'ZY302: the journal entry % for this deposit movement is dated % and the movement is on business '
      'day %. A deposit filed under another day''s takings reconciles against neither drawer.',
      new.journal_entry_id, entry_day, new.trading_date
      using errcode = 'ZY302';
  end if;

  -- Signed, in the liability's own direction: a credit increases what is owed.
  select coalesce(sum(l.credit_fils - l.debit_fils), 0) into moved
    from journal_line l
   where l.entry_id = new.journal_entry_id and l.account_code = deposit_account;
  expected := case when new.kind = 'received' then new.amount_fils else -new.amount_fils end;
  if moved <> expected then
    raise exception
      'ZY302: the journal entry % moves % fils on account % and this % movement is for % fils (expected '
      '% in the liability''s direction). The entry and the movement are two statements of one fact.',
      new.journal_entry_id, moved, deposit_account, new.kind, new.amount_fils, expected
      using errcode = 'ZY302';
  end if;

  -- An APPLICATION is part of the sale's own entry, which legitimately credits revenue and 2030: that is
  -- the invoice. A receipt and a refund are the two that must recognise nothing.
  if new.kind = 'applied' then
    return null;
  end if;

  select coalesce(sum(l.debit_fils + l.credit_fils), 0) into revenue
    from journal_line l
    join account a on a.code = l.account_code
   where l.entry_id = new.journal_entry_id and a.type = 'revenue';
  if revenue <> 0 then
    raise exception
      'ZY303: the journal entry % moves % fils across revenue accounts. A deposit % recognises no '
      'revenue: the supply is the treatment, and [UNVERIFIED] Y11-vat-deposit is open. The release of '
      '% against the invoice that bills the appointment is what recognises it, once.',
      new.journal_entry_id, revenue, new.kind, deposit_account
      using errcode = 'ZY303';
  end if;

  select coalesce(sum(l.debit_fils + l.credit_fils), 0) into output_vat
    from journal_line l
   where l.entry_id = new.journal_entry_id and l.account_code = '2030';
  if output_vat <> 0 then
    raise exception
      'ZY303: the journal entry % moves % fils on 2030 Output VAT payable. A deposit % charges no output '
      'VAT: whether receiving one is itself a date of supply is [UNVERIFIED] Y11-vat-deposit, and the '
      'provisional answer is the one Y11-vat-package gives - the supply is the delivery.',
      new.journal_entry_id, output_vat, new.kind
      using errcode = 'ZY303';
  end if;
  return null;
end $$;

comment on function deposit_movement_matches_its_entry() is
  'ZY302: the named entry moves the deposit account by exactly this movement, in the direction its kind '
  'says, on its own business day. ZY303: a receipt or a refund recognises no revenue and charges no '
  'output VAT - ZG005''s shape for package_sale, and it measures the TOTAL movement rather than the net '
  'because crediting 4010 and debiting the contra 4095 by one figure nets to zero and has recognised '
  'revenue. If Y11-vat-deposit moves the date of supply to the receipt, this predicate changes and no '
  'table does.';

create constraint trigger deposit_movement_matches_its_entry
  after insert on deposit_movement
  deferrable initially deferred
  for each row execute function deposit_movement_matches_its_entry();

-- ------------------------------------------------------------------------------------------------
-- ZY304 — the chain: an opening balance is the previous movement's closing balance
-- ------------------------------------------------------------------------------------------------

-- Not deferred. This rule needs nothing but the rows already committed plus this one, and firing
-- immediately puts the refusal on the statement that caused it rather than at COMMIT.
create function deposit_movement_continues_the_chain() returns trigger
language plpgsql as $$
declare
  previous_after bigint;
  previous_seq   integer;
begin
  select m.held_after_fils, m.seq into previous_after, previous_seq
    from deposit_movement m
   where m.appointment_id = new.appointment_id and m.seq < new.seq
   order by m.seq desc
   limit 1;

  if previous_seq is null then
    if new.seq <> 1 then
      raise exception
        'ZY304: movement %s of appointment % has no movement before it. A history that starts at %s is a '
        'history with a gap, and a gap is a balance nobody can explain.',
        new.seq, new.appointment_id, new.seq
        using errcode = 'ZY304';
    end if;
    if new.held_before_fils <> 0 then
      raise exception
        'ZY304: the first movement of appointment % opens at % fils. Nothing was held before the first '
        'deposit was taken.',
        new.appointment_id, new.held_before_fils
        using errcode = 'ZY304';
    end if;
    return null;
  end if;

  if previous_seq <> new.seq - 1 then
    raise exception
      'ZY304: movement %s of appointment % follows movement %s. The sequence is contiguous, because '
      'ADR 0057''s cumulative figure is only a figure if every difference is on file.',
      new.seq, new.appointment_id, previous_seq
      using errcode = 'ZY304';
  end if;
  if new.held_before_fils <> previous_after then
    raise exception
      'ZY304: movement %s of appointment % opens at % fils and movement %s closed at % fils. Each row is '
      'internally consistent either way, so without this the sequence says whatever anybody wrote.',
      new.seq, new.appointment_id, new.held_before_fils, previous_seq, previous_after
      using errcode = 'ZY304';
  end if;
  return null;
end $$;

comment on function deposit_movement_continues_the_chain() is
  'ZY304: a movement''s opening balance is the previous movement''s closing balance, the sequence is '
  'contiguous, and the first movement opens at zero. deposit_movement_balance_moves_by_its_amount holds '
  'each row internally; this is the part a CHECK cannot see.';

create trigger deposit_movement_continues_the_chain
  after insert on deposit_movement
  for each row execute function deposit_movement_continues_the_chain();

-- ------------------------------------------------------------------------------------------------
-- ZY305 — an application must name a document that bills its appointment
-- ------------------------------------------------------------------------------------------------

-- DEFERRED: `finaliseCheckout` writes the invoice, the entry, the tenders and the `invoice_appointment`
-- link in one transaction, and the movement may legitimately be inserted before the link.
create function deposit_applies_only_to_its_own_appointment() returns trigger
language plpgsql as $$
declare
  billed text;
begin
  if new.kind <> 'applied' then
    return null;
  end if;
  if exists (
    select 1 from invoice_appointment ia
     where ia.invoice_id = new.invoice_id and ia.appointment_id = new.appointment_id
  ) then
    return null;
  end if;
  select coalesce(string_agg(ia.appointment_id::text, ', ' order by ia.appointment_id), 'no appointment')
    into billed
    from invoice_appointment ia where ia.invoice_id = new.invoice_id;
  raise exception
    'ZY305: the deposit held against appointment % cannot settle document %, which bills %. A deposit is '
    'a part-payment against ONE booking (docs/01 decision 19b) - a payment on account that could settle '
    'any document would make its own refund and cancellation questions unanswerable.',
    new.appointment_id, new.invoice_id, billed
    using errcode = 'ZY305';
end $$;

comment on function deposit_applies_only_to_its_own_appointment() is
  'ZY305: an applied movement must name a document that bills its own appointment, joined through '
  'invoice_appointment - which already holds "an appointment appears on at most one issued document, '
  'ever" (0063), so the refusal is exact rather than approximate. The TypeScript half is '
  'assertDepositRedeemable in packages/core/src/payments/deposit.ts.';

create constraint trigger deposit_applies_only_to_its_own_appointment
  after insert on deposit_movement
  deferrable initially deferred
  for each row execute function deposit_applies_only_to_its_own_appointment();

-- ------------------------------------------------------------------------------------------------
-- ZY306 — a deposit may not become a package
-- ------------------------------------------------------------------------------------------------

-- On `journal_line` and not on `deposit_movement`, because the conversion decision 19b forbids would not
-- write a movement at all: it is an entry debiting 2045 and crediting 2050, and nothing about such an
-- entry looks wrong. It balances, it has a narrative, and it has created a second deferred-revenue path
-- on the same money under a second answer to Y11-vat-package.
--
-- DEFERRED and FOR EACH ROW, so every line of the entry is present when the predicate runs. One
-- direction is enough and is total: whichever line is the deposit account will find the other, and if
-- there is no deposit line the entry is not this unit's business.
create function deposit_is_not_a_prepaid_product() returns trigger
language plpgsql as $$
declare
  deferred_accounts text[] := array['2050', '2055'];
  touched           text;
begin
  if new.account_code <> customer_deposit_account_code() then
    return null;
  end if;
  select string_agg(distinct l.account_code, ', ' order by l.account_code) into touched
    from journal_line l
   where l.entry_id = new.entry_id and l.account_code = any (deferred_accounts);
  if touched is null then
    return null;
  end if;
  raise exception
    'ZY306: journal entry % moves both % and % in one entry. docs/01 decision 19b: packages are the only '
    'prepaid product, and a deposit "is not a prepaid product - it is a part-payment against one '
    'specific booking". Converting one would put the same money under a second deferred-revenue path, a '
    'second liability account and a second answer to Y11-vat-package.',
    new.entry_id, customer_deposit_account_code(), touched
    using errcode = 'ZY306';
end $$;

comment on function deposit_is_not_a_prepaid_product() is
  'ZY306: no journal entry may move the deposit account and a deferred-revenue account (2050 packages, '
  '2055 vouchers) at once, in either direction. The refusal is on journal_line because the conversion '
  'docs/01 decision 19b forbids writes no deposit_movement at all - it is just an entry, and it '
  'balances. The TypeScript half is DepositIsNotAPrepaidProduct in @berelax/core.';

create constraint trigger journal_line_deposit_is_not_a_prepaid_product
  after insert on journal_line
  deferrable initially deferred
  for each row execute function deposit_is_not_a_prepaid_product();

commit;
