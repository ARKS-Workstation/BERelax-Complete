import { COMMISSION_ENABLED_SETTING_KEY, loadConfig } from '@berelax/config'
import {
  instantFromIso,
  LEAVE_REQUEST_KINDS,
  localDate,
  mayUseStaffPortal,
  portalRefusalOf,
} from '@berelax/core'
import {
  createConnection,
  readCommissionRuns,
  readPayrollRuns,
  readSetting,
  readTradingDayWindows,
  type Sql,
} from '@berelax/db'
import {
  type PortalViewer,
  readPortalBank,
  readPortalCommission,
  readPortalLeave,
  readPortalPayslips,
  readPortalSchedule,
  submitLeaveRequest,
  tradingHoursFromWindows,
} from '@berelax/hr'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import {
  type PortalCommissionLineView,
  type PortalLeaveFormView,
  type PortalLeaveRequestView,
  type PortalPageView,
  type PortalPayslipView,
  type PortalShiftView,
  renderStaffPortalHtml,
} from './render.ts'

/**
 * `GET`/`POST /hr/me` — the staff portal (P-HR-14).
 *
 * ## Whose data, and why there is no parameter for it
 *
 * The SESSION's, and nothing else. `apps/web/src/admin-guard.test.ts` refuses a principal, a role or a
 * permission taken from the query across the whole of `apps/web` (W-SYS-11), so a request for somebody
 * else's portal is not something this estate can express — and that is the better design, because there is
 * then no path to authorise.
 *
 * The refusal the acceptance line names — "every portal route requested with another employee's id returns
 * a refusal" — lives at the FUNCTION boundary instead, on `assertPortalSubject` in `@berelax/core` applied
 * by every reader in `packages/hr/src/staff-portal.ts`. That is the right layer for it: the refusal has to
 * hold for a CALLER that names a subject, and `packages/fixtures/src/staff-portal.itest.ts` drives it with
 * a colleague's rows present in every table, which is what makes a refusal distinguishable from an empty
 * one.
 *
 * It is the same division P-HR-11 and P-HR-12 made, and the portal's fence is deliberately NARROWER than
 * either: `mayReadPayslip` widens on `payroll:read` because an accountant running payroll legitimately
 * reads somebody else's figures, and nothing legitimately reads somebody else's `/hr/me`.
 *
 * ## One POST, which is the one write the portal has
 *
 * Filing the viewer's own leave. It calls `submitLeaveRequest` in `@berelax/hr` — the ONE validator, which
 * `/hr/leave` (the on-behalf path) also calls and which
 * `packages/fixtures/src/leave-submission-entry-points.test.ts` asserts is the only caller of
 * `writeLeaveRequest` in the application.
 *
 * **200 for a refusal, not 4xx**, which is the checkout screen's decision and its reason: the response is a
 * DOCUMENT somebody at a terminal reads and acts on, a 400 with a page in it is a page a proxy is entitled
 * to replace, and the one thing the reader must see is the sentence saying what to fix.
 */
export const dynamic = 'force-dynamic'

/** How much of the rota the portal shows. Bounded: an unbounded read gets slower every month. */
const SHIFT_WINDOW_DAYS = 28

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  dateStyle: 'medium',
  timeStyle: 'short',
})

const TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  hour: '2-digit',
  minute: '2-digit',
})

const DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', dateStyle: 'medium' })

