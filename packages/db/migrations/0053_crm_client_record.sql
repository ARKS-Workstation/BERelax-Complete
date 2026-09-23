-- 0053 — the client record: preferences, tags, lifecycle, source, VIP, and a blocklist that blocks.
--
-- C-CRM-01. 0019 gave the customer an identity — one row per phone number, no account, no credential
-- (ADR 0014). This migration makes it a CRM record, expand-only over that table exactly as 0050 was
-- expand-only over 0030: every statement below either ADDs a column to `customer` or creates a new
-- table referencing it, and the identity, the match keys and the OTP estate keep working unchanged.
--
-- ## The blocklist is keyed on a CONTACT DETAIL, not on a customer id
--
-- This is the decision the whole unit turns on. The person the front desk needs to refuse most often
-- has no customer row at all — a walk-in who was abusive, a number that books every Friday and never
-- arrives — and the one who does has already worked out that a second phone number makes a second
-- record. A blocklist built on `customer_id` refuses the record rather than the person, so it is
-- bypassed by the cheapest possible action and it reads, in review, exactly like a blocklist that
-- works.
--
-- So `customer_blocklist` holds `(key_kind, key_value)` where the value is NORMALISED — E.164 for a
-- phone, a lower-cased address for an email — and the booking path matches on what the request
-- carries, before any record is read or created. `customer_id` is kept as a nullable REFERENCE so the
-- admin screen can show which record an entry is about; nothing matches on it.
--
-- The check constraints below are what make "normalised" a fact rather than an intention.
-- `customer_blocklist_phone_is_e164` is the same shape check `customer_phone_is_e164` applies (0019,
-- and for the same stated reason: it catches an un-normalised value written straight into the column
-- without teaching the database a prefix list the regulator changes without telling anybody), and the
-- email check refuses anything with an upper-case character or a space in it. Without those two, one
-- entry typed as `0501234567` at the desk is an entry nothing will ever match.
--
-- ## Removing an entry is a LIFT, never a DELETE
--
-- `lifted_at`, `lifted_by_role`, `lifted_reason`, and `delete` revoked from berelax_app. The record of
-- who blocked somebody, why, and who later decided to unblock them is the only evidence that any of it
-- happened, and a DELETE erases it — the same argument 0050 makes for a superseded bank account. An
-- active entry is `lifted_at is null`, and the partial UNIQUE index makes "one active entry per key"
-- a fact the database holds rather than a rule the repository remembers.
--
-- ## The lifecycle and the source are TABLES, not Postgres enums
--
-- Both vocabularies are this build's guess: nobody has stated a client lifecycle or an attribution
-- model (Y9-crm-lifecycle, Y9-crm-source). A provisional value has to carry a marker the system can
-- see — `is_provisional`, `open_question_id`, `provisional_note`, the trio 0031 and 0032 established
-- and `unconfirmedAssumptionRows` reads — and a `create type ... as enum` has nowhere to put one. An
-- enum label also cannot be corrected without an ALTER TYPE in a new migration, which is the wrong
-- shape for a value whose whole status is "to be confirmed at deploy-and-check time" (brief rule 15,
-- docs/12 §1).
--
-- The cost is that `customer.lifecycle_state` is `text` with a foreign key rather than an enum, so the
-- set of legal values is enforced by a constraint instead of by a type. That is the same trade
-- `document_series.code` makes, and the seeds below plus `packages/core/src/crm/lifecycle.ts` are
-- pinned to each other label-for-label by packages/fixtures/src/crm-client-record.itest.ts — so a
-- seventh state in one and not the other fails the build rather than a booking.
--
-- ## The do-not-pair flag is a fact about a PAIR, and it never reaches the client
--
-- `customer_therapist_do_not_pair` is what the scheduler honours and what no customer-facing response
-- may mention: a therapist's refusal to work with a named person, recorded by a manager. The
-- availability path applies it as a **candidate exclusion** rather than as a reported exclusion reason
-- (`doNotPairExclusion` in packages/db/src/queries/therapist-exclusions.ts) — an excluded therapist is
-- simply not in the pool, so there is no reason label to leak through the `excluded` array of an
-- availability answer. `CLIENT_RECORD_AUDIENCES` in packages/core/src/crm/client-record.ts keeps it
-- out of every outward DTO by classification rather than by omission.
--
-- ## Three preference fields are free text, and that is deliberate
--
-- Language, therapist gender and room type are typed against vocabularies the system already owns.
-- Pressure, oil and music are `text`, because a closed vocabulary for them would be this build's guess
-- at words nobody has supplied, and a preference the customer cannot express is worse than a note the
-- therapist reads. `preferred_therapist_gender` is a PREFERENCE and can only narrow what B-AVAIL-05's
-- same-gender constraint already allows — the availability query does not read this table at all, and
-- a preference that could relax a compliance constraint by being set is the one shape it must not have.

