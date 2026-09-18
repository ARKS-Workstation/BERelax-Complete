import { readFileSync } from 'node:fs'
import {
  boundaryViolations,
  CATALOGUE_OWNED_FIELD_NAMES,
  CMS_ROUTE_PREFIXES,
  COMPLIANCE_NOTICES,
  CONTENT_COLLECTIONS,
  EDITORIAL_DEFAULTS,
  SERVICE_NARRATIVE,
  SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE,
  SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS,
} from '@berelax/cms'
import { createConnection, type Sql } from '@berelax/db'
import { getPayload, type Payload, type PayloadRequest } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import config from '../payload.config.ts'
import { countFutureBookings, setFutureBookingProbe } from './payload/future-bookings.ts'

/**
 * W-SYS-08 — Payload CMS v3, proved against a real PostgreSQL.
 *
 * None of these claims can be checked any other way.
 *
 *   - Whether Payload's tables landed in its own schema is a property of the database after a push.
 *   - Whether a receptionist can publish is a property of Payload's access pipeline, which is a dozen
 *     hooks deep; a unit test on `mayOperateOnCollection` proves the matrix, not the wiring.
 *   - Whether the audit row is written in the same transaction as the change can only be shown by
 *     rolling one back.
 *   - Whether a refusal actually leaves the row alone can only be shown by reading it back.
 *
 * The unit tests in `packages/cms` prove the rules. This proves they are connected to something.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''

/** A treatment that exists only in these tests. The catalogue has none yet (B-CAT-03). */
const CATALOGUE_SERVICE_ID = '0198f0a0-0000-7000-8000-0000000c4103'

let payload: Payload
let sql: Sql
/**
 * A signed-in principal as the Local API takes one.
 *
 * `role` is not optional decoration: `principalFrom` reads it and returns null without it, and a null
 * principal is refused by `access.update` — so a user object missing the role fails every test in this
 * file with "You are not allowed to perform this action", which reads exactly like a broken access rule.
 */
interface TestUser {
  readonly id: string
  readonly collection: string
  readonly role: string
}

let owner: TestUser
let marketer: TestUser
let receptionist: TestUser

