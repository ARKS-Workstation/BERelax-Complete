/**
 * The resolved dependency graph, read from `pnpm-lock.yaml`.
 *
 * Two gates need the same answer to the same question — *what is actually in the tree, and does any
 * of it ship?* — so they read it from one place. A workspace `package.json` cannot answer it: the
 * copyleft dependency this repository really has (`@img/sharp-libvips-*`, LGPL-3.0-or-later) is four
 * edges from anything anybody declared, and the advisories it really has are six edges away, inside
 * the Payload admin UI. A scan of declared dependencies would report a clean tree.
 *
 * Why a hand-written reader rather than a YAML library: there is no YAML dependency in this
 * workspace, and adding one so that a supply-chain gate can inspect the supply chain is the wrong
 * direction. This covers exactly the three sections of lockfileVersion 9 that the gates need, and it
 * **throws** when a section is missing or empty rather than returning an empty graph. That is ADR
 * 0002's failure mode: `pnpm boundaries` cruised zero modules and reported success.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, normalize } from 'node:path'

export const ROOT = join(import.meta.dirname, '..', '..')

/**
 * The importers whose **production** closure is distributed.
 *
 * Not the root and not `packages/*` on their own: `packages/harness` declares `axe-core` (MPL-2.0)
 * and `playwright` as ordinary dependencies because it is consumed by tests through a workspace
 * link, so `pnpm licenses list --prod -r` reports both as production. Nothing in the deployed
 * artefact imports them. The question a licence policy asks is "what do we distribute", and the
 * answer is the production closure of the two deployables.
 */
export const SHIPPED_IMPORTERS = ['apps/web', 'apps/worker']

const unquote = (value) => value.replace(/^'(.*)'$/, '$1')

/** The lines of one top-level block, i.e. everything indented under `name:` up to the next column-0 key. */
function sectionLines(text, name) {
  const lines = text.split('\n')
  const start = lines.indexOf(`${name}:`)
  if (start === -1) {
    throw new Error(`pnpm-lock.yaml has no \`${name}:\` section — the lockfile format changed`)
  }
  const out = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^\S/.test(line)) break
    out.push(line)
  }
  return out
}

function parseImporters(text) {
  const importers = new Map()
  let current
  let group
  let name
  for (const line of sectionLines(text, 'importers')) {
    const head = line.match(/^ {2}(\S.*?):(?: \{\})?$/)
    if (head) {
      current = {
        dependencies: new Map(),
        devDependencies: new Map(),
        optionalDependencies: new Map(),
      }
      importers.set(unquote(head[1]), current)
      group = undefined
      continue
    }
    const section = line.match(/^ {4}(dependencies|devDependencies|optionalDependencies):$/)
    if (section) {
      group = section[1]
      continue
    }
    const key = line.match(/^ {6}(\S.*?):$/)
    if (key) {
      name = unquote(key[1])
      continue
    }
    const version = line.match(/^ {8}version: (.+)$/)
    if (version && current !== undefined && group !== undefined && name !== undefined) {
      current[group].set(name, version[1].trim())
    }
  }
  if (importers.size === 0) throw new Error('pnpm-lock.yaml lists no importers')
  return importers
}

function parseSnapshots(text) {
  const snapshots = new Map()
  let current
  let group
  for (const line of sectionLines(text, 'snapshots')) {
    const head = line.match(/^ {2}(\S.*?):(?: \{\})?$/)
    if (head) {
      current = { dependencies: new Map(), optionalDependencies: new Map() }
      snapshots.set(unquote(head[1]), current)
      group = undefined
      continue
    }
    const section = line.match(/^ {4}(dependencies|optionalDependencies):$/)
    if (section) {
      group = section[1]
      continue
    }
    // `optional: true`, `transitivePeerDependencies:` and anything else at this depth ends the group,
    // so the `- name` list items underneath are never mistaken for dependency edges.
    if (/^ {4}\S/.test(line)) {
      group = undefined
      continue
    }
    const edge = line.match(/^ {6}(\S[^:]*?): (.+)$/)
    if (edge && current !== undefined && group !== undefined) {
      current[group].set(unquote(edge[1]), edge[2].trim())
    }
  }
  if (snapshots.size === 0) throw new Error('pnpm-lock.yaml lists no snapshots')
  return snapshots
}

function parsePackageKeys(text) {
  const keys = new Set()
  for (const line of sectionLines(text, 'packages')) {
    const head = line.match(/^ {2}(\S.*?):$/)
    if (head) keys.add(unquote(head[1]))
  }
  if (keys.size === 0) throw new Error('pnpm-lock.yaml lists no packages')
  return keys
}

export function readLockfile(root = ROOT) {
  const text = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
  return {
    importers: parseImporters(text),
    snapshots: parseSnapshots(text),
    packages: parsePackageKeys(text),
  }
}

/** `drizzle-orm@0.45.2(pg@8.23.0)` -> `drizzle-orm@0.45.2`. The peer suffix is not part of the identity. */
export const withoutPeers = (value) => {
  const at = value.indexOf('(')
  return at === -1 ? value : value.slice(0, at)
}

/** `name@1.2.3` -> `{ name: 'name', version: '1.2.3' }`, scoped names included. */
export function splitId(id) {
  const at = id.lastIndexOf('@')
  return { name: id.slice(0, at), version: id.slice(at + 1) }
}

