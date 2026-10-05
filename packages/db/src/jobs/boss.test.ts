import { describe, expect, it } from 'vitest'
import { jobQueueSsl } from './boss.ts'

/**
 * The TLS settings pg-boss's driver gets, which are not the ones postgres.js gets.
 *
 * This function exists because of a failure that only a real deployment produced: the worker died at boot
 * with `SELF_SIGNED_CERT_IN_CHAIN` against the very cluster the web app was serving pages from. `postgres`
 * reads `sslmode=require` as libpq defines it — encrypt, do not verify — and `pg`, under pg-boss, verifies
 * the chain anyway. So the three cases below are the three states a deployment can actually be in, and the
 * first one is the one that was broken.
 */
describe('jobQueueSsl', () => {
  const managed = 'postgresql://u:p@db.example.com:25060/berelax?sslmode=require'

  it('asks for no verification when TLS is required and no CA was supplied', () => {
    // What the connection string asked for, and no more. The queue must not hold a stricter policy than
    // the application it serves: that difference is what stopped the worker booting while the site was up.
    expect(jobQueueSsl(managed)).toEqual({ rejectUnauthorized: false })
    expect(jobQueueSsl(managed, '')).toEqual({ rejectUnauthorized: false })
  })

  it('verifies against the CA when the deployment supplies one', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nnot-a-real-certificate\n-----END CERTIFICATE-----'
    expect(jobQueueSsl(managed, ca)).toEqual({ ca, rejectUnauthorized: true })
  })

  it('configures no TLS at all when none was asked for', () => {
    // Local development and the integration suite. `rejectUnauthorized: false` is NOT the right answer
    // here: it still attempts TLS, and a cluster that has none refuses the handshake.
    expect(jobQueueSsl('postgres://berelax:berelax@127.0.0.1:5432/berelax_test')).toBeUndefined()
    expect(
      jobQueueSsl('postgres://berelax:berelax@127.0.0.1:5432/t?sslmode=disable'),
    ).toBeUndefined()
  })
})
