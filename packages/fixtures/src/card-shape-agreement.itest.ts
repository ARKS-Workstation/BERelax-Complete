import { createConnection, PAYMENT_INTENT_SQLSTATE, type Sql } from '@berelax/db'
import { CARD_SHAPE_PROBES, cardShapedRuns, isLuhnValid } from '@berelax/payments'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The card shape is stated twice, and this is the check that holds the two equal (Y-PAY-03).
 *
 * `cardShapedRuns` in `packages/payments/src/redaction.ts` is the request boundary's rule. `is_card_shaped()`
 * in migration 0117 is the database's, and it exists because SQL cannot read TypeScript and a refusal in the
 * route handler is one `if` away from being skipped (ADR 0056's argument, applied to a value's shape).
 *
 * The brief's rule is that a second statement of a fact drifts and the check that holds the two equal ships in
 * the same commit. The direction the drift would take is the dangerous one: a database still accepting what the
 * boundary had started refusing, so a test asserting the refusal would be satisfied by the wrong layer and
 * nothing would say which.
 *
 * `CARD_SHAPE_PROBES` is the corpus and it is stated ONCE, in the TypeScript module, because a second corpus
 * would be two corpora within a month. Every entry carries the reason it is there.
 *
 * This suite creates nothing and removes nothing: it calls two functions and inserts one row into
 * `payment_intent` to see the trigger fire. That row cannot be deleted (ZY161 pins it through its movements
 * and this one has none, so the intent itself is deletable — but the suite still does not, because the rule is
 * that a suite removes only what it created and a row it created in a table nothing else reads costs nothing to
 * leave). Every assertion is a DELTA or is scoped to this run's own token.
 */

