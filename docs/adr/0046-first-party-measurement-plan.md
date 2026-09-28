# ADR 0046 — the measurement plan is code: one closed taxonomy, one funnel vocabulary, and a funnel bucketed on business_day

- **Status:** accepted
- **Date:** 2026-09-28
- **Unit:** A-FIRST-02
- **Covers:** docs/01 decisions — none; this is the mechanism under ADR 0018 (a first-party event store is
  the source of truth) and it stands on ADR 0007 (business day first-class) and ADR 0021 (a service is
  style × treatment)

## Decision

Four things, and three of them are a refusal to hold a fact in two places.

1. **The event taxonomy is closed, versioned, and every name carries a Zod schema.** Five collected
   events — `page_view`, `service_viewed`, `price_viewed`, `cta_click`, `whatsapp_ref_shown` — in
   `packages/shared/src/analytics/taxonomy.ts`, with `ANALYTICS_TAXONOMY_VERSION` stamped on the row. A
   name the registry does not hold is refused at runtime with a named `UnknownEventError` and does not
   typecheck at the call site.

2. **The funnel vocabulary has exactly one statement, and everything about the order is derived from it.**
   `FUNNEL_STAGES` is a tuple; `FunnelStage` is derived from it, `FUNNEL_TERMINAL_STAGE` is its last
   element, `funnelStageRank` is its index and `funnelStagesAfter` is a slice. There is no second list and
   no constant spelling `'paid'`.

3. **The mapping from domain facts to stages is a table keyed on the lifecycle's own union.**
   `APPOINTMENT_STATUS_FUNNEL` in `packages/core/src/analytics/funnel.ts` is a
   `Record<AppointmentStatus, FunnelOutcome>`, and the exclusion reasons are the terminal appointment
   statuses with `completed` removed. `appointment.completed` → `attended`, a document settled in full →
   `paid`, `no_show` → no stage with `excluded_reason = 'no_show'`.

4. **A funnel step is bucketed on `business_day`, and an instant that belongs to no trading date says so
   rather than being given the calendar date.**

## Why the vocabulary is in `packages/shared` and not in `packages/core`

It is the mapping's natural home, and it cannot live there. `packages/db` holds the `analytics` schema
(A-FIRST-01) whose `funnel_step.stage` and `funnel_step.excluded_reason` are these exact words, and `db`
must never import `core` (ADR 0001, `db-must-not-import-core`). Seven units read this vocabulary and no two
of them may import each other. `shared` is the only package all of them may depend on.

The cost of the move is that the vocabulary left the tree `pnpm purity` and `core-must-be-pure` protect —
so the code with the strictest purity requirement in the unit briefly had no gate about it at all. Both
gates were widened rather than the claim being softened: `scripts/check-core-purity.mjs` reads
`packages/shared/src/analytics` as its one root outside `packages/core` (and bans `Date` and `Intl` there
outright, the scoped treatment the ledger and the till already get), and
`analytics-taxonomy-must-be-pure` in `.dependency-cruiser.cjs` closes the import path to I/O that
`shared-must-not-import-siblings` never covered.

It also cost one structural change: `AppError` moved from `packages/shared/src/index.ts` into
`packages/shared/src/app-error.ts`. `UnknownEventError` has to be a subclass — `isAppError` is
`instanceof AppError`, so a refusal raised as a plain `Error` reaches a visitor as a 500 instead of the 422
it is — and a submodule importing the barrel that re-exports it closes a cycle `no-circular` refuses. The
barrel re-exports all three names, so no consumer changed.

## Why the exclusion reasons are the terminal statuses, minus `completed`

The tempting design is a short hand-written list: `['no_show']`, because that is the one the acceptance
line names. It would work until the first cancelled booking, which would then sit at `confirmed` for ever
and read as a journey still in flight.

