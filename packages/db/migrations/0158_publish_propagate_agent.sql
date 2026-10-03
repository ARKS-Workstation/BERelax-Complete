-- 0158 — the publish-propagation agent, and the table its pings and purges are visible in.
--
-- W-SITE-08 closes the catalogue-to-frontend loop: publishing something in admin revalidates its pages,
-- pings IndexNow, purges the CDN and writes an audit row, all in one job run. Two things in this
-- migration, and both exist because of a question an operator asks afterwards.
--
-- ## The agent row: "did it run, and what went wrong?"
--
-- docs/09 §5's agent console lists every agent with its last run, last SUCCESS, next run and ERROR STATE,
-- and the rule it enforces is that **no agent ever stops quietly**. The propagation job is the one whose
-- silence is hardest to notice: a publish that revalidated the pages and failed to ping leaves a site
-- that looks entirely correct to everybody who can see it, and is simply not re-crawled. So the job
-- reports to an `agent_definition` like every other, and `agent_heartbeat.last_error` is where the
-- acceptance criterion's *"a provider rejection surfaces as last_error in the agent console"* lands.
--
-- It has NO cron, which is deliberate and is the one unusual thing here. Every other agent in this
-- registry is scheduled; this one is triggered by a publish, because propagating a change nobody made is
-- a job that reads the same rows and sends nothing. `expected_interval_seconds` is therefore not a
-- schedule but a WATCHDOG bound — see the column's own comment below for why the figure is what it is.
--
-- ## `publish_propagation`: "was the ping sent, and to what?"
--
-- The fakes hold their outbox in memory, which is right for a fake and useless for an operator: a process
-- restart is the end of the record. The acceptance criterion asks for an outbox that is VISIBLE, and
-- visible means a row somebody can select. So each propagation run writes one row carrying the changed
-- URL set, the idempotency key derived from it, and the outcome of each of the two outbound calls.
--
-- It is NOT append-only. A run is a single row updated once as it completes, because the question asked
-- of it is "what is the state of this propagation" rather than "what happened in order" — and the
-- ordering question is already answered by `audit_event`, which IS append-only (0005) and which this job
-- writes to as its fifth artefact.
--
-- `idempotency_key` is UNIQUE per surface and key, and that is what makes the criterion's *"a retried
-- publish yields one ping per changed URL set"* a property of the DATABASE rather than of the fake's
-- memory: the second run's insert conflicts, the job reads the existing row, and nothing is sent again.
--
-- ZY791 is the one refusal here. ZY792 through ZY800 are released UNUSED and deliberately unregistered,
-- because `pnpm sqlstate` refuses an entry for a code no migration raises.

begin;

insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('publish_propagate', 'Publish propagation',
   'Runs once per publish: revalidates the pages the change touches, pings IndexNow with exactly the '
   'changed URLs, purges those paths at the CDN and writes an audit row. It is triggered by a publish '
   'rather than by a cron, because propagating a change nobody made reads the same rows and sends '
   'nothing. A rejection from either outbound call is recorded as last_error and does NOT fail the '
   'publish: a ping is a notification, not a precondition, and a publish rolled back because Bing was '
   'unreachable would be a worse failure than a page that is re-crawled a day late. It makes at most two '
   'outbound calls and neither is metered, so the budget is 0.',
   -- 604800 — a week. Not a schedule: this agent has no cron, so the watchdog's "no success within twice
   -- the declared interval" would otherwise alert on a quiet week in which nobody published anything,
   -- which is not an incident. A week is long enough that silence means the loop is broken rather than
   -- that the owner was on holiday, and short enough that a broken loop is noticed before a quarter's
   -- rankings are.
   604800, 0)
on conflict (agent_key) do nothing;

