# Execution Plan — Step by Step

The ordered sequence from today to steady state, derived from
[00-plan.md](00-plan.md) (workstreams and dependencies), [05](05-external-dependencies.md) (external
queues) and [10](10-google-connection.md) (Google sequencing).

**Baseline assumption for the calendar: two engineers.** §9 gives the one- and three-engineer variants.
Step numbers are stable; week numbers move with team size.

---

## Stage 0 — Week 0: discovery and starting the clocks

Nothing here is code. Every step either unblocks a later stage or starts an external queue that runs in
the background for weeks. **Stage 0 is the highest-leverage week in the project** — skipping it is how
month six becomes month nine.

| # | Step | Output | Unblocks |
|---|---|---|---|
| 1 | **Collect the handover pack** — real service menu with durations and prices; actual room inventory (count, types, couples-capable, service compatibility, honest turnaround); staff list with skills, languages, gender, certification expiries; opening hours including Ramadan; existing chart of accounts; **unredeemed vouchers and outstanding packages with balances**; **current leave balances per employee**; customer list; existing site URLs | A populated seed dataset | B, M, P, and the migration |
| 2 | **Read the trade licence** and any municipality / health-authority approval | `licence_class`, permitted public vocabulary, permitted staff titles, permitted room types | F (regulatory profile), W (lint lexicon) |
| 3 | **Establish who owns the Google Business Profile listing and at what role**, and who is a Verified Owner of the Search Console property | The truth, which may be a former agency | Everything Google |
| 4 | **Buy one Google Workspace seat** on the business domain; create the business account; add it as a **GBP Owner** | Starts Google's owner-promotion waiting period in the background | §3 of [10](10-google-connection.md) |
| 5 | **Submit the GBP Basic API Access application** with the Cloud project number, from an owner/manager account | Approval clock starts (days to ~6 weeks) | Autoresponder API mode |
| 6 | **Start the 9-day OAuth token-expiry experiment** — publish to Production, consent, record `consent_at`, assert the token still works on day 9 | Resolves the single biggest silent-failure risk | The OAuth publishing decision |
| 7 | **Ask the lawyer the one health-data residency question** | The hosting region decision | F (region), and go-live with real intake data |
| 8 | **Start two SMSala sender-ID registrations** (transactional + `AD-` promotional) with e& and du | Registration clock starts | C (campaigns) |
| 9 | **Open the acquirer conversation**; get the MCC confirmed in writing. Ask two providers | Merchant onboarding clock starts | Y |
| 10 | **Baseline the existing site** — full crawl, rank snapshot, GSC export, top-page inventory | The 301 map source, and the before/after evidence | W, and the cutover |
| 11 | **Confirm `btree_gist`** is available on DO Managed Postgres, and that a standby is offered on the intended tier | Concurrency design validated | B |
| 12 | **Brief the photographer and book the shoot** using the art-direction brief in [08](08-frontend-design.md) §6 | Real media, which has a **long lead time** | W — genuinely blocked without it |
| 13 | **Audit the incumbent export**, if bookings run through Fresha / Booksy / Zenoti | What actually comes out, and what does not | The migration and the cutover date |

**Gate out of Stage 0:** steps 1, 2, 3 and 11 answered. Steps 4–9 and 12 *started* — they do not need to
finish, they need to be running.

---

## Stage 1 — Weeks 1–3: Foundation (F), serial

Both engineers. Nothing else starts until this merges; a moving schema spine costs more in rework than
the three weeks saved.

