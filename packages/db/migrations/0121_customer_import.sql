-- 0121_customer_import.sql — H-MIG-04
--
-- The reconstructed contact list: what one line of it became, and the consent floor as a property of the
-- database rather than of an importer.
--
-- ============================================================================================
-- The sentence this whole file follows from
-- ============================================================================================
--
-- **A list rebuilt from WhatsApp history and phone contacts is not consent.** docs/11 §7 states it and
-- states the consequence without exception: the contacts import with `marketing_consent = false`,
-- transactional messaging is permitted, and consent is captured at the next booking with the wording
-- version shown. docs/04 §5 is why it matters in money: TDRA requires the opt-in proof to exist BEFORE a
-- promotional send, penalties are reported as high as AED 400,000 per message, and the practical sanction
-- is sender-ID suspension — which, with two registered identities (ADR 0016), is every campaign this
-- business can run.
--
-- There is no `marketing_consent` column anywhere in this schema and this migration does not add one.
-- That is the first decision in the file. 0056 made consent an APPEND-ONLY LOG rather than a flag, for
-- reasons its own header sets out, and in that model "no marketing consent" is **the absence of a row**:
-- not a `false`, and specifically not a `withdrawn` row either, because nobody withdrew anything and
-- nobody was ever asked. A boolean here would be a second statement of a fact the log already holds, and
-- the first time the two disagreed the flag would be the one a send path read.
--
-- So the floor is not a field to fill in. It is what the import must refuse to assume, and the only
-- enforceable statement of it is a REFUSAL — which is ZY271 below.
--
-- ============================================================================================
-- ZY271: an import cannot produce an opt-in, and the door it deliberately leaves
-- ============================================================================================
--
-- `consent.capture_source` has included `'import'` since 0056, and `@berelax/shared`'s own note on that
-- value says what it is for: *"the reconstructed-contacts path (`Y8-customers`), which imports with no
-- promotional consent at all"*. Nothing enforced the second half of that sentence, and H-MIG-04's
-- acceptance asks for an importer with "no flag able to change this" — a claim about code, which a later
-- unit, a job, a one-off `psql` session or a corrected re-import can each falsify without touching the
-- importer at all.
--
-- What makes an imported grant false is not that an importer wrote it. It is that `consent_wording` holds
-- only the versions THIS system published and showed, 0056 requires a grant to name one
-- (`consent_grant_carries_its_wording`), and a contact rebuilt from a chat thread was never shown any of
-- them. A grant captured at `import` is therefore a record claiming words were read that this system
-- never displayed — which is precisely the artefact TDRA asks for and precisely the one that would not
-- survive being asked about.
--
-- The rule is narrowed to the purposes that gate a SEND, read from `consent_purpose.is_send_gating`
-- rather than restated here, so it follows the vocabulary 0056 owns instead of becoming a second list of
-- which purposes those are. `clinical_processing` and `photography` are left alone deliberately: they are
-- lawful bases for holding a record rather than permission to message anybody (0056 says so), and an
-- import of a signed photography release is a different subject that this unit has no business refusing.
--
-- **The door it leaves, named rather than left to be discovered.** docs/11 §7 contemplates "a one-time
-- opt-in campaign only if your lawyer confirms a lawful basis for it", and a lawfully collected external
-- opt-in list would arrive through an import. Under this rule that import needs a migration first: publish
-- the external statement as a new `consent_wording` version and drop or narrow this trigger. That is the
-- intended cost. A mass import of marketing consent should be a migration somebody has to argue for, not
-- an INSERT — and the alternative reading, where the schema quietly permits it and only an importer's
-- options type stands in the way, is the arrangement this unit exists to replace.
--
-- ============================================================================================
-- Y9-import-ledger, answered: the ledger stages a KEYED DIGEST and never the number
-- ============================================================================================
--
-- H-MIG-01 left this open and named this unit as the one that has to answer it before anything stages a
-- phone number. The staging ledger keeps `import_row.payload` for ever — append-only by ZY192, with no
-- role holding DELETE anywhere in `import_staging` — so C-CRM-10's erasure engine cannot reach it. Worse
-- than cannot: `payload` is `jsonb`, and none of C-CRM-10's five catalogue probes can see inside one. A
-- phone number in there is not retained against an obligation, it is **invisible**.
--
-- The provisional position was "stage a minimised payload rather than delete evidence later". This unit
-- takes it further, in the one direction that needs no migration to the ledger: for a contact list the
-- payload IS the identifier, so minimising the fields is not enough and the number itself does not go in.
-- What is staged is `HMAC-SHA256(value, SUPPRESSION_PEPPER)` — the instrument 0064 already uses for the
-- suppression list, under its own key kind so the two key spaces stay disjoint — and the plaintext lives
-- in exactly one place, `customer.phone_e164`, which the erasure engine pseudonymises today.
--
-- Three consequences, all intended:
--
--   1. **An erasure is complete again.** After it, the number exists nowhere: the customer row is
--      pseudonymised and the ledger never had it. The ledger keeps the evidence an import happened —
--      the file, the line, the content hash, and a digest that was never reversible — which is what
--      C-CRM-10 already decided a hashed key may be (its own acceptance keeps `suppression.key_hmac`
--      through an erasure on purpose).
--   2. **A digest needs the pepper, so a dump is worthless.** An unpeppered hash of a UAE mobile is a
--      phone number with extra steps — 0064's own argument, and the UAE mobile space is small enough to
--      enumerate exhaustively. `pepper_version` records the LABEL of the pepper a row was keyed under,
--      never the pepper, exactly as `suppression.pepper_version` does.
--   3. **A pepper rotation costs idempotence, not data.** The framework decides "already imported" on the
--      content hash of the payload, so a re-import after a rotation stages different digests and applies
--      every line again — landing as `matched` against the customers that already exist, because the
--      unique index on `customer.phone_e164` is the real dedup and the digest is only the forecast. No
--      duplicate customer and no consent either way. `customer-import.itest.ts` asserts that directly.
--
-- ============================================================================================
-- Why `imported_contact` exists at all, and why it holds so little
-- ============================================================================================
--
-- One row per staged line, always — the arrangement 0119 gives its reason for: the reconstruction record
-- is the entity that ALWAYS exists, so every staged row has exactly one provenance target even when no
-- customer was created. Three things make that necessary rather than tidy:
--
--   * `import_provenance_one_per_target` is unique on (schema, table, id), so the second line naming a
--     number cannot record provenance against the customer the first line created;
--   * ZY196 refuses a COMMIT of an applied row with no provenance at all, so a duplicate line cannot
--     simply write nothing;
--   * a line whose number cannot be read has to be QUARANTINED rather than guessed, and a quarantine is
--     only useful if it resolves to the line it is about.
--
-- It holds a digest, a pepper label, an outcome and a reason, and that is the whole table. In particular
-- it holds **no copy of the number**, for the reason above, and **no customer id**, for the reason 0119
-- gives for `imported_package_sale`: a customer MERGE re-points the columns `merge-participants.ts`
-- registers, and a second copy of the holder here would be the copy the merge did not follow. The link
-- from a customer to the lines it came from is the digest, recomputed from `customer.phone_e164` — which
-- also means an ERASED customer stops resolving to its import, which is correct rather than unfortunate.
--
-- And it holds no copy of the quarantined cell. A quarantine record is a REASON and a REFERENCE: the cell
-- is in the file the operator already has, at the line `import_staging.entity_provenance` names, and a
-- copy here would re-create the unerasable estate this whole decision is about.

