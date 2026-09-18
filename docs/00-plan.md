# BeRelax Platform — Master Plan & Phased Roadmap

## 1. What we are building

A single, self-hosted platform covering the full operating surface of a one-location UAE
massage and spa business: taking bookings, running the front desk, managing client
relationships, paying and scheduling staff, keeping the books to FTA standard, reporting on
the money, and acquiring customers through organic search.

## 2. Confirmed constraints

| Decision | Value |
|---|---|
| Jurisdiction | **United Arab Emirates** (Dubai / Sharjah / Abu Dhabi) |
| Locations | **One, permanently.** No branches, no franchise, no multi-tenancy |
| Service model | **In-parlour only.** Treatments happen in rooms at the premises |
| Hosting | DigitalOcean |
| Database | DigitalOcean **Managed PostgreSQL** |
| Email | **Resend** |
| SMS | **SMSala** |
| Card payments | Required **later**, not at launch |
| Languages | English primary, Arabic (RTL) planned |
| Staff scale | ~5–25 therapists |

Explicitly out of scope: home/hotel outcall, mobile therapists, travel-time scheduling,
multi-branch, franchise reporting.

## 3. Honest framing before the phases

Three things need saying before a roadmap is credible.

**This is several products, not one.** A booking engine, a marketing automation platform, an
accounting system, an HR system and an SEO agent are each a company in their own right. The
full requested scope is roughly **40–50 engineer-weeks**: about 10–12 months for one capable
full-stack engineer, or 6–7 months for two working in parallel after the foundations land.
Anyone promising materially less is either cutting a module or cutting the parts that make it
trustworthy with money and law.

**Two of the nine modules should be integrated rather than built.** Statutory VAT filing and
payroll mechanics are commodity, heavily regulated, and change under you. The plan builds an
internal double-entry journal — because operational truth must live in your own database and
retrofitting one is brutal — but hands statutory filing to an FTA-ready package (Zoho Books
is the pragmatic UAE choice) and hands payroll mechanics to a reviewed export. You get the
management reporting you want without becoming responsible for tracking every FTA rule change
in code. Building the booking engine and CRM *is* justified: they are where your operational
difference lives, and no off-the-shelf product will model your rooms, your gender-matching
constraint and your intake flow the way you need.

**The sequencing in the original brief has one error.** "Design the frontend and CMS last" is
right for the *marketing site* and wrong for the *booking interface*. A booking engine with no
UI cannot be validated, cannot be used by the front desk, and cannot take a single dirham. The
plan therefore splits the frontend in two: a deliberately plain but real booking UI and admin
calendar in Phase 1, and the designed marketing site plus CMS in Phase 8. It also flags a
consequence of deferring content: organic search compounds slowly, so pushing all content to
month seven delays organic revenue by roughly that much. Phase 1 includes a minimal static
marketing shell with correct structured data for that reason — it is cheap, and it starts the
clock.

## 4. The phases

Each phase states the business outcome it produces. A phase that does not move a business
number should be challenged.

---

### Phase 0 — Foundations (2–3 weeks)

Repo, monorepo layout, TypeScript strict, lint/format, CI on GitHub Actions, four
environments, DigitalOcean provisioning (App Platform, Managed Postgres with standby, Spaces,
Cloudflare), secret management, structured logging, error tracking, the migration pipeline,
the audit-log service, the transactional outbox, the durable job queue, staff auth with TOTP
2FA, the RBAC model, and the two singleton tables (`legal_entity`, `premises`).

Also in Phase 0, and just as important: the **`regulatory_profile`** row — a single versioned
config record carrying licence class, emirate, legal form, VAT status, retention years,
permitted public vocabulary and required credential types. Every module reads policy from it.
It defaults to the *stricter* of the wellness and healthcare profiles so a late answer from
the lawyer cannot produce a non-compliant system.

**Outcome:** a deployable skeleton with auth, audit, jobs and compliance policy in place.
Nothing customer-facing. This phase exists so that the following ten do not each reinvent it.

**Start in parallel:** every external lead-time item in [docs/05-external-dependencies.md](05-external-dependencies.md).

