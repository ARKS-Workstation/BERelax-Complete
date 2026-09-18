/**
 * Reports computed from the fixture salon.
 *
 * These exist for the acceptance criterion *seeded twice from clean yields byte-identical reporting
 * output*. A digest over the dataset would satisfy it literally and prove less: a report is where
 * non-determinism actually shows up, because it aggregates, sorts and rounds — and a sort with ties
 * broken by insertion order is the classic way a "deterministic" pipeline produces two different
 * spreadsheets.
 *
 * They are also the first place `business_day` earns its keep. Trading runs 11:00 to 02:00, so an
 * 01:30 appointment belongs to the **previous** trading day. Cut these by calendar date and the
 * Friday figures are wrong every week — quietly, by however much the business takes after midnight.
 *
 * Pure: the dataset in, numbers out, no clock and no I/O.
 */
import { formatMoney, type Money, splitGross, sum, ZERO_AED } from '@berelax/core'
import type { FixtureAppointment, FixtureSalon } from './salon.ts'

export interface DailyTakings {
  readonly businessDay: string
  readonly completed: number
  readonly noShows: number
  readonly cancellations: number
  readonly gross: Money
  readonly net: Money
  readonly vat: Money
}

export interface TherapistUtilisation {
  readonly therapistId: string
  readonly displayName: string
  readonly completedAppointments: number
  readonly bookedMinutes: number
  readonly gross: Money
}

export interface SalonReport {
  readonly generatedForIso: string
  readonly daily: readonly DailyTakings[]
  readonly utilisation: readonly TherapistUtilisation[]
  readonly totals: {
    readonly gross: string
    readonly net: string
    readonly vat: string
    readonly completed: number
  }
}

function byBusinessDay(
  appointments: readonly FixtureAppointment[],
): Map<string, FixtureAppointment[]> {
  const grouped = new Map<string, FixtureAppointment[]>()
  for (const appointment of appointments) {
    const existing = grouped.get(appointment.businessDay)
    if (existing === undefined) grouped.set(appointment.businessDay, [appointment])
    else existing.push(appointment)
  }
  return grouped
}

/**
 * Daily takings, cut on the business day.
 *
 * Sorted by day, which is a total order over distinct keys — so there are no ties, and no
 * tie-breaking rule that could differ between runs.
 */
export function dailyTakings(salon: FixtureSalon): DailyTakings[] {
  const grouped = byBusinessDay(salon.appointments)
  return [...grouped.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([businessDay, appointments]) => {
      const completed = appointments.filter((a) => a.state === 'completed')
      const gross = sum(completed.map((a) => a.priceGross))
      const breakdown = splitGross(gross)
      return {
        businessDay,
        completed: completed.length,
        noShows: appointments.filter((a) => a.state === 'no_show').length,
        cancellations: appointments.filter((a) => a.state === 'cancelled').length,
        gross,
        net: breakdown.net,
        vat: breakdown.vat,
      }
    })
}

/**
 * Utilisation per therapist.
 *
 * Sorted by gross descending, and **then by id** — because gross is not unique, and a sort whose
 * comparator returns zero leaves the order to the engine. That is the tie the acceptance criterion
 * is really about.
 */
export function therapistUtilisation(salon: FixtureSalon): TherapistUtilisation[] {
  const rows = salon.therapists.map((therapist) => {
    const completed = salon.appointments.filter(
      (appointment) =>
        appointment.therapistId === therapist.id && appointment.state === 'completed',
    )
    return {
      therapistId: therapist.id,
      displayName: therapist.displayName,
      completedAppointments: completed.length,
      bookedMinutes: completed.reduce(
        (total, appointment) => total + (appointment.endsAt - appointment.startsAt) / 60_000,
        0,
      ),
      gross: completed.length === 0 ? ZERO_AED : sum(completed.map((a) => a.priceGross)),
    }
  })
  return rows.sort(
    (a, b) => b.gross.fils - a.gross.fils || (a.therapistId < b.therapistId ? -1 : 1),
  )
}

/** The whole report, in the form the determinism test digests. */
export function salonReport(salon: FixtureSalon): SalonReport {
  const daily = dailyTakings(salon)
  const completedGross = sum(daily.map((row) => row.gross))
  const breakdown = splitGross(completedGross)
  return {
    generatedForIso: salon.generatedForIso,
    daily,
    utilisation: therapistUtilisation(salon),
    totals: {
      gross: formatMoney(completedGross),
      net: formatMoney(breakdown.net),
      vat: formatMoney(breakdown.vat),
      completed: daily.reduce((total, row) => total + row.completed, 0),
    },
  }
}
