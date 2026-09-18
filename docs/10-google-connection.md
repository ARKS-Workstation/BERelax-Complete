# The Google Connection

One owner-consented OAuth connection powering the review autoresponder, the SEO agent and the
GBP-versus-website consistency check.

Items marked **[UNVERIFIED]** must be confirmed before or during the build; §8 lists them with their
blocker status. Google's Business Profile programmes are poorly documented and change, so this document
is deliberately explicit about what is known versus assumed.

---

## 1. The five facts that shape everything

**1. OAuth is not the hard part.** Business Profile API access is gated at the **Google Cloud project**
level by an application form — *Application for Basic API Access* at
`support.google.com/business/contact/api_default`. Until approved, project quota sits at **0 QPM** and
every GBP call fails regardless of how valid the token is. Approval is observable as quota moving
**0 → 300 QPM** in the Cloud console. Prerequisites per Google's own page: the profile **verified and
active 60+ days**, a **website representing the business** listed on the profile, submitted from an
account that is an **owner or manager** of the listing, plus the Cloud project number.
**[UNVERIFIED]** review timeline — practitioner reports cluster around 7–10 business days but range from
days to ~6 weeks.

**2. Search Console is not gated that way.** It needs only the API enabled and the consenting account to
have property access. **The SEO agent can therefore be fully functional on launch day while GBP access
is pending.** That asymmetry should drive launch sequencing.

**3. An OAuth app left in Testing issues refresh tokens that expire in 7 days.** Both agents run on a
weekly-ish cadence, so the failure presents as *"it worked when we tested it and stopped the following
week"*, repeatedly, with no correlated deploy. `business.manage` is a **Sensitive** scope, so moving to
Production raises app verification. §3 resolves this.

**4. Review replies are on a legacy API.** Every other capability has migrated to the `v1` services;
Reviews is the conspicuous remainder on `mybusiness.googleapis.com/v4`. **This is the highest-risk
dependency in the plan.** Isolate it behind a single adapter module so a migration is a day, not a month.

**5. An operating business's listing may not be owned by the owner.** It is frequently held by whoever
set it up — often a former marketing agency or a departed staff member. **Establishing which Google
account currently owns this listing, and at what role, is the very first task.** No code substitutes for
it, and Google's recovery process for a listing claimed by someone else is slow, evidence-based and not
guaranteed.

---

## 2. Schema — one connection, but not a singleton

The brief assumes one grant. Model **one-to-many**, because of a case that is common in operating
businesses: **the account that owns the GBP listing is frequently not the account verified on the Search
Console property.** GBP was claimed on one Gmail, the site was built by someone else. A singleton row
discovers this on launch day and forces a reshape.

```
google_connections
  id                 uuid pk
  google_sub         text not null    -- stable subject from id_token: the identity key
  google_email       text not null    -- display only; can change
  granted_scopes     text[] not null  -- what Google returned, not what we asked for
  refresh_token_ct   bytea not null   -- envelope-encrypted
  refresh_token_kid  text not null    -- DEK version, so rotation is a re-wrap job
  access_token_ct    bytea            -- cached, encrypted (an hour of full authority)
  access_expires_at  timestamptz
  status             text             -- active | needs_reauth | revoked | disconnected
  status_reason      text             -- invalid_grant | scope_removed | manual | ...
  last_ok_at         timestamptz      -- last successful authenticated call
  last_checked_at    timestamptz
  created_by         uuid
google_capabilities
  connection_id      uuid fk
  capability         text  -- gbp_reviews | gbp_location | gbp_performance | gsc
  resource_ref       jsonb -- {account, location, placeId} | {siteUrl}
  verified_at        timestamptz
  primary            boolean
google_connection_events   -- append-only, mirrored into the global audit log
```

**`google_sub` is the identity key, never the email.** On reconnect: matching `sub` is a re-auth of the
same connection (preserve capabilities and history); a different `sub` is a **new grant** — warn loudly,
because silently swapping the connected account is how replies get posted to the wrong listing.

