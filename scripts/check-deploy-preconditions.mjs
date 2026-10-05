#!/usr/bin/env node
/**
 * The check that stands between a written app spec and a production deployment.
 *
 * ## Why this is a separate script and not a paragraph in the runbook
 *
 * `.do/app.production.yaml` is a complete, applyable spec. The moment one exists, the distance between
 * "we have the artefacts" and "it is live" is one `doctl apps create`, and the five things `pnpm go-no-go`
 * refuses on are not things a deploy fixes — they are facts about the business: unresolved open questions,
 * an undemonstrated milestone, no penetration test, an unconfirmed restore-drill age, unconfirmed
 * provisional settings. ADR 0002's rule applies to deployment as much as to a gate: a check that examined
 * nothing is worse than no check, and a runbook paragraph saying "make sure go/no-go passes" is a check
 * that examines nothing.
 *
 * So this runs the real one, adds the two preconditions that are about the DEPLOYMENT rather than the
 * business, and exits non-zero. It is the thing `pnpm deploy:preflight` runs.
 *
 * ## What it adds on top of go/no-go
 *
 *  - **`Y5-residency`.** DigitalOcean has no UAE region and ADR 0010 records that UAE Federal Law 2 of 2019
 *    may prohibit storing health data outside the country. The licence classification that decides whether
 *    the rule applies is open. A region slug in a spec is not an answer to that, and nothing in this
 *    repository may choose a jurisdiction on the owner's behalf — so an open `Y5-residency` refuses a
 *    PRODUCTION target and says nothing about staging, which holds no real record.
 *  - **The specs are the ones the application can boot.** Every `key:` in a spec's `envs` is held against
 *    `packages/config/src/env.ts`, in one direction: a key the schema does not declare is a key
 *    `parseConfig` will ignore and somebody will believe is in effect. The other direction is not an error
 *    — the schema declares many optional secrets the spec deliberately omits.
 *  - **No secret value is in a committed spec.** Brief rule 15: a placeholder is indistinguishable from a
 *    configured value. `type: SECRET` with a literal in a file in git is refused by name.
 *
 * ## What it deliberately does not do
 *
 * It does not talk to DigitalOcean. It needs no token, runs offline, and refuses on repository facts —
 * which is also why it is NOT in `pnpm verify`: a developer verifying a unit is not deploying, and
 * `go-no-go` reads the database.
 *
 * Usage: `node scripts/check-deploy-preconditions.mjs [--target staging|production]`
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')

const flag = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const TARGET = flag('target', 'production')
if (TARGET !== 'staging' && TARGET !== 'production') {
  console.error(`--target must be \`staging\` or \`production\`, not \`${TARGET}\``)
  process.exit(2)
}

const SPEC = TARGET === 'production' ? '.do/app.production.yaml' : '.do/app.staging.yaml'
const problems = []
const notes = []

/*
 * The spec is read as text and not parsed as YAML. There is no YAML dependency in this workspace and the
 * three things checked here are line-shaped: a `- key: NAME` entry, a `type: SECRET` beside a `value:`
 * that is not a `${...}` binding, and the target's own `name:`. A parser would be a supply-chain surface
 * behind a deployment check, which is the trade `docs/runbooks/_schema.json` makes for the same reason.
 */
const spec = readFileSync(join(ROOT, SPEC), 'utf8')
const specLines = spec.split('\n')

const declaredEnvKeys = new Set()
for (const [index, raw] of specLines.entries()) {
  const key = raw.match(/^\s*-\s*key:\s*([A-Z][A-Z0-9_]*)\s*$/)
  if (key !== null) declaredEnvKeys.add(key[1])

  if (/^\s*type:\s*SECRET\s*$/.test(raw)) {
    // The value belongs to the same entry, so look forward to the next `- key:` and no further.
    for (let at = index + 1; at < specLines.length; at += 1) {
      if (/^\s*-\s*key:/.test(specLines[at])) break
      const value = specLines[at].match(/^\s*value:\s*(.+?)\s*$/)
      if (value === null) continue
      if (/^\$\{[^}]+\}$/.test(value[1])) break
      problems.push(
        `${SPEC}:${at + 1}  [secret-literal-in-committed-spec] a \`type: SECRET\` entry carries the ` +
          `literal \`${value[1]}\`. A placeholder in a committed spec is indistinguishable from a ` +
          'configured value, and a real one is a credential in git. Secrets are set on the app — ' +
          '.do/README.md §4.',
      )
      break
    }
  }
}

