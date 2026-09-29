# ADR 0060 — the reporting schema is derived, keyed on `business_day`, and refreshed concurrently

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** R-REP-01
- **Covers:** docs/01 decisions — none; this is the mechanism behind the two lines docs/02 §4 gives on
  "Reporting (separate schema, materialised)", and it stands on ADR 0006 (SQL-first migrations), ADR 0007
  (integer fils) and ADR 0034 (erasure is enumerated and bounded)

## Decision

**Three things, and the first is what the other two are for.**

1. **Nothing in the `reporting` schema states a fact of its own.** Every relation is a materialised view
   over `public`, and the only thing that changes a row in it is `reporting.refresh_all()` or
   `reporting.refresh(view)`. The application role holds `select` and `execute` and nothing else.
2. **`dim_date` is keyed on `business_day.trading_date` and has no calendar date of its own.** There is no
   generated date dimension, and there is no row for a date the premises did not trade on.
3. **Every view carries a UNIQUE index over plain columns, and every refresh is `CONCURRENTLY`.** The
   absence of such an index is refused *before* a refresh is attempted (`ZY182`), not reported by
   PostgreSQL afterwards.

## Why "derived, and nothing else" is a decision rather than an implementation detail

A reporting schema is the obvious place to put a table. Three things would each have been reasonable and
each is refused here:

- a `dim_date` generated from `generate_series` and populated once;
- a `fact_sale` written by the checkout as well as read by the reports;
- a small `customer_label` or `therapist_name` column, so a dashboard needs one join fewer.

What forecloses all three is a property the schema has only while it is entirely derived, and it is a
property of two checks written for other units. **C-CRM-05's merge registry and C-CRM-10's erasure
catalogue both enumerate `relkind in ('r','p')`** — ordinary and partitioned tables. A materialised view is
`relkind = 'm'` and is invisible to both. That is either exactly right or a hole, depending on one thing:
whether anything in the schema holds a row a merge would have to re-point or an erasure would have to
remove.

While the answer is no, the schema needs no entry in either registry and a customer's erasure is complete
the moment the base row changes, **whether or not a refresh has run since**. The day one relation holds a
`customer_id` *and* a stored value of its own, the schema silently leaves both registries' coverage with
nothing failing — which is the exact failure mode `merge-participants.ts` opens with ("the failure is not a
bug in the merge as first written — it is what happens when a table is added afterwards").

So the decision is not "materialised views are a nice way to build a warehouse". It is: **the reporting
schema buys its exemption from two enumerations by having nothing of its own, and that price is paid in
full or not at all.** `dim_customer` therefore carries a customer's *shape* — how they arrived, where they
are in the lifecycle, when they first and last came in, whether they are erased — and no phone, no name, no
label and no note. `dim_staff` carries no wage, which is the same argument meeting R-REP-08's "forbidden
columns are absent from the serialised JSON response" one layer up: the dimension every role's dashboard
joins to cannot leak a salary it does not contain.

**Rejected: an identity label, materialised.** "Customer 0042" (ADR 0020) is what a record with no display
name is called, and it would be convenient in `dim_customer`. It is a presentation value derived from an
ordinal, and storing it here would put a contact-shaped column into the schema whose entire safety argument
is that it has none — for the saving of a `lpad` at the render site.

## Why `dim_date` is keyed on `business_day` and not on a calendar date

Trading runs 11:00–02:00 (docs/01 decision 8), so 01:30 belongs to the *previous* trading date. Migration
0011 made that mapping a TABLE rather than an expression, and said why: *"a SQL expression repeated in each
of them is a rule that will eventually disagree with itself."* Eleven tables in `public` now carry the
quantity as `trading_date` with a foreign key to `business_day`.

A date dimension generated from `generate_series` over calendar dates would be the twelfth statement of the
trading calendar and **the first one entitled to disagree with it**, because nothing would join the two. It
would have rows for days the salon was shut, and every figure divided by "days in the period" would quietly
include them.

So `dim_date.business_day` *is* `business_day.trading_date`: one row per trading date, absent for a date
that was not one. That is 0011's own claim, kept: *"a report that forgets a `where is_open` predicate would
count a closed day as a zero-takings trading day, which is a different and much worse claim than 'we were
shut'."*

**The consequence to live with, stated rather than implied.** The `reporting` schema cannot answer a
question about a calendar day the premises did not trade on. Every figure R-REP-02 through R-REP-08 asks
for is per trading day, so that is the right refusal for all of them — and anything else has to join
`business_day` itself and say so.

**And the same rule reaches the facts, where it is not free.** `fact_appointment` and `fact_shift` inherit
it from a foreign key. `fact_sale` does not: `invoice.tax_point_date` is a trading date that 0026 *stores*
rather than derives, and it has no foreign key to `business_day`. The tempting fix — an INNER JOIN — is
worse than the problem, because it makes an off-calendar invoice **disappear from a revenue fact** with
nothing said. So the key is taken as stored and `reporting.assert_business_day_keys` refuses the refresh
(`ZY185`), naming every offending date. It is applied to all three facts rather than only to the one that
needs it, so a fact added by a later unit inherits the rule whether or not its author knew it existed.

## Why the refresh is concurrent, and why that makes a missing index a refusal

`REFRESH MATERIALIZED VIEW` takes ACCESS EXCLUSIVE. Every reader blocks for the length of the rebuild —
which on a nightly pass is seconds nobody sees, and on an on-demand refresh from an admin screen is every
other admin's dashboard hanging. `CONCURRENTLY` avoids that and requires a UNIQUE index over plain columns:
a partial or expression unique index satisfies `pg_index.indisunique` and does **not** satisfy PostgreSQL.

The failure mode is not the missing index. It is the *fix*: a concurrent refresh that errors has one
obvious remedy, which is to drop the keyword, and the resulting schema works perfectly until somebody reads
a dashboard during the nightly pass. So the absence is refused before any refresh is attempted, by a named
code (`ZY182`) whose message says what the wrong fix costs.

`packages/db/src/reporting.itest.ts` proves the mechanism by the LOCK rather than by a race — a holder
session starts a concurrent refresh and does not commit, a reader session succeeds — **and pairs it with
the control that the non-concurrent form blocks the same reader**, which is what makes the first assertion
a statement about `CONCURRENTLY` rather than about a 149-row view being fast. A timing test there would
measure the machine (brief rule 23).

## Why there is a registry table at all, and why it is append-only next door

`reporting.materialised_view` restates which views exist, which is a second statement of a fact and
therefore comes with `reporting.assert_views_are_refreshable()` holding it equal to `pg_catalog` in both
directions (`ZY181`). What it holds that the catalogue cannot is the GRAIN in one sentence, the refresh
ORDER, and which column carries the trading date.

The direction that earns it is "a materialised view the registry does not declare": a view a later R-REP
unit adds and never registers is a view the nightly pass walks straight past, so its rows are whatever they
were the day it was created — **with a green job beside them**. That is the same defect the job registry
exists for one subject along, and `refreshReportingViews` refuses a pass that refreshed nothing for the
same reason, because an empty registry agrees with an empty catalogue in both directions.

`reporting.refresh_run` is separate and **append-only** (`ZY184`). PostgreSQL records nothing about when a
materialised view was last refreshed, and R-REP-07's rule — "a materialised view older than 26 hours marks
its dependent tiles stale" — has to read that from somewhere. The one thing an editable freshness log
permits is making a stale view look current, which is precisely the state R-REP-07 exists to refuse. It has
no `updated_at` and no retention pass: seven views once a night is about 2,600 rows a year.

`checksum` on that table is what makes "refresh is idempotent" a measurement instead of a hope. It is md5
over the rows ordered by their own text, so it depends on the set and not on the order a refresh wrote
them — and a view reading `now()` would break it, which is why a clock in a view definition is a rule
(`reporting-view-is-a-pure-function-of-its-base-tables`) rather than a style note.

## The holiday calendar this unit does not own, and the constraint it left behind

P-HR-10 owns the holiday calendar and does not exist yet. `dim_date` still has to carry the two flags, so
`reporting.calendar_observance` is the minimum source for them — and the reason it is a new table rather
than a read of `premises_closure` is worth recording, because the obvious answer is **exactly backwards**.

`premises_closure` carries `kind = 'public_holiday'`, so it looks like the holiday calendar. A closure
means the premises is SHUT, a shut date has no `business_day` row (0011) and therefore no `dim_date` row at
all — while a public holiday the salon TRADES THROUGH has no closure row, which `Y9-overtime` states in so
many words: *"a public holiday the premises trades through has no row at all, so the derived set is a
floor."* Deriving the flag from closures would make it false on every holiday the flag is for.

**No observance row is seeded.** The UAE's lunar holiday dates are announced at short notice (docs/04 §6,
docs/06 B5), and a plausible one is indistinguishable from a confirmed one (brief rule 15) in the one place
every report would then key on. The dates are `Y9-holiday-calendar`; the mechanism is here.

