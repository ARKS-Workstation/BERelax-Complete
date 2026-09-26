#!/usr/bin/env node
/**
 * `next build`, with a temp root it owns.
 *
 * ## Why this file exists
 *
 * `next build` writes an 11 MB server-module cache into a RANDOMLY NAMED directory under `os.tmpdir()`
 * and removes nothing — one `<random>/ssr` per build, for ever. `packages/harness/src/server.ts` already
 * solved exactly this for `next start`, by pointing the child's `TMPDIR` at a directory it deletes, and
 * that fix was assumed to cover the build too. It does not: the harness only wraps the SERVER.
 *
 * Measured rather than argued. A single `pnpm --filter @berelax/web build` in an otherwise quiet tree
 * added exactly one such directory; this session's builds had accumulated 380 of them, 2.4 GB, on a
 * container whose writable allowance is a few gigabytes. The failure mode is not a slow leak, it is
 * `ENOSPC` in the middle of somebody's integration run, reported as whatever happened to be writing at
 * the time.
 *
 * ## Why a temp root rather than a path inside `.next`
 *
 * `next build` clears stale files out of `.next` as it starts, so a cache directory in there would be a
 * directory Next might delete underneath its own writes. `mkdtempSync` under the OS temp root is the
 * harness's proven shape: unique per invocation, so two worktrees building at once cannot collide, and
 * named `berelax-web-build-` so an orphan left by a `kill -9` is attributable rather than anonymous.
 *
 * `TMP` and `TEMP` are set beside `TMPDIR` for the reason `childEnv` gives: so nothing in the tree
 * reaches round it.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const temp = mkdtempSync(join(tmpdir(), 'berelax-web-build-'))

/** Removed on every path out, including a signal: an early exit is exactly when the leak used to happen. */
const clean = () => {
  rmSync(temp, { recursive: true, force: true })
}

const child = spawn('pnpm', ['exec', 'next', 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp },
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal)
  })
}

child.on('error', (error) => {
  clean()
  console.error(`next build could not be started: ${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  clean()
  // A child killed by a signal has no exit code, and exiting 0 there would report a build that did not
  // finish as a build that succeeded.
  process.exit(signal === null ? (code ?? 1) : 1)
})
