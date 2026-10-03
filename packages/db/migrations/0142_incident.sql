-- 0142 — the incident register, and the breach-notification clock.
--
-- H-HARD-07. docs/04 §9 asks for an incident register under premises and inspections; docs/04 §8 asks
-- for a response to the PDPL and marks the whole regulation [UNVERIFIED], including — in so many words —
-- the breach notification threshold and deadline. This migration is the register and the clock, and the
-- three decisions that shape it are all about instants.
--
-- 1. **THE CLOCK STARTS AT DISCOVERY, NOT AT FILING.** A breach is noticed on a Friday evening and
--    written down on Monday morning. If the deadline came from the filing, the statutory clock would
--    restart every time somebody got round to the paperwork, and the later the record the more time the
--    business would appear to have. So `discovered_at` is a column a filer supplies and `filed_at` is
--    `now()`, they are separate, and `incident_filed_after_discovery` requires the second to be at or
--    after the first. The gap is then a visible fact instead of an erased one.
--
-- 2. **A FILED INCIDENT IS IMMUTABLE AND AN ADDENDUM IS THE ONLY WAY TO ADD TO IT.** The obvious design
--    is an editable row, because almost everything about an incident is learned afterwards. It fails in
--    the one situation the register exists for: an insurer or a regulator asks what was known WHEN, and
--    an edited row cannot answer — it reads identically whether the figure was known at filing or
--    written in last week. ZY521 refuses UPDATE and DELETE, ZY522 does the same for an addendum, ZY523
--    for a notification, and `incident_addendum.corrects_field` is how a correction names what it
--    corrects.
--
-- 3. **A BREACH FILING GENERATES ITS DUTIES, AND THE DATABASE REQUIRES THEM.** The compliance calendar
--    (0052) already holds dated duties, reminds about them, escalates them and shows them overdue. So
--    the breach clock is two `obligation` definitions plus `obligation_instance` rows dated from the
--    discovery — not a second calendar. ZY524 is a DEFERRED constraint trigger: at COMMIT, a
--    `personal_data_breach` row with no instance linked to it is refused, so "filing a breach creates
--    the duties" is a property of the schema rather than of whichever writer remembered.
--
-- **Nothing here names an authority, a contact or a statutory period.** `obligation.authority` is NULL
-- for both definitions, which is the column's own stated purpose — naming a plausible one reads as
-- configured (brief rule 15) — and both carry `is_unverified` with an open question. The PERIOD is the
-- `provisional` F09 setting `pdpl.breach_notification_hours`, so it appears on the Unconfirmed
-- Assumptions panel and is corrected by one audited settings change.
--
-- **And the THRESHOLD is deliberately not decided anywhere.** Whether a given breach is notifiable at
-- all is a judgement about risk to the people affected. Every breach filing therefore generates the
-- duty, and closing it is an act with a recorded reason — including "assessed as not notifiable".
-- A build that applied a threshold of its own would be deciding not to notify, silently, and the
-- evidence would be an absence.

-- ---------------------------------------------------------------------------------------------
-- The vocabularies
-- ---------------------------------------------------------------------------------------------
create type incident_class as enum (
  'personal_data_breach', -- docs/04 §8. The one with a clock attached.
  'client_injury',        -- docs/04 §9, and the one an insurer asks about first.
  'staff_injury',         -- docs/04 §7 and §9.
  'hygiene_failure',      -- docs/04 §9: inspection records, sanitation, linen, water safety.
  'equipment_failure',
  'security_event'
);

comment on type incident_class is
  'What kind of event this is, and it decides which duties the filing generates. A closed set for '
  'obligation_class''s reason: a class spelled two ways is a rule that silently applies to nothing. '
  'personal_data_breach is the class ZY524 requires notification instances for.';

create type incident_notified_party as enum (
  'data_subjects',
  'supervisory_authority',
  'insurer',
  'police',
  'municipality',
  'health_authority'
);

