import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ATTENDANCE_OUTCOMES, INCOMPLETE_REASONS } from '@berelax/core'
import { ATTENDANCE_SQLSTATE } from '@berelax/db'
import { describe, expect, it } from 'vitest'

/**
 * P-HR-07 — the claims about the SOURCE, which no behavioural test can make.
 *
 * Four of this unit's claims are statements about text, and each one is a rule that an implementation could
 * satisfy behaviourally today and break invisibly tomorrow. So this file reads the text. It lives in
 * `packages/fixtures` for the reason `hr-rota.test.ts` gives: `packages/core` may not import `node:fs` — the
 * purity gate forbids it — so a test that reads a file cannot live beside the file it reads.
 *
 *   1. **There is ONE reader of the period lock.** `periodStatusOn` (M-VAT-06) over `period_lock_for()` and
 *      `earliest_open_date_from()`. A timesheet refused by one rule and permitted by another is the defect
 *      that arrangement exists to prevent, and the way it arrives is not a wrong answer — it is somebody
 *      adding a second `select ... from period_lock` because it was two lines shorter than an import. Only a
 *      source scan can see that, because the second reader agrees with the first on the day it is written.
 *
 *   2. **Attendance is measured against the PUBLISHED version and never against a draft `shift`.** That is
 *      P-HR-06's deferral in its own words, and it is unobservable in a passing test: a reader pointed at
 *      `shift` returns the same rows for a week nobody has edited, and diverges only months later when
 *      somebody rewrites a roster — at which point a therapist who was on time becomes late on a day already
 *      paid.
 *
 *   3. **No table in 0086 references `business_day`.** The rows are append-only, so a RESTRICT reference
 *      would pin every trading date named for ever and break `generateBusinessDays` — eleven failing cases in
 *      a suite this unit does not own, which is how P-HR-06 found it. A behavioural test in THIS file cannot
 *      see it; only the other suite can, and only after it has already failed.
 *
 *   4. **The SQLSTATE vocabulary is the same in both places.** The migration's header lists the five codes
 *      and `ATTENDANCE_SQLSTATE` declares them, and nothing but this scan reads the header — so a code
 *      renamed in one place and left in the other is invisible to every other check in the repository. Both
 *      directions, because the direction that catches a rename is the one nobody writes.
 */
const REPO = join(import.meta.dirname, '..', '..', '..')

const CORE = join(REPO, 'packages', 'core', 'src', 'hr', 'attendance.ts')
const REPOSITORY = join(REPO, 'packages', 'db', 'src', 'repositories', 'timesheet.ts')
const MIGRATION = join(REPO, 'packages', 'db', 'migrations', '0086_attendance.sql')

/**
 * Comments, string literals and template literals blanked, so the prose explaining why a second reader is
 * absent does not read as the second reader being present.
 *
 * Copied from `hr-rota.test.ts` rather than shared, deliberately, and that file gives the reason: its version
 * is calibrated to its own rules and a shared helper would be one both files then had to agree about. The
 * mistake it exists to prevent has been made in this repository — `check-schema-conventions.mjs` records
 * reporting the word "timestamp" in a sentence about timestamps.
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

/** SQL comments blanked. `--` to end of line, and there are no block comments in these migrations. */
function sqlCodeOnly(source: string): string {
  return source.replace(/--.*/g, '')
}

const core = readFileSync(CORE, 'utf8')
const repository = readFileSync(REPOSITORY, 'utf8')
const migration = readFileSync(MIGRATION, 'utf8')

/**
 * Every way the repository could be answering "is this period closed?" for itself.
 *
 * The template literals are KEPT for these, because a SQL query lives in one — `codeOnly` would blank the
 * very text the rule is looking for. That is the calibration `hr-rota.test.ts` records getting wrong first
 * time: a pattern stripped of the thing it looks for reports clean because it could not report anything else,
 * and the control below is what proves these can still find something.
 */
