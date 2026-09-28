# ADR 0034 — erasure is enumerated from the catalogue, and its four boundaries are stated in the row

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** C-CRM-10
- **Covers:** docs/01 decisions — none; this is the mechanism behind the data-subject rights engine, and
  it is the erasure half of the enumeration argument ADR 0010 made for the clinical boundary and
  `packages/db/src/merge-participants.ts` made for a merge

## Decision

**An erasure never works from a list of tables. It enumerates the catalogue, requires every column it
finds to be classified by name, and refuses to run when one is not.**

`packages/db/src/privacy-coverage.ts` holds five predicates over `pg_catalog` and `pg_constraint` and no
list of tables. `packages/core/src/privacy/rights-policy.ts` holds one rule per `schema.table.column`,
keyed, with the reason for the action on the rule. A column the probes return that no rule classifies is
an `unclassified` entry, and `eraseSubject` refuses rather than erasing part of a person.

The obvious alternative is a hand-written list of everywhere a person appears, and its failure mode is
not that it is wrong when written. It is that it is right when written and silently wrong afterwards: the
next migration adds the twenty-fifth table, nothing fails, and the defect surfaces months later as a
message sent to somebody who asked to be forgotten. This repository has already answered the same
question once for merges, and `merge-participants.ts` says why in its own header — an unregistered table
must be NOTICED. An erasure needs exactly that and needs it harder, because a merge that misses a table
leaves a record nobody reads while an erasure that misses one leaves a person reachable.

Two consequences of enumerating rather than listing, both of which have to be lived with:

- **The probes read `pg_catalog`, not `information_schema`.** `information_schema` is filtered to what the
  current role holds a privilege on. 0009 revokes every privilege on the `clinical` schema from
  `berelax_app`, so an erasure run by the application — which is how it runs in production — enumerated
  zero clinical columns and then reported a complete, balanced, fully-accounted erasure over a catalogue
  missing five tables. Nothing in the integration suite could see it, because the suite connects as the
  owner. The rule this leaves behind: **a catalogue probe must return the same rows for every role**, and
  `packages/fixtures/src/rights.itest.ts` asserts that equality by running the probe under
  `berelax_app`.
- **Partitions are excluded, the parent is not.** `audit_event` is partitioned monthly (0005) so that
  retention is a DETACH. Every partition is itself a table, so a probe that admits them demands a rule per
  partition — and the coverage test would go red on the first of every month, on a branch nobody had
  touched.

## The four things a row-level erasure cannot do, stated in the row rather than implied

An erasure that quietly does less than the word suggests is worse than one that says what it did.
`rights_resolution` therefore carries each of these as a column a row cannot omit, and
`rights_resolution_class` carries, per participant, the rows that were there and the rows acted on or
retained with `rows_before = rows_acted + rows_retained` as a CHECK and a subject-facing reason required
exactly when something was retained.

1. **It does not reach a backup.** `rights_resolution.backup_position` is `not null` with no default, so
   every completed erasure carries the sentence in its own row. Backups age out on their own schedule; no
   individual row is removed from one. Provisional against `Y1-entity`.
2. **It does not reach a person's name typed into free text on a table that is not subject-scoped.** A
   cash-session count note, an appointment reassignment's resolution note: not reachable from a customer
   id by any query. Probe 5 is narrowed to subject-scoped tables *deliberately*, so that it makes a claim
   it can keep — a probe over every `notes` column in the schema would return rows an erasure cannot act
   on, and a coverage report that demands a rule for them would be satisfied by a rule that does nothing.
3. **It does not delete a statutorily retained document, and it does not rewrite an append-only one.** An
   issued tax document is kept (0026, 0072) and an audit row cannot be edited (ADR 0008). These are
   retentions with a named basis and a stated period read from `regulatory_profile`, never a literal — the
   profile COLUMN the figure came from is recorded on the class row, so a past decision stays explainable
   after the profile changes.
4. **It does not delete a clinical row.** A clinical submission is append-only, encrypted and bound to its
   row by its AAD, so the only mutation available is replacing the wrapped data key — which is
   crypto-erasure, and is the right one. Whether the content goes at all is decided by
   `regulatory_profile.erasure_overrides_retention`, which is the owner's policy and not this unit's
   preference.

## The consequence somebody will have to live with

**Adding a table that holds a customer reference, a contact detail, a credential or a subject-scoped free
text column now requires a rule in `rights-policy.ts` on the same commit**, with a maintainer's reason
and — if it retains anything — a separate sentence in the words a data subject is given. The rights suite
fails until it is there, naming the table.

That is the cost, and it is the point. The alternative is a migration that lands green and an erasure
that is incomplete from that day forward with nothing saying so.

Two smaller obligations fall out of it:

- **A retaining rule needs two reasons, not one.** `rights_resolution_class.retained_reason` is refused by
  `is_placeholder_text` (0026), and a maintainer's prose legitimately contains the markers that constraint
  rejects — one rule's reason quotes `'unknown'` as an enum label. The constraint was right and the first
  design was wrong: a sentence handed to somebody exercising a statutory right should not be a code
  comment. `ruleRegistry` refuses a missing or marker-carrying subject reason at module load.
- **Every path must be exercised as `berelax_app`, not only as the owner.** Two defects in this unit were
  invisible to a suite running as the owner: the `information_schema` filtering above, and a credential
  revocation written as an UPDATE on a table 0067 revokes UPDATE from the application role on (its
  revocation path is DELETE, which 0067 says in so many words). Both would have failed on the first real
  request with every test green.

## Not decided here

Which privacy law applies (`Y1-entity`) and whether intake notes are health data subject to localisation
(`Y5-residency`). Both are open, and this unit is built against the strictest reading of each: the
shortest deadline the build can see, intake treated as health data. **The supervisory authority is not
named anywhere** — it is a configured value, and when it is absent `decideRightsResponse` WITHHOLDS the
response rather than issuing one that tells a data subject to complain to a regulator this build invented.
A response naming an invented authority is worse than no response.
