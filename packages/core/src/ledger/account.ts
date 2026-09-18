import type { Brand } from '@berelax/shared'
import { AppError } from '@berelax/shared'
import type { Fils, Money } from '../money.ts'
import { filsFrom } from '../money.ts'

/**
 * The account model behind the double-entry journal (ADR 0017).
 *
 * Four classifications are carried on every account and **none of them has a default**:
 *
 *   - `type` and `normalBalance`, because the sign of a balance is not derivable from the type alone:
 *     accumulated depreciation is an asset that sits on the credit side and owner's drawings is
 *     equity that sits on the debit side. A rule of "asset implies debit" is right for most accounts
 *     and produces a balance sheet with the wrong sign for the rest — an error that still reconciles
 *     to zero while misstating the figure a reader cares about.
 *   - `vatBox`, nullable but explicit, because a missing tag and an untaxed account are different
 *     facts. `undefined` would mean "nobody decided", and an account nobody classified silently drops
 *     out of the VAT201 working papers.
 *   - `inputVatRecoverable`, because blocked input VAT (entertainment, docs/04 section 4) must be
 *     excluded from recovery by classification rather than by the preparer remembering.
 *
 * Nothing here reads a clock or performs I/O. An account is data; the classification decisions are
 * the whole content of the module.
 */

/** A chart-of-accounts code, e.g. `'1030'`. Stable, and what the journal stores. */
export type AccountCode = Brand<string, 'AccountCode'>

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense'

/** The side on which the account carries a positive balance. */
export type NormalBalance = 'debit' | 'credit'

/**
 * The VAT201 grouping an account feeds.
 *
 * [UNVERIFIED] The box numbering must be confirmed with a tax agent (docs/04 section 4); these are
 * names for the groupings, not a claim about the form's current layout. What the tag guarantees is
 * that every account states which grouping it belongs to, or states that it belongs to none.
 */
export type VatBox =
  | 'standard_rated_supplies'
  | 'zero_rated_supplies'
  | 'exempt_supplies'
  | 'reverse_charge'
  | 'output_tax'
  | 'recoverable_input_tax'
  | 'blocked_input_tax'

export interface Account {
  readonly code: AccountCode
  readonly name: string
  readonly type: AccountType
  readonly normalBalance: NormalBalance
  /**
   * True for a contra account: one that lives under a type but carries the opposite normal balance,
   * such as accumulated depreciation or sales discounts. Stated rather than inferred, so that
   * `expectedNormalBalance` can be asserted against every account in the chart.
   */
  readonly contra: boolean
  /** `null` means "feeds no VAT201 grouping", decided. It never means "not yet classified". */
  readonly vatBox: VatBox | null
  readonly inputVatRecoverable: boolean
}

/** Raised when an account is under-specified or internally inconsistent. */
export class MalformedAccount extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('validation', message, details === undefined ? undefined : { details })
    this.name = 'MalformedAccount'
  }
}

/** Raised when an entry references a code the chart does not contain. */
export class UnknownAccount extends AppError {
  readonly code: string
  constructor(code: string, chartId: string) {
    super('not_found', `Account "${code}" is not in chart "${chartId}"`, {
      details: { code, chartId },
    })
    this.name = 'UnknownAccount'
    this.code = code
  }
}

export function accountCode(value: string): AccountCode {
  if (!/^[0-9]{4}$/.test(value)) {
    throw new MalformedAccount(`Account code must be four digits, received "${value}"`, { value })
  }
  return value as AccountCode
}

/**
 * Every field an account must state. The test that enumerates the chart iterates this list, so
 * adding a classification here makes an unclassified account a test failure rather than a silent
 * `undefined` that survives as far as the VAT return.
 */
export const ACCOUNT_FIELDS = [
  'code',
  'name',
  'type',
  'normalBalance',
  'contra',
  'vatBox',
  'inputVatRecoverable',
] as const

export type AccountField = (typeof ACCOUNT_FIELDS)[number]

