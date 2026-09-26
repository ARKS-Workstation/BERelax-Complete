-- 0083 — the redemption: the drawdown, the VAT event, expiry, and the payment row a package sale never
-- wrote.
--
-- 0078 sold a package and put the whole consideration into `2050 Deferred revenue — packages`. This file
-- is the other end: a treatment delivered against that entitlement, which draws the balance down, releases
-- the liability, and recognises the supply. Everything here is about making "what the salon still owes"
-- a figure the database cannot let drift.
--
-- ## 1. The posting, and why THIS is where the VAT is
--
--     Dr  2050   Deferred revenue — packages, at the released GROSS
--       Cr  4020 Package redemption revenue, at the NET
--       Cr  2030 Output VAT payable, at the VAT
--
-- **[UNVERIFIED] Y11-vat-package.** Whether the date of supply on a prepaid package is the sale or the
-- redemption is a tax-agent question and nobody has answered it. The provisional answer — 0078's, and the
-- strictest safe one — is the REDEMPTION: nothing is recognised until a treatment is actually delivered, so
-- an uncorrected assumption cannot understate an output-VAT box that has already been filed.
--
-- `package_redemption_posts_the_release` (ZG008, DEFERRED) is that rule as a database refusal, and it is
-- ZG005's mirror made stricter. ZG005 could say "nothing on revenue"; this one has to say "exactly this much
-- on exactly this revenue account and nothing on any other", because a release is the first time a package
-- is allowed to touch revenue at all and "some revenue moved" is no longer a refusal. It measures the
-- movement on every OTHER revenue account as debits PLUS credits, for ZG005's reason: an entry crediting
-- `4010` and debiting the contra `4095` by the same figure nets to zero and has recognised revenue in the
-- wrong place, on the wrong VAT box, with the trial balance still balancing.
--
-- If the owner answers Y11-vat-package the other way — supply at SALE — what changes is ZG005's predicate
-- and this one's: the sale would credit `4020` net and `2030` the VAT, and a redemption would move nothing
-- but the balance. No table in either file changes, because a balance still has to be drawn down.
--
-- ## 2. What a redemption releases, and why the answer is a closed form
--
-- A balance carries `value_fils` — its share of the sale's gross, allocated once at the sale (0078 §5) —
-- and `sessions_total` sessions. Redeeming the r-th session has to release a figure, the figures have to
-- sum to `value_fils` EXACTLY over all `sessions_total` of them (ADR 0007), and the r-th figure must not
-- depend on the order the sessions were taken in.
--
--     release_through(value, total, redeemed) = ceil(value * redeemed / total)
--
-- and one redemption of `u` sessions releases `release_through(v, n, r + u) - release_through(v, n, r)`.
-- `package_release_through_fils` below is that function, in integer arithmetic, and it is the ONE statement
-- of the rule: ZG009 re-adds it over the rows, the service checks a caller's figure against it before
-- anything is written, and `packages/core/src/money/package-drawdown.ts` computes the same expression in
-- `BigInt` so a posting can be built without a round trip. Three readers of one formula.
--
-- **It is deliberately NOT `allocateByWeight` over equal weights**, which is what `@berelax/core` uses for
-- the per-LINE split, and the difference is real: largest-remainder gives the spare fils to the FIRST
-- sessions, this gives them to sessions spread evenly through the course. Both sum to `value_fils` exactly
-- and neither is more correct commercially. The closed form was chosen because a cumulative total is what a
-- constraint has to check, and checking a largest-remainder allocation in SQL means reimplementing
-- largest-remainder in PL/pgSQL — a second implementation of an arithmetic rule, which is the defect this
-- codebase spends most of its constraints preventing. A closed form has no second implementation: it is one
-- expression, and the census in `packages/fixtures/src/package-redemption.itest.ts` holds the SQL and the
-- TypeScript equal over every (value, total, redeemed) in a bounded box rather than trusting that they read
-- the same.
--
-- ## 3. The drawdown is the balance's own columns, and ZG009 is what makes them mean something
--
-- `package_balance.sessions_redeemed` and `released_fils` are the authoritative drawdown — 0078 declared
-- them with their ceilings (`package_balance_cannot_overdraw`, `package_balance_cannot_overrelease`)
-- precisely so a ceiling was never absent while rows were being written, and this unit gets the first
-- acceptance line ("sessions redeemed never exceed sessions sold") from them for nothing.
--
-- A ceiling is not an identity, though. Nothing in 0078 says the columns agree with the redemptions that
-- moved them, and a balance whose `released_fils` was moved by a statement that wrote no redemption row is
-- a liability that has been released against nothing. `package_balance_drawdown_matches_its_redemptions`
-- (ZG009, DEFERRED, fired from BOTH tables) holds three equalities at COMMIT:
--
--   1. `sessions_redeemed` = the sum of the redemptions' `sessions_redeemed`;
--   2. `released_fils`     = the sum of the redemptions' `released_fils`;
--   3. `released_fils`     = `package_release_through_fils(value_fils, sessions_total, sessions_redeemed)`.
--
-- (1) and (2) are "the columns came from somewhere"; (3) is "the figure is the right one". Two of the three
-- would be satisfied by a caller that released a plausible but wrong amount consistently in both places,
-- which is why (3) exists and reads the function rather than the rows.
--
-- Fired from both tables because either half can arrive alone: an UPDATE of the balance with no redemption
-- row, and a redemption row with no UPDATE of the balance, are different defects and both are refused.
--
-- ## 4. Expiry, and why breakage posts NOTHING
--
-- `package_sale.expires_on` is GENERATED by 0078 from the trading date and the validity months, and this
-- file READS it. There is no second derivation anywhere: `package_redemption_is_in_time` (ZG010) compares
-- the redemption's own business day against the stored column, and the service compares the same two dates.
--
-- **[UNVERIFIED] Y9-package-policy**, provisionally `retained` and not `forfeited`, and that answer decides
-- what expiry POSTS. It posts nothing, and the argument is worth writing out because the other reading is
-- the one that looks like accounting:
--
--   - `forfeited` would mean the salon keeps the money and owes nothing, so the unreleased part of `2050`
--     becomes income — a journal entry moving the liability to a breakage account at expiry.
--   - `retained` means the customer is STILL OWED the treatments. The liability is real. An entry moving
--     `2050` to revenue would be recognising money the business still owes, on a VAT box, for a supply that
--     has not happened — and reversing it later, when the owner says "of course we honour it", means
--     amending a filed return.
--
-- So under the provisional answer BREAKAGE IS A MEASUREMENT AND NOT A POSTING. `package_expiry_exposure`
-- below is that measurement: per sale, what has expired and what is still unreleased, which is the figure
-- the owner needs in order to answer Y9-package-policy at all. Nothing in this file writes a journal entry,
-- and `4050 Unredeemed voucher breakage` — which exists in the chart (0018) — is a VOUCHER account and is
-- deliberately not reused here.
--
-- If the owner answers `forfeited`, what changes is: a posting at expiry, an account for it (reusing 4050
-- would need an argument, because a voucher and a package are different products on the same box), and a
-- SECOND tax question nobody has asked — whether forfeited consideration is a supply at all, which
-- Y11-vat-package's wording does not reach. `unredeemed_balance_policy` is snapshotted per SALE, so a sale
-- already made keeps the answer it was sold under and no answer restates an outstanding balance. A sale
-- carrying `forfeited` today can only exist because somebody typed it in, and the expiry sweep REFUSES to
-- post for it rather than guessing: see `apps/worker/src/jobs/package-expiry.ts`.
--
-- ## 5. An appointment is redeemed or charged, never both
--
-- `package_redemption_appointment_once` (a UNIQUE constraint) is "not against two balances": one appointment
-- is one delivery, so it draws down one entitlement.
--
-- "Not redeemed AND invoiced for cash" cannot be a unique constraint, because the two facts live in two
-- tables and PostgreSQL has no cross-table unique. It is a TRIGGER PAIR — `package_redemption_not_charged`
-- and `invoice_appointment_not_redeemed`, both ZG011, one on each table — because whichever row arrives
-- second has to be the one refused and a guard on one table only refuses one of the two orders. The
-- rejected alternative was a shared `appointment_settlement` table with a primary key on the appointment,
-- written by both paths: that WOULD be one unique constraint, and it would also be a second answer to "was
-- this appointment billed" sitting beside `invoice_appointment`, which is the question that table exists to
-- answer.
--
-- "Charged" is `invoice_appointment.line_no is not null`. 0063 wrote the nullability for exactly this
-- distinction — "a redemption line bills an appointment that appears on NO invoice line at all (its gross is
-- zero and the document does not state it)" — and the sanctioned mapping derives `line_no` from
-- `posting.charges`, so every chargeable appointment has one. The residual hole is stated rather than hidden:
-- a hand-built `finaliseCheckout` call that omitted `lineNo` for a CHARGED appointment would read as a
-- redemption link here. Such a call also issues a document that does not state the appointment it billed,
-- which is a worse defect and one `invoice_line` shows; closing it properly means requiring a `line_no` for
-- every charged appointment, which is M-TILL-06's contract and M-TILL-13's caller, not this file's.
--
-- ## 6. A package sale writes PAYMENT rows, which is a defect in 0078 fixed here
--
-- 0078 took money for a package and wrote no `payment` row, because `payment.invoice_id` is NOT NULL (0063)
-- and a package sale issues no invoice. The consequence is not cosmetic: `readDrawerTakings` and `ZU005`
-- (0076) both sum `payment` for the business day, so cash taken for a package was invisible to both, and
-- M-TILL-11's cash-up read the drawer as OVER by exactly that amount and posted the difference to
-- `6140 Cash over and short`. A `done` unit's reconciliation was knowably wrong for every package sold for
-- cash.
--
-- The fix is the shape that keeps the row ATTACHED to something: `invoice_id` becomes nullable, a
-- `package_sale_id` is added beside it, and `payment_settles_exactly_one_document` requires exactly one of
-- the two. Making `invoice_id` merely nullable was the other option and is worse twice over — the row would
-- name no document at all, so nothing could say which package the money was for; and
-- `payment_one_row_per_tender` is `unique (invoice_id, tender_no)`, and NULLs are distinct in a unique
-- index, so every package payment would have escaped the one-row-per-tender rule as well. Hence
-- `payment_one_row_per_package_tender` beside it.
--
-- `payment_within_the_document()` (ZT001, 0068) is REPLACED rather than left alone, and not to add a
-- feature. With a nullable `invoice_id` its `v_applied > v_payable` became `0 > NULL`, which is NULL, which
-- is not true — so the ceiling silently stopped applying to exactly the rows this file adds. It now branches
-- explicitly and the package side has its own ceiling (ZG012): payments against a sale may not exceed its
-- price, which is `sellPackage`'s own tender check made a database rule for a writer that never came through
-- it.
--
-- Nothing else about `payment` moves. It keeps no UPDATE and no DELETE for the application role, so a
-- mis-keyed package tender is answered by a refund and not by an edit, exactly as a checkout's is.
--
-- ## 7. What is deliberately NOT here
--
-- No tax invoice at redemption. Under the provisional answer the redemption IS the supply, so a document
-- naming it is owed — and issuing one needs the numbering series, the issuer snapshot and the mandatory
-- field list (Y11-vat-invoice), which is `invoice`'s machinery and not a second document shape. Recorded as
-- M-TILL-13's, which is `todo` and builds the till screen that would show it. The VAT itself is NOT deferred
-- with it: `2030` is credited here, so the box is right whether or not the paper exists yet.
--
-- No transfer of a balance between customers as a DATABASE rule, and that is a real limitation rather than
-- an omission. A transfer is `update package_sale set customer_id = …`, which is byte for byte the statement
-- a customer MERGE issues (0078 permits that one column for exactly that reason), so no trigger can tell the
-- two apart. The refusal therefore lives in `transferPackageBalance` in
-- `packages/db/src/services/redeem-package.ts`, which reads the snapshotted `transferable` and writes an
-- `audit_event` for the refused attempt — the acceptance line asks for the audit row, and an audit row is
-- something only an application layer can write with an actor on it anyway.
--
-- No seeded package templates, still. What the business actually sells is a FACT nobody has stated (brief
-- rule 15) and an invented "6 Massage Package" would be indistinguishable from a configured one. M-TILL-13
-- (`todo`) already owes a seeded receipt fixture containing a package redemption and owns the screens where
-- an invented name would be visible in a screenshot somebody reviews.

