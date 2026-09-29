/**
 * The four rules the `reporting` schema has to keep, as predicates over a catalogue corpus.
 *
 * ## Why these are pure functions and not queries
 *
 * Each one is a claim about the SHAPE of the schema — "every materialised view carries a unique index",
 * "all money is bigint fils" — and the natural way to write it is a `select` with a `where` clause in the
 * integration suite. That form has one failure mode and it is the one ADR 0002 is about: a query returning
 * no rows is indistinguishable from a query that no longer matches anything, so the assertion passes for
 * ever the day its predicate stops being right.
 *
 * So the catalogue read and the judgement are separated. `packages/db/src/reporting.itest.ts` does the
 * read and hands the rows here; `schema-rules.test.ts` hands the same functions a corpus that DOES
 * violate each rule and requires the finding. That is the arrangement `sqlstate-registry.ts` describes for
 * itself — "pure over a corpus, so a test can hand it a corpus that DOES collide" — applied one schema
 * along.
 *
 * ## Each rule, and the failure it is against
 *
 *   * **{@link REPORTING_SCHEMA_RULES.uniqueIndex}** — `REFRESH MATERIALIZED VIEW CONCURRENTLY` requires a
 *     UNIQUE index over plain columns. Without one the refresh fails; the tempting fix is to drop
 *     `CONCURRENTLY`, which takes ACCESS EXCLUSIVE and blocks every reader for the length of the rebuild.
 *     A partial or expression unique index satisfies `indisunique` and does NOT satisfy PostgreSQL, which
 *     is why the corpus carries both flags rather than one boolean.
 *   * **{@link REPORTING_SCHEMA_RULES.moneyIsBigintFils}** — money is integer fils (ADR 0007). Two
 *     directions, because each catches something the other cannot: a `_fils` column that is not `bigint`
 *     is a money column that has stopped being exact, and a `numeric`, `real` or `double precision` column
 *     under any name is the float-money mistake wearing a different one. `sum(bigint)` returns `numeric`
 *     in PostgreSQL, so this is the rule a view author trips over by writing the obvious aggregate.
 *   * **{@link REPORTING_SCHEMA_RULES.clockFree}** — a view definition that reads the clock makes every
 *     refresh a change. "Refresh is idempotent: two consecutive refreshes produce identical row checksums"
 *     is then false by construction, and every comparison built on it is noise.
 *   * **{@link REPORTING_SCHEMA_RULES.mirrorMatchesCatalogue}** — the seven materialised views are OUTSIDE
 *     `pnpm db:drift`, whose query is `relkind in ('r','p')`, so nothing else in this repository compares
 *     their shape to anything. This rule is that comparison: the Drizzle mirror's `materializedView(...)`
 *     blocks against `pg_attribute`, in both directions. Parsed from the mirror's SOURCE rather than
 *     imported, for `check-schema-drift.mjs`'s own reason — "so the check does not depend on the ORM's
 *     runtime internals and keeps working across Drizzle versions".
 *   * **{@link REPORTING_SCHEMA_RULES.businessDayKey}** — a fact is keyed on `business_day`, never on a
 *     calendar date truncated from an instant. Trading runs 11:00–02:00, so `(occurred_at at time zone
 *     'Asia/Dubai')::date` moves the last two hours of every night into the next day. The rule refuses the
 *     truncation in the DEFINITION, and requires every fact to declare a business-day column that the view
 *     actually has — the two halves together, because a fact with a correct column and a stray truncation
 *     elsewhere in its body is still wrong.
 */

/** The rule names a finding is reported by, so a known-bad fixture can assert the one it broke (ADR 0003). */
export const REPORTING_SCHEMA_RULES = {
  uniqueIndex: 'reporting-view-has-a-plain-unique-index',
  moneyIsBigintFils: 'reporting-money-is-bigint-fils',
  clockFree: 'reporting-view-is-a-pure-function-of-its-base-tables',
  businessDayKey: 'reporting-fact-is-keyed-on-business-day',
  mirrorMatchesCatalogue: 'reporting-view-mirror-matches-the-catalogue',
} as const

export type ReportingSchemaRule =
  (typeof REPORTING_SCHEMA_RULES)[keyof typeof REPORTING_SCHEMA_RULES]

/** One index on one relation in the `reporting` schema, as `pg_index` describes it. */
export interface IndexRow {
  readonly relation: string
  readonly indexName: string
  readonly isUnique: boolean
  /** True when the index carries a WHERE clause (`pg_index.indpred is not null`). */
  readonly isPartial: boolean
  /** True when any key is an expression rather than a bare column (`pg_index.indexprs is not null`). */
  readonly isExpression: boolean
}

