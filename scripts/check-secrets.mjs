#!/usr/bin/env node
/**
 * Refuses a credential in the repository.
 *
 * **This gate never prints a matched value.** It reports the path, the line, the rule that fired and
 * the length of what it found, and nothing else. A secret scanner that echoes its finding has moved
 * the credential from a file one person can rotate into a CI log, an agent transcript and a terminal
 * scrollback, which is three more copies than existed before it ran. The known-bad fixture in
 * `scripts/test-gates.mjs` asserts this directly: it checks that the gate's output does *not* contain
 * the fixture's value.
 *
 * Two deliberate omissions, because a rule that duplicates another gate makes both harder to trust:
 *
 *  - **Google refresh tokens** (`1//…`) belong to `pnpm chokepoint`, which enforces something
 *    stronger than "not in a file" — that the token is only ever named inside the token modules. The
 *    synthetic `1//09…` fixtures scattered through `packages/google` are the reason that gate exists;
 *    matching their shape here would report thirteen findings that are all correct behaviour.
 *  - **`.env` files.** `.gitignore` refuses to track any of them but `.env.example`, which is
 *    structural and needs no scan. This gate reads the tracked-and-not-ignored file set, so a
 *    developer's real `.env.local` is never opened, let alone reported.
 *
 * The provider patterns are high-confidence shapes only: a prefix plus a length that a credential has
 * and ordinary prose does not. There is one general rule (`high-entropy-assigned-secret`) for the
 * credential nobody anticipated, and it is deliberately narrow — the value must be a *single*
 * consistent encoding, long, high-entropy and free of placeholder vocabulary. A generic rule that
 * fires on `password: 'a-long-enough-test-password'` gets switched off within a week, and then there
 * is no scanner at all.
 *
 * Usage: `node scripts/check-secrets.mjs [--allowlist build/secret-allowlist.json]`
 * The flag exists so the known-bad fixtures can exercise the allowlist's own rules; `pnpm secrets`
 * and CI pass no flags.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const ALLOWLIST_PATH = flag('allowlist', 'build/secret-allowlist.json')

/**
 * Binary and rendered artefacts. A JPEG that happens to contain the bytes `AKIA` followed by sixteen
 * upper-case characters is not a leaked key, and reporting a byte offset inside a photograph is how a
 * gate teaches people to ignore it.
 */
const SKIP_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.avif',
  '.gif',
  '.ico',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.webm',
  '.zip',
  '.gz',
])

/**
 * Each rule is a prefix-and-length shape a real credential has.
 *
 * `where` is the reason, not a restatement: it says which account the credential controls, because
 * the response to a finding is a rotation and the rotation is different for each one.
 */
const RULES = [
  {
    name: 'aws-access-key-id',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    where: 'an AWS access key id; rotate in IAM and check CloudTrail for use',
  },
  {
    name: 'google-oauth-client-secret',
    pattern: /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
    where:
      'a Google OAuth client secret — with the refresh tokens it can mint, this is control of the ' +
      'business Google presence (docs/10 §4)',
  },
  {
    name: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    where: 'a Google API key; restrict or delete it in the Cloud console',
  },
  {
    name: 'github-token',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
    where: 'a GitHub token; it can push to this repository and rewrite CI',
  },
  {
    name: 'slack-token',
    pattern: /\bxox[abprse]-[A-Za-z0-9-]{20,}/g,
    where: 'a Slack token',
  },
  {
    name: 'stripe-secret-key',
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}/g,
    where: 'a Stripe secret key; a live one can move money',
  },
  {
    name: 'resend-api-key',
    pattern: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}/g,
    where: 'a Resend API key; it can send mail as the business domain',
  },
  {
    name: 'digitalocean-access-token',
    pattern: /\bdop_v1_[a-f0-9]{64}\b/g,
    where:
      'a DigitalOcean personal access token — the whole deployment, including the managed database ' +
      'and its backups',
  },
  {
    name: 'anthropic-api-key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{24,}/g,
    where: 'an Anthropic API key; it bills the business account',
  },
  {
    name: 'openai-api-key',
    pattern: /\bsk-proj-[A-Za-z0-9_-]{24,}/g,
    where: 'an OpenAI project key; it bills the business account',
  },
  {
    name: 'meta-graph-access-token',
    pattern: /\bEAA[A-Za-z0-9]{60,}/g,
    where: 'a Meta Graph access token; it can send WhatsApp messages as the business number',
  },
  {
    name: 'private-key-block',
    pattern: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g,
    where: 'a private key. Whatever it signs or decrypts must be treated as compromised',
  },
  {
    name: 'json-web-token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
    where: 'a signed JWT; it is a bearer credential until it expires',
  },
]

