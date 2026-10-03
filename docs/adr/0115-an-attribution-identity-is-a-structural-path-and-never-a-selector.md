# ADR 0115 — a web-vitals attribution identity is a structural path and never a selector

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** A-MEAS-04
- **Covers:** docs/01 decisions — none. This is a mechanism under ADR 0018 (first-party measurement),
  beside ADR 0059 (the opaque category code and the whole-payload argument), ADR 0066 (the visitor row is
  created at consent) and ADR 0076 (one consent gate). It is the same rule as ADR 0059's, applied to the
  one field in this build that a browser fills in from the page's own DOM.

## Context

Web-vitals attribution answers "what was slow" with an element: the LCP element, the sources of the
largest layout shift, the target of the slowest interaction. Every library that does this identifies the
element with a **CSS selector** — `#price-table`, `main > .deep-tissue-card:nth-child(3)`, and where
nothing else is available, a fragment of the element's own text.

That is the right answer for a tool that sends the selector back to the developer who wrote the page. It
is the wrong answer here, and the reason is the one docs/03 §6 already states about the raw event store:
a name in the raw payload is the thing that later gets copied into an outbound push. An id is chosen by
whoever wrote the component and is very often the service — `#deep-tissue-60` is a plausible id for a real
card on a real page. A class is the same. Text is worse: it is the page's content, and on a treatment page
the content is a service name and a price.

The weaker versions of this rule were both considered and both fail in a way nobody would notice:

- **A length cap.** `identity.slice(0, 120)` keeps `#deep-tissue-60` intact; it is fifteen characters.
- **A deny list** — strip anything matching the service slugs. It is a list that has to be maintained
  against the catalogue, it cannot cover a class somebody invents next month, and the failure is silent.

## Decision

**An attribution identity is built from three things and the schema admits nothing else:** lowercase tag
names, `:nth-of-type(N)` positions, and at most one trailing `[data-track=<event>]` naming an event the
taxonomy already holds. `WEB_VITALS_IDENTITY_PATTERN` in `packages/shared/src/analytics/taxonomy.ts` is
that rule as a regular expression, and it is part of the `web_vitals` payload schema — so the refusal
happens at `/api/collect`, for every client, and not in the browser that happens to be running this
build's own code.

The browser half is shaped so that it *cannot* produce a forbidden identity rather than so that it does
not. `structuralIdentity` in `packages/ui/src/analytics/web-vitals.ts` takes an `IdentifiableElement` —
an interface with four fields: the tag name, the parent, the sibling tag names with an index, and the
`data-track` value. There is no `id`, no `className` and no `textContent` on it. A future edit that
wanted to put a class in the identity would have to widen that interface first, which is a diff somebody
reviews.

An identity that would be refused is **dropped rather than truncated**: the metric still travels, without
an attribution. Truncating would produce a string the server refuses, and a refused envelope costs the
figure as well as the identity.

## Consequences

**An identity is less useful than a selector, and that is the price.** `section:nth-of-type(2)>h2` says
where the element is and not what it is called, so finding it means opening the page rather than reading
the row. `data-track` is the escape hatch and it is deliberately narrow: an element a unit WANTS to be
identifiable declares a taxonomy event on itself, which is the attribute A-FIRST-06's collector already
reads, and then the identity names it.

**An identity is not stable across a redesign.** A wrapper added above the element changes the path, so a
figure compared across a layout change is comparing two identities for one element. That is the correct
behaviour for a position — the element did move — and it is why the figure that is compared over time is
the metric and not the identity.

**The pattern admits a digit and a hyphen in a tag name, and it must.** `h1` to `h6` carry a digit and a
heading is the commonest LCP element on a text page; the first version of the pattern was `[a-z]+`, it
refused every heading, and the symptom was a metric with no attribution rather than an error. A custom
element's name is structural for the same reason a tag name is: it is chosen by whoever wrote the
component, never by the page's content.

**This does not make the raw store safe by itself.** It makes one field safe. The envelope's other fields
are A-FIRST-01's and A-FIRST-04's, and the outbound half — what may leave the building at all — is
A-MEAS-01's egress guard and the opaque category code, which this record does not weaken or replace.
