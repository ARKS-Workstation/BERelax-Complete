# BeRelax — Spa & Massage Business Platform

Custom booking, CRM and back-office platform for a single-location massage and spa
business in the UAE.

**Status: planning. No application code yet.** This repository currently contains the
implementation plan only.

## Start here

| Document | What it covers |
|---|---|
| [docs/00-plan.md](docs/00-plan.md) | The single-release build plan: dependency graph, workstreams, integration milestones, cutover — **read this first** |
| [docs/01-scope-and-decisions.md](docs/01-scope-and-decisions.md) | Confirmed scope, what is explicitly out, and the locked technical decisions |
| [docs/02-architecture.md](docs/02-architecture.md) | Stack, deployment topology, data model spine, cross-cutting services |
| [docs/03-modules.md](docs/03-modules.md) | Module-by-module specification of all nine requested subsystems |
| [docs/04-uae-compliance.md](docs/04-uae-compliance.md) | UAE licensing, tax, telecom and privacy rules translated into software requirements |
| [docs/05-external-dependencies.md](docs/05-external-dependencies.md) | The three items in an external queue, and what is answerable from documents already held |
| [docs/06-blind-spots-and-risks.md](docs/06-blind-spots-and-risks.md) | What was missing from the original brief, plus the risk register |
| [docs/07-frontend-and-agents-requirements.md](docs/07-frontend-and-agents-requirements.md) | Confirmed frontend, SEO and agent requirements — design language, settings model, review autoresponder, Google connection |
| [docs/08-frontend-design.md](docs/08-frontend-design.md) | The design system: accessible pastel palette with measured ratios, type, motion tokens, media/hero technique, performance budget |
| [docs/09-ia-seo-and-settings.md](docs/09-ia-seo-and-settings.md) | Page set, therapist pages, mobile booking flow, the location record that drives all SEO, and the settings spine |
| [docs/10-google-connection.md](docs/10-google-connection.md) | The owner-consented Google OAuth connection: API access gating, token lifecycle, identity, and the fallback that is actually launch mode |
| [docs/11-execution-plan.md](docs/11-execution-plan.md) | **The execution plan** — single-track build order, what only the owner can do, the operating model, and the migration |

## The one-paragraph summary

Nine modules were requested: booking engine, CRM with SMS marketing and a drag-and-drop flow builder,
GA4 + Meta analytics with server-side push, a CMS, a frontend, HR with leave management, accounting with
VAT and recurring costs, financial analysis, and an agentic SEO system with Google Search Console access.
The whole system is built in one go and launched once. The business is already operating, so it keeps
trading on its current process throughout the build, and the end of the build is a **data migration and
cutover**, not a launch. Claude is the builder, so the plan is a single-threaded dependency order of work
units with the repository as the memory between sessions — see
[docs/11-execution-plan.md](docs/11-execution-plan.md), whose §2 lists the fourteen things only the owner
can do. Two of the nine modules are *integrate, not build*: statutory tax filing and payroll mechanics.
