-- 0012 — rooms as schedulable resources, and which treatments may be delivered in which of them.
--
-- Two modelling decisions carry this migration, and both of them are the non-obvious choice.
--
-- ## The wet room is a TYPE, not an attribute
--
-- The obvious shape is `rooms.is_wet boolean`. It is wrong here. With a boolean, "can this treatment
-- happen in this room" becomes a predicate over attributes that every availability query has to
-- restate, and the next facility — a shaving station, a couples plinth — adds another column and
-- another clause to every one of those queries. With a room TYPE, compatibility is a join on one
-- column, and the scheduler can rank scarcity by type because the type is the scarce thing.
--
-- The wet room is genuinely scarce: Morocco Bath and Jacuzzi cannot be delivered anywhere else, and
-- there is one of it. Mis-scheduling it does not degrade the booking, it voids it.
--
-- ## service_room_type_compat has no default, and that is the point
--
-- A service with no compatibility rows resolves to zero bookable rooms. It does NOT fall back to
-- "any room". A permissive default is the failure this table exists to prevent: it would let a
-- Morocco Bath be booked into a dry room the moment somebody forgot to seed a row, and the error
-- would surface as a customer standing in a room with no bath in it. Structural absence is a loud
-- failure; a fall-back is a quiet one.
--
-- The table name `rooms` is plural against the singular convention of every other table here. It is
-- pinned: ADR 0015 and docs/01 decision 9 both name `rooms.capacity` as the column the deferred
-- room-capacity trigger counts against, and B-AVAIL-01 writes that trigger.

begin;

-- Exactly three types. Adding a fourth is a migration, which is correct: a new kind of room changes
-- what the premises can sell and should not be arrivable at by inserting a row.
create type room_type as enum ('standard', 'couples', 'wet');
comment on type room_type is
  'standard: an ordinary treatment room. couples: capacity 2, two clients in one room. '
  'wet: Moroccan bath and jacuzzi, the scarce resource. See docs/13 section 4.';

create table rooms (
  id            uuid        primary key default uuid_generate_v7(),
  -- A stable internal reference. The display name is editable in settings and translated; joins,
  -- seeds and the 301-style continuity of a renamed room all need something that does not move.
  code          text        not null unique,
  name          text        not null,
  room_type     room_type   not null,
  -- How many clients may be in the room at once. This is what the deferred room-capacity trigger in
  -- B-AVAIL-01 counts overlapping appointments against, which is why it is an explicit integer
  -- rather than derived from room_type: a second couples room with three plinths is data, not a
  -- schema change.
  capacity      smallint    not null,
  -- False decommissions a room without deleting it, so historical appointments keep their room.
  is_bookable   boolean     not null default true,
  display_order smallint    not null default 0,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A room that holds nobody is not a room with unusual capacity; it is a row that would make every
  -- capacity count pass trivially.
  constraint rooms_capacity_positive check (capacity >= 1),
  -- A couples room that holds one client cannot deliver the service it exists for. Caught here
  -- rather than at booking time, where it would present as "no availability" with no reason given.
  constraint rooms_couples_holds_two check (room_type <> 'couples' or capacity >= 2)
);

comment on column rooms.capacity is
  'Clients the room holds at once. The room-capacity constraint trigger (ADR 0015) counts '
  'overlapping appointments against this, so it is authoritative and not derived from room_type.';
comment on column rooms.is_bookable is
  'False takes a room out of service without deleting it. Deleting would orphan the appointments '
  'that happened in it, which are financial records.';

create trigger rooms_updated_at before update on rooms
  for each row execute function set_updated_at();

create index rooms_bookable_idx on rooms (room_type) where is_bookable;

-- Maintenance, deep cleans, and holds a manager places by hand. A block makes a room unavailable
-- without a booking, which is how "the wet room is out until Thursday" gets said to the scheduler.
--
-- The period is a tstzrange with '[)' bounds, per ADR 0015: half-open is what makes two treatments
-- that abut exactly at 14:00 both legal, and mixing bound styles in one schema guarantees that one
-- day two of them are compared.
create table resource_block (
  id          uuid        primary key default uuid_generate_v7(),
  room_id     uuid        not null references rooms (id) on delete cascade,
  period      tstzrange   not null,
  kind        text        not null check (kind in ('maintenance','deep_clean','hold','other')),
  reason      text        not null,
  created_by  text        not null default 'system',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- An empty range blocks nothing while looking like a block, so it would sit in the table reading
  -- as "this room is unavailable" and never make a single slot unavailable.
  constraint resource_block_period_nonempty check (not isempty(period)),
  -- Both bounds finite: an unbounded block takes the room out of service for ever, and the way that
  -- is discovered is that the room never appears in availability again.
  constraint resource_block_period_bounded
    check (lower(period) is not null and upper(period) is not null),
  -- Half-open, always. A block stored as '[]' overlaps the treatment that starts exactly when the
  -- block ends, which would silently shorten every day after a maintenance slot.
  constraint resource_block_period_half_open
    check (lower_inc(period) and not upper_inc(period))
);

comment on table resource_block is
  'Room unavailability that is not a booking: maintenance, deep cleans, manual holds. Rooms only. '
  'A therapist block is leave or a shift gap, which is P-HR data with its own approval path, not a '
  'nullable second foreign key on this table.';

create trigger resource_block_updated_at before update on resource_block
  for each row execute function set_updated_at();