/**
 * Breadth-first closure over the real graph.
 *
 * `includeDev` walks `devDependencies` of every importer it reaches; dependency *snapshots* never
 * carry dev edges, because a dependency's own dev dependencies are not installed. Breadth-first so
 * the first trail recorded for a package is the shortest one, which is the trail worth printing.
 */
export function resolveClosure({ importers, snapshots }, seeds, { includeDev }) {
  const found = new Map()
  const seenImporters = new Set()
  const unresolved = new Set()
  const queue = seeds.map((path) => ({ kind: 'importer', path, trail: [path] }))
  for (const seed of seeds) {
    if (!importers.has(seed)) throw new Error(`pnpm-lock.yaml has no importer \`${seed}\``)
  }

  /** `base` is the importer directory a `link:` resolves against, and is absent for package edges. */
  const push = (trail, name, version, base) => {
    if (version.startsWith('link:')) {
      if (base === undefined) {
        unresolved.add(`${name}@${version}`)
        return
      }
      const path = normalize(join(base, version.slice('link:'.length)))
      queue.push({ kind: 'importer', path, trail: [...trail, path] })
      return
    }
    const key = `${name}@${version}`
    queue.push({ kind: 'package', key, trail: [...trail, withoutPeers(key)] })
  }

  const visitImporter = (node) => {
    if (seenImporters.has(node.path)) return
    seenImporters.add(node.path)
    const importer = importers.get(node.path)
    if (importer === undefined) {
      unresolved.add(node.path)
      return
    }
    const groups = includeDev
      ? ['dependencies', 'optionalDependencies', 'devDependencies']
      : ['dependencies', 'optionalDependencies']
    for (const group of groups) {
      for (const [name, version] of importer[group]) {
        push(node.trail, name, version, node.path)
      }
    }
  }

  const visitPackage = (node) => {
    const id = withoutPeers(node.key)
    if (found.has(id)) return
    const { name, version } = splitId(id)
    found.set(id, { name, version, trail: node.trail })
    const snapshot = snapshots.get(node.key) ?? snapshots.get(id)
    if (snapshot === undefined) {
      unresolved.add(node.key)
      return
    }
    for (const group of ['dependencies', 'optionalDependencies']) {
      for (const [depName, depVersion] of snapshot[group]) {
        push(node.trail, depName, depVersion, undefined)
      }
    }
  }

  while (queue.length > 0) {
    const node = queue.shift()
    if (node.kind === 'importer') visitImporter(node)
    else visitPackage(node)
  }

  return { found, importers: seenImporters, unresolved }
}

/** The SPDX expression a package declares, in any of the three shapes npm has used for it. */
export function declaredLicence(manifest) {
  if (typeof manifest.license === 'string') return manifest.license
  if (typeof manifest.license?.type === 'string') return manifest.license.type
  if (Array.isArray(manifest.licenses)) {
    return manifest.licenses
      .map((entry) => (typeof entry === 'string' ? entry : entry?.type))
      .filter(Boolean)
      .join(' OR ')
  }
  return undefined
}

/**
 * Every package actually unpacked into the pnpm store, keyed `name@version`.
 *
 * Indexed by reading the store rather than by reconstructing pnpm's directory-name mangling: the
 * mangling is an implementation detail that has changed between lockfile versions, and a gate that
 * guessed it wrong would silently classify nothing. ~1,750 files, well under a second.
 */
const packageNamesIn = (modules) => {
  let entries
  try {
    entries = readdirSync(modules, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (!entry.name.startsWith('@')) {
      names.push(entry.name)
      continue
    }
    try {
      for (const scoped of readdirSync(join(modules, entry.name))) {
        names.push(`${entry.name}/${scoped}`)
      }
    } catch {
      /* a broken symlink in the store is not this gate's business */
    }
  }
  return names
}

export function readInstalledPackages(root = ROOT) {
  const store = join(root, 'node_modules', '.pnpm')
  const installed = new Map()
  let directories
  try {
    directories = readdirSync(store)
  } catch {
    throw new Error(`${store} does not exist — run \`pnpm install\` before this gate`)
  }
  for (const directory of directories) {
    const modules = join(store, directory, 'node_modules')
    for (const name of packageNamesIn(modules)) {
      const directoryPath = join(modules, name)
      let manifest
      try {
        manifest = JSON.parse(readFileSync(join(directoryPath, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue
      const id = `${manifest.name}@${manifest.version}`
      if (!installed.has(id)) {
        installed.set(id, { licence: declaredLicence(manifest), directory: directoryPath })
      }
    }
  }
  if (installed.size === 0) throw new Error(`${store} contains no packages — run \`pnpm install\``)
  return installed
}

/** Every workspace manifest, root included, expanded from `pnpm-workspace.yaml`'s globs. */
export function workspaceManifests(root = ROOT) {
  const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const globs = [...text.matchAll(/^\s*-\s*'?([^'\s]+)'?\s*$/gm)].map((match) => match[1])
  const paths = ['.']
  for (const glob of globs) {
    if (!glob.endsWith('/*')) {
      paths.push(glob)
      continue
    }
    const parent = glob.slice(0, -2)
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true })) {
      if (entry.isDirectory()) paths.push(`${parent}/${entry.name}`)
    }
  }
  const manifests = []
  for (const path of paths) {
    try {
      manifests.push({
        path: path === '.' ? 'package.json' : `${path}/package.json`,
        manifest: JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')),
      })
    } catch {
      /* a workspace directory with no manifest is not a workspace package */
    }
  }
  return manifests
}