comment on type incident_notified_party is
  'The CATEGORY of recipient, never a named body. Which authority supervises this business is a '
  'configured value the rights engine already withholds a response rather than invent (ADR 0034), and '
  'Y1-entity is the open question. This build has also never seen an insurance policy.';

-- A CHECK may not contain a subquery — PostgreSQL refuses one outright — and the first two versions of
-- `incident_personal_data_categories_nonempty` each did, once as `not exists (select ...)` and once as
-- `'' = any (array(select ...))`, which is the same thing wearing an array constructor. Both were
-- refused at apply time rather than silently, which is the right failure; the way to express the rule
-- is an IMMUTABLE function, exactly as `is_placeholder_text()` already is for the same reason.
create or replace function text_array_has_blank(items text[])
returns boolean
language sql
immutable
parallel safe
as $$
  select coalesce(bool_or(btrim(item) = ''), false) from unnest(items) as item
$$;

comment on function text_array_has_blank(text[]) is
  'True when any element of the array is empty or whitespace. IMMUTABLE so it may be used in a CHECK, '
  'which a subquery may not be. Trims before comparing, so a single space fails too.';

-- ---------------------------------------------------------------------------------------------
-- incident — the filed event
-- ---------------------------------------------------------------------------------------------
create table incident (
  id                    uuid                    primary key default uuid_generate_v7(),

  -- The business's own handle, which is what an insurer and an inspector quote back. A shape and not a
  -- generated format: this build has never seen how the business numbers its incidents, and inventing
  -- `INC-2026-0001` would be a convention nobody chose appearing on correspondence.
  reference             text                    not null unique
                          constraint incident_reference_shape
                          check (reference ~ '^[A-Z0-9][A-Z0-9/_-]{2,31}$'),

  incident_class        incident_class          not null,

  -- The two instants. See decision 1 in the header.
  occurred_at           timestamptz,
  -- GENERATED, so there is no writer and no way to hold a flag that disagrees with the column. A filer
  -- who does not know when it happened leaves `occurred_at` null, and this says so without a second
  -- statement of the same fact.
  occurrence_known      boolean                 not null
                          generated always as (occurred_at is not null) stored,
  discovered_at         timestamptz             not null,
  filed_at              timestamptz             not null default now(),

  -- Who recorded it. Text with a CHECK restating the F07 vocabulary, exactly as `obligation.owner_role`
  -- does and for the same reason: the database cannot import the policy layer, and the duplication is
  -- made safe by a test that parses this constraint out of pg_constraint and holds its accepted set
  -- equal to ROLES in both directions.
  recorded_by_role      text                    not null
                          constraint incident_recorded_by_role_known
                          check (recorded_by_role in
                            ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer',
                             'auditor', 'system')),
  recorded_by_label     text                    not null
                          constraint incident_recorded_by_label_real
                          check (btrim(recorded_by_label) <> '' and not is_placeholder_text(recorded_by_label)),

  -- What happened. Three fields both readers ask for, and `is_placeholder_text` on each: a register
  -- whose entries say "TBD" is a register that will be read once, at the worst possible moment.
  summary               text                    not null
                          constraint incident_summary_real
                          check (btrim(summary) <> '' and not is_placeholder_text(summary)),
  location              text                    not null
                          constraint incident_location_real
                          check (btrim(location) <> '' and not is_placeholder_text(location)),
  immediate_action      text                    not null
                          constraint incident_immediate_action_real
                          check (btrim(immediate_action) <> '' and not is_placeholder_text(immediate_action)),
  -- Proposed and not yet done. Nullable, because "nothing further is proposed" is a legitimate answer
  -- and an empty string pretending to be one is not.
  measures_proposed     text
                          constraint incident_measures_proposed_real
                          check (measures_proposed is null
                                 or (btrim(measures_proposed) <> '' and not is_placeholder_text(measures_proposed))),

  people_affected_count integer                 not null
                          constraint incident_people_affected_nonneg
                          check (people_affected_count >= 0),
  injury_reported       boolean                 not null,
  emergency_services_attended boolean           not null,
  claim_anticipated     boolean                 not null,
  -- Fils (ADR 0007), and NULLABLE rather than defaulted to zero: an unknown loss left blank is visibly
  -- unanswered, and zero is a claim an insurer would read as one.
  estimated_loss_fils   bigint
                          constraint incident_estimated_loss_nonneg
                          check (estimated_loss_fils is null or estimated_loss_fils >= 0),

  -- The breach-only fields. Required exactly when the class is a breach: see
  -- `incident_breach_fields_match_class` below.
  personal_data_categories text[],
  data_subjects_affected_estimate integer
                          constraint incident_subjects_estimate_nonneg
                          check (data_subjects_affected_estimate is null
                                 or data_subjects_affected_estimate >= 0),
  records_affected_estimate integer
                          constraint incident_records_estimate_nonneg
                          check (records_affected_estimate is null or records_affected_estimate >= 0),
  likely_consequences   text
                          constraint incident_likely_consequences_real
                          check (likely_consequences is null
                                 or (btrim(likely_consequences) <> ''
                                     and not is_placeholder_text(likely_consequences))),
  cross_border_transfer boolean,

  -- GENERATED, and it exists so the CHECK below is readable rather than a five-term conjunction
  -- repeated twice. Every breach field present, or every one absent.
  breach_fields_present boolean                 not null
                          generated always as (
                            personal_data_categories is not null
                            and data_subjects_affected_estimate is not null
                            and records_affected_estimate is not null
                            and likely_consequences is not null
                            and cross_border_transfer is not null
                          ) stored,

  created_at            timestamptz             not null default now(),

  -- Decision 1, as a constraint. A filing before the discovery it records is not a late filing; it is a
  -- clock that ran backwards, and the deadline derived from it would be wrong in the business's favour.
  constraint incident_filed_after_discovery
    check (filed_at >= discovered_at),
  -- And an event cannot be discovered before it happened.
  constraint incident_discovered_after_occurrence
    check (occurred_at is null or occurred_at <= discovered_at),

  -- The breach fields are required for a breach and refused for anything else. Refused, not merely
  -- optional: "approximately how many data subjects" on an equipment failure is a field somebody fills
  -- in with a number that means nothing, and the regulator's field list is what gives those columns
  -- their meaning.
  constraint incident_breach_fields_match_class
    check ((incident_class = 'personal_data_breach') = breach_fields_present),
  -- A category list that is empty is not a list. One category is the floor, and "we do not yet know
  -- which" belongs in an addendum rather than in an empty array.
  --
  -- The blank-element half goes through `text_array_has_blank`, defined above: a CHECK may not contain a
  -- subquery, and both of the obvious spellings are one.
  --
  -- `coalesce(array_length(...), 0)` and not `array_length(...) >= 1`, which is what this constraint
  -- said first. `array_length` of an EMPTY array is NULL, not 0, so the comparison was NULL, the
  -- conjunction was NULL, and a CHECK evaluating to NULL PASSES — `array[]::text[]` went straight
  -- through. It was then caught at COMMIT by ZY524 instead, which named the wrong rule entirely, and
  -- that is how the hole was found: by a probe that expected 23514 and got ZY524.
  constraint incident_personal_data_categories_nonempty
    check (personal_data_categories is null
           or (coalesce(array_length(personal_data_categories, 1), 0) >= 1
               and not text_array_has_blank(personal_data_categories)))
);

