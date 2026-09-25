import {
  AppError,
  MAX_GOOGLE_REAUTH_LADDER_STEPS,
  REAUTH_REASSURANCE_SENTENCE,
} from '@berelax/shared'
import { addMinutes, type Instant, instantToIso } from '../time.ts'
import type {
  GoogleConnectionDisplayState,
  GoogleConnectionHealth,
  GoogleConnectionNotification,
} from './connection.ts'
import { connectionStateCopy, stateShownFor } from './connection-state.ts'

/**
 * The re-auth banner and the escalating notification ladder, as rules with no I/O in them.
 *
 * Two questions, both downstream of the one derivation in `connection.ts` and neither of them a second
 * opinion about it:
 *
 *  1. **Does every admin page have to carry a banner, and may a human make it go away?**
 *     {@link reauthBannerFor}, keyed on `stateShownFor` — G-CONN-07's one instruction to this unit, and the
 *     reason is in that file: a connection consented ten minutes ago with nothing read yet *derives*
 *     healthy and must not be shown a green tick, so a banner keyed on `displayState` would be absent from
 *     exactly the page that has something to say.
 *
 *  2. **How many times may the owner be told, and when does it stop?** {@link reauthNoticeRunFor}, over
 *     {@link REAUTH_LADDERS} and a cap.
 *
 * ## Why "non-dismissible" is a property of this module and not of a click handler
 *
 * The obvious implementation of a banner you cannot dismiss is a dismiss button that the broken state does
 * not render, with the state stored somewhere. Every version of *somewhere* is wrong here, and not
 * marginally:
 *
 *   - **Client-side JavaScript.** Anybody with dev tools removes the element, and the admin documents in
 *     this application ship no client bundle at all, so a banner that depended on script would be a banner
 *     that is absent when script is.
 *   - **A cookie.** It outlives the incident. The connection is a Google grant that has expired; a
 *     dismissed banner means messages silently stop, which is the failure docs/10 exists to design out.
 *   - **A query parameter.** It survives a bookmark and a shared link.
 *
 * So {@link ReauthBannerView} carries `dismissible`, the renderer reads it, and for `broken` there is no
 * value of anything — no cookie, no parameter, no script — that makes `reauthBannerFor` return `null`. The
 * banner's presence is a function of the stored connection state and of nothing else, which is the only
 * form of the claim a test can hold: re-render the document with every dismissal the product affords and
 * the element is still there.
 *
 * `degraded` DOES carry a dismiss control, and it is deliberately one that cannot outlive the document it
 * is in — see {@link ReauthBannerView.dismissible}.
 *
 * ## Why the ladder cannot escalate for ever, in three layers
 *
 * A ladder with a `while` in it is a ladder that mails somebody every fifteen minutes the day a
 * cron interval changes. So: the rungs are an enumerated union with a `Record` of specs, the total is
 * bounded by a cap this module REFUSES to exceed, and `MAX_GOOGLE_REAUTH_LADDER_STEPS` is restated as a
 * CHECK constraint in migration 0075 so a row claiming a rung nobody declared is unstorable. The first
 * layer makes a new rung a compile error, the second makes an unbounded run a thrown error, and the third
 * makes it unrepresentable in the database that records what was sent.
 */

/** A notice kind. Two, because they report different facts — see `GOOGLE_REAUTH_TEMPLATE_KEYS`. */
export const REAUTH_NOTICE_KINDS = ['reactive', 'predictive'] as const
export type ReauthNoticeKind = (typeof REAUTH_NOTICE_KINDS)[number]

/**
 * Which notice kind a health reading calls for, or null.
 *
 * A `Record` over `GoogleConnectionNotification` — the field `deriveConnectionHealth` already sets — so
 * this is a translation of the one derivation and not a second one. A third notification value added there
 * fails to compile here, which is what stops a new reason quietly producing no email.
 */
export const NOTICE_KIND_FOR_NOTIFICATION: Readonly<
  Record<GoogleConnectionNotification, ReauthNoticeKind>
> = Object.freeze({
  reauth_required: 'reactive',
  predictive_warning: 'predictive',
})

