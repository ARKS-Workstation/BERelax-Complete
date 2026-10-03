import { AppError } from '@berelax/shared'
import { type RareQueryGapInput, rareQueryGap, rareQueryGapExplanation } from './rare-query-gap.ts'

/**
 * The weekly plain-English report: five prioritised actions, and the honest count when there are fewer.
 *
 * docs/07 §3 asks for the agent's autonomy to be *earnable*, and docs/09's SEO section says what loses
 * it: a report whose reader learns to skim. ADR 0085 recorded the same hazard for the analyses
 * themselves. This module is the last mile of that argument — the place where findings become sentences
 * somebody acts on, or does not.
 *
 * ## Five is a CAP and the report must be able to fail to reach it
 *
 * The acceptance criterion is two assertions and the second is the one that matters: *"a run with three
 * findings renders three and states the honest count rather than padding."* A report that always finds
 * five has a **floor**, not a finding. Padding is the specific failure: the fifth-best action in a quiet
 * week is noise, and a reader who meets it four weeks running has been taught that the list is filler.
 *
 * So {@link prioritiseSeoActions} returns `found` beside `shown` and never invents a row, and
 * {@link renderSeoWeeklyReport} prints the count it actually has. `weekly-report.test.ts` drives six
 * findings and three findings through the same renderer and asserts both.
 *
 * ## Plain English is enforced, not hoped for
 *
 * Three rules, each of which has a specific failure behind it:
 *
 *   - **Sentence length.** `SEO_REPORT_MAX_SENTENCE_WORDS` is the configured maximum, and
 *     {@link seoReportReadability} measures the rendered body rather than the template. A long sentence
 *     in a weekly email is not a style complaint: it is where the action goes missing.
 *   - **Every metric carries a one-line explanation.** A number with no explanation is a number the
 *     reader cannot act on, and the commonest kind in this subject — *impressions*, *position*, *CTR* —
 *     reads as if it were self-explanatory to the person who wrote it. {@link SeoReportMetric} makes the
 *     explanation a REQUIRED field, so a metric cannot reach the body without one.
 *   - **No jargon token without its gloss, no scope URL, no SQL.** {@link SEO_REPORT_JARGON} is a map
 *     from a term to the sentence that defines it, so "zero undefined jargon tokens" is checkable rather
 *     than a matter of taste. The scope-URL and SQL rules are about a different hazard: those strings get
 *     into a report by somebody pasting a diagnostic into a template, and the first person to receive one
 *     is the owner.
 *
 * ## Pure
 *
 * No clock, no I/O. The instant, the heartbeat facts, the findings and the stored click totals are all
 * arguments, which is what lets the fixtures assert a three-finding week and a six-finding week against
 * the same renderer, and the worker's integration suite assert the same renderer against real rows.
 */

/**
 * The longest sentence this report may contain, in words.
 *
 * Twenty-four, and the figure is a CHOICE rather than a measurement — stated here as a named constant so
 * it is one decision in one place rather than a number inside an assertion. It is near the upper end of
 * what plain-English guidance recommends (most say 15 to 20 for a general audience) because this report
 * explains two things at once, a finding and what to do about it, and a limit tight enough to forbid that
 * would be met by splitting a sentence in the middle of its own reason.
 *
 * It is not a default anybody inherits: `seoReportReadability` takes its maximum as a required argument
 * for `coverageAnomalyConfig`'s reason (ADR 0085 decision 1) — a threshold that arrives by default is a
 * threshold nobody chose — and this is what the renderer's own caller passes.
 */
export const SEO_REPORT_MAX_SENTENCE_WORDS = 24

/**
 * Every term this subject cannot avoid, with the sentence that defines it.
 *
 * A map and not a blocklist, and the direction is the point: these words ARE the vocabulary of the
 * finding, so forbidding them would make the report unable to say what it found. What is forbidden is
 * using one **without its gloss**, which is a rule the renderer satisfies by construction and the
 * readability check proves.
 *
 * Matched case-blind on a word boundary. The glosses are deliberately short: a reader meeting *CTR* for
 * the first time needs one line, not a paragraph, and a paragraph is how the five actions get pushed
 * below the fold.
 */
