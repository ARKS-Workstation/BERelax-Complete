# ADR 0014 — phone-first customer identity, and no customer accounts

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H01
- **Covers:** docs/01 decision 6

## Decision

**Customers have no accounts.** Identity is a phone number, verified by SMS OTP when verification is
needed. Booking is guest booking. A stable `customer_id` exists in the database regardless, keyed on
the normalised phone number, so history, packages, contraindications and marketing consent all attach
to a person rather than to a session.

## Why

The business currently takes bookings by WhatsApp and a paper diary. The system it is replacing has
zero friction and no password. A booking flow that opens with "create an account" competes with
sending a WhatsApp message, and loses.

Nothing an account would provide is actually blocked by not having one:

| Wanted | Without accounts |
|---|---|
| See my past bookings | OTP on the phone number, then show them |
| Use my package balance | Balance is on the customer record; the front desk reads it |
| Don't re-type my details | The phone number is the key; the rest is prefilled |
| Marketing consent | A consent record on the customer, not a profile setting |

## Consequences

- **Phone-number normalisation is load-bearing.** `050 510 8633`, `0505108633` and `+971505108633`
  must resolve to one customer or the history splits. Normalisation to E.164 happens at the boundary,
  and the stored form is canonical.
- **OTP is a rate-limited, auditable path**, not a convenience. It gates access to someone's own
  clinical flags and booking history.
- A number that changes hands is a real scenario. Merging and splitting customer records is an
  admin-only, audited operation rather than something that can never happen.
- Because there is no password, there is no password reset, no credential stuffing surface, and no
  customer-side breach of hashes. The staff side is the opposite: mandatory TOTP, see
  [ADR 0009](0009-authorisation-matrix-and-mandatory-totp.md).

## Rejected

**Optional accounts.** They are not free: every screen then has two states, and the half of customers
who create one expect it to do something the guest flow does not. The cost is paid in perpetuity for
a feature nobody asked for.