Consumers never touch tokens. They call `withGoogle(capability, fn)`, which resolves the connection and
resource, obtains a fresh token under lock, injects a correlation id, and classifies every error. One
chokepoint is what makes observability and graceful degradation possible; three ad-hoc `fetch` calls make
both impossible.

```ts
const CONSUMERS = {
  reviewAutoresponder: { capability: 'gbp_reviews',  scopes: ['…/business.manage'],      degradesTo: 'draft_only' },
  seoAgent:            { capability: 'gsc',          scopes: ['…/webmasters.readonly'],  degradesTo: 'disabled' },
  localSeoChecker:     { capability: 'gbp_location', scopes: ['…/business.manage'],      degradesTo: 'manual_snapshot' },
}
```

---

## 3. Scopes, and the publishing-status decision

**Request two scopes up front**, in the single consent the owner performs during handover:

- `https://www.googleapis.com/auth/business.manage` — the **only** scope for every Business Profile API.
  There is no read-only variant. **The scope that reads reviews also rewrites your address and hours.**
  That is the single biggest security fact of this integration. Classified **Sensitive**.
- `https://www.googleapis.com/auth/webmasters.readonly` — Search Console read. Do **not** request the
  read/write `webmasters` scope; sitemap submission is a one-time manual action in the GSC UI.

Consent-screen minimalism arguments apply to consumer SaaS with thousands of self-serve signups. Here
there is **one user, once, during a scheduled onboarding call**. Optimise for "one flow, done, verified".

### The Testing / Production / Internal decision

| Option | Consequence |
|---|---|
| **A.** External + Production + verified | Correct and unrestricted, but `business.manage` is Sensitive so you enter Google's Verification Center: scope justification, demo video, privacy policy on a verified domain, domain ownership proof. **[UNVERIFIED]** duration — plan weeks, and it can round-trip |
| **B.** External + Production + unverified | Owner sees a "Google hasn't verified this app" interstitial once. The 100-new-user cap is irrelevant at one user. Cheapest safe path **if** the 7-day expiry is genuinely lifted by Production alone |
| **C.** **Internal audience inside a Google Workspace org** | **Recommended.** Not subject to external verification, not user-capped, no interstitial |

**Recommendation: buy one Google Workspace seat on the business domain.** A few dollars a month, and it
solves three problems with one purchase: a business-controlled identity, a Cloud project inside a
Workspace organisation so the OAuth audience can be **Internal**, and a business email identity for every
other vendor. It is the cheapest high-leverage decision in this document.

**What must not happen is shipping with the audience left at External/Testing** — which is the default
state of every Cloud project, and therefore the result of not deciding.

---

## 4. Token lifecycle

**Storage.** The refresh token is a durable bearer credential for control of the business's Google
presence — the second-most-valuable secret in the system after the clinical DEK. Envelope-encrypted with
a per-row data key wrapped by the app KEK, plus `refresh_token_kid` so rotation is a background re-wrap
rather than a forced re-consent. It never appears in an env var, a rendering CMS field, a **pg-boss job
payload** (those are rows and reach query logs and `pg_stat_statements`), a log line at any level, an
error message, a Sentry breadcrumb, or an unencrypted backup. A CI lint rule fails the build on any
template literal containing the token variable.

**Refresh** proactively when expiry is under 5 minutes away — never reactively on 401, which wastes a
round trip per cron cycle and pollutes the error taxonomy with noise.

**Concurrency.** pg-boss can start the review poll, the SEO crawl and the health check in the same second
on different workers, all seeing a stale token. Serialise with a Postgres advisory transaction lock and
double-checked locking:

```sql
select pg_advisory_xact_lock(hashtextextended('google:'||$1, 0));
-- re-read the row inside the lock; the winner has already refreshed
```

Released at commit. No Redis, no lease expiry, no distributed-lock correctness argument. Google normally
returns the *same* refresh token on refresh, but persist a new one if it ever appears — silently
discarding a rotated token is a time bomb.

### Every cause of invalidation