-- GiST over (room_id, period) so the overlap lookup for one room is an index scan. The btree_gist
-- extension from 0001 is what allows the uuid equality and the range overlap in the same index.
create index resource_block_room_period_idx on resource_block using gist (room_id, period);

-- Which room types a service may be delivered in.
--
-- Keyed on the service natural key `(style, treatment_key)` rather than on a surrogate id, because
-- there is no `service` table yet: B-CAT-03 builds it and declares (style, treatment_key) UNIQUE,
-- at which point this becomes a composite foreign key with no data migration. The `treatment_style`
-- enum is created here for the same reason — a composite foreign key requires the referencing and
-- referenced columns to have identical types, so B-CAT-03 must reuse this enum rather than declare
-- its own. See the NOTE on B-CAT-02 in build/manifest.yaml.
create type treatment_style as enum ('asian', 'arabic');
comment on type treatment_style is
  'Style is an attribute of the TREATMENT, not of the therapist (ADR 0021). A service is the pair '
  '(style x treatment), which is what makes price and therapist assignment independent.';

create table service_room_type_compat (
  service_style         treatment_style not null,
  service_treatment_key text            not null,
  room_type             room_type       not null,
  -- Provisional rows are assumptions the build made because no answer existed; the Unconfirmed
  -- Assumptions panel reads this the same way it reads app_setting.is_provisional.
  is_provisional        boolean         not null default false,
  open_question_id      text,
  created_at            timestamptz     not null default now(),
  primary key (service_style, service_treatment_key, room_type)
);

comment on table service_room_type_compat is
  'Which room types a service may be delivered in. NO DEFAULT and no fall-back: zero rows means zero '
  'bookable rooms. A permissive default would let a Morocco Bath be booked into a dry room the first '
  'time a row was forgotten, and the failure would be discovered by the customer.';

create index service_room_type_compat_room_type_idx on service_room_type_compat (room_type);

-- The bookable set, as a view, so "no compatibility rows means no rooms" is an inner join rather
-- than a code path somebody can forget to write. A caller cannot accidentally widen this the way it
-- could accidentally widen a hand-written WHERE clause.
create view service_bookable_room as
select
  c.service_style,
  c.service_treatment_key,
  r.id   as room_id,
  r.code as room_code,
  r.room_type,
  r.capacity
from service_room_type_compat c
join rooms r on r.room_type = c.room_type
where r.is_bookable;

comment on view service_bookable_room is
  'Rooms a service may be delivered in. Empty for a service with no compatibility rows, by '
  'construction rather than by convention.';

-- --------------------------------------------------------------------------------------------
-- Provisional inventory. Y8-rooms and Y1-rooms are open: the room count, which room is wet and
-- which are capacity-2 all come from the handover pack. Five rooms is the documented stub in
-- docs/OPEN-QUESTIONS.md, and B-CAT-06 replaces it with the measured inventory.
--
-- `on conflict do nothing` so re-applying against a database that already has the real inventory
-- does not resurrect the stub.
-- --------------------------------------------------------------------------------------------
insert into rooms (code, name, room_type, capacity, display_order, notes)
values
  ('room-1',       'Room 1',       'standard', 1, 1, 'Provisional inventory, Y8-rooms'),
  ('room-2',       'Room 2',       'standard', 1, 2, 'Provisional inventory, Y8-rooms'),
  ('room-3',       'Room 3',       'standard', 1, 3, 'Provisional inventory, Y8-rooms'),
  ('room-couples', 'Couples Room', 'couples',  2, 4, 'Capacity 2. Assumed permitted under the licence, Y1-rooms'),
  ('room-wet',     'Wet Room',     'wet',      1, 5, 'Moroccan bath and jacuzzi. The scarce resource, Y8-rooms')
on conflict (code) do nothing;

-- The eight catalogue services, as (style x treatment) from docs/13 section 4.
--
-- Morocco Bath or Jacuzzi maps to the wet room type ONLY, for both styles. That is the load-bearing
-- row set: it is the reason this table exists rather than a boolean on rooms.
--
-- The dry massages accept a couples room as well as a standard one, because a couples room is a
-- treatment room that happens to hold two. Whether the scheduler SHOULD put a single client in the
-- only capacity-2 room is a scarcity-ranking question for the availability engine — this table
-- answers "may it be delivered here at all", and conflating the two would make a physically
-- possible booking impossible to express.
--
-- Massage with Shaving is restricted to standard rooms, which is the Y9-shaving-room stub
-- ("any standard room") and is flagged provisional accordingly.
insert into service_room_type_compat
  (service_style, service_treatment_key, room_type, is_provisional, open_question_id)
values
  ('asian',  'normal_massage',       'standard', false, null),
  ('asian',  'normal_massage',       'couples',  false, null),
  ('asian',  'hot_oil_balm_massage', 'standard', false, null),
  ('asian',  'hot_oil_balm_massage', 'couples',  false, null),
  ('asian',  'morocco_bath_jacuzzi', 'wet',      false, null),
  ('asian',  'massage_with_shaving', 'standard', true,  'Y9-shaving-room'),
  ('arabic', 'normal_massage',       'standard', false, null),
  ('arabic', 'normal_massage',       'couples',  false, null),
  ('arabic', 'hot_oil_balm_massage', 'standard', false, null),
  ('arabic', 'hot_oil_balm_massage', 'couples',  false, null),
  ('arabic', 'morocco_bath_jacuzzi', 'wet',      false, null),
  ('arabic', 'massage_with_shaving', 'standard', true,  'Y9-shaving-room')
on conflict (service_style, service_treatment_key, room_type) do nothing;

commit;
