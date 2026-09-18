import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'

/**
 * B-MSG-01 — the template model's database-side guarantees.
 *
 * Two of them cannot be asserted anywhere but against a real PostgreSQL: a trigger that refuses a
 * column change, and the claim that adding WhatsApp needs no migration. The second is the interesting
 * one — "the schema is channel-shaped" is an assertion about a schema, and the only honest way to
 * check it is to insert a WhatsApp variant into the shipped schema and see it land.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/**
 * This file's own template keys, and why they are now prefixed.
 *
 * It used to seed the shipped keys — `booking.confirmed`, `invoice.issued` — and clear the table with
 * `delete from message_template` in `beforeEach`. Both assumed this file owned the table, and B-MSG-04
 * ended that: `message.template_id` references it ON DELETE RESTRICT, because a sent message is
 * evidence and its template is the words it went out with. The blanket delete then failed against rows
 * another suite had every right to leave behind — the third case in
 * `docs/CONTRIBUTING-AGENT-BRIEF.md` §12, arriving from the other direction.
 *
 * So the keys are namespaced and the cleanup removes only those. A fixed prefix rather than a
 * per-run one, deliberately: a random suffix would leave every previous run's rows behind for ever,
 * where a fixed one means each run tidies up its predecessor's.
 */
const PREFIX = 'bmsg01-itest.'
const key = (name: string) => `${PREFIX}${name}`

beforeAll(() => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  // This file's templates only. Narrowing what the test can see is the fix; deleting rows a foreign
  // key protects is not.
  await sql`delete from message_template where template_key like ${`${PREFIX}%`}`
})

async function seedTemplate(
  key: string,
  messageClass: 'transactional' | 'promotional' = 'transactional',
) {
  const [row] = await sql<{ id: string }[]>`
    insert into message_template (template_key, version, message_class, purpose, is_current)
    values (${key}, 1, ${messageClass}, 'test', true)
    returning id
  `
  return row?.id ?? ''
}

describe('acceptance — message_class is immutable', () => {
  it('refuses an UPDATE of the column, with a named error', () => {
    // A class chosen per send puts the compliance decision at the least reviewed point in the system.
    // A class that can be edited afterwards is the same failure, slower.
    return seedTemplate(key('booking.confirmed')).then(async (id) => {
      await expect(
        sql`update message_template set message_class = 'promotional' where id = ${id}`,
      ).rejects.toThrow(/message_class is immutable/)
    })
  })

  it('permits an update that leaves the class alone, so the table is not read-only', async () => {
    const id = await seedTemplate(key('booking.confirmed'))
    await sql`update message_template set purpose = 'revised' where id = ${id}`
    const [row] = await sql<{ purpose: string }[]>`
      select purpose from message_template where id = ${id}
    `
    expect(row?.purpose).toBe('revised')
  })

  it('reclassifies through one privileged path that resets approval to pending', async () => {
    // The bodies carry over; the approval does not. A template whose class changed is a different
    // template as far as the regulator is concerned, so inheriting the approval it was granted as
    // transactional would launder it. Doing this as a function rather than three statements is the
    // point: the third statement is the one that gets skipped at 9pm.
    const id = await seedTemplate(key('booking.confirmed'))
    await sql`
      insert into message_template_variant (template_id, channel, locale, body, approval_state, variables)
      values (${id}, 'sms', 'en', 'Confirmed {{date}}', 'approved', '{"date"}')
    `
    const [created] = await sql<{ reclassify_template: string }[]>`
      select reclassify_template(${key('booking.confirmed')}, 'promotional', 'reclassified')
    `
    const newId = created?.reclassify_template ?? ''

    const [variant] = await sql<{ approval_state: string; body: string }[]>`
      select approval_state, body from message_template_variant where template_id = ${newId}
    `
    expect(variant?.approval_state).toBe('pending')
    expect(variant?.body).toBe('Confirmed {{date}}')

    const rows = await sql<{ version: number; is_current: boolean; message_class: string }[]>`
      select version, is_current, message_class from message_template
      where template_key = ${key('booking.confirmed')} order by version
    `
    expect(rows).toHaveLength(2)
    expect(rows[0]?.is_current).toBe(false)
    expect(rows[1]).toMatchObject({ version: 2, is_current: true, message_class: 'promotional' })
  })

  it('refuses a reclassification to the class it already has', async () => {
    await seedTemplate(key('booking.reminder'))
    await expect(
      sql`select reclassify_template(${key('booking.reminder')}, 'transactional', 'no-op')`,
    ).rejects.toThrow(/already transactional/)
  })

  it('refuses to reclassify a template that does not exist', async () => {
    await expect(
      sql`select reclassify_template(${key('nope')}, 'promotional', 'x')`,
    ).rejects.toThrow(/No current template/)
  })

  it('permits exactly one current version per key', async () => {
    await seedTemplate(key('booking.reminder'))
    await expect(
      sql`
        insert into message_template (template_key, version, message_class, purpose, is_current)
        values (${key('booking.reminder')}, 2, 'transactional', 'second current', true)
      `,
    ).rejects.toThrow(/message_template_one_current|unique/i)
  })
})

