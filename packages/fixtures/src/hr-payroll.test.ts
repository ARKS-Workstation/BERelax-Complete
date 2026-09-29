import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PLACEHOLDER_WPS_AGENT_ID,
  PLACEHOLDER_WPS_EMPLOYER_ID,
  WPS_SIF_FORMATS,
} from '@berelax/core'
import { PAYROLL_SQLSTATE } from '@berelax/db'
import { describe, expect, it } from 'vitest'

/**
 * P-HR-12 — the claims about the SOURCE, which no behavioural test can make.
 *
 * Every rule here is one an implementation could satisfy behaviourally today and break invisibly tomorrow,
 * which is why this file reads text. It lives in `packages/fixtures` for the reason `hr-commission.test.ts`
 * gives: `packages/core` may not import `node:fs` — the purity gate forbids it — so a test that reads a file
 * cannot live beside the file it reads. And a migration mutation cannot be caught behaviourally at all: the
 * gate runs against an already-migrated database, so weakening `0104_hr_payroll.sql` changes no refusal
 * anybody could observe until somebody rebuilds from it.
 *
 *   1. **Nothing in this unit invents a WPS identifier.** The most important negative claim in the unit and
 *      only visible in the text: a plausible establishment number anywhere — a literal in the migration, a
 *      default in the registry, a fallback in the exporter — would produce a file that passes every check
 *      and pays nineteen people against somebody else's registration (brief rule 15, sharpest instance).
 *
 *   2. **No wage divisor, multiplier or rate is a literal in the payroll arithmetic.** The figures live in
 *      `labour_cost_rule` and `working_hours_rule`. A constant in the engine would pass every test written
 *      against it, because the test would use it too — and the specific constant that matters here is the
 *      ordinary multiplier, which is 10,000 today and whose being hard-coded would be invisible until
 *      somebody published a version that changed it.
 *
 *   3. **A payslip's commission is never recomputed.** `payroll-run.ts` must not call the commission engine.
 *      A payslip that recomputed would resolve "the rule in force" and restate March at June's rates — the
 *      defect ADR 0047 exists to prevent, arriving one layer up.
 *
 *   4. **The tip's liability account is refused structurally, not by convention.** A trigger over another
 *      table's `type` column, which no TypeScript test can express.
 *
 *   5. **The SQLSTATE vocabulary is the same in both places.** The migration's header lists the codes and
 *      `PAYROLL_SQLSTATE` declares them; nothing but this scan reads the header, so a code renamed in one
 *      place and left in the other is invisible to every other check in the repository. Both directions.
 */
const REPO = join(import.meta.dirname, '..', '..', '..')

const CORE = join(REPO, 'packages', 'core', 'src', 'hr', 'payroll.ts')
const WPS = join(REPO, 'packages', 'core', 'src', 'hr', 'wps-sif.ts')
const ORCHESTRATOR = join(REPO, 'packages', 'hr', 'src', 'payroll-run.ts')
const MIGRATION = join(REPO, 'packages', 'db', 'migrations', '0104_hr_payroll.sql')
const REGISTRY = join(REPO, 'packages', 'config', 'src', 'settings', 'registry.ts')

const read = (path: string): string => readFileSync(path, 'utf8')

