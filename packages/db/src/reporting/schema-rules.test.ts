import { describe, expect, it } from 'vitest'
import {
  type ColumnRow,
  type DefinitionRow,
  describeFinding,
  factsNotKeyedOnBusinessDay,
  type IndexRow,
  mirroredViewColumns,
  moneyColumnsThatAreNotExact,
  REPORTING_SCHEMA_RULES,
  type RegistryRow,
  reportingSchemaFindings,
  viewsThatReadTheClock,
  viewsWhoseMirrorDisagrees,
  viewsWithoutAUsableUniqueIndex,
} from './schema-rules.ts'

/**
 * The four reporting-schema rules, each handed a corpus that DOES violate it (ADR 0002, ADR 0003).
 *
 * `packages/db/src/reporting.itest.ts` hands the same functions the real catalogue and requires NO
 * findings. On its own that assertion is satisfied by a predicate that has stopped matching anything, which
 * is the failure mode this whole gate suite exists for — so this file is the other half, and it is a unit
 * test because these are pure functions over rows and need no database to be wrong in front of.
 *
 * Every case pairs the violation with the control that must pass: the rule has to tell the two apart, not
 * merely fire. `dim_date.business_month` is the control that matters most — it is a real cast to `date` in
 * a shipped view, and an earlier version of the instant-truncation pattern reported it.
 */

/** A correct corpus: the shape of the seven shipped views, reduced to what each rule reads. */
const VIEWS = ['dim_date', 'fact_sale'] as const

const INDEXES: readonly IndexRow[] = [
  {
    relation: 'dim_date',
    indexName: 'dim_date_business_day_key',
    isUnique: true,
    isPartial: false,
    isExpression: false,
  },
  {
    relation: 'fact_sale',
    indexName: 'fact_sale_key',
    isUnique: true,
    isPartial: false,
    isExpression: false,
  },
  {
    relation: 'fact_sale',
    indexName: 'fact_sale_business_day_idx',
    isUnique: false,
    isPartial: false,
    isExpression: false,
  },
]

const COLUMNS: readonly ColumnRow[] = [
  { relation: 'dim_date', column: 'business_day', type: 'date' },
  { relation: 'dim_date', column: 'open_minutes', type: 'integer' },
  { relation: 'fact_sale', column: 'business_day', type: 'date' },
  { relation: 'fact_sale', column: 'net_fils', type: 'bigint' },
  { relation: 'fact_sale', column: 'gross_fils', type: 'bigint' },
]

/**
 * Deparsed definitions, in the form PostgreSQL stores rather than the form the migration wrote.
 *
 * `dim_date`'s line is copied from `pg_matviews` on a migrated database, `::timestamp with time zone` and
 * all, because that spelling is the reason the `::date` pattern is anchored with `+` instead of `*`.
 */
const DEFINITIONS: readonly DefinitionRow[] = [
  {
    relation: 'dim_date',
    definition:
      ' SELECT bd.trading_date AS business_day, bd.opens_at, (bd.duration_seconds / 60) AS open_minutes,' +
      " (date_trunc('month'::text, (bd.trading_date)::timestamp with time zone))::date AS business_month" +
      ' FROM business_day bd;',
  },
  {
    relation: 'fact_sale',
    definition:
      ' SELECT i.id AS document_id, i.tax_point_date AS business_day, i.issued_at,' +
      ' (i.net_total)::bigint AS net_fils FROM invoice i;',
  },
]

const REGISTRY: readonly RegistryRow[] = [
  { viewName: 'dim_date', kind: 'dimension', businessDayColumn: 'business_day' },
  { viewName: 'fact_sale', kind: 'fact', businessDayColumn: 'business_day' },
]

/**
 * A mirror source declaring exactly the two views above, with exactly their columns.
 *
 * Written as source text rather than built from the real file, so this corpus can be made to disagree in
 * each of the four directions without editing anything shipped. The real mirror is compared to the real
 * catalogue by `packages/db/src/reporting.itest.ts`.
 */
