import {
  CLIENT_RECORD_KEYS,
  type ClientRecordFacts,
  CUSTOMER_ACQUISITION_PROVISIONAL,
  CUSTOMER_ACQUISITION_SOURCES,
  CUSTOMER_LIFECYCLE_PROVISIONAL,
  CUSTOMER_LIFECYCLE_STATES,
  type CustomerAcquisitionSource,
  type CustomerLifecycleState,
  DEFAULT_ACQUISITION_SOURCE,
  DEFAULT_LIFECYCLE_STATE,
  decideBlocklist,
  decideCustomerLifecycle,
  mayChangeBlocklist,
  normaliseBlocklistKey,
  normalisePhone,
  serialiseClientRecord,
} from '@berelax/core'
import {
  type Actor,
  addBlocklistEntry,
  addCustomerTag,
  applyCustomerLifecycleEvent,
  type BlocklistAuthoriser,
  type BlocklistMatcher,
  type ClientRecordRead,
  CRM_AUDIT_ACTIONS,
  CRM_AUDIT_COVERAGE,
  createConnection,
  crmAuditCoverage,
  crmRefusalOf,
  ensureCustomer,
  evaluateBlocklist,
  type LifecycleDecider,
  liftBlocklistEntry,
  readClientRecord,
  removeCustomerTag,
  type Sql,
  setAcquisitionSource,
  setCustomerPreferences,
  setCustomerVip,
  setDoNotPair,
  unconfirmedAssumptionRows,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { syntheticPerson } from './synthetic.ts'

/**
 * C-CRM-01 — the client record, the blocklist's role checks, and the audit coverage of the CRM area.
 *
 * `packages/fixtures` is the only package that may import both halves, and every claim in this file is a
 * claim about the pair: the reducer is pure and lives in `@berelax/core`, the rows live in PostgreSQL and
 * `@berelax/db` writes them, and neither package may import the other. So the three injected seams — the
 * lifecycle decider, the blocklist authoriser, the blocklist matcher — are asserted with `satisfies`
 * here rather than trusted, and the vocabulary in migration 0053 is pinned to the lists in core.
 *
 * ## The audit-coverage test, and why it enumerates from the database
 *
 * The acceptance line is "a query enumerates every mutable table in the CRM area and asserts each is
 * either covered by an audited repository method or carries an audit trigger; a fixture table added
 * without either fails the test". The enumeration is `information_schema` through `crmAuditCoverage`,
 * NOT the register in `CRM_AUDIT_COVERAGE`: a test that iterated the register could only ever report
 * what somebody remembered to write down, and the table nobody registered is exactly the one that ships
 * unaudited. The last case creates such a table and watches the coverage report it.
 *
 * ## Isolation, and the append-only rule
 *
 * Every assertion about `audit_event` is a DELTA measured in SQL (ADR 0008, brief rules 9 and 12): the
 * table only grows, it is never deleted from here, and a count taken through a capped reader is the
 * defect `settings-store.itest.ts` recorded. The customers are `syntheticPerson`, on the unallocated
 * `+971 59` prefix, and nothing here has a name — a record with no display name is labelled
 * `Customer 0042` (ADR 0020).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const MARKER = 'ccrm01 client record itest'
const SUBJECT = syntheticPerson(4_411)
const BLOCKED = syntheticPerson(4_412)
const ACTOR: Actor = { kind: 'staff', label: 'Manager (fixture)' }
const MANAGER = 'manager'
const RECEPTIONIST = 'receptionist'
/** Not in `ROLES`. The realistic bad input at an API boundary: a session claim nobody declared. */
const UNLISTED_ROLE = 'floor_manager'
const FROZEN_ISO = '2099-09-20T10:00:00.000Z'

/**
 * The three ports, asserted structurally rather than described in a comment.
 *
 * `satisfies` and not casts: `packages/db` declares each of these in strings because it may not import
 * `@berelax/core`, so every one is two declarations of one shape. A field added to one and not the other
 * fails `pnpm typecheck` naming this file, instead of a role check that stopped checking or a blocklist
 * that evaluated nothing.
 */
const decide = decideCustomerLifecycle satisfies LifecycleDecider
const authorise = mayChangeBlocklist satisfies BlocklistAuthoriser
const match = decideBlocklist satisfies BlocklistMatcher

let sql: Sql
let subjectId: string
let blockedId: string
let employeeId: string

/** Counted in SQL, never through a capped reader: `audit_event` only grows (brief rule 12). */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

/**
 * Every audit action this file has WATCHED a row appear for.
 *
 * Read by the last case in the coverage block. `CRM_AUDIT_COVERAGE`'s `by: 'repository'` arm is a claim
 * that a named action is written, and `crmAuditCoverage` takes that claim on trust because it cannot call
 * the method — so something has to check it, or a repository method that stopped auditing would go on
 * reading as covered forever. This set is that check, and it is built out of measured DELTAS rather than
 * out of totals: `audit_event` only grows, and a total would be satisfied by another suite's rows.
 */
const proven = new Set<string>()

/** The delta a body produces in one audit action. The only shape an append-only assertion may take. */
async function auditDelta<T>(action: string, body: () => Promise<T>): Promise<[number, T]> {
  const before = await auditCount(action)
  const result = await body()
  const delta = (await auditCount(action)) - before
  if (delta > 0) proven.add(action)
  return [delta, result]
}

const asStaff = <T>(
  body: (uow: Parameters<Parameters<typeof withUnitOfWork>[2]>[0]) => Promise<T>,
) => withUnitOfWork(sql, ACTOR, body)

/** The sentinel that makes {@link probe} roll back. */
const ROLLBACK = 'ccrm01 rollback'

/**
 * Runs a body in a transaction that is ALWAYS rolled back, and carries its answer out.
 *
 * The same helper `business-seed.itest.ts` uses, and for the same reason: `sql.begin` COMMITS when its
 * callback returns, so a "temporary" change made that way is permanent. Two cases below need to break
 * something — a cleared provisional flag, a dropped trigger — and either of them surviving would corrupt
 * the vocabulary and the audit coverage for every suite that runs after this file, in a way that presents
 * as a failure in a package nobody touched.
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

/**
 * The db read, narrowed to core's facts.
 *
 * The three narrowed fields are `text` columns on the db side, because their vocabularies live in TABLES
 * and the reader answers what the row holds. Narrowing them HERE, in the one package that can see both,
 * is the same arrangement `asPool` has in `therapist-eligibility.itest.ts` — and the membership
 * assertions below are what make the casts honest rather than hopeful. Everything else is spread whole,
 * so a field core requires and the reader stopped producing is a compile error on this function.
 */
function asFacts(read: ClientRecordRead): ClientRecordFacts {
  expect(CUSTOMER_LIFECYCLE_STATES, 'lifecycle state is a label core knows').toContain(
    read.lifecycleState,
  )
  expect(CUSTOMER_ACQUISITION_SOURCES, 'acquisition source is a label core knows').toContain(
    read.acquisitionSource,
  )
  for (const kind of read.blocklistedKeyKinds) expect(['phone', 'email']).toContain(kind)
  return {
    ...read,
    lifecycleState: read.lifecycleState as CustomerLifecycleState,
    acquisitionSource: read.acquisitionSource as CustomerAcquisitionSource,
    blocklistedKeyKinds: read.blocklistedKeyKinds as readonly ('phone' | 'email')[],
  }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  const subject = await asStaff((uow) =>
    ensureCustomer(uow, {
      phoneE164: normalisePhone(SUBJECT.phone),
      displayName: null,
      nameMatchKey: null,
      locale: 'en',
      createdVia: 'front_desk',
    }),
  )
  subjectId = subject.customer.id
  const blocked = await asStaff((uow) =>
    ensureCustomer(uow, {
      phoneE164: normalisePhone(BLOCKED.phone),
      displayName: null,
      nameMatchKey: null,
      locale: 'en',
      createdVia: 'front_desk',
    }),
  )
  blockedId = blocked.customer.id
  const [employee] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from, notes)
    values ('ccrm01-rec-therapist', '2099-01-01', ${MARKER})
    returning id
  `
  employeeId = (employee as { id: string }).id
})

afterAll(async () => {
  // `audit_event` is append-only and is deliberately NOT cleaned: every assertion above is a delta.
  await sql`delete from customer_therapist_do_not_pair where employee_id = ${employeeId}`
  await sql`delete from employee where id = ${employeeId}`
  await sql`
    delete from customer_blocklist
     where key_value in (${normalisePhone(BLOCKED.phone)}, ${BLOCKED.email}, ${normalisePhone(SUBJECT.phone)})
  `
  await sql`
    delete from customer where phone_e164 in (${normalisePhone(SUBJECT.phone)}, ${normalisePhone(BLOCKED.phone)})
  `
  await sql?.end({ timeout: 5 })
})

describe('the provisional vocabularies are the ones core declares, and they say so', () => {
  it('seeds exactly the six lifecycle states, in order, all flagged provisional', async () => {
    const rows = await sql<
      { state: string; is_provisional: boolean; open_question_id: string | null }[]
    >`
      select state, is_provisional, open_question_id
        from customer_lifecycle_state order by display_order
    `
    expect(rows.map((row) => row.state)).toEqual([...CUSTOMER_LIFECYCLE_STATES])
    for (const row of rows) {
      expect(row.is_provisional, row.state).toBe(true)
      expect(row.open_question_id, row.state).toBe(CUSTOMER_LIFECYCLE_PROVISIONAL.openQuestionId)
    }
  })

  it('seeds exactly the six acquisition sources, in order, all flagged provisional', async () => {
    const rows = await sql<
      { source: string; is_provisional: boolean; open_question_id: string | null }[]
    >`
      select source, is_provisional, open_question_id
        from customer_acquisition_source order by display_order
    `
    expect(rows.map((row) => row.source)).toEqual([...CUSTOMER_ACQUISITION_SOURCES])
    for (const row of rows) {
      expect(row.is_provisional, row.source).toBe(true)
      expect(row.open_question_id, row.source).toBe(CUSTOMER_ACQUISITION_PROVISIONAL.openQuestionId)
    }
  })

  it('lists every label in the Unconfirmed Assumptions panel', async () => {
    // The reason both vocabularies are tables rather than enums. An enum label has nowhere to carry
    // is_provisional, an OPEN-QUESTIONS id or a note, so it could not appear here at all.
    const rows = await unconfirmedAssumptionRows(sql)
    const states = rows.filter((row) => row.source === 'customer_lifecycle_state')
    const sources = rows.filter((row) => row.source === 'customer_acquisition_source')
    expect(states.map((row) => row.reference).sort()).toEqual([...CUSTOMER_LIFECYCLE_STATES].sort())
    expect(sources.map((row) => row.reference).sort()).toEqual(
      [...CUSTOMER_ACQUISITION_SOURCES].sort(),
    )
    for (const row of [...states, ...sources]) expect(row.note ?? '').not.toBe('')
  })

  it('leaves the panel when a label is confirmed, which is the control on the query', async () => {
    // Without this, "the panel lists them" is satisfied by a query with no WHERE clause. Rolled back, so
    // the vocabulary is unchanged for every later suite.
    const listed = await probe(async (tx) => {
      await tx`
        update customer_lifecycle_state
           set is_provisional = false, open_question_id = null, provisional_note = null
         where state = 'lead'
      `
      const rows = await unconfirmedAssumptionRows(tx)
      return rows.filter((row) => row.source === 'customer_lifecycle_state').length
    })
    expect(listed).toBe(CUSTOMER_LIFECYCLE_STATES.length - 1)
    // And it is back, because `probe` rolls back. `sql.begin` COMMITS on a clean return, which would
    // leave the vocabulary confirmed for every suite after this one.
    const stillProvisional = await unconfirmedAssumptionRows(sql)
    expect(stillProvisional.filter((row) => row.source === 'customer_lifecycle_state').length).toBe(
      CUSTOMER_LIFECYCLE_STATES.length,
    )
  })

  it('states the same defaults the schema does, so the two cannot drift', async () => {
    // Two statements of one fact: what core says a new record carries, and what 0053's DEFAULT clauses
    // actually give it. A migration that changed a column default without the constant would put every new
    // record in a state the reducer's callers do not expect, and nothing else in the build would notice.
    const rows = await sql<{ column_name: string; column_default: string | null }[]>`
      select column_name, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'customer'
         and column_name in ('lifecycle_state', 'acquisition_source')
       order by column_name
    `
    const defaultOf = (name: string) =>
      rows.find((row) => row.column_name === name)?.column_default ?? ''
    expect(defaultOf('lifecycle_state')).toContain(`'${DEFAULT_LIFECYCLE_STATE}'`)
    expect(defaultOf('acquisition_source')).toContain(`'${DEFAULT_ACQUISITION_SOURCE}'`)
    // And a record really is born in them, which is what makes the two assertions above about something
    // rather than about the text of a catalogue column.
    const born = syntheticPerson(4_498)
    try {
      const [row] = await sql<{ lifecycle_state: string; acquisition_source: string }[]>`
        insert into customer (phone_e164, locale) values (${normalisePhone(born.phone)}, 'en')
        returning lifecycle_state, acquisition_source
      `
      const record = row as { lifecycle_state: string; acquisition_source: string }
      expect(record.lifecycle_state).toBe(DEFAULT_LIFECYCLE_STATE)
      // `unknown` and not a guess: it is the honest answer for every record whose origin nobody wrote
      // down, and a plausible attribution is indistinguishable from a recorded one.
      expect(record.acquisition_source).toBe(DEFAULT_ACQUISITION_SOURCE)
      expect(record.acquisition_source).toBe('unknown')
    } finally {
      await sql`delete from customer where phone_e164 = ${normalisePhone(born.phone)}`
    }
  })

  it('refuses a customer whose state or source is not in the vocabulary', async () => {
    // The foreign key is what makes the vocabulary a constraint rather than a convention.
    for (const statement of [
      sql`update customer set lifecycle_state = 'vip' where id = ${subjectId}`,
      sql`update customer set acquisition_source = 'tiktok' where id = ${subjectId}`,
    ]) {
      let caught: unknown
      try {
        await statement
      } catch (error) {
        caught = error
      }
      expect((caught as { code?: string } | undefined)?.code).toBe('23503')
    }
  })
})

describe('preferences, tags, source and VIP', () => {
  it('writes the whole preference row and audits it', async () => {
    const [delta, record] = await auditDelta(CRM_AUDIT_ACTIONS.preferencesSet, () =>
      asStaff((uow) =>
        setCustomerPreferences(uow, {
          customerId: subjectId,
          preferredLanguage: 'ar',
          preferredTherapistGender: 'female',
          preferredRoomType: 'standard',
          pressureNote: 'Lighter on the shoulders.',
        }),
      ),
    )
    expect(delta).toBe(1)
    expect(record.preferredLanguage).toBe('ar')
    expect(record.preferredTherapistGender).toBe('female')
    expect(record.pressureNote).toBe('Lighter on the shoulders.')
    // An omitted field is null and not "leave it alone": the admin form posts the whole row, and a patch
    // semantics would make clearing a note impossible to express.
    expect(record.oilNote).toBeNull()
  })

  it('overwrites the row on a second write, clearing what the caller omitted', async () => {
    const [delta, record] = await auditDelta(CRM_AUDIT_ACTIONS.preferencesSet, () =>
      asStaff((uow) =>
        setCustomerPreferences(uow, { customerId: subjectId, oilNote: 'Unscented.' }),
      ),
    )
    expect(delta).toBe(1)
    expect(record.oilNote).toBe('Unscented.')
    expect(record.pressureNote).toBeNull()
    expect(record.preferredLanguage).toBeNull()
  })

  it('adds and removes a tag, audits each, and is idempotent on a repeat', async () => {
    const [added, first] = await auditDelta(CRM_AUDIT_ACTIONS.tagAdded, () =>
      asStaff((uow) => addCustomerTag(uow, { customerId: subjectId, tag: 'evenings' })),
    )
    expect(added).toBe(1)
    expect(first.added).toBe(true)
    const [again, second] = await auditDelta(CRM_AUDIT_ACTIONS.tagAdded, () =>
      asStaff((uow) => addCustomerTag(uow, { customerId: subjectId, tag: 'evenings' })),
    )
    // A tag added twice is one row and NO second audit row: a trail of non-changes reads as activity.
    expect(again).toBe(0)
    expect(second.added).toBe(false)
    const [removed] = await auditDelta(CRM_AUDIT_ACTIONS.tagRemoved, () =>
      asStaff((uow) => removeCustomerTag(uow, { customerId: subjectId, tag: 'evenings' })),
    )
    expect(removed).toBe(1)
    const [removedAgain, outcome] = await auditDelta(CRM_AUDIT_ACTIONS.tagRemoved, () =>
      asStaff((uow) => removeCustomerTag(uow, { customerId: subjectId, tag: 'evenings' })),
    )
    expect(removedAgain).toBe(0)
    expect(outcome.removed).toBe(false)
  })

  it('refuses a tag that is not a lower-case slug', async () => {
    // Two capitalisations of one tag are two tags, and the segment built on one of them silently misses
    // half the people.
    for (const tag of ['Evenings', 'deep tissue', 'x', '-leading']) {
      let caught: unknown
      try {
        await sql`insert into customer_tag (customer_id, tag) values (${subjectId}, ${tag})`
      } catch (error) {
        caught = error
      }
      expect((caught as { code?: string } | undefined)?.code, tag).toBe('23514')
    }
  })

  it('records the acquisition source and audits the change with its previous value', async () => {
    const [delta] = await auditDelta(CRM_AUDIT_ACTIONS.acquisitionSourceSet, () =>
      asStaff((uow) => setAcquisitionSource(uow, { customerId: subjectId, source: 'walk_in' })),
    )
    expect(delta).toBe(1)
    const [row] = await sql<{ before: unknown; after: unknown }[]>`
      select before_state as before, after_state as after from audit_event
       where action = ${CRM_AUDIT_ACTIONS.acquisitionSourceSet} and entity_id = ${subjectId}
       order by occurred_at desc limit 1
    `
    // `unknown` is the default every record carries, and the audit row has to say what it was before —
    // "somebody set this to walk_in" and "somebody changed this from web to walk_in" are two facts.
    expect((row as { before: { acquisition_source: string } }).before.acquisition_source).toBe(
      'unknown',
    )
    expect((row as { after: { acquisition_source: string } }).after.acquisition_source).toBe(
      'walk_in',
    )
  })

  it('sets the VIP flag with its date, and the database refuses one without the other', async () => {
    const [delta] = await auditDelta(CRM_AUDIT_ACTIONS.vipSet, () =>
      asStaff((uow) =>
        setCustomerVip(uow, { customerId: subjectId, isVip: true, atIso: FROZEN_ISO }),
      ),
    )
    expect(delta).toBe(1)
    const [row] = await sql<{ is_vip: boolean; vip_since: Date | null }[]>`
      select is_vip, vip_since from customer where id = ${subjectId}
    `
    expect((row as { is_vip: boolean }).is_vip).toBe(true)
    expect((row as { vip_since: Date | null }).vip_since?.toISOString()).toBe(FROZEN_ISO)

    // The fence. A VIP with no date is a flag nobody can attribute; a date with no flag is a VIP who was
    // silently demoted. The constraint is what makes the repository's pairing more than a convention.
    let caught: unknown
    try {
      await sql`update customer set vip_since = null where id = ${subjectId}`
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('23514')
  })
})

describe('the lifecycle, through the injected reducer', () => {
  it('moves a lead to new on a booking, and writes nothing on a repeat', async () => {
    const [moved, first] = await auditDelta(CRM_AUDIT_ACTIONS.lifecycleChanged, () =>
      asStaff((uow) =>
        applyCustomerLifecycleEvent(
          uow,
          { customerId: subjectId, event: 'booking_taken', atIso: FROZEN_ISO },
          { decide },
        ),
      ),
    )
    expect(moved).toBe(1)
    expect(first).toEqual({ from: 'lead', to: 'new', moved: true })

    const [repeat, second] = await auditDelta(CRM_AUDIT_ACTIONS.lifecycleChanged, () =>
      asStaff((uow) =>
        applyCustomerLifecycleEvent(
          uow,
          { customerId: subjectId, event: 'booking_taken', atIso: FROZEN_ISO },
          { decide },
        ),
      ),
    )
    // `unchanged` writes no column and no audit row: the state the caller asked for is already true.
    expect(repeat).toBe(0)
    expect(second.moved).toBe(false)
  })

  it('refuses with lifecycle_not_decided when no reducer is injected', async () => {
    // Fail closed. The permissive version of this seam is a lifecycle that moves on nothing's authority.
    let caught: unknown
    try {
      await asStaff((uow) =>
        applyCustomerLifecycleEvent(
          uow,
          { customerId: subjectId, event: 'booking_taken', atIso: FROZEN_ISO },
          {},
        ),
      )
    } catch (error) {
      caught = error
    }
    expect(crmRefusalOf(caught)).toBe('lifecycle_not_decided')
  })

  it('refuses a booking for a blocked record, carrying the reducer’s own refusal', async () => {
    await asStaff((uow) =>
      applyCustomerLifecycleEvent(
        uow,
        { customerId: blockedId, event: 'blocklisted', atIso: FROZEN_ISO },
        { decide },
      ),
    )
    let caught: unknown
    try {
      await asStaff((uow) =>
        applyCustomerLifecycleEvent(
          uow,
          { customerId: blockedId, event: 'booking_taken', atIso: FROZEN_ISO },
          { decide },
        ),
      )
    } catch (error) {
      caught = error
    }
    expect(crmRefusalOf(caught)).toBe('lifecycle_refused')
    expect((caught as { details: { reducerRefusal: string } }).details.reducerRefusal).toBe(
      'customer_is_blocked',
    )
  })

  it('does not let the lapse sweep move a blocked record', async () => {
    // The security property, against a real row: a blocked record that could lapse would leave `blocked`
    // on a timer, and the sweep would un-block somebody at 03:00 with nobody deciding it should.
    for (const event of ['inactivity_warning_reached', 'inactivity_threshold_reached']) {
      let caught: unknown
      try {
        await asStaff((uow) =>
          applyCustomerLifecycleEvent(
            uow,
            { customerId: blockedId, event, atIso: FROZEN_ISO },
            { decide },
          ),
        )
      } catch (error) {
        caught = error
      }
      expect(crmRefusalOf(caught), event).toBe('lifecycle_refused')
    }
    const [row] = await sql<{ lifecycle_state: string }[]>`
      select lifecycle_state from customer where id = ${blockedId}
    `
    expect((row as { lifecycle_state: string }).lifecycle_state).toBe('blocked')
  })
})

describe('acceptance — changing the blocklist is deny-by-default for three kinds of role', () => {
  const key = () => {
    const result = normaliseBlocklistKey('phone', BLOCKED.phone)
    if (!result.ok) throw new Error('fixture phone must normalise')
    return result.key
  }

  const add = (role: string) =>
    asStaff((uow) =>
      addBlocklistEntry(
        uow,
        {
          kind: 'phone',
          value: key().value,
          reason: 'Abusive to staff on 2099-09-01.',
          role,
          customerId: blockedId,
        },
        { authorise },
      ),
    )

  it('refuses the receptionist', async () => {
    let caught: unknown
    try {
      await add(RECEPTIONIST)
    } catch (error) {
      caught = error
    }
    expect(crmRefusalOf(caught)).toBe('blocklist_forbidden')
    expect(
      (caught as { details: { authorisationRefusal: string } }).details.authorisationRefusal,
    ).toBe('permission_not_granted')
  })

  it('refuses an unlisted role, by name rather than by throwing a TypeError', async () => {
    // `ROLE_DEFINITIONS['floor_manager']` is undefined and reading `.permissions` off it throws — a
    // deny-by-default failure that presents as a 500. The authoriser narrows first.
    let caught: unknown
    try {
      await add(UNLISTED_ROLE)
    } catch (error) {
      caught = error
    }
    expect(crmRefusalOf(caught)).toBe('blocklist_forbidden')
    expect(
      (caught as { details: { authorisationRefusal: string } }).details.authorisationRefusal,
    ).toBe('unknown_role')
  })

  it('refuses a caller that brought no authoriser at all', async () => {
    let caught: unknown
    try {
      await asStaff((uow) =>
        addBlocklistEntry(
          uow,
          { kind: 'phone', value: key().value, reason: 'No authoriser.', role: MANAGER },
          {},
        ),
      )
    } catch (error) {
      caught = error
    }
    expect(crmRefusalOf(caught)).toBe('blocklist_not_authorised')
  })

  it('permits the manager, and writes exactly one audit row', async () => {
    const [delta, result] = await auditDelta(CRM_AUDIT_ACTIONS.blocklisted, () => add(MANAGER))
    expect(delta).toBe(1)
    expect(result.created).toBe(true)
    // And nothing was written by the three refusals above, which is what makes them refusals.
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from customer_blocklist where key_value = ${key().value}
    `
    expect(Number((count as { n: string }).n)).toBe(1)
  })

  it('applies the same three answers to a LIFT, not only to an add', async () => {
    const [entry] = await sql<{ id: string }[]>`
      select id::text as id from customer_blocklist
       where key_value = ${key().value} and lifted_at is null
    `
    const lift = (role: string) =>
      asStaff((uow) =>
        liftBlocklistEntry(
          uow,
          {
            entryId: (entry as { id: string }).id,
            role,
            reason: 'Reviewed and lifted.',
            atIso: FROZEN_ISO,
          },
          { authorise },
        ),
      )
    for (const role of [RECEPTIONIST, UNLISTED_ROLE]) {
      let caught: unknown
      try {
        await lift(role)
      } catch (error) {
        caught = error
      }
      expect(crmRefusalOf(caught), role).toBe('blocklist_forbidden')
    }
    const [delta] = await auditDelta(CRM_AUDIT_ACTIONS.blocklistLifted, () => lift(MANAGER))
    expect(delta).toBe(1)
    // A second lift is an error and not a no-op: a silent success would conceal a manager acting on the
    // wrong entry.
    let caught: unknown
    try {
      await lift(MANAGER)
    } catch (error) {
      caught = error
    }
    expect(crmRefusalOf(caught)).toBe('blocklist_entry_not_active')
  })

  it('keeps the lifted row rather than deleting it, and berelax_app cannot delete either', async () => {
    const [row] = await sql<{ lifted_by_role: string; lifted_reason: string }[]>`
      select lifted_by_role, lifted_reason from customer_blocklist
       where key_value = ${key().value}
    `
    expect((row as { lifted_by_role: string }).lifted_by_role).toBe(MANAGER)
    expect((row as { lifted_reason: string }).lifted_reason).toBe('Reviewed and lifted.')
    const [privileges] = await sql<{ can_delete: boolean; can_read: boolean }[]>`
      select has_table_privilege('berelax_app', 'customer_blocklist', 'DELETE') as can_delete,
             has_table_privilege('berelax_readonly', 'customer_blocklist', 'SELECT') as can_read
    `
    // The record of who blocked somebody and who unblocked them is the only evidence either happened,
    // and a reporting role has no business in it at all.
    expect((privileges as { can_delete: boolean }).can_delete).toBe(false)
    expect((privileges as { can_read: boolean }).can_read).toBe(false)
  })

  it('refuses a blocklist entry whose key was never normalised', async () => {
    // The constraint is what makes "normalised" a fact. An entry typed 0590000042 at the desk is an
    // entry nothing will ever match, and it would look exactly like a working one.
    for (const [kind, value] of [
      ['phone', '0590000042'],
      ['email', 'Customer.42@fixture.invalid'],
      ['email', 'not-an-address'],
    ] as const) {
      let caught: unknown
      try {
        await sql`
          insert into customer_blocklist (key_kind, key_value, reason, added_by_role)
          values (${kind}, ${value}, 'fixture', 'manager')
        `
      } catch (error) {
        caught = error
      }
      expect((caught as { code?: string } | undefined)?.code, `${kind} ${value}`).toBe('23514')
    }
  })

  it('refuses an entry with no stated reason, at the database as well as in the repository', async () => {
    for (const reason of ['', '   ', 'tbc', 'pending']) {
      let caught: unknown
      try {
        await sql`
          insert into customer_blocklist (key_kind, key_value, reason, added_by_role)
          values ('phone', '+971590009999', ${reason}, 'manager')
        `
      } catch (error) {
        caught = error
      }
      expect((caught as { code?: string } | undefined)?.code, reason).toBe('23514')
    }
    let caught: unknown
    try {
      await asStaff((uow) =>
        addBlocklistEntry(
          uow,
          { kind: 'phone', value: '+971590009999', reason: '  ', role: MANAGER },
          { authorise },
        ),
      )
    } catch (error) {
      caught = error
    }
    expect(crmRefusalOf(caught)).toBe('reason_required')
  })
})