comment on table incident is
  'The incident register (docs/04 §9) and the personal-data-breach record (docs/04 §8). Append-only: '
  'UPDATE and DELETE raise ZY521, and incident_addendum is the only way to add information to a filed '
  'incident. The clock is discovered_at, never filed_at.';
comment on column incident.discovered_at is
  'When the business became aware. THE CLOCK: every notification deadline derives from this instant. '
  'Computed in the civil zone and never the trading date — a statutory deadline does not move with the '
  'salon''s trading hours, so a breach discovered at 01:30 on the 4th is discovered on the 4th.';
comment on column incident.filed_at is
  'When the row was written. Separate from discovered_at on purpose: a deadline computed from the '
  'filing would restart the statutory clock every time somebody got round to the paperwork.';
comment on column incident.occurrence_known is
  'GENERATED from occurred_at. There is no writer, which is the point: a flag saying whether the '
  'occurrence instant is known, held separately from the instant, is one UPDATE away from disagreeing '
  'with it.';
comment on column incident.estimated_loss_fils is
  'The loss as the business estimates it, in fils. NULL where unknown and never 0 — an insurer reads a '
  'zero as a claim that nothing was lost.';

create index incident_class_discovered_idx on incident (incident_class, discovered_at desc);
create index incident_discovered_idx on incident (discovered_at desc);

