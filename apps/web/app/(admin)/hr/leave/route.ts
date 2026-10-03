import { loadConfig } from '@berelax/config'
import { can, instantFromIso, LEAVE_REQUEST_KINDS, localDate } from '@berelax/core'
import { createConnection, readTradingDayWindows, type Sql } from '@berelax/db'
import { type PortalViewer, submitLeaveRequest, tradingHoursFromWindows } from '@berelax/hr'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import {
  type LeaveFilingCandidateView,
  type LeaveFilingPageView,
  renderLeaveFilingHtml,
} from './render.ts'

/**
 * `GET`/`POST /hr/leave` — filing leave for a member of staff (P-HR-14).
 *
 * The second of the two entry points into `submitLeaveRequest`. The portal's is `/hr/me`; this is the one
 * a manager uses for the nineteen employees with no contact detail on file, who cannot reach the portal at
 * all. Both call the one validator and neither calls `writeLeaveRequest` — asserted by source scan in
 * `packages/fixtures/src/leave-submission-entry-points.test.ts`, with the control that the scan can see a
 * direct call when one is planted.
 *
 * ## The authority
 *
 * `leave:approve`, checked against the SESSION's role by `assertOnBehalfAuthority` inside
 * `submitLeaveRequest` and checked again here before the screen renders, so a role that may not file for
 * somebody is refused the FORM rather than being refused after typing into it. The two checks are the same
 * `can(role, 'leave:approve')` call and not two readings: one decides what to render, the other decides
 * what to write, and the writing one is the authority.
 *
 * `leave:request` is deliberately NOT enough. Every therapist holds it and it is what lets them file their
 * own; filing for somebody else is the authority that decides leave.
 *
 * ## There is no `?employee=`
 *
 * The subject is in the POST body. `admin-guard.test.ts` refuses a principal, a role or a permission taken
 * from the query across the whole of `apps/web`, and while a subject is not a principal, a GET URL
 * carrying an employee id is a URL that gets shared — and the authority is the session's either way.
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

const DUBAI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dubai',
  dateStyle: 'medium',
  timeStyle: 'short',
})

/** `YYYY-MM-DD` or null. Rejected rather than coerced: a half-parsed date is another week's leave. */
function parseDate(raw: string | null): string | null {
  return raw !== null && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null
}

/** A uuid, or null. The subject is a row id and a value that is not one is refused before any query. */
function parseUuid(raw: string | null): string | null {
  return raw !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
    ? raw
    : null
}

interface EmployeeRow {
  readonly employeeId: string
  readonly staffReference: string
  readonly employedFrom: string
}

/**
 * Current employees, by handle.
 *
 * `staff_reference` and the two dates the submission needs, and nothing else — no wage, no document, no
 * name beyond the handle. The select list is the field policy: this screen files leave and has no business
 * reading anything a rota screen would not.
 */
async function currentEmployees(sql: Sql, onDate: string): Promise<readonly EmployeeRow[]> {
  return sql<EmployeeRow[]>`
    select id::text             as "employeeId",
           staff_reference      as "staffReference",
           employed_from::text  as "employedFrom"
      from employee
     where employed_from <= ${onDate}::date
       and (employed_until is null or employed_until >= ${onDate}::date)
     order by staff_reference
  `
}

function refusedResponse(role: string): Response {
  return new Response(
    `Role "${role}" may file its own leave and not somebody else's. Filing for another employee is the ` +
      'authority that decides leave, which the matrix grants with leave:approve.\n',
    {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    },
  )
}

