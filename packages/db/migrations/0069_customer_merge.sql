-- 0069 — the merge as a RECORD, and the tombstone that keeps a merged-away record answerable.
--
-- C-CRM-05. Two customer rows turn out to be one person (a typo'd digit, a second number, a SIM
-- change), and the business wants one record. Every other unit in this area produced a piece of that
-- job and deliberately left this one alone: 0055 added the indexes that find the pair, 0056 made
-- consent append-only and said a merge must re-point it by INSERT, and 0064 keyed suppression on the
-- hashed DETAIL and said a merge owes it nothing but a back-reference. This migration adds the thing
-- they all defer to — the record of what a merge actually did, per table, with the arithmetic in a
-- CHECK.
--
-- ## There is no hard delete, and the loser is not emptied
--
-- The loser's `customer` row is untouched. It keeps its number, its label, its notes and its
-- `created_at`, and `merge_record` is what makes it a TOMBSTONE rather than a duplicate: one row per
-- merge, `loser_customer_id` UNIQUE, so "has this record been merged away, and into what" is one index
-- lookup. Three reasons it is a row here rather than a `merged_into_customer_id` column on `customer`:
--
--   1. **A column would be a second source of truth.** The pair (survivor, loser) would then exist
--      twice, and the first disagreement would be silent — a tombstone column set with no record of who
--      merged it or why, or a record whose column was never written. The repository would have to keep
--      them in step and nothing would notice when it stopped.
--   2. **A merge has evidence, and evidence does not fit in a column.** Who decided, under which
--      authority, on which score, and what the two records disagreed about. `merge_record` holds all of
--      it beside the pair, where a dispute six months later can read it.
--   3. **The loser's data is still the loser's.** Reading a merged-away record has to keep working —
--      that is what a tombstone is for — and emptying the row would destroy exactly the evidence that
--      says the merge was right or wrong.
--
-- `merge_survivor_of()` is the lookup, and it is a SQL function rather than a query in one repository
-- because the clinical schema cannot call TypeScript. See the boundary note below.
--
-- ## Neither id is a foreign key
--
-- 0056's decision and for 0056's reason, restated because the temptation here is stronger: an
-- append-only log cannot hold a reference to a mutable parent. A cascade from `customer` would fire the
-- refusal trigger below and make `delete from customer` raise for every caller — including the four
-- integration files that clear that table — and a merge record has to outlive the erasure of the
-- identities it is about (docs/04 §4, §8). `survivor_customer_id` is not a foreign key either, for the
-- same reason and not as an oversight.
--
-- `merge_record_table.merge_record_id` IS a real foreign key, and the difference is that its parent is
-- one of this migration's own append-only tables: nothing can delete a `merge_record` row, so the
-- reference cannot be left dangling and no cascade can ever fire.
--
-- ## Chains are possible and cycles are not
--
-- A merged into B, and later B into C, is an ordinary sequence of events: each merge is a separate
-- decision taken at a separate time, and the first one's row may not be edited afterwards. So
-- `merge_survivor_of()` FOLLOWS the chain rather than assuming a depth of one.
--
-- What is refused is an edge INTO a record that is already a loser — merging somebody into a tombstone
-- (ZT002). It is the caller's mistake to resolve the survivor first, and refusing it has a second
-- effect worth more than the first: since every edge's head is live when it is written, and a head can
-- never become live again, no cycle can be constructed at all. The depth bound in
-- `merge_survivor_of()` is therefore a belt-and-braces guard whose firing (ZT003) would mean this
-- trigger had been dropped, and it says so rather than looping.
--
-- ## The per-table counts, and why they are a child table rather than jsonb
--
-- The acceptance criterion asks for before/after row counts per table. A `jsonb` blob would hold them
-- and could not be CHECKed, and the arithmetic is the entire claim: `rows_after_loser` must be
-- `rows_before_loser - rows_moved`, and `rows_after_survivor` must be
-- `rows_before_survivor + rows_moved + rows_inserted`. A merge that dropped rows, or counted them
-- twice, breaks one of those two identities — and a constraint that refuses to STORE the report is
-- worth more than a test that reads it afterwards, because the report is written in the merge's own
-- transaction and a refusal rolls the merge back.
--
-- `rows_retained_on_loser` is the honest half, and the third identity is the registry's whole point:
--
--   for a strategy that MOVES rows, `rows_before_loser = rows_moved + rows_retained_on_loser`.
--
-- Every row on the tombstone is therefore either re-pointed or retained WITH A STATED REASON, and a
-- strategy that quietly left rows behind cannot store its own report. Two reasons a row is retained, and
-- they are different facts rather than two spellings of one:
--
--   - **its key is already taken on the survivor.** `customer_preference` has one row per customer and
--     `customer_tag` one per tag, so the unique index refuses to re-point the loser's row at all. The
--     survivor's value stands (the provisional rule) and the loser's stays readable on the tombstone.
--   - **it is the same event recorded twice.** A `union_dedupe` participant — C-AUTO-03's frequency
--     ledger is the one this exists for — holds one row per (contact, window, message), and a message
--     recorded against both records is one message. Moving the second would double it, and the cap it
--     feeds would silence somebody for a fortnight on the strength of one send.
--
-- The strategies that COPY rather than move (`repoint_insert` for an append-only table, and the
-- back-reference an `insert_backreference` table is owed) leave every original where it was by
-- definition, so `rows_moved` is constrained to zero for them rather than left to a caller's arithmetic.
--
-- ## What this migration deliberately does NOT do
--
-- **It does not touch the clinical schema.** 0009 revokes all privileges on `clinical` from
-- `berelax_app`, so a merge — an application operation — structurally cannot re-point a treatment note,
-- an intake submission, a treatment consent or a contraindication flag. Two of those four could not be
-- re-pointed even by a role that was allowed to try: 0043's sealed-row trigger raises ZK002 on an
-- UPDATE that changes anything outside the mutable set, and `customer_id` is part of the AAD that binds
-- the ciphertext to its row, so changing it would leave a record nothing can decrypt. The clinical side
-- therefore resolves the tombstone on READ instead, which is what `merge_survivor_of()` is granted to
-- `berelax_clinical` for. `packages/db/src/merge-participants.ts` names all four in its allowlist with
-- that reason, and the completeness test refuses an unregistered table.
--
-- **It does not touch `invoice` or `checkout_finalisation`.** Both are append-only to the application
-- role (0026 and 0063 revoke UPDATE from `berelax_app`), and both carry a snapshot of the customer as
-- they were issued. A tax invoice re-attributed to another record is a different document; the read
-- that wants one person's whole history resolves the tombstone instead.
--
-- **It adds no duplicate-candidate table.** 0055 states why one would be a second source of truth, and
-- nothing here changes that.

