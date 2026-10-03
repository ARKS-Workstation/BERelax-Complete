#!/usr/bin/env node
/**
 * Import the crawl baseline into `redirect_map`, idempotently.
 *
 * The baseline is `LEGACY_BASELINE` in `packages/core/src/seo/legacy-redirects.ts` — a committed fixture
 * of the four ranking URL patterns docs/13 §6 names, standing in for the real crawl and rank export
 * (`Y1-woo-baseline`). This script is what puts those rows in the table so that everything which CAN read
 * a database — the treatment route's resolver, the coverage gate's live half, a CDN rule generated from
 * the same table — has one answer to "where does this path go".
 *
 * `apps/web/proxy.ts` does NOT read the table: it is pure by construction and cannot reach a database, so
 * it resolves from the committed module. That is one fact in two places, and `redirects.itest.ts` holds
 * them equal by importing the baseline and asserting every row is in the table with the same target.
 *
 * ## It refuses rather than upserting
 *
 * A path that already redirects somewhere else is a CONFLICT, reported and not overwritten.
 * `redirect_map` is shared with the slug-change and therapist-archival rows, and an import that
 * overwrote one of those would silently undo a redirect somebody's page depends on — the symptom being a
 * 404 on a URL that worked yesterday. The exit code is non-zero when there is one.
 *
 * Run: `pnpm redirects:import` with `DATABASE_URL` set — `tsx`, because it imports TypeScript modules
 * directly the way `scripts/seed.mjs` does. `--dry-run` reports what it would do and writes nothing.
 */
import { LEGACY_BASELINE } from '../packages/core/src/seo/legacy-redirects.ts'
import { createConnection } from '../packages/db/src/connection.ts'
import {
  importBaselineRedirects,
  lookupRedirect,
} from '../packages/db/src/repositories/redirects.ts'

const DRY_RUN = process.argv.includes('--dry-run')
const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL'] ?? ''
if (url === '') {
  console.error('DATABASE_URL is required: this writes rows.')
  process.exit(2)
}

const rows = LEGACY_BASELINE.map((row) => ({
  sourcePath: row.source,
  targetPath: row.target,
  reason: row.reason,
}))

const sql = createConnection({ url, max: 2 })
try {
  if (DRY_RUN) {
    let present = 0
    const conflicts = []
    for (const row of rows) {
      const existing = await lookupRedirect(sql, row.sourcePath)
      if (existing === undefined) continue
      if (existing.targetPath === row.targetPath) present += 1
      else conflicts.push(`${row.sourcePath} already points at ${existing.targetPath}`)
    }
    console.log(
      `Crawl baseline (dry run): ${rows.length} row(s) in the fixture, ${present} already present, ` +
        `${rows.length - present - conflicts.length} would be inserted.`,
    )
    for (const conflict of conflicts) console.error(`  conflict: ${conflict}`)
    process.exit(conflicts.length === 0 ? 0 : 1)
  }

  const result = await importBaselineRedirects(sql, rows)
  console.log(
    `Crawl baseline: ${result.inserted} inserted, ${result.unchanged} already present, ` +
      `${result.conflicts.length} conflict(s).`,
  )
  for (const conflict of result.conflicts) {
    console.error(
      `  conflict: ${conflict.sourcePath} already redirects to ${conflict.existingTarget}. The ` +
        'baseline is NOT applied over an existing redirect — redirect_map is shared with slug changes ' +
        'and therapist archival, and overwriting one of those undoes a redirect a live page depends on.',
    )
  }
  process.exit(result.conflicts.length === 0 ? 0 : 1)
} finally {
  await sql.end({ timeout: 5 })
}
