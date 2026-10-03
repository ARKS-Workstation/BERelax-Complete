import { createConnection, type Sql } from '@berelax/db'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Y-PAY-05's four refusals, against real PostgreSQL.
 *
 * The diff is proved without a database by `packages/payments/src/reconcile.test.ts`, and the PASS — the
 * five-hundred-intent fuzz run, the idempotence, the interruption checksum and the quarantine — by
 * `apps/worker/src/jobs/payment-reconciliation.itest.ts`. What is left, and what only a `psql` prompt can
 * reach, is whether the rules hold against a caller that is NOT the pass: a hand-run correction, a second
 * reconciler written in another worktree, or the same one after somebody decides a repair does not really
 * need its evidence.
 *
 * Every probe writes raw INSERTs rather than going through the repository, deliberately: the repository
 * refuses most of these a layer above the rule, so a probe that used it would be stopped before reaching
 * the thing it is about.
 *
 * ## Isolation (brief rule 12)
 *
 * All three tables refuse DELETE for every role (`ZY681`), so there is no truncate here and every
 * assertion is about rows this run created. The intent is created by this file and is undeletable
 * afterwards (`ZY161`), so its references carry a per-run nonce.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
let nonce: string
let intentId: string
let observationId: string
let runId: string

const run = (suffix: string): string => `YPAY05DB-${nonce}-${suffix}`

const sqlStateOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null
    ? ((error as { code?: string }).code ?? undefined)
    : undefined

const errorOf = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work()
  } catch (error) {
    return error
  }
  throw new Error('the statement was expected to be refused and was not')
}

const gatewayName = (): string => run('GATEWAY')

