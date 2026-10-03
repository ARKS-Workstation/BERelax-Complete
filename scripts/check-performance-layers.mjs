#!/usr/bin/env node
/**
 * The three independent performance enforcement layers, held to being three and to being enforced
 * (W-SITE-11).
 *
 * docs/08 §8 names three layers — field, CI and publish — and says "any of the three failing is a red
 * build, not a ticket". Before this unit the CI layer did not exist at all: `build/budgets.json`'s own
 * note says so in the collector's entry, *"Lighthouse CI does not exist in this repository and is
 * W-SITE-11's to add"*. So this gate has two halves.
 *
 * ## The static half, which runs in `pnpm verify`
 *
 * It needs no browser and no build, which is the whole reason it is separate: a budget is decoration if
 * nothing holds it to covering what it claims, and that claim can be checked on every commit for the
 * cost of two file reads. It judges `lighthouse/budget.json` and `lighthouserc.cjs` against each other
 * and against `apps/web/src/routes/registry.ts`, and reports every budget that is declared and NOT
 * enforced rather than letting one sit unenforced quietly.
 *
 * ## The measured half, which runs in CI after a real Lighthouse collection
 *
 * `--reports <dir>` reads the Lighthouse reports LHCI wrote and enforces every budget, exiting non-zero
 * **naming the metric and the measured value**. It is the authoritative enforcement, and not
 * Lighthouse's own: a Lighthouse budget breach is a warning inside the report rather than a non-zero
 * exit, three of the nine declared budgets cannot be expressed as a Lighthouse budget at all, and two
 * of them differ by form factor, which a Lighthouse budgets file cannot say.
 *
 * It also refuses a report that is not evidence: a target with no report at all, and a target whose
 * own document answered anything but 200. A Lighthouse run against a 404 produces a perfect score, and
 * a CI job that passed on one would be the purest form of this gate not being one (ADR 0003).
 *
 * ## Usage
 *
 *     node scripts/check-performance-layers.mjs                       # the static half
 *     node scripts/check-performance-layers.mjs --reports .lighthouseci
 *     node scripts/check-performance-layers.mjs --emit-native <path>  # the Lighthouse budgets file
 *     node scripts/check-performance-layers.mjs --declaration <path>  # for the known-bad fixtures
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const DECLARATION_PATH = flag('declaration', 'lighthouse/budget.json')
const RC_PATH = flag('rc', 'lighthouserc.cjs')
const REGISTRY_PATH = 'apps/web/src/routes/registry.ts'
const MANIFEST_PATH = 'build/manifest.yaml'
const REPORTS_DIR = flag('reports', null)
const EMIT_NATIVE = flag('emit-native', null)

/** The four route shapes W-SITE-11's acceptance line names. Spelled here because it is the SPEC. */
const REQUIRED_SHAPE_IDS = ['home', 'treatment', 'therapist', 'gallery']

/** Every rule this gate can report, asserted BY NAME (ADR 0003). */
const RULES = [
  'budget-covers-every-required-route-shape',
  'budget-shape-is-served-or-blocked-on-a-live-unit',
  'budget-figure-has-a-stated-basis',
  'budget-covers-both-themes-and-both-directions',
  'budget-locale-prefix-matches-the-i18n-module',
  'lighthouserc-holds-no-figure-of-its-own',
  'lighthouserc-derives-every-enforceable-budget',
  'every-layer-names-its-enforcement-or-the-unit-that-owns-it',
  'a-new-public-document-is-covered-by-axe-and-a-baseline',
  'report-exists-for-every-collected-target',
  'report-is-of-a-document-that-answered-200',
  'measured-value-is-within-its-budget',
]

const violations = []
const record = (rule, detail) => violations.push({ rule, detail })

const read = (path) => readFileSync(path, 'utf8')

function declaration() {
  try {
    return JSON.parse(read(DECLARATION_PATH))
  } catch (error) {
    console.error(`${DECLARATION_PATH} is not readable JSON: ${String(error)}`)
    process.exit(1)
  }
}

// --- the static half ------------------------------------------------------------------------------

/** Every `path:` the route registry declares. A text scan, because the registry is a TS module. */
function registryPaths() {
  const text = read(REGISTRY_PATH)
  return [...text.matchAll(/^\s*path: '([^']+)',$/gm)].map((match) => match[1])
}