---

### Phase 1 — Booking engine and the front desk (5–7 weeks) ← *the revenue phase*

The core of the system and the hardest engineering in the project.

- Service catalogue configurable in admin: categories, services, duration/price variants,
  add-ons, therapist skill mapping, room-type compatibility, per-service turnaround.
- Rooms as first-class schedulable resources, including capacity-2 couples rooms, room types
  and housekeeping turnaround as scheduled non-bookable time.
- The availability engine: opening hours, closures, lunar public holidays, therapist shifts,
  skills, **same-gender matching as a hard constraint (default strict)**, credential validity,
  buffers, lead time, booking window.
- Concurrency correctness: `btree_gist` exclusion constraint on therapist time ranges, a
  deferred constraint trigger for room capacity, idempotency keys on the public endpoint.
- Appointment lifecycle state machine with every transition, actor and side effect defined.
- Phone-first identity: E.164 normalisation, SMS OTP with rate limiting and enumeration
  resistance, guest booking with no account, a stable `customer_id` regardless.
- Public booking flow (plain, mobile-first, accessible, real) and a minimal marketing shell
  with correct `DaySpa`/`LocalBusiness` structured data.
- Admin day/week calendar: room × time as the primary grid, therapist × time secondary,
  drag to reschedule, quick-book, walk-in and phone-booking entry.
- Transactional messaging: confirmation, reminder at 24h and 2h, reschedule, cancellation —
  via SMSala and Resend, on the durable queue, with invalidation on reschedule or cancel.
- Self-service manage-booking page via a magic link, so customers reschedule without calling.

**Outcome:** the business takes online bookings and the front desk runs the day off the
system. This is the first phase that earns money.

---

### Phase 2 — Checkout, invoicing and money-in (3–4 weeks)

- Till/checkout screen: complete a visit, add retail, apply a discount, record payment by
  cash, in-salon card machine or bank transfer. No gateway yet — a manual payments adapter so
  the ledger is correct before any card integration exists.
- **FTA-compliant tax invoices** and simplified tax invoices: bilingual, with TRN and issuing
  address snapshotted, gap-free sequential numbering allocated inside the insert transaction,
  per-line VAT at 5%, gross-first integer-fils money.
- Credit notes as the only correction mechanism. No invoice is ever edited or deleted.
- Gift vouchers, prepaid packages and memberships as **deferred revenue liabilities**, with
  redemption, balance tracking, expiry and breakage.
- Cash drawer reconciliation per shift.
- Rebooking prompt at checkout — the single biggest revenue lever in the industry.

**Outcome:** every dirham is recorded, and the documents you hand an auditor exist and are
correct. Deferred revenue stops being invisible.

---

### Phase 3 — CRM, consent and automation (4–5 weeks)

- Client record: preferences (pressure, oils, therapist, room temperature), tags, lifecycle
  stage, source, visit and spend history, VIP and blocklist flags.
- **Intake and consent forms behind the clinical data boundary**: own Postgres schema, own DB
  role, envelope encryption, UUID-only references, no cross-boundary foreign keys, separate
  RBAC and separate audit log. The booking layer sees boolean contraindication flags only —
  never free-text health notes.
- Duplicate detection and merge, including re-pointing consents, suppressions, enrolments and
  ledgers to the surviving record.
- Consent as a first-class object: per channel, per purpose, timestamped, with the exact
  wording version shown. A preference centre reachable without login.
- Automation engine: event-driven, on the outbox and job queue, with a flow definition DSL,
  enrolment state, versioning, and hard rails — global per-contact frequency cap, quiet hours,
  suppression and consent evaluated at **send** time, loop detection, kill switch, dry-run.
- Drag-and-drop: the Kanban lead/client pipeline first (cheap, immediately useful), the
  node-graph journey builder second (React Flow) once the engine is proven.
- SMS campaigns behind the **TDRA compliance gate** (see Phase gating below).
- Review solicitation, win-back, birthday and lapsed-client triggers.

