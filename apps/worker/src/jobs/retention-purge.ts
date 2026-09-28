import {
  type DataClass,
  type LegalHold,
  type PurgeCandidate,
  planRetentionPurge,
  type RetentionRule,
} from '@berelax/core'
import type { Sql } from '@berelax/db'
import { AppError, RETENTION_PURGE_JOB } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * The per-data-class retention purge (C-CRM-10), which docs/04 §8 asks for beside the rights engine.
 *
 * ## Why this is a separate pass from an erasure, and not the same code
 *
 * An erasure is a request about ONE PERSON, and everything it does is justified by that request. A purge is
 * about TIME, and it acts on people who have asked for nothing — which makes its failure mode the opposite
 * one. An erasure that does too little leaves somebody reachable; a purge that does too much destroys
 * records nobody consented to lose and that a dispute may turn on. So this pass is deliberately
 * conservative in the other direction: it acts only where a retention period is configured for the class,
 * it never touches the classes whose rules say `null`, and a row under legal hold is reported rather than
 * quietly kept.
 *
 * ## `skip` and `keep` are different outcomes, and the acceptance line says so
 *
 * "A row under legal hold is skipped AND REPORTED rather than silently retained." A hold is somebody's
 * decision that this row is needed; a row inside its retention window is just young. Folding them together
 * would leave nothing saying the hold had bitten, so the next person asking "did the purge touch this"
 * would have to reason about dates instead of reading an answer. `planRetentionPurge` in `@berelax/core`
 * tests the hold FIRST and independently of the dates, so a held row that is ALSO too young still reports
 * `legal_hold` — the reason that would outlast the other one.
 *
 * ## The clock is an argument
 *
 * `runRetentionPurge` takes `nowIso`, because every assertion about which rows fall due is made under a
 * frozen clock. The handler is the only thing that reads a real clock, and it reads it once.
 *
 * ## What this pass deliberately does NOT purge
 *
 * Nothing in the `financial`, `audit`, `consent_record` or `suppression_record` classes, and the rules say
 * so with `retainDays: null` rather than by omission. Those are the four classes whose whole purpose is to
 * outlive the data they are about: a tax document under the FTA obligation, an append-only log, the record
 * of what this business was permitted to do, and the entry that keeps somebody un-messageable. A purge that
 * aged out a suppression would make everybody who ever unsubscribed messageable again after a while, which
 * is the single worst thing a scheduled job in this system could do.
 */

/**
 * The retention period per data class.
 *
 * Every figure here is either derived from a statutory obligation held in `regulatory_profile` or is
 * `null`, and there is deliberately NO invented number: a retention period nobody has decided is exactly
 * the kind of business rule docs/12 §1 forbids guessing. The three non-null entries are the classes whose
 * rows are operational exhaust with no evidential value, and each says what makes that true.
 */
