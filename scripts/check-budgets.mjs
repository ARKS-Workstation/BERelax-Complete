#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
/**
 * Byte budgets for everything shipped to a browser or embedded in a document.
 *
 * A performance budget nobody measures is a paragraph in a design document. This measures, and it
 * fails — which is the only difference that matters, because payload weight never regresses in one
 * visible step. It regresses by eight kilobytes at a time, each individually reasonable, until the
 * page is twice the size and nobody can point at the commit.
 *
 * `build/budgets.json` carries a reason per entry, not just a number. A budget with no stated reason
 * gets raised the first time it fails, which makes it decoration.
 *
 * Four kinds of budget, and each measures the artefact the browser or the reader actually receives:
 * `file` on disk, `fonts` embedded in a document, `derivative` built through the real encoder, and
 * `client-js` read out of the real `next build` — the island budget, W-SYS-04's.
 */
import { gzipSync } from 'node:zlib'
import { encodeRendition } from '../packages/media/src/derivatives.ts'
import { embeddedFontBytes } from '../packages/pdf/src/fonts.ts'

const ROOT = join(import.meta.dirname, '..')
const { budgets } = JSON.parse(readFileSync(join(ROOT, 'build', 'budgets.json'), 'utf8'))

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`

/**
 * The media manifest, for the focal point a derivative budget has to crop around.
 *
 * A budget measured on a centre crop would be measuring a file the site never serves: the portraits are
 * full-length shots whose subject sits in the top fifth, and the crop that keeps the face in frame is a
 * different set of pixels with a different byte count.
 */
const mediaAssets = JSON.parse(
  readFileSync(join(ROOT, 'assets', 'media', 'manifest.json'), 'utf8'),
).assets

/**
 * A `derivative` budget encodes the real original through the real encoder and measures the result.
 *
 * It is built rather than read off disk because no derivative is committed (`assets/media/README.md`) —
 * they are produced at deploy time. Measuring a checked-in copy would measure whatever was last committed,
 * which is the thing a budget is supposed to notice changing.
 *
 * `encodeRendition` is the function `buildDerivatives` itself calls. A second copy of the encoder settings
 * here would let this pass while the file the site serves is over.
 */
async function derivativeBytes(budget) {
  const relative = budget.source.replace(/^assets\/media\//, '')
  const asset = mediaAssets.find((candidate) => candidate.path === relative)
  if (asset === undefined) {
    throw new Error(`${budget.id}: ${budget.source} is not in the media manifest`)
  }
  const encoded = await encodeRendition({
    source: readFileSync(join(ROOT, budget.source)),
    crop: budget.crop,
    width: budget.width,
    format: budget.format,
    focal: { x: asset.focalX ?? 50, y: asset.focalY ?? 50 },
  })
  return encoded.length
}

/*
 * ── The island budget ────────────────────────────────────────────────────────────────────────────
 *
 * docs/08 §7 budgets the motion library at "≤2 code-split islands, never in the shared layout", and
 * W-SYS-04's acceptance turns that into two measurements: the shared layout ships zero bytes
 * attributable to motion, and each island is at most 40KB gzip.
 *
 * ## Where the numbers come from
 *
 * `next build` writes one `page_client-reference-manifest.js` per route, and each one lists every client
 * module the route ships with its Turbopack module id and the chunk group that has to be loaded for it.
 * That is the build's own record of what a browser downloads, which is why it is read here rather than
 * anything being inferred from the import graph: an import that the bundler tree-shook costs nothing,
 * and an import somebody forgot they made still costs whatever the chunk weighs.
 *
 * ## Three scopes, because "the island's bytes" is not one number
 *
 * Turbopack gives every client module on a route the *same* chunk list — the route's whole client group —
 * so a chunk list cannot be divided between the modules that share it. What it does give is the chunk
 * that **defines** a module, found by that module's id, and that is the narrow measurement. The wider one
 * is the route's whole client group, which is what notices a library arriving anywhere in an island's
 * import graph rather than in the island's own chunk. Both are budgeted:
 *
 * - `scope: "shared"` — the chunks every route loads. Its client modules are an allow-list, so a new
 *   client reference in the shell fails by name rather than by two kilobytes nobody looks at.
 * - `scope: "modules"` — the chunks that define the named modules. The narrow per-island number.
 * - `scope: "route"` — everything a route loads beyond the shared layout. The number that moves when a
 *   32KB animation library joins an island's graph, wherever the bundler decides to put it.
 *
 * ## gzip, level 9, deterministic
 *
 * A budget has to mean the same thing on two machines. Level 9 is the strongest zlib setting and the one
 * a CDN's precompressed asset is closest to; Brotli would be closer still and is not in the standard
 * library, so the number here is conservative — real transfer is smaller, never larger.
 */
const NEXT_DIR = join(ROOT, 'apps', 'web', '.next')

/**
 * One spelling per chunk.
 *
 * The same chunk is written two ways in the same manifest — `clientModules` uses the served URL
 * (`/_next/static/chunks/x.js`) and `entryJSFiles` the build-relative path (`static/chunks/x.js`). A set
 * that holds both counts every chunk twice, which measured this route at 90KB when it ships 46KB, and a
 * doubled measurement in a budget is a budget that fails on nothing having changed.
 */
function normaliseChunk(chunk) {
  return chunk.replace(/^\/_next\//, '').replace(/^\//, '')
}

/** How a chunk list in a manifest maps to a file on disk. */
function chunkPath(chunk) {
  return join(NEXT_DIR, normaliseChunk(chunk))
}

function gzipBytes(chunks) {
  let total = 0
  for (const chunk of chunks) total += gzipSync(readFileSync(chunkPath(chunk)), { level: 9 }).length
  return total
}

/** Every `page_client-reference-manifest.js` the build wrote, as parsed objects. */
function clientManifests(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...clientManifests(full))
    } else if (entry.name === 'page_client-reference-manifest.js') {
      const source = readFileSync(full, 'utf8')
      const route = /__RSC_MANIFEST\["([^"]+)"\]/.exec(source)?.[1] ?? full
      // The file is `globalThis.__RSC_MANIFEST["…"] = { … };`, so the object is what sits between the
      // first `] = ` and the statement's semicolon.
      const assigned = source
        .slice(source.indexOf('] = ') + 4)
        .trim()
        .replace(/;$/, '')
      found.push({ route, manifest: JSON.parse(assigned) })
    }
  }
  return found
}

/** `[project]/packages/ui/src/x.tsx` -> `packages/ui/src/x.tsx`; an installed package -> null. */
function firstPartyPath(moduleId) {
  const relative = moduleId.replace(/^\[project\]\//, '')
  return /^(packages|apps)\//.test(relative) && !relative.includes('node_modules/')
    ? relative
    : null
}

/**
 * The routes whose weight this project is answerable for.
 *
 * `(payload)` is the CMS's own admin UI — nine chunks and most of a megabyte of Payload's React app,
 * which W-SYS-08 owns and no customer loads. `_not-found` and `_global-error` are Next's own. Including
 * any of them would make the shared-layout measurement the *intersection with* the admin, which is a
 * different and much larger number.
 */
function isOwnRoute(route) {
  return !route.startsWith('/(payload)') && !route.startsWith('/_')
}

/** The build's client-side record, or null when nothing has been built. */
function readClientBuild() {
  const appDir = join(NEXT_DIR, 'server', 'app')
  if (!existsSync(appDir)) return null
  const pages = clientManifests(appDir).filter((page) => isOwnRoute(page.route))
  if (pages.length === 0) return null

  /** The chunks of every root layout entry — what a browser loads before any page's own code. */
  const sharedChunks = new Set()
  for (const { manifest } of pages) {
    for (const [entry, chunks] of Object.entries(manifest.entryJSFiles ?? {})) {
      if (/app\/\([a-z]+\)\/layout$/.test(entry)) {
        for (const chunk of chunks) sharedChunks.add(normaliseChunk(chunk))
      }
    }
  }

  /**
   * The client modules every page ships, which is what "the shared layout" means as a set of modules.
   *
   * An intersection rather than the layout entry's own list: a client reference reaches every page
   * whether the shell imports it directly or through something the shell imports, and the thing being
   * fenced off is "on every page", not "named in one file".
   */
  let sharedModules
  for (const { manifest } of pages) {
    const modules = new Set(Object.keys(manifest.clientModules))
    sharedModules =
      sharedModules === undefined
        ? modules
        : new Set([...sharedModules].filter((module) => modules.has(module)))
  }

  return { pages, sharedChunks: [...sharedChunks], sharedModules: [...(sharedModules ?? [])] }
}

const clientBuild = readClientBuild()

/**
 * The chunk that *defines* a module, as opposed to the chunk group that has to be loaded for it.
 *
 * Turbopack chunks carry no paths — a module is registered by its numeric id, which the manifest also
 * records. So the defining chunk is the one whose text registers that id. Exactly one chunk must, and a
 * count of zero or two is reported rather than silently resolved: a bundler format change that broke this
 * match would otherwise measure nothing and pass forever, which is ADR 0003's failure mode with a
 * kilobyte count attached to it.
 */
function definingChunk(module, info) {
  const matches = info.chunks.filter((chunk) => {
    const text = readFileSync(chunkPath(chunk), 'utf8')
    return new RegExp(`[,[]${info.id},`).test(text)
  })
  if (matches.length !== 1) {
    throw new Error(
      `[unattributable-client-module] ${module}: module id ${info.id} is registered by ` +
        `${matches.length} of its ${info.chunks.length} chunks, not exactly one. Turbopack's chunk ` +
        'format has changed and this measurement is no longer measuring anything.',
    )
  }
  return matches[0]
}

