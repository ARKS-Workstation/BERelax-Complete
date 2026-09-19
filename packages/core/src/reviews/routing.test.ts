import { MINIMUM_REVIEW_COOLING_OFF_HOURS, REVIEW_AUTOSEND_SETTING_KEYS } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { type Instant, instantFromIso } from '../time.ts'
import {
  REVIEW_ESCALATION_LEXICON,
  REVIEW_ESCALATION_LEXICON_VERSION,
  reviewEscalationLexiconFor,
} from './escalation-lexicon.ts'
import {
  autoSendFloor,
  DOCUMENTED_ROW_SUBJECT,
  DOCUMENTED_ROWS,
  normaliseReviewPolicy,
  REVIEW_ROUTING_ROWS,
  REVIEW_ROUTING_RULES,
  REVIEW_ROUTING_TABLE,
  REVIEW_ROUTING_VERDICTS,
  type ReviewRoutingPolicy,
  type ReviewRoutingRow,
  type RoutableReview,
  replayReviewRouting,
  reviewRoutingRule,
  reviewVerdictForRule,
  routeReview,
} from './routing.ts'

/**
 * G-REV-03 — the docs/07 §4 table as an executable, settings-proof control.
 *
 * ## What this file asserts, and what it deliberately does not
 *
 * It does **not** restate the table. A test listing "rating 1 → escalate, rating 2 → escalate" beside a
 * module listing the same thing proves only that two lists were typed the same afternoon. So the structural
 * assertions here are about *properties* of the table — every declared category has exactly one route, the
 * set is closed, precedence has one source, there is exactly one permissive row — and the behavioural ones
 * drive the router over inputs a real database can hand it.
 *
 * The count of documented rows is asserted against the markdown table in
 * `docs/07-frontend-and-agents-requirements.md` by `packages/fixtures/src/review-routing-table.test.ts`,
 * because `packages/core` may not read a file. A row deleted from either side fails there.
 *
 * ## Every control is present
 *
 * Every safety assertion has a pair that must produce the permissive answer. A router that returned
 * `escalate` unconditionally would satisfy the 1,764-combination settings test, the property test, the
 * totality tests and the lexicon tests — and would also mean the autoresponder can never send anything,
 * which is a defect and not a safe default. `auto_send` is therefore *reached* in this file, under exactly
 * the conditions docs/07 §4 names and no others.
 */

/** Asia/Dubai is where the listing is; these are instants, so the zone only matters to the reader. */
const REVIEWED_AT = instantFromIso('2026-09-10T18:22:00.000Z')
/** Well past the 24-hour floor: 3 days later. */
const LONG_AFTER = instantFromIso('2026-09-13T18:22:00.000Z')
/** A clock reading 23 hours after the review: inside the 24-hour floor. */
const NOW_TOO_SOON = instantFromIso('2026-09-11T17:22:00.000Z')

const STAR_ONLY = (rating: number, reviewedAt: Instant = REVIEWED_AT): RoutableReview => ({
  rating,
  commentText: null,
  reviewedAt,
})

const WITH_TEXT = (
  rating: number,
  commentText: string,
  reviewedAt: Instant = REVIEWED_AT,
): RoutableReview => ({ rating, commentText, reviewedAt })

/** The policy an owner who has deliberately enabled everything produces. The only permissive one. */
function enabledPolicy(now: Instant = LONG_AFTER): ReviewRoutingPolicy {
  return {
    now,
    autosendEnabledSetting: true,
    businessProfileAccessSetting: true,
    coolingOffHoursSetting: MINIMUM_REVIEW_COOLING_OFF_HOURS,
    replyLanguagesSetting: ['en', 'ar'],
    lexicon: REVIEW_ESCALATION_LEXICON,
  }
}

/** The policy a database with nothing configured produces: every setting absent. */
function defaultPolicy(now: Instant = LONG_AFTER): ReviewRoutingPolicy {
  return {
    now,
    autosendEnabledSetting: undefined,
    businessProfileAccessSetting: undefined,
    coolingOffHoursSetting: undefined,
    replyLanguagesSetting: undefined,
    lexicon: REVIEW_ESCALATION_LEXICON,
  }
}

