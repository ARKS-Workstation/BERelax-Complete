# ADR 0057 — a gratuity liability is cumulative, and a month's accrual is its difference

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** P-HR-13
- **Covers:** docs/01 decisions — none; this is the mechanism behind the one line docs/04 section 7 gives on
  end-of-service gratuity, and it is ADR 0017's append-only journal applied to a figure nobody reads for
  years

## Decision

**The primitive is the WHOLE liability owed at a date, computed exactly with one rounding at the end. A
month's accrual is the DIFFERENCE between that figure and what the books already hold, and it is posted as
one balanced two-line entry. Not the other way round.**

**And every figure the computation uses is a versioned provisional row of `gratuity_rule`, flagged against
`Y9-gratuity`. There is no rate, band, divisor or cap written in code, and no cap column at all.**

## Why the cumulative figure is the primitive

The obvious implementation computes a month directly — a twelfth of a year's entitlement, added to a running
total — and it is wrong here in a way that only appears after a year.

A twelfth of 21 days' wage is not an integer number of fils. So every month is rounded, and twelve rounded
months do not sum to the year. The residue is small, it is permanent because the journal has no edit
(ADR 0017), and it grows for as long as somebody is employed. Nothing ever reports it: the liability looks
plausible at every point, and the first person to add it up is settling a leaver.

Making the cumulative figure the primitive removes the failure rather than bounding it. `gratuityLiabilityAt`
sums an integer numerator over a common denominator — the lowest common multiple of the four possible month
lengths, so a part month pro-rated on its own days stays exact — and divides once, in `BigInt`, rounding up.
The month's movement is `cum(n) − cum(n−1)`, so a run of months telescopes to the cumulative figure at the end
of the run **for every rounding direction**. That is why it is a property test and not a worked example.

Three consequences, and each one is why this is worth an ADR rather than a comment:

- **Idempotence is arithmetic.** A month already accrued has a movement of zero because the two figures
  agree, not because a flag says so. The partial unique index
  `gratuity_accrual_one_original_per_month` refuses the row as well, so the guarantee holds through a
  concurrent pass; but the pass does not need to remember anything, and 0031 records what a job's own state
  costs the first time it is lost.

- **A wage change is a change in estimate, not a restatement.** It lands as one catch-up movement in the
  month it is known. This is the constraint P-HR-12 handed over, satisfied by not needing it: a completed
  payroll run is immutable (ZY141) and its header figures may only be written by the statement that completes
  it (ZY142), so a design that had to revisit an earlier month would be unpostable.

- **Rounding UP is prudence, not taste.** Of the two available errors only one is recoverable: an
  over-accrual is visible on the balance sheet and answered by a dated reversal, and an under-accrual is money
  somebody is owed that no figure anywhere shows. The cost is at most one fil, once, on the cumulative total —
  not once per month, because the movements are differences of ceiled cumulatives.

**Rejected: a stored running balance on the employee.** It is a second statement of a sum the accrual rows
already make, and settling a leaver would then have two answers to compare. The liability is a VIEW —
`employee_gratuity_liability` — which excludes any accrual a correction supersedes, so the live figure is a
sum over rows nobody has edited. That is what makes the reconciliation in the acceptance list provable at all,
and it is `leave_balance`'s shape one subject along.

## Why there is no cap, and no column for one

docs/04 section 7's entire statement on this subject is: *"**End-of-service gratuity** as an accruing
balance-sheet liability, accrued monthly."* No rate, no band, no cap, no wage basis, no authority — and the
section's own note on the labour figures says why and says where they go instead: they are versioned rows
flagged provisional, *"so answering either question publishes a new version rather than editing a document."*

So `gratuity_rule` holds them, and brief rule 15 holds absolutely: a plausible rate is worse than a blank one
because it is indistinguishable from a configured one, and what this one decides is what somebody leaves with.

The cap is the sharper case and is left **out** rather than nulled. The SHAPE is unknown as well as the
number: a cap could be a ceiling on the days earned, on the months of service that earn, or on the total as a
multiple of the wage, and choosing which to store is inventing a cap just as surely as choosing a figure. A
nullable `cap_fils` would also be a place for somebody to put a number the engine would then apply to the
wrong quantity. Uncapped is the prudent direction for a liability, `Y9-gratuity` says so in words, and
answering it needs a unit rather than a value — which is 0066's reasoning about carry-over expiry, where a
policy the code would silently mis-apply was left unexpressible for the same reason.

**Three further readings are this build's, all in the prudent direction, all on `Y9-gratuity`:** the wage is
the wage as at the accrual month applied to the whole of service (the "final wage" reading, larger whenever
wages rise); a month straddling a band boundary earns at the higher rate for the whole month; and probation
months earn nothing but still count as service, so the band boundary arrives on the employment anniversary.
None is a flag on the rule row, because a flag the engine would have to honour two ways is the thing 0066
refuses.

## Why the daily-wage divisor is its own column

