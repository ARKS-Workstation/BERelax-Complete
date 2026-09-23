# Build Progress

Generated from `build/manifest.yaml` by `scripts/progress.py`. **Do not edit by hand.**

**91 / 207 units complete.**

## Next up

1. **B-UI-02 — Public booking flow: details, OTP, confirm and the nine enumerated edge states**
1. **B-UI-03 — Admin calendar: room x time primary, therapist x time secondary, drag to reschedule**
1. **M-TILL-06 — Checkout finalisation: one transaction, idempotent, invoice plus journal plus tender**

## All units

| | Order | ID | Unit | Depends on | Milestone | Owner input |
|---|---|---|---|---|---|---|
| [x] | 1 | `F01` | Monorepo scaffold and toolchain | — | — | — |
| [x] | 2 | `F02` | CI pipeline with real Postgres | `F01` | — | — |
| [x] | 3 | `F03` | Environments, config validation, staging send guard | `F01` | — | — |
| [x] | 4 | `F04` | Database spine and migration pipeline | `F02` | — | — |
| [x] | 5 | `F05` | Money, time and identifier primitives | `F01` | — | — |
| [x] | 6 | `F06` | Audit service and domain event outbox | `F04` | — | — |
| [x] | 7 | `F07` | Staff auth with mandatory TOTP and the RBAC policy layer | `F04` | — | — |
| [x] | 8 | `F08` | Clinical schema boundary | `F04`, `F07` | — | — |
| [x] | 9 | `F09` | Settings registry | `F04`, `F07` | — | — |
| [x] | 10 | `F10` | Arabic RTL PDF proof | `F01` | — | — |
| [x] | 11 | `F11` | Design tokens | `F01` | — | — |
| [x] | 11.5 | `F12` | The worker app — pg-boss on the primary Postgres, the job registry and transactional enqueue | `F03`, `F04`, `F06`, `F09` | — | — |
| [x] | 12 | `H01` | Progress ledger, ADRs for locked decisions, open questions | `F01` | — | — |
| [x] | 13 | `H02` | Fake provider layer | `F03`, `F06` | — | — |
| [x] | 14 | `H03` | Deterministic seed and frozen clock | `F04`, `F05` | — | — |
| [x] | 15 | `H04` | Screenshot harness and gallery | `H03`, `F11` | — | — |
| [x] | 16 | `H05` | Quality gates wired into CI | `F02`, `H04` | — | — |
| [x] | 17 | `B-CAT-01` | Premises hours, closures and the first-class business_day | `F04`, `F05`, `F09`, `H03` | — | Y8-hours |
| [x] | 18 | `B-CAT-02` | Rooms, room types, capacity and service/room compatibility | `B-CAT-01` | — | Y8-rooms, Y1-rooms, Y9-shaving-room |
| [x] | 19 | `B-CAT-03` | Service catalogue schema: style x treatment, variants, skills and resource shapes | `B-CAT-02` | — | Y9-turnaround |
| [x] | 20 | `B-AVAIL-01` | Booking and appointment schema with the concurrency constraints | `B-CAT-03`, `F04`, `F06` | — | — |
| [x] | 21 | `B-AVAIL-02` | The pure availability solver: trading window, duration, turnaround, buffers, lead and advance | `B-CAT-01`, `B-CAT-03`, `F05` | — | Y9-turnaround, Y9-buffer, Y9-lead |
| [x] | 22 | `B-AVAIL-03` | Resource-shape assignment for the three real shapes | `B-AVAIL-02`, `B-CAT-02` | — | — |
| [x] | 23 | `B-AVAIL-04` | Therapist availability read model and the eligibility port P-HR later fills | `B-AVAIL-01`, `B-CAT-02` | — | Y8-staff |
| [x] | 24 | `B-AVAIL-05` | Gender matching as a hard constraint, default strict | `B-AVAIL-04`, `F09` | — | Y9-gender |
| [x] | 25 | `B-CAT-04` | Price resolution chain and effective-dated price lists | `B-CAT-03`, `F05` | — | — |
| [x] | 26 | `B-AVAIL-06` | The booking transaction: room row lock, idempotency, all-or-none, price snapshot | `B-AVAIL-01`, `B-AVAIL-03`, `B-AVAIL-05`, `B-CAT-04`, `F06` | — | — |
| [x] | 27 | `B-CAT-05` | Catalogue mutation guard rails and the public display-name compliance lint | `B-AVAIL-01`, `B-CAT-04` | — | — |
| [x] | 28 | `B-CAT-06` | Catalogue, premises and room seed from the real business profile | `B-CAT-05`, `H03` | — | Y8-rooms, Y9-poa-prices, Y1-nap, Y1-trn |
| [x] | 29 | `B-AVAIL-07` | Availability query service, brief cache with write invalidation, alternatives and waitlist | `B-AVAIL-06`, `B-CAT-06` | — | — |
| [x] | 30 | `B-LIFE-01` | Appointment lifecycle state machine with actor permissions and declared side effects | `B-AVAIL-06`, `F06`, `F07` | — | — |
| [x] | 31 | `B-LIFE-03` | Reschedule, cancellation, no-show and the cancellation policy | `B-AVAIL-07`, `B-LIFE-01` | — | Y9-windows |
| [x] | 32 | `B-MSG-01` | Channel-shaped template model, encoding, segment count and cost | `F04`, `F06`, `F09` | — | — |
| [x] | 33 | `B-MSG-02` | The single send choke point, sender-ID class routing and fail-closed evaluation | `B-MSG-01`, `F03`, `H02` | — | Y6-sender-ids |
| [x] | 34 | `B-LIFE-02` | Phone-first identity: E.164 normalisation, dedup match keys and SMS OTP | `B-MSG-02`, `F04`, `F06` | — | — |
| [x] | 35 | `B-MSG-03` | Scheduled steps with invalidation keys, and reminder rebuilds | `B-LIFE-03`, `B-MSG-02` | — | — |
| [x] | 36 | `B-MSG-04` | Delivery receipts, message lifecycle and the admin Messages inbox | `B-MSG-02`, `F11`, `H02` | — | — |
| [x] | 37 | `B-UI-01` | Public booking flow: service, therapist and slot selection | `B-AVAIL-07`, `F11`, `H04` | M1 | — |
| [ ] | 38 | `B-UI-02` | Public booking flow: details, OTP, confirm and the nine enumerated edge states | `B-LIFE-01`, `B-LIFE-02`, `B-UI-01` | M1 | — |
| [ ] | 39 | `B-UI-03` | Admin calendar: room x time primary, therapist x time secondary, drag to reschedule | `B-LIFE-03`, `B-UI-01` | M1 | — |
| [ ] | 40 | `B-UI-04` | Quick-book, walk-in entry and the WhatsApp ref field | `B-LIFE-02`, `B-UI-03` | M1 | Y12-ref-loop |
| [ ] | 41 | `B-UI-05` | Magic-link token service and the manage-booking page | `B-LIFE-03`, `B-MSG-03`, `B-UI-02` | M1 | — |
| [ ] | 42 | `B-M1` | M1 Bookable: the end-to-end walkthrough, invariant suite and milestone stop | `B-CAT-06`, `B-MSG-04`, `B-UI-04`, `B-UI-05` | M1 | — |
| [x] | 43 | `M-TILL-01` | Chart of accounts and the pure double-entry ledger kernel | `F05` | — | Y8-coa |
| [x] | 44 | `M-TILL-02` | Append-only journal schema, period locks and the posting repository | `F04`, `F06`, `M-TILL-01` | — | — |
| [x] | 45 | `M-TILL-03` | Gap-free sequential document numbering allocated inside the insert transaction | `F04` | — | — |
| [x] | 46 | `M-TILL-04` | Invoice document model: immutable per-line tax derivation and issuer snapshot | `F05`, `M-TILL-02`, `M-TILL-03` | — | Y11-vat-invoice, Y1-trn |
| [x] | 47 | `M-TILL-05` | Checkout basket: snapshotted pricing, discounts with reasons, tips, package lines | `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `M-TILL-01` | — | — |
| [ ] | 48 | `M-TILL-06` | Checkout finalisation: one transaction, idempotent, invoice plus journal plus tender | `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `F06`, `M-TILL-04`, `M-TILL-05` | — | — |
| [ ] | 49 | `M-TILL-07` | Payments and refunds through the manual tender adapter | `M-TILL-06` | — | — |
| [ ] | 50 | `M-TILL-08` | Credit notes as the only correction mechanism | `M-TILL-03`, `M-TILL-06` | — | — |
| [ ] | 51 | `M-TILL-09` | Versioned package templates and package sale as deferred revenue | `F09`, `M-TILL-06` | — | Y9-package-policy, Y11-vat-package |
| [ ] | 52 | `M-TILL-10` | Package redemption drawdown, expiry and breakage | `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `M-TILL-09` | — | Y9-package-policy, Y11-vat-package |
| [ ] | 53 | `M-TILL-11` | Cash drawer reconciliation per shift, keyed on business_day | `B-CAT-01`, `B-CAT-02`, `B-CAT-03`, `B-CAT-04`, `B-CAT-05`, `B-CAT-06`, `M-TILL-07` | — | — |
| [x] | 54 | `M-TILL-12` | Bilingual tax invoice, simplified invoice and receipt PDFs | `F10`, `M-TILL-04` | — | Y11-vat-invoice, Y1-trn |
| [ ] | 55 | `M-TILL-13` | Till, cash-up and package screens, and the M2 Bankable vertical slice | `B-UI-01`, `B-UI-02`, `B-UI-03`, `B-UI-04`, `B-UI-05`, `H04`, `M-TILL-07`, `M-TILL-08`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12` | M2 | — |
| [x] | 56 | `M-VAT-01` | Suppliers, supplier tax profile, bills and payables | `M-TILL-02`, `M-TILL-03` | — | — |
| [x] | 57 | `M-VAT-02` | Input VAT recoverability classification, including blocked categories | `M-VAT-01` | — | — |
| [x] | 58 | `M-VAT-03` | Reverse charge on offshore suppliers and the nightly exception report | `F06`, `M-VAT-01`, `M-VAT-02` | — | — |
| [x] | 59 | `M-VAT-04` | Recurring cost register with fixed/variable split and variance alerting | `H03`, `M-VAT-01` | — | — |
| [x] | 60 | `M-VAT-05` | Opening balances and the trial balance | `M-TILL-02` | — | Y8-opening-balances, Y8-coa |
| [ ] | 61 | `M-VAT-06` | Period close and lock workflow, corrections by dated reversal | `M-TILL-08`, `M-VAT-05` | — | — |
| [ ] | 62 | `M-VAT-07` | VAT201 box mapping and working papers with drill-down | `M-TILL-10`, `M-VAT-02`, `M-VAT-03`, `M-VAT-06` | — | Y11-tax-agent, Y11-vat-package |
| [ ] | 63 | `M-VAT-08` | Immutable VAT return snapshot with preparer and reviewer sign-off | `F07`, `M-VAT-07` | — | Y11-tax-agent |
| [ ] | 64 | `M-VAT-09` | Absence of auto-file, proven, and the Zoho Books export | `M-VAT-08` | — | — |
| [x] | 65 | `M-VAT-10` | Compliance calendar engine and blocking obligations | `B-AVAIL-01`, `B-AVAIL-02`, `B-AVAIL-03`, `B-AVAIL-04`, `B-AVAIL-05`, `B-AVAIL-06`, `B-AVAIL-07`, `F06`, `F09` | — | — |
| [x] | 66 | `M-VAT-11` | Compliance calendar reminders, escalation, evidence and the unverified dashboard | `H02`, `M-VAT-10` | — | — |
| [ ] | 67 | `M-VAT-12` | Closed test month reconciliation report | `H03`, `M-TILL-13`, `M-VAT-07` | — | Y11-tax-agent |
| [ ] | 68 | `M-VAT-13` | Money invariant suite wired into pnpm verify and CI, with gate-fires fixtures | `H05`, `M-VAT-12` | — | — |
| [x] | 69 | `C-AUTO-01` | Template model: per-channel variants, immutable message_class, approval state, two sender identities | `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04`, `F09` | — | Y6-sender-ids |
| [ ] | 70 | `C-AUTO-02` | GSM-7 vs UCS-2 detection, segmentation and cost preview at authoring time | `C-AUTO-01`, `F05` | — | Y6-sender-ids |
| [x] | 71 | `C-CRM-01` | Client record: preferences, tags, lifecycle, source, VIP and a blocklist that actually blocks | `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `F09` | — | — |
| [ ] | 72 | `C-AUTO-06` | Flow DSL, versioning and enrolment pinning | `C-AUTO-01`, `C-CRM-01` | — | — |
| [ ] | 73 | `C-AUTO-08` | Kanban pipeline for leads and clients | `C-CRM-01`, `H04` | — | — |
| [x] | 74 | `C-CRM-02` | E.164 normalisation and deterministic duplicate scoring | `C-CRM-01`, `F05` | — | — |
| [x] | 75 | `C-CRM-03` | Consent: channel x purpose x timestamp x wording version, append-only | `C-CRM-01`, `F06` | — | Y8-customers, Y1-entity |
| [ ] | 76 | `C-CRM-04` | Suppression list and the opt-out token service | `C-CRM-03` | — | — |
| [ ] | 77 | `C-CRM-05` | Merge as a first-class transactional operation, with a participant registry | `C-CRM-02`, `C-CRM-03`, `C-CRM-04` | — | — |
| [ ] | 78 | `C-AUTO-03` | Frequency ledger and a global cap across every flow and campaign | `C-AUTO-01`, `C-CRM-05` | — | Y6-sender-ids |
| [ ] | 79 | `C-AUTO-04` | The messaging compliance gate: one choke point, code not settings, failing closed | `C-AUTO-01`, `C-AUTO-02`, `C-AUTO-03`, `C-CRM-03`, `C-CRM-04` | — | Y6-sender-ids |
| [ ] | 80 | `C-AUTO-05` | Marketing kill switch and promotional-identity containment | `C-AUTO-04`, `H02` | — | — |
| [ ] | 81 | `C-AUTO-07` | The interpreter on pg-boss: idempotency, loop detection and dry run | `C-AUTO-04`, `C-AUTO-06`, `F06` | — | — |
| [ ] | 82 | `C-AUTO-09` | Node-graph journey builder, with misrouting made impossible | `C-AUTO-06`, `C-AUTO-07`, `H04` | — | — |
| [ ] | 83 | `C-AUTO-10` | Segments, campaigns, spend caps and window-aware scheduling | `C-AUTO-03`, `C-AUTO-04`, `H04` | — | Y6-sender-ids |
| [ ] | 84 | `C-AUTO-11` | Stock journeys - review solicitation, win-back, birthday - and the M3 proof | `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04`, `C-AUTO-07`, `C-AUTO-10`, `H03` | — | Y2-gbp-status, Y9-windows |
| [ ] | 85 | `C-CRM-06` | Duplicate review queue and merge preview | `C-CRM-05`, `H04` | — | — |
| [ ] | 86 | `C-CRM-07` | Preference centre, public and login-free | `C-CRM-04`, `F11` | — | — |
| [ ] | 87 | `C-CRM-08` | Clinical intake templates and encrypted submissions behind the boundary | `C-CRM-01`, `F08` | — | Y5-residency, Y1-licence |
| [ ] | 88 | `C-CRM-09` | Contraindication flags: the boolean-only crossing | `C-CRM-08` | — | Y1-licence |
| [ ] | 89 | `C-CRM-10` | Data-subject rights engine, retention and erasure with statutory conflict resolution | `C-CRM-04`, `C-CRM-08`, `F06` | — | Y1-entity, Y5-residency |
| [x] | 90 | `P-HR-01` | Employee record and encrypted staff PII | `B-AVAIL-01`, `B-AVAIL-02`, `B-AVAIL-03`, `B-AVAIL-04`, `B-AVAIL-05`, `B-AVAIL-06`, `B-AVAIL-07`, `F06`, `F07` | — | Y8-staff |
| [x] | 91 | `P-HR-02` | Credential registry and the pure eligibility evaluator | `P-HR-01` | — | Y1-licence, Y8-staff |
| [x] | 92 | `P-HR-03` | Expired credential removes a therapist from availability and flags their appointments | `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `P-HR-02` | — | Y8-staff |
| [ ] | 93 | `P-HR-04` | Reassignment work queue and the reassign transaction | `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04`, `P-HR-03` | — | Y9-gender |
| [x] | 94 | `P-HR-05` | Shift model and midnight-crossing working-hours maths | `P-HR-01` | — | Y9-overtime |
| [ ] | 95 | `P-HR-06` | Rota publishing, coverage and fatigue validator, labour-cost forecast | `P-HR-02`, `P-HR-05` | — | Y9-coverage |
| [ ] | 96 | `P-HR-07` | Attendance, timesheets and the period lock | `P-HR-06` | — | Y9-attendance |
| [ ] | 97 | `P-HR-08` | Leave types, entitlement and the accrual engine with worked examples | `P-HR-01` | — | Y8-leave, Y9-leave-policy |
| [ ] | 98 | `P-HR-09` | Leave approval: delegation, coverage, booking conflicts, availability block | `P-HR-04`, `P-HR-06`, `P-HR-08` | M6 | Y9-coverage |
| [ ] | 99 | `P-HR-10` | Holiday calendar, lunar confirmation impact report, Ramadan dated override | `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `P-HR-06` | — | — |
| [ ] | 100 | `P-HR-11` | Commission: versioned rules and a reproducible engine | `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13`, `P-HR-07` | — | Y9-commission |
| [ ] | 101 | `P-HR-12` | Payroll run, bilingual payslips and the WPS export | `F10`, `P-HR-08`, `P-HR-11` | — | Y8-wps, Y9-tips |
| [ ] | 102 | `P-HR-13` | Monthly gratuity accrual posted to the append-only ledger | `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13`, `P-HR-12` | M6 | Y8-coa, Y9-gratuity |
| [ ] | 103 | `P-HR-14` | Therapist self-service portal and staff notifications | `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04`, `P-HR-09`, `P-HR-12` | — | — |
| [ ] | 104 | `A-FIRST-01` | Analytics schema, monthly partitions, 90-day raw retention | `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13` | — | — |
| [ ] | 105 | `A-FIRST-02` | Event taxonomy and the funnel contract, pure | `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `F05`, `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13` | — | — |
| [ ] | 106 | `A-FIRST-03` | Origination resolver and click-id persistence, pure | `A-FIRST-02` | — | — |
| [ ] | 107 | `A-FIRST-04` | Bot and AI-crawler classification with one shared source of truth | `A-FIRST-02` | — | — |
| [ ] | 108 | `A-FIRST-05` | /api/collect ingest, session stitching and pre-consent staging | `A-FIRST-01`, `A-FIRST-02`, `A-FIRST-03`, `A-FIRST-04` | — | Y5-analytics-basis |
| [ ] | 109 | `A-FIRST-06` | Typed browser collector and declarative interaction tracking | `A-FIRST-05`, `B-UI-01`, `B-UI-02`, `B-UI-03`, `B-UI-04`, `B-UI-05` | — | — |
| [ ] | 110 | `A-FIRST-07` | WhatsApp reference-code loop, end to end | `A-FIRST-05`, `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03` | — | Y12-ref-loop, Y1-nap |
| [ ] | 111 | `A-FIRST-08` | First-touch and last-touch attribution onto customer and booking | `A-FIRST-05`, `A-FIRST-07`, `C-CRM-01`, `C-CRM-02`, `C-CRM-03`, `C-CRM-04`, `C-CRM-05`, `C-CRM-06`, `C-CRM-07`, `C-CRM-08`, `C-CRM-09`, `C-CRM-10` | — | — |
| [ ] | 112 | `A-FIRST-09` | Funnel to PAID and the nightly rollups on business_day | `A-FIRST-02`, `A-FIRST-08`, `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13` | — | — |
| [ ] | 113 | `A-FIRST-10` | The /analytics admin page | `A-FIRST-09`, `F07`, `H04` | — | — |
| [ ] | 114 | `A-MEAS-01` | Egress guard: opaque category codes with an enumerating test | `A-FIRST-02`, `B-CAT-01`, `B-CAT-02`, `B-CAT-03`, `B-CAT-04`, `B-CAT-05`, `B-CAT-06` | — | — |
| [ ] | 115 | `A-MEAS-02` | Analytics consent: Consent Mode v2 gating client tags and server pushes | `A-FIRST-05`, `C-CRM-01`, `C-CRM-02`, `C-CRM-03`, `C-CRM-04`, `C-CRM-05`, `C-CRM-06`, `C-CRM-07`, `C-CRM-08`, `C-CRM-09`, `C-CRM-10` | — | Y5-analytics-basis |
| [ ] | 116 | `A-MEAS-03` | analytics_dispatch consumer with GA4 MP and Meta CAPI behind fakes | `A-MEAS-01`, `A-MEAS-02`, `F06`, `H02` | — | — |
| [ ] | 117 | `A-MEAS-04` | Consent-gated tag loader and web-vitals field reporting | `A-FIRST-06`, `A-MEAS-02` | — | — |
| [ ] | 118 | `A-MEAS-05` | Offline conversion loop: corrected values, no-show void, past event_time | `A-FIRST-09`, `A-MEAS-03`, `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13` | M7 | Y11-vat-package |
| [ ] | 119 | `A-MEAS-06` | Heartbeat, watchdog and dead-letter for the dispatcher and rollups | `A-FIRST-09`, `A-MEAS-03`, `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04` | — | — |
| [ ] | 120 | `A-MEAS-07` | Dispatch reconciliation: internal truth versus what was pushed | `A-FIRST-09`, `A-MEAS-05` | — | — |
| [ ] | 121 | `R-REP-01` | Reporting schema: dims, facts, materialised views and refresh | `C-CRM-01`, `C-CRM-02`, `C-CRM-03`, `C-CRM-04`, `C-CRM-05`, `C-CRM-06`, `C-CRM-07`, `C-CRM-08`, `C-CRM-09`, `C-CRM-10`, `M-VAT-01`, `M-VAT-02`, `M-VAT-03`, `M-VAT-04`, `M-VAT-05`, `M-VAT-06`, `M-VAT-07`, `M-VAT-08`, `M-VAT-09`, `M-VAT-10`, `M-VAT-11`, `M-VAT-12`, `M-VAT-13`, `P-HR-01`, `P-HR-02`, `P-HR-03`, `P-HR-04`, `P-HR-05`, `P-HR-06`, `P-HR-07`, `P-HR-08`, `P-HR-09`, `P-HR-10`, `P-HR-11`, `P-HR-12`, `P-HR-13`, `P-HR-14` | — | Y8-hours |
| [ ] | 122 | `R-REP-02` | P&L, balance sheet and cash flow tied to the ledger | `M-VAT-01`, `M-VAT-02`, `M-VAT-03`, `M-VAT-04`, `M-VAT-05`, `M-VAT-06`, `M-VAT-07`, `M-VAT-08`, `M-VAT-09`, `M-VAT-10`, `M-VAT-11`, `M-VAT-12`, `M-VAT-13`, `R-REP-01` | — | Y8-opening-balances, Y8-coa |
| [ ] | 123 | `R-REP-03` | KPI registry, utilisation and revenue per available room-hour | `B-CAT-01`, `B-CAT-02`, `B-CAT-03`, `B-CAT-04`, `B-CAT-05`, `B-CAT-06`, `P-HR-01`, `P-HR-02`, `P-HR-03`, `P-HR-04`, `P-HR-05`, `P-HR-06`, `P-HR-07`, `P-HR-08`, `P-HR-09`, `P-HR-10`, `P-HR-11`, `P-HR-12`, `P-HR-13`, `P-HR-14`, `R-REP-01` | — | — |
| [ ] | 124 | `R-REP-04` | Contribution margin per service and the operational KPI set | `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13`, `R-REP-03` | — | Y9-commission, Y7-mcc |
| [ ] | 125 | `R-REP-05` | Cohorts, LTV, CAC and payback, outstanding package liability | `A-FIRST-08`, `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13`, `R-REP-04` | — | Y9-package-policy, Y11-vat-package |
| [ ] | 126 | `R-REP-06` | Seasonality and the 13-week cash-flow forecast | `R-REP-02`, `R-REP-04` | — | Y8-hours, Y9-windows |
| [ ] | 127 | `R-REP-07` | The data-quality gate that refuses to show an unreconciled number | `A-FIRST-09`, `A-MEAS-07`, `R-REP-02`, `R-REP-04` | — | — |
| [ ] | 128 | `R-REP-08` | Role-scoped dashboards, drill-down and pushed alerts | `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04`, `F07`, `H04`, `R-REP-05`, `R-REP-06`, `R-REP-07` | M5 | Y6-sender-ids |
| [x] | 129 | `W-SYS-01` | Next.js app shell, Tailwind v4 token mapping and the type stack | `F11`, `H04` | — | Y12-body-face |
| [x] | 130 | `W-SYS-02` | Editorial grid, layout primitives and the container-query component set | `W-SYS-01` | — | — |
| [x] | 131 | `W-SYS-03` | Radix/shadcn primitive set and an axe gate that provably fires | `H05`, `W-SYS-01`, `W-SYS-02` | — | — |
| [x] | 132 | `W-SITE-01` | Route spine, EN/AR locales, canonicalisation and the route registry | `W-SYS-01`, `W-SYS-03` | — | — |
| [x] | 133 | `W-SITE-02` | The premises row as the only NAP source: /api/facts, /llms.txt, robots policy | `B-CAT-01`, `B-CAT-02`, `B-CAT-03`, `B-CAT-04`, `B-CAT-05`, `B-CAT-06`, `F09`, `W-SITE-01` | — | Y1-nap |
| [x] | 134 | `W-SITE-03` | JSON-LD generated from the database | `B-CAT-01`, `B-CAT-02`, `B-CAT-03`, `B-CAT-04`, `B-CAT-05`, `B-CAT-06`, `W-SITE-02` | — | Y1-licence, Y2-gbp-status |
| [x] | 135 | `W-SITE-05` | Catalogue-derived routes: /treatments, /treatments/[slug], /pricing | `B-CAT-01`, `B-CAT-02`, `B-CAT-03`, `B-CAT-04`, `B-CAT-05`, `B-CAT-06`, `W-SITE-03`, `W-SYS-02` | — | Y9-poa-prices |
| [x] | 136 | `W-SYS-04` | Motion system: token overrides, distance-duration and the island budget | `W-SYS-02` | — | — |
| [x] | 137 | `W-SYS-05` | Image derivative pipeline, immutable media URLs and the storage fake | `F06`, `H02`, `W-SYS-01` | — | Y12-photos |
| [x] | 138 | `W-SYS-06` | Hero video rendition job | `W-SYS-05` | — | Y12-photos |
| [x] | 139 | `W-SYS-07` | HeroMedia: the LCP-safe poster and the attach island | `W-SYS-04`, `W-SYS-06` | — | — |
| [x] | 140 | `W-SITE-04` | Home route: the anchored page with a real LCP hero | `W-SITE-03`, `W-SYS-07` | — | — |
| [x] | 141 | `W-SYS-08` | Payload CMS v3 embedded, content model and the catalogue boundary | `F07`, `F09`, `W-SYS-01` | — | — |
| [x] | 142 | `W-SITE-07` | CMS-driven routes, internal linking and breadcrumbs | `W-SITE-03`, `W-SITE-05`, `W-SYS-08` | — | Y1-licence |
| [ ] | 143 | `W-SITE-10` | Publication control plane: banned-claims lint, named approval, immutable record | `F06`, `F09`, `W-SITE-07`, `W-SYS-08` | — | Y1-licence |
| [x] | 144 | `W-SYS-09` | Media slots: declared constraints, required alt and the junk-alt filter | `W-SYS-05`, `W-SYS-08` | — | Y12-photos |
| [ ] | 145 | `W-SITE-06` | Therapist routes and the publishing guard | `B-UI-01`, `B-UI-02`, `B-UI-03`, `B-UI-04`, `B-UI-05`, `P-HR-01`, `P-HR-02`, `P-HR-03`, `P-HR-04`, `P-HR-05`, `P-HR-06`, `P-HR-07`, `P-HR-08`, `P-HR-09`, `P-HR-10`, `P-HR-11`, `P-HR-12`, `P-HR-13`, `P-HR-14`, `W-SITE-03`, `W-SYS-09` | — | Y12-consent-photo, Y8-staff |
| [ ] | 146 | `W-SITE-08` | Sitemaps, hreflang, IndexNow and the publish propagation pipeline | `H02`, `W-SITE-05`, `W-SITE-06`, `W-SITE-07` | M4 | — |
| [ ] | 147 | `W-SITE-09` | Legacy WooCommerce URL migration and the 301 map | `W-SITE-08` | — | Y1-woo-baseline |
| [ ] | 148 | `W-SITE-11` | Performance enforcement: Lighthouse CI budgets and field RUM | `A-FIRST-01`, `A-FIRST-02`, `A-FIRST-03`, `A-FIRST-04`, `A-FIRST-05`, `A-FIRST-06`, `A-FIRST-07`, `A-FIRST-08`, `A-FIRST-09`, `A-FIRST-10`, `H05`, `W-SITE-04`, `W-SITE-05`, `W-SITE-06` | — | Y5-analytics-basis |
| [x] | 149 | `W-SYS-10` | Breakpoint preview in the CMS admin | `W-SYS-09` | — | — |
| [x] | 150 | `G-AGT-01` | Agent registry, heartbeat contract and 2x-interval watchdog | `F09`, `H02` | — | — |
| [x] | 151 | `G-CONN-01` | google_connections schema: one-to-many, sub-keyed, envelope-encrypted | `F04`, `F08`, `F09` | — | Y2-listing-owner, Y2-gbp-status |
| [x] | 152 | `G-CONN-02` | OAuth consent against the fake, granted-scope truth, sub-match reconnect semantics | `G-CONN-01`, `H02` | — | Y10-consent |
| [x] | 153 | `G-CONN-03` | withGoogle: the single chokepoint, error taxonomy and declared degradation | `G-CONN-02` | — | — |
| [x] | 154 | `G-CONN-04` | Proactive token refresh under an advisory transaction lock, double-checked | `G-CONN-03` | — | — |
| [x] | 155 | `G-CONN-05` | Account and location picker, LOCATION_GROUP enumeration, GSC selected independently | `G-CONN-03` | — | Y10-consent, Y2-listing-owner |
| [x] | 156 | `G-CONN-06` | Daily health check, Testing-expiry tripwire, listing-drift detection | `G-AGT-01`, `G-CONN-04`, `G-CONN-05` | — | Y4-token-test |
| [ ] | 157 | `G-CONN-07` | Connection state machine, plain-English states, Test connection, settings card | `G-CONN-06`, `W-SYS-01`, `W-SYS-02`, `W-SYS-03`, `W-SYS-04`, `W-SYS-05`, `W-SYS-06`, `W-SYS-07`, `W-SYS-08`, `W-SYS-09`, `W-SYS-10` | — | — |
| [ ] | 158 | `G-AGT-02` | Agent console: last success, cost against budget, pending approvals, kill switches | `G-AGT-01`, `G-CONN-07`, `W-SYS-01`, `W-SYS-02`, `W-SYS-03`, `W-SYS-04`, `W-SYS-05`, `W-SYS-06`, `W-SYS-07`, `W-SYS-08`, `W-SYS-09`, `W-SYS-10` | — | — |
| [ ] | 159 | `G-CONN-08` | Non-dismissible re-auth banner, escalating notification ladder, one-click reconnect | `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04`, `G-CONN-07` | — | — |
| [x] | 160 | `G-CONN-09` | Disconnect with revocation at Google, zeroisation, and the offboarding runbook | `F06`, `G-CONN-04` | — | — |
| [x] | 161 | `G-REV-01` | Review data model: nullable google_review_id, delivery_mode as a column | `G-CONN-01` | — | — |
| [ ] | 162 | `G-REV-02` | Fallback intake: paste form, defensive email parse, Places count tripwire, Monday nudge | `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04`, `G-AGT-01`, `G-REV-01` | — | Y3-gbp-api, Y2-gbp-status |
| [x] | 163 | `G-REV-03` | The safety routing table as executable, settings-proof policy | `G-REV-01` | — | — |
| [x] | 164 | `G-REV-04` | Reply generator: house-voice templates plus LLM, review text as untrusted data | `G-AGT-01`, `G-REV-03`, `H02` | — | — |
| [ ] | 165 | `G-REV-05` | The reply linter, blocking on the send path, one known-bad fixture per rule | `G-REV-04`, `W-SITE-01`, `W-SITE-02`, `W-SITE-03`, `W-SITE-04`, `W-SITE-05`, `W-SITE-06`, `W-SITE-07`, `W-SITE-08`, `W-SITE-09`, `W-SITE-10`, `W-SITE-11` | — | — |
| [ ] | 166 | `G-REV-06` | Approval queue: Copy reply, deep link, Marked as posted | `G-REV-05`, `W-SYS-01`, `W-SYS-02`, `W-SYS-03`, `W-SYS-04`, `W-SYS-05`, `W-SYS-06`, `W-SYS-07`, `W-SYS-08`, `W-SYS-09`, `W-SYS-10` | — | — |
| [ ] | 167 | `G-REV-07` | API delivery mode: the legacy v4 reviews adapter, isolated, flipped by a row | `G-CONN-05`, `G-REV-06`, `M-VAT-01`, `M-VAT-02`, `M-VAT-03`, `M-VAT-04`, `M-VAT-05`, `M-VAT-06`, `M-VAT-07`, `M-VAT-08`, `M-VAT-09`, `M-VAT-10`, `M-VAT-11`, `M-VAT-12`, `M-VAT-13` | — | Y3-gbp-api, Y2-gbp-status, Y2-listing-owner |
| [x] | 168 | `G-SEO-01` | GSC warehouse: nightly snapshots, startRow paging, the rare-query gap | `G-AGT-01`, `G-CONN-05` | — | — |
| [x] | 169 | `G-SEO-02` | The seo_agent principal: publish denied at the permission layer, target allowlist | `F07`, `G-SEO-01` | — | — |
| [x] | 170 | `G-SEO-03` | Query-side deterministic analyses: CTR outliers, content gaps, cannibalisation | `G-SEO-01` | — | — |
| [ ] | 171 | `G-SEO-04` | Site-side deterministic analyses: coverage anomalies, internal links, structured data | `G-SEO-01`, `W-SITE-01`, `W-SITE-02`, `W-SITE-03`, `W-SITE-04`, `W-SITE-05`, `W-SITE-06`, `W-SITE-07`, `W-SITE-08`, `W-SITE-09`, `W-SITE-10`, `W-SITE-11` | — | — |
| [ ] | 172 | `G-SEO-05` | Suggestion store with before/after and rollback, LLM drafting, red-team gate | `G-AGT-01`, `G-SEO-02`, `G-SEO-03`, `G-SEO-04` | — | — |
| [ ] | 173 | `G-SEO-06` | GBP-versus-website consistency check, degrading to a manual snapshot | `G-CONN-05`, `G-SEO-04` | — | Y3-gbp-api, Y1-nap |
| [ ] | 174 | `G-SEO-07` | Weekly plain-English report by Resend, five prioritised actions | `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04`, `G-AGT-02`, `G-SEO-05`, `G-SEO-06` | — | — |
| [ ] | 175 | `H-HARD-01` | Security headers, CSP and public-endpoint rate limiting | `A-FIRST-01`, `A-FIRST-02`, `A-FIRST-03`, `A-FIRST-04`, `A-FIRST-05`, `A-FIRST-06`, `A-FIRST-07`, `A-FIRST-08`, `A-FIRST-09`, `A-FIRST-10`, `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `H05`, `W-SITE-01`, `W-SITE-02`, `W-SITE-03`, `W-SITE-04`, `W-SITE-05`, `W-SITE-06`, `W-SITE-07`, `W-SITE-08`, `W-SITE-09`, `W-SITE-10`, `W-SITE-11` | — | — |
| [x] | 176 | `H-HARD-02` | Dependency, secret, licence and container scanning in CI | `F02`, `H05` | — | — |
| [x] | 177 | `H-HARD-03` | KEK rotation for clinical DEKs, and secret rotation | `F08`, `H-HARD-02` | — | Y5-residency |
| [ ] | 178 | `H-HARD-04` | Backup, PITR and the automated restore drill | `F04`, `M-VAT-01`, `M-VAT-02`, `M-VAT-03`, `M-VAT-04`, `M-VAT-05`, `M-VAT-06`, `M-VAT-07`, `M-VAT-08`, `M-VAT-09`, `M-VAT-10`, `M-VAT-11`, `M-VAT-12`, `M-VAT-13`, `R-REP-01`, `R-REP-02`, `R-REP-03`, `R-REP-04`, `R-REP-05`, `R-REP-06`, `R-REP-07`, `R-REP-08` | — | — |
| [ ] | 179 | `H-HARD-07` | Incident register and the PDPL breach-notification clock | `C-CRM-01`, `C-CRM-02`, `C-CRM-03`, `C-CRM-04`, `C-CRM-05`, `C-CRM-06`, `C-CRM-07`, `C-CRM-08`, `C-CRM-09`, `C-CRM-10`, `F06`, `F09`, `M-VAT-01`, `M-VAT-02`, `M-VAT-03`, `M-VAT-04`, `M-VAT-05`, `M-VAT-06`, `M-VAT-07`, `M-VAT-08`, `M-VAT-09`, `M-VAT-10`, `M-VAT-11`, `M-VAT-12`, `M-VAT-13` | — | Y1-entity |
| [ ] | 180 | `H-HARD-08` | Offline tolerance, honest failure and the paper fallback | `B-UI-01`, `B-UI-02`, `B-UI-03`, `B-UI-04`, `B-UI-05`, `H-HARD-01`, `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13` | — | — |
| [ ] | 181 | `H-HARD-10` | Pen-test intake, findings register and the remediation gate | `H-HARD-01`, `H-HARD-02` | — | Y13-pentest |
| [ ] | 182 | `H-HARD-11` | Load and concurrency soak at realistic peak | `B-AVAIL-01`, `B-AVAIL-02`, `B-AVAIL-03`, `B-AVAIL-04`, `B-AVAIL-05`, `B-AVAIL-06`, `B-AVAIL-07`, `H-HARD-01`, `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13` | — | — |
| [ ] | 183 | `H-MIG-01` | Migration framework: staging schema, provenance and resumable idempotent importers | `F04`, `F06`, `H-HARD-04` | — | — |
| [ ] | 184 | `H-MIG-02` | Package templates in settings, and the reconstruction workbook validator | `F09`, `H-MIG-01`, `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13` | — | Y8-packages, Y9-package-policy |
| [ ] | 185 | `H-MIG-03` | Package liability import, opening deferred revenue and cash reconciliation | `H-MIG-02`, `M-VAT-01`, `M-VAT-02`, `M-VAT-03`, `M-VAT-04`, `M-VAT-05`, `M-VAT-06`, `M-VAT-07`, `M-VAT-08`, `M-VAT-09`, `M-VAT-10`, `M-VAT-11`, `M-VAT-12`, `M-VAT-13` | — | Y8-packages, Y11-vat-package, Y9-package-thin |
| [ ] | 186 | `H-MIG-04` | Customer import: E.164 normalisation, dedup and the consent floor | `C-CRM-01`, `C-CRM-02`, `C-CRM-03`, `C-CRM-04`, `C-CRM-05`, `C-CRM-06`, `C-CRM-07`, `C-CRM-08`, `C-CRM-09`, `C-CRM-10`, `H-MIG-01` | — | Y8-customers, Y1-nap |
| [ ] | 187 | `H-MIG-05` | Historic bookings and appointment history | `B-LIFE-01`, `B-LIFE-02`, `B-LIFE-03`, `H-MIG-04` | — | — |
| [ ] | 188 | `H-MIG-06` | Staff, credentials and leave opening balances | `H-MIG-01`, `P-HR-01`, `P-HR-02`, `P-HR-03`, `P-HR-04`, `P-HR-05`, `P-HR-06`, `P-HR-07`, `P-HR-08`, `P-HR-09`, `P-HR-10`, `P-HR-11`, `P-HR-12`, `P-HR-13`, `P-HR-14` | — | Y8-staff, Y8-leave, Y12-consent-photo |
| [ ] | 189 | `H-MIG-07` | Accounting opening balances and the period boundary lock | `H-MIG-03`, `M-VAT-01`, `M-VAT-02`, `M-VAT-03`, `M-VAT-04`, `M-VAT-05`, `M-VAT-06`, `M-VAT-07`, `M-VAT-08`, `M-VAT-09`, `M-VAT-10`, `M-VAT-11`, `M-VAT-12`, `M-VAT-13` | — | Y8-opening-balances, Y8-coa, Y1-trn |
| [ ] | 190 | `H-MIG-08` | The reconciliation report generator | `H-MIG-03`, `H-MIG-04`, `H-MIG-05`, `H-MIG-06`, `H-MIG-07` | — | — |
| [ ] | 191 | `H-MIG-09` | Three dry runs, gated on zero unexplained variance | `H-HARD-04`, `H-MIG-08` | — | — |
| [ ] | 192 | `H-MIG-10` | Parallel run, staff pilot instrumentation and front-desk speed | `B-UI-01`, `B-UI-02`, `B-UI-03`, `B-UI-04`, `B-UI-05`, `H-MIG-09`, `R-REP-01`, `R-REP-02`, `R-REP-03`, `R-REP-04`, `R-REP-05`, `R-REP-06`, `R-REP-07`, `R-REP-08` | — | Y12-pilot, Y14-devices |
| [ ] | 193 | `Y-PAY-01` | Payment gateway port, adapter conformance suite and provider registry | `F03`, `H02`, `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13` | — | — |
| [ ] | 194 | `Y-PAY-02` | payment_intent, idempotency and the capture/refund state machine | `F06`, `Y-PAY-01` | — | — |
| [ ] | 195 | `Y-PAY-03` | SAQ-A hosted-fields checkout and the PAN-never-touched gate | `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13`, `Y-PAY-02` | — | — |
| [ ] | 196 | `Y-PAY-04` | Webhook ingest: signature verification, replay protection, idempotent handlers | `F06`, `Y-PAY-02` | — | — |
| [ ] | 197 | `Y-PAY-05` | Missed-event reconciliation job | `Y-PAY-04` | — | — |
| [ ] | 198 | `H-HARD-05` | Alert registry, SLOs and the insider-threat export alarm | `F06`, `H-HARD-01`, `R-REP-01`, `R-REP-02`, `R-REP-03`, `R-REP-04`, `R-REP-05`, `R-REP-06`, `R-REP-07`, `R-REP-08`, `Y-PAY-05` | — | — |
| [ ] | 199 | `H-HARD-06` | Runbook set, machine-checked | `B-MSG-01`, `B-MSG-02`, `B-MSG-03`, `B-MSG-04`, `G-CONN-01`, `G-CONN-02`, `G-CONN-03`, `G-CONN-04`, `G-CONN-05`, `G-CONN-06`, `G-CONN-07`, `G-CONN-08`, `G-CONN-09`, `H-HARD-04`, `H-HARD-05` | — | — |
| [ ] | 200 | `H-HARD-09` | Documentation set, processor register and bus-factor artefacts | `H-HARD-06`, `H-HARD-07`, `H01` | — | — |
| [ ] | 201 | `Y-PAY-06` | Deposits and prepayment as an appointment-scoped payment on account | `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13`, `Y-PAY-02` | — | Y9-windows |
| [ ] | 202 | `Y-PAY-07` | Card-on-file mandates and the no-show / late-cancellation fee path | `Y-PAY-06` | — | Y9-windows |
| [ ] | 203 | `Y-PAY-08` | Refunds, partial refunds and chargebacks in the append-only journal | `M-TILL-01`, `M-TILL-02`, `M-TILL-03`, `M-TILL-04`, `M-TILL-05`, `M-TILL-06`, `M-TILL-07`, `M-TILL-08`, `M-TILL-09`, `M-TILL-10`, `M-TILL-11`, `M-TILL-12`, `M-TILL-13`, `Y-PAY-04` | — | — |
| [ ] | 204 | `Y-PAY-09` | Settlement import and reconciliation to the fils | `M-VAT-01`, `M-VAT-02`, `M-VAT-03`, `M-VAT-04`, `M-VAT-05`, `M-VAT-06`, `M-VAT-07`, `M-VAT-08`, `M-VAT-09`, `M-VAT-10`, `M-VAT-11`, `M-VAT-12`, `M-VAT-13`, `Y-PAY-08` | — | — |
| [ ] | 205 | `Y-PAY-10` | Discreet statement descriptor, MCC gate and the payments go-live guard | `F09`, `W-SITE-01`, `W-SITE-02`, `W-SITE-03`, `W-SITE-04`, `W-SITE-05`, `W-SITE-06`, `W-SITE-07`, `W-SITE-08`, `W-SITE-09`, `W-SITE-10`, `W-SITE-11`, `Y-PAY-09` | — | Y7-mcc |
| [ ] | 206 | `H-MIG-11` | Freeze, go/no-go check and the cutover runbook with rollback | `H-HARD-06`, `H-HARD-09`, `H-HARD-10`, `H-MIG-10`, `Y-PAY-10` | — | Y13-pentest, Y11-tax-agent, Y10-consent, Y6-sender-ids, Y7-mcc |

## Legend

`[x]` done  ·  `[~]` in progress  ·  `[ ]` todo  ·  `[!]` blocked

*(expand)* = group-level unit; decompose into session-sized units before working it.

A unit is `done` only when every acceptance check in the manifest passes in CI —
never on assertion. See [12-autonomous-delivery.md](12-autonomous-delivery.md) §6.