What the mechanism *does* guarantee is the acceptance line, as a CHECK rather than as a property of rows
somebody seeded: `calendar_observance_lunar_is_provisional` refuses a lunar-dated observance that is not
provisional. Asserting it over whatever rows exist would be vacuous on an empty table and would pass for
ever once somebody added a confirmed one. It is safe to refuse now because **nothing in this build can
record an announcement** — the confirmation flow is P-HR-10's third acceptance line — and when P-HR-10
lands, `dim_date` reads its calendar and this table goes with its constraint. That hand-over is recorded as
a `NOTE:` on P-HR-10 in `build/manifest.yaml`, so it is a deferral rather than a constraint a future unit
has to argue with.

## What this costs

- **Seven views are outside `pnpm db:drift`.** The gate compares `relkind in ('r','p')`, so only the two
  base tables are drift-checked. The views' shapes are asserted against the Drizzle mirrors by
  `reporting.itest.ts`, which reads `pg_attribute` — a second mechanism for one property, and it is the
  honest arrangement rather than teaching the drift gate that a view is a table.
- **A figure is never fresher than the last refresh.** There is no incremental maintenance and no trigger
  keeping a fact in step with an insert: a sale entered at 14:00 is not in `fact_sale` until the pass runs
  or somebody asks for one. R-REP-07 reads `refresh_run` and marks the tile stale instead of rendering a
  number nobody can date, which is the only version of this that is safe — but it does mean the reporting
  schema is *never* the place to answer an operational question, and the calendar and the till read
  `public` directly.
- **Two statements of every money column's type.** The migration casts each amount to `bigint` — stripping
  the `fils` domain — so the schema's money rule is checkable by type alone. That is a deliberate loss of
  the domain's own `check (value >= 0)` on `fils_nonneg`: a credit note's amounts are NEGATIVE in
  `fact_sale` by design, so the non-negative domain could not have been carried through anyway.
- **The refresh is one transaction per view and seven in a pass.** A pass that fails half way leaves some
  views new and some old. It is left that way rather than wrapped in one transaction, because a single
  transaction over seven concurrent refreshes holds a lock on all seven for the duration of the slowest —
  and the ORDER is declared in the registry so the half-state is the same every night rather than a
  different one each time.
