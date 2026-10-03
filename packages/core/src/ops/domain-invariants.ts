/**
 * The four domain invariants docs/14 §3 calls non-negotiable, as DATA and a pure verdict over a census.
 *
 * B-M1. The section's own words, in its own order:
 *
 *   *no double-booked therapist · no room over capacity · nothing scheduled past close once turnaround
 *   is counted · an after-midnight slot resolves to the correct business day*
 *
 * ## Why a CENSUS and not a registry of tests
 *
 * `MONEY_INVARIANTS` (ADR 0074) is a registry of existing tests, and the argument for that shape was
 * that every one of the seven money claims is already proved in the only place it can be. These four
 * are different: each is already enforced by the DATABASE — an exclusion constraint, a capacity
 * trigger, and the availability solver that decides what may be offered — and what nothing checks is
 * whether the ESTATE those guards protect actually holds. The acceptance line asks for exactly that
 * difference: *"a deliberately broken fixture (an appointment inserted past close) is proven to fail
 * the invariant job"*. A row planted with the guard dropped, or written before the guard existed, or
 * imported from the previous arrangement (`appointment.migrated`), satisfies every test in the
 * repository and breaks every one of these claims.
 *
 * So this re-derives each claim over every row the database holds, the way `pnpm money-invariants`
 * re-adds every money identity over every row rather than over the rows one fixture wrote.
 *
 * ## Why the judgement is here and the SQL is in `packages/fixtures`
 *
 * `packages/core` is pure and may read neither a database nor a clock (`pnpm purity`), so the four
 * queries live in `packages/fixtures/src/domain-invariants.ts` — the one package that may import both
 * `@berelax/core` and `@berelax/db` (brief rule 4). What is here is the claim list, the rule names and
 * the verdict, so a test reaches all three without a database. A judgement that lives in a script is a
 * judgement no test reaches, which is `go-live-payments.mjs`'s stated reason for the same split.
 *
 * ## The floors, which are most of the value
 *
 * Every claim is a query returning the rows that BREAK it, and an empty result is a pass. So a wrong
 * join, a filter that matched nothing, or an empty table produces four passes about nothing — ADR
 * 0002's shape pointed at the four claims docs/14 says run on every unit regardless of what changed.
 * {@link domainInvariantProblems} therefore refuses a census that examined no appointment, no room or
 * no trading date, and REPORTS the after-midnight population rather than hiding it: claim four is
 * about a 01:30 start belonging to the previous trading date, and a database holding no such
 * appointment has not exercised it (brief rule 22).
 */

/** Rule names, printed verbatim by the script so a gate case can assert the rule (ADR 0003). */
export const DOMAIN_INVARIANT_RULES = {
  doubleBookedTherapist: 'domain-invariant-therapist-double-booked',
  roomOverCapacity: 'domain-invariant-room-over-capacity',
  pastClose: 'domain-invariant-scheduled-past-close',
  wrongBusinessDay: 'domain-invariant-wrong-business-day',
  /** A trading date an appointment claims and `business_day` does not hold at all. */
  dayNotTrading: 'domain-invariant-trading-date-is-not-a-trading-day',
  /** The floor: a census that examined nothing reports four passes about nothing. */
  examinedNothing: 'domain-invariant-census-examined-nothing',
} as const

export interface DomainInvariant {
  readonly id: string
  /** docs/14 §3's own words for this claim. */
  readonly claim: string
  /** Where the rule is stated once, and therefore what a breach means. */
  readonly oneStatement: string
  /** The rule a breach of it is reported under. */
  readonly rule: string
}

/** The four, in docs/14 §3's order. */
export const DOMAIN_INVARIANTS: readonly DomainInvariant[] = Object.freeze([
  Object.freeze({
    id: 'NO_DOUBLE_BOOKED_THERAPIST',
    claim: 'no double-booked therapist',
    oneStatement:
      'the exclusion constraint appointment_therapist_no_overlap — EXCLUDE USING gist (therapist_id ' +
      'WITH =, period WITH &&) WHERE (holds_resources), packages/db/migrations/0038_booking_' +
      'transaction.sql. The census re-derives it as a self-join, so a row written while the ' +
      'constraint was dropped, deferred or not yet created is still found',
    rule: DOMAIN_INVARIANT_RULES.doubleBookedTherapist,
  }),
  Object.freeze({
    id: 'NO_ROOM_OVER_CAPACITY',
    claim: 'no room over capacity',
    oneStatement:
      'assert_room_capacity() raising ZB001, over room_peak_concurrency(room_id, period) — the ONE ' +
      'statement of how many client places a room holds at an instant. The census calls that same ' +
      'function for every row, so the two cannot come to disagree about what capacity means',
    rule: DOMAIN_INVARIANT_RULES.roomOverCapacity,
  }),
  Object.freeze({
    id: 'NOTHING_PAST_CLOSE_WITH_TURNAROUND',
    claim: 'nothing scheduled past close once turnaround is counted',
    oneStatement:
      'hoursOverrideStrandedAppointments in packages/core/src/availability/hours-override.ts: an ' +
      'appointment holds its room for its own turnaround after the treatment ends, and the close is ' +
      'INCLUSIVE — a treatment plus its turnaround may end exactly at close and nothing may start ' +
      'there. The census applies that comparison against the business_day row for each appointment',
    rule: DOMAIN_INVARIANT_RULES.pastClose,
  }),
  Object.freeze({
    id: 'AFTER_MIDNIGHT_BUSINESS_DAY',
    claim: 'an after-midnight slot resolves to the correct business day',
    oneStatement:
      'resolveTradingDate in packages/core/src/business-day/resolve.ts and the business_day table it ' +
      'is derived into: trading runs 11:00-02:00, so 01:30 belongs to the PREVIOUS trading date ' +
      '(brief rule 7). The census holds every appointment start inside the window of the trading date ' +
      'its own row claims, which is the same statement read backwards',
    rule: DOMAIN_INVARIANT_RULES.wrongBusinessDay,
  }),
])

