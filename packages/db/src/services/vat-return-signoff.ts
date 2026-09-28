import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import {
  canonicaliseVat201WorkingPapers,
  type Vat201Period,
  type Vat201WorkingPapers,
  vat201ContentHash,
  vat201WorkingPapers,
} from '../queries/vat201-working-papers.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The VAT return as a sealed snapshot, its two signatures, and the one door a filing may come through.
 *
 * M-VAT-08. M-VAT-07's {@link vat201WorkingPapers} is a FUNCTION OF THE LEDGER — recomputed on every read,
 * which is exactly right for a working paper and exactly wrong for a filed return. A return is a statement
 * made on a date about a period, and the one thing it must not do is change when the ledger behind it does.
 *
 * So this module takes the papers ONCE, stores the canonical bytes, and never looks at the journal again.
 * Everything a caller reads afterwards comes out of those bytes: {@link vatReturnBoxFigures} selects from
 * `vat_return_box_figure`, a VIEW over `vat_return.snapshot_json` that touches no ledger table at all
 * (0095). `packages/db/src/services/vat-return-signoff.itest.ts` proves the difference the only way it can
 * be proved — it reopens the period, posts another entry, closes it again, and requires the stored figures
 * and the stored hash not to move while the regenerated paper's hash DOES.
 *
 * ## Almost nothing here is a rule
 *
 * Every refusal this module can produce is raised by 0095 and translated here. That is deliberate and it is
 * the acceptance criteria's own wording — "refused in the database rather than in the service layer" — for
 * the reason 0087 and 0093 both record: a rule that lives in a service is a rule for the callers that went
 * through the service. A `psql` session, a restored dump and the next caller who writes a filing path
 * without reading this one are three writers that do not.
 *
 * So {@link signOffVatReturn} does not compare the preparer's id with the reviewer's, and
 * {@link finaliseVatReturn} does not check that both signatures exist. They INSERT, and the database
 * refuses. What this module adds is the `AppError` a screen can render and the audit row the refusal's
 * own constraint trigger requires.
 *
 * ## What the snapshot carries, and why each part is there
 *
 *   * `snapshot_json` — the figures, as the exact bytes `canonicaliseVat201WorkingPapers()` produced.
 *   * `content_hash` — sha256 of those bytes. A CHECK in 0095 ties the two, so the column cannot be the
 *     hash of something else, and the acceptance line "regenerating with the clock five years on reproduces
 *     the stored content hash" is a comparison of one hex string.
 *   * `trial_balance_hash` — `period_trial_balance_hash()`, M-VAT-06's evidence about the LEDGER. Different
 *     question: "is this the return I filed" against "is this the ledger it was filed from".
 *   * `engine_signature` and `format_version` — the GENERATING CODE VERSION, and neither is a number
 *     somebody typed. The signature is the sha256 of `pg_get_functiondef()` over the seven SQL functions
 *     that compute a VAT201 figure; the format version is the canonical form's own tag, taken from the
 *     paper.
 *   * `fileable` — the paper's verdict, which is the literal `false` while [UNVERIFIED] Y11-vat201-boxes
 *     and Y11-tax-agent stand. 0095 makes `true` impossible while the snapshot itself carries a reason
 *     against filing or a provisional box, so a snapshot cannot make an unfileable return look fileable.
 */

/** The SQLSTATEs `0095_vat_return.sql` raises. Class `ZY`, band 051-057; see that file's header. */
export const VAT_RETURN_SQLSTATE = {
  /** UPDATE or DELETE on a snapshot, a signature or a finalisation. */
  immutable: 'ZY051',
  /** One person signing as both preparer and reviewer. */
  samePersonSignOff: 'ZY052',
  /** A role outside `vat_return_signing_roles()`. */
  roleNotPermitted: 'ZY053',
  /** An amendment that is not the next version of the period in force. */
  amendmentNotWellFormed: 'ZY054',
  /** Marked final, or read for filing, without both signatures. */
  notSignedOff: 'ZY055',
  /** The engine's named function list and the catalogue disagree. */
  engineSignatureIncomplete: 'ZY056',
  /** A signature or a finalisation with no `audit_event` in the same transaction. */
  notAudited: 'ZY057',
} as const

/** `42501`: the application role holds no such privilege. The grant layer refusing, not a trigger. */
const INSUFFICIENT_PRIVILEGE = '42501'
/** `23514`: a CHECK refused the row — the layer that still holds when a restore has triggers off. */
const CHECK_VIOLATION = '23514'
/** `23505`: the UNIQUE index refused it. The restore-proof half of "two different people". */
const UNIQUE_VIOLATION = '23505'

