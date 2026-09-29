# ADR 0054 — a payslip pins every figure it prints, and the WPS file cannot name an employer nobody confirmed

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** P-HR-12
- **Covers:** docs/01 decisions — none; this is the mechanism behind the Wage Protection System file and
  the payslip that docs/04 section 7 asks for, and it is the reproducibility argument ADR 0047 makes about
  commission applied one layer up, to the document that pays it

## Decision

**A payslip stores no figure it could recompute. Every line names the version that produced it — the
commission RUN and its rule version, the timesheet APPROVAL and the working-hours version that approval
snapshotted, and the wage divisor the payroll RUN pinned — and a completed run is immutable, so a correction
is a new dated run naming the original.**

**And the WPS salary file names an employer identifier that does not exist yet.** Both identifiers default to
placeholders chosen to fail validation twice over, the layout is one member of a closed set that says
`provisional=Y8-wps` in its own first line, and there is no code anywhere in the repository that could send
the bytes.

## Why the pin, when the arithmetic is six additions

A payslip is the one document in this build somebody will dispute, and the dispute is never about the
arithmetic. `basic + allowances + overtime + commission + tips − deductions = net` is not where this goes
wrong. It goes wrong when a figure **moves after it was paid**, and every way that happens is a recomputation
at the wrong moment against rules that have since changed:

- **Commission recomputed at payslip time.** ADR 0047 built a whole migration to make a commission run
  reproducible: the version that judged a run is stored ON it, because resolving "the rule in force" answers
  with whatever is in force *now*, so a rate published in June silently restates March. A payslip that called
  the engine again would throw all of that away. So `payslip.commission_run_id` is a foreign key into a table
  nothing can delete, `commission_rule_version` is snapshotted **beside** it, and `ZY147` refuses a non-zero
  commission that names neither — and equally refuses a ZERO commission that names a run, because "a run
  produced nothing for this employee" and "the module is disabled" are the same zero and different facts.

  The version is snapshotted rather than joined for, and that is not redundancy. What a disputing employee is
  handed is a sheet of paper: the version has to be *on* the payslip, not one join away from it. `ZY147` holds
  the snapshot equal to the run's, which is the half a foreign key cannot state.

- **Hours re-derived.** Nothing in the payroll path pairs a punch or splits a minute. `payable_minutes` and
  `weighted_minute_bp` are P-HR-07's approved figures, and re-deriving them would be a second reader of
  attendance that disagrees with the approval on the one day it mattered.

- **Overtime priced at today's multipliers.** The uplift is measured against the ordinary multiplier from the
  `working_hours_rule` version **the approval snapshotted**, which is why `overtimeUpliftMinuteBp` takes it as
  an argument and there is no literal `10000` in `payroll.ts` to reach for. The divisor that turns a monthly
  wage into money is pinned on the run, so a run reproduced next year prices its overtime at the divisor that
  priced it the first time.

## The modelling decision that can double-pay somebody

`employee.basic_wage_fils` is a MONTHLY figure: it is what the contract pays for an ordinary month and it does
not vary with attendance. P-HR-05's `weighted_minute_bp` is `sum(minutes × multiplier)` over **every** minute,
ordinary ones included. So pricing it whole and adding it to the monthly basic pays the ordinary month twice.

The payslip therefore pays the monthly basic in full, the allowances in full, and **only the uplift** above
the ordinary rate:

    overtime = price( weighted_minute_bp − payable_minutes × ordinary_multiplier_bp )

which is zero for a month with no overtime, no night minutes and no public holiday worked. A payslip whose
overtime line is zero in an ordinary month is the sanity check that the subtraction is present.

The alternative reading — nothing is a monthly wage, every attended minute is paid at its bucket rate and the
monthly figure is only a budget — is defensible and is a **different payslip**: somebody who worked three days
of a month would be paid for three days. Which one is right is part of `Y9-overtime`, the row that already
records that the monthly-to-hourly question is unanswered. A comment cannot settle it; the arithmetic says
which one this build implements, and the open question says it is not confirmed.

