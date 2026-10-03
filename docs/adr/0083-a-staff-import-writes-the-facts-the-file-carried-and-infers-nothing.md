# ADR 0083 — a staff import writes the facts the file carried, infers nothing, and carries no sealed field at all

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** H-MIG-06
- **Covers:** docs/01 decisions — none new. It is the import-shaped consequence of
  [ADR 0072](0072-the-consent-floor-is-a-refusal-and-the-import-ledger-stages-a-digest.md) (the migration
  ledger is permanent, so what it stages is the decision) meeting
  [migration 0030](../../packages/db/migrations/0030_staff_availability.sql)'s refusal to invent a gender and
  [migration 0066](../../packages/db/migrations/0066_hr_leave.sql)'s leave policy, and it records the
  provisional answers to **Y8-staff** and **Y8-leave** that the import rests on.

## Decision

**Four things the staff import will not infer, and the fourth is an absence.**

1. **A gender.** A line with no gender cell is QUARANTINED by name
   (`gender_not_recorded`), never defaulted. `employee.gender` is nullable because 0030 refused to have a
   migration "invent nineteen people's genders", and gender is a hard constraint on assignment
   (B-AVAIL-05): a customer may ask for a female therapist and the booking rules enforce it, so a guessed
   value decides who may treat whom. A null one does not fail either — it quietly makes that therapist
   unassignable to every gender-specified request while looking like an ordinary row — which is why
   **`ZY374`** refuses, at COMMIT, an `imported_staff_row` naming an employee whose gender is not
   recorded. The importer declines the line; the trigger is what makes the decline unforgeable.

2. **A leave balance's unit.** `leave_movement.day_basis` is a column every opening balance must fill in,
   `trading_session_day` is the only value one may carry, and **`ZY371`** refuses `calendar_day` by name.

   **It is not a second arithmetic, and the obvious reading is wrong.** 0066 settled that the statutory
   entitlement is counted in calendar days ("a leave day is a calendar day, never a working day") and
   `hundredths` is in those units throughout this ledger; nothing here changes that. What the basis
   records is the question
   [0092](../../packages/db/migrations/0092_leave_approval.sql) already asks of a leave REQUEST from the
   other end — `ZY020` refuses a period bounded by a midnight that falls inside a trading session, because
   trading runs 11:00 to 02:00 and a calendar-aligned leave day "leaves its last two hours rostered" —
   applied to the BALANCE every such request will be spent against. This business opens on every date, so
   the two readings are the same quantity today; which is exactly why nobody would notice the question was
   never asked, and why ZY371's own message COUNTS, from `business_day`, how many dates of the covering
   leave year the business does not trade. Zero means the readings coincide and the cell is the
   confirmation nobody has given; above zero means they are different numbers and the previous
   arrangement's records do not say which was meant.

   A `calendar_day` line is quarantined WHOLE rather than imported without its balance. An employee with
   no `opening_balance` movement has a balance of zero by construction, accrual then runs forward from
   zero, and nothing is marked provisional because no row was written to mark — which is the failure
   `ZY372` exists to refuse, reached the long way round.

3. **A zero that nobody confirmed.** **`ZY372`** refuses an opening balance of zero that is not marked
   `is_provisional` with an open question named. docs/11 §7 says the accrual engine needs a real opening
   balance rather than a zero, and the arithmetic is indifferent between them: twelve months forward from
   an unconfirmed zero and from a confirmed one are the same 3,000 hundredths, so only the mark tells them
   apart. `accrual.worked-examples.test.ts` asserts exactly that indifference as its sixth example.