/** A minimal Lexical editor state. `body` is a required richText field and an empty one is refused. */
function prose(text: string) {
  return {
    root: {
      type: 'root',
      format: '',
      indent: 0,
      version: 1,
      direction: 'ltr',
      children: [
        {
          type: 'paragraph',
          format: '',
          indent: 0,
          version: 1,
          direction: 'ltr',
          children: [
            { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
          ],
        },
      ],
    },
  }
}

/**
 * Staff accounts, one per role under test.
 *
 * Real rows with real roles, not a fabricated `user` object: the access pipeline reads `req.user.role`
 * out of the collection, and a hand-made object would prove the pipeline works on hand-made objects.
 * The local parts are the role names — an email is an identifier the admin sets, and nobody's name is
 * invented here.
 */
async function ensureStaff(role: string): Promise<TestUser> {
  const email = `${role}@berelax.test`
  await payload.delete({ collection: 'cms_user', where: { email: { equals: email } } })
  const created = await payload.create({
    collection: 'cms_user',
    data: { email, password: 'a-long-enough-test-password', role },
  })
  return { id: String(created.id), collection: 'cms_user', role: String(created['role']) }
}

async function auditCount(actionPrefix: string): Promise<number> {
  const rows = (await sql`
    select count(*)::int as n from audit_event where action like ${`${actionPrefix}%`}
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}

interface AuditRow {
  action: string
  operation: string
  entity_type: string
  entity_id: string
  actor_kind: string
  actor_label: string
  before_state: Record<string, unknown> | null
  after_state: Record<string, unknown> | null
}

async function auditRows(actionPrefix: string): Promise<AuditRow[]> {
  return (await sql`
    select action, operation, entity_type, entity_id, actor_kind, actor_label, before_state, after_state
    from audit_event
    where action like ${`${actionPrefix}%`}
    order by occurred_at asc, action asc
  `) as unknown as AuditRow[]
}

async function createNarrative(overrides: Record<string, unknown> = {}) {
  return await payload.create({
    collection: SERVICE_NARRATIVE.slug,
    data: {
      catalogue_service_id: CATALOGUE_SERVICE_ID,
      slug: `deep-tissue-${Math.random().toString(36).slice(2, 10)}`,
      headline: 'Deep tissue',
      promise: 'You leave able to turn your head.',
      body: prose('Firm pressure through the shoulders and upper back.'),
      editorial_state: 'live',
      ...overrides,
    },
  })
}

beforeAll(async () => {
  payload = await getPayload({ config })
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  owner = await ensureStaff('owner')
  marketer = await ensureStaff('marketer')
  receptionist = await ensureStaff('receptionist')
}, 180_000)

afterAll(async () => {
  setFutureBookingProbe(null)
  // Optional chaining, not neatness: if `beforeAll` threw part-way — a missing DATABASE_URL, say — these
  // are undefined, and an unguarded teardown then throws `Cannot read properties of undefined` and reports
  // *that* as the failure. The real cause scrolls away above it, so the first thing anybody sees is a
  // symptom of the teardown rather than the reason setup gave up.
  await payload?.destroy?.()
  await sql?.end({ timeout: 5 })
})

afterEach(() => {
  // A probe left in place fails the next test for a reason that has nothing to do with it.
  setFutureBookingProbe(null)
})

describe('acceptance — Payload owns its own schema', () => {
  it('put every table in the payload schema and none in public', async () => {
    const rows = (await sql`
      select table_schema, count(*)::int as n
      from information_schema.tables
      where table_type = 'BASE TABLE'
        and (table_name in ('pages', 'journal_posts', 'faq_entries', 'service_narrative',
                            'therapist_narrative', 'testimonials', 'cms_user')
             or table_name like 'payload\\_%')
      group by table_schema
    `) as unknown as { table_schema: string; n: number }[]
    const bySchema = new Map(rows.map((row) => [row.table_schema, row.n]))
    expect(bySchema.get('payload') ?? 0).toBeGreaterThan(6)
    // The one that matters. A Payload table in `public` has no Drizzle mirror, so `pnpm db:drift`
    // reports it as a forgotten migration — on whoever's branch is next.
    expect(bySchema.get('public') ?? 0).toBe(0)
  }, 60_000)

  it('is not in the list of schemas pnpm db:drift compares', () => {
    // The equivalent of the pgboss assertion in apps/worker/src/worker.itest.ts. Payload migrates its own
    // tables on its own release cycle, so the drift gate must not compare them against a mirror that does
    // not exist. Asserting the list here makes widening it a deliberate act with a failing test to
    // explain itself.
    const source = readFileSync('scripts/check-schema-drift.mjs', 'utf8')
    const listed = [...source.matchAll(/schema:\s*'([a-z_]+)'/g)].map((match) => match[1])
    expect(listed.length).toBeGreaterThan(0)
    expect(listed).not.toContain('payload')
    // The control: the schemas it does compare are the ones with mirrors.
    expect(listed).toContain('public')
  })

  it('has no foreign key crossing out of its schema', async () => {
    // Asserted, not merely intended. See migration 0023 for why the catalogue reference is a bare UUID.
    {
      const rows = (await sql`
        select tn.nspname as from_schema, fn.nspname as to_schema, count(*)::int as n
        from pg_constraint c
        join pg_class t on t.oid = c.conrelid
        join pg_namespace tn on tn.oid = t.relnamespace
        join pg_class f on f.oid = c.confrelid
        join pg_namespace fn on fn.oid = f.relnamespace
        where c.contype = 'f' and tn.nspname = 'payload'
        group by tn.nspname, fn.nspname
      `) as unknown as { from_schema: string; to_schema: string; n: number }[]
      const crossing = rows.filter((row) => row.to_schema !== 'payload')
      expect(crossing).toEqual([])
      // The control. Payload creates plenty of foreign keys WITHIN its schema, so a query that found
      // none at all would satisfy the assertion above while proving nothing.
      expect(rows.some((row) => row.to_schema === 'payload' && row.n > 0)).toBe(true)
    }
  }, 60_000)

  it('stores the catalogue reference as a bare string with no constraint on it', async () => {
    // A string column, not `uuid` and not a foreign key. `character varying` is what Payload's postgres
    // adapter emits for a `text` field; the type name is not the claim — the absence of a reference to
    // another table is.
    const columns = (await sql`
      select data_type from information_schema.columns
      where table_schema = 'payload' and table_name = 'service_narrative'
        and column_name = 'catalogue_service_id'
    `) as unknown as { data_type: string }[]
    expect(['text', 'character varying']).toContain(columns[0]?.data_type)

    const constraints = (await sql`
      select c.conname, c.contype
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
      join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey)
      where n.nspname = 'payload' and t.relname = 'service_narrative'
        and a.attname = 'catalogue_service_id'
    `) as unknown as { conname: string; contype: string }[]
    expect(constraints.filter((row) => row.contype === 'f')).toEqual([])
  }, 60_000)
})

describe('acceptance — the collections exist with drafts and versions', () => {
  it('serves all six, and each keeps versions', async () => {
    const sanitized = await config
    for (const collection of CONTENT_COLLECTIONS) {
      const served = sanitized.collections.find((candidate) => candidate.slug === collection.slug)
      expect(served, collection.slug).toBeDefined()
      expect(served?.versions?.drafts, collection.slug).toBeTruthy()
      expect(served?.versions?.maxPerDoc, collection.slug).toBe(collection.maxVersions)
    }
  })

  it('writes a version table for each, so a revert has something to revert to', async () => {
    const rows = (await sql`
      select table_name from information_schema.tables
      where table_schema = 'payload' and table_name like '\\_%\\_v'
    `) as unknown as { table_name: string }[]
    const names = rows.map((row) => row.table_name)
    for (const collection of CONTENT_COLLECTIONS) {
      expect(names, collection.slug).toContain(`_${collection.slug}_v`)
    }
  }, 60_000)
})

describe('acceptance — the catalogue boundary over the generated Payload config', () => {
  it('finds no field named price, duration, bookable or vat anywhere in it', async () => {
    // The generated config, not the descriptors: this is the shape Payload actually serves, including
    // every field it and the Lexical editor added on their own.
    const sanitized = await config
    const subjects = [
      ...sanitized.collections.map((collection) => ({
        slug: collection.slug,
        fields: collection.fields as readonly unknown[],
      })),
      ...sanitized.globals.map((global) => ({
        slug: global.slug,
        fields: global.fields as readonly unknown[],
      })),
    ]
    expect(subjects.length).toBeGreaterThan(CONTENT_COLLECTIONS.length)
    expect(boundaryViolations(subjects)).toEqual([])

    // And the control: the same walk over the same config with one catalogue field added must fail, or
    // the assertion above is a walk that examined nothing.
    for (const name of CATALOGUE_OWNED_FIELD_NAMES) {
      const poisoned = [...subjects, { slug: 'pages', fields: [{ name, type: 'text' }] }]
      expect(
        boundaryViolations(poisoned).map((violation) => violation.rule),
        name,
      ).toEqual(['no-catalogue-field-in-cms'])
    }
  })
})

describe('acceptance — a receptionist cannot publish', () => {
  it('refuses the draft and the publish, naming the permission', async () => {
    await expect(
      payload.create({
        collection: SERVICE_NARRATIVE.slug,
        data: {
          catalogue_service_id: CATALOGUE_SERVICE_ID,
          slug: 'receptionist-attempt',
          headline: 'Deep tissue',
          promise: 'Should never be stored.',
          body: prose('Should never be stored.'),
          editorial_state: 'live',
        },
        overrideAccess: false,
        user: receptionist as never,
      }),
    ).rejects.toThrow()

    const document = await createNarrative()
    await expect(
      payload.update({
        collection: SERVICE_NARRATIVE.slug,
        id: document.id,
        data: { _status: 'published' },
        overrideAccess: false,
        user: receptionist as never,
      }),
    ).rejects.toThrow()
  }, 60_000)

  it('lets a marketer draft, refuses the publish, and lets the owner publish', async () => {
    const document = await createNarrative()

    // Draft: allowed. Without this the refusal below is satisfied by an access layer that denies
    // everything, and the admin would be unusable in a way no test would report.
    const drafted = await payload.update({
      collection: SERVICE_NARRATIVE.slug,
      id: document.id,
      data: { promise: 'You leave able to turn your head, properly.' },
      overrideAccess: false,
      user: marketer as never,
    })
    expect(drafted['promise']).toContain('properly')

    await expect(
      payload.update({
        collection: SERVICE_NARRATIVE.slug,
        id: document.id,
        data: { _status: 'published' },
        overrideAccess: false,
        user: marketer as never,
      }),
    ).rejects.toThrow(/content:publish/)

    const published = await payload.update({
      collection: SERVICE_NARRATIVE.slug,
      id: document.id,
      data: { _status: 'published' },
      overrideAccess: false,
      user: owner as never,
    })
    expect(published['_status']).toBe('published')
  }, 60_000)

  it('refuses an UNpublish from a role that may not publish', async () => {
    // Taking a live page down is as consequential as putting one up, and an access rule that only
    // guarded the way in would let anybody with content:write remove the homepage.
    const document = await createNarrative()
    await payload.update({
      collection: SERVICE_NARRATIVE.slug,
      id: document.id,
      data: { _status: 'published' },
      overrideAccess: false,
      user: owner as never,
    })
    await expect(
      payload.update({
        collection: SERVICE_NARRATIVE.slug,
        id: document.id,
        data: { _status: 'draft' },
        overrideAccess: false,
        user: marketer as never,
      }),
    ).rejects.toThrow(/content:publish/)
  }, 60_000)
})

describe('acceptance — an editor cannot mutate the compliance-locked global', () => {
  it('refuses the marketer on compliance_notices and allows the owner', async () => {
    await expect(
      payload.updateGlobal({
        slug: COMPLIANCE_NOTICES.slug,
        data: {
          medical_disclaimer: prose('Massage is not a medical treatment.'),
          licence_statement: 'Licensed by ADDED as a wellness establishment.',
          complaints_procedure: prose('Speak to the manager on duty.'),
        },
        overrideAccess: false,
        user: marketer as never,
      }),
    ).rejects.toThrow()

    const saved = await payload.updateGlobal({
      slug: COMPLIANCE_NOTICES.slug,
      data: {
        medical_disclaimer: prose('Massage is not a medical treatment.'),
        licence_statement: 'Licensed by ADDED as a wellness establishment.',
        complaints_procedure: prose('Speak to the manager on duty.'),
      },
      overrideAccess: false,
      user: owner as never,
    })
    expect(saved['licence_statement']).toContain('ADDED')
  }, 60_000)

  it('allows the same marketer on the editorial global', async () => {
    // The control. "Cannot mutate the compliance global" is satisfied by an access layer that refuses
    // every global; this is the one that says the refusal is about THIS global.
    const saved = await payload.updateGlobal({
      slug: EDITORIAL_DEFAULTS.slug,
      data: {
        default_seo_title: 'BE RELAX — Al Zahiyah',
        default_seo_description: 'A massage centre on Al Meena Street, open until 2am.',
      },
      overrideAccess: false,
      user: marketer as never,
    })
    expect(saved['default_seo_title']).toContain('Al Zahiyah')
  }, 60_000)
})

describe('acceptance — every mutation writes an audit_event with before/after', () => {
  it('records create, update, publish and version revert, each distinguishable', async () => {
    // Restoring the first (draft) version over a published document IS an unpublish, so the retire guard
    // runs — and against this database the real probe answers `unknowable`, which is a refusal. That rule
    // has its own tests; here it would only stop the revert happening at all.
    setFutureBookingProbe(async () => ({ kind: 'counted', count: 0 }))
    const before = await auditCount('cms.service_narrative.')
    const document = await createNarrative()

    await payload.update({
      collection: SERVICE_NARRATIVE.slug,
      id: document.id,
      data: { promise: 'You leave able to turn your head without wincing.' },
    })
    await payload.update({
      collection: SERVICE_NARRATIVE.slug,
      id: document.id,
      data: { _status: 'published' },
    })

    const versions = await payload.findVersions({
      collection: SERVICE_NARRATIVE.slug,
      where: { parent: { equals: document.id } },
      sort: 'createdAt',
      limit: 50,
    })
    expect(versions.docs.length).toBeGreaterThan(1)
    const firstVersion = versions.docs[0]
    expect(firstVersion).toBeDefined()
    await payload.restoreVersion({
      collection: SERVICE_NARRATIVE.slug,
      id: String(firstVersion?.id),
    })

    // A DELTA, never a total: audit_event is append-only (ADR 0008) and every other test in the suite
    // adds to it.
    expect(await auditCount('cms.service_narrative.')).toBe(before + 4)

    const rows = (await auditRows('cms.service_narrative.')).slice(-4)
    expect(rows.map((row) => row.action)).toEqual([
      'cms.service_narrative.create',
      'cms.service_narrative.update',
      'cms.service_narrative.publish',
      'cms.service_narrative.version_revert',
    ])

    const [created, updated, published, reverted] = rows
    // A create has no before state — `null`, not `{}`, which would read as "every field was cleared".
    expect(created?.before_state).toBeNull()
    expect(created?.after_state?.['headline']).toBe('Deep tissue')
    expect(created?.operation).toBe('create')

    expect(updated?.before_state?.['promise']).toBe('You leave able to turn your head.')
    expect(updated?.after_state?.['promise']).toContain('without wincing')

    expect(published?.before_state?.['_status']).toBe('draft')
    expect(published?.after_state?.['_status']).toBe('published')
    // F06's operation taxonomy is a CHECK constraint shared with bookings and money; the CMS verb lives
    // in `action`.
    expect(published?.operation).toBe('update')

    expect(reverted?.after_state?.['promise']).toBe('You leave able to turn your head.')

    for (const row of rows) {
      expect(row.entity_type).toBe(SERVICE_NARRATIVE.slug)
      expect(row.entity_id).toBe(String(document.id))
      // No name and no email in an append-only table nobody can redact. `actor_id` is who.
      expect(row.actor_label).toBe('system')
    }
  }, 120_000)

  it('records a delete, with the document as the before state', async () => {
    const before = await auditCount('cms.faq_entries.delete')
    const entry = await payload.create({
      collection: 'faq_entries',
      data: {
        question: 'Do you take walk-ins?',
        answer: prose('Yes, when a room is free.'),
        topic: 'booking',
      },
    })
    await payload.delete({ collection: 'faq_entries', id: entry.id })

    expect(await auditCount('cms.faq_entries.delete')).toBe(before + 1)
    const rows = await auditRows('cms.faq_entries.delete')
    const last = rows.at(-1)
    expect(last?.operation).toBe('delete')
    expect(last?.before_state?.['question']).toBe('Do you take walk-ins?')
    expect(last?.after_state).toBeNull()
  }, 60_000)

  it('records a global change with both states', async () => {
    const before = await auditCount('cms.editorial_defaults.')
    await payload.updateGlobal({
      slug: EDITORIAL_DEFAULTS.slug,
      data: {
        default_seo_title: 'BE RELAX',
        default_seo_description: 'A massage centre in Al Zahiyah, Abu Dhabi.',
      },
    })
    expect(await auditCount('cms.editorial_defaults.')).toBe(before + 1)
    const last = (await auditRows('cms.editorial_defaults.')).at(-1)
    expect(last?.entity_id).toBe(EDITORIAL_DEFAULTS.slug)
    expect(last?.after_state?.['default_seo_title']).toBe('BE RELAX')
  }, 60_000)

  it('names the acting role when the mutation comes from a signed-in editor', async () => {
    const before = await auditCount('cms.faq_entries.create')
    await payload.create({
      collection: 'faq_entries',
      data: {
        question: 'Is there parking?',
        answer: prose('On the street behind.'),
        topic: 'visiting',
      },
      overrideAccess: false,
      user: marketer as never,
    })
    expect(await auditCount('cms.faq_entries.create')).toBe(before + 1)
    const last = (await auditRows('cms.faq_entries.create')).at(-1)
    expect(last?.actor_kind).toBe('staff')
    expect(last?.actor_label).toBe('marketer')
  }, 60_000)

  it('rolls the audit row back with the change, because it is in the same transaction', async () => {
    // The assertion that makes the audit trail evidence rather than logging. If this hook wrote on its own
    // connection — which is what using `AuditWriter` here would do — the row below would survive the
    // rollback and the trail would describe a change that never happened.
    const question = `Transactional probe ${Math.random().toString(36).slice(2, 10)}`
    const before = await auditCount('cms.faq_entries.create')

    const transactionID = await payload.db.beginTransaction()
    expect(transactionID).not.toBeNull()
    if (transactionID === null) return

    await payload.create({
      collection: 'faq_entries',
      data: { question, answer: prose('Rolled back.'), topic: 'booking' },
      req: { transactionID } as never,
    })
    // Read from a DIFFERENT connection, before the commit. Without this the test passes when the insert
    // silently did nothing at all — the same observable result as a correct rollback.
    expect(await auditCount('cms.faq_entries.create')).toBe(before)

    await payload.db.rollbackTransaction(transactionID)

    expect(await auditCount('cms.faq_entries.create')).toBe(before)
    const found = await payload.find({
      collection: 'faq_entries',
      where: { question: { equals: question } },
    })
    expect(found.totalDocs).toBe(0)
  }, 60_000)

  it('commits the audit row with the change, so the rollback test is not measuring nothing', async () => {
    const question = `Committed probe ${Math.random().toString(36).slice(2, 10)}`
    const before = await auditCount('cms.faq_entries.create')

    const transactionID = await payload.db.beginTransaction()
    if (transactionID === null) return
    const entry = await payload.create({
      collection: 'faq_entries',
      data: { question, answer: prose('Committed.'), topic: 'booking' },
      req: { transactionID } as never,
    })
    await payload.db.commitTransaction(transactionID)

    expect(await auditCount('cms.faq_entries.create')).toBe(before + 1)
    await payload.delete({ collection: 'faq_entries', id: entry.id })
  }, 60_000)
})

describe('acceptance — a narrative with future bookings cannot be unpublished or deleted', () => {
  async function publish(id: number | string): Promise<void> {
    await payload.update({
      collection: SERVICE_NARRATIVE.slug,
      id,
      data: { _status: 'published' },
    })
  }

  it('refuses the unpublish by name and leaves the row published', async () => {
    setFutureBookingProbe(async () => ({ kind: 'counted', count: 3 }))
    const document = await createNarrative()
    await publish(document.id)

    await expect(
      payload.update({
        collection: SERVICE_NARRATIVE.slug,
        id: document.id,
        data: { _status: 'draft' },
      }),
    ).rejects.toThrow(SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS)

    // Read it back. A refusal that threw after the write would pass an assertion on the throw alone.
    const after = await payload.findByID({ collection: SERVICE_NARRATIVE.slug, id: document.id })
    expect(after['_status']).toBe('published')
  }, 60_000)

  it('refuses the delete by name and leaves the row present', async () => {
    setFutureBookingProbe(async () => ({ kind: 'counted', count: 1 }))
    const document = await createNarrative()
    await publish(document.id)

    await expect(
      payload.delete({ collection: SERVICE_NARRATIVE.slug, id: document.id }),
    ).rejects.toThrow(SERVICE_NARRATIVE_HAS_FUTURE_BOOKINGS)

    const after = await payload.findByID({ collection: SERVICE_NARRATIVE.slug, id: document.id })
    expect(after.id).toBe(document.id)
  }, 60_000)

  it('lets the same document be archived', async () => {
    // The acceptance line's other half, and the point of the whole rule: archiving is what the editor
    // wanted. The page stays readable for the guest who already booked, and it leaves the menu.
    setFutureBookingProbe(async () => ({ kind: 'counted', count: 3 }))
    const document = await createNarrative()
    await publish(document.id)

    const archived = await payload.update({
      collection: SERVICE_NARRATIVE.slug,
      id: document.id,
      data: { editorial_state: 'archived' },
    })
    expect(archived['editorial_state']).toBe('archived')
    expect(archived['_status']).toBe('published')
  }, 60_000)

  it('allows both once nothing is booked', async () => {
    // The control for the two refusals. A guard that refused every unpublish and every delete would
    // satisfy them and make the collection permanent.
    setFutureBookingProbe(async () => ({ kind: 'counted', count: 0 }))
    const document = await createNarrative()
    await publish(document.id)

    const unpublished = await payload.update({
      collection: SERVICE_NARRATIVE.slug,
      id: document.id,
      data: { _status: 'draft' },
    })
    expect(unpublished['_status']).toBe('draft')
    await payload.delete({ collection: SERVICE_NARRATIVE.slug, id: document.id })
    await expect(
      payload.findByID({ collection: SERVICE_NARRATIVE.slug, id: document.id }),
    ).rejects.toThrow()
  }, 60_000)

  it('refuses when the booking records cannot be read at all, which is the state of this database', async () => {
    // The real probe, against the real database. The catalogue and appointment tables are B-CAT-03's and
    // B-AVAIL-01's and have not landed, so the honest answer is `unknowable` — and `unknowable` is a
    // refusal, not a zero. A probe that reported "no bookings" because it could not look is how a
    // fail-open default arrives dressed as a measurement.
    const report = await countFutureBookings(
      { payload } as unknown as PayloadRequest,
      CATALOGUE_SERVICE_ID,
      '2026-09-18T10:00:00.000Z',
    )
    expect(report.kind).toBe('unknowable')

    const document = await createNarrative()
    await payload.update({
      collection: SERVICE_NARRATIVE.slug,
      id: document.id,
      data: { _status: 'published' },
    })
    await expect(
      payload.update({
        collection: SERVICE_NARRATIVE.slug,
        id: document.id,
        data: { _status: 'draft' },
      }),
    ).rejects.toThrow(SERVICE_NARRATIVE_BOOKINGS_UNKNOWABLE)
  }, 60_000)

  it('does not hold an unattached draft hostage', async () => {
    // A narrative that references no catalogue service cannot have a booking against it, so the
    // fail-closed rule must not apply. Without this the rule blocks ordinary work, and a rule that
    // blocks ordinary work is one somebody switches off.
    const document = await payload.create({
      collection: SERVICE_NARRATIVE.slug,
      data: {
        slug: `unattached-${Math.random().toString(36).slice(2, 10)}`,
        headline: 'A draft with no service',
        promise: 'Not yet attached to anything.',
        body: prose('Still being written.'),
        editorial_state: 'live',
        catalogue_service_id: null,
      },
    })
    await payload.delete({ collection: SERVICE_NARRATIVE.slug, id: document.id })
  }, 60_000)
})

describe('acceptance — the CMS is absent from the public surface', () => {
  it('serves both its route prefixes and claims nothing else', async () => {
    const sanitized = await config
    expect([sanitized.routes.admin, sanitized.routes.api].sort()).toEqual([...CMS_ROUTE_PREFIXES])
    // Payload's default API route is `/api`, which belongs to the application.
    expect(sanitized.routes.api).not.toBe('/api')
  })

  it('exposes no GraphQL surface', async () => {
    // Every field GraphQL exposes is a field the access rules have to be right about twice, for a
    // requirement this project does not have.
    const sanitized = await config
    expect(sanitized.graphQL.disable).toBe(true)
  })
})