describe('acceptance — every blocklist evaluation writes an audit row', () => {
  const phoneKey = normaliseBlocklistKey('phone', BLOCKED.phone)
  const emailKey = normaliseBlocklistKey('email', BLOCKED.email)
  if (!phoneKey.ok || !emailKey.ok) throw new Error('fixture keys must normalise')

  beforeAll(async () => {
    // A fresh active entry per kind: the previous block lifted the phone one.
    for (const key of [phoneKey.key, emailKey.key]) {
      await asStaff((uow) =>
        addBlocklistEntry(
          uow,
          {
            kind: key.kind,
            value: key.value,
            reason: 'Abusive to staff on 2099-09-01.',
            role: MANAGER,
            customerId: blockedId,
          },
          { authorise },
        ),
      )
    }
  })

  it('records the actor, the matched key kind and the reason on a match', async () => {
    const [delta, verdict] = await auditDelta(CRM_AUDIT_ACTIONS.blocklistEvaluated, () =>
      asStaff((uow) =>
        evaluateBlocklist(uow, { keys: [phoneKey.key], context: 'fixture' }, { match }),
      ),
    )
    expect(delta).toBe(1)
    expect(verdict.blocked).toBe(true)
    expect(verdict.matchedKeyKind).toBe('phone')
    const [row] = await sql<
      {
        actor_kind: string
        actor_label: string
        operation: string
        after: Record<string, unknown>
      }[]
    >`
      select actor_kind, actor_label, operation, after_state as after from audit_event
       where action = ${CRM_AUDIT_ACTIONS.blocklistEvaluated}
       order by occurred_at desc, id desc limit 1
    `
    const record = row as {
      actor_kind: string
      actor_label: string
      operation: string
      after: { matched: boolean; matched_key_kind: string; reason: string }
    }
    expect(record.actor_kind).toBe('staff')
    expect(record.actor_label).toBe('Manager (fixture)')
    // `denied` and not `read`: the refusals are the rows anybody reviewing an incident wants, and 0005
    // indexes the vocabulary that makes them cheap to find.
    expect(record.operation).toBe('denied')
    expect(record.after.matched).toBe(true)
    expect(record.after.matched_key_kind).toBe('phone')
    expect(record.after.reason).toBe('Abusive to staff on 2099-09-01.')
    // The VALUE is never recorded: the trail must say what was checked without becoming a second copy
    // of the contact details it was checking.
    expect(JSON.stringify(record.after)).not.toContain(phoneKey.key.value)
  })

  it('records the email match separately, with its own key kind', async () => {
    const [, verdict] = await auditDelta(CRM_AUDIT_ACTIONS.blocklistEvaluated, () =>
      asStaff((uow) =>
        evaluateBlocklist(uow, { keys: [emailKey.key], context: 'fixture' }, { match }),
      ),
    )
    expect(verdict.blocked).toBe(true)
    expect(verdict.matchedKeyKind).toBe('email')
  })

  it('audits a CLEAR evaluation too, which is how "was this checked at all" is answerable', async () => {
    const clean = normaliseBlocklistKey('phone', syntheticPerson(4_499).phone)
    if (!clean.ok) throw new Error('fixture phone must normalise')
    const [delta, verdict] = await auditDelta(CRM_AUDIT_ACTIONS.blocklistEvaluated, () =>
      asStaff((uow) =>
        evaluateBlocklist(uow, { keys: [clean.key], context: 'fixture' }, { match }),
      ),
    )
    expect(delta).toBe(1)
    expect(verdict.blocked).toBe(false)
    const [row] = await sql<{ operation: string; after: { matched: boolean } }[]>`
      select operation, after_state as after from audit_event
       where action = ${CRM_AUDIT_ACTIONS.blocklistEvaluated}
       order by occurred_at desc, id desc limit 1
    `
    const record = row as { operation: string; after: { matched: boolean } }
    // `read` and not `denied`: the vocabulary is what separates "checked and clear" from "refused", and
    // 0005 indexes it, which is what makes the refusals cheap to find after an incident.
    expect(record.operation).toBe('read')
    expect(record.after.matched).toBe(false)
  })

  it('refuses to evaluate with no matcher injected, rather than answering "not blocked"', async () => {
    let caught: unknown
    try {
      await asStaff((uow) =>
        evaluateBlocklist(uow, { keys: [phoneKey.key], context: 'fixture' }, {}),
      )
    } catch (error) {
      caught = error
    }
    expect(crmRefusalOf(caught)).toBe('blocklist_not_evaluated')
  })
})