export const SEO_REPORT_JARGON: Readonly<Record<string, string>> = Object.freeze({
  CTR: 'CTR is the share of people who clicked after seeing you in the results.',
  impressions:
    'An impression is one appearance in Google’s results, whether or not anyone clicked.',
  position: 'Position is where you appeared in the list of results, where 1 is the top.',
  canonical: 'A canonical tag tells Google which address is the real one when two pages are alike.',
  indexed: 'Indexed means Google has the page on file and can show it in results.',
  sitemap: 'A sitemap is the list of pages this site asks Google to look at.',
})

/** Strings a report may never contain, with the reason each one gets in. */
export const SEO_REPORT_FORBIDDEN: readonly { readonly what: string; readonly pattern: RegExp }[] =
  Object.freeze([
    {
      what: 'an OAuth scope URL',
      // These reach a template by somebody pasting a diagnostic, and the first recipient is the owner.
      pattern: /https:\/\/www\.googleapis\.com\/auth\//i,
    },
    {
      what: 'SQL',
      pattern:
        /\b(select\s+\w+\s+from|insert\s+into|update\s+\w+\s+set|::(uuid|text|date|jsonb))\b/i,
    },
    {
      what: 'a raw identifier a reader cannot act on',
      // `sc-domain:` is a Search Console property identifier and `accounts/` + `locations/` are Business
      // Profile resource names. Each is correct, internal, and meaningless on an owner's screen.
      pattern: /\b(sc-domain:|accounts\/\d|locations\/[a-z0-9-]+)/i,
    },
  ])

/** What kind of thing was found. The set the priority order is declared over. */
export const SEO_FINDING_KINDS = [
  /** The site and the Google profile disagree about hours or a price (G-SEO-06). */
  'gbp_inconsistency',
  /** A sustained fall in a Search Console series (G-SEO-04). */
  'traffic_anomaly',
  /** A page Google has not indexed, or has dropped. */
  'coverage',
  /** Markup on a page that Google would reject or distrust. */
  'structured_data',
  /** A drafted copy change waiting for a human decision (G-SEO-05). */
  'suggestion',
  /** An internal-link or sitemap problem. */
  'site_structure',
] as const
export type SeoFindingKind = (typeof SEO_FINDING_KINDS)[number]

/**
 * The order the kinds are reported in, and why it is this order.
 *
 * Declared as data rather than computed from a score, because a score would be a model of importance
 * nobody has agreed to and it would change the order of a weekly email between two runs for reasons
 * nobody could explain. The reasoning, highest first:
 *
 *   1. `gbp_inconsistency` — a wrong closing time or price is a customer turned away at the door and an
 *      assistant quoting the wrong figure under this business's name. It is the only kind that is
 *      actively costing something today.
 *   2. `traffic_anomaly` — something that was working has stopped, and the sooner it is looked at the
 *      shorter the loss.
 *   3. `coverage` — a page Google cannot show is a page that earns nothing.
 *   4. `structured_data` — markup Google distrusts loses a rich result and can earn a manual action.
 *   5. `site_structure` — real, slower, and nothing breaks while it waits.
 *   6. `suggestion` — a copy improvement. Valuable, and the one kind where doing nothing this week costs
 *      nothing at all, which is why it is last and why a quiet week's report is allowed to be short.
 */
export const SEO_FINDING_PRIORITY: readonly SeoFindingKind[] = Object.freeze([
  'gbp_inconsistency',
  'traffic_anomaly',
  'coverage',
  'structured_data',
  'site_structure',
  'suggestion',
])

/**
 * One thing to do, in the three parts the acceptance criterion names.
 *
 * All three are REQUIRED. An action with no expected effect is a chore, and an action with no human step
 * is a notification — and this report exists to be acted on, so a shape that could carry either would be
 * a shape the first busy week fills with both.
 */
