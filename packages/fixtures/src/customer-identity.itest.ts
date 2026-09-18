import {
  isAllocatedUaeMobile,
  nameMatchKey,
  normalisePhone,
  phoneMatchKey,
  UAE_MOBILE_PREFIXES,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  ensureCustomer,
  findCustomerByPhone,
  markPhoneVerified,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { customerLabel, SYNTHETIC_MOBILE_PREFIX, syntheticPerson } from './synthetic.ts'

/**
 * B-LIFE-02 — the pair: normalisation in `@berelax/core`, the row in `@berelax/db`.
 *
 * This suite lives in `packages/fixtures` because it is the only package allowed to depend on both.
 * `packages/db` must not import `packages/core` (`pnpm boundaries` enforces it), and the property
 * being proved is a property of the two together: that the match key the database generates and the
 * match key TypeScript computes are the same value, and that four spellings of one number resolve to
 * one `customer_id` rather than four.
 *
 * Every number here comes from `syntheticPerson`, which derives it from the unallocated `059` prefix.
 * Nothing in this file can reach a handset, and no customer has a name: they are labelled
 * `Customer 0042`, which is what they are in a fixture.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const FROZEN_ISO = '2026-09-18T18:00:00.000Z'
const FRONT_DESK: Actor = { kind: 'staff', label: 'Front desk' }

const PERSON = syntheticPerson(42)

/**
 * One number, five spellings. Two are the forms a customer types, one is what the front desk writes
 * down, one arrives from a WhatsApp paste and one is already canonical.
 */
const SPELLINGS = [
  PERSON.phone,
  `0${SYNTHETIC_MOBILE_PREFIX}0000042`,
  `971 ${SYNTHETIC_MOBILE_PREFIX} 000 0042`,
  `00971${SYNTHETIC_MOBILE_PREFIX}0000042`,
  `+971 ${SYNTHETIC_MOBILE_PREFIX} 000 00 42`,
] as const

const sql: Sql = createConnection({ url, max: 4 })

const guestBooking = (spelling: string) =>
  withUnitOfWork(sql, FRONT_DESK, (uow) =>
    ensureCustomer(uow, {
      phoneE164: normalisePhone(spelling),
      displayName: null,
      nameMatchKey: null,
      locale: 'en',
      createdVia: 'guest_booking',
    }),
  )

async function customerCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from customer`
  return Number(row?.n ?? '0')
}

async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

async function columnsMatching(table: string, pattern: string): Promise<string[]> {
  const rows = await sql<{ column_name: string }[]>`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and column_name ~ ${pattern}
    order by column_name
  `
  return rows.map((row) => row.column_name)
}

beforeEach(async () => {
  await sql`delete from customer`
})

afterAll(async () => {
  await sql`delete from customer`
  await sql.end({ timeout: 5 })
})

describe('one number is one customer', () => {
  it('reuses the customer_id for every accepted spelling', async () => {
    const first = await guestBooking(SPELLINGS[0])
    expect(first.created).toBe(true)

    for (const spelling of SPELLINGS.slice(1)) {
      const again = await guestBooking(spelling)
      expect(again.created).toBe(false)
      expect(again.customer.id).toBe(first.customer.id)
    }
    expect(await customerCount()).toBe(1)

    // The control. A different number must produce a different customer, or the assertion above is
    // satisfied by an upsert that ignores its argument.
    const other = await guestBooking(syntheticPerson(43).phone)
    expect(other.customer.id).not.toBe(first.customer.id)
    expect(await customerCount()).toBe(2)
  })

  it('refuses a second row for the same number at the database, not only in the repository', async () => {
    // The repository is the polite path. This is the guarantee underneath it: even a direct INSERT
    // cannot split one person into two rows, which is what makes the merge C-CRM owns a rare
    // administrative job rather than a daily cleanup.
    await sql`insert into customer (phone_e164, locale) values (${PERSON.phone}, 'en')`
    let caught: unknown
    try {
      await sql`insert into customer (phone_e164, locale) values (${PERSON.phone}, 'ar')`
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('23505')
    expect(await customerCount()).toBe(1)
  })

  it('refuses an un-normalised number rather than storing a second spelling', async () => {
    // The check constraint in 0019. Without it, `0590000042` written straight into the column is a
    // second customer for the same person, and nothing anywhere reports a fault.
    let caught: unknown
    try {
      await sql`insert into customer (phone_e164, locale) values ('0590000042', 'en')`
    } catch (error) {
      caught = error
    }
    expect((caught as { code?: string } | undefined)?.code).toBe('23514')
  })
})

describe('the match keys', () => {
  it('agrees with packages/core on the generated phone match key', async () => {
    for (const spelling of SPELLINGS) {
      await sql`delete from customer`
      const e164 = normalisePhone(spelling)
      const { customer } = await guestBooking(spelling)
      // The database generates the column; core computes the same key for the lookup side. This is
      // the assertion that catches the two definitions drifting apart, which would show up as a merge
      // that quietly stops finding duplicates.
      expect(customer.phoneMatchKey).toBe(phoneMatchKey(e164))
      expect(customer.phoneMatchKey).toBe('590000042')
    }
  })

  it('cannot be written by a caller, and a wrong key does not match', async () => {
    await guestBooking(PERSON.phone)
    // Generated always: the database refuses a supplied value rather than storing a second opinion
    // about the same nine digits.
    let caught: unknown
    try {
      await sql`update customer set phone_match_key = '000000000'`
    } catch (error) {
      caught = error
    }
    expect(caught).toBeDefined()

    // The control for the equality assertion above: a deliberately wrong key must not find the row.
    const [wrong] = await sql<{ n: string }[]>`
      select count(*)::text as n from customer where phone_match_key = '590000043'
    `
    expect(Number(wrong?.n)).toBe(0)
  })

  it('keys a written label onto the same value however it was spelled', async () => {
    const e164 = normalisePhone(PERSON.phone)
    const label = customerLabel(42)
    const { customer } = await withUnitOfWork(sql, FRONT_DESK, (uow) =>
      ensureCustomer(uow, {
        phoneE164: e164,
        displayName: label,
        nameMatchKey: nameMatchKey(label, e164),
        locale: 'en',
        createdVia: 'front_desk',
      }),
    )
    expect(customer.nameMatchKey).toBe(nameMatchKey(label, e164))

    // The same label in a different word order and case produces the same key, which is the whole
    // point: the desk and the booking form do not agree on either.
    const [found] = await sql<{ id: string }[]>`
      select id from customer where name_match_key = ${nameMatchKey('0042 CUSTOMER', e164)}
    `
    expect(found?.id).toBe(customer.id)

    // The control: a different record label must not collide.
    const [other] = await sql<{ id: string }[]>`
      select id from customer where name_match_key = ${nameMatchKey(customerLabel(43), e164)}
    `
    expect(other).toBeUndefined()
  })

  it('is indexed, both of them', async () => {
    const rows = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes where tablename = 'customer' order by indexname
    `
    const names = rows.map((row) => row.indexname)
    // An unindexed match key is a sequential scan of every customer per merge candidate, which is the
    // difference between a usable admin screen and one nobody opens twice.
    expect(names).toContain('customer_phone_match_key_idx')
    expect(names).toContain('customer_name_match_key_idx')
    expect(names).not.toContain('customer_match_key_idx_that_does_not_exist')
  })
})

