import { loadConfig } from '@berelax/config'
import {
  type ConsentLog,
  type CustomerMergeDecision,
  type CustomerMergePlan,
  type CustomerMergeSubject,
  type Instant,
  instantFromIso,
  planCustomerMerge,
  resolveConsent,
  scoreDuplicatePair,
} from '@berelax/core'
import {
  type ConsentLogRead,
  type CustomerMergePlanInput,
  createConnection,
  mergeCustomers,
  mergeRefusalOf,
  previewCustomerMerge,
  readCustomerMergeSubject,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { AppError, isAppError } from '@berelax/shared'
import { adminChromeFor } from '../../../../../src/components/admin/google-reauth-source.ts'
import { atFrom, directionFrom, idFrom } from '../params.ts'
import { type RenderDirection, scopeQuery } from '../render.ts'
import { type MergePreviewView, type PreviewConsentView, renderMergePreviewHtml } from './render.ts'

/**
 * `GET|POST /clients/duplicates/preview` — the merge preview, and the one place a merge is authorised.
 *
 * GET previews: it runs `previewCustomerMerge`, which runs the REAL merge inside a transaction that is
 * always rolled back, and renders what it did. POST authorises: it runs the same merge for real, in one
 * transaction, and redirects back here — where the pair now reads as `already_merged`, which is the merge's
 * own answer to a repeat rather than a second row saying something slightly different.
 *
 * ## Why the survivor is always named in the URL
 *
 * The queue links here with `survivor` and `loser` spelled out, even when the survivor is the default. Two
 * reasons: a link that meant "the default" would change meaning if the rule ever did, and the swap is then
 * the same URL with the two swapped — so the page a reviewer sees after choosing the other record is
 * produced by exactly the path that produced the first one. The nomination is passed to
 * `planCustomerMerge`, which refuses a survivor that is not one of the pair and refuses a nomination
 * without an operator behind it.
 *
 * ## Not authenticated, and what that means for the POST
 *
 * There is no admin session until W-SYS-01 — every route under `/compliance`, `/hr`, `/settings` and
 * `/messaging` records the same thing. This route nevertheless WRITES, which none of those do, so the
 * authorisation it can enforce is the one the database enforces: `merge_record` requires a stated actor and
 * a stated reason and refuses a placeholder in either (0069), and both arrive from the form. That is
 * deliberately weaker than a session and it is not pretending otherwise: what it buys is that no merge can
 * exist without a human having typed who they are and why, which is this unit's provisional line.
 */
export const dynamic = 'force-dynamic'

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
} as const

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
 * Free text from the form, refused when absent or too long.
 *
 * The length is checked here as well as by the database, and the two are saying it for different readers:
 * 0069's `merge_record_actor_is_stated` caps the label at 200 characters, and a value that only the CHECK
 * refused would arrive as a 503 that reads like a broken page rather than as "that field is too long".
 */
function statedFrom(value: unknown, name: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') {
    throw new TypeError(`${name} is required: a merge with no ${name} cannot be reviewed`)
  }
  if (text.length > maxLength) {
    throw new TypeError(`${name} must be at most ${maxLength} characters`)
  }
  return text
}

/**
 * The plan for a named pair with the survivor named explicitly.
 *
 * The refusals are the plan's own and are passed through by name: a pair the scorer calls `distinct` is not
 * previewable under any authority — a hand-typed URL for two unrelated records must not produce a page with
 * a merge button on it.
 */
async function planFor(
  sql: Sql,
  survivorId: string,
  loserId: string,
): Promise<{
  plan: CustomerMergePlan
  survivor: CustomerMergeSubject
  loser: CustomerMergeSubject
}> {
  const survivorRead = await readCustomerMergeSubject(sql, survivorId)
  const loserRead = await readCustomerMergeSubject(sql, loserId)
  if (survivorRead === null || loserRead === null) {
    throw new AppError('not_found', 'One of the two records is not a customer.', {
      details: { survivorId, loserId },
    })
  }
  const survivor = survivorRead as CustomerMergeSubject
  const loser = loserRead as CustomerMergeSubject
  const score = scoreDuplicatePair(
    { phone: survivor.phoneE164, label: survivor.displayName },
    { phone: loser.phoneE164, label: loser.displayName },
  )
  const decision: CustomerMergeDecision = planCustomerMerge(
    survivor,
    loser,
    score,
    'operator_confirmed',
    {
      nominatedSurvivorId: survivorId,
    },
  )
  if (decision.kind !== 'plan') {
    throw new AppError('conflict', decision.detail, {
      details: { refusal: decision.refusal, survivorId, loserId },
    })
  }
  // `satisfies` and not a cast: `packages/db` declares its own mirror of this shape because it may not
  // import `packages/core`, and this is the assertion that the two still agree — the same arrangement
  // `packages/fixtures/src/merge.itest.ts` makes. A cast here would let the two drift.
  return { plan: decision satisfies CustomerMergePlanInput, survivor, loser }
}

