# Open Questions

Everything the build is carrying as an assumption or a stub, with who resolves it and what it blocks.

**The rule** ([12-autonomous-delivery.md](12-autonomous-delivery.md) §1): nothing here stalls the build.
Each item has a **provisional value chosen as the strictest safe option**, is flagged `provisional: true`
in settings, appears in the **Unconfirmed Assumptions panel**, and is corrected with one audited settings
change at deploy-and-check time.

Statuses: `open` · `asked` (with whom and when) · `resolved` (with the answer and date).

---

## A. Business rules — needed before the units that use them

| ID | Question | Provisional value | Status | Blocks |
|---|---|---|---|---|
| Y9-gender | Must therapists serve only clients of the same gender? Are gender-zoned rooms required? | **Strict same-gender matching, enforced** | open | `B-AVAIL` |
| Y9-turnaround | Real turnaround per service type. The **wet room** almost certainly needs longer than a standard room | **20 min standard, 30 min wet room** | open | `B-CAT`, `B-AVAIL` |
| Y9-windows | Cancellation window, late-cancellation and no-show policy | **24h window; no fee charged, flagged only** | open | `B-LIFE` |
| Y9-buffer | Therapist buffer before/after a treatment, distinct from room turnaround | **10 min each side** | open | `B-AVAIL` |
| Y9-lead | Minimum online booking lead time and maximum advance window | **2h lead, 90 days ahead** | open | `B-AVAIL` |
| Y9-commission | Therapist commission structure — flat, tiered, service-dependent | **None configured; commission module ships disabled** | open | `P-HR` |
| Y9-package-policy | Package validity, transferability, and unredeemed-balance treatment at expiry | **6 months, non-transferable, balance retained not forfeited** | open | `M-TILL` |
| Y9-package-thin | Policy for a pre-system package with a thin paper trail — honour, honour-once-on-evidence, or decline | **Honour once on evidence, logged** | open | `H-MIG` |

## A2. Opened by the unit decomposition

Each of these is a value a build unit needs and that no document supplies. They were found by
decomposing the plan into machine-checkable acceptance criteria — the point at which "to be confirmed"
stops being acceptable. Every one has a provisional value chosen as the strictest safe option, and each
is flagged `provisional: true` in settings so it appears in the Unconfirmed Assumptions panel.

| ID | Question | Provisional value | Status | Blocks |
|---|---|---|---|---|
| Y9-buffer | Therapist buffer before/after a treatment, as distinct from room turnaround | **10 min each side** | open | availability engine |
| Y9-overtime | Overtime uplift percentages and the daily cap under MOHRE rules | **8h/day standard, 25% uplift, 2h daily overtime cap** | open | rota validator, payroll |
| Y9-coverage | Minimum floor coverage, and the daily treatment-load cap per therapist | **2 therapists on the floor; max 6 treatment-hours/day/therapist, max 4 of them deep-tissue** | open | leave approval, rota |
| Y9-leave-detail | Probation length, first-year and pro-rata accrual, carry-over cap and expiry, and whether a public holiday inside annual leave is counted | **6-month probation; accrual from day 1; 30-day carry-over cap expiring after 12 months; public holidays inside leave NOT counted** | open | leave accrual engine |
| Y9-frequency-cap | Maximum marketing sends per contact per week across all flows and campaigns | **2 per week, 6 per month** | open | automation engine rails |
| Y9-ramadan-window | Whether the 07:00–21:00 promotional SMS window narrows during Ramadan | **Narrowed to 10:00–16:00 during Ramadan** (the conservative guess; a wider window would risk a breach) | open | campaign scheduler |
| Y9-queued-staleness | What happens to a time-sensitive promotional message queued at 23:00 whose offer expires before the window reopens | **Expires unsent, with a report to the owner rather than a late send** | open | campaign scheduler |
| Y9-tips | Tip model: cash vs card, pooled vs individual, and the payout and tax treatment | **Cash only, individual, recorded but not banked — no card tips until the model is decided** | open | till, payroll, payments |
| Y9-deposits | Which services require a deposit, what percentage, and whether first-time clients prepay | **Deposits DISABLED. No service requires one** | open | payments |
| Y1-analytics-credentials | GA4 measurement id and API secret, Meta dataset id and CAPI access token, and Meta Business verification | **Fake analytics provider; no real ids configured** | open | real analytics dispatch |
| Y11-vat201-boxes | The actual VAT201 box numbers for standard-rated sales, reverse charge and recoverable input VAT | **Box 1 / Box 3 / Box 10 as placeholders, held in a data table with a test proving the mapping is data not code** | open | VAT return working papers |
| Y11-rounding | Confirm the gross-to-net rounding convention is acceptable to the tax agent | **half-up on net, VAT as the remainder** (exactness proven either way) | open | first VAT return |

---

## B. Legal and regulatory

