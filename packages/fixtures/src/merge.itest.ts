import {
  type ConsentLog,
  type ConsentRecord,
  type CustomerMergePlan,
  type CustomerMergeSubject,
  type Instant,
  LABEL_AGREEMENTS,
  PHONE_AGREEMENTS,
  planCustomerMerge,
  resolveConsent,
  resolveSuppression,
  type SuppressionLog,
  scoreDuplicatePair,
  suppressionKeyNormaliser,
  unionByNaturalKey,
} from '@berelax/core'
import {
  type Actor,
  AuditWriter,
  applyMergeParticipant,
  assertParticipantIsWellFormed,
  assertParticipantKeyIsAUniqueIndex,
  type ConsentLogRead,
  type CustomerMergePlanInput,
  type CustomerMergeSubjectRead,
  createConnection,
  ensureCustomer,
  MERGE_ALLOWLIST,
  MERGE_AUDIT_ACTIONS,
  MERGE_PARTICIPANTS,
  type MergeParticipant,
  mergeCoverage,
  mergeCustomers,
  mergeRefusalOf,
  mergeRowCounts,
  mergeSurvivorOf,
  participantName,
  publishEvent,
  readConsentLog,
  readCurrentConsentWording,
  readCustomerMergeSubject,
  readMergeRecordForLoser,
  readMergeTableReports,
  readSuppressionLogs,
  recordConsent,
  recordSuppression,
  type Sql,
  type SuppressionKeying,
  type SuppressionLogRead,
  suppressionKey,
  type UnitOfWork,
  unsuppressKey,
  withdrawConsent,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fixtureSuppressionPeppers } from './suppression.ts'
import { syntheticPerson } from './synthetic.ts'

/**
 * C-CRM-05 — the merge as one transaction, the participant registry, and the tombstone.
 *
 * `packages/fixtures` is the only package that may import both halves, and the two claims that need it
 * are the ones this file exists for: `planCustomerMerge` is pure and lives in `@berelax/core`, the rows
 * live in PostgreSQL and `@berelax/db` moves them, and neither package may import the other. So the two
 * shapes that travel between them are asserted with `satisfies` rather than described in a comment.
 *
 * ## Every merge here runs in ONE unit of work, and that unit of work is rolled back
 *
 * A merge is not repeatable. `merge_record_one_merge_per_loser` makes a second attempt on one pair
 * `already_merged`, and `consent` and `suppression` are append-only so the rows a merge writes cannot be
 * removed afterwards. A file that committed its merges would pass once against a fresh database and
 * answer `already_merged` for ever after — and it would leave the estate every later suite reads holding
 * tombstones nobody expected (brief rule 12). So `probe` opens a real `withUnitOfWork` — the production
 * seam, not a hand-rolled transaction — runs the case inside it, and throws at the end to roll it back.
 * Nothing is skipped by that: the triggers, the CHECKs and the unique indexes all fire inside a
 * transaction, which is where they fire in production too.
 *
 * Wherever a case expects a statement to RAISE — a refused merge, a refused UPDATE on an append-only
 * table — it goes through `attempt`, which nests a savepoint. Without one the first failed statement
 * aborts the probe's transaction, and every assertion after it comes back as 25P02 rather than as the
 * thing being measured.
 *
 * The probe customers are keyed on FIXED synthetic numbers on the unallocated `+971 59` prefix, outside
 * every band already in use (`generateSalon`'s 1–140, the CRM suites' 4411 upward, the consent loader's
 * 9101–9104, `consent.itest.ts`'s 9111–9112, the suppression loader's 9201–9203 and the bands at 9301 and
 * 9401), and they are re-ensured in `beforeAll` because `customer-identity.itest.ts` clears the whole
 * `customer` table between its cases.
 *
 * Nothing here is a name: a record with no display name is labelled `Customer 0042` (ADR 0020).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ACTOR: Actor = { kind: 'staff', label: 'Manager (fixture)' }
/** Fixed instants, so nothing here depends on a wall clock and the orderings are readable. */
const T0_ISO = '2099-08-01T10:00:00.000Z'
const T1_ISO = '2099-09-01T10:00:00.000Z'
const T2_ISO = '2099-09-02T10:00:00.000Z'
const MERGED_AT_ISO = '2099-09-25T10:00:00.000Z'
const AFTER_ISO = '2099-10-01T10:00:00.000Z'

const SURVIVOR = syntheticPerson(9_501)
const LOSER = syntheticPerson(9_502)
const THIRD = syntheticPerson(9_503)

const CAPTURE = {
  source: 'front_desk',
  actorKind: 'staff',
  actorLabel: 'Receptionist (fixture)',
  locale: 'en',
} as const

const MERGE_ARGS = {
  mergedAtIso: MERGED_AT_ISO,
  reason: 'One person, two records: the same handset was entered twice at the front desk.',
  actorKind: 'staff',
  actorLabel: 'Manager (fixture)',
} as const

let sql: Sql
let survivorId: string
let loserId: string
let thirdId: string
let marketingWordingId: string
let marketingWordingHash: string
let keying: SuppressionKeying

const ROLLBACK = 'ccrm05 rollback'

interface Probe {
  readonly tx: Sql
  readonly uow: UnitOfWork
}

/** Runs a body inside ONE real unit of work that is ALWAYS rolled back, carrying its answer out. */
async function probe<T>(body: (p: Probe) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      carried = await body({ tx: uow.sql, uow })
      throw new Error(ROLLBACK)
    })
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err
  }
  return carried as T
}

/** postgres.js exposes `savepoint` on a transaction and not on the pool, and the `Sql` type is the pool's. */
interface Savepointing {
  savepoint<T>(cb: (sp: Sql) => Promise<T>): Promise<T>
}

/**
 * Runs a body in a nested unit of work over a SAVEPOINT, so a merge that raises rolls back only itself.
 *
 * The unit of work is assembled here rather than through `withUnitOfWork`, which opens a transaction on
 * the pool and cannot nest. What it does with the savepoint is what a failed statement does to the
 * merge's own transaction — every write gone, nothing half applied — which is exactly the claim the
 * transaction case measures.
 */
async function attempt<T>(uow: UnitOfWork, body: (inner: UnitOfWork) => Promise<T>): Promise<T> {
  return (uow.sql as unknown as Savepointing).savepoint(async (sp) =>
    body({
      sql: sp,
      audit: new AuditWriter(sp, ACTOR),
      publish: (event) => publishEvent(sp, event),
    }),
  )
}

/** The error a body raised, or null when it did not raise. */
const raised = (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => null,
    (err: unknown) => err,
  )

/** The SQLSTATE a statement raised, or null when it did not raise. */
async function sqlstateOf(run: Promise<unknown>): Promise<string | null> {
  const error = await raised(run)
  return typeof (error as { code?: unknown } | null)?.code === 'string'
    ? (error as { code: string }).code
    : null
}