/** Every document route the registry declares, which is what a baseline can photograph. */
function registryDocuments() {
  const text = read(REGISTRY_PATH)
  return [...text.matchAll(/^\s*path: '([^']+)',\n\s*kind: 'document',/gm)].map((match) => match[1])
}

/** The units the manifest records as `done`, so a `blockedOn` marker can be held to being live. */
function doneUnits() {
  const text = read(MANIFEST_PATH)
  const done = new Set()
  let id = null
  for (const line of text.split('\n')) {
    const match = /^\s*- id: ([A-Z0-9-]+)$/.exec(line)
    if (match !== null) id = match[1]
    if (id !== null && /^\s*status: done$/.test(line)) {
      done.add(id)
      id = null
    }
  }
  return done
}

function checkShapes(spec, served, done) {
  const declared = spec.routeShapes.map((shape) => shape.id)
  const missing = REQUIRED_SHAPE_IDS.filter((id) => !declared.includes(id))
  if (missing.length > 0) {
    record(
      'budget-covers-every-required-route-shape',
      `the budget declares [${declared.join(', ')}] and the acceptance line names ` +
        `[${REQUIRED_SHAPE_IDS.join(', ')}]; missing [${missing.join(', ')}]. A budget over three of ` +
        'the four shapes is a budget the fourth page grows past without anything failing',
    )
  }
  for (const shape of spec.routeShapes) {
    const isServed = served.includes(shape.registryPath)
    if (isServed && shape.blockedOn !== undefined) {
      record(
        'budget-shape-is-served-or-blocked-on-a-live-unit',
        `${shape.id} carries blockedOn=${shape.blockedOn} and ${shape.registryPath} IS in the route ` +
          'registry. The marker is what keeps an unbuilt route out of the collection; left on a route ' +
          'that exists it keeps the page permanently unmeasured',
      )
      continue
    }
    if (isServed) continue
    if (shape.blockedOn === undefined) {
      record(
        'budget-shape-is-served-or-blocked-on-a-live-unit',
        `${shape.id} budgets ${shape.registryPath}, which the route registry does not serve, and ` +
          'carries no blockedOn. A Lighthouse run against it would score a 404 page, which is a pass ' +
          'over nothing',
      )
      continue
    }
    if (done.has(shape.blockedOn)) {
      record(
        'budget-shape-is-served-or-blocked-on-a-live-unit',
        `${shape.id} is blocked on ${shape.blockedOn}, which the manifest records as done. Either the ` +
          'route is served and the marker goes, or the unit did not build it and the deferral needs ' +
          're-pointing',
      )
    }
  }
}

function checkFigures(spec) {
  const bases = new Set(['acceptance', 'structural', 'unmeasured'])
  for (const budget of spec.budgets) {
    if (!bases.has(budget.basis)) {
      record(
        'budget-figure-has-a-stated-basis',
        `${budget.id} declares basis "${budget.basis}", which is not one of ` +
          `[${[...bases].join(', ')}]. A figure with no stated basis is a figure somebody invented`,
      )
      continue
    }
    const values = [budget.mobile, budget.desktop]
    if (budget.basis === 'unmeasured') {
      if (values.some((value) => value !== null)) {
        record(
          'budget-figure-has-a-stated-basis',
          `${budget.id} is declared unmeasured and carries a figure (${values.join('/')}). An ` +
            'unmeasured budget with a number in it is an invented target wearing a disclaimer',
        )
      }
      if (typeof budget.openQuestionId !== 'string' || budget.openQuestionId.trim() === '') {
        record(
          'budget-figure-has-a-stated-basis',
          `${budget.id} is unmeasured and names no open question, so nothing says who answers it`,
        )
      }
      continue
    }
    if (values.some((value) => typeof value !== 'number')) {
      record(
        'budget-figure-has-a-stated-basis',
        `${budget.id} has basis "${budget.basis}" and a non-numeric figure (${values.join('/')}). ` +
          'Only an unmeasured budget may be null',
      )
    }
  }
}

