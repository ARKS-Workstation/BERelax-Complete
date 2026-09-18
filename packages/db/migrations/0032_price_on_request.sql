-- 0032 — the three offerings docs/13 §4 prints with no figure, recorded as data with no figure.
--
-- docs/13 §4 has a fourth table headed **"Price on request"**: Four Hands Massage, Couple Massage and
-- Full Body Shaving. It states each one's resource requirement and states no price for any of them,
-- because the business quotes them at the desk. Y9-poa-prices is the open question, and it is open.
--
-- ## Why this table exists at all, rather than three prices
--
-- The tempting move is to derive a figure — 1.8× the single-therapist equivalent is the multiplier this
-- unit's manifest entry proposed — and store it as an ordinary `service_variant` price flagged
-- provisional. Two things are wrong with that, and the second is worse than the first.
--
-- A derived price is an **invented fact about this business**. It would be quoted to a customer, taken
-- at the till and printed on a tax invoice, and nothing on any of those surfaces distinguishes it from a
-- price the owner set. A blank is visibly unanswered; a plausible figure is indistinguishable from a
-- configured one. That is the rule the whole repository is built on — the same reason `legal_entity.trn`
-- carries `TRN-PENDING-Y1-TRN` (0026) instead of fifteen digits that look like a registration.
--
-- And there is nowhere for it to go. `service_variant` is `(service × duration)` and duration is the
-- ONLY pricing axis (ADR 0021): a Four Hands figure is a price for a *shape*, so storing one needs a
-- third axis, which 0017 refused to add and 0025 refused to add again. A price column on
-- `service_resource_shape` would be that axis wearing a different hat.
--
-- So what gets recorded is the fact that *is* known: three named offerings exist, docs/13 states what
-- each one needs, and none of them has a price. **This table has no price column, and that absence is
-- its content.** A row here means "quoted by hand, no figure in the system". When Y9-poa-prices closes,
-- the answer arrives as ordinary catalogue data — a variant, or a `price_list` row — and the row here is
-- DELETED. It is never flipped to confirmed, which is why `price_on_request_row_is_always_unanswered`
-- pins `is_provisional` true: a confirmed row in a table with no price column would be a statement that
-- somebody has answered a question this table cannot hold the answer to.
--
-- ## Why Full Body Shaving is here and not in the catalogue
--
-- Four Hands and Couple Massage are resource SHAPES of treatments already in `service`, which is what
-- 0017's `service_resource_shape` rows say. Full Body Shaving is not: it is not one of the four
-- treatment keys, it is not a shape of one, and docs/13 lists it once with no style — so expressing it
-- as `(style × treatment)` would mean inventing that it comes in an Asian and an Arabic version. It has
-- no room requirement either; docs/13 marks that [CONFIRM] and OPEN-QUESTIONS tracks it as
-- Y9-shaving-room. A row here is the honest record: on the menu, not modelled, two open questions.
-- `modelled_as` is what tells those two cases apart, so a reader does not have to infer it from the
-- absence of a shape.
--
-- ## The Unconfirmed Assumptions panel
--
-- 0010, 0012, 0017 and 0025 each carry the same provenance trio — `is_provisional`, `provisional_note`,
-- `open_question_id` — and each says the panel reads it "the same way it reads app_setting". Until this
-- migration the reader only ever read `app_setting`, so every provisional row in the catalogue was
-- invisible on the one screen built to show them. `unconfirmedAssumptionRows()` in
-- `packages/db/src/settings-store.ts` now unions all of them, and this table is one of its sources.

begin;

-- How an offering on the price-on-request list is expressed in the catalogue.
--
-- An enum rather than a boolean: "is it modelled" has a third answer already — modelled as a shape,
-- modelled as a service, not modelled — and the day a fourth arrives it should be a migration, because
-- it changes what the catalogue can express.
create type price_on_request_modelling as enum (
  'service_resource_shape',
  'not_modelled'
);
comment on type price_on_request_modelling is
  'How a price-on-request offering is expressed in the catalogue. service_resource_shape: a resource '
  'footprint over treatments that already exist (Four Hands, Couple Massage). not_modelled: docs/13 '
  'lists it but it is neither a treatment key nor a shape of one (Full Body Shaving).';