export function retentionRulesFor(profile: {
  readonly financialRetentionYears: number
  readonly clinicalRetentionYears: number
}): readonly RetentionRule[] {
  return Object.freeze([
    {
      dataClass: 'contact_channel' as DataClass,
      // An OTP challenge lives five minutes and a phone lock fifteen; a spent booking session is dead the
      // moment it expires. Thirty days is far longer than any of them needs and is not a business rule
      // anybody has to confirm — it is a floor chosen so that a support question about last week is still
      // answerable, and the rows it removes are rows nothing reads.
      retainDays: 30,
      why:
        'Expired one-time challenges and spent booking sessions. They hold a phone number in the clear and ' +
        'nothing reads them once they have expired, so keeping them is pure exposure with no compensating ' +
        'value. The retention schedule docs/04 §8 asks for is this pass, and 0062 and 0067 both name it as ' +
        'the thing that would eventually prune them. `otp_phone_lock` is NOT in this pass and the reason ' +
        'is structural rather than an oversight — see the candidate query below.',
    },
    {
      dataClass: 'credential' as DataClass,
      retainDays: 90,
      why:
        'Expired and revoked booking-manage grants and opt-out verification attempts. A dead token is not ' +
        'evidence of anything once the window it belonged to has closed, and ninety days leaves a quarter ' +
        'of history for a dispute about a cancellation somebody says they did not make.',
    },
    {
      dataClass: 'operational' as DataClass,
      retainDays: 365 * profile.financialRetentionYears,
      why:
        'Bookings and appointments are joined to invoices, so their retention is TIED to the financial ' +
        'obligation rather than chosen: purging a booking an invoice line points at would break the ' +
        'document the FTA requires be kept. The figure is read from ' +
        'regulatory_profile_current.financial_retention_years and is never a literal.',
    },
    {
      dataClass: 'identity' as DataClass,
      retainDays: null,
      why:
        'Not purged by time. A `customer` row is the anchor every retained document joins through, and a ' +
        'record deleted on a timer would orphan an invoice the business must keep. Identity leaves by ' +
        'ERASURE, which is a request about a person rather than a date.',
    },
    {
      dataClass: 'financial' as DataClass,
      retainDays: null,
      why:
        'Never purged by this pass. The rows are kept under the statutory obligation, they are append-only, ' +
        'and the application role holds no UPDATE or DELETE on them — a purge that reached them would be ' +
        'refused by the database anyway, and it is right that it is.',
    },
    {
      dataClass: 'clinical' as DataClass,
      retainDays: null,
      why:
        `Never purged by this pass, although the figure exists (${profile.clinicalRetentionYears} years, ` +
        'stored per row as `retain_until` at capture). Two reasons and either alone would be enough: 0009 ' +
        'revokes every privilege on the schema from the application role, and Y1-licence is unanswered so ' +
        'the figure itself is provisional. A pass that destroyed health records on a provisional number ' +
        'would be irreversible on the strength of an assumption.',
    },
    {
      dataClass: 'audit' as DataClass,
      retainDays: null,
      why:
        'Never purged by this pass. `audit_event` is partitioned monthly precisely so that retention is a ' +
        'DETACH performed by a person (0005), and every other audit table is append-only for every role. A ' +
        'trail a scheduled job could trim is not a trail.',
    },
    {
      dataClass: 'consent_record' as DataClass,
      retainDays: null,
      why:
        'Never purged. The log is the only evidence of what this business was permitted to do and when it ' +
        'stopped being permitted, and 0056 makes it append-only for every role including the owner.',
    },
    {
      dataClass: 'suppression_record' as DataClass,
      retainDays: null,
      why:
        'Never purged, and this is the entry worth reading twice. Ageing out a suppression would make ' +
        'everybody who ever unsubscribed messageable again after a while — the single worst thing a ' +
        'scheduled job in this system could do, and it would look like tidying up. The rows hold an HMAC ' +
        'and no recipient, so there is no exposure to trade against it.',
    },
    {
      dataClass: 'not_customer_data' as DataClass,
      retainDays: null,
      why: 'Not a data subject’s data, so no data-subject retention rule applies.',
    },
  ])
}

export interface PurgeReport {
  readonly purged: readonly string[]
  readonly keptWithinRetention: readonly string[]
  readonly keptNoRuleForClass: readonly string[]
  /** Reported, never merely omitted. The acceptance line turns on this list existing. */
  readonly skippedUnderLegalHold: readonly { readonly rowId: string; readonly dataClass: string }[]
}

/**
 * Reads the candidates, asks `@berelax/core` for the verdicts, and carries out the purges.
 *
 * The decision is pure and lives in core; this function does the I/O. That split is what lets the
 * frozen-clock acceptance test assert exactly which row ids fall which way without a database at all, and
 * lets the integration test check that the statements match the verdicts.
 */
