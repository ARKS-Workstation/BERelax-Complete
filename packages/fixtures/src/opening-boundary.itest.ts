import { boundaryVerdict, openingRemainder } from '@berelax/core'
import {
  type Actor,
  createConnection,
  OPENING_BOUNDARY_SQLSTATE,
  openingBalanceIsAttested,
  openingBoundaryError,
  readChartAccountCodes,
  readOpeningBalancePostings,
  readOpeningBoundary,
  readVat201Attributions,
  reconcileOpeningPosition,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { runImport } from '@berelax/migration'
import {
  boxesFedByTheChart,
  buildOpeningWorkbook,
  chartAttributionGaps,
  OPENING_HEADER,
  OPENING_IMPORTER_TARGETS,
  openingBalancesImporter,
  parseOpeningWorkbook,
  statedPositions,
} from '@berelax/migration/importers/ledger'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * H-MIG-07's five acceptance lines, against a real PostgreSQL, each with a control that must fail.
 *
 * This is the only place they can be asserted. `packages/migration` may not import `@berelax/core`, so
 * the remainder arithmetic is injected here from the real `openingRemainder`; and the check that holds
 * `boundaryVerdict` equal to migration 0132's triggers needs both, which only `packages/fixtures` may
 * see.
 *
 * ## Every case runs inside a transaction it ROLLS BACK, and that is not the usual arrangement
 *
 * Every other import suite in this repository commits and leaves its rows behind, because the staging
 * ledger is append-only and the records are the evidence. This one cannot: an opening balance is UNIQUE
 * on `(legal_entity_id, opening_date)` and, once attested, it LOCKS THE WHOLE DATABASE BEHIND ITS
 * BOUNDARY — `ZL004` and `ZY381` then refuse every entry any later suite posts with an earlier date, and
 * the integration suite runs sequentially against one database (brief rule 12). A committed opening
 * balance here would therefore break suites that have nothing to do with this unit, in a way whose
 * symptom names neither.
 *
 * So each case opens a `withUnitOfWork`, does its work, asserts, and throws a sentinel to roll back. The
 * import framework's own `dry-run` mode does the same thing for the same reason and forces the deferred
 * constraints before rolling back; here the cases that are ABOUT a deferred constraint (ZY382) do that
 * explicitly with `set constraints all immediate`, so the rehearsal is as strong as the run.
 *
 * **Inside such a transaction the importer's `apply` is driven DIRECTLY and not through `runImport`**, and
 * the reason is mechanical: `runImport` opens a transaction of its own per row through `withUnitOfWork`,
 * which calls `sql.begin` — and a `postgres.js` transaction handle has no `begin`, only `savepoint`, so a
 * nested run fails with `sql.begin is not a function` before it reaches anything this suite is about. The
 * cases that are about the framework's own behaviour — the staged rejection, the report, the forced
 * deferred constraints — use `runImport` in `dry-run` mode instead, which is one transaction it rolls
 * back itself. Between them every path is exercised and nothing commits.
 *
 * The boundary is drawn per EXECUTION from a date far in the past that the seeded calendar does not
 * reach, so even an accidental commit could not lock a date any other suite posts to — and the
 * reconciliation cases assert DELTAS rather than totals (brief rule 9), because `journal_line` is
 * append-only and every money suite posts to the same accounts.
 */

let sql: Sql

const ACTOR: Actor = { kind: 'system', label: 'H-MIG-07 opening-boundary suite' }

/** Thrown to reach a ROLLBACK with an assertion already made. The framework's own arrangement. */
class RollBack extends Error {
  constructor() {
    super('opening-boundary case complete — rolling back')
    this.name = 'RollBack'
  }
}

/** Runs `body` in a transaction and rolls it back, whatever it asserted. */
async function inRolledBackTransaction(
  body: (uow: Parameters<Parameters<typeof withUnitOfWork>[2]>[0]) => Promise<void>,
): Promise<void> {
  try {
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      await body(uow)
      throw new RollBack()
    })
  } catch (error) {
    if (error instanceof RollBack) return
    throw error
  }
}

