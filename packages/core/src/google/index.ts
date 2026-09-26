/**
 * The Google connection's pure domain logic.
 *
 * The grant's state machine, the seven-day Testing tripwire, the staleness calculation and the one
 * derivation that turns a stored status into what a human is shown. No I/O, no clock — see docs/10 §4
 * and docs/07 §6.
 */
export * from './connection.ts'
export * from './connection-state.ts'
export * from './health.ts'
export * from './reauth.ts'
