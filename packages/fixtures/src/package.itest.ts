import {
  ACCOUNTS,
  allocateByWeight,
  can,
  entryId,
  filsFrom,
  localDate,
  money,
  PACKAGE_DEFERRED_REVENUE_ACCOUNT,
  ROLES,
  type TenderLine,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  currentPackageTemplateVersion,
  DEFERRED_REVENUE_ACCOUNT_CODE,
  PACKAGE_SQLSTATE,
  readPackageSale,
  type Sql,
  savePackageTemplateVersion,
  sellPackage,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  assertPackageSaleMappingReconciles,
  PackageSaleMappingMismatch,
  packageSaleMapping,
  reconcilePackageSaleMapping,
} from './package.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * The PAIR: `@berelax/core`'s package-sale rule against the rows `@berelax/db` writes.
 *
 * `packages/db` may never import `packages/core`, so each half is exercised against a structural mirror
 * of the other and neither half's own suite can see the mapping between them. This file is where both can
 * be imported at once, and it is the only place three things can be compared:
 *
 *   1. core's `ACCOUNTS.packageDeferredRevenue`, db's `DEFERRED_REVENUE_ACCOUNT_CODE`, and ZG005's
 *      literal `'2050'` in SQL — three statements of one account code, two of which no import can reach
 *      from the third;
 *   2. core's largest-remainder allocation against `package_balance.value_fils` and against ZG006, which
 *      re-adds the shares in SQL at COMMIT;
 *   3. the F07 permission matrix (`packages/core`) against the F09 settings registry
 *      (`packages/config`) — see `package.test.ts` beside this file, which needs no database.
 *
 * The business days are in 2098-06, which no other suite posts into: `credit-note.itest.ts` uses
 * 2097–2098 but only its own dates, so the month is stated here and the days are inserted with
 * `on conflict do nothing`.
 */

const ACTOR: Actor = {
  kind: 'staff',
  id: '77777777-7777-7777-7777-777777777777',
  label: 'Till (pair)',
}

const DAY = '2098-06-11'
let sql: Sql
let customerId: string
let variants: readonly { id: string; grossPriceFils: number }[]

const RUN = Date.now().toString(36)
let nonce = 0

