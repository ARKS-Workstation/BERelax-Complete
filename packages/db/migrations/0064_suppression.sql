-- 0064 — the suppression list, and the opt-out grant that lets somebody put themselves on it.
--
-- C-CRM-04. Two things, in one migration because the second exists only to feed the first: a list of
-- contact details this business will not MARKET to, and the expiring capability a customer redeems to
-- add themselves to it with no login. docs/04 §5 is why the second is not optional — an alphanumeric
-- sender ID cannot receive an SMS, so "reply STOP" is not available to this business at all and the link
-- in the message is the ONLY functional opt-out it has.
--
-- ## A suppression list is not a second blocklist
--
-- 0053's `customer_blocklist` and this table look alike — both key on a normalised contact detail, both
-- treat removal as a record rather than a DELETE — and they answer different questions at different
-- choke points, so the resemblance is worth spending a paragraph on rather than leaving somebody to
-- discover it:
--
--   - **`customer_blocklist` is "we will not serve this person".** It is consulted by the BOOKING path,
--     before a record is read or created, and a match refuses an appointment. Its entries are the
--     business's decision about a person, taken by a role that holds `customer:blocklist`, and the
--     refusal is byte-identical to a no-availability answer so the list cannot be used as an oracle.
--   - **`suppression` is "we will not MARKET to this person".** It is consulted by the SEND path — at
--     `evaluateGate`'s `isSuppressed` and nowhere else — and a match refuses a promotional message.
--     Most of its entries are the CUSTOMER's decision, or an aggregator's, or a mail provider's; none of
--     them says anything about whether that person may book a treatment.
--
-- Collapsing the two would break in both directions and neither break would be visible. A blocked
-- walk-in who never consented to marketing would appear on a suppression report as somebody who opted
-- out; and, far worse, an unsubscribe would start refusing appointments — a customer who asked to stop
-- receiving offers would be told there is no availability, for ever, and the only evidence would be a
-- booking that quietly never happens.
--
-- ## Nothing here holds a phone number or an address
--
-- `suppression.key_hmac` is the lower-case hex of HMAC-SHA256 over the NORMALISED recipient under a
-- server-side pepper (`SUPPRESSION_PEPPER`), and `suppression_key_is_hmac_hex` is what makes "no
-- plaintext" a fact the database keeps rather than a promise the repository makes. Three things follow:
--
--   1. a database dump does not disclose who has opted out. A plain SHA-256 would: UAE mobile numbers
--      are a space of about ten million per prefix and a laptop enumerates it in seconds, so an
--      unpeppered digest of a phone number is a phone number with extra steps;
--   2. the 64-character constraint refuses every plaintext by LENGTH before anything else. A normalised
--      E.164 number is at most 16 characters and an address contains an `@`, which is not a hex digit;
--   3. the pepper is deliberately NOT in the database. A pepper stored beside the digests it peppers is
--      a pepper that adds nothing to a dump, which is the one attack it exists to answer.
--
-- `pepper_version` is the label of the pepper a row was keyed under, never the pepper — exactly what
-- `google_connection.refresh_token_kid` does for a KEK. It is here so a rotation is a possible operation
-- rather than a data loss: a row keyed under a retired pepper is still matchable while
-- `SUPPRESSION_PEPPER_PREVIOUS` is retained, and `build/secret-inventory.json` states what the rotation
-- can and cannot recover.
--
-- ## The KEY is the hashed contact detail, and NOT the contact id
--
-- The same decision 0053 made for the blocklist and for the same reason, which is also the answer to the
-- question C-CRM-03's NOTE (4) asks this unit to settle. A suppression keyed on `customer_id` would be
-- bypassed by a second record for one person — and in this direction the bypass is not a refused booking
-- but a promotional SMS to somebody who opted out, which is the TDRA exposure the whole area exists to
-- remove. `contact_customer_id` is kept beside the key, nullable and with NO foreign key, purely so a
-- report can say which record an entry is about; nothing matches on it.
--
-- So C-CRM-05's merge does NOT have to re-point this table at all, and that is a different answer from
-- `consent`'s rather than the same one. A merge unions two contacts' consent logs because a consent row
-- names a contact; it unions nothing here, because a suppression row names a contact DETAIL and both
-- details survive the merge with their suppressions attached. What the merge does owe this table is the
-- `contact_customer_id` back-reference on the surviving record, and that is an INSERT of a new row for
-- the same key — never an UPDATE, for the reason the triggers below give.
--
-- ## Append-only, and an unsuppression is a new row
--
-- `suppression` revokes UPDATE and DELETE with BEFORE triggers that RAISE (ZQ001), for every role
-- including the owner. Removing somebody from the list is a row with `kind = 'unsuppressed'` carrying
-- its own actor and reason, and the suppressing row is left byte-identical. The reason is the reason
-- 0056 gives for `consent`: the evidence that somebody asked not to be marketed to is the only defence
-- this business has if they later complain, and a column that can be cleared is a column an UPDATE can
-- un-clear.

