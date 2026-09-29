import { randomUUID } from 'node:crypto'
import { DOCUMENT_SIGNATURE_TTL_SECONDS } from '@berelax/core'
import {
  type Actor,
  createConnection,
  registerPrivateDocument,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { createFixturePrincipal, type FixturePrincipal } from '@berelax/fixtures'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import {
  createDocumentUrlSigner,
  DOCUMENT_SIGNATURE_PARAMS,
  type DocumentUrlSigner,
  mintDocumentNonce,
} from '@berelax/media/storage'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appMediaStorage } from './media/storage.ts'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

/**
 * W-SYS-14 — the private document route, driven against the built application.
 *
 * Five claims live here and nowhere else, because none can be checked by reading source or by calling a
 * function. Every one is about a RESPONSE:
 *
 *   1. an **unsigned** request for a document path is refused with **403 by the route**, not by the storage
 *      layer — which is why this is a served response and not an assertion on `verify`;
 *   2. an **expired** signature is refused with a **distinct named reason** from an absent one;
 *   3. a signature for document A does **not** authorise document B, with the path swapped and the
 *      signature kept;
 *   4. a **receptionist** holding a valid link to a **payslip** and a **marketer** holding a valid link to a
 *      **tax document** are both refused, although the signature is genuine — the permission is the
 *      authorisation matrix's, checked every time;
 *   5. every download writes an `audit_event`, and a **single-use** document's second fetch is refused.
 *
 * ## Isolation, and the rows this file cannot take back
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12), so nothing here counts rows in a table anybody else writes. `audit_event` is asserted as a
 * DELTA around one request and counted in SQL rather than through a capped reader — `settings-store.itest.ts`
 * read a delta through a `limit` and got zero for three real changes.
 *
 * The `private_document` rows this file registers are **permanent** and that is stated rather than hidden:
 * migration 0101 refuses DELETE for every role including the owner (`ZY112`), because the register is what an
 * audited download names. Their ids are fresh uuids per run, their storage keys carry this suite's marker,
 * and nothing else reads them — so an accumulating register costs a row per run and confuses nothing. The
 * `private_document_fetch` rows are permanent for the same reason and are the record the suite is about.
 *
 * ## Why the signer is built here from the same secret the server is given
 *
 * The screen that OFFERS a download does not exist yet (it belongs with the unit that builds it — see the
 * NOTE in `build/manifest.yaml`), so there is no endpoint to mint a link from, and inventing one would be
 * inventing an unauthenticated mint endpoint that hands a link to anybody who asks. So this suite mints them
 * the way that screen will: through `MediaStorage.sign`, and — for the cases that need an expiry in the past
 * or a nonce that was never stored — through a signer built on the same key. That the two agree is itself a
 * claim: a suite signing with one key against a server holding another would fail every case here, so the
 * green run is evidence the wiring in `apps/web/src/media/storage.ts` reads the environment it is given.
 */

/**
 * The signing key this run uses, generated per run and never written down.
 *
 * Generated rather than a literal, for the reason `packages/fixtures/src/admin-principal.ts` gives about its
 * session token: 44 characters of base64 is exactly the shape `scripts/check-secrets.mjs`'s
 * `high-entropy-assigned-secret` rule is written for, and a key pasted into a test file as a literal has
 * already cost this build a whole verify run.
 */
const SIGNING_SECRET = Buffer.from(randomUUID() + randomUUID()).toString('base64')
const KEY_VERSION = 'v1'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const MARKER = 'wsys14 private documents itest'
const ACTOR: Actor = { kind: 'staff', label: MARKER }

const INVOICE_BYTES = Buffer.from('%PDF-1.7 pretend this is a filed tax invoice\n')
const PAYSLIP_BYTES = Buffer.from('%PDF-1.7 pretend this is one employee pay run\n')

let sql: Sql
let server: WebServer
let BASE = ''
let signer: DocumentUrlSigner

/** One principal per role under test, so a case can switch reader without a global cookie patch. */
const principals = new Map<string, FixturePrincipal>()

let invoiceId = ''
let payslipId = ''
let invoiceKey = ''

const cookieFor = (role: string): string => {
  const principal = principals.get(role)
  if (principal?.sessionToken == null) {
    throw new Error(`No fixture session for ${role}; beforeAll did not create one.`)
  }
  return `${ADMIN_SESSION_COOKIE}=${principal.sessionToken}`
}

/**
 * A fetch as one role.
 *
 * The cookie is composed per request rather than through `installAdminCookie`, and that is the one place this
 * suite departs from the twelve that came before it: those drive the admin estate as ONE reader, and every
 * claim here is about the answer differing BY ROLE. A global patch would make "as a marketer" and "as an
 * accountant" the same request.
 */