One consequence follows and is stated rather than discovered: under the monthly-wage reading, unpaid absence
reduces pay by a **deduction**, and a deduction here is always an explicit authorised row and never something
this code derives. See `Y9-deductions`.

## Why the WPS identifiers are placeholders rather than blanks or numbers

docs/04 §7's entire statement about the Wage Protection System is *"salary file, in the format the bank
requires"*. No bank is named, no agent code, no establishment or MOL id, no record layout, no field spec.

A plausible thirteen digits would produce a file that is structurally perfect, passes every check, looks
exactly like a configured one, and pays nineteen people against somebody else's registration. This is brief
rule 15's sharpest instance in the build, and the defence is that the default **fails**:
`WPS-EMPLOYER-ID-PENDING-Y8-WPS` says what it is in words *and* is not a run of digits — `PLACEHOLDER_TRN`'s
technique, for `PLACEHOLDER_TRN`'s reason, one estate along.

A marker rather than an empty string, unlike `google.cloud_quota_page_url`, because this value is *printed
into a file*: an empty field in a fixed-shape record is the one a downstream reader pads and accepts.

**The validator enforces only what it can honestly claim.** Every rule is either arithmetic that is true of
any wage file — the header's record count and total against the rows — or a published standard with a
published algorithm: ISO 13616 structure with ISO 7064 mod-97-10 check digits, and ITU-T E.164. The
country-specific IBAN length is deliberately **not** asserted: that is the bank's specification to state, and
a correct account refused by an invented length is a therapist not paid.

## Consequences somebody has to live with

- **A run cannot be edited, including a draft.** A draft accepts exactly one UPDATE — the one that completes
  it, which is also the only statement that may write its header figures, because they are the sum of
  payslips that arrive over several transactions and `ZY150` checks them on that same statement. A draft
  whose numbers were edited in place could not be told from one whose INPUTS changed, so the remedy for a
  wrong draft is to discard it and build it again. That costs nothing, because a draft has paid nobody.

- **An employee with no wage on file gets no payslip, and is counted.** All nineteen seeded employees are in
  that state (`Y8-staff`). A run that treated an absent wage as zero would produce nineteen payslips of
  0.00 AED and every figure on the screen would reconcile — so `payroll_run.unpriced_employee_count` exists
  and the screen prints it beside the total.

- **An employee with no APPROVED timesheet is not paid either, and is named.** `payslip.timesheet_approval_id`
  is NOT NULL, so a figure cannot come from nowhere. The case this refuses that somebody will meet is an
  employee on leave for a whole month: they have a monthly wage and no attendance, and this build declines to
  pay them automatically rather than inventing the rule. It is recorded as a deferral rather than hidden.

- **A tip is a liability and cannot be stored as anything else.** `employee_tip` names the account it is owed
  against and `ZY146` refuses any account whose type is not `liability` — refusing an expense or asset account
  too, because a revenue-only check would pass both. "A tip never lands in a revenue account" is therefore a
  property of the schema rather than a habit of a function, and it holds for a `psql` session and an import.

- **The payslip is bilingual and is one document per person.** Not because a wage is a supply — it is not, and
  the document says so and carries no VAT line — but because a therapist who cannot read the figures cannot
  dispute them. One payslip per PDF, because a run of nineteen in one file is nineteen people's pay that
  anybody holding the file has all of.

- **There is no submission path, and keeping it absent is a test.** Absent, not disabled, which is docs/04
  §4's rule for VAT201 applied where the consequence is larger: filing a wage file against an invented
  establishment id would be an offence rather than a bug. `packages/fixtures/src/wps-no-submission.test.ts`
  scans for a module that knows about WPS and reaches the network, for a URL naming a submission host, and
  for a bank-file SDK in any manifest — and gate block 132 plants a fixture to prove the scan fires.

- **Three questions were opened or widened rather than answered.** `Y8-wps` is new and is the registration
  details and the layout. `Y9-deductions` is new and is which deductions are lawful and what cap applies.
  `Y9-tips` already existed and is extended with what payroll does with a tip — the build did not open a
  second row for a question somebody had already written down.
