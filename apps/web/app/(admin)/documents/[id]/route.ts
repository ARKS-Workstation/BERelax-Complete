import { loadConfig } from '@berelax/config'
import { documentReadRefusal } from '@berelax/core'
import {
  type Actor,
  authoriseDocumentFetch,
  createConnection,
  readPrivateDocument,
  type Sql,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { appDocumentUrlSigner, appMediaStorage } from '../../../../src/media/storage.ts'
import { guardAdminRoute } from '../../../../src/session.ts'

/**
 * `GET /documents/{id}?cls=…&exp=…&n=…&kid=…&sig=…` — one private document, privately (W-SYS-14).
 *
 * The one route every private document is fetched through: filed tax invoices and credit notes, VAT return
 * snapshots, payslips, clinical extracts, compliance evidence. Before this, `writeTaxDocumentPdf()` wrote a
 * tax invoice to a path a caller chose, so a statutory document was readable by anybody who learned the
 * path and nothing recorded a read.
 *
 * ## Three gates, in this order, and the order is the design
 *
 *   1. **The session.** `guardAdminRoute` first, because it never throws and fails closed, so it is safe
 *      outside this handler's own `try`. An unauthenticated request gets the 303 every admin route gets —
 *      not a 403 — because the reader is a person at a desk and a redirect to the login screen with their
 *      destination remembered is the thing they wanted.
 *   2. **The signature.** Verified before the document is looked up, so a request with no signature costs
 *      no database round trip and tells the caller nothing about whether the id exists.
 *   3. **The authorisation matrix.** `documentReadRefusal` from `@berelax/core`, which asks `can()` and
 *      `canReadFieldGroup()`. A valid signature is NOT permission: a receptionist handed a link to a
 *      payslip is refused, and so is a marketer handed a link to a tax document. That is the acceptance
 *      line, and it is the reason the signature is over the document and not over a principal — a scheme
 *      where the signature carried the role would make a forwarded link a role grant.
 *
 * Then, and only then, the fetch is burned and audited in ONE transaction, and the bytes are read.
 *
 * ## Every refusal is 403, and never 404
 *
 * A 404 for a document id that does not exist and a 403 for one that does is an oracle: it answers "does
 * this business hold a payslip for employee X" to anybody who can guess a uuid. So an unknown id, an absent
 * signature, a malformed one, a forged one, an expired one, a used one and a refused role all answer 403
 * with the reason named in the body. The reason is safe to state: it tells the holder of a dead link why it
 * is dead and tells a stranger nothing they did not already supply. This is M-VAT-11's argument for its
 * evidence route, applied unchanged because it was right.
 *
 * The one exception is `[document-object-missing]`, a 404 for a register row whose bytes are not in the
 * bucket. That is not an oracle — the caller held a valid signature for that exact document and passed the
 * matrix — and it must not read as 403, because "you may not have this" and "we have lost this" are
 * different incidents.
 *
 * ## Why the audit row is written BEFORE the bytes are read
 *
 * The burn and the audit row are one transaction, and the transaction commits before `storage.get`. A
 * download that reached the reader is therefore never one the trail is missing. The other order — stream
 * first, record afterwards — loses the record for exactly the requests that mattered most. The cost is that
 * a fetch recorded for bytes that then turn out to be absent leaves a row saying a download happened when
 * it did not, which is why that case answers 404 with a named reason rather than silently: an over-recorded
 * download is a question somebody can ask, and an unrecorded one is not.
 */
export const dynamic = 'force-dynamic'

/** Why a reader did not get the document. Every one answers 403. */
const REFUSAL_MESSAGE: Readonly<Record<string, string>> = {
  signature_absent:
    'This document is private and this request carried no signature. A link is minted for one document, ' +
    'expires, and does not make its holder anybody.',
  signature_malformed:
    'That link is not shaped like one this system issues. Ask for the document again rather than editing ' +
    'the address.',
  signature_unknown_key:
    'That link was signed under a key this deployment no longer holds. It was ours and it is dead; ask ' +
    'for the document again.',
  signature_invalid:
    'That signature does not match this document. A link opens the one document it was minted for, not ' +
    'the filing cabinet.',
  signature_expired: 'That link has expired. Document links are deliberately short-lived.',
  signature_already_used:
    'That link has already been used. A payslip or a clinical extract is single-use: there is no ' +
    'legitimate reason for one link to yield two copies of it. Ask for the document again.',
  document_unknown:
    'This document is private and this request carried no signature valid for it. A link is minted for ' +
    'one document, expires, and does not make its holder anybody.',
  permission_denied:
    'Your role may not read this kind of document. A valid link authorises a FETCH and never a person: ' +
    'the permission is checked separately, every time, against the same matrix every screen uses.',
  field_group_denied:
    'Your role may reach this kind of record and not the figures on this document. That distinction is ' +
    'deliberate and is checked here as well as on every screen.',
  document_class_unknown:
    'This document is filed under a class this build does not recognise, so there is no permission that ' +
    'could grant it. Nothing can read it until the class is added to the catalogue.',
}

const ACTOR_KIND = 'staff' as const

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
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      // A refusal must not be indexed either: the reason names the document class, and a cached refusal is
      // served to the next reader who does hold the permission.
      'x-robots-tag': 'noindex, nofollow, noarchive',
    },
  })
}

