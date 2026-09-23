/**
 * The one way an integration suite starts the web application.
 *
 * Eleven suites each spawned `next start` themselves, and by the eleventh they had drifted apart in three
 * ways that all cost real runs:
 *
 *   1. **The temp directory.** Next writes its server-side module cache under `os.tmpdir()` and removes
 *      nothing. No suite removed it either. One `pnpm verify` left eleven directories of roughly 5.7 MB
 *      behind; a session of agents each running verify repeatedly left **10,539** of them — 25 GB, which
 *      presented as `ENOSPC` in whatever unrelated command ran next, and twice as a container that stopped.
 *      The cause is invisible from the symptom, which is why it survived so long.
 *   2. **The port.** {@link testPort} returns a random port inside the suite's band, and the band comment
 *      argues the birthday collision between two worktrees is "under a percent". That is true for one pair
 *      of runs and false for how this repository is actually built: several worktrees each running the whole
 *      suite means eleven simultaneous draws per run, and the collision arrives often enough to be mistaken
 *      for a flake. `EADDRINUSE` makes `next start` exit 1, and a suite that does not look at the child then
 *      reports a timeout, or worse answers from the *other* worktree's server.
 *   3. **The failure message.** Some suites included the server's captured output and checked that the
 *      process which answered was still alive; others threw `next start exited with 1` and discarded both.
 *      The second kind names the symptom and hides the cause: the word `EADDRINUSE` was in the output that
 *      was thrown away.
 *
 * One owner fixes all three, for the same reason {@link TEST_PORT_BANDS} has one owner: eleven copies of a
 * decision is eleven places for it to be made differently, and the drift does not announce itself.
 *
 * The port is still drawn from the suite's band — bands stay disjoint so a *deliberate* overlap is still
 * impossible — but it is now **acquired** rather than assumed: a candidate is bound and released before
 * `next start` is given it, and a candidate that is taken sends us round again. The band comment's claim
 * becomes true instead of approximate.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TestSuiteName, testPort } from './ports.ts'

/** A running application, and the two things a suite needs from it. */
export interface WebServer {
  /** The port it actually bound — drawn from the suite's band, then acquired. */
  readonly port: number
  /** `http://127.0.0.1:<port>`, with no trailing slash. */
  readonly origin: string
  /** Everything the child has written to stdout and stderr so far. For a failure message. */
  output(): string
  /**
   * Whether the child is still serving.
   *
   * For a teardown with work to do through the server — `content.itest.ts` republishes two ISR paths on its
   * way out — where a dead child means skip it rather than fail. Not for the ownership check a suite used to
   * make by hand: that one belongs to the start, and {@link startWebServer} makes it.
   */
  alive(): boolean
  /** SIGTERM, wait for exit, then remove the temp root. Safe to call twice. */
  stop(): Promise<void>
}

export interface WebServerOptions {
  /** The suite whose band the port comes from. A name with no band is a compile error. */
  readonly suite: TestSuiteName
  /** The application directory — `new URL('..', import.meta.url).pathname` from a suite in `src/`. */
  readonly cwd: string
  /**
   * The path polled until it answers. `/robots.txt` by default because every locale serves it and it
   * reads no row, so a slow database cannot be mistaken for a server that never started.
   */
  readonly probePath?: string
  /** How long the application may take to answer before this is a failure. */
  readonly readyWithinMs?: number
  /** Added to `process.env` for the child. `NODE_ENV: 'production'` is set for you. */
  readonly env?: Readonly<Record<string, string>>
  /** How many ports to try before giving up. Each attempt is a fresh draw from the band. */
  readonly portAttempts?: number
}

const DEFAULT_PROBE = '/robots.txt'
const DEFAULT_READY_WITHIN_MS = 90_000
const DEFAULT_PORT_ATTEMPTS = 6

/**
 * Whether a port can be bound right now, by binding it and letting go.
 *
 * This is a check and not a reservation: between the release and `next start`'s own bind, another process
 * can take it. That race is why {@link startWebServer} still retries on a child that exits with an
 * address-in-use — the probe removes the collisions that are already visible, and the retry covers the rest.
 * Binding `127.0.0.1` rather than `0.0.0.0` matches what `next start --port` does, so a port free on the
 * loopback but taken on another interface is not rejected for no reason.
 */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true))
    })
  })
}

/**
 * The text `next start` writes when the port is taken, in each of the three forms seen.
 *
 * Exported for its own test rather than kept private, because the whole retry rests on this pattern: a
 * form it does not match is a collision reported as a crash, which is the failure this module exists to
 * stop being mistaken for one.
 */
export const ADDRESS_IN_USE = /EADDRINUSE|address already in use|Port \d+ is in use/i

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The environment the child gets: the caller's, then the caller's additions, then the temp root.
 *
 * The order is the point and it is not the obvious one. Next caches its server modules under `os.tmpdir()`
 * and removes nothing, so the whole cleanup rests on the child resolving `os.tmpdir()` to a directory
 * {@link WebServer.stop} owns — and `os.tmpdir()` reads `TMPDIR` on Linux. Spreading the caller's `env`
 * LAST would let a suite set `TMPDIR` itself, at which point the cache lands somewhere `stop()` does not
 * remove and the leak is back with nothing to notice it. So the three temp variables go last and a caller
 * cannot override them; every other variable a suite passes wins over `process.env`, which is what a
 * caller actually wants the option for. `TMP` and `TEMP` are set beside `TMPDIR` so nothing in the tree
 * reaches round it on another platform.
 *
 * Exported for its own test, because "the child writes into a directory we delete" is the claim the whole
 * module exists to make and a spread in the wrong order would silently break it.
 */
