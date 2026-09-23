import {
  type ConsentLog,
  type ConsentRecord,
  consentGateEvaluator,
  type Instant,
  instantFromIso,
  normalisePhone,
  resolveConsent,
} from '@berelax/core'
import {
  type Actor,
  CONSENT_AUDIT_ACTIONS,
  CONSENT_SQLSTATE,
  CONSENT_WORDING_DRAFTS,
  CONSENT_WORDING_OPEN_QUESTION,
  type ConsentLogRead,
  consentRefusalOf,
  consentStateCounts,
  consentWordingHash,
  consentWordingIntegrity,
  createConnection,
  publishConsentWording,
  readConsentLog,
  readConsentLogs,
  readConsentPurposes,
  readContactsByPhone,
  readCurrentConsentWording,
  recordConsent,
  type Sql,
  seedConsent,
  unconfirmedAssumptionRows,
  withdrawConsent,
  withUnitOfWork,
} from '@berelax/db'
import {
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  InMemoryOutbox,
  type MessageId,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  type SendRequest,
  sendMessage,
  TDRA_PROMOTIONAL_WINDOW,
  type TransportRequest,
} from '@berelax/messaging'
import {
  CONSENT_CAPTURE_SOURCES,
  CONSENT_PURPOSES,
  SEND_GATING_CONSENT_PURPOSES,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_NOW, FIXTURE_NOW_ISO } from './clock.ts'
import { CONSENT_SEED_INDEXES, consentSeedContacts } from './load.ts'
import { syntheticPerson } from './synthetic.ts'

/**
 * C-CRM-03 — the consent record, the wording hash, the append-only guarantees, and the resolver joined
 * to the send choke point.
 *
 * `packages/fixtures` is the only package that may import both halves, and every claim here is a claim
 * about the pair: `resolveConsent` is pure and lives in `@berelax/core`, the rows live in PostgreSQL and
 * `@berelax/db` writes them, and neither package may import the other. So `ConsentLogRead` is asserted to
 * BE what the resolver takes, with `satisfies`, rather than described in a comment.
 *
 * ## Isolation, and the append-only rule
 *
 * `consent` and `consent_wording` refuse DELETE for every role including the owner, so **nothing in this
 * file is cleaned up** and nothing may be asserted as a total (ADR 0008, brief rules 9 and 12). Three
 * consequences, all deliberate:
 *
 *   - every count is either a DELTA measured in SQL around a body, or a count narrowed to this file's own
 *     contact ids;
 *   - the probe contacts are keyed on FIXED synthetic phone numbers and their rows on FIXED instants, so
 *     `consent_one_record_per_instant` makes a second run of the suite against the same database a no-op
 *     rather than an accumulation;
 *   - the fixture contacts are re-seeded in `beforeAll`. `customer-identity.itest.ts` clears the whole
 *     `customer` table between its cases, so a file that assumed the loader's four contacts were still
 *     there would pass or fail on vitest's file ordering. `seedConsent` is idempotent, and re-running it
 *     is isolation by construction rather than by luck.
 *
 * Anything that must be REFUSED, and the wording tamper, run inside a transaction that always rolls back
 * — `probe` below. A committed tamper would leave a stale hash in every later suite's view of the table,
 * and `sql.begin` COMMITS when its callback returns, so "temporary" has to be made explicit.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ACTOR: Actor = { kind: 'staff', label: 'Receptionist (fixture)' }
/** Fixed, so a second run of this suite collapses on the unique index instead of appending. */
const PROBE_AT_ISO = '2099-09-20T10:00:00.000Z'
/** Outside the fixture band (9101–9104) and outside the CRM suites' band (4411 upward). */
const PROBE_SUBJECT = syntheticPerson(9_111)
const PROBE_SECOND = syntheticPerson(9_112)

let sql: Sql
let subjectId: string
let secondId: string
let marketingWordingId: string
let marketingWordingHash: string

/** The capture context every probe uses. Whole, because the schema and the database both demand it. */
const CAPTURE = {
  source: 'front_desk',
  actorKind: 'staff',
  actorLabel: 'Receptionist (fixture)',
  locale: 'en',
} as const

const asStaff = <T>(
  body: (uow: Parameters<Parameters<typeof withUnitOfWork>[2]>[0]) => Promise<T>,
) => withUnitOfWork(sql, ACTOR, body)

/** Counted in SQL, never through a capped reader: `audit_event` only grows (brief rule 12). */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

/** The delta a body produces in one audit action. The only shape an append-only assertion may take. */
async function auditDelta<T>(action: string, body: () => Promise<T>): Promise<[number, T]> {
  const before = await auditCount(action)
  const result = await body()
  return [(await auditCount(action)) - before, result]
}

