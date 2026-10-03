/**
 * The security findings register: closed enums, a closing rule, and a go/no-go verdict.
 *
 * H-HARD-10. Pure, and separate from `scripts/go-live-security.mjs`, for `go-live-payments.mjs`'s stated
 * reason: a judgement that lives in a script is a judgement no test reaches.
 *
 * ## Why the register is a FILE and not a table
 *
 * The declared file for this unit was a migration. The register is `artifacts/security/findings.json`
 * instead, and the reason is what a go/no-go decision has to be reproducible from:
 *
 *   * **A release gate that reads database state cannot be re-run from the commit.** "Was the build
 *     clear to ship on the 3rd?" is answered by `git show`, not by whatever rows the database holds
 *     today — and a findings table is mutable by exactly the person the gate is about.
 *   * **The register is reviewed, not entered.** A finding arrives from an engagement report or from
 *     `scripts/security-baseline-scan.mjs`, and closing one requires a commit, a test reference or a
 *     written acceptance. All three of those are repository facts, so the register belongs beside them
 *     where a reviewer sees the finding and its remediation in one diff.
 *   * **It needs no database to run.** The gate is run before a release, on a machine that may have
 *     nothing deployed.
 *
 * There is deliberately **no digest** over this file, which is the opposite of the restore drill's
 * artefact (ADR 0123) and worth saying why: a drill report is a MEASUREMENT and a hand edit to it is
 * always a falsification, whereas this register is a working document somebody edits on purpose. The
 * control on an edit here is the closing rule — a finding cannot be closed without a commit, a test
 * reference or a rationale — plus the review of the diff.
 *
 * ## Why an empty register does NOT pass
 *
 * No engagement has been booked (`Y13-pentest`). An empty register would make the go-live check green,
 * and "no findings" is indistinguishable from "nobody looked" — which is ADR 0002's shape applied to a
 * security review. So {@link goNoGoVerdict} refuses while `engagement.booked` is false, and
 * `scripts/go-live-security.mjs` is therefore NOT in `pnpm verify`: it exits non-zero today and is
 * supposed to, exactly as `go-live-payments.mjs` does for the same reason.
 */

/** Rule names, printed verbatim by the scripts so a gate case can assert the rule (ADR 0003). */
export const FINDING_RULES = {
  unknownSeverity: 'finding-severity-not-in-closed-set',
  unknownStatus: 'finding-status-not-in-closed-set',
  malformed: 'finding-malformed',
  duplicateId: 'finding-id-used-twice',
  closedWithoutEvidence: 'finding-closed-without-evidence',
  acceptedWithoutRationale: 'finding-accepted-without-rationale',
  duplicateWithoutOriginal: 'finding-duplicate-without-original',
  blocking: 'go-live-blocked-by-finding',
  engagementNotBooked: 'go-live-blocked-engagement-not-performed',
  registerExaminedNothing: 'finding-register-examined-nothing',
} as const

/**
 * Severity, closed. Five values and no default: an import carrying anything else FAILS.
 *
 * Closed rather than free text because the gate turns on it. A report whose severity read `Critical`,
 * `P1` or `sev-1` would, with any defaulting at all, become whatever the default was — and the default
 * nobody would notice is the one that lets a critical finding through as a medium.
 */
export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'informational'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

/**
 * Status, closed. Seven values, and the three that CLOSE a finding each need their own evidence.
 *
 * `accepted_with_rationale` is not a synonym for `fixed`: one says the hole is gone and the other says
 * somebody decided to live with it. Collapsing them would make the register unable to answer the only
 * question an auditor asks about a closed critical finding, which is which of the two it was.
 */
export const FINDING_STATUSES = [
  'open',
  'triaged',
  'in_progress',
  'fixed',
  'accepted_with_rationale',
  'false_positive',
  'duplicate',
] as const
export type FindingStatus = (typeof FINDING_STATUSES)[number]

/** The statuses that close a finding. Each needs evidence; see {@link findingProblems}. */
export const CLOSING_STATUSES: readonly FindingStatus[] = Object.freeze([
  'fixed',
  'accepted_with_rationale',
  'false_positive',
  'duplicate',
])

/** The statuses that leave a finding OPEN for the go/no-go question. */
export const UNRESOLVED_STATUSES: readonly FindingStatus[] = Object.freeze([
  'open',
  'triaged',
  'in_progress',
])

/** The severities that block a release while unresolved. */
export const BLOCKING_SEVERITIES: readonly FindingSeverity[] = Object.freeze(['critical', 'high'])

