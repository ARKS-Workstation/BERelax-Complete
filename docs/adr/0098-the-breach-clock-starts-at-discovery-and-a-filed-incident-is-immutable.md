# ADR 0098 — the breach clock starts at the discovery, a filed incident is immutable, and the threshold is decided nowhere

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-HARD-07
- **Covers:** docs/01 decisions — none; this is the incident-register half of docs/04 §9 and the
  breach-notification half of docs/04 §8, built on the compliance calendar ADR 0052's migration created
  and beside ADR 0034, which is the erasure half of the same privacy surface.
- **Revisit when:** `Y1-breach-clock` is answered (the period and the authority), or
  `Y1-breach-threshold` is answered (whether and when a breach is notifiable).

## Decision

Four things.

1. **The clock starts at `incident.discovered_at`, which is a column a filer supplies, and never at
   `filed_at`.** The two are separate, `incident_filed_after_discovery` orders them, and every deadline
   derives from the first.

2. **A filed incident is immutable (`ZY521`), and `incident_addendum` is the only way to add to it
   (`ZY522`).** `incident_notification` is append-only too (`ZY523`), and `ZY525` refuses a notification
   dated before the discovery it answers.

3. **Filing a `personal_data_breach` must leave its transaction with both notification duties dated, and
   the database requires it** — `ZY524`, a deferred constraint trigger. The duties are
   `obligation_instance` rows in the calendar 0052 already built, not a second calendar.

4. **Whether a breach is notifiable at all is decided nowhere in this build.** Both duties are always
   generated and dated; closing one is an act with a recorded reason.

## Why the clock cannot start at the filing

A breach is noticed on a Friday evening and written down on Monday morning. That is not a failure of
process; it is what happens, and the register has to be able to record it.

If the deadline came from the filing, the statutory clock would restart every time somebody got round to
the paperwork — and the worse the delay, the more time the business would appear to have. The incentive
runs exactly the wrong way, and nothing would look wrong: the row would be complete, the calendar entry
would exist, and the deadline on it would simply be later than the law allows.

So `discovered_at` is supplied and `filed_at` is `now()`, they are different columns, and the CHECK
requires the filing to be at or after the discovery. The gap between noticing and recording becomes a
visible fact instead of an erased one, which is also the first thing a regulator asks about.

**And the deadline is dated in the civil zone, not through `resolveTradingDate`.** Everything else dated
in this build goes through the trading date, because trading runs 11:00–02:00 and 01:30 belongs to the
previous business day. A statutory period does not work that way, and `rights-policy.ts` already says so
in those words: *a statutory deadline does not move with the salon's trading hours*. Using the trading
date here would hand the business an extra day roughly one night in three, silently, in its own favour.

Both the instant and the civil date are kept. The date is what `obligation_instance.due_on` holds and
what a screen can show; the instant is what answers *was the notification inside the period* to the hour.
Keeping only the date loses up to a day of the answer — a notification at 23:00 on the due date is inside
a 72-hour window that expired that morning only if the comparison is done on dates, which is the answer a
regulator would not accept. `notificationWasTimely` therefore compares instants, and it answers `unknown`
rather than `late` for a duty with no notification yet, because "we cannot tell" and "it was late" are
different findings and the second is an accusation.

## Why the register is immutable, when almost everything about an incident is learned afterwards

The obvious design is an editable row. An incident is filed within minutes of being noticed, the estimate
of how many people were affected changes twice in the first week, and the loss figure is not known for a
month. An append-only table looks like an obstacle to the normal case.

It fails in the one situation the register exists for. Both readers ask the same question — what did you
know, and WHEN — and an edited row cannot answer it. A row saying 220 records reads identically whether
that was the figure at filing or was written in last week, and the difference is the entire question. An
insurer asking whether circumstances were notified promptly, and a regulator asking what the controller
knew at the moment the clock started, are both asking about a state the editable row has destroyed.

So the correction mechanism is a row: `incident_addendum`, with its own instant, its own actor, and
`corrects_field` naming what it corrects. `added_at` is supplied rather than defaulted to `now()` for the
same reason `discovered_at` is — an addendum dated when it was typed cannot distinguish a finding from
something that was known at filing.

`corrects_field` is required to name a field only in the sense that the shape is checked in SQL and the
name is held to a real column by the completeness test. A correction that does not say what it corrects
is not a correction: somebody reading the register later has to diff two paragraphs of prose to work out
what changed.

## Why the duties are a schema rule rather than the writer's diligence

A `personal_data_breach` row is a statutory clock that has started. If the duties were dated in a second
transaction, a failure between the two would leave a breach on file with nothing counting — and that is
not a state anybody notices, because the register looks complete and the calendar simply has no entry.
The absence of a reminder is indistinguishable from a quiet week.

`ZY524` is therefore a **deferred** constraint trigger: at COMMIT, a breach row with fewer than both
duties linked to it is refused, whatever path wrote it. Deferred and not immediate because the
`obligation_instance` rows cannot exist before the incident they reference, so an immediate check would
refuse every correct filing — which is the version that was written first and is worth recording, because
it looks right until it is run.

