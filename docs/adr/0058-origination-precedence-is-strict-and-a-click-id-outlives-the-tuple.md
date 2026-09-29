# ADR 0058 — origination precedence is strict, a click id is kept whatever wins, and the registrable domain comes from a declared table rather than the Public Suffix List

- **Status:** accepted
- **Date:** 2026-09-29
- **Unit:** A-FIRST-03
- **Covers:** docs/01 decisions — none; this is the mechanism under ADR 0018 (a first-party event store is
  the source of truth) and it fills in the `analytics.attribution` and `analytics.session.click_ids`
  columns ADR 0045's schema created. It stands beside ADR 0046, which is the taxonomy half of the same
  measurement plan.

## Decision

Four things.

1. **The precedence is strict, total and stated once.** docs/03 §6's order — UTM → click id (`gclid`,
   `fbclid`, `wbraid`, `msclkid`) → referrer → direct — is implemented as four exclusive branches in
   `resolveOrigination` (`packages/core/src/analytics/origination.ts`). Exactly one basis wins, the losers
   contribute nothing to the tuple, and the basis is stored beside the answer in
   `analytics.attribution.basis`.

2. **A click id is persisted whatever won the origination**, verbatim, capped at 512 characters, and never
   case-folded or trimmed.

3. **A referrer that is one of our own hosts yields `no_new_origination`, not `direct`.**

4. **The registrable domain of a referrer is computed from a declared, bounded multi-label public-suffix
   table with a last-two-labels fallback.** It is not the Public Suffix List, and the module says so.

## Why a UTM set outranks a click id, and why the click id survives anyway

These look like one question and they are two. "Where did this session come from" and "which ad click was
this" have different answers and different readers.

A UTM set wins the first question because a human wrote it. Somebody chose `utm_source=newsletter` when
they built the link, and a resolver that overrode that with `gclid` → `google/cpc` would be telling the
person who tagged the campaign that they were wrong about their own campaign. It is also the only basis
that can carry a campaign, a term and content at all; the other three infer two dimensions and leave three
blank.

The click id answers the second question and nothing else can. docs/03 §6: click ids "are what permits
reconciliation with the ad platforms later, so they are stored even though nothing reads them yet". The
tempting implementation resolves the basis first and then keeps only what that basis used — which is a
single line shorter and throws away the only join key back to Google Ads. The loss would be invisible: the
tuple looks right, every dashboard looks right, and the gap appears the first time somebody tries to
reconcile spend, by which point the 90-day raw retention (ADR 0045) has removed the sessions. So
`resolveOrigination` returns the click ids **outside** the decision union, where no branch can drop them,
and `origination.test.ts`'s property asserts the reported set equals the set present in the query on every
generated case rather than only on the precedence rows.

A click id is stored **verbatim**: not trimmed, not lower-cased. It is an opaque token the platform issued,
`Cj0KCQ` and `cj0kcq` are different ids, and the one that reconciles is the one that arrived. An id longer
than 512 characters is **truncated rather than dropped**, and that is the deliberate one of the two: the
parameter's presence is evidence of a paid click whatever its value, so dropping it would reclassify a paid
session as organic. A truncated id is visible to whoever attempts the reconciliation; a reclassified
session is visible to nobody.

## Why an own-host referrer is not `direct`

Origination is resolved once per session. A visitor who reached the landing page from one of our own pages
was originated by whatever brought them to *that* page, and the only honest answer at this point is "this
signal says nothing new". Writing `direct` would overwrite a real origination with the absence of one, and
because `direct` is a legitimate answer nothing downstream could tell the two apart.

So the decision is a union — `{ kind: 'origination' }` or `{ kind: 'no_new_origination', why }` — for the
reason `FunnelOutcome`'s `no_step` carries a `why` (ADR 0046): a reader looking at a gap needs to know
which kind of gap it is, and a writer needs a value to branch on rather than a `null` to interpret.

The own-host test stops at a **label boundary**. `host.endsWith(own)` is the obvious spelling and it is
exploitable: it makes `notberelaxmassage.com` and `berelaxmassage.com.evil.test` our own hosts, so an
attacker-chosen domain could suppress a session's origination by referring to us from it. Both are asserted
external.

## Why the registrable domain is a declared table and not the Public Suffix List

A referral's `source` is the registrable domain, so that every page of a referring site groups into one row
— `l.instagram.com` and `www.instagram.com` are both `instagram.com`. Computing that correctly in general
requires the Public Suffix List: roughly 13,000 entries, distributed as a file, with its own update cadence.

`packages/core` may not read a file, fetch a URL or read the environment (ADR 0001, `pnpm purity`). So the
PSL could only arrive as a 13,000-entry literal inside a pure package — a dataset that is stale the day it
is committed and that nothing in this build has a mechanism to refresh — or by moving the registrable-domain
answer out of `core`, away from the only caller and into a package that would have to be consulted from a
pure resolver.