/**
 * Every rung either ladder may stand on.
 *
 * Facts about *when*, not about *what*: the wording comes from the kind and the timing comes from here, so
 * the predictive ladder can reuse the first rung without inheriting the repeats.
 */
export const REAUTH_LADDER_RUNGS = ['on_discovery', 'after_one_day', 'daily_thereafter'] as const
export type ReauthLadderRung = (typeof REAUTH_LADDER_RUNGS)[number]

/**
 * 24, spelled once, and declared here rather than below the table that reads it.
 *
 * `REAUTH_LADDER` is a frozen object literal evaluated at module load, so a `const` declared after it
 * would be in its temporal dead zone: the module would throw on import rather than fail to compile, which
 * is the one class of mistake a reader cannot see by looking at the table.
 */
const HOURS_PER_DAY_RUNG = 24

export interface ReauthRungSpec {
  /** Hours after the incident opened that this rung first falls due. */
  readonly firstAfterHours: number
  /** Hours between repeats, or null when the rung fires exactly once. */
  readonly repeatEveryHours: number | null
  /** Why this rung exists, in one sentence, for whoever has to decide whether the ladder is right. */
  readonly because: string
}

/**
 * The timing of every rung. A `Record`, so a rung added to the union without a time fails to compile.
 *
 * `daily_thereafter` is the only repeating rung and it is the last one, which is what makes the plan
 * monotonic without a sort: every rung's first occurrence is later than the previous rung's, and the
 * repeats extend from the end.
 */
export const REAUTH_LADDER: Readonly<Record<ReauthLadderRung, ReauthRungSpec>> = Object.freeze({
  on_discovery: {
    firstAfterHours: 0,
    repeatEveryHours: null,
    because:
      'The moment the grant is known to be dead. Every Google invalidation is silent, so the first ' +
      'notice is the only thing between a dead connection and somebody noticing weeks later.',
  },
  after_one_day: {
    firstAfterHours: HOURS_PER_DAY_RUNG,
    repeatEveryHours: null,
    because:
      'A day later, because the first one arrived while the owner was doing something else. One repeat ' +
      'at a different time of day catches the reader the first one missed without becoming a drumbeat.',
  },
  daily_thereafter: {
    firstAfterHours: 2 * HOURS_PER_DAY_RUNG,
    repeatEveryHours: HOURS_PER_DAY_RUNG,
    because:
      'Daily after that, until the cap. Daily rather than hourly because the fix is a human pressing a ' +
      'button, and nothing about the situation changes in an hour.',
  },
})

/**
 * Which rungs each kind stands on. A `Record` over the kind union, so a third kind fails to compile.
 *
 * The predictive ladder is ONE rung on purpose, and the acceptance line says why: *"does not re-fire for
 * the same expiry instant"*. Nothing is broken yet, and a daily countdown to a deadline the owner has
 * already been told about is the email that teaches them to filter these.
 */
export const REAUTH_LADDERS: Readonly<Record<ReauthNoticeKind, readonly ReauthLadderRung[]>> =
  Object.freeze({
    reactive: Object.freeze(['on_discovery', 'after_one_day', 'daily_thereafter'] as const),
    predictive: Object.freeze(['on_discovery'] as const),
  })

/** The roles a re-auth notice is addressed to, in the order they are told. Never a person (brief rule 10). */
export const REAUTH_NOTICE_ROLES = ['owner', 'manager'] as const
export type ReauthNoticeRole = (typeof REAUTH_NOTICE_ROLES)[number]

/**
 * One notice the ladder says should exist.
 *
 * `step` is the durable label: it is what the table records and what "already sent" is keyed on, so it has
 * to be derivable from the rung and the occurrence and from nothing else. `reactive_48h` is the third rung
 * of a reactive incident and nothing else, in any process, for ever.
 */
export interface PlannedReauthNotice {
  readonly step: string
  readonly kind: ReauthNoticeKind
  readonly rung: ReauthLadderRung
  /** Hours after the incident opened. Strictly increasing across the plan. */
  readonly afterHours: number
  /** The instant it falls due. */
  readonly dueAt: Instant
  /** 1-based, and bounded by the cap. The number migration 0075's CHECK refuses above the ceiling. */
  readonly rungIndex: number
}

