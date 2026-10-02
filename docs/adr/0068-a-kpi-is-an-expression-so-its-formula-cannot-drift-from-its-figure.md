# ADR 0068 — a KPI is an EXPRESSION, so its published formula cannot drift from its figure

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** R-REP-03
- **Covers:** docs/01 decisions — none; this is the mechanism behind the KPI half of docs/02 §4's
  "Reporting (separate schema, materialised)", and it stands on ADR 0060 (the reporting schema is derived
  and keyed on `business_day`), ADR 0064 (a statement is a directed sum over a partition of the chart),
  ADR 0003 (every gate needs a known-bad fixture) and ADR 0007 (integer fils)

## Decision

**Four things, and the first is what makes the other three checkable.**

1. **A KPI is an expression over named measures, and its formula string is RENDERED from that
   expression.** Nothing declares a formula. `formula`, `expandedFormula` and `compute` are three
   renderings of one tree, so there is no pair to hold equal and a change to the arithmetic changes the
   published definition in the same edit.
2. **A measure — the one thing that cannot be an expression, because an aggregation is a fold — DECLARES
   the `<dataset>.<field>` pairs it reads, and the declaration is held equal to the access** by replaying
   the reducer against a recording copy of a probe input, in both directions.
3. **The hours denominator reads `reporting.dim_date.open_minutes` and nothing else**, and that is
   enforced by (2) plus a fixture on a trading day the premises has never traded.
4. **A figure is an exact rational of two `bigint`s and a zero divisor is an answer, not a value.**
   Rounding happens once, at the edge, with a stated rule; `NoDenominator` names the divisor that was
   empty.

## Why "the formula is derived" rather than "the formula is checked"

The acceptance line asks for "named pure KPI functions each carrying its formula as a documented string".
Written the obvious way that is a `formula: string` field beside a function body, and it is the exact
shape of the failure the brief's rule about a second statement describes: the two drift, and **nothing
fails**, because a wrong formula is still a string and the figure it misdescribes is still a figure. A
dashboard then publishes a definition that is not what was computed, which is worse than publishing none
— somebody checks the arithmetic against the words, finds them consistent with each other, and reports
the number as verified.

Two repairs were available and only one of them removes the pair:

- **Check them.** Evaluate the formula string with a small interpreter and compare it to the function over
  generated inputs. This works, and it is what differential testing is for, but it leaves TWO
  implementations of every KPI and the interpreter is then the thing nobody tests.
- **Derive one from the other.** The expression is the single statement; the string and the number are
  both projections of it.

The second is taken. What it costs is that a KPI cannot branch, loop or read a row — the expression
language is a sum, a difference and a quotient over measures, other KPIs and whole-number constants — and
that cost is the benefit: a KPI cannot acquire a special case its formula does not show.

**The derivation needs its own control, and it is not a formality.** A renderer that returned a constant
satisfies every "the formula is not empty" assertion ever written, and so does a renderer that drops the
right-hand side of a subtraction. So `kpi-formula-names-every-reference-it-computes` requires every name
the expression reaches to appear in the rendered string, the unit suite asserts that a changed expression
produces a changed formula, and gate case 146i pins the renderer to a constant and requires the suite to
notice.

## Why a measure declares what it reads, and why that is the load-bearing check

Migration 0110 put `open_minutes` on `dim_date`, derived from `business_day.duration_seconds`, which
migration 0011 GENERATES from the day's own opening and closing instants. The chain from `premises_hours`
and its dated overrides down to every hours denominator therefore already exists, and R-REP-01's
`provisional:` note is discharged by it: a Ramadan schedule is a row in `premises_hours_override` plus a
regeneration of `business_day`, with no code change anywhere.

The way to break that is almost invisible. Trading runs 11:00–02:00 (Y8-hours, resolved), so **fifteen
hours is the right answer today**. An implementation that multiplied 15 by 60 passes "5 rooms × 15h =
75.0" and "73.0 with a two-hour closure" — both acceptance fixtures — and goes on answering 75.0 for ever
after the premises changes its hours. No test built from the real trading day can tell the two apart.

So two mechanisms close it from opposite sides, and they are complementary rather than redundant:

- a fixture on a **13-hour** day, which only an implementation that reads the column answers (65.0). It
  catches one that reads `open_minutes` and then ignores it.
- `measure-reads-exactly-the-fields-it-declares`, which observes the access rather than asking the code
  about itself. It catches one that stops reading the column at all.

The declaration is itself a second statement of a fact, which is why it arrives with that rule in the same
commit. The direction that earns the rule is **"declared and not read"**: "read and not declared" is a
tidiness finding, and "declared and not read" is the denominator quietly becoming a constant.

A consequence worth stating: the rule needs a PROBE with rows, and an EMPTY probe makes every reducer read
nothing and therefore FAILS. That is deliberate — a probe that cannot make a measure read what it declares
is not evidence about that measure — and the unit suite asserts the empty-probe failure, because a rule
that passed over an empty probe would be a rule that passes over anything.

## Why the KPI input holds no instant

ADR 0060's rule is that a trading date comes from `business_day` and is never derived from an instant: a
01:30 treatment belongs to the previous trading date, and anything that re-derived the date would disagree
with the calendar for the nine hours either side of midnight. The cheapest way to make that impossible
rather than merely true is to hand the pure layer no instant at all.

