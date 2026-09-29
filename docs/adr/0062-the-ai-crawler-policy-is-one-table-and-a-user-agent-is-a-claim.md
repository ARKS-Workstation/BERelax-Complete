# ADR 0062 — the AI crawler policy is one table, a user agent is a claim and never evidence, and a headless suspicion is corroborated or exact

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** A-FIRST-04
- **Covers:** docs/01 decisions — none; decisions 14 and 24 are recorded in ADR 0018, and this is a
  mechanism under it, beside ADR 0046 (the taxonomy), ADR 0058 (origination) and ADR 0059 (the egress
  guard). It fills in the `analytics.session.bot` and `analytics.session.bot_kind` columns ADR 0045's
  schema created.

## Decision

Four things.

1. **The AI crawler policy is ONE table**, `packages/shared/src/crawlers.ts`. The `robots.txt` builder, the
   bot classifier and the repository-wide scan that refuses a third statement all read it, and
   `apps/web/src/crawler-policy.test.ts` holds the rendered policy, the table and the classifier equal in
   every direction.

2. **`Bytespider` is on the allowed list**, which is one token more than docs/09 §"LLM SEO" names.

3. **A user agent is a claim, not evidence.** `classifyBot` returns a `basis` saying which half of the
   module answered, and no verdict from this module may refuse, gate or authorise anything.

4. **`suspected_headless` is corroborated or exact.** Three named signal rules; a rule fires alone only
   where a person cannot produce the signal at all; otherwise two must agree. No tolerance, and no tuned
   threshold.

## Why one table, when two lists would have been shorter

Because the two lists had already been written. `apps/web/src/facts/robots.ts` held five tokens because
docs/09 requires an explicit decision about them, and `packages/core/src/analytics/bots.ts` had to hold the
same five to detect them, because docs/03 §6 is explicit that the second half is what makes the first
affordable: *"We deliberately allow GPTBot, ClaudeBot and PerplexityBot for citation value. On a
low-traffic local site they will inflate page views substantially. Without a filter list and a `bot` flag
on every session, the funnel is meaningless."*

The obvious alternative — two lists and a test asserting they are equal — fails in a way this build has
already paid for twice. A set-equality test between two hand-written lists passes on the day it is written
and is the first thing deleted when somebody adds a crawler in a hurry; and it says nothing at all about a
THIRD copy, which is how the same fact ends up in four places. So the equality here is structural: both
readers derive from the table, and what the check tests is that they still derive — 140a to 140f each put
one reader back on a list of its own and require a named failure.

The consequence somebody has to live with: the crawler names may appear in exactly two files
(`crawlers.ts` and the pin in `crawler-policy.test.ts`) and in prose, and nowhere else in `packages/` or
`apps/`. A scan enforces it. That is a real constraint — a future unit that wants a per-crawler rule in a
query cannot write the name at the call site — and it is the price of the property.

The table lives in `packages/shared` rather than `packages/core` for the reason the event taxonomy does:
`packages/db` can reach `shared` and must never import `core` (ADR 0001), so a policy this build might one
day want to read in a query has no business on the wrong side of that boundary.

## Why Bytespider, when docs/09 names five

docs/09 names GPTBot, ClaudeBot, PerplexityBot, Google-Extended and CCBot, and recommends **allow** for the
citation argument. Bytespider — ByteDance's crawler, which feeds TikTok search and Doubao — is not in that
list, and it is in this one. Two things make that the right answer here rather than a quiet extension of
somebody else's decision.

The first is that the classification half is load-bearing whatever the policy half says. On a small site
Bytespider is among the highest-volume crawlers there is, and an unclassified crawler is not a neutral
omission: its page views are counted as people, so the funnel's denominator grows, every conversion rate
falls, and nothing fails. The unit's job is that the funnel means something.

The second is the shape of `robots.txt` itself. A crawler obeys exactly one group and a named group
*replaces* the wildcard rather than extending it, so every group in this file carries the identical policy.
Once the name is in the table it is in the file, and a name in the file is an `Allow`. "Classify it but do
not mention it" is therefore not available without a second list — which is the thing this ADR exists to
remove.

The alternative was to block it, as many sites do, on the grounds that ByteDance's crawler has been
reported to ignore `robots.txt` and that TikTok search is a thinner citation surface for a Dubai spa than
an assistant is. That argument is about the *value* of the trade, which is the owner's to make and not
this build's: it is recorded as **Y5-ai-crawler-allow-list** in `docs/OPEN-QUESTIONS.md`, and answering it
"block" is a change to one field's worth of mechanism — a per-entry rule in the table and a second branch
in `ruleLines()` — rather than a change to anything the classifier does. Nothing about the measurement
depends on the answer, which is why the mechanism was built and the figure was not invented.

