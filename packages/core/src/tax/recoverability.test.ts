import { describe, expect, it } from 'vitest'
import type { Account } from '../ledger/account.ts'
import { accountCode, defineAccount } from '../ledger/account.ts'
import {
  ACCOUNTS,
  accountFor,
  accountsOfType,
  STANDARD_SPA_CHART,
} from '../ledger/chart-of-accounts.ts'
import { BILL_TAX_TREATMENTS, carriesVat } from '../purchases/bill.ts'
import {
  assertEveryExpenseAccountClassified,
  BLOCKED_CATEGORIES_NOT_INCURRED,
  BLOCKED_INPUT_VAT_CATEGORIES,
  blockedCategoryFor,
  blockedInputVatAccounts,
  expenseAccountsMissingRecoverability,
  INPUT_VAT_RECOVERABILITIES,
  isBlockedCategory,
  recoverabilityOf,
  UnclassifiedExpenseAccounts,
  vatBearingTreatmentFor,
} from './recoverability.ts'

/**
 * M-VAT-02, the pure half: which input VAT may be reclaimed, and which the law blocks.
 *
 * The acceptance criterion this file is the whole of is the first one — *enumerate the chart and fail if
 * any expense account leaves the recovery classification unset*. Its database half (no column default,
 * and a known-bad INSERT refused) is `packages/db`'s and `scripts/test-gates.mjs`'s; what belongs here is
 * that the chart the application reasons about has no unclassified expense in it, and that the check
 * would say so if it did.
 */
const CHART = STANDARD_SPA_CHART

describe('every expense account states its input VAT recovery position', () => {
  it('finds nothing unclassified in the chart, and fails on an account that drops a classification', () => {
    expect(expenseAccountsMissingRecoverability(CHART)).toEqual([])
    expect(() => assertEveryExpenseAccountClassified(CHART)).not.toThrow()

    // The control, and it is the whole value of the assertion above: a chart carrying an expense account
    // whose classification was omitted is REPORTED, naming the account and the field. `undefined`
    // rather than `false`, because "nobody decided" and "decided: not recoverable" are different facts
    // and the second is a legitimate classification held by half the chart.
    const { inputVatRecoverable: _omitted, ...withoutTheField } = accountFor(CHART, ACCOUNTS.rent)
    const broken = {
      ...CHART,
      accounts: [...CHART.accounts, withoutTheField as Account],
    }
    expect(expenseAccountsMissingRecoverability(broken)).toEqual([
      { code: ACCOUNTS.rent as string, missing: ['inputVatRecoverable'] },
    ])
    expect(() => assertEveryExpenseAccountClassified(broken)).toThrow(UnclassifiedExpenseAccounts)
    expect(() => assertEveryExpenseAccountClassified(broken)).toThrow(
      /6010 \(inputVatRecoverable\)/,
    )

    // And an omitted `vatBox` is caught too, which is the one a database cannot police: a nullable
    // column cannot distinguish "feeds no VAT201 grouping, decided" from an INSERT that left it out.
    const { vatBox: _absent, ...withoutTheBox } = accountFor(CHART, ACCOUNTS.utilities)
    expect(
      expenseAccountsMissingRecoverability({
        ...CHART,
        accounts: [withoutTheBox as Account],
      }),
    ).toEqual([{ code: ACCOUNTS.utilities as string, missing: ['vatBox'] }])
  })

  it('classifies every account in the chart as exactly one of the three positions', () => {
    for (const account of CHART.accounts) {
      const recoverability = recoverabilityOf(account)
      expect(INPUT_VAT_RECOVERABILITIES, `${account.code}`).toContain(recoverability)
    }
    // All three positions are actually occupied. A classifier that answered 'out_of_scope' for
    // everything would satisfy the loop above and would put the whole purchase ledger outside box 9.
    const positions = new Set(CHART.accounts.map(recoverabilityOf))
    expect([...positions].sort()).toEqual(['blocked', 'out_of_scope', 'recoverable'])
  })

  it('reads the position off the two classifications the account states, in the only order they permit', () => {
    expect(recoverabilityOf(accountFor(CHART, ACCOUNTS.rent))).toBe('recoverable')
    expect(recoverabilityOf(accountFor(CHART, ACCOUNTS.entertainment))).toBe('blocked')
    // Bank charges on an exempt financial service: no recoverable input VAT arises at all, which is a
    // different fact from "blocked" and keeps them out of the disclosure line as well as out of box 9.
    expect(recoverabilityOf(accountFor(CHART, ACCOUNTS.bankCharges))).toBe('out_of_scope')
    expect(recoverabilityOf(accountFor(CHART, ACCOUNTS.licenceAndGovernmentFees))).toBe(
      'out_of_scope',
    )
    // The asset the claim is accumulated in is itself recoverable, which is why the classification is
    // not "expense accounts only".
    expect(recoverabilityOf(accountFor(CHART, ACCOUNTS.recoverableInputVat))).toBe('recoverable')

    // The pair that would make the order of the branches a guess is refused at construction, so the
    // derivation is total rather than a precedence decision this module makes.
    expect(() =>
      defineAccount({
        code: accountCode('6199'),
        name: 'Blocked and recoverable at once',
        type: 'expense',
        normalBalance: 'debit',
        contra: false,
        vatBox: 'blocked_input_tax',
        inputVatRecoverable: true,
      }),
    ).toThrow(/cannot be recoverable/)
  })
})

