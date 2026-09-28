import { AppError } from '@berelax/shared'
import { can, type Role } from '../access/permissions.ts'
import type { LocalDate } from '../time.ts'

/**
 * Commission: the rate a version says, applied to the value a completed and paid treatment recognised.
 * Pure.
 *
 * ## The one property this module exists to have
 *
 * **A period computed again produces the same figures.** Not approximately, not to the fil — the same
 * bytes. That is what a therapist disputing a payslip needs, and it is the only claim here that is hard.
 * Three things make it true and every one of them is a decision that could have gone the other way:
 *
 *   1. **The rule version is an ARGUMENT, never a lookup.** {@link computeCommission} takes the version it
 *      is to use. It does not receive a list and pick; {@link commissionRuleFor} exists for the caller that
 *      has to choose one for a NEW run, and a recompute of an old run passes the version stored ON that
 *      run. A function that selected internally would answer with whatever is in force today, so a rate
 *      change in June would silently restate March — the defect the whole subject is about, and the one
 *      that looks like working code.
 *   2. **The output order is stated.** Lines come back ordered by trading date and then by appointment id,
 *      which is a total order over a period's appointments because an appointment has one id. Without a
 *      stated order "byte-identical" would be a claim about whatever order the caller's SQL happened to
 *      return, which is stable on a small table and stops being stable the first time the planner picks a
 *      parallel scan.
 *   3. **The arithmetic is integer, and the rounding is named by the version.** See below.
 *
 * ## Integer fils, and why the rounding direction is a versioned figure
 *
 * Money is integer fils (ADR 0007). `rateBp * basisFils` is computed BEFORE the division, because dividing
 * first turns 1% of 9,900 fils into 0 — and `Math.round(basisFils * rateBp / 10000)` is not an option
 * either: the intermediate is a float, and a float intermediate is the mistake ADR 0007 exists to refuse
 * even where it happens to be exact.
 *
 * Rounding DIRECTION is a business fact nobody has stated. It is worth one fil per line and real money over
 * a month, and both available answers are defensible — `floor` never overpays, `half_up` is what a
 * spreadsheet does. So it is a column on the rule version (`commission_rule.rounding_mode`, 0097) and this
 * module implements exactly the two the schema admits. A third mode is a new member there AND a branch
 * here, and {@link commissionFilsFor} refuses an unknown one rather than falling through to a default:
 * silently becoming `floor` would be an unpublished rounding rule paying somebody less.
 *
 * `commission_fils_for()` in 0097 is the same arithmetic in SQL, deliberately duplicated for the reason
 * 0083 gives about `package_release_through_fils`: the formula is EVIDENCE, and evidence only one program
 * can reproduce is evidence about the program. The two are held equal over a bounded CENSUS in
 * `packages/fixtures/src/hr-commission.itest.ts` — a census and not a random sample, because "these two
 * agree" checked on random inputs is a claim about the seed.
 *
 * ## No rate, threshold or structure is written down here
 *
 * `docs/OPEN-QUESTIONS.md` Y9-commission is open and its provisional answer is not a figure: it is "none
 * configured; the commission module ships disabled". So `commission_rule` seeds no version, nothing in this
 * file names a percentage, and with no version published {@link commissionRuleFor} throws rather than
 * inventing one. Every number in the tests belongs to a rule set the SUITE publishes.
 */

/** Which figure of the source document a percentage applies to. Mirrors `commission_rule.basis` (0097). */
export const COMMISSION_BASES = ['net_of_vat', 'gross_inclusive'] as const

export type CommissionBasis = (typeof COMMISSION_BASES)[number]

/** Mirrors `commission_rule.rounding_mode` (0097), and {@link commissionFilsFor} implements both. */
export const COMMISSION_ROUNDING_MODES = ['floor', 'half_up'] as const

export type CommissionRoundingMode = (typeof COMMISSION_ROUNDING_MODES)[number]

/** Where a commissionable value came from. Mirrors `commission_line.source` (0097). */
export const COMMISSION_SOURCES = ['invoice_line', 'package_redemption'] as const

export type CommissionSource = (typeof COMMISSION_SOURCES)[number]

/** One rate band of a version, exactly as `commission_rule_band` holds it. */
export interface CommissionBand {
  /** Position within the version, from 1. The bands are ORDERED and the order is data. */
  readonly bandNo: number
  /** Inclusive lower bound of the appointment value, in integer fils. */
  readonly fromFils: number
  readonly rateBp: number
}

