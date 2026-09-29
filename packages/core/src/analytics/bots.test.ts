import { AI_CRAWLER_BOT_KINDS, AI_CRAWLER_FETCHERS, AI_CRAWLERS } from '@berelax/shared'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import fixture from '../../test/fixtures/user-agents.json' with { type: 'json' }
import {
  BOT_KINDS,
  type BotKind,
  classifyBot,
  classifyHeadlessSignals,
  HEADLESS_CORROBORATION,
  HEADLESS_SIGNAL_RULES,
  type HeadlessSignalRule,
  type RequestSignals,
  USER_AGENT_SCAN_LIMIT,
} from './bots.ts'

/**
 * A-FIRST-04's acceptance, as a table plus a truth table plus two properties.
 *
 * The committed fixture is `packages/core/test/fixtures/user-agents.json`: 56 real strings, each with the
 * verdict it must produce. Nothing regenerates it and there is no `--emit` anywhere near it, for the
 * reason the encoding fixture beside it gives — changing a committed answer is allowed and sometimes
 * right, changing one *without noticing* is not, and every one of these answers moves a figure on the
 * analytics page.
 *
 * ## What each part of this file is for
 *
 * The **table** proves the classifier's answers. It cannot prove the classifier is not a constant, so the
 * kind coverage assertion does: every kind in {@link BOT_KINDS} except `suspected_headless` — which no
 * user agent can produce — has at least one row, and no row produces `suspected_headless`.
 *
 * The **truth table** over the three signal rules proves the corroboration rule exactly, in all eight
 * combinations. A heuristic that always suspected would fail three of the eight rows and one that never
 * did would fail five, so neither degenerate answer survives.
 *
 * The **properties** are two rather than one, and deliberately. Brief rule 22 is about a generator that
 * cannot exercise the claim it is asserted against, and the answer here is structural rather than
 * statistical: the arbitrary-string property asserts only what every input exercises (it returns, it
 * returns the same thing twice, and the row it implies is one the database would accept), while the claim
 * that *needs* a bot is asserted over a generator in which every single case contains a real bot's user
 * agent by construction. There is no floor to tune because there is no sampling to get unlucky with, and
 * the run asserts the count it exercised anyway.
 */

interface AgentCase {
  readonly id: string
  readonly why: string
  readonly userAgent: string
  readonly bot: boolean
  readonly botKind: BotKind | null
}

const cases = fixture.agents as readonly AgentCase[]
const botCases = cases.filter((one) => one.bot)
const humanCases = cases.filter((one) => !one.bot)

/** Signals from a visitor who is plainly a person: a phone viewport, taps, and human gaps. */
const HUMAN_SIGNALS: RequestSignals = {
  viewportWidth: 390,
  interactionCount: 3,
  interEventGapsMs: [1240, 3310],
}

/** The pair the acceptance line names: no viewport reported and nothing interacted with. */
const HEADLESS_SIGNALS: RequestSignals = {
  viewportWidth: null,
  interactionCount: 0,
  interEventGapsMs: [1240, 3310],
}