-- ---------------------------------------------------------------------------------------------
-- Custom SQLSTATEs. Class 'ZG', continuing 0078's, with numbers 0078 does not use.
--
-- The same class as another file on purpose, which is the opposite of what 0078's own header argues for —
-- so the argument has to be made. 0078 moved off 'ZP' because 0056_consent.sql raises ZP001-ZP003 and
-- `packageError` and `consentError` both match on SQLSTATE ALONE: two different DOMAINS sharing a class
-- makes one translator answer for the other's refusal. That is not the case here. This is the same domain,
-- read by the same caller, and the codes are disjoint from 0078's six — so `packageError` and
-- `packageRedemptionError` partition ZG between them and neither can claim the other's code.
--
-- Measured before it was written: eleven codes already appear in more than one migration file (ZT001,
-- ZT002, ZT003, ZU001-ZU003, ZW001, ZW002, ZB001, ZB002, ZL002, and ZV002 in three), because a later
-- migration `create or replace`s the function that raises one. So "a code lives in one file" is not the
-- repository's rule and never was; "a code has one meaning" is. ZT001 appears below for that very reason.
--
--   ZG007  a package_redemption row was UPDATEd or DELETEd
--   ZG008  a redemption's journal entry is not the release posting
--   ZG009  a balance's drawdown disagrees with its redemptions, or with the release formula
--   ZG010  a redemption on a business day after the sale's expiry
--   ZG011  an appointment is both redeemed and charged on a document
--   ZG012  payments against a package sale exceed its price
-- ---------------------------------------------------------------------------------------------

