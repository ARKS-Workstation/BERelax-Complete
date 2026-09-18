#!/usr/bin/env node
/**
 * Outbound licence policy, over the dependency graph that is actually resolved.
 *
 * BE RELAX is closed-source software for one business, so the only licence question that matters is
 * what distributing the product obliges the business to publish. That makes **transitive** copyleft
 * the finding, and it is why this reads `pnpm-lock.yaml` rather than the workspace manifests: the one
 * copyleft dependency this product really ships is `@img/sharp-libvips-<platform>`
 * (LGPL-3.0-or-later), four edges down from `packages/media`'s `sharp`, and nothing anybody wrote
 * mentions it. A scan of declared dependencies reports a clean tree.
 *
 * Three dispositions, and the difference between them is distribution, not ideology:
 *
 *  - **Strong copyleft (GPL, AGPL, SSPL, OSL, …) inside the shipped closure** is refused and cannot be
 *    accepted. The remedy is to remove the dependency, so there is nothing for an allowlist to say.
 *  - **Weak copyleft (LGPL, MPL, EPL, CDDL) inside the shipped closure** is allowed only with an entry
 *    in `accepted` that states the obligation it carries. The obligation is the point: "LGPL is fine"
 *    is not a decision, "the image must carry libvips' notice and the offer to replace it" is.
 *  - **Anything that only ever runs on a build machine** is measured and reported but not refused for
 *    weak copyleft, because MPL and LGPL duties attach to conveying the work. `axe-core` (MPL-2.0) and
 *    `lightningcss` (MPL-2.0) are here. Strong copyleft in tooling still needs an accepted entry.
 *
 * And a fourth subject with no disposition of its own: anything unpacked into the pnpm store that the
 * lockfile graph does not explain. That is either a lockfile and a tree that disagree or something that
 * wrote into `node_modules` after install; either way it is code on disk that no licence and no advisory
 * check has accounted for, so it is refused and classified as though it ships.
 *
 * "Shipped" is the production closure of `apps/web` and `apps/worker` only — see SHIPPED_IMPORTERS in
 * scripts/lib/dependency-graph.mjs for why `pnpm licenses list --prod -r` answers a different
 * question and gets `axe-core` wrong.
 *
 * Usage: `node scripts/check-licences.mjs [--policy build/licence-policy.json]`
 * The flag exists so the known-bad fixtures can run the real graph against a policy that is missing an
 * acceptance, or that classifies the LGPL family as strong copyleft. `pnpm licences` and CI pass no
 * flags.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ROOT,
  readInstalledPackages,
  readLockfile,
  resolveClosure,
  SHIPPED_IMPORTERS,
  splitId,
  workspaceManifests,
} from './lib/dependency-graph.mjs'

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const POLICY_PATH = flag('policy', 'build/licence-policy.json')
const policy = JSON.parse(readFileSync(join(ROOT, POLICY_PATH), 'utf8'))

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const globToRegExp = (pattern) => new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)

const RANK = { permissive: 0, weak: 1, strong: 2, unknown: 3 }

/**
 * The disposition of an SPDX expression.
 *
 * A disjunction takes its **most permissive** term, because a dual-licensed package lets the user
 * choose: `dompurify` is `(MPL-2.0 OR Apache-2.0)` and we take Apache-2.0, so it is not a copyleft
 * finding. A conjunction takes its least permissive term, because every condition applies.
 */
function classifyIdentifier(id) {
  if (policy.permissive.includes(id)) return 'permissive'
  if (policy.weakCopyleft.includes(id)) return 'weak'
  if (policy.strongCopyleft.includes(id)) return 'strong'
  return 'unknown'
}

/** A conjunction is only as permissive as its least permissive condition. */
function classifyConjunction(term) {
  let worst = 'permissive'
  for (const id of term.trim().split(/\s+AND\s+/i)) {
    const single = classifyIdentifier(id)
    if (RANK[single] > RANK[worst]) worst = single
  }
  return worst
}

function classify(expression) {
  if (expression === undefined || expression === null) return 'none'
  const text = String(expression).trim()
  if (text === '' || /^(UNLICENSED|UNKNOWN|SEE LICEN[CS]E)/i.test(text)) return 'none'
  let best = 'unknown'
  for (const term of text.replace(/[()]/g, ' ').split(/\s+OR\s+/i)) {
    const worst = classifyConjunction(term)
    if (RANK[worst] < RANK[best]) best = worst
  }
  return best
}

const platformBinaries = (policy.platformBinaries ?? []).map((entry) => ({
  ...entry,
  matches: globToRegExp(entry.pattern),
}))
const accepted = (policy.accepted ?? []).map((entry) => ({
  ...entry,
  matches: globToRegExp(entry.pattern),
  used: false,
}))

const lock = readLockfile()
const shipped = resolveClosure(lock, SHIPPED_IMPORTERS, { includeDev: false })
const everything = resolveClosure(lock, [...lock.importers.keys()], { includeDev: true })
const installed = readInstalledPackages()

const problems = []
const counted = new Map()
let declaredFromPolicy = 0

/**
 * Everything to classify: the resolved graph, plus anything unpacked into the store that the graph does
 * not explain.
 *
 * An orphan is either a lockfile and a tree that disagree, or something that wrote into `node_modules`
 * after install. Either way it is code on disk that no licence and no advisory check has ever accounted
 * for, and code on disk is what gets copied into an image — so it is classified as though it ships.
 */
