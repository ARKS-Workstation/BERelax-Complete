import {
  type ConsentLog,
  type ConsentRecord,
  classifyErasureCoverage,
  decideRightsResponse,
  dueDateFor,
  E164_IDENTITY_REJECTIONS,
  e164IdentityResult,
  erasurePseudonym,
  type Instant,
  planClinicalErasure,
  resolveConsent,
  suppressionKeyNormaliser,
} from '@berelax/core'
import {
  type Actor,
  beginRightsRequest,
  createConnection,
  type ErasureDeps,
  eraseSubject,
  IMPORT_CONTACT_AUDIT_ACTIONS,
  IMPORT_CONTACT_KEY_KINDS,
  IMPORT_CONTACT_SQLSTATE,
  importContactHmac,
  readConsentLogs,
  readConsentPurposes,
  readCurrentConsentWording,
  readImportedContactCounts,
  readImportedContactsForNumber,
  readSuppressionLogs,
  recordConsent,
  recordRightsRequest,
  type Sql,
  type SuppressionKeying,
  type SuppressionPepper,
  withUnitOfWork,
} from '@berelax/db'
import {
  evaluateGate,
  promotionalGateEvaluators,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { contentChecksum, exactChecksum, runImport, unprovenancedRowIds } from '@berelax/migration'
import {
  CUSTOMERS_IMPORTER_TARGETS,
  customersImporter,
  MINIMISED_PAYLOAD_KEYS,
  planContactList,
} from '@berelax/migration/importers/customers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildContactList,
  type ContactListFixture,
  contactNormaliser,
  UNREADABLE_REASONS,
  unreadableCells,
} from './customer-import.ts'
import { fixtureSuppressionPeppers } from './suppression.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * H-MIG-04's five acceptance lines, against a real PostgreSQL, each with a control that must fail.
 *
 * This is the only place they can be asserted. `packages/db` may never import `packages/core` and
 * `packages/migration` may import neither, so the normaliser, the importer and the consent gate live in
 * three packages whose own suites can each see one of them; `packages/fixtures` may depend on all three.
 *
 * ## The claim this file exists to make honestly
 *
 * **A list rebuilt from WhatsApp history and phone contacts is not consent.** The hard part is that
 * "no marketing consent" is an ABSENCE: 0056 made consent an append-only log, so there is no flag to read
 * and a case asserting `marketing_consent === false` would be asserting about a column that does not
 * exist. So the absence is asserted three ways, because any one of them alone is weak:
 *
 *   1. **no row.** Zero consent rows for the customers an import created, over a file that claims a
 *      consent on EVERY line — and the control is that the claim was read, counted and recorded as
 *      discarded, so the count is not zero because the column was ignored.
 *   2. **through the GATE.** The send path's own evaluators, over the real stored log, refuse a
 *      promotional message to every imported customer by name (`refused_no_consent`) and allow a
 *      transactional one. A row can exist and be unreadable by the gate; a gate can refuse for the wrong
 *      reason. Only the fold answers the question that matters.
 *   3. **at the database.** ZY271 refuses a granted send-gating consent captured by an import, whatever
 *      wrote it — with the three controls that keep the rule narrow: an ordinary capture still works, a
 *      WITHDRAWAL captured by an import still works, and a non-send-gating purpose is untouched.
 *
 * ## What is asserted as a DELTA
 *
 * `imported_contact`, `import_row`, `import_provenance` and `audit_event` are all append-only with no
 * DELETE grant, so every count over them is a delta across one import and never a total (brief rule 9).
 * The customers this file creates ARE removed in `afterAll` — rows it created, which is all a suite may
 * delete — and the erasure case's subject is deliberately left, because an erasure cannot be undone and
 * `rights_request` holds a reference to it.
 *
 * ## Why every number is unique per EXECUTION
 *
 * `customer.phone_e164` is UNIQUE, so a second run over the same numbers resolves every line to the
 * customer the first run created: `matched`, not `created`. A suite with fixed numbers would assert 1,760
 * creations once and zero for ever after — green the first time and red about nothing afterwards. So the
 * base index is drawn per execution, in a band far above every fixture index any other file uses (the
 * highest is 10_700 + 300 in `rights.itest.ts`), which is the arrangement `package-liability.itest.ts`
 * needs for the same reason.
 *
 * The two numbers the third acceptance line names — `052 510 8633` and `02 557 6533` — are the business's
 * own, from docs/13 §3. They are NORMALISED here, which is what the line asks for, and no customer is
 * ever created from one: `REAL_BUSINESS_NUMBERS` names both and `assertSynthetic` exists to keep them out
 * of a fixture.
 */

const ACTOR: Actor = { kind: 'system', label: 'H-MIG-04 customer import suite' }

/**
 * The per-execution nonce, and the band derived from it.
 *
 * `RUN_NONCE` is the whole clock reading and goes into the unreadable cells, which have to be unique in
 * full: a cell is keyed as itself, so a repeat is SKIPPED by the framework's idempotence and the
 * quarantine count silently drops. `RUN_BASE` is quantised because it indexes `syntheticPerson` and 2,000
 * lines need 1,760 consecutive indexes, so the blocks are 4,000 apart.
 */
const RUN_NONCE = Date.now()
const RUN_BASE = 6_000_000 + (RUN_NONCE % 500) * 4_000

const BAND = {
  consentFloor: RUN_BASE,
  gate: RUN_BASE + 200,
  quarantine: RUN_BASE + 400,
  capture: RUN_BASE + 600,
  ledger: RUN_BASE + 800,
  dedup: RUN_BASE + 1_000,
} as const

/**
 * Fixed instants, so nothing here depends on a wall clock — and ORDERED, which is load-bearing.
 *
 * The capture happens BEFORE the send. `resolveConsent` folds the log as at an instant, so a grant
 * recorded after the instant the gate is asked about has not happened yet: the first version of this file
 * captured at 10:00 and sent at 08:00, and the resolver correctly answered `unknown` about a grant that
 * was two hours in its future. That is the resolver being right and the fixture being wrong, which is the
 * more useful way round and is why the order is written down here rather than left to two literals.
 */