| # | Step |
|---|---|
| 14 | Monorepo, TypeScript strict, Biome/ESLint with the **module import-boundary rule** (`core` may not import `db`; `db` may not import `apps`) |
| 15 | CI on GitHub Actions: typecheck, unit, integration **against real Postgres**, migration dry-run |
| 16 | Four environments: local compose, PR preview, staging, production. **Separate OAuth client IDs per environment** — see [10](10-google-connection.md) §4 |
| 17 | **The staging send guard** — a hard block preventing any non-production environment from messaging a real customer |
| 18 | DO provisioning: App Platform (web ×2 + worker ×1), Managed Postgres 2 vCPU / 4 GB **with standby**, Spaces (two buckets: private originals, public derivatives), Cloudflare |
| 19 | Schema spine: `legal_entity`, `premises`, `regulatory_profile`, `audit_event` (monthly partitions), `outbox_event`, pg-boss tables, roles and permissions |
| 20 | Cross-cutting services: boot-time config validation, structured logging with correlation IDs, Sentry, audit service, outbox publisher, notification service, money (integer fils) and date (`timestamptz`, Asia/Dubai) utilities, feature flags, export service |
| 21 | Staff auth with **mandatory TOTP 2FA**; the RBAC policy layer |
| 22 | **The clinical schema boundary**: separate schema, separate DB role, envelope encryption, UUID-only references, **no cross-boundary foreign keys** |
| 23 | **The settings registry** — declarative Zod schema per setting with type, constraint, role, and `onChange` cache-tag effects ([09](09-ia-seo-and-settings.md) §5) |
| 24 | **Prove Arabic RTL PDF rendering.** Now, not in month five. It is the classic late surprise |
| 25 | Design tokens from [08](08-frontend-design.md): palette as CSS custom properties, type scale, spacing, motion tokens, Tailwind v4 theme with the default palette deleted, generated hex mirror |

**Gate out of Stage 1:** a migration ships through CI to production; an audited mutation appears in the
audit log; an outbox event reaches a worker; 2FA login works; an Arabic PDF renders correctly.

---

## Stage 2 — Weeks 4–10: Booking engine (B) ∥ design system

The hardest engineering in the project. **Engineer 1 owns B start to finish** — it is the critical path
and should not be split.

**Engineer 1 — B:**

| # | Step |
|---|---|
| 26 | Service catalogue: categories, services (internal + **linted public display name**), variants, add-ons, skill mapping, room-type compatibility, per-service turnaround, gross-fils pricing, effective-dated price lists |
| 27 | Rooms as schedulable resources: types, capacity-2 couples rooms, service compatibility, **turnaround as room-occupying time distinct from therapist buffer** |
| 28 | **The availability engine** — all five simultaneous constraints, including **same-gender matching, default strict**. Compute on demand, cache 30–60s, invalidate on any write to appointments, shifts, blocks or leave. No precomputed slot table |
| 29 | **Concurrency correctness**: `btree_gist` exclusion constraint on `(therapist_id, period)`, **deferred** constraint trigger for room capacity, `FOR UPDATE` on the room row, idempotency keys on the public endpoint |
| 30 | Appointment lifecycle state machine — every transition, actor and side effect. `COMPLETED` emits revenue events, not `CONFIRMED` |
| 31 | Phone-first identity: E.164 normalisation, SMS OTP with rate limiting and enumeration resistance, guest booking, stable `customer_id` |
| 32 | **Property-based tests** on the engine: no double-booking, no room over capacity, no closure crossing, turnaround respected, gender constraint never violated |
| 33 | Public booking flow — plain but real, mobile-first, all edge states from [09](09-ia-seo-and-settings.md) §3 |
| 34 | Admin calendar: **room × time primary**, therapist × time secondary, drag to reschedule, quick-book, walk-in entry |
| 35 | Transactional messaging via SMSala and Resend on the durable queue, with **reminder invalidation on reschedule and cancel** |
| 36 | Magic-link self-service manage-booking page |

**Engineer 2 — design system and CMS scaffolding (W, part 1):**

