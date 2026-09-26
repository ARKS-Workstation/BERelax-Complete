import {
  CONNECTION_STALE_AFTER_HOURS,
  expiryIncidentKey,
  type GoogleConnectionHealth,
  type Instant,
  type PlannedReauthNotice,
  REAUTH_NOTICE_ROLES,
  type ReauthIncident,
  type ReauthNoticeKind,
  type ReauthNoticeRole,
  type ReauthSkipReason,
  reauthNoticeRunFor,
  stalenessIncidentKey,
} from '@berelax/core'
import { reconnectLink } from '@berelax/shared'
import {
  createMemoryReauthNoticeStore,
  type ReauthNoticeChannel,
  type ReauthNoticeDecision,
  type ReauthNoticeStore,
} from './notice-store.ts'

/**
 * The escalating re-auth ladder, as a pass: who has already been told, who is due, and what is recorded.
 *
 * ## Where the decision comes from, and where it does not
 *
 * From `reauthNoticeRunFor` in `@berelax/core`, which reads `health.notify` — the field
 * `deriveConnectionHealth` already computed and the one the settings card and the banner read too. This
 * file does not ask again whether the connection is broken. Two answers to that question is the defect
 * docs/10 §2 arranges everything else to avoid, and the second answer would be the one in the email.
 *
 * What this file owns is the three things a pure function cannot: which incident a connection is in (a
 * store read), what has already gone out (a store read), and the send itself — through an injected sender,
 * because `messaging-providers-only-inside-a-transport` forbids this package reaching an email provider and
 * because the choke point is where a message becomes a row, a cost and a delivery receipt.
 *
 * ## Why the sender is injected and returns a verdict rather than throwing
 *
 * Every missing input here is a fact to RECORD rather than an exception to raise: a role with no address on
 * file, a deployment with no configured origin, a channel switched off. None of them changes in sixty
 * seconds, so throwing would burn a queue retry and leave nothing written — and a row nobody wrote is the
 * one state this table exists to make impossible, because the next pass would then send again.
 *
 * `recipientForRole` answers `null` for every role in the shipped runtime, and that is the honest value
 * rather than an omission: nothing in this build holds a staff email address or phone number, and a
 * plausible one is worse than a blank (brief rule 15). Every due rung is then recorded as skipped with
 * `no_recipient_on_file`, which is a row somebody can look at, and the ladder goes on to the next rung
 * rather than retrying this one for ever.
 */

/** What a send attempt came back with. `refused` covers a gate refusal and F03's staging diversion. */
export type ReauthSendOutcome =
  | { readonly kind: 'sent'; readonly messageId: string | null }
  | { readonly kind: 'refused' }

/** What the sender is handed. Everything it needs, and nothing it could leak. */
export interface ReauthSendRequest {
  readonly connectionId: string
  readonly googleEmail: string
  readonly kind: ReauthNoticeKind
  readonly channel: ReauthNoticeChannel
  readonly toRole: ReauthNoticeRole
  readonly recipient: string
  readonly step: string
  /** The absolute link the body carries. Built here, from the validated origin, never in a template. */
  readonly reconnectUrl: string
  /** The fact the body states: when the grant died, or when it is due to. Spelled, never an instant. */
  readonly whenLabel: string
}

export type ReauthSender = (request: ReauthSendRequest) => Promise<ReauthSendOutcome>

/** Where a notice for a role goes, or null. Null for every role in the shipped runtime — see the header. */
export type ReauthRecipientResolver = (
  role: ReauthNoticeRole,
  channel: ReauthNoticeChannel,
) => string | null

/** One connection, as the pass sees it. Assembled by the caller from the deep check and the stored row. */
export interface ReauthSubject {
  readonly connectionId: string
  readonly googleEmail: string
  readonly health: GoogleConnectionHealth
  /** The last successful authenticated call, or null. The staleness incident is keyed on it. */
  readonly lastOkAt: Instant | null
  readonly consentAt: Instant
}

export interface ReauthLadderDeps {
  readonly store: ReauthNoticeStore
  readonly send: ReauthSender
  readonly recipientForRole: ReauthRecipientResolver
  /**
   * The absolute origin the deep link is built from, or null.
   *
   * Null is refusable rather than fatal, and the reason is the same as the recipient's: a relative path in
   * an email is a dead end, and a dead link in the one message whose entire purpose is to get somebody to
   * press a button teaches them to ignore the next one. `siteOriginFrom` in `@berelax/shared` is what
   * validates it; a caller that has none passes null and the rung is recorded as skipped.
   */
  readonly origin: string | null
  /** From `google.reauth_notice_repeat_cap`. Validated by `reauthLadderCap`. */
  readonly cap: number
  /** From `google.reauth_sms_enabled`. Off by default. */
  readonly smsEnabled: boolean
  /** Spells an instant for a human, in the owner's zone. Injected so the pass carries no formatter. */
  readonly spellInstant: (instant: Instant) => string
}

