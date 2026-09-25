import { loadConfig } from '@berelax/config'
import {
  escalationRoleFor,
  type Instant,
  instantFromIso,
  obligationNoticeOffsetsFrom,
  ROLES,
  type Role,
} from '@berelax/core'
import {
  createConnection,
  OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
  OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
  obligationNoticesFor,
  readObligationAcknowledgements,
  readObligationDefinitions,
  readObligationEscalationOffsets,
  readObligationEvidence,
  readObligationInstances,
  readObligationReminderOffsets,
  type Sql,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { complianceAsOf } from '../../../src/compliance/as-of.ts'
import { adminChromeFor } from '../../../src/components/admin/google-reauth-source.ts'
import {
  type CalendarObligationRow,
  type CalendarOccurrenceRow,
  renderComplianceCalendarHtml,
} from './render.ts'

/**
 * `GET /compliance` — the compliance calendar (docs/04 §9).
 *
 * The obligations, their dated occurrences, the notices planned against each and whether anything
 * blocking is overdue. The rows come from `@berelax/db`, the judgement — which date the calendar is
 * judged against, and which role an escalation goes to — from `@berelax/core`. This route is the only
 * place the two meet, the same arrangement the availability read and the credentials screen have, and the
 * reason neither package imports the other.
 *
 * ## The as-of date is read once, here
 *
 * Once for the whole page: a per-row `Date.now()` would let one request straddle the close of trading and
 * report two occurrences against two different dates, which is the kind of one-in-a-thousand disagreement
 * nobody reproduces. `?at=` overrides it so an operator can ask "what did this look like on the 31st", and
 * so a screenshot is reproducible.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, exactly as the HR
 * credentials screen, the Messages inbox and the two Google routes record. It is read-only — GET, no
 * mutation of any kind — so there is no actor to record and none is invented. It shows no licence number,
 * no permit number and no TRN: none is on file and the obligation table holds none.
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

/**
 * The instant to judge at: `?at=` when it parses, otherwise now.
 *
 * `instantFromIso` throws on an unparseable value rather than silently falling back to now, and the throw
 * is caught by the handler below. A query parameter that quietly did nothing would make "as of the 31st"
 * answer for today and look right.
 */
function evaluationInstant(url: URL): number {
  const at = url.searchParams.get('at')
  return at === null ? Date.now() : instantFromIso(at)
}

/**
 * The obligation keys this page shows, when the caller narrows it.
 *
 * `?key=` repeated. The integration suite runs sequentially against one database and earlier files leave
 * rows behind (brief rule 12), so the screenshot assertions narrow what the page can SEE rather than
 * deleting rows a foreign key protects — `obligation_evidence.obligation_instance_id` is ON DELETE
 * RESTRICT and `obligation` has DELETE revoked outright. It is also what makes the screenshots
 * deterministic: a page showing every occurrence in a shared database would diff the moment another unit
 * generated one.
 */
function keysFilter(url: URL): readonly string[] | undefined {
  const keys = url.searchParams.getAll('key').filter((key) => key.trim() !== '')
  return keys.length === 0 ? undefined : keys
}

/** The role an escalation about this obligation goes to, or null when there is nobody above. */
function escalationFor(ownerRole: string): string | null {
  if (!(ROLES as readonly string[]).includes(ownerRole)) return null
  return escalationRoleFor(ownerRole as Role)
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const instant = evaluationInstant(url)
    const keys = keysFilter(url)

    const view = await withSql(async (sql) => {
      const asOf = await complianceAsOf(sql, instant)
      const definitions = await readObligationDefinitions(sql)
      const shown =
        keys === undefined ? definitions : definitions.filter((d) => keys.includes(d.key))
      const instances = await readObligationInstances(
        sql,
        keys === undefined ? {} : { keys: [...keys] },
      )
      const evidence = await readObligationEvidence(
        sql,
        instances.map((row) => row.instanceId),
      )
      const acknowledged = await readObligationAcknowledgements(
        sql,
        instances.map((row) => row.instanceId),
      )
      const occurrences: CalendarOccurrenceRow[] = []
      for (const instance of instances) {
        occurrences.push({
          instanceId: instance.instanceId,
          obligationKey: instance.obligationKey,
          dueOn: instance.dueOn,
          status: instance.status,
          // Strictly before, exactly as `obligationBreaches` decides it: an obligation due today is due
          // today and not late today, and the inclusive reading would show every renewal as a breach on
          // its own due date.
          overdue: instance.dueOn < asOf,
          acknowledged: acknowledged.has(instance.instanceId),
          blockingEffect: instance.blockingEffect,
          notices: (await obligationNoticesFor(sql, instance.instanceId)).map((notice) => ({
            step: notice.step,
            kind: notice.kind,
            toRole: notice.toRole,
            state: notice.state,
            notifyOn: notice.notifyOn,
            skippedReason: notice.skippedReason,
          })),
          evidence: evidence
            .filter((row) => row.obligationInstanceId === instance.instanceId)
            .map((row) => ({ evidenceId: row.evidenceId, contentHash: row.contentHash })),
        })
      }
      const obligations: CalendarObligationRow[] = shown.map((row) => ({
        key: row.key,
        title: row.title,
        obligationClass: row.obligationClass,
        cadence: row.cadence,
        ownerRole: row.ownerRole,
        escalationRole: escalationFor(row.ownerRole),
        blockingEffect: row.blockingEffect,
        evidenceRequired: row.evidenceRequired,
        isUnverified: row.isUnverified,
        authority: row.authority,
        sourceReference: row.sourceReference,
        anchorOn: row.anchorOn ?? null,
      }))
      return {
        chrome: await adminChromeFor({ sql, now: instant as Instant, request }),
        asOf,
        obligations,
        occurrences,
        reminderOffsetsDays: obligationNoticeOffsetsFrom(
          await readObligationReminderOffsets(sql),
          OBLIGATION_REMINDER_OFFSETS_SETTING_KEY,
        ),
        escalationOffsetsDays: obligationNoticeOffsetsFrom(
          await readObligationEscalationOffsets(sql),
          OBLIGATION_ESCALATION_OFFSETS_SETTING_KEY,
        ),
        // Counted over the obligations SHOWN, so a narrowed page reports the narrowed count rather than
        // a total over another unit's rows.
        unconfirmedCount: obligations.filter((row) => row.isUnverified).length,
      }
    })

    return new Response(renderComplianceCalendarHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached copy of a compliance verdict outlives the day it was true for, and the
        // whole page is a claim about which trading date it is.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looked like an
    // empty calendar would say "nothing is overdue" when the truth is "nothing could be read" — the one
    // failure a compliance screen must never have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The compliance calendar could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