/** The step label for a kind and an offset. One spelling, matched by 0075's pattern CHECK. */
export function reauthNoticeStep(kind: ReauthNoticeKind, afterHours: number): string {
  if (!Number.isInteger(afterHours) || afterHours < 0 || afterHours > 9999) {
    throw new AppError(
      'validation',
      `A re-auth notice ${afterHours} hours after the incident is not a step this ladder can name. ` +
        'The label is part of the deduplication key, so an unnameable offset would be a notice that ' +
        'cannot be recorded as sent and therefore sends for ever.',
      { details: { kind, afterHours } },
    )
  }
  return `${kind}_${afterHours}h`
}

/** The pattern 0075 restates in SQL. Exported so a test can assert the two agree. */
export const REAUTH_NOTICE_STEP_PATTERN = /^(reactive|predictive)_(0|[1-9][0-9]{0,3})h$/

const MINUTES_PER_HOUR = 60

/**
 * The cap, validated.
 *
 * Throws rather than clamping, and that is the point: a clamp turns "somebody configured 500" into a
 * silently different number, and the value came from a settings row an operator can see. A cap of zero is
 * refused too — a ladder with no rungs is not a quieter ladder, it is a connection that dies in silence,
 * and the way to turn the notices off is to fix the connection.
 */
export function reauthLadderCap(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_GOOGLE_REAUTH_LADDER_STEPS) {
    throw new AppError(
      'validation',
      `A re-auth ladder cap of ${value} is not between 1 and ${MAX_GOOGLE_REAUTH_LADDER_STEPS}. ` +
        'Zero would be a dead Google connection nobody is told about; an unbounded cap is a daily email ' +
        'for ever, which is the same thing one month later.',
      { details: { cap: value, ceiling: MAX_GOOGLE_REAUTH_LADDER_STEPS } },
    )
  }
  return value
}

/**
 * Every notice one incident should produce, in the order they fall due.
 *
 * Finite by construction: the walk is over the declared rungs, the only repeating rung is the last, and
 * the loop's bound is the cap rather than a condition about time. There is no input for which this returns
 * more than `cap` notices, and a test counts that at the ceiling.
 *
 * The predictive ladder stands on one non-repeating rung, so its plan is one notice however large the cap
 * is — which is the *"fires once … and does not re-fire"* half of its acceptance line, held by the shape
 * of the ladder rather than by a flag somebody could invert.
 */
export function reauthLadderFor(args: {
  readonly kind: ReauthNoticeKind
  readonly openedAt: Instant
  readonly cap: number
}): readonly PlannedReauthNotice[] {
  const cap = reauthLadderCap(args.cap)
  const notices: PlannedReauthNotice[] = []
  const push = (rung: ReauthLadderRung, afterHours: number): void => {
    notices.push({
      step: reauthNoticeStep(args.kind, afterHours),
      kind: args.kind,
      rung,
      afterHours,
      dueAt: addMinutes(args.openedAt, afterHours * MINUTES_PER_HOUR),
      rungIndex: notices.length + 1,
    })
  }
  for (const rung of REAUTH_LADDERS[args.kind]) {
    if (notices.length >= cap) break
    const spec = REAUTH_LADDER[rung]
    push(rung, spec.firstAfterHours)
    const every = spec.repeatEveryHours
    if (every === null) continue
    let afterHours = spec.firstAfterHours
    while (notices.length < cap) {
      afterHours += every
      push(rung, afterHours)
    }
  }
  return Object.freeze(notices)
}

/**
 * Why a run sent nothing. A CLOSED set, and 0075's CHECK holds the same list.
 *
 * Closed for `OBLIGATION_NOTICE_SKIP_REASONS`'s reason: *"how many re-auth notices did we not send last
 * month, and why"* is answerable over a vocabulary and unanswerable over free text.
 */