describe('the committed fixture', () => {
  it('is 56 real user-agent strings, each with an id, a reason and a representable verdict', () => {
    // The acceptance line asks for at least 40. The exact count is pinned as well, so a row lost in a
    // merge is a deliberate committed diff rather than a fixture that quietly got smaller.
    expect(cases.length).toBeGreaterThanOrEqual(40)
    expect(cases).toHaveLength(56)
    expect(new Set(cases.map((one) => one.id)).size).toBe(56)
    expect(new Set(cases.map((one) => one.userAgent)).size).toBe(56)
    for (const one of cases) {
      // A fixture row nobody can read is a row nobody maintains, and the `why` is what a reviewer uses to
      // decide whether a changed verdict is a correction or a regression.
      expect(one.why.length, one.id).toBeGreaterThan(30)
      expect(one.userAgent.trim(), one.id).not.toBe('')
      // The pairing `analytics.session.bot_kind`'s CHECK constraint permits, in the fixture as well as in
      // the return type: a row the database would refuse must not be expressible as an expectation either.
      expect(one.botKind === null, one.id).toBe(!one.bot)
      if (one.botKind !== null) expect(BOT_KINDS, one.id).toContain(one.botKind)
    }
  })

  it('covers every kind a user agent can produce, and no kind it cannot', () => {
    // The control that stops the table below being 56 assertions about one constant answer.
    const produced = new Set(botCases.map((one) => one.botKind))
    const fromClaim = BOT_KINDS.filter((kind) => kind !== 'suspected_headless')
    expect([...produced].sort()).toEqual([...fromClaim].sort())
    // `suspected_headless` is reachable from request signals and from nothing else. A fixture row
    // expecting it would mean a user-agent string had been treated as evidence about behaviour.
    expect(produced.has('suspected_headless')).toBe(false)
  })

  it('holds ten or more human agents including the three families the acceptance line names', () => {
    expect(humanCases.length).toBeGreaterThanOrEqual(10)
    // By id, because "iOS Safari" is a claim about which string was chosen and not about its shape — the
    // Applebot row is a complete macOS Safari string and is not a person.
    const ids = new Set(humanCases.map((one) => one.id))
    expect(ids).toContain('human-ios-safari-iphone')
    expect(ids).toContain('human-android-chrome-pixel')
    expect(ids).toContain('human-macos-safari')
  })
})

describe('the fixture classifies with zero misses', () => {
  it.each(cases.map((one) => [one.id, one] as const))('%s', (_id, one) => {
    const verdict = classifyBot({ userAgent: one.userAgent, signals: null })
    expect({ bot: verdict.bot, botKind: verdict.botKind }, one.why).toEqual({
      bot: one.bot,
      botKind: one.botKind,
    })
    // The basis, which is the whole honesty of this module: a user agent is a claim. Every `true` in this
    // table came from a string the sender chose, and `no_evidence` is what the absence of one is called.
    expect(verdict.basis).toBe(one.bot ? 'user_agent_claim' : 'no_evidence')
  })

  it('answers nothing for an absent, empty or punctuation-only user agent', () => {
    // Not a bot, deliberately: the absence of a claim is not a claim, and the two errors do not cost the
    // same. A bot counted as a person is one row in a denominator; a person counted as a bot is a visitor
    // A-FIRST-09 drops from the funnel by default and nobody ever sees.
    for (const userAgent of [null, '', '   ', ';;; (((', '\u0000']) {
      const verdict = classifyBot({ userAgent, signals: null })
      expect(verdict, JSON.stringify(userAgent)).toEqual({
        bot: false,
        botKind: null,
        basis: 'no_evidence',
      })
    }
  })

  it('stops scanning at the declared limit, in both directions', () => {
    const real = botCases[0]?.userAgent ?? ''
    expect(real).not.toBe('')
    // Just inside: found. This is the control — without it the assertion below would pass against a
    // classifier that had stopped matching anything at all.
    const inside = `${'x'.repeat(USER_AGENT_SCAN_LIMIT - real.length - 1)} ${real}`
    expect(inside.length).toBeLessThanOrEqual(USER_AGENT_SCAN_LIMIT)
    expect(classifyBot({ userAgent: inside, signals: null }).bot).toBe(true)
    // Beyond it: missed, and that is the documented behaviour rather than a defect. A client that wants
    // to hide omits its name; it does not pad past a limit to keep it.
    const beyond = `${'x'.repeat(USER_AGENT_SCAN_LIMIT)} ${real}`
    expect(classifyBot({ userAgent: beyond, signals: null }).bot).toBe(false)
  })
})

