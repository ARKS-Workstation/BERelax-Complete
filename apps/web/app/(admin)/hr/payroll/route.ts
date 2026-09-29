import { loadConfig, WPS_AGENT_ID_SETTING_KEY, WPS_EMPLOYER_ID_SETTING_KEY } from '@berelax/config'
import {
  can,
  instantFromIso,
  mayReadPayslip,
  PLACEHOLDER_WPS_AGENT_ID,
  PLACEHOLDER_WPS_EMPLOYER_ID,
} from '@berelax/core'
import {
  createConnection,
  periodStatusOn,
  readPayrollRuns,
  readPayslips,
  readSetting,
  readWpsExports,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { isAppError, WPS_OPEN_QUESTION_ID } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import {
  type PayrollPageView,
  type PayrollRunView,
  type PayslipLineView,
  renderPayrollHtml,
  type WpsExportView,
} from './render.ts'

/**
 * The payroll screen (P-HR-12): which runs exist over a period, what each payslip is made of, and what is
 * blocking a WPS file.
 *
 * The rows come from `@berelax/db` and every JUDGEMENT from `@berelax/core`. That split is the unit's, not a
 * style: `packages/db` may not import `packages/core`, so the composition happens here and in
 * `packages/hr/src/payroll-run.ts`, and `packages/fixtures/src/hr-payroll.itest.ts` asserts the same
 * composition against real PostgreSQL.
 *
 * ## It READS and never runs, and never exports
 *
 * Computing a run is a write with an actor, a period and an immutable result, and it is not something to put
 * behind a button on a page whose purpose is to explain what is blocking — a run recorded by a curious click
 * is a row nothing can delete (ZY141). `executePayrollRun` in `@berelax/hr` is the entry point.
 *
 * The export is the same argument twice over. An export of wages is the insider-threat signal this system
 * watches most closely (0005's `audit_event_export_idx`), so producing one belongs behind a deliberate
 * action rather than on the page that lists the runs. This screen LISTS the exports already taken, which is
 * the half that belongs on a console.
 *
 * ## Whose payslip, and why there is no `?employee=`
 *
 * `mayReadPayslip` in `@berelax/core` owns the decision. A therapist may read their OWN payslip; a
 * colleague's needs `payroll:read`, which the matrix grants to the owner and the accountant and deliberately
 * not to the floor manager (`ROLE_DEFINITIONS`: "Pay is different").
 *
 * The subject therefore comes from the SESSION and from nowhere else. A `?employee=` parameter is refused by
 * `apps/web/src/admin-guard.test.ts` across the whole of `apps/web` — W-SYS-11's first acceptance line — and
 * the refusal is the better design: a request for somebody else's payslip is not something this estate can
 * express, so there is no path to authorise. The refusal the acceptance line names lives at the function
 * boundary instead, on `readPayslipFor` in `@berelax/hr`, which takes a subject id and throws `forbidden`
 * for one the viewer may not read — the layer a payroll run reading one employee's figures also hits.
 *
 * ## Every read of this page writes an audit row
 *
 * `readPayslips` takes a `UnitOfWork` and writes the audit row itself, so there is no shape of this handler
 * that reads a payslip without recording who did and how many rows came back. docs/04 §7 puts salary beside
 * bank details and identity numbers, "with every read audited".
 */
export const dynamic = 'force-dynamic'

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** `YYYY-MM-DD` or nothing. Rejected rather than coerced: a half-parsed date is another month's payroll. */
function parseDate(raw: string | null): string | null {
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

/**
 * A subject id that is nobody, for asking "would this role be allowed a COLLEAGUE'S payslip?".
 *
 * The all-zero uuid, which `uuid_generate_v7()` cannot produce, so it names no employee and never will. The
 * question is put to `mayReadPayslip` rather than to `can(role, 'payroll:read')` directly, although the two
 * answer the same thing today: the screen's sentence and the rule that scoped its rows then come from one
 * function, and a change to the rule moves both together.
 */
const SOMEBODY_ELSE = '00000000-0000-0000-0000-000000000000'

/** The first and last day of the calendar month containing `date`, as trading dates. */
function monthAround(date: string): { readonly startsOn: string; readonly endsOn: string } {
  const [year, month] = date.split('-').map(Number)
  const first = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, 1))
  const last = new Date(Date.UTC(year ?? 1970, month ?? 1, 0))
  return {
    startsOn: first.toISOString().slice(0, 10),
    endsOn: last.toISOString().slice(0, 10),
  }
}

/**
 * Whether a stored identifier is a real answer rather than the placeholder the build ships.
 *
 * Compared against the SHARED constant rather than re-tested for shape: `@berelax/shared` holds the one
 * spelling, `@berelax/config` uses it as the default and `@berelax/core` refuses a file naming it, so a
 * screen that decided "configured" by its own rule could say yes to a value the export refuses.
 */
