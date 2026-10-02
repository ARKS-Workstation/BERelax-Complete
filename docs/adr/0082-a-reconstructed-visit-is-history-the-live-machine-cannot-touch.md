# ADR 0082 — a reconstructed visit is HISTORY the live machine cannot touch, and it posts nothing

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** H-MIG-05
- **Covers:** docs/01 decisions — none new. It is the storage-shaped consequence of
  [ADR 0061](0061-an-import-is-resumable-per-row-and-provenance-is-a-reference.md) (an import is resumable
  per row and provenance is a reference) and
  [ADR 0065](0065-a-reconstructed-balance-is-validated-against-the-workbook-and-an-attested-one-is-admitted.md)
  (the workbook is the schema) meeting
  [migration 0024](../../packages/db/migrations/0024_appointment_constraints.sql)'s appointment invariants,
  and it carries forward [ADR 0069](0069-a-reconstructed-package-sale-is-the-outstanding-entitlement-held-to-its-workbook-row.md)'s
  refusal to post output tax on a supply made before these books opened, and
  [ADR 0072](0072-the-consent-floor-is-a-refusal-and-the-import-ledger-stages-a-digest.md)'s rule that the
  migration ledger stages a keyed digest rather than the number.

## Decision

**A visit imported out of the previous arrangement's records goes into `appointment` with
`migrated = true`, is judged by every invariant a live booking is judged by, and is outside the live
status machine, outside the future and outside the ledger — each of those three by a database refusal
rather than by a convention.**

Concretely, in migration 0130:

1. **One flag on the existing table, not a second table.** The imported visits have to appear in the
   customer's record and in the retention cohorts, and both are read from `appointment` (the second
   through `reporting.fact_appointment`, a view over it joined to `booking`). A `historic_appointment`
   table would mean a `union all` in every one of those readers and a shorter history than this business
   has wherever one was missed — and it would put the rows outside
   `appointment_therapist_no_overlap` and `assert_room_capacity`, which are what make "no double-booked
   therapist, no room over capacity" a checkable claim about the imported dataset rather than an
   assertion about the file.
2. **`ZY361` fixes the booking facts** — status, period, therapist, room, service and the three money
   columns. `recordAppointmentTransition` knows nothing about reconstruction, so a receptionist
   completing a visit from June is a plausible accident whose result is a status-history chain, an audit
   row and an outbox event about a treatment nobody delivered today. **`ZY362`** refuses a change to the
   flag in either direction, as a separate code because the remedy is different: the question is wrong,
   not the data.
3. **`ZY366` refuses a migrated row that ENDS in the future**, and it is the refusal that does the most
   work for the least code. Every forward-looking reader — `readCommittedAppointments`,
   `readReassignmentCandidates` — is bounded below by a trading date or an instant, so a reconstruction
   that cannot be dated forward can never be offered a slot, swept for reassignment or asked to
   transition. The alternative was `and not a.migrated` in each of those queries, which is the same claim
   restated in every reader that grows later.
4. **`ZY363` and `ZY365` make the flag unforgeable.** A migrated appointment that no `imported_appointment`
   record names cannot COMMIT, and a record naming an appointment that is not migrated cannot either. This
   is 0119's ZY258 shape: a mark that exempts a row from the ordinary rules may only be carried by a row an
   import attests to. **`ZY364`** makes the record append-only, because it is the evidence of what one line
   of one file was decided to be.
5. **The row carries no tax figure.** `vat_rate_bp = 0`, `vat_fils = 0`, and the whole gross in `net_fils`,
   by CHECK. ADR 0069 settled the principle one subject along; this is it stated on the row, so there is no
   output-tax figure for a supply outside these books for anything to add up.
6. **`booking.source` gains a fifth value, `import`.** The four live channels — online, front desk, phone,
   walk-in — are how a booking reaches this system, and a reconstructed visit reached it through none of
   them. The records do not say which one it originally came through, so any of the four would be an
   invented fact about how a real customer booked, on a row the CRM reads (brief rule 15). Same decision as
   `customer.created_via = 'import'`.

And in the importer:

7. **The P&L is untouched by construction and not by a filter.** It writes no invoice, no payment and no
   journal entry. A statement line is a directed sum over `journal_line`
   ([ADR 0064](0064-a-financial-statement-is-a-directed-sum-over-a-partition-of-the-chart.md)), so a visit
   that is not in the ledger contributes zero to every line of every statement — asserted as the CENSUS,
   which takes no account set, rather than as a statement that might happen to net to nought. The period
   before this system started is accounted for by H-MIG-07's opening balances, and counting these visits as
   revenue as well would count it twice on a trial balance that still balanced.