| # | Step |
|---|---|
| 37 | Component library in `packages/ui`: shadcn/ui copied in, Radix, geometry replaced per [08](08-frontend-design.md) §7 so it does not look like every other shadcn site |
| 38 | Motion system implemented as tokens, including the reduced-motion override and the RTL direction multiplier |
| 39 | Payload CMS v3 embedded, media collection with **named slots** (aspect ratio, min dimensions, max size, **required alt text**, junk-alt filter) |
| 40 | Media pipeline: `sharp` derivative job, colour management for pastels, content-addressed immutable URLs, same-origin `/m/*` via Cloudflare, custom `next/image` loader |
| 41 | **The breakpoint preview component** — shows editors the real crop at real widths. A week of work that prevents most bad publishes |
| 42 | `next-intl` plumbing, EN/AR routing, RTL layout verified, `DirectionProvider` |

**Milestone M1 Bookable** (~week 10): catalogue → availability → book online → confirmation SMS →
appears on admin calendar → reschedule invalidates the old reminder. **Demo to the owner.**

---

## Stage 3 — Weeks 8–13: CRM, consent and automation (C) — Engineer 2

Starts once B's event catalogue exists (~week 8), overlapping B's tail.

| # | Step |
|---|---|
| 43 | Client record: preferences, tags, lifecycle, source, spend history, VIP and **blocklist that blocks in the booking path**, not just a note |
| 44 | **Intake and consent forms behind the clinical boundary.** Versioned templates, signature capture, re-consent interval. The booking layer sees **boolean contraindication flags only** |
| 45 | Duplicate detection and **merge as a first-class operation** — re-points consents, suppressions, enrolments and frequency ledgers to the survivor |
| 46 | Consent per channel × purpose × timestamp × **wording version shown**; preference centre reachable without login |
| 47 | Automation engine: versioned flow DSL, enrolments pinned to a definition version, idempotency on `(flow_run, node, channel, contact)`, frequency caps, loop detection, kill switch, dry-run |
| 48 | **The messaging compliance gate** — two sender IDs, immutable template `message_class`, consent / quiet-hours / suppression **in the send path as code**, fail closed |
| 49 | Kanban pipeline (ship first — cheap, immediately useful) |
| 50 | React Flow node-graph builder, which must make routing promotional content through a transactional template **impossible**, not discouraged |
| 51 | Campaigns with audience from segment, throttling, spend caps. Review solicitation, win-back, birthday triggers |

**Milestone M3 Reachable** (~week 13): booking event → enrolment → consented SMS → opt-out honoured →
suppression blocks the next send. Consent gating tested as an **invariant**.

---

## Stage 4 — Weeks 11–19: Money (M) — Engineer 1

The longest workstream, and the one where a bug costs real money.

| # | Step |
|---|---|
| 52 | Till / checkout: complete a visit, add retail, discount, record payment by cash / in-salon card machine / bank transfer via a **manual payments adapter** so the ledger is correct before any gateway exists |
| 53 | Chart of accounts; **append-only double-entry journal**; period locking; corrections by dated reversal only. No UPDATE or DELETE on `journal_line` |
| 54 | **FTA tax invoices** and simplified invoices: bilingual, snapshotted issuer name/address/TRN, **gapless sequence allocated inside the insert transaction**, per-line VAT, gross-first integer fils |
| 55 | Credit notes as the only correction mechanism |
| 56 | Vouchers, packages, memberships as **deferred revenue liabilities** — redemption, balance, expiry, breakage, and the **VAT event separated from the revenue event** |
| 57 | Cash drawer reconciliation per shift; **rebooking prompt at checkout** |
| 58 | Suppliers, bills, expense capture with receipts, approval limits, payables ageing |
| 59 | **Recurring-cost register** with fixed/variable split, renewal reminders, budget-vs-actual variance alerting |
| 60 | **Reverse-charge VAT** on offshore suppliers, with a nightly exception report on any bill missing the pair |
| 61 | Blocked input VAT classification; inventory and COGS for retail and professional-use stock |
| 62 | VAT201 working papers: accounts tagged with return-box codes, drill-down to source, preparer/reviewer sign-off. **No auto-file capability in the codebase** |
| 63 | **The compliance calendar** — obligations, dated instances, escalation, and **blocking obligations that change system behaviour when overdue** |
| 64 | Zoho Books export for statutory filing |

