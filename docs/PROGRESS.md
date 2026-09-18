# Build Progress

Generated from `build/manifest.yaml` by `scripts/progress.py`. **Do not edit by hand.**

**5 / 37 units complete.**

## Next up

1. **F06 — Audit service and domain event outbox**
1. **F07 — Staff auth with mandatory TOTP and the RBAC policy layer**
1. **F10 — Arabic RTL PDF proof**

## All units

| | Order | ID | Unit | Depends on | Milestone | Owner input |
|---|---|---|---|---|---|---|
| [x] | 1 | `F01` | Monorepo scaffold and toolchain | — | — | — |
| [x] | 2 | `F02` | CI pipeline with real Postgres | `F01` | — | — |
| [x] | 3 | `F03` | Environments, config validation, staging send guard | `F01` | — | — |
| [x] | 4 | `F04` | Database spine and migration pipeline | `F02` | — | — |
| [x] | 5 | `F05` | Money, time and identifier primitives | `F01` | — | — |
| [ ] | 6 | `F06` | Audit service and domain event outbox | `F04` | — | — |
| [ ] | 7 | `F07` | Staff auth with mandatory TOTP and the RBAC policy layer | `F04` | — | — |
| [ ] | 8 | `F08` | Clinical schema boundary | `F04`, `F07` | — | — |
| [ ] | 9 | `F09` | Settings registry | `F04`, `F07` | — | — |
| [ ] | 10 | `F10` | Arabic RTL PDF proof | `F01` | — | — |
| [ ] | 11 | `F11` | Design tokens | `F01` | — | — |
| [ ] | 12 | `H01` | Progress ledger, ADRs for locked decisions, open questions | `F01` | — | — |
| [ ] | 13 | `H02` | Fake provider layer | `F03`, `F06` | — | — |
| [ ] | 14 | `H03` | Deterministic seed and frozen clock | `F04`, `F05` | — | — |
| [ ] | 15 | `H04` | Screenshot harness and gallery | `H03`, `F11` | — | — |
| [ ] | 16 | `H05` | Quality gates wired into CI | `F02`, `H04` | — | — |
| [ ] | 17 | `B-CAT` | Service catalogue, styles, rooms and business day *(expand)* | `F09`, `H03` | — | Y8-rooms, Y9-turnaround, Y9-poa-prices |
| [ ] | 18 | `B-AVAIL` | Availability engine *(expand)* | `B-CAT` | — | Y9-gender, Y9-windows |
| [ ] | 19 | `B-LIFE` | Appointment lifecycle and phone-first identity *(expand)* | `B-AVAIL` | — | — |
| [ ] | 20 | `B-UI` | Booking flow and admin calendar *(expand)* | `B-LIFE`, `H04` | M1 | — |
| [ ] | 21 | `B-MSG` | Transactional messaging and reminder invalidation *(expand)* | `B-LIFE`, `H02` | — | — |
| [ ] | 22 | `M-TILL` | Till, invoicing, ledger, packages *(expand)* | `B-LIFE`, `F10` | M2 | — |
| [ ] | 23 | `M-VAT` | Purchases, recurring costs, VAT working papers, compliance calendar *(expand)* | `M-TILL` | — | Y11-tax-agent |
| [ ] | 24 | `C-CRM` | CRM, clinical intake, consent *(expand)* | `F08`, `B-LIFE` | — | — |
| [ ] | 25 | `C-AUTO` | Automation engine and messaging compliance gate *(expand)* | `C-CRM`, `B-MSG` | M3 | — |
| [ ] | 26 | `P-HR` | People, credentials gating availability, leave *(expand)* | `B-AVAIL`, `M-TILL` | M6 | — |
| [ ] | 26.5 | `A-FIRST` | First-party analytics, funnel and the WhatsApp ref loop *(expand)* | `B-LIFE`, `M-TILL` | — | — |
| [ ] | 27 | `A-MEAS` | Analytics, server-side push, egress guard *(expand)* | `A-FIRST`, `H02` | M7 | — |
| [ ] | 28 | `R-REP` | Reporting, KPIs, dashboards *(expand)* | `M-VAT`, `C-CRM`, `P-HR` | M5 | — |
| [ ] | 29 | `W-SYS` | Component library, CMS, media pipeline *(expand)* | `F11`, `H04` | — | — |
| [ ] | 30 | `W-SITE` | Public site, SEO, publication control plane *(expand)* | `W-SYS`, `B-CAT` | M4 | — |
| [ ] | 31 | `G-CONN` | Google connection, health check, re-auth surfaces *(expand)* | `H02`, `F09` | — | Y2-listing-owner, Y4-token-test, Y10-consent |
| [ ] | 32 | `G-REV` | Review autoresponder, fallback mode first *(expand)* | `G-CONN` | — | — |
| [ ] | 33 | `G-SEO` | SEO agent *(expand)* | `G-CONN`, `W-SITE` | — | — |
| [ ] | 34 | `Y-PAY` | Payments *(expand)* | `M-TILL` | — | Y7-mcc |
| [ ] | 35 | `H-HARD` | Hardening, runbooks, restore drill *(expand)* | `R-REP`, `W-SITE`, `G-SEO` | — | Y13-pentest |
| [ ] | 36 | `H-MIG` | Migration tooling and dry runs *(expand)* | `H-HARD` | — | Y8-packages, Y8-leave, Y8-opening-balances |

## Legend

`[x]` done  ·  `[~]` in progress  ·  `[ ]` todo  ·  `[!]` blocked

*(expand)* = group-level unit; decompose into session-sized units before working it.

A unit is `done` only when every acceptance check in the manifest passes in CI —
never on assertion. See [12-autonomous-delivery.md](12-autonomous-delivery.md) §6.