/*
 * A platform binding (`${db.DATABASE_URL}`, `${APP_URL}`) scoped to BUILD time.
 *
 * This rule exists because the failure is silent and expensive. App Platform does not interpolate a
 * binding at build time: the value arrives as the literal `${...}` text, or as nothing. Measured twice on
 * the first live deploy — `DATABASE_URL` reached `next build` as the nine characters `${db.DATABASE_URL}`
 * and the build died collecting page data, and `SITE_ORIGIN=${APP_URL}` quietly fell back to the LIVE
 * DOMAIN, so the staging site served `rel="canonical" href="https://berelaxmassage.com/"` and asked
 * Google to index production copies of unreviewed pages. The first failure is loud and costs a build; the
 * second is silent and costs the thing the site is for.
 *
 * So a binding may be `RUN_TIME` and nothing else. A value the BUILD needs has to be a literal in the
 * spec, or a secret set on the app — and `.do/README.md` makes that a step of creating the app.
 */
for (const [index, raw] of specLines.entries()) {
  if (!/^\s*scope:\s*(?:RUN_AND_)?BUILD_TIME\s*$/.test(raw)) continue
  // The value belongs to the same entry, so look forward to the next `- key:` and no further.
  for (let at = index + 1; at < specLines.length; at += 1) {
    if (/^\s*-\s*key:/.test(specLines[at])) break
    const value = specLines[at].match(/^\s*value:\s*(.+?)\s*$/)
    if (value === null) continue
    if (!/\$\{[^}]+\}/.test(value[1])) break
    problems.push(
      `${SPEC}:${at + 1}  [binding-scoped-to-build-time] \`${value[1]}\` is a platform binding scoped ` +
        'to build time, and App Platform does not interpolate one there — the build gets the literal ' +
        '`${...}` text or nothing at all. Scope the binding to RUN_TIME and give the build a literal, or ' +
        'a secret set on the app (.do/README.md §4).',
    )
    break
  }
}

if (declaredEnvKeys.size === 0) {
  // ADR 0003's floor: if the spec were renamed or its shape changed, every rule above would examine
  // nothing and this check would print a clean result.
  problems.push(
    `${SPEC}  [spec-declares-no-environment] no \`- key: NAME\` entry was found, so the rules that read ` +
      'this spec examined nothing',
  )
}

const envSchema = readFileSync(join(ROOT, 'packages/config/src/env.ts'), 'utf8')
/** Everything the schema declares, plus the keys the PLATFORM owns rather than the application. */
const PLATFORM_OWNED = new Set([
  // App Platform sets PORT from `http_port`; `next start` reads it and `parseConfig` has no business
  // declaring a value the platform assigns.
  'PORT',
  // Read by `apps/web/payload.config.ts` directly and deliberately not in the config schema: the public
  // site must render without it, which is why `assertPayloadSecretConfigured()` is at the two admin entry
  // points instead of in `parseConfig`.
  'PAYLOAD_SECRET',
  // `siteOrigin()` in `@berelax/shared` validates this one, and it is outside the config schema on purpose:
  // `alternates.ts` is imported by page metadata and by `registry.test.ts`, and `loadConfig()` throws
  // without a validated `APP_ENV`. Two leaf readers with one rule rather than a key in `@berelax/config`.
  'SITE_ORIGIN',
])
/*
 * The schema's own keys, read off its object literal: four spaces of indentation, a SCREAMING_SNAKE name, a
 * colon and a validator. Matching `z.` specifically would have been wrong and was — the seven provider modes
 * are declared as `providerMode.default('fake')`, so a rule keyed on `z.` reported every one of them as
 * undeclared. The indentation is the schema's shape and a nested object would be deeper.
 */