| ID | Question | Provisional value | Status | Blocks |
|---|---|---|---|---|
| Y1-licence | Licence classification: commercial wellness or a healthcare activity? Permitted public vocabulary and staff titles follow from it | **`licence_class: unconfirmed` → resolves to the stricter combination: wellness vocabulary, healthcare-grade retention** | open | public copy in `W-SITE` |
| Y5-residency | Do intake notes count as health data subject to UAE localisation? Decides hosting region | **Clinical boundary built and isolated; no real intake data loaded** | open | loading real intake data |
| Y1-entity | Mainland, DIFC, ADGM or free zone? Decides which privacy law applies | **Federal PDPL assumed** | open | privacy layer specifics |
| Y11-tax-agent | FTA-registered tax agent review of the VAT working papers. **Not optional** | — | open | first VAT return |
| Y11-vat-package | VAT date of supply on a prepaid package: at sale or at redemption? | **At redemption; deferred-revenue liability on sale** | open | `M-TILL` revenue recognition |
| Y11-vat-invoice | Confirm mandatory tax-invoice field list and the Arabic-language requirement | **Superset of known requirements carried on every invoice** | open | first invoice issued |
| Y1-rooms | Permitted room types and treatment-room count under the licence | **From the handover pack; couples room assumed permitted** | open | `B-CAT` |

## C. External credentials and access — all stubbed, none blocking

| ID | Item | Stub behaviour | Status | Blocks |
|---|---|---|---|---|
| Y2-listing-owner | Which Google account owns the GBP listing, at what role | Fake OAuth + fake account/location picker | open | real `G-CONN` |
| Y3-gbp-api | GBP Basic API Access application | Fake GBP returning `access_not_granted` on demand | open | autoresponder API mode |
| Y4-token-test | The 9-day refresh-token expiry experiment. **Hard blocker — see [10](10-google-connection.md) §6** | Fake OAuth simulates 7-day expiry and `invalid_grant` | open | OAuth publishing decision |
| Y10-consent | Owner completes OAuth consent and confirms the location picker | Fake consent flow, fully testable | open | real `G-CONN` |
| Y6-sender-ids | Two SMSala sender IDs, transactional + `AD-` promotional | Fake SMSala with segment/cost calc, DLRs, suspension simulation | open | real campaigns |
| Y7-mcc | Merchant category code confirmed in writing, two providers | Manual/cash adapter is real; fake card gateway with 3DS and chargebacks | open | `Y-PAY` going live |
| Y13-pentest | Penetration test booked | — | open | go-live |
| Y6-sms-rate | **What does SMSala actually charge per segment?** The campaign budget screen multiplies it by a segment count, and Arabic is 70 characters per segment against English's 160 — so the rate decides whether an Arabic campaign is affordable | 9 fils per segment, marked provisional in the fake | open | campaign cost estimates |
| Y7-gateway | **Which card gateway, and is an MCC agreed in writing?** Some acquirers decline this merchant category | Fake gateway with 3DS, partial refund, webhook replay and disputes | open | `Y-PAY` |
| Y8-llm-budget | **What monthly token budget does the owner agree to?** The setting exists and is bounded; the number is not the build's to choose | `agents.monthly_token_budget` provisional, and the fake accounts for tokens so the guard is testable | open | `G-SEO` live mode |

## D. Data and assets from the owner

| ID | Item | Provisional | Status | Blocks |
|---|---|---|---|---|
| Y8-menu | Real service menu: names, durations, prices, which are online-bookable | Synthetic 12-service fixture | open | `B-CAT` seeding |
| Y8-rooms | Room inventory: count, types, couples-capable, service compatibility | Synthetic 5-room fixture | open | `B-CAT` seeding |
| Y8-staff | Staff list for the **19 therapists**: names, skills (Asian/Arabic style), languages, gender, certification expiries | 19 unnamed therapists, style skills split evenly | open | `P-HR` seeding, therapist pages |
| Y8-hours | Opening hours including Ramadan variation | Synthetic hours | open | `B-AVAIL` |
| Y8-packages | **Outstanding packages already sold** — holder, price, sessions remaining, validity. Reconciled to cash received and signed off | Synthetic balances | open | `H-MIG` |
| Y8-leave | Current leave balance per employee | Zero balances | open | `P-HR` accrual opening |
| Y8-opening-balances | Accounting opening balances at a clean period boundary | Zero | open | `M-VAT` |
| Y8-coa | Existing chart of accounts and what the accountant expects monthly | Standard spa CoA | open | `M-VAT` |
| Y8-customers | Customer list. **Imports with `marketing_consent = false` without exception** — see [11](11-execution-plan.md) §7 | Synthetic customers | open | `H-MIG` |
| Y12-photos | **Photo library audit and per-face focal points.** The 19 portraits from the prototype are now in `assets/media/`, and their native ratios span **0.461 to 0.799** — nearly two to one. They are full-length shots with the face in roughly the top fifth, so a 4:5 centre crop produces a row of torsos. **W-SYS-05 measured a second problem in the same library:** the dominant colour of all 12 rendered fixture images falls outside the placeholder band docs/08 §6 declares — lightness 0.134 to 0.783 against a 0.86 floor — so every placeholder is the clamp output rather than the photographs colour, and docs/08 §8s 'pastel photography is a performance asset' does not describe these files | Every portrait carries a focal point of 50%/16%, a defensible default from the framing rather than a per-face measurement. `pnpm media` fails if one is missing | open | `W-SITE` therapist grid |
| Y12-consent-photo | Staff photography consent on record for anyone identifiable. **19 identifiable photographs are now in the repository**, taken from the business's own public site | Therapist cards render the photograph with no name and no link, which is also the launch state: the prototype has 19 photographs and 0 names | open | `W-SITE` therapist pages |