function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`The leave filing screen could not be read: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

const FILING_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  vary: 'Cookie',
}

interface FormState {
  readonly employeeId: string
  readonly from: string
  readonly to: string
  readonly kind: string
  readonly refusal: { readonly name: string; readonly sentence: string } | null
  readonly submitted: {
    readonly staffReference: string
    readonly days: number
    readonly status: string
  } | null
}

const EMPTY_FORM: FormState = {
  employeeId: '',
  from: '',
  to: '',
  kind: 'annual',
  refusal: null,
  submitted: null,
}

async function screen(request: Request, state: FormState): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal
  if (!can(principal.role, 'leave:approve')) return refusedResponse(principal.role)
  try {
    const readAtIso = new Date().toISOString()
    const view = await withSql(async (sql) => {
      const chrome = await adminChromeFor({ sql, now: instantFromIso(readAtIso), request })
      const employees = await currentEmployees(sql, readAtIso.slice(0, 10))
      const page: LeaveFilingPageView = {
        chrome,
        readAtLabel: DUBAI.format(new Date(readAtIso)),
        actorLabel: principal.staffReference,
        candidates: employees.map(
          (row): LeaveFilingCandidateView => ({
            employeeId: row.employeeId,
            staffReference: row.staffReference,
          }),
        ),
        leaveKinds: LEAVE_REQUEST_KINDS,
        form: {
          employeeId: state.employeeId,
          from: state.from,
          to: state.to,
          kind: state.kind,
        },
        refusal: state.refusal,
        submitted: state.submitted,
      }
      return page
    })
    return new Response(renderLeaveFilingHtml(view), { headers: FILING_HEADERS })
  } catch (error) {
    return unavailable(error)
  }
}

export async function GET(request: Request): Promise<Response> {
  return screen(request, EMPTY_FORM)
}

export async function POST(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else. `guardAdminRoute` never throws and fails closed.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const principal = authorised.principal
  if (!can(principal.role, 'leave:approve')) return refusedResponse(principal.role)
  const viewer: PortalViewer = { role: principal.role, employeeId: principal.employeeId }

  try {
    const body = new URLSearchParams(await request.text())
    const subject = parseUuid(body.get('employee'))
    const from = parseDate(body.get('from'))
    const to = parseDate(body.get('to'))
    const kind = body.get('kind') ?? 'annual'
    const state: FormState = {
      employeeId: subject ?? '',
      from: from ?? '',
      to: to ?? '',
      kind,
      refusal: null,
      submitted: null,
    }
    if (subject === null || from === null || to === null) {
      return screen(request, {
        ...state,
        refusal: {
          name: 'leave_range_not_submittable',
          sentence:
            'An employee and both dates are needed, the dates as YYYY-MM-DD and the employee as the ' +
            'row id the form supplies. A half-parsed value is refused rather than coerced.',
        },
      })
    }

    const outcome = await withSql(async (sql) => {
      const [employee] = await sql<EmployeeRow[]>`
        select id::text            as "employeeId",
               staff_reference     as "staffReference",
               employed_from::text as "employedFrom"
          from employee
         where id = ${subject}::uuid
      `
      if (employee === undefined) return { kind: 'unknown_employee' as const }
      const windows = await readTradingDayWindows(sql, {
        fromTradingDate: from,
        toTradingDate: to,
      })
      const result = await submitLeaveRequest(sql, {
        viewer,
        subjectEmployeeId: subject,
        kind,
        from: localDate(from),
        to: localDate(to),
        submittedOn: localDate(new Date().toISOString().slice(0, 10)),
        employedFrom: localDate(employee.employedFrom),
        hoursFor: tradingHoursFromWindows(windows),
        // The ACTOR is whoever is signed in and the SUBJECT is whose leave it is. Two different facts,
        // and conflating them is how an audit trail comes to say a therapist filed a request a manager
        // typed in.
        actor: { kind: 'staff', label: principal.staffReference },
        createdBy: principal.staffReference,
      })
      return { kind: 'decided' as const, result, staffReference: employee.staffReference }
    })

    if (outcome.kind === 'unknown_employee') {
      return screen(request, {
        ...state,
        refusal: {
          name: 'unknown_employee',
          sentence: 'No employee row has that id, so there is nobody to file leave for.',
        },
      })
    }
    return screen(
      request,
      outcome.result.kind === 'refused'
        ? {
            ...state,
            refusal: {
              name: outcome.result.verdict.refusal,
              sentence: outcome.result.verdict.detail,
            },
          }
        : {
            ...EMPTY_FORM,
            submitted: {
              staffReference: outcome.staffReference,
              days: Math.trunc(outcome.result.reservedHundredths / 100),
              status: outcome.result.status,
            },
          },
    )
  } catch (error) {
    return unavailable(error)
  }
}
