# Scope and Locked Decisions

## 1. In scope

Nine modules, as requested: booking engine; CRM with SMS marketing, automatic reminders and a
drag-and-drop flow; GA4 + Meta analytics with server-side push; CMS; public frontend; HR with
leave management; accounting with recurring costs, VAT and tax-return-ready documents;
financial analysis; and an agentic SEO system with Google Search Console access.

## 2. Explicitly out of scope

| Excluded | Why |
|---|---|
| Home/hotel outcall, mobile therapists | Dropped by the owner. Removes travel-time matrices, geocoding, maps API cost, dispatcher console, zone pricing, vehicle and mileage records, GPS lone-worker tracking and arrival-window booking |
| Multi-branch / franchise | One location, permanently |
| Multi-tenancy | Follows from the above |
| Automated statutory tax filing | The taxable person carries the liability. The system produces working papers; a human files |
| A payroll calculation engine | Export to a reviewed WPS file instead of reimplementing UAE payroll law |
| Native mobile apps | Responsive web and a PWA cover it at this scale |

### What dropping outcall actually saved

Travel-time matrix and zone-to-zone caching, maps/routing API integration and its per-call
bill, client address capture and geocoding, service-area eligibility checks, travel blocks on
therapist calendars, the dispatcher console and map view, distance and zone pricing, vehicle
and driver records, mileage and toll expense capture, GPS check-in/check-out, duress escalation
and the lone-worker safety tree, and arrival-window rather than exact-time booking. Conservatively
**6–9 engineer-weeks**, and a materially smaller PII surface. Reinvest it in the availability
engine, the accounting journal and the consent/audit model — the three things that cannot be
retrofitted cheaply.

### What single-location saved

`branch_id` on 35–45 tables and its composite-index prefix, the branch-scoped query client,
Postgres RLS with an `app.current_branch` GUC and the `SET LOCAL` discipline it forces (which
also removes a PgBouncer transaction-mode hazard), the generic organisations table, the branch
switcher and `/b/:slug` URL scoping, per-branch hours/pricing/roles, the "all branches"
aggregate query paths, and the branch dimension in reporting. Roughly **4–6 engineer-weeks**
and a significantly smaller permission matrix and test surface.

## 3. Seams kept anyway

Deleting multi-branch does not mean hard-coding everything. Four seams stay because they are
nearly free and expensive to add later:

1. **`legal_entity`** (one row) — licence number, TRN, VAT registration date, corporate-tax
   registration, financial year end, Small Business Relief election. Belongs to the company and
   survives a relocation.
2. **`premises`** (one row) — trading address, opening hours, rooms. Belongs to the building.
   Separate from `legal_entity` so a relocation does not touch tax identity, and so an invoice
   can snapshot its issuing address without historic invoices silently rewriting themselves.
3. **`service_location` semantics on the appointment** — reduced to "at the premises, in a
   room", but the room/bed resource model is the location dimension and it is central.
