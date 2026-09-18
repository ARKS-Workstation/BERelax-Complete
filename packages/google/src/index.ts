/**
 * @berelax/google — the owner's Google connection: its token store, its lifecycle and its KEK rotation.
 *
 * Why a package of its own rather than a folder in `db` or `providers`: the tokens here are the only
 * secret in the `public` schema that grants write access to something outside this system. Everything
 * that touches them is in one place so the chokepoint rule G-CONN-03 adds — *nothing outside
 * `with-google.ts` and `token-store.ts` may reference a token column* — has a boundary to be drawn
 * around. A rule that has to enumerate folders across three packages is a rule that will be forgotten.
 *
 * The pure arithmetic (staleness, the seven-day Testing tripwire, the state machine, the derivation of
 * what a human is shown) lives in `@berelax/core` and is tested without a clock or a database. This
 * package is the I/O around it.
 */
export type {
  ConnectionEventInput,
  GoogleCapabilityRecord,
  GoogleConnectionRecord,
  GoogleConnectionStore,
  RefreshWrite,
  StatusWrite,
} from './connection-store.ts'
export {
  type AccessTokenGrant,
  accessTokenFor,
  googleReauthRequired,
  grantFailureFromError,
  refreshAccessToken,
  type TokenLifecycleDeps,
} from './lifecycle.ts'
export {
  connectionRecord,
  createMemoryConnectionStore,
  type MemoryConnectionStore,
} from './memory-store.ts'
export { createPostgresConnectionStore, type NewConnection } from './postgres-store.ts'
export { type RewrapReport, rewrapRefreshTokens } from './rewrap.ts'
export {
  connectionBinding,
  GOOGLE_CONNECTIONS_TABLE,
  openToken,
  rewrapToken,
  type SealedToken,
  sealToken,
} from './token-store.ts'
