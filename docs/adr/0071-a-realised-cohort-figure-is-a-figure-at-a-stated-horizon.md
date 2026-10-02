# ADR 0071 — a realised cohort figure is a figure at a STATED HORIZON, and a lifetime value is not one

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** R-REP-05
- **Covers:** docs/01 decisions — none; this is the mechanism behind what docs/03 §7 asks for as retention
  cohorts, LTV, CAC and payback, and it stands on ADR 0007 (integer fils), ADR 0043 (a private code is
  for a refusal that needs one), ADR 0060 (the reporting schema is derived and keyed on `business_day`),
  ADR 0064 (a statement is a directed sum over a partition), ADR 0068 (a KPI is an expression) and
  ADR 0070 (an unattributable cost is a refusal and never a zero)

## Decision

**Four things, and the first is what the other three are for.**

1. **A cohort figure is reported at a stated horizon, and a horizon the cohort has not lived is
   REFUSED.** `cohortRealisedWindow` is the only thing that builds the `cohortMonths` rows every cohort
   measure restricts itself to, and it throws `CohortHorizonNotReached` rather than answering a smaller
   number. There is no horizon argument in the KPI input at all — the window IS the rows — and
   `comparableHorizon` exists so that a set of cohorts is compared at a horizon all of them reach.
2. **No forecasting, regression, projection, decay or annualisation construct may be reachable from the
   LTV path.** That is an arch rule over the module graph, with its own closure check, because the
   construct that breaks it is a plausible helper rather than a wrong signature.
3. **An unattributable acquisition is a refusal and never a zero**, which is ADR 0070 applied to the
   other side of the subtraction: a cohort value built from net revenue reports the highest possible
   lifetime value, and a CAC over a marketing total no channel claims reports a figure
   indistinguishable from one.
4. **The outstanding package liability's per-session gross is the release formula's own complement,
   not a division.** `floor(value × remaining ÷ total)` ≡ `value − ceil(value × redeemed ÷ total)` for
   whole `value`, so the schedule ties to `2050` by an algebraic identity rather than by a rounding
   convention that happens to agree.

## Why "at a horizon" rather than "labelled provisional"

The acceptance line says retention is **realised, never forecast**. The obvious implementation of that
is discipline: compute only what happened, and do not write the extrapolation. It is not enough, and the
reason is not that somebody will disobey it.

A cohort's realised value **rises every month the cohort is observed**. So the figure for a cohort
acquired twelve months ago and the figure for one acquired last month are not the same kind of number,
and nothing in either number says so. Put them in one column headed "LTV" and the youngest cohort always
looks the worst — which is the opposite of the truth about a business that is growing — and the oldest
looks like the target. **The forecast does not have to be computed anywhere for the report to be read as
one.** It is supplied by the reader, from the word "lifetime".

Three repairs were available:

- **Label the figure provisional.** ADR 0068's marker, carried on every result. It records that a
  definition rests on an assumption; it cannot record that two figures in one column are at different
  horizons, because the horizon is not an assumption — it is data.
- **Report the horizon beside the figure and leave the comparison to the reader.** Better, and it is
  half of what is done: `cohort_realised_months` is a measure, it appears in the published formula of
  every figure that divides by it, and `cohortMonths` is on the input. On its own it is a column somebody
  will sort by the wrong one of the two.
- **Make the horizon the thing the figure is indexed BY, and refuse one the cohort has not lived.**

The third is taken, and the refusal is the part that does work. `cohortRealisedWindow(cohortMonth,
horizonMonths, throughMonth)` throws when `horizonMonths` exceeds the months that have fully elapsed, so
a value over a month that has not finished is unreachable rather than discouraged. `throughMonth` is a
trading month the caller supplies and never a clock read, for ADR 0060's reason: a date comes from
`business_day` and is never derived from an instant.

**What this costs** is that there is no single figure called "the LTV of this business". There is a
figure per cohort per horizon, and `comparableHorizon` of a set that includes a cohort acquired this
month is **nought** — the caller gets nothing to compare rather than a small number. That is the correct
answer and it is an inconvenient one: a dashboard asking "what is our LTV" has to say which cohort and
how long it has been held.

