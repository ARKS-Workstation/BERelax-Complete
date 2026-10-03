#!/usr/bin/env node
/**
 * The runbook set, machine-checked: a runbook is checked or it is decoration.
 *
 * `pnpm runbooks`, and it is the fourth link in `pnpm docs-set` rather than a gate of its own —
 * H-HARD-09 already built the documentation chain (the generated ADR index, the generated secret
 * inventory, every relative link and anchor) and a second entry point reading the same directory is a
 * second place for the set's rules to live.
 *
 * ## Why this gate exists at all
 *
 * The runbooks are what somebody reads at 8pm on a Friday when something has gone wrong, which is the
 * one moment when nobody is going to notice that the script a step tells them to run was renamed six
 * months ago. Every failure mode of this document set is quiet: the sentence still reads correctly, and
 * the thing it names is gone. So each claim a runbook makes about the repository is held to the
 * repository:
 *
 *  1. `runbook-front-matter-*` — the front matter is present, complete, and every value is of its
 *     declared kind. The schema is `docs/runbooks/_schema.json` and is READ rather than restated, so a
 *     field added there is required here on the same commit. A `kind` this file does not implement is
 *     refused by name rather than skipped, because a schema whose keywords are ignored is a schema that
 *     quietly stops meaning anything.
 *  2. `runbook-first-action-heading-missing` — `first_action_heading` names a heading in its own file.
 *     The acceptance line's "every heading a check references must exist", pointed at the one heading a
 *     reader is sent to before they have read anything.
 *  3. `runbook-command-missing` / `runbook-path-missing` — every `pnpm <script>` and every repository
 *     path written in a code span or a fenced block exists. This is the rule the set needs most: a
 *     procedure naming `pnpm rotate:kek` is worth exactly as much as the script.
 *  4. `runbook-env-undeclared` — every environment variable a runbook tells somebody to set or read is
 *     declared in `packages/config/src/env.ts`, or is in {@link ENV_NOT_IN_SCHEMA} with a reason.
 *  5. `runbook-alert-*` — the cross-check against H-HARD-05's registry, in both directions. No alert
 *     whose runbook heading resolves to a file that does not list it, and no runbook listing an alert
 *     the registry does not define. `pnpm alerts` already resolves an alert's `<stem>#<slug>` to a
 *     heading; what it cannot see is a runbook that has stopped being about the alert pointing at it.
 *  6. `runbook-orphan` — a runbook whose trigger kind is `alert` and which names no alert.
 *  7. `runbook-subject-missing` — the eight subjects the unit's acceptance line names, by file.
 *
 * ## The floors
 *
 * Every rule above is a comparison, and a comparison against an empty list passes (ADR 0002). So the
 * run refuses to report success over fewer than {@link MINIMUM_RUNBOOKS} runbooks, zero commands
 * examined, zero paths examined, zero environment variables and zero alerts — each of which is what a
 * pattern that stopped matching looks like from the inside.
 *
 * Usage: `node scripts/check-runbooks.mjs [--dir docs/runbooks]`
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROLES } from '../packages/core/src/access/permissions.ts'
import { ALERT_REGISTRY } from '../packages/shared/src/alerts/registry.ts'

const argv = process.argv.slice(2)
const dirFlag = argv.indexOf('--dir')
const RUNBOOK_DIR = dirFlag === -1 ? 'docs/runbooks' : (argv[dirFlag + 1] ?? 'docs/runbooks')
const SCHEMA_FILE = 'docs/runbooks/_schema.json'
const ENV_FILE = 'packages/config/src/env.ts'
const PACKAGE_JSON = 'package.json'

/**
 * How few runbooks is too few to mean anything.
 *
 * The acceptance line names eight subjects by hand, so eight is the floor that is derived from the
 * specification rather than chosen. Below it the set is incomplete and `runbook-subject-missing` says
 * which; at or above it the floors below are what stop a pattern that matches nothing from reporting
 * that every runbook is correct.
 */
const MINIMUM_RUNBOOKS = 8