begin;

-- ---------------------------------------------------------------------------------------------
-- The merge record
-- ---------------------------------------------------------------------------------------------

create table merge_record (
  id                   uuid        primary key default uuid_generate_v7(),
  -- The record that survived. A plain uuid with NO foreign key; see the header.
  survivor_customer_id uuid        not null,
  -- The record that became a tombstone. UNIQUE, which is what makes this table the tombstone index:
  -- a record is merged away exactly once, and a second attempt is `already_merged` rather than a
  -- second row saying something slightly different.
  loser_customer_id    uuid        not null,
  -- When the merge was decided. Supplied by the caller's clock and NOT defaulted, for the reason 0056
  -- gives for `consent.recorded_at`: every ordering assertion in this area is made under a frozen one.
  merged_at            timestamptz not null,
  -- Who. Never `customer`: a merge is a decision about somebody's records that they cannot take
  -- themselves, and an attribution that allowed it would make an unattributable merge storable.
  actor_kind           text        not null
                         constraint merge_record_actor_kind_known
                         check (actor_kind in ('staff', 'system')),
  actor_label          text        not null
                         constraint merge_record_actor_is_stated
                         check (not is_placeholder_text(actor_label) and length(actor_label) <= 200),
  -- Under what authority. `auto_merge` is the score alone, which C-CRM-02's table only ever reaches
  -- with an identical phone number; `operator_confirmed` is a person taking responsibility for a pair
  -- the score left in the review band. There is deliberately no third value: a pair the scorer calls
  -- `distinct` is not mergeable under either, because a false merge cannot be undone by a DELETE.
  authority            text        not null
                         constraint merge_record_authority_known
                         check (authority in ('auto_merge', 'operator_confirmed')),
  reason               text        not null
                         constraint merge_record_reason_is_stated
                         check (not is_placeholder_text(reason) and length(reason) <= 500),
  -- C-CRM-02's authoritative figure, in integer per-mille. Integer and not a float for that unit's
  -- reason: a score divided by 1000 round-trips, and a stored float makes every later comparison
  -- machine-dependent.
  score_per_mille      integer     not null
                         constraint merge_record_score_is_per_mille
                         check (score_per_mille between 0 and 1000),
  -- The two cells of C-CRM-02's table the score was read off. Stored because "why was this merged"
  -- must be answerable from the row: a number alone cannot say whether the phones were identical or
  -- the labels were. Pinned to PHONE_AGREEMENTS and LABEL_AGREEMENTS in @berelax/core by
  -- packages/fixtures/src/merge.itest.ts, so a vocabulary change cannot leave these two behind.
  phone_agreement      text        not null
                         constraint merge_record_phone_agreement_known
                         check (phone_agreement in ('identical', 'one_digit_apart', 'digits_transposed',
                                                    'one_digit_shifted', 'different', 'unknown')),
  label_agreement      text        not null
                         constraint merge_record_label_agreement_known
                         check (label_agreement in ('identical', 'near', 'partial', 'different',
                                                    'unknown')),
  -- Every scalar field the two records disagreed about, with the loser's value. The survivor's value
  -- wins (the provisional rule), so this is where the discarded half is kept: without it a merge that
  -- resolved a conflict would be indistinguishable from a merge that found none.
  field_resolutions    jsonb       not null
                         constraint merge_record_field_resolutions_is_an_array
                         check (jsonb_typeof(field_resolutions) = 'array'),
  -- When the ROW landed, as distinct from when the merge was decided. Two facts, both real.
  created_at           timestamptz not null default now(),
  -- A record merged into itself is a no-op dressed as an operation, and every count below would
  -- double.
  constraint merge_record_survivor_is_not_the_loser
    check (survivor_customer_id <> loser_customer_id),
  constraint merge_record_one_merge_per_loser unique (loser_customer_id)
);