-- ---------------------------------------------------------------------------------------------
-- The release formula, once.
--
-- IMMUTABLE and PARALLEL SAFE: it is arithmetic over three integers and nothing else, which is what lets a
-- constraint call it per row without a planner surprise.
--
-- `(value * redeemed + total - 1) / total` is ceiling division. Integer division truncates toward zero in
-- PostgreSQL and every input here is non-negative, so truncation is floor and the +total-1 makes it ceil.
-- Written that way rather than as `ceil(value::numeric * redeemed / total)` because numeric would be exact
-- and `ceil(...)::bigint` would be a cast somebody can widen to `float`; this version cannot round at all.
--
-- The guards RAISE rather than returning NULL. A NULL here would propagate into ZG009's comparison and make
-- it neither true nor false, which is a check that silently stops checking — and that exact failure mode is
-- why ZT001 is being replaced at the foot of this file.
-- ---------------------------------------------------------------------------------------------
create function package_release_through_fils(
  p_value_fils       bigint,
  p_sessions_total   integer,
  p_sessions_redeemed integer
) returns bigint
  language plpgsql immutable parallel safe
as $$
begin
  if p_value_fils is null or p_sessions_total is null or p_sessions_redeemed is null then
    raise exception
      'package_release_through_fils was called with a NULL argument (value %, total %, redeemed %). A '
      'release of NULL fils would make every comparison against it neither true nor false.',
      p_value_fils, p_sessions_total, p_sessions_redeemed
      using errcode = 'ZG009';
  end if;
  if p_sessions_total < 1 then
    raise exception
      'package_release_through_fils was called with % session(s) in total. A balance entitling nobody to '
      'anything has no share to release.', p_sessions_total
      using errcode = 'ZG009';
  end if;
  if p_sessions_redeemed < 0 or p_sessions_redeemed > p_sessions_total then
    raise exception
      'package_release_through_fils was asked for % of % session(s). Releasing past the entitlement is '
      'what package_balance_cannot_overdraw refuses, and this function must not answer for it.',
      p_sessions_redeemed, p_sessions_total
      using errcode = 'ZG009';
  end if;
  return (p_value_fils * p_sessions_redeemed + p_sessions_total - 1) / p_sessions_total;
end;
$$;

comment on function package_release_through_fils(bigint, integer, integer) is
  'The share of a balance''s value released after `redeemed` of `total` sessions: ceil(value * redeemed / '
  'total), in integer arithmetic. The ONE statement of the rule — ZG009 re-adds it over the rows, '
  'redeemPackage checks a caller''s figure against it, and package-drawdown.ts computes the same '
  'expression in BigInt. Deliberately not largest-remainder over equal weights: both sum to the value '
  'exactly, and only a closed form can be checked in SQL without reimplementing the allocation.';

-- ---------------------------------------------------------------------------------------------
-- package_redemption — one treatment delivered against one entitlement
-- ---------------------------------------------------------------------------------------------

