-- 0094 — one private SQLSTATE, one rule: the nine codes that stood for two rules each are separated.
--
-- W-SYS-12. Nothing here creates a table, a column or a constraint. It `create or replace`s nine trigger
-- functions and changes one thing in each: the five characters the refusal carries. Everything else in
-- every body below is copied verbatim from the migration that defined it, deliberately, so that a reader
-- diffing this file against 0069, 0077, 0081 and 0087 sees exactly one changed token per function.
--
-- ## What was wrong
--
-- Every refusal in this schema carries a private SQLSTATE so a caller can branch on the RULE rather than on
-- a message, and every translator in `packages/db` matches on the code ALONE. A code standing for two rules
-- therefore breaks three things at once and none of them loudly: a translator reports one file's refusal as
-- the other's with a plausible message and the wrong cause; a probe asserting the code passes when the
-- statement bounced off something else entirely; and the test meant to prove a rule fires proves only that
-- SOMETHING did.
--
-- Thirteen codes were shared when this unit started. Nine of them were two DIFFERENT rules and are the
-- subject of this file:
--
--     was    now     the rule that MOVED (the later migration, which took a class it could not see was
--                    already taken), and the rule that KEPT the code
--     -----  -----   ----------------------------------------------------------------------------------
--     ZT001  ZT005   moved: 0069 merge_record/merge_record_table is append-only
--                    kept:  0068's overpayment ceiling, live in 0083's payment_within_the_document()
--     ZT002  ZT006   moved: 0069 the survivor of a new merge may not itself be a tombstone
--                    kept:  0068 change against a tender that gives none
--     ZT003  ZT007   moved: 0069 merge_survivor_of() walked more than 32 hops
--                    kept:  0068 a tender kind that requires a reference carries none
--     ZU001  ZU008   moved: 0077 a card's stage changed with no transition recording the move
--                    kept:  0076 a cash session cannot be closed with no counted amount
--     ZU002  ZU009   moved: 0077 pipeline_stage_transition is append-only
--                    kept:  0076 a counted-and-closed cash session, and the movement rows behind it
--     ZU003  ZU010   moved: 0077 pipeline_stage positions must be 1..n with no gap
--                    kept:  0076 a cash session or adjustment dated in a locked accounting period
--     ZW001  ZW006   moved: 0081 a published rota version is immutable
--                    kept:  0080 the frequency cap must be a whole number of at least 1
--     ZW002  ZW007   moved: 0081 rota_change_request is append-only
--                    kept:  0080 a counted send may not be re-dated or un-counted
--     ZX001  ZX006   moved: 0087 the promotional window may only ever be narrowed
--                    kept:  0086 attendance is append-only
--
-- The moved side is the later migration in every one of the nine, which is not a coincidence: a unit picks
-- a class by reading the migrations it can see, and the second unit to reach for a class is the one whose
-- worktree could not see the first. The code that STAYS is the one already named in more translators,
-- probes and headers, so moving the later side is also the smaller change.
--
-- ## The four that are NOT moved, and why they were never collisions
--
-- ZB001, ZB002, ZL002 and ZV002 were in the same allowlist and are ONE rule each. In every case a later
-- migration `create or replace`s the SAME function, so the earlier file's `raise` is dead text and only one
-- definition can ever execute:
--
--     ZB001  assert_room_capacity()                     0024, replaced by 0038
--     ZB002  assert_room_capacity_covers_commitments()  0024, replaced by 0038
--     ZL002  raise_if_period_locked()                   0018, replaced by 0073
--     ZV002  assert_bill_totals_match_lines()           0028, replaced by 0034, replaced by 0039
--
-- The detector that found the thirteen keyed on "which FILES contain this code", which cannot tell a
-- superseded definition from a second rule — so three of its thirteen entries described a collision that
-- did not exist, and the fourth (ZL002) was described as "0018 raises it from the shared function, 0073
-- from its caller" when 0073 in fact replaces that function. The check now resolves each raising function
-- to its LIVE definition before comparing, which is a measurement rather than an allowlist and is why
-- these four need no migration. `packages/db/src/sqlstate-registry.ts` records the rule for each.
--
-- ## Why the allocations are subclasses of the class each rule already sat in
--
-- ZA through ZZ are all in use: the convention that a CLASS identifies a migration file ran out at 0093,
-- which took the last free class. W-SYS-12's answer is that a refusal is identified by all FIVE characters
-- — two unrelated rules may share a class and must never share a code — so the class a rule already sits
-- in is exactly where its replacement belongs. Each moved rule takes the next free subclass of its own
-- class, which keeps each file's family contiguous (0069 now holds ZT005-ZT007, 0077 ZU008-ZU010, 0081
-- ZW003-ZW007, 0087 ZX006) and takes nothing from the ZY bands reserved to units in flight.
--
-- ## Why the migrations that defined these functions are NOT edited
--
-- 0069, 0077, 0081 and 0087 still say `errcode = 'ZT001'` and so on, inside definitions this file
-- supersedes. That is deliberate: a numbered migration is a record of what was applied, and editing an
-- applied file makes the history of a refusal unreadable. The check reads the live definition, so the dead
-- text costs nothing — and a future migration that `create or replace`s one of these functions back onto
-- its old code fails `pnpm sqlstate` rather than silently re-creating the collision.