export const REAUTH_SKIP_REASONS = [
  /** The derivation says nothing is wrong. THE control: a healthy connection produces no notice at all. */
  'connection_is_healthy',
  /** The next rung has not fallen due yet. The ordinary answer on most days of an incident. */
  'no_rung_is_due_yet',
  /** Every rung that is due has already been sent for this incident. The dedupe rule. */
  'already_notified_for_this_step',
  /** The ladder is spent. The escalation stops here rather than going on daily for ever. */
  'ladder_cap_reached',
  /** No contact detail is on file for the role. Recorded rather than guessed — brief rule 15. */
  'no_recipient_on_file',
  /** No absolute origin is configured, so a deep link would be a relative path in an email. */
  'no_reconnect_link_configured',
  /** The channel is switched off. SMS is off by default and this is what that looks like on the row. */
  'channel_disabled',
  /**
   * The message was built and the choke point did not hand it to a vendor.
   *
   * A gate refusal or F03's staging guard, neither of which writes a `message` row — and on a staging
   * worker the second is the ORDINARY outcome. A distinct reason from `no_recipient_on_file` because one
   * is something to configure and the other is the environment behaving correctly.
   */
  'send_refused',
] as const
export type ReauthSkipReason = (typeof REAUTH_SKIP_REASONS)[number]

/**
 * An incident: the thing a ladder is climbed once for.
 *
 * `key` is what makes *"one per incident"* mean something. It is a string because the two kinds identify
 * an incident differently and both identifications are honest: a dead grant is identified by the
 * `google_connection_events` row that recorded it, and an approaching expiry by the expiry INSTANT — which
 * is what *"does not re-fire for the same expiry instant"* asks for, and which no event row could supply,
 * because nothing happens when a deadline comes into view.
 */
export interface ReauthIncident {
  readonly key: string
  readonly openedAt: Instant
}

/** The prefixes an incident key may carry. Closed, and restated as 0075's pattern CHECK. */
export const REAUTH_INCIDENT_KEY_PATTERN = /^(reauth|expiry|stale):[\x21-\x7e]{1,180}$/

/** A dead grant's incident, keyed on the event row that recorded it. */
export function reauthIncidentKey(eventId: string | number): string {
  return `reauth:${String(eventId)}`
}

/** An approaching Testing expiry, keyed on the instant itself. */
export function expiryIncidentKey(expiresAt: Instant): string {
  return `expiry:${instantToIso(expiresAt)}`
}

/** A staleness incident, keyed on the instant the window closed. Fixed, so it cannot re-fire. */
export function stalenessIncidentKey(windowClosedAt: Instant): string {
  return `stale:${instantToIso(windowClosedAt)}`
}

/** What a run of the pass decided for one connection. */
export type ReauthNoticeRun =
  | {
      readonly kind: 'send'
      readonly noticeKind: ReauthNoticeKind
      readonly incident: ReauthIncident
      /** Every rung that is due and unsent. Counted by the tests; never derived from a clock. */
      readonly due: readonly PlannedReauthNotice[]
      /** The roles told, in order. */
      readonly roles: readonly ReauthNoticeRole[]
    }
  | { readonly kind: 'skip'; readonly reason: ReauthSkipReason }

/**
 * Everything the run needs to decide, with no store and no clock in it.
 *
 * `alreadySentSteps` is the dedupe input and it is a list of LABELS rather than a count, because a count
 * cannot tell "the first two rungs went out" from "two copies of the first rung went out" — and the second
 * is the bug being prevented. The store supplies it from the rows it has, so the claim *"fifty failed jobs
 * inside one incident produce exactly one email"* is decided here and enforced by a unique index there.
 */
export interface ReauthNoticeRunRequest {
  readonly health: GoogleConnectionHealth
  readonly incident: ReauthIncident | null
  readonly now: Instant
  readonly cap: number
  readonly alreadySentSteps: readonly string[]
}

/**
 * What to send for one connection, now.
 *
 * Reads `health.notify`, which `deriveConnectionHealth` already computed, and translates it through
 * {@link NOTICE_KIND_FOR_NOTIFICATION}. It does not ask again whether the connection is broken: two
 * answers to that question is the defect docs/10 §2 arranges everything else to avoid, and the second
 * answer would be the one in the email.
 *
 * `due` can hold more than one rung, and that is deliberate rather than an oversight: a worker that was
 * down for three days comes back with three rungs due, and sending one per pass would stretch a
 * five-notice ladder over five days of downtime and then five more. The cap still bounds the total, and
 * the recorded steps still make each one once.
 */
