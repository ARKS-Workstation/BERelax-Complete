-- 0056 — consent: channel x purpose x timestamp x wording version, append-only.
--
-- C-CRM-03. docs/04 §8 states the requirement in one sentence: "Consent per channel and per purpose,
-- timestamped, storing the exact wording version shown, in Arabic and English, versioned and hashed."
-- §5 says why it is structural rather than a settings page: TDRA reportedly requires the opt-in proof to
-- be available *before* a promotional blast, penalties are cited as high as AED 400,000 per message, and
-- the practical sanction is sender-ID suspension — which, with two registered identities (ADR 0016), is
-- still the loss of every campaign this business can run.
--
-- ## Everything here is append-only, and that is the whole design
--
-- `consent` and `consent_wording` both revoke UPDATE and DELETE with a BEFORE trigger that RAISES.
-- There are three consequences a reader has to hold on to, because each of them is the opposite of what
-- the obvious code would do:
--
--   1. **A withdrawal is a new row**, with `kind = 'withdrawn'`. It does not clear a flag, it does not
--      set a `withdrawn_at` on the granting row, and the granting row is left byte-identical. A column
--      that could be cleared is a column an UPDATE can un-clear, and the evidence that somebody opted
--      out would then be a value rather than a record.
--   2. **A correction is a new row.** The wrong channel, the wrong purpose, a mis-keyed timestamp: all
--      of them are corrected forward. `appointment_status_history` (0024) makes the same argument for
--      the same reason — history a DELETE can rewrite is not history.
--   3. **A reworded consent statement is a new VERSION**, never an edit. An edited wording silently
--      re-words every consent row already pointing at it, which is precisely the tampering the stored
--      hash exists to make detectable.
--
-- `consent_purpose` is the exception and is mutable, because it is a vocabulary rather than a record:
-- confirming a provisional label clears its flag, which is an UPDATE, and it is audited by the trigger
-- 0053 introduced for exactly this shape of table.
--
-- ## The contact reference is a plain uuid with NO foreign key
--
-- The same choice `audit_event` (0005), `google_connection_events` (0016) and
-- `appointment_status_history` (0024) make, and for the reason 0024 states: an append-only log with a
-- foreign key to a mutable parent is a contradiction, because the parent's DELETE either fails or
-- rewrites history. Here it would fail — a cascade fires the row-level refusal trigger and raises — so
-- one consent row would make `delete from customer` impossible for every caller including the suites
-- that clear the table between cases.
--
-- It is also the PDPL answer. docs/04 §4 and §8 resolve the erasure-versus-retention conflict by
-- anonymising the CRM identity and retaining the record carried by a statutory or evidential
-- obligation, recording the conflict. The proof that a send was permitted is exactly such a record: it
-- must survive the erasure of the identity it was about, and a foreign key would delete it with them.
--
-- `consent_wording_id` IS a foreign key, and the contrast is the point: `consent_wording` is itself
-- append-only, so the DELETE a foreign key would have to answer for cannot happen.
--
-- ## The hash is computed by the database, and the consent row snapshots it
--
-- `consent_wording.content_hash` is GENERATED ALWAYS from the EN and AR text through
-- `consent_wording_hash()`, so a wording row cannot hold a hash that disagrees with its own words. The
-- consent row carries `wording_hash` as well — the hash the caller had in hand when it rendered the
-- statement — and `assert_consent_wording_hash()` refuses an INSERT whose snapshot does not equal the
-- referenced version's. Two things follow:
--
--   - a caller that read one version, rendered it, and wrote the consent row after somebody published a
--     different one is refused rather than recorded against words it did not show;
--   - a wording row altered later (which needs the refusal trigger disabled as the owner, since the
--     application role cannot UPDATE it at all) leaves every consent row pointing at it with a stale
--     snapshot, which `consentWordingIntegrity` in packages/db reports. Without the snapshot the
--     tampering would be undetectable: the generated hash would move with the text.
--
-- ## The purpose vocabulary is a TABLE, not a Postgres enum
--
-- The four purposes are this build's reading of docs/04 §8 and nobody has stated a purpose taxonomy for
-- this business (Y9-consent-purpose). A provisional value has to carry a marker the system can see —
-- `is_provisional`, `open_question_id`, `provisional_note`, the trio 0031, 0032 and 0053 established and
-- `unconfirmedAssumptionRows` reads — and `create type ... as enum` has nowhere to put one (brief rule
-- 15). Transactional service updates are deliberately ABSENT from the vocabulary: `evaluateGate`
-- returns `allow` for a transactional message before any store is read, and a purpose somebody could
-- later gate a booking confirmation on is how a consent outage becomes an operational one.