describe('acceptance — the table is complete, closed, and has one route per category', () => {
  it('gives every declared category exactly one row, and declares every row', () => {
    const keys = Object.keys(REVIEW_ROUTING_ROWS)
    expect(keys.sort()).toEqual([...REVIEW_ROUTING_RULES].sort())
    expect(keys).toHaveLength(REVIEW_ROUTING_RULES.length)
    expect(new Set(REVIEW_ROUTING_RULES).size).toBe(REVIEW_ROUTING_RULES.length)
    // Each row's own `rule` field agrees with the key it is filed under. A `Record` proves the key exists;
    // this proves the row is the right one, which is the copy-paste mistake it cannot catch.
    for (const rule of REVIEW_ROUTING_RULES) {
      expect(REVIEW_ROUTING_ROWS[rule].rule, rule).toBe(rule)
    }
  })

  it('is a closed set: nothing outside it is a rule, and every member is', () => {
    for (const rule of REVIEW_ROUTING_RULES) expect(reviewRoutingRule(rule)).toBe(rule)
    for (const value of [
      'rating_escalate',
      'auto_send',
      '',
      'QUIET_HIGH_RATING_MAY_AUTO_SEND',
      undefined,
      null,
      1,
      {},
      ['rating_escalates'],
    ]) {
      expect(reviewRoutingRule(value), `${String(value)}`).toBeNull()
    }
  })

  it('derives the evaluated table from the declared order, so precedence has one source', () => {
    const evaluated = REVIEW_ROUTING_RULES.filter(
      (rule) => REVIEW_ROUTING_ROWS[rule].matches !== null,
    )
    expect(REVIEW_ROUTING_TABLE.map((row) => row.rule)).toEqual(evaluated)
    // Four rules are excluded from the evaluated table by construction, and each for its own reason: the
    // three structural ones cannot be expressed as a predicate over a context that could not be built,
    // and `auto_send_floor_violated` is what the router says AFTER the fold when the independent re-check
    // disagrees — a row that appeared in the loop would be a row the loop could satisfy.
    const excluded = REVIEW_ROUTING_RULES.filter(
      (rule) => REVIEW_ROUTING_ROWS[rule].matches === null,
    )
    expect(excluded).toEqual([
      'routing_table_unavailable',
      'routing_policy_unavailable',
      'unroutable_review',
      'auto_send_floor_violated',
    ])
    expect(REVIEW_ROUTING_TABLE).toHaveLength(REVIEW_ROUTING_RULES.length - excluded.length)
  })

  it('has exactly one permissive row, and it is last', () => {
    const permissive = REVIEW_ROUTING_TABLE.filter((row) => row.verdict === 'auto_send')
    expect(permissive.map((row) => row.rule)).toEqual(['quiet_high_rating_may_auto_send'])
    expect(REVIEW_ROUTING_TABLE.at(-1)?.rule).toBe('quiet_high_rating_may_auto_send')
    // Every rule id that is not that one means escalate, including the twelve others.
    for (const rule of REVIEW_ROUTING_RULES) {
      const expected = rule === 'quiet_high_rating_may_auto_send' ? 'auto_send' : 'escalate'
      expect(reviewVerdictForRule(rule), rule).toBe(expected)
    }
  })

  it('gives every row a verdict from the vocabulary and a reason worth reading', () => {
    for (const rule of REVIEW_ROUTING_RULES) {
      const row = REVIEW_ROUTING_ROWS[rule]
      expect(REVIEW_ROUTING_VERDICTS, rule).toContain(row.verdict)
      expect(row.why.length, rule).toBeGreaterThan(60)
      if (row.documentedRow !== null) expect(DOCUMENTED_ROWS, rule).toContain(row.documentedRow)
    }
  })

  it('implements every documented row, and attributes only the structural rules to none', () => {
    const covered = new Set(
      REVIEW_ROUTING_RULES.map((rule) => REVIEW_ROUTING_ROWS[rule].documentedRow).filter(
        (row): row is (typeof DOCUMENTED_ROWS)[number] => row !== null,
      ),
    )
    expect([...covered].sort()).toEqual([...DOCUMENTED_ROWS].sort())
    const structural = REVIEW_ROUTING_RULES.filter(
      (rule) => REVIEW_ROUTING_ROWS[rule].documentedRow === null,
    )
    expect(structural).toEqual([
      'routing_table_unavailable',
      'routing_policy_unavailable',
      'unroutable_review',
    ])
    // Row 2 is implemented by exactly one rule, which is what says the "1-2 star" cell has not quietly
    // grown a three-star reading.
    const rowTwo = REVIEW_ROUTING_RULES.filter(
      (rule) => REVIEW_ROUTING_ROWS[rule].documentedRow === 2,
    )
    expect(rowTwo).toEqual(['rating_escalates'])
    for (const row of DOCUMENTED_ROWS) {
      expect(DOCUMENTED_ROW_SUBJECT[row].length, `row ${row}`).toBeGreaterThan(5)
    }
  })
})

