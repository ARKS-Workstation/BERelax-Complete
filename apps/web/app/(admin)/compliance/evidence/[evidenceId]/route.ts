import { loadConfig } from '@berelax/config'
import {
  type Actor,
  createConnection,
  recordEvidenceDownload,
  redeemObligationEvidenceGrant,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { appMediaStorage } from '../../../../../src/media/storage.ts'

/**
 * `GET /compliance/evidence/{evidenceId}?grant=…` — one filed evidence file, privately.
 *
 * docs/04 §9's evidence attachment, served. M-VAT-10 left the bytes unreachable on purpose — the storage
 * key and content hash exist because the completion trigger needs something real to join to — and
 * M-TILL-12's NOTE asked whichever unit landed first to own the capability rather than build a second one.
 *
 * ## Every refusal is 403, and never 404
 *
 * A 404 for an evidence id that does not exist and a 403 for one that does is an oracle: it answers "has
 * an inspection report been filed against this occurrence" to anybody who can guess a uuid, which is a
 * fact about the premises. So the four refusals — no grant, an unknown grant, an expired grant, and a
 * valid grant for a different file — all answer 403 with the reason named in the body. The reason is safe
 * to state: it tells the holder of a dead link why it is dead and tells a stranger nothing they did not
 * already supply.
 *
 * The one exception is `[evidence-object-missing]`, a 404 for a row whose bytes are not in the bucket.
 * That is not an oracle — the caller already held a valid grant for that exact file — and it must not
 * read as 403, because "you may not have this" and "we have lost this" are different incidents.
 *
 * ## The grant is the gate, and it is the only one
 *
 * There is no admin session until W-SYS-01, which `/hr/credentials`, `/settings/messages` and the two
 * Google routes each record. So this route does not additionally check a role, and that is a stated
 * boundary rather than an omission: the grant carries the role it was minted for, the mint is a function
 * in `packages/db` rather than an endpoint, and an unauthenticated mint endpoint would hand a link to
 * anybody who asked — which is the whole of what this 403 exists to prevent.
 *
 * ## Every download writes an audit_event
 *
 * Including a repeat of the same link, because a second download is a second copy leaving the business.
 * The audit row names the content HASH and never the storage key: the hash says which bytes were served
 * and the key is a path into the private bucket.
 */
export const dynamic = 'force-dynamic'

const ACTOR: Actor = { kind: 'system', label: 'compliance.evidence-download' }

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

function text(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** What a reader is told when the link does not open. One sentence each, no guessing. */
const REFUSAL_MESSAGE: Readonly<Record<string, string>> = {
  grant_absent:
    'This evidence file is private and this request carried no grant. A download link is minted for a ' +
    'named role, for a stated purpose, and it expires.',
  grant_unknown: 'That grant is not one this system issued, or it has been revoked.',
  grant_expired: 'That download link has expired. Evidence links are deliberately short-lived.',
  grant_not_for_this_evidence:
    'That grant is valid and it is for a different file. A grant opens one attachment, not the filing ' +
    'cabinet.',
}

export async function GET(
  request: Request,
  context: { params: Promise<{ evidenceId: string }> },
): Promise<Response> {
  const { evidenceId } = await context.params
  try {
    const grant = new URL(request.url).searchParams.get('grant')
    const resolved = await withSql(async (sql) => {
      const outcome = await redeemObligationEvidenceGrant(sql, { evidenceId, token: grant })
      if (outcome.kind === 'refused') return outcome

      const storage = appMediaStorage()
      const bytes = await storage
        .get({ bucket: 'private', key: outcome.evidence.storageKey })
        .catch(() => undefined)
      if (bytes === undefined) return { kind: 'missing' as const }

      // The audit row is written BEFORE the bytes are returned, inside its own unit of work, so a
      // download that reached the reader is never one the trail is missing. The other order — stream
      // first, record afterwards — loses the record for exactly the requests that mattered most.
      await withUnitOfWork(sql, ACTOR, (uow) =>
        recordEvidenceDownload(uow, { evidence: outcome.evidence, bytes: bytes.byteLength }),
      )
      return { kind: 'granted' as const, bytes, contentHash: outcome.evidence.contentHash }
    })

    if (resolved.kind === 'refused') {
      return text(`${REFUSAL_MESSAGE[resolved.reason] ?? 'Refused.'} (${resolved.reason})\n`, 403)
    }
    if (resolved.kind === 'missing') {
      return text(
        `[evidence-object-missing] the grant is valid and the object is not in the private bucket. ` +
          'This is a lost file rather than a refused one, which is why it is a 404 and not a 403.\n',
        404,
      )
    }

    return new Response(new Uint8Array(resolved.bytes), {
      headers: {
        // `application/octet-stream` and an attachment disposition rather than the stored type. A hygiene
        // report is whatever an inspector handed over — a photograph, a PDF, a scan — and rendering an
        // untrusted upload inline in an admin origin is the stored-XSS path a `Content-Disposition` closes.
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="evidence-${resolved.contentHash.slice(0, 12)}"`,
        'cache-control': 'private, no-store',
        // A private file must never be indexed even if a link escapes: the admin prefix already carries
        // this through the proxy, and stating it on the response means a direct hit cannot lose it.
        'x-robots-tag': 'noindex, nofollow, noarchive',
      },
    })
  } catch (error) {
    const message = isAppError(error) ? error.message : 'Unexpected'
    return text(`The evidence file could not be served: ${message}\n`, 503)
  }
}
