# ADR 0073 — a forecast line is a COMMITMENT already on file, and a projection is marked so a screen cannot render it as a measurement

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** R-REP-06
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/00's "Seasonality including
  Ramadan and the summer exodus. Cash-flow forecast from recurring costs plus forward bookings and
  payroll" and docs/06 B6, and it stands on ADR 0060 (the reporting schema is derived and keyed on
  `business_day`), ADR 0064 (a statement is a directed sum over a partition, computed at read time),
  ADR 0068 (a KPI is an expression and a zero divisor is an answer), ADR 0070 (an unattributable cost is
  a refusal and never a zero) and ADR 0007 (integer fils)

## The problem this record is about

**A forecast is a number nobody can check until it is too late.** Every other figure in the R-REP set is
auditable the moment it is published: a statement line drills to `journal_line`, a KPI names the
expression it was computed from, a contribution margin names the costs it is missing. A closing-cash
figure for week nine can only be checked in week nine, and by then the decision it was read for has been
taken.

R-REP-05 is the contrast and it is deliberate: its acceptance line says LTV is "cumulative realised net
contribution per cohort" and requires "an arch test asserting no forecasting, regression or projection
code participates in the LTV path". This unit's acceptance line is explicitly a forecast. **What
separates them therefore has to be visible in the output rather than in the prose**, because the two
units publish numbers on the same dashboard, and a reader who cannot tell them apart will treat both as
measurements.

## Decision

**Four things, and the first two are what the dispatch asked this unit to decide.**

1. **A forecast line is a commitment already on file, re-timed. Nothing is extrapolated from history.**
   The forecast may be derived from exactly four things and from nothing else:
   - the **measured** cash position at `asOf`, from ADR 0064's cash account set;
   - **recurring cost occurrences** computed from contracted definitions;
   - **forward bookings** already in the diary at the gross snapshotted when each was taken, reduced by a
     show-up rate;
   - **payroll settlements**, which in this build is a refusal.

   There is no trend, no moving average, no regression, no growth rate and **no seasonality index**.
2. **No figure in the artefact is a bare number.** Every amount is a `ForecastFigure`, a discriminated
   union whose states are `measured`, `committed`, `projected`, `none_by_construction` and
   `unattributable`. A sum is as weak as its weakest part; one `unattributable` part poisons it and
   carries no `fils` field at all. The only function that produces a printable number,
   `publishForecastFigure`, takes only the three states that have one and returns the number **together
   with the qualifier that must appear beside it**.
3. **The seasonality index refuses rather than returning 1.00**, and it needs two separated occurrences
   of its bucket. Every bucket answers `no_data` over this build's own history, naming its observation
   count.
4. **The forecast is not materialised and the two modules are not connected.**
   `cash-forecast.ts` does not import `seasonality.ts`, and gate case 151j plants the import and requires
   its own scan to see it.

## 1. What the forecast may be derived from, and why "weeks of history" forecloses the obvious answer

The obvious design is the one every cash-flow tool ships: take the trailing weeks, apply a seasonality
index, project forward. It is foreclosed here by a fact about this business rather than by taste.

**The salon has weeks of trading, not years.** A seasonality index computed over its own data is an index
over almost nothing, and the arithmetic does not say so — it produces a number either way. Multiply a
cash figure by it and the assumption disappears into the figure: there is nothing left in the closing
cash of week nine that says it was scaled, by how much, or on what evidence. That is the same failure ADR
0070 describes for a zero cost, with one difference that makes it worse: a zero at least leaves the
figure at an identifiable extreme, while a multiplier near 1.00 leaves a figure that looks exactly like
an unscaled one.

So the rule is the other way round: **every line is a quantity somebody has already committed to, placed
in the week its cash moves.** What that buys is the only kind of checkability a forecast can have — each
line's error mode is "the commitment did not happen", which is a fact somebody can look up afterwards,
and never "the model was wrong", which is not.

The four permitted sources are each a commitment and each a different kind:

| line | the commitment | the state it reports |
| --- | --- | --- |
| opening cash | money in the bank | `measured` — the only one in the artefact |
| recurring costs, fixed | a contracted amount | `committed` |
| recurring costs, variable | a declared band | `projected` on that band's own id |
| forward bookings | an appointment taken at a snapshotted price | `projected` on the show-up rate |
| payroll | nothing; see below | `unattributable` |