/** One published version, exactly as `commission_rule` plus its bands hold it. */
export interface CommissionRuleVersion {
  readonly ruleVersionId: string
  readonly version: number
  readonly effectiveFrom: LocalDate
  readonly basis: CommissionBasis
  readonly roundingMode: CommissionRoundingMode
  readonly bands: readonly CommissionBand[]
}

/**
 * One appointment that earned something: what it recognised, and where that came from.
 *
 * `grossFils` and `vatFils` are the figures of the SOURCE DOCUMENT and not of the appointment. For a till
 * sale they are the invoice LINE's, which is what was actually charged after any discount — the
 * appointment's own `gross_price_fils` is the price as quoted at booking and is not what the customer paid.
 * For a package redemption they are `package_redemption.released_fils` and its VAT, which is the value
 * RECOGNISED when the treatment was delivered; the package SALE value is a different and larger figure,
 * and commissioning it would pay the whole course on the first visit.
 */
export interface CommissionEarning {
  readonly appointmentId: string
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly source: CommissionSource
  /** Set for `invoice_line`, null for `package_redemption`. */
  readonly invoiceId: string | null
  /** Set for `package_redemption`, null for `invoice_line`. */
  readonly packageRedemptionId: string | null
  readonly grossFils: number
  readonly vatFils: number
}

/** One computed line, in the shape `commission_line` stores. */
export interface CommissionLine {
  readonly appointmentId: string
  readonly employeeId: string
  readonly tradingDate: LocalDate
  readonly source: CommissionSource
  readonly invoiceId: string | null
  readonly packageRedemptionId: string | null
  readonly basisFils: number
  readonly bandNo: number
  readonly rateBp: number
  readonly commissionFils: number
}

export interface CommissionComputation {
  readonly ruleVersionId: string
  readonly lines: readonly CommissionLine[]
  readonly totalFils: number
}

/**
 * The largest basis this arithmetic is exact over, in fils, and the reason there is a bound at all.
 *
 * `basisFils * rateBp` is at most 10,000 times the basis, and JavaScript integers are exact to 2^53 - 1. A
 * basis above this makes the MULTIPLICATION inexact, and an inexact multiplication produces a plausible
 * figure rather than an error — which is the failure mode ADR 0007 is about. 900,000,000,000 fils is nine
 * billion dirhams, so the bound costs nothing and refusing above it costs nothing either.
 */
export const MAX_COMMISSION_BASIS_FILS = 900_000_000_000

/**
 * Commission for a basis at a rate, in integer fils, rounded as the version says.
 *
 * The multiplication happens FIRST. `Math.floor(basis / 10000) * rateBp` is the same expression rearranged
 * and it answers 0 for 1% of 9,900 fils, which is a therapist not paid for a treatment that was sold.
 *
 * `half_up` is `(basis * rateBp + 5000) / 10000` floored, which is exact: the numerator is an integer, so
 * no float intermediate exists and the tie at .5 goes up by construction rather than by a comparison
 * somebody has to get the boundary of right.
 */
export function commissionFilsFor(
  basisFils: number,
  rateBp: number,
  mode: CommissionRoundingMode,
): number {
  if (!Number.isInteger(basisFils) || basisFils < 0) {
    throw new AppError(
      'validation',
      `A commission basis of ${basisFils} fils is not a value. Money is integer fils (ADR 0007) and a ` +
        'refund is a reversal, never a negative line.',
    )
  }
  if (basisFils > MAX_COMMISSION_BASIS_FILS) {
    throw new AppError(
      'validation',
      `A commission basis of ${basisFils} fils is above ${MAX_COMMISSION_BASIS_FILS}, at which ` +
        'basisFils * rateBp stops being an exact integer. An inexact multiplication here produces a ' +
        'plausible figure rather than an error, which is the one outcome money arithmetic may not have.',
    )
  }
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10_000) {
    throw new AppError(
      'validation',
      `A commission rate of ${rateBp} basis points is outside 0..10000, which is 0% to 100%. ` +
        '`commission_rule_band_rate_bounded` refuses the same row.',
    )
  }
  const scaled = basisFils * rateBp
  if (mode === 'floor') return Math.floor(scaled / 10_000)
  if (mode === 'half_up') return Math.floor((scaled + 5_000) / 10_000)
  /*
    Not a fall-through to `floor`.

    A rounding mode nobody implemented must not silently become one of the two that exist: that is an
    unpublished rounding rule paying somebody a fil less on every line, and nothing would ever report it.
    `commission_rule.rounding_mode`'s CHECK makes this unreachable through the table, and a third member
    added there without a branch here fails loudly instead — which is the point of stating it.
  */
  throw new AppError(
    'invariant_violated',
    `"${String(mode)}" is not a commission rounding mode. The modes are ` +
      `${COMMISSION_ROUNDING_MODES.join(' and ')}; a new one is a new member of ` +
      'commission_rule.rounding_mode AND a branch in commissionFilsFor.',
  )
}

