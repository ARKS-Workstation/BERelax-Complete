# ADR 0112 — A lopsided sitemap is REFUSED rather than served, and a ping is never reported that was not sent

- **Status:** accepted
- **Date:** 2026-10-03
- **Unit:** W-SITE-08
- **Covers:** docs/01 decisions — none; this is the propagation-shaped consequence of
  [ADR 0007](0007-money-and-business-day-primitives.md) (the zone is always an argument),
  [ADR 0022](0022-provider-ports-and-fakes.md) (a port is shaped around the provider, and `real` refuses
  rather than degrading) and brief rule 15, applied to docs/09 §5's interconnection map

## Context

M4 is *Findable*, and its criterion is a loop rather than a feature: publishing a service in admin has to
produce, **within one job run**, the route live with correct JSON-LD, an updated sitemap `lastmod`, an
IndexNow ping containing exactly the changed URLs, a CDN purge for those paths, and an `audit_event` —
and *"four out of five is a failure"*.

Two of the five need no job at all, and saying so is half the design: the route is live and its JSON-LD
correct because the page is rendered from the rows, and the sitemap's `lastmod` is `updated_at` on those
same rows. A publish moves both by writing the row. The other three are what this unit builds, and each
of them raised a decision about what to do when the outside world does not cooperate.

## Decision 1 — a sitemap whose `hreflang` graph is lopsided is not served

Google's rule for an alternate set is that **every page in it lists every page in it, including itself**,
and a set that fails is not partially honoured: it is **ignored entirely**, for every page in the group.
The symptom is the Arabic page ranking for English queries, six weeks later, with nothing to point at.

So `sitemapXml` **throws** rather than serving a document `reciprocityFindings` has findings about. The
alternative — serve it and report the findings somewhere — is wrong in exactly one direction: serving it
loses the language signal for the whole group, while a 500 on `/sitemaps/treatments` is noticed the same
day. The four rules are named (`alternate_set_is_not_self_referential`,
`alternate_set_is_not_reciprocal`, `alternate_names_an_absent_url`, `duplicate_location`), and the third
is the one that matters operationally: it fires when the set was built correctly and the OTHER document
stopped being published — an archived treatment, a withdrawn photography consent — so it is the rule that
goes wrong after the code was right.

The sitemap's set and the page's `<head>` come from **one function**, `alternatesFor`. The cross-check in
`public-site.itest.ts` is still asserted over served bytes, because a registry entry and a rendered
document are two different programs.

## Decision 2 — an empty section is left OUT of the index, never served as an empty `<urlset>`

An empty `<urlset>` is a positive statement — *there are no pages of this kind* — and a crawler acts on it
by dropping the ones it knows about. Two of the four sections are legitimately empty today: nobody is
publishable (ADR 0020) and no journal post has its two bylines. So those paths **404**, the index does not
list them, and the day a therapist is published both change together with nothing to remember.

## Decision 3 — the IndexNow key is a SETTING with a marker default, and the fake refuses it in its constructor

An IndexNow key is published by the site that uses it, at `https://<host>/<key>.txt`. It is a credential
in the sense that it authorises a submission and **not** in the sense that it must be concealed, so it is
a setting rather than an environment secret — one in the encrypted table would be masked on display and
therefore impossible to publish.

Its default is the marker `INDEXNOW-KEY-PENDING-Y1-INDEXNOW-KEY`, and the consequence is sharper than the
usual brief-rule-15 case: **a wrong key does not fail.** IndexNow answers 403 and the pipeline would go on
reporting pings that reach nobody for as long as nobody checks Bing. So `createFakeIndexNow` throws from
its **constructor** when handed a marker — the one moment the refusal can be made before a submission
exists — and the propagation job records `refused_no_key` with the open question in the message.

**A rejected ping does not fail the publish.** A ping is a notification and a purge is an optimisation; a
publish is a decision somebody made. Rolling one back because Bing was unreachable is a worse failure, and
one an operator cannot act on. It is not silent either: the rejection appears in `publish_propagation`, in
`agent_heartbeat.last_error` where docs/09 §5's console reads it, and in the audit row's `after` state.

## Decision 4 — the idempotency key is a hash of the URL SET, and the uniqueness is the database's

*"A retried publish yields one ping per changed URL set"* is a statement about a **set**: publishing the
same service twice must not ping twice, and publishing a second service must ping again even though one
URL is shared. So the key is a hash of the sorted, deduplicated set — sorting is what makes it independent
of the order the job happened to collect the paths in, and without it a retry whose paths came back
reordered is a second ping that looks legitimate.

The enforcement is `publish_propagation_once_per_set`, unique on `(surface, idempotency_key)`, and that is
deliberate: the fakes hold their outboxes in memory, which a process restart ends, so an idempotency claim
resting on them is a claim about one process. Per **surface** as well as per key, because the same URL set
can legitimately be republished by two different kinds of change — archiving a therapist and editing the
CMS page that linked them both touch `/therapists` — and collapsing those would lose one of them.

## Decision 5 — revalidate BEFORE pinging, and declare the cache tags rather than deriving them

The order is the reverse of the obvious one. A crawler arriving in the second between the ping and the
revalidation is served the cached page the ping said had changed, which teaches it that this site's pings
are noise — and IndexNow's documented remedy for a site that does that is to stop honouring them.

The URLs are **derived** (from the same `revalidationPathsFor` the revalidate endpoints use, so the set
pinged is the set revalidated) and the cache tags are **declared** (from `INTERCONNECTION_MAP`). The
asymmetry is the criterion's: *"each row purges exactly its declared cache tags and no others"*, and a
derived set cannot be held to a declaration. Over-purging is the failure nobody reports — every test still
passes, the cache empties on a change that touched one page, and nothing says so — which is why the
comparison is of SETS and why the map is a table with docs/09's own sentence beside each row.
