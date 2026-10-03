import { AppError } from '@berelax/shared'
import { filsFrom, formatMoney, money } from '../money.ts'
import { SCHEMA_DAY_NAMES } from './jsonld/business.ts'

/**
 * What the website says against what Google shows: the comparison, as a pure function.
 *
 * docs/09's NAP section is the subject and docs/13 §2 is the premises it is about. The reason the check
 * exists is not tidiness: an AI assistant asked *"when does Be Relax close?"* reads whichever source it
 * can see, and when the two disagree it answers confidently and wrongly under the business's own name.
 * The same is true of a price. So the output is a FINDING that quotes **both** values and says where each
 * one came from, rather than a boolean or a "fix it" instruction — because which of the two is wrong is
 * not a thing this module can know.
 *
 * ## Why the Google side carries its provenance and the website side does not carry a time
 *
 * There is no Business Profile API access in this build (docs/10 §4, `OPEN-QUESTIONS Y3-gbp-api` — an
 * application nobody has answered). The degraded mode `localSeoChecker` declares is `manual_snapshot`,
 * and a manual snapshot is **a human's claim about what Google shows**, not an observation this system
 * made. Those are different facts and a report that rendered them identically would be making the
 * stronger claim on the weaker evidence.
 *
 * So {@link GbpFactProvenance} is a union, the manual arm carries **who said so and when**, and every
 * finding names the provenance of each of its two values. A reader can therefore tell *"Google shows X"*
 * from *"somebody told us on Tuesday that Google shows X"*, which is the difference between a finding
 * they can act on and one they should go and check.
 *
 * ## Why one finding per DISAGREEMENT and not per day
 *
 * A closing time that is wrong on the profile is wrong on all seven days, and seven findings for one
 * mistake is ADR 0085's cry-wolf failure in miniature: a reader who scrolls past a wall of identical
 * rows has learned to scroll past the section. So days that disagree in the same way are ONE finding
 * carrying the days it covers, and the acceptance criterion is stated in those terms — a whole-week
 * closing-time divergence plus one price is exactly two findings.
 *
 * ## Pure
 *
 * No clock, no I/O, no database. Both sides arrive as arguments, which is what lets one test judge a
 * seeded divergence against a fixture and `gbp-consistency.itest.ts` judge the same comparison against
 * `premises_hours` and the price in force read out of the database. It holds no address, no telephone
 * number and no opening-hour literal: `packages/fixtures/src/seo-nap-literals.test.ts` is the scan that
 * keeps that true, because a module with its own copy of the hours answers "consistent" about itself.
 */

/** Every rule this comparison can report, by name. A caller branches on these, never on prose. */
export const GBP_CONSISTENCY_RULES = [
  /** The profile and the premises row disagree about when the business is open. */
  'opening_hours_disagree',
  /** The profile and the price in force disagree about what a service costs. */
  'service_price_disagrees',
] as const
export type GbpConsistencyRule = (typeof GBP_CONSISTENCY_RULES)[number]

/**
 * Where one value in a comparison came from.
 *
 * The two website authorities are named separately because they are different rows with different
 * owners: the hours are `premises_hours` (0003), and the price is the **price in force** — an
 * effective-dated `price_list` row (0025) and never `service_variant.gross_price_fils`, for the reason
 * `CataloguePriceRow` records. A single `'website'` label would let a reader think one row answered both.
 */
export type GbpFactProvenance =
  | { readonly side: 'website'; readonly authority: 'premises_hours_row' | 'price_in_force' }
  /** Read from Business Information v1. Only reachable with API access, which this build has not got. */
  | { readonly side: 'google'; readonly authority: 'business_information_v1' }
  /**
   * A human's claim about what the Google profile shows.
   *
   * `claimedBy` and `claimedAtIso` are REQUIRED, not optional. An unattributed claim is indistinguishable
   * from an observation, which is exactly the confusion this arm exists to prevent (the brief's rule 15
   * one step out: a plausible provenance is worse than a blank one).
   */
  | {
      readonly side: 'google'
      readonly authority: 'manual_snapshot'
      readonly claimedBy: string
      readonly claimedAtIso: string
    }