/** `YYYY-MM-DD` or null. Rejected rather than coerced: a half-parsed date is another week's leave. */
function parseDate(raw: string | null): string | null {
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

function shiftDate(from: string, days: number): string {
  const at = new Date(`${from}T00:00:00Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return at.toISOString().slice(0, 10)
}

interface EmployeeFacts {
  readonly staffReference: string
  readonly employedFrom: string
  readonly employedUntil: string | null
  readonly contractType: string
  readonly displayName: string | null
}

/**
 * The employment-record fields the portal shows, and ONLY those.
 *
 * The select list is the field policy made executable: `PORTAL_EMPLOYEE_FIELDS` in `@berelax/core`
 * enumerates the five names and `portalFieldPolicyProblems` refuses one whose sensitivity is not `open`,
 * so a wage column cannot be added to this statement without failing
 * `packages/core/src/hr/self-service.test.ts`. A `select *` here would have been the shape that leaks the
 * sixth field somebody adds.
 */
async function employeeFacts(sql: Sql, employeeId: string): Promise<EmployeeFacts | null> {
  const [row] = await sql<EmployeeFacts[]>`
    select staff_reference      as "staffReference",
           employed_from::text  as "employedFrom",
           employed_until::text as "employedUntil",
           contract_type::text  as "contractType",
           display_name         as "displayName"
      from employee
     where id = ${employeeId}::uuid
  `
  return row ?? null
}

interface PortalData {
  readonly view: PortalPageView
}

/**
 * Everything the document needs, read with one connection.
 *
 * One connection for the chrome and the four surfaces, for the commission screen's reason: a second pool
 * would make one page load two connections, and the integration suite opens 64 of its own.
 */
async function readPortal(
  sql: Sql,
  request: Request,
  viewer: PortalViewer,
  leaveForm: PortalLeaveFormView,
): Promise<PortalData> {
  const readAtIso = new Date().toISOString()
  const today = readAtIso.slice(0, 10)
  const chrome = await adminChromeFor({ sql, now: instantFromIso(readAtIso), request })

  const facts = await employeeFacts(sql, viewer.employeeId)
  if (facts === null) {
    throw new Error(
      `The session names employee ${viewer.employeeId} and no employee row has that id. A session is ` +
        'minted against a credential that references one, so this is a deleted row rather than a bad ' +
        'cookie — refusing rather than rendering an empty portal, which would read as "nothing is on ' +
        'file for you".',
    )
  }

  const shiftsTo = shiftDate(today, SHIFT_WINDOW_DAYS)
  const [shifts, leave, bank, commissionEnabled, commissionRuns, payrollRuns] = await Promise.all([
    readPortalSchedule(sql, {
      viewer,
      subjectEmployeeId: viewer.employeeId,
      fromTradingDate: today,
      toTradingDate: shiftsTo,
    }),
    readPortalLeave(sql, { viewer, subjectEmployeeId: viewer.employeeId }),
    readPortalBank(sql, { viewer, subjectEmployeeId: viewer.employeeId }),
    readSetting(sql, COMMISSION_ENABLED_SETTING_KEY),
    // The newest run over the month containing today. Which run a PAYSLIP paid is the payslip's own pin
    // (P-HR-12); this panel is "what the newest derivation says you earned", which is the question a
    // therapist checking a figure actually has.
    readCommissionRuns(sql, {
      periodStartsOn: `${today.slice(0, 7)}-01`,
      periodEndsOn: shiftDate(`${today.slice(0, 7)}-01`, 31),
    }),
    // Bounded to the last 13 months, which is the window a payslip question is ever about and the same
    // shape the commission panel takes. `readPayrollRuns` requires a period: an unbounded read would get
    // slower every month and would also write one audit row per run per page load.
    readPayrollRuns(sql, { periodStartsOn: shiftDate(today, -400), periodEndsOn: today }),
  ])

  const newestCommissionRun = commissionRuns[0]
  const commission: readonly PortalCommissionLineView[] =
    newestCommissionRun === undefined
      ? []
      : (
          await readPortalCommission(sql, {
            viewer,
            subjectEmployeeId: viewer.employeeId,
            runId: newestCommissionRun.runId,
          })
        ).map((line) => ({
          tradingDate: line.tradingDate,
          basisFils: line.basisFils,
          commissionFils: line.commissionFils,
        }))

  /*
    Payslips across every COMPLETED run, newest first.

    `readPayslipFor` is per run and writes an audit row per read, which is docs/04 §7's "every read
    audited" and the reason this loop is bounded to the newest few rather than every run ever: a portal
    that read twenty runs would write twenty audit rows per page load and bury the one read somebody is
    looking for.
  */
  const payslips: PortalPayslipView[] = []
  for (const run of payrollRuns.slice(0, PAYSLIP_RUNS_SHOWN)) {
    const rows = await readPortalPayslips(sql, {
      viewer,
      subjectEmployeeId: viewer.employeeId,
      runId: run.runId,
      actor: { kind: 'staff', label: facts.staffReference },
    })
    for (const row of rows) {
      payslips.push({
        periodStartsOn: row.periodStartsOn,
        periodEndsOn: row.periodEndsOn,
        grossFils: row.grossFils,
        deductionsFils: row.deductionsFils,
        netFils: row.netFils,
      })
    }
  }

  const view: PortalPageView = {
    chrome,
    readAtIso,
    readAtLabel: DUBAI.format(new Date(readAtIso)),
    staffReference: facts.staffReference,
    employedFrom: facts.employedFrom,
    employedUntil: facts.employedUntil,
    contractType: facts.contractType,
    displayName: facts.displayName,
    shiftsFromLabel: today,
    shiftsToLabel: shiftsTo,
    shifts: shifts.map(
      (shift): PortalShiftView => ({
        tradingDate: shift.tradingDate,
        startsAtLabel: TIME.format(new Date(shift.startsAt)),
        endsAtLabel: TIME.format(new Date(shift.endsAt)),
        rotaVersionNo: shift.versionNo,
      }),
    ),
    leaveRequests: leave.requests.map(
      (request_): PortalLeaveRequestView => ({
        kind: request_.kind,
        status: request_.status,
        fromLabel: DATE.format(new Date(request_.startsAt)),
        toLabel: DATE.format(new Date(request_.endsAt)),
      }),
    ),
    leaveBalanceHundredths: leave.balanceHundredths,
    leaveReservedHundredths: leave.reservedHundredths,
    leaveForm,
    leaveKinds: LEAVE_REQUEST_KINDS,
    commission,
    // `readSetting` returns the declared default for an absent key, which for this flag is `false` — the
    // state the build ships in. Narrowed rather than cast: a non-boolean would mean the registry and the
    // stored row disagree, and treating that as "enabled" would put a figure on a payslip panel that no
    // agreed rate produced.
    commissionEnabled: commissionEnabled === true,
    payslips,
    bank,
  }
  return { view }
}

/** How many payroll runs the payslip panel reaches back over. See the loop's comment on the audit cost. */
const PAYSLIP_RUNS_SHOWN = 6

const EMPTY_FORM: PortalLeaveFormView = {
  from: '',
  to: '',
  kind: 'annual',
  refusal: null,
  submitted: null,
}

function refusal(error: unknown): Response | null {
  // A portal refusal is a 403 and not a 503: the request was understood and declined, and an operator
  // who read "the page could not be read" would go looking for an outage.
  if (portalRefusalOf(error) === null) return null
  return new Response(
    'The staff portal answers for the signed-in employee and for nobody else, so this request is ' +
      'refused.\n',
    {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    },
  )
}

function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  // Plain text and a 503: a blank page that looked like an empty portal would say "nothing is on file
  // for you", which for a screen about somebody's own pay and leave is the one failure it must not have.
  return new Response(`Your details could not be read: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

const PORTAL_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  // Never cached. This document is one person's wage, leave and roster, and a cached copy is served to
  // the next reader at the same terminal.
  'cache-control': 'no-store',
  // The same URL answers differently per session, which is what `Vary` says.
  vary: 'Cookie',
}

async function portalResponse(request: Request, form: PortalLeaveFormView): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal
  if (!mayUseStaffPortal(principal.role)) {
    return new Response(
      `Role "${principal.role}" has no staff portal: it holds no leave:request grant, which is what ` +
        'this surface is for.\n',
      {
        status: 403,
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      },
    )
  }
  const viewer: PortalViewer = { role: principal.role, employeeId: principal.employeeId }
  try {
    const { view } = await withSql((sql) => readPortal(sql, request, viewer, form))
    return new Response(renderStaffPortalHtml(view), { headers: PORTAL_HEADERS })
  } catch (error) {
    return refusal(error) ?? unavailable(error)
  }
}

export async function GET(request: Request): Promise<Response> {
  return portalResponse(request, EMPTY_FORM)
}

export async function POST(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else. `guardAdminRoute` never throws and fails closed, so it
  // is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal
  const viewer: PortalViewer = { role: principal.role, employeeId: principal.employeeId }

  let form: PortalLeaveFormView = EMPTY_FORM
  try {
    // `application/x-www-form-urlencoded` only. The screen is one `<form method="post">`, which is what
    // makes it work with JavaScript off. A body that is not form-encoded parses to empty
    // `URLSearchParams` and is refused by name below rather than turning into a 500.
    const body = new URLSearchParams(await request.text())
    const from = parseDate(body.get('from'))
    const to = parseDate(body.get('to'))
    const kind = body.get('kind') ?? 'annual'
    form = { from: from ?? '', to: to ?? '', kind, refusal: null, submitted: null }
    if (from === null || to === null) {
      return portalResponse(request, {
        ...form,
        refusal: {
          name: 'leave_range_not_submittable',
          sentence:
            "Both dates are needed, each as YYYY-MM-DD. A half-parsed date is another week's leave, " +
            'so it is refused rather than coerced.',
        },
      })
    }

    const outcome = await withSql(async (sql) => {
      const facts = await employeeFacts(sql, viewer.employeeId)
      if (facts === null) {
        throw new Error(
          `The session names employee ${viewer.employeeId} and no employee row has that id.`,
        )
      }
      const windows = await readTradingDayWindows(sql, {
        fromTradingDate: from,
        toTradingDate: to,
      })
      return submitLeaveRequest(sql, {
        viewer,
        // From the SESSION and from nowhere else. There is no body field for it either: a subject in the
        // body would be the same defect as a subject in the query, one layer down. `/hr/leave` is the
        // on-behalf path and it takes an explicit authority check for exactly that reason.
        subjectEmployeeId: viewer.employeeId,
        kind,
        from: localDate(from),
        to: localDate(to),
        submittedOn: localDate(new Date().toISOString().slice(0, 10)),
        employedFrom: localDate(facts.employedFrom),
        hoursFor: tradingHoursFromWindows(windows),
        actor: { kind: 'staff', label: facts.staffReference },
        createdBy: facts.staffReference,
      })
    })

    return portalResponse(
      request,
      outcome.kind === 'refused'
        ? { ...form, refusal: { name: outcome.verdict.refusal, sentence: outcome.verdict.detail } }
        : {
            ...EMPTY_FORM,
            submitted: {
              days: Math.trunc(outcome.reservedHundredths / 100),
              status: outcome.status,
            },
          },
    )
  } catch (error) {
    return refusal(error) ?? unavailable(error)
  }
}
