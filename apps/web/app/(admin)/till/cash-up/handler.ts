import { randomUUID } from 'node:crypto'
import {
  ASIA_DUBAI,
  accountCode,
  cashDropPosting,
  cashUpPosting,
  entryId,
  expectedFloat,
  filsFrom,
  formatMoney,
  type Instant,
  localDate,
  money,
  reconcileDrawer,
  STANDARD_SPA_CHART,
  toLocal,
} from '@berelax/core'
import {
  closeCashSession,
  type DrawerTakingsRow,
  openCashSession,
  readCashDrawers,
  readCashSessionsForBusinessDay,
  readDrawerTakings,
  readOpenCashSession,
  recordCashDrop,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import type { AdminChrome } from '../../../../src/components/admin/google-reauth-banner.ts'
import { toEntryInput } from '../../../../src/till/mapping.ts'
import { PACKAGES_PATH, TILL_CASH_UP_PATH, TILL_FIELDS, TILL_PATH } from '../view.ts'
import {
  CASH_UP_FIELDS,
  type CashUpSessionView,
  type CashUpView,
  renderCashUpHtml,
} from './render.ts'

/**
 * Everything the cash-up screen decides (M-TILL-13).
 *
 * The clock and the connection are arguments for the reason the till's handler gives. Three writes — open,
 * drop, close — each one transaction, each one going through M-TILL-11's service so the period check, the
 * mandatory reason and ZU004's variance posting are the database's answers and not this screen's.
 */

export interface CashUpRequest {
  readonly searchParams: URLSearchParams
  readonly body: URLSearchParams | null
  readonly chrome: AdminChrome
  readonly requestId: string | null
}

export interface CashUpDeps {
  readonly sql: Sql
  readonly now: () => number
}

/** The drawer the screen defaults to. One row is seeded, and a second drawer is a row and not a migration. */
const DEFAULT_DRAWER = 'reception'

const html = (body: string, status: number): Response =>
  new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  })

const fils = (value: number): string => formatMoney(money(filsFrom(value)))

function amountFils(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!/^[0-9]{1,12}$/.test(trimmed)) return null
  return Number(trimmed)
}

interface CashUpDay {
  readonly tradingDate: string
  readonly opensAt: Date
  readonly closesAt: Date
}

/**
 * The trading day, requested or in progress, WITH its own hours.
 *
 * The hours are read rather than written down: `premises_hours` is where they live and the `business_day` row
 * is how a reader reaches them, which is what `premises.test.ts` refuses a literal for.
 */
async function tradingDayFor(sql: Sql, now: number, requested: string): Promise<CashUpDay | null> {
  const wanted = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : null
  const [row] = await sql<{ trading_date: string; opens_at: Date; closes_at: Date }[]>`
    select to_char(trading_date, 'YYYY-MM-DD') as trading_date, opens_at, closes_at
      from business_day
     where case when ${wanted}::text is null then closes_at > ${new Date(now)}
                else trading_date = ${wanted}::date end
     order by trading_date
     limit 1
  `
  return row === undefined
    ? null
    : { tradingDate: row.trading_date, opensAt: row.opens_at, closesAt: row.closes_at }
}

const sessionView = (session: {
  id: string
  drawerCode: string
  tradingDate: string
  shiftNo: number
  status: 'open' | 'closed'
  openingFloatFils: number
  countedFloatFils?: number | null
  expectedFloatFils?: number | null
  discrepancyFils?: number | null
  countNote?: string | null
}): CashUpSessionView => ({
  sessionId: session.id,
  drawerCode: session.drawerCode,
  tradingDate: session.tradingDate,
  shiftNo: session.shiftNo,
  status: session.status,
  openingFloatLabel: fils(session.openingFloatFils),
  countedLabel:
    session.countedFloatFils === null || session.countedFloatFils === undefined
      ? null
      : fils(session.countedFloatFils),
  expectedLabel:
    session.expectedFloatFils === null || session.expectedFloatFils === undefined
      ? null
      : fils(session.expectedFloatFils),
  discrepancyLabel:
    session.discrepancyFils === null || session.discrepancyFils === undefined
      ? null
      : fils(Math.abs(session.discrepancyFils)),
  direction:
    session.discrepancyFils === null || session.discrepancyFils === undefined
      ? null
      : session.discrepancyFils === 0
        ? 'balanced'
        : session.discrepancyFils > 0
          ? 'over'
          : 'short',
  countNote: session.countNote ?? null,
})

