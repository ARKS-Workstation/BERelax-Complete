/**
 * The CRM's pure half (C-CRM-01).
 *
 * `lifecycle.ts` is the six-state reducer, total over the whole (state x event) cross product;
 * `blocklist.ts` is what a contact key is, how a match is decided and who may change the list;
 * `client-record.ts` closes the record and classifies every field by the widest audience it may reach.
 *
 * `phone.ts` is the contact key C-CRM-02 added — B-LIFE-02's normaliser for every UAE number, plus the
 * one thing it deliberately refuses: a number whose country code is not 971. `duplicate-score.ts` is the
 * deterministic pair scorer that reads those keys and the folded record label, and the two thresholds
 * that act on its answer.
 */
export * from './blocklist.ts'
export * from './client-record.ts'
export * from './duplicate-score.ts'
export * from './lifecycle.ts'
export * from './phone.ts'