/**
 * Refuses a rule version that cannot be applied, rather than letting it produce a figure.
 *
 * The same rule `assert_commission_bands_cover_from_zero` (ZY073) holds in the database, stated twice on
 * purpose and for 0086's recorded reason: the trigger answers a `psql` session and an import, and this
 * answers a rule set a test or a caller constructed in memory, which no trigger ever sees. The failure
 * either one prevents is the same and is silent — a version whose lowest band starts above zero has NO
 * rate for the cheapest treatments, and the plausible thing for a reader to do about that is charge zero.
 */
export function assertCommissionRuleVersion(version: CommissionRuleVersion): void {
  if (version.bands.length === 0) {
    throw new AppError(
      'validation',
      `Commission rule version ${version.version} has no bands, so no rate applies to anything. An ` +
        'empty version is not a zero-rate policy: it is a version somebody forgot to finish, and the ' +
        'two must not compute the same answer.',
    )
  }
  const ordered = [...version.bands].sort((a, b) => a.bandNo - b.bandNo)
  const first = ordered[0]
  if (first === undefined || first.bandNo !== 1 || first.fromFils !== 0) {
    throw new AppError(
      'validation',
      `Commission rule version ${version.version} starts at band ` +
        `${String(first?.bandNo)} from ${String(first?.fromFils)} fils. Band 1 must start at 0, or an ` +
        'appointment below the lowest threshold is commissioned at whatever the reader decides — a ' +
        'therapist quietly unpaid for the cheapest treatments.',
    )
  }
  for (const [index, band] of ordered.entries()) {
    if (band.bandNo !== index + 1) {
      throw new AppError(
        'validation',
        `Commission rule version ${version.version} has a gap in its band numbers at ${band.bandNo}. ` +
          'The bands are ordered by bandNo and the numbering is what the order means.',
      )
    }
    if (!Number.isInteger(band.fromFils) || band.fromFils < 0) {
      throw new AppError(
        'validation',
        `Band ${band.bandNo} of commission rule version ${version.version} starts at ` +
          `${band.fromFils} fils, which is not a threshold. Money is integer fils (ADR 0007).`,
      )
    }
    if (!Number.isInteger(band.rateBp) || band.rateBp < 0 || band.rateBp > 10_000) {
      throw new AppError(
        'validation',
        `Band ${band.bandNo} of commission rule version ${version.version} pays ${band.rateBp} basis ` +
          'points, which is outside 0..10000.',
      )
    }
    const previous = ordered[index - 1]
    if (previous !== undefined && band.fromFils <= previous.fromFils) {
      throw new AppError(
        'validation',
        `Band ${band.bandNo} of commission rule version ${version.version} starts at ` +
          `${band.fromFils} fils, which is not above band ${previous.bandNo}'s ${previous.fromFils}. ` +
          'A reader that re-sorted the bands would silently repair a version somebody entered wrongly, ' +
          'and the repair is what makes the wrong version undetectable.',
      )
    }
  }
}

/**
 * The version that governs a trading date: the latest one effective at or before it.
 *
 * `rulesFor` in `./rates.ts` one subject along, and the same three decisions. `versions` may arrive in any
 * order because the caller is usually a SQL read and an `order by` is easy to lose. It throws when nothing
 * governs the date, which for THIS table is the ordinary state rather than an anomaly: `commission_rule`
 * seeds no version, because Y9-commission's provisional answer is that no structure is configured. The
 * caller's job is to report that the module has nothing to apply — never to default to a rate, which would
 * be indistinguishable from a configured one on the payslip that resulted.
 *
 * **This is for a NEW run only.** A recompute of an existing run uses the version stored on that run. A
 * recompute that came back here would answer with whatever is in force today, which is the defect this
 * whole unit is about.
 */
export function commissionRuleFor(
  versions: readonly CommissionRuleVersion[],
  tradingDate: LocalDate,
): CommissionRuleVersion {
  let governing: CommissionRuleVersion | undefined
  for (const version of versions) {
    if (version.effectiveFrom > tradingDate) continue
    if (governing === undefined || version.effectiveFrom > governing.effectiveFrom) {
      governing = version
    }
  }
  if (governing === undefined) {
    throw new AppError(
      'not_found',
      `No commission rule version is effective on or before ${tradingDate}. Nothing is seeded, because ` +
        'Y9-commission is open and its provisional answer is that no commission structure is ' +
        'configured — so this is the ordinary state and not a missing row. Report that the module has ' +
        'no rule to apply; a default rate here would be a commission nobody agreed to.',
    )
  }
  assertCommissionRuleVersion(governing)
  return governing
}