comment on table merge_record is
  'One row per completed merge: which record survived, which became a tombstone, who decided, under '
  'which authority and on which score. Append-only: UPDATE and DELETE raise, for every role including '
  'the owner. `loser_customer_id` is UNIQUE, so this table IS the tombstone index and a repeated merge '
  'is answered `already_merged` from it rather than attempted twice. Neither customer id is a foreign '
  'key: 0056''s reason, restated in this file''s header.';
comment on column merge_record.loser_customer_id is
  'The merged-away record. UNIQUE. The `customer` row itself is untouched — it keeps its number, its '
  'label and its notes — so reading a merged-away record keeps working and the evidence that the merge '
  'was right survives it.';
comment on column merge_record.field_resolutions is
  'The scalar conflicts and the loser''s discarded values, from planCustomerMerge in @berelax/core. An '
  'array of {field, resolution, survivor_value, loser_value}. `phone_e164` is always here and always '
  'resolves to the survivor: the column is UNIQUE, so one record cannot hold both numbers, and the '
  'loser''s number stays reachable on the tombstone.';

create index merge_record_survivor_idx on merge_record (survivor_customer_id, merged_at desc);

-- ---------------------------------------------------------------------------------------------
-- The per-table counts
-- ---------------------------------------------------------------------------------------------