| Cause | Reality |
|---|---|
| **Testing publishing status** | 7 days after consent. **The launch blocker** |
| Owner revokes at `myaccount.google.com/permissions` | Immediate `invalid_grant`. Often done while tidying unfamiliar app names — a recognisable app name and logo materially reduce this |
| Six months unused | Auto-invalidated. The **daily** health check makes this structurally impossible |
| Password change | **Probably not a risk for us.** Google ties password-reset revocation to refresh tokens carrying *Gmail* scopes, which ours do not. Flagged as likely-overstated rather than repeated, because arguing from a risk that never materialises costs credibility on the risks that do |
| ~100 live refresh tokens per account per client | Exceeding it silently invalidates the **oldest**. A non-issue with one production owner; a real issue when a developer re-consents fifty times against the **production** client ID. **Separate client IDs per environment, enforced** |
| Scope change on re-consent | Replace the stored token atomically in the same transaction as the capability update |
| Workspace admin marks a service Restricted | Surfaces as `admin_policy_enforced` at authorisation, before any token exists |

### Detection and recovery

A pg-boss cron `google-connection-health` **daily at 03:00 Asia/Dubai**, plus an on-demand *Test
connection* button. Per connection it forces a refresh, runs one cheap read per granted capability, diffs
granted scopes against required, **re-resolves the stored `placeId` and compares title and address
against what the owner confirmed** (catching a listing that was merged, moved between accounts, or edited
by Google), reads Voice of Merchant, and writes `last_ok_at` and per-capability health.

A tripwire: if the app is in Testing, compute `consent_at + 7 days` and **display that expiry date in
settings** — surfacing the bomb rather than waiting for it.

States shown in plain English, never scope strings: *Connected* **with a "last verified 2 hours ago"
timestamp** — "Connected" with no recency is exactly how silent failure hides · *Connected, Business
Profile access pending Google approval* (amber, with submission date and a link to the Cloud quota page
where 0→300 is visible) · *Needs re-authorising* (red, one button, preserves the location selection on
matching `sub`) · *Permission missing* (naming the capability in English) · *Listing not verified with
Google* · *Disconnected*.

**Notify before the stop, not after.** Predictive email at T-48h when a Testing expiry is computable or
`last_ok_at` exceeds 48 hours. Reactive email on the **first** `invalid_grant`, deduped to one per
incident — never one per failed job. The Resend template says what stopped, what still works, one link,
and what happens if they do nothing: *"review replies will keep being drafted for you to post by hand;
nothing is lost."*

**Degrade, do not throw.** `withGoogle` converts `GoogleReauthRequired` and `AccessNotGranted` into the
consumer's declared degraded mode. And the rule that makes this real: **a pg-boss job failure is not
sufficient evidence of failure, because nobody reads `pgboss.job`.** Every Google failure affecting a
capability must also write a row the owner's dashboard renders.

---

## 5. Identity: whose account

**Recommendation: a dedicated business account** (`google-admin@berelax.ae`, ideally a Workspace seat)
that is a GBP **Owner**, with the proprietor as **Manager**.

**How GBP roles work**, because the recommendation depends on it: exactly one **Primary Owner**, plus
**Owners** (can add and remove users) and **Managers** (can edit information and reply to reviews, cannot
remove users or delete the listing). Transferring Primary Ownership requires the recipient to already be
an Owner or Manager, and Google imposes a waiting period before promotion — **[UNVERIFIED]**, historically
seven days. **That waiting period is why the ownership restructuring happens in the same week you submit
the API application, not on launch weekend.**

**What actually goes wrong with a personal Gmail**, ranked by real likelihood:

1. **Offboarding.** The proprietor sells, or the person who claimed the listing was a contractor who left.
   For an operating business **this may already have happened.**
2. **Revocation by tidying.** The owner reviews their app permissions, does not recognise the app, removes it.
3. **Account recovery and 2FA loss.** A Workspace account has a super-admin who can reset it; a personal
   Gmail has only automated recovery, which can fail permanently.