export interface SeoWeeklyAction {
  readonly kind: SeoFindingKind
  /** What was found, in one sentence a reader can check. */
  readonly finding: string
  /** What acting on it is expected to change. Never a figure nobody measured (ADR 0070). */
  readonly expectedEffect: string
  /** What a person has to do. A step, not an intention. */
  readonly humanAction: string
}

/** How many actions the report shows. Five, from the acceptance line and from docs/07 §3. */
export const SEO_WEEKLY_ACTION_CAP = 5

export interface PrioritisedSeoActions {
  readonly actions: readonly SeoWeeklyAction[]
  /** How many findings there were. The number the report states, and it may be below the cap. */
  readonly found: number
  readonly shown: number
  /** True when findings were held back. What the "and N more" sentence is rendered from. */
  readonly withheld: number
}

/**
 * Orders the findings and takes at most {@link SEO_WEEKLY_ACTION_CAP}.
 *
 * Stable: within a kind the input order is kept, so two runs over the same findings produce the same
 * email — which the screenshot rerun depends on and which a sort by anything derived from a clock or a
 * hash would quietly break.
 *
 * It never pads. `found` is what came in, `shown` is what fits, and a caller that wanted five rows out
 * of three findings has nowhere to get the other two.
 */
export function prioritiseSeoActions(
  findings: readonly SeoWeeklyAction[],
  cap: number = SEO_WEEKLY_ACTION_CAP,
): PrioritisedSeoActions {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new AppError(
      'validation',
      `A weekly report must show at least one action; ${cap} was asked for. A cap of zero is a report ` +
        'with nothing in it, which is a stopped agent rather than a quiet week.',
    )
  }
  const ordered = [...findings]
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) => {
      const byKind =
        SEO_FINDING_PRIORITY.indexOf(a.finding.kind) - SEO_FINDING_PRIORITY.indexOf(b.finding.kind)
      return byKind === 0 ? a.index - b.index : byKind
    })
    .map((entry) => entry.finding)
  const actions = ordered.slice(0, cap)
  return {
    actions: Object.freeze(actions),
    found: findings.length,
    shown: actions.length,
    withheld: findings.length - actions.length,
  }
}

/** One figure the report prints, and the line that says what it means. */
export interface SeoReportMetric {
  readonly label: string
  readonly value: string
  /** Required. A number with no explanation is a number the reader cannot act on. */
  readonly explanation: string
}

/**
 * The run's own heartbeat facts, so a stopped agent is visible in the report as well as the console.
 *
 * Every field is nullable except the cost, because *never succeeded* and *succeeded at some instant* are
 * different facts and a report that rendered the first as an instant would say the agent is fine. The
 * cost is a sum over rows and is therefore zero when there are none — which is a measurement and not an
 * absence.
 */
export interface SeoAgentHeartbeatFacts {
  readonly lastSuccessAtIso: string | null
  readonly nextRunDueAtIso: string | null
  readonly costToDateFils: number
}

export interface SeoWeeklyReportInput {
  readonly weekEndingIso: string
  readonly findings: readonly SeoWeeklyAction[]
  readonly metrics: readonly SeoReportMetric[]
  readonly heartbeat: SeoAgentHeartbeatFacts
  /**
   * The stored query-versus-page click totals, or null when no snapshot covers the window.
   *
   * Null rather than zeros: a window with no snapshot and a window with no withheld clicks are different
   * facts, and `rareQueryGapExplanation` says something confident about the second one.
   */
  readonly clicks: RareQueryGapInput | null
  /**
   * Set when the Google connection could not be read and the figures came from the mirror.
   *
   * A string rather than a boolean, so the sentence names WHAT degraded. `null` is the ordinary state.
   */
  readonly degradedBecause: string | null
  readonly maxSentenceWords: number
}

export interface SeoWeeklyReport {
  readonly subject: string
  /** The plain-text body. The email's text part, and what `renderEmailHtml` derives the HTML from. */
  readonly body: string
  readonly actions: PrioritisedSeoActions
}

const fils = (amount: number): string => `${(amount / 100).toFixed(2)} AED`