/**
 * The eight subjects the unit must cover, each bound to the file that covers it.
 *
 * A declared list and not an inference, because "there is a runbook about payments somewhere" is not a
 * claim anything can check. Three of these existed before this unit and are named here rather than
 * rewritten: `restore` is H-HARD-04's and `key-rotation` is H-HARD-03's.
 */
const REQUIRED_SUBJECTS = [
  { subject: 'database failover to standby', id: 'database-failover' },
  { subject: 'SMSala or Resend outage', id: 'messaging-outage' },
  { subject: 'payment gateway outage', id: 'payment-gateway-outage' },
  { subject: 'pg-boss backlog', id: 'job-backlog' },
  { subject: 'Google invalid_grant', id: 'google-invalid-grant' },
  { subject: 'restore', id: 'restore' },
  { subject: 'KEK rotation', id: 'key-rotation' },
  { subject: 'cutover rollback', id: 'cutover-rollback' },
]

/**
 * Environment variables a runbook may name that `env.ts` does not declare, with the reason for each.
 *
 * Declared rather than inferred, for `check-gate-registry.mjs`'s reason: "it is not in the schema" is
 * exactly the condition a typo also satisfies, so an allowance that guessed would let the typo through
 * as an exception.
 */
const ENV_NOT_IN_SCHEMA = new Map([
  [
    'PAYLOAD_SECRET',
    'read by Payload itself rather than through the application config schema, which is why it is ' +
      'absent from env.ts and still has to be set for the CMS to start',
  ],
  [
    'TEST_DATABASE_URL',
    'the integration suites’ database, read directly by the suites and the scripts rather than ' +
      'through the config schema',
  ],
  [
    'PGPASSWORD',
    "libpq's own variable, not this application's: a runbook step that invokes psql may name it",
  ],
])

const problems = []
const fail = (rule, where, detail) => problems.push({ rule, where, detail })

// ------------------------------------------------------------------------------------------------
// The schema, read rather than restated
// ------------------------------------------------------------------------------------------------

if (!existsSync(SCHEMA_FILE)) {
  console.error(`${SCHEMA_FILE} is missing, so there is no declared front-matter shape to check.`)
  process.exit(1)
}
const schema = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'))
const FIELDS = Object.entries(schema.fields ?? {})
if (FIELDS.length === 0) {
  console.error(`${SCHEMA_FILE} declares no fields, so "every field is present" would be vacuous.`)
  process.exit(1)
}

/** The kinds this file knows how to check. A kind outside this set is refused, never skipped. */
const IMPLEMENTED_KINDS = new Set([
  'slug',
  'text',
  'unit-id',
  'enum',
  'heading-slug',
  'role',
  'alert-id-list',
  'env-var-list',
])
for (const [name, field] of FIELDS) {
  if (!IMPLEMENTED_KINDS.has(field.kind)) {
    fail(
      'runbook-schema-construct-unimplemented',
      SCHEMA_FILE,
      `field "${name}" declares kind "${field.kind}", which this checker does not implement. A schema ` +
        'keyword nothing enforces is worse than no schema: the field looks checked and is not',
    )
  }
}

// ------------------------------------------------------------------------------------------------
// What the claims are checked against
// ------------------------------------------------------------------------------------------------

const scripts = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')).scripts ?? {}
const declaredEnv = new Set(
  [...readFileSync(ENV_FILE, 'utf8').matchAll(/^\s+([A-Z][A-Z0-9_]{2,}):/gm)].map((m) => m[1]),
)
if (declaredEnv.size < 20) {
  console.error(
    `Read only ${declaredEnv.size} variable(s) out of ${ENV_FILE}: the pattern is wrong, so every ` +
      'environment variable a runbook names would be reported as undeclared.',
  )
  process.exit(1)
}

/** `<stem>#<slug>` from each alert, so the registry's own pointer is the thing compared against. */
const alertsByStem = new Map()
for (const alert of ALERT_REGISTRY) {
  const [stem] = alert.runbook.split('#')
  const existing = alertsByStem.get(stem) ?? []
  alertsByStem.set(stem, [...existing, alert.id])
}
const alertIds = new Set(ALERT_REGISTRY.map((alert) => alert.id))
if (alertIds.size === 0) {
  console.error(
    'ALERT_REGISTRY is empty, so the alert-to-runbook cross-check would be about nothing.',
  )
  process.exit(1)
}