/**
 * A boundary this execution owns, well before the seeded trading calendar.
 *
 * 1970 and not a plausible cutover date, deliberately: nothing in the seed or in any other suite posts an
 * entry anywhere near it, so even a case that escaped its rollback could not lock a date somebody else
 * needs. The arithmetic the unit is about does not depend on the year.
 */
const BOUNDARY = `1970-${String(1 + (process.pid % 12)).padStart(2, '0')}-0${1 + (process.pid % 9)}`

let chartCodes: readonly string[] = []
let debitAccount = ''
let creditAccount = ''
let fileCounter = 0

const OPTIONS = {
  remainder: openingRemainder as never,
  importedBy: 'H-MIG-07 opening-boundary suite',
}

function openingFile(
  rows: readonly (readonly [string, number, number])[],
  boundary = BOUNDARY,
): string {
  fileCounter += 1
  return [
    buildOpeningWorkbook(),
    `# suite file ${fileCounter}`,
    ...rows.map(([code, debit, credit]) =>
      [boundary, code, String(debit), String(credit)].join('\t'),
    ),
    '',
  ].join('\n')
}

/**
 * Stages a file through the importer's own `parse` and `validate`, then drives `apply` on this handle.
 *
 * `runImport` cannot be nested inside a transaction (see the module note), so the suite does what the
 * framework does minus the staging ledger: it parses, refuses by name if the statement is bad, and
 * applies. The entities `apply` returns are what the framework would record provenance against, and they
 * are asserted where that is the claim.
 */
async function applyStatement(
  uow: Parameters<Parameters<typeof withUnitOfWork>[2]>[0],
  sourceText: string,
): Promise<readonly { readonly table: string; readonly id: string }[]> {
  const importer = openingBalancesImporter(OPTIONS)
  const rows = importer.parse(sourceText)
  const row = must(rows[0], 'one staged statement')
  const verdict = importer.validate(row.payload)
  if (!verdict.ok) throw new Error(`the suite's own file was refused: ${verdict.reason}`)
  return importer.apply(uow, row.payload)
}

/**
 * Attempts something expected to be REFUSED, inside a savepoint, and returns the error.
 *
 * The savepoint is not tidiness. A failed statement aborts the whole transaction in PostgreSQL, so the
 * second probe in any of these cases came back `25P02 current transaction is aborted` and the assertion
 * then reported the wrong code for the right refusal — three cases failed that way before this helper
 * existed. `postgres.js` rolls a savepoint back when its callback rejects and re-throws, so the outer
 * transaction survives and the next probe is about what it says it is about.
 */
