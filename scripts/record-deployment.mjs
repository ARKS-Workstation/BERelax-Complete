#!/usr/bin/env node
/**
 * Records what was deployed, and refuses to invent any of it.
 *
 * `artifacts/release/deployments.json` says why this exists: a production App Platform app ran from
 * 2026-10-05, created the first CMS account and the first staff credential, and five weeks later the
 * account held no app and no database — with nothing in the repository naming the app, its URL or the
 * commit it served. The DigitalOcean API does not list deleted apps, so that is unanswerable now.
 *
 * ## Two modes, and the second is the one that makes the first worth having
 *
 *   `--record`  appends an entry. Every field is required and none is derived from a guess.
 *   `--verify`  refuses a register that has been hand-edited into something untrue.
 *
 * A register nothing checks is a file that drifts, which is ADR 0003's subject: the known-bad fixtures
 * for the rules below are in `scripts/test-gates.mjs`, not in this header.
 *
 * ## What it will not do
 *
 * It does not read the live estate and write what it finds. That sounds better and is worse: a recorder
 * that discovered the URL would be the only thing asserting the URL, and on the day it is wrong there is
 * nothing to compare it against. A person states what they deployed; this checks the parts it can
 * (the commit is in this history, the instant parses, the URL is https, the target is not already live
 * under a different commit) and stores the rest verbatim.
 *
 * It also never deletes an entry. `--retire` sets `retired` with an instant and a reason, and the row
 * stays — the whole value of this file is that it holds a row for something that no longer exists.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const REGISTER = 'artifacts/release/deployments.json'
const ROLES = ['owner', 'manager', 'accountant', 'receptionist', 'therapist', 'auditor', 'system']

const flag = (name) => {
  const at = process.argv.indexOf(`--${name}`)
  return at !== -1 && process.argv[at + 1] !== undefined ? process.argv[at + 1] : null
}
const has = (name) => process.argv.includes(`--${name}`)

const USAGE = `
record-deployment — the deployment register

  pnpm deployment:record -- --target <id> --url <https url> --commit <sha> \\
                            --platform <name> --by <f07 role> [--note "..."]
  pnpm deployment:retire -- --target <id> --reason "..."
  pnpm deployment:verify

  --target     The thing deployed to, as the platform names it: an App Platform app id, a droplet id,
               or "<droplet-id>/<compose project>" for one instance among several on a host.
  --url        The origin it actually serves. https, no trailing slash.
  --commit     The commit deployed. Must be in this repository's history.
  --platform   app-platform | droplet | other
  --by         The F07 role of the person recording it. Not a name (brief rule 10).
  --note       Anything a reader will want and cannot derive.
`

function load() {
  const text = readFileSync(REGISTER, 'utf8')
  const data = JSON.parse(text)
  if (!Array.isArray(data.deployments)) {
    console.error(`${REGISTER}: "deployments" is not an array.`)
    process.exit(1)
  }
  return data
}

const save = (data) => writeFileSync(REGISTER, `${JSON.stringify(data, null, 2)}\n`)

/** True when the sha names a commit in THIS history. A deployment of something unreachable is a typo. */
function inHistory(sha) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// --- verify ------------------------------------------------------------------------------------------

