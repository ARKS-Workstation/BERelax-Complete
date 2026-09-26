import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Actor } from '../audit.ts'
import { createConnection, type Sql } from '../connection.ts'
import type { JournalEntryInput } from '../repositories/journal.ts'
import { accountTotals } from '../repositories/journal.ts'
import {
  PACKAGE_TRANSFERABLE_SETTING_KEY,
  PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
  PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
} from '../settings/package.ts'
import {
  unconfirmedAssumptionRows,
  unconfirmedAssumptions,
  writeSetting,
} from '../settings-store.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  ArchivedServiceReferenced,
  currentPackageTemplateVersion,
  isDuplicatePackageLine,
  PACKAGE_SQLSTATE,
  PackageTemplateUnavailable,
  packageError,
  readPackageSale,
  type SavePackageTemplateVersionInput,
  type SellPackageInput,
  savePackageTemplateVersion,
  sellPackage,
} from './sell-package.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * Versioned package templates and the package sale, against a real PostgreSQL.
 *
 * Almost everything `0078_package.sql` adds is a DATABASE rule — six per-row immutability triggers, one
 * per-row archived-service trigger, four DEFERRED constraint triggers, a generated expiry column and a
 * narrowed grant list — and a rule is only a rule once something has been seen to bounce off it (ADR
 * 0003). So every refusal below is asserted by its SQLSTATE, and every refusal has an ACCEPTED control
 * beside it, so a renamed column cannot make the whole file pass by refusing everything.
 *
 * `packages/db` may not import `packages/core`, so every posting below is written out with its arithmetic
 * in a comment and every account code as a literal. The PAIR — `packageSalePosting` and
 * `allocateByWeight` in core against these rows — is `packages/fixtures/src/package.itest.ts`, the one
 * package allowed to depend on both. The multi-line ALLOCATION therefore lives there and not here: a
 * largest-remainder split reimplemented in this file to check the split would be a check comparing an
 * algorithm to a copy of itself.
 *
 * ## Isolation
 *
 * `package_sale`, `package_template_version` and `package_template_line` refuse DELETE for every role
 * including the owner, which is the whole point of the unit — so TRUNCATE as the owner is the only way to
 * clear them (0072's arrangement for `credit_note`, and the migration revokes TRUNCATE from
 * `berelax_app` precisely so this stays a thing only a test or a migration can do). Every referencing
 * table is NAMED rather than reached with CASCADE, so the NEXT table to reference `package_sale` fails
 * loudly here instead of having its rows removed by a statement that never mentioned it.
 *
 * `journal_entry` is truncated by nobody, so every assertion about an account BALANCE below is a DELTA or
 * is restricted to this test's own entry ids. The business days are in 2092, which no other suite and no
 * gate uses, and entry ids carry a per-run prefix because an id built from a counter alone collides with
 * the previous run's.
 *
 * ## Nothing here leaves `app_setting`, `service` or `audit_event` changed
 *
 * The three settings cases and the archived-service case both need a mutation that must not survive: a
 * confirmed setting disappears from the Unconfirmed Assumptions panel that four other suites read, and an
 * archived seeded service would make `business-seed.itest.ts` (8 services) and the availability suites
 * fail on a row this file changed. Both run inside a transaction that is ROLLED BACK by letting the error
 * out, or by throwing a sentinel — which is also the only honest way to assert an `audit_event` delta
 * without deleting from an append-only table (brief rule 9).
 */

const ACTOR: Actor = {
  kind: 'staff',
  id: '55555555-5555-5555-5555-555555555555',
  label: 'Front desk',
}
const ACCOUNTANT: Actor = {
  kind: 'staff',
  id: '66666666-6666-6666-6666-666666666666',
  label: 'Accountant',
}

const CASH = '1010'
const CARD = '1040'
const DEFERRED_REVENUE = '2050'
const TREATMENT_REVENUE = '4010'
const OUTPUT_VAT = '2030'
const DISCOUNTS = '4095'

/** 2092 is used by no other suite and no gate. */
const DAY = '2092-04-06'
const DAY_TWO = '2092-04-07'
const WINDOW_FROM = '2092-01-01'
const WINDOW_TO = '2092-12-31'
const DAYS = [DAY, DAY_TWO] as const

let sql: Sql
let customerId: string
/** Two seeded variants with different prices, so a two-line package has a real weighting. */
let variantA: { id: string; grossPriceFils: number }
let variantB: { id: string; grossPriceFils: number }
/** A seeded service to archive inside a rolled-back transaction. */
let archivableServiceId: string
let archivableVariantId: string

const RUN = Date.now().toString(36)
let nonce = 0
const entryIdFor = (label: string) => `je-mtill09-${label}-${RUN}-${nonce}`
const keyFor = (label: string) => `mtill09_${label}_${nonce}`

/** A sentinel thrown to roll a transaction back after its assertions have run. */
const ROLLBACK = 'mtill09-rollback-sentinel'

