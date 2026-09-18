#!/usr/bin/env node
/**
 * Enforces schema conventions that a type system cannot.
 *
 * 1. **Every timestamp is timestamptz.** A naive `timestamp` column silently stores whatever the
 *    session timezone was, so the same appointment reads back differently depending on who connects.
 *    With trading hours crossing midnight, that is not a cosmetic bug — it moves bookings between
 *    business days and therefore between cash-up totals.
 * 2. **Money columns are integer.** `numeric`, `real` or `double precision` on an amount column is
 *    the float-money mistake in a different costume.
 * 3. **A table that says UPDATE and DELETE raise must actually make them raise.** ADR 0017's
 *    append-only tables are enforced by a pair of BEFORE triggers, and the pair is where the defect
 *    hides: you write one trigger, copy it for the other event, and forget to change the word. The
 *    table then documents a guarantee it only half keeps, and the half that is missing is invisible in
 *    review because the comment says otherwise. The same rule refuses an `updated_at` column or a
 *    `set_updated_at` trigger on such a table, which is what arrives when a mutable table's definition
 *    is copied to make the next log: a row with no second version has no update time, and a table
 *    carrying both triggers claims two contradictory things.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const problems = []

// --- Drizzle definitions ------------------------------------------------------------------------
// Both mirror directories. The clinical schema's mirrors live in @berelax/clinical, and leaving
// them out would exempt the most sensitive schema from the convention.
const SCHEMA_DIRS = ['packages/db/src/schema', 'packages/clinical/src/schema']
for (const dir of SCHEMA_DIRS) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const path = join(dir, file)
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/\btimestamp\s*\(/.test(line) && !/withTimezone:\s*true/.test(line)) {
          problems.push(`${path}:${i + 1}  timestamp() without { withTimezone: true }`)
        }
        if (/\b(?:real|doublePrecision)\s*\(/.test(line)) {
          problems.push(
            `${path}:${i + 1}  floating-point column — money and counts must be integer`,
          )
        }
      })
  }
}

/**
 * Rule `review-no-overloaded-posted-at`.
 *
 * A review table records its reply delivery as `delivery_mode` plus `submitted_at`/`confirmed_at` and
 * `posted_manually_at` (docs/10 §6, migration 0020). A single `posted_at` is the mistake this exists to
 * stop: it reads identically whether the system submitted the reply through the API or a human says they
 * pasted it in, which is the only question anybody asks of that column afterwards — and it has no room
 * for the API's separate acknowledgement.
 *
 * Scoped to the SQL, because SQL-first is where a column comes into existence (ADR 0006). The applied
 * schema is asserted separately, by introspecting `information_schema` in
 * `packages/db/src/schema/reviews.itest.ts`; the Drizzle mirror is compared to the live database by
 * `pnpm db:drift`. This gate is the one that fires before the column has been applied anywhere.
 */
const POSTED_AT_RULE = 'review-no-overloaded-posted-at'
const REVIEW_TABLE = /review/