const MIRROR_SOURCE = [
  'export const dimDate = reportingSchema',
  "  .materializedView('dim_date', {",
  "    businessDay: date('business_day'),",
  "    openMinutes: integer('open_minutes'),",
  '  })',
  '  .existing()',
  '',
  'export const factSale = reportingSchema',
  "  .materializedView('fact_sale', {",
  "    businessDay: date('business_day'),",
  "    netFils: bigint('net_fils', { mode: 'bigint' }),",
  "    grossFils: bigint('gross_fils', { mode: 'bigint' }),",
  '  })',
  '  .existing()',
].join('\n')

const rulesOf = (findings: readonly { readonly rule: string }[]): string[] =>
  findings.map((finding) => finding.rule)

describe('the correct corpus is clean, which is what makes every case below mean something', () => {
  it('reports nothing over the shape the shipped schema has', () => {
    const findings = reportingSchemaFindings({
      views: [...VIEWS],
      indexes: INDEXES,
      columns: COLUMNS,
      definitions: DEFINITIONS,
      registry: REGISTRY,
      mirrorSource: MIRROR_SOURCE,
    })
    expect(findings.map(describeFinding)).toEqual([])
  })

  it('reads a non-empty corpus, so "no findings" is not "nothing was examined"', () => {
    // The control for the control. Every assertion in this file is over a difference against this corpus,
    // and a difference against nothing is nothing.
    expect(VIEWS.length).toBeGreaterThan(1)
    expect(INDEXES.length).toBeGreaterThan(2)
    expect(COLUMNS.length).toBeGreaterThan(4)
    expect(DEFINITIONS.every((row) => row.definition.length > 60)).toBe(true)
  })
})

describe(REPORTING_SCHEMA_RULES.uniqueIndex, () => {
  it('reports a view with no index at all — which contributes no index rows to derive it from', () => {
    const findings = viewsWithoutAUsableUniqueIndex(
      [...VIEWS, 'fact_shift'],
      // Deliberately no row for fact_shift. A function that derived its relation set from the index rows
      // could never report this case, and this is the case that matters: a view nobody indexed.
      INDEXES,
    )
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.uniqueIndex])
    expect(findings[0]?.relation).toBe('fact_shift')
    expect(findings[0]?.detail).toContain('no unique index at all')
  })

  it('reports a unique index that is PARTIAL, which satisfies indisunique and not PostgreSQL', () => {
    const findings = viewsWithoutAUsableUniqueIndex(['dim_date'], [
      { ...INDEXES[0], isPartial: true },
    ] as readonly IndexRow[])
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.uniqueIndex])
    expect(findings[0]?.detail).toContain('partial or over an expression')
  })

  it('reports a unique index over an EXPRESSION for the same reason', () => {
    const findings = viewsWithoutAUsableUniqueIndex(['dim_date'], [
      { ...INDEXES[0], isExpression: true },
    ] as readonly IndexRow[])
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.uniqueIndex])
  })

  it('accepts a plain unique index, so the rule is not simply always firing', () => {
    expect(viewsWithoutAUsableUniqueIndex([...VIEWS], INDEXES)).toEqual([])
  })
})

describe(REPORTING_SCHEMA_RULES.moneyIsBigintFils, () => {
  it('reports a fils column that is not bigint — the shape sum(bigint) produces', () => {
    const findings = moneyColumnsThatAreNotExact([
      ...COLUMNS,
      { relation: 'fact_sale', column: 'takings_fils', type: 'numeric' },
    ])
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.moneyIsBigintFils])
    expect(findings[0]?.detail).toContain('inexact')
  })

  it('reports a SCALED numeric, which is a different wrong answer and still not integer fils', () => {
    const findings = moneyColumnsThatAreNotExact([
      { relation: 'fact_sale', column: 'gross_fils', type: 'numeric(12,2)' },
    ])
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.moneyIsBigintFils])
    expect(findings[0]?.detail).toContain('numeric(12,2)')
  })

  it('reports an inexact column under a name that says nothing about money', () => {
    // The direction the `_fils` rule cannot see, which is why the whole schema is scanned.
    const findings = moneyColumnsThatAreNotExact([
      { relation: 'dim_date', column: 'utilisation', type: 'double precision' },
    ])
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.moneyIsBigintFils])
  })

  it('reports a fils column that is an exact type but the WRONG exact type', () => {
    const findings = moneyColumnsThatAreNotExact([
      { relation: 'fact_sale', column: 'net_fils', type: 'integer' },
    ])
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.moneyIsBigintFils])
    expect(findings[0]?.detail).toContain('a fils column is bigint')
  })

  it('accepts bigint fils beside integer minutes and date keys', () => {
    expect(moneyColumnsThatAreNotExact(COLUMNS)).toEqual([])
  })
})