/** One value in a finding: what it says, and where it came from. */
export interface GbpComparedValue {
  /** The value as a person reads it. Formatted here so the two sides cannot be formatted differently. */
  readonly value: string
  readonly provenance: GbpFactProvenance
}

export interface GbpConsistencyFinding {
  readonly rule: GbpConsistencyRule
  /** What the finding is about: the days, or the service and duration. */
  readonly subject: string
  readonly website: GbpComparedValue
  readonly google: GbpComparedValue
  /** Why it matters, in the words the weekly report uses. No instruction to change either side. */
  readonly why: string
}

/** A time of day as Business Information v1 structures it, and as `premises_hours` stores one. */
export interface GbpClockTime {
  readonly hours: number
  readonly minutes: number
}

/**
 * One day's trading, on either side.
 *
 * `dayOfWeek` is `premises_hours.day_of_week` — 0 is Sunday — and `SCHEMA_DAY_NAMES` is indexed the same
 * way, which is why the day name is read out of that array rather than written again here.
 *
 * A closed day carries no times. `isClosed` with an open and a close would be two claims about one day,
 * and the one a renderer honoured would be whichever it checked first.
 */
export type GbpDayHours =
  | {
      readonly dayOfWeek: number
      readonly isClosed: false
      readonly open: GbpClockTime
      readonly close: GbpClockTime
    }
  | { readonly dayOfWeek: number; readonly isClosed: true }

/** One price point to compare: a service at one duration, gross, in integer fils (ADR 0007). */
export interface GbpServicePrice {
  /** The stable key a comparison matches on. A slug, not a display name — a name is editable copy. */
  readonly serviceKey: string
  /** What the owner sees in a finding. */
  readonly label: string
  readonly durationMinutes: number
  readonly grossFils: number
}

export interface GbpConsistencyInput {
  readonly website: {
    readonly hours: readonly GbpDayHours[]
    readonly prices: readonly GbpServicePrice[]
  }
  readonly google: {
    /** How the Google side was obtained. Carried onto every Google value in every finding. */
    readonly provenance: Extract<GbpFactProvenance, { side: 'google' }>
    readonly hours: readonly GbpDayHours[]
    readonly prices: readonly GbpServicePrice[]
  }
}

/** Coverage per rule, beside the findings. ADR 0085 decision 4's reason: no subjects is not a pass. */
export interface GbpConsistencyCoverage {
  /** Days present on BOTH sides, which is the set the hours rule could have an opinion about. */
  readonly daysCompared: number
  /** Service-and-duration pairs present on both sides. */
  readonly pricesCompared: number
  /** Days or prices one side holds and the other does not. Reported, never compared. */
  readonly daysOnlyOnOneSide: readonly string[]
  readonly pricesOnlyOnOneSide: readonly string[]
}

export interface GbpConsistencyReport {
  readonly findings: readonly GbpConsistencyFinding[]
  readonly coverage: GbpConsistencyCoverage
}

const TWO = 2

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/** `HH:MM`, built from the numbers rather than written as a literal. See the header's NAP note. */
export function formatClockTime(time: GbpClockTime): string {
  return `${pad(time.hours)}:${pad(time.minutes)}`
}

/**
 * `HH:MM` to a structured time, or a refusal.
 *
 * Takes `HH:MM` and `HH:MM:SS`, because `premises_hours.open_time` is a `time` column and the driver
 * renders it with seconds. It refuses anything else rather than coercing: a snapshot form takes this
 * value from a person, and a silently-parsed `11pm` would compare as midnight and report a finding
 * against a value nobody entered.
 */
export function parseClockTime(text: string): GbpClockTime {
  const parts = text.trim().split(':')
  const refuse = (): never => {
    throw new AppError(
      'validation',
      `"${text}" is not a time of day. It must be two digits, a colon and two digits — a 24-hour ` +
        'time, because a time this build could not parse would be compared as midnight and would ' +
        'report a divergence against a value nobody entered.',
      { userFacing: true, details: { reason: 'gbp_clock_time_unreadable', text } },
    )
  }
  if (parts.length < TWO) refuse()
  const hours = Number(parts[0])
  const minutes = Number(parts[1])
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) refuse()
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) refuse()
  return { hours, minutes }
}

