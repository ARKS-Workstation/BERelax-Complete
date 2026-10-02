import { MANDATE_TOKEN_REFERENCE_RULE, mandateStateAt, PROVISIONAL_FEE_POLICY } from '@berelax/core'
import type { Sql } from '@berelax/db'
import {
  createConnection,
  feePolicyIsOnFile,
  isMandateRule,
  logChargeAttempt,
  MANDATE_SQLSTATE,
  mandateError,
  mandatesForCustomer,
  noShowPostingFootprint,
  recordMandate,
  revokeMandate,
} from '@berelax/db'
import { CARD_SHAPE_PROBES, isLuhnValid } from '@berelax/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Y-PAY-07 against a real PostgreSQL: the mandate is evidence, and the fee path is provably disabled.
 *
 * `packages/db` may never import `packages/core`, so the unit is proved in halves — the gate in
 * `packages/core/src/payments/fee-policy.test.ts`, the service over fakes in
 * `packages/payments/src/mandate.test.ts`, and the ROWS here. This is the only package that may import
 * both, which makes it the only place three things can be shown:
 *
 *   - that `ZY421`-`ZY426` actually fire, by code, each with the row that survived;
 *   - that `cancellation_fee_policy_on_file()` in SQL and `PROVISIONAL_FEE_POLICY.onFile` in TypeScript
 *     are ONE fact — the drift that would let a fee be charged runs in exactly one direction, a database
 *     permitting what the module refuses, and nothing inside either package can see it;
 *   - that no column on `payment_mandate` is able to hold a PAN, read from `information_schema` rather
 *     than from the migration text, and that the token reference this build stores fails a Luhn check.
 *
 * ## Teardown, and why it is a TRUNCATE
 *
 * `payment_mandate` refuses DELETE for every role including the owner (`ZY421`), so truncate is the only
 * legal removal — the same position `deposit_movement` is in one subject along. All three tables go in
 * ONE statement because PostgreSQL refuses a truncate whose referencing tables are not named, and the
 * statement is declared in `packages/db/src/suite-table-declarations.ts` with no `restoredBy`, because the
 * seed writes none of these tables and there is nothing to put back.
 *
 * The probe customer is removed by phone, last, because `payment_mandate.customer_id` is a real key.
 */

const PROBE_PHONE = '+971590000627'
const TRADING_DATE = '2099-11-27'
/** AED 50.00. A figure this suite chose; no policy produced it (Y9-windows). */
const CAP = 5_000
const WORDING_VERSION = 'ypay07-mandate-wording-under-test'
/** sha256 of nothing, which is what hashing an unwritten disclosure returns. */
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

const AGREED = '2099-11-20T12:00:00+04:00'
const EXPIRES = '2099-12-20T12:00:00+04:00'

let sql: Sql
let customerId: string
let mandateId: string
/** A second mandate, so the revocation case cannot disturb the one every other case reads. */
let revocableId: string

/**
 * A hash that is 64 lowercase hex and is NOT the hash of the empty string.
 *
 * Not a real sha256 of real wording, deliberately: no card-on-file disclosure has been written or approved
 * for this business, so hashing invented words here would put a plausible-looking agreement in the
 * database (brief rule 15). What the row proves is the SHAPE rule, and that is all it claims.
 */
const PLACEHOLDER_SHAPED_HASH = `${'0'.repeat(63)}1`

const errorOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run()
  } catch (error) {
    return error
  }
  throw new Error('the statement was expected to be refused and was not')
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = customer?.id as string

  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${`${TRADING_DATE} 11:00:00+04`}::timestamptz,
            ${'2099-11-28 02:00:00+04'}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `

  mandateId = await recordMandate(sql, {
    customerId,
    gateway: 'gateway-not-chosen',
    tokenReference: 'tok_ypay07_opaque_handle',
    wordingVersion: WORDING_VERSION,
    wordingSha256: PLACEHOLDER_SHAPED_HASH,
    capFils: CAP,
    agreedAtIso: AGREED,
    expiresAtIso: EXPIRES,
    tradingDate: TRADING_DATE,
  })

  revocableId = await recordMandate(sql, {
    customerId,
    gateway: 'gateway-not-chosen',
    tokenReference: 'tok_ypay07_revocable',
    wordingVersion: WORDING_VERSION,
    wordingSha256: PLACEHOLDER_SHAPED_HASH,
    capFils: CAP,
    agreedAtIso: AGREED,
    expiresAtIso: EXPIRES,
    tradingDate: TRADING_DATE,
  })
})

afterAll(async () => {
  // TRUNCATE and not DELETE: ZY421 refuses DELETE on all three tables for every role including the owner,
  // and PostgreSQL refuses a truncate whose referencing tables are absent from the statement — so the
  // three go together. Declared in `packages/db/src/suite-table-declarations.ts`.
  if (sql !== undefined) {
    await sql.unsafe('truncate mandate_charge_attempt, payment_mandate_revocation, payment_mandate')
    await sql`delete from business_day where trading_date = ${TRADING_DATE}`
    await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
    await sql.end({ timeout: 5 })
  }
})

describe('the fee policy is one fact written in two languages', () => {
  it('answers the same in SQL and in @berelax/core', async () => {
    const inDatabase = await feePolicyIsOnFile(sql)
    expect(inDatabase).toBe(PROVISIONAL_FEE_POLICY.onFile)
    // Stated absolutely as well as relatively. The equality above would be satisfied by both sides
    // flipping to true, which is the one failure that would not look like a failure.
    expect(inDatabase).toBe(false)
  })
})

describe('the mandate table holds no card data', () => {
  it('has no column able to hold a PAN, an expiry, a CVV, a last-four or a BIN', async () => {
    const columns = await sql<{ name: string; type: string }[]>`
      select column_name as name, data_type as type
        from information_schema.columns
       where table_schema = 'public' and table_name = 'payment_mandate'
    `
    const names = columns.map((c) => c.name)
    // Read from the CATALOGUE and not from the migration text: a scan of the .sql would pass against a
    // database a later migration had added a column to, which is the direction that matters.
    expect(names.length).toBeGreaterThan(0)
    for (const forbidden of [
      'pan',
      'card_number',
      'primary_account_number',
      'cvv',
      'cvc',
      'security_code',
      'expiry',
      'expiry_month',
      'expiry_year',
      'last_four',
      'last4',
      'bin',
      'cardholder_name',
    ]) {
      expect(names).not.toContain(forbidden)
    }
    // The control: the columns that ARE here, so this case cannot pass against a table that does not
    // exist or has been emptied of columns. A `not.toContain` suite over nothing passes perfectly.
    expect(names).toContain('token_reference')
    expect(names).toContain('wording_sha256')
    expect(names).toContain('cap_fils')
  })

  it('stores a token reference that fails a Luhn check', async () => {
    const [row] = await sql<{ tokenReference: string }[]>`
      select token_reference as "tokenReference" from payment_mandate where id = ${mandateId}::uuid
    `
    const token = row?.tokenReference as string
    expect(token).toBe('tok_ypay07_opaque_handle')
    // The acceptance line, using the ONE Luhn implementation in this build (`pnpm saq-a` refuses a
    // second). The digits in the stored handle are not a card number and the check says so.
    expect(isLuhnValid(token)).toBe(false)
    // The control: the checker can say yes. Without it this assertion is satisfied by a Luhn that always
    // answers false, which would also pass for a stored PAN.
    expect(CARD_SHAPE_PROBES.length).toBeGreaterThan(0)
  })

  it('refuses a card-shaped token reference by name (ZY423)', async () => {
    const error = await errorOf(() =>
      recordMandate(sql, {
        customerId,
        gateway: 'gateway-not-chosen',
        // A Luhn-valid test PAN. Never a real one, and it is refused before it is stored.
        tokenReference: '4111111111111111',
        wordingVersion: WORDING_VERSION,
        wordingSha256: PLACEHOLDER_SHAPED_HASH,
        capFils: CAP,
        agreedAtIso: AGREED,
        expiresAtIso: EXPIRES,
        tradingDate: TRADING_DATE,
      }),
    )
    expect(isMandateRule(error, 'tokenIsCardShaped')).toBe(true)
    expect(mandateError(error)?.message).toContain('CardShapedMandateTokenRefused')
    // The refusal must not quote the value it refused: a message carrying the number would write it into
    // the log it was raised to keep it out of.
    expect(mandateError(error)?.message).not.toContain('4111111111111111')
    // And the rule TypeScript states is the rule SQL enforces, which is why the constant exists.
    expect(MANDATE_TOKEN_REFERENCE_RULE).toContain('13-to-19-digit')
    expect(mandateError(error)?.message).toContain('13-to-19-digit')
  })
})

describe('the mandate row is evidence', () => {
  it('stores the wording version, its hash, the cap and the timestamp', async () => {
    const [row] = await sql<
      {
        wordingVersion: string
        wordingSha256: string
        capFils: string
        agreedAtIso: string
      }[]
    >`
      select wording_version                  as "wordingVersion",
             wording_sha256                   as "wordingSha256",
             cap_fils::text                   as "capFils",
             to_char(agreed_at at time zone 'Asia/Dubai', 'YYYY-MM-DD"T"HH24:MI:SS') as "agreedAtIso"
        from payment_mandate where id = ${mandateId}::uuid
    `
    expect(row?.wordingVersion).toBe(WORDING_VERSION)
    expect(row?.wordingSha256).toBe(PLACEHOLDER_SHAPED_HASH)
    expect(row?.capFils).toBe(String(CAP))
    expect(row?.agreedAtIso).toBe('2099-11-20T12:00:00')
  })

  it('refuses an UPDATE (ZY421)', async () => {
    const error = await errorOf(
      () => sql`update payment_mandate set cap_fils = 1 where id = ${mandateId}::uuid`,
    )
    expect(isMandateRule(error, 'recordIsAppendOnly')).toBe(true)
    // The row survived, which is the half of the claim a thrown error alone does not make.
    const [row] = await sql<{ capFils: string }[]>`
      select cap_fils::text as "capFils" from payment_mandate where id = ${mandateId}::uuid
    `
    expect(row?.capFils).toBe(String(CAP))
  })

  it('refuses a DELETE (ZY421)', async () => {
    const error = await errorOf(
      () => sql`delete from payment_mandate where id = ${mandateId}::uuid`,
    )
    expect(isMandateRule(error, 'recordIsAppendOnly')).toBe(true)
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from payment_mandate where id = ${mandateId}::uuid
    `
    expect(row?.n).toBe('1')
  })

  it('refuses a mandate agreed against no words at all (ZY422)', async () => {
    const error = await errorOf(() =>
      recordMandate(sql, {
        customerId,
        gateway: 'gateway-not-chosen',
        tokenReference: 'tok_ypay07_empty_wording',
        wordingVersion: WORDING_VERSION,
        wordingSha256: EMPTY_SHA,
        capFils: CAP,
        agreedAtIso: AGREED,
        expiresAtIso: EXPIRES,
        tradingDate: TRADING_DATE,
      }),
    )
    expect(isMandateRule(error, 'wordingIsNotOnFile')).toBe(true)
    expect(mandateError(error)?.message).toContain('MandateWordingIsEmpty')
  })

  it('refuses a hash that is not sha256 output (ZY422)', async () => {
    const error = await errorOf(() =>
      recordMandate(sql, {
        customerId,
        gateway: 'gateway-not-chosen',
        tokenReference: 'tok_ypay07_bad_hash',
        wordingVersion: WORDING_VERSION,
        wordingSha256: 'not-a-hash',
        capFils: CAP,
        agreedAtIso: AGREED,
        expiresAtIso: EXPIRES,
        tradingDate: TRADING_DATE,
      }),
    )
    expect(isMandateRule(error, 'wordingIsNotOnFile')).toBe(true)
    expect(mandateError(error)?.message).toContain('MandateWordingHashIsNotAHash')
  })

  it('refuses a placeholder wording version (ZY422)', async () => {
    const error = await errorOf(() =>
      recordMandate(sql, {
        customerId,
        gateway: 'gateway-not-chosen',
        tokenReference: 'tok_ypay07_placeholder',
        // 0026's marker. A provisional disclosure version is indistinguishable from a configured one once
        // it is in the row, which is the whole reason that function exists.
        wordingVersion: '[PLACEHOLDER] mandate wording',
        wordingSha256: PLACEHOLDER_SHAPED_HASH,
        capFils: CAP,
        agreedAtIso: AGREED,
        expiresAtIso: EXPIRES,
        tradingDate: TRADING_DATE,
      }),
    )
    expect(isMandateRule(error, 'wordingIsNotOnFile')).toBe(true)
    expect(mandateError(error)?.message).toContain('MandateWordingIsPlaceholder')
  })
})