describe('the AI crawler list is the shared table and the kinds are distinct', () => {
  it('classifies every fetching crawler in the table, each as its own kind', () => {
    // The classifier half of the drift check. `apps/web/src/crawler-policy.test.ts` holds the other half —
    // the rendered robots.txt — equal to the same table, so an entry cannot be added to the policy and
    // left unrecognised here, which is the drift that inflates every figure on the analytics page.
    expect(AI_CRAWLER_FETCHERS.length).toBeGreaterThan(0)
    for (const entry of AI_CRAWLER_FETCHERS) {
      const rows = cases.filter(
        (one) =>
          one.bot &&
          classifyBot({ userAgent: one.userAgent, signals: null }).botKind === entry.botKind,
      )
      expect(rows.length, `${entry.token} has no user agent in the fixture`).toBeGreaterThan(0)
    }
  })

  it('gives each AI crawler a distinct kind, and no kind two things produce', () => {
    expect(new Set(AI_CRAWLER_BOT_KINDS).size).toBe(AI_CRAWLER_BOT_KINDS.length)
    // Across the whole vocabulary, not only the AI half: an AI crawler whose kind collided with a family
    // name would be a `bot_kind` two different things write, and no query could separate them again.
    expect(new Set(BOT_KINDS).size).toBe(BOT_KINDS.length)
  })

  it('classifies nothing for the entry that fetches nothing', () => {
    // `Google-Extended` is a usage-control token, not a crawler: it never makes a request, so there is no
    // user agent to recognise and the table gives it no kind. Asserted because a future maintainer
    // reading "six allowed, five classified" needs the absence to be a decision.
    const usageOnly = AI_CRAWLERS.filter((entry) => !entry.fetches)
    expect(usageOnly.length).toBeGreaterThan(0)
    for (const entry of usageOnly) {
      expect(entry.botKind, entry.token).toBeNull()
      expect(AI_CRAWLER_BOT_KINDS as readonly string[]).not.toContain(entry.token.toLowerCase())
    }
  })
})

