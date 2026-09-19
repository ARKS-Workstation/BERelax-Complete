-- 0043 — KEK rotation for clinical DEKs.
--
-- Rotating the key-encrypting key re-wraps every per-record data key and rewrites NO ciphertext.
-- That is the whole reason the envelope exists (ADR 0010): a rotation moves a few dozen bytes per
-- record instead of re-encrypting every intake form, so it is a routine background job rather than
-- an outage, and it can be stopped and resumed at any record.
--
-- Three properties are enforced HERE, in the database, and not in the application layer that drives
-- the rotation. ADR 0010's thesis is that the clinical boundary must survive a mistake in the
-- application, and a rotation is a mass UPDATE over the most sensitive table in the system — the one
-- place where an application bug is least survivable:
--
--   1. a KEK version that is not the active one cannot ENCRYPT, though it can still decrypt;
--   2. an UPDATE may rewrite the wrapped data key and nothing else, so a re-wrap cannot touch the
--      ciphertext, the nonce, the row identity or the AAD fingerprint;
--   3. an UPDATE that changes the version must actually change the wrapped key, so a rotation that
--      merely bumped a version column fails instead of leaving unreadable records behind.
--
-- The key MATERIAL is never in this database. Only version labels are, because the point of the
-- version is to say which externally-held key opens a row.

-- ---------------------------------------------------------------------------------------------
-- The version registry.
-- ---------------------------------------------------------------------------------------------
--
-- Lives in the `clinical` schema, so it is dumped, moved and restored with the clinical store it
-- describes (ADR 0010: the boundary is designed for relocation, and a version registry left behind
-- in `public` would make the moved store unreadable). The Google refresh-token key version is
-- deliberately NOT in here: `public.google_connection.refresh_token_kid` tracks its own, because
-- they are two different keys on two different boundaries and a shared registry would tie the
-- clinical rotation schedule to the Google one.