begin;

-- ---------------------------------------------------------------------------------------------
-- 0069 — the customer merge. ZT001 -> ZT005, ZT002 -> ZT006, ZT003 -> ZT007.
-- ---------------------------------------------------------------------------------------------

create or replace function refuse_merge_record_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'merge_record is append-only; % is refused. A merge that was wrong is not corrected by editing the '
    'row that records it: the record of what was done to which rows is the only evidence that says so, '
    'and an un-merge is a new operation with its own record. Nothing in this system deletes a merge '
    'either — the tombstone it created is what keeps the merged-away record answerable.',
    tg_op
    using errcode = 'ZT005';
end $$;

comment on function refuse_merge_record_change() is
  'Raises ZT005 for EVERY role including the owner: privileges cover the application role, and a '
  'migration or a psql session does not connect as the application role. A trigger and not `create '
  'rule ... do instead nothing`, which reports success and lets the caller go on believing the edit '
  'happened (0018''s argument). ZT005 and not ZT001, which 0068''s overpayment ceiling holds: 0094 '
  'separated the two.';

create or replace function assert_merge_survivor_is_live() returns trigger
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
      using errcode = 'ZT006';
  end if;

  return new;
end $$;

comment on function assert_merge_survivor_is_live() is
  'Raises ZT006 when the survivor of a new merge is itself a tombstone. Also the reason cycles are '
  'impossible, which is why merge_survivor_of()''s depth bound is a guard rather than a limit. ZT006 and '
  'not ZT002, which 0068''s tender rules hold: 0094 separated the two.';

create or replace function merge_survivor_of(p_customer_id uuid) returns uuid
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
        using errcode = 'ZT007';
    end if;
  end loop;
end $$;

comment on function merge_survivor_of(uuid) is
  'The live record a customer id resolves to, following merge_record to the end of the chain and '
  'returning the id itself when it is not a tombstone. A SQL function rather than a query in one '
  'repository because the readers that need it are not all in one place: the clinical schema cannot '
  'call TypeScript, and 0009 revokes all privileges on `clinical` from the application role, so a '
  'clinical read resolving a merged-away customer has to do it here. Its depth bound raises ZT007 and '
  'not ZT003, which 0068''s tender rules hold: 0094 separated the two.';

-- ---------------------------------------------------------------------------------------------
-- 0077 — the CRM pipeline. ZU001 -> ZU008, ZU002 -> ZU009, ZU003 -> ZU010.
-- ---------------------------------------------------------------------------------------------

create or replace function assert_pipeline_stage_positions_are_gapless() returns trigger
language plpgsql
as $$
declare
  v_count integer;
  v_min   integer;
  v_max   integer;