begin;

-- ---------------------------------------------------------------------------------------------
-- The two provisional vocabularies
-- ---------------------------------------------------------------------------------------------

create table customer_lifecycle_state (
  state            text        primary key,
  -- The order the panel and the pipeline display them in. UNIQUE so two labels cannot claim one
  -- position, which is how a Kanban board comes to render a column twice (C-AUTO-08 depends on it).
  display_order    smallint    not null unique,
  description      text        not null,
  is_provisional   boolean     not null default false,
  open_question_id text,
  provisional_note text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The provenance trio, whole or absent. A row flagged provisional with no question id is an
  -- assumption nobody can look up, which is the state this flag exists to prevent.
  constraint customer_lifecycle_state_provenance
    check ((is_provisional and open_question_id is not null) or not is_provisional)
);

comment on table customer_lifecycle_state is
  'The client lifecycle vocabulary. A TABLE and not an enum because every label is provisional and an '
  'enum label cannot carry is_provisional, an OPEN-QUESTIONS id or a note. Pinned label-for-label to '
  'CUSTOMER_LIFECYCLE_STATES in packages/core/src/crm/lifecycle.ts.';

create table customer_acquisition_source (
  source           text        primary key,
  display_order    smallint    not null unique,
  description      text        not null,
  is_provisional   boolean     not null default false,
  open_question_id text,
  provisional_note text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint customer_acquisition_source_provenance
    check ((is_provisional and open_question_id is not null) or not is_provisional)
);

comment on table customer_acquisition_source is
  'Where a record came from. `unknown` is a member and it is the DEFAULT, because it is true of every '
  'customer the business already has: choosing walk_in for them would be an invented attribution.';

-- The seeds. In the migration rather than in a seed script, because `customer.lifecycle_state` has a
-- foreign key into this table AND a default: a database without these rows cannot accept a customer at
-- all, so they are not fixture data, they are part of the schema's meaning.
insert into customer_lifecycle_state
  (state, display_order, description, is_provisional, open_question_id, provisional_note)
values
  ('lead',    1, 'Made contact. No booking has ever been taken.', true, 'Y9-crm-lifecycle',
   'Six states chosen by this build; no client lifecycle has been stated by the business.'),
  ('new',     2, 'A booking exists. No treatment has been completed yet.', true, 'Y9-crm-lifecycle',
   'Six states chosen by this build; no client lifecycle has been stated by the business.'),
  ('active',  3, 'A current client.', true, 'Y9-crm-lifecycle',
   'Six states chosen by this build; no client lifecycle has been stated by the business.'),
  ('lapsing', 4, 'Past the first inactivity threshold. Still warm enough for a win-back.', true,
   'Y9-crm-lifecycle',
   'Six states chosen by this build; no client lifecycle has been stated by the business.'),
  ('lapsed',  5, 'Past the second inactivity threshold.', true, 'Y9-crm-lifecycle',
   'Six states chosen by this build; no client lifecycle has been stated by the business.'),
  ('blocked', 6, 'Refused service. Does not lapse and does not expire on a timer.', true,
   'Y9-crm-lifecycle',
   'Six states chosen by this build; no client lifecycle has been stated by the business.');

insert into customer_acquisition_source
  (source, display_order, description, is_provisional, open_question_id, provisional_note)
values
  ('walk_in',  1, 'Walked in off Al Wasl Road.', true, 'Y9-crm-source',
   'Six channels taken from the ones docs/13 shows in use; no attribution model has been stated.'),
  ('whatsapp', 2, 'Arrived through the published WhatsApp number.', true, 'Y9-crm-source',
   'Six channels taken from the ones docs/13 shows in use; no attribution model has been stated.'),
  ('phone',    3, 'Telephoned the salon.', true, 'Y9-crm-source',
   'Six channels taken from the ones docs/13 shows in use; no attribution model has been stated.'),
  ('web',      4, 'Booked or enquired through the website.', true, 'Y9-crm-source',
   'Six channels taken from the ones docs/13 shows in use; no attribution model has been stated.'),
  ('referral', 5, 'Sent by an existing client.', true, 'Y9-crm-source',
   'Six channels taken from the ones docs/13 shows in use; no attribution model has been stated.'),
  ('unknown',  6, 'Nobody recorded where this record came from. The default, and the honest answer '
                 'for every record that predates the system.', true, 'Y9-crm-source',
   'Six channels taken from the ones docs/13 shows in use; no attribution model has been stated.');

