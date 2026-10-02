# ADR 0076 — one consent gate, asked in two places, and enforced by the database

- **Status:** accepted
- **Date:** 2026-10-02
- **Unit:** A-MEAS-02
- **Covers:** docs/01 decisions — none. Decisions 14, 24 and 25 are recorded in ADR 0018, and this is a
  mechanism under it, beside ADR 0045 (the analytics schema and its retention), ADR 0059 (the opaque
  category code and the whole-payload argument) and ADR 0066 (pre-consent collection as a projection, and
  the position this gate is the enforcement of).

## Context

A-MEAS-02's title has two halves — *"Consent Mode v2 gating client tags and server pushes"* — and the
obvious way to build it is two gates: one in the tag loader, one in the dispatch writer. That is the
decision this record exists to refuse, and the reason is not symmetry.

**A second statement of a fact drifts, and this one drifts silently.** The day a conversions API starts
needing a signal that an on-page pixel does not, one of two gates is edited and the other is not. Nothing
errors. The symptom is an outbound push that happens while the on-page tag correctly refuses, for a visitor
who said no — and the only evidence is in somebody else's advertising account, weeks later, with no commit
to point at.

Three further things about this gate make a convention insufficient:

**It must fail closed, and the ways it can fail open are one character wide.** `=== true` relaxed to a
truthiness test reads the string `'f'` — which is what a boolean column comes back as under one of the
query shapes in this stack — as consent. `cardinality(missing) = 0` written `array_length(missing, 1) > 0`
is NULL for the permitted case, and a `case` whose condition is NULL falls to its `else`, which in the
writer is the permitted branch. `default false` on a session's consent column written `default true`
applies cleanly, passes every test, and permits a push for every session created by a writer that had not
heard of consent.

**`packages/db` may not ask the pure gate.** ADR 0001 forbids `packages/db` importing `packages/core`,
and the dispatch writer is in `packages/db`. So the decision cannot literally be one function call in both
places: either the writer re-implements the comparison, or the comparison lives somewhere both can reach.

**A suppression must be visible.** A dispatch that does not go out because consent is absent has to leave a
row saying so. Dropping it silently makes "we respect consent" indistinguishable from "the dispatcher has
been broken for a fortnight".

## Decision

**One table of gated targets, one comparison per layer, and the gate is in the database as well as in the
code.**

1. **`CONSENT_GATED_TARGETS` in `packages/core/src/analytics/consent-gate.ts` is the one statement of which
   target needs which signal**, and `gateConsent` is the one function that answers. The two surfaces — a
   client tag and a server dispatch — differ only in where the STATE comes from: the `berelax_consent`
   cookie in the browser, and four boolean columns on `analytics.session` for a dispatch, because a
   dispatch is enqueued by a booking or a payment where there is no cookie to read.

2. **The mapping from target to signal is this build's decision, stated here.** An analytics tag or push
   measures use, so it is gated on `analytics_storage`. An on-page advertising tag both writes advertising
   storage in the browser and passes what it observes to an advertising service, so it needs `ad_storage`
   and `ad_user_data`. A server-side advertising push sets nothing in any browser, so `ad_storage` does not
   describe it: what it does is send the visitor's own data to an advertising service, which is
   `ad_user_data`. `ad_personalization` is captured on every record and forwarded, and gates nothing here,
   because whether data may personalise advertising is a decision the receiving platform makes.

3. **The comparison inside the database is stated ONCE, as a function.**
   `dispatch_consent_gap(session, destination)` returns the required signals a session has not granted.
   The ZY312 trigger calls it to refuse a row reaching `queued` or `sent`; `enqueueAnalyticsDispatch` calls
   it to choose between a `queued` row and the visible `suppressed` row. The state the writer chooses and
   the state the trigger permits therefore cannot disagree, and there is no window in which consent could
   change between a decision and a write.

4. **The two statements that unavoidably exist are held equal in both directions, in the same commit.**
   `CONSENT_GATED_TARGETS` in core and `analytics_dispatch_destination` in the database are compared by
   `packages/fixtures/src/analytics-consent.itest.ts` — the only package that may hold both — and by
   `packages/fixtures/src/consent-gate-arch.test.ts` against the migration's text, which fails before a
   migration has been applied anywhere.

5. **Absent, unreadable and denied are one answer, and that answer is deny.** No record, an empty record,
   a signal name nobody defined, a boolean column that arrived as a string: all resolve to the empty state,
   and the empty state permits nothing. Every session consent column is `not null default false`.