const refused = (reason: string): Response =>
  text(`${REFUSAL_MESSAGE[reason] ?? 'Refused.'} (${reason})\n`, 403)

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  // W-SYS-11: the session, before anything else this handler does. `guardAdminRoute` never throws and
  // fails closed, so it is safe as the first statement and outside this handler's own `try`.
  const authorised = await guardAdminRoute(request)
  if ('response' in authorised) return authorised.response
  const { principal } = authorised
  const { id } = await context.params

  try {
    const signer = appDocumentUrlSigner()
    if (signer === undefined) {
      // 503 and not 403: nothing about this request is wrong. The deployment has no signing key, so no
      // document can be authorised at all, and saying "you may not have this" would send the reader to
      // ask for a permission that would not help.
      return text(
        '[document-signing-not-configured] this deployment holds no document signing key, so no private ' +
          'document can be authorised. Set DOCUMENT_URL_SIGNING_SECRET. Serving the bytes unsigned would ' +
          'be worse than serving nothing.\n',
        503,
      )
    }

    const params = new URL(request.url).searchParams
    const nowEpochSeconds = Math.floor(Date.now() / 1000)
    const verified = signer.verify(params, { documentId: id }, nowEpochSeconds)
    if (verified.kind === 'refused') return refused(verified.reason)

    const outcome = await withSql(async (sql) => {
      const document = await readPrivateDocument(sql, id)
      // An unknown id is 403 and carries the same sentence as an absent signature. See the header: a 404
      // here is an oracle for which documents this business holds.
      if (document === undefined) return { kind: 'refused' as const, reason: 'document_unknown' }

      /*
        The class is taken from the ROW and compared to the one in the signature, rather than trusted from
        the query string. The signature covers the class, so a mismatch means the row was re-registered
        under a different class after the link was minted — which migration 0101 refuses outright, because
        the register is append-only. Checked anyway: this is the assertion that would notice if that trigger
        were ever removed, and it costs one comparison.
      */
      if (document.documentClass !== verified.documentClass) {
        return { kind: 'refused' as const, reason: 'signature_invalid' }
      }

      const denial = documentReadRefusal(principal.role, document.documentClass)
      if (denial !== undefined) return { kind: 'refused' as const, reason: denial }

      const actor: Actor = { kind: ACTOR_KIND, label: principal.staffReference }
      // The transaction is `authoriseDocumentFetch`'s, not this handler's, and that is where `ZY111` is
      // translated: a replay ABORTS the transaction, so catching it inside would swallow the refusal and
      // then fail at COMMIT — which is how a replayed link answered 503 in the first run of the suite.
      const burn = await authoriseDocumentFetch(sql, actor, {
        document,
        signatureNonce: verified.nonce,
        signatureKeyVersion: verified.keyVersion,
        role: principal.role,
        actorLabel: principal.staffReference,
      })
      if (burn.kind === 'refused') return { kind: 'refused' as const, reason: burn.reason }
      return { kind: 'authorised' as const, document }
    })

    if (outcome.kind === 'refused') return refused(outcome.reason)

    const bytes = await appMediaStorage()
      .get({ bucket: 'private', key: outcome.document.storageKey })
      .catch(() => undefined)
    if (bytes === undefined) {
      return text(
        '[document-object-missing] the signature is valid, your role may read this document, and the ' +
          'bytes are not in the private bucket. This is a lost file rather than a refused one, which is ' +
          'why it is a 404 and not a 403. The fetch is recorded: an over-recorded download is a question ' +
          'somebody can ask, and an unrecorded one is not.\n',
        404,
      )
    }

    return new Response(new Uint8Array(bytes), {
      headers: {
        // `application/octet-stream` and an attachment disposition rather than the stored content type. A
        // filed document may be a PDF the renderer produced or a scan an inspector handed over, and
        // rendering an untrusted upload inline in the admin origin is the stored-XSS path a
        // `Content-Disposition` closes. The stored type is on the row for the question "what did we file".
        'content-type': 'application/octet-stream',
        // The content hash and never the storage key: the key is a path into the private bucket, and a
        // filename is a thing a reader saves and forwards.
        'content-disposition':
          `attachment; filename="${outcome.document.documentClass}-` +
          `${outcome.document.contentSha256.slice(0, 12)}"`,
        'cache-control': 'private, no-store',
        // A private document must never be indexed even if a link escapes: the admin prefix already carries
        // this through the proxy, and stating it on the response means a direct hit cannot lose it.
        'x-robots-tag': 'noindex, nofollow, noarchive',
      },
    })
  } catch (error) {
    const message = isAppError(error) ? error.message : 'Unexpected'
    return text(`The document could not be served: ${message}\n`, 503)
  }
}