**Milestone M2 Bankable** (~week 15): visit → invoice with correct VAT → payment → balanced journal →
correct VAT201 box.
**Milestone M5 Accountable** (~week 19, with R): a closed test month reconciles end to end.
**An FTA-registered tax agent reviews the working papers.** Non-negotiable.

---

## Stage 5 — Weeks 14–17: People (P) — Engineer 2

| # | Step |
|---|---|
| 65 | Employee records with field-level encryption on bank details and identity document numbers; every read audited |
| 66 | **Credential registry gating availability** — an expired labour card, visa or certification **automatically removes the therapist from bookable availability** and flags their future appointments for reassignment. This automation is the module's whole value |
| 67 | Rota publishing, swaps, open shifts, labour-cost forecast against booked revenue |
| 68 | Attendance and timesheets; scheduled vs actual vs billed hours |
| 69 | **Leave management**: accrual, carry-over, UAE 30-day entitlement, sick-leave tiers, approval with delegation, minimum-coverage rules, team calendar — and **approving leave blocks availability and surfaces booking conflicts with a reassignment path, never a silent cancellation** |
| 70 | Commission (versioned, reproducible, **therapist-visible derivation**), tips, deductions, payslips |
| 71 | **Monthly gratuity accrual** posting to the ledger; WPS export as a bank-specific adapter over a reviewed payroll |
| 72 | Ramadan reduced hours as a dated override; **provisional-vs-confirmed lunar holidays with an impact report** |

**Milestone M6 Staffed** (~week 17): publish rota → approve leave over a booking → conflict surfaced →
availability blocked → payroll and gratuity posted. One of the three most likely places for a surprise.

---

## Stage 6 — Weeks 18–23: Analytics (A) then Reporting (R) — Engineer 2

| # | Step |
|---|---|
| 73 | Measurement plan and event taxonomy **first**; one typed tracking SDK so events are not sprinkled ad hoc |
| 74 | GA4 + Meta Pixel client-side; **Consent Mode v2** and a CMP gating client tags **and** server pushes |
| 75 | Server-side push from the **transactional outbox** to GA4 Measurement Protocol and Meta CAPI — shared `event_id`, hashed user data, `fbp`/`fbc` forwarding. First-party `/api/collect`, **no sGTM container** |
| 76 | **Offline conversion loop**: the till emits corrected values; no-shows pushed as void. Booking value is a guess, the till knows the truth |
| 77 | **The egress guard** — services mapped to opaque category codes, health-adjacent parameters stripped, with a test **enumerating every service** |
| 78 | Reporting schema and materialised views: `dim_*`, `fact_appointment`, `fact_sale`, `fact_shift`, nightly refresh |
| 79 | P&L, balance sheet, **cash-flow statement** (profit and cash are different numbers and the owner will not otherwise see it) |
| 80 | The spa KPI set with explicit formulas — utilisation, **revenue per available room-hour**, average ticket, retail attachment, **rebooking rate**, retention cohorts, LTV, no-show cost, discount leakage, labour %, **contribution margin per service**, break-even, voucher liability, CAC |
| 81 | Seasonality including **Ramadan and the summer exodus**; cash-flow forecast from recurring costs + forward bookings + payroll |
| 82 | Pushed alerts; role-scoped dashboards with drill-down; a **data-quality view that refuses to show an unreconciled number** |

**Milestone M7 Attributable** (~week 20): booking → no-show → GA4 and Meta receive the corrected
net-zero value; the egress test passes.

---

## Stage 7 — Weeks 20–23: Payments (Y) — Engineer 1 · *gated on the merchant account*

If the acquirer is slow, this slides to Stage 9 and launch proceeds on cash / card machine / transfer,
which was always the launch plan.

