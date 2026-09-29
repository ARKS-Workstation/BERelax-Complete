/**
 * Every `service` row a suite creates and may leave behind, by treatment-key prefix, stated ONCE.
 *
 * ## Why this exists
 *
 * `catalogue.itest.ts` asserts that the catalogue holds exactly the eight services the seed writes. It did
 * that over the WHOLE `service` table, excluding only its own probe — so the claim it actually made was
 * "no other suite has a service row", which is not what it is about and is not true. Two suites create
 * one: `till.itest.ts` removes its probe in `afterAll`, and `month-reconciliation.itest.ts` deliberately
 * cannot (its own header says why: the service is pinned by `package_template_line` and `package_balance`
 * against package rows that refuse DELETE). So the count read 9, then 10, and the failure named a treatment
 * key the file had never heard of.
 *
 * The seeded catalogue is not identifiable from the `service` table alone — no column says "the seed wrote
 * this" — so the discriminator has to be the other side: the rows a FIXTURE wrote. Listing them here, once,
 * is what makes the count exact rather than a pattern match on the word "probe", and what makes the next
 * probe a one-line diff in a file about probes rather than a failure in a file about the catalogue.
 *
 * ## What it does NOT weaken
 *
 * The orphan check in the same file stays whole-table and must: a probe service with no
 * `service_room_type_compat` row is one `seedCatalogue`'s publication lint refuses outright, which is how
 * one leftover row failed six unrelated suites. A probe is allowed to exist; it is not allowed to be
 * malformed.
 */
export const FIXTURE_PROBE_TREATMENT_KEY_PREFIXES: readonly string[] = Object.freeze([
  // `catalogue.itest.ts`'s own, which used to be the only one this rule knew about.
  'bcat03_probe',
  // `till.itest.ts` — removed in its `afterAll`. Listed because a run that dies before the teardown leaves
  // it, and because the teardown threw exactly once and cost eighteen unrelated files their run.
  'mtill13_till_probe',
  // `till-receipt.itest.ts` — the same shape, one screen along.
  'mtill13_receipt_probe',
  // `month-reconciliation.itest.ts` — PERMANENT, and the key carries a per-run nonce, so a prefix and not
  // an exact key. Its compatibility row is what keeps it publishable.
  'mvat12_recon_probe',
])

/** True when `treatmentKey` belongs to a declared fixture probe rather than to the seeded catalogue. */
export function isFixtureProbeTreatmentKey(treatmentKey: string): boolean {
  return FIXTURE_PROBE_TREATMENT_KEY_PREFIXES.some((prefix) => treatmentKey.startsWith(prefix))
}