4. **A bank account, an Emirates ID number, a passport number, a visa number or a wage — there is no
   column and no cell for any of them.** This is the unit's main decision and it is an absence, so it is
   the one most likely to be read as a gap. `import_row.payload` is kept for ever and is invisible to
   every erasure probe (ADR 0072, Y9-import-ledger), so an IBAN in a staff workbook is an IBAN in that
   ledger **permanently** — strictly worse than the plaintext column `employee_bank_detail` was built to
   avoid, because that column does not exist and this one could not be removed afterwards. Those fields
   are entered through the HR screens, which seal them under 0102's envelope scheme.

   What the import DOES write about a credential is its **type and its expiry**, which is the half
   availability is gated on: `readEligibleTherapists` excludes a therapist whose mandatory document has
   lapsed by the trading date with `credential_expired`, and `readReassignmentCandidates` is what then
   finds their future appointments. A document number is not in that path at all, so leaving it out costs
   nothing the acceptance line asks for and removes the one thing that could not be taken back.

And one thing it deliberately does not re-state: **`employee.is_publishable` is untouched.** It is already
GENERATED from `display_name` and `photo_consent` (0030, decision 23), so an import cannot publish a
therapist whatever it writes, and a rule here would be the second statement that drifts.

## The alternatives, and the specific way each fails

**Import the bank and identity fields, sealed.** The sealing works — 0102 built it, and the import could
call it. The ledger is the problem and not the column: the workbook and `import_row.payload` would both
hold the plaintext on the way in, and the payload is the one copy no erasure reaches. Sealing the
destination while staging the source in clear is the shape of a control that measures the wrong end.

**Default the gender from a name, a title, or the style skill.** Every one of those is a guess with a
plausible accuracy and no way to tell a wrong one from a right one afterwards, on a field that decides who
may treat whom. The acceptance line names this directly, and ZY374 is what makes it checkable.

**Convert a calendar-day balance.** There is nothing to convert — the two readings are the same quantity
in a business that opens every day — so a conversion would be a no-op that looked like diligence, and the
first time a date in the leave year was not a trading day it would silently become wrong. Asking for the
confirmation is the only thing that distinguishes "checked" from "assumed".

**Accept a zero as a zero.** It is the exact shape of `rota_version.forecast_unpriced_employees`' recorded
failure one subject along — "a forecast over a rota where no wage is recorded is 0 fils and reads as a free
rota". Nineteen zero balances read as a business with no leave liability, which reaches an end-of-service
calculation and nothing that would query it.

**Ask for the leave already TAKEN as dates, and derive the balance.** Tempting, because dates are what a
previous arrangement's records hold. They are calendar dates, and reconstructing them as `leave_request`
rows is exactly what ZY020 refuses: a period bounded by midnight leaves the last two hours of the previous
session rostered. Deriving a balance from them without writing the rows would be the same arithmetic with
nothing to check it against.

**Two files, one per credential.** The owner holds one row per person, so a per-credential file means
re-keying the staff reference on every line — and a reference mistyped on one of six lines attaches a lapse
date to somebody else. The multi-valued cell is uglier and has one failure mode instead of that one.

## The consequence somebody will have to live with

**A therapist imported from this file is not bookable until somebody enters their credentials' details and
their sealed identity fields through the HR screens, and not publishable until somebody sets a display name
and records a photography consent.** Both are correct and both will look like the import having failed. The
credential EXPIRIES are imported, so availability is gated on real dates from the first minute; what is
absent is the document number, which nothing in the availability path reads.

**`employee.staff_reference` is still not unique in the database, and this importer quarantines a repeat
rather than the schema refusing one.** Making it unique would be the stronger fix and is out of this unit's
scope: 0030 left it open and three suites create employees with references of their own shape. The importer
refuses both lines of an in-file repeat by name and quarantines a reference somebody already holds, which
covers every path an import can take — and leaves the schema-level question where 0030 left it.

**The worked examples restate migration 0066's policy as a literal.** `packages/core` performs no I/O, so
they cannot read the row. `packages/fixtures/src/staff-import.itest.ts` carries the check that holds the
literal equal to the row — it reads the test file as text and asserts each field — which is the "if you must
write a fact twice, add the check that holds the two equal, in the same commit" rule applied where the
second statement was unavoidable.