/**
 * An amount a person typed, as integer fils, or a refusal.
 *
 * Here rather than in `money.ts` because it is a parser for ONE form — the manual snapshot — and the
 * repository has no general "an amount a human typed" reader to extend. It is exact on purpose: `AED`,
 * thousands separators, a trailing full stop and a three-decimal figure are all refused rather than
 * coerced, because the number this produces is one side of a comparison that will be reported to the
 * owner as a divergence. A figure silently read as 30 instead of 300 manufactures a finding, and a
 * finding nobody can reproduce is worse than a blank field (ADR 0070's reasoning about an
 * unattributable figure, applied to an input).
 *
 * Money is integer fils and the gross is authoritative (ADR 0007), so two decimals and no more.
 */
export function parseGrossAedToFils(text: string): number {
  const trimmed = text.trim()
  const match = /^(\d{1,7})(?:\.(\d{2}))?$/.exec(trimmed)
  if (match === null) {
    throw new AppError(
      'validation',
      `"${text}" is not an amount in AED. It must be digits, optionally a full stop and exactly two ` +
        'more digits — no currency code, no thousands separator and no third decimal. A figure read as ' +
        '30 instead of 300 would manufacture a divergence nobody could reproduce.',
      { userFacing: true, details: { reason: 'gbp_amount_unreadable', text } },
    )
  }
  const major = Number(match[1])
  const minor = match[2] === undefined ? 0 : Number(match[2])
  return major * 100 + minor
}

/**
 * The day's trading as a person reads it, with the midnight crossing made visible.
 *
 * Trading runs past midnight (docs/13 §2, and `premises_hours.crosses_midnight` is a generated column
 * for it), so the close is numerically LESS than the open. A renderer that printed the pair without
 * saying so produces a range that reads backwards, and a reader comparing it against a profile would
 * conclude the premises is open for one hour.
 */
export function formatDayHours(day: GbpDayHours): string {
  if (day.isClosed) return 'closed'
  const crossesMidnight =
    day.close.hours * 60 + day.close.minutes <= day.open.hours * 60 + day.open.minutes
  return `${formatClockTime(day.open)}-${formatClockTime(day.close)}${
    crossesMidnight ? ' (the next day)' : ''
  }`
}

const dayName = (dayOfWeek: number): string => SCHEMA_DAY_NAMES[dayOfWeek] ?? `day ${dayOfWeek}`

/** `every day` for all seven, otherwise the day names. One finding may cover several days. */
function describeDays(days: readonly number[]): string {
  return days.length === SCHEMA_DAY_NAMES.length
    ? 'every day'
    : days.map((day) => dayName(day)).join(', ')
}

const priceKey = (price: GbpServicePrice): string => `${price.serviceKey}@${price.durationMinutes}`

/**
 * Compares the two sides and reports every disagreement, grouped.
 *
 * The grouping key for hours is the PAIR of rendered values, so a week whose closing time is wrong
 * everywhere is one finding and a week with two different mistakes is two. The alternative — one finding
 * per day — is the cry-wolf shape ADR 0085 names, and it is worse here than there because the rows are
 * identical: a reader cannot tell seven copies of one problem from seven problems.
 *
 * A day or a price present on only one side is NOT a finding. It is reported as coverage, because the
 * comparison has nothing to say about it and a "missing" finding is indistinguishable from a divergence
 * when neither has a second value to quote. A profile with no hours at all is a different problem, and it
 * belongs to whoever owns the profile's completeness rather than to a consistency check.
 */