const RUN = `ypay03-shape-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const PAN = '4111111111111111'

let sql: Sql

beforeAll(() => {
  sql = createConnection({ url: url as string, max: 4 })
})

afterAll(async () => {
  await sql.end()
})

const sqlSaysCardShaped = async (text: string): Promise<boolean> => {
  const [row] = await sql<{ shaped: boolean }[]>`select is_card_shaped(${text}) as shaped`
  return row?.shaped === true
}

describe('the two statements of the card shape agree', () => {
  it('agrees on every probe in the shared corpus', async () => {
    const disagreements: string[] = []
    for (const probe of CARD_SHAPE_PROBES) {
      const inSql = await sqlSaysCardShaped(probe.text)
      const inTs = cardShapedRuns(probe.text).length > 0
      if (inSql !== inTs || inTs !== probe.cardShaped) {
        disagreements.push(
          `${JSON.stringify(probe.text)}: corpus ${probe.cardShaped}, TypeScript ${inTs}, SQL ${inSql}`,
        )
      }
    }
    expect(
      disagreements,
      'the request boundary and the database disagree about a card number',
    ).toEqual([])
    // Non-vacuity. A corpus that had lost its entries would make the loop above pass over nothing, which is
    // the shape of failure ADR 0002 is about. Both directions have a floor, measured against the corpus as it
    // is: eleven entries, four of them positive.
    expect(CARD_SHAPE_PROBES.length).toBeGreaterThanOrEqual(11)
    expect(CARD_SHAPE_PROBES.filter((probe) => probe.cardShaped).length).toBeGreaterThanOrEqual(4)
  })

  it('agrees on the Luhn check itself, including the digit that makes it fail', async () => {
    // The layer below the shape. Stated separately because a `luhn_check` that returned true for everything
    // would make `is_card_shaped` agree with the TypeScript on every POSITIVE probe while being wrong.
    const pairs: readonly [string, boolean][] = [
      [PAN, true],
      ['4111111111111112', false],
      ['4222222222222', true],
      ['4111111111112', false],
      ['', false],
      ['not digits', false],
    ]
    for (const [digits, expected] of pairs) {
      const [row] = await sql<{ ok: boolean }[]>`select luhn_check(${digits}) as ok`
      expect(row?.ok === true, `SQL luhn_check(${JSON.stringify(digits)})`).toBe(expected)
      expect(isLuhnValid(digits), `TypeScript isLuhnValid(${JSON.stringify(digits)})`).toBe(
        expected,
      )
    }
  })

  it('is NOT applied to audit_event or outbox_event, which is a decision and not an omission', async () => {
    // The strongest-sounding version of this rule, refused on measured grounds: those payloads carry a
    // fifteen-digit TRN, an IBAN whose BBAN can be sixteen digits or more, and E.164 numbers up to fifteen,
    // and about one arbitrary run in ten of that length is Luhn-valid. An audit write that can be refused is
    // an audit trail with a hole in it. See migration 0117 and ADR 0067.
    const [row] = await sql<{ triggers: string }[]>`
      select coalesce(string_agg(c.relname, ',' order by c.relname), '') as triggers
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
       where not t.tgisinternal
         and t.tgfoid = 'refuse_card_shaped_payment_text'::regproc
    `
    const tables = (row?.triggers ?? '').split(',').filter((name) => name !== '')
    expect(tables.sort()).toEqual(['payment_intent', 'payment_intent_transaction'])
  })
})

describe('ZY231 refuses a card-shaped reference, and names no value', () => {
  /** A minimal intent row. Every column the table requires and nothing else. */
  const insertIntent = async (reference: string, key: string): Promise<void> => {
    await sql`
      insert into payment_intent
        (idempotency_key, gateway, instrument, posting_account_code, requested_fils, reference)
      values (${key}, 'fake-card-gateway', 'card_online', '1030', 20000, ${reference})
    `
  }

  it('refuses the insert by its own code, with no value in the message', async () => {
    let code = ''
    let message = ''
    try {
      await insertIntent(`${RUN} ${PAN}`, `${RUN}-pan`)
    } catch (error) {
      code = (error as { code?: string }).code ?? ''
      message = error instanceof Error ? error.message : ''
    }
    expect(code).toBe(PAYMENT_INTENT_SQLSTATE.cardShapedText)
    // The reason it is a trigger and not a CHECK: a CHECK violation's DETAIL line prints the failing row, so
    // the constraint that kept the number out of the column would have written it into the server log.
    expect(message).not.toContain(PAN)
    expect(message).not.toContain('4111')
    // The control: the message DOES name the table and the column, so the assertions above are about the
    // value and not about a message that says nothing.
    expect(message).toContain('payment_intent')
    expect(message).toContain('reference')
  })

  it('refuses a card-shaped idempotency key too', async () => {
    let code = ''
    try {
      await insertIntent(`${RUN}-ok`, `${RUN}-${PAN}`)
    } catch (error) {
      code = (error as { code?: string }).code ?? ''
    }
    expect(code).toBe(PAYMENT_INTENT_SQLSTATE.cardShapedText)
  })

  it('the control: an ordinary reference is accepted, and the row appears', async () => {
    // Without this, both refusals above are satisfied by a trigger that refuses every insert.
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from payment_intent where reference like ${`${RUN}%`}
    `
    await insertIntent(`${RUN}/INV-0042`, `${RUN}-clean`)
    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from payment_intent where reference like ${`${RUN}%`}
    `
    // A DELTA and not a total: nothing in this table can be emptied, so every other suite's rows are here too.
    expect(Number(after[0]?.n ?? 0) - Number(before[0]?.n ?? 0)).toBe(1)
  })

  it('refuses a card number typed into a reference on an UPDATE as well as an INSERT', async () => {
    // An intent MOVES — ZY162 lets it — and a move must not be the opportunity to write a card number into the
    // reference. The trigger is `before insert or update` on this table for that reason, and this is the case
    // that would notice if it were narrowed to inserts.
    let code = ''
    try {
      await sql`
        update payment_intent set reference = ${`${RUN} ${PAN}`}
         where idempotency_key = ${`${RUN}-clean`}
      `
    } catch (error) {
      code = (error as { code?: string }).code ?? ''
    }
    expect(code).toBe(PAYMENT_INTENT_SQLSTATE.cardShapedText)
  })
})
