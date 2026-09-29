-- 0111_migration_staging.sql — H-MIG-01
--
-- The `import_staging` schema: the substrate every H-MIG importer (H-MIG-02 .. H-MIG-11) runs on. A
-- staging ledger, per-row provenance, and the two database-side rules that make an import resumable and
-- an imported figure defensible.
--
-- ============================================================================================
-- Why the schema is called `import_staging` and not `staging`
-- ============================================================================================
--
-- `staging` is an APP_ENV value — `packages/config/src/env.ts` lists development, test, preview, staging
-- and production — so a schema of that name would read as "the schema the staging deployment uses" to
-- every person who met it after this file. It is not that: it is where IMPORTED DATA sits while it is
-- being judged, in production as much as anywhere else. The prefix costs six characters and removes a
-- reading that would otherwise be made, probably at the moment somebody is deciding whether it is safe to
-- drop.
--
-- ============================================================================================
-- What the migration is for, and the four failures it is arranged against
-- ============================================================================================
--
-- H-MIG-01's own summary states the constraint the rest of this file follows from: **there is no incumbent
-- export.** The source of every figure that arrives through this schema is a spreadsheet a human typed, so
-- there is no foreign primary key to reconcile against, no second system to re-query, and no way to
-- re-derive a row once the file has been edited. The only identity a source row has is
-- (file, line, content hash), and that is what provenance here records — see "Why provenance is a
-- reference and not five columns" below.
--
--   1. **An import that cannot be resumed is an import that is run twice.** A killed process leaves rows
--      applied and rows not applied, and with nothing recording which is which the only safe action is to
--      start again — into a database that already holds half the rows. So progress is COMMITTED per row:
--      `import_row.state` moves `pending` -> `applied` in the same transaction as the entity insert and
--      its provenance, and a resumed run is the SAME run row continuing with the rows still pending.
--      ZY192 makes a terminal outcome immutable, so a resume cannot re-apply what a previous attempt
--      already did, and ZY191 makes a second concurrent run of the same file a database error rather than
--      a race two processes can win differently.
--   2. **A figure whose provenance is not recorded is a figure nobody can defend.** When an imported
--      package balance disagrees with what the owner believes, the only useful answer is "row 214 of
--      <file>, whose content hashed to <hash> when it was read". ZY196 is what makes that answer exist for
--      every imported row rather than for the ones whose importer remembered: a DEFERRED constraint
--      trigger refuses, at COMMIT, any `import_row` that reached `applied` with no provenance row naming
--      it.
--   3. **A dry run that writes is not a dry run, and a dry run that skips the checks is not a rehearsal.**
--      The framework runs a dry run inside one transaction it rolls back. The trap is that ZY196 and every
--      other constraint trigger here is DEFERRED, so a transaction that never commits never fires them —
--      a dry run would report success over exactly the defect it exists to find. `runImport` therefore
--      issues `set constraints all immediate` before rolling back, which is the one line that makes the
--      rehearsal worth running. `packages/migration/src/framework.itest.ts` asserts it by giving a dry run
--      a row whose importer records no provenance and requiring ZY196.
--   4. **A checksum over nothing compares equal for ever.** Every acceptance line in this unit is asserted
--      by a checksum, so the checksum is the thing whose being wrong would make the whole unit report
--      success without measuring anything (ADR 0002's subject). `import_staging.content_checksum` is
--      therefore a function in the database rather than a query in a suite — so the report and the test
--      compute it the same way and cannot disagree — and it RAISES ZY197 when its exclusion list has
--      removed every column, instead of returning the md5 of an empty string.
--
-- ============================================================================================
-- Why provenance is a reference and not five columns
-- ============================================================================================
--
-- `import_provenance` names (target_schema, target_table, target_id) and an `import_row_id`, and it does
-- NOT carry the source file, the line number or the content hash. Those live once each:
-- `import_run.source_file` and `source_file_hash`, `import_row.line_number` and `row_hash`. The
-- resolution is `import_staging.entity_provenance`, one view, which is the only place the join is written.
--
-- The obvious alternative — denormalising file, line and hash onto every provenance row — is faster to
-- read and is the second statement of a fact this repository has paid for most often. It would also be
-- WRONG in a way nobody would see: a provenance row carrying its own copy of the file hash cannot be
-- checked against the run it came from, so a corrected re-import that edited one row of the file would
-- leave provenance claiming a hash the file no longer has, and the claim would still resolve.
--
-- `target_id` is `text` and not `uuid` deliberately. Most imported entities have a uuid primary key and
-- some do not: `package_template` is keyed by a code, and H-MIG-06's chart-of-accounts rows are keyed by
-- an account code. A uuid column here would force the one importer with a natural key either to cast or
-- to keep its provenance somewhere else, and "somewhere else" is how coverage stops being 100%.
--
-- ============================================================================================
-- What is deliberately NOT here
-- ============================================================================================
--
--   * **No importer.** H-MIG-02 through H-MIG-11 own the importers and their target tables. This file
--     creates ONE target: `import_probe_entity`, which exists so the framework's five claims —
--     idempotence, resumability, dry run, provenance coverage, rollback — are proved against a real table
--     with real triggers and a real checksum rather than against a mock. It is the same arrangement as
--     `packages/payments/src/conformance/fixtures`, and `packages/migration/src/write-path.test.ts` is
--     what stops a real importer naming it.
--   * **No owner sign-off table.** H-MIG-03's acceptance names one ("stored immutably against the hash of
--     the file it attests to") and its `files` list names the migration that creates it. The hash it
--     attests to is `import_run.source_file_hash`, which is here; the sign-off itself is not, because a
--     table with no unit deciding who may sign and what a signature covers would be a shape for somebody
--     else to work around.
--   * **No rejection catalogue.** `import_row.outcome_detail` is free text. H-MIG-02 owns the validator
--     and its named malformed fixtures, and a CHECK here listing the reasons a row may be rejected would
--     be a second list for that unit's to disagree with.
--   * **No ON DELETE CASCADE anywhere in this schema, and no DELETE grant.** The staging ledger is the
--     evidence that an import happened and what it read. Deleting a run to tidy up would delete the only
--     record of where a figure on the balance sheet came from, so `import_row.run_id` and
--     `import_provenance.import_row_id` are both ON DELETE RESTRICT and the application role holds no
--     DELETE on any of the three tables. A run that should not have happened is recorded as having
--     happened; that is what an audit trail is.

create schema import_staging;

comment on schema import_staging is
  'Where imported data sits while it is being judged, and the ledger of every import that has run '
  '(H-MIG-01). NOT the schema of the "staging" deployment environment — APP_ENV happens to have a value '
  'of that name and the two are unrelated, which is why this schema carries the prefix.';

-- ---------------------------------------------------------------------------------------------
-- The run
-- ---------------------------------------------------------------------------------------------

create table import_staging.import_run (
  id                uuid primary key default uuid_generate_v7(),
  -- The importer's registered name, e.g. 'packages'. Free text and not an enum: the list of importers is
  -- `packages/migration/src/registry.ts`, and an enum here would be a second list that a new importer has
  -- to migrate before it can run once.
  importer          text not null check (length(importer) between 1 and 64),
  -- The importer's own version. An imported figure that disagrees with the incumbent has to be traceable
  -- to the CODE that read it as well as to the row it was read from, because an importer's rounding or
  -- normalisation is as much a cause of a discrepancy as a typed digit.
  importer_version  text not null check (length(importer_version) between 1 and 64),
  source_file       text not null check (length(source_file) between 1 and 1024),
  -- sha-256 of the file BYTES, lower-case hex. The only stable identity the source has: a spreadsheet has
  -- no version number, and its filename is whatever the person who sent it called it that day.
  source_file_hash  text not null check (source_file_hash ~ '^[0-9a-f]{64}$'),
  mode              text not null check (mode in ('dry-run', 'live')),
  state             text not null check (state in ('running', 'completed', 'failed')),
  -- The tables the importer DECLARES it writes, schema-qualified. Load-bearing twice: ZY194 refuses
  -- provenance for a table not in this list, so the report's "tables touched" is complete rather than
  -- hopeful, and the before/after checksums are taken over exactly this list.
  target_tables     text[] not null check (cardinality(target_tables) between 1 and 64),
  -- How many times this run has been picked up again after a kill. Kept because a run resumed four times
  -- is a fact about the import worth seeing in the report, not an implementation detail.
  resumed_count     integer not null default 0 check (resumed_count >= 0),
  actor_label       text not null check (length(actor_label) between 1 and 128),
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  -- `finished_at` is present exactly when the run is over. Written as a CHECK rather than trusted to the
  -- framework because a `running` row with a `finished_at` is indistinguishable, to the resume path, from
  -- a run nobody has to finish.
  constraint import_run_finished_iff_terminal check (
    (state = 'running' and finished_at is null) or (state <> 'running' and finished_at is not null)
  )
);

comment on table import_staging.import_run is
  'One import of one source file. A resumed import is the SAME row continuing, never a second row — '
  'which is what makes "resume rather than re-run" expressible at all (ZY191).';
comment on column import_staging.import_run.source_file_hash is
  'sha-256 of the file bytes, lower-case hex. The identity of the source, because a typed spreadsheet has '
  'no other. H-MIG-03''s owner sign-off attests to this value.';
comment on column import_staging.import_run.mode is
  'A dry run rolls its whole transaction back, so NO dry-run row survives a completed dry run. The column '
  'exists because the rows staged inside that transaction need a run to hang off, and because a dry run '
  'that crashed mid-way must be distinguishable from a live one if one is ever found committed.';

create index import_run_importer_file on import_staging.import_run (importer, source_file_hash);

-- ---------------------------------------------------------------------------------------------
-- The staged row
-- ---------------------------------------------------------------------------------------------

create table import_staging.import_row (
  id              uuid primary key default uuid_generate_v7(),
  -- ON DELETE RESTRICT, not CASCADE: see the header. Nothing deletes an import.
  run_id          uuid not null references import_staging.import_run (id) on delete restrict,
  line_number     integer not null check (line_number >= 1),
  -- sha-256 of the row's CANONICAL content, lower-case hex — the hash the importer computed over the
  -- normalised payload, not over the raw line. Idempotence is decided on this value, so it has to be
  -- stable under things that do not change the data: a re-saved spreadsheet moves every byte of every
  -- line and must not re-import a single row.
  row_hash        text not null check (row_hash ~ '^[0-9a-f]{64}$'),
  payload         jsonb not null,
  state           text not null default 'pending'
                    check (state in ('pending', 'applied', 'skipped', 'rejected')),
  -- Why a row was skipped or rejected, in the importer's words. Required for those two outcomes and
  -- refused for the others: "skipped" with no reason is the outcome somebody has to guess at months later,
  -- and an `applied` row with a reason is a row whose state and story disagree.
  outcome_detail  text,
  applied_at      timestamptz,
  constraint import_row_outcome_detail_iff_not_applied check (
    (state in ('skipped', 'rejected')) = (outcome_detail is not null)
  ),
  constraint import_row_applied_at_iff_applied check ((state = 'applied') = (applied_at is not null)),
  constraint import_row_one_per_line unique (run_id, line_number)
);

comment on table import_staging.import_row is
  'One row of one source file, as read. The payload is kept because the file will be edited and the run '
  'has to stay answerable afterwards: this is the copy of row 214 that was actually imported.';
comment on column import_staging.import_row.state is
  'pending -> applied | skipped | rejected, once. A terminal outcome is immutable (ZY192), which is what '
  'makes a resumed run unable to apply a row a previous attempt already applied.';

create index import_row_run_pending on import_staging.import_row (run_id, line_number)
  where state = 'pending';
-- The idempotence lookup: "has a completed run of this importer already applied this row content?".
create index import_row_hash_applied on import_staging.import_row (row_hash) where state = 'applied';

-- ---------------------------------------------------------------------------------------------
-- Provenance
-- ---------------------------------------------------------------------------------------------

create table import_staging.import_provenance (
  id              uuid primary key default uuid_generate_v7(),
  import_row_id   uuid not null references import_staging.import_row (id) on delete restrict,
  target_schema   text not null check (target_schema ~ '^[a-z_][a-z0-9_]*$'),
  target_table    text not null check (target_table ~ '^[a-z_][a-z0-9_]*$'),
  target_id       text not null check (length(target_id) between 1 and 256),
  recorded_at     timestamptz not null default now(),
  -- One imported entity row, one provenance row. A second claim on the same target row is a unique
  -- violation and not a private code on purpose: 23505 names both the constraint and the values, which is
  -- more than a bespoke message would say, and there is no separate remedy to point a reader at.
  constraint import_provenance_one_per_target unique (target_schema, target_table, target_id)
);

comment on table import_staging.import_provenance is
  'Which imported entity row came from which staged source row. Append-only: UPDATE and DELETE raise '
  'ZY195. It deliberately carries NO copy of the file, the line or the hash — those resolve through '
  'import_staging.entity_provenance, so there is one statement of each.';

create index import_provenance_row on import_staging.import_provenance (import_row_id);
create index import_provenance_target_relation
  on import_staging.import_provenance (target_schema, target_table);

/**
 * The resolution: every imported entity row to its source file, line number and content hash.
 *
 * One view, because the join is the unit's central claim and a second spelling of it in a report, a suite
 * and an importer is three things to drift. Every later H-MIG unit's liability report reads this.
 */
create view import_staging.entity_provenance as
  select p.target_schema,
         p.target_table,
         p.target_id,
         r.source_file,
         r.source_file_hash,
         w.line_number as source_line,
         w.row_hash    as content_hash,
         r.importer,
         r.importer_version,
         r.id          as run_id,
         w.id          as import_row_id,
         p.recorded_at as imported_at
    from import_staging.import_provenance p
    join import_staging.import_row w on w.id = p.import_row_id
    join import_staging.import_run r on r.id = w.run_id;

comment on view import_staging.entity_provenance is
  'The ONE place (target row) -> (file, line, content hash, importer, importer version) is written. '
  'H-MIG-01''s answer to "where did this figure come from".';

-- ---------------------------------------------------------------------------------------------
-- The conformance target
-- ---------------------------------------------------------------------------------------------

create table import_staging.import_probe_entity (
  id          uuid primary key default uuid_generate_v7(),
  -- The natural key the probe importer dedupes on, so idempotence is asserted over a real unique
  -- constraint rather than over row counts.
  probe_key   text not null unique check (length(probe_key) between 1 and 128),
  label       text not null,
  amount_fils fils not null,
  created_at  timestamptz not null default now()
);

comment on table import_staging.import_probe_entity is
  'The framework''s conformance target, and nothing else reads it. It exists so H-MIG-01''s five claims '
  'are proved against a real table — real constraints, real checksum, real deferred trigger — instead of '
  'a mock, exactly as packages/payments/src/conformance/fixtures ships adapters that are deliberately '
  'broken. A real importer that named this table would be recording a domain figure where nothing looks '
  'for it; packages/migration/src/write-path.test.ts refuses one.';

-- ---------------------------------------------------------------------------------------------
-- ZY191 — one open run per (importer, source file)
-- ---------------------------------------------------------------------------------------------
--
-- The rule that makes "resume" the only available action. Two processes started on the same file would
-- each stage the rows and then each apply them: the second would find nothing already applied, because the
-- first has not committed yet, and both would insert. The unique constraint cannot express it — it is
-- conditional on `state` — so it is a trigger, and it is a private code because the remedy is specific and
-- is not "try again": resume the run that is already open.
--
-- Scoped to LIVE runs on BOTH sides, and that is a decision rather than an optimisation. A dry run holds
-- its whole run inside one transaction it rolls back, so it applies nothing and no other session can see
-- it: two of them cannot collide, and one cannot collide with a live run. Refusing a dry run while a live
-- run is open would forbid the single most useful thing to do about a live run that is stuck — rehearse the
-- file and find out what it would do — so the rule says what it means, which is that two runs may not be
-- APPLYING one file.
create or replace function import_staging.assert_one_open_run()
returns trigger
language plpgsql
as $$
declare
  v_open uuid;
begin
  select id into v_open
    from import_staging.import_run
   where importer = new.importer
     and source_file_hash = new.source_file_hash
     and state = 'running'
     and mode = 'live'
     and id <> new.id
   limit 1;

  if v_open is not null then
    raise exception
      'ImportAlreadyRunning: importer "%" already has run % open on source file hash %; resume that run '
      'rather than starting a second',
      new.importer, v_open, new.source_file_hash
      using errcode = 'ZY191';
  end if;

  return new;
end $$;

comment on function import_staging.assert_one_open_run() is
  'Raises ZY191. Two runs of one file both stage and both apply: neither can see the other''s uncommitted '
  'rows, so idempotence cannot save them. The remedy is to resume, which is why it is a named code.';

create trigger import_run_one_open
  before insert or update of state on import_staging.import_run
  for each row when (new.state = 'running' and new.mode = 'live')
  execute function import_staging.assert_one_open_run();

-- ---------------------------------------------------------------------------------------------
-- ZY192 — a staged row's evidence and its terminal outcome are immutable
-- ---------------------------------------------------------------------------------------------
--
-- The one permitted UPDATE is `pending` -> terminal, together with the two columns that describe the
-- outcome. Everything else is refused, and the reason is resumability: a resumed run decides what to do by
-- reading `state`, so a row that can go back to `pending` is a row that can be applied twice, and a
-- payload or hash that can be edited after the fact is provenance that resolves to something that was
-- never imported. A DELETE is refused for the header's reason — the ledger is the evidence.
create or replace function import_staging.refuse_import_row_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      'ImportRowImmutable: staged row % (line % of run %) may not be deleted; the staging ledger is the '
      'evidence that the import happened',
      old.id, old.line_number, old.run_id
      using errcode = 'ZY192';
  end if;

  if old.state <> 'pending' then
    raise exception
      'ImportRowImmutable: staged row % is already %, and a terminal outcome may not change — a resumed '
      'run reads this column to decide what it still has to do',
      old.id, old.state
      using errcode = 'ZY192';
  end if;

  if new.id <> old.id
     or new.run_id <> old.run_id
     or new.line_number <> old.line_number
     or new.row_hash <> old.row_hash
     or new.payload <> old.payload then
    raise exception
      'ImportRowImmutable: staged row % may change only its outcome (state, outcome_detail, applied_at); '
      'its run, line, hash and payload are the record of what was read',
      old.id
      using errcode = 'ZY192';
  end if;

  return new;
end $$;

comment on function import_staging.refuse_import_row_change() is
  'Raises ZY192. Permits exactly pending -> terminal plus the outcome columns; refuses every other '
  'update and every delete.';

create trigger import_row_no_reopen before update on import_staging.import_row
  for each row execute function import_staging.refuse_import_row_change();
create trigger import_row_no_delete before delete on import_staging.import_row
  for each row execute function import_staging.refuse_import_row_change();

-- ---------------------------------------------------------------------------------------------
-- ZY193 — nothing may be staged against a run that has finished
-- ---------------------------------------------------------------------------------------------
--
-- A row staged after its run completed is never applied by anything: the run is over, and the resume path
-- looks only at `running` runs. So the row sits pending for ever, the run says `completed`, and the
-- idempotence check — which trusts `completed` — then skips nothing and re-imports nothing. The failure is
-- silent in both directions, which is why it is refused at the insert rather than reported by a report.
create or replace function import_staging.assert_run_still_open()
returns trigger
language plpgsql
as $$
declare
  v_state text;
begin
  select state into v_state from import_staging.import_run where id = new.run_id;

  if v_state <> 'running' then
    raise exception
      'ImportRunClosed: run % is %, so no further row may be staged against it (line % was)',
      new.run_id, v_state, new.line_number
      using errcode = 'ZY193';
  end if;

  return new;
end $$;

comment on function import_staging.assert_run_still_open() is
  'Raises ZY193. A row staged into a finished run is never applied and never noticed: the run reads as '
  'completed and the row reads as pending, and nothing joins the two.';

create trigger import_row_run_open before insert on import_staging.import_row
  for each row execute function import_staging.assert_run_still_open();

-- ---------------------------------------------------------------------------------------------
-- ZY194 — provenance may only name a table the run declared
-- ---------------------------------------------------------------------------------------------
--
-- `import_run.target_tables` is what the before/after checksums are taken over and what the report calls
-- "tables touched". An importer that wrote into a table it had not declared would produce a report whose
-- checksums cover the wrong set — and every acceptance line in this unit is asserted BY those checksums,
-- so the unit's own evidence would be measuring somewhere else. Refused here, at the one write that knows
-- both the table and the run.
create or replace function import_staging.assert_target_was_declared()
returns trigger
language plpgsql
as $$
declare
  v_declared text[];
  v_relation text := new.target_schema || '.' || new.target_table;
begin
  select r.target_tables into v_declared
    from import_staging.import_row w
    join import_staging.import_run r on r.id = w.run_id
   where w.id = new.import_row_id;

  if not (v_relation = any (v_declared)) then
    raise exception
      'UndeclaredImportTarget: provenance names % and the run declares only %; a report''s checksums '
      'cover the declared tables, so an undeclared one is a change nothing measured',
      v_relation, v_declared
      using errcode = 'ZY194';
  end if;

  return new;
end $$;

comment on function import_staging.assert_target_was_declared() is
  'Raises ZY194. Keeps import_run.target_tables complete, which is what the before/after checksums and '
  'the provenance-coverage read are both taken over.';

create trigger import_provenance_target_declared before insert on import_staging.import_provenance
  for each row execute function import_staging.assert_target_was_declared();

-- ---------------------------------------------------------------------------------------------
-- ZY195 — provenance is append-only
-- ---------------------------------------------------------------------------------------------
--
-- ADR 0008's shape, for the reason that applies to every append-only table in this schema: provenance is
-- the answer to "where did this figure come from", and an answer that can be edited afterwards is not
-- evidence. A correction is a new import, not a rewritten record of the old one.
create or replace function import_staging.refuse_provenance_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'ProvenanceImmutable: provenance for %.% row % may not be % — a corrected import is a new import, '
    'and the record of the old one is what makes the correction auditable',
    old.target_schema, old.target_table, old.target_id, lower(tg_op)
    using errcode = 'ZY195';
end $$;

comment on function import_staging.refuse_provenance_change() is
  'Raises ZY195 for both events. One function and two triggers, because the half-written pair — one '
  'trigger copied for the other event with the word not changed — is where this defect always hides.';

create trigger import_provenance_no_update before update on import_staging.import_provenance
  for each row execute function import_staging.refuse_provenance_change();
create trigger import_provenance_no_delete before delete on import_staging.import_provenance
  for each row execute function import_staging.refuse_provenance_change();

-- ---------------------------------------------------------------------------------------------
-- ZY196 — an applied row carries provenance, checked at COMMIT
-- ---------------------------------------------------------------------------------------------
--
-- The unit's deliverable, as a property of the database rather than of whichever importer remembered.
--
-- DEFERRED because the entity insert, the provenance row and the state change are three statements and
-- their order is the importer's business: an immediate trigger would force provenance to be written before
-- the row is marked applied, which is an arbitrary rule about statement order that a reasonable importer
-- would fail for no reason. Deferred to COMMIT, the rule is exactly the claim — you may not COMMIT an
-- applied row with no provenance.
--
-- What it can and cannot see, stated rather than left to be discovered. The database cannot see an INSERT
-- into an arbitrary target table, so this is not "no entity row exists without provenance" in the
-- strongest sense; it is "no source row reaches `applied` without provenance". Those are the same event
-- only because `runImport` is the single write path — it performs the entity insert, the provenance row
-- and the state change in one transaction — and `packages/migration/src/write-path.test.ts` is what keeps
-- it single. The other direction is measured rather than assumed:
-- `import_staging.unprovenanced_row_ids` reads a target table for rows with no provenance, and the
-- framework's report carries the count for every declared target.
create or replace function import_staging.assert_applied_row_has_provenance()
returns trigger
language plpgsql
as $$
begin
  if new.state <> 'applied' then
    return null;
  end if;

  if not exists (
    select 1 from import_staging.import_provenance p where p.import_row_id = new.id
  ) then
    raise exception
      'MissingProvenance: staged row % (line % of run %) is applied with no provenance row; an imported '
      'figure whose source is not recorded is a figure nobody can defend',
      new.id, new.line_number, new.run_id
      using errcode = 'ZY196';
  end if;

  return null;
end $$;

comment on function import_staging.assert_applied_row_has_provenance() is
  'Raises ZY196 at COMMIT. Deferred because the three statements'' order is the importer''s business; the '
  'claim is about what may be committed, not about what may be written first. A dry run rolls back and so '
  'would never fire it, which is why runImport issues `set constraints all immediate` before rolling '
  'back.';

create constraint trigger import_row_applied_has_provenance
  after insert or update on import_staging.import_row
  deferrable initially deferred
  for each row execute function import_staging.assert_applied_row_has_provenance();

-- ---------------------------------------------------------------------------------------------
-- ZY198 — a run may not complete while any of its rows is still pending
-- ---------------------------------------------------------------------------------------------
--
-- `completed` is what the idempotence check trusts: a second import of the same file skips a row because a
-- COMPLETED run already applied it. A run marked completed with rows still pending therefore makes the
-- next run skip rows that were never imported — the one failure in this unit that produces MISSING data
-- and reports success, and the reason the state is refused rather than reported.
create or replace function import_staging.assert_run_has_no_pending_rows()
returns trigger
language plpgsql
as $$
declare
  v_pending integer;
begin
  select count(*) into v_pending
    from import_staging.import_row w
   where w.run_id = new.id and w.state = 'pending';

  if v_pending > 0 then
    raise exception
      'IncompleteImportRun: run % still has % pending row(s) and may not be completed; the next import of '
      'this file would skip them as already imported',
      new.id, v_pending
      using errcode = 'ZY198';
  end if;

  return new;
end $$;

comment on function import_staging.assert_run_has_no_pending_rows() is
  'Raises ZY198. The only failure in this schema that loses data while reporting success: a completed run '
  'with pending rows makes every later import skip them.';

create trigger import_run_completed_has_no_pending
  before update of state on import_staging.import_run
  for each row when (new.state = 'completed')
  execute function import_staging.assert_run_has_no_pending_rows();

-- ---------------------------------------------------------------------------------------------
-- The checksum, and the coverage read
-- ---------------------------------------------------------------------------------------------

/**
 * md5 over the content of a relation, row-ordered, with named columns excluded.
 *
 * In the database and not in a suite so that the framework's report and every test compute it the SAME
 * way. Two implementations of one checksum is two answers to "did this table change", and the first time
 * they disagree the suite will be believed.
 *
 * `p_exclude` is what makes two DIFFERENT runs comparable: the resumability claim is that a killed and
 * resumed import reaches the same final state as an uninterrupted one, and those two runs differ in every
 * generated id and every timestamp. Excluding them compares the CONTENT, which is the claim. Excluding
 * nothing compares the bytes, which is the idempotence claim — a second import must not change even an id.
 *
 * It RAISES ZY197 when the exclusion list has removed every column, rather than returning md5(''). That is
 * this unit's ADR 0002 case: every acceptance line here is asserted by comparing two of these strings, so
 * a checksum that silently covers nothing would make the whole unit pass while measuring nothing.
 */
create or replace function import_staging.content_checksum(
  p_relation regclass,
  p_exclude  text[] default array[]::text[]
)
returns text
language plpgsql
stable
as $$
declare
  v_columns text[];
  v_sql     text;
  v_result  text;
begin
  select array_agg(quote_ident(a.attname) order by a.attnum)
    into v_columns
    from pg_attribute a
   where a.attrelid = p_relation
     and a.attnum > 0
     and not a.attisdropped
     and not (a.attname = any (coalesce(p_exclude, array[]::text[])));

  if v_columns is null or cardinality(v_columns) = 0 then
    raise exception
      'EmptyChecksum: % has no columns left after excluding %; a checksum over no columns is a constant '
      'and would compare equal for ever',
      p_relation::text, coalesce(p_exclude, array[]::text[])
      using errcode = 'ZY197';
  end if;

  -- The row text is ordered by its own content, so the checksum does not depend on physical order — a
  -- resumed run inserts in the same logical order but need not land the tuples in the same pages.
  v_sql := format(
    'select coalesce(md5(string_agg(t.row_text, E''\n'' order by t.row_text)), %L) '
    'from (select (row(%s))::text as row_text from %s) t',
    'empty:' || p_relation::text,
    array_to_string(v_columns, ', '),
    p_relation::text
  );
  execute v_sql into v_result;
  return v_result;
end $$;

comment on function import_staging.content_checksum(regclass, text[]) is
  'md5 over a relation''s content with named columns excluded, ordered by row text so it is independent '
  'of physical order. Raises ZY197 rather than checksumming nothing. An EMPTY relation returns '
  '"empty:<relation>" and not md5(''''), so "no rows" and "no columns read" are different answers.';

/**
 * The ids of rows in a target relation that no provenance row names.
 *
 * The other direction of the coverage claim. ZY196 says no staged row may be APPLIED without provenance;
 * this says no row is SITTING in a target table without it. Both are needed and neither implies the other:
 * a row inserted by hand, by a seed, or by an importer that went round `runImport` satisfies ZY196
 * trivially, because there is no staged row at all.
 *
 * It refuses a relation whose primary key is not a single column (ZY199) rather than guessing, because the
 * alternative is a function that returns no rows for such a table — which reads as 100% coverage.
 */
create or replace function import_staging.unprovenanced_row_ids(p_relation regclass)
returns setof text
language plpgsql
stable
as $$
declare
  v_schema  text;
  v_table   text;
  v_key     text;
  v_keys    integer;
begin
  select n.nspname, c.relname into v_schema, v_table
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.oid = p_relation;

  select count(*), min(a.attname) into v_keys, v_key
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
   where i.indrelid = p_relation and i.indisprimary;

  if coalesce(v_keys, 0) <> 1 then
    raise exception
      'UnreadableProvenanceTarget: % has % primary-key column(s); provenance names one target_id, so a '
      'coverage read over this relation would silently report full coverage',
      p_relation::text, coalesce(v_keys, 0)
      using errcode = 'ZY199';
  end if;

  return query execute format(
    'select t.%1$s::text from %2$s t '
    'where not exists (select 1 from import_staging.import_provenance p '
    '  where p.target_schema = %3$L and p.target_table = %4$L and p.target_id = t.%1$s::text)',
    quote_ident(v_key), p_relation::text, v_schema, v_table
  );
end $$;

comment on function import_staging.unprovenanced_row_ids(regclass) is
  'Rows in a target relation that no provenance row names — the measured half of "100% provenance '
  'coverage". Raises ZY199 on a relation without a single-column primary key rather than returning '
  'nothing, because nothing reads as full coverage.';

-- ---------------------------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------------------------
--
-- 0009 grants the application role select/insert/update/delete on every table in `public` and sets default
-- privileges there. A NEW SCHEMA inherits none of that, so everything here is granted explicitly — which
-- is the opportunity to grant less. No DELETE and no TRUNCATE anywhere: the ledger is the evidence, and
-- the refusal triggers above would report a DELETE as a refusal while the grant said it was allowed, which
-- is append-only by convention rather than by privilege.
grant usage on schema import_staging to berelax_app;
grant select, insert on all tables in schema import_staging to berelax_app;
-- UPDATE on the run and the staged row only, because a run's state and a row's outcome are how progress is
-- recorded. Provenance and the probe entity get none: provenance is append-only (ZY195), and an imported
-- entity is corrected by a new import.
grant update on import_staging.import_run, import_staging.import_row to berelax_app;
revoke delete, truncate on all tables in schema import_staging from berelax_app;
alter default privileges in schema import_staging grant select, insert on tables to berelax_app;
grant execute on function import_staging.content_checksum(regclass, text[]) to berelax_app;
grant execute on function import_staging.unprovenanced_row_ids(regclass) to berelax_app;

grant usage on schema import_staging to berelax_readonly;
grant select on all tables in schema import_staging to berelax_readonly;
alter default privileges in schema import_staging grant select on tables to berelax_readonly;

-- The clinical role cannot enter this schema at all. Stated rather than left to the default, for 0009's
-- reason: a migration that imports clinical history is H-MIG-09's, it will run as the clinical role, and
-- the decision about whether that role may read the staging ledger belongs to the unit that needs it.
revoke all on schema import_staging from berelax_clinical;
