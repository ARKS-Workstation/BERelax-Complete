import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { ADDRESS_IN_USE, childEnv, portIsFree, UNUSABLE_PORT } from './server.ts'

/**
 * The two pieces of {@link startWebServer} that decide whether a port collision is retried or reported as a
 * crash. Everything else in that module needs a real `next start`, and the eleven integration suites are
 * that test; these two are the parts whose being wrong would make the retry silently do nothing.
 */

const held: Server[] = []

afterEach(async () => {
  await Promise.all(
    held.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
})

/** Bind a port and keep it, so `portIsFree` has something real to be wrong about. */
function hold(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      held.push(server)
      resolve()
    })
  })
}

/** A port the kernel just handed us and we released: free, and outside every declared band. */
function freeEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('the probe did not report a numeric address'))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

describe('portIsFree', () => {
  it('says false for a port something is holding', async () => {
    const port = await freeEphemeralPort()
    await hold(port)
    expect(await portIsFree(port)).toBe(false)
  })

  it('says true for a port nothing is holding, which is the control', async () => {
    // Without this the first assertion is satisfied by a function that always answers false, and a
    // `startWebServer` that could never acquire any port at all would pass its own guard.
    const port = await freeEphemeralPort()
    expect(await portIsFree(port)).toBe(true)
  })

  it('releases the port it probed, so the caller can still bind it', async () => {
    // The probe binds to find out. If it did not close, the check would poison every port it approved and
    // `next start` would then fail on exactly the ports this module had just declared usable.
    const port = await freeEphemeralPort()
    expect(await portIsFree(port)).toBe(true)
    await expect(hold(port)).resolves.toBeUndefined()
  })
})

describe('the address-in-use pattern', () => {
  // Verbatim shapes, because a pattern that matches a paraphrase and not the real line retries nothing.
  const inUse = [
    'Error: listen EADDRINUSE: address already in use 127.0.0.1:6668',
    '⨯ Failed to start server\nError: listen EADDRINUSE: address already in use :::4712',
    '  ⚠ Port 4712 is in use, trying 4713 instead.',
    'node:events:496\n      throw er; // Unhandled "error" event\n      Error: listen EADDRINUSE',
  ]
  for (const line of inUse) {
    it(`matches ${JSON.stringify(line.slice(0, 44))}`, () => {
      expect(ADDRESS_IN_USE.test(line)).toBe(true)
    })
  }

  const other = [
    "Error: Cannot find module 'next/dist/server'",
    "TypeError: Cannot read properties of undefined (reading 'origin')",
    'AppError: Invalid configuration — 1 problem(s):\n  APP_ENV: Invalid option',
    '  ▲ Next.js 16.3.5\n  - Local:  http://127.0.0.1:6668\n ✓ Ready in 812ms',
  ]
  for (const line of other) {
    it(`does not match ${JSON.stringify(line.slice(0, 44))}`, () => {
      // The controls, and the last one matters most: a ready server prints its own address, and a pattern
      // loose enough to read that as a collision would retry a server that had already started.
      expect(ADDRESS_IN_USE.test(line)).toBe(false)
    })
  }

  it('is not a global regex, because a global one carries lastIndex between calls', () => {
    // The same defect `ports.test.ts` records: `.test()` on a `/g` pattern answers true, false, true for
    // identical input, so half the checks in a loop would silently pass.
    expect(ADDRESS_IN_USE.global).toBe(false)
  })
})

/*
 * The second reason to redraw: a port that cannot be used at all, rather than one that is taken.
 *
 * `testPort` no longer draws Chromium's restricted ports, which is the fix. This pattern is the fallback
 * for a port Chromium adds to that table later — without it such a port is a crash with no retry, and the
 * suite fails on every assertion with a message about ircu.
 */
describe('the unusable-port pattern', () => {
  const unusable = [
    'Bad port: "6665" is reserved for ircu',
    'net::ERR_UNSAFE_PORT at http://127.0.0.1:6566/robots.txt',
    'Error: Port 6000 is reserved for X11 and cannot be used',
  ]
  for (const line of unusable) {
    it(`matches ${JSON.stringify(line.slice(0, 44))}`, () => {
      expect(UNUSABLE_PORT.test(line)).toBe(true)
    })
  }

  const other = [
    'Error: listen EADDRINUSE: address already in use 127.0.0.1:6668',
    "Error: Cannot find module 'next/dist/server'",
    '  ▲ Next.js 16.3.5\n  - Local:  http://127.0.0.1:6668\n ✓ Ready in 812ms',
    'AppError: Invalid configuration — 1 problem(s):\n  APP_ENV: Invalid option',
  ]
  for (const line of other) {
    it(`does not match ${JSON.stringify(line.slice(0, 44))}`, () => {
      // The first control is the one that matters: an address-in-use line must NOT be read as an unusable
      // port. Both lead to a redraw today, so a pattern that swallowed the other would look harmless — and
      // the day the two are handled differently it would be wrong with no test to say so.
      expect(UNUSABLE_PORT.test(line)).toBe(false)
    })
  }

  it('is not a global regex, for the reason above', () => {
    expect(UNUSABLE_PORT.global).toBe(false)
  })
})

describe('the environment the child is given', () => {
  const TEMP = '/tmp/berelax-content-XYZ'

  it('points every temp variable at the directory stop() removes', () => {
    const env = childEnv(TEMP, {})
    expect(env['TMPDIR']).toBe(TEMP)
    expect(env['TMP']).toBe(TEMP)
    expect(env['TEMP']).toBe(TEMP)
  })

  it('serves production, because `next start` is not a dev server', () => {
    expect(childEnv(TEMP, {})['NODE_ENV']).toBe('production')
  })

  it("passes a suite's own variables through, which is what the option is for", () => {
    const env = childEnv(TEMP, { APP_ENV: 'test', DATABASE_URL: 'postgres://x/y' })
    expect(env['APP_ENV']).toBe('test')
    expect(env['DATABASE_URL']).toBe('postgres://x/y')
  })

  it('refuses to let a caller redirect the temp root, which is the whole cleanup', () => {
    // The ordering assertion, and the reason the spread is not the obvious way round. A suite that set
    // TMPDIR itself would send Next's cache somewhere `stop()` does not delete, and the leak would be back
    // with nothing to notice it — 10,539 directories is what that looked like the first time.
    const env = childEnv(TEMP, { TMPDIR: '/tmp/somewhere-else', TMP: '/tmp/x', TEMP: '/tmp/y' })
    expect(env['TMPDIR']).toBe(TEMP)
    expect(env['TMP']).toBe(TEMP)
    expect(env['TEMP']).toBe(TEMP)
  })

  it('lets a suite override NODE_ENV, so the refusal above is about the temp root and not about order', () => {
    // The control. Without it the assertion above is satisfied by a builder that ignores `extra` entirely.
    expect(childEnv(TEMP, { NODE_ENV: 'test' })['NODE_ENV']).toBe('test')
  })
})
