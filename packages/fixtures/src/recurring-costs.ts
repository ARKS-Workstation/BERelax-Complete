import {
  ACCOUNTS,
  type AccountCode,
  type BillTaxTreatment,
  filsFrom,
  type LocalDate,
  localDate,
  type Money,
  money,
  type RecurringCadence,
  type RecurringCost,
  type RecurringCostKind,
  validateRecurringCost,
} from '@berelax/core'
import { FIXTURE_TODAY } from './clock.ts'

/**
 * The committed recurring cost fixtures: the four cost shapes, the forward-schedule worked example and
 * the variance boundary cases every M-VAT-04 test asserts against.
 *
 * Committed data rather than values built inside each test, because two of the acceptance criteria are
 * literally "totals a committed worked example to the fils" and "asserted at the tolerance boundary on
 * both sides". A test that computed its expectation from the same code it is testing would assert that
 * the code agrees with itself: every figure below was worked out by hand and is checked in.
 *
 * ## Nothing here is loaded into a database by the seed
 *
 * Deliberately, and for the same reason `0031_recurring_cost.sql` seeds no row. The real register —
 * landlord, utilities, laundry, consumables, licence, insurance — is an H-MIG import, and a recurring
 * cost carries an **amount**: a seeded placeholder would put a contract that does not exist into a
 * cash-flow forecast, where it is summed, exported, demoed and eventually believed. These are test
 * fixtures, and the suppliers they name carry {@link SUPPLIER_FIXTURE_PREFIX} from `./purchases.ts` so
 * nothing here could be mistaken for a real counterparty.
 *
 * ## Why the forward schedule spans thirteen calendar months
 *
 * The horizon is the half-open window `[FIXTURE_TODAY, FIXTURE_TODAY + 12 months)`, which is what makes
 * a monthly cost contribute exactly twelve occurrences whatever day of the month it falls on. Twelve
 * rolling months starting on the 18th of September therefore touch September 2026 through September
 * 2027 — thirteen keys, the first and last of them partial. The alternative, bounding on calendar
 * months, gives eleven occurrences for a cost due on the 1st and twelve for one due on the 20th purely
 * because of where in the month the report was run.
 */

/** A fixture definition, in the shape both the pure validator and `recordRecurringCost` accept. */
export interface FixtureRecurringCost {
  /** Why this shape exists — the case it is the only test of. */
  readonly why: string
  readonly code: string
  readonly description: string
  /** A supplier code from `FIXTURE_SUPPLIERS` in `./purchases.ts`. */
  readonly supplierCode: string
  readonly account: AccountCode
  readonly taxTreatment: BillTaxTreatment
  readonly cadence: RecurringCadence
  readonly firstDueDate: LocalDate
  readonly kind: RecurringCostKind
  readonly expectedAmountFils?: number
  readonly expectedMinFils?: number
  readonly expectedMaxFils?: number
  readonly varianceToleranceBp: number
}

/**
 * The four shapes a recurring cost register has to handle.
 *
 * The first two are the whole point of the fixed/variable split: a rent that is identical every month
 * and a utility recharge that swings with the season, which need different expectations or the second
 * one alerts every month. The other two exercise the cadences a monthly-only register would get wrong —
 * a quarterly insurance premium and an annual licence renewal, each landing in the one month it is
 * actually due so that a cash-flow line can sum cadences together.
 */
export const FIXTURE_RECURRING_COSTS: readonly FixtureRecurringCost[] = [
  {
    why: 'the fixed cost the register exists for: identical every month, so any difference is news',
    code: 'fixture-monthly-rent',
    description: 'Premises rent',
    supplierCode: 'fixture-registered-landlord',
    account: ACCOUNTS.rent,
    taxTreatment: 'standard_recoverable',
    cadence: 'monthly',
    // Anchored on the 1st, and in January so the series is nine periods old at the frozen clock.
    firstDueDate: localDate('2026-01-01'),
    kind: 'fixed',
    expectedAmountFils: 2_100_000,
    // Zero, because a contracted rent that moves at all is either an escalation clause, a service
    // charge that used to be separate, or an error — and all three want somebody to look.
    varianceToleranceBp: 0,
  },
  {
    why: 'the variable cost: a band, so an August bill at the top of its range raises nothing',
    code: 'fixture-monthly-utilities',
    description: 'Chilled water and electricity, recharged by the landlord',
    supplierCode: 'fixture-registered-landlord',
    account: ACCOUNTS.utilities,
    taxTreatment: 'standard_recoverable',
    cadence: 'monthly',
    // The 20th, so this cost's September period falls INSIDE the rolling window and the rent's does not.
    // That asymmetry is what the worked example's thirteen keys demonstrate.
    firstDueDate: localDate('2026-02-20'),
    kind: 'variable',
    expectedMinFils: 210_000,
    expectedMaxFils: 525_000,
    varianceToleranceBp: 500,
  },
  {
    why: 'a quarterly cadence, which a monthly-only generator would file four times too often',
    code: 'fixture-quarterly-insurance',
    description: 'Public liability insurance premium',
    supplierCode: 'fixture-registered-consumables',
    account: ACCOUNTS.insurance,
    taxTreatment: 'standard_recoverable',
    cadence: 'quarterly',
    firstDueDate: localDate('2026-04-15'),
    kind: 'fixed',
    expectedAmountFils: 315_000,
    varianceToleranceBp: 250,
  },
  {
    why: 'an annual cadence, and an out-of-scope treatment: a government fee carries no claimable VAT',
    code: 'fixture-annual-licence',
    description: 'Trade licence renewal',
    supplierCode: 'fixture-registered-consumables',
    account: ACCOUNTS.licenceAndGovernmentFees,
    taxTreatment: 'out_of_scope',
    cadence: 'annual',
    firstDueDate: localDate('2026-11-05'),
    kind: 'fixed',
    expectedAmountFils: 1_200_000,
    varianceToleranceBp: 0,
  },
]