4. **A brand seam, documented but not built.** A second trading name (a ladies-only sub-brand,
   a men's line) is materially more likely than a second premises, and it touches only services,
   price lists, CMS pages, templates, invoice branding, domain, GA4 stream, pixel and GSC
   property — never operational or financial tables. That is a contained 2–4 week project.

A dormant `branch_id` was considered and **rejected**: it costs an index prefix and a mandatory
predicate on every query, invites a half-enforced scoping habit that is never tested, and would
be wrong anyway when a real second location arrives. Genuine multi-location is a 6–10 week
project; that price is recorded here rather than paid for in advance.

## 4. Locked technical decisions

Each of these should become an ADR in `docs/adr/` when workstream F starts.

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Repo shape | pnpm monorepo: one Next.js app (public + admin route groups), one worker service, shared `db` / `core` / `ui` packages | A second deploy target buys nothing at this scale and duplicates auth, session, design system and CI. Domain logic lives in a framework-free `core` package so a future split is cheap |
| 2 | Framework | Next.js App Router, server components by default | SEO is an explicit goal; see the SPA note in [02-architecture.md](02-architecture.md) |
| 3 | ORM | **Drizzle** | SQL-first, so `tstzrange`, `btree_gist` exclusion constraints, deferred triggers and materialised views are first-class rather than escape hatches. No engine binary. Clean under PgBouncer transaction pooling |
| 4 | Job queue | **pg-boss** on the primary Postgres | Gives transactional enqueue in the same transaction as the outbox write — the property that actually prevents dropped and duplicated sends. Removes a Redis component, a bill and a failure mode. Revisit above ~100 sustained jobs/sec, which this business will not reach |
| 5 | Staff auth | Better Auth, Postgres sessions, **mandatory TOTP 2FA** for owner/manager/accountant | TypeScript-native, 2FA built in, no external IdP bill |
| 6 | Customer auth | None. Phone-first identity with SMS OTP, guest booking | Accounts are friction on a booking flow. A stable `customer_id` exists regardless |
| 7 | Money | **Integer fils, gross (VAT-inclusive) authoritative**; net and VAT derived and stored immutably per document line | UAE consumer prices are displayed tax-inclusive and must be honoured. Storing net produces AED 262.50 prices that marketing rounds, silently desynchronising the agreed price, the invoice and the ledger. Every downstream number depends on this one choice |
| 8 | Time | `timestamptz` everywhere, one date library, `Asia/Dubai` as the business timezone (no DST), deterministic clock in tests | |
| 9 | Double-booking | `btree_gist` exclusion constraint on `(therapist_id, period)`; deferred constraint trigger counting overlaps against `rooms.capacity`; `SELECT … FOR UPDATE` on the room row inside the booking transaction | A therapist can never be in two places, so an exclusion constraint is exact. A capacity-2 couples room legitimately allows two overlapping appointments but not three, which an exclusion constraint cannot express. Application-level checks alone are a race |
| 10 | Clinical data | Separate `clinical` schema, own DB role, envelope encryption (DEK per record, KEK outside the database), UUID-only references, **no foreign keys across the boundary**, separate RBAC and audit log | Makes relocating health notes to a UAE region a week of work rather than a rewrite, if the lawyer's answer requires it. The booking layer sees boolean contraindication flags only |
| 11 | Messaging | Two separately registered sender IDs (transactional; `AD-` promotional). `message_class` immutable on the **template**. Consent, quiet hours and suppression enforced **in the send path as code, not settings**. Marketing kill switch that cannot touch transactional traffic | With one sender ID, one over-eager blast suspends the identity and every booking confirmation stops — a marketing decision causing an operational outage |
| 12 | Template model | Channel-shaped from day one: per-channel variants, category, approval state, customer-care window | WhatsApp is later but inevitable in this market. Retrofitting it into a flat SMS-shaped table means touching every send path |
| 13 | Accounting | Internal append-only double-entry journal for operational truth; corrections by dated reversal; period locking. **Statutory filing integrated to Zoho Books.** No auto-file capability in the codebase — absent, not disabled | The taxable person carries the liability. A flag keeping auto-file off will eventually be switched on by a future maintainer |
| 14 | Analytics | GA4 + Meta Pixel client-side; server-side push from the transactional outbox; first-party `/api/collect` route **instead of** a server-side GTM container; egress guard mapping services to opaque category codes | A sGTM container is real monthly cost and maintenance for benefits this traffic level does not need. Health data must never reach Google or Meta |
| 15 | CMS | Payload CMS v3 embedded in the same Next.js app, same Postgres | One deployment, one database, no second source of truth. The catalogue owns price and bookability; the CMS owns narrative and SEO copy |
| 16 | Database | DO Managed Postgres 2 vCPU / 4 GB **with a standby node**, 60 GB+. No read replica | Data volume is 3–8 GB in year one, so size is not the argument — availability is. A spa that cannot take bookings on a Friday night loses real revenue. Materialised views on the primary suffice until DB CPU sits above 50% for a week |
| 17 | Region | Frankfurt as the working assumption, **pending the health-data residency answer** | DigitalOcean has no UAE region. This is a documented legal decision, not a hosting default |
| 18 | Extensions | `btree_gist`, `pgcrypto`, `pg_trgm`, `unaccent`. No PostGIS | PostGIS was only needed for outcall zones |
| 19 | Gender matching | A hard constraint in the availability solver, **default strict**, downgradable to advisory only as an audited configuration change once the licensing authority confirms in writing | If it applies and the engine cannot express it, the system routinely generates bookings that must be cancelled by hand, and one non-compliant appointment at inspection is a licence risk. The safe behaviour is what happens if nobody configures anything |
| 20 | Regulatory profile | A single versioned config row driving vocabulary, retention, permitted titles and credential requirements, defaulting to the **stricter** of wellness and healthcare | Makes the build immune to a late answer from the lawyer |

## 5. Things not to build at this scale

With the honest threshold at which each would become justified:

| Not now | Justified when |
|---|---|
| Kubernetes / DOKS | Multiple teams deploying independently, or >10 services |
| Microservices | Team >8 engineers with genuine domain ownership splits |
| A separate standalone API service | A native mobile app or third-party partner integrations ship |
| Event sourcing / CQRS | Never, for this business |
| Data warehouse / BigQuery | Reporting queries exceed ~30s on the primary, or >100 GB of facts |
| Temporal | Workflows exceeding days with complex compensation logic |
| Kafka or a hosted broker | >10k events/sec, or cross-system fan-out to many consumers |
| Read replicas | Database CPU sustained above 50% for a week |
| Multi-region | A second country of operation |
| GraphQL | Many heterogeneous clients you do not control |
| A separate admin application | Public Core Web Vitals degrade measurably, or admin needs an IP allowlist |

## 6. Things to do properly now, because retrofitting is brutal

Each is cheap before there is data and expensive after:

- **Integer minor units with explicit currency.** Floats in money produce errors discovered during a VAT reconciliation, by which point they are historical.
- **`timestamptz` everywhere**, one date library, business timezone explicit.
- **Append-only accounting journal**, credit notes instead of edits. Editable history destroys auditability permanently.
- **Price and tax snapshotting** onto bookings and invoices. Reading price live means a price change rewrites history.
- **Audit log** including reads of sensitive data. Cannot be reconstructed after the fact.
- **Transactional outbox / domain events.** Retrofitting means finding every side effect already scattered through request handlers.
- **Field-level encryption** of clinical and staff-sensitive fields. Encrypting a populated table under load is a migration nobody wants.
- **Per-channel, per-purpose consent with proof of capture.** Consent you cannot prove is consent you do not have.
- **Idempotency keys** on the public booking endpoint from day one, and on payments from the first line of payment code.
- **Soft-delete plus anonymise**, never hard delete, to reconcile PDPL erasure with the FTA's five-year retention.
