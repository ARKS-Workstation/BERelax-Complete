-- 0005 — the audit trail.
--
-- Append-only and partitioned by month. Partitioning is not premature here: this table records
-- every mutation plus every READ of clinical and salary data, so it grows faster than any business
-- table, and a 90-day retention on raw analytics has no equivalent here — audit rows are kept.
-- Monthly partitions make retention and archival a DETACH rather than a mass DELETE.
--
-- Insider access is the realistic breach for this business (docs/06 §D4), so reads are logged, and
-- exports are logged and alerted.

create table audit_event (
  id            uuid        not null default uuid_generate_v7(),
  occurred_at   timestamptz not null default now(),
  actor_kind    text        not null check (actor_kind in ('staff','customer','system','agent')),
  actor_id      uuid,
  actor_label   text,
  action        text        not null,          -- e.g. 'booking.reschedule', 'clinical_note.read'
  entity_type   text        not null,
  entity_id     text,
  -- Reads are as important as writes for clinical and salary data.
  operation     text        not null check (operation in ('create','update','delete','read','export','login','logout','denied')),
  before_state  jsonb,
  after_state   jsonb,
  request_id    text,
  ip_address    inet,
  user_agent    text,
  primary key (id, occurred_at)
) partition by range (occurred_at);

comment on table audit_event is
  'Append-only. No UPDATE or DELETE is permitted (enforced by a rule below). Partitioned monthly so '
  'retention is a DETACH, not a mass delete.';

create index audit_event_entity_idx  on audit_event (entity_type, entity_id, occurred_at desc);
create index audit_event_actor_idx   on audit_event (actor_id, occurred_at desc);
create index audit_event_action_idx  on audit_event (action, occurred_at desc);
-- Exports are the insider-threat signal; make them cheap to find.
create index audit_event_export_idx  on audit_event (occurred_at desc) where operation = 'export';

-- Append-only, enforced by the database rather than by discipline.
create rule audit_event_no_update as on update to audit_event do instead nothing;
create rule audit_event_no_delete as on delete to audit_event do instead nothing;

/**
 * Creates the partition for a given month, plus `ahead` future months, idempotently.
 * Run by a scheduled job; also called by the migration so today works immediately.
 */
create or replace function ensure_audit_partitions(from_month date default date_trunc('month', now())::date,
                                                   ahead integer default 3)
returns integer
language plpgsql
as $$
declare
  i          integer;
  start_date date;
  end_date   date;
  part_name  text;
  created    integer := 0;
begin
  for i in 0..ahead loop
    start_date := (date_trunc('month', from_month) + (i || ' months')::interval)::date;
    end_date   := (start_date + interval '1 month')::date;
    part_name  := format('audit_event_%s', to_char(start_date, 'YYYY_MM'));

    if not exists (select 1 from pg_class where relname = part_name) then
      execute format(
        'create table %I partition of audit_event for values from (%L) to (%L)',
        part_name, start_date, end_date
      );
      created := created + 1;
    end if;
  end loop;
  return created;
end $$;

comment on function ensure_audit_partitions(date, integer) is
  'Idempotent. Called by a pg-boss cron job. If it stops running, inserts fail loudly rather than '
  'landing in a default partition that nobody prunes — which is why there is deliberately no DEFAULT partition.';

select ensure_audit_partitions();
