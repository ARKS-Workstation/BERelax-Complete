-- 0125 — analytics consent: the record, the session's four signals, and the dispatch the gate governs.
--
-- A-MEAS-02. docs/04 §8 requires consent "timestamped, storing the exact wording version shown, in Arabic
-- and English, versioned and hashed". 0056 built that for MESSAGING consent, per contact, per channel and
-- per purpose. This migration builds the analytics half, and the shape differs in exactly one way that
-- matters, which is the whole of the header below.
--
-- ## The subject is a visitor, and this record deliberately does not name one
--
-- `consent.contact_customer_id` is a plain uuid naming a CRM identity. There is no analytics counterpart,
-- and not because one would be awkward: because there is nothing to name. ADR 0066 and A-FIRST-05 take the
-- stricter reading of `Y5-analytics-basis` while the lawful basis for the internal store is open —
-- `analytics.visitor` is created AT consent and never before it, by `ingestCollectBatch`, which is "the ONE
-- place the server decides who owns an identifier". At the instant the banner is answered there is no
-- visitor row yet, and minting one here would be a second identifier-minting site: two statements of who
-- owns an identifier, which is exactly the drift this unit exists to prevent.
--
-- A nullable `visitor_id` was the obvious alternative and is worse. It would be NULL for the common case
-- (a first grant), so the column would be mostly empty and therefore mostly useless, while costing a
-- foreign key into a table the retention pass purges every 90 days — and an append-only log with a
-- foreign key to a purged parent is the contradiction 0024 and 0056 both refuse: the parent's DELETE
-- either fails or rewrites history.
--
-- So: `analytics.consent_record` holds NO identifier of any kind, and what it is evidence of is that a
-- decision of a given SHAPE was made, under given WORDS, at a given INSTANT. Three readers need exactly
-- that and no more:
--
--   * the consented share of landings, which A-FIRST-10 publishes as a data-quality figure, and which
--     A-FIRST-05's own comment hands to this unit — "A-MEAS-02's record is where a deliberate denial is
--     distinguishable from a banner nobody answered";
--   * which wording version was in force while decisions were being made;
--   * that a withdrawal happened at all, which the dispatch rows then show the consequence of.
--
-- The limitation is stated rather than implied: nothing here says WHICH visitor made which decision, so
-- this table cannot answer "show me my consent record". That is the price of withholding the identifier,
-- it is the same price `analytics.pre_consent_landing` pays, and the operative state — the thing the gate
-- actually reads — is on the session instead.
--
-- ## The operative state is four columns on the session, and it defaults to DENIED
--
-- A dispatch is enqueued by a booking or a payment, server-side, where there is no cookie to read. So the
-- state a dispatch is gated on has to be stored, and the row it belongs on is the session: one row per
-- session, four booleans, written by the ingest from the consent cookie the request carried.
--
-- Every one of them is `not null default false`, and the default is the single most important value in
-- this file. A gate that defaults to granted is a gate that opens by accident: a fixture that forgets the
-- columns, a migration replayed against a database with rows, a writer that is wired up next quarter —
-- each of them would silently permit an outbound push for a visitor who never answered. With a default of
-- false the same omission suppresses everything instead, and a suppression is a ROW
-- (`state = 'suppressed'`, `reason = 'consent_denied'`), so the failure is visible in the one place
-- somebody would look.
--
-- There is deliberately NO check that `consent_analytics_storage` is true. A session only exists because
-- the ingest saw that signal, so the check would hold today — and it would turn every pre-existing fixture
-- row into a refused one while buying nothing, since the fail-closed direction is already safe.
--
-- ## The gate is in the database as well as in the code, and that is the acceptance line
--
-- "An arch test asserts no setting key, feature flag or env var can disable the gate — it is code, not
-- configuration." `packages/core/src/analytics/consent-gate.ts` is the code and
-- `packages/fixtures/src/consent-gate-arch.test.ts` is that test. This file is the other half: a dispatch
-- row cannot REACH `queued` or `sent` for a session that lacks the destination's required signals, for any
-- role including the owner, raising ZY312. A worker with a bug, a psql session, a future call site that
-- never heard of the gate: all refused. That is what makes "no call site can bypass it" a fact rather than
-- a convention.
--
-- The requirement itself is a TABLE — `analytics_dispatch_destination`, four booleans per destination,
-- named to match the session's four columns one for one. Two reasons. A `case` over signal names inside
-- the trigger would be a second vocabulary with a NULL hole in it (a `case` with no `else` yields NULL for
-- an unlisted name, `not null` is NULL, and a trigger whose condition is NULL lets the row through — the
-- fail-open an added signal would reach). And a table can be held equal to `CONSENT_GATED_TARGETS` by a
-- test, which is what `analytics-consent.itest.ts` does in both directions; a `case` cannot be read back.
--
-- `analytics_dispatch_destination_requires_something` is the fail-closed guard on the table itself: a
-- destination requiring NO signal would be ungated, and the natural way to add a destination is to copy a
-- row and clear the flags.
--
-- ## Why the dispatch queue is in `public` and the record is in `analytics`
--
-- `analytics.consent_record` is measurement's own subject and holds no identifier, so it takes a
-- `retention_policy` row saying `keep_indefinitely` with the reason — 0096 raises ZY062 for a base table
-- in that schema with no row, which is what stops a new table being retained for ever by omission.
--
-- `analytics_dispatch` is a QUEUE — A-MEAS-03's title names it `analytics_dispatch` — and it lives in
-- `public` beside `outbox_event`, which it behaves like. Its rows leave with the session they are about,
-- by `on delete cascade`, so the 90-day purge of a session takes its dispatch records with it and nothing
-- in `analytics.retention_policy` has to claim otherwise.
--
-- ## What this migration deliberately does NOT add
--
-- No `event_id` column, no payload, no attempt counter, no per-destination idempotency index. A-MEAS-01
-- refused to put the shared `event_id` in its payload allowlist for the same reason: a column with no
-- producer is indistinguishable from a column whose producer stopped working. A-MEAS-03 owns the consumer,
-- the retries and the deduplication, and adds them with the code that writes them.

