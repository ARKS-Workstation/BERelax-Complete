import { loadConfig } from '@berelax/config'
import {
  type ComplianceQuestionRow,
  complianceQuestionRows,
  complianceQuestionSections,
  instantFromIso,
  localDate,
} from '@berelax/core'
import {
  createConnection,
  type ObligationDefinitionRow,
  type ObligationInstanceRow,
  readObligationAcknowledgements,
  readObligationDefinitions,
  readObligationInstances,
  type Sql,
} from '@berelax/db'
import { isAppError } from '@berelax/shared'
import { complianceAsOf } from '../../../../src/compliance/as-of.ts'
import {
  type ComplianceQuestionsView,
  type NoDeadlineRow,
  type OverdueRow,
  renderComplianceQuestionsHtml,
  type UnverifiedRow,
} from './render.ts'

/**
 * `GET /compliance/unverified` — the open-compliance-questions dashboard (docs/04 §9).
 *
 * The classification is `complianceQuestionRows` in `@berelax/core` and not a `filter` here, and that is
 * the point of the split. Two facts are reported about each obligation and they are independent: whether
 * the DUTY is unconfirmed, and where its DEADLINE stands. The second is an exclusive state — overdue, no
 * deadline on file, or scheduled — because those three are what a single edit to one filter would make
 * overlap, and "no deadline on file" beside an overdue occurrence would be the screen contradicting
 * itself. Keeping the first independent is what makes "the dashboard lists exactly the obligations
 * flagged unverified" a claim about one list rather than about whatever was left after two other filters
 * ran.
 *
 * **This route is not authenticated**, exactly as `/compliance`, `/hr/credentials` and the Messages inbox
 * record: there is no admin session until W-SYS-01. It is read-only and shows no licence number, permit
 * number or TRN — none is on file, and the obligation table holds none.
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

function evaluationInstant(url: URL): number {
  const at = url.searchParams.get('at')
  return at === null ? Date.now() : instantFromIso(at)
}

/** `?key=` repeated, for the isolation reason `/compliance` gives. */
function keysFilter(url: URL): readonly string[] | undefined {
  const keys = url.searchParams.getAll('key').filter((key) => key.trim() !== '')
  return keys.length === 0 ? undefined : keys
}

/**
 * Joins classified rows back to their definitions, dropping any the definition list does not hold.
 *
 * The drop is unreachable — the rows were classified FROM these definitions — and it is here because the
 * alternative is a non-null assertion, which is the thing that turns an impossible state into a crash on
 * the one request where it is not impossible.
 */
function present<T>(
  rows: readonly ComplianceQuestionRow[],
  byKey: ReadonlyMap<string, ObligationDefinitionRow>,
  build: (row: ComplianceQuestionRow, definition: ObligationDefinitionRow) => T,
): readonly T[] {
  const out: T[] = []
  for (const row of rows) {
    const definition = byKey.get(row.key)
    if (definition !== undefined) out.push(build(row, definition))
  }
  return out
}

function unverifiedRow(
  _row: ComplianceQuestionRow,
  definition: ObligationDefinitionRow,
): UnverifiedRow {
  return {
    key: definition.key,
    title: definition.title,
    obligationClass: definition.obligationClass,
    ownerRole: definition.ownerRole,
    // 0052's `obligation_unverified_names_a_question` refuses an unverified row without both, so neither
    // fallback is reachable through the schema. They are here because the TYPE allows null and a screen
    // that printed "null" would be worse than one that says what is missing.
    openQuestionId: definition.openQuestionId ?? 'none recorded',
    unverifiedNote: definition.unverifiedNote ?? 'no note recorded',
    sourceReference: definition.sourceReference,
    authority: definition.authority,
  }
}

function noDeadlineRow(
  _row: ComplianceQuestionRow,
  definition: ObligationDefinitionRow,
): NoDeadlineRow {
  return {
    key: definition.key,
    title: definition.title,
    ownerRole: definition.ownerRole,
    cadence: definition.cadence,
    sourceReference: definition.sourceReference,
  }
}

function overdueRow(
  row: ComplianceQuestionRow,
  definition: ObligationDefinitionRow,
  instances: readonly ObligationInstanceRow[],
  acknowledged: ReadonlySet<string>,
): OverdueRow {
  const breach = instances.find(
    (instance) =>
      instance.obligationKey === definition.key &&
      instance.status === 'open' &&
      instance.dueOn === row.dueOn,
  )
  return {
    key: definition.key,
    title: definition.title,
    dueOn: row.dueOn ?? '',
    blockingEffect: definition.blockingEffect,
    isUnconfirmedDuty: row.isUnconfirmedDuty,
    acknowledged: breach !== undefined && acknowledged.has(breach.instanceId),
  }
}

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    const instant = evaluationInstant(url)
    const keys = keysFilter(url)

    const view: ComplianceQuestionsView = await withSql(async (sql) => {
      const asOf = await complianceAsOf(sql, instant)
      const all = await readObligationDefinitions(sql)
      const definitions = keys === undefined ? all : all.filter((row) => keys.includes(row.key))
      const instances = await readObligationInstances(
        sql,
        keys === undefined ? {} : { keys: [...keys] },
      )
      const acknowledged = await readObligationAcknowledgements(
        sql,
        instances.map((row) => row.instanceId),
      )

      const rows = complianceQuestionRows(
        definitions.map((definition) => ({
          key: definition.key,
          isUnverified: definition.isUnverified,
          ...(definition.openQuestionId === undefined
            ? {}
            : { openQuestionId: definition.openQuestionId }),
          ...(definition.anchorOn === undefined
            ? {}
            : { anchorOn: localDate(definition.anchorOn) }),
          openDueDates: instances
            .filter((row) => row.obligationKey === definition.key && row.status === 'open')
            .map((row) => localDate(row.dueOn)),
        })),
        localDate(asOf),
      )

      // The three lists come from `complianceQuestionSections` and not from three filters written here,
      // because the rule about which list a row belongs in is one rule — and three filters over one list
      // is three filters that overlap the first time somebody edits one.
      const sections = complianceQuestionSections(rows)
      const byKey = new Map(definitions.map((definition) => [definition.key, definition]))
      return {
        asOf,
        unconfirmed: present(sections.unconfirmed, byKey, unverifiedRow),
        noDeadline: present(sections.noDeadline, byKey, noDeadlineRow),
        overdue: present(sections.overdue, byKey, (row, definition) =>
          overdueRow(row, definition, instances, acknowledged),
        ),
      }
    })

    return new Response(renderComplianceQuestionsHtml(view), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    // Plain text and a 503, for `/compliance`'s reason: a blank page that looked like an empty list would
    // say "there are no open questions" when the truth is "nothing could be read".
    const message = isAppError(error) ? error.message : 'Unexpected'
    return new Response(`The open compliance questions could not be read: ${message}\n`, {
      status: 503,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    })
  }
}