export const VAT_RETURN_SIGN_OFF_CAPACITIES = ['preparer', 'reviewer'] as const
export type VatReturnSignOffCapacity = (typeof VAT_RETURN_SIGN_OFF_CAPACITIES)[number]

/** Raised when one person would hold both capacities. The acceptance criterion names it. */
export class SamePersonSignOff extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('conflict', message, { details })
    this.name = 'SamePersonSignOff'
  }
}

/** Raised when a return is marked final, or read for filing, without both signatures. */
export class VatReturnNotSignedOff extends AppError {
  constructor(message: string, details: Record<string, unknown>) {
    super('conflict', message, { details })
    this.name = 'VatReturnNotSignedOff'
  }
}

const sqlState = (err: unknown): string | null => {
  if (typeof err !== 'object' || err === null) return null
  const code = (err as { code?: unknown }).code
  if (typeof code === 'string') return code
  const carried = (err as { details?: { sqlState?: unknown } }).details?.sqlState
  return typeof carried === 'string' ? carried : null
}

const constraintOf = (err: unknown): string | null => {
  const name = (err as { constraint_name?: unknown }).constraint_name
  return typeof name === 'string' ? name : null
}

/**
 * Translates a VAT-return refusal into an `AppError`, or `null` if it is not one of ours.
 *
 * Every branch is `conflict` or `forbidden` and none is `validation`: the request is well formed in each
 * case and the STATE refuses it. A caller that presented `SamePersonSignOff` as validation would show
 * "you typed something wrong" to somebody whose only mistake was being the person who prepared it.
 *
 * `23514` and `23505` are translated as well as the private codes, and that is the point rather than
 * thoroughness: those are the layers that still hold when a restore has triggers off, so they are the
 * refusal a caller gets in exactly the circumstances where nothing else would refuse at all.
 */
export function vatReturnError(err: unknown): AppError | null {
  const code = sqlState(err)
  const message = err instanceof Error ? err.message : String(err)
  switch (code) {
    case VAT_RETURN_SQLSTATE.samePersonSignOff:
      return new SamePersonSignOff(message, { sqlState: code })
    case VAT_RETURN_SQLSTATE.notSignedOff:
      return new VatReturnNotSignedOff(message, { sqlState: code })
    case VAT_RETURN_SQLSTATE.immutable:
    case INSUFFICIENT_PRIVILEGE:
      return new AppError('forbidden', message, { details: { sqlState: code } })
    case VAT_RETURN_SQLSTATE.roleNotPermitted:
    case VAT_RETURN_SQLSTATE.amendmentNotWellFormed:
    case VAT_RETURN_SQLSTATE.notAudited:
    case VAT_RETURN_SQLSTATE.engineSignatureIncomplete:
      return new AppError('conflict', message, { details: { sqlState: code } })
    case UNIQUE_VIOLATION:
      // The storage layer catching what ZY052 catches first. Reported as the same kind of failure, so a
      // caller does not have to know which layer answered.
      return constraintOf(err) === 'vat_return_sign_off_is_two_people'
        ? new SamePersonSignOff(message, { sqlState: code, constraint: constraintOf(err) })
        : null
    case CHECK_VIOLATION:
      return constraintOf(err)?.startsWith('vat_return') === true
        ? new AppError('conflict', message, {
            details: { sqlState: code, constraint: constraintOf(err) },
          })
        : null
    default:
      return null
  }
}

// --- the shapes a caller reads ------------------------------------------------------------------

export interface StoredVatReturn {
  readonly id: string
  readonly periodId: string
  readonly startsOn: string
  readonly endsOn: string
  readonly version: number
  readonly supersedesId: string | null
  readonly amendmentReason: string | null
  readonly closedPeriodId: string
  readonly formatVersion: string
  /** The generating code version: sha256 over the seven engine functions' definitions. */
  readonly engineSignature: string
  readonly trialBalanceHash: string
  /** sha256 of {@link snapshotJson}, tied to it by a CHECK in 0095. */
  readonly contentHash: string
  /** The canonical bytes. The figures themselves, not a recipe for recomputing them. */
  readonly snapshotJson: string
  readonly fileable: boolean
  readonly preparedByActorKind: string
  readonly preparedByActorLabel: string
  readonly snapshottedAt: Date
}

