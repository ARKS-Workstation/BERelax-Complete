import { describe, expect, it } from 'vitest'
import { filsFrom } from '../money.ts'
import type { Account, AccountType, NormalBalance } from './account.ts'
import {
  ACCOUNT_FIELDS,
  accountCode,
  defineAccount,
  expectedNormalBalance,
  MalformedAccount,
  missingAccountFields,
  naturalBalance,
  signedBalance,
  signedBalanceFils,
  UnknownAccount,
} from './account.ts'

const CASH: Account = {
  code: accountCode('1010'),
  name: 'Cash in drawer',
  type: 'asset',
  normalBalance: 'debit',
  contra: false,
  vatBox: null,
  inputVatRecoverable: false,
}

describe('accountCode', () => {
  it('accepts a four-digit code', () => {
    expect(accountCode('6140') as string).toBe('6140')
  })

  it.each(['614', '61400', '61a0', '', ' 6140'])('rejects "%s"', (bad) => {
    expect(() => accountCode(bad)).toThrow(MalformedAccount)
  })
})

describe('missingAccountFields', () => {
  it('reports nothing for a fully specified account', () => {
    expect(missingAccountFields(CASH)).toEqual([])
  })

  it('distinguishes an explicit null from an omission', () => {
    // The entire "nullable but explicit" rule rests on this. `vatBox: null` is a decision that the
    // account feeds no VAT201 grouping; an absent `vatBox` is nobody having looked. Reading the
    // property back gives `undefined` in both cases, which is why the check uses Object.hasOwn.
    const explicitNull = { ...CASH, vatBox: null }
    const omitted: Record<string, unknown> = { ...CASH }
    delete omitted['vatBox']

    expect(missingAccountFields(explicitNull)).toEqual([])
    expect(missingAccountFields(omitted)).toEqual(['vatBox'])
  })

  it('reports an undefined value as unset, not as stated', () => {
    expect(missingAccountFields({ ...CASH, inputVatRecoverable: undefined })).toEqual([
      'inputVatRecoverable',
    ])
  })

  it('names every required field when the candidate is empty', () => {
    expect(missingAccountFields({})).toEqual([...ACCOUNT_FIELDS])
  })
})

describe('normal balance', () => {
  const naturally: readonly [AccountType, NormalBalance][] = [
    ['asset', 'debit'],
    ['expense', 'debit'],
    ['liability', 'credit'],
    ['equity', 'credit'],
    ['revenue', 'credit'],
  ]

  it.each(naturally)('%s carries a %s balance naturally', (type, side) => {
    expect(naturalBalance(type)).toBe(side)
  })

  it.each(naturally)('a contra %s carries the opposite of %s', (type, side) => {
    expect(expectedNormalBalance(type, false)).toBe(side)
    expect(expectedNormalBalance(type, true)).not.toBe(side)
  })
})

describe('defineAccount', () => {
  it('returns a frozen account when everything is stated', () => {
    const account = defineAccount(CASH)
    expect(Object.isFrozen(account)).toBe(true)
    expect(account.code as string).toBe('1010')
  })

  it('refuses an account that leaves a classification unset', () => {
    const omitted = { ...CASH } as Record<string, unknown>
    delete omitted['vatBox']
    expect(() => defineAccount(omitted as unknown as Account)).toThrow(MalformedAccount)
    expect(() => defineAccount(omitted as unknown as Account)).toThrow(/vatBox unset/)
  })

  it('names the account in the message even when the code itself is missing', () => {
    expect(() => defineAccount({} as Account)).toThrow(/Account "\?"/)
  })

  it('refuses a normal balance that contradicts the type', () => {
    // The wrong-sign balance sheet. An asset booked as a credit-normal account still reconciles to
    // zero across the journal and reports the opposite of the truth for that one line.
    expect(() => defineAccount({ ...CASH, normalBalance: 'credit' })).toThrow(
      /normal balance must be debit/,
    )
  })

  it('accepts the same contradiction once the account declares itself contra', () => {
    const accumulated = defineAccount({
      ...CASH,
      code: accountCode('1110'),
      name: 'Accumulated depreciation',
      normalBalance: 'credit',
      contra: true,
    })
    expect(accumulated.normalBalance).toBe('credit')
  })

  it('refuses blocked input VAT that claims to be recoverable', () => {
    expect(() =>
      defineAccount({
        ...CASH,
        code: accountCode('6090'),
        type: 'expense',
        name: 'Entertainment',
        vatBox: 'blocked_input_tax',
        inputVatRecoverable: true,
      }),
    ).toThrow(/cannot be recoverable/)
  })

  it('refuses an unknown type or an unknown VAT box', () => {
    expect(() => defineAccount({ ...CASH, type: 'wealth' as AccountType })).toThrow(/unknown type/)
    expect(() => defineAccount({ ...CASH, vatBox: 'box_seventeen' as Account['vatBox'] })).toThrow(
      /unknown vatBox/,
    )
  })

  it('refuses a nameless account', () => {
    expect(() => defineAccount({ ...CASH, name: '   ' })).toThrow(/has no name/)
  })
})

describe('signedBalance', () => {
  it('reports a debit-normal account positive when debits exceed credits', () => {
    expect(signedBalanceFils(CASH, filsFrom(50_000), filsFrom(20_000))).toBe(30_000)
  })

  it('reports a credit-normal account positive when credits exceed debits', () => {
    // The defect this prevents: a gratuity liability shown as a negative number reads as an asset.
    const gratuity = defineAccount({
      ...CASH,
      code: accountCode('2070'),
      name: 'End-of-service gratuity liability',
      type: 'liability',
      normalBalance: 'credit',
    })
    expect(signedBalanceFils(gratuity, filsFrom(0), filsFrom(90_000))).toBe(90_000)
    // The control: taking the raw debit-minus-credit would give -90000 here, and the sign is the
    // whole point of the function.
    expect(signedBalanceFils(gratuity, filsFrom(0), filsFrom(90_000))).not.toBe(-90_000)
  })

  it('carries the currency through', () => {
    expect(signedBalance(CASH, filsFrom(1_000), filsFrom(0))).toEqual({
      fils: 1_000,
      currency: 'AED',
    })
  })
})

describe('UnknownAccount', () => {
  it('names the code and the chart it was looked for in', () => {
    const error = new UnknownAccount('9999', 'standard-spa-uae')
    expect(error.kind).toBe('not_found')
    expect(error.code).toBe('9999')
    expect(error.message).toContain('9999')
    expect(error.message).toContain('standard-spa-uae')
  })
})
