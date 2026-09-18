# Execution Plan — Step by Step

**Claude builds this.** There is no engineering team, so this plan is not measured in engineer-weeks
and has no parallel tracks. It is a single-threaded dependency order, decomposed into **work units**
sized to one working session, with the repository as the memory between them.

Confirmed alongside this:

| Decision | Consequence |
|---|---|
| **Claude is the builder** | No parallelism. Strict dependency order. Verification, not typing, is the bottleneck |
| **No incumbent platform** — phone, WhatsApp, paper diary | No export to audit. But no export also means **outstanding packages and the customer list must be reconstructed** — see §7 |
| **Photo library already exists** | Removes the longest-lead dependency, **conditional on passing the week-0 audit** in §4 |
| **Owner's personal Gmail for Google** | Accepted. Raises the OAuth risk profile and makes one week-0 experiment a hard blocker — see §6 |
| **Packages only, configured in settings from day one** | No gift vouchers, no memberships. One prepaid product, one deferred-revenue liability, one migration artefact — see §7 |

---

## 1. What this model changes, and what it does not

**Unchanged.** The dependency graph is physics: checkout cannot precede the catalogue, reporting cannot
precede facts, reminders cannot precede the appointment lifecycle. The seven integration milestones,
the definition of done, the compliance controls and the external clocks are all exactly as specified in
[00-plan.md](00-plan.md).

**Changed.**

- **No parallel tracks.** Work proceeds in one order. Ordering therefore optimises for something new:
  putting work that needs *your* input early, so your review latency overlaps my build time rather than
  blocking it.
- **Engineer-weeks are the wrong unit.** Replaced by work units sized to a session, each independently
  verifiable.
- **The repository is the memory.** I do not carry context between sessions. Anything not written to the
  repo — a decision, a rationale, a half-finished intent — is lost. That makes ADRs, a progress ledger
  and tests load-bearing infrastructure rather than good practice.
- **Verification is the bottleneck.** Writing code is fast; proving it correct is not. Tests and CI are
  the deliverable alongside the code, not a follow-up.
- **Some things I cannot do at all.** §2 is explicit about that, and it is the most important section
  in this document.

---

## 2. The split — what only you can do

I cannot act in the physical or legal world, hold your credentials, or certify UAE tax correctness.
These are yours, and **the build stalls on several of them**:

| # | Yours | Why it cannot be delegated | Blocks |
|---|---|---|---|
| Y1 | **Send me the trade licence** and any municipality / health-authority approval | I need to read the actual document to set `licence_class` and the permitted vocabulary | Foundation, all public copy |
| Y2 | **Find out which Google account owns the GBP listing**, and at what role | Requires signing into accounts I have no access to. May be a former agency | Everything Google |
| Y3 | **Submit the GBP Basic API Access application** | Must come from an owner/manager account | Autoresponder API mode |
| Y4 | **Run the 9-day OAuth token experiment** | Requires consenting with your Google account | **Hard blocker — see §6** |
| Y5 | **Ask the lawyer the health-data residency question** | One question, but it must come from the client | Hosting region; loading real intake data |
| Y6 | **Register two SMSala sender IDs** | Commercial application in the business's name | Campaigns |
| Y7 | **Open the acquirer conversation**, two providers, MCC in writing | Commercial | Payments |
| Y8 | **Provide the handover pack** — §7 | Only you have it | Booking, Money, People, migration |
| Y9 | **Confirm the availability rules** — same-gender matching, turnaround times, cancellation windows | Business rules I must not invent | Booking engine sign-off |
| Y10 | **Complete the OAuth consent** and confirm the location picker shows the right listing | Your account, your listing | Google connection |
| Y11 | **Have an FTA-registered tax agent review the VAT working papers** | **I cannot certify tax correctness. This is not negotiable** | First VAT return |
| Y12 | **Run the staff pilot** and tell me what the front desk complains about | Requires real staff on a real floor | Cutover |
| Y13 | **Book the penetration test** | Commercial engagement | Go-live |
| Y14 | **Test on real devices** — your phone, your staff's phones, real Safari on real iOS | I can test logic, not a specific device's rendering or SMS autofill | Launch confidence |

Everything else — schema, code, tests, migrations, infrastructure-as-config, documentation, the agents
— is mine.

---

## 3. The operating model

**Session protocol.** Every session: read `docs/PROGRESS.md` for state → pick the next unit in
dependency order → build it with tests → run the full CI gate locally → update `PROGRESS.md` and write
an ADR if a decision was made → commit and push. A session that ends without updating the ledger has
lost work even if the code is committed.

