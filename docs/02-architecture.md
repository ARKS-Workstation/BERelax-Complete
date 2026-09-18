# Architecture

## 1. The SPA question, answered directly

The brief calls the site an SPA and also requires it to be SEO and LLM-SEO optimised. Those two
goals are in direct tension, and the tension has to be resolved in favour of SEO.

A client-rendered SPA ships an empty HTML shell and builds the page in JavaScript. Google can
render JavaScript but defers it, spending crawl budget to do so. More importantly, **most AI
answer engines do not execute JavaScript at all** — they fetch HTML. A client-rendered site is
therefore close to invisible to exactly the channel the brief wants to win.

The resolution: **Next.js App Router with server components**. Marketing and content pages are
static or ISR; service pages are generated from the catalogue; the booking widget is the only
substantially client-side surface, and it is an island inside a server-rendered page. The site
*feels* like an SPA to a user — client-side navigation, no full reloads — while serving complete
HTML to every crawler. This is not a compromise; it is strictly better on both axes.

## 2. Deployment topology

```
                     Cloudflare  (WAF, DDoS, bot management, CDN)
                           │
              ┌────────────┴────────────┐
              │  DO App Platform        │
              │                         │
              │  web       (2 inst.)    │  Next.js: public site, booking,
              │                         │  admin route group, Payload CMS,
              │                         │  /api/collect, webhooks
              │                         │
              │  worker    (1 inst.)    │  pg-boss: reminders, campaigns,
              │                         │  analytics push, reports, SEO agent,
              │                         │  compliance jobs, nightly rollups
              └────────────┬────────────┘
                           │ VPC (private, TLS verify-full)
              ┌────────────┴────────────┐
              │ DO Managed PostgreSQL   │  2 vCPU / 4 GB + standby
              │  schema: app            │  operational data
              │  schema: clinical       │  separate role, envelope-encrypted
              │  schema: reporting      │  materialised views
              │  pg-boss tables         │  durable jobs
              └─────────────────────────┘
                           │
              DO Spaces + CDN            media, invoice PDFs, payslips,
                                         document scans (private, signed URLs)
```

External: Resend (email), SMSala (SMS), GA4 Measurement Protocol, Meta Conversions API,
Google Search Console API, Zoho Books (statutory filing), Sentry, a payment gateway from
workstream Y (Payments).

**Why App Platform and not Droplets or DOKS.** App Platform gives managed TLS, zero-downtime
rolling deploys, log aggregation and a separate worker component without writing any
infrastructure code. Its limits — build minutes, no persistent local disk, less networking
control — do not bind at this scale. Droplets would become right if you needed persistent local
state or an unusual network topology; DOKS is not justified until multiple teams deploy
independently.

**Why the worker is a separate component.** The web process must never run the job queue. A long
campaign send would compete with page rendering for CPU, and a rolling web deploy would kill
in-flight jobs mid-send.

## 3. Repository layout

```
apps/
  web/                    Next.js App Router
    app/(public)/         marketing, service pages, booking flow  — SSG/ISR
    app/(admin)/          calendar, checkout, CRM, HR, accounts   — dynamic, noindex
    app/(payload)/        Payload CMS admin
    app/api/              collect, webhooks, public booking API (versioned)
  worker/                 pg-boss workers, cron registrations
packages/
  core/                   framework-free domain logic: availability, pricing,
                          VAT, leave accrual, commission, ledger. Pure functions,
                          heavily unit-tested, no Next.js or DB imports
  db/                     Drizzle schema, migrations, repositories, seed
  clinical/              the clinical boundary: repository interface + crypto
  messaging/              channel adapters (SMSala, Resend), template engine,
                          the compliance gate
  ui/                     design system, shadcn/ui components
  shared/                 types, zod schemas, money, dates, errors, i18n keys
docs/
  adr/                    architecture decision records
```

Module boundaries are enforced with an ESLint import-boundary rule. `core` may not import from
`db`; `db` may not import from `apps`. This is what stops a nine-module system rotting into a
ball of mud, and it is nearly free to set up in workstream F (Foundation).

## 4. Data model spine

Not exhaustive — the shape that matters.

**Identity and configuration**
`legal_entity` (1 row), `premises` (1 row), `regulatory_profile` (versioned), `premises_hours`,
`premises_closures`, `room_types`, `rooms`, `resource_blocks`.

**Catalogue**
`service_category`, `service` (**`style` enum: asian | arabic**, internal name + linted public display
name, turnaround minutes, taxability, gender delivery rules), `service_variant` (duration + **gross price
in fils**), `add_on`, `service_room_type_compat` (the wet room is a scarce resource),
`service_skill` (style → required therapist skill), `service_resource_shape` (therapists and rooms
required — 2 therapists + 1 room for Four Hands, 2 therapists + a capacity-2 room for Couple Massage),
`price_list` with effective dating.

**Booking**
`customer` (E.164 phone, normalised, plus dedup match keys), `booking` (the commercial container),
`appointment` (n per booking; `room_id`,
`therapist_id`, `period tstzrange`, snapshotted price and tax), `appointment_status_history`,
`waitlist`, `booking_idempotency`.

Concurrency: `EXCLUDE USING gist (therapist_id WITH =, period WITH &&)` on appointments, plus a
deferred constraint trigger counting room overlaps against `rooms.capacity`.

