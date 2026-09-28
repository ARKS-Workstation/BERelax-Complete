import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The publication control plane's writes (W-SITE-10).
 *
 * Migration 0093 is the authority for every rule here; this module is the only thing in the build that
 * writes these three tables, and what it adds is the ORDER of the statements — a lint pass, then an
 * approval that cites it, then a published record that cites both, each in one transaction with the audit
 * row the database refuses to commit without.
 *
 * ## Why every refusal is checked here AND in the database
 *
 * Because they are not the same check. The pure decision
 * (`packages/core/src/publication/state-machine.ts`) is what lets a screen grey a button and this module
 * report a rule name instead of a SQLSTATE; the database is what holds when a caller does not come through
 * here at all. A rejected INSERT also consumes a `seq`, so asking first is cheaper as well as clearer.
 *
 * What this module must never do is let the two disagree. It does not carry a second copy of the arrows —
 * it imports them — and `packages/fixtures/src/publication-control-plane.itest.ts` drives both layers with
 * the same pairs.
 *
 * ## Why the hash is computed by PostgreSQL
 *
 * `consentWordingHash` settled this and the argument transfers unchanged: one definition of the digest
 * exists, and a second implementation in TypeScript would agree today and be two things to change
 * tomorrow — with the symptom of a disagreement being a correctly approved page refused as tampered. The
 * CANONICAL FORM is a different question and belongs in `@berelax/core`, which is pure and is where the
 * regions are already known; this module hashes the string that function produced.
 */

// ------------------------------------------------------------------------------------------------
// Refusals and the codes 0093 raises
// ------------------------------------------------------------------------------------------------

/**
 * Every refusal this module raises, by name. Three, and each one is raised below.
 *
 * Deliberately NOT a longer list of plausible refusals: a name nothing can raise is a rule a reader
 * believes exists, which is the same defect as a check that examines nothing. The refusals that belong to
 * the DATABASE are not here either — they arrive as the SQLSTATEs in {@link PUBLICATION_SQLSTATE}, and
 * restating them as names here would be two vocabularies for one set of rules.
 */
export const PUBLICATION_REFUSALS = [
  /** No regulatory profile is in force, so nothing can say what the lint compared against. */
  'publication_profile_absent',
  /** A revert was asked for against a record that is not a published record of this surface. */
  'publication_revert_target_not_published',
  /** A revert was asked for against the record that is already live, which changes nothing. */
  'publication_revert_target_is_live',
] as const
export type PublicationRefusal = (typeof PUBLICATION_REFUSALS)[number]

/** The SQLSTATEs 0093 raises, so a caller tells one refusal from any other conflict. */
export const PUBLICATION_SQLSTATE = {
  recordImmutable: 'ZZ001',
  transitionNotPermitted: 'ZZ002',
  correctionMustSupersede: 'ZZ003',
  notAudited: 'ZZ004',
  overWeightBudget: 'ZZ005',
} as const

/** Audit actions this module writes. Named constants, so a caller can count a delta on one. */
export const PUBLICATION_AUDIT_ACTIONS = {
  /** The one 0093's deferred constraint trigger looks for. Renaming it breaks every publish. */
  published: 'publication.publish',
  lintPassed: 'publication.lint_passed',
  approved: 'publication.approved',
  reverted: 'publication.revert',
} as const

function refuse(
  refusal: PublicationRefusal,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new AppError('invariant_violated', message, { details: { ...details, refusal } })
}

/** The named refusal carried on an error this module raised, or null. */
export function publicationRefusalOf(err: unknown): PublicationRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' &&
    (PUBLICATION_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as PublicationRefusal)
    : null
}

