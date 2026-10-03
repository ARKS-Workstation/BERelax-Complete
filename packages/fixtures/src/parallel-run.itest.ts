import { walkInSpeedVerdict } from '@berelax/core'
import {
  type Actor,
  countUnreconciledDaysTo,
  createConnection,
  PARALLEL_RUN_SQLSTATE,
  PARALLEL_RUN_WINDOW_END_SETTING_KEY,
  PARALLEL_RUN_WINDOW_START_SETTING_KEY,
  parallelRunError,
  readParallelRunVariance,
  readParallelRunWindow,
  recordPaperCount,
  recordParallelRunDecision,
  recordReconciliation,
  type Sql,
  type UnitOfWork,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  describeParallelRunPass,
  runParallelRunReconciliationPass,
} from '../../../apps/worker/src/jobs/parallel-run-reconcile.ts'
import { createFixturePrincipal } from './admin-principal.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * H-MIG-10's four acceptance lines against a real PostgreSQL, each with a control that must fail.
 *
 * ## Every case runs inside a transaction it ROLLS BACK, and that is not the usual arrangement
 *
 * `parallel_run_paper_count` is keyed on the trading date and append-only (ZY743), and
 * `parallel_run_decision` is append-only too (ZY745). A suite that committed its rows would therefore
 * fail on its OWN first execution's rows the second time it ran, and could not clean up after itself even
 * in principle. `opening-boundary.itest.ts` reached the same conclusion for the same kind of reason.
 *
 * Three of the six refusals are DEFERRED constraint triggers, which a transaction that never commits
 * never fires — so each of those cases issues `set constraints all immediate`, exactly as the import
 * framework's own dry run does, and for the same reason: without it the rehearsal is weaker than the run.
 *
 * The window settings are written inside the transaction too, so the shared integration database is left
 * with neither row nor setting.
 */

const ACTOR_SYSTEM: Actor = { kind: 'system', label: 'H-MIG-10 parallel-run suite' }

let sql: Sql
/** A staff principal, so the claim triggers have an `actor_id` to find. */
let staffActor: Actor

class RollBack extends Error {
  constructor() {
    super('parallel-run case complete — rolling back')
    this.name = 'RollBack'
  }
}

async function inRolledBackTransaction(
  actor: Actor,
  body: (uow: UnitOfWork) => Promise<void>,
): Promise<void> {
  try {
    await withUnitOfWork(sql, actor, async (uow) => {
      await body(uow)
      throw new RollBack()
    })
  } catch (error) {
    if (error instanceof RollBack) return
    throw error
  }
}

/** Two trading dates the seeded calendar holds, and the window that contains them. */
let dayOne = ''
let dayTwo = ''
let outsideWindow = ''

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const principal = await createFixturePrincipal(sql, { role: 'manager' })
  staffActor = { kind: 'staff', id: principal.employeeId, label: 'H-MIG-10 parallel-run suite' }
  const days = await sql<{ tradingDate: string }[]>`
    select trading_date::text as "tradingDate" from business_day order by trading_date limit 3
  `
  dayOne = days[0]?.tradingDate ?? ''
  dayTwo = days[1]?.tradingDate ?? ''
  outsideWindow = days[2]?.tradingDate ?? ''
  expect([dayOne, dayTwo, outsideWindow].every((day) => day.length === 10)).toBe(true)
}, 60_000)

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/**
 * Issues one statement inside a SAVEPOINT and answers the SQLSTATE it was refused with.
 *
 * A refused statement aborts the enclosing transaction, so two refusals asserted in sequence without a
 * savepoint give the first rule's code and then `25P02 current_transaction_is_aborted` — which reads as
 * the second rule not firing at all. `postgres.js` also executes a tagged template EAGERLY, so the
 * statement is passed as a thunk rather than as a query built in an array literal: both queries in such
 * a literal are already in flight before the first assertion is made.
 */
async function refusalCode(
  uow: UnitOfWork,
  statement: () => PromiseLike<unknown>,
): Promise<string> {
  await uow.sql`savepoint refusal_probe`
  try {
    await statement()
  } catch (error) {
    await uow.sql`rollback to savepoint refusal_probe`
    return String(
      parallelRunError(error)?.details?.['sqlState'] ?? `untranslated: ${String(error)}`,
    )
  }
  await uow.sql`release savepoint refusal_probe`
  throw new Error('the statement was permitted, so there is no refusal to report')
}

