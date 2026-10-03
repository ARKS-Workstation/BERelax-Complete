/**
 * The go/no-go decision: six requirements, every one of which is UNMET until a fact clears it.
 *
 * H-MIG-11. Pure, and separate from `scripts/go-no-go.mjs`, for `go-live-payments.mjs`'s stated reason:
 * a judgement that lives in a script is a judgement no test reaches.
 *
 * ## Why a requirement starts UNMET and why `unknown` is not a third outcome
 *
 * A release gate's failure mode is not that it says the wrong thing. It is that it says nothing and is
 * read as a pass: the source it consults is missing, the figure it compares against was never
 * configured, the list it differences against is empty. Every one of those produces "no problems
 * found", which is ADR 0002's shape at the one moment it costs the most.
 *
 * So the vocabulary has three states and only one of them clears a requirement. `met` is a fact that
 * answers it. `unmet` is a fact that refuses it. `unknown` is the absence of a fact — a report that was
 * never produced, a maximum age nobody has configured, a register nobody has filled in — and it blocks
 * exactly as hard as a refusal, because on the day of a cutover "we did not measure it" and "it failed"
 * have the same consequence. {@link releaseGoNoGoVerdict} names the state in the problem either way, so
 * the two are still distinguishable to a reader; they are simply not distinguishable to the verdict.
 *
 * ## Why the requirement list is DATA and the verdict refuses an incomplete answer
 *
 * `GO_NO_GO_REQUIREMENTS` is the acceptance line's own list, and the verdict demands exactly one
 * finding per requirement: a gatherer that stopped producing one — a source file renamed, a query that
 * threw and was caught — would otherwise reduce the examined set by one and report a cleaner answer
 * than the last run. That is the regression nothing else could see, so it is a refusal of its own
 * ({@link GO_NO_GO_RULES.notAnswered}), and the floor beneath it refuses a verdict computed over no
 * requirements at all.
 *
 * ## What this module deliberately does NOT do
 *
 * It does not decide the freeze and it does not decide the cutover. The freeze is a claim a human makes
 * ({@link module:release/freeze}) and the cutover decision is `parallel_run_decision` (H-MIG-10,
 * ADR 0107) — a free column a person fills in with their own name and rationale. A function that turned
 * either into a verdict would be a verdict nobody made.
 */

/** Rule names, printed verbatim by the script so a gate case can assert the rule (ADR 0003). */
export const GO_NO_GO_RULES = {
  /** A requirement a fact refuses. */
  unmet: 'go-live-requirement-not-met',
  /** A requirement no fact answers. Blocks, and says it is an absence rather than a refusal. */
  unknown: 'go-live-requirement-unanswered',
  /** A declared requirement with no finding at all: the gatherer stopped producing one. */
  notAnswered: 'go-no-go-requirement-not-examined',
  /** A finding for an id the list does not declare. */
  notDeclared: 'go-no-go-finding-not-declared',
  /** Two findings for one requirement; the second would win a lookup silently. */
  answeredTwice: 'go-no-go-requirement-answered-twice',
  /** The floor: a verdict over no requirements, or over no findings, is a verdict about nothing. */
  examinedNothing: 'go-no-go-examined-nothing',
} as const

/**
 * A requirement's state. Three values, and only `met` clears it.
 *
 * Closed with no default, for `FINDING_SEVERITIES`' reason: a defaulted state is how an unanswered
 * requirement becomes a satisfied one.
 */
export const GO_NO_GO_STATES = ['met', 'unmet', 'unknown'] as const
export type GoNoGoState = (typeof GO_NO_GO_STATES)[number]

export interface GoNoGoRequirement {
  readonly id: string
  readonly label: string
  /** Why a release is held on it. A sentence a reader can disagree with. */
  readonly why: string
  /** What answers it, named so a reader can run that thing themselves. */
  readonly answeredBy: string
}

/**
 * The six requirements H-MIG-11's acceptance line names, in its order.
 *
 * Each is answered by a check that already exists and already has its own known-bad fixture, which is
 * why this list carries no thresholds: the maximum drill age belongs to the drill's own artefact, the
 * blocking severities to the findings register, the minimum of three to the dry-run gate. A second copy
 * of any of those figures here would be the second statement that drifts — and the one that drifted
 * would be the one this gate reads.
 */