/** Counted in SQL, never through a capped reader: `audit_event` only grows (brief rule 12). */
async function auditCount(tx: Sql, action: string): Promise<number> {
  const [row] = await tx<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

const countOf = async (tx: Sql, statement: Promise<{ n: string }[]>): Promise<number> => {
  void tx
  const [row] = await statement
  return Number(row?.n ?? '0')
}

/**
 * The db read, narrowed to the resolver's own type.
 *
 * `satisfies` would not do on its own: `recordedAt` is a plain `number` on the db side, because that
 * package may not import core's `Instant` brand, so the cast is unavoidable — and the membership
 * assertions are what make it honest rather than hopeful. The arrangement `consent.itest.ts` uses.
 */
function asConsentLog(read: ConsentLogRead): ConsentLog {
  for (const record of read.records) {
    expect(['granted', 'withdrawn'], 'kind is a label core knows').toContain(record.kind)
    expect(Number.isFinite(record.recordedAt), `${record.id} has a finite instant`).toBe(true)
  }
  return {
    contactId: read.contactId,
    records: read.records.map(
      (record): ConsentRecord => ({ ...record, recordedAt: record.recordedAt as Instant }),
    ),
    wordingVersions: read.wordingVersions,
  }
}

const asSuppressionLog = (read: SuppressionLogRead): SuppressionLog => ({
  key: read.key,
  records: read.records.map((record) => ({ ...record, recordedAt: record.recordedAt as Instant })),
})

const at = (iso: string): Instant => Date.parse(iso) as Instant

async function subjectOf(tx: Sql, id: string): Promise<CustomerMergeSubjectRead> {
  const subject = await readCustomerMergeSubject(tx, id)
  if (subject === null) throw new Error(`the fixture customer ${id} is missing`)
  return subject
}

/**
 * The plan a merge of two probe records makes, from the real scorer.
 *
 * The score is computed for one number against ITSELF, which is what the fixture represents: two
 * spellings of one handset, the only shape C-CRM-02's table lets `auto_merge` act on. The two probe
 * records necessarily hold different numbers, because `customer.phone_e164` is UNIQUE — which is the
 * same constraint that makes the number untransferable in the plan.
 */
function planFor(
  survivor: CustomerMergeSubjectRead,
  loser: CustomerMergeSubjectRead,
): CustomerMergePlanInput {
  const score = scoreDuplicatePair(
    { phone: SURVIVOR.phone, label: SURVIVOR.label },
    { phone: SURVIVOR.phone, label: SURVIVOR.label },
  )
  const decision = planCustomerMerge(
    survivor as CustomerMergeSubject,
    loser as CustomerMergeSubject,
    score,
    'auto_merge',
  )
  if (decision.kind !== 'plan') throw new Error(`the fixture pair was refused: ${decision.refusal}`)
  // The survivor is the earlier record, which the fixture arranges by creating it first. Asserted here
  // rather than assumed, because every count below is about the right one of the two.
  expect(decision.survivorId).toBe(survivor.id)
  return decision satisfies CustomerMergePlanInput
}

/** Reads both probe records and plans the merge, inside the caller's transaction. */
async function planned(tx: Sql): Promise<CustomerMergePlanInput> {
  return planFor(await subjectOf(tx, survivorId), await subjectOf(tx, loserId))
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  // Re-ensured rather than assumed: `customer-identity.itest.ts` clears the whole customer table, so a
  // file that trusted an earlier fixture would pass or fail on vitest's file ordering (brief rule 12).
  // The survivor is created FIRST, so it is the earlier record and `planCustomerMerge` picks it.
  const ensure = async (
    person: { phone: string; label: string },
    named: boolean,
  ): Promise<string> =>
    withUnitOfWork(sql, ACTOR, async (uow) => {
      const result = await ensureCustomer(uow, {
        phoneE164: person.phone,
        displayName: named ? person.label : null,
        // The key `nameMatchKey` in core produces, which the fixture cannot compute here without
        // importing it; the shape is what matters — it moves with the name or not at all.
        nameMatchKey: named
          ? `${person.label.toLowerCase().replace(/\s+/g, '')}|${person.phone.slice(-4)}`
          : null,
        locale: 'en',
        createdVia: named ? 'guest_booking' : 'front_desk',
      })
      return result.customer.id
    })

  survivorId = await ensure(SURVIVOR, false)
  loserId = await ensure(LOSER, true)
  thirdId = await ensure(THIRD, false)

  const wording = await readCurrentConsentWording(sql, 'marketing')
  if (wording === null) {
    throw new Error('No marketing consent wording is published. Run `pnpm seed` (brief rule 24).')
  }
  marketingWordingId = wording.id
  marketingWordingHash = wording.contentHashHex
  keying = { peppers: fixtureSuppressionPeppers(process.env), normalise: suppressionKeyNormaliser }
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------
// The registry
// ------------------------------------------------------------------------------------------------

describe('the participant registry', () => {
  it('names every table carrying a customer or contact id as a participant or an allowlisted exception', async () => {
    const coverage = await mergeCoverage(sql)
    const unregistered = coverage.filter((row) => row.status === 'unregistered')
    expect(
      unregistered.map((row) => `${row.schema}.${row.table}.${row.column}`),
      'a table carrying a customer id that nothing in the registry accounts for — register a merge ' +
        'participant for it, or add it to MERGE_ALLOWLIST with the reason a merge must not touch it',
    ).toEqual([])
    // The control that stops an empty catalogue satisfying the assertion above: the query has to be
    // finding the tables in the first place, and both classifications have to occur.
    expect(coverage.length, 'tables carrying a customer or contact id').toBeGreaterThanOrEqual(15)
    expect(coverage.some((row) => row.status === 'participant')).toBe(true)
    expect(coverage.some((row) => row.status === 'allowlisted')).toBe(true)
    // Every registry entry is REACHED by the catalogue, which is the other direction: an entry for a
    // table that no longer exists would silently never run, and an allowlisted one would read as a
    // decision somebody took about a real table.
    const catalogued = new Set(coverage.map((row) => `${row.schema}.${row.table}.${row.column}`))
    for (const p of MERGE_PARTICIPANTS) {
      expect(catalogued, `${participantName(p)} is a real table`).toContain(
        `${p.schema}.${p.table}.${p.column}`,
      )
    }
    for (const entry of MERGE_ALLOWLIST) {
      expect(
        catalogued,
        `${entry.schema}.${entry.table}.${entry.column} is allowlisted but does not exist`,
      ).toContain(`${entry.schema}.${entry.table}.${entry.column}`)
    }
  })

  it('reports a table nobody registered, and stops reporting it once it is registered', async () => {
    await probe(async ({ tx }) => {
      // A table added by a later unit, which is the case the registry exists for: nothing in a review of
      // that unit's diff would say a merge now has one more table to handle.
      await tx.unsafe(
        'create table merge_fixture_unregistered (id uuid primary key default uuid_generate_v7(), ' +
          'customer_id uuid not null)',
      )
      const coverage = await mergeCoverage(tx)
      const found = coverage.find((row) => row.table === 'merge_fixture_unregistered')
      expect(found?.status).toBe('unregistered')
      expect(found?.column).toBe('customer_id')
      expect(found?.reason).toBeNull()

      // And the control: registered, the same catalogue reports it as handled. Without this the
      // assertion above would pass for a coverage function that called everything unregistered.
      const adHoc: MergeParticipant = {
        schema: 'public',
        table: 'merge_fixture_unregistered',
        column: 'customer_id',
        strategy: 'repoint_update',
        conflictKey: null,
        activePredicate: null,
        dedupeKey: null,
        backReference: null,
        excludeColumns: [],
        retainedReason: null,
        why: 'The fixture table this case creates, registered to prove the coverage query sees it.',
        registeredBy: 'C-CRM-05 (fixture)',
      }
      const registered = await mergeCoverage(tx, [...MERGE_PARTICIPANTS, adHoc])
      expect(registered.find((row) => row.table === 'merge_fixture_unregistered')?.status).toBe(
        'participant',
      )
    })
  })

  it('enumerates base tables only, so a view is not asked to re-point anything', async () => {
    const coverage = await mergeCoverage(sql)
    const named = coverage.map((row) => `${row.schema}.${row.table}`)
    // The SECURITY DEFINER view the booking layer reads clinical flags through has no rows of its own.
    expect(named).not.toContain('public.customer_contraindication_flags')
    // Its table is enumerated in its own right, and allowlisted with the privilege reason.
    expect(
      coverage.find((row) => row.schema === 'clinical' && row.table === 'contraindication_flag')
        ?.status,
    ).toBe('allowlisted')
  })

  it('has no flow-run participant yet, which is the deferral to C-AUTO-07 stated as a test', async () => {
    const coverage = await mergeCoverage(sql)
    // C-AUTO-07 owns `flow_run` and its (flow_run, node, channel, contact) idempotency key, and it
    // depends on this unit. The day that table lands, the completeness case above turns red until it is
    // registered — which is the whole point of enumerating from the catalogue. This assertion exists so
    // the deferral is visible here and not only in the manifest.
    //
    // It used to assert that NO table starting with `flow_` was catalogued, and that was true when it was
    // written and false a few hours later: C-AUTO-06 landed 0070 with `flow_enrolment.customer_id`, and
    // this case reported the arrival of a table it had no opinion about as the deferral breaking. The
    // deferral is about `flow_run` specifically, so it names it — and `flow_enrolment` is asserted to be
    // a REGISTERED participant here as well, because "the enrolment moves with the contact" is a decision
    // taken at that merge and this is where a reader of the deferral will look for it.
    expect(coverage.map((row) => row.table).filter((table) => table === 'flow_run')).toEqual([])
    expect(
      coverage.find((row) => row.table === 'flow_enrolment')?.status,
      'flow_enrolment is registered, not merely absent from the deferral',
    ).toBe('participant')
  })
})

// ------------------------------------------------------------------------------------------------
// One transaction
// ------------------------------------------------------------------------------------------------

/** A participant that is well formed and names a table that does not exist. Fails at execution. */
const BROKEN_PARTICIPANT: MergeParticipant = {
  schema: 'public',
  table: 'merge_probe_missing_table',
  column: 'customer_id',
  strategy: 'repoint_update',
  conflictKey: null,
  activePredicate: null,
  dedupeKey: null,
  backReference: null,
  excludeColumns: [],
  retainedReason: null,
  why: 'Deliberately absent from the database, so the merge fails AFTER the consents are re-pointed.',
  registeredBy: 'C-CRM-05 (fixture)',
}

describe('a participant reaches sql.unsafe only if every identifier is one', () => {
  it('refuses a table name that is not an identifier, before any statement is issued', async () => {
    await probe(async ({ tx, uow }) => {
      // The executor builds its statements with `sql.unsafe`, because a dynamic table name, a dynamic
      // column list and a partial-index predicate cannot all be bound as parameters. This is the boundary
      // that makes that safe, and it has to be shown to hold: nothing in the registry comes from a
      // request, but a registry entry is source somebody edits.
      const injected: MergeParticipant = {
        ...BROKEN_PARTICIPANT,
        table: 'customer_tag; drop table customer',
      }
      const plan = await planned(tx)
      const error = await raised(mergeCustomers(uow, { ...MERGE_ARGS, plan }, [injected]))
      expect(mergeRefusalOf(error)).toBe('merge_participant_invalid')
      expect(String(error)).toContain('not a bare lower-case SQL identifier')
      // Nothing was issued: the transaction is still usable and the table is still there. Had the
      // statement run first, this read would come back as 25P02 instead.
      expect(
        await countOf(tx, tx<{ n: string }[]>`select count(*)::text as n from customer`),
      ).toBeGreaterThan(0)
      // And the control: every registered participant passes the same check, so it is not a check that
      // refuses everything.
      for (const p of MERGE_PARTICIPANTS) {
        expect(() => assertParticipantIsWellFormed(p), participantName(p)).not.toThrow()
      }
    })
  })
})

describe('the merge is one transaction', () => {
  it('leaves both records fully intact when it fails immediately after the consents are re-pointed', async () => {
    await probe(async ({ tx, uow }) => {
      await grantMarketing(uow, survivorId, T1_ISO)
      await withdrawMarketing(uow, loserId, T2_ISO)
      const before = await consentCounts(tx)
      const auditBefore = await auditCount(tx, MERGE_AUDIT_ACTIONS.merged)

      // The consent participant, then a participant that cannot run. `consent` is deliberately not last
      // in the registry so that this failure lands where the acceptance criterion asks for it.
      const upToConsent = MERGE_PARTICIPANTS.slice(
        0,
        MERGE_PARTICIPANTS.findIndex((p) => p.table === 'consent') + 1,
      )
      expect(upToConsent.at(-1)?.table).toBe('consent')

      const plan = await planned(tx)
      const error = await raised(
        attempt(uow, (inner) =>
          mergeCustomers(inner, { ...MERGE_ARGS, plan }, [...upToConsent, BROKEN_PARTICIPANT]),
        ),
      )
      expect(error, 'the merge raised').not.toBeNull()

      expect(await consentCounts(tx), 'zero consent rows moved or copied').toEqual(before)
      expect(await readMergeRecordForLoser(tx, loserId), 'no merge_record written').toBeNull()
      expect(await auditCount(tx, MERGE_AUDIT_ACTIONS.merged)).toBe(auditBefore)

      // The control: the same merge with the real registry DOES copy the log, so the assertions above
      // are about the rollback and not about a merge that never touches consent.
      const outcome = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      expect(outcome.kind).toBe('merged')
      expect((await consentCounts(tx)).survivor).toBeGreaterThan(before.survivor)
    })
  })
})

// ------------------------------------------------------------------------------------------------
// Consent
// ------------------------------------------------------------------------------------------------

async function grantMarketing(
  uow: UnitOfWork,
  contactId: string,
  recordedAtIso: string,
): Promise<void> {
  await recordConsent(uow, {
    contactCustomerId: contactId,
    channel: 'sms',
    purpose: 'marketing',
    kind: 'granted',
    recordedAtIso,
    wordingId: marketingWordingId,
    wordingHashHex: marketingWordingHash,
    capture: CAPTURE,
  })
}

async function withdrawMarketing(
  uow: UnitOfWork,
  contactId: string,
  recordedAtIso: string,
): Promise<void> {
  await withdrawConsent(uow, {
    contactCustomerId: contactId,
    channel: 'sms',
    purpose: 'marketing',
    recordedAtIso,
    wordingId: null,
    wordingHashHex: null,
    capture: CAPTURE,
  })
}

async function consentCounts(tx: Sql): Promise<{ survivor: number; loser: number }> {
  const [row] = await tx<{ s: string; l: string }[]>`
    select count(*) filter (where contact_customer_id = ${survivorId})::text as s,
           count(*) filter (where contact_customer_id = ${loserId})::text as l
      from consent
  `
  return { survivor: Number(row?.s ?? '0'), loser: Number(row?.l ?? '0') }
}

/** The state the SEND path would read, through the function the send path uses. */
async function marketingStateOf(tx: Sql, contactId: string, atIso: string) {
  return resolveConsent(
    asConsentLog(await readConsentLog(tx, contactId)),
    'sms',
    'marketing',
    at(atIso),
  )
}

describe('consent resolves to the strictest state a merge can produce', () => {
  it('lets a withdrawal on the loser govern the survivor when it is the newest thing either said', async () => {
    await probe(async ({ tx, uow }) => {
      await grantMarketing(uow, survivorId, T1_ISO)
      await withdrawMarketing(uow, loserId, T2_ISO)

      // Before the merge the survivor is sendable, so the assertion below is about the merge.
      expect((await marketingStateOf(tx, survivorId, AFTER_ISO)).state).toBe('granted')

      await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })

      // `resolveConsent` itself, over the merged log — the same function the send path reads through,
      // not a query written for this test.
      expect((await marketingStateOf(tx, survivorId, AFTER_ISO)).state).toBe('withdrawn')
    })
  })

  it('leaves a later grant standing, so the strictest state is the newest decision and not the harshest', async () => {
    await probe(async ({ tx, uow }) => {
      // The mirror of the case above: the withdrawal is the OLDER decision, and the person opted back in.
      await withdrawMarketing(uow, loserId, T0_ISO)
      await grantMarketing(uow, survivorId, T1_ISO)
      await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      // The control that stops the previous case passing for a merge that simply withdraws everything: a
      // merge may not manufacture a withdrawal nobody made, and the union of two logs is one person's
      // real chronology.
      expect((await marketingStateOf(tx, survivorId, AFTER_ISO)).state).toBe('granted')
    })
  })

  it('copies the log rather than moving it, so the loser keeps every record it had', async () => {
    await probe(async ({ tx, uow }) => {
      await grantMarketing(uow, survivorId, T1_ISO)
      await withdrawMarketing(uow, loserId, T2_ISO)
      const before = await consentCounts(tx)
      await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      const after = await consentCounts(tx)
      // Append-only: nothing is deleted from the tombstone's log (ADR 0008, brief rule 9).
      expect(after.loser).toBe(before.loser)
      expect(after.survivor).toBe(before.survivor + before.loser)
      // And the copy keeps the decision instant, which is what makes the resolver read a chronology.
      const log = await readConsentLog(tx, survivorId)
      const withdrawals = log.records.filter((record) => record.kind === 'withdrawn')
      expect(withdrawals).toHaveLength(1)
      expect(withdrawals[0]?.recordedAt).toBe(Date.parse(T2_ISO))
    })
  })

  it('refuses a dedupe key no unique index backs, because "already there" would mean nothing', async () => {
    await probe(async ({ tx, uow }) => {
      await grantMarketing(uow, survivorId, T1_ISO)
      await withdrawMarketing(uow, loserId, T2_ISO)
      // The known-bad control, in-process: a dedupe key too COARSE to describe
      // `consent_one_record_per_instant`. Under it, `channel` alone matches the survivor's existing sms
      // row, so the loser's WITHDRAWAL is skipped as "already there" and is silently absent from the
      // survivor's log — a promotional message to somebody who opted out, with a merge that reported
      // success. The row counts cannot see it (the copy did what it was told), which is why the key is
      // checked against pg_index before the statement runs.
      const tooCoarse = MERGE_PARTICIPANTS.map((p) =>
        p.table === 'consent' ? { ...p, dedupeKey: ['channel'] } : p,
      )
      const plan = await planned(tx)
      const error = await raised(
        attempt(uow, (inner) => mergeCustomers(inner, { ...MERGE_ARGS, plan }, tooCoarse)),
      )
      expect(mergeRefusalOf(error)).toBe('merge_key_is_not_a_unique_index')
      expect(String(error)).toContain('public.consent')
      // And nothing was written: the refusal happens inside the merge's own transaction.
      expect(await readMergeRecordForLoser(tx, loserId)).toBeNull()
      // The control on the control: the REGISTERED key is backed by an index, so the refusal above is
      // about the mutant and not about a check that refuses everything.
      await expect(
        assertParticipantKeyIsAUniqueIndex(
          tx,
          MERGE_PARTICIPANTS.find((p) => p.table === 'consent') as MergeParticipant,
        ),
      ).resolves.toBeUndefined()
    })
  })

  it('refuses by name when a copy leaves rows behind, whatever the key said', async () => {
    await probe(async ({ tx, uow }) => {
      await grantMarketing(uow, survivorId, T1_ISO)
      await withdrawMarketing(uow, loserId, T2_ISO)
      // The other half, and it is a claim about the STATEMENT rather than about the key: after the copy,
      // no row on the loser may be without a counterpart on the survivor. Gate case 93c breaks the copy
      // itself and requires this refusal by name; here the query behind it is asserted to answer zero
      // for a real merge, so the guard is known to be looking at the right rows.
      const outcome = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      expect(outcome.kind).toBe('merged')
      const orphaned = await countOf(
        tx,
        tx<{ n: string }[]>`
          select count(*)::text as n from consent l
           where l.contact_customer_id = ${loserId}
             and not exists (select 1 from consent s
                              where s.contact_customer_id = ${survivorId}
                                and (s.channel, s.purpose, s.kind, s.recorded_at)
                                    is not distinct from (l.channel, l.purpose, l.kind, l.recorded_at))
        `,
      )
      expect(orphaned, 'every row on the tombstone has its counterpart on the survivor').toBe(0)
    })
  })
})

