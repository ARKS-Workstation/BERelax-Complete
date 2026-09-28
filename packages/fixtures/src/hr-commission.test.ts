import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { COMMISSION_BASES, COMMISSION_ROUNDING_MODES, COMMISSION_SOURCES } from '@berelax/core'
import { COMMISSION_SQLSTATE } from '@berelax/db'
import { describe, expect, it } from 'vitest'

/**
 * P-HR-11 — the claims about the SOURCE, which no behavioural test can make.
 *
 * Every rule here is one an implementation could satisfy behaviourally today and break invisibly tomorrow,
 * which is why the file reads text. It lives in `packages/fixtures` for the reason `hr-attendance.test.ts`
 * gives: `packages/core` may not import `node:fs` — the purity gate forbids it — so a test that reads a file
 * cannot live beside the file it reads.
 *
 *   1. **Nothing in 0097 seeds a rate.** This is the unit's most important negative claim and it is only
 *      visible in the text: an `insert into commission_rule` would be a commission structure the build
 *      invented, indistinguishable from a configured one on the payslip that resulted (brief rule 15), and a
 *      behavioural test would simply find a version and price against it.
 *
 *   2. **No rate, threshold or rounding direction is a literal in TypeScript.** The figures live in
 *      `commission_rule` and `commission_rule_band`. A constant in the engine would pass every test written
 *      against it, because the test would use it too.
 *
 *   3. **A recompute does not re-resolve the version.** `recomputeCommissionRun` takes the run and must never
 *      call `commissionRuleFor`. A recompute that resolved would answer with whatever is in force today — the
 *      defect the whole unit is about — and it is INVISIBLE until a second version exists, which in a fresh
 *      database is never.
 *
 *   4. **The period-lock PREDICATE has one reader.** `periodStatusOn` (M-VAT-06) answers "is this date
 *      closed". `commissionPeriodSource` then reads `locked_at` off the row that call named, by primary key,
 *      which is a column of an identified row rather than a second answer — and the difference between those
 *      two things is exactly what a scan can see and a passing test cannot.
 *
 *   5. **The SQLSTATE vocabulary is the same in both places.** The migration's header lists the codes and
 *      `COMMISSION_SQLSTATE` declares them; nothing but this scan reads the header, so a code renamed in one
 *      place and left in the other is invisible to every other check in the repository. Both directions.
 *
 *   6. **The vocabularies the migration CHECKs and the ones `@berelax/core` declares are the same sets.** A
 *      value admitted by one and not the other is a row that stores and a figure that cannot be priced.
 */
const REPO = join(import.meta.dirname, '..', '..', '..')

const CORE = join(REPO, 'packages', 'core', 'src', 'hr', 'commission.ts')
const REPOSITORY = join(REPO, 'packages', 'db', 'src', 'repositories', 'commission.ts')
const ORCHESTRATOR = join(REPO, 'packages', 'hr', 'src', 'commission-run.ts')
const MIGRATION = join(REPO, 'packages', 'db', 'migrations', '0097_hr_commission.sql')

/**
 * Comments, string literals and template literals blanked, so the prose explaining why a rule holds does not
 * read as the rule being broken.
 *
 * Copied from `hr-attendance.test.ts` rather than shared, deliberately, and that file gives the reason: each
 * version is calibrated to its own rules and a shared helper would be one both files then had to agree about.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')
}

function codeOnly(source: string): string {
  return withoutComments(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

/** SQL comments blanked. `--` to end of line; 0097 has no block comments. */
function sqlCodeOnly(source: string): string {
  return source.replace(/--.*/g, '')
}

const core = readFileSync(CORE, 'utf8')
const repository = readFileSync(REPOSITORY, 'utf8')
const orchestrator = readFileSync(ORCHESTRATOR, 'utf8')
const migration = readFileSync(MIGRATION, 'utf8')

