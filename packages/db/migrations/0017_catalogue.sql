-- 0017 — the service catalogue: (style x treatment), duration variants, required skill, resource shapes.
--
-- The catalogue is the spine every other module reads: availability needs the turnaround, the booking
-- transaction snapshots the price, the website renders the public name, the rota needs the skill. Four
-- decisions carry this migration, and three of them are the non-obvious choice.
--
-- ## A service is the PAIR (style x treatment), not a treatment with a style column on the therapist
--
-- ADR 0021, confirmed with the owner. Style is an attribute of the treatment, so the catalogue holds
-- 8 rows: 4 treatments x 2 styles. The consequence that makes this the right shape is that price and
-- therapist assignment stay decoupled — the price is known when the customer picks a service and does
-- not move when the front desk reassigns a therapist. Model it the other way and every reassignment is
-- a repricing, including reassignments made after the customer has been quoted.
--
-- `(style, treatment_key)` is therefore a natural key and is declared UNIQUE. That is not decoration:
-- 0012_rooms.sql keyed `service_room_type_compat` on exactly those two columns because no parent
-- existed yet, and this migration attaches the composite foreign key it was waiting for. The
-- `treatment_style` enum is REUSED from 0012 rather than redeclared — a composite foreign key requires
-- identical types on both sides, and a second enum with the same labels is a different type.
--
-- `treatment_key` is text rather than an enum for the same reason, in the other direction:
-- `service_room_type_compat.service_treatment_key` is text, and there is no equality operator between
-- an enum and text, so an enum here would have made the foreign key impossible to attach.
--
-- ## Turnaround is not a therapist buffer
--
-- `service.turnaround_minutes` occupies the ROOM after a treatment: linen, cleaning, airing.
-- `service_resource_shape.therapist_buffer_minutes` occupies the THERAPIST either side of it. Two
-- resources, two durations, two columns, and deliberately no derivation between them — the wet room
-- needs 30 minutes of cleaning while the therapist needs 10 minutes of rest, and a schema that derived
-- one from the other would make that impossible to express. docs/06 B1 records this as a blind spot
-- because conflating them is the mistake that looks like a simplification.
--
-- ## Four Hands and Couple Massage are resource SHAPES, not extra treatments
--
-- docs/13 section 4 lists them under "price on request", which reads like two more menu items. They are
-- not: Four Hands is two therapists over one client in one standard room, and Couple Massage is two
-- therapists over two clients in one capacity-2 room. Both are the SAME treatments already in the
-- catalogue, delivered with a different resource footprint. Modelled as extra treatment keys they would
-- multiply the menu by the styles and durations they share with their parents, and 0012's compatibility
-- rows would not cover them. Modelled as shapes, `booking (1) -> appointments (n)` already expresses
-- them and the deferred room-capacity trigger of B-AVAIL-01 counts them correctly.
--
-- ## No third pricing axis
--
-- ADR 0021 again: duration is the only axis. Not time of day, not seniority, not day of week. So
-- `service_variant` is (service x duration) and nothing else, and the price-on-request derivations for
-- the two-therapist shapes belong to B-CAT-06's seed, flagged provisional, rather than to a multiplier
-- column here that would quietly become a second pricing axis.

begin;

-- ---------------------------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------------------------

-- The skill a style requires of whoever delivers it. Eligibility only: it decides who CAN take the
-- appointment, never what it costs (ADR 0021).
--
-- An enum rather than free text because the roster and the catalogue must agree on the spelling. P-HR's
-- `employee_skill` should reference this type rather than declare its own, so a new style cannot become
-- bookable before anybody is recorded as able to deliver it.
create type therapist_skill as enum ('asian_style', 'arabic_style');
comment on type therapist_skill is
  'Required therapist skill for a treatment style. Eligibility only — style maps to a skill, never to '
  'a price (ADR 0021, docs/01 decision 21).';