begin;

-- ---------------------------------------------------------------------------------------------
-- The vocabularies
-- ---------------------------------------------------------------------------------------------
-- Postgres ENUMS here, and TABLES in 0053 and 0056, and the contrast is deliberate rather than
-- inconsistent. `consent_purpose` and `customer_lifecycle_state` are this build's GUESS at a business
-- vocabulary, so every label needs `is_provisional`, an OPEN-QUESTIONS id and a note, and an enum label
-- has nowhere to put one (brief rule 15). These five sources are not a guess about the business: each
-- one names a MECHANISM that already exists in this system or outside it — a manager typing, a customer
-- complaining, a mail provider rejecting, the national register, the preference centre — and the set is
-- closed because a sixth would be a new mechanism and therefore new code. An enum is also the stronger
-- instrument where the value decides nothing but must never be arbitrary: there is no foreign key to
-- forget and no vocabulary row a seed can fail to write.
create type suppression_source as enum (
  'manual',
  'complaint',
  'hard_bounce',
  'dnc_register',
  'preference_centre'
);

comment on type suppression_source is
  'Where a suppression came from. An ENUM and not a vocabulary table, unlike consent_purpose: each '
  'label names a mechanism rather than a business assumption, so none of them needs is_provisional or an '
  'OPEN-QUESTIONS id. dnc_register is the national do-not-call register, treated as binding on this '
  'business as well as on the aggregator - the stricter of the two readings, recorded as Y9-dnc-register.';

create type suppression_kind as enum ('suppressed', 'unsuppressed');

comment on type suppression_kind is
  'The two kinds of record, and there are only two. "Never suppressed" is the ABSENCE of a row and is '
  'never stored, exactly as consent_kind treats "never asked": a row saying nothing happened is a row a '
  'later reader treats as a decision.';

-- ---------------------------------------------------------------------------------------------
-- The suppression list
-- ---------------------------------------------------------------------------------------------