create table merge_record_table (
  id                   uuid    primary key default uuid_generate_v7(),
  -- A real foreign key, unlike the two customer ids: the parent is one of this migration's own
  -- append-only tables, so it can never be deleted and no cascade can ever fire.
  merge_record_id      uuid    not null references merge_record (id),
  -- `schema.table`, as `packages/db/src/merge-participants.ts` spells it. Text and not an enum: the
  -- registry is code, later units register into it (C-AUTO-03 and C-AUTO-07 both will), and an enum
  -- would make every registration a migration.
  participant          text    not null
                         constraint merge_record_table_participant_is_qualified
                         check (participant ~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$'),
  id_column            text    not null
                         constraint merge_record_table_id_column_is_an_identifier
                         check (id_column ~ '^[a-z_][a-z0-9_]*$'),
  strategy             text    not null
                         constraint merge_record_table_strategy_known
                         check (strategy in ('repoint_update', 'repoint_insert',
                                             'insert_backreference', 'union_dedupe')),
  rows_before_survivor integer not null check (rows_before_survivor >= 0),
  rows_before_loser    integer not null check (rows_before_loser >= 0),
  rows_after_survivor  integer not null check (rows_after_survivor >= 0),
  rows_after_loser     integer not null check (rows_after_loser >= 0),
  -- Re-pointed in place: the row is now the survivor's and is no longer the loser's.
  rows_moved           integer not null check (rows_moved >= 0),
  -- Copied onto the survivor with the original left where it was, which is the only way an append-only
  -- table can be re-pointed at all (0056).
  rows_inserted        integer not null check (rows_inserted >= 0),
  -- Rows that stayed on the tombstone, with the reason they did. See the header.
  rows_retained_on_loser integer not null check (rows_retained_on_loser >= 0),
  retained_reason      text
                         constraint merge_record_table_retained_reason_is_stated
                         check (retained_reason is null
                                or (not is_placeholder_text(retained_reason)
                                    and length(retained_reason) <= 300)),
  created_at           timestamptz not null default now(),
  constraint merge_record_table_one_row_per_participant unique (merge_record_id, participant),
  -- The two identities that are the whole claim of this table. A merge that dropped a row or counted
  -- one twice cannot write its own report, and the refusal rolls the merge back.
  constraint merge_record_table_loser_balances
    check (rows_after_loser = rows_before_loser - rows_moved),
  constraint merge_record_table_survivor_balances
    check (rows_after_survivor = rows_before_survivor + rows_moved + rows_inserted),
  -- A row left behind with no reason given is the failure the registry exists to prevent, so the
  -- reason is required exactly when there is one to give.
  constraint merge_record_table_retention_is_explained
    check ((rows_retained_on_loser > 0) = (retained_reason is not null)),
  constraint merge_record_table_retained_rows_are_still_there
    check (rows_retained_on_loser <= rows_after_loser),
  -- The registry's whole claim, as a constraint: for a strategy that MOVES rows, every row that was on
  -- the loser is either re-pointed or retained with a stated reason. A participant that silently left
  -- rows behind cannot store its report, and the refusal rolls the merge back.
  constraint merge_record_table_every_moved_row_is_accounted_for
    check (strategy not in ('repoint_update', 'union_dedupe')
           or rows_before_loser = rows_moved + rows_retained_on_loser),
  -- And its mirror for the strategies that COPY. An append-only table's originals stay where they are
  -- (0056: UPDATE raises for every role), so a non-zero `rows_moved` on one of these is arithmetic
  -- nobody could have performed.
  constraint merge_record_table_a_copied_row_did_not_move
    check (strategy not in ('repoint_insert', 'insert_backreference') or rows_moved = 0)
);

comment on table merge_record_table is
  'What one merge did to one table: the row counts on both records before and after, how many were '
  're-pointed, how many were copied, and how many could not be accounted for and stayed on the '
  'tombstone. Append-only: UPDATE and DELETE raise, for every role including the owner. The two '
  'balance constraints are the claim — a merge that lost or doubled a row cannot store its report, and '
  'the refusal happens inside the merge''s own transaction.';
comment on column merge_record_table.rows_retained_on_loser is
  'Rows that stayed on the tombstone, with `retained_reason` required whenever there are any. Either '
  'their key was already taken on the survivor (`customer_preference` has one row per customer, so the '
  'unique index refuses to re-point it) or they are the same event recorded twice and moving one would '
  'double it. merge_record_table_every_moved_row_is_accounted_for is what makes "nothing was left '
  'behind silently" a fact the database keeps rather than a promise the repository makes.';

create index merge_record_table_record_idx on merge_record_table (merge_record_id);

-- ---------------------------------------------------------------------------------------------
-- Append-only, for every role
-- ---------------------------------------------------------------------------------------------

create function refuse_merge_record_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'merge_record is append-only; % is refused. A merge that was wrong is not corrected by editing the '
    'row that records it: the record of what was done to which rows is the only evidence that says so, '
    'and an un-merge is a new operation with its own record. Nothing in this system deletes a merge '
    'either — the tombstone it created is what keeps the merged-away record answerable.',
    tg_op
    using errcode = 'ZT001';
end $$;

comment on function refuse_merge_record_change() is
  'Raises ZT001 for EVERY role including the owner: privileges cover the application role, and a '
  'migration or a psql session does not connect as the application role. A trigger and not `create '
  'rule ... do instead nothing`, which reports success and lets the caller go on believing the edit '
  'happened (0018''s argument).';

create trigger merge_record_no_update before update on merge_record
  for each row execute function refuse_merge_record_change();
create trigger merge_record_no_delete before delete on merge_record
  for each row execute function refuse_merge_record_change();
create trigger merge_record_table_no_update before update on merge_record_table
  for each row execute function refuse_merge_record_change();
create trigger merge_record_table_no_delete before delete on merge_record_table
  for each row execute function refuse_merge_record_change();

-- ---------------------------------------------------------------------------------------------
-- No merging into a tombstone
-- ---------------------------------------------------------------------------------------------

create function assert_merge_survivor_is_live() returns trigger
language plpgsql
as $$
declare
  v_its_survivor uuid;
begin
  select m.survivor_customer_id into v_its_survivor
    from merge_record m
   where m.loser_customer_id = new.survivor_customer_id;

  if v_its_survivor is not null then
    raise exception
      'MergeSurvivorIsATombstone: customer % was itself merged into % and cannot be the survivor of '
      'another merge. Resolve the survivor first — merge_survivor_of(%) answers it — and merge into '
      'that record. Allowing this would let a merge point at a record nothing reads, and it is also '
      'what makes a cycle constructible: every edge''s head is live when it is written, and a head '
      'never becomes live again, so refusing this refuses every cycle.',
      new.survivor_customer_id, v_its_survivor, new.survivor_customer_id
      using errcode = 'ZT002';
  end if;

  return new;
end $$;

comment on function assert_merge_survivor_is_live() is
  'Raises ZT002 when the survivor of a new merge is itself a tombstone. Also the reason cycles are '
  'impossible, which is why merge_survivor_of()''s depth bound is a guard rather than a limit.';

create trigger merge_record_survivor_is_live before insert on merge_record
  for each row execute function assert_merge_survivor_is_live();

-- ---------------------------------------------------------------------------------------------
-- The lookup
-- ---------------------------------------------------------------------------------------------

create function merge_survivor_of(p_customer_id uuid) returns uuid
language plpgsql
stable
as $$
declare
  v_current uuid := p_customer_id;
  v_next    uuid;
  v_hops    integer := 0;
begin
  if p_customer_id is null then return null; end if;

  loop
    select m.survivor_customer_id into v_next
      from merge_record m
     where m.loser_customer_id = v_current;

    -- Not a tombstone: this is the record itself, which is the answer for every customer that has
    -- never been merged. Returning the input rather than NULL is what lets a caller wrap a read in
    -- this function unconditionally.
    if v_next is null then return v_current; end if;

    v_current := v_next;
    v_hops := v_hops + 1;
    if v_hops > 32 then
      raise exception
        'MergeChainTooLong: following merge_record from customer % has taken more than 32 hops. The '
        'insert trigger assert_merge_survivor_is_live() makes a cycle impossible, so this means that '
        'trigger is missing rather than that somebody merged 32 records in a chain.',
        p_customer_id
        using errcode = 'ZT003';
    end if;
  end loop;
end $$;

comment on function merge_survivor_of(uuid) is
  'The live record a customer id resolves to, following merge_record to the end of the chain and '
  'returning the id itself when it is not a tombstone. A SQL function rather than a query in one '
  'repository because the readers that need it are not all in one place: the clinical schema cannot '
  'call TypeScript, and 0009 revokes all privileges on `clinical` from the application role, so a '
  'clinical read resolving a merged-away customer has to do it here.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 grants the application role select, insert, update and delete on every table created in
-- `public` afterwards. Stated explicitly first rather than relied upon, because a managed database
-- restored from a dump does not necessarily carry the same defaults, and then revoked down to what
-- these tables allow — the same belt and braces 0063 and 0064 use, and for the same reason: the
-- triggers above raise for every role, and these make the application role unable to try.
grant select, insert on merge_record, merge_record_table to berelax_app;
revoke update, delete on merge_record, merge_record_table from berelax_app;
revoke truncate on merge_record, merge_record_table from berelax_app;

-- The clinical role reads the tombstone and nothing else in this pair. It holds `select` on public
-- tables from 0009 already; the grant that matters is on the function, because a clinical read that
-- cannot resolve a merged-away customer id silently returns nothing for a record that exists.
grant execute on function merge_survivor_of(uuid) to berelax_app, berelax_clinical, berelax_readonly;

commit;