| # | Step |
|---|---|
| 83 | Gateway behind the payments abstraction from step 52 |
| 84 | Deposits, first-time prepayment, saved cards, **no-show and late-cancellation fees with disclosed documented consent** |
| 85 | PCI **SAQ-A** only — hosted fields, never touching PAN |
| 86 | Webhooks: signature verification, idempotent handlers, replay protection, **a reconciliation job for missed events**. Client callbacks are never the source of truth |
| 87 | Settlement reconciliation — gross vs net of fees, timing, refunds, chargebacks — **to the fils** |
| 88 | A discreet, configurable statement descriptor |

---

## Stage 8 — Weeks 24–30: public site, CMS content and the SEO agent

Both engineers. **Photography must be delivered by now** (step 12).

| # | Step |
|---|---|
| 89 | Content model with the boundary enforced: the **catalogue** owns price, duration and bookability; the **CMS** owns narrative, media and SEO copy |
| 90 | Build the page set from [09](09-ia-seo-and-settings.md) §1 with the per-route rendering strategy |
| 91 | **Therapist pages** — the differentiator. Consent captured, first-name/pseudonym option, and the **301-not-404 archival path** when a therapist leaves |
| 92 | The hero: **real `<img>` as LCP element, `<video>` with no `src` attached by the ~1.4KB island after LCP is final**. Codec ladder, art-directed `<picture>`, WCAG pause control |
| 93 | JSON-LD generated from the database — `DaySpa`, `Service`/`Offer` in AED, `Person` per therapist, `FAQPage`, `OpeningHoursSpecification` from the single `premises` row |
| 94 | Sitemaps with CMS-driven `lastmod`, `hreflang`, `robots.txt` with the **allow-AI-crawlers** policy, IndexNow, `/api/facts`, `/llms.txt` |
| 95 | **The publication control plane**: draft → banned-claims lint → named human approval → immutable publication record with content hash. Runs over service display names and alt text too |
| 96 | Performance enforcement, all three layers: field RUM (`web-vitals` attribution), **Lighthouse CI budget that fails the build**, and a publish-time weight check |
| 97 | **The 301 map** from the step-10 baseline, for every retired URL |
| 98 | Google connection UI: OAuth flow, **account-then-location picker**, capability map, health check, the **not-dismissible re-auth banner** and escalating email ([07](07-frontend-and-agents-requirements.md) §6) |
| 99 | Review autoresponder **in fallback/draft mode first** — nullable `google_review_id`, `delivery_mode` as a column, the safety routing table, the output linter, human approval |
| 100 | SEO agent: GSC nightly snapshots into Postgres, deterministic analyses, LLM provider abstraction shared with the autoresponder, **publish denied at the permission layer**, weekly Resend report |
| 101 | **The agent console** with heartbeats and the 2×-interval watchdog across every agent |

**Milestone M4 Findable** (~week 28): publish a service in admin → page live with JSON-LD → sitemap
updated → indexed in GSC.

---

## Stage 9 — Weeks 31–34: hardening, migration, cutover

| # | Step |
|---|---|
| 102 | Penetration test (**booked at the start of this stage, not the end**); triage findings |
| 103 | **Restore drill from backup.** An untested backup is not a backup |
| 104 | Runbooks: restore, rotate a leaked key, roll back a deploy, drain the queue, re-send failed messages, re-auth Google |
| 105 | Incident-response plan with PDPL notification timelines; the processor register; the documentation set |
| 106 | **Migration dry run ×3** against staging, each producing a reconciliation report — counts, totals, **voucher liability**, **leave liability** — against source. Run three: no unexplained variance |
| 107 | **Parallel run, two weeks.** Old process and new system both record every booking, reconciled daily. The only way to discover the engine disagrees with how the salon actually works while the old process still exists |
| 108 | **Staff pilot** on a quiet weekday, front desk on the new till, one super-user per shift. Fix what they complain about **before** cutover — the post-cutover version of that complaint is silent abandonment |
| 109 | Training: admin guide, therapist quick guide, accountant guide, cheat sheets |
| 110 | **Code freeze**, one week out. Launch-blocking fixes only |
| 111 | **Go/no-go**: external items cleared, M1–M7 demonstrated, restore drill passed, pen-test findings triaged, rollback rehearsed, first-fortnight support rota agreed **including who answers at 8pm on a Friday** |
| 112 | **Cutover**: final migration, DNS, 301s live, GBP booking link updated, monitoring on |