describe('acceptance — the client record serialises without the internal fields', () => {
  it('reads the record, narrows to core’s facts, and hands the customer only their own', async () => {
    const [flagged] = await auditDelta(CRM_AUDIT_ACTIONS.doNotPairSet, () =>
      asStaff((uow) =>
        setDoNotPair(
          uow,
          {
            customerId: subjectId,
            employeeId,
            reason: 'Asked not to be paired again after 2099-09-01.',
            role: MANAGER,
          },
          { authorise },
        ),
      ),
    )
    expect(flagged).toBe(1)
    const read = await readClientRecord(sql, subjectId)
    expect(read).not.toBeNull()
    const facts = asFacts(read as ClientRecordRead)
    // The db read and core's record are the same key set, in both directions. A field on one side only
    // is a DTO that quietly stopped carrying something.
    expect(Object.keys(read as object).sort()).toEqual([...CLIENT_RECORD_KEYS.staff])
    expect(facts.doNotPairTherapistIds).toEqual([employeeId])
    // A record with no display name is labelled by its record number, never by an invented name.
    expect(facts.label).toMatch(/^Customer \d{4,}$/)

    const forCustomer = serialiseClientRecord('customer', facts)
    expect(Object.keys(forCustomer).sort()).toEqual([...CLIENT_RECORD_KEYS.customer])
    expect(JSON.stringify(forCustomer)).not.toContain(employeeId)
    const forPublic = serialiseClientRecord('public', facts)
    expect(Object.keys(forPublic).sort()).toEqual([...CLIENT_RECORD_KEYS.public])
  })

  it('refuses a receptionist and an unlisted role the do-not-pair flag as well', async () => {
    // The same permission as a blocklist change, deliberately: a receptionist recording that an employee
    // will not work with a named client is a judgement about the employee as well as about the client, and
    // the manager holds it. Asserted directly rather than inferred from the blocklist's answer, because
    // "they share a helper today" is not a property a test can rely on.
    for (const [role, expected] of [
      [RECEPTIONIST, 'permission_not_granted'],
      [UNLISTED_ROLE, 'unknown_role'],
    ] as const) {
      let caught: unknown
      try {
        await asStaff((uow) =>
          setDoNotPair(
            uow,
            { customerId: blockedId, employeeId, reason: 'Should not be recorded.', role },
            { authorise },
          ),
        )
      } catch (error) {
        caught = error
      }
      expect(crmRefusalOf(caught), role).toBe('blocklist_forbidden')
      expect(
        (caught as { details: { authorisationRefusal: string } }).details.authorisationRefusal,
        role,
      ).toBe(expected)
    }
    const [count] = await sql<{ n: string }[]>`
      select count(*)::text as n from customer_therapist_do_not_pair
       where customer_id = ${blockedId}
    `
    expect(Number((count as { n: string }).n)).toBe(0)
  })

  it('does not tell a blocked customer that they are blocked', async () => {
    const read = await readClientRecord(sql, blockedId)
    const facts = asFacts(read as ClientRecordRead)
    // The staff view says so, which is what makes the customer view's silence an omission rather than an
    // absence of data.
    expect(facts.blocklistedKeyKinds.length).toBeGreaterThan(0)
    expect(facts.lifecycleState).toBe('blocked')
    const forCustomer = serialiseClientRecord('customer', facts)
    expect(JSON.stringify(forCustomer)).not.toContain('blocked')
    expect(Object.keys(forCustomer)).not.toContain('blocklistedKeyKinds')
    expect(Object.keys(forCustomer)).not.toContain('lifecycleState')
  })
})