`labour_cost_rule.monthly_wage_days_divisor` (0081) already says how many calendar days a monthly wage covers,
and version 1 of both rows carries the same figure. Reusing it was the first design and it is wrong.

That divisor is a FORECAST's. P-HR-07's NOTE declines to pay anybody with it in so many words, and it is
flagged against `Y9-overtime`. This one is the basis of a statutory entitlement and is flagged against
`Y9-gratuity`. One column serving both would clear the Unconfirmed Assumptions panel for an answer nobody
gave — and 0081 itself draws exactly this distinction one step along, between its own `paid_minutes_per_day`
and `working_hours_rule.ordinary_minutes_per_day`: *"Two figures that happen to be equal."*

The underlying question — what a day of a monthly salary is worth — is already recorded on `Y9-deductions`
and `Y9-overtime`, so `Y9-gratuity` **cross-references** them rather than opening a third row for it.

## The accounts are resolved through settings, and only their TYPES are checked

`chart_of_accounts` is a row rather than a constant because it is provisional against `Y8-coa` (0018 says so
on the table). A code written into a posting rule would therefore be this build deciding an accountant's
classification, in a journal where changing it later means restating history. So the expense, liability and
settlement-payable accounts are three compliance-locked settings, and
`packages/fixtures/src/hr-gratuity.test.ts` scans the engine and the job for a four-digit literal.

`ZY173` checks that the entry debits an account of type `expense` and credits one of type `liability` for
exactly the accrued amount — the types, deliberately not the codes, which is the shape 0104 gave a tip with
`ZY146`. An accrual credited to a revenue account balances perfectly and turns a debt into income; that is the
case the type check exists for and it has its own probe.

## Accruing into a month somebody has already filed

ADR 0026: a closed period cannot be reopened without a migration. So a month whose accounting period has since
been locked is still accrued — the liability was earned — and the entry is dated in the next OPEN period and
NAMES the locked one, in the row and in the narrative. `ZY174` holds the pair to exactly two shapes: an open
month is dated at its own month end, and a locked month is dated after it and outside every lock. The pass
walks forward rather than stepping once, because consecutive locked periods are ordinary — a quarter is three
of them — and a single step would land inside the next lock.

One consequence to live with, found by the pass's own suite: `gratuity_accrual.locked_period_id` references
`period_lock`, so **once an accrual names a lock that lock can never be deleted**, and the accrual cannot be
deleted either (ZY171). That is ADR 0026 made structural rather than a limitation, and it is stated here
because it surprises anybody trying to tidy up a test database.

## The gap this takes over from P-HR-07

`Y9-attendance` has carried one since 0086: attendance for a day in a CLOSED accounting period with NO punch
at all cannot be entered, because `attendance_correction.corrects_event_id` is NOT NULL — a correction amends
a record and cannot invent one. The question recorded it as *"a ledger-side adjustment rather than a punch"*
and pointed it at P-HR-12. P-HR-12 re-pointed it here: its `payroll_deduction` only ever REDUCES pay, and
unrecorded work needs an UPWARD adjustment, which nothing in the payroll schema expresses.

`closed_period_labour_adjustment` is that adjustment: wages expense against wages payable, dated in the open
period and naming the locked one (`ZY177`). Two decisions in it are the same ones this ADR makes elsewhere:

- **The amount is stated by whoever authorises it and never derived.** Deriving it means deciding what a day
  of a monthly salary is worth, which `Y9-deductions` records as unanswered, and a derived figure would be
  indistinguishable on the ledger from an authorised one — which is `Y9-deductions`' own argument against a
  derived deduction. So the row carries an authoriser distinct from the recorder and a reason in their own
  words, with **no `kind` vocabulary**, exactly as `payroll_deduction` does.
- **It credits a payable and never reaches into a payroll run.** A completed run is immutable, so the next run
  discharges the payable instead and no completed run is ever rewritten.

## What this costs

- **Two figures are stored where one would do.** `cumulative_fils` sits beside `accrued_fils` on every row. It
  is a derived value and it is stored anyway, because the alternative is a re-derivation by an engine that may
  since have changed — and the whole point is that the movement IS a difference, so the row has to show both
  sides of it.
- **An over-accrual is not posted and needs a human.** When a wage is corrected downwards the pass names the
  employee and stops accruing them, rather than posting a negative movement. Direction lives in the side of a
  journal line and never in the sign, so the answer is a dated reversal plus a replacement — and which of the
  two figures was wrong is not something the pass can decide.
- **The engine refuses a provisional employment record.** Service length multiplies the liability rather than
  adding to it, and the nineteen seeded employees carry `employed_from = 1970-01-01`, an epoch placeholder
  0050's seeder chose to be visibly implausible. Accruing against one would owe fifty-six years of gratuity.
  So the pass excludes them and NAMES them, separately from being unpriced, because "put the wage in" and
  "confirm the HR file" are different things to go and do. A forecast that is wrong by decades is obviously
  wrong; a balance-sheet liability that is wrong by decades sits there looking like a number.