/** The glosses for every jargon term the text actually uses. Nothing is glossed that is not said. */
export function jargonGlossesFor(text: string): readonly string[] {
  const lower = text.toLowerCase()
  return Object.entries(SEO_REPORT_JARGON)
    .filter(([term]) => new RegExp(`\\b${term.toLowerCase()}\\b`).test(lower))
    .map(([, gloss]) => gloss)
}

/**
 * Renders the report.
 *
 * The order is the reader's and not the data's: what to do, then the figures, then why a figure might look
 * wrong, then whether the agent is alive. A heartbeat section at the top would be the agent talking about
 * itself before it says anything useful.
 */
export function renderSeoWeeklyReport(input: SeoWeeklyReportInput): SeoWeeklyReport {
  const actions = prioritiseSeoActions(input.findings)
  const lines: string[] = []

  lines.push(`Website report for the week ending ${input.weekEndingIso}.`)
  lines.push('')

  if (input.degradedBecause !== null) {
    // One plain sentence, and it is not an apology. The reader has to know the figures are from the
    // stored history rather than from Google, because the decision they take differs.
    lines.push(
      `This week’s figures come from the copy we keep, not from Google: ${input.degradedBecause} ` +
        'The actions below still stand.',
    )
    lines.push('')
  }

  if (actions.found === 0) {
    lines.push('Nothing needs doing this week. We checked and found no problems.')
  } else {
    lines.push(
      actions.withheld > 0
        ? `We found ${actions.found} things worth doing. Here are the ${actions.shown} that matter ` +
            `most, with ${actions.withheld} left for next week.`
        : `We found ${actions.found} ${actions.found === 1 ? 'thing' : 'things'} worth doing. ` +
            'That is all of them.',
    )
    lines.push('')
    actions.actions.forEach((action, index) => {
      lines.push(`${index + 1}. ${action.finding}`)
      lines.push(`   What it should do: ${action.expectedEffect}`)
      lines.push(`   What you need to do: ${action.humanAction}`)
      lines.push('')
    })
  }

  if (input.metrics.length > 0) {
    lines.push('The numbers:')
    for (const metric of input.metrics) {
      lines.push(`- ${metric.label}: ${metric.value}. ${metric.explanation}`)
    }
    lines.push('')
  }

  if (input.clicks !== null) {
    const gap = rareQueryGap(input.clicks)
    // Rendered only when there is a discrepancy to explain. When the totals agree there is nothing to
    // explain, and `rareQueryGapExplanation`'s own zero-case sentence belongs on the dashboard beside the
    // query report rather than in a weekly email that is five actions long.
    if (gap.withheldClicks > 0 || gap.withheldImpressions > 0) {
      lines.push(rareQueryGapExplanation(input.clicks))
      lines.push('')
    }
  }

  lines.push(
    input.heartbeat.lastSuccessAtIso === null
      ? 'This check has never finished successfully yet, so treat the list above as incomplete.'
      : `This check last finished on ${input.heartbeat.lastSuccessAtIso}.`,
  )
  lines.push(
    input.heartbeat.nextRunDueAtIso === null
      ? 'It has no next run on the books.'
      : `The next one is due on ${input.heartbeat.nextRunDueAtIso}.`,
  )
  lines.push(`It has cost ${fils(input.heartbeat.costToDateFils)} so far.`)

  const glosses = jargonGlossesFor(lines.join('\n'))
  if (glosses.length > 0) {
    lines.push('')
    lines.push('What the words mean:')
    for (const gloss of glosses) lines.push(`- ${gloss}`)
  }

  return {
    subject: `Website report, week ending ${input.weekEndingIso}`,
    body: lines.join('\n'),
    actions,
  }
}