-- The resource footprint of one delivery of a service.
--
-- 'solo' is one therapist over one client. 'four_hands' is two therapists over ONE client, and 'couple'
-- is two therapists over TWO clients in one room — the two rows that make the booking container
-- one-to-many. A fourth footprint is a migration, which is correct: it changes what the premises can
-- physically deliver and should not be arrivable at by inserting a row.
create type service_shape as enum ('solo', 'four_hands', 'couple');
comment on type service_shape is
  'Resource footprint of one delivery: solo, four_hands (2 therapists, 1 client), couple (2 therapists, '
  '2 clients). Four Hands and Couple Massage are shapes of existing treatments, not extra treatments.';

-- ---------------------------------------------------------------------------------------------
-- service — the catalogue spine
-- ---------------------------------------------------------------------------------------------
create table service (
  id                  uuid            primary key default uuid_generate_v7(),
  -- Reused from 0012_rooms.sql. See the header: a composite foreign key needs identical types.
  style               treatment_style not null,
  treatment_key       text            not null,
  -- The public path segment. Held here rather than derived from the name so that renaming a service for
  -- the customer does not silently change its URL; B-CAT-05 pairs a slug change with a 301 row.
  slug                text            not null unique,
  -- Two names, on purpose, and the asymmetry is the point.
  --
  -- `internal_name` is unconstrained: the front desk calls a treatment whatever the front desk calls it,
  -- and a lint on an internal label is a lint nobody can satisfy at 23:00 with a customer waiting.
  -- `public_display_name` is what reaches a customer, so B-CAT-05 lints it against the banned-claims
  -- lexicon read from regulatory_profile — a wellness licence may not advertise a therapeutic claim.
  -- One column serving both purposes forces the compliance rule onto the internal label or drops it
  -- from the public one.
  internal_name       text            not null,
  public_display_name text            not null,
  -- Minutes the ROOM is unavailable after this treatment. Not the therapist buffer; see the header and
  -- `service_resource_shape.therapist_buffer_minutes`.
  turnaround_minutes  smallint        not null,
  display_order       smallint        not null default 0,
  -- Provenance, the same trio as app_setting (0010) so the Unconfirmed Assumptions panel reads one
  -- shape everywhere. Set when the build chose a value because no answer existed.
  is_provisional      boolean         not null default false,
  provisional_note    text,
  open_question_id    text,
  created_at          timestamptz     not null default now(),
  updated_at          timestamptz     not null default now(),
  -- The natural key. Exactly 8 rows can exist for 4 treatments across 2 styles, and this is the parent
  -- 0012's compatibility rows have been waiting for.
  constraint service_style_treatment_key_unique unique (style, treatment_key),
  -- The key is a join target and a seed handle, so it is machine-shaped. A key with a capital letter or
  -- a space would still work until the day two spellings of it existed.
  constraint service_treatment_key_snake_case check (treatment_key ~ '^[a-z][a-z0-9_]*$'),
  constraint service_slug_kebab_case check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  -- An empty public name renders as a blank line on the menu and an empty internal one makes the rota
  -- unreadable. Neither is a name.
  constraint service_names_nonempty
    check (btrim(internal_name) <> '' and btrim(public_display_name) <> ''),
  -- Zero is legal — a treatment needing no room turnaround is a possible answer — but an unbounded value
  -- is not: a mistyped 2000 would take the room out of service for a day and a half and read as
  -- "no availability".
  constraint service_turnaround_bounded check (turnaround_minutes between 0 and 240),
  -- A provisional value with no open question is an assumption nobody can resolve: it shows up in the
  -- Unconfirmed Assumptions panel with nothing to ask the owner about.
  constraint service_provisional_names_a_question
    check (not is_provisional or open_question_id is not null)
);

comment on table service is
  'The catalogue: one row per (style x treatment) pair, 8 rows (ADR 0021). The parent of '
  'service_room_type_compat, whose two natural-key columns 0012_rooms.sql declared for exactly this.';
comment on column service.turnaround_minutes is
  'Minutes the ROOM is unavailable after the treatment. NOT the therapist buffer, which is '
  'service_resource_shape.therapist_buffer_minutes — different resource, different duration, no '
  'derivation between them (docs/06 B1).';