export async function runRetentionPurge(sql: Sql, nowIso: string): Promise<PurgeReport> {
  const [profile] = await sql<
    { financialRetentionYears: number; clinicalRetentionYears: number }[]
  >`
    select financial_retention_years as "financialRetentionYears",
           clinical_retention_years  as "clinicalRetentionYears"
      from regulatory_profile_current
  `
  const rules = retentionRulesFor({
    financialRetentionYears: Number(profile?.financialRetentionYears ?? 5),
    clinicalRetentionYears: Number(profile?.clinicalRetentionYears ?? 25),
  })

  // **Both sides of the hold comparison are resolved through `merge_survivor_of`, and that is what makes
  // `legal_hold`'s merge-allowlist entry true rather than hopeful.**
  //
  // `legal_hold.subject_customer_id` is allowlisted in `merge-participants.ts`: a merge does not re-point
  // it, because its live-hold uniqueness is a partial index over two `coalesce` EXPRESSIONS and the
  // executor's conflict test is a list of plain columns — so a hold on "every subject" (a null
  // `subject_customer_id`) could collide on a re-point without the skip ever detecting it. The read side
  // resolves the tombstone instead, which is 0069's standing answer and the one the clinical tables already
  // rely on.
  //
  // Resolving only ONE side would be worse than resolving neither, because it would look done: a hold
  // placed on a record that was later merged away has to keep protecting the survivor's rows, and a hold
  // placed on the survivor has to protect rows captured under the loser's id before the merge. The function
  // returns its input unchanged for an id that is not a tombstone, so the ordinary case is untouched.
  const holds = await sql<{ subjectCustomerId: string | null; dataClass: string | null }[]>`
    select merge_survivor_of(subject_customer_id) as "subjectCustomerId", data_class as "dataClass"
      from legal_hold where lifted_at is null
  `

  // The candidates. Only the classes with a non-null retention are read at all, so a class this pass does
  // not purge costs nothing and cannot be purged by an oversight in the verdict loop.
  //
  // **`otp_phone_lock` is deliberately absent, and the absence is stated rather than left to be noticed.**
  // The table has no surrogate key: its primary key IS `phone_e164` (0067), so the only candidate id it
  // could offer is the phone number itself — and this pass names every row it takes in `PurgeReport.purged`
  // and passes each id through `planRetentionPurge`, so including it would carry plaintext phone numbers
  // through the plan and into the report. A set-based `delete ... where locked_until < now()` would avoid
  // that and is the wrong trade for a different reason: it abandons "one statement per row, and the plan is
  // the authority", which is what stops a predicate removing a row the plan never named. An earlier draft
  // of this rule's `why` claimed phone locks WERE pruned here, which was simply untrue of the query.
  //
  // What is NOT left open by this: a person who asks to be forgotten IS covered, because
  // `otp_phone_lock.phone_e164` is classified `delete_row` in the erasure rule registry and the erasure
  // matches it on the number. What is missing is only the time-based sweep for somebody who never asked,
  // and closing it needs a surrogate key on a table this unit does not own.
  const candidates = await sql<
    { rowId: string; dataClass: string; anchoredAt: Date; subjectCustomerId: string | null }[]
  >`
    select id::text as "rowId", 'contact_channel' as "dataClass", created_at as "anchoredAt",
           null::uuid as "subjectCustomerId"
      from otp_challenge
    union all
    -- Resolved, for the reason given above the holds query: a row captured under a tombstone's id must be
    -- matched against a hold placed on the survivor.
    select id::text, 'contact_channel', created_at, merge_survivor_of(customer_id)
      from booking_session where expires_at < ${nowIso}::timestamptz
    union all
    select id::text, 'credential', created_at, null::uuid
      from booking_manage_grant where expires_at < ${nowIso}::timestamptz
  `

  const verdicts = planRetentionPurge({
    candidates: candidates.map(
      (c): PurgeCandidate => ({
        rowId: c.rowId,
        dataClass: c.dataClass as DataClass,
        anchoredAt: c.anchoredAt,
      }),
    ),
    rules,
    holds: holds.map(
      (h): LegalHold => ({
        subjectCustomerId: h.subjectCustomerId,
        dataClass: h.dataClass === null ? null : (h.dataClass as DataClass),
      }),
    ),
    subjectOf: new Map(
      candidates
        .filter((c) => c.subjectCustomerId !== null)
        .map((c) => [c.rowId, c.subjectCustomerId as string]),
    ),
    now: new Date(nowIso),
  })

  const byId = new Map(candidates.map((c) => [c.rowId, c]))
  const purged: string[] = []
  const keptWithinRetention: string[] = []
  const keptNoRuleForClass: string[] = []
  const skippedUnderLegalHold: { rowId: string; dataClass: string }[] = []

  for (const verdict of verdicts) {
    const candidate = byId.get(verdict.rowId)
    if (candidate === undefined) continue
    if (verdict.outcome === 'skip') {
      skippedUnderLegalHold.push({ rowId: verdict.rowId, dataClass: candidate.dataClass })
      continue
    }
    if (verdict.outcome === 'keep') {
      ;(verdict.because === 'within_retention' ? keptWithinRetention : keptNoRuleForClass).push(
        verdict.rowId,
      )
      continue
    }
    // One statement per row rather than a batched delete keyed on the class, so a row the plan did not
    // name cannot be removed by a predicate that happens to match it. The plan is the authority.
    if (candidate.dataClass === 'contact_channel') {
      await sql`delete from otp_challenge where id = ${verdict.rowId}::uuid`
      await sql`delete from booking_session where id = ${verdict.rowId}::uuid`
    } else if (candidate.dataClass === 'credential') {
      await sql`delete from booking_manage_grant where id = ${verdict.rowId}::uuid`
    }
    purged.push(verdict.rowId)
  }

  return {
    purged: Object.freeze(purged),
    keptWithinRetention: Object.freeze(keptWithinRetention),
    keptNoRuleForClass: Object.freeze(keptNoRuleForClass),
    skippedUnderLegalHold: Object.freeze(skippedUnderLegalHold),
  }
}

