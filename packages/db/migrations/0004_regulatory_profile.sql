-- 0004 — the regulatory profile.
--
-- One unanswered question (is the licence a commercial wellness activity or a healthcare activity?)
-- cascades into permitted public vocabulary, permitted staff titles, clinical record retention,
-- whether erasure can be honoured, and where health data may be hosted. The build must not wait for
-- the answer, so the profile is DATA, versioned, and defaults to the STRICTER combination:
-- wellness vocabulary (conservative copy) plus healthcare-grade retention and isolation.
--
-- Consequence of the default: a late answer leaves the system conservative, never non-compliant.
-- See docs/04 §1 and docs/12 §2.

create type licence_class as enum ('unconfirmed', 'wellness', 'healthcare');

create table regulatory_profile (
  version                   integer     primary key generated always as identity,
  licence_class             licence_class not null default 'unconfirmed',
  emirate                   text        not null default 'Abu Dhabi',

  -- Derived policy. Stored rather than computed so a historical decision can be explained: "we
  -- published that copy because the profile in force said we could".
  clinical_retention_years  smallint    not null default 25,
  financial_retention_years smallint    not null default 5,
  erasure_overrides_retention boolean   not null default false,
  medical_claims_permitted  boolean     not null default false,
  permitted_public_titles   text[]      not null default array['Therapist','Senior Therapist','Spa Therapist'],
  banned_claim_terms        text[]      not null default array[
                              'therapeutic','therapy','treatment','pain relief','rehabilitation',
                              'cure','heal','medical','clinical','diagnosis','prescribe',
                              'physiotherapy','lymphatic drainage','prenatal'
                            ],

  -- Provisional until a lawyer confirms. Surfaced in the Unconfirmed Assumptions panel.
  is_provisional            boolean     not null default true,
  source_note               text,
  effective_from            timestamptz not null default now(),
  superseded_at             timestamptz,
  created_at                timestamptz not null default now(),
  created_by                text        not null default 'system'
);

comment on table regulatory_profile is
  'Append-only, versioned. A change inserts a new row and stamps superseded_at on the previous one; '
  'rows are never edited, so the profile in force on any past date is recoverable.';
comment on column regulatory_profile.clinical_retention_years is
  'Defaults to the healthcare-grade figure because unconfirmed resolves to the stricter option.';
comment on column regulatory_profile.banned_claim_terms is
  'Drives the publication lint. Under a non-healthcare licence these words are claims, not marketing. '
  'Applies to service display names too: "Therapeutic Deep Tissue" is a claim.';

-- Exactly one profile in force at a time.
create unique index regulatory_profile_one_current
  on regulatory_profile ((superseded_at is null))
  where superseded_at is null;

create view regulatory_profile_current as
  select * from regulatory_profile where superseded_at is null;

comment on view regulatory_profile_current is 'The profile in force. Every consumer reads this, never the table.';

-- Seed the stricter default so the system is never without a profile.
insert into regulatory_profile (source_note)
values ('Seeded by migration 0004. licence_class=unconfirmed resolves to the stricter combination until a UAE lawyer confirms. See OPEN-QUESTIONS Y1-licence.');