comment on column service.internal_name is
  'Unconstrained by design. The public name is the linted one; see public_display_name.';
comment on column service.public_display_name is
  'Reaches the customer, so B-CAT-05 lints it against the banned-claims lexicon in regulatory_profile. '
  'The internal name is deliberately exempt.';

create trigger service_updated_at before update on service
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------------------------
-- service_variant — duration and price, the only pricing axis
-- ---------------------------------------------------------------------------------------------
create table service_variant (
  id                uuid        primary key default uuid_generate_v7(),
  service_id        uuid        not null references service (id) on delete cascade,
  duration_minutes  smallint    not null,
  -- VAT-inclusive gross, integer fils, per docs/01 decision 7. The `fils` domain (0002) states the unit
  -- in the column type so a reader of this table cannot mistake it for dirhams.
  gross_price_fils  fils        not null,
  is_provisional    boolean     not null default false,
  provisional_note  text,
  open_question_id  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- The four durations the menu offers (docs/13 section 4). A CHECK rather than free minutes because an
  -- arbitrary duration is not a price point: every other duration has no price, so it would be a
  -- bookable service with nothing to charge for it.
  constraint service_variant_duration_allowed
    check (duration_minutes in (45, 60, 90, 120)),
  -- Strictly positive. Zero is not a free treatment, it is a missing price: it would pass a
  -- non-negative check, invoice as 0.00 and reconcile to nothing.
  constraint service_variant_price_positive check (gross_price_fils > 0),
  -- One price per duration. Two rows for the same pair make "the price of a 60-minute Asian massage"
  -- a question with two answers, and which one the booking snapshots would depend on row order.
  constraint service_variant_service_duration_unique unique (service_id, duration_minutes),
  constraint service_variant_provisional_names_a_question
    check (not is_provisional or open_question_id is not null)
);

comment on table service_variant is
  'Duration x price. Duration is the ONLY pricing axis (ADR 0021): no time of day, no seniority, no day '
  'of week. The 32 price points are transcribed from docs/13 section 4 by B-CAT-06 seed, not here.';
comment on column service_variant.gross_price_fils is
  'VAT-inclusive gross in integer fils (docs/01 decision 7). VAT is derived as gross - net so '
  'net + vat = gross exactly; never stored as a fraction of dirhams.';
comment on column service_variant.is_provisional is
  'On a variant the only guessable value is the price, so this flags a DERIVED price rather than one '
  'transcribed from docs/13. B-CAT-06 acceptance calls this price_provisional and records the '
  'derivation in provisional_note.';

create trigger service_variant_updated_at before update on service_variant
  for each row execute function set_updated_at();

create index service_variant_service_idx on service_variant (service_id);

-- ---------------------------------------------------------------------------------------------
-- service_skill — style to required skill, total over the style enum
-- ---------------------------------------------------------------------------------------------
-- Keyed on the STYLE, not on the service: the skill requirement is a property of the style, and 8 rows
-- would let two services of the same style disagree about who may deliver them.
--
-- Totality over `treatment_style` cannot be a CHECK — a constraint cannot count rows — so it is asserted
-- against `pg_enum` in packages/db/src/schema/catalogue.itest.ts and by an exhaustive mapping in
-- packages/shared. A style with no skill row is a style nobody is eligible for, which surfaces as an
-- empty therapist list rather than as an error.
create table service_skill (
  style            treatment_style primary key,
  required_skill   therapist_skill not null,
  created_at       timestamptz     not null default now(),
  -- One skill per style and one style per skill. Without this, both styles could require the same skill,
  -- which is the "style is really a therapist attribute" model creeping back in through the mapping.
  constraint service_skill_required_skill_unique unique (required_skill)
);

comment on table service_skill is
  'Style -> required therapist skill, for ELIGIBILITY ONLY. Carries no price and never will: pricing and '
  'therapist assignment are decoupled (ADR 0021), and a price here would recouple them.';