/**
 * Names the fields a candidate has not stated.
 *
 * `null` counts as stated and `undefined` does not, which is the distinction the "nullable but
 * explicit" rule rests on: `vatBox: null` is a decision, an absent `vatBox` is an omission, and
 * reading the property back cannot tell them apart without `Object.hasOwn`.
 */
export function missingAccountFields(candidate: object): readonly AccountField[] {
  const record = candidate as Record<string, unknown>
  return ACCOUNT_FIELDS.filter(
    (field) => !Object.hasOwn(candidate, field) || record[field] === undefined,
  )
}

const TYPES: readonly AccountType[] = ['asset', 'liability', 'equity', 'revenue', 'expense']

const VAT_BOXES: readonly VatBox[] = [
  'standard_rated_supplies',
  'zero_rated_supplies',
  'exempt_supplies',
  'reverse_charge',
  'output_tax',
  'recoverable_input_tax',
  'blocked_input_tax',
]

/** The side an account of this type carries a positive balance on, ignoring contra accounts. */
export function naturalBalance(type: AccountType): NormalBalance {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit'
}

/** The normal balance an account of this type and contra flag must declare. */
export function expectedNormalBalance(type: AccountType, contra: boolean): NormalBalance {
  const natural = naturalBalance(type)
  if (!contra) return natural
  return natural === 'debit' ? 'credit' : 'debit'
}

/**
 * Validates a candidate account and returns it frozen.
 *
 * Runtime validation exists alongside the type because the chart crosses a boundary: M-TILL-02 seeds
 * these same accounts into Postgres and compares them back, and a row read from a database is
 * `unknown` however well typed the literal that produced it was.
 */
export function defineAccount(candidate: Account): Account {
  const missing = missingAccountFields(candidate)
  if (missing.length > 0) {
    throw new MalformedAccount(
      `Account "${String((candidate as { code?: unknown }).code ?? '?')}" leaves ` +
        `${missing.join(', ')} unset. No classification on an account has a default.`,
      { missing },
    )
  }
  if (!TYPES.includes(candidate.type)) {
    throw new MalformedAccount(`Account "${candidate.code}" has unknown type "${candidate.type}"`)
  }
  if (candidate.vatBox !== null && !VAT_BOXES.includes(candidate.vatBox)) {
    throw new MalformedAccount(
      `Account "${candidate.code}" has unknown vatBox "${candidate.vatBox}"`,
    )
  }
  const expected = expectedNormalBalance(candidate.type, candidate.contra)
  if (candidate.normalBalance !== expected) {
    throw new MalformedAccount(
      `Account "${candidate.code}" is ${candidate.contra ? 'a contra ' : 'an '}${candidate.type} ` +
        `so its normal balance must be ${expected}, not ${candidate.normalBalance}`,
    )
  }
  if (candidate.vatBox === 'blocked_input_tax' && candidate.inputVatRecoverable) {
    throw new MalformedAccount(
      `Account "${candidate.code}" is tagged blocked_input_tax and cannot be recoverable. ` +
        'Blocked input VAT (entertainment and similar) is excluded from recovery by ' +
        'classification, not by the preparer remembering.',
    )
  }
  if (candidate.name.trim().length === 0) {
    throw new MalformedAccount(`Account "${candidate.code}" has no name`)
  }
  return Object.freeze({ ...candidate })
}

/**
 * The account's balance expressed in its own normal-balance direction, so a normal balance is
 * positive and an abnormal one is negative.
 *
 * Keeping the raw debit-minus-credit instead is what produces a balance sheet showing a negative
 * gratuity liability, which reads as a receivable.
 */
export function signedBalanceFils(account: Account, debits: Fils, credits: Fils): Fils {
  const net = debits - credits
  return filsFrom(account.normalBalance === 'debit' ? net : -net)
}

export function signedBalance(account: Account, debits: Fils, credits: Fils): Money {
  return { fils: signedBalanceFils(account, debits, credits), currency: 'AED' }
}
