import { createHash } from 'node:crypto'
import {
  createPostgresClinicalKeyStore,
  generateKek,
  open as openSealed,
  seal,
} from '@berelax/clinical'
import {
  classifyErasureCoverage,
  decideRightsResponse,
  dueDateFor,
  ERASURE_ACTIONS,
  ERASURE_RULES,
  erasurePseudonym,
  type Instant,
  isRetainingAction,
  planClinicalErasure,
  resolveSuppression,
  type SuppressionLog,
  suppressionKeyNormaliser,
} from '@berelax/core'
import {
  type Actor,
  AuditWriter,
  assertRecipesMatchRules,
  beginRightsRequest,
  coveredTables,
  createConnection,
  type ErasureDeps,
  EXECUTION_RECIPES,
  ensureCustomer,
  eraseSubject,
  erasureCoverage,
  exportSubjectData,
  issueInvoice,
  MERGE_CATALOGUE_EXCLUDED_SCHEMAS,
  moveCard,
  overdueRightsRequests,
  publishEvent,
  RETAINING_ERASURE_ACTIONS,
  readSuppressionLogs,
  recordRightsRequest,
  type Sql,
  type SuppressionKeying,
  suppressionKey,
  type UnitOfWork,
  withUnitOfWork,
} from '@berelax/db'
import { CMS_SCHEMA } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_TRN, invoiceFixture } from './invoice.ts'
import { fixtureSuppressionPeppers } from './suppression.ts'
import { syntheticPerson } from './synthetic.ts'

/**
 * C-CRM-10 — the data-subject rights engine, the erasure/retention conflict, and the retention purge.
 *
 * `packages/fixtures` is the only package that may import both halves, and this unit needs it three times
 * over: the classification lives in `@berelax/core`, the catalogue probes and the statements live in
 * `@berelax/db`, and the proof that a destroyed key cannot be opened needs `@berelax/clinical`.
 *
 * ## The assertion this file exists to make honestly
 *
 * "Erasure worked" is the hardest claim in this repository to test, because a test that checks the rows it
 * knows about passes while the row it forgot is the whole defect. So the completeness case does NOT list
 * tables. It enumerates from `information_schema` through the five probes, classifies every column through
 * the rule registry, and fails on anything unaccounted for — and the KNOWN-BAD case creates a table with a
 * phone number in it inside a rolled-back transaction and asserts the probe finds it unclassified. A test
 * listing tables by hand is a test that will pass on the day somebody adds the twenty-fifth one.
 *
 * ## What is asserted through the GATE rather than by inspecting a table
 *
 * The suppression case resolves through `resolveSuppression` — the same fold the send path uses — because
 * the claim is "the send is refused", not "a row exists". A row can exist and be unreadable by the gate; a
 * gate can refuse for the wrong reason. Only the fold answers the question that matters.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind. So:
 * every fixture person here is in the 9_6xx block, which nothing else uses; every assertion is scoped to
 * those ids or those phone numbers; and the completeness case is order-independent because it reads the
 * catalogue rather than rows. The erasure cases each use their OWN subject, because an erasure is
 * irreversible and a second case sharing a subject would run against an already-erased record.
 *
 * Nothing here is a name: a record with no display name is labelled `Customer 0042` (ADR 0020), and the
 * phone numbers are on `+971 59`, which is not an allocated UAE mobile prefix.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ACTOR: Actor = { kind: 'staff', label: 'Manager (fixture)' }

/** Fixed instants, so nothing here depends on a wall clock and every deadline is readable. */
const RECEIVED_ISO = '2099-06-01T09:00:00.000Z'
const ERASED_ISO = '2099-06-02T09:00:00.000Z'
const SLA_DAYS = 30
const DUE_ISO = dueDateFor(new Date(RECEIVED_ISO), SLA_DAYS).toISOString()
/** One millisecond past the deadline: the boundary `isRightsRequestOverdue` is strict about. */
const PAST_DUE_ISO = new Date(new Date(DUE_ISO).getTime() + 1).toISOString()

const BACKUP_POSITION =
  'Row-level erasure does not reach a database backup. Backups are retained on their own schedule and ' +
  'age out; no individual row is removed from one. This position is provisional against Y1-entity.'
const REGIME = 'Federal PDPL assumed (provisional, Y1-entity)'
const OPEN_QUESTIONS = ['Y1-entity', 'Y1-licence', 'Y5-residency']

let sql: Sql
let keying: SuppressionKeying
let deps: ErasureDeps

/**
 * Each case gets its own subject, because an erasure cannot be undone.
 *
 * The suppression case's subject is drawn from a PER-RUN index, and that is not tidiness: a suppression is
 * keyed on an HMAC of the number and the list is append-only, so an entry written by an earlier run of this
 * file would still be there — and the case's whole precondition is that this person has NEVER opted out.
 * With a fixed number the case passed with the suppression write removed from the engine, which the gate
 * block's 112k found. The FIXED subjects live in `9_60x`, which is this file's own block; the two per-run
 * bands are above every index any fixture uses, for the reason set out at {@link SUPPRESSION_BAND}.
 */
const RUN_OFFSET = Date.now() % 300
/**
 * The two PER-RUN bands, chosen so they cannot collide with a fixed subject or with each other.
 *
 * The first draft used `9_700 + RUN_OFFSET` and `9_400 + RUN_OFFSET`, and both were latent flakes rather
 * than merely untidy. A 300-wide band starting at 9_400 covers 9_400..9_699, which contains this file's own
 * five fixed subjects AND the 9_4xx and 9_5xx subjects three other fixture files use — thirteen of the three
 * hundred offsets land on one of them, so about one run in twenty-three. The consequence is not a wrong
 * value, it is a nonsensical one: on offset 201 `mergedAway` IS `invoiced`, and the case inserts a
 * `merge_record` whose survivor is its own loser. `9_700 + RUN_OFFSET` collided with 9_700..9_706 the same
 * way, which would give the suppression case a subject another file may already have suppressed — and that
 * case's entire precondition is that this person has never opted out.
 *
 * So both bands start above every index any fixture uses (the highest is 9_706) and are separated by a gap
 * wider than the offset, which makes the disjointness arithmetic rather than a thing to remember.
 */
const SUPPRESSION_BAND = 10_300
const MERGED_AWAY_BAND = 10_700
const SUBJECTS = {
  invoiced: syntheticPerson(9_601),
  clinical: syntheticPerson(9_602),
  /** The app-role case's own subject: an erasure cannot be undone, so nothing else may use it. */
  appRole: syntheticPerson(9_603),
  suppression: syntheticPerson(SUPPRESSION_BAND + RUN_OFFSET),
  exportA: syntheticPerson(9_604),
  exportB: syntheticPerson(9_605),
  overdue: syntheticPerson(9_606),
  /** The credential case's own subject: an erasure cannot be undone, so nothing else may use it. */
  credential: syntheticPerson(9_607),
  /** The privileged-delete case's own subject, for the same reason. */
  workflow: syntheticPerson(9_608),
  /**
   * Merged INTO `invoiced`, to prove an erasure covers a tombstone's own phone number.
   *
   * Per-run like `suppression`, and for a sharper reason: `merge_record` is append-only for every role
   * (ZT005) and its `loser_customer_id` is UNIQUE, so a tombstone written by an earlier run cannot be
   * removed or re-pointed — and it names a survivor that run has since erased and `ensureCustomer` has
   * since replaced. The lineage from the new survivor then finds nothing, and the case reports a failure
   * about a defect that is not there. Gate case 112m found this.
   */
  mergedAway: syntheticPerson(MERGED_AWAY_BAND + RUN_OFFSET),
} as const

const ids: Record<keyof typeof SUBJECTS, string> = {} as never

async function ensure(person: { phone: string }): Promise<string> {
  return withUnitOfWork(sql, ACTOR, async (uow) => {
    const result = await ensureCustomer(uow, {
      phoneE164: person.phone,
      displayName: null,
      nameMatchKey: null,
      locale: 'en',
      createdVia: 'front_desk',
    })
    return result.customer.id
  })
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  keying = { peppers: fixtureSuppressionPeppers(process.env), normalise: suppressionKeyNormaliser }
  for (const key of Object.keys(SUBJECTS) as (keyof typeof SUBJECTS)[]) {
    ids[key] = await ensure(SUBJECTS[key])
  }
  // Close any request an earlier RUN of this file left open. `rights_request` refuses DELETE for every role
  // (ZY001), and `rights_request_one_open_per_subject_and_type` refuses a second open request of a type —
  // so without this the second run of the suite fails on a unique index, which is the worst kind of red:
  // green once, red for ever after, and about nothing. Closed through the real state machine
  // (`received -> refused`) rather than by editing the row, because that is the only transition the
  // database permits for a request nobody answered.
  await sql`
    update rights_request
       -- closed_at = received_at, not now(): rights_request_closed_after_received refuses a closing
       -- instant before the request, and these fixtures are dated 2099 so the wall clock is EARLIER than
       -- everything in them. The constraint catching that was the guard working: a request closed before
       -- it was made is exactly the incoherence it exists to refuse.
       set state = 'refused', closed_at = received_at
     where subject_customer_id = any (${Object.values(ids)}::uuid[])
       and closed_at is null and state = 'received'
  `
  deps = {
    classify: (probed) => classifyErasureCoverage(probed),
    pseudonymFor: erasurePseudonym,
    planClinical: planClinicalErasure,
    decideResponse: decideRightsResponse,
    keying,
  }
})