function checkCells(spec) {
  const themes = spec.cells.themes.map((cell) => cell.theme).sort()
  const directions = spec.cells.directions.map((cell) => cell.direction).sort()
  if (themes.join(',') !== 'dark,light') {
    record(
      'budget-covers-both-themes-and-both-directions',
      'budget-locale-prefix-matches-the-i18n-module',
      `the budget declares the theme(s) [${themes.join(', ')}] and the acceptance line asks for light ` +
        'and dark. The Arabic page ships a different font subset and the dark page a different image ' +
        'ladder, so a cell dropped here is a page nobody measured',
    )
  }
  if (directions.join(',') !== 'ltr,rtl') {
    record(
      'budget-covers-both-themes-and-both-directions',
      'budget-locale-prefix-matches-the-i18n-module',
      `the budget declares the direction(s) [${directions.join(', ')}] and the acceptance line asks ` +
        'for both',
    )
  }
  // The locale prefix is `LOCALE_PREFIX`'s, read rather than restated: a second spelling of which URL
  // the Arabic document lives at is a Lighthouse run against a 404.
  const i18n = read('apps/web/src/i18n/locales.ts')
  const match = /LOCALE_PREFIX[^=]*=\s*\{([^}]*)\}/.exec(i18n)
  if (match === null) {
    console.error(
      'apps/web/src/i18n/locales.ts has no LOCALE_PREFIX this gate can read, so the budget\u2019s ' +
        'pathPrefix could not be held equal to it. Fix the pattern, not the expectation.',
    )
    process.exit(1)
  }
  for (const cell of spec.cells.directions) {
    const declared = new RegExp(`${cell.locale}:\\s*'([^']*)'`).exec(match[1])
    if (declared === null || declared[1] !== cell.pathPrefix) {
      record(
        'budget-locale-prefix-matches-the-i18n-module',
        `the ${cell.direction} cell claims the locale "${cell.locale}" lives under ` +
          `"${cell.pathPrefix}" and LOCALE_PREFIX says "${declared?.[1] ?? '(absent)'}". The budget ` +
          'builds its collect URLs from the cell, so a disagreement is a Lighthouse run against a 404 ' +
          'scoring nearly perfectly',
      )
    }
  }

  const flags = new Set(spec.cells.themes.map((cell) => cell.chromeFlag))
  if (flags.size !== spec.cells.themes.length) {
    record(
      'budget-covers-both-themes-and-both-directions',
      'budget-locale-prefix-matches-the-i18n-module',
      'two theme cells carry the same Chrome flag, so both runs measure the same theme and the dark ' +
        'cell is a second copy of the light one',
    )
  }
}

/** The rc file holds no figure of its own, and derives every budget this gate can enforce. */
function checkRc(spec) {
  const text = read(RC_PATH)
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  // A numeric literal of three digits or more, or a decimal: the figures in the declaration all look
  // like one. `1` and `3000` differ, so the floor is deliberate — `numberOfRuns: 1` and a port are not
  // budgets, and a budget of 25 would slip through. That is why the second half of this rule reads the
  // derivation instead of trusting the scan.
  const literals = [...code.matchAll(/(?<![\w.])(\d{3,}|0\.\d+)(?![\w])/g)].map((match) => match[1])
  const permitted = new Set(['127', '0', '3000'])
  const offending = literals.filter((literal) => !permitted.has(literal))
  if (offending.length > 0) {
    record(
      'lighthouserc-holds-no-figure-of-its-own',
      `lighthouserc.cjs contains the numeric literal(s) [${offending.join(', ')}]. Every figure is ` +
        'the declaration’s: a threshold written here as well would be a second statement of it, and ' +
        'the symptom of a second statement is a CI job passing on the one nobody meant',
    )
  }
  const enforceable = spec.budgets.filter(
    (budget) =>
      (budget.enforcedBy === 'lighthouse-budget' || budget.enforcedBy === 'lhci-assertion') &&
      budget.mobile !== null,
  )
  for (const budget of enforceable) {
    if (
      !code.includes(
        budget.enforcedBy === 'lhci-assertion' ? 'lhci-assertion' : 'lighthouse-budget',
      )
    ) {
      record(
        'lighthouserc-derives-every-enforceable-budget',
        `lighthouserc.cjs never reads the enforcedBy value "${budget.enforcedBy}", so the budget ` +
          `${budget.id} is declared and nothing in the Lighthouse run would carry it`,
      )
      break
    }
  }
  if (!code.includes('budgetsPath') || !code.includes('assertions')) {
    record(
      'lighthouserc-derives-every-enforceable-budget',
      'lighthouserc.cjs sets no budgetsPath or no assertions, so Lighthouse would measure the pages ' +
        'and carry none of the figures',
    )
  }
  if (!code.includes('blockedOn === undefined')) {
    record(
      'lighthouserc-derives-every-enforceable-budget',
      'lighthouserc.cjs does not exclude a blockedOn route shape from its collection, so it would run ' +
        'Lighthouse against a route the registry does not serve and score the 404 page',
    )
  }
}