export const RETENTION_PURGE_AGENT = 'retention_purge'

let configured: Sql | undefined

/**
 * Supplies the connection. Called by `run.ts` before `startWorkers()`, as the other job modules are.
 *
 * A setter rather than a connection this module opens for itself, so the worker holds one pool; and a
 * REFUSAL rather than a lazily-opened fallback, because a purge that quietly opened its own connection
 * would bypass whatever the process was configured with and delete rows against a database nobody meant.
 */
export function setRetentionPurgeSql(sql: Sql): void {
  configured = sql
}

function runtime(): Sql {
  if (configured === undefined) {
    throw new AppError(
      'invariant_violated',
      `${RETENTION_PURGE_JOB} ran before setRetentionPurgeSql() supplied a connection. run.ts calls it ` +
        'before startWorkers().',
    )
  }
  return configured
}

async function retentionPurgeHandler(_data: never, context: JobContext): Promise<void> {
  const report = await runRetentionPurge(runtime(), context.now())
  console.log(
    `${RETENTION_PURGE_JOB} ${context.now()}: ${report.purged.length} purged, ` +
      `${report.keptWithinRetention.length} within retention, ` +
      `${report.keptNoRuleForClass.length} in a class this pass does not purge, ` +
      `${report.skippedUnderLegalHold.length} skipped under legal hold`,
  )
}

/**
 * The purge's definition.
 *
 * 05:15 Asia/Dubai, after trading closes at 02:00 and after the four existing nightly passes
 * (recurring-cost at 03:45, reverse-charge at 04:15, credential-sweep at 04:45) — the nightly work should
 * not contend, and this pass takes row locks on tables the booking path writes to. Inside trading hours it
 * would delete a booking session somebody is part-way through using.
 *
 * `RETENTION_PURGE_JOB` from `@berelax/shared` rather than a literal, for the reason
 * `REBUILD_OBLIGATION_NOTICES_JOB` gives: a name spelled twice is a job that is declared in one place and
 * registered under another, with nothing to say so.
 */
export const RETENTION_PURGE_JOB_DEFINITION: JobDefinition<never> = {
  name: RETENTION_PURGE_JOB,
  purpose:
    'Anonymises or deletes rows past their retention period, per data class, skipping and REPORTING ' +
    'anything under legal hold (C-CRM-10, docs/04 §8). Classes whose rules say null are never touched, ' +
    'which is most of them: financial rows are kept under the statutory obligation, audit and consent ' +
    'logs are append-only, and ageing out a suppression would make everybody who ever unsubscribed ' +
    'messageable again.',
  cron: '15 5 * * *',
  agent: RETENTION_PURGE_AGENT,
  retryLimit: 3,
  retryDelaySeconds: 120,
  retryBackoff: true,
  // One read per class plus one statement per purged row. Ten minutes is generous, and a reclaimed pass is
  // safe: deleting a row that is already gone is a no-op, so the pass is idempotent by construction.
  expireInSeconds: 600,
  handler: retentionPurgeHandler,
}