begin;

-- ---------------------------------------------------------------------------------------------
-- The purpose, and version 1 of the words
-- ---------------------------------------------------------------------------------------------
-- A fifth `consent_purpose`, seeded here rather than in a seed script for 0056's own reason: the foreign
-- key means a database without this row cannot accept an analytics consent record at all, so it is part of
-- the schema's meaning rather than fixture data.
--
-- `is_send_gating` is FALSE, which is the same answer `clinical_processing` and `photography` get and for
-- the same reason: this is a lawful basis for MEASURING, not permission to message anybody, and a send
-- path that accepted it would pass every test it had.
insert into consent_purpose
  (purpose, display_order, description, is_send_gating, is_provisional, open_question_id,
   provisional_note)
values
  ('analytics_measurement', 5,
   'Measuring how the website is used, and sharing that measurement with advertising services. The '
   'purpose Consent Mode v2 signals are recorded against. Not a messaging permission: nothing may send '
   'on the strength of it.',
   false, true, 'Y9-consent-purpose',
   'Four purposes read off docs/04 SS8 by this build and this fifth one read off docs/03; no purpose '
   'taxonomy has been stated by the business. The lawful basis for the internal measurement store is '
   'open too (Y5-analytics-basis), and this build takes the stricter position and treats it as '
   'consent-gated, which is what makes this purpose exist at all.');