---

## Stage 10 — Post-launch

| # | Step |
|---|---|
| 113 | **Paper fallback fortnight** — printed day sheet each morning, documented manual process |
| 114 | **SEO monitoring window, four weeks** — rankings, coverage, 404s, Core Web Vitals against the step-10 baseline |
| 115 | Daily reconciliation for the first month: bookings vs invoices vs payments vs journal |
| 116 | First VAT return prepared from the system, reviewed by the tax agent |
| 117 | Flip the autoresponder to API mode when GBP access lands — **a row in the capability table, not a deploy** |
| 118 | Then: WhatsApp Business API, Arabic launch if deferred, memberships, retail inventory depth, node-graph builder if thinned — from the flex list in [00-plan.md](00-plan.md) §10 |

---

## Timeline at a glance — two engineers

```
Week      0    4    8   12   16   20   24   28   32   34
          │    │    │    │    │    │    │    │    │    │
Stage 0   ██
F         ░████
E1              ███████ B ──────┐
                        ████████████ M ────────┐
                                      ████ Y ──┤
                                               ████████ W2 ──┐
E2              ████ W1 ──┐                                  │
                     █████████ C ──┐                         │
                                ███████ P ──┐                │
                                          ██████ A+R ──┐     │
                                                       ████ S┤
H                                                            █████
Milestones           M1        M3   M2  M6   M7    M4       go-live
External  ═══ GBP approval ═══════╗  ═══ sender IDs ═══╗  ═══ MCC ═══╗
          ═══ photography ════════════════════════════╗
```

**Critical path: F → B → M → H.** Roughly 18–24 weeks of serial work that adding people does not
compress.

---

## §9 — Other team shapes

| Team | To launch | Notes |
|---|---|---|
| **1 engineer** | 11–13 months | Works, but the highest-risk shape: bus factor of one for a year, and no second pair of eyes on the money paths. If this is the reality, take the flex list in [00-plan.md](00-plan.md) §10 up front rather than at month nine |
| **2 engineers** (baseline) | 7–8 months | E1 owns the critical path F→B→M→Y; E2 owns W1→C→P→A→R. H shared |
| **3 engineers** | 5–6 months | Diminishing returns — F is serial and M depends on B. The third is best on W, S and test coverage, **not** on splitting B or M |

Also needed: a **designer for ~4 weeks, front-loaded** (before Stage 8, ideally during Stage 1–2 so W1
is not blocked); an **FTA-registered tax agent** to review Stage 4's output; a **photographer** early;
and a **penetration tester** booked for Stage 9.

---

## §10 — The five ways this slips, and the counter

| Risk | Counter |
|---|---|
| **Stage 0 gets skipped** because it is not code | It is the highest-leverage week. Every external clock starts here; none can be compressed later |
| **Photography arrives late** and blocks Stage 8 | Brief and book in week 0. It is the one dependency with no software workaround |
| **M2 or M6 surprises** — VAT or leave/availability interaction wrong | They are milestones precisely because they are the likely surprises. Demo on real data; do not defer |
| **The acquirer is slow** and Y blocks launch | Y was never launch-critical. Cash, card machine and bank transfer were always the launch payment set |
| **Migration variance found late** | Three dry runs with reconciliation reports, starting in Stage 9 week 1, not launch week |