afterAll(async () => {
  /**
   * This file leaves NO invoice and no booking behind, and that is a convention rather than tidiness.
   *
   * `customer-identity.itest.ts` USED TO clear the table with a bare `delete from customer`, and
   * `invoice.customer_id` and `booking.customer_id` are both `ON DELETE RESTRICT` — so a single row of
   * either, left behind by any suite that runs earlier, turns all eleven of that file's cases red with a
   * foreign-key message that names neither this file nor the row. It happened: this suite's invoice fixture
   * and its two fixture bookings did exactly that on the first full `pnpm test:integration`, in a file this
   * unit never touched. `checkout-finalise.itest.ts` already carries this cleanup and its comment already
   * names `customer-identity.itest.ts` as the reason; this is that convention, followed.
   *
   * TRUNCATE and not DELETE for the invoice family: `invoice` refuses DELETE for every role including the
   * owner (ZI003, migration 0026) and `scripts/check-no-invoice-mutation.mjs` refuses the statement anywhere
   * in the tree, so truncate is the only legal removal. Every referencing table is NAMED rather than reached
   * with CASCADE, so the next table to reference `invoice` fails loudly here instead of having its rows
   * removed by a statement that never mentioned it.
   *
   * The pseudonymised customers themselves are LEFT, deliberately. An erasure cannot be undone and the
   * reachability invariant reads the whole table, so those rows are evidence; `ensureCustomer` creates a
   * fresh record for each fixture number on the next run because the erased row no longer holds it.
   */
  await sql?.unsafe(
    'truncate refund, checkout_finalisation, payment, invoice_appointment, invoice_line, invoice',
  )
  const subjectIds = Object.values(ids)
  if (sql !== undefined && subjectIds.length > 0) {
    await sql`delete from booking where customer_id = any (${subjectIds}::uuid[])`

    /**
     * This file's own clinical rows go too, and the reason is sharper than tidiness.
     *
     * `packages/clinical/src/crypto/rotation.itest.ts` asserts `countSealedOn(baseVersion) === 0` — a count
     * over the WHOLE estate, while its own `sweep` removes only rows carrying its id prefix. A
     * CRYPTO-ERASED row is never rotated, by design and by this unit's own gate case 112p: the KEK rotation
     * skips a destroyed key rather than re-wrapping zero bytes, and 0085 leaves `kek_version` unchanged so
     * the sealed-row trigger admits the write. So one committed crypto-erasure leaves one row on the base
     * version for ever, and that global assertion goes red in a file this unit never touched — which is
     * what happened. Sweeping by subject is rotation's own convention, applied here.
     *
     * Order matters and each step is a constraint rather than a preference: the contraindication flags
     * reference the submission (`source_submission_id`), and 0082's consent gate is a DEFERRED constraint
     * trigger, so the consents must go in the same transaction as the submissions they authorise or COMMIT
     * refuses. `clinical.dek_destruction` is deliberately NOT swept — it refuses DELETE for every role
     * including the owner (ZY005) — and it does not need to be: it holds no wrapped key, so it is invisible
     * to the count above, and it carries no foreign key that a swept submission would break.
     */
    await sql.begin(async (tx) => {
      await tx`
        delete from clinical.contraindication_flag where customer_id = any (${subjectIds}::uuid[])
      `
      await tx`delete from clinical.intake_submission where customer_id = any (${subjectIds}::uuid[])`
      await tx`delete from clinical.treatment_note where customer_id = any (${subjectIds}::uuid[])`
      await tx`delete from clinical.treatment_consent where customer_id = any (${subjectIds}::uuid[])`
    })
  }
  await sql?.end({ timeout: 5 })
})

/** Opens an erasure request and moves it to `in_progress`, which the clinical functions require. */
async function openErasure(uow: UnitOfWork, subjectCustomerId: string): Promise<string> {
  const request = await recordRightsRequest(uow, {
    requestType: 'erasure',
    subjectCustomerId,
    receivedAtIso: RECEIVED_ISO,
    slaDays: SLA_DAYS,
    dueAtIso: DUE_ISO,
    verifiedVia: 'otp',
    actorKind: 'customer',
    actorLabel: 'Customer (fixture, OTP verified)',
    requestDetail: 'Asked at the front desk for their record to be erased.',
  })
  await beginRightsRequest(uow, request.id)
  return request.id
}

const ERASURE_ARGS = {
  erasedAtIso: ERASED_ISO,
  supervisoryAuthority: null,
  backupPosition: BACKUP_POSITION,
  privacyRegime: REGIME,
  regimeIsProvisional: true,
  openQuestionIds: OPEN_QUESTIONS,
} as const

// ------------------------------------------------------------------------------------------------
// Completeness: enumerated from the catalogue, never from a list
// ------------------------------------------------------------------------------------------------

describe('erasure coverage', () => {
  it('accounts for every column the five probes find, by name', async () => {
    const probed = await erasureCoverage(sql)
    const coverage = classifyErasureCoverage(probed)
    // The whole point. If this fails, the message names the table somebody added and nobody classified.
    expect(
      coverage.unclassified.map((c) => `${c.schema}.${c.table}.${c.column} [${c.axes.join(',')}]`),
    ).toEqual([])
    // And nothing claims coverage it does not have: a rule for a table that no longer exists makes the
    // registry read as broader than it is.
    expect(coverage.staleRuleKeys).toEqual([])
    // The control for both: the catalogue must have produced a substantial number of columns. A probe that
    // returned nothing would satisfy both assertions above and prove nothing at all — which is exactly how
    // `pnpm boundaries` once reduced to zero modules while reporting success.
    expect(probed.length).toBeGreaterThan(80)
    expect(coverage.classified.length).toBe(probed.length)
  })

  it('enumerates no column of a schema this repository does not define', async () => {
    // G-REV-02 found this one: the probes enumerated `payload.cms_user.email`,
    // `payload.cms_user.reset_password_token` and three collection bodies, and `eraseSubject` then REFUSED
    // for want of a rule — but only on a database Payload had already booted against, because the schema is
    // empty until it does. The failure named five tables nobody had touched and moved with the file
    // ORDERING, since only an `apps/web` suite boots Payload.
    //
    // `CMS_SCHEMA` is excluded for the reason `MERGE_CATALOGUE_EXCLUDED_SCHEMAS` spells out. This asserts
    // it, and it is a real assertion rather than a tautology on any database an admin suite has run
    // against: remove the exclusion there and the probes return those five columns again.
    const probed = await erasureCoverage(sql)
    expect(probed.filter((column) => column.schema === CMS_SCHEMA)).toEqual([])
    expect(MERGE_CATALOGUE_EXCLUDED_SCHEMAS).toContain(CMS_SCHEMA)
    // The control: the exclusion is narrow. `public` is still enumerated in bulk, so this is not a probe
    // that has quietly stopped returning anything.
    expect(probed.filter((column) => column.schema === 'public').length).toBeGreaterThan(80)
  })

  it('finds every one of the five probes to be carrying its weight', async () => {
    const probed = await erasureCoverage(sql)
    const axes = new Map<string, number>()
    for (const column of probed) {
      for (const axis of column.axes) axes.set(axis, (axes.get(axis) ?? 0) + 1)
    }
    // Each probe must find something, or it is a predicate nobody is testing. The two that were added
    // after the others were written are the ones this most needs to hold for.
    for (const axis of [
      'customer_reference',
      'contact_detail',
      'foreign_key_child',
      'credential',
      'free_text_note',
    ]) {
      expect(axes.get(axis) ?? 0, axis).toBeGreaterThan(0)
    }
    // The four tables each probe exists BECAUSE of, asserted by name — these are the ones a single-axis
    // probe would have missed, and the reason the other four axes exist at all.
    const found = new Set(probed.map((c) => `${c.schema}.${c.table}.${c.column}`))
    expect(found).toContain('public.otp_challenge.phone_e164')
    expect(found).toContain('public.otp_phone_lock.phone_e164')
    expect(found).toContain('public.message.recipient')
    expect(found).toContain('public.booking_manage_grant.token_sha256')
    expect(found).toContain('public.customer.notes')
    // And the one the fifth probe would have found if its "subject table" definition were wrong: `customer`
    // has no `customer_id` column of its own, so it is only a subject table because it is named as one.
    expect(found).toContain('public.customer.phone_e164')
  })

  it('returns the SAME catalogue for the application role as for the owner', async () => {
    // The probe must not depend on who is asking, and it DID. `information_schema` is filtered to what the
    // current role holds a privilege on, and 0009 revokes every privilege on the `clinical` schema from
    // `berelax_app` — so an erasure run by the application enumerated ZERO clinical columns and then
    // reported a complete, balanced, fully-accounted erasure over a catalogue missing five tables. That is
    // this unit's defining failure arriving through privileges rather than through a forgotten rule, and
    // nothing in this file could have seen it: the suite connects as the OWNER, so the probe always
    // returned everything. The probe now reads `pg_catalog`, which is not privilege-filtered.
    const key = (c: { schema: string; table: string; column: string }) =>
      `${c.schema}.${c.table}.${c.column}`
    const asOwner = (await erasureCoverage(sql)).map(key).sort()
    let asApp: string[] = []
    await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      asApp = (await erasureCoverage(tx as unknown as Sql)).map(key).sort()
    })
    expect(asApp).toEqual(asOwner)
    // The controls. An empty catalogue would satisfy the equality, and so would one that had lost only the
    // schema this is about — which is precisely what it lost before.
    expect(asApp.length).toBeGreaterThan(80)
    expect(asApp.filter((k) => k.startsWith('clinical.')).length).toBeGreaterThan(4)
  })

  it('does NOT enumerate the audit partitions, which would break this suite every month', async () => {
    const probed = await erasureCoverage(sql)
    const partitions = probed.filter((c) => /^audit_event_\d{4}_\d{2}$/.test(c.table))
    expect(partitions).toEqual([])
    // The control: the PARENT is enumerated, so the exclusion is of partitions specifically and not of the
    // whole table. Without this, a probe that dropped `audit_event` entirely would pass.
    expect(probed.some((c) => c.table === 'audit_event' && c.column === 'ip_address')).toBe(true)
  })

  it('reports a table nobody classified — the known-bad case', async () => {
    // Created inside a transaction that is rolled back, so the catalogue is unchanged afterwards. It is a
    // real table while the transaction is open, which is what makes the probe see it: a fixture the probe
    // could not see would prove nothing.
    await expect(
      sql
        .begin(async (tx) => {
          await tx`
            create table __gate_fixture_unregistered (
              id uuid primary key default uuid_generate_v7(),
              customer_id uuid not null,
              phone_e164 text not null
            )
          `
          const probed = await erasureCoverage(tx as unknown as Sql)
          const coverage = classifyErasureCoverage(probed)
          const names = coverage.unclassified.map((c) => `${c.table}.${c.column}`)
          expect(names).toContain('__gate_fixture_unregistered.customer_id')
          expect(names).toContain('__gate_fixture_unregistered.phone_e164')
          // And the engine REFUSES rather than erasing part of the person: stronger than a failing test,
          // because it holds in production on the day a migration's classification is lost in a merge.
          //
          // The unit of work is built over the TRANSACTION HANDLE rather than through `withUnitOfWork`,
          // which calls `sql.begin` — and a postgres.js transaction handle has no `begin`. Nesting would be
          // wrong here anyway: the whole point is that the fixture table and the refusal share one
          // transaction, so the table is visible to the probe and nothing is left behind.
          const inner = tx as unknown as Sql
          const uow: UnitOfWork = {
            sql: inner,
            audit: new AuditWriter(inner, ACTOR),
            publish: (event) => publishEvent(inner, event),
          }
          const requestId = await openErasure(uow, ids.overdue)
          await expect(
            eraseSubject(uow, deps, { ...ERASURE_ARGS, rightsRequestId: requestId }),
          ).rejects.toThrow(/erasure cannot say what it did|no erasure rule classifies/i)
          throw new Error('rollback the fixture table')
        })
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'rollback the fixture table') {
            return 'rolled back'
          }
          throw error
        }),
    ).resolves.toBe('rolled back')

    // The table is gone, and the coverage is complete again — so the case left nothing behind.
    const after = classifyErasureCoverage(await erasureCoverage(sql))
    expect(after.unclassified).toEqual([])
  })

  it('holds the rule registry and the statements that carry it out equal, in both directions', async () => {
    const probed = await erasureCoverage(sql)
    const coverage = classifyErasureCoverage(probed)
    // Does not throw. A rule that acts with no statement reports its rows as acted on while changing
    // nothing, and a statement for a rule that does not act would act where the policy said not to.
    expect(() => assertRecipesMatchRules(coverage.classified.map((c) => c.rule))).not.toThrow()
    // The control: a rule set claiming to act on a table with no recipe must be REFUSED, or the assertion
    // above is a function that never throws.
    expect(() =>
      assertRecipesMatchRules([
        ...coverage.classified.map((c) => c.rule),
        { key: 'public.a_table_nobody_wired.customer_id', action: 'delete_row' },
      ]),
    ).toThrow(/no statement/i)
    expect(EXECUTION_RECIPES.length).toBeGreaterThan(15)
  })

  it('holds the two spellings of "which actions retain" equal across the package boundary', () => {
    // `packages/db` may not import `packages/core`, so the list exists twice — and `packages/fixtures` is
    // the one package that can hold them equal. The defect this catches is not hypothetical: the two
    // disagreeing is what made an erasure count `inherits_parent` as a retention, demand a reason for data
    // that is not there, and roll the whole operation back with a constraint name pointing at nothing.
    const fromCore = ERASURE_ACTIONS.filter((action) => isRetainingAction(action))
    expect([...RETAINING_ERASURE_ACTIONS].sort()).toEqual([...fromCore].sort())
    // The control: the lists are non-empty and do NOT contain an acting action, so the equality above is
    // not two empty arrays agreeing.
    expect(fromCore.length).toBeGreaterThan(3)
    expect(RETAINING_ERASURE_ACTIONS).not.toContain('delete_row')
    expect(RETAINING_ERASURE_ACTIONS).not.toContain('inherits_parent')
  })

  it('gives every retaining rule a reason, which is the sentence a subject is entitled to', async () => {
    const coverage = classifyErasureCoverage(await erasureCoverage(sql))
    const retaining = coverage.classified.filter((c) => isRetainingAction(c.rule.action as never))
    expect(retaining.length).toBeGreaterThan(5)
    for (const entry of retaining) {
      expect(entry.rule.why.length, entry.rule.key).toBeGreaterThan(40)
    }
  })
})

