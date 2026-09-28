-- 0095 — the VAT return as a SEALED SNAPSHOT: the figures as bytes, a hash over exactly those bytes, two
--        named signatures from two different people, and no way to edit any of it.
--
-- M-VAT-08. M-VAT-07 built the working papers: `vat201_box_total()` over `vat201_box_line()` (0089) and
-- `vat201WorkingPapers()` reading them. Those are a FUNCTION OF THE LEDGER, recomputed on every read, and
-- that is right for a working paper — it is what makes the drill-down and the box total impossible to
-- disagree. It is exactly wrong for a filed return. A return is a statement made on a date about a period,
-- and the one thing it must not do is change when the ledger behind it does.
--
-- So this file stores the ANSWER and not the question.
--
-- ## The snapshot is the canonical BYTES, and the hash is a CHECK over them
--
-- `vat_return.snapshot_json` holds exactly what `canonicaliseVat201WorkingPapers()` produced — keys sorted
-- recursively, every `bigint` a decimal string, no instant anywhere in it — and
-- `vat_return_snapshot_hash_is_the_hash_of_the_snapshot` is
--
--     content_hash = encode(sha256(convert_to(snapshot_json, 'UTF8')), 'hex')
--
-- as a CHECK. That is the same sha256 `vat201ContentHash()` computes in TypeScript over the same bytes, so
-- the column cannot be a hash of something else. It holds during a restore with triggers off, it holds
-- against a `psql` session, and it is reproducible by something that is not this codebase: any reader can
-- take the text out of the row, sha256 it, and get the stored value.
--
-- What it does NOT claim, stated because the claim must not be wider than the measurement: it does not say
-- the bytes are what the ledger said. Nothing in a database can say that. What says it is
-- `packages/db/src/services/vat-return-signoff.itest.ts`, which regenerates the working papers from the
-- ledger — with the clock advanced five years — and requires the hash to come back identical.
--
-- ## The figures are a VIEW over those bytes, and that is the opposite of recomputing them
--
-- `vat_return_box_figure` and `vat_return_not_fileable_reason` are views over
-- `vat_return.snapshot_json`. They touch `vat_return` and nothing else: no `journal_line`, no
-- `vat201_box_total()`, no `account`. Reading them cannot reach the ledger, so a figure cannot move when
-- the ledger does — which is the property the unit exists for, and gate case 122t asserts it over the view
-- definitions with a known-bad fixture that plants a join to `vat201_box_line` and requires it to be found.
--
-- The alternative — `vat_return_box` as a TABLE, one row per box, written beside the JSON — was written
-- first and is worse in the one way this build keeps paying for: **a second statement of a fact drifts.**
-- Two copies of the same figure can disagree, nothing in SQL can prove they do not, and the copy that
-- disagrees is the one a screen reads while the hash still verifies the other. It also needs three rules
-- the view needs none of: a refusal for a box row appended to a sealed return in a later transaction, a
-- refusal for a box row whose figure is not the one in the hashed bytes, and a refusal for a snapshot
-- committed with no box rows at all. The view has no second copy to append to, edit or forget.
--
-- The one thing a view cannot do is carry an index, and it does not matter here: a VAT return is quarterly,
-- so the whole table is a few dozen rows a decade and every read of it names one `id`.
--
-- ## Every scalar column that also appears in the bytes is TIED to them by a CHECK
--
-- `period_id`, `starts_on`, `ends_on`, `closed_period_id`, `format_version`, `trial_balance_hash` and
-- `fileable` are all columns AND all present inside `snapshot_json`. They are columns because a return is
-- looked up by period and a `psql` session should not have to parse JSON to answer "which period is this";
-- they are duplicated, which is the thing this build's conventions warn about, so the duplication is
-- REFUSED the chance to drift: two CHECKs compare each column against its own value inside the hashed
-- bytes. A row where the two disagree cannot be stored, so "the columns describe the snapshot" is a
-- property of the database and not of the writer.
--
-- ## Immutable means REVOKED and REFUSED, and a correction is a new version
--
-- Three layers, because they answer different questions and each holds when the others are absent:
--
--   * `revoke update, delete, truncate … from berelax_app` — what a reader of `\dp` sees, and the layer the
--     integration suite CANNOT see, because the test pool connects as owner. Five units have been caught by
--     that gap; gate case 122a runs `set local role berelax_app` and requires `42501`.
--   * BEFORE UPDATE and BEFORE DELETE triggers raising `ZY051`, for EVERY role including the owner. A
--     migration, an import and a `psql` session are three writers that are not the application.
--   * `version` + `supersedes_id` + `amendment_reason`, so the shape a correction has to take exists: a new
--     row naming the one it replaces and saying why. `ZY054` refuses every other shape.
--
-- A `create rule … do instead nothing` was not used, for 0018's reason restated by 0085 and 0093: a rule
-- reports SUCCESS and lets the caller go on believing the edit happened.
--
-- ## Preparer and reviewer are two DIFFERENT people, refused here rather than in a service
--
-- `vat_return_sign_off` holds one row per capacity per return. Two layers again, and neither is a copy of
-- the other:
--
--   * `unique (return_id, signatory_user_id)` — the storage layer. It holds during a restore with triggers
--     off and cannot be satisfied by editing a row, because the table is append-only. What it cannot do is
--     explain itself: it is `23505` naming an index.
--   * `assert_vat_return_sign_off_is_a_second_person()` — `ZY052`, BEFORE INSERT, which fires first and
--     names the person, the capacity they already signed in, and why the rule exists. This is the
--     `SamePersonSignOff` the acceptance criterion asks for by name.
--
-- The ROLE is refused the same way twice over for the same reason: a CHECK against
-- `vat_return_signing_roles()` (restore-proof, and the ONE place the permitted set is written down), and
-- `ZY053` beside it with the role and the permitted list in the sentence. Deny by default: the function
-- returns the two roles that may sign and every other role in F07's set — manager, receptionist,
-- therapist, marketer, auditor, system — is refused by not being in it.
--
-- `packages/fixtures/src/vat-return-signoff.itest.ts` is what stops that list drifting from
-- `packages/core/src/access/permissions.ts`: it reads `vat_return_signing_roles()` out of the database and
-- requires it to equal exactly the roles `can(role, 'vat_return:prepare')` grants, for all eight roles
-- individually. `packages/db` may never import `packages/core`, so fixtures is the only place that
-- comparison can be made at all.
--
-- The signatory's DISPLAY NAME and ROLE are SNAPSHOTTED beside their id, which is 0093's
-- `publication_approval` for 0026's reason: a join would let a later rename rewrite who signed. There is no
-- invented name here and none is possible — the value comes from the row the signatory was signed in as,
-- and `is_placeholder_text` refuses a blank one.
--
-- ## The generating code version, read from the code that generated it
--
-- The manifest asks the snapshot to carry "the generating code version". Two columns carry it and neither
-- is a version number somebody typed:
--
--   * `format_version` — the canonical form's own tag, `vat201-wp1`, taken from the paper. A future
--     canonical form is INCOMPARABLE to this one rather than merely unequal.
--   * `engine_signature` — `vat201_engine_signature()`, the sha256 of `pg_get_functiondef()` over the seven
--     SQL functions that ARE the return engine. Not a number in a constant: the actual text of the code
--     that produced the figures, read out of the catalogue. A `create or replace` of any of the seven
--     changes it, so two snapshots computed by different engines say so.
--
-- `vat201_engine_signature()` raises `ZY056` when the number of functions it found is not the number it
-- names. Without that it would be ADR 0002 in one line: rename `vat201_box_line` and the signature becomes
-- a hash of six definitions, quietly, and every snapshot after it would record a signature that omits the
-- function that did the work.
--
-- ## An unsigned return cannot be marked final and cannot be exported
--
-- `vat_return_finalisation` is the row a filing cites, and `assert_vat_return_is_signed_off()` (`ZY055`)
-- refuses it unless BOTH capacities are signed. `vat_return_for_filing()` raises the same code, so the
-- refusal reaches a read as well as a write: M-VAT-09's one-way Zoho export reads that function, and a
-- caller who skips it is not reading "the return for filing", which is what the function is named for.
-- `vat_return_sign_off_state()` is the ONE reader of "is this signed", called by both, so they cannot
-- disagree.
--
-- The base tables stay readable, deliberately. A snapshot is not a secret and a preparer has to be able to
-- look at the figures they are about to sign — a sign-off that cannot see what it signs is worse than no
-- sign-off. What is guarded is the door labelled FILING.
--
-- ## Every signature writes an audit_event in the same transaction
--
-- `ZY057`, a `deferrable initially deferred` constraint trigger, which is 0081's ZW003 and 0093's ZZ004
-- shape for their reason: at COMMIT the audit row either is in the transaction or is not, so it cannot be
-- satisfied by a row written afterwards in a second one. A statutory signature whose only evidence is the
-- signature itself is the case this is against.
--
-- ## Nothing here reads a clock, and nothing here divides
--
-- `snapshotted_at`, `signed_at` and `finalised_at` are NOT defaulted: they come from the caller, because
-- every ordering assertion in this area is made under a frozen clock and a column defaulting to `now()`
-- cannot be frozen (0056, 0064, 0085, 0093). `created_at` defaults, and is the row's arrival rather than
-- the event's.
--
-- No figure in this file is computed. The views cast a stored decimal string to `bigint` and stop; there is
-- no division, no `round()`, no `numeric` and no rate, for 0089's reason — whichever way [UNVERIFIED]
-- Y11-rounding is answered, no figure in a snapshot can move, because nothing here applies a rate to
-- anything.
--
-- ## The return is NOT fileable, and the snapshot may not pretend otherwise
--
-- Every box in `vat201_box` is `is_provisional` against [UNVERIFIED] Y11-vat201-boxes, Y11-tax-agent
-- records an FTA-registered tax agent's review as NOT OPTIONAL, and `vat201WorkingPapers()` therefore
-- reports `fileable` as the literal `false` with the reasons as rows. A snapshot is allowed to record that
-- state and is refused the chance to improve on it:
-- `vat_return_fileable_only_when_nothing_in_it_refuses_filing` is a CHECK, so `fileable = true` is
-- impossible while the hashed bytes carry a `notFileableReasons` entry or a box marked provisional. Making
-- an unfileable return look fileable is the one failure that ends with something wrong sent to the FTA,
-- and it is refused by the same layer that survives a restore.
--
-- ## No period_lock foreign key, and that is 0086's test rather than a shortcut
--
-- `closed_period_id` is a plain column. The rule P-HR-07 sharpened: ask whether the CHILD can be deleted to
-- release the pin. A `period_lock` row CAN be deleted — `journal.itest.ts`, `period-close.itest.ts`, gate
-- block 98 and this unit's own suite all remove their own locks to be re-runnable — while a `vat_return`
-- row can be deleted by nobody. A RESTRICT reference from one would therefore pin that lock for ever and
-- make every one of those suites unable to clean up after itself. The lock is provenance here, not
-- evidence: the EVIDENCE is `trial_balance_hash`, which is `period_trial_balance_hash()`'s and needs no row
-- to stay true.
--
-- ## The private SQLSTATEs: ZY051-ZY057
--
-- `ZY` and not a fresh class, because there is no fresh class: 0093 took `ZZ`, the last one, and
-- `packages/db/src/sqlstate-uniqueness.test.ts` says so in its own header. W-SYS-12's provisional answer is
-- applied here — a refusal is identified by ALL FIVE characters, and two unrelated rules may share a class
-- as long as they never share a code. `ZY001`-`ZY008` are 0085's, `ZY009`-`ZY010` are 0089's,
-- `ZY011`-`ZY014` are 0091's. This file holds `ZY051`-`ZY057`, a band nobody else was allocated, and
-- `ZY058`-`ZY060` are left free rather than taken and unused.
--
--   ZY051  VatReturnSnapshotImmutable — UPDATE or DELETE on a snapshot, a signature or a finalisation
--   ZY052  SamePersonSignOff — one person signing as both preparer and reviewer
--   ZY053  VatReturnSignOffRoleNotPermitted — a role outside vat_return_signing_roles()
--   ZY054  VatReturnAmendmentNotWellFormed — a version that is not the next one, does not supersede the
--          current one, forks a superseded one, or describes another period
--   ZY055  VatReturnNotSignedOff — marked final, or read for filing, without both signatures
--   ZY056  Vat201EngineSignatureIncomplete — the engine's function list and the catalogue disagree
--   ZY057  VatReturnSignOffNotAudited — a signature or a finalisation with no audit_event at COMMIT
--
-- See docs/adr/0044-a-filed-vat-return-is-a-snapshot-not-a-query.md, docs/OPEN-QUESTIONS.md
-- (Y11-tax-agent, Y11-vat201-boxes, Y11-vat201-blocked-box) and
-- docs/adr/0017-accounting-journal-and-no-auto-filing.md.