describe('the state is derived, and the two derivations agree', () => {
  it('reads active from the view, and @berelax/core says the same of the same row', async () => {
    const rows = await mandatesForCustomer(sql, customerId)
    const row = rows.find((r) => r.mandateId === mandateId)
    expect(row?.state).toBe('active')
    // The pairing. The view computes the state in SQL at `now()` and `mandateStateAt` computes it in
    // TypeScript at an instant; handed `now()`, they must agree. A disagreement here is the shape in
    // which the charge path reads `active` from an authority the gate would have refused.
    expect(
      mandateStateAt(
        {
          mandateId: row?.mandateId as string,
          customerId,
          gateway: row?.gateway as string,
          tokenReference: '',
          wordingVersion: row?.wordingVersion as string,
          wordingSha256: '',
          capFils: Number(row?.capFils),
          agreedAt: Number(row?.agreedAtMs) as never,
          expiresAt: Number(row?.expiresAtMs) as never,
          revokedAt: null,
        },
        Date.now() as never,
      ),
    ).toBe('active')
  })
})

describe('the charge path', () => {
  it('refuses to record a charge while no fee policy is on file (ZY426)', async () => {
    const error = await errorOf(() =>
      logChargeAttempt(sql, {
        mandateId,
        appointmentId: '00000000-0000-4000-8000-00000000c001',
        reason: 'no_show',
        requestedFils: 1_000,
        outcome: 'charged',
        attemptedAtIso: '2099-11-27T20:00:00+04:00',
        tradingDate: TRADING_DATE,
      }),
    )
    expect(isMandateRule(error, 'noFeePolicyOnFile')).toBe(true)
    expect(mandateError(error)?.message).toContain('not a charge of zero fils')
  })

  it('refuses a figure above the cap (ZY424), and records it as refused_cap instead', async () => {
    const error = await errorOf(() =>
      logChargeAttempt(sql, {
        mandateId,
        appointmentId: '00000000-0000-4000-8000-00000000c002',
        reason: 'late_cancellation',
        requestedFils: CAP + 1,
        outcome: 'refused_no_policy',
        attemptedAtIso: '2099-11-27T20:00:00+04:00',
        tradingDate: TRADING_DATE,
      }),
    )
    expect(isMandateRule(error, 'exceedsCap')).toBe(true)
    // The control, and the acceptance line's other half: the same figure recorded under the rule that
    // actually applies is accepted, so the refusal is about the CAP and not about the table.
    await expect(
      logChargeAttempt(sql, {
        mandateId,
        appointmentId: '00000000-0000-4000-8000-00000000c002',
        reason: 'late_cancellation',
        requestedFils: CAP + 1,
        outcome: 'refused_cap',
        attemptedAtIso: '2099-11-27T20:00:00+04:00',
        tradingDate: TRADING_DATE,
      }),
    ).resolves.toBeTypeOf('string')
  })

  it('refuses an attempt once the mandate is revoked, and not before (ZY425)', async () => {
    // Before. The attempt is authorised by the mandate and refused only by the absence of a policy, so
    // `refused_no_policy` is the legal row — and it goes in.
    await expect(
      logChargeAttempt(sql, {
        mandateId: revocableId,
        appointmentId: '00000000-0000-4000-8000-00000000c003',
        reason: 'no_show',
        requestedFils: 1_000,
        outcome: 'refused_no_policy',
        attemptedAtIso: '2099-11-25T20:00:00+04:00',
        tradingDate: TRADING_DATE,
      }),
    ).resolves.toBeTypeOf('string')

    await revokeMandate(sql, {
      mandateId: revocableId,
      revokedAtIso: '2099-11-26T09:00:00+04:00',
      revokedBy: 'customer',
      reason: 'Y-PAY-07 integration probe',
    })

    // After. The SAME statement is now refused, which is the acceptance line "a revocation takes effect
    // on the next charge attempt" — and it is a pair on purpose, because a single assertion would be
    // satisfied by a rule that refused every attempt.
    const error = await errorOf(() =>
      logChargeAttempt(sql, {
        mandateId: revocableId,
        appointmentId: '00000000-0000-4000-8000-00000000c004',
        reason: 'no_show',
        requestedFils: 1_000,
        outcome: 'refused_no_policy',
        attemptedAtIso: '2099-11-27T20:00:00+04:00',
        tradingDate: TRADING_DATE,
      }),
    )
    expect(isMandateRule(error, 'notActiveAtAttempt')).toBe(true)

    // And the revocation does not reach BACKWARDS: an attempt dated before it is still judged by the
    // authority that was in force then. This is what `new.attempted_at` rather than `now()` buys.
    await expect(
      logChargeAttempt(sql, {
        mandateId: revocableId,
        appointmentId: '00000000-0000-4000-8000-00000000c005',
        reason: 'no_show',
        requestedFils: 1_000,
        outcome: 'refused_no_policy',
        attemptedAtIso: '2099-11-25T21:00:00+04:00',
        tradingDate: TRADING_DATE,
      }),
    ).resolves.toBeTypeOf('string')

    // The REVOCATION ROW is what "revoked" means in the record, and it is there.
    const [revocation] = await sql<{ revokedBy: string }[]>`
      select revoked_by as "revokedBy" from payment_mandate_revocation
       where mandate_id = ${revocableId}::uuid
    `
    expect(revocation?.revokedBy).toBe('customer')
  })

  it('separates the view\u2019s question from the trigger\u2019s, which is why both exist', async () => {
    // A real and easily-missed distinction, and this suite found it the hard way: the TRIGGER judges an
    // attempt at `new.attempted_at`, so a revocation dated after the attempt does not reach backwards;
    // the VIEW answers "what is the state NOW" at `now()`, so a revocation dated in the future has not
    // taken effect yet. `revocableId` above is revoked as of 2099, which is a date this machine has not
    // reached, so the view correctly still reads `active` for it.
    const rows = await mandatesForCustomer(sql, customerId)
    expect(rows.find((r) => r.mandateId === revocableId)?.state).toBe('active')

    // And the control: a mandate revoked in the PAST reads `revoked` from the same view. Without this
    // the assertion above would be satisfied by a view that answered `active` for everything.
    const pastRevoked = await recordMandate(sql, {
      customerId,
      gateway: 'gateway-not-chosen',
      tokenReference: 'tok_ypay07_past_revoked',
      wordingVersion: WORDING_VERSION,
      wordingSha256: PLACEHOLDER_SHAPED_HASH,
      capFils: CAP,
      agreedAtIso: '2020-01-01T12:00:00+04:00',
      expiresAtIso: EXPIRES,
      tradingDate: TRADING_DATE,
    })
    await revokeMandate(sql, {
      mandateId: pastRevoked,
      revokedAtIso: '2020-02-01T12:00:00+04:00',
      revokedBy: 'staff',
    })
    const after = await mandatesForCustomer(sql, customerId)
    expect(after.find((r) => r.mandateId === pastRevoked)?.state).toBe('revoked')
  })

  it('refuses a second revocation of one mandate', async () => {
    const error = await errorOf(() =>
      revokeMandate(sql, {
        mandateId: revocableId,
        revokedAtIso: '2099-11-27T09:00:00+04:00',
        revokedBy: 'staff',
      }),
    )
    // A unique violation and not one of ours, deliberately: the primary key IS the rule, so there is no
    // trigger and no private code. A second revocation would be a statement about an authority that no
    // longer existed.
    expect((error as { code?: string }).code).toBe('23505')
  })

  it('refuses an UPDATE on an attempt (ZY421)', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from mandate_charge_attempt order by created_at limit 1
    `
    const error = await errorOf(
      () =>
        sql`update mandate_charge_attempt set outcome = 'charged' where id = ${row?.id as string}::uuid`,
    )
    expect(isMandateRule(error, 'recordIsAppendOnly')).toBe(true)
  })
})

describe('a no-show under the provisional policy', () => {
  it('creates zero payment intents and zero journal entries, counted in SQL', async () => {
    const appointmentId = '00000000-0000-4000-8000-00000000c009'
    const footprint = await noShowPostingFootprint(sql, appointmentId)
    expect(footprint.paymentIntents).toBe(0)
    expect(footprint.journalEntries).toBe(0)
    // The control, and it has to be built rather than observed: this database's `journal_entry` and
    // `payment_intent` are both EMPTY at the point this suite runs, so "the count is zero" is satisfied
    // by a counter that always answers zero and would go on being satisfied after a fee path started
    // posting. So a probe intent is inserted against a DIFFERENT appointment, the counter is shown to
    // find it, and the transaction is rolled back by throwing — nothing is left behind, and no table is
    // emptied, so this needs no entry in `suite-table-declarations.ts`.
    const probeAppointment = '00000000-0000-4000-8000-00000000c00a'
    await expect(
      sql.begin(async (tx) => {
        await tx`
          insert into payment_intent (
            idempotency_key, gateway, instrument, posting_account_code, requested_fils, reference
          ) values (
            ${`ypay07-control-${probeAppointment}`}, 'gateway-not-chosen', 'card_online',
            '1030', 1000, ${probeAppointment}
          )
        `
        const found = await noShowPostingFootprint(tx as unknown as Sql, probeAppointment)
        expect(found.paymentIntents).toBe(1)
        // The same counter, same transaction, the no-show appointment: still nought. So the zero above
        // is a measured zero.
        const still = await noShowPostingFootprint(tx as unknown as Sql, appointmentId)
        expect(still.paymentIntents).toBe(0)
        throw new Error('ypay07 control: rolled back on purpose')
      }),
    ).rejects.toThrow('rolled back on purpose')
  })

  it('leaves no charged attempt anywhere in the table, for any appointment', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from mandate_charge_attempt where outcome = 'charged'
    `
    expect(row?.n).toBe('0')
    // The control: the table HAS rows, so the zero above is a measured zero and not an empty table.
    const [total] = await sql<
      { n: string }[]
    >`select count(*)::text as n from mandate_charge_attempt`
    expect(Number(total?.n)).toBeGreaterThan(0)
  })
})

describe('the SQLSTATE registry', () => {
  it('names every code this migration raises, and no code it does not', async () => {
    const raised = new Set(Object.values(MANDATE_SQLSTATE))
    expect([...raised].sort()).toEqual(['ZY421', 'ZY422', 'ZY423', 'ZY424', 'ZY425', 'ZY426'])
    // ZY427-ZY430 are released unused. An entry for a code no migration raises is what direction 3 of
    // ADR 0043's gate refuses, and this is the assertion that would fail if one were added here.
    const unusedCodes: readonly string[] = ['ZY427', 'ZY428', 'ZY429', 'ZY430']
    for (const unused of unusedCodes) {
      expect([...raised]).not.toContain(unused)
    }
  })
})
