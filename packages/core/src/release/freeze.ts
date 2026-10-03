/**
 * The code freeze: a CLAIM a human makes, recorded with who and when, and a merge rule derived from it.
 *
 * H-MIG-11. Pure, and the shape is the one this repository already uses three times for the same
 * reason — G-REV-06's *"Marked as posted"* (migration 0128), H-HARD-07's incident register, and
 * H-MIG-10's `parallel_run_decision` (ADR 0107).
 *
 * ## Nothing here decides the freeze
 *
 * A freeze is the moment a business stops accepting change before a cutover. Nothing in this repository
 * knows when that moment is: the cutover date is not on file, no release calendar exists, and the
 * question of when the business is ready is the owner's. So there is deliberately **no mechanism that
 * decides it** — no date arithmetic, no "frozen once the go/no-go passes", no job that sets it. The
 * register holds a state somebody set, with the role that set it, the instant they set it and their
 * reason, and {@link freezeProblems} refuses a frozen register that is missing any of the three.
 *
 * The reason is the one migration 0128 states about a posting claim: a row that says only *the tree was
 * frozen at 14:02* is a fact nobody is answerable for, and the first question asked of it — *who said
 * so?* — has no answer at all.
 *
 * ## Why a ROLE and never a person
 *
 * No name of a person is in this repository (brief rule 10), and F07's role set is what every other
 * attributed claim in this build records. `owner` is a role an auditor can resolve to a person outside
 * this repository; a name typed into a JSON file is a string this build invented.
 *
 * ## Why the exempt label is a constant and not a field of the register
 *
 * {@link LAUNCH_BLOCKING_LABEL} is in code because the register is a working file somebody edits on
 * purpose (ADR 0125's argument for having no digest over the findings register). A label named in the
 * register could be edited to one every pull request already carries — `bug`, say — and the freeze
 * would then permit everything while reading as enforced. The label a freeze exempts is a decision,
 * so it lives where a decision lives, and changing it is a diff a reviewer sees in the gate's own
 * fixtures.
 */
import { ROLES } from '../access/permissions.ts'

/** Rule names, printed verbatim by the script so a gate case can assert the rule (ADR 0003). */
export const FREEZE_RULES = {
  malformed: 'freeze-register-malformed',
  unknownState: 'freeze-state-not-in-closed-set',
  /** Frozen, and missing the who, the when or the why. The whole point of the register. */
  declaredWithoutClaimant: 'freeze-declared-without-a-claimant',
  /** A claimant that is not an F07 role: a person's name, a team, a free string. */
  claimantNotARole: 'freeze-claimant-is-not-a-role',
  /** Open, and carrying a claim. Either it is frozen and the state should say so, or the claim is stale. */
  openWithClaimant: 'freeze-open-and-carries-a-claim',
  /** Open, and naming no open question. An absence has to be visibly unanswered (brief rule 15). */
  openWithoutOpenQuestion: 'freeze-open-without-an-open-question',
  /** The merge rule: the tree is frozen and this change is not labelled launch-blocking. */
  mergeRefused: 'merge-refused-while-the-tree-is-frozen',
  /** The floor: judging a merge against no label information at all. */
  labelsNotSupplied: 'freeze-merge-labels-not-supplied',
} as const

/**
 * The label that exempts a change from the freeze. One, and closed.
 *
 * A single label rather than a set, because every additional exemption is a second way through: the
 * freeze exists to make *is this change worth the risk* a question somebody answers out loud, and two
 * labels is two answers to it.
 */
export const LAUNCH_BLOCKING_LABEL = 'launch-blocking'

/** The register's states. Closed, no default. */
export const FREEZE_STATES = ['open', 'frozen'] as const
export type FreezeState = (typeof FREEZE_STATES)[number]

/** Who declared the freeze, when, and why. Absent together or present together. */
export interface FreezeClaim {
  /** An F07 role, never a person (brief rule 10). */
  readonly declaredBy: string
  readonly declaredAtIso: string
  /** Why, in the words somebody will be held to. A freeze with no stated reason cannot be lifted. */
  readonly rationale: string
}