/** Writes the window into the transaction's own view of `app_setting`. */
async function setWindow(uow: UnitOfWork, start: string, end: string): Promise<void> {
  for (const [key, value] of [
    [PARALLEL_RUN_WINDOW_START_SETTING_KEY, start],
    [PARALLEL_RUN_WINDOW_END_SETTING_KEY, end],
  ] as const) {
    await uow.sql`
      insert into app_setting (key, value, tier, is_provisional, open_question_id, updated_by)
      values (${key}, ${uow.sql.json(value as never)}, 'operational', true,
              'Y8-parallel-run-window', 'H-MIG-10 suite')
      on conflict (key) do update set value = excluded.value
    `
  }
}

describe('the window', () => {
  it('refuses to report at all while it is unset, rather than reporting no variance', async () => {
    await inRolledBackTransaction(ACTOR_SYSTEM, async (uow) => {
      await uow.sql`
        delete from app_setting
         where key in (${PARALLEL_RUN_WINDOW_START_SETTING_KEY}, ${PARALLEL_RUN_WINDOW_END_SETTING_KEY})
      `
      // The acceptance line's own wording: a misleading zero, refused. "0 days, no variance" reads
      // exactly like a parallel run in which everything agreed.
      await expect(readParallelRunWindow(uow.sql)).rejects.toThrow(/not set/)
      await expect(readParallelRunWindow(uow.sql)).rejects.toThrow(/Y8-parallel-run-window/)
    })
  })

  it('refuses a reconciliation for a day outside it, by name', async () => {
    await inRolledBackTransaction(staffActor, async (uow) => {
      await setWindow(uow, dayOne, dayTwo)
      await recordPaperCount(uow, {
        businessDay: outsideWindow,
        sheetCount: 3,
        countedBy: 'the H-MIG-10 suite',
      })
      let refusal: unknown
      try {
        await recordReconciliation(
          uow,
          { businessDay: outsideWindow, systemCount: 3, ranAt: new Date() },
          { start: dayOne, end: dayTwo },
        )
      } catch (error) {
        refusal = error
      }
      expect(parallelRunError(refusal)?.details?.['sqlState']).toBe(
        PARALLEL_RUN_SQLSTATE.dayOutsideWindow,
      )
      // The message is where a reader at 02:00 finds out what to do, which is why it is a trigger.
      expect(String((refusal as Error).message)).toContain('misleading zero')
      expect(String((refusal as Error).message)).toContain(PARALLEL_RUN_WINDOW_START_SETTING_KEY)
    })
  })

  it('does not pass vacuously: a day INSIDE the window reconciles', async () => {
    await inRolledBackTransaction(staffActor, async (uow) => {
      await setWindow(uow, dayOne, dayTwo)
      await recordPaperCount(uow, {
        businessDay: dayOne,
        sheetCount: 5,
        countedBy: 'the H-MIG-10 suite',
      })
      const written = await recordReconciliation(
        uow,
        { businessDay: dayOne, systemCount: 5, ranAt: new Date() },
        { start: dayOne, end: dayTwo },
      )
      expect(written.state).toBe('reconciled')
      expect(written.difference).toBe(0)
    })
  })
})

describe('the paper count is a named person’s claim', () => {
  it('cannot COMMIT without a staff-attributed audit row in the same transaction', async () => {
    await inRolledBackTransaction(ACTOR_SYSTEM, async (uow) => {
      // A SYSTEM actor, which is what the job is — so the audit row the writer emits names no person.
      await recordPaperCount(uow, {
        businessDay: dayOne,
        sheetCount: 7,
        countedBy: 'the H-MIG-10 suite',
      })
      let refusal: unknown
      try {
        // ZY742 is DEFERRED, so without this the rehearsal is weaker than the run.
        await uow.sql`set constraints all immediate`
      } catch (error) {
        refusal = error
      }
      expect(parallelRunError(refusal)?.details?.['sqlState']).toBe(
        PARALLEL_RUN_SQLSTATE.paperCountNotAttributed,
      )
      expect(String((refusal as Error).message)).toContain('NAMED PERSON')
    })
  })

  it('commits when a staff actor made the claim', async () => {
    // The control: the refusal above must be about the ACTOR and not about the writer being broken.
    await inRolledBackTransaction(staffActor, async (uow) => {
      await recordPaperCount(uow, {
        businessDay: dayOne,
        sheetCount: 7,
        countedBy: 'the H-MIG-10 suite',
      })
      await uow.sql`set constraints all immediate`
    })
  })

  it('cannot be changed or deleted afterwards', async () => {
    await inRolledBackTransaction(staffActor, async (uow) => {
      await recordPaperCount(uow, {
        businessDay: dayOne,
        sheetCount: 7,
        countedBy: 'the H-MIG-10 suite',
      })
      await uow.sql`set constraints all immediate`
      expect(
        await refusalCode(
          uow,
          () =>
            uow.sql`update parallel_run_paper_count set sheet_count = 9 where business_day = ${dayOne}::date`,
        ),
      ).toBe(PARALLEL_RUN_SQLSTATE.paperCountImmutable)
      expect(
        await refusalCode(
          uow,
          () => uow.sql`delete from parallel_run_paper_count where business_day = ${dayOne}::date`,
        ),
      ).toBe(PARALLEL_RUN_SQLSTATE.paperCountImmutable)
    })
  })
})