create table package_redemption (
  id                 uuid        primary key default uuid_generate_v7(),
  -- The entitlement drawn down. RESTRICT: a balance a redemption points at is evidence that a treatment
  -- was delivered against a contract, and 0078 refuses to let the sale above it be deleted either.
  package_balance_id uuid        not null references package_balance (id) on delete restrict,
  -- The delivery. A plain uuid and NO foreign key, `invoice_appointment.appointment_id`'s reason verbatim
  -- (0063): PostgreSQL refuses `truncate appointment` while a referencing table is absent from the
  -- statement, and four suites truncate it by list. The link may therefore be orphaned, which is the right
  -- direction — the release of a liability is accounting and the diary row is not — and the UNIQUE below
  -- still bites, because it constrains the id.
  appointment_id     uuid        not null,
  -- Whole entitlements consumed. One treatment normally consumes one; a double session is two and the
  -- ceiling on the balance is what stops it consuming a third that was never bought.
  sessions_redeemed  smallint    not null
                       constraint package_redemption_sessions_positive check (sessions_redeemed >= 1),
  -- The GROSS released from 2050 by this redemption. Checked against
  -- `package_release_through_fils` by ZG009 through the balance, never re-derived from the catalogue: a
  -- second derivation would give a different answer the moment a price moved.
  released_fils      fils_nonneg not null
                       constraint package_redemption_release_positive check (released_fils > 0),
  -- The tax on it. Derived by `splitGross` in @berelax/core at the snapshotted rate and stored, for
  -- `invoice_line`'s reason (0026): re-deriving a filed figure means a rounding-rule change restates it.
  vat_fils           fils_nonneg not null,
  -- `released_fils - vat_fils`, GENERATED, so `net + vat = gross` holds by construction (ADR 0007) and
  -- there is one subtraction rather than one per reader.
  --
  -- Domain `fils` and NOT `fils_nonneg`, which is 0068's measurement and not a preference: a generated
  -- column's DOMAIN is checked BEFORE the table's CHECK constraints, so with `fils_nonneg` a VAT figure
  -- above the gross was refused by `fils_nonneg_check` — naming no constraint a caller could recognise —
  -- and `package_redemption_vat_not_more_than_gross` never fired at all.
  net_fils           fils        not null
                       generated always as (released_fils - vat_fils) stored,
  -- The rate applied, snapshotted. 500 bp today; a rate change must not restate a redemption already in a
  -- filed return, which is why this is a column and not a lookup.
  vat_rate_bp        smallint    not null
                       constraint package_redemption_rate_bounded
                       check (vat_rate_bp between 0 and 10000),
  -- The BUSINESS DAY the treatment was delivered on, and the VAT period this release falls in. A foreign
  -- key into `business_day` for `package_sale.trading_date`'s reason: trading runs 11:00-02:00, so a 01:30
  -- redemption belongs to the previous trading date, and `expires_on` is compared against THIS column
  -- rather than against a date truncated from an instant.
  trading_date       date        not null
                       references business_day (trading_date)
                       on update cascade on delete restrict,
  -- MANDATORY and a real foreign key, `package_sale.journal_entry_id`'s reason: a liability released with
  -- no entry behind it is the state that makes the deferred-revenue balance unexplainable.
  journal_entry_id   text        not null references journal_entry (entry_id),
  redeemed_at        timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  -- THE constraint the acceptance line asks for. One appointment is one delivery, so it draws down one
  -- entitlement: without this, two balances could each be told they paid for the same treatment and 2050
  -- would be released twice for one supply.
  constraint package_redemption_appointment_once unique (appointment_id),
  -- One entry per redemption, which is what lets ZG008 measure the WHOLE entry against this row's figures
  -- rather than trying to find its own lines inside a shared posting.
  constraint package_redemption_one_per_entry unique (journal_entry_id),
  -- The VAT may not exceed the consideration. Named, because the domain on `net_fils` would otherwise
  -- answer first with a message naming no rule.
  constraint package_redemption_vat_not_more_than_gross check (vat_fils <= released_fils)
);

create index package_redemption_balance_idx on package_redemption (package_balance_id);
create index package_redemption_trading_date_idx on package_redemption (trading_date);

comment on table package_redemption is
  'One treatment delivered against one prepaid entitlement: the drawdown, and the release of 2050 into '
  '4020 and 2030. Append-only — UPDATE and DELETE raise (ZG007) — because a release is a supply recognised '
  'on a VAT box, and the correction for a wrong one is a reversing entry and a new row, never an edit. Its '
  'posting is held by ZG008 and its figure by ZG009; [UNVERIFIED] Y11-vat-package puts the date of supply '
  'here rather than at the sale.';
comment on column package_redemption.appointment_id is
  'The delivery. No foreign key, deliberately: PostgreSQL refuses `truncate appointment` while a '
  'referencing table is absent from the statement and four suites truncate it by list (0063''s reason). '
  'package_redemption_appointment_once still bites, because it constrains the id.';
comment on column package_redemption.released_fils is
  'The gross released from 2050 by this redemption: package_release_through_fils at sessions_redeemed after '
  'this row, minus the same before it. Held against the formula and against the balance''s own columns by '
  'ZG009.';

-- ---------------------------------------------------------------------------------------------
-- ZG007 — a redemption is append-only, for EVERY role including the owner.
--
-- 0072's, 0076's and 0078's argument: the grants at the foot of this file constrain `berelax_app`, and a
-- migration or a psql session does not connect as `berelax_app`. A redemption is the recognition of a
-- supply on a VAT return, so the correction for a wrong one is a dated reversal and a fresh row (ADR 0017).
-- ---------------------------------------------------------------------------------------------
create or replace function package_redemption_is_immutable() returns trigger
  language plpgsql as $$
begin
  raise exception
    'ZG007: a package redemption is the recognition of a supply on a VAT return, so % is refused. The '
    'correction is a reversing journal entry and a new redemption, never a change to this row.',
    tg_op
    using errcode = 'ZG007';
end;
$$;

create trigger package_redemption_no_update
  before update on package_redemption
  for each row execute function package_redemption_is_immutable();
create trigger package_redemption_no_delete
  before delete on package_redemption
  for each row execute function package_redemption_is_immutable();

