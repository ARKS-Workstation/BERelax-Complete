import { createClinicalIntakeStore, parseKek, SILENT_CLINICAL_LOGGER } from '@berelax/clinical'
import { loadConfig } from '@berelax/config'
import { type ClinicalReadRefusal, instantFromIso } from '@berelax/core'
import { createConnection, readSetting, type Sql } from '@berelax/db'
import {
  AppError,
  CLINICAL_OPEN_QUESTIONS,
  CLINICAL_REAL_INTAKE_SETTING_KEY,
  isAppError,
} from '@berelax/shared'
import { adminChromeFor } from '../../../../../src/components/admin/google-reauth-source.ts'
import { type IntakeOutcome, type RenderDirection, renderIntakePageHtml } from './render.ts'

/**
 * `GET /clients/[id]/intake` — one client's intake record, behind the consent gate (C-CRM-08).
 *
 * The route is a join and nothing else: `@berelax/clinical` owns the store, `@berelax/core` owns the
 * decision, and `render.ts` owns the document. Nothing is decided here that either of those two decides —
 * in particular the refusal, which arrives as a named `ClinicalReadRefused` and is rendered by name.
 *
 * ## It WRITES, and what it writes is the audit trail
 *
 * Every request that reaches a submission records a read, or records a denial. That is the acceptance
 * criterion and it is also the reason this is a route rather than a cached page: a cached clinical record
 * is a record read once and shown many times, with one audit row for the first reader.
 *
 * ## Not authenticated, and what stands in for it
 *
 * There is no admin session until W-SYS-01, exactly as every route under `/compliance`, `/hr`, `/settings`
 * and `/clients/duplicates` records. So the authorisation this page enforces is the DATABASE's: the read
 * needs a live `clinical.step_up_grant` for the employee id in the query, matching the stated purpose, and
 * migration 0082 refuses a grant longer than fifteen minutes however it was minted. When the session
 * arrives, `employee` and `purpose` stop being query parameters and become the session's — and the shape of
 * the store call does not change, which is the point of taking them as arguments now.
 *
 * `?employee=` is therefore NOT a way to read somebody else's records: without a grant of their own it is
 * refused, and the refusal is recorded against whoever was named.
 *
 * ## The query parameters
 *
 *   - `employee` — who is reading. Required: there is no default reader, and a default would be an
 *     unattributable read in the one table whose purpose is answering "who opened this".
 *   - `purpose` — why. Required for the same reason, and matched against the grant.
 *   - `dir=rtl` mirrors the layout. A direction axis rather than a locale, as every admin handler records.
 */
export const dynamic = 'force-dynamic'

/**
 * The connection this route needs, and the one thing it must not do.
 *
 * `DATABASE_URL` is the APPLICATION's credential, and migration 0009 does
 * `revoke all on schema clinical from berelax_app` — that revoke is the whole of ADR 0010's second
 * property, the one that makes an application-layer compromise unable to reach health data at all. So this
 * route cannot read a submission over this connection in production, and it MUST NOT be given a connection
 * that can: a `berelax_app` with clinical privilege is the boundary deleted.
 *
 * What is missing is a separate clinical credential, and supplying one is deployment work this unit does
 * not do (see the manifest NOTE). Until it exists, the permission denial is caught and rethrown naming the
 * missing piece — because the alternative is a 503 whose message is `permission denied for schema
 * clinical`, and an operator reading that looks for a bug in the query.
 *
 * There is deliberately NO fallback. A route that used the application connection when a clinical one was
 * absent would work in the test database — where the connecting role is the owner — and fail in the only
 * environment that matters, which is the exact shape of defect this build refuses everywhere else.
 */
const CLINICAL_PRIVILEGE_MISSING =
  'ClinicalConnectionNotConfigured: this route read the clinical schema over the application ' +
  'credential, which migration 0009 denies it (`revoke all on schema clinical from berelax_app`). That ' +
  'revoke is ADR 0010 property 2 and must NOT be relaxed to make this page work: serving a clinical ' +
  'record needs its own database credential holding the berelax_clinical role. Until one is configured ' +
  'this page cannot be served, and granting berelax_app access to the clinical schema would delete the ' +
  'boundary rather than fix the page.'

/** Postgres `insufficient_privilege`. The code, not the message, because the message is localised. */
const INSUFFICIENT_PRIVILEGE = '42501'