begin;

-- ---------------------------------------------------------------------------------------------
-- The canonical wording hash
-- ---------------------------------------------------------------------------------------------
-- One definition, used by the GENERATED column, by the INSERT trigger on `consent`, and by
-- `consentWordingHash` in packages/db. Three copies of a hash definition is three ways for a valid
-- consent record to read as tampered.
--
-- The unit separator between the two texts is load-bearing. Without it ('ab','c') and ('a','bc') hash
-- identically, so a wording pair could be re-split between the columns — English text moved into the
-- Arabic column and back — with the hash never moving. U+001F cannot occur in either text: the CHECKs
-- below refuse a control character.
create function consent_wording_hash(p_text_en text, p_text_ar text) returns bytea
language sql
immutable
strict
as $$
  select sha256(convert_to(p_text_en || chr(31) || p_text_ar, 'UTF8'));
$$;

comment on function consent_wording_hash(text, text) is
  'SHA-256 over the EN and AR wording, separated by U+001F. IMMUTABLE so consent_wording.content_hash '
  'can be GENERATED from it. The separator stops two different splits of one pair sharing a hash.';

-- ---------------------------------------------------------------------------------------------
-- The purposes
-- ---------------------------------------------------------------------------------------------

create table consent_purpose (
  purpose          text        primary key,
  display_order    smallint    not null unique,
  description      text        not null,
  -- Whether a PROMOTIONAL SEND may be gated on this purpose. `clinical_processing` and `photography`
  -- are lawful bases for holding a record, not permission to message anybody, and a send path that
  -- accepted one of them would pass every test it had. Pinned to SEND_GATING_CONSENT_PURPOSES in
  -- @berelax/shared by packages/fixtures/src/consent.itest.ts.
  is_send_gating   boolean     not null,
  is_provisional   boolean     not null default false,
  open_question_id text,
  provisional_note text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The provenance trio, whole or absent. A row flagged provisional with no question id is an
  -- assumption nobody can look up, which is the state the flag exists to prevent.
  constraint consent_purpose_provenance
    check ((is_provisional and open_question_id is not null) or not is_provisional)
);

comment on table consent_purpose is
  'What consent is asked FOR. A TABLE and not an enum because every label is provisional and an enum '
  'label cannot carry is_provisional, an OPEN-QUESTIONS id or a note. Transactional service updates are '
  'deliberately absent: they are not consent-gated, and a purpose here could be gated on later.';
comment on column consent_purpose.is_send_gating is
  'True for the purposes a promotional send may be refused on. False for a lawful basis that is not a '
  'messaging permission - a photography grant is not permission to text an offer.';

-- Seeded in the migration rather than in a seed script, because `consent.purpose` has a foreign key
-- into this table: a database without these rows cannot accept a consent record at all, so they are not
-- fixture data, they are part of the schema's meaning. Same argument 0053 makes for its two.
insert into consent_purpose
  (purpose, display_order, description, is_send_gating, is_provisional, open_question_id,
   provisional_note)
values
  ('marketing', 1,
   'Offers, campaigns and win-back messages. The purpose TDRA''s opt-in proof is about.',
   true, true, 'Y9-consent-purpose',
   'Four purposes read off docs/04 SS8 by this build; no purpose taxonomy has been stated by the business.'),
  ('review_request', 2,
   'Asking a client to leave a public review after a treatment. Separate from marketing because a '
   'client may welcome one and not the other, and a single flag would make the stricter answer win for '
   'both.',
   true, true, 'Y9-consent-purpose',
   'Four purposes read off docs/04 SS8 by this build; no purpose taxonomy has been stated by the business.'),
  ('clinical_processing', 3,
   'Holding and processing the intake answers behind the clinical boundary (ADR 0010). Not a messaging '
   'permission: nothing may send on the strength of it.',
   false, true, 'Y9-consent-purpose',
   'Four purposes read off docs/04 SS8 by this build; no purpose taxonomy has been stated by the business.'),
  ('photography', 4,
   'Using a client''s image. Not a messaging permission either. The therapist-side equivalent is '
   'employee.photo_consent (0030), which is a different subject and a different table.',
   false, true, 'Y9-consent-purpose',
   'Four purposes read off docs/04 SS8 by this build; no purpose taxonomy has been stated by the business.');

