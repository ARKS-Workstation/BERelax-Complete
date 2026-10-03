# ADR 0094 — five is a CAP the weekly report must be able to fail to reach, plain English is measured over the RENDERED BODY and not the template, and the report goes down the one send choke point

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** G-SEO-07
- **Covers:** docs/01 decisions — none; this is the mechanism behind docs/07 §3's *"the thing that makes the
  agent's autonomy earnable"* and docs/09's warning about a report whose reader learns to skim. It stands on
  ADR 0002 (a check that examined nothing is worse than one that failed), ADR 0003 (every gate needs a
  known-bad fixture asserted by rule name), ADR 0005 (no real provider outside production), ADR 0007 (money
  is integer fils), ADR 0016 and docs/03 §4 (one send choke point), ADR 0022 (every external service behind
  a port with a fake), ADR 0063 (a judgement on a send path is not injectable), ADR 0070 (an unattributable
  figure is a refusal and never a zero) and ADR 0085 (the cry-wolf problem, and why a threshold is a
  caller's argument)

## The problem this record is about

The weekly email is the only thing most of this agent's work is ever seen through. An owner who reads five
actions and recognises them agrees to more automation next month; an owner who reads a wall of metrics stops
opening it, and the week the agent is right is the week nobody notices. ADR 0085 recorded that hazard for
the analyses. This is the last mile of it, and the three ways it goes wrong are all invisible to a test that
only asks whether an email was produced.

## Decision 1 — five is a CAP, and the report must be able to fail to reach it

The acceptance criterion is two assertions and the second is the one that matters: *"a run with three
findings renders three and states the honest count rather than padding."*

A report that always finds five has a **floor**, not a finding. Padding is the specific failure, and it is
worse than it looks: the fifth-best action in a quiet week is noise, and a reader who meets it four weeks
running has been taught that the list is filler — which is exactly the attention this report exists to earn.

So `prioritiseSeoActions` returns `found` beside `shown` and `withheld`, never invents a row, and the
sentence the report prints is rendered from `found`. Gate case 172a is the fixture: it pads `actions` up to
the cap, which satisfies *"exactly five prioritised actions"* perfectly and is caught by the three-finding
assertion. Gate case 172b is its companion — the count sentence made a constant — because a report showing
four rows under a sentence claiming five is the same lie told by the half nobody checks.

**The priority order is declared as data, not computed from a score.** `SEO_FINDING_PRIORITY` lists the six
kinds with the reasoning for each, highest first, and the sort is stable within a kind. A score would be a
model of importance nobody has agreed to, and it would change the order of a weekly email between two runs
for reasons nobody could explain — which also breaks the unchanged-rerun screenshot the acceptance line
asks for. `suggestion` is last because it is the one kind where doing nothing this week costs nothing at
all, which is why a quiet week's report is allowed to be short.

## Decision 2 — plain English is measured over the RENDERED BODY

`seoReportReadability` takes the body, not the template. That is the difference between a check and a hope:
every figure, finding and action in the body arrived at render time, so a check over the template would pass
for ever while the sentences the data produced grew.

Three rules, each with a failure behind it:

- **Sentence length.** `SEO_REPORT_MAX_SENTENCE_WORDS` is 24 and it is a *choice*, named as a constant so it
  is one decision in one place. `seoReportReadability` takes its maximum as a **required argument** for the
  reason ADR 0085 decision 1 gives about thresholds: a limit that arrives by default is a limit nobody
  chose.
- **Every metric carries a one-line explanation.** `SeoReportMetric.explanation` is a required field, so a
  metric cannot reach the body without one. A number with no explanation is a number the reader cannot act
  on, and *impressions*, *position* and *CTR* all read as self-explanatory to whoever wrote them.
- **No jargon without its gloss, no scope URL, no SQL, no raw identifier.** `SEO_REPORT_JARGON` is a **map
  from a term to its definition**, not a blocklist, and the direction is the point: those words ARE the
  vocabulary of the finding, so forbidding them would make the report unable to say what it found. What is
  forbidden is using one without its gloss. The glossary prints only the terms the body actually used — gate
  case 172g is the other direction, because six definitions in a report that uses one is four lines pushing
  the five actions below the fold.

The forbidden-content rule is about a different hazard from the other two: scope URLs, `select … from` and
`sc-domain:` get into a template by somebody pasting a diagnostic, and the first person to receive one is
the owner.

**The pass refuses to send a body that breaks its own rules**, with the rule names in the reason. That is
ADR 0063's shape one subject along: a judgement on a send path, not an advisory. A body sent once would be
read as the house style from then on.

### The one exemption, and why it is asserted to still be needed

`SEO_REPORT_READABILITY_EXEMPT` holds exactly one entry: `rareQueryGapExplanation`'s first sentence, which
is 31 words. That function is the build's **only** explanation of why the query totals are lower than the
page totals, and its own header says a second one would keep reading the same after the data changed. The
alternatives were both worse — a shorter second sentence for email is precisely the drift it exists to
prevent, and rewording another unit's prose is an edit this unit's cap does not justify on its own.

The exemption is asserted to still be **live**: `weekly-report.test.ts` requires the sentence to appear in a
report with a discrepancy *and* to be over the maximum, so the day somebody shortens it the test fails and
the exemption is deleted deliberately rather than inherited for ever. That is the pattern
`packages/fixtures/src/seo-nap-literals.test.ts` already uses for its two file exemptions. It is also the
one place in this unit where a rule is relaxed, which is why it is on the record rather than in a comment.

## Decision 3 — the discrepancy is explained when there IS one, and not when there is not

Both branches are the acceptance line, and the zero branch is the one that is wrong by default:
`rareQueryGapExplanation` has a confident sentence for a window with nothing withheld (*"That is unusual, and
normal only for a short window…"*), which belongs on the dashboard beside the query report rather than in an
email that is five actions long. So the report renders the explanation only when `rareQueryGap` says
something was withheld.

A window with **no snapshot at all** is a third state and is `null`, not zeros. A window with no snapshot and
a window with no withheld clicks are different facts, and the second has a sentence while the first has
nothing to say.

## Decision 4 — the report goes down the EXISTING choke point, and the F03 guard is re-asserted here

`deliverMessage` and therefore `sendMessage`, where the template judgement, the sender-identity class rule,
the promotional gate, the campaign cap and the staging guard live.
`scripts/check-send-chokepoint.mjs`'s `message-send-outside-the-choke-point` permits a `.send(` only in
`send.ts` and the two transports, so a second path here fails that scanner rather than merely being
discouraged. The port's method is `deliver` and not `send`, for `ReviewNoticeNotifier.notify`'s reason: the
name is not a way round the scanner, and what matters is that there is one place a message can land.

This is the **third** runtime in this worker to wire a `SendContext`, and what keeps the three from drifting
is not a comment: `gate-evaluator-answers-a-constant` refuses an evaluator wired to a literal, so the three
fail-closed evaluators beside the kill-switch literal are a rule rather than a convention. The runtime is
declared in `PERMITTED_LITERAL_KILL_SWITCHES` with its reason, because reading the marketing control row on
this path would be worse than not reading it — an unreadable marketing table would stop the one email that
says the agent has gone quiet. `pnpm send-chokepoint` refused the first version of this file for exactly
that, which is the gate doing its job.

Both halves of F03 are asserted **at this seam** rather than taken on trust: a recipient not on
`OUTBOUND_ALLOWLIST` outside production is diverted to the local outbox with no provider call, and
`EMAIL_PROVIDER=real` outside production does not even construct (ADR 0005).

**The recipient is nobody, and that is the shipped answer.** `NO_OWNER_REPORT_ADDRESS` returns `null`: no
table in this build holds a contact address for the owner (migration 0075 recorded it for the Google re-auth
ladder, P-HR-06 for the rota notice), and a plausible address is worse than a blank one.
`google_connections.google_email` is deliberately not used — docs/10 §5's third question is *which Google
account currently owns the GBP listing*, answered *possibly a former agency*, so sending this business's
weekly report there would be a disclosure to a third party chosen by the build.
`Y7-owner-notification-address` is the question and that resolver is the one line that changes.

## Decision 5 — the body is composed in `packages/core` and the frame is a template row

One variable, `{{report}}`. Every other template in `templates.ts` owns its sentence and takes a value or
two; this one owns the frame and takes the whole body, because the body is five actions whose number, order
and wording come from what the week found. A template with a field per action would have to declare a fixed
five, and a three-finding week would then render two blanks in the sentence — the padding decision 1
forbids, arriving through the template instead of the renderer. Gate case 172o is the fixture.

The frame stays editable without a deploy, which is what `message_template` is for. The Arabic variant is
seeded and will be selected the day a staff locale exists (ADR 0020's reason, as the re-auth templates
record); its `{{report}}` body is composed in English today, which is honest rather than hidden — a machine
translation of a report somebody acts on would be this build inventing the owner's words.

## Decision 6 — the heartbeat facts come from the ROWS

`agentHeartbeatFacts` reads `agent_heartbeat.last_success_at`, derives the next run from
`last_run_at + expected_interval_seconds`, and sums `agent_run.cost_fils` **in SQL**. Three notes, each a
defect avoided:

- `nextRunDueAtIso` is **derived**, because nothing in this schema stores a schedule. A cron expression
  copied out of a worker into a report is a second statement that drifts the first time the schedule moves.
  A heartbeat with no `last_run_at` has no next run on the books, reported as `null` rather than as *now*.
- The cost is summed in SQL for `settings-store.itest.ts`'s reason: a capped reader makes a growing total
  pin silently at the cap.
- `lastSuccessAtIso` nullable, and the report has a different **sentence** for null rather than printing an
  instant. A report that said *"last finished on null"* — or worse, today — would say the agent is fine on
  the exact week it stopped, which is the failure the heartbeat section exists to prevent.

## What is NOT built

The acceptance line *"Playwright captures the rendered HTML preview at 3 viewports × 2 themes with zero
pixel diff on an unchanged rerun; axe reports zero violations on the preview pane"* is **not built**, and a
NOTE on the manifest entry says so and to whom it goes. The reason is that there is no preview *pane*: this
unit adds no route, the HTML part is stored on the `message` row, and the surface that renders it is the
admin message inbox, which belongs to another unit. A screenshot matrix needs a registry route of its own
and an entry in the breakpoint harness; adding one here would mean this unit owning a screen whose subject
is every message in the system rather than this report. What IS asserted is the thing the matrix would be
about: `seo-weekly-report.itest.ts` compares the stored `body_html` byte for byte against the HTML the
transport was handed, so the preview is the bytes that were sent and not a second rendering of them.
