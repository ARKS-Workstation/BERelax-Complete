import { describe, expect, it } from 'vitest'
import { pgDriverConnectionString } from './pg-driver-url.ts'

/**
 * The connection string pg-boss's driver is given, which is not the one the rest of the app uses.
 *
 * This function exists because of a failure only a real deployment produced: the worker died at boot with
 * `SELF_SIGNED_CERT_IN_CHAIN` against the very cluster the web app was serving pages from. `postgres` reads
 * `sslmode=require` as libpq defines it — encrypt, do not verify — and `pg`, under pg-boss, verifies the
 * chain anyway. The three cases below are the three states a deployment can be in, and the first is the one
 * that was broken.
 */
describe('pgDriverConnectionString', () => {
  const managed = 'postgresql://u:p@db.example.com:25060/berelax?sslmode=require'

  it('downgrades require to no-verify when no CA is available', () => {
    // What the connection string asked for, and no more. The queue must not hold a stricter policy than
    // the application it serves: that difference is what stopped the worker booting while the site was up.
    expect(pgDriverConnectionString(managed)).toContain('sslmode=no-verify')
    expect(pgDriverConnectionString(managed)).not.toContain('sslmode=require')
    expect(pgDriverConnectionString(managed, '')).toContain('sslmode=no-verify')
  })

  it('asks for verify-full against the CA file when the deployment supplies one', () => {
    const out = pgDriverConnectionString(managed, '/run/ca.pem')
    expect(out).toContain('sslmode=verify-full')
    expect(out).toContain('sslrootcert=%2Frun%2Fca.pem')
    expect(out).not.toContain('no-verify')
  })

  it('hands back a value it cannot parse, rather than throwing over it', () => {
    // `payload.config.ts` passes `process.env['DATABASE_URL'] ?? ''`, so an unset variable arrives as the
    // empty string. `new URL('')` throws, which turned a clear "DATABASE_URL is required" refusal into a
    // TypeError from a TLS helper. The callers downstream already say the useful thing.
    expect(pgDriverConnectionString('')).toBe('')
    expect(pgDriverConnectionString('not-a-url')).toBe('not-a-url')
    expect(pgDriverConnectionString('', '/run/ca.pem')).toBe('')
  })

  it('leaves a connection string that asked for no TLS exactly as it is', () => {
    // Local development and the integration suite. Forcing a mode here would attempt a handshake against
    // a cluster that has none, so the string comes back unchanged rather than normalised.
    const local = 'postgres://berelax:berelax@127.0.0.1:5432/berelax_test'
    expect(pgDriverConnectionString(local)).toBe(local)
    expect(pgDriverConnectionString(`${local}?sslmode=disable`)).toBe(`${local}?sslmode=disable`)
  })
})