**Clinical** (separate schema)
`intake_form_template` (versioned), `intake_submission` (encrypted payload, DEK reference),
`treatment_note`, `consent_record` (form version, wording hash, timestamp), and a materialised
`contraindication_flags` view exposing booleans only across the boundary.

**CRM and messaging**
`customer_preference`, `customer_tag`, `lead`, `pipeline_stage`, `segment` (definition + cached
count), `consent` (channel × purpose × timestamp × wording version), `suppression` (hashed),
`message_template` (+ per-channel variants, immutable `message_class`), `message` (provider id,
status lifecycle, segments, cost), `campaign`, `flow_definition` (versioned JSON DSL),
`flow_enrolment`, `frequency_ledger`.

**Money**
`invoice` (snapshotted issuer name/address/TRN, gapless series number), `invoice_line`,
`credit_note`, `payment`, `refund`, `cash_session`, `package_template` (configured in settings),
`package_sale`, `package_balance`, `package_redemption`, `journal_entry` + `journal_line` (append-only), `account` (with `vat_box` tag),
`supplier`, `supplier_tax_profile` (offshore flag driving reverse charge), `bill`,
`recurring_cost`, `expense_claim`, `stock_item`, `stock_movement`, `period_lock`.

**HR**
`employee`, `employee_document` (type, number encrypted, expiry — drives availability),
`skill`, `employee_skill`, `shift`, `shift_assignment`, `attendance`, `leave_type`,
`leave_balance`, `leave_request`, `commission_rule` (versioned), `commission_line`, `payslip`,
`gratuity_accrual`.

**Platform**
`audit_event` (append-only, monthly partitions), `outbox_event`,
`obligation` + `obligation_instance` (compliance calendar), `publication_record`, `seo_gsc_daily`,
`seo_suggestion`, `incident`, `business_day` (open/close instants per date, so a 01:30 appointment
resolves to the previous day).

**First-party analytics** (own schema, monthly partitions, 90-day raw retention)
`visitor` (first-party id), `session` (entry page, referrer, UTM set, click ids `gclid`/`fbclid`/
`wbraid`/`msclkid`, `fbp`/`fbc`, device, breakpoint, bot flag), `event` (page_view and every tracked
interaction incl. WhatsApp and call clicks), `attribution` (first-touch and last-touch, persisted onto
`customer` and `booking`), `whatsapp_ref` (short code → session, reconciled at booking),
`funnel_step`, plus nightly rollups `daily_traffic`, `daily_funnel`, `daily_source_revenue` retained
indefinitely, and `analytics_dispatch` for outbound GA4/Meta pushes with retries.

**Reporting** (separate schema, materialised)
`dim_date`, `dim_service`, `dim_staff`, `dim_customer`, `fact_appointment`, `fact_sale`,
`fact_shift`, refreshed nightly and on demand.

## 5. Cross-cutting services built once in workstream F (Foundation)

- **Config and env validation at boot** — fail fast on a missing secret, never at 2am on a Friday.
- **Structured JSON logging** with correlation IDs; Sentry for errors.
- **Audit service** — every mutation with before/after, every read of clinical or salary data,
  every export. Client-list exports are logged *and alerted*: that is the insider-threat control.
- **Transactional outbox + event publisher.** The event catalogue (`booking.created`,
  `booking.rescheduled`, `booking.completed`, `invoice.issued`, `leave.approved`, …) is versioned.
- **Notification service** routing through the messaging compliance gate. Nothing sends by
  calling a provider SDK directly.
- **Money and date utilities.** Integer fils, one date library, business timezone explicit.
- **PDF service** for invoices, payslips and reports — with early attention to Arabic/RTL
  rendering, which is genuinely painful and worth proving in workstream F (Foundation) rather than discovering in
  workstream M (Money).
- **Export service** (CSV/Excel), gated by permission and always audited.
- **Feature flags**, so a half-built module can ship dark.
- **Staging send guard** — a hard block preventing any non-production environment from ever
  messaging a real customer. This is the classic disaster and the guard costs an afternoon.

## 6. Authorisation model

Roles: `owner`, `manager`, `accountant`, `receptionist`, `therapist`, `marketer`, `auditor`,
`system`. Deny by default, permissions checked in a single policy layer rather than sprinkled
through handlers.

Field-level rules matter more than route-level ones here. A receptionist can see that a client
has a contraindication flag but not read the health notes. A therapist sees their own schedule
and their clients' preferences but cannot export the client list. An accountant sees every
financial record but no clinical data. Clinical reads require step-up authentication and are
individually logged.

## 7. Testing strategy

The `core` package carries the highest-value tests because it holds every calculation where a
bug costs money or breaks the law:

- **Availability engine** — property-based tests: no double-booked therapist, no room over
  capacity, no appointment crossing a closure, turnaround always respected, gender constraint
  never violated.
- **Pricing and VAT** — gross/net/VAT round-trip at every rate, rounding to the fils, discount
  and package interactions.
- **Leave accrual, commission, gratuity** — worked examples from the labour law, reviewed by a
  human who knows the rules.
- **Ledger** — every journal entry balances; period locks hold; reversals reconcile.
- **Consent gating** — a send is impossible without valid consent, inside quiet hours, or to a
  suppressed contact. These are tested as *invariants*, not features.

Integration tests run against real Postgres in CI (the exclusion constraints and deferred
triggers cannot be tested against a mock). Playwright covers the booking happy path and the top
failure paths. Provider integrations use recorded fixtures.
