# ADR 0021 — a service is (style × treatment), and packages are the only prepaid product

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H01
- **Covers:** docs/01 decisions 19b, 21

## The catalogue is a pair, not a therapist attribute

The menu offers Asian and Arabic treatments. The obvious modelling — and the wrong one — is to make
Asian/Arabic a property of the *therapist*, because that is how it looks on a staff rota.

Confirmed with the owner: **it is a property of the treatment.** So a service is the pair
`(style × treatment)`: 8 services, each with 4 durations, **32 price points**.

The consequence that makes this the right shape is that **price and therapist assignment stay
decoupled**. The price is known when the customer picks a service, and it does not change when the
front desk assigns a different therapist. Model it the other way and every therapist reassignment is a
repricing — including reassignments made after the customer has been quoted.

Style still maps to a **required therapist skill**, used for eligibility only: it decides who *can*
take the appointment, not what it costs.

There is no third pricing axis. Not time of day, not therapist seniority, not day of week. Adding one
multiplies the catalogue and every screen that renders it.

## Packages are the only prepaid product

**Packages only**, as `package_template` rows configured in settings from day one. No gift vouchers.
No memberships.

Each prepaid product is not a variant of the others — each is a distinct revenue-recognition pattern,
and each drags in the same four things: a deferred-revenue path, a liability account, a migration
artefact, and a VAT date-of-supply question to settle with the accountant. One of each is a
manageable amount of accounting. Three is a project.

Declining vouchers and memberships now is therefore a real simplification, not a deferral of typing.
Adding one later is a new product with its own recognition rules, which is the honest description of
the work.

## A deposit is not a prepaid product

This is the distinction that keeps the rule from collapsing. A deposit is a **part-payment against one
specific booking**: no balance, no expiry, no redemption schedule, nothing to carry forward. It
settles into that booking's revenue when the treatment happens.

Calling it prepaid would reintroduce exactly the second deferred-revenue path the decision exists to
avoid — and it would do so quietly, since a deposit looks like a small package if you squint.

## Consequences

- One `package_template` shape, configurable from launch, with validity in months as a bounded setting.
- Deferred revenue has one source. A package sold is a liability; a package redeemed moves to revenue
  on the treatment date.
- The 32 price points are seed data from docs/13 §4, and the catalogue is what both the website and
  the booking engine read — see [ADR 0019](0019-cms-embedded-in-the-app.md) on where the CMS stops.