-- ---------------------------------------------------------------------------------------------
-- ZG010 — a redemption may not be dated after the sale's expiry.
--
-- IMMEDIATE and per row, so the refusal arrives at the statement that tried it rather than at a COMMIT that
-- also wrote a journal entry. `expires_on` is READ from `package_sale` — it is GENERATED there from the
-- trading date and the validity months (0078), and a second derivation in this file would be a second
-- answer about when a customer's money runs out.
--
-- The wording deliberately shares no phrase with `PackageExpired` in `redeem-package.ts`. Both layers
-- refuse this, and when two layers' messages share a phrase, deleting one of them leaves its suite green
-- with the other answering instead — M-TILL-11 measured exactly that and a gate reported a pass over a
-- check that had been removed. The service names the customer's position; this names the return.
-- ---------------------------------------------------------------------------------------------
create or replace function package_redemption_is_in_time() returns trigger
  language plpgsql as $$
declare
  v_expires date;
  v_sale    uuid;
begin
  select s.expires_on, s.id into v_expires, v_sale
    from package_balance b join package_sale s on s.id = b.package_sale_id
   where b.id = new.package_balance_id;

  if v_expires is null then
    raise exception
      'ZG010: package balance % names no sale, so there is no validity to measure a redemption against.',
      new.package_balance_id
      using errcode = 'ZG010';
  end if;

  if new.trading_date > v_expires then
    -- Deliberately shares NO phrase with `PackageExpired` in redeem-package.ts, which says "ran out on"
    -- and what happens to the money. This one says what the release would do to a return, and the itest
    -- asserts the absence of "the terms of sale" from the service's message — a test asserting a phrase
    -- both layers emit passes after either one is deleted.
    raise exception
      'ZG010: this redemption is dated on business day % and the terms of sale % ended on %. A release '
      'after that date puts revenue and output VAT into a period the terms had already closed.',
      new.trading_date, v_sale, v_expires
      using errcode = 'ZG010';
  end if;
  return new;
end;
$$;

create trigger package_redemption_is_in_time
  before insert on package_redemption
  for each row execute function package_redemption_is_in_time();

-- ---------------------------------------------------------------------------------------------
-- ZG011 — an appointment is redeemed or charged, never both. The pair, one trigger on each table.
--
-- Whichever row arrives second is the one refused, which is why there are two: a guard on
-- `package_redemption` alone refuses "charge then redeem" and lets "redeem then charge" through, and the
-- money is released twice for one supply in both orders.
--
-- IMMEDIATE on both, because the caller has to be told at the statement it issued. A DEFERRED pair would
-- report at a COMMIT that had also allocated an invoice number.
-- ---------------------------------------------------------------------------------------------
create or replace function package_redemption_not_charged() returns trigger
  language plpgsql as $$
declare
  v_invoice uuid;
  v_line    smallint;
begin
  -- `line_no is not null` is "the document states this appointment as a line", which is 0063's own reason
  -- for making the column nullable: a redemption appears on NO invoice line, because its gross is zero.
  select ia.invoice_id, ia.line_no into v_invoice, v_line
    from invoice_appointment ia
   where ia.appointment_id = new.appointment_id and ia.line_no is not null
   limit 1;

  if v_invoice is not null then
    raise exception
      'ZG011: appointment % is already stated as line % of invoice %, so the customer has been charged '
      'for it. Redeeming it as well would release 2050 for a treatment that was paid for twice.',
      new.appointment_id, v_line, v_invoice
      using errcode = 'ZG011';
  end if;
  return new;
end;
$$;

create trigger package_redemption_not_charged
  before insert on package_redemption
  for each row execute function package_redemption_not_charged();

create or replace function invoice_appointment_not_redeemed() returns trigger
  language plpgsql as $$
declare
  v_redemption uuid;
begin
  if new.line_no is null then
    -- A link with no line number is the redemption link itself (0063). Refusing it here would refuse the
    -- very row a checkout containing a redemption has to write.
    return new;
  end if;

  select r.id into v_redemption
    from package_redemption r where r.appointment_id = new.appointment_id;

  if v_redemption is not null then
    raise exception
      'ZG011: appointment % was redeemed against a package (redemption %), so it may not also be stated '
      'as a chargeable line on a document. The treatment was paid for when the package was sold.',
      new.appointment_id, v_redemption
      using errcode = 'ZG011';
  end if;
  return new;
end;
$$;

create trigger invoice_appointment_not_redeemed
  before insert on invoice_appointment
  for each row execute function invoice_appointment_not_redeemed();

-- ---------------------------------------------------------------------------------------------
-- ZG008 — the posting IS the release.
--
-- Four facts, and each one is measured off the LEDGER against a figure on THIS ROW rather than against
-- another ledger figure. That distinction is the point: a check comparing two sums taken from the same
-- lines can be satisfied by an entry that is internally consistent and wrong, and M-TILL-11 shipped exactly
-- that defect — an expected-float control that subtracted the same two figures on both sides and reported
-- PASS while comparing a value to itself.
--
--   1. the entry is dated on the redemption's own business day — a release filed under another day lands in
--      another VAT period, and at a period boundary in one that has already been filed;
--   2. `2050` is DEBITED by exactly `released_fils` (debits minus credits, so a credit cannot pad it);
--   3. `4020` is CREDITED by exactly `net_fils`, and total movement on every OTHER revenue account is zero;
--   4. `2030` is CREDITED by exactly `vat_fils`.
--
-- (3)'s second half measures debits PLUS credits, ZG005's reason: an entry crediting `4010` and debiting the
-- contra `4095` by the same figure nets to zero and has put a package's revenue on the wrong account and
-- the wrong VAT box, with the trial balance still balancing.
--
-- DEFERRED, because the entry, its lines and the redemption are separate INSERTs in one transaction.
-- ---------------------------------------------------------------------------------------------
create or replace function package_redemption_posts_the_release() returns trigger
  language plpgsql as $$
declare
  v_entry_day    date;
  v_deferred     bigint;
  v_revenue      bigint;
  v_other_rev    bigint;
  v_output_vat   bigint;