describe('the variance', () => {
  it('is signed, and flags a non-zero difference per business day', async () => {
    await inRolledBackTransaction(staffActor, async (uow) => {
      await setWindow(uow, dayOne, dayTwo)
      await recordPaperCount(uow, {
        businessDay: dayOne,
        sheetCount: 9,
        countedBy: 'the H-MIG-10 suite',
      })
      await recordPaperCount(uow, {
        businessDay: dayTwo,
        sheetCount: 2,
        countedBy: 'the H-MIG-10 suite',
      })
      const window = { start: dayOne, end: dayTwo }
      const more = await recordReconciliation(
        uow,
        { businessDay: dayOne, systemCount: 4, ranAt: new Date() },
        window,
      )
      const fewer = await recordReconciliation(
        uow,
        { businessDay: dayTwo, systemCount: 6, ranAt: new Date() },
        window,
      )
      // Positive: treatments the paper recorded that the system does not hold — work this business did
      // and cannot bill. Negative: the reverse. An absolute figure would make the two indistinguishable.
      expect(more.difference).toBe(5)
      expect(more.state).toBe('unreconciled')
      expect(fewer.difference).toBe(-4)
      expect(fewer.state).toBe('unreconciled')
      const rows = await readParallelRunVariance(uow.sql, window)
      expect(rows.map((row) => row.businessDay)).toEqual([dayOne, dayTwo])
      expect(rows.every((row) => row.countedBy === 'the H-MIG-10 suite')).toBe(true)
      // Read straight off the VIEW as well as through the writer's return, because the view holds the
      // one statement of the arithmetic and the two are different code paths to it. A gate case cannot
      // break the view's expression — a file edit does not change a database that is already migrated —
      // so this is where that claim is held.
      expect(rows.map((row) => row.difference)).toEqual([5, -4])
      expect(rows.map((row) => row.state)).toEqual(['unreconciled', 'unreconciled'])
      expect(await countUnreconciledDaysTo(uow.sql, dayTwo)).toBe(2)
    })
  })

  it('emits nothing for a closed day nobody has counted, and names it', async () => {
    await inRolledBackTransaction(staffActor, async (uow) => {
      await setWindow(uow, dayOne, dayTwo)
      await recordPaperCount(uow, {
        businessDay: dayOne,
        sheetCount: 1,
        countedBy: 'the H-MIG-10 suite',
      })
      const result = await runParallelRunReconciliationPass(uow.sql, {
        // Well after both days closed, so the calendar — not arithmetic on the clock — selects them.
        nowIso: '2099-01-01T00:00:00.000Z',
        countedBySystem: async () => 1,
        transactionally: (fn) => fn(uow),
      })
      expect(result.reconciled.map((row) => row.businessDay)).toEqual([dayOne])
      // The acceptance line: a row with paper_count 0 is indistinguishable from agreement, so the day
      // is reported as awaiting rather than reconciled and never skipped in silence.
      expect(result.awaitingPaperCount).toEqual([dayTwo])
      expect(result.flagged).toEqual([])
      expect(describeParallelRunPass(result)).toContain('have no paper count')
      expect(describeParallelRunPass(result)).toContain(dayTwo)
    })
  })
})

