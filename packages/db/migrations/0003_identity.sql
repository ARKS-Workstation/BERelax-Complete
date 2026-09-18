-- 0003 — who we are and where we are.
--
-- Two singletons, deliberately modelled as rows rather than config constants, because:
--   * a tax invoice must SNAPSHOT the issuer's name, address and TRN, so a future relocation or
--     TRN change cannot retroactively rewrite historic invoices (docs/01, docs/04 §4);
--   * the licence and TRN belong to the company and survive a move, while the address, rooms and
--     opening hours belong to the building — collapsing them means a relocation touches tax identity.

create table legal_entity (
  id                        smallint primary key default 1 check (id = 1),
  legal_name                text        not null,
  trading_name              text        not null,
  trn                       text,                    -- null until the owner supplies it (Y1-trn)
  trade_licence_number      text,
  licensing_authority       text        not null default 'ADDED',
  emirate                   text        not null default 'Abu Dhabi',
  legal_form                text        not null default 'mainland'
                              check (legal_form in ('mainland','difc','adgm','freezone')),
  financial_year_end_month  smallint    not null default 12 check (financial_year_end_month between 1 and 12),
  vat_registered            boolean     not null default false,
  vat_registration_date     date,
  small_business_relief     boolean     not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);
comment on table legal_entity is
  'The company. Singleton. Invoices snapshot these values so history never rewrites itself.';
comment on column legal_entity.trn is
  'FTA Tax Registration Number. Null until confirmed by the owner; invoice issuance validates it is present.';

create trigger legal_entity_updated_at before update on legal_entity
  for each row execute function set_updated_at();

create table premises (
  id                    smallint primary key default 1 check (id = 1),
  display_name          text        not null,
  address_line_1        text        not null,
  address_line_2        text,
  floor                 text,
  area                  text        not null,          -- Al Zahiyah (Al Mina)
  emirate               text        not null default 'Abu Dhabi',
  country_code          char(2)     not null default 'AE',
  po_box                text,
  makani_number         text,
  latitude              numeric(9,6),
  longitude             numeric(9,6),
  plus_code             text,
  google_place_id       text,
  phone_landline        text,
  phone_mobile          text,
  phone_whatsapp        text,
  email                 text,
  parking_notes         text,
  directions_notes      text,
  timezone              text        not null default 'Asia/Dubai',
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table premises is
  'The building. Singleton. THE single source of truth for NAP: every schema block, footer, map '
  'embed, sitemap entry and facts endpoint derives from here. No address is hard-coded anywhere '
  '(asserted by a grep test). See docs/09 §4.';

create trigger premises_updated_at before update on premises
  for each row execute function set_updated_at();

-- Opening hours. Trading runs 11:00–02:00, so close_time is LESS than open_time and the interval
-- crosses midnight. `crosses_midnight` is generated rather than derived in application code so
-- every consumer agrees. See docs/13 §2.
create table premises_hours (
  id                smallint    primary key generated always as identity,
  day_of_week       smallint    not null check (day_of_week between 0 and 6),   -- 0 = Sunday
  open_time         time        not null,
  close_time        time        not null,
  crosses_midnight  boolean     not null generated always as (close_time <= open_time) stored,
  is_closed         boolean     not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (day_of_week)
);
comment on column premises_hours.crosses_midnight is
  'True when close_time <= open_time, e.g. 11:00–02:00. Generated, so no caller can disagree.';

create trigger premises_hours_updated_at before update on premises_hours
  for each row execute function set_updated_at();

-- Dated exceptions: public holidays (lunar, announced at short notice, so provisional vs confirmed
-- matters), Ramadan hours, maintenance closures.
create table premises_closure (
  id            uuid        primary key default uuid_generate_v7(),
  starts_on     date        not null,
  ends_on       date        not null,
  reason        text        not null,
  kind          text        not null check (kind in ('public_holiday','ramadan_hours','maintenance','other')),
  is_confirmed  boolean     not null default false,
  open_time     time,                       -- set for reduced hours rather than full closure
  close_time    time,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (ends_on >= starts_on)
);
comment on column premises_closure.is_confirmed is
  'UAE public holidays are lunar and announced late. A provisional date must be distinguishable so '
  'the impact report can list affected bookings when it is confirmed.';

create trigger premises_closure_updated_at before update on premises_closure
  for each row execute function set_updated_at();

create index premises_closure_range_idx on premises_closure (starts_on, ends_on);