create table suppression (
  id                  uuid               primary key default uuid_generate_v7(),
  -- The two kinds 0053's blocklist uses, spelled the same way and checked the same way. A CHECK rather
  -- than an enum here, in a migration that creates two enums, because these labels are SHARED with
  -- `customer_blocklist.key_kind` and a second type for one vocabulary is how the two lists come to
  -- disagree about what a key is.
  key_kind            text               not null check (key_kind in ('phone', 'email')),
  -- HMAC-SHA256 of the NORMALISED recipient under the server-side pepper, lower-case hex. Never the
  -- recipient. See the header: the 64-hex shape is what refuses a plaintext by length and by alphabet.
  key_hmac            text               not null
                        constraint suppression_key_is_hmac_hex
                          check (key_hmac ~ '^[a-f0-9]{64}$'),
  -- The LABEL of the pepper this row was keyed under. Never the pepper, the same way
  -- google_connection.refresh_token_kid holds a KEK version and never a KEK.
  pepper_version      text               not null
                        constraint suppression_pepper_version_is_stated
                          check (btrim(pepper_version) <> '' and length(pepper_version) <= 64),
  kind                suppression_kind   not null,
  source              suppression_source not null,
  -- Mandatory and not a placeholder, for 0053's reason: a suppression with no stated reason cannot be
  -- reviewed, and `is_placeholder_text` (0026) refuses 'tbc', 'pending' and a blank.
  reason              text               not null
                        constraint suppression_reason_is_stated
                          check (not is_placeholder_text(reason) and length(reason) <= 500),
  -- Who. The same trio `consent` records, and for the same reason: PDPL asks who decided and when, and
  -- a record missing either cannot answer the question it exists for. Never a person's name (ADR 0020).
  actor_kind          text               not null
                        check (actor_kind in ('customer', 'staff', 'system')),
  actor_label         text               not null
                        constraint suppression_actor_is_stated
                          check (not is_placeholder_text(actor_label) and length(actor_label) <= 200),
  -- When the decision was made. Supplied by the caller's clock and NOT defaulted, for the reason 0056
  -- gives for consent.recorded_at: every ordering and window assertion in this area is made under a
  -- frozen clock.
  recorded_at         timestamptz        not null,
  -- The record this entry is ABOUT, when one is known. NEVER what the match runs on, and deliberately
  -- NOT a foreign key: see the header for the keying argument, and 0056's for why an append-only log
  -- cannot reference a mutable parent. A foreign key here would also make `delete from customer` and
  -- `truncate customer` raise for the four integration files that clear that table.
  contact_customer_id uuid,
  -- When the ROW landed, as distinct from when the decision was made. Two facts, both real.
  created_at          timestamptz        not null default now(),
  -- A complaint and a hard bounce are EVENTS. They happened, and they cannot un-happen, so neither can
  -- be the source of an unsuppression: a bounce that stopped bouncing is a new deliverability fact and
  -- somebody has to take responsibility for acting on it. The three that remain are the ones with a
  -- decision behind them - a member of staff, the customer themselves, or the register being re-read.
  constraint suppression_unsuppression_has_a_decision_behind_it
    check (kind <> 'unsuppressed'
           or source in ('manual', 'preference_centre', 'dnc_register')),
  -- A customer can only ever speak for themselves. A `preference_centre` row attributed to staff or to
  -- the system would be a withdrawal nobody made, recorded as though somebody had.
  constraint suppression_preference_centre_is_the_customer
    check (source <> 'preference_centre' or actor_kind = 'customer')
);

comment on table suppression is
  'Contact details this business will not MARKET to, keyed on HMAC-SHA256 of the normalised recipient '
  'under a server-side pepper - never on a plaintext number or address, and never on a customer id. '
  'Append-only: UPDATE and DELETE raise, for every role including the owner. Removing somebody is a NEW '
  'row with kind = unsuppressed. Distinct from customer_blocklist, which is "we will not SERVE this '
  'person" and is consulted by the booking path; this one is consulted at evaluateGate and nowhere else.';
comment on column suppression.key_hmac is
  'Lower-case hex of HMAC-SHA256(normalised recipient, SUPPRESSION_PEPPER). A plain digest would not do: '
  'the UAE mobile space is small enough to enumerate, so an unpeppered hash of a phone number is a phone '
  'number with extra steps. The 64-hex CHECK refuses every plaintext by length and by alphabet.';
comment on column suppression.pepper_version is
  'The label of the pepper this row was keyed under, never the pepper. Present so a rotation is an '
  'operation rather than a data loss: a row under a retired pepper stays matchable while '
  'SUPPRESSION_PEPPER_PREVIOUS is retained. build/secret-inventory.json states what it cannot recover.';
comment on column suppression.contact_customer_id is
  'Which record the entry is about, when one is known. Never matched on, and not a foreign key: the '
  'match is on the hashed DETAIL so a second record for one person cannot walk past the list, and a '
  'cascade here would fire the refusal trigger and make `delete from customer` raise for every caller.';

-- One row per (key, kind, instant). The idempotence 0056's `consent_one_record_per_instant` buys, and
-- `kind` is IN the key for the same reason: without it a suppression and an unsuppression recorded at
-- one instant would collide and `on conflict do nothing` would discard one of them in silence. With it
-- the pair is stored, the log is ambiguous, and the resolver fails closed to SUPPRESSED - which is the
-- safe direction here, and the opposite of the direction `consent` fails in for the same ambiguity.
create unique index suppression_one_record_per_instant
  on suppression (key_kind, key_hmac, kind, recorded_at);

-- The send path's own read: every row for a set of keys, newest first.
create index suppression_key_idx on suppression (key_hmac, key_kind, recorded_at desc);

create index suppression_contact_idx on suppression (contact_customer_id)
  where contact_customer_id is not null;

-- A report's read. `source` first because "how many opted out through the preference centre this month"
-- is the question a marketing report actually asks.
create index suppression_source_idx on suppression (source, recorded_at desc);