/** The SQLSTATE a driver error carries, or null. */
export function publicationSqlstateOf(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

// ------------------------------------------------------------------------------------------------
// The content digest
// ------------------------------------------------------------------------------------------------

/**
 * The sha256 of one canonical content string, computed by PostgreSQL. See the header.
 *
 * Lower-case hex, which is the form `publication_lint_pass.content_sha256`'s CHECK requires, and
 * `encode(sha256(...))` produces it directly. `convert_to(..., 'UTF8')` is explicit rather than implied:
 * the same Arabic paragraph hashed under two server encodings is two hashes, and this digest is compared
 * across a lint, an approval and a publish that may be weeks apart.
 */
export async function publicationContentHash(sql: Sql, canonical: string): Promise<string> {
  const [row] = await sql<{ digest: string }[]>`
    select encode(sha256(convert_to(${canonical}, 'UTF8')), 'hex') as digest
  `
  if (row === undefined) throw new AppError('invariant_violated', 'sha256 returned no row')
  return row.digest
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

export interface PublicationPositionRow {
  /** `unrecorded` when the surface has no record at all. */
  readonly state: 'unrecorded' | 'draft' | 'lint_passed' | 'approved' | 'published'
  readonly currentRecordId: string | null
  readonly currentContentSha256: string | null
  readonly seq: number | null
}

/**
 * Where a surface stands: the state of its newest record.
 *
 * Ordered by `seq` and not by `recorded_at` or `id`. `recorded_at` comes from an injected clock and two
 * records written under a frozen one share it exactly; a uuid v7 ties for two rows inserted in the same
 * transaction. `seq` is `generated always as identity` and cannot.
 */
export async function publicationPosition(
  sql: Sql,
  surface: string,
): Promise<PublicationPositionRow> {
  const [row] = await sql<{ state: string; id: string; contentSha256: string; seq: string }[]>`
    select state, id, content_sha256 as "contentSha256", seq
      from publication_record
     where surface = ${surface}
     order by seq desc
     limit 1
  `
  if (row === undefined) {
    return { state: 'unrecorded', currentRecordId: null, currentContentSha256: null, seq: null }
  }
  return {
    state: row.state as PublicationPositionRow['state'],
    currentRecordId: row.id,
    currentContentSha256: row.contentSha256,
    seq: Number(row.seq),
  }
}

export interface PublicationRecordRow {
  readonly id: string
  readonly seq: number
  readonly surface: string
  readonly state: string
  readonly contentSha256: string
  readonly lintPassId: string | null
  readonly approvalId: string | null
  readonly supersedesId: string | null
  readonly measuredCriticalPathBytes: number | null
  readonly criticalPathBudgetBytes: number | null
  readonly recordedAt: Date
}

const RECORD_COLUMNS = `
  id, seq, surface, state, content_sha256 as "contentSha256", lint_pass_id as "lintPassId",
  approval_id as "approvalId", supersedes_id as "supersedesId",
  measured_critical_path_bytes as "measuredCriticalPathBytes",
  critical_path_budget_bytes as "criticalPathBudgetBytes", recorded_at as "recordedAt"
`

const asRecord = (row: Record<string, unknown>): PublicationRecordRow => ({
  id: String(row['id']),
  seq: Number(row['seq']),
  surface: String(row['surface']),
  state: String(row['state']),
  contentSha256: String(row['contentSha256']),
  lintPassId: row['lintPassId'] === null ? null : String(row['lintPassId']),
  approvalId: row['approvalId'] === null ? null : String(row['approvalId']),
  supersedesId: row['supersedesId'] === null ? null : String(row['supersedesId']),
  measuredCriticalPathBytes:
    row['measuredCriticalPathBytes'] === null ? null : Number(row['measuredCriticalPathBytes']),
  criticalPathBudgetBytes:
    row['criticalPathBudgetBytes'] === null ? null : Number(row['criticalPathBudgetBytes']),
  recordedAt: row['recordedAt'] as Date,
})

/** Every record of one surface, oldest first. The ledger, which is what makes a revert reviewable. */
export async function publicationHistory(
  sql: Sql,
  surface: string,
): Promise<readonly PublicationRecordRow[]> {
  const rows = await sql.unsafe(
    `select ${RECORD_COLUMNS} from publication_record where surface = $1 order by seq asc`,
    [surface],
  )
  return (rows as unknown as Record<string, unknown>[]).map(asRecord)
}

/** One record by id, or null. Used to prove a superseded record stays readable after it is replaced. */
export async function publicationRecordById(
  sql: Sql,
  id: string,
): Promise<PublicationRecordRow | null> {
  const rows = await sql.unsafe(
    `select ${RECORD_COLUMNS} from publication_record where id = $1::uuid`,
    [id],
  )
  const row = (rows as unknown as Record<string, unknown>[])[0]
  return row === undefined ? null : asRecord(row)
}

// ------------------------------------------------------------------------------------------------
// Writes
// ------------------------------------------------------------------------------------------------

export interface LintPassInput {
  readonly surface: string
  readonly contentSha256: string
  /** How many banned terms the pass compared against. `> 0` by CHECK; see 0093. */
  readonly termsChecked: number
  readonly lintedAt: Date
  readonly actorKind: 'staff' | 'system'
  readonly actorLabel: string
}

/**
 * Records a PASSED lint, against the profile in force, and appends the `lint_passed` record.
 *
 * The profile version is read here rather than taken from the caller: it is the row the lint was decided
 * by, and a caller that could pass it could pass a different one. `regulatory_profile_current` and not the
 * table, for 0054's reason — the table holds every version ever written and the answer would become
 * whichever row PostgreSQL happened to return first.
 */
export async function recordLintPass(
  sql: Sql,
  input: LintPassInput,
): Promise<{ readonly lintPassId: string; readonly recordId: string }> {
  return await sql.begin(async (tx) => {
    const [profile] = await tx<{ version: number }[]>`
      select version from regulatory_profile_current
    `
    if (profile === undefined) {
      refuse(
        'publication_profile_absent',
        'No regulatory profile is in force, so nothing can say which vocabulary the lint compared ' +
          'against. A lint pass recorded without one is evidence for a check whose rules are unknown.',
        { surface: input.surface },
      )
    }
    const [pass] = await tx<{ id: string }[]>`
      insert into publication_lint_pass (
        surface, content_sha256, regulatory_profile_version, terms_checked, linted_at,
        actor_kind, actor_label
      ) values (
        ${input.surface}, ${input.contentSha256}, ${profile.version}, ${input.termsChecked},
        ${input.lintedAt}, ${input.actorKind}, ${input.actorLabel}
      ) returning id
    `
    if (pass === undefined)
      throw new AppError('invariant_violated', 'lint pass insert returned no row')
    const [record] = await tx<{ id: string }[]>`
      insert into publication_record (
        surface, state, content_sha256, lint_pass_id, recorded_at, actor_kind, actor_label
      ) values (
        ${input.surface}, 'lint_passed', ${input.contentSha256}, ${pass.id}::uuid,
        ${input.lintedAt}, ${input.actorKind}, ${input.actorLabel}
      ) returning id
    `
    if (record === undefined)
      throw new AppError('invariant_violated', 'record insert returned no row')
    await tx`
      insert into audit_event (
        actor_kind, actor_label, action, entity_type, entity_id, operation, after_state
      ) values (
        ${input.actorKind}, ${input.actorLabel}, ${PUBLICATION_AUDIT_ACTIONS.lintPassed},
        'publication_record', ${record.id}, 'create',
        ${tx.json({
          surface: input.surface,
          contentSha256: input.contentSha256,
          regulatoryProfileVersion: profile.version,
          termsChecked: input.termsChecked,
        })}
      )
    `
    return { lintPassId: pass.id, recordId: record.id }
  })
}

/** Opens a surface, or reopens it after an edit. The only state that needs no evidence. */
export async function recordDraft(
  sql: Sql,
  input: {
    readonly surface: string
    readonly contentSha256: string
    readonly recordedAt: Date
    readonly actorKind: 'staff' | 'system'
    readonly actorLabel: string
  },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into publication_record (
      surface, state, content_sha256, recorded_at, actor_kind, actor_label
    ) values (
      ${input.surface}, 'draft', ${input.contentSha256}, ${input.recordedAt},
      ${input.actorKind}, ${input.actorLabel}
    ) returning id
  `
  if (row === undefined) throw new AppError('invariant_violated', 'draft insert returned no row')
  return row.id
}

export interface ApprovalInput {
  readonly surface: string
  readonly lintPassId: string
  /**
   * The hash of the content being approved.
   *
   * Passed rather than read from the lint pass, and that is the whole point of the column: the caller
   * hashes what it is about to publish, and if that differs from what was linted the composite foreign key
   * refuses the row. Reading it from the parent here would make the mismatch unreachable and the test of it
   * a test of nothing.
   */
  readonly contentSha256: string
  readonly approverUserId: string
  /** Snapshotted, so a later rename cannot rewrite who approved what. */
  readonly approverDisplayName: string
  readonly approverRole: string
  readonly approvedAt: Date
}

/** Records a named approval of one content hash, and appends the `approved` record. */
export async function recordApproval(
  sql: Sql,
  input: ApprovalInput,
): Promise<{ readonly approvalId: string; readonly recordId: string }> {
  return await sql.begin(async (tx) => {
    const [approval] = await tx<{ id: string }[]>`
      insert into publication_approval (
        lint_pass_id, content_sha256, approver_user_id, approver_display_name, approver_role,
        approved_at
      ) values (
        ${input.lintPassId}::uuid, ${input.contentSha256}, ${input.approverUserId},
        ${input.approverDisplayName}, ${input.approverRole}, ${input.approvedAt}
      ) returning id
    `
    if (approval === undefined) {
      throw new AppError('invariant_violated', 'approval insert returned no row')
    }
    const [record] = await tx<{ id: string }[]>`
      insert into publication_record (
        surface, state, content_sha256, lint_pass_id, recorded_at, actor_kind, actor_label
      ) values (
        ${input.surface}, 'approved', ${input.contentSha256}, ${input.lintPassId}::uuid,
        ${input.approvedAt}, 'staff', ${input.approverDisplayName}
      ) returning id
    `
    if (record === undefined)
      throw new AppError('invariant_violated', 'record insert returned no row')
    await tx`
      insert into audit_event (
        actor_kind, actor_id, actor_label, action, entity_type, entity_id, operation, after_state
      ) values (
        'staff', null, ${input.approverDisplayName}, ${PUBLICATION_AUDIT_ACTIONS.approved},
        'publication_record', ${record.id}, 'create',
        ${tx.json({
          surface: input.surface,
          contentSha256: input.contentSha256,
          lintPassId: input.lintPassId,
          approverUserId: input.approverUserId,
          approverRole: input.approverRole,
        })}
      )
    `
    return { approvalId: approval.id, recordId: record.id }
  })
}

export interface PublishInput {
  readonly surface: string
  readonly lintPassId: string
  readonly approvalId: string
  readonly contentSha256: string
  /** What the publish-time weight check measured, and the budget it judged against. Both required. */
  readonly measuredCriticalPathBytes: number
  readonly criticalPathBudgetBytes: number
  readonly recordedAt: Date
  readonly actorKind: 'staff' | 'system'
  readonly actorLabel: string
  /** Set exactly when the surface is already published: a correction or a revert (ZZ003). */
  readonly supersedesId?: string | null
}

/**
 * Appends the `published` record, with its audit row, in one transaction.
 *
 * The audit INSERT is not optional and is not a courtesy: 0093's deferred constraint trigger refuses the
 * COMMIT without it (ZZ004). So this function cannot be made to publish silently by deleting a line — the
 * transaction would roll back — which is the difference between an audited publish and a publish that
 * happens to be audited today.
 */
export async function publishSurface(
  sql: Sql,
  input: PublishInput,
): Promise<{ readonly recordId: string; readonly supersededId: string | null }> {
  return await sql.begin(async (tx) => {
    const supersedes = input.supersedesId ?? null
    const [record] = await tx<{ id: string }[]>`
      insert into publication_record (
        surface, state, content_sha256, lint_pass_id, approval_id, supersedes_id,
        measured_critical_path_bytes, critical_path_budget_bytes, recorded_at, actor_kind, actor_label
      ) values (
        ${input.surface}, 'published', ${input.contentSha256}, ${input.lintPassId}::uuid,
        ${input.approvalId}::uuid, ${supersedes}, ${input.measuredCriticalPathBytes},
        ${input.criticalPathBudgetBytes}, ${input.recordedAt}, ${input.actorKind}, ${input.actorLabel}
      ) returning id
    `
    if (record === undefined) throw new AppError('invariant_violated', 'publish returned no row')
    await tx`
      insert into audit_event (
        actor_kind, actor_label, action, entity_type, entity_id, operation, after_state
      ) values (
        ${input.actorKind}, ${input.actorLabel}, ${PUBLICATION_AUDIT_ACTIONS.published},
        'publication_record', ${record.id}, 'create',
        ${tx.json({
          surface: input.surface,
          contentSha256: input.contentSha256,
          lintPassId: input.lintPassId,
          approvalId: input.approvalId,
          supersedesId: supersedes,
          measuredCriticalPathBytes: input.measuredCriticalPathBytes,
          criticalPathBudgetBytes: input.criticalPathBudgetBytes,
        })}
      )
    `
    return { recordId: record.id, supersededId: supersedes }
  })
}

/**
 * Reverts a surface to an earlier published record.
 *
 * Three properties the acceptance criterion asks for, and each is a consequence of the shape rather than
 * of care taken here:
 *
 *   * **The exact approved content hash is restored**, because the new row copies `content_sha256`,
 *     `lint_pass_id` and `approval_id` from the target. It does not re-lint and does not re-approve: the
 *     content being restored was linted and approved once, and asking for a second approval of unchanged
 *     copy is how a revert comes to be done by hand instead.
 *   * **A new record is written**, never an edit — the table refuses one (ZZ001).
 *   * **The superseded record stays readable**, because nothing touches it. It is named by
 *     `supersedes_id`, which is what makes "what was live on that date" answerable afterwards.
 *
 * The weight figures are re-measured by the caller rather than copied from the target, and that is
 * deliberate: the page is rendered from today's templates and today's renditions, so the target's figure
 * describes bytes nobody will download. A revert that reintroduced an over-budget page would be refused
 * with today's number, which is the answer wanted.
 */
export async function revertSurfaceTo(
  sql: Sql,
  input: {
    readonly surface: string
    readonly targetRecordId: string
    readonly measuredCriticalPathBytes: number
    readonly criticalPathBudgetBytes: number
    readonly recordedAt: Date
    readonly actorKind: 'staff' | 'system'
    readonly actorLabel: string
  },
): Promise<{
  readonly recordId: string
  readonly supersededId: string
  readonly contentSha256: string
}> {
  const target = await publicationRecordById(sql, input.targetRecordId)
  if (target === null || target.surface !== input.surface || target.state !== 'published') {
    refuse(
      'publication_revert_target_not_published',
      `Cannot revert '${input.surface}' to record ${input.targetRecordId}: it is not a published record ` +
        'of that surface. A revert restores a version that was actually live, which is the only thing a ' +
        'named approval covers.',
      {
        surface: input.surface,
        targetRecordId: input.targetRecordId,
        state: target?.state ?? null,
      },
    )
  }
  const position = await publicationPosition(sql, input.surface)
  if (position.currentRecordId === target.id) {
    refuse(
      'publication_revert_target_is_live',
      `Record ${target.id} is already the live version of '${input.surface}', so a revert to it would ` +
        'write a publication record for a change that did not happen.',
      { surface: input.surface, targetRecordId: input.targetRecordId },
    )
  }
  if (target.lintPassId === null || target.approvalId === null) {
    // Unreachable through the CHECK on `published`, and asserted rather than assumed: a narrowing here is
    // cheaper than a null reaching the INSERT and coming back as a constraint name.
    throw new AppError(
      'invariant_violated',
      `Published record ${target.id} carries no lint pass or approval, which its CHECK forbids.`,
    )
  }
  const published = await publishSurface(sql, {
    surface: input.surface,
    lintPassId: target.lintPassId,
    approvalId: target.approvalId,
    contentSha256: target.contentSha256,
    measuredCriticalPathBytes: input.measuredCriticalPathBytes,
    criticalPathBudgetBytes: input.criticalPathBudgetBytes,
    recordedAt: input.recordedAt,
    actorKind: input.actorKind,
    actorLabel: input.actorLabel,
    supersedesId: position.currentRecordId,
  })
  return {
    recordId: published.recordId,
    supersededId: position.currentRecordId as string,
    contentSha256: target.contentSha256,
  }
}
