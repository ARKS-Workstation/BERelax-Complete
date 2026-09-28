import { entryId, filsFrom, isPlaceholderText, localDate, money } from '@berelax/core'
import {
  currentPackageTemplateVersion,
  redeemPackage,
  type Sql,
  savePackageTemplateVersion,
  sellPackage,
  withUnitOfWork,
} from '@berelax/db'
import { packageSaleMapping } from './package.ts'
import { packageRedemptionMapping } from './package-redemption.ts'

/**
 * The fixture salon's packages, at four drawdown states (M-TILL-13).
 *
 * docs/12 §5 promises "packages at several drawdown states" and no loader wrote one: M-TILL-09 and M-TILL-10
 * both deliberately seeded none and both named this unit as the owner, because **what this business sells as a
 * package is a fact nobody has stated** and the screens where an invented product name would appear in a
 * screenshot are this unit's.
 *
 * ## How a package is made demonstrable without inventing a product
 *
 * Not by picking a plausible menu. Four things, and the first three are what make a reviewer unable to mistake
 * the fixture for a configured product:
 *
 *   1. **The name carries a marker the schema itself refuses.** Every `public_display_name` and
 *      `internal_name` below starts `[confirm]` and ends with `Y9-package-catalogue`, and `[confirm]` is one of
 *      the ten markers `is_placeholder_text()` (0026) matches. That is the same function that stops
 *      `TRN-PENDING-Y1-TRN` reaching `invoice.issuer_trn`, so a fixture package name can never be printed on a
 *      document as though it were a product. {@link assertFixturePackageNamesAreMarked} holds that for every
 *      seeded row, with the control that a plausible name fails it.
 *   2. **The template is FLAGGED, in the data.** `is_provisional` is true and `open_question_id` is set, which
 *      is what puts the row on the Unconfirmed Assumptions panel and what the `/packages` screen reads to
 *      print the id beside the package. A confirmed package loses the badge by having the flag cleared — no
 *      code change, the same mechanism a confirmed setting uses.
 *   3. **No price is invented.** The price of each fixture package is the **undiscounted sum of the catalogue
 *      prices of the sessions it contains** — `gross_price_fils × session_count` of a real seeded variant. It
 *      is therefore not a figure this build made up: it is arithmetic over prices docs/13 §4 publishes. What a
 *      package DISCOUNT should be is exactly the unstated fact, so the fixture applies none and says so. A
 *      package that saves the customer nothing is commercially odd, which is the point: it reads as a fixture.
 *   4. **The treatments are real.** Each template's one line names a live seeded `service_variant`, so the
 *      entitlement, the allocation weight and the redemption posting all exercise real catalogue rows.
 *
 * ## The four states, and the one that needed a term overridden
 *
 * `untouched`, `part used` and `fully used` are reachable with the provisional six-month validity. **`expired
 * with a balance` is not**, and the arithmetic says why rather than the fixture guessing: the seeded
 * `business_day` range opens on {@link FIRST_BUSINESS_DAY} and the frozen clock's today is 2026-09-18, so a
 * six-month package sold on the earliest day the premises traded expires in November — after today. So that
 * one template supplies `terms` explicitly with a three-month validity, which means `savePackageTemplateVersion`
 * does NOT flag it provisional (supplying the terms is a deliberate override — somebody typed the numbers in,
 * and here the somebody is this fixture). Its name still carries both markers, and
 * {@link FIXTURE_PACKAGE_SHAPES} records the override beside the shape rather than hiding it.
 *
 * That state matters more than the other three: it is the only one that shows Y9-package-policy's retained
 * answer doing anything. A retained balance posts NOTHING at expiry, so without a seeded expired balance the
 * screen has nothing to show for the decision M-TILL-10 spent a whole section on.
 *
 * ## The appointment ids the redemptions name
 *
 * `package_redemption.appointment_id` is a plain uuid with **no foreign key**, which 0083 states as a decision:
 * "the link may therefore be orphaned, which is the right direction — the release of a liability is accounting
 * and the diary row is not". The fixture leans on that deliberately, because **no loader inserts an
 * appointment at all**: `generateSalon` builds 250 of them and 188 invoices and `loadSalon` writes none of
 * them, exactly as it builds a full rota and writes no `shift`. So the ids here are derived from a fixed
 * namespace with `md5(...)::uuid`, which makes them stable across runs and recognisable in a query; the day an
 * appointment loader lands, it can adopt the same derivation and the links resolve.
 */

/** The marker every fixture package name carries. One of `is_placeholder_text`'s ten (0026). */
export const FIXTURE_PACKAGE_MARKER = '[confirm]'

/** The question that owns "what does this business sell as a package". */
export const FIXTURE_PACKAGE_OPEN_QUESTION = 'Y9-package-catalogue'

/** The first day the seeded `business_day` range covers. See the note on the expired shape. */
export const FIRST_BUSINESS_DAY = '2026-05-21'

