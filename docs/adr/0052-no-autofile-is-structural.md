# ADR 0052 — the absence of a filing capability is structural, and the export is one-way

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** M-VAT-09
- **Covers:** docs/01 decisions — none; [ADR 0017](0017-accounting-journal-and-no-auto-filing.md) records
  decision 13 (*"No auto-file capability in the codebase — absent, not disabled"*, because *"a flag keeping
  auto-file off will eventually be switched on by a future maintainer"*), and this record is the mechanism
  that makes that refusable rather than stated — the same relationship 0044 has to 0017, one layer further
  out

## Decision

**The absence of a filing capability is enforced by checks that FAIL when the ability appears, not by the
absence of code. Two mechanisms, because neither can see what the other sees: a dependency-cruiser rule
(`tax-and-filing-must-not-reach-the-network`) refuses a network IMPORT anywhere in the tax estate, and
`scripts/test-no-autofile.mjs` refuses the network GLOBAL, the forbidden identifier anywhere in the
repository, a credential read in the export, and a raw query that would go round the sign-off door. The
export to Zoho Books is bytes handed to a person: one-way, needing nothing configured, allowed only for a
return two different people have signed and marked final.**

An absence cannot be tested by a passing assertion. Every other claim in this build is "the system does X",
and a test that exercises X is evidence; this claim is "the system cannot do Y", and there is nothing to
exercise. A test asserting `expect(filingCapability).toBeUndefined()` passes today, passes tomorrow, and
passes on the day somebody adds `packages/db/src/services/fta-submit.ts` — because it was never about the
tree. So the mechanism has to be an ENUMERATING SCAN over the code that could file, with a known-bad
fixture that is seen to fail (ADR 0002, ADR 0003).

Concretely, six refusals, each of which holds when the other five are absent:

1. **No network import in the tax estate.** `tax-and-filing-must-not-reach-the-network` covers
   `packages/core/src/tax/`, `vat201-working-papers.ts`, `vat-return-signoff.ts` and `zoho-export.ts`, and
   forbids seven Node builtins, eight HTTP client packages and the three outward-facing workspace packages.
   Gate cases 130m-130o break each of the three branches separately, because the rule's `to` is one
   alternation and a typo in one branch is invisible while the others fire.
2. **No network-capable global in the same estate.** `fetch` is a global, so a module graph has nothing to
   draw an edge to and rule 1 is blind to it — the same division of labour `payments-must-not-reach-the-
   network` already records immediately above it in the config. Scan 2 of the script covers `fetch(`,
   `globalThis.fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` and `sendBeacon`.
3. **No identifier a filing path would be named after, anywhere in the repository.**
   `/(auto[_-]?file|submitReturn|fta[_-]?api|efile|file[_-]?return)/i`, over 2.9 million identifiers in
   1,457 source files. Repository-wide and not estate-bounded, because a submission helper gets written
   beside the thing that needs it — a route, a job, a script — and none of those is under
   `packages/core/src/tax`.
4. **The export reads no credentials.** No `process`, no environment, no `@berelax/config` in
   `zoho-export.ts`. Structural, and behavioural too: `zoho-export.itest.ts` empties `process.env`, replaces
   `fetch`, `http.request` and `https.request` with throwing stubs, and requires the export to produce
   BYTE-IDENTICAL output. "It did not throw" would also be true of an export that silently produced a
   degraded file when it could not reach anything.
5. **The export holds no SQL.** Its only read is `vatReturnForFiling`, which is
   `vat_return_for_filing()` — `ZY055` on a READ (0095). `vat_return` is deliberately readable, because a
   preparer has to see what they are about to sign, so a `select … from vat_return` in the export would
   answer the same question with no refusal attached. The script refuses any SQL template in the module AND
   requires the door call to be present, because the first rule alone is satisfied by a module that reads
   nothing.
6. **The rule and the script cannot drift apart.** The script `require`s the dependency-cruiser config and
   requires the rule to cover every module in its own estate list, and NOT to cover
   `manual-payment.ts` — so a rule narrowed until it covers nothing and a rule widened until it covers
   everything both fail, which is the same dead rule from two sides.

## The alternative, and the specific way it fails

The alternative is the one ADR 0017 already rejected at the level of behaviour — *build the capability and
hold it behind a flag* — and it arrives a second time in a much more reasonable-looking form: **write no
filing code and rely on nobody writing any.** That is the state this build was in until this unit. It looks
identical to the enforced version, costs nothing, and has been true for 99 migrations.

It fails in a way that has a name in this repository. `pnpm boundaries` was once reduced to zero modules by
a TypeScript upgrade while reporting success, and only a deliberate-violation test found it. The absence of
filing code is the same shape: a property that is true, that nothing measures, and whose becoming false is
silent. What makes this instance worse than an ordinary unmeasured property is WHO pays. The taxable person
carries the liability for what is filed; an incorrect return filed by software is not a bug report, and the
person who eventually writes the submission call will do it helpfully, in an afternoon, because an
accountant asked why they have to type the figures in by hand.

There is a second alternative worth naming because it is the one a reviewer suggests first: **make it a
lint rule about names only** — the identifier grep, without the boundary rule. It is one file, it is
repository-wide, and it catches the honest addition. It also cannot catch `postVat201ToProvider`, and a
grep over names is the one mechanism here whose evasion needs no thought at all: rename the function. The
identifier scan is kept because it catches the thing somebody writes when they are NOT trying to get round
anything, which is how this capability would actually arrive. What closes the hole is rule 1 and rule 2: a
filing path must reach the network under SOME name, and reaching the network is what neither permits.

The converse alternative — **the boundary rule only** — fails on `fetch`, which is three keystrokes and
invisible to a module graph.

## The export, and why it is a file rather than a call

The furthest a figure travels towards the authority is a CSV somebody is handed. docs/04 §4 is explicit
about why, and it is not caution: the e-invoicing model is [UNVERIFIED] (a Peppol-based
accredited-service-provider arrangement, dates unconfirmed), and that section's own conclusion is *"a strong
argument for routing statutory filing through an accredited package rather than building it."*

Three properties of the file are decisions rather than details:

- **It carries no instant and no person.** `renderZohoVatReturn` takes the filing row and nothing else, so
  the same signed return exports to the same bytes for ever. That is what makes the file hash recorded on
  the `audit_event` answer a question — "is this the file we handed over" rather than "is this a file
  somebody made at some point". An `exported_at` column inside the file would make every export a different
  artefact and the hash an identifier for nothing. Who exported it and when are in the audit row, where
  `occurred_at` is the database's own clock.
- **It carries no TRN, registered name, address or authority reference, and it is not Zoho Books' own import
  format.** Every one of those is unanswered, and brief rule 15 is that a plausible value is worse than a
  blank one because blank is visibly unanswered. Which columns that package expects for a VAT return is
  [UNVERIFIED] Y11-zoho-import — inventing a set would be inventing an integration contract, which is the
  same mistake as inventing a TRN one layer out. So the file declares its own tag,
  `berelax.vat201.zoho.v1`, and answering the question is a new format version beside this one rather than a
  silent change in what every previously exported file meant.
- **Amounts are integer fils with no decimal column.** A decimal rendering would be a second money
  formatter in a package that may not import `@berelax/core` (brief rule 4), and it would be one a
  spreadsheet parses as a double on the way into the accounting package — the drift ADR 0007 exists to
  prevent, arriving through the one file nobody would think to check.

## The consequences somebody has to live with

**The pattern in rule 3 is porous, and it is written down rather than smoothed over.** `submitVatReturn` has
`Vat` between the two words the pattern joins, and `e-file` spelled with a hyphen is not in the pattern at
all. The pattern is the one M-VAT-09's acceptance criterion states, character for character, and it is
deliberately not widened here: it is quoted in the manifest and in the script, and a check quietly enforcing
something broader than its specification makes the two disagree in the direction nobody reads. The porosity
is why there are six refusals and not one.

**The scan needs segment alignment, and that is not an optimisation.** `efile` as a substring matches the
`eFile` inside `writeFileSync`, `readFileSync`, `sourceFiles`, `captureFilename` and
`parseCaptureFilename` — about forty occurrences in this tree. A gate that fires on `readFileSync` is a gate
somebody switches off rather than fixes, so the match must begin where a name's segment begins and end where
one ends. Gate case 130e removes the alignment and requires the scan's own negative control to fire.

**Three files are exempt from the identifier scan, and one token is.** The script itself (the pattern is
written out in it), `scripts/test-gates.mjs` (it holds the fixtures, which must contain the strings the gate
rejects), and `0052_obligation.sql`, whose comment states that the system *"contains no auto-file
capability"* — the sentence this gate is the enforcement of, in a migration that is a record of what was
applied rather than a file to edit. Each exemption is asserted to be USED, because an exemption that excuses
nothing is a hole waiting for the next thing written there. The token is the gate's own name: every comment,
CI line and gate case that cites `no-autofile` contains it, and the first run of the scan flagged the module
the gate protects for naming its own gate. Exempting the FILE would have been the wrong fix — it is the one
file where a filing capability would be most at home — so the exemption is the exact token and nothing else.

**There is no `vat_return_export` table, and this is the one claim in the unit the database does not hold.**
Every other refusal around the VAT return is a trigger or a CHECK, for the reason ADR 0044 and migration
0087 record: a
rule in a service is a rule for the callers that came through the service. That argument does not transfer
here, and the reason is worth stating precisely rather than leaving as an inconsistency: **an export writes
no row.** Its whole content is a read plus some formatting, so there is nothing for a `psql` session to
write that a trigger could refuse — which is exactly why 0095 put the sign-off refusal on
`vat_return_for_filing()`, a READ, in the first place. The evidence of an export is therefore an
`audit_event`, which is append-only in the database (ADR 0008), written by the same function that produces
the bytes and in the same transaction, so the file and the evidence of it cannot separate. What this costs
is that the audit trail is the ONLY index of exports: there is no `vat_return_export` to join, and "which
returns have been handed over" is a query over `audit_event` by action. A later unit that needs exports as
first-class records adds the table and the deferred audit trigger; nothing here forecloses it.

**`ReturnNotSigned` and `VatReturnNotSignedOff` are one refusal under two names, and only one exists.**
M-VAT-09's acceptance line calls it `ReturnNotSigned`; M-VAT-08 shipped it as `VatReturnNotSignedOff`, from
`ZY055`. This unit does not add a second class, because two error classes for one database rule is the
second-statement-of-a-fact problem in the place it matters least and reads worst — a caller branching on the
wrong one is a screen that cannot tell a missing signature from an unknown failure. The manifest carries a
`NOTE` saying so.

**The boundary rule exempts the test files, and the exemption is load-bearing.** `zoho-export.itest.ts`
imports `node:http` and `node:https` in order to replace their `request` with a throwing stub — the opposite
of using them — and it is the file that proves the export completes with no network at all. A rule that
condemned it would leave the claim unprovable, which is the mistake the first version of
`payments-must-not-reach-the-network` made and recorded.
