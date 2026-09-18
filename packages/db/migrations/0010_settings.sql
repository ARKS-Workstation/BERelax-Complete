-- 0010 — the settings registry's storage.
--
-- "Everything can be tweaked in settings" is the owner's requirement; docs/07 §2 qualifies it as
-- bounded rather than unbounded. Storage therefore carries three things beyond the value:
--
--   * `is_provisional` — the value is an assumption the build made because no answer existed. This is
--     what the Unconfirmed Assumptions panel reads, and it is why deploy-and-check is one screen
--     rather than archaeology across fifteen documents.
--   * append-only history — a settings change is an audited fact, and "what was the quiet-hours
--     window in March" must be answerable.
--   * `tier` — which of the five configurability tiers the key belongs to, so a compliance-locked key
--     cannot be written by a route that only checks `settings:write`.

create type setting_tier as enum (
  'content',            -- freely editable by staff
  'operational',        -- owner/manager, validated, real consequences
  'brand',              -- bounded enums only, never free-form
  'structural',         -- developer-only; present here for completeness, not writable at runtime
  'compliance_locked'   -- audited action with justification, or not at all
);

create table app_setting (
  key             text        primary key,
  value           jsonb       not null,
  tier            setting_tier not null,
  -- True when the build chose this value because no answer existed. Drives the owner-facing panel.
  is_provisional  boolean     not null default false,
  provisional_note text,
  open_question_id text,
  updated_at      timestamptz not null default now(),
  updated_by      text        not null default 'system'
);

comment on column app_setting.is_provisional is
  'The value is an assumption, not a decision. Listed in the Unconfirmed Assumptions panel with its '
  'open_question_id so the owner can confirm or correct it in one place.';

create index app_setting_provisional_idx on app_setting (key) where is_provisional;
create index app_setting_tier_idx on app_setting (tier);

-- Append-only. A settings change is an audited fact; the audit_event row records WHO, this records WHAT.
create table app_setting_history (
  id           bigint      generated always as identity primary key,
  key          text        not null,
  old_value    jsonb,
  new_value    jsonb       not null,
  tier         setting_tier not null,
  changed_at   timestamptz not null default now(),
  changed_by   text        not null,
  justification text
);

create rule app_setting_history_no_update as on update to app_setting_history do instead nothing;
create rule app_setting_history_no_delete as on delete to app_setting_history do instead nothing;

create index app_setting_history_key_idx on app_setting_history (key, changed_at desc);

-- Records every change automatically, so no write path can forget to.
create or replace function record_setting_history()
returns trigger
language plpgsql
as $$
begin
  insert into app_setting_history (key, old_value, new_value, tier, changed_by)
  values (new.key,
          case when tg_op = 'UPDATE' then old.value else null end,
          new.value,
          new.tier,
          new.updated_by);
  return new;
end $$;

create trigger app_setting_history_trg
  after insert or update of value on app_setting
  for each row execute function record_setting_history();