/** One box as it stood when the return was snapshotted, read out of the hashed bytes. */
export interface VatReturnBoxFigure {
  readonly boxNo: number
  /** SNAPSHOTTED. A migration answering Y11-vat201-boxes renumbers the live rows, not this one. */
  readonly label: string
  readonly side: 'output' | 'input'
  readonly displayOrder: number
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly netSuppliesFils: bigint
  readonly taxFils: bigint
  readonly lineCount: number
}

export interface VatReturnSignature {
  readonly userId: string
  /** As it stood when they signed. A later rename cannot reach it. */
  readonly displayName: string
  readonly role: string
  readonly signedAt: Date
}

export interface VatReturnSignOffState {
  readonly preparer: VatReturnSignature | null
  readonly reviewer: VatReturnSignature | null
  /** Both capacities signed. From `vat_return_sign_off_state()`, the one reader of this question. */
  readonly signed: boolean
  /** When it was marked final, or `null`. A finalisation is refused while `signed` is false. */
  readonly finalisedAt: Date | null
}

export interface SnapshotVatReturnInput {
  readonly period: Vat201Period
  readonly preparedBy: { readonly kind: 'staff' | 'system'; readonly label: string }
  /** The caller's clock, as an ISO instant. Nothing here reads an ambient one. */
  readonly snapshottedAt: string
}

export interface AmendVatReturnInput extends SnapshotVatReturnInput {
  /** The version in force, which this one replaces. ZY054 refuses any other. */
  readonly supersedesId: string
  /** Why. ZY054 and a CHECK both refuse a blank one. */
  readonly amendmentReason: string
}

export interface SignOffVatReturnInput {
  readonly returnId: string
  readonly capacity: VatReturnSignOffCapacity
  readonly signatory: {
    readonly userId: string
    /** Taken from the row the signatory is signed in as. Never composed here (brief rule 10). */
    readonly displayName: string
    readonly role: string
  }
  readonly signedAt: string
}

export interface FinaliseVatReturnInput {
  readonly returnId: string
  readonly finalisedAt: string
  readonly actor: { readonly kind: 'staff' | 'system'; readonly label: string }
}

/** The return as a filing reads it. Refused with `ZY055` while it is unsigned or not final. */
export interface VatReturnForFiling {
  readonly returnId: string
  readonly periodId: string
  readonly startsOn: string
  readonly endsOn: string
  readonly version: number
  readonly contentHash: string
  readonly engineSignature: string
  readonly formatVersion: string
  readonly snapshotJson: string
  readonly finalisedAt: Date
}

// --- the consumer surface ------------------------------------------------------------------------

/**
 * Every function this module exports, and whether it may touch a return that is not signed off.
 *
 * The acceptance line is "a test asserts every path that consumes the return checks sign-off, enumerated
 * from the export surface", and this is that enumeration. It is a closed list compared against the module's
 * REAL exports by `vat-return-signoff.itest.ts`, which is what makes it a check rather than a comment: an
 * export added and not classified fails, so M-VAT-09's Zoho export cannot arrive without somebody deciding
 * in writing whether it needs a signature.
 *
 * The `false` entries are the important half, because a list where everything requires sign-off would be
 * the same thing as no list. A preparer has to be able to READ the figures they are about to sign — a
 * sign-off that cannot see what it signs is worse than no sign-off — so the reads are open and the two
 * paths that move a return towards being FILED are not.
 */
export interface VatReturnConsumer {
  /** The exported function's name, exactly. */
  readonly export: string
  readonly requiresSignOff: boolean
  /** Why it does or does not. Stated per entry, so a wrong answer is visible rather than inherited. */
  readonly why: string
}

