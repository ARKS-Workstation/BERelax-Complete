# ADR 0116 — a reason is a declared consequence or the agent's own words, and nothing else is representable

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** G-AGT-02
- **Covers:** docs/01 decisions — none. A mechanism under ADR 0002 (a gap is not a nought), beside
  ADR 0104 (the four heartbeat fields and giving up as a state) and G-AGT-01's structural watching.

## Context

G-AGT-02's acceptance line is unusually specific about a string: *"Real reason, never generic … a DOM
test asserts the string 'An error occurred' appears nowhere on the page"*. A test over the rendered bytes
is the right check and it is not enough on its own, because it tests a page rather than a shape: a console
can pass it on the day it is written and grow a fallback six weeks later, and the fallback is exactly what
a reviewer skims past. `?? 'An error occurred'` is eleven characters and reads as defensive programming.

The failure it produces is specific and it is worse than it looks. A console that says "an error
occurred" about a paused autoresponder sends somebody after a stack trace for a Google grant that has
expired — a thing with a button on the screen above. The generic string does not merely fail to help; it
points away from the remedy. And a screen where one row in eight says nothing useful is a screen whose
other seven rows stop being read.

The second half of the problem is that ONE cause produces DIFFERENT reasons. With the Google connection
broken, the review autoresponder cannot post a reply at all and the SEO agent falls back to the history it
keeps. Reporting either as the other is its own defect: "paused" about an agent that is running sends
somebody after a stopped worker, and "degraded" about an agent that cannot act means review replies have
stopped being posted while the console says some figures may be stale.

## Decision

**`AgentReason` is a discriminated union, and every member carries either a sentence declared for a named
cause or the agent's own `agent_heartbeat.last_error`.** There is no member a renderer can reach without a
cause, so there is nowhere for a generic string to live. `agentConsoleReason` is total over its input and
answers `running` when nothing is wrong — and `running` carries no text at all, because a row with no
problem has no reason and a sentence there would be one more line on a screen whose value is that its
lines mean something.

**What a broken Google grant does to an agent is DECLARED per agent**, in `GOOGLE_DEPENDENT_AGENTS`, as
`pauses` or `degrades` with the consequence written out. The table is keyed by `agent_key` and is
deliberately NOT exhaustive: an agent that is not in it is unaffected by the connection, which is the
ordinary case and is what lets a new `agent_definition` row appear on the console with no code change —
the same acceptance list's first claim. An exhaustive `Record` would make adding an agent a compile error
in that file, which is the opposite of what that line asks for.

**The one case where the console has no words says which field is empty.** An agent whose heartbeat
records a failure and no error text happens — a worker killed between the attempt and the write leaves the
streak without the reason — and `failing_without_words` names the absence and points at `agent_run.error`.
That is the member that makes the whole design hold: it is the branch a fallback string would have been
written for.

## Consequences

**The sentences are in code and not in the database, and they cannot be edited by an operator.** What a
missing grant does to the autoresponder is decided by the autoresponder's design, so a settings-table copy
would be a sentence somebody could edit into something untrue about code they cannot see. The cost is a
release to reword one.

**A new Google-dependent agent needs a line in the table or it reports nothing about the connection.**
That is the trade the non-exhaustive table buys, and it is the right way round: an agent that silently
reports no Google reason is a missing sentence, and an agent that cannot be added without editing a
reason table is a registry that is no longer the list.

**`last_error` is printed verbatim, escaped.** It is the agent's own words and this console does not
paraphrase them, which means a job that writes a useless sentence produces a useless row — and the remedy
is in that job rather than in a layer that would have to decide which errors are worth showing.

**The ordering is part of the decision.** A kill switch beats everything because it is the one cause that
is somebody's deliberate act; a broken grant beats a failure because it EXPLAINS the failure; a failure
beats an open watchdog alert because an agent that is running and failing needs a stack trace while one
that has stopped needs a worker. Reading the precedence list is reading the decision.