**The seasonality index is published beside the forecast and a reader joins them.** That is a real cost:
the reader has to do the work, and a reader who does not will read a flat forecast through a quiet
August. It is accepted because the alternative hides the same error inside a number instead of leaving it
in front of one, and because the index itself has nothing to say yet — see section 3.

**Rejected: the receivables line.** An issued invoice not yet paid is as much a commitment as a
contracted rent, and leaving it out understates near-term inflow. It is out because this unit's
acceptance names three sources and a fourth would be scope invention, and because it needs a payment-term
assumption — "when does an issued invoice get paid" — which nobody has answered and which would be a
second `Y8`-class open question for a line nobody asked for. A later unit adds it as a `committed` line
with its own assumption, and nothing here has to change to let it.

## 2. How a projection is marked, and why a label would not have been enough

The requirement is that **no screen can render a projection as though it were measured**. A `provisional`
flag beside a number does not achieve it: a flag is something a renderer can forget to read, and the
forecast's figures travel through sums — a week's closing cash is built from an opening position, an
inflow and two outflows, and a flag on one of them has no defined behaviour under addition.

So the marking is structural in three places:

**The figure is a union, not a number.** `ForecastFigure` has five states and only three of them carry
`fils`. `unattributable` carries none at all, so there is no code path from an unknown to a number even
by mistake — which is the arrangement `MeasuredKpi` / `NoDenominator` already is one unit along (ADR
0068), extended with the two states a forecast needs that a KPI does not.

**The lattice makes the marking survive arithmetic.** `combineFigures` returns the weakest state of its
parts, with `unattributable` poisoning. So a week's closing cash is `projected` the moment one projected
amount reaches it, and `measured` survives only a sum of measured parts — which in this artefact means a
sum of one. **A contracted amount added to a bank balance is not a bank balance any more**, and the
figure says so without anybody having to remember. `cash-forecast.test.ts` proves the lattice as a
property over generated figure sets, with the count of mixed-state cases measured and asserted against a
floor (brief rule 22).

`none_by_construction` ranks with `committed` rather than with `measured`, and is deliberately not
`measured 0` — ADR 0070's argument, unchanged: "no recurring cost falls due in week seven" is a fact
about the contracts in the register, and a measured zero would be a bank account somebody looked at. The
difference matters most where it is least visible: a week beyond the booking window has no appointments
in the diary, and that is a fact about the diary and not a forecast of no revenue.

**The qualifier arrives with the number.** `publishForecastFigure` is the only way to a printable figure
and it returns `{ fils, state, qualifier }`, with `qualifier` non-empty for everything but a measurement.
So a caller cannot print the number without having the words in its hand; the worst it can do is discard
them, which is a visible omission rather than a missing branch. Its parameter type excludes the two
states that have no number, so the caller must narrow past them first — R-REP-07's "no numeric fallback
branch" reached one unit early, as `publishedFigure` already does for a KPI.

**And the caveat is derived rather than supplied.** R-REP-02 states that "a balance sheet read as a
movement is a balance sheet that omits every opening balance, which still balances" — the window a
statement reads is a property of the statement, not of its lines, because the artefact still looks
complete when it is wrong. The same class of caveat applies here, and the same remedy: `CashForecast.caveats`
is `FORECAST_CAVEAT` plus one sentence per assumption actually used, and no field of `CashForecastInput`
can empty it. A caveat a caller could switch off is a caveat that will be off on the screen it matters
on. Gate case 151e removes the constant and the suite notices — which "the caveats are not empty" would
not have, because the derived half is non-empty whenever an assumption was used.

### The show-up rate is the one guessed figure, and it is marked twice

`reporting.forecast_show_up_rate_bp`, 9,000 basis points — a 10% no-show rate, which is
`build/manifest.yaml`'s own provisional value — `provisional: true` against `Y9-windows`, so it appears on
the Unconfirmed Assumptions panel. It is **also** named on every figure it touches, because a panel is a
different screen and a reader of a cash figure has to be told there rather than having to already suspect
there is an assumption.

It is stated as the SHOW-UP rate although the handover expresses the no-show rate, because the figure is
a multiplier of booked gross: stating it as the multiplier removes the subtraction a reader would
otherwise do in their head, and somebody who misreads 9,000 as a no-show rate gets a visibly absurd
forecast rather than a plausible one that is 80% too low.

