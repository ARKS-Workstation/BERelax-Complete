-- 0076 — the cash drawer reconciliation: a shift keyed on the BUSINESS DAY, and a discrepancy that is
--        a stored signed figure rather than a boolean.
--
-- 0011 made `business_day` a table because trading runs 11:00–02:00 and a trading date cannot be had by
-- truncating a timestamp. 0063 put `trading_date` on `payment` for this unit by name — "the cash-up that
-- reconciles it (M-TILL-11) cuts on this column" — and 0068 put `change_given_fils` BESIDE `amount_fils`
-- for this unit too: "a drawer is counted against the notes that went in and the notes that came out".
-- Nothing here re-argues any of that. What this file adds is the shift, the count, and the arithmetic
-- between them.
--
-- ## 1. The key is `trading_date`, and a shift that crosses midnight is ONE session
--
-- `cash_session.trading_date` is a foreign key into `business_day (trading_date)` — the same column name
-- the other nine tables carrying this quantity use, `business_day`'s own primary key included. A tenth
-- spelling for one fact is how two queries come to disagree about which day a note belongs to.
--
-- A shift that opens at 23:00 and ends at 02:00 belongs to ONE business day: 02:00 is the close instant
-- of the 23:00 date's session (`business_day.closes_at`, generated, with `crosses_midnight` true), so
-- both instants resolve to the same `trading_date`. A reconciliation keyed on the CALENDAR date would
-- split that shift in two and balance neither half: the money taken before midnight would be counted
-- against a drawer that was still being used, and the money taken after it against an opening float
-- nobody declared. The key is therefore the business day and never `opened_at::date` — which is also why
-- `opened_at` carries no generated date column: a second derivation of the trading date is a second
-- answer, and `resolveTradingDate` in @berelax/core plus this foreign key are the only two.
--
-- ## 2. `expected_float_fils` is GENERATED, and the formula exists once
--
--     expected = opening float + cash received - change given - cash refunded - drops
--
-- Four of those five are SNAPSHOTTED onto the session at close rather than read through a view, because a
-- reconciliation is evidence AS AT the moment the drawer was counted: a payment back-dated afterwards
-- must not silently restate a figure somebody has already signed off. The snapshot is held equal to the
-- rows by `cash_session_reconciles_to_the_rows` (ZU005) at COMMIT, so the two cannot drift, and
-- `cash_session_reconciliation` shows both side by side.
--
-- `cash_received_fils` and `change_given_fils` are stored SEPARATELY and never as one net figure. That is
-- 0068's decision used for the purpose it was taken for: a cash-up sheet is checked against the till roll
-- in both directions — notes in, notes out — and `sum(applied_fils)` alone reconciles against neither.
--
-- The formula is stated ONCE, in `cash_session_expected_float_fils()`, and both generated columns call
-- it. PostgreSQL forbids a generation expression referencing another generated column, so
-- `discrepancy_fils` cannot be written as `counted - expected_float_fils`; an inlined copy of the
-- subtraction is the alternative, and two copies of an arithmetic rule is one opportunity for them to
-- disagree. An `immutable` SQL function is allowed in a generation expression and closes that.
--
-- ## 3. The discrepancy is a SIGNED STORED FIGURE, not a boolean
--
-- `discrepancy_fils = counted - expected`, generated, in the permissive `fils` domain: NEGATIVE means the
-- drawer is SHORT and POSITIVE means it is OVER. A `balanced boolean` would answer the only question
-- nobody needs answered — a till that is out by 5 fils and one out by 500 dirhams are the same boolean
-- and different events — and it could not be summed over a month, which is the figure that says whether
-- there is a process problem or a person problem.
--
-- ## 4. A disagreement is RECORDED WITH A REASON, and posted. It is not refused
--
-- A close whose count differs from the expectation is accepted, provided two things: a `count_note`
-- saying what the counter thinks happened (`cash_session_variance_needs_a_reason`) and a journal entry
-- moving exactly the discrepancy to `6140 Cash over and short`
-- (`cash_session_variance_is_posted`, ZU004, DEFERRED so it fires at COMMIT).
--
-- Refusing the close was considered and is wrong. The count is a MEASUREMENT of the physical world and
-- the expectation is a derivation from rows; when they differ, the measurement is the fact. A refusal
-- would leave the shift with no counted figure at all — so the evidence of the discrepancy would be
-- destroyed by the mechanism meant to protect it, and the operator's only way to finish the day would be
-- to type the expected number in, which is precisely the silent absorption this unit exists to prevent.
-- Worse, the money would still be missing and nothing would say so.
--
-- The symmetric rule holds the other way: a session whose discrepancy is ZERO must carry NO entry
-- (`journal_entry_id is null`), because a cash-up that posted a zero-value pair of lines would be refused
-- by `journal_line_exactly_one_side` (0018) and a cash-up that posted nothing while claiming to have
-- posted something is the state ZU004 exists to make unrepresentable.
--
-- ## 5. Closed is terminal, and the remedy is a new dated row
--
-- `cash_session_close_is_terminal` (ZU002) refuses EVERY update to a closed session and every delete of
-- one, for every role including the owner — so `open` -> `closed` is the only transition that exists and
-- `closed` -> `open` is unrepresentable rather than merely ungranted. 0072's argument, one table along.
-- The remedy is `cash_session_adjustment`: a new row, dated on its OWN business day, with its own
-- journal entry. That is the same shape a credit note has to an invoice (0072) and a dated reversal has
-- to a filed period (0073), and it is the only shape that leaves the original count readable.
--
-- ## 6. What is deliberately NOT here
--
-- No `payment.drawer_code`. ZU005 and ZU006 therefore sum ALL cash for a business day rather than the
-- cash of one drawer, which is EXACT while `cash_drawer` holds one row and is the honest limit otherwise.
-- Attributing a tender to a till is M-TILL-13's: the till is the thing that knows which drawer took the
-- money, and a column here that nothing populated would read as "drawer unknown" for every sale ever
-- made. Both predicates name the column they will gain.
--
-- No second reader for "is this date closed?". `period_lock_for()` and `earliest_open_date_from()` are
-- 0018's and 0073's, and `periodStatusOn()` is their one TypeScript reader (M-VAT-06's NOTE). ZU003 calls
-- the same two functions the journal's own guards call, so a cash-up cannot be refused by one rule and
-- permitted by another.

begin;

-- ------------------------------------------------------------------------------------------------
-- cash_drawer — the registry
-- ------------------------------------------------------------------------------------------------
-- A registry table and not a bare text column on `cash_session`, for one reason that is about the
-- uniqueness rule below rather than about tidiness: `cash_session_one_open_per_drawer_per_day` is a
-- partial unique index on `(drawer_code, trading_date)`, so a typo in the drawer code does not collide
-- with the row it was meant to collide with. 'Reception' beside 'reception' would be a SECOND open
-- session on one physical till, which is the state that index exists to make impossible.
--
-- A table and not an enum type, for 0063's reason: adding a drawer must not require ALTER TYPE inside a
-- transaction that also writes rows.
create table cash_drawer (
  -- Lower snake case, so a display-label change cannot silently become a new drawer.
  code                 text        primary key
                         constraint cash_drawer_code_is_snake_case
                         check (code ~ '^[a-z][a-z0-9_]*$'),
  label                text        not null
                         constraint cash_drawer_label_nonempty check (btrim(label) <> ''),
  -- Which asset account this drawer's cash sits in. `1010 Cash in drawer` for a till; a second drawer
  -- kept in the safe would be `1015 Petty cash float`, and the cash-up posting reads THIS column rather
  -- than assuming 1010, so the two cannot be reconciled into one balance by accident.
  posting_account_code text        not null references account (code),
  -- Retired rather than deleted: `cash_session.drawer_code` references this table, and a drawer that was
  -- once counted has rows that must keep resolving. NULL means in service.
  retired_at           timestamptz,
  created_at           timestamptz not null default now()
);

comment on table cash_drawer is
  'Every physical cash drawer, with the asset account its cash sits in. A registry so that a mistyped '
  'drawer code cannot become a second open session on one till.';
comment on column cash_drawer.posting_account_code is
  'The account a cash-up debits or credits for this drawer. Read by the posting rule rather than '
  'assumed to be 1010, so a safe float and a till float are not reconciled into one balance.';

-- One row, because there is one till at reception (docs/06 F8 lists the hardware and settles nothing
-- else about it). A second drawer is a ROW and not a migration, which is the whole point of the table.
insert into cash_drawer (code, label, posting_account_code) values
  ('reception', 'Reception drawer', '1010');

-- ------------------------------------------------------------------------------------------------
-- The over/short account, stated once in SQL
-- ------------------------------------------------------------------------------------------------
-- `6140 Cash over and short` appears in exactly one place in SQL, so the pair with
-- `ACCOUNTS.cashOverShort` in @berelax/core can be asserted in one assertion rather than wherever the
-- literal happened to be typed. `tips_payable_account_code()` (0068) is the same arrangement, and
-- packages/fixtures/src/cash-up.itest.ts makes the assertion with a control proving it would notice a
-- disagreement.
create or replace function cash_over_short_account_code() returns text
  language sql immutable parallel safe
  as $$ select '6140'::text $$;

comment on function cash_over_short_account_code() is
  'The drawer discrepancy account. One statement of it in SQL, held equal to ACCOUNTS.cashOverShort in '
  '@berelax/core, because packages/db may not import packages/core.';

-- ------------------------------------------------------------------------------------------------
-- The expected float, as one immutable function
-- ------------------------------------------------------------------------------------------------
-- The whole arithmetic of a cash-up, in one place, called by BOTH generated columns below. Written as a
-- function rather than inlined twice because PostgreSQL forbids a generation expression from referencing
-- another generated column, so `discrepancy_fils` cannot say `counted - expected_float_fils` and would
-- otherwise have to repeat the formula.
--
-- `strict` is deliberate and load-bearing: an OPEN session has NULL counts, and a strict function returns
-- NULL for a NULL argument, so `expected_float_fils` and `discrepancy_fils` are both NULL until the
-- drawer is counted. A `coalesce(..., 0)` here would state an expected float for a shift that is still
-- running, and a discrepancy against a count nobody has taken.
create or replace function cash_session_expected_float_fils(
  p_opening_float  bigint,
  p_cash_received  bigint,
  p_change_given   bigint,
  p_cash_refunded  bigint,
  p_drops          bigint
) returns bigint
  language sql immutable strict parallel safe
  as $$
    select p_opening_float + p_cash_received - p_change_given - p_cash_refunded - p_drops
  $$;

comment on function cash_session_expected_float_fils(bigint, bigint, bigint, bigint, bigint) is
  'opening float + cash received - change given - cash refunded - drops. The one statement of the '
  'cash-up formula: both generated columns on cash_session call it, and @berelax/core''s expectedFloat '
  'is held equal to it by packages/fixtures/src/cash-up.itest.ts. STRICT so an uncounted session has a '
  'NULL expectation rather than a figure derived from a count nobody took.';

-- ------------------------------------------------------------------------------------------------
-- cash_session — one shift, one drawer, one business day
-- ------------------------------------------------------------------------------------------------
create table cash_session (
  id                   uuid        primary key default uuid_generate_v7(),
  drawer_code          text        not null references cash_drawer (code),
  -- THE KEY. A foreign key into business_day (0011), on update cascade so a regenerated calendar moves
  -- the sessions with it, on delete restrict because a counted drawer is evidence about a day that
  -- happened. Trading runs 11:00-02:00, so a shift from 23:00 to 02:00 is ONE row here and a
  -- reconciliation keyed on the calendar date would split it across two and balance neither.
  trading_date         date        not null
                         references business_day (trading_date)
                         on update cascade on delete restrict,
  -- Which shift of that business day. A day may have two: an early and a late, each counted. Positional
  -- rather than timed, so two reads list them in the same order (0063's reason for payment.tender_no).
  shift_no             smallint    not null
                         constraint cash_session_shift_no_positive check (shift_no >= 1),
  status               text        not null default 'open'
                         constraint cash_session_status_known
                         check (status in ('open', 'closed')),
  -- What was in the drawer when the shift started. Declared, not posted: the float is the previous
  -- close's counted cash left in the till, so it never left `1010` and there is nothing to post. A
  -- posting here would double-count the float on every shift.
  opening_float_fils   fils_nonneg not null,
  opened_at            timestamptz not null default now(),
  -- Who opened it, by kind. The label and id are on the audit_event row the service writes; this column
  -- exists so a query over the table alone can tell an operator's shift from one a job opened.
  opened_by_actor_kind text        not null
                         constraint cash_session_opened_by_known
                         check (opened_by_actor_kind in ('staff', 'customer', 'system', 'agent')),

  -- --- the four figures a drawer is reconciled against, snapshotted AT CLOSE --------------------
  -- NULL while the shift is open, all five non-null once it closes (cash_session_closed_is_complete).
  -- Snapshotted rather than read live: a reconciliation is evidence as at the count, and a payment
  -- back-dated afterwards must not restate a figure somebody signed. ZU005 holds them equal to the rows.
  --
  -- `cash_received_fils` is the sum of `payment.amount_fils` — the notes that WENT IN — and
  -- `change_given_fils` the sum of `payment.change_given_fils`, the notes that CAME OUT. Never one net
  -- figure: that is what 0068 separated them for, and a cash-up sheet is checked in both directions.
  cash_received_fils   fils_nonneg,
  change_given_fils    fils_nonneg,
  cash_refunded_fils   fils_nonneg,
  -- Cash removed from the drawer mid-shift to the safe or the bank. Snapshotted from `cash_drop`, whose
  -- rows carry the posting: the money left `1010` when it was dropped, not when the drawer was counted.
  drops_fils           fils_nonneg not null default 0,
  -- What was physically counted. The whole artefact: without it there is no reconciliation, which is
  -- what ZU001 (CountRequired) refuses a close without.
  counted_float_fils   fils_nonneg,

  -- --- the two derived figures ------------------------------------------------------------------
  expected_float_fils  fils        generated always as (
                         cash_session_expected_float_fils(
                           opening_float_fils, cash_received_fils, change_given_fils,
                           cash_refunded_fils, drops_fils)
                       ) stored,
  -- counted - expected, SIGNED. Negative is short, positive is over. A stored figure and not a boolean:
  -- a till out by 5 fils and one out by 500 dirhams are the same boolean and different events, and a
  -- boolean cannot be summed over a month to tell a process problem from a person problem.
  --
  -- The `fils` domain and NOT `fils_nonneg`, which is the point rather than an oversight: a short drawer
  -- is the case that matters and `fils_nonneg` would refuse the row outright, with a message naming no
  -- rule anybody could act on. 0068 measured the same trap on `applied_fils`.
  discrepancy_fils     fils        generated always as (
                         counted_float_fils - cash_session_expected_float_fils(
                           opening_float_fils, cash_received_fils, change_given_fils,
                           cash_refunded_fils, drops_fils)
                       ) stored,

  -- --- the close ---------------------------------------------------------------------------------
  closed_at            timestamptz,
  closed_by_actor_kind text
                         constraint cash_session_closed_by_known
                         check (closed_by_actor_kind is null
                                or closed_by_actor_kind in ('staff', 'customer', 'system', 'agent')),
  -- What the counter thinks happened. Mandatory when the drawer is out, by
  -- cash_session_variance_needs_a_reason: a discrepancy nobody explained is a discrepancy nobody
  -- investigated, and the sentence is the only part of this row a person wrote.
  count_note           text
                         constraint cash_session_count_note_nonempty
                         check (count_note is null or btrim(count_note) <> ''),
  -- The `cash_up` entry that moved the discrepancy to 6140. NULL exactly when the drawer balanced, which
  -- ZU004 enforces in both directions.
  journal_entry_id     text        references journal_entry (entry_id),
  created_at           timestamptz not null default now(),

  -- One session per shift per drawer per business day, so a reference to "the second shift on the 3rd"
  -- resolves to one row.
  constraint cash_session_one_row_per_shift unique (drawer_code, trading_date, shift_no),

  -- A closed session carries every figure the reconciliation is made of, and an open one carries none of
  -- them. Stated as one constraint over the set rather than five nullability rules, because the thing
  -- that must not exist is a HALF-counted close — a counted float with no receipts total against it is a
  -- figure that reconciles to nothing.
  constraint cash_session_closed_is_complete check (
    case status
      when 'closed' then
        counted_float_fils is not null and cash_received_fils is not null
        and change_given_fils is not null and cash_refunded_fils is not null
        and closed_at is not null and closed_by_actor_kind is not null
      else
        counted_float_fils is null and cash_received_fils is null
        and change_given_fils is null and cash_refunded_fils is null
        and closed_at is null and closed_by_actor_kind is null
        and journal_entry_id is null and count_note is null
    end
  ),

  -- A drawer that is out needs a sentence. The check reads the GENERATED discrepancy, which is allowed
  -- and is what keeps the rule stated against the figure rather than against the inputs.
  constraint cash_session_variance_needs_a_reason check (
    status <> 'closed' or discrepancy_fils = 0 or count_note is not null
  ),

  -- Change cannot exceed what was handed over, in aggregate as well as per tender
  -- (payment_change_not_more_than_tendered, 0068). A snapshot that broke this would make the expected
  -- float larger than the cash that ever entered the drawer.
  constraint cash_session_change_not_more_than_received check (
    change_given_fils is null or change_given_fils <= cash_received_fils
  )
);

comment on table cash_session is
  'One shift on one drawer on one BUSINESS DAY (0011), opened with a declared float and closed with a '
  'counted one. Keyed on trading_date and never on opened_at::date: trading runs 11:00-02:00, so a '
  '23:00-to-02:00 shift is one row here and a calendar key would split it in two and balance neither.';
comment on column cash_session.trading_date is
  'The business day this shift belongs to, resolved by the caller with resolveTradingDate and held to '
  'the materialised calendar by the foreign key. The column the cash-up cuts on, and the same column '
  'payment.trading_date and refund.trading_date carry.';
comment on column cash_session.opening_float_fils is
  'Declared, not posted. The float is the previous close''s counted cash left in the till, so it never '
  'left 1010 and a posting here would double-count it on every shift.';
comment on column cash_session.cash_received_fils is
  'Sum of payment.amount_fils for cash on this business day - the notes that went IN. Snapshotted at '
  'close and held equal to the rows by ZU005.';
comment on column cash_session.change_given_fils is
  'Sum of payment.change_given_fils - the notes that came OUT. Stored separately from cash_received '
  'and never netted into it: that is what 0068 separated the two columns for, and a cash-up sheet is '
  'checked against the till roll in both directions.';
comment on column cash_session.expected_float_fils is
  'opening + received - change - refunded - drops, GENERATED through '
  'cash_session_expected_float_fils() so the formula exists once. NULL while the session is open.';
comment on column cash_session.discrepancy_fils is
  'counted - expected, GENERATED and SIGNED: negative is short, positive is over. A stored figure and '
  'not a boolean, so it can be summed over a month. The `fils` domain deliberately, because a short '
  'drawer is the case that matters and fils_nonneg would refuse the row.';
comment on column cash_session.journal_entry_id is
  'The cash_up entry that moved the discrepancy to 6140. NULL exactly when the drawer balanced - ZU004 '
  'enforces both directions, so a variance cannot be absorbed and a balanced drawer cannot claim a '
  'posting it did not make.';
comment on column cash_session.count_note is
  'Why the drawer was out. Mandatory for a non-zero discrepancy. The close is RECORDED rather than '
  'refused: the count is a measurement of the physical world and the expectation is a derivation, so '
  'refusing would destroy the evidence and leave the operator typing in the expected figure.';

-- THE index the acceptance names. Partial on `status = 'open'`, so a day may hold several CLOSED
-- sessions — an early shift and a late one, each counted — and at most one open. The second insert
-- raises 23505 rather than leaving two shifts taking money into one drawer with two opening floats.
create unique index cash_session_one_open_per_drawer_per_day
  on cash_session (drawer_code, trading_date) where status = 'open';

comment on index cash_session_one_open_per_drawer_per_day is
  'At most one OPEN session per drawer per business day. Partial rather than total so a second SHIFT '
  'may be opened once the first has been counted.';

create index cash_session_trading_date_idx on cash_session (trading_date, drawer_code);
create index cash_session_open_idx on cash_session (drawer_code) where status = 'open';

-- ------------------------------------------------------------------------------------------------
-- cash_drop — money out of the drawer mid-shift, with its own posting
-- ------------------------------------------------------------------------------------------------
-- A drop has to be a ROW and not a column on the session, because it happens at a time and moves money
-- between two accounts at that time. `1010` is debited by every cash payment as the payment is taken
-- (0068's manual adapter), so a drop that only appeared in the close would leave `1010` overstated for
-- the rest of the shift — and a trial balance taken mid-shift is exactly when somebody is looking.
create table cash_drop (
  id                       uuid        primary key default uuid_generate_v7(),
  cash_session_id          uuid        not null references cash_session (id),
  drop_no                  smallint    not null
                             constraint cash_drop_no_positive check (drop_no >= 1),
  amount_fils              fils_nonneg not null
                             constraint cash_drop_amount_positive check (amount_fils > 0),
  -- Where the money went: `1020 Bank current` for a banking, `1015 Petty cash float` for the safe.
  -- Snapshotted for payment.posting_account_code's reason (0063): re-mapping later must not restate a
  -- posting already filed.
  destination_account_code text        not null references account (code),
  -- The deposit slip or safe-log reference. Absent rather than blank, 0063's reason.
  reference                text
                             constraint cash_drop_reference_nonempty
                             check (reference is null or btrim(reference) <> ''),
  reason                   text        not null
                             constraint cash_drop_reason_nonempty check (btrim(reason) <> ''),
  -- MANDATORY and a real foreign key. Money leaving the drawer with no entry behind it is the state that
  -- makes every later count unexplainable, and nothing truncates the journal, so the key costs nothing.
  journal_entry_id         text        not null references journal_entry (entry_id),
  dropped_at               timestamptz not null default now(),
  created_at               timestamptz not null default now(),
  constraint cash_drop_one_row_per_number unique (cash_session_id, drop_no)
);

comment on table cash_drop is
  'Cash taken out of a drawer mid-shift, with the entry that moved it. A row and not a column on '
  'cash_session: 1010 is debited as each payment is taken, so a drop recorded only at the close would '
  'leave 1010 overstated for the rest of the shift. UPDATE and DELETE raise ZU002 for every role: a '
  'drop that could be edited is a drawer whose history changes after it was counted.';

create index cash_drop_session_idx on cash_drop (cash_session_id, drop_no);

-- ------------------------------------------------------------------------------------------------
-- cash_session_adjustment — the correction, because a closed session cannot be reopened
-- ------------------------------------------------------------------------------------------------
-- The remedy `cash_session_close_is_terminal` leaves. A new row, dated on its OWN business day, with its
-- own entry — the shape a credit note has to an invoice (0072) and a dated reversal has to a filed period
-- (0073), and the only shape that leaves the original count readable.
create table cash_session_adjustment (
  id               uuid        primary key default uuid_generate_v7(),
  cash_session_id  uuid        not null references cash_session (id),
  adjustment_no    smallint    not null
                     constraint cash_session_adjustment_no_positive check (adjustment_no >= 1),
  -- The business day the CORRECTION posts under, which is not the session's: a discrepancy found on
  -- Tuesday against Saturday's drawer is Tuesday's entry, because Saturday may be filed (0073).
  trading_date     date        not null
                     references business_day (trading_date)
                     on update cascade on delete restrict,
  -- Signed, and the `fils` domain: positive means the drawer held more than the close recorded.
  amount_fils      fils        not null
                     constraint cash_session_adjustment_amount_nonzero check (amount_fils <> 0),
  reason           text        not null
                     constraint cash_session_adjustment_reason_nonempty check (btrim(reason) <> ''),
  journal_entry_id text        not null references journal_entry (entry_id),
  created_at       timestamptz not null default now(),
  constraint cash_session_adjustment_one_row_per_number unique (cash_session_id, adjustment_no)
);

comment on table cash_session_adjustment is
  'A dated correction to a session that has been counted and closed. The remedy for "a closed session '
  'cannot be reopened": a new row on its own business day with its own entry, never an edit. UPDATE '
  'and DELETE raise ZU002 for every role, because an adjustment that could be edited is the reopening '
  'this unit refuses, reached one table along.';

create index cash_session_adjustment_session_idx
  on cash_session_adjustment (cash_session_id, adjustment_no);

-- ------------------------------------------------------------------------------------------------
-- ZU002 — closed is terminal, for every role
-- ------------------------------------------------------------------------------------------------
-- The acceptance asks for a trigger that rejects the status transition. This refuses every UPDATE to a
-- closed row rather than the one transition, because `closed` -> `open` is not the only way to undo a
-- count: rewriting `counted_float_fils` in place reaches the same end with the status untouched, and a
-- rule that named the transition would permit it.
--
-- For EVERY role including the owner, 0072's argument: the grants below constrain berelax_app, and a
-- migration or a psql session does not connect as berelax_app.
create function refuse_closed_cash_session_change() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'CashSessionAlreadyClosed: cash session % was counted and closed on %; DELETE is refused. A '
      'counted drawer is evidence about a day that happened. Correct it with a '
      'cash_session_adjustment dated on an open business day.',
      old.id, old.closed_at using errcode = 'ZU002';
  end if;
  raise exception
    'CashSessionAlreadyClosed: cash session % was counted and closed on % with a discrepancy of % '
    'fils; UPDATE is refused, including reopening it. A closed session is corrected by a new '
    'cash_session_adjustment dated on an open business day, never by editing the count.',
    old.id, old.closed_at, old.discrepancy_fils using errcode = 'ZU002';
end $$;

comment on function refuse_closed_cash_session_change() is
  'Raises ZU002 for any UPDATE or DELETE of a CLOSED cash_session, for every role including the owner. '
  'Every update rather than the open<-closed transition alone: rewriting counted_float_fils in place '
  'undoes a count without touching status, and a rule naming the transition would allow it.';

create trigger cash_session_close_is_terminal before update on cash_session
  for each row when (old.status = 'closed') execute function refuse_closed_cash_session_change();
create trigger cash_session_no_delete_once_closed before delete on cash_session
  for each row when (old.status = 'closed') execute function refuse_closed_cash_session_change();

-- `cash_drop` and `cash_session_adjustment` are append-only outright. A drop that could be edited is a
-- drawer whose history changes after it was counted; an adjustment that could be edited is the reopening
-- this unit refuses, reached one table along.
create function refuse_cash_movement_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only; % is refused. A drop or an adjustment recorded in error is answered by a new '
    'dated row, because the figure it changed has already been reconciled against a counted drawer.',
    tg_table_name, tg_op
    using errcode = 'ZU002';
end $$;

create trigger cash_drop_no_update before update on cash_drop
  for each row execute function refuse_cash_movement_change();
create trigger cash_drop_no_delete before delete on cash_drop
  for each row execute function refuse_cash_movement_change();
create trigger cash_session_adjustment_no_update before update on cash_session_adjustment
  for each row execute function refuse_cash_movement_change();
create trigger cash_session_adjustment_no_delete before delete on cash_session_adjustment
  for each row execute function refuse_cash_movement_change();

-- ------------------------------------------------------------------------------------------------
-- ZU001 / ZU003 — a close needs a count, and a business day in an OPEN period
-- ------------------------------------------------------------------------------------------------
create function cash_session_is_closeable() returns trigger
language plpgsql
as $$
declare
  v_period text;
  v_open   date;
begin
  -- ZU003 on INSERT and on close. `period_lock_for()` (0018) and `earliest_open_date_from()` (0073) are
  -- the SAME two functions the BEFORE INSERT guards on journal_entry and journal_line call, and the same
  -- two periodStatusOn() reads — so a cash-up cannot be refused by one rule and permitted by another,
  -- and no second definition of "is this date closed" exists to disagree.
  v_period := period_lock_for(new.trading_date);
  if v_period is not null then
    v_open := earliest_open_date_from(new.trading_date);
    raise exception
      'CashSessionPeriodLocked: cash session for drawer "%" on business day % cannot be opened or '
      'counted; accounting period "%" is locked. The earliest open date is %.',
      new.drawer_code, new.trading_date, v_period, v_open using errcode = 'ZU003';
  end if;

  -- ZU001. The counted float IS the reconciliation: without it the row records an expectation and no
  -- measurement, which is a shift that was never counted wearing the word closed.
  if new.status = 'closed' and new.counted_float_fils is null then
    raise exception
      'CountRequired: cash session % for drawer "%" on business day % cannot be closed with no '
      'counted amount. The counted float minus the expected float IS the reconciliation; a close '
      'without one records an expectation and no measurement.',
      new.id, new.drawer_code, new.trading_date using errcode = 'ZU001';
  end if;

  return new;
end $$;

comment on function cash_session_is_closeable() is
  'Raises ZU003 (the business day is inside a locked accounting period, naming the earliest OPEN date) '
  'or ZU001 (CountRequired: closing with no counted float). BEFORE INSERT OR UPDATE, so the refusal '
  'arrives at the statement that caused it.';

create trigger cash_session_is_openable_and_closeable before insert or update on cash_session
  for each row execute function cash_session_is_closeable();

-- A drop may not be recorded into a session that has been counted: the drawer's history would change
-- after the reconciliation that depended on it, and ZU005 would then report the snapshot as wrong about
-- a figure that was right when it was taken.
create function cash_drop_session_is_open() returns trigger
language plpgsql
as $$
declare
  v_status text;
  v_date   date;
begin
  select status, trading_date into v_status, v_date
    from cash_session where id = new.cash_session_id;
  if v_status = 'closed' then
    raise exception
      'CashSessionAlreadyClosed: cannot record a drop against cash session %, which was counted and '
      'closed for business day %. Money out of a counted drawer is a new session''s drop or a '
      'cash_session_adjustment.',
      new.cash_session_id, v_date using errcode = 'ZU002';
  end if;
  return new;
end $$;

create trigger cash_drop_into_an_open_session before insert on cash_drop
  for each row execute function cash_drop_session_is_open();

-- An adjustment is the remedy for a CLOSED session, and it posts on its own business day, which must be
-- open and may not predate the shift it corrects.
create function cash_session_adjustment_is_postable() returns trigger
language plpgsql
as $$
declare
  v_status text;
  v_date   date;
  v_period text;
  v_open   date;
begin
  select status, trading_date into v_status, v_date
    from cash_session where id = new.cash_session_id;

  if v_status is null then
    raise exception
      'CashSessionAdjustmentWithoutSession: adjustment names cash session %, which does not exist.',
      new.cash_session_id using errcode = 'ZU007';
  end if;

  if v_status <> 'closed' then
    raise exception
      'CashSessionStillOpen: cash session % for business day % is still open, so there is nothing to '
      'correct. While a session is open the drawer is re-counted at its close; an adjustment is the '
      'remedy only once a count has been recorded.',
      new.cash_session_id, v_date using errcode = 'ZU007';
  end if;

  if new.trading_date < v_date then
    raise exception
      'CashSessionAdjustmentBeforeTheShift: adjustment is dated % and corrects a session counted on '
      '%. A correction may not appear on a business day the shift never reached.',
      new.trading_date, v_date using errcode = 'ZU007';
  end if;

  v_period := period_lock_for(new.trading_date);
  if v_period is not null then
    v_open := earliest_open_date_from(new.trading_date);
    raise exception
      'CashSessionPeriodLocked: adjustment dated % cannot be posted; accounting period "%" is locked. '
      'The earliest open date is %.',
      new.trading_date, v_period, v_open using errcode = 'ZU003';
  end if;

  return new;
end $$;

create trigger cash_session_adjustment_corrects_a_closed_session
  before insert on cash_session_adjustment
  for each row execute function cash_session_adjustment_is_postable();

-- ------------------------------------------------------------------------------------------------
-- ZU004 — a variance is ALWAYS posted, and a balanced drawer posts nothing
-- ------------------------------------------------------------------------------------------------
-- THE rule of this unit, and the reason it is a DEFERRED constraint trigger rather than a check: the
-- close and the `cash_up` entry are written a statement at a time inside one transaction, and the
-- session's `journal_entry_id` is set by the same UPDATE that closes it, so a per-statement check would
-- refuse whichever of the two arrived first. 0018's and 0068's pattern.
--
-- Both directions are enforced, and the second is as important as the first. A non-zero discrepancy with
-- no entry is a variance absorbed in silence. A ZERO discrepancy WITH an entry is a cash-up claiming a
-- posting it did not make — and since `journal_line_exactly_one_side` (0018) refuses a zero-value line,
-- such an entry can only be for some other figure.
create function cash_session_variance_is_posted() returns trigger
language plpgsql
as $$
declare
  v_expected_side text;
  v_posted        bigint;
  v_source        text;
  v_date          date;
  v_account       text := cash_over_short_account_code();
begin
  if new.status <> 'closed' then
    return null;
  end if;

  if new.discrepancy_fils = 0 then
    if new.journal_entry_id is not null then
      raise exception
        'VarianceNotPosted: cash session % balanced exactly, and yet it names journal entry "%". A '
        'balanced drawer posts nothing: journal_line_exactly_one_side refuses a zero-value line, so '
        'that entry moves some other figure.',
        new.id, new.journal_entry_id using errcode = 'ZU004';
    end if;
    return null;
  end if;

  if new.journal_entry_id is null then
    raise exception
      'VarianceNotPosted: cash session % is out by % fils (counted %, expected %) and names no journal '
      'entry. A reconciliation that can absorb a variance is not a reconciliation - the difference '
      'belongs in % Cash over and short, in this transaction.',
      new.id, new.discrepancy_fils, new.counted_float_fils, new.expected_float_fils, v_account
      using errcode = 'ZU004';
  end if;

  select source, entry_date into v_source, v_date
    from journal_entry where entry_id = new.journal_entry_id;

  if v_source <> 'cash_up' then
    raise exception
      'VarianceNotPosted: cash session % names journal entry "%", whose source is "%" and not '
      '"cash_up". A refund and a cash-up can produce identical lines, and the classification is the '
      'only thing that tells them apart when somebody asks.',
      new.id, new.journal_entry_id, v_source using errcode = 'ZU004';
  end if;

  if v_date <> new.trading_date then
    raise exception
      'VarianceNotPosted: cash session % is for business day % and names journal entry "%" dated %. '
      'The discrepancy is a fact about that shift, so it posts on that business day - dating it '
      'elsewhere files the loss in a period the shift never reached.',
      new.id, new.trading_date, new.journal_entry_id, v_date using errcode = 'ZU004';
  end if;

  -- A SHORT drawer (negative discrepancy) is a loss: debit 6140. An OVER drawer is a credit to it.
  -- Asserted on the side as well as the amount, because a posting on the wrong side balances just as
  -- well and states the opposite of what happened.
  v_expected_side := case when new.discrepancy_fils < 0 then 'debit' else 'credit' end;
  select coalesce(sum(case when v_expected_side = 'debit'
                           then debit_fils - credit_fils
                           else credit_fils - debit_fils end), 0)
    into v_posted
    from journal_line
   where entry_id = new.journal_entry_id and account_code = v_account;

  if v_posted <> abs(new.discrepancy_fils) then
    raise exception
      'VarianceNotPosted: cash session % is out by % fils, so journal entry "%" must carry % fils on '
      'the % side of account % and it carries %. A cash-up that posted a different figure leaves the '
      'drawer explained by no row.',
      new.id, new.discrepancy_fils, new.journal_entry_id, abs(new.discrepancy_fils),
      v_expected_side, v_account, v_posted
      using errcode = 'ZU004';
  end if;

  return null;
end $$;

comment on function cash_session_variance_is_posted() is
  'Raises ZU004 at COMMIT. A non-zero discrepancy must be carried to 6140 by a cash_up entry dated on '
  'the session''s business day, on the side the sign says, for exactly its absolute value; a zero '
  'discrepancy must name no entry at all. Deferred because the close and the entry are separate '
  'statements in one transaction.';

create constraint trigger cash_session_variance_is_posted
  after insert or update on cash_session
  deferrable initially deferred
  for each row execute function cash_session_variance_is_posted();

-- ------------------------------------------------------------------------------------------------
-- ZU005 — the snapshot equals the rows, exact to the fils
-- ------------------------------------------------------------------------------------------------
-- The acceptance line "the session's cash total reconciles to the sum of cash payment rows for that
-- business_day, exact to the fils", enforced rather than merely tested. DEFERRED, because a fixture, an
-- import or a checkout may write the session and the payments in one transaction in either order.
--
-- The sums are over ALL cash for the business day, not the cash of one drawer, because `payment` carries
-- no `drawer_code`: that column is M-TILL-13's, the unit that knows which till took the money. Exact
-- while `cash_drawer` holds one row, and named here so the next unit knows what to narrow.
create function cash_session_reconciles_to_the_rows() returns trigger
language plpgsql
as $$
declare
  v_received bigint;
  v_change   bigint;
  v_refunded bigint;
  v_drops    bigint;
begin
  if new.status <> 'closed' then
    return null;
  end if;

  select coalesce(sum(p.amount_fils), 0), coalesce(sum(p.change_given_fils), 0)
    into v_received, v_change
    from payment p
    join tender_type t on t.code = p.tender_kind
   where p.trading_date = new.trading_date and t.gives_change;

  select coalesce(sum(r.amount_fils), 0) into v_refunded
    from refund r
    join tender_type t on t.code = r.tender_kind
   where r.trading_date = new.trading_date and t.gives_change;

  select coalesce(sum(d.amount_fils), 0) into v_drops
    from cash_drop d where d.cash_session_id = new.id;

  if new.cash_received_fils <> v_received or new.change_given_fils <> v_change
     or new.cash_refunded_fils <> v_refunded or new.drops_fils <> v_drops then
    raise exception
      'CashSessionSnapshotDisagrees: cash session % for business day % recorded received %, change %, '
      'refunded %, drops %; the rows hold received %, change %, refunded %, drops %. The snapshot is '
      'the evidence as at the count, so it has to be what the rows said at the count.',
      new.id, new.trading_date,
      new.cash_received_fils, new.change_given_fils, new.cash_refunded_fils, new.drops_fils,
      v_received, v_change, v_refunded, v_drops
      using errcode = 'ZU005';
  end if;

  return null;
end $$;

comment on function cash_session_reconciles_to_the_rows() is
  'Raises ZU005 at COMMIT when a closed session''s snapshotted cash figures differ from the payment, '
  'refund and cash_drop rows for its business day. `tender_type.gives_change` selects the cash types '
  'rather than the literal ''cash'', so the registry stays the one definition of which tenders are '
  'physical money.';

create constraint trigger cash_session_reconciles_to_the_rows
  after insert or update on cash_session
  deferrable initially deferred
  for each row execute function cash_session_reconciles_to_the_rows();

-- ------------------------------------------------------------------------------------------------
-- ZU006 — no cash into a business day whose drawer has been counted
-- ------------------------------------------------------------------------------------------------
-- Without this, ZU005 protects the snapshot only until the transaction that took it commits: a cash
-- payment inserted for a business day afterwards makes a signed reconciliation wrong with nothing
-- saying so, and the next count inherits a float it cannot explain.
--
-- IMMEDIATE, and on both tables, because the caller has to be told at the statement that took the money
-- rather than at a COMMIT that also wrote an invoice. Like ZU005 it is scoped to the business day and not
-- to a drawer until `payment.drawer_code` exists (M-TILL-13).
create function refuse_cash_after_the_count() returns trigger
language plpgsql
as $$
declare
  v_gives_change boolean;
  v_closed_at    timestamptz;
  v_drawer       text;
begin
  select gives_change into v_gives_change from tender_type where code = new.tender_kind;
  if v_gives_change is not true then
    return new;
  end if;

  select s.closed_at, s.drawer_code into v_closed_at, v_drawer
    from cash_session s
   where s.trading_date = new.trading_date and s.status = 'closed'
   order by s.closed_at desc
   limit 1;

  if v_closed_at is not null then
    raise exception
      'CashTakenAfterTheDrawerWasCounted: % of % fils is dated on business day %, whose drawer "%" was '
      'counted and closed at %. Cash recorded after the count makes a signed reconciliation wrong and '
      'leaves the next float unexplainable; take it on the open business day, or correct the closed '
      'session with a cash_session_adjustment.',
      tg_table_name, new.amount_fils, new.trading_date, v_drawer, v_closed_at
      using errcode = 'ZU006';
  end if;

  return new;
end $$;

comment on function refuse_cash_after_the_count() is
  'Raises ZU006. Keeps ZU005''s guarantee true after the transaction that took the snapshot commits: a '
  'cash payment or refund dated on a counted business day is refused at the statement, not at COMMIT.';

create trigger payment_not_after_the_count before insert on payment
  for each row execute function refuse_cash_after_the_count();
create trigger refund_not_after_the_count before insert on refund
  for each row execute function refuse_cash_after_the_count();

-- ------------------------------------------------------------------------------------------------
-- cash_session_reconciliation — the cash-up sheet, as a view
-- ------------------------------------------------------------------------------------------------
-- A VIEW and not stored figures, for the reason `invoice_settlement` is one (0068): the LIVE sums belong
-- beside the snapshot so a reader can see them agree, and a second stored copy is a second thing to
-- drift. What is stored is the snapshot, because that is evidence; what is derived is the comparison.
create view cash_session_reconciliation as
  select s.id                                     as cash_session_id,
         s.drawer_code,
         s.trading_date,
         s.shift_no,
         s.status,
         s.opening_float_fils,
         s.cash_received_fils,
         s.change_given_fils,
         s.cash_refunded_fils,
         s.drops_fils,
         s.counted_float_fils,
         s.expected_float_fils,
         s.discrepancy_fils,
         -- The same figures read from the rows, now. Equal to the snapshot for a closed session by
         -- ZU005; for an OPEN one this is the only answer there is, which is what a mid-shift cash-up
         -- screen shows.
         coalesce(live.received_fils, 0)::bigint  as live_received_fils,
         coalesce(live.change_fils, 0)::bigint    as live_change_fils,
         coalesce(back.refunded_fils, 0)::bigint  as live_refunded_fils,
         coalesce(drop_total.fils, 0)::bigint     as live_drops_fils,
         cash_session_expected_float_fils(
           s.opening_float_fils,
           coalesce(live.received_fils, 0)::bigint,
           coalesce(live.change_fils, 0)::bigint,
           coalesce(back.refunded_fils, 0)::bigint,
           coalesce(drop_total.fils, 0)::bigint)  as live_expected_float_fils,
         s.count_note,
         s.journal_entry_id,
         s.opened_at,
         s.closed_at
    from cash_session s
    left join (
      select p.trading_date,
             sum(p.amount_fils)::bigint       as received_fils,
             sum(p.change_given_fils)::bigint as change_fils
        from payment p join tender_type t on t.code = p.tender_kind
       where t.gives_change
       group by p.trading_date
    ) live on live.trading_date = s.trading_date
    left join (
      select r.trading_date, sum(r.amount_fils)::bigint as refunded_fils
        from refund r join tender_type t on t.code = r.tender_kind
       where t.gives_change
       group by r.trading_date
    ) back on back.trading_date = s.trading_date
    left join (
      select d.cash_session_id, sum(d.amount_fils)::bigint as fils
        from cash_drop d group by d.cash_session_id
    ) drop_total on drop_total.cash_session_id = s.id;

comment on view cash_session_reconciliation is
  'The cash-up sheet: the snapshot a close recorded beside the live sums over payment, refund and '
  'cash_drop for the same BUSINESS DAY. A view and not stored figures (0068''s argument for '
  'invoice_settlement) - the snapshot is the evidence, the comparison is derived.';

-- ------------------------------------------------------------------------------------------------
-- Privileges
-- ------------------------------------------------------------------------------------------------
-- 0009 granted the application role select, insert, update and delete on every table in public AND set
-- default privileges extending that to tables created later, so all four tables arrive with UPDATE and
-- DELETE already granted. The door is held twice, which is 0072's and 0075's arrangement: the triggers
-- above refuse for every role, and the grants below refuse before a trigger is reached.
grant select, insert on cash_drawer, cash_session, cash_drop, cash_session_adjustment to berelax_app;

-- cash_session needs UPDATE, because closing one IS an update — and only of the columns a close writes.
-- `trading_date`, `drawer_code`, `shift_no` and `opening_float_fils` are what the reconciliation is
-- ABOUT, so a statement that could move them could re-point a counted drawer at another day.
--
-- The table-level REVOKE has to come FIRST, and leaving it out cost this unit a run: 0009 granted UPDATE
-- on every table in public to berelax_app and set default privileges extending that to tables created
-- later, so this one ARRIVED with full-table UPDATE. A column-list grant does not narrow an existing
-- table-level one — it is simply redundant beside it — so the itest that asserted 42501 on
-- `set trading_date` watched the statement succeed.
revoke update, delete on cash_session from berelax_app;
grant update (
  status, cash_received_fils, change_given_fils, cash_refunded_fils, drops_fils,
  counted_float_fils, closed_at, closed_by_actor_kind, count_note, journal_entry_id
) on cash_session to berelax_app;
revoke update, delete on cash_drop, cash_session_adjustment from berelax_app;
revoke update, delete on cash_drawer from berelax_app;

-- TRUNCATE fires no row-level trigger, so the refusals above would not see it. 0009 never granted it;
-- stated explicitly because "it was never granted" and "we checked" are different facts. A truncated
-- cash_session table is every drawer in the business un-counted with nothing saying so.
revoke truncate on cash_drawer, cash_session, cash_drop, cash_session_adjustment from berelax_app;

grant select on cash_session_reconciliation to berelax_app, berelax_readonly;
grant select on cash_drawer, cash_session, cash_drop, cash_session_adjustment to berelax_readonly;

commit;
