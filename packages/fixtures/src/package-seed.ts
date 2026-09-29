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

/**
 * ## Why the templates are seeded and the drawdown states are not
 *
 * This file used to seed both, and that broke nine cases in an OTP suite — a file this unit never touched
 * and had no business touching.
 *
 * The schema is the whole argument. `package_sale.customer_id` is `not null references customer (id) on delete
 * restrict` (0078), and `package_sale` refuses DELETE for every role because a sale is a contract. So a
 * package sale PERMANENTLY pins its customer: the sale cannot be deleted, therefore the customer cannot be
 * either, for the life of the database. Any suite that tries to remove that customer fails on the foreign
 * key, and no amount of scoping helps: the row is pinned by a contract, so the only safe seed is one that
 * sells nothing.
 *
 * That is why the five existing package suites all end with
 * `truncate ... package_template_version, package_template`: `truncate` is the one statement that removes an
 * append-only row, so a package sale that must not outlive its suite is truncated away rather than deleted.
 * A sale written by a LOADER has no suite to be truncated by, and between `pnpm seed` and whichever package
 * suite happens to run first there is a window in which `otp-route.itest.ts` fails.
 *
 * So the split is by what is safe to make permanent:
 *
 *   - {@link seedPackageTemplates} is what `pnpm seed` runs. A template and its version pin a
 *     `service_variant` and nothing else, no suite deletes a variant, and no journal entry is written at all
 *     — so it is permanent, idempotent, and cannot pin a customer or collide with the ledger.
 *   - {@link seedPackageDrawdownStates} writes the sales, balances and redemptions, and is called by the
 *     suite that DISPLAYS them (`apps/web/src/till.itest.ts`), which truncates the package family in its
 *     `afterAll` exactly as the other five do. The four states are therefore real on the screens, in the
 *     axe audit and in the forty-eight screenshots, and gone by the time anything else runs.
 *
 * What a human running `pnpm seed` loses is the outstanding balances, not the packages: `/packages` still
 * lists the four marked fixture templates, and selling and redeeming one is what that screen is for, so
 * every drawdown state is two keystrokes away rather than pre-made. That is a smaller loss than a seed that
 * makes a bare `delete from customer` impossible for every suite that comes after it.
 */

export interface SeededPackageTemplates {
  readonly templates: number
  readonly names: readonly string[]
}

export interface SeededDrawdownStates {
  readonly sales: number
  readonly balances: number
  readonly redemptions: number
}

const NO_TEMPLATES: SeededPackageTemplates = Object.freeze({ templates: 0, names: [] })
const NO_STATES: SeededDrawdownStates = Object.freeze({ sales: 0, balances: 0, redemptions: 0 })

/**
 * Seeds the four fixture templates and their first version. Nothing else.
 *
 * Idempotent per TEMPLATE KEY, and that is W-SYS-13's correction to this loader. It used to short-circuit on
 * `count(*) from package_template > 0`, which is idempotent per TABLE, and per-table idempotence is exactly
 * the defect ADR 0050 is about:
 *
 *  - a PARTLY emptied family looks seeded. Truncate `package_template_version` and `package_template_line`
 *    and leave `package_template` standing, and this loader returned "nothing to do" for ever after — four
 *    templates with no version, which every reader treats as four templates that do not exist.
 *  - a loader that cannot repair what it created cannot be a `restoredBy`. Six suites truncate this family
 *    as its declared owner (see `packages/db/src/suite-table-ownership.ts`) and the integration run's own
 *    invariant re-runs the loaders and then checks the seeded rows are back. With the table-level guard the
 *    templates came back only on a database where the family happened to be completely empty.
 *
 * `savePackageTemplateVersion` is still called only for a key with NO version, because it is an EDIT — it
 * inserts version+1 — so calling it on a template that already has one would leave a trail of undeletable
 * versions rather than the single version this fixture means.
 */
