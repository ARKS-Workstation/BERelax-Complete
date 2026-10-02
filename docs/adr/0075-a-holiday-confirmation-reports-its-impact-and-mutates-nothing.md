# ADR 0075 — a holiday confirmation REPORTS its impact and mutates nothing, and a predicted date says so in the figure

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** P-HR-10
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/01 decision 8's trading
  calendar as it meets `Y9-holiday-calendar` and `Y9-overtime` in docs/OPEN-QUESTIONS.md, and it stands
  on ADR 0008 (append-only tables), ADR 0043 (a refusal is identified by all five SQLSTATE characters),
  ADR 0056 (a rule the application can skip is not a rule) and ADR 0073 (a projection is marked so a
  screen cannot render it as a measurement)

## The problem this record is about

UAE public holidays are lunar and announced at short notice (docs/04 §6, docs/06 B5). So a holiday on
file is one of two completely different claims — **a date somebody announced** and **a date somebody
predicted** — and almost everything in this build keys on it: the rota, the public-holiday pay bucket,
`dim_date`'s flags and three reports.

Two things follow, and the obvious answer to each is wrong.

**First**, a prediction that turns out to be wrong has to be CORRECTED, and the correction moves a date
that appointments, shifts and approved leave are already attached to. The obvious implementation moves
them: the holiday shifted by a day, so shift the rota with it. That is the worst available behaviour,
because the people whose appointments moved did not ask and nobody can afterwards say what the rota said
when it was published.

**Second**, a figure computed over a predicted date looks exactly like a figure computed over an
announced one. `reporting.calendar_observance` (migration 0110) already recorded the shape of that
hazard in its own comment: *"a plausible lunar date is indistinguishable from a confirmed one"* — in the
one place every report keys on.

## Decision

**Four things.**

1. **A confirmation reports and mutates nothing.** `confirmHolidayObservance` writes exactly two rows —
   the observance's new dates and state, and the `holiday_confirmation` that names the announcement — and
   touches `appointment`, `shift`, `shift_assignment` and `leave_request` not at all. The impact report
   is what the caller gets instead: the appointments, shift assignments and approved leave days on the
   dates the holiday LEFT and the dates it ARRIVED on, each marked with which side it is on. Acting on
   them is a separate decision with its own actor.

   The rejected alternative is a confirmation that reschedules. It fails for the reason above and for one
   more that is structural: a reschedule has to choose a new slot, and choosing one needs the availability
   engine, a customer notification and somebody's authority. A calendar edit that did all that quietly is
   not a calendar edit.

2. **The report is DERIVED and never stored.** There is no `holiday_impact_report` table.
   `holiday_confirmation` carries `previous_starts_on` and `previous_ends_on` as well as the confirmed
   dates, which is the report's whole input on the calendar side — so it is reproducible from the row
   rather than remembered beside it.

   A stored report is a second statement of a derived figure, and the first thing that makes it wrong is
   an appointment moved AFTER the confirmation: the stored copy then names a booking that is no longer on
   that date, while looking exactly as authoritative as it did on the day. ADR 0064's reasoning about
   statements and ADR 0073's about the forecast reach one subject further here.

   The report is therefore deterministic by construction: `holidayImpactBytes` is a canonical
   serialisation, the report holds **no instant at all**, and the committed golden file pins it. A
   `generatedAt` field would make two runs differ by construction, and freezing the clock to hide that
   would be a test about the clock. The instant a confirmation happened lives on
   `holiday_confirmation.recorded_at`, where it belongs.

3. **A confirmation state is a column, and a predicted figure says so IN the figure.**
   `holiday_observance.confirmation_state` is `provisional` or `confirmed` — not a boolean, because the
   two states are two positive claims about where a date came from rather than the presence and absence
   of a flag, and `holiday_observance_provisional_names_a_question` holds a provisional date to the
   OPEN-QUESTIONS id that owns it.

   Above that, **no count in this unit is a bare number.** Every one is a `HolidayFigure` whose basis is
   `confirmed` or `predicted`; a figure over several dates is as weak as its weakest date; and the only
   function that yields a printable count, `publishHolidayFigure`, returns the qualifier **with** it. A
   caveat printed beside a figure is separated from it by the first person who copies the number, which is
   ADR 0073's rule about projections applied to a calendar.

   Its successor rule at the database is `ZY291`: **a lunar-dated observance may be `confirmed` only
   where a `holiday_confirmation` row names the announcement.** That is what 0110's
   `calendar_observance_lunar_is_provisional` becomes once something in the build can record an
   announcement — 0110 said so in its own comment, and the claim survives intact: a lunar date presented
   as settled with nothing on file behind it is still unstorable.

4. **An observance does not close the premises, and an hours override may not strand a booking.** A row
   in `holiday_observance` is a PAY and ROTA fact. It changes no trading hour and no availability, which
   makes "a provisional holiday changes no availability" true by construction rather than by a flag
   somebody remembered to check. Closing for a holiday is a `premises_closure` row, written by somebody
   who decided to close — and `Y9-overtime` records that a public holiday the salon trades through has no
   closure row at all, which is why a holiday calendar derived from closures would be false on exactly the
   days the flag exists for.

   Reduced Ramadan hours are a dated `premises_hours_override` (migration 0011), unchanged. What is added
   is `ZY294`: an override that would leave an already-booked appointment outside trading hours is
   refused, naming every appointment. Reduced hours that strand a booking do not cancel it — they produce
   a customer standing outside a locked door.

## Consequences somebody will have to live with

**A confirmed observance can never be removed.** `holiday_confirmation` is append-only (`ZY292`) and it
pins its observance `on delete restrict`, so once an announcement is recorded neither row can go, by any
role including the owner. A date entered in error is superseded by a new observance, never deleted. The
first cost of this was immediate and is worth recording: `packages/fixtures/src/hr-holiday-calendar.itest.ts`
cannot clean up after itself, so every case that records an announcement runs inside a rolled-back
transaction with `set constraints all immediate` to force the deferred checks — which is ADR 0061's dry
run, in a test.

**"Stranded" is stated twice.** `holiday_override_stranded_appointments(...)` in SQL and
`hoursOverrideStrandedAppointments` in `packages/core` say the same thing, because the database has to be
able to refuse the write and `packages/core` is pure. The check that holds them equal ships in the same
commit — `packages/fixtures/src/holiday-hours-agreement.itest.ts`, one probe corpus through both, with
each probe's answer computed by hand so the two agree with the RULE and not merely with each other. Two
identically wrong readings agree perfectly.

**Three constraint triggers are deferred, and each one has to be.** `ZY291` and `ZY293` fire at COMMIT so
a repository may confirm the observance and record the announcement in either order; `ZY294` is deferred
so a transaction can move the affected appointments AND narrow the hours. An immediate trigger would make
each half impossible without the other, which is a refusal with no way to comply. The cost is that a
caller who never commits never learns, and a suite that rolls back has to force them by hand.

**`reporting.calendar_observance` is still there, and `dim_date` still reads it.** 0110's deferral asked
for it to be dropped when this calendar landed. It is not dropped, and the reason is measured rather than
reluctant: thirteen files read that table, `packages/fixtures/src/cash-forecast.itest.ts` asserts
`calendar_observance_lunar_is_provisional` BY NAME, gate block 151 rests on that assertion, and two ADRs
describe it. Re-pointing `dim_date` is an integrating change across three units' committed work. Until it
happens, `dim_date.is_public_holiday` answers `false` for an operational observance — which
`hr-holiday-calendar.itest.ts` MEASURES rather than leaves to be discovered, so the day somebody does the
re-point the measurement fails and names this record.