/** The fixture definitions as validated `RecurringCost`s, for the pure schedule functions. */
export const FIXTURE_RECURRING_DEFINITIONS: readonly RecurringCost[] = FIXTURE_RECURRING_COSTS.map(
  (shape) =>
    validateRecurringCost({
      code: shape.code,
      cadence: shape.cadence,
      firstDueDate: shape.firstDueDate,
      kind: shape.kind,
      expectedAmount:
        shape.expectedAmountFils === undefined ? null : money(filsFrom(shape.expectedAmountFils)),
      expectedMin:
        shape.expectedMinFils === undefined ? null : money(filsFrom(shape.expectedMinFils)),
      expectedMax:
        shape.expectedMaxFils === undefined ? null : money(filsFrom(shape.expectedMaxFils)),
      toleranceBp: shape.varianceToleranceBp,
    }),
)

/** How many months the committed forward-schedule example covers. */
export const FIXTURE_FORECAST_MONTHS = 12

/**
 * The forward-schedule worked example, as at the frozen clock.
 *
 * `FIXTURE_TODAY` is 18 September 2026, so the window is `[2026-09-18, 2027-09-18)` and each cost
 * contributes the occurrences below. Worked out by hand from the anchors, not computed from the code
 * under test:
 *
 *   fixture-monthly-rent        1st of the month   2026-10-01 .. 2027-09-01   12 x 2,100,000
 *   fixture-monthly-utilities   20th of the month  2026-09-20 .. 2027-08-20   12 x   525,000 (band top)
 *   fixture-quarterly-insurance 15th, quarterly    2026-10-15, 2027-01-15,
 *                                                  2027-04-15, 2027-07-15      4 x   315,000
 *   fixture-annual-licence      5 November          2026-11-05                 1 x 1,200,000
 *
 * September 2026 holds only the utility recharge and September 2027 only the rent, because the window
 * opens on the 18th and closes on the 18th. That is the half-open window doing exactly what it is for.
 */
export const FIXTURE_FORECAST_PERIODS: readonly {
  readonly periodKey: string
  readonly expectedFils: number
  readonly costCount: number
}[] = [
  { periodKey: '2026-09', expectedFils: 525_000, costCount: 1 },
  // Rent + utilities + the first insurance quarter inside the window.
  { periodKey: '2026-10', expectedFils: 2_940_000, costCount: 3 },
  // Rent + utilities + the licence renewal.
  { periodKey: '2026-11', expectedFils: 3_825_000, costCount: 3 },
  { periodKey: '2026-12', expectedFils: 2_625_000, costCount: 2 },
  { periodKey: '2027-01', expectedFils: 2_940_000, costCount: 3 },
  { periodKey: '2027-02', expectedFils: 2_625_000, costCount: 2 },
  { periodKey: '2027-03', expectedFils: 2_625_000, costCount: 2 },
  { periodKey: '2027-04', expectedFils: 2_940_000, costCount: 3 },
  { periodKey: '2027-05', expectedFils: 2_625_000, costCount: 2 },
  { periodKey: '2027-06', expectedFils: 2_625_000, costCount: 2 },
  { periodKey: '2027-07', expectedFils: 2_940_000, costCount: 3 },
  { periodKey: '2027-08', expectedFils: 2_625_000, costCount: 2 },
  { periodKey: '2027-09', expectedFils: 2_100_000, costCount: 1 },
]

/**
 * What the committed horizon totals, prudently and optimistically.
 *
 * 25,200,000 + 6,300,000 + 1,260,000 + 1,200,000 = 33,960,000 fils at the top of every band, and
 * 25,200,000 + 2,520,000 + 1,260,000 + 1,200,000 = 30,180,000 at the bottom. The difference is the one
 * variable cost's band, which is the figure a forecast that took the midpoint would be wrong by.
 */
export const FIXTURE_FORECAST_TOTAL_FILS = 33_960_000
export const FIXTURE_FORECAST_LOW_TOTAL_FILS = 30_180_000
/** 12 + 12 + 4 + 1. Asserted as a count, because 29 rows in the wrong months would still total right. */
export const FIXTURE_FORECAST_ROW_COUNT = 29