describe('acceptance — each documented row, against its documented handling', () => {
  it('row 2: a one- or two-star review is always escalated, star-only or not', () => {
    for (const rating of [1, 2]) {
      const quiet = routeReview({ review: STAR_ONLY(rating), policy: enabledPolicy() })
      expect(quiet.verdict, `${rating} star, star-only`).toBe('escalate')
      expect(quiet.rule).toBe('rating_escalates')
      expect(quiet.documentedRow).toBe(2)
      const texted = routeReview({
        review: WITH_TEXT(rating, 'Everything was perfect, thank you so much.'),
        policy: enabledPolicy(),
      })
      expect(texted.verdict, `${rating} star, with text`).toBe('escalate')
      expect(texted.rule).toBe('rating_escalates')
    }
  })

  it('row 3: any mention of the seven categories is escalated, at any rating in row 1 band', () => {
    for (const rating of [4, 5]) {
      const decision = routeReview({
        review: WITH_TEXT(rating, 'They charged my card twice and refused to refund.'),
        policy: enabledPolicy(),
      })
      expect(decision.verdict, `${rating} star`).toBe('escalate')
      expect(decision.rule).toBe('escalation_term_present')
      expect(decision.documentedRow).toBe(3)
      expect(decision.categories).toContain('refund')
      expect(decision.matches.map((m) => m.term)).toContain('refund')
    }
  })

  it('carries the escalation categories even when a higher row decided the verdict', () => {
    // Precedence follows docs/07 §4's row order, so a three-star review mentioning an injury is decided
    // by the rating band. The reason an operator has to read is not lost by that: `matches` and
    // `categories` are computed before the fold and ride on every decision, whichever row won.
    const decision = routeReview({
      review: WITH_TEXT(3, 'Lovely place but the massage bruised my shoulder.'),
      policy: enabledPolicy(),
    })
    expect(decision.rule).toBe('rating_below_auto_send_band')
    expect(decision.categories).toContain('injury')
    expect(decision.matches.map((match) => match.term)).toContain('bruised')
    // And the same holds for the row that outranks everything: a one-star review keeps its categories.
    const oneStar = routeReview({
      review: WITH_TEXT(
        1,
        'They charged my card twice and refused to refund. I am calling a lawyer.',
      ),
      policy: enabledPolicy(),
    })
    expect(oneStar.rule).toBe('rating_escalates')
    expect(oneStar.categories).toEqual(['refund', 'legal_threat'])
  })

  it('row 4: a five-star Tagalog review escalates with language_outside_configured_set', () => {
    const decision = routeReview({
      review: WITH_TEXT(5, 'Napakaganda ng lugar at ang masahe ay sobrang nakakarelax. Salamat!'),
      policy: enabledPolicy(),
    })
    expect(decision.verdict).toBe('escalate')
    expect(decision.rule).toBe('language_outside_configured_set')
    expect(decision.documentedRow).toBe(4)
    // The pair: the same shape of review in a configured language reaches a different row, so the rule
    // above was chosen for the language and not for being first.
    const english = routeReview({
      review: WITH_TEXT(
        5,
        'Best massage in Abu Dhabi. Very professional and the place is spotless.',
      ),
      policy: enabledPolicy(),
    })
    expect(english.rule).not.toBe('language_outside_configured_set')
    expect(english.verdict).toBe('escalate')
  })

  it('row 4: removing a language from the set escalates reviews in it', () => {
    const arabic = 'مكان ممتاز ونظيف، والخدمة رائعة. أنصح به بشدة.'
    const both = routeReview({ review: WITH_TEXT(5, arabic), policy: enabledPolicy() })
    expect(both.rule).not.toBe('language_outside_configured_set')
    const englishOnly = routeReview({
      review: WITH_TEXT(5, arabic),
      policy: { ...enabledPolicy(), replyLanguagesSetting: ['en'] },
    })
    expect(englishOnly.rule).toBe('language_outside_configured_set')
    expect(englishOnly.verdict).toBe('escalate')
  })

  it('row 1: a named individual escalates, and so does any free text at all', () => {
    const named = routeReview({
      review: WITH_TEXT(5, 'The therapist was excellent and the room was spotless.'),
      policy: enabledPolicy(),
    })
    expect(named.rule).toBe('names_an_individual')
    expect(named.documentedRow).toBe(1)
    // Text with no name and no escalation term still escalates, one row lower.
    const plain = routeReview({
      review: WITH_TEXT(5, 'the room was warm and the oil was very good, i will be back'),
      policy: enabledPolicy(),
    })
    expect(plain.rule).toBe('free_text_present')
    expect(plain.verdict).toBe('escalate')
  })

  it('row 1: the one permitted case, reached — 4 and 5 star, star-only, API mode, cooled off, enabled', () => {
    // The control the whole file needs. Without a reachable auto_send, every assertion above is satisfied
    // by a router that never sends anything, which is a broken autoresponder rather than a safe one.
    for (const rating of [4, 5]) {
      const decision = routeReview({ review: STAR_ONLY(rating), policy: enabledPolicy() })
      expect(decision.verdict, `${rating} star`).toBe('auto_send')
      expect(decision.rule).toBe('quiet_high_rating_may_auto_send')
      expect(decision.documentedRow).toBe(1)
      expect(decision.lexiconVersion).toBe(REVIEW_ESCALATION_LEXICON_VERSION)
      expect(decision.matches).toEqual([])
    }
  })

  it('row 1: and each of its four conditions, removed one at a time, names its own rule', () => {
    const base = enabledPolicy()
    expect(
      routeReview({
        review: STAR_ONLY(5),
        policy: { ...base, autosendEnabledSetting: false },
      }).rule,
    ).toBe('autosend_not_enabled')
    expect(
      routeReview({
        review: STAR_ONLY(5),
        policy: { ...base, businessProfileAccessSetting: false },
      }).rule,
    ).toBe('autosend_outside_api_mode')
    expect(routeReview({ review: STAR_ONLY(5), policy: enabledPolicy(NOW_TOO_SOON) }).rule).toBe(
      'cooling_off_not_elapsed',
    )
    // A lengthened cooling-off is honoured: three days is not enough when the owner asked for a week.
    expect(
      routeReview({ review: STAR_ONLY(5), policy: { ...base, coolingOffHoursSetting: 168 } }).rule,
    ).toBe('cooling_off_not_elapsed')
    // A three-star review is in NEITHER documented row, so it carries row 1's own band rule rather than
    // the "always escalated" one that was written about one- and two-star reviews.
    const three = routeReview({ review: STAR_ONLY(3), policy: base })
    expect(three.rule).toBe('rating_below_auto_send_band')
    expect(three.documentedRow).toBe(1)
    expect(three.verdict).toBe('escalate')
  })

  it('row 1: a shortened cooling-off does not shorten anything', () => {
    // 23 hours elapsed, and the setting says zero. The floor is 24, so this still escalates — which is the
    // whole of "no setting may relax it below its floor", in one assertion.
    const decision = routeReview({
      review: STAR_ONLY(5),
      policy: { ...enabledPolicy(NOW_TOO_SOON), coolingOffHoursSetting: 0 },
    })
    expect(decision.rule).toBe('cooling_off_not_elapsed')
    expect(decision.verdict).toBe('escalate')
    // The pair: past the floor, the same policy sends.
    expect(routeReview({ review: STAR_ONLY(5), policy: enabledPolicy() }).verdict).toBe('auto_send')
  })

  it('row 1: a review dated in the future escalates rather than counting as long-cooled', () => {
    const future = routeReview({
      review: STAR_ONLY(5, instantFromIso('2026-10-01T00:00:00.000Z')),
      policy: enabledPolicy(),
    })
    expect(future.rule).toBe('cooling_off_not_elapsed')
  })
})