async function refusedWith(
  uow: Parameters<Parameters<typeof withUnitOfWork>[2]>[0],
  body: (handle: Sql) => Promise<unknown>,
): Promise<{ readonly code?: string; readonly message: string }> {
  const tx = uow.sql as unknown as {
    savepoint: <T>(fn: (handle: Sql) => Promise<T>) => Promise<T>
  }
  const caught = await tx
    .savepoint(async (handle) => {
      await body(handle)
    })
    .then(
      () => null,
      (error: unknown) => error,
    )
  if (caught === null) throw new Error('the statement was expected to be refused and was not')
  return {
    ...(typeof (caught as { code?: unknown }).code === 'string'
      ? { code: (caught as { code: string }).code }
      : {}),
    message: caught instanceof Error ? caught.message : String(caught),
  }
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the suite expected ${what} and the read returned none`)
  return value
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })
  chartCodes = await readChartAccountCodes(sql)
  // Read, never written down. An account code stated here would be a second statement of the chart, and
  // `opening-balances.itest.ts`'s recorded failure is the same mistake one column along.
  const accounts = await sql<{ code: string; normalBalance: string }[]>`
    select code, normal_balance as "normalBalance" from account order by code
  `
  debitAccount = must(
    accounts.find((row) => row.normalBalance === 'debit')?.code,
    'an account whose normal balance is a debit',
  )
  creditAccount = must(
    accounts.find((row) => row.normalBalance === 'credit')?.code,
    'an account whose normal balance is a credit',
  )
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('the opening trial balance is refused unless it balances', () => {
  it('names the imbalance in fils before anything is written', async () => {
    const unbalanced = openingFile([
      [debitAccount, 4_000_000, 0],
      [creditAccount, 0, 3_998_750],
    ])
    // The framework stages the row, `validate` refuses it by name, and the run ends `failed` having
    // applied nothing (ADR 0065). The staged rejection is COMMITTED as the evidence, which is why this
    // one case runs outside a rolled-back transaction — it writes no journal entry and no attestation.
    const report = await runImport({
      sql,
      importer: openingBalancesImporter(OPTIONS),
      sourceFile: 'opening-unbalanced.tsv',
      sourceText: unbalanced,
      mode: 'dry-run',
      actor: ACTOR,
    })
    expect(report.state).toBe('failed')
    expect(report.applied).toBe(0)
    expect(report.rejections.map((rejection) => rejection.reason)).toEqual([
      'opening-trial-balance-must-balance',
    ])
  })

  it('and the imbalance in fils is in the message the writer throws', async () => {
    // `assertImportable` in `packages/db/src/services/opening-balances.ts` is the layer that names the
    // figure — 1,250 fils here — and it predates this unit. Asserted rather than restated, because the
    // acceptance line is about the sentence a person corrects a spreadsheet from.
    await inRolledBackTransaction(async (uow) => {
      const { importOpeningBalances } = await import('@berelax/db')
      await expect(
        importOpeningBalances(uow, {
          openingDate: BOUNDARY,
          entryId: `OPEN-PROBE-${BOUNDARY}`,
          importedBy: ACTOR.label ?? 'suite',
          lines: [
            { accountCode: debitAccount, debitFils: 4_000_000, creditFils: 0 },
            { accountCode: creditAccount, debitFils: 0, creditFils: 3_998_750 },
          ],
        }),
      ).rejects.toThrow(/debits exceed credits by 1250 fils/)
    })
  })
})

describe('the period up to the boundary is locked once the balance is imported', () => {
  it('refuses a posting dated before it, and the refusal names the boundary', async () => {
    await inRolledBackTransaction(async (uow) => {
      await applyStatement(
        uow,
        openingFile([
          [debitAccount, 4_000_000, 0],
          [creditAccount, 0, 4_000_000],
        ]),
      )
      expect(await openingBalanceIsAttested(uow.sql, BOUNDARY)).toBe(true)

      // An ordinary posting: ZL004 (0027). Still the named error the acceptance line asks for, and it
      // fires first because PostgreSQL runs BEFORE triggers in name order and `not_before_opening`
      // sorts ahead of `not_behind_the_boundary`.
      const before = new Date(`${BOUNDARY}T00:00:00Z`)
      before.setUTCDate(before.getUTCDate() - 1)
      const earlier = before.toISOString().slice(0, 10)
      const sale = await refusedWith(
        uow,
        (handle) => handle`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${`PROBE-SALE-${earlier}`}, ${earlier}::date, 'a sale behind the boundary', 'sale')
        `,
      )
      expect(sale.code).toBe('ZL004')
      expect(sale.message).toContain(BOUNDARY)

      // An `opening_balance` or a `reversal` dated earlier: 0027 EXEMPTED those two sources so the
      // opening entry could be inserted at all, and 0132 closes the exemption once a boundary exists.
      for (const source of ['opening_balance', 'reversal'] as const) {
        const refused = await refusedWith(
          uow,
          (handle) => handle`
            insert into journal_entry (entry_id, entry_date, narrative, source)
            values (${`PROBE-${source}-${earlier}`}, ${earlier}::date, 'behind the boundary', ${source})
          `,
        )
        expect(refused.code).toBe(OPENING_BOUNDARY_SQLSTATE.behindTheBoundary)
        // The refusal NAMES the boundary and the remedy, which is what the acceptance line asks of it.
        expect(refused.message).toContain(BOUNDARY)
      }

      // And a further opening_balance ON the boundary, which is where the opening entries actually sit.
      const second = await refusedWith(
        uow,
        (handle) => handle`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${`PROBE-SECOND-${BOUNDARY}`}, ${BOUNDARY}::date, 'a second opening', 'opening_balance')
        `,
      )
      expect(second.code).toBe(OPENING_BOUNDARY_SQLSTATE.openingPositionIsClosed)
    })
  })

  it('permits a posting ON and AFTER the boundary, which is the control', async () => {
    await inRolledBackTransaction(async (uow) => {
      await applyStatement(
        uow,
        openingFile([
          [debitAccount, 1_000, 0],
          [creditAccount, 0, 1_000],
        ]),
      )
      // Without this the case above would pass for a trigger that refused every insert, and the books
      // could not be posted to at all after an import.
      await uow.sql`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${`PROBE-ON-${BOUNDARY}`}, ${BOUNDARY}::date, 'a sale on the boundary', 'sale')
      `
      await uow.sql`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${`PROBE-ON-${BOUNDARY}`}, 1, ${debitAccount}, 500, 0),
               (${`PROBE-ON-${BOUNDARY}`}, 2, ${creditAccount}, 0, 500)
      `
    })
  })

  it('agrees with boundaryVerdict in @berelax/core, which is a second statement of it', async () => {
    // The check that holds the two equal, in the same commit. `period-lock.ts` says the database is the
    // thing that holds and that it is the explanation; this drives both over the same inputs so the
    // explanation cannot drift from the refusal.
    await inRolledBackTransaction(async (uow) => {
      await applyStatement(
        uow,
        openingFile([
          [debitAccount, 2_000, 0],
          [creditAccount, 0, 2_000],
        ]),
      )
      const boundary = must(await readOpeningBoundary(uow.sql), 'the attested boundary')
      expect(boundary).toBe(BOUNDARY)

      const before = new Date(`${BOUNDARY}T00:00:00Z`)
      before.setUTCDate(before.getUTCDate() - 1)
      const after = new Date(`${BOUNDARY}T00:00:00Z`)
      after.setUTCDate(after.getUTCDate() + 1)

      const probes = [
        { date: before.toISOString().slice(0, 10), source: 'sale' as const, expected: false },
        { date: before.toISOString().slice(0, 10), source: 'reversal' as const, expected: false },
        { date: BOUNDARY, source: 'opening_balance' as const, expected: false },
        { date: BOUNDARY, source: 'sale' as const, expected: true },
        {
          date: after.toISOString().slice(0, 10),
          source: 'opening_balance' as const,
          expected: true,
        },
      ]

      for (const [index, probe] of probes.entries()) {
        const pure = boundaryVerdict({
          boundary: { opensOn: boundary as never },
          entryDate: probe.date as never,
          source: probe.source,
          attested: true,
        })
        expect(pure.ok).toBe(probe.expected)

        const entryId = `PROBE-AGREE-${index}`
        const insert = (handle: Sql) => handle`
          insert into journal_entry (entry_id, entry_date, narrative, source)
          values (${entryId}, ${probe.date}::date, 'agreement probe', ${probe.source})
        `
        if (probe.expected) {
          await insert(uow.sql)
          // Posted, so it has to balance: the deferred trigger would refuse a COMMIT this case never
          // reaches, and a savepoint release would not fire it — so the lines are the honest shape.
          await uow.sql`
            insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
            values (${entryId}, 1, ${debitAccount}, 100, 0), (${entryId}, 2, ${creditAccount}, 0, 100)
          `
          continue
        }
        const refused = await refusedWith(uow, insert)
        // The pure verdict's refusal and the database's code have to be about the same thing. ZL004 is
        // 0027's, which 0132 leaves in place for an ordinary source behind the boundary; the two private
        // codes are 0132's own and each maps to one of the two refusals the pure verdict names.
        if (refused.code === 'ZL004') {
          expect(pure.ok ? '' : pure.refusal).toBe('behind_the_boundary')
          continue
        }
        expect(openingBoundaryError(refused)).not.toBeNull()
        expect(refused.code).toBe(
          pure.ok || pure.refusal === 'behind_the_boundary'
            ? OPENING_BOUNDARY_SQLSTATE.behindTheBoundary
            : OPENING_BOUNDARY_SQLSTATE.openingPositionIsClosed,
        )
      }
    })
  })
})

describe('an opening balance cannot be edited', () => {
  it('refuses an UPDATE and a DELETE of the attestation, by name', async () => {
    await inRolledBackTransaction(async (uow) => {
      await applyStatement(
        uow,
        openingFile([
          [debitAccount, 3_000, 0],
          [creditAccount, 0, 3_000],
        ]),
      )
      // ZY384. 0027 revoked the privilege from `berelax_app`, which is not the rule: ZY382 is deferred
      // and fires on INSERT, so an UPDATE afterwards would change the attested totals unchecked.
      const updated = await refusedWith(
        uow,
        (handle) =>
          handle`update opening_balance_import set total_debit_fils = 1
                  where opening_date = ${BOUNDARY}::date`,
      )
      expect(updated.code).toBe(OPENING_BOUNDARY_SQLSTATE.openingBalanceImportImmutable)
      const deleted = await refusedWith(
        uow,
        (handle) =>
          handle`delete from opening_balance_import where opening_date = ${BOUNDARY}::date`,
      )
      expect(deleted.code).toBe(OPENING_BOUNDARY_SQLSTATE.openingBalanceImportImmutable)
      // And the journal itself, which `refuse_journal_change()` (0018) already covers — asserted here
      // because the acceptance line is about the pair.
      const journal = await refusedWith(
        uow,
        (handle) =>
          handle`update journal_entry set narrative = 'edited' where entry_id = ${`OPEN-${BOUNDARY}`}`,
      )
      expect(journal.message).toMatch(/refuse|immutable|append|may not/i)
    })
  })

  it('refuses an attestation whose totals do not match the entry, naming both sides', async () => {
    // ZY382, raised at COMMIT. Forced with `set constraints all immediate` so the rehearsal is as strong
    // as a run — the framework's dry-run mode does exactly this and gives the reason.
    await inRolledBackTransaction(async (uow) => {
      await uow.sql`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${`PROBE-TIE-${BOUNDARY}`}, ${BOUNDARY}::date, 'a probe opening entry', 'opening_balance')
      `
      await uow.sql`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${`PROBE-TIE-${BOUNDARY}`}, 1, ${debitAccount}, 5_000, 0),
               (${`PROBE-TIE-${BOUNDARY}`}, 2, ${creditAccount}, 0, 5_000)
      `
      await uow.sql`
        insert into opening_balance_import (
          legal_entity_id, opening_date, entry_id, total_debit_fils, total_credit_fils, imported_by
        ) values (1, ${BOUNDARY}::date, ${`PROBE-TIE-${BOUNDARY}`}, 9_000, 9_000, 'suite probe')
      `
      await expect(uow.sql`set constraints all immediate`).rejects.toMatchObject({
        code: OPENING_BOUNDARY_SQLSTATE.openingTotalsDoNotTieToTheLedger,
      })
    })
  })

  it('permits an attestation whose totals DO match, which is the control', async () => {
    await inRolledBackTransaction(async (uow) => {
      await uow.sql`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${`PROBE-OK-${BOUNDARY}`}, ${BOUNDARY}::date, 'a probe opening entry', 'opening_balance')
      `
      await uow.sql`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${`PROBE-OK-${BOUNDARY}`}, 1, ${debitAccount}, 5_000, 0),
               (${`PROBE-OK-${BOUNDARY}`}, 2, ${creditAccount}, 0, 5_000)
      `
      await uow.sql`
        insert into opening_balance_import (
          legal_entity_id, opening_date, entry_id, total_debit_fils, total_credit_fils, imported_by
        ) values (1, ${BOUNDARY}::date, ${`PROBE-OK-${BOUNDARY}`}, 5_000, 5_000, 'suite probe')
      `
      // Without this the case above would pass for a trigger that refused every attestation.
      await uow.sql`set constraints all immediate`
    })
  })
})

describe('the opening position ties to what is already posted, to the fils', () => {
  it('posts the REMAINDER and reconciles to zero variance on every account', async () => {
    await inRolledBackTransaction(async (uow) => {
      /*
        H-MIG-03's shape, planted: a reconstructed package liability posted on `source =
        'opening_balance'` at the boundary, before the trial balance that attests to it. 733_337 fils is
        the figure `cohorts.itest.ts` records as being in `2050` in the test database — used here as a
        liability-sized number with a provenance rather than a round one somebody might read as a
        convention.
      */
      const liabilityFils = 733_337
      await uow.sql`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (
          ${`PROBE-LIAB-${BOUNDARY}`}, ${BOUNDARY}::date,
          'a reconstructed package liability, as H-MIG-03 posts one', 'opening_balance'
        )
      `
      await uow.sql`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${`PROBE-LIAB-${BOUNDARY}`}, 1, ${debitAccount}, ${liabilityFils}, 0),
               (${`PROBE-LIAB-${BOUNDARY}`}, 2, ${creditAccount}, 0, ${liabilityFils})
      `

      const statedDebit = 4_000_000
      const source = openingFile([
        [debitAccount, statedDebit, 0],
        [creditAccount, 0, statedDebit],
      ])
      const entities = await applyStatement(uow, source)
      expect(entities.map((entity) => entity.table)).toEqual([
        'journal_entry',
        'opening_balance_import',
      ])

      // The entry this import posted carries the REMAINDER and not the stated figure.
      const lines = await uow.sql<{ accountCode: string; debit: string; credit: string }[]>`
        select account_code as "accountCode", debit_fils::text as debit, credit_fils::text as credit
          from journal_line where entry_id = ${`OPEN-${BOUNDARY}`} order by line_no
      `
      expect(lines.map((line) => Number(line.debit) + Number(line.credit))).toEqual([
        statedDebit - liabilityFils,
        statedDebit - liabilityFils,
      ])

      // And the reconciliation is zero on every account: the stated position equals what the boundary
      // now holds, which is the acceptance line's "ties ... to the fils".
      const reconciliation = await reconcileOpeningPosition(uow.sql, {
        openingDate: BOUNDARY,
        stated: statedPositions(parseOpeningWorkbook(source)),
      })
      expect(reconciliation.map((row) => row.varianceFils)).toEqual([0, 0])
      expect(reconciliation).toHaveLength(2)

      // The control: the same read with a DELIBERATELY wrong statement must report the variance, or the
      // zeros above would be a report about a query that measures nothing.
      const wrong = await reconcileOpeningPosition(uow.sql, {
        openingDate: BOUNDARY,
        stated: [{ accountCode: debitAccount, netFils: statedDebit - 1 }],
      })
      expect(wrong.find((row) => row.accountCode === debitAccount)?.varianceFils).toBe(-1)
    })
  })

  it('refuses a stated figure below what is already posted, naming both', async () => {
    await inRolledBackTransaction(async (uow) => {
      const liabilityFils = 733_337
      await uow.sql`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${`PROBE-UNDER-${BOUNDARY}`}, ${BOUNDARY}::date, 'a planted liability', 'opening_balance')
      `
      await uow.sql`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils)
        values (${`PROBE-UNDER-${BOUNDARY}`}, 1, ${debitAccount}, ${liabilityFils}, 0),
               (${`PROBE-UNDER-${BOUNDARY}`}, 2, ${creditAccount}, 0, ${liabilityFils})
      `
      await expect(
        applyStatement(
          uow,
          openingFile([
            [debitAccount, 500_000, 0],
            [creditAccount, 0, 500_000],
          ]),
        ),
      ).rejects.toThrow(/named variance rather than one absorbed/)
      // And nothing was posted: the read that would have shown a second entry shows only the plant.
      const postings = await readOpeningBalancePostings(uow.sql, BOUNDARY)
      expect(postings.map((row) => Math.abs(row.netFils)).sort()).toEqual([
        liabilityFils,
        liabilityFils,
      ])
    })
  })

  it('refuses a statement naming an account the chart does not hold, naming every one', async () => {
    await inRolledBackTransaction(async (uow) => {
      // `9999` is not a four-digit code the chart holds, and the refusal is the WHOLE file: a trial
      // balance missing an account is a different position that happens to balance.
      expect(chartCodes).not.toContain('9999')
      await expect(
        applyStatement(
          uow,
          openingFile([
            [debitAccount, 1_000, 0],
            ['9999', 0, 1_000],
          ]),
        ),
      ).rejects.toThrow(/does not hold: 9999/)
    })
  })

  it('leaves no imported row without provenance, proved by a dry run that COMPLETES', async () => {
    /*
      `runImport`'s dry-run mode stages, validates, applies and then issues `set constraints all
      immediate` before rolling back — which fires `ZY196`, the deferred trigger that refuses an applied
      staged row recording no provenance. So a dry run that reports `completed` IS the provenance claim,
      and it is the only shape in which this suite can make it: the run commits nothing, and after a
      rollback there is nothing left to query.

      Asserted alongside the checksums, because a run that applied the statement must have moved both
      target relations — a `completed` report over unchanged checksums would be a report about nothing.
    */
    const report = await runImport({
      sql,
      importer: openingBalancesImporter(OPTIONS),
      sourceFile: 'opening-provenance.tsv',
      sourceText: openingFile([
        [debitAccount, 7_000, 0],
        [creditAccount, 0, 7_000],
      ]),
      mode: 'dry-run',
      actor: ACTOR,
    })
    expect(report.state).toBe('completed')
    expect(report.committed).toBe(false)
    expect(report.applied).toBe(1)
    expect(report.targets.map((target) => target.relation)).toEqual([...OPENING_IMPORTER_TARGETS])
    for (const target of report.targets) {
      expect(target.exactBefore).not.toBe(target.exactAfter)
    }
  })
})

describe('the chart the balances are posted against is complete', () => {
  it('carries a VAT201 attribution on every account, measured through a LEFT JOIN', async () => {
    const attributions = await readVat201Attributions(sql)
    expect(attributions.length).toBe(chartCodes.length)
    // ZY009 is what makes this empty; the measurement is over the rows as they are, so a gap would
    // appear rather than being excluded by the query.
    expect([...chartAttributionGaps(attributions)]).toEqual([])
  })

  it('and the measurement reports a gap when there is one, which is the control', async () => {
    const attributions = await readVat201Attributions(sql)
    const first = must(attributions[0], 'an attributed account')
    // Planted in memory, not in the database: ZY009 refuses the row, so the only way to exercise the
    // measurement is over a row the database would not accept — which is exactly what makes the empty
    // answer above meaningful rather than a property of the query.
    expect([
      ...chartAttributionGaps([
        ...attributions,
        { accountCode: '9999', disposition: null as never, boxNo: null, openQuestionId: null },
      ]),
    ]).toEqual([{ accountCode: '9999', reason: 'no_attribution' }])
    expect(first.accountCode).toMatch(/^\d{4}$/)
  })

  it('feeds only boxes the mapping itself names, derived and not written down', async () => {
    const attributions = await readVat201Attributions(sql)
    const fed = boxesFedByTheChart(attributions)
    const declared = await sql<{ boxNo: number }[]>`
      select distinct box_no as "boxNo" from vat201_box_mapping
       where box_no is not null order by box_no
    `
    expect([...fed]).toEqual(declared.map((row) => row.boxNo))
    // And every account the chart holds either feeds a box, is unallocated with a question, or is
    // explicitly out of scope. That trichotomy IS "every account that needs one carries one".
    const dispositions = new Set(attributions.map((row) => row.disposition))
    for (const disposition of dispositions) {
      expect(['box', 'unallocated', 'out_of_scope']).toContain(disposition)
    }
  })
})

describe('the generated file is what the parser demands', () => {
  it('writes a header the parser accepts and refuses one it did not write', async () => {
    const file = openingFile([
      [debitAccount, 1_000, 0],
      [creditAccount, 0, 1_000],
    ])
    expect(file).toContain(OPENING_HEADER)
    const broken = file.replace(OPENING_HEADER, OPENING_HEADER.replace('account_code', 'account'))
    await expect(
      runImport({
        sql,
        importer: openingBalancesImporter(OPTIONS),
        sourceFile: 'opening-broken-header.tsv',
        sourceText: broken,
        mode: 'dry-run',
        actor: ACTOR,
      }),
    ).rejects.toThrow(/not the generated one/)
  })
})
