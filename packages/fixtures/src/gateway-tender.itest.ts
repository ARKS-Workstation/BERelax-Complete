import { parseConfig } from '@berelax/config'
import { fixedClock, TENDER_KINDS, TENDER_TYPES, tenderTypeOf } from '@berelax/core'
import type { Sql } from '@berelax/db'
import { createConnection, readTenderTypes } from '@berelax/db'
import { createPaymentGateways } from '@berelax/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Migration 0105's row against `@berelax/core` and against the gateway registry, in three directions.
 *
 * `packages/fixtures` is the package allowed to depend on `@berelax/core` and `@berelax/db` at once (brief
 * rule 4), which is why `payment.itest.ts` lives here and why this does too. What is new is the third
 * direction: the tender registry says which ADAPTER owns each kind, and `@berelax/payments`' registry says
 * which gateway serves it. Those are two statements of one fact, and nothing had compared them — a
 * `card_online` row whose `adapter` said `manual` would post an online card through the till with every
 * other check still green.
 *
 * ## Why this is a separate file from `payment.itest.ts`
 *
 * Not to avoid duplication — the parity assertion IS duplicated here for the new row, deliberately, because
 * a claim asserted in one file that cannot run is a claim asserted nowhere. `payment.itest.ts` cannot run in
 * this tree: its file-level `beforeEach` truncates `invoice`, and migration 0097's `commission_line`
 * references `invoice` without being named in the statement, so PostgreSQL refuses it and all eight of its
 * tests fail before any of them reaches an assertion. That regression arrived with the commit this unit
 * branched from and is not this unit's to fix — `commission_line` is append-only (ZY072), so adding it to a
 * TRUNCATE list would silently bypass the guarantee its two triggers exist to make, which means the obvious
 * remedy is the wrong one and somebody has to decide between three real options.
 *
 * ## Why it truncates nothing
 *
 * It is read-only. Brief rule 12: the integration suite runs sequentially against one database and earlier
 * files leave rows behind, so a suite that has to clear a table is a suite that will one day fail on
 * somebody else's branch. Every assertion here is about rows a MIGRATION seeded, which no other suite
 * writes to, so there is nothing to isolate from.
 */

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url: url as string, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('the gateway tender kind exists in both registries and agrees', () => {
  it('holds every kind equal between @berelax/core and the database, in both directions', async () => {
    const rows = await readTenderTypes(sql)
    const byCode = new Map(rows.map((row) => [row.code, row]))

    // Direction 1: every kind core knows about is in the database, with the same six facts.
    for (const kind of TENDER_KINDS) {
      const spec = TENDER_TYPES[kind]
      const row = byCode.get(kind)
      expect(row, `the database holds a tender type "${kind}"`).toBeDefined()
      expect(row?.postingAccountCode, `${kind}.postingAccountCode`).toBe(spec.account)
      expect(row?.givesChange, `${kind}.givesChange`).toBe(spec.givesChange)
      expect(row?.requiresReference, `${kind}.requiresReference`).toBe(spec.requiresReference)
      expect(row?.settlesImmediately, `${kind}.settlesImmediately`).toBe(spec.settlesImmediately)
      expect(row?.adapter, `${kind}.adapter`).toBe(spec.adapter)
      expect(row?.sortOrder, `${kind}.sortOrder`).toBe(spec.sortOrder)
    }

    // Direction 2: the database holds no kind core does not know about. Without this the comparison is
    // satisfied by a database that has grown a fifth tender type nothing can post.
    expect(rows.map((row) => row.code).sort()).toEqual([...TENDER_KINDS].sort())
  })

  it('records card_online as the gateway kind, posting to 1030 and settling later', async () => {
    const rows = await readTenderTypes(sql)
    const card = rows.find((row) => row.code === 'card_online')
    expect(card, 'migration 0105 seeded no card_online row').toBeDefined()
    expect(card?.adapter).toBe('gateway')
    expect(card?.postingAccountCode).toBe('1030')
    expect(card?.settlesImmediately).toBe(false)
    expect(card?.requiresReference).toBe(true)
    expect(card?.givesChange).toBe(false)
    expect(card?.retiredAt).toBeNull()
  })

  it('the control: the comparison would notice a wrong account', async () => {
    // Six fields compared equal is exactly the shape that passes when both sides are read from one source
    // by mistake. 1040 is the in-salon terminal's clearing account and the plausible wrong answer: both
    // clear card money that has not arrived, and one account holding both streams reconciles against
    // neither statement on its own.
    const rows = await readTenderTypes(sql)
    const card = rows.find((row) => row.code === 'card_online')
    expect(card?.postingAccountCode).not.toBe('1040')
    expect(card?.postingAccountCode).not.toBe(TENDER_TYPES['card_in_salon'].account)
  })

  it('is the only row whose adapter is not the manual till', async () => {
    // The control on the other three rows: adding the fourth must not have moved any of them.
    const rows = await readTenderTypes(sql)
    expect(rows.filter((row) => row.adapter === 'gateway').map((row) => row.code)).toEqual([
      'card_online',
    ])
    expect(
      rows
        .filter((row) => row.adapter === 'manual')
        .map((row) => row.code)
        .sort(),
      // `deposit_on_account` is Y-PAY-06's fifth kind (0124) and is `manual` for the reason the other
      // three are: a person at the till applies it. It is named here rather than the filter being
      // loosened, because what this case is for is that adding a kind must not have MOVED any of the
      // others — a count or a `not.toContain` would stop saying that.
    ).toEqual(['bank_transfer', 'card_in_salon', 'cash', 'deposit_on_account'])
  })
})

describe('the gateway registry agrees with the database about who serves what', () => {
  it('routes every stored tender kind to a gateway whose name matches the stored adapter', async () => {
    // The third direction, and the one nothing had. `tender_type.adapter` is a word in a database column;
    // `registry.byInstrument` is what actually decides where the money goes. A row saying `manual` for
    // `card_online` would send an online card to the till, and the till would post it to 1030 anyway —
    // because the posting account comes from the registry the adapter reads, not from the routing.
    const registry = createPaymentGateways({
      config: parseConfig({ APP_ENV: 'test', DATABASE_URL: url as string }),
      clock: fixedClock('2026-09-28T19:30:00.000Z'),
    })
    const rows = await readTenderTypes(sql)
    expect(rows.length, 'no tender types were read, so this case measures nothing').toBeGreaterThan(
      3,
    )

    for (const row of rows) {
      const gateway = registry.byInstrument(row.code as (typeof TENDER_KINDS)[number])
      const expected = row.adapter === 'gateway' ? registry.cards : registry.till
      expect(gateway.name, `"${row.code}" (adapter ${row.adapter}) routed to ${gateway.name}`).toBe(
        expected.name,
      )
      // And the account the gateway will snapshot onto a movement is the one the database stores.
      expect(tenderTypeOf(row.code).account, `"${row.code}" posting account`).toBe(
        row.postingAccountCode,
      )
    }
  })

  it('the control: the routing distinguishes the two gateways', async () => {
    // Without this, the loop above is satisfied by a registry whose two gateways have the same name.
    const registry = createPaymentGateways({
      config: parseConfig({ APP_ENV: 'test', DATABASE_URL: url as string }),
      clock: fixedClock('2026-09-28T19:30:00.000Z'),
    })
    expect(registry.till.name).not.toBe(registry.cards.name)
    expect(registry.byInstrument('cash').name).toBe(registry.till.name)
    expect(registry.byInstrument('card_online').name).toBe(registry.cards.name)
  })
})