export interface FreezeRegister {
  readonly registerVersion: number
  readonly state: FreezeState
  /** Present exactly when `state` is `frozen`. */
  readonly claim: FreezeClaim | null
  /**
   * While the tree is OPEN, the id of the question whose answer would set a freeze date.
   *
   * Required, so that "not frozen" reads as *nobody has declared one and here is what is missing*
   * rather than as *the freeze is over*.
   */
  readonly openQuestionId: string | null
}

export const FREEZE_REGISTER_VERSION = 1

export interface FreezeProblem {
  readonly rule: string
  readonly detail: string
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

/**
 * Parses a freeze register, refusing an unknown state rather than defaulting one.
 *
 * Returns the problems rather than throwing, so the script can print every one.
 */
export function parseFreezeRegister(
  raw: unknown,
  where: string,
): { readonly register: FreezeRegister | null; readonly problems: readonly FreezeProblem[] } {
  const problems: FreezeProblem[] = []
  const bad = (rule: string, detail: string) => problems.push({ rule, detail })
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    bad(FREEZE_RULES.malformed, `${where} is not an object`)
    return { register: null, problems }
  }
  const root = raw as Record<string, unknown>
  if (root['registerVersion'] !== FREEZE_REGISTER_VERSION) {
    bad(
      FREEZE_RULES.malformed,
      `${where} is register version ${String(root['registerVersion'])} and this build reads version ` +
        `${FREEZE_REGISTER_VERSION}`,
    )
    return { register: null, problems }
  }
  const state = root['state']
  if (!FREEZE_STATES.includes(state as FreezeState)) {
    bad(
      FREEZE_RULES.unknownState,
      `${where} has state ${JSON.stringify(state)}. The set is ${FREEZE_STATES.join(', ')} and there ` +
        'is no default: a defaulted state is how a frozen tree comes to accept every merge',
    )
    return { register: null, problems }
  }
  const rawClaim = root['claim']
  let claim: FreezeClaim | null = null
  if (rawClaim !== null && rawClaim !== undefined) {
    if (typeof rawClaim !== 'object' || Array.isArray(rawClaim)) {
      bad(FREEZE_RULES.malformed, `${where}'s claim is neither an object nor null`)
      return { register: null, problems }
    }
    const row = rawClaim as Record<string, unknown>
    if (
      !nonEmpty(row['declaredBy']) ||
      !nonEmpty(row['declaredAtIso']) ||
      !nonEmpty(row['rationale'])
    ) {
      bad(
        FREEZE_RULES.declaredWithoutClaimant,
        `${where}'s claim must state declaredBy, declaredAtIso and rationale. A freeze recorded ` +
          'without all three is a fact nobody is answerable for, and the first question asked of it — ' +
          'who said so? — has no answer at all',
      )
      return { register: null, problems }
    }
    claim = {
      declaredBy: row['declaredBy'],
      declaredAtIso: row['declaredAtIso'],
      rationale: row['rationale'],
    }
  }
  const openQuestionId = root['openQuestionId']
  return {
    register: {
      registerVersion: FREEZE_REGISTER_VERSION,
      state: state as FreezeState,
      claim,
      openQuestionId: nonEmpty(openQuestionId) ? openQuestionId : null,
    },
    problems,
  }
}

/**
 * Every way the register is not a record of a claim.
 *
 * Run by `pnpm freeze` on every commit, because a malformed freeze register is a defect in the
 * repository whatever the release position is — `pnpm findings`' argument about its own register.
 */
export function freezeProblems(register: FreezeRegister): readonly FreezeProblem[] {
  const problems: FreezeProblem[] = []
  const bad = (rule: string, detail: string) => problems.push({ rule, detail })
  if (register.state === 'frozen') {
    if (register.claim === null) {
      bad(
        FREEZE_RULES.declaredWithoutClaimant,
        'the tree is frozen and no claim is recorded. Nothing in this build decides a freeze, so a ' +
          'frozen state with no role, no instant and no reason behind it is a state that arrived from ' +
          'nowhere and can be lifted by anybody',
      )
    } else if (!ROLES.includes(register.claim.declaredBy as (typeof ROLES)[number])) {
      bad(
        FREEZE_RULES.claimantNotARole,
        `the freeze is declared by ${JSON.stringify(register.claim.declaredBy)}, which is not one of ` +
          `the F07 roles (${ROLES.join(', ')}). A role resolves to a person outside this repository; ` +
          'a name typed in here is a string this build invented (brief rule 10)',
      )
    }
    return problems
  }
  // Open. The two refusals here are the ones that keep "not frozen" honest.
  if (register.claim !== null) {
    bad(
      FREEZE_RULES.openWithClaimant,
      'the tree is open and the register still carries a claim. Either it is frozen and the state ' +
        'should say so, or the freeze was lifted and the claim is a record of a period that has ' +
        'ended — which belongs in the history of the decision and not in the live state',
    )
  }
  if (register.openQuestionId === null) {
    bad(
      FREEZE_RULES.openWithoutOpenQuestion,
      'the tree is open and the register names no open question. A blank reads like a field nobody ' +
        'filled in; the id is what makes "no freeze has been declared" visibly unanswered rather than ' +
        'quietly fine (brief rule 15)',
    )
  }
  return problems
}