begin;

-- ---------------------------------------------------------------------------------------------
-- 1. Who may sign, written down ONCE
-- ---------------------------------------------------------------------------------------------
-- A function rather than a literal list inside a CHECK, for one reason: the list has to be READABLE from
-- outside the constraint. `packages/fixtures/src/vat-return-signoff.itest.ts` reads it and requires it to
-- equal the roles `can(role, 'vat_return:prepare')` grants in `packages/core/src/access/permissions.ts`,
-- and that comparison is the only thing stopping the two from drifting — `packages/db` may not import
-- `packages/core`, so nothing compiles them against each other.
--
-- IMMUTABLE so a CHECK may call it. Widening it later is a `create or replace`, which does not revalidate
-- the rows already stored — correct in this direction, because a role that was permitted when somebody
-- signed does not stop having signed.
create function vat_return_signing_roles() returns text[]
language sql
immutable
as $$
  -- F07's role set is owner, manager, accountant, receptionist, therapist, marketer, auditor, system.
  -- These two hold `vat_return:prepare`; the other six are refused by NOT BEING HERE, which is what
  -- deny-by-default means in a database.
  select array['accountant', 'owner']::text[];
$$;

comment on function vat_return_signing_roles() is
  'The roles that may sign a VAT return, as DATA so it can be compared with core''s permission matrix. '
  'Deny-by-default: the other six roles in F07''s set are refused by absence. '
  'packages/fixtures/src/vat-return-signoff.itest.ts requires this to equal the roles holding '
  'vat_return:prepare, because packages/db may not import packages/core.';

