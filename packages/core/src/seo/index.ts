/**
 * The SEO agent's pure domain logic.
 *
 * The Search Console window (the 2–3 day lag, and why these dates are calendar UTC rather than trading
 * days), the rare-query gap and the sentence that explains it, and the URL Inspection cap arithmetic. No
 * I/O, no clock — the instant is always an argument. See docs/09 §4 and docs/10 §7.
 */
/*
  Two unrelated bodies of SEO logic share this directory, and this barrel is where that is stated rather
  than left for a reader to infer: `jsonld/` (W-SITE-03) builds the structured-data graph the site serves,
  and the modules beside it (G-SEO-01, G-SEO-03) are the Search Console agent's arithmetic. Nothing crosses
  between them — the graph does not read a snapshot and the snapshot does not read the graph — so they are
  separate subjects under one heading, not layers.

  G-SEO-03's three query-side analyses — `ctr-outliers.ts`, `content-gaps.ts` and `cannibalisation.ts` —
  sit beside G-SEO-01's arithmetic because they are the other half of one subject: G-SEO-01 mirrors the
  Search Console query report into `seo_gsc_daily` and these read it back. They share `query-rows.ts`,
  which holds the row shape and the two derivations (the aggregate and the basis-point CTR) all three need,
  and `content-gaps.ts` reads the rare-query gap because a query Google withheld cannot be a content gap —
  it is a query nothing here can see.

  `analyses.worked-examples.fixture.ts` is deliberately NOT exported. It is the reviewed hand-computed
  expectation the tests beside it assert against, and exporting it from the package barrel would invite a
  caller to read its figures as measurements.

  G-SEO-04 adds the other half of the deterministic pipeline, and it is the half that reads the LIVE SITE
  rather than a Search Console mirror: `coverage-anomaly.ts` judges a series with a statistical threshold
  rather than a delta (the cry-wolf problem, which is the whole reason it is not six lines of subtraction),
  `internal-link-audit.ts` reconciles the fetched sitemap against the crawled link graph, and
  `structured-data-validate.ts` extracts the JSON-LD a page actually serves and hands it to `jsonld/
  validate.ts` — the SAME rule set the CI gate uses, reused whole rather than restated, plus the three
  rules that are properties of a page rather than of a graph. Two of the three take their fetched bytes
  inside G-SEO-02's untrusted envelope, which `.dependency-cruiser.cjs`'s
  `seo-site-analysis-must-take-the-untrusted-envelope` is what keeps true.

  `structured-data.fixtures/` is deliberately NOT exported, for `analyses.worked-examples.fixture.ts`'
  reason: the three known-bad pages are derived from the specimen graph with one declared mutation each,
  and a caller reaching them through the package barrel would be a caller treating a deliberately broken
  document as a specimen.

  `link-graph.ts` (W-SITE-07) is a third subject under the same heading: the hub-and-spoke invariant over
  the internal links of the built site. It crosses to neither of the others — it judges a graph a crawler
  describes, and knows nothing about JSON-LD or about Search Console — and it is here rather than in
  apps/web for the reason the jsonld builders are: the rules have to be provable on a fixture whose answer
  is known, and a rule that can only run against a live server is a rule whose failure nobody has seen.
*/

export * from './candidate-screen.ts'
export * from './cannibalisation.ts'
export * from './content-gaps.ts'
export * from './coverage-anomaly.ts'
export * from './ctr-outliers.ts'
export * from './gsc-window.ts'
export * from './internal-link-audit.ts'
export * from './jsonld/index.ts'
export * from './link-graph.ts'
export * from './query-rows.ts'
export * from './rare-query-gap.ts'
export * from './structured-data-validate.ts'
export * from './target-allowlist.ts'
export * from './untrusted-envelope.ts'
export * from './url-inspection-cap.ts'