describe('the rollback decision', () => {
  it('cannot COMMIT without a staff-attributed audit row in the same transaction', async () => {
    await inRolledBackTransaction(ACTOR_SYSTEM, async (uow) => {
      await recordParallelRunDecision(uow, {
        decision: 'proceed',
        decidedAt: new Date(),
        decidedBy: 'the H-MIG-10 suite',
        rationale: 'the suite is exercising the refusal',
        asOfBusinessDay: dayOne,
        unreconciledDays: 0,
      })
      let refusal: unknown
      try {
        await uow.sql`set constraints all immediate`
      } catch (error) {
        refusal = error
      }
      expect(parallelRunError(refusal)?.details?.['sqlState']).toBe(
        PARALLEL_RUN_SQLSTATE.decisionNotAttributed,
      )
      expect(String((refusal as Error).message)).toContain('taken by the system')
    })
  })

  it('holds its unreconciled-day count to the rows it summarises', async () => {
    await inRolledBackTransaction(staffActor, async (uow) => {
      await setWindow(uow, dayOne, dayTwo)
      await recordPaperCount(uow, {
        businessDay: dayOne,
        sheetCount: 9,
        countedBy: 'the H-MIG-10 suite',
      })
      await recordReconciliation(
        uow,
        { businessDay: dayOne, systemCount: 4, ranAt: new Date() },
        { start: dayOne, end: dayTwo },
      )
      await recordParallelRunDecision(uow, {
        decision: 'proceed',
        decidedAt: new Date(),
        // The figure is wrong by one, which is the edit that would make a decision look better than it
        // was: "proceeded while nothing was unexplained" over a day that disagreed by five treatments.
        decidedBy: 'the H-MIG-10 suite',
        rationale: 'claiming a clean record over a day that disagrees',
        asOfBusinessDay: dayOne,
        unreconciledDays: 0,
      })
      let refusal: unknown
      try {
        await uow.sql`set constraints all immediate`
      } catch (error) {
        refusal = error
      }
      expect(parallelRunError(refusal)?.details?.['sqlState']).toBe(
        PARALLEL_RUN_SQLSTATE.decisionEvidenceDisagrees,
      )
      expect(String((refusal as Error).message)).toContain('nobody can act on')
    })
  })

  it('commits with the right evidence, and cannot be changed afterwards', async () => {
    await inRolledBackTransaction(staffActor, async (uow) => {
      await setWindow(uow, dayOne, dayTwo)
      await recordPaperCount(uow, {
        businessDay: dayOne,
        sheetCount: 9,
        countedBy: 'the H-MIG-10 suite',
      })
      await recordReconciliation(
        uow,
        { businessDay: dayOne, systemCount: 4, ranAt: new Date() },
        { start: dayOne, end: dayTwo },
      )
      const unreconciled = await countUnreconciledDaysTo(uow.sql, dayOne)
      expect(unreconciled).toBe(1)
      const id = await recordParallelRunDecision(uow, {
        decision: 'roll_back',
        decidedAt: new Date(),
        decidedBy: 'the H-MIG-10 suite',
        rationale: 'one day disagrees by five treatments',
        asOfBusinessDay: dayOne,
        unreconciledDays: unreconciled,
      })
      await uow.sql`set constraints all immediate`
      expect(
        await refusalCode(
          uow,
          () =>
            uow.sql`update parallel_run_decision set decision = 'proceed' where id = ${id}::uuid`,
        ),
      ).toBe(PARALLEL_RUN_SQLSTATE.decisionImmutable)
      expect(
        await refusalCode(
          uow,
          () => uow.sql`delete from parallel_run_decision where id = ${id}::uuid`,
        ),
      ).toBe(PARALLEL_RUN_SQLSTATE.decisionImmutable)
    })
  })
})

describe('what nothing here does', () => {
  it('offers no function that decides a cutover', async () => {
    /*
      The constraint this unit was given in so many words: do not build a mechanism that decides it. So
      the claim is asserted over the SOURCE of the two modules that could hold one — a scan, because the
      absence of a function cannot be observed by calling anything.

      `walkInSpeedVerdict` is imported here only so this file's import of `@berelax/core` is the one the
      pilot's arithmetic lives in, and the assertion below is what keeps that honest.
    */
    const modules = {
      'services/parallel-run.ts': await import('../../../packages/db/src/services/parallel-run.ts'),
      'jobs/parallel-run-reconcile.ts': await import(
        '../../../apps/worker/src/jobs/parallel-run-reconcile.ts'
      ),
    }
    for (const [where, module] of Object.entries(modules)) {
      /*
        The EXPORTS and not the source text, which is what the first version of this case scanned — and
        it failed on the modules' own prose, because every one of them explains at length that nothing
        here recommends a cutover. A scan that a comment can fail is a scan that a comment can also
        satisfy, which is the vacuity ADR 0002 is about.
      */
      const deciders = Object.keys(module).filter((name) =>
        /decid|decision|recommend|verdict|threshold|shouldRoll/i.test(name),
      )
      // The ONE export whose name is about the decision RECORDS it and takes it as an argument. There is
      // no `decideCutover`, no threshold and no verdict anywhere in either module, and the worker — the
      // thing that runs daily and sees every variance row — exports nothing of the kind at all.
      expect(deciders, where).toEqual(
        where.startsWith('services') ? ['recordParallelRunDecision'] : [],
      )
    }
    // And the control: the thing this unit DOES decide by arithmetic is the speed verdict, which is a
    // measurement rather than a judgement about a business.
    expect(walkInSpeedVerdict([]).kind).toBe('not_measured')
  })
})