const as = (role: string, path: string): Promise<Response> =>
  fetch(`${BASE}${path}`, { headers: { cookie: cookieFor(role) } })

async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from audit_event where action = ${action}
  `
  return Number(row?.count ?? '0')
}

/** A link to `documentId`, minted by the same signer the server verifies with. */
function link(args: {
  readonly documentId: string
  readonly documentClass: string
  readonly expiresAtEpochSeconds?: number
  readonly nonce?: string
}): string {
  const query = signer.sign({
    documentId: args.documentId,
    documentClass: args.documentClass,
    expiresAtEpochSeconds:
      args.expiresAtEpochSeconds ?? Math.floor(Date.now() / 1000) + DOCUMENT_SIGNATURE_TTL_SECONDS,
    nonce: args.nonce ?? mintDocumentNonce(),
  }).query
  return `/documents/${args.documentId}?${query}`
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  signer = createDocumentUrlSigner({ current: { version: KEY_VERSION, secret: SIGNING_SECRET } })

  for (const role of ['accountant', 'receptionist', 'marketer', 'owner'] as const) {
    principals.set(
      role,
      await createFixturePrincipal(sql, {
        role,
        // `requiresTotp` is true for the accountant and the owner, and a credential without a factor
        // reaches `totp_enrolment_required` rather than a session. The session row is inserted directly, so
        // no code is ever verified — the second factor is a LOGIN gate and `session.itest.ts` is where the
        // login path is proven.
        enrolTotp: role === 'accountant' || role === 'owner',
      }),
    )
  }

  const suffix = randomUUID().slice(0, 8)
  invoiceKey = `documents/tax_invoice/${MARKER.replaceAll(' ', '-')}-${suffix}.pdf`
  const payslipKey = `documents/payslip/${MARKER.replaceAll(' ', '-')}-${suffix}.pdf`

  // The bytes, in the private bucket the route reads. The fake adapter writes them under
  // `artifacts/media-outbox`, which `mediaOutboxRoot()` anchors on the repository root so the suite and the
  // server agree about where it is whatever each one's working directory happens to be.
  const storage = appMediaStorage()
  const invoiceReceipt = await storage.put({
    bucket: 'private',
    key: invoiceKey,
    body: INVOICE_BYTES,
    contentType: 'application/pdf',
    cacheControl: 'private, no-store',
  })
  const payslipReceipt = await storage.put({
    bucket: 'private',
    key: payslipKey,
    body: PAYSLIP_BYTES,
    contentType: 'application/pdf',
    cacheControl: 'private, no-store',
  })

  // Registered through the repository, which is the only writer of either table
  // (`pnpm private-documents`). `usePolicy` comes from `@berelax/core`'s catalogue and the migration's CHECK
  // ties it to the class, so a row claiming a payslip is replayable is unstorable.
  const registered = await withUnitOfWork(sql, ACTOR, async (uow) => ({
    invoice: await registerPrivateDocument(uow, {
      documentClass: 'tax_invoice',
      storageKey: invoiceKey,
      contentSha256: invoiceReceipt.sha256,
      bytes: invoiceReceipt.bytes,
      contentType: 'application/pdf',
      usePolicy: 'replayable',
      subjectKind: 'invoice',
      subjectId: `itest-${suffix}`,
      registeredBy: MARKER,
    }),
    payslip: await registerPrivateDocument(uow, {
      documentClass: 'payslip',
      storageKey: payslipKey,
      contentSha256: payslipReceipt.sha256,
      bytes: payslipReceipt.bytes,
      contentType: 'application/pdf',
      usePolicy: 'single_use',
      subjectKind: 'employee',
      subjectId: `itest-${suffix}`,
      registeredBy: MARKER,
    }),
  }))
  invoiceId = registered.invoice.documentId
  payslipId = registered.payslip.documentId

  server = await startWebServer({
    suite: 'documents',
    cwd: new URL('..', import.meta.url).pathname,
    // `/documents` has no index, so the readiness probe uses a path that answers without a session: an
    // unauthenticated GET of the route answers 303, which is a response, which is all the probe needs.
    probePath: '/documents/00000000-0000-4000-8000-000000000000',
    readyWithinMs: 90_000,
    env: {
      // This route calls `loadConfig()`, so every value it needs is declared rather than assumed — the same
      // note the compliance suite makes: a local run that exported only TEST_DATABASE_URL would otherwise
      // get a 503 that reads like a broken route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
      DOCUMENT_URL_SIGNING_SECRET: SIGNING_SECRET,
      DOCUMENT_URL_SIGNING_SECRET_VERSION: KEY_VERSION,
    },
  })
  BASE = server.origin
}, 180_000)

afterAll(async () => {
  await server?.stop()
  for (const principal of principals.values()) await principal.cleanup()
  await sql?.end({ timeout: 5 })
})

describe('the private document route, unsigned and malformed', () => {
  it('refuses an unauthenticated request with the 303 every admin route gives', async () => {
    // The session comes FIRST, before the signature. A 403 here would tell an anonymous caller that the id
    // exists, and a person at a desk needs the login screen rather than a page they cannot act on.
    const response = await fetch(`${BASE}/documents/${invoiceId}`, { redirect: 'manual' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('/login')
  })

  it('refuses an UNSIGNED request with 403, by name, from the route', async () => {
    const response = await as('accountant', `/documents/${invoiceId}`)
    expect(response.status).toBe(403)
    const body = await response.text()
    expect(body).toContain('(signature_absent)')
    // The refusal is the ROUTE's: a text body with a reason, not a storage error. A refusal produced by the
    // storage layer would arrive through the handler's catch as a 503.
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
  })

  it('answers 403 for an id that does not exist, with the same sentence as an absent signature', async () => {
    // Never 404. A 404 for an id that does not exist and a 403 for one that does is an oracle: it answers
    // "does this business hold a payslip for employee X" to anybody who can guess a uuid.
    const unknown = randomUUID()
    const response = await as(
      'accountant',
      link({ documentId: unknown, documentClass: 'tax_invoice' }),
    )
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('(document_unknown)')

    // And for a malformed id, which must not be a 503 from a failed uuid cast.
    const malformed = await as('accountant', `/documents/not-a-uuid?sig=${'a'.repeat(64)}`)
    expect(malformed.status).toBe(403)
  })
})

describe('the private document route, signed', () => {
  it('serves the bytes to a role that holds the permission, and audits the download', async () => {
    const before = await auditCount('document.private_document.fetched')

    const response = await as(
      'accountant',
      link({ documentId: invoiceId, documentClass: 'tax_invoice' }),
    )
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(INVOICE_BYTES)).toBe(true)
    // An attachment, and never the stored content type: a filed document may be a scan somebody handed
    // over, and rendering an untrusted upload inline in an admin origin is the stored-XSS path a
    // `Content-Disposition` closes.
    expect(response.headers.get('content-type')).toBe('application/octet-stream')
    expect(response.headers.get('content-disposition')).toContain('attachment;')
    expect(response.headers.get('content-disposition')).toContain('tax_invoice-')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')

    // A SECOND fetch of a replayable document, with a fresh link. Two rows, because a second download is a
    // second copy of a statutory document leaving the business.
    const again = await as(
      'accountant',
      link({ documentId: invoiceId, documentClass: 'tax_invoice' }),
    )
    expect(again.status).toBe(200)

    expect(await auditCount('document.private_document.fetched')).toBe(before + 2)

    // The audit row names the content HASH and never the storage key, and it names the authenticated role.
    // Counted and read in SQL rather than through a capped reader: `settings-store.itest.ts` read a delta
    // through a `limit` and got zero for three real changes.
    // `after_state`, and `entity_id` is TEXT on this table rather than uuid — both read off the live
    // schema rather than assumed. The first version of this case wrote `select after ... = $1::uuid` and
    // failed with `column "after" does not exist`, which is what a raw query typed loosely buys you.
    const [row] = await sql<{ after_state: Record<string, unknown> }[]>`
      select after_state
        from audit_event
       where action = 'document.private_document.fetched'
         and entity_id = ${invoiceId}
       order by occurred_at desc
       limit 1
    `
    expect(row?.after_state['role']).toBe('accountant')
    expect(row?.after_state['documentClass']).toBe('tax_invoice')
    expect(row?.after_state['contentSha256']).toMatch(/^[0-9a-f]{64}$/)
    // The storage key is a path into the private bucket and must never reach a table several roles read.
    expect(JSON.stringify(row?.after_state)).not.toContain(invoiceKey)
  })

  it('refuses an EXPIRED signature with a reason distinct from an absent one', async () => {
    // The pair the acceptance line is about: one is a stale link, the other is somebody guessing, and they
    // are different facts to whoever reads the log.
    const stale = link({
      documentId: invoiceId,
      documentClass: 'tax_invoice',
      expiresAtEpochSeconds: Math.floor(Date.now() / 1000) - 1,
    })
    const response = await as('accountant', stale)
    expect(response.status).toBe(403)
    const body = await response.text()
    expect(body).toContain('(signature_expired)')
    expect(body).not.toContain('signature_absent')
  })

  it('refuses a signature for document A against document B — the swapped path', async () => {
    const forInvoice = link({ documentId: invoiceId, documentClass: 'tax_invoice' })
    const query = forInvoice.slice(forInvoice.indexOf('?'))
    // Everything kept, only the path changed. The document id is in the PATH alone, so a swap can only be
    // caught by the MAC — which is what makes this case unable to pass over a signature that covered nothing
    // but the expiry and the nonce.
    const swapped = await as('accountant', `/documents/${payslipId}${query}`)
    expect(swapped.status).toBe(403)
    expect(await response403(swapped)).toContain('(signature_invalid)')

    // The control, without which the case above would pass for a route that refuses every signature.
    const own = await as('accountant', forInvoice)
    expect(own.status).toBe(200)
  })

  it('refuses a nonce that was never stored only when the MAC is wrong, and not otherwise', async () => {
    // A nonce is not a credential: a fresh one with a VALID signature opens the document, which is what
    // makes a link cheap to mint. Editing the nonce without re-signing does not.
    const good = link({
      documentId: invoiceId,
      documentClass: 'tax_invoice',
      nonce: mintDocumentNonce(),
    })
    expect((await as('accountant', good)).status).toBe(200)

    const tampered = new URL(`${BASE}${good}`)
    tampered.searchParams.set(DOCUMENT_SIGNATURE_PARAMS.nonce, mintDocumentNonce())
    const response = await fetch(tampered, { headers: { cookie: cookieFor('accountant') } })
    expect(response.status).toBe(403)
    expect(await response403(response)).toContain('(signature_invalid)')
  })
})

describe('the authorisation matrix, not a second copy', () => {
  it('refuses a RECEPTIONIST a valid link to a payslip', async () => {
    // The acceptance line's first pair. The signature is genuine — the same shape that serves an accountant
    // a tax invoice — and it authorises a FETCH, never a principal.
    const response = await as(
      'receptionist',
      link({ documentId: payslipId, documentClass: 'payslip' }),
    )
    expect(response.status).toBe(403)
    expect(await response403(response)).toMatch(/\((?:permission_denied|field_group_denied)\)/)
  })

  it('refuses a MARKETER a valid link to a tax document', async () => {
    const response = await as(
      'marketer',
      link({ documentId: invoiceId, documentClass: 'tax_invoice' }),
    )
    expect(response.status).toBe(403)
    expect(await response403(response)).toContain('(permission_denied)')
  })

  it('writes NO fetch row and NO audit row for a refused role', async () => {
    /*
      The half a status-code assertion cannot make: a refusal must not burn the link.

      If the permission were checked after the burn, a receptionist's refused click would consume an
      accountant's single-use payslip link — so the accountant would then be told the document had already
      been fetched, by somebody who never received it. Asserted as a delta of ZERO around the refused
      request, with the row count read in SQL.
    */
    const before = await auditCount('document.private_document.fetched')
    const [{ count: fetchesBefore } = { count: '0' }] = await sql<{ count: string }[]>`
      select count(*)::text as count from private_document_fetch
       where private_document_id = ${payslipId}::uuid
    `
    const refused = await as('marketer', link({ documentId: payslipId, documentClass: 'payslip' }))
    expect(refused.status).toBe(403)
    const [{ count: fetchesAfter } = { count: '0' }] = await sql<{ count: string }[]>`
      select count(*)::text as count from private_document_fetch
       where private_document_id = ${payslipId}::uuid
    `
    expect(fetchesAfter).toBe(fetchesBefore)
    expect(await auditCount('document.private_document.fetched')).toBe(before)
  })
})

describe('a single-use document', () => {
  it('serves once and refuses the same link a second time', async () => {
    // The one place a replayable link is not acceptable. `owner` because the payslip needs both
    // `payroll:read` and the `employee.salary` field group, and the owner is the role that holds every
    // permission — so this case is about the REPLAY and not about the matrix, which has its own cases above.
    const once = link({ documentId: payslipId, documentClass: 'payslip' })
    const first = await as('owner', once)
    expect(first.status).toBe(200)
    expect(Buffer.from(await first.arrayBuffer()).equals(PAYSLIP_BYTES)).toBe(true)

    const second = await as('owner', once)
    expect(second.status).toBe(403)
    expect(await response403(second)).toContain('(signature_already_used)')

    // The control, and it is the one that stops this reading as "a payslip can only ever be fetched once":
    // a FRESH link to the same document works. The budget is per link, not per document.
    const fresh = await as('owner', link({ documentId: payslipId, documentClass: 'payslip' }))
    expect(fresh.status).toBe(200)
  })

  it('does not refuse the second fetch of a REPLAYABLE document with the same link', async () => {
    // The control for the whole single-use mechanism. Without it, a trigger that refused every repeat would
    // satisfy the case above and would break the accountant re-opening an invoice while the books are read.
    const reusable = link({ documentId: invoiceId, documentClass: 'tax_invoice' })
    expect((await as('accountant', reusable)).status).toBe(200)
    expect((await as('accountant', reusable)).status).toBe(200)
  })
})

/** The body of a refusal, as text. Named so a case reads as an assertion rather than as plumbing. */
async function response403(response: Response): Promise<string> {
  return response.text()
}