-- ---------------------------------------------------------------------------------------------
-- service_resource_shape — therapists, rooms, capacity and the therapist buffer
-- ---------------------------------------------------------------------------------------------
-- Keyed on the service NATURAL key rather than on service_id, which buys a guarantee no surrogate key
-- can: `(service_style, service_treatment_key, required_room_type)` is exactly the primary key of
-- service_room_type_compat, so a shape that demands a room type the service may not be delivered in is
-- refused by a foreign key. With a service_id that check would be a trigger or, more likely, nothing —
-- and a Four Hands shape demanding a wet room would resolve to zero bookable rooms and read as
-- "no availability" for ever.
create table service_resource_shape (
  service_style            treatment_style not null,
  service_treatment_key    text            not null,
  shape                    service_shape   not null,
  -- Two therapists for Four Hands and Couple Massage. This is what makes the booking container
  -- one-to-many: one booking, n appointments, each with its own therapist.
  therapists_required      smallint        not null,
  rooms_required           smallint        not null,
  -- Clients the room must hold. Four Hands is min 1 — two therapists over ONE client — and Couple
  -- Massage is min 2. Deriving this from therapists_required would get Four Hands wrong.
  min_room_capacity        smallint        not null,
  -- Narrows the compatible room types for THIS shape. NULL means any type service_room_type_compat
  -- allows: compatibility answers "may it be delivered here at all", and the shape narrows it for one
  -- footprint. Four Hands needs floor space, so it is standard-room only even for a treatment whose
  -- compatibility rows also permit the couples room.
  required_room_type       room_type,
  -- Minutes protecting the THERAPIST either side of the treatment. Distinct from
  -- service.turnaround_minutes, which occupies the room. See the header.
  therapist_buffer_minutes smallint        not null,
  is_provisional           boolean         not null default false,
  provisional_note         text,
  open_question_id         text,
  created_at               timestamptz     not null default now(),
  updated_at               timestamptz     not null default now(),
  primary key (service_style, service_treatment_key, shape),
  -- The composite foreign key the natural key exists for.
  constraint service_resource_shape_service_fk
    foreign key (service_style, service_treatment_key)
    references service (style, treatment_key) on update cascade on delete cascade,
  -- A narrowed room type must be one the service may actually be delivered in. MATCH SIMPLE, so a NULL
  -- required_room_type is unconstrained here and falls back to the full compatibility set.
  --
  -- ON DELETE CASCADE rather than RESTRICT deliberately: deleting a service cascades to both this table
  -- and service_room_type_compat, and PostgreSQL does not promise an order between two cascade paths, so
  -- RESTRICT here could refuse a legitimate service delete depending on which path ran first.
  constraint service_resource_shape_room_type_compat_fk
    foreign key (service_style, service_treatment_key, required_room_type)
    references service_room_type_compat (service_style, service_treatment_key, room_type)
    on update cascade on delete cascade,
  constraint service_resource_shape_therapists_positive check (therapists_required >= 1),
  constraint service_resource_shape_rooms_positive check (rooms_required >= 1),
  constraint service_resource_shape_capacity_positive check (min_room_capacity >= 1),
  -- Two clients in one room needs a room that holds two. Caught here rather than at booking time, where
  -- it presents as a couples booking silently assigned to a single room.
  constraint service_resource_shape_couple_holds_two
    check (shape <> 'couple' or min_room_capacity >= 2),
  -- Four hands are two therapists. A four_hands row with one is a shape that cannot deliver what it
  -- names.
  constraint service_resource_shape_four_hands_needs_two
    check (shape <> 'four_hands' or therapists_required >= 2),
  constraint service_resource_shape_buffer_bounded
    check (therapist_buffer_minutes between 0 and 60),
  constraint service_resource_shape_provisional_names_a_question
    check (not is_provisional or open_question_id is not null)
);

comment on table service_resource_shape is
  'Resource footprint per (service, shape): therapists, rooms, minimum room capacity and the therapist '
  'buffer. Four Hands and Couple Massage are shapes of existing treatments, not extra treatments.';
comment on column service_resource_shape.therapist_buffer_minutes is
  'Minutes protecting the THERAPIST either side of the treatment. Distinct from '
  'service.turnaround_minutes, which occupies the room: different resource, different duration, no '
  'derivation between them (docs/06 B1).';
