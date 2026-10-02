# ADR 0070 — an unattributable cost is a refusal, and never a zero

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** R-REP-04
- **Covers:** docs/01 decisions — none; this is the mechanism behind what docs/03 §7 asks for as
  "contribution margin per service" and the operational KPI set, and it stands on ADR 0007 (integer
  fils, gross authoritative), ADR 0043 (a private code is for a refusal that needs one), ADR 0047
  (commission is reproducible by pinning its version), ADR 0060 (the reporting schema is derived) and
  ADR 0064 (a statement is a directed sum over a partition)

## Decision

**Four things, and the first is what the other three are for.**

1. **A cost component is `measured`, `none_by_construction` or `unattributable`, and `0` is not one of
   those states.** A margin is reported only when every component of
   `net_price − (therapist + consumables + room_consumables + payment_fee)` is stated and none is
   unattributable. Otherwise the result is `not_attributable`, naming the components and the open
   questions.
2. **A per-unit cost is DIRECTLY attributable or it is not attributable at all.** A share of a period
   total is never a per-unit figure. There is no pro-rata allocation anywhere in this unit.
3. **Every KPI returns `value`, `no_denominator`, `no_data` or `not_attributable`** — never `NaN`, never
   `Infinity` and never `0` standing in for one of the other three.
4. **Nothing in this unit holds a rate, a fee, a window length or a cost.** Every figure is an argument.
   Three of the eight KPIs therefore answer `no_data` against this build's own database today, and that
   is the correct answer rather than a gap.

## Why a zero is the dangerous value here, measured rather than argued

Substituting zero for an unknown cost is not a conservative simplification. It reports the **highest
possible margin**, on the screen somebody prices from, and it is indistinguishable from a cost that was
genuinely nil.

This build has already paid for that lesson once, one subject along.
`rota_version.forecast_unpriced_employees` exists because of it, and the column's own comment says why in
so many words: *"an employee with no wage contributes nothing to a sum, so a forecast over a rota where
no wage is recorded is 0 fils and reads as a free rota. All nineteen seeded employees are unpriced."*
That is **the ordinary state of this database today**, not an edge case — and the same arithmetic over a
treatment rather than a shift would read as a treatment that costs nothing to deliver.

So the three states are not error handling. They are the arrangement R-REP-07 needs one unit later — "a
tile physically cannot render a number whose check is failing" — reached by the KPI never producing one.

**`none_by_construction` is deliberately NOT `measured 0`.** A cash tender carries no acquirer fee
because there is no acquirer; a card tender measured at 0 fils would be an acquirer that charged nothing.
The two are the same number and different claims, and only one of them survives somebody signing an
acquirer agreement. A single zero cannot carry that difference, which is the same argument ADR 0060 makes
for splitting `is_public_holiday` into three columns rather than blending them into one.

## Why "attributable" is the whole difficulty, and what it rules out

`net_price` exists and is a snapshot. The four costs are not the same kind of thing, and three of them do
not exist in this build at all:

- **therapist.** Two paths, neither with a figure. P-HR-11's `commission_line` is per appointment, which
  is exactly the right grain — but the module ships disabled with no published rule version
  (Y9-commission) and the engine produces zero lines rather than paying a rate this build invented. And
  the wage path cannot be derived: `employee.basic_wage_fils` is NULL for all nineteen employment records
  (Y8-staff). `kpiTherapistCostCensus` counts both facts so that "no commission because the module is
  off" is never reported as "no commission is due" — the distinction `commission_run.module_enabled`
  exists for.