// --- SQL migrations -----------------------------------------------------------------------------
const MIGRATIONS_DIR = 'packages/db/migrations'
for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))) {
  const path = join(MIGRATIONS_DIR, file)
  /** The table whose definition the scan is currently inside, so the rule can be table-scoped. */
  let table = null
  readFileSync(path, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      // `--` comments and single-quoted strings are blanked before the scan. SQL `comment on`
      // statements are prose about the schema, and prose about a schema says the word "timestamp" —
      // which the first version of this gate reported as a naive timestamp column.
      const code = line.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/, '')
      // `timestamp` not followed by `tz` or `with time zone`.
      if (/\btimestamp\b(?!tz)(?!\s+with\s+time\s+zone)/i.test(code)) {
        problems.push(`${path}:${i + 1}  naive timestamp — use timestamptz`)
      }
      if (/\b(real|double\s+precision|money)\b/i.test(code)) {
        problems.push(
          `${path}:${i + 1}  ${/money/i.test(code) ? 'the money type' : 'a floating-point type'} — ` +
            'amounts are integer fils (see the `fils` domain in 0002_conventions.sql)',
        )
      }
      // Which table is this line part of? `create table` opens a definition, the closing `)` of the
      // column list ends it, and an `alter table` names its own target on the same line.
      const opened = /^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z0-9_.]+)/i.exec(code)
      const altered = /^\s*alter\s+table\s+(?:if\s+exists\s+)?([a-z0-9_.]+)/i.exec(code)
      if (opened !== null) table = opened[1]
      else if (altered !== null) table = altered[1]
      else if (/^\s*\)\s*;?\s*$/.test(code)) table = null
      if (table !== null && REVIEW_TABLE.test(table) && /\bposted_at\b/.test(code)) {
        problems.push(
          `${path}:${i + 1}  ${POSTED_AT_RULE}: posted_at on "${table}" — a review's delivery is ` +
            'delivery_mode plus submitted_at/confirmed_at and posted_manually_at (docs/10 SS6), never ' +
            'one column that cannot say which of the two happened',
        )
      }
    })
}

// --- append-only tables must refuse UPDATE and DELETE -------------------------------------------
// Scoped by what the table itself claims, so it judges a declaration rather than a guess: the marker
// is the phrase "UPDATE and DELETE raise" in the table's own SQL comment. `audit_event` and
// `app_setting_history` use `create rule ... do instead nothing` and say so differently; a rule reports
// success to the caller, which is a different (and weaker) promise and not the one checked here.
const RULE = 'append-only-table-must-refuse-update-and-delete'
const APPEND_ONLY_MARKER = /UPDATE and DELETE raise/i

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
const migrations = migrationFiles.map((file) => ({
  path: join(MIGRATIONS_DIR, file),
  sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8'),
}))
// One corpus, because the trigger that enforces a table declared in 0016 may be added in 0020. A
// per-file check would report a defect that a later migration had already fixed.
const allSql = migrations.map((m) => m.sql).join('\n')

