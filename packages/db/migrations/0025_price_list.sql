-- 0025 — effective-dated price lists: the third layer of the price resolution chain.
--
-- `service_variant.gross_price_fils` (0017) answers "what does a 60-minute Asian massage cost?" with one
-- number and no date. That is the right answer for the catalogue and the wrong answer for a business
-- that changes its prices: a price rise applied by UPDATE-ing the variant rewrites history, and every
-- report that recomputes a figure rather than reading a snapshot then reports the new price against last
-- month's bookings. This table adds the date.
--
-- ## Why a separate table rather than valid_from/valid_to on service_variant
--
-- Because a variant is a menu item and a price list is a period. Putting the dates on the variant would
-- make "the 60-minute Asian massage" several rows, and every foreign key that names a variant — the
-- booking price snapshot, the availability lookup, B-CAT-05's archive rule — would have to pick one of
-- them. The variant stays one row, its own gross is the fallback, and this table overrides it for a
-- stated period.
--
-- ## The exclusion constraint is the whole point
--
-- Two overlapping rows for one variant make "the price on the 3rd of March" a question with two answers,
-- and which one a query returns would depend on the plan. An application-level check cannot close it:
-- two concurrent inserts each see no conflict and both commit. `EXCLUDE USING gist` is evaluated by the
-- index, so the second one blocks and then fails — the same mechanism, and the same reasoning, as
-- `period_lock_no_overlap` in 0018_ledger.sql and the appointment constraint of ADR 0015.
--
-- The range is `daterange(valid_from, valid_to, '[]')`: **inclusive at both ends**, because `valid_to` is
-- the last day the price applies, not the first day after it. An exclusive upper bound expires a menu one
-- day early exactly once — on the row somebody entered by copying the end date off a poster — and nobody
-- finds it until a customer is charged the old price on the last day of a promotion. A NULL `valid_to`
-- is an unbounded range: the price applies until another row supersedes it, which is what an ordinary
-- price rise looks like.
--
-- `packages/core/src/pricing/resolve-price.ts` mirrors exactly this window in
-- `windowStateOn`, and `packages/fixtures/src/price-resolution.itest.ts` asserts the two agree by
-- resolving the same date against both.
--
-- The validity is held as two `date` columns with the range built in the constraint expression, rather
-- than as a stored `daterange` column. Same choice as `period_lock` in 0018_ledger.sql, same reason: the
-- question this table is actually asked is "what is the price on this date", which is a comparison
-- against each bound, and `valid_from <= $1 and ($1 <= valid_to or valid_to is null)` is both indexable
-- and readable. A stored range would make that query a containment test against a value PostgreSQL has
-- already canonicalised to a half-open form, so `valid_to` would read back as the day AFTER the last day
-- the price applied — the one fact anybody entering a promotion needs to get right.
--
-- ## No net or VAT columns
--
-- Gross is authoritative (docs/01 decision 7) and net and VAT are derived from it as
-- `net = round(gross × 20 / 21)`, `vat = gross − net`. Storing all three here would create three places
-- for the same fact and one of them would eventually disagree. The derivation lives in
-- `@berelax/core`'s `splitGross`; what gets stored is the appointment's snapshot at booking time
-- (B-AVAIL-06), not a second copy of the price list.
--
-- ## A fractional price is refused on the path the application uses
--
-- `gross_price_fils` is the `fils` domain, i.e. `bigint`. Written as a SQL literal, `250.5` is a
-- **numeric constant** that PostgreSQL rounds to 251 on the way into a bigint, silently — B-CAT-03's
-- agent found this the hard way. Every write from the application arrives as a bind parameter, where the
-- bigint input function parses the text and raises 22P02, so that is the path
-- `packages/db/src/schema/price-list.itest.ts` asserts, and it asserts the rounding of the literal path
-- as well so the trap is visible rather than described.

begin;

create table price_list (
  id                 uuid        primary key default uuid_generate_v7(),
  -- One price list row prices one variant for one period. Keyed on the variant rather than on the
  -- service because duration is the pricing axis (ADR 0021): a Ramadan menu that discounted every
  -- duration by the same amount would still be four rows, and one row for a service would have no
  -- answer to "which duration".
  service_variant_id uuid        not null references service_variant (id) on delete cascade,
  -- VAT-inclusive gross, integer fils, exactly as on service_variant.
  gross_price_fils   fils        not null,
  -- What this price list is, in words: 'Ramadan 2027 menu', 'March 2027 price rise'. Not decoration —
  -- it is what appears next to the figure when somebody asks why a booking was priced this way, and a
  -- price list row with no label is a price change nobody can account for.
  label              text        not null,
  valid_from         date        not null,
  -- The LAST day this price applies. NULL is open-ended. See the header on the inclusive upper bound.
  valid_to           date,
  -- The same provenance trio as app_setting (0010) and the catalogue (0017), so the Unconfirmed
  -- Assumptions panel reads one shape everywhere. A derived price — the price-on-request figures of
  -- docs/13 section 4, for instance — is provisional and must name the question it is waiting on.
  is_provisional     boolean     not null default false,
  provisional_note   text,
  open_question_id   text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- Strictly positive, like service_variant_price_positive. Zero is a missing price, not a free
  -- treatment: it would pass a non-negative check, invoice as 0.00 and reconcile to nothing.
  constraint price_list_gross_positive check (gross_price_fils > 0),
  constraint price_list_label_nonempty check (btrim(label) <> ''),
  -- A one-day price list is legitimate (valid_to = valid_from); a window that ends before it starts is
  -- a typo that would otherwise create a row matching no date at all and silently do nothing.
  constraint price_list_valid_to_not_before_from
    check (valid_to is null or valid_to >= valid_from),
  -- The guarantee this table exists for. See the header: an application-level check cannot hold it
  -- under concurrency, and the ambiguity it prevents is a price with two answers.
  constraint price_list_no_overlap
    exclude using gist (
      service_variant_id with =,
      (daterange(valid_from, valid_to, '[]')) with &&
    ),
  constraint price_list_provisional_names_a_question
    check (not is_provisional or open_question_id is not null)
);

comment on table price_list is
  'Effective-dated gross price overrides per service_variant. Layer 3 of the resolution chain in '
  'packages/core/src/pricing/resolve-price.ts: base -> variant -> price_list -> promotion. At most one '
  'row per variant covers any given date, enforced by price_list_no_overlap.';
comment on column price_list.gross_price_fils is
  'VAT-inclusive gross in integer fils (docs/01 decision 7). Net and VAT are derived as '
  'net = round(gross * 20 / 21) and vat = gross - net; neither is stored here.';
comment on column price_list.valid_to is
  'The LAST day this price applies, not the first day after it — the range is inclusive at both ends. '
  'NULL is open-ended: the price holds until a later row supersedes it.';
comment on constraint price_list_no_overlap on price_list is
  'Two overlapping rows would make the price on a given date ambiguous, and which one a query returned '
  'would depend on the plan. Enforced by the gist index rather than by the application, because two '
  'concurrent inserts each see no conflict and both commit.';

create trigger price_list_updated_at before update on price_list
  for each row execute function set_updated_at();

-- The lookup the resolver drives: every row for one variant, ordered so the effective one is found by a
-- range scan rather than a sort. The gist index behind the exclusion constraint answers overlap
-- questions, not this one — it cannot be used for an ordered read of one variant's history.
create index price_list_variant_valid_from_idx on price_list (service_variant_id, valid_from desc);

commit;