**It is deliberately NOT the strictest safe option**, which is the convention everywhere else in
`docs/OPEN-QUESTIONS.md`. There is no safe direction: too high overstates cash and too low understates
it, and both mislead whoever is deciding whether the rent is affordable. The only honest handling of a
figure with no conservative side is to mark it, which is what the flag and the on-figure assumption do.

The rate is applied **once per week** and not per booking, because it is a property of the population: a
single appointment either happens or it does not. The horizon total is the sum of the thirteen rounded
weekly figures and never a re-rounding of the horizon, which would differ by up to twelve fils and break
the articulation.

## 3. Why the seasonality index refuses, and why the floor is in occurrences

**An index of 1.00 is the dangerous value here, for exactly ADR 0070's reason.** "No seasonal effect
measured" and "we have not traded through a Ramadan yet" are the same number and different claims, and
only one of them survives the first Ramadan. A flat index is also the one value a screen renders without
complaint and the one a forecast would multiply by to no visible effect — so a reader would see a
seasonality model, see it saying nothing, and conclude the business is not seasonal. docs/06 B6 says the
opposite in so many words: "any forecast that assumes a flat year will be wrong twice annually".

So `seasonalityIndex` returns `KpiOutcome<SeasonalityIndexValue>` — **R-REP-04's union and not a fourth
one of this unit's own** — and answers `no_data` naming the observation count rather than producing a
figure it has no evidence for.

**The floor is two OCCURRENCES and not a number of days.** A Ramadan is about thirty consecutive trading
days, so a days floor of thirty is met by a single Ramadan — and one occurrence of a season cannot be
told apart from everything else that happened in the same weeks: a price change, a closure, a campaign, a
therapist leaving. Two is the smallest number that can repeat, and a repeat is the only evidence that an
effect belongs to the season rather than to the month it happened in. That is a methodological floor and
not a figure about this salon, which is why it is a named constant while the summer window is an
argument: answering `Y9-summer-window` changes which days are in the bucket and changes nothing about how
much evidence a claim needs.

`packages/fixtures/src/cash-forecast.itest.ts` **measures** that every bucket answers `no_data` over this
build's own history, rather than asserting it: it reads `reporting.dim_date` over the fixture's 120 days,
confirms not one of them carries an observance flag, and confirms `reporting.calendar_observance` holds
no row. That is R-REP-04's arrangement for the contribution margin, applied to a seasonality index.

### Why the index is a quotient of a REGISTERED KPI and not a KPI of its own

The index is `RevPARH(bucket) ÷ RevPARH(baseline)`, both computed by
`resolveKpi('revenue_per_available_room_hour')` over two different selections of `KpiInput`. **No KPI is
registered by this unit**, and the reason is ADR 0068's own: a KPI is an expression over measures folded
from ONE input, and an index is a quotient of two folds over two different SUBSETS of it — a partition
the expression language has no node for. Registering one would have meant a new node type, its rendering,
its unit rule and a fourth row in the quotient table, which ADR 0068 lists as the cost of its design.
Dividing one registered KPI's figure by its own figure over another population costs none of that and
leaves one statement of the arithmetic.

Three consequences, and the third is an acceptance line:

- **The index is an INTENSITY ratio and not a revenue ratio.** Ramadan revenue is lower partly because
  the premises is open for fewer hours and partly because demand moves. A raw revenue ratio blends the
  two and reports the reduced hours as reduced demand: on the fixture in `seasonality.test.ts` the
  revenue ratio is 0.2667 and the index is 0.5000. The hours denominator is what separates them.
- **The baseline is the trading days in NO bucket**, not "every day not in this bucket". Otherwise the
  Ramadan index would be measured partly against the summer and the summer index partly against Ramadan,
  so each would be partly the other's reciprocal and neither would mean what its name says.
