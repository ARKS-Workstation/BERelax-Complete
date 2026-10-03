# ADR 0124 — A runbook is machine-checked or it is decoration, and its front matter is a narrow format rather than YAML

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** H-HARD-06
- **Covers:** docs/01 decisions — none; this extends H-HARD-09's documentation chain (`pnpm docs-set`)
  rather than adding a second checker, and it is ADR 0003's known-bad-fixture rule applied to prose

## Context

The runbook set is what somebody reads at 8pm on a Friday. That is the one moment when nobody is going
to notice that the script a step names was renamed six months ago, and every failure mode of this
document set is quiet in exactly that way: the sentence still reads correctly and the thing it names is
gone. `pnpm docs-set` already catches a dead *link*; it cannot see a dead command, because a command in a
runbook is a code span and not a link.

Four existing runbooks had no structured front matter at all, so there was no machine-readable statement
of what triggers any of them, what the first action is, or who owns it. And the alert registry pointed
one way only: `pnpm alerts` resolves each alert's `<stem>#<slug>` to a heading, which stays green while
the document under that heading quietly becomes about something else.

## Decision 1 — the checker is the fourth link in `pnpm docs-set`, not a gate of its own

`scripts/check-runbooks.mjs` runs after `check-docs-links.mjs` in the same chain. A second entry point
reading the same directory is a second place for the set's rules to live, and the one that would drift is
whichever one was not in `pnpm verify`. It therefore adds **no** new verify step and no new case-29
registration: `pnpm docs-set` is already both.

## Decision 2 — the front matter is a narrow format with its own parser, and no YAML dependency

One `key: value` per line between two `---` lines at the very top, no continuation lines, no nesting,
lists comma-separated, an empty list written `(none)`. A continuation line is an ERROR rather than a
block scalar.

Two reasons, and the second is the real one. First, validating a JSON Schema document needs a validator,
this workspace has none, and adding a dependency for eleven fields puts a supply-chain surface behind a
documentation gate. Second, and decisively: with a narrow format **the parser IS the format**. A document
that is almost YAML is refused with a line number, rather than parsed into something nobody meant — and a
front matter that means one thing to a reader and another to the gate is worse than none, because it
looks checked.

## Decision 3 — `_schema.json` is READ by the checker, and an unimplemented `kind` is refused

The schema declares eleven fields, each with a `kind`; the checker implements the kinds and refuses one
it does not know (`runbook-schema-construct-unimplemented`). Both directions are proved by gate cases:
adding a required field to the schema makes every runbook fail on the same commit, and declaring an
unknown kind fails rather than being skipped.

That second half is the point. A checker carrying its own copy of the field list is a second statement
that drifts, and the field it would stop requiring is whichever one somebody added last. A schema whose
keywords are silently ignored is worse still — the field looks checked and is not, which is ADR 0002's
green tick over nothing in a new place.

`owner` resolves against `ROLES` from `packages/core` rather than a list here, so a role added to the F07
matrix is admissible on the same commit and a plausible-looking person's name is not (brief rule 10).

## Decision 4 — the alert cross-check runs in BOTH directions, and `trigger_kind` is what makes an orphan detectable

Each runbook declares the alert ids it answers. The registry's own `runbook` field gives the file, so the
two are held equal: an id in the front matter that the registry does not define, and an alert whose
registry entry points at a runbook whose list omits it. The second is the one `pnpm alerts` cannot make.

"No runbook without a trigger" needed something verifiable rather than a prose field nobody can check,
so `trigger_kind` is a closed set and `alert` is the only value that requires a non-empty `alerts` list.
A runbook that says it is triggered by an alert and names none is an orphan by that rule; one triggered
manually, on a schedule, or by an external event states its trigger in a sentence and is not.

## Decision 5 — six of the eight required subjects say what this build does NOT have, in the document itself

The acceptance line names eight subjects. Writing the procedures made it clear that for several of them
the honest document is mostly about an absence, and that writing a plausible procedure instead would be
the worst outcome available:

- **`database-failover`** opens by saying there is **no standby**: one `DATABASE_URL`, no replica, no
  read/write split. Its three real cases are told apart (server down, credential refused, connections
  exhausted) and the lost-database case routes to the restore runbook. What a real failover would need is
  listed so the cost of not having it is visible.
- **`messaging-outage`** names the trap that looks like a workaround: `SMS_PROVIDER=fake` does not queue
  for later, it makes the send succeed against a fake and marks the outbox event delivered. The message
  is then gone, recorded as sent, and nobody will ever know.
- **`payment-gateway-outage`** separates the refused charge from the charge whose outcome is unknown, and
  has no step that makes the figures agree: a divergence the event stream does not explain is
  quarantined, never corrected.
- **`job-backlog`** opens with the exposure the alert registry already records — every alert is raised by
  a pass, so a stopped worker raises nothing and the absence of alerts reads exactly like quiet.
- **`google-invalid-grant`** is a table separating `invalid_grant` from the five Google failures it is
  mistaken for, because only that one needs a person at a browser.
- **`cutover-rollback`** is explicit that nothing decides it, and lists what a rollback cannot undo:
  issued tax documents, sent messages, audit rows, erasures.

## The consequence somebody will have to live with

**Every claim a runbook makes about the repository is now load-bearing, so a rename breaks the build.**
That is the intent, and it has a cost: renaming a script means editing the runbooks that name it, in the
same commit. The alternative is the one this ADR exists to end — a set of documents that is correct on
the day it is written and is read for the first time on the worst night of the year.

**And the front matter has to be maintained by hand.** It cannot be generated: the trigger, the first
action and the escalation are judgements, and the one field that could be generated — the first action's
heading — is checked against the document instead, which is the half that catches a reorganisation.