create function refuse_suppression_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    'suppression is append-only; % is refused. Removing somebody from the list is a NEW row with '
    'kind = unsuppressed carrying its own actor and reason. Clearing a suppression would leave the fact '
    'that somebody asked not to be marketed to as a value rather than as a record, and that record is '
    'the only defence this business has if they complain.',
    tg_op
    using errcode = 'ZQ001';
end $$;

comment on function refuse_suppression_change() is
  'Raises ZQ001 for EVERY role including the owner: privileges cover the application role, and a '
  'migration or a psql session does not connect as the application role. A trigger and not `create rule '
  '... do instead nothing`, because a rule reports success and the caller goes on believing the edit '
  'happened.';

create trigger suppression_no_update before update on suppression
  for each row execute function refuse_suppression_change();
create trigger suppression_no_delete before delete on suppression
  for each row execute function refuse_suppression_change();

-- ---------------------------------------------------------------------------------------------
-- The opt-out grant
-- ---------------------------------------------------------------------------------------------
-- A stored, expiring, revocable grant whose sha256 alone is kept — the shape 0060 established for
-- `obligation_evidence_grant`, followed here rather than re-argued, and the acceptance criterion's word
-- "signed" answered with a stored capability for the three reasons that unit records:
--
--   1. **No new signing secret.** An HMAC over the URL would be an eighth entry in
--      `build/secret-inventory.json` with a rotation section somebody has to follow at 02:00. This unit
--      already adds one secret it cannot avoid — the suppression pepper, without which the digests are
--      reversible — and a second one for a link is a poor trade.
--   2. **Revocable.** A link minted for the wrong contact is a DELETE. A signature is valid until it
--      expires and the only way to withdraw one is to rotate the key and break every other link.
--   3. **It records that the link existed.** "Which message carried the link this opt-out arrived
--      through" is a question a TDRA complaint asks, and the row answers it; a signature answers
--      nothing about itself.
--
-- The one difference from 0060 is the TTL and it is two orders of magnitude: an evidence link lives
-- fifteen minutes because somebody is looking at a screen, and this one lives THIRTY DAYS because the
-- person who needs it is reading an SMS they were sent three weeks ago. A link that has expired by the
-- time somebody is annoyed enough to use it is an opt-out this business does not have.
create table optout_grant (
  id                  uuid        primary key default uuid_generate_v7(),
  -- The sha256 of the token, hex, never the token. A grant table that held its own tokens would be a
  -- table that opts anybody out of anything — the reason repositories/otp.ts stores a digest of a
  -- six-digit code rather than the code.
  token_sha256        text        not null unique
                        constraint optout_grant_token_shape
                          check (token_sha256 ~ '^[a-f0-9]{64}$'),
  -- Who the link is for. A plain uuid with NO foreign key, for 0056's reason and one more: a foreign key
  -- to `customer` would make `truncate customer` raise in every integration file that clears the table
  -- without naming this one.
  contact_customer_id uuid        not null,
  -- SINGLE PURPOSE, and a column rather than an implied constant although only one value is legal
  -- today. The realistic second purpose is near — an unsubscribe-confirmation link, a data-export link
  -- under PDPL — and a token whose purpose was implicit would be valid for both of them retroactively,
  -- which is how a link that lets somebody stop a text becomes a link that hands over their record.
  purpose             text        not null
                        constraint optout_grant_purpose_known
                          check (purpose in ('preference_centre')),
  -- Which message carried the link. `message_channel` since 0014, so there is no second list of channel
  -- names anywhere in the send path.
  channel             message_channel not null,
  -- Supplied, never defaulted, for the reason recorded_at is: every expiry assertion here is made under
  -- a frozen clock.
  issued_at           timestamptz not null,
  expires_at          timestamptz not null,
  created_at          timestamptz not null default now(),
  -- A grant that has already expired when it is written is a link that reads as simply broken.
  constraint optout_grant_expires_after_issue check (expires_at > issued_at)
);

comment on table optout_grant is
  'An expiring capability to reach the preference centre for ONE contact with no login. Only the '
  'sha256 of the token is stored. A stored grant rather than an HMAC over the URL: no second signing '
  'secret, revocable by DELETE, and the row records that the link existed. Revocation is a DELETE and '
  'the audit_event for the minting survives it, so this table is deliberately NOT append-only.';
