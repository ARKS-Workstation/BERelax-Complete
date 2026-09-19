#!/usr/bin/env node
/**
 * Container policy: the part of container scanning that can be done without an image.
 *
 * **`apps/worker/Dockerfile` exists now.** H-HARD-02 deferred image vulnerability scanning to W-SYS-06,
 * because scanning an image's OS packages for CVEs needs an image and there was none; that unit wrote the
 * Dockerfile, so `build/container-policy.json` records the image, every component it conveys, and an
 * enabled Trivy scan as a CI job. This gate still runs offline and holds only the rules that need no
 * image — the scan itself stays out of `pnpm verify`, which runs on every unit by every agent and must not
 * depend on the network or on a Docker daemon. What this gate asserts about the scan is that it is
 * *declared and wired*, which is the half a static check can prove.
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
 * The Dockerfile rules were written and live before there was a Dockerfile, with known-bad fixtures
 * proving they fire, so the first one was held to them on the commit that added it rather than six months
 * later.
 *
 * ## What an image *conveys*, and why that is a container question rather than an npm one
 *
 * `scripts/check-licences.mjs` reads `pnpm-lock.yaml` and classifies npm packages. Two of the most
 * consequential licences in this product are outside that graph: ffmpeg is an operating-system package,
 * and libvips arrives inside a prebuilt binary package that ships **no copy of its own LGPL text**. Both
 * are copyleft, both are conveyed in the worker image, and the obligation each one carries is about what is
 * *in the image* — a licence text and a written offer — which is precisely the thing a lockfile scan cannot
 * see. So `imageComponents` in the policy declares them with their obligation, and four rules here make
 * that declaration mechanical rather than a paragraph: a package installed and not declared, a copyleft
 * component with no obligation written out, a declared component nothing installs, and a notice the
 * Dockerfile has stopped copying into the image.
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

/**
 * Every operating-system package a Dockerfile installs by name.
 *
 * `apt-get install` and `apk add` with their flags stripped: anything beginning with `-` is a flag, and
 * everything after a `&&` belongs to the next command. Transitive dependencies are invisible here by
 * construction — `libx264` arrives because `ffmpeg` depends on it — which is why the policy declares those
 * with `installedBy: "apt-dependency"` and why the staleness rule below only holds directly-named packages
 * to being findable.
 */
function installedPackages(text) {
  const found = new Set()
  const flattened = text.replace(/\\\s*\n/g, ' ')
  for (const match of flattened.matchAll(/\b(?:apt-get\s+install|apk\s+add)\s+([^\n]*)/g)) {
    for (const token of (match[1] ?? '').split(/\s+/)) {
      if (token.length === 0 || token.startsWith('-')) continue
      // The install command ends where the next one begins. Without this, everything in a `&&` chain —
      // `rm`, `-rf`, `/var/lib/apt/lists/*` — is reported as an undeclared package.
      if (token === '&&' || token === ';' || token === '||' || token === '|') break
      found.add(token)
    }
  }
  return [...found]
}

const imageComponents = policy.imageComponents ?? []
const COPYLEFT = new Set(['weakCopyleft', 'strongCopyleft'])

