/**
 * Lighthouse CI's configuration, DERIVED from `lighthouse/budget.json` (W-SITE-11).
 *
 * Nothing here holds a figure. Every number, every URL and every Chrome flag is computed from that one
 * declaration, because the alternative is the defect this whole unit is about: a budgets file and an
 * assertions block that each state the same threshold, and a CI job that passes on the one nobody meant.
 * `scripts/check-performance-layers.mjs` holds this file and that one together — it builds the same
 * derivation and refuses a figure here that the declaration does not produce.
 *
 * ## `.cjs` and not `.js`
 *
 * `@lhci/cli` loads its config with `require`, and the repository is `"type": "module"`. A `.js` file
 * here would be an ES module Node refuses to `require`, which arrives as "Cannot use import statement
 * outside a module" from a tool that is not the one at fault.
 *
 * ## One form factor per invocation, on purpose
 *
 * A Lighthouse budget carries no form factor and LHCI takes one `budgetsPath`, so mobile and desktop
 * are two runs of this file rather than one. `LHCI_FORM_FACTOR` picks which, defaulting to mobile —
 * docs/08 §8's "mobile is where the budget bites", so the run somebody forgets to parameterise is the
 * strict one. CI runs both; the gate asserts both are run.
 *
 * ## The theme axis is a Chrome flag, not a URL
 *
 * `prefers-color-scheme` is not a Lighthouse setting. It is forced with Chrome's own
 * `--blink-settings=preferredColorScheme`, and the flag is read out of the declaration so the cell and
 * the flag cannot disagree. `LHCI_THEME` picks it; the direction axis is a locale and therefore a URL.
 *
 * ## What this file does NOT enforce
 *
 * Three of the nine declared budgets. `cumulative-layout-shift` and `dom-size` are audits rather than
 * budget metrics and arrive below as assertions; `requests-before-lcp` is derived from the
 * `network-requests` audit against the LCP timing and has neither a budget nor an audit, so
 * `scripts/check-performance-layers.mjs` is what fails the job for it. A Lighthouse budget breach is a
 * WARNING in the report rather than a non-zero exit, which is the other half of the same reason: the
 * authoritative enforcement is the script, and this file is what makes Lighthouse measure the right
 * pages in the right cells.
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const DECLARATION = join(__dirname, 'lighthouse', 'budget.json')
const declaration = JSON.parse(readFileSync(DECLARATION, 'utf8'))

/** `mobile` unless asked otherwise. See the header for why the default is the strict one. */
const formFactor = process.env['LHCI_FORM_FACTOR'] === 'desktop' ? 'desktop' : 'mobile'
const theme = process.env['LHCI_THEME'] === 'dark' ? 'dark' : 'light'
/** The origin the built application is served on. LHCI's own server if unset. */
const origin = process.env['LHCI_ORIGIN'] ?? 'http://127.0.0.1:3000'

const factor = declaration.formFactors.find((entry) => entry.id === formFactor)
const themeCell = declaration.cells.themes.find((entry) => entry.theme === theme)
if (factor === undefined || themeCell === undefined) {
  throw new Error(
    `lighthouserc.cjs was asked for the ${formFactor}/${theme} cell and lighthouse/budget.json ` +
      'declares no such cell. The cells are the declaration’s, so a cell this file invented would ' +
      'be a run against a page nobody budgeted.',
  )
}

/** The budgets for this form factor, as Lighthouse's own schema, minus the ones it cannot express. */
const nativeBudget = () => {
  const forFactor = (budget) => budget[formFactor]
  const enforceable = declaration.budgets.filter(
    (budget) => budget.enforcedBy === 'lighthouse-budget' && forFactor(budget) !== null,
  )
  const sizes = enforceable.filter((budget) => budget.unit === 'kib')
  const counts = enforceable.filter((budget) => budget.unit === 'count')
  const timings = enforceable.filter((budget) => budget.unit === 'ms')
  return declaration.routeShapes
    .filter((shape) => shape.blockedOn === undefined)
    .map((shape) => ({
      path: shape.lighthousePathPattern,
      resourceSizes: sizes.map((budget) => ({
        resourceType: budget.metric,
        budget: forFactor(budget),
      })),
      resourceCounts: counts.map((budget) => ({
        resourceType: budget.metric,
        budget: forFactor(budget),
      })),
      timings: timings.map((budget) => ({
        metric: budget.metric,
        budget: forFactor(budget),
      })),
    }))
}

/** The assertions for the budgets Lighthouse can only express as an audit's numeric value. */
const assertions = () => {
  const out = {}
  for (const budget of declaration.budgets) {
    if (budget.enforcedBy !== 'lhci-assertion') continue
    const value = budget[formFactor]
    if (value === null) continue
    out[budget.metric] = ['error', { maxNumericValue: value }]
  }
  return out
}

/**
 * Every URL to collect, as the cross of the collectable route shapes with the two directions.
 *
 * A shape carrying `blockedOn` is NOT collected: the route does not exist, so a run against it would be
 * a 404 — which this unit's own gate requires to FAIL rather than to pass with a perfect score over an
 * error page. The gate refuses the marker once the unit that owns the route is done, so the shape
 * cannot stay uncollected by accident.
 */
const urls = () =>
  declaration.routeShapes
    .filter((shape) => shape.blockedOn === undefined)
    .flatMap((shape) =>
      declaration.cells.directions.map((cell) => {
        const path = shape.registryPath.replace(
          '[slug]',
          process.env['LHCI_SAMPLE_SLUG'] ?? 'sample',
        )
        // `localisedPath`'s own arithmetic, over the declaration's own prefix: the root becomes the bare
        // prefix and everything else is prefixed. The prefix is NOT spelled here — it is the cell's, and
        // the gate holds it equal to `LOCALE_PREFIX` in `apps/web/src/i18n/locales.ts`.
        const localised =
          cell.pathPrefix === '' ? path : `${cell.pathPrefix}${path === '/' ? '' : path}`
        return `${origin}${localised}`
      }),
    )

module.exports = {
  ci: {
    collect: {
      url: urls(),
      numberOfRuns: 1,
      settings: {
        budgetsPath: DECLARATION_NATIVE_PATH(),
        ...(factor.lighthousePreset === null ? {} : { preset: factor.lighthousePreset }),
        chromeFlags: [
          // The theme cell, forced. See the header.
          themeCell.chromeFlag,
          // The same flags every browser in this repository launches with: no sandbox because the
          // container has no user namespaces, and a fixed colour profile because host-dependent
          // rasterisation is not worth a gate that only works on one machine.
          '--no-sandbox',
          '--force-color-profile=srgb',
        ].join(' '),
      },
    },
    assert: { assertions: assertions() },
    upload: { target: 'filesystem', outputDir: '.lighthouseci' },
  },
}

/**
 * Where the Lighthouse-native budgets file is written.
 *
 * Emitted rather than committed, by `scripts/check-performance-layers.mjs --emit-native <path>`, for
 * the reason this file holds no figure: a committed Lighthouse budgets file would be a second statement
 * of the declaration's numbers. It is written into `.lighthouseci`, which is gitignored, and the gate
 * asserts the emitted file equals what the declaration produces.
 */
function DECLARATION_NATIVE_PATH() {
  return process.env['LHCI_NATIVE_BUDGET'] ?? join(__dirname, '.lighthouseci', 'budget.native.json')
}

module.exports.nativeBudget = nativeBudget
module.exports.collectUrls = urls
module.exports.lhciAssertions = assertions
