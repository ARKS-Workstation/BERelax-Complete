-- 0031 — the recurring cost register: definitions, the periods they expect, the bills that satisfied
--        them, and the alerts raised when one did not.
--
-- A salon's cost base is mostly the same handful of invoices every month: rent, the landlord's utility
-- recharge, laundry, consumables, the trade licence, the insurance, half a dozen subscriptions. Two
-- things go wrong with that list and neither is visible in the ledger:
--
--   1. **A cost silently stops arriving.** The landlord's service-charge invoice does not come, nobody
--      notices, and the month closes understating the cost base. It surfaces when the arrears letter
--      does, by which point the VAT return for that period has been filed.
--   2. **A cost silently changes.** The rent arrives 4% higher because an escalation clause fired, or
--      the laundry starts billing a collection charge that used to be included. Each individual invoice
--      looks ordinary. Nobody compares it with anything.
--
-- So the register holds what the business *expects*, period by period, and everything here exists to
-- make the two failures above into rows somebody can read.
--
-- ## What a variance is measured against, and why not the alternatives
--
-- **The cost's own declared expectation for that period — never a statistic derived from history.**
--
-- A rent is a `fixed` cost: the expectation is the contracted amount, and any difference beyond a
-- declared tolerance is news in **either** direction (a rent 200 AED low is a credit to chase or an
-- error, exactly as a rent 200 AED high is). A utility recharge is a `variable` cost: it swings with
-- the season by design, so a single expected number would be wrong every month by construction. Its
-- expectation is a declared **band**, and the variance is the distance *outside* the band — zero while
-- the bill is inside it. That is the whole purpose of the fixed/variable split: one expectation shape
-- per cost shape, so an August electricity bill at the top of its band raises nothing and an August
-- rent rise raises immediately.
--
-- The two obvious alternatives are both worse, and specifically:
--
--   - **Against last period.** The second month of a wrong amount is silent: the landlord overcharges
--     in March and the alert fires; he overcharges the identical amount in April and the difference is
--     zero. A wrong figure that persists is the one most worth catching, and a last-period baseline is
--     blind to exactly that.
--   - **Against a rolling mean.** The mean absorbs the error it is meant to detect. Three months of an
--     incorrect rent pulls the mean onto the incorrect rent, and the alert stops. For a seasonal cost a
--     rolling mean is worse still: it fires twice a year on the way up and on the way down, both of
--     which are normal, and an alert that fires every month is an alert nobody reads.
--
-- The expectation a variance is measured against is **snapshotted onto the period** by
-- `recurring_cost_instance`, not read through the definition. A rent renegotiated in June must not
-- retroactively make March's variance disappear — that is the same argument, and the same mechanism, as
-- `bill.supplier_trn` in 0028.
--
-- ## Absence is a different alert from difference
--
-- A period past its due date with no bill raises `missing_cost`; a bill that arrived outside tolerance
-- raises `variance_over_tolerance`. They need different actions — the first is chased with the supplier
-- or accrued before the return is filed, the second is queried against the invoice in hand — and one
-- alert kind covering both would tell the reader nothing about which they are looking at.
--
-- Both are deduplicated by `(recurring_cost_id, period_key, alert_kind)`, so a job that runs daily
-- raises an alert **once per incident** rather than once per run. That is `agent_alert`'s arrangement in
-- 0021, for the identical reason: the ninety-sixth copy of an alert is the one nobody reads.
--
-- ## Custom SQLSTATEs
--
-- Class 'ZR' is unused by PostgreSQL (Appendix A) and by this schema so far. 'ZV' is purchases' (0028),
-- 'ZL' the ledger's (0018, 0027), 'ZB' booking's (0024), 'ZC' the catalogue's and 'ZI' the invoice's.
--
--   ZR001  recurring cost history is append-only; UPDATE or DELETE was refused
--   ZR002  MatchedBillFromAnotherSupplier — a bill matched to a cost billed by somebody else
--   ZR003  UnknownRecurringCadence — a cadence the schedule cannot step
--
-- Matched on the code and never on the message, because a wording change must not stop a caller
-- recognising the refusal.
--
-- See docs/04-uae-compliance.md §4, ADR 0007 (integer fils, gross authoritative), ADR 0008 and
-- ADR 0017 (append-only evidence).

begin;

-- ---------------------------------------------------------------------------------------------
-- The cadence arithmetic, stated in SQL
-- ---------------------------------------------------------------------------------------------
-- These four functions are the SQL half of a rule that is stated twice, because `packages/db` may not
-- import `packages/core` and both the report and the pure schedule generator need it. The other half is
-- `packages/core/src/money/recurring-schedule.ts`, and `packages/fixtures/src/recurring-costs.itest.ts`
-- asserts the two agree over every cadence and a long run of occurrences. That is the arrangement
-- `payables_aging_bucket` / `payablesBucketFor` already uses, for the same reason and with the same
-- agreement test.