-- Version 1 of the banner's exact words, in both languages.
--
-- IN THE MIGRATION and not in the seed, unlike C-CRM-03's four drafts, and the difference is what each one
-- is for. Those are drafts of a statement a human reads off a form; this is the text a public page renders
-- to every visitor, and the record of a decision cannot be written without a wording row to reference. A
-- database with the schema and no seed would therefore refuse every consent a visitor gave.
--
-- The same bytes are also a committed constant, `ANALYTICS_CONSENT_WORDING` in `@berelax/shared`, because
-- `/` and `/ar` are statically prerendered and a build-time database read would either fail the build on a
-- machine with no database or bake whatever that machine happened to hold. So the words are written twice,
-- and the check that holds the two equal is STRUCTURAL rather than a test: `recordAnalyticsConsent`
-- resolves this row BY THE HASH of the constant's bytes, so a tree whose copy was edited without a new
-- version being published cannot find a wording row and every write is refused by name
-- (`wording_not_published`). `analytics-consent.itest.ts` asserts it in both directions as well.
--
-- `published_at` is `now()`: this version became the wording shown when this migration ran. `created_at`
-- beside it is when the row landed, and on a replayed migration they are the same instant, which is true.
insert into consent_wording
  (purpose, version, text_en, text_ar, published_at, is_provisional, open_question_id,
   provisional_note)
values
  ('analytics_measurement', 1,
   '[DRAFT WORDING — not approved copy] We measure how this site is used, and we can share that '
   'measurement with advertising services. Nothing is measured and nothing is shared until you '
   'choose. You can change your mind at any time.',
   '[صياغة مسودة — ليست نصًا معتمدًا] نقيس كيفية استخدام هذا الموقع، ويمكننا مشاركة هذا القياس مع خدمات '
   'الإعلان. لا يُقاس شيء ولا يُشارك شيء حتى تختار. يمكنك تغيير رأيك في أي وقت.',
   now(), true, 'Y9-consent-wording',
   'Drafted by this build so the consent paths are testable and so the banner says something true. The '
   'words a visitor is shown are legal copy and the build has seen none; answering this question '
   'publishes a new version rather than editing version 1, because consent_wording is append-only.');

-- ---------------------------------------------------------------------------------------------
-- The session's four Consent Mode v2 signals
-- ---------------------------------------------------------------------------------------------
-- The column names ARE the external vocabulary, prefixed. The four signal names are Google's and not ours
-- (`CONSENT_MODE_SIGNALS`, A-FIRST-05), so spelling one differently here would produce a store whose
-- consent state could not be handed to the thing it gates. `SESSION_CONSENT_COLUMNS` in
-- `packages/core/src/analytics/consent-gate.ts` is the one place the signal meets the column, and
-- `analytics-consent.itest.ts` holds those four names against the columns this database actually has —
-- without which every lookup would be `undefined`, every signal would read as denied, and every test about
-- suppression would still pass.
--
-- `default false` on all four. See the header: this is the fail-closed default, and it is why an added
-- column needs no backfill statement.
alter table analytics.session
  add column consent_ad_storage          boolean not null default false,
  add column consent_ad_user_data        boolean not null default false,
  add column consent_ad_personalization  boolean not null default false,
  add column consent_analytics_storage   boolean not null default false;

comment on column analytics.session.consent_ad_storage is
  'Consent Mode v2 `ad_storage`, as the consent cookie claimed it when this session was created or last '
  'advanced. Defaults to FALSE: a gate that defaults to granted opens by accident, so an omission '
  'suppresses rather than permits.';
comment on column analytics.session.consent_ad_user_data is
  'Consent Mode v2 `ad_user_data`. The signal a SERVER-SIDE advertising push is gated on (A-MEAS-02), '
  'because such a push sets nothing in any browser and what it does is send the visitor''s own data to an '
  'advertising service.';
comment on column analytics.session.consent_ad_personalization is
  'Consent Mode v2 `ad_personalization`. CAPTURED and forwarded; it gates nothing in this build, because '
  'whether data may personalise advertising is a decision the receiving platform makes. A-MEAS-03 passes '
  'it on.';
comment on column analytics.session.consent_analytics_storage is
  'Consent Mode v2 `analytics_storage`. The signal the internal store is gated on, so a session only '
  'exists because the ingest saw it. Deliberately NOT constrained to true: the check would hold today and '
  'would refuse every fixture row written before this migration, while the fail-closed default already '
  'makes the unsafe direction impossible.';

-- ---------------------------------------------------------------------------------------------
-- The record
-- ---------------------------------------------------------------------------------------------

create type analytics.consent_decision as enum ('granted', 'denied', 'withdrawn');

