import { COMMISSION_ENABLED_SETTING_KEY, loadConfig } from '@berelax/config'
import { can, instantFromIso, mayReadCommissionDerivation } from '@berelax/core'
import {
  createConnection,
  periodStatusOn,
  readCommissionDerivation,
  readCommissionRuleVersions,
  readCommissionRuns,
  readSetting,
  type Sql,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import {
  type CommissionDerivationLineView,
  type CommissionPageView,
  type CommissionRuleVersionView,
  type CommissionRunView,
  renderCommissionHtml,
} from './render.ts'

/**
 * The commission screen (P-HR-11): which rule version judged a period, what each appointment earned, and —
 * today — that the module is switched off.
 *
 * The rows come from `@berelax/db` and every JUDGEMENT from `@berelax/core`. That split is the unit's, not a
 * style: `packages/db` may not import `packages/core`, so the composition happens here and in
 * `packages/hr/src/commission-run.ts`, and `packages/fixtures/src/hr-commission.itest.ts` asserts the same
 * composition against real PostgreSQL.
 *
 * ## It READS and never runs
 *
 * Computing a run is a write with an actor, a period and an immutable result, and it is not something to put
 * behind a button on a page whose purpose is to explain that nothing is configured — a run recorded by a
 * curious click is a row nothing can delete (ZY072). `executeCommissionRun` in `@berelax/hr` is the entry
 * point, and P-HR-12's payroll run is its first real caller.
 *
 * ## Whose derivation, and why there is no `?employee=`
 *
 * `mayReadCommissionDerivation` in `@berelax/core` owns the decision. A therapist may read their OWN
 * derivation; a colleague's needs `payroll:read`, which the matrix grants to the owner and the accountant and
 * deliberately not to the floor manager (`ROLE_DEFINITIONS`: "Pay is different").
 *
 * The subject therefore comes from the SESSION and from nowhere else. A `?employee=` parameter is refused by
 * `apps/web/src/admin-guard.test.ts` across the whole of `apps/web` — W-SYS-11's first acceptance line, and
 * the scan found this route the first time it was written — and the refusal is the better design: a request
 * for somebody else's derivation is not something this estate can express, so there is no path to authorise.
 *
 * The refusal the acceptance line names — "another employee's id returns a refusal" — lives at the function
 * boundary instead, on `readCommissionDerivationFor` in `@berelax/hr`, which takes a subject id and throws
 * `forbidden` for one the viewer may not read. It is asserted against real rows in
 * `packages/fixtures/src/hr-commission.itest.ts` and over the matrix in
 * `packages/core/src/hr/commission.test.ts`. That is the right layer for it: P-HR-12's payroll run reads a
 * derivation for an employee it names, and the refusal has to hold for THAT caller, not only for a URL.
 *
 * ## Why the period defaults to the calendar month
 *
 * A commission period is the unit of payroll and payroll is monthly. An unbounded read would be a page that
 * gets slower every month; the timesheets screen bounds itself the same way and for the same reason.
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

/** `YYYY-MM-DD` or nothing. Rejected rather than coerced: a half-parsed date is another month's commission. */
function parseDate(raw: string | null): string | null {
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

/**
 * A subject id that is nobody, for asking "would this role be allowed a COLLEAGUE'S derivation?".
 *
 * The all-zero uuid, which `uuid_generate_v7()` cannot produce, so it names no employee and never will. The
 * question is asked of `mayReadCommissionDerivation` rather than of `can(role, 'payroll:read')` directly,
 * although the two answer the same thing today: the screen's sentence and the rule that scoped its rows then
 * come from one function, and a change to the rule moves both together.
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

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and fails
  // closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal
  const url = new URL(request.url)

  /*
    Whose derivation, from the SESSION and from nowhere else.

    A role holding `payroll:read` sees the whole run; everybody else sees their own rows and nothing else,
    which `mayReadCommissionDerivation` is asked about rather than inferred from a role list here. There is no
    parameter for it: see the header.
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
      // One connection for the chrome and the commission, for the timesheets screen's reason: a second pool
      // would make one page load two connections, and the integration suite opens 64 of its own.
      const chrome = await adminChromeFor({ sql, now: instantFromIso(readAtIso), request })
      const [moduleEnabled, versionRows, runs, status] = await Promise.all([
        readSetting(sql, COMMISSION_ENABLED_SETTING_KEY),
        readCommissionRuleVersions(sql),
        readCommissionRuns(sql, { periodStartsOn, periodEndsOn }),
        // The ONE reader of the period lock (M-VAT-06). Read here so the screen can name the earliest OPEN
        // date as data rather than as text somebody has to parse out of a refusal they have not seen yet.
        periodStatusOn(sql, periodEndsOn),
      ])

      const newest = runs[0]
      const derivation =
        newest === undefined
          ? []
          : await readCommissionDerivation(sql, {
              runId: newest.runId,
              // Omitted entirely for a role that may read everybody, rather than passed as a null: the
              // repository's filter is "this employee or no filter", and spelling the wider case as an
              // absent argument is what keeps the narrow one from being reachable by accident.
              ...(seesEveryone ? {} : { employeeId: subjectEmployeeId }),
            })

      const [subject] = await sql<{ staffReference: string }[]>`
        select staff_reference as "staffReference" from employee where id = ${subjectEmployeeId}::uuid
      `

      const versions: CommissionRuleVersionView[] = versionRows.map((row, index) => ({
        version: row.version,
        effectiveFrom: row.effectiveFrom,
        basis: row.basis,
        roundingMode: row.roundingMode,
        openQuestionId: row.isProvisional ? row.openQuestionId : null,
        bands: row.bands.map((band) => ({
          bandNo: band.bandNo,
          fromFils: band.fromFils,
          rateBp: band.rateBp,
        })),
        // Derived from a later version existing, never read from a column: `commission_rule` refuses every
        // UPDATE, so a `superseded_at` would be unwritable. The rows arrive ordered by effective date.
        superseded: index < versionRows.length - 1,
      }))

      const page: CommissionPageView = {
        chrome,
        readAtIso,
        periodStartsOn,
        periodEndsOn,
        // `readSetting` returns the declared default for an absent key, which for this flag is `false` —
        // the state the build ships in. Narrowed rather than cast: a non-boolean would mean the registry
        // and the stored row disagree, and treating that as "enabled" is the one reading that could pay
        // somebody at a rate nobody agreed.
        moduleEnabled: moduleEnabled === true,
        moduleOpenQuestionId: 'Y9-commission',
        versions,
        runs: runs.map(
          (run): CommissionRunView => ({
            runId: run.runId,
            ruleVersion: run.ruleVersion,
            totalFils: run.totalFils,
            lineCount: run.lineCount,
            sourceAsOf: run.sourceAsOf,
            lockedPeriodId: run.lockedPeriodId,
            moduleEnabled: run.moduleEnabled,
            computedAt: run.computedAt,
          }),
        ),
        derivation: derivation.map(
          (line): CommissionDerivationLineView => ({
            staffReference: line.staffReference,
            appointmentId: line.appointmentId,
            tradingDate: line.tradingDate,
            source: line.source,
            basisFils: line.basisFils,
            bandNo: line.bandNo,
            rateBp: line.rateBp,
            commissionFils: line.commissionFils,
          }),
        ),
        subject: {
          // The handle and never a name: nineteen employees have no name recorded (ADR 0020, brief rule 10).
          staffReference: subject?.staffReference ?? subjectEmployeeId,
          // Asserted rather than assumed. `seesEveryone` decided the read above, and this is the same
          // question put to `mayReadCommissionDerivation` — the function the refusal in `@berelax/hr` uses —
          // so the sentence on the screen and the rule that scoped the rows cannot disagree.
          ownOnly: !mayReadCommissionDerivation({
            role: principal.role,
            viewerEmployeeId: principal.employeeId,
            subjectEmployeeId: SOMEBODY_ELSE,
          }),
        },
        accountingPeriod: {
          closed: status.closed,
          periodId: status.periodId,
          earliestOpenDate: status.earliestOpenDate,
        },
      }
      return page
    })

    return new Response(renderCommissionHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached commission page outlives the run: a recompute a minute ago would be missing
        // from it, and somebody would read a figure that had been superseded.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looked like an empty
    // commission screen would say "nothing was earned" when the truth is "nothing could be read" — which for
    // a screen about somebody's pay is the one failure it must never have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The commission figures could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