const asConsentLog = (read: ConsentLogRead): ConsentLog => ({
  contactId: read.contactId,
  // `recordedAt` is epoch milliseconds on both sides of the boundary; `Instant` is the brand core puts on
  // that number, and `packages/fixtures/src/consent.itest.ts` asserts the two shapes agree.
  records: read.records.map((record) => ({ ...record, recordedAt: record.recordedAt as Instant })),
  wordingVersions: read.wordingVersions,
})

/**
 * Every (channel, purpose) either log mentions, resolved before and after, in a stable order.
 *
 * The union rather than the survivor's own pairs: the decision that changes the answer is usually the
 * loser's — a withdrawal the survivor's log knows nothing about — and a table built from the survivor's
 * pairs alone would not have a row to show it in.
 */
function consentRows(
  before: ConsentLogRead,
  after: ConsentLogRead,
  atIso: string,
): readonly PreviewConsentView[] {
  const at = Date.parse(atIso) as Instant
  const keys = new Map<string, { channel: string; purpose: string }>()
  for (const log of [before, after]) {
    for (const record of log.records) {
      keys.set(`${record.channel}/${record.purpose}`, {
        channel: record.channel,
        purpose: record.purpose,
      })
    }
  }
  const beforeLog = asConsentLog(before)
  const afterLog = asConsentLog(after)
  return [...keys.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, pair]) => ({
      channel: pair.channel,
      purpose: pair.purpose,
      before: resolveConsent(beforeLog, pair.channel, pair.purpose, at).state,
      after: resolveConsent(afterLog, pair.channel, pair.purpose, at).state,
    }))
}

function hrefs(
  url: URL,
  survivorId: string,
  loserId: string,
  atIso: string,
  direction: RenderDirection,
): { swapHref: string; queueHref: string } {
  const query = scopeQuery({
    customerIds: url.searchParams.getAll('customer'),
    atIso,
    direction,
  })
  return {
    // The same route with the two ids swapped. See this file's header: the choice is a URL, so the page a
    // reviewer sees after making it is produced by the path that produced the first one.
    swapHref: `/clients/duplicates/preview?survivor=${encodeURIComponent(loserId)}&loser=${encodeURIComponent(survivorId)}&${query}`,
    queueHref: `/clients/duplicates?${query}`,
  }
}