/** Consent rows for one contact, counted in SQL. Narrowed, so another suite's rows cannot satisfy it. */
async function consentRowCount(contactId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from consent where contact_customer_id = ${contactId}
  `
  return Number(row?.n ?? '0')
}

const ROLLBACK = 'ccrm03 rollback'

/**
 * Runs a body in a transaction that is ALWAYS rolled back, and carries its answer out.
 *
 * The helper `crm-client-record.itest.ts` and `business-seed.itest.ts` use, for the same reason: `sql.begin`
 * COMMITS when its callback returns. Two cases below have to break something the whole database shares —
 * a published wording's text, the refusal triggers themselves — and either surviving would corrupt the
 * consent estate for every suite that runs after this file, presenting as a failure nobody touched.
 */
async function probe<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (tx) => {
      carried = await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err
  }
  return carried as T
}

/** The SQLSTATE a statement raised, or null when it did not raise. */
async function sqlstateOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (error) {
    return typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null
  }
}

/**
 * The db read, narrowed to the resolver's own type.
 *
 * `satisfies` would not do on its own: `recordedAt` is a plain `number` on the db side (the package may
 * not import core's `Instant` brand) so the cast is unavoidable, and the membership assertions are what
 * make it honest rather than hopeful — the same arrangement `asFacts` has in `crm-client-record.itest.ts`.
 * Everything else is spread whole, so a field the resolver requires and the reader stopped producing is a
 * compile error on this function.
 */
function asLog(read: ConsentLogRead): ConsentLog {
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

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  // Re-seed the fixture contacts and the wording. Idempotent, and the reason is in the header.
  await seedConsent(sql, { contacts: consentSeedContacts(), recordedAtIso: FIXTURE_NOW_ISO })

  for (const person of [PROBE_SUBJECT, PROBE_SECOND]) {
    await sql`
      insert into customer (phone_e164, locale, created_via) values (${normalisePhone(person.phone)}, 'en', 'front_desk')
      on conflict (phone_e164) do nothing
    `
  }
  const [subject] = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = ${normalisePhone(PROBE_SUBJECT.phone)}
  `
  const [second] = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = ${normalisePhone(PROBE_SECOND.phone)}
  `
  subjectId = (subject as { id: string }).id
  secondId = (second as { id: string }).id

  const marketing = await readCurrentConsentWording(sql, 'marketing')
  if (marketing === null) throw new Error('The consent seed left no marketing wording version.')
  marketingWordingId = marketing.id
  marketingWordingHash = marketing.contentHashHex
})

afterAll(async () => {
  // `consent`, `consent_wording` and `audit_event` are append-only and are deliberately NOT cleaned:
  // every assertion above is either a delta or narrowed to this file's own contact ids, and the probe
  // contacts are kept so a second run reuses their ids and collapses on the unique index. Deleting the
  // customer rows would strand this run's consent rows and make the next run's ids different, which is
  // the accumulation the fixed instants exist to prevent.
  await sql?.end({ timeout: 5 })
})

describe('the db read is exactly what the pure resolver takes', () => {
  it('reads a log the resolver accepts, and resolves it', async () => {
    const granted = syntheticPerson(CONSENT_SEED_INDEXES.granted)
    const [contact] = await readContactsByPhone(sql, [normalisePhone(granted.phone)])
    expect(contact, 'the granted fixture contact is seeded').toBeDefined()
    const read = await readConsentLog(sql, (contact as { contactId: string }).contactId)
    // The structural claim: `ConsentLogRead` IS a `ConsentLog` but for the instant's brand.
    const log = asLog(read)
    expect(log satisfies ConsentLog).toBeDefined()
    const answer = resolveConsent(log, 'sms', 'marketing', FIXTURE_NOW)
    expect(answer.state).toBe('granted')
    if (answer.state !== 'granted') return
    // The wording version travelled with it, which is what makes the grant a proof rather than a flag.
    expect(answer.wordingVersion).toBe(1)
    expect(answer.wordingHashHex).toBe(marketingWordingHash)
  })

  it('reads an EMPTY log for a contact with no records, rather than omitting it', async () => {
    const never = syntheticPerson(CONSENT_SEED_INDEXES.never_asked)
    const [contact] = await readContactsByPhone(sql, [normalisePhone(never.phone)])
    const contactId = (contact as { contactId: string }).contactId
    const logs = await readConsentLogs(sql, [contactId])
    // Present with no records, not absent. The distinction is what keeps "never asked" out of
    // `blocked_unevaluable` — see `consentGateEvaluator`.
    expect(logs.has(contactId)).toBe(true)
    expect(logs.get(contactId)?.records).toEqual([])
    expect(
      resolveConsent(asLog(logs.get(contactId) as ConsentLogRead), 'sms', 'marketing', FIXTURE_NOW)
        .state,
    ).toBe('unknown')
  })

  it('batches the prefetch without mixing the records of one contact into another', async () => {
    // The grouping a campaign depends on. `readConsentLogs` reads every contact's records in ONE query
    // and splits them in memory, so the failure mode it has to be checked against is a split that leaks:
    // the granted contact's rows appearing under the never-asked one would make the whole campaign
    // sendable, and every single-contact assertion in this file would still pass.
    const wanted = [
      CONSENT_SEED_INDEXES.granted,
      CONSENT_SEED_INDEXES.withdrawn,
      CONSENT_SEED_INDEXES.never_asked,
    ].map((index) => normalisePhone(syntheticPerson(index).phone))
    const contacts = await readContactsByPhone(sql, wanted)
    expect(contacts).toHaveLength(3)
    const logs = await readConsentLogs(
      sql,
      contacts.map((contact) => contact.contactId),
    )
    expect(logs.size).toBe(3)
    for (const contact of contacts) {
      const log = logs.get(contact.contactId) as ConsentLogRead
      // Every record in this contact's log is about this contact, which is what the split has to preserve.
      expect(log.contactId).toBe(contact.contactId)
      const single = await readConsentLog(sql, contact.contactId)
      // And the batched read agrees with the single read, record for record and in the same order.
      expect(log.records).toEqual(single.records)
    }
    // The three states, read back through the batch rather than one at a time.
    const stateOf = (phone: string) => {
      const contactId = contacts.find((c) => c.phoneE164 === phone)?.contactId as string
      return resolveConsent(
        asLog(logs.get(contactId) as ConsentLogRead),
        'sms',
        'marketing',
        // After the seeded withdrawal, so the withdrawn contact reads as withdrawn rather than as the
        // grant it still carries one minute earlier.
        instantFromIso('2026-09-18T11:00:00.000Z'),
      ).state
    }
    expect(wanted.map(stateOf)).toEqual(['granted', 'withdrawn', 'unknown'])
  })
})

describe('acceptance — UPDATE and DELETE raise, and a withdrawal is a new row', () => {
  it('records a grant, then a withdrawal, and leaves the granting row byte-identical', async () => {
    const [delta, granted] = await auditDelta(CONSENT_AUDIT_ACTIONS.recorded, () =>
      asStaff((uow) =>
        recordConsent(uow, {
          contactCustomerId: subjectId,
          channel: 'sms',
          purpose: 'marketing',
          kind: 'granted',
          recordedAtIso: PROBE_AT_ISO,
          wordingId: marketingWordingId,
          wordingHashHex: marketingWordingHash,
          capture: CAPTURE,
        }),
      ),
    )
    // On a re-run of the suite the insert is a no-op, so the audit delta is 0 and `recorded` is false.
    // Asserted as agreeing rather than as a fixed number, which is what makes this idempotent AND not
    // vacuous: one of the two branches must hold, and they cannot both.
    expect(delta).toBe(granted.recorded ? 1 : 0)
    const grantRow = granted.row

    const before = await consentRowCount(subjectId)
    const withdrawn = await asStaff((uow) =>
      withdrawConsent(uow, {
        contactCustomerId: subjectId,
        channel: 'sms',
        purpose: 'marketing',
        recordedAtIso: '2099-09-21T10:00:00.000Z',
        wordingId: null,
        wordingHashHex: null,
        capture: { ...CAPTURE, source: 'preference_centre' },
      }),
    )
    expect(withdrawn.row.kind).toBe('withdrawn')
    expect(withdrawn.row.id).not.toBe(grantRow.id)
    // A NEW row. Counted as a delta, because the table only grows.
    expect(await consentRowCount(subjectId)).toBe(before + (withdrawn.recorded ? 1 : 0))

    // And the granting row is exactly as it was: read back and compared field by field.
    const [reread] = await sql<
      { kind: string; recorded_at: Date; consent_wording_id: string; capture_source: string }[]
    >`
      select kind::text as kind, recorded_at, consent_wording_id, capture_source
        from consent where id = ${grantRow.id}
    `
    expect(reread).toEqual({
      kind: 'granted',
      recorded_at: grantRow.recordedAt,
      consent_wording_id: marketingWordingId,
      capture_source: 'front_desk',
    })
  })

  it('refuses UPDATE and DELETE on a consent row, for the table owner', async () => {
    // The owner, not the application role. `revoke update, delete from berelax_app` covers the
    // application; the trigger is what covers a migration and a psql session, which is where a
    // "one-off correction" actually comes from.
    const [row] = await sql<{ id: string }[]>`
      select id from consent where contact_customer_id = ${subjectId} and kind = 'granted' limit 1
    `
    const id = (row as { id: string }).id
    expect(await sqlstateOf(sql`update consent set capture_locale = 'ar' where id = ${id}`)).toBe(
      CONSENT_SQLSTATE.consentImmutable,
    )
    expect(await sqlstateOf(sql`delete from consent where id = ${id}`)).toBe(
      CONSENT_SQLSTATE.consentImmutable,
    )
    // The control: the row is still there and still says what it said. A trigger that raised and let the
    // change through would satisfy both assertions above.
    const [after] = await sql<{ capture_locale: string }[]>`
      select capture_locale from consent where id = ${id}
    `
    expect((after as { capture_locale: string }).capture_locale).toBe('en')
  })

  it('refuses UPDATE and DELETE on a published wording row, for the table owner', async () => {
    expect(
      await sqlstateOf(
        sql`update consent_wording set text_en = text_en || ' amended' where id = ${marketingWordingId}`,
      ),
    ).toBe(CONSENT_SQLSTATE.wordingImmutable)
    expect(
      await sqlstateOf(sql`delete from consent_wording where id = ${marketingWordingId}`),
    ).toBe(CONSENT_SQLSTATE.wordingImmutable)
    const [after] = await sql<{ text_en: string }[]>`
      select text_en from consent_wording where id = ${marketingWordingId}
    `
    expect((after as { text_en: string }).text_en).not.toContain('amended')
  })

  it('publishes a correction as version N+1 rather than editing version N', async () => {
    const [delta, published] = await auditDelta(CONSENT_AUDIT_ACTIONS.wordingPublished, () =>
      asStaff((uow) =>
        publishConsentWording(uow, {
          purpose: 'photography',
          textEn: `[DRAFT WORDING — not approved copy] Correction ${PROBE_AT_ISO}.`,
          textAr: `[صياغة مسودة — ليست نصًا معتمدًا] تصحيح ${PROBE_AT_ISO}.`,
          publishedAtIso: PROBE_AT_ISO,
          isProvisional: true,
          openQuestionId: CONSENT_WORDING_OPEN_QUESTION,
          provisionalNote: 'Published by the C-CRM-03 integration suite.',
        }),
      ),
    )
    expect(delta).toBe(1)
    expect(published.version).toBeGreaterThan(1)
    // Version 1 is still there, unchanged, which is what an old consent row's proof depends on.
    const [first] = await sql<{ text_en: string }[]>`
      select text_en from consent_wording where purpose = 'photography' and version = 1
    `
    expect((first as { text_en: string }).text_en).toBe(
      CONSENT_WORDING_DRAFTS.find((draft) => draft.purpose === 'photography')?.textEn,
    )
  })
})

describe('acceptance — a consent row whose wording hash does not match is rejected', () => {
  it('refuses a snapshot hash computed over TAMPERED text — the known-bad fixture', async () => {
    const wording = await readCurrentConsentWording(sql, 'marketing')
    const stored = wording as NonNullable<typeof wording>
    // The tamper: the words the record CLAIMS were shown, which differ from the words stored by one
    // sentence. The hash is computed by the database's own function, so this is not a wrong hash — it is
    // the right hash of the wrong text, which is the only interesting case.
    const tampered = await consentWordingHash(sql, {
      textEn: `${stored.textEn} We may also share your number with partners.`,
      textAr: stored.textAr,
    })
    expect(tampered).not.toBe(stored.contentHashHex)

    let caught: unknown
    await probe(async (tx) => {
      try {
        await tx`
          insert into consent
            (contact_customer_id, channel, purpose, kind, recorded_at, consent_wording_id, wording_hash,
             capture_source, capture_actor_kind, capture_actor_label, capture_locale)
          values (${secondId}, 'sms', 'marketing', 'granted', ${PROBE_AT_ISO}::timestamptz,
                  ${stored.id}, decode(${tampered}, 'hex'), 'front_desk', 'staff', 'Receptionist', 'en')
        `
      } catch (error) {
        caught = error
      }
    })
    expect((caught as { code?: string } | undefined)?.code).toBe(
      CONSENT_SQLSTATE.wordingHashMismatch,
    )

    // The control, in the same transaction shape: the TRUE hash is accepted. Without it, "the insert was
    // rejected" would be satisfied by a trigger that rejected everything.
    const accepted = await probe(async (tx) => {
      const rows = await tx`
        insert into consent
          (contact_customer_id, channel, purpose, kind, recorded_at, consent_wording_id, wording_hash,
           capture_source, capture_actor_kind, capture_actor_label, capture_locale)
        values (${secondId}, 'sms', 'marketing', 'granted', ${PROBE_AT_ISO}::timestamptz,
                ${stored.id}, decode(${stored.contentHashHex}, 'hex'), 'front_desk', 'staff',
                'Receptionist', 'en')
        returning id
      `
      return rows.length
    })
    expect(accepted).toBe(1)
  })

  it('reports the refusal by name through the repository', async () => {
    const stored = (await readCurrentConsentWording(sql, 'marketing')) as NonNullable<
      Awaited<ReturnType<typeof readCurrentConsentWording>>
    >
    const wrong = await consentWordingHash(sql, {
      textEn: 'Something else entirely.',
      textAr: stored.textAr,
    })
    let caught: unknown
    try {
      await asStaff((uow) =>
        recordConsent(uow, {
          contactCustomerId: secondId,
          channel: 'whatsapp',
          purpose: 'marketing',
          kind: 'granted',
          recordedAtIso: PROBE_AT_ISO,
          wordingId: stored.id,
          wordingHashHex: wrong,
          capture: CAPTURE,
        }),
      )
    } catch (error) {
      caught = error
    }
    expect(consentRefusalOf(caught)).toBe('consent_wording_hash_mismatch')
  })

  it('detects a wording row edited under the trigger, through the stored snapshot', async () => {
    // Nothing should ever be able to do this: the application role cannot UPDATE the table and the
    // trigger raises for the owner too. It is reachable only by the owner disabling the trigger, which is
    // what a "quick fix in psql" looks like — and `content_hash` is GENERATED, so the wording row stays
    // internally consistent afterwards. The consent rows' snapshots are the ONLY surviving evidence.
    expect(await consentWordingIntegrity(sql)).toEqual([])
    const breaches = await probe(async (tx) => {
      await tx`alter table consent_wording disable trigger consent_wording_no_update`
      await tx`
        update consent_wording
           set text_en = text_en || ' We may also share your number with partners.'
         where id = ${marketingWordingId}
      `
      await tx`alter table consent_wording enable trigger consent_wording_no_update`
      return consentWordingIntegrity(tx)
    })
    expect(breaches.length).toBeGreaterThan(0)
    expect(breaches.every((breach) => breach.consentWordingId === marketingWordingId)).toBe(true)
    expect(breaches[0]?.snapshotHashHex).not.toBe(breaches[0]?.currentHashHex)
    // Rolled back, so the wording is intact for every later suite — and the integrity query is clean
    // again, which is also the control that it was not simply reporting every row.
    expect(await consentWordingIntegrity(sql)).toEqual([])
  })
})

describe('acceptance — the capture context is mandatory at the DATABASE, not only in zod', () => {
  /** The accepted insert, with one column overridden. The defaults are a row the database takes. */
  const captureInsert = (tx: Sql, overrides: Record<string, string | null> = {}) => {
    const values = {
      capture_source: 'front_desk',
      capture_actor_kind: 'staff',
      capture_actor_label: 'Receptionist',
      capture_locale: 'en',
      ...overrides,
    }
    return tx`
      insert into consent
        (contact_customer_id, channel, purpose, kind, recorded_at, consent_wording_id, wording_hash,
         capture_source, capture_actor_kind, capture_actor_label, capture_locale)
      values (${secondId}, 'email', 'marketing', 'granted', ${PROBE_AT_ISO}::timestamptz,
              ${marketingWordingId}, decode(${marketingWordingHash}, 'hex'),
              ${values.capture_source}, ${values.capture_actor_kind}, ${values.capture_actor_label},
              ${values.capture_locale})
    `
  }

  it('accepts a whole capture, so every refusal below is about the omission', async () => {
    const accepted = await probe(async (tx) => {
      await captureInsert(tx)
      const [row] = await tx<{ n: string }[]>`
        select count(*)::text as n from consent
         where contact_customer_id = ${secondId} and channel = 'email'
      `
      return Number((row as { n: string }).n)
    })
    expect(accepted).toBe(1)
  })

  it('refuses a NULL source, actor kind, actor label or locale, naming the column', async () => {
    for (const column of [
      'capture_source',
      'capture_actor_kind',
      'capture_actor_label',
      'capture_locale',
    ]) {
      const state = await probe((tx) => sqlstateOf(captureInsert(tx, { [column]: null })))
      // 23502 is not_null_violation. The zod schema refuses the same omission with a readable message;
      // this is the half that holds against a psql session.
      expect(state, `${column} must be NOT NULL`).toBe('23502')
    }
  })

  it('refuses a blank or placeholder actor label', async () => {
    for (const label of ['', '   ', 'TBC', 'pending']) {
      const state = await probe((tx) =>
        sqlstateOf(captureInsert(tx, { capture_actor_label: label })),
      )
      expect(state, `"${label}" must be refused`).toBe('23514')
    }
  })

  it('refuses a source or locale outside the closed sets', async () => {
    expect(
      await probe((tx) => sqlstateOf(captureInsert(tx, { capture_source: 'email_blast' }))),
    ).toBe('23514')
    expect(await probe((tx) => sqlstateOf(captureInsert(tx, { capture_locale: 'fr' })))).toBe(
      '23514',
    )
    expect(
      await probe((tx) => sqlstateOf(captureInsert(tx, { capture_actor_kind: 'agent' }))),
    ).toBe('23514')
    // The control: every source the contract declares IS accepted, so the CHECK is not narrower than the
    // vocabulary. A closed set the application can spell and the database cannot is a 500 on a real capture.
    for (const source of CONSENT_CAPTURE_SOURCES) {
      expect(
        await probe((tx) => sqlstateOf(captureInsert(tx, { capture_source: source }))),
        source,
      ).toBeNull()
    }
  })

  it('agrees with is_placeholder_text on every marker the edge refuses', async () => {
    // The database function is the authority and `PLACEHOLDER_MARKERS` in `@berelax/shared` is the edge's
    // readable copy. Asserted against the real function rather than against the comment beside it.
    const rows = await sql<{ marker: string; refused: boolean }[]>`
      select m.marker, is_placeholder_text(m.marker) as refused
        from unnest(array['[confirm]','to be confirmed','tbc','tbd','pending','placeholder',
                          'not configured','unknown','todo','xxx','Customer 9101']) as m(marker)
    `
    for (const row of rows) {
      expect(row.refused, row.marker).toBe(row.marker !== 'Customer 9101')
    }
  })

  it('refuses a GRANT with no wording version, and accepts a WITHDRAWAL without one', async () => {
    const granted = await probe((tx) =>
      sqlstateOf(tx`
        insert into consent
          (contact_customer_id, channel, purpose, kind, recorded_at, capture_source,
           capture_actor_kind, capture_actor_label, capture_locale)
        values (${secondId}, 'email', 'review_request', 'granted', ${PROBE_AT_ISO}::timestamptz,
                'front_desk', 'staff', 'Receptionist', 'en')
      `),
    )
    expect(granted).toBe('23514')
    const withdrawn = await probe((tx) =>
      sqlstateOf(tx`
        insert into consent
          (contact_customer_id, channel, purpose, kind, recorded_at, capture_source,
           capture_actor_kind, capture_actor_label, capture_locale)
        values (${secondId}, 'email', 'review_request', 'withdrawn', ${PROBE_AT_ISO}::timestamptz,
                'preference_centre', 'customer', 'Customer 9112', 'en')
      `),
    )
    expect(withdrawn).toBeNull()
  })

  it('refuses a half-stated wording reference', async () => {
    const state = await probe((tx) =>
      sqlstateOf(tx`
        insert into consent
          (contact_customer_id, channel, purpose, kind, recorded_at, consent_wording_id,
           capture_source, capture_actor_kind, capture_actor_label, capture_locale)
        values (${secondId}, 'email', 'photography', 'granted', ${PROBE_AT_ISO}::timestamptz,
                ${marketingWordingId}, 'front_desk', 'staff', 'Receptionist', 'en')
      `),
    )
    expect(state).toBe('23514')
  })
})

describe('the wording row states both languages, and the database says so', () => {
  const wordingInsert = (tx: Sql, over: { textEn?: string; textAr?: string } = {}) => tx`
    insert into consent_wording
      (purpose, version, text_en, text_ar, published_at, is_provisional, open_question_id,
       provisional_note)
    values ('photography', 99, ${over.textEn ?? 'A stated English consent statement.'},
            ${over.textAr ?? 'صياغة عربية مذكورة بالكامل.'}, ${PROBE_AT_ISO}::timestamptz,
            true, ${CONSENT_WORDING_OPEN_QUESTION}, 'probe')
  `

  it('accepts a stated pair', async () => {
    expect(await probe((tx) => sqlstateOf(wordingInsert(tx)))).toBeNull()
  })

  it('refuses the English text pasted into the Arabic column', async () => {
    const same = 'A stated English consent statement.'
    expect(await probe((tx) => sqlstateOf(wordingInsert(tx, { textEn: same, textAr: same })))).toBe(
      '23514',
    )
  })

  it('refuses an Arabic column with no Arabic script in it', async () => {
    expect(
      await probe((tx) => sqlstateOf(wordingInsert(tx, { textAr: 'Nous enverrons des offres.' }))),
    ).toBe('23514')
  })

  it('refuses a blank or placeholder text in either language', async () => {
    expect(await probe((tx) => sqlstateOf(wordingInsert(tx, { textEn: '   ' })))).toBe('23514')
    expect(await probe((tx) => sqlstateOf(wordingInsert(tx, { textEn: 'Wording TBC' })))).toBe(
      '23514',
    )
  })

  it('refuses a control character, which the hash separator depends on', async () => {
    // U+001F is what `consent_wording_hash` puts between the two texts. A text containing one could make
    // two different pairs hash identically, which is the whole ambiguity the separator removes.
    expect(
      await probe((tx) => sqlstateOf(wordingInsert(tx, { textEn: 'A stated\u001fstatement.' }))),
    ).toBe('23514')
  })

  it('computes a hash that distinguishes a re-split pair', async () => {
    // The separator's own assertion, against the real function. Without it ('ab','c') and ('a','bc')
    // share a hash, so the English text could be moved into the Arabic column and back with the record's
    // proof never moving.
    const left = await consentWordingHash(sql, { textEn: 'ab', textAr: 'c' })
    const right = await consentWordingHash(sql, { textEn: 'a', textAr: 'bc' })
    expect(left).not.toBe(right)
    // And it is deterministic, which is what makes it usable as a snapshot at all.
    expect(await consentWordingHash(sql, { textEn: 'ab', textAr: 'c' })).toBe(left)
  })
})

describe('an ambiguous log resolves to unknown, end to end', () => {
  it('stores a grant and a withdrawal at the identical instant rather than dropping one', async () => {
    // `kind` is in `consent_one_record_per_instant` precisely so this pair is STORED. If it were not, the
    // repository's `on conflict do nothing` would discard the withdrawal in silence, which is the one
    // outcome this table exists to prevent.
    const tie = '2099-10-01T10:00:00.000Z'
    const rows = await probe(async (tx) => {
      const uow = { sql: tx, audit: { record: async () => {} }, publish: async () => null }
      await recordConsent(uow as never, {
        contactCustomerId: secondId,
        channel: 'sms',
        purpose: 'review_request',
        kind: 'granted',
        recordedAtIso: tie,
        wordingId: marketingWordingId,
        wordingHashHex: marketingWordingHash,
        capture: CAPTURE,
      })
      await withdrawConsent(uow as never, {
        contactCustomerId: secondId,
        channel: 'sms',
        purpose: 'review_request',
        recordedAtIso: tie,
        wordingId: null,
        wordingHashHex: null,
        capture: { ...CAPTURE, source: 'preference_centre' },
      })
      const log = await readConsentLog(tx, secondId)
      return resolveConsent(asLog(log), 'sms', 'review_request', instantFromIso(tie))
    })
    expect(rows.state).toBe('unknown')
    if (rows.state !== 'unknown') return
    expect(rows.reason).toBe('ambiguous_timestamp')
    expect(rows.tiedRecordIds).toHaveLength(2)
  })

  it('refuses an EXACT duplicate of one event, so a double submit is one record', async () => {
    const duplicate = await probe(async (tx) => {
      const uow = { sql: tx, audit: { record: async () => {} }, publish: async () => null }
      const first = await recordConsent(uow as never, {
        contactCustomerId: secondId,
        channel: 'whatsapp',
        purpose: 'review_request',
        kind: 'granted',
        recordedAtIso: '2099-10-02T10:00:00.000Z',
        wordingId: marketingWordingId,
        wordingHashHex: marketingWordingHash,
        capture: CAPTURE,
      })
      const second = await recordConsent(uow as never, {
        contactCustomerId: secondId,
        channel: 'whatsapp',
        purpose: 'review_request',
        kind: 'granted',
        recordedAtIso: '2099-10-02T10:00:00.000Z',
        wordingId: marketingWordingId,
        wordingHashHex: marketingWordingHash,
        capture: CAPTURE,
      })
      return { first, second }
    })
    expect(duplicate.first.recorded).toBe(true)
    expect(duplicate.second.recorded).toBe(false)
    // And the second call still returns the record, so a retrying form is not sent round again.
    expect(duplicate.second.row.id).toBe(duplicate.first.row.id)
  })
})

describe('the vocabulary the database holds is the one the contract declares', () => {
  it('seeds exactly the four purposes, in order, all flagged provisional', async () => {
    const purposes = await readConsentPurposes(sql)
    expect(purposes.map((row) => row.purpose)).toEqual([...CONSENT_PURPOSES])
    for (const row of purposes) {
      expect(row.isProvisional, row.purpose).toBe(true)
      expect(row.openQuestionId, row.purpose).toBe('Y9-consent-purpose')
      expect((row.provisionalNote ?? '').length, row.purpose).toBeGreaterThan(20)
    }
  })

  it('agrees with SEND_GATING_CONSENT_PURPOSES on which purposes gate a send', async () => {
    const purposes = await readConsentPurposes(sql)
    expect(purposes.filter((row) => row.isSendGating).map((row) => row.purpose)).toEqual([
      ...SEND_GATING_CONSENT_PURPOSES,
    ])
    // Both directions, so "is_send_gating" is neither all-true nor all-false in the table.
    expect(purposes.filter((row) => !row.isSendGating).map((row) => row.purpose)).toEqual([
      'clinical_processing',
      'photography',
    ])
  })

  it('puts every provisional purpose and wording version on the Unconfirmed Assumptions panel', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const purposes = rows.filter((row) => row.source === 'consent_purpose')
    expect(purposes.map((row) => row.reference).sort()).toEqual([...CONSENT_PURPOSES].sort())
    for (const row of purposes) expect(row.openQuestionId).toBe('Y9-consent-purpose')

    const wording = rows.filter((row) => row.source === 'consent_wording')
    expect(wording.length).toBeGreaterThanOrEqual(CONSENT_PURPOSES.length)
    for (const row of wording) {
      expect(row.openQuestionId).toBe(CONSENT_WORDING_OPEN_QUESTION)
      expect(row.reference).toMatch(/ v\d+$/)
    }
  })

  it('leaves the panel when the flag is cleared, so the query has a WHERE clause', async () => {
    // The control on the two above. Without it, "the panel lists them" is satisfied by a query with no
    // condition at all — which is exactly the defect `business-seed.itest.ts` records for the catalogue.
    const remaining = await probe(async (tx) => {
      await tx`
        update consent_purpose set is_provisional = false, open_question_id = null,
               provisional_note = null where purpose = 'photography'
      `
      const listed = await unconfirmedAssumptionRows(tx)
      return listed.filter((row) => row.source === 'consent_purpose').length
    })
    expect(remaining).toBe(CONSENT_PURPOSES.length - 1)
  })

  it('seeds the drafted wording with a visible draft marker in BOTH languages', async () => {
    // Rule 15. A plausible consent statement in this table is indistinguishable from approved legal copy,
    // so the marker is in the text a reader sees and not only in a flag a query reads.
    for (const purpose of CONSENT_PURPOSES) {
      const [row] = await sql<{ text_en: string; text_ar: string }[]>`
        select text_en, text_ar from consent_wording where purpose = ${purpose} and version = 1
      `
      const stored = row as { text_en: string; text_ar: string }
      expect(stored.text_en, purpose).toContain('[DRAFT WORDING')
      expect(stored.text_ar, purpose).toContain('صياغة مسودة')
    }
  })
})

describe('acceptance — H03: the fixture salon shows every (channel x purpose) state', () => {
  it('has a granted, a withdrawn and a never-asked contact for every channel and purpose', async () => {
    const counts = await consentStateCounts(sql)
    const contactsIn = (channel: string, purpose: string, kind: string) =>
      counts.find((row) => row.channel === channel && row.purpose === purpose && row.kind === kind)
        ?.contacts ?? 0

    for (const channel of ['sms', 'email', 'whatsapp']) {
      for (const purpose of CONSENT_PURPOSES) {
        expect(
          contactsIn(channel, purpose, 'granted'),
          `${channel}/${purpose} granted`,
        ).toBeGreaterThan(0)
        expect(
          contactsIn(channel, purpose, 'withdrawn'),
          `${channel}/${purpose} withdrawn`,
        ).toBeGreaterThan(0)
      }
    }

    // Never-asked is the ABSENCE of a row, so it is asserted as an absence against a contact that exists.
    const never = syntheticPerson(CONSENT_SEED_INDEXES.never_asked)
    const [contact] = await readContactsByPhone(sql, [normalisePhone(never.phone)])
    expect(contact, 'the never-asked fixture contact exists as a customer').toBeDefined()
    expect(await consentRowCount((contact as { contactId: string }).contactId)).toBe(0)
  })

  it('leaves every reconstructed contact with zero promotional consent rows', async () => {
    // docs/11 §7 and Y8-customers: the business's existing customer list imports with
    // marketing_consent = false WITHOUT EXCEPTION. In an append-only model that means no promotional row
    // at all, not a row saying `withdrawn` — nobody withdrew anything and nobody was ever asked.
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n
        from consent c join customer u on u.id = c.contact_customer_id
       where u.created_via = 'import'
         and c.purpose in (select purpose from consent_purpose where is_send_gating)
    `
    expect(Number((rows[0] as { n: string }).n)).toBe(0)
    // The control, and the reason the count above is not vacuous: reconstructed contacts DO exist, and a
    // non-imported contact does have promotional rows.
    const [imported] = await sql<{ n: string }[]>`
      select count(*)::text as n from customer where created_via = 'import'
    `
    expect(Number((imported as { n: string }).n)).toBeGreaterThan(0)
    const granted = syntheticPerson(CONSENT_SEED_INDEXES.granted)
    const [grantedContact] = await readContactsByPhone(sql, [normalisePhone(granted.phone)])
    expect(
      await consentRowCount((grantedContact as { contactId: string }).contactId),
    ).toBeGreaterThan(0)
  })

  it('records both locales, so the Arabic wording column is not decoration', async () => {
    const rows = await sql<{ capture_locale: string }[]>`
      select distinct capture_locale from consent order by capture_locale
    `
    expect(rows.map((row) => row.capture_locale)).toEqual(['ar', 'en'])
  })
})