-- How many calendar months one period of a cadence spans.
--
-- plpgsql rather than a `case` in SQL so that an unknown cadence RAISES. A SQL `case` with no `else`
-- returns NULL, and a NULL here does not fail: it makes every due date NULL, which makes the cost vanish
-- from the forward schedule silently. A cost that disappears from a cash-flow forecast is the failure
-- this whole migration exists to prevent, so it must be loud.
create function recurring_cost_period_months(p_cadence text) returns integer
language plpgsql
immutable
strict
as $$
begin
  case p_cadence
    when 'monthly'   then return 1;
    when 'quarterly' then return 3;
    when 'annual'    then return 12;
    else
      raise exception
        'UnknownRecurringCadence: "%" is not a cadence this schedule can step', p_cadence
        using errcode = 'ZR003',
              hint = 'monthly, quarterly or annual. Adding one is a migration, like a document series.';
  end case;
end $$;

comment on function recurring_cost_period_months(text) is
  'Calendar months per period. Raises ZR003 on an unknown cadence rather than returning NULL, because '
  'a NULL would drop the cost out of the forward schedule without saying so.';

-- The period a due date belongs to, as `YYYY-MM`.
--
-- A calendar MONTH for every cadence, not the cadence''s own unit. A quarterly cost lands in the month
-- it falls due and an annual one in its renewal month, which is what lets costs of different cadences be
-- summed into one cash-flow line. A per-cadence key ('2027-Q2') could not be added up with a monthly one.
--
-- `extract` rather than `to_char`: `to_char(timestamp, text)` is STABLE, so PostgreSQL refuses it inside
-- the CHECK below that ties a period to its due date. `extract` on a date is immutable.
create function recurring_cost_period_key(p_due_date date) returns text
language sql
immutable
strict
as $$
  select lpad(extract(year from p_due_date)::text, 4, '0') || '-' ||
         lpad(extract(month from p_due_date)::text, 2, '0')
$$;

comment on function recurring_cost_period_key(date) is
  'The YYYY-MM period of a due date. A calendar month for every cadence, so a quarterly and a monthly '
  'cost can be summed into one cash-flow line.';

-- The due date of the nth occurrence, counting the anchor as occurrence 0.
--
-- Anchored to `first_due_date` and stepped in whole months, so the sequence is a function of the
-- definition alone. Stepping from the PREVIOUS occurrence instead would make the series depend on which
-- rows already exist, and a single missing row would shift every later date.
create function recurring_cost_due_date(
  p_first_due_date date,
  p_cadence        text,
  p_occurrence     integer
) returns date
language sql
immutable
strict
as $$
  select (p_first_due_date
          + (p_occurrence * recurring_cost_period_months(p_cadence)) * interval '1 month')::date
$$;

comment on function recurring_cost_due_date(date, text, integer) is
  'The due date of occurrence n, anchored on first_due_date. Anchored rather than chained: a chain '
  'depends on which rows exist, so one missing row would shift every later date.';

