# ADR 0019 — Payload CMS inside the same application and the same database

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H01
- **Covers:** docs/01 decision 15

## Decision

**Payload CMS v3, embedded in the Next.js application, writing to the same PostgreSQL.** Not a
headless CMS on its own host, not a hosted SaaS, not a second database.

## Why embedded

One deployment, one database, one backup, one set of credentials, one place a page can be slow. For a
single-location business with one builder, every additional running service is a thing that can be
down at 11pm on a Friday with nobody to notice.

It also removes the class of bug where the CMS and the application disagree about what exists. A
decoupled CMS means content lives in one store and bookings in another, and every page that shows both
is a join across a network.

## The line between the CMS and the catalogue

This is the decision that actually matters, and it is easy to get wrong in the other direction — a CMS
that owns everything ends up owning price.

- **The catalogue owns price, duration, bookability and the required therapist skill.** It is
  operational data, changed by the owner in settings, and it drives the booking engine.
- **The CMS owns narrative and SEO copy**: page content, the description beside a service, therapist
  biographies, the words on the homepage.

A service's price is never edited in the CMS, and a page's prose is never edited in the catalogue. When
a page shows a price, it reads it from the catalogue at render time. So an owner changing a price
changes it in one place and every surface follows — the site, the booking flow, the till, the invoice.

## Consequences

- Payload's tables share the database with the application's. Migrations are SQL-first for ours
  ([ADR 0006](0006-sql-first-migrations.md)) and Payload-managed for its own; the schema-drift gate
  covers our mirrors and deliberately does not police Payload's.
- Publication passes a **lint against the banned-claims lexicon**
  ([ADR 0020](0020-regulatory-profile-drives-vocabulary-and-eligibility.md)). Copy that claims a
  treatment is therapeutic is a licensing problem, and the CMS is where that copy is written.
- Editorial media goes through named slots with declared aspect ratios and required alt text
  (docs/08 §6), so an editor cannot publish a page that breaks its own layout.

## Rejected

**A separate headless CMS.** A second deployment, a second bill, a second auth system, and content a
network hop away from the pages that render it — in exchange for an independence this project has no
use for.
