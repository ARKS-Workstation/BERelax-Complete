# BeRelax Platform — Single-Release Build Plan

**Execution model: build the complete system, then launch once.** No incremental go-lives, no
interim releases. This document is the work breakdown for that.

---

## 1. What "in one go" changes, and what it does not

**The business is already operating.** That is the important context for this whole plan. There is an
existing trade licence, an existing service menu, existing staff on existing visas, an existing
accountant, existing customers and an existing booking process — almost certainly a mix of phone,
WhatsApp and a diary or an incumbent app. Two consequences follow:

1. **The build is under no revenue pressure.** The business keeps trading on its current process
   throughout. Nothing is lost by finishing the system before switching to it.
2. **The end of the build is a migration, not a launch.** The hard part is not "going live" — it is
   moving a live, operating business onto the system without losing a booking, an outstanding package
   balance or a leave balance. §7 is therefore a work breakdown, not a risk-mitigation plea.

**Changes.** No phased staff onboarding, one UAT, one training event, one cutover.
Business-outcome-per-phase sequencing is gone, so the organising structure becomes **parallel
workstreams against a dependency graph**, with **internal integration milestones** that prove the
system end to end rather than ship to customers.

**Does not change.** Dependencies are physics, not policy. Checkout cannot be written before the
catalogue exists; reminders cannot be written before the appointment lifecycle exists; reporting
cannot be written before there are facts to report on. A single release does not flatten the graph —
it only removes the release points from it.

**Also does not change: a handful of external items.** Most are answered by reading documents the
business already holds — the trade licence states the activity, the accountant knows the VAT position,
the insurer knows the cover. Only three genuinely sit in an external queue: **SMS sender-ID
registration**, **platform verifications** (Google Business Profile, Search Console, Meta, Resend
domain) and, if cards are wanted, **merchant-account onboarding**. Those three should start now
because they are measured in weeks. See §8 and
[05-external-dependencies.md](05-external-dependencies.md).

---

## 2. Serial prefix: the Foundation (~3 weeks, blocks everything)

Nothing else starts until this is merged. Attempting workstreams in parallel with a moving schema
spine produces rework that costs more than the three weeks saved.

- Monorepo, TypeScript strict, lint/format, module import-boundary rule.
- CI on GitHub Actions: typecheck, unit, integration against real Postgres, migration dry-run.
- Four environments: local (compose), PR preview, staging, production. **Staging send guard** — a
  hard block preventing any non-production environment from messaging a real customer.
- DigitalOcean provisioning: App Platform (web + worker), Managed Postgres 2 vCPU / 4 GB with
  standby, Spaces, Cloudflare, secrets, TLS `verify-full` to the database.
- Schema spine and migration pipeline: `legal_entity`, `premises`, `regulatory_profile`,
  `audit_event`, `outbox_event`, pg-boss tables, the role/permission model.
- Cross-cutting services: config validation at boot, structured logging with correlation IDs,
  Sentry, audit service, outbox publisher, job queue, notification service, money and date
  utilities, feature flags, export service.
- Staff auth with mandatory TOTP 2FA; the RBAC policy layer.
- **The `clinical` schema boundary**: separate role, envelope encryption, UUID-only references, no
  cross-boundary foreign keys.
- **Prove Arabic RTL PDF rendering now**, not in month six. It is the classic late surprise.
- Confirm `btree_gist` is available on DO Managed Postgres. The concurrency design depends on it.

**Exit criteria:** a deployable skeleton where a migration ships through CI to production, an
audited mutation appears in the audit log, an outbox event reaches a worker, and a 2FA login works.

---

## 3. Dependency graph

