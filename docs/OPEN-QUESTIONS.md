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
| Y9-turnaround | Real room turnaround time per service type — linen change, clean, air | **20 min all services** | open | `B-CAT`, `B-AVAIL` |
| Y9-windows | Cancellation window, late-cancellation and no-show policy | **24h window; no fee charged, flagged only** | open | `B-LIFE` |
| Y9-buffer | Therapist buffer before/after a treatment, distinct from room turnaround | **10 min each side** | open | `B-AVAIL` |
| Y9-lead | Minimum online booking lead time and maximum advance window | **2h lead, 90 days ahead** | open | `B-AVAIL` |
| Y9-commission | Therapist commission structure — flat, tiered, service-dependent | **None configured; commission module ships disabled** | open | `P-HR` |
| Y9-package-policy | Package validity, transferability, and unredeemed-balance treatment at expiry | **6 months, non-transferable, balance retained not forfeited** | open | `M-TILL` |
| Y9-package-thin | Policy for a pre-system package with a thin paper trail — honour, honour-once-on-evidence, or decline | **Honour once on evidence, logged** | open | `H-MIG` |

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

## D. Data and assets from the owner

| ID | Item | Provisional | Status | Blocks |
|---|---|---|---|---|
| Y8-menu | Real service menu: names, durations, prices, which are online-bookable | Synthetic 12-service fixture | open | `B-CAT` seeding |
| Y8-rooms | Room inventory: count, types, couples-capable, service compatibility | Synthetic 5-room fixture | open | `B-CAT` seeding |
| Y8-staff | Staff list: skills, languages, gender, certification expiries | Synthetic 8-therapist fixture | open | `P-HR` seeding |
| Y8-hours | Opening hours including Ramadan variation | Synthetic hours | open | `B-AVAIL` |
| Y8-packages | **Outstanding packages already sold** — holder, price, sessions remaining, validity. Reconciled to cash received and signed off | Synthetic balances | open | `H-MIG` |
| Y8-leave | Current leave balance per employee | Zero balances | open | `P-HR` accrual opening |
| Y8-opening-balances | Accounting opening balances at a clean period boundary | Zero | open | `M-VAT` |
| Y8-coa | Existing chart of accounts and what the accountant expects monthly | Standard spa CoA | open | `M-VAT` |
| Y8-customers | Customer list. **Imports with `marketing_consent = false` without exception** — see [11](11-execution-plan.md) §7 | Synthetic customers | open | `H-MIG` |
| Y12-photos | **Photo library audit** — 15–20 representative images against each media slot's constraints | Palette-matched placeholders at correct aspect ratios | open | `W-SITE` final imagery |
| Y12-consent-photo | Staff photography consent on record for anyone identifiable | Therapist pages use initials until consent recorded | open | `W-SITE` therapist pages |

## E. Owner verification tasks — at deploy-and-check

| ID | Task | Why it cannot be automated |
|---|---|---|
| Y12-pilot | Staff pilot; report what the front desk complains about | Requires real staff on a real floor |
| Y14-devices | Real-device testing: SMS arrival on a UAE handset, OTP autofill on real iOS, receipt printer | I can test logic, not a specific device |

---

## Resolved

*(none yet — entries move here with the answer and the date, and the corresponding settings row loses its
`provisional` flag)*