function checkLayers(spec, done) {
  const ids = spec.layers.entries.map((entry) => entry.id).sort()
  if (ids.join(',') !== 'ci,field,publish') {
    record(
      'every-layer-names-its-enforcement-or-the-unit-that-owns-it',
      `the declaration names the layer(s) [${ids.join(', ')}] and docs/08 §8 names field, CI and ` +
        'publish. Three independent layers with one missing is two layers and a claim',
    )
  }
  for (const entry of spec.layers.entries) {
    if (entry.enforcedBy === null && entry.blockedOn === undefined) {
      record(
        'every-layer-names-its-enforcement-or-the-unit-that-owns-it',
        `the ${entry.id} layer names no enforcement and no owning unit, so "any of the three failing ` +
          'is a red build" is a sentence about something that cannot fail',
      )
    }
    if (entry.enforcedBy === null && entry.blockedOn !== undefined && done.has(entry.blockedOn)) {
      record(
        'every-layer-names-its-enforcement-or-the-unit-that-owns-it',
        `the ${entry.id} layer is blocked on ${entry.blockedOn}, which the manifest records as done`,
      )
    }
  }
}

/**
 * Every public document is covered by an axe run AND a visual-regression baseline, or was already
 * uncovered when this gate was written.
 *
 * DERIVED, not declared: a suite's subject is the `probePath` it hands `startWebServer`, and a suite
 * covers that route when the same file both calls `auditPage(` and takes a screenshot. A declared
 * register would be a second statement of what the suites do, and it would go stale in the direction
 * that claims coverage.
 *
 * The baseline is the honest part. Twelve public documents had neither an axe run nor a baseline in a
 * browser suite when this gate was written — `pnpm a11y` audits the design specimen across the matrix
 * and the per-route sweeps live in individual suites — and a gate that failed the build on that would
 * have been switched off in a week. So the measured gap is committed as data, and what the rule refuses
 * is an ADDITION: a public document written after this gate must be covered, and a document removed
 * from the baseline cannot be put back.
 */
function checkMatrixCoverage(spec) {
  const covered = new Set()
  for (const dir of ['apps/web/src', 'apps/web/e2e']) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.itest.ts')) continue
      const text = read(join(dir, name))
      if (!text.includes('auditPage(')) continue
      if (!/\.screenshot\(/.test(text)) continue
      for (const match of text.matchAll(/probePath: '([^']+)'/g)) covered.add(match[1])
      // A suite whose probe path is a constant names it; the constant's value is in the same file.
      for (const match of text.matchAll(/^const (?:PATH|[A-Z_]*PATH) = '([^']+)'$/gm)) {
        covered.add(match[1])
      }
    }
  }
  const baseline = new Set(spec.matrixCoverage?.alreadyUncovered ?? [])
  const documents = registryDocuments()
  const uncovered = documents.filter((path) => !covered.has(path) && !baseline.has(path))
  if (uncovered.length > 0) {
    record(
      'a-new-public-document-is-covered-by-axe-and-a-baseline',
      `the public document(s) [${uncovered.join(', ')}] have neither an axe run nor a screenshot ` +
        'baseline in any browser suite, and are not in the committed baseline of documents that were ' +
        'already uncovered when this gate was written. A document added after this gate is covered or ' +
        'it is refused: a suite that drives the route must call auditPage and take a screenshot',
    )
  }
  const stale = [...baseline].filter((path) => !documents.includes(path) || covered.has(path))
  if (stale.length > 0) {
    record(
      'a-new-public-document-is-covered-by-axe-and-a-baseline',
      `the baseline still lists [${stale.join(', ')}], which are now covered or no longer documents. ` +
        'A baseline entry that excuses nothing is how a gate quietly stops being one — remove them',
    )
  }
  return { covered: [...covered].sort(), documents, baseline: [...baseline].sort() }
}

// --- the Lighthouse-native budgets file -----------------------------------------------------------

