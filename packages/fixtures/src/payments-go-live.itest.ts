import {
  STATEMENT_DESCRIPTOR_LIMIT_SETTING_KEY,
  STATEMENT_DESCRIPTOR_SETTING_KEY,
} from '@berelax/config'
import {
  lintStatementDescriptor,
  MCC_OPEN_QUESTION,
  mayUseRealPaymentProvider,
} from '@berelax/core'
import {
  createConnection,
  readMccConfirmation,
  readStatementDescriptor,
  type Sql,
  unconfirmedAssumptionRows,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Y-PAY-10 against a real PostgreSQL: the MCC's absence as a ROW, and the descriptor as a stored marker.
 *
 * The lint, the privacy claim and the real-provider verdict are judged with no database at all in
 * `packages/core/src/payments/descriptor.test.ts`; the prerequisite list is held against the route
 * registry in `apps/web/src/payments-go-live.test.ts`. What this file drives is the composition — the
 * three `legal_entity` columns, the two settings as they are actually stored, the panel branch that makes
 * both visible, and `ZY771`.
 *
 * Every write here runs inside a transaction that is ALWAYS rolled back. `legal_entity` is the singleton
 * every tax invoice is snapshotted from (`opening-balances.itest.ts`'s recorded defect, brief rule 12),
 * so a committed MCC would leave this database claiming an acquirer that does not exist — in every later
 * suite's view of it, and in the Unconfirmed Assumptions panel.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
const ROLLBACK = 'ypay10 rollback'

beforeAll(() => {
  sql = createConnection({ url, max: 3 })
})

afterAll(async () => {
  // Nothing to clean: every write is rolled back and nothing is committed. See the header.
  await sql?.end({ timeout: 5 })
})

/** Runs a body in a transaction that is ALWAYS rolled back, carrying its answer out. */
async function probe<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (tx) => {
      carried = await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== ROLLBACK) throw error
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

describe('acceptance — the descriptor and the MCC both appear in the Unconfirmed Assumptions result', () => {
  it('the MCC is a row on the panel, keyed on its absence rather than on a placeholder', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const mcc = rows.find((row) => row.source === 'legal_entity' && row.reference === 'mcc')
    expect(mcc).toBeDefined()
    expect(mcc?.openQuestionId).toBe(MCC_OPEN_QUESTION)
    // The note has to say what the absence COSTS, not merely that it exists: the panel is read by
    // somebody deciding what to chase.
    expect(mcc?.note).toContain('ZY771')
  })

  it('both descriptor settings are on the panel, flagged provisional', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const keys = rows.filter((row) => row.source === 'app_setting').map((row) => row.reference)
    expect(keys).toContain(STATEMENT_DESCRIPTOR_SETTING_KEY)
    expect(keys).toContain(STATEMENT_DESCRIPTOR_LIMIT_SETTING_KEY)
  })

  it('the stored descriptor is a MARKER the lint refuses, not a plausible line', async () => {
    const stored = await readStatementDescriptor(sql)
    const verdict = lintStatementDescriptor({
      descriptor: stored.descriptor as string | null,
      limit: stored.limit as number | null,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    const rules = verdict.refusals.map((refusal) => refusal.rule)
    expect(rules).toContain('descriptor-not-configured')
    expect(rules).toContain('descriptor-limit-not-configured')
  })

  it('the MCC confirmation reads back as three absences, so a refusal can name which', async () => {
    const confirmation = await readMccConfirmation(sql)
    expect(confirmation).toEqual({ mcc: null, confirmedAtIso: null, confirmedBy: null })
    const verdict = mayUseRealPaymentProvider({
      isProduction: true,
      mcc: confirmation.mcc,
      mccConfirmedAtIso: confirmation.confirmedAtIso,
      mccConfirmedBy: confirmation.confirmedBy,
    })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect([...verdict.reasons].sort()).toEqual(
      ['mcc-confirmation-has-no-recorder', 'mcc-not-confirmed', 'mcc-not-recorded'].sort(),
    )
  })
})

describe('acceptance — ZY771: a live gateway may not be reached until the MCC is on file', () => {
  /**
   * One intent, at the one gateway name the test is about. Inserted inside a rolled-back probe.
   *
   * The idempotency key carries NO digit run, and that is not cosmetic: the first version used
   * `Date.now()` and `ZY231` refused it — `is_card_shaped()` from migration 0117 reads a thirteen-digit
   * run as a possible card number, which is the rule working exactly as ADR 0067 describes. Every probe
   * runs in its own rolled-back transaction, so the key does not have to be unique across them.
   */
  const insertIntent = (tx: Sql, gateway: string) => tx`
    insert into payment_intent (idempotency_key, gateway, state, instrument,
                                posting_account_code, requested_fils, reference)
    values (${`ypay10-probe-${gateway}`}, ${gateway}, 'requires_authorisation',
            'card_online', '1030', 1000, ${'Y-PAY-10 probe'})
  `

  it('refuses an intent against a gateway this build does not ship', async () => {
    expect(await probe((tx) => sqlstateOf(insertIntent(tx, 'some-real-acquirer')))).toBe('ZY771')
  })

  it('permits the two gateways it DOES ship, which is why the refusal is safe', async () => {
    // The control, and it is the whole argument for the scope: a blanket refusal would stop the manual
    // till adapter and the card fake, the only two payment paths that work today.
    expect(await probe((tx) => sqlstateOf(insertIntent(tx, 'manual-till')))).toBeNull()
    expect(await probe((tx) => sqlstateOf(insertIntent(tx, 'fake-card-gateway')))).toBeNull()
  })

  it('permits any gateway once the MCC is confirmed, so the refusal lifts rather than blocks', async () => {
    // The second control: the trigger is a GATE and not a prohibition. Rolled back, because a committed
    // MCC would leave this database claiming an acquirer that does not exist.
    const state = await probe(async (tx) => {
      await tx`
        update legal_entity
           set mcc = '0000', mcc_confirmed_at = now(),
               mcc_confirmed_by = 'Y-PAY-10 probe (rolled back)'
         where id = (select min(id) from legal_entity)
      `
      return sqlstateOf(insertIntent(tx, 'some-real-acquirer'))
    })
    expect(state).toBeNull()

    // And the rollback held: the panel still shows the MCC as unanswered.
    const rows = await unconfirmedAssumptionRows(sql)
    expect(rows.some((row) => row.source === 'legal_entity' && row.reference === 'mcc')).toBe(true)
  })

  it('refuses a placeholder MCC, so the gate cannot be opened with a marker', async () => {
    const state = await probe((tx) =>
      sqlstateOf(tx`
        update legal_entity
           set mcc = 'TBC0', mcc_confirmed_at = now(), mcc_confirmed_by = 'probe'
         where id = (select min(id) from legal_entity)
      `),
    )
    // 23514: `legal_entity_mcc_is_four_digits` or `legal_entity_mcc_is_not_a_placeholder`. A CHECK is
    // right here and a private code would be a second statement of a rule the constraint already makes.
    expect(state).toBe('23514')
  })

  it('refuses a confirmation that is not all three facts', async () => {
    expect(
      await probe((tx) =>
        sqlstateOf(tx`
          update legal_entity set mcc = '7297'
           where id = (select min(id) from legal_entity)
        `),
      ),
    ).toBe('23514')
    expect(
      await probe((tx) =>
        sqlstateOf(tx`
          update legal_entity set mcc = '7297', mcc_confirmed_at = now()
           where id = (select min(id) from legal_entity)
        `),
      ),
    ).toBe('23514')
  })
})
