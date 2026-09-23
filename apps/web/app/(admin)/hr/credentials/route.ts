import { loadConfig } from '@berelax/config'
import { evaluateCredentials, type HeldCredential, instantFromIso, localDate } from '@berelax/core'
import {
  createConnection,
  readCredentialPolicy,
  readCredentialSubjects,
  readEmployeeCredentials,
  type Sql,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { type CredentialRow, renderCredentialsHtml } from './render.ts'

/**
 * The HR credentials screen: which documents each employee holds, and whether they are current.
 *
 * docs/04 §7's "credential registry with expiry dates that gates bookable availability", as a surface
 * somebody can look at. The rows and the policy come from `@berelax/db`, the judgement from
 * `@berelax/core` — this route is the only place the two meet, which is the same arrangement the
 * availability read has and the reason neither package imports the other.
 *
 * ## The evaluation instant is read once, here
 *
 * The evaluator takes an instant as an argument (`pnpm purity` allows it no clock), and this is the
 * boundary where the clock is read. Once, for the whole page: a per-employee `Date.now()` would let one
 * request straddle local midnight and report two employees against two different days, which is exactly
 * the kind of one-in-a-thousand disagreement nobody reproduces. `?at=` overrides it so an operator can
 * ask "what did this look like on the 31st", and so a screenshot is reproducible.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, exactly as the Messages
 * inbox and the two Google routes next door record. It is read-only — GET, no mutation of any kind — so
 * there is no actor to record and none is invented. It shows no document number: `number_ct` is a
 * ciphertext under `STAFF_PII_KEK`, the only path to a plaintext is the audited decrypt in
 * `packages/hr/src/employee-repository.ts`, and this page never asks for one.
 */
export const dynamic = 'force-dynamic'

/** The page is per employee and bounded. See `readCredentialSubjects`. */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * The instant to judge at: `?at=` when it parses, otherwise now.
 *
 * `instantFromIso` throws on an unparseable value rather than silently falling back to now, and the
 * throw is caught by the handler below. A query parameter that quietly did nothing would make "as of the
 * 31st" answer for today and look right.
 */
function evaluationInstant(url: URL): number {
  const at = url.searchParams.get('at')
  return at === null ? Date.now() : instantFromIso(at)
}

function parseLimit(url: URL): number {
  const raw = Number(url.searchParams.get('limit') ?? '')
  return Number.isInteger(raw) && raw > 0 ? Math.min(raw, MAX_LIMIT) : DEFAULT_LIMIT
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const instant = evaluationInstant(url)
    const limit = parseLimit(url)
    const evaluatedAtIso = new Date(instant).toISOString()

    const view = await withSql(async (sql) => {
      const policy = await readCredentialPolicy(sql)
      const subjects = await readCredentialSubjects(sql, {
        limit,
        asOf: evaluatedAtIso.slice(0, 10),
      })
      const documents = await readEmployeeCredentials(
        sql,
        subjects.map((subject) => subject.employeeId),
      )
      const rows: CredentialRow[] = subjects.map((subject) => {
        const mine = documents.filter((row) => row.employeeId === subject.employeeId)
        const credentials: HeldCredential[] = mine.map((row) => ({
          documentType: row.documentType,
          expiresOn: row.expiresOn === null ? null : localDate(row.expiresOn),
        }))
        const sealedNumbers: Record<string, boolean> = {}
        for (const row of mine) {
          // OR across the rows of one type: a renewal is a new row, and "is a number recorded for this
          // credential" is true if any row carries one.
          sealedNumbers[row.documentType] =
            (sealedNumbers[row.documentType] ?? false) || row.hasSealedNumber
        }
        return {
          employeeId: subject.employeeId,
          reference: subject.reference,
          evaluation: evaluateCredentials({
            credentials,
            policy,
            at: instant as ReturnType<typeof instantFromIso>,
          }),
          sealedNumbers,
        }
      })
      return {
        rows,
        profileVersion: policy.profileVersion,
        mandatoryTypes: policy.mandatoryTypes,
        nonExpiringTypes: policy.nonExpiringTypes,
        expiringSoonDays: policy.expiringSoonDays,
        evaluatedAtIso,
      }
    })

    return new Response(renderCredentialsHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached copy of a credential verdict outlives the day it was true for, and the
        // whole page is a claim about which day it is.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looked like an
    // empty roster would say "nobody has a credential problem" when the truth is "nothing could be
    // read" — which is the one failure a compliance screen must never have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The credential registry could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