// ------------------------------------------------------------------------------------------------
// The erasure itself
// ------------------------------------------------------------------------------------------------

/**
 * A hash over every column of every row of the document and its lines.
 *
 * `md5(i::text)` over the WHOLE row rather than a column list, for the reason 0043's sealed-row trigger
 * compares `to_jsonb(new)` to `to_jsonb(old)`: a column added by a later migration is covered the day it
 * appears rather than the day somebody remembers to add it here. A hash built from a column list would go
 * on passing while an erasure quietly edited the column nobody named.
 *
 * The JOURNAL ENTRIES the acceptance line also names are asserted separately and structurally, in
 * `the ledger is unreachable from an erasure` below. `issueInvoice` does not post to the ledger — that is
 * `finaliseCheckout`'s job through `checkout_finalisation.journal_entry_id` — and `invoice` carries no
 * `journal_entry_id` column at all. Hashing a journal entry this test had posted by hand would be hashing
 * a row this unit fabricated, which proves nothing about the real one; the catalogue claim below is the
 * stronger statement and it holds for every journal entry that will ever exist.
 */
async function documentRowHashes(customerId: string): Promise<readonly string[]> {
  const rows = await sql<{ h: string }[]>`
    select md5(i::text) as h from invoice i where i.customer_id = ${customerId}::uuid
    union all
    select md5(l::text) from invoice_line l
      join invoice i on i.id = l.invoice_id
     where i.customer_id = ${customerId}::uuid
    order by 1
  `
  return rows.map((r) => r.h)
}