- **The hours denominator reads `premises_hours`, transitively, with no arithmetic here.** RevPARH
  divides by `available_room_hours` → `available_room_minutes` → `room_open_minutes` →
  `businessDays.openMinutes` → `reporting.dim_date.open_minutes` → `business_day.duration_seconds`
  (generated by 0011 from the day's instants) → `premises_hours` and `premises_hours_override`. The
  integration suite writes a Ramadan hours override over a reserved year, regenerates `business_day`,
  refreshes `dim_date`, and reads **0.4000 before and 0.5000 after** out of unchanged code. That is
  R-REP-06's third acceptance line, and it closes ADR 0068's "fifteen hours is correct today" hazard from
  the database side.

### The observance impact is reported twice and there is no field that adds them

`ObservanceImpact` has exactly two sides, `confirmed` and `provisional`, and no combined total — because
a blended figure cannot be unblended by whoever reads it. A dirham of impact resting on a date the
authority has not announced is a different claim from one resting on 1 January: the remedy for the first
is to wait and the remedy for the second is to staff differently.

"Rather than one blended number" is made a CHECK rather than a comment by asserting the KEY SET:
`OBSERVANCE_IMPACT_SIDES` is the whole of it, and both suites assert `Object.keys(impact)` equals it, so a
`total` added to the type fails by name.

A day carrying both a settled and an unsettled observance is reported as **provisional**, and the
asymmetry is deliberate: such a day may stop being a holiday the moment the announcement comes, so
reporting it as settled would report the part that cannot move and stay silent about the part that can. A
day with no observance is on neither side, which is why the two counts do not add to the period and why
each side carries its own `shareOfPeriodBp`.

The pure refusal `LunarDatePresentedAsSettled` is only a sound guarantee while
`reporting.calendar_observance_lunar_is_provisional` holds, so the integration suite **probes the
constraint** as well as the function: a lunar observance that is not provisional cannot be stored, which
is why `dim_date` can never report one on the confirmed side.

## 4. Why the two modules are not connected, and why nothing is materialised

`cash-forecast.ts` does not import `seasonality.ts`, and that is enforced rather than observed. Gate case
151j is a scan of its own with a planted import, because the rule is about one file in one direction and
both modules are in `packages/core` — `pnpm boundaries` cannot express "A may not import B inside one
package" without a rule nobody else needs.

The forecast is **not materialised**, which is ADR 0064's conclusion for the statements reaching one
subject further. It is recomputed from `journal_line`, the recurring cost definitions and the diary at
read time, and a stored 13-week snapshot would be a second statement of a figure the two would disagree
about the first time a booking was cancelled. If a later unit needs "the forecast as it was on the day
the owner decided", that is a stored artefact with a content hash — ADR 0044's shape for a filed VAT
return, and `forecastBytes` is already the canonical form it would be hashed over — and not a table this
unit invents on the off-chance.

### What the articulation proves, and what it does not

`opening + inflows − outflows = closing` is true by construction, because `closing` is defined that way.
That is ADR 0064's point about the balance sheet balancing, one subject along, and this unit says so
rather than presenting the identity as the check. What the articulation does prove is that the artefact is
a **chain** and that its totals are a **second, independent read** of its lines:

- each week's opening is the previous week's closing, so no week re-reads the ledger half way through the
  horizon and presents a jump nobody can drill to;
- the horizon totals are summed from the LINES across all thirteen weeks while each week's subtotals are
  summed from its own lines, and `totalsDifferenceFils` holds the two readings equal. **A line dropped
  from one week keeps every weekly identity and fails only this one.**

**A refused figure makes the difference `null` and not `0`**, and that is the subtlest decision in the
module. A week whose outflow is `unattributable` has no identity to satisfy; treating the missing figure
as zero would make the week articulate, which is the artefact asserting that an unknown is nil — ADR
0070's substitution arriving through the back door of a check rather than through a figure. A null is
visible. A satisfied identity over a missing number is not. The first version of this unit computed the
difference over zeros, and its own integration suite caught it: `week 1 is out by 1850000 fils`.

## The payroll line refuses, and the two gaps are independent

Payroll is where this build's data runs out twice over, and both gaps are reported because answering one
does not answer the other:

1. **There is no pay date anywhere.** `payroll_run` records `period_starts_on` and `period_ends_on` and
   **no date on which the money leaves the bank**. A cash forecast is about dates, and a 13-week horizon
   holds three payroll settlements — so putting one on the last day of the period, or on a fixed day of
   the following month, moves a whole month's wage bill into or out of the horizon. That is not a rounding
   error and it is not a figure this build may choose. Recorded as **`Y8-payroll-date`**.
2. **Every wage is NULL.** `employee.basic_wage_fils` is unset for every employment record
   (`Y8-staff`), which is the state ADR 0070 was written about.

So `ForecastPayroll` is a refusal-capable INPUT rather than a list that might be empty, because an empty
list is a real and different answer — "no settlement falls due in this horizon". `payrollForecastCensus`
in `packages/db` returns **no amount at all**, not even the total of the wages that are on file: a partial
wage bill is a number a screen renders that is lower than the real one by exactly the employees nobody has
priced.

`aPayDateIsRecordedAnywhere` is a read of `information_schema` rather than a constant, so the day somebody
adds the column the census stops claiming there is none.

**The refusal propagates to every week rather than to the weeks a settlement would have fallen in**, and
that is the decision: when the pay date is unknown, which weeks the wage bill belongs to is exactly what
is unknown, so a week reported as nil would be claiming the money does not leave then. ADR 0070's
direction argument is sharper here than anywhere else in the build — an understated outflow OVERSTATES
closing cash, on the screen somebody decides whether they can pay the rent from.

The inflow side still reports while the outflows refuse, so the artefact says what it does know. A
refusal that took the known figures down with it would be a report that stops being useful at the first
gap.

## What this costs

- **The headline figure this unit is named for cannot be completed from this build's data.** Closing cash
  is `unattributable` in every one of the thirteen weeks until `Y8-payroll-date` and `Y8-staff` are
  answered, and the integration suite MEASURES that rather than asserting it. The arithmetic is complete
  and is exercised against a hand-computed fixture in which every component is supplied; what is missing
  is figures, and a figure invented here would be indistinguishable from a configured one (brief rule 15).
- **Every seasonality bucket answers `no_data`, and will until the salon has traded through two of each.**
  That is two years for Ramadan and for the summer. Answering `Y9-summer-window` does not shorten it: the
  window decides which days are in the bucket and the occurrence count decides whether there is an index.
- **The seasonality index and the forecast are two artefacts a reader has to join.** Stated as a cost
  rather than defended: a reader who does not join them will read a flat forecast through a quiet August.
  The alternative buries the same error inside a number.
- **Two new open questions.** `Y8-payroll-date` and `Y9-summer-window`, neither of which existed. The
  first is a real gap this unit found in `payroll_run`; the second is the window docs/06 B6 observes
  without anybody having confirmed it against takings.
- **Three facts are now stated twice, each with the check that holds it equal in the same commit.**
  `forecastBytes` against `statementBytes` (`packages/core` may not import `packages/db`); core's
  `PayrollCensus` against db's `PayrollForecastCensus` (the same unavoidable pair as
  `PeriodFigures` / `KpiPeriodFigures`); and `SHOW_UP_RATE_WHOLE_BP` against `WHOLE_IN_BASIS_POINTS`
  (`@berelax/config` depends on `@berelax/shared` alone). All three are asserted in
  `packages/fixtures/src/cash-forecast.itest.ts`, the one package that can import each pair at once.