describe('acceptance — no commission structure is invented', () => {
  it('seeds no rule version and no band', () => {
    const sql = sqlCodeOnly(migration)
    // The whole of Y9-commission's provisional answer, as a property of the file: nothing is configured.
    // Unlike 0059, 0066, 0081 and 0086, which each seed the build's strictest reading of a law that exists
    // to be read, there is no law about commission and no figure in the handover.
    expect(sql).not.toMatch(/insert\s+into\s+commission_rule\b/i)
    expect(sql).not.toMatch(/insert\s+into\s+commission_rule_band\b/i)
  })

  it('CONTROL: the patterns find a seeded version when one is spliced in', () => {
    // Without this arm the rule above is satisfiable by a pattern that matches nothing at all.
    const spliced = `${migration}
      insert into commission_rule (version, effective_from) values (1, date '1900-01-01');
      insert into commission_rule_band (rule_version_id, band_no, from_fils, rate_bp) values (1, 1, 0, 1000);`
    const sql = sqlCodeOnly(spliced)
    expect(sql).toMatch(/insert\s+into\s+commission_rule\b/i)
    expect(sql).toMatch(/insert\s+into\s+commission_rule_band\b/i)
  })

  it('writes no rate, threshold or rounding direction into TypeScript', () => {
    /*
      The figures are rows. What this looks for is a CONSTANT that would stand in for one.

      Not "no number appears": the engine is full of 10_000 (basis points per unit) and 5_000 (half of it),
      which are the definition of a basis point rather than a rate somebody chose, and `commissionFilsFor`
      could not exist without them. What must not appear is a named default: a `DEFAULT_RATE_BP`, a
      `COMMISSION_RATE`, a fallback band. Those are the shapes in which a rate becomes code, and each of
      them would make every test written against it pass, because the test would use the same constant.
    */
    const text = codeOnly(core)
    for (const forbidden of [
      /\bDEFAULT_[A-Z_]*RATE/,
      /\bCOMMISSION_RATE/,
      /\bDEFAULT_BAND/,
      /\bFALLBACK_[A-Z_]*(RATE|BAND)/,
      /\brateBp\s*[:=]\s*\d/,
      /\bfromFils\s*[:=]\s*\d/,
      /\broundingMode\s*[:=]\s*'/,
    ]) {
      expect(text, String(forbidden)).not.toMatch(forbidden)
    }
    // And the positive half, because an absence is not a mechanism: the rate reaches the arithmetic as an
    // argument off a band, and the rounding mode off the version.
    expect(text).toMatch(
      /commissionFilsFor\(basisFils,\s*band\.rateBp,\s*ruleVersion\.roundingMode\)/,
    )
  })

  it('CONTROL: the constant patterns fire on a spliced default rate', () => {
    const spliced = `${core}\nconst DEFAULT_RATE_BP = 1000\nconst band = { rateBp: 1000 }\n`
    const text = codeOnly(spliced)
    expect(text).toMatch(/\bDEFAULT_[A-Z_]*RATE/)
    expect(text).toMatch(/\brateBp\s*[:=]\s*\d/)
  })
})