/** The variant every fixture package is built over: a real, live, seeded catalogue row. */
export const FIXTURE_PACKAGE_VARIANT = {
  style: 'asian',
  treatmentKey: 'normal_massage',
  durationMinutes: 60,
} as const

export interface FixturePackageShape {
  readonly templateKey: string
  readonly sessions: number
  /** How many of them the fixture draws down. */
  readonly redeemed: number
  /** The business day the sale is dated on. */
  readonly soldOn: string
  /** The state the screen should read off the rows. Asserted, never stored. */
  readonly state: 'untouched' | 'part used' | 'fully used' | 'expired with a balance'
  /**
   * Set only for the expired shape. Supplying the terms means the version is NOT flagged provisional, which
   * is what that flag means — somebody typed the numbers in.
   */
  readonly validityMonths?: number
}

/**
 * The four shapes, one template each.
 *
 * A template per shape rather than four sales of one template, so the `/packages` screen's drawdown column has
 * four different answers to show and a reviewer can see all four states in one screenshot. Four templates is
 * also what makes the per-template drawdown summary in `readPackageTemplates` mean anything: one template with
 * four sales would report a single blended figure.
 */
export const FIXTURE_PACKAGE_SHAPES: readonly FixturePackageShape[] = Object.freeze([
  {
    templateKey: 'fixture_package_untouched',
    sessions: 5,
    redeemed: 0,
    soldOn: '2026-08-14',
    state: 'untouched',
  },
  {
    templateKey: 'fixture_package_part_used',
    sessions: 5,
    redeemed: 2,
    soldOn: '2026-08-21',
    state: 'part used',
  },
  {
    templateKey: 'fixture_package_fully_used',
    sessions: 3,
    redeemed: 3,
    soldOn: '2026-07-10',
    state: 'fully used',
  },
  {
    templateKey: 'fixture_package_expired',
    sessions: 10,
    redeemed: 3,
    soldOn: FIRST_BUSINESS_DAY,
    state: 'expired with a balance',
    // 2026-05-21 + 3 months = 2026-08-21, which is before the frozen clock's 2026-09-18. With the provisional
    // six months it would be 2026-11-21 and the balance would still be live, so this state would be absent
    // from the fixture salon and the retained-balance policy would have nothing to show for itself.
    validityMonths: 3,
  },
])

/**
 * The display name a shape gets. It says what it is, it names the question, and it is not a product.
 *
 * The TEMPLATE KEY is in it, and that is not decoration: two of the four shapes sell five sessions, so a name
 * built from the session count alone gave the untouched and the part-used templates the SAME name — four
 * templates on the screen and two names. The key is already unique, already on the page as `data-template`,
 * and already says which fixture this is, so it is the right distinguisher; a serial number would be a second
 * identity to keep in step.
 */
export function fixturePackageName(shape: FixturePackageShape): string {
  return (
    `${FIXTURE_PACKAGE_MARKER} ${shape.templateKey}: ${shape.sessions} sessions of ` +
    'Normal Massage (Asian), 60 min — not a package this business sells; ' +
    FIXTURE_PACKAGE_OPEN_QUESTION
  )
}

/**
 * Throws unless every seeded package name is one the schema would refuse on a document.
 *
 * The check the whole approach rests on, so it is a function and not a comment: a name that stopped carrying
 * a marker would be a plausible product in a screenshot, and nothing else in the build would notice.
 */
export function assertFixturePackageNamesAreMarked(names: readonly string[]): void {
  const unmarked = names.filter((name) => !isPlaceholderText(name))
  if (unmarked.length > 0) {
    throw new Error(
      `A seeded package name carries no provisional marker, so a reviewer could mistake it for a product ` +
        `the business sells: ${unmarked.join('; ')}`,
    )
  }
}

/** The customers the fixture packages are sold to: the four the consent loader inserts, by phone. */
const FIXTURE_PACKAGE_CUSTOMER_PHONES = [
  '+971590009101',
  '+971590009102',
  '+971590009103',
  '+971590009104',
] as const

export interface SeededPackages {
  readonly templates: number
  readonly sales: number
  readonly balances: number
  readonly redemptions: number
  readonly names: readonly string[]
}

const NOTHING: SeededPackages = Object.freeze({
  templates: 0,
  sales: 0,
  balances: 0,
  redemptions: 0,
  names: [],
})

/**
 * Seeds the four templates, their sales and their redemptions.
 *
 * Idempotent per table, like every other loader: a database that already holds a `package_template` row is
 * left alone. That matters more here than elsewhere because a second run would issue a second set of journal
 * entries, and `journal_entry` is append-only.
 */
