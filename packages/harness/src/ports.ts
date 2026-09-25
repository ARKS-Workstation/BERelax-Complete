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
  'template-editor': { start: 9700, width: 300 },
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
 * The ports a browser refuses to open, and `next start` therefore refuses to bind.
 *
 * Not an availability question and not a collision: `next start --port 4045` exits immediately with
 * `Bad port: "4045" is reserved for npp`, because Chrome's unsafe-port list blocks it — a page served
 * there could never be opened, so Next declines to serve one. The failure arrives as a dead child and
 * reads exactly like the port bug this module exists to prevent, while being a POLICY that no retry and no
 * free-port probe can do anything about.
 *
 * Three bands contain one today, which is why this is a filter rather than a comment: `primitives`
 * [3800, 4100) holds 4045 — one draw in three hundred, and C-AUTO-02's verify drew it — `shell` holds
 * 3659, and `breakpoint-preview` [6400, 6700) holds seven of them, which is a suite that dies on better
 * than one run in fifty.
 *
 * Listed rather than computed, and only the members that could fall inside a band, so the set is
 * reviewable: 3659 (apple-sasl), 4045 (npp/lockd), 5060 and 5061 (SIP), 6000 (X11), 6566 (sane-port),
 * 6665-6669 and 6697 (IRC). Chrome's list is longer; everything else on it is below 3200, where no band
 * starts, or above 10000, where none reaches — and {@link reservedPortsIn} is what keeps that reviewable
 * when a band moves.
 */
export const RESERVED_PORTS: readonly number[] = [
  3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697,
]

const RESERVED = new Set(RESERVED_PORTS)

/** The reserved ports inside one band, in order. Empty for a band nothing blocks. */
export function reservedPortsIn(band: TestPortBand): readonly number[] {
  return RESERVED_PORTS.filter((port) => port >= band.start && port < band.start + band.width).sort(
    (left, right) => left - right,
  )
}

/** Every port in a band that a browser will actually open, which is what a draw may return. */
export function usablePortsIn(band: TestPortBand): readonly number[] {
  const ports: number[] = []
  for (let port = band.start; port < band.start + band.width; port += 1) {
    if (!RESERVED.has(port)) ports.push(port)
  }
  return ports
}

/**
 * A port inside the suite's own band.
 *
 * Random within the band, because several worktrees usually run at once and a fixed port means the second
 * one reads the first one's build. Random *within a band this file owns*, because a band the suite picked
 * for itself is how the overlaps above happened. And random within the ports a browser will **open**,
 * because the alternative is a suite that dies on a draw rather than on anything it did — see
 * {@link RESERVED_PORTS}.
 *
 * Drawn from the usable list rather than redrawn until acceptable: the distribution stays uniform, and a
 * loop that retried a random draw could in principle not terminate, which is a worse failure than the one
 * being fixed.
 */
export function testPort(suite: TestSuiteName): number {
  const band = TEST_PORT_BANDS[suite]
  const clashes = overlappingBands()
  if (clashes.length > 0) {
    throw new Error(`[test-port-bands-overlap] ${clashes.join('; ')}`)
  }
  const usable = usablePortsIn(band)
  // `band.start` when there is nothing to draw from — a band of width zero, or one narrow enough to be
  // entirely reserved. Both are registry defects, and both are reported BY NAME by `ports.test.ts`: a band
  // must be at least 100 wide, and a draw must vary between calls. Falling back rather than throwing is
  // what keeps those two failures the ones a reader sees; a throw from the drawer would replace them with a
  // stack trace out of a helper, and it would replace the width-zero case gate 61d watches — "a fixed port
  // wearing the registry's clothes" — with an exception that says nothing about bands.
  return usable[Math.floor(Math.random() * usable.length)] ?? band.start
}