begin;

-- ---------------------------------------------------------------------------------------------
-- What one line of a reconstructed contact list became
-- ---------------------------------------------------------------------------------------------

create table imported_contact (
  id                      uuid        primary key default uuid_generate_v7(),
  /*
    The keyed digest of what identifies this line. NEVER the number.

    `HMAC-SHA256(json(value), <pepper>)`, lower-case hex, computed by `suppressionKey` in
    `packages/db/src/repositories/suppression.ts` — one implementation of one keyed digest, shared rather
    than re-spelled. Which value was keyed follows from `outcome`, so it is one fact and not two: for
    `created` and `matched` it is the canonical E.164 number under the key kind
    `import_contact_phone`, and for `quarantined` it is the cell exactly as the file held it, under
    `import_contact_cell`. The two kinds keep the key spaces disjoint, which is what the kind argument is
    for (0064) — a cell that happens to read like a number must not key the same as a number.

    The column is named `_hmac` on purpose. `CREDENTIAL_COLUMN_PATTERN` in
    `packages/db/src/privacy-coverage.ts` matches it, so C-CRM-10's fourth probe enumerates this column
    and the erasure engine REFUSES to run until `rights-policy.ts` classifies it. A column called
    `phone_digest` would have been invisible to all five probes, which is the accident Y9-import-ledger is
    about — so the name is the thing that makes the decision reviewable.
  */
  contact_hmac            text        not null
                            constraint imported_contact_hmac_is_keyed
                              check (contact_hmac ~ '^[a-f0-9]{64}$'),
  -- The LABEL of the pepper this row was keyed under, never the pepper — `suppression.pepper_version`'s
  -- arrangement and its reason: a digest that cannot be attributed to the pepper that keyed it cannot be
  -- recomputed after a rotation, and a rotation is then a data loss rather than an operation.
  pepper_version          text        not null
                            constraint imported_contact_pepper_version_is_stated
                              check (btrim(pepper_version) <> '' and length(pepper_version) <= 64),
  /*
    What happened to this line, and there are exactly three answers.

    `created` — this line is why a `customer` row exists. `matched` — the number already resolved to a
    customer, whether an earlier line of this same file put it there, an earlier import did, or the person
    has walked in and booked since; one answer rather than three because the operation is the same and the
    difference is a fact about the database's history, not about the file. `quarantined` — the cell could
    not be read as a UAE number and nothing was guessed.

    A CHECK and not a vocabulary table: these three are a property of this importer's code, not a label
    anybody can configure, and ZY273 holds the column to what the import actually wrote.
  */
  outcome                 text        not null
                            check (outcome in ('created', 'matched', 'quarantined')),
  -- Why the cell could not be read, in `E164_IDENTITY_REJECTIONS`' words (`empty`, `not_digits`,
  -- `unsupported_country`, `wrong_length`). Free text and not a CHECK listing them, for the reason
  -- H-MIG-01 left `import_row.outcome_detail` free: the vocabulary is a TypeScript constant in the
  -- importer, and a list here would be a second one to disagree with it.
  quarantine_reason       text        constraint imported_contact_reason_is_stated
                            check (quarantine_reason is null
                                   or (btrim(quarantine_reason) <> ''
                                       and length(quarantine_reason) <= 64)),
  /*
    The source row asserted a marketing consent, and it was DISCARDED.

    It confers nothing and it is not a consent record — a consent record is a row in `consent` and this
    import writes none. The column exists because the claim is EVIDENCE: the list this business was handed
    said these contacts had opted in, and a reconstruction that silently dropped that assertion would
    leave nothing to show it had been considered and refused. Counted in the import report, so the size of
    the claim is visible before anybody decides what to do about it.

    Named for the discard rather than for the claim (`consent_claim_discarded`, not `claimed_consent`) so
    that no reader of this row can take it for permission.
  */
  consent_claim_discarded boolean     not null,
  created_at              timestamptz not null default now(),
  -- A reason is present exactly when the line was quarantined. A quarantined line with no reason is the
  -- row somebody has to guess at months later, and a reason on an imported line is a record whose state
  -- and story disagree.
  constraint imported_contact_reason_iff_quarantined
    check ((outcome = 'quarantined') = (quarantine_reason is not null))
);

