-- 0011 — business_day as a materialised table, and closures that are intervals.
--
-- Trading runs 11:00–02:00, so a trading date is not a calendar date and cannot be derived by
-- truncating a timestamp. Every report, rota, cash-up and commission calculation cuts on it, and a
-- SQL expression repeated in each of them is a rule that will eventually disagree with itself.
--
-- So the mapping is a TABLE. One row per trading date, carrying the instants it opens and closes.
-- A report joins to it; nothing recomputes it. The rows are generated over a rolling horizon by
-- `generate-business-days.ts`, idempotently, so re-running is safe and changing the hours regenerates
-- rather than migrates.

begin;

-- Reduced hours were modelled on premises_closure as an open_time/close_time pair, which conflates
-- two different exceptions: "we open later during Ramadan" and "we are shut on Tuesday afternoon".
-- The first is an hours override for a date range; the second is an interval subtracted from a day.
-- Mixing them means a maintenance closure has to be expressed as reduced hours, which cannot
-- represent a gap in the middle of a session at all.
alter table premises_closure drop column open_time;
alter table premises_closure drop column close_time;

-- A closure may cover whole dates, or a slice of one. Null times mean the whole day.
alter table premises_closure add column closed_from_time time;
alter table premises_closure add column closed_until_time time;
alter table premises_closure add constraint premises_closure_partial_day_pair
  check ((closed_from_time is null) = (closed_until_time is null));
comment on column premises_closure.closed_from_time is
  'Start of a partial-day closure, local time. Null with closed_until_time means the whole date.';

-- Dated hours overrides: Ramadan, a seasonal change, a one-off late opening. Data, not a migration.
create table premises_hours_override (
  id           uuid        primary key default uuid_generate_v7(),
  starts_on    date        not null,
  ends_on      date        not null,
  day_of_week  smallint    check (day_of_week between 0 and 6),  -- null = every day in the range
  open_time    time        not null,
  close_time   time        not null,
  reason       text        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (ends_on >= starts_on)
);
comment on table premises_hours_override is
  'Replaces premises_hours for a date range. A Ramadan row is data; without this it is a migration, '
  'which is not something to run under time pressure during Ramadan.';

create trigger premises_hours_override_updated_at before update on premises_hours_override
  for each row execute function set_updated_at();

create index premises_hours_override_range_idx on premises_hours_override (starts_on, ends_on);

-- One row per trading date.
create table business_day (
  trading_date  date        primary key,
  opens_at      timestamptz not null,
  closes_at     timestamptz not null,
  -- Generated, so no writer can disagree with the instants. 11:00–02:00 is exactly 54000 seconds.
  duration_seconds integer  not null generated always as
    (extract(epoch from (closes_at - opens_at))::integer) stored,
  -- True when the session runs past midnight, which is the normal case here.
  crosses_midnight boolean  not null generated always as
    ((closes_at at time zone 'Asia/Dubai')::date > trading_date) stored,
  source        text        not null check (source in ('weekly','override')),
  generated_at  timestamptz not null default now(),
  -- A trading date that closes before it opens is not a date with unusual hours; it is a bug that
  -- would make every duration negative and every report silently wrong.
  constraint business_day_closes_after_opens check (closes_at > opens_at),
  -- Nothing trades for more than a day. Catches a timezone slip that adds 24 hours.
  constraint business_day_plausible_length check (closes_at - opens_at <= interval '24 hours')
);
comment on table business_day is
  'The trading calendar, materialised. Reports join to this rather than deriving a trading date from '
  'a timestamp, so the 11:00-02:00 rule lives in one place.';

create index business_day_opens_at_idx on business_day (opens_at);

-- Closed dates are absent from business_day rather than present with a flag: a report that forgets a
-- `where is_open` predicate would count a closed day as a zero-takings trading day, which is a
-- different and worse claim than "we were shut".

commit;
