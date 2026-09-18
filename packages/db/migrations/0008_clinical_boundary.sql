-- 0008 — the clinical data boundary.
--
-- Client intake data (contraindications, pregnancy, medication, injuries) is special-category health
-- data. It is isolated here for one concrete, unsentimental reason: UAE Federal Law 2 of 2019 may
-- prohibit storing health data outside the country, DigitalOcean has no UAE region, and the licence
-- classification that decides whether the rule applies is still unconfirmed (OPEN-QUESTIONS Y5).
--
-- So the design goal is REVERSIBILITY. Isolating this now makes relocating the clinical store to a
-- UAE-hosted database about a week of work. Not isolating it would mean migrating the most sensitive
-- table in the system while it is live.
--
-- Four properties make that possible, and each is enforced rather than documented:
--   1. its own schema, so it can be dumped and moved independently
--   2. its own database role, so an application SQL injection cannot read it
--   3. UUID-only references, NO foreign keys crossing the boundary
--   4. envelope-encrypted payloads, so the ciphertext is useless without the key hierarchy
--
-- Point 3 is the one people get wrong. A foreign key from clinical to public makes the two schemas
-- one database forever.

create schema clinical;
comment on schema clinical is
  'Special-category health data. Separate role, envelope-encrypted, no FKs to public. Designed to be '
  'relocatable to a UAE-hosted database without touching the rest of the application.';

-- Versioned intake questionnaires. Consent is tied to the version the client actually saw, so
-- "what did they agree to" is answerable years later.
create table clinical.intake_form_template (
  id            uuid        primary key default public.uuid_generate_v7(),
  version       integer     not null,
  locale        text        not null check (locale in ('en','ar')),
  title         text        not null,
  -- The question set. Structure, not answers — no health data lives here.
  definition    jsonb       not null,
  consent_text  text        not null,
  consent_hash  text        not null,
  is_current    boolean     not null default false,
  created_at    timestamptz not null default now(),
  unique (version, locale)
);

create unique index intake_template_one_current_per_locale
  on clinical.intake_form_template (locale)
  where is_current;

-- The answers. Encrypted at rest with a per-record data key.
create table clinical.intake_submission (
  id                  uuid        primary key default public.uuid_generate_v7(),
  -- UUID reference only. Deliberately NOT a foreign key to public.customer: a FK would weld the
  -- two schemas together and defeat the relocation this boundary exists to enable.
  customer_id         uuid        not null,
  template_id         uuid        not null references clinical.intake_form_template(id),
  -- Envelope encryption: AES-256-GCM ciphertext, the data key wrapped by the KEK, and the KEK
  -- version so a rotation is a background re-wrap rather than a forced re-collection.
  payload_ciphertext  bytea       not null,
  payload_nonce       bytea       not null,
  wrapped_data_key    bytea       not null,
  kek_version         text        not null,
  -- Binds the ciphertext to its row, so a payload cannot be moved between customers.
  aad_fingerprint     text        not null,
  submitted_at        timestamptz not null default now(),
  submitted_via       text        not null check (submitted_via in ('online','in_salon','staff_entry')),
  superseded_at       timestamptz
);

create index intake_submission_customer_idx
  on clinical.intake_submission (customer_id, submitted_at desc);

-- Treatment notes, per appointment. Same encryption, same no-FK rule.
create table clinical.treatment_note (
  id                  uuid        primary key default public.uuid_generate_v7(),
  customer_id         uuid        not null,
  appointment_id      uuid        not null,
  author_employee_id  uuid        not null,
  body_ciphertext     bytea       not null,
  body_nonce          bytea       not null,
  wrapped_data_key    bytea       not null,
  kek_version         text        not null,
  aad_fingerprint     text        not null,
  created_at          timestamptz not null default now(),
  -- Append-only in spirit: a correction is a new note referencing the one it supersedes, because a
  -- clinical record that can be rewritten is worthless as evidence.
  supersedes_id       uuid        references clinical.treatment_note(id)
);

create index treatment_note_customer_idx    on clinical.treatment_note (customer_id, created_at desc);
create index treatment_note_appointment_idx on clinical.treatment_note (appointment_id);

/**
 * The ONLY thing that crosses the boundary.
 *
 * The booking layer needs to know a contraindication EXISTS so it can route or warn. It must never
 * receive the free text. These are booleans, derived when a submission is stored, and they carry no
 * detail — "requires_consultation" tells reception to ask, not what to ask about.
 */
create table clinical.contraindication_flag (
  customer_id           uuid        primary key,
  pregnancy             boolean     not null default false,
  recent_surgery        boolean     not null default false,
  cardiovascular        boolean     not null default false,
  skin_condition        boolean     not null default false,
  requires_consultation boolean     not null default false,
  -- No detail, no free text, no diagnosis. Deliberately.
  updated_at            timestamptz not null default now(),
  source_submission_id  uuid        not null references clinical.intake_submission(id)
);

comment on table clinical.contraindication_flag is
  'The only data permitted to cross the boundary. Booleans only — never free text, never a diagnosis. '
  'A view in the public schema exposes these so the booking layer never touches the clinical schema.';

-- Consent records. Kept beside the data they authorise so a relocation moves both together.
create table clinical.treatment_consent (
  id                uuid        primary key default public.uuid_generate_v7(),
  customer_id       uuid        not null,
  appointment_id    uuid,
  template_id       uuid        not null references clinical.intake_form_template(id),
  consent_hash      text        not null,
  consented_at      timestamptz not null default now(),
  consent_locale    text        not null check (consent_locale in ('en','ar')),
  captured_via      text        not null check (captured_via in ('online','in_salon','staff_witnessed')),
  signature_present boolean     not null default false,
  withdrawn_at      timestamptz
);

create index treatment_consent_customer_idx on clinical.treatment_consent (customer_id, consented_at desc);
