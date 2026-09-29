import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import {
  createConnection,
  readMessagingControls,
  type Sql,
  toggleMessagingControl,
  withUnitOfWork,
} from '@berelax/db'
import { assertMayToggleMessagingControl, resolveMarketingKillSwitch } from '@berelax/messaging'
import {
  isAppError,
  MESSAGING_CONTROL_DIRECTIONS,
  MESSAGING_CONTROL_KEYS,
  type MessagingControlDirection,
  type MessagingControlKey,
} from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../../src/session.ts'
import { controlViewsFrom, renderControlsHtml } from './render.ts'

/**
 * The promotional controls console — C-AUTO-05.
 *
 * GET shows the marketing kill switch and the promotional sender-ID suspension, each with the actor, the
 * instant and the reason of its last change, and above them the one banner every admin surface reads through
 * `promotionalSendingBanner`. POST moves one of the two.
 *
 * ## Why the toggle is a POST on this route and not a separate endpoint
 *
 * One URL, so the permission decision, the write and the screen that shows the result cannot disagree about
 * what happened. The refusal a role gets is rendered on the same document rather than as a bare 403 body,
 * because the person reading it needs to know who to ask.
 *
 * ## The three layers this handler sits on top of
 *
 *   1. `guardAdminRoute` — W-SYS-11's session. Refuses a request with no live staff session, and fails closed.
 *   2. `assertMayToggleMessagingControl` — the role rule, from `@berelax/core`'s matrix via `@berelax/messaging`.
 *      Owner and manager may; receptionist, marketer and everybody else are refused by name.
 *   3. `messaging_control_role_may_toggle()` in migration 0098 — `ZY082`, and the only layer that holds for a
 *      `psql` session, a seed, or an import of another environment's rows.
 *
 * None of the three is the others' backup: the first cannot see a role's permissions, the second is not in the
 * path of a script, and the third cannot produce a sentence with a link in it.
 *
 * ## Why `APP_ENV` decides the switch as well as the row
 *
 * `resolveMarketingKillSwitch` ORs the stored decision with "this is not production", and the banner is
 * rendered from the RESULT. Rendering the row alone would make a staging console say "sending" while the gate
 * refused every send — the second statement of the switch's state that the one-home rule exists to remove.
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

const HTML = {
  'content-type': 'text/html; charset=utf-8',
  // Never cached: the state of a kill switch is the one thing a stale copy must never show.
  'cache-control': 'no-store',
} as const

/** The whole page, for a GET or for the answer to a POST. One renderer, so the two cannot diverge. */
async function page(
  sql: Sql,
  request: Request,
  role: string,
  notice: { readonly kind: 'refused' | 'done'; readonly detail: string } | null,
): Promise<Response> {
  const config = loadConfig()
  const rows = await readMessagingControls(sql)
  const killSwitch = resolveMarketingKillSwitch({
    stored: rows.marketing_kill_switch.engaged,
    appEnv: config.APP_ENV,
  })
  let mayToggle = true
  try {
    // Asked with a reason that would pass, so what is being tested is the ROLE. The form is absent rather
    // than present-and-refused for somebody who may not: a control you can press and cannot use is worse
    // than one that is not there, because the refusal arrives after the decision has been made.
    assertMayToggleMessagingControl({
      controlKey: 'marketing_kill_switch',
      direction: 'engage',
      role,
      reason: 'probe',
    })
  } catch {
    mayToggle = false
  }
  return new Response(
    renderControlsHtml({
      killSwitch,
      controls: controlViewsFrom(rows),
      role,
      mayToggle,
      notice,
      // The re-auth banner's source, read per request like every other admin screen's: this console is where
      // somebody looks when messages are not arriving, so "the Google connection is dead" belongs on it.
      chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
    }),
    { headers: HTML },
  )
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else. `guardAdminRoute` never throws and fails closed, so it is
  // safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  try {
    return await withSql((sql) => page(sql, request, authorised.principal.role, null))
  } catch (error) {
    // Plain text and a 503: a blank page here would read as "nothing is stopping promotional sending", which
    // is the one wrong answer this screen can give.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The promotional controls could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const { role, staffReference } = authorised.principal

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return new Response('The toggle form could not be read.\n', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const control = String(form.get('control') ?? '')
  const direction = String(form.get('direction') ?? '')
  const reason = String(form.get('reason') ?? '')

  // Validated against the closed sets before the role is consulted, because an unknown control is a bad
  // request rather than a forbidden one — and answering 403 to a typo would send somebody to find a manager
  // for a form that would not have worked either way.
  if (!(MESSAGING_CONTROL_KEYS as readonly string[]).includes(control)) {
    return new Response(`'${control}' is not a messaging control.\n`, {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
  if (!(MESSAGING_CONTROL_DIRECTIONS as readonly string[]).includes(direction)) {
    return new Response(`'${direction}' is not a direction.\n`, {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }

  const controlKey = control as MessagingControlKey
  const engaged = (direction as MessagingControlDirection) === 'engage'

  try {
    assertMayToggleMessagingControl({
      controlKey,
      direction: direction as MessagingControlDirection,
      role,
      reason,
    })
  } catch (error) {
    const detail = isAppError(error) ? error.message : 'This change was refused.'
    /*
      The STATUS comes from the error's kind, and getting that wrong was a real defect this route shipped
      with for one test run.

      `assertMayToggleMessagingControl` refuses two different things — a role that may not toggle
      (`forbidden`) and a missing reason (`validation`) — and mapping every throw from it to 403 answered
      "not you" to a manager who had simply left the reason box empty. That sends somebody to find the owner
      for a form that would not have worked for the owner either, and it is the wrong thing for a browser to
      remember about the request. `apps/web/src/marketing-kill-switch.itest.ts` caught it: the case asserting
      the blank-reason refusal read 403 where it expected a state refusal.

      403 only for `forbidden`, 400 for anything else, and the SCREEN in both cases — a refusal readable on
      the page it was refused from, because a bare status code tells a manager nothing about what to do next.
    */
    const status = isAppError(error) && error.kind === 'forbidden' ? 403 : 400
    return await withSql(async (sql) => {
      const answer = await page(sql, request, role, { kind: 'refused', detail })
      return new Response(await answer.text(), { status, headers: HTML })
    })
  }

  return await withSql(async (sql) => {
    try {
      const moved = await withUnitOfWork(
        sql,
        // The employment record's internal handle, which names no person (ADR 0020) and is what the audit
        // row carries. A display name here would put a person's name in an append-only table.
        { kind: 'staff', label: staffReference },
        (uow) =>
          toggleMessagingControl(uow, {
            controlKey,
            engaged,
            role,
            actorLabel: staffReference,
            reason,
            at: Date.now(),
          }),
      )
      return await page(sql, request, role, {
        kind: 'done',
        detail: `${controlKey} is now ${moved.after.engaged ? 'engaged' : 'not engaged'}.`,
      })
    } catch (error) {
      const detail = isAppError(error) ? error.message : 'The change could not be recorded.'
      const answer = await page(sql, request, role, { kind: 'refused', detail })
      // 409 rather than 400 for the two refusals a well-formed request can still get — a no-op toggle and a
      // blank reason — because the request is valid and the state is what refused it.
      return new Response(await answer.text(), { status: 409, headers: HTML })
    }
  })
}
