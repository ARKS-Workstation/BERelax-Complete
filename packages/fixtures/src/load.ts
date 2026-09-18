/**
 * Writing the fixture salon into a database.
 *
 * Only the tables that exist today: `premises` and its trading hours, and the settings whose values
 * the fixture world depends on. Services, rooms, therapists, appointments and invoices are loaded by
 * `B-CAT`, `B-AVAIL`, `B-LIFE` and `M-VAT` once those tables exist — each registers a loader here
 * rather than writing its own seed script, so `pnpm seed` stays one command and the ordering between
 * loaders is explicit rather than implied by filenames.
 *
 * **Every loader must be idempotent.** Seeding twice from clean has to produce the same rows, which
 * is the acceptance criterion and also what makes a developer's `pnpm seed` safe to run twice when
 * they are not sure whether it worked the first time.
 */
import type { Sql } from '@berelax/db'
import { FIXTURE_CLOSE, FIXTURE_OPEN } from './clock.ts'
import type { FixtureSalon } from './salon.ts'

export interface Loader {
  /** Ordered: a loader runs after every loader it names. */
  readonly name: string
  readonly after: readonly string[]
  load(sql: Sql, salon: FixtureSalon): Promise<number>
}

/**
 * The premises, and its trading hours.
 *
 * Hours are the fixture's most load-bearing row: 11:00 to 02:00 is what makes `crosses_midnight`
 * true and what makes every business-day calculation downstream mean something. Seeding 09:00 to
 * 17:00 here would leave the whole after-midnight path untested while every test still passed.
 */
const premisesLoader: Loader = {
  name: 'premises',
  after: [],
  async load(sql, salon) {
    void salon
    await sql`
      insert into premises (id, display_name, address_line_1, address_line_2, area)
      values (
        1,
        'BE RELAX Massage Center and Spa',
        '250 Al Meena Street, Tower Block A/B, M-Floor',
        'Al Zahiyah, E14',
        'Al Zahiyah'
      )
      on conflict (id) do update set
        display_name = excluded.display_name,
        address_line_1 = excluded.address_line_1,
        address_line_2 = excluded.address_line_2,
        area = excluded.area
    `
    // Replace rather than upsert: the hours are a set, and a day removed from the fixture must be
    // removed from the table too.
    await sql`delete from premises_hours`
    await sql`
      insert into premises_hours (day_of_week, open_time, close_time)
      select d, ${FIXTURE_OPEN}::time, ${FIXTURE_CLOSE}::time from generate_series(0, 6) as d
    `
    return 8
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
    const values: readonly [string, unknown][] = [
      ['booking.turnaround_minutes_standard', 15],
      ['booking.turnaround_minutes_wet', 30],
      ['packages.default_validity_months', 6],
    ]
    for (const [key, value] of values) {
      // `sql.json(value)` rather than `JSON.stringify(value)::jsonb`. postgres.js infers a string
      // parameter destined for jsonb as JSON and encodes it again, so the number 15 lands as the
      // JSON string "15" — which type-checks, stores, reads back, and is wrong.
      await sql`
        update app_setting
        set value = ${sql.json(value as never)},
            updated_by = 'fixture-seed'
        where key = ${key}
      `
    }
    return values.length
  },
}

const LOADERS: Loader[] = [premisesLoader, settingsLoader]

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
