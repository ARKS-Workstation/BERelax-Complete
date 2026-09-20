import { describe, expect, it } from 'vitest'
import {
  bandsReachingEphemeralRange,
  EPHEMERAL_PORT_FLOOR,
  overlappingBands,
  TEST_PORT_BANDS,
  type TestSuiteName,
  testPort,
} from './ports.ts'

/**
 * The registry's own guarantees.
 *
 * These are cheap and they are the entire point of the file: a band table nobody checks is exactly the
 * comment-based scheme it replaced. `overlappingBands` returning empty is the assertion that matters — when
 * it does not, two suites share a port range, and the symptom in CI is a suite reporting on another
 * worktree's build rather than a failure anyone would recognise as a port problem.
 */
describe('test port bands', () => {
  it('never overlap', () => {
    expect(overlappingBands()).toEqual([])
  })

  it('stay below the ephemeral range the kernel allocates from', () => {
    expect(bandsReachingEphemeralRange()).toEqual([])
  })

  it('leave room above the privileged ports', () => {
    for (const [suite, band] of Object.entries(TEST_PORT_BANDS)) {
      expect(band.start, `${suite} starts at ${band.start}`).toBeGreaterThan(1024)
    }
  })

  /**
   * 100 is the floor at which two worktrees picking the same suite's port collide under 1% of the time.
   * Narrower is a flake budget nobody agreed to.
   */
  it('are wide enough that two worktrees rarely collide', () => {
    for (const [suite, band] of Object.entries(TEST_PORT_BANDS)) {
      expect(band.width, `${suite} is ${band.width} wide`).toBeGreaterThanOrEqual(100)
    }
  })

  it('hand out ports inside the band of the suite that asked, only', () => {
    for (const suite of Object.keys(TEST_PORT_BANDS) as readonly TestSuiteName[]) {
      const band = TEST_PORT_BANDS[suite]
      for (let draw = 0; draw < 500; draw += 1) {
        const port = testPort(suite)
        expect(port, `${suite} drew ${port}`).toBeGreaterThanOrEqual(band.start)
        expect(port, `${suite} drew ${port}`).toBeLessThan(band.start + band.width)
        expect(port).toBeLessThan(EPHEMERAL_PORT_FLOOR)
      }
    }
  })

  /**
   * A draw that never varies is a fixed port wearing the registry's clothes, which is the failure mode the
   * whole file exists to prevent. 500 draws from a band of at least 100 returning one value is not chance.
   */
  it('vary the port between calls', () => {
    for (const suite of Object.keys(TEST_PORT_BANDS) as readonly TestSuiteName[]) {
      const drawn = new Set(Array.from({ length: 500 }, () => testPort(suite)))
      expect(drawn.size, `${suite} drew ${drawn.size} distinct ports in 500 calls`).toBeGreaterThan(
        1,
      )
    }
  })
})