beforeAll(async () => {
  sql = createConnection({ url, max: 8 })
  // `package_sale.trading_date` is a foreign key into `business_day` (0011), a TABLE, so the days have to
  // exist. 11:00 to 02:00 the next calendar morning, which is what makes `crosses_midnight` true.
  for (const day of DAYS) {
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (
        ${day}::date,
        (${day}::date + time '11:00') at time zone 'Asia/Dubai',
        (${day}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
        'weekly'
      )
      on conflict (trading_date) do nothing
    `
  }
  const [buyer] = await sql<{ id: string }[]>`select id from customer order by id limit 1`
  if (buyer === undefined) {
    throw new Error('the seed creates customers; run `pnpm seed` before the integration suite')
  }
  customerId = buyer.id

  const variants = await sql<{ id: string; serviceId: string; grossPriceFils: string }[]>`
    select v.id, v.service_id as "serviceId", v.gross_price_fils as "grossPriceFils"
      from service_variant v
      join service s on s.id = v.service_id
     where s.archived_at is null
     order by v.gross_price_fils desc, v.id
     limit 3
  `
  const [first, second, third] = variants
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error('the seed creates 32 priced variants; run `pnpm seed`')
  }
  variantA = { id: first.id, grossPriceFils: Number(first.grossPriceFils) }
  variantB = { id: second.id, grossPriceFils: Number(second.grossPriceFils) }
  archivableServiceId = third.serviceId
  archivableVariantId = third.id
})

afterAll(async () => {
  await sql?.unsafe(
    'truncate package_balance, package_sale, package_template_line, package_template_version, ' +
      'package_template',
  )
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql.unsafe(
    'truncate package_balance, package_sale, package_template_line, package_template_version, ' +
      'package_template',
  )
  nonce += 1
})

// --- helpers -----------------------------------------------------------------------------------

const saveVersion = (input: SavePackageTemplateVersionInput) =>
  withUnitOfWork(sql, ACTOR, (uow) => savePackageTemplateVersion(uow, input))

/**
 * The journal entry for a package sale, written out rather than built by a rule.
 *
 * `Dr` the tender accounts at what was handed over, `Cr 2050` the whole gross. That is the entire
 * posting under Y11-vat-package's provisional answer: no revenue line and no VAT line, because the
 * supply has not happened yet.
 */
const deferredRevenueEntry = (
  entryId: string,
  day: string,
  tenders: readonly { account: string; fils: number }[],
): JournalEntryInput => {
  const gross = tenders.reduce((running, tender) => running + tender.fils, 0)
  return {
    entryId,
    entryDate: day,
    narrative: 'Package sale (itest)',
    source: 'package_sale',
    lines: [
      ...tenders.map((tender) => ({
        accountCode: tender.account,
        debitFils: tender.fils,
        creditFils: 0,
      })),
      { accountCode: DEFERRED_REVENUE, debitFils: 0, creditFils: gross },
    ],
  }
}

interface SoldOptions {
  readonly templateVersionId: string
  readonly priceFils: number
  readonly sessionCount: number
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  readonly balances: readonly {
    lineNo: number
    serviceVariantId: string
    sessionsTotal: number
    valueFils: number
  }[]
  readonly day?: string
  readonly label?: string
  readonly tenders?: readonly { account: string; fils: number }[]
}

const sellOne = async (options: SoldOptions) => {
  const day = options.day ?? DAY
  const entryId = entryIdFor(options.label ?? `sale-${options.templateVersionId.slice(0, 8)}`)
  const tenders = options.tenders ?? [{ account: CASH, fils: options.priceFils }]
  const input: SellPackageInput = {
    customerId,
    templateVersionId: options.templateVersionId,
    tradingDate: day,
    priceFils: options.priceFils,
    sessionCount: options.sessionCount,
    validityMonths: options.validityMonths,
    transferable: options.transferable,
    unredeemedBalancePolicy: options.unredeemedBalancePolicy,
    journal: deferredRevenueEntry(entryId, day, tenders),
    balances: options.balances,
    tenders: tenders.map((tender) => ({
      tenderKind: tender.account === CASH ? 'cash' : 'card_in_salon',
      postingAccountCode: tender.account,
      amountFils: tender.fils,
      ...(tender.account === CASH ? {} : { reference: 'AUTH-000123' }),
    })),
  }
  return withUnitOfWork(sql, ACTOR, (uow) => sellPackage(uow, input))
}

/** Movement on one account, restricted to a set of entry ids, so no other suite's rows are counted. */
const movementOn = async (account: string, entryIds: readonly string[]) => {
  const [row] = await sql<{ debit: string; credit: string }[]>`
    select coalesce(sum(debit_fils), 0)::text as debit,
           coalesce(sum(credit_fils), 0)::text as credit
      from journal_line
     where account_code = ${account} and entry_id = any(${[...entryIds]}::text[])
  `
  return { debitFils: Number(row?.debit ?? 0), creditFils: Number(row?.credit ?? 0) }
}

/** Total movement — debits PLUS credits — across every account the chart types as `revenue`. */
const revenueMovementOn = async (entryIds: readonly string[]) => {
  const [row] = await sql<{ movement: string }[]>`
    select coalesce(sum(l.debit_fils + l.credit_fils), 0)::text as movement
      from journal_line l
      join account a on a.code = l.account_code
     where a.type = 'revenue' and l.entry_id = any(${[...entryIds]}::text[])
  `
  return Number(row?.movement ?? 0)
}

const deferredBalanceInWindow = async () => {
  const totals = await accountTotals(sql, { from: WINDOW_FROM, to: WINDOW_TO })
  const row = totals.find((t) => t.accountCode === DEFERRED_REVENUE)
  return row === undefined ? 0 : row.creditFils - row.debitFils
}

/** A deterministic 32-bit LCG. Reproducible, so a failure is a failure and not a seed. */
const lcg = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

// --- template versions -------------------------------------------------------------------------

describe('a template is EDITED by inserting a version', () => {
  it('inserts version 1 then version 2, and both rows survive with their own terms', async () => {
    const key = keyFor('edit')
    const first = await saveVersion({
      templateKey: key,
      internalName: 'Course A',
      publicDisplayName: 'Course A',
      priceFils: 100_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 5 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    const second = await saveVersion({
      templateKey: key,
      internalName: 'Course A',
      publicDisplayName: 'Course A (revised)',
      priceFils: 120_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 6 }],
      terms: { validityMonths: 12, transferable: true, unredeemedBalancePolicy: 'forfeited' },
    })
    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(second.templateId).toBe(first.templateId)

    const rows = await sql<{ version: number; priceFils: string; validityMonths: number }[]>`
      select version, price_fils as "priceFils", validity_months as "validityMonths"
        from package_template_version where template_id = ${first.templateId}::uuid
       order by version
    `
    expect(rows.map((row) => [row.version, Number(row.priceFils), row.validityMonths])).toEqual([
      [1, 100_000, 6],
      [2, 120_000, 12],
    ])
    // `max(version)` is the one definition of current. There is no pointer column to disagree with it.
    const current = await currentPackageTemplateVersion(sql, key)
    expect(current?.version).toBe(2)
    expect(current?.priceFils).toBe(120_000)
  })

  it('refuses every UPDATE and DELETE of a version and of its lines, by SQLSTATE', async () => {
    const saved = await saveVersion({
      templateKey: keyFor('immutable'),
      internalName: 'Course B',
      publicDisplayName: 'Course B',
      priceFils: 50_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 2 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    for (const statement of [
      sql`update package_template_version set price_fils = 1 where id = ${saved.versionId}::uuid`,
      sql`delete from package_template_version where id = ${saved.versionId}::uuid`,
      sql`update package_template_line set session_count = 99
            where template_version_id = ${saved.versionId}::uuid`,
      sql`delete from package_template_line where template_version_id = ${saved.versionId}::uuid`,
    ]) {
      const err = await statement.catch((caught: unknown) => caught)
      expect((err as { code?: string }).code).toBe(PACKAGE_SQLSTATE.immutableRow)
      expect(packageError(err)?.kind).toBe('forbidden')
    }
    // The control: the row is still there and still says what it said, so the four refusals above are
    // about the statements rather than about a row that had already gone.
    const [row] = await sql<{ priceFils: string }[]>`
      select price_fils as "priceFils" from package_template_version
       where id = ${saved.versionId}::uuid
    `
    expect(Number(row?.priceFils)).toBe(50_000)
  })

  it('refuses a version with no lines — in the service, and at COMMIT by ZG004', async () => {
    await expect(
      saveVersion({
        templateKey: keyFor('empty'),
        internalName: 'Nothing',
        publicDisplayName: 'Nothing',
        priceFils: 10_000,
        lines: [],
        terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
      }),
    ).rejects.toThrow(/entitlement to nothing sold for money/)

    // And the database, past the service: a version inserted directly with no lines is refused at COMMIT.
    const direct = await withUnitOfWork(sql, ACTOR, async (uow) => {
      const [template] = await uow.sql<{ id: string }[]>`
        insert into package_template (template_key) values (${keyFor('empty_direct')}) returning id
      `
      await uow.sql`
        insert into package_template_version (
          template_id, version, internal_name, public_display_name, price_fils, validity_months,
          transferable, unredeemed_balance_policy, is_provisional
        ) values (${template?.id ?? null}::uuid, 1, 'Direct', 'Direct', 10000, 6, false,
                  'retained', false)
      `
      return 'inserted'
    }).catch((caught: unknown) => caught)
    expect((direct as { code?: string }).code).toBe(PACKAGE_SQLSTATE.versionHasNoLines)
    expect(packageError(direct)?.kind).toBe('invariant_violated')
  })
})

describe('an archived catalogue service may not be sold in a package', () => {
  it('is refused at save time with ArchivedServiceReferenced', async () => {
    // Inside a transaction that ROLLS BACK: archiving a seeded service permanently would break
    // `business-seed.itest.ts` (8 services) and every availability suite.
    const caught = await withUnitOfWork(sql, ACTOR, async (uow) => {
      await uow.sql`
        update service set published_at = null, archived_at = now()
         where id = ${archivableServiceId}::uuid
      `
      await savePackageTemplateVersion(uow, {
        templateKey: keyFor('archived'),
        internalName: 'Course C',
        publicDisplayName: 'Course C',
        priceFils: 30_000,
        lines: [
          { serviceVariantId: variantA.id, sessionCount: 1 },
          { serviceVariantId: archivableVariantId, sessionCount: 2 },
        ],
        terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
      })
      return 'saved'
    }).catch((err: unknown) => err)

    expect(caught).toBeInstanceOf(ArchivedServiceReferenced)
    const refusal = caught as ArchivedServiceReferenced
    // The line is NAMED, which is most of the diagnosis: "a service is archived" without it is a package
    // of six lines and somebody reading the catalogue.
    expect(refusal.lineNo).toBe(2)
    expect(refusal.serviceVariantId).toBe(archivableVariantId)
    // The SERVICE's own wording, and ZG003 deliberately shares no phrase with it. When the two layers say
    // the same thing, deleting the service check leaves this suite green with the database refusing
    // instead — M-TILL-11 measured exactly that, and the gate reported a pass over a check that had gone.
    expect(refusal.message).toMatch(/is not bookable/)

    // The service was rolled back with the transaction.
    const [service] = await sql<{ archivedAt: Date | null }[]>`
      select archived_at as "archivedAt" from service where id = ${archivableServiceId}::uuid
    `
    expect(service?.archivedAt).toBeNull()
  })

  it('is refused by the DATABASE too, past the service, with ZG003', async () => {
    const caught = await withUnitOfWork(sql, ACTOR, async (uow) => {
      await uow.sql`
        update service set published_at = null, archived_at = now()
         where id = ${archivableServiceId}::uuid
      `
      const [template] = await uow.sql<{ id: string }[]>`
        insert into package_template (template_key) values (${keyFor('zp003')}) returning id
      `
      const [version] = await uow.sql<{ id: string }[]>`
        insert into package_template_version (
          template_id, version, internal_name, public_display_name, price_fils, validity_months,
          transferable, unredeemed_balance_policy, is_provisional
        ) values (${template?.id ?? null}::uuid, 1, 'D', 'D', 10000, 6, false, 'retained', false)
        returning id
      `
      await uow.sql`
        insert into package_template_line (template_version_id, line_no, service_variant_id,
                                           session_count)
        values (${version?.id ?? null}::uuid, 1, ${archivableVariantId}::uuid, 1)
      `
      return 'inserted'
    }).catch((err: unknown) => err)

    expect((caught as { code?: string }).code).toBe(PACKAGE_SQLSTATE.archivedService)
    // The database's own wording, which the service does not use.
    expect(String((caught as Error).message)).toMatch(/availability solver will never offer/)
  })

  it('accepts a line on a live service, so the two refusals are about the archiving', async () => {
    const saved = await saveVersion({
      templateKey: keyFor('live'),
      internalName: 'Course E',
      publicDisplayName: 'Course E',
      priceFils: 30_000,
      lines: [
        { serviceVariantId: variantA.id, sessionCount: 1 },
        { serviceVariantId: archivableVariantId, sessionCount: 2 },
      ],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    expect(saved.version).toBe(1)
    expect(saved.sessionCount).toBe(3)
  })
})

// --- the sale ----------------------------------------------------------------------------------

describe('selling a package posts cash against a deferred-revenue liability', () => {
  it('debits cash and credits 2050 at gross, with zero to revenue and zero to output VAT', async () => {
    const saved = await saveVersion({
      templateKey: keyFor('sale'),
      internalName: 'Course F',
      publicDisplayName: 'Course F',
      priceFils: 150_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 5 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    const sold = await sellOne({
      templateVersionId: saved.versionId,
      priceFils: 150_000,
      sessionCount: 5,
      validityMonths: 6,
      transferable: false,
      unredeemedBalancePolicy: 'retained',
      balances: [
        { lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 5, valueFils: 150_000 },
      ],
    })

    const entries = [sold.entryId]
    expect(await movementOn(CASH, entries)).toEqual({ debitFils: 150_000, creditFils: 0 })
    expect(await movementOn(DEFERRED_REVENUE, entries)).toEqual({
      debitFils: 0,
      creditFils: 150_000,
    })
    // The acceptance line, asserted PER POSTING: nothing on any revenue account and nothing on 2030.
    // Measured as debits PLUS credits and not as the net, because an entry crediting 4010 and debiting
    // the contra 4095 by the same figure nets to zero and has recognised revenue on a package sale.
    expect(await revenueMovementOn(entries)).toBe(0)
    const vat = await movementOn(OUTPUT_VAT, entries)
    expect(vat.debitFils + vat.creditFils).toBe(0)

    // The expiry, generated: 2092-04-06 + 6 months.
    expect(sold.expiresOn).toBe('2092-10-06')
    const read = await readPackageSale(sql, sold.saleId)
    expect(read?.priceFils).toBe(150_000)
    expect(read?.balances).toEqual([
      {
        lineNo: 1,
        serviceVariantId: variantA.id,
        sessionsTotal: 5,
        sessionsRedeemed: 0,
        valueFils: 150_000,
        releasedFils: 0,
      },
    ])
  })

  it('refuses a posting that recognises revenue, with ZG005 at COMMIT', async () => {
    const saved = await saveVersion({
      templateKey: keyFor('zp005'),
      internalName: 'Course G',
      publicDisplayName: 'Course G',
      priceFils: 100_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 2 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    const entryId = entryIdFor('zp005-smuggled')
    const caught = await withUnitOfWork(sql, ACTOR, async (uow) => {
      // A balanced entry that credits 4010 for 7,000 and debits the contra 4095 for the same figure. Its
      // NET revenue movement is ZERO. This is the exact posting a weaker rule reports as clean.
      await uow.sql`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${entryId}, ${DAY}::date, 'Smuggled revenue', 'package_sale')
      `
      await uow.sql`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils) values
          (${entryId}, 1, ${CASH}, 100000, 0),
          (${entryId}, 2, ${DEFERRED_REVENUE}, 0, 100000),
          (${entryId}, 3, ${TREATMENT_REVENUE}, 0, 7000),
          (${entryId}, 4, ${DISCOUNTS}, 7000, 0)
      `
      await uow.sql`
        insert into package_sale (customer_id, template_version_id, trading_date, price_fils,
                                  session_count, validity_months, transferable,
                                  unredeemed_balance_policy, journal_entry_id)
        values (${customerId}::uuid, ${saved.versionId}::uuid, ${DAY}::date, 100000, 2, 6, false,
                'retained', ${entryId})
      `
      const [sale] = await uow.sql<{ id: string }[]>`
        select id from package_sale where journal_entry_id = ${entryId}
      `
      await uow.sql`
        insert into package_balance (package_sale_id, line_no, service_variant_id, sessions_total,
                                     value_fils)
        values (${sale?.id ?? null}::uuid, 1, ${variantA.id}::uuid, 2, 100000)
      `
      return 'inserted'
    }).catch((err: unknown) => err)

    expect((caught as { code?: string }).code).toBe(PACKAGE_SQLSTATE.postingNotDeferredRevenue)
    expect(String((caught as Error).message)).toMatch(/moves 14000 fils across revenue accounts/)
  })

  it('refuses output VAT on a sale, and an entry dated on another business day, with ZG005', async () => {
    const saved = await saveVersion({
      templateKey: keyFor('zp005b'),
      internalName: 'Course H',
      publicDisplayName: 'Course H',
      priceFils: 105_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 3 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })

    const withVat = await withUnitOfWork(sql, ACTOR, async (uow) => {
      const entryId = entryIdFor('zp005-vat')
      await uow.sql`
        insert into journal_entry (entry_id, entry_date, narrative, source)
        values (${entryId}, ${DAY}::date, 'VAT on a prepayment', 'package_sale')
      `
      // 105,000 gross split 100,000 net + 5,000 VAT — the posting the OTHER answer to Y11-vat-package
      // would make. Refused while the provisional answer stands, and the refusal names the question.
      await uow.sql`
        insert into journal_line (entry_id, line_no, account_code, debit_fils, credit_fils) values
          (${entryId}, 1, ${CASH}, 105000, 0),
          (${entryId}, 2, ${DEFERRED_REVENUE}, 0, 100000),
          (${entryId}, 3, ${OUTPUT_VAT}, 0, 5000)
      `
      await uow.sql`
        insert into package_sale (customer_id, template_version_id, trading_date, price_fils,
                                  session_count, validity_months, transferable,
                                  unredeemed_balance_policy, journal_entry_id)
        values (${customerId}::uuid, ${saved.versionId}::uuid, ${DAY}::date, 105000, 3, 6, false,
                'retained', ${entryId})
      `
      // The balance is opened correctly on purpose. Every DEFERRED trigger on `package_sale` fires at
      // the same COMMIT, and PostgreSQL fires triggers on one event in alphabetical order by NAME — so
      // `package_balance_shares_sum_to_the_price` (ZG006) answers first for a sale with no balances, and
      // a probe that left them out would report ZG006 while claiming to be about the VAT line.
      const [sale] = await uow.sql<{ id: string }[]>`
        select id from package_sale where journal_entry_id = ${entryId}
      `
      await uow.sql`
        insert into package_balance (package_sale_id, line_no, service_variant_id, sessions_total,
                                     value_fils)
        values (${sale?.id ?? null}::uuid, 1, ${variantA.id}::uuid, 3, 105000)
      `
      return 'inserted'
    }).catch((err: unknown) => err)
    expect((withVat as { code?: string }).code).toBe(PACKAGE_SQLSTATE.postingNotDeferredRevenue)
    // 2050 is credited 100,000 against a price of 105,000, so THAT is the first thing ZG005 finds. Both
    // halves of the wrong posting are named, which is why the assertion is on the deferred figure.
    expect(String((withVat as Error).message)).toMatch(/credits 2050 Deferred revenue by 100000/)

    // The entry dated on ANOTHER business day than the sale. Built by hand rather than through `sellOne`,
    // which derives both dates from one argument and therefore cannot express the disagreement — the
    // first version of this case did go through `sellOne` and was asserting that a consistent sale fails.
    const wrongDay = await withUnitOfWork(sql, ACTOR, (uow) =>
      sellPackage(uow, {
        customerId,
        templateVersionId: saved.versionId,
        tradingDate: DAY,
        priceFils: 105_000,
        sessionCount: 3,
        validityMonths: 6,
        transferable: false,
        unredeemedBalancePolicy: 'retained',
        journal: deferredRevenueEntry(entryIdFor('wrong-day'), DAY_TWO, [
          { account: CASH, fils: 105_000 },
        ]),
        balances: [
          { lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 3, valueFils: 105_000 },
        ],
        tenders: [{ tenderKind: 'cash', postingAccountCode: CASH, amountFils: 105_000 }],
      }),
    ).catch((err: unknown) => err)
    expect((wrongDay as { code?: string }).code).toBe(PACKAGE_SQLSTATE.postingNotDeferredRevenue)
    expect(String((wrongDay as Error).message)).toMatch(
      /is dated 2092-04-07 and the sale is on business day 2092-04-06/,
    )
  })

  it('refuses a snapshot that disagrees with the version, with ZG002', async () => {
    const saved = await saveVersion({
      templateKey: keyFor('zp002'),
      internalName: 'Course I',
      publicDisplayName: 'Course I',
      priceFils: 80_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 4 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    // Every one of the five snapshot columns, one at a time, so a trigger comparing only the price would
    // be caught. The price case ALSO has to keep the posting consistent, or ZG005 would answer first.
    // `sessionCount` carries its balance with it: ZG006 compares the balances' sessions against the
    // SNAPSHOT and ZG002 compares the snapshot against the VERSION's lines, and ZG006 fires first
    // (alphabetical trigger order on one event). Without the matching balance this case reported ZG006
    // while claiming to be about the version — the defect of a probe naming a rule it does not reach.
    const variations: readonly [string, Partial<SoldOptions>][] = [
      ['validityMonths', { validityMonths: 12 }],
      ['transferable', { transferable: true }],
      ['unredeemedBalancePolicy', { unredeemedBalancePolicy: 'forfeited' }],
      [
        'sessionCount',
        {
          sessionCount: 5,
          balances: [
            { lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 5, valueFils: 80_000 },
          ],
        },
      ],
    ]
    for (const [label, variation] of variations) {
      const caught = await sellOne({
        templateVersionId: saved.versionId,
        priceFils: 80_000,
        sessionCount: 4,
        validityMonths: 6,
        transferable: false,
        unredeemedBalancePolicy: 'retained',
        balances: [
          { lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 4, valueFils: 80_000 },
        ],
        label: `zp002-${label}`,
        ...variation,
      }).catch((err: unknown) => err)
      expect((caught as { code?: string }).code, label).toBe(PACKAGE_SQLSTATE.termsDisagree)
    }
    // The control: the matching snapshot IS accepted, so the four refusals are about the disagreement.
    const ok = await sellOne({
      templateVersionId: saved.versionId,
      priceFils: 80_000,
      sessionCount: 4,
      validityMonths: 6,
      transferable: false,
      unredeemedBalancePolicy: 'retained',
      balances: [{ lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 4, valueFils: 80_000 }],
      label: 'zp002-control',
    })
    expect(ok.priceFils).toBe(80_000)
  })

  it('refuses balances that do not sum to the price, or that miss a line, with ZG006', async () => {
    // A two-line version, with the shares hand-computed: 4 x variantA and 2 x variantB, sold at a
    // discount. The ALLOCATION is core's; what is asserted here is only that the database refuses a set
    // of shares that does not add up.
    const listA = variantA.grossPriceFils * 4
    const listB = variantB.grossPriceFils * 2
    const price = Math.floor((listA + listB) * 0.8)
    const saved = await saveVersion({
      templateKey: keyFor('zp006'),
      internalName: 'Course J',
      publicDisplayName: 'Course J',
      priceFils: price,
      lines: [
        { serviceVariantId: variantA.id, sessionCount: 4 },
        { serviceVariantId: variantB.id, sessionCount: 2 },
      ],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    const shareA = Math.floor((price * listA) / (listA + listB))
    const shareB = price - shareA

    const short = await sellOne({
      templateVersionId: saved.versionId,
      priceFils: price,
      sessionCount: 6,
      validityMonths: 6,
      transferable: false,
      unredeemedBalancePolicy: 'retained',
      balances: [
        { lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 4, valueFils: shareA },
        { lineNo: 2, serviceVariantId: variantB.id, sessionsTotal: 2, valueFils: shareB - 1 },
      ],
      label: 'zp006-short',
    }).catch((err: unknown) => err)
    expect((short as { code?: string }).code).toBe(PACKAGE_SQLSTATE.allocationDisagrees)
    expect(String((short as Error).message)).toMatch(/sum to the price exactly/)

    const missing = await sellOne({
      templateVersionId: saved.versionId,
      priceFils: price,
      sessionCount: 6,
      validityMonths: 6,
      transferable: false,
      unredeemedBalancePolicy: 'retained',
      balances: [{ lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 6, valueFils: price }],
      label: 'zp006-missing',
    }).catch((err: unknown) => err)
    expect((missing as { code?: string }).code).toBe(PACKAGE_SQLSTATE.allocationDisagrees)
    expect(String((missing as Error).message)).toMatch(/opened 1 balance\(s\)/)

    // The control: the exact shares ARE accepted, so both refusals are about the arithmetic.
    const ok = await sellOne({
      templateVersionId: saved.versionId,
      priceFils: price,
      sessionCount: 6,
      validityMonths: 6,
      transferable: false,
      unredeemedBalancePolicy: 'retained',
      balances: [
        { lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 4, valueFils: shareA },
        { lineNo: 2, serviceVariantId: variantB.id, sessionsTotal: 2, valueFils: shareB },
      ],
      label: 'zp006-control',
    })
    const read = await readPackageSale(sql, ok.saleId)
    expect(read?.balances.reduce((running, b) => running + b.valueFils, 0)).toBe(price)
  })

  it('refuses a sale whose journal entry is filed under another source', async () => {
    const saved = await saveVersion({
      templateKey: keyFor('source'),
      internalName: 'Course K',
      publicDisplayName: 'Course K',
      priceFils: 20_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 1 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    const entry = deferredRevenueEntry(entryIdFor('bad-source'), DAY, [
      { account: CASH, fils: 20_000 },
    ])
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        sellPackage(uow, {
          customerId,
          templateVersionId: saved.versionId,
          tradingDate: DAY,
          priceFils: 20_000,
          sessionCount: 1,
          validityMonths: 6,
          transferable: false,
          unredeemedBalancePolicy: 'retained',
          journal: { ...entry, source: 'sale' },
          balances: [
            { lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 1, valueFils: 20_000 },
          ],
          tenders: [{ tenderKind: 'cash', postingAccountCode: CASH, amountFils: 20_000 }],
        }),
      ),
    ).rejects.toThrow(/posts under "package_sale"/)
  })
})

describe('the deferred-revenue liability equals the cash taken, exact to the fils', () => {
  /**
   * N pseudo-random sales, with the identity checked PER POSTING and then in the aggregate.
   *
   * Every template here has ONE line, so `value_fils` is the price and ZG006 is satisfied without this
   * file reimplementing core's largest-remainder allocation — a split checked against a copy of itself is
   * a check that measures nothing. The multi-line allocation is asserted in core and in the pair.
   *
   * The aggregate is a DELTA over `accountTotals`, not a total: `journal_entry` is truncated by nobody, so
   * entries from an earlier test in the same run sit in the same 2092 window.
   *
   * 60_000 ms explicitly: 30 sales are about 200 statements against a real database and
   * `vitest.config.ts` declares no `testTimeout`, so the inherited 5,000 ms would be a performance budget
   * on a correctness test (brief rule 21).
   */
  it('after 30 random sales, 2050 equals the cash received and the sum of the prices', async () => {
    const random = lcg(20_260_926)
    const before = await deferredBalanceInWindow()
    const entryIds: string[] = []
    let tendered = 0
    let priced = 0
    let splitSales = 0

    for (let index = 0; index < 30; index += 1) {
      // Prices between 10.00 and 5,000.00, and deliberately not round: a figure ending in 00 would let a
      // fils-losing bug through on every case.
      const price = 1_000 + Math.floor(random() * 499_000) + (index % 7)
      const sessions = 1 + Math.floor(random() * 6)
      const saved = await saveVersion({
        templateKey: keyFor(`bulk_${index}`),
        internalName: `Course ${index}`,
        publicDisplayName: `Course ${index}`,
        priceFils: price,
        lines: [{ serviceVariantId: variantA.id, sessionCount: sessions }],
        terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
      })
      // A third of the sales are split across two tenders, so the debit side is a real merge rather than
      // one line every time. The split is deliberately uneven.
      const split = random() < 0.34 && price > 3
      const tenders = split
        ? [
            { account: CASH, fils: Math.floor(price / 3) },
            { account: CARD, fils: price - Math.floor(price / 3) },
          ]
        : [{ account: CASH, fils: price }]
      if (split) splitSales += 1

      const sold = await sellOne({
        templateVersionId: saved.versionId,
        priceFils: price,
        sessionCount: sessions,
        validityMonths: 6,
        transferable: false,
        unredeemedBalancePolicy: 'retained',
        balances: [
          { lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: sessions, valueFils: price },
        ],
        tenders,
        label: `bulk-${index}`,
      })
      entryIds.push(sold.entryId)
      tendered += tenders.reduce((running, tender) => running + tender.fils, 0)
      priced += price

      // PER POSTING, as the acceptance asks: this one entry moved nothing on revenue and nothing on 2030.
      expect(await revenueMovementOn([sold.entryId])).toBe(0)
      const vat = await movementOn(OUTPUT_VAT, [sold.entryId])
      expect(vat.debitFils + vat.creditFils).toBe(0)
    }

    // The control for the split arm: if every sale had used one tender, the merge would never have been
    // exercised and the cash/card totals below would be one account's.
    expect(
      splitSales,
      `only ${splitSales} of 30 sales were split across two tenders`,
    ).toBeGreaterThan(3)

    const deferred = await movementOn(DEFERRED_REVENUE, entryIds)
    const cash = await movementOn(CASH, entryIds)
    const card = await movementOn(CARD, entryIds)
    expect(deferred.creditFils - deferred.debitFils).toBe(priced)
    expect(cash.debitFils + card.debitFils).toBe(tendered)
    expect(tendered).toBe(priced)

    const [sales] = await sql<{ total: string }[]>`
      select coalesce(sum(price_fils), 0)::text as total from package_sale
    `
    expect(Number(sales?.total)).toBe(priced)

    // And through the aggregate reader, as a delta.
    expect((await deferredBalanceInWindow()) - before).toBe(priced)
    expect(await revenueMovementOn(entryIds)).toBe(0)
  }, 60_000)
})

describe('a sold balance never changes when the template is edited', () => {
  /**
   * The first acceptance line: a property over random interleavings of edits and sales.
   *
   * Eight pseudo-random plans from FIXED seeds, so a failure is reproducible and is a failure rather than
   * a seed. After every step, every sale made so far is re-read and its five snapshot columns are compared
   * against what they were at the moment of sale AND against the version row they point at — one query
   * for all of them, because a per-sale read would make this quadratic against a real database.
   *
   * Two arms are COUNTED (brief rule 22), because either being empty would make the property hold for a
   * system that cannot version at all: sales that were followed by at least one EDIT, and sales made
   * under a version later than 1. A plan whose edits all came before its sales exercises neither.
   *
   * 60_000 ms, for the reason the bulk case above gives.
   */
  it('holds over eight random interleavings of edits and sales', async () => {
    interface Recorded {
      saleId: string
      versionId: string
      version: number
      priceFils: number
      sessionCount: number
      validityMonths: number
      transferable: boolean
      policy: 'retained' | 'forfeited'
      editsAfter: number
    }
    let salesFollowedByAnEdit = 0
    let salesOnALaterVersion = 0
    let totalSales = 0

    for (const seed of [11, 101, 1_009, 7_919, 20_260_101, 31_337, 424_242, 999_983]) {
      await sql.unsafe(
        'truncate package_balance, package_sale, package_template_line, ' +
          'package_template_version, package_template',
      )
      const random = lcg(seed)
      const key = keyFor(`weave_${seed}`)
      const recorded: Recorded[] = []
      let current = await saveVersion({
        templateKey: key,
        internalName: 'Weave',
        publicDisplayName: 'Weave',
        priceFils: 40_000,
        lines: [{ serviceVariantId: variantA.id, sessionCount: 2 }],
        terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
      })

      for (let step = 0; step < 16; step += 1) {
        if (random() < 0.5) {
          // An EDIT. Every one of the five snapshot columns moves, so a sale that drifted onto the new
          // version would differ in all five rather than in whichever one this plan happened to change.
          const priceFils = 10_000 + Math.floor(random() * 300_000)
          const sessions = 1 + Math.floor(random() * 9)
          current = await saveVersion({
            templateKey: key,
            internalName: 'Weave',
            publicDisplayName: `Weave v${current.version + 1}`,
            priceFils,
            lines: [{ serviceVariantId: variantA.id, sessionCount: sessions }],
            terms: {
              validityMonths: 1 + Math.floor(random() * 59),
              transferable: random() < 0.5,
              unredeemedBalancePolicy: random() < 0.5 ? 'retained' : 'forfeited',
            },
          })
          for (const sale of recorded) sale.editsAfter += 1
        } else {
          // A SALE, at the terms the CURRENT version states.
          const sold = await sellOne({
            templateVersionId: current.versionId,
            priceFils: current.priceFils,
            sessionCount: current.sessionCount,
            validityMonths: current.validityMonths,
            transferable: current.transferable,
            unredeemedBalancePolicy: current.unredeemedBalancePolicy,
            balances: [
              {
                lineNo: 1,
                serviceVariantId: variantA.id,
                sessionsTotal: current.sessionCount,
                valueFils: current.priceFils,
              },
            ],
            label: `weave-${seed}-${step}`,
          })
          recorded.push({
            saleId: sold.saleId,
            versionId: current.versionId,
            version: current.version,
            priceFils: current.priceFils,
            sessionCount: current.sessionCount,
            validityMonths: current.validityMonths,
            transferable: current.transferable,
            policy: current.unredeemedBalancePolicy,
            editsAfter: 0,
          })
          totalSales += 1
          if (current.version > 1) salesOnALaterVersion += 1
        }

        // After EVERY step, not only at the end: a drift introduced by step 3 and undone by step 9 would
        // be invisible to a check that only ran last.
        const rows = await sql<
          {
            saleId: string
            versionId: string
            priceFils: string
            sessionCount: number
            validityMonths: number
            transferable: boolean
            policy: 'retained' | 'forfeited'
            vVersion: number
            vPriceFils: string
            vValidityMonths: number
            vTransferable: boolean
            vPolicy: 'retained' | 'forfeited'
            lineSessions: number
          }[]
        >`
          select s.id as "saleId", s.template_version_id as "versionId",
                 s.price_fils as "priceFils", s.session_count as "sessionCount",
                 s.validity_months as "validityMonths", s.transferable,
                 s.unredeemed_balance_policy as "policy",
                 v.version as "vVersion", v.price_fils as "vPriceFils",
                 v.validity_months as "vValidityMonths", v.transferable as "vTransferable",
                 v.unredeemed_balance_policy as "vPolicy",
                 (select coalesce(sum(l.session_count), 0) from package_template_line l
                   where l.template_version_id = v.id) as "lineSessions"
            from package_sale s
            join package_template_version v on v.id = s.template_version_id
        `
        const byId = new Map(rows.map((row) => [row.saleId, row]))
        expect(rows).toHaveLength(recorded.length)
        for (const sale of recorded) {
          const row = byId.get(sale.saleId)
          expect(row, `sale ${sale.saleId} disappeared at step ${step}`).toBeDefined()
          if (row === undefined) continue
          // The snapshot, unchanged.
          expect([
            row.versionId,
            Number(row.priceFils),
            row.sessionCount,
            row.validityMonths,
            row.transferable,
            row.policy,
          ]).toEqual([
            sale.versionId,
            sale.priceFils,
            sale.sessionCount,
            sale.validityMonths,
            sale.transferable,
            sale.policy,
          ])
          // And the VERSION it points at, unchanged — so this is not a snapshot that happens to agree
          // with a version somebody rewrote.
          expect([
            row.vVersion,
            Number(row.vPriceFils),
            row.vValidityMonths,
            row.vTransferable,
            row.vPolicy,
            Number(row.lineSessions),
          ]).toEqual([
            sale.version,
            sale.priceFils,
            sale.validityMonths,
            sale.transferable,
            sale.policy,
            sale.sessionCount,
          ])
        }
      }
      for (const sale of recorded) if (sale.editsAfter > 0) salesFollowedByAnEdit += 1
    }

    /**
     * The two arms, counted — and asserted EXACTLY rather than against a floor, because the seeds are
     * fixed and the counts are therefore a measurement rather than a distribution. Measured: 61 sales
     * across the eight plans, 55 of them followed by at least one edit, 52 of them made under a version
     * later than 1.
     *
     * Exact and not `toBeGreaterThan`, deliberately. A change to the plan generator — one more
     * `random()` call anywhere in the loop — shifts every subsequent draw, and a floor would absorb that
     * silently while the coverage claim in the comment above stopped being true. If these fail after a
     * refactor of the loop, re-measure and update the three numbers; do not widen them.
     */
    expect(totalSales, 'the eight plans no longer make 61 sales').toBe(61)
    expect(
      salesFollowedByAnEdit,
      `${salesFollowedByAnEdit} of ${totalSales} sales were followed by an edit, not 55. Without ` +
        'that arm the property cannot detect a sale drifting onto a newer version at all.',
    ).toBe(55)
    expect(
      salesOnALaterVersion,
      `${salesOnALaterVersion} of ${totalSales} sales were made under a version later than 1, not 52`,
    ).toBe(52)
  }, 60_000)
})

// --- the settings ------------------------------------------------------------------------------

describe('the three package-policy settings', () => {
  it('are provisional and appear in the Unconfirmed Assumptions query, naming Y9-package-policy', async () => {
    const listed = await unconfirmedAssumptions(sql)
    const mine = listed.filter((row) =>
      (
        [
          PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
          PACKAGE_TRANSFERABLE_SETTING_KEY,
          PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
        ] as readonly string[]
      ).includes(row.key),
    )
    expect(mine.map((row) => row.key).sort()).toEqual(
      [
        PACKAGE_TRANSFERABLE_SETTING_KEY,
        PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
        PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
      ].sort(),
    )
    for (const row of mine) expect(row.openQuestionId).toBe('Y9-package-policy')
    expect(mine.find((row) => row.key === PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY)?.tier).toBe(
      'compliance_locked',
    )

    // And in the panel's own reader, which is the one an admin screen calls.
    const rows = await unconfirmedAssumptionRows(sql)
    const references = rows
      .filter((row) => row.source === 'app_setting')
      .map((row) => row.reference)
    for (const key of [
      PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
      PACKAGE_TRANSFERABLE_SETTING_KEY,
      PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
    ]) {
      expect(references, key).toContain(key)
    }
    // The control: the panel is not simply listing every setting, so "it appears" means something.
    expect(references).not.toContain('theme.accent')
  })

  it('carry the provisional terms onto a version saved without explicit terms', async () => {
    const saved = await saveVersion({
      templateKey: keyFor('defaulted'),
      internalName: 'Course L',
      publicDisplayName: 'Course L',
      priceFils: 60_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 3 }],
    })
    // The strictest safe option on all three, taken from the settings rather than from a literal here.
    expect(saved.validityMonths).toBe(6)
    expect(saved.transferable).toBe(false)
    expect(saved.unredeemedBalancePolicy).toBe('retained')
    // And the version says WHY it holds them: the panel row for a template is the question it stands in
    // for, not the value.
    expect(saved.isProvisional).toBe(true)
    expect(saved.openQuestionId).toBe('Y9-package-policy')

    const [row] = await sql<{ note: string | null }[]>`
      select provisional_note as note from package_template_version
       where id = ${saved.versionId}::uuid
    `
    expect(row?.note).toMatch(/3 of 3 package policy settings unconfirmed/)

    // The control: terms typed in by a human are NOT flagged, so the flag is about the defaulting.
    const explicit = await saveVersion({
      templateKey: keyFor('explicit'),
      internalName: 'Course M',
      publicDisplayName: 'Course M',
      priceFils: 60_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 3 }],
      terms: { validityMonths: 9, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    expect(explicit.isProvisional).toBe(false)
    expect(explicit.validityMonths).toBe(9)
  })

  it('lock the unredeemed-balance policy: a manager is refused, the accountant succeeds and is audited', async () => {
    // A manager, through the F09 role check `writeSetting` calls before it touches a row.
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        writeSetting(uow, {
          key: PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
          value: 'forfeited',
          role: 'manager',
          actorLabel: 'Floor manager',
          justification: 'Wants the breakage',
        }),
      ),
    ).rejects.toThrow(/compliance_locked/)

    // The accountant's change, asserted INSIDE a transaction that is then rolled back: a confirmed
    // setting leaves the Unconfirmed Assumptions panel, and four other suites read it. The audit delta is
    // counted rather than the total, because `audit_event` is append-only and only grows (brief rule 9).
    const outcome = await withUnitOfWork(sql, ACCOUNTANT, async (uow) => {
      const [start] = await uow.sql<{ n: string }[]>`
        select count(*)::text as n from audit_event
         where entity_type = 'app_setting' and entity_id = ${PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY}
      `
      const result = await writeSetting(uow, {
        key: PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
        value: 'forfeited',
        role: 'accountant',
        actorLabel: 'Accountant',
        justification: 'Confirmed with the tax agent under Y9-package-policy',
      })
      const [end] = await uow.sql<{ n: string; action: string }[]>`
        select count(*)::text as n, max(action) as action from audit_event
         where entity_type = 'app_setting' and entity_id = ${PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY}
      `
      const [stored] = await uow.sql<{ value: string; isProvisional: boolean }[]>`
        select value #>> '{}' as value, is_provisional as "isProvisional" from app_setting
         where key = ${PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY}
      `
      const observed = {
        delta: Number(end?.n ?? 0) - Number(start?.n ?? 0),
        action: end?.action ?? null,
        value: stored?.value ?? null,
        stillProvisional: stored?.isProvisional ?? null,
        previous: result.previousValue,
      }
      // Assertions run, then the sentinel rolls the whole thing back.
      throw Object.assign(new Error(ROLLBACK), { observed })
    }).catch((err: unknown) => err)

    const observed = (outcome as { observed?: Record<string, unknown> }).observed
    expect(observed, 'the accountant’s write threw for some other reason').toBeDefined()
    expect(observed?.['delta']).toBe(1)
    expect(observed?.['action']).toBe('settings.compliance_locked.changed')
    expect(observed?.['value']).toBe('forfeited')
    // Confirming a value clears the provisional flag — that is the whole point of the panel.
    expect(observed?.['stillProvisional']).toBe(false)
    expect(observed?.['previous']).toBe('retained')

    // And nothing survived: the setting is still the provisional `retained`.
    const [after] = await sql<{ value: string; isProvisional: boolean }[]>`
      select value #>> '{}' as value, is_provisional as "isProvisional" from app_setting
       where key = ${PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY}
    `
    expect(after?.value).toBe('retained')
    expect(after?.isProvisional).toBe(true)
  })
})

describe('the refusals a caller reaches by mis-describing a package', () => {
  it('refuses two lines for one catalogue variant, by the named constraint, and says so readably', async () => {
    const caught = await saveVersion({
      templateKey: keyFor('dupe'),
      internalName: 'Course N',
      publicDisplayName: 'Course N',
      priceFils: 40_000,
      lines: [
        { serviceVariantId: variantA.id, sessionCount: 2 },
        { serviceVariantId: variantA.id, sessionCount: 1 },
      ],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }).catch((err: unknown) => err)

    // The constraint, not an application check: one entitlement expressed twice would give a redemption
    // two balances to draw from, so the refusal belongs where it cannot be bypassed.
    expect(isDuplicatePackageLine(caught)).toBe(true)
    expect(packageError(caught)?.message).toMatch(/may not list the same treatment twice/)
    // The control: the same two lines on DIFFERENT variants are accepted, so the refusal is about the
    // repetition and not about a version with two lines.
    const ok = await saveVersion({
      templateKey: keyFor('dupe_ok'),
      internalName: 'Course O',
      publicDisplayName: 'Course O',
      priceFils: 40_000,
      lines: [
        { serviceVariantId: variantA.id, sessionCount: 2 },
        { serviceVariantId: variantB.id, sessionCount: 1 },
      ],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    expect(ok.sessionCount).toBe(3)
  })

  it('names the CLASS on every early refusal, not just in the message text', async () => {
    // Two of these used to be plain AppErrors whose message spelled the class name, so
    // `err instanceof PackageTemplateUnavailable` answered false for an error that said
    // PackageTemplateUnavailable — worse than no name at all, because a caller branching on the type
    // silently took the other branch.
    const noLines = await saveVersion({
      templateKey: keyFor('class_a'),
      internalName: 'Course P',
      publicDisplayName: 'Course P',
      priceFils: 10_000,
      lines: [],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }).catch((err: unknown) => err)
    expect(noLines).toBeInstanceOf(PackageTemplateUnavailable)

    const unknownVariant = await saveVersion({
      templateKey: keyFor('class_b'),
      internalName: 'Course Q',
      publicDisplayName: 'Course Q',
      priceFils: 10_000,
      lines: [{ serviceVariantId: '00000000-0000-0000-0000-000000000000', sessionCount: 1 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    }).catch((err: unknown) => err)
    expect(unknownVariant).toBeInstanceOf(PackageTemplateUnavailable)
    expect(String((unknownVariant as Error).message)).toMatch(/the catalogue does not have/)

    const retired = await (async () => {
      const saved = await saveVersion({
        templateKey: keyFor('class_c'),
        internalName: 'Course R',
        publicDisplayName: 'Course R',
        priceFils: 10_000,
        lines: [{ serviceVariantId: variantA.id, sessionCount: 1 }],
        terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
      })
      await sql`update package_template set retired_at = now() where id = ${saved.templateId}::uuid`
      return saveVersion({
        templateKey: keyFor('class_c'),
        internalName: 'Course R',
        publicDisplayName: 'Course R',
        priceFils: 20_000,
        lines: [{ serviceVariantId: variantA.id, sessionCount: 2 }],
        terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
      }).catch((err: unknown) => err)
    })()
    expect(retired).toBeInstanceOf(PackageTemplateUnavailable)
    expect(String((retired as Error).message)).toMatch(/withdrawn from sale/)
  })
})

describe('the grants permit exactly what the service does', () => {
  /**
   * The whole path under `set local role berelax_app`.
   *
   * Every other case in this file connects as the OWNER, which is how a grant too narrow hides: the
   * service works for a test and is `42501 permission denied` in production. It did. The first version of
   * `savePackageTemplateVersion` upserted the template with
   * `on conflict (template_key) do update set updated_at = now()`, and 0078 narrows `berelax_app`'s
   * UPDATE on that table to `retired_at` alone — a column-list grant is checked against the columns the
   * statement NAMES. Nothing in the build caught it; a psql probe did.
   *
   * `set local role` rather than a second connection, so the role cannot leak onto the next statement
   * that shares this pooled connection (0076's arrangement for the same probe).
   */
  it('saves a version and sells it as berelax_app, not as the owner', async () => {
    const key = keyFor('as_app')
    const outcome = await withUnitOfWork(sql, ACTOR, async (uow) => {
      await uow.sql`set local role berelax_app`
      const saved = await savePackageTemplateVersion(uow, {
        templateKey: key,
        internalName: 'Course S',
        publicDisplayName: 'Course S',
        priceFils: 70_000,
        lines: [{ serviceVariantId: variantA.id, sessionCount: 2 }],
        terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
      })
      const entryId = entryIdFor('as-app')
      const sold = await sellPackage(uow, {
        customerId,
        templateVersionId: saved.versionId,
        tradingDate: DAY,
        priceFils: 70_000,
        sessionCount: 2,
        validityMonths: 6,
        transferable: false,
        unredeemedBalancePolicy: 'retained',
        journal: deferredRevenueEntry(entryId, DAY, [{ account: CASH, fils: 70_000 }]),
        balances: [
          { lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 2, valueFils: 70_000 },
        ],
        tenders: [{ tenderKind: 'cash', postingAccountCode: CASH, amountFils: 70_000 }],
      })
      // Read back inside the same role, so the SELECT grant is exercised too.
      const [row] = await uow.sql<{ expiresOn: string }[]>`
        select expires_on::text as "expiresOn" from package_sale where id = ${sold.saleId}::uuid
      `
      return { version: saved.version, expiresOn: row?.expiresOn ?? null }
    })
    expect(outcome.version).toBe(1)
    expect(outcome.expiresOn).toBe('2092-10-06')

    // A SECOND version through the same path, which is the statement the narrowed grant refused: the
    // template already exists, so the insert conflicts and the service has to read rather than update.
    const second = await withUnitOfWork(sql, ACTOR, async (uow) => {
      await uow.sql`set local role berelax_app`
      return savePackageTemplateVersion(uow, {
        templateKey: key,
        internalName: 'Course S',
        publicDisplayName: 'Course S (revised)',
        priceFils: 90_000,
        lines: [{ serviceVariantId: variantA.id, sessionCount: 3 }],
        terms: { validityMonths: 12, transferable: false, unredeemedBalancePolicy: 'retained' },
      })
    })
    expect(second.version).toBe(2)

    // And the control on the other side of the same grant: the application role still cannot restate a
    // version somebody has sold against. A grant wide enough for the service must not be wide enough for
    // that, and this is the pair of assertions that says so.
    const refused = await withUnitOfWork(sql, ACTOR, async (uow) => {
      await uow.sql`set local role berelax_app`
      await uow.sql`
        update package_template_version set price_fils = 1 where id = ${second.versionId}::uuid
      `
      return 'updated'
    }).catch((err: unknown) => err)
    expect(refused).not.toBe('updated')
    expect(String((refused as Error).message)).toMatch(
      /permission denied for table package_template_version/,
    )
  })
})

describe('a sale follows the person a customer merge keeps', () => {
  /**
   * The one UPDATE `package_sale` permits, and the only thing that issues it.
   *
   * `merge-participants.ts` registers this table as `repoint_update` (C-CRM-05): two duplicate records
   * are one person who paid for one package, and a merge that could not follow the money would leave a
   * live entitlement on a tombstone nothing reads. `packages/fixtures/src/merge.itest.ts` proves the
   * registry covers the table; what it cannot prove is that the statement the executor issues is one the
   * trigger and the grant actually permit, because that suite has no `package_sale` rows. This does.
   *
   * Both halves are asserted together. "The merge may re-point the customer" on its own is satisfied by a
   * table with no guard at all, and "the terms are immutable" on its own is satisfied by a table nothing
   * may update — and the pair is the whole claim.
   */
  it('permits a customer_id re-point as berelax_app and refuses every other column', async () => {
    const saved = await saveVersion({
      templateKey: keyFor('merge'),
      internalName: 'Course T',
      publicDisplayName: 'Course T',
      priceFils: 55_000,
      lines: [{ serviceVariantId: variantA.id, sessionCount: 2 }],
      terms: { validityMonths: 6, transferable: false, unredeemedBalancePolicy: 'retained' },
    })
    const sold = await sellOne({
      templateVersionId: saved.versionId,
      priceFils: 55_000,
      sessionCount: 2,
      validityMonths: 6,
      transferable: false,
      unredeemedBalancePolicy: 'retained',
      balances: [{ lineNo: 1, serviceVariantId: variantA.id, sessionsTotal: 2, valueFils: 55_000 }],
      label: 'merge',
    })
    const [survivor] = await sql<{ id: string }[]>`
      select id from customer where id <> ${customerId}::uuid order by id limit 1
    `
    expect(survivor, 'the seed creates more than one customer').toBeDefined()

    // The statement the merge executor issues, under the role it runs as.
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      await uow.sql`set local role berelax_app`
      await uow.sql`
        update package_sale set customer_id = ${survivor?.id ?? null}::uuid
         where id = ${sold.saleId}::uuid
      `
    })
    const moved = await readPackageSale(sql, sold.saleId)
    expect(moved?.customerId).toBe(survivor?.id)
    // And nothing else moved with it: the terms are what the customer agreed to.
    expect(moved?.priceFils).toBe(55_000)
    expect(moved?.sessionCount).toBe(2)
    expect(moved?.expiresOn).toBe('2092-10-06')
    // The balance carries no customer id and hangs off the sale, so it followed without being touched.
    expect(moved?.balances[0]?.valueFils).toBe(55_000)

    // Every other column, refused — by the trigger for the owner and by the grant for the application
    // role, which is the door held twice.
    const asOwner = await sql`
      update package_sale set price_fils = 1 where id = ${sold.saleId}::uuid
    `.catch((err: unknown) => err)
    expect((asOwner as { code?: string }).code).toBe(PACKAGE_SQLSTATE.immutableRow)
    expect(String((asOwner as Error).message)).toMatch(/a package sale is a contract/)

    const asApp = await withUnitOfWork(sql, ACTOR, async (uow) => {
      await uow.sql`set local role berelax_app`
      await uow.sql`update package_sale set price_fils = 1 where id = ${sold.saleId}::uuid`
      return 'updated'
    }).catch((err: unknown) => err)
    expect(asApp).not.toBe('updated')
    expect(String((asApp as Error).message)).toMatch(/permission denied for table package_sale/)

    // And a DELETE is refused outright for every role, which is the half no merge needs.
    const deleted = await sql`delete from package_sale where id = ${sold.saleId}::uuid`.catch(
      (err: unknown) => err,
    )
    expect((deleted as { code?: string }).code).toBe(PACKAGE_SQLSTATE.immutableRow)
  })
})