const schemaKeys = new Set(
  [...envSchema.matchAll(/^ {4}([A-Z][A-Z0-9_]*):\s*\S/gm)].map((match) => match[1]),
)
if (schemaKeys.size === 0) {
  problems.push(
    'packages/config/src/env.ts  [config-schema-unreadable] no declared key was found in the schema ' +
      'object, so the rule holding the spec against it examined nothing (ADR 0003)',
  )
}
for (const key of [...declaredEnvKeys].sort()) {
  if (PLATFORM_OWNED.has(key)) continue
  if (schemaKeys.has(key)) continue
  problems.push(
    `${SPEC}  [spec-sets-an-undeclared-key] the spec sets \`${key}\` and ` +
      'packages/config/src/env.ts does not declare it, so `parseConfig` ignores it and somebody will ' +
      'believe it is in effect',
  )
}

if (TARGET === 'production') {
  /*
   * `Y5-residency`, read out of the open-questions table rather than restated here. The row's status column
   * is the fourth pipe-delimited field; `open` there means nobody has answered it.
   */
  const questions = readFileSync(join(ROOT, 'docs/OPEN-QUESTIONS.md'), 'utf8')
  const row = questions.split('\n').find((line) => line.startsWith('| Y5-residency '))
  if (row === undefined) {
    problems.push(
      '[residency-question-not-found] docs/OPEN-QUESTIONS.md has no `Y5-residency` row. It is the ' +
        'question that decides whether this data may sit outside the UAE, and a check that cannot find ' +
        'it has not confirmed anything (ADR 0010).',
    )
  } else if (/\|\s*open\s*\|/.test(row)) {
    problems.push(
      '[data-residency-unresolved] `Y5-residency` is open. DigitalOcean has no UAE region, and ADR 0010 ' +
        'records that UAE Federal Law 2 of 2019 may prohibit storing health data outside the country — ' +
        'the licence classification that decides whether the rule applies to this business is the open ' +
        'question. A region slug in an app spec is not an answer to it. The clinical schema is isolated ' +
        'so it can move to a UAE-hosted database in about a week; that is the mitigation, not the answer.',
    )
  } else {
    notes.push('`Y5-residency` is no longer open — read the answer before trusting this line.')
  }

  /*
   * And the real thing. `go-no-go` reads the database and takes a few seconds; its exit code is the
   * verdict and its stdout is the five reasons, which are reproduced rather than summarised because a
   * summary of a refusal is how a refusal becomes a formality.
   */
  let goNoGo
  try {
    goNoGo = execFileSync('node', [join(ROOT, 'scripts/go-no-go.mjs')], { encoding: 'utf8' })
    notes.push('`pnpm go-no-go` says go.')
  } catch (error) {
    goNoGo = `${error.stdout ?? ''}${error.stderr ?? ''}`
    // `go-no-go` prints one `MET`/`UNMET`/`UNKNOWN` line per requirement and then its verdict. Only the
    // first two kinds are reproduced: a refusal's reasons, not its full report.
    const verdict = goNoGo.split('\n').filter((line) => /^\s*(UNMET|UNKNOWN)\s|^VERDICT/.test(line))
    problems.push(
      '[go-no-go-refuses] `pnpm go-no-go` does not say go, and nothing it refuses on can be fixed by a ' +
        'deploy:\n' +
        (verdict.length > 0
          ? verdict.map((line) => `      ${line.trim()}`).join('\n')
          : `      ${goNoGo.trim()}`),
    )
  }
}

if (problems.length > 0) {
  console.error(`Deployment preconditions for \`${TARGET}\` — ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  ${problem}\n`)
  console.error(
    'None of this is a reason the spec is wrong. It is the distance between an applyable spec and a\n' +
      'defensible release, and closing it is a decision somebody takes deliberately. .do/README.md §1\n' +
      'says what overriding looks like and what it means.',
  )
  process.exit(1)
}

const leafOwned = [...declaredEnvKeys].filter((key) => PLATFORM_OWNED.has(key)).sort()
console.log(
  `Deployment preconditions clear for \`${TARGET}\`: ${declaredEnvKeys.size} environment key(s) in ` +
    `${SPEC}, no secret literal in a committed spec. ` +
    `${declaredEnvKeys.size - leafOwned.length} held against packages/config/src/env.ts` +
    (leafOwned.length === 0
      ? '.'
      : `, and ${leafOwned.join(', ')} read outside that schema by a named reader.`),
)
for (const note of notes) console.log(`  NOTE: ${note}`)