// ------------------------------------------------------------------------------------------------
// Suppression
// ------------------------------------------------------------------------------------------------

/** Details this fixture suppresses. Addresses are on the unroutable fixture domain (RFC 2606). */
const ONLY_LOSER = 'ccrm05.only.loser@fixture.invalid'
const NEWEST_LOSER = 'ccrm05.newest.loser@fixture.invalid'
const ALREADY_SURVIVOR = 'ccrm05.already.survivor@fixture.invalid'
const LIFTED = 'ccrm05.lifted@fixture.invalid'
const TIED = 'ccrm05.tied@fixture.invalid'

async function suppress(
  uow: UnitOfWork,
  recipient: string,
  contactCustomerId: string | null,
  recordedAtIso: string,
): Promise<void> {
  await recordSuppression(uow, keying, {
    keyKind: 'email',
    recipient,
    source: 'complaint',
    reason: 'Complaint reported by the mail provider against this address.',
    actorKind: 'system',
    actorLabel: 'Provider feedback',
    recordedAtIso,
    contactCustomerId,
  })
}

async function suppressionStates(
  tx: Sql,
  recipients: readonly string[],
  atIso: string,
): Promise<Record<string, string>> {
  const logs = await readSuppressionLogs(
    tx,
    keying,
    recipients.map((recipient) => ({ keyKind: 'email', recipient })),
  )
  const states: Record<string, string> = {}
  for (const recipient of recipients) {
    const log = logs.get(recipient)
    if (log === undefined) throw new Error(`${recipient} could not be keyed`)
    states[recipient] = resolveSuppression(asSuppressionLog(log), at(atIso)).state
  }
  return states
}

