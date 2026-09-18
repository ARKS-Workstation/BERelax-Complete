#!/usr/bin/env node
/**
 * Container policy: the part of container scanning that can be done without an image.
 *
 * **There is no Dockerfile in this repository yet.** `apps/worker/Dockerfile` belongs to W-SYS-06,
 * which needs ffmpeg in the image, and scanning an image's OS packages for CVEs needs an image. So
 * this gate does not pretend to be Trivy against a container that does not exist — that half is
 * deferred, recorded in `build/container-policy.json` and in H-HARD-02's manifest entry, and will be a
 * CI step rather than part of `pnpm verify` when it lands, because it downloads a vulnerability
 * database.
 *
 * What there is today is a container surface that CI and local development already depend on, and it
 * has a real failure mode. `docker-compose.yml` and `.github/workflows/ci.yml` each name a PostgreSQL
 * image independently. The migration dry run, `pnpm db:drift` and the whole integration suite validate
 * against whatever major CI starts; the deployment target is a DigitalOcean **PostgreSQL Managed
 * Database** on major 16. If those three numbers stop agreeing, every gate still passes and what was
 * validated is not what is deployed — and the behaviour that would be validated on the wrong engine is
 * the btree_gist exclusion constraint and the deferred capacity trigger (ADR 0015, ADR 0024), which is
 * the double-booking guard.
 *
 * The Dockerfile rules are written and live now, with known-bad fixtures proving they fire, so the
 * first Dockerfile is held to them on the commit that adds it rather than six months later.
 *
 * Usage: `node scripts/check-container.mjs [--policy build/container-policy.json]`
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const POLICY_PATH = flag('policy', 'build/container-policy.json')
const policy = JSON.parse(readFileSync(join(ROOT, POLICY_PATH), 'utf8'))
const problems = []

const listing = (directory) => {
  try {
    return readdirSync(join(ROOT, directory))
  } catch {
    return []
  }
}

/** Every file that can name a container image: compose files, workflows, and Dockerfiles. */
function composeAndWorkflowFiles() {
  const files = []
  for (const name of listing('.')) {
    if (/^docker-compose.*\.(ya?ml)$/.test(name)) files.push(name)
  }
  for (const name of listing('.github/workflows')) {
    if (/\.(ya?ml)$/.test(name)) files.push(`.github/workflows/${name}`)
  }
  return files
}

function dockerfiles() {
  const found = []
  const directories = [
    '.',
    ...listing('apps').map((n) => `apps/${n}`),
    ...listing('packages').map((n) => `packages/${n}`),
  ]
  for (const directory of directories) {
    let entries
    try {
      entries = readdirSync(join(ROOT, directory), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile() || !basename(entry.name).startsWith('Dockerfile')) continue
      found.push(directory === '.' ? entry.name : `${directory}/${entry.name}`)
    }
  }
  return found
}

const moving = new Set(policy.movingTags ?? [])

/** `postgres:16-alpine` -> `{ repository, tag, digest }`; a registry host and port survive intact. */
function parseImageReference(reference) {
  const [withoutDigest, digest] = reference.split('@')
  const slash = withoutDigest.lastIndexOf('/')
  const colon = withoutDigest.lastIndexOf(':')
  const hasTag = colon > slash
  return {
    repository: hasTag ? withoutDigest.slice(0, colon) : withoutDigest,
    tag: hasTag ? withoutDigest.slice(colon + 1) : undefined,
    digest,
  }
}

function checkImage(where, line, reference) {
  const { repository, tag } = parseImageReference(reference)
  if (tag === undefined || moving.has(tag)) {
    problems.push(
      `${where}:${line}  [unpinned-image-tag] \`${reference}\` ` +
        `${tag === undefined ? 'has no tag' : `is pinned to the moving tag \`${tag}\``} — the image ` +
        'CI runs and the image that was reviewed are then different bytes',
    )
    return
  }
  const declared = policy.images?.[repository]
  if (declared === undefined) {
    problems.push(
      `${where}:${line}  [undeclared-image] \`${repository}\` is not in ${POLICY_PATH} — a new base ` +
        'image is a reviewed decision, not a line in a compose file',
    )
    return
  }
  if (declared.tag !== tag) {
    problems.push(
      `${where}:${line}  [image-tag-drift] \`${repository}:${tag}\` but ${POLICY_PATH} declares ` +
        `\`${declared.tag}\` — one of the two places that name this image was changed and the other was not`,
    )
  }
  if (/(^|\/)postgres$/.test(repository)) {
    const major = tag.split(/[.-]/)[0]
    if (major !== policy.postgresMajor) {
      problems.push(
        `${where}:${line}  [postgres-major-mismatch] \`${reference}\` is major ${major}; the ` +
          `DigitalOcean managed database is major ${policy.postgresMajor}. Every migration and drift ` +
          'check would then be validated against an engine this system does not deploy on.',
      )
    }
  }
}

