/**
 * The CRM's pure half (C-CRM-01).
 *
 * `lifecycle.ts` is the six-state reducer, total over the whole (state x event) cross product;
 * `blocklist.ts` is what a contact key is, how a match is decided and who may change the list;
 * `client-record.ts` closes the record and classifies every field by the widest audience it may reach.
 *
 * C-CRM-02 adds `phone.ts` and `duplicate-score.ts` beside these.
 */
export * from './blocklist.ts'
export * from './client-record.ts'
export * from './lifecycle.ts'