**Outcome:** retention levers are live and rebooking rate, churn and segment performance
become measurable.

---

### Phase 4 — Accounting and recurring costs (4–5 weeks)

- Chart of accounts for a spa; append-only double-entry journal; period locking; corrections
  by dated reversal only.
- Purchases, suppliers, expense capture with receipt images, approval limits, payables ageing.
- **Recurring-cost register** — rent, DEWA, salaries, licences, insurance, SaaS, DigitalOcean,
  Resend, SMSala — with frequency, next-due, vendor, category, contract end, renewal reminder,
  fixed-vs-variable split, and budget-versus-actual variance alerting.
- **Reverse-charge VAT on imported services** (DigitalOcean, Resend, Google, Meta, Anthropic),
  incurred from day one and the single most commonly missed UAE obligation at this size. A
  nightly job flags any offshore bill lacking reverse-charge entries.
- VAT201 working papers: GL accounts tagged with return-box codes, drill-down to source
  documents, preparer/reviewer sign-off. **The system never files anything** — that capability
  is absent from the codebase, not merely disabled.
- Blocked input VAT classification. Inventory and COGS for retail and professional-use stock.
- The **compliance calendar**: VAT returns, trade licence, municipality permit, insurance,
  per-employee visa and labour card, therapist certifications, corporate tax, WPS runs — each
  with configurable lead time, owner and escalation. Blocking obligations change system
  behaviour when overdue.
- Export/integration to Zoho Books for statutory filing.

**Outcome:** the VAT return is prepared from the system rather than from a spreadsheet, and
the true cost base — including the subscriptions nobody remembers — becomes visible.

---

### Phase 5 — HR and leave (3–4 weeks)

- Employee records with field-level encryption on bank details and identity document numbers.
- **Credential registry driving availability**: visa, labour card, Emirates ID, occupational
  health card, qualifications. An expired mandatory document automatically removes the
  therapist from bookable availability and flags their future appointments for reassignment.
  This automation is the module's main value.
- Rota and shift publishing, swaps, open shifts, labour-cost forecast against booked revenue.
- Attendance and timesheets; scheduled vs actual vs billed hours.
- **Leave management**: leave types with distinct accrual, carry-over and expiry; UAE 30-day
  annual entitlement and sick-leave tiers; approval workflow with delegation; minimum-coverage
  rules; a team calendar; and the critical link that approving leave blocks therapist
  availability and surfaces conflicts with existing bookings.
- Commission (transparent, versioned, auditable — this is where staff disputes happen), tips,
  deductions, payslips, **end-of-service gratuity accrued monthly as a balance-sheet
  liability**, and a WPS salary-file export reviewed by a human.
- Ramadan reduced hours as a dated override; provisional-versus-confirmed lunar holidays.

**Outcome:** leave and labour cost are controlled, and the expired-visa risk — an existential
compliance problem for a UAE small business — is automated away.

---

### Phase 6 — Analytics and measurement (2–3 weeks)

- Measurement plan and event taxonomy first, then a single typed tracking SDK so events are
  not sprinkled ad hoc.
- GA4 and Meta Pixel client-side; **server-side push driven from the transactional outbox** to
  the GA4 Measurement Protocol and Meta Conversions API, with a shared `event_id` for dedup and
  properly hashed user data.
- Google **Consent Mode v2** and a CMP, gating client tags *and* server pushes. A server-side
  push that ignores consent is the classic compliance hole.
- **Offline conversion loop**: most revenue is confirmed at the till, so completed and paid
  bookings and no-shows are pushed back with corrected values. Booking value at booking time
  is a guess; the till knows the truth.
- **Analytics egress guard**: services map to opaque allowlisted category codes and any
  health-adjacent parameter is stripped, with a test enumerating every service. Health data
  must never reach Google or Meta.
- Recommendation: skip a server-side GTM container. A first-party `/api/collect` route inside
  the app gives first-party cookies and ad-blocker resilience at a fraction of the cost and
  maintenance. Revisit only if tag complexity genuinely demands a container.

**Outcome:** marketing spend becomes attributable to completed, paid bookings rather than to
form submissions.

