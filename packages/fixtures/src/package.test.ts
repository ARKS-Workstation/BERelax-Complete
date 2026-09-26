import { SETTINGS } from '@berelax/config'
import {
  can,
  entryId,
  filsFrom,
  localDate,
  MalformedPackage,
  money,
  ROLES,
  type Role,
  type TenderLine,
} from '@berelax/core'
import { describe, expect, it } from 'vitest'
import {
  assertPackageSaleMappingReconciles,
  packageSaleMapping,
  reconcilePackageSaleMapping,
} from './package.ts'

/**
 * The F09 settings registry against the F07 permission matrix.
 *
 * `packages/config` may not import `packages/core` — the registry declares `editableBy` as plain strings
 * for exactly that reason — so nothing else in the build can check that the roles a compliance-locked
 * setting names are the roles the matrix actually trusts with a locked change. `packages/fixtures` is the
 * package allowed to depend on both, and this is the check that was missing when M-TILL-09 widened the
 * tier from "the owner" to "the owner, and the accountant for accounting policy".
 *
 * Without it, `editableBy: ['marketer']` on a compliance-locked setting would be caught by nothing: the
 * registry's own guard is an allow-list it defines itself, and the matrix would go on saying the marketer
 * may not make a locked change while the settings writer let them.
 */
const LOCKED_PERMISSIONS = [
  'settings:write_compliance',
  'settings:write_accounting_policy',
] as const

/**
 * Is this string a role the F07 matrix declares?
 *
 * `editableBy` is `readonly string[]` because `packages/config` cannot import the `Role` union. So a
 * setting naming `'acountant'` would be a setting nobody may edit and nothing would say so — which makes
 * this narrowing an assertion in its own right rather than a cast to get past the compiler.
 */
const isKnownRole = (role: string): role is Role => (ROLES as readonly string[]).includes(role)

describe('the settings registry and the permission matrix agree about the locked tier', () => {
  it('every role a compliance-locked setting names holds a locked-change permission', () => {
    const locked = SETTINGS.filter((setting) => setting.tier === 'compliance_locked')
    // The control: an empty filter would make every assertion below pass vacuously.
    expect(locked.length).toBeGreaterThanOrEqual(5)
    for (const setting of locked) {
      for (const role of setting.editableBy) {
        expect(
          isKnownRole(role),
          `${setting.key} grants "${role}", which the F07 matrix does not declare as a role`,
        ).toBe(true)
        if (!isKnownRole(role)) continue
        const holds = LOCKED_PERMISSIONS.some((permission) => can(role, permission))
        expect(
          holds,
          `${setting.key} grants "${role}", which holds no locked-change permission`,
        ).toBe(true)
      }
    }
  })

  it('every role that holds a locked-change permission is named by some locked setting', () => {
    // The other direction, which is what catches a permission granted to a role the registry never uses:
    // a lock nobody can turn is a lock somebody will work around.
    const holders = ROLES.filter((role) =>
      LOCKED_PERMISSIONS.some((permission) => can(role, permission)),
    )
    const named = new Set(
      SETTINGS.filter((setting) => setting.tier === 'compliance_locked').flatMap((setting) => [
        ...setting.editableBy,
      ]),
    )
    expect([...holders].sort()).toEqual(['accountant', 'owner'])
    for (const role of holders) expect([...named], role).toContain(role)
  })

  it('the manager holds the operational lock and neither locked one', () => {
    expect(can('manager', 'settings:write')).toBe(true)
    expect(can('manager', 'settings:write_compliance')).toBe(false)
    expect(can('manager', 'settings:write_accounting_policy')).toBe(false)
    // And no compliance-locked setting names them, which is the registry half of the same claim.
    const managerLocked = SETTINGS.filter(
      (setting) => setting.tier === 'compliance_locked' && setting.editableBy.includes('manager'),
    )
    expect(managerLocked.map((setting) => setting.key)).toEqual([])
  })

  it('the three package-policy settings are all provisional and all name Y9-package-policy', () => {
    const keys = [
      'packages.default_validity_months',
      'packages.default_transferable',
      'packages.unredeemed_balance_policy',
    ]
    for (const key of keys) {
      const setting = SETTINGS.find((candidate) => candidate.key === key)
      expect(setting, key).toBeDefined()
      expect(setting?.provisional?.openQuestionId, key).toBe('Y9-package-policy')
      expect(setting?.audited, key).toBe(true)
    }
    // Each note is its OWN: the validity note used to state all three terms, which read as one answered
    // question and made the other two invisible on the panel.
    const notes = keys.map(
      (key) => SETTINGS.find((candidate) => candidate.key === key)?.provisional?.note ?? '',
    )
    expect(new Set(notes).size).toBe(3)
  })
})