comment on type analytics.consent_decision is
  'The three kinds of analytics consent record. A withdrawal is a NEW ROW and never an edit (0056): a '
  'column that could be cleared is a column an UPDATE can un-clear. "Never asked" is the ABSENCE of a row '
  'and is never stored, even though the gate treats it exactly like a denial — they are the same '
  'instruction and not the same fact.';

create table analytics.consent_record (
  consent_record_id          uuid not null default public.uuid_generate_v7(),
  decision                   analytics.consent_decision not null,
  -- The four signals, each one as the visitor left it. Named to match analytics.session's columns, which
  -- is what lets one `SESSION_CONSENT_COLUMNS` map serve both.
  consent_ad_storage         boolean not null,
  consent_ad_user_data       boolean not null,
  consent_ad_personalization boolean not null,
  consent_analytics_storage  boolean not null,
  -- The version shown and the hash of its words. NOT NULL on both, which is where this table is STRICTER
  -- than `consent` — that one lets a withdrawal carry no wording, because the realistic withdrawal is
  -- somebody telling the receptionist to stop texting them and a system harder to leave than to join is
  -- the wrong trade. Here every decision, including a withdrawal, is made by clicking a control on a page
  -- that was rendering specific words, so there is always a version and refusing a record without one
  -- costs nothing.
  consent_wording_id         uuid not null references public.consent_wording (id),
  wording_hash               bytea not null,
  -- When the visitor decided. Supplied by the caller's clock and NOT defaulted, for the reason 0056 gives
  -- for `consent.recorded_at`: every assertion about ordering here is made under a frozen one.
  decided_at                 timestamptz not null,
  capture_locale             text not null
                               constraint consent_record_locale_known
                                 check (capture_locale in ('en', 'ar')),
  -- The surface, with exactly one value today. A vocabulary with a value nobody writes is
  -- indistinguishable from a vocabulary whose writer stopped working, so a preference centre is a value
  -- added here by the unit that builds one.
  capture_surface            text not null
                               constraint consent_record_surface_known
                                 check (capture_surface in ('consent_banner')),
  -- When the ROW landed, as distinct from when the person decided. Two facts, both real, neither editable.
  created_at                 timestamptz not null default now(),
  primary key (consent_record_id),
  -- A GRANT that grants nothing is a denial wearing the wrong name, and recording it as a grant would
  -- report a consent rate this build did not earn. A denial or a withdrawal that kept one signal is a NEW
  -- GRANT of that signal and has to be recorded as one, or the log says somebody opted out while the gate
  -- goes on opening. `analyticsConsentShapeRefusal` in @berelax/shared is the readable half of the same
  -- rule and `analytics-consent.itest.ts` asserts both.
  constraint consent_record_grant_grants_something
    check (decision <> 'granted'
           or consent_ad_storage or consent_ad_user_data
           or consent_ad_personalization or consent_analytics_storage),
  constraint consent_record_refusal_grants_nothing
    check (decision = 'granted'
           or not (consent_ad_storage or consent_ad_user_data
                   or consent_ad_personalization or consent_analytics_storage))
);

comment on table analytics.consent_record is
  'The analytics consent record (A-MEAS-02, docs/04 SS8): which of the four Consent Mode v2 signals a '
  'visitor granted, under which wording version, at which instant. Append-only: UPDATE and DELETE raise, '
  'for every role including the owner. It holds NO identifier of any kind and names no visitor — see '
  '0125''s header: the visitor row is created AT consent by the ingest and does not exist yet when the '
  'banner is answered, and a second identifier-minting site is the drift this unit exists to prevent.';
comment on column analytics.consent_record.wording_hash is
  'The caller''s snapshot of consent_wording.content_hash for the words it rendered. '
  'assert_consent_wording_hash() (ZP002) refuses an INSERT that disagrees with the stored version, which '
  'is the only way an edit to a published wording is detectable at all.';
comment on column analytics.consent_record.decided_at is
  'When the visitor decided. Supplied, never defaulted; created_at beside it is when the row landed.';