export const VAT_RETURN_CONSUMERS: readonly VatReturnConsumer[] = [
  {
    export: 'snapshotVatReturn',
    requiresSignOff: false,
    why: 'It CREATES the return. Requiring a signature to take a snapshot would make the first one impossible.',
  },
  {
    export: 'amendVatReturn',
    requiresSignOff: false,
    why:
      'An amendment supersedes the version in force whether or not that version was signed, and ZY054 ' +
      'requires it to be the next version of the same period. Requiring a signature first would make a ' +
      'snapshot taken from a wrong figure uncorrectable: it cannot be edited, so the only way out is a ' +
      'new version.',
  },
  {
    export: 'readVatReturn',
    requiresSignOff: false,
    why: 'The row as stored. A preparer, a reviewer and an auditor all read this before anybody signs.',
  },
  {
    export: 'vatReturnBoxFigures',
    requiresSignOff: false,
    why:
      'The figures, out of the hashed bytes. This is WHAT A REVIEWER REVIEWS — refusing it until the ' +
      'return is signed would mean the second signature was given to something nobody could see.',
  },
  {
    export: 'vatReturnNotFileableReasons',
    requiresSignOff: false,
    why: "The snapshot's own reasons against filing. Read for the same purpose, by the same people.",
  },
  {
    export: 'vatReturnSignOffState',
    requiresSignOff: false,
    why:
      'It IS the sign-off question. A reader that had to be signed off to ask whether it was signed off ' +
      'could never answer.',
  },
  {
    export: 'vatReturnSigningRoles',
    requiresSignOff: false,
    why: 'The permitted roles, from the database. About no particular return.',
  },
  {
    export: 'signOffVatReturn',
    requiresSignOff: false,
    why: 'It is the signing. The second signature is refused a second time by ZY052, not by this list.',
  },
  {
    export: 'vatReturnError',
    requiresSignOff: false,
    why: 'A pure translation of a driver error. It touches no return and no database.',
  },
  {
    export: 'finaliseVatReturn',
    requiresSignOff: true,
    why:
      'Marking a return final is the acceptance line in those words. Refused by ZY055 from a BEFORE ' +
      'INSERT trigger on vat_return_finalisation, so a caller that skipped a check in TypeScript is ' +
      'refused anyway — including a psql session.',
  },
  {
    export: 'vatReturnForFiling',
    requiresSignOff: true,
    why:
      "The door a filing comes through, and M-VAT-09's one-way Zoho export reads it. Refused by ZY055 " +
      'from vat_return_for_filing() itself rather than from here, so the check cannot be skipped by a ' +
      'caller that did not know about it.',
  },
] as const

// --- snapshotting --------------------------------------------------------------------------------

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/

function assertInstant(value: string, what: string): void {
  if (!ISO_INSTANT.test(value)) {
    throw new AppError(
      'validation',
      `${what} must be an ISO instant with a zone (e.g. 2026-10-01T09:00:00.000Z), got "${value}". ` +
        'Nothing in this module reads an ambient clock, because every ordering assertion about a sign-off ' +
        'is made under a frozen one.',
    )
  }
}

/**
 * The bytes a snapshot stores, and the hash over them.
 *
 * The paper arrives carrying its own `contentHash`, and a hash over a value containing itself has no fixed
 * point — so the field is removed before canonicalising, which is exactly what {@link vat201ContentHash}
 * does. Both halves are computed from the same stripped object here rather than in two places, so the
 * stored bytes and the stored hash cannot be of different things. 0095's CHECK is what proves it, and this
 * is what stops that CHECK ever firing in production.
 */
function canonicalBytes(paper: Vat201WorkingPapers): { body: string; hash: string } {
  const { contentHash: _ignored, ...rest } = paper
  return { body: canonicaliseVat201WorkingPapers(rest), hash: vat201ContentHash(rest) }
}

const ROW_COLUMNS = `
  id, period_id, starts_on::text as starts_on, ends_on::text as ends_on, version, supersedes_id,
  amendment_reason, closed_period_id, format_version, engine_signature, trial_balance_hash,
  content_hash, snapshot_json, fileable, prepared_by_actor_kind, prepared_by_actor_label,
  snapshotted_at
`

interface VatReturnRow {
  id: string
  period_id: string
  starts_on: string
  ends_on: string
  version: number
  supersedes_id: string | null
  amendment_reason: string | null
  closed_period_id: string
  format_version: string
  engine_signature: string
  trial_balance_hash: string
  content_hash: string
  snapshot_json: string
  fileable: boolean
  prepared_by_actor_kind: string
  prepared_by_actor_label: string
  snapshotted_at: Date
}

const asStored = (row: VatReturnRow): StoredVatReturn => ({
  id: row.id,
  periodId: row.period_id,
  startsOn: row.starts_on,
  endsOn: row.ends_on,
  version: row.version,
  supersedesId: row.supersedes_id,
  amendmentReason: row.amendment_reason,
  closedPeriodId: row.closed_period_id,
  formatVersion: row.format_version,
  engineSignature: row.engine_signature,
  trialBalanceHash: row.trial_balance_hash,
  contentHash: row.content_hash,
  snapshotJson: row.snapshot_json,
  fileable: row.fileable,
  preparedByActorKind: row.prepared_by_actor_kind,
  preparedByActorLabel: row.prepared_by_actor_label,
  snapshottedAt: row.snapshotted_at,
})

