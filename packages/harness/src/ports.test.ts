import { describe, expect, it } from 'vitest'
import {
  bandsReachingEphemeralRange,
  EPHEMERAL_PORT_FLOOR,
  overlappingBands,
  RESERVED_PORTS,
  reservedPortsIn,
  TEST_PORT_BANDS,
  type TestSuiteName,
  testPort,
  usablePortsIn,
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
   * The ports a browser refuses to open, which no probe and no retry can rescue.
   *
   * `next start --port 4045` exits with `Bad port: "4045" is reserved for npp` before it binds anything, so
   * a suite whose band contains one dies on the draw. Three bands do, and the numbers here are what make
   * the filter non-vacuous: an empty reserved list would satisfy the assertion below for ever.
   */
  it('never draw a port a browser refuses to open', () => {
    // The filter has something to remove: `primitives` really does contain 4045, which is the draw that
    // failed C-AUTO-02's verify, and `breakpoint-preview` contains seven of them.
    expect(reservedPortsIn(TEST_PORT_BANDS.primitives)).toEqual([4045])
    expect(reservedPortsIn(TEST_PORT_BANDS['breakpoint-preview'])).toEqual([
      6566, 6665, 6666, 6667, 6668, 6669, 6697,
    ])
    expect(reservedPortsIn(TEST_PORT_BANDS.shell)).toEqual([3659])
    // And no band is drawn from that could return one. 4,000 draws over a 300-wide band holding one
    // reserved port would hit it about thirteen times unfiltered.
    for (const suite of Object.keys(TEST_PORT_BANDS) as readonly TestSuiteName[]) {
      const reserved = new Set(reservedPortsIn(TEST_PORT_BANDS[suite]))
      if (reserved.size === 0) continue
      for (let draw = 0; draw < 4000; draw += 1) {
        const port = testPort(suite)
        expect(reserved.has(port), `${suite} drew the reserved port ${port}`).toBe(false)
      }
    }
  })

  it('still offer every other port in the band, so the filter removes only the reserved ones', () => {
    // The control on the filter: it must not quietly narrow a band. The usable count is the width minus
    // exactly the reserved members, and the endpoints are still reachable.
    for (const suite of Object.keys(TEST_PORT_BANDS) as readonly TestSuiteName[]) {
      const band = TEST_PORT_BANDS[suite]
      const usable = usablePortsIn(band)
      expect(usable.length, suite).toBe(band.width - reservedPortsIn(band).length)
      expect(usable.includes(band.start) || reservedPortsIn(band).includes(band.start), suite).toBe(
        true,
      )
    }
    // Every listed port is a real one, and the list is sorted so a reviewer can find a number in it.
    for (const port of RESERVED_PORTS) expect(port).toBeGreaterThan(1024)
    expect([...RESERVED_PORTS]).toEqual([...RESERVED_PORTS].sort((a, b) => a - b))
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
