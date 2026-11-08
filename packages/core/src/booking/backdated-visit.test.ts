import { describe, expect, it } from 'vitest'
import type { Instant, LocalDate } from '../time.ts'
import { backdatedVisitVerdict } from './backdated-visit.ts'

/**
 * Recording a visit that happened and was never entered.
 *
 * The cases below are the five ways it can go wrong, and the one way it goes right. Each refusal is
 * about a different kind of mistake, which is why they are separate names rather than one
 * `invalid_period`: "you typed next week", "you typed last year", "the client is still on the table"
 * and "we were closed then" need different answers from the person at the desk.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000 as Instant
const date = (value: string): LocalDate => value as LocalDate
const at = (ms: number): Instant => ms as Instant

/** Every instant belongs to one trading date, unless a test says otherwise. */
const alwaysTrading = (): LocalDate => date('2027-01-15')

describe('backdatedVisitVerdict', () => {
  const yesterday = {
    startsAt: at(NOW - DAY),
    endsAt: at(NOW - DAY + 60 * 60 * 1000),
    outcome: 'completed' as const,
    now: NOW,
    horizonDays: 14,
  }

  it('records a visit that finished yesterday, on the trading date that owns it', () => {
    expect(backdatedVisitVerdict(yesterday, alwaysTrading)).toEqual({
      kind: 'recordable',
      tradingDate: date('2027-01-15'),
      outcome: 'completed',
    })
  })

  it('records a no-show the same way', () => {
    // The outcome is the caller's, not this function's: a client who did not arrive is still a visit
    // the diary and the commission run need to know about.
    const verdict = backdatedVisitVerdict({ ...yesterday, outcome: 'no_show' }, alwaysTrading)
    expect(verdict).toMatchObject({ kind: 'recordable', outcome: 'no_show' })
  })

  it('refuses a future visit, because that is a booking', () => {
    const future = { ...yesterday, startsAt: at(NOW + DAY), endsAt: at(NOW + DAY + 3_600_000) }
    expect(backdatedVisitVerdict(future, alwaysTrading)).toEqual({
      kind: 'refused',
      refusal: 'not_in_the_past',
    })
  })

  it('refuses a treatment that has not finished', () => {
    // Started an hour ago, ends in an hour. Marking this `completed` would finish a treatment while the
    // client is still on the table.
    const running = { ...yesterday, startsAt: at(NOW - 3_600_000), endsAt: at(NOW + 3_600_000) }
    expect(backdatedVisitVerdict(running, alwaysTrading)).toEqual({
      kind: 'refused',
      refusal: 'still_running',
    })
  })

  it('refuses an entry further back than the horizon', () => {
    const old = {
      ...yesterday,
      startsAt: at(NOW - 30 * DAY),
      endsAt: at(NOW - 30 * DAY + 3_600_000),
    }
    expect(backdatedVisitVerdict(old, alwaysTrading)).toEqual({
      kind: 'refused',
      refusal: 'beyond_the_horizon',
    })
    // And accepts it when the horizon is wide enough, so the refusal is about the horizon and not
    // about the age.
    expect(backdatedVisitVerdict({ ...old, horizonDays: 60 }, alwaysTrading)).toMatchObject({
      kind: 'recordable',
    })
  })

  it('refuses a period that is empty or inverted', () => {
    const empty = { ...yesterday, endsAt: yesterday.startsAt }
    expect(backdatedVisitVerdict(empty, alwaysTrading)).toEqual({
      kind: 'refused',
      refusal: 'period_not_positive',
    })
    const inverted = { ...yesterday, endsAt: at(yesterday.startsAt - 1) }
    expect(backdatedVisitVerdict(inverted, alwaysTrading)).toEqual({
      kind: 'refused',
      refusal: 'period_not_positive',
    })
  })

  it('refuses an instant no trading session owns', () => {
    // The salon was closed. The trading-date resolution is the caller's — `resolveTradingDate` is what
    // knows a 01:30 treatment belongs to the previous day — and a null from it is a refusal here rather
    // than a date this function invents.
    expect(backdatedVisitVerdict(yesterday, () => null)).toEqual({
      kind: 'refused',
      refusal: 'outside_a_trading_session',
    })
  })

  it('checks the period before the clock', () => {
    // An inverted period in the future is refused for being inverted, not for being in the future: the
    // first answer a reader gets should be about what they typed wrongly.
    const both = { ...yesterday, startsAt: at(NOW + DAY), endsAt: at(NOW + DAY - 1) }
    expect(backdatedVisitVerdict(both, alwaysTrading)).toEqual({
      kind: 'refused',
      refusal: 'period_not_positive',
    })
  })
})