**Repo-as-memory artefacts**, created in the Foundation stage and maintained thereafter:

- `docs/PROGRESS.md` — the unit ledger: done, in progress, blocked and on what, plus the next three units.
- `docs/adr/NNNN-*.md` — one per real decision, including the ones already locked in
  [01-scope-and-decisions.md](01-scope-and-decisions.md).
- `docs/OPEN-QUESTIONS.md` — everything waiting on you or on a third party, with what is blocked by each.
- The test suite — the only durable proof that the money and compliance paths are right.

**Definition of done per unit** (from [00-plan.md](00-plan.md) §6): tests written and passing · migration
reviewed · permissions applied at field level where sensitive · audit logging where it applies · i18n
keys extracted · analytics events emitted · accessibility checked · CI green · ledger updated.

**Drift control.** If I find that something in the plan is wrong once real code meets it, I change the
plan document and say so, rather than quietly diverging. The docs staying true is what makes the next
session possible.

---

## 4. Stage 0 — before any code

Still a full stage, still the highest-leverage work in the project. The clocks here are external and
cannot be compressed later.

| # | Step | Owner |
|---|---|---|
| 1 | **Handover pack** — see §7 for the full list, including the reconstruction work your setup implies | You |
| 2 | **Trade licence** read; `regulatory_profile` inputs set | You send, I read |
| 3 | **Who owns the GBP listing** | You |
| 4 | *(Workspace seat — declined; see §6 for what replaces it)* | — |
| 5 | **Submit GBP Basic API Access** | You |
| 6 | **The 9-day token experiment — start it in week 0.** With a personal Gmail this is a hard blocker, not a curiosity | You |
| 7 | **Lawyer: health-data residency** | You |
| 8 | **Two SMSala sender IDs** | You |
| 9 | **Acquirer / MCC, two providers** | You |
| 10 | **Baseline the existing site** — crawl, ranks, GSC export. *I can do this if the site is public* | Me |
| 11 | **Confirm `btree_gist`** on DO Managed Postgres | Me |
| **12** | **AUDIT THE PHOTO LIBRARY — do this in week 0, not week 20** | Me, from what you send |
| 13 | *(Incumbent export audit — not applicable)* | — |

### Step 12 deserves its own note

You have a full library, which removes the longest-lead dependency in the plan — **if it passes.**
Existing libraries commonly fail on three things, and each has a different remedy:

1. **Mobile portrait crops.** A landscape image CSS-cropped to a phone looks bad, and the design uses
   genuine art direction via `<picture>` with a 4:5 mobile crop. If the library is all landscape with
   subjects centre-framed, the mobile hero has no usable crop.
2. **The pastel grade.** The palette expects the deepest in-frame value around `#3A3B37`, never pure
   black, with greens desaturated 10–15%. A punchy high-contrast library fights the design and also
   costs more bytes ([08](08-frontend-design.md) §8).
3. **Negative space for text overlay.** Hero images need deliberate empty area. Photos composed to fill
   the frame have nowhere for the headline to go.

**So the audit happens in week 0 with a pass/fail verdict per slot.** If it fails, you still have the
full lead time to shoot rather than discovering it when the site is being built. Send me a
representative sample — 15–20 images covering hero candidates, therapist portraits, rooms, treatment
detail — and I will report against each slot's constraints.

Also needed regardless: **staff photography consent on record** for anyone identifiable, which connects
to the therapist-page archival path in [09](09-ia-seo-and-settings.md) §2.

---

## 5. The build order

Single track. Steps 14–118 from the previous revision retain their numbers and content; what changes is
that they run in one sequence rather than two. Grouped into units, ordered so your inputs land early.