export function reauthNoticeRunFor(request: ReauthNoticeRunRequest): ReauthNoticeRun {
  const notification = request.health.notify
  if (notification === null) return { kind: 'skip', reason: 'connection_is_healthy' }
  const noticeKind = NOTICE_KIND_FOR_NOTIFICATION[notification]
  if (request.incident === null) return { kind: 'skip', reason: 'connection_is_healthy' }

  const plan = reauthLadderFor({
    kind: noticeKind,
    openedAt: request.incident.openedAt,
    cap: request.cap,
  })
  const sent = new Set(request.alreadySentSteps)
  const dueNow = plan.filter((notice) => notice.dueAt <= request.now)
  const due = dueNow.filter((notice) => !sent.has(notice.step))
  if (due.length > 0) {
    return {
      kind: 'send',
      noticeKind,
      incident: request.incident,
      due: Object.freeze(due),
      roles: REAUTH_NOTICE_ROLES,
    }
  }
  // Ordered cause before symptom, exactly as `testConnection`'s verdict is. A spent ladder ALSO satisfies
  // "nothing new is due", and reporting the timing would say the pass is waiting when it has in fact
  // finished — which is the difference between a row somebody leaves alone and a row somebody chases.
  if (plan.length > 0 && plan.every((notice) => sent.has(notice.step))) {
    return { kind: 'skip', reason: 'ladder_cap_reached' }
  }
  if (dueNow.length > 0) return { kind: 'skip', reason: 'already_notified_for_this_step' }
  return { kind: 'skip', reason: 'no_rung_is_due_yet' }
}

/**
 * Whether a state carries the banner, and whether a human may make it go away.
 *
 * A `Record` over the display-state union, so a seventh presentation state cannot reach an admin page
 * without somebody deciding this — the third compile-time obligation on that union, after G-CONN-07's
 * sentence table and transition matrix. Satisfying one of the three does not satisfy the others, which is
 * the whole reason they are three tables rather than one.
 */
export const REAUTH_BANNER_RULES: Readonly<
  Record<GoogleConnectionDisplayState, { readonly show: boolean; readonly dismissible: boolean }>
> = Object.freeze({
  never_connected: { show: false, dismissible: false },
  healthy: { show: false, dismissible: false },
  // Nothing is broken yet and the deadline drives the predictive email instead. A banner on every admin
  // page for the seven days after every consent would be a banner nobody reads by the second week.
  expiring_soon: { show: false, dismissible: false },
  degraded: { show: true, dismissible: true },
  // The launch-day normal for weeks (docs/10 §1). Red on every page for six weeks about something the
  // owner can do nothing about is how a real fault comes to be ignored.
  pending_gbp_approval: { show: false, dismissible: false },
  broken: { show: true, dismissible: false },
})

/**
 * What a banner says.
 *
 * The headline and the detail come from `CONNECTION_STATE_COPY`, not from a second copy here: the card and
 * the banner are two renderings of one sentence, and an owner who reads a different wording on each has to
 * decide which is true. `reconnectPath` is the one action.
 */
export interface ReauthBannerView {
  readonly state: GoogleConnectionDisplayState
  readonly headline: string
  readonly detail: string
  /**
   * False for `broken`, and it is a claim about the DOCUMENT rather than about a click.
   *
   * When it is true the renderer emits a native `<details>` collapse, which cannot outlive the response it
   * is in: there is no client bundle on these documents, so nothing records that it was collapsed, and the
   * next page the operator opens renders it expanded again. That is the *"reappears after a client-side
   * navigation"* half of the acceptance, satisfied by there being nowhere for a dismissal to live rather
   * than by code that puts it back.
   *
   * When it is false the renderer emits no control at all — see `reauth.ts`'s header for why every
   * available *somewhere* to store a dismissal is wrong for a dead Google grant.
   */
  readonly dismissible: boolean
  /** The connection the banner is about, so the reconnect link can name it. Null when there are several. */
  readonly connectionId: string | null
  /** The account, so the owner knows which Google account to sign in as. Null when nothing is connected. */
  readonly googleEmail: string | null
}