-- ZY521. ADR 0008's shape, for decision 2's reason. The question a register is asked is what was known
-- WHEN, and an edited row reads identically whether a figure was known at filing or written in last
-- week.
create or replace function refuse_incident_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'IncidentImmutable: incident % (%) may not be % — a filed incident records what was known at the '
    'time it was filed, and the only way to add or correct information is an incident_addendum row, '
    'which carries its own instant and its own actor',
    old.reference, old.incident_class, lower(tg_op)
    using errcode = 'ZY521';
end $$;

comment on function refuse_incident_change() is
  'Raises ZY521 for both events. One function and two triggers, 0111''s reason: the half-written pair — '
  'one trigger copied for the other event with the word not changed — is where this defect always '
  'hides, and the table then documents a guarantee it half keeps.';

create trigger incident_no_update before update on incident
  for each row execute function refuse_incident_change();
create trigger incident_no_delete before delete on incident
  for each row execute function refuse_incident_change();

-- ---------------------------------------------------------------------------------------------
-- incident_addendum — the only way to add to a filed incident
-- ---------------------------------------------------------------------------------------------
create table incident_addendum (
  id             uuid        primary key default uuid_generate_v7(),
  incident_id    uuid        not null references incident (id) on delete restrict,

  added_at       timestamptz not null,
  added_by_role  text        not null
                   constraint incident_addendum_role_known
                   check (added_by_role in
                     ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer',
                      'auditor', 'system')),
  added_by_label text        not null
                   constraint incident_addendum_label_real
                   check (btrim(added_by_label) <> '' and not is_placeholder_text(added_by_label)),
  body           text        not null
                   constraint incident_addendum_body_real
                   check (btrim(body) <> '' and not is_placeholder_text(body)),

  -- Which field this corrects, where it corrects one. A correction that does not say what it corrects
  -- is not a correction — somebody reading the register later has to diff two paragraphs of prose to
  -- find out. NULL for an addendum that only adds.
  corrects_field text
                   constraint incident_addendum_corrects_field_shape
                   check (corrects_field is null or corrects_field ~ '^[a-z][a-z0-9_]{2,63}$'),

  created_at     timestamptz not null default now()
);

comment on table incident_addendum is
  'What was learned after an incident was filed. Append-only: UPDATE and DELETE raise ZY522. This is '
  'the mechanism that lets incident itself be immutable — new information is a new row with its own '
  'instant and its own actor, and the original stays readable.';
comment on column incident_addendum.added_at is
  'When this was learned, supplied by the caller rather than defaulted to now(). An addendum dated when '
  'it was typed cannot distinguish a finding from something known at filing, which is the whole question '
  'the register is asked.';
comment on column incident_addendum.corrects_field is
  'The incident column this corrects, or NULL. Shape-checked rather than a foreign key into the '
  'catalogue, because a column name is not a row; the completeness test in '
  'packages/fixtures/src/incident.itest.ts is what holds it to a real column.';

