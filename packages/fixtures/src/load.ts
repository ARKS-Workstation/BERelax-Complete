/**
 * Writing the fixture salon into a database.
 *
 * Two kinds of thing go through here, and the distinction matters more than the file name suggests.
 *
 * The **real business** — the premises and its 11:00–02:00 hours, the legal entity, the 32 prices of
 * docs/13 §4, the publication of the eight services — is seeded from `packages/db/src/seed/`, which
 * holds the transcriptions. The **fixture salon** — synthetic customers, an eight-therapist roster, the
 * historical book — comes from `salon.ts`. Both run from one `pnpm seed` because the demo dataset is
 * placed against the real trading window and the real menu; a loader that seeded its own hours would
 * make the two disagree.
 *
 * Therapists, appointments and invoices are loaded by `B-AVAIL`, `B-LIFE` and `M-VAT` once those tables
 * exist — each registers a loader here rather than writing its own seed script, so `pnpm seed` stays one
 * command and the ordering between loaders is explicit rather than implied by filenames.
 *
 * **Every loader must be idempotent.** Seeding twice from clean has to produce the same rows, which
 * is the acceptance criterion and also what makes a developer's `pnpm seed` safe to run twice when
 * they are not sure whether it worked the first time.
 */
import {
  assertPublicDisplayNameCompliant,
  horizonDates,
  horizonRows,
  hoursFromSchedule,
  localDate,
  localTime,
} from '@berelax/core'
import {
  ensureLegalEntity,
  generateBusinessDays,
  readCompliancePolicy,
  type Sql,
  seedCatalogue,
  seedPremises,
  seedSettingDefaults,
} from '@berelax/db'
import {
  FIXTURE_CLOSE,
  FIXTURE_FORWARD_DAYS,
  FIXTURE_HISTORY_DAYS,
  FIXTURE_OPEN,
  FIXTURE_TODAY,
} from './clock.ts'
import type { FixtureSalon } from './salon.ts'

export interface Loader {
  /** Ordered: a loader runs after every loader it names. */
  readonly name: string
  readonly after: readonly string[]
  load(sql: Sql, salon: FixtureSalon): Promise<number>
}

/**
 * The premises, its trading hours and the legal entity — the real ones, from docs/13.
 *
 * The values used to be literals here, which made this file a second spelling of the address the
 * `premises` row is supposed to be the only source of. They now live in
 * `packages/db/src/seed/premises.ts`, which is a real seed rather than a fixture: this is the business's
 * own address and its own hours, not synthetic data, and the fixture salon's appointments are placed
 * against the same 11:00–02:00 window. B-CAT-06 moved them and left this loader as the ordering.
 *
 * Hours are the most load-bearing row in the database: 11:00 to 02:00 is what makes `crosses_midnight`
 * true and what makes every business-day calculation downstream mean something. Seeding 09:00 to 17:00
 * would leave the whole after-midnight path untested while every test still passed.
 */
const premisesLoader: Loader = {
  name: 'premises',
  after: [],
  async load(sql, salon) {
    void salon
    const rows = await seedPremises(sql)
    // The legal entity is 0026's singleton, ensured with 0026's own values and `do nothing`. It is
    // here so `pnpm seed` against a database that predates that migration still has an issuer, and it
    // must never carry a second spelling of the registered name: that name is snapshotted onto every
    // tax invoice, and a seed that "ensured" its own version once left the wrong one behind for every
    // later suite.
    return rows + (await ensureLegalEntity(sql))
  },
}

/**
 * The catalogue: the 32 prices of docs/13 §4, the publication of the 8 services, the price-on-request
 * items.
 *
 * Runs after `premises` because the trading hours are what make a published menu bookable at all, and
 * because `pnpm seed`'s output reads in that order.
 *
 * The compliance lint is assembled here rather than inside the seed, and this loader is the reason the
 * seam exists: `packages/db` may not import `packages/core`, so the term list comes out of
 * `regulatory_profile` through `readCompliancePolicy` and the lexicon comes from `@berelax/core`, and
 * `packages/fixtures` is the only package allowed to hold both. `seedCatalogue` refuses to publish a
 * name without a lint rather than defaulting to one that permits everything.
 */
const catalogueLoader: Loader = {
  name: 'catalogue',
  after: ['premises'],
  async load(sql, salon) {
    void salon
    const policy = await readCompliancePolicy(sql)
    const result = await seedCatalogue(sql, {
      lint: (name) =>
        assertPublicDisplayNameCompliant(name, {
          bannedClaimTerms: policy.bannedClaimTerms,
          permittedPublicTitles: policy.permittedPublicTitles,
          medicalClaimsPermitted: policy.medicalClaimsPermitted,
        }),
    })
    return result.variantsWritten + result.servicesPublished + result.priceOnRequestWritten
  },
}

/**
 * Settings the fixture world assumes.
 *
 * Written through the same store the application uses, so a value seeded here is indistinguishable
 * from one an owner set — including its audit trail. Anything not listed keeps its registry default,
 * which is deliberately the strict one.
 */
