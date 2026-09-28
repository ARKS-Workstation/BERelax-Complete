import { loadConfig } from '@berelax/config'
import {
  classifyErasureCoverage,
  DATA_CLASSES,
  type DataClass,
  decideRightsResponse,
  ERASURE_PROBE_AXES,
  instantFromIso,
  isRetainingAction,
  isRightsRequestOverdue,
} from '@berelax/core'
import { createConnection, erasureCoverage, readSetting, type Sql } from '@berelax/db'
import {
  CLINICAL_REAL_INTAKE_SETTING_KEY,
  isAppError,
  PRIVACY_OPEN_QUESTIONS,
  PROVISIONAL_REAL_INTAKE_PERMITTED,
  PROVISIONAL_RIGHTS_SLA_DAYS,
  PROVISIONAL_SUPERVISORY_AUTHORITY,
  RIGHTS_SLA_DAYS_SETTING_KEY,
  RIGHTS_SLA_PROVENANCE,
  RIGHTS_SUPERVISORY_AUTHORITY_SETTING_KEY,
} from '@berelax/shared'
import { adminChromeFor } from '../../../../src/components/admin/google-reauth-source.ts'
import {
  type DataClassView,
  type PrivacyPageView,
  type RetentionView,
  type RightsRequestView,
  renderPrivacyHtml,
} from './render.ts'

/**
 * The data-subject rights screen (C-CRM-10): the requests, their deadlines, and what an erasure would do.
 *
 * The rows come from `@berelax/db` and every JUDGEMENT from `@berelax/core`. That split is the unit's, not a
 * style: `packages/db` may not import `packages/core`, so the composition happens here — read the catalogue,
 * classify it, render — and `packages/fixtures/src/rights.itest.ts` asserts the same classification against
 * real PostgreSQL. Nothing in this file decides anything a rule could decide.
 *
 * **The classes and the reasons on this page ARE the registry**, not a description of it. A hand-written
 * "here is what we delete" page drifts from the engine the first time a table is added, and the drift is
 * invisible: the page keeps reading correctly and stops being true. So the page renders
 * `classifyErasureCoverage` over the live catalogue, which is the same call `eraseSubject` makes before it
 * touches a row — and if the two disagreed, the page would say so by showing an unclassified count.
 *
 * **This route is not authenticated.** There is no admin session until W-SYS-01, exactly as the routes under
 * `/settings` record. It is READ-ONLY — GET, no mutation — so there is no actor to record and none is
 * invented: `rights_request_actor_is_stated` refuses a placeholder, which is the constraint doing what a
 * comment could not.
 */
export const dynamic = 'force-dynamic'

/** Bounded, because a list of every request ever taken gets slower every month. */
const REQUEST_LIMIT = 50

