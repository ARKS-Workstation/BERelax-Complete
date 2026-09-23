import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { Sql } from '../connection.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * Serving a filed evidence file privately, and auditing every download (M-VAT-11).
 *
 * 0052 created `obligation_evidence` with a private-bucket storage key and a content hash, and nothing has
 * ever read it back over HTTP. M-TILL-12's NOTE records why and asks whichever unit lands first to own the
 * capability rather than build a second one: nothing in this repository can sign a URL — `MediaStorage`
 * (packages/media/src/storage/port.ts) exposes put, head, get and list and no signing — and there was no
 * document route to return 403 from.
 *
 * This is that capability. It is a **stored grant** rather than an HMAC over the URL, and the choice is
 * worth stating because the acceptance criterion says "signed URL":
 *
 *   1. **No fourth signing secret.** `build/secret-inventory.json` classifies three KEKs, a database
 *      credential, a Payload secret, an OAuth client secret and a telemetry key, each with a rotation
 *      procedure in `docs/runbooks/key-rotation.md`. Adding an eighth entry — with a runbook section
 *      somebody has to follow at 02:00 — for a link that lives fifteen minutes is a poor trade.
 *   2. **Revocable.** A grant that should never have been minted is a DELETE. A signature is valid until
 *      it expires, and the only way to withdraw one is to rotate the key and break every other link.
 *   3. **It records who asked.** An inspection's question about a hygiene report that left the building is
 *      "who took a copy", and the row answers it. A signature answers nothing about its holder.
 *
 * Only the **sha256 of the token** is stored, exactly as `repositories/otp.ts` stores a digest of a
 * six-digit code rather than the code: a grant table that held its own tokens would be a table that grants
 * access to every evidence file in the business.
 *
 * ## What this does NOT claim
 *
 * The grant is the only gate today. There is no admin session until W-SYS-01 — the same statement
 * `/hr/credentials`, the Messages inbox and the two Google routes make next door — so the route that
 * serves these bytes refuses a request with no valid grant and does not additionally check a role. That
 * is a deliberate boundary, not an omission, and it is why minting is a function rather than an endpoint:
 * an unauthenticated mint endpoint would hand a link to anybody who asked for one, which is the whole of
 * what the 403 exists to prevent.
 */

/**
 * How long a download link lives.
 *
 * Fifteen minutes: long enough to open a file, forward it to a colleague in the same conversation and
 * open it again after a failed download, and short enough that a link pasted into a chat transcript, an
 * agent log or a browser history is dead before anybody reads that transcript. It is not a legal figure
 * and it is not derived from one — it is a technical policy with a stated reason, the way
 * `SCHEDULED_STEP_LATE_TOLERANCE_MINUTES` is.
 */
export const EVIDENCE_GRANT_TTL_SECONDS = 15 * 60

/**
 * Why a download was refused. Every one of these answers 403 and never 404.
 *
 * A missing evidence id and an expired grant both answer 403, deliberately: a 404 for an id that does not
 * exist and a 403 for one that does is an oracle for enumerating which occurrences carry evidence, which
 * is a fact about which inspections happened.
 */
export const EVIDENCE_DOWNLOAD_REFUSALS = [
  'grant_absent',
  'grant_unknown',
  'grant_expired',
  'grant_not_for_this_evidence',
] as const
export type EvidenceDownloadRefusal = (typeof EVIDENCE_DOWNLOAD_REFUSALS)[number]

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex')

/**
 * The token, and the digest stored for it.
 *
 * 32 bytes of `randomBytes` in base64url: 256 bits, so the token is not guessable and the table needs no
 * rate limiter of its own. base64url rather than hex because it goes in a URL, and rather than base64
 * because `+` and `/` would have to be escaped by every caller that builds one.
 */
function mintToken(): { readonly token: string; readonly digest: string } {
  const token = randomBytes(32).toString('base64url')
  return { token, digest: sha256Hex(token) }
}

export interface IssuedEvidenceGrant {
  readonly grantId: string
  /** The bearer token. Returned once, never stored, and never logged by anything here. */
  readonly token: string
  readonly expiresAtIso: string
}

