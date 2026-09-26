-- 0078 — versioned package templates, and a package sale that is a LIABILITY rather than a sale.
--
-- Two things, and the whole file is about keeping them apart: what the business currently offers, which
-- changes, and what a customer actually bought, which never does.
--
-- ## 1. A template is EDITED by inserting a new version, and a version is immutable
--
-- `package_template` is the identity — a stable `template_key` and nothing else that can be wrong.
-- `package_template_version` holds everything a buyer agrees to: the price, the sessions, the validity,
-- the transferability, the treatment of an unredeemed balance. It refuses UPDATE and DELETE outright
-- (ZG001), so "edit the six-massage package" is `insert ... version = 2` and the row every outstanding
-- balance points at cannot be reached by the edit at all.
--
-- The alternative — an UPDATE plus a snapshot on the sale — was rejected, and not because the snapshot is
-- wrong. It is here too (§3). It was rejected because the snapshot would be the ONLY record: a customer
-- disputing "I was told twelve sessions" would be answered from a row the business had overwritten, and
-- the version that was on sale on the day would exist nowhere. 0072 took the same decision one document
-- along and C-AUTO-06 took it for flow definitions. This is the third, and the argument has not changed.
--
-- The CURRENT version of a template is `max(version)`. There is deliberately no `current_version_id`
-- pointer: a pointer is a second answer to a question `max()` already answers, and the failure mode is a
-- pointer at a version a later insert superseded — which reads as a template that quietly stopped being
-- editable. `package_template.retired_at` withdraws the whole template from sale; a retired template's
-- versions stay, because balances point at them.
--
-- A version with NO lines is an entitlement to nothing sold for money. Refused at COMMIT
-- (`package_template_version_has_lines`, ZG004) rather than per row, because the version and its lines are
-- separate INSERTs in one transaction and an immediate check would fire on the version before its own
-- lines existed.
--
-- ## 2. A line may not reference an ARCHIVED catalogue service
--
-- `package_template_line.service_variant_id` points into B-CAT's catalogue, and
-- `package_template_line_service_not_archived` (ZG003) refuses a line whose service has `archived_at`
-- set. Selling six sessions of a treatment the salon has withdrawn is a promise nobody can keep: the
-- availability solver will not offer it (`service_bookable_idx` is partial on
-- `published_at is not null and archived_at is null`), so the customer's money buys an appointment that
-- cannot be booked.
--
-- Checked at INSERT and never afterwards. A service archived AFTER a version was saved does NOT
-- invalidate that version: versions are immutable, the balances sold under it are contracts, and the
-- remedy is a new version without the line. Making archiving retro-active would mean a catalogue change
-- silently voiding paid-for entitlements, which is worse than the thing it would prevent.
--
-- A DRAFT service (`published_at is null`) is deliberately ALLOWED. A draft becomes published; archived is
-- terminal. Refusing drafts would stop a package being prepared alongside the treatment it sells, which
-- is the normal order of work, and nothing in the acceptance asks for it.
--
-- ## 3. A sale SNAPSHOTS the terms, and the snapshot is held equal to the version it names
--
-- `package_sale` carries the price, the session count, the validity, the transferability and the
-- unredeemed-balance policy as its own columns, even though the version it points at is immutable and
-- holds all five. Two copies of one fact is normally the defect this codebase fights, so the reason has
-- to be good, and it is the same one `invoice` snapshots the issuer's legal name for: the sale is the
-- CONTRACT, and a contract has to be readable as a document rather than as a join. It is also what makes
-- `package_balance` and every later reconciliation independent of a version row somebody may one day
-- decide to re-key.
--
-- The two cannot drift, because `package_sale_terms_match_version` (ZG002) holds them equal at COMMIT —
-- all five columns plus `session_count` against `sum(package_template_line.session_count)`. So the
-- snapshot is a copy the database refuses to let disagree, which is a different thing from a copy nobody
-- checks.
--
-- ## 4. The posting: a sale credits a LIABILITY, and touches no revenue and no VAT
--
--     Dr  1010 / 1040 / 1020   each tender, at what was handed over
--       Cr  2050              Deferred revenue — packages, at the FULL gross
--
-- **[UNVERIFIED] Y11-vat-package.** Whether the date of supply on a prepaid package is the sale or the
-- redemption is a tax-agent question. The provisional answer is the redemption, which is the strictest
-- safe one: the salon holds the money as a liability and recognises nothing until a treatment is
-- delivered, so an uncorrected assumption cannot understate an output-VAT box that has already been filed.
--
-- `package_sale_posts_deferred_revenue_only` (ZG005, DEFERRED) is that rule as a database refusal. It
-- requires the named entry to be dated on the sale's own business day, to credit `2050` by exactly the
-- price, and to move NOTHING on any account the chart types as `revenue` and nothing on `2030`. It
-- measures the TOTAL movement — debits plus credits — and not the net, because a posting that credited
-- `4010` and debited the contra `4095` by the same figure nets to zero and has recognised revenue on a
-- package sale.
--
-- Releasing `2050` into `4020` and `2030` at redemption is M-TILL-10's. Nothing here assumes which end
-- the VAT event sits at: if the answer moves it to the sale, ZG005's predicate changes and no table does.
--
-- ## 5. The price is ALLOCATED across the lines, and stored
--
-- `package_balance.value_fils` is the share of the sale's gross that line carries, allocated in
-- proportion to what the line would have cost at the version's own prices, largest-remainder so the
-- shares sum to the price EXACTLY. `package_balance_shares_sum_to_the_price` (ZG006, DEFERRED) holds
-- that identity in the database. Without the allocation a redemption has no figure to release: "the
-- package cost 3,000" does not say what one facial out of it was worth, and re-deriving the share at
-- redemption time would give a different answer the moment the catalogue's prices moved.
--
-- `sessions_redeemed` and `released_fils` start at zero and are M-TILL-10's to move. Their ceilings
-- (`package_balance_cannot_overdraw`, `package_balance_cannot_overrelease`) are declared HERE, with the
-- columns, because a ceiling added later is a ceiling that was absent while rows were being written.
--
-- ## 6. What is deliberately NOT here
--
-- No `package_redemption`, no expiry job, no breakage posting, no transfer. All four are M-TILL-10's.
-- `expires_on` is generated here because it is a property of the sale, and M-TILL-10 reads it; a second
-- derivation in TypeScript would be a second answer about when a customer's money runs out.
--
-- No invoice. Whether a prepaid package gets a tax invoice at sale depends on Y11-vat-package: if the
-- supply is at redemption there is nothing to state as a standard-rated supply on the day the money is
-- taken. A document naming a VAT figure of zero would be a claim about the answer, so this unit issues
-- none and `package_sale` stands alone. M-TILL-12's, once the tax agent has answered.
--
-- No customer-facing package NAMES in a seed. `internal_name` and `public_display_name` are supplied by
-- whoever configures a package; what the business actually sells is a FACT nobody has stated (brief rule
-- 15), and a plausible "6 Massage Package" seeded here would be indistinguishable from a configured one.