**And the figure is never called a lifetime value.** `cohort_realised_value_per_customer` is the
registered id, and the label says the horizon. That is not squeamishness about a word: the id appears in
`formula`, in `expandedFormula` and on every result, and a name that claimed a lifetime would be the one
statement in this unit that was not checkable.

## Why an arch rule, and why its own closure is the load-bearing part

A type cannot stop this. `projectedLifetimeValue(cohort, decayRate)` has the right signature, computes a
`bigint`, and the `bigint` renders beside the realised one. So the rule reads the CODE of every module the
LTV path reaches and refuses a declared table of constructs: a call that forecasts, a declaration naming
a curve or a rate, a rate identifier applied forward, floating-point curve arithmetic, and an import of
any of them.

Two things about it are worth recording, because both were wrong in the first version.

**The patterns require CODE syntax, not words.** This unit's whole argument has to be written down
somewhere, and the place it is written down is the modules the rule scans. A rule that could not read
past a comment would fire on the sentence explaining why there is no forecast — which is the failure
`scripts/lib/strip-non-code.mjs`'s own header records one subject along, where the colour gate's first
run flagged the Tailwind class names in the sentence forbidding them. A rule that fires on its own
documentation gets turned off.

**`bigint` exponentiation is not compounding, and the first version of the rule did not know that.**
It refused `**` outright and fired on `scaledFigure`'s `TEN ** BigInt(decimals)` — the fixed-point
scaling ADR 0068 already states is the one place rounding happens. The repair was not an exception: a
compounding projection needs a **rate below one**, a rate below one is not a `bigint`, and the only way a
float enters a module whose every figure is an exact rational of `bigint`s is through `Math.exp`,
`Math.pow`, `Math.log` or `Math.sqrt`. So the rule names those four and `**` is not a construct at all.
The narrower rule is the stronger one.

**The closure check is what stops the whole thing being green and dead.** An empty closure, a blanked
pattern table and a renamed import each produce zero findings and a passing scan, and the first of those
is what a moved module looks like. So `ltv-path-closure-reaches-its-own-modules` is a finding of its own,
the suite names the modules the closure must reach, and gate block 149 blinds each half separately —
including by planting a real `decayCurve` in a real module on the real path, because a rule proved only
against a synthetic module is a rule proved against a synthetic module.

The scope is stated rather than implied: relative `.ts` imports within `packages/core/src`, which is the
tree the arithmetic is in. It does not follow `@berelax/shared`, for the reason
`check-core-purity.mjs` gives about the same boundary — a rule applied to code nobody examined is how a
gate acquires exceptions.

## Why CAC is a mechanism without a figure, and what was refused to keep it that way

`CAC = paid acquisition spend ÷ new customers acquired through a paid channel`. **Both halves are absent
from this build, and they are absent differently.**

- **The spend is recorded and is not attributed to a channel.** Ad spend lands on `6070 Marketing and
  advertising` through `bill_line.expense_account_code` or `recurring_cost.expense_account_code`
  (migrations 0028 and 0031), and neither table has a channel column — a search across every migration
  finds only the messaging estate's `channel`, which is an SMS-or-WhatsApp transport. So the movement on
  `6070` is readable and it mixes paid acquisition with signage, print and the shopfront. Measured on a
  database migrated and seeded from clean: **zero `bill_line` rows, zero `recurring_cost` rows and zero
  `journal_line` rows on `6070`.**
- **The denominator's classification does not exist and could not be derived from what does.**
  `customer_acquisition_source` (0053) holds six labels — `walk_in`, `whatsapp`, `phone`, `web`,
  `referral`, `unknown` — and none records whether the touch was bought. A `web` booking may have come
  from organic search, from a link in a reminder or from an advertisement click, and the row cannot tell
  the three apart. Paid-ness is a property of the TOUCH, which is A-FIRST-08's attribution row and its
  medium, and that unit does not exist yet.