/** One exception row, with everything a caller can get wrong overridable. */
const insertException = async (over: {
  readonly kind?: 'repaired' | 'quarantined'
  readonly before?: unknown
  readonly after?: unknown
  readonly missed?: readonly string[]
  readonly alert?: boolean
}): Promise<void> => {
  await sql.begin(async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into reconciliation_exception (
        run_id, payment_intent_id, gateway_intent_id, observation_id, kind, before_state, after_state,
        missed_event_ids, detail
      ) values (
        ${runId}::uuid, ${intentId}::uuid, ${run('GW')}, ${observationId}::uuid,
        ${over.kind ?? 'repaired'},
        ${over.before === undefined ? tx.json({ fields: ['captured'] } as never) : over.before === null ? null : tx.json(over.before as never)},
        ${over.after === undefined ? tx.json({ state: 'captured' } as never) : over.after === null ? null : tx.json(over.after as never)},
        ${tx.array([...(over.missed ?? ['evt-1'])])},
        'Y-PAY-05 refusal probe'
      )
      returning id
    `
    if (over.alert === true) {
      await tx`
        insert into audit_event (actor_kind, action, entity_type, entity_id, operation)
        values ('system', 'payment.reconciliation-quarantined', 'reconciliation_exception',
                ${row?.id as string}, 'denied')
      `
    }
  })
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })
  nonce = Math.random().toString(36).slice(2, 10)

  const [intent] = await sql<{ id: string }[]>`
    insert into payment_intent (
      idempotency_key, gateway, gateway_intent_id, instrument, posting_account_code, requested_fils,
      reference
    ) values (
      ${run('IK')}, ${gatewayName()}, ${run('GW')}, 'card_online', '1030', 5_000, ${run('REF')}
    )
    returning id
  `
  intentId = intent?.id as string

  const [observation] = await sql<{ id: string }[]>`
    insert into gateway_state_observation (
      gateway, gateway_intent_id, state, authorised_fils, captured_fils, refunded_fils, observed_at
    ) values (
      ${gatewayName()}, ${run('GW')}, 'captured', 5_000, 5_000, 0, now()
    )
    returning id
  `
  observationId = observation?.id as string

  const [runRow] = await sql<{ id: string }[]>`
    insert into payment_reconciliation_run (gateway, cursor_from)
    values (${gatewayName()}, null)
    returning id
  `
  runId = runRow?.id as string
}, 60_000)

describe('ZY681 — the records are append-only, and a run closes once', () => {
  it('refuses UPDATE and DELETE on an observation and on an exception', async () => {
    await insertException({})
    for (const statement of [
      () =>
        sql`update gateway_state_observation set captured_fils = 1 where id = ${observationId}::uuid`,
      () => sql`delete from gateway_state_observation where id = ${observationId}::uuid`,
      () =>
        sql`update reconciliation_exception set detail = 'edited' where run_id = ${runId}::uuid`,
      () => sql`delete from reconciliation_exception where run_id = ${runId}::uuid`,
      () => sql`delete from payment_reconciliation_run where id = ${runId}::uuid`,
    ]) {
      expect(sqlStateOf(await errorOf(statement))).toBe('ZY681')
    }
  })

  it('permits the ONE legal update — the close — and refuses every other, including a second', async () => {
    const [open] = await sql<{ id: string }[]>`
      insert into payment_reconciliation_run (gateway, cursor_from)
      values (${run('CLOSE')}, 'evt_00000001')
      returning id
    `
    const id = open?.id as string
    // Re-attributing a run to another gateway is refused even while it is open: a run is evidence of a
    // window that was read, and re-dating or re-attributing one makes the watermark unreadable.
    expect(
      sqlStateOf(
        await errorOf(
          () =>
            sql`update payment_reconciliation_run set gateway = 'elsewhere' where id = ${id}::uuid`,
        ),
      ),
    ).toBe('ZY681')

    // The close itself commits.
    await sql`
      update payment_reconciliation_run
         set finished_at = now(), cursor_to = 'evt_00000009', intents_examined = 1, repairs = 1
       where id = ${id}::uuid
    `
    // And a SECOND close is refused, because it would move the watermark on evidence already counted.
    expect(
      sqlStateOf(
        await errorOf(
          () => sql`
            update payment_reconciliation_run
               set finished_at = now(), cursor_to = 'evt_00000099'
             where id = ${id}::uuid
          `,
        ),
      ),
    ).toBe('ZY681')
  })
})

describe('ZY682 — a repair names its evidence', () => {
  it('refuses a repair naming no missed event', async () => {
    expect(sqlStateOf(await errorOf(() => insertException({ missed: [] })))).toBe('ZY682')
  })

  it('refuses a repair with no after-state', async () => {
    expect(sqlStateOf(await errorOf(() => insertException({ after: null })))).toBe('ZY682')
  })

  it('refuses a quarantine with no divergence recorded', async () => {
    expect(
      sqlStateOf(
        await errorOf(() =>
          insertException({ kind: 'quarantined', before: null, missed: [], alert: true }),
        ),
      ),
    ).toBe('ZY682')
  })

  it('accepts a quarantine that records one, which is the control', async () => {
    // Without this, every case above is satisfied by a rule that refuses everything.
    await expect(
      insertException({ kind: 'quarantined', missed: [], alert: true }),
    ).resolves.toBeUndefined()
  })
})

describe('ZY683 — a quarantine is alerted in the same transaction', () => {
  it('refuses a quarantine with no audit_event', async () => {
    expect(
      sqlStateOf(
        await errorOf(() => insertException({ kind: 'quarantined', missed: [], alert: false })),
      ),
    ).toBe('ZY683')
    // The control: a REPAIR needs no alert, so the rule is about the quarantine and not about the table.
    await expect(insertException({ kind: 'repaired', alert: false })).resolves.toBeUndefined()
  })
})

describe('ZY684 — the watermark does not go backwards', () => {
  it('refuses a finished run that closes behind the current watermark', async () => {
    const gateway = run('WATERMARK')
    const open = async (from: string | null): Promise<string> => {
      const [row] = await sql<{ id: string }[]>`
        insert into payment_reconciliation_run (gateway, cursor_from)
        values (${gateway}, ${from})
        returning id
      `
      return row?.id as string
    }
    const ahead = await open(null)
    await sql`
      update payment_reconciliation_run
         set finished_at = now(), cursor_to = 'evt_00000500'
       where id = ${ahead}::uuid
    `
    const behind = await open(null)
    expect(
      sqlStateOf(
        await errorOf(
          () => sql`
            update payment_reconciliation_run
               set finished_at = now(), cursor_to = 'evt_00000100'
             where id = ${behind}::uuid
          `,
        ),
      ),
    ).toBe('ZY684')

    // The control: closing AT or AHEAD of the watermark commits, and the view then reports the newest.
    await sql`
      update payment_reconciliation_run
         set finished_at = now(), cursor_to = 'evt_00000900'
       where id = ${behind}::uuid
    `
    const [watermark] = await sql<{ cursorTo: string }[]>`
      select cursor_to as "cursorTo" from payment_reconciliation_watermark where gateway = ${gateway}
    `
    expect(watermark?.cursorTo).toBe('evt_00000900')
  })

  it('excludes an unfinished run from the watermark, which is the interrupted-run property', async () => {
    const gateway = run('INFLIGHT')
    const [first] = await sql<{ id: string }[]>`
      insert into payment_reconciliation_run (gateway, cursor_from) values (${gateway}, null)
      returning id
    `
    await sql`
      update payment_reconciliation_run
         set finished_at = now(), cursor_to = 'evt_00000010'
       where id = ${first?.id as string}::uuid
    `
    // A pass that died: its row exists, its cursor is null, and the watermark is unmoved. That is what
    // makes the next pass re-read the window rather than skip the events it had read and not repaired.
    await sql`
      insert into payment_reconciliation_run (gateway, cursor_from) values (${gateway}, 'evt_00000010')
    `
    const [watermark] = await sql<{ cursorTo: string; finishedRuns: number }[]>`
      select cursor_to as "cursorTo", finished_runs as "finishedRuns"
        from payment_reconciliation_watermark where gateway = ${gateway}
    `
    expect(watermark?.cursorTo).toBe('evt_00000010')
    expect(watermark?.finishedRuns).toBe(1)
  })
})

describe('the structural refusals', () => {
  it('refuses an unrecognised observation that claims figures', async () => {
    // "We asked and it said no" holds NOTHING, and the nought is a measured answer rather than a
    // stand-in. An unrecognised observation carrying a figure would be a claim the gateway never made.
    const error = await errorOf(
      () => sql`
        insert into gateway_state_observation (
          gateway, gateway_intent_id, state, authorised_fils, captured_fils, refunded_fils, observed_at,
          recognised
        ) values (
          ${gatewayName()}, ${run('GW')}, 'captured', 0, 5_000, 0, now(), false
        )
      `,
    )
    expect((error as { constraint_name?: string }).constraint_name).toBe(
      'gateway_state_observation_unrecognised_holds_nothing',
    )
  })

  it('admits a finished run over an EMPTY window, which has no cursor to report', async () => {
    // The constraint this replaced required a finished run to carry a cursor, and it refused exactly
    // this run — a pass over a window with no events in it. Requiring one would have made the pass
    // invent a bookmark the gateway never issued.
    const [row] = await sql<{ id: string }[]>`
      insert into payment_reconciliation_run (gateway, cursor_from) values (${run('EMPTY')}, null)
      returning id
    `
    await expect(
      sql`
        update payment_reconciliation_run
           set finished_at = now(), cursor_to = null, intents_examined = 0
         where id = ${row?.id as string}::uuid
      `,
    ).resolves.toBeTruthy()
  })
})