create index incident_addendum_incident_idx on incident_addendum (incident_id, added_at);

-- ZY522. Same argument as ZY521 one level down: an addendum that can be rewritten is a record of what
-- somebody currently says they learned, which is not evidence of anything.
create or replace function refuse_incident_addendum_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'IncidentAddendumImmutable: addendum % on incident % may not be % — an addendum is the correction '
    'mechanism, so a correction to a correction is another addendum',
    old.id, old.incident_id, lower(tg_op)
    using errcode = 'ZY522';
end $$;

create trigger incident_addendum_no_update before update on incident_addendum
  for each row execute function refuse_incident_addendum_change();
create trigger incident_addendum_no_delete before delete on incident_addendum
  for each row execute function refuse_incident_addendum_change();

-- ---------------------------------------------------------------------------------------------
-- incident_notification — what was notified
-- ---------------------------------------------------------------------------------------------
create table incident_notification (
  id                uuid                    primary key default uuid_generate_v7(),
  incident_id       uuid                    not null references incident (id) on delete restrict,

  party             incident_notified_party not null,
  notified_at       timestamptz             not null,
  notified_by_role  text                    not null
                      constraint incident_notification_role_known
                      check (notified_by_role in
                        ('owner', 'manager', 'accountant', 'receptionist', 'therapist', 'marketer',
                         'auditor', 'system')),
  notified_by_label text                    not null
                      constraint incident_notification_label_real
                      check (btrim(notified_by_label) <> ''
                             and not is_placeholder_text(notified_by_label)),

  -- How, in the filer's words. Free text rather than an enum, deliberately: this build has no
  -- notification integration at all, so a closed list would be a list of channels nobody has used — and
  -- the honest record is what the person says they did.
  channel           text                    not null
                      constraint incident_notification_channel_real
                      check (btrim(channel) <> '' and not is_placeholder_text(channel)),
  -- What they were told. Both readers ask what was disclosed, and a notification row with no content is
  -- a tick in a box.
  content_summary   text                    not null
                      constraint incident_notification_content_real
                      check (btrim(content_summary) <> ''
                             and not is_placeholder_text(content_summary)),

  created_at        timestamptz             not null default now()
);

comment on table incident_notification is
  'Who was told, when, by whom, through what, and what they were told. Append-only: UPDATE and DELETE '
  'raise ZY523. The party is a CATEGORY and never a named body — which authority supervises this '
  'business is a configured value (Y1-entity).';
comment on column incident_notification.notified_at is
  'When they were told. Compared against the DEADLINE INSTANT and not against the due date: a '
  'notification at 23:00 on the due date is inside a 72-hour period that expired at 09:00 that morning '
  'only if the comparison is done on dates, and that is the answer a regulator would not accept.';

create index incident_notification_incident_idx
  on incident_notification (incident_id, notified_at);
create index incident_notification_party_idx on incident_notification (party, notified_at desc);

-- ZY523.
create or replace function refuse_incident_notification_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'IncidentNotificationImmutable: the notification of % for incident % may not be % — when somebody '
    'was told is the fact the whole clock exists to establish, and a rewritable instant establishes '
    'nothing',
    old.party, old.incident_id, lower(tg_op)
    using errcode = 'ZY523';
end $$;

create trigger incident_notification_no_update before update on incident_notification
  for each row execute function refuse_incident_notification_change();
create trigger incident_notification_no_delete before delete on incident_notification
  for each row execute function refuse_incident_notification_change();

-- A notification cannot predate the discovery it answers. A BEFORE trigger rather than a CHECK,
-- because the claim is about two tables: a row claiming the authority was told before anybody knew is
-- either a typo or a backdated record, and the second is the thing an immutable register exists to
-- prevent. ZY525.
create or replace function assert_notification_follows_discovery()
returns trigger
language plpgsql
as $$
declare
  discovered timestamptz;
  ref        text;