/**
 * Mints a download link for one filed evidence file.
 *
 * Audited, and the audit row is written here rather than at the download so that a link nobody ever
 * followed still leaves a trace: "who asked for a copy of the inspection report" is a different question
 * from "who opened it", and both have answers. The purpose is required and refuses a placeholder for
 * 0026's reason — `is_placeholder_text` is a CHECK on the column, and "updated" answers nothing an
 * inspection asks.
 */
export async function issueObligationEvidenceGrant(
  uow: UnitOfWork,
  args: {
    readonly evidenceId: string
    readonly role: string
    readonly actorLabel: string
    readonly purpose: string
    readonly ttlSeconds?: number
  },
): Promise<IssuedEvidenceGrant> {
  const ttl = args.ttlSeconds ?? EVIDENCE_GRANT_TTL_SECONDS
  if (!Number.isInteger(ttl) || ttl < 1) {
    throw new AppError(
      'validation',
      `An evidence grant must live a whole positive number of seconds, received ${ttl}. A grant that has ` +
        'already expired when it is written reads on the screen as a link that is simply broken.',
      { details: { ttlSeconds: ttl } },
    )
  }
  const { token, digest } = mintToken()
  const [row] = await uow.sql<{ id: string; expires_at: Date }[]>`
    insert into obligation_evidence_grant
      (obligation_evidence_id, token_sha256, expires_at, issued_to_role, issued_to_label, purpose)
    values (${args.evidenceId}::uuid, ${digest},
            now() + make_interval(secs => ${ttl}),
            ${args.role}, ${args.actorLabel}, ${args.purpose})
    returning id::text as id, expires_at
  `
  if (row === undefined) {
    throw new AppError(
      'invariant_violated',
      'The evidence grant was not written and did not raise.',
    )
  }
  await uow.audit.record({
    action: 'compliance.obligation_evidence.grant_issued',
    entityType: 'obligation_evidence',
    entityId: args.evidenceId,
    operation: 'create',
    // The token is deliberately absent from the audit row. An audit trail that carried the credential
    // would be a second copy of it, in a partitioned table several roles may read.
    after: { grantId: row.id, role: args.role, purpose: args.purpose },
  })
  return { grantId: row.id, token, expiresAtIso: row.expires_at.toISOString() }
}

/** What a redeemed grant hands the route: where the bytes are, and which file they are. */
export interface RedeemedEvidence {
  readonly grantId: string
  readonly evidenceId: string
  readonly obligationInstanceId: string
  readonly obligationKey: string
  readonly storageKey: string
  readonly contentHash: string
  readonly issuedToRole: string
  readonly issuedToLabel: string
}

/**
 * Resolves a token to the evidence it grants, or names the refusal.
 *
 * The lookup is on the DIGEST, so the stored value is never compared against a secret this function was
 * given in the clear — and `timingSafeEqual` compares the two digests even though the SELECT already
 * matched on one, because the second comparison is what makes the code obviously constant-time to the
 * next reader rather than dependent on how PostgreSQL compares text.
 *
 * Expiry is judged in SQL against `now()` and not against a clock this process read: two processes serving
 * the same link must agree about whether it is dead, and a per-process clock is how a link works on one
 * container and 403s on another.
 */
export async function redeemObligationEvidenceGrant(
  sql: Sql,
  args: { readonly evidenceId: string; readonly token: string | null },
): Promise<
  | { readonly kind: 'granted'; readonly evidence: RedeemedEvidence }
  | { readonly kind: 'refused'; readonly reason: EvidenceDownloadRefusal }