describe(REPORTING_SCHEMA_RULES.clockFree, () => {
  it('reports a definition holding now()', () => {
    const findings = viewsThatReadTheClock([
      {
        relation: 'dim_customer',
        definition: ' SELECT c.id, (now() - c.created_at) AS age FROM customer c;',
      },
    ])
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.clockFree])
    expect(findings[0]?.detail).toContain('now()')
  })

  it('reports CURRENT_DATE, which is the spelling a date-shaped view reaches for', () => {
    const findings = viewsThatReadTheClock([
      { relation: 'dim_date', definition: ' SELECT (CURRENT_DATE - bd.trading_date) AS age_days' },
    ])
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.clockFree])
  })

  it('accepts a definition that merely SELECTS an instant column', () => {
    // `issued_at` and `opens_at` are in two shipped definitions. A rule matching on the word "time" or a
    // `_at` column would fire on both, and would then be switched off.
    expect(viewsThatReadTheClock(DEFINITIONS)).toEqual([])
  })
})

describe(REPORTING_SCHEMA_RULES.businessDayKey, () => {
  it('reports AT TIME ZONE in the spelling the server actually stores', () => {
    // Copied from `pg_get_viewdef` rather than from the source: the server keeps `AT TIME ZONE`, upper-cased,
    // and adds `::text` to the zone. A rule matching only a `timezone(...)` call would see nothing here,
    // which is the version of this list that shipped first.
    const findings = factsNotKeyedOnBusinessDay(
      REGISTRY,
      [
        {
          relation: 'fact_sale',
          definition:
            " SELECT i.id, ((i.issued_at AT TIME ZONE 'Asia/Dubai'::text))::date AS business_day" +
            ' FROM invoice i;',
        },
      ],
      COLUMNS,
    )
    expect(rulesOf(findings)).toContain(REPORTING_SCHEMA_RULES.businessDayKey)
    expect(findings.map(describeFinding).join('\n')).toContain('at time zone')
  })

  it('reports the function spelling of the same thing', () => {
    const findings = factsNotKeyedOnBusinessDay(
      REGISTRY,
      [
        {
          relation: 'fact_sale',
          definition:
            " SELECT i.id, (timezone('Asia/Dubai'::text, i.issued_at))::date AS business_day FROM invoice i;",
        },
      ],
      COLUMNS,
    )
    expect(rulesOf(findings)).toContain(REPORTING_SCHEMA_RULES.businessDayKey)
    expect(findings.map(describeFinding).join('\n')).toContain('timezone')
  })

  it('reports date(<instant>) and <instant>::date separately, because they are written separately', () => {
    const viaDate = factsNotKeyedOnBusinessDay(
      REGISTRY,
      [{ relation: 'fact_sale', definition: ' SELECT date(i.issued_at) AS business_day' }],
      COLUMNS,
    )
    const viaCast = factsNotKeyedOnBusinessDay(
      REGISTRY,
      [{ relation: 'fact_sale', definition: ' SELECT (i.issued_at)::date AS business_day' }],
      COLUMNS,
    )
    expect(viaDate.map((f) => f.detail).join()).toContain('date(<instant>)')
    expect(viaCast.map((f) => f.detail).join()).toContain('<instant>::date')
  })

  it("reports date_trunc('day', <instant>) and to_char(<instant>, …)", () => {
    const findings = factsNotKeyedOnBusinessDay(
      REGISTRY,
      [
        {
          relation: 'fact_sale',
          definition:
            " SELECT date_trunc('day'::text, i.issued_at), to_char(i.issued_at, 'YYYY-MM'::text)",
        },
      ],
      COLUMNS,
    )
    expect(findings.length).toBe(2)
  })

  it('does NOT report dim_date.business_month, a real cast to date over a trading DATE', () => {
    // The control that earned its place, and the reason the patterns were checked against `pg_matviews`
    // instead of against the SQL as written. `DEFINITIONS` holds the deparsed `dim_date` body, which
    // contains `::date` AND the words `time zone` — `(date_trunc('month'::text, (bd.trading_date)::timestamp
    // with time zone))::date` — and is a correct, shipped column. A rule that fires on it is a rule
    // somebody switches off, so the two things that keep it quiet are load-bearing: the `_at` anchor needs a
    // real identifier before it, and `at time zone` is matched as three words rather than as two.
    expect(DEFINITIONS[0]?.definition).toContain('time zone')
    expect(DEFINITIONS[0]?.definition).toContain('::date')
    expect(factsNotKeyedOnBusinessDay(REGISTRY, DEFINITIONS, COLUMNS)).toEqual([])
  })

  it('reports a fact whose registry row declares no business day at all', () => {
    const findings = factsNotKeyedOnBusinessDay(
      [{ viewName: 'fact_sale', kind: 'fact', businessDayColumn: null }],
      DEFINITIONS,
      COLUMNS,
    )
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.businessDayKey])
    expect(findings[0]?.detail).toContain('names no business_day_column')
  })

  it('reports a fact whose declared business-day column the view does not have', () => {
    const findings = factsNotKeyedOnBusinessDay(
      [{ viewName: 'fact_sale', kind: 'fact', businessDayColumn: 'trading_day' }],
      DEFINITIONS,
      COLUMNS,
    )
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.businessDayKey])
    expect(findings[0]?.detail).toContain('no such column')
  })

  it('does not demand a business day of a DIMENSION', () => {
    // `dim_service` and `dim_staff` are not dated, and a rule that demanded a trading date of every
    // relation would have to be given an exception list — which is the shape that goes stale.
    expect(
      factsNotKeyedOnBusinessDay(
        [{ viewName: 'dim_service', kind: 'dimension', businessDayColumn: null }],
        [],
        COLUMNS,
      ),
    ).toEqual([])
  })
})