export function childEnv(temp: string, extra: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  return { ...process.env, NODE_ENV: 'production', ...extra, TMPDIR: temp, TMP: temp, TEMP: temp }
}

/**
 * Start the application for one suite, and own its port, its temp directory and its teardown.
 *
 * Throws with the child's captured output on every failure path, because the output is where the reason is.
 */
export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
  const {
    suite,
    cwd,
    probePath = DEFAULT_PROBE,
    readyWithinMs = DEFAULT_READY_WITHIN_MS,
    env = {},
    portAttempts = DEFAULT_PORT_ATTEMPTS,
  } = options

  const attempted: number[] = []
  let lastOutput = ''

  /*
   * `portAttempts` counts ports we actually TRIED, not draws from the band.
   *
   * A `for` loop over attempts would spend one on a repeat draw, and with a 300-wide band a repeat is
   * ordinary — so the retry budget would quietly be smaller than the number it is named after. `draws`
   * bounds the loop instead, generously, so a band that is entirely occupied still terminates.
   */
  const maxDraws = portAttempts * 20
  for (let draws = 0; attempted.length < portAttempts && draws < maxDraws; draws += 1) {
    const port = testPort(suite)
    if (attempted.includes(port)) continue
    attempted.push(port)
    if (!(await portIsFree(port))) continue

    const temp = mkdtempSync(join(tmpdir(), `berelax-${suite}-`))
    const child = spawn('pnpm', ['exec', 'next', 'start', '--port', String(port)], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(temp, env),
    })
    let output = ''
    const collect = (chunk: Buffer): void => {
      output += chunk.toString()
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    const origin = `http://127.0.0.1:${port}`
    const server = await waitForServer({
      child,
      origin,
      probePath,
      readyWithinMs,
      temp,
      port,
      output: () => output,
    })
    if (server !== 'address-in-use') return server

    // The port went between the probe and the bind. Clean up and draw again.
    lastOutput = output
    await stopChild(child)
    rmSync(temp, { recursive: true, force: true })
  }

  throw new Error(
    `[${suite}] could not acquire a free port in ${portAttempts} attempts; tried ${attempted.join(', ')}. ` +
      `Every candidate was already bound, which on this repository usually means several worktrees are ` +
      `running the same suite at once. The last child's output was:\n${lastOutput}`,
  )
}

/**
 * Poll until the application answers, or say that the port was taken so the caller can draw again.
 *
 * A child that has exited is not a server that is slow to start, so this looks at the child on every pass:
 * waiting the full deadline on a process that is already gone turns a crash into a timeout nobody can read.
 */
async function waitForServer(input: {
  readonly child: ChildProcess
  readonly origin: string
  readonly probePath: string
  readonly readyWithinMs: number
  readonly temp: string
  readonly port: number
  readonly output: () => string
}): Promise<WebServer | 'address-in-use'> {
  const { child, origin, probePath, readyWithinMs, temp, port, output } = input
  const deadline = Date.now() + readyWithinMs
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (ADDRESS_IN_USE.test(output())) return 'address-in-use'
      rmSync(temp, { recursive: true, force: true })
      throw new Error(
        `next start exited with ${child.exitCode ?? child.signalCode} before answering on ${origin}. ` +
          `Its output follows, which is where the reason is:\n${output()}`,
      )
    }
    try {
      if ((await fetch(`${origin}${probePath}`)).ok) break
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) {
      rmSync(temp, { recursive: true, force: true })
      throw new Error(
        `the app did not answer on ${origin}${probePath} within ${readyWithinMs}ms:\n${output()}`,
      )
    }
    await sleep(250)
  }

  // The server that answered must be OURS. A reachable port plus a dead child is another worktree's
  // application answering for this one, and every assertion after this point would then be about a build
  // the file under test does not contain — which is the failure the port registry exists to prevent, seen
  // from the other end.
  if (child.exitCode !== null) {
    rmSync(temp, { recursive: true, force: true })
    throw new Error(
      `next start exited with ${child.exitCode} yet ${origin} answered, so the reply came from another ` +
        `process on this port. Its output follows:\n${output()}`,
    )
  }

  let stopped = false
  return {
    port,
    origin,
    output,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      await stopChild(child)
      // After the child is gone, not before: Next writes to this directory until it exits.
      rmSync(temp, { recursive: true, force: true })
    },
  }
}

/**
 * SIGTERM, then SIGKILL if it is still there. Resolves only once the process is gone.
 *
 * Waiting for the exit rather than for the signal is what makes the caller's `rmSync` safe: Next writes to
 * its temp root until it exits, so removing the directory while the child is still alive leaves it to
 * recreate part of what was just deleted.
 */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  const timedOut = Symbol('timed-out')
  const outcome = await Promise.race([exited, sleep(5_000).then(() => timedOut)])
  if (outcome !== timedOut) return
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  await exited
}