begin
  select e.entry_date into v_entry_day from journal_entry e where e.entry_id = new.journal_entry_id;
  if v_entry_day <> new.trading_date then
    raise exception
      'ZG008: the journal entry % for this redemption is dated % and the treatment was delivered on '
      'business day %. A release filed under another day''s takings lands in another VAT period.',
      new.journal_entry_id, v_entry_day, new.trading_date
      using errcode = 'ZG008';
  end if;

  select coalesce(sum(l.debit_fils - l.credit_fils), 0) into v_deferred
    from journal_line l
   where l.entry_id = new.journal_entry_id and l.account_code = '2050';
  if v_deferred <> new.released_fils then
    raise exception
      'ZG008: the journal entry % debits 2050 Deferred revenue by % fils and this redemption releases % '
      'fils. The liability has to fall by exactly what was delivered against it.',
      new.journal_entry_id, v_deferred, new.released_fils
      using errcode = 'ZG008';
  end if;

  select coalesce(sum(l.credit_fils - l.debit_fils), 0) into v_revenue
    from journal_line l
   where l.entry_id = new.journal_entry_id and l.account_code = '4020';
  if v_revenue <> new.net_fils then
    raise exception
      'ZG008: the journal entry % credits 4020 Package redemption revenue by % fils and this redemption '
      'recognises % fils net. The supply is the net; the VAT belongs on 2030.',
      new.journal_entry_id, v_revenue, new.net_fils
      using errcode = 'ZG008';
  end if;

  select coalesce(sum(l.debit_fils + l.credit_fils), 0) into v_other_rev
    from journal_line l
    join account a on a.code = l.account_code
   where l.entry_id = new.journal_entry_id and a.type = 'revenue' and l.account_code <> '4020';
  if v_other_rev <> 0 then
    raise exception
      'ZG008: the journal entry % moves % fils across revenue accounts other than 4020. A package '
      'redemption is recognised on 4020 alone, so that the VAT box and the drill-down both name what '
      'was actually delivered.',
      new.journal_entry_id, v_other_rev
      using errcode = 'ZG008';
  end if;

  select coalesce(sum(l.credit_fils - l.debit_fils), 0) into v_output_vat
    from journal_line l
   where l.entry_id = new.journal_entry_id and l.account_code = '2030';
  if v_output_vat <> new.vat_fils then
    raise exception
      'ZG008: the journal entry % credits 2030 Output VAT payable by % fils and this redemption carries '
      '% fils of VAT. [UNVERIFIED] Y11-vat-package puts the date of supply HERE, so this is the entry '
      'the box is built from.',
      new.journal_entry_id, v_output_vat, new.vat_fils
      using errcode = 'ZG008';
  end if;
  return null;
end;
$$;

create constraint trigger package_redemption_posts_the_release
  after insert on package_redemption
  deferrable initially deferred
  for each row execute function package_redemption_posts_the_release();

-- ---------------------------------------------------------------------------------------------
-- ZG009 — the balance's drawdown equals its redemptions, and equals the formula.
--
-- Fired from BOTH tables, because either half can arrive alone and the two are different defects: an UPDATE
-- of the balance with no redemption row is a liability released against nothing, and a redemption row with
-- no UPDATE of the balance is a supply recognised twice the next time somebody reads the entitlement.
--
-- DEFERRED, because the redemption row and the UPDATE of the balance are two statements in one transaction
-- and either order has to be allowed.
-- ---------------------------------------------------------------------------------------------
create or replace function package_balance_drawdown_matches_its_redemptions() returns trigger
  language plpgsql as $$
declare
  v_balance   package_balance;
  v_sessions  bigint;
  v_released  bigint;
  v_formula   bigint;
begin
  -- One function on two tables, so it resolves the balance from whichever row fired it. `tg_table_name`
  -- rather than two near-identical functions: the three equalities below are the rule, and a copy of them
  -- per table is a copy to keep in step.
  if tg_table_name = 'package_balance' then
    select * into v_balance from package_balance where id = new.id;
  else
    select * into v_balance from package_balance where id = new.package_balance_id;
  end if;

  if v_balance.id is null then
    raise exception
      'ZG009: no package_balance row to reconcile a drawdown against. A release with no entitlement '
      'behind it is money taken off a liability nobody owed.'
      using errcode = 'ZG009';
  end if;

  select coalesce(sum(r.sessions_redeemed), 0), coalesce(sum(r.released_fils), 0)
    into v_sessions, v_released
    from package_redemption r where r.package_balance_id = v_balance.id;

  if v_balance.sessions_redeemed <> v_sessions then
    raise exception
      'ZG009: balance % records % session(s) redeemed and carries % redemption session(s). A drawdown '
      'with no redemption behind it is an entitlement consumed by nothing.',
      v_balance.id, v_balance.sessions_redeemed, v_sessions
      using errcode = 'ZG009';
  end if;

  if v_balance.released_fils <> v_released then
    raise exception
      'ZG009: balance % records % fils released and its redemptions release % fils. The liability may '
      'only fall by what a delivered treatment released.',
      v_balance.id, v_balance.released_fils, v_released
      using errcode = 'ZG009';
  end if;

  -- The third equality, and the one the other two cannot give. A caller that released a plausible but wrong
  -- figure, consistently on the row and on the balance, satisfies both of the above; only the formula says
  -- whether the figure is the right one — and it is what makes the last session release exactly the
  -- remainder, so a fully redeemed balance has released its whole value to the fils.
  v_formula := package_release_through_fils(
    v_balance.value_fils, v_balance.sessions_total, v_balance.sessions_redeemed);
  if v_balance.released_fils <> v_formula then
    raise exception
      'ZG009: balance % has released % fils after % of % session(s); the release formula gives % fils '
      'for that point. The shares have to sum to the balance''s whole value over the course, exact to '
      'the fils.',
      v_balance.id, v_balance.released_fils, v_balance.sessions_redeemed,
      v_balance.sessions_total, v_formula
      using errcode = 'ZG009';
  end if;
  return null;