create table price_on_request (
  id                   uuid        primary key default uuid_generate_v7(),
  -- The label exactly as docs/13 §4 prints it. Public-facing — this is what a menu or a quote shows —
  -- so it goes through the same banned-claims lint as service.public_display_name (B-CAT-05).
  menu_label           text        not null unique,
  -- The resource requirement, transcribed from the second column of the same table. Prose rather than
  -- (therapists, rooms, clients) integers: for the two shape-modelled rows those integers are already
  -- in service_resource_shape and a second copy would be a second answer, and for Full Body Shaving
  -- docs/13 gives no integers at all.
  resource_requirement text        not null,
  modelled_as          price_on_request_modelling not null,
  -- Which footprint delivers it, for a shape-modelled row. Reuses the service_shape enum from 0017
  -- rather than restating its labels: a second enum with the same labels is a different type, and the
  -- two would disagree the first time a shape was added to one of them.
  shape                service_shape,
  -- The provenance trio, same three columns and same meaning as app_setting (0010) and the catalogue
  -- (0017), so the panel reads one shape everywhere.
  --
  -- `provisional_note` is NOT NULL here, unlike on service and service_variant. On those tables most
  -- rows are transcribed facts and the note is the exception; every row here is an unanswered price, so
  -- a row with no note would be an assumption with no stated reason.
  is_provisional       boolean     not null default true,
  provisional_note     text        not null,
  open_question_id     text        not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- See the header. A row in this table is an unanswered price by construction: there is no column to
  -- put the answer in, so "confirmed" could only ever mean "somebody cleared the flag and the price is
  -- still missing" — which is how an unanswered question disappears from the panel while staying
  -- unanswered.
  constraint price_on_request_row_is_always_unanswered check (is_provisional),
  constraint price_on_request_menu_label_nonempty check (btrim(menu_label) <> ''),
  -- The label is transcribed from docs/13, so it must not itself be a stand-in. is_placeholder_text()
  -- is 0026's, reused rather than restated: one list of markers, and the CHECK holds for a psql session
  -- as well as for the application.
  constraint price_on_request_menu_label_not_placeholder
    check (not is_placeholder_text(menu_label)),
  constraint price_on_request_requirement_nonempty check (btrim(resource_requirement) <> ''),
  -- A shape-modelled row names its shape and a not-modelled row cannot: written as an equality between
  -- two booleans rather than two one-directional CHECKs, so neither half can be satisfied while the
  -- other is not.
  constraint price_on_request_shape_matches_modelling
    check ((modelled_as = 'service_resource_shape') = (shape is not null)),
  -- The question has to be one somebody can look up. Free text here — 'TBD', 'ask the owner' — is an
  -- assumption the panel can display and nobody can close, which is the failure the whole trio exists
  -- to prevent.
  constraint price_on_request_names_an_open_question
    check (open_question_id ~ '^Y[0-9]+-[a-z][a-z0-9-]*$'),
  constraint price_on_request_note_nonempty check (btrim(provisional_note) <> '')
);

comment on table price_on_request is
  'The offerings docs/13 section 4 lists under "price on request", recorded with NO price column. A row '
  'means: quoted by hand, no figure in the system, Y9-poa-prices open. The answer arrives as ordinary '
  'catalogue data and deletes the row; it is never a cleared flag.';
comment on column price_on_request.menu_label is
  'The label as docs/13 section 4 prints it. Public-facing, so B-CAT-05 lints it against the '
  'banned-claims lexicon exactly as it lints service.public_display_name.';
comment on column price_on_request.modelled_as is
  'service_resource_shape for Four Hands and Couple Massage, which are footprints over treatments that '
  'already exist. not_modelled for Full Body Shaving: not a treatment key, not a shape of one, and '
  'listed once with no style, so a (style x treatment) row would invent an Asian and an Arabic version.';
comment on constraint price_on_request_row_is_always_unanswered on price_on_request is
  'There is no price column, so a cleared flag would mean "answered" while the price was still missing '
  'and the row had left the Unconfirmed Assumptions panel. Answering deletes the row instead.';

create trigger price_on_request_updated_at before update on price_on_request
  for each row execute function set_updated_at();

-- The panel's read: every unanswered price, in one ordered scan.
create index price_on_request_open_question_idx on price_on_request (open_question_id);

commit;