// ------------------------------------------------------------------------------------------------
// Parsing
// ------------------------------------------------------------------------------------------------

/** GitHub's heading slug, as `check-docs-links.mjs` computes it. One spelling, imported in spirit. */
const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')

/**
 * Front matter, parsed strictly.
 *
 * `(none)` is the empty list and an empty value is an error, because "the field is there and says
 * nothing" is the state this whole gate exists to refuse. A continuation line is an error too: it is
 * what a YAML block scalar looks like, and accepting it would mean this parser and a real YAML parser
 * disagree about the document — after which the front matter means one thing to a reader and another
 * to the gate.
 */
function frontMatter(text, where) {
  const lines = text.split('\n')
  if (lines[0] !== schema.format.opener) {
    fail(
      'runbook-front-matter-missing',
      where,
      `the file does not begin with "${schema.format.opener}". A runbook with no front matter has no ` +
        'declared trigger, and a runbook with no trigger is a document nobody opens at the right moment',
    )
    return null
  }
  const closer = lines.indexOf(schema.format.closer, 1)
  if (closer === -1) {
    fail('runbook-front-matter-missing', where, 'the front matter block is never closed')
    return null
  }
  const entry = new RegExp(schema.format.entry)
  const values = new Map()
  for (let at = 1; at < closer; at += 1) {
    const line = lines[at] ?? ''
    const match = entry.exec(line)
    if (match === null) {
      fail(
        'runbook-front-matter-malformed',
        `${where}:${at + 1}`,
        `"${line}" is not "key: value". The format is one entry per line with no continuation and no ` +
          'nesting; a document that is almost YAML is refused here rather than parsed into something ' +
          'nobody meant',
      )
      continue
    }
    const [, key, value] = match
    if (values.has(key)) {
      fail('runbook-front-matter-malformed', `${where}:${at + 1}`, `"${key}" appears twice`)
      continue
    }
    values.set(key, value.trim())
  }
  return { values, body: lines.slice(closer + 1).join('\n') }
}

/** Headings, after code fences are blanked — `admin-access.md` has a `#` comment inside a shell block. */
function headings(body) {
  const prose = body.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, ' '))
  return new Set([...prose.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1] ?? '')))
}

/** Every code span and fenced block, which is where a runbook names a command or a path. */
function codeFragments(body) {
  return [
    ...[...body.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]),
    ...[...body.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? ''),
  ]
}

const list = (value) =>
  value === schema.format.emptyList ? [] : value.split(',').map((v) => v.trim())

// ------------------------------------------------------------------------------------------------
// The run
// ------------------------------------------------------------------------------------------------

const files = readdirSync(RUNBOOK_DIR)
  .filter((name) => name.endsWith('.md'))
  .sort()

let commandsChecked = 0
let pathsChecked = 0
let envChecked = 0
let alertsChecked = 0
const byStem = new Map()
const byDeclaredId = new Map()