export const GO_NO_GO_REQUIREMENTS: readonly GoNoGoRequirement[] = Object.freeze([
  Object.freeze({
    id: 'external-items-cleared',
    label: 'Every external item cleared',
    why:
      'docs/11 §5 step 24 states the gate for this step in three words: every external item cleared. ' +
      'An external item is something only the owner can do — a licence, a consent, a sender id, a ' +
      'merchant category code — and no amount of code changes any of them. A build that went live with ' +
      'one outstanding would be operating on a value this build chose for it (brief rule 15).',
    answeredBy:
      "every id in any unit's blocked_on_owner in build/manifest.yaml, against its row in " +
      'docs/OPEN-QUESTIONS.md: cleared means that row says resolved',
  }),
  Object.freeze({
    id: 'milestones-demonstrated',
    label: 'M1 to M7 demonstrated',
    why:
      'docs/00 §5 calls the seven milestones the schedule’s truth-telling mechanism: each is a ' +
      'vertical slice demonstrated end to end, and each is the earliest honest evidence that a set of ' +
      'workstreams composes. A release before one of them is demonstrated is a release whose core ' +
      'chain has never been walked.',
    answeredBy:
      'build/manifest.yaml: each of M1..M7 is demonstrated when a unit declaring that milestone is done',
  }),
  Object.freeze({
    id: 'restore-drill-current',
    label: 'A restore drill newer than the maximum age',
    why:
      'A backup nobody has restored is a backup whose format, completeness and readability are all ' +
      'assumptions (ADR 0123). The drill is the evidence, and evidence has an age: a restore proved ' +
      'against a schema that is no longer here proves nothing about this one.',
    answeredBy:
      'node scripts/check-drill-age.mjs over artifacts/drills/restore-report.json, plus a maximum age ' +
      'actually configured in that artefact — an unconfigured bound makes "newer than the maximum ' +
      'age" a comparison against nothing',
  }),
  Object.freeze({
    id: 'security-findings-clear',
    label: 'No untriaged critical or high security finding',
    why:
      'ADR 0125: an empty register is not a clean one. "No findings" and "nobody looked" are the same ' +
      'register until an engagement has been performed, so this requirement is refused while ' +
      'engagement.booked is false and refused again by any unresolved finding of blocking severity.',
    answeredBy: 'node scripts/go-live-security.mjs over artifacts/security/findings.json',
  }),
  Object.freeze({
    id: 'three-clean-dry-runs',
    label: 'Three recorded dry runs, every one clean',
    why:
      'One run proves the importers execute, two prove the result is reproducible, and the third is ' +
      'what distinguishes reproducible from "two runs happened to agree" (ADR 0070). A migration ' +
      'performed without them is a migration whose variance nobody has ever seen.',
    answeredBy: 'tsx scripts/check-dry-runs.mjs over artifacts/migration/run-*.json',
  }),
  Object.freeze({
    id: 'provisional-settings-confirmed',
    label: 'No provisional setting left unconfirmed',
    why:
      'docs/OPEN-QUESTIONS’ own rule is that every provisional value is a strictest-safe assumption ' +
      'the build chose and is corrected with one audited settings change at deploy-and-check time. A ' +
      'provisional value still in place on the day the business goes live is a figure this build ' +
      'invented, operating on real customers and real money.',
    answeredBy:
      'the app_setting rows for the keys packages/config declares provisional: confirmed means a row ' +
      'exists and is_provisional is false',
  }),
])

/** What a gatherer found about one requirement. */
export interface GoNoGoFinding {
  readonly id: string
  readonly state: GoNoGoState
  /** The fact, in the words of whatever produced it. Printed verbatim. */
  readonly detail: string
}

/** A requirement joined to its finding, for the report. */
export interface GoNoGoItem extends GoNoGoRequirement {
  readonly state: GoNoGoState
  readonly detail: string
}

/** A problem, as the script prints it. */
export interface GoNoGoProblem {
  readonly rule: string
  readonly detail: string
}

export type GoNoGoReleaseVerdict =
  | { readonly go: true; readonly items: readonly GoNoGoItem[]; readonly examined: number }
  | {
      readonly go: false
      readonly items: readonly GoNoGoItem[]
      readonly examined: number
      readonly problems: readonly GoNoGoProblem[]
    }

/**
 * May this build go live.
 *
 * Every problem names the requirement id, so the acceptance line's *"a fixture with exactly one unmet
 * item names that item and no other"* is a property of the returned list rather than of the printing.
 */
