# ADR 0099 — the processor register is held against the services actually wired up, and every page in the documentation set is generated or checked

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-HARD-09
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/04 §8's processor register and
  the bus-factor half of docs/12. It sits beside ADR 0034 (the erasure half of the same privacy surface)
  and takes ADR 0003's obligation to the documentation set.
- **Revisit when:** a data processing agreement is signed (`Y1-processor-agreements`), or the data
  residency question is answered (`Y5-residency`).

## Decision

Four artefacts, and the rule is the same for all four: it is derived from a machine-readable source, or
it is held to one by a check that has been seen to fail.

1. **`PROCESSOR_REGISTER` is held against the config schema in both directions.** A provider-mode key in
   `packages/config/src/env.ts` with no register row fails `pnpm processors`; a row naming a key the
   schema does not declare fails too.

2. **The public privacy policy's processor section is GENERATED from those rows** by
   `packages/core/src/privacy/processor-policy.ts`, and no processor name may appear in the generator's
   own source. There is no list of processors in prose anywhere in this repository.

3. **The ADR index is generated** (`docs/adr/INDEX.md`, from each record's front matter) and the
   hand-written commentary in `README.md` is held to the records on disk in both directions.

4. **The secret inventory page is generated** from `build/secret-inventory.json`, and the inventory is
   now held against the config schema as well as against the names the code reads — which was the half
   nothing covered.

And `pnpm docs-set` follows every relative link and anchor in `docs/`.

## Why a register that nothing compares to the build is worse than no register

docs/04 §8 asks for a processor register and says what kind: *"This register drives the privacy policy
and the deletion logic — it is a working artefact, not a formality."* That sentence is the whole
specification, and the difference between the two things it names is entirely whether something fails
when they disagree.

A register written once is right once. The eleventh provider key is added, nothing fails, and the privacy
policy names eight services while the build talks to nine — so the document that exists to tell a data
subject who has their phone number is wrong about exactly the service that was added most recently. That
is the same defect `pnpm jobs` removes for crons and `pnpm alerts` removes for alerts, one more floor up,
and it is worse here because the audience is outside the business.

**The detection has to be structural, and the structure chosen matters.** `pnpm processors` derives the
provider set from the declaration's TYPE — every external service in `env.ts` is a field declared with
the `providerMode` enum — and not from the key's NAME. A name-suffix scan for `*_PROVIDER` was the
obvious design and it would have missed `MEDIA_STORAGE`, which is in the set and holds nineteen staff
portraits at full resolution. Deriving from the type means a provider called anything at all is caught.

The register lives in `packages/shared` and `packages/db/src/processor-register.ts` re-exports it, which
is the path the manifest names. `crawlers.ts`'s reason and `alerts/registry.ts`'s: `db` may reach
`shared` and must never import `core` (ADR 0001), and the policy generator is in `core`. The re-export is
not a copy — two lists plus a set-equality test is the shape ADR 0062 rejected for the crawler names and
ADR 0043 rejected for SQLSTATE classes, because such a test passes on the day it is written, is the first
thing deleted when somebody adds a provider in a hurry, and says nothing about a third copy.

**There is deliberately no `processor` table.** The register changes only when code changes — adding a
processor means a provider key, an adapter and an egress allowance — so a table would be a second place
to change, with a migration, and the copy that drifted would be the one the privacy policy read.

## Why the policy is generated, and what the generated version says that a written one could not

A hand-written privacy policy beside a register is two statements of who has the data, and the one that
drifts is the one a data subject reads. So the policy's processor section is a function of the rows: add
a row and it grows a paragraph, remove one and the paragraph goes, change a data class and the sentence
changes.

Proving that is a claim about the FUNCTION and not about today's output. Comparing the policy to the
register as both stand would pass equally well for a hand-written policy that happens to agree, so
`processorPolicySection` takes the register as an argument and most of its tests generate from a fixture
set and assert the output follows the input. `pnpm processors` adds the rule the tests cannot: no vendor
name may appear in the generator's own source, because the commit that writes one is the commit where the
generated sentence read awkwardly and somebody improved it.

Two sentences in the generated policy could not be written by hand at all, and they are the point:

- **"None of these services receives health information you have given us."** Emitted only while no row
  declares the `clinical` class. A hand-written version of that sentence survives the commit that makes
  it untrue, which is the single worst failure available to a privacy policy.
- **"We do not yet have a written data processing agreement with this service."** Said beside each
  service rather than once at the top, because it is a fact about each relationship. `agreementOnFile` is
  `false` on every row and the register refuses `true` at module load: no agreement has been seen by this
  build, and a claimed legal instrument is the plausible-looking TRN of brief rule 15 applied to a
  contract.

The transfer basis is an enum including `not_yet_established`, which is a value rather than a NULL for
the same reason. A NULL reads as "nobody filled this in"; the value reads as "this is unresolved", it is
the same answer for every row, and the policy opens by saying so rather than listing eight services under
a heading that implies a mechanism exists.

## Why the index is generated and the commentary is not

`docs/adr/README.md` is the most useful thing in that directory: one long paragraph per decision, written
by whoever made it. It is also the wrong artefact to answer "which ADRs exist", because that is a fact
about the filesystem and a hand-maintained copy of a filesystem drifts.

So the two jobs are separated. `INDEX.md` is generated from front matter — number, title, status, date,
unit, covers — so no row in it can be wrong without the record being wrong. The commentary keeps the
arguments, and `--check` holds its row set equal to the records on disk in both directions. The set is
stated once, by the filesystem, and both files derive from it, which is ADR 0062's structural-equality
shape rather than a test between two hand-written lists.

Generating the commentary instead was the alternative and it is wrong twice: it would need a one-line
summary field in all 74 records, rewritten by somebody who did not make the decisions, and a generated
paragraph is exactly the part of an ADR that cannot be generated, because the thing worth recording is
the argument.

The emit/check pair is one file for each generated page, following `pnpm tokens`. A separate checker
would reimplement the rendering, and the first format change would make it fail on correct output.

## Why the link checker earns its place, and the defect it found

A broken link in a documentation set is not untidy. It is the sentence *"the procedure is in the
runbook"* pointing at nothing, discovered by whoever is reading it because something has already gone
wrong. And it is the failure mode of a documentation set specifically: the links are the part that goes
stale without anybody touching the sentence around them. A renamed file, a reworded heading — the
paragraph still reads correctly.

Nothing in this build noticed, because nothing followed a link. `pnpm adr` checks that records exist, not
that anything can reach them. The first run of `pnpm docs-set` found ADR 0072 linking
`0014-customers-have-no-accounts-identity-is-the-phone-number.md`, a file that has never existed under
that name; the record is `0014-phone-first-customer-identity.md`. It had been there since 0072 was
written.

The checker also refuses a generated page that nothing links to, which is not fussiness: a page kept
perfectly current that nobody can reach from the set is not in the set, and the generator keeping it
fresh makes it worse by making it look maintained.

External links are deliberately not followed. Resolving them is network I/O in a gate, and a gate that
fails because a vendor's marketing site is down is a gate people learn to ignore.

## Why the secret inventory needed a second check

`check-secret-rotation.mjs` (H-HARD-03) holds `build/secret-inventory.json` against secret-shaped
environment names **the code reads** — it scans source for `process.env` references. It therefore cannot
see a key reached only through `loadConfig()`, because there is no `process.env.FOO` for it to find. A
credential declared in `env.ts` and consumed through the validated config object was invisible to every
gate in this build.

`pnpm processors` closes that: every key the schema declares that is secret-shaped by name, or required
by shape (neither `.default(` nor `.optional()`, which is acceptance line 4's own words), must be
classified in the inventory or listed as explicitly not a secret with a reason. Both halves are derived
from the file rather than listed, because a list would be the reservation list ADR 0043 rejected.

Two corrections the gate's own first run produced, both worth recording because they were the gate being
wrong rather than the tree:

- **Provider-mode switches were in the set and should not have been.** `SMS_PROVIDER=real` carries no
  credential; demanding an owner and a rotation interval for it is demanding a procedure for rotating the
  word "fake". Six entries would have been written to satisfy a rule, which is how an inventory becomes
  something nobody reads.
- **An inventory entry's variable need not be in `env.ts`.** `PAYLOAD_SECRET` is in the inventory with a
  rotation procedure and is not in the config schema, because the CMS owns its own bootstrap (ADR 0019)
  and reads it directly. The rule's claim is that an entry describes a variable something reads, and that
  one does. Refusing it would have been a documentation check deciding Payload's configuration.

## Consequences

- **Adding an external provider is now four things in one commit:** the `env.ts` key, a
  `PROCESSOR_REGISTER` row with purpose, data classes, transfer basis and retention, an inventory entry
  or an explicit not-a-secret classification, and — because the policy is generated — a paragraph in the
  public privacy policy that appears whether anybody remembered it or not. That last one is the point.
- **A renamed ADR or a reworded runbook heading now fails the build** if anything linked to it. That is a
  real cost on a rename and it is the cheaper half of the trade.
- **`docs/adr/INDEX.md` and `docs/operations/secret-inventory.md` must not be edited by hand.** Both
  carry a generated-file banner and both are refused while stale.
- **The `/privacy` ROUTE is not built**, and acceptance line 2's "asserted by a route test" half is
  therefore not satisfied. The generation is built and tested; the public page is not. Adding a route
  puts it into `content.itest.ts`'s and `facts.itest.ts`'s server-driven matrices, which cannot be
  validated without a full web build and those suites — and a route shipped unvalidated is the "green
  means nothing" failure brief rule 19 is about. Recorded as a deferral in the manifest with the writer
  the page needs, rather than half-built.
- **`pnpm processors` and `pnpm docs-set` are registered `pnpm verify` steps** and are named in gate case
  29's array, so dropping either from CI fails the build. That is not ceremony: the failure mode of every
  artefact in this unit is that nothing fails when it is ignored.