export async function seedPackageTemplates(sql: Sql): Promise<SeededPackageTemplates> {
  const keys = FIXTURE_PACKAGE_SHAPES.map((shape) => shape.templateKey)
  // Issued in EVERY state, and not redundant with `savePackageTemplateVersion`'s own identical ensure.
  // `seeded-tables.ts` derives the seeded tables from what the loaders reach for, because an idempotent
  // loader's row diff is zero on a database that has already been seeded — so a loader that writes nothing
  // on a healthy database is a loader whose tables the run invariant cannot protect. This statement is this
  // loader saying, in every state, which table it owns.
  await sql`
    insert into package_template (template_key)
    select unnest(${keys}::text[])
    on conflict (template_key) do nothing
  `
  const versioned = await sql<{ template_key: string }[]>`
    select t.template_key
      from package_template t
      join package_template_version v on v.template_id = t.id
  `
  const present = new Set(versioned.map((row) => row.template_key))

  const [variant] = await sql<{ id: string; gross_price_fils: string }[]>`
    select v.id, v.gross_price_fils
      from service_variant v
      join service s on s.id = v.service_id
     where s.style = ${FIXTURE_PACKAGE_VARIANT.style}::treatment_style
       and s.treatment_key = ${FIXTURE_PACKAGE_VARIANT.treatmentKey}
       and v.duration_minutes = ${FIXTURE_PACKAGE_VARIANT.durationMinutes}
       and s.archived_at is null
  `
  if (variant === undefined) return NO_TEMPLATES

  const unitGrossFils = Number(variant.gross_price_fils)
  const names: string[] = []
  let templates = 0

  for (const shape of FIXTURE_PACKAGE_SHAPES) {
    const name = fixturePackageName(shape)
    // Pushed before the skip, so the marker assertion below covers all four names on every run and not just
    // the ones this call happened to write. A check that examines fewer rows the second time is a check
    // whose coverage depends on the state it ran against (ADR 0002).
    names.push(name)
    if (present.has(shape.templateKey)) continue
    // The undiscounted sum of the catalogue prices of the sessions. No figure is invented; see the note.
    const priceFils = unitGrossFils * shape.sessions

    await withUnitOfWork(sql, { kind: 'system', label: 'fixture-packages' }, async (uow) =>
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
  }

  assertFixturePackageNamesAreMarked(names)
  return { templates, names }
}

/**
 * Sells each fixture template and draws its sessions down to the state the shape declares.
 *
 * NOT part of `pnpm seed`. Every row this writes pins a customer that cannot then be deleted, so it belongs
 * to a suite that truncates the package family afterwards — see the note above. It is idempotent against its
 * own output: a database that already holds a sale for a fixture template is left alone.
 *
 * **The CALLER supplies the customers, and that is deliberate.** This used to read the four the consent loader
 * seeds, which cannot be relied on: any suite that emptied `customer` would leave the fixture salon with no
 * customers at all and no way back, because `pnpm seed` is not re-run between suites. ADR 0050 now refuses
 * that statement outright; a caller that owns its row does not have to depend on the refusal holding. A caller that owns its customer row, creates it
 * and deletes it again is the only arrangement that holds whatever order the files run in (brief rule 12).
 * Sales are spread round the list, so one id gives one holder four packages and four ids give one each.
 *
 * The entry ids carry a discriminator, and that is not decoration. They are derived from the template key, and
 * `journal_entry` refuses DELETE and is absent from the truncate statement that clears everything else — it
 * could not be in it. So after a truncate the sales are gone while the entries they posted are still there,
 * and a second seeding deriving `fixture-pkg-sale-<key>` again collides on the primary key, from inside
 * `sellPackage`, with nothing about seeding in the message. The discriminator is the number of fixture sale
 * entries the journal ALREADY holds, which is deterministic, legible in a query, and strictly increasing
 * because those rows cannot be removed — so it cannot repeat. The first seeding of a fresh database counts
 * zero and takes no suffix at all.
 */
export async function seedPackageDrawdownStates(
  sql: Sql,
  customerIds: readonly string[],
): Promise<SeededDrawdownStates> {
  if (customerIds.length === 0) return NO_STATES

  const [already] = await sql<{ n: string }[]>`
    select count(*)::text as n
      from package_sale s
      join package_template_version v on v.id = s.template_version_id
      join package_template t on t.id = v.template_id
     where t.template_key = any(${FIXTURE_PACKAGE_SHAPES.map((shape) => shape.templateKey)})
  `
  if (already !== undefined && Number(already.n) > 0) return NO_STATES

  const [posted] = await sql<{ n: string }[]>`
    select count(*)::text as n from journal_entry where entry_id like 'fixture-pkg-sale-%'
  `
  const generation = Number(posted?.n ?? '0')
  const run = generation === 0 ? '' : `-r${generation}`

  let sales = 0
  let balances = 0
  let redemptions = 0

  for (const [index, shape] of FIXTURE_PACKAGE_SHAPES.entries()) {
    const version = await currentPackageTemplateVersion(sql, shape.templateKey)
    if (version === null) continue
    const customerId = customerIds[index % customerIds.length]
    if (customerId === undefined) continue

    const saleMapping = packageSaleMapping({
      entryId: entryId(`fixture-pkg-sale-${shape.templateKey}${run}`),
      tradingDate: localDate(shape.soldOn),
      customerId,
      templateVersionId: version.versionId,
      priceGross: money(filsFrom(Number(version.priceFils))),
      lines: version.lines.map((line) => ({
        lineNo: line.lineNo,
        serviceVariantId: line.serviceVariantId,
        sessionCount: line.sessionCount,
        listGrossFils: line.listGrossFils,
      })),
      // Cash, because a fixture drawer that never took a note would leave the cash-up screen with nothing to
      // reconcile — and a package payment being visible to `readDrawerTakings` is the defect M-TILL-10 fixed.
      tenders: [{ kind: 'cash', amount: money(filsFrom(Number(version.priceFils))) }],
      validityMonths: version.validityMonths,
      transferable: version.transferable,
      unredeemedBalancePolicy: version.unredeemedBalancePolicy,
      packageLabel: version.publicDisplayName,
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
        entryId: entryId(`fixture-pkg-redeem-${shape.templateKey}-${step}${run}`),
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
        packageLabel: version.publicDisplayName,
      })
      await withUnitOfWork(sql, { kind: 'system', label: 'fixture-packages' }, async (uow) =>
        redeemPackage(uow, redemptionMapping.input),
      )
      redemptions += 1
    }
  }

  return { sales, balances, redemptions }
}