```
                              ┌─────────────────┐
                              │  F  Foundation  │  serial, blocks all
                              └────────┬────────┘
                                       │
        ┌──────────────┬───────────────┼───────────────┬──────────────┐
        ▼              ▼               ▼               ▼              ▼
   ┌─────────┐   ┌──────────┐    ┌──────────┐    ┌──────────┐   ┌──────────┐
   │ B       │   │ C        │    │ P        │    │ A        │   │ W        │
   │ Booking │   │ CRM +    │    │ People   │    │Analytics │   │ Web/CMS  │
   │ + desk  │   │messaging │    │ HR+leave │    │          │   │ + SEO    │
   └────┬────┘   └────┬─────┘    └────┬─────┘    └────┬─────┘   └────┬─────┘
        │             │               │               │              │
        │  catalogue  │ events        │ availability  │ outbox       │ catalogue
        │  + lifecycle│ + consent     │ blocking      │ events       │ + facts
        ├─────────────┴───────────────┴───────────────┘              │
        ▼                                                            │
   ┌──────────┐                                                      │
   │ M  Money │  checkout, invoicing, ledger, VAT, recurring costs    │
   └────┬─────┘                                                      │
        │                                                            │
        ├──────────────┬─────────────────────────────────────────────┘
        ▼              ▼                              ▼
   ┌──────────┐   ┌──────────┐                  ┌──────────┐
   │ R        │   │ Y        │                  │ S        │
   │Reporting │   │ Payments │                  │SEO agent │
   └────┬─────┘   └────┬─────┘                  └────┬─────┘
        └──────────────┴─────────────┬───────────────┘
                                     ▼
                          ┌────────────────────┐
                          │ H  Hardening, UAT, │
                          │    cutover         │
                          └────────────────────┘
```

**Hard edges** (cannot be parallelised away):

| Edge | Why |
|---|---|
| F → everything | Schema spine, auth, audit, outbox, queue |
| B → M | Checkout needs the appointment lifecycle and snapshotted prices |
| B → C | Automation triggers on booking events; reminders need the lifecycle |
| B → A | Conversion events originate from booking and completion |
| B, C, M → R | Reporting needs facts from all three |
| P → B | Approved leave and expired credentials must block availability |
| M → Y | Payments plug into the ledger and invoice model built in M |
| W → S | The SEO agent needs pages and GSC history to work on |
| all → H | Hardening, UAT and cutover are terminal |

**Soft edges** (ordering preference, not a blocker): W benefits from a stable catalogue; A benefits
from a settled event taxonomy; R benefits from a closed month of real test data.

---

## 4. Workstreams

Effort is engineer-weeks for a competent full-stack engineer. "Entry" is what must be merged before
the track can start meaningfully.

### F — Foundation · 2–3 weeks · serial
See §2. Owner: the most senior engineer. Do not delegate the schema spine.

### B — Booking engine and front desk · 5–7 weeks · entry: F
The hardest engineering in the project. Detail in [03-modules.md](03-modules.md) §1–3.

Service catalogue (categories, services, variants, add-ons, skill mapping, room-type compatibility,
turnaround, gross-fils pricing, effective-dated price lists, linted public display names). Rooms as
schedulable resources including capacity-2 couples rooms. The availability engine with all five
simultaneous constraints including **same-gender matching, default strict**. Concurrency correctness:
`btree_gist` exclusion constraint on therapist ranges, deferred constraint trigger for room capacity,
`FOR UPDATE` on the room row, idempotency keys on the public endpoint. Appointment lifecycle state
machine with every transition, actor and side effect. Phone-first identity with SMS OTP, rate
limiting and enumeration resistance. Public booking flow (mobile-first, accessible). Admin calendar:
room × time primary, therapist × time secondary, drag to reschedule, quick-book, walk-in entry.
Transactional messaging with **reminder invalidation on reschedule and cancellation**. Magic-link
self-service manage-booking page.

**Exit:** property-based tests prove no double-booking, no room over capacity, no closure crossing,
turnaround always respected, gender constraint never violated. A walk-in is bookable in under 10
seconds, measured.