So the set is stated as a derivation and asserted as one: `FUNNEL_EXCLUSION_REASONS` equals
`TERMINAL_APPOINTMENT_STATUSES` with `completed` removed, because `completed` is the single terminal state
that *advances* the funnel (to `attended`). `packages/core/src/analytics/funnel.test.ts` holds the two
equal in both directions — it is the one file in the build that can see the vocabulary in `shared` and the
lifecycle table in `core` at once — and a tenth appointment status fails `pnpm typecheck` naming
`funnel.ts`, because the mapping is a `Record` over the union with no `default` branch.

This is the ADR 0002 shape stated positively: the claim "the funnel knows every way a journey can end" is
measured by a set equality against the state machine, not by a reviewer having read both lists.

## Why `paid` is terminal and `booking_created` is not

docs/03 §6: "roughly 5–15% of bookings do not turn up, so any funnel ending at 'booking created'
overstates itself and any ad platform optimising on that signal is optimising for no-shows too." A funnel
whose last stage is a promise reports intent and calls it business, and the push to GA4 and Meta then
trains on it.

Nothing follows `paid`, and a refund is deliberately not a ninth stage. A refund is a correction to a
document (ADR 0017, M-TILL-08's credit note), and a ninth stage would require the funnel to *un-count* a
conversion that has already been pushed — which no ad platform and no rollup can do honestly.

A partial payment is not `paid`. `payment.recorded` fires for a deposit too, so the signal carries
`settlesDocumentInFull`, computed once by `settleTenders` (`packages/core/src/money/tender.ts`) and never
re-derived from figures here: a second answer to "is this invoice paid" first shows up as a funnel that
converts on a deposit.

## Why the funnel refuses to date an instant in the daytime gap

Trading runs 11:00–02:00 Asia/Dubai, so a treatment paid for at 01:30 on the 3rd belongs to the **2nd's**
business day. A daily funnel cut on the calendar date splits every night's takings across two rows and
disagrees with cash-up, the rota and the journal, all of which cut on `business_day` (ADR 0007).
`funnelBucketFor` therefore resolves through `resolveTradingDate`, with the instant, the hours and the zone
all arguments.

Between 02:00 and 11:00 the premises is shut and web traffic does not stop, so a funnel step can exist for
an instant that belongs to no trading date. `FunnelBucket` is a union: a trading date, or the named
`OutsideTradingReason` plus the calendar date the instant fell on — and that shape carries no
`tradingDate` field at all, so the calendar date cannot be used as one by accident. **Which** trading date
the gap should roll into is a business decision nobody has made, recorded as `Y5-funnel-gap-bucket` in
docs/OPEN-QUESTIONS.md and named by `ANALYTICS_OPEN_QUESTIONS.gapBucket`. Inventing an answer here would
put morning traffic on a day whose session had not begun, with nothing distinguishing it from a day
somebody decided (brief rule 15).

The step is still produced. Dropping the event would have been the other wrong answer: it makes an
unbucketable hit indistinguishable from no hit, which is the failure ADR 0018 records about ref-capture
rate one layer up.

## Consequences

- Adding, removing or renaming a collected event is a committed diff in three places that must agree, and
  `tsc` enforces two of them: the name tuple, the schema registry (`satisfies Record<AnalyticsEventName,
  ZodType>`) and `COLLECTED_EVENT_FUNNEL` (a `Record` over the same union). The third is the literal list
  in `taxonomy.test.ts`, which exists only so the change appears in review.
- A ninth funnel stage requires a decision about what produces it: `REACHABLE_FUNNEL_STAGES` is derived
  from the mapping and asserted equal to `FUNNEL_STAGES`, so a stage nothing maps to fails the build
  rather than becoming a bucket that is empty for ever.
- `packages/shared/src/analytics` is now purity-gated. A future module there may not read a clock, a
  locale or the environment, and may not import Node builtins or a framework.
- The taxonomy validates a payload and nothing else. Visitor id, session id and the instant are columns
  A-FIRST-01 owns; origination and click ids are resolved once per session by A-FIRST-03 and are
  deliberately absent from every event payload, which is also why a collected path carries no query
  string.