The alternative was rejected because of what a miss actually costs, and the cost is narrow enough to state
exactly: a suffix the table does not know makes the referral group one label too broadly, `foo.co.zz` →
`co.zz`. It never changes **whether** a session is attributed, never changes the basis, and never touches a
UTM or click-id answer — which is where every paid figure and every reconciliation comes from. It is a
reporting-granularity error confined to organic referrals from countries the table does not cover.

So `MULTI_LABEL_PUBLIC_SUFFIXES` covers the market this business sells in (the GCC), the English-speaking
markets its referrers sit in, and the majors, with a last-two-labels fallback that is correct for `.com`,
`.ae` and every other single-label suffix. The table is declared rather than inferred, sorted so a reader
can see what is and is not in it, and `origination.test.ts` asserts the fallback's wrong answer on
`example.co.zz` so the limitation is a committed assertion rather than a sentence in a comment.

## Why the basis vocabulary is checked across three files rather than derived from one

`'utm' | 'click_id' | 'referrer' | 'direct'` is written in three places and cannot be written in one.
Migrations are hand-written SQL (ADR 0006), so `attribution_basis_known` in
`packages/db/migrations/0096_analytics_schema.sql` holds the words literally; its Drizzle mirror holds them
again, because `pnpm db:drift` compares the two and a mirror that derived them from elsewhere would no
longer be a mirror; and `packages/db` may never import `packages/core` (ADR 0001), so this resolver's
`ORIGINATION_BASES` cannot be the source either of them reads.

Three statements with nothing holding them equal is how a vocabulary drifts, and the symptom would be a
`23514` check violation from A-FIRST-05's INSERT naming a constraint rather than the rename that caused it.
Gate case 136u therefore reads all three files and requires the same four words in each, with a known-bad
fixture that renames one basis in the resolver and asserts the case fails (ADR 0003). That is the same trade
`FUNNEL_EXCLUSION_REASONS` makes against `TERMINAL_APPOINTMENT_STATUSES` in ADR 0046: where the derivation
cannot be expressed, it is asserted.

## Why there is no instant

`resolveOrigination` takes no clock and no instant, which is stricter than `pnpm purity` requires — the gate
bans *reading* the clock, and an injected instant is legitimate everywhere in `core` except the scoped
directories. Where a session came from is a function of its query string, its referrer and which hosts are
ours. `analytics.attribution.resolved_at` is the **writer's** instant and A-FIRST-05 stamps it; a
`resolvedAt` parameter here would be one this code never reads, and the next person to see it would
reasonably assume something depended on it.

## Consequences

- **A fifth click id is a committed diff, not configuration.** `analytics.session.click_ids` is `jsonb` so
  the database needs no migration (A-FIRST-01's comment says as much), but `CLICK_ID_ORIGINATION` is a
  `Record` over the tuple with no default branch, so a fifth parameter fails `pnpm typecheck` until
  somebody decides its source and medium. An unknown platform silently attributed to `direct` is the
  failure that prevents.
- **A UTM set with no `utm_medium` resolves to the medium `unset`.** `''` is refused by
  `attribution_medium_not_blank`; `'none'` is the *direct* medium, so it would fold a real tagged source
  into untagged traffic in every report cut on (source, medium); `'(not set)'` is the parenthesised
  spelling migration 0096's comment names as the confusion to avoid. `unset` is a word about the tag.
- **`utm_source` and `utm_medium` are lower-cased and `utm_campaign`, `utm_term` and `utm_content` are
  not.** The first two are dimensions every report groups on, so `'  Google '` and `'google'` must collapse.
  The last three are labels somebody typed, and lower-casing `Eid_Offer_2026` makes the analytics row stop
  matching the campaign name in the ad platform. All five are trimmed, because a trailing space in a
  rollup's primary-key dimension is a second row for one campaign.
- **Changing any normalisation, the precedence, the click-id list or the suffix table means bumping
  `ORIGINATION_RESOLVER_VERSION`**, which is stored on every `analytics.attribution` row. A corrected
  resolver gives a different answer for the same session, and a row that did not say which version decided
  it would make the two indistinguishable.
- **Nothing here erases.** `analytics.session.click_ids` holds a pseudonymous ad-click identifier and is
  reached by none of C-CRM-10's five erasure probes, because the `analytics` schema holds no customer or
  contact reference at all — A-FIRST-01's decision, asserted from both ends by
  `packages/fixtures/src/analytics-privacy.itest.ts`. That remains true only while it remains true: the unit
  that puts a `customer_id` anywhere near this data is A-FIRST-08, and classifying the analytics store under
  ADR 0034 is its obligation, not a thing a pure resolver can discharge.