/**
 * The banner for one connection's health, or null when the state carries none.
 *
 * Keyed on `stateShownFor` rather than on `displayState`, which is G-CONN-07's one instruction to this
 * unit: a connection consented ten minutes ago with nothing read yet derives `healthy` and is shown
 * `degraded`, and a banner keyed on the derivation would be missing from the page that has something to
 * say. There is no second rule here — the divergence is `stateShownFor`'s and this reads it.
 */
export function reauthBannerFor(args: {
  readonly health: GoogleConnectionHealth
  readonly connectionId?: string | null
  readonly googleEmail?: string | null
}): ReauthBannerView | null {
  const state = stateShownFor(args.health)
  const rule = REAUTH_BANNER_RULES[state]
  if (!rule.show) return null
  const copy = connectionStateCopy(state)
  return {
    state,
    headline: copy.headline,
    detail: copy.detail,
    dismissible: rule.dismissible,
    connectionId: args.connectionId ?? null,
    googleEmail: args.googleEmail ?? null,
  }
}

/**
 * The banner for a whole admin page, which may be looking at several connections.
 *
 * The worst state wins, and *worst* is the precedence `chooseDisplayState` already declares: a `broken`
 * connection beside a `degraded` one is a page with a non-dismissible banner, because the dismissible one
 * would let the operator make the other one's warning disappear. The list is read in one pass so the
 * answer does not depend on the order the rows arrived in.
 */
export function pageReauthBanner(
  connections: readonly {
    readonly connectionId: string
    readonly googleEmail: string
    readonly health: GoogleConnectionHealth
  }[],
): ReauthBannerView | null {
  let best: ReauthBannerView | null = null
  for (const connection of connections) {
    const banner = reauthBannerFor({
      health: connection.health,
      connectionId: connection.connectionId,
      googleEmail: connection.googleEmail,
    })
    if (banner === null) continue
    if (best === null || (best.dismissible && !banner.dismissible)) best = banner
  }
  // Two connections in the same state is one banner about neither in particular: naming one of them would
  // send the owner to reconnect an account that may not be the one that failed.
  if (best === null) return best
  const sameState = connections.filter(
    (connection) => stateShownFor(connection.health) === best?.state,
  )
  return sameState.length > 1 ? { ...best, connectionId: null, googleEmail: null } : best
}

/**
 * Asserts a banner's copy still carries docs/10 §4's promise.
 *
 * Exported as a predicate rather than written as a test assertion because two packages check it: the
 * banner's own suite, and the template corpus, which has to make the same claim about an email body. A
 * predicate both can call is one rule; two assertions would be two.
 */
export function carriesReassurance(text: string): boolean {
  return text.includes(REAUTH_REASSURANCE_SENTENCE)
}

/**
 * Where a reconnect should return to, or null.
 *
 * The syntactic half of the open-redirect defence, and it is deliberately only the syntactic half: this
 * module cannot know which paths exist, so the route applies a second check against the admin paths it
 * declares. Two layers, because each catches what the other cannot — a path that is well-formed and does
 * not exist is a 404 after a successful consent, and a path that exists but was written
 * `//evil.example/x` is an open redirect on a route that hands out nothing but a redirect.
 *
 * Refused: anything not starting with a single `/`, a protocol-relative `//`, a backslash (which several
 * browsers normalise to `/`), a `:` anywhere, and anything over 200 characters. A query string is allowed
 * — the calendar's state is its URL — and a fragment is not, because a fragment never reaches the server
 * and would be dead weight in a cookie.
 */
export function parseReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value.length === 0 || value.length > 200) return null
  if (!value.startsWith('/') || value.startsWith('//')) return null
  if (value.includes('\\') || value.includes(':') || value.includes('#')) return null
  // Control characters split a `Location` header. Refused by code point rather than by a regex class so
  // the rule does not depend on which characters a linter believes are printable.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return null
  }
  return value
}