/**
 * Takes the working papers for a CLOSED period and seals them as a new version of the return.
 *
 * `version` and `supersedes_id` are passed through to the database rather than computed by reading the
 * current version first and adding one: the read-then-write would race two preparers into one version
 * number, and `unique (period_id, version)` plus ZY054 already answer it. So version 1 is an INSERT with a
 * null supersession, and every later version goes through {@link amendVatReturn}, which names the row it
 * replaces.
 *
 * The papers are refused for an open period by {@link vat201WorkingPapers} itself, from `periodStatusOn` —
 * the only reader of "is this date closed?" in this repository. Nothing is re-checked here, because a
 * second reader would be a second answer.
 */
export async function snapshotVatReturn(
  uow: UnitOfWork,
  input: SnapshotVatReturnInput,
): Promise<StoredVatReturn> {
  return insertSnapshot(uow, input, null, null, 1)
}

/**
 * Amends a return: a NEW version carrying a reason, never an edit.
 *
 * The version is `supersedes.version + 1`, read from the row being superseded inside the same transaction.
 * That is not a second statement of the rule — ZY054 refuses anything that is not the next version of the
 * period in force — it is how the caller learns the number without having to know it.
 */
export async function amendVatReturn(
  uow: UnitOfWork,
  input: AmendVatReturnInput,
): Promise<StoredVatReturn> {
  const [prior] = await uow.sql<{ version: number }[]>`
    select version from vat_return where id = ${input.supersedesId}::uuid
  `
  if (!prior) {
    throw new AppError(
      'not_found',
      `No VAT return ${input.supersedesId} to amend. An amendment names the version it replaces, because ` +
        'the superseded version has to stay readable — that is what makes "what did we file, and on what" ' +
        'answerable at all.',
    )
  }
  return insertSnapshot(uow, input, input.supersedesId, input.amendmentReason, prior.version + 1)
}

async function insertSnapshot(
  uow: UnitOfWork,
  input: SnapshotVatReturnInput,
  supersedesId: string | null,
  amendmentReason: string | null,
  version: number,
): Promise<StoredVatReturn> {
  assertInstant(input.snapshottedAt, 'snapshottedAt')
  const paper = await vat201WorkingPapers(uow.sql, input.period)
  const { body, hash } = canonicalBytes(paper)

  let row: VatReturnRow | undefined
  try {
    ;[row] = await uow.sql<VatReturnRow[]>`
      insert into vat_return (
        period_id, starts_on, ends_on, version, supersedes_id, amendment_reason,
        closed_period_id, format_version, engine_signature, trial_balance_hash,
        content_hash, snapshot_json, fileable,
        prepared_by_actor_kind, prepared_by_actor_label, snapshotted_at
      ) values (
        ${paper.period.periodId},
        ${paper.period.startsOn}::date,
        ${paper.period.endsOn}::date,
        ${version},
        ${supersedesId}::uuid,
        ${amendmentReason},
        ${paper.closedPeriodId},
        ${paper.formatVersion},
        -- The generating code version, read from the catalogue inside the same statement that stores it,
        -- so it cannot be the signature of an engine that was replaced in between.
        vat201_engine_signature(),
        ${paper.trialBalanceHash},
        ${hash},
        ${body},
        ${paper.fileable},
        ${input.preparedBy.kind},
        ${input.preparedBy.label},
        ${input.snapshottedAt}::timestamptz
      )
      returning ${uow.sql.unsafe(ROW_COLUMNS)}
    `
  } catch (err) {
    throw vatReturnError(err) ?? err
  }
  if (!row) {
    throw new AppError('invariant_violated', 'the vat_return insert returned no row')
  }

  await uow.audit.record({
    action: 'vat_return.snapshotted',
    entityType: 'vat_return',
    entityId: row.id,
    operation: 'create',
    after: {
      periodId: row.period_id,
      version: row.version,
      supersedesId: row.supersedes_id,
      amendmentReason: row.amendment_reason,
      contentHash: row.content_hash,
      trialBalanceHash: row.trial_balance_hash,
      engineSignature: row.engine_signature,
      // Recorded although it is always false today, and recorded BECAUSE it is: a reader in five years
      // wants to see that the question was asked, not to infer it from the answer having been the same
      // every time (period-close.ts makes the same argument about a zero difference).
      fileable: row.fileable,
      notFileableReasons: paper.notFileableReasons.map((reason) => reason.reason),
    },
  })

  await uow.publish({
    eventType: 'vat_return.snapshotted',
    aggregateType: 'vat_return',
    aggregateId: row.id,
    payload: {
      periodId: row.period_id,
      version: row.version,
      contentHash: row.content_hash,
      fileable: row.fileable,
    },
    // The ROW ID and never `period_id`, which is a label people read: two versions of one period would
    // share a key and the second event would be dropped by `on conflict do nothing`
    // (packages/db/src/outbox-keys.test.ts).
    idempotencyKey: `vat_return.snapshotted:${row.id}`,
  })

  return asStored(row)
}