export function releaseGoNoGoVerdict(
  findings: readonly GoNoGoFinding[],
  requirements: readonly GoNoGoRequirement[] = GO_NO_GO_REQUIREMENTS,
): GoNoGoReleaseVerdict {
  const problems: GoNoGoProblem[] = []
  const bad = (rule: string, detail: string) => problems.push({ rule, detail })

  // The floors first. Every verdict below is a walk over one of these two lists, and a walk over an
  // empty list finds nothing to object to — which is the one failure a release gate must not have.
  if (requirements.length === 0) {
    bad(
      GO_NO_GO_RULES.examinedNothing,
      'no requirement is declared, so "every item is met" would be a claim about nothing',
    )
  }
  if (findings.length === 0) {
    bad(
      GO_NO_GO_RULES.examinedNothing,
      'nothing was examined. A gatherer that produced no finding at all reports exactly what a clean ' +
        'build reports, and this is the difference',
    )
  }

  const declared = new Map(requirements.map((requirement) => [requirement.id, requirement]))
  const seen = new Map<string, GoNoGoFinding>()
  for (const finding of findings) {
    if (!declared.has(finding.id)) {
      bad(
        GO_NO_GO_RULES.notDeclared,
        `${finding.id} is not one of the ${requirements.length} declared requirement(s) ` +
          `(${[...declared.keys()].join(', ')}), so nothing holds it to a source`,
      )
      continue
    }
    if (seen.has(finding.id)) {
      bad(
        GO_NO_GO_RULES.answeredTwice,
        `${finding.id} is answered twice; the second answer would win a lookup silently and the two ` +
          'disagree about whether this build may ship',
      )
      continue
    }
    if (!GO_NO_GO_STATES.includes(finding.state)) {
      bad(
        GO_NO_GO_RULES.notDeclared,
        `${finding.id} has state ${JSON.stringify(finding.state)}; the set is ` +
          `${GO_NO_GO_STATES.join(', ')} and there is no default`,
      )
      continue
    }
    seen.set(finding.id, finding)
  }

  const items: GoNoGoItem[] = []
  for (const requirement of requirements) {
    const finding = seen.get(requirement.id)
    if (finding === undefined) {
      bad(
        GO_NO_GO_RULES.notAnswered,
        `${requirement.id} (${requirement.label}) was not examined. ${requirement.answeredBy}`,
      )
      // Recorded as `unknown` in the report too, so the printed table has a row for every requirement
      // and a reader cannot mistake a shorter table for a cleaner one.
      items.push({ ...requirement, state: 'unknown', detail: 'not examined' })
      continue
    }
    items.push({ ...requirement, state: finding.state, detail: finding.detail })
    if (finding.state === 'unmet') {
      bad(GO_NO_GO_RULES.unmet, `${requirement.id}: ${finding.detail}`)
    } else if (finding.state === 'unknown') {
      bad(
        GO_NO_GO_RULES.unknown,
        `${requirement.id}: ${finding.detail}. An absent fact blocks exactly as hard as a refusal — ` +
          'on the day of a cutover, "we did not measure it" and "it failed" have the same consequence',
      )
    }
  }

  const examined = seen.size
  return problems.length === 0
    ? { go: true, items, examined }
    : { go: false, items, examined, problems }
}

/** The widest state label, so the report's columns line up without a layout library. */
const STATE_WIDTH = Math.max(...GO_NO_GO_STATES.map((state) => state.length))

/**
 * The verdict, rendered. Deterministic, so a snapshot test is a real test.
 *
 * Every requirement appears, including the met ones, for `renderGoNoGo`'s reason one subject over: an
 * output listing only the blockers tells a reader nothing about what was cleared on their behalf.
 */
export function renderReleaseGoNoGo(verdict: GoNoGoReleaseVerdict): string {
  const lines: string[] = ['RELEASE GO/NO-GO', '']
  for (const item of verdict.items) {
    // The id as well as the label, on every row including the met ones. A reader who wants to re-run
    // one requirement needs the id the problems are reported under, and a report that printed only
    // prose would make the cleared half of the set unsearchable.
    lines.push(
      `  ${item.state.toUpperCase().padEnd(STATE_WIDTH + 2)}${item.id} \u2014 ${item.label}`,
    )
    lines.push(`  ${' '.repeat(STATE_WIDTH + 2)}${item.detail}`)
  }
  lines.push('')
  lines.push(`requirements examined: ${verdict.examined} of ${verdict.items.length}`)
  if (verdict.go) {
    lines.push('VERDICT: go')
    return lines.join('\n')
  }
  lines.push(`VERDICT: no-go, ${verdict.problems.length} problem(s)`)
  for (const problem of verdict.problems) lines.push(`  [${problem.rule}] ${problem.detail}`)
  return lines.join('\n')
}