insert into agent_heartbeat (agent_key) values ('publish_propagate')
on conflict (agent_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- publish_propagation — the visible outbox
-- ---------------------------------------------------------------------------------------------
create table publish_propagation (
  id              uuid        primary key default uuid_generate_v7(),
  -- What was published: 'service', 'therapist', 'content', 'premises'. Text rather than an enum, because
  -- the set grows with every surface that becomes publishable and an enum would make each one a
  -- migration — while the CHECK below is what stops it being free-form.
  surface         text        not null,
  -- The row that changed, when there is one. NULL for a surface with no single row behind it (a theme
  -- change touches every page), which is why it is nullable rather than a sentinel.
  subject_id      text,
  -- The hash of the sorted, deduplicated changed URL set. The key both outbound calls deduplicate on.
  idempotency_key text        not null,
  -- The URLs, as submitted. Stored so an operator can answer "what did we tell Bing changed?" without
  -- re-deriving it from rows that have since changed again.
  changed_urls    text[]      not null,
  -- Each outbound call's outcome, as its port's vocabulary spells it: 'accepted', 'deduplicated',
  -- 'rejected', 'refused_no_key', 'not_attempted'.
  indexnow_outcome text       not null,
  indexnow_error   text,
  purge_outcome    text       not null,
  purge_error      text,
  -- The cache tags the change declared, from docs/09 §5's interconnection map. Stored because the
  -- criterion is "exactly its declared tags and no others", and a figure nobody recorded cannot be
  -- audited after the fact.
  cache_tags      text[]      not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint publish_propagation_surface_known
    check (surface in ('service', 'therapist', 'content', 'premises', 'theme', 'media', 'package')),
  constraint publish_propagation_outcomes_known
    check (indexnow_outcome in ('accepted', 'deduplicated', 'rejected', 'refused_no_key', 'not_attempted')
       and purge_outcome   in ('accepted', 'deduplicated', 'rejected', 'not_attempted')),
  -- A rejection with no reason is a rejection nobody can act on, and a success carrying an error message
  -- is a run whose state two columns disagree about.
  constraint publish_propagation_errors_explain_themselves
    check ((indexnow_outcome in ('rejected', 'refused_no_key')) = (indexnow_error is not null)
       and (purge_outcome = 'rejected') = (purge_error is not null)),
  -- A propagation that submitted nothing is a propagation that should not have run.
  constraint publish_propagation_changed_something
    check (cardinality(changed_urls) > 0)
);

comment on table publish_propagation is
  'One row per publish-propagation run: the changed URL set, the key both outbound calls deduplicate on, '
  'and each call''s outcome. The VISIBLE outbox W-SITE-08''s acceptance criterion asks for — the fakes '
  'hold theirs in memory, which a process restart ends. Not append-only: the question asked of a row is '
  '"what is the state of this propagation", and the ordering question is audit_event''s (0005).';
comment on column publish_propagation.idempotency_key is
  'sha256 of the sorted, deduplicated changed URL set, truncated. UNIQUE per surface: that index is what '
  'makes "a retried publish yields one ping per changed URL set" a property of this database rather than '
  'of a fake''s memory.';

-- The uniqueness that IS the idempotency. Per surface as well as per key, because the same URL set can
-- legitimately be republished by two different kinds of change — archiving a therapist and editing the
-- CMS page that linked them both touch `/therapists` — and collapsing those would lose one of them.
create unique index publish_propagation_once_per_set
  on publish_propagation (surface, idempotency_key);

create index publish_propagation_recent_idx on publish_propagation (created_at desc);

create trigger publish_propagation_updated_at before update on publish_propagation
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- ZY791 — a propagation may not claim to have pinged URLs it did not submit
-- ---------------------------------------------------------------------------------------------
create function assert_propagation_submitted_what_it_claims() returns trigger
language plpgsql
as $$
begin
  -- An accepted or deduplicated IndexNow outcome is a claim that this exact set was submitted. A row
  -- whose `changed_urls` were edited afterwards would make the outbox a record of what somebody wishes
  -- had been sent. The key is derived from the set, so the set is what the key has to agree with — and
  -- this trigger is the only place both are visible at once.
  if tg_op = 'UPDATE' and old.idempotency_key is distinct from new.idempotency_key
     and old.changed_urls = new.changed_urls then
    raise exception
      'propagation_key_does_not_match_its_urls: the idempotency key of % changed while its URL set did '
      'not. The key IS the set (a hash of it sorted and deduplicated), so a key that moved on its own '
      'makes this row a record of a submission nobody made.',
      new.id
      using errcode = 'ZY791';
  end if;
  if tg_op = 'UPDATE' and old.changed_urls <> new.changed_urls
     and old.indexnow_outcome in ('accepted', 'deduplicated') then
    raise exception
      'propagation_urls_changed_after_submission: % claims IndexNow accepted its URL set and the set '
      'has been rewritten. An outbox that can be edited after the fact answers "what did we send?" with '
      'what somebody wishes had been sent.',
      new.id
      using errcode = 'ZY791';
  end if;
  return new;
end $$;

comment on function assert_propagation_submitted_what_it_claims() is
  'Raises ZY791. The outbox is a record of what was sent, so neither half of (key, URL set) may move '
  'without the other, and neither may move at all once a submission has been accepted.';

create trigger publish_propagation_records_what_was_sent
  before update on publish_propagation
  for each row execute function assert_propagation_submitted_what_it_claims();

commit;