async function buildView(args: {
  readonly deps: CashUpDeps
  readonly request: CashUpRequest
  readonly params: URLSearchParams
  readonly announcement: string
  readonly refusal: string | null
  readonly postedLines: CashUpView['postedLines']
}): Promise<CashUpView | null> {
  const { deps, params } = args
  const day = await tradingDayFor(deps.sql, deps.now(), params.get(CASH_UP_FIELDS.day) ?? '')
  if (day === null) return null
  const tradingDate = day.tradingDate
  const direction = params.get(CASH_UP_FIELDS.direction) === 'rtl' ? 'rtl' : 'ltr'
  const drawerCode = params.get(CASH_UP_FIELDS.drawer) ?? DEFAULT_DRAWER
  const drawers = await readCashDrawers(deps.sql)
  const open = await readOpenCashSession(deps.sql, drawerCode)
  const sessions = await readCashSessionsForBusinessDay(deps.sql, tradingDate)
  const takingsRow = open === null ? null : await readDrawerTakings(deps.sql, open.id)

  const query = new URLSearchParams()
  query.set(TILL_FIELDS.day, tradingDate)
  if (direction === 'rtl') query.set(TILL_FIELDS.direction, 'rtl')
  const previewQuery = new URLSearchParams(query)
  previewQuery.set(TILL_FIELDS.view, 'preview')
  const ownQuery = new URLSearchParams(query)
  ownQuery.set(CASH_UP_FIELDS.drawer, drawerCode)

  return {
    direction,
    chrome: args.request.chrome,
    action: `${TILL_CASH_UP_PATH}?${ownQuery.toString()}`,
    tillHref: `${TILL_PATH}?${query.toString()}`,
    previewHref: `${TILL_PATH}?${previewQuery.toString()}`,
    cashUpHref: `${TILL_CASH_UP_PATH}?${ownQuery.toString()}`,
    packagesHref: `${PACKAGES_PATH}?${query.toString()}`,
    tradingDate,
    hoursLabel:
      `${toLocal(day.opensAt.getTime() as Instant, ASIA_DUBAI).time} to ` +
      `${toLocal(day.closesAt.getTime() as Instant, ASIA_DUBAI).time}`,
    announcement: args.announcement,
    refusal: args.refusal,
    drawers: drawers.map((drawer) => ({
      code: drawer.code,
      label: drawer.label,
      postingAccountCode: drawer.postingAccountCode,
      chosen: drawer.code === drawerCode,
    })),
    drawerCode,
    open: open === null ? null : sessionView(open),
    takings:
      takingsRow === null
        ? null
        : {
            openingFloatLabel: fils(takingsRow.openingFloatFils),
            cashReceivedLabel: fils(takingsRow.cashReceivedFils),
            changeGivenLabel: fils(takingsRow.changeGivenFils),
            cashRefundedLabel: fils(takingsRow.cashRefundedFils),
            dropsLabel: fils(takingsRow.dropsFils),
            // `expectedFloat` in `@berelax/core`, which is the other statement of
            // `cash_session_expected_float_fils` in SQL — the two are held equal by
            // `packages/fixtures/src/cash-up.itest.ts`. The screen shows core's, so an operator sees the same
            // figure the generated column will hold before anything is written.
            expectedLabel: fils(expectedFloat(takingsRow)),
          },
    sessions: sessions.map(sessionView),
    postedLines: args.postedLines,
  }
}

const NOT_TRADING = (): Response =>
  new Response(
    'The premises did not trade on that day, so no drawer can be counted against it.\n',
    {
      status: 409,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    },
  )