const CAPTURED_ISO = '2099-06-30T10:00:00.000Z'
/** Inside the 07:00-21:00 Asia/Dubai promotional window, so the gate's verdict is about consent. */
const SEND_ISO = '2099-07-01T08:00:00.000Z'
const RECEIVED_ISO = '2099-07-02T09:00:00.000Z'
const ERASED_ISO = '2099-07-03T09:00:00.000Z'
const SLA_DAYS = 30
const DUE_ISO = dueDateFor(new Date(RECEIVED_ISO), SLA_DAYS).toISOString()

let sql: Sql
let keying: SuppressionKeying
let pepper: SuppressionPepper
let deps: ErasureDeps
/** Every number this file created a customer for, for the one DELETE it is allowed to make. */
const created: string[] = []

beforeAll(() => {
  sql = createConnection({ url, max: 4 })
  keying = { peppers: fixtureSuppressionPeppers(process.env), normalise: suppressionKeyNormaliser }
  pepper = keying.peppers.current
  deps = {
    classify: (probed) => classifyErasureCoverage(probed),
    pseudonymFor: erasurePseudonym,
    planClinical: planClinicalErasure,
    decideResponse: decideRightsResponse,
    keying,
  }
})

afterAll(async () => {
  /*
    The customers this file created, and nothing else.

    `imported_contact` refuses DELETE for every role (ZY272) and so does the whole staging ledger (ZY192,
    ZY195, and no DELETE grant anywhere in `import_staging`) — which is the point of them, and is why every
    count in this file is a delta. The customer rows are mine to remove and have to be: `customer` is the
    table every other suite's counts run over, and two thousand rows left behind by one file is the shape
    of defect brief rule 12 is about.

    The erasure subject is NOT in this list. An erasure is irreversible, its `rights_request` row holds a
    reference to the subject, and the reachability invariant in `rights.itest.ts` reads the whole table —
    so the pseudonymised row is evidence and is left exactly as `rights.itest.ts` leaves its own.
  */
  if (sql !== undefined && created.length > 0) {
    await sql`delete from customer where phone_e164 = any (${created}::text[])`
  }
  await sql?.end({ timeout: 5 })
})

/** Imports one list and returns the framework's report. The one place a run is started. */
async function importList(
  list: ContactListFixture,
  sourceFile: string,
  mode: 'live' | 'dry-run' = 'live',
): ReturnType<typeof runImport> {
  const report = await runImport({
    sql,
    importer: customersImporter({ pepper, normalise: contactNormaliser }),
    sourceFile,
    sourceText: list.sourceText,
    mode,
    actor: ACTOR,
  })
  if (mode === 'live') created.push(...list.numbers)
  return report
}

/** How many consent rows one contact has, counted in SQL: the table only grows (brief rule 12). */
async function consentRowCount(contactIds: readonly string[]): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n from consent
     where contact_customer_id = any (${[...contactIds]}::uuid[])
  `
  return Number(rows[0]?.n ?? '0')
}

async function customerIdsFor(numbers: readonly string[]): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = any (${[...numbers]}::text[]) order by phone_e164
  `
  return rows.map((row) => row.id)
}

async function auditCount(action: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(rows[0]?.n ?? '0')
}

/**
 * The db read, narrowed to the resolver's own type.
 *
 * `recordedAt` is a plain `number` on the db side — that package may not import core's `Instant` brand —
 * so the cast is unavoidable and the spread is what makes it honest: a field the resolver requires and the
 * reader stopped producing is a compile error here. `consent.itest.ts` has the same helper for the same
 * reason, and it is not exported from either file because a shared one would be a third statement of a
 * shape two readers already agree on.
 */
function asLog(read: {
  readonly contactId: string
  readonly records: readonly {
    readonly id: string
    readonly channel: string
    readonly purpose: string
    readonly kind: 'granted' | 'withdrawn'
    readonly recordedAt: number
    readonly wordingId: string | null
  }[]
  readonly wordingVersions: readonly {
    readonly id: string
    readonly purpose: string
    readonly version: number
    readonly contentHashHex: string
  }[]
}): ConsentLog {
  return {
    contactId: read.contactId,
    records: read.records.map(
      (record): ConsentRecord => ({ ...record, recordedAt: record.recordedAt as Instant }),
    ),
    wordingVersions: read.wordingVersions,
  }
}

/** One promotional and one transactional message to the same recipient, identical but for the class. */
const messageTo = (recipient: string, messageClass: 'promotional' | 'transactional') =>
  ({
    id: `hmig04-${messageClass}-${recipient}` as never,
    channel: 'sms' as const,
    messageClass,
    recipient,
    body: 'Fixture body.',
    templateKey: messageClass === 'promotional' ? 'fixture.offer' : 'fixture.confirmation',
    locale: 'en' as const,
  }) as never

// ------------------------------------------------------------------------------------------------
// Acceptance 1 — the consent floor
// ------------------------------------------------------------------------------------------------