/** Where a finding came from. Closed, because "an engagement found it" is a different claim from "a scan did". */
export const FINDING_SOURCES = [
  'penetration_test',
  'automated_baseline',
  'code_review',
  'reported_externally',
] as const
export type FindingSource = (typeof FINDING_SOURCES)[number]

/** What was done about a finding. Required for a closing status, and refused for an unresolved one. */
export interface FindingRemediation {
  /** A commit this repository holds. Evidence that the hole is gone. */
  readonly commit?: string
  /** A test that would fail if it came back. Better evidence than a commit, for the same reason as ADR 0003. */
  readonly testReference?: string
  /** For `accepted_with_rationale` and `false_positive`: why, in words somebody will be held to. */
  readonly rationale?: string
  /** For `accepted_with_rationale`: the F07 role that accepted it. A role and never a person (brief rule 10). */
  readonly acceptedBy?: string
  /** For `duplicate`: the finding this one repeats. */
  readonly duplicateOf?: string
}

export interface SecurityFinding {
  readonly id: string
  readonly title: string
  readonly severity: FindingSeverity
  readonly status: FindingStatus
  readonly source: FindingSource
  /** What is wrong, in enough detail to reproduce. */
  readonly detail: string
  /** Where: a route, a module, a table. */
  readonly surface: string
  readonly raisedAtIso: string
  readonly remediation?: FindingRemediation
}

/** Whether an engagement has actually been performed. An empty register is not a clean one. */
export interface EngagementState {
  readonly booked: boolean
  /** What stands in while it is not booked. */
  readonly standIn: string
  readonly openQuestionId: string
}

export interface FindingsRegister {
  readonly registerVersion: number
  readonly engagement: EngagementState
  readonly findings: readonly SecurityFinding[]
}

export const FINDINGS_REGISTER_VERSION = 1