-- ---------------------------------------------------------------------------------------------
-- 2. The engine's own signature: the generating code version, read from the code
-- ---------------------------------------------------------------------------------------------
-- The sha256 of `pg_get_functiondef()` over the seven functions that compute a VAT201 figure. Recorded on
-- every snapshot so that two returns produced by different engines say so, rather than two identical-looking
-- rows produced eight months and one `create or replace` apart.
--
-- `plpgsql` and not `sql`, only so that the count can RAISE. Without the raise, renaming one of the seven
-- would silently reduce the signature to a hash of six definitions and every later snapshot would record a
-- signature that omits the function that did the work — ADR 0002 in one line, in the column whose whole
-- job is to be different when the code is different.
create function vat201_engine_signature() returns text
language plpgsql
stable
as $$
declare
  -- The engine, named. Every function `vat201WorkingPapers()` reaches for a FIGURE; not
  -- `vat201_mapping_is_complete()` or `vat201_measure_matches_the_account()`, which are refusals and
  -- compute nothing, and whose rewording would change a signature without changing an answer.
  v_names       text[] := array[
    'vat201_box_line',
    'vat201_box_total',
    'vat201_unboxed_total',
    'vat201_partition_census',
    'vat201_entry_document',
    'vat201_entry_document_direct',
    'vat201_mapping_disagreement'
  ];
  v_found       integer;
  v_definitions text;
begin
  select count(*), string_agg(pg_get_functiondef(p.oid), e'\n' order by p.proname, p.oid)
    into v_found, v_definitions
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = any (v_names);

  -- Not `<` but `<>`: an OVERLOAD is also a changed engine, and a second `vat201_box_line` would make the
  -- signature stable while the answer depended on which one the planner chose.
  if v_found <> cardinality(v_names) then
    raise exception
      'Vat201EngineSignatureIncomplete: the VAT201 engine is named as % function(s) and the catalogue '
      'holds %. The signature is the sha256 of their definitions and is stored on every vat_return, so a '
      'missing or duplicated one would quietly hash a different engine than the one that computed the '
      'figures. Expected: %. Fix the list in vat201_engine_signature() in the same migration that renames '
      'or overloads one of them.',
      cardinality(v_names), v_found, array_to_string(v_names, ', ')
      using errcode = 'ZY056';
  end if;

  return encode(sha256(convert_to(v_definitions, 'UTF8')), 'hex');
end $$;

comment on function vat201_engine_signature() is
  'sha256 of pg_get_functiondef() over the seven SQL functions that compute a VAT201 figure — the '
  'GENERATING CODE VERSION, read from the code rather than typed as a number. Raises ZY056 when the '
  'catalogue holds a different number of them than the list names, because a hash of six definitions out '
  'of seven would be silently wrong in the one column whose job is to differ when the code differs.';

