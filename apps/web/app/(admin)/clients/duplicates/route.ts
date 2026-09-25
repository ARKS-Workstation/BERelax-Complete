import { loadConfig } from '@berelax/config'
import {
  buildDuplicateQueue,
  type CustomerMergeSubject,
  DUPLICATE_AUTO_MERGE_THRESHOLD,
  DUPLICATE_REVIEW_THRESHOLD,
  DUPLICATE_THRESHOLDS_OPEN_QUESTION,
} from '@berelax/core'
import { createConnection, type Sql, scanDuplicateQueue } from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { atFrom, directionFrom, limitFrom, scopeFrom } from './params.ts'
import { renderDuplicateQueueHtml } from './render.ts'

/**
 * `GET /clients/duplicates` — the duplicate review queue (C-CRM-06).
 *
 * The scan is `@berelax/db`'s (C-CRM-02's query, unchanged, once per record), the scoring and the ordering
 * are `@berelax/core`'s `buildDuplicateQueue`, and this route is the join: it may import both, and neither
 * of them may import the other. Nothing is computed here that either of those two decides — in particular
 * the survivor, which the queue reads off `planCustomerMerge` so that the record named on the screen is the
 * record the merge will keep.
 *
 * **It writes nothing.** Not even a read is recorded: there is no admin session until W-SYS-01, so there is
 * no actor to attribute a view to, and the provisional line on this unit is that every merge is confirmed by
 * a human on the preview page. The queue is a list with links.
 *
 * ## The query parameters, and why each exists
 *
 *   - `customer` (repeatable) narrows the whole pass to a named set. The integration suite runs sequentially
 *     against one database and earlier files leave rows behind (brief rule 12), so every assertion about the
 *     contents of this page narrows through it — the instrument `/compliance` uses with `?key=`.
 *   - `limit` is the probe bound. It is a window over the newest records and the page says so.
 *   - `at` is the instant consent is resolved at on the preview, carried through every link so a reviewer
 *     who opens a preview is asking about the same moment the queue was built for. A screenshot needs it:
 *     a page that read the clock could not be photographed twice.
 *   - `dir=rtl` mirrors the layout. A direction axis rather than a locale — see `render.ts`.
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

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const customerIds = scopeFrom(url)
    const subjectLimit = limitFrom(url)
    const atIso = atFrom(url)
    const direction = directionFrom(url)

    const html = await withSql(async (sql) => {
      const scan = await scanDuplicateQueue(sql, {
        ...(customerIds === undefined ? {} : { customerIds }),
        subjectLimit,
      })
      // The records arrive in the merge plan's own shape (`readCustomerMergeSubjects`), so the cast is a
      // brand and not a conversion: `createdAt` is epoch milliseconds on both sides, which is what
      // `Instant` is. `packages/fixtures/src/merge.itest.ts` asserts that agreement with `satisfies`.
      const records = scan.records.map((entry) => ({
        subject: entry.subject as CustomerMergeSubject,
        isMergedAway: entry.isMergedAway,
      }))
      const queue = buildDuplicateQueue({ records, edges: scan.edges })
      return renderDuplicateQueueHtml({
        queue,
        scope: {
          customerIds: customerIds ?? null,
          recordsProbed: scan.recordsProbed,
          scansIssued: scan.scansIssued,
          bounded: scan.bounded,
          subjectLimit,
          atIso,
          direction,
        },
        reviewPerMille: DUPLICATE_REVIEW_THRESHOLD * 1000,
        autoMergePerMille: DUPLICATE_AUTO_MERGE_THRESHOLD * 1000,
        thresholdsOpenQuestion: DUPLICATE_THRESHOLDS_OPEN_QUESTION,
      })
    })

    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error) {
    // A refused parameter is the caller's, a failed read is not, and the two must not answer the same way:
    // a blank queue that looked like an empty list would say "there are no duplicates" when the truth is
    // "nothing could be read". `/compliance` makes the same split.
    const isRequest = error instanceof TypeError
    const message = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
    return new Response(`The duplicate review queue could not be read: ${message}\n`, {
      status: isRequest ? 400 : 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