describe('the consent floor', () => {
  it('writes no consent row from a file that claims one on every line, and logs each override', async () => {
    const list = buildContactList({
      baseIndex: BAND.consentFloor,
      distinct: 30,
      duplicates: 4,
      // EVERY line. The acceptance line is about exactly this file: "a fixture source file explicitly
      // setting consent true still imports as false with a logged override".
      claimEvery: 1,
    })
    expect(list.claims).toBe(list.lines)

    const before = await auditCount(IMPORT_CONTACT_AUDIT_ACTIONS.consentClaimDiscarded)
    const report = await importList(list, 'consent-floor.tsv')
    expect(report.state).toBe('completed')
    expect(report.rejected).toBe(0)
    expect(report.applied).toBe(list.lines)

    const ids = await customerIdsFor(list.numbers)
    expect(ids).toHaveLength(list.numbers.length)

    // 1. No row. Not a `false` and not a `withdrawn` row either — nobody withdrew anything and nobody was
    //    ever asked, which is what the absence says and a `withdrawn` row would not.
    expect(await consentRowCount(ids)).toBe(0)

    // 2. The control, and the reason the zero above is not vacuous: the claim WAS read. Every imported
    //    contact record carries the discard, and one audit row per line says so.
    const rows = await sql<{ n: string; claims: string }[]>`
      select count(*)::text as n,
             count(*) filter (where consent_claim_discarded)::text as claims
        from imported_contact c
        join import_staging.import_provenance p
          on p.target_schema = 'public' and p.target_table = 'imported_contact'
         and p.target_id = c.id::text
        join import_staging.import_row w on w.id = p.import_row_id
       where w.run_id = ${report.runId}::uuid
    `
    expect(Number(rows[0]?.n ?? '0')).toBe(list.lines)
    expect(Number(rows[0]?.claims ?? '0')).toBe(list.lines)
    expect(await auditCount(IMPORT_CONTACT_AUDIT_ACTIONS.consentClaimDiscarded)).toBe(
      before + list.lines,
    )

    // 3. And the import created exactly the people the list is about, not the lines it has.
    const counts = await readImportedContactCounts(sql)
    expect(counts.created).toBeGreaterThanOrEqual(list.numbers.length)
    expect(report.applied - list.duplicates).toBe(list.numbers.length)
  }, 120_000) // 34 rows, each its own transaction, against vitest's undeclared 5,000 ms default (rule 21).

  it('refuses a granted send-gating consent captured by an import, and nothing else', async () => {
    const [contactId] = await customerIdsFor([...created].slice(0, 1))
    expect(contactId, 'an imported customer exists from the case above').toBeDefined()
    const wording = await readCurrentConsentWording(sql, 'marketing')
    expect(wording, 'the marketing wording is seeded').not.toBeNull()
    if (wording === null || contactId === undefined) return

    const capture = (source: string, kind: string, purpose: string, withWording: boolean) =>
      sql`
        insert into consent
          (contact_customer_id, channel, purpose, kind, recorded_at, consent_wording_id, wording_hash,
           capture_source, capture_actor_kind, capture_actor_label, capture_locale)
        values (
          ${contactId}::uuid, 'sms'::message_channel, ${purpose}, ${kind}::consent_kind,
          ${CAPTURED_ISO}::timestamptz,
          ${withWording ? wording.id : null},
          ${withWording ? sql`decode(${wording.contentHashHex}, 'hex')` : null},
          ${source}, 'system', 'H-MIG-04 fixture probe', 'en'
        )
      `

    // ZY271, by name. A bare failure would be satisfied by a typo in a column name (ADR 0003), and here
    // it would also be satisfied by the row bouncing off the wording-hash trigger instead.
    const refused = await sql
      .begin(async (tx) => {
        await tx`
          insert into consent
            (contact_customer_id, channel, purpose, kind, recorded_at, consent_wording_id, wording_hash,
             capture_source, capture_actor_kind, capture_actor_label, capture_locale)
          values (
            ${contactId}::uuid, 'sms'::message_channel, 'marketing', 'granted'::consent_kind,
            ${CAPTURED_ISO}::timestamptz, ${wording.id},
            decode(${wording.contentHashHex}, 'hex'),
            'import', 'system', 'H-MIG-04 fixture probe', 'en'
          )
        `
        return 'accepted'
      })
      .catch((error: unknown) => (error as { code?: string }).code ?? String(error))
    expect(refused).toBe(IMPORT_CONTACT_SQLSTATE.importIsNotAnOptIn)

    /*
      The three controls that keep the rule as narrow as it claims to be. Without them a trigger that
      refused every consent row, or every imported row, would pass the case above — and the first symptom
      would be the booking form unable to record an opt-in at all.
    */
    const accepted = async (
      label: string,
      source: string,
      kind: string,
      purpose: string,
      withWording: boolean,
    ): Promise<string> =>
      sql
        .begin(async (tx) => {
          await tx.unsafe(
            `insert into consent
               (contact_customer_id, channel, purpose, kind, recorded_at, consent_wording_id,
                wording_hash, capture_source, capture_actor_kind, capture_actor_label, capture_locale)
             values ($1::uuid, 'sms'::message_channel, $2, $3::consent_kind, $4::timestamptz, $5,
                     case when $6::boolean then decode($7, 'hex') else null end,
                     $8, 'system', 'H-MIG-04 fixture probe', 'en')`,
            [
              contactId,
              purpose,
              kind,
              CAPTURED_ISO,
              withWording ? wording.id : null,
              withWording,
              wording.contentHashHex,
              source,
            ],
          )
          throw new Error(`rollback ${label}`)
        })
        .then(() => 'committed')
        .catch((error: unknown) =>
          error instanceof Error && error.message === `rollback ${label}`
            ? 'accepted'
            : ((error as { code?: string }).code ?? String(error)),
        )

    // An ordinary capture at the booking form, which is the path that must keep working.
    expect(await accepted('booking', 'booking_form', 'granted', 'marketing', true)).toBe('accepted')
    // A WITHDRAWAL captured by an import. Permitted deliberately: it only ever restricts sending, and a
    // list that says "these people asked us to stop" must be importable without argument.
    expect(await accepted('withdraw', 'import', 'withdrawn', 'marketing', false)).toBe('accepted')
    // A purpose that does NOT gate a send. `clinical_processing` is a lawful basis for holding a record
    // rather than permission to message anybody (0056), and refusing it would be this unit deciding
    // something it has no business deciding.
    expect(await accepted('clinical', 'import', 'granted', 'clinical_processing', true)).toBe(
      'accepted',
    )
    expect(capture).toBeTypeOf('function')
  })
})

// ------------------------------------------------------------------------------------------------
// Acceptance 2 — transactional permitted, promotional refused, as an invariant
// ------------------------------------------------------------------------------------------------

