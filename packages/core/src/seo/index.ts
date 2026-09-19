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
  and the three modules beside it (G-SEO-01) are the Search Console agent's arithmetic. Nothing crosses
  between them — the graph does not read a snapshot and the snapshot does not read the graph — so they are
  separate subjects under one heading, not layers.
*/

export * from './gsc-window.ts'
export * from './jsonld/index.ts'
export * from './rare-query-gap.ts'
export * from './url-inspection-cap.ts'