-- Reading the log: newest first, and the counts A-FIRST-10 publishes are a group by on `decision`.
create index consent_record_decided_idx on analytics.consent_record (decided_at desc);

-- The same instrument 0056 uses, with the same reach. A trigger and not `create rule ... do instead
-- nothing`, because a rule reports success and the caller goes on believing the edit happened.
create function analytics.refuse_consent_record_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'analytics.consent_record is append-only; % is refused. A withdrawal is a NEW row with '
    'decision = withdrawn, and a correction is a new row too. Clearing a grant would leave the fact that '
    'somebody opted out as a value rather than as a record.',
    tg_op
    using errcode = 'ZY311';
end $$;

comment on function analytics.refuse_consent_record_change() is
  'Raises ZY311 for EVERY role, the owner and berelax_retention included. The retention role holds UPDATE '
  'and DELETE here by the schema''s default privileges, and the policy row says keep_indefinitely — so a '
  'write from that role would be a bug, and a trigger that exempted it would make it a silent one.';

create trigger consent_record_no_update before update on analytics.consent_record
  for each row execute function analytics.refuse_consent_record_change();
create trigger consent_record_no_delete before delete on analytics.consent_record
  for each row execute function analytics.refuse_consent_record_change();

-- The wording snapshot is checked by 0056's OWN trigger function, attached here rather than copied.
-- `assert_consent_wording_hash()` reads `new.consent_wording_id` and `new.wording_hash`, which this table
-- has under the same names for exactly this reason: a second implementation of "the snapshot must equal
-- the stored version" is a second way for a valid consent record to read as tampered.
create trigger consent_record_wording_hash_matches before insert on analytics.consent_record
  for each row execute function assert_consent_wording_hash();

-- Explicit rather than merely absent, 0056's argument: the triggers raise for every role, and this makes
-- the application role unable to try. The default privileges 0096 declared for this schema grant only
-- select and insert, so these are belt and braces on the role that matters.
revoke update, delete on analytics.consent_record from berelax_app;

-- Its retention policy row, which is not paperwork: analytics.run_retention raises ZY062 for a base table
-- in this schema with no row here, so the whole pass stops rather than retaining a new table for ever by
-- omission.
insert into analytics.retention_policy (relation_name, policy, age_column, purge_order, reason)
values
  ('consent_record', 'keep_indefinitely', null, null,
   'The analytics consent record (A-MEAS-02). Exempt because there is nothing here for retention to '
   'protect anybody from: the row holds a decision, four booleans, a wording reference and an instant, '
   'and NO identifier of any kind. It is also the evidence docs/04 SS8 requires a consent decision to '
   'leave behind, and a 90-day window would delete the proof that somebody was asked.');

-- ---------------------------------------------------------------------------------------------
-- The dispatch destinations, and what each one requires
-- ---------------------------------------------------------------------------------------------
-- One row per server-side destination, four booleans parallel to the session's four columns. Held equal to
-- `CONSENT_GATED_TARGETS` in `packages/core/src/analytics/consent-gate.ts` in BOTH directions by
-- `analytics-consent.itest.ts` — this is the second statement of a mapping and it arrives with the check.
--
-- It names no host and no vendor. `scripts/check-egress-guard.mjs` rule 6 refuses a module that names an
-- analytics destination outside `DECLARED_ADAPTERS`, which is empty until A-MEAS-03 writes the adapters,
-- and an opaque destination id is what the gate needs anyway: what a payload leaves through is the
-- adapter's business and which signal permits it is this table's.
create table analytics_dispatch_destination (
  destination                text not null,
  requires_ad_storage         boolean not null,
  requires_ad_user_data       boolean not null,
  requires_ad_personalization boolean not null,
  requires_analytics_storage  boolean not null,
  reason                      text not null,
  created_at                  timestamptz not null default now(),
  primary key (destination),
  -- The fail-closed guard, and it is structural because the natural way to add a destination is to copy a
  -- row and clear the flags. A destination requiring NO signal would be permitted for every session,
  -- including one that answered the banner with a flat no, and the trigger below would have nothing to
  -- refuse it with.
  constraint analytics_dispatch_destination_requires_something
    check (requires_ad_storage or requires_ad_user_data
           or requires_ad_personalization or requires_analytics_storage),
  constraint analytics_dispatch_destination_reason_not_blank check (btrim(reason) <> '')
);