const subjects = [...everything.found].map(([id, { name, trail: anyTrail }]) => {
  const shippedEntry = shipped.found.get(id)
  return {
    id,
    name,
    isShipped: shippedEntry !== undefined,
    // When a package ships, the trail worth printing is the one through a deployable — not whichever
    // importer the wider walk reached it from first, which for `sharp` is the repository root.
    trail: shippedEntry?.trail ?? anyTrail,
  }
})

for (const id of installed.keys()) {
  if (everything.found.has(id)) continue
  problems.push(
    `${id}  [package-outside-the-lockfile-graph] is unpacked in node_modules/.pnpm but no importer or ` +
      'snapshot reaches it. Run `pnpm install --frozen-lockfile`; if that does not remove it, something ' +
      'wrote into node_modules after install.',
  )
  subjects.push({ id, name: splitId(id).name, isShipped: true, trail: undefined })
}

for (const { id, name, isShipped, trail } of subjects) {
  const fromStore = installed.get(id)?.licence
  let licence = fromStore
  if (licence === undefined) {
    const declared = platformBinaries.find((entry) => entry.matches.test(name))
    if (declared === undefined) {
      // Not installed on this platform and not declared. Refusing is the only safe answer: a gate that
      // skipped these would classify nothing on a runner whose platform differs from the developer's.
      problems.push(
        `${id}  [unresolved-licence] not installed on this platform and no \`platformBinaries\` ` +
          `pattern covers it — add one, with the licence read from a sibling platform build` +
          `${isShipped ? ' (this one is in the shipped closure)' : ''}`,
      )
      continue
    }
    licence = declared.licence
    declaredFromPolicy += 1
  }

  const disposition = classify(licence)
  const bucket = `${isShipped ? 'shipped' : 'tooling'}/${disposition}`
  counted.set(bucket, (counted.get(bucket) ?? 0) + 1)

  const acceptance = accepted.find((entry) => entry.matches.test(name) && entry.licence === licence)
  if (acceptance !== undefined) acceptance.used = true

  const where =
    trail === undefined
      ? 'unpacked in node_modules, outside the lockfile graph'
      : isShipped
        ? `shipped via ${trail.join(' > ')}`
        : 'build tooling only'

  if (disposition === 'none') {
    problems.push(`${id}  [no-declared-licence] declares ${JSON.stringify(licence)} — ${where}`)
    continue
  }
  if (disposition === 'unknown') {
    problems.push(
      `${id}  [unclassified-licence] ${licence} is in none of the policy's three lists — ${where}`,
    )
    continue
  }
  if (disposition === 'strong') {
    if (isShipped) {
      problems.push(
        `${id}  [strong-copyleft-in-shipped-closure] ${licence} — ${where}. This cannot be ` +
          'accepted: distributing it would oblige the business to publish its source.',
      )
    } else if (acceptance === undefined) {
      problems.push(
        `${id}  [strong-copyleft-in-build-tooling] ${licence} — ${where}. Not distributed, so it ` +
          'is acceptable with a recorded reason, but not silently.',
      )
    }
    continue
  }
  if (disposition === 'weak' && isShipped && acceptance === undefined) {
    problems.push(
      `${id}  [unaccepted-weak-copyleft] ${licence} — ${where}. Add an entry to ` +
        `${POLICY_PATH} stating the obligation distribution carries.`,
    )
  }
}

for (const entry of accepted) {
  if (entry.used) continue
  problems.push(
    `${POLICY_PATH}  [stale-acceptance] nothing in the graph matches \`${entry.pattern}\` at ` +
      `${entry.licence} — delete the entry rather than leave it covering a future package`,
  )
}

/**
 * The workspace's own manifests. A closed-source product's packages grant nobody an outbound licence,
 * and `private: true` is what stops one being published by accident.
 */
for (const { path, manifest } of workspaceManifests()) {
  if (manifest.private !== true) {
    problems.push(`${path}  [private-workspace-package] must set "private": true`)
  }
  const own = manifest.license
  if (own !== undefined && !/^UNLICENSED$/i.test(String(own))) {
    problems.push(
      `${path}  [workspace-licence-grant] declares "license": ${JSON.stringify(own)} — a workspace ` +
        'package of a closed-source product grants no outbound licence; omit the field or use UNLICENSED',
    )
  }
}

// ADR 0003. `pnpm boundaries` once cruised zero modules and reported success; a licence gate that
// resolved an empty closure would report a clean tree for the same reason.
if (shipped.found.size < policy.minimumShippedPackages) {
  problems.push(
    `[empty-graph] the shipped closure resolved to ${shipped.found.size} packages, below the ` +
      `policy floor of ${policy.minimumShippedPackages}. The walk is broken, not the tree.`,
  )
}

if (problems.length > 0) {
  console.error('Licence policy violations:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\n${problems.length} problem(s) against ${POLICY_PATH}.`)
  process.exit(1)
}

const summary = [...counted]
  .sort()
  .map(([bucket, count]) => `${bucket} ${count}`)
  .join(', ')
console.log(
  `Licences clear: ${shipped.found.size} packages in the shipped closure of ` +
    `${SHIPPED_IMPORTERS.join(' + ')}, ${everything.found.size} in the whole graph ` +
    `(${declaredFromPolicy} classified from \`platformBinaries\` because this platform does not ` +
    `install them). ${summary}. ${accepted.length} accepted copyleft entr` +
    `${accepted.length === 1 ? 'y' : 'ies'}: ` +
    `${accepted.map((entry) => `${entry.pattern} (${entry.licence})`).join(', ')}.`,
)