create trigger consent_purpose_updated_at before update on consent_purpose
  for each row execute function set_updated_at();

-- Audited by 0053's vocabulary trigger, which is generic over the primary-key column name and whose own
-- comment invites a third vocabulary. A vocabulary has no repository - it is changed by a migration or a
-- one-off admin correction - so a trigger is the only instrument that can attribute the change at all.
create trigger consent_purpose_audit
  after insert or update or delete on consent_purpose
  for each row execute function record_crm_vocabulary_change('purpose');

-- ---------------------------------------------------------------------------------------------
-- The wording versions
-- ---------------------------------------------------------------------------------------------

create table consent_wording (
  id               uuid        primary key default uuid_generate_v7(),
  purpose          text        not null references consent_purpose (purpose),
  -- Monotonic per purpose, and the number a person quotes. Not derived from `published_at`: two
  -- versions published in one second would then be one version.
  version          integer     not null check (version >= 1),
  -- The exact words shown, both languages, always both. A consent statement published in English only
  -- is a record that cannot answer what an Arabic-speaking client agreed to, and this market reads
  -- Arabic (docs/04 SS5 on UCS-2 pricing is the same fact seen from the cost side).
  text_en          text        not null
                     constraint consent_wording_en_is_stated
                       check (not is_placeholder_text(text_en)
                              and length(text_en) between 1 and 4000),
  text_ar          text        not null
                     constraint consent_wording_ar_is_stated
                       check (not is_placeholder_text(text_ar)
                              and length(text_ar) between 1 and 4000),
  -- GENERATED, so the row cannot hold a hash that disagrees with its own words. The tamper this schema
  -- defends against is therefore an edit to the TEXT, which moves this hash and strands the snapshot on
  -- every consent row pointing here - see the header.
  content_hash     bytea       not null
                     generated always as (consent_wording_hash(text_en, text_ar)) stored,
  -- When this version became the wording shown. There is deliberately no draft state and no nullable
  -- `published_at`: a wording nobody has shown to anybody has no reason to be in the table that records
  -- what was shown, and a mutable draft row is an UPDATE path into an append-only table.
  published_at     timestamptz not null,
  is_provisional   boolean     not null default false,
  open_question_id text,
  provisional_note text,
  created_at       timestamptz not null default now(),
  constraint consent_wording_provenance
    check ((is_provisional and open_question_id is not null) or not is_provisional),
  -- One text in both columns is a copy-paste away and nothing else would report it: the client is shown
  -- English, the record says Arabic, and the hash is perfectly valid.
  constraint consent_wording_languages_differ check (text_en <> text_ar),
  -- At least one Arabic character. The same blocks packages/core/src/text/bidi.ts uses to decide a
  -- string is RTL. Presence, not a language check - it catches the English paste, which is the only
  -- failure mode here that is silent.
  constraint consent_wording_ar_is_arabic_script
    check (text_ar ~ '[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-ﻼ]'),
  -- No control characters in either text. U+001F is the separator `consent_wording_hash` puts between
  -- them, so a text containing one could make two different pairs hash identically - the exact ambiguity
  -- the separator exists to remove. [[:cntrl:]] rather than a \u range: the range would have to include
  -- U+0000, which a text value cannot hold and which a regex is a poor place to name.
  constraint consent_wording_no_control_characters
    check (text_en !~ '[[:cntrl:]]' and text_ar !~ '[[:cntrl:]]'),
  constraint consent_wording_version_unique unique (purpose, version)
);

comment on table consent_wording is
  'The exact consent statement shown, per purpose, in EN and AR, versioned and hashed (docs/04 SS8). '
  'Append-only: UPDATE and DELETE raise, for every role including the owner. A reworded statement is a '
  'new version - editing one would silently re-word every consent row already pointing at it.';
comment on column consent_wording.content_hash is
  'GENERATED from the two texts by consent_wording_hash(). A wording row therefore cannot lie about its '
  'own hash; the row that CAN go stale is the consent row''s snapshot of it, which is the point.';
