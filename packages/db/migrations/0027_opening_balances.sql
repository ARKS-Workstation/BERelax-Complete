-- 0027 — opening balances: the one entry a set of books starts from, and the date before which nothing
-- may be posted.
--
-- This business is already trading. Its books do not start at zero on the day this system goes live; they
-- start at whatever the previous arrangement left behind, and that closing position becomes this system's
-- opening entry. Getting it wrong is not a rounding error — every balance sheet the system ever produces
-- is the opening entry plus everything since, so an opening entry that is out by a dirham is a balance
-- sheet that is out by a dirham for ever, and the discrepancy surfaces during a VAT return.
--
-- Three rules, and each has a specific failure behind it.
--
-- **One import, ever.** The unique key on `(legal_entity_id, opening_date)` makes a second import raise
-- rather than double every balance. An import script run twice because somebody was not sure the first
-- had worked is the normal way this happens, and it is undetectable afterwards: the books balance, they
-- are simply twice the size.
--
-- **Nothing may be dated before the opening date.** Not "should not" — a posting before the opening date
-- is a posting into the period the opening entry already summarises, so it is counted twice. The guard is
-- a trigger rather than a check in the application, because there are five posting paths (invoice, bill,
-- credit note, payment, redemption) and a rule enforced in five places is a rule with five chances to be
-- forgotten. The opening entry itself is exempt, obviously, and so is a reversal of it.
--
-- **Zero is provisional, not confirmed.** Y8-opening-balances is unanswered: nobody has supplied the
-- real figures. Seeding zeros and flagging them `is_provisional` puts them in the Unconfirmed Assumptions
-- panel, where the difference between "the owner told us the balances are zero" and "nobody has told us
-- anything" is visible. Seeding zeros silently would make an unstarted task look like a finished one.

begin;

create table opening_balance_import (
  import_id       uuid        primary key default uuid_generate_v7(),
  legal_entity_id smallint    not null references legal_entity (id),
  -- The date the books open. Every posting must be on or after it.
  opening_date    date        not null,
  -- The journal entry this import posted. One entry, not one per account: the opening position is a
  -- single balanced document, and a per-account entry would let half of it commit.
  entry_id        text        not null references journal_entry (entry_id),
  -- The sum of the debit side, for a reader who wants the size of the import without joining the lines.
  -- Derived, and asserted against the lines by the itest rather than trusted.
  total_debit_fils  fils_nonneg not null,
  total_credit_fils fils_nonneg not null,
  -- Y8-opening-balances. True while the figures are the build's assumption rather than the owner's
  -- answer, which is what the Unconfirmed Assumptions panel reads.
  is_provisional   boolean     not null default false,
  provisional_note text,
  open_question_id text,
  imported_at      timestamptz not null default now(),
  imported_by      text        not null,
  -- One import per entity per opening date. The whole protection against a double import.
  unique (legal_entity_id, opening_date),
  -- A provisional row names the question it is waiting on, or the panel has a value and nothing to ask
  -- about it. Same rule as app_setting and service_variant.
  constraint opening_balance_import_provisional_names_a_question
    check (not is_provisional or open_question_id is not null),
  constraint opening_balance_import_balances
    check (total_debit_fils = total_credit_fils)
);

comment on table opening_balance_import is
  'One row per opening-balance import. unique (legal_entity_id, opening_date) is what makes a second '
  'import raise instead of doubling every balance — which is undetectable afterwards, because the books '
  'still balance.';
comment on column opening_balance_import.opening_date is
  'The date the books open. journal_entry_not_before_opening refuses any entry dated earlier.';

-- No updated_at: an import is a fact, not a record that gets revised. A corrected opening position is a
-- dated reversal plus a fresh import, like every other correction in this ledger (ADR 0017).

create index opening_balance_import_provisional_idx
  on opening_balance_import (legal_entity_id) where is_provisional;

-- ---------------------------------------------------------------------------------------------
-- Nothing may be posted before the books open
-- ---------------------------------------------------------------------------------------------

create or replace function opening_date_for(p_entity smallint default 1)
returns date
language sql
stable
as $$
  -- `min`, not `select opening_date`. The unique key is on (legal_entity_id, opening_date), so a second
  -- import at a *different* date is permitted — that is how a re-based or corrected opening position is
  -- expressed. With two rows, an unaggregated select returns whichever row the planner reaches first, and
  -- a guard whose threshold depends on the plan is not a guard. The earliest date is the right answer: the
  -- books opened when they first opened, and nothing may be dated before that whatever was imported later.
  select min(opening_date) from opening_balance_import where legal_entity_id = p_entity
$$;

comment on function opening_date_for(smallint) is
  'The earliest date the books open, or null before any import. Null means no guard: a system that refused '
  'every posting until the opening balances were imported could not be set up at all.';

create or replace function refuse_entry_before_opening()
returns trigger
language plpgsql
as $$
declare
  v_opening date;
begin
  v_opening := opening_date_for();

  -- Before the import there is nothing to be before. This is also what lets the opening entry itself be
  -- inserted: it commits, and only then does the import row exist to guard against it.
  if v_opening is null then
    return new;
  end if;

  if new.entry_date >= v_opening then
    return new;
  end if;

  -- An opening balance and a reversal of one are the two entries that may legitimately predate the
  -- opening date: the first IS the opening position, and the second corrects it. Everything else dated
  -- earlier is a posting into the period the opening entry already summarises, and is therefore counted
  -- twice.
  if new.source in ('opening_balance', 'reversal') then
    return new;
  end if;

  raise exception
    'BeforeOpeningBalance: entry % is dated % but the books open on %',
      new.entry_id, new.entry_date, v_opening
    using errcode = 'ZL004',
          hint = 'A transaction before the opening date is already inside the opening balance.';
end
$$;

-- On journal_entry only, not on journal_line. The entry carries the date; a line has none, and a second
-- trigger reading the parent's date would fire once per line to reach the same conclusion.
create trigger journal_entry_not_before_opening before insert on journal_entry
  for each row execute function refuse_entry_before_opening();

comment on function refuse_entry_before_opening() is
  'Raises ZL004 BeforeOpeningBalance. A trigger rather than five checks in five posting paths (invoice, '
  'bill, credit note, payment, redemption), because a rule enforced in five places has five chances to '
  'be forgotten and the one that is forgotten is the one that double-counts.';

-- The application role may read and insert; it may not rewrite an import. Same shape as the ledger's
-- own revokes in 0018 — and default privileges in 0009 grant all four, so these are load-bearing.
revoke all on opening_balance_import from berelax_app;
grant select, insert on opening_balance_import to berelax_app;

commit;