-- ---------------------------------------------------------------------------------------------
-- The CRM columns on the customer record
-- ---------------------------------------------------------------------------------------------

alter table customer
  -- `lead` and not `new`: a row is created by whatever touched the number first (0019), which is often
  -- an OTP request or an enquiry and not a booking. The booking path applies `booking_taken` through
  -- the lifecycle reducer, which is what moves it to `new`.
  add column lifecycle_state text not null default 'lead'
    references customer_lifecycle_state (state),
  add column lifecycle_state_changed_at timestamptz not null default now(),
  add column acquisition_source text not null default 'unknown'
    references customer_acquisition_source (source),
  add column is_vip boolean not null default false,
  add column vip_since timestamptz,
  -- The flag and its date are one fact said twice, so they cannot disagree. A VIP with no date is a
  -- flag nobody can attribute, and a date with no flag is a VIP who was silently demoted.
  add constraint customer_vip_since_matches_flag check ((vip_since is not null) = is_vip);

comment on column customer.lifecycle_state is
  'The state packages/core/src/crm/lifecycle.ts reduces over. Provisional vocabulary (Y9-crm-lifecycle). '
  '`blocked` is reached and left only by an explicit blocklist change - never by the lapse sweep.';
comment on column customer.acquisition_source is
  'Provisional vocabulary (Y9-crm-source). Defaults to `unknown`, which is the honest answer for every '
  'record whose origin nobody wrote down.';
comment on column customer.is_vip is
  'A commercial decision by the owner or a manager, never derived from spend by this schema. Staff-only: '
  'CLIENT_RECORD_AUDIENCES keeps it out of every customer-facing DTO.';

-- The lapse sweep and the pipeline both read by state. Partial on nothing: every row has a state, and
-- the selective query is "everybody in one state", which is what this serves.
create index customer_lifecycle_state_idx on customer (lifecycle_state, lifecycle_state_changed_at);

-- ---------------------------------------------------------------------------------------------
-- Preferences
-- ---------------------------------------------------------------------------------------------