comment on column consent_wording.published_at is
  'When this version became the wording shown. Supplied, never defaulted: every expiry and ordering '
  'assertion in this area is made under a frozen clock, and created_at beside it is when the row landed.';

create index consent_wording_purpose_idx on consent_wording (purpose, version desc);

create function refuse_consent_wording_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'consent_wording is append-only; % is refused. The exact wording shown is what a consent record '
    'proves, and a statement that can be edited afterwards proves nothing about what anybody read. '
    'Publish a new version.',
    tg_op
    using errcode = 'ZP001';
end $$;

comment on function refuse_consent_wording_change() is
  'Raises ZP001 for EVERY role including the owner. A trigger and not `create rule ... do instead '
  'nothing`, because a rule reports success and the caller goes on believing the edit happened.';

create trigger consent_wording_no_update before update on consent_wording
  for each row execute function refuse_consent_wording_change();
create trigger consent_wording_no_delete before delete on consent_wording
  for each row execute function refuse_consent_wording_change();

-- ---------------------------------------------------------------------------------------------
-- The consent records
-- ---------------------------------------------------------------------------------------------

create type consent_kind as enum ('granted', 'withdrawn');

comment on type consent_kind is
  'The two kinds of record, and there are only two. "Never asked" is the ABSENCE of a row and is never '
  'stored: a row saying nothing happened is a row a later reader treats as a decision.';

create table consent (
  id                  uuid            primary key default uuid_generate_v7(),
  -- A plain uuid, deliberately NOT a foreign key. See the header: an append-only log cannot hold a
  -- reference to a mutable parent, and this record has to survive the erasure of the identity it is
  -- about (docs/04 SS4, SS8).
  contact_customer_id uuid            not null,
  -- `message_channel` since 0014, which is the enum the template, the message row and the transport all
  -- use. A second list of channel names here is a consent record the send path cannot match.
  channel             message_channel not null,
  purpose             text            not null references consent_purpose (purpose),
  kind                consent_kind    not null,
  -- When the person decided. Supplied by the caller's clock and NOT defaulted, for the reason 0019
  -- gives for otp_challenge.issued_at: every assertion about ordering here is made under a frozen one.
  recorded_at         timestamptz     not null,
  -- The version shown, and the hash the caller had in hand when it rendered it. Both or neither.
  consent_wording_id  uuid            references consent_wording (id),
  wording_hash        bytea,
  -- The capture context, all of it mandatory. PDPL asks who consented, to what, when, and on the
  -- strength of which words; a record missing any of those cannot answer the question it exists for.
  capture_source      text            not null
                        check (capture_source in
                          ('booking_form','front_desk','whatsapp_reply','preference_centre','import')),
  capture_actor_kind  text            not null
                        check (capture_actor_kind in ('customer','staff','system')),
  capture_actor_label text            not null
                        constraint consent_actor_is_stated
                          check (not is_placeholder_text(capture_actor_label)
                                 and length(capture_actor_label) <= 200),
  capture_locale      text            not null check (capture_locale in ('en','ar')),
  -- When the ROW landed, as distinct from when the person decided. Two facts, both real: a backdated
  -- `recorded_at` is visible next to the instant it was actually written, and neither can be edited.
  created_at          timestamptz     not null default now(),
  -- A reference and its hash are one fact said twice, so they cannot disagree: a hash with no version
  -- cannot be verified and a version with no hash records nothing about what was shown.
  constraint consent_wording_reference_is_whole
    check ((consent_wording_id is null) = (wording_hash is null)),
  -- A GRANT must carry the wording it was given under; a WITHDRAWAL need not. The asymmetry is
  -- deliberate: the realistic withdrawal is somebody telling the receptionist to stop texting them, and
  -- a system that refused to record that until an operator produced a wording version would be easier
  -- to opt into than out of.
  constraint consent_grant_carries_its_wording
    check (kind <> 'granted' or consent_wording_id is not null)
);

comment on table consent is
  'Consent per contact, channel and purpose, timestamped, carrying the wording version shown (docs/04 '
  'SS8). Append-only: UPDATE and DELETE raise, for every role including the owner. A withdrawal is a NEW '
  'row with kind = withdrawn and the granting row is left untouched; so is a correction.';