4. Mixed personal/business audit trail — every GBP edit attributed to an individual.

**The framing that gets a yes.** The owner will want to use the Gmail already open in their browser, and a
lecture loses. Make it a fifteen-minute step in the onboarding call that you drive: you create the account
together; from their personal account (currently Owner) they add the business account as an Owner; the
OAuth connection uses the business account; **their personal account stays a Manager so nothing they do
day to day changes** — they can still reply from their phone, still edit hours, still get Google's emails.
*"You keep everything you have today, and the business gets a spare key"* is an easy yes.
*"Give up your account"* is a fight.

**Migration path** if they start personal — and assume they will, which the schema already tolerates:
create the business account → add as Owner → wait out the promotion period → transfer Primary Ownership,
demote personal to Manager → add as Verified Owner in Search Console **via DNS TXT on Cloudflare**, which
is domain-based and survives the loss of any personal account → reconnect in our admin (new `sub`, so a
new connection row) → verify capabilities against the same `placeId` → mark the old connection
`disconnected` and **call `POST https://oauth2.googleapis.com/revoke`** so the old token is dead rather
than orphaned in our database.

Approval is attached to the **Cloud project**, not the Google account, so switching identity should not
restart the clock — **[UNVERIFIED]**, and it matters, because if wrong you migrate *before* applying.

**Minimum safeguards if they insist on personal Gmail:** a second Owner on the listing regardless (spouse,
co-founder or accountant) so it survives losing one account · 2FA with a hardware key or printed recovery
codes in the business safe, not only SMS to one phone · recovery email and phone the business controls ·
Search Console verified by **DNS TXT** so SEO data survives entirely · a note in the settings panel naming
the connected account, visible to whoever runs the business next · the daily health check and pre-emptive
email, which turns *"the agents mysteriously stopped in March"* into *"we were told on the 3rd"*.

**Offboarding checklist** — in the runbook, not in someone's head: disconnect in admin (revokes at Google
and zeroises the stored token) · remove them as a GBP user, **transferring Primary Ownership first** since
the Primary Owner cannot be removed · remove from Search Console users · remove from the GA4 property ·
**remove from Google Cloud project IAM**, the one everybody forgets and the account that can change the
OAuth client and consent screen · rotate the client secret if they ever had it · audit the sequence.

---

## 6. The fallback is the launch mode

Not an error state. The access application takes an unverified number of weeks and the business launches
once. **A fallback designed as something you hope not to need is a fallback you never finish.**

### Detecting new reviews without API access — honestly

- **Polling: impossible.** There is no API.
- **Scraping Maps or Search: do not build it**, and do not leave it in the plan as an "if needed" option,
  because "if needed" is how it gets built at 11pm. It breaches Google's terms, breaks without warning,
  and puts the listing itself at risk.
- **Places API (New)** returns a small, non-exhaustive, Google-curated set of reviews and is separately
  billed. It is **not** a review feed. It is useful for exactly one thing: reading the aggregate rating and
  **review count**, so you can detect that the **count went up** even without seeing which review is new.
  That is the cheapest honest trigger available and worth building: a daily call, and on an increase, email
  *"you have 2 new reviews"* with a deep link built from the stored `placeId`. **[UNVERIFIED]** whether its
  terms permit caching review content — Places has historically been restrictive, so check before storing.