-- ---------------------------------------------------------------------------------------------
-- 3. The snapshot
-- ---------------------------------------------------------------------------------------------
create table vat_return (
  id                  uuid        primary key default uuid_generate_v7(),
  -- The identifier an accountant recognises: '2026-08', '2026-Q3'. It appears in every refusal, and it is
  -- NOT a display number anything keys on — the outbox and the audit trail key on `id`
  -- (packages/db/src/outbox-keys.test.ts), because a label people read can repeat and a row id cannot.
  period_id           text        not null
                        constraint vat_return_period_is_identified
                        check (not is_placeholder_text(period_id) and length(period_id) between 3 and 60),
  starts_on           date        not null,
  -- The last day OF the period, not the first day after it.
  ends_on             date        not null,
  -- 1 for the return as first snapshotted; 2 for the first amendment, and so on. An amendment is a NEW ROW
  -- and never an edit, which is the whole point of the table.
  version             integer     not null check (version >= 1),
  -- The version this one replaces. Exactly the rows with `version > 1` carry it, and ZY054 additionally
  -- requires it to be the CURRENT version of the SAME period — so the chain cannot fork.
  supersedes_id       uuid        references vat_return (id),
  -- WHY the return was amended. An amendment with no stated reason is one nobody can review, and a tax
  -- agent reviewing this table is what the whole unit is for.
  amendment_reason    text,
  -- The `period_lock` that covered the period when the snapshot was taken, from `periodStatusOn` — the one
  -- reader of "is this date closed?" in this repository. A plain column and NOT a foreign key: see the
  -- header on 0086's releasable-pin test.
  closed_period_id    text        not null
                        constraint vat_return_closed_period_is_identified
                        check (not is_placeholder_text(closed_period_id)),
  -- The canonical form's tag, from the paper itself. A future form is INCOMPARABLE rather than unequal.
  format_version      text        not null
                        constraint vat_return_format_version_is_stated
                        check (not is_placeholder_text(format_version) and length(format_version) <= 60),
  -- The GENERATING CODE VERSION: `vat201_engine_signature()` at the moment of snapshotting.
  engine_signature    text        not null
                        constraint vat_return_engine_signature_is_sha256
                        check (engine_signature ~ '^[0-9a-f]{64}$'),
  -- `period_trial_balance_hash(ends_on)`, M-VAT-06's evidence about the LEDGER. The snapshot's own hash
  -- answers "is this the return I filed"; this one answers "is this the ledger it was filed from". Both are
  -- here because they are different questions.
  trial_balance_hash  text        not null
                        constraint vat_return_trial_balance_hash_is_sha256
                        check (trial_balance_hash ~ '^[0-9a-f]{64}$'),
  -- sha256 of `snapshot_json`, tied to it by a CHECK below. The same value `vat201ContentHash()` computes.
  content_hash        text        not null
                        constraint vat_return_content_hash_is_sha256
                        check (content_hash ~ '^[0-9a-f]{64}$'),
  -- THE SNAPSHOT. Exactly the bytes `canonicaliseVat201WorkingPapers()` produced over the paper with its
  -- own `contentHash` omitted — keys sorted recursively, every figure a decimal string of integer fils, no
  -- instant anywhere in it, so two reads five years apart produce the same bytes.
  --
  -- `text` and not `jsonb`: `jsonb` normalises whitespace, drops duplicate keys and reorders, so the bytes
  -- that come back out would not be the bytes that were hashed and `content_hash` could not be checked
  -- against them. The views below cast to `jsonb` to READ it, which is free and changes nothing stored.
  snapshot_json       text        not null,
  -- The paper's own verdict, copied out for a screen and REFUSED the chance to improve on it. See the CHECK.
  fileable            boolean     not null,
  prepared_by_actor_kind  text    not null
                        constraint vat_return_actor_kind_known
                        check (prepared_by_actor_kind in ('staff', 'system')),
  prepared_by_actor_label text    not null
                        constraint vat_return_actor_is_stated
                        check (not is_placeholder_text(prepared_by_actor_label)
                               and length(prepared_by_actor_label) <= 200),
  -- The caller's clock, NOT defaulted: see the header.
  snapshotted_at      timestamptz not null,
  created_at          timestamptz not null default now(),

  -- One snapshot per version of a period. A second row claiming to be version 2 of one period would make
  -- "the return as filed" two answers.
  constraint vat_return_one_row_per_version unique (period_id, version),
  constraint vat_return_ends_after_it_starts check (ends_on >= starts_on),

  -- THE hash rule. `content_hash` is the hash of the bytes in this row and cannot be the hash of anything
  -- else. A CHECK rather than a trigger so it holds during a restore with triggers off, and because it is a
  -- statement about ONE ROW, which is what a CHECK is for.
  constraint vat_return_snapshot_hash_is_the_hash_of_the_snapshot
    check (content_hash = encode(sha256(convert_to(snapshot_json, 'UTF8')), 'hex')),

  -- A snapshot with no figures in it is not a snapshot. ADR 0002 applied to the artefact rather than to a
  -- test: an empty `boxes` array would store, hash and verify perfectly and say nothing.
  constraint vat_return_snapshot_carries_its_figures
    check (jsonb_array_length((snapshot_json::jsonb) -> 'boxes') > 0),

  -- The columns that also live inside the bytes, tied to them. Two constraints rather than one so a
  -- violation says whether the PERIOD or the PROVENANCE disagreed; see the header on why they are
  -- duplicated at all.
  constraint vat_return_period_columns_are_the_snapshot_s_own
    check (period_id = (snapshot_json::jsonb) -> 'period' ->> 'periodId'
           and starts_on = ((snapshot_json::jsonb) -> 'period' ->> 'startsOn')::date
           and ends_on = ((snapshot_json::jsonb) -> 'period' ->> 'endsOn')::date),
  constraint vat_return_provenance_columns_are_the_snapshot_s_own
    check (closed_period_id = (snapshot_json::jsonb) ->> 'closedPeriodId'
           and format_version = (snapshot_json::jsonb) ->> 'formatVersion'
           and trial_balance_hash = (snapshot_json::jsonb) ->> 'trialBalanceHash'
           and fileable = ((snapshot_json::jsonb) ->> 'fileable')::boolean),

  -- The trap this unit is most able to walk into: a snapshot that makes an unfileable return look
  -- fileable. Both halves are read out of the HASHED BYTES rather than out of a flag beside them, so the
  -- only way to store `fileable = true` is for the snapshot itself to carry no reason against filing and no
  -- provisional box. Every box is provisional today (0089, Y11-vat201-boxes), so today the answer is always
  -- false and the row says why.
  constraint vat_return_fileable_only_when_nothing_in_it_refuses_filing
    check (fileable = false
           or (jsonb_array_length((snapshot_json::jsonb) -> 'notFileableReasons') = 0
               and not ((snapshot_json::jsonb) -> 'boxes' @> '[{"isProvisional": true}]'::jsonb))),

  -- The shape of an amendment, in two halves so a violation names which one. ZY054 carries the
  -- cross-ROW half, which a CHECK cannot express.
  constraint vat_return_only_an_amendment_supersedes
    check ((version > 1) = (supersedes_id is not null)),
  constraint vat_return_amendment_carries_a_reason
    check ((supersedes_id is not null)
           = (amendment_reason is not null and btrim(amendment_reason) <> ''))
);

comment on table vat_return is
  'One appended row per version of one VAT return: the canonical working-paper bytes, the sha256 of '
  'exactly those bytes, the trial-balance hash of the ledger behind them, and the engine signature of the '
  'code that computed them. UPDATE and DELETE raise (ZY051) for every role including the owner. A return '
  'that was wrong is corrected by a NEW version naming the one it supersedes and saying why — never by an '
  'edit, because the superseded version has to stay readable for "what did we file, and on what".';
comment on column vat_return.snapshot_json is
  'The FIGURES, as the exact bytes canonicaliseVat201WorkingPapers() produced. Not a recipe to recompute '
  'them: vat_return_box_figure reads this column and never the ledger, so a figure cannot move when the '
  'journal does. text and not jsonb, because jsonb normalises and content_hash is a hash of these bytes.';
comment on column vat_return.engine_signature is
  'vat201_engine_signature() at the moment of snapshotting: the sha256 of the seven engine functions'' '
  'definitions. The generating code version, read from the code rather than typed as a number.';
comment on column vat_return.closed_period_id is
  'The period_lock that covered the period, from periodStatusOn. A plain column: a period_lock row CAN be '
  'deleted and a vat_return row cannot, so a reference from here would pin every lock it names for ever '
  '(0086''s releasable-pin test). The evidence is trial_balance_hash, which needs no row to stay true.';
comment on constraint vat_return_snapshot_hash_is_the_hash_of_the_snapshot on vat_return is
  'content_hash = sha256(snapshot_json). A CHECK, so it holds during a restore with triggers off and any '
  'reader can reproduce it. It does NOT claim the bytes are what the ledger said — that is proven by '
  'regenerating the papers, which packages/db/src/services/vat-return-signoff.itest.ts does with the clock '
  'five years on.';