/** One column of one relation in the `reporting` schema, with `format_type`'s spelling of its type. */
export interface ColumnRow {
  readonly relation: string
  readonly column: string
  readonly type: string
}

/** One materialised view and the definition `pg_matviews` holds for it. */
export interface DefinitionRow {
  readonly relation: string
  readonly definition: string
}

/** One row of `reporting.materialised_view`. */
export interface RegistryRow {
  readonly viewName: string
  readonly kind: string
  readonly businessDayColumn: string | null
}

/** A rule violation: which rule, which relation, and what was found. */
export interface Finding {
  readonly rule: ReportingSchemaRule
  readonly relation: string
  readonly detail: string
}

/**
 * Materialised views with no unique index `REFRESH ... CONCURRENTLY` will accept.
 *
 * `views` is passed separately from `indexes` rather than being derived from them, and that is the whole
 * point: a view with no index at all contributes NO rows to `pg_index`, so a function that derived the
 * relation set from the index rows could never report it. That is the defect this rule exists to catch.
 */
export function viewsWithoutAUsableUniqueIndex(
  views: readonly string[],
  indexes: readonly IndexRow[],
): readonly Finding[] {
  return views
    .filter(
      (view) =>
        !indexes.some(
          (index) =>
            index.relation === view && index.isUnique && !index.isPartial && !index.isExpression,
        ),
    )
    .map((view) => ({
      rule: REPORTING_SCHEMA_RULES.uniqueIndex,
      relation: view,
      detail:
        indexes.filter((index) => index.relation === view && index.isUnique).length > 0
          ? 'its only unique index is partial or over an expression, which satisfies indisunique and ' +
            'does not satisfy REFRESH MATERIALIZED VIEW CONCURRENTLY'
          : 'no unique index at all, so REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run',
    }))
}

/** Types that may never hold an amount, whatever the column is called. ADR 0007: integer fils, never a float. */
const INEXACT_TYPES: readonly string[] = Object.freeze([
  'numeric',
  'real',
  'double precision',
  'money',
])

/** A column whose name says it holds money. */
const MONEY_COLUMN = /_fils$/

/**
 * Money columns that are not `bigint`, and any column at all whose type cannot hold an exact amount.
 *
 * Both directions. The first catches a `_fils` column that has drifted — `sum(x)` over a `bigint` returns
 * `numeric`, so this is what a view author trips over by writing the obvious aggregate. The second catches
 * the same mistake under a name the first cannot see, and is why the whole schema is scanned rather than
 * only the columns that admit to being money.
 *
 * A `numeric` scale is not inspected and does not need to be: `numeric(12,2)` is a scaled decimal, which
 * is a different wrong answer from a float and is still not integer fils.
 */
export function moneyColumnsThatAreNotExact(columns: readonly ColumnRow[]): readonly Finding[] {
  const findings: Finding[] = []
  for (const column of columns) {
    // `startsWith`, because `format_type` spells a constrained numeric as `numeric(12,2)`.
    const inexact = INEXACT_TYPES.find((type) => column.type.startsWith(type))
    if (inexact !== undefined) {
      findings.push({
        rule: REPORTING_SCHEMA_RULES.moneyIsBigintFils,
        relation: column.relation,
        detail: `${column.column} is ${column.type}; no column in the reporting schema may hold an inexact number, because an amount is integer fils (ADR 0007) and a count is an integer`,
      })
      continue
    }
    if (MONEY_COLUMN.test(column.column) && column.type !== 'bigint') {
      findings.push({
        rule: REPORTING_SCHEMA_RULES.moneyIsBigintFils,
        relation: column.relation,
        detail: `${column.column} is ${column.type} and a fils column is bigint`,
      })
    }
  }
  return findings
}

/**
 * Everything that reads the clock. Spelled out rather than matched by a pattern, because the set is closed
 * and a pattern over it would also match `business_day`, `issued_at` and every other honest column name.
 */
const CLOCK_READS: readonly string[] = Object.freeze([
  'now()',
  'current_timestamp',
  'current_date',
  'current_time',
  'localtimestamp',
  'localtime',
  'clock_timestamp()',
  'statement_timestamp()',
  'transaction_timestamp()',
  'timeofday()',
])