beforeAll(async () => {
  sql = createConnection({ url, max: 6 })
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (
      ${DAY}::date,
      (${DAY}::date + time '11:00') at time zone 'Asia/Dubai',
      (${DAY}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
      'weekly'
    )
    on conflict (trading_date) do nothing
  `
  const [buyer] = await sql<{ id: string }[]>`select id from customer order by id limit 1`
  if (buyer === undefined) throw new Error('run `pnpm seed` before the integration suite')
  customerId = buyer.id
  const rows = await sql<{ id: string; grossPriceFils: string }[]>`
    select v.id, v.gross_price_fils as "grossPriceFils"
      from service_variant v join service s on s.id = v.service_id
     where s.archived_at is null
     order by v.gross_price_fils desc, v.id limit 3
  `
  if (rows.length < 3) throw new Error('the seed creates 32 priced variants; run `pnpm seed`')
  variants = rows.map((row) => ({ id: row.id, grossPriceFils: Number(row.grossPriceFils) }))
})

afterAll(async () => {
  await sql?.unsafe(
    // `package_redemption` and `payment` are NAMED because 0083 made both reference this family, and
    // PostgreSQL refuses a TRUNCATE while a referencing table is missing from the statement — a package
    // sale now writes a `payment` row (0083 §6) and a redemption hangs off a balance.
    'truncate package_redemption, payment, package_balance, package_sale, package_template_line, ' +
      'package_template_version, package_template',
  )
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql.unsafe(
    // `package_redemption` and `payment` are NAMED because 0083 made both reference this family, and
    // PostgreSQL refuses a TRUNCATE while a referencing table is missing from the statement — a package
    // sale now writes a `payment` row (0083 §6) and a redemption hangs off a balance.
    'truncate package_redemption, payment, package_balance, package_sale, package_template_line, ' +
      'package_template_version, package_template',
  )
  nonce += 1
})

const cash = (fils: number): TenderLine => ({ kind: 'cash', amount: money(filsFrom(fils)) })

/** Saves a three-line version and returns it as the mapping wants it. */
const saveThreeLineVersion = async (priceFils: number) => {
  const key = `mtill09_pair_${nonce}`
  const saved = await withUnitOfWork(sql, ACTOR, (uow) =>
    savePackageTemplateVersion(uow, {
      templateKey: key,
      internalName: 'Pair course',
      publicDisplayName: 'Pair course',
      priceFils,
      lines: [
        { serviceVariantId: variants[0]?.id ?? '', sessionCount: 5 },
        { serviceVariantId: variants[1]?.id ?? '', sessionCount: 3 },
        { serviceVariantId: variants[2]?.id ?? '', sessionCount: 1 },
      ],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }),
  )
  const version = await currentPackageTemplateVersion(sql, key)
  if (version === null) throw new Error('the version just saved cannot be read back')
  return { saved, version }
}

describe('the package-sale pair', () => {
  it('maps core’s posting and allocation onto rows PostgreSQL accepts', async () => {
    // A discounted three-line package: the list total is more than the price, so the allocation has a
    // remainder to distribute and the per-line shares are not the list values.
    const { saved, version } = await saveThreeLineVersion(333_337)
    const listTotal = version.lines.reduce((running, line) => running + line.listGrossFils, 0)
    expect(listTotal).toBeGreaterThan(333_337)

    const mapping = assertPackageSaleMappingReconciles(
      packageSaleMapping({
        entryId: entryId(`je-mtill09-pair-${RUN}-${nonce}`),
        tradingDate: localDate(DAY),
        customerId,
        templateVersionId: saved.versionId,
        priceGross: money(filsFrom(333_337)),
        lines: version.lines.map((line) => ({
          lineNo: line.lineNo,
          serviceVariantId: line.serviceVariantId,
          sessionCount: line.sessionCount,
          listGrossFils: line.listGrossFils,
        })),
        tenders: [cash(333_337)],
        validityMonths: version.validityMonths,
        transferable: version.transferable,
        unredeemedBalancePolicy: version.unredeemedBalancePolicy,
        packageLabel: version.internalName,
      }),
    )

    const sold = await withUnitOfWork(sql, ACTOR, (uow) => sellPackage(uow, mapping.input))
    const read = await readPackageSale(sql, sold.saleId)
    expect(read).not.toBeNull()

    // Core's shares, on the rows. ZG006 re-added them in SQL at COMMIT, so this equality is asserted
    // twice by two different mechanisms — the second one being the only reason the insert succeeded.
    const expectedShares = allocateByWeight(
      money(filsFrom(333_337)),
      version.lines.map((line) => line.listGrossFils),
    ).map((share) => share.fils)
    expect(read?.balances.map((balance) => balance.valueFils)).toEqual(expectedShares)
    expect(expectedShares.reduce((a, b) => a + b, 0)).toBe(333_337)
    // The control: the shares are NOT simply the list values, so the equality above is about the
    // allocation rather than about a pass-through.
    expect(expectedShares).not.toEqual(version.lines.map((line) => line.listGrossFils))

    // The liability, off the journal rows, and the third statement of the account code: ZG005 accepted
    // this sale by summing `account_code = '2050'` in SQL, which no import here can reach.
    const [row] = await sql<{ credit: string }[]>`
      select coalesce(sum(credit_fils - debit_fils), 0)::text as credit
        from journal_line
       where entry_id = ${sold.entryId} and account_code = ${DEFERRED_REVENUE_ACCOUNT_CODE}
    `
    expect(Number(row?.credit)).toBe(333_337)
    expect(DEFERRED_REVENUE_ACCOUNT_CODE).toBe(PACKAGE_DEFERRED_REVENUE_ACCOUNT as string)
    expect(DEFERRED_REVENUE_ACCOUNT_CODE).toBe(ACCOUNTS.packageDeferredRevenue as string)

    const reconciliation = reconcilePackageSaleMapping(mapping)
    expect(reconciliation.revenueMovementByCodeFils).toBe(0)
    expect(reconciliation.revenueMovementByTypeFils).toBe(0)
    expect(reconciliation.outputVatMovementFils).toBe(0)
    expect(reconciliation.deferredRevenueCodeAgrees).toBe(true)
  })

  it('the mapping refuses a line set the rule did not return a share for', async () => {
    const { saved, version } = await saveThreeLineVersion(200_000)
    // One line dropped on the way in. The rule allocates across what it is GIVEN, so this produces two
    // shares for a version with three lines — which ZG006 would refuse at COMMIT, naming a count. The
    // mapping refuses it earlier, naming the line.
    const mapping = () =>
      packageSaleMapping({
        entryId: entryId(`je-mtill09-pair-drop-${RUN}-${nonce}`),
        tradingDate: localDate(DAY),
        customerId,
        templateVersionId: saved.versionId,
        priceGross: money(filsFrom(200_000)),
        lines: version.lines.slice(0, 2).map((line) => ({
          lineNo: line.lineNo,
          serviceVariantId: line.serviceVariantId,
          sessionCount: line.sessionCount,
          listGrossFils: line.listGrossFils,
        })),
        tenders: [cash(200_000)],
        validityMonths: version.validityMonths,
        transferable: version.transferable,
        unredeemedBalancePolicy: version.unredeemedBalancePolicy,
        packageLabel: version.internalName,
      })
    // The mapping itself is consistent — two lines, two shares — so it does NOT throw. What it produces
    // is a sale whose session count disagrees with the version, and the database is what refuses it.
    const built = mapping()
    expect(built.input.balances).toHaveLength(2)
    const caught = await withUnitOfWork(sql, ACTOR, (uow) => sellPackage(uow, built.input)).catch(
      (err: unknown) => err,
    )
    expect((caught as { code?: string }).code).toBe(PACKAGE_SQLSTATE.allocationDisagrees)
    expect(String((caught as Error).message)).toMatch(/opened 2 balance\(s\) and the version/)
  })

  it('the reconciliation would CATCH a mapping that dropped the liability line', async () => {
    const { saved, version } = await saveThreeLineVersion(120_000)
    const good = packageSaleMapping({
      entryId: entryId(`je-mtill09-pair-guard-${RUN}-${nonce}`),
      tradingDate: localDate(DAY),
      customerId,
      templateVersionId: saved.versionId,
      priceGross: money(filsFrom(120_000)),
      lines: version.lines.map((line) => ({
        lineNo: line.lineNo,
        serviceVariantId: line.serviceVariantId,
        sessionCount: line.sessionCount,
        listGrossFils: line.listGrossFils,
      })),
      tenders: [cash(120_000)],
      validityMonths: version.validityMonths,
      transferable: version.transferable,
      unredeemedBalancePolicy: version.unredeemedBalancePolicy,
      packageLabel: version.internalName,
    })
    expect(() => assertPackageSaleMappingReconciles(good)).not.toThrow()

    // The known-bad fixture for the reconciliation (ADR 0003): the `2050` line removed from the mapped
    // entry. Gate 103 showed that a mapping which silently omits a posting is invisible to both halves'
    // own suites, so the guard that would see it has to be seen to fire.
    const crippled = {
      ...good,
      input: {
        ...good.input,
        journal: {
          ...good.input.journal,
          lines: good.input.journal.lines.filter(
            (line) => line.accountCode !== DEFERRED_REVENUE_ACCOUNT_CODE,
          ),
        },
      },
    }
    expect(() => assertPackageSaleMappingReconciles(crippled)).toThrow(PackageSaleMappingMismatch)
    expect(() => assertPackageSaleMappingReconciles(crippled)).toThrow(/2050 is credited 0 fils/)
  })

  it('the accountant, and only the accountant besides the owner, holds the accounting-policy lock', () => {
    // The F07 half of the settings claim. `packages/config` cannot import `packages/core`, so the matrix
    // and the registry can only be compared from here; the registry half is in `package.test.ts`.
    const allowed = ROLES.filter((role) => can(role, 'settings:write_accounting_policy'))
    expect([...allowed].sort()).toEqual(['accountant', 'owner'])
    // And the customer-safety lock has NOT been widened: it is still the owner alone.
    const compliance = ROLES.filter((role) => can(role, 'settings:write_compliance'))
    expect([...compliance]).toEqual(['owner'])
    expect(can('manager', 'settings:write_accounting_policy')).toBe(false)
  })
})