- **The integration suite refreshes `reporting.dim_date`, which rebuilds every row of it.** There is no
  narrower way: the view is a materialised view over the whole of `business_day`, so the suite's own
  trading dates cannot exist in the reporting schema without it. It is safe because the schema states no
  fact of its own (ADR 0060) and `reporting.refresh()` is its only writer, and the suite removes its
  `business_day` rows and refreshes again. Nothing is truncated and no `delete` is unqualified, so there
  is no `suite-table-declarations.ts` entry.
- **The journal refuses DELETE, so the suite's own revenue postings stay.** They are dated in a reserved
  year nothing else reads and are scoped out of every figure by date, which is why the suite searches for
  a fresh span of fourteen trading dates on each run rather than fixing one.
- **One migration, and it adds no schema.** 0122 inserts the `agent_definition` and `agent_heartbeat`
  rows behind the weekly cron, because `apps/worker/src/job.ts` requires an agent on any job with one and
  an agent is a row. The alternative — a queue-only job with no cron — is worse for this unit
  specifically: the figures it can produce today are mostly refusals, and a report that only runs when
  somebody asks for it is a report whose refusals are seen by whoever already suspected them. The
  SQLSTATE band **ZY281–ZY290** and the test port band **{ start: 17_000, width: 300 }** are released
  unused, the codes deliberately left unregistered because `pnpm sqlstate` refuses an entry for a code no
  migration raises — and nothing here can be refused by the database, since nothing here writes.