### M — Money: checkout, invoicing, ledger, VAT, costs · 7–9 weeks · entry: B (catalogue + lifecycle)
Till/checkout with cash, in-salon card machine and bank transfer via a manual payments adapter, so
the ledger is correct before any gateway exists. FTA-compliant bilingual tax invoices and simplified
invoices with snapshotted issuer identity and **gapless sequential numbering allocated inside the
insert transaction**. Credit notes as the only correction mechanism. **Packages** as the
sole prepaid product and a **deferred revenue liability** — definitions configured in settings, with
redemption, session balance, validity and breakage. No gift vouchers, no memberships. Cash
drawer reconciliation per shift. Rebooking prompt at checkout. Chart of accounts, **append-only
double-entry journal**, period locking, corrections by dated reversal. Suppliers, bills, expense
capture, payables. **Recurring-cost register** with fixed/variable split and variance alerting.
**Reverse-charge VAT** on offshore suppliers with a nightly exception report. Blocked input VAT
classification. VAT201 working papers with drill-down and preparer/reviewer sign-off — **no auto-file
capability in the codebase**. Inventory and COGS. The **compliance calendar** with blocking
obligations. Zoho Books export.

**Exit:** a closed test month reconciles — bookings to invoices to payments to journal to VAT boxes —
and an FTA-registered tax agent signs off the working papers.

### C — CRM, consent and automation · 5–6 weeks · entry: F, B (events)
Client record with preferences, tags, lifecycle, source, VIP and blocklist. **Intake and consent
forms behind the clinical boundary**, exposing boolean contraindication flags only. Duplicate
detection and **merge as a first-class operation** re-pointing consents, suppressions, enrolments and
ledgers. Consent per channel × purpose × timestamp × wording version; preference centre reachable
without login. Automation engine on the outbox and queue: versioned flow DSL, enrolment pinning to a
definition version, idempotency on `(flow_run, node, channel, contact)`, frequency caps, loop
detection, kill switch, dry-run. **Messaging compliance gate** with two sender IDs, immutable
template `message_class`, consent/window/suppression enforced in the send path, fail-closed. Kanban
pipeline, then the React Flow node-graph builder. Campaigns with spend caps. Review solicitation,
win-back, birthday triggers.

**Exit:** consent gating is tested as an invariant — a send is *impossible* without valid consent,
inside quiet hours, or to a suppressed contact. A flow edit does not disturb in-flight enrolments.

### P — People: HR and leave · 3–4 weeks · entry: F, B (availability interface)
Employee records with field-level encryption on bank and identity fields. **Credential registry
gating bookable availability** — an expired labour card removes the therapist automatically and flags
their future appointments for reassignment. Rota publishing, swaps, open shifts, labour-cost
forecast. Attendance and timesheets. **Leave management**: accrual, carry-over, UAE 30-day
entitlement, sick-leave tiers, approval with delegation, minimum-coverage rules, team calendar, and
the hard link that **approving leave blocks availability and surfaces booking conflicts**. Commission
(versioned, reproducible, therapist-visible), tips, deductions, payslips, **monthly gratuity
accrual** posting to the ledger, WPS export. Ramadan reduced hours; provisional-vs-confirmed lunar
holidays with an impact report.

**Exit:** approving leave over an existing booking produces a conflict and a reassignment path, never
a silent cancellation. Leave accrual matches worked examples reviewed against the labour law.

### A — Analytics and measurement · 2–3 weeks · entry: F, B (events), M (till events)
Measurement plan and event taxonomy first; one typed tracking SDK. GA4 and Meta Pixel client-side.
**Server-side push from the transactional outbox** to GA4 Measurement Protocol and Meta CAPI with
shared `event_id`, hashed user data, `fbp`/`fbc` forwarding. **Consent Mode v2** and a CMP gating
both client tags and server pushes. **Offline conversion loop**: the till emits corrected values;
no-shows are voided. **Egress guard** mapping services to opaque category codes with a test
enumerating every service. First-party `/api/collect` route instead of a server-side GTM container.

**Exit:** the enumerating egress test passes; a booking-then-no-show produces a net-zero conversion;
no tag fires before recorded consent.