for (const file of files) {
  const where = join(RUNBOOK_DIR, file)
  const stem = file.replace(/\.md$/, '')
  const parsed = frontMatter(readFileSync(where, 'utf8'), where)
  if (parsed === null) continue
  const { values, body } = parsed
  const own = headings(body)

  for (const [name, field] of FIELDS) {
    const value = values.get(name)
    if (value === undefined || value === '') {
      if (field.required === true) {
        fail('runbook-front-matter-field-missing', where, `"${name}" is required and is not stated`)
      }
      continue
    }
    switch (field.kind) {
      case 'slug':
        if (value !== stem) {
          fail(
            'runbook-front-matter-field-invalid',
            where,
            `"${name}" is "${value}" and the file stem is "${stem}". A renamed file keeping an old id ` +
              'is an id other documents cite and nothing resolves',
          )
        }
        break
      case 'text':
        if (value.length < (field.minLength ?? 1)) {
          fail(
            'runbook-front-matter-field-invalid',
            where,
            `"${name}" is ${value.length} character(s) and the schema asks for ${field.minLength}. A ` +
              'one-word trigger or escalation is a field somebody filled in to make a gate pass',
          )
        }
        break
      case 'unit-id':
        if (!/^(?:[A-Z]-[A-Z]{2,5}-\d{2}|[A-Z]\d{2}|[A-Z]-[A-Z]\d)$/.test(value)) {
          fail(
            'runbook-front-matter-field-invalid',
            where,
            `"${name}" is not a unit id: "${value}"`,
          )
        }
        break
      case 'enum':
        if (!(field.values ?? []).includes(value)) {
          fail(
            'runbook-front-matter-field-invalid',
            where,
            `"${name}" is "${value}" and the schema allows ${(field.values ?? []).join(', ')}`,
          )
        }
        break
      case 'role':
        if (!ROLES.includes(value)) {
          fail(
            'runbook-front-matter-field-invalid',
            where,
            `"${name}" is "${value}", which is not an F07 role. An owner is a role and never a person ` +
              '(brief rule 10)',
          )
        }
        break
      case 'heading-slug':
        if (!own.has(value)) {
          fail(
            'runbook-first-action-heading-missing',
            where,
            `"${name}" names "${value}" and no heading in this file produces that anchor. The front ` +
              'matter sends a reader to a section that is not there',
          )
        }
        break
      case 'alert-id-list':
        for (const id of list(value)) {
          alertsChecked += 1
          if (!alertIds.has(id)) {
            fail(
              'runbook-alert-unknown',
              where,
              `"${id}" is not an alert in ALERT_REGISTRY. A runbook answering an alert nothing raises ` +
                'is a procedure for a condition that cannot occur',
            )
          }
        }
        break
      case 'env-var-list':
        for (const name2 of list(value)) {
          envChecked += 1
          if (!declaredEnv.has(name2) && !ENV_NOT_IN_SCHEMA.has(name2)) {
            fail(
              'runbook-env-undeclared',
              where,
              `"${name2}" is not declared in ${ENV_FILE} and is not in this checker's declared ` +
                'exceptions. A step telling somebody to set a variable the application never reads is ' +
                'a step that appears to work',
            )
          }
        }
        break
      default:
        // The unimplemented kind is already reported against the schema above; nothing is checked
        // here, deliberately, so the failure names the schema rather than every runbook.
        break
    }
  }

  // --- the body's claims about the repository ---------------------------------------------------
  for (const fragment of codeFragments(body)) {
    for (const match of fragment.matchAll(/\bpnpm ([a-z][\w:-]*)\b/g)) {
      const name = match[1] ?? ''
      // `pnpm exec`, `pnpm install` and `pnpm --filter` are pnpm's own verbs rather than this
      // workspace's scripts, and a check that demanded a script called `exec` would fail on correct
      // instructions — which is a gate somebody deletes.
      if (['exec', 'install', 'add', 'run', 'dlx', 'audit', 'why', 'store'].includes(name)) continue
      commandsChecked += 1
      if (!Object.hasOwn(scripts, name)) {
        fail(
          'runbook-command-missing',
          where,
          `\`pnpm ${name}\` is not a script in ${PACKAGE_JSON}. A procedure naming a command is worth ` +
            'exactly as much as the command',
        )
      }
    }
    for (const match of fragment.matchAll(
      /\b((?:scripts|packages|apps|docs|build|artifacts)\/[\w./@-]*[\w)](?:\.[a-z]+)?)/g,
    )) {
      const path = (match[1] ?? '').replace(/[.)]+$/, '')
      // A path with no extension is a directory reference, and a glob is a specification; both are
      // checked by existence of the literal, which is what `path` already is here.
      if (!/\.[a-z]+$/.test(path) && !path.endsWith('/')) continue
      pathsChecked += 1
      if (!existsSync(path)) {
        fail(
          'runbook-path-missing',
          where,
          `${path} does not exist. The sentence around it still reads correctly, which is why nothing ` +
            'else would notice',
        )
      }
    }
    for (const match of fragment.matchAll(
      /(?:^|[\s"'])(?:export\s+)?\$?\{?([A-Z][A-Z0-9_]{2,})\}?=/gm,
    )) {
      const name = match[1] ?? ''
      envChecked += 1
      if (!declaredEnv.has(name) && !ENV_NOT_IN_SCHEMA.has(name)) {
        fail(
          'runbook-env-undeclared',
          where,
          `a step sets "${name}", which ${ENV_FILE} does not declare and this checker does not except`,
        )
      }
    }
  }

  const entry = {
    where,
    stem,
    declaredId: values.get('id'),
    triggerKind: values.get('trigger_kind'),
    alerts: list(values.get('alerts') ?? schema.format.emptyList),
  }
  byStem.set(stem, entry)
  /*
    Keyed by the DECLARED id and not by the file stem, and the difference is a defect gate case 202j
    found. The subject list below is a list of ids, so checking it against stems made
    `runbook-subject-missing` unreachable from any fixture short of deleting a committed file: a runbook
    whose `id` had been changed still answered for its subject because its FILENAME had not. The
    id-equals-stem rule above keeps the two aligned, so both rules fire together on that edit — which is
    the stronger statement, not a duplicate.
  */
  if (entry.declaredId !== undefined) byDeclaredId.set(entry.declaredId, entry)
}