end;
$$;

create constraint trigger package_balance_drawdown_matches_its_redemptions
  after update on package_balance
  deferrable initially deferred
  for each row execute function package_balance_drawdown_matches_its_redemptions();

create constraint trigger package_redemption_drawdown_matches_the_balance
  after insert on package_redemption
  deferrable initially deferred
  for each row execute function package_balance_drawdown_matches_its_redemptions();

-- ---------------------------------------------------------------------------------------------
-- package_expiry_exposure — what breakage WOULD be, as a view, posting nothing.
--
-- The measurement §4 argues for. Under the provisional `retained` answer to Y9-package-policy an expired
-- balance is still owed, so there is no entry to post and nothing to reverse when the owner answers — and
-- the figure the owner needs in order to answer at all is exactly this: how much money is sitting in 2050
-- against entitlements nobody can draw on any more.
--
-- A VIEW and not a stored figure, `invoice_settlement`'s and `leave_balance`'s reason: a stored total
-- disagrees with the movements the first time one is corrected. `as at` is a parameter of the caller's
-- question, so the view exposes `expires_on` and the caller compares it — a view that read `current_date`
-- would make every test of it depend on the machine's clock, which is what the frozen clock exists to
-- remove.
-- ---------------------------------------------------------------------------------------------
create view package_expiry_exposure as
  select
    s.id                                                as package_sale_id,
    s.customer_id,
    s.trading_date                                      as sold_on,
    s.expires_on,
    s.unredeemed_balance_policy,
    s.price_fils::bigint                                as sold_gross_fils,
    coalesce(sum(b.released_fils), 0)::bigint           as released_fils,
    -- What is still owed against this sale: the liability 2050 holds for it. Named `unreleased` and not
    -- `breakage`, because under the provisional answer it is not breakage — it is a debt.
    (s.price_fils - coalesce(sum(b.released_fils), 0))::bigint as unreleased_fils,
    coalesce(sum(b.sessions_total), 0)::bigint          as sessions_total,
    coalesce(sum(b.sessions_redeemed), 0)::bigint       as sessions_redeemed
  from package_sale s
  left join package_balance b on b.package_sale_id = s.id
  group by s.id, s.customer_id, s.trading_date, s.expires_on, s.unredeemed_balance_policy, s.price_fils;

comment on view package_expiry_exposure is
  'Per package sale: what was sold, what has been released into 4020 and 2030, and what is still '
  'unreleased — which is what 2050 holds for it. The breakage MEASUREMENT, and there is deliberately no '
  'breakage posting: [UNVERIFIED] Y9-package-policy provisionally RETAINS an unredeemed balance, so the '
  'customer is still owed the treatments and moving the liability to revenue would recognise money the '
  'business owes. Compare expires_on against the caller''s own date; this view reads no clock.';

-- ---------------------------------------------------------------------------------------------
-- payment — the row a package sale never wrote. §6 is the argument.
-- ---------------------------------------------------------------------------------------------

alter table payment
  -- Nullable, because a package sale issues no invoice and cash taken for one still went into the drawer.
  alter column invoice_id drop not null;

alter table payment
  -- The other document a tender may settle. A real foreign key, and RESTRICT by default: money taken for a
  -- package has to keep naming the package.
  add column package_sale_id uuid references package_sale (id);

alter table payment
  -- Exactly one document, never none and never both. `num_nonnulls` rather than a pair of implications:
  -- two implications are two constraints to get right and the one somebody forgets is the one that admits
  -- a payment attached to nothing, which is money in the drawer with no reason for being there.
  add constraint payment_settles_exactly_one_document
    check (num_nonnulls(invoice_id, package_sale_id) = 1),
  -- `payment_one_row_per_tender` is `unique (invoice_id, tender_no)` and NULLs are DISTINCT in a unique
  -- index, so it constrains none of the rows this file adds. This is its twin for the package side; without
  -- it a retry could write tender 1 twice and the drawer would expect the money twice.
  add constraint payment_one_row_per_package_tender unique (package_sale_id, tender_no);

-- No separate index on `package_sale_id`: `payment_one_row_per_package_tender` leads on it, so a second
-- one would be the same B-tree twice — and every write to this table would maintain both.

comment on column payment.invoice_id is
  'The document this tender settled, or NULL for a package sale — which takes money against no invoice, '
  'because [UNVERIFIED] Y11-vat-package puts the date of supply at redemption and there is nothing to '
  'state as a supply on the day the money is taken. Exactly one of this and package_sale_id is set '
  '(payment_settles_exactly_one_document).';
comment on column payment.package_sale_id is
  'The package sale this tender paid for, or NULL for a checkout. Added by 0083 because 0078 took money '
  'for a package and wrote no payment row at all: readDrawerTakings and ZU005 (0076) both sum this table '
  'for the business day, so package cash was invisible to the cash-up and the drawer read as OVER by it.';

-- ---------------------------------------------------------------------------------------------
-- ZT001 and ZG012 — the ceiling on each kind of document.
--
-- `payment_within_the_document()` is REPLACED and not extended, and the reason is a silent failure rather
-- than a missing feature. With a nullable `invoice_id` its test was `v_applied > v_payable` where
-- `invoice_payable_fils(NULL)` returns NULL and the sum over `invoice_id = NULL` is 0 — so `0 > NULL` is
-- NULL, which is not TRUE, and the ceiling stopped applying to precisely the rows 0083 adds while still
-- reporting itself as present. A check that cannot fail is not a check (ADR 0003), and a NULL-propagating
-- comparison is the way one stops failing without anybody editing it.
--
-- So the branch is explicit, and the package side gets its own ceiling under its own code: a caller has to
-- tell "you have overpaid this invoice" from "you have overpaid this package" because the remedy differs —
-- an invoice over-collection is change or a credit note, and a package's is a second sale.
--
-- ZT001's name and code are kept for the invoice branch. `packages/db/src/services/checkout-finalise.ts`
-- and gate block 92 both assert on that SQLSTATE, and renaming a refusal a `done` unit recognises would
-- turn a handled conflict into an unhandled one.
-- ---------------------------------------------------------------------------------------------
create or replace function payment_within_the_document() returns trigger
  language plpgsql as $$