comment on table analytics_dispatch_destination is
  'Which Consent Mode v2 signals each server-side dispatch destination may not act without (A-MEAS-02). A '
  'TABLE and not a CASE inside the trigger: a case with no ELSE yields NULL for an unlisted signal, NOT '
  'NULL is NULL, and a trigger whose condition is NULL lets the row through — the fail-open an added '
  'signal would reach. A table can also be read back and held equal to CONSENT_GATED_TARGETS, which a '
  'case cannot.';

insert into analytics_dispatch_destination
  (destination, requires_ad_storage, requires_ad_user_data, requires_ad_personalization,
   requires_analytics_storage, reason)
values
  ('analytics_measurement_push', false, false, false, true,
   'A server-side measurement push records the same measurement the on-page tag would have, so it is '
   'gated on analytics_storage.'),
  ('advertising_conversion_push', false, true, false, false,
   'A server-side conversion push sets nothing in any browser, so ad_storage does not describe it. What '
   'it does is send the visitor''s own data to an advertising service, which is ad_user_data.');

-- ---------------------------------------------------------------------------------------------
-- The dispatch queue
-- ---------------------------------------------------------------------------------------------

create type analytics_dispatch_state as enum
  ('queued', 'sent', 'suppressed', 'cancelled_consent_withdrawn');

comment on type analytics_dispatch_state is
  'Where a dispatch is in its life. `suppressed` is a dispatch that was never enqueued — the row exists '
  'so the refusal is VISIBLE rather than silent — and `cancelled_consent_withdrawn` is one that was '
  'queued when the visitor changed their mind. A-MEAS-03 owns transport failure and adds its own value.';

create table analytics_dispatch (
  dispatch_id    uuid not null default uuid_generate_v7(),
  /*
   * The session whose consent state governs this dispatch. `on delete cascade`, so the 90-day purge of a
   * session takes its dispatch records with it and `analytics.retention_policy` has nothing to claim about
   * a table outside its schema. A real foreign key and not a plain uuid, unlike the append-only logs in
   * 0056 and 0024: those have to OUTLIVE their parent, and a dispatch record about a purged session is a
   * record about nothing — there is no state left to say whether it should have gone out.
   */
  session_id     uuid not null references analytics.session (session_id) on delete cascade,
  destination    text not null references analytics_dispatch_destination (destination),
  /*
   * Which funnel stage this dispatch is about, as `analytics.funnel_step_name` — 0096's own enum, whose
   * ORDER is the measurement and which A-FIRST-02 pins against the shared tuple. A second vocabulary of
   * dispatchable events would be a third statement of the funnel, and A-MEAS-01's rule 7 already refuses
   * an event type that is not derived from it.
   */
  funnel_stage   analytics.funnel_step_name not null,
  state          analytics_dispatch_state not null,
  /*
   * Why a dispatch is not going out. `consent_denied` is the acceptance line's own spelling and
   * `consent_withdrawn` is the second kind — two values and not one, because a dispatch nobody was ever
   * permitted to send and one cancelled because somebody changed their mind are different facts.
   */
  reason         text,
  decided_at     timestamptz not null,
  transmitted_at timestamptz,
  created_at     timestamptz not null default now(),
  primary key (dispatch_id),
  constraint analytics_dispatch_reason_known
    check (reason is null or reason in ('consent_denied', 'consent_withdrawn')),
  /*
   * `transmitted_at` is present exactly when the row is `sent`. This is what makes "a test asserts nothing
   * was transmitted" a claim about a stored fact rather than about an absence: a cancelled dispatch has no
   * transmission instant, and one cannot be given one without moving the state.
   */
  constraint analytics_dispatch_transmitted_iff_sent
    check ((state = 'sent') = (transmitted_at is not null)),
  /*
   * A terminal non-sent state carries its reason, and a live one carries none.
   *
   * The two rules below make `reason` derivable from `state` today, which looks like a second statement of
   * one fact and is not: it is the constraint that keeps the pair in bijection WHILE it is one, so
   * A-MEAS-03's transport failures arrive by a migration that relaxes these deliberately rather than by a
   * row that quietly disagrees with the state beside it.
   */
  constraint analytics_dispatch_reason_iff_refused
    check ((state in ('suppressed', 'cancelled_consent_withdrawn')) = (reason is not null)),
  constraint analytics_dispatch_suppression_is_a_denial
    check (state <> 'suppressed' or reason = 'consent_denied'),
  constraint analytics_dispatch_cancellation_is_a_withdrawal
    check (state <> 'cancelled_consent_withdrawn' or reason = 'consent_withdrawn')
);

