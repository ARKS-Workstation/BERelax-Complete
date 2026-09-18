# Autonomous Run Plan

How the build actually runs, session after session, from an empty repo to a complete system with
screenshot evidence. [12-autonomous-delivery.md](12-autonomous-delivery.md) is the *contract*; this is the
*runbook*.

---

## 1. The loop

Every session, without exception, in this order:

```
1  READ      docs/PROGRESS.md and build/manifest.yaml
2  SELECT    lowest `order` where status=todo and all depends_on are done
             └─ if it is `expand: true`, the session's job is to DECOMPOSE it into
                session-sized units with acceptance criteria, and stop there
3  CLAIM     set status=in_progress, commit the manifest alone, push
             └─ so a crashed session leaves a visible claim, not a mystery
4  BUILD     implement, with tests written against the acceptance criteria FIRST
5  VERIFY    pnpm verify  (the full local gate — see §3)
6  EVIDENCE  pnpm screenshots for any unit that changes a rendered route
7  CRITIQUE  read the screenshots back against docs/08; file fix units for defects
8  RECORD    status=done, regenerate PROGRESS.md, write an ADR if a decision was made,
             append to OPEN-QUESTIONS.md anything newly blocked on the owner
9  COMMIT    one commit per unit, message naming the unit id
10 PUSH      to claude/massage-crm-planning-c05j70
```

**Step 3 matters more than it looks.** Claiming before building means a session that dies mid-unit leaves
`in_progress` in the manifest. The next session sees the claim, inspects the diff, and either finishes or
resets it — instead of silently starting the same work twice.

**Step 7 is what prevents drift.** Tests prove behaviour; only the screenshots prove it looks right.

## 2. Selection rules

- **Strictly by `order`.** No cherry-picking interesting work.
- **`expand: true` units are decomposed, never built directly.** A group-level unit is a planning task.
  Decomposition is its own session and produces units with executable acceptance criteria.
- **`blocked_on_owner` does not block.** Use the provisional value from
  [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md), mark the setting `provisional: true`, and continue. Only a unit
  that is *impossible* without the owner — a real OAuth token, a real acquirer — is skipped, and it is
  skipped by moving to the next unit, never by waiting.
- **Fix units from the critique pass jump the queue** within the same workstream. Visual debt compounds.

## 3. `pnpm verify` — the local gate

One command, the same set CI runs, so a red CI is a surprise rather than routine:

```
typecheck · lint + import-boundary rule · unit tests · integration vs real Postgres
· domain invariants · axe on changed routes · palette gate (scripts/palette.py)
· bundle-size budget · Playwright e2e · visual regression
```

**Domain invariants** are the non-negotiable subset, and they run on every unit regardless of what changed:
no double-booked therapist · no room over capacity · nothing scheduled past close once turnaround is
counted · an after-midnight slot resolves to the correct business day · VAT gross↔net round-trip exact at
the fils · ledger always balances · leave accrual matches worked examples · commission reproducible from
versioned rules · **a send is impossible without valid consent, inside quiet hours, or to a suppressed
contact** · no health-adjacent field crosses the analytics egress guard.

A unit is `done` when every acceptance check in its manifest entry passes **in CI**. Never on my
assertion.

## 4. Evidence per session

| Artefact | Where |
|---|---|
| Screenshots, 3 viewports × 2 themes × 2 directions | `artifacts/screens/<unit>/` |
| `gallery.html` | published as a private Artifact; link in the session summary |
| CI result | GitHub Actions on the pushed commit |
| `docs/PROGRESS.md` | regenerated, never hand-edited |
| Newly blocked items | appended to `OPEN-QUESTIONS.md` |

The session summary is four lines: unit completed · gate result · gallery link · what is now blocked on
the owner.

## 5. The critique pass

After capture, every screenshot is read back against [08-frontend-design.md](08-frontend-design.md):

- Is any body text on `--surface-clay`, `--decor-gold` or `--decor-tan`? **Those are surfaces. That is
  the single most likely defect**, because the prototype used the bright gold for text.
- Is the mobile hero using the 4:5 art-directed crop, or a squashed landscape?
- Is RTL genuinely mirrored — layout, icons, number direction — or merely translated?
- Is the 68ch measure holding? Are touch targets ≥48px with ≥8px gaps?
- Does dark mode read warm, or has it gone grey-inverted?
- Is Cormorant Garamond confined to display, with nothing set in it below `lg`?
- Above the fold: any entrance animation, which is banned because it delays LCP?

