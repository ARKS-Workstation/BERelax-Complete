import { loadConfig } from '@berelax/config'
import type { Instant } from '@berelax/core'
import { createConnection, type InboxFilter, listMessageInbox, type Sql } from '@berelax/db'
import { isAppError, MESSAGE_STATUSES, type MessageStatus } from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import { renderInboxHtml } from './render.ts'

/**
 * The admin Messages inbox: every message a vendor was asked to send, and what became of it.
 *
 * docs/12 §3 names this screen twice — SMSala's local outbox is "an admin *Messages* inbox", and
 * Resend's is "the same inbox, with an HTML preview pane" — and §1's prohibition is what it is for: a
 * stub must never look like it worked. So this lists the body, the encoding, the segments, the cost, the
 * status and every delivery receipt, including the ones that changed nothing.
 *
 * ## Why this is a route handler and not a page
 *
 * The same reason G-CONN-05's picker is one, one directory along: W-SITE-01's registry is in exact
 * bijection with the filesystem and requires every *document* to be served in both locales, so a
 * `page.tsx` here would need an Arabic admin document and the admin shell to render it — W-SYS-01's work
 * — and it would join a screenshot matrix whose RTL half must be a real Arabic route. This surface is
 * deliberately English-only: the acceptance criterion asks for three viewports times two themes, with no
 * direction axis, because it shows an operator what a vendor was sent. A handler answering
 * `text/html` is walkable today, is covered by the `/settings` noindex prefix, and is declared in
 * `apps/web/src/routes/registry.ts` as a handler.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, exactly as the consent
 * and picker routes next door record. It is read-only — GET, no mutation of any kind — so there is no
 * actor to record and none is invented: the only writer in this unit is the worker's DLR pass, whose
 * receipts carry the vendor that sent them. It must not be deployed to a reachable environment before
 * W-SYS-01, because the bodies it renders are customer messages. The recipient is masked for the same
 * reason the fakes' call log masks: this page is screenshotted and the gallery is published as a link.
 */
export const dynamic = 'force-dynamic'

function parseFilter(url: URL): InboxFilter & { readonly limit: number } {
  const status = url.searchParams.get('status')
  const limitParam = Number(url.searchParams.get('limit') ?? '')
  // Bounded rather than trusted: an unbounded `limit` on an append-only-ish table is a page that gets
  // slower every week and a screenshot that changes size every run.
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50
  return {
    limit,
    ...(url.searchParams.get('template') === null
      ? {}
      : { templateKey: url.searchParams.get('template') as string }),
    ...(url.searchParams.get('recipient') === null
      ? {}
      : { recipient: url.searchParams.get('recipient') as string }),
    // Validated against the closed set: an unknown status would silently return everything, and a
    // filtered view that quietly is not filtered is worse than an error.
    ...(status !== null && (MESSAGE_STATUSES as readonly string[]).includes(status)
      ? { status: status as MessageStatus }
      : {}),
  }
}

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const config = loadConfig()
    const filter = parseFilter(new URL(request.url))
    const { entries, chrome } = await withSql(async (sql) => ({
      entries: await listMessageInbox(sql, filter),
      chrome: await adminChromeFor({ sql, now: Date.now() as Instant, request }),
    }))
    return new Response(
      renderInboxHtml({
        chrome,
        entries,
        filter: {
          templateKey: filter.templateKey ?? null,
          recipient: filter.recipient ?? null,
          status: filter.status ?? null,
          limit: filter.limit,
        },
        smsProvider: config.SMS_PROVIDER,
        emailProvider: config.EMAIL_PROVIDER,
      }),
      {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          // Never cached: the list is the evidence, and a cached copy of an admin screen outlives the
          // page (the same reason `noarchive` is in the registry's robots directive).
          'cache-control': 'no-store',
        },
      },
    )
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looks like an
    // empty inbox would say "nothing was sent" when the truth is "nothing could be read".
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The Messages inbox could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