/** The body of `create table <name> ( ... )`, by matching parentheses rather than a closing line. */
function createTableBody(name) {
  const opened = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?${name}\\s*\\(`, 'i')
  const match = opened.exec(allSql)
  if (match === null) return null
  let depth = 1
  let i = match.index + match[0].length
  while (i < allSql.length && depth > 0) {
    if (allSql[i] === '(') depth += 1
    else if (allSql[i] === ')') depth -= 1
    i += 1
  }
  return allSql.slice(match.index + match[0].length, i - 1)
}

const hasTrigger = (event, table) =>
  new RegExp(`create\\s+trigger\\s+\\w+\\s+before\\s+${event}\\s+on\\s+${table}\\b`, 'i').test(
    allSql,
  )

for (const { path, sql } of migrations) {
  // `comment on table <name> is '<prose>';` — the prose may span lines as adjacent string literals.
  for (const match of sql.matchAll(/comment\s+on\s+table\s+([a-z0-9_.]+)\s+is\s+([^;]*);/gi)) {
    const qualified = match[1]
    const prose = match[2]
    if (!APPEND_ONLY_MARKER.test(prose)) continue
    const table = qualified.replace(/^[a-z0-9_]+\./i, '')

    for (const event of ['update', 'delete']) {
      if (!hasTrigger(event, table)) {
        problems.push(
          `${path}  ${RULE}: ${table} is documented as raising on UPDATE and DELETE, but no ` +
            `BEFORE ${event.toUpperCase()} trigger on it exists in any migration`,
        )
      }
    }

    const body = createTableBody(table)
    if (body !== null && /^\s*updated_at\b/im.test(body)) {
      problems.push(
        `${path}  ${RULE}: ${table} is append-only and has an updated_at column. A row with no ` +
          'second version has no update time',
      )
    }
    if (
      new RegExp(
        `create\\s+trigger\\s+\\w+[\\s\\S]{0,120}?on\\s+${table}\\b[\\s\\S]{0,120}?set_updated_at`,
        'i',
      ).test(allSql)
    ) {
      problems.push(
        `${path}  ${RULE}: ${table} is append-only and carries a set_updated_at trigger, which can ` +
          'only ever fire on an UPDATE the refusal trigger rejects',
      )
    }
  }
}

// --- availability is computed on demand, never materialised -------------------------------------
/**
 * Rule `no-precomputed-slot-table`.
 *
 * B-AVAIL-02 answers availability by arithmetic over the trading window, the appointments, the blocks
 * and the closures — `packages/core/src/availability/solve.ts`. A slot is therefore a **computed
 * answer**, and this rule is the negative schema assertion that keeps it one: there is no slot table,
 * no `availability_cache`, no materialised view of either.
 *
 * Why a gate rather than a convention. A precomputed slot table is an attractive idea — it makes the
 * booking page a single indexed read — and it fails in a way nobody sees for weeks: the rows are stale
 * from the instant a block, a closure, a shift change or a manual booking lands, so the page offers a
 * slot the floor cannot deliver, and the front desk learns about it from the customer. Every
 * regeneration strategy that fixes that is a second source of truth for the same question.
 *
 * Scoped to the SQL, because a table comes into existence there (ADR 0006). A table created straight
 * in a database without a migration is `pnpm db:drift`'s to catch.
 */
const SLOT_RULE = 'no-precomputed-slot-table'

/** True for a relation name that would hold precomputed availability. */
const namesPrecomputedAvailability = (name) => {
  const bare = name.replace(/^[a-z0-9_]+\./i, '')
  if (/(^|_)slots?(_|$)/.test(bare)) return true
  if (/^precomputed_/.test(bare)) return true
  // "availability" plus any word that means "stored earlier": availability_cache, avail_snapshot.
  return /avail/.test(bare) && /(cache|snapshot|precomputed|materiali[sz]ed|generated)/.test(bare)
}

for (const { path, sql } of migrations) {
  sql.split('\n').forEach((line, i) => {
    // Comments and string literals blanked first. The migrations and this repository's prose talk about
    // slots constantly — 0012 explains why a block "must never make a single slot unavailable" — and a
    // rule that read comments would fire on the sentence explaining why it exists.
    const code = line.replace(/'(?:[^']|'')*'/g, "''").replace(/--.*$/, '')
    const created =
      /^\s*create\s+(?:or\s+replace\s+)?(?:unlogged\s+|temp\s+|temporary\s+)?(table|materialized\s+view|view)\s+(?:if\s+not\s+exists\s+)?([a-z0-9_."]+)/i.exec(
        code,
      )
    if (created === null) return
    const kind = created[1].toLowerCase().replace(/\s+/g, ' ')
    const name = created[2].replace(/"/g, '')
    if (!namesPrecomputedAvailability(name)) return
    problems.push(
      `${path}:${i + 1}  ${SLOT_RULE}: ${kind} "${name}" would materialise availability. Slots are ` +
        'computed on demand from the trading window, appointments, blocks and closures ' +
        '(packages/core/src/availability/solve.ts); a stored copy is stale from the next block, ' +
        'closure or walk-in and offers a slot the floor cannot deliver',
    )
  })
}

if (problems.length > 0) {
  console.error(`Schema convention violations — ${problems.length}:`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
// Every rule is named in the summary. Two units added a rule to this file in parallel and one of them
// branched before the other's landed; copying the file wholesale dropped a rule, and the only reason it
// was noticed is that scripts/test-gates.mjs still had the fixture and reported the gate had not fired.
// A summary that lists the rules makes the loss visible in the output as well.
console.log(
  'Schema conventions hold: all timestamps are timestamptz, no floating-point amounts, no overloaded ' +
    'posted_at on a review table, every append-only table refuses UPDATE and DELETE, and no migration ' +
    'materialises availability as a slot or cache table.',
)