comment on constraint vat_return_fileable_only_when_nothing_in_it_refuses_filing on vat_return is
  'fileable = true is impossible while the hashed bytes carry a notFileableReasons entry or a provisional '
  'box. Read out of the snapshot and not out of a flag beside it, so a snapshot cannot make an unfileable '
  'return look fileable — the one failure here that ends with something wrong sent to the FTA.';

create index vat_return_period_idx on vat_return (period_id, version desc);
create index vat_return_window_idx on vat_return (ends_on desc, starts_on);
-- The amendment chain, read backwards from a correction to what it replaced.
create index vat_return_supersedes_idx on vat_return (supersedes_id) where supersedes_id is not null;

-- ---------------------------------------------------------------------------------------------
-- 4. The figures, as views over the hashed bytes
-- ---------------------------------------------------------------------------------------------
-- Every column here comes out of `vat_return.snapshot_json`. Nothing below names `journal_line`,
-- `journal_entry`, `account`, `vat201_box`, `vat201_box_mapping` or any `vat201_*()` function, and gate case
-- 122t asserts that over the view definitions with a fixture that plants such a join and requires it to be
-- found. That absence IS the snapshot: a view that reached the ledger would recompute the return on every
-- read, which is what M-VAT-07's working paper is for and what a filed return must never be.
--
-- `::bigint` on the two figures because the fils domain is integer and the canonical form writes every
-- `bigint` as a decimal STRING — `JSON.stringify` throws on a bigint, and a figure silently becoming a JSON
-- number is how a box total rounds at 2^53 in the artefact somebody compares.
create view vat_return_box_figure as
  select r.id                                      as return_id,
         r.period_id,
         r.version,
         (box ->> 'boxNo')::integer                as box_no,
         -- SNAPSHOTTED. A later migration answering Y11-vat201-boxes renames and renumbers `vat201_box`;
         -- this is what the form said when the return was signed, and a join would rewrite it.
         box ->> 'label'                           as label,
         box ->> 'side'                            as side,
         (box ->> 'displayOrder')::integer         as display_order,
         (box ->> 'isProvisional')::boolean        as is_provisional,
         box ->> 'openQuestionId'                  as open_question_id,
         (box ->> 'netSuppliesFils')::bigint       as net_supplies_fils,
         (box ->> 'taxFils')::bigint               as tax_fils,
         (box ->> 'lineCount')::bigint             as line_count
    from vat_return r
    cross join lateral jsonb_array_elements((r.snapshot_json::jsonb) -> 'boxes') as box;

comment on view vat_return_box_figure is
  'The box figures of a snapshot, read out of vat_return.snapshot_json and NEVER out of the ledger. A view '
  'rather than a table because a second copy of a figure drifts and nothing in SQL could prove it had not; '
  'there is no second copy here, so a figure cannot be appended, edited or forgotten. No index, which '
  'costs nothing: a VAT return is quarterly and every read names one id.';

-- Why this return may not be filed, one row each, as snapshotted. A zero-reason return is a decision and
-- not a gap — and while Y11-tax-agent stands there is always at least one row.
create view vat_return_not_fileable_reason as
  select r.id                       as return_id,
         r.period_id,
         r.version,
         reason ->> 'reason'        as reason,
         reason ->> 'openQuestionId' as open_question_id,
         reason ->> 'detail'        as detail
    from vat_return r
    cross join lateral jsonb_array_elements((r.snapshot_json::jsonb) -> 'notFileableReasons') as reason;

comment on view vat_return_not_fileable_reason is
  'The reasons the snapshot itself gives for not being fileable, read out of the hashed bytes. The CHECK '
  'vat_return_fileable_only_when_nothing_in_it_refuses_filing makes fileable = true impossible while any '
  'of these exists, so the rows and the verdict cannot disagree.';

-- ---------------------------------------------------------------------------------------------
-- 5. An amendment is the NEXT version of the SAME period, and cannot fork
-- ---------------------------------------------------------------------------------------------
-- `plpgsql` and not a CHECK, because every rule here is about ANOTHER ROW. The CHECKs on the table answer
-- the single-row half (a version > 1 carries a supersession and a reason) and are the layer that survives a
-- restore; this is the layer that tells a human which of four things was wrong.
create function assert_vat_return_amendment() returns trigger
language plpgsql
as $$
declare
  v_prior vat_return;
  v_fork  uuid;
begin
  if new.supersedes_id is null then
    -- Version 1. The CHECK already ties that to `supersedes_id is null`; what is left is that it must be
    -- the FIRST version of the period, which `unique (period_id, version)` would also catch with a less
    -- useful message.
    if exists (select 1 from vat_return where period_id = new.period_id) then
      raise exception
        'VatReturnAmendmentNotWellFormed: period % already has a snapshot, so this row is an amendment and '
        'must carry version %, supersedes_id naming the current version, and a reason. A second version 1 '
        'would make "the return as filed" two unrelated answers about one period.',
        new.period_id,
        (select max(version) + 1 from vat_return where period_id = new.period_id)
        using errcode = 'ZY054';
    end if;
    return new;
  end if;

  select * into v_prior from vat_return where id = new.supersedes_id;
  -- The foreign key guarantees it exists, so a miss here is a defect rather than a caller error.
  if not found then
    raise exception
      'VatReturnAmendmentNotWellFormed: superseded return % does not exist, which the foreign key should '
      'have refused first.',
      new.supersedes_id
      using errcode = 'ZY054';
  end if;

  -- The same period, both the label and the dates. A cross-period amendment would make one quarter's
  -- history read as another's, and the dates are checked as well as the label because a period_id is a
  -- string somebody types.
  if v_prior.period_id <> new.period_id
     or v_prior.starts_on <> new.starts_on
     or v_prior.ends_on <> new.ends_on then
    raise exception
      'VatReturnAmendmentNotWellFormed: this amendment describes % (%..%) and supersedes a return for % '
      '(%..%). An amendment restates ONE period; superseding another period''s return would make one '
      'quarter''s filed history read as another''s.',
      new.period_id, new.starts_on, new.ends_on,
      v_prior.period_id, v_prior.starts_on, v_prior.ends_on
      using errcode = 'ZY054';
  end if;

  -- Exactly the next version, so the chain is a chain. `unique (period_id, version)` stops a repeat and
  -- says nothing about a gap; a version 4 superseding version 1 would leave 2 and 3 unaccounted for.
  if new.version <> v_prior.version + 1 then
    raise exception
      'VatReturnAmendmentNotWellFormed: version % supersedes version % of %. An amendment is the NEXT '
      'version: a gap leaves the versions in between unaccounted for, and "which return was in force on '
      'that date" stops being answerable.',
      new.version, v_prior.version, new.period_id
      using errcode = 'ZY054';
  end if;

  -- And no fork. The superseded return must be the one currently in force, which is the same rule 0093's
  -- ZZ003 makes about a publication correction: superseding an older version leaves the current one
  -- unaccounted for, and the ledger then reads as two returns in force at once.
  select id into v_fork from vat_return where supersedes_id = new.supersedes_id;
  if v_fork is not null then
    raise exception
      'VatReturnAmendmentNotWellFormed: return % has already been superseded by %, so it is not the '
      'version in force. Amend the CURRENT version of % — a second amendment of the same version forks the '
      'chain, and two returns would claim to be in force for one period.',
      new.supersedes_id, v_fork, new.period_id
      using errcode = 'ZY054';
  end if;

  return new;
