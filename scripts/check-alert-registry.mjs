#!/usr/bin/env node
/**
 * The alert registry is checkable or it is a document.
 *
 * `ALERT_REGISTRY` in `packages/shared/src/alerts/registry.ts` is the table the alerting path reads. A
 * table that only the alerting path reads is still better than a document beside it, and it is not
 * enough: every field but the prose is a claim about something OUTSIDE that file, and a claim nothing
 * compares is the port-band comment and the SQLSTATE-class convention all over again — right the day it
 * was written and quietly wrong afterwards.
 *
 * So this gate fails in eight directions, each named, each with a known-bad fixture in gate block 175:
 *
 *  1. `unknown-alert-severity` / `unknown-alert-surface` / `unknown-alert-audience-role` — a value
 *     outside the closed set it claims to come from. An audience naming a role the F07 matrix does not
 *     have is an alert routed to nobody.
 *  2. `alert-runbook-missing` — the `runbook` does not resolve to a heading in `docs/runbooks/`. This is
 *     the acceptance line: "an entry naming an unknown runbook id fails a gate". Same mechanism
 *     `pnpm rotation` uses for `build/secret-inventory.json`, which is the precedent.
 *  3. `structural-threshold-not-stated-there` — a structural threshold's `statedIn` file does not exist
 *     or does not contain the figure. The registry POINTS at the authority for a figure rather than
 *     repeating it; a pointer nothing follows is a repetition with extra steps.
 *  4. `threshold-setting-undeclared` / `threshold-setting-not-provisional` /
 *     `threshold-setting-unbounded` — a setting threshold must be an F09 setting, flagged `provisional`
 *     so it appears on the Unconfirmed Assumptions panel, and BOUNDED. The bound is the load-bearing
 *     one: an alert whose threshold can be set to a million is an alert that can be silenced from a
 *     settings screen with nothing recording that it was.
 *  5. `alert-slo-has-a-target` — any numeric target at all. `AlertSlo.target` is typed `null` and not
 *     `number | null`, so the TYPE is the primary enforcement and this is the backstop for a tree where
 *     somebody widened it. This build has no production traffic and no baseline; a figure here would be
 *     invented, and a dashboard green against an invented target is worse than no dashboard.
 *  6. `alert-open-question-missing` — an `openQuestionId` that is not a row in `docs/OPEN-QUESTIONS.md`.
 *     An absent figure is only honest if the absence is recorded where absences are recorded.
 *  7. `alert-without-an-observer` / `observer-without-an-alert` — `ALERT_OBSERVERS` in
 *     `packages/db/src/alerts.ts` and the registry must be equal in both directions. The `Record<AlertId,
 *     …>` proves this for a tree that typechecks and says nothing about one where the type was widened,
 *     which is exactly how `pnpm boundaries` once reported success over zero modules (ADR 0002).
 *  8. `undefended-case-unreferenced` / `alert-names-an-undefined-exception` — `UNDEFENDED_BY_DESIGN` and
 *     the `doesNotCover` lists must be equal in both directions. The insider-threat exception's whole
 *     value is that it is attached to the alert somebody would otherwise believe; an exception no alert
 *     names is a page nobody opens.
 *
 * ## What this gate deliberately does not do
 *
 * It does not check that an alert has ever fired. That needs a database and rows, and it is
 * `packages/fixtures/src/alerts.itest.ts` — six conditions, each made true and then made false again.
 * A static gate that claimed to cover it would be the dead gate ADR 0003 is about.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDefinition, SETTINGS } from '../packages/config/src/settings/registry.ts'
import { ROLES } from '../packages/core/src/access/permissions.ts'
import { ALERT_OBSERVERS } from '../packages/db/src/alerts.ts'
import {
  ALERT_REGISTRY,
  ALERT_SEVERITIES,
  ALERT_SURFACES,
  THRESHOLD_UNITS,
  UNDEFENDED_BY_DESIGN,
} from '../packages/shared/src/alerts/registry.ts'

const ROOT = join(import.meta.dirname, '..')
const REGISTRY_PATH = 'packages/shared/src/alerts/registry.ts'
const OBSERVERS_PATH = 'packages/db/src/alerts.ts'
const RUNBOOK_DIR = 'docs/runbooks'
const OPEN_QUESTIONS_PATH = 'docs/OPEN-QUESTIONS.md'

const problems = []
const fail = (rule, where, detail) => problems.push(`${where}  [${rule}] ${detail}`)

const read = (path) => {
  try {
    return readFileSync(join(ROOT, path), 'utf8')
  } catch {
    return null
  }
}

/** GitHub's heading slug, near enough: lower-cased, punctuation dropped, spaces hyphenated. */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')