/** The figure the rate applies to, from the source document and the version's `basis`. */
export function commissionBasisFilsFor(
  earning: Pick<CommissionEarning, 'grossFils' | 'vatFils'>,
  basis: CommissionBasis,
): number {
  if (!Number.isInteger(earning.grossFils) || !Number.isInteger(earning.vatFils)) {
    throw new AppError(
      'validation',
      `A source document of ${earning.grossFils} gross and ${earning.vatFils} VAT fils is not integer ` +
        'fils (ADR 0007).',
    )
  }
  if (earning.vatFils > earning.grossFils || earning.vatFils < 0 || earning.grossFils < 0) {
    throw new AppError(
      'validation',
      `A source document cannot carry ${earning.vatFils} VAT fils on ${earning.grossFils} gross. VAT is ` +
        'derived as gross - net so that net + vat = gross exactly (ADR 0007), which makes VAT above ' +
        'gross a negative net.',
    )
  }
  // Gross-inclusive is authoritative and net is DERIVED as gross - vat, never recomputed from a rate
  // (ADR 0007). Re-deriving it here would be a second answer to what the document's net is, and the two
  // would differ by a fil on exactly the lines where the rounding of the VAT split mattered.
  return basis === 'gross_inclusive' ? earning.grossFils : earning.grossFils - earning.vatFils
}

/** The band a basis falls in: the greatest threshold at or below it. */
export function commissionBandFor(
  version: CommissionRuleVersion,
  basisFils: number,
): CommissionBand {
  assertCommissionRuleVersion(version)
  let chosen: CommissionBand | undefined
  for (const band of version.bands) {
    if (band.fromFils > basisFils) continue
    if (chosen === undefined || band.fromFils > chosen.fromFils) chosen = band
  }
  if (chosen === undefined) {
    // Unreachable: `assertCommissionRuleVersion` has just held band 1 to starting at 0, and a basis is
    // non-negative. Answered rather than asserted with `!`, which is how an impossible state becomes a
    // crash on the one input where it is not impossible.
    throw new AppError(
      'invariant_violated',
      `Commission rule version ${version.version} has no band covering ${basisFils} fils, although its ` +
        'bands were just held to starting at 0.',
    )
  }
  return chosen
}

/**
 * Every earning commissioned under one version, in a stated order, with the total.
 *
 * The order is `(tradingDate, appointmentId)` and it is part of the answer rather than an implementation
 * detail: "recomputing reproduces every line byte-identically" is a claim about a SEQUENCE, and a sequence
 * taken from whatever order the caller's SQL returned is stable until the planner changes its mind.
 *
 * A duplicate appointment is refused rather than commissioned twice. `commission_line_once_per_run` refuses
 * the same row, and the reason to refuse it here as well is that the database's refusal arrives as a
 * constraint violation on the second INSERT of a transaction that has already computed a wrong total — so
 * the caller would see a unique violation and not "this period was read twice".
 */
export function computeCommission(args: {
  readonly ruleVersion: CommissionRuleVersion
  readonly earnings: readonly CommissionEarning[]
}): CommissionComputation {
  const { ruleVersion, earnings } = args
  assertCommissionRuleVersion(ruleVersion)

  const seen = new Set<string>()
  for (const earning of earnings) {
    if (seen.has(earning.appointmentId)) {
      throw new AppError(
        'invariant_violated',
        `Appointment ${earning.appointmentId} appears twice in one commission period. An appointment is ` +
          'billed once (invoice_appointment_appointment_once, 0063) and redeemed once ' +
          '(package_redemption_appointment_once, 0083), so two earnings for one appointment is a read ' +
          'that joined twice rather than a treatment that happened twice.',
      )
    }
    seen.add(earning.appointmentId)
  }

  const ordered = [...earnings].sort((a, b) =>
    a.tradingDate === b.tradingDate
      ? a.appointmentId.localeCompare(b.appointmentId)
      : a.tradingDate.localeCompare(b.tradingDate),
  )

  const lines: CommissionLine[] = []
  let totalFils = 0
  for (const earning of ordered) {
    const basisFils = commissionBasisFilsFor(earning, ruleVersion.basis)
    const band = commissionBandFor(ruleVersion, basisFils)
    const commissionFils = commissionFilsFor(basisFils, band.rateBp, ruleVersion.roundingMode)
    lines.push({
      appointmentId: earning.appointmentId,
      employeeId: earning.employeeId,
      tradingDate: earning.tradingDate,
      source: earning.source,
      invoiceId: earning.invoiceId,
      packageRedemptionId: earning.packageRedemptionId,
      basisFils,
      bandNo: band.bandNo,
      rateBp: band.rateBp,
      commissionFils,
    })
    totalFils += commissionFils
  }

  return { ruleVersionId: ruleVersion.ruleVersionId, lines, totalFils }
}

