import { describe, expect, it, vi } from 'vitest'
import {
  bandsReachingEphemeralRange,
  EPHEMERAL_PORT_FLOOR,
  overlappingBands,
  RESTRICTED_PORTS,
  restrictedPortsIn,
  TEST_PORT_BANDS,
  type TestSuiteName,
  testPort,
  usableWidth,
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

  /*
   * The restricted ports.
   *
   * A server bound to one of these starts perfectly and a browser then refuses to connect to it, so the
   * suite fails on every assertion with `Bad port: "6665" is reserved for ircu` and nothing that looks
   * like a port problem. Five bands contain one and `breakpoint-preview` contains eight, so before this
   * the suite lost roughly one run in thirty-eight to a cause invisible from the symptom.
   */

  /**
   * EXHAUSTIVE, not statistical, and that is the second lesson of this change.
   *
   * The first version drew 20,000 random ports from each of the fifteen bands — 300,000 draws, 3.1 s on
   * an idle machine and 7.9 s under coverage with five sibling verify runs, against vitest's 5,000 ms
   * default. So the case that exists to stop a flake was a flake, on exactly the hazard brief rule 21
   * describes, written by the same hand that wrote the rule.
   *
   * Stubbing `Math.random` to walk every index instead makes it deterministic AND a stronger claim:
   * `testPort` maps an index over the usable ports, so covering every index covers every port the
   * function can return. 300,000 random draws could still have missed one; 4,362 indices cannot. It also
   * proves reachability in the same pass, which is what the old 60,000-draw case was for.
   *
   * `(k + 0.5) / width` rather than `k / width` because `Math.floor((k / w) * w)` is `k - 1` for some
   * pairs in binary floating point, and a test that mis-states its own index would be worse than none.
   */
  it('maps every index in every band onto a usable port, and onto nothing else', () => {
    const forbidden = new Set(RESTRICTED_PORTS)
    for (const suite of Object.keys(TEST_PORT_BANDS) as readonly TestSuiteName[]) {
      const band = TEST_PORT_BANDS[suite]
      const width = usableWidth(band)
      const expected = new Set<number>()
      for (let port = band.start; port < band.start + band.width; port += 1) {
        if (!forbidden.has(port)) expected.add(port)
      }
      const drawn = new Set<number>()
      const random = vi.spyOn(Math, 'random')
      try {
        for (let index = 0; index < width; index += 1) {
          random.mockReturnValue((index + 0.5) / width)
          drawn.add(testPort(suite))
        }
      } finally {
        random.mockRestore()
      }
      /*
       * SOFT, so both facts are reported from one run.
       *
       * Drawing a restricted port and losing a usable one are different defects with different causes, and
       * a hard assertion on the first hides the second entirely. That is not a diagnostic nicety: gate case
       * 89c asserts this test fails *by naming* the unreachability, and with a hard assertion above it that
       * message was unreachable for every mutation that also made a restricted port drawable — so the gate
       * reported its rule as missing while the test was failing correctly.
       */
      const restricted = [...drawn].filter((port) => forbidden.has(port))
      expect
        .soft(restricted, `${suite} can draw ${restricted.join(', ')}, which a browser refuses`)
        .toEqual([])
      const unreachable = [...expected].filter((port) => !drawn.has(port))
      expect
        .soft(unreachable, `${suite} cannot reach ${unreachable.length} usable port(s)`)
        .toEqual([])
      expect(drawn.size, `${suite} drew ${drawn.size} distinct ports over ${width} indices`).toBe(
        width,
      )
    }
  })

  /**
   * And the real `Math.random` path, because everything above runs against a stub.
   *
   * A thousand draws per band is enough to catch a mapping that escapes the band or returns a restricted
   * port often, and it is two orders of magnitude cheaper than the version that timed out. The explicit
   * timeout is there because this one does depend on how busy the machine is.
   */
  it('stay inside the band and off the restricted ports with the real generator', () => {
    const forbidden = new Set(RESTRICTED_PORTS)
    for (const suite of Object.keys(TEST_PORT_BANDS) as readonly TestSuiteName[]) {
      const band = TEST_PORT_BANDS[suite]
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        const port = testPort(suite)
        expect(forbidden.has(port), `${suite} drew the restricted port ${port}`).toBe(false)
        expect(port, `${suite} drew ${port}`).toBeGreaterThanOrEqual(band.start)
        expect(port, `${suite} drew ${port}`).toBeLessThan(band.start + band.width)
      }
    }
  }, 30_000)

  /**
   * The control on the case above, and the reason it is worth 20,000 draws.
   *
   * Excluding ports a band does not contain proves nothing, so this asserts the exclusion is doing real
   * work: at least one band must contain a restricted port, and `breakpoint-preview` specifically, because
   * that is the band whose eight collisions were measured in the wild. If the bands are ever moved so that
   * none of them contains one, this fails and says to retire the exclusion rather than leaving 20,000
   * draws that could not fail.
   */
  it('are checked against bands that really do contain restricted ports', () => {
    const withRestricted = (Object.keys(TEST_PORT_BANDS) as readonly TestSuiteName[]).filter(
      (suite) => restrictedPortsIn(TEST_PORT_BANDS[suite]).length > 0,
    )
    expect(
      withRestricted.length,
      'no band contains a restricted port, so the exclusion test above cannot fail',
    ).toBeGreaterThan(0)
    expect(restrictedPortsIn(TEST_PORT_BANDS['breakpoint-preview'])).toEqual([
      6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697,
    ])
  })

  /**
   * Excluding ports must not leave a band too narrow to be random.
   *
   * The band comment's collision argument rests on the width, and the width that matters is the usable
   * one. A hundred is the floor the registry already claims; the worst band after exclusion is
   * `breakpoint-preview` at 292 of 300.
   */
  it('keep at least 100 usable ports in every band', () => {
    for (const suite of Object.keys(TEST_PORT_BANDS) as readonly TestSuiteName[]) {
      const band = TEST_PORT_BANDS[suite]
      expect(
        usableWidth(band),
        `${suite} has ${usableWidth(band)} usable ports of ${band.width}`,
      ).toBeGreaterThanOrEqual(100)
    }
  })
})