describe('the headless heuristic reads the signals and nothing else', () => {
  /** Signals built from which of the three rules should fire. */
  const signalsFor = (v: boolean, i: boolean, u: boolean): RequestSignals => ({
    viewportWidth: v ? null : 390,
    interactionCount: i ? 0 : 3,
    interEventGapsMs: u ? [1000, 1000] : [1240, 3310],
  })

  // All eight combinations of the three rules. A heuristic that always suspected fails three rows and one
  // that never did fails five, so the table refuses both degenerate answers — and it states the
  // corroboration rule exactly rather than asserting the two cases somebody happened to think of.
  interface TruthRow {
    readonly v: boolean
    readonly i: boolean
    readonly u: boolean
    readonly suspected: boolean
    readonly rules: readonly HeadlessSignalRule[]
  }

  const truthTable: readonly TruthRow[] = [
    { v: false, i: false, u: false, suspected: false, rules: [] },
    { v: true, i: false, u: false, suspected: false, rules: ['no_viewport'] },
    { v: false, i: true, u: false, suspected: false, rules: ['no_interaction'] },
    { v: false, i: false, u: true, suspected: true, rules: ['uniform_event_timing'] },
    { v: true, i: true, u: false, suspected: true, rules: ['no_viewport', 'no_interaction'] },
    { v: true, i: false, u: true, suspected: true, rules: ['no_viewport', 'uniform_event_timing'] },
    {
      v: false,
      i: true,
      u: true,
      suspected: true,
      rules: ['no_interaction', 'uniform_event_timing'],
    },
    {
      v: true,
      i: true,
      u: true,
      suspected: true,
      rules: ['no_viewport', 'no_interaction', 'uniform_event_timing'],
    },
  ]

  it.each(truthTable)('viewport=$v interaction=$i timing=$u', (row) => {
    const verdict = classifyHeadlessSignals(signalsFor(row.v, row.i, row.u))
    expect(verdict.rules).toEqual(row.rules)
    expect(verdict.suspected).toBe(row.suspected)
    // The rule the table encodes, asserted as arithmetic so a change to either constant fails here rather
    // than in eight separate rows: alone-sufficient, or corroborated.
    const alone = row.rules.includes('uniform_event_timing')
    expect(row.suspected).toBe(alone || row.rules.length >= HEADLESS_CORROBORATION)
  })

  it('needs two gaps before identical timings mean anything, and exact equality', () => {
    const uniform = (gaps: readonly number[]): boolean =>
      classifyHeadlessSignals({
        viewportWidth: 390,
        interactionCount: 3,
        interEventGapsMs: gaps,
      }).rules.includes('uniform_event_timing')
    // One gap is always identical to itself, so one gap says nothing.
    expect(uniform([])).toBe(false)
    expect(uniform([1000])).toBe(false)
    expect(uniform([1000, 1000])).toBe(true)
    // No tolerance: a millisecond apart is not a scheduler, and a tolerance would be a figure nobody has
    // measured. This is the control on the row above.
    expect(uniform([1000, 1001])).toBe(false)
    expect(uniform([1000, 1000, 1000, 500])).toBe(false)
    // Garbage cannot be uniform. NaN is not equal to itself, so this would answer correctly by accident;
    // it is asserted so that a future `Math.abs(gap - first) < tolerance` cannot pass it.
    expect(uniform([Number.NaN, Number.NaN])).toBe(false)
  })

  it('answers the same for one set of signals whatever the user agent says — all twelve of them', () => {
    // The acceptance line: `suspected_headless` from signals ALONE. `RequestSignals` has no user-agent
    // field, so the heuristic cannot read one; this is the end-to-end statement of the same fact through
    // `classifyBot`, over every human string in the fixture.
    expect(humanCases.length).toBeGreaterThanOrEqual(10)
    for (const human of humanCases) {
      expect(
        classifyBot({ userAgent: human.userAgent, signals: HEADLESS_SIGNALS }),
        human.id,
      ).toEqual({
        bot: true,
        botKind: 'suspected_headless',
        basis: 'request_signals',
      })
      // The control, and it is the load-bearing one: the same strings with human signals are people. Without
      // it the assertion above would pass against a classifier that flagged these twelve on their strings.
      expect(classifyBot({ userAgent: human.userAgent, signals: HUMAN_SIGNALS }), human.id).toEqual(
        {
          bot: false,
          botKind: null,
          basis: 'no_evidence',
        },
      )
    }
  })

  it('lets a declared agent keep its own kind when the signals also fire', () => {
    // A crawler reports no viewport and interacts with nothing, so every one of them trips the pair above.
    // The claim wins, because "GPTBot read this page" is the figure docs/09 asks to be measured and
    // `suspected_headless` over the top of it would lose it.
    for (const bot of botCases) {
      const verdict = classifyBot({ userAgent: bot.userAgent, signals: HEADLESS_SIGNALS })
      expect(verdict.botKind, bot.id).toBe(bot.botKind)
      expect(verdict.basis, bot.id).toBe('user_agent_claim')
    }
  })

  it('names its rules once, in the order it reports them', () => {
    // The tuple is the declared order and `classifyHeadlessSignals` filters it, so a rule reported out of
    // order would mean the function had built its own list.
    expect([...HEADLESS_SIGNAL_RULES]).toEqual([
      'no_viewport',
      'no_interaction',
      'uniform_event_timing',
    ])
  })
})

