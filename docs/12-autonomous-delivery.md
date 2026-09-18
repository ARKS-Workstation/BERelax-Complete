# Autonomous Delivery — the contract and the harness

How the build runs unattended, what happens to work that needs the owner, and how completion is
evidenced.

---

## 1. The deferred-scope contract

**Owner's instruction:** *for the things you can't do now, keep the scope of it and continue; once
you're done, we deploy and check.*

"Keep the scope" is precise, and means all five of these — not just "leave a TODO":

| # | Requirement | Why |
|---|---|---|
| 1 | **The real interface exists.** Every external dependency is defined by the interface the real adapter will implement — not shaped around the fake | A fake shaped differently from reality means the real integration is a rewrite, which is the opposite of keeping scope |
| 2 | **A fake adapter that behaves like the real thing**, including its failures — rate limits, rejections, delivery receipts, webhook replays, `invalid_grant` | A fake that only ever succeeds hides every error path. The error paths are most of the work |
| 3 | **A feature flag defaulting to the fake**, flipped by config, never by a code change | This is what makes "deploy and check" a configuration exercise rather than a release |
| 4 | **An `OPEN-QUESTIONS.md` entry** naming what is needed, from whom, and what it blocks | So nothing is remembered only by me, and nothing is silently dropped |
| 5 | **Provisional values marked provisional**, never silently defaulted | See §2 — this is the mechanism that makes the final check tractable |

Two prohibitions that follow:

- **A stub must never look like it works.** No no-op that returns success. A fake sends to a local
  outbox that is visible in the UI and in screenshots; it does not pretend to have sent an SMS.
- **No business rule gets invented.** If a unit needs a turnaround time, a cancellation window or a
  commission rate, it uses a **provisional value marked as such** and records the question. It does not
  guess silently and it does not stall the build.

## 2. The Unconfirmed Assumptions panel

This is how §1.5 pays off, and it is a real feature rather than a document.

Every provisional value — business rule, legal position, external credential, placeholder asset —
carries `provisional: true` and a note on *why* and *who confirms it*. An admin screen lists them all:
what the system is currently assuming, what it affects, and a field to confirm or correct.

So at deploy-and-check time there is **one screen** listing everything to settle, rather than an
archaeology exercise across eleven documents. Each confirmation is an audited settings change.

**Provisional values are always the strictest safe option**, never the convenient one. Same-gender
matching defaults strict. Marketing consent defaults false. Retention defaults to the longer period.
Quiet hours default to the narrower window. If a provisional value is never corrected, the system is
conservative rather than non-compliant.

---

## 3. What gets faked, and what that unlocks

| Real provider | Fake behaviour | Visible where |
|---|---|---|
| **SMSala** | Local outbox with segment/encoding/cost calculation, GSM-7 vs UCS-2 detection, simulated DLRs, simulated rejection and sender-ID suspension | An admin "Messages" inbox, and in screenshots |
| **Resend** | Local mail outbox, rendered HTML preview, simulated bounce and complaint webhooks | Same inbox, with an HTML preview pane |
| **Google GBP** | Fixture reviews at each star rating including star-only-no-text, simulated `updateReply`, simulated `access_not_granted` and quota-zero | Autoresponder queue in draft mode |
| **Google GSC** | Fixture Search Analytics rows with realistic CTR/position distributions and the rare-query filtering gap | SEO agent's weekly report |
| **Google OAuth** | Fake consent + account/location picker, simulated `invalid_grant` and 7-day expiry | The re-auth banner and health panel — testable without a Google account |
| **Payment gateway** | Manual/cash adapter is real; a fake card gateway with 3DS, webhook replay, partial refund, chargeback | Checkout and settlement reconciliation |
| **LLM providers** | Deterministic canned responses per prompt-hash, plus a live mode behind a flag | Review drafts and SEO suggestions |

The unlock: **the entire system is buildable, testable and demoable with zero external credentials**,
every error path is exercisable on demand, and no non-production environment can physically reach a real
customer because no real transport is wired.

---

## 4. Repo-as-memory

I carry nothing between sessions, so these are infrastructure, not documentation:

- **`build/manifest.yaml`** — the work units: id, `depends_on`, acceptance criteria as executable
  checks, status, owner, expected screenshots. Next unit = topological sort filtered by status. No
  judgement call about what to do next.