/** Every `<stem>#<slug>` a runbook in `docs/runbooks/` offers. */
function runbookAnchors() {
  const anchors = new Set()
  for (const name of readdirSync(join(ROOT, RUNBOOK_DIR))) {
    if (!name.endsWith('.md')) continue
    const stem = name.slice(0, -3)
    const text = read(join(RUNBOOK_DIR, name))
    if (text === null) continue
    for (const match of text.matchAll(/^#{1,6}\s+(.+)$/gm)) {
      anchors.add(`${stem}#${slug(match[1])}`)
    }
  }
  return anchors
}

const anchors = runbookAnchors()
const openQuestions = read(OPEN_QUESTIONS_PATH) ?? ''
const registrySource = read(REGISTRY_PATH) ?? ''
const observerSource = read(OBSERVERS_PATH) ?? ''
const settingKeys = new Set(SETTINGS.map((s) => s.key))
const roles = new Set(ROLES)

if (registrySource === '') {
  console.error(`${REGISTRY_PATH} could not be read. The registry is the gate's whole subject.`)
  process.exit(1)
}

/*
  The floor (ADR 0002), and it is three numbers rather than one because this gate derives from three
  places and any of them can go quiet.

  An empty `ALERT_REGISTRY` makes every loop below iterate zero times and the gate prints "0 alerts, each
  with a severity, a threshold, a runbook heading…" — which is the green tick over zero modules that
  ADR 0002 exists about, said about alerting. No runbook anchors means `readdirSync` found no `.md` (a
  renamed directory, a `SKIP` that grew) and every `alert-runbook-missing` would be reported for a reason
  that has nothing to do with the registry. No F09 setting keys means the registry import resolved to
  something that is not the settings module, and every `threshold-setting-undeclared` below would be
  noise.

  Floors, not exact counts: an exact count is a second statement of how many alerts there are, and the
  copy that drifts is the one in the gate.
*/
if (ALERT_REGISTRY.length < 3 || anchors.size < 3 || settingKeys.size < 20) {
  console.error(
    `Alert registry gate read ${ALERT_REGISTRY.length} alert(s), ${anchors.size} runbook anchor(s) and ` +
      `${settingKeys.size} F09 setting key(s), which is too little to mean anything. One of the three ` +
      'sources this gate derives from is not being read, so every answer below would be about nothing.',
  )
  process.exit(1)
}

// --- the entries ------------------------------------------------------------------------------------

for (const [index, entry] of ALERT_REGISTRY.entries()) {
  const where = `${REGISTRY_PATH}[${index}] ${entry.id}`

  if (!ALERT_SEVERITIES.includes(entry.severity)) {
    fail(
      'unknown-alert-severity',
      where,
      `severity "${entry.severity}" is not one of ${ALERT_SEVERITIES.join(', ')}`,
    )
  }
  if (!ALERT_SURFACES.includes(entry.route.surface)) {
    fail(
      'unknown-alert-surface',
      where,
      `surface "${entry.route.surface}" is not one of ${ALERT_SURFACES.join(', ')}`,
    )
  }
  if (entry.route.audience.length === 0) {
    fail(
      'unknown-alert-audience-role',
      where,
      'the audience is empty, so this alert is routed to nobody',
    )
  }
  for (const role of entry.route.audience) {
    if (!roles.has(role)) {
      fail(
        'unknown-alert-audience-role',
        where,
        `audience names "${role}", which the F07 role set does not have`,
      )
    }
  }
  // Prose, and the one field the gate cannot verify — so the only check is that it is a sentence
  // somebody could disagree with rather than a restatement of the id.
  if (typeof entry.rule !== 'string' || entry.rule.trim().length < 40) {
    fail(
      'alert-rule-not-a-sentence',
      where,
      'the `rule` must say what is TRUE when this fires, in a sentence',
    )
  }

  if (!anchors.has(entry.runbook)) {
    fail(
      'alert-runbook-missing',
      where,
      `runbook "${entry.runbook}" resolves to no heading in ${RUNBOOK_DIR}/. An alert with no ` +
        'procedure is a notification somebody invents a response to at 02:00',
    )
  }

  // --- the threshold ---
  if (!THRESHOLD_UNITS.includes(entry.threshold.unit)) {
    fail(
      'unknown-threshold-unit',
      where,
      `unit "${entry.threshold.unit}" is not one of ${THRESHOLD_UNITS.join(', ')}`,
    )
  }
  if (entry.threshold.kind === 'structural') {
    const stated = read(entry.threshold.statedIn)
    if (stated === null) {
      fail(
        'structural-threshold-not-stated-there',
        where,
        `statedIn "${entry.threshold.statedIn}" does not exist`,
      )
    } else if (!stated.includes(String(entry.threshold.value))) {
      fail(
        'structural-threshold-not-stated-there',
        where,
        `${entry.threshold.statedIn} does not contain ${entry.threshold.value}, so the registry is ` +
          'repeating a figure rather than pointing at the authority for it',
      )
    }
  } else {
    const key = entry.threshold.settingKey
    if (!settingKeys.has(key)) {
      fail(
        'threshold-setting-undeclared',
        where,
        `"${key}" is not an F09 setting, so nothing can change it`,
      )
      continue
    }
    const definition = getDefinition(key)
    if (definition.provisional === undefined) {
      fail(
        'threshold-setting-not-provisional',
        where,
        `"${key}" is not flagged provisional. Nothing in this build has measured it, so it must appear ` +
          'on the Unconfirmed Assumptions panel rather than reading as a figure somebody looked up',
      )
    } else if (!openQuestions.includes(definition.provisional.openQuestionId)) {
      fail(
        'alert-open-question-missing',
        where,
        `"${key}" names open question ${definition.provisional.openQuestionId}, which ${OPEN_QUESTIONS_PATH} does not list`,
      )
    }
    // An upper bound, proved by ASKING THE SCHEMA rather than by looking for `.max(` in the source.
    // The text scan was written first and was wrong in a way worth recording: the registry spells most
    // keys as an imported constant, so locating the definition by its literal found nothing and the
    // slice that followed examined the end of the file — the check passed for every key and would have
    // passed for an unbounded one. Parsing a value no threshold may legitimately hold is a claim about
    // behaviour, and it cannot go vacuous when somebody reformats.
    if (definition.schema.safeParse(Number.MAX_SAFE_INTEGER).success) {
      fail(
        'threshold-setting-unbounded',
        where,
        `"${key}" accepts ${Number.MAX_SAFE_INTEGER}, so its schema has no upper bound. A threshold ` +
          'that can be set to a million is an alert that can be silenced from a settings screen with ' +
          'nothing recording that it was',
      )
    }
  }

  // --- the SLO ---
  if (entry.slo.target !== null) {
    fail(
      'alert-slo-has-a-target',
      where,
      `the SLO carries a target (${JSON.stringify(entry.slo.target)}). There is no measured baseline in ` +
        'this build, so a figure here is invented, and a dashboard green against an invented target is ' +
        'worse than no dashboard',
    )
  }
  if (!openQuestions.includes(entry.slo.openQuestionId)) {
    fail(
      'alert-open-question-missing',
      where,
      `the SLO names open question ${entry.slo.openQuestionId}, which ${OPEN_QUESTIONS_PATH} does not list`,
    )
  }
  if (entry.slo.measuredFrom.length === 0) {
    fail('alert-slo-not-measurable', where, 'the SLO names no inputs, so nobody can recompute it')
  }
  for (const input of entry.slo.measuredFrom) {
    if (!/^[a-z_]+\.[a-z_]+$/.test(input)) {
      fail(
        'alert-slo-not-measurable',
        where,
        `measuredFrom "${input}" is not a \`table.column\` pair`,
      )
    }
  }
  if (!Number.isInteger(entry.slo.windowDays) || entry.slo.windowDays < 1) {
    fail(
      'alert-slo-not-measurable',
      where,
      'the SLO has no window, so the measure is an all-time average',
    )
  }

  // --- the exception ---
  for (const id of entry.doesNotCover) {
    if (!UNDEFENDED_BY_DESIGN.some((c) => c.id === id)) {
      fail(
        'alert-names-an-undefined-exception',
        where,
        `doesNotCover names "${id}", which UNDEFENDED_BY_DESIGN does not define`,
      )
    }
  }
}

// --- the observers, in both directions --------------------------------------------------------------

const observerIds = new Set(Object.keys(ALERT_OBSERVERS))
for (const entry of ALERT_REGISTRY) {
  if (!observerIds.has(entry.id)) {
    fail(
      'alert-without-an-observer',
      OBSERVERS_PATH,
      `"${entry.id}" is registered and ALERT_OBSERVERS has no reader for it. An alert nothing measures ` +
        'reports the same thing as a quiet day',
    )
  }
}
for (const id of observerIds) {
  if (!ALERT_REGISTRY.some((entry) => entry.id === id)) {
    fail(
      'observer-without-an-alert',
      OBSERVERS_PATH,
      `ALERT_OBSERVERS has a reader for "${id}", which ALERT_REGISTRY does not declare. It has no ` +
        'severity, no threshold, no runbook and no audience',
    )
  }
}
if (observerSource === '') {
  fail('observer-without-an-alert', OBSERVERS_PATH, 'the observer module could not be read')
}

// --- the exception list -----------------------------------------------------------------------------

if (UNDEFENDED_BY_DESIGN.length === 0) {
  fail(
    'undefended-case-unreferenced',
    REGISTRY_PATH,
    'UNDEFENDED_BY_DESIGN is empty. docs/06 D4 is explicit that the realistic breach here is an ' +
      'insider, and the owner can read everything — an empty exception list claims a coverage this ' +
      'build does not have',
  )
}
const named = new Set(ALERT_REGISTRY.flatMap((entry) => entry.doesNotCover))
for (const [index, kase] of UNDEFENDED_BY_DESIGN.entries()) {
  const where = `${REGISTRY_PATH} UNDEFENDED_BY_DESIGN[${index}] ${kase.id}`
  for (const field of ['what', 'who', 'why', 'wouldNeed']) {
    if (typeof kase[field] !== 'string' || kase[field].trim().length < 30) {
      fail(
        'undefended-case-incomplete',
        where,
        `\`${field}\` must be something a reviewer can disagree with`,
      )
    }
  }
  if (!named.has(kase.id)) {
    fail(
      'undefended-case-unreferenced',
      where,
      'no alert names this in doesNotCover. The exception has to sit beside the alert somebody would ' +
        'otherwise believe, or it is a page nobody opens',
    )
  }
}

if (problems.length > 0) {
  console.error('Alert registry problems:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(
    `\n${problems.length} problem(s). An alert nobody is watching is the failure G-AGT-01 exists to ` +
      'remove, one level up.',
  )
  process.exit(1)
}

console.log(
  `${ALERT_REGISTRY.length} alerts, each with a severity, a threshold, a runbook heading, an audience, ` +
    `an SLO shape and no target; ${UNDEFENDED_BY_DESIGN.length} exceptions, each named by an alert.`,
)