describe('the messaging gate over imported customers', () => {
  it('allows every transactional send and refuses every promotional one, by name', async () => {
    const list = buildContactList({ baseIndex: BAND.gate, distinct: 12 })
    await importList(list, 'gate.tsv')
    const ids = await customerIdsFor(list.numbers)
    expect(ids).toHaveLength(list.numbers.length)

    const at = Date.parse(SEND_ISO) as Instant
    const byContact = await readConsentLogs(sql, ids)
    const suppressionLogs = await readSuppressionLogs(
      sql,
      keying,
      list.numbers.map((recipient) => ({ keyKind: 'phone', recipient })),
    )

    /*
      The evaluators are keyed by RECIPIENT, which is how `message.recipient` spells it — so the consent
      log, which the database keys by contact id, is re-keyed here. That is the caller's job and
      `promotionalGateEvaluators`' own note says so; doing it per message would be three queries per
      recipient and a campaign of four thousand would be twelve thousand round trips.
    */
    const consentLogs = new Map<string, ConsentLog>()
    for (const [at2, number] of list.numbers.entries()) {
      const contactId = ids[at2]
      const read = contactId === undefined ? undefined : byContact.get(contactId)
      expect(read, `a consent log was read for ${number}`).toBeDefined()
      if (read !== undefined) consentLogs.set(number, asLog(read))
    }

    const evaluators = promotionalGateEvaluators({
      purpose: 'marketing',
      at,
      reads: {
        consentLogs,
        suppressionLogs: new Map(
          [...suppressionLogs].map(([recipient, read]) => [
            recipient,
            {
              key: read.key,
              records: read.records.map((record) => ({
                ...record,
                recordedAt: record.recordedAt as Instant,
              })),
            },
          ]),
        ),
        // Present, read and empty: a contact who has never been messaged. Absent is a different claim and
        // all three evaluators throw for it, which the gate reports as `blocked_unevaluable`.
        ledgerCountedAt: new Map(list.numbers.map((recipient) => [recipient, []])),
        ledgerReadFrom: 0 as Instant,
      },
    })
    const ctx = {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators,
    }

    // The invariant, over every imported customer rather than over one: a case that checked the first
    // would pass if the import had granted consent to everybody but the first.
    for (const number of list.numbers) {
      expect(
        evaluateGate(ctx, messageTo(number, 'transactional'), at),
        `transactional to ${number}`,
      ).toEqual({ kind: 'allow' })
      const promotional = evaluateGate(ctx, messageTo(number, 'promotional'), at)
      expect(promotional.kind, `promotional to ${number}`).toBe('refuse')
      expect(
        promotional.kind === 'refuse' ? promotional.reason : '',
        `promotional to ${number} refused by name`,
      ).toBe('refused_no_consent')
    }

    // The control: the resolver says `unknown` rather than `withdrawn`, because an imported contact has
    // never been asked. A `withdrawn` answer would mean the import had written a row claiming a decision.
    for (const number of list.numbers) {
      const log = consentLogs.get(number)
      expect(log).toBeDefined()
      if (log !== undefined)
        expect(resolveConsent(log, 'sms', 'marketing', at).state).toBe('unknown')
    }
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Acceptance 3 — normalisation and quarantine
// ------------------------------------------------------------------------------------------------

describe('normalisation, through the importer the suite actually runs', () => {
  it('normalises the two local Abu Dhabi formats the acceptance names', () => {
    /*
      The real `e164IdentityResult`, wired into the real importer, over the two spellings the acceptance
      line names — and no row is written, because both numbers are the BUSINESS's own (docs/13 §3) and
      `REAL_BUSINESS_NUMBERS` names both. Normalising them is what the line asks for; creating a customer
      from one is what `assertSynthetic` exists to prevent.

      Asserted through `planContactList` rather than through `e164IdentityResult` directly, because the
      claim is about what the IMPORT does with the cell: the pure function has its own census in
      `packages/core/src/identity/e164.test.ts`, and this is the wiring between the two packages.
    */
    const header = buildContactList({ baseIndex: BAND.quarantine, distinct: 0 }).sourceText
    const plan = planContactList(
      { pepper, normalise: contactNormaliser },
      `${header}052 510 8633\t\n02 557 6533\t\n`,
    )
    expect([...plan.plaintextByHmac.values()].sort()).toEqual(
      ['+971525108633', '+97125576533'].sort(),
    )
    expect(plan.distinct).toBe(2)
    expect(plan.quarantined).toBe(0)
    // The landline is a real identity and nothing can send to it — the distinction this unit's own
    // normaliser exists for, and the figure the plan reports so somebody is not surprised by it.
    expect(plan.unmessageable).toBe(1)
  })

  it('stores every number it calls canonical, which is the check SQL and TypeScript cannot share', async () => {
    /*
      `STORABLE_E164` in `@berelax/core` mirrors `customer_phone_is_e164` (migration 0019) and neither
      spelling can read the other — so the agreement is proved by pushing the census through the real
      COLUMN inside a transaction that is rolled back. It is the only way a number this module calls
      canonical and `customer` would refuse becomes a failure here rather than at the INSERT, a thousand
      rows into an import, naming a constraint instead of a cell.

      The business's own numbers appear here and are never committed: the transaction always ends by
      throwing.
    */
    const census = [
      '052 510 8633',
      '02 557 6533',
      '059 000 0042',
      '800 4357',
      '600 512345',
      '+971 3 765 4321',
      '٠٥٩٠٠٠٠٠٤٢',
    ]
    const canonical = census
      .map((raw) => e164IdentityResult(raw))
      .filter((result) => result.ok)
      .map((result) => (result.ok ? result.e164 : ''))
    expect(canonical.length).toBeGreaterThanOrEqual(5)

    /*
      One transaction per number, each rolled back, and a UNIQUE violation counts as storable.

      The first version put the whole census in one transaction and failed on
      `customer_phone_e164_key`: `+971590000042` is a seeded fixture contact, so the row already exists.
      That is not the claim. A duplicate key is raised by the INDEX, after the row-level CHECK has already
      accepted the value — so 23505 proves the same thing the insert does, and only 23514 (a check
      violation) is a number this module calls canonical and `customer` will not hold.
    */
    const unstorable: string[] = []
    for (const e164 of canonical) {
      const verdict = await sql
        .begin(async (tx) => {
          await tx`insert into customer (phone_e164, created_via) values (${e164}, 'import')`
          throw new Error('rollback')
        })
        .then(() => 'committed')
        .catch((error: unknown) => {
          if (error instanceof Error && error.message === 'rollback') return 'storable'
          const code = (error as { code?: string }).code
          // 23505: the value passed every CHECK and collided with a row that is already there.
          if (code === '23505') return 'storable'
          return `${code ?? ''} ${(error as { constraint_name?: string }).constraint_name ?? ''}`
        })
      if (verdict !== 'storable') unstorable.push(`${e164}: ${verdict}`)
    }
    expect(unstorable).toEqual([])

    // Nothing this case inserted was committed, which is the half a `catch` could hide. The business's
    // own landline and both WhatsApp candidates are in the census above and must not reach a row; the
    // synthetic number that is already seeded is excluded, because it was there before this case ran.
    const mine = canonical.filter((e164) => e164 !== '+971590000042')
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from customer where phone_e164 = any (${mine}::text[])
    `
    expect(Number(rows[0]?.n ?? '0')).toBe(0)
  })

  it('quarantines an unreadable cell with its reason and creates no customer for it', async () => {
    // Per execution, like the numbers and for a sharper reason: a quarantined line stages the digest of
    // the CELL (there is no number), so a fixed cell keys identically on every run and the framework's
    // idempotence skips it — four quarantines on the first run and zero for ever afterwards.
    const unreadable = unreadableCells(RUN_NONCE)
    const list = buildContactList({
      baseIndex: BAND.quarantine + 50,
      distinct: 5,
      unreadable,
    })
    const before = await readImportedContactCounts(sql)
    const report = await importList(list, 'quarantine.tsv')
    const after = await readImportedContactCounts(sql)

    // A quarantine is NOT a rejection: one unreadable cell in a contact list must not stop the other
    // lines arriving, which is what the framework's rejection path would do.
    expect(report.state).toBe('completed')
    expect(report.rejected).toBe(0)
    expect(after.quarantined - before.quarantined).toBe(unreadable.length)
    expect(after.created - before.created).toBe(list.numbers.length)

    // The reasons stored are `E164_IDENTITY_REJECTIONS`' own words. This is the agreement the importer
    // cannot assert for itself: the vocabulary is `@berelax/core`'s, which `packages/migration` may not
    // import, so it holds the SHAPE and this holds the VALUES.
    const reasons = await sql<{ reason: string }[]>`
      select distinct c.quarantine_reason as reason
        from imported_contact c
        join import_staging.import_provenance p
          on p.target_schema = 'public' and p.target_table = 'imported_contact'
         and p.target_id = c.id::text
        join import_staging.import_row w on w.id = p.import_row_id
       where w.run_id = ${report.runId}::uuid and c.outcome = 'quarantined'
       order by reason
    `
    expect(reasons.map((row) => row.reason)).toEqual([...UNREADABLE_REASONS].sort())
    for (const row of reasons) {
      expect(E164_IDENTITY_REJECTIONS as readonly string[]).toContain(row.reason)
    }

    // And nothing was guessed: a quarantined line resolves to its own line of the file and to no customer.
    const quarantined = await sql<{ sourceLine: number; sourceFile: string }[]>`
      select v.source_line as "sourceLine", v.source_file as "sourceFile"
        from imported_contact c
        join import_staging.entity_provenance v
          on v.target_schema = 'public' and v.target_table = 'imported_contact'
         and v.target_id = c.id::text
       where c.outcome = 'quarantined' and v.run_id = ${report.runId}::uuid
    `
    expect(quarantined).toHaveLength(unreadable.length)
    for (const row of quarantined) {
      expect(row.sourceFile).toBe('quarantine.tsv')
      expect(row.sourceLine).toBeGreaterThan(0)
    }
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Acceptance 4 — the dedup, at the size the acceptance names
// ------------------------------------------------------------------------------------------------

describe('two thousand lines with twelve per cent planted duplicates', () => {
  it('creates the distinct count, and a second import changes nothing at all', async () => {
    const list = buildContactList({ baseIndex: BAND.dedup, distinct: 1_760, duplicates: 240 })
    expect(list.lines).toBe(2_000)
    expect(list.duplicates).toBe(240)
    expect(list.numbers).toHaveLength(1_760)

    // The forecast, from the FILE alone, before anything is written.
    const plan = planContactList({ pepper, normalise: contactNormaliser }, list.sourceText)
    expect(plan.distinct).toBe(1_760)
    expect(plan.repeated).toBe(240)

    const before = await readImportedContactCounts(sql)
    const report = await importList(list, 'dedup-2000.tsv')
    const after = await readImportedContactCounts(sql)

    expect(report.state).toBe('completed')
    expect(report.applied).toBe(2_000)
    // The expected distinct count, and the two readings of it held equal: the forecast from the file and
    // what the unique index on `customer.phone_e164` actually did.
    expect(after.created - before.created).toBe(1_760)
    expect(after.matched - before.matched).toBe(240)
    expect(plan.distinct).toBe(after.created - before.created)

    const ids = await customerIdsFor(list.numbers)
    expect(ids).toHaveLength(1_760)
    // Still no consent, over the whole population rather than over a sample.
    expect(await consentRowCount(ids)).toBe(0)

    // Every imported customer row resolves to the line of the file it came from — H-MIG-01's provenance
    // claim, over this importer's own target.
    const unprovenanced = await unprovenancedRowIds(sql, 'public.imported_contact')
    expect(unprovenanced).toEqual([])

    /*
      The second import. Zero new and zero changed rows, asserted by the EXACT checksum over both target
      tables — every column, so not even a generated id may move. H-MIG-01's first acceptance line, over
      this importer.
    */
    const exactBefore = new Map<string, string>()
    for (const relation of CUSTOMERS_IMPORTER_TARGETS) {
      exactBefore.set(relation, await exactChecksum(sql, relation))
    }
    const again = await importList(list, 'dedup-2000.tsv')
    expect(again.applied).toBe(0)
    expect(again.skipped).toBe(2_000)
    for (const relation of CUSTOMERS_IMPORTER_TARGETS) {
      expect(await exactChecksum(sql, relation), `${relation} changed on the second import`).toBe(
        exactBefore.get(relation),
      )
    }
  }, 300_000) // ~2,000 transactions, twice. Measured at about 25s; the ceiling is for a loaded machine.

  it('creates no second customer when the pepper has been rotated under it', async () => {
    /*
      The one cost of staging a keyed digest rather than the number, asserted rather than left in a
      comment. Idempotence is decided on the content hash of the payload, and a rotated pepper produces a
      different digest — so a re-import after a rotation applies every line again. What must NOT happen is
      a second customer: the unique index on `customer.phone_e164` is the real dedup and the digest is only
      the forecast, so every line lands as `matched`.
    */
    const list = buildContactList({ baseIndex: BAND.dedup + 2_000, distinct: 8 })
    await importList(list, 'rotation.tsv')
    const idsBefore = await customerIdsFor(list.numbers)
    expect(idsBefore).toHaveLength(8)

    const rotated: SuppressionPepper = {
      version: `${pepper.version}-rotated`,
      secret: `${pepper.secret}-rotated-for-this-case-only`,
    }
    const before = await readImportedContactCounts(sql)
    const report = await runImport({
      sql,
      importer: customersImporter({ pepper: rotated, normalise: contactNormaliser }),
      // A DIFFERENT file name and the same bytes: the run is identified by the hash of the bytes, so the
      // same name would resume the earlier run rather than start one.
      sourceFile: 'rotation.tsv',
      sourceText: list.sourceText,
      mode: 'live',
      actor: ACTOR,
    })
    const after = await readImportedContactCounts(sql)

    expect(report.state).toBe('completed')
    expect(report.applied).toBe(8)
    expect(report.skipped).toBe(0)
    // Eight more records of what the import did, and not one new customer.
    expect(after.matched - before.matched).toBe(8)
    expect(after.created - before.created).toBe(0)
    expect(await customerIdsFor(list.numbers)).toEqual(idsBefore)
    // The pepper label travels with the digest, so a row keyed under the retired one is attributable.
    const versions = await sql<{ pepperVersion: string }[]>`
      select distinct pepper_version as "pepperVersion" from imported_contact
       where contact_hmac = ${importContactHmac(rotated, IMPORT_CONTACT_KEY_KINDS.number, list.numbers[0] ?? '')}
    `
    expect(versions.map((row) => row.pepperVersion)).toEqual([rotated.version])
  }, 120_000)

  it('rehearses the whole thing and changes nothing', async () => {
    const list = buildContactList({ baseIndex: BAND.dedup + 3_000, distinct: 20, duplicates: 2 })
    const before = new Map<string, string>()
    for (const relation of CUSTOMERS_IMPORTER_TARGETS) {
      before.set(relation, await exactChecksum(sql, relation))
    }
    const report = await importList(list, 'dry-run.tsv', 'dry-run')
    expect(report.committed).toBe(false)
    expect(report.state).toBe('completed')
    expect(report.applied).toBe(list.lines)
    for (const relation of CUSTOMERS_IMPORTER_TARGETS) {
      expect(await exactChecksum(sql, relation), `${relation} changed in a rehearsal`).toBe(
        before.get(relation),
      )
    }
    // And the rehearsal is as strong as the run: `runImport` issues `set constraints all immediate`
    // before rolling back, so ZY273 — deferred to COMMIT — fired on every one of these rows.
    expect(await customerIdsFor(list.numbers)).toEqual([])
    expect(await contentChecksum(sql, 'public.imported_contact')).toBeTypeOf('string')
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Acceptance 5 — the consent capture at the next booking
// ------------------------------------------------------------------------------------------------

describe('the consent capture step at an imported customer’s next booking', () => {
  it('has something to show, stores the wording version and its hash, and flips the gate', async () => {
    const list = buildContactList({ baseIndex: BAND.capture, distinct: 1 })
    await importList(list, 'capture.tsv')
    const [contactId] = await customerIdsFor(list.numbers)
    const number = list.numbers[0]
    expect(contactId).toBeDefined()
    expect(number).toBeDefined()
    if (contactId === undefined || number === undefined) return

    /*
      1. The step has something to show, and it is not conditional on the customer.

      `readConsentOffers` in `apps/web/src/book/read.ts` composes exactly these two reads — the send-gating
      purposes from `consent_purpose`, and the current published wording for each — and renders a fieldset
      on every confirm step. So "the step appears at an imported customer's next booking" is a property of
      the WORDINGS and not of the record: there is no branch anywhere that could show it to one customer
      and not another, which is what these two assertions are about.
    */
    const purposes = await readConsentPurposes(sql)
    const gating = purposes.filter((purpose) => purpose.isSendGating)
    expect(gating.length).toBeGreaterThan(0)
    const wording = await readCurrentConsentWording(sql, 'marketing')
    expect(
      wording,
      'a published marketing wording, or the step has nothing to render',
    ).not.toBeNull()
    if (wording === null) return

    const at = Date.parse(SEND_ISO) as Instant
    const logBefore = asLog((await readConsentLogs(sql, [contactId])).get(contactId) as never)
    expect(resolveConsent(logBefore, 'sms', 'marketing', at).state).toBe('unknown')

    // 2. The capture itself, through the repository the booking handler calls, with the version and the
    //    hash the form carried — which is what makes the record a claim about the words THIS reader saw.
    const recorded = await withUnitOfWork(sql, ACTOR, async (uow) =>
      recordConsent(uow, {
        contactCustomerId: contactId,
        channel: 'sms',
        purpose: 'marketing',
        kind: 'granted',
        recordedAtIso: CAPTURED_ISO,
        wordingId: wording.id,
        wordingHashHex: wording.contentHashHex,
        capture: {
          source: 'booking_form',
          actorKind: 'customer',
          actorLabel: 'Customer (fixture, at the confirm step)',
          locale: 'en',
        },
      }),
    )
    expect(recorded.recorded).toBe(true)
    expect(recorded.row.consentWordingId).toBe(wording.id)
    expect(recorded.row.wordingHashHex).toBe(wording.contentHashHex)

    // 3. The resolver, and therefore the gate, now answers differently — which is the end of the chain
    //    this acceptance line is about: the floor is a floor and not a wall.
    const logAfter = asLog((await readConsentLogs(sql, [contactId])).get(contactId) as never)
    const resolution = resolveConsent(logAfter, 'sms', 'marketing', at)
    expect(resolution.state).toBe('granted')
    if (resolution.state !== 'granted') return
    expect(resolution.wordingVersion).toBe(wording.version)
    expect(resolution.wordingHashHex).toBe(wording.contentHashHex)

    const suppressionLogs = await readSuppressionLogs(sql, keying, [
      { keyKind: 'phone', recipient: number },
    ])
    const evaluators = promotionalGateEvaluators({
      purpose: 'marketing',
      at,
      reads: {
        consentLogs: new Map([[number, logAfter]]),
        suppressionLogs: new Map(
          [...suppressionLogs].map(([recipient, read]) => [
            recipient,
            {
              key: read.key,
              records: read.records.map((record) => ({
                ...record,
                recordedAt: record.recordedAt as Instant,
              })),
            },
          ]),
        ),
        ledgerCountedAt: new Map([[number, []]]),
        ledgerReadFrom: 0 as Instant,
      },
    })
    expect(
      evaluateGate(
        { marketingKillSwitch: false, promotionalWindow: TDRA_PROMOTIONAL_WINDOW, evaluators },
        messageTo(number, 'promotional'),
        at,
      ),
    ).toEqual({ kind: 'allow' })
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Y9-import-ledger — the decision, demonstrated
// ------------------------------------------------------------------------------------------------

describe('the staging ledger holds no number, and an erasure is therefore complete', () => {
  it('stages a digest the ledger cannot resolve, and leaves the plaintext only on the customer', async () => {
    const list = buildContactList({ baseIndex: BAND.ledger, distinct: 6, claimEvery: 2 })
    const report = await importList(list, 'ledger.tsv')

    // Every payload this run staged, as text. The claim is about what the ledger HOLDS, so it is read
    // back out of the ledger rather than taken from the plan.
    const staged = await sql<{ payload: string }[]>`
      select payload::text as payload from import_staging.import_row
       where run_id = ${report.runId}::uuid
    `
    expect(staged).toHaveLength(list.lines)

    /*
      The scan is over each payload with its DIGEST lifted out, and the digest is held to being 64 hex
      characters instead. That is a correctness fix the property test in `@berelax/migration` found first
      and this case reproduced: a four-digit run matches a window of a 64-character hex digest by chance
      often enough to fail, and `9715` — the leading digits of every UAE number — found one on the first
      run. A property that fails on coincidences gets deleted, so the claim is decomposed rather than
      widened. Both halves are needed: the scan alone would miss a number put into a new key, and the
      shape check alone would miss one put into `pepperVersion` or `quarantineReason`.
    */
    const runs = new Set<string>()
    for (const number of list.numbers) {
      const digits = number.replace(/\D/g, '')
      for (let at = 0; at + 4 <= digits.length; at += 1) runs.add(digits.slice(at, at + 4))
    }
    for (const row of staged) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      expect(payload['contactHmac'], 'the staged digest is a keyed digest').toMatch(
        /^[a-f0-9]{64}$/,
      )
      const { contactHmac: _, ...rest } = payload
      const scannable = JSON.stringify(rest)
      for (const run of runs) {
        expect(scannable, `${run} reached the ledger outside the digest`).not.toContain(run)
      }
      // Every key is a minimised one, so there is nowhere else a number could be.
      for (const key of Object.keys(payload)) {
        expect(MINIMISED_PAYLOAD_KEYS as readonly string[]).toContain(key)
      }
    }

    // The control: the digest IS resolvable from the customer's own number — so the case above is about
    // the ledger holding a digest rather than about it holding nothing.
    const hmac = importContactHmac(pepper, IMPORT_CONTACT_KEY_KINDS.number, list.numbers[0] ?? '')
    expect(staged.map((row) => row.payload).join('\n')).toContain(hmac)
    expect(await readImportedContactsForNumber(sql, pepper, list.numbers[0] ?? '')).not.toEqual([])
  }, 60_000)

  it('erases the number and leaves the record of the import standing', async () => {
    const list = buildContactList({ baseIndex: BAND.ledger + 50, distinct: 1 })
    await importList(list, 'erasure.tsv')
    const number = list.numbers[0]
    const [customerId] = await customerIdsFor(list.numbers)
    expect(number).toBeDefined()
    expect(customerId).toBeDefined()
    if (number === undefined || customerId === undefined) return

    const importedBefore = await readImportedContactsForNumber(sql, pepper, number)
    expect(importedBefore).toHaveLength(1)

    await withUnitOfWork(sql, ACTOR, async (uow) => {
      const request = await recordRightsRequest(uow, {
        requestType: 'erasure',
        subjectCustomerId: customerId,
        receivedAtIso: RECEIVED_ISO,
        slaDays: SLA_DAYS,
        dueAtIso: DUE_ISO,
        verifiedVia: 'otp',
        actorKind: 'customer',
        actorLabel: 'Customer (fixture, OTP verified)',
        requestDetail: 'Asked for the record created from the imported contact list to be erased.',
      })
      await beginRightsRequest(uow, request.id)
      return eraseSubject(uow, deps, {
        rightsRequestId: request.id,
        erasedAtIso: ERASED_ISO,
        supervisoryAuthority: null,
        backupPosition:
          'Row-level erasure does not reach a database backup. Backups age out on their own ' +
          'schedule; no individual row is removed from one. Provisional against Y1-entity.',
        privacyRegime: 'Federal PDPL assumed (provisional, Y1-entity)',
        regimeIsProvisional: true,
        openQuestionIds: ['Y1-entity', 'Y9-import-ledger'],
      })
    })

    // 1. The number is gone from the one place it existed.
    const [row] = await sql<{ phone: string }[]>`
      select phone_e164 as phone from customer where id = ${customerId}::uuid
    `
    expect(row?.phone).toBe(erasurePseudonym(customerId))

    // 2. The record of the import is still there — it is append-only (ZY272) and it is the evidence that
    //    this record was created from a contact list with no consent.
    const stillThere = await sql<{ n: string }[]>`
      select count(*)::text as n from imported_contact
       where contact_hmac = ${importContactHmac(pepper, IMPORT_CONTACT_KEY_KINDS.number, number)}
    `
    expect(Number(stillThere[0]?.n ?? '0')).toBe(importedBefore.length)

    // 3. And it no longer resolves to a person: the digest is recomputed from `customer.phone_e164`, so
    //    once that is a pseudonym nothing in this database joins the two. That is the whole of the
    //    Y9-import-ledger decision — the ledger keeps evidence, not an identifier.
    const [survivor] = await sql<{ n: string }[]>`
      select count(*)::text as n from customer
       where phone_e164 = ${number} or phone_e164 = ${erasurePseudonym(customerId)}
    `
    // `survivor` is the ROW, not the result set: `const [x] = await sql` has already taken the first
    // element. The first version of this line read `survivor[0]?.n`, which is `undefined`, which the
    // `?? '0'` then turned into a confident zero — a reading that cannot be told from a real answer.
    // The suite reported "expected +0 to be 1" about a query that had returned 1.
    expect(Number(survivor?.n ?? 'not a count')).toBe(1)
    const reachable = await sql<{ n: string }[]>`
      select count(*)::text as n from customer where phone_e164 = ${number}
    `
    expect(Number(reachable[0]?.n ?? '0')).toBe(0)
    // The erased subject is deliberately NOT added to the cleanup list — see `afterAll`.
    const index = created.indexOf(number)
    if (index >= 0) created.splice(index, 1)
  }, 90_000)
})

// ------------------------------------------------------------------------------------------------
// The refusals the database makes about this unit's own table
// ------------------------------------------------------------------------------------------------

describe('the imported-contact record', () => {
  const sqlstateOf = (error: unknown): string =>
    (error as { code?: string }).code ?? String((error as Error).message)

  it('refuses an UPDATE and a DELETE by name (ZY272)', async () => {
    const rows = await sql<{ id: string }[]>`select id from imported_contact limit 1`
    const id = rows[0]?.id
    expect(id, 'an imported-contact record exists from a case above').toBeDefined()
    if (id === undefined) return

    for (const statement of [
      sql`update imported_contact set outcome = 'matched' where id = ${id}::uuid`,
      sql`delete from imported_contact where id = ${id}::uuid`,
    ]) {
      const code = await statement.then(() => 'accepted').catch(sqlstateOf)
      expect(code).toBe(IMPORT_CONTACT_SQLSTATE.importedContactImmutable)
    }
  })

  it('refuses a record that names no staged source row, and one whose outcome disagrees (ZY273)', async () => {
    // Both halves, because the second matters as much as the first: a `matched` record whose line DID
    // create a customer is a customer nothing accounts for, and no count would show it.
    const bare = await sql
      .begin(async (tx) => {
        await tx`
          insert into imported_contact
            (contact_hmac, pepper_version, outcome, consent_claim_discarded)
          values (${'d'.repeat(64)}, 'fixture', 'created', false)
        `
        await tx`set constraints all immediate`
        return 'accepted'
      })
      .catch(sqlstateOf)
    expect(bare).toBe(IMPORT_CONTACT_SQLSTATE.outcomeDisagreesWithTheImport)

    // The control: the same row WITH provenance to a staged row that created a customer is accepted, so
    // the refusal above is about the missing provenance rather than about the table refusing everything.
    const accepted = await sql
      .begin(async (tx) => {
        const [run] = await tx<{ id: string }[]>`
          insert into import_staging.import_run
            (importer, importer_version, source_file, source_file_hash, mode, state, target_tables,
             actor_label)
          values ('customers', '1', 'zy273-control.tsv', ${'e'.repeat(64)}, 'live', 'running',
                  ${CUSTOMERS_IMPORTER_TARGETS as unknown as string[]}::text[], 'H-MIG-04 fixture probe')
          returning id
        `
        const [staged] = await tx<{ id: string }[]>`
          insert into import_staging.import_row (run_id, line_number, row_hash, payload, state)
          values (${run?.id ?? ''}::uuid, 1, ${'f'.repeat(64)}, '{}'::jsonb, 'pending')
          returning id
        `
        const [customer] = await tx<{ id: string }[]>`
          insert into customer (phone_e164, created_via) values ('+971590099991', 'import')
          returning id
        `
        const [record] = await tx<{ id: string }[]>`
          insert into imported_contact
            (contact_hmac, pepper_version, outcome, consent_claim_discarded)
          values (${'a'.repeat(64)}, 'fixture', 'created', false)
          returning id
        `
        for (const target of [
          { table: 'imported_contact', id: record?.id ?? '' },
          { table: 'customer', id: customer?.id ?? '' },
        ]) {
          await tx`
            insert into import_staging.import_provenance
              (import_row_id, target_schema, target_table, target_id)
            values (${staged?.id ?? ''}::uuid, 'public', ${target.table}, ${target.id})
          `
        }
        await tx`set constraints all immediate`
        throw new Error('rollback the ZY273 control')
      })
      .then(() => 'committed')
      .catch((error: unknown) =>
        error instanceof Error && error.message === 'rollback the ZY273 control'
          ? 'accepted'
          : sqlstateOf(error),
      )
    expect(accepted).toBe('accepted')
  })
})