### R — Reporting and financial analysis · 2–3 weeks · entry: M, B, C, P
Reporting schema in the same Postgres, refreshed by materialised views. P&L, balance sheet,
cash-flow statement. The spa KPI set with explicit formulas: therapist and room utilisation, revenue
per available room-hour, average ticket, retail attachment, rebooking rate, retention cohorts, LTV,
no-show cost, discount leakage, labour cost %, **contribution margin per service**, break-even,
outstanding package liability, CAC and payback. Seasonality including Ramadan and the summer exodus. Cash-flow
forecast from recurring costs plus forward bookings and payroll. Pushed alerts. Role-scoped
dashboards with drill-down and a data-quality view that refuses to show an unreconciled number.

**Exit:** every headline number drills to source rows and ties to the ledger.

### W — Web: CMS, public site and SEO · 5–7 weeks · entry: F, B (catalogue); can start early on design
Payload CMS v3 in the same app on the same Postgres. Content model with the catalogue/CMS boundary
explicit. Design system, EN/AR with real RTL, WCAG 2.2 AA, performance budget with a CWV gate in CI.
JSON-LD generated from the database. Sitemaps with CMS-driven `lastmod`, hreflang, redirect-on-slug-
change, IndexNow. **LLM-SEO**: server-rendered HTML, question-shaped headings with stable anchors, a
machine-readable facts endpoint, a considered AI-crawler `robots.txt` policy, citation monitoring.
**Publication control plane**: draft → banned-claims lint → named human approval → immutable
publication record. Publish pipeline: ISR revalidation, sitemap, IndexNow, CDN purge.

**Exit:** nothing publishable breaches licence conditions; a catalogue change propagates to page,
structured data and sitemap without manual intervention.

### S — SEO agent · 2–3 weeks · entry: W
GSC API with nightly snapshots into Postgres. Deterministic analysis first, LLM for judgement and
drafting only. CTR outliers, content gaps, cannibalisation, coverage regressions, internal-link
audit, structured-data validation, on-site-vs-GBP consistency. **Propose-only by construction** —
publish denied at the permission layer, never `robots.txt`/canonical/redirect/`noindex`, keyword
expansion filtered against the blocking lexicon, fetched web content treated as untrusted data.
Weekly plain-English report by Resend.

**Exit:** the agent cannot publish even if instructed to; a red-team prompt-injection test fails to
escalate it.

### Y — Payments · 3–4 weeks · entry: M · **external gate: merchant account**
Gateway behind the payments abstraction built in M. Deposits, first-time prepayment, saved cards,
no-show and late-cancellation fees with disclosed consent. PCI SAQ-A only — hosted fields, never
touching PAN. Webhooks with signature verification, idempotent handlers, replay protection and a
reconciliation job for missed events; client callbacks are never the source of truth. Settlement
reconciliation: gross vs net, timing, refunds, chargebacks. Discreet configurable statement
descriptor.

**Exit:** a settlement file reconciles to the ledger to the fils, including fees and a refund.

### H — Hardening, UAT and cutover · 4–5 weeks · entry: all
See §6 and §7. Penetration test, restore drill, DR runbooks, key rotation, incident-response plan
with PDPL notification timelines, dependency and secret scanning, the documentation set, then UAT
and the cutover itself.

---

## 5. Integration milestones

Internal, not releases. Each is a **vertical slice demonstrated on real data**, and each is the
earliest honest evidence that a set of workstreams actually composes. In a single-release build these
replace release points as the schedule's truth-telling mechanism — if a milestone slips, the launch
date slips, and you find out months earlier than you otherwise would.

| # | Milestone | Proves | Needs |
|---|---|---|---|
| **M1 Bookable** | Catalogue → availability → book online → confirmation SMS → appears on admin calendar → reschedule invalidates the old reminder | The core engine composes, and messaging works | F, B |
| **M2 Bankable** | Visit completed → invoice issued with correct VAT → payment recorded → journal balanced → lands in the right VAT201 box | Money is correct end to end | B, M |
| **M3 Reachable** | Booking event → automation enrolment → consented SMS sent → opt-out honoured → suppression blocks the next send | Consent and automation are enforced, not decorative | B, C |
| **M4 Findable** | Publish a service in admin → page live with JSON-LD → sitemap updated → indexed in GSC | The catalogue-to-frontend loop works | B, W |
| **M5 Accountable** | Close a test month → VAT201 working papers → P&L and cash flow → owner dashboard, every number drilling to source | Reporting ties to the ledger | M, R |
| **M6 Staffed** | Publish rota → approve leave over a booking → conflict surfaced → availability blocked → payroll and gratuity posted | HR and booking share one source of truth | B, P |
| **M7 Attributable** | Booking → no-show → GA4 and Meta receive the corrected net-zero value; egress test passes | Measurement reflects reality | B, M, A |