/** What one connection's pass did. Counted by the tests rather than described. */
export interface ReauthLadderOutcome {
  readonly connectionId: string
  /** Null when the pass decided nothing was needed. */
  readonly incidentKey: string | null
  readonly kind: ReauthNoticeKind | null
  /** One entry per (rung × role × channel) the pass sent. */
  readonly sent: readonly ReauthNoticeDecision[]
  /** One entry per (rung × role × channel) the pass decided not to send, each with its reason. */
  readonly skipped: readonly ReauthNoticeDecision[]
  /** Set when nothing was attempted at all, with the reason the ladder gave. */
  readonly skippedWholly: ReauthSkipReason | null
}

/** Every connection's outcome, plus the counts a log line needs. */
export interface ReauthPassResult {
  readonly at: Instant
  readonly connections: readonly ReauthLadderOutcome[]
  readonly sent: number
  readonly skipped: number
}

/**
 * Which incident a subject is in, or null.
 *
 * Three causes and three key shapes, and the difference is not cosmetic. A dead grant is identified by the
 * `google_connection_events` row that recorded it — an EVENT, with an instant. An approaching Testing
 * expiry is identified by the expiry INSTANT, because nothing happens at the moment a deadline comes into
 * view and there is therefore no event to key on; that is also the only construction under which *"does not
 * re-fire for the same expiry instant"* is true by the shape of the key rather than by a flag. Staleness is
 * keyed on the instant the 48-hour window closed, which is a fixed function of the last success, so a
 * connection that has been quiet for a month has ONE staleness incident rather than one per pass.
 */
export async function reauthIncidentFor(
  store: Pick<ReauthNoticeStore, 'latestReauthIncident'>,
  subject: ReauthSubject,
): Promise<ReauthIncident | null> {
  const notification = subject.health.notify
  if (notification === null) return null
  if (notification === 'reauth_required') {
    return await store.latestReauthIncident(subject.connectionId)
  }
  // Expiry before staleness: a connection can be both, and the expiry is the one with a date on it. A
  // warning that named the quieter of two reasons would send the owner looking for the wrong thing.
  const expiresAt = subject.health.testingExpiresAt
  if (subject.health.expiringSoon && expiresAt !== null) {
    // The window opens 48 hours before the deadline, which is where the acceptance line's T-48h comes from.
    return {
      key: expiryIncidentKey(expiresAt),
      openedAt: (expiresAt - CONNECTION_STALE_AFTER_HOURS * 60 * 60 * 1000) as Instant,
    }
  }
  if (subject.health.stale) {
    const from = subject.lastOkAt ?? subject.consentAt
    const closedAt = (from + CONNECTION_STALE_AFTER_HOURS * 60 * 60 * 1000) as Instant
    return { key: stalenessIncidentKey(closedAt), openedAt: closedAt }
  }
  return null
}

/** The channels a pass will attempt, in order. Email always; SMS only when the setting says so. */
function channelsFor(smsEnabled: boolean): readonly ReauthNoticeChannel[] {
  return smsEnabled ? (['email', 'sms'] as const) : (['email'] as const)
}

/**
 * The fact the body states, spelled for a reader.
 *
 * For a dead grant it is when the incident opened, which is when the grant was found to be dead. For an
 * approaching expiry it is the DEADLINE, not the moment the warning became due — an email that said
 * *"due to stop working on the day you are reading this"* would be describing its own send time.
 */
function whenLabelFor(
  deps: Pick<ReauthLadderDeps, 'spellInstant'>,
  kind: ReauthNoticeKind,
  subject: ReauthSubject,
  incident: ReauthIncident,
): string {
  if (kind === 'reactive') return deps.spellInstant(incident.openedAt)
  return deps.spellInstant(subject.health.testingExpiresAt ?? incident.openedAt)
}

/**
 * One connection: find the incident, ask the ladder, send what is due, record every decision.
 *
 * The recording is per (rung × role × channel) rather than per rung, which is what makes the acceptance
 * line's *"exactly one owner email and one manager email"* countable: two rows for one rung, one each, and
 * migration 0075's unique index refuses a third.
 */