describe('a guest booking creates no credential and no account', () => {
  it('creates a row with no verification and no name', async () => {
    const { customer, created } = await guestBooking(PERSON.phone)
    expect(created).toBe(true)
    expect(customer.phoneVerifiedAtIso).toBeNull()
    expect(customer.displayName).toBeNull()
    expect(customer.createdVia).toBe('guest_booking')
  })

  it('has no credential column at all, and the detector that says so can fail', async () => {
    // ADR 0014: no accounts means no password, no reset token, no customer-side hash to breach. That
    // is a claim about the SHAPE of the table, so it is asserted against information_schema rather
    // than by reading the migration file — a migration nobody applied would satisfy the second.
    expect(await columnsMatching('customer', '(password|credential|secret|token|hash)')).toEqual([])

    // The control. `phone_match_key` is not a credential and must not be reported as one, and the
    // pattern must still find a real one — otherwise this assertion holds for a table with a
    // `password_hash` column in it.
    expect(await columnsMatching('customer', 'match_key')).toEqual([
      'name_match_key',
      'phone_match_key',
    ])
    expect(
      await columnsMatching('google_connections', '(password|credential|secret|token|hash)'),
    ).not.toEqual([])
  })

  it('records the verification separately, when an OTP eventually proves the number', async () => {
    await guestBooking(PERSON.phone)
    const before = await auditCount('customer.phone_verified')
    const verified = await withUnitOfWork(sql, FRONT_DESK, (uow) =>
      markPhoneVerified(uow, normalisePhone(PERSON.phone), FROZEN_ISO),
    )
    expect(verified.phoneVerifiedAtIso).toBe(FROZEN_ISO)
    expect(await findCustomerByPhone(sql, normalisePhone(PERSON.phone))).toMatchObject({
      phoneVerifiedAtIso: FROZEN_ISO,
    })
    // A delta, because audit_event is append-only (ADR 0008) and shared with every other suite.
    expect(await auditCount('customer.phone_verified')).toBe(before + 1)
  })
})

describe('the fixture numbers stay undialable', () => {
  it('normalises like a real number without being one', () => {
    // Both halves have to hold. A fixture number must normalise exactly as a customer number does, or
    // this suite proves nothing about customer numbers; and it must not be able to ring anybody.
    expect(normalisePhone(PERSON.phone)).toBe(PERSON.phone)
    expect(isAllocatedUaeMobile(normalisePhone(PERSON.phone))).toBe(false)

    // The two prefix lists are in different packages for different reasons - core knows which
    // prefixes are allocated, fixtures needs one that is not - and this is what stops them drifting
    // into agreement. The day 059 is allocated, this fails and the fixture prefix has to move.
    expect(UAE_MOBILE_PREFIXES as readonly string[]).not.toContain(SYNTHETIC_MOBILE_PREFIX)

    // The control: an allocated prefix must be reported as allocated, or the assertion above holds
    // for a function that always says no.
    expect(isAllocatedUaeMobile(normalisePhone('0501234567'))).toBe(true)
  })
})