const SECOND_LOCK_READER = [
  { rule: 'queries period_lock directly', re: /\bfrom\s+period_lock\b/i },
  { rule: 'calls period_lock_for itself', re: /\bperiod_lock_for\s*\(/i },
  { rule: 'calls earliest_open_date_from itself', re: /\bearliest_open_date_from\s*\(/i },
  { rule: 'computes an earliest open date', re: /\bearliestOpen[A-Za-z]*\s*=/ },
] as const

describe('acceptance — the period lock has exactly one reader', () => {
  it('reaches the lock only through periodStatusOn', () => {
    const text = withoutComments(repository)
    expect(text).toContain("import { periodStatusOn } from '../services/period-close.ts'")
    const found = SECOND_LOCK_READER.filter((pattern) => pattern.re.test(text)).map(
      (pattern) => pattern.rule,
    )
    expect(found).toEqual([])
  })

  it('CONTROL: the patterns find a second reader when one is spliced in', () => {
    // Without this arm the rule above is satisfiable by a pattern that matches nothing at all, which is
    // exactly how `hr-rota.test.ts`'s equivalent first went vacuous.
    const spliced = `${repository}
      async function alsoAsks(sql) {
        return sql\`select period_lock_for($1::date), earliest_open_date_from($1::date) from period_lock\`
      }`
    const found = SECOND_LOCK_READER.filter((pattern) =>
      pattern.re.test(withoutComments(spliced)),
    ).map((pattern) => pattern.rule)
    expect(found).toContain('queries period_lock directly')
    expect(found).toContain('calls period_lock_for itself')
    expect(found).toContain('calls earliest_open_date_from itself')
  })

  it('does not restate the lock refusal message, which 0073 owns', () => {
    // `raise_if_period_locked()` is called by both triggers in 0086 and nothing here re-raises ZL002 with a
    // message of its own. A second wording would drift from the one 0073 redefined to name the earliest OPEN
    // date, and the drift would be a refusal that sends somebody to a month they also cannot use.
    expect(sqlCodeOnly(migration)).toContain('perform raise_if_period_locked(')
    expect(sqlCodeOnly(migration)).not.toContain("errcode = 'ZL002'")
  })
})

describe('acceptance — attendance is measured against the published rota version', () => {
  it('reads rota_version_assignment and never shift', () => {
    const text = codeOnly(repository)
    // `codeOnly` blanks the template literals, so the SQL is checked on the raw source with comments
    // removed — and the absence of `shift` is checked there too, for the same reason.
    const sqlText = withoutComments(repository)
    expect(sqlText).toMatch(/\bfrom\s+rota_version_assignment\b/)
    expect(sqlText).not.toMatch(/\bfrom\s+shift\b/)
    expect(sqlText).not.toMatch(/\bjoin\s+shift_assignment\b/)
    // And nothing in the module names a shift at all, so there is no half-written path to one.
    expect(text).not.toMatch(/\bshiftId\b/)
  })

  it('CONTROL: the patterns find a draft read when one is spliced in', () => {
    const spliced = `${repository}
      async function draftSpans(sql) {
        return sql\`select s.id from shift s join shift_assignment sa on sa.shift_id = s.id\`
      }`
    expect(withoutComments(spliced)).toMatch(/\bfrom\s+shift\b/)
    expect(withoutComments(spliced)).toMatch(/\bjoin\s+shift_assignment\b/)
  })

  it('the approval pins the version it was measured against, rather than recording it as a date', () => {
    // A KEY and not a plain column, which is the one reference in 0086 that is a precondition rather than
    // provenance: a plain column would let a timesheet be approved against a version nobody published.
    expect(sqlCodeOnly(migration)).toMatch(
      /rota_version_id\s+uuid\s+not null references rota_version \(id\) on delete restrict/,
    )
  })
})

describe('acceptance — no append-only table pins a generated parent', () => {
  it('references business_day from nowhere in 0086', () => {
    // The rows here can never be deleted, so a RESTRICT reference would pin every trading date named for
    // ever and stop `generateBusinessDays` removing a date that had stopped trading — eleven failing cases in
    // `business-days.itest.ts`, a suite this unit does not own, which is how P-HR-06 found it.
    expect(sqlCodeOnly(migration)).not.toMatch(/references\s+business_day\b/i)
    // It still READS the calendar, which is the point: `attendance_trading_date_for()` derives the trading
    // date from `business_day` without referencing it, so the guard exists and the pin does not.
    expect(sqlCodeOnly(migration)).toMatch(/from business_day bd/)
  })

  it('references only tables that already cannot be deleted, plus employee', () => {
    const referenced = [...sqlCodeOnly(migration).matchAll(/references\s+([a-z_]+)\s*\(/gi)].map(
      (match) => match[1],
    )
    // `employee` is 0030's decision — deleting a person to erase their roster is the delete worth refusing.
    // `rota_version` and `attendance_event` are themselves append-only, so the pin is on a row nothing could
    // release anyway, which is the case 0081 keeps its own self-references for.
    expect(new Set(referenced)).toEqual(new Set(['employee', 'rota_version', 'attendance_event']))
  })

  it('refuses a punch off a whole minute at the column, where the value arrives', () => {
    // `workedMinutes` in @berelax/core refuses a span off a whole minute, so seconds admitted here would
    // surface as a thrown pricing call on a screen rather than as a rejected punch at the desk.
    expect(sqlCodeOnly(migration)).toContain(
      "check (date_trunc('minute', occurred_at) = occurred_at)",
    )
  })

  it('bounds the punch tolerance below half the gap between one day’s close and the next day’s open', () => {
    // Trading is 11:00–02:00, so that gap is nine hours. A tolerance at or above 270 minutes each side would
    // make two consecutive days' widened windows overlap, and a punch in the overlap would belong to two
    // trading dates with nothing able to choose. The bound is the only thing holding that shut for a version
    // somebody publishes later, and `attendance.test.ts` asserts the arithmetic.
    const bound = /punch_tolerance_minutes between 0 and (\d+)/.exec(sqlCodeOnly(migration))?.[1]
    expect(bound).toBeDefined()
    expect(Number(bound) * 2).toBeLessThan(9 * 60)
  })

  it('refuses a reason that is blank, a placeholder, or too short to be one — all three', () => {
    // The acceptance criterion says "rejected by constraint, not by UI validation alone", and each of the
    // three catches a different way of writing nothing. The placeholder arm is the one a reviewer would call
    // redundant: `TBD` passes both the others and answers nobody's question about a changed payslip.
    const constraint =
      /attendance_correction_reason_is_a_reason[\s\S]{0,400}?\)\)?,/.exec(
        sqlCodeOnly(migration),
      )?.[0] ?? ''
    expect(constraint).toContain('btrim(reason)')
    expect(constraint).toContain('is_placeholder_text(reason)')
    expect(constraint).toContain('length(btrim(reason)) >= 8')
  })

  it('gives the approved-period lock no exemption to walk through', () => {
    // A correction changes an approved period WITHOUT inserting into `attendance_event`, so nothing needs a
    // way past this lock — and an exemption keyed on a column would be a hole any caller could set that
    // column to use. Asserted as the absence of an early return before the lookup, because that is the shape
    // an exemption takes.
    const fn =
      /create function assert_attendance_period_not_approved[\s\S]*?end \$\$;/.exec(
        sqlCodeOnly(migration),
      )?.[0] ?? ''
    expect(fn).toContain('from timesheet_approval')
    expect(fn.slice(0, fn.indexOf('from timesheet_approval'))).not.toContain('return new;')
  })

  it('every one of the three record tables refuses UPDATE and DELETE', () => {
    for (const table of ['attendance_event', 'attendance_correction', 'timesheet_approval']) {
      expect(migration).toContain(`create trigger ${table}_no_update before update on ${table}`)
      expect(migration).toContain(`create trigger ${table}_no_delete before delete on ${table}`)
      expect(migration).toContain(`revoke update, delete, truncate on ${table} from berelax_app`)
    }
  })
})

describe('acceptance — the vocabularies are the same in both places', () => {
  it('the migration lists every SQLSTATE the repository declares, and declares every one it lists', () => {
    const declared = new Set(Object.values(ATTENDANCE_SQLSTATE))
    // From the header's list, which is the only place the codes are explained.
    const listed = new Set([...migration.matchAll(/^--\s+(ZX\d{3})\b/gm)].map((match) => match[1]))
    expect(listed).toEqual(declared)
    // And every code the migration actually RAISES is one of them, which is the direction that catches a
    // sixth code added to a trigger and left out of both lists.
    const raised = new Set([...migration.matchAll(/errcode = '(ZX\d{3})'/g)].map((m) => m[1]))
    for (const code of raised) expect(declared).toContain(code)
  })

  it('the outcome vocabulary is the six the module documents, and the reasons are the two', () => {
    // A closed set asserted by value rather than by length: a seventh outcome is a judgement somebody has to
    // make about precedence, and a test counting members would pass over it.
    expect([...ATTENDANCE_OUTCOMES]).toEqual([
      'ON_TIME',
      'LATE',
      'EARLY_LEAVE',
      'ABSENT',
      'UNROSTERED',
      'INCOMPLETE',
    ])
    expect([...INCOMPLETE_REASONS]).toEqual(['missing_clock_out', 'implausible_span'])
    // The migration's CHECK on `attendance_correction.kind` is a different vocabulary from these on purpose —
    // a reason a span is incomplete is not a kind of correction — but the two it does have must both exist.
    expect(sqlCodeOnly(migration)).toContain("'supply_missing_clock_out', 'amend_punch_instant'")
  })
})

describe('acceptance — the payable figure is P-HR-05s and not a second implementation', () => {
  it('summariseTimesheet sums P-HR-05s day rows and nothing else', () => {
    const text = codeOnly(core)
    // The import path is a STRING, so `codeOnly` blanks it — asserted on the comment-stripped source instead.
    // That is the calibration `hr-rota.test.ts` records getting wrong first time, in the other direction.
    expect(withoutComments(core)).toContain("from './working-hours.ts'")
    expect(text).toMatch(/summariseWorkedHours\(\{/)
    // The total is accumulated from `workedHours.days`, which is the claim: a sum over `attendedMinutes` or
    // over `rosteredMinutes` would be a second reading, and the roster one would pay the rota rather than the
    // hours — the defect that reads as perfectly ordinary on a screen.
    expect(text).toMatch(/for \(const day of workedHours\.days\)/)
    expect(text).not.toMatch(/payableMinutes \+= [a-z]*\.?(?:attendedMinutes|rosteredMinutes)/)
  })

  it('CONTROL: the pattern finds a sum over the wrong field when one is spliced in', () => {
    const spliced = codeOnly(`${core}
      function alsoTotals(variances) {
        let payableMinutes = 0
        for (const row of variances) payableMinutes += row.rosteredMinutes
        return payableMinutes
      }`)
    expect(spliced).toMatch(/payableMinutes \+= [a-z]*\.?(?:attendedMinutes|rosteredMinutes)/)
  })

  it('the core module reads no clock and no environment, so a verdict cannot depend on today', () => {
    // `packages/core` is pure and the purity gate enforces it, but this claim is sharper than purity: a
    // variance derived against `Date.now()` would change its answer for an approved day the next time the
    // page was opened, and the figure would look ordinary both times.
    const text = codeOnly(core)
    expect(text).not.toMatch(/\bDate\.now\(\)/)
    expect(text).not.toMatch(/\bnew Date\(\s*\)/)
    expect(text).not.toMatch(/\bprocess\./)
  })
})