comment on table imported_contact is
  'What one line of a reconstructed contact list became (H-MIG-04). Append-only: UPDATE and DELETE '
  'raise, because this is the evidence of what an import did. It holds a keyed digest and never the '
  'number, which is this unit''s answer to Y9-import-ledger, and no customer id, which is 0119''s reason '
  'about a merge re-pointing the one copy that exists.';
comment on column imported_contact.contact_hmac is
  'HMAC-SHA256 of the canonical number, or of the cell as typed for a quarantined line, under the '
  'suppression pepper. Never a number and never reversible without the pepper. Named _hmac so C-CRM-10''s '
  'credential probe enumerates it and an erasure cannot run until it is classified.';
comment on column imported_contact.outcome is
  'created | matched | quarantined. ZY273 holds it equal to what the import actually wrote, by walking '
  'this row''s own provenance to the staged row and asking whether a customer came from it.';
comment on column imported_contact.consent_claim_discarded is
  'The source list claimed a marketing consent for this line and it was discarded. NOT a consent record '
  'and not permission: a consent record is a row in `consent`, and this import writes none (ZY271).';

-- "Which lines of which imports is this number from?" — the one read, from a digest recomputed off
-- `customer.phone_e164`. Not unique, deliberately: two source files legitimately hold the same number (a
-- WhatsApp export and a phone-contacts export are the same people), and a re-import after a pepper
-- rotation stages it again. The dedup that MATTERS is the unique index on `customer.phone_e164`.
create index imported_contact_hmac_idx on imported_contact (contact_hmac);
create index imported_contact_quarantined_idx on imported_contact (created_at)
  where outcome = 'quarantined';

