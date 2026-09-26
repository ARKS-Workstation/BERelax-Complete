-- 0075 — what the Google re-auth ladder has already told somebody, so it cannot tell them again and
-- cannot go on telling them for ever.
--
-- G-CONN-06 computed the notification DECISION (`notify: reauth_required | predictive_warning`) and said
-- outright that it sends nothing; G-CONN-08 sends it. Between the two sits the only durable fact the
-- sending needs: which rung of which incident has already gone out to whom. Without a row, "one owner
-- email and one manager email per incident" is a claim about the inside of one worker process, and a
-- worker restart makes it false.
--
-- ## Why this is a record of DECISIONS and not a queue of intentions
--
-- 0051 and 0060 plan their notices in advance as `pending` rows, because both are about a date that can
-- MOVE: an appointment is rescheduled, a licence deadline is corrected, and the row is what makes the
-- stale reminder refusable. A re-auth ladder has no such date. Its rungs are a pure function of the
-- instant the incident opened and a cap — `reauthLadderFor` in `@berelax/core` — so planning them into
-- rows would store a derivation that is already reproducible, and the first thing a moved cap would do is
-- make every stored row wrong.
--
-- So every row here is terminal on insert: the pass decided, and this is what it decided. There is no
-- `pending` state, no `settled_at` (the decision instant IS `decided_at`) and no supersede. What replaces
-- 0060's one-way-door trigger is stronger and simpler: every UPDATE raises, so the record of what an owner
-- was told is evidence rather than a mutable field.
--
-- DELETE is deliberately NOT refused, and that is why this table's comment does not claim to be
-- append-only: the foreign key cascades from `google_connections`, because a disconnected-and-deleted
-- connection's notice history is about a grant that no longer exists. `google_connection_events` is the
-- durable audit trail of the connection itself and is not touched here.
--
-- ## The escalation cannot run for ever, and that is a CHECK rather than a convention
--
-- `rung_index` is bounded by `MAX_GOOGLE_REAUTH_LADDER_STEPS` (8, in `@berelax/shared`) and `step` by the
-- hours the eighth rung can reach. The duplication of a TypeScript constant in SQL is deliberate, for
-- 0051's and 0060's reason: the database cannot import the module, and a row claiming rung 900 would be a
-- ladder nobody declared — which is precisely the failure "escalating" invites. The ladder is finite three
-- times over: the rungs are an enumerated union with a `Record` of specs (a new rung is a compile error),
-- `reauthLadderCap` refuses a cap outside 1..8 (an unbounded run is a thrown error), and this CHECK makes
-- the row unstorable.
--
-- ## Why the uniqueness is (connection, incident, step, role, channel) and total rather than partial
--
-- Because "fifty failed jobs inside one incident produce exactly one owner email and one manager email"
-- is the acceptance criterion, and the only version of it that survives a concurrent worker is a unique
-- index. `incident_key` is what makes "one incident" a fact rather than a window: a dead grant is keyed on
-- the `google_connection_events` row that recorded it, and an approaching Testing expiry on the expiry
-- INSTANT — which is what "does not re-fire for the same expiry instant" asks for, and which no event row
-- could supply, because nothing happens at the moment a deadline comes into view.
--
-- Total rather than partial on `outcome = 'sent'` (0060 makes the other choice) because a SKIP is also a
-- decision about that rung, and a skipped rung that retried on every pass would be a row the unique index
-- refuses and a pass that throws — the failure mode being avoided rather than a retry. A rung decided is
-- decided; the ladder goes on to the next one, and every skip carries a reason somebody can read.

begin;

-- ---------------------------------------------------------------------------------------------
-- The vocabularies
-- ---------------------------------------------------------------------------------------------
create type google_reauth_notice_kind as enum ('reactive', 'predictive');

comment on type google_reauth_notice_kind is
  'reactive is sent because the grant has STOPPED working; predictive because it is about to (a Testing '
  'expiry inside the 48-hour window, or nothing read successfully for 48 hours). Two kinds and not one '
  'because they report different facts, and a template that hedged between them is the subject line '
  'nobody opens.';

create type google_reauth_notice_outcome as enum ('sent', 'skipped');

comment on type google_reauth_notice_outcome is
  'There is no pending state: the pass decides and the row records the decision. A rung this table has no '
  'row for has not been decided, which is the only thing the dedupe read needs to know.';