describe('acceptance — every mutable table in the CRM area is audited', () => {
  it('enumerates the area from the database and finds every table covered', async () => {
    const coverage = await crmAuditCoverage(sql)
    expect(coverage.map((row) => row.table)).toEqual([
      'customer',
      'customer_acquisition_source',
      'customer_blocklist',
      'customer_lifecycle_state',
      // C-AUTO-08's pipeline card. In the area because of its name, and named that way on purpose: its
      // row is where a human has put a person, so a change to it that nothing recorded is exactly what
      // this register exists to refuse. Audited by trigger — `crm.ts` states why that arm and not the
      // repository one, although it has a repository.
      'customer_pipeline_card',
      'customer_preference',
      'customer_tag',
      'customer_therapist_do_not_pair',
    ])
    for (const row of coverage) expect(row.covered, `${row.table}: ${row.detail}`).toBe(true)
    // Both mechanisms are actually in use, so neither arm of the rule is dead code.
    expect(coverage.filter((row) => row.by === 'repository').length).toBeGreaterThan(0)
    expect(coverage.filter((row) => row.by === 'trigger').length).toBe(3)
    // And the register covers exactly the area, in both directions.
    expect(Object.keys(CRM_AUDIT_COVERAGE).sort()).toEqual(coverage.map((row) => row.table))
  })

  it('proves each registered repository action by having exercised it, not by declaring it', () => {
    // The gap `crmAuditCoverage` cannot close on its own: it reports a table covered because the register
    // names an action, and it has no way to call the method. Every registered action must therefore be one
    // this file watched a row appear for.
    const registered = Object.values(CRM_AUDIT_COVERAGE)
      .filter((entry): entry is { by: 'repository'; action: string } => entry.by === 'repository')
      .map((entry) => entry.action)
    expect(registered.length).toBeGreaterThan(0)
    for (const action of registered) {
      expect(
        [...proven],
        `${action} is registered as audited and nothing in this file measured a row for it`,
      ).toContain(action)
    }
  })

  it('fails for a fixture table added to the area with neither', async () => {
    // The known-bad case the acceptance line asks for, run against a real table. Dropped in a `finally`:
    // a table left behind fails `pnpm db:drift` in a package nobody touched, and the first person to see
    // it spends an hour on the wrong bug.
    await sql`create table customer_gate_fixture (id uuid primary key default uuid_generate_v7())`
    try {
      const coverage = await crmAuditCoverage(sql)
      const row = coverage.find((entry) => entry.table === 'customer_gate_fixture')
      expect(row).toBeDefined()
      expect(row?.covered).toBe(false)
      expect(row?.by).toBeNull()
      expect(row?.detail).toContain('CRM_AUDIT_COVERAGE does not register it')
      expect(coverage.every((entry) => entry.covered)).toBe(false)
    } finally {
      await sql`drop table customer_gate_fixture`
    }
  })

  it('reports a registered trigger that is not there as uncovered', async () => {
    // The other half of the same rule: the register is checked against `pg_trigger` rather than believed,
    // so a trigger dropped by a later migration is reported rather than assumed.
    const dropped = await probe(async (tx) => {
      await tx`drop trigger customer_lifecycle_state_audit on customer_lifecycle_state`
      const coverage = await crmAuditCoverage(tx)
      return coverage.find((row) => row.table === 'customer_lifecycle_state')
    })
    expect(dropped?.covered).toBe(false)
    expect(dropped?.detail).toContain('no such trigger')
    // Rolled back by the transaction, so the trigger is still there for every later suite.
    const after = await crmAuditCoverage(sql)
    expect(after.find((row) => row.table === 'customer_lifecycle_state')?.covered).toBe(true)
  })

  it('audits a vocabulary change through the trigger, with a stated actor when there is none', async () => {
    const [delta] = await auditDelta('customer_lifecycle_state.changed', () =>
      sql.begin(async (tx) => {
        await tx`
          update customer_lifecycle_state set description = description || '' where state = 'lead'
        `
      }),
    )
    expect(delta).toBe(1)
    const [row] = await sql<{ actor_kind: string; actor_label: string; entity_id: string }[]>`
      select actor_kind, actor_label, entity_id from audit_event
       where action = 'customer_lifecycle_state.changed' order by occurred_at desc, id desc limit 1
    `
    const record = row as { actor_kind: string; actor_label: string; entity_id: string }
    expect(record.entity_id).toBe('lead')
    // `system` with a label that says what it is: the honest description of a migration or a psql
    // correction, and visibly different from a named actor.
    expect(record.actor_kind).toBe('system')
    expect(record.actor_label).toContain('no transaction-local actor')
  })

  it('attributes a vocabulary change when the transaction-local actor is set', async () => {
    const [delta] = await auditDelta('customer_acquisition_source.changed', () =>
      sql.begin(async (tx) => {
        await tx`select set_config('berelax.audit_actor_kind', 'staff', true)`
        await tx`select set_config('berelax.audit_actor_label', 'Owner (fixture)', true)`
        await tx`
          update customer_acquisition_source set description = description || '' where source = 'web'
        `
      }),
    )
    expect(delta).toBe(1)
    const [row] = await sql<{ actor_kind: string; actor_label: string }[]>`
      select actor_kind, actor_label from audit_event
       where action = 'customer_acquisition_source.changed'
       order by occurred_at desc, id desc limit 1
    `
    expect((row as { actor_kind: string }).actor_kind).toBe('staff')
    expect((row as { actor_label: string }).actor_label).toBe('Owner (fixture)')
  })
})
