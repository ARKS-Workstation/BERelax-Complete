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
  'book-flow': { start: 9700, width: 300 },
  // C-AUTO-02 allocated this band at 9700, which `book-flow` already held on main: two units picked
  // the next round number after the last band each could see. Moved rather than renumbered because
  // `book-flow` is the one already in use, and 10000 is the next start with 300 clear ports below the
  // ephemeral floor and none a browser refuses.
  'template-editor': { start: 10_000, width: 300 },
  // B-UI-03's diary. The next free start above `template-editor`, and 10_300 rather than 10_080 because
  // 10080 is in Chromium's table: a band beginning there would contain a port the browser refuses, which
  // `RESTRICTED_PORTS` does not list precisely because it falls outside every band — including this one.
  'admin-calendar': { start: 10_300, width: 300 },
  // C-CRM-06's queue and preview. 10_900 rather than the next round number after 10_000: 10_300 and 10_600
  // are allocations held by units in flight in other worktrees, and a band chosen from what this worktree
  // can see is exactly how `template-editor` and `book-flow` came to share one.
  duplicates: { start: 10_900, width: 300 },
  // C-CRM-07's preference centre, which needs a real server for the one claim a pure render cannot make:
  // a document loaded with JavaScript DISABLED whose form then submits. 11_500 rather than the next round
  // number after `duplicates`: 11_200 is an allocation held by a unit in flight in another worktree, and a
  // band chosen from what one worktree can see is exactly how `template-editor` and `book-flow` came to
  // share one. [11_500, 11_800) contains none of RESTRICTED_PORTS.
  'preference-centre': { start: 11_500, width: 300 },
  // C-AUTO-08's pipeline board, which needs a real server for the claims a pure render cannot make: a
  // drag is a sequence of pointer events, a card returning to its origin column is a
  // `getBoundingClientRect`, and axe needs a rendered DOM. 12_100 rather than the next round number after
  // `preference-centre`: 11_800 is an allocation held by a unit in flight in another worktree, and a band
  // chosen from what one worktree can see is exactly how `template-editor` and `book-flow` came to share
  // one. [12_100, 12_400) contains none of RESTRICTED_PORTS.
  pipeline: { start: 12_100, width: 300 },
  // B-UI-04's quick-book screen, which needs a real server for the claims a pure render cannot make: the
  // 10-second walk-in measurement is a browser typing into a real form and waiting for a real POST, a
  // pointer-free run has to be a real keyboard driving real controls, and axe needs a rendered DOM. 11_800
  // is the band this unit was allocated. The comment on `pipeline` above says 11_800 was "held by a unit in
  // flight in another worktree", which was true when it was written: that unit is this one, and the
  // allocation has now landed. [11_800, 12_100) contains none of RESTRICTED_PORTS.
  'quick-book': { start: 11_800, width: 300 },
  // W-SYS-11's admin session, which needs a real server for the claims no pure render can make. All three
  // are about a RESPONSE rather than a return value: the `Set-Cookie` a successful POST emits and its exact
  // attributes, the 303 an unguarded request gets from every one of 25 routes, and the bytes a receptionist
  // receives being identical with `?role=owner` appended — which is the assertion that would catch a
  // re-introduction of the query parameter, and it can only be made against served bytes.
  //
  // 12_700 rather than the next round number after `pipeline` (12_100): 12_400 is an allocation held by a
  // unit in flight in another worktree, and a band chosen from what one worktree can see is exactly how
  // `template-editor` and `book-flow` came to share one. [12_700, 13_000) contains none of
  // RESTRICTED_PORTS.
  'admin-session': { start: 12_700, width: 300 },
  // W-SITE-10's publication control plane, which needs a real server for the claims a pure test cannot
  // make: the publish endpoint answers 403 to the SEO agent's credential over HTTP, and the synthetic
  // weight check fetches the rendered document from the application it is about to publish — so the bytes
  // it weighs are the bytes the route produces rather than a fixture's. 13_400 is the band this unit was
  // allocated; 12_400 through 13_300 are allocations held by units in flight in other worktrees, and a band
  // chosen from what one worktree can see is exactly how `template-editor` and `book-flow` came to share
  // one. [13_700, 14_000) contains none of RESTRICTED_PORTS — the highest entry in that table below the
  // ephemeral floor is 6697, and Chromium's own list has nothing between 10080 and the floor — so the
  // browser-unsafe exclusion this registry keeps costs this band nothing and `usableWidth` is the full 300.
  //
  // MOVED from 13_400, which overlapped `leave-approval` at [13_300, 13_600). Not two units picking
  // independently this time: the integrator issued 13_400 to W-SITE-10 and 13_300 to P-HR-09 a few minutes
  // apart, 100 apart, in a registry whose bands are 300 wide — so the overlap was allocated rather than
  // stumbled into. Two suites sharing a band is worse than a collision that fails to start, because the
  // second `next start` cannot bind and the suite answers from the FIRST one's server, at which point green
  // and red both mean nothing. 13_700 was M-VAT-08's allocation and it declined the band, having started no
  // server. Found independently by A-FIRST-01 and by `ports.test.ts`, which is the check that exists for it.
  publication: { start: 13_700, width: 300 },
  // P-HR-09's leave request screen, which needs a real server for the claims a pure render cannot make: the
  // `?role=` narrowing has to be refused by the running route rather than by a view object a test built, the
  // noindex header is the proxy's and not the document's, and axe needs a rendered DOM. 13_300 rather than
  // the next round number after `quick-book`: 12_400 through 13_000 are allocations held by units in flight
  // in other worktrees, and a band chosen from what one worktree can see is exactly how `template-editor` and
  // `book-flow` came to share one. [13_300, 13_600) contains none of RESTRICTED_PORTS, and none of the low
  // entries of Chromium's own table either — the nearest above every band is 10080.
  'leave-approval': { start: 13_300, width: 300 },
  // M-TILL-13's till, cash-up and package screens, which need a real server for the claims a pure render
  // cannot make: the twelve-interaction walk-in is a real keyboard driving real `<form>` POSTs, "genuinely
  // mirrored" is a `getBoundingClientRect` on the keypad and the total column in both directions, the
  // palette rule is read off the COMPUTED style of a rendered DOM rather than off a CSS string, and axe and
  // the screenshot matrix both need a rendered page. 12_400 is the band this unit was allocated; it is the
  // next start above `pipeline` [12_100, 12_400) and [12_400, 12_700) contains none of RESTRICTED_PORTS.
  till: { start: 12_400, width: 300 },
  // C-AUTO-05's promotional controls console, which needs a real server for the claims no pure render can
  // make. All three are about a RESPONSE rather than a return value: the 403 a marketer's POST gets and the
  // 200 a manager's gets are status codes, the audit row a successful POST leaves is written by a handler in
  // another process, and axe needs a rendered DOM. 14_600 is the band this unit was allocated; 13_700 through
  // 14_500 are allocations held by units in flight in other worktrees, and a band chosen from what one
  // worktree can see is exactly how `template-editor` and `book-flow` came to share one. [14_600, 14_900)
  // contains none of RESTRICTED_PORTS — the highest entry in that table below the ephemeral floor is 6697 —
  // so `usableWidth` is the full 300.
  'marketing-kill-switch': { start: 14_600, width: 300 },
  // P-HR-11's commission screen, which needs a real server for the one claim no pure render can make: the
  // bytes an OWNER receives and the bytes a THERAPIST receives differ in the derivation's scope, and that
  // difference is produced by the session — there is no `?employee=` to drive it with, because
  // `admin-guard.test.ts` refuses one across the whole of `apps/web`. A render test can be handed either
  // view; only a served response proves which view a cookie actually gets. 14_300 is the band this unit was
  // allocated, and it survived the merge: 13_700 is `publication`'s (moved there from an overlap) and
  // [14_000, 14_300) is unallocated, so nothing else reaches into this one. [14_300, 14_600) contains none of RESTRICTED_PORTS — the highest entry in that table below the
  // ephemeral floor is 6697 — so `usableWidth` is the full 300.
  commission: { start: 14_300, width: 300 },
  // G-REV-02's paste form, which needs a real server for the one claim a pure render cannot make: that the
  // form completes in a SINGLE POST. Counting requests is a property of a browser submitting a real form to a
  // real handler, and the 303 that follows it is what makes "one POST" different from "one request". 13_500
  // was the band this unit was allocated, and it did NOT survive the merge: [13_500, 13_800) reaches into
  // `leave-approval` at [13_300, 13_600), which is the third overlap this registry has caught and the second
  // the integrator issued rather than a unit picking for itself. MOVED to 14_900, the next start above
  // `marketing-kill-switch` [14_600, 14_900). Two suites sharing a band is worse than a collision that fails
  // to start, because the second `next start` cannot bind and the suite answers from the FIRST one's server.
  // [14_900, 15_200) contains none of RESTRICTED_PORTS.
  'reviews-paste': { start: 14_900, width: 300 },
  // W-SYS-14's private document route, which needs a real server for every claim it makes, because all of
  // them are about a RESPONSE rather than a return value: 403 for an unsigned request, 403 with a DIFFERENT
  // named reason for an expired one, 403 for a signature swapped onto another document's path, 403 for a
  // receptionist holding a valid link to a payslip, and the bytes plus their `content-disposition` for a
  // reader who passes all three gates. The acceptance line says so in as many words — "a test drives a real
  // served response rather than asserting on a function" — because a handler exercised as a function is a
  // handler whose status codes nobody has seen.
  //
  // 15_500 is the band this unit was allocated; 14_900 through 15_400 are allocations held by units in
  // flight in other worktrees, and a band chosen from what one worktree can see is exactly how
  // `template-editor` and `book-flow` came to share one. [15_500, 15_800) contains none of
  // RESTRICTED_PORTS — the highest entry in that table below the ephemeral floor is 6697, and Chromium's own
  // list has nothing between 10080 and the floor — so `usableWidth` is the full 300.
  documents: { start: 15_500, width: 300 },
  // Y-PAY-03's SAQ-A checkout, which needs a real browser for the one claim nothing else can make: that the
  // card field is inside a CROSS-ORIGIN iframe. "Cross-origin" is `frame.contentDocument === null` in a real
  // browser enforcing the same-origin policy, and no substring assertion over served HTML can say it — an
  // `<iframe src>` pointing at our own origin renders identical markup. The suite also reads the
  // content-security-policy off a served response and sweeps every sink for a Luhn-valid test PAN, which needs
  // the application's own writes rather than a handler called as a function.
  //
  // The stand-in gateway origin the frame points at is a second server this suite starts, and it draws its
  // port from the KERNEL (`listen(0)`) rather than from this band. That is deliberate and is not a hole in
  // rule 18: the rule exists because two suites sharing a band answer from each other's `next start`, and an
  // ephemeral port cannot collide with anything by construction. Drawing a second port from this band would
  // have been the arithmetic the rule forbids, or a second `startWebServer` for a server that is not the
  // application.
  //
  // 16_700 is the band this unit was allocated. 15_800 through 16_600 are allocations held by units in flight
  // in other worktrees, and a band chosen from what one worktree can see is exactly how `template-editor` and
  // `book-flow` came to share one. [16_700, 17_000) contains none of RESTRICTED_PORTS — the highest entry in
  // that table below the ephemeral floor is 6697, and Chromium's own list has nothing between 10080 and the
  // floor — so `usableWidth` is the full 300.
  checkout: { start: 16_700, width: 300 },
  // A-FIRST-05's `/api/collect`, which needs a real server for every claim it makes, because all of them
  // are about a RESPONSE rather than a return value: the `Set-Cookie` a first consented batch emits and
  // its exact attributes, the ABSENCE of one before consent, the 400 with a named reason for each of the
  // four caps, the 429 and its `Retry-After` under a burst, and the rendered public HTML a grep test reads
  // for third-party analytics origins — which can only be the bytes the application actually serves.
  //
  // 16_400 is the band this unit was allocated. It is the next start above `documents` [15_500, 15_800)
  // with 300 clear ports and does not reach into [15_800, 16_400), which is held by units in flight in
  // other worktrees; a band chosen from what one worktree can see is exactly how `template-editor` and
  // `book-flow` came to share one. [16_400, 16_700) contains none of RESTRICTED_PORTS — the highest entry
  // in that table below the ephemeral floor is 6697, and Chromium's own list has nothing between 10080 and
  // the floor — so `usableWidth` is the full 300.
  collect: { start: 16_400, width: 300 },
  // A-MEAS-02's consent banner and consent endpoint, which need a real server for the claims no pure test
  // can make, and one of them needs a real BROWSER:
  //
  //   * zero requests to any third-party tag host are made while loading the public pages, before any
  //     decision and after an explicit denial — which is a claim about the network a document generates
  //     and can only be made with request interception against the bytes the application serves;
  //   * the inline bootstrap sets `data-consent` on `<html>` before first paint, and the CSS hides the
  //     banner, which is a computed style in a browser rather than a string in a render;
  //   * the endpoint's `Set-Cookie` and its exact attributes, including the one attribute deliberately
  //     ABSENT (`HttpOnly`), and the 409 a tree whose banner copy has no published version receives.
  // 17_900 is the band this unit was allocated. It was A-MEAS-01's allocation first and that unit declined
  // it, having started no server — so it is reused rather than a new number, and nothing else holds it.
  // It does not reach into [16_700, 17_900), which is held by units in flight in other worktrees; a band
  // chosen from what one worktree can see is exactly how `template-editor` and `book-flow` came to share
  // one. [17_900, 18_200) contains none of RESTRICTED_PORTS — the highest entry in that table below the
  // ephemeral floor is 6697, and Chromium's own list has nothing between 10080 and the floor — so
  // `usableWidth` is the full 300, which matters here because this suite drives Chromium and a port it
  // refuses to CONNECT to is gate case 89b's whole subject.
  'analytics-consent': { start: 17_900, width: 300 },
  // A-FIRST-06's browser collector, which needs a real server and a real browser for every claim it makes,
  // because not one of them can be read off source. "Each declared interaction produces exactly one event"
  // is a count of `sendBeacon` calls against a running route; "a double click inside 300 ms produces one"
  // is two real `click` events a hundred milliseconds apart; "events queued while offline flush on the
  // next visibilitychange" needs a browser that can be taken offline and a `visibilitychange` the page
  // believes; and "the collector contacts no origin other than the site's own" is request interception
  // over everything the document fetched, which is a property of the BUILT bundle rather than of the
  // module graph.
  // 18_200 is the band this unit was allocated. 16_700 through 18_100 are allocations held by units in
  // flight in other worktrees, and a band chosen from what one worktree can see is exactly how
  // `template-editor` and `book-flow` came to share one. [18_200, 18_500) contains none of
  // RESTRICTED_PORTS — the highest entry in that table below the ephemeral floor is 6697, and Chromium's
  // own list has nothing between 10080 and the floor — so `usableWidth` is the full 300.
  collector: { start: 18_200, width: 300 },
  // G-REV-06's approval queue, which needs a real server and a real browser for four claims no pure render
  // can make. Two are about a RESPONSE rather than a return value: the 403 a receptionist's POST gets and
  // the 200 an owner's GET gets are status codes the F07 matrix produces through a session cookie, and
  // there is no `?role=` to drive it with (`admin-guard.test.ts` refuses one across the whole of
  // apps/web). The third is the CLIPBOARD: "Copy reply places the exact linted text on the clipboard
  // byte-for-byte" is a claim about `navigator.clipboard` in a browser with a user gesture, and nothing
  // short of one can make it. The fourth is axe plus the twelve-cell screenshot matrix, which need a
  // rendered DOM.
  // 18_800 is the band this unit was allocated. 17_000 through 18_700 are allocations held by units in
  // `template-editor` and `book-flow` came to share one. [18_800, 19_100) contains none of
  'reviews-queue': { start: 18_800, width: 300 },
  // C-AUTO-09's journey builder, which needs a real server for every claim it makes. Three of them can
  // only be made against the bytes the application serves: the template picker's `<option>` set for each
  // message class, the save control's `disabled` attribute on a graph the one verdict refuses, and the
  // enrolment figure printed beside it — counted in SQL per request, so a prerendered copy would print a
  // number from before. The fourth is the reload: save, open the page again, and the serialised graph is
  // byte-identical, which is a claim about two responses.
  // 19_100 is the band this unit was allocated. 16_800 through 19_000 are allocations held by units in
  // `template-editor` and `book-flow` came to share one. [19_100, 19_400) contains none of
  'flow-builder': { start: 19_100, width: 300 },
  // Y-PAY-04's webhook ingest, which needs a real server for every claim it makes. Three of them can only
  // be made against what the application ANSWERS: the three 401s for an absent, a malformed and a
  // wrong-key signature, the 200 a redelivery gets rather than a 409, and the 503 an absent signing
  // secret gets rather than a 401 — statuses a handler test can assert about a `Response` object it built
  // itself, which is exactly why they have to be asserted about one the route served. The fourth is the
  // body: the suite POSTs raw bytes and signs them, so a route that read `request.json()` and
  // re-serialised would fail every signature, and nothing short of a real request can show that.
  // 20_000 is the band this unit was allocated. [20_000, 20_300) is above every band above it and well
  // below EPHEMERAL_PORT_FLOOR.
  'payments-webhook': { start: 20_000, width: 300 },
  // H-MIG-10's walk-in stopwatch, which needs a real server because the claim is a wall-clock duration
  // through the BUILT application: a pure render cannot measure how long the desk waits, and the figure
  // the pilot is judged on is the one a browser produces against the bytes `next build` emitted.
  // 22_700 is the band this unit was allocated. 19_400 through 22_600 are allocations held by units in
  // other worktrees, and a band chosen from what one worktree can see is exactly how `template-editor`
  // and `book-flow` came to share one. [22_700, 23_000) contains none of RESTRICTED_PORTS and is below
  // EPHEMERAL_PORT_FLOOR.
  'walk-in-speed': { start: 22_700, width: 300 },
  // The public site's served bytes: W-SITE-06's therapist routes, W-SITE-08's sitemaps and publish loop,
  // and W-SITE-09's 301 map. ONE suite and one band rather than three, because three of these units were
  // allocated a single band between them and because `test-ports.test.ts` requires exactly one claimant
  // per band — a second `startWebServer({ suite: 'public-site' })` would be a second application on one
  // port, which is the failure rule 18 describes: the loser cannot bind, the winner answers both suites,
  // and neither green nor red means anything.
  //
  // Every claim it holds is about bytes and cannot be made any other way: a status code (200 for a
  // publishable therapist, 404 for the three that are not, one permanent hop for one who has left), the
  // XML a sitemap route serves, and the reciprocity between a page's `hreflang` set and the sitemap's.
  // 23_300 is the band these units were allocated. [23_300, 23_600) is above every band above it and well
  // below EPHEMERAL_PORT_FLOOR.
  'public-site': { start: 23_300, width: 300 },
  // A-MEAS-04's tag loader and web-vitals reporter, which need a real server for the three claims no pure
  // test can make: a REQUEST to a tag that must not happen before a grant and must happen after one in the
  // same page session, the `dataLayer` a real script would read, and a `PerformanceObserver`'s own figures
  // — which only exist in a browser that laid a page out.
  //
  // 23_600 and not the next round number after `walk-in-speed`: 23_000 and 23_300 are allocations held by
  // units in flight in other worktrees, and a band chosen from what one worktree can see is exactly how
  // `template-editor` and `book-flow` came to share one. [23_600, 23_900) contains none of
  // RESTRICTED_PORTS and is below the ephemeral floor.
  'tags-and-vitals': { start: 23_600, width: 300 },
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
/**
 * The port at `index` within a band, skipping the ports a browser refuses.
 *
 * Separated from {@link testPort} so the arithmetic can be tested against a pathological band without
 * inventing a suite to hold one. A test that reimplements this mapping to check it is testing its own copy,
 * which is worth nothing; a test that calls it is testing the thing that runs.
 *
 * `index` is expected in `[0, usableWidth(band))`. Outside that it is clamped rather than trusted, because
 * the failure a wrong index produces — a port outside the band — is the one outcome the registry exists to
 * prevent, and a gate case deliberately constructs a band with nothing usable in it.
 */
export function portAtIndex(band: TestPortBand, index: number): number {
  const blocked = restrictedPortsIn(band)
  const usable = band.width - blocked.length
  if (usable <= 0) return band.start
  let port = band.start + Math.min(Math.max(index, 0), usable - 1)
  // Ascending, so each skip can only push the answer past a port it has already accounted for.
  for (const restricted of blocked) if (port >= restricted) port += 1
  return port
}

export function testPort(suite: TestSuiteName): number {
  const band = TEST_PORT_BANDS[suite]
  const clashes = overlappingBands()
  if (clashes.length > 0) {
    throw new Error(`[test-port-bands-overlap] ${clashes.join('; ')}`)
  }
  return portAtIndex(band, Math.floor(Math.random() * usableWidth(band)))
}