describe('acceptance — a database with nothing configured never auto-sends', () => {
  it('escalates the one case that could otherwise be sent', () => {
    // Not simulated by passing `false`: simulated the way it arrives, with every setting absent.
    const decision = routeReview({ review: STAR_ONLY(5), policy: defaultPolicy() })
    expect(decision.verdict).toBe('escalate')
    expect(decision.rule).toBe('autosend_not_enabled')
  })

  it('applies the floor rather than trusting the caller to have applied it', () => {
    const normalised = normaliseReviewPolicy(defaultPolicy())
    expect(normalised.autosendEnabled).toBe(false)
    expect(normalised.replyMode).toBe('draft')
    expect(normalised.coolingOffHours).toBe(MINIMUM_REVIEW_COOLING_OFF_HOURS)
    expect(normalised.configuredLanguages).toEqual([])
  })
})

describe('acceptance — compliance-locked, not settings: every combination, one-star escalates', () => {
  /**
   * The raw values each setting can actually hold: the intended ones, the absent one, and the shapes a
   * form post or a half-finished migration produces.
   */
  const AUTOSEND: readonly unknown[] = [true, false, undefined, null, 'true', 1, {}]
  const ACCESS: readonly unknown[] = [true, false, undefined, null, 'api', 1]
  const COOLING: readonly unknown[] = [24, 0, -1, 168, undefined, 'immediately']
  const LANGUAGES: readonly unknown[] = [['en', 'ar'], ['en'], [], undefined, null, ['tl'], '*']

  const combinations = (): readonly ReviewRoutingPolicy[] => {
    const out: ReviewRoutingPolicy[] = []
    for (const autosendEnabledSetting of AUTOSEND) {
      for (const businessProfileAccessSetting of ACCESS) {
        for (const coolingOffHoursSetting of COOLING) {
          for (const replyLanguagesSetting of LANGUAGES) {
            out.push({
              now: LONG_AFTER,
              autosendEnabledSetting,
              businessProfileAccessSetting,
              coolingOffHoursSetting,
              replyLanguagesSetting,
              lexicon: REVIEW_ESCALATION_LEXICON,
            })
          }
        }
      }
    }
    return out
  }

  it('varies exactly the four settings the shared list names', () => {
    // The hole this closes: a fifth autosend-related setting added to the registry and not to
    // REVIEW_AUTOSEND_SETTING_KEYS would be an input this loop never varies, and the loop would go on
    // reporting that every combination escalates.
    expect(REVIEW_AUTOSEND_SETTING_KEYS).toHaveLength(4)
    expect(combinations()).toHaveLength(
      AUTOSEND.length * ACCESS.length * COOLING.length * LANGUAGES.length,
    )
  })

  it('escalates a one-star review under every one of them', () => {
    for (const policy of combinations()) {
      const decision = routeReview({ review: STAR_ONLY(1), policy })
      expect(decision.verdict).toBe('escalate')
      expect(decision.rule).toBe('rating_escalates')
    }
    // An explicit timeout, the same convention `solve.property.test.ts` uses. This loop is 1,764
    // routings and the acceptance line asks for every combination, so the cost is the requirement — and
    // under v8 coverage instrumentation on a machine running four suites at once it is several times the
    // 5s default. A test one second inside the default is a test that fails on somebody else's branch.
  }, 30_000)

  it('escalates a one-star review with text under every one of them', () => {
    for (const policy of combinations()) {
      const decision = routeReview({
        review: WITH_TEXT(1, 'They hurt my back and refused to refund. I am calling a lawyer.'),
        policy,
      })
      expect(decision.verdict).toBe('escalate')
    }
    // An explicit timeout, the same convention `solve.property.test.ts` uses. This loop is 1,764
    // routings and the acceptance line asks for every combination, so the cost is the requirement — and
    // under v8 coverage instrumentation on a machine running four suites at once it is several times the
    // 5s default. A test one second inside the default is a test that fails on somebody else's branch.
  }, 30_000)

  it('escalates a two-star review, and a five-star one mentioning an injury, under every one of them', () => {
    for (const policy of combinations()) {
      expect(routeReview({ review: STAR_ONLY(2), policy }).verdict).toBe('escalate')
      expect(
        routeReview({
          review: WITH_TEXT(5, 'Lovely place but the massage bruised my shoulder.'),
          policy,
        }).verdict,
      ).toBe('escalate')
    }
    // An explicit timeout, the same convention `solve.property.test.ts` uses. This loop is 1,764
    // routings and the acceptance line asks for every combination, so the cost is the requirement — and
    // under v8 coverage instrumentation on a machine running four suites at once it is several times the
    // 5s default. A test one second inside the default is a test that fails on somebody else's branch.
  }, 30_000)

  it('control — the same loop DOES auto-send the one permitted case, and only when both switches are true', () => {
    let sent = 0
    for (const policy of combinations()) {
      const decision = routeReview({ review: STAR_ONLY(5), policy })
      if (decision.verdict === 'auto_send') {
        sent += 1
        // Every auto_send is accounted for by the two booleans being exactly `true`, and by a cooling-off
        // the floor allows. Asserted independently of the router's own normalisers.
        expect(policy.autosendEnabledSetting).toBe(true)
        expect(policy.businessProfileAccessSetting).toBe(true)
        expect(policy.coolingOffHoursSetting).not.toBe(168)
      }
    }
    // 1 autosend value x 1 access value x 5 cooling values the floor permits at 72 hours elapsed
    // (24, 0, -1, undefined, 'immediately' all resolve to 24; 168 does not) x 7 language values.
    expect(sent).toBe(35)
    // An explicit timeout, the same convention `solve.property.test.ts` uses. This loop is 1,764
    // routings and the acceptance line asks for every combination, so the cost is the requirement — and
    // under v8 coverage instrumentation on a machine running four suites at once it is several times the
    // 5s default. A test one second inside the default is a test that fails on somebody else's branch.
  }, 30_000)
})