describe('acceptance — adding WhatsApp needs no migration', () => {
  it('accepts a whatsapp variant against the shipped schema', async () => {
    const id = await seedTemplate(key('booking.confirmed'))
    const [row] = await sql<{ channel: string; customer_care_window: boolean }[]>`
      insert into message_template_variant
        (template_id, channel, locale, body, category, customer_care_window, variables)
      values (${id}, 'whatsapp', 'ar', 'تم تأكيد حجزك', 'UTILITY', true, '{"date"}')
      returning channel, customer_care_window
    `
    expect(row?.channel).toBe('whatsapp')
    // The 24-hour window: outside it, only an approved template may be sent.
    expect(row?.customer_care_window).toBe(true)
  })

  it('refuses a channel the enum does not know, at the database level', async () => {
    const id = await seedTemplate(key('booking.confirmed'))
    await expect(
      sql`
        insert into message_template_variant (template_id, channel, locale, body, variables)
        values (${id}, 'telegram', 'en', 'hello', '{}')
      `,
    ).rejects.toThrow()
  })

  it('keeps one variant per channel per locale', async () => {
    const id = await seedTemplate(key('booking.confirmed'))
    await sql`
      insert into message_template_variant (template_id, channel, locale, body, variables)
      values (${id}, 'sms', 'en', 'first', '{}')
    `
    await expect(
      sql`
        insert into message_template_variant (template_id, channel, locale, body, variables)
        values (${id}, 'sms', 'en', 'second', '{}')
      `,
    ).rejects.toThrow(/unique|duplicate/i)
  })

  it('requires a subject for email and refuses one for SMS', async () => {
    // An email without a subject is a deliverability problem; an SMS has nowhere to put one, and a
    // subject silently stored and never sent is a field somebody will eventually rely on.
    const id = await seedTemplate(key('invoice.issued'))
    await expect(
      sql`
        insert into message_template_variant (template_id, channel, locale, body, variables)
        values (${id}, 'email', 'en', 'Attached', '{}')
      `,
    ).rejects.toThrow()
    await expect(
      sql`
        insert into message_template_variant (template_id, channel, locale, subject, body, variables)
        values (${id}, 'sms', 'en', 'Subject', 'Body', '{}')
      `,
    ).rejects.toThrow()
  })
})

describe('the variant carries what a send path needs', () => {
  it('defaults approval to draft, so nothing is sendable by existing', async () => {
    const id = await seedTemplate(key('booking.confirmed'))
    const [row] = await sql<{ approval_state: string; customer_care_window: boolean }[]>`
      insert into message_template_variant (template_id, channel, locale, body, variables)
      values (${id}, 'sms', 'en', 'Confirmed', '{}')
      returning approval_state, customer_care_window
    `
    expect(row?.approval_state).toBe('draft')
    expect(row?.customer_care_window).toBe(false)
  })

  it('stores the declared variables as an array the render path can check against', async () => {
    const id = await seedTemplate(key('booking.confirmed'))
    const [row] = await sql<{ variables: string[] }[]>`
      insert into message_template_variant (template_id, channel, locale, body, variables)
      values (${id}, 'sms', 'en', 'Confirmed {{date}} {{time}}', '{"date","time"}')
      returning variables
    `
    expect(row?.variables).toEqual(['date', 'time'])
  })

  it('cascades variants when a template is deleted', async () => {
    const id = await seedTemplate(key('booking.confirmed'))
    await sql`
      insert into message_template_variant (template_id, channel, locale, body, variables)
      values (${id}, 'sms', 'en', 'Confirmed', '{}')
    `
    // The control on the count below: the variant is there before the delete. A count of zero scoped
    // to a deleted id passes just as happily when the variant was never inserted.
    const [before] = await sql<{ n: string }[]>`
      select count(*)::text as n from message_template_variant where template_id = ${id}
    `
    expect(before?.n).toBe('1')
    await sql`delete from message_template where id = ${id}`
    // Scoped to this template, not the whole table: other units seed variants of their own, and a
    // global count here would read them.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from message_template_variant where template_id = ${id}
    `
    expect(row?.n).toBe('0')
  })
})