export async function runReauthLadderFor(
  deps: ReauthLadderDeps,
  subject: ReauthSubject,
  now: Instant,
): Promise<ReauthLadderOutcome> {
  const incident = await reauthIncidentFor(deps.store, subject)
  const decided =
    incident === null
      ? []
      : await deps.store.decidedSteps({
          connectionId: subject.connectionId,
          incidentKey: incident.key,
        })
  const verdict = reauthNoticeRunFor({
    health: subject.health,
    incident,
    now,
    cap: deps.cap,
    alreadySentSteps: decided,
  })
  if (verdict.kind === 'skip') {
    return {
      connectionId: subject.connectionId,
      incidentKey: incident?.key ?? null,
      kind: null,
      sent: [],
      skipped: [],
      skippedWholly: verdict.reason,
    }
  }

  const sent: ReauthNoticeDecision[] = []
  const skipped: ReauthNoticeDecision[] = []
  const whenLabel = whenLabelFor(deps, verdict.noticeKind, subject, verdict.incident)

  for (const notice of verdict.due) {
    for (const role of REAUTH_NOTICE_ROLES) {
      for (const channel of ['email', 'sms'] as const) {
        const decision = await decide({
          deps,
          subject,
          notice,
          incident: verdict.incident,
          kind: verdict.noticeKind,
          role,
          channel,
          whenLabel,
          now,
        })
        // A channel that is switched off is recorded once per rung and role, so the row says the switch
        // was off rather than the pass having said nothing. `record` is what refuses a second one.
        await deps.store.record(decision)
        if (decision.skippedReason === null) sent.push(decision)
        else skipped.push(decision)
      }
    }
  }

  return {
    connectionId: subject.connectionId,
    incidentKey: verdict.incident.key,
    kind: verdict.noticeKind,
    sent,
    skipped,
    skippedWholly: null,
  }
}

/** One (rung × role × channel): send it, or say why not. Never throws for a missing input. */
async function decide(args: {
  readonly deps: ReauthLadderDeps
  readonly subject: ReauthSubject
  readonly notice: PlannedReauthNotice
  readonly incident: ReauthIncident
  readonly kind: ReauthNoticeKind
  readonly role: ReauthNoticeRole
  readonly channel: ReauthNoticeChannel
  readonly whenLabel: string
  readonly now: Instant
}): Promise<ReauthNoticeDecision> {
  const base = {
    connectionId: args.subject.connectionId,
    incidentKey: args.incident.key,
    kind: args.kind,
    step: args.notice.step,
    rungIndex: args.notice.rungIndex,
    toRole: args.role,
    channel: args.channel,
    dueAt: args.notice.dueAt,
    decidedAt: args.now,
  } as const
  const refuse = (skippedReason: ReauthSkipReason): ReauthNoticeDecision => ({
    ...base,
    messageId: null,
    skippedReason,
  })

  if (!channelsFor(args.deps.smsEnabled).includes(args.channel)) return refuse('channel_disabled')
  const recipient = args.deps.recipientForRole(args.role, args.channel)
  if (recipient === null || recipient.trim() === '') return refuse('no_recipient_on_file')
  // Email only: the SMS body carries no link (one segment in Arabic is 70 UCS-2 units), so a missing
  // origin does not stop it.
  if (args.channel === 'email' && args.deps.origin === null) {
    return refuse('no_reconnect_link_configured')
  }
  const outcome = await args.deps.send({
    connectionId: args.subject.connectionId,
    googleEmail: args.subject.googleEmail,
    kind: args.kind,
    channel: args.channel,
    toRole: args.role,
    recipient: recipient.trim(),
    step: args.notice.step,
    reconnectUrl:
      args.deps.origin === null ? '' : reconnectLink(args.deps.origin, args.subject.connectionId),
    whenLabel: args.whenLabel,
  })
  if (outcome.kind === 'refused') return refuse('send_refused')
  return { ...base, messageId: outcome.messageId, skippedReason: null }
}

/** Every connection, in one pass, with the counts a nightly log line needs — including zero. */
export async function runReauthLadder(
  deps: ReauthLadderDeps,
  subjects: readonly ReauthSubject[],
  now: Instant,
): Promise<ReauthPassResult> {
  const connections: ReauthLadderOutcome[] = []
  for (const subject of subjects) {
    connections.push(await runReauthLadderFor(deps, subject, now))
  }
  return {
    at: now,
    connections,
    sent: connections.reduce((total, outcome) => total + outcome.sent.length, 0),
    skipped: connections.reduce((total, outcome) => total + outcome.skipped.length, 0),
  }
}

/** Re-exported so a caller wiring the pass does not have to know which file the memory store is in. */
export { createMemoryReauthNoticeStore }