-- ---------------------------------------------------------------------------------------------
-- ZY271 — an import may not produce a promotional opt-in
-- ---------------------------------------------------------------------------------------------
--
-- See the header. The purposes are read from `consent_purpose.is_send_gating` so this rule follows 0056's
-- vocabulary rather than restating it.
--
-- A WITHDRAWAL captured at `import` is permitted, and that asymmetry is deliberate: it only ever
-- restricts sending, 0056 accepts a withdrawal with no wording version for the same reason ("a system
-- that refused to record that until an operator produced a wording version would be easier to opt into
-- than out of"), and a list that arrives marked "these people asked us to stop" must be importable
-- without argument.
create or replace function refuse_imported_promotional_consent()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from consent_purpose p where p.purpose = new.purpose and p.is_send_gating
  ) then
    return new;
  end if;

  raise exception
    'ImportIsNotAnOptIn: a consent record for "%" may not be GRANTED with capture_source = ''import''. '
    'consent_wording holds only the statements this system published and showed, and a contact '
    'reconstructed from a contact list or a chat thread was shown none of them — so the row would claim '
    'words were read that nobody displayed, which is the one artefact a promotional send has to be able '
    'to produce. Import the contact with no consent and capture it at the next booking. A withdrawal is '
    'accepted here; a lawfully collected external opt-in needs its wording published first.',
    new.purpose
    using errcode = 'ZY271';
end $$;

comment on function refuse_imported_promotional_consent() is
  'Raises ZY271. The consent floor as a property of the database: an import may not write a GRANTED '
  'send-gating consent row, whatever wrote it. docs/11 SS7 states the rule without exception and an '
  'importer''s options type is not where it can be kept.';

-- The filter is the WHEN clause and the vocabulary read is the body, so the cheap half costs nothing on
-- every ordinary capture. It fires BEFORE `consent_wording_hash_matches` because PostgreSQL runs BEFORE
-- triggers in alphabetical order by name and `consent_i…` sorts before `consent_w…` — deliberate: "this
-- is not an opt-in at all" is the more useful of the two answers, and the hash mismatch would otherwise
-- send somebody looking for a republished wording.
create trigger consent_import_is_not_an_opt_in
  before insert on consent
  for each row when (new.kind = 'granted' and new.capture_source = 'import')
  execute function refuse_imported_promotional_consent();

-- ---------------------------------------------------------------------------------------------
-- ZY272 — the record of what an import did is append-only
-- ---------------------------------------------------------------------------------------------
--
-- ADR 0008's shape and 0119's ZY255 reason: this row is the evidence of what the import decided about one
-- line, and evidence that can be edited afterwards is not evidence. A correction is a new import.
create or replace function refuse_imported_contact_change()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'ImportedContactImmutable: the imported-contact record % (outcome %) may not be % — it is the record '
    'of what the import did with one line of the list, and a correction is a new import against the '
    'corrected file',
    old.id, old.outcome, lower(tg_op)
    using errcode = 'ZY272';
end $$;

comment on function refuse_imported_contact_change() is
  'Raises ZY272 for both events. One function and two triggers, because the half-written pair — one '
  'trigger copied for the other event with the word not changed — is where this defect always hides.';

create trigger imported_contact_no_update before update on imported_contact
  for each row execute function refuse_imported_contact_change();
create trigger imported_contact_no_delete before delete on imported_contact
  for each row execute function refuse_imported_contact_change();

