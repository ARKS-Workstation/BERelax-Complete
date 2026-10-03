import {
  ACCOUNTS,
  SETTLEMENT_LINE_KINDS,
  SETTLEMENT_LINE_TIE_ACCOUNT,
  type SettlementLineKind,
} from '@berelax/core'
import { createConnection, type Sql, settlementTieAccount } from '@berelax/db'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Y-PAY-09's seven refusals, against real PostgreSQL, plus the pairing that holds two statements of one
 * mapping equal.
 *
 * The arithmetic is proved without a database by `packages/core/src/payments/settlement.test.ts` and its
 * property sibling; the IMPORT's own properties — the no-op by content hash, the quarantine, the
 * reverse-charge pair — by `apps/worker/src/jobs/settlement-import.itest.ts`. What is left, and what only
 * a `psql` prompt can reach, is whether the rules hold against a caller that is not the importer: a
 * second importer written in another worktree, a hand-run correction, or the same importer after somebody
 * widens a tolerance. That is this file.
 *
 * ## Why four of the seven arrive at COMMIT
 *
 * `ZY442`, `ZY443`, `ZY444` and `ZY446` read the LINES, the VARIANCES and the `audit_event` of a batch,
 * and the batch row, its lines, its variances, its entry and its audit row are separate statements in one
 * transaction. An immediate trigger would reject the legal sequence on the first of them. So every probe
 * here drives a real transaction and reads the error at COMMIT — a `savepoint` would discard the pending
 * constraint check and the probe would never reach it, which is 0135's recorded mistake one table along.
 *
 * ## Isolation (brief rule 12)
 *
 * `settlement_batch`, `settlement_line` and `settlement_variance` all refuse DELETE for every role
 * (`ZY441`), so there is no truncate in this file and nothing is declarable in
 * `suite-table-declarations.ts`. Every content hash, batch reference and entry id carries a per-run
 * nonce, and every assertion is about rows this run created. No figure here is a money figure anybody
 * has to believe: the amounts are small round numbers chosen so the identities are checkable by eye.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
let nonce: string

const SETTLED_ON = '2099-12-10'
const CAPTURE = 10_000
const FEE = 500

const run = (suffix: string): string => `YPAY09DB-${nonce}-${suffix}`
const hashFor = (suffix: string): string =>
  Buffer.from(`${nonce}-${suffix}`, 'utf8').toString('hex').padEnd(64, '0').slice(0, 64)

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

/*
  `tx as unknown as Sql` at both helper call sites below, which is `withUnitOfWork`'s own cast in
  `packages/db/src/tx.ts`. `TransactionSql` is missing `END`, `options` and nine other members of the pool
  type, so a helper annotated `Sql` does not accept it — and `Parameters<Parameters<Sql['begin']>[0]>[0]`
  does not resolve, because `begin` is overloaded. The cast is the arrangement this repository already
  uses, and the statements these helpers issue need nothing a transaction handle lacks.
*/

/** A balanced payout entry, so a POSTED batch has something real to name. */
async function payoutEntry(tx: Sql, id: string, netFils: number): Promise<void> {
  await tx`
    insert into journal_entry (entry_id, entry_date, narrative, source)
    values (${id}, ${SETTLED_ON}::date, 'Y-PAY-09 refusal probe payout', 'payout')
  `
  await tx`
    insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils, memo)
    values (${id}, 1, ${ACCOUNTS.bankCurrent}, ${netFils}, 0, 'probe'),
           (${id}, 2, ${ACCOUNTS.paymentProcessingFees}, ${FEE}, 0, 'probe'),
           (${id}, 3, ${ACCOUNTS.gatewayClearing}, 0, ${netFils + FEE}, 'probe')
  `
}

interface ProbeLine {
  readonly lineNo: number
  readonly kind: SettlementLineKind
  readonly reference: string
  readonly amountFils: number
  readonly tieAccountCode?: string
  readonly localFils: number | null
}

interface Probe {
  readonly suffix: string
  /**
   * The suffix the CONTENT HASH is derived from, when it must differ from the rest.
   *
   * Only the re-import probe uses it: a second batch for one file has to carry the same hash and a
   * DIFFERENT journal entry id, because `journal_entry_pkey` would otherwise refuse the probe before the
   * rule under test could. That was a real false failure on this suite's first run, reporting
   * `journal_entry_pkey` where it expected `settlement_batch_one_per_file`.
   */
  readonly hashSuffix?: string
  readonly state: 'posted' | 'quarantined'
  readonly declaredNetFils: number
  readonly linesNetFils: number
  readonly lines: readonly ProbeLine[]
  readonly variances?: readonly {
    readonly lineNo: number | null
    readonly kind: string
    readonly fileFils: number
    readonly differenceFils: number
  }[]
  readonly withEntry?: boolean
  readonly withAudit?: boolean
}

