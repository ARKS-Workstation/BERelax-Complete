-- 0013 — gap-free statutory document numbering: a counter row per series, locked inside the
-- transaction that inserts the document.
--
-- The obvious mechanism is a `SEQUENCE`, and it is wrong here. `nextval` is deliberately
-- non-transactional: it takes no lock and it does not roll back. A transaction that allocates a
-- number and then fails — a card decline, a constraint violation, a dropped connection — consumes the
-- number permanently and leaves a hole in the issued range. That is the right trade for a surrogate
-- key and the wrong one for a tax invoice number, because a hole is precisely what a tax authority
-- asks about, and "the till crashed in March" is not a record.
--
-- So the counter is an ordinary row. `update ... returning` takes a row-level exclusive lock held
-- until the transaction ends, so concurrent issuers serialise on that one row and a rollback returns
-- the number to the pool. Throughput is irrelevant here: a spa issues tens of documents a day, not
-- thousands a second, so serialising costs nothing worth having.
--
-- See docs/03-modules.md §7, docs/adr/0017 and docs/adr/0023.

begin;

-- ---------------------------------------------------------------------------------------------
-- The series
-- ---------------------------------------------------------------------------------------------
-- Tax invoices, simplified invoices and credit notes are independent statutory ranges. They are
-- separate ROWS, not separate sequences and not a discriminator over one shared counter: a shared
-- counter would make the credit-note range depend on invoice volume, so 'CN-00042' would not be the
-- forty-second credit note and no gap report could say otherwise.
create table document_series (
  code           text        primary key,
  document_kind  text        not null
    check (document_kind in ('tax_invoice', 'simplified_invoice', 'credit_note')),

  -- Format, held as data. Changing it must change only what is issued NEXT: the formatted string is
  -- stored on the document at issue and never re-derived, so an admin renaming a prefix cannot
  -- renumber an invoice already handed to a customer or filed with a return.
  --
  -- The prefix is used verbatim and carries its own separator ('TI-' -> 'TI-2026-00001'). A separate
  -- separator column would be a second field to keep consistent with the first, and buys nothing.
  prefix         text        not null check (prefix <> ''),
  -- MINIMUM width, not fixed width — see document_number_display().
  padding        smallint    not null check (padding between 1 and 18),
  -- 'annual' restarts at 1 for each calendar year of the document's trading date, and the year
  -- becomes part of the display number, so 'TI-2026-00001' and 'TI-2027-00001' are distinct.
  -- 'never' runs one unbroken range forever.
  reset_policy   text        not null check (reset_policy in ('never', 'annual')),

  -- The counter. `next_number` is the number the NEXT allocation will issue, so a fresh series
  -- issues 1. `period_key` is the reset period the counter currently belongs to: '' under the
  -- 'never' policy, the four-digit year under 'annual'.
  next_number    bigint      not null default 1 check (next_number >= 1),
  period_key     text        not null default '',

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table document_series is
  'One row per statutory numbering range. The row IS the counter: allocation is an UPDATE inside the '
  'document insert transaction, so a rollback leaves no gap. A SEQUENCE cannot do that (ADR 0023).';
comment on column document_series.next_number is
  'The number the next allocation will issue. Only allocate_document_number() may move it: the '
  'application role holds no UPDATE privilege on this column.';
comment on column document_series.padding is
  'Minimum zero-padded width. A wider number is NOT truncated; see document_number_display().';

create trigger document_series_updated_at before update on document_series
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Formatting, in one place
-- ---------------------------------------------------------------------------------------------
-- The display number is composed here and nowhere else. It is deliberately NOT reimplemented in
-- TypeScript: two implementations of a statutory identifier format is one implementation plus a
-- future discrepancy, and the discrepancy would be found on a document that is already filed.
create function document_number_display(
  p_prefix     text,
  p_period_key text,
  p_padding    smallint,
  p_number     bigint
) returns text
language sql
immutable
strict
as $$
  select p_prefix
      || case when p_period_key = '' then '' else p_period_key || '-' end
      -- `lpad(x, n)` TRUNCATES when x is longer than n, so a series padded to 3 renders number 1000
      -- as '100' — a byte-identical duplicate of number 100's display number, in a value whose whole
      -- job is to identify one document. greatest() makes the padding a floor instead of a cage.
      || lpad(p_number::text, greatest(p_padding, length(p_number::text)), '0');
$$;

comment on function document_number_display(text, text, smallint, bigint) is
  'The single definition of a document number string. Padding is a minimum width: lpad() alone '
  'truncates a too-wide number into a duplicate of a smaller one.';

-- The reset period a document issued on a given trading date belongs to.
--
-- It takes a DATE, not a timestamp and not now(): trading runs 11:00-02:00, so the year a 01:30
-- document belongs to is a property of its trading date (resolveTradingDate in @berelax/core), not
-- of the instant it was rung up in whatever timezone the session happened to be carrying.
create function document_series_period_key(p_reset_policy text, p_trading_date date)
returns text
language plpgsql
immutable
as $$
begin
  if p_reset_policy = 'never' then
    return '';
  elsif p_reset_policy = 'annual' then
    return to_char(p_trading_date, 'YYYY');
  end if;
  -- Not defensive noise. A silent null here would never equal the stored period_key, so every
  -- allocation would look like the start of a new period and reset the counter to 1 — issuing
  -- duplicate numbers instead of raising.
  raise exception 'unknown document series reset policy: %', p_reset_policy
    using errcode = 'invalid_parameter_value';
end $$;

-- ---------------------------------------------------------------------------------------------
-- Allocation
-- ---------------------------------------------------------------------------------------------
-- A composite type rather than RETURNS TABLE: the OUT parameters of a RETURNS TABLE function are
-- plpgsql variables, and `period_key` as both a variable and a column of the table being updated is
-- an ambiguity waiting to be resolved the wrong way.
create type document_number as (
  series_code    text,
  period_key     text,
  number         bigint,
  display_number text
);
comment on type document_number is
  'An allocated document number: the integer for gap reporting, the formatted string for the '
  'document. The string is stored by the caller, never recomputed from the integer later.';

-- Called INSIDE the transaction that inserts the document.
--
-- One statement on purpose: `select ... for update` followed by a separate `update` holds the same
-- lock, but between the two the counter row still reads as the old value to anything that looks, and
-- the two-statement shape is the one that tempts a caller into allocate-then-insert-in-a-new-
-- transaction — which is the allocate-then-leak-a-gap bug wearing a lock.
--
-- RETURNING yields the NEW row, so the number just allocated is `next_number - 1`.
--
-- SECURITY DEFINER with a pinned search_path, because the application role is deliberately denied
-- UPDATE on next_number (see the grants below). This function is then the only path to the counter,
-- so no code path — and no injected statement — can wind it back or set it by hand.
create function allocate_document_number(p_series_code text, p_trading_date date)
returns document_number
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  allocated document_number;
begin
  update document_series s
     set next_number = case
           -- Same period: hand out the current number and advance by one.
           when s.period_key = document_series_period_key(s.reset_policy, p_trading_date)
             then s.next_number + 1
           -- A new period under the 'annual' policy: this document is number 1 of the new year, so
           -- the next one is 2.
           else 2
         end,
         period_key = document_series_period_key(s.reset_policy, p_trading_date)
   where s.code = p_series_code
  returning s.code,
            s.period_key,
            s.next_number - 1,
            document_number_display(s.prefix, s.period_key, s.padding, s.next_number - 1)
    into allocated;

  -- No row updated means no such series. Returning null would let the caller insert a document with
  -- a null number; raising fails the document transaction, which is the correct outcome.
  if allocated.series_code is null then
    raise exception 'unknown document series: %', p_series_code
      using errcode = 'foreign_key_violation';
  end if;

  return allocated;
end $$;

comment on function allocate_document_number(text, date) is
  'Allocates the next number in a series. MUST be called inside the document insert transaction: the '
  'UPDATE row lock is what serialises issuers, and the rollback is what closes the gap.';

-- ---------------------------------------------------------------------------------------------
-- Privileges: the counter is reachable only through the function
-- ---------------------------------------------------------------------------------------------
-- 0009 granted the application role UPDATE on every table in public, and its default privileges
-- extend that to this one. That would let any code path — or any injected statement — set
-- next_number to a value already issued, and a duplicate tax invoice number is worse than a gap:
-- two customers hold the same document reference and neither copy is wrong.
revoke insert, update, delete on document_series from berelax_app;
-- The FORMAT is configuration and an admin may change it. The COUNTER is not configuration.
grant update (prefix, padding, reset_policy) on document_series to berelax_app;

-- Adding or retiring a statutory series is a migration, not a settings screen: a series inserted
-- with next_number = 500 begins its issued range at 500, which the gap report then reports forever.
-- Hence no INSERT either.

-- A SECURITY DEFINER function runs with the owner's privileges, so EXECUTE for PUBLIC (the default)
-- would hand the counter to every role in the cluster, including berelax_readonly.
revoke execute on function allocate_document_number(text, date) from public;
grant execute on function allocate_document_number(text, date) to berelax_app;

-- ---------------------------------------------------------------------------------------------
-- The three series
-- ---------------------------------------------------------------------------------------------
-- `on conflict do nothing` so re-applying is safe, and so a format change made later in the
-- application is not silently reverted by a re-run of this migration.
insert into document_series (code, document_kind, prefix, padding, reset_policy) values
  ('TAX-INV',   'tax_invoice',        'TI-', 5, 'annual'),
  ('SIMPL-INV', 'simplified_invoice', 'SI-', 5, 'annual'),
  ('CR-NOTE',   'credit_note',        'CN-', 5, 'annual')
on conflict (code) do nothing;

commit;