end $$;

comment on function assert_vat_return_amendment() is
  'Raises ZY054 for an amendment that is not the next version, describes another period, supersedes a '
  'version that is not in force, or is a second version 1. The single-row half — a version > 1 carries a '
  'supersession and a non-blank reason — is CHECKed on the table and survives a restore with triggers off.';

create trigger vat_return_amendment_is_well_formed before insert on vat_return
  for each row execute function assert_vat_return_amendment();

-- ---------------------------------------------------------------------------------------------
-- 6. The signatures
-- ---------------------------------------------------------------------------------------------
create table vat_return_sign_off (
  id                     uuid        primary key default uuid_generate_v7(),
  return_id              uuid        not null references vat_return (id),
  -- Which half of the sign-off. Two capacities, and the acceptance criterion is that they are two PEOPLE.
  capacity               text        not null
                           constraint vat_return_sign_off_capacity_known
                           check (capacity in ('preparer', 'reviewer')),
  -- Who. NOT a foreign key to a staff table: the record of a signature outlives the record of the person
  -- (0085's reasoning for rights_request.subject_customer_id, and 0093's for publication_approval).
  signatory_user_id      text        not null
                           constraint vat_return_sign_off_signatory_is_identified
                           check (not is_placeholder_text(signatory_user_id)
                                  and length(signatory_user_id) between 1 and 200),
  -- A SNAPSHOT of the display name as it stood when they signed. Not a join: a later rename would
  -- otherwise rewrite who signed the return, which is the same failure invoice.issuer_legal_name (0026) is
  -- a snapshot against. No name is invented here and none can be — the value comes from the row the
  -- signatory was signed in as, and a blank one is refused rather than defaulted.
  signatory_display_name text        not null
                           constraint vat_return_sign_off_name_is_stated
                           check (not is_placeholder_text(signatory_display_name)
                                  and length(signatory_display_name) between 1 and 200),
  -- And the role they held then, for the same reason, against the ONE list of who may sign. Deny by
  -- default: every role not in `vat_return_signing_roles()` is refused. ZY053 beside it says which role was
  -- attempted and which are permitted, because a CHECK violation cannot.
  signatory_role         text        not null
                           constraint vat_return_sign_off_role_may_sign
                           check (signatory_role = any (vat_return_signing_roles())),
  -- The caller's clock. Not defaulted: see the header.
  signed_at              timestamptz not null,
  created_at             timestamptz not null default now(),

  -- One preparer and one reviewer per return.
  constraint vat_return_sign_off_one_per_capacity unique (return_id, capacity),
  -- And they are two DIFFERENT people, at the storage layer. This is the half that holds during a restore
  -- with triggers off; ZY052 beside it is the half that explains itself. Neither is a copy of the other:
  -- one answers "can this be stored" and the other answers "what do I tell the person".
  constraint vat_return_sign_off_is_two_people unique (return_id, signatory_user_id)
);

comment on table vat_return_sign_off is
  'One row per capacity per VAT return: who prepared it and who reviewed it, with each signatory''s display '
  'name and role SNAPSHOTTED beside their id so a later rename cannot rewrite who signed. UPDATE and '
  'DELETE raise (ZY051) for every role including the owner. A signature withdrawn is not an edit: it is a '
  'new version of the return, because the figures a reviewer refused are not the figures that get filed.';
comment on constraint vat_return_sign_off_is_two_people on vat_return_sign_off is
  'One person cannot hold both capacities. A UNIQUE index so it holds during a restore with triggers off '
  'and cannot be satisfied by editing a row (the table is append-only); ZY052 raises first and names the '
  'person and the capacity they already signed in.';
comment on column vat_return_sign_off.signatory_display_name is
  'Snapshotted at signing. A join would let a later rename rewrite who signed the return — the same reason '
  'invoice.issuer_legal_name is a snapshot (0026).';

create index vat_return_sign_off_signatory_idx
  on vat_return_sign_off (signatory_user_id, signed_at desc);
create index vat_return_sign_off_return_idx on vat_return_sign_off (return_id, capacity);

-- The two refusals a human reads. BEFORE INSERT, so they fire ahead of the unique index and the CHECK and
-- the caller gets the sentence rather than `23505` naming an index.
create function assert_vat_return_sign_off_is_a_second_person() returns trigger
language plpgsql
as $$
declare
  v_existing_capacity text;
begin
  -- The ROLE first, because a refusal about who may sign is more useful than one about who already signed.
  if not (new.signatory_role = any (vat_return_signing_roles())) then
    raise exception
      'VatReturnSignOffRoleNotPermitted: % may not sign a VAT return as %. Permitted roles: %. This is '
      'deny-by-default and not a list to widen in passing — a VAT return is a statement to the FTA, and '
      'the roles that may make it are the ones holding vat_return:prepare in '
      'packages/core/src/access/permissions.ts. Widening it means widening that permission, in core, where '
      'the matrix is tested.',
      new.signatory_role, new.capacity,
      array_to_string(vat_return_signing_roles(), ', ')
      using errcode = 'ZY053';
  end if;

  select capacity into v_existing_capacity
    from vat_return_sign_off
   where return_id = new.return_id
     and signatory_user_id = new.signatory_user_id;

  if v_existing_capacity is not null then
    raise exception
      'SamePersonSignOff: % has already signed return % as %, so they cannot also sign as %. The whole '
      'value of a two-signature return is that a second person looked at it: one person signing both '
      'halves records a review that did not happen, and it is the only defect here that leaves no trace '
      'in the figures. A second signatory in the accountant or owner role has to sign, or the return is '
      'not signed.',
      new.signatory_display_name, new.return_id, v_existing_capacity, new.capacity
      using errcode = 'ZY052';
  end if;

  return new;
end $$;