comment on column optout_grant.expires_at is
  'Thirty days after issue. Two orders of magnitude longer than obligation_evidence_grant''s fifteen '
  'minutes, because the person who needs this link is reading a message they were sent three weeks ago '
  'and a link that has expired by then is an opt-out this business does not have.';

create index optout_grant_contact_idx on optout_grant (contact_customer_id, expires_at desc);
-- Expiry sweeps and "how many live links are out there" both read this way.
create index optout_grant_expiry_idx on optout_grant (expires_at);

-- ---------------------------------------------------------------------------------------------
-- The verification attempt log, which is the rate limit
-- ---------------------------------------------------------------------------------------------
-- A 256-bit token is not guessable, so this is not an anti-guessing measure and saying so matters: what
-- it stops is a FLOOD. Every verification is a query and a write, the endpoint is unauthenticated by
-- construction, and a script pointed at it is a denial of service against the one opt-out path this
-- business has. Ten an IP a minute is generous for a person following a link and refuses a script.
--
-- Counted over rows rather than held in memory, for the reason `otp_challenge` counts its own: the
-- application runs in more than one container and a per-process counter is a limit per container, which
-- is the limit multiplied by however many are running.
create table optout_verification_attempt (
  id           uuid        primary key default uuid_generate_v7(),
  -- NOT NULL, unlike `otp_challenge.request_ip`, and the difference is the point. The OTP endpoint has a
  -- per-NUMBER limit that still binds when the edge supplies no address; this endpoint has one dimension
  -- and nothing else to fall back on, so an unattributable request cannot be allowed to bypass the only
  -- defence there is. The route refuses such a request by name instead.
  request_ip   inet        not null,
  -- Supplied from the caller's clock, never now(): the window assertions are made under a frozen one.
  attempted_at timestamptz not null,
  -- WHICH outcome, so a report can tell a flood of unknown tokens from a flood of valid ones. Pinned to
  -- the refusal vocabulary in @berelax/core by packages/fixtures/src/suppression.itest.ts, the way
  -- consent_purpose.is_send_gating is pinned to SEND_GATING_CONSENT_PURPOSES.
  outcome      text        not null
                 constraint optout_verification_attempt_outcome_known
                   check (outcome in ('granted', 'token_absent', 'token_malformed', 'token_unknown',
                                      'token_expired', 'token_not_for_this_contact',
                                      'token_not_for_this_purpose', 'rate_limited'))
);

comment on table optout_verification_attempt is
  'One row per opt-out token verification, which IS the rate limit: ten per IP per minute, counted in '
  'SQL because a per-process counter is a limit per container. Not append-only - DELETE stays granted so '
  'the window can be pruned, and the table is only ever READ over the last minute.';

create index optout_verification_attempt_ip_idx
  on optout_verification_attempt (request_ip, attempted_at desc);

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009's `alter default privileges` grants berelax_app select/insert/update/delete on tables created in
-- public afterwards, so these revokes are load-bearing rather than decorative — and stated explicitly
-- because a managed database restored from a dump does not necessarily carry the same defaults. The
-- triggers above raise for every role; these make the application role unable to try.
revoke update, delete on suppression from berelax_app;
-- DELETE stays granted on `optout_grant`, and that IS the revocation path: a link that should never have
-- been minted is removed, and the audit row for the minting remains because audit_event is append-only.
revoke truncate on optout_grant from berelax_app;

-- `berelax_readonly` may NOT read the suppression list, which is the opposite of the decision 0056 made
-- for `consent` one migration earlier, and the difference is what the two tables disclose. A consent row
-- names a contact by uuid and carries no contact detail, so reading it discloses nobody. A suppression
-- row is a set of hashed contact details, and a reader who can also compute the HMAC — that is, anybody
-- who has the pepper — can test any number they like against it. "Has this person unsubscribed" is not a
-- question a reporting connection needs to answer about a named individual, and the aggregate ones are
-- answered through the application. 0009 grants `berelax_readonly` select on every future public table
-- through `alter default privileges`, so these three revokes are what make that not true here — the same
-- reason 0053 states for the blocklist and the do-not-pair flag.
revoke select on suppression from berelax_readonly;
revoke select on optout_grant from berelax_readonly;
revoke select on optout_verification_attempt from berelax_readonly;

commit;