export function gbpConsistencyReport(input: GbpConsistencyInput): GbpConsistencyReport {
  const websiteDays = new Map(input.website.hours.map((day) => [day.dayOfWeek, day]))
  const googleDays = new Map(input.google.hours.map((day) => [day.dayOfWeek, day]))

  const hoursGroups = new Map<
    string,
    { readonly site: string; readonly gbp: string; days: number[] }
  >()
  const daysOnlyOnOneSide: string[] = []
  let daysCompared = 0

  for (const dayOfWeek of [...new Set([...websiteDays.keys(), ...googleDays.keys()])].sort(
    (a, b) => a - b,
  )) {
    const site = websiteDays.get(dayOfWeek)
    const gbp = googleDays.get(dayOfWeek)
    if (site === undefined || gbp === undefined) {
      daysOnlyOnOneSide.push(dayName(dayOfWeek))
      continue
    }
    daysCompared += 1
    const siteText = formatDayHours(site)
    const gbpText = formatDayHours(gbp)
    if (siteText === gbpText) continue
    const key = `${siteText}\u0000${gbpText}`
    const group = hoursGroups.get(key)
    if (group === undefined) {
      hoursGroups.set(key, { site: siteText, gbp: gbpText, days: [dayOfWeek] })
    } else {
      group.days.push(dayOfWeek)
    }
  }

  const findings: GbpConsistencyFinding[] = []
  for (const group of hoursGroups.values()) {
    findings.push({
      rule: 'opening_hours_disagree',
      subject: describeDays(group.days),
      website: {
        value: group.site,
        provenance: { side: 'website', authority: 'premises_hours_row' },
      },
      google: { value: group.gbp, provenance: input.google.provenance },
      why:
        'A visitor who reads the Google profile and a visitor who reads the website are told different ' +
        'closing times, and an assistant asked when this business closes answers from whichever it can ' +
        'see. One of the two is wrong and this check cannot say which.',
    })
  }

  const websitePrices = new Map(input.website.prices.map((price) => [priceKey(price), price]))
  const googlePrices = new Map(input.google.prices.map((price) => [priceKey(price), price]))
  const pricesOnlyOnOneSide: string[] = []
  let pricesCompared = 0

  for (const key of [...new Set([...websitePrices.keys(), ...googlePrices.keys()])].sort()) {
    const site = websitePrices.get(key)
    const gbp = googlePrices.get(key)
    if (site === undefined || gbp === undefined) {
      pricesOnlyOnOneSide.push(key)
      continue
    }
    pricesCompared += 1
    if (site.grossFils === gbp.grossFils) continue
    findings.push({
      rule: 'service_price_disagrees',
      subject: `${site.label} (${site.durationMinutes} minutes)`,
      website: {
        // `money(filsFrom(...))` and not `aedFrom`, which takes MAJOR units: the first version of this
        // line passed fils to `aedFrom` and rendered 350 AED as `AED 35,000.00`. `formatMoney` and
        // nothing else renders the figure, because a price rendered two ways is a price two readers
        // argue about.
        value: formatMoney(money(filsFrom(site.grossFils))),
        provenance: { side: 'website', authority: 'price_in_force' },
      },
      google: {
        value: formatMoney(money(filsFrom(gbp.grossFils))),
        provenance: input.google.provenance,
      },
      why:
        'A price quoted on the Google profile that the till will not charge is a complaint at the desk ' +
        'and a wrong answer from any assistant that reads the profile. The website figure is the price ' +
        'in force today, which is what a booking is taken at.',
    })
  }

  return {
    findings: Object.freeze(findings),
    coverage: {
      daysCompared,
      pricesCompared,
      daysOnlyOnOneSide: Object.freeze(daysOnlyOnOneSide),
      pricesOnlyOnOneSide: Object.freeze(pricesOnlyOnOneSide),
    },
  }
}

/**
 * The sentence a report puts beside a Google value, so the evidence travels with the finding.
 *
 * Separate from the finding because a renderer needs it once per report and not once per row, and
 * because it is the one place the manual arm's weaker claim is spelled out in words. A reader who sees
 * only *"Google shows 01:00"* has been told something this build does not know.
 */
export function describeGoogleProvenance(
  provenance: Extract<GbpFactProvenance, { side: 'google' }>,
): string {
  return provenance.authority === 'business_information_v1'
    ? 'The Google figures were read from the Business Profile API.'
    : `The Google figures are what ${provenance.claimedBy} recorded seeing on the profile on ` +
        `${provenance.claimedAtIso}. Nothing in this system has read the profile itself, so this is ` +
        'their account of it rather than an observation.'
}
