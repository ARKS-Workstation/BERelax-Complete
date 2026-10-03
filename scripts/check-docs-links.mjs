#!/usr/bin/env node
/**
 * Every relative link and every anchor in `docs/` resolves, including into the generated pages.
 *
 * The documentation set is this build's bus-factor artefact: the single builder leaves, and what
 * survives is what somebody else can read and follow. A broken link in that set is not untidy — it is
 * the sentence "the procedure is in the runbook" pointing at nothing, discovered by whoever is reading
 * it because something has already gone wrong.
 *
 * And it is the failure mode of a documentation set specifically, rather than of prose in general,
 * because the links are the part that goes stale without anybody touching the sentence around them. A
 * renamed ADR, a reworded runbook heading, a moved file: the paragraph still reads correctly and the
 * link is dead. Nothing else in this repository would notice — `pnpm adr` checks that records exist, not
 * that anything can reach them.
 *
 * ## What is checked
 *
 *  1. `docs-link-target-missing` — a relative link whose file is not there.
 *  2. `docs-anchor-missing` — a `#fragment` that matches no heading in the target. GitHub's slug, near
 *     enough: lower-cased, punctuation dropped, spaces hyphenated. Also checked for a same-file `#…`.
 *  3. `docs-generated-page-not-linked` — a generated page that nothing in `docs/` links to. A page
 *     nobody can reach from anywhere is a page that is not in the set, however current it is, and the
 *     generator keeping it fresh makes that worse rather than better.
 *
 * ## What is deliberately not checked
 *
 * **External links.** Resolving them is network I/O in a gate, and a gate that fails because a vendor's
 * marketing site is down is a gate people learn to ignore. `pnpm egress` is where outbound anything is
 * this build's business.
 *
 * **Links from code comments into docs.** There are hundreds, they are prose references rather than
 * navigation, and a reader who cannot find `docs/04 §8` from that string has a different problem. The
 * set this is about is the one somebody reads to operate the business.
 *
 * Usage: `node scripts/check-docs-links.mjs`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const DOCS = 'docs'
/** The pages a generator owns. Each must be reachable from the set, or it is not in the set. */
const GENERATED = ['docs/adr/INDEX.md', 'docs/operations/secret-inventory.md']

const problems = []
const fail = (rule, where, detail) => problems.push(`${where}  [${rule}] ${detail}`)

function* walk(dir) {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(rel)
    else if (entry.name.endsWith('.md')) yield rel
  }
}

/** GitHub's heading slug, near enough: lower-cased, punctuation dropped, spaces hyphenated. */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')

const pages = [...walk(DOCS)]

/*
  The floor (ADR 0002). An empty page list makes every loop below run zero times and the gate reports
  that every link in the documentation set resolves — about no documents. There are dozens.
*/
if (pages.length < 10) {
  console.error(
    `The docs link checker found ${pages.length} page(s) under ${DOCS}/, which is too few to mean ` +
      'anything. The directory walk is wrong, so "every link resolves" below would be about nothing.',
  )
  process.exit(1)
}

/** Every page's text, and the anchors it offers. */
const text = new Map()
const anchors = new Map()
for (const page of pages) {
  const body = readFileSync(join(ROOT, page), 'utf8')
  text.set(page, body)
  const set = new Set()
  for (const match of body.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    if (match[1] !== undefined) set.add(slug(match[1]))
  }
  // An explicit `<a name>` or `id` attribute is a legitimate anchor too, and the runbooks use neither
  // today — included so that the first page that does is not reported as broken.
  for (const match of body.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/g)) {
    if (match[1] !== undefined) set.add(match[1])
  }
  anchors.set(page, set)
}

let linksChecked = 0
const linkedTargets = new Set()

for (const page of pages) {
  const body = text.get(page) ?? ''
  /*
    Inline markdown links only: `[words](target)`. Reference-style definitions and bare URLs are not
    navigation a reader clicks through a rendered page, and the set uses none.

    Code fences are stripped first. `docs/12` and the runbooks contain shell blocks with `[`…`]` in
    them, and a link checker reading a `psql` invocation as a link reports a missing file that nobody
    ever wrote — which is a gate that fails on correct work, and a gate that fails on correct work
    teaches people to delete the gate.
  */
  const prose = body
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, (m) => m.replace(/[^\n]/g, ' '))

  for (const match of prose.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const target = match[1]
    if (target === undefined) continue
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue
    linksChecked += 1

    const [pathPart, anchor] = target.split('#')
    const where = `${page} -> ${target}`

    if (pathPart === undefined || pathPart === '') {
      // A same-page `#fragment`.
      if (anchor !== undefined && !(anchors.get(page) ?? new Set()).has(anchor)) {
        fail('docs-anchor-missing', where, 'no heading on this page produces that anchor')
      }
      continue
    }

    const resolved = normalize(relative(ROOT, resolve(join(ROOT, dirname(page)), pathPart)))
    if (resolved.startsWith('..')) {
      fail('docs-link-target-missing', where, 'resolves outside the repository')
      continue
    }
    let exists = false
    let isDirectory = false
    try {
      const stat = statSync(join(ROOT, resolved))
      exists = true
      isDirectory = stat.isDirectory()
    } catch {
      exists = false
    }
    if (!exists) {
      fail(
        'docs-link-target-missing',
        where,
        `${resolved} does not exist. A sentence saying the procedure is in the runbook, pointing at ` +
          'nothing, is read by whoever is already having a bad night',
      )
      continue
    }
    linkedTargets.add(resolved)
    if (isDirectory || !resolved.endsWith('.md')) continue
    if (anchor === undefined) continue
    const available = anchors.get(resolved)
    if (available === undefined) {
      // A markdown file outside `docs/` — the walk did not read it, so its headings are unknown and
      // reporting a missing anchor would be a guess. Read it now rather than skipping silently.
      const body2 = readFileSync(join(ROOT, resolved), 'utf8')
      const set = new Set([...body2.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1] ?? '')))
      anchors.set(resolved, set)
    }
    if (!(anchors.get(resolved) ?? new Set()).has(anchor)) {
      fail(
        'docs-anchor-missing',
        where,
        `${resolved} has no heading producing "#${anchor}". A reworded heading breaks the link and ` +
          'leaves the sentence around it reading perfectly',
      )
    }
  }
}

// A floor on the links as well as on the pages: a pattern that stopped matching would report success
// over nothing, which is the exact shape of the dead gate ADR 0002 is about.
if (linksChecked < 20) {
  fail(
    'docs-link-target-missing',
    DOCS,
    `only ${linksChecked} relative link(s) were examined across ${pages.length} page(s), which is too ` +
      'few. The link pattern is wrong, so the clean run below would be about nothing',
  )
}

for (const generated of GENERATED) {
  if (linkedTargets.has(normalize(generated))) continue
  fail(
    'docs-generated-page-not-linked',
    generated,
    'is generated and nothing in docs/ links to it. A page nobody can reach is not in the set, and a ' +
      'generator keeping it current makes that worse rather than better',
  )
}

if (problems.length > 0) {
  console.error('Documentation links:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\n${problems.length} problem(s).`)
  process.exit(1)
}

console.log(
  `Documentation links: ${linksChecked} relative link(s) across ${pages.length} page(s) resolve, every ` +
    `anchor matches a heading, and all ${GENERATED.length} generated page(s) are reachable from the set.`,
)