/** Source with comments removed, for claims about what the code DOES rather than what it explains. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !/^\s*(?:\/\/|\*|--)/.test(line))
    .join('\n')
}

describe('acceptance — no WPS identifier is invented anywhere', () => {
  it('writes no digit-run identifier into the migration, the exporter or the registry', () => {
    /*
      A run of 9 to 20 digits, which is the shape every establishment, MOL and agent code takes. Bounded at
      both ends so it cannot match a fils amount in a test fixture or a year; the files scanned are the three
      that could plausibly carry one.
    */
    const plausible = /\b\d{9,20}\b/
    for (const path of [MIGRATION, WPS, REGISTRY]) {
      const offending = codeOnly(read(path))
        .split('\n')
        .filter((line) => plausible.test(line))
      expect(
        offending,
        `${path.slice(REPO.length + 1)} carries something shaped like a registration number. No WPS ` +
          'identifier is known to this build (Y8-wps), and a plausible one is indistinguishable from a ' +
          'configured one on the file that results.',
      ).toEqual([])
    }
  })

  it('CONTROL: the pattern finds an invented identifier when one is spliced in', () => {
    // Brief rule 3. Without this the assertion above is satisfied by a pattern that matches nothing.
    const plausible = /\b\d{9,20}\b/
    expect(plausible.test("employerId: '204561230001'")).toBe(true)
    expect(plausible.test('const TIP_FILS = 3_125')).toBe(false)
  })

  it('defaults both settings to the SHARED placeholder rather than a second spelling', () => {
    const registry = read(REGISTRY)
    expect(registry).toContain('defaultValue: PLACEHOLDER_WPS_EMPLOYER_ID')
    expect(registry).toContain('defaultValue: PLACEHOLDER_WPS_AGENT_ID')
    /*
      The literal must NOT appear in the registry. `@berelax/config` may not import `@berelax/core`, so the
      tempting fix is to retype the string — and a placeholder the validator no longer recognises reads as
      CONFIGURED, which is `PLACEHOLDER_TRN`'s own recorded lesson. The constants live in `@berelax/shared`,
      which both may import.
    */
    expect(registry).not.toContain('WPS-EMPLOYER-ID-PENDING')
    expect(registry).not.toContain('WPS-AGENT-ID-PENDING')
  })

  it('chooses placeholders that fail validation twice over', () => {
    for (const placeholder of [PLACEHOLDER_WPS_EMPLOYER_ID, PLACEHOLDER_WPS_AGENT_ID]) {
      // It says what it is in words...
      expect(placeholder).toMatch(/PENDING/)
      expect(placeholder).toMatch(/Y8-WPS/)
      // ...and it is not a run of digits, so a validator checking only the shape would refuse it too.
      expect(placeholder).not.toMatch(/^\d+$/)
    }
  })

  it('names the layout as a closed set, so a new one is a new member and not a silent change', () => {
    expect(WPS_SIF_FORMATS).toEqual(['generic_mohre_v1'])
    // The migration's CHECK and the core vocabulary must agree: a layout one admits and the other does not
    // is an export row that stores and a file nothing can produce.
    for (const format of WPS_SIF_FORMATS) {
      expect(read(MIGRATION)).toContain(`'${format}'`)
    }
  })
})

describe('acceptance — no wage figure is a literal in the arithmetic', () => {
  it('reads the ordinary multiplier as an argument and never writes 10000 in the payroll engine', () => {
    /*
      The constant that matters. `working_hours_rule.ordinary_multiplier_bp` is 10,000 today and a literal
      here would agree with the table and keep agreeing after a version changed it — silently overpaying,
      with every figure on the page still reconciling.
    */
    const code = codeOnly(read(CORE))
    expect(code).not.toMatch(/\b10_?000\b/)
    expect(code).toContain('ordinaryMultiplierBp')
  })

  it('CONTROL: the pattern fires on a spliced multiplier constant', () => {
    expect(/\b10_?000\b/.test('const ORDINARY_BP = 10_000')).toBe(true)
    expect(/\b10_?000\b/.test('const ORDINARY_BP = ordinaryMultiplierBp')).toBe(false)
  })

  it('prices a wage through the ONE shared formula rather than dividing here', () => {
    const code = codeOnly(read(CORE))
    expect(code).toContain('filsForWeightedMinuteBp')
    /*
      No division in the payroll module at all. `labour-cost.ts` owns the single division and both callers go
      through it, so the roster forecast and the payslip cannot round differently — and the difference would
      otherwise be read as the rostered-versus-attended variance rather than as two implementations parting
      company.
    */
    expect(code).not.toMatch(/monthlyWageDaysDivisor\s*\*/)
    expect(code).not.toMatch(/Math\.(?:ceil|floor)\s*\([^)]*\/[^)]*\)/)
  })
})