Each defect becomes a fix unit with the offending screenshot attached.

## 6. Milestone stops

At each of M1–M7 the loop **pauses and reports** rather than rolling on:

| Milestone | Proves | Owner sees |
|---|---|---|
| **M1 Bookable** | catalogue → availability → book → SMS → calendar → reschedule invalidates reminder | gallery + a walkthrough |
| **M2 Bankable** | visit → invoice with correct VAT → payment → balanced journal → VAT201 box | working papers to the tax agent |
| **M3 Reachable** | event → enrolment → consented send → opt-out → suppression | consent invariants green |
| **M4 Findable** | publish a service → route live with JSON-LD → sitemap → GSC | gallery of every public route |
| **M5 Accountable** | closed test month reconciles end to end | P&L, cash flow, dashboard |
| **M6 Staffed** | leave approved over a booking → conflict → availability blocked | the conflict flow |
| **M7 Attributable** | click → booking → no-show → corrected net-zero conversion; **WhatsApp ref round-trip** | the funnel on seeded data |

M1, M2 and M6 are where a surprise is most likely and most expensive. M7 is where the owner finds out
whether the ref loop actually closes.

## 7. Stop-and-ask conditions

The loop halts and reports, rather than improvising, when:

- Two consecutive sessions complete no unit.
- One gate fails three times on the same unit.
- A unit cannot proceed without inventing a business rule that has no safe strict default.
- A decision would contradict a locked decision in [01-scope-and-decisions.md](01-scope-and-decisions.md).
- The manifest has no unblocked unit left.
- Anything would touch real customer data, real money, or a real external send.

## 8. Never, under any circumstances

- Weaken, skip or delete a test to make a gate pass. **A red gate is a fix.**
- Force-push, rewrite history, or touch the default branch.
- Commit a secret, or wire a real provider credential.
- Mark a unit `done` without its acceptance checks passing in CI.
- Invent a business rule, a price, a legal position or a licence condition.
- Let a stub return success without writing to a visible outbox.
- Publish anything public-facing that has not passed the banned-claims lint.

## 9. Order of the run

Per [11-execution-plan.md](11-execution-plan.md) §5, single-threaded:

**Attended** — `F01`–`F11` foundation, `B-AVAIL` availability, `M-TILL`/`M-VAT` money. Schema and money
decisions are expensive to get wrong and are where owner input changes the answer.

**Semi-attended, report at milestones** — `H01`–`H05` harness, `B-CAT`, `B-LIFE`, `B-UI`, `B-MSG`,
`C-CRM`, `C-AUTO`, `P-HR`, `A-FIRST`, `A-MEAS`, `R-REP`.

**Fully automatic** — `W-SYS`, `W-SITE`, `G-CONN`, `G-REV`, `G-SEO`. The page build-out is the most
repetitive and the most screenshot-visible, and it is where the harness pays back hardest.

**Back to attended** — `H-HARD`, `H-MIG`, and the cutover.

## 10. First three sessions, concretely

| Session | Unit | Output |
|---|---|---|
| 1 | `F01` | pnpm monorepo, TypeScript strict, Biome, import-boundary rule with a failing fixture proving it works, `pnpm verify` wired |
| 2 | `F02` | GitHub Actions running the gate against `postgres:16`, with a deliberately failing test proving the workflow goes red |
| 3 | `F03` | Four environments, boot-time config validation that fails loudly on a missing secret, and the **staging send guard** proven by test |

After session 3 the machinery exists and the loop runs on its own.

## 11. What the owner does in parallel

Nothing in §10 needs them. While sessions 1–3 run, the highest-value owner actions are the week-0 clocks in
[11-execution-plan.md](11-execution-plan.md) §4 — and the two with the longest lead times:

1. **Check whether the Google Business Profile is claimed and verified.** API access needs verified and
   active 60+ days. If it is unclaimed, that clock has not started and it is now the longest-lead item in
   the plan.
2. **Start the 9-day OAuth refresh-token experiment**, which with a personal Gmail is a hard blocker.

Then: the canonical WhatsApp number, the TRN and licence number, room inventory, and the 19 therapists'
names and skills.
