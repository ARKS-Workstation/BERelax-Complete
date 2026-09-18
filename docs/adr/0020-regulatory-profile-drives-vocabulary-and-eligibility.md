# ADR 0020 — one versioned regulatory profile, defaulting to the stricter reading

- **Status:** accepted
- **Date:** 2026-09-18
- **Unit:** H01
- **Covers:** docs/01 decisions 19, 20, 23, 26

## The problem: the licence classification is not yet known

Whether this business is regulated as wellness or as healthcare in Abu Dhabi decides several things at
once — what the copy may claim, how long clinical records are kept, what staff may be called, and what
credentials must be on file. The answer needs a lawyer, and the build cannot wait for it.

## Decision

**A single versioned `regulatory_profile` row** drives all of it: banned vocabulary, retention period,
permitted job titles, credential requirements. It is **append-only**, with exactly one row in force at
a time, enforced by a partial unique index rather than by convention.

It **defaults to the stricter of the two readings**: medical claims forbidden, healthcare-grade
retention, and the row flagged `is_provisional` so the Unconfirmed Assumptions panel shows it.

The default is the whole point. **The safe behaviour is what happens when nobody configures
anything.** A system that defaults permissive and waits for someone to tighten it spends the interval
non-compliant, and the interval is however long the lawyer takes.

## One lexicon, four consumers

The banned-claims list is owned by the profile and consumed by:

1. the CMS publication lint,
2. the service display-name lint,
3. the message-template lint,
4. the SEO agent's keyword filter.

Decomposition found it **required in three places and built by none** — the failure that would have
shipped is a word blocked in page copy and permitted in a service name. That is the version an
inspector notices, because it is the one printed on the menu.

## Gender matching is a hard constraint by default

Same-gender therapist matching is a **hard constraint in the availability solver**, default strict,
downgradable to advisory only as an audited configuration change and only once the licensing authority
confirms in writing.

Advisory-by-default fails in both directions: if the rule applies and the engine cannot express it, the
system generates bookings that staff cancel by hand every day; and one non-compliant appointment at an
inspection is a licence risk, not a customer-service problem.

## Therapist pages need a name and a consent

A therapist page publishes only with a **display name** and a **recorded photography consent**.

Nineteen therapists currently have photographs and no names. Publishing on photos alone yields
nineteen indexed, near-empty, near-duplicate pages, which is worse for search than having none — and
it publishes someone's face without a record that they agreed. Unnamed therapists render as unlinked
photo cards: visible on the site, absent from the index.

This connects to archival: when someone leaves, their page and their consent record have to be handled
together.

## Consequences

- A late answer from the lawyer is a **configuration change plus a data retention review**, not a
  rebuild.
- Every lint reads the profile at runtime, so tightening the lexicon takes effect without a deploy.
- The profile's history is the audit trail for "what were we operating under in March".