**Classifying `web` as paid would have been one line and is exactly the refused move.** It is ADR 0070's
rejected pro-rata allocation in a different place: a policy decision disguised as a calculation, where
the choice decides the figure and the figure is what an acquisition budget is set from. `Y9-crm-source`
already says the same thing about the labels themselves — "a plausible attribution is indistinguishable
from a recorded one".

So `FIRST_TOUCH_PAID_CLASSIFICATION` classifies all six as `not_recorded`, with the reason on each
entry, and its totality is a **typecheck** rather than a findings rule: it is a `Record` over a closed
union, so a label added to `CUSTOMER_ACQUISITION_SOURCES` and left unclassified fails `pnpm typecheck`
naming the file. That is stronger than the runtime check `REVPARH_REVENUE_PARTITION` needs, and it is
available here only because the vocabulary is a union in `packages/core` while a chart of accounts is a
list of rows.

`not_recorded` is deliberately not `unpaid`. `unpaid` would be the claim that these customers cost
nothing to acquire, which is the same substitution ADR 0070 refuses one subject along.

**The spend has two states and not three.** `channelAttributedSpend` carries rows that each name a paid
channel — and an EMPTY row list is legitimate, because a period in which the business genuinely spent
nothing has a real figure of zero. `spendNotChannelAttributed` carries a total that no channel claims and
`acquisitionSpendRows` refuses it. There is no `measured total` state, because that is the one shape a
caller would be tempted to divide by.

**The refusal is upstream of the registry, and that is structural rather than stylistic.** A measure can
only return a `bigint`, so an absent spend would arrive as an empty dataset and a CAC of zero — a free
customer, which is ADR 0070's free treatment with the sign reversed. There is no parameter a total could
enter through.

**And the unattributed share is published beside every CAC rather than folded into it.** A CAC over the
attributed subset is a figure whose denominator moves with how much happens to be known; with the share
beside it, a CAC computed over 4% of acquisitions is visibly that. It is the arrangement R-REP-04's
`kpiDiscountCoverage` already uses, which ADR 0070 names this unit as the source of. Against this
build's own data the share is the whole of it, and `cohorts.itest.ts` measures that.

## Why the liability needs a third read of one figure

There are now three independent readings of what the business owes its package holders:

1. **`sold − released`**, which is `readPackageLiability`'s (M-TILL-10) and reads the `package_sale` and
   `package_redemption` totals. Wrong if a balance row disagrees with its sale.
2. **`2050`'s own balance**, read from `journal_line`. Wrong if a posting was missed.
3. **`Σ remaining_sessions × the per-session gross`**, which this unit's acceptance line asks for and
   which is the only one at the grain the entitlement has: a holder with two sessions left on one line
   and none on another.

`reconcilePackageLiabilityToLedger` holds all three equal. It is not a second statement of a figure in
the sense the brief warns about — it is `month-reconciliation.ts`'s arrangement, where "the refinement is
not a second answer, it is an answer whose total the report itself holds to the one source", and each
identity is a named LINE of the report.

**The per-session arithmetic is where "to the fils" is won or lost.** The obvious implementation,
`remaining × round(value ÷ total)`, is wrong for most real packages: 0078 allocates a sale's price across
the version's lines by largest remainder (ZG006) and 0083 releases a line's share as
`ceil(value × redeemed ÷ total)`, so a price that does not divide by its session count has **no single
per-session figure**. Three sessions of a 10,000-fils line are worth 3,333, 3,334 and 3,333 in the order
they are taken.

So the share is the release formula's own complement, and the tie is an identity rather than an
agreement: `v − ceil(vr/n) = v + floor(−vr/n) = floor(v(n−r)/n)` for whole `v`. This is worth recording
because of how the broken version behaves: `remaining × floor(value ÷ total)` **agrees with both
hand-computed fixtures** — 10,000 over 3 sessions gives 6,666 and 3,333 either way — and differs at 5
fils over 3 sessions. The property test over 500 generated balances is what notices, and it counts how
many of its cases have a non-zero remainder against a floor measured over twelve runs (brief rule 22).