describe('acceptance — every route is total; nothing falls through to a reply', () => {
  it('escalates an absent, empty or non-array table', () => {
    for (const table of [[] as readonly ReviewRoutingRow[], null]) {
      const decision = routeReview({ review: STAR_ONLY(5), policy: enabledPolicy(), table })
      expect(decision.verdict).toBe('escalate')
      expect(decision.rule).toBe('routing_table_unavailable')
    }
    // `undefined` means "use the shipped table" rather than "no table", which is the one case that must
    // NOT escalate — otherwise the default call would never send anything and the distinction would be
    // untestable.
    expect(routeReview({ review: STAR_ONLY(5), policy: enabledPolicy() }).verdict).toBe('auto_send')
    expect(
      routeReview({ review: STAR_ONLY(5), policy: enabledPolicy(), table: undefined }).verdict,
    ).toBe('auto_send')
  })

  it('escalates a truncated table whose rows all decline', () => {
    // A hand-built table with only the cooling-off row in it: nothing matches a long-cooled review, and
    // falling off the end is `escalate`, not "no rule objected".
    const truncated = REVIEW_ROUTING_TABLE.filter((row) => row.rule === 'cooling_off_not_elapsed')
    const decision = routeReview({
      review: STAR_ONLY(5),
      policy: enabledPolicy(),
      table: truncated,
    })
    expect(decision.verdict).toBe('escalate')
    expect(decision.rule).toBe('routing_table_unavailable')
  })

  it('escalates a row that cannot say whether it applies', () => {
    // A row whose predicate is missing — deserialised, hand-built, half-edited — is treated as matching.
    // A row that has not said it does not apply has not declined.
    const broken: readonly ReviewRoutingRow[] = [
      { ...REVIEW_ROUTING_ROWS.free_text_present, matches: null },
      REVIEW_ROUTING_ROWS.quiet_high_rating_may_auto_send,
    ]
    const decision = routeReview({ review: STAR_ONLY(5), policy: enabledPolicy(), table: broken })
    expect(decision.verdict).toBe('escalate')
    expect(decision.rule).toBe('free_text_present')
  })

  it('escalates an absent or unreadable policy', () => {
    for (const policy of [null, undefined]) {
      const decision = routeReview({ review: STAR_ONLY(5), policy })
      expect(decision.verdict).toBe('escalate')
      expect(decision.rule).toBe('routing_policy_unavailable')
      // The version recorded is this build's, because this build is what refused.
      expect(decision.lexiconVersion).toBe(REVIEW_ESCALATION_LEXICON_VERSION)
    }
    for (const broken of [
      { ...enabledPolicy(), now: Number.NaN as Instant },
      { ...enabledPolicy(), lexicon: null as unknown as typeof REVIEW_ESCALATION_LEXICON },
      {
        ...enabledPolicy(),
        lexicon: { version: 7 } as unknown as typeof REVIEW_ESCALATION_LEXICON,
      },
    ]) {
      expect(routeReview({ review: STAR_ONLY(5), policy: broken }).rule).toBe(
        'routing_policy_unavailable',
      )
    }
  })

  it('escalates a review that is not a review', () => {
    const unroutable: readonly unknown[] = [
      null,
      undefined,
      {},
      { rating: 5 },
      { rating: 5, commentText: null },
      { rating: 0, commentText: null, reviewedAt: REVIEWED_AT },
      { rating: 6, commentText: null, reviewedAt: REVIEWED_AT },
      { rating: 4.5, commentText: null, reviewedAt: REVIEWED_AT },
      { rating: Number.NaN, commentText: null, reviewedAt: REVIEWED_AT },
      { rating: '5', commentText: null, reviewedAt: REVIEWED_AT },
      { rating: 5, commentText: null, reviewedAt: Number.NaN },
      { rating: 5, commentText: null, reviewedAt: '2026-09-10T18:22:00.000Z' },
      { rating: 5, commentText: 42, reviewedAt: REVIEWED_AT },
    ]
    for (const review of unroutable) {
      const decision = routeReview({
        review: review as RoutableReview | null | undefined,
        policy: enabledPolicy(),
      })
      expect(decision.verdict, JSON.stringify(review)).toBe('escalate')
      expect(decision.rule, JSON.stringify(review)).toBe('unroutable_review')
    }
  })

  it('reads an unrecognised stored rule id as escalate, never as auto_send', () => {
    for (const value of [
      undefined,
      null,
      '',
      'quiet_high_rating',
      'QUIET_HIGH_RATING_MAY_AUTO_SEND',
      'auto_send',
      'a_rule_a_later_build_added',
      0,
      1,
      {},
      { verdict: 'auto_send' },
      ['quiet_high_rating_may_auto_send'],
    ]) {
      expect(reviewVerdictForRule(value), `${String(value)}`).toBe('escalate')
    }
    // And the pair, so the function is not simply a constant.
    expect(reviewVerdictForRule('quiet_high_rating_may_auto_send')).toBe('auto_send')
  })

  it('does not read an inherited Object property as a rule', () => {
    // `ROWS['constructor']` would be a function on the prototype chain, and a lookup that did not check
    // ownership could read a truthy row out of it. `escalate` either way, but for the right reason.
    expect(reviewVerdictForRule('constructor')).toBe('escalate')
    expect(reviewVerdictForRule('toString')).toBe('escalate')
    expect(reviewRoutingRule('constructor')).toBeNull()
  })
})