/** Distinct hashed keys attributed to one record, which is the figure the union claim is about. */
async function suppressionKeysFor(tx: Sql, contactId: string): Promise<number> {
  return countOf(
    tx,
    tx<{ n: string }[]>`
      select count(distinct (key_kind, key_hmac))::text as n
        from suppression where contact_customer_id = ${contactId}
    `,
  )
}

describe('suppression unions and de-duplicates by hashed key', () => {
  it('back-references one row per detail and leaves every resolved state exactly as it was', async () => {
    await probe(async ({ tx, uow }) => {
      const RECIPIENTS = [ONLY_LOSER, NEWEST_LOSER, ALREADY_SURVIVOR, LIFTED, TIED]
      // One detail only the loser names.
      await suppress(uow, ONLY_LOSER, loserId, T1_ISO)
      // One the survivor named first and the loser named more recently.
      await suppress(uow, NEWEST_LOSER, survivorId, T0_ISO)
      await suppress(uow, NEWEST_LOSER, loserId, T1_ISO)
      // One whose newest entry ALREADY names the survivor: owed nothing, which is the de-duplication.
      await suppress(uow, ALREADY_SURVIVOR, loserId, T0_ISO)
      await suppress(uow, ALREADY_SURVIVOR, survivorId, T1_ISO)
      // And one that was LIFTED. The dangerous direction: a merge that restated the suppression rather
      // than the newest entry would silently re-suppress somebody who had been taken off the list.
      await suppress(uow, LIFTED, loserId, T0_ISO)
      await unsuppressKey(uow, keying, {
        keyKind: 'email',
        recipient: LIFTED,
        source: 'manual',
        reason: 'The complaint was mis-attributed to this address.',
        actorKind: 'staff',
        actorLabel: 'Manager (fixture)',
        recordedAtIso: T1_ISO,
        contactCustomerId: loserId,
      })

      // And one whose newest entry is AMBIGUOUS: a suppression and a lift at the same instant, which
      // 0064 says the resolver deliberately fails closed on. A back-reference that restated one of the
      // two would settle that ambiguity by accident, and half the time the one it settled on reads as
      // "not suppressed" — so both are restated and the tie survives the merge intact.
      await suppress(uow, TIED, loserId, T1_ISO)
      await unsuppressKey(uow, keying, {
        keyKind: 'email',
        recipient: TIED,
        source: 'manual',
        reason: 'A second decision was recorded against this address at the same instant.',
        actorKind: 'staff',
        actorLabel: 'Manager (fixture)',
        recordedAtIso: T1_ISO,
        contactCustomerId: loserId,
      })

      const statesBefore = await suppressionStates(tx, RECIPIENTS, AFTER_ISO)
      expect(statesBefore[LIFTED], 'the lifted detail was clear before the merge').toBe('clear')
      expect(statesBefore[TIED], 'the tied detail failed closed before the merge').toBe(
        'suppressed',
      )
      expect({
        survivor: await suppressionKeysFor(tx, survivorId),
        loser: await suppressionKeysFor(tx, loserId),
      }).toEqual({ survivor: 2, loser: 5 })
      const totalBefore = await countOf(
        tx,
        tx<{ n: string }[]>`select count(*)::text as n from suppression`,
      )

      const outcome = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      if (outcome.kind !== 'merged') throw new Error(outcome.kind)
      const report = outcome.tables.find((table) => table.participant === 'public.suppression')

      // Four details are owed a back-reference — the loser-only one, the one whose newest entry names the
      // loser, the lifted one and the tied one — and one is not, because its newest entry already names
      // the survivor. One row per DETAIL rather than one per loser row, EXCEPT where the newest entry is
      // a tie, where both of the tied rows are restated: 4 details, 5 rows.
      expect(report?.rowsInserted).toBe(5)
      expect(
        report?.rowsMoved,
        'nothing is re-pointed here: the key is the detail, not the contact',
      ).toBe(0)
      expect(
        (await countOf(tx, tx<{ n: string }[]>`select count(*)::text as n from suppression`)) -
          totalBefore,
      ).toBe(5)
      // The tie is reproduced rather than settled: BOTH rows restated for that one detail, which is what
      // keeps the resolver failing closed on it afterwards. `row_number()` in place of `rank()` would
      // copy one of the two and settle the ambiguity by accident — gate case 93h is that mutant.
      expect(
        await countOf(
          tx,
          tx<{ n: string }[]>`
            select count(*)::text as n from suppression
             where contact_customer_id = ${survivorId}
               and recorded_at = ${MERGED_AT_ISO}::timestamptz
               and key_hmac = ${suppressionKey(keying.peppers.current, 'email', TIED)}
          `,
        ),
      ).toBe(2)

      // The union, de-duplicated: the survivor now names every detail either record named, counting a
      // shared one once.
      expect(await suppressionKeysFor(tx, survivorId)).toBe(5)
      // And the loser keeps everything it had, because the table refuses UPDATE and DELETE (ZQ001).
      expect(await suppressionKeysFor(tx, loserId)).toBe(5)

      // THE claim: only the attribution moved. Not one resolved state changed, including the lifted one.
      expect(await suppressionStates(tx, RECIPIENTS, AFTER_ISO)).toEqual(statesBefore)
    })
  })
})