// --- reading -------------------------------------------------------------------------------------

/** The stored snapshot, or `null`. Open to everybody: a return is reviewed before it is signed. */
export async function readVatReturn(sql: Sql, returnId: string): Promise<StoredVatReturn | null> {
  const [row] = await sql<VatReturnRow[]>`
    select ${sql.unsafe(ROW_COLUMNS)} from vat_return where id = ${returnId}::uuid
  `
  return row ? asStored(row) : null
}

/**
 * The box figures of a snapshot, out of the hashed bytes.
 *
 * `vat_return_box_figure` is a VIEW over `vat_return.snapshot_json` and reaches no ledger table, so this
 * cannot re-derive anything: post to the journal afterwards and the numbers do not move. That is the
 * property the unit exists for, and the itest changes the journal to prove it rather than asserting it.
 *
 * Every figure comes back as `text` and becomes a `BigInt`, for `trial-balance.ts`'s recorded reason: a
 * `number` produced a four-fils difference out of nothing, and these are the figures a return is filed on.
 */
export async function vatReturnBoxFigures(
  sql: Sql,
  returnId: string,
): Promise<readonly VatReturnBoxFigure[]> {
  const rows = await sql<
    {
      box_no: number
      label: string
      side: string
      display_order: number
      is_provisional: boolean
      open_question_id: string | null
      net_supplies_fils: string
      tax_fils: string
      line_count: string
    }[]
  >`
    select box_no, label, side, display_order, is_provisional, open_question_id,
           net_supplies_fils::text, tax_fils::text, line_count::text
    from vat_return_box_figure
    where return_id = ${returnId}::uuid
    order by display_order
  `
  return rows.map((row) => ({
    boxNo: row.box_no,
    label: row.label,
    side: row.side as 'output' | 'input',
    displayOrder: row.display_order,
    isProvisional: row.is_provisional,
    openQuestionId: row.open_question_id,
    netSuppliesFils: BigInt(row.net_supplies_fils),
    taxFils: BigInt(row.tax_fils),
    lineCount: Number(row.line_count),
  }))
}

export interface VatReturnNotFileableReasonRow {
  readonly reason: string
  readonly openQuestionId: string
  readonly detail: string
}

/** The snapshot's own reasons against filing, out of the hashed bytes. */
export async function vatReturnNotFileableReasons(
  sql: Sql,
  returnId: string,
): Promise<readonly VatReturnNotFileableReasonRow[]> {
  const rows = await sql<{ reason: string; open_question_id: string; detail: string }[]>`
    select reason, open_question_id, detail
    from vat_return_not_fileable_reason
    where return_id = ${returnId}::uuid
    order by reason
  `
  return rows.map((row) => ({
    reason: row.reason,
    openQuestionId: row.open_question_id,
    detail: row.detail,
  }))
}

/** The roles that may sign, read from the database — the one place the set is written down. */
export async function vatReturnSigningRoles(sql: Sql): Promise<readonly string[]> {
  const [row] = await sql<{ roles: string[] }[]>`select vat_return_signing_roles() as roles`
  if (!row) {
    throw new AppError('invariant_violated', 'vat_return_signing_roles() returned no row')
  }
  return [...row.roles].sort()
}

/**
 * Who has signed, and whether the return is signed and final.
 *
 * One round trip, and the `signed` answer comes from `vat_return_sign_off_state()` — the same function the
 * finalisation trigger and `vat_return_for_filing()` call. A second computation of "signed" here would be a
 * second answer, and the day the two disagreed a screen would offer a filing the database refuses.
 */