describe('the property: arbitrary, empty and absent user agents', () => {
  it('always returns, returns the same answer twice, and never a row the database would refuse', () => {
    let answered = 0
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 400 }), { nil: null }), (userAgent) => {
        // "Never throws" is asserted by calling it: fc reports the shrunk input on any throw, which is
        // more use than a wrapper that only says one was thrown.
        const first = classifyBot({ userAgent, signals: null })
        const second = classifyBot({ userAgent, signals: null })
        expect(second).toEqual(first)
        answered += 1
        // `(bot_kind is not null) = bot` — migration 0096's CHECK, as a property. A shape this classifier
        // could produce and the database would refuse would surface as a 23514 from A-FIRST-05's INSERT
        // naming a constraint rather than the classifier that caused it.
        expect(first.botKind === null).toBe(!first.bot)
        if (first.botKind !== null) expect(BOT_KINDS).toContain(first.botKind)
        // And the third field, which is the one a reader trusts: `no_evidence` exactly when nothing was
        // found, never beside a verdict.
        expect(first.basis === 'no_evidence').toBe(!first.bot)
      }),
      { numRuns: 500 },
    )
    // There is no branch floor here and there should not be: the claim is that ANY input gets an answer,
    // so every generated case exercises it and a random string containing a real agent token is a thing
    // that essentially never happens. The claim that needs a bot is the property below, whose generator
    // contains one in every case by construction (brief rule 22).
    expect(answered).toBe(500)
    // An explicit budget: vitest's default is 5,000 ms and this file runs under coverage alongside other
    // worktrees (brief rule 21).
  }, 30_000)

  it('still recognises a real agent inside arbitrary noise, in every generated case', () => {
    let exercised = 0
    const longest = Math.max(...botCases.map((one) => one.userAgent.length))
    // The noise is bounded so the token cannot be pushed past USER_AGENT_SCAN_LIMIT, which is a documented
    // behaviour of its own and tested above rather than rediscovered here as a flake.
    const noiseLimit = 64
    expect(longest + noiseLimit * 2 + 2).toBeLessThan(USER_AGENT_SCAN_LIMIT)
    fc.assert(
      fc.property(
        fc.constantFrom(...botCases.map((one) => one.userAgent)),
        fc.string({ maxLength: noiseLimit }),
        fc.string({ maxLength: noiseLimit }),
        (userAgent, before, after) => {
          const verdict = classifyBot({
            userAgent: `${before} ${userAgent} ${after}`,
            signals: null,
          })
          // `bot` and not the exact kind: noise can only ADD a match, never remove one, and a generated
          // prefix that happened to name another agent would change the kind without making the claim
          // wrong. The kind is pinned by the fixture table, where nothing is generated.
          expect(verdict.bot).toBe(true)
          expect(verdict.botKind).not.toBeNull()
          expect(verdict.basis).toBe('user_agent_claim')
          exercised += 1
        },
      ),
      { numRuns: 300 },
    )
    // Every case carried a real agent, by construction. Asserted rather than reasoned about, because the
    // way this property would go vacuous is a generator edit that left it drawing from an empty list —
    // `fc.constantFrom()` with no arguments throws, but a filter that matched nothing would not.
    expect(exercised).toBe(300)
  }, 30_000)

  it('never throws on arbitrary signals, and reports only rules it names', () => {
    fc.assert(
      fc.property(
        fc.option(fc.double(), { nil: null }),
        fc.integer(),
        fc.array(fc.double(), { maxLength: 12 }),
        (viewportWidth, interactionCount, interEventGapsMs) => {
          const signals: RequestSignals = { viewportWidth, interactionCount, interEventGapsMs }
          const first = classifyHeadlessSignals(signals)
          expect(classifyHeadlessSignals(signals)).toEqual(first)
          for (const rule of first.rules) expect(HEADLESS_SIGNAL_RULES).toContain(rule)
          // A suspicion with nothing behind it would be a verdict no report could explain.
          if (first.suspected) expect(first.rules.length).toBeGreaterThan(0)
          // And the arithmetic of the rule, over inputs nobody chose: a single corroborating rule is never
          // a verdict on its own.
          if (first.rules.length === 1 && first.rules[0] !== 'uniform_event_timing') {
            expect(first.suspected).toBe(false)
          }
        },
      ),
      { numRuns: 500 },
    )
  }, 30_000)
})