/**
 * The variance boundary cases, worked out by hand.
 *
 * Each pair is a gross the supplier might charge and what the register must conclude. The two
 * `within`/`over` rows either side of a boundary are the point: a bill exactly ON the tolerance is
 * within it, and one fils past is not — an off-by-one there alerts on every cost whose tolerance was set
 * to the amount it actually varies by, which is the amount somebody sets it to.
 */
export const FIXTURE_VARIANCE_CASES: readonly {
  readonly why: string
  readonly costCode: string
  readonly actualGrossFils: number
  readonly expectedDeltaFils: number
  readonly expectedToleranceFils: number
  readonly overTolerance: boolean
}[] = [
  {
    why: 'the rent exactly as contracted: no variance, and no alert',
    costCode: 'fixture-monthly-rent',
    actualGrossFils: 2_100_000,
    expectedDeltaFils: 0,
    expectedToleranceFils: 0,
    overTolerance: false,
  },
  {
    why: 'the rent one fils over, with a zero tolerance: the smallest difference this register reports',
    costCode: 'fixture-monthly-rent',
    actualGrossFils: 2_100_001,
    expectedDeltaFils: 1,
    expectedToleranceFils: 0,
    overTolerance: true,
  },
  {
    why: 'the rent 210 AED short: signed, because a credit to chase is not an overcharge',
    costCode: 'fixture-monthly-rent',
    actualGrossFils: 2_079_000,
    expectedDeltaFils: -21_000,
    expectedToleranceFils: 0,
    overTolerance: true,
  },
  {
    why: 'a utility bill at the very top of its band: inside it, so nothing is raised',
    costCode: 'fixture-monthly-utilities',
    actualGrossFils: 525_000,
    expectedDeltaFils: 0,
    expectedToleranceFils: 0,
    overTolerance: false,
  },
  {
    why: 'a utility bill at the very bottom of its band: also inside it',
    costCode: 'fixture-monthly-utilities',
    actualGrossFils: 210_000,
    expectedDeltaFils: 0,
    expectedToleranceFils: 0,
    overTolerance: false,
  },
  {
    // 5% of the 525,000 fils band top is 26,250 fils of grace BEYOND the band.
    why: 'a utility bill exactly on the tolerance above the band top: still within',
    costCode: 'fixture-monthly-utilities',
    actualGrossFils: 551_250,
    expectedDeltaFils: 26_250,
    expectedToleranceFils: 26_250,
    overTolerance: false,
  },
  {
    why: 'the same bill one fils higher: over tolerance, and the delta is measured from the band top',
    costCode: 'fixture-monthly-utilities',
    actualGrossFils: 551_251,
    expectedDeltaFils: 26_251,
    expectedToleranceFils: 26_250,
    overTolerance: true,
  },
  {
    // 5% of the 210,000 fils band FLOOR is 10,500 fils — a different reference from the case above,
    // which is the point of measuring from the edge that was crossed.
    why: 'a utility bill exactly on the tolerance below the band floor: still within',
    costCode: 'fixture-monthly-utilities',
    actualGrossFils: 199_500,
    expectedDeltaFils: -10_500,
    expectedToleranceFils: 10_500,
    overTolerance: false,
  },
  {
    why: 'the same bill one fils lower: over tolerance, below',
    costCode: 'fixture-monthly-utilities',
    actualGrossFils: 199_499,
    expectedDeltaFils: -10_501,
    expectedToleranceFils: 10_500,
    overTolerance: true,
  },
  {
    // 250 bp of 315,000 fils is 7,875 fils.
    why: 'an insurance premium exactly on its 2.5% tolerance below the contracted amount: within',
    costCode: 'fixture-quarterly-insurance',
    actualGrossFils: 307_125,
    expectedDeltaFils: -7_875,
    expectedToleranceFils: 7_875,
    overTolerance: false,
  },
  {
    why: 'the same premium one fils lower: over',
    costCode: 'fixture-quarterly-insurance',
    actualGrossFils: 307_124,
    expectedDeltaFils: -7_876,
    expectedToleranceFils: 7_875,
    overTolerance: true,
  },
]

/** One fixture definition by code. Throws rather than returning undefined: a typo is a bug, not a case. */
export function fixtureRecurringCost(code: string): FixtureRecurringCost {
  const found = FIXTURE_RECURRING_COSTS.find((shape) => shape.code === code)
  if (found === undefined) throw new Error(`No fixture recurring cost "${code}"`)
  return found
}

/** The as-of business day every figure above is committed for. */
export const FIXTURE_FORECAST_AS_OF: LocalDate = FIXTURE_TODAY

/** The prudent expectation of one fixture cost, as `Money`. */
export function fixtureExpectedGross(code: string): Money {
  const shape = fixtureRecurringCost(code)
  return money(filsFrom(shape.expectedAmountFils ?? shape.expectedMaxFils ?? 0))
}