/**
 * Writes one batch and everything it names, in ONE transaction, returning its id.
 *
 * Deliberately NOT `recordSettlementBatch`: that function derives the state from the variances and
 * refuses the illegal combinations in TypeScript, so every probe here would be stopped a layer above the
 * rule it is about. The point of this file is the rules holding against a caller that is not the
 * importer, so these are raw INSERTs.
 */
async function writeBatch(probe: Probe): Promise<string> {
  const entryId = run(`${probe.suffix}-ENTRY`)
  return await sql.begin(async (tx) => {
    if (probe.withEntry === true)
      await payoutEntry(tx as unknown as Sql, entryId, probe.declaredNetFils)
    const [batch] = await tx<{ id: string }[]>`
      insert into settlement_batch (
        batch_reference, content_sha256, settled_on, declared_net_fils, lines_net_fils, state,
        journal_entry_id
      ) values (
        ${run(`${probe.suffix}-BATCH`)}, ${hashFor(probe.hashSuffix ?? probe.suffix)},
        ${SETTLED_ON}::date,
        ${probe.declaredNetFils}, ${probe.linesNetFils}, ${probe.state},
        ${probe.withEntry === true ? entryId : null}
      )
      returning id
    `
    if (batch === undefined) throw new Error('the probe batch insert returned no row')
    const lineIds = new Map<number, string>()
    for (const line of probe.lines) {
      const [row] = await tx<{ id: string }[]>`
        insert into settlement_line (
          batch_id, line_no, kind, reference, amount_fils, tie_account_code, local_fils
        ) values (
          ${batch.id}::uuid, ${line.lineNo}, ${line.kind}, ${line.reference}, ${line.amountFils},
          ${line.tieAccountCode ?? SETTLEMENT_LINE_TIE_ACCOUNT[line.kind]}, ${line.localFils}
        )
        returning id
      `
      if (row === undefined) throw new Error('the probe line insert returned no row')
      lineIds.set(line.lineNo, row.id)
    }
    await writeVariances(tx as unknown as Sql, batch.id, probe, lineIds)
    if (probe.withAudit === true) {
      await tx`
        insert into audit_event (actor_kind, action, entity_type, entity_id, operation)
        values ('system', 'settlement.quarantined', 'settlement_batch', ${batch.id}, 'create')
      `
    }
    return batch.id
  })
}

/** The variance rows of a probe. Extracted so `writeBatch` stays inside the complexity budget. */
async function writeVariances(
  tx: Sql,
  batchId: string,
  probe: Probe,
  lineIds: ReadonlyMap<number, string>,
): Promise<void> {
  for (const variance of probe.variances ?? []) {
    await tx`
      insert into settlement_variance (
        batch_id, settlement_line_id, kind, file_fils, local_fils, difference_fils, explanation
      ) values (
        ${batchId}::uuid,
        ${variance.lineNo === null ? null : (lineIds.get(variance.lineNo) ?? null)},
        ${variance.kind}, ${variance.fileFils}, null, ${variance.differenceFils},
        'Y-PAY-09 refusal probe'
      )
    `
  }
}

/** A batch that reconciles: one capture that ties, one fee that ties to nothing, and its entry. */
const reconciled = (suffix: string): Probe => ({
  suffix,
  state: 'posted',
  declaredNetFils: CAPTURE - FEE,
  linesNetFils: CAPTURE - FEE,
  withEntry: true,
  lines: [
    {
      lineNo: 1,
      kind: 'capture',
      reference: run(`${suffix}-GW`),
      amountFils: CAPTURE,
      localFils: CAPTURE,
    },
    { lineNo: 2, kind: 'fee', reference: run(`${suffix}-BATCH`), amountFils: FEE, localFils: null },
  ],
})

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })
  nonce = Math.random().toString(36).slice(2, 10)
}, 60_000)

