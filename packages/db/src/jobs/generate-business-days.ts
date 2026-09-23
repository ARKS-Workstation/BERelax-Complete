/**
 * Materialises the trading calendar over a rolling horizon.
 *
 * `business_day` is a table rather than an expression because every report, rota, cash-up and
 * commission calculation cuts on the trading date, and a `case when extract(hour ...) < 2` repeated
 * across a dozen queries is one rule with a dozen chances to disagree with itself.
 *
 * ## Idempotence is the whole contract
 *
 * Running this twice must change nothing. That is asserted by hashing the table before and after, and
 * it matters for a reason beyond tidiness: this runs on a schedule *and* by hand, and the hand runs
 * happen when somebody is not sure the scheduled one worked. A generator that appends, or that
 * rewrites `generated_at` on every pass, turns "did it work?" into "what did it just change?".
 *
 * So `generated_at` is only written when a row's substance actually changes, and a row whose hours
 * are unchanged is left alone. Rows outside the horizon are deleted, so shortening the horizon or
 * closing a date removes its row rather than leaving a stale one behind — a closed date is **absent**
 * from this table, never present with a flag.
 *
 * The SQL is deliberately one statement per phase rather than a merge. A merge would be shorter and
 * would make the "changed nothing" case indistinguishable from the "updated every row to itself" one.
 */
import type { Sql } from '../connection.ts'

/**
 * A trading date to materialise.
 *
 * Structurally identical to `BusinessDayRow` in `@berelax/core`, and declared here rather than
 * imported because `db` must not depend on `core` — the dependency runs the other way, and
 * `pnpm boundaries` enforces it. It caught the first draft of this file on the wrong side of the
 * rule. The caller computes the rows with `horizonRows` and hands them over; this module writes them
 * and knows nothing about trading hours.
 */
export interface BusinessDayInput {
  readonly tradingDate: string
  /** Epoch milliseconds. */
  readonly opensAt: number
  readonly closesAt: number
  readonly source: 'weekly' | 'override'
}

export interface WriteOptions {
  /** First trading date the horizon covers. Rows outside it are left alone. */
  readonly from: string
  /** Last trading date the horizon covers, inclusive. */
  readonly to: string
}

export interface GenerationResult {
  readonly inserted: number
  readonly updated: number
  /** Dates that stopped trading — a new closure, or a change to the weekly pattern. */
  readonly deleted: number
}

/**
 * Applies a horizon to the database. Safe to run repeatedly; the second run changes nothing.
 */
export async function generateBusinessDays(
  sql: Sql,
  rows: readonly BusinessDayInput[],
  options: WriteOptions,
): Promise<GenerationResult> {
  const payload = rows.map((row) => ({
    trading_date: row.tradingDate,
    opens_at: new Date(row.opensAt).toISOString(),
    closes_at: new Date(row.closesAt).toISOString(),
    source: row.source,
  }))

  if (payload.length === 0) {
    const removed = await sql<{ trading_date: string }[]>`
      delete from business_day
      where trading_date >= ${options.from}::date and trading_date <= ${options.to}::date
      returning trading_date
    `
    return { inserted: 0, updated: 0, deleted: removed.length }
  }

  // `on conflict do nothing` rather than `do update`: an update here would touch generated_at on
  // every run, and then "ran twice, changed nothing" would be untrue in a way that shows up only as
  // noise in an audit trail.
  const inserted = await sql<{ trading_date: string }[]>`
    insert into business_day ${sql(payload, 'trading_date', 'opens_at', 'closes_at', 'source')}
    on conflict (trading_date) do nothing
    returning trading_date
  `

  // Only the rows whose instants actually moved.
  const updated = await sql<{ trading_date: string }[]>`
    update business_day as b
    set opens_at = incoming.opens_at::timestamptz,
        closes_at = incoming.closes_at::timestamptz,
        source = incoming.source,
        generated_at = now()
    from (values ${sql(
      payload.map((row) => [row.trading_date, row.opens_at, row.closes_at, row.source]),
    )}) as incoming(trading_date, opens_at, closes_at, source)
    where b.trading_date = incoming.trading_date::date
      and (b.opens_at is distinct from incoming.opens_at::timestamptz
        or b.closes_at is distinct from incoming.closes_at::timestamptz
        or b.source is distinct from incoming.source)
    returning b.trading_date
  `

  // Dates inside the horizon that no longer trade. A closed date is absent, never flagged.
  const deleted = await sql<{ trading_date: string }[]>`
    delete from business_day
    where trading_date >= ${options.from}::date
      and trading_date <= ${options.to}::date
      and trading_date <> all(${payload.map((row) => row.trading_date)}::date[])
    returning trading_date
  `

  return { inserted: inserted.length, updated: updated.length, deleted: deleted.length }
}