## D2. Newly opened by the prototype and live-site review

| ID | Question | Provisional value | Status | Blocks |
|---|---|---|---|---|
| Y2-gbp-status | **Is the Google Business Profile claimed and verified?** GBP API access needs it verified and active **60+ days**, so if it is unclaimed this is now the longest-lead item in the plan | Fake GBP; autoresponder in draft mode | open | real `G-CONN`, autoresponder API mode |
| Y1-nap | **Which WhatsApp number is canonical?** The prototype says `052 510 8633`, the live site says `+971 52 823 9069` | Prototype number used; flagged in the Unconfirmed panel | open | `premises` seed, all schema and citations |
| Y1-trn | TRN and trade-licence number for tax invoices | Placeholder that fails invoice validation until set | open | issuing any real invoice |
| Y8-rooms | Room count, types, which is the wet room, which are capacity-2 | 5 rooms: 1 wet, 1 capacity-2, 3 standard | open | `B-CAT`, availability |
| Y9-poa-prices | Prices for Four Hands, Couple Massage, Full Body Shaving | Derived as 1.8× the single-therapist equivalent | open | `B-CAT` seed |
| Y9-shaving-room | Does Full Body Shaving need a specific room or equipment? | Any standard room | open | `service_room_type_compat` |
| Y12-names | **The 19 therapist display names.** The prototype publishes none, and the build does not invent them — a therapist page is unpublishable without one (ADR 0020), so every therapist in the fixture is currently unpublished | Cards read "Name not yet published"; the photograph shows, the page does not link | open | `W-SITE` therapist pages, therapist SEO |
| Y12-body-face | **Keep Jost for body text, or adopt a higher-x-height workhorse sans?** Jost is a legibility risk at 17px and worse in dense admin tables | Workhorse sans for body and admin; Jost retained for marketing display | open | `F11`, `W-SYS` |
| Y5-analytics-basis | Lawful basis for the **internal** first-party analytics store, which shares nothing with third parties — a different question from the consent-gated GA4/Meta push | Internal store treated as consent-gated too, i.e. the stricter position | open | `A-FIRST` go-live |
| Y12-ref-loop | **Will the front desk paste the WhatsApp ref code at booking?** If not, attribution honestly stops at the click | Ref field present; capture rate reported rather than assumed | open | funnel completeness |
| Y1-woo-baseline | Crawl and rank baseline of `berelaxmassage.com` before anything changes, for the 301 map | Not yet captured | open | `W-SITE` 301 map, relaunch safety |

---

## E. Owner verification tasks — at deploy-and-check

| ID | Task | Why it cannot be automated |
|---|---|---|
| Y12-pilot | Staff pilot; report what the front desk complains about | Requires real staff on a real floor |
| Y14-devices | Real-device testing: SMS arrival on a UAE handset, OTP autofill on real iOS, receipt printer | I can test logic, not a specific device |

---

## Resolved

| ID | Question | Answer | Date |
|---|---|---|---|
| Y9-style | Is Asian/Arabic a treatment style or a therapist attribute? | **Treatment style.** Service = `(style × treatment)`; style maps to a required therapist skill for eligibility only. Pricing and therapist assignment stay decoupled | 2026-09-18 |
| Y12-names | Therapist naming — full, first-name-only, or anonymous? | **Names set in the backend by the admin.** Build the fields; a therapist page publishes only with a display name *and* recorded photography consent | 2026-09-18 |
| Y12-design | Is the Netlify prototype the design direction or a placeholder? | **A prototype to evolve.** Palette and typefaces inherited and made accessible; single-page anchors evolve into real indexable routes | 2026-09-18 |
| Y8-menu | Real service menu with durations and prices | **Extracted** — 8 services × 4 durations, 32 AED gross prices. See [13-business-profile.md](13-business-profile.md) §4 | 2026-09-18 |
| Y8-hours | Opening hours | **Daily 11:00–02:00.** Crosses midnight; `business_day` is first-class | 2026-09-18 |
