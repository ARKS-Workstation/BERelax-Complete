import {
  ACCOUNT_FIELDS,
  type Account,
  accountCode,
  defineAccount,
  expectedNormalBalance,
  findAccount,
  missingAccountFields,
  recoverableInputVatAccounts,
  STANDARD_SPA_CHART,
} from '@berelax/core'
import {
  createConnection,
  readChartOfAccounts,
  type Sql,
  type StoredAccount,
  type StoredChartOfAccounts,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * M-TILL-02 — the seeded chart of accounts round-trips to the `packages/core` chart with no drift.
 *
 * It lives in `@berelax/fixtures` because it compares `core`'s chart against `db`'s rows, and fixtures
 * is the one package allowed to depend on both — `db` must never import `core`. Putting it beside the
 * migration would have meant `packages/db` importing the package it is forbidden to import, which is
 * how a boundary gets relaxed for the sake of a test.
 *
 * Why the comparison matters more than it looks: the journal is append-only, so once entries reference
 * account codes, a code that means one thing in TypeScript and another in Postgres cannot be fixed by
 * a migration — it can only be restated. The rows in `0018_ledger.sql` were **generated** from
 * `STANDARD_SPA_CHART`, and this test is what keeps them generated: a hand-edit to either side fails
 * here rather than surfacing as two charts that disagree about what account 6090 recovers.
 *
 * The comparison runs in both directions and over every field of every account, because "the same
 * codes are present" is the assertion that passes while the classifications drift.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

/** The core chart, in the shape `readChartOfAccounts` returns, so the two are comparable at all. */
function coreChartAsStored(): StoredChartOfAccounts {
  return {
    id: STANDARD_SPA_CHART.id,
    provisional:
      STANDARD_SPA_CHART.provisional === null
        ? null
        : {
            openQuestionId: STANDARD_SPA_CHART.provisional.openQuestionId,
            note: STANDARD_SPA_CHART.provisional.note,
          },
    accounts: [...STANDARD_SPA_CHART.accounts]
      .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
      .map((a) => ({
        code: a.code as string,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        contra: a.contra,
        vatBox: a.vatBox,
        inputVatRecoverable: a.inputVatRecoverable,
      })),
  }
}

/**
 * Names every way two charts differ, field by field, in both directions.
 *
 * A boolean would have been enough for the happy path and useless for the controls: when this fires in
 * a year's time the question is *which* account and *which* classification, and a failure that only
 * says "the chart drifted" sends the reader to diff 62 rows by hand.
 */
function chartDifferences(
  left: StoredChartOfAccounts,
  right: StoredChartOfAccounts,
): readonly string[] {
  const problems: string[] = []
  if (left.id !== right.id) problems.push(`chart id: "${left.id}" vs "${right.id}"`)

  const leftMarker = JSON.stringify(left.provisional)
  const rightMarker = JSON.stringify(right.provisional)
  if (leftMarker !== rightMarker) {
    problems.push(`provisional marker: ${leftMarker} vs ${rightMarker}`)
  }

  const byCode = (chart: StoredChartOfAccounts) => new Map(chart.accounts.map((a) => [a.code, a]))
  const leftAccounts = byCode(left)
  const rightAccounts = byCode(right)

  for (const code of leftAccounts.keys()) {
    if (!rightAccounts.has(code)) problems.push(`account ${code}: present on the left only`)
  }
  for (const code of rightAccounts.keys()) {
    if (!leftAccounts.has(code)) problems.push(`account ${code}: present on the right only`)
  }

  for (const [code, a] of leftAccounts) {
    const b = rightAccounts.get(code)
    if (b === undefined) continue
    // Driven by ACCOUNT_FIELDS, not by a hand-written list: adding a classification to an account in
    // core makes an unmirrored column a failure here rather than a silently unchecked field.
    for (const field of ACCOUNT_FIELDS) {
      if (field === 'code') continue
      const l = a[field as keyof StoredAccount]
      const r = b[field as keyof StoredAccount]
      if (l !== r) problems.push(`account ${code}.${field}: ${String(l)} vs ${String(r)}`)
    }
  }
  return problems
}

describe('the seeded chart round-trips to the core chart', () => {
  it('matches field for field, in both directions, with no drift', async () => {
    const stored = await readChartOfAccounts(sql, STANDARD_SPA_CHART.id)
    expect(stored).not.toBeNull()
    if (stored === null) return

    expect(chartDifferences(coreChartAsStored(), stored)).toEqual([])
    // Not vacuous: there really are 62 accounts on both sides, so an empty-versus-empty comparison
    // cannot be what produced the empty list above.
    expect(stored.accounts).toHaveLength(STANDARD_SPA_CHART.accounts.length)
    expect(stored.accounts.length).toBeGreaterThan(50)
    // Every field of ACCOUNT_FIELDS was compared, so the test grows when the model does.
    expect(ACCOUNT_FIELDS.length).toBe(7)
  })

  it('carries the provisional marker as data, not as a comment', async () => {
    // Y8-coa is open: the business has an existing chart and the accountant has monthly expectations
    // nobody has written down. An accountant reading the database has to be able to see that these
    // classifications are a standing-in assumption, which a marker left behind in the TypeScript
    // cannot tell them.
    const stored = await readChartOfAccounts(sql, STANDARD_SPA_CHART.id)
    expect(stored?.provisional?.openQuestionId).toBe('Y8-coa')
    expect(stored?.provisional?.note).toBe(STANDARD_SPA_CHART.provisional?.note)

    // Control: the reader returns null for a chart that is not there, rather than an empty chart that
    // would compare equal to nothing in particular.
    expect(await readChartOfAccounts(sql, 'no-such-chart')).toBeNull()
  })

  it('every stored row survives core defineAccount, so a database row is still a valid account', async () => {
    // A row read out of Postgres is `unknown` however well typed the literal that produced it was.
    // Feeding each one back through core's own constructor proves the seed did not merely get the
    // column names right: defineAccount refuses an omitted classification, a normal balance that
    // disagrees with the type, and recoverable blocked input VAT.
    const stored = await readChartOfAccounts(sql, STANDARD_SPA_CHART.id)
    const rebuilt: Account[] = []
    for (const row of stored?.accounts ?? []) {
      rebuilt.push(
        defineAccount({
          code: accountCode(row.code),
          name: row.name,
          type: row.type as Account['type'],
          normalBalance: row.normalBalance as Account['normalBalance'],
          contra: row.contra,
          vatBox: row.vatBox as Account['vatBox'],
          inputVatRecoverable: row.inputVatRecoverable,
        }),
      )
    }
    expect(rebuilt).toHaveLength(STANDARD_SPA_CHART.accounts.length)
    for (const account of rebuilt) {
      expect(missingAccountFields(account)).toEqual([])
      expect(account.normalBalance).toBe(expectedNormalBalance(account.type, account.contra))
    }

    // Control: a row with the classification left off is refused, so the loop above is asserting
    // something. `vatBox` is the field the database cannot protect — a nullable column cannot tell
    // "feeds no grouping" from "nobody decided" — which is exactly why it is checked here.
    const underSpecified = {
      code: accountCode('1010'),
      name: 'Cash in drawer',
      type: 'asset',
      normalBalance: 'debit',
      contra: false,
      inputVatRecoverable: false,
    }
    expect(() => defineAccount(underSpecified as unknown as Account)).toThrow(/leaves vatBox unset/)
  })

  it('the comparison detects a mutated row, a missing row and an extra row', async () => {
    // The gate for this gate. Everything above asserts the chart matches; none of it shows that the
    // comparison could ever have reported otherwise. So here it is, shown failing three ways.
    const core = coreChartAsStored()
    const stored = await readChartOfAccounts(sql, STANDARD_SPA_CHART.id)
    if (stored === null) throw new Error('the chart is not seeded')

    const mutate = (code: string, patch: Partial<StoredAccount>): StoredChartOfAccounts => ({
      ...stored,
      accounts: stored.accounts.map((a) => (a.code === code ? { ...a, ...patch } : a)),
    })

    // A renamed account: the kind of drift a hand-edit to the migration produces.
    expect(chartDifferences(core, mutate('1010', { name: 'Cash in the drawer' }))).toEqual([
      'account 1010.name: Cash in drawer vs Cash in the drawer',
    ])
    // A re-tagged VAT box: the drift that reaches the VAT201 working papers and nothing else.
    expect(chartDifferences(core, mutate('6090', { vatBox: 'recoverable_input_tax' }))).toEqual([
      'account 6090.vatBox: blocked_input_tax vs recoverable_input_tax',
    ])
    // A missing account and an extra account, in both directions.
    const without = { ...stored, accounts: stored.accounts.filter((a) => a.code !== '2070') }
    expect(chartDifferences(core, without)).toEqual(['account 2070: present on the left only'])
    const extra = {
      ...stored,
      accounts: [...stored.accounts, { ...(stored.accounts[0] as StoredAccount), code: '9999' }],
    }
    expect(chartDifferences(core, extra)).toEqual(['account 9999: present on the right only'])
    // And the marker: a chart that quietly stopped being provisional.
    expect(chartDifferences(core, { ...stored, provisional: null })[0]).toMatch(
      /^provisional marker/,
    )
  })

  it('reports drift introduced into the database itself, not only into a copy of the rows', async () => {
    // The three controls above mutate JavaScript objects, which proves the comparison function works.
    // This one mutates the database and rolls back, which proves the comparison is reading the rows
    // rather than something it computed from the core chart on both sides.
    await expect(
      sql.begin(async (tx) => {
        await tx`update account set name = 'Petty cash' where code = '1015'`
        const drifted = await readChartOfAccounts(tx as unknown as Sql, STANDARD_SPA_CHART.id)
        if (drifted === null) throw new Error('the chart is not seeded')
        expect(chartDifferences(coreChartAsStored(), drifted)).toEqual([
          'account 1015.name: Petty cash float vs Petty cash',
        ])
        // Rolled back: the chart is not a fixture to be left rearranged for the next suite.
        throw new Error('rollback the deliberate drift')
      }),
    ).rejects.toThrow('rollback the deliberate drift')

    const restored = await readChartOfAccounts(sql, STANDARD_SPA_CHART.id)
    if (restored === null) throw new Error('the chart is not seeded')
    expect(chartDifferences(coreChartAsStored(), restored)).toEqual([])
  })

  it('holds the accounts P-HR, Y-PAY and M-TILL-07 will post to, by name', async () => {
    // A chart of accounts lands in an append-only journal: adding a code later is easy and renumbering
    // one means restating history. So the accounts those units need are already seeded, and asserting
    // it here — against the database rather than against the TypeScript — is what makes a second chart
    // migration in P-HR unnecessary rather than merely unlikely.
    const stored = await readChartOfAccounts(sql, STANDARD_SPA_CHART.id)
    const byName = new Map((stored?.accounts ?? []).map((a) => [a.name, a]))
    for (const name of [
      'End-of-service gratuity liability',
      'Staff commission expense',
      'Payment gateway clearing',
      'Tips payable to therapists',
      'Cash over and short',
      'Deferred revenue — packages',
    ]) {
      expect(byName.has(name)).toBe(true)
      // And core agrees the code exists, which is the round trip stated once more per account.
      const code = byName.get(name)?.code ?? ''
      expect(findAccount(STANDARD_SPA_CHART, accountCode(code))?.name).toBe(name)
    }
    // Control: a name nobody seeded is absent, so the loop is not passing against a lookup that
    // answers true for everything.
    expect(byName.has('Gratuity')).toBe(false)
  })

  it('the recoverable-input-VAT population is the same on both sides', async () => {
    // Box 9 is derived from this population, so a database that disagreed with core about which
    // accounts carry recoverable input VAT would produce a VAT return nobody could reconcile to the
    // trial balance. Blocked input VAT (entertainment) must be outside it on both sides.
    const stored = await readChartOfAccounts(sql, STANDARD_SPA_CHART.id)
    const fromDb = (stored?.accounts ?? [])
      .filter((a) => a.inputVatRecoverable)
      .map((a) => a.code)
      .sort()
    const fromCore = recoverableInputVatAccounts(STANDARD_SPA_CHART)
      .map((a) => a.code as string)
      .sort()
    expect(fromDb).toEqual(fromCore)
    expect(fromDb.length).toBeGreaterThan(0)
    expect(fromDb).not.toContain('6090')
  })
})