/**
 * `scope: "shared"` — the chunks every route loads, and the allow-list of what may be in them.
 *
 * The byte count and the module list answer different halves of one question. A module list cannot see a
 * library bundled *inside* a module it permits; a byte count cannot say which module grew. Both are
 * needed for "the shared layout ships zero bytes attributable to motion" to be a measurement rather than
 * a hope.
 */
function sharedScope(build, budget) {
  const declared = new Set(budget.declaredModules ?? [])
  const violations = []
  for (const module of build.sharedModules) {
    const path = firstPartyPath(module)
    if (path === null || declared.has(path)) continue
    violations.push(
      `[undeclared-shared-client-module] ${path} is a client reference on every route. Every page ` +
        'in the application pays for it, which is why the shared set is an allow-list in ' +
        'build/budgets.json: docs/08 §7 puts the motion islands and everything like them behind a ' +
        'dynamic import, never in the shell.',
    )
  }
  return { chunks: build.sharedChunks, violations }
}

/** `scope: "modules"` — the chunks that define the named modules. The narrow per-island number. */
function moduleScope(build, budget) {
  const wanted = new Set(budget.modules)
  const found = new Set()
  const defining = new Set()
  const violations = []
  for (const { manifest } of build.pages) {
    for (const [module, info] of Object.entries(manifest.clientModules)) {
      const path = firstPartyPath(module)
      if (path === null || !wanted.has(path)) continue
      found.add(path)
      defining.add(normaliseChunk(definingChunk(path, info)))
    }
  }
  for (const module of wanted) {
    if (found.has(module)) continue
    // The vacuity guard. A budget over a module the build does not contain measures zero bytes and
    // passes, which is exactly how a check stops being one.
    violations.push(
      `[missing-client-module] ${module} is declared in this budget and is not a client module of ` +
        'any route in the build. Either it is no longer an island or nothing renders it, and either ' +
        'way this budget was about to measure zero bytes.',
    )
  }
  return { chunks: [...defining], violations }
}

