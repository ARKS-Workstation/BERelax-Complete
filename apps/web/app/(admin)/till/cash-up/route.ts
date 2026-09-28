import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { handleCashUpRead, handleCashUpWrite } from './handler.ts'

/**
 * `GET`/`POST /till/cash-up` — the Next binding for the drawer reconciliation (M-TILL-13).
 *
 * Everything decidable lives in `./handler.ts`. `max: 2` and the `finally` are the till route's, for the same
 * reason: this is a page load, not a pass over the book.
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

const now = (): number => Date.now()

function unavailable(error: unknown): Response {
  const message = isAppError(error) ? error.message : 'Unexpected'
  return new Response(`Cash-up is not available: ${message}\n`, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    return await withSql(async (sql) =>
      handleCashUpRead(
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
  try {
    const url = new URL(request.url)
    const body = new URLSearchParams(await request.text())
    return await withSql(async (sql) =>
      handleCashUpWrite(
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