8. **The workbook asks for `duration_minutes` although the two instants give it**, and a row where they
   disagree is refused by name. ADR 0065's self-contradiction rule, and this is the clearest case of it in
   the build: both instants come off the same handwritten diary line, so a wrong hour or an AM/PM slip
   imports perfectly and shows up only as a therapist's utilisation being wrong on a day nobody can check
   any more. The duration is the one number the person filling the file in knows without reading the clock.
9. **The trading date is READ from `business_day`, never computed.** The table holds `[opens_at, closes_at)`
   per trading date, so the containment query IS the resolution and 01:30 lands on the previous date
   without anything correcting it afterwards. `packages/migration` may not import `@berelax/core`, so this
   is not a shortcut around `resolveTradingDate` — it is the primitive the foreign key will demand anyway,
   and `business-days.itest.ts` is what holds the table and the function equal.
10. **It creates no customer and resolves none from the payload.** The staged payload carries
    `HMAC-SHA256(json(e164), pepper)` under H-MIG-04's own key kinds — the same kinds, so the digest is the
    value `imported_contact` already holds and the two records join — and the plaintext comes from the parse
    of the file being imported, exactly as `applyContactRow`'s does. A number that resolves to no customer
    is QUARANTINED, because H-MIG-04 is the one door into `customer` and it is where the consent floor, the
    `created_via` and the contact record ZY273 holds to the facts are written.
11. **A line that cannot be resolved is quarantined with a NAMED reason, and nothing is guessed** — no
    placeholder therapist, no default room, no nearest service. A placeholder therapist would put a
    treatment somebody else performed into a named person's commission base, their utilisation and the
    figure their performance is read off.

## The alternatives, and the specific way each fails

**Mark the rows by status instead of by a flag.** A tenth `appointment_status` — `migrated`, or
`historic` — needs no column. It fails on `Record<AppointmentStatus, …>`: the transition table and the
action table are total over the status union by typecheck (0051), so a tenth label has to be given fifteen
transition answers and an `emitsRevenue` answer, and the honest answer to every one of them is "this is
not a state of the machine". It also throws away `holds_resources`, which is generated from the status —
a reconstruction that held its room would have to be declared to hold no resources, and the exclusion
constraint and the capacity trigger would both stop seeing it, which is the one thing this unit needs them
to do.

**Filter the migrated rows out of the revenue queries.** This is the version that needs no migration, and
it is the shape this repository keeps paying for: a claim restated in every reader, true in the ones
somebody remembered. The measurable difference is that the flag plus "posts nothing" is checkable by a
census with no account set in it, while the filter can only be checked by reading every revenue query and
agreeing that none was missed.

**Exclude the migrated rows from the occupancy read, so they cannot affect availability.** Tempting, and
wrong in a way that is invisible: a migrated visit HELD its therapist and its room, so filtering it out of
`readCommittedAppointments` would make the imported history double-bookable against itself, and the first
sign of it would be two therapists in one room on a date nobody can check. ZY366 gets the same result
without the hole, because a row that cannot be dated forward is a row no forward-looking read can reach.

**Admit a Four Hands or a couple's treatment.** Those are two `appointment` rows sharing a `delivery_id`,
and the previous arrangement's records do not say which rows went together. Reconstructing one means
choosing a pairing, after which `assert_delivery_is_coherent` (ZB004) is judging a grouping this code
invented. The shape is therefore a named quarantine (`shape_is_not_solo`) and the pairing is deferred.

**Import the price as zero rather than asking for it.** `appointment_price_positive` refuses it, and that
constraint is right: zero reads as a treatment given away and is indistinguishable from a figure nobody
filled in, which is ADR 0070's rule one subject along. So the figure is a required cell and a line without
one is refused by name.

## The consequence somebody will have to live with

**A quarantined line is not retried automatically.** The record is append-only, so resolving one — adding
the room, re-creating the therapist, importing the contact list first — means importing the corrected file
again, and the first record stays as evidence of what was missing. That is the same bargain ADR 0061 made
for every imported figure, and the report lists the quarantined lines by file and line number so the second
pass is over a short file.

**A visit starting at 01:30 cannot be imported at all for this business, and that is correct.** It resolves
to the previous trading date, as it must; it is then quarantined, because the shortest treatment in the
catalogue plus its room turnaround is 65 minutes and the session closes at 02:00. The two are separate
claims and the pairing suite asserts both — the resolution against `business_day`, the quarantine by name —
because collapsing them would hide the second, and the second is the one somebody will query.

**This suite cannot clean up after itself.** `imported_appointment` is append-only and holds
`appointment_id` with ON DELETE RESTRICT, so the rows a test imports stay. What makes that safe is ZY366:
every one of them is in the past, and every forward-looking reader is bounded below. The suite picks a past
trading session that no appointment stands in, which is how it runs twice.