export async function seedPackages(sql: Sql): Promise<SeededPackages> {
  const [existing] = await sql<{ n: string }[]>`select count(*)::text as n from package_template`
  if (existing !== undefined && Number(existing.n) > 0) return NOTHING

  const [variant] = await sql<{ id: string; gross_price_fils: string }[]>`
    select v.id, v.gross_price_fils
      from service_variant v
      join service s on s.id = v.service_id
     where s.style = ${FIXTURE_PACKAGE_VARIANT.style}::treatment_style
       and s.treatment_key = ${FIXTURE_PACKAGE_VARIANT.treatmentKey}
       and v.duration_minutes = ${FIXTURE_PACKAGE_VARIANT.durationMinutes}
       and s.archived_at is null
  `
  if (variant === undefined) return NOTHING

  const customers = await sql<{ id: string }[]>`
    select id from customer
     where phone_e164 = any(${FIXTURE_PACKAGE_CUSTOMER_PHONES as unknown as string[]})
     order by phone_e164
  `
  if (customers.length === 0) return NOTHING

  const unitGrossFils = Number(variant.gross_price_fils)
  const names: string[] = []
  let templates = 0
  let sales = 0
  let balances = 0
  let redemptions = 0

  for (const [index, shape] of FIXTURE_PACKAGE_SHAPES.entries()) {
    const name = fixturePackageName(shape)
    names.push(name)
    // The undiscounted sum of the catalogue prices of the sessions. No figure is invented; see the note.
    const priceFils = unitGrossFils * shape.sessions

    const saved = await withUnitOfWork(
      sql,
      { kind: 'system', label: 'fixture-packages' },
      async (uow) =>
        savePackageTemplateVersion(uow, {
          templateKey: shape.templateKey,
          internalName: name,
          publicDisplayName: name,
          priceFils,
          lines: [{ serviceVariantId: variant.id, sessionCount: shape.sessions }],
          ...(shape.validityMonths === undefined
            ? {}
            : {
                terms: {
                  validityMonths: shape.validityMonths,
                  transferable: false,
                  unredeemedBalancePolicy: 'retained',
                },
              }),
        }),
    )
    templates += 1

    const version = await currentPackageTemplateVersion(sql, shape.templateKey)
    if (version === null) continue
    const customer = customers[index % customers.length]
    if (customer === undefined) continue

    const saleMapping = packageSaleMapping({
      entryId: entryId(`fixture-pkg-sale-${shape.templateKey}`),
      tradingDate: localDate(shape.soldOn),
      customerId: customer.id,
      templateVersionId: version.versionId,
      priceGross: money(filsFrom(priceFils)),
      lines: version.lines.map((line) => ({
        lineNo: line.lineNo,
        serviceVariantId: line.serviceVariantId,
        sessionCount: line.sessionCount,
        listGrossFils: line.listGrossFils,
      })),
      // Cash, because a fixture drawer that never took a note would leave the cash-up screen with nothing to
      // reconcile — and a package payment being visible to `readDrawerTakings` is the defect M-TILL-10 fixed.
      tenders: [{ kind: 'cash', amount: money(filsFrom(priceFils)) }],
      validityMonths: saved.validityMonths,
      transferable: saved.transferable,
      unredeemedBalancePolicy: saved.unredeemedBalancePolicy,
      packageLabel: name,
    })
    const sold = await withUnitOfWork(
      sql,
      { kind: 'system', label: 'fixture-packages' },
      async (uow) => sellPackage(uow, saleMapping.input),
    )
    sales += 1
    balances += sold.balanceIds.length

    for (let step = 0; step < shape.redeemed; step += 1) {
      const [balanceRow] = await sql<
        {
          id: string
          sessions_total: number
          sessions_redeemed: number
          value_fils: string
          released_fils: string
        }[]
      >`
        select id, sessions_total, sessions_redeemed, value_fils, released_fils
          from package_balance
         where package_sale_id = ${sold.saleId} and sessions_redeemed < sessions_total
         order by line_no
         limit 1
      `
      if (balanceRow === undefined) break
      // A stable synthetic appointment id. No foreign key exists (0083), and no loader inserts an appointment,
      // so this is the honest shape: a link that will resolve the day one does.
      const [derived] = await sql<{ id: string }[]>`
        select md5(${`fixture-pkg-appointment-${shape.templateKey}-${step}`})::uuid as id
      `
      if (derived === undefined) break
      const redemptionMapping = packageRedemptionMapping({
        entryId: entryId(`fixture-pkg-redeem-${shape.templateKey}-${step}`),
        tradingDate: localDate(shape.soldOn),
        balance: {
          balanceId: balanceRow.id,
          sessionsTotal: balanceRow.sessions_total,
          sessionsRedeemed: balanceRow.sessions_redeemed,
          valueGross: money(filsFrom(Number(balanceRow.value_fils))),
          releasedGross: money(filsFrom(Number(balanceRow.released_fils))),
        },
        appointmentId: derived.id,
        units: 1,
        packageLabel: name,
      })
      await withUnitOfWork(sql, { kind: 'system', label: 'fixture-packages' }, async (uow) =>
        redeemPackage(uow, redemptionMapping.input),
      )
      redemptions += 1
    }
  }

  assertFixturePackageNamesAreMarked(names)
  return { templates, sales, balances, redemptions, names }
}