/**
 * A hash of the whole table, for asserting that a second run changed nothing.
 *
 * `generated_at` is deliberately included: if it moved, the generator rewrote a row it should have
 * left alone, and that is exactly the failure this is meant to catch.
 */
export async function businessDayFingerprint(sql: Sql): Promise<string> {
  const [row] = await sql<{ digest: string }[]>`
    select coalesce(
      md5(string_agg(
        trading_date::text || '|' || opens_at::text || '|' || closes_at::text || '|' ||
        source || '|' || generated_at::text,
        E'\n' order by trading_date
      )),
      'empty'
    ) as digest
    from business_day
  `
  return row?.digest ?? 'empty'
}

/** The trading session an instant falls in, by its own open and close instants. */
export interface BusinessDayAt {
  readonly tradingDate: string
  /** Epoch milliseconds, as `business_day.opens_at` holds it. */
  readonly opensAt: number
  readonly closesAt: number
  /** True when the instant is inside `[opens_at, closes_at)` — the session is actually trading. */
  readonly isOpen: boolean
}

/**
 * The trading session an instant belongs to, read from the materialised calendar.
 *
 * `tradingDateAt` answers the same question with one column and is what a job needs when it only has
 * to date a row. This returns the **instants**, and P-HR-03's nightly sweep needs them for a reason
 * that is the whole of its fifth acceptance line: the window of "future appointments" has to start at a
 * trading date, and the trading date at 00:30 is YESTERDAY'S, because the session that opened at 11:00
 * closes at 02:00 the following calendar day (0011). A sweep that floored its window with
 * `date(at)` would miss tonight's 01:30 appointment entirely — the one whose calendar date is tomorrow
 * and whose trading date is the day before that.
 *
 * `isOpen` distinguishes the two cases a caller may legitimately care about. The nightly pass runs at
 * 05:00, after `closes_at`, so it is looking at the session that has just ENDED and `isOpen` is false;
 * a pass driven by hand at midnight is inside one and `isOpen` is true. Either way the trading date is
 * the same row, which is the point — the answer does not change depending on which side of 02:00
 * somebody ran it.
 *
 * Returns `null` when the calendar holds no session at or before the instant. The caller must refuse
 * rather than substitute a calendar date, for the reason `tradingDateAt` gives: a row dated by a guess
 * is a row nobody can reconcile.
 */
export async function businessDayAt(sql: Sql, atIso: string): Promise<BusinessDayAt | null> {
  const [row] = await sql<
    { trading_date: string; opens_at: Date; closes_at: Date; is_open: boolean }[]
  >`
    select trading_date::text as trading_date,
           opens_at,
           closes_at,
           (${atIso}::timestamptz < closes_at) as is_open
      from business_day
     where opens_at <= ${atIso}::timestamptz
     order by opens_at desc
     limit 1
  `
  if (row === undefined) return null
  return {
    tradingDate: row.trading_date,
    opensAt: row.opens_at.getTime(),
    closesAt: row.closes_at.getTime(),
    isOpen: row.is_open,
  }
}