// ------------------------------------------------------------------------------------------------
// The ledger union, whose table does not exist yet
// ------------------------------------------------------------------------------------------------

describe('the union_dedupe strategy, which C-AUTO-03 will register', () => {
  it('gives a survivor count of exactly 2 from one send on each record, and 1 from one send on both', async () => {
    const ledger: MergeParticipant = {
      schema: 'public',
      table: 'merge_fixture_ledger',
      column: 'contact_customer_id',
      strategy: 'union_dedupe',
      // The natural key C-AUTO-03's acceptance names, minus the contact: after the merge both sides ARE
      // the survivor's rows, so keying on the contact would make every pair look distinct.
      conflictKey: ['window_start', 'message_id'],
      activePredicate: null,
      dedupeKey: null,
      backReference: null,
      excludeColumns: [],
      retainedReason:
        'The same send is already recorded against the survivor under this natural key. Counted once: ' +
        'moving the second would double a message the rolling cap reads.',
      why: 'The frequency ledger’s shape, driven here because C-AUTO-03 depends on this unit.',
      registeredBy: 'C-CRM-05 (fixture)',
    }

    const run = async (loserMessageId: string) =>
      probe(async ({ tx }) => {
        await tx.unsafe(
          'create table merge_fixture_ledger (id uuid primary key default uuid_generate_v7(), ' +
            'contact_customer_id uuid not null, window_start date not null, message_id text not null, ' +
            'constraint merge_fixture_ledger_one_send unique (contact_customer_id, window_start, ' +
            'message_id))',
        )
        await tx.unsafe(
          'insert into merge_fixture_ledger (contact_customer_id, window_start, message_id) values ' +
            '($1, $3, $4), ($2, $3, $5)',
          [survivorId, loserId, '2099-09-01', 'm-survivor', loserMessageId],
        )
        return applyMergeParticipant(tx, ledger, {
          survivorCustomerId: survivorId,
          loserCustomerId: loserId,
          mergedAtIso: MERGED_AT_ISO,
        })
      })

    // Different messages: two sends happened, so the merged contact's count is 2 — never 1, which would
    // hand them a fresh allowance, and never 4, which would silence them on the strength of one message.
    const distinct = await run('m-loser')
    expect(distinct.rowsAfterSurvivor).toBe(2)
    expect(distinct.rowsMoved).toBe(1)
    expect(distinct.rowsRetainedOnLoser).toBe(0)

    // The same message recorded against both records is one message.
    const shared = await run('m-survivor')
    expect(shared.rowsAfterSurvivor).toBe(1)
    expect(shared.rowsMoved).toBe(0)
    expect(shared.rowsRetainedOnLoser).toBe(1)
    expect(shared.retainedReason).toContain('Counted once')

    // The pure rule the SQL implements, asserted on the same worked example. C-AUTO-03 registers the
    // table; the semantics are settled here.
    const key = (row: { window: string; message: string }) => `${row.window}|${row.message}`
    expect(
      unionByNaturalKey(
        [{ window: '2099-09-01', message: 'm-survivor' }],
        [{ window: '2099-09-01', message: 'm-loser' }],
        key,
      ).keptCount,
    ).toBe(2)
    expect(
      unionByNaturalKey(
        [{ window: '2099-09-01', message: 'm-survivor' }],
        [{ window: '2099-09-01', message: 'm-survivor' }],
        key,
      ).keptCount,
    ).toBe(1)
  })
})