comment on function assert_vat_return_sign_off_is_a_second_person() is
  'Raises ZY053 for a role outside vat_return_signing_roles() and ZY052 (SamePersonSignOff) when one '
  'person would hold both capacities. BEFORE INSERT so it fires ahead of the CHECK and the UNIQUE index, '
  'which are the layers that still hold when a restore has triggers off.';

create trigger vat_return_sign_off_is_a_second_person before insert on vat_return_sign_off
  for each row execute function assert_vat_return_sign_off_is_a_second_person();

-- ---------------------------------------------------------------------------------------------
-- 7. Is this return signed? ONE reader
-- ---------------------------------------------------------------------------------------------
-- Called by the finalisation trigger, by `vat_return_for_filing()` and by the service's reader, so the
-- refusal a caller gets and the answer a screen shows cannot disagree. M-VAT-06's `periodStatusOn` is the
-- same arrangement for "is this date closed?", for the same reason: the day two readers of one question
-- disagree, a return gets filed that something else believed was unsigned.
create function vat_return_sign_off_state(p_return_id uuid)
returns table (
  preparer_user_id       text,
  preparer_display_name  text,
  preparer_role          text,
  preparer_signed_at     timestamptz,
  reviewer_user_id       text,
  reviewer_display_name  text,
  reviewer_role          text,
  reviewer_signed_at     timestamptz,
  signed                 boolean
)
language sql
stable
as $$
  -- An aggregate with no GROUP BY returns exactly one row, so a return with no signatures at all answers
  -- with nulls and `signed = false` rather than with no row — which a caller would have to special-case,
  -- and the special case is where "no row" gets read as "fine".
  select max(s.signatory_user_id)      filter (where s.capacity = 'preparer'),
         max(s.signatory_display_name) filter (where s.capacity = 'preparer'),
         max(s.signatory_role)         filter (where s.capacity = 'preparer'),
         max(s.signed_at)              filter (where s.capacity = 'preparer'),
         max(s.signatory_user_id)      filter (where s.capacity = 'reviewer'),
         max(s.signatory_display_name) filter (where s.capacity = 'reviewer'),
         max(s.signatory_role)         filter (where s.capacity = 'reviewer'),
         max(s.signed_at)              filter (where s.capacity = 'reviewer'),
         count(*) filter (where s.capacity = 'preparer') = 1
           and count(*) filter (where s.capacity = 'reviewer') = 1
    from vat_return_sign_off s
   where s.return_id = p_return_id;
$$;

comment on function vat_return_sign_off_state(uuid) is
  'The preparer and the reviewer of one return, and whether BOTH have signed. The ONE reader of "is this '
  'signed": the finalisation trigger, vat_return_for_filing() and the service reader all call it, so a '
  'refusal and a screen cannot disagree. Always exactly one row, nulls included, so "no signatures" does '
  'not arrive as "no row".';

-- ---------------------------------------------------------------------------------------------
-- 8. Marked final — and refused without both signatures
-- ---------------------------------------------------------------------------------------------
create table vat_return_finalisation (
  id           uuid        primary key default uuid_generate_v7(),
  -- One finalisation per return. A second one would be a second claim about when the return became final.
  return_id    uuid        not null unique references vat_return (id),
  finalised_at timestamptz not null,
  actor_kind   text        not null
                 constraint vat_return_finalisation_actor_kind_known
                 check (actor_kind in ('staff', 'system')),
  actor_label  text        not null
                 constraint vat_return_finalisation_actor_is_stated
                 check (not is_placeholder_text(actor_label) and length(actor_label) <= 200),
  created_at   timestamptz not null default now()
);

comment on table vat_return_finalisation is
  'One row per return that has been marked final: the point after which it may be exported. UPDATE and '
  'DELETE raise (ZY051). Refused by ZY055 unless both a preparer and a reviewer have signed, so "an '
  'unsigned return cannot be marked final" is a property of the database rather than of whichever caller '
  'checked. A final return that was wrong is not un-finalised: it is amended, which is a new version with '
  'its own signatures and its own finalisation.';

create function assert_vat_return_is_signed_off() returns trigger
language plpgsql
as $$
declare
  v_state record;
begin
  select * into v_state from vat_return_sign_off_state(new.return_id);

  if not v_state.signed then
    raise exception
      'VatReturnNotSignedOff: return % cannot be marked final. Preparer: %. Reviewer: %. A VAT return is '
      'final when two different people in the accountant or owner role have signed it — one of them '
      'prepared the figures and the other reviewed them — and a return marked final without that is a '
      'return nobody checked, carrying a mark that says somebody did.',
      new.return_id,
      coalesce(v_state.preparer_display_name, 'not signed'),
      coalesce(v_state.reviewer_display_name, 'not signed')
      using errcode = 'ZY055';
  end if;

  return new;
end $$;

comment on function assert_vat_return_is_signed_off() is
  'Raises ZY055 for a finalisation of a return that is not signed by both a preparer and a reviewer. Reads '
  'vat_return_sign_off_state(), which is the only reader of that question, so this and '
  'vat_return_for_filing() cannot disagree.';

create trigger vat_return_finalisation_is_signed_off before insert on vat_return_finalisation
  for each row execute function assert_vat_return_is_signed_off();

-- ---------------------------------------------------------------------------------------------
-- 9. The door labelled FILING, and the same refusal on a READ
-- ---------------------------------------------------------------------------------------------
-- M-VAT-09 builds the one-way Zoho Books export and its acceptance line is that it is "allowed only for a
-- signed return". A privilege cannot express that and a TypeScript guard is a guarantee about the callers
-- that went through it, so the refusal lives here: the read that hands back a return FOR FILING raises
-- ZY055 when it is not signed and final.
--
-- The base table stays readable on purpose (see the header): a preparer must be able to see the figures
-- they are about to sign. What this function is, is the door — a caller that did not come through it is not
-- reading "the return for filing", and gate case 122q asserts that every consumer in
-- VAT_RETURN_CONSUMERS that requires sign-off really is refused one that is unsigned.
create function vat_return_for_filing(p_return_id uuid)
returns table (
  return_id        uuid,
  period_id        text,
  starts_on        date,
  ends_on          date,
  version          integer,
  content_hash     text,
  engine_signature text,
  format_version   text,
  snapshot_json    text,
  finalised_at     timestamptz
)
language plpgsql
stable
as $$
declare
  v_state       record;
  v_finalised   timestamptz;