/** The Lighthouse budgets file for one form factor, derived from the declaration. */
function nativeBudgetFor(spec, formFactor) {
  const enforceable = spec.budgets.filter(
    (budget) => budget.enforcedBy === 'lighthouse-budget' && budget[formFactor] !== null,
  )
  const by = (unit) => enforceable.filter((budget) => budget.unit === unit)
  return spec.routeShapes
    .filter((shape) => shape.blockedOn === undefined)
    .map((shape) => ({
      path: shape.lighthousePathPattern,
      resourceSizes: by('kib').map((budget) => ({
        resourceType: budget.metric,
        budget: budget[formFactor],
      })),
      resourceCounts: by('count').map((budget) => ({
        resourceType: budget.metric,
        budget: budget[formFactor],
      })),
      timings: by('ms').map((budget) => ({ metric: budget.metric, budget: budget[formFactor] })),
    }))
}

// --- the measured half ----------------------------------------------------------------------------

const KIB = 1024

/** One Lighthouse report, flattened to the figures this gate enforces. */
function readingOf(report) {
  const audits = report.audits ?? {}
  const summary = audits['resource-summary']?.details?.items ?? []
  const sizeOf = (type) => summary.find((item) => item.resourceType === type)?.transferSize ?? null
  const countOf = (type) => summary.find((item) => item.resourceType === type)?.requestCount ?? null
  const lcpMs = audits['largest-contentful-paint']?.numericValue ?? null
  const requests = audits['network-requests']?.details?.items ?? []
  const beforeLcp =
    lcpMs === null
      ? null
      : requests.filter((item) => (item.networkEndTime ?? item.endTime ?? 0) <= lcpMs).length
  const documentRequest = requests.find(
    (item) => item.resourceType === 'Document' || item.resourceType === 'document',
  )
  return {
    url: report.finalDisplayedUrl ?? report.finalUrl ?? report.requestedUrl ?? '(unknown)',
    formFactor: report.configSettings?.formFactor === 'desktop' ? 'desktop' : 'mobile',
    statusCode: documentRequest?.statusCode ?? null,
    runtimeError: report.runtimeError?.code ?? null,
    values: {
      'largest-contentful-paint': lcpMs,
      'cumulative-layout-shift': audits['cumulative-layout-shift']?.numericValue ?? null,
      'total-blocking-time': audits['total-blocking-time']?.numericValue ?? null,
      'dom-size': audits['dom-size']?.numericValue ?? null,
      script: sizeOf('script') === null ? null : sizeOf('script') / KIB,
      stylesheet: sizeOf('stylesheet') === null ? null : sizeOf('stylesheet') / KIB,
      total: sizeOf('total') === null ? null : sizeOf('total') / KIB,
      'third-party': countOf('third-party'),
      'requests-before-lcp': beforeLcp,
    },
  }
}

/** Every `*.report.json` LHCI wrote, read. */
function reportsIn(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((name) => name.endsWith('.json') && !name.endsWith('budget.native.json'))
    .map((name) => {
      try {
        return { name, report: JSON.parse(read(join(dir, name))) }
      } catch {
        return null
      }
    })
    .filter((entry) => entry !== null && entry.report.audits !== undefined)
}

function enforceReports(spec) {
  const entries = reportsIn(REPORTS_DIR)
  if (entries.length === 0) {
    record(
      'report-exists-for-every-collected-target',
      `no Lighthouse report was found in ${REPORTS_DIR}. A run with no report is not a run that ` +
        'passed: this gate exits non-zero rather than reporting zero breaches over zero evidence',
    )
    return []
  }
  const readings = entries.map((entry) => readingOf(entry.report))
  for (const reading of readings) {
    if (reading.runtimeError !== null) {
      record(
        'report-is-of-a-document-that-answered-200',
        `${reading.url} produced the Lighthouse runtime error ${reading.runtimeError}, so its figures ` +
          'are about a page that did not load',
      )
      continue
    }
    if (reading.statusCode !== null && reading.statusCode !== 200) {
      record(
        'report-is-of-a-document-that-answered-200',
        `${reading.url} answered ${reading.statusCode}. A Lighthouse run against an error page scores ` +
          'nearly perfectly, so a job that passed on one would be the purest form of this gate not ' +
          'being one',
      )
      continue
    }
    for (const budget of spec.budgets) {
      const limit = budget[reading.formFactor]
      if (limit === null || limit === undefined) continue
      const measured = reading.values[budget.metric]
      if (measured === null || measured === undefined) {
        record(
          'measured-value-is-within-its-budget',
          `${reading.url} (${reading.formFactor}): the report carries no value for ` +
            `${budget.metric}, so ${budget.id} was not enforced. An absent measurement is not a pass`,
        )
        continue
      }
      if (measured > limit) {
        record(
          'measured-value-is-within-its-budget',
          `${reading.url} (${reading.formFactor}): ${budget.label} — ${budget.metric} measured ` +
            `${Math.round(measured * 100) / 100} ${budget.unit}, budget ${limit} ${budget.unit} ` +
            `(${budget.id})`,
        )
      }
    }
  }
  return readings
}

