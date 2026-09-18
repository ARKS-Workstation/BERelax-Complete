# ADR 0017 — an internal double-entry journal, and no capability to file tax

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H01
- **Covers:** docs/01 decision 13

## Decision

The system keeps an **append-only double-entry journal** as its operational source of truth: every
sale, refund, payout, recurring cost and adjustment lands as balanced entries. Corrections are made by
**dated reversal**, never by editing history. Periods **lock** once closed.

Statutory filing integrates to **Zoho Books**. The codebase has **no capability to file a return** —
not a disabled feature, not a flag set to false. Absent.

## Why append-only and reversal-only

An accounting record that can be edited is not evidence. The FTA expects a taxable person to produce
records showing what was charged and when; a table where a row can be updated cannot show that. The
cost is that a fat-fingered entry needs a reversal and a re-entry rather than a fix, which is exactly
what a paper ledger required and for the same reason.

Period locking is what makes a VAT return meaningful. Without it, a return filed on the 28th describes
a period that can still change on the 29th.

## Why the filing capability is absent rather than disabled

The taxable person carries the liability for what is filed. A system that *can* file, held back by a
flag, is a system where a future maintainer — reasonably, helpfully — switches the flag on. The
protection has to be that the code does not exist.

What the system does instead is produce **return-ready documents**: the figures, the supporting
transaction list, and the tax invoices behind them, in a form the accountant files. That is the useful
90% without the liability.

## Consequences

- VAT arithmetic follows [ADR 0007](0007-money-and-business-day-primitives.md): gross is
  authoritative, VAT is the remainder, so net + VAT is exactly gross with no rounding drift to
  explain.
- Invoice numbering is gap-free, which a PostgreSQL `SEQUENCE` **cannot** provide — `nextval` is
  non-transactional, so a rolled-back transaction leaves precisely the gap an auditor asks about.
  A locked counter row per series is used instead (docs/03 §7).
- Daily figures are cut on `business_day`, not calendar date: trading runs 11:00–02:00, so a 01:30
  sale belongs to the previous trading day.
- Zoho Books is an integration boundary, so it is one of the fake providers in H02 and can fail on
  demand in tests.

## Rejected

**Generating and submitting returns directly.** Rejected for the liability reason above, and because
the filing formats change on the authority's schedule rather than ours.