// ------------------------------------------------------------------------------------------------
// Idempotency, the tombstone, and zero hard deletes
// ------------------------------------------------------------------------------------------------

describe('a repeated merge, and the tombstone', () => {
  it('answers already_merged and mutates nothing', async () => {
    await probe(async ({ tx, uow }) => {
      await grantMarketing(uow, survivorId, T1_ISO)
      const first = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      if (first.kind !== 'merged') throw new Error(first.kind)

      const survivorBefore = await mergeRowCounts(tx, survivorId)
      const loserBefore = await mergeRowCounts(tx, loserId)
      const auditBefore = await auditCount(tx, MERGE_AUDIT_ACTIONS.merged)
      const recordsBefore = await countOf(
        tx,
        tx<{ n: string }[]>`select count(*)::text as n from merge_record`,
      )

      // A second attempt is what an at-least-once queue and a double-clicked button both produce.
      const again = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      expect(again.kind).toBe('already_merged')
      expect(again.kind === 'already_merged' && again.mergeRecordId).toBe(first.mergeRecordId)

      expect(Object.fromEntries(await mergeRowCounts(tx, survivorId))).toEqual(
        Object.fromEntries(survivorBefore),
      )
      expect(Object.fromEntries(await mergeRowCounts(tx, loserId))).toEqual(
        Object.fromEntries(loserBefore),
      )
      expect(
        await countOf(tx, tx<{ n: string }[]>`select count(*)::text as n from merge_record`),
      ).toBe(recordsBefore)
      // Not even an audit row: a trail that grew one per redelivery would bury the one real merge.
      expect(await auditCount(tx, MERGE_AUDIT_ACTIONS.merged)).toBe(auditBefore)
    })
  })

  it('deletes nothing: the loser survives as a tombstone that resolves to the survivor', async () => {
    await probe(async ({ tx, uow }) => {
      await grantMarketing(uow, survivorId, T1_ISO)
      await withdrawMarketing(uow, loserId, T2_ISO)
      const customersBefore = await countOf(
        tx,
        tx<{ n: string }[]>`select count(*)::text as n from customer`,
      )
      const loserBefore = await mergeRowCounts(tx, loserId)

      await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })

      // Not one customer row went, and the loser's own row still holds its number and its label.
      expect(await countOf(tx, tx<{ n: string }[]>`select count(*)::text as n from customer`)).toBe(
        customersBefore,
      )
      const tombstone = await subjectOf(tx, loserId)
      expect(tombstone.phoneE164).toBe(LOSER.phone)
      expect(tombstone.displayName).toBe(LOSER.label)

      // And nothing was deleted from any participant: the append-only tables keep every row, and the
      // ones that move are re-pointed rather than removed.
      const loserAfter = await mergeRowCounts(tx, loserId)
      for (const [participant, before] of loserBefore) {
        const after = loserAfter.get(participant) ?? 0
        const strategy = MERGE_PARTICIPANTS.find(
          (p) => participantName(p) === participant,
        )?.strategy
        if (strategy === 'repoint_insert' || strategy === 'insert_backreference') {
          expect(after, `${participant} keeps every row`).toBe(before)
        } else {
          expect(after, `${participant} moved rows rather than deleting them`).toBeLessThanOrEqual(
            before,
          )
        }
      }

      expect(await mergeSurvivorOf(tx, loserId)).toBe(survivorId)
      // The control: a record that is not a tombstone resolves to itself, so a caller may wrap every
      // read in this unconditionally.
      expect(await mergeSurvivorOf(tx, survivorId)).toBe(survivorId)
    })
  })

  it('follows a chain, and refuses a merge into a tombstone by name', async () => {
    await probe(async ({ tx, uow }) => {
      await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })

      // The survivor is later merged into a third record, which is an ordinary sequence of events: the
      // first merge's row may not be edited, so the chain is what a lookup has to follow. The pair is
      // nominated the other way round from the pure default — the third record is the NEWER of the two —
      // which an operator may do (C-CRM-06's surface offers an explicit survivor choice, so the
      // repository takes the pair rather than re-deriving it) and is the only way to build a chain.
      const survivor = await subjectOf(tx, survivorId)
      const third = await subjectOf(tx, thirdId)
      expect(survivor.createdAt, 'the third record is the newer one').toBeLessThanOrEqual(
        third.createdAt,
      )
      const base = planFor(survivor, third)
      const onward: CustomerMergePlanInput = {
        ...base,
        survivorId: thirdId,
        loserId: survivorId,
        authority: 'operator_confirmed',
      }
      await mergeCustomers(uow, { ...MERGE_ARGS, plan: onward })
      expect(await mergeSurvivorOf(tx, loserId)).toBe(thirdId)

      // And an edge INTO a tombstone is refused, which is also why a cycle cannot be constructed.
      const intoTombstone: CustomerMergePlanInput = {
        ...onward,
        survivorId: loserId,
        loserId: thirdId,
      }
      const error = await raised(
        attempt(uow, (inner) => mergeCustomers(inner, { ...MERGE_ARGS, plan: intoTombstone })),
      )
      expect(mergeRefusalOf(error)).toBe('merge_survivor_is_a_tombstone')
    })
  })

  /*
    The registry entry for `flow_enrolment` says the enrolment moves with the contact. This is that
    sentence measured, and it exists because the entry was written at an integrating merge rather than by
    the unit that owns either table: C-AUTO-06 landed 0070 while C-CRM-05 was in another worktree, so the
    completeness case found a column nobody had an opinion about and nothing exercised the opinion taken.

    A row-level case rather than the arithmetic in `merge_record_table`: a table with no rows balances
    trivially, so the counts case is satisfied by a participant that moves nothing.
  */
  it('moves an automation enrolment onto the survivor, because a flow follows the contact', async () => {
    await probe(async ({ tx, uow }) => {
      // Inserted with SQL rather than through `publishFlowDefinition`, which takes a validator injected
      // from @berelax/core: what is under test is the participant, not the publish path.
      const [flow] = await tx<{ id: string }[]>`
        insert into flow (flow_key, title, created_by)
        values ('merge_itest_enrolment', 'A flow the merge suite enrols a losing record in', 'merge.itest.ts')
        returning id
      `
      const flowId = flow?.id ?? ''
      await tx`
        insert into flow_definition (flow_id, version, dsl_version, definition, published_by)
        values (
          ${flowId}::uuid, 1, 1,
          '{"dslVersion":1,"nodes":[{"id":"n1","kind":"exit","reason":"probe"}]}'::jsonb,
          'merge.itest.ts'
        )
      `
      const enrol = async (customerId: string): Promise<string> => {
        const [row] = await tx<{ id: string }[]>`
          insert into flow_enrolment (flow_id, definition_version, customer_id, created_by)
          values (${flowId}::uuid, 1, ${customerId}::uuid, 'merge.itest.ts')
          returning id
        `
        return row?.id ?? ''
      }
      const losers = await enrol(loserId)
      // The control, and it is the one that matters: "the loser's enrolment moved" is also true of a
      // statement that re-points every row in the table, and a third record's enrolment is how the two
      // are told apart.
      const untouched = await enrol(thirdId)

      const outcome = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      if (outcome.kind !== 'merged') throw new Error(outcome.kind)

      const owner = async (enrolmentId: string): Promise<string | undefined> => {
        const [row] = await tx<{ customerId: string }[]>`
          select customer_id as "customerId" from flow_enrolment where id = ${enrolmentId}::uuid
        `
        return row?.customerId
      }
      expect(await owner(losers), "the loser's enrolment now names the survivor").toBe(survivorId)
      expect(await owner(untouched), "a third record's enrolment is left alone").toBe(thirdId)

      // And the merge's own record says one row moved, so the count and the rows agree.
      const [counted] = await tx<{ moved: number; retained: number }[]>`
        select rows_moved as "moved", rows_retained_on_loser as "retained"
        from merge_record_table
        where merge_record_id = ${outcome.mergeRecordId}::uuid
          and participant = 'public.flow_enrolment'
      `
      expect(Number(counted?.moved), 'one enrolment moved').toBe(1)
      expect(Number(counted?.retained), 'none retained').toBe(0)
    })
  })
})