begin
  select i.discovered_at, i.reference into discovered, ref
    from incident i where i.id = new.incident_id;
  if new.notified_at < discovered then
    raise exception
      'NotificationBeforeDiscovery: incident % was discovered at % and this notification of % claims %, '
      'which is before anybody knew. The clock starts at the discovery, so a notification that predates '
      'it is either a mistyped instant or a backdated record',
      ref, discovered, new.party, new.notified_at
      using errcode = 'ZY525';
  end if;
  return new;
end $$;

create trigger incident_notification_follows_discovery
  before insert on incident_notification
  for each row execute function assert_notification_follows_discovery();

-- ---------------------------------------------------------------------------------------------
-- The compliance calendar link
-- ---------------------------------------------------------------------------------------------
-- `obligation_instance` gains the incident that generated it, and the uniqueness constraint gains it
-- too. Without the column, two breaches whose deadlines land on the same civil date would collide on
-- `obligation_instance_one_per_due_date` and the second filing would silently reuse the first's duty —
-- so completing one would mark both done. With it, an event-driven instance belongs to the event, which
-- is also what `obligation_cadence`'s comment already says event_driven means: the due date comes from
-- the event.
--
-- NULLS NOT DISTINCT is kept, so every existing generated instance (incident_id NULL) behaves exactly
-- as before and `generateObligationInstances`'s `on conflict on constraint` clause still names a
-- constraint that exists.
alter table obligation_instance
  add column incident_id uuid references incident (id) on delete restrict;

comment on column obligation_instance.incident_id is
  'The incident that generated this occurrence, for an event_driven obligation. NULL for every '
  'cadence-generated instance. It is part of obligation_instance_one_per_due_date because two breaches '
  'discovered close together have deadlines on the same civil date, and sharing one instance would mean '
  'completing one notification marked the other done.';

alter table obligation_instance
  drop constraint obligation_instance_one_per_due_date;
alter table obligation_instance
  add constraint obligation_instance_one_per_due_date
  unique nulls not distinct (obligation_id, subject_employee_id, incident_id, due_on);

create index obligation_instance_incident_idx
  on obligation_instance (incident_id) where incident_id is not null;

-- `obligation_class` gains `privacy`, because docs/04 section 8 is a section of its own and these two
-- duties are not licence renewals. Filing them under `licence` would put a breach notification in the
-- calendar beside the trade licence, which is where nobody would look for it — and the class is what
-- 0052's `obligation_blocking_effect_matches_class` reads, so a class chosen for convenience is a
-- blocking rule applying to the wrong family. `privacy` carries `none`, so the CHECK is satisfied
-- without widening what may block.
--
-- A separate statement before the inserts below, deliberately: PostgreSQL will not let a value added by
-- `alter type` be USED in the same transaction, and the migrations are applied statement by statement
-- (`psql -f`), so the insert that follows runs after this has committed. Writing them together is the
-- shape that fails, and it fails with "unsafe use of new value", which does not sound like this.
alter type obligation_class add value if not exists 'privacy';

comment on type obligation_class is
  'What kind of duty this is. The BLOCKING CONSEQUENCE is constrained against it: only a credential '
  'obligation may take a therapist out of availability, and only a licence obligation may block '
  'publishing. A third consequence is a migration, not a row. 0142 added privacy (docs/04 section 8), '
  'which carries no blocking consequence — blocking publishing on an overdue breach notification would '
  'be this build inventing one.';