export async function handleCashUpRead(
  request: CashUpRequest,
  deps: CashUpDeps,
): Promise<Response> {
  const view = await buildView({
    deps,
    request,
    params: request.searchParams,
    announcement:
      'Declare the opening float to start the shift, or count the drawer to close the one that is open.',
    refusal: null,
    postedLines: [],
  })
  return view === null ? NOT_TRADING() : html(renderCashUpHtml(view), 200)
}

export async function handleCashUpWrite(
  request: CashUpRequest,
  deps: CashUpDeps,
): Promise<Response> {
  const body = request.body ?? new URLSearchParams()
  const step = body.get(CASH_UP_FIELDS.step)
  const context = request.requestId === null ? {} : { requestId: request.requestId }

  const answer = async (
    announcement: string,
    refusal: string | null,
    status: number,
    posted: CashUpView['postedLines'] = [],
  ) => {
    const view = await buildView({
      deps,
      request,
      params: body,
      announcement,
      refusal,
      postedLines: posted,
    })
    return view === null ? NOT_TRADING() : html(renderCashUpHtml(view), status)
  }

  if (step === null) {
    return answer(
      'That request could not be read as a cash-up submission.',
      'That request could not be read as a cash-up submission.',
      400,
    )
  }

  const day = await tradingDayFor(deps.sql, deps.now(), body.get(CASH_UP_FIELDS.day) ?? '')
  if (day === null) return NOT_TRADING()
  const tradingDate = day.tradingDate
  const drawerCode = body.get(CASH_UP_FIELDS.drawer) ?? DEFAULT_DRAWER

  try {
    if (step === 'open') {
      const float = amountFils(body.get(CASH_UP_FIELDS.float) ?? '')
      if (float === null) {
        return answer(
          'An opening float has to be a whole number of fils, and a blank field is not a declaration of zero.',
          'An opening float has to be a whole number of fils, and a blank field is not a declaration of zero.',
          409,
        )
      }
      const session = await withUnitOfWork(
        deps.sql,
        { kind: 'staff', label: 'Cash-up' },
        async (uow) =>
          openCashSession(uow, { drawerCode, tradingDate, openingFloatFils: float }, 'staff'),
        context,
      )
      return answer(
        `Shift ${session.shiftNo} is open on ${session.drawerCode} with ${fils(session.openingFloatFils)} declared.`,
        null,
        200,
      )
    }

    if (step === 'drop') {
      const sessionId = body.get(CASH_UP_FIELDS.session) ?? ''
      const amount = amountFils(body.get(CASH_UP_FIELDS.dropAmount) ?? '')
      const destination = body.get(CASH_UP_FIELDS.dropDestination) ?? ''
      const reason = (body.get(CASH_UP_FIELDS.dropReason) ?? '').trim()
      if (amount === null || amount === 0 || reason === '') {
        return answer(
          'A drop needs an amount and a reason: cash leaving a drawer with neither is what a reconciliation cannot explain.',
          'A drop needs an amount and a reason: cash leaving a drawer with neither is what a reconciliation cannot explain.',
          409,
        )
      }
      const drawer = (await readCashDrawers(deps.sql)).find((row) => row.code === drawerCode)
      const posting = cashDropPosting(
        {
          // A FRESH id per drop, for the reason the package sale records: two drops of the same amount out of
          // one drawer in one shift is an ordinary evening, and a digest of the drop's own fields would make
          // the second one fail with a raw unique violation on `journal_entry.entry_id`.
          entryId: entryId(`cash-drop-${randomUUID()}`),
          businessDay: localDate(tradingDate),
          drawerCode,
          drawerAccount: accountCode(drawer?.postingAccountCode ?? '1010'),
          destinationAccount: accountCode(destination),
          amount: money(filsFrom(amount)),
          reason,
        },
        STANDARD_SPA_CHART,
      )
      await withUnitOfWork(
        deps.sql,
        { kind: 'staff', label: 'Cash-up' },
        async (uow) =>
          recordCashDrop(uow, {
            cashSessionId: sessionId,
            amountFils: amount,
            destinationAccountCode: destination,
            reason,
            posting: toEntryInput(posting),
          }),
        context,
      )
      return answer(`${fils(amount)} out of the drawer to ${destination}.`, null, 200)
    }

    if (step === 'close') {
      const sessionId = body.get(CASH_UP_FIELDS.session) ?? ''
      const counted = amountFils(body.get(CASH_UP_FIELDS.counted) ?? '')
      const note = (body.get(CASH_UP_FIELDS.note) ?? '').trim()
      const takings = await readDrawerTakings(deps.sql, sessionId)
      if (takings === null) {
        return answer('That shift is not open.', 'That shift is not open.', 409)
      }
      if (counted === null) {
        // `CountRequired`, refused before a statement is issued. An empty field is the absence of a count and
        // a zero is an empty drawer; treating the first as the second is how a shift acquires a figure
        // nobody measured.
        return answer(
          'CountRequired: a shift cannot be closed without a counted amount. A blank field is not a count of zero.',
          'CountRequired: a shift cannot be closed without a counted amount. A blank field is not a count of zero.',
          409,
        )
      }
      const reconciliation = reconcileDrawer(
        takings as DrawerTakingsRow,
        money(filsFrom(counted)),
        {
          drawerCode,
          businessDay: localDate(tradingDate),
        },
      )
      if (reconciliation.discrepancyFils !== 0 && note === '') {
        return answer(
          `The drawer is out by ${fils(Math.abs(reconciliation.discrepancyFils))} and carries no reason. A discrepancy nobody explained is a discrepancy nobody investigated.`,
          `The drawer is out by ${fils(Math.abs(reconciliation.discrepancyFils))} and carries no reason. A discrepancy nobody explained is a discrepancy nobody investigated.`,
          409,
        )
      }
      const drawer = (await readCashDrawers(deps.sql)).find((row) => row.code === drawerCode)
      // Whether an entry is needed is the sign of the discrepancy and nothing else, and ZU004 refuses the
      // pairing the other way round in both directions: a balanced session naming an entry, and a session
      // that is out naming none.
      const posting =
        reconciliation.discrepancyFils === 0
          ? undefined
          : cashUpPosting(
              {
                entryId: entryId(`cash-up-${sessionId}`),
                businessDay: localDate(tradingDate),
                drawerCode,
                drawerAccount: accountCode(drawer?.postingAccountCode ?? '1010'),
                reconciliation,
                countNote: note,
              },
              STANDARD_SPA_CHART,
            )
      const closed = await withUnitOfWork(
        deps.sql,
        { kind: 'staff', label: 'Cash-up' },
        async (uow) =>
          closeCashSession(
            uow,
            {
              cashSessionId: sessionId,
              countedFloatFils: counted,
              takings,
              ...(note === '' ? {} : { countNote: note }),
              ...(posting === undefined ? {} : { posting: toEntryInput(posting) }),
            },
            'staff',
          ),
        context,
      )
      const lines =
        posting === undefined
          ? []
          : posting.lines.map((line) => ({
              accountCode: line.account as string,
              debitLabel: line.debitFils === 0 ? '' : fils(line.debitFils),
              creditLabel: line.creditFils === 0 ? '' : fils(line.creditFils),
            }))
      return answer(
        closed.discrepancyFils === 0
          ? `Shift ${closed.shiftNo} closed and balanced at ${fils(counted)}.`
          : `Shift ${closed.shiftNo} closed ${(closed.discrepancyFils ?? 0) > 0 ? 'over' : 'short'} by ${fils(Math.abs(closed.discrepancyFils ?? 0))}, posted to 6140.`,
        null,
        200,
        lines,
      )
    }

    return answer(`Unknown step "${step}".`, `Unknown step "${step}".`, 400)
  } catch (error) {
    const message = isAppError(error) ? error.message : 'Unexpected.'
    return answer(message, message, 409)
  }
}