Demo each to the owner. M1, M2 and M6 are the three where a surprise is most likely and most
expensive.

---

## 6. Global definition of done

Applies to every item in every workstream. A module is not done until all of it holds.

- Unit tests on the domain logic in `core`; integration tests against real Postgres; Playwright
  coverage for anything a customer or receptionist touches.
- Migration reviewed, forward-only, expand-contract if destructive.
- Permissions applied at field level where sensitive; deny-by-default verified.
- Audit logging on every mutation, on reads of clinical and salary data, and on every export.
- i18n keys extracted; Arabic present; RTL verified visually, including PDFs.
- Analytics events emitted per the taxonomy; egress guard respected.
- Compliance lint applied to anything publishable.
- Accessibility: keyboard operable, screen-reader semantics, contrast checked.
- ADR written for any decision that a future maintainer would otherwise have to guess at.
- Runbook entry if it can fail at 8pm on a Friday.

---

## 7. Cutover: moving an operating business onto the system

The business is trading throughout the build, so this section is the work of switching it over. It is
scoped work, not contingency.

**Data migration.** Everything below already exists somewhere — a spreadsheet, an incumbent app, a
diary, the accountant's ledger. Extracting it is the job.

| Data | Notes |
|---|---|
| Customers | Phone normalisation to E.164 and duplicate merge. Expect 5–15% duplicates from a phone-and-WhatsApp process |
| Historic bookings | Enough history for the reporting cohorts and each client's visit record |
| **Outstanding packages already sold** | Real, enforceable liabilities held by real customers, with remaining session balances and validity dates. Missing one produces an angry client at the desk and a wrong opening balance sheet |
| Staff records | Contracts, skills, and **current visa / labour-card / certification expiry dates** |
| **Leave balances as they stand today** | The accrual engine needs an opening balance per employee, not a zero |
| Accounting opening balances | From the accountant, at a clean period boundary |
| Existing site URLs | Into a 301 redirect map, if the site is being replaced |

Run the migration three times against staging. Each run produces a reconciliation report — counts,
totals, outstanding package liability, leave liability — compared against the source. The third run should have no
unexplained variance. Then run it once for real during the freeze window.

**Parallel run, two weeks.** Both the existing process and the new system record every booking, with
daily reconciliation. For an operating business this is cheap: nobody is waiting on it, and it is the
only way to find out that the availability engine disagrees with how the salon actually works while
the old process is still there.

**Staff pilot.** Real bookings on a quiet weekday, front desk on the new till, one super-user per
shift. Staff on an operating floor will not tolerate a system slower than what they have, so fix what
they complain about before cutover — the post-cutover version of that complaint is silent
abandonment and rotten data.

**Paper fallback, first fortnight.** A printed day sheet each morning and a documented manual process.

**SEO migration.** If the current site is being replaced: full crawl and rank baseline before
anything changes, a 301 for every retired URL, preserve structure where it ranks, monitor for four
weeks. A relaunch without this routinely costs 30–50% of organic traffic, and an operating business
has traffic to lose.

**Freeze window.** Code freeze one week before cutover; launch-blocking fixes only.

**Go / no-go checklist.** External items in §8 cleared. M1–M7 demonstrated. Restore drill passed.
Penetration-test findings triaged. Rollback plan rehearsed. Support rota agreed for the first
fortnight, including who answers at 8pm on a Friday.

**Rollback.** Per subsystem, and honest about what cannot be reversed: issued tax invoices and sent
messages are permanent. So the rollback story is "bookings revert to the old process, the ledger
stays", not "switch the system off".

---

## 8. External items

The business is established, so most of this is retrieval rather than discovery. Detail and the exact
questions in [05-external-dependencies.md](05-external-dependencies.md).

