import { describe, expect, it } from 'vitest'
import type { Account, AccountCode, AccountField } from './account.ts'
import {
  ACCOUNT_FIELDS,
  accountCode,
  expectedNormalBalance,
  missingAccountFields,
  UnknownAccount,
} from './account.ts'
import {
  ACCOUNTS,
  accountFor,
  accountsOfType,
  chartCodes,
  findAccount,
  recoverableInputVatAccounts,
  STANDARD_SPA_CHART,
} from './chart-of-accounts.ts'

const CHART = STANDARD_SPA_CHART

describe('every account is fully classified — no defaults permitted', () => {
  it('leaves no field unset on any account in the chart', () => {
    // The acceptance criterion in full: enumerate the chart, and fail if a single account leaves
    // type, normalBalance, vatBox (nullable but explicit) or inputVatRecoverable unset. An account
    // that reached the journal unclassified drops silently out of the VAT201 working papers, and
    // nothing downstream notices — the entries still balance.
    const unclassified = CHART.accounts
      .map((account) => ({ code: account.code, missing: missingAccountFields(account) }))
      .filter((row) => row.missing.length > 0)

    expect(unclassified).toEqual([])
  })

  it('states vatBox on every account, as null or as a box, never as absent', () => {
    for (const account of CHART.accounts) {
      expect(Object.hasOwn(account, 'vatBox'), `${account.code}`).toBe(true)
    }
  })

  it('detects the omission it is meant to detect', () => {
    // The control. Without it, the enumeration above passes on an empty chart, on a chart of
    // objects that all happen to be complete, and on a `missingAccountFields` that always returns
    // an empty array — which is what a check that has never been seen to fail is worth.
    for (const field of ACCOUNT_FIELDS) {
      const first = CHART.accounts[0]
      expect(first).toBeDefined()
      const damaged: Record<string, unknown> = { ...(first as Account) }
      delete damaged[field]
      expect(missingAccountFields(damaged), field).toEqual([field as AccountField])
    }
  })

  it('checks a chart with accounts in it, so the enumeration is not vacuous', () => {
    expect(CHART.accounts.length).toBeGreaterThan(40)
  })
})

describe('the accounts P-HR and Y-PAY will need already exist', () => {
  // Asserted by name, one line each, because the point of this test is that deleting any of these
  // fails here rather than in a unit that is three months away. A chart of accounts lands in an
  // append-only journal: adding a code later is easy, renumbering one means restating history.
  const required: readonly [string, AccountCode, string][] = [
    ['gratuity liability', ACCOUNTS.gratuityLiability, 'End-of-service gratuity liability'],
    ['commission expense', ACCOUNTS.commissionExpense, 'Staff commission expense'],
    ['tips payable', ACCOUNTS.tipsPayable, 'Tips payable to therapists'],
    ['cash over and short', ACCOUNTS.cashOverShort, 'Cash over and short'],
    ['package deferred revenue', ACCOUNTS.packageDeferredRevenue, 'Deferred revenue — packages'],
    ['gateway clearing', ACCOUNTS.gatewayClearing, 'Payment gateway clearing'],
  ]

  it.each(required)('%s is in the chart', (_label, code, name) => {
    const account = accountFor(CHART, code)
    expect(account.name).toBe(name)
  })

  it('classifies each of them the way the unit that needs it expects', () => {
    expect(accountFor(CHART, ACCOUNTS.gratuityLiability).type).toBe('liability')
    expect(accountFor(CHART, ACCOUNTS.commissionExpense).type).toBe('expense')
    // A tip is collected on behalf of a therapist. Booked as revenue it would inflate both the VAT
    // base and the commission base.
    expect(accountFor(CHART, ACCOUNTS.tipsPayable).type).toBe('liability')
    expect(accountFor(CHART, ACCOUNTS.tipsPayable).vatBox).toBeNull()
    expect(accountFor(CHART, ACCOUNTS.cashOverShort).type).toBe('expense')
    expect(accountFor(CHART, ACCOUNTS.packageDeferredRevenue).type).toBe('liability')
    expect(accountFor(CHART, ACCOUNTS.gatewayClearing).type).toBe('asset')
  })
})