async function withSql<T>(run: (sql: Sql) => Promise<T>): Promise<T> {
  const config = loadConfig()
  const sql = createConnection({ url: config.DATABASE_URL, max: 2 })
  try {
    return await run(sql)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

interface ProfileRow {
  readonly version: number
  readonly erasureOverridesRetention: boolean
  readonly clinicalRetentionYears: number
  readonly financialRetentionYears: number
}

interface RequestRow {
  readonly id: string
  readonly requestType: string
  readonly subjectCustomerId: string
  readonly receivedAt: Date
  readonly dueAt: Date
  readonly state: string
  readonly verifiedVia: string
  readonly pseudonym: string | null
}

export async function GET(request: Request): Promise<Response> {
  try {
    const readAtIso = new Date().toISOString()
    const view = await withSql(async (sql) => {
      // One connection for the chrome and the page, for the rota screen's reason: a second pool would make
      // one page load two connections, and the integration suite opens 64 of its own.
      const chrome = await adminChromeFor({ sql, now: instantFromIso(readAtIso), request })

      const [profileRows, requestRows, probed, slaSetting, authoritySetting, realIntakeSetting] =
        await Promise.all([
          sql<ProfileRow[]>`
            select version,
                   erasure_overrides_retention as "erasureOverridesRetention",
                   clinical_retention_years    as "clinicalRetentionYears",
                   financial_retention_years   as "financialRetentionYears"
              from regulatory_profile_current
          `,
          sql<RequestRow[]>`
            select r.id, r.request_type as "requestType",
                   r.subject_customer_id as "subjectCustomerId",
                   r.received_at as "receivedAt", r.due_at as "dueAt", r.state,
                   r.verified_via as "verifiedVia",
                   (select s.pseudonym from rights_resolution s where s.rights_request_id = r.id)
                     as pseudonym
              from rights_request r
             order by r.closed_at is null desc, r.due_at asc, r.id asc
             limit ${REQUEST_LIMIT}
          `,
          erasureCoverage(sql),
          readSetting(sql, RIGHTS_SLA_DAYS_SETTING_KEY),
          readSetting(sql, RIGHTS_SUPERVISORY_AUTHORITY_SETTING_KEY),
          readSetting(sql, CLINICAL_REAL_INTAKE_SETTING_KEY),
        ])

      const profile = profileRows[0]
      const coverage = classifyErasureCoverage(probed)

      // The authority is read as a string and an ABSENT row reads as absent, not as something. The opposite
      // care to `clinical.real_intake_permitted`, whose absent row must read as `false` so a restore cannot
      // open a gate — here the unsafe direction is a value appearing out of nowhere.
      const supervisoryAuthority =
        typeof authoritySetting === 'string' ? authoritySetting : PROVISIONAL_SUPERVISORY_AUTHORITY
      const response = decideRightsResponse({ supervisoryAuthority })

      const requests: RightsRequestView[] = requestRows.map((row) => ({
        id: row.id,
        requestType: row.requestType,
        // The pseudonym once the record has one, and the record id until then. Never a name: a customer
        // with no display name is `Customer 0042` (ADR 0020), and this screen shows neither.
        subjectLabel: row.pseudonym ?? `record ${row.subjectCustomerId.slice(0, 8)}`,
        receivedAtIso: row.receivedAt.toISOString(),
        dueAtIso: row.dueAt.toISOString(),
        state: row.state,
        isOverdue: isRightsRequestOverdue(
          { dueAt: row.dueAt, state: row.state as never },
          new Date(readAtIso),
        ),
        verifiedVia: row.verifiedVia,
      }))

      // Grouped from the CLASSIFIED coverage, so the page cannot list a class the engine does not act on or
      // omit one it does. `DATA_CLASSES` orders it, so the list reads the same on every load.
      const classes: DataClassView[] = DATA_CLASSES.map((dataClass: DataClass): DataClassView => {
        const columns = coverage.classified.filter((entry) => entry.rule.dataClass === dataClass)
        return {
          dataClass,
          actions: [...new Set(columns.map((entry) => entry.rule.action))].sort(),
          columnCount: columns.length,
        }
      }).filter((entry) => entry.columnCount > 0)

      const retentions: RetentionView[] = coverage.classified
        .filter((entry) => isRetainingAction(entry.rule.action))
        .map((entry): RetentionView => {
          const obligationColumn = entry.rule.obligationColumn ?? null
          return {
            participant: `${entry.schema}.${entry.table}`,
            columnName: entry.column,
            action: entry.rule.action,
            // The SUBJECT-facing sentence, which is what the resolution row stores and what somebody
            // exercising a right is told. The maintainer's `why` names migrations and SQLSTATEs and is not
            // for this page.
            why: entry.rule.subjectReason ?? entry.rule.why,
            obligationColumn,
            obligationYears:
              obligationColumn === 'clinical_retention_years'
                ? (profile?.clinicalRetentionYears ?? 0)
                : obligationColumn === 'financial_retention_years'
                  ? (profile?.financialRetentionYears ?? 0)
                  : null,
          }
        })
        .sort((a, b) =>
          `${a.participant}.${a.columnName}`.localeCompare(`${b.participant}.${b.columnName}`),
        )

      const page: PrivacyPageView = {
        chrome,
        readAtIso,
        slaDays: typeof slaSetting === 'number' ? slaSetting : PROVISIONAL_RIGHTS_SLA_DAYS,
        slaOpenQuestionId: PRIVACY_OPEN_QUESTIONS.entity,
        slaProvenance: RIGHTS_SLA_PROVENANCE,
        supervisoryAuthority,
        responseCanBeIssued: response.issued,
        regulatoryProfileVersion: profile?.version ?? 0,
        erasureOverridesRetention: profile?.erasureOverridesRetention ?? false,
        clinicalRetentionYears: profile?.clinicalRetentionYears ?? 0,
        financialRetentionYears: profile?.financialRetentionYears ?? 0,
        realIntakePermitted:
          typeof realIntakeSetting === 'boolean'
            ? realIntakeSetting
            : PROVISIONAL_REAL_INTAKE_PERMITTED,
        requests,
        overdueCount: requests.filter((entry) => entry.isOverdue).length,
        probes: ERASURE_PROBE_AXES.map((axis) => ({
          axis,
          columnCount: probed.filter((column) => column.axes.includes(axis)).length,
        })),
        unclassifiedColumnCount: coverage.unclassified.length,
        classes,
        retentions,
      }
      return page
    })

    return new Response(renderPrivacyHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // Never cached. A cached copy would show a deadline that has since passed as still in hand, and
        // would go on saying a column is classified after somebody's migration made it not.
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503: this surface has no error document, and a blank page that looked like an empty
    // request list would say "nobody has asked for anything" when the truth is "nothing could be read" —
    // which for a screen about statutory deadlines is the one failure it must never have.
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The privacy screen could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
