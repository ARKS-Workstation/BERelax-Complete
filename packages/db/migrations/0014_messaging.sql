-- 0014 — the template model, channel-shaped from day one.
--
-- WhatsApp is not in scope now and is inevitable in this market: it is already the channel the
-- business actually books on. A table shaped like an SMS row — one body, one sender — has to be
-- rebuilt to hold per-channel variants, a category, an approval state and the 24-hour customer-care
-- window, and rebuilding it means touching every send path in the system. The cost today is a few
-- unused columns. See ADR 0016.

begin;

create type message_class as enum ('transactional', 'promotional');
create type message_channel as enum ('sms', 'email', 'whatsapp');
create type template_approval as enum ('draft', 'pending', 'approved', 'rejected');

-- The template. message_class lives HERE, not on the send call, so an automation cannot route
-- promotional content down a transactional path.
create table message_template (
  id             uuid              primary key default uuid_generate_v7(),
  template_key   text              not null,
  version        integer           not null default 1,
  message_class  message_class     not null,
  -- A short description of what the template is for, shown in the admin list.
  purpose        text              not null,
  is_current     boolean           not null default true,
  created_at     timestamptz       not null default now(),
  updated_at     timestamptz       not null default now(),
  unique (template_key, version)
);
comment on column message_template.message_class is
  'Immutable. Enforced by a trigger, not by convention: a class chosen per send puts the compliance '
  'decision at the least reviewed point in the system, inside a loop, at 9pm.';

-- Exactly one current version per key, enforced rather than assumed.
create unique index message_template_one_current on message_template (template_key)
  where is_current;

create trigger message_template_updated_at before update on message_template
  for each row execute function set_updated_at();

-- Changing the class of an existing template is refused. The privileged path is a NEW VERSION, which
-- also resets approval to pending — because a template whose class changed is a different template as
-- far as the regulator is concerned, and inheriting its approval would launder that.
create or replace function refuse_message_class_change() returns trigger
language plpgsql as $$
begin
  if new.message_class is distinct from old.message_class then
    raise exception 'message_class is immutable on a template (template_key=%, version=%). '
      'Create a new version instead; it starts at approval_state=pending.',
      old.template_key, old.version
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

create trigger message_template_class_immutable
  before update on message_template
  for each row execute function refuse_message_class_change();

-- One row per channel per locale. Adding WhatsApp is an INSERT, not a migration.
create table message_template_variant (
  id                    uuid               primary key default uuid_generate_v7(),
  template_id           uuid               not null references message_template(id) on delete cascade,
  channel               message_channel    not null,
  locale                text               not null check (locale in ('en','ar')),
  -- WhatsApp's own category taxonomy; null for channels that have none.
  category              text,
  approval_state        template_approval  not null default 'draft',
  -- WhatsApp allows free-form replies only within 24 hours of the customer's last message. A template
  -- that may be sent outside that window must be an approved template; one that may not, need not be.
  customer_care_window  boolean            not null default false,
  subject               text,
  body                  text               not null,
  -- The variables the body may use. A placeholder outside this list fails to render rather than
  -- emitting an empty string, which is how "Hi , your appointment on  is confirmed" gets sent.
  variables             text[]             not null default '{}',
  encoding              text,
  segments              smallint,
  cost_fils             fils,
  created_at            timestamptz        not null default now(),
  updated_at            timestamptz        not null default now(),
  unique (template_id, channel, locale),
  -- An email needs a subject; an SMS has nowhere to put one.
  check ((channel = 'email') = (subject is not null))
);

create trigger message_template_variant_updated_at before update on message_template_variant
  for each row execute function set_updated_at();

create index message_template_variant_channel_idx on message_template_variant (channel, approval_state);

commit;