describe('acceptance — the record reaches the send choke point', () => {
  /**
   * A promotional SMS template. `messageClass` comes from the template and from nowhere else, which is
   * what makes it impossible for a call site to route promotional content down the transactional
   * identity (B-MSG-02).
   */
  const TEMPLATE: ClassifiedTemplate = {
    key: 'ccrm03.campaign',
    messageClass: 'promotional',
    channel: 'sms',
    locale: 'en',
    body: 'BE RELAX: {{offer}}',
    variables: ['offer'],
  }

  /** A transport that records what it was handed. No provider: the gate runs long before this. */
  function fakeTransport(): { transport: ClassRoutedTransport; calls: TransportRequest[] } {
    const calls: TransportRequest[] = []
    return {
      calls,
      transport: {
        channel: 'sms',
        send: async (request) => {
          calls.push(request)
          return {
            kind: 'accepted',
            providerMessageId: `ccrm03-${calls.length}`,
            segments: 1,
            costFils: 12,
          }
        },
      },
    }
  }

  /**
   * The instant a campaign is evaluated at.
   *
   * One hour after `FIXTURE_NOW`, which is one hour after the seeded grants and 59 minutes after the
   * seeded withdrawals — the seed records a withdrawal one minute after the grant it supersedes. It is
   * stated here rather than being `FIXTURE_NOW` because the difference is the point: at `FIXTURE_NOW`
   * exactly, the withdrawn contact had not yet withdrawn, and the last case below sends to them to prove
   * the choke point reads consent as at the instant it is given rather than as at "now". Still 15:00
   * Asia/Dubai, so the promotional window is open and the gate's decision is the consent decision.
   */
  const CAMPAIGN_AT = instantFromIso('2026-09-18T11:00:00.000Z')

  /** The real `sendMessage`, the real gate, and the consent evaluator built over a real DB read. */
  async function sendAs(
    phoneE164: string,
    options: { readonly prefetch?: readonly string[]; readonly at?: Instant } = {},
  ) {
    const at = options.at ?? CAMPAIGN_AT
    const contacts = await readContactsByPhone(sql, options.prefetch ?? [phoneE164])
    const logs = new Map(
      [
        ...(
          await readConsentLogs(
            sql,
            contacts.map((c) => c.contactId),
          )
        ).entries(),
      ].map(([contactId, read]) => {
        const phone = contacts.find((c) => c.contactId === contactId)?.phoneE164 as string
        return [phone, asLog(read)] as const
      }),
    )
    const transport = fakeTransport()
    const ctx: SendContext = {
      // Production, so the staging guard does not divert and the gate's decision is the one under test.
      appEnv: 'production',
      outboundAllowlist: [],
      senderIds: PROVISIONAL_SENDER_IDS,
      transports: [transport.transport],
      outbox: new InMemoryOutbox(),
      clock: { now: () => at },
      gate: {
        marketingKillSwitch: false,
        promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
        evaluators: {
          // The whole point of this unit reaching the choke point: the real evaluator, over real rows.
          hasConsent: consentGateEvaluator({ logs, purpose: 'marketing', at }),
          isSuppressed: () => false,
          frequencyCapReached: () => false,
        },
      },
    }
    const request: SendRequest = {
      id: `ccrm03-${phoneE164}` as MessageId,
      template: TEMPLATE,
      values: { offer: '20% off this week' },
      recipient: phoneE164,
    }
    return { result: await sendMessage(ctx, request), calls: transport.calls }
  }

  it('sends to a granted contact', async () => {
    const granted = normalisePhone(syntheticPerson(CONSENT_SEED_INDEXES.granted).phone)
    const { result, calls } = await sendAs(granted)
    expect(result.kind).toBe('sent')
    expect(calls).toHaveLength(1)
  })

  it('refuses a withdrawn contact with refused_no_consent, and nothing reaches the transport', async () => {
    const withdrawn = normalisePhone(syntheticPerson(CONSENT_SEED_INDEXES.withdrawn).phone)
    const { result, calls } = await sendAs(withdrawn)
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') return
    expect(result.reason).toBe('refused_no_consent')
    expect(result.evaluator).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('refuses a never-asked contact the same way', async () => {
    const never = normalisePhone(syntheticPerson(CONSENT_SEED_INDEXES.never_asked).phone)
    const { result } = await sendAs(never)
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') return
    expect(result.reason).toBe('refused_no_consent')
  })

  it('refuses a reconstructed contact, which is the import rule arriving at the send path', async () => {
    const reconstructed = normalisePhone(syntheticPerson(CONSENT_SEED_INDEXES.reconstructed).phone)
    const { result } = await sendAs(reconstructed)
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') return
    expect(result.reason).toBe('refused_no_consent')
  })

  it('blocks as UNEVALUABLE when the recipient was not in the prefetch', async () => {
    // The distinction the whole evaluator exists for. `prefetch` deliberately names a different contact,
    // which is what a campaign whose recipient list and consent query have drifted apart looks like.
    const granted = normalisePhone(syntheticPerson(CONSENT_SEED_INDEXES.granted).phone)
    const target = normalisePhone(syntheticPerson(CONSENT_SEED_INDEXES.withdrawn).phone)
    const { result, calls } = await sendAs(target, { prefetch: [granted] })
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') return
    expect(result.reason).toBe('blocked_unevaluable')
    // Named, so the fault is actionable rather than filed under "this contact never opted in".
    expect(result.evaluator).toBe('consent')
    expect(calls).toHaveLength(0)
  })

  it('reads consent as at the instant given, not as at the newest record', async () => {
    // The control on the withdrawn case above, and the reason `at` is an argument all the way down. The
    // seed records the withdrawal one minute AFTER the grant, so at `FIXTURE_NOW` — before it — the same
    // contact was opted in and the same campaign sends. A choke point that read "the newest row" rather
    // than "the state at this instant" would refuse here, and a rebuild of a historical campaign would
    // report every send it made as non-compliant.
    const withdrawn = normalisePhone(syntheticPerson(CONSENT_SEED_INDEXES.withdrawn).phone)
    const { result, calls } = await sendAs(withdrawn, { at: FIXTURE_NOW })
    expect(result.kind).toBe('sent')
    expect(calls).toHaveLength(1)
  })
})