/** `scope: "route"` — everything one route loads beyond the shared layout. */
function routeScope(build, budget) {
  const page = build.pages.find(({ manifest }) =>
    Object.keys(manifest.entryJSFiles ?? {}).some((entry) => entry.endsWith(budget.entry)),
  )
  if (page === undefined) {
    return {
      chunks: [],
      violations: [
        `[missing-route-entry] no route in the build has the entry ${budget.entry}; this budget is ` +
          'measuring a page that no longer exists.',
      ],
    }
  }
  const shared = new Set(build.sharedChunks)
  const own = new Set()
  const add = (chunk) => {
    const normalised = normaliseChunk(chunk)
    if (!shared.has(normalised)) own.add(normalised)
  }
  for (const entry of Object.values(page.manifest.entryJSFiles ?? {})) for (const c of entry) add(c)
  for (const info of Object.values(page.manifest.clientModules)) for (const c of info.chunks) add(c)
  return { chunks: [...own], violations: [] }
}

const CLIENT_JS_SCOPES = { shared: sharedScope, modules: moduleScope, route: routeScope }

/** Measures one `client-js` budget, and reports any rule it breaks by name. */
function clientJsBytes(budget) {
  if (clientBuild === null) return null
  const scope = CLIENT_JS_SCOPES[budget.scope]
  if (scope === undefined)
    throw new Error(`${budget.id}: unknown client-js scope '${budget.scope}'`)
  const { chunks, violations } = scope(clientBuild, budget)
  return { bytes: gzipBytes(chunks), chunks: chunks.length, violations }
}