---

### Phase 7 — Financial analysis (2–3 weeks)

- A small star-shaped reporting schema inside the same Postgres, refreshed by materialised
  views. No warehouse, no read replica, no BigQuery — the data volume does not justify them.
- Statutory-shaped reports: P&L, balance sheet, cash-flow statement (profit and cash are not
  the same number, and the owner will not otherwise see it).
- The KPIs that actually run a spa, each with an explicit formula: therapist utilisation, room
  utilisation, **revenue per available room-hour**, average ticket, retail attachment,
  **rebooking rate at checkout**, new-versus-returning mix, retention by cohort, LTV,
  no-show cost, discount leakage, labour cost %, **contribution margin per service** (which
  services are actually profitable once commission and room time are costed — this usually
  surprises owners), break-even per day, outstanding voucher liability, CAC and payback.
- Forecasting: seasonality including Ramadan and the summer exodus, cash-flow forecast from
  the recurring-cost register plus forward bookings and payroll.
- Pushed alerts: revenue below forecast, no-show spike, utilisation collapse, cost drift,
  unexpected VAT liability build-up.
- Role-scoped dashboards — owner (five numbers on a phone), manager, accountant, therapist —
  with drill-down to source rows, and a data-quality view that refuses to show a number the
  system cannot reconcile.

**Outcome:** the owner sees the state of the business daily without asking anyone.

---

### Phase 8 — CMS and the designed public site (5–7 weeks)

- Payload CMS v3 embedded in the same Next.js app on the same Postgres — one deployment, one
  database, no second source of truth.
- Content model with a clear boundary: the **catalogue** owns price, duration and bookability;
  the **CMS** owns narrative, media and SEO copy. Service pages join the two.
- Design system (Tailwind + shadcn/ui), EN/AR with real RTL, WCAG 2.2 AA, explicit performance
  budget and a Core Web Vitals regression gate in CI.
- SEO: JSON-LD generated from the database so it cannot drift from reality, title/meta patterns
  from the catalogue, hub-and-spoke topic clusters, sitemaps with CMS-driven `lastmod`,
  hreflang, redirect-on-slug-change, IndexNow.
- **LLM/AI-answer-engine optimisation**: clean server-rendered HTML (not a client-rendered
  SPA — see the note in [docs/02-architecture.md](02-architecture.md)), question-shaped headings
  with stable anchors, high factual density, a machine-readable facts endpoint so price, hours
  and location are consistent everywhere, a considered `robots.txt` policy for AI crawlers, and
  brand-citation monitoring in AI answers as a tracked KPI.
- **Publication control plane**: draft → automated compliance lint (banned medical claims,
  forbidden staff titles, controlled vocabulary from the regulatory profile) → named human
  approval → publish, with an immutable publication record carrying the content hash. Runs
  over service names and descriptions too: a service called "Therapeutic Deep Tissue Treatment"
  is a regulatory claim, so public display names are linted separately from internal names.
- Publish pipeline: on-demand ISR revalidation, sitemap update, IndexNow ping, CDN purge.

**Outcome:** an organic acquisition channel exists, and nothing publishable can breach the
licence conditions.

---

### Phase 9 — The agentic SEO system (2–3 weeks)

- Google Search Console API integration with nightly snapshots into Postgres, building the
  16-month-plus history GSC itself discards.
- Deterministic analysis first, LLM only for judgement and drafting: CTR outliers at positions
  5–20, content gaps, cannibalisation, coverage regressions, internal-link audit, structured-data
  validation, and a check that on-site price and hours match Google Business Profile.
- **Propose-only by construction.** The agent writes to a suggestions table or opens a pull
  request. It has no publish capability *at the permission layer* — not a prompt instruction, an
  API permission. It may never touch `robots.txt`, canonicals, redirects or `noindex`. Keyword
  expansion is filtered against the blocking lexicon so non-compliant terms never surface as
  tempting opportunities. Fetched competitor pages and SERP content are treated as untrusted
  data, never as instructions.
