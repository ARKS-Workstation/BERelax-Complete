# ADR 0025 — staff PII is sealed under a THIRD key, and the employment record is a closed field map

- **Status:** accepted
- **Date:** 2026-09-19
- **Unit:** P-HR-01
- **Covers:** docs/01 decisions — none; this is the mechanism behind the storage half of docs/04 §7 and
  the field-level half of the matrix ADR 0009 chose for decision 5

## Decision

Staff bank accounts and identity-document numbers are stored as envelope-encrypted payloads under a
**third key-encrypting key**, `STAFF_PII_KEK`, using the primitives `@berelax/clinical` already owns:
AES-256-GCM under a fresh per-record data key, that key wrapped by a KEK held outside the database, the
key version stored alongside, and AAD binding each ciphertext to `table | row id | employee id`.

Alongside it, the employment record's field-level authorisation is a **closed map**
(`packages/core/src/hr/employee.ts`): every field is classified as a field group or explicitly `'open'`,
and a field that is not classified is **refused**.

Both halves are enforced by migration `0050_employee.sql` as well as by the code: `StaffSealedRowImmutable`
(SQLSTATE ZS002), `StaffRewrapDidNotRewrap` (ZS003), `StaffSealedRowRebound` (ZS004) and
`StaffSealedNumberCannotBeCleared` (ZS005).

## Why a third key rather than the clinical one

The obvious alternative is to seal staff PII under `CLINICAL_KEK` — the key already exists, the code
already exists, and one fewer secret is one fewer thing to rotate. It fails on a decision this build has
already taken.

ADR 0010 designs the clinical store to **relocate**: if the licence classification makes UAE data
localisation apply (`Y5-residency`), the clinical schema moves to a UAE-hosted database and **takes its
key with it**. An employment record does not move with it — it is joined to the roster, the rota and the
ledger. So one key means either the staff estate becomes unreadable the day the clinical store moves, or
`CLINICAL_KEK` has to exist in two deployments at once, which is the coupling ADR 0010 exists to prevent.
H-HARD-03 took the same decision for the Google token key and wrote the same argument: a client-secret
incident must not force a re-wrap of every clinical record.

The cost is real and is not hidden. There is now a third secret in `build/secret-inventory.json`, a third
section in `docs/runbooks/key-rotation.md`, and a third estate whose rotation is a procedure rather than
a command: `scripts/rotate-kek.mjs` cannot be pointed at these tables, because its sealed-table list is a
literal union of the two clinical tables, every query in `postgres-key-store.ts` names `customer_id`, and
its version registry lives in the `clinical` schema precisely so that it relocates with the store.
Widening that one command to reach all three estates would put the two most sensitive keys in this system
into one process, which H-HARD-03 declined to do for the Google key. `rewrapStaffSecret` is the per-row
primitive and it deliberately returns **only** the two columns an `UPDATE` may change, so the shape of
its return value is itself the guard.

## Why the employment record is closed when no other record is

`redactForRole` in `packages/core/src/access/permissions.ts` **keeps** a field the sensitivity map does
not mention. That is right for the records it was written for: an appointment or a customer is mostly
innocuous fields with a few sensitive exceptions, and a rule that dropped everything unmapped would strip
every ordinary column off every response in the system.

The employment record is the opposite shape. Almost every field is sensitive — a wage, a gender, a
manager's note, a consent record — so the field somebody forgets to classify is, on the balance of
probability, a wage or a number. A permissive default there means adding `iban_last4` to a query leaks it
to a receptionist and **no test fails**. So this one record is closed, the two defaults are opposite on
purpose, and the comment on `redactForRole` now says so in both directions.

The same unit closed a hole in the other direction: `canReadFieldGroup` had no equivalent of the
catalogue check `can()` has performed since F07, so a role holding `fieldGroups: 'all'` answered *true*
for a group nobody had declared. One policy, two halves, and they disagreed exactly where it mattered.

## Consequences somebody will have to live with

- **A rotation of this key is a written procedure and not a command**, until a unit writes one. The
  runbook says so at the point of use rather than in a footnote.
- **The estate has no `kek_version` registry**, so nothing refuses a retired key for a new `INSERT` the
  way `clinical.kek_version` does for the clinical estate. That check needs retirement to be a reachable
  state, and retirement is created by a rotation. Both arrive together or neither is real.
- **An `UPDATE` cannot correct a bank account.** A change of salary account is a new row and the old one
  is superseded, because the row is the evidence of where a Wage Protection System payment was actually
  sent. Anything that wants to edit one has to supersede instead, and the database enforces it.
- **What the encryption does not cover.** Every backup and WAL segment written before a rotation still
  holds data keys wrapped with the old KEK; an `UPDATE` leaves the previous row version in the heap page
  until vacuum reclaims the space *for reuse* rather than overwriting it; and a payload that has been
  decrypted once is out. The asymmetry that makes this estate different from the other two is that **an
  Emirates ID cannot be reissued because a key leaked**. So the controls that matter here are the ones
  that run before a disclosure — no plaintext column, an audited decrypt with a declared purpose, and
  field-level authorisation — and `pnpm pii` refuses a committed IBAN or Emirates ID that passes its own
  check digit, because a plausible fixture value may be somebody's.