| Order | Units | Steps | Gate |
|---|---|---|---|
| **1** | Foundation | 14–25 | Migration through CI to prod · audited mutation logged · outbox reaches worker · 2FA login · **Arabic PDF renders** |
| **2** | Repo-as-memory | new | `PROGRESS.md`, ADRs for the 20 locked decisions, `OPEN-QUESTIONS.md` |
| **3** | Catalogue + rooms | 26–27 | Seeded from your real menu and room inventory |
| **4** | **Availability engine** | 28–29, 32 | **Property-based tests green.** The single most important gate in the build |
| **5** | Appointment lifecycle + identity | 30–31 | State machine transitions tested exhaustively |
| **6** | Booking UI + admin calendar | 33–34 | **M1 Bookable** |
| **7** | Transactional messaging | 35–36 | Reminder invalidation on reschedule proven |
| **8** | Till + invoicing + ledger | 52–57 | **M2 Bankable** |
| **9** | Purchases + recurring costs + VAT | 58–64 | Working papers generated → **Y11: tax agent review** |
| **10** | CRM + clinical boundary + consent | 43–46 | Consent gating tested as an invariant |
| **11** | Automation engine + compliance gate | 47–51 | **M3 Reachable** |
| **12** | People: credentials, rota, leave | 65–72 | **M6 Staffed** |
| **13** | Analytics + egress guard | 73–77 | **M7 Attributable** |
| **14** | Reporting + dashboards | 78–82 | **M5 Accountable** |
| **15** | Design system + CMS + media | 37–42, 89–90 | Photo library passing, breakpoint preview working |
| **16** | Public site + SEO + publication plane | 91–97 | **M4 Findable** |
| **17** | Google connection + health/re-auth | 98, 101 | **Y10: you complete consent and confirm the listing** |
| **18** | Review autoresponder, fallback mode | 99 | Safety routing table enforced; linter blocking |
| **19** | SEO agent | 100 | Publish denied at the permission layer; injection test fails to escalate |
| **20** | Payments *(if MCC cleared)* | 83–88 | Settlement reconciles to the fils |
| **21** | Hardening | 102–105 | Pen test triaged · **restore drill passed** |
| **22** | Migration dry runs ×3 | 106 | No unexplained variance in the reconciliation report |
| **23** | Parallel run + staff pilot | 107–109 | **Y12: front-desk feedback acted on** |
| **24** | Freeze, go/no-go, cutover | 110–112 | Every external item cleared |
| **25** | Post-launch | 113–118 | Paper fallback · 4-week SEO window · first VAT return |

**Note the reordering.** Money moved ahead of CRM, and the public site moved late. Two reasons: the
tax-agent review (Y11) has its own latency, so generating working papers early means that review runs in
the background; and the photo-library verdict from step 12 may change what unit 15 involves.

---

## 6. The Google decision, and its cost

You have chosen the owner's personal Gmail. That is your call and the plan accommodates it, but it is
worth being precise about what it changes, because one item becomes a genuine blocker.

**The OAuth app must be External.** With no Workspace organisation, the *Internal* audience is
unavailable — so the app cannot sidestep verification, and the **7-day refresh-token expiry in Testing
status is live**. Left unresolved, both agents stop every week with no correlated deploy.

**Therefore step 6 is a hard blocker, not a curiosity.** Publish to Production, consent, record
`consent_at`, and confirm on **day 9** that the same refresh token still works. Three outcomes:

| Result | Consequence |
|---|---|
| Token survives day 9 | Good. External + Production + unverified is the path. You see the "Google hasn't verified this app" screen once |
| Token dies at day 7 | Then `business.manage` verification is required — scope justification, demo video, privacy policy on a verified domain, domain ownership. **Weeks, with round-trips.** The Workspace seat returns as the cheaper escape hatch, and I would re-raise it at that point |

**Because it is a nine-day experiment, starting it in week 0 is what keeps it off the critical path.**
Started in launch week, it becomes the thing that delays launch.

**The safeguards now in scope**, from [10](10-google-connection.md) §5 — these move from "if they insist"
to required work:

- **A second GBP Owner** — spouse, co-founder or accountant — so the listing survives losing one account.
- **Hardware-key 2FA, or printed recovery codes in the business safe.** Not SMS to one phone.
- **Recovery email and phone the business controls.**
- **Search Console verified by DNS TXT** on Cloudflare, so SEO data survives losing the Google account entirely. This one is free and I will do it.
- **A note in the settings panel naming the connected account**, visible to whoever runs the business next.
- The daily health check and pre-emptive email, which turn *"the agents stopped in March"* into *"we were told on the 3rd"*.

One risk I previously overstated and will not repeat: a routine password change should **not** break the
connection, because Google ties that revocation to Gmail scopes, which we do not request. The real risk
is **offboarding** — which is also why Y2 matters so much.

---

## 7. The migration, with no incumbent platform

No export to audit is genuinely simpler in one way and harder in another: **there is no system of record
to migrate from, so several things must be reconstructed by hand.** Two of them are liabilities.