comment on column service_resource_shape.required_room_type is
  'Narrows the compatible room types for this shape. NULL means any type service_room_type_compat '
  'allows. A non-NULL value must have a matching compatibility row, enforced by a composite FK.';

create trigger service_resource_shape_updated_at before update on service_resource_shape
  for each row execute function set_updated_at();

create index service_resource_shape_shape_idx on service_resource_shape (shape);

-- ---------------------------------------------------------------------------------------------
-- The seed, and then the foreign key 0012 was waiting for
-- ---------------------------------------------------------------------------------------------
-- The 8 services, as (style x treatment) from docs/13 section 4. Seeded HERE rather than in B-CAT-06's
-- seed because service_room_type_compat already holds 12 rows keyed on these pairs: without the parent
-- rows the composite foreign key below cannot be attached, and attaching it later would need a data
-- migration for rows that are already correct.
--
-- What is deliberately NOT seeded here is the 32 prices. They are business data transcribed from
-- docs/13 section 4 and belong to B-CAT-06's seed; two sources for the same 32 numbers is one source too
-- many, and a migration cannot be re-run when a price changes.
--
-- Turnaround: 20 minutes standard, 30 for the wet-room treatment, matching the provisional defaults of
-- booking.turnaround_minutes_standard and booking.turnaround_minutes_wet in the settings registry. Both
-- are assumptions against Y9-turnaround, so every row is flagged provisional and names the question.
insert into service
  (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
   display_order, is_provisional, provisional_note, open_question_id)
values
  ('asian',  'normal_massage',       'asian-normal-massage',
   'Asian Normal Massage',           'Normal Massage (Asian)',            20, 1,
   true, 'Turnaround assumed 20 min for a standard room.', 'Y9-turnaround'),
  ('asian',  'hot_oil_balm_massage', 'asian-hot-oil-balm-massage',
   'Asian Hot Oil / Balm Massage',   'Hot Oil / Balm Massage (Asian)',    20, 2,
   true, 'Turnaround assumed 20 min for a standard room.', 'Y9-turnaround'),
  ('asian',  'morocco_bath_jacuzzi', 'asian-morocco-bath-jacuzzi',
   'Asian Morocco Bath or Jacuzzi',  'Morocco Bath or Jacuzzi (Asian)',   30, 3,
   true, 'Turnaround assumed 30 min for the wet room.', 'Y9-turnaround'),
  ('asian',  'massage_with_shaving', 'asian-massage-with-shaving',
   'Asian Massage with Shaving',      'Massage with Shaving (Asian)',      20, 4,
   true, 'Turnaround assumed 20 min for a standard room.', 'Y9-turnaround'),
  ('arabic', 'normal_massage',       'arabic-normal-massage',
   'Arabic Normal Massage',           'Normal Massage (Arabic)',           20, 5,
   true, 'Turnaround assumed 20 min for a standard room.', 'Y9-turnaround'),
  ('arabic', 'hot_oil_balm_massage', 'arabic-hot-oil-balm-massage',
   'Arabic Hot Oil / Balm Massage',   'Hot Oil / Balm Massage (Arabic)',   20, 6,
   true, 'Turnaround assumed 20 min for a standard room.', 'Y9-turnaround'),
  ('arabic', 'morocco_bath_jacuzzi', 'arabic-morocco-bath-jacuzzi',
   'Arabic Morocco Bath or Jacuzzi',  'Morocco Bath or Jacuzzi (Arabic)',  30, 7,
   true, 'Turnaround assumed 30 min for the wet room.', 'Y9-turnaround'),
  ('arabic', 'massage_with_shaving', 'arabic-massage-with-shaving',
   'Arabic Massage with Shaving',     'Massage with Shaving (Arabic)',     20, 8,
   true, 'Turnaround assumed 20 min for a standard room.', 'Y9-turnaround')
on conflict (style, treatment_key) do nothing;

-- The style-to-skill mapping. Two rows, one per label of treatment_style, which is the totality the
-- exhaustiveness test asserts.
insert into service_skill (style, required_skill)
values
  ('asian',  'asian_style'),
  ('arabic', 'arabic_style')