// --- main -----------------------------------------------------------------------------------------

function main() {
  const spec = declaration()

  if (EMIT_NATIVE !== null) {
    const formFactor = process.env['LHCI_FORM_FACTOR'] === 'desktop' ? 'desktop' : 'mobile'
    mkdirSync(dirname(EMIT_NATIVE), { recursive: true })
    writeFileSync(EMIT_NATIVE, `${JSON.stringify(nativeBudgetFor(spec, formFactor), null, 2)}\n`)
    console.log(
      `Wrote ${EMIT_NATIVE}: the Lighthouse-native budgets for the ${formFactor} form factor, ` +
        'derived from lighthouse/budget.json.',
    )
    return
  }

  const done = doneUnits()
  // The controls first. Every assertion below is over a list, and a parser that silently read nothing
  // would report success (ADR 0003).
  const served = registryPaths()
  if (served.length < 20) {
    console.error(
      `${REGISTRY_PATH} parsed to ${served.length} route(s), which is fewer than this repository ` +
        'serves. The scan has gone stale against the registry’s shape; fix the pattern.',
    )
    process.exit(1)
  }
  if (done.size < 20) {
    console.error(
      `${MANIFEST_PATH} parsed to ${done.size} done unit(s), which is fewer than the manifest records. ` +
        'The scan has gone stale; a blockedOn marker cannot be judged against an empty set.',
    )
    process.exit(1)
  }

  checkShapes(spec, served, done)
  checkFigures(spec)
  checkCells(spec)
  checkRc(spec)
  checkLayers(spec, done)
  const coverage = checkMatrixCoverage(spec)

  let readings = []
  if (REPORTS_DIR !== null) readings = enforceReports(spec)

  if (violations.length > 0) {
    console.error('Performance layer violations:\n')
    for (const violation of violations) {
      console.error(`  [${violation.rule}] ${violation.detail}`)
    }
    console.error(`\n${violations.length} violation(s).`)
    process.exit(1)
  }

  const unenforced = spec.budgets.filter((budget) => budget.basis === 'unmeasured')
  const blocked = spec.layers.entries.filter((entry) => entry.enforcedBy === null)
  console.log(
    `Performance layers hold: ${spec.budgets.length} budget(s) over ${spec.routeShapes.length} route ` +
      `shape(s) x ${spec.cells.themes.length} theme(s) x ${spec.cells.directions.length} direction(s) ` +
      `x ${spec.formFactors.length} form factor(s), and ${spec.layers.entries.length} enforcement ` +
      'layer(s).',
  )
  if (REPORTS_DIR !== null) {
    console.log(
      `  ${readings.length} Lighthouse report(s) read from ${REPORTS_DIR}; every declared budget was ` +
        'within its figure.',
    )
  } else {
    console.log('  Static half only: no --reports directory, so nothing was measured.')
  }
  console.log(
    `  ${coverage.covered.length} route(s) carry both an axe run and a screenshot baseline; ` +
      `${coverage.baseline.length} public document(s) were already uncovered when this gate was ` +
      'written and are committed as a baseline rather than excused.',
  )
  for (const budget of unenforced) {
    console.log(
      `  UNENFORCED: ${budget.id} (${budget.metric}) has no measured figure — ` +
        `${budget.openQuestionId}. It is reported on every run so it cannot be forgotten.`,
    )
  }
  for (const entry of blocked) {
    console.log(
      `  UNENFORCED LAYER: ${entry.id} — blocked on ${entry.blockedOn}. Reported on every run.`,
    )
  }
  console.log(`\n${RULES.length} rule(s) examined.`)
}

main()