/**
 * Whether a run should produce lines at all.
 *
 * A separate function from {@link computeCommission} and not a flag inside it, because "the module is off"
 * and "nobody earned anything" must never be the same answer: both are an empty line set, and only one of
 * them means no commission is due. The caller records {@link CommissionRunPlan.moduleEnabled} on the run
 * (`commission_run.module_enabled`) so the screen can say which.
 */
export interface CommissionRunPlan {
  readonly moduleEnabled: boolean
  /** Null when the module is off, or when no version governs the period. */
  readonly ruleVersion: CommissionRuleVersion | null
  /** Why there is nothing to apply, for a screen. Null when there is. */
  readonly inertReason: 'module_disabled' | 'no_rule_version' | null
}

/**
 * What a run over `periodStartsOn` can do, given the flag and the published versions.
 *
 * The flag is checked BEFORE the versions, and the order is the answer to a real question: with the module
 * off and no version published, both reasons are true and a screen must show the one an operator can act
 * on. Turning the module on is a settings change; publishing a version is a migration. So the flag is
 * reported first.
 */
export function planCommissionRun(args: {
  readonly moduleEnabled: boolean
  readonly versions: readonly CommissionRuleVersion[]
  readonly periodStartsOn: LocalDate
}): CommissionRunPlan {
  if (!args.moduleEnabled) {
    return { moduleEnabled: false, ruleVersion: null, inertReason: 'module_disabled' }
  }
  try {
    return {
      moduleEnabled: true,
      ruleVersion: commissionRuleFor(args.versions, args.periodStartsOn),
      inertReason: null,
    }
  } catch {
    // The only throw `commissionRuleFor` makes for an absent version, and it is the ORDINARY state: no
    // version is seeded. Swallowed into a reported reason rather than propagated, because a screen asking
    // "is there anything to run" must not 500 on the answer "no".
    return { moduleEnabled: true, ruleVersion: null, inertReason: 'no_rule_version' }
  }
}

/**
 * Who may read whose derivation.
 *
 * Two facts and they are independent, which is why this is not `can(role, 'commission:read')` alone: the
 * permission says whether a role may see commission at all, and this says WHOSE. `therapist` holds
 * `commission:read` precisely so somebody can check their own payslip, and a therapist who could pass
 * another employee's id would be reading a colleague's earnings — which is the same class of fact as a
 * wage, and `ROLE_DEFINITIONS` says a therapist never sees one.
 *
 * `owner`, `manager` and `accountant` hold `payroll:read` as well, and that is the permission that means
 * "may see other people's pay". Deriving the answer from the two grants rather than from a role list is
 * what stops this drifting from the matrix: a role given `payroll:read` tomorrow gets the wider view
 * without an edit here, and a role that loses it loses the view.
 */
export function mayReadCommissionDerivation(args: {
  readonly role: Role
  readonly viewerEmployeeId: string
  readonly subjectEmployeeId: string
}): boolean {
  if (!can(args.role, 'commission:read')) return false
  if (can(args.role, 'payroll:read')) return true
  return args.viewerEmployeeId === args.subjectEmployeeId
}

/** {@link mayReadCommissionDerivation} as a refusal, for a route. */
export function assertMayReadCommissionDerivation(args: {
  readonly role: Role
  readonly viewerEmployeeId: string
  readonly subjectEmployeeId: string
}): void {
  if (mayReadCommissionDerivation(args)) return
  throw new AppError(
    'forbidden',
    !can(args.role, 'commission:read')
      ? `Role "${args.role}" may not read commission at all.`
      : `Role "${args.role}" may read only their own commission derivation, and this request names ` +
          "another employee. Reading a colleague's earnings is reading their pay, which needs " +
          'payroll:read.',
    {
      details: {
        role: args.role,
        viewerEmployeeId: args.viewerEmployeeId,
        subjectEmployeeId: args.subjectEmployeeId,
      },
    },
  )
}
