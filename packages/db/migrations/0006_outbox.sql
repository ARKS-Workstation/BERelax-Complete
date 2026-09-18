-- 0006 — the transactional outbox.
--
-- A domain event is written in the SAME transaction as the state change that caused it, so a booking
-- cannot be confirmed without its confirmation event, and an event cannot exist for a booking that
-- rolled back. That property is why the queue lives in Postgres rather than Redis (docs/01 decision 4).

create table outbox_event (
  id             uuid        primary key default uuid_generate_v7(),
  occurred_at    timestamptz not null default now(),
  event_type     text        not null,           -- 'booking.confirmed'
  event_version  smallint    not null default 1, -- payload shape is versioned
  aggregate_type text        not null,
  aggregate_id   text        not null,
  payload        jsonb       not null,
  -- Deduplication key for effects that must happen once per (event, handler).
  idempotency_key text       not null,
  published_at   timestamptz,
  attempts       smallint    not null default 0,
  last_error     text,
  unique (idempotency_key)
);

comment on table outbox_event is
  'Written in the same transaction as the state change. A worker publishes and stamps published_at. '
  'At-least-once delivery, so every handler must be idempotent on idempotency_key.';

-- Partial index: the worker only ever scans unpublished rows, and this stays small even as the
-- table grows, because published rows drop out of the index.
create index outbox_event_unpublished_idx
  on outbox_event (occurred_at)
  where published_at is null;

create index outbox_event_aggregate_idx on outbox_event (aggregate_type, aggregate_id, occurred_at desc);