describe('acceptance — the floor is applied a second time, independently', () => {
  it('refuses an auto_send the independent re-check does not agree with', () => {
    // The mutant: a table whose permissive row is reached without any of the nine above it declining. This
    // is what a dropped row, a reordered table or an inverted predicate looks like from here.
    const onlyPermissive: readonly ReviewRoutingRow[] = [
      REVIEW_ROUTING_ROWS.quiet_high_rating_may_auto_send,
    ]
    const decision = routeReview({
      review: STAR_ONLY(1),
      policy: enabledPolicy(),
      table: onlyPermissive,
    })
    expect(decision.verdict).toBe('escalate')
    expect(decision.rule).toBe('auto_send_floor_violated')
    expect(decision.documentedRow).toBe(1)
  })

  it('refuses it for a review with text, a named individual, or an escalation term', () => {
    const onlyPermissive: readonly ReviewRoutingRow[] = [
      REVIEW_ROUTING_ROWS.quiet_high_rating_may_auto_send,
    ]
    for (const text of [
      'the room was warm and the oil was very good',
      'The therapist was excellent',
      'They charged my card twice and refused to refund.',
    ]) {
      const decision = routeReview({
        review: WITH_TEXT(5, text),
        policy: enabledPolicy(),
        table: onlyPermissive,
      })
      expect(decision.rule, text).toBe('auto_send_floor_violated')
    }
  })

  it('agrees with the table on the one case both permit, so the floor is not simply false', () => {
    const onlyPermissive: readonly ReviewRoutingRow[] = [
      REVIEW_ROUTING_ROWS.quiet_high_rating_may_auto_send,
    ]
    expect(
      routeReview({ review: STAR_ONLY(5), policy: enabledPolicy(), table: onlyPermissive }).verdict,
    ).toBe('auto_send')
    expect(
      autoSendFloor({
        review: STAR_ONLY(5),
        policy: normaliseReviewPolicy(enabledPolicy()),
        matches: [],
      }),
    ).toBe(true)
  })
})