export async function vatReturnSignOffState(
  sql: Sql,
  returnId: string,
): Promise<VatReturnSignOffState> {
  const [row] = await sql<
    {
      preparer_user_id: string | null
      preparer_display_name: string | null
      preparer_role: string | null
      preparer_signed_at: Date | null
      reviewer_user_id: string | null
      reviewer_display_name: string | null
      reviewer_role: string | null
      reviewer_signed_at: Date | null
      signed: boolean
      finalised_at: Date | null
    }[]
  >`
    select s.*, f.finalised_at
    from vat_return_sign_off_state(${returnId}::uuid) s
    left join vat_return_finalisation f on f.return_id = ${returnId}::uuid
  `
  if (!row) {
    throw new AppError(
      'invariant_violated',
      `vat_return_sign_off_state(${returnId}) returned no row; it aggregates without GROUP BY and always ` +
        'returns exactly one',
    )
  }
  const signature = (
    userId: string | null,
    displayName: string | null,
    role: string | null,
    signedAt: Date | null,
  ): VatReturnSignature | null =>
    userId === null || displayName === null || role === null || signedAt === null
      ? null
      : { userId, displayName, role, signedAt }

  return {
    preparer: signature(
      row.preparer_user_id,
      row.preparer_display_name,
      row.preparer_role,
      row.preparer_signed_at,
    ),
    reviewer: signature(
      row.reviewer_user_id,
      row.reviewer_display_name,
      row.reviewer_role,
      row.reviewer_signed_at,
    ),
    signed: row.signed,
    finalisedAt: row.finalised_at,
  }
}

// --- signing -------------------------------------------------------------------------------------

export interface VatReturnSignOff {
  readonly id: string
  readonly returnId: string
  readonly capacity: VatReturnSignOffCapacity
  readonly signatory: VatReturnSignature
}

/**
 * Records one signature.
 *
 * Nothing is pre-checked. The role, the second person and the audit row are all refused by 0095 — ZY053,
 * ZY052 and ZY057 — and this function's job is to INSERT, write the audit row that ZY057 requires, and
 * translate. A TypeScript comparison of the two user ids would be a rule for the callers that came through
 * here, and the three writers that do not are a `psql` session, a restored dump and the next caller.
 *
 * The display name and the role are taken from the caller and SNAPSHOTTED, so a later rename cannot rewrite
 * who signed. No name is composed here (brief rule 10): the value is the one the signatory is signed in as,
 * and `is_placeholder_text` refuses a blank.
 */
export async function signOffVatReturn(
  uow: UnitOfWork,
  input: SignOffVatReturnInput,
): Promise<VatReturnSignOff> {
  assertInstant(input.signedAt, 'signedAt')

  let row:
    | {
        id: string
        return_id: string
        capacity: string
        signatory_user_id: string
        signatory_display_name: string
        signatory_role: string
        signed_at: Date
      }
    | undefined
  try {
    ;[row] = await uow.sql<
      {
        id: string
        return_id: string
        capacity: string
        signatory_user_id: string
        signatory_display_name: string
        signatory_role: string
        signed_at: Date
      }[]
    >`
      insert into vat_return_sign_off (
        return_id, capacity, signatory_user_id, signatory_display_name, signatory_role, signed_at
      ) values (
        ${input.returnId}::uuid,
        ${input.capacity},
        ${input.signatory.userId},
        ${input.signatory.displayName},
        ${input.signatory.role},
        ${input.signedAt}::timestamptz
      )
      returning id, return_id, capacity, signatory_user_id, signatory_display_name, signatory_role,
                signed_at
    `
  } catch (err) {
    throw vatReturnError(err) ?? err
  }
  if (!row) {
    throw new AppError('invariant_violated', 'the vat_return_sign_off insert returned no row')
  }

  // ZY057 requires this row at COMMIT. Written here rather than left to the caller for the reason the
  // constraint trigger exists: a statutory signature whose only evidence is the signature itself.
  await uow.audit.record({
    action: 'vat_return.sign_off',
    entityType: 'vat_return_sign_off',
    entityId: row.id,
    operation: 'create',
    after: {
      returnId: row.return_id,
      capacity: row.capacity,
      signatoryUserId: row.signatory_user_id,
      signatoryDisplayName: row.signatory_display_name,
      signatoryRole: row.signatory_role,
    },
  })

  await uow.publish({
    eventType: 'vat_return.signed_off',
    aggregateType: 'vat_return',
    aggregateId: row.return_id,
    payload: { returnId: row.return_id, capacity: row.capacity, signOffId: row.id },
    // The SIGN-OFF's row id: two capacities on one return would otherwise share a key and the reviewer's
    // event would be silently dropped (packages/db/src/outbox-keys.test.ts).
    idempotencyKey: `vat_return.signed_off:${row.id}`,
  })

  return {
    id: row.id,
    returnId: row.return_id,
    capacity: row.capacity as VatReturnSignOffCapacity,
    signatory: {
      userId: row.signatory_user_id,
      displayName: row.signatory_display_name,
      role: row.signatory_role,
      signedAt: row.signed_at,
    },
  }
}