const isPrivilegeDenied = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { readonly code?: unknown }).code === INSUFFICIENT_PRIVILEGE

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } catch (error) {
    if (isPrivilegeDenied(error)) {
      throw new AppError('invariant_violated', CLINICAL_PRIVILEGE_MISSING, { cause: error })
    }
    throw error
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/** The newest submission for a client, or null. The read gate is the STORE's, not this query's. */
async function newestSubmissionId(sql: Sql, customerId: string): Promise<string | null> {
  const [row] = await sql<{ id: string }[]>`
    select id from clinical.intake_submission
     where customer_id = ${customerId}::uuid and superseded_at is null
     order by submitted_at desc, id desc
     limit 1
  `
  return row?.id ?? null
}

const required = (url: URL, name: string): string => {
  const value = url.searchParams.get(name)?.trim() ?? ''
  if (value.length === 0) {
    // A TypeError, because the error branch below maps it to 400: this is the caller's request being
    // incomplete, not a failure to read.
    throw new TypeError(
      `?${name}= is required. A clinical read has to say who is reading and why; there is no default, ` +
        'because an unattributable read is worse than a refused one.',
    )
  }
  return value
}

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const { id: customerId } = await context.params
    const employeeId = required(url, 'employee')
    const statedPurpose = required(url, 'purpose')
    const direction: RenderDirection = url.searchParams.get('dir') === 'rtl' ? 'rtl' : 'ltr'

    const html = await withSql(async (sql) => {
      const config = loadConfig()
      const chrome = await adminChromeFor({
        sql,
        now: instantFromIso(new Date().toISOString()),
        request,
      })
      const realIntakePermitted = await readSetting<boolean>(sql, CLINICAL_REAL_INTAKE_SETTING_KEY)

      const submissionId = await newestSubmissionId(sql, customerId)
      const outcome = await resolveOutcome({
        sql,
        config,
        submissionId,
        customerId,
        employeeId,
        statedPurpose,
      })

      return renderIntakePageHtml({
        chrome,
        customerId,
        outcome,
        direction,
        realIntakePermitted,
        residencyQuestionId: CLINICAL_OPEN_QUESTIONS.residency,
      })
    })

    return new Response(html, {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    })
  } catch (error) {
    // A refused parameter is the caller's, a failed read is not, and the two must not answer the same way.
    // A REFUSED READ is neither: it is rendered as a page, above, because "you may not open this" is
    // information the operator needs on the screen they are on.
    const isRequest = error instanceof TypeError
    const message = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
    return new Response(`The intake record could not be read: ${message}\n`, {
      status: isRequest ? 400 : 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}

/**
 * The read, and the three outcomes.
 *
 * A `ClinicalReadRefused` is caught and turned into a page rather than a status code, which is the one
 * judgement in this file. The alternative — 403 — is correct for an API and wrong here: the operator is
 * standing at a desk with a client in front of them, and a bare 403 tells them neither which rule refused
 * nor what to do about it, so they try again and the audit trail fills with attempts.
 *
 * Every other error propagates. A database failure must not render as "refused": the two mean opposite
 * things about whether there is a record, and the remedy for one is a conversation with the client.
 */
async function resolveOutcome(args: {
  readonly sql: Sql
  readonly config: ReturnType<typeof loadConfig>
  readonly submissionId: string | null
  readonly customerId: string
  readonly employeeId: string
  readonly statedPurpose: string
}): Promise<IntakeOutcome> {
  if (args.submissionId === null) return { kind: 'absent' }

  const kekValue = args.config.CLINICAL_KEK
  if (!kekValue) {
    // Not rendered as a refusal. No key means nothing here can be opened by anybody, which is a
    // deployment fault and not a decision about this client — and a page saying "refused" would send an
    // operator to re-authenticate over and over against a server that cannot read anything at all.
    throw new AppError(
      'invariant_violated',
      'CLINICAL_KEK is not configured, so no clinical record can be opened. This is a deployment ' +
        'fault rather than a refusal; see docs/runbooks/key-rotation.md.',
    )
  }

  const store = createClinicalIntakeStore({
    sql: args.sql,
    kek: parseKek(kekValue, args.config.CLINICAL_KEK_VERSION ?? 'v1'),
    clock: { now: () => instantFromIso(new Date().toISOString()) },
    // No logger on this path. The store's lines are diagnostics for a job; a request already has the
    // audit row, which is the record that matters and the one a reviewer reads.
    logger: SILENT_CLINICAL_LOGGER,
  })

  try {
    const result = await store.readIntake({
      submissionId: args.submissionId,
      actor: { employeeId: args.employeeId, label: `employee ${args.employeeId}` },
      statedPurpose: args.statedPurpose,
    })
    const [template] = await args.sql<{ title: string }[]>`
      select t.title
        from clinical.intake_form_template t
        join clinical.intake_submission s on s.template_id = t.id
       where s.id = ${args.submissionId}::uuid
    `
    return {
      kind: 'record',
      rendered: result.rendered,
      grantId: result.grantId,
      statedPurpose: args.statedPurpose,
      templateTitle: template?.title ?? 'Intake form',
    }
  } catch (error) {
    if (isAppError(error) && typeof error.details['refusal'] === 'string') {
      return {
        kind: 'refused',
        refusal: error.details['refusal'] as ClinicalReadRefusal,
        because: error.message,
        submissionId: args.submissionId,
      }
    }
    throw error
  }
}