let failures = 0
let skipped = 0

for (const budget of budgets) {
  let actual
  let ruleViolations = []
  if (budget.kind === 'fonts') {
    actual = embeddedFontBytes()
  } else if (budget.kind === 'derivative') {
    actual = await derivativeBytes(budget)
  } else if (budget.kind === 'client-js') {
    const measured = clientJsBytes(budget)
    if (measured === null) {
      // `.next` is gitignored, and this budget can only be measured against a real build. CI runs
      // `pnpm --filter @berelax/web build` before this step and `scripts/test-gates.mjs` asserts that
      // ordering, so a skip here is a developer who has not built yet — never CI quietly measuring
      // nothing.
      console.log(
        `SKIP  ${budget.label.padEnd(42)} no build — run \`pnpm --filter @berelax/web build\``,
      )
      skipped += 1
      continue
    }
    actual = measured.bytes
    ruleViolations = measured.violations
  } else {
    try {
      actual = statSync(join(ROOT, budget.path)).size
    } catch {
      if (budget.optional === true) {
        // Generated by `pnpm screens`, which CI runs before this. A developer who has not run it
        // locally should not get a failure about a file they were never asked to produce.
        console.log(`SKIP  ${budget.label.padEnd(42)} not built`)
        skipped += 1
        continue
      }
      console.error(`FAIL  ${budget.label.padEnd(42)} missing: ${budget.path}`)
      failures += 1
      continue
    }
  }

  const headroom = budget.maxBytes - actual
  const status = headroom >= 0 && ruleViolations.length === 0 ? 'PASS' : 'FAIL'
  if (headroom < 0) failures += 1
  console.log(
    `${status}  ${budget.label.padEnd(42)} ${kb(actual).padStart(9)} of ${kb(budget.maxBytes).padStart(9)}` +
      `  (${headroom >= 0 ? `${kb(headroom)} left` : `${kb(-headroom)} over`})`,
  )
  if (headroom < 0) {
    // The rule name and the exact byte count, in that order. `scripts/test-gates.mjs` asserts a known-bad
    // fixture was rejected *by this rule* rather than by a missing file or a thrown encoder — the ADR 0003
    // failure mode — and the number has to be the measurement rather than a rounded kilobyte, because the
    // first question anybody asks of a breached budget is by how much.
    console.error(
      `      [over-budget] ${budget.id}: measured ${actual} bytes against a budget of ` +
        `${budget.maxBytes} bytes`,
    )
    console.error(`      ${budget.why}`)
  }
  for (const violation of ruleViolations) {
    failures += 1
    console.error(`      ${violation}`)
  }
}

if (failures > 0) {
  console.error(
    `\n${failures} budget(s) breached. Raising the number is a decision with a reason, not a fix — ` +
      'the reason is in build/budgets.json beside it.',
  )
  process.exit(1)
}
console.log(`\n${budgets.length - skipped} budget(s) within limits.`)