/**
 * A database URL carrying a password, where the host is reachable.
 *
 * A loopback host is exempt **structurally**, not by allowlist: `postgres://berelax:berelax@127.0.0.1`
 * appears in `.env.example`, in the CI workflow and in the agent brief because it is the documented
 * local development credential, and a credential for a database nobody outside the machine can reach
 * is not a secret. Exempting those three paths instead would have exempted every future real
 * credential that lands in them. What this catches is the shape that matters here: a DigitalOcean
 * managed-database URL, whose host is public and whose password is the whole database.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'])
const DATABASE_URL =
  /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/([^:/\s'"`]+):([^@/\s'"`]+)@([^:/\s'"`?]+)/g

/** Placeholder vocabulary. A value containing any of these is a fixture, not a credential. */
const PLACEHOLDER =
  /fake|test|example|sample|dummy|placeholder|changeme|redacted|never|your-|xxx|0000|todo|fixture|synthetic/i

const IDENTIFIER =
  /(secret|password|passwd|api[_-]?key|apikey|token|credential|private[_-]?key|access[_-]?key|auth[_-]?key)/i

/** Single-encoding value shapes. A real credential is one encoding; `1//09-a_b` is three. */
const ENCODINGS = [/^[A-Za-z0-9+/]{24,}={0,2}$/, /^[A-Za-z0-9_-]{24,}$/, /^[a-f0-9]{32,}$/]

/** Shannon entropy in bits per character. 4.0 is roughly the floor for random base64. */
function entropy(value) {
  const counts = new Map()
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }
  return bits
}

const looksLikeACredential = (value) =>
  ENCODINGS.some((encoding) => encoding.test(value)) &&
  !PLACEHOLDER.test(value) &&
  entropy(value) >= 4

const ASSIGNED_QUOTED = /([A-Za-z0-9_$.-]*)\s*[:=]\s*(?:'([^'\n]+)'|"([^"\n]+)"|`([^`\n]+)`)/g
const ASSIGNED_ENV = /^\s*export\s+([A-Z0-9_]+)=(\S+)\s*$|^\s*([A-Z0-9_]+)=(\S+)\s*$/

function scanLine(file, lineNumber, line, findings) {
  for (const rule of RULES) {
    for (const match of line.matchAll(rule.pattern)) {
      findings.push({ file, line: lineNumber, rule: rule.name, length: match[0].length })
    }
  }

  for (const match of line.matchAll(DATABASE_URL)) {
    if (LOOPBACK_HOSTS.has(match[4])) continue
    findings.push({
      file,
      line: lineNumber,
      rule: 'database-url-with-password',
      length: match[3].length,
      detail: `scheme ${match[1]}, host ${match[4]}`,
    })
  }

  for (const match of line.matchAll(ASSIGNED_QUOTED)) {
    const value = match[2] ?? match[3] ?? match[4]
    if (!IDENTIFIER.test(match[1]) || value === undefined) continue
    if (!looksLikeACredential(value)) continue
    findings.push({
      file,
      line: lineNumber,
      rule: 'high-entropy-assigned-secret',
      length: value.length,
      detail: `assigned to ${match[1]}`,
    })
  }

  const env = line.match(ASSIGNED_ENV)
  const envName = env?.[1] ?? env?.[3]
  const envValue = env?.[2] ?? env?.[4]
  if (envName !== undefined && envValue !== undefined && IDENTIFIER.test(envName)) {
    if (looksLikeACredential(envValue)) {
      findings.push({
        file,
        line: lineNumber,
        rule: 'high-entropy-assigned-secret',
        length: envValue.length,
        detail: `assigned to ${envName}`,
      })
    }
  }
}