/**
 * Materialised views whose definition reads the clock.
 *
 * A view holding `now() - created_at` changes on every refresh whether or not a base row moved, so the
 * checksum comparison that proves the refresh idempotent cannot hold — and a report whose figures move
 * when nothing happened is worse than one that is late, because nothing in it says which.
 */
export function viewsThatReadTheClock(rows: readonly DefinitionRow[]): readonly Finding[] {
  return rows.flatMap((row) => {
    const lowered = row.definition.toLowerCase()
    const found = CLOCK_READS.filter((call) => lowered.includes(call))
    return found.length === 0
      ? []
      : [
          {
            rule: REPORTING_SCHEMA_RULES.clockFree,
            relation: row.relation,
            detail: `its definition reads ${found.join(', ')}, so every refresh is a change and no two refreshes can agree`,
          },
        ]
  })
}

/**
 * Ways a definition can turn an instant into a date, each of which breaks the 11:00–02:00 trading day.
 *
 * ## These are matched against the definition PostgreSQL STORES, not the one the migration wrote
 *
 * The server deparses a view body, and the deparsed form is not the source. Both halves of that were
 * checked against `pg_matviews` on a migrated database rather than reasoned about, because the first
 * version of this list was reasoned about and was wrong in both directions:
 *
 *   * `AT TIME ZONE` survives as `AT TIME ZONE`, upper-cased — so the pattern for it is needed and a
 *     `timezone(...)` pattern alone would have matched nothing, ever. The function spelling is carried as
 *     well, because a definition written that way comes back that way;
 *   * a string literal gains a cast: `date_trunc('month', d)` comes back as `date_trunc('month'::text, d)`,
 *     so a pattern ending the literal at `'` followed by a comma could not see it.
 *
 * ## And every pattern is anchored on a column name ending `_at`, with `+` rather than `*`
 *
 * The distinction the rule draws is that a trading DATE may be reshaped and an INSTANT may not be
 * truncated: `dim_date.business_month` is `date_trunc('month', trading_date)::date` and is correct. The
 * leading class is therefore a prefix of a real identifier and is required to have one — `+`, so the rule
 * cannot match a cast whose operand is a parenthesis. The deparsed `dim_date` body is the control for that
 * in both `schema-rules.test.ts` and `reporting.itest.ts`, because it contains `::date` AND the words
 * `time zone` and still must not be reported.
 */
