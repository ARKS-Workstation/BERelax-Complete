import {
  assertMayReadCommissionDerivation,
  type CommissionBasis,
  type CommissionRoundingMode,
  type CommissionRuleVersion,
  type CommissionRunPlan,
  computeCommission,
  localDate,
  planCommissionRun,
  type Role,
} from '@berelax/core'
import {
  type Actor,
  type CommissionDerivationRow,
  type CommissionRuleVersionRow,
  commissionPeriodSource,
  readCommissionDerivation,
  readCommissionEarnings,
  readCommissionRuleVersions,
  recordCommissionRun,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'

/**
 * The commission run: the one place `@berelax/core`'s arithmetic meets `@berelax/db`'s rows.
 *
 * `packages/db` may never import `packages/core` (brief rule 4), so neither package can perform a run on
 * its own: the repository reads earnings and records lines, the engine turns the first into the second, and
 * something has to hold both. `packages/hr` already depends on both for P-HR-01's reason, which makes it the
 * right home — the alternative is a second copy of the arithmetic inside `packages/db`, and two
 * implementations of a money formula is two chances to get the rounding wrong.
 *
 * ## The two entry points, and why recomputing is a DIFFERENT function
 *
 * {@link executeCommissionRun} computes a period for the FIRST time. It resolves the version that governs
 * the period start, reads the earnings as at the instant the period's figures should be read at, and records
 * a run.
 *
 * {@link recomputeCommissionRun} computes a period AGAIN, and it takes the run to reproduce. Everything that
 * decided the first answer — the rule version, and the instant the source figures were read at — comes off
 * that row rather than being resolved again. That separation is the unit: a recompute that resolved the
 * version would answer with whatever is in force today, so a rate published in June would silently restate
 * March, and the arithmetic would be correct the whole way. One function doing both, with the version
 * optional, is exactly the shape in which somebody later forgets to pass it.
 */

/** A rule version row, as the pure engine wants it. */
function asRuleVersion(row: CommissionRuleVersionRow): CommissionRuleVersion {
  return {
    ruleVersionId: row.ruleVersionId,
    version: row.version,
    effectiveFrom: localDate(row.effectiveFrom),
    // The columns are `text` in the repository's row type, because `packages/db` may not import the core
    // vocabularies that narrow them. Narrowed here, at the one boundary that knows both, and by a
    // comparison rather than a cast: a third `basis` added to the migration without being added to
    // `COMMISSION_BASES` would arrive here as the other value, which is why the CHECK and the union are
    // asserted equal by `packages/fixtures/src/hr-commission.itest.ts` against `pg_constraint`.
    basis: row.basis as CommissionBasis,
    roundingMode: row.roundingMode as CommissionRoundingMode,
    bands: row.bands.map((band) => ({
      bandNo: band.bandNo,
      fromFils: band.fromFils,
      rateBp: band.rateBp,
    })),
  }
}

export interface CommissionRunResult {
  readonly runId: string | null
  readonly totalFils: number
  readonly lineCount: number
  readonly ruleVersion: number | null
  readonly sourceAsOf: string
  readonly lockedPeriodId: string | null
  /** Why no run was recorded, or null when one was. */
  readonly inertReason: CommissionRunPlan['inertReason']
}

export interface ExecuteCommissionRunArgs {
  readonly periodStartsOn: string
  readonly periodEndsOn: string
  /**
   * Whether the module is enabled. An ARGUMENT and not a `loadConfig()` call here, because this package has
   * no business reading configuration: the caller reads `hr.commission_enabled` (the settings registry,
   * `false` and provisional against Y9-commission) and passes the answer, which is also what lets a test
   * exercise both states without editing a setting.
   */
  readonly moduleEnabled: boolean
  /** The instant an OPEN period's figures are read at. A locked period's comes from the lock. */
  readonly nowIso: string
  readonly actor: Actor
}

/**
 * Computes a period for the first time, and records it.
 *
 * Returns an inert result rather than throwing when there is nothing to apply, and the two reasons stay
 * distinguishable all the way to the caller: `module_disabled` is a settings change and `no_rule_version` is
 * a migration, and a screen showing the wrong one sends an operator to the wrong place. **No run row is
 * written in either case** — a run needs a `rule_version_id` and there is none, which is the schema
 * refusing to record a computation that did not happen rather than this function choosing not to.
 */
export async function executeCommissionRun(
  sql: Sql,
  args: ExecuteCommissionRunArgs,
): Promise<CommissionRunResult> {
  const source = await commissionPeriodSource(sql, {
    periodEndsOn: args.periodEndsOn,
    nowIso: args.nowIso,
  })
  const versions = await readCommissionRuleVersions(sql)
  const plan = planCommissionRun({
    moduleEnabled: args.moduleEnabled,
    versions: versions.map(asRuleVersion),
    periodStartsOn: localDate(args.periodStartsOn),
  })

  if (plan.ruleVersion === null) {
    return {
      runId: null,
      totalFils: 0,
      lineCount: 0,
      ruleVersion: null,
      sourceAsOf: source.sourceAsOf,
      lockedPeriodId: source.lockedPeriodId,
      inertReason: plan.inertReason,
    }
  }

  return runWith(sql, {
    ruleVersion: plan.ruleVersion,
    periodStartsOn: args.periodStartsOn,
    periodEndsOn: args.periodEndsOn,
    sourceAsOf: source.sourceAsOf,
    lockedPeriodId: source.lockedPeriodId,
    moduleEnabled: true,
    actor: args.actor,
  })
}

export interface RecomputeCommissionRunArgs {
  /** The run to reproduce. Everything that decided its answer comes off it. */
  readonly run: {
    readonly ruleVersionId: string
    readonly periodStartsOn: string
    readonly periodEndsOn: string
    readonly sourceAsOf: string
    readonly lockedPeriodId: string | null
  }
  readonly actor: Actor
}

/**
 * Computes a period again under the version and as at the instant a previous run used.
 *
 * The version is looked up BY ID among the published versions and is not re-resolved by date: a version
 * superseded twice over is still the one that judged the run, and `commissionRuleFor` would answer with
 * today's. This is the function the reproducibility acceptance line is about, and it deliberately takes no
 * `nowIso` at all — there is no instant it could use that would not break the claim.
 */
export async function recomputeCommissionRun(
  sql: Sql,
  args: RecomputeCommissionRunArgs,
): Promise<CommissionRunResult> {
  const versions = await readCommissionRuleVersions(sql)
  const pinned = versions.find((row) => row.ruleVersionId === args.run.ruleVersionId)
  if (pinned === undefined) {
    // Unreachable through any statement the database permits: `commission_run.rule_version_id` is a
    // foreign key and `commission_rule` refuses every DELETE (ZY071). Answered rather than asserted,
    // because the alternative is a non-null assertion that becomes a crash on the one read where the
    // impossible happened — a restore with triggers off, for instance.
    throw new Error(
      `Commission run names rule version ${args.run.ruleVersionId}, which is not published. A run cannot ` +
        'be reproduced without the version that judged it, and that version is a foreign key nothing can ' +
        'delete — so this is a database that has been restored around the constraint.',
    )
  }

  return runWith(sql, {
    ruleVersion: asRuleVersion(pinned),
    periodStartsOn: args.run.periodStartsOn,
    periodEndsOn: args.run.periodEndsOn,
    sourceAsOf: args.run.sourceAsOf,
    lockedPeriodId: args.run.lockedPeriodId,
    moduleEnabled: true,
    actor: args.actor,
  })
}

/** The shared half: read the earnings at the instant, price them under the version, record the run. */
async function runWith(
  sql: Sql,
  args: {
    readonly ruleVersion: CommissionRuleVersion
    readonly periodStartsOn: string
    readonly periodEndsOn: string
    readonly sourceAsOf: string
    readonly lockedPeriodId: string | null
    readonly moduleEnabled: boolean
    readonly actor: Actor
  },
): Promise<CommissionRunResult> {
  const earnings = await readCommissionEarnings(sql, {
    periodStartsOn: args.periodStartsOn,
    periodEndsOn: args.periodEndsOn,
    sourceAsOf: args.sourceAsOf,
  })

  const computed = computeCommission({
    ruleVersion: args.ruleVersion,
    earnings: earnings.map((row) => ({
      appointmentId: row.appointmentId,
      employeeId: row.employeeId,
      tradingDate: localDate(row.tradingDate),
      source: row.source,
      invoiceId: row.invoiceId,
      packageRedemptionId: row.packageRedemptionId,
      grossFils: row.grossFils,
      vatFils: row.vatFils,
    })),
  })

  const recorded = await withUnitOfWork(sql, args.actor, (uow) =>
    recordCommissionRun(uow, {
      ruleVersionId: args.ruleVersion.ruleVersionId,
      periodStartsOn: args.periodStartsOn,
      periodEndsOn: args.periodEndsOn,
      sourceAsOf: args.sourceAsOf,
      lockedPeriodId: args.lockedPeriodId,
      moduleEnabled: args.moduleEnabled,
      lines: computed.lines.map((line) => ({ ...line, tradingDate: String(line.tradingDate) })),
      totalFils: computed.totalFils,
      computedByActorKind: args.actor.kind === 'staff' ? 'staff' : 'system',
      computedByActorId: args.actor.id ?? null,
    }),
  )

  return {
    runId: recorded.runId,
    totalFils: recorded.totalFils,
    lineCount: recorded.lineCount,
    ruleVersion: args.ruleVersion.version,
    sourceAsOf: args.sourceAsOf,
    lockedPeriodId: args.lockedPeriodId,
    inertReason: null,
  }
}

/**
 * One run's derivation for one employee, refused when the viewer may not read it.
 *
 * The refusal happens BEFORE the read and not by filtering it, and that is the acceptance line's "another
 * employee's id returns a refusal": a filtered read of somebody else's derivation returns an empty list,
 * which reads as "no commission" rather than as "not yours" — and a therapist told they earned nothing is a
 * worse answer than a therapist told they may not look.
 */
export async function readCommissionDerivationFor(
  sql: Sql,
  args: {
    readonly runId: string
    readonly role: Role
    readonly viewerEmployeeId: string
    readonly subjectEmployeeId: string
  },
): Promise<readonly CommissionDerivationRow[]> {
  assertMayReadCommissionDerivation({
    role: args.role,
    viewerEmployeeId: args.viewerEmployeeId,
    subjectEmployeeId: args.subjectEmployeeId,
  })
  return readCommissionDerivation(sql, {
    runId: args.runId,
    employeeId: args.subjectEmployeeId,
  })
}