describe('acceptance — a payslip never recomputes what something else decided', () => {
  it('never calls the commission engine from the payroll path', () => {
    const code = codeOnly(read(ORCHESTRATOR))
    for (const forbidden of [
      'computeCommission',
      'commissionRuleFor',
      'executeCommissionRun',
      'recomputeCommissionRun',
      'readCommissionRuleVersions',
    ]) {
      expect(
        code,
        `${forbidden} is reachable from the payroll run. A payslip that recomputed commission would ` +
          'resolve the rule in force and restate a filed month at today’s rates, which is exactly ' +
          'what ADR 0047 built a migration to prevent.',
      ).not.toContain(forbidden)
    }
    // What it DOES call: the read that returns the recorded lines of a run the caller named.
    expect(code).toContain('readCommissionDerivation')
  })

  it('CONTROL: the patterns fire when the engine is spliced into the payroll path', () => {
    expect(codeOnly('const c = computeCommission({})')).toContain('computeCommission')
  })

  it('takes the commission run as an ARGUMENT rather than resolving one', () => {
    const code = codeOnly(read(ORCHESTRATOR))
    expect(code).toContain('commissionRun: CommissionRunPin | null')
    // A function that picked the newest run would make the payslip's pin true and its provenance a guess:
    // a month may have been recomputed three times and the one that was paid is not necessarily the newest.
    expect(code).not.toMatch(/readCommissionRuns\s*\(/)
  })

  it('never re-derives attendance: no punch pairing in the payroll path', () => {
    const code = codeOnly(read(ORCHESTRATOR))
    for (const forbidden of [
      'pairAttendancePunches',
      'summariseWorkedHours',
      'splitWorkedMinutes',
    ]) {
      expect(code).not.toContain(forbidden)
    }
    expect(code).toContain('readTimesheetApprovals')
  })
})

describe('acceptance — the schema states the rules rather than the code remembering them', () => {
  const migration = read(MIGRATION)

  it('refuses a tip against any account whose type is not a liability', () => {
    expect(migration).toContain('assert_tip_is_owed_as_a_liability')
    // The rule, not a list: refusing `revenue` by name would pass an expense or asset account, and a tip
    // booked to an expense account is equally wrong.
    expect(migration).toMatch(/v_type\s*<>\s*'liability'/)
    expect(migration).not.toMatch(/v_type\s*=\s*'revenue'/)
  })

  it('generates the gross and the net rather than accepting them', () => {
    // GENERATED makes a wrong net UNSTORABLE rather than merely detectable, which is stronger than a CHECK
    // comparing two columns somebody wrote — a CHECK still lets a wrong pair be offered.
    expect(migration).toMatch(/gross_fils[\s\S]{0,120}generated always as/)
    expect(migration).toMatch(/net_fils[\s\S]{0,160}generated always as/)
  })

  it('makes the commission pin NOT NULL-able in halves, and holds the version to its run', () => {
    expect(migration).toContain('payslip_commission_pin_is_whole')
    expect(migration).toContain('assert_payslip_commission_is_pinned')
  })

  it('calls the ONE period-lock reader rather than reading period_lock itself', () => {
    expect(migration).toContain('raise_if_period_locked')
    // A second reader of the lock is the defect 0086 and 0097 each recorded avoiding.
    expect(migration).not.toMatch(/from\s+period_lock/)
  })

  it('reads P-HR-07 stored incomplete count rather than pairing punches in SQL', () => {
    expect(migration).toContain('incomplete_presence_count > 0')
    // A SQL re-derivation would be a second implementation of the plausibility ceiling, and the two would
    // disagree the first time that figure was versioned.
    expect(migration).not.toMatch(/from\s+attendance_event/)
  })

  it('seeds nothing: no payroll run, payslip, tip or deduction arrives with the schema', () => {
    const inserts = migration
      .split('\n')
      .filter((line) =>
        /^\s*insert\s+into\s+(?:payroll_run|payslip|employee_tip|payroll_deduction|wps_export)\b/i.test(
          line,
        ),
      )
    expect(
      inserts,
      'the migration seeds a payroll row. Every figure in this estate is somebody’s pay, and a seeded ' +
        'one would be a wage, a tip or a deduction this build invented.',
    ).toEqual([])
  })
})

describe('acceptance — the SQLSTATE vocabulary agrees with the migration that raises it', () => {
  const migration = read(MIGRATION)

  it('declares every code the migration raises, and raises every code it declares', () => {
    const raised = new Set(
      [...migration.matchAll(/errcode\s*=\s*'(ZY1\d\d)'/g)].map((match) => match[1] as string),
    )
    const declared = new Set(Object.values(PAYROLL_SQLSTATE))
    expect([...raised].sort()).toEqual([...declared].sort())
    // Vacuity: a regex that matched nothing would make both sides empty and the comparison true.
    expect(raised.size).toBe(10)
  })

  it('lists the same codes in the migration HEADER, which nothing else reads', () => {
    const header = migration.slice(0, migration.indexOf('begin;'))
    for (const code of Object.values(PAYROLL_SQLSTATE)) {
      expect(header, `${code} is raised but the header does not list it`).toContain(code)
    }
  })

  it('uses the whole allocated band and no code outside it', () => {
    const codes = [...Object.values(PAYROLL_SQLSTATE)].sort()
    expect(codes[0]).toBe('ZY141')
    expect(codes.at(-1)).toBe('ZY150')
    for (const code of codes) expect(code).toMatch(/^ZY1(?:4\d|50)$/)
  })
})
