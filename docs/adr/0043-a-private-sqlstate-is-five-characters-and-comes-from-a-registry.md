# ADR 0043 — a private SQLSTATE is all five characters, and it comes from a registry

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** W-SYS-12
- **Covers:** docs/01 decisions — none; this is the allocation mechanism behind every refusal code the
  schema raises, and it is the enforcement half of a convention ADR 0006 implies but does not state (a
  migration is written once and applied once, so the identifiers it hands out cannot be reissued)

## Decision

**A private SQLSTATE is identified by all FIVE characters. The CLASS stops identifying a migration file: two
unrelated rules may share a class and may never share a code. `packages/db/src/sqlstate-registry.ts`
allocates them, one entry per code, and `pnpm sqlstate` derives the truth from the migration files and
refuses a registry that disagrees.**

That one sentence — *two rules may share a class and never a code* — is what makes `ZZ` sufficient. Under
the old convention the scarce thing was the class, and there were 26 of them.

The registry entry names the code, the rule in one sentence, the migration whose LIVE definition raises it,
the functions that raise it, and the translators that report it. Only the sentence is prose; every other
field is a claim the gate proves. The gate fails in five directions:

1. two entries sharing a code;
2. a code raised by a migration with no entry;
3. an entry naming a code no migration raises — the direction that lets the registry **shrink**;
4. an entry whose migration, functions or translators disagree with the tree;
5. one code raised from two migrations' live definitions, which is the collision itself.

Allocating is reading the entries for the class your rule belongs in and taking the next free subclass. There
is no reservation step and nothing to ask anybody for: a code two units both take fails direction 1 or 5 in
whichever tree merges second.

## The alternative, and the specific way it fails

The alternative was the convention this replaced, and it is worth stating precisely because it did not look
like a bad idea: **one private class per migration file, picked by reading the migrations you can see.** It
gives every file a namespace, it needs no shared state, and for 60-odd migrations it worked.

It failed in two ways at once, and the second is the one that matters.

**It ran out.** `ZA` through `ZZ` is 26 namespaces for a schema that is at 94 migrations and has 89 units
still to land. `0093_publication.sql` took the last free class, and ADR 0042 records that it had to: the
convention had no allocation left in it, so the next migration needing a refusal code could only extend an
existing family — which the uniqueness check refused — or wait.

**And "the migrations you can see" is not a fact about the repository; it is a fact about a worktree.** Units
run in parallel in separate checkouts, so two units allocating on the same afternoon read the same tree and
reach the same conclusion. Four migrations claimed `ZY001`. `0084` and `0085` both took `ZA`. `0087`
deliberately avoided `ZW001` *because it was known to be shared*, wrote a paragraph explaining the collision
it was avoiding, and took `ZX001` — which was already `0086`'s attendance rule, allocated in a worktree it
could not see. Thirteen codes each stood for two rules.

A shared code is not untidy. Every translator in `packages/db` matches on the code ALONE, so three things
break at once and none of them loudly: a translator reports one file's refusal as the other's, with a
plausible message and the wrong cause; a probe asserting the code passes when the statement bounced off
something else entirely; and the test that was supposed to prove a rule fires proves only that SOMETHING
did. `0080_frequency_ledger.sql`'s own header says it. Every one of the thirteen was green.

A second alternative, rejected: **keep the class-per-file convention and add a reservation list.** That is
the same design one level up — a list of what a file WILL use, which nothing compares to what it does use —
and it fails the way the port-band comments failed before `TEST_PORT_BANDS`: by the eleventh claimant three
pairs were sharing one band and one file had written two of the three overlaps into its own comment as if
they were the arrangement. The registry is not a reservation list; it is compared to the migrations on every
run.

## The consequences somebody has to live with

- **A class no longer tells you which file a code came from.** `ZT` holds the payment tender's rules and the
  customer merge's; `ZU` holds the cash session's and the CRM pipeline's. Grepping a class is no longer a
  way to find a subject, and the registry is the index instead. That is the cost of the sentence that makes
  `ZZ` sufficient, and it is a smaller cost than it looks: what a reader actually has is a five-character
  code from a log, and the registry answers that in one lookup where a class never did.

- **Nine codes moved, and every translator, probe and comment naming them moved with them.** `0099` is the
  migration: it `create or replace`s nine trigger functions and changes one token in each.
  `ZT001`→`ZT005`, `ZT002`→`ZT006`, `ZT003`→`ZT007` (0069's merge record, survivor-is-live and chain bound,
  leaving 0068's tender rules on the originals); `ZU001`→`ZU008`, `ZU002`→`ZU009`, `ZU003`→`ZU010` (0077's
  pipeline, leaving 0076's cash session); `ZW001`→`ZW006`, `ZW002`→`ZW007` (0081's rota, leaving 0080's
  frequency ledger); `ZX001`→`ZX006` (0087's promotional window, leaving 0086's attendance). The later
  migration moved in all nine, which is not a coincidence: the second unit to reach for a class is the one
  whose worktree could not see the first. **Anybody reading a log or a runbook written before this date will
  find the old code**, which is why `0099`'s header carries the table and the old migrations are left saying
  what they said.

- **The migrations that defined those functions are deliberately NOT edited.** `0069`, `0077`, `0081` and
  `0087` still contain `errcode = 'ZT001'` and its siblings, inside definitions `0099` supersedes. A
  numbered migration is a record of what was applied; editing an applied file makes the history of a refusal
  unreadable, and the gate reads the live definition so the dead text costs nothing. What it does cost is
  that grepping the migrations for a code now returns both the live raise and the superseded one, and the
  answer to "which one executes" is `pnpm sqlstate`, not the grep.

- **Four of the thirteen were never collisions, and the check that said they were had to be replaced rather
  than trusted.** `ZB001`, `ZB002`, `ZL002` and `ZV002` are one rule each whose function was later
  `create or replace`d — `assert_room_capacity` and `assert_room_capacity_covers_commitments` in 0038,
  `raise_if_period_locked` in 0073, `assert_bill_totals_match_lines` in 0039 — so the earlier file's `raise`
  is text that can never execute. The old detector keyed on **which files contain a code**, which cannot
  tell a superseded definition from a second rule; it therefore reported three collisions that did not exist
  and described the fourth wrongly ("0018 raises it from the shared function, 0073 from its caller" — 0073
  replaces that function). The derivation now resolves every raising function to its live definition first.
  The consequence to live with is that the check is no longer a text scan: it has to understand
  `create or replace`, and a migration that defines a function in a way the parser does not recognise will
  be attributed to `(do block)` rather than silently to the function above it.

- **29 of the 138 codes have no translator, and the registry says so with an empty list.** That was
  invisible before: those refusals reach their caller as a raw `postgres.js` error. The empty list is
  checked in BOTH directions, so adding a translator fails the build until the entry names it — and nothing
  here invents a translator that does not exist, because a plausible entry is worse than a blank one (brief
  rule 15).

- **`KNOWN_COLLISIONS` is deleted rather than emptied**, and a test asserts that no module declares it again.
  An empty allowlist is a place to put the next collision, and the thirteen it held arrived one merge at a
  time. There is now nowhere to record an exception, which means a genuine one — if some future rule really
  must share a code — has to change this ADR rather than add a line to a map.

- **The gate is a registered `pnpm verify` step and is named in gate case 29's array**, so dropping it from
  CI fails the build. That is not ceremony: the failure mode of the convention it replaces was precisely
  that nothing failed when it was ignored.
