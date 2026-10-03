# ADR 0117 — the staff portal is SELF-ONLY with no permission that widens it, and the mask is the absence of the value

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** P-HR-14
- **Covers:** docs/01 decisions — none; this is the staff-facing consequence of
  [ADR 0010](0010-clinical-boundary.md) (the field-group boundary) and
  [ADR 0020](0020-regulatory-profile-drives-vocabulary-and-eligibility.md) (a therapist is a handle, and the mandatory credential set is data),
  with [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md)'s rule that a refusal is proved by
  something that FAILS

## Context

P-HR-14 puts a therapist in front of their own record: their published shifts, their leave balance and
requests, their commission derivation, their payslips, and where they are paid. Every one of those is a
fact the admin estate already has a screen for, and every one of those screens widens for a role holding
the right permission — `mayReadPayslip` and `mayReadCommissionDerivation` both return true for anybody
with `payroll:read`, because an accountant running payroll legitimately reads somebody else's figures.

So the question the unit had to answer was not "may a therapist read this" — the matrix answers that — but
**whose record `/hr/me` may be about**, and what the answer costs when it is wrong. A therapist reading a
colleague's wage is the worst disclosure this estate can make: it is a protected fact about a named person,
it is irreversible once read, and nothing in the system would record that it happened.

## Decision 1 — the subject is the session's, and no permission widens it

`assertPortalSubject` in `packages/core/src/hr/self-service.ts` compares two employee ids and refuses when
they differ. It takes the role, consults it for the message and **never for the answer** — so the owner,
who holds `permissions: 'all'`, is refused a colleague's portal exactly as a therapist is.

The obvious alternative was the shape next door: *self, or a permission*. It fails in a way nothing would
notice. A rule of that form is one grant away from a hole — a role given `payroll:read` tomorrow for a
reporting screen acquires the whole portal with it, invisibly, in a diff about reports. A rule with no
permission in its condition cannot be widened by a grant at all; the only way to widen it is to edit the
function, which is a diff somebody has to justify.

What is given up is real and is stated here rather than discovered later: there is no way for a manager to
LOOK at a therapist's portal. Diagnosing "the page is wrong for her" means reading the admin screens —
`/hr/rota`, `/hr/commission`, `/hr/payroll` — which hold the same rows under their own authority. That is
the right trade, because the alternative is a surface whose whole purpose is "your own record" having a
mode in which it is somebody else's.

`packages/core/src/hr/self-service.test.ts` asserts every role × every surface is refused a colleague AND
granted its own, so a fence that refused unconditionally fails too; gate 195b plants the role exception and
requires the suite to name the refusal.

## Decision 2 — the refusal is in the QUERY, and the proof is a colleague's row being present

Every portal reader in `packages/hr/src/staff-portal.ts` calls the fence as its first statement, before
any SQL is composed. The filter version was considered and is wrong twice over.

It answers the wrong question. A therapist handed an empty list has been told *"you have no shifts"*,
which is a statement about them; the truth is *"not yours"*. For a payslip the difference is the whole
message — a therapist told they have no payslip is worse off than one told they may not look.

And it is unprovable. A suite over a filtered reader asserts "I got no rows back", which is exactly what an
empty table returns, so the test passes on a database where the colleague has nothing. So
`packages/fixtures/src/staff-portal.itest.ts` runs every case with the colleague's rows **present** — a
shift they are rostered on, a leave request they filed, a balance on their ledger, an account on their
file — and each refusal carries two controls: the colleague reads their own row through the same function,
and the viewer reads their own surface. Gate 195g removes one fence and the suite names it.

The repositories are the second layer. `packages/db/src/repositories/staff-portal.ts` requires an employee
id on every reader and has **no "everybody" shape**: `readPayslips` and `readCommissionDerivation` beside
them take an optional filter, because a payroll run legitimately reads a whole period, and an optional
filter is one `??` away from returning the roster — a mistake whose shape is a missing argument rather than
a wrong one, which is the kind a reviewer does not see.

## Decision 3 — the portal's commission and payslip readers DELEGATE, so there is one authority over pay

`readPortalCommission` and `readPortalPayslips` apply the portal's fence and then call
`readCommissionDerivationFor` and `readPayslipFor` — P-HR-11's and P-HR-12's own guarded readers. Two
fences in series, and the portal's is the narrower one.

Reaching the repository directly would have been one call shorter and would have created a second
authority over somebody's earnings. The second one is the one nobody updates: a change to who may read a
colleague's pay would move `mayReadPayslip` and leave the portal where it was. Delegating also keeps the
`payroll.payslips_read` audit row, so a therapist opening their own payslip is recorded like every other
read of a wage (docs/04 §7).

## Decision 4 — the bank mask is the ABSENCE of the value, not a redaction of it

The acceptance line asks for the therapist's own bank detail to be *masked on display*. There are two ways
to satisfy that and only one of them is a privacy property.

A tail — `…4821` — requires the number. It would have to be decrypted on a page render, or denormalised
onto a column every raw `select` then returns, and four digits plus a staff reference is enough to confirm
a guess. More to the point, a mask over a value the renderer holds is one `substring` away from being the
value: the next person to widen the view has the number in hand.

