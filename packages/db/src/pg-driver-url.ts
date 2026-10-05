/**
 * The connection string the `pg`-family drivers need, which is not the one the rest of this build uses.
 *
 * ## The failure this exists for
 *
 * Two drivers reach the same PostgreSQL in this system and they disagree about TLS. `postgres`
 * (postgres.js) reads `sslmode=require` the way libpq defines it — encrypt, do not verify — while `pg`
 * reads it as "verify the chain", which against a managed cluster signed by its provider's own CA is
 * `SELF_SIGNED_CERT_IN_CHAIN`.
 *
 * So a connection string that asked for no verification got it from one driver and not the other, and the
 * two things that refused were the two that use `pg`: the worker, through pg-boss, which crash-looped at
 * boot; and the CMS admin, through `@payloadcms/db-postgres`, which answered 500 while the public site
 * beside it served pages happily off the same database. Both found on a real deployment and neither
 * reproducible locally, because a local cluster has no TLS at all.
 *
 * ## Why a URL rewrite rather than an `ssl` option
 *
 * Because one of the two callers cannot take an option: **pg-boss does not forward one.** The string "ssl"
 * does not appear anywhere in its distributed build, so passing it is accepted, ignored, and leaves code
 * that reads as though it fixed something. The connection string is the one channel both callers pass
 * through, and `pg-connection-string` understands `sslmode`, `sslrootcert` and libpq's `no-verify`.
 *
 * ## What it chooses
 *
 * With a CA file, the strong answer: `verify-full` against it, which is the "TLS verify-full" docs/02 §2
 * asks for. Without one, exactly what the connection string asked for and no more — a deliberate choice to
 * make the drivers agree rather than have the queue and the CMS hold a stricter policy than the
 * application they are part of. When no TLS was asked for at all, nothing is changed: forcing a mode would
 * attempt a handshake against a local cluster that has none.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function pgDriverConnectionString(connectionString: string, caPath?: string): string {
  /*
   * An unparseable value is handed back untouched, and that is not defensive padding — it was a real
   * crash. `payload.config.ts` passes `process.env['DATABASE_URL'] ?? ''`, so an unset variable arrives
   * here as the empty string and `new URL('')` throws `TypeError: Invalid URL`, which replaced a clear
   * refusal with a stack trace from a TLS helper. Nothing here can improve on the error the caller
   * already has: `createConnection` in `@berelax/db` says "DATABASE_URL is required to create a
   * connection", and `pg` says what it cannot parse. This function's job is TLS, so a string it cannot
   * read is one it has nothing to say about.
   */
  let url: URL
  try {
    url = new URL(connectionString)
  } catch {
    return connectionString
  }
  const mode = url.searchParams.get('sslmode')
  if (mode === null || mode === 'disable') return connectionString
  if (caPath !== undefined && caPath.length > 0) {
    url.searchParams.set('sslmode', 'verify-full')
    url.searchParams.set('sslrootcert', caPath)
    return url.toString()
  }
  url.searchParams.set('sslmode', 'no-verify')
  url.searchParams.delete('sslrootcert')
  return url.toString()
}

/**
 * Writes a CA certificate out and returns its path, or `undefined` when there is none to write.
 *
 * A file because `sslrootcert` names one, and that is the only channel available. Mode 0o644 and the OS
 * temp root are deliberate: a certificate authority's certificate is public by construction, so there is
 * nothing here to protect. It is left in place for the life of the process because the driver re-reads it
 * on every reconnect rather than once at startup.
 */
export function writeCaCertificateFile(pem: string | undefined): string | undefined {
  if (pem === undefined || pem.trim().length === 0) return undefined
  const path = join(mkdtempSync(join(tmpdir(), 'berelax-db-ca-')), 'ca.pem')
  writeFileSync(path, pem.endsWith('\n') ? pem : `${pem}\n`, { mode: 0o644 })
  return path
}
