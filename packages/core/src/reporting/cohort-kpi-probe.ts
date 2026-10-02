import type { LocalDate } from '../time.ts'
import type { KpiInput } from './kpi-expression.ts'

/**
 * Probe rows for R-REP-05's five datasets, so the ONE registry's reads rule has evidence about them.
 *
 * # Why this is a module and not fixture data in a test file
 *
 * `measure-reads-exactly-the-fields-it-declares` (ADR 0068) compares a measure's declaration against
 * what its reducer ACTUALLY touched, by replaying it against a recording copy of a probe input. A probe
 * with no rows in a dataset makes every measure that reads it read nothing, which is a mismatch against
 * a non-empty declaration — so the rule FAILS over an empty probe, deliberately, and R-REP-03's suite
 * asserts that failure as its vacuity control.
 *
 * The registry now spans two units. R-REP-03's `REGISTRY_PROBE` lives in `utilisation.test.ts` and
 * cannot reach into a test file of this unit's without the two suites importing each other, so the rows
 * for the datasets this unit added live here and that probe spreads them in. One probe, one statement of
 * it, no import cycle — and a dataset added by a later unit has a visible place to put its rows rather
 * than a reason to weaken the rule.
 *
 * # What the rows have to do
 *
 * Make every branch of every R-REP-05 reducer read every field it declares, which is more than "one row
 * each":
 *
 *   * **two cohorts and two months**, because the cohort measures restrict on `cohortMonths` and a
 *     single cohort month would make the restriction unexercised in the direction that matters — a row
 *     OUTSIDE the window being dropped.
 *   * **one contribution row inside the window and one outside it**, so
 *     `cohort_realised_net_contribution_fils` actually compares `monthIndex` rather than summing
 *     everything it is handed.
 *   * **one first touch in each of the three states**, so `new_customers_from_paid_channels` and
 *     `new_customers_with_unrecorded_first_touch` each read `firstTouch` and each select a subset.
 *   * **one spend row in a window cohort and one outside**, same argument.
 *   * **one entitlement part-drawn**, so the share arithmetic reads all three of its fields; a balance
 *     with every session left reads `sessionsRemaining` and `sessionsTotal` as the same number, which a
 *     reducer that used one for the other would pass.
 *
 * Nothing here is a fact about the business. Every figure is a round number chosen to make the rules
 * exercisable, and the cohort months are in a year nothing in this repository claims.
 */

const JANUARY = '2415-01-01' as LocalDate
const FEBRUARY = '2415-02-01' as LocalDate
/** A cohort month OUTSIDE the probe's window, so every restriction is exercised both ways. */
const MARCH = '2415-03-01' as LocalDate

export const COHORT_KPI_PROBE: Pick<
  KpiInput,
  | 'cohortMembers'
  | 'cohortMonths'
  | 'cohortContributions'
  | 'acquisitionSpend'
  | 'packageEntitlements'
> = Object.freeze({
  cohortMembers: Object.freeze([
    { customerId: 'probe-paid', cohortMonth: JANUARY, firstTouch: 'paid' as const },
    { customerId: 'probe-unpaid', cohortMonth: JANUARY, firstTouch: 'unpaid' as const },
    { customerId: 'probe-unrecorded', cohortMonth: FEBRUARY, firstTouch: 'not_recorded' as const },
    // Outside the window: dropped by every member measure, which is what proves they read cohortMonth.
    { customerId: 'probe-outside', cohortMonth: MARCH, firstTouch: 'paid' as const },
  ]),
  cohortMonths: Object.freeze([
    { cohortMonth: JANUARY, monthIndex: 0 },
    { cohortMonth: JANUARY, monthIndex: 1 },
    { cohortMonth: FEBRUARY, monthIndex: 0 },
  ]),
  cohortContributions: Object.freeze([
    { cohortMonth: JANUARY, monthIndex: 0, customerId: 'probe-paid', netContributionFils: 40_000n },
    { cohortMonth: JANUARY, monthIndex: 1, customerId: 'probe-paid', netContributionFils: 20_000n },
    // Past the horizon: dropped, which is what proves the measure compares monthIndex.
    { cohortMonth: JANUARY, monthIndex: 2, customerId: 'probe-paid', netContributionFils: 99_000n },
  ]),
  acquisitionSpend: Object.freeze([
    { cohortMonth: JANUARY, channel: 'probe-channel', netFils: 30_000n },
    { cohortMonth: MARCH, channel: 'probe-channel', netFils: 77_000n },
  ]),
  packageEntitlements: Object.freeze([
    {
      packageSaleId: 'probe-sale',
      balanceId: 'probe-balance',
      sessionsTotal: 6,
      sessionsRemaining: 4,
      valueFils: 60_000n,
    },
  ]),
})