describe('acceptance — a recompute uses the version the run names', () => {
  it('never resolves a version by date in the recompute path', () => {
    const text = withoutComments(orchestrator)
    // `commissionRuleFor` is the by-DATE resolver and belongs to the first run only. The recompute finds its
    // version by ID among the published ones.
    const recompute = text.slice(text.indexOf('export async function recomputeCommissionRun'))
    expect(recompute).not.toMatch(/\bcommissionRuleFor\s*\(/)
    expect(recompute).not.toMatch(/\bplanCommissionRun\s*\(/)
    expect(recompute).toMatch(/find\(\(row\) => row\.ruleVersionId === args\.run\.ruleVersionId\)/)
    // And it takes no clock at all, because there is no instant it could use that would not break the claim.
    expect(recompute).not.toMatch(/\bnowIso\b/)
    expect(recompute).not.toMatch(/Date\.now\(\)/)
    expect(recompute).not.toMatch(/new Date\(\)/)
  })

  it('CONTROL: the patterns fire when a resolver is spliced into the recompute', () => {
    const spliced = orchestrator.replace(
      'const pinned = versions.find((row) => row.ruleVersionId === args.run.ruleVersionId)',
      'const pinned = commissionRuleFor(versions.map(asRuleVersion), localDate(args.run.periodStartsOn))',
    )
    const text = withoutComments(spliced)
    const recompute = text.slice(text.indexOf('export async function recomputeCommissionRun'))
    expect(recompute).toMatch(/\bcommissionRuleFor\s*\(/)
    expect(recompute).not.toMatch(
      /find\(\(row\) => row\.ruleVersionId === args\.run\.ruleVersionId\)/,
    )
  })

  it('the first run resolves by date and records the version it chose', () => {
    const text = withoutComments(orchestrator)
    const execute = text.slice(
      text.indexOf('export async function executeCommissionRun'),
      text.indexOf('export interface RecomputeCommissionRunArgs'),
    )
    // The control for the case above in the direction that matters: the by-date resolver EXISTS and is used,
    // so its absence from the recompute is a decision rather than a function nobody wrote.
    expect(execute).toMatch(/planCommissionRun\(/)
  })
})

describe('acceptance — the period-lock predicate has one reader', () => {
  it('asks periodStatusOn and never re-answers which dates are closed', () => {
    const text = withoutComments(repository)
    expect(text).toContain("import { periodStatusOn } from '../services/period-close.ts'")
    // The PREDICATE, which is what must not be re-implemented. `period_lock_for()` and
    // `earliest_open_date_from()` are 0018's and 0073's definitions and every guard in the database reaches
    // them; a second caller here would agree on the day it was written and disagree after the next change.
    expect(text).not.toMatch(/\bperiod_lock_for\s*\(/i)
    expect(text).not.toMatch(/\bearliest_open_date_from\s*\(/i)
  })

  it('reads period_lock exactly once, for locked_at, by primary key', () => {
    const text = withoutComments(repository)
    const reads = [...text.matchAll(/\bfrom\s+period_lock\b/gi)]
    // Exactly one, and it is the `locked_at` read: a column of the row `periodStatusOn` has already
    // identified. That is not a second answer to "which dates are closed" — and the difference between the
    // two is precisely what this case exists to hold, because both look the same in a passing test.
    expect(reads.length).toBe(1)
    expect(text).toMatch(/select locked_at::text as "lockedAt" from period_lock where period_id = /)
  })

  it('CONTROL: the predicate patterns fire when a second reader is spliced in', () => {
    const spliced = `${repository}
      async function alsoAsks(sql) {
        return sql\`select period_lock_for($1::date), earliest_open_date_from($1::date)\`
      }`
    const text = withoutComments(spliced)
    expect(text).toMatch(/\bperiod_lock_for\s*\(/i)
    expect(text).toMatch(/\bearliest_open_date_from\s*\(/i)
  })

  it('the DATABASE guard calls period_lock_for rather than reading the table', () => {
    const sql = sqlCodeOnly(migration)
    const guard = sql.slice(
      sql.indexOf('create function assert_commission_run_reads_the_lock'),
      sql.indexOf('create trigger commission_run_reads_the_lock'),
    )
    // The other half of the same rule, one layer down: the trigger is another CALLER of the one definition
    // and not a second reading of the table. It does read `period_lock` for `locked_at`, by primary key,
    // which is the same distinction the repository draws.
    expect(guard).toMatch(/period_lock_for\(new\.period_ends_on\)/)
    expect(guard).toMatch(/select locked_at into v_locked_at from period_lock where period_id = /)
    // And it decides on the period END, which the message and the comment both say. A guard that tested the
    // START would pass a run over a month whose last day is filed.
    expect(guard).not.toMatch(/period_lock_for\(new\.period_starts_on\)/)
  })
})

describe('acceptance — an instant parameter never loses its microseconds', () => {
  /*
    The subtlest defect this unit shipped, and it is only visible in the text.

    postgres.js infers a parameter's type from the cast that follows it, so `${iso}::timestamptz` is sent as
    an OID 1184 parameter and serialised by the driver's own date serialiser — `new Date(v).toISOString()`,
    which is MILLISECOND precision. A `timestamptz` column holds MICROSECONDS, so the lock instant the
    repository had just read out of `period_lock` came back 633 microseconds early and
    `assert_commission_run_reads_the_lock` (ZY076) refused every run over the filed month. Three cases
    failed and all three looked like a trigger bug.

    `${iso}::text::timestamptz` is inferred as text and the exact string survives. No behavioural test can
    hold that, because the wrong form works for every instant whose microseconds happen to be zero — which
    is every instant a test writes by hand.
  */
  /** A parameter cast straight to `timestamptz`: the form the driver truncates. */
  const bareInstantCasts = (source: string): number =>
    [...withoutComments(source).matchAll(/\}::timestamptz/g)].length

  /** A parameter cast through `text` first: the form that survives. */
  const safeInstantCasts = (source: string): number =>
    [...withoutComments(source).matchAll(/\}::text::timestamptz/g)].length

  it('casts every instant through ::text first', () => {
    expect(bareInstantCasts(repository)).toBe(0)
    // The control: there ARE instant parameters, so the zero above is about their form rather than about a
    // file that happens to contain none.
    expect(safeInstantCasts(repository)).toBeGreaterThan(5)
  })

  it('CONTROL: the pattern fires on a bare cast', () => {
    const spliced = `${repository}\nconst q = sql\`select 1 where created_at <= \${asOf}::timestamptz\`\n`
    expect(bareInstantCasts(spliced)).toBe(1)
    expect(safeInstantCasts(spliced)).toBe(safeInstantCasts(repository))
  })
})

describe('acceptance — the arithmetic exists in both layers and says so', () => {
  it('states the formula in SQL, multiplying before dividing', () => {
    const sql = sqlCodeOnly(migration)
    const fn = sql.slice(
      sql.indexOf('create function commission_fils_for'),
      sql.indexOf('comment on function commission_fils_for'),
    )
    expect(fn).toContain('(p_basis_fils * p_rate_bp) / 10000')
    expect(fn).toContain('(p_basis_fils * p_rate_bp + 5000) / 10000')
    // Never a numeric or a float: `/ 10000.0` and `::numeric` are the two shapes that would round money.
    expect(fn).not.toMatch(/10000\.0/)
    expect(fn).not.toMatch(/::numeric/i)
    // And it refuses an unknown mode rather than falling through, which is what stops a mode nobody
    // implemented silently becoming `floor`.
    expect(fn).toContain('CommissionRoundingModeUnknown')
  })

  it('states the same formula in TypeScript, and refuses an unknown mode there too', () => {
    const text = withoutComments(core)
    expect(text).toContain('Math.floor(scaled / 10_000)')
    expect(text).toContain('Math.floor((scaled + 5_000) / 10_000)')
    expect(text).toContain('not a commission rounding mode')
  })

  it('holds every line to the formula in the database, not only in the engine', () => {
    const sql = sqlCodeOnly(migration)
    const guard = sql.slice(
      sql.indexOf('create function assert_commission_line_follows_its_rule'),
      sql.indexOf('comment on function assert_commission_line_follows_its_rule'),
    )
    // Without this trigger a run could store any figure at all and satisfy every other constraint, so
    // "recomputing reproduces the stored line" would be a claim about whichever program wrote it.
    expect(guard).toContain('commission_fils_for(new.basis_fils, new.rate_bp, v_rounding)')
    expect(guard).toContain('new.band_no <> v_band_no')
    expect(guard).toContain('new.rate_bp <> v_band_rate')
  })
})

describe('acceptance — the run pins its version and the line cannot disagree', () => {
  it('makes the line’s version the run’s own fact, by composite foreign key', () => {
    const sql = sqlCodeOnly(migration)
    expect(sql).toContain('constraint commission_run_rule_version_pin unique (id, rule_version_id)')
    expect(sql).toMatch(
      /constraint commission_line_pins_its_runs_rule_version\s*\n\s*foreign key \(run_id, rule_version_id\) references commission_run \(id, rule_version_id\)/,
    )
    // NOT NULL on the line, which is the acceptance line's own words.
    expect(sql).toMatch(/rule_version_id\s+uuid\s+not null,/)
  })

  it('references business_day from nowhere, because every table here is append-only', () => {
    const sql = sqlCodeOnly(migration)
    // P-HR-06 found this as eleven failures in a suite it did not own: a RESTRICT reference from an
    // append-only table pins every trading date it names for ever and breaks `generateBusinessDays`.
    expect(sql).not.toMatch(/references\s+business_day\b/i)
    // The CONTROL: the file does declare `trading_date` columns, so the absence above is about the
    // reference rather than about a pattern that could not match anything.
    expect(sql).toMatch(/trading_date\s+date\s+not null/)
  })

  it('revokes UPDATE and DELETE from the application role on all four tables', () => {
    const sql = sqlCodeOnly(migration)
    // Privileges AND triggers, and neither is the other's backup: the grant covers the application role and
    // a migration, a psql session and a restore do not connect as it.
    expect(sql).toMatch(
      /revoke update, delete\s*\n\s*on commission_rule, commission_rule_band, commission_run, commission_line\s*\n\s*from berelax_app/,
    )
    for (const table of [
      'commission_rule',
      'commission_rule_band',
      'commission_run',
      'commission_line',
    ]) {
      expect(sql, `${table} update`).toMatch(
        new RegExp(`create trigger \\w+ before update on ${table}\\b`),
      )
      expect(sql, `${table} delete`).toMatch(
        new RegExp(`create trigger \\w+ before delete on ${table}\\b`),
      )
    }
  })
})

describe('acceptance — one vocabulary, stated once', () => {
  it('declares every SQLSTATE the migration raises, and raises every one it declares', () => {
    const raised = new Set(
      [...migration.matchAll(/errcode = '([A-Z0-9]{5})'/g)].map((match) => match[1] as string),
    )
    const declared = new Set<string>(Object.values(COMMISSION_SQLSTATE))
    expect([...raised].sort()).toEqual([...declared].sort())
    // Inside the allocated band, and the band is the unit's — the CLASS no longer identifies a file (0091).
    for (const code of declared) {
      expect(Number(code.slice(2)), code).toBeGreaterThanOrEqual(71)
      expect(Number(code.slice(2)), code).toBeLessThanOrEqual(80)
      expect(code.slice(0, 2), code).toBe('ZY')
    }
    // And the header lists them, because that list is what the next unit reads before taking a code.
    for (const code of declared) {
      expect(migration, code).toMatch(new RegExp(`^--\\s+${code}\\s`, 'm'))
    }
  })

  it('CHECKs exactly the values @berelax/core declares, in both directions', () => {
    const sql = sqlCodeOnly(migration)
    const listOf = (constraint: string): readonly string[] => {
      const at = sql.indexOf(constraint)
      expect(at, constraint).toBeGreaterThan(-1)
      const window = sql.slice(at, at + 400)
      const inList = /in \(([^)]*)\)/.exec(window)
      expect(inList, constraint).not.toBeNull()
      return [...(inList?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string)
    }
    // A value admitted by one side and not the other is a row that stores and a figure that cannot be
    // priced — and `packages/hr/src/commission-run.ts` narrows the column to the union with a cast, which is
    // exactly the place a mismatch would be invisible.
    expect([...listOf('commission_rule_basis_known')].sort()).toEqual([...COMMISSION_BASES].sort())
    expect([...listOf('commission_rule_rounding_mode_known')].sort()).toEqual(
      [...COMMISSION_ROUNDING_MODES].sort(),
    )
    expect([...listOf('commission_line_source_known')].sort()).toEqual(
      [...COMMISSION_SOURCES].sort(),
    )
  })
})