// ------------------------------------------------------------------------------------------------
// The record and the audit
// ------------------------------------------------------------------------------------------------

describe('the merge record', () => {
  it('holds one row per registered participant, with before and after counts that balance', async () => {
    await probe(async ({ tx, uow }) => {
      await grantMarketing(uow, survivorId, T1_ISO)
      await withdrawMarketing(uow, loserId, T2_ISO)
      const auditBefore = await auditCount(tx, MERGE_AUDIT_ACTIONS.merged)
      const outcome = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      if (outcome.kind !== 'merged') throw new Error(outcome.kind)

      // Exactly one audit row, measured as a delta: audit_event only grows (brief rule 12).
      expect((await auditCount(tx, MERGE_AUDIT_ACTIONS.merged)) - auditBefore).toBe(1)

      const record = await readMergeRecordForLoser(tx, loserId)
      expect(record?.survivorCustomerId).toBe(survivorId)
      expect(record?.authority).toBe('auto_merge')
      expect(record?.mergedAtIso).toBe(MERGED_AT_ISO)
      // The loser's discarded values are IN the record, so a merge that resolved a conflict is not
      // indistinguishable from one that found none.
      const resolutions = (record?.fieldResolutions ?? []) as readonly {
        field: string
        loserValue: unknown
      }[]
      expect(resolutions.find((field) => field.field === 'phoneE164')?.loserValue).toBe(LOSER.phone)
      expect(resolutions.map((field) => field.field)).toContain('displayName')

      const reports = await readMergeTableReports(tx, outcome.mergeRecordId)
      expect(reports.map((report) => report.participant).sort()).toEqual(
        MERGE_PARTICIPANTS.map(participantName).sort(),
      )
      for (const report of reports) {
        expect(report.rowsAfterLoser, `${report.participant}: after = before - moved`).toBe(
          report.rowsBeforeLoser - report.rowsMoved,
        )
        expect(
          report.rowsAfterSurvivor,
          `${report.participant}: after = before + moved + inserted`,
        ).toBe(report.rowsBeforeSurvivor + report.rowsMoved + report.rowsInserted)
      }
      // The consent report is the one that must show a COPY rather than a move.
      const consent = reports.find((report) => report.participant === 'public.consent')
      expect(consent?.strategy).toBe('repoint_insert')
      expect(consent?.rowsMoved).toBe(0)
      expect(consent?.rowsInserted).toBeGreaterThan(0)
    })
  })

  it('refuses UPDATE and DELETE on both tables, for the owner as well', async () => {
    await probe(async ({ tx, uow }) => {
      const outcome = await mergeCustomers(uow, { ...MERGE_ARGS, plan: await planned(tx) })
      if (outcome.kind !== 'merged') throw new Error(outcome.kind)
      const id = outcome.mergeRecordId
      // Each in its own savepoint: a refused statement aborts the transaction it is in, and the next
      // assertion would then measure 25P02 rather than the trigger.
      expect(
        await sqlstateOf(
          attempt(
            uow,
            (inner) => inner.sql`update merge_record set reason = 'edited' where id = ${id}`,
          ),
        ),
      ).toBe('ZT001')
      expect(
        await sqlstateOf(
          attempt(uow, (inner) => inner.sql`delete from merge_record where id = ${id}`),
        ),
      ).toBe('ZT001')
      expect(
        await sqlstateOf(
          attempt(
            uow,
            (inner) =>
              inner.sql`update merge_record_table set rows_moved = 99 where merge_record_id = ${id}`,
          ),
        ),
      ).toBe('ZT001')
      expect(
        await sqlstateOf(
          attempt(
            uow,
            (inner) => inner.sql`delete from merge_record_table where merge_record_id = ${id}`,
          ),
        ),
      ).toBe('ZT001')
      // The control: a SELECT on the same rows works, so the four refusals above are about the operation
      // and not about a row the probe cannot see.
      expect(
        await countOf(
          tx,
          tx<{ n: string }[]>`
            select count(*)::text as n from merge_record_table where merge_record_id = ${id}
          `,
        ),
      ).toBe(MERGE_PARTICIPANTS.length)
    })
  })

  it('accepts every agreement label @berelax/core declares, and nothing outside them', async () => {
    await probe(async ({ tx, uow }) => {
      // The pinning 0069's comment promises: the two CHECKs are a copy of core's vocabularies, and a
      // label added there without being added here would be a merge the database refuses to record.
      let serial = 0
      for (const phone of PHONE_AGREEMENTS) {
        for (const label of LABEL_AGREEMENTS) {
          serial += 1
          const loser = `00000000-0000-7000-8000-0000000${String(serial).padStart(5, '0')}`
          await tx`
            insert into merge_record (
              survivor_customer_id, loser_customer_id, merged_at, actor_kind, actor_label, authority,
              reason, score_per_mille, phone_agreement, label_agreement, field_resolutions
            ) values (
              ${survivorId}::uuid, ${loser}::uuid, ${MERGED_AT_ISO}::timestamptz, 'system',
              'Agreement vocabulary probe', 'operator_confirmed',
              'Pinning the agreement vocabulary against @berelax/core.', 500, ${phone}, ${label},
              '[]'::jsonb
            )
          `
        }
      }
      expect(serial).toBe(PHONE_AGREEMENTS.length * LABEL_AGREEMENTS.length)
      // And the control that makes the thirty inserts mean something: a label core does not declare is
      // refused by the CHECK rather than stored.
      expect(
        await sqlstateOf(
          attempt(
            uow,
            (inner) => inner.sql`
              insert into merge_record (
                survivor_customer_id, loser_customer_id, merged_at, actor_kind, actor_label, authority,
                reason, score_per_mille, phone_agreement, label_agreement, field_resolutions
              ) values (
                ${survivorId}::uuid, ${'00000000-0000-7000-8000-0000000fffff'}::uuid,
                ${MERGED_AT_ISO}::timestamptz, 'system', 'Agreement vocabulary probe',
                'operator_confirmed', 'A label core does not declare.', 500, 'nearly', 'identical',
                '[]'::jsonb
              )
            `,
          ),
        ),
      ).toBe('23514')
    })
  })
})