begin
  select * into v_state from vat_return_sign_off_state(p_return_id);
  select f.finalised_at into v_finalised
    from vat_return_finalisation f where f.return_id = p_return_id;

  if not v_state.signed or v_finalised is null then
    raise exception
      'VatReturnNotSignedOff: return % may not be read for filing. Preparer: %. Reviewer: %. Marked '
      'final: %. Filing reads this function rather than the table so that the check cannot be skipped by '
      'a caller that did not know about it — including a psql session and a later export nobody has '
      'written yet.',
      p_return_id,
      coalesce(v_state.preparer_display_name, 'not signed'),
      coalesce(v_state.reviewer_display_name, 'not signed'),
      coalesce(v_finalised::text, 'no')
      using errcode = 'ZY055';
  end if;

  return query
    select r.id, r.period_id, r.starts_on, r.ends_on, r.version, r.content_hash, r.engine_signature,
           r.format_version, r.snapshot_json, v_finalised
      from vat_return r
     where r.id = p_return_id;
end $$;

comment on function vat_return_for_filing(uuid) is
  'The return as a filing reads it, refused with ZY055 unless both signatures and the finalisation exist. '
  'M-VAT-09''s one-way export reads this; the base table stays readable so a preparer can see what they '
  'are signing. Reads vat_return_sign_off_state(), the one reader of "is this signed".';

-- ---------------------------------------------------------------------------------------------
-- 10. Every signature and every finalisation writes an audit_event, in the SAME transaction
-- ---------------------------------------------------------------------------------------------
-- 0081's ZW003 and 0093's ZZ004 shape, for their reason: a `deferrable initially deferred` constraint
-- trigger runs at COMMIT, by which time the audit row either is in this transaction or is not — so it
-- cannot be satisfied by one written afterwards in a second transaction, which is what a plain AFTER
-- trigger would have allowed. "Every sign-off is audited" is the sort of sentence that is true of the code
-- that was reviewed and false of the third caller.
--
-- A statutory signature whose only evidence is the signature itself is what this is against: the audit row
-- carries the actor, the request and the IP, and the sign-off row carries none of them.
create function assert_vat_return_act_is_audited() returns trigger
language plpgsql
as $$
declare
  v_action text := case tg_table_name
                     when 'vat_return_sign_off'    then 'vat_return.sign_off'
                     when 'vat_return_finalisation' then 'vat_return.finalised'
                   end;
begin
  if exists (select 1 from audit_event
              where entity_type = tg_table_name
                and entity_id = new.id::text
                and action = v_action) then
    return null;
  end if;

  raise exception
    'VatReturnSignOffNotAudited: %.% reached COMMIT with no audit_event(action=%, entity_type=%, '
    'entity_id=%) in the same transaction. An audit row written afterwards in a second transaction is not '
    'the same guarantee: the signature can commit and the audit can fail, and the only evidence that a '
    'named person signed this return would be the row they signed.',
    tg_table_schema, tg_table_name, v_action, tg_table_name, new.id
    using errcode = 'ZY057';
end $$;

comment on function assert_vat_return_act_is_audited() is
  'Raises ZY057 at COMMIT for a sign-off or a finalisation with no matching audit_event in the same '
  'transaction. A deferrable constraint trigger rather than an AFTER trigger, so the audit row may be '
  'written either side of the act and neither may be written in a later transaction (0081 ZW003''s shape).';

create constraint trigger vat_return_sign_off_audited
  after insert on vat_return_sign_off
  deferrable initially deferred
  for each row execute function assert_vat_return_act_is_audited();

create constraint trigger vat_return_finalisation_audited
  after insert on vat_return_finalisation
  deferrable initially deferred
  for each row execute function assert_vat_return_act_is_audited();

-- ---------------------------------------------------------------------------------------------
-- 11. Append-only, for every role
-- ---------------------------------------------------------------------------------------------
-- A trigger and not `create rule … do instead nothing`, which reports success and lets the caller go on
-- believing the edit happened (0018's argument, restated by 0085 and 0093). For EVERY role including the
-- owner: privileges cover the application role, and a migration or a `psql` session does not connect as it.
create function refuse_vat_return_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'VatReturnSnapshotImmutable: %.% is append-only; % is refused. A filed VAT return is a statement made '
    'on a date about a period: the figures, the two signatures and the mark that made it final are the '
    'evidence of what was filed and by whom. A return that was wrong is not corrected by editing the row '
    'that records it — it is corrected by a NEW version naming the one it supersedes and saying why, which '
    'is what keeps the superseded version readable.',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'ZY051';
end $$;

comment on function refuse_vat_return_change() is
  'Raises ZY051 for UPDATE and DELETE on vat_return, vat_return_sign_off and vat_return_finalisation, for '
  'every role including the owner.';

create trigger vat_return_no_update before update on vat_return
  for each row execute function refuse_vat_return_change();
create trigger vat_return_no_delete before delete on vat_return
  for each row execute function refuse_vat_return_change();
create trigger vat_return_sign_off_no_update before update on vat_return_sign_off
  for each row execute function refuse_vat_return_change();
create trigger vat_return_sign_off_no_delete before delete on vat_return_sign_off
  for each row execute function refuse_vat_return_change();
create trigger vat_return_finalisation_no_update before update on vat_return_finalisation
  for each row execute function refuse_vat_return_change();
create trigger vat_return_finalisation_no_delete before delete on vat_return_finalisation
  for each row execute function refuse_vat_return_change();

-- ---------------------------------------------------------------------------------------------
-- 12. Privileges
-- ---------------------------------------------------------------------------------------------
-- The application may append a snapshot, a signature and a finalisation, and may read everything. It may
-- not edit or remove any of them. Stated explicitly rather than relying on the triggers alone, for 0093's
-- reason: the two answer different questions — "may this role" and "may anybody" — and a privilege is what
-- a reader of `\dp` sees. The integration suite connects as OWNER and therefore cannot see this layer at
-- all, which is the gap that has caught five units; gate case 122a is what covers it.
grant select, insert on vat_return             to berelax_app;
grant select, insert on vat_return_sign_off    to berelax_app;
grant select, insert on vat_return_finalisation to berelax_app;
revoke update, delete, truncate on vat_return             from berelax_app;
revoke update, delete, truncate on vat_return_sign_off    from berelax_app;
revoke update, delete, truncate on vat_return_finalisation from berelax_app;

-- The views are reads over `vat_return`, and a view runs with the privileges of its OWNER, so a SELECT here
-- is all the application needs to see the figures.
grant select on vat_return_box_figure         to berelax_app;
grant select on vat_return_not_fileable_reason to berelax_app;

grant select on vat_return, vat_return_sign_off, vat_return_finalisation to berelax_readonly;
grant select on vat_return_box_figure, vat_return_not_fileable_reason to berelax_readonly;

commit;