| Item | Where it lives now | Risk |
|---|---|---|
| **Outstanding packages / prepaid sessions** | Paper, a drawer, a notebook, memory | **Highest-risk item in the migration.** Real, enforceable liabilities held by real customers, with remaining-session counts to reconstruct. There is no export to fall back on |
| **Customer list** | Phone contacts, WhatsApp chats, paper cards | See the consent problem below |
| **Current leave balances** | Informal | The accrual engine needs an opening balance per employee, not zero |
| **Accounting opening balances** | The accountant | Needs a clean period boundary |
| **Service menu and prices** | Whatever is current | Must be authoritative before the catalogue is seeded |
| **Package definitions** | Whatever is sold today | Seeded as `package_template` rows in settings before any package balance is imported |
| **Room inventory and honest turnaround times** | Operational knowledge | The availability engine is wrong without real numbers |

Gift vouchers and memberships being out of scope removes two of the three prepaid liabilities and leaves
a single artefact to reconstruct. That is a material reduction in migration risk — the remaining one
still has to be right.

### The consent problem, which is not obvious

A customer list reconstructed from **WhatsApp chat history and phone contacts is not a marketing consent
list.** Someone messaging to book an appointment has given you a phone number for that purpose; it is
not opt-in to promotional SMS under PDPL, and under the TDRA rules in
[04-uae-compliance.md](04-uae-compliance.md) §5 promotional SMS needs demonstrable prior consent with
penalties reported up to AED 400,000.

So the migration imports these contacts with:

- **`marketing_consent = false`** on every reconstructed record, without exception.
- **Transactional messaging permitted** — booking confirmations and reminders for appointments they
  actually make.
- **A consent capture step** at the next booking or visit, storing the wording version shown.
- A one-time **opt-in campaign only if** your lawyer confirms a lawful basis for it. Do not assume one.

This is worth raising now because it is tempting to import 2,000 numbers and start marketing to them,
and that is precisely the thing that gets a sender ID suspended and a fine issued.

### The package reconstruction task

Make this a **named task with a deadline in week 0**, not a cutover-week scramble.

1. **Define the package templates first**, in settings: name, which service(s), number of sessions,
   price paid, validity period, whether transferable, and what happens to an unredeemed balance at
   expiry. Nothing can be imported until the shapes exist.
2. **Go through the physical records** and build one spreadsheet: holder name and phone, package
   template, price paid, purchase date, **sessions used to date**, sessions remaining, validity.
3. **Reconcile the total** to whatever cash was actually taken — the accountant may be able to
   corroborate from bank and till records. A package list that does not reconcile to money received is
   incomplete.
4. **Have the owner sign it off as complete.** That signed list becomes the opening liability balance,
   and the defence when someone appears in month three with a package nobody recorded.

Then decide — with the accountant — the policy for a package sold before the system existed whose paper
trail is thin: honour it, honour it once on evidence, or decline. Deciding that **before** the first
disputed case is much easier than during it.

---

## 8. What actually gates the calendar

Not typing speed. In order of real impact:

1. **Your inputs (Y1–Y14).** Most of the build can proceed without most of them, but Y1, Y8 and Y9 gate
   the first real units, and Y11 gates the VAT sign-off.
2. **External clocks.** GBP API approval (days to ~6 weeks), sender-ID registration, merchant
   onboarding, and possibly OAuth verification if the day-9 test fails.
3. **Verification depth.** The availability engine, VAT, leave accrual, commission and the ledger get
   property-based and worked-example tests because a bug in them costs money or breaks the law. That is
   deliberate time, not overhead.
4. **Review cycles.** Each milestone is demoed. Your feedback on M1, M2 and M6 in particular will change
   things, and it is cheaper to change them at the milestone than after.

I will not give you a month count for a build of this size under this model — it would be invented. What
I will do is keep `docs/PROGRESS.md` current so that progress is a fact you can read rather than an
estimate you have to trust, and flag in every session what is blocked and on whom.

---

## 9. The honest limits of this arrangement

Stated plainly, because they matter more than any schedule:

- **I cannot certify tax or legal correctness.** I can build a VAT engine that ties to the ledger and
  produces auditable working papers with tests for every rate and rounding case. Whether it satisfies the
  FTA for your business is a question for an FTA-registered tax agent, and Y11 is not optional.
- **I cannot test the physical world.** Real SMS arriving on a real UAE handset, SMS autofill on a
  specific iOS version, a receipt printer, how fast a receptionist can actually work. Y12 and Y14 cover
  what I cannot.
- **Nothing is in my head between sessions.** If the ledger and ADRs are not maintained, work is lost and
  decisions get silently re-made differently. That is why unit 2 exists.
- **A single builder has no second reviewer.** Tests are the substitute, and it is an imperfect one. On
  the money paths specifically, a human reading the VAT and commission logic before launch is worth
  buying even if nobody writes code.