const INSTANT_TRUNCATIONS: readonly { readonly name: string; readonly pattern: RegExp }[] =
  Object.freeze([
    { name: 'at time zone', pattern: /\bat\s+time\s+zone\b/i },
    { name: 'timezone(zone, <instant>)', pattern: /\btimezone\s*\(/i },
    { name: 'date(<instant>)', pattern: /\bdate\s*\(\s*[a-z0-9_."]+_at\s*\)/i },
    { name: '<instant>::date', pattern: /[a-z0-9_."]+_at\s*\)?\s*::\s*date\b/i },
    {
      name: "date_trunc('…', <instant>)",
      pattern: /date_trunc\s*\(\s*'[^']*'(?:::text)?\s*,\s*[a-z0-9_."]+_at\s*\)/i,
    },
    { name: 'to_char(<instant>, …)', pattern: /to_char\s*\(\s*[a-z0-9_."]+_at\s*,/i },
  ])

/**
 * Facts that are not keyed on `business_day`: a definition that truncates an instant to a date, a fact
 * with no declared business-day column, or a declared column the view does not have.
 *
 * Three findings from one rule because they are three ways to arrive at the same wrong number, and a check
 * that only did the first would pass a fact with a perfectly clean body and no business day at all.
 */
export function factsNotKeyedOnBusinessDay(
  registry: readonly RegistryRow[],
  definitions: readonly DefinitionRow[],
  columns: readonly ColumnRow[],
): readonly Finding[] {
  const findings: Finding[] = []

  for (const row of definitions) {
    for (const truncation of INSTANT_TRUNCATIONS) {
      if (!truncation.pattern.test(row.definition)) continue
      findings.push({
        rule: REPORTING_SCHEMA_RULES.businessDayKey,
        relation: row.relation,
        detail: `its definition truncates an instant with ${truncation.name}; trading runs 11:00-02:00, so 01:30 belongs to the PREVIOUS trading date and the business day comes from business_day rather than from a cast`,
      })
    }
  }

  for (const entry of registry.filter((row) => row.kind === 'fact')) {
    if (entry.businessDayColumn === null) {
      findings.push({
        rule: REPORTING_SCHEMA_RULES.businessDayKey,
        relation: entry.viewName,
        detail:
          'the registry declares it a fact and names no business_day_column, so nothing checks its ' +
          'key against the trading calendar',
      })
      continue
    }
    const declared = entry.businessDayColumn
    if (!columns.some((c) => c.relation === entry.viewName && c.column === declared)) {
      findings.push({
        rule: REPORTING_SCHEMA_RULES.businessDayKey,
        relation: entry.viewName,
        detail: `the registry names ${declared} as its business day and the view has no such column`,
      })
    }
  }

  return findings
}

/**
 * `reportingSchema.materializedView('name', { ... })` blocks in the mirror source, and the DATABASE column
 * name declared in each.
 *
 * Braces are counted rather than a closing line matched, which is the mistake `check-schema-drift.mjs`
 * records making: requiring a newline before the closing brace made a single-line declaration invisible to
 * that gate, and a parser a rule cannot see past is a rule that passes over whatever it could not read.
 */
export function mirroredViewColumns(source: string): ReadonlyMap<string, readonly string[]> {
  const opening = /materializedView\(\s*'([a-z0-9_]+)'\s*,\s*\{/g
  const column =
    /(?:^|[,{]|\n)\s*(?:'[^']+'|[A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*\(\s*'([a-z0-9_]+)'/g
  const out = new Map<string, readonly string[]>()
  for (const match of source.matchAll(opening)) {
    const start = (match.index ?? 0) + match[0].length
    let depth = 1
    let at = start
    while (at < source.length && depth > 0) {
      if (source[at] === '{') depth += 1
      else if (source[at] === '}') depth -= 1
      at += 1
    }
    const body = source.slice(start, at - 1)
    out.set(
      match[1] as string,
      [...body.matchAll(column)].map((found) => found[1] as string),
    )
  }
  return out
}

/**
 * Where the Drizzle mirror and the catalogue disagree about a materialised view, in both directions.
 *
 * Four findings from one rule, because each is a different way for a caller writing from the mirror to
 * compile against a shape the database does not have: a view with no mirror at all, a mirror for a view
 * that is gone, a column the database has and the mirror does not, and the reverse.
 */
export function viewsWhoseMirrorDisagrees(
  mirror: ReadonlyMap<string, readonly string[]>,
  views: readonly string[],
  columns: readonly ColumnRow[],
): readonly Finding[] {
  const findings: Finding[] = []
  const rule = REPORTING_SCHEMA_RULES.mirrorMatchesCatalogue

  for (const view of views) {
    const mirrored = mirror.get(view)
    if (mirrored === undefined) {
      findings.push({ rule, relation: view, detail: 'the database has it and the mirror does not' })
      continue
    }
    const actual = columns.filter((c) => c.relation === view).map((c) => c.column)
    for (const missing of actual.filter((name) => !mirrored.includes(name))) {
      findings.push({
        rule,
        relation: view,
        detail: `${missing} is in the database and not in the mirror`,
      })
    }
    for (const extra of mirrored.filter((name) => !actual.includes(name))) {
      findings.push({
        rule,
        relation: view,
        detail: `${extra} is in the mirror and not in the database`,
      })
    }
  }

  for (const view of [...mirror.keys()].filter((name) => !views.includes(name))) {
    findings.push({ rule, relation: view, detail: 'the mirror has it and the database does not' })
  }

  return findings
}

/** Every finding, in rule order, for a suite that wants one assertion over the whole schema. */
export function reportingSchemaFindings(input: {
  readonly views: readonly string[]
  readonly indexes: readonly IndexRow[]
  readonly columns: readonly ColumnRow[]
  readonly definitions: readonly DefinitionRow[]
  readonly registry: readonly RegistryRow[]
  /** The Drizzle mirror's own source. Read by the caller, so this module touches no file. */
  readonly mirrorSource: string
}): readonly Finding[] {
  return [
    ...viewsWithoutAUsableUniqueIndex(input.views, input.indexes),
    ...moneyColumnsThatAreNotExact(input.columns),
    ...viewsThatReadTheClock(input.definitions),
    ...factsNotKeyedOnBusinessDay(input.registry, input.definitions, input.columns),
    ...viewsWhoseMirrorDisagrees(
      mirroredViewColumns(input.mirrorSource),
      input.views,
      input.columns,
    ),
  ]
}

/** A finding as one line, for a failure message that points at something. */
export const describeFinding = (finding: Finding): string =>
  `[${finding.rule}] reporting.${finding.relation}: ${finding.detail}`