// --- the cross-check, in both directions --------------------------------------------------------

for (const [stem, ids] of alertsByStem) {
  const runbook = byStem.get(stem)
  if (runbook === undefined) {
    fail(
      'runbook-alert-orphan',
      `${RUNBOOK_DIR}/${stem}.md`,
      `alert(s) ${ids.join(', ')} name this runbook and it is not in the set. \`pnpm alerts\` resolves ` +
        'the heading; this is the file',
    )
    continue
  }
  for (const id of ids) {
    if (!runbook.alerts.includes(id)) {
      fail(
        'runbook-alert-orphan',
        runbook.where,
        `alert "${id}" names a heading in this runbook and the runbook's own \`alerts\` list omits it. ` +
          'The registry points one way and the document points nowhere, which is how a runbook comes to ' +
          'be about something else while the alert still links to it',
      )
    }
  }
}

for (const [stem, runbook] of byStem) {
  if (runbook.triggerKind === 'alert' && runbook.alerts.length === 0) {
    fail(
      'runbook-orphan',
      runbook.where,
      `${stem} declares trigger_kind "alert" and names no alert, so nothing will ever send anybody here`,
    )
  }
}

for (const { subject, id } of REQUIRED_SUBJECTS) {
  if (!byDeclaredId.has(id)) {
    fail(
      'runbook-subject-missing',
      `${RUNBOOK_DIR}/${id}.md`,
      `there is no runbook for "${subject}". The set is the list of things that can fail at 8pm on a ` +
        'Friday, and the one that is missing is the one nobody thought of',
    )
  }
}

// --- the floors ---------------------------------------------------------------------------------

const floors = [
  [files.length, MINIMUM_RUNBOOKS, 'runbook(s) in the directory'],
  [commandsChecked, 10, 'pnpm command(s) examined'],
  [pathsChecked, 10, 'repository path(s) examined'],
  [envChecked, 5, 'environment variable(s) examined'],
  [alertsChecked, ALERT_REGISTRY.length, 'alert id(s) read from front matter'],
]
for (const [got, floor, what] of floors) {
  if (got < floor) {
    fail(
      'runbook-examined-nothing',
      RUNBOOK_DIR,
      `${got} ${what}, below the floor of ${floor}. A comparison against an empty list passes, so the ` +
        'clean run this would otherwise print would be about nothing (ADR 0002)',
    )
  }
}

if (problems.length > 0) {
  console.error('Runbook set:\n')
  for (const problem of problems) {
    console.error(`  ${problem.where}  [${problem.rule}] ${problem.detail}`)
  }
  console.error(`\n${problems.length} problem(s).`)
  process.exit(1)
}

console.log(
  `Runbook set: ${files.length} runbook(s), each with a trigger, a first action whose heading exists, ` +
    `an owner role and an escalation; ${commandsChecked} command(s), ${pathsChecked} path(s) and ` +
    `${envChecked} environment variable(s) named in them all exist; ${ALERT_REGISTRY.length} alert(s) ` +
    'cross-check against the registry in both directions with no orphan either way; all ' +
    `${REQUIRED_SUBJECTS.length} declared subjects covered.`,
)