comment on table analytics_dispatch is
  'The outbound analytics dispatch queue (A-MEAS-02 writes it and gates it; A-MEAS-03 consumes it). A '
  'dispatch for a session lacking the destination''s required signal is NOT enqueued and a row is written '
  'with state = suppressed and reason = consent_denied, so the suppression is visible rather than silent. '
  'In `public` beside outbox_event, which it behaves like, and not in `analytics`, whose retention policy '
  'would then have to claim something about rows that leave by cascade.';
comment on column analytics_dispatch.state is
  'Where this dispatch is. The ZY312 trigger refuses `queued` and `sent` for a session lacking the '
  'destination''s signals, on INSERT and on UPDATE, which is what makes a withdrawal airtight: the '
  'withdrawal clears the session''s columns, so a cancelled row cannot be reinstated and transmitted.';

-- The consumer's own read (A-MEAS-03), and the withdrawal's: everything still queued for a session.
create index analytics_dispatch_queued_idx on analytics_dispatch (session_id)
  where state = 'queued';
create index analytics_dispatch_state_idx on analytics_dispatch (state, decided_at desc);

/*
 * **The gate, in the database — ONE statement of it, used twice.**
 *
 * `dispatch_consent_gap` answers the only question: which of a destination's required signals is this
 * session missing. It is a FUNCTION rather than an expression inside the trigger, and that is the whole
 * design, because there are two callers and a second copy of the comparison would drift between them:
 *
 *   * the trigger below, which refuses a row reaching `queued` or `sent`;
 *   * `enqueueAnalyticsDispatch` in `packages/db/src/repositories/analytics-consent.ts`, which chooses
 *     between writing a `queued` row and writing the `suppressed` row that makes the refusal visible.
 *
 * It also has to be the database's own statement because of ADR 0001: `packages/db` may never import
 * `packages/core`, where `gateConsent` lives, so the writer cannot ask the pure gate. The two statements
 * that DO exist — `CONSENT_GATED_TARGETS` in core and `analytics_dispatch_destination` here — are held
 * equal in both directions by `packages/fixtures/src/analytics-consent.itest.ts`, which is the only
 * package that may hold both.
 *
 * A missing session or a missing destination RAISES rather than returning an empty gap. An empty gap means
 * "permitted", so a function that returned one for a row it could not read would be a gate that opens for
 * exactly the input it cannot judge.
 *
 * Both guards were written as belt and braces against a NULL the foreign keys make impossible, and the
 * destination one turns out to be the branch that actually FIRES: a BEFORE INSERT trigger runs before the
 * row's foreign keys are checked, so an undeclared destination reaches this function rather than `23503`.
 * `analytics-consent.itest.ts` expected the key's error and measured this one, which is recorded here
 * because a guard somebody reads as unreachable is a guard somebody deletes.
 *
 * The comparison is column-wise and written out rather than looped over a vocabulary. There is no signal
 * NAME to mis-spell and nothing that can be NULL — `requires_x and not consent_x` is a boolean for every
 * pair, because all eight columns are NOT NULL — which is the trap a `case` over signal names would carry:
 * a `case` with no `else` yields NULL for an unlisted name, `not NULL` is NULL, and a condition that is
 * NULL lets the row through.
 */
