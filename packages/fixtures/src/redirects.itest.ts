import { formatRedirectMapFindings, LEGACY_BASELINE, redirectMapFindings } from '@berelax/core'
import {
  allRedirects,
  createConnection,
  importBaselineRedirects,
  lookupRedirect,
  type Sql,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The crawl-baseline importer, against a real PostgreSQL and without a server.
 *
 * Here rather than in `apps/web/src/public-site.itest.ts`, and the split is deliberate. The claims about
 * the importer are claims about ROWS — idempotency, and the refusal to overwrite a redirect that is
 * already there — and `packages/fixtures` is the right home for a test that exercises `@berelax/core`'s
 * rules against `@berelax/db`'s rows (brief rule 4). It also means the gate case that breaks the importer
 * does not need a BUILT application to prove it: a suite that needs `next build` is one whose failure a
 * reader has to wait several minutes for.
 *
 * The served behaviour — one 301 hop to a 200, the query string, the locale prefix — is the integration
 * suite's, because only a request can see it.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (!DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

let sql: Sql

const rows = LEGACY_BASELINE.map((row) => ({
  sourcePath: row.source,
  targetPath: row.target,
  reason: row.reason,
}))

beforeAll(() => {
  sql = createConnection({ url: DATABASE_URL, max: 2 })
})

afterAll(async () => {
  // Only the rows this file created. `redirect_map` is shared with the slug-change and
  // therapist-archival rows, and a wider delete would remove a redirect a live page depends on.
  for (const row of rows) {
    await sql`delete from redirect_map where source_path = ${row.sourcePath}`
  }
  await sql`delete from redirect_map where source_path = ${'/product/conflict-probe'}`
  await sql.end({ timeout: 5 })
})

describe('the baseline importer', () => {
  it('writes every row once and is a no-op on a second run', async () => {
    const first = await importBaselineRedirects(sql, rows, 'fixtures redirects.itest')
    expect(first.inserted + first.unchanged).toBe(rows.length)
    expect([...first.conflicts]).toEqual([])
    const second = await importBaselineRedirects(sql, rows, 'fixtures redirects.itest')
    expect(second.inserted).toBe(0)
    expect(second.unchanged).toBe(rows.length)
    expect([...second.conflicts]).toEqual([])
    for (const row of rows) {
      const stored = await lookupRedirect(sql, row.sourcePath)
      expect(stored?.targetPath, row.sourcePath).toBe(row.targetPath)
      expect(stored?.statusCode, row.sourcePath).toBe(301)
    }
  }, 60_000)

  it('refuses a source that already redirects somewhere else, and leaves the row alone', async () => {
    /*
      The acceptance line asks for the REFUSAL to be asserted and not a silent upsert. `redirect_map` is
      shared: B-CAT-05 writes a row on a slug change and W-SITE-06 on a therapist archival, so an import
      that overwrote one would silently undo a redirect a live page depends on — and the symptom is a 404
      on a URL that worked yesterday, with nothing in the import's output to connect the two.
    */
    const probe = '/product/conflict-probe'
    await sql`
      insert into redirect_map (source_path, target_path, status_code, reason, created_by)
      values (${probe}, ${'/pricing'}, 301, 'a pre-existing redirect', 'fixtures redirects.itest')
      on conflict (source_path) do nothing
    `
    const result = await importBaselineRedirects(
      sql,
      [{ sourcePath: probe, targetPath: '/treatments', reason: 'the baseline would say this' }],
      'fixtures redirects.itest',
    )
    expect(result.inserted).toBe(0)
    expect(result.conflicts).toEqual([{ sourcePath: probe, existingTarget: '/pricing' }])
    // Untouched, which is the half that matters.
    expect((await lookupRedirect(sql, probe))?.targetPath).toBe('/pricing')
    expect((await lookupRedirect(sql, probe))?.reason).toBe('a pre-existing redirect')
  }, 60_000)

  it('reports every conflict in one run rather than throwing on the first', async () => {
    // An importer that threw on the first would be run, fixed, run, fixed — once per conflicting path.
    const result = await importBaselineRedirects(
      sql,
      rows.map((row) => ({ ...row, targetPath: '/pricing' })),
      'fixtures redirects.itest',
    )
    expect(result.conflicts).toHaveLength(rows.length)
  }, 60_000)

  it('leaves the table a function with no gaps, no chains and no loops', async () => {
    const stored = await allRedirects(sql)
    const served = new Set<string>(['/treatments', '/pricing'])
    for (const row of stored) {
      const slug = /^\/treatments\/([a-z0-9-]+)$/.exec(row.targetPath)?.[1]
      if (slug !== undefined) served.add(`/treatments/${slug}`)
    }
    const findings = redirectMapFindings({
      rows: stored.map((row) => ({
        source: row.sourcePath,
        target: row.targetPath,
        reason: row.reason,
      })),
      baseline: rows.map((row) => row.sourcePath),
      isServedPage: (path) => served.has(path),
    })
    // `target_is_not_a_page` is excluded: this file has no route registry, so "a page this site serves"
    // is a question it cannot answer — `pnpm redirects` answers it without a database and
    // `public-site.itest.ts` answers it against the registry. What IS asserted here is the shape of the
    // table: no gap, no chain, no loop, nothing mapped twice.
    const shape = findings.filter((finding) => finding.rule !== 'target_is_not_a_page')
    expect(formatRedirectMapFindings(shape)).toBe('')
  }, 60_000)
})