describe('the ledger', () => {
  it('is unreachable from an erasure, because no journal table holds a customer reference', async () => {
    const probed = await erasureCoverage(sql)
    const ledgerColumns = probed.filter(
      (c) => c.table === 'journal_entry' || c.table === 'journal_line',
    )
    // Not "the erasure chose not to touch the ledger" — it CANNOT. The five probes are every way this
    // engine can find a person, and they find nothing on either journal table, so no rule exists for one
    // and no statement can name one. This is what makes "the journal entries are byte-identical" true for
    // every entry that will ever be posted rather than for the rows a fixture happened to create.
    expect(ledgerColumns).toEqual([])
    // The control: the tables EXIST, so the assertion above is about their shape and not about a typo in
    // two table names.
    const [exists] = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_name in ('journal_entry', 'journal_line')
    `
    expect(Number(exists?.n)).toBe(2)
    // And the one row that DOES join a customer to a ledger entry is retained with its reason:
    // `checkout_finalisation` carries both `customer_id` and `journal_entry_id`, and 0063 revokes UPDATE
    // and DELETE on it from the application role.
    const checkout = probed.find(
      (c) => c.table === 'checkout_finalisation' && c.column === 'customer_id',
    )
    expect(checkout).toBeDefined()
    expect(ERASURE_RULES.get('public.checkout_finalisation.customer_id')?.action).toBe(
      'retain_statutory',
    )
  })
})

describe('erasing a customer who holds an issued invoice', () => {
  it('leaves the invoice byte-identical, pseudonymises the identity, and records the conflict', async () => {
    const customerId = ids.invoiced

    // A REAL issued invoice, through `issueInvoice` and this package's own `invoiceFixture` — not a
    // hand-built row. Two reasons, and the second is the one that matters:
    //
    //   - the document's lines, totals and tax point come from `@berelax/core`, so nothing about it is
    //     invented and `invoice_totals_match_lines` (a deferred constraint trigger, ZI001) is satisfied by
    //     construction rather than by numbers chosen to match;
    //   - the issuer TRN is `FIXTURE_TRN`, which already exists in this package with its reason written
    //     down. `legal_entity.trn` holds `TRN-PENDING-Y1-TRN` and `invoice_issuer_trn_is_fifteen_digits`
    //     refuses it, so **no invoice can be issued at all until the real TRN is configured** — which is
    //     the system working as designed (brief rule 15: a plausible TRN is worse than a blank one) and is
    //     why the `invoice` table is EMPTY after `pnpm seed` despite the seeder reporting 188 of them. A
    //     second fifteen-digit literal here would be a second invented TRN in the repository, so the one
    //     that already exists is reused.
    const fixture = invoiceFixture({
      customerId,
      supplyAt: Date.parse('2099-05-30T14:00:00.000Z') as Instant,
      issuedAt: Date.parse('2099-05-30T20:00:00.000Z') as Instant,
    })
    const issued = await withUnitOfWork(sql, ACTOR, (uow) => issueInvoice(uow, fixture.input))
    expect(issued.lines.length).toBeGreaterThan(0)
    // The issuer TRN reached the document, which is what makes this a document the FTA obligation
    // attaches to rather than a row shaped like one.
    expect(issued.issuerTrn).toBe(FIXTURE_TRN)

    const before = await documentRowHashes(customerId)
    expect(before.length).toBeGreaterThan(0)

    // A second record MERGED INTO this one, so the erasure has a tombstone to cover. A merge leaves the
    // loser's `customer` row in place (0069) and that row still holds its own live phone number, so an
    // erasure naming only the survivor leaves the person reachable through a row the request never
    // mentioned. The tombstone is written directly rather than through `mergeCustomers`, because what this
    // case needs is the `merge_record` row the lineage walks and not a full merge's re-pointing.
    await sql`
      insert into merge_record (survivor_customer_id, loser_customer_id, merged_at, actor_kind,
                                actor_label, authority, reason, score_per_mille, phone_agreement,
                                label_agreement, field_resolutions)
      values (${customerId}::uuid, ${ids.mergedAway}::uuid, ${RECEIVED_ISO}::timestamptz, 'staff',
              'Manager (fixture)', 'operator_confirmed',
              'One person, two records: the same handset was entered twice at the front desk.',
              960, 'identical', 'identical', '[]'::jsonb)
      on conflict (loser_customer_id) do nothing
    `

    const report = await withUnitOfWork(sql, ACTOR, async (uow) => {
      const requestId = await openErasure(uow, customerId)
      return eraseSubject(uow, deps, { ...ERASURE_ARGS, rightsRequestId: requestId })
    })

    // 0. The tombstone is erased too, and its own number no longer resolves. This is the assertion that
    //    catches an erasure which walks no lineage: everything else about such an erasure looks complete.
    expect(report.erasedCustomerIds).toContain(ids.mergedAway)
    const [tombstone] = await sql<{ phone: string; erasedAt: Date | null }[]>`
      select phone_e164 as phone, erased_at as "erasedAt" from customer
       where id = ${ids.mergedAway}::uuid
    `
    expect(tombstone?.phone).toBe(erasurePseudonym(ids.mergedAway))
    expect(tombstone?.erasedAt).not.toBeNull()
    const byMergedPhone = await sql`
      select id from customer where phone_e164 = ${SUBJECTS.mergedAway.phone}
    `
    expect(byMergedPhone).toHaveLength(0)

    // 1. The invoice is untouched, byte for byte.
    expect(await documentRowHashes(customerId)).toEqual(before)

    // 2. The CRM identity is a pseudonym, and the record is marked erased. The database refuses one
    //    without the other (`customer_erasure_and_pseudonym_agree`), so this is one fact read twice.
    const [identity] = await sql<{ phone: string; erasedAt: Date | null; matchKey: string }[]>`
      select phone_e164 as phone, erased_at as "erasedAt", phone_match_key as "matchKey"
        from customer where id = ${customerId}::uuid
    `
    expect(identity?.phone).toBe(erasurePseudonym(customerId))
    expect(identity?.erasedAt).not.toBeNull()
    // The match key derived to nothing, so the record can never surface as a merge candidate.
    expect(identity?.matchKey).toBe('')
    // The control: the original number is no longer anywhere on the row, and no lookup by it resolves.
    const byPhone = await sql`select id from customer where phone_e164 = ${SUBJECTS.invoiced.phone}`
    expect(byPhone).toHaveLength(0)

    // 3. The resolution names what was retained, the statutory basis and the profile that decided it.
    const [resolution] = await sql<
      {
        pseudonym: string
        regime: string
        provisional: boolean
        openQuestions: string[]
        backupPosition: string
        responseIssued: boolean
        withheld: string | null
        profileVersion: number
      }[]
    >`
      select pseudonym, privacy_regime as regime, regime_is_provisional as provisional,
             open_question_ids as "openQuestions", backup_position as "backupPosition",
             response_issued as "responseIssued", response_withheld_reason as withheld,
             regulatory_profile_version as "profileVersion"
        from rights_resolution where id = ${report.resolutionId}::uuid
    `
    expect(resolution?.pseudonym).toBe(erasurePseudonym(customerId))
    expect(resolution?.provisional).toBe(true)
    expect(resolution?.openQuestions).toContain('Y1-entity')
    expect(resolution?.backupPosition).toContain('does not reach a database backup')
    // The written response is WITHHELD, because no supervisory authority is recorded. The work was still
    // done — everything above happened — and the letter that would name a regulator was not produced.
    expect(resolution?.responseIssued).toBe(false)
    expect(resolution?.withheld).toBe('rights_response_authority_absent')
    expect(resolution?.profileVersion).toBeGreaterThan(0)

    // 4. The per-class accounting names the retained tables and gives each one its reason and its years.
    const classes = await sql<
      {
        participant: string
        columnName: string
        dataClass: string
        action: string
        rowsBefore: number
        rowsActed: number
        rowsRetained: number
        retainedReason: string | null
        obligationColumn: string | null
        obligationYears: number | null
      }[]
    >`
      select participant, column_name as "columnName", data_class as "dataClass", action,
             rows_before as "rowsBefore", rows_acted as "rowsActed", rows_retained as "rowsRetained",
             retained_reason as "retainedReason", obligation_column as "obligationColumn",
             obligation_years as "obligationYears"
        from rights_resolution_class where rights_resolution_id = ${report.resolutionId}::uuid
    `
    // Every line balances, which is the constraint the database holds and the claim of the whole table.
    for (const line of classes) {
      expect(line.rowsBefore, `${line.participant}.${line.columnName}`).toBe(
        line.rowsActed + line.rowsRetained,
      )
    }
    const lineFor = (participant: string, column: string) =>
      classes.find((c) => c.participant === participant && c.columnName === column)

    // Asserted PER COLUMN, not per table, and the reason is a defect this caught: `public.invoice` has six
    // probed columns under three different rules, and an executor that attributed the rule by TABLE wrote
    // every line with whichever one it looked up last — so the resolution said the issuer's own telephone
    // number was retained under the FTA obligation.
    for (const column of ['customer_id', 'customer_phone', 'customer_name_snapshot']) {
      const line = lineFor('public.invoice', column)
      expect(line, `public.invoice.${column}`).toBeDefined()
      expect(line?.action, column).toBe('retain_statutory')
      expect(line?.rowsRetained, column).toBeGreaterThan(0)
      // The sentence a data subject is entitled to be given, on the row rather than in a comment.
      expect(line?.retainedReason, column).not.toBeNull()
      // The figure comes from the profile and the COLUMN it came from is NAMED, so the years cannot go
      // stale against a later profile and nobody has to guess where 5 came from.
      expect(line?.obligationColumn, column).toBe('financial_retention_years')
      expect(line?.obligationYears, column).toBeGreaterThan(0)
    }

    // The control, and it is the one that catches the by-table attribution: the SALON's own number on its
    // own invoice is not customer data, carries no obligation and carries no retained reason. If the rule
    // were looked up by TABLE, this line would take whichever of `public.invoice`'s six rules the lookup
    // reached first — and the resolution would record the issuer's own telephone number as financial data
    // retained under the FTA obligation.
    const issuer = lineFor('public.invoice', 'issuer_phone')
    expect(issuer?.action).toBe('not_customer_data')
    expect(issuer?.dataClass).toBe('not_customer_data')
    expect(issuer?.obligationColumn).toBeNull()
    // And the data class of a CUSTOMER column on the same table is the other one, so the two cannot both
    // be satisfied by a lookup that ignores the column.
    expect(lineFor('public.invoice', 'customer_phone')?.dataClass).toBe('financial')

    // The retained reasons are the columns' OWN, not one reason repeated across the table. The phrase below
    // appears in exactly one rule in the registry — the one that states plainly that a completed erasure
    // leaves a readable number on a tax invoice — so finding it on the right line is what proves the
    // attribution is per column.
    expect(lineFor('public.invoice', 'customer_phone')?.retainedReason).toContain(
      'Your telephone number stays on any tax invoice',
    )
    expect(lineFor('public.invoice', 'customer_id')?.retainedReason).not.toContain(
      'Your telephone number stays on any tax invoice',
    )
    // And the reason on the row is the SUBJECT-facing one, not the maintainer's. The maintainer's prose for
    // this column contains a phrase that could not be stored at all — `is_placeholder_text` refuses text
    // containing `unknown` and eight other markers — so this assertion is what keeps the two apart.
    expect(lineFor('public.invoice', 'customer_phone')?.retainedReason).not.toContain('docs/04')

    // And the two retentions whose basis is NOT statutory carry their own kind, so the three
    // justifications cannot be read as one.
    expect(lineFor('public.suppression', 'key_hmac')?.action).toBe('retain_for_subject')
    expect(lineFor('public.consent', 'contact_customer_id')?.action).toBe('retain_append_only')

    // 4b. EVERY TABLE THE CATALOGUE ENUMERATES IS IN THIS RESOLUTION, BY NAME.
    //
    //     This is the assertion the unit exists for, and it is made the way `merge.itest.ts` makes its
    //     own: the expected set is enumerated FROM `information_schema` at the moment of the assertion,
    //     never written down here. A test listing the tables by hand passes on the day somebody adds the
    //     next one, which is the entire failure mode of an erasure engine — and "somebody adds a table" is
    //     not hypothetical, it is what every remaining unit in this build does.
    //
    //     It caught two tables on the day it was written. `clinical.treatment_consent` and
    //     `clinical.dek_destruction` are both classified and both RETAINED, and the engine emitted no line
    //     for either: fifty-two tables are covered and fifty were reported. Both are things a data subject
    //     is entitled to be TOLD are being kept — the record that they consented, and the record that
    //     their health data was destroyed — so the two omissions were in the worst possible place, and
    //     nothing else in this file would ever have noticed. The column-level coverage case above passes
    //     either way: it proves the RULE REGISTRY is complete, which is a different claim from the one
    //     this makes, that a COMPLETED ERASURE accounted for what the registry classified.
    const covered = coveredTables(await erasureCoverage(sql))
    const accounted = new Set(classes.map((c) => c.participant))
    expect([...covered].filter((table) => !accounted.has(table))).toEqual([])
    // The control, in both directions. A resolution that reported on nothing would satisfy the line above,
    // and so would a catalogue that enumerated nothing.
    expect(covered.length).toBeGreaterThan(40)
    expect(accounted.size).toBe(covered.length)
    // And nothing was reported that the catalogue does not hold: a line for a table nobody enumerated is a
    // participant name somebody typed, and it would make the accounting read as broader than it is.
    expect([...accounted].filter((table) => !covered.includes(table))).toEqual([])
    // The two the assertion above caught, named individually so a regression says which one went.
    expect(accounted).toContain('clinical.treatment_consent')
    expect(accounted).toContain('clinical.dek_destruction')
    // And each carries its OWN subject reason rather than the clinical decision's sentence: the decision is
    // about the payload, and "your health information is kept for N years" is untrue of a consent record
    // holding a wording hash and the opposite of true of the log that records the destruction.
    const consentLine = lineFor('clinical.treatment_consent', 'customer_id')
    expect(consentLine?.action).toBe('retain_statutory')
    expect(consentLine?.obligationColumn).toBe('clinical_retention_years')
    const destructionLine = lineFor('clinical.dek_destruction', 'customer_id')
    expect(destructionLine?.action).toBe('retain_append_only')
    expect(destructionLine?.obligationColumn).toBeNull()

    // 5. And the request is `partially_completed` rather than `completed`, because something was retained.
    //    Telling a subject their record was fully erased while a tax document still names them would be
    //    the engine saying something untrue.
    expect(report.state).toBe('partially_completed')
    const [request] = await sql<{ state: string; closedAt: Date | null }[]>`
      select state, closed_at as "closedAt" from rights_request
       where subject_customer_id = ${customerId}::uuid and request_type = 'erasure'
    `
    expect(request?.state).toBe('partially_completed')
    expect(request?.closedAt).not.toBeNull()
  }, 30_000)
})

describe('the reachability invariant', () => {
  it('leaves no record marked erased while it still holds a real phone number', async () => {
    // Over the WHOLE table, not over this file's own subjects, and that is the point: this is the one
    // thing that must never be true of any record in the database, and it is the sentence
    // `customer_erasure_and_pseudonym_agree` exists to make impossible. The test is here as well as the
    // constraint because a constraint can be dropped, and gate case 112r drops it — which is the only way
    // to see this assertion fail, and therefore the only way to know it is an assertion at all.
    const reachable = await sql<{ id: string }[]>`
      select id from customer
       where erased_at is not null and phone_e164 !~ '^erased-[a-p]{32}$'
    `
    expect(reachable.map((row) => row.id)).toEqual([])
    // The mirror, and it is a different defect: a record CARRYING the pseudonym with no erasure marker
    // reads as a live customer whose number happens to be unusable, so it appears in every list and
    // somebody tries to ring it.
    const unmarked = await sql<{ id: string }[]>`
      select id from customer
       where erased_at is null and phone_e164 ~ '^erased-[a-p]{32}$'
    `
    expect(unmarked.map((row) => row.id)).toEqual([])
    // The control: some record IS erased by now, so the two assertions above are about a population that
    // exists. Over an empty set they would both hold and prove nothing.
    const [erased] = await sql<{ n: number }[]>`
      select count(*)::int as n from customer where erased_at is not null
    `
    expect(Number(erased?.n)).toBeGreaterThan(0)
  })
})

describe('the rows the application role may not delete directly', () => {
  /**
   * A pipeline card goes, although `berelax_app` holds no DELETE on that table.
   *
   * 0070 (`flow_enrolment`) and 0077 (`customer_pipeline_card`) each revoke DELETE from the application
   * role, and each gives the same reason: *"DELETE has no legitimate caller; the cascade from `customer`
   * still works."* The premise does not hold for an erasure — it cannot delete the `customer` row, because
   * a retained tax invoice references it — so the cascade never runs and the direct statement raises
   * `permission denied` for the role the engine actually runs as. Both go through
   * `public.erase_customer_workflow_rows`, which is SECURITY DEFINER and gated on an in-progress erasure
   * request.
   *
   * Asserted on the CARD and not on the enrolment because `flow_enrolment` needs a `flow_definition` and
   * the seed creates none, while the two share one function, one gate and one call site — the branch is
   * chosen by a parameter this test would only be re-proving. What is specific to each table is the
   * `delete` statement, and `recipeRegistry` refuses a `definer` recipe naming any other table at module
   * load.
   *
   * This case runs as the OWNER, so it proves the route's EFFECT. That the route is necessary at all is
   * proved by the app-role case at the end of this file, and gate case 112y removes the route and watches
   * that case fail.
   */
  it('deletes the card through the definer function and leaves another customer\u2019s card alone', async () => {
    const customerId = ids.workflow
    const [stage] = await sql<{ stageKey: string }[]>`
      select stage_key as "stageKey" from pipeline_stage order by stage_key limit 1
    `
    if (stage === undefined)
      throw new Error('the seed created no pipeline stage for this case to use')
    // Through `moveCard` and not a raw insert, because 0077 carries a deferred constraint trigger that
    // refuses a card whose stage changed with no `pipeline_stage_transition` recording the move — "a stage
    // is a claim somebody made about a person, so the claim and its record are one transaction". A raw
    // insert here failed at COMMIT with exactly that message, which is the guard working. Using the real
    // path also means the card arrives the way a card arrives, with its transition, and the transition is
    // itself a classified participant this erasure has to account for.
    // Only where the card is not ALREADY on that stage, and that is re-runnability rather than caution.
    // `ids.overdue` is a fixed subject this file never erases, so its card survives the run — and `moveCard`
    // refuses a move whose `from` and `to` are the same column, correctly, because a transition recording a
    // move to where the card already is records nothing. The first draft moved both unconditionally and was
    // green once and red for ever after, which is the failure mode this file's own header warns about.
    for (const id of [customerId, ids.overdue]) {
      const [card] = await sql<{ stageKey: string }[]>`
        select stage_key as "stageKey" from customer_pipeline_card where customer_id = ${id}::uuid
      `
      if (card?.stageKey === stage.stageKey) continue
      await withUnitOfWork(sql, ACTOR, (uow) =>
        moveCard(uow, {
          customerId: id,
          toStageKey: stage.stageKey,
          actor: ACTOR,
          at: new Date(RECEIVED_ISO),
        }),
      )
    }
    const carded = async (id: string): Promise<number> => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from customer_pipeline_card where customer_id = ${id}::uuid
      `
      return Number(row?.n ?? 0)
    }
    // The precondition, asserted: without it the case passes against an engine that deletes nothing.
    expect(await carded(customerId)).toBe(1)
    expect(await carded(ids.overdue)).toBe(1)

    const report = await withUnitOfWork(sql, ACTOR, async (uow) => {
      const requestId = await openErasure(uow, customerId)
      return eraseSubject(uow, deps, { ...ERASURE_ARGS, rightsRequestId: requestId })
    })

    expect(await carded(customerId)).toBe(0)
    // The control, and it is what says the function is scoped to one customer rather than clearing a board:
    // it takes a customer id, not a predicate, and there is no variant that takes one.
    expect(await carded(ids.overdue)).toBe(1)

    // And it is accounted for, as an acting line with a count — not as a table the report forgot.
    const [line] = await sql<{ action: string; rowsActed: number; rowsRetained: number }[]>`
      select action, rows_acted as "rowsActed", rows_retained as "rowsRetained"
        from rights_resolution_class
       where rights_resolution_id = ${report.resolutionId}::uuid
         and participant = 'public.customer_pipeline_card'
    `
    expect(line?.action).toBe('delete_row')
    expect(line?.rowsActed).toBe(1)
    expect(line?.rowsRetained).toBe(0)
  }, 30_000)

  it('refuses to delete a workflow row without an in-progress erasure request naming that customer', async () => {
    // The gate, on its own. The privilege is only half of what makes a SECURITY DEFINER delete safe: the
    // other half is that it will not act without a request that says who asked and how they were verified.
    await expect(
      sql`
        select public.erase_customer_workflow_rows(${ids.overdue}::uuid,
          '00000000-0000-7000-8000-000000000000'::uuid, 'customer_pipeline_card')
      `,
    ).rejects.toThrow(/ErasureWorkflowRemovalNotAuthorised/)
    // And the target is a branch selector, not an identifier it will interpolate.
    await expect(
      sql`
        select public.erase_customer_workflow_rows(${ids.overdue}::uuid,
          '00000000-0000-7000-8000-000000000000'::uuid, 'customer')
      `,
    ).rejects.toThrow(/ErasureWorkflowRemovalNotAuthorised|ErasureWorkflowTargetUnknown/)
    // The control: the card this did NOT delete is still there, so the refusals refused rather than
    // silently doing nothing.
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from customer_pipeline_card where customer_id = ${ids.overdue}::uuid
    `
    expect(Number(row?.n)).toBe(1)
  })
})

describe('the credential class, which no other assertion in this file reached', () => {
  /**
   * A live booking-manage token stops working, and a stranger's does not.
   *
   * This case exists because the credential class was the one class with a rule, a recipe, a probe and a
   * gate case and NO end-to-end assertion. `booking_manage_grant.token_sha256` is the column probe 4 was
   * written for — a bearer token that lets whoever holds the link view and cancel a booking, on a table
   * with no customer id, no contact detail and no foreign key to `booking` — and the only thing asserted
   * about it was that the probe FINDS it. Whether an erasure actually stopped the link working was never
   * checked, and it did not: the recipe issued an UPDATE on a table 0067 revokes UPDATE on from
   * `berelax_app` in so many words, so the statement raised `permission denied` the first time the engine
   * ran as the application role. Both halves — a rule with no consequence, and a consequence the
   * application role could not carry out — were invisible because this assertion was missing.
   *
   * The CONTROL is the half that matters as much: another customer's grant on another customer's booking
   * must survive. A delete with a wrong or absent subject predicate destroys every live link in the salon,
   * and it would satisfy the first assertion perfectly.
   */
  it('deletes the subject\u2019s live booking-manage token and leaves a stranger\u2019s alone', async () => {
    const customerId = ids.credential
    // Two bookings and two grants: one of the subject's, one of an unrelated customer's. `booking` is
    // customer_id plus a source, and `booking_manage_grant.booking_id` carries NO foreign key (0067, so
    // that four suites may truncate `booking` by an explicit list) — but the recipe reaches the subject
    // THROUGH `booking`, so both bookings have to be real rows.
    const [mine] = await sql<{ id: string }[]>`
      insert into booking (customer_id, source) values (${customerId}::uuid, 'front_desk') returning id
    `
    const [theirs] = await sql<{ id: string }[]>`
      insert into booking (customer_id, source) values (${ids.overdue}::uuid, 'front_desk') returning id
    `
    if (mine === undefined || theirs === undefined)
      throw new Error('the fixture bookings were not created')
    // Digests, not tokens — the column is `^[a-f0-9]{64}$` and holds the sha256 of a token this test never
    // needs to possess. Derived from the booking id so two runs cannot collide on the unique index.
    const digest = (seed: string) =>
      createHash('sha256').update(`C-CRM-10 credential case ${seed}`).digest('hex')
    for (const [bookingId, seed] of [
      [mine.id, `mine ${mine.id}`],
      [theirs.id, `theirs ${theirs.id}`],
    ] as const) {
      await sql`
        insert into booking_manage_grant (token_sha256, booking_id, purpose, issued_at, expires_at)
        values (${digest(seed)}, ${bookingId}::uuid, 'manage_booking',
                ${RECEIVED_ISO}::timestamptz, ${RECEIVED_ISO}::timestamptz + interval '30 days')
      `
    }
    const live = async (bookingId: string): Promise<number> => {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from booking_manage_grant where booking_id = ${bookingId}::uuid
      `
      return Number(row?.n ?? 0)
    }
    // The precondition, asserted rather than assumed: both links exist BEFORE the erasure. Without this
    // the case would pass against an engine that deletes nothing and an insert that silently did nothing.
    expect(await live(mine.id)).toBe(1)
    expect(await live(theirs.id)).toBe(1)

    const report = await withUnitOfWork(sql, ACTOR, async (uow) => {
      const requestId = await openErasure(uow, customerId)
      return eraseSubject(uow, deps, { ...ERASURE_ARGS, rightsRequestId: requestId })
    })

    // Gone. Not expired-in-place: there is no row left holding the digest of a secret somebody still has.
    expect(await live(mine.id)).toBe(0)
    // And the stranger's link still works, which is what says the delete was scoped to the subject.
    expect(await live(theirs.id)).toBe(1)

    // The resolution ACCOUNTS for it, by name and as an acting line. A table erased without a line saying
    // so is the accounting defect this unit is built against, and it is a different failure from the two
    // above: the rows could be gone and the report still silent about them.
    //
    // Read from `rights_resolution_class` rather than from the returned report, because `retained_reason` is
    // a COLUMN and the report's class lines do not carry it. Asserting it off the report was a TS2339 that
    // vitest transpiled straight past — brief rule 28 exactly — and the database is the better source
    // anyway: it is what a reader of the resolution actually sees.
    const [line] = await sql<
      {
        action: string
        dataClass: string
        rowsActed: number
        rowsRetained: number
        retainedReason: string | null
      }[]
    >`
      select action, data_class as "dataClass", rows_acted as "rowsActed",
             rows_retained as "rowsRetained", retained_reason as "retainedReason"
        from rights_resolution_class
       where rights_resolution_id = ${report.resolutionId}::uuid
         and participant = 'public.booking_manage_grant' and column_name = 'token_sha256'
    `
    expect(line, 'public.booking_manage_grant.token_sha256').toBeDefined()
    expect(line?.action).toBe('delete_row')
    expect(line?.dataClass).toBe('credential')
    expect(line?.rowsActed).toBe(1)
    // Nothing retained, so nothing needs a reason: a credential has no lawful basis to outlive the person
    // it was issued to, and `rights_resolution_class` refuses a retained row with no reason anyway.
    expect(line?.rowsRetained).toBe(0)
    expect(line?.retainedReason).toBeNull()
  }, 30_000)
})

