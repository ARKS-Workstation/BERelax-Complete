import type { Config } from '@berelax/config'
import {
  ASIA_DUBAI,
  credentialStatusFor,
  type Instant,
  instantFromIso,
  localDate,
  toLocal,
} from '@berelax/core'
import {
  type Actor,
  businessDayAt,
  type CredentialExpiryNoticeRow,
  createPostgresMessageStore,
  type ExpiringCandidateRow,
  readCredentialPolicy,
  readCurrentTemplate,
  readExpiringCredentialCandidates,
  recordCredentialExpiryNotice,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import {
  type DeliveryDeps,
  deliverStaffNotification,
  InMemoryOutbox,
  type MessageId,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  TDRA_PROMOTIONAL_WINDOW,
} from '@berelax/messaging'
import { createSmsalaTransport } from '@berelax/messaging/transports/smsala'
import { AppError, STAFF_NOTIFICATION_TEMPLATE_KEYS } from '@berelax/shared'

/**
 * The credential-expiry notice pass (P-HR-14).
 *
 * ## It DECIDES notices; it does not decide statuses
 *
 * The acceptance line is that the notices are "generated from the P-HR-02 evaluator at the configured
 * window", and the only way to make that literally true is for this pass to own no date arithmetic at all.
 * `credentialStatusFor` in `@berelax/core` is the evaluator; `readCredentialPolicy` supplies the configured
 * window (`hr.credential_expiring_soon_days`, 60 provisionally against Y1-licence) and the non-expiring
 * set; and `readExpiringCredentialCandidates` deliberately filters on EMPLOYMENT and never on the expiry.
 *
 * A `where expires_on <= now() + interval '60 days'` would have been the obvious shape and it is the wrong
 * one twice. It would be a second reading of the window — SQL comparing calendar dates while the evaluator
 * compares wall-clock dates in the policy's zone, which disagree for the two hours of every trading day
 * after midnight — and it would read the window from a literal rather than from the setting, so changing
 * the setting would move the badge on the admin screen and not the notices.
 *
 * ## The idempotency is the INDEX's and the pass remembers nothing
 *
 * `credential_expiry_notice_once` is `(employee_id, employee_document_id, window_days)` and
 * `recordCredentialExpiryNotice` is `on conflict do nothing`, answering null for a notice already decided.
 * So a second pass over the same window inserts nothing, **sends nothing** and writes no audit row. The
 * credential sweep's header argues the same thing about `appointment_reassignment_flag`: a pass holding
 * "already sent" in its own state loses the copy the first time a worker restarts mid-run, and the index
 * also holds against two workers and against a `psql` session.
 *
 * ## The order: resolve a recipient, record the decision, then send
 *
 * Three steps, and the middle one is in the transaction with the audit row. The notice row records what
 * was DECIDED — whether a recipient existed, and the message id the send will carry — and the send happens
 * after it has committed.
 *
 * The alternative orders are both worse and worth naming. Sending first and recording after is a message
 * that can leave twice, because the crash between the two is exactly the window a second worker races in,
 * and an SMS cannot be un-sent. Recording the SEND'S OWN OUTCOME on the notice would need an UPDATE, and
 * `credential_expiry_notice` is append-only (ZY841) — a notice that can be edited is not evidence.
 *
 * So the row says "we decided to tell this person, through this message id" and the `message` row says
 * what became of the send, which is where a delivery outcome belongs: `deliverMessage` records an attempt
 * per try with its own reason, and `reconcile-dlr.ts` is what later moves it. The message id is DERIVED
 * from the notice's own key, so a retried send cannot be billed twice — `idempotencyKeyFor` in the choke
 * point is `templateKey:messageId`.
 *
 * ## It goes through the send choke point and nowhere else
 *
 * {@link credentialNoticeDeliveryFor} builds the real runtime and calls `deliverStaffNotification`, which
 * applies the transactional-class fence and then `deliverMessage` → `sendMessage`. There is no `.send(` in
 * this file, which is what `pnpm send-chokepoint` enumerates.
 *
 * ## Nothing is sent today, and the row says so
 *
 * No table in this build holds a staff phone number or an email address — `employee` has neither, there is
 * no `employee_contact`, and a plausible one would be indistinguishable from a configured one in the one
 * place it would reach a stranger (brief rule 15). So {@link NO_STAFF_CONTACT_ON_FILE} is the shipped
 * resolver and every notice resolves to `skipped` with `no_recipient_on_file`, which is 0081's answer for
 * the rota notice and 0075's for the Google re-auth ladder.
 *
 * The resolver is injected rather than written inline so the integration suite can supply a recipient and
 * drive the SEND path against the fake SMS outbox — which is what makes the idempotency claim testable at
 * all. A pass whose send branch could never run would have an idempotency claim about a branch that does
 * nothing.
 */

/** The `agent_definition` this pass reports to. It shares the sweep's: see the header on the cron. */
export const CREDENTIAL_EXPIRY_NOTICE_AGENT = 'credential_sweep'

/**
 * `actor_id` is a uuid column; the label is where a name goes (ADR 0020).
 *
 * The label is a separate constant because `credential_expiry_notice.created_by` is NOT NULL and
 * `Actor.label` is optional — reading it off the actor would be `string | undefined` at a column that
 * refuses null, and the `??` that silenced it would be a second spelling of the same label.
 */
const ACTOR_LABEL = 'credential.expiry_notice'
const ACTOR: Actor = { kind: 'system', label: ACTOR_LABEL }

/** Where a staff notice would be sent, or why it cannot be. */
export type StaffRecipient =
  | { readonly kind: 'recipient'; readonly recipient: string }
  | { readonly kind: 'none'; readonly reason: string }

/**
 * How a notice finds its recipient, as an injected port.
 *
 * `NO_STAFF_CONTACT_ON_FILE` is the shipped value and it is a NAMED EXPORT rather than a lambda in the
 * wiring, so that the day an `employee_contact` table exists the diff that replaces it is one line and the
 * test proving the send path works is already written.
 */
export type StaffRecipientResolver = (subject: {
  readonly employeeId: string
  readonly staffReference: string
}) => Promise<StaffRecipient>

/** There is no staff contact detail in this build, so nothing is sent. 0081's answer, unchanged. */
export const NO_STAFF_CONTACT_ON_FILE: StaffRecipientResolver = async () => ({
  kind: 'none',
  reason: 'no_recipient_on_file',
})

/**
 * What performs the send, once a recipient is known.
 *
 * It answers a typed outcome and never a bare success (ADR 0005, which H-HARD-08 extends): `not_sent`
 * carries the reason the choke point gave, so a notice held by the gate or diverted on staging is
 * distinguishable from one that left.
 */
export type CredentialNoticeDelivery = (args: {
  readonly messageId: string
  readonly recipient: string
  readonly expiresOn: string
}) => Promise<
  | { readonly kind: 'sent'; readonly providerMessageId: string | null }
  | { readonly kind: 'not_sent'; readonly reason: string }
>

/**
 * The delivery nothing is wired to, which REFUSES rather than silently doing nothing.
 *
 * The default for `delivery`, and it can only be reached by a resolver that found a recipient — which the
 * shipped resolver never does. If the two are ever wired inconsistently, this throws rather than recording
 * a notice as sent: "the recipient exists and nothing is wired to send to them" is a configuration fault,
 * and a skip would make it invisible for as long as nobody checked the table.
 */
export const NO_DELIVERY_WIRED: CredentialNoticeDelivery = async () => {
  throw new AppError(
    'invariant_violated',
    'A credential expiry notice resolved to a recipient and no delivery is wired. The shipped resolver ' +
      'is NO_STAFF_CONTACT_ON_FILE, so reaching here means a recipient resolver was injected without a ' +
      'delivery. Refusing rather than recording the notice as skipped: a skip would hide a ' +
      'configuration fault behind the state the build ships in.',
  )
}

export interface CredentialExpiryNoticeResult {
  /** The trading date the pass was made for — the session the instant belongs to. */
  readonly asOf: string
  /** The configured window the pass judged with. On the result so a reader never has to guess. */
  readonly windowDays: number
  /** Documents considered. Reported even when zero, so "nothing expiring" is not "nothing ran". */
  readonly considered: number
  /** Documents the evaluator reported as EXPIRING_SOON. */
  readonly expiringSoon: number
  /** Notices this pass decided. **Empty on a second pass**, which is the acceptance criterion. */
  readonly recorded: readonly CredentialExpiryNoticeRow[]
  /** Notices a previous pass had already decided for the same (employee, document, window). */
  readonly alreadyDecided: number
  /** Sends attempted, and what each one answered. Empty while no staff contact detail exists. */
  readonly delivered: readonly {
    readonly noticeId: string
    readonly outcome: 'sent' | 'not_sent'
    readonly detail: string
  }[]
}

export interface CredentialExpiryNoticeDeps {
  readonly recipientFor?: StaffRecipientResolver
  readonly delivery?: CredentialNoticeDelivery
}

/**
 * The message id a notice's send carries, derived from the notice's own identity.
 *
 * Derived and not minted, because `idempotencyKeyFor` in the choke point is `templateKey:messageId` and
 * the provider must not bill the same message twice on a retry. The three components are exactly the
 * unique index's, so two passes that both decided to tell one person about one document under one window
 * cannot produce two message ids.
 */
export function credentialNoticeMessageId(args: {
  readonly employeeId: string
  readonly employeeDocumentId: string
  readonly windowDays: number
}): MessageId {
  return `credential-expiry-${args.employeeId}-${args.employeeDocumentId}-${args.windowDays}` as MessageId
}

/**
 * One pass, for the business day containing `atIso`.
 *
 * `atIso` is injected rather than read, for `runCredentialSweep`'s reason: the integration suite drives it
 * at a frozen clock and asserts the second run records nothing, which is exactly what a job reading
 * `new Date()` could not be asked.
 *
 * It has NO CRON OF ITS OWN and runs on the back of the nightly credential sweep, which is
 * `google-reauth-notify.ts`'s arrangement and its argument: a second poller would wake up to ask a
 * question the first one had just answered, and it would need its own `agent_definition` row for the
 * watchdog to mean anything.
 */
export async function runCredentialExpiryNotices(
  sql: Sql,
  atIso: string,
  deps: CredentialExpiryNoticeDeps = {},
): Promise<CredentialExpiryNoticeResult> {
  const recipientFor = deps.recipientFor ?? NO_STAFF_CONTACT_ON_FILE
  const delivery = deps.delivery ?? NO_DELIVERY_WIRED

  const day = await businessDayAt(sql, atIso)
  if (day === null) {
    throw new AppError(
      'invariant_violated',
      `The credential expiry notice pass ran at ${atIso} and business_day holds no trading session at ` +
        'or before it, so there is no trading date to date the notices on. Generate the trading ' +
        "calendar (generateBusinessDays) first: dating a notice on the instant's own calendar date " +
        'would file the two hours after midnight under tomorrow.',
    )
  }

  // Read ONCE, outside the loop. The window is part of every notice's identity, so a policy re-read per
  // document could judge the first half of a file against 60 days and the second half against 90 with no
  // row saying which — and the two halves would then be separately idempotent under two keys.
  const policy = await readCredentialPolicy(sql)
  const windowDays = policy.expiringSoonDays
  // The ONE place the instant becomes a date in this pass, in the policy's zone rather than against the
  // trading date: `credentialStatusFor` compares wall-clock dates, and handing it last night's trading
  // date would make a document expiring today read as expiring yesterday. `readCredentialPolicy` carries
  // no zone of its own, so Asia/Dubai is named here exactly as `evaluateCredentials` defaults it.
  const asOfDate = toLocal(instantFromIso(atIso), ASIA_DUBAI).date

  const candidates = await readExpiringCredentialCandidates(sql, { asOfDate })
  const nonExpiring = new Set(policy.nonExpiringTypes)

  const recorded: CredentialExpiryNoticeRow[] = []
  const delivered: {
    noticeId: string
    outcome: 'sent' | 'not_sent'
    detail: string
  }[] = []
  let expiringSoon = 0
  let alreadyDecided = 0

  for (const candidate of candidates) {
    const verdict = statusOf(candidate, { asOfDate, windowDays, nonExpiring })
    if (verdict.status !== 'EXPIRING_SOON' || verdict.expiresOn === null) continue
    expiringSoon += 1
    const expiresOn = verdict.expiresOn

    const target = await recipientFor({
      employeeId: candidate.employeeId,
      staffReference: candidate.staffReference,
    })
    const messageId = credentialNoticeMessageId({
      employeeId: candidate.employeeId,
      employeeDocumentId: candidate.employeeDocumentId,
      windowDays,
    })

    const claimed = await withUnitOfWork(sql, ACTOR, async (uow) => {
      const row = await recordCredentialExpiryNotice(uow, {
        employeeId: candidate.employeeId,
        employeeDocumentId: candidate.employeeDocumentId,
        windowDays,
        expiresOn,
        detectedOn: day.tradingDate,
        templateKey: STAFF_NOTIFICATION_TEMPLATE_KEYS.credentialExpiring,
        ...(target.kind === 'recipient'
          ? { outcome: 'sent' as const, messageId }
          : { outcome: 'skipped' as const, skipReason: target.reason }),
        createdBy: ACTOR_LABEL,
      })
      // Null means the index already holds this (employee, document, window): this pass has nothing to
      // do, so no audit row either. An audit row for a decision nobody took is noise in the one table an
      // insider-threat review reads.
      if (row === null) return null
      await uow.audit.record({
        action: 'hr.credential_expiry_notice',
        entityType: 'credential_expiry_notice',
        entityId: row.id,
        operation: 'create',
        after: {
          employeeId: candidate.employeeId,
          employeeDocumentId: candidate.employeeDocumentId,
          windowDays,
          expiresOn,
          outcome: row.outcome,
          // The reason or the message id, and never the document TYPE: which document somebody holds is
          // a fact about their immigration or professional status, and an audit row is read by more
          // people than the file is (docs/06 D4).
          // One of the two is always present: `credential_expiry_notice_skip_has_a_reason` and
          // `credential_expiry_notice_send_has_a_message` are biconditionals, so the row cannot carry
          // neither. The fallback is the notice's own id rather than a cast, because an audit row with
          // `undefined` in it is the shape that reads as "nothing happened".
          detail: row.skipReason ?? row.messageId ?? row.id,
        },
      })
      return row
    })

    if (claimed === null) {
      alreadyDecided += 1
      continue
    }
    recorded.push(claimed)
    if (target.kind !== 'recipient') continue

    // After the commit, deliberately. See the header: the notice is the decision, and a send inside the
    // transaction that then rolled back would be a message somebody received about a notice no row holds.
    const outcome = await delivery({ messageId, recipient: target.recipient, expiresOn })
    delivered.push({
      noticeId: claimed.id,
      outcome: outcome.kind,
      detail: outcome.kind === 'sent' ? (outcome.providerMessageId ?? messageId) : outcome.reason,
    })
  }

  return {
    asOf: day.tradingDate,
    windowDays,
    considered: candidates.length,
    expiringSoon,
    recorded,
    alreadyDecided,
    delivered,
  }
}

/**
 * One document's status, from the evaluator and from nothing else.
 *
 * The candidate is handed to `credentialStatusFor` as a single-element credential list, which looks
 * redundant and is not: that function takes the LATEST expiry among the rows held for a type, and a notice
 * is about one ROW. Passing the whole type's rows would report the renewal's expiry on a notice about the
 * document that is lapsing, and the therapist would be asked to renew something already renewed.
 */
function statusOf(
  candidate: ExpiringCandidateRow,
  policy: {
    readonly asOfDate: string
    readonly windowDays: number
    readonly nonExpiring: ReadonlySet<string>
  },
): { readonly status: string; readonly expiresOn: string | null } {
  const verdict = credentialStatusFor({
    documentType: candidate.documentType,
    credentials: [
      {
        documentType: candidate.documentType,
        expiresOn: candidate.expiresOn === null ? null : localDate(candidate.expiresOn),
      },
    ],
    asOfDate: localDate(policy.asOfDate),
    expiringSoonDays: policy.windowDays,
    nonExpiring: policy.nonExpiring.has(candidate.documentType),
  })
  return { status: verdict.status, expiresOn: verdict.expiresOn }
}

/**
 * The real delivery, assembled from the database and the environment.
 *
 * It goes through `deliverStaffNotification`, which is the class fence plus `deliverMessage` plus
 * `sendMessage`. The three fail-closed evaluators are the ones every other runtime in this repository
 * wires and for the same reason, which is worth restating because it looks like dead code: a staff notice
 * is TRANSACTIONAL, so the gate returns `allow` on its first line before any of them is read — and a
 * PROMOTIONAL send through this runtime therefore fails closed rather than going out unevaluated.
 *
 * English only, and deliberately: no table in this build records which language a member of staff reads.
 * The Arabic variant is seeded and will be selected the day a staff locale exists; picking one per role
 * would be a guess about a person (ADR 0020).
 */
export function credentialNoticeDeliveryFor(sql: Sql, config: Config): CredentialNoticeDelivery {
  const now = (): string => new Date().toISOString()
  const sms = createSmsalaTransport({ config, now })
  const send: SendContext = {
    appEnv: config.APP_ENV,
    outboundAllowlist: config.OUTBOUND_ALLOWLIST,
    senderIds: PROVISIONAL_SENDER_IDS,
    transports: [sms.transport],
    outbox: new InMemoryOutbox(),
    clock: { now: () => Date.now() as Instant },
    gate: {
      marketingKillSwitch: false,
      promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
      evaluators: {
        hasConsent: () => {
          throw new Error('No consent store in this runtime. Promotional sends fail closed.')
        },
        isSuppressed: () => {
          throw new Error('No suppression log in this runtime. Promotional sends fail closed.')
        },
        frequencyCapReached: () => {
          throw new Error('No frequency store in this runtime. Promotional sends fail closed.')
        },
      },
    },
  }
  const delivery: DeliveryDeps = {
    store: createPostgresMessageStore(sql),
    send,
    // The queue is the thing that waits. A retry inside the pass would hold the transaction's rows for
    // the length of the declared backoff.
    waitUntil: async () => {},
  }

  return async (args) => {
    const template = await readCurrentTemplate(sql, {
      key: STAFF_NOTIFICATION_TEMPLATE_KEYS.credentialExpiring,
      channel: 'sms',
      locale: 'en',
    })
    if (template === undefined) {
      return { kind: 'not_sent', reason: 'template_not_published' }
    }
    const outcome = await deliverStaffNotification(delivery, {
      templateId: template.templateId,
      id: args.messageId as MessageId,
      template: {
        key: template.templateKey,
        channel: 'sms',
        locale: 'en',
        body: template.body,
        variables: [...template.variables],
        messageClass: 'transactional',
        approvalState: 'approved',
      },
      // Narrowed to what the variant declares rather than handed a superset: the renderer refuses a value
      // it did not declare, which is `google-reauth-notify.ts`'s note and the same shape here.
      values: Object.fromEntries(
        template.variables.filter((name) => name === 'date').map((name) => [name, args.expiresOn]),
      ),
      recipient: args.recipient,
    })
    if (outcome.kind === 'sent') {
      return { kind: 'sent', providerMessageId: outcome.message.providerMessageId ?? null }
    }
    return {
      kind: 'not_sent',
      reason:
        outcome.kind === 'not_sent'
          ? `${outcome.result.kind}:${'reason' in outcome.result ? outcome.result.reason : ''}`
          : outcome.kind,
    }
  }
}