comment on column consent.contact_customer_id is
  'Plain uuid, deliberately not a foreign key. An append-only log cannot hold a reference to a mutable '
  'parent (0024): a cascade would fire the refusal trigger and make `delete from customer` impossible, '
  'and this record must outlive the erasure of the identity it is about.';
comment on column consent.wording_hash is
  'The caller''s snapshot of consent_wording.content_hash at the moment it rendered the statement. '
  'assert_consent_wording_hash() refuses an INSERT that disagrees with the stored version, and a later '
  'edit to the wording leaves this stale - which is the only way tampering is detectable at all.';

-- One row per (contact, channel, purpose, kind, instant).
--
-- `kind` is IN the key on purpose. Without it, a withdrawal recorded at the same instant as a grant
-- would collide, and `on conflict do nothing` in the repository would discard the withdrawal in
-- silence - the one outcome this whole table exists to prevent. With it, the pair is stored, the log is
-- ambiguous, and `resolveConsent` fails closed to `unknown`: safe, visible, and settled by a further
-- row. The idempotence it does buy is real: a double-submitted opt-in form is one record.
create unique index consent_one_record_per_instant
  on consent (contact_customer_id, channel, purpose, kind, recorded_at);

-- The send path's own read: every record for one contact, newest first.
create index consent_contact_idx on consent (contact_customer_id, channel, purpose, recorded_at desc);
create index consent_wording_id_idx on consent (consent_wording_id)
  where consent_wording_id is not null;

create function assert_consent_wording_hash() returns trigger
language plpgsql
as $$
declare
  v_expected bytea;
begin
  if new.consent_wording_id is null then
    return new;
  end if;
  select content_hash into v_expected from consent_wording where id = new.consent_wording_id;
  -- The foreign key has already proved the row exists, so a NULL here would mean the generated column
  -- produced one - which it cannot. Checked anyway: `null <> null` is null, and a trigger whose
  -- condition is null lets the row through.
  if v_expected is null then
    raise exception
      'consent_wording % has no content hash, so the wording this consent record claims cannot be '
      'verified.', new.consent_wording_id
      using errcode = 'ZP002';
  end if;
  if new.wording_hash <> v_expected then
    raise exception
      'This consent record snapshots wording hash %, and consent_wording % hashes to %. The words the '
      'record claims were shown are not the words stored. Either a different version was published '
      'between the render and the write, or the wording has been altered.',
      encode(new.wording_hash, 'hex'), new.consent_wording_id, encode(v_expected, 'hex')
      using errcode = 'ZP002';
  end if;
  return new;
end $$;

comment on function assert_consent_wording_hash() is
  'Raises ZP002 when a consent row''s snapshot of the wording hash disagrees with the stored version. '
  'BEFORE INSERT only: the row cannot be UPDATEd at all, and re-checking on UPDATE would imply it can.';

create trigger consent_wording_hash_matches before insert on consent
  for each row execute function assert_consent_wording_hash();

create function refuse_consent_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'consent is append-only; % is refused. A withdrawal is a NEW row with kind = withdrawn, and a '
    'correction is a new row too. Clearing a grant would leave the fact that somebody opted out as a '
    'value rather than as a record.',
    tg_op
    using errcode = 'ZP003';
end $$;

comment on function refuse_consent_change() is
  'Raises ZP003 for EVERY role including the owner: privileges cover the application role, and a '
  'migration or a psql session does not connect as the application role.';

create trigger consent_no_update before update on consent
  for each row execute function refuse_consent_change();
create trigger consent_no_delete before delete on consent
  for each row execute function refuse_consent_change();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009's `alter default privileges` grants berelax_app select/insert/update/delete on tables created in
-- public afterwards, so these revokes are load-bearing rather than decorative - and stated explicitly
-- because a managed database restored from a dump does not necessarily carry the same defaults. The
-- triggers above raise for every role; these make the application role unable to try.
revoke update, delete on consent from berelax_app;
revoke update, delete on consent_wording from berelax_app;

-- The reporting role may read both. Unlike the blocklist and the do-not-pair flag, which 0053 revoked
-- `select` on, a consent record is the evidence a marketing report has to be able to cite: "how many
-- contacts may we message" is a question answered from this table or not at all. It carries no contact
-- detail - the contact is a uuid - so reading it discloses no phone number or address.

commit;