-- ---------------------------------------------------------------------------------------------
-- ZY273 — an imported contact's outcome is what the import actually wrote, checked at COMMIT
-- ---------------------------------------------------------------------------------------------
--
-- The count every acceptance line in this unit is read off. "A 2,000-row fixture with 12% planted
-- duplicates yields the expected distinct count" is answered by counting `outcome = 'created'`, and a
-- row that SAYS `created` with no customer behind it would make that count a claim about nothing —
-- reported as a successful import of 1,760 people who are not in the database. Nothing else would notice:
-- ZY196 is satisfied, because this row itself carries provenance.
--
-- So the outcome is held to the facts, by walking from this row through
-- `import_staging.entity_provenance` to the staged row that produced it and asking whether a `customer`
-- row came from the same line. Both directions are refused, and the second matters as much as the first:
-- a `matched` or `quarantined` row whose line DID create a customer is a customer nothing accounts for.
--
-- DEFERRED, for ZY196's reason. The entity insert, the provenance rows and the customer insert are
-- several statements and their order is the importer's business; the claim is about what may be
-- COMMITTED. A dry run never commits, so it never fires one — which is why `runImport` issues
-- `set constraints all immediate` before rolling back, and why a gate probe of this rule has to do the
-- same.
--
-- It also refuses a row with NO provenance at all, which is this table's half of ZY196: an
-- imported-contact record that resolves to no file and no line is not evidence of anything, and the
-- measured half (`import_staging.unprovenanced_row_ids`) reports it after the fact rather than refusing
-- it.
create or replace function assert_imported_contact_outcome()
returns trigger
language plpgsql
as $$
declare
  v_row_id   uuid;
  v_customer integer;
begin
  select p.import_row_id into v_row_id
    from import_staging.import_provenance p
   where p.target_schema = 'public'
     and p.target_table = 'imported_contact'
     and p.target_id = new.id::text;

  if v_row_id is null then
    raise exception
      'ImportedContactUnprovenanced: imported-contact record % names no staged source row, so it is '
      'evidence of nothing — there is no file and no line it can be resolved to',
      new.id
      using errcode = 'ZY273';
  end if;

  select count(*) into v_customer
    from import_staging.import_provenance p
   where p.import_row_id = v_row_id
     and p.target_schema = 'public'
     and p.target_table = 'customer';

  if new.outcome = 'created' and v_customer <> 1 then
    raise exception
      'ImportedContactOutcomeDisagrees: imported-contact record % says a customer was CREATED and its '
      'staged row % has provenance for % customer row(s). The distinct-customer count this import '
      'reports is read off this column, so a created record with nothing behind it is a report of people '
      'who are not in the database',
      new.id, v_row_id, v_customer
      using errcode = 'ZY273';
  end if;

  if new.outcome <> 'created' and v_customer <> 0 then
    raise exception
      'ImportedContactOutcomeDisagrees: imported-contact record % says % and its staged row % created a '
      'customer anyway. A customer nothing accounts for is the half of this rule that the count would '
      'never show',
      new.id, new.outcome, v_row_id
      using errcode = 'ZY273';
  end if;

  return null;
end $$;

comment on function assert_imported_contact_outcome() is
  'Raises ZY273 at COMMIT. Walks an imported-contact record''s own provenance to the staged row and holds '
  'its outcome equal to whether that row produced a customer — in both directions, because an '
  'unaccounted customer is as bad as a created record with nothing behind it.';

create constraint trigger imported_contact_outcome_matches_the_import
  after insert on imported_contact
  deferrable initially deferred
  for each row execute function assert_imported_contact_outcome();

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
--
-- 0009 granted the application role select, insert, update and delete on every table in `public` AND set
-- default privileges extending that to tables created later, so this table ARRIVED with UPDATE and DELETE
-- already granted. The table-level REVOKE has to come first and cannot be narrowed by a column-list
-- grant; leaving it out cost 0076 a whole run, and 0119 records the same trap.
revoke update, delete, truncate on imported_contact from berelax_app;

-- `berelax_readonly` may NOT read this table, which is 0064's decision about `suppression` and the same
-- argument: the column is a set of hashed contact details, and a reader who can also compute the HMAC —
-- anybody with the pepper — can test any number they like against it. "Was this person on the imported
-- list" is not a question a reporting connection needs to answer about a named individual, and the
-- aggregate ones are answered through the application. 0009's `alter default privileges` grants select on
-- every future public table, so this revoke is what makes that not true here.
revoke select on imported_contact from berelax_readonly;

commit;