**`2050` is read SPLIT BY `journal_entry.source`, and that split is the second thing this unit adds.**
H-MIG-03 posts a reconstructed package's opening liability as `Dr 3030 / Cr 2050` with
`source = 'opening_balance'`, and it also writes the `package_sale` and `package_balance` rows the
schedule reads. So a schedule compared against a `2050` balance scoped to the till's two sources would
be out by exactly the imported liability, with a message naming neither the import nor the scope.
`readPackageLiability` uses that narrower scope deliberately, for a claim about what the till wrote, and
it is right for that claim and not for this one. `other` is **reported rather than filtered**, because
`2050` is a real account and nothing stops an accountant posting an adjustment to it — ADR 0064's census
argument, where "an account posted to that no line claims leaves the sheet balancing and is invisible to
every identity".

## What this costs

- **The headline figure this unit is named for cannot be computed from this build's data either.** A
  cohort value is a cumulative realised CONTRIBUTION, and ADR 0070 settled that three of the four cost
  components do not exist — so `cohortContributionRow` refuses a delivery whose margin is
  `not_attributable`, and `cohorts.itest.ts` MEASURES that no delivery in this database has an
  attributable cost rather than asserting it. The mechanism is complete and is asserted to the fils
  against both hand-computed fixtures and real deliveries with the costs stated. What is missing is
  figures, and `Y9-unit-cost-basis` is where they are.
- **CAC, its payback and the unattributed share answer `no_denominator` against this build today**, and
  that is the correct answer rather than a gap. `Y9-paid-channel-attribution` is the new row that would
  change it; no arithmetic here moves when it is answered.
- **Four new units and four new lines in the quotient table.** `customers`, `months`,
  `fils_per_customer` and `fils_per_customer_month`, with `fils ÷ customers`, `customers ÷ customers`,
  `fils_per_customer ÷ months` and `fils_per_customer ÷ fils_per_customer_month`. ADR 0068 names that
  table as its own extension point ("a fourth kind of quotient is a line in that table"). The two counts
  are separate members rather than one dimensionless `count` deliberately: `fils ÷ customers` and
  `fils ÷ months` are different figures, and a single count would have made a lifetime value and a
  monthly run rate interchangeable on the same screen.
- **Five new datasets on `KpiInput`, and a probe module for them.** The reads rule needs a probe with
  rows in every dataset, the registry is now one registry spanning two units, and R-REP-03's probe lives
  in its own suite — so `cohort-kpi-probe.ts` holds this unit's rows and that probe spreads them in. A
  dataset added by a later unit has a visible place to put its rows rather than a reason to weaken the
  rule.
- **Two mechanisms for "one cohort per merged customer".** The query groups on `merge_survivor_of` and
  `collapseCohortMembers` collapses whatever arrives. Redundant in the steady state and not in the one
  that matters: a materialised view is only as current as its last refresh (ADR 0060), and the window in
  which the first mechanism is needed is exactly the window in which somebody has just run a merge and is
  looking at the screen to see whether it worked. `cohorts.itest.ts` refreshes, then merges, then queries
  without refreshing.
- **`packageSoldLessReleasedFils` is a second READ of M-TILL-10's figure.** The same subtraction over the
  same two tables, existing only because `readPackageLiability` returns `number` and every figure here is
  `bigint` for ADR 0064's measured reason. The pairing suite holds the two equal in the same commit,
  which is what stops it becoming a second answer.
- **No migration and no private SQLSTATE.** Every input already exists in `reporting`, in `public` or in
  `journal_line`; nothing new is written; and every refusal here is a refusal of ARITHMETIC — a horizon
  the cohort has not lived, a cost nothing can attribute, a marketing total no channel claims — none of
  which the database can raise. A private code is for a refusal with a runbook answer at the database
  boundary (ADR 0043, 0061). The migration number **0120** and the band **ZY261–ZY270** allocated to this
  unit are released unused, as is the test port band `{ start: 15_800, width: 300 }` — nothing here
  starts a server. `SCHEMA_VERSION` is untouched and no paragraph was added to the migration ledger,
  there being no migration to document.