/** A problem, as both scripts print it. */
export interface FindingProblem {
  readonly rule: string
  readonly detail: string
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/**
 * Parses a register, refusing an unknown severity or status rather than defaulting one.
 *
 * Returns the problems rather than throwing, so a script can print every one: a report with four
 * mis-spelled severities should be corrected once and not four times.
 */
export function parseFindingsRegister(
  raw: unknown,
  where: string,
): { readonly register: FindingsRegister | null; readonly problems: readonly FindingProblem[] } {
  const problems: FindingProblem[] = []
  const bad = (rule: string, detail: string) => problems.push({ rule, detail })
  if (raw === null || typeof raw !== 'object') {
    bad(FINDING_RULES.malformed, `${where} is not an object`)
    return { register: null, problems }
  }
  const root = raw as Record<string, unknown>
  if (root['registerVersion'] !== FINDINGS_REGISTER_VERSION) {
    bad(
      FINDING_RULES.malformed,
      `${where} is register version ${String(root['registerVersion'])} and this build reads version ` +
        `${FINDINGS_REGISTER_VERSION}`,
    )
    return { register: null, problems }
  }
  const engagement = root['engagement']
  if (engagement === null || typeof engagement !== 'object') {
    bad(FINDING_RULES.malformed, `${where} states no engagement`)
    return { register: null, problems }
  }
  const eng = engagement as Record<string, unknown>
  if (
    typeof eng['booked'] !== 'boolean' ||
    !nonEmpty(eng['standIn']) ||
    !nonEmpty(eng['openQuestionId'])
  ) {
    bad(
      FINDING_RULES.malformed,
      `${where}'s engagement must state booked, standIn and openQuestionId. "No findings" and "nobody ` +
        'looked" are the same register without it',
    )
    return { register: null, problems }
  }
  if (!Array.isArray(root['findings'])) {
    bad(FINDING_RULES.malformed, `${where} has no findings array`)
    return { register: null, problems }
  }

  const findings: SecurityFinding[] = []
  const seen = new Set<string>()
  for (const [at, entry] of (root['findings'] as readonly unknown[]).entries()) {
    const at1 = `${where} finding ${at + 1}`
    if (entry === null || typeof entry !== 'object') {
      bad(FINDING_RULES.malformed, `${at1} is not an object`)
      continue
    }
    const row = entry as Record<string, unknown>
    const id = row['id']
    if (!nonEmpty(id)) {
      bad(FINDING_RULES.malformed, `${at1} has no id`)
      continue
    }
    if (seen.has(id)) {
      bad(FINDING_RULES.duplicateId, `${id} appears twice; the second would win a lookup silently`)
      continue
    }
    seen.add(id)
    const severity = row['severity']
    if (!FINDING_SEVERITIES.includes(severity as FindingSeverity)) {
      bad(
        FINDING_RULES.unknownSeverity,
        `${id} has severity ${JSON.stringify(severity)}. The set is ${FINDING_SEVERITIES.join(', ')} ` +
          'and there is no default: a defaulted severity is how a critical finding becomes a medium',
      )
      continue
    }
    const status = row['status']
    if (!FINDING_STATUSES.includes(status as FindingStatus)) {
      bad(
        FINDING_RULES.unknownStatus,
        `${id} has status ${JSON.stringify(status)}. The set is ${FINDING_STATUSES.join(', ')}`,
      )
      continue
    }
    if (!FINDING_SOURCES.includes(row['source'] as FindingSource)) {
      bad(
        FINDING_RULES.malformed,
        `${id} has source ${JSON.stringify(row['source'])}; "an engagement found it" and "a scan found ` +
          'it" are different claims and the set is closed',
      )
      continue
    }
    for (const field of ['title', 'detail', 'surface', 'raisedAtIso'] as const) {
      if (!nonEmpty(row[field])) bad(FINDING_RULES.malformed, `${id} has no ${field}`)
    }
    findings.push({
      id,
      title: String(row['title'] ?? ''),
      severity: severity as FindingSeverity,
      status: status as FindingStatus,
      source: row['source'] as FindingSource,
      detail: String(row['detail'] ?? ''),
      surface: String(row['surface'] ?? ''),
      raisedAtIso: String(row['raisedAtIso'] ?? ''),
      ...(row['remediation'] !== undefined && row['remediation'] !== null
        ? { remediation: row['remediation'] as FindingRemediation }
        : {}),
    })
  }

  if (problems.length > 0) return { register: null, problems }
  return {
    register: {
      registerVersion: FINDINGS_REGISTER_VERSION,
      engagement: {
        booked: eng['booked'] as boolean,
        standIn: eng['standIn'] as string,
        openQuestionId: eng['openQuestionId'] as string,
      },
      findings,
    },
    problems,
  }
}

/**
 * The closing rule: a finding may not be closed without evidence, and the evidence depends on HOW.
 *
 * This is the acceptance line "closing a finding without a linked commit, test reference or
 * accepted-risk rationale is refused with a named error", with one addition the line implies: evidence
 * on an UNRESOLVED finding is also refused. A row that says `open` and carries a commit is a row
 * somebody fixed and forgot to close, and reading it as open is the safe direction only until somebody
 * notices the commit and assumes the status is stale.
 */
export function findingProblems(finding: SecurityFinding): readonly FindingProblem[] {
  const problems: FindingProblem[] = []
  const remediation = finding.remediation
  const closing = CLOSING_STATUSES.includes(finding.status)
  if (!closing) {
    if (remediation !== undefined && Object.keys(remediation).length > 0) {
      problems.push({
        rule: FINDING_RULES.malformed,
        detail:
          `${finding.id} is ${finding.status} and carries remediation. Either it is closed and the ` +
          'status should say so, or the remediation belongs in the detail as work in progress',
      })
    }
    return problems
  }
  if (finding.status === 'fixed') {
    if (!nonEmpty(remediation?.commit) && !nonEmpty(remediation?.testReference)) {
      problems.push({
        rule: FINDING_RULES.closedWithoutEvidence,
        detail:
          `${finding.id} is fixed and names neither a commit nor a test reference. "Fixed" with no ` +
          'evidence is a status somebody set, and a test that would fail if it came back is better ' +
          'evidence than a commit (ADR 0003)',
      })
    }
  }
  if (finding.status === 'accepted_with_rationale') {
    if (!nonEmpty(remediation?.rationale)) {
      problems.push({
        rule: FINDING_RULES.acceptedWithoutRationale,
        detail:
          `${finding.id} is accepted and states no rationale. Accepting a risk is a decision, and a ` +
          'decision with no stated reason cannot be revisited when the circumstances change',
      })
    }
    if (!nonEmpty(remediation?.acceptedBy)) {
      problems.push({
        rule: FINDING_RULES.acceptedWithoutRationale,
        detail: `${finding.id} is accepted and names no role that accepted it`,
      })
    }
  }
  if (finding.status === 'false_positive' && !nonEmpty(remediation?.rationale)) {
    problems.push({
      rule: FINDING_RULES.closedWithoutEvidence,
      detail:
        `${finding.id} is a false positive and states no rationale. A scanner's finding dismissed with ` +
        'no reason is the one that comes back next quarter and is dismissed again',
    })
  }
  if (finding.status === 'duplicate' && !nonEmpty(remediation?.duplicateOf)) {
    problems.push({
      rule: FINDING_RULES.duplicateWithoutOriginal,
      detail: `${finding.id} is a duplicate and names no original, so nothing tracks the real finding`,
    })
  }
  return problems
}

/** Every closing-rule problem across the register. */
export function registerProblems(register: FindingsRegister): readonly FindingProblem[] {
  return register.findings.flatMap((finding) => findingProblems(finding))
}

/** The go/no-go answer. */
export type GoNoGoVerdict =
  | { readonly go: true; readonly examined: number }
  | { readonly go: false; readonly problems: readonly FindingProblem[]; readonly examined: number }

/**
 * May this build go live, as far as the security review is concerned.
 *
 * Two reasons it can refuse, and the second is the one that matters today: an unresolved finding of
 * blocking severity, and an engagement that has not been performed at all.
 */
export function goNoGoVerdict(register: FindingsRegister): GoNoGoVerdict {
  const problems: FindingProblem[] = [...registerProblems(register)]
  for (const finding of register.findings) {
    if (
      BLOCKING_SEVERITIES.includes(finding.severity) &&
      UNRESOLVED_STATUSES.includes(finding.status)
    ) {
      problems.push({
        rule: FINDING_RULES.blocking,
        detail: `${finding.id} (${finding.severity}, ${finding.status}): ${finding.title} — ${finding.surface}`,
      })
    }
  }
  if (!register.engagement.booked) {
    problems.push({
      rule: FINDING_RULES.engagementNotBooked,
      detail:
        'no penetration test has been performed, so this register being clear says nothing. "No ' +
        `findings" and "nobody looked" are the same register (${register.engagement.openQuestionId}). ` +
        `What stands in: ${register.engagement.standIn}`,
    })
  }
  const examined = register.findings.length
  return problems.length === 0 ? { go: true, examined } : { go: false, problems, examined }
}

/**
 * The register, rendered for the go/no-go output. Deterministic, so a snapshot test is a real test.
 *
 * Every finding appears, including the closed ones, and that is the acceptance line's point: a go/no-go
 * output listing only the blockers tells a reader nothing about what was accepted on their behalf.
 */
export function renderGoNoGo(register: FindingsRegister): string {
  const lines: string[] = []
  lines.push('SECURITY GO/NO-GO')
  lines.push(
    `engagement: ${register.engagement.booked ? 'performed' : 'NOT PERFORMED'} (${register.engagement.openQuestionId})`,
  )
  lines.push(`stands in: ${register.engagement.standIn}`)
  lines.push('')
  lines.push(`findings: ${register.findings.length}`)
  for (const severity of FINDING_SEVERITIES) {
    const matching = register.findings.filter((finding) => finding.severity === severity)
    const unresolved = matching.filter((finding) => UNRESOLVED_STATUSES.includes(finding.status))
    lines.push(`  ${severity}: ${matching.length} (${unresolved.length} unresolved)`)
  }
  if (register.findings.length > 0) lines.push('')
  for (const finding of [...register.findings].sort((left, right) =>
    left.id < right.id ? -1 : 1,
  )) {
    lines.push(
      `  [${finding.severity}/${finding.status}] ${finding.id} ${finding.title} (${finding.source}) ` +
        `on ${finding.surface}`,
    )
    const remediation = finding.remediation
    if (remediation !== undefined) {
      const parts = [
        remediation.commit === undefined ? null : `commit ${remediation.commit}`,
        remediation.testReference === undefined ? null : `test ${remediation.testReference}`,
        remediation.acceptedBy === undefined ? null : `accepted by ${remediation.acceptedBy}`,
        remediation.duplicateOf === undefined ? null : `duplicate of ${remediation.duplicateOf}`,
        remediation.rationale === undefined ? null : `rationale: ${remediation.rationale}`,
      ].filter((part): part is string => part !== null)
      if (parts.length > 0) lines.push(`      ${parts.join('; ')}`)
    }
  }
  const verdict = goNoGoVerdict(register)
  lines.push('')
  lines.push(verdict.go ? 'VERDICT: go' : `VERDICT: no-go, ${verdict.problems.length} problem(s)`)
  if (!verdict.go)
    for (const problem of verdict.problems) lines.push(`  [${problem.rule}] ${problem.detail}`)
  return lines.join('\n')
}