on conflict (style) do nothing;

-- Resource shapes.
--
-- A 'solo' row for all 8 services, plus 'four_hands' and 'couple' for the two dry massage treatments.
-- Morocco Bath and Massage with Shaving get no two-therapist shape: the bath is wet-room only and the
-- shaving treatment is standard-room only with a hygiene protocol (Y9-shaving-room), so a couples
-- footprint for either has no compatibility row to stand on — and the composite foreign key above would
-- refuse the row rather than let it resolve to zero bookable rooms.
--
-- The wet-room solo shape pins required_room_type = 'wet' explicitly even though compatibility already
-- restricts it: the scheduler reads the shape, and a Morocco Bath whose shape says "any compatible room"
-- would be correct only for as long as nobody adds a second compatibility row.
--
-- The 10-minute therapist buffer is an assumption against Y9-buffer, matching
-- booking.therapist_buffer_minutes in the settings registry. The resource counts are NOT assumptions:
-- docs/13 section 4 states them.
insert into service_resource_shape
  (service_style, service_treatment_key, shape, therapists_required, rooms_required,
   min_room_capacity, required_room_type, therapist_buffer_minutes,
   is_provisional, provisional_note, open_question_id)
values
  ('asian',  'normal_massage',       'solo',       1, 1, 1, null,       10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('asian',  'hot_oil_balm_massage', 'solo',       1, 1, 1, null,       10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('asian',  'morocco_bath_jacuzzi', 'solo',       1, 1, 1, 'wet',      10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('asian',  'massage_with_shaving', 'solo',       1, 1, 1, 'standard', 10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('arabic', 'normal_massage',       'solo',       1, 1, 1, null,       10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('arabic', 'hot_oil_balm_massage', 'solo',       1, 1, 1, null,       10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('arabic', 'morocco_bath_jacuzzi', 'solo',       1, 1, 1, 'wet',      10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('arabic', 'massage_with_shaving', 'solo',       1, 1, 1, 'standard', 10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  -- Four Hands: 2 therapists, 1 standard room, 1 client (docs/13 section 4).
  ('asian',  'normal_massage',       'four_hands', 2, 1, 1, 'standard', 10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('asian',  'hot_oil_balm_massage', 'four_hands', 2, 1, 1, 'standard', 10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('arabic', 'normal_massage',       'four_hands', 2, 1, 1, 'standard', 10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('arabic', 'hot_oil_balm_massage', 'four_hands', 2, 1, 1, 'standard', 10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  -- Couple Massage: 2 therapists, 1 double-capacity room, 2 clients (docs/13 section 4).
  ('asian',  'normal_massage',       'couple',     2, 1, 2, 'couples',  10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('asian',  'hot_oil_balm_massage', 'couple',     2, 1, 2, 'couples',  10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('arabic', 'normal_massage',       'couple',     2, 1, 2, 'couples',  10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer'),
  ('arabic', 'hot_oil_balm_massage', 'couple',     2, 1, 2, 'couples',  10,
   true, 'Therapist buffer assumed 10 min each side.', 'Y9-buffer')
on conflict (service_style, service_treatment_key, shape) do nothing;

-- The foreign key 0012_rooms.sql was written for. Its two columns were already the service natural key;
-- all this does is say so to the database, now that the parent exists. No data migration: the 12 seeded
-- compatibility rows match the 8 services above by construction, and this statement fails loudly if a
-- compatibility row ever names a service that does not exist.
alter table service_room_type_compat
  add constraint service_room_type_compat_service_fk
  foreign key (service_style, service_treatment_key)
  references service (style, treatment_key) on update cascade on delete cascade;

comment on constraint service_room_type_compat_service_fk on service_room_type_compat is
  'Attached by 0017 once the parent existed. ON UPDATE CASCADE so renaming a treatment key moves its '
  'compatibility rows with it; ON DELETE CASCADE because a compatibility row for a deleted service is '
  'not a row anybody can act on.';

commit;