create table customer_preference (
  -- One row per customer, so the primary key IS the customer. A row per (customer, kind) would make
  -- "what are this client's preferences" a pivot, and every screen would write its own.
  customer_id                uuid        primary key references customer (id) on delete cascade,
  preferred_language         text        check (preferred_language in ('en','ar')),
  -- 'female' / 'male', the two labels employee_gender holds (0030). Typed against the column the
  -- solver reads rather than against a second list.
  preferred_therapist_gender employee_gender,
  preferred_room_type        room_type,
  -- Free text, deliberately. See the header: no vocabulary for these three has been stated, and an
  -- invented enum would be indistinguishable from a configured one.
  pressure_note              text        check (pressure_note is null or length(pressure_note) <= 500),
  oil_note                   text        check (oil_note is null or length(oil_note) <= 500),
  music_note                 text        check (music_note is null or length(music_note) <= 500),
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

comment on table customer_preference is
  'Treatment preferences (docs/03 SS5). preferred_therapist_gender is a PREFERENCE: B-AVAIL-05''s '
  'same-gender rule is a hard constraint and this table is not read by the availability query, so a '
  'preference can only ever narrow what the constraint already allows.';

create trigger customer_preference_updated_at before update on customer_preference
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Tags
-- ---------------------------------------------------------------------------------------------

create table customer_tag (
  customer_id uuid        not null references customer (id) on delete cascade,
  -- A lower-case slug, because a tag typed twice with different capitalisation is two tags and the
  -- segment built on one of them silently misses half the people. No vocabulary is imposed: the labels
  -- a salon wants are its own, and enumerating them here would be this build choosing them.
  tag         text        not null
                check (tag ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(tag) between 2 and 40),
  created_at  timestamptz not null default now(),
  primary key (customer_id, tag)
);

comment on table customer_tag is
  'One row per (customer, tag). The tag shape is constrained and the vocabulary is not: which labels a '
  'salon finds useful is the salon''s decision, and a fixed list would be this build''s guess.';

create index customer_tag_tag_idx on customer_tag (tag);

-- ---------------------------------------------------------------------------------------------
-- The blocklist
-- ---------------------------------------------------------------------------------------------

create table customer_blocklist (
  id             uuid        primary key default uuid_generate_v7(),
  key_kind       text        not null check (key_kind in ('phone','email')),
  -- Normalised on the way in, and the constraints below refuse anything else. See the header.
  key_value      text        not null,
  -- The record this entry is ABOUT, when there is one. Never what the match runs on: a blocklist keyed
  -- on the record refuses the record rather than the person. ON DELETE SET NULL, because a merged-away
  -- customer must not take a live block with it.
  customer_id    uuid        references customer (id) on delete set null,
  -- Mandatory, and not a placeholder. A block with no stated reason cannot be reviewed, and
  -- is_placeholder_text (0026) refuses 'tbc', 'pending' and a blank.
  reason         text        not null
                   constraint customer_blocklist_reason_is_stated
                     check (not is_placeholder_text(reason)),
  -- The F07 role that made the change, recorded beside the row the way 0046 records a transition's
  -- role: audit_event holds the actor KIND and has never held the role, and the role is what says
  -- whether the change was authorised at all.
  added_by_role  text        not null,
  added_at       timestamptz not null default now(),
  lifted_at      timestamptz,
  lifted_by_role text,
  lifted_reason  text,
  constraint customer_blocklist_phone_is_e164
    check (key_kind <> 'phone' or key_value ~ '^\+[1-9][0-9]{7,14}$'),
  -- Lower case, one @, no whitespace. The same key packages/core/src/crm/blocklist.ts produces: an
  -- entry stored in any other spelling is an entry nothing will ever match.
  constraint customer_blocklist_email_is_normalised
    check (key_kind <> 'email' or key_value ~ '^[^[:space:]@]+@[^[:space:]@.]+(\.[^[:space:]@.]+)+$'),
  constraint customer_blocklist_email_is_lower_case
    check (key_kind <> 'email' or key_value = lower(key_value)),
  -- A lift is whole or absent, so a row cannot claim to be lifted by nobody for no reason.
  constraint customer_blocklist_lift_is_whole
    check ((lifted_at is null and lifted_by_role is null and lifted_reason is null)
        or (lifted_at is not null and lifted_by_role is not null and lifted_reason is not null))
);

comment on table customer_blocklist is
  'Blocked contact details, not blocked records. An active entry is lifted_at IS NULL. Removing an '
  'entry is a LIFT: DELETE is revoked from berelax_app, because the record of who blocked somebody and '
  'who unblocked them is the only evidence either happened.';
comment on column customer_blocklist.key_value is
  'Normalised: E.164 for a phone, a lower-cased address for an email. The three CHECK constraints on '
  'this table are what make that a fact - an entry typed 0501234567 at the desk would never match.';

-- One ACTIVE entry per key, and any number of historical ones. The partial index is the whole rule:
-- without it, blocking the same number twice leaves two rows and lifting one of them looks like an
-- unblock that did not happen.
create unique index customer_blocklist_one_active_per_key
  on customer_blocklist (key_kind, key_value) where lifted_at is null;

-- The booking path's own lookup: two keys, one statement, active entries only.
create index customer_blocklist_active_idx
  on customer_blocklist (key_value, key_kind) where lifted_at is null;

create index customer_blocklist_customer_idx
  on customer_blocklist (customer_id) where customer_id is not null;

-- ---------------------------------------------------------------------------------------------
-- The therapist do-not-pair flag
-- ---------------------------------------------------------------------------------------------

create table customer_therapist_do_not_pair (
  id             uuid        primary key default uuid_generate_v7(),
  customer_id    uuid        not null references customer (id) on delete cascade,
  -- ON DELETE RESTRICT, unlike the customer side: an employee row is not deleted when somebody leaves
  -- (employed_until is), and losing this flag with a row would silently re-enable a pairing a manager
  -- refused.
  employee_id    uuid        not null references employee (id) on delete restrict,
  reason         text        not null
                   constraint customer_therapist_do_not_pair_reason_is_stated
                     check (not is_placeholder_text(reason)),
  set_by_role    text        not null,
  created_at     timestamptz not null default now(),
  lifted_at      timestamptz,
  lifted_by_role text,
  lifted_reason  text,
  constraint customer_therapist_do_not_pair_lift_is_whole
    check ((lifted_at is null and lifted_by_role is null and lifted_reason is null)
        or (lifted_at is not null and lifted_by_role is not null and lifted_reason is not null))
);

comment on table customer_therapist_do_not_pair is
  'A manager''s record that this therapist is not to be paired with this customer. Honoured by the '
  'availability path as a silent candidate exclusion (doNotPairExclusion), so no reason label can reach '
  'an availability answer, and kept out of every outward DTO by CLIENT_RECORD_AUDIENCES.';

create unique index customer_therapist_do_not_pair_one_active
  on customer_therapist_do_not_pair (customer_id, employee_id) where lifted_at is null;

-- The availability read's own lookup: every active exclusion for one customer.
create index customer_therapist_do_not_pair_customer_idx
  on customer_therapist_do_not_pair (customer_id) where lifted_at is null;

-- ---------------------------------------------------------------------------------------------
-- The audit trigger on the two vocabularies
-- ---------------------------------------------------------------------------------------------
-- Every mutable table in the CRM area is covered either by an audited repository method or by an audit
-- trigger, and packages/fixtures/src/crm-client-record.itest.ts enumerates the area from
-- information_schema and asserts it. These two are the trigger half, and a trigger is the right
-- instrument for them precisely because they have no repository: a vocabulary is changed by a migration
-- or by a one-off admin correction, and a change nobody can attribute is the failure mode there.
--
-- Actor from the transaction-local settings 0036 introduced and 0046 reuses, empty-string-normalised
-- the same way: `set_config` cannot store SQL NULL, so a caller with nothing to say sets '' and that
-- must not be recorded as an actor somebody named. Absent means `system` with a label saying so, which
-- is the honest description of a psql correction and is visibly different from a named actor.
create or replace function record_crm_vocabulary_change() returns trigger
language plpgsql
as $$
declare
  v_actor_kind  text;
  v_actor_id    uuid;
  v_actor_label text;
  v_operation   text;
  v_entity_id   text;
begin
  v_actor_kind  := nullif(btrim(coalesce(current_setting('berelax.audit_actor_kind',  true), '')), '');
  v_actor_label := nullif(btrim(coalesce(current_setting('berelax.audit_actor_label', true), '')), '');
  -- A malformed uuid is left to raise: recording the change with the actor silently dropped is how an
  -- unattributed row comes to look like a psql correction when it was a person.
  v_actor_id    := nullif(btrim(coalesce(current_setting('berelax.audit_actor_id',    true), '')), '')::uuid;

  v_operation := case tg_op when 'INSERT' then 'create' when 'UPDATE' then 'update' else 'delete' end;
  -- The primary key is `state` on one table and `source` on the other, so it is read out of the row as
  -- jsonb rather than named: one function for both, and a third vocabulary added later needs no copy.
  v_entity_id := coalesce(to_jsonb(new) ->> tg_argv[0], to_jsonb(old) ->> tg_argv[0]);

  insert into audit_event
    (actor_kind, actor_id, actor_label, action, entity_type, entity_id, operation,
     before_state, after_state)
  values
    (coalesce(v_actor_kind, 'system'),
     v_actor_id,
     coalesce(v_actor_label, 'Direct change with no transaction-local actor (migration or psql)'),
     tg_table_name || '.changed',
     tg_table_name,
     v_entity_id,
     v_operation,
     case when tg_op = 'INSERT' then null else to_jsonb(old) end,
     case when tg_op = 'DELETE' then null else to_jsonb(new) end);
  return null;
end $$;

comment on function record_crm_vocabulary_change() is
  'Audits a change to a CRM vocabulary table. AFTER, so a row that fails a constraint leaves no audit '
  'row; takes the actor from the transaction-local berelax.audit_actor_* settings (the mechanism 0036 '
  'introduced), and records `system` with a stating label when there is none.';

create trigger customer_lifecycle_state_audit
  after insert or update or delete on customer_lifecycle_state
  for each row execute function record_crm_vocabulary_change('state');

create trigger customer_acquisition_source_audit
  after insert or update or delete on customer_acquisition_source
  for each row execute function record_crm_vocabulary_change('source');

create trigger customer_lifecycle_state_updated_at before update on customer_lifecycle_state
  for each row execute function set_updated_at();

create trigger customer_acquisition_source_updated_at before update on customer_acquisition_source
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009's `alter default privileges` grants berelax_app select/insert/update/delete on tables created in
-- public afterwards, so the revokes below are load-bearing rather than decorative. Stated explicitly
-- because a managed database restored from a dump does not necessarily carry the same defaults.
revoke delete on customer_blocklist from berelax_app;
revoke delete on customer_therapist_do_not_pair from berelax_app;

-- A tag IS deletable, and a preference row is: correcting a list of tags or a pressure note is a
-- correction, not a history. The two revokes above are for the two tables where the removal is itself
-- the fact worth keeping.

-- The reporting role has no business in either. A blocklist entry and a do-not-pair flag are the two
-- most sensitive rows in the CRM — one says the business refused somebody service, the other names an
-- employee's refusal to work with a client — and 0009 grants berelax_readonly select on every future
-- public table through `alter default privileges`, so these revokes are what make that not true here.
revoke select on customer_blocklist from berelax_readonly;
revoke select on customer_therapist_do_not_pair from berelax_readonly;

commit;