export interface VatReturnFinalisation {
  readonly id: string
  readonly returnId: string
  readonly finalisedAt: Date
}

/**
 * Marks a signed return final — the point after which it may be exported.
 *
 * The signatures are NOT checked here. `assert_vat_return_is_signed_off()` refuses the INSERT with ZY055,
 * reading `vat_return_sign_off_state()`, which is also what {@link vatReturnSignOffState} and
 * `vat_return_for_filing()` read — so a screen, a refusal and an export cannot disagree about whether a
 * return is signed.
 */
export async function finaliseVatReturn(
  uow: UnitOfWork,
  input: FinaliseVatReturnInput,
): Promise<VatReturnFinalisation> {
  assertInstant(input.finalisedAt, 'finalisedAt')

  let row: { id: string; return_id: string; finalised_at: Date } | undefined
  try {
    ;[row] = await uow.sql<{ id: string; return_id: string; finalised_at: Date }[]>`
      insert into vat_return_finalisation (return_id, finalised_at, actor_kind, actor_label)
      values (
        ${input.returnId}::uuid,
        ${input.finalisedAt}::timestamptz,
        ${input.actor.kind},
        ${input.actor.label}
      )
      returning id, return_id, finalised_at
    `
  } catch (err) {
    throw vatReturnError(err) ?? err
  }
  if (!row) {
    throw new AppError('invariant_violated', 'the vat_return_finalisation insert returned no row')
  }

  await uow.audit.record({
    action: 'vat_return.finalised',
    entityType: 'vat_return_finalisation',
    entityId: row.id,
    operation: 'create',
    after: { returnId: row.return_id, finalisedAt: row.finalised_at.toISOString() },
  })

  await uow.publish({
    eventType: 'vat_return.finalised',
    aggregateType: 'vat_return',
    aggregateId: row.return_id,
    payload: { returnId: row.return_id, finalisationId: row.id },
    idempotencyKey: `vat_return.finalised:${row.id}`,
  })

  return { id: row.id, returnId: row.return_id, finalisedAt: row.finalised_at }
}

/**
 * The return as a filing reads it. Refused with `ZY055` while it is unsigned or not marked final.
 *
 * The refusal comes from `vat_return_for_filing()` in the database and not from a guard here, which is the
 * whole point: M-VAT-09's one-way Zoho export reads that function, so does anything else that ever files,
 * and a caller who goes round this module is refused by the same code. The base tables stay readable
 * because a preparer has to see what they are signing.
 */
export async function vatReturnForFiling(sql: Sql, returnId: string): Promise<VatReturnForFiling> {
  let row:
    | {
        return_id: string
        period_id: string
        starts_on: string
        ends_on: string
        version: number
        content_hash: string
        engine_signature: string
        format_version: string
        snapshot_json: string
        finalised_at: Date
      }
    | undefined
  try {
    ;[row] = await sql<
      {
        return_id: string
        period_id: string
        starts_on: string
        ends_on: string
        version: number
        content_hash: string
        engine_signature: string
        format_version: string
        snapshot_json: string
        finalised_at: Date
      }[]
    >`
      select return_id, period_id, starts_on::text as starts_on, ends_on::text as ends_on, version,
             content_hash, engine_signature, format_version, snapshot_json, finalised_at
      from vat_return_for_filing(${returnId}::uuid)
    `
  } catch (err) {
    throw vatReturnError(err) ?? err
  }
  if (!row) {
    throw new AppError('not_found', `No VAT return ${returnId}`)
  }
  return {
    returnId: row.return_id,
    periodId: row.period_id,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    version: row.version,
    contentHash: row.content_hash,
    engineSignature: row.engine_signature,
    formatVersion: row.format_version,
    snapshotJson: row.snapshot_json,
    finalisedAt: row.finalised_at,
  }
}