begin
  select count(*), min(display_order), max(display_order) into v_count, v_min, v_max
    from pipeline_stage;
  -- An empty table is gapless. The board is then empty, which is a different problem and not this
  -- trigger's: refusing it here would make the last stage undeletable for no reason anybody could act on.
  if v_count = 0 then
    return null;
  end if;
  if v_min <> 1 or v_max <> v_count then
    raise exception
      'pipeline_stage positions must be 1..%, with no duplicate and no gap; they are %..% over % row(s). '
      'A gap renders an empty column between two full ones, which reads as a stage nobody is at. Reorder '
      'the stages as a PERMUTATION (reorderPipelineStages) rather than by editing one position.',
      v_count, v_min, v_max, v_count
      using errcode = 'ZU010';
  end if;
  return null;
end $$;

comment on function assert_pipeline_stage_positions_are_gapless() is
  'Raises ZU010 when pipeline_stage.display_order is not 1..n. Deferred to COMMIT, so a reorder may pass '
  'through states that hold a gap; distinctness comes from pipeline_stage_display_order_unique, which is '
  'what makes three aggregates a sufficient test. ZU010 and not ZU003, which 0076''s cash session holds: '
  '0094 separated the two.';

create or replace function refuse_pipeline_transition_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'pipeline_stage_transition is append-only; % is refused. The log is the only evidence that a card '
    'moved and who moved it, and customer_pipeline_card_records_every_move reads it at COMMIT - so a '
    'caller that could remove a row could move a card with nothing recording the move.',
    tg_op
    using errcode = 'ZU009';
end $$;

comment on function refuse_pipeline_transition_change() is
  'Raises ZU009 (PipelineTransitionImmutable) for pipeline_stage_transition, for every role including '
  'the owner. A correction is a new move, not an edit to the record of the old one. ZU009 and not ZU002, '
  'which 0076''s cash session holds: 0094 separated the two.';

create or replace function assert_pipeline_card_move_is_recorded() returns trigger
language plpgsql
as $$
declare
  v_from text;