describe('the blocked categories are the ones this business incurs', () => {
  it('names every blocked account in the chart, with the documentation that put it there', () => {
    const blocked = blockedInputVatAccounts(CHART).map((account) => account.code as string)
    expect(blocked).toEqual([
      ACCOUNTS.staffAccommodation as string,
      ACCOUNTS.entertainment as string,
    ])

    // Every blocked account has a category entry, and every category entry points at a blocked account.
    // Both directions, because a category with no account is a rule nothing enforces and an account with
    // no category is a classification nobody can defend to a tax agent.
    expect(
      BLOCKED_INPUT_VAT_CATEGORIES.map((category) => category.account as string).sort(),
    ).toEqual([...blocked].sort())
    for (const category of BLOCKED_INPUT_VAT_CATEGORIES) {
      expect(isBlockedCategory(accountFor(CHART, category.account)), category.id).toBe(true)
      // Each one states where it comes from and what the business actually buys under it. A category
      // with no exposure does not belong in the chart at all, and "entertainment, and certain other
      // categories" is not a classification until it names them.
      expect(category.source, category.id).toMatch(/docs\/\d+/)
      expect(category.basis.length, category.id).toBeGreaterThan(40)
      expect(category.incurred.length, category.id).toBeGreaterThan(40)
    }
    expect(blockedCategoryFor(ACCOUNTS.entertainment)?.id).toBe('entertainment_and_hospitality')
    expect(blockedCategoryFor(ACCOUNTS.staffAccommodation)?.id).toBe(
      'employee_benefits_not_obliged',
    )
    // The control: an account that is not a blocked category has no entry, so the lookup is not a
    // function that answers "yes" for everything.
    expect(blockedCategoryFor(ACCOUNTS.rent)).toBeUndefined()
  })

  it('records the open question behind any classification the conservative reading decided', () => {
    for (const category of BLOCKED_INPUT_VAT_CATEGORIES) {
      // Both entries carry a conservative component, so both name the question. An id with no note, or
      // a note with no id, is half a marker — the shape that survives a review as "already answered",
      // which is the same argument chart_of_accounts_provisional_pair makes in SQL.
      expect(category.openQuestionId === null, category.id).toBe(category.conservativeNote === null)
      expect(category.openQuestionId, category.id).toBe('Y11-blocked-vat')
      expect(category.conservativeNote ?? '', category.id).toMatch(/conservative|over-claim/)
    }
  })

  it('does not invent a category the business has no exposure to', () => {
    // UAE VAT blocks recovery on a motor vehicle available for personal use. This business operates
    // none — outcall was dropped, which removed vehicle and mileage records — so there is no account and
    // no category. The entry exists so the absence reads as a decision, and this assertion is what keeps
    // it honest: the day somebody adds a vehicle account, this fails and the classification has to be
    // decided rather than inherited.
    expect(BLOCKED_CATEGORIES_NOT_INCURRED.map((entry) => entry.id)).toEqual([
      'motor_vehicle_available_for_personal_use',
    ])
    for (const entry of BLOCKED_CATEGORIES_NOT_INCURRED) {
      expect(entry.absentFromChart.length, entry.id).toBeGreaterThan(0)
      for (const word of entry.absentFromChart) {
        const matching = CHART.accounts.filter((account) =>
          account.name.toLowerCase().includes(word),
        )
        expect(
          matching.map((account) => account.code as string),
          word,
        ).toEqual([])
      }
    }
    // The control: the same scan DOES find the accounts the categories that ARE incurred point at, so a
    // search that matched nothing would not pass the loop above by accident.
    expect(
      CHART.accounts.filter((account) => account.name.toLowerCase().includes('entertainment'))
        .length,
    ).toBe(1)
  })
})

describe('the treatment a VAT-bearing line must carry follows from its account', () => {
  it('answers blocked for a blocked category and standard for a recoverable one', () => {
    expect(vatBearingTreatmentFor(accountFor(CHART, ACCOUNTS.entertainment))).toBe(
      'blocked_not_recoverable',
    )
    expect(vatBearingTreatmentFor(accountFor(CHART, ACCOUNTS.staffAccommodation))).toBe(
      'blocked_not_recoverable',
    )
    expect(vatBearingTreatmentFor(accountFor(CHART, ACCOUNTS.rent))).toBe('standard_recoverable')
    // Whatever it answers is a treatment that carries VAT and one the schema accepts — the two facts
    // that make it usable as the bridge between the chart and `bill_line.tax_treatment`.
    for (const account of accountsOfType(CHART, 'expense')) {
      if (recoverabilityOf(account) === 'out_of_scope') continue
      const treatment = vatBearingTreatmentFor(account)
      expect(BILL_TAX_TREATMENTS, `${account.code}`).toContain(treatment)
      expect(carriesVat(treatment), `${account.code}`).toBe(true)
    }
  })

  it('refuses to name a treatment for an account that carries no recoverable input VAT', () => {
    // A government fee coded with VAT on it is a mis-coded line, and returning `standard_recoverable`
    // here would claim tax on an account the chart says carries none.
    expect(() =>
      vatBearingTreatmentFor(accountFor(CHART, ACCOUNTS.licenceAndGovernmentFees)),
    ).toThrow(/out of scope for input VAT/)
    expect(() => vatBearingTreatmentFor(accountFor(CHART, ACCOUNTS.therapistWages))).toThrow(
      /Code the line to the account/,
    )
  })
})