// ------------------------------------------------------------------------------------------------
// The two shapes that cross the package boundary
// ------------------------------------------------------------------------------------------------

describe('the db reads are what the pure plan takes', () => {
  it('is asserted structurally rather than described in a comment', async () => {
    const read = await readCustomerMergeSubject(sql, survivorId)
    if (read === null) throw new Error('the fixture survivor is missing')
    // `packages/db` may not import `packages/core`, so `CustomerMergeSubjectRead` is a second
    // declaration of `CustomerMergeSubject` and this is where the two are held together. `createdAt` is
    // a plain number there and a branded `Instant` here, which is why the cast is unavoidable and the
    // finiteness is asserted instead.
    expect(Number.isFinite(read.createdAt)).toBe(true)
    const asPure: CustomerMergeSubject = {
      ...read,
      createdAt: read.createdAt as Instant,
      phoneVerifiedAt: read.phoneVerifiedAt === null ? null : (read.phoneVerifiedAt as Instant),
    }
    expect(asPure.id).toBe(survivorId)

    // And the plan travels the other way. `satisfies` here is the assertion: a field the repository
    // requires and the planner stopped producing is a compile error on this line.
    const score = scoreDuplicatePair(
      { phone: SURVIVOR.phone, label: SURVIVOR.label },
      { phone: SURVIVOR.phone, label: SURVIVOR.label },
    )
    const other: CustomerMergeSubject = {
      ...asPure,
      id: loserId,
      createdAt: (asPure.createdAt + 1) as Instant,
    }
    const decision = planCustomerMerge(asPure, other, score, 'auto_merge')
    if (decision.kind !== 'plan') throw new Error(decision.refusal)
    const plan: CustomerMergePlan = decision
    expect(plan satisfies CustomerMergePlanInput).toBe(plan)
  })
})