describe('acceptance — a stored verdict is reproducible from the stored version alone', () => {
  it('reproduces the verdict and the rule from the lexicon the version names', () => {
    const review = WITH_TEXT(4, 'They charged my card twice and refused to refund.')
    const original = routeReview({ review, policy: enabledPolicy() })
    expect(original.rule).toBe('escalation_term_present')

    // Everything a row carries: the verdict, the rule id, the lexicon version. The replay is given the
    // version and nothing else about the lexicon.
    const replay = replayReviewRouting({
      review,
      policy: {
        now: LONG_AFTER,
        autosendEnabledSetting: true,
        businessProfileAccessSetting: true,
        coolingOffHoursSetting: MINIMUM_REVIEW_COOLING_OFF_HOURS,
        replyLanguagesSetting: ['en', 'ar'],
      },
      storedLexiconVersion: original.lexiconVersion,
      lexiconFor: reviewEscalationLexiconFor,
    })
    expect(replay.verdict).toBe(original.verdict)
    expect(replay.rule).toBe(original.rule)
    expect(replay.lexiconVersion).toBe(original.lexiconVersion)
    expect(replay.matches.map((m) => m.term)).toEqual(original.matches.map((m) => m.term))
  })

  it('refuses to reproduce a verdict whose version this build cannot resolve', () => {
    const replay = replayReviewRouting({
      review: STAR_ONLY(5),
      policy: {
        now: LONG_AFTER,
        autosendEnabledSetting: true,
        businessProfileAccessSetting: true,
        coolingOffHoursSetting: 24,
        replyLanguagesSetting: ['en'],
      },
      storedLexiconVersion: '2027-01-01',
      lexiconFor: reviewEscalationLexiconFor,
    })
    // Not today's terms with a confident sentence: an explicit "this cannot be reproduced".
    expect(replay.verdict).toBe('escalate')
    expect(replay.rule).toBe('routing_policy_unavailable')
  })

  it('refuses with no policy at all', () => {
    const replay = replayReviewRouting({
      review: STAR_ONLY(5),
      policy: null,
      storedLexiconVersion: REVIEW_ESCALATION_LEXICON_VERSION,
      lexiconFor: reviewEscalationLexiconFor,
    })
    expect(replay.rule).toBe('routing_policy_unavailable')
  })

  it('reaches a different verdict when the historical lexicon lacked the term', () => {
    // The pair that proves the version is actually consulted rather than decorative: the same review, the
    // same policy, a lexicon without the refund terms — and a different rule.
    const review = WITH_TEXT(5, 'I want my money back.')
    const without = replayReviewRouting({
      review,
      policy: {
        now: LONG_AFTER,
        autosendEnabledSetting: true,
        businessProfileAccessSetting: true,
        coolingOffHoursSetting: 24,
        replyLanguagesSetting: ['en', 'ar'],
      },
      storedLexiconVersion: 'historical',
      lexiconFor: () => ({
        version: 'historical',
        rules: {
          ...REVIEW_ESCALATION_LEXICON.rules,
          refund: { category: 'refund' as const, why: 'none yet', terms: [] },
        },
      }),
    })
    expect(routeReview({ review, policy: enabledPolicy() }).rule).toBe('escalation_term_present')
    expect(without.rule).not.toBe('escalation_term_present')
    expect(without.verdict).toBe('escalate')
    expect(without.lexiconVersion).toBe('historical')
  })
})
