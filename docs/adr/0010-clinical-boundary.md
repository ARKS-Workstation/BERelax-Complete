# ADR 0010 — the clinical boundary, designed for relocation

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** F08

## Why this exists at all

Client intake data — contraindications, pregnancy, medication, injuries — is special-category health
data. But the reason it gets its own schema, its own role and its own encryption is narrower and more
practical than "it is sensitive":

**UAE Federal Law 2 of 2019 may prohibit storing health data outside the country, DigitalOcean has no
UAE region, and the licence classification that decides whether the rule applies is still
unconfirmed** ([OPEN-QUESTIONS](../OPEN-QUESTIONS.md) `Y5-residency`, [docs/10](../10-google-connection.md)).

So the design goal is **reversibility**. Isolating this now makes moving the clinical store to a
UAE-hosted database roughly a week of work. Not isolating it would mean migrating the most sensitive
table in the system while it is live, under legal pressure.

## Four properties, each enforced rather than documented

**1. Its own schema** (`clinical`), so it can be dumped and moved independently of everything else.

**2. Its own database role.** Volume encryption on DO Managed Postgres protects a stolen disk and
nothing else. It does not protect against the realistic case — an attacker holding a valid
application credential via an SQL injection or a leaked connection string. `berelax_app` has
`REVOKE ALL ON SCHEMA clinical`, so an application-layer compromise **cannot reach health data at
all**. Tests assert the denial for both the app role and the read-only reporting role.

**3. No foreign key crosses the boundary, in either direction.** This is the one people get wrong. A
single FK from `clinical` to `public` welds the two schemas into one database forever and makes
relocation impossible. References are UUIDs only, and an integration test queries `pg_constraint` to
prove no cross-schema FK exists — so a future migration cannot quietly add one.

**4. Envelope encryption**, so the ciphertext is useless without the key hierarchy.

## The envelope, and why AAD matters more than it looks

A fresh 256-bit data key per record, used once with AES-256-GCM, wrapped by a long-lived KEK held
outside the database, with the KEK version stored alongside.

**Every ciphertext is bound to its own row via AAD** — `table | recordId | customerId`. Without it,
someone with `UPDATE` on the table could swap one client's intake payload onto another client's row
and it would decrypt cleanly. A test asserts that decryption under a different `customerId`,
`recordId` or `table` fails — and that it still fails even when the attacker also rewrites the stored
fingerprint, because the AAD participates in the GCM tag itself.

**Rotation re-wraps without decrypting.** `rewrap` moves a few dozen bytes per record instead of
re-encrypting every intake form, so rotating the KEK is a routine background job rather than an
outage. A test asserts the payload ciphertext is byte-identical after rotation, and that the old KEK
can no longer open it.

The version-mismatch error names the problem explicitly — *"retain retired KEKs until every payload
has been re-wrapped"* — because the failure mode of a half-finished rotation is unreadable records,
and a vague error there costs hours.

## The only path across the boundary

The booking layer needs to know a contraindication **exists** so it can route or warn. It must never
receive the free text.

`public.customer_contraindication_flags` is a `security_invoker = false` view exposing **booleans
only**. The application role reads it while holding no privilege on the `clinical` schema. A test
asserts the view exposes no `text` or `char` column at all, so no note or diagnosis can leak through
it even by a later careless migration.

`requires_consultation` is deliberately shaped to tell reception *to ask*, not *what to ask about*.

## Corrections supersede; they never overwrite

`treatment_note.supersedes_id` models a correction as a new row referencing the one it replaces, and
`DELETE` is revoked **even for the clinical role**. A clinical record that can be rewritten is
worthless as evidence — which matters for an insurance claim or a safeguarding allegation in either
direction ([docs/06 §E](../06-blind-spots-and-risks.md)).

## Two gate gaps closed while doing this

Both found by asking "what is this gate actually looking at?" rather than by a failure:

- **`db:drift` only scanned `public`**, so the entire `clinical` schema — the most sensitive one — was
  un-drift-checked. It now scans both, with mirrors qualified by schema, and the table-matching regex
  handles `someSchema.table(...)` as well as `pgTable(...)`.
- **`db:conventions` only scanned `packages/db/src/schema`**, exempting the clinical mirrors from the
  timestamptz and integer-money rules. It now scans both mirror directories.

The clinical mirrors live in `@berelax/clinical` rather than `@berelax/db`, so the package that owns
the boundary owns its own shape, and nothing outside it imports them.