-- ---------------------------------------------------------------------------------------------
-- google_reauth_notice
-- ---------------------------------------------------------------------------------------------
create table google_reauth_notice (
  id             uuid                         primary key default uuid_generate_v7(),

  -- CASCADE. The notice history is about a grant; when the grant's row goes, so does the record of what
  -- was said about it. What survives is `google_connection_events`, which is the connection's own audit
  -- trail and is append-only there.
  connection_id  uuid                         not null
                   references google_connections (id) on delete cascade,

  -- `reauth:<event id>`, `expiry:<iso instant>` or `stale:<iso instant>`. The pattern is
  -- REAUTH_INCIDENT_KEY_PATTERN in packages/core, restated because the database cannot import it and an
  -- unprefixed key would make two different causes look like one incident.
  incident_key   text                         not null,

  kind           google_reauth_notice_kind    not null,

  -- `reactive_0h`, `reactive_24h`, `predictive_0h`. The rung's durable label, and the thing "already
  -- decided" is keyed on — so it has to be derivable from the rung and from nothing else.
  step           text                         not null,

  -- 1-based position on the ladder. The column that makes "cannot escalate for ever" a refusal.
  rung_index     integer                      not null,

  -- The F07 role told. The full vocabulary is restated as `obligation_notice.to_role` restates it, and
  -- for the same reason: the database cannot import the policy layer. The ladder addresses two of them
  -- (REAUTH_NOTICE_ROLES), and a role nobody is accountable for would make the notice decoration.
  to_role        text                         not null
                   constraint google_reauth_notice_to_role_known
                   check (to_role in
                     ('owner', 'manager', 'accountant', 'receptionist', 'therapist',
                      'marketer', 'auditor', 'system')),

  -- email or sms. SMS is off by default (`google.reauth_sms_enabled`) and a run with it off records the
  -- row as skipped with `channel_disabled` rather than writing nothing — a switch whose state leaves no
  -- trace is a switch nobody can prove was off.
  channel        text                         not null
                   constraint google_reauth_notice_channel_known
                   check (channel in ('email', 'sms')),

  outcome        google_reauth_notice_outcome not null,

  -- The message the send produced, when one was produced. NULLABLE even for `sent`, deliberately: F03's
  -- guard diverts every send to the local outbox outside production and writes no `message` row (B-MSG-04
  -- records that a diverted message deliberately has none), and on a staging worker that is the ORDINARY
  -- outcome. RESTRICT because a sent message is the evidence somebody was told.
  message_id     uuid                         references message (id) on delete restrict,

  -- Why nothing was sent. A CLOSED set: REAUTH_SKIP_REASONS in packages/core is the same list, minus the
  -- three that are decided before a row exists (`connection_is_healthy`, `no_rung_is_due_yet`,
  -- `ladder_cap_reached` are reasons the pass wrote NOTHING, and a row for them would be a row per
  -- connection per pass for ever).
  skipped_reason text
                   constraint google_reauth_notice_skipped_reason_known
                   check (skipped_reason in (
                     -- No contact detail on file for the role. The honest shipped state: nothing in this
                     -- build holds a staff address, and a plausible one would be indistinguishable from a
                     -- configured one (brief rule 15).
                     'no_recipient_on_file',
                     -- No absolute origin configured, so the deep link would be a relative path in an
                     -- email. A notice whose one action is a dead link is worse than no notice.
                     'no_reconnect_link_configured',
                     'channel_disabled',
                     'already_notified_for_this_step',
                     'send_refused')),

  -- When the rung fell due, and when the pass decided about it. Both, because a rung decided three days
  -- late is the visible shape of a worker outage and the two instants are the only record of it.
  due_at         timestamptz                  not null,
  decided_at     timestamptz                  not null default now(),
  created_at     timestamptz                  not null default now(),

  -- The pattern and the bound, restated from `@berelax/core`. 168 is the eighth rung: the first is at 0
  -- hours, the second at 24, and every one after that a day later, so
  -- 24 * (MAX_GOOGLE_REAUTH_LADDER_STEPS - 1) is as far as any declared ladder reaches.
  constraint google_reauth_notice_step_is_a_declared_rung check (
    step ~ '^(reactive|predictive)_(0|[1-9][0-9]{0,3})h$'
    and (regexp_replace(step, '^(reactive|predictive)_([0-9]+)h$', '\2'))::integer between 0 and 168
  ),
  -- The label and the kind are one fact written twice, which is only safe if they cannot disagree: a row
  -- whose kind says predictive and whose step says `reactive_48h` would be counted one way by a report and
  -- worded the other way by the sender.
  constraint google_reauth_notice_step_matches_its_kind check (
    step like kind::text || '\_%'
  ),
  -- THE ceiling. A ladder is finite or it is a daily email for ever, which is the same thing a month later.
  constraint google_reauth_notice_rung_is_within_the_ladder check (
    rung_index between 1 and 8
  ),
  -- A predictive notice stands on ONE rung by construction (`REAUTH_LADDERS.predictive`), so a second one
  -- is a ladder that has grown a repeat nobody declared.
  constraint google_reauth_notice_predictive_has_one_rung check (
    kind <> 'predictive' or rung_index = 1
  ),
  constraint google_reauth_notice_incident_key_shaped check (
    incident_key ~ '^(reauth|expiry|stale):[\x21-\x7e]{1,180}$'
  ),
  -- Every skip names a reason, and nothing else does. The `=` is what stops a sent row carrying one.
  constraint google_reauth_notice_skip_carries_a_reason check (
    (outcome = 'skipped') = (skipped_reason is not null)
  ),
  -- A skipped rung produced no message. The converse is NOT asserted — see `message_id`.
  constraint google_reauth_notice_skip_has_no_message check (
    outcome <> 'skipped' or message_id is null
  ),
  constraint google_reauth_notice_message_claimed_once unique (message_id)
);