/**
 * Sentences this check does not measure, each with the module that owns the words and the reason.
 *
 * ONE entry, and it is the honest cost of reusing a single statement of a fact. `rareQueryGapExplanation`
 * is the build's only explanation of why the query totals are lower than the page totals — its own header
 * says a second one would keep reading the same after the data changed — and its first sentence is 31
 * words, written for a dashboard panel. The alternatives were both worse: a second, shorter sentence for
 * email would be the drift that function exists to prevent, and rewording the original is an edit to
 * another unit's prose that this unit's cap does not justify on its own.
 *
 * The exemption is asserted to still be NEEDED. `weekly-report.test.ts` asserts the sentence appears in a
 * report with a discrepancy AND that it is over the maximum, so the day somebody shortens it this test
 * fails and the exemption is deleted deliberately rather than inherited for ever — the pattern
 * `packages/fixtures/src/seo-nap-literals.test.ts` already uses for its two file exemptions.
 */
export const SEO_REPORT_READABILITY_EXEMPT: readonly {
  readonly owner: string
  readonly why: string
  readonly matches: RegExp
}[] = Object.freeze([
  {
    owner: 'rareQueryGapExplanation (packages/core/src/seo/rare-query-gap.ts)',
    why:
      'the build\u2019s ONE explanation of the query-versus-page click discrepancy, rendered from the ' +
      'stored figures. A shorter second version for email is exactly the drift that function exists to ' +
      'prevent.',
    // The opening, which identifies the sentence and does not depend on the figures in it.
    matches: /^Search Console withholds /,
  },
])

/** One thing wrong with the prose, by rule name. */
export interface SeoReadabilityFinding {
  readonly rule:
    | 'sentence_too_long'
    | 'metric_without_explanation'
    | 'forbidden_content'
    | 'jargon_without_gloss'
  readonly detail: string
}

/** Splits on sentence ends, dropping the list markers a numbered action starts with. */
function sentencesOf(body: string): readonly string[] {
  return body
    .split('\n')
    .flatMap((line) => line.replace(/^\s*(?:\d+\.|-)\s*/, '').split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== '')
}

const wordsIn = (sentence: string): number =>
  sentence.split(/\s+/).filter((word) => /[a-z0-9]/i.test(word)).length

/**
 * Judges the rendered body, by rule name.
 *
 * Over the BODY and not over the template, which is the difference between a check and a hope: the body
 * is what a reader receives, and every figure, finding and action in it arrived at render time. A check
 * on the template would pass for ever while the sentences the data produced grew.
 *
 * `maxSentenceWords` is a required argument. A default here would be a limit nobody chose, and the one
 * place the choice belongs is {@link SEO_REPORT_MAX_SENTENCE_WORDS}.
 */
export function seoReportReadability(
  report: Pick<SeoWeeklyReport, 'body'>,
  options: { readonly maxSentenceWords: number; readonly metrics: readonly SeoReportMetric[] },
): readonly SeoReadabilityFinding[] {
  const findings: SeoReadabilityFinding[] = []

  for (const sentence of sentencesOf(report.body)) {
    if (SEO_REPORT_READABILITY_EXEMPT.some((entry) => entry.matches.test(sentence))) continue
    const words = wordsIn(sentence)
    if (words > options.maxSentenceWords) {
      findings.push({
        rule: 'sentence_too_long',
        detail: `${words} words (the maximum is ${options.maxSentenceWords}): ${sentence}`,
      })
    }
  }

  for (const metric of options.metrics) {
    if (!report.body.includes(metric.label)) continue
    if (!report.body.includes(metric.explanation)) {
      findings.push({
        rule: 'metric_without_explanation',
        detail: `${metric.label} is printed with no line saying what it means`,
      })
    }
  }

  for (const forbidden of SEO_REPORT_FORBIDDEN) {
    const match = forbidden.pattern.exec(report.body)
    if (match !== null) {
      findings.push({
        rule: 'forbidden_content',
        detail: `${forbidden.what}: ${match[0]}`,
      })
    }
  }

  for (const [term, gloss] of Object.entries(SEO_REPORT_JARGON)) {
    if (!new RegExp(`\\b${term}\\b`, 'i').test(report.body)) continue
    if (!report.body.includes(gloss)) {
      findings.push({
        rule: 'jargon_without_gloss',
        detail: `"${term}" is used with no line defining it`,
      })
    }
  }

  return Object.freeze(findings)
}