- **consumables and room_consumables.** The ledger holds the period's total on `6030 Treatment
  consumables used`. Nothing anywhere records what one treatment consumed: there is no bill of
  materials, no product per service and no room cost.
- **payment_fee.** The only component with a real answer for part of the population, and it is derived
  rather than stated: a tender debited to a CLEARING account is one a processor settles in a batch, net
  of fees, which is `0068_payment_tender.sql`'s own reason for `card_in_salon` debiting 1040 rather than
  the bank. So cash and bank transfer are `none_by_construction` and the two card tenders are
  `unattributable` against Y7-card-fee. A tender kind added to `TENDER_KINDS` is classified by
  construction, because the classifier reads `TENDER_ACCOUNT` instead of listing the tenders again.

**The rejected alternative is the obvious one: allocate the period totals pro rata.** `6030` divided by
treatments delivered, `5010` divided by treatment minutes, `6080` divided by card turnover. Each is one
line of arithmetic and each is a **policy decision disguised as a calculation**: the basis (per treatment,
per minute, per revenue dirham) changes which services look profitable, and nobody has chosen one. ADR
0064 rejected a pro-rata split inside the cash flow for the narrower version of this reason — "a rounding
rule inside a statement whose acceptance is to the fils" — and here the consequence is larger, because the
output is a ranking of services by margin that somebody prices from.

A monthly salary is in any case a cost of the MONTH and not of a treatment. That is why the period-level
KPIs (labour cost %, break-even) read the ledger and the per-unit margin does not: the two are different
grains and sharing one figure between them is what an allocation basis would be hiding.

## Why break-even and the contribution margin ratio are `no_data` rather than figures

Both divide by a fixed/variable split of the expense accounts, and **nothing in this build classifies an
account as fixed or variable**. `account` carries `type`, `normalBalance`, `contra`, `vatBox` and
`inputVatRecoverable`, and no cost behaviour.

The split is not arithmetic. Rent is fixed and consumables vary, but `6020 Utilities` is semi-variable,
`6070 Marketing` is discretionary, and `5010 Therapist wages` is the load-bearing one: fixed for nineteen
monthly-salaried staff and variable under a commission structure nobody has published. A split chosen
here would decide the headline figure *"the revenue this salon must take to break even"* on this build's
guess about somebody else's cost structure, which is brief rule 15 applied to a classification rather
than to a number. So `variableCostFils` and `fixedCostFils` arrive as `bigint | null`,
`kpiPeriodFigures` returns `null` for both, and the two KPIs answer `no_data` naming them.

It is **not** declared the way R-REP-02 declared its statement layout against Y8-coa, and the difference
is worth stating: a statement layout that groups an account into a line is checkable against the chart in
both directions and is visible on the artefact, while a cost behaviour is invisible in the figure it
produces. A reader can see which line an account is on; nobody can see from a break-even number which
costs were called fixed.

## The KPIs that are `0` and are RIGHT to be

Two, and both are measured zeros rather than refusals:

- **no-show cost in a period with no no-shows.** The sum over an empty set, which is a fact and a good
  one. It is a sum and not a division, which is why zero is available to it at all.
- **retail attachment.** `basket.ts` has four line kinds — service, discount, tip, package redemption —
  so nothing in this build can sell a retail product (ADR 0021: services and packages only), and no
  ticket can carry retail. The mechanism reads postings to `4030 Retail product revenue` through
  `checkout_finalisation`, rather than a product table, so the figure starts answering the day a retail
  line kind exists and needs no change here.

## A KPI period is bounded on three different columns

Stated because it reads as one thing and is not: a delivery is bounded on `appointment.trading_date`, a
tax document on `invoice.tax_point_date`, and a ledger position on `journal_entry.entry_date` — which
deliberately has no foreign key to `business_day`, because the journal must record the rent for a month
containing days the premises were shut (ADR 0064).

A supply delivered on the last trading day of a month and invoiced the next morning keeps its tax point
in the old month (0026) while its journal entry is dated in the new one. Reading one window with
another's column moves money between periods, which is `date(occurred_at)`'s defect one layer down (ADR
0060). So **net revenue is the DOCUMENTS' net** — invoices less credit notes over their tax points, the
quantity `fact_sale` sums — and not the revenue accounts' movement, so that labour cost %'s denominator
cannot disagree with every other revenue figure in the build by whatever straddles a boundary.

## Discount leakage: what the figure covers, exactly

`discount_leakage = Σ (list gross − charged gross)` over invoice lines, and both figures are snapshots:
the charged gross is `invoice_line.unit_gross_fils × quantity`, generated in the database, and the list
gross is `appointment.gross_price_fils` reached through `invoice_appointment`, which
`serviceLineFromAppointment` copies "field for field" into the basket line the till then discounts. So
the difference is the reduction applied **at the till**, exact to the fils, drilling to the `invoice_line`
rows.

Two limits are reported rather than smoothed over:

- **a line that bills no appointment has no list price snapshotted anywhere**, so it makes the figure
  `not_attributable` rather than contributing zero. `invoice_appointment.line_no` is nullable by design
  and a document may be raised outside a checkout.
- **a price reduced by a `price_list` row or a promotion is already inside
  `appointment.gross_price_fils`,** and the catalogue price it was reduced from is snapshotted nowhere —
  `dim_service.list_gross_fils` is the price TODAY (0110). So a campaign menu is invisible to this
  figure, and `kpiDiscountCoverage` counts the deliveries in that state so a report states its coverage
  instead of quietly meaning less than its label. That is R-REP-05's arrangement for its unattributed CAC
  share, applied here.

## What this costs

- **The headline figure this unit is named for cannot be computed from this build's data.** Contribution
  margin per service answers `not_attributable` for every service in every period until somebody answers
  Y9-unit-cost-basis, and `packages/fixtures/src/contribution-margin.itest.ts` MEASURES that rather than
  asserting it — zero published commission rule versions and every delivering employee unpriced. The
  mechanism is complete and is exercised against hand-computed fixtures; what is missing is figures, and
  a figure invented here would be indistinguishable from a configured one (brief rule 15).
- **Two statements of the figures bag.** `PeriodFigures` in `packages/core` and `KpiPeriodFigures` in
  `packages/db` are the same interface written twice, because `db` may never import `core` (ADR 0001).
  They arrive with the check that holds them equal in the same commit: a type annotation in the pairing
  suite, plus a runtime comparison of the field sets, so a field renamed on either side is a
  `pnpm typecheck` failure and a field read by `db` and never looked at by `core` is a test failure.
- **This unit adds NO migration and NO private SQLSTATE, and that is the same conclusion ADR 0064
  reached for R-REP-02.** Every refusal here is a refusal of ARITHMETIC — a cost list missing a
  component, a negative cost, a surcharge reported as leakage — and none of them can be raised by the
  database, because there is no new relation and nothing new is written. A private code is for a refusal
  that needs a runbook answer at the database boundary (ADR 0043, 0061). The migration number **0120**
  and the band **ZY261–ZY270** are released unused, as is the test port band
  `{ start: 17_000, width: 300 }` — nothing here starts a server. `SCHEMA_VERSION` is untouched and no
  paragraph was added to the migration ledger, there being no migration to document.
- **The KPI registry is R-REP-03's and this unit does not build one.**
  `OPERATIONAL_KPI_DEFINITIONS` is a frozen `Record` over a closed union of ids with no lookup function
  and no mutation: a set to be registered, not a registry. Each definition carries the same pure function
  the typed export is, plus the adaptation from the figures bag, so there is one statement of every
  figure and R-REP-03's registry can register all eight without knowing eight shapes.
