#!/usr/bin/env node
import { LOCALES, localisedPath } from '../apps/web/src/i18n/locales.ts'
import {
  fillParams,
  isParameterised,
  ROUTES,
  registryPaths,
} from '../apps/web/src/routes/registry.ts'
/**
 * The 301 map is a FUNCTION with no gaps and no loops, and an unmapped ranking path fails the build.
 *
 * W-SITE-09's acceptance criterion in one sentence: *"every path in the baseline has a map row, and an
 * unmapped ranking path fails the build with the path printed, so an incomplete map is red rather than a
 * silent traffic loss."* The failure this removes is the quietest one a relaunch has: a URL that ranks,
 * is not in the map, and 404s from the day of the cutover. Nothing inside the application knows that URL
 * exists, so no test can discover it — only a declared baseline can, which is what makes a GATE the
 * right shape and a unit test the wrong one.
 *
 * ## It reads no database, deliberately
 *
 * The baseline is a committed module (`LEGACY_BASELINE`) and so is the registry of served routes, so this
 * runs in CI before any database exists and fails in the same second as a malformed cron. The table's own
 * half — that the rows were imported and point where the module says — is `redirects.itest.ts`'s, which
 * has a database.
 *
 * ## Four properties, and the fifth claim is about the TARGETS
 *
 * `redirectMapFindings` judges totality, single-valuedness, one-hop-ness and acyclicity.
 * `target_is_not_a_page` is the fifth and it is the one that needs this script rather than
 * `packages/core`: the set of served routes is the route registry's, which `packages/core` may not read.
 * A target the registry does not declare is a redirect to a 404 — 0029's "a 404 with extra steps" — and
 * it is the finding a relaunch produces by renaming a target page after the map was written.
 */
import {
  baselinePaths,
  formatRedirectMapFindings,
  LEGACY_BASELINE,
  redirectMapFindings,
} from '../packages/core/src/seo/legacy-redirects.ts'

/**
 * Every path this site serves that a redirect may legitimately target.
 *
 * The registry's literal paths, plus the concrete paths of the one parameterised route whose params a
 * redirect can name: a treatment. The slugs come from the BASELINE's own targets rather than from the
 * catalogue, because this script reads no database — and that is not a weakening, because a target naming
 * a slug the catalogue does not have is refused from the other side by `redirect_map_one_hop` (0029,
 * `redirect_target_unresolved`) the moment the importer writes the row.
 */
function servedPaths() {
  const served = new Set(registryPaths().filter((path) => !isParameterised(path)))
  const treatment = ROUTES.find((route) => route.id === 'treatment')
  if (treatment !== undefined) {
    for (const row of LEGACY_BASELINE) {
      const slug = /^\/treatments\/([a-z0-9-]+)$/.exec(row.target)?.[1]
      if (slug === undefined) continue
      for (const locale of LOCALES) {
        served.add(fillParams(localisedPath(treatment.path, locale), { slug }))
      }
    }
  }
  return served
}

const served = servedPaths()
const findings = redirectMapFindings({
  rows: LEGACY_BASELINE,
  baseline: baselinePaths(),
  isServedPage: (path) => served.has(path),
})

if (findings.length > 0) {
  console.error('\nRedirect map problems:\n')
  console.error(
    formatRedirectMapFindings(findings)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  )
  console.error(
    `\n${findings.length} problem(s). A 301 map is a function with no gaps and no loops: a path in the ` +
      'baseline with no row is a 404 on a page that ranks, and nothing inside this application knows ' +
      'that URL exists.',
  )
  process.exit(1)
}

console.log(
  `Redirect map: ${LEGACY_BASELINE.length} row(s) over ${baselinePaths().length} baseline path(s), ` +
    `every one a single hop to one of ${served.size} served path(s), no chain and no loop.`,
)