The consequence is that `fileIncident` is checkable rather than trusted, and a second writer added later
gets the same refusal instead of a green test suite.

## Why two things in shared schema had to move

**`obligation_class` gained `privacy`.** Two PDPL duties filed under `licence` would sit in the calendar
beside the trade licence renewal, which is where nobody would look for them — and the class is what 0052's
`obligation_blocking_effect_matches_class` reads, so a class chosen for convenience is a blocking rule
applying to the wrong family. `privacy` carries `blocking_effect = 'none'`. Blocking publishing on an
overdue breach notification is tempting and would be this build inventing a consequence: docs/04 §9 names
exactly two blocking behaviours, 0052 ties each to the class that may hold it, and a third is a migration
with an argument rather than a row. The enum value was added with every literal of it in the same commit
(the pgEnum mirror, the `services/obligation.ts` union, `OBLIGATION_CLASSES` and its pinned test), which
is the brief's rule about widening a shared type.

**`obligation_instance` gained `incident_id`, and it joined
`obligation_instance_one_per_due_date`.** Without it, two breaches discovered close enough that their
deadlines land on the same civil date collide on that constraint, the second filing's insert conflicts
with the first's instance, and the two breaches share one duty — so completing one notification marks the
other done. `NULLS NOT DISTINCT` is kept, so every cadence-generated instance behaves exactly as before
and `generateObligationInstances`'s `on conflict on constraint` clause still names a constraint that
exists.

## Why the field list is data, and checked in both directions

The acceptance line is that the schema's columns match the declared insurer and regulator field list
*exactly*, and "exactly" is not a claim prose can carry. `INCIDENT_FIELDS` in `packages/shared` is the
list, each entry naming the column, the table that holds it, which of the two readers asks for it, and
why. `packages/fixtures/src/incident.itest.ts` reads `information_schema` and holds the two equal per
table.

Both directions, because the two failures are different and both are invisible to review. A field an
insurer asks for with no column is a question somebody answers in an email at the worst possible moment.
A column nobody asks for is a field that gets left blank, then gets dropped, and takes a real one with it
when the next person decides the table is cluttered.

The exclusion list for structural columns is itself asserted to be exactly those columns. Without that,
the cheapest way to satisfy a both-directions test is to declare the awkward column structural, and
nothing would say so.

`askedBy` is recorded rather than implied because the overlap is not obvious — an insurer wants to know
whether anybody was hurt and whether a claim is coming, a data regulator wants the categories of personal
data and roughly how many people — and because it makes a future deletion arguable. "The regulator does
not ask for this" is a reason; "we do not use it" is not.

## Why the threshold is decided nowhere, and why that is the decision

Whether a given breach has to be reported is a judgement about risk to the people affected. Nothing in
this repository is in a position to make it: docs/04 §8 marks the regulation and its executive regulations
`[UNVERIFIED]` and names the notification threshold among the things to confirm.

A build that applied a threshold of its own would be deciding **not** to notify — silently, from a rule
nobody wrote down, with an absence for evidence. That is strictly worse than generating a duty somebody
closes, because a closed duty has a reason attached and a duty that was never created has nothing.

So every breach filing generates both duties and dates them, and closing one is an act with a recorded
reason, including "assessed as not notifiable". The two are separate duties on their own deadlines because
they are decided by different things: the authority is told about the breach, and the people affected are
told when it is likely to harm them. `Y1-breach-threshold` is where the procedure belongs, and it is
`H-HARD-06`'s runbook rather than a code change.

The same reasoning governs the period and the authority. The period is the `provisional` F09 setting
`pdpl.breach_notification_hours`, bounded 1–720 hours and owner-only, so it appears on the Unconfirmed
Assumptions panel instead of reading like a figure somebody looked up — and `readBreachNotificationHours`
throws rather than falling back, because a default would be an invented statutory period in the one place
nobody looks. The authority is named nowhere: `obligation.authority` is NULL on both definitions, and
`incident_notification.party` records the category `supervisory_authority` rather than a name. ADR 0034
already decided this from the other side — a response naming an invented authority is worse than no
response.

## The consequences somebody has to live with

- **A sixth incident class, or a new insurer or regulator field, is a migration plus an entry in
  `INCIDENT_FIELDS`.** The completeness test fails until both are there, naming the column. That is the
  cost and it is the point.
- **Nothing in the register can be deleted, including in a test.** `packages/fixtures/src/incident.itest.ts`
  therefore uses a per-run reference token, asserts only about rows it created, and counts no totals. A
  suite that could empty the register would be testing something else.
- **The `obligation_instance` rows a filing creates cannot be deleted while their incident survives**
  (`on delete restrict`), and the incident never goes. A mistaken filing is corrected by an addendum and a
  closed duty, not by removal.
- **There is no admin screen yet.** The register, the clock, the duties and the checks are built; the
  `(admin)/compliance/incidents` surface the manifest names is not, and no acceptance line asks for it.
  Recorded as a deferral in the manifest rather than half-built.
- **A changed period does not move a deadline already computed.** The duty's `due_on` is a stored date
  derived from the figure in force at filing, which is the same shape `working_hours_rule` takes for
  payroll: the past is asked about with the rules that judged it.