So `KpiInput` carries dates as `LocalDate` keys taken from the facts, and a room closure arrives as
**minutes after the day's opening instant** rather than as a `tstzrange`. Rebasing `resource_block.period`
against `dim_date.opens_at` is one expression in the caller's SQL; after it there is nothing here a date
could be derived from, and the period itself is the set of `dim_date` rows the caller selected, so a date
the premises did not trade on cannot appear.

**The clip and the union are not defensive tidying.** A maintenance block scheduled while the premises is
shut is ordinary, so a closure must be clipped to `[0, open_minutes)` — unclipped, its length goes negative
and the arithmetic ADDS capacity. And nothing in 0012 forbids two `resource_block` rows over the same
minutes, so the closures of one room-day are UNIONED before they are summed — summed raw they subtract the
overlap twice, which drives the denominator below the occupancy and produces a utilisation above 100% with
nothing in either figure saying why. Both make `available_room_minutes` non-negative and not greater than
the open minutes **by construction**, which is what the "no utilisation exceeds 100%" property rests on.

## Why the RevPARH numerator is a partition of the chart's revenue accounts

"Treatment net revenue, with tips and retail excluded" cannot be read off an invoice. `invoice_line` (0026)
carries a description snapshot, a quantity and three money columns and **no revenue kind at all**. The
distinction exists exactly once in this build, in the chart of accounts, so that is where it is read —
which makes the two exclusions two different kinds of thing, and only one of them is a rule anybody could
relax:

- **A tip is not excluded. It is not revenue.** Migration 0068 records that "a tip is not consideration for
  a supply, so it appears on no tax invoice", and a gratuity posts to the `2040` tips-payable LIABILITY.
  It is outside the partition by construction, and the rule that keeps it outside is
  "claims only revenue accounts" rather than a filter.
- **Retail is excluded, and that is a choice with a reason.** A product sold at the desk occupies no
  room-minute, so counting it raises a figure whose denominator is room-hours — the one way to improve
  RevPARH with no extra treatment delivered.

It is a PARTITION and not a list of included codes for ADR 0064's reason one subject along: a list is
satisfied by a chart that has grown an account nobody classified, the new revenue lands in no set, the
figure drops it, and nothing fails. Both sides are declared and held equal to `STANDARD_SPA_CHART` itself,
so an account added to the chart and claimed by neither side is a failing test.

**The grouping is provisional against Y8-coa** and the marker is on every figure. Three placements are
judgements rather than readings and the one that will move a reported number is `4095` discounts and
allowances: there is one contra-revenue account for the whole business, so a discount given on a retail
product reduces this treatment numerator. Netting it out instead would report RevPARH before discount — a
gross figure wearing the word "net" — and splitting it needs a second discounts account, which is a chart
decision and not a reporting one.

## Why a zero denominator is a result shape and not a number

The acceptance line says "an explicit NoDenominator result rather than NaN, Infinity or 0", and `0` is the
worst of the three because it is the only one a screen will render without complaint: **a room utilisation
of zero is a real reading that means the rooms were idle, not that there were none.** The two facts have
different remedies and must not share a figure.

`NoDenominator` therefore carries the rendered divisor, so "no available room-hours" and "no trading day in
the period" are distinguishable. And `publishedFigure` takes the MEASURED variant rather than the union, so
the type system forces a caller past the empty case before it can print anything — which is the shape
R-REP-07's "the KPI tile's props accept only a discriminated union with no numeric fallback branch"
acceptance line asks for, available one unit early because it cost nothing here.

Every figure being an exact rational of `bigint`s is ADR 0064's argument reaching a second module: `Fils` is
a branded `number` capped at `Number.MAX_SAFE_INTEGER`, and `packages/db/src/queries/trial-balance.ts`
records what a `number` did to a cumulative position. It also removes the failure mode above structurally —
`bigint` division by zero throws rather than returning `NaN` or `Infinity`, so there is no path from an
empty denominator to a non-finite value even if the check were removed.

## What this costs

- **A KPI cannot express anything the expression language cannot.** A weighted average, a clamp, a
  conditional — none of them is writable as a KPI, and each would have to arrive either as a new node type
  (with its rendering and its unit rule) or as a new MEASURE, which is a reducer with a declared read set.
  That is the intended friction: the alternative is a `compute` that does something its formula does not
  show.
- **A measure's name is not checked against its reducer.** `reads` is, but nothing holds
  `room_occupied_minutes` to meaning what it says. The hand-computed fixtures are what carry that, and
  there is no mechanism behind them.
- **The (room, trading day) set is the caller's, and `rooms.is_bookable` has no history.** So available
  room-hours for a past period uses the rooms in service *now*. That is a property of the data rather than
  of this arithmetic — a decommissioned room's past capacity is not recorded anywhere — and it is handed
  to R-REP-04, which owns the queries that fill this input.
- **An hours figure is published to one decimal place and a ratio to four.** Stated once in
  `KPI_UNIT_DECIMALS`, and a unit is checked against the arithmetic that produced it — which required a
  small declared table of the three quotients this build's figures are, rather than a dimension system.
  A fourth kind of quotient is a line in that table.
- **No migration, no private SQLSTATE and no test port.** This unit adds no schema and starts no server.
  Every input it takes already exists in `reporting` or in `journal_line`, and a private code is for a
  refusal with a runbook answer (ADR 0043, 0061) — a pure function's refusals are thrown `AppError`s with
  their own names. Migration **0118**, the SQLSTATE band **ZY241–ZY250** and the port band
  **{ start: 15_800, width: 300 }** allocated to this unit are released unused; `SCHEMA_VERSION` is
  untouched and no paragraph was added to the migration ledger, there being no migration to document.