-- ---------------------------------------------------------------------------------------------
-- Custom SQLSTATEs. Class 'ZG' is unused by PostgreSQL and reserved by the standard for user-defined
-- conditions, and a caller has to tell these six apart: matching on message text stops working the first
-- time somebody improves the wording, and the code that then treats an archived service as an unknown
-- failure is the code that retries it.
--
-- 'ZG' and NOT the mnemonic 'ZP', which this file used until the collision was found: 0056_consent.sql
-- already raises ZP001, ZP002 and ZP003. Two files raising one code is worse than an unmemorable letter —
-- `packageError` would have translated a consent refusal as a package refusal and `consentError` the
-- reverse, and both translations match on SQLSTATE alone precisely so that a wording change cannot break
-- them. What a private code has to be is unique to one file, not memorable (0077's wording).
--
--   ZG001  a package_template_version or package_template_line row was UPDATEd or DELETEd
--   ZG002  a sale's snapshotted terms disagree with the version it names
--   ZG003  a template line references an archived catalogue service
--   ZG004  a template version has no lines
--   ZG005  a sale's journal entry is not a pure deferred-revenue posting
--   ZG006  the balances' shares do not sum to the price the sale was made at
-- ---------------------------------------------------------------------------------------------

create table package_template (
  id            uuid        primary key default uuid_generate_v7(),
  -- Lower snake case, so a display-label change cannot silently become a second package. cash_drawer's
  -- reason (0076), and the same shape.
  template_key  text        not null unique
                  constraint package_template_key_is_snake_case
                  check (template_key ~ '^[a-z][a-z0-9_]*$'),
  -- Withdrawn from sale rather than deleted: every version and every balance sold under one points here,
  -- and a package somebody has paid for has to keep resolving. NULL means on sale.
  retired_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger package_template_set_updated_at
  before update on package_template
  for each row execute function set_updated_at();

comment on table package_template is
  'The identity of a package. Everything a buyer agrees to is on package_template_version, which is '
  'immutable — so editing a package inserts a new version and the balances sold under the old one are '
  'untouched. The current version is max(version); there is no pointer column, because a pointer is a '
  'second answer to a question max() already answers.';

create table package_template_version (
  id                        uuid        primary key default uuid_generate_v7(),
  template_id               uuid        not null references package_template (id) on delete restrict,
  -- 1, 2, 3 … An edit is the next one. Positional rather than timed, so two reads list the versions in
  -- the same order (0063's reason for payment.tender_no).
  version                   smallint    not null
                              constraint package_template_version_positive check (version >= 1),
  -- The front desk's own words, and the public name. Split for `service`'s reason (0017): the public one
  -- reaches a customer and is linted, the internal one is unconstrained.
  internal_name             text        not null
                              constraint package_template_version_internal_name_nonempty
                              check (btrim(internal_name) <> ''),
  public_display_name       text        not null
                              constraint package_template_version_public_name_nonempty
                              check (btrim(public_display_name) <> ''),
  -- VAT-INCLUSIVE GROSS in integer fils (ADR 0007). Strictly positive, not merely non-negative: zero is
  -- a missing price, and it would take a customer's nothing and credit a liability of nothing rather
  -- than failing anywhere a human would look.
  price_fils                fils_nonneg not null
                              constraint package_template_version_price_positive
                              check (price_fils > 0),
  -- Y9-package-policy, provisionally 6. Bounded rather than free: a validity of 0 months is a package
  -- that expires before the customer leaves the building, and one of 600 is an unbounded liability.
  validity_months           smallint    not null
                              constraint package_template_version_validity_bounded
                              check (validity_months between 1 and 60),
  -- Y9-package-policy, provisionally false. A transferable balance can be moved between customers, which
  -- is both a fraud path and a data-protection question nobody has been asked.
  transferable              boolean     not null,
  -- Y9-package-policy, provisionally 'retained'. A text column with a CHECK rather than an enum, for
  -- cash_session.status's reason (0076): the vocabulary is two words and an enum is a migration to widen.
  unredeemed_balance_policy text        not null
                              constraint package_template_version_balance_policy_known
                              check (unredeemed_balance_policy in ('retained', 'forfeited')),
  -- The same provenance trio as app_setting, read by the Unconfirmed Assumptions panel. Per VERSION and
  -- not per column: the three policy figures are one decision somebody takes in one sitting, and a
  -- separate flag per column would let the panel clear for an answer nobody gave. working_hours_rule's
  -- argument (0059), and the same shape — answering Y9-package-policy publishes a NEW version, and the
  -- panel row leaves by that version being confirmed rather than by this one being edited.
  is_provisional            boolean     not null,
  provisional_note          text,
  open_question_id          text,
  created_at                timestamptz not null default now(),
  constraint package_template_version_one_row_per_number unique (template_id, version),
  constraint package_template_version_provisional_names_a_question
    check (not is_provisional or open_question_id is not null)
);

create index package_template_version_template_idx
  on package_template_version (template_id, version desc);

comment on table package_template_version is
  'Immutable: UPDATE and DELETE raise (ZG001). Editing a package inserts version + 1, so every '
  'package_sale stays on the version it was sold under and its terms, price and session count cannot be '
  'restated by a later edit. No updated_at, because there is no second version of a row here.';

create table package_template_line (
  id                  uuid        primary key default uuid_generate_v7(),
  template_version_id uuid        not null
                        references package_template_version (id) on delete restrict,
  line_no             smallint    not null
                        constraint package_template_line_no_positive check (line_no >= 1),
  -- Duration x price is the only pricing axis (ADR 0021), so a package entitles its buyer to a VARIANT
  -- and not to a service: "six massages" without a duration is six of a price the catalogue does not
  -- have. ON DELETE RESTRICT because service_variant is archived, never deleted (0024's reason).
  service_variant_id  uuid        not null references service_variant (id) on delete restrict,
  session_count       smallint    not null
                        constraint package_template_line_sessions_positive check (session_count >= 1),
  created_at          timestamptz not null default now(),
  constraint package_template_line_one_row_per_number unique (template_version_id, line_no),
  -- One line per variant. Two lines for one variant is one entitlement expressed twice, and it would
  -- give package_balance two rows a redemption could draw down in either order — so "which of my four
  -- massages did that use" would have two answers.
  constraint package_template_line_one_row_per_variant unique (template_version_id, service_variant_id)
);

create index package_template_line_variant_idx on package_template_line (service_variant_id);

comment on table package_template_line is
  'Immutable with its version: UPDATE and DELETE raise (ZG001). A line may not reference an ARCHIVED '
  'catalogue service (ZG003), because the availability solver will not offer one — so the money would '
  'buy an appointment that cannot be booked. Checked at INSERT only: archiving a service afterwards does '
  'not void a paid-for entitlement.';

create table package_sale (
  id                        uuid        primary key default uuid_generate_v7(),
  -- Who bought it. ON DELETE RESTRICT: a balance is money owed to a person, and 0019's customer rows are
  -- merged rather than deleted (C-CRM-05).
  customer_id               uuid        not null references customer (id) on delete restrict,
  -- The version sold under, and the row a dispute is answered from. RESTRICT, so a version somebody has
  -- sold cannot be removed even by a migration that was trying to tidy up.
  template_version_id       uuid        not null
                              references package_template_version (id) on delete restrict,
  -- The BUSINESS DAY, the same column name the other ten tables carrying this quantity use (0011,
  -- business_day's own primary key included). Trading runs 11:00-02:00, so a 01:30 sale belongs to the
  -- previous trading date and a validity counted from the calendar date would expire a day early.
  trading_date              date        not null
                              references business_day (trading_date)
                              on update cascade on delete restrict,
  -- --- the snapshot. Held equal to the version by ZG002 at COMMIT. --------------------------------
  price_fils                fils_nonneg not null
                              constraint package_sale_price_positive check (price_fils > 0),
  session_count             smallint    not null
                              constraint package_sale_sessions_positive check (session_count >= 1),
  validity_months           smallint    not null
                              constraint package_sale_validity_bounded
                              check (validity_months between 1 and 60),
  transferable              boolean     not null,
  unredeemed_balance_policy text        not null
                              constraint package_sale_balance_policy_known
                              check (unredeemed_balance_policy in ('retained', 'forfeited')),
  -- The ONE derivation of when the customer's money runs out, and it lives here rather than in
  -- TypeScript because a second copy is a second answer. `make_interval` and `date + interval` are both
  -- immutable, which is what lets a generated column hold it; M-TILL-10 reads this column to decide
  -- whether a redemption is in time, and evaluates the INSTANT against business_day rather than
  -- re-deriving the date.
  expires_on                date        not null
                              generated always as
                              ((trading_date + make_interval(months => validity_months))::date) stored,
  -- MANDATORY and a real foreign key. Money taken with no entry behind it is the state that makes the
  -- deferred-revenue balance unexplainable, and nothing truncates the journal, so the key costs nothing.
  journal_entry_id          text        not null references journal_entry (entry_id),
  sold_at                   timestamptz not null default now(),
  created_at                timestamptz not null default now()
);

create index package_sale_customer_idx on package_sale (customer_id, trading_date desc);
create index package_sale_version_idx on package_sale (template_version_id);
create index package_sale_expiry_idx on package_sale (expires_on);
create unique index package_sale_one_per_entry on package_sale (journal_entry_id);

comment on table package_sale is
  'The TERMS are immutable: UPDATE and DELETE raise (ZG001), except that a customer merge may re-point '
  'customer_id and nothing else. A sale is a contract, so its terms are snapshotted and '
  'held equal to the version it names by ZG002 at COMMIT. Its journal entry credits 2050 at the full '
  'gross and moves nothing on revenue and nothing on 2030 (ZG005): [UNVERIFIED] Y11-vat-package puts the '
  'date of supply at redemption. No updated_at, because there is no second version of a row here.';

create table package_balance (
  id                 uuid        primary key default uuid_generate_v7(),
  package_sale_id    uuid        not null references package_sale (id) on delete restrict,
  -- The template line this balance came from, by number. Carried rather than joined so a balance reads
  -- as a row: "line 2 of what you bought", in the order the version states it.
  line_no            smallint    not null
                       constraint package_balance_line_no_positive check (line_no >= 1),
  service_variant_id uuid        not null references service_variant (id) on delete restrict,
  sessions_total     smallint    not null
                       constraint package_balance_sessions_positive check (sessions_total >= 1),
  -- M-TILL-10's to move. The ceiling is declared HERE, with the column, because a ceiling added later is
  -- a ceiling that was absent while rows were being written.
  sessions_redeemed  smallint    not null default 0
                       constraint package_balance_redeemed_nonneg check (sessions_redeemed >= 0),
  -- The share of the sale's gross this line carries, allocated largest-remainder so the shares sum to
  -- the price exactly (ZG006). What a redemption releases from 2050, and never re-derived: re-deriving it
  -- at redemption time would give a different answer the moment the catalogue's prices moved.
  value_fils         fils_nonneg not null
                       constraint package_balance_value_positive check (value_fils > 0),
  released_fils      fils_nonneg not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint package_balance_one_row_per_line unique (package_sale_id, line_no),
  constraint package_balance_one_row_per_variant unique (package_sale_id, service_variant_id),
  -- Sessions redeemed never exceed sessions sold, and value released never exceeds value sold. Two
  -- ceilings and not one: a drawdown moves both, and a redemption that moved only the money would leave
  -- an entitlement nobody can count.
  constraint package_balance_cannot_overdraw check (sessions_redeemed <= sessions_total),
  constraint package_balance_cannot_overrelease check (released_fils <= value_fils)
);

create index package_balance_sale_idx on package_balance (package_sale_id, line_no);
create index package_balance_variant_idx on package_balance (service_variant_id);

create trigger package_balance_set_updated_at
  before update on package_balance
  for each row execute function set_updated_at();

comment on table package_balance is
  'The entitlement, and the share of the sale price it carries. sessions_redeemed and released_fils are '
  'M-TILL-10''s to move; their ceilings are declared with the columns rather than added later. The shares '
  'sum to the sale price exactly (ZG006).';

-- ---------------------------------------------------------------------------------------------
-- Immutability. For EVERY role including the owner, 0072's and 0076's argument: the grants at the foot
-- of this file constrain berelax_app, and a migration or a psql session does not connect as berelax_app.
-- A version somebody has sold against is evidence about an agreement that happened.
-- ---------------------------------------------------------------------------------------------
create or replace function package_row_is_immutable() returns trigger
  language plpgsql as $$
begin
  raise exception
    'ZG001: %.% is immutable — a package version is EDITED by inserting version + 1, and a sale is a '
    'contract. % refused.',
    tg_table_schema, tg_table_name, tg_op
    using errcode = 'ZG001';
end;
$$;

create trigger package_template_version_no_update
  before update on package_template_version
  for each row execute function package_row_is_immutable();
create trigger package_template_version_no_delete
  before delete on package_template_version
  for each row execute function package_row_is_immutable();
create trigger package_template_line_no_update
  before update on package_template_line
  for each row execute function package_row_is_immutable();
create trigger package_template_line_no_delete
  before delete on package_template_line
  for each row execute function package_row_is_immutable();
create trigger package_sale_no_delete
  before delete on package_sale
  for each row execute function package_row_is_immutable();

-- ---------------------------------------------------------------------------------------------
-- A sale's TERMS are immutable. Its CUSTOMER may move, and exactly one thing moves it.
--
-- `package_sale` needs its own guard rather than `package_row_is_immutable()` because a customer MERGE
-- (C-CRM-05) has to re-point `customer_id`: two duplicate records are one person who paid for one
-- package, and a merge that could not follow the money would leave a live entitlement on a tombstone
-- nothing reads. `merge-participants.ts` registers this table as `repoint_update` for that reason.
--
-- The `invoice` and `credit_note` argument deliberately does NOT transfer. Those are allowlisted out of a
-- merge because they SNAPSHOT the customer's name, phone and TRN onto the document and the FTA reads
-- those columns, so a re-attributed invoice is a different document. A package sale snapshots no customer
-- identity at all — only the terms — and unlike a filed document it is an entitlement somebody is still
-- going to walk in and use. So this one follows the person.
--
-- Everything else is held by comparing the whole row with `customer_id` removed from both sides. A
-- column-by-column list would have to be extended every time a column is added, and the one time somebody
-- forgets is the time the terms become editable; `to_jsonb(row) - 'customer_id'` cannot be forgotten.
--
-- `expires_on` is removed from BOTH sides as well, and that is not a second exemption. PostgreSQL computes
-- a GENERATED column AFTER the BEFORE triggers have run, so `new.expires_on` is NULL here while
-- `old.expires_on` holds the stored date -- the two rows therefore differed on EVERY update, including the
-- customer re-point this function exists to permit, and the first version of it refused the merge it was
-- written for. Removing it costs nothing: it is generated from `trading_date` and `validity_months`, both
-- of which the comparison still covers, so it cannot change unless one of them does and that is refused.
-- ---------------------------------------------------------------------------------------------
create or replace function package_sale_terms_are_immutable() returns trigger
  language plpgsql as $$
begin
  if (to_jsonb(new) - 'customer_id' - 'expires_on')
       <> (to_jsonb(old) - 'customer_id' - 'expires_on') then
    raise exception
      'ZG001: a package sale is a contract and its terms are immutable. Only customer_id may change, '
      'and only a customer merge changes it. The remedy for wrong terms is a NEW version and a NEW sale.'
      using errcode = 'ZG001';
  end if;
  return new;
end;
$$;

create trigger package_sale_terms_are_immutable
  before update on package_sale
  for each row execute function package_sale_terms_are_immutable();

-- ---------------------------------------------------------------------------------------------
-- ZG003 — a line may not reference an ARCHIVED catalogue service.
--
-- BEFORE INSERT and per row, so the refusal names the line that caused it. It joins through
-- service_variant to service, because archiving is a property of the SERVICE (0029) and the variant is
-- what a package entitles its buyer to.
-- ---------------------------------------------------------------------------------------------
create or replace function package_template_line_service_not_archived() returns trigger
  language plpgsql as $$
declare
  archived timestamptz;
  label    text;
begin
  select s.archived_at, s.style::text || '/' || s.treatment_key
    into archived, label
    from service_variant v
    join service s on s.id = v.service_id
   where v.id = new.service_variant_id;

  if archived is not null then
    raise exception
      -- Deliberately does NOT repeat the service layer's wording. Both layers refuse this, and when the
      -- two messages share a phrase, deleting the service check leaves its suite green with the DATABASE
      -- answering instead — M-TILL-11 measured exactly that and it reported a gate as passing over a check
      -- that had been removed. The service says "is not bookable"; this says what a customer ends up with.
      'ZG003: line % references service %, archived at %. A package may not sell a treatment the '
      'availability solver will never offer: the money would buy an appointment nobody can make.',
      new.line_no, label, archived
      using errcode = 'ZG003';
  end if;
  return new;
end;
$$;

create trigger package_template_line_service_not_archived
  before insert on package_template_line
  for each row execute function package_template_line_service_not_archived();

-- ---------------------------------------------------------------------------------------------
-- ZG004 — a version with no lines. DEFERRED, because the version and its lines are separate INSERTs in
-- one transaction: an immediate check would fire on the version before its own lines existed.
-- ---------------------------------------------------------------------------------------------
create or replace function package_template_version_has_lines() returns trigger
  language plpgsql as $$
declare
  lines integer;
begin
  select count(*) into lines from package_template_line where template_version_id = new.id;
  if lines = 0 then
    raise exception
      'ZG004: package template version % has no lines. A version with no lines is an entitlement to '
      'nothing sold for money.',
      new.version
      using errcode = 'ZG004';
  end if;
  return null;
end;
$$;

create constraint trigger package_template_version_has_lines
  after insert on package_template_version
  deferrable initially deferred
  for each row execute function package_template_version_has_lines();

-- ---------------------------------------------------------------------------------------------
-- ZG002 — the snapshot is held equal to the version it names.
--
-- DEFERRED, because a sale and the version it points at may be inserted in one transaction and because
-- the session_count half reads package_template_line, whose rows arrive after the version's.
--
-- Every column is compared, and `session_count` against the SUM of the version's lines rather than
-- against a column: a total stored on the version would be a third copy of the same fact.
-- ---------------------------------------------------------------------------------------------
create or replace function package_sale_terms_match_version() returns trigger
  language plpgsql as $$
declare
  v        package_template_version;
  sessions integer;
begin
  select * into v from package_template_version where id = new.template_version_id;
  select coalesce(sum(session_count), 0) into sessions
    from package_template_line where template_version_id = new.template_version_id;

  if new.price_fils <> v.price_fils
     or new.validity_months <> v.validity_months
     or new.transferable is distinct from v.transferable
     or new.unredeemed_balance_policy <> v.unredeemed_balance_policy
     or new.session_count <> sessions then
    raise exception
      'ZG002: the terms snapshotted on this sale disagree with version % of the template it names. '
      'Sale: % fils, % session(s), % month(s), transferable %, balance %. Version: % fils, % '
      'session(s), % month(s), transferable %, balance %.',
      v.version,
      new.price_fils, new.session_count, new.validity_months, new.transferable,
      new.unredeemed_balance_policy,
      v.price_fils, sessions, v.validity_months, v.transferable, v.unredeemed_balance_policy
      using errcode = 'ZG002';
  end if;
  return null;
end;
$$;

create constraint trigger package_sale_terms_match_version
  after insert on package_sale
  deferrable initially deferred
  for each row execute function package_sale_terms_match_version();

-- ---------------------------------------------------------------------------------------------
-- ZG005 — the posting is a PURE deferred-revenue posting.
--
-- The rule of the unit, and the one Y11-vat-package's provisional answer IS. Four facts:
--
--   1. the entry is dated on the sale's own business day — a sale filed under another day's takings
--      lands in another VAT period, and at a period boundary in one that has already been filed;
--   2. it credits 2050 by EXACTLY the price;
--   3. total movement on every account the chart types as `revenue` is zero;
--   4. total movement on 2030 Output VAT payable is zero.
--
-- (3) and (4) measure debits PLUS credits and not the net, because a posting that credited 4010 and
-- debited the contra 4095 by the same figure nets to zero and has recognised revenue on a package sale.
-- That is not hypothetical: 4095 is a revenue-typed contra account in the same chart.
--
-- DEFERRED, because the entry, its lines and the sale are separate INSERTs in one transaction.
-- ---------------------------------------------------------------------------------------------
create or replace function package_sale_posts_deferred_revenue_only() returns trigger
  language plpgsql as $$
declare
  entry_day  date;
  deferred   bigint;
  revenue    bigint;
  output_vat bigint;
begin
  select e.entry_date into entry_day from journal_entry e where e.entry_id = new.journal_entry_id;
  if entry_day <> new.trading_date then
    raise exception
      'ZG005: the journal entry % for this package sale is dated % and the sale is on business day %. '
      'A sale filed under another day''s takings lands in another VAT period.',
      new.journal_entry_id, entry_day, new.trading_date
      using errcode = 'ZG005';
  end if;

  select coalesce(sum(l.credit_fils - l.debit_fils), 0) into deferred
    from journal_line l
   where l.entry_id = new.journal_entry_id and l.account_code = '2050';
  if deferred <> new.price_fils then
    raise exception
      'ZG005: the journal entry % credits 2050 Deferred revenue by % fils and the package was sold for '
      '% fils. The liability has to be the whole consideration.',
      new.journal_entry_id, deferred, new.price_fils
      using errcode = 'ZG005';
  end if;

  select coalesce(sum(l.debit_fils + l.credit_fils), 0) into revenue
    from journal_line l
    join account a on a.code = l.account_code
   where l.entry_id = new.journal_entry_id and a.type = 'revenue';
  if revenue <> 0 then
    raise exception
      'ZG005: the journal entry % moves % fils across revenue accounts. A package sale recognises no '
      'revenue: [UNVERIFIED] Y11-vat-package puts the date of supply at redemption, so the release of '
      '2050 into 4020 is M-TILL-10''s.',
      new.journal_entry_id, revenue
      using errcode = 'ZG005';
  end if;

  select coalesce(sum(l.debit_fils + l.credit_fils), 0) into output_vat
    from journal_line l
   where l.entry_id = new.journal_entry_id and l.account_code = '2030';
  if output_vat <> 0 then
    raise exception
      'ZG005: the journal entry % moves % fils on 2030 Output VAT payable. A package sale charges no '
      'output VAT under the provisional answer to Y11-vat-package.',
      new.journal_entry_id, output_vat
      using errcode = 'ZG005';
  end if;
  return null;
end;
$$;

create constraint trigger package_sale_posts_deferred_revenue_only
  after insert on package_sale
  deferrable initially deferred
  for each row execute function package_sale_posts_deferred_revenue_only();

-- ---------------------------------------------------------------------------------------------
-- ZG006 — the balances' shares sum to the price, and there is one balance per line of the version.
--
-- DEFERRED and fired from the SALE, so a sale with no balances at all is refused too: fired from
-- package_balance it would pass for a sale that opened none, which is the case that loses the whole
-- allocation.
-- ---------------------------------------------------------------------------------------------
create or replace function package_balance_shares_sum_to_the_price() returns trigger
  language plpgsql as $$
declare
  shares   bigint;
  sessions integer;
  balances integer;
  lines    integer;
begin
  select coalesce(sum(value_fils), 0), coalesce(sum(sessions_total), 0), count(*)
    into shares, sessions, balances
    from package_balance where package_sale_id = new.id;
  select count(*) into lines
    from package_template_line where template_version_id = new.template_version_id;

  if balances <> lines then
    raise exception
      'ZG006: this sale opened % balance(s) and the version it names has % line(s). Every line of a '
      'package a customer paid for has to be an entitlement they can draw on.',
      balances, lines
      using errcode = 'ZG006';
  end if;

  -- The line NUMBERS, and not only how many there are. A count alone accepts a balance numbered 3 against
  -- a two-line version: the right number of entitlements, one of them naming a line that does not exist.
  -- `package_balance_one_row_per_line` cannot see it (it only forbids a repeat) and no foreign key can,
  -- because a line is keyed on (template_version_id, line_no) and a balance knows the SALE — carrying the
  -- version id onto the balance to make a composite key possible would be another copy to hold equal.
  -- So the set is compared here, where both are already in hand.
  if exists (
    select 1 from package_balance b
     where b.package_sale_id = new.id
       and not exists (
         select 1 from package_template_line l
          where l.template_version_id = new.template_version_id and l.line_no = b.line_no
       )
  ) then
    raise exception
      'ZG006: this sale opened a balance numbered for a line the version it names does not have. A '
      'balance is "line N of what you bought", so a number naming no line is an entitlement nobody '
      'can read back.'
      using errcode = 'ZG006';
  end if;
  if shares <> new.price_fils then
    raise exception
      'ZG006: the balances opened by this sale are worth % fils in total and the package was sold for '
      '% fils. The allocation is largest-remainder precisely so the shares sum to the price exactly.',
      shares, new.price_fils
      using errcode = 'ZG006';
  end if;
  if sessions <> new.session_count then
    raise exception
      'ZG006: the balances opened by this sale carry % session(s) and the sale snapshotted %.',
      sessions, new.session_count
      using errcode = 'ZG006';
  end if;
  return null;
end;
$$;

create constraint trigger package_balance_shares_sum_to_the_price
  after insert on package_sale
  deferrable initially deferred
  for each row execute function package_balance_shares_sum_to_the_price();

-- ---------------------------------------------------------------------------------------------
-- Grants.
--
-- 0009 granted the application role select, insert, update and delete on every table in public AND set
-- default privileges extending that to tables created later — so these five ARRIVED with UPDATE and
-- DELETE already granted. The door is held twice, 0072's, 0075's and 0076's arrangement: the triggers
-- above refuse for every role, and the grants below refuse before a trigger is reached.
--
-- The table-level REVOKE has to come FIRST. A column-list grant does not narrow an existing table-level
-- one, and leaving the revoke out cost 0076 a whole run.
-- ---------------------------------------------------------------------------------------------
grant select, insert on
  package_template, package_template_version, package_template_line, package_sale, package_balance
  to berelax_app;

revoke update, delete on package_template_version, package_template_line from berelax_app;

-- `package_sale` keeps UPDATE on ONE column: a customer merge re-points `customer_id` and nothing else
-- may move. The table-level revoke comes first because a column-list grant does not narrow an existing
-- table-level one.
revoke update, delete on package_sale from berelax_app;
grant update (customer_id) on package_sale to berelax_app;

-- package_template keeps UPDATE: retiring a template is an UPDATE of retired_at and nothing else, so the
-- grant is narrowed to that one column rather than removed.
revoke update, delete on package_template from berelax_app;
grant update (retired_at) on package_template to berelax_app;

-- package_balance is drawn down by M-TILL-10, which moves exactly these two columns. Narrowed now rather
-- than left open for it: a grant nobody has needed yet is a grant nobody has argued for.
revoke update, delete on package_balance from berelax_app;
grant update (sessions_redeemed, released_fils) on package_balance to berelax_app;

-- TRUNCATE fires no row-level trigger, so the refusals above would not see it. 0009 never granted it;
-- stated explicitly because "it was never granted" and "we checked" are different facts.
revoke truncate on
  package_template, package_template_version, package_template_line, package_sale, package_balance
  from berelax_app;

grant select on
  package_template, package_template_version, package_template_line, package_sale, package_balance
  to berelax_readonly;