const settingsLoader: Loader = {
  name: 'settings',
  after: ['premises'],
  async load(sql, salon) {
    void salon
    // The registry's defaults FIRST, because nothing else creates an `app_setting` row: no migration seeds
    // the table, and `readSetting` deliberately falls back to the declared default for an absent key — so
    // the three UPDATEs below matched zero rows on any database that had not already run
    // `settings-store.itest.ts` or `availability.itest.ts`, while this loader went on reporting three
    // settings written. `seedSettingDefaults` is `on conflict do nothing`, which is what keeps the loader
    // idempotent (the acceptance criterion for every loader here). Found by M-VAT-03, whose two new
    // integration files changed the order vitest runs them in.
    await seedSettingDefaults(sql)
    const values: readonly [string, unknown][] = [
      ['booking.turnaround_minutes_standard', 15],
      ['booking.turnaround_minutes_wet', 30],
      ['packages.default_validity_months', 6],
    ]
    let changed = 0
    for (const [key, value] of values) {
      // `sql.json(value)` rather than `JSON.stringify(value)::jsonb`. postgres.js infers a string
      // parameter destined for jsonb as JSON and encodes it again, so the number 15 lands as the
      // JSON string "15" — which type-checks, stores, reads back, and is wrong.
      // `returning key`, and the count is what this loader reports: it used to return `values.length`
      // whatever it had done, which is a loader that says it seeded three settings while touching none.
      const result = await sql`
        update app_setting
        set value = ${sql.json(value as never)},
            updated_by = 'fixture-seed'
        where key = ${key}
        returning key
      `
      changed += result.length
    }
    return changed
  },
}

/**
 * The trading calendar, over the fixture's own horizon.
 *
 * Every report joins to `business_day`, so a fixture without it has no days to report on. The horizon
 * matches the appointments — history behind, forward book ahead — because a calendar shorter than the
 * data is a join that silently drops rows.
 */
const businessDayLoader: Loader = {
  name: 'business-days',
  after: ['premises'],
  async load(sql, salon) {
    void salon
    const hours = { open: localTime(FIXTURE_OPEN), close: localTime(FIXTURE_CLOSE) }
    const from = shift(FIXTURE_TODAY, -FIXTURE_HISTORY_DAYS)
    const days = FIXTURE_HISTORY_DAYS + FIXTURE_FORWARD_DAYS + 1
    const rows = horizonRows({
      from,
      days,
      hoursFor: hoursFromSchedule({ weekly: Array.from({ length: 7 }, () => hours) }),
    })
    const result = await generateBusinessDays(
      sql,
      rows.map((row) => ({
        tradingDate: row.tradingDate,
        opensAt: row.opensAt,
        closesAt: row.closesAt,
        source: row.source,
      })),
      { from, to: horizonDates(from, days).at(-1) ?? from },
    )
    return result.inserted + result.updated
  },
}

function shift(date: string, offsetDays: number) {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + offsetDays)
  return localDate(value.toISOString().slice(0, 10))
}

const LOADERS: Loader[] = [premisesLoader, catalogueLoader, settingsLoader, businessDayLoader]

/** Registers a loader. Called by the unit that owns the tables it writes. */
export function registerLoader(loader: Loader): void {
  if (LOADERS.some((existing) => existing.name === loader.name)) {
    throw new Error(`A fixture loader named '${loader.name}' is already registered.`)
  }
  LOADERS.push(loader)
}

/** Loaders in dependency order. Throws on a cycle or an unknown dependency rather than guessing. */
export function orderedLoaders(): Loader[] {
  const byName = new Map(LOADERS.map((loader) => [loader.name, loader]))
  const ordered: Loader[] = []
  const state = new Map<string, 'visiting' | 'done'>()

  const visit = (name: string, trail: readonly string[]): void => {
    const status = state.get(name)
    if (status === 'done') return
    if (status === 'visiting') {
      throw new Error(`Fixture loaders form a cycle: ${[...trail, name].join(' -> ')}`)
    }
    const loader = byName.get(name)
    if (loader === undefined) {
      throw new Error(
        `Fixture loader '${trail.at(-1)}' depends on '${name}', which is not registered.`,
      )
    }
    state.set(name, 'visiting')
    for (const dependency of loader.after) visit(dependency, [...trail, name])
    state.set(name, 'done')
    ordered.push(loader)
  }

  for (const loader of LOADERS) visit(loader.name, [])
  return ordered
}

export interface LoadResult {
  readonly loader: string
  readonly rows: number
}

/** Runs every loader, in order, in one transaction. */
export async function loadSalon(sql: Sql, salon: FixtureSalon): Promise<LoadResult[]> {
  const results: LoadResult[] = []
  for (const loader of orderedLoaders()) {
    const rows = await loader.load(sql, salon)
    results.push({ loader: loader.name, rows })
  }
  return results
}