So `PORTAL_BANK_MASK` is a constant, `PortalBankView` has **no field an account number can occupy**, and
`readPortalBankSummary` selects `label` and `created_at` and no sealed column at all — a statement that
cannot return ciphertext cannot have a caller that opens it. The therapist sees that an account is on file,
what payroll files it under and when, and the office is where a wrong one is corrected.

The cost: a therapist cannot check from the portal that the account on file is the right one. That is the
honest state of this build rather than a limitation of the design — `employee_bank_detail` is sealed under
the staff KEK and reading it writes an audit row with a declared purpose, which is the insider-threat
control docs/06 D4 asks for and not something a page render should be doing.

## Decision 5 — the leave submission is ONE function, and the scan that says so refuses a second insert

`submitLeaveRequest` in `@berelax/hr` judges the kind, the range, the probation rule, the leave year and
the balance, and writes the request row, the `reserved` movement and the audit row in one transaction. The
portal (`/hr/me`) and the on-behalf screen (`/hr/leave`) both call it.

A test that drove both routes and compared their answers would prove they AGREE TODAY, which is not the
claim: two paths that agree today are what the acceptance line exists to refuse. So
`packages/fixtures/src/leave-submission-entry-points.test.ts` asserts the structure instead — every entry
point imports the validator, and **no application file calls `writeLeaveRequest`** except the validator
itself. The second half is the load-bearing one: without it a third route could appear next week with its
own balance check.

Two consequences worth recording. The balance question is asked of `applyLeaveLedgerEvent` — the engine
whose property test proves no sequence drives a balance negative — rather than re-derived as
`balance >= days`, so `insufficient_balance` on a screen and `insufficient_balance` in that property are
one rule; a verdict the engine gives that this module has not been told how to report is THROWN rather than
reported as a balance, because inventing a reason for a refusal it does not understand is the one failure a
screen about somebody's holiday must not have. And **only annual leave reserves**: `leave_movement` is the
annual ledger, so reserving against it for unpaid or sick leave deducts days nobody earned there, in a
table that refuses DELETE (ZH001). The first draft reserved for every kind; the integration suite's balance
delta caught it, and gate 195f is what keeps it caught.

## Decision 6 — a staff notification is TRANSACTIONAL, and the route refuses anything else BY NAME

The four notices — rota published, leave decided, credential expiring, shift swap requested — are facts
about somebody's own employment, so `STAFF_NOTIFICATION_CLASS` is `transactional` and
`deliverStaffNotification` refuses a template that is not. It is not a preference about tone. A promotional
staff notice would be suppressed by the marketing kill switch and held outside TDRA's 07:00–21:00 window,
so a rota published at 22:00 would arrive at breakfast and one published while campaigns were paused would
not arrive at all — staffing failures caused by a marketing control, neither of which looks like a bug
anywhere near the notice.

The route is a fence and then the choke point: it calls `deliverMessage`, which calls `sendMessage`, and
`pnpm send-chokepoint` finds no `.send(` in it. There is no second send path and the gate is what says so
rather than this paragraph.

It refuses an undeclared KEY as well as a wrong class, because a transactional template that is not one of
the four would pass a class fence and be the wrong message from the wrong route — a booking confirmation
addressed at a therapist.

## Decision 7 — the credential-expiry notice's idempotency is a UNIQUE INDEX, and the window is part of its identity

`credential_expiry_notice_once` is `(employee_id, employee_document_id, window_days)` with an
`on conflict do nothing` insert above it, so a second pass inserts nothing, sends nothing and writes no
audit row. A pass that REMEMBERED what it had sent would be a second copy of the truth and the copy is lost
the first time a worker restarts mid-run; an index also holds against two workers and against a `psql`
session. That is 0068's reassignment-flag argument in a second subject.

`window_days` is IN the key and `expires_on` is NOT, and the asymmetry is the decision. Widening the
configured window from 60 days to 90 changes the QUESTION — documents that were not inside it now are, and
a notice about one of them is a new fact rather than a repeat — while `employee_document.expires_on` cannot
vary for one document, because 0030 makes a renewal a new row rather than an update. A key with a column in
it that cannot vary is a key that permits a duplicate the day it does.

The notice records the DECISION and the `message` row records what became of the send. That split follows
from the table being append-only (ZY841): the row is written before the send, because sending first and
recording after is a message that can leave twice and an SMS cannot be un-sent, and the send's own outcome
cannot then be written onto a row nothing may update. The message id is DERIVED from the notice's key, so
the choke point's `templateKey:messageId` idempotency covers a retry.

Nothing is sent today and the row says so: no table in this build holds a staff phone number or an email,
so `NO_STAFF_CONTACT_ON_FILE` is the shipped resolver and every notice is `skipped` with
`no_recipient_on_file` — 0081's answer for the rota notice. The delivery that is NOT wired **throws** rather
than skipping, because "a recipient exists and nothing can send to them" is a configuration fault and a
skip would hide it behind the state the build ships in.