describe('the tie-account mapping, stated twice and held equal', () => {
  it('agrees between settlement_tie_account() and SETTLEMENT_LINE_TIE_ACCOUNT for every kind', async () => {
    // The whole reason the mapping is in SQL at all is ZY445's predicate, and a second statement of a
    // fact drifts — so this is the check that ships with it (brief: "in the same commit").
    for (const kind of SETTLEMENT_LINE_KINDS) {
      const inSql = await settlementTieAccount(sql, kind)
      expect(inSql, `settlement_tie_account('${kind}') answered nothing`).not.toBeNull()
      expect(inSql, `the two statements of the mapping disagree for ${kind}`).toBe(
        SETTLEMENT_LINE_TIE_ACCOUNT[kind],
      )
    }
    // And the control: a kind neither side knows answers null rather than a plausible account. Without
    // it, a function returning '1030' for everything would pass the loop above for two of five kinds.
    expect(await settlementTieAccount(sql, 'not-a-kind')).toBeNull()
    expect(new Set(Object.values(SETTLEMENT_LINE_TIE_ACCOUNT)).size).toBeGreaterThan(1)
  })

  it('maps the tip to tips payable and no kind to a revenue account', async () => {
    const revenue = await sql<{ code: string }[]>`select code from account where type = 'revenue'`
    expect(revenue.length).toBeGreaterThan(0)
    expect(await settlementTieAccount(sql, 'tip')).toBe(ACCOUNTS.tipsPayable)
    for (const kind of SETTLEMENT_LINE_KINDS) {
      expect(revenue.map((row) => row.code)).not.toContain(SETTLEMENT_LINE_TIE_ACCOUNT[kind])
    }
  })
})

describe('ZY441 — the three tables are append-only', () => {
  it('refuses UPDATE and DELETE on a batch, a line and a variance, for the owner', async () => {
    const posted = await writeBatch(reconciled('APPEND'))
    const quarantined = await writeBatch({
      suffix: 'APPENDQ',
      state: 'quarantined',
      declaredNetFils: CAPTURE,
      linesNetFils: CAPTURE,
      withAudit: true,
      lines: [
        {
          lineNo: 1,
          kind: 'capture',
          reference: run('APPENDQ-GW'),
          amountFils: CAPTURE,
          localFils: null,
        },
      ],
      variances: [
        { lineNo: 1, kind: 'no_local_record', fileFils: CAPTURE, differenceFils: CAPTURE },
      ],
    })

    for (const statement of [
      () => sql`update settlement_batch set state = 'quarantined' where id = ${posted}::uuid`,
      () => sql`delete from settlement_batch where id = ${posted}::uuid`,
      () => sql`update settlement_line set amount_fils = 1 where batch_id = ${posted}::uuid`,
      () => sql`delete from settlement_line where batch_id = ${posted}::uuid`,
      () =>
        sql`update settlement_variance set difference_fils = 1 where batch_id = ${quarantined}::uuid`,
      () => sql`delete from settlement_variance where batch_id = ${quarantined}::uuid`,
    ]) {
      expect(sqlStateOf(await errorOf(statement))).toBe('ZY441')
    }
  })
})