create table clinical.kek_version (
  version      text        primary key
                           check (version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  status       text        not null check (status in ('active', 'retired')),
  activated_at timestamptz not null default now(),
  retired_at   timestamptz,
  -- A retired version must say when it was retired, and an active one must not claim to be.
  constraint kek_version_retired_at_matches_status
    check ((status = 'retired') = (retired_at is not null))
);

comment on table clinical.kek_version is
  'Which KEK versions exist and which one may encrypt. Key MATERIAL is never stored here — only the '
  'label that says which externally-held key opens a row. A retired version is RETAINED, because '
  'discarding it before every row has been re-wrapped makes those rows unreadable.';

-- Exactly one version may encrypt. Two active versions means two rows sealed the same minute cannot
-- be told apart by which key they need, which is the state rotation exists to leave.
create unique index kek_version_one_active on clinical.kek_version ((true)) where status = 'active';

/**
 * The version that may encrypt, or null when the registry is empty.
 *
 * A function rather than a subquery repeated in two triggers: the rule is one rule, and the second
 * copy of it is where the two drift apart.
 */
create or replace function clinical.active_kek_version()
returns text
language sql
stable
as $$
  select version from clinical.kek_version where status = 'active'
$$;

/**
 * Retirement is one-way.
 *
 * Bringing a retired version back would encrypt new records under a key that has been out of the
 * active set — the reason it left may have been that it was exposed, and nothing in the registry
 * records which reason applied. Rotating forward to a new version costs one row.
 */
create or replace function clinical.forbid_kek_reactivation()
returns trigger
language plpgsql
as $$
begin
  if old.status = 'retired' and new.status = 'active' then
    raise exception
      'KekReactivationRefused: KEK version "%" was retired at %. Retirement is one-way: rotate '
      'forward to a new version instead.', old.version, old.retired_at
      using errcode = 'ZK005';
  end if;
  return new;
end $$;

create trigger kek_version_no_reactivation
  before update on clinical.kek_version
  for each row execute function clinical.forbid_kek_reactivation();

-- ---------------------------------------------------------------------------------------------
-- What a sealed row may accept, and what a re-wrap may change.
-- ---------------------------------------------------------------------------------------------
--
-- One trigger function for both sealed tables. It compares `to_jsonb(new)` against `to_jsonb(old)`
-- rather than naming columns, for two reasons: the two tables spell their ciphertext differently
-- (`payload_ciphertext` versus `body_ciphertext`), and a column added by a later migration is
-- covered the day it appears rather than the day somebody remembers to add it here.
--
-- The mutable set is an allow-list of three columns. `superseded_at` is in it because an intake
-- submission is superseded rather than edited; `treatment_note` has no such column, and listing it
-- for both is harmless and keeps one function instead of two.

create or replace function clinical.enforce_sealed_row_writes()
returns trigger
language plpgsql
as $$
declare
  v_active   text := clinical.active_kek_version();
  v_mutable  text[] := array['wrapped_data_key', 'kek_version', 'superseded_at'];
  v_old      jsonb;
  v_new      jsonb;
  v_changed  text;
begin
  if tg_op = 'INSERT' then
    -- A retired KEK may decrypt for as long as it is retained and may never encrypt. This is the
    -- half of rotation that is easy to get wrong in the other direction: refusing the retired key
    -- for reads would make a half-rotated estate unreadable, which is the outage rotation avoids.
    if v_active is null then
      raise exception
        'KekNotActive: clinical.kek_version has no active row, so nothing may be sealed. Register '
        'the current KEK version before writing a clinical record.'
        using errcode = 'ZK001';
    end if;
    if new.kek_version <> v_active then
      raise exception
        'KekRetiredCannotEncrypt: KEK version "%" may not encrypt; "%" is the active version. A '
        'retired KEK is retained so that rows still sealed with it can be DECRYPTED and re-wrapped.',
        new.kek_version, v_active
        using errcode = 'ZK001';
    end if;
    return new;
  end if;

  v_old := to_jsonb(old);
  v_new := to_jsonb(new);

  -- Every column outside the mutable set must be byte-identical. This is the rule that makes
  -- "rotation never rewrites ciphertext" a fact about the database rather than a property of
  -- whichever code happened to issue the UPDATE — and it is also the AAD's protection, because the
  -- AAD is `table | record id | customer id` and two of those three are columns of this row.
  select key into v_changed
    from jsonb_each(v_new) as n(key, value)
   where not (n.key = any (v_mutable))
     and (v_old -> n.key) is distinct from n.value
   order by key
   limit 1;

  if v_changed is not null then
    raise exception
      'SealedRowImmutable: %.% may not change column "%" on UPDATE. A re-wrap rewrites the wrapped '
      'data key; the ciphertext, the nonce and the row identity the AAD binds it to stay as they '
      'were. Correct a clinical record by superseding it, never by rewriting it.',
      tg_table_schema, tg_table_name, v_changed
      using errcode = 'ZK002';
  end if;

  if new.kek_version <> old.kek_version then
    if new.kek_version <> v_active then
      raise exception
        'KekRetiredCannotEncrypt: cannot re-wrap %.% onto KEK version "%"; "%" is the active '
        'version.', tg_table_schema, tg_table_name, new.kek_version, coalesce(v_active, '(none)')
        using errcode = 'ZK001';
    end if;
    -- A re-wrap encrypts the data key again under a fresh nonce, so the bytes always change. Equal
    -- bytes with a new version label means the version column was bumped and the key was not
    -- re-wrapped, which is exactly the bug that leaves a record that nothing can open.
    if new.wrapped_data_key = old.wrapped_data_key then
      raise exception
        'RewrapDidNotRewrap: %.% moved from KEK "%" to "%" with an unchanged wrapped_data_key. The '
        'row is now labelled with a key that cannot open it.',
        tg_table_schema, tg_table_name, old.kek_version, new.kek_version
        using errcode = 'ZK003';
    end if;
  end if;

  return new;
end $$;

comment on function clinical.enforce_sealed_row_writes() is
  'Raises ZK001 (a KEK that may not encrypt), ZK002 (an UPDATE touching anything but the wrapped '
  'key, the version or superseded_at) or ZK003 (a version change with an unchanged wrapped key).';

create trigger intake_submission_sealed_writes
  before insert or update on clinical.intake_submission
  for each row execute function clinical.enforce_sealed_row_writes();

create trigger treatment_note_sealed_writes
  before insert or update on clinical.treatment_note
  for each row execute function clinical.enforce_sealed_row_writes();

-- ---------------------------------------------------------------------------------------------
-- Privileges.
-- ---------------------------------------------------------------------------------------------
--
-- Stated explicitly rather than relying on 0009's `alter default privileges`, which applies only to
-- objects created by the role that set it; a migration applied by a different owner would leave the
-- clinical role unable to read its own registry.
grant select, insert, update on clinical.kek_version to berelax_clinical;

-- The clinical role could not write an audit row.
--
-- 0009 grants it `select` on public and nothing else, so `clinical.read` — the audited read that
-- ADR 0010 requires for every access to health data, and that `ClinicalStore.readIntake` is
-- documented to write — could not be recorded, and neither could a rotation's own event. INSERT
-- only: `audit_event` is append-only by rules in 0005 for every role, and this grant does not
-- weaken that.
grant insert on audit_event to berelax_clinical;

-- ---------------------------------------------------------------------------------------------
-- The initial version.
-- ---------------------------------------------------------------------------------------------
--
-- `v1` is a label, not a secret and not a business fact: it is the default the code already uses
-- when no version is configured, and it names the first externally-held clinical KEK. No clinical
-- record exists in any environment yet (Y5-residency gates loading real intake data), so there is
-- nothing to back-fill and no row is left pointing at a version this table does not know.
insert into clinical.kek_version (version, status) values ('v1', 'active');
