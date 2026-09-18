# ADR 0013 — server-rendered, not a single-page application

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H01
- **Covers:** docs/01 decision 2

## The tension

The brief asked for "an agentic flow with Google Search Console access to ensure better SEO for the
SPA". Those two halves pull in opposite directions. A single-page application renders its content in
the browser; investing in SEO for it means paying an agent to optimise pages that a large share of
crawlers never see rendered.

Googlebot does execute JavaScript, in a second pass, on its own schedule. Almost nothing else does.
Bing's coverage is partial. Facebook's and WhatsApp's link previewers do not. And the crawlers that
now matter most for a local business — the ones behind AI answers, which is where "LLM SEO" actually
lives — read HTML and stop. A spa in Al Zahiyah competing for `massage centre Al Zahiyah` cannot
afford to be invisible to half of them.

## Decision

**Next.js App Router, server components by default.** The public site renders on the server: HTML
arrives complete, with content, structured data and metadata in the first response. Interactivity is
added as islands where it earns its place — the booking flow, the slot grid, the admin scheduler.

The word "SPA" in the brief described an app-like *feel*, not a rendering architecture. That feel is
achievable server-first; the reverse is not.

## Consequences

- The SEO agent has something to optimise. Its recommendations change the HTML a crawler receives,
  not a bundle a crawler may or may not run.
- Booking remains a client island, because a slot grid that round-trips to the server on every tap is
  worse than the WhatsApp flow it replaces.
- The admin is the same application under a route group rather than a separate app. Splitting it is a
  reversible decision, listed in docs/01 with its trigger: public Core Web Vitals degrading
  measurably, or admin needing an IP allowlist.
- Payload CMS v3 embeds in this app (see [ADR 0019](0019-cms-embedded-in-the-app.md)), which is only
  possible because there is one Next.js application rather than a decoupled front end.

## Rejected

**A client-rendered SPA with prerendering or dynamic rendering for bots.** Serving different HTML to
crawlers than to people is cloaking unless done exactly right, it needs a second rendering service,
and it fails silently — the failure mode is a page that ranks fine until it doesn't.