describe('erasing a customer with clinical data', () => {
  it('destroys the data keys, so decrypting fails with a KEY error rather than returning nothing', async () => {
    const customerId = ids.clinical
    // The ACTIVE version, read from the database, never the literal 'v1'. `rotation.itest.ts` retires the
    // seeded version and activates one of its own, and 0043 refuses to ENCRYPT under a retired KEK
    // (`KekRetiredCannotEncrypt`) — correctly, because a retired key is kept so rows sealed with it can be
    // decrypted and re-wrapped, not so new rows can be written under it. This fixture hardcoded 'v1' and so
    // passed alone and failed in the suite, with a message about key lifecycle rather than about erasure.
    const [active] = await sql<{ v: string | null }[]>`select clinical.active_kek_version() as v`
    if (!active?.v) throw new Error('no active KEK version; migration 0043 seeds one')
    const kek = generateKek(active.v)

    // A template, the consent that authorises an answer against it (0082's deferred gate refuses without
    // one), and a real sealed payload — so the decryption assertions are about a payload that genuinely
    // decrypted a moment ago.
    //
    // **An EXISTING template is reused wherever there is one, and the version space is the reason.**
    // `intake_form_template.version` is shared across every suite that touches the clinical schema, and
    // 0082's `intake_template_version_is_newer` refuses any insert numbered below the locale's current
    // version. The first draft of this fixture inserted a fixed `960201` — chosen to sit above everything,
    // which is exactly what made it harmful: `intake.itest.ts` walks the locale forward with
    // `max(version) + 1`, so twenty-five of its own inserts climbed from that seed to a current version of
    // 960226, and `rotation.itest.ts` — which inserts a fixed, modest version of its own — was then refused
    // with `IntakeTemplateVersionNotNewer`. A file this unit never touched, failing on a number this unit
    // chose. That is brief rule 12 with a shared counter instead of a shared row.
    //
    // This fixture needs only SOME template to hang a consent and a sealed payload on, so it takes whatever
    // is there and inserts one only when the table is empty for this locale — at version 1, which cannot be
    // above anything. Reusing another suite's template is safe in both directions: the consent written below
    // makes the row undeletable by `intake.itest.ts`'s conditional cleanup, which skips a referenced
    // template rather than failing on one.
    const templateFor = async (): Promise<{ id: string; version: number; consentHash: string }> => {
      const [found] = await sql<{ id: string; version: number; consentHash: string }[]>`
        select id, version, consent_hash as "consentHash"
          from clinical.intake_form_template where locale = 'en'
         order by version desc limit 1
      `
      if (found !== undefined) return found
      await sql`
        insert into clinical.intake_form_template (version, locale, title, definition, consent_text,
                                                   consent_hash, is_current)
        values (1, 'en', 'Fixture intake (C-CRM-10)', '{"fields":[]}'::jsonb,
                '[DRAFT WORDING — not approved copy]', 'ccrm10-fixture-consent-hash', false)
        on conflict (version, locale) do nothing
      `
      const [created] = await sql<{ id: string; version: number; consentHash: string }[]>`
        select id, version, consent_hash as "consentHash"
          from clinical.intake_form_template where locale = 'en' order by version desc limit 1
      `
      if (created === undefined) throw new Error('the fixture template was not created')
      return created
    }
    const template = await templateFor()

    await sql`
      insert into clinical.treatment_consent (customer_id, template_id, consent_hash, consented_at,
                                              consent_locale, captured_via, signature_present)
      select ${customerId}::uuid, ${template.id}::uuid, ${template.consentHash},
             ${RECEIVED_ISO}::timestamptz, 'en', 'in_salon', true
       where not exists (
         select 1 from clinical.treatment_consent
          where customer_id = ${customerId}::uuid and consent_hash = ${template.consentHash}
       )
    `

    const submissionId = (await sql<{ id: string }[]>`select uuid_generate_v7() as id`)[0]
      ?.id as string
    const binding = {
      table: 'intake_submission',
      recordId: submissionId,
      customerId,
      context: `template_version=${template.version}`,
    }
    const sealed = seal(kek, binding, JSON.stringify({ allergies: 'none stated (fixture)' }))

    await sql`
      insert into clinical.intake_submission
        (id, customer_id, template_id, payload_ciphertext, payload_nonce, wrapped_data_key,
         kek_version, aad_fingerprint, submitted_at, submitted_via, template_version, aad_context,
         data_origin, retain_until)
      values (${submissionId}::uuid, ${customerId}::uuid, ${template.id}::uuid,
              ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.wrappedDataKey}, ${sealed.kekVersion},
              ${sealed.aadFingerprint}, ${RECEIVED_ISO}::timestamptz, 'in_salon', ${template.version},
              ${`template_version=${template.version}`}, 'synthetic',
              ${RECEIVED_ISO}::timestamptz + interval '25 years')
    `

    /** Reads the row back and opens it. The control for the whole case. */
    const readAndOpen = async (): Promise<string> => {
      const [row] = await sql<
        {
          ciphertext: Buffer
          nonce: Buffer
          wrappedDataKey: Buffer
          kekVersion: string
          aadFingerprint: string
        }[]
      >`
        select payload_ciphertext as ciphertext, payload_nonce as nonce,
               wrapped_data_key as "wrappedDataKey", kek_version as "kekVersion",
               aad_fingerprint as "aadFingerprint"
          from clinical.intake_submission where id = ${submissionId}::uuid
      `
      if (row === undefined)
        throw new Error('the submission row is gone, which is not crypto-erasure')
      return openSealed(kek, binding, row)
    }

    // It decrypts BEFORE. Without this the assertion after the erasure would hold for a payload that was
    // never readable in the first place — a control that compares a value to itself.
    expect(await readAndOpen()).toContain('none stated (fixture)')

    const report = await withUnitOfWork(sql, ACTOR, async (uow) => {
      const requestId = await openErasure(uow, customerId)
      return eraseSubject(uow, deps, { ...ERASURE_ARGS, rightsRequestId: requestId })
    })

    // Synthetic data, so the conflict is not live and the key is destroyed.
    expect(report.clinical?.action).toBe('crypto_erase')
    expect(report.clinical?.conflict).toBeNull()

    // The ROW is still there — this is crypto-erasure, not a hidden delete — and it will not open.
    await expect(readAndOpen()).rejects.toThrow(/ClinicalDataKeyDestroyed/)

    // The ciphertext is untouched and the wrapped key is gone. Both, because "the rows are hidden" and
    // "the key is destroyed" look identical from a failed decryption alone.
    const [row] = await sql<{ ciphertextLength: number; wrappedLength: number }[]>`
      select length(payload_ciphertext) as "ciphertextLength",
             length(wrapped_data_key)   as "wrappedLength"
        from clinical.intake_submission where id = ${submissionId}::uuid
    `
    expect(Number(row?.ciphertextLength)).toBe(sealed.ciphertext.length)
    expect(Number(row?.wrappedLength)).toBe(0)

    // And the destruction is RECORDED, with the request that authorised it. The empty key is the
    // mechanism; this table is the authority on who decided and when.
    const [destruction] = await sql<{ requestId: string; kekVersion: string }[]>`
      select rights_request_id as "requestId", kek_version_at_destruction as "kekVersion"
        from clinical.dek_destruction
       where target_table = 'intake_submission' and record_id = ${submissionId}::uuid
    `
    // The version the row was sealed UNDER, whatever that was — not the literal 'v1'. This is the same
    // defect as the `generateKek` call above and the half that survived the first fix: the assertion read
    // 'v1', so the case failed after `rotation.itest.ts` had activated a version of its own. It also MASKED
    // gate case 112p, which breaks the rotation queue's destroyed-key skip and expects this file to fail on
    // a `not.toContain` — with the case dying on this line first, the gate saw a non-zero exit carrying the
    // wrong reason and reported itself broken rather than the mutation caught.
    //
    // Recording the version at destruction is the point of the column: an operator reading the row needs to
    // know which KEK the ciphertext was under when its key was destroyed, and `destroy_customer_deks`
    // deliberately leaves `kek_version` alone so 0043's sealed-row trigger admits the write.
    expect(destruction?.kekVersion).toBe(active.v)
    expect(destruction?.requestId).toBeDefined()

    // The consent that authorised the processing is RETAINED: it holds no health content, and destroying
    // the record of consent while keeping the record that data was processed is the worst of both.
    const consents = await sql`
      select 1 from clinical.treatment_consent where customer_id = ${customerId}::uuid
    `
    expect(consents.length).toBeGreaterThan(0)

    // And the destroyed row is INVISIBLE to the KEK rotation's work queue. This is the assertion that
    // matters most beyond the erasure itself, and the failure it prevents is unbounded: `rewrap` cannot
    // unwrap a destroyed key, so a rotation that selected this row would throw, the row would never move off
    // the old KEK, and every subsequent rotation would fail on the same row for ever. One honoured erasure
    // request would make KEK rotation impossible in perpetuity.
    const store = createPostgresClinicalKeyStore(sql)
    const pending = await store.listSealedNotOn('a-version-nothing-is-on', 500)
    expect(pending.map((record) => record.recordId)).not.toContain(submissionId)
    // The control: a row that is NOT destroyed is returned by the same call with the same argument, so the
    // assertion above is about the destroyed key and not about a query that returns nothing.
    const [live] = await sql<{ id: string }[]>`
      select id from clinical.intake_submission
       where length(wrapped_data_key) > 0 and customer_id <> ${customerId}::uuid limit 1
    `
    if (live !== undefined) {
      expect(pending.map((record) => record.recordId)).toContain(live.id)
    }
  }, 30_000)

  it('refuses to destroy a key without an in-progress erasure request naming that customer', async () => {
    // The gate on the SECURITY DEFINER function, which is what makes lending the application role write
    // access to the clinical schema survivable. Asserted through the DATABASE, so it holds for a psql
    // session that never came through the repository.
    await expect(
      sql`
        select * from public.destroy_customer_deks(${ids.suppression}::uuid,
                                                     uuid_generate_v7(), now())
      `,
    ).rejects.toThrow(/ClinicalDekDestructionNotAuthorised/)
  })
})