comment on table google_reauth_notice is
  'One decision about one rung of one re-auth incident, for one role on one channel. Terminal on insert: '
  'every UPDATE raises, because this is the record of what an owner was told. The rows are what make '
  '"exactly one owner email and one manager email per incident" a constraint rather than a convention in '
  'the sender.';
comment on column google_reauth_notice.incident_key is
  'What makes "one incident" a fact rather than a time window. A dead grant is keyed on the '
  'google_connection_events row that recorded it; an approaching Testing expiry on the expiry instant '
  'itself, which is what "does not re-fire for the same expiry instant" requires and what no event row '
  'could supply.';
comment on column google_reauth_notice.rung_index is
  'The rung''s 1-based position, bounded by MAX_GOOGLE_REAUTH_LADDER_STEPS. The escalation is finite here '
  'as well as in the planner, because a cap that lives only in code is a cap one bad settings row removes.';

-- THE dedupe. Total rather than partial: a skip is a decision about the rung too, and a skipped rung that
-- retried every pass would be an insert this index refuses and a pass that throws.
create unique index google_reauth_notice_one_per_rung_role_channel
  on google_reauth_notice (connection_id, incident_key, step, to_role, channel);

-- The read the pass makes: every step already decided for this incident.
create index google_reauth_notice_by_incident_idx
  on google_reauth_notice (connection_id, incident_key, decided_at desc);

-- ---------------------------------------------------------------------------------------------
-- Terminal on insert
-- ---------------------------------------------------------------------------------------------
create or replace function refuse_google_reauth_notice_rewrite() returns trigger as $$
begin
  raise exception
    'google_reauth_notice row % records a notice decision that was already made and cannot be edited '
    '(step %, role %, channel %). Record a new decision on the next rung instead: rewriting this one '
    'would make the history of what an owner was told depend on which writer ran last.',
    old.id, old.step, old.to_role, old.channel
    using errcode = 'restrict_violation';
end;
$$ language plpgsql;

create trigger google_reauth_notice_is_terminal
  before update on google_reauth_notice
  for each row execute function refuse_google_reauth_notice_rewrite();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 granted the application role select, insert, update and delete on every table in public AND set
-- default privileges extending that to tables created later, so this table arrives with UPDATE and DELETE
-- already granted. The trigger above refuses an UPDATE from every role, the owner included, which is the
-- stronger half; these statements are the half a later migration cannot drop by accident, which is the
-- precedent M-VAT-06 set for `period_lock` and 0072 set for `credit_note` — a door held by the grant, not
-- only by a trigger somebody might rewrite.
grant select, insert on google_reauth_notice to berelax_app;
revoke update, delete on google_reauth_notice from berelax_app;

-- DELETE is revoked and the cascade from `google_connections` still works: a referential action is
-- performed internally and does not check the deleting role's privilege on the referencing table. So the
-- one deletion this table allows is the one that means the grant itself is gone, and the application has no
-- statement that can forget what an owner was told.
--
-- TRUNCATE is the statement that fires no row-level trigger at all, so the refusal above would not see it —
-- and a truncated notice table is a ladder that sends every rung of every live incident again. 0009 never
-- granted it; stated explicitly because "it was never granted" and "we checked" are different facts.
revoke truncate on google_reauth_notice from berelax_app;

grant select on google_reauth_notice to berelax_readonly;

commit;