6. **The gate is code, not configuration.** No setting key, no feature flag and no environment variable
   appears anywhere in the gate's estate, and the arch test enumerates every key the settings registry
   holds and every variable the environment schema declares — at runtime, so a key composed from a
   constant is counted — and asserts that none of them appears in it. The one allowance is `DATABASE_URL`
   in the route's wiring module, which says where the records live and nothing about whether consent is
   required, and the allowance is asserted to have been used.

7. **The consent RECORD holds no identifier at all.** ADR 0066 creates `analytics.visitor` at consent,
   inside `ingestCollectBatch`, which is the one place the server decides who owns an identifier — so at
   the instant the banner is answered there is no visitor row, and minting one in the consent endpoint
   would be a second identifier-minting site.

## Alternatives rejected

**Two gates, one per surface.** The shape everything above exists to prevent. Its failure is silent and
asymmetric, and no test written against either gate alone can see it.

**A nullable `visitor_id` on the consent record.** It would be NULL for the common case — a first grant,
where no visitor exists yet — so the column would be mostly empty and therefore mostly useless, while
costing a foreign key into a table the retention pass purges every 90 days. An append-only log with a
foreign key to a purged parent is the contradiction 0024 and 0056 both refuse: the parent's DELETE either
fails or rewrites history.

**A `case` over signal names inside the trigger** instead of the requirement table. A `case` with no `else`
yields NULL for an unlisted name, `not NULL` is NULL, and a trigger whose condition is NULL lets the row
through — which is the fail-open the fifth signal Google adds would reach. A table also reads back, so it
can be held equal to the pure one; a `case` cannot.

**A setting to turn the gate off in staging.** The thing somebody asks for in week three. There is no such
setting and the arch test is what keeps it that way: a gate whose answer can come from a settings page is a
gate whose answer is whatever an admin last saved.

**Dropping a refused dispatch silently.** Cheaper, and it makes the one question anybody asks — "did we
send anything we should not have" — unanswerable. The suppression is a row.

**Reading the consent decision out of the banner's own inline script.** The script sets a `data-consent`
attribute so the CSS can hide the banner before first paint, and it deliberately does NOT decide whether
anything may load: that is `mayLoadClientTag`'s answer over the cookie. An attribute a page can set is a
second authority, and a tag loader reading it would be the second gate under another name.

## Consequences

**A new destination is three edits and a test tells you if you forget one.** A member of
`CONSENT_GATED_TARGETS`, a row in `analytics_dispatch_destination`, and a migration. Miss the row and the
foreign key refuses the dispatch; miss the member and the pair suite fails naming the destination.

**A withdrawal is airtight and that costs an UPDATE on the session.** `withdrawAnalyticsConsent` cancels
every `queued` dispatch for the visitor's sessions and then clears those sessions' four consent columns, in
that order — the order matters, because the trigger reads `NEW.state` and a cancellation is reached from
`queued`. Afterwards no row can reach `queued` or `sent` for any of those sessions, from any caller in any
role, so a cancelled dispatch cannot be reinstated and transmitted.

**Nothing says which visitor made which consent decision.** The price of point 7, stated rather than
implied: the record answers how many grants, denials and withdrawals happened, under which wording version,
at which instants — which is what distinguishes a deliberate denial from a banner nobody answered, and what
A-FIRST-10 publishes as a data-quality figure — and it cannot answer "show me my consent record". What
removes a visitor's analytics data is TIME, exactly as `analytics-privacy.itest.ts` already records.

**The banner's words are committed in `@berelax/shared` and in the migration, and the hash is what holds
them together.** `/` and `/ar` are prerendered, so a build-time database read would either fail the build
on a machine with no database or bake whatever that machine held. So the words are written twice — and
`recordAnalyticsConsent` resolves the wording row BY THE HASH of the constant's bytes, so a tree whose copy
was edited without a new version being published cannot find a row and every write is refused by name
rather than recorded against words nobody read.

**The banner ships no client JavaScript module, and must not start.** `build/budgets.json` caps the client
JS every route ships at 4096 bytes and names the two modules allowed in it; a `'use client'` banner on every
public page is exactly what that budget exists to notice. More importantly, a banner that hydrates decides
after the first paint and after whatever the page has already begun fetching — so the decision is an inline
blocking script, for the same reason the theme's is, and here lateness would cost a REQUEST rather than a
frame.

**A-MEAS-03 inherits a table it did not create.** `analytics_dispatch` and
`analytics_dispatch_destination` land with this unit because the gate's acceptance lines name their states
and their reason column. What this unit deliberately did NOT add is the transport: no `event_id`, no
payload, no attempt counter, no per-destination idempotency index — a column with no producer is
indistinguishable from a column whose producer stopped working, which is the reason A-MEAS-01 gives for
keeping the shared `event_id` out of its own allowlist.