describe('internal consistency', () => {
  it('declares a normal balance consistent with type and contra flag', () => {
    for (const account of CHART.accounts) {
      expect(account.normalBalance, `${account.code} ${account.name}`).toBe(
        expectedNormalBalance(account.type, account.contra),
      )
    }
  })

  it('actually contains contra accounts, so the rule above is not trivially satisfied', () => {
    // Without a contra account anywhere, "normalBalance matches expectedNormalBalance" reduces to
    // "asset implies debit" and would pass against a chart that had dropped the flag entirely.
    const contra = CHART.accounts.filter((a) => a.contra)
    expect(contra.map((a) => a.code as string)).toEqual(['1110', '3020', '4095'])
    for (const account of contra) {
      expect(account.normalBalance).not.toBe(expectedNormalBalance(account.type, false))
    }
  })

  it('has unique codes', () => {
    const codes = chartCodes(CHART).map((c) => c as string)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('numbers each account in the block its type belongs to', () => {
    const block: Record<string, string> = {
      asset: '1',
      liability: '2',
      equity: '3',
      revenue: '4',
    }
    for (const account of CHART.accounts) {
      const first = (account.code as string).slice(0, 1)
      const expected = block[account.type] ?? first
      if (account.type === 'expense') {
        expect(['5', '6'], `${account.code}`).toContain(first)
      } else {
        expect(first, `${account.code} ${account.name}`).toBe(expected)
      }
    }
  })

  it('never tags a supply box on anything but revenue', () => {
    for (const account of CHART.accounts) {
      if (account.vatBox === 'standard_rated_supplies') {
        expect(account.type, `${account.code}`).toBe('revenue')
      }
    }
  })

  it('treats blocked input VAT as blocked', () => {
    const blocked = CHART.accounts.filter((a) => a.vatBox === 'blocked_input_tax')
    // Entertainment is the case docs/04 section 4 names, and it must exist for the rule to mean
    // anything.
    expect(blocked.map((a) => a.code as string)).toEqual([ACCOUNTS.entertainment as string])
    for (const account of blocked) expect(account.inputVatRecoverable).toBe(false)
  })

  it('marks recoverable input VAT only on expenses and on the input VAT asset itself', () => {
    const recoverable = recoverableInputVatAccounts(CHART)
    expect(recoverable.length).toBeGreaterThan(5)
    for (const account of recoverable) {
      const isTheAssetItself = account.code === ACCOUNTS.recoverableInputVat
      expect(isTheAssetItself || account.type === 'expense', `${account.code}`).toBe(true)
      expect(account.vatBox, `${account.code}`).not.toBeNull()
    }
  })

  it('separates bank charges from merchant acquiring fees', () => {
    // Both are "the bank took money". Only one of them carries recoverable input VAT, and merging
    // them makes box 9 a figure somebody adjusts by hand every quarter.
    expect(accountFor(CHART, ACCOUNTS.bankCharges).inputVatRecoverable).toBe(false)
    expect(accountFor(CHART, ACCOUNTS.paymentProcessingFees).inputVatRecoverable).toBe(true)
  })

  it('gives imported services their own reverse-charge classification', () => {
    expect(accountFor(CHART, ACCOUNTS.importedServices).vatBox).toBe('reverse_charge')
    expect(accountFor(CHART, ACCOUNTS.reverseChargeVatPayable).vatBox).toBe('reverse_charge')
  })
})

describe('lookup', () => {
  it('finds an account by code', () => {
    expect(findAccount(CHART, ACCOUNTS.cashInDrawer)?.name).toBe('Cash in drawer')
  })

  it('returns undefined rather than guessing', () => {
    expect(findAccount(CHART, accountCode('9999'))).toBeUndefined()
  })

  it('throws UnknownAccount from accountFor, naming the chart', () => {
    expect(() => accountFor(CHART, accountCode('9999'))).toThrow(UnknownAccount)
    expect(() => accountFor(CHART, accountCode('9999'))).toThrow(/standard-spa-uae/)
  })

  it('returns the same answer on a second call, so the cached index is not stale', () => {
    // The index is memoised per chart object. A cache that returned a different answer the second
    // time would be worse than no cache.
    expect(findAccount(CHART, ACCOUNTS.rent)).toBe(findAccount(CHART, ACCOUNTS.rent))
  })

  it('groups by type', () => {
    const revenue = accountsOfType(CHART, 'revenue')
    expect(revenue.length).toBeGreaterThan(3)
    for (const account of revenue) expect(account.type).toBe('revenue')
    const total = (['asset', 'liability', 'equity', 'revenue', 'expense'] as const)
      .map((type) => accountsOfType(CHART, type).length)
      .reduce((a, b) => a + b, 0)
    expect(total).toBe(CHART.accounts.length)
  })
})

describe('provisional status', () => {
  it('names the open question it stands in for', () => {
    // Y8-coa is unanswered. The chart must say so rather than presenting itself as the business's
    // real chart of accounts, which is the difference between a placeholder and a silent assumption.
    expect(CHART.provisional?.openQuestionId).toBe('Y8-coa')
    expect(CHART.provisional?.note.length).toBeGreaterThan(20)
  })
})