declare
  v_payable bigint;
  v_applied bigint;
begin
  if new.invoice_id is not null then
    v_payable := invoice_payable_fils(new.invoice_id);
    select coalesce(sum(applied_fils), 0) into v_applied
      from payment where invoice_id = new.invoice_id;

    if v_applied > v_payable then
      raise exception
        'Overpayment: invoice % has % fils applied against a payable total of % fils. A payment that '
        'takes a document above what it is payable for is a mis-keyed amount or a second tap, and the '
        'answer to a genuine over-collection is change (recorded on the tender) or a credit note.',
        new.invoice_id, v_applied, v_payable using errcode = 'ZT001';
    end if;
    return null;
  end if;

  -- The package branch. `price_fils` and not a payable total: a package collects no gratuity — a tip is
  -- consideration for a treatment somebody delivered, and nobody has delivered anything yet — so the
  -- ceiling is the price the version was sold at, which ZG002 already holds equal to the version.
  select price_fils into v_payable from package_sale where id = new.package_sale_id;
  select coalesce(sum(applied_fils), 0) into v_applied
    from payment where package_sale_id = new.package_sale_id;

  if v_payable is null then
    raise exception
      'ZG012: this payment names package sale %, which does not exist. Money in the drawer against no '
      'document is the state a cash-up cannot explain.',
      new.package_sale_id using errcode = 'ZG012';
  end if;

  if v_applied <> v_payable then
    -- EQUALITY and not a ceiling, which is where this differs from ZT001 on purpose. An invoice may be
    -- part paid — M-TILL-07's receivable — and a package may not: `sellPackage` refuses tenders that do not
    -- add up to the price, because a part-paid package would credit 2050 with a liability the salon was
    -- never paid for and every later reconciliation of the liability against the cash taken would be out
    -- by it. Enforcing the ceiling alone would have left the under-tender, which is the half that loses
    -- money rather than the half that looks wrong.
    raise exception
      'ZG012: package sale % has % fils applied against a price of % fils. A package is paid in full or '
      'not sold: a part payment would credit 2050 with a liability the salon was not paid for, and an '
      'over-tender is change, which belongs on the tender rather than in the liability.',
      new.package_sale_id, v_applied, v_payable using errcode = 'ZG012';
  end if;
  return null;
end $$;

comment on function payment_within_the_document() is
  'Raises ZT001 when the payments applied to an INVOICE exceed what it is payable for, and ZG012 when the '
  'payments against a PACKAGE SALE do not equal its price exactly. DEFERRED, because the tenders of one '
  'sale are inserted a statement at a time inside one transaction. The branch is explicit because with a '
  'nullable invoice_id the single-branch version compared 0 > NULL for every package row, which is NULL, '
  'which is not TRUE — a ceiling that silently stopped applying.';

-- ---------------------------------------------------------------------------------------------
-- The expiry sweep's agent row. `assertRegistry` in apps/worker refuses a cron without one, and
-- `agentsWithHeartbeat` INNER joins definition to heartbeat, so an agent with no heartbeat row never
-- appears in the watchdog's list at all — which is worse than unwatched, because the
-- registry-completeness check would report it present (0033's note).
--
-- The interval is 25 hours against a daily pass: a sweep that is a few minutes late is not a dead sweep,
-- and the watchdog alerts at twice a declared interval. `budget_fils_per_run` is 0 because the pass sends
-- nothing and calls nothing — it reads a view and writes an audit row.
-- ---------------------------------------------------------------------------------------------
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('package_expiry', 'Package expiry sweep',
   'Daily: measures the packages whose validity has run out and what is still unreleased against them — '
   'the liability 2050 holds for entitlements nobody can draw on any more. Posts NOTHING: [UNVERIFIED] '
   'Y9-package-policy provisionally RETAINS an unredeemed balance, so the customer is still owed the '
   'treatments and moving 2050 to revenue would recognise money the business owes (M-TILL-10).',
   25 * 60 * 60, 0)
on conflict (agent_key) do nothing;

insert into agent_heartbeat (agent_key) values ('package_expiry')
on conflict (agent_key) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Grants.
--
-- 0009 set default privileges so a table created later arrives with select, insert, update and delete for
-- the application role — so `package_redemption` ARRIVED with UPDATE and DELETE already granted. The door
-- is held twice, 0072's, 0076's and 0078's arrangement: the triggers above refuse for every role, and the
-- grants below refuse before a trigger is reached. The table-level REVOKE has to come FIRST, because a
-- column-list grant does not narrow an existing table-level one — leaving it out cost 0076 a whole run.
--
-- `package_balance` already holds `update (sessions_redeemed, released_fils)` and nothing more (0078
-- narrowed it for this unit), so the drawdown statement in `redeemPackage` names exactly those two columns
-- and no grant changes here. That was checked by running the statement as `berelax_app` in psql rather than
-- by reading the grant, which is how M-TILL-09 found an upsert the application role could not run after
-- every test had passed as the owner.
--
-- `payment` keeps INSERT and SELECT and neither UPDATE nor DELETE (0063), and the new column needs no grant
-- of its own because those are table-level.
-- ---------------------------------------------------------------------------------------------
grant select, insert on package_redemption to berelax_app;
revoke update, delete on package_redemption from berelax_app;
revoke truncate on package_redemption from berelax_app;

grant select on package_redemption, package_expiry_exposure to berelax_readonly;
grant select on package_expiry_exposure to berelax_app;