if (has('verify') || process.argv.length === 2) {
  const data = load()
  const problems = []
  const seen = new Set()

  for (const [index, entry] of data.deployments.entries()) {
    const at = `deployments[${index}]`
    for (const key of ['target', 'url', 'commit', 'platform', 'recordedBy', 'recordedAt']) {
      if (typeof entry[key] !== 'string' || entry[key] === '')
        problems.push(`${at}.${key} is missing`)
    }
    if (typeof entry.url === 'string' && !entry.url.startsWith('https://')) {
      problems.push(`${at}.url is not https`)
    }
    if (typeof entry.url === 'string' && entry.url.endsWith('/')) {
      problems.push(`${at}.url has a trailing slash, so it will not compare equal to SITE_ORIGIN`)
    }
    if (typeof entry.commit === 'string' && entry.commit !== '' && !inHistory(entry.commit)) {
      // A shallow clone legitimately cannot see an old commit, so this names that possibility rather
      // than asserting a lie. It is still a refusal: an unverifiable register is not a verified one.
      problems.push(
        `${at}.commit ${entry.commit} is not an ancestor of HEAD — a typo, or a shallow clone ` +
          '(fetch more history and re-run before believing this one)',
      )
    }
    if (typeof entry.recordedAt === 'string' && Number.isNaN(Date.parse(entry.recordedAt))) {
      problems.push(`${at}.recordedAt does not parse`)
    }
    if (entry.recordedBy !== undefined && !ROLES.includes(entry.recordedBy)) {
      problems.push(`${at}.recordedBy "${entry.recordedBy}" is not one of the eight F07 roles`)
    }
    if (entry.retired !== undefined) {
      if (typeof entry.retired?.at !== 'string' || typeof entry.retired?.reason !== 'string') {
        problems.push(`${at}.retired needs both an "at" and a "reason"`)
      }
    } else {
      // Two LIVE entries for one target is the state that makes the register useless: it no longer says
      // what is running. Retiring the old one is the act this refusal requires somebody to perform.
      if (seen.has(entry.target)) {
        problems.push(
          `${at}.target "${entry.target}" is live twice. Retire the superseded entry — a register ` +
            'that names two live deployments of one target answers nothing.',
        )
      }
      seen.add(entry.target)
    }
  }

  if (problems.length > 0) {
    console.error(`${REGISTER} — ${problems.length} problem(s):`)
    for (const p of problems) console.error(`  ${p}`)
    process.exit(1)
  }
  const live = data.deployments.filter((d) => d.retired === undefined)
  console.log(
    `Deployment register: ${data.deployments.length} entr(y|ies), ${live.length} live — ` +
      `${live.map((d) => `${d.target} -> ${d.url}`).join(', ') || 'nothing is recorded as deployed'}.`,
  )
  process.exit(0)
}

// --- retire ------------------------------------------------------------------------------------------

if (has('retire')) {
  const target = flag('target')
  const reason = flag('reason')
  if (target === null || reason === null) {
    console.error('--retire needs --target and --reason.')
    process.exit(1)
  }
  const data = load()
  const entry = data.deployments.find((d) => d.target === target && d.retired === undefined)
  if (entry === undefined) {
    console.error(`No live entry for target "${target}".`)
    process.exit(1)
  }
  entry.retired = { at: new Date().toISOString(), reason }
  save(data)
  console.log(`Retired ${target}. The entry stays; that is the point of the register.`)
  process.exit(0)
}

// --- record ------------------------------------------------------------------------------------------

const target = flag('target')
const url = flag('url')
const commit = flag('commit')
const platform = flag('platform')
const by = flag('by')

if (target === null || url === null || commit === null || platform === null || by === null) {
  console.error(USAGE)
  process.exit(1)
}
if (!url.startsWith('https://') || url.endsWith('/')) {
  console.error(
    '--url must be https and must not end in a slash (it is compared against SITE_ORIGIN).',
  )
  process.exit(1)
}
if (!['app-platform', 'droplet', 'other'].includes(platform)) {
  console.error('--platform must be app-platform, droplet or other.')
  process.exit(1)
}
if (!ROLES.includes(by)) {
  console.error(`--by must be one of the eight F07 roles: ${ROLES.join(', ')}.`)
  process.exit(1)
}
if (!inHistory(commit)) {
  console.error(`--commit ${commit} is not an ancestor of HEAD. Nothing was recorded.`)
  process.exit(1)
}

const data = load()
if (data.deployments.some((d) => d.target === target && d.retired === undefined)) {
  console.error(
    `"${target}" already has a live entry. Retire it first:\n` +
      `  pnpm deployment:retire -- --target ${target} --reason "..."`,
  )
  process.exit(1)
}

const resolved = execFileSync('git', ['rev-parse', commit], { encoding: 'utf8' }).trim()
const note = flag('note')
data.deployments.push({
  target,
  platform,
  url,
  commit: resolved,
  recordedBy: by,
  recordedAt: new Date().toISOString(),
  ...(note === null ? {} : { note }),
})
save(data)
console.log(`Recorded ${platform} deployment of ${resolved.slice(0, 7)} at ${url} (${target}).`)
console.log('Commit this file: the register is only evidence once it is in the history.')