for (const file of dockerfiles()) {
  const declared = declaredDockerfiles.find((entry) => entry.path === file)
  if (declared === undefined) {
    problems.push(
      `${file}  [dockerfile-not-declared] this image is not listed in ${POLICY_PATH} — every image ` +
        'the build produces has to be a reviewed one, with an owner',
    )
  }
  const text = readFileSync(join(ROOT, file), 'utf8')
  const lines = text.split('\n')

  // --- what the image conveys -----------------------------------------------------------------------
  const componentsHere = imageComponents.filter((entry) => entry.dockerfile === file)
  for (const name of installedPackages(text)) {
    if (componentsHere.some((entry) => entry.component === name)) continue
    problems.push(
      `${file}  [image-component-undeclared] the image installs \`${name}\` and ${POLICY_PATH} does not ` +
        'declare it. Every package in a conveyed image is a licence obligation until somebody has said ' +
        'which one — ffmpeg is GPL because of the encoders it is built with, and nothing in a lockfile ' +
        'scan can see an apt package at all.',
    )
  }
  for (const entry of componentsHere) {
    if (COPYLEFT.has(entry.disposition ?? '')) {
      if ((entry.obligation ?? '').trim().length === 0) {
        problems.push(
          `${file}  [image-component-without-licence-obligation] \`${entry.component}\` is declared ` +
            `${entry.licence} (${entry.disposition}) with no \`obligation\`. "It is copyleft" is not a ` +
            'decision; "the image must carry the text and honour the offer to supply the source" is.',
        )
      }
      const textPath = entry.licenceTextInImage
      if (typeof textPath !== 'string' || !text.includes(textPath)) {
        problems.push(
          `${file}  [copyleft-notice-not-copied-into-image] \`${entry.component}\` is ${entry.licence} ` +
            `and its licence text at \`${textPath ?? '(undeclared)'}\` is not named anywhere in this ` +
            'Dockerfile. An obligation to carry a notice is discharged by the image carrying it, so the ' +
            'build has to put it there or assert it is there.',
        )
      }
    }
    if (entry.installedBy === 'apt' && !installedPackages(text).includes(entry.component)) {
      // The stale-exemption shape, and the dangerous direction: an entry that no longer covers anything
      // silently covers whatever arrives under that name next.
      problems.push(
        `${file}  [declared-image-component-not-installed] ${POLICY_PATH} declares \`${entry.component}\` ` +
          'as installed by apt and this Dockerfile does not install it — the declaration, and the licence ' +
          'obligation attached to it, now describe an image that does not exist',
      )
    }
  }

  // The written offer and the notice itself, which is what makes an obligation discharged rather than
  // recorded. Only demanded of an image that conveys something copyleft.
  if (declared !== undefined && componentsHere.some((e) => COPYLEFT.has(e.disposition ?? ''))) {
    for (const key of ['noticeSource', 'noticePathInImage']) {
      const value = declared[key]
      if (typeof value !== 'string' || !text.includes(value)) {
        problems.push(
          `${file}  [copyleft-notice-not-copied-into-image] this image conveys a copyleft component and ` +
            `its \`${key}\` (${value ?? 'undeclared'}) is not named in the Dockerfile. The notice and the ` +
            'offer have to be in the image, not only in the repository.',
        )
      }
    }
    if (
      typeof declared.noticeSource === 'string' &&
      !existsSync(join(ROOT, declared.noticeSource))
    ) {
      problems.push(
        `${file}  [copyleft-notice-not-copied-into-image] \`${declared.noticeSource}\` is the notice this ` +
          'image copies and it is not in the repository, so the COPY would fail at build time',
      )
    }
  }

  // `[env-file-copied-into-image]` reads COPY arguments and cannot see `COPY . .`, which is how an
  // environment file actually reaches a layer. A whole-context copy therefore needs a .dockerignore.
  if (policy.requireDockerignore === true && /^\s*(?:COPY|ADD)\s+\.\s+\S/im.test(text)) {
    const ignorePath = join(ROOT, '.dockerignore')
    const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : undefined
    // Both spellings, because they are different files: `.env` is the one a developer has, `.env.*` is
    // `.env.production` and `.env.local`. Excluding one and not the other has caught nothing.
    const patterns = (ignore ?? '').split('\n').map((line) => line.trim())
    const excludesEnv = patterns.includes('.env') && patterns.includes('.env.*')
    if (!excludesEnv) {
      problems.push(
        `${file}  [dockerignore-does-not-exclude-env] this Dockerfile copies the whole build context and ` +
          `${ignore === undefined ? 'there is no .dockerignore' : '.dockerignore does not exclude `.env` ' + 'and `.env.*`'}. ` +
          'An image layer is immutable and readable by anyone who can pull it, so a credential copied in ' +
          'cannot be removed by a later layer.',
      )
    }
  }

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

/*
 * The image vulnerability scan, once it is no longer deferred.
 *
 * A status of `enabled` is a claim about CI, and a claim nobody checks is how a deferral gets discharged on
 * paper. So the declared workflow file has to exist, has to contain the declared job, and has to run every
 * step the policy names. This is deliberately *not* a scan — it needs an image and a vulnerability database
 * — and it is deliberately not silent either: what can be proven offline is that the wiring is there.
 */
const scanningPolicy = policy.imageVulnerabilityScanning ?? {}
if (scanningPolicy.status === 'enabled') {
  const workflowPath = scanningPolicy.workflowFile
  const workflow =
    typeof workflowPath === 'string' && existsSync(join(ROOT, workflowPath))
      ? readFileSync(join(ROOT, workflowPath), 'utf8')
      : undefined
  if (workflow === undefined) {
    problems.push(
      `[image-scan-not-wired] ${POLICY_PATH} says image vulnerability scanning is enabled and its ` +
        `workflowFile (${workflowPath ?? 'undeclared'}) is not in this repository`,
    )
  } else {
    const missing = [
      ...(typeof scanningPolicy.ciJob === 'string' ? [`${scanningPolicy.ciJob}:`] : []),
      ...(scanningPolicy.requiredSteps ?? []),
    ].filter((needle) => !workflow.includes(needle))
    if (missing.length > 0) {
      problems.push(
        `[image-scan-not-wired] ${workflowPath} is missing ${missing.join(', ')} — the policy records the ` +
          'scan as enabled and H-HARD-02 deferred it only for as long as there was no image, so a status ' +
          'of `enabled` with nothing running is worse than the deferral it replaced',
      )
    }
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
const copyleft = imageComponents.filter((entry) => COPYLEFT.has(entry.disposition ?? ''))
console.log(
  `Container policy clear: ${imageReferences} image reference(s) across ` +
    `${composeAndWorkflowFiles().length} compose/workflow file(s), all pinned and on PostgreSQL ` +
    `major ${policy.postgresMajor}; ${found.length} Dockerfile(s) present of ` +
    `${declaredDockerfiles.length} declared. Image vulnerability scanning: ${scanning.status} ` +
    `(${scanning.unit}).`,
)
console.log(
  `  ${imageComponents.length} declared image component(s), ${copyleft.length} copyleft: ` +
    `${copyleft.map((entry) => `${entry.component} ${entry.licence}`).join(', ') || 'none'} — each with ` +
    'its obligation written out and its licence text asserted in the build.',
)

// Deliberately not silent: a deferral that stops being visible stops being a deferral.
if (scanning.status === 'deferred') {
  console.log(`  NOTE: ${scanning.reason}`)
}
for (const entry of declaredDockerfiles) {
  // An image nobody has built is a reviewed Dockerfile and not a tested one, and saying so on every run is
  // the only thing that stops the distinction being quietly lost.
  if (typeof entry.unverified === 'string')
    console.log(`  NOTE: ${entry.path} — ${entry.unverified}`)
}
