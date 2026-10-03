-- 0155 — a birthday is a DAY AND A MONTH, and there is nowhere to put a year.
--
-- C-AUTO-11. The birthday journey needs to know when somebody's birthday is and must not be able to know
-- how old they are. Three decisions, and the first is the whole migration.
--
-- 1. **THERE IS NO BIRTH-YEAR COLUMN, AND THAT IS THE POINT.** A date of birth is personal data this
--    business has no use for: nothing in docs/03 or docs/06 asks for an age, no treatment in the
--    catalogue is age-restricted in a way the booking path checks, and a marketing journey that wished
--    somebody a happy birthday from a full date of birth would be holding a government-identifier-grade
--    field in order to send one SMS a year. So the day and the month are separate `smallint` columns and
--    the year has nowhere to live — which is a stronger claim than a policy, because a query cannot
--    derive an age from data that is not there. `customer_birthday.test.ts` asserts the absence against
--    `information_schema`, in the direction that fails when somebody adds one.
--
--    A `date` column holding, say, 1900-05-14 was the obvious alternative and it is worse in both
--    directions: the year is a lie that every reader has to know to ignore, and the moment one row holds
--    a real year the column is a date of birth with no way to tell the two apart.
--
-- 2. **DAY AND MONTH MOVE TOGETHER.** `customer_birthday_is_whole_or_absent` requires both or neither: a
--    month with no day is a birthday nobody can send on, and a day with no month is a journey that fires
--    twelve times a year. `customer_birthday_is_a_real_date` refuses 31 February and 30 February without
--    needing a year, because the only ambiguous day in the calendar is the 29th of February — which is a
--    real birthday, is permitted here, and is `Y9-birthday-leap`'s to answer: whether a leap-day birthday
--    is greeted on 28 February or 1 March in a common year is a business decision nobody has made, so the
--    ROW is accepted and the SENDING rule is the open question.
--
-- 3. **THE SWEEP IS AN AGENT.** The three stock journeys are entered by a daily pass rather than by an
--    event dispatcher, because nothing in this build consumes `outbox_event` into an enrolment and a
--    sweep is idempotent by construction: `enrolOnLiveVersion` answers `already_enrolled` for a contact
--    already running, so a pass delivered twice enrols nobody twice. 0031's convention — a definition
--    row and a heartbeat row, because `agentsWithHeartbeat` inner-joins the two and a definition with no
--    heartbeat is an agent the watchdog cannot see.
--
-- **No figure in this migration.** The win-back interval (90 days), the birthday send hour (10:00) and
-- the internal-rating threshold are all C-AUTO-11 provisional values and all three live in the F09
-- settings registry, where a provisional value can say that it is one and reach the Unconfirmed
-- Assumptions panel. A default here would be the same guess in a place that cannot carry the marker.

alter table customer
  add column birth_day smallint,
  add column birth_month smallint;

comment on column customer.birth_day is
  'Day of the month of this contact''s birthday, 1-31. NULL until somebody records one. There is '
  'deliberately no birth-year column anywhere in this schema: see 0155''s header. Never a date of birth.';

comment on column customer.birth_month is
  'Month of this contact''s birthday, 1-12. Moves with birth_day by constraint.';

alter table customer
  add constraint customer_birthday_is_whole_or_absent
    check ((birth_day is null) = (birth_month is null)),
  add constraint customer_birthday_is_a_real_date
    check (
      birth_day is null
      or (
        birth_month between 1 and 12
        and birth_day between 1
          and case birth_month
                when 2 then 29  -- 29 February is a real birthday. Y9-birthday-leap owns the send rule.
                when 4 then 30
                when 6 then 30
                when 9 then 30
                when 11 then 30
                else 31
              end
      )
    );

-- The index the birthday sweep reads: one pass per day asking "whose birthday is today", which is an
-- equality on both columns. Partial, because the overwhelming majority of rows have no birthday recorded
-- and an index over them would be an index of nulls.
create index customer_birthday_idx on customer (birth_month, birth_day)
  where birth_day is not null;

-- ---------------------------------------------------------------------------------------------
-- The sweep's agent (0031's convention)
-- ---------------------------------------------------------------------------------------------
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('stock_journey_triggers', 'Stock journey triggers',
   'Enters the three stock journeys once a day: review solicitation for every appointment that COMPLETED '
   'and was paid, win-back for every contact whose last completed visit is older than the configured '
   'interval measured on BUSINESS DAYS, and the birthday journey for every contact whose recorded day '
   'and month are today. It enrols and does not send: every message a journey reaches goes through the '
   'interpreter and the messaging choke point, so the budget is 0 (C-AUTO-11).',
   86400, 0)
on conflict (agent_key) do nothing;

-- Its heartbeat row, because `agentsWithHeartbeat` INNER JOINS the two: a definition with no heartbeat
-- row is an agent the watchdog cannot see at all. 0031's convention.
insert into agent_heartbeat (agent_key)
values ('stock_journey_triggers')
on conflict (agent_key) do nothing;