> {
  if (args.token === null || args.token.trim() === '') {
    return { kind: 'refused', reason: 'grant_absent' }
  }
  const digest = sha256Hex(args.token)
  const [row] = await sql<
    {
      id: string
      token_sha256: string
      evidence_id: string
      instance_id: string
      key: string
      storage_key: string
      content_hash: string
      issued_to_role: string
      issued_to_label: string
      expired: boolean
    }[]
  >`
    select g.id::text as id, g.token_sha256,
           e.id::text as evidence_id, e.obligation_instance_id::text as instance_id,
           o.key, e.storage_key, e.content_hash,
           g.issued_to_role, g.issued_to_label,
           (g.expires_at <= now()) as expired
      from obligation_evidence_grant g
      join obligation_evidence e on e.id = g.obligation_evidence_id
      join obligation_instance i on i.id = e.obligation_instance_id
      join obligation o on o.id = i.obligation_id
     where g.token_sha256 = ${digest}
  `
  if (row === undefined) return { kind: 'refused', reason: 'grant_unknown' }
  if (!timingSafeEqual(Buffer.from(row.token_sha256, 'hex'), Buffer.from(digest, 'hex'))) {
    return { kind: 'refused', reason: 'grant_unknown' }
  }
  if (row.expired) return { kind: 'refused', reason: 'grant_expired' }
  // A valid grant for a DIFFERENT file is refused rather than followed. Without this the evidence id in
  // the path would be decoration: one grant would open every file in the business, and the audit row
  // would name the wrong document.
  if (row.evidence_id !== args.evidenceId) {
    return { kind: 'refused', reason: 'grant_not_for_this_evidence' }
  }
  return {
    kind: 'granted',
    evidence: {
      grantId: row.id,
      evidenceId: row.evidence_id,
      obligationInstanceId: row.instance_id,
      obligationKey: row.key,
      storageKey: row.storage_key,
      contentHash: row.content_hash,
      issuedToRole: row.issued_to_role,
      issuedToLabel: row.issued_to_label,
    },
  }
}

/**
 * Records a download. Called for EVERY download, including a repeat of the same link.
 *
 * Not conditional on it being the first: a second download is a second copy leaving the business, and a
 * trail that recorded only the first would answer the inspection's question wrongly. The actor is the role
 * and label the grant was minted for, because that is who the link belongs to — attributing the download
 * to the process that served it would record `system` for every copy anybody ever took.
 */
export async function recordEvidenceDownload(
  uow: UnitOfWork,
  args: { readonly evidence: RedeemedEvidence; readonly bytes: number },
): Promise<void> {
  await uow.audit.record({
    action: 'compliance.obligation_evidence.downloaded',
    entityType: 'obligation_evidence',
    entityId: args.evidence.evidenceId,
    operation: 'read',
    after: {
      grantId: args.evidence.grantId,
      obligation: args.evidence.obligationKey,
      role: args.evidence.issuedToRole,
      // The content hash and not the storage key: the hash says WHICH bytes were served, which is the
      // claim a re-upload of a substituted file would break, and the key is a private-bucket path.
      contentHash: args.evidence.contentHash,
      bytes: args.bytes,
    },
  })
}

/** Revokes one grant. The record that it was minted stays: `audit_event` is append-only. */
export async function revokeObligationEvidenceGrant(
  uow: UnitOfWork,
  args: { readonly grantId: string; readonly reason: string },
): Promise<void> {
  const rows = await uow.sql<{ id: string }[]>`
    delete from obligation_evidence_grant where id = ${args.grantId}::uuid returning id
  `
  if (rows.length !== 1) {
    throw new AppError('not_found', `No evidence grant ${args.grantId}.`, {
      details: { grantId: args.grantId },
    })
  }
  await uow.audit.record({
    action: 'compliance.obligation_evidence.grant_revoked',
    entityType: 'obligation_evidence',
    entityId: args.grantId,
    operation: 'delete',
    before: { grantId: args.grantId },
    after: { reason: args.reason },
  })
}

/** The evidence filed against a set of occurrences, for the calendar. Never a storage key on a screen. */
export async function readObligationEvidence(
  sql: Sql,
  instanceIds: readonly string[],
): Promise<
  readonly {
    readonly evidenceId: string
    readonly obligationInstanceId: string
    readonly contentHash: string
    readonly uploadedAtIso: string
    readonly uploadedByLabel: string
  }[]
> {
  if (instanceIds.length === 0) return []
  const rows = await sql<
    {
      id: string
      instance_id: string
      content_hash: string
      uploaded_at: Date
      uploaded_by_label: string
    }[]
  >`
    select id::text as id, obligation_instance_id::text as instance_id, content_hash,
           uploaded_at, uploaded_by_label
      from obligation_evidence
     where obligation_instance_id = any(${[...instanceIds]}::uuid[])
     order by uploaded_at, id
  `
  return rows.map((row) => ({
    evidenceId: row.id,
    obligationInstanceId: row.instance_id,
    contentHash: row.content_hash,
    uploadedAtIso: row.uploaded_at.toISOString(),
    uploadedByLabel: row.uploaded_by_label,
  }))
}