/**
 * The mapping, tested WITHOUT a database.
 *
 * `packageSaleMapping` and `reconcilePackageSaleMapping` are pure — they turn a template version and a set
 * of tenders into the two structural mirrors `sellPackage` takes, and decide nothing that needs a row. So
 * they belong in the unit suite: `packages/fixtures/src/package.itest.ts` proves the mirrors are shapes
 * PostgreSQL accepts, which is a different claim and the only one that needs a database.
 */
describe('packageSaleMapping — the structural mirrors, with no database', () => {
  const VARIANT_A = '11111111-1111-1111-1111-111111111111'
  const VARIANT_B = '22222222-2222-2222-2222-222222222222'
  const CUSTOMER = '33333333-3333-3333-3333-333333333333'
  const VERSION = '44444444-4444-4444-4444-444444444444'
  const DAY = localDate('2026-09-26')

  const build = (options: { price: number; tenders?: readonly TenderLine[] }) =>
    packageSaleMapping({
      entryId: entryId('PKG-MAP-1'),
      tradingDate: DAY,
      customerId: CUSTOMER,
      templateVersionId: VERSION,
      priceGross: money(filsFrom(options.price)),
      lines: [
        { lineNo: 1, serviceVariantId: VARIANT_A, sessionCount: 5, listGrossFils: 100_000 },
        { lineNo: 2, serviceVariantId: VARIANT_B, sessionCount: 3, listGrossFils: 90_000 },
      ],
      tenders: options.tenders ?? [{ kind: 'cash', amount: money(filsFrom(options.price)) }],
      validityMonths: 6,
      transferable: false,
      unredeemedBalancePolicy: 'retained',
      packageLabel: 'Mapped course',
    })

  it('maps the entry, the balances and the tenders field for field', () => {
    const mapping = assertPackageSaleMappingReconciles(build({ price: 150_000 }))
    expect(mapping.input.journal.source).toBe('package_sale')
    expect(mapping.input.journal.entryDate).toBe('2026-09-26')
    expect(mapping.input.tradingDate).toBe('2026-09-26')
    expect(mapping.input.journal.lines.map((line) => line.accountCode)).toEqual(['1010', '2050'])
    expect(mapping.input.sessionCount).toBe(8)
    // The hand-computed allocation: 150,000 weighted 100,000 : 90,000 is 78,947 and 71,053, the odd fils
    // going to the larger remainder.
    expect(mapping.input.balances).toEqual([
      { lineNo: 1, serviceVariantId: VARIANT_A, sessionsTotal: 5, valueFils: 78_947 },
      { lineNo: 2, serviceVariantId: VARIANT_B, sessionsTotal: 3, valueFils: 71_053 },
    ])
    expect(mapping.input.tenders).toEqual([
      { tenderKind: 'cash', postingAccountCode: '1010', amountFils: 150_000 },
    ])
  })

  it('carries a tender reference through and leaves it off a tender that has none', () => {
    const mapping = build({
      price: 100_000,
      tenders: [
        { kind: 'cash', amount: money(filsFrom(40_000)) },
        { kind: 'card_in_salon', amount: money(filsFrom(60_000)), reference: 'AUTH-4242' },
      ],
    })
    expect(mapping.input.tenders).toEqual([
      { tenderKind: 'cash', postingAccountCode: '1010', amountFils: 40_000 },
      {
        tenderKind: 'card_in_salon',
        postingAccountCode: '1040',
        amountFils: 60_000,
        reference: 'AUTH-4242',
      },
    ])
    // Absent rather than blank: an empty string reads as a reference that was not captured.
    expect('reference' in (mapping.input.tenders[0] ?? {})).toBe(false)
  })

  it('reports both revenue measurements, and both are zero', () => {
    const r = reconcilePackageSaleMapping(build({ price: 123_457 }))
    expect(r.imbalanceFils).toBe(0)
    expect(r.deferredRevenueFils).toBe(123_457)
    expect(r.revenueMovementByCodeFils).toBe(0)
    expect(r.revenueMovementByTypeFils).toBe(0)
    expect(r.outputVatMovementFils).toBe(0)
    expect(r.allocatedFils).toBe(123_457)
    expect(r.tenderedFils).toBe(123_457)
    expect(r.deferredRevenueCodeAgrees).toBe(true)
  })

  it('the assertion fires for each identity it claims to check', () => {
    // Known-bad fixtures for the guard itself (ADR 0003). Each one breaks ONE identity, and the message
    // has to name that one — a guard that reported the same sentence for all five would be a guard whose
    // claim is not what it measures.
    const good = build({ price: 200_000 })
    const withoutLiability = {
      ...good,
      input: {
        ...good.input,
        journal: {
          ...good.input.journal,
          lines: good.input.journal.lines.filter((line) => line.accountCode !== '2050'),
        },
      },
    }
    expect(() => assertPackageSaleMappingReconciles(withoutLiability)).toThrow(
      /2050 is credited 0 fils/,
    )
    const withRevenue = {
      ...good,
      input: {
        ...good.input,
        journal: {
          ...good.input.journal,
          lines: [
            ...good.input.journal.lines,
            { accountCode: '4010', debitFils: 0, creditFils: 1_000, memo: null },
            { accountCode: '4095', debitFils: 1_000, creditFils: 0, memo: null },
          ],
        },
      },
    }
    // The self-cancelling contra pair: the entry still BALANCES and its net revenue movement is zero.
    expect(reconcilePackageSaleMapping(withRevenue).imbalanceFils).toBe(0)
    expect(() => assertPackageSaleMappingReconciles(withRevenue)).toThrow(
      /2000 fils moved on a 4xxx revenue code/,
    )
    const shortBalances = {
      ...good,
      input: {
        ...good.input,
        balances: good.input.balances.slice(0, 1),
      },
    }
    expect(() => assertPackageSaleMappingReconciles(shortBalances)).toThrow(
      /the balances are worth/,
    )
    const shortTenders = {
      ...good,
      input: { ...good.input, tenders: [] },
    }
    expect(() => assertPackageSaleMappingReconciles(shortTenders)).toThrow(
      /the tenders come to 0 fils/,
    )
    const withVat = {
      ...good,
      input: {
        ...good.input,
        journal: {
          ...good.input.journal,
          lines: [
            ...good.input.journal.lines,
            { accountCode: '2030', debitFils: 0, creditFils: 500, memo: null },
          ],
        },
      },
    }
    expect(() => assertPackageSaleMappingReconciles(withVat)).toThrow(
      /500 fils moved on 2030 Output VAT payable/,
    )
    // The control: the unbroken mapping passes, so the five refusals are about the breakage.
    expect(() => assertPackageSaleMappingReconciles(good)).not.toThrow()
  })

  it('refuses a line the rule returned no share for', () => {
    // Reachable only if `packageSalePosting` ever stops returning one balance per line. Asserted because
    // the mapping pairs by POSITION, and a silent drop would put one line's money on another line's
    // entitlement while both still summed to the price.
    expect(() =>
      packageSaleMapping({
        entryId: entryId('PKG-MAP-EMPTY'),
        tradingDate: DAY,
        customerId: CUSTOMER,
        templateVersionId: VERSION,
        priceGross: money(filsFrom(10_000)),
        lines: [],
        tenders: [{ kind: 'cash', amount: money(filsFrom(10_000)) }],
        validityMonths: 6,
        transferable: false,
        unredeemedBalancePolicy: 'retained',
        packageLabel: 'Empty',
      }),
    ).toThrow(MalformedPackage)
  })
})