let imageReferences = 0
for (const file of composeAndWorkflowFiles()) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  for (const [index, line] of text.split('\n').entries()) {
    const match = line.match(/^\s*image:\s*['"]?([^'"#\s]+)['"]?/)
    if (match === null) continue
    imageReferences += 1
    checkImage(file, index + 1, match[1])
  }
}

// --- Dockerfiles: no subject yet, but the rules are live ---------------------------------------------

const declaredDockerfiles = policy.dockerfiles ?? []
for (const entry of declaredDockerfiles) {
  const exists = existsSync(join(ROOT, entry.path))
  if (exists && entry.status === 'not-yet-created') {
    problems.push(
      `${entry.path}  [dockerfile-appeared] ${POLICY_PATH} still records this as \`not-yet-created\` ` +
        `for ${entry.unit}. The commit that adds it owns updating the policy and enabling the image ` +
        'vulnerability scan, which is deferred only for as long as there is no image.',
    )
  }
  if (!exists && entry.status !== 'not-yet-created') {
    problems.push(
      `${entry.path}  [declared-dockerfile-missing] ${POLICY_PATH} records status ` +
        `\`${entry.status}\` but the file is not there`,
    )
  }
}

for (const file of dockerfiles()) {
  if (!declaredDockerfiles.some((entry) => entry.path === file)) {
    problems.push(
      `${file}  [dockerfile-not-declared] this image is not listed in ${POLICY_PATH} — every image ` +
        'the build produces has to be a reviewed one, with an owner',
    )
  }
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
  let lastUser
  let lastUserLine = 0
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/#.*$/, '').trim()
    const from = line.match(/^FROM\s+(\S+)/i)
    if (from !== null) {
      const { repository, tag, digest } = parseImageReference(from[1])
      if (tag === undefined || moving.has(tag)) {
        problems.push(
          `${file}:${index + 1}  [unpinned-base-image] \`${from[1]}\` ` +
            `${tag === undefined ? 'has no tag' : `uses the moving tag \`${tag}\``}`,
        )
      } else if (policy.requireBaseImageDigest === true && digest === undefined) {
        problems.push(
          `${file}:${index + 1}  [unpinned-base-image] \`${repository}:${tag}\` has no ` +
            '`@sha256:` digest. A tag is mutable, so the image that was scanned and the image that ' +
            'ships are not the same bytes.',
        )
      }
      // A new stage resets the user: only the final stage's USER decides what the container runs as.
      lastUser = undefined
      continue
    }
    const user = line.match(/^USER\s+(\S+)/i)
    if (user !== null) {
      lastUser = user[1]
      lastUserLine = index + 1
    }
    const copy = line.match(/^(?:COPY|ADD)\s+(.*)$/i)
    if (copy !== null && /(^|[\s"'/])\.env(\.|\s|$|["'])/.test(copy[1])) {
      problems.push(
        `${file}:${index + 1}  [env-file-copied-into-image] an image layer is immutable and readable ` +
          'by anyone who can pull it; a credential copied in cannot be removed by a later layer',
      )
    }
  }
  if (lastUser === undefined) {
    problems.push(
      `${file}  [container-runs-as-root] the final stage sets no \`USER\`, so the container runs as ` +
        'root and a process escape owns the host namespace it was given',
    )
  } else if (/^(root|0)$/.test(lastUser)) {
    problems.push(
      `${file}:${lastUserLine}  [container-runs-as-root] the final stage sets \`USER ${lastUser}\``,
    )
  }
}

// ADR 0003. If the compose file and the workflow were renamed, every rule above would examine nothing
// and this gate would print a clean result — which is the exact failure ADR 0002 records.
if (imageReferences === 0) {
  problems.push(
    '[no-container-surface] no `image:` reference was found in any compose file or workflow. This ' +
      'repository runs PostgreSQL in both, so the scan found nothing rather than nothing being wrong.',
  )
}

if (problems.length > 0) {
  console.error('Container policy violations:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\n${problems.length} problem(s) against ${POLICY_PATH}.`)
  process.exit(1)
}

const scanning = policy.imageVulnerabilityScanning ?? {}
const found = dockerfiles()
console.log(
  `Container policy clear: ${imageReferences} image reference(s) across ` +
    `${composeAndWorkflowFiles().length} compose/workflow file(s), all pinned and on PostgreSQL ` +
    `major ${policy.postgresMajor}; ${found.length} Dockerfile(s) present of ` +
    `${declaredDockerfiles.length} declared. Image vulnerability scanning: ${scanning.status} ` +
    `(${scanning.unit}).`,
)

// Deliberately not silent: a deferral that stops being visible stops being a deferral.
if (scanning.status === 'deferred') {
  console.log(`  NOTE: ${scanning.reason}`)
}
