-- 0007 — per-handler delivery tracking for the outbox.
--
-- The outbox gives at-least-once delivery: a worker can crash after dispatching but before marking
-- the row published, and the next worker will dispatch again. "Exactly once per handler" is therefore
-- not a property of the queue — it is a property of this table.
--
-- The primary key is (event_id, handler), so a second delivery attempt for the same handler is a
-- primary-key conflict rather than a duplicate side effect. A handler that is added later starts from
-- nothing and receives events it has not yet seen, which is the behaviour you want when a new
-- consumer is deployed.

create table outbox_delivery (
  event_id     uuid        not null references outbox_event(id) on delete cascade,
  handler      text        not null,
  delivered_at timestamptz not null default now(),
  attempts     smallint    not null default 1,
  last_error   text,
  primary key (event_id, handler)
);

comment on table outbox_delivery is
  'One row per (event, handler) that has been delivered. The PK is what makes delivery '
  'exactly-once per handler on top of an at-least-once queue.';

create index outbox_delivery_handler_idx on outbox_delivery (handler, delivered_at desc);