- **`docs/PROGRESS.md`** — the ledger: done, in progress, blocked and on what, next three units.
- **`docs/OPEN-QUESTIONS.md`** — everything awaiting the owner or a third party, with what each blocks.
- **`docs/adr/NNNN-*.md`** — one per real decision, starting with the decisions already locked in
  [01-scope-and-decisions.md](01-scope-and-decisions.md).
- **The test suite** — the only durable proof the money and compliance paths are right.

---

## 5. Evidence: seed, screenshots, and reading my own output

**Deterministic seed and frozen clock.** A fixture salon — 12 services, 5 rooms, 8 therapists with
skills, genders and languages, a published rota, ~200 historical and 40 forward bookings, packages at
several drawdown states, invoices, one closed month. The clock is frozen so "today" is stable, which is
what makes screenshots diffable. Synthetic data only; health fixtures obviously fake.

**Screenshot harness.** Playwright against the pre-installed Chromium. Per route: 3 viewports
(390 / 768 / 1440) × 2 themes × 2 directions where applicable. Animations disabled, fonts awaited,
network idle, deterministic filenames. A generated `gallery.html` groups by page with theme and
direction side by side, published as a **private Artifact** so review is one link on a phone.

**The self-critique pass.** Screenshots are a feedback signal, not just evidence. After capture, each
shot is reviewed against [08-frontend-design.md](08-frontend-design.md): is body text sitting on a
pastel surface, is the mobile hero using the 4:5 portrait crop or a squashed landscape, is RTL genuinely
mirrored rather than translated, is the 68ch measure holding, are touch targets 48px, does dark mode read
warm rather than inverted. Findings become fix units in the manifest.

Without this pass, unattended work produces a site that passes every test and looks wrong.

**Placeholder media.** Until the photo library passes its audit, heroes use palette-matched placeholders
at correct aspect ratios. Deliberate: layout truth should not wait on photography, and
placeholder-at-correct-ratio exposes crop problems a real image would disguise.

---

## 6. Gates — CI is the only arbiter

Never my assessment that a unit is done.

typecheck · lint · unit · **integration against real Postgres** (exclusion constraints cannot be tested
against a mock) · Playwright e2e on the booking happy path and top failure paths · axe accessibility ·
Lighthouse CI budget that fails the build · visual regression diff · and the domain invariant suites:
no double-booking, no room over capacity, VAT gross/net round-trip, leave accrual worked examples,
commission reproducibility, ledger balance, consent gating as an invariant.

A unit is done when its manifest acceptance checks pass in CI.

---

## 7. Guardrails for unattended running

- Feature branch only. Never force-push. Never touch the default branch.
- No real external sends — structural, via §3, not a promise.
- No secrets committed. No production deploy.
- **Never invent a business rule** — provisional value plus a recorded question, then continue.
- **Never weaken a test to make it pass.** A red gate is a fix, not a threshold to adjust.
- **One blocked unit never stalls the loop.** Skip to the next unblocked unit.
- Hard stop and ask: two consecutive sessions with no unit completed, or one gate failing three times.

## 8. Sequencing the automation itself

| Mode | Units | Why |
|---|---|---|
| **Attended** | Foundation, availability engine, VAT and ledger | Schema and money decisions are expensive to get wrong and are where owner input changes the answer |
| **Semi-attended** | CRM, People, Analytics, Reporting | Build unattended, review at each milestone demo |
| **Fully automatic** | Public site and CMS page build-out | Most repetitive, most screenshot-visible, where the harness pays back hardest |

## 9. Per-run output

Green CI or a named failure · updated `PROGRESS.md` · a gallery link · and the current list of what is
blocked on the owner.

## 10. Deploy and check

When the build is complete:

1. Deploy to staging on DigitalOcean with every provider still faked.
2. Walk the **Unconfirmed Assumptions panel** together — one screen, every provisional value.
3. Flip providers to real one at a time as credentials arrive, each a config change.
4. Then the Stage 9 sequence in [11-execution-plan.md](11-execution-plan.md): migration dry runs,
   parallel run, staff pilot, go/no-go.

The honest statement of what "done" means under this contract: **the system is complete and provable;
it is not live.** Real photography, the Google connection, SMS sender IDs and the tax-agent review are
owner-side, and the panel in §2 is the list.