/** What a merge may do, and why. */
export type MergeVerdict =
  | { readonly permitted: true; readonly reason: string }
  | { readonly permitted: false; readonly problems: readonly FreezeProblem[] }

/**
 * May this change be merged.
 *
 * `labels` is the set the change carries. `null` is NOT an empty set: it is the absence of label
 * information — a workflow whose expression resolved to nothing, a caller that forgot the flag — and
 * an absence must not read as *this change carries no exempt label, refuse it* either, because a
 * refusal nobody can satisfy is a gate somebody switches off. It is refused by its own rule, naming
 * the absence.
 */
export function mergePermitted(
  register: FreezeRegister,
  labels: readonly string[] | null,
): MergeVerdict {
  const shape = freezeProblems(register)
  if (shape.length > 0) return { permitted: false, problems: shape }
  if (labels === null) {
    return {
      permitted: false,
      problems: [
        {
          rule: FREEZE_RULES.labelsNotSupplied,
          detail:
            'no label information was supplied, so "this change is labelled launch-blocking" is a ' +
            'claim about nothing. An empty set of labels is a change with no labels; an absent set is ' +
            'a caller that did not look',
        },
      ],
    }
  }
  if (register.state === 'open') {
    return {
      permitted: true,
      reason:
        'the tree is not frozen. No freeze has been declared, so every change is permitted — and ' +
        `nothing in this build will declare one (${register.openQuestionId ?? 'no open question'})`,
    }
  }
  if (labels.includes(LAUNCH_BLOCKING_LABEL)) {
    const claim = register.claim
    return {
      permitted: true,
      reason:
        `labelled ${LAUNCH_BLOCKING_LABEL}, and the freeze declared by ${claim?.declaredBy ?? 'nobody'} ` +
        `at ${claim?.declaredAtIso ?? 'no instant'} exempts it`,
    }
  }
  return {
    permitted: false,
    problems: [
      {
        rule: FREEZE_RULES.mergeRefused,
        detail:
          `the tree is frozen (declared by ${register.claim?.declaredBy ?? 'nobody'} at ` +
          `${register.claim?.declaredAtIso ?? 'no instant'}: ${register.claim?.rationale ?? ''}) and ` +
          `this change carries [${labels.join(', ') || 'no labels'}] rather than ` +
          `${LAUNCH_BLOCKING_LABEL}. A change that has to go in during a freeze is a change somebody ` +
          'is prepared to label as launch-blocking and be asked about afterwards',
      },
    ],
  }
}

/** The register and a merge verdict, rendered. Deterministic, so a snapshot test is a real test. */
export function renderFreeze(register: FreezeRegister, verdict: MergeVerdict): string {
  const lines: string[] = ['CODE FREEZE']
  lines.push(`state: ${register.state.toUpperCase()}`)
  if (register.claim === null) {
    lines.push(
      `declared by: nobody (${register.openQuestionId ?? 'no open question named'}) — nothing in ` +
        'this build decides a freeze',
    )
  } else {
    lines.push(`declared by: ${register.claim.declaredBy} at ${register.claim.declaredAtIso}`)
    lines.push(`because: ${register.claim.rationale}`)
  }
  lines.push('')
  if (verdict.permitted) {
    lines.push(`MERGE: permitted — ${verdict.reason}`)
    return lines.join('\n')
  }
  lines.push(`MERGE: refused, ${verdict.problems.length} problem(s)`)
  for (const problem of verdict.problems) lines.push(`  [${problem.rule}] ${problem.detail}`)
  return lines.join('\n')
}