begin
  -- An UPDATE that does not touch the stage is not a move. Without this the trigger would refuse every
  -- unrelated write to the row, and the first one is `set_updated_at`'s own.
  if tg_op = 'UPDATE'
     and new.stage_key is not distinct from old.stage_key
     and new.stage_entered_at is not distinct from old.stage_entered_at then
    return null;
  end if;

  v_from := case when tg_op = 'UPDATE' then old.stage_key else null end;

  -- `is not distinct from` on the FROM column, because it is nullable on an insert and `= null` is
  -- NULL: a comparison that silently answers NULL is how a guard comes to pass everything (0065's note).
  if not exists (
    select 1 from pipeline_stage_transition t
     where t.customer_id = new.customer_id
       and t.to_stage_key = new.stage_key
       and t.from_stage_key is not distinct from v_from
       and t.occurred_at = new.stage_entered_at
  ) then
    raise exception
      'customer_pipeline_card.stage_key changed from % to % for contact % with no pipeline_stage_'
      'transition recording that move at %. A stage is a claim somebody made about a person, so the '
      'claim and its record are one transaction: move the card with moveCard, which writes both.',
      coalesce(v_from, '(none)'), new.stage_key, new.customer_id, new.stage_entered_at
      using errcode = 'ZU008';
  end if;
  return null;
end $$;

comment on function assert_pipeline_card_move_is_recorded() is
  'Raises ZU008 when a customer_pipeline_card row is created or its stage changed without a matching '
  'pipeline_stage_transition row - same contact, same from, same to, same instant. Deferred to COMMIT, '
  'because the log cannot be written before the card it describes exists; and for every role including '
  'the owner, because the owner is who moves a card by hand at 02:00. ZU008 and not ZU001, which 0076''s '
  'cash session holds: 0094 separated the two.';

-- Three of 0077's table and column comments named the old codes, and they are re-issued here with the new
-- ones. A `comment on` is schema STATE — `\d+` shows it, and it is what the next person reads — so unlike
-- the migration text above it is not a record of what was once true. Word for word 0077's, one code changed.
comment on column pipeline_stage.display_order is
  'The column order: 1..n over every row in this table, archived ones included. Unique (deferred) and '
  'gapless (pipeline_stage_positions_are_gapless, ZU010). A duplicate renders one column twice and a gap '
  'renders an empty column between two full ones, which reads as a stage nobody is at.';

comment on table pipeline_stage_transition is
  'Every move of a card between columns: who, from where, to where, and when. Append-only: UPDATE and '
  'DELETE raise ZU009 for every role including the owner, because this log is the only evidence that a '
  'stage change happened and who made it - and because customer_pipeline_card_records_every_move reads '
  'it at COMMIT, a writer that could delete a row could move a card with no record of the move.';

comment on table customer_pipeline_card is
  'Where one contact is on the pipeline board. One row per person - the customer id IS the primary key - '
  'so two cards for one person are unrepresentable. Every change of stage_key must be accompanied by a '
  'pipeline_stage_transition row for exactly that move (ZU008), checked at COMMIT for every role '
  'including the owner. Named under customer_ deliberately: the row is what the front desk says about a '
  'person, so it is in the CRM audit area and customer_pipeline_card_audit covers it.';

-- ---------------------------------------------------------------------------------------------
-- 0081 — the HR rota version. ZW001 -> ZW006, ZW002 -> ZW007.
-- ---------------------------------------------------------------------------------------------

create or replace function refuse_published_rota_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'A published rota version is immutable; % on % is refused. An edit to a published rota is a NEW '
    'rota_version carrying supersedes_id, which is what lets a swap, a sickness or a correction be seen '
    'as a change rather than as the rota having always said something else.',
    tg_op, tg_table_name
    using errcode = 'ZW006';
end $$;

comment on function refuse_published_rota_change() is
  'Raises ZW006 (PublishedRotaImmutable) for rota_version and rota_version_assignment, for every role '
  'including the owner. An edit is a new version, not an UPDATE of the old one. ZW006 and not ZW001, '
  'which 0080''s frequency cap holds: 0094 separated the two.';

create or replace function refuse_rota_change_request_edit() returns trigger
language plpgsql
as $$
begin
  raise exception
    'rota_change_request is append-only; % is refused. A request that was refused stays refused: the '
    'remedy is a new request against the rota as it now stands, and rewriting the old one would erase '
    'the only record of what the validator said.',
    tg_op
    using errcode = 'ZW007';
end $$;

comment on function refuse_rota_change_request_edit() is
  'Raises ZW007 (RotaChangeRequestImmutable) for every role including the owner. A refused request is '
  'answered by a new request, not by editing the record of the old one. ZW007 and not ZW002, which '
  '0080''s frequency ledger holds: 0094 separated the two.';

-- ---------------------------------------------------------------------------------------------
-- 0087 — the messaging compliance gate. ZX001 -> ZX006.
--
-- 0087's own header already reported this collision and said it was "reported rather than repaired here".
-- This is the repair.
-- ---------------------------------------------------------------------------------------------

create or replace function assert_promotional_window_is_a_narrowing()
returns trigger
language plpgsql
as $$
begin
  if new.key <> 'messaging.promotional_window'
     or promotional_window_is_a_narrowing(new.value) then
    return new;
  end if;

  raise exception
    '% cannot be set to %: the promotional send window is not switchable. It may only ever be NARROWED '
    'inside 07:00-21:00 Asia/Dubai, must be an object of two whole hours, and must actually open - '
    '{"startHour": 21, "endHour": 21} is inside the ceiling and permits nothing, which holds every '
    'promotional message for ever with nothing saying why. TDRA restricts promotional SMS to those hours '
    'and the sanction is sender-ID SUSPENSION rather than a per-message fine, so a send at 21:30 stops the '
    'booking confirmations too. To stop promotional traffic, engage the marketing kill switch, which says '
    'so on its face and records who engaged it. To narrow the window for Ramadan, add a dated row to '
    'business_calendar rather than editing this one, so the narrowing ends when Ramadan does '
    '(Y9-ramadan-window).',
    new.key, coalesce(new.value::text, 'NULL')
    using errcode = 'ZX006';
end $$;

comment on function assert_promotional_window_is_a_narrowing() is
  'Raises ZX006 when messaging.promotional_window is set to anything but an object of two whole hours with '
  '7 <= startHour < endHour <= 21. The CHECK constraint beside it calls the same predicate and is the layer '
  'that still holds when session_replication_role has triggers off, which is how a restore runs. ZX006 and '
  'not ZX001, which 0086''s attendance tables hold: 0094 separated the two.';

commit;