- **Google's own notification email is the real-world trigger.** Either the owner forwards it to an inbound
  Resend address and we parse reviewer and rating defensively (falling back to *"a review arrived, please
  paste it"* when Google changes the template), or a **Paste a review** form in admin, which always works
  and takes ninety seconds.
- **A Monday 09:00 nudge** with a direct link, if nothing has been reported. Low tech, and it turns an
  invisible task into a habit.

### The reply path is identical in both modes

Review record created (by API, email parse, paste or manual entry) → LLM drafts → **the same linter runs**
(no medical claims, no therapist named, no discount promise, never quote a reviewer's health disclosure
back at them publicly, length cap, tone, language match) → **mandatory human approval** → owner sees the
draft with *Copy reply* and a deep link → posts → clicks *Marked as posted*.

### The two data-model decisions that must be right on day one

1. **`google_review_id` is NULLABLE.** A manually entered review has none. When API access arrives, reconcile
   by reviewer name + rating + date and backfill.
2. **`delivery_mode` is a column, not an assumption**, so `submitted_at`/`confirmed_at` and
   `posted_manually_at` coexist rather than overloading a single `posted_at`.

Get either wrong and you are writing a migration in week three.

### How much value survives: 70–80%

The bottleneck was never the posting. The hard part is writing a good reply promptly and consistently in a
tone that does not create a compliance problem, for an owner with twenty other things to do — and that is
the LLM's job and the linter's job, both of which work fine. What is lost: **latency** (minutes via API
versus same-day manually), **completeness** (reviews the owner does not forward leave gaps, so any
average-rating-over-time chart is unreliable), the copy-paste step itself (~2 minutes, at 5–20 reviews a
month), and programmatic reply editing and deletion.

**70–80% of the value on launch day beats 100% at an unknown future date.** And switching to API mode is a
row in the capability table, not a deploy.

---

## 7. API notes worth knowing before writing a client

| API | Note |
|---|---|
| **Account Management** `v1` | `accounts.list` returns an empty list with **HTTP 200** when there genuinely are no profiles — do not confuse with a gating error. **LOCATION_GROUP accounts hold locations not returned under the PERSONAL account**, so enumerate under every account and dedupe by `placeId` |
| **Business Information** `v1` | `readMask` is **mandatory** on `locations.list`/`get`, `updateMask` on patch. Hours use structured `periods`; **Ramadan variations belong in `specialHours` and a naive write wipes them** — always read-modify-write with a narrow `updateMask`, never PATCH the whole object. Categories are opaque IDs resolved via `categories.list`; the massage/spa taxonomy is genuinely ambiguous and picking it is a judgement call. **Edits are capped at 10 per minute per profile and Google states this cannot be raised** |
| **Reviews** (legacy `v4`) | Highest-risk dependency. Path is `accounts/{a}/locations/{l}/reviews` while `v1` returns `locations/{l}`, **so persist the `accountId`**. Star-only reviews with no comment are common — the LLM must handle a 5-star review with empty text. Plan a 6/min token bucket against the 10 edits/min cap |
| **Performance** `v1` | **Hostname conflict I could not resolve:** the API overview table says `mybusinessperformance.googleapis.com`, while the reference, client libraries and RPC package say `businessprofileperformance.googleapis.com`. **[UNVERIFIED]** — resolve in the Cloud console API Library before writing a client. Impressions are split across **four** metric enums (desktop/mobile × maps/search) and must be summed to match what the owner sees in the GBP UI. **Monthly keywords are bucketed below a threshold (e.g. `"<15"`) — the data model must accept a range, not an integer**, or every long-tail term silently stores 0 |
| **Verifications** `v1` | Cheap, and the only clean programmatic answer to *"why are my writes failing when my token is fine"*. Most implementations skip it and then cannot explain a suspension. **In MVP** |
| **Notifications** `v1` (P1) | **There is exactly ONE notification setting per account.** Writing your Pub/Sub topic **silently replaces another tool's** and breaks their integration — a genuine way to break a third party's product. Always `getNotificationSetting` first and, if a foreign topic is present, show the owner what you are about to overwrite. Payloads are pointers, not reviews. Delivery is at-least-once, so be idempotent on `reviewId + updateTime`. **Verify the Google-signed OIDC JWT** — an unauthenticated webhook here is an injection path into the LLM pipeline |
| **Search Console** | Not access-gated. 16-month window, 2–3 day lag, 25,000 rows per request with `startRow` paging. URL Inspection is **2,000/day per site** and effectively unraisable — inspect a rotating priority subset, not everything daily. **Query-level clicks will always be less than page-level clicks** because Google filters out rare queries entirely; explain that in the UI rather than trying to reconcile it |
| **GA4 Data API** | **Recommendation: do not build it.** It adds a Sensitive scope for zero capability the owner lacks (they already have the GA4 UI), and putting GA4's approximate conversion number beside your own exact one creates a reconciliation argument you will lose. The Performance API covers the local-visibility figures the dashboard actually needs |
| **Indexing API** | **Stated plainly and not softened:** restricted by policy to pages with `JobPosting` or livestream `BroadcastEvent` markup. A spa site has neither. **Nobody should promise instant indexing.** The sanctioned route is a clean sitemap plus manual *Request indexing* |
| **PageSpeed Insights** | API key only, no OAuth — works on day one. Lab scores are noisy; a 6-point swing is meaningless and an agent reporting it as a regression will cry wolf until the owner stops reading. Median of 3, or prefer CrUX field data for trend. **CrUX has no data for low-traffic origins** — handle the empty case rather than rendering zeros |
| **Bing Webmaster + IndexNow** (P2) | ~30 minutes of setup, no OAuth. Worth it because Bing data increasingly feeds Copilot, a growing discovery channel. Cloudflare enables IndexNow with a toggle |

---

## 8. Must confirm

### Launch blockers

1. **Does an External app in Production but *unverified* still issue 7-day refresh tokens?** Google's docs
   tie the expiry to *Testing*; practitioner sources say Production alone lifts it. **Confirm empirically:
   publish to Production, consent, record `consent_at`, assert the same refresh token works on day 9.
   That is a nine-day experiment — start it in week one of the build, not launch week.**
2. **Does an Internal audience (Workspace org) exempt the app from verification, the 100-user cap *and* the
   7-day expiry?** If yes, buy the Workspace seat and take that path.
3. **Which Google account currently owns the GBP listing, and at what role?** Possibly a former agency.
   Everything depends on it and no code substitutes for it.
4. **Does the listing meet the Basic API Access prerequisites today** — verified, active 60+ days, with a
   website on the profile? If the new site is not live at launch, does a holding page satisfy it?
5. **Submit the Basic API Access application** and confirm the current process end to end.
6. **Is approval attached to the Cloud project or the applying account?** Determines whether identity
   migration happens before or after applying.
7. **Is app verification required for `business.manage` on a single-user External Production app?**
8. **Which account is a Verified Owner of the Search Console property, and is it the same one that owns the
   GBP listing?** If different, the two-connection schema in §2 is load-bearing rather than defensive.
9. **The correct Performance API hostname.**

### Build-time

Reply length cap via `reviews.updateReply` (lint to a conservative 1,200 characters regardless) · the quota
actually applied to legacy `v4` reviews · the Performance API retention window, which sets how urgently to
mirror into Postgres · whether Places API terms permit caching review content or only rating and count ·
Google's current waiting period before a new Owner can be promoted to Primary Owner · whether a Workspace
super-admin's forced revocation behaves like a user revocation · Pub/Sub push OIDC verification and the IAM
binding for `mybusiness-api-pubsub@system.gserviceaccount.com` · **and read the Business Profile API
changelog and deprecation pages before writing the Reviews adapter, with a recurring quarterly reminder to
re-read them** — Reviews remaining on legacy `v4` while everything else migrated is the clearest possible
signal it will move.

---

## 9. Sequencing consequence

Because GSC is ungated and GBP is not, the build order is not the obvious one:

| Week | Action |
|---|---|
| 1 | Establish who owns the listing. Start the 9-day token-expiry experiment. Decide Workspace/Internal. Buy the seat |
| 1–2 | Restructure GBP ownership (the promotion waiting period runs in the background). Submit Basic API Access with the Cloud project number |
| 2+ | Build the connection, the picker, the health check and `withGoogle`. **Build the SEO agent against GSC — it works now** |
| 2+ | Build the autoresponder **in fallback mode first**, because that is launch mode |
| When approved | Flip `delivery_mode` to `api` — a row change, not a deploy. Add Notifications (P1) for minute-latency replies |