-- ---------------------------------------------------------------------------------------------
-- The variance, stated in SQL
-- ---------------------------------------------------------------------------------------------
-- `delta_fils` is signed: above the expectation is positive, below is negative, and both matter. A
-- non-negative delta would fold "the landlord billed 200 short" into "the landlord billed 200 over",
-- which are opposite conversations.
--
-- NOT `strict`. A fixed cost has NULL min/max and a variable cost has a NULL expected amount, so a
-- strict function would return NULL for every real row — and a NULL `over_tolerance` is a variance that
-- never alerts.
--
-- The tolerance is a fraction of the **breached expectation**: the contracted amount for a fixed cost,
-- and whichever band edge was crossed for a variable one. One column, one meaning ("how far past the
-- expectation is still not news"), and two references because the two cost shapes have two expectations.
create function recurring_cost_variance(
  p_cost_kind             text,
  p_expected_amount_fils  bigint,
  p_expected_min_fils     bigint,
  p_expected_max_fils     bigint,
  p_variance_tolerance_bp integer,
  p_actual_gross_fils     bigint
) returns table (delta_fils bigint, tolerance_fils bigint, over_tolerance boolean)
language sql
immutable
as $$
  with breach as (
    select
      case p_cost_kind
        when 'fixed' then p_actual_gross_fils - p_expected_amount_fils
        when 'variable' then case
          -- Inside the declared band is not a variance at all. This is the line that stops a seasonal
          -- cost alerting every month, which is the whole point of declaring a band for it.
          when p_actual_gross_fils > p_expected_max_fils
            then p_actual_gross_fils - p_expected_max_fils
          when p_actual_gross_fils < p_expected_min_fils
            then p_actual_gross_fils - p_expected_min_fils
          else 0::bigint
        end
      end as delta,
      case p_cost_kind
        when 'fixed' then p_expected_amount_fils
        when 'variable' then case
          when p_actual_gross_fils > p_expected_max_fils then p_expected_max_fils
          when p_actual_gross_fils < p_expected_min_fils then p_expected_min_fils
          else 0::bigint
        end
      end as reference
  )
  -- Integer arithmetic throughout, half-up: `(x * bp + 5000) / 10000` on non-negative bigints is
  -- floor(x * bp / 10000 + 0.5), which is what `roundHalfUp` in @berelax/core computes. A numeric
  -- division here would be a second rounding rule, and ADR 0007 exists because two rounding rules
  -- eventually disagree by a fils.
  select b.delta,
         (b.reference * p_variance_tolerance_bp + 5000) / 10000,
         -- Strictly greater: a bill exactly ON the tolerance is within it. An off-by-one here alerts on
         -- every cost whose tolerance was set to the amount it actually varies by.
         abs(b.delta) > (b.reference * p_variance_tolerance_bp + 5000) / 10000
  from breach b
$$;

comment on function recurring_cost_variance(text, bigint, bigint, bigint, integer, bigint) is
  'The variance of one bill against one period expectation: signed delta, the tolerance in fils, and '
  'whether it was breached. Deliberately not STRICT — a fixed cost has no band and a variable cost no '
  'single amount, so STRICT would return NULL for every real row and NULL never alerts.';

-- ---------------------------------------------------------------------------------------------
-- The definition
-- ---------------------------------------------------------------------------------------------
-- NO ROW IS SEEDED HERE, and that is a decision rather than an omission. The real register — landlord,
-- utilities, laundry, consumables, licence, insurance — is an H-MIG import, exactly as the domestic
-- supplier list is (0028 makes the same call for the same reason). A seeded placeholder would put a
-- contract that does not exist into a cash-flow forecast, where it is exported, demoed and eventually
-- believed; and a recurring cost carries an AMOUNT, so the invented figure would be added up. The
-- offshore subscriptions 0028 does seed as suppliers are not registered here either: what any of them
-- actually bills per month is unknown (OPEN-QUESTIONS), and guessing it is how a forecast acquires a
-- number nobody chose.
create table recurring_cost (
  recurring_cost_id     uuid        primary key default uuid_generate_v7(),
  -- A stable handle for a seed, a report and a test fixture. The uuid is the key; this is what a human
  -- and a migration refer to, and it never changes. Same arrangement as `supplier.code`.
  code                  text        not null unique check (code ~ '^[a-z0-9][a-z0-9-]*$'),
  -- What the cost is, in the words the invoice will use. It becomes the bill line's description.
  description           text        not null check (btrim(description) <> ''),

  -- Who bills it. NOT NULL: a recurring cost with no counterparty cannot be matched against an arriving
  -- bill, and matching is what makes the missing-cost alert possible at all.
  supplier_id           uuid        not null references supplier (supplier_id),
  -- Where it posts. A foreign key to the chart, so a mistyped code fails here rather than appearing in
  -- the trial balance as an account nobody recognises.
  expense_account_code  text        not null references account (code),
  -- The treatment the bill line is expected to carry. The same vocabulary as `bill_line.tax_treatment`
  -- (0028), minus nothing: blocked input VAT (M-VAT-02) and the imported-services reverse charge
  -- (M-VAT-03) are absent there and so are absent here, because a register that could name a treatment
  -- no posting path implements would generate a bill that looks complete and understates the return.
  --
  -- Expected, not authoritative. `postBill` reads the supplier's TRN snapshot and refuses a claim
  -- without one; this column is what the register predicts, and the bill is what happened.
  tax_treatment         text        not null check (tax_treatment in (
                          'standard_recoverable', 'no_trn_not_recoverable',
                          'zero_rated', 'exempt', 'out_of_scope')),

  cadence               text        not null check (cadence in ('monthly', 'quarterly', 'annual')),
  -- The first period's due date, and the anchor every later due date is stepped from.
  first_due_date        date        not null,
  -- When the contract ends. NULL is open-ended, which is the normal case for rent and utilities.
  final_due_date        date,

  -- 'fixed'    a contracted amount that should not move: rent, insurance, a licence, a subscription.
  -- 'variable' a cost that moves by design: utilities, laundry by volume, card-processing fees.
  --
  -- The split decides what the expectation IS, which is why it cannot be derived from the amounts and
  -- must be stated: a cost that happens to have billed the same figure three times is not thereby fixed,
  -- and treating it as fixed would alert on the first genuine seasonal swing.
  cost_kind             text        not null check (cost_kind in ('fixed', 'variable')),
  -- The contracted amount, for a fixed cost only.
  expected_amount_fils  fils_nonneg,
  -- The band a variable cost is normal inside, for a variable cost only.
  expected_min_fils     fils_nonneg,
  expected_max_fils     fils_nonneg,

  -- How far past the expectation is still not news, in basis points of the expectation. 500 is 5%.
  --
  -- NOT NULL AND NO DEFAULT, deliberately. This is the one number that decides whether the alert gets
  -- read: default it to zero and every variable cost alerts on the first fils outside its band, default
  -- it to 500 and a 5% rent rise is accepted for ever. A column with a default makes "nobody chose" and
  -- "somebody chose that" indistinguishable, which is the argument 0028 makes for
  -- `supplier_tax_profile.residency`.
  variance_tolerance_bp smallint    not null check (variance_tolerance_bp between 0 and 10000),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- A fixed cost is an amount and nothing else; a variable cost is a band and nothing else. Stating
  -- both directions is what stops a half-filled definition: a variable cost carrying an
  -- `expected_amount_fils` would be compared against the wrong thing by whichever reader reached for
  -- the non-null column first.
  constraint recurring_cost_fixed_needs_an_expected_amount check (
    cost_kind <> 'fixed'
    or (expected_amount_fils is not null
        and expected_min_fils is null and expected_max_fils is null)
  ),
  constraint recurring_cost_variable_needs_an_expected_range check (
    cost_kind <> 'variable'
    or (expected_min_fils is not null and expected_max_fils is not null
        and expected_amount_fils is null)
  ),
  -- An inverted band accepts nothing: every bill is simultaneously above the maximum and below the
  -- minimum, so every period alerts and the alert means nothing.
  constraint recurring_cost_range_is_ordered check (
    expected_min_fils is null or expected_max_fils is null
    or expected_max_fils >= expected_min_fils
  ),
  -- Zero is a missing amount, not a free contract: it would post nothing, forecast nothing, and make
  -- every arriving bill a 100% variance while the definition still looked complete.
  constraint recurring_cost_expected_amount_positive
    check (expected_amount_fils is null or expected_amount_fils > 0),
  constraint recurring_cost_expected_range_positive
    check (expected_min_fils is null or expected_min_fils > 0),
  constraint recurring_cost_ends_after_it_starts
    check (final_due_date is null or final_due_date >= first_due_date),
  -- The anchor's day of the month must exist in every month.
  --
  -- `date + interval '1 month'` clamps 31 January to 28 February, so an anchor on the 31st would step to
  -- the 28th, the 31st, the 30th — a series whose day of month wanders, which cannot be compared period
  -- to period and cannot be predicted by a reader. Restricting the anchor to 1..28 removes the clamp
  -- rather than documenting it. A cost genuinely due on the last day of the month is anchored on the
  -- 28th: three days early for an alert whose purpose is to fire BEFORE somebody forgets.
  constraint recurring_cost_anchor_day_is_in_every_month
    check (extract(day from first_due_date) <= 28)
);

comment on table recurring_cost is
  'One row per recurring cost the business expects: who bills it, how often, and what for. '
  'Configuration, so an admin may correct it — and every period snapshots the expectation it was '
  'generated under, so a correction cannot reach back and change a variance already reported.';
comment on column recurring_cost.cost_kind is
  'fixed | variable. Decides what the expectation is — a contracted amount or a normal band — and '
  'therefore what a variance is measured against. Stated, never inferred from the amounts billed so '
  'far: three identical invoices do not make a cost fixed.';
comment on column recurring_cost.variance_tolerance_bp is
  'Basis points of the breached expectation. No default: this is the number that decides whether the '
  'alert is read, and a default makes "nobody chose" look like a choice.';
comment on column recurring_cost.first_due_date is
  'The anchor. Every later due date is first_due_date + n periods, so the series is a function of the '
  'definition alone. Its day must be 1..28 — see recurring_cost_anchor_day_is_in_every_month.';

create trigger recurring_cost_updated_at before update on recurring_cost
  for each row execute function set_updated_at();

-- The forward schedule scans active costs; the matcher looks one up by supplier.
create index recurring_cost_supplier_idx on recurring_cost (supplier_id);
create index recurring_cost_active_idx on recurring_cost (first_due_date) where final_due_date is null;

-- ---------------------------------------------------------------------------------------------
-- The expected period
-- ---------------------------------------------------------------------------------------------
-- One row per period the register expects a bill for, generated deterministically from the definition.
--
-- The expectation is SNAPSHOTTED here rather than read through `recurring_cost`, for the reason the
-- header gives and 0028 already argues for `bill.supplier_trn`: a rent renegotiated in June must not
-- retroactively change March's variance, in either direction. Five duplicated columns is the price of
-- that, and it buys a period whose reported variance can still be explained years later.
create table recurring_cost_instance (
  recurring_cost_id     uuid        not null references recurring_cost (recurring_cost_id),
  -- `YYYY-MM`. A calendar month for every cadence: see recurring_cost_period_key().
  period_key            text        not null,
  due_date              date        not null,

  -- The expectation as it stood when this period was generated.
  cost_kind             text        not null check (cost_kind in ('fixed', 'variable')),
  expected_amount_fils  fils_nonneg,
  expected_min_fils     fils_nonneg,
  expected_max_fils     fils_nonneg,
  variance_tolerance_bp smallint    not null check (variance_tolerance_bp between 0 and 10000),

  generated_at          timestamptz not null default now(),

  -- The idempotency of generation, as a constraint rather than as a habit of the generator: one period
  -- per cost, so a job that runs twice a day for a year cannot produce a second September.
  constraint recurring_cost_instance_one_per_period
    primary key (recurring_cost_id, period_key),

  -- The period and the due date cannot disagree. Without this a generator bug could file October's bill
  -- under September, and the missing-cost alert would then fire for a period that was in fact billed.
  constraint recurring_cost_instance_period_matches_due_date
    check (period_key = recurring_cost_period_key(due_date)),

  -- The same two shape rules as the definition. Restated rather than inherited, because this row is what
  -- the variance is actually computed from: a snapshot that could be half-filled would be compared
  -- against whichever column the reader reached for first.
  constraint recurring_cost_instance_fixed_needs_an_expected_amount check (
    cost_kind <> 'fixed'
    or (expected_amount_fils is not null
        and expected_min_fils is null and expected_max_fils is null)
  ),
  constraint recurring_cost_instance_variable_needs_an_expected_range check (
    cost_kind <> 'variable'
    or (expected_min_fils is not null and expected_max_fils is not null
        and expected_amount_fils is null)
  ),
  constraint recurring_cost_instance_range_is_ordered check (
    expected_min_fils is null or expected_max_fils is null
    or expected_max_fils >= expected_min_fils
  )
);

comment on table recurring_cost_instance is
  'One period a recurring cost is expected in, with the expectation snapshotted as it stood when the '
  'period was generated. Append-only: UPDATE and DELETE raise, because a reported variance has to stay '
  'explainable — re-stating what March expected would silently rewrite what March was told.';
comment on column recurring_cost_instance.period_key is
  'YYYY-MM of the due date, tied to it by recurring_cost_instance_period_matches_due_date. A calendar '
  'month for every cadence, so costs of different cadences sum into one cash-flow line.';

-- The job's scan: every period past its due date, oldest first.
create index recurring_cost_instance_due_date_idx on recurring_cost_instance (due_date);

-- ---------------------------------------------------------------------------------------------
-- The match
-- ---------------------------------------------------------------------------------------------
-- Which bill satisfied which expected period.
--
-- A separate table rather than a column on either side. `bill` is append-only for every role, so a
-- `recurring_cost_id` column on it could never be filled in later for a bill somebody entered before
-- realising which contract it was; and an `entry_id`-style column on the instance would make the
-- instance mutable, which is the thing the snapshot above depends on it not being.
create table recurring_cost_match (
  match_id          uuid        primary key default uuid_generate_v7(),
  recurring_cost_id uuid        not null,
  period_key        text        not null,
  bill_id           uuid        not null references bill (bill_id),
  -- Who matched it. A label, not a uuid: the audit_event row written in the same transaction carries the
  -- full actor and request context (F06).
  matched_by        text        not null check (btrim(matched_by) <> ''),
  matched_at        timestamptz not null default now(),

  -- A match points at a period that exists, and at the snapshot the variance was computed against.
  constraint recurring_cost_match_instance_fk
    foreign key (recurring_cost_id, period_key)
    references recurring_cost_instance (recurring_cost_id, period_key),

  -- ACCEPTANCE: matching is idempotent on (recurring_cost_id, period). The second match raises here
  -- rather than being quietly ignored, because two bills against one month's rent is either a duplicate
  -- invoice or a period somebody mis-keyed, and both need a person.
  constraint recurring_cost_match_one_per_period unique (recurring_cost_id, period_key),
  -- And one bill satisfies at most one expected period. Without this, one invoice could be used to
  -- silence two different missing-cost alerts.
  constraint recurring_cost_match_one_per_bill unique (bill_id)
);

comment on table recurring_cost_match is
  'One bill against one expected period. Append-only: UPDATE and DELETE raise — a match that could be '
  'moved would move a reported variance with it, and the alert already sent would no longer be '
  'explainable by any row.';

create index recurring_cost_match_bill_idx on recurring_cost_match (bill_id);

-- The bill matched to a cost has to be the bill of the supplier that cost is billed by.
--
-- A trigger, because a CHECK cannot reach across to `bill` and `recurring_cost`. The mistake it refuses
-- is the ordinary one: two recurring costs, adjacent in a list, and the laundry invoice matched to the
-- rent. That single keystroke would report a large negative variance on the rent, silence the rent's
-- missing-cost alert, and leave the laundry looking unbilled — three wrong answers from one row.
create function assert_matched_bill_is_from_the_cost_supplier() returns trigger
language plpgsql
as $$
declare
  v_cost_supplier uuid;
  v_bill_supplier uuid;
  v_code          text;
begin
  select c.supplier_id, c.code into v_cost_supplier, v_code
    from recurring_cost c where c.recurring_cost_id = new.recurring_cost_id;
  select b.supplier_id into v_bill_supplier from bill b where b.bill_id = new.bill_id;

  if v_cost_supplier = v_bill_supplier then
    return new;
  end if;

  raise exception
    'MatchedBillFromAnotherSupplier: bill % is from supplier %, but recurring cost "%" is billed by '
    'supplier %',
    new.bill_id, v_bill_supplier, v_code, v_cost_supplier
    using errcode = 'ZR002',
          hint = 'Match the bill to the cost its own supplier bills, or record a new recurring cost.';
end $$;

comment on function assert_matched_bill_is_from_the_cost_supplier() is
  'Raises ZR002. One mis-keyed match reports a false variance, silences a real missing-cost alert and '
  'leaves another cost looking unbilled — three wrong answers from one row.';

create trigger recurring_cost_match_supplier_agrees before insert on recurring_cost_match
  for each row execute function assert_matched_bill_is_from_the_cost_supplier();

-- ---------------------------------------------------------------------------------------------
-- The alerts
-- ---------------------------------------------------------------------------------------------
-- What was raised, when, and on what figures.
--
-- There is no `acknowledged_at` here and no state to move. An alert row is the evidence that something
-- was noticed on a date, which is a fact that does not change; an inbox that tracks what has been dealt
-- with is a different table and a different unit's decision, and adding a mutable column to this one
-- would make the row rewritable by whatever owns that inbox.
create table recurring_cost_alert (
  alert_id          uuid        primary key default uuid_generate_v7(),
  recurring_cost_id uuid        not null,
  period_key        text        not null,

  -- 'variance_over_tolerance'  a bill arrived and differs from the expectation by more than tolerance
  -- 'missing_cost'             the period passed its due date with no bill matched to it
  alert_kind        text        not null
    check (alert_kind in ('variance_over_tolerance', 'missing_cost')),

  -- Signed: above the expectation is positive, below is negative. `fils` and not `fils_nonneg` on
  -- purpose — an under-billing is as much a variance as an over-billing and they are opposite
  -- conversations, so folding the sign away would lose the only thing the reader needs first.
  delta_fils        fils,
  -- The threshold that was breached, so the alert explains itself without re-deriving anything.
  tolerance_fils    fils_nonneg,
  -- Readable context for whoever opens it: the expectation, the bill, the supplier's reference.
  detail            jsonb       not null default '{}'::jsonb,
  -- The business day the pass was made for, not the wall clock it ran at. A report of what was alerted
  -- for a closed period has to be reproducible, which is the same reason `payables_aging_bucket` takes
  -- its as-of date as a parameter.
  raised_for_date   date        not null,
  raised_at         timestamptz not null default now(),

  constraint recurring_cost_alert_instance_fk
    foreign key (recurring_cost_id, period_key)
    references recurring_cost_instance (recurring_cost_id, period_key),

  -- ACCEPTANCE: raised exactly once per incident, not once per run. A daily job that re-raised would
  -- produce 365 copies of one unbilled September, and the 365th is the one nobody reads. Same mechanism
  -- as `agent_alert`'s (agent_key, incident_key) in 0021.
  constraint recurring_cost_alert_once_per_period_and_kind
    unique (recurring_cost_id, period_key, alert_kind),

  -- A variance alert carries its figures; a missing-cost alert has none, because nothing arrived to
  -- compare. Stating it as an equivalence rather than two one-way checks is what stops the halfway row:
  -- a missing-cost alert with a delta invites the reader to treat an absence as a difference.
  constraint recurring_cost_alert_variance_carries_a_delta
    check ((alert_kind = 'variance_over_tolerance') = (delta_fils is not null)),
  constraint recurring_cost_alert_delta_and_tolerance_travel_together
    check ((delta_fils is null) = (tolerance_fils is null)),
  -- A zero delta is not a variance. A row like that is a bug in the caller, and it would sit in the
  -- ledger as an alert nobody can act on.
  constraint recurring_cost_alert_variance_delta_is_not_zero
    check (delta_fils is null or delta_fils <> 0)
);

comment on table recurring_cost_alert is
  'One alert per (cost, period, kind), which is what makes a daily pass raise once per incident rather '
  'than once per run. Append-only: UPDATE and DELETE raise — an alert is the evidence that something '
  'was noticed on a date, and that fact does not change.';
comment on column recurring_cost_alert.delta_fils is
  'Signed. Above the expectation is positive, below negative; an under-billing is as much a variance '
  'as an over-billing and they are opposite conversations.';

create index recurring_cost_alert_raised_idx on recurring_cost_alert (raised_for_date, alert_kind);

-- ---------------------------------------------------------------------------------------------
-- Append-only enforcement
-- ---------------------------------------------------------------------------------------------
-- A trigger that RAISES, not `create rule ... do instead nothing`: a rule reports success, and code that
-- UPDATEs one of these believes it corrected what a period expected. It must be told that it did not.
-- Same shape and same reasoning as `refuse_purchase_document_change()` in 0028.
--
-- Fires for EVERY role including the owner. The revokes below cover the application role; a migration, a
-- psql session and a future admin tool connect as the owner, and the owner is who rewrites history by
-- hand at 2am.
create function refuse_recurring_cost_history_change() returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is append-only; % is refused. A period''s expectation, its match and the alerts raised on it are '
    'the record of what was reported at the time.',
    tg_table_name, tg_op
    using errcode = 'ZR001';
end $$;

comment on function refuse_recurring_cost_history_change() is
  'Raises ZR001 for recurring_cost_instance, recurring_cost_match and recurring_cost_alert, for every '
  'role. The definition itself stays editable; what a period was told does not.';

create trigger recurring_cost_instance_no_update before update on recurring_cost_instance
  for each row execute function refuse_recurring_cost_history_change();
create trigger recurring_cost_instance_no_delete before delete on recurring_cost_instance
  for each row execute function refuse_recurring_cost_history_change();
create trigger recurring_cost_match_no_update before update on recurring_cost_match
  for each row execute function refuse_recurring_cost_history_change();
create trigger recurring_cost_match_no_delete before delete on recurring_cost_match
  for each row execute function refuse_recurring_cost_history_change();
create trigger recurring_cost_alert_no_update before update on recurring_cost_alert
  for each row execute function refuse_recurring_cost_history_change();
create trigger recurring_cost_alert_no_delete before delete on recurring_cost_alert
  for each row execute function refuse_recurring_cost_history_change();

-- ---------------------------------------------------------------------------------------------
-- The forward schedule
-- ---------------------------------------------------------------------------------------------
-- What the register expects to pay over the next `p_months` months: the cash-flow forecast's cost side.
--
-- `p_as_of` is a PARAMETER, never `current_date`, for the reason `payables_aging_bucket` states: a
-- forecast that read the clock would give a different answer tomorrow for a horizon somebody already
-- committed to, and the worked example in `packages/fixtures/src/recurring-costs.ts` could not exist.
--
-- The window is half-open, `[p_as_of, p_as_of + p_months months)`. That makes a monthly cost contribute
-- exactly `p_months` occurrences whatever day of the month it falls on, which is the property that lets
-- a reader check the total by eye. Bounding it on calendar months instead ("the twelve months beginning
-- with September") would give eleven occurrences for a cost due on the 1st and twelve for one due on the
-- 20th, purely because of where in the month the report was run.
--
-- **This function is what R-REP reads.** It does not join `recurring_cost_instance`, so a forecast does
-- not depend on the generator having run — a horizon that ends where the generated rows happen to stop
-- is a forecast that quietly shortens. The occurrences are computed from the definitions.
create function recurring_cost_forward_schedule(p_as_of date, p_months integer default 12)
returns table (
  recurring_cost_id    uuid,
  code                 text,
  description          text,
  supplier_id          uuid,
  expense_account_code text,
  cadence              text,
  cost_kind            text,
  period_key           text,
  due_date             date,
  -- What to hold cash for: the contracted amount for a fixed cost, and the TOP of the band for a
  -- variable one. The midpoint is the tempting choice and it is wrong here — a forecast built on the
  -- middle of every band is short of cash in about half of the months it covers, and the point of a
  -- cash-flow forecast is to not be.
  expected_fils        bigint,
  -- The band, so a report can show a range rather than only the prudent figure. Equal for a fixed cost.
  expected_low_fils    bigint,
  expected_high_fils   bigint
)
language sql
stable
as $$
  select c.recurring_cost_id,
         c.code,
         c.description,
         c.supplier_id,
         c.expense_account_code,
         c.cadence,
         c.cost_kind,
         recurring_cost_period_key(occurrence.due_date),
         occurrence.due_date,
         case c.cost_kind when 'fixed' then c.expected_amount_fils else c.expected_max_fils end,
         case c.cost_kind when 'fixed' then c.expected_amount_fils else c.expected_min_fils end,
         case c.cost_kind when 'fixed' then c.expected_amount_fils else c.expected_max_fils end
    from recurring_cost c
    -- The series is bounded on both sides rather than started at occurrence 0. A cost anchored in 2019
    -- would otherwise need hundreds of iterations before the first one landed inside the window, and a
    -- fixed `generate_series(0, p_months)` would never reach it at all — the cost would simply be absent
    -- from the forecast, which is the failure mode this whole register exists to remove.
    cross join lateral (
      select recurring_cost_due_date(c.first_due_date, c.cadence, n) as due_date
        from generate_series(
               greatest(
                 0,
                 (((extract(year from p_as_of) - extract(year from c.first_due_date)) * 12
                   + (extract(month from p_as_of) - extract(month from c.first_due_date)))::integer
                  / recurring_cost_period_months(c.cadence)) - 1
               ),
               greatest(
                 0,
                 (((extract(year from p_as_of) - extract(year from c.first_due_date)) * 12
                   + (extract(month from p_as_of) - extract(month from c.first_due_date)))::integer
                  / recurring_cost_period_months(c.cadence))
               ) + (p_months / recurring_cost_period_months(c.cadence)) + 1
             ) as g(n)
    ) as occurrence
   where occurrence.due_date >= p_as_of
     and occurrence.due_date < (p_as_of + p_months * interval '1 month')::date
     and occurrence.due_date >= c.first_due_date
     and (c.final_due_date is null or occurrence.due_date <= c.final_due_date)
   order by occurrence.due_date, c.code
$$;

comment on function recurring_cost_forward_schedule(date, integer) is
  'The cost side of the cash-flow forecast: every occurrence due in [p_as_of, p_as_of + p_months). '
  'Computed from the definitions, not from generated periods, so a forecast cannot quietly shorten to '
  'wherever the generator stopped. expected_fils is the prudent figure — the top of a variable band.';

-- ---------------------------------------------------------------------------------------------
-- The period status
-- ---------------------------------------------------------------------------------------------
-- Every generated period with what happened to it: matched or not, by how much it varied, and whether
-- it is overdue. One query, so the job, the admin screen and any later report agree about which periods
-- are a problem instead of each writing the comparison again.
--
-- `p_as_of` is the business day, resolved by the caller. Overdue is `due_date < p_as_of`: a cost due
-- today is not late, exactly as a payable due today is `current` in the aging (0028). The grace a late
-- invoice needs is already in the definition — the DUE date is later than the supplier's invoice date —
-- rather than added here as a second knob nobody would tune.
create function recurring_cost_period_status(p_as_of date)
returns table (
  recurring_cost_id     uuid,
  code                  text,
  period_key            text,
  due_date              date,
  cost_kind             text,
  expected_amount_fils  bigint,
  expected_min_fils     bigint,
  expected_max_fils     bigint,
  variance_tolerance_bp integer,
  bill_id               uuid,
  supplier_reference    text,
  actual_gross_fils     bigint,
  delta_fils            bigint,
  tolerance_fils        bigint,
  over_tolerance        boolean,
  is_overdue            boolean
)
language sql
stable
as $$
  select i.recurring_cost_id,
         c.code,
         i.period_key,
         i.due_date,
         i.cost_kind,
         i.expected_amount_fils,
         i.expected_min_fils,
         i.expected_max_fils,
         i.variance_tolerance_bp::integer,
         b.bill_id,
         b.supplier_reference,
         b.gross_fils,
         v.delta_fils,
         v.tolerance_fils,
         v.over_tolerance,
         i.due_date < p_as_of
    from recurring_cost_instance i
    join recurring_cost c on c.recurring_cost_id = i.recurring_cost_id
    left join recurring_cost_match m
      on m.recurring_cost_id = i.recurring_cost_id and m.period_key = i.period_key
    left join bill b on b.bill_id = m.bill_id
    -- LEFT join, so an unmatched period still appears with NULL variance columns. An inner join here
    -- would hide exactly the rows the missing-cost alert is looking for.
    left join lateral recurring_cost_variance(
      i.cost_kind, i.expected_amount_fils, i.expected_min_fils, i.expected_max_fils,
      i.variance_tolerance_bp::integer, b.gross_fils
    ) as v on b.bill_id is not null
   order by i.due_date, c.code
$$;

comment on function recurring_cost_period_status(date) is
  'Every generated period as at a business day: its snapshotted expectation, the bill matched to it if '
  'any, its signed variance and whether it is overdue. One comparison, so the job and every report '
  'agree about which periods are a problem.';

-- ---------------------------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------------------------
-- 0009 granted the application role select, insert, update and delete on every table in public and set
-- default privileges to extend that to tables created later, so these four tables arrive with UPDATE and
-- DELETE already granted. An append-only table that forgets to revoke them is append-only by convention.
grant select, insert on recurring_cost_instance, recurring_cost_match, recurring_cost_alert
  to berelax_app;
revoke update, delete on recurring_cost_instance, recurring_cost_match, recurring_cost_alert
  from berelax_app;
-- TRUNCATE fires no row-level trigger, so it is the one statement that could empty these past the
-- refusals above. 0009 never granted it by name; revoking it says so out loud.
revoke truncate on recurring_cost_instance, recurring_cost_match, recurring_cost_alert
  from berelax_app;

-- The definition is configuration and an admin corrects it: a rent is renegotiated, a tolerance turns
-- out to be too tight, a contract ends. So UPDATE is held here, unlike on the three history tables — and
-- the snapshot on the instance is what stops a correction reaching a variance already reported.
grant select, insert, update on recurring_cost to berelax_app;
-- A cost referenced by a period cannot be removed anyway (the foreign key refuses), and removing an
-- unused one is a migration. Ending a contract is `final_due_date`, which keeps its history.
revoke delete, truncate on recurring_cost from berelax_app;

revoke execute on function recurring_cost_period_months(text) from public;
revoke execute on function recurring_cost_period_key(date) from public;
revoke execute on function recurring_cost_due_date(date, text, integer) from public;
revoke execute on function
  recurring_cost_variance(text, bigint, bigint, bigint, integer, bigint) from public;
revoke execute on function recurring_cost_forward_schedule(date, integer) from public;
revoke execute on function recurring_cost_period_status(date) from public;
grant execute on function recurring_cost_period_months(text) to berelax_app, berelax_readonly;
grant execute on function recurring_cost_period_key(date) to berelax_app, berelax_readonly;
grant execute on function recurring_cost_due_date(date, text, integer) to berelax_app, berelax_readonly;
grant execute on function
  recurring_cost_variance(text, bigint, bigint, bigint, integer, bigint)
  to berelax_app, berelax_readonly;
grant execute on function
  recurring_cost_forward_schedule(date, integer) to berelax_app, berelax_readonly;
grant execute on function recurring_cost_period_status(date) to berelax_app, berelax_readonly;

-- ---------------------------------------------------------------------------------------------
-- The agent behind the nightly pass
-- ---------------------------------------------------------------------------------------------
-- `recurring-cost.check` is a cron, and 0021's contract is that every cron has an `agent_definition`
-- row: without one it has no declared interval and no budget, so nothing is watching it and nothing is
-- capping it. `pnpm jobs` refuses a cron with no agent and `agents.itest.ts` asserts the row exists, so
-- this insert is what makes the job declarable at all.
--
-- The interval is a day, so the watchdog alerts after two missed passes rather than after one late one.
-- The budget is zero: this pass is SQL and arithmetic, with no model call in it.
insert into agent_definition
  (agent_key, display_name, purpose, expected_interval_seconds, budget_fils_per_run)
values
  ('recurring_cost_register', 'Recurring cost register',
   'Generates the expected periods of every recurring cost, and raises a variance alert for a bill '
   'outside its declared tolerance and a missing-cost alert for a period that passed its due date '
   'unbilled (M-VAT-04).',
   60 * 60 * 24, 0)
on conflict (agent_key) do nothing;

-- `agentsWithHeartbeat` INNER joins, so an agent with no heartbeat row does not appear — and an agent
-- that does not appear is one the watchdog silently never checks. 0021 seeded a heartbeat for every
-- agent it created; a new agent has to bring its own.
insert into agent_heartbeat (agent_key) values ('recurring_cost_register')
on conflict (agent_key) do nothing;

commit;