/** Tracked files plus untracked-but-not-ignored ones, so a fixture written into the tree is scanned. */
function scannableFiles() {
  const listed = execFileSync(
    'git',
    ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  return listed
    .split('\0')
    .filter((path) => path !== '')
    .filter((path) => !SKIP_EXTENSIONS.has(extname(path).toLowerCase()))
}

const allowlist = JSON.parse(readFileSync(join(ROOT, ALLOWLIST_PATH), 'utf8'))
const entries = allowlist.entries ?? []
const problems = []

// An exemption with no stated reason is an exemption nobody can review, and the next person to read it
// has to guess whether the credential was fake or merely old.
for (const [index, entry] of entries.entries()) {
  const at = `${ALLOWLIST_PATH}[${index}]`
  if (typeof entry.rule !== 'string' || typeof entry.path !== 'string') {
    problems.push(`${at}  [malformed-allowlist-entry] needs both \`rule\` and \`path\``)
  }
  if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) {
    problems.push(
      `${at}  [allowlist-entry-without-reason] \`${entry.rule ?? '?'}\` on \`${entry.path ?? '?'}\`` +
        ' needs a reason a reviewer can disagree with',
    )
  }
}

const files = scannableFiles()
const findings = []
for (const file of files) {
  let text
  try {
    text = readFileSync(join(ROOT, file), 'utf8')
  } catch {
    continue
  }
  if (text.includes('\0')) continue
  for (const [index, line] of text.split('\n').entries()) {
    scanLine(file, index + 1, line, findings)
  }
}

const exempt = (finding) =>
  entries.some((entry) => entry.rule === finding.rule && entry.path === finding.file)
const live = findings.filter((finding) => !exempt(finding))

// A stale exemption is worse than no exemption: it silently covers whatever lands in that path next.
for (const [index, entry] of entries.entries()) {
  if (!findings.some((finding) => finding.rule === entry.rule && finding.file === entry.path)) {
    problems.push(
      `${ALLOWLIST_PATH}[${index}]  [stale-allowlist-entry] \`${entry.rule}\` no longer fires on ` +
        `\`${entry.path}\` — delete the entry`,
    )
  }
}

for (const finding of live) {
  const rule = RULES.find((candidate) => candidate.name === finding.rule)
  problems.push(
    `${finding.file}:${finding.line}  [${finding.rule}] ${finding.length} characters` +
      `${finding.detail === undefined ? '' : ` (${finding.detail})`}` +
      `${rule === undefined ? '' : ` — ${rule.where}`}`,
  )
}

// ADR 0003's failure mode: a scan that examined nothing reports success. `git ls-files` returning an
// empty list — wrong working directory, a broken checkout — must fail rather than pass.
if (files.length < 100) {
  problems.push(
    `[nothing-scanned] only ${files.length} files were readable; this repository has hundreds`,
  )
}

if (problems.length > 0) {
  console.error('Credential scan failed:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    `\n${problems.length} problem(s). The matched values are deliberately not printed: a leaked ` +
      'credential must be rotated, and echoing it here would put another copy in the CI log.',
  )
  process.exit(1)
}

console.log(
  `No credentials in ${files.length} scannable files: ${RULES.length + 2} rules, ` +
    `${entries.length} allowlist entr${entries.length === 1 ? 'y' : 'ies'}.`,
)