const isConfigured = (value: unknown, placeholder: string): boolean =>
  typeof value === 'string' && value.trim() !== '' && value !== placeholder

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and fails
  // closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal
  const url = new URL(request.url)

  /*
    Whose payslip, from the SESSION and from nowhere else.

    A role holding `payroll:read` sees the whole run; everybody else sees their own rows and nothing else,
    which `mayReadPayslip` is asked about rather than inferred from a role list here. There is no parameter
    for it: see the header.
  */
  const seesEveryone = can(principal.role, 'payroll:read')
  const subjectEmployeeId = principal.employeeId

  try {
    const readAtIso = new Date().toISOString()
    const anchor = parseDate(url.searchParams.get('from')) ?? readAtIso.slice(0, 10)
    const period = monthAround(anchor)
    const periodStartsOn = period.startsOn
    const periodEndsOn = parseDate(url.searchParams.get('to')) ?? period.endsOn

    const view = await withSql(async (sql) => {
      // One connection for the chrome and the payroll, for the timesheets screen's reason: a second pool
      // would make one page load two connections, and the integration suite opens 64 of its own.
      const chrome = await adminChromeFor({ sql, now: instantFromIso(readAtIso), request })
      const [runs, employerId, agentId, status] = await Promise.all([
        readPayrollRuns(sql, { periodStartsOn, periodEndsOn }),
        readSetting(sql, WPS_EMPLOYER_ID_SETTING_KEY),
        readSetting(sql, WPS_AGENT_ID_SETTING_KEY),
        // The ONE reader of the period lock (M-VAT-06). Read here so the screen can name the earliest OPEN
        // date as data rather than as text somebody has to parse out of a refusal they have not seen yet.
        periodStatusOn(sql, periodEndsOn),
      ])

      const newest = runs[0]
      const payslips =
        newest === undefined
          ? []
          : await withUnitOfWork(
              sql,
              { kind: 'staff', id: principal.employeeId, label: principal.role },
              (uow) =>
                readPayslips(uow, {
                  runId: newest.runId,
                  // Omitted entirely for a role that may read everybody, rather than passed as a null: the
                  // repository's filter is "this employee or no filter", and spelling the wider case as an
                  // absent argument is what keeps the narrow one from being reachable by accident.
                  ...(seesEveryone ? {} : { employeeId: subjectEmployeeId }),
                }),
            )
      const exports = newest === undefined ? [] : await readWpsExports(sql, newest.runId)

      const [subject] = await sql<{ staffReference: string }[]>`
        select staff_reference as "staffReference" from employee where id = ${subjectEmployeeId}::uuid
      `

      const page: PayrollPageView = {
        chrome,
        readAtIso,
        periodStartsOn,
        periodEndsOn,
        runs: runs.map(
          (run): PayrollRunView => ({
            runId: run.runId,
            periodStartsOn: run.periodStartsOn,
            periodEndsOn: run.periodEndsOn,
            payslipCount: run.payslipCount,
            netTotalFils: run.netTotalFils,
            unpricedEmployeeCount: run.unpricedEmployeeCount,
            completedAtIso: run.completedAt === null ? null : run.completedAt.toISOString(),
            completedBy: run.completedBy,
            correctsRunId: run.correctsRunId,
            labourCostRuleEffectiveFrom: run.labourCostRuleEffectiveFrom,
          }),
        ),
        payslips: payslips.map(
          (line): PayslipLineView => ({
            // The handle and never a name: nineteen employees have no name recorded (ADR 0020, rule 10).
            staffReference: line.staffReference,
            basicFils: line.basicFils,
            allowancesFils: line.allowancesFils,
            overtimeFils: line.overtimeFils,
            commissionFils: line.commissionFils,
            tipsFils: line.tipsFils,
            grossFils: line.grossFils,
            deductionsFils: line.deductionsFils,
            netFils: line.netFils,
            payableMinutes: line.payableMinutes,
            commissionRunId: line.commissionRunId,
            commissionRuleVersion: line.commissionRuleVersion,
            timesheetApprovalId: line.timesheetApprovalId,
            workingHoursRuleEffectiveFrom: line.workingHoursRuleEffectiveFrom,
          }),
        ),
        exports: exports.map(
          (row): WpsExportView => ({
            exportedAtIso: row.exportedAt.toISOString(),
            exportedBy: row.exportedBy,
            recordCount: row.recordCount,
            fileSha256: row.fileSha256,
            format: row.format,
          }),
        ),
        subject: {
          staffReference: subject?.staffReference ?? subjectEmployeeId,
          // Asserted rather than assumed. `seesEveryone` decided the read above, and this is the same
          // question put to `mayReadPayslip` — the function `readPayslipFor` uses — so the sentence on the
          // screen and the rule that scoped the rows cannot disagree.
          ownOnly: !mayReadPayslip({
            role: principal.role,
            viewerEmployeeId: principal.employeeId,
            subjectEmployeeId: SOMEBODY_ELSE,
          }),
        },
        wps: {
          employerIdConfigured: isConfigured(employerId, PLACEHOLDER_WPS_EMPLOYER_ID),
          agentIdConfigured: isConfigured(agentId, PLACEHOLDER_WPS_AGENT_ID),
          openQuestionId: WPS_OPEN_QUESTION_ID,
        },
        accountingPeriod: {
          closed: status.closed,
          periodId: status.periodId,
          earliestOpenDate: status.earliestOpenDate,
        },
      }
      return page
    })

    return new Response(renderPayrollHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached payroll page outlives the run: a correcting run computed a minute ago
        // would be missing from it, and somebody would read a figure that had been superseded.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looked like an empty
    // payroll screen would say "nobody is owed anything" when the truth is "nothing could be read" — which
    // for a screen about somebody's pay is the one failure it must never have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The payroll figures could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