create function dispatch_consent_gap(p_session_id uuid, p_destination text) returns text[]
language plpgsql
stable
as $$
declare
  s record;
  d record;
begin
  select consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
         consent_analytics_storage
    into s
    from analytics.session
   where session_id = p_session_id;
  if not found then
    raise exception
      'analytics_dispatch names session %, which does not exist, so no consent state could be read for '
      'it. A dispatch whose consent state cannot be read is refused rather than permitted.', p_session_id
      using errcode = 'ZY312';
  end if;

  select requires_ad_storage, requires_ad_user_data, requires_ad_personalization,
         requires_analytics_storage
    into d
    from analytics_dispatch_destination
   where destination = p_destination;
  if not found then
    raise exception
      'analytics_dispatch names destination %, which has no row in analytics_dispatch_destination, so '
      'nothing says which consent signals it needs. An ungated destination is refused rather than '
      'permitted.', p_destination
      using errcode = 'ZY312';
  end if;

  -- `array_remove(..., null)` never returns NULL, and `cardinality` of an empty array is 0 rather than
  -- NULL. Both callers test `cardinality(...) = 0`; `array_length(x, 1) > 0` would have been NULL for the
  -- permitted case, and a NULL condition is how a gate stops gating.
  return array_remove(array[
    case when d.requires_ad_storage and not s.consent_ad_storage
         then 'ad_storage' end,
    case when d.requires_ad_user_data and not s.consent_ad_user_data
         then 'ad_user_data' end,
    case when d.requires_ad_personalization and not s.consent_ad_personalization
         then 'ad_personalization' end,
    case when d.requires_analytics_storage and not s.consent_analytics_storage
         then 'analytics_storage' end
  ], null);
end $$;

comment on function dispatch_consent_gap(uuid, text) is
  'Which of a destination''s required Consent Mode v2 signals a session has not granted. Empty means '
  'permitted. The ONE statement of the gate inside the database, called by the ZY312 trigger and by '
  'enqueueAnalyticsDispatch - packages/db may never import packages/core, so the writer cannot ask the '
  'pure gate and a second copy of the comparison would drift. Raises ZY312 for a session or a destination '
  'it cannot read, because an empty gap means permitted.';

/*
 * The refusal.
 *
 * A dispatch may not be `queued` or `sent` while a required signal is missing, for every role including
 * the owner, on INSERT and on UPDATE — with no setting, no flag and no environment to switch it off, which
 * is the acceptance line "it is code, not configuration" made true at the one boundary a call site cannot
 * talk its way past. The UPDATE half is what makes a withdrawal airtight: the withdrawal clears the
 * session's four columns, so a cancelled row cannot be reinstated and transmitted afterwards.
 *
 * `suppressed` and `cancelled_consent_withdrawn` are deliberately NOT checked. Those rows are the record
 * that a dispatch did not go out, and refusing to write them would make the suppression silent, which is
 * the one outcome this whole table exists to prevent.
 */
create function assert_dispatch_consent() returns trigger
language plpgsql
as $$
declare
  v_missing text[];
begin
  if new.state not in ('queued', 'sent') then
    return new;
  end if;
  v_missing := dispatch_consent_gap(new.session_id, new.destination);
  if cardinality(v_missing) = 0 then
    return new;
  end if;
  raise exception
    'Session % has not granted %, which destination % requires, so this dispatch may not be %. Write the '
    'suppression instead: state = suppressed with reason = consent_denied, which is what makes the '
    'refusal visible rather than silent.',
    new.session_id, array_to_string(v_missing, ', '), new.destination, new.state
    using errcode = 'ZY312';
end $$;

comment on function assert_dispatch_consent() is
  'Raises ZY312 when a dispatch would be queued or sent for a session lacking a signal its destination '
  'requires. For every role including the owner: a privilege covers the application role, and a worker, a '
  'psql session and a future call site that never heard of the gate are none of them that role.';

create trigger analytics_dispatch_consent_gate
  before insert or update on analytics_dispatch
  for each row execute function assert_dispatch_consent();

commit;