describe(REPORTING_SCHEMA_RULES.mirrorMatchesCatalogue, () => {
  it('reads a column set out of each materializedView block, nested braces and all', () => {
    // `bigint('net_fils', { mode: 'bigint' })` has a brace inside the column definition, so a parser that
    // ended the block at the first `}` would stop half way through fact_sale and report its remaining
    // columns as absent from the mirror. That is the shape the real mirror is written in.
    const parsed = mirroredViewColumns(MIRROR_SOURCE)
    expect([...parsed.keys()]).toEqual(['dim_date', 'fact_sale'])
    expect(parsed.get('fact_sale')).toEqual(['business_day', 'net_fils', 'gross_fils'])
  })

  it('reports a view the database has and the mirror does not', () => {
    const findings = viewsWhoseMirrorDisagrees(
      mirroredViewColumns(MIRROR_SOURCE),
      [...VIEWS, 'fact_shift'],
      COLUMNS,
    )
    expect(rulesOf(findings)).toEqual([REPORTING_SCHEMA_RULES.mirrorMatchesCatalogue])
    expect(findings[0]?.relation).toBe('fact_shift')
  })

  it('reports a mirror for a view the database does not have', () => {
    const findings = viewsWhoseMirrorDisagrees(
      mirroredViewColumns(MIRROR_SOURCE),
      ['dim_date'],
      COLUMNS,
    )
    expect(findings.map((finding) => finding.relation)).toEqual(['fact_sale'])
    expect(findings[0]?.detail).toContain('the mirror has it and the database does not')
  })

  it('reports a column in the database that the mirror renamed', () => {
    const renamed = MIRROR_SOURCE.replace("integer('open_minutes')", "integer('open_minute')")
    const findings = viewsWhoseMirrorDisagrees(mirroredViewColumns(renamed), [...VIEWS], COLUMNS)
    // Both directions of one rename, which is what makes the message point at the change rather than at a
    // column that has gone missing for no reason anybody can see.
    expect(findings.map((finding) => finding.detail)).toEqual([
      'open_minutes is in the database and not in the mirror',
      'open_minute is in the mirror and not in the database',
    ])
  })

  it('accepts the mirror that matches, so the rule is not simply always firing', () => {
    expect(
      viewsWhoseMirrorDisagrees(mirroredViewColumns(MIRROR_SOURCE), [...VIEWS], COLUMNS),
    ).toEqual([])
  })
})
