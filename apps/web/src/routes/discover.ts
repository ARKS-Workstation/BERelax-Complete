/**
 * The routes on disk, derived from the App Router's own conventions.
 *
 * This is the other half of the bijection: the registry says what the site serves, and this says what
 * the filesystem serves. Comparing the two is what makes "adding a route without a registry entry" a
 * failing test rather than an omission nobody sees — and it is why this walks the directory rather than
 * reading a list. A list of expected files is the same list twice.
 *
 * The conventions implemented here are Next's, and each one has a reason to be got wrong:
 *
 * - **`(group)` contributes nothing to the URL.** There are four groups in this application — `(en)`,
 *   `(ar)`, `(payload)` and `(admin)` — and three of them exist because a root layout cannot be shared
 *   (see `app/_document/shell.tsx`). A scanner that treated them as segments would report `/(en)/` and
 *   match nothing in the registry.
 * - **`_private` folders are not routes.** `_document`, `_dev`, `_fonts` and `_routes` hold the shell,
 *   the gallery, the font declarations and the spine's components. Next excludes an underscore-prefixed
 *   folder from routing, so they contribute no URL and must not be counted as missing registry entries.
 * - **`page` is a document, `route` is a handler**, and both may exist in the same folder in principle —
 *   Next refuses that pair at build time, but the scanner reports both rather than picking one, so the
 *   conflict shows up as a duplicate path instead of silently resolving.
 * - **Dynamic segments keep their brackets.** `[index]`, `[...slug]` and `[[...segments]]` are spelled
 *   here exactly as `.next/app-path-routes-manifest.json` spells them, which is what lets
 *   `route-spine.itest.ts` compare this scan against what the build produced — a control on the scanner
 *   itself, because a scanner with a bug that dropped a route would otherwise make the bijection pass.
 *
 * It is test-only code that lives in `src/` rather than beside the test, because two tests need it: the
 * unit bijection and the post-build manifest comparison.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

export type FilesystemRouteKind = 'document' | 'handler'

export interface FilesystemRoute {
  /** The URL the router resolves this file to, dynamic segments included. */
  readonly path: string
  readonly kind: FilesystemRouteKind
  /** Relative to the app directory, for an error message that names the file. */
  readonly file: string
}

const PAGE_FILES = new Set(['page.tsx', 'page.ts', 'page.jsx', 'page.js'])
const ROUTE_FILES = new Set(['route.ts', 'route.tsx', 'route.js'])

/** `(en)` is a route group: it organises files and contributes nothing to the URL. */
function isRouteGroup(segment: string): boolean {
  return segment.startsWith('(') && segment.endsWith(')')
}

/** `_dev` is a private folder: Next excludes it from routing entirely. */
function isPrivateFolder(segment: string): boolean {
  return segment.startsWith('_')
}

/**
 * Every route under an app directory, unsorted.
 *
 * `appDir` is a parameter rather than a constant so the test can point it at a fixture tree and assert
 * the walk itself — a scan that is only ever run against the real directory is a scan whose failure mode
 * is "found nothing, reported success", which is the defect ADR 0002 was written about.
 */
export function filesystemRoutes(
  appDir: string,
  urlPrefix = '',
  filePrefix = '',
): FilesystemRoute[] {
  const found: FilesystemRoute[] = []
  for (const entry of readdirSync(appDir, { withFileTypes: true })) {
    const name = entry.name
    if (entry.isDirectory()) {
      if (name === 'node_modules' || isPrivateFolder(name)) continue
      found.push(
        ...filesystemRoutes(
          join(appDir, name),
          isRouteGroup(name) ? urlPrefix : `${urlPrefix}/${name}`,
          `${filePrefix}${name}/`,
        ),
      )
      continue
    }
    const kind = PAGE_FILES.has(name) ? 'document' : ROUTE_FILES.has(name) ? 'handler' : undefined
    if (kind === undefined) continue
    found.push({ path: urlPrefix === '' ? '/' : urlPrefix, kind, file: `${filePrefix}${name}` })
  }
  return found
}

/** The same routes, in path order, so a diff between two runs is empty rather than reordered. */
export function sortedFilesystemRoutes(appDir: string): readonly FilesystemRoute[] {
  return filesystemRoutes(appDir).sort((left, right) => left.path.localeCompare(right.path))
}
