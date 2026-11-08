import { loadConfig } from '@berelax/config'
import { can, type Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../src/components/admin/google-reauth-source.ts'
import { guardAdminRoute } from '../../../src/session.ts'
import { handleRecordVisitRead, handleRecordVisitWrite } from './handler.ts'

/**
 * `GET`/`POST /record-visit` — the Next binding for recording a treatment that already happened.
 *
 * Everything decidable lives in `./handler.ts`, which the integration suite drives directly with an
 * injected clock; this file is the connection, the clock, the two verbs and the permission. The split the
 * diary, the pipeline board and quick-book all take, and here the clock matters more than on any of them:
 * the horizon is measured from `now`, so a test that could not freeze it could only assert dates relative
 * to the day it ran.
 */
export const dynamic = 'force-dynamic'

/**
 * The permission this screen requires, and why it is this one.
 *
 * `booking:override_constraints` — held by `manager` and `owner`, and deliberately NOT by `receptionist`.
 *
 * The constraints it names are the ones that make a booking honest: the availability gate, the desk's lead
 * time, and the rule that an appointment reaches `completed` by being walked there while somebody watched.
 * Recording a past visit steps around the first two by design — that is the whole feature — so it is the
 * permission whose definition already covers what this screen does.
 *
 * It is also the right ANSWER about who should do this. A backdated entry writes money into a trading day
 * that has already been counted, and the person who noticed the oversight is usually the person who made
 * it. Requiring a manager puts a second pair of eyes on a correction to the books without inventing an
 * approval queue — and `permissions.test.ts` already asserts which roles hold it, so this cannot drift
 * silently.
 *
 * The refusal is a 403 with the role named, not a redirect: a receptionist who followed a link from the
 * menu should be told what is needed rather than sent to sign in again as somebody they are not.
 */
export const RECORD_VISIT_PERMISSION = 'booking:override_constraints' as const

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  // `max: 2` for the reason quick-book, the diary and the HR routes give: this is a page load, not a pass
  // over the book, and the integration suite opens a large pool of its own to prove a row lock.
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

const now = (): number => Date.now()

/**
 * 503 and `text/plain`, deliberately not a document.
 *
 * Every file under `app/(admin)` that emits a doctype has to render the Google re-auth banner (G-CONN-08)
 * and `google-reauth-banner.test.ts` walks the tree to say so. A one-sentence refusal for a database
 * nobody can reach is not a page, and dressing it as one would put a second, bannerless copy of the shell
 * in this file — quick-book's `unavailable` records the same argument.
 */
function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`Recording a missed visit is not available: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function forbidden(role: string): Response {
  return new Response(
    `The role "${role}" may not ${RECORD_VISIT_PERMISSION}, which recording a visit after the fact ` +
      'requires. A manager or the owner can enter it.\n',
    {
      status: 403,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    },
  )
}

export async function GET(request: Request): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  if (!can(authorised.principal.role, RECORD_VISIT_PERMISSION)) {
    return forbidden(authorised.principal.role)
  }
  try {
    const url = new URL(request.url)
    return await withSql(async (sql) =>
      handleRecordVisitRead(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          body: null,
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  // Checked on the WRITE as well as on the read, and not only on the read. A POST reaches a route handler
  // without ever having rendered its GET, so a permission enforced on the page and not on the submission
  // is a permission enforced on the menu.
  if (!can(authorised.principal.role, RECORD_VISIT_PERMISSION)) {
    return forbidden(authorised.principal.role)
  }
  try {
    const url = new URL(request.url)
    // `application/x-www-form-urlencoded` only. This screen has no JSON client: it is two
    // `<form method="post">` submissions, which is what makes it work with JavaScript off. A body that is
    // not form-encoded parses to an empty `URLSearchParams`, which the handler refuses by name as
    // `unreadable_request` rather than as a 500.
    const body = new URLSearchParams(await request.text())
    return await withSql(async (sql) =>
      handleRecordVisitWrite(
        {
          searchParams: url.searchParams,
          chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
          body,
          requestId: request.headers.get('x-request-id'),
        },
        { sql, now },
      ),
    )
  } catch (error) {
    return unavailable(error)
  }
}
