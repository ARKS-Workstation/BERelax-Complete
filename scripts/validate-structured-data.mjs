#!/usr/bin/env node
/**
 * The structured-data gate: invalid JSON-LD fails the build rather than warning.
 *
 * ADR 0003 in one sentence: a check nobody has seen fail is not a check. Google's Rich Results Test is a
 * network service and reports *warnings* for most of what matters here, so a gate built on it would be
 * skipped offline and ignored when it spoke. This runs the repository's own validator — `validateGraph` in
 * `@berelax/core` — and exits non-zero on any finding.
 *
 * ## Two modes, and why the second exists
 *
 * With **no arguments** it builds the specimen graphs through the real builders and validates them. That is
 * the repository check: it proves `buildStructuredDataGraph` emits a graph that passes every rule, for a
 * business with every node type populated *and* for one shaped like the seeded data — no coordinate, no
 * reviews, no published therapist, an offering with no price.
 *
 * With **file arguments** it validates the JSON in each file, which is what makes the gate provable:
 * `scripts/test-gates.mjs` writes a `Service` with no offers and a `DaySpa` with no address, points this
 * script at them, and asserts it exits non-zero naming `service_without_offers` and
 * `business_missing_required_property`. A gate that can only be handed a graph it built itself can only pass.
 *
 * ## Why this does not read the database
 *
 * Because it runs where every other gate in `pnpm verify` runs, which in CI is before the migrations
 * (`.github/workflows/ci.yml` applies them after the build, for the integration suite). A gate that needed a
 * seeded database would be a gate that got skipped — the argument `pnpm deps` and `pnpm licences` make about
 * the network, applied to PostgreSQL.
 *
 * The **real** graph is validated where a real graph exists: `apps/web/src/seo/structured-data.itest.ts`
 * fetches every registry document from a running server, parses each `<script type="application/ld+json">`
 * out of the served HTML and runs this same `validateGraph` over it. Two callers, one implementation.
 *
 * The specimen lives in `@berelax/core` rather than here, because the unit tests build the identical graphs
 * and two copies of a thirty-field payload is one copy that drifts — and the one that drifts is the one the
 * gate uses. See `packages/core/src/seo/jsonld/specimen.ts` on why none of its values is this business's.
 */
import { readFileSync } from 'node:fs'
import {
  buildStructuredDataGraph,
  formatFindings,
  graphOpenAt,
  specimenGraphs,
  validateGraph,
} from '@berelax/core'

let failures = 0
const fail = (label, detail) => {
  failures += 1
  console.error(`FAIL  ${label}`)
  if (detail) console.error(detail.replace(/^/gm, '      '))
}
const pass = (label) => {
  console.log(`PASS  ${label}`)
}

function validateFile(path) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    fail(`${path} is not readable JSON`, String(err))
    return
  }
  // A supplied file may wrap the graph as `{ licenceClass, graph }` to say which class it was built under. A
  // bare graph is judged against `unconfirmed`, the seeded class — the strict answer, and the right default
  // for a fixture whose author did not say.
  const licence = typeof parsed.licenceClass === 'string' ? parsed.licenceClass : 'unconfirmed'
  const graph = parsed.graph ?? parsed
  const findings = validateGraph(graph, { licence })
  if (findings.length > 0) {
    fail(`${path} is not a valid graph`, formatFindings(findings))
    return
  }
  pass(`${path} is a valid graph`)
}

/**
 * The hours claim, read back off the emitted graph.
 *
 * docs/13 §2 calls the midnight crossing "the single most consequential operational fact", and this is the
 * published end of it: a consumer evaluating `opens <= t <= closes` over the emitted specifications has to
 * conclude the premises is open inside the window and closed outside it. The specimen trades 12:00–03:00, so
 * 01:30 on any day is inside it and 04:00 is not — and a single specification reading
 * `opens: 12:00, closes: 03:00` would make **both** answers false, which is the defect this asserts away.
 */
function checkEmittedHours(graph) {
  const expectations = [
    [1, '01:30', true, 'inside the after-midnight half of the session'],
    [1, '12:00', true, 'the opening minute'],
    [1, '23:59', true, 'the last minute before midnight'],
    [1, '04:00', false, 'after the close'],
    [1, '11:00', false, 'before the open'],
  ]
  let wrong = 0
  for (const [day, time, expected, why] of expectations) {
    const actual = graphOpenAt(graph, day, time)
    if (actual !== expected) {
      wrong += 1
      fail(
        `the emitted opening hours read ${time} as ${actual === true ? 'open' : 'closed'}`,
        `${time} should read as ${expected ? 'open' : 'closed'}: ${why}`,
      )
    }
  }
  if (wrong === 0) pass('the emitted opening hours read 01:30 as open and 04:00 as closed')
}

function checkSpecimens() {
  const graphs = specimenGraphs()
  let lastSeeded
  for (const specimen of graphs) {
    let graph
    try {
      graph = buildStructuredDataGraph(specimen.input)
    } catch (err) {
      fail(`${specimen.label} could not be built`, String(err))
      continue
    }
    lastSeeded = graph
    const findings = validateGraph(graph, {
      licence: specimen.licence,
      requireTypes: specimen.requireTypes,
    })
    if (findings.length > 0) {
      fail(specimen.label, formatFindings(findings))
      continue
    }
    pass(specimen.label)
  }
  if (lastSeeded !== undefined) checkEmittedHours(lastSeeded)
}

const files = process.argv.slice(2)
if (files.length === 0) checkSpecimens()
else for (const file of files) validateFile(file)

if (failures > 0) {
  console.error(
    `\n${failures} structured-data failure(s). Invalid JSON-LD fails the build: a graph published wrong is ` +
      'quoted wrong, and a rating or a coordinate nothing stands behind is a manual action rather than a ' +
      'missing rich result.',
  )
  process.exit(1)
}
console.log('\nStructured data is valid.')