**In an external queue — start now, measured in weeks:**

| Item | Blocks | From |
|---|---|---|
| Two SMS sender IDs (transactional + `AD-` promotional) | Any marketing send | SMSala + e& + du |
| Platform verifications: GBP, Search Console, Meta Business, Resend domain + SPF/DKIM/DMARC and warm-up | Workstreams A, W, S | The platforms |
| Merchant category code confirmed in writing | Workstream Y | Acquirer — ask two |

**Answered from what the business already holds — a morning's work:**

| Question | Source |
|---|---|
| Licence classification, and therefore permitted public vocabulary and staff titles | The trade licence itself, plus municipality/health approvals already on file |
| Permitted room types and treatment-room count | The licence and municipality approval |
| VAT registration status, TRN, tax period, invoice format currently issued | The accountant, and existing invoices |
| Whether the entity is mainland, DIFC, ADGM or free zone | Incorporation documents — determines which privacy law applies |
| Insurance cover in force, and what the insurer requires to accept a claim | The existing policy and broker |
| Current staff visa, labour-card and certification expiry dates | HR file |
| Existing leave practice and contract terms | Existing contracts |

**Still worth one professional conversation:** whether the intake notes count as health data subject
to UAE localisation rules, which decides the hosting region. It is the one item where reading the
licence is not enough, and it gates loading real intake data. Ask the accountant's or the company's
existing lawyer — it is a single question, not an engagement.

---

## 9. Calendar and team

Total scope is **40–52 engineer-weeks**. The critical path is **F → B → M → H**, roughly 18–24 weeks
of serial work that cannot be compressed by adding people.

| Team | Elapsed to launch | Assessment |
|---|---|---|
| 1 full-stack engineer | 11–13 months | Works, but the highest-risk shape in this plan. Bus factor of one over a year, and no second opinion on the money paths |
| **2 engineers + designer (~4 wks) + tax agent review** | **7–8 months** | **Recommended.** One owns F/B/M (the critical path), the other owns C/P/A/R/W. H is shared |
| 3 engineers | 5–6 months | Diminishing returns — F is serial, and M depends on B. The third engineer is best spent on W, S and test coverage |

Allocation that works for two engineers:

- **Engineer 1 (critical path):** F → B → M → Y, then shares H.
- **Engineer 2:** starts on W design system and CMS scaffolding during F, then C → P → A → R.
- **Designer:** ~4 weeks, front-loaded, so W is not blocked later.
- **FTA-registered tax agent:** reviews M's working papers before launch. Non-negotiable.
- **Penetration test:** booked for the start of H, not the end.

---

## 10. If the date compresses

Building in one go removes the natural pressure valve of shipping a smaller first release, so decide
the flex list **now**, before the pressure arrives.

**Frozen — never cut, because the cost of retrofitting is worse than the delay:**
money correctness (integer fils, gross-first, snapshotting), the append-only journal and gapless
numbering, the availability engine's correctness constraints, consent gating and the audit log, the
clinical boundary, the compliance lints, and the migration reconciliation of outstanding package balances.

**Flexible — ship a thinner version and extend after launch:**

| Can be thinned | To |
|---|---|
| Node-graph flow builder | Kanban pipeline plus hard-coded reminder and win-back flows |
| SEO agent (S) | The GSC data warehouse and weekly emailed report; no suggestion engine |
| Payments (Y) | Cash, card machine and bank transfer only — already the plan for launch |
| Arabic / RTL | English at launch, Arabic as the first post-launch release — but keep i18n plumbing and the RTL PDF proof from F |
| Package complexity | Single flat package type (N sessions of one service) before multi-service or tiered packages |
| Retail inventory | Sell retail as a simple line item; no stock or COGS |
| Financial analysis (R) | P&L, cash flow and the five owner KPIs; defer cohorts and forecasting |
| CMS editorial depth | A fixed set of page templates; defer the composable block library |

**Never the answer:** cutting tests on the money paths, shipping without the parallel run, or
launching before the external gates in §8 clear.