-- The two duties a breach filing generates. Both are definitions in the calendar that already exists
-- (0052) rather than a second calendar: it reminds, escalates, shows overdue and refuses a completion
-- with no actor, and none of that would be rebuilt as well as it already works.
--
-- `authority` is NULL on both, which is the column's own stated purpose: the build has not been told
-- which body supervises this business, and naming a plausible one reads as configured. `is_unverified`
-- is true with an open question, so both appear on the open-compliance-questions dashboard that exists
-- for exactly this.
--
-- `anchor_on` is NULL and the cadence is `event_driven`, so the cadence generator produces nothing —
-- which is correct and is what its comment says: a due date for a breach that has not happened would be
-- a date in the calendar that nothing on file supports. Instances come from a filing.
--
-- `blocking_effect` is `none` on both. It is tempting to block publishing on an overdue breach
-- notification, and it would be this build inventing a consequence: 0052 ties each blocking effect to
-- the class that may carry it, docs/04 §9 names exactly the two, and a third is a migration with an
-- argument rather than a row.
insert into obligation (
  key, title, obligation_class, cadence, subject_scope, owner_role, blocking_effect,
  evidence_required, is_unverified, unverified_note, open_question_id, source_reference,
  authority, anchor_on
) values (
  'pdpl_breach_notification',
  'Notify the supervisory authority of a personal-data breach',
  'privacy',
  'event_driven',
  'business',
  'owner',
  'none',
  true,
  true,
  'The DEADLINE is the build''s reading of a secondary source and is held as the provisional setting '
    'pdpl.breach_notification_hours, not as a figure here. docs/04 section 8 marks Federal Decree-Law 45 '
    'of 2021 and its executive regulations UNVERIFIED and says in so many words to confirm the breach '
    'notification threshold and deadline. Which authority this is owed to is also not on file, which is '
    'why the authority column is null.',
  'Y1-breach-clock',
  'docs/04-uae-compliance.md section 8',
  null,
  null
), (
  'pdpl_breach_subject_notification',
  'Tell the people whose personal data was breached',
  'privacy',
  'event_driven',
  'business',
  'owner',
  'none',
  true,
  true,
  'A SEPARATE duty from the authority notification and on its own deadline, because the two are decided '
    'by different things: the authority is told about the breach, and the people affected are told when '
    'the breach is likely to harm them. Whether this duty is owed at all for a given breach is the '
    'threshold question the build does not answer (Y1-breach-threshold), so the instance is always '
    'created and closing it is an act with a recorded reason.',
  'Y1-breach-threshold',
  'docs/04-uae-compliance.md section 8',
  null,
  null
);

-- ZY524. The property acceptance line 2 asks for, as a schema rule rather than as a writer's diligence.
--
-- A DEFERRED constraint trigger, which is the whole mechanism: the instances cannot exist before the
-- incident row they reference, so an IMMEDIATE check would refuse every correct filing. Deferred to
-- COMMIT, it refuses a transaction that filed a breach and did not date its duties — including one that
-- took a path nobody has written yet.
create or replace function assert_breach_has_notification_duties()
returns trigger
language plpgsql
as $$
declare
  dated integer;
begin
  if new.incident_class <> 'personal_data_breach' then
    return null;
  end if;
  select count(*) into dated
    from obligation_instance oi
    join obligation o on o.id = oi.obligation_id
   where oi.incident_id = new.id
     and o.key in ('pdpl_breach_notification', 'pdpl_breach_subject_notification');
  if dated < 2 then
    raise exception
      'BreachDutiesNotDated: incident % is a personal_data_breach and this transaction dated % of its 2 '
      'notification duties. The deadline derives from discovered_at (%), so a breach filed without its '
      'obligation_instance rows is a statutory clock that started and that nothing is counting',
      new.reference, dated, new.discovered_at
      using errcode = 'ZY524';
  end if;
  return null;
end $$;

comment on function assert_breach_has_notification_duties() is
  'Raises ZY524 at COMMIT. Deferred because the obligation_instance rows cannot exist before the '
  'incident they reference, so an immediate check would refuse every correct filing — and the point is '
  'to refuse a transaction that filed a breach and dated nothing, whatever path it took.';

create constraint trigger incident_breach_duties_dated
  after insert on incident
  deferrable initially deferred
  for each row execute function assert_breach_has_notification_duties();