describe('the hashed suppression key after erasure', () => {
  it('still refuses a send to the same number, asserted through the gate', async () => {
    const customerId = ids.suppression
    const phone = SUBJECTS.suppression.phone

    // This person never opted out, so there is NOTHING to preserve. That is the case that matters: the
    // erasure has to WRITE the suppression, or re-importing the number leaves a record with a clean sheet.
    const keyBefore = suppressionKey(keying.peppers.current, 'phone', phone)

    /**
     * The fold the send path uses, over the log this key resolves to. Never a row count.
     *
     * `asSuppressionLog` re-brands `recordedAt`, which is the same narrow cast `merge.itest.ts` makes for
     * the same reason: `Instant` is a branded number in `@berelax/core` and `packages/db` returns a plain
     * one, because the db layer may not import core to get the brand.
     */
    const stateAt = async (recipient: string, atIso: string): Promise<string> => {
      const logs = await readSuppressionLogs(sql, keying, [{ keyKind: 'phone', recipient }])
      const read = logs.get(recipient)
      const log: SuppressionLog =
        read === undefined
          ? { key: 'absent', records: [] }
          : {
              key: read.key,
              records: read.records.map((record) => ({
                ...record,
                recordedAt: record.recordedAt as Instant,
              })),
            }
      return resolveSuppression(log, Date.parse(atIso) as Instant).state
    }

    expect(await stateAt(phone, RECEIVED_ISO)).not.toBe('suppressed')

    await withUnitOfWork(sql, ACTOR, async (uow) => {
      const requestId = await openErasure(uow, customerId)
      return eraseSubject(uow, deps, { ...ERASURE_ARGS, rightsRequestId: requestId })
    })

    // Through the FOLD the send path uses, not by counting rows: the claim is "the send is refused".
    expect(await stateAt(phone, ERASED_ISO)).toBe('suppressed')

    // And it survives a RE-IMPORT under a brand-new customer record, which is the scenario the acceptance
    // line describes. The key is an HMAC of the detail and not of the contact, so the new record inherits
    // the refusal without anything joining them.
    const reimportedId = await ensure({ phone })
    expect(reimportedId).not.toBe(customerId)
    expect(await stateAt(phone, ERASED_ISO)).toBe('suppressed')

    // The control that stops this passing vacuously: a DIFFERENT number is not suppressed, so the fold is
    // answering about this key rather than refusing everything.
    expect(await stateAt(SUBJECTS.overdue.phone, ERASED_ISO)).not.toBe('suppressed')

    // The stored row holds an HMAC and no number anywhere — so the retention that keeps somebody
    // un-messageable is not itself a disclosure.
    const rows = await sql<{ keyHmac: string; source: string }[]>`
      select key_hmac as "keyHmac", source::text as source from suppression
       where key_hmac = ${keyBefore} and source = 'erasure_request'
    `
    expect(rows.length).toBeGreaterThan(0)
    expect(rows[0]?.keyHmac).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(rows)).not.toContain(phone.slice(-6))
  }, 30_000)
})