## Why a claim can never be evidence, and what that forbids

Anyone can send `User-Agent: GPTBot`. Nothing in an HTTP request proves who sent it, and the things that
come close — a reverse DNS lookup on the peer address, a published IP range — are network I/O, which
`packages/core` cannot do even in principle (ADR 0001). So `bot: true` from a user agent means exactly one
thing: this request said it was a bot.

That is enough for what the flag is for. A crawler that declares itself is telling the truth for its own
reasons — it wants `robots.txt` applied to it — and the figure the analytics page needs is a share, not a
verdict about an individual session. It is nowhere near enough for anything else, and the rule that follows
is the one that has to be written down:

> No verdict from this module may refuse, gate or authorise anything.

Serving different content on it would be cloaking decided by a string the visitor controls. Refusing a
request on it would be an access-control decision resting on a header. The verdict's `basis` field exists
so a consumer can tell a self-report from an inference, and the inference is weaker about identity and
stronger about honesty: it cannot be turned off by editing a header.

The same reasoning is why an absent or blank `User-Agent` is **not** a bot. It is the absence of a claim,
and the two errors do not cost the same: a bot counted as a person is one row in a denominator, while a
person counted as a bot is a visitor the funnel drops by default and nobody ever sees.

## Why the signal heuristic is corroborated or exact, with no tuned number

The specification names three signals — absent viewport, zero interaction events, identical inter-event
timings — and no figure. The temptation is a score with a threshold, and the threshold would have been
invented. Instead:

- Each rule declares whether firing **alone** is enough, and only one does: identical inter-event gaps, to
  the millisecond, across at least two gaps. A person cannot produce that twice in a row and a
  `setInterval` produces nothing else. Exact equality rather than a tolerance, because a tolerance in
  milliseconds is a figure nobody has measured — and exactness is what makes the rule safe to fire alone.
- Everything else needs corroboration, and corroboration means two. Two is not tuned; it is the smallest
  number that is more than one, and the reason it cannot be one is `no_interaction`: a visitor who reads a
  page and leaves interacts with nothing, which is most of the genuine traffic on a brochure site. A
  one-rule verdict would filter real people out of the very denominator the flag exists to protect.
- Two gaps, not one, before "identical" means anything, because one gap is always identical to itself.

What this cannot see is stated in the module and repeated here, because the name has to stay honest: a
headless browser that sets a viewport, moves a pointer and varies its delays is indistinguishable from a
person, and no addition to the table would change that — the signals are all the client's to fabricate. So
the kind is `suspected_headless`, it is reported as a share rather than acted on, and the honest reading of
a low figure is "this heuristic found little", never "there was little".

## The general rule, and the phone it must not filter out

The obvious way to catch a crawler nobody has named is to search the user agent for `bot`, `spider` or
`crawler`. It is wrong, and the failure is invisible: `CUBOT` is a real Android phone brand, so a `/bot/i`
search removes every visitor holding one from the funnel, and a missing visitor leaves nothing behind to
notice.

So the general rule is about a **product token** rather than a substring: the token is split out of the
string, its version is dropped, and an all-capitals token is skipped — a device model is shouted
(`CUBOT_X30`, `SM-S918B`) and a crawler's product name is not (`SeznamBot`, `bingbot`). The committed
fixture carries a real CUBOT string as the control, and gate case 140h removes the carve-out and requires
that row to fail.

## Consequences

- A seventh AI crawler is one entry in one table plus one line in the pin, and two suites fail until a real
  user agent for it is committed to `packages/core/test/fixtures/user-agents.json`. That is the intended
  cost: an allowed crawler nobody has checked the classifier against is the defect this unit removes.
- `analytics.session.bot_kind` has a closed vocabulary in code and no CHECK constraint in the database, for
  ADR 0046's reason: a list in SQL and a union in TypeScript is two lists. `BOT_KINDS` is the one
  statement, and the classifier's return type makes a row the database's `bot_kind_implies_bot` CHECK would
  refuse unrepresentable before the INSERT.
- The crawler names may not appear in code outside the two declared files. A future consumer reads
  `AI_CRAWLER_USER_AGENTS`, `AI_CRAWLER_FETCHERS` or `AI_CRAWLER_BOT_KINDS` from `@berelax/shared`.
- `Google-Extended` is allowed and unclassifiable, and the type makes that pairing the only representable
  one. It never fetches anything, so a `bot_kind` for it would be a value no request could produce.