/** The reason and actor a PREVIEW is run under. Stated, because 0069 refuses a placeholder in either. */
const PREVIEW_ARGS = {
  actorKind: 'staff',
  actorLabel: 'Duplicate review queue',
  reason:
    'A preview requested from the duplicate review queue: what this merge would move if it were authorised.',
} as const

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const survivorId = idFrom(url.searchParams.get('survivor'), 'survivor')
    const loserId = idFrom(url.searchParams.get('loser'), 'loser')
    const atIso = atFrom(url)
    const direction = directionFrom(url)
    const { swapHref, queueHref } = hrefs(url, survivorId, loserId, atIso, direction)

    const html = await withSql(async (sql) => {
      // The same `?at=` the preview is judged at, so the page — banner included — is photographable.
      const chrome = await adminChromeFor({ sql, now: instantFromIso(atIso), request })
      const { plan, survivor, loser } = await planFor(sql, survivorId, loserId)
      const preview = await previewCustomerMerge(sql, {
        plan,
        // The merge instant a PREVIEW is run at is the instant the page is about, so the same `?at=` twice
        // renders the same document twice — which is what makes this page photographable. The authorised
        // merge below uses the real clock instead: a merge recorded at a requested instant would be a
        // record of a decision taken at a time nobody decided anything.
        mergedAtIso: atIso,
        ...PREVIEW_ARGS,
      })

      if (preview.kind === 'already_merged') {
        return renderMergePreviewHtml({
          kind: 'already_merged',
          chrome,
          mergeRecordId: preview.mergeRecordId,
          survivorCustomerId: preview.survivorCustomerId,
          loserCustomerId: preview.loserCustomerId,
          mergedAtIso: preview.mergedAtIso,
          queueHref,
          direction,
        })
      }

      const view: MergePreviewView = {
        kind: 'preview',
        chrome,
        survivor,
        loser,
        scorePerMille: plan.scorePerMille,
        phoneAgreement: plan.phoneAgreement,
        labelAgreement: plan.labelAgreement,
        authority: plan.authority,
        tables: preview.tables.map((table) => ({
          participant: table.participant,
          strategy: table.strategy,
          rowsBeforeSurvivor: table.rowsBeforeSurvivor,
          rowsBeforeLoser: table.rowsBeforeLoser,
          rowsAfterSurvivor: table.rowsAfterSurvivor,
          rowsAfterLoser: table.rowsAfterLoser,
          rowsMoved: table.rowsMoved,
          rowsInserted: table.rowsInserted,
          rowsRetainedOnLoser: table.rowsRetainedOnLoser,
          retainedReason: table.retainedReason,
        })),
        consent: consentRows(preview.survivorConsentBefore, preview.survivorConsentAfter, atIso),
        fields: plan.fields,
        wouldWrite: preview.wouldWrite,
        swapHref,
        queueHref,
        atIso,
        direction,
        // The default survivor is the earlier record. Saying which one this is matters: an override the
        // screen did not mention is an override the next reviewer cannot see.
        survivorWasNominated:
          survivor.createdAt > loser.createdAt ||
          (survivor.createdAt === loser.createdAt && survivor.id > loser.id),
      }
      return renderMergePreviewHtml(view)
    })

    return new Response(html, { headers: HTML_HEADERS })
  } catch (error) {
    return refusal(error)
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const form = await request.formData()
    const survivorId = idFrom(form.get('survivor'), 'survivor')
    const loserId = idFrom(form.get('loser'), 'loser')
    const actorLabel = statedFrom(form.get('authorisedBy'), 'authorisedBy', 200)
    const reason = statedFrom(form.get('reason'), 'reason', 1000)
    const direction: RenderDirection = form.get('dir') === 'rtl' ? 'rtl' : 'ltr'
    if (form.get('confirm') !== 'yes') {
      // The button carries it. A POST without it is a request that did not come from the form, and a merge
      // is not an operation to perform for a caller that has not said it means to.
      throw new TypeError('confirm must be "yes": a merge is authorised deliberately or not at all')
    }

    const mergedAtIso = new Date().toISOString()
    await withSql(async (sql) => {
      const { plan } = await planFor(sql, survivorId, loserId)
      return withUnitOfWork(sql, { kind: 'staff', label: actorLabel }, (uow) =>
        mergeCustomers(uow, { plan, mergedAtIso, reason, actorKind: 'staff', actorLabel }),
      )
    })

    // 303 and not 200: the merge is done, and a browser that re-submitted this POST on a refresh would be
    // asking for a second merge of a pair that now has a tombstone. The GET it lands on reads
    // `already_merged` from that tombstone, which is the merge's own answer to a repeat.
    const query = `at=${encodeURIComponent(mergedAtIso)}${direction === 'rtl' ? '&dir=rtl' : ''}`
    return new Response(null, {
      status: 303,
      headers: {
        location:
          `/clients/duplicates/preview?survivor=${encodeURIComponent(survivorId)}` +
          `&loser=${encodeURIComponent(loserId)}&${query}`,
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    return refusal(error)
  }
}

/**
 * The failure shapes, kept apart on purpose.
 *
 * A refused request is 400, a refused MERGE is 409 with the refusal's name in the body — a caller that
 * asked for something the merge will not do needs to know which of the two it was — and a failed read is
 * 503. One status for all three would make "these are two people" and "the database is down" the same
 * event.
 */
function refusal(error: unknown): Response {
  const named = mergeRefusalOf(error)
  const planRefusal = isAppError(error)
    ? ((error.details as { refusal?: unknown } | undefined)?.refusal ?? null)
    : null
  const message = isAppError(error) || error instanceof Error ? error.message : 'Unexpected'
  const status =
    error instanceof TypeError
      ? 400
      : named !== null || typeof planRefusal === 'string'
        ? 409
        : isAppError(error) && error.kind === 'not_found'
          ? 404
          : 503
  const refusalName = named ?? (typeof planRefusal === 'string' ? planRefusal : null)
  return new Response(
    `The merge preview could not be produced: ${message}\n` +
      (refusalName === null ? '' : `refusal: ${refusalName}\n`),
    {
      status,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    },
  )
}