// ------------------------------------------------------------------------------------------------
// Export, and the insider-threat control
// ------------------------------------------------------------------------------------------------

describe('exporting subject data', () => {
  it('writes an audit row and enqueues an alert in the SAME transaction for more than one subject', async () => {
    const auditBefore = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event where action = 'privacy.subject_data_exported'
    `
    const outboxBefore = await sql<{ n: number }[]>`
      select count(*)::int as n from outbox_event where event_type = 'privacy.bulk_export_alerted'
    `

    const result = await withUnitOfWork(sql, ACTOR, (uow) =>
      exportSubjectData(uow, {
        rightsRequestId: null,
        purpose: 'Fixture bulk export, to exercise the insider-threat alert (docs/06 D4).',
        exportedAtIso: ERASED_ISO,
        subjectCustomerIds: [ids.exportA, ids.exportB],
        actorKind: 'staff',
        actorLabel: 'Manager (fixture)',
      }),
    )
    expect(result.subjectCount).toBe(2)
    expect(result.alerted).toBe(true)

    // Deltas, never totals: this table is append-only and earlier files leave rows (brief rules 9 and 12).
    const auditAfter = await sql<{ n: number }[]>`
      select count(*)::int as n from audit_event where action = 'privacy.subject_data_exported'
    `
    const outboxAfter = await sql<{ n: number }[]>`
      select count(*)::int as n from outbox_event where event_type = 'privacy.bulk_export_alerted'
    `
    expect(Number(auditAfter[0]?.n) - Number(auditBefore[0]?.n)).toBe(1)
    expect(Number(outboxAfter[0]?.n) - Number(outboxBefore[0]?.n)).toBe(1)

    // The export record cannot claim to be un-alerted: the CHECK ties `alerted` to `subject_count`.
    await expect(
      sql`
        insert into rights_export (purpose, exported_at, row_count, subject_count, alerted,
                                   actor_kind, actor_label)
        values ('Fixture', ${ERASED_ISO}::timestamptz, 40, 40, false, 'staff', 'Manager (fixture)')
      `,
    ).rejects.toThrow(/rights_export_multi_subject_alerts/)
  }, 30_000)

  it('does NOT alert for a single subject exercising their own right', async () => {
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from outbox_event where event_type = 'privacy.bulk_export_alerted'
    `
    const result = await withUnitOfWork(sql, ACTOR, (uow) =>
      exportSubjectData(uow, {
        rightsRequestId: null,
        purpose: 'Fixture single-subject export.',
        exportedAtIso: ERASED_ISO,
        subjectCustomerIds: [ids.exportA],
        actorKind: 'customer',
        actorLabel: 'Customer (fixture, OTP verified)',
      }),
    )
    expect(result.alerted).toBe(false)
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from outbox_event where event_type = 'privacy.bulk_export_alerted'
    `
    // The control for the case above: this delta is ZERO, so the alert is about the subject count and not
    // about exports in general.
    expect(Number(after[0]?.n) - Number(before[0]?.n)).toBe(0)
  })
})

// ------------------------------------------------------------------------------------------------
// The deadline
// ------------------------------------------------------------------------------------------------

describe('the SLA', () => {
  it('returns a request from the overdue query only once the frozen clock passes its due date', async () => {
    const requestId = await withUnitOfWork(sql, ACTOR, async (uow) => {
      const request = await recordRightsRequest(uow, {
        requestType: 'export',
        subjectCustomerId: ids.overdue,
        receivedAtIso: RECEIVED_ISO,
        slaDays: SLA_DAYS,
        dueAtIso: DUE_ISO,
        verifiedVia: 'staff_attested',
        actorKind: 'staff',
        actorLabel: 'Receptionist (fixture)',
        requestDetail: 'Asked for a copy of everything held about them.',
      })
      return request.id
    })

    const onTheDeadline = await overdueRightsRequests(sql, DUE_ISO)
    expect(onTheDeadline.map((r) => r.id)).not.toContain(requestId)

    const pastIt = await overdueRightsRequests(sql, PAST_DUE_ISO)
    expect(pastIt.map((r) => r.id)).toContain(requestId)

    // The due date is derived from the SLA and stored, so lowering the setting later cannot retroactively
    // make an answered request late.
    const [stored] = await sql<{ slaDays: number; dueAt: Date }[]>`
      select sla_days as "slaDays", due_at as "dueAt" from rights_request
       where id = ${requestId}::uuid
    `
    expect(Number(stored?.slaDays)).toBe(SLA_DAYS)
    expect(stored?.dueAt.toISOString()).toBe(DUE_ISO)
  })

  it('refuses a second open request of the same type for the same subject', async () => {
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        recordRightsRequest(uow, {
          requestType: 'export',
          subjectCustomerId: ids.overdue,
          receivedAtIso: RECEIVED_ISO,
          slaDays: SLA_DAYS,
          dueAtIso: DUE_ISO,
          verifiedVia: 'otp',
          actorKind: 'customer',
          actorLabel: 'Customer (fixture, OTP verified)',
          requestDetail: 'A duplicate of the request above.',
        }),
      ),
    ).rejects.toThrow(/rights_request_one_open_per_subject_and_type/)
  })
})

// ------------------------------------------------------------------------------------------------
// As the APPLICATION role, not the owner
// ------------------------------------------------------------------------------------------------

describe('under berelax_app rather than the owner', () => {
  /**
   * Runs one statement as the application role, in its OWN transaction.
   *
   * One transaction per expectation, which is not fussiness: the first refused statement aborts the
   * transaction, and every statement after it fails with "current transaction is aborted" — a message that
   * matches no privilege assertion and makes the second and third checks prove nothing. The first draft of
   * this case put all three in one transaction and the second one failed for exactly that reason.
   */
  const asApp = async (body: (tx: Sql) => Promise<unknown>): Promise<void> => {
    await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      await body(tx as unknown as Sql)
    })
  }

  it('cannot edit or delete its own evidence', async () => {
    // The integration database connects as the OWNER, so every privilege assertion elsewhere in this file
    // is silent about what the application can actually do. One unit's statement in an earlier batch was
    // green only because of that.
    await expect(
      asApp((tx) => tx`update rights_resolution set response_issued = true`),
    ).rejects.toThrow(/permission denied|RightsRecordImmutable/)
    await expect(asApp((tx) => tx`delete from rights_request`)).rejects.toThrow(
      /permission denied|RightsRequestNotDeletable/,
    )
    await expect(asApp((tx) => tx`delete from rights_resolution_class`)).rejects.toThrow(
      /permission denied|RightsRecordImmutable/,
    )
  })

  it('cannot reach the clinical schema at all', async () => {
    await expect(
      asApp((tx) => tx`select count(*) from clinical.intake_submission`),
    ).rejects.toThrow(/permission denied/)
    await expect(asApp((tx) => tx`select count(*) from clinical.dek_destruction`)).rejects.toThrow(
      /permission denied/,
    )
  })

  it('CAN crypto-erase through the SECURITY DEFINER function, which is the only route it has', async () => {
    const customerId = ids.exportB
    // The request is created as the OWNER and the call is made as the APPLICATION role, inside one
    // transaction that is rolled back. `withUnitOfWork` is not used because it calls `sql.begin`, and a
    // postgres.js transaction handle has no `begin` — which is how the first draft of this case failed.
    await sql
      .begin(async (tx) => {
        const [request] = await tx<{ id: string }[]>`
          insert into rights_request (request_type, subject_customer_id, received_at, sla_days, due_at,
                                      verified_via, actor_kind, actor_label, request_detail, state)
          values ('erasure', ${customerId}::uuid, ${RECEIVED_ISO}::timestamptz, ${SLA_DAYS},
                  ${DUE_ISO}::timestamptz, 'otp', 'customer', 'Customer (fixture, OTP verified)',
                  'Asked for their record to be erased.', 'in_progress')
          returning id
        `
        if (request === undefined) throw new Error('the fixture erasure request was not created')
        await tx`set local role berelax_app`
        // The privilege and the authorisation gate are different things and both have to hold: the role may
        // EXECUTE the function, and the function refuses without an in-progress request naming this
        // customer. This subject has no clinical rows, so both counts are zero and what is proved is the
        // route itself.
        const rows = await tx`
          select * from public.destroy_customer_deks(${customerId}::uuid, ${request.id}::uuid,
                                                       ${ERASED_ISO}::timestamptz)
        `
        expect(rows).toHaveLength(2)
        throw new Error('rollback the app-role case')
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'rollback the app-role case') return
        throw error
      })

    // Rolled back, so the fixture left no open request behind for the overdue query to find.
    const left = await sql`
      select 1 from rights_request where subject_customer_id = ${customerId}::uuid
    `
    expect(left).toHaveLength(0)
  })

  it('runs a WHOLE erasure as the application role, which is the only thing that finds a direct read', async () => {
    // The case that had to exist. Every other assertion in this file runs as the OWNER, so the engine could
    // read the clinical schema directly and nothing would say so — and it DID: `actOnClinicalSchema` issued
    // `select distinct data_origin from clinical.intake_submission` on every single run, plus two more
    // selects in the retain branch. 0009 revokes every privilege on that schema from `berelax_app`, so the
    // engine as first written could only ever have run as the database owner, and the feature would have
    // failed in production on the first erasure with `permission denied for schema clinical`.
    //
    // The case directly above proves the role may CALL the SECURITY DEFINER function. That is a different
    // claim from this one, which is that the engine only ever goes through it — and the gap between the two
    // is exactly where the defect lived. The sibling case asserting the role "cannot reach the clinical
    // schema at all" was passing at the same time, about the same schema, in the same file.
    //
    // Rolled back, so the subject stays usable and the case is idempotent across runs. `withUnitOfWork` is
    // not used because it calls `sql.begin` and a postgres.js transaction handle has no `begin`; nesting
    // would also defeat the point, which is that `set local role` covers the whole erasure.
    await sql
      .begin(async (tx) => {
        await tx`set local role berelax_app`
        const inner = tx as unknown as Sql
        const uow: UnitOfWork = {
          sql: inner,
          audit: new AuditWriter(inner, ACTOR),
          publish: (event) => publishEvent(inner, event),
        }
        const requestId = await openErasure(uow, ids.appRole)
        const report = await eraseSubject(uow, deps, {
          ...ERASURE_ARGS,
          rightsRequestId: requestId,
        })
        // It completed, and it accounted for the clinical tables it could only have reached through the
        // function. A run that had skipped them would still report a state and still balance.
        expect(report.erasedCustomerIds).toContain(ids.appRole)
        const participants = new Set(report.classes.map((c) => c.participant))
        expect(participants).toContain('clinical.intake_submission')
        expect(participants).toContain('clinical.treatment_consent')
        expect(participants).toContain('clinical.dek_destruction')
        // And the completeness claim holds under the application role too, which is the claim that matters:
        // a resolution written by the app is no less an account of itself than one written by the owner.
        const covered = coveredTables(await erasureCoverage(inner))
        expect([...covered].filter((table) => !participants.has(table))).toEqual([])
        throw new Error('rollback the app-role erasure')
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.message === 'rollback the app-role erasure') return
        throw error
      })

    // Nothing survived the rollback: the subject is live and un-erased, so the case has not spent itself.
    const [after] = await sql<{ erasedAt: Date | null }[]>`
      select erased_at as "erasedAt" from customer where id = ${ids.appRole}::uuid
    `
    expect(after?.erasedAt).toBeNull()
  }, 30_000)
})
