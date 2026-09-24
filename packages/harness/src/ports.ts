/**
 * Every server-starting integration suite's port band, in one place.
 *
 * Each suite used to pick its own band and record the neighbours in a comment. That is correct exactly as
 * long as every one of those comments is updated whenever a band is added, and they were not: three pairs
 * of suites overlapped by the time there were eleven of them — `kitchen-sink` and `breakpoint-preview` both
 * on 4400, `primitives` and `messages-inbox` both on 3800, and `hero-lcp` at 5800+300 running into `content`
 * at 5900+300.
 *
 * An overlap is worse than a flake. The second `next start` cannot bind the port, exits, and the suite's own
 * wait-for-server loop then **succeeds against the other suite's server** — so the assertions run against a
 * different build of the application and report on code the file under test does not contain. Green means
 * nothing and red means nothing.
 *
 * So the bands live here, {@link overlappingBands} proves they are disjoint, and a gate proves no suite
 * computes a port of its own. A new server-starting suite adds a row rather than a comment; the compiler
 * rejects {@link testPort} for a name that has no row.
 */

/** A half-open port range: `[start, start + width)`. */
export interface TestPortBand {
  readonly start: number
  readonly width: number
}

/**
 * The bands, by suite.
 *
 * Widths are 300 — enough that the birthday collision between two worktrees running the same suite is under
 * a percent — except `shell`, which was already 600 and has no reason to shrink. Everything sits well below
 * the Linux ephemeral floor of 32768, so the kernel cannot hand one of these to an unrelated socket first.
 */
export const TEST_PORT_BANDS = {
  shell: { start: 3200, width: 600 },
  primitives: { start: 3800, width: 300 },
  'route-spine': { start: 4100, width: 300 },
  'kitchen-sink': { start: 4400, width: 300 },
  motion: { start: 4700, width: 300 },
  'structured-data': { start: 5100, width: 300 },
  treatments: { start: 5500, width: 300 },
  'hero-lcp': { start: 5800, width: 300 },
  content: { start: 6100, width: 300 },
  'breakpoint-preview': { start: 6400, width: 300 },
  'messages-inbox': { start: 6700, width: 300 },
  book: { start: 7000, width: 300 },
  home: { start: 8500, width: 300 },
  compliance: { start: 9400, width: 300 },
} as const satisfies Record<string, TestPortBand>

/** The suites that own a band. */
export type TestSuiteName = keyof typeof TEST_PORT_BANDS

/** The ephemeral range Linux allocates from by default; a band that reaches it is not ours to hold. */
export const EPHEMERAL_PORT_FLOOR = 32_768

/**
 * The pairs of suites whose bands intersect, named, in a form a failure message can print verbatim.
 *
 * Empty is the only acceptable answer. Returned rather than thrown so that both the unit test and the gate
 * can report every overlap at once instead of the first.
 */
export function overlappingBands(): readonly string[] {
  const rows = Object.entries(TEST_PORT_BANDS).sort(([, a], [, b]) => a.start - b.start)
  const clashes: string[] = []
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]
    const current = rows[index]
    if (previous === undefined || current === undefined) continue
    const [earlierName, earlier] = previous
    const [laterName, later] = current
    const earlierEnd = earlier.start + earlier.width
    if (earlierEnd > later.start) {
      clashes.push(
        `${earlierName} [${earlier.start}, ${earlierEnd}) overlaps ${laterName} [${later.start}, ${later.start + later.width})`,
      )
    }
  }
  return clashes
}

/** The bands that run into the kernel's ephemeral range, where a port is not ours to reserve. */
export function bandsReachingEphemeralRange(): readonly string[] {
  return Object.entries(TEST_PORT_BANDS)
    .filter(([, band]) => band.start + band.width > EPHEMERAL_PORT_FLOOR)
    .map(
      ([name, band]) =>
        `${name} ends at ${band.start + band.width}, at or above ${EPHEMERAL_PORT_FLOOR}`,
    )
}

/**
 * The ports a browser refuses to connect to, so a server bound to one cannot be reached.
 *
 * Chromium keeps a table of ports reserved for protocols it will not speak to over HTTP
 * (`kRestrictedPorts` in `net/base/port_util.cc`) and answers `ERR_UNSAFE_PORT` for them; the message
 * that surfaces names the service, `Bad port: "6665" is reserved for ircu`. The server starts perfectly
 * — nothing is in use, nothing crashes — and every Playwright assertion in the suite then fails on a
 * navigation the browser declined.
 *
 * Five of the fourteen bands contain one. `breakpoint-preview` [6400, 6700) contains EIGHT — 6566 and
 * 6665-6669 and 6679 and 6697 — so roughly one run of that suite in thirty-eight drew a port its own
 * assertions could not use, with no `EADDRINUSE` for {@link startWebServer} to redraw on. It read as a
 * flaky suite for the same reason the random-port collision did: the cause is invisible from the symptom.
 *
 * Only the entries that can fall inside a band are listed; the table's low ports (1-995) and 10080 are
 * below and above every band and listing them would invite the belief that this is the whole table.
 */
export const RESTRICTED_PORTS: readonly number[] = [
  3659, // apple-sasl
  4045, // lockd
  4190, // sieve
  5060, // sip
  5061, // sips
  6000, // X11
  6566, // sane-port
  6665, // ircu
  6666, // ircu
  6667, // ircu
  6668, // ircu
  6669, // ircu
  6679, // osaut
  6697, // ircs
] as const

/** The restricted ports inside one band, ascending. Empty for a band that has none. */
export function restrictedPortsIn(band: TestPortBand): readonly number[] {
  const end = band.start + band.width
  return RESTRICTED_PORTS.filter((port) => port >= band.start && port < end)
}

/** How many ports in a band a suite can actually be reached on. */
export function usableWidth(band: TestPortBand): number {
  return band.width - restrictedPortsIn(band).length
}

/**
 * A port inside the suite's own band, never one a browser refuses.
 *
 * Random within the band, because several worktrees usually run at once and a fixed port means the second
 * one reads the first one's build. Random *within a band this file owns*, because a band the suite picked
 * for itself is how the overlaps above happened.
 *
 * The restricted ports are skipped by mapping an index over the USABLE ports rather than by drawing and
 * redrawing: a draw-and-retry loop has no bound, and a rejection this function cannot see the reason for
 * is what {@link RESTRICTED_PORTS} exists to stop. Every usable port stays equally likely.
 */
export function testPort(suite: TestSuiteName): number {
  const band = TEST_PORT_BANDS[suite]
  const clashes = overlappingBands()
  if (clashes.length > 0) {
    throw new Error(`[test-port-bands-overlap] ${clashes.join('; ')}`)
  }
  const blocked = restrictedPortsIn(band)
  let port = band.start + Math.floor(Math.random() * (band.width - blocked.length))
  // Ascending, so each skip can only push the answer past a port it has already accounted for.
  for (const restricted of blocked) if (port >= restricted) port += 1
  return port
}
