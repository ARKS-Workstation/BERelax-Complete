# ADR 0007 — money as integer fils, VAT as a remainder, business day as a first-class concept

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F05
- **Covers:** docs/01 decisions 7, 8, 22

## Money

Integer fils, VAT-inclusive gross authoritative, per [decision 7](../01-scope-and-decisions.md).

**A fractional literal is a compile-time error**, via a template-literal type:

```ts
type IntegerLiteral<N extends number> = `${N}` extends `${bigint}` ? N : never
```

`` `${1.5}` `` is `"1.5"`, which does not extend `` `${bigint}` ``, so `fils(1.5)` and `aed(1.5)` fail
to compile. Computed values go through `filsFrom` / `aedFrom`, which validate at runtime — the
separation is deliberate, because it means a stray `aed(price * 1.05)` cannot compile and must be
written as something a reader recognises as a calculation.

This immediately caught a legitimate case in the test suite: iterating the real catalogue prices needs
`aedFrom`, because a loop variable is not a literal. That is the type working, not obstructing.

## VAT is derived as a remainder, never rounded twice

```
net = roundHalfUp(gross * 10000 / (10000 + rateBp))
vat = gross - net                       // NOT roundHalfUp(gross * rate / (10000 + rate))
```

Rounding net and VAT independently produces inputs where `net + vat !== gross`. On an invoice that is
a one-fils discrepancy somebody has to explain to an auditor. Deriving VAT as the remainder makes
`net + vat === gross` exact **by construction**, for every input — asserted by a property test over
5,000 random amounts up to AED 1,000,000, plus the twelve real catalogue prices from
[docs/13 §4](../13-business-profile.md), plus a per-line-sum property proving that rounding each
invoice line and summing still reconciles to the document total.

`roundHalfUp` rounds away from zero rather than using `Math.round`, which rounds −2.5 to −2. That
difference only shows up on refunds and credit notes, which is exactly where it must not.

## Time, and the clock rule

`packages/core` never reads the clock. A `Clock` is injected, and `scripts/check-core-purity.mjs`
rejects `Date.now()`, argument-less `new Date()`, `Math.random()`, `process.`, `fetch` and `console.`
anywhere in the package.

The reason is reproducibility, not tidiness: availability, VAT periods, leave accrual and commission
must all be derivable from their inputs. A hidden clock read makes a test pass today and fail during
Ramadan, and makes a scheduling bug impossible to reproduce from a report.

Timezone conversion uses `Intl`, which is part of the language, deterministic, and does no I/O — so it
is permitted in core and needs no date library. `fromLocal` does a two-pass offset correction, which
is redundant for Asia/Dubai (no DST) and correct anyway, because nothing here assumes a fixed offset.

## Business day

`businessDayFor(instant, hours, zone)` resolves the **trading date** an instant belongs to. With
11:00–02:00 hours, an appointment at 01:30 on the 2nd belongs to the **1st**.

This is not a reporting convenience. Cash-up, the rota, commission, every daily total and "today" in
the owner dashboard all key off it. Getting it wrong moves revenue between days, and the error is
invisible until someone reconciles a till.

The boundary is **half-open**: exactly 02:00 belongs to the new day, one minute before it to the
previous one — matching the `tstzrange '[)'` convention the availability constraints use, so the two
layers cannot disagree.

`latestStart(day, hours, duration, turnaround)` answers the question the booking flow actually asks.
For 11:00–02:00 with a 20-minute turnaround: a 120-minute treatment must begin by **23:40**, a
45-minute one by **00:55**. A property test asserts start + duration + turnaround lands exactly on
close for every duration the catalogue sells.

## Two gates added

- `pnpm db:conventions` — every timestamp column is `timestamptz` in both the Drizzle definitions and
  the SQL migrations, and no amount column is `real`, `double precision`, `numeric` or `money`. A naive
  `timestamp` stores whatever the session timezone was, which with midnight-crossing hours moves
  bookings between business days.
- The core purity checker now blanks comments and string literals while preserving line numbers,
  after two false positives of its own: a `new Date()` inside a doc comment, and
  ``new Date(`${date}T00:00:00Z`)`` appearing argument-less once its template literal was blanked to
  whitespace. Strings are now filled with a placeholder rather than erased.

Both have known-bad fixtures per [ADR 0003](0003-every-gate-needs-a-known-bad-fixture.md).
