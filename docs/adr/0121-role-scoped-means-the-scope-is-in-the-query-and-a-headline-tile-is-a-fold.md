# ADR 0121 — role-scoped means the scope is in the QUERY, and a headline tile is a FOLD

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** R-REP-08
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/03's reporting set and docs/06
  §D4's insider-threat control, and it stands on F07's role matrix,
  [ADR 0120](0120-an-unsound-figure-is-a-refusal-and-dependence-on-a-check-is-derived.md) (an unsound
  figure is a refusal), [ADR 0068](0068-a-kpi-is-an-expression-so-its-formula-cannot-drift-from-its-figure.md)
  (a measure's `reads` declaration is held equal to what its reducer touches),
  brief rule 10 and `packages/fixtures/src/synthetic.ts` (a staff reference names no person),
  [ADR 0097](0097-the-alert-registry-is-what-the-alerting-path-reads-and-an-slo-has-no-invented-target.md)
  (the alert registry is what the alerting path reads) and
  [ADR 0016](0016-messaging-compliance-is-structural.md) (messaging compliance is structural: one choke point)

## Decision 1 — the scope is a value the QUERY takes, never a filter over its result

A role-scoped dashboard has two implementations. One reads everything and draws the rows the role may
see. The other restricts inside the SQL. They look identical on the screen and they are not the same
system, because **this screen has two surfaces that return what the query returned rather than what the
view drew**: the drill-down, and the export.

So `DashboardScope` is a value — `{ kind: 'business' }` or `{ kind: 'own_employee', employeeId }` —
`kpiInputRows` and `dashboardDrillDown` both take it, and the restriction is a `where employee_id = …`
inside the aggregate. `provenance.scopedToEmployeeId` reports which it was, so a screen cannot imply
otherwise.

Gate case 199h drops the clause from ONE of the two scoped reads, which is what a partial edit looks
like: the therapist's rostered minutes stay their own and their delivered minutes become the salon's —
two figures on one screen, one of them somebody else's, with nothing saying which.

**`revenueLines` is not loaded for a scoped caller at all**, and that is ADR 0120's rule rather than
caution: an empty dataset is a figure of zero in a sum and an absent one is not, so a revenue measure
folded over a scoped input would report nought rather than refusing. `tilesFor` drops every
`businessWide` tile for a scoped role, which is what makes the absence safe.

A business-wide tile is **removed** from a scoped role rather than restricted. A per-person share of the
salon's net revenue is a figure nobody has defined, and a scoped version of it under the same label is
how a therapist comes to quote the salon's takings as their own.

## Decision 2 — a forbidden column is ABSENT from the projection, and the classification is CLOSED

`selectableColumnsFor(role)` is the column list the query selects. A column a role may not read was
never fetched, so it is not in the payload — which is the acceptance line's distinction between a column
a reader cannot see and a column that is not there.

The classification is **closed**: a column nobody classified is refused to everybody, including the
owner. That is the opposite of `redactForRole`'s default, which keeps an unmapped field, and the reason
is the one `packages/core/src/hr/employee.ts` gives for the employment record: a dashboard row is mostly
about a person, so the column somebody forgets to classify is the one most likely to be a wage.

`employee_reference` is classified `operational` and not `employee.identity_documents`. It is the
employment record's internal handle, which names no person (brief rule 10) and which the diary and every
audit row already carry; a visa number is an identity document and a handle is a label. Classifying it
as sensitive would have refused a therapist their own roster.

## Decision 3 — a headline tile is a registered MEASURE, which is what makes the M5 identity exact

The M5 gate is *every headline tile drills to source rows whose aggregate equals the tile value exactly,
asserted for all tiles, not a sample*. **A ratio cannot keep that promise**: utilisation is `a ÷ b` and
no list of rows sums to it.

So a headline tile's source is one of R-REP-03's `Measure`s — a fold over one dataset whose `reads`
declaration is already held equal to what the reducer touches (ADR 0068) — and the drill-down returns
the rows that fold ran over, each carrying its own contribution. The figure comes from the reducer in
`@berelax/core`; the aggregate comes from `sum(amount)` over the rows the SQL returned. Two independent
paths to one number, which is the only version of the claim worth asserting: a drill-down that re-used
the tile's figure would prove nothing, and one returning a total rather than rows would be a third
aggregate to reconcile.

Ratios still belong on this dashboard and arrive as ADR 0120's gated KPI tile, which carries its formula
and its refusal states and makes no drill-down claim.

Gate case 199k drops turnaround from the occupied-room-minute rows. It reads as a correction —
turnaround is not treatment — and it is the one edit that makes the identity false, because the measure
includes it: the next client cannot be in the room while it is being reset.

## Decision 4 — the export raises the registered insider-threat alert ITSELF

`customer_list_export` is this build's one insider-threat alert and its observer polls `rights_export`,
the table a **data-subject rights** export writes. A report export writes no row there and never should:
it is not a right being exercised. So the nightly observer would never see it, and the alert that exists
for exactly this act would never fire for the surface most able to perform it.

The export therefore raises the notification at the moment of export, in the same transaction as the
`audit_event` with `operation = 'export'` and the row count, keyed on the audit row's own id so one
export notifies once for ever. It is the **same** registered alert, with the tile, the subject kind and
the subject count in the detail: a second export alert would be a second answer to "an export happened"
with its own threshold and its own route, which ADR 0097 exists to prevent. The threshold is the
registry's own structural 2, which a dashboard export always exceeds.

**An export needs `report:read` even where the tile does not.** The therapist holds `rota:read`, so
their own rostered minutes are on their screen; an export is a file that leaves the building and is the
wider act. Both refusals are rows: `audit_event` with `operation = 'denied'`, because a refusal nobody
recorded is indistinguishable from a request nobody made.

## Decision 5 — the alert's CLASS is a constant, and the buckets are derived

A pushed report is a send: `deliverMessage` and therefore `sendMessage`, with no second path
(ADR 0016). `REPORT_ALERT_CLASS` is `transactional` and is **not a parameter**. A caller that could pass
the class could pass `promotional` for a staff alert — which reads as respecting quiet hours and would
hold the one message saying the figures cannot be trusted until 07:00, by which time the trading day it
concerns has closed — or `transactional` for a customer-facing one, which is the TDRA breach. The
decision belongs to the alert's audience, and the audience is in the registry.

The trading window is **derived from the day's own open instant and length**, never from a literal
11:00–02:00: `premises_hours` and its dated overrides are rows, `business_day.duration_seconds` is
generated from them, and a window spelled in a module would be wrong on exactly the days somebody set an
override for. The standard day gives the fifteen buckets the acceptance line names; a Ramadan schedule
gives its own count. Business-day order is the claim: the hours run 11 … 23, 0, 1, and any sort by the
clock puts the two busiest hours of the evening at the start of the chart.

## Consequences somebody has to live with

- **F07 gives the therapist no reporting permission at all.** This unit's own test found it. The tiles
  on a therapist's dashboard are therefore gated on `rota:read` and `booking:read` — their own roster and
  their own appointments, which they already read — rather than on `report:read`. Widening F07 would have
  handed them every other report in the build; this is the narrower grant and the matrix is unchanged.
- **Two of the tile grant's three layers had no teeth until the gate block was written.** Every shipped
  tile's permission was already held by every role its dashboard publishes it to, and the unclassified
  column branch was unreachable because the column list is derived from the classification's own keys. So
  `tilesFor` and `selectableColumnsFor` take their declarations as ARGUMENTS, which is what lets the
  refusals be exercised; cases 199c and 199d restore the dead versions.
- **No dashboard query selects a wage or a clinical note.** The two are classified so that the day a
  tile needs one the grant is a field group rather than a new rule, and so a role's projection can be
  asserted to exclude them. Until then the acceptance line's payload check is a regression guard over an
  absence rather than a demonstration of a strip.
- **`/reports` is English-only and `?dir=rtl` mirrors it.** A registry *document* must be served in both
  locales, which needs the W-SYS-01 shell; the direction is a layout axis so the accessibility matrix has
  an RTL half without an invented Arabic admin surface.
