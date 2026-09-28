import { beforeAll, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from './connection.ts'
import { PRIVATE_SQLSTATES } from './sqlstate-registry.ts'

/**
 * Every refusal W-SYS-12 moved, driven against a real PostgreSQL, asserting the NEW code AND its message.
 *
 * ## Why the message is asserted and not only the code
 *
 * Because a code with no message assertion is exactly what let thirteen codes stand for two rules each
 * without anybody noticing. Every probe in this repository that asserted one of the nine codes below was
 * green before this unit and green after it, and would have stayed green if the two rules had been left
 * sharing the code — that is what "a probe asserting the code passes when the statement bounced off
 * something else entirely" means, and it is not a hypothetical: `0087_compliance_gate.sql` chose `ZX001`
 * in a paragraph explaining that it was avoiding `ZW001` because `ZW001` was shared, and `ZX001` was
 * already 0086's.
 *
 * So each case asserts three things about one statement:
 *
 *   1. the SQLSTATE is the new code;
 *   2. the message is THIS rule's, matched on wording only this rule has;
 *   3. the message is NOT the wording of the rule that KEPT the old code. That is the assertion that would
 *      have failed before 0099 and the one that makes the other two more than a rename — a translator
 *      matching on the code alone cannot tell the two apart, so the message is the only evidence that the
 *      statement bounced off the rule the test names.
 *
 * And the registry entry for the code is looked up by the code the DATABASE raised, which is the only
 * place in the build where the registry is checked against a running PostgreSQL rather than against the
 * migration text.
 *
 * ## Isolation
 *
 * Every case runs inside one transaction that is always rolled back (brief rule 12), so nothing here
 * leaves a row, a lock or a disabled trigger behind — `alter table … disable trigger` is transactional in
 * PostgreSQL, and `vitest.integration.config.ts` sets `fileParallelism: false`, so the ACCESS EXCLUSIVE
 * lock the one case that needs it takes is not contended. The seeded rows two cases write against
 * (`pipeline_stage`, `customer`) are read, never changed outside a rolled-back transaction.
 *
 * No explicit per-test timeout: `vitest.integration.config.ts` declares `testTimeout: 30_000`, so brief
 * rule 21 is already satisfied for this suite and a second statement of it would be the drift that rule's
 * neighbour is about.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

let sql: Sql
let customerA: string
let customerB: string
let firstStage: string

/** A refusal, or the sentinel — never `null`, so a case cannot read "nothing happened" as a pass. */
interface Refused {
  readonly code: string
  readonly message: string
}
const NOTHING = 'the statement was accepted; no rule refused it'

const ROLLBACK = 'w-sys-12 rollback'

/**
 * Runs `body` in a transaction that is ALWAYS rolled back, and returns the refusal it raised.
 *
 * The throw after `body` is what guarantees the rollback even when nothing was refused, which is the case
 * the sentinel names: a probe that quietly committed would leave a tombstone or a gap behind for every
 * later suite, and a probe that silently passed because nothing refused it is the vacuous green ADR 0002
 * is about.
 */
async function refusedBy(body: (tx: Sql) => Promise<unknown>): Promise<Refused | typeof NOTHING> {
  let caught: unknown = null
  try {
    await sql.begin(async (tx) => {
      await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
  } catch (error) {
    caught = error
  }
  if (caught instanceof Error && caught.message === ROLLBACK) return NOTHING
  const code = (caught as { code?: unknown } | null)?.code
  const message = (caught as { message?: unknown } | null)?.message
  if (typeof code !== 'string' || typeof message !== 'string') {
    throw caught instanceof Error
      ? caught
      : new Error(`not a PostgreSQL refusal: ${String(caught)}`)
  }
  return { code, message }
}

/** A merge_record row. The two customer columns are plain uuids by design (0069), so any uuid will do. */
const mergeRecord = (tx: Sql, survivor: string, loser: string) => tx`
  insert into merge_record (
    survivor_customer_id, loser_customer_id, merged_at, actor_kind, actor_label,
    authority, reason, score_per_mille, phone_agreement, label_agreement, field_resolutions)
  values (${survivor}::uuid, ${loser}::uuid, now(), 'system', 'W-SYS-12 (fixture)', 'auto_merge',
    'One person, two records: the same handset was entered twice at the front desk.', 900,
    'identical', 'identical', '[]'::jsonb)
`

/** A rota_version that supersedes nothing, which is version 1 of its own period. */
const rotaVersion = (tx: Sql, from: string, to: string, digest: string) => tx`
  insert into rota_version (
    from_trading_date, to_trading_date, supersedes_id, version_no,
    coverage_rule_effective_from, working_hours_rule_effective_from, labour_cost_rule_effective_from,
    forecast_labour_cost_fils, forecast_unpriced_employees, assignment_digest, published_by)
  values (${from}::date, ${to}::date, null, 1, '2031-01-01'::date, '2031-01-01'::date,
    '2031-01-01'::date, 0, 0, ${digest}, 'W-SYS-12 (fixture)')
  returning id
`

/** The nine rules 0099 moved, each with the rule that KEPT the code it left. */
const MOVED = [
  {
    code: 'ZT005',
    left: 'ZT001',
    mine: /merge_record is append-only; UPDATE is refused/,
    theirs: 'Overpayment',
    drive: async (tx: Sql) => {
      await mergeRecord(tx, customerA, customerB)
      await tx`update merge_record set reason = 'edited' where loser_customer_id = ${customerB}::uuid`
    },
  },
  {
    code: 'ZT006',
    left: 'ZT002',
    mine: /MergeSurvivorIsATombstone/,
    theirs: 'ChangeOnATenderThatGivesNone',
    drive: async (tx: Sql) => {
      await mergeRecord(tx, customerA, customerB)
      // B is now a tombstone, so a merge whose SURVIVOR is B points at a record nothing reads.
      await mergeRecord(tx, customerB, chainId(99))
    },
  },
  {
    code: 'ZT007',
    left: 'ZT003',
    mine: /MergeChainTooLong/,
    theirs: 'TenderReferenceRequired',
    drive: async (tx: Sql) => {
      // The only state that can raise it, which is what the message says: the insert trigger makes a cycle
      // impossible, so more than 32 hops means that trigger is gone. The case therefore creates exactly
      // that — the trigger off and a 34-link chain — rather than asserting a bound nothing can reach.
      await tx`alter table merge_record disable trigger merge_record_survivor_is_live`
      for (let hop = 1; hop <= 34; hop += 1) {
        await mergeRecord(tx, chainId(hop + 1), chainId(hop))
      }
      await tx`select merge_survivor_of(${chainId(1)}::uuid)`
    },
  },
  {
    code: 'ZU008',
    left: 'ZU001',
    mine: /with no pipeline_stage_transition recording that move/,
    theirs: 'CountRequired',
    drive: async (tx: Sql) => {
      await tx`
        insert into customer_pipeline_card (customer_id, stage_key, stage_entered_at)
        values (${customerA}::uuid, ${firstStage}, now())
      `
      // Deferred to COMMIT and this probe rolls back, so the check is forced here. Without this line the
      // probe returns cleanly and the assertion reports the trigger as absent.
      await tx`set constraints all immediate`
    },
  },
  {
    code: 'ZU009',
    left: 'ZU002',
    mine: /pipeline_stage_transition is append-only/,
    theirs: 'CashSessionAlreadyClosed',
    drive: async (tx: Sql) => {
      await tx`
        insert into pipeline_stage_transition (
          customer_id, from_stage_key, to_stage_key, actor_kind, actor_label, occurred_at)
        values (${customerA}::uuid, null, ${firstStage}, 'system', 'W-SYS-12 (fixture)', now())
      `
      await tx`
        update pipeline_stage_transition set actor_label = 'edited'
         where actor_label = 'W-SYS-12 (fixture)'
      `
    },
  },
  {
    code: 'ZU010',
    left: 'ZU003',
    mine: /pipeline_stage positions must be 1\.\./,
    theirs: 'CashSessionPeriodLocked',
    drive: async (tx: Sql) => {
      await tx`
        update pipeline_stage set display_order = display_order + 20 where stage_key = ${firstStage}
      `
      await tx`set constraints all immediate`
    },
  },
  {
    code: 'ZW006',
    left: 'ZW001',
    mine: /A published rota version is immutable/,
    theirs: 'the frequency cap is not switchable',
    drive: async (tx: Sql) => {
      await rotaVersion(tx, '2031-03-03', '2031-03-09', 'a'.repeat(64))
      await tx`
        update rota_version set forecast_unpriced_employees = 1
         where assignment_digest = ${'a'.repeat(64)}
      `
    },
  },
  {
    code: 'ZW007',
    left: 'ZW002',
    mine: /rota_change_request is append-only/,
    theirs: 'frequency_ledger',
    drive: async (tx: Sql) => {
      const [version] = await rotaVersion(tx, '2031-03-10', '2031-03-16', 'b'.repeat(64))
      const versionId = (version as { id?: unknown } | undefined)?.id
      if (typeof versionId !== 'string') throw new Error('the fixture rota version has no id')
      await tx`
        insert into rota_change_request (
          kind, rota_version_id, to_employee_id, decision, refused_rule, requested_by)
        values ('open_shift_claim', ${versionId}::uuid, (select id from employee order by id limit 1),
          'refused', 'coverage_would_break', 'W-SYS-12 (fixture)')
      `
      await tx`
        update rota_change_request set refusal_detail = 'edited'
         where requested_by = 'W-SYS-12 (fixture)'
      `
    },
  },
  {
    code: 'ZX006',
    left: 'ZX001',
    mine: /the promotional send window is not switchable/,
    theirs: 'Attendance is append-only',
    drive: async (tx: Sql) => {
      await tx`
        update app_setting set value = '{"startHour":0,"endHour":24}'::jsonb
         where key = 'messaging.promotional_window'
      `
    },
  },
] as const

/** A uuid for a link in a synthetic merge chain. Not a customer: 0069's columns are plain uuids. */
const chainId = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as const

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const customers = await sql<{ id: string }[]>`select id from customer order by id limit 2`
  const stages = await sql<{ stageKey: string }[]>`
    select stage_key as "stageKey" from pipeline_stage order by display_order limit 1
  `
  const [a, b] = customers
  const [stage] = stages
  if (a === undefined || b === undefined || stage === undefined) {
    throw new Error(
      'this suite needs two seeded customers and the seeded pipeline board — run `pnpm seed` first',
    )
  }
  customerA = a.id
  customerB = b.id
  firstStage = stage.stageKey
})

describe('every refusal 0099 moved reports its NEW code and its OWN message', () => {
  it('drives all nine, and nine is the number the migration moved', () => {
    // ADR 0002: without this, deleting a case from the table above silently reduces the coverage of the
    // acceptance line to whatever is left, and every remaining case still passes.
    expect(MOVED).toHaveLength(9)
    expect(new Set(MOVED.map((moved) => moved.code)).size).toBe(9)
    const movedIn = new Set(
      MOVED.map(
        (moved) =>
          PRIVATE_SQLSTATES.find((entry) => entry.code === moved.code)?.migration ??
          '(unregistered)',
      ),
    )
    expect(
      movedIn,
      'all nine are registered against the one migration that moved them',
    ).toHaveLength(1)
  })

  it.each(MOVED.map((moved) => [moved.code, moved] as const))(
    '%s is raised with its own message, and not the rule that kept the old code',
    async (_code, moved) => {
      const refused = await refusedBy(moved.drive)
      expect(refused, `${moved.code}: nothing refused the statement`).not.toBe(NOTHING)
      if (refused === NOTHING) return
      expect(refused.code, `${moved.code}: the SQLSTATE`).toBe(moved.code)
      expect(refused.message, `${moved.code}: its own message`).toMatch(moved.mine)
      // The assertion that would have failed before 0099, and the reason the message is asserted at all:
      // the rule that kept the old code has a different message, and a translator matching on the code
      // alone cannot tell them apart.
      expect(
        refused.message,
        `${moved.code} carries the wording of ${moved.left}'s rule, so the two are still one code`,
      ).not.toContain(moved.theirs)
      // The registry is looked up by the code the DATABASE raised, not by the code the test expected.
      const entry = PRIVATE_SQLSTATES.find((candidate) => candidate.code === refused.code)
      expect(entry, `${refused.code} is registered`).toBeDefined()
      expect(entry?.rule.length ?? 0).toBeGreaterThan(30)
    },
  )
})

describe('ZL002 is ONE rule raised in two places', () => {
  /**
   * The distinction the collision detector was built to make, proven rather than asserted.
   *
   * `raise_if_period_locked` is defined in 0018 and `create or replace`d in 0073, and it is reached from
   * two BEFORE INSERT guards: one on `journal_entry`, one on `journal_line`. Two files, two call sites,
   * ONE rule — which is why it is not moved and needs no exception, and why the allowlist that called it
   * "0018 raises it from the shared function, 0073 from its caller" was wrong about the two places as well
   * as right about there being one rule.
   *
   * The two call sites exist for different reasons and this is what makes driving BOTH the point: the
   * entry guard is what a posting hits first, and the LINE guard is what stops a line being appended to an
   * entry that was posted while the period was still open. A future unit that gave one of them its own
   * code would be splitting one rule in two, and this case is what says so.
   */
  const LOCKED = { period: '2031-06', from: '2031-06-01', to: '2031-06-30', on: '2031-06-15' }

  const lockThePeriod = (tx: Sql) => tx`
    insert into period_lock (period_id, starts_on, ends_on, reason, locked_by_actor_kind)
    values (${LOCKED.period}, ${LOCKED.from}::date, ${LOCKED.to}::date,
      'W-SYS-12 (fixture): proving ZL002 is one rule', 'system')
  `

  it('refuses a journal ENTRY and a journal LINE in a locked period with the same code and rule', async () => {
    // The line guard. The entry is posted while the period is still open, so what refuses the line is the
    // LOCK and not the entry's own guard — which is the whole reason the line guard exists.
    const line = await refusedBy(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('WSYS12-LINE', ${LOCKED.on}::date, 'W-SYS-12 (fixture)', 'adjustment')
      `
      await lockThePeriod(tx)
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils)
        values ('WSYS12-LINE', 1, '1010', 100)
      `
    })
    // The entry guard, in its own transaction: the first one is aborted by its refusal.
    const entry = await refusedBy(async (tx) => {
      await lockThePeriod(tx)
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('WSYS12-ENTRY', ${LOCKED.on}::date, 'W-SYS-12 (fixture)', 'adjustment')
      `
    })

    expect(line, 'a journal line in a locked period').not.toBe(NOTHING)
    expect(entry, 'a journal entry in a locked period').not.toBe(NOTHING)
    if (line === NOTHING || entry === NOTHING) return

    // Same code, and the SAME RULE — `PeriodLocked`, naming the period, from one function.
    expect(line.code).toBe('ZL002')
    expect(entry.code).toBe('ZL002')
    expect(line.message).toContain(
      'PeriodLocked: cannot post journal line 1 on entry "WSYS12-LINE"',
    )
    expect(entry.message).toContain('PeriodLocked: cannot post journal entry "WSYS12-ENTRY"')
    for (const refusal of [line, entry]) {
      expect(refusal.message, 'the period is IN the message, not merely in the code').toContain(
        `accounting period "${LOCKED.period}" is locked`,
      )
    }

    // And the registry holds ONE entry for it, naming ONE function — which is the shape "one rule, two
    // places" has after the derivation resolves the replaced definition.
    const entryInRegistry = PRIVATE_SQLSTATES.filter((candidate) => candidate.code === 'ZL002')
    expect(entryInRegistry).toHaveLength(1)
    expect(entryInRegistry[0]?.raisedBy).toEqual(['raise_if_period_locked'])
    expect(entryInRegistry[0]?.migration, 'the LIVE definition, which 0073 replaced').toBe('0073')
  })

  it('the control: the same two statements are accepted when the period is not locked', async () => {
    // Without this, both refusals above would also hold for a guard that refused every posting, and the
    // case would be evidence about nothing.
    const accepted = await refusedBy(async (tx) => {
      await tx`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values ('WSYS12-OPEN', ${LOCKED.on}::date, 'W-SYS-12 (fixture)', 'adjustment')
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, debit_fils)
        values ('WSYS12-OPEN', 1, '1010', 100)
      `
      await tx`
        insert into journal_line (entry_id, line_no, account_code, credit_fils)
        values ('WSYS12-OPEN', 2, '4010', 100)
      `
    })
    expect(accepted, 'an entry and its lines in an OPEN period are accepted').toBe(NOTHING)
  })
})
