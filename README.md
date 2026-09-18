# BeRelax — Spa & Massage Business Platform

Custom booking, CRM and back-office platform for a single-location massage and spa
business in the UAE.

**Status: planning. No application code yet.** This repository currently contains the
implementation plan only.

## Start here

| Document | What it covers |
|---|---|
| [docs/00-plan.md](docs/00-plan.md) | Executive summary and the phased roadmap — **read this first** |
| [docs/01-scope-and-decisions.md](docs/01-scope-and-decisions.md) | Confirmed scope, what is explicitly out, and the locked technical decisions |
| [docs/02-architecture.md](docs/02-architecture.md) | Stack, deployment topology, data model spine, cross-cutting services |
| [docs/03-modules.md](docs/03-modules.md) | Module-by-module specification of all nine requested subsystems |
| [docs/04-uae-compliance.md](docs/04-uae-compliance.md) | UAE licensing, tax, telecom and privacy rules translated into software requirements |
| [docs/05-external-dependencies.md](docs/05-external-dependencies.md) | Things with external lead times — start these now, not when the code needs them |
| [docs/06-blind-spots-and-risks.md](docs/06-blind-spots-and-risks.md) | What was missing from the original brief, plus the risk register |

## The one-paragraph summary

Nine modules were requested: booking engine, CRM with SMS marketing and a drag-and-drop
flow builder, GA4 + Meta analytics with server-side push, a CMS, a frontend, HR with leave
management, accounting with VAT and recurring costs, financial analysis, and an agentic SEO
system with Google Search Console access. That is genuinely several products. The plan
sequences them into eleven phases across roughly 40–50 engineer-weeks, ordered so that each
phase changes a business number rather than merely adding surface area. Two of the nine are
recommended as **integrate, not build** (statutory tax filing and payroll mechanics). One
piece of the original sequencing is wrong and is corrected in the plan: the *public booking
interface* cannot be built last, because the booking engine cannot be validated or earn
revenue without it — what can safely come last is the marketing site and CMS.