describe('ZY442 — to the fils, with no tolerance', () => {
  it('refuses a posted batch whose declared net is one fils from its lines', async () => {
    const error = await errorOf(() =>
      writeBatch({ ...reconciled('ONEFILS'), declaredNetFils: CAPTURE - FEE + 1 }),
    )
    expect(sqlStateOf(error)).toBe('ZY442')
    expect((error as Error).message).toContain('1 fils')
    // The control: the same batch with the fils put back commits. Without it, a rule that refused every
    // posted batch would pass the case above.
    await expect(writeBatch(reconciled('ONEFILSOK'))).resolves.toBeTruthy()
  })

  it('refuses a stored line net that disagrees with the rows', async () => {
    const error = await errorOf(() =>
      writeBatch({ ...reconciled('CACHE'), linesNetFils: CAPTURE - FEE + 7 }),
    )
    expect(sqlStateOf(error)).toBe('ZY442')
  })

  it('refuses the one-fils difference on a QUARANTINED batch too, as its stored net', async () => {
    // The declared-net half of ZY442 applies only to a posted batch — a quarantined one exists precisely
    // to record the disagreement — but the stored LINE net is a cache of the rows either way.
    const error = await errorOf(() =>
      writeBatch({
        suffix: 'QCACHE',
        state: 'quarantined',
        declaredNetFils: CAPTURE + 1,
        linesNetFils: CAPTURE + 1,
        withAudit: true,
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('QCACHE-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE,
          },
        ],
        variances: [
          { lineNo: null, kind: 'unattributable', fileFils: CAPTURE + 1, differenceFils: 1 },
        ],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY442')
  })
})

describe('ZY443 — posted and quarantined are exclusive, in both directions', () => {
  it('refuses a posted batch that carries a variance', async () => {
    const error = await errorOf(() =>
      writeBatch({
        ...reconciled('POSTEDVAR'),
        variances: [{ lineNo: 1, kind: 'amount_disagrees', fileFils: CAPTURE, differenceFils: 3 }],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY443')
  })

  it('refuses a posted batch with no journal entry', async () => {
    const error = await errorOf(() => writeBatch({ ...reconciled('NOENTRY'), withEntry: false }))
    expect(sqlStateOf(error)).toBe('ZY443')
  })

  it('refuses a quarantined batch with a journal entry', async () => {
    const error = await errorOf(() =>
      writeBatch({
        suffix: 'QENTRY',
        state: 'quarantined',
        declaredNetFils: CAPTURE - FEE,
        linesNetFils: CAPTURE - FEE,
        withEntry: true,
        withAudit: true,
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('QENTRY-GW'),
            amountFils: CAPTURE,
            localFils: null,
          },
          {
            lineNo: 2,
            kind: 'fee',
            reference: run('QENTRY-BATCH'),
            amountFils: FEE,
            localFils: null,
          },
        ],
        variances: [
          { lineNo: 1, kind: 'no_local_record', fileFils: CAPTURE, differenceFils: CAPTURE },
        ],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY443')
  })

  it('refuses a quarantined batch with no variance at all', async () => {
    const error = await errorOf(() =>
      writeBatch({
        suffix: 'QNOREASON',
        state: 'quarantined',
        declaredNetFils: CAPTURE,
        linesNetFils: CAPTURE,
        withAudit: true,
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('QNOREASON-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE,
          },
        ],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY443')
  })
})

describe('ZY444 — a posted line ties exactly, and a fee ties to nothing', () => {
  it('refuses a posted line matched to nothing', async () => {
    const error = await errorOf(() =>
      writeBatch({
        ...reconciled('UNTIED'),
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('UNTIED-GW'),
            amountFils: CAPTURE,
            localFils: null,
          },
          {
            lineNo: 2,
            kind: 'fee',
            reference: run('UNTIED-BATCH'),
            amountFils: FEE,
            localFils: null,
          },
        ],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY444')
  })

  it('refuses a posted line whose local figure is one fils out', async () => {
    const error = await errorOf(() =>
      writeBatch({
        ...reconciled('MISMATCH'),
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('MISMATCH-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE - 1,
          },
          {
            lineNo: 2,
            kind: 'fee',
            reference: run('MISMATCH-BATCH'),
            amountFils: FEE,
            localFils: null,
          },
        ],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY444')
  })

  it('refuses a fee line carrying a local figure, because no rate exists to tie it to', async () => {
    const error = await errorOf(() =>
      writeBatch({
        ...reconciled('FEETIED'),
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('FEETIED-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE,
          },
          {
            lineNo: 2,
            kind: 'fee',
            reference: run('FEETIED-BATCH'),
            amountFils: FEE,
            localFils: FEE,
          },
        ],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY444')
  })
})

describe('ZY445 — a line ties to the account its kind declares', () => {
  it('refuses a tip line claiming a revenue account', async () => {
    const error = await errorOf(() =>
      writeBatch({
        ...reconciled('WRONGACC'),
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('WRONGACC-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE,
          },
          {
            lineNo: 2,
            kind: 'tip',
            reference: run('WRONGACC-GW'),
            amountFils: 1,
            // The whole reason the mapping is in SQL: a tip tied to revenue reconciles a payout against
            // a SALE, and the figure would be right.
            tieAccountCode: ACCOUNTS.treatmentRevenue,
            localFils: 1,
          },
          {
            lineNo: 3,
            kind: 'fee',
            reference: run('WRONGACC-BATCH'),
            amountFils: FEE,
            localFils: null,
          },
        ],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY445')
  })

  it('refuses a capture claiming the disputed-receivable account', async () => {
    const error = await errorOf(() =>
      writeBatch({
        ...reconciled('CAPACC'),
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('CAPACC-GW'),
            amountFils: CAPTURE,
            tieAccountCode: ACCOUNTS.disputedCardReceipts,
            localFils: CAPTURE,
          },
          {
            lineNo: 2,
            kind: 'fee',
            reference: run('CAPACC-BATCH'),
            amountFils: FEE,
            localFils: null,
          },
        ],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY445')
  })
})

describe('ZY446 — a quarantine is alerted in the same transaction', () => {
  it('refuses a quarantined batch with no audit_event', async () => {
    const error = await errorOf(() =>
      writeBatch({
        suffix: 'NOALERT',
        state: 'quarantined',
        declaredNetFils: CAPTURE,
        linesNetFils: CAPTURE,
        withAudit: false,
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('NOALERT-GW'),
            amountFils: CAPTURE,
            localFils: null,
          },
        ],
        variances: [
          { lineNo: 1, kind: 'no_local_record', fileFils: CAPTURE, differenceFils: CAPTURE },
        ],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY446')
    // The control: the same batch WITH the alert commits, so the case above is about the audit row and
    // not about the batch being quarantined at all.
    await expect(
      writeBatch({
        suffix: 'ALERTED',
        state: 'quarantined',
        declaredNetFils: CAPTURE,
        linesNetFils: CAPTURE,
        withAudit: true,
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('ALERTED-GW'),
            amountFils: CAPTURE,
            localFils: null,
          },
        ],
        variances: [
          { lineNo: 1, kind: 'no_local_record', fileFils: CAPTURE, differenceFils: CAPTURE },
        ],
      }),
    ).resolves.toBeTruthy()
  })
})

describe('ZY447 — a variance of nought is not a variance', () => {
  it('refuses it, which is the shape a tolerance takes when somebody writes one', async () => {
    const error = await errorOf(() =>
      writeBatch({
        suffix: 'ZEROVAR',
        state: 'quarantined',
        declaredNetFils: CAPTURE,
        linesNetFils: CAPTURE,
        withAudit: true,
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('ZEROVAR-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE,
          },
        ],
        variances: [{ lineNo: 1, kind: 'amount_disagrees', fileFils: CAPTURE, differenceFils: 0 }],
      }),
    )
    expect(sqlStateOf(error)).toBe('ZY447')
  })
})

describe('the structural refusals that are constraints rather than triggers', () => {
  it('refuses a second line about one movement, and a second batch for one file', async () => {
    const duplicate = await errorOf(() =>
      writeBatch({
        ...reconciled('DUP'),
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('DUP-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE,
          },
          {
            lineNo: 2,
            kind: 'capture',
            reference: run('DUP-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE,
          },
        ],
      }),
    )
    expect(sqlStateOf(duplicate)).toBe('23505')
    expect((duplicate as { constraint_name?: string }).constraint_name).toBe(
      'settlement_line_one_per_movement',
    )

    await writeBatch(reconciled('REIMPORT'))
    const again = await errorOf(() =>
      writeBatch({ ...reconciled('REIMPORT2'), hashSuffix: 'REIMPORT' }),
    )
    expect((again as { constraint_name?: string }).constraint_name).toBe(
      'settlement_batch_one_per_file',
    )
  })

  it('refuses a content hash that is not a sha256, and a non-positive line amount', async () => {
    const badHash = await errorOf(
      () => sql`
        insert into settlement_batch (
          batch_reference, content_sha256, settled_on, declared_net_fils, lines_net_fils, state
        ) values (
          ${run('BADHASH')}, 'not-a-digest', ${SETTLED_ON}::date, 0, 0, 'quarantined'
        )
      `,
    )
    expect((badHash as { constraint_name?: string }).constraint_name).toBe(
      'settlement_batch_hash_is_sha256',
    )

    const badAmount = await errorOf(() =>
      writeBatch({
        ...reconciled('BADAMOUNT'),
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('BADAMOUNT-GW'),
            amountFils: 0,
            localFils: 0,
          },
        ],
      }),
    )
    expect((badAmount as { constraint_name?: string }).constraint_name).toBe(
      'settlement_line_amount_positive',
    )
  })

  it('refuses an unattributable variance pointing at a line, and a line variance pointing at none', async () => {
    // The biconditional on `settlement_variance_line_only_for_a_line`, both ways. A residue that belongs
    // to no line cannot name one, and a line's own disagreement cannot be a fact about the batch.
    const attributed = await errorOf(() =>
      writeBatch({
        suffix: 'VARLINE',
        state: 'quarantined',
        declaredNetFils: CAPTURE,
        linesNetFils: CAPTURE,
        withAudit: true,
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('VARLINE-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE,
          },
        ],
        variances: [{ lineNo: 1, kind: 'unattributable', fileFils: CAPTURE, differenceFils: 1 }],
      }),
    )
    expect((attributed as { constraint_name?: string }).constraint_name).toBe(
      'settlement_variance_line_only_for_a_line',
    )

    const orphaned = await errorOf(() =>
      writeBatch({
        suffix: 'VARNOLINE',
        state: 'quarantined',
        declaredNetFils: CAPTURE,
        linesNetFils: CAPTURE,
        withAudit: true,
        lines: [
          {
            lineNo: 1,
            kind: 'capture',
            reference: run('VARNOLINE-GW'),
            amountFils: CAPTURE,
            localFils: CAPTURE,
          },
        ],
        variances: [
          { lineNo: null, kind: 'amount_disagrees', fileFils: CAPTURE, differenceFils: 1 },
        ],
      }),
    )
    expect((orphaned as { constraint_name?: string }).constraint_name).toBe(
      'settlement_variance_line_only_for_a_line',
    )
  })
})