/** One breach, named in the words a reader needs to find the row. */
export interface DomainBreach {
  readonly rule: string
  readonly detail: string
}

/**
 * What the census counted and what it found.
 *
 * The counts are not decoration: every list below is "the rows that break this claim", so an empty
 * list is a pass and the counts are the only thing that distinguishes a clean estate from a query that
 * read nothing.
 */
export interface DomainInvariantCensus {
  readonly appointmentsExamined: number
  readonly roomsExamined: number
  readonly tradingDatesExamined: number
  /**
   * Appointments starting after midnight and before the following day's opening.
   *
   * The population claim four is ABOUT. Reported rather than asserted, because a database with none of
   * them has not exercised that claim and the honest answer is to say so (brief rule 22).
   */
  readonly afterMidnightExamined: number
  readonly therapistOverlaps: readonly DomainBreach[]
  readonly roomsOverCapacity: readonly DomainBreach[]
  readonly pastClose: readonly DomainBreach[]
  readonly wrongBusinessDay: readonly DomainBreach[]
  readonly daysNotTrading: readonly DomainBreach[]
}

export interface DomainInvariantProblem {
  readonly rule: string
  readonly detail: string
}

/**
 * Every breach, plus the floors that stop an empty census reading as a clean one.
 *
 * Applied by `scripts/domain-invariants.mjs` and by
 * `packages/fixtures/src/domain-invariants.itest.ts`, which plants one breach per claim with the
 * database's own guard dropped inside a rolled-back transaction — so each of the four is watched
 * failing (ADR 0003) rather than assumed to be checkable.
 */
export function domainInvariantProblems(
  census: DomainInvariantCensus,
): readonly DomainInvariantProblem[] {
  const problems: DomainInvariantProblem[] = []
  const bad = (rule: string, detail: string) => problems.push({ rule, detail })

  // The floors first. Everything below is a list of rows that break a claim, and an empty list is a
  // pass — so a census that read nothing passes every claim it makes.
  if (census.appointmentsExamined === 0) {
    bad(
      DOMAIN_INVARIANT_RULES.examinedNothing,
      'no appointment was examined, so all four claims would pass over an empty estate. A freshly ' +
        'migrated and seeded database holds no appointment at all, so this is a real state and not a ' +
        'hypothetical one: run the census against a database the suites have written to',
    )
  }
  if (census.roomsExamined === 0) {
    bad(
      DOMAIN_INVARIANT_RULES.examinedNothing,
      'no room was examined, so "no room over capacity" is a claim about no rooms',
    )
  }
  if (census.tradingDatesExamined === 0) {
    bad(
      DOMAIN_INVARIANT_RULES.examinedNothing,
      'no trading date was examined, so the close and the business-day claims are both comparisons ' +
        'against an empty calendar',
    )
  }

  for (const breach of census.therapistOverlaps) bad(breach.rule, breach.detail)
  for (const breach of census.roomsOverCapacity) bad(breach.rule, breach.detail)
  for (const breach of census.pastClose) bad(breach.rule, breach.detail)
  for (const breach of census.wrongBusinessDay) bad(breach.rule, breach.detail)
  for (const breach of census.daysNotTrading) bad(breach.rule, breach.detail)
  return problems
}

/**
 * The census, rendered. Deterministic, so a snapshot test is a real test.
 *
 * The after-midnight population is printed on every run, clean or not. It is the one figure that says
 * whether claim four was exercised at all, and a figure that only appears when something is wrong is a
 * figure nobody reads.
 */
export function renderDomainInvariantCensus(
  census: DomainInvariantCensus,
  problems: readonly DomainInvariantProblem[] = domainInvariantProblems(census),
): string {
  const lines: string[] = ['DOMAIN INVARIANTS (docs/14 §3)', '']
  const counts: Readonly<Record<string, number>> = {
    NO_DOUBLE_BOOKED_THERAPIST: census.therapistOverlaps.length,
    NO_ROOM_OVER_CAPACITY: census.roomsOverCapacity.length,
    NOTHING_PAST_CLOSE_WITH_TURNAROUND: census.pastClose.length + census.daysNotTrading.length,
    AFTER_MIDNIGHT_BUSINESS_DAY: census.wrongBusinessDay.length,
  }
  for (const invariant of DOMAIN_INVARIANTS) {
    const breaches = counts[invariant.id] ?? 0
    lines.push(`  ${breaches === 0 ? 'HOLDS ' : 'BREACH'}  ${invariant.id} — ${invariant.claim}`)
    if (breaches > 0) lines.push(`          ${breaches} breach(es)`)
  }
  lines.push('')
  lines.push(
    `examined: ${census.appointmentsExamined} appointment(s), ${census.roomsExamined} room(s), ` +
      `${census.tradingDatesExamined} trading date(s), of which ` +
      `${census.afterMidnightExamined} appointment(s) start after midnight`,
  )
  if (census.afterMidnightExamined === 0 && census.appointmentsExamined > 0) {
    lines.push(
      'NO appointment in this estate starts after midnight, so "an after-midnight slot resolves to ' +
        'the correct business day" held over a population of zero. The claim is not false; it was not ' +
        'exercised (brief rule 22)',
    )
  }
  lines.push('')
  if (problems.length === 0) {
    lines.push('VERDICT: all four hold')
    return lines.join('\n')
  }
  lines.push(`VERDICT: ${problems.length} problem(s)`)
  for (const problem of problems) lines.push(`  [${problem.rule}] ${problem.detail}`)
  return lines.join('\n')
}