- Deliverable the owner actually wants: a weekly plain-English report with five prioritised
  actions, what changed, and what it earned — emailed via Resend.

**Outcome:** a prioritised SEO worklist every week, with a human deciding what ships.

---

### Phase 10 — Card payments (3–4 weeks)

Deliberately late in the build, but the **merchant-account conversation starts in Phase 0**
because onboarding for this merchant category takes weeks and can stall.

- Gateway integration behind the payments abstraction built in Phase 2 (Stripe, Telr,
  N-Genius, Checkout.com, PayTabs — chosen on AED settlement, local acquiring and the MCC the
  acquirer will actually grant). Tabby/Tamara for packages.
- Deposits, prepayment for first-time clients, saved cards, and no-show/late-cancellation fees
  with the explicit disclosed consent that makes them defensible.
- PCI SAQ-A scope only: hosted fields, never touching card data.
- Webhooks with signature verification, idempotent handlers, replay protection and a
  reconciliation job for missed events. Client-side success callbacks are never the source of
  truth.
- Settlement reconciliation: gross vs net of fees, timing differences, refunds, chargebacks.
- A discreet, configurable statement descriptor — a genuine product requirement for this
  business, not a joke.

**Outcome:** revenue protection against no-shows, and online prepayment.

---

### Phase 11 — Hardening and the things that keep it alive (ongoing, ~3 weeks concentrated)

Penetration test, restore drill from backup (an untested backup is not a backup), DR runbooks,
key rotation procedure, incident-response plan with PDPL notification timelines, WhatsApp
Business API as the channel this market actually reads, dependency and secret scanning, and the
documentation set: admin guide, therapist quick guide, accountant guide, the data-processing
register and the ADR log.

---

## 5. Gates

Some phases must not ship without an external answer. These are hard gates, not warnings.

| Gate | Blocks | Needed from |
|---|---|---|
| Health-data residency answer | Go-live with real intake data (Phase 3) | UAE lawyer |
| Licence classification | Any public copy going live (Phase 1 shell, Phase 8) | Economic dept + health authority |
| Same-gender matching requirement | Availability engine sign-off (Phase 1) | Licensing authority, in writing |
| Two registered sender IDs | First marketing campaign (Phase 3) | SMSala + e& + du |
| Tax-invoice field list confirmed | First invoice issued (Phase 2) | FTA-registered tax agent |
| Merchant category code in writing | Payments build (Phase 10) | Acquirer |

## 6. Effort and team

| Phase | Weeks | Cumulative |
|---|---|---|
| 0 Foundations | 2–3 | 3 |
| 1 Booking + front desk | 5–7 | 10 |
| 2 Checkout + invoicing | 3–4 | 14 |
| 3 CRM + automation | 4–5 | 19 |
| 4 Accounting | 4–5 | 24 |
| 5 HR + leave | 3–4 | 28 |
| 6 Analytics | 2–3 | 31 |
| 7 Financial analysis | 2–3 | 34 |
| 8 CMS + public site | 5–7 | 41 |
| 9 SEO agent | 2–3 | 44 |
| 10 Payments | 3–4 | 48 |
| 11 Hardening | ~3 | 51 |

Roughly **40–51 engineer-weeks**. One engineer: 10–12 months. Two: 6–7 months, with Phases 4–7
parallelising well once Phase 2 lands. A designer is needed for ~3 weeks before Phase 8, and an
FTA-registered tax agent should review Phase 4's output before the first return is filed.

Bus factor of one is the largest programme risk. ADRs, tests on the money paths and a written
runbook set are the mitigation, and they are in the plan for that reason.

## 7. Run cost

At launch, roughly **USD 120–190/month**: App Platform web (2 instances) and one worker,
Managed Postgres 2 vCPU / 4 GB with standby, Spaces + CDN, Cloudflare, Sentry, plus per-message
SMS and email. Note that Arabic SMS is UCS-2 — 70 characters per segment instead of 160 — so an
Arabic campaign costs roughly double per message. LLM spend for the SEO agent is small at
weekly cadence. Budget separately for the annual penetration test and the Zoho Books licence.
