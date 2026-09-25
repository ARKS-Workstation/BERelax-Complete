import { assertNever } from '../assert-never.ts'
import { ASIA_DUBAI, addMinutes, fromLocal, type Instant, localTime, toLocal } from '../time.ts'
import {
  GOOGLE_SCOPE_BUSINESS_MANAGE,
  GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY,
  type GoogleCapability,
  type GoogleCapabilityHealth,
  type GoogleConnectionDisplayState,
  type GoogleConnectionHealth,
  type GoogleRequestedScope,
} from './connection.ts'

/**
 * What a human is told about the Google connection, and what may move it.
 *
 * `connection.ts` next door answers *"what state is this connection in"* — the stored grant status, the
 * capability health, the staleness window, the seven-day fuse — and it is the one derivation every
 * surface and every email reads. This file answers the two questions that come after it, and both are
 * about people rather than about Google:
 *
 *  1. **What sentence does a person see?** Exactly one per presentation state, in `CONNECTION_STATE_COPY`,
 *     which is a `Record` over the state union. That is the enforcement rather than a convention: a state
 *     added to `GoogleConnectionDisplayState` without a sentence **fails to compile**, in this file and in
 *     every switch below, so an enum member can never reach a screen. docs/10 §4 is explicit that the
 *     states are shown in plain English and **never as scope strings**, and a lookup that the compiler
 *     insists is total is the only version of that promise which survives the next state being added.
 *
 *  2. **Which events may move which state?** `CONNECTION_TRANSITIONS` is a `Record` over *both* unions, so
 *     every (state × event) pair carries either a declared transition or an explicit refusal with a
 *     reason. Neither dimension can lose a member silently, and there is no `default:` anywhere for one to
 *     hide in.
 *
 * ## What the matrix is, and what it is deliberately not
 *
 * It is a **closure claim**: for each of the {@link CONNECTION_PRESENTATION_STATES} and each of the
 * {@link CONNECTION_STATE_EVENTS} somebody has decided, in writing, what happens — including deciding that
 * nothing does. It is what makes a new state or a new event impossible to add without recording that
 * decision 13 or 6 times.
 *
 * It is **not** a second derivation, and nothing renders from it. What a card shows *right now* is
 * `stateShownFor(deriveConnectionHealth(...))` and nothing else; if the matrix and the derivation ever
 * disagreed about a pair, the derivation would be right. That is why `connection-state.test.ts` checks the
 * matrix against `deriveConnectionHealth` over hand-built fixtures rather than trusting it: two answers to
 * one question is the defect this whole module is arranged to avoid, and the way to keep it to one is to
 * make the second answer checkable rather than to write it twice.
 */

/** Every presentation state, enumerated so a test can walk them. Pinned to the union below. */
export const CONNECTION_PRESENTATION_STATES = [
  'never_connected',
  'healthy',
  'expiring_soon',
  'degraded',
  'pending_gbp_approval',
  'broken',
] as const satisfies readonly GoogleConnectionDisplayState[]

/**
 * How urgently the state reads, for a surface that has to choose an affordance.
 *
 * Four words rather than colours. A token name here would put the design system inside `packages/core`,
 * and the mapping from urgency to colour belongs to `@berelax/ui` — which is also what stops an admin
 * screen inventing a fifth shade of amber.
 */
export type ConnectionTone = 'neutral' | 'good' | 'attention' | 'urgent'

/**
 * What the owner is told, per state.
 *
 * `headline` is the words docs/10 §4 names. `detail` is the sentence under it, and it always says what
 * happens next if the reader does nothing — a state that does not is a state somebody has to ask about.
 */
export interface ConnectionStateCopy {
  readonly headline: string
  readonly detail: string
  readonly tone: ConnectionTone
  /**
   * Whether the headline may only be shown beside a relative timestamp.
   *
   * True for exactly one state, and it is the rule docs/10 §4 states outright: *"Connected" with no
   * recency is exactly how silent failure hides.* `stateShownFor` is what enforces it.
   */
  readonly requiresRecency: boolean
}

/**
 * The one place a state becomes a sentence. A `Record`, so the compiler requires all six.
 *
 * The strings are docs/10 §4's, including the reassurance in `broken` — *"review replies will keep being
 * drafted for you to post by hand; nothing is lost"* — which is there because the owner's first question
 * on seeing a red banner is whether work has been lost, and answering it in the banner is what stops the
 * banner being a phone call.
 *
 * `pending_gbp_approval`'s headline is quoted verbatim by the settings card's test. It is the state that
 * looks like an error and is not: Business Profile API access is granted by application review rather than
 * by enabling an API, so a perfectly valid token with zero quota is the expected state for weeks after
 * launch (docs/10 §1).
 */
export const CONNECTION_STATE_COPY: Readonly<
  Record<GoogleConnectionDisplayState, ConnectionStateCopy>
> = Object.freeze({
  never_connected: {
    headline: 'Not connected',
    detail:
      'No Google account is connected. Connecting one lets review replies be drafted for approval and ' +
      'Search Console performance be read; nothing is published without somebody pressing a button.',
    tone: 'neutral',
    requiresRecency: false,
  },
  healthy: {
    headline: 'Connected',
    detail: 'Everything this connection is used for was working at the time shown.',
    tone: 'good',
    requiresRecency: true,
  },
  expiring_soon: {
    headline: 'Connected, and due to stop working',
    detail:
      'Nothing is wrong yet. The date below is when this connection stops working, and publishing the ' +
      'Google consent screen is what removes the deadline altogether.',
    tone: 'attention',
    requiresRecency: false,
  },
  degraded: {
    headline: 'Connected, but something it needs is not working',
    detail:
      'The connection itself is fine. One of the things it reads is not, and the list below names which.',
    tone: 'attention',
    requiresRecency: false,
  },
  pending_gbp_approval: {
    headline: 'Connected, Business Profile access pending Google approval',
    detail:
      'This is expected and is not something to act on. Google grants Business Profile access by ' +
      'reviewing an application rather than by switching an API on, so the reads below will keep being ' +
      'refused until that review finishes.',
    tone: 'attention',
    requiresRecency: false,
  },
  broken: {
    headline: 'Needs re-authorising',
    detail:
      'Reconnect the Google account to fix this. In the meantime review replies will keep being drafted ' +
      'for you to post by hand; nothing is lost.',
    tone: 'urgent',
    requiresRecency: false,
  },
})

/** The sentence and tone for a state. A function so a caller cannot index the table with a string. */
export function connectionStateCopy(state: GoogleConnectionDisplayState): ConnectionStateCopy {
  return CONNECTION_STATE_COPY[state]
}

/**
 * Why a connection is showing `degraded`, which is the one state with more than one cause.
 *
 * Kept apart from the state itself because the state decides the badge and the cause decides the
 * sentence. Collapsing them would mean either three states nothing else understands, or one sentence that
 * has to cover *"a capability is failing"* and *"nothing has ever been read"* — and those two ask the
 * reader for completely different things.
 */
export type DegradedCause = 'never_verified' | 'capability_failing' | 'stale'

/** The sentence per cause. A `Record`, for the same reason the state copy is one. */
export const DEGRADED_CAUSE_DETAIL: Readonly<Record<DegradedCause, string>> = Object.freeze({
  never_verified:
    'Nothing has been read from Google on this connection yet, so there is nothing to confirm it ' +
    'works. The nightly check will try, or press Test connection to find out now.',
  capability_failing:
    'The connection is live and at least one of the things it reads is refusing. The list below names ' +
    'which, and what each one means.',
  stale:
    'The connection is live and nothing has been read successfully for more than two days, which is ' +
    'long enough that something is wrong rather than quiet.',
})

/**
 * Which cause a health reading is showing, or null when the state is not `degraded`.
 *
 * Ordered: never-verified first, because *"nothing has ever worked"* is a different conversation from
 * *"something stopped working"*, and a connection in that state is usually one somebody has just made.
 */
export function degradedCauseFor(health: GoogleConnectionHealth): DegradedCause | null {
  if (stateShownFor(health) !== 'degraded') return null
  if (health.hoursSinceLastSuccess === null) return 'never_verified'
  if (health.failingCapabilities.length > 0) return 'capability_failing'
  return 'stale'
}

/**
 * The state a person is shown, which is not always the state the derivation reports.
 *
 * One rule, and it exists because of one sentence in docs/10 §4: *States shown in plain English … an
 * account is "Connected" **with a "last verified 2 hours ago" timestamp** — "Connected" with no recency is
 * exactly how silent failure hides.*
 *
 * `deriveConnectionHealth` answers *"is anything wrong"*, and for a connection consented ten minutes ago
 * with no successful call the answer is genuinely no: it is not stale (staleness falls back to
 * `consentAt`), no capability has failed, and nothing should email anybody about it. So it derives
 * `healthy` — and a card that printed `healthy` for it would show a green tick and the words *No
 * successful call has been made yet* in the same box, which is the exact pair of claims this rule exists
 * to forbid.
 *
 * So the card shows `degraded`, cause `never_verified`, until something has been read. The alternative
 * designs were both worse: a seventh state would make every consumer of the union decide about it, and
 * suppressing the green tick without changing the state would leave the amber/red affordance keyed to a
 * state that says everything is fine.
 *
 * Every surface reads this rather than `displayState` directly, which is why it takes the whole health
 * record — a function of `displayState` alone could not see the recency it turns on.
 */
export function stateShownFor(health: GoogleConnectionHealth): GoogleConnectionDisplayState {
  if (health.displayState === 'healthy' && health.hoursSinceLastSuccess === null) return 'degraded'
  return health.displayState
}

/**
 * The relative timestamp beside the headline, or null when there has never been a successful call.
 *
 * Null rather than *"never"*: the null is what `stateShownFor` keys on, and a caller that has to compare
 * against a magic string is a caller that will render it.
 *
 * Whole hours and days, because the input is whole hours. A minutes-accurate phrase would imply a
 * precision `hoursSinceLastSuccess` does not carry, and *"last verified 0 hours ago"* reads as an error —
 * which is why the first bucket is words rather than a number.
 */
export function recencyPhrase(hoursSinceLastSuccess: number | null): string | null {
  const hours = hoursSinceLastSuccess
  if (hours === null) return null
  if (hours <= 0) return 'Last verified less than an hour ago'
  if (hours === 1) return 'Last verified 1 hour ago'
  if (hours < HOURS_PER_DAY) return `Last verified ${hours} hours ago`
  const days = Math.floor(hours / HOURS_PER_DAY)
  return days === 1 ? 'Last verified 1 day ago' : `Last verified ${days} days ago`
}

const HOURS_PER_DAY = 24
const MINUTES_PER_DAY = 24 * 60

/**
 * The local hour the daily deep check runs at, and the reason it is here rather than only in the worker.
 *
 * The card tells the owner when the next check will happen, and a card that computed that from its own
 * copy of the hour would go on promising 03:00 after somebody moved the cron. `apps/worker`'s registry
 * declares `0 3 * * *` with `tz: 'Asia/Dubai'`, and
 * `apps/worker/src/jobs/google-connection-health.test.ts` asserts the registered expression's hour is
 * this constant — so the two cannot drift apart without a named failure.
 */
export const DAILY_HEALTH_CHECK_LOCAL_HOUR = 3

/**
 * When the nightly check will next run, as an instant.
 *
 * Asia/Dubai has no daylight saving — a fixed UTC+4 all year — so *"the same wall-clock time tomorrow"* is
 * exactly 24 hours later and needs no DST branch. The zone is still resolved through `fromLocal` rather
 * than by adding four hours, because a hand-computed offset is the one arithmetic that keeps being right
 * until the day a zone changes its rules.
 */
export function nextDailyHealthCheck(now: Instant): Instant {
  const time = localTime(`0${DAILY_HEALTH_CHECK_LOCAL_HOUR}:00`)
  const today = fromLocal(toLocal(now, ASIA_DUBAI).date, time, ASIA_DUBAI)
  if (today > now) return today
  return fromLocal(toLocal(addMinutes(today, MINUTES_PER_DAY), ASIA_DUBAI).date, time, ASIA_DUBAI)
}

/**
 * Everything that can happen to a connection, as far as what a person is shown is concerned.
 *
 * Facts rather than commands, and each one is something this system already observes: a consent exchange,
 * a forced refresh, one capability probe, a settings change, an offboarding. `gbp_read_refused_pending`
 * is separate from `capability_failed` because the two produce different states from the same HTTP
 * response — which is the whole of `partitionCapabilities` — and an event set that could not tell them
 * apart would make `pending_gbp_approval` unreachable.
 */
export const CONNECTION_STATE_EVENTS = [
  /** A consent exchange completed and a grant was stored (G-CONN-02). */
  'consent_completed',
  /** A forced refresh was answered: the grant is alive. NOT a capability read, so no recency moves. */
  'refresh_succeeded',
  /** The refresh came back `invalid_grant`: the grant is dead (docs/10 §4). */
  'refresh_failed_invalid_grant',
  /** A declared capability failed for a reason the owner can act on. */
  'capability_failed',
  /** A Business Profile read was refused while the access application is still pending. */
  'gbp_read_refused_pending',
  /** Every declared capability read successfully. The only event that can report all-clear. */
  'capabilities_all_ok',
  /** `google.business_profile_access_granted` moved to true: quota went 0 → 300 QPM. */
  'gbp_access_approved',
  /** Two days passed with nothing read successfully. */
  'staleness_window_passed',
  /** The Testing expiry came inside the 48-hour window. */
  'testing_expiry_within_window',
  /** `google.consent_screen_publishing_status` moved to production: the seven-day fuse is gone. */
  'consent_screen_published',
  /** The owner disconnected the account on purpose (G-CONN-09). */
  'owner_disconnected',
  /** The grant was revoked at Google — `myaccount.google.com`, or a Workspace policy. */
  'grant_revoked_at_google',
  /** An authenticated call was answered, so `last_ok_at` moved. */
  'check_reached_google',
] as const

export type ConnectionStateEvent = (typeof CONNECTION_STATE_EVENTS)[number]

/** Why an event leaves the state alone. Four reasons, each meaning something different to a reader. */
export type TransitionRefusal =
  /** There is no live grant for the event to be about. */
  | 'no_connection_to_act_on'
  /** The state already says this. The dedupe rule, and the reason one incident is one email. */
  | 'already_in_that_state'
  /** Only a re-consent moves a dead grant. Nothing can be read without a token. */
  | 'reconnect_first'
  /** True, but something worse is already being shown. `chooseDisplayState`'s precedence. */
  | 'not_the_current_obstacle'

/**
 * What an event does to what a person is shown.
 *
 * `PresentationTransition` rather than `ConnectionTransition`, which `connection.ts` already exports for
 * the transition of the stored **status** column. The two vocabularies are deliberately not one (see that
 * file's header), and giving them one name in the barrel would be the first step to conflating them again.
 */
export type PresentationTransition =
  | {
      readonly kind: 'moves'
      readonly to: GoogleConnectionDisplayState
      /** Why, in one sentence. Read by a person deciding whether the matrix is right. */
      readonly because: string
    }
  | { readonly kind: 'refused'; readonly reason: TransitionRefusal; readonly because: string }

const moves = (
  to: GoogleConnectionDisplayState,
  because: string,
): Extract<PresentationTransition, { kind: 'moves' }> => ({ kind: 'moves', to, because })

const refused = (
  reason: TransitionRefusal,
  because: string,
): Extract<PresentationTransition, { kind: 'refused' }> => ({ kind: 'refused', reason, because })

/** The events that cannot be about a connection nobody has made. Every one, so the row is total. */
const NOTHING_IS_CONNECTED = 'There is no live grant, so this fact cannot be about this business.'
const DEAD_GRANT_READS_NOTHING =
  'The grant is dead, so no token is issued and no capability can be read at all.'

/**
 * Every (state × event) pair, decided.
 *
 * A `Record` over both unions rather than a switch, and the difference is what happens when somebody adds
 * a member: a switch needs an `assertNever` in each of six arms to be total, and the table needs nothing —
 * TypeScript refuses the object literal until all 78 entries exist. `assertNever` still appears below, in
 * `connectionToneFor`, because the *other* half of the claim is that no state reaches a surface without a
 * sentence, and that is a switch.
 */
export const CONNECTION_TRANSITIONS: Readonly<
  Record<
    GoogleConnectionDisplayState,
    Readonly<Record<ConnectionStateEvent, PresentationTransition>>
  >
> = Object.freeze({
  never_connected: {
    consent_completed: moves(
      'degraded',
      'A stored grant is not a working one: nothing has been read yet, so the card says so rather ' +
        'than showing a green tick the first nightly check might contradict.',
    ),
    refresh_succeeded: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
    refresh_failed_invalid_grant: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
    capability_failed: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
    gbp_read_refused_pending: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
    capabilities_all_ok: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
    gbp_access_approved: refused(
      'no_connection_to_act_on',
      'The setting can be changed with nothing connected, and until something is there is nothing ' +
        'for it to change the meaning of.',
    ),
    staleness_window_passed: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
    testing_expiry_within_window: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
    consent_screen_published: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
    owner_disconnected: refused(
      'already_in_that_state',
      'A disconnected connection reads as never connected, deliberately: the owner did it on purpose, ' +
        'and a state that emails them daily about their own action trains them to ignore the emails.',
    ),
    grant_revoked_at_google: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
    check_reached_google: refused('no_connection_to_act_on', NOTHING_IS_CONNECTED),
  },
  healthy: {
    consent_completed: moves(
      'healthy',
      'A re-consent on a working grant replaces the token and changes nothing a person is shown; the ' +
        'recency that makes it healthy is a different column and survives.',
    ),
    refresh_succeeded: moves('healthy', 'The grant is alive and was already known to be working.'),
    refresh_failed_invalid_grant: moves(
      'broken',
      'The one failure that kills a grant. Nothing else in the taxonomy does, because treating a quota ' +
        'error or a 500 as a dead token sends the owner through a re-consent that fixes nothing.',
    ),
    capability_failed: moves(
      'degraded',
      'The connection works and something it reads does not, which is the distinction the whole ' +
        'per-capability health column exists to keep.',
    ),
    gbp_read_refused_pending: moves(
      'pending_gbp_approval',
      'The same refusal as a failure, read differently because Google has not finished its access ' +
        'review: rendering it red would put a banner on every admin page for six weeks.',
    ),
    capabilities_all_ok: moves('healthy', 'Everything read. Nothing changed.'),
    gbp_access_approved: moves(
      'healthy',
      'Approval only changes what a REFUSED read means, and nothing is being refused.',
    ),
    staleness_window_passed: moves(
      'degraded',
      'An active grant with no recent success is not healthy: that is precisely the silent failure ' +
        'being designed out, and the banner shows for degraded so the owner is told.',
    ),
    testing_expiry_within_window: moves(
      'expiring_soon',
      'Nothing is broken yet, which is the point of showing it: there is still time to publish the ' +
        'consent screen.',
    ),
    consent_screen_published: moves(
      'healthy',
      'Publishing removes the seven-day fuse and touches nothing else.',
    ),
    owner_disconnected: moves('never_connected', 'The owner ended it on purpose.'),
    grant_revoked_at_google: moves(
      'broken',
      'A revocation at myaccount.google.com takes effect immediately and silently; the next call is ' +
        'what discovers it.',
    ),
    check_reached_google: moves('healthy', 'A call was answered, so the recency moved forward.'),
  },
  expiring_soon: {
    consent_completed: moves(
      'healthy',
      'Re-consenting is exactly what buys another seven days, so the deadline moves out of the window ' +
        'and there is nothing left to warn about.',
    ),
    refresh_succeeded: moves(
      'expiring_soon',
      'The expiry is measured from the consent, not from the last refresh, so refreshing does not ' +
        'postpone it. This is the fact that makes the fuse invisible without a tripwire.',
    ),
    refresh_failed_invalid_grant: moves(
      'broken',
      'The deadline arrived. What was predicted is now what happened.',
    ),
    capability_failed: moves(
      'degraded',
      'A live failure outranks a future one: docs/07 §6 orders a real fault above the launch-day ' +
        'normal and above a deadline nothing has hit yet.',
    ),
    gbp_read_refused_pending: moves(
      'pending_gbp_approval',
      'Both are amber and neither is an error; the pending review is the one the owner can do nothing ' +
        'about, so it is shown first.',
    ),
    capabilities_all_ok: moves(
      'expiring_soon',
      'Everything reads, and the deadline is still there. Both are true at once, which is why the ' +
        'expiry is a state rather than a failure.',
    ),
    gbp_access_approved: moves('expiring_soon', 'Nothing is being refused for it to change.'),
    staleness_window_passed: moves(
      'degraded',
      'Two days without a successful read is a fault now, and it outranks a deadline still to come.',
    ),
    testing_expiry_within_window: refused(
      'already_in_that_state',
      'The window is what put it here.',
    ),
    consent_screen_published: moves(
      'healthy',
      'The deadline is gone rather than postponed: a published consent screen issues refresh tokens ' +
        'that do not expire after seven days.',
    ),
    owner_disconnected: moves('never_connected', 'The owner ended it on purpose.'),
    grant_revoked_at_google: moves('broken', 'A dead grant outranks a deadline.'),
    check_reached_google: moves('expiring_soon', 'The recency moved and the deadline did not.'),
  },
  degraded: {
    consent_completed: moves(
      'degraded',
      'A re-consent fixes a missing permission and proves nothing else: capability health goes to ' +
        'unknown rather than ok, because a consent is not a read (capabilityHealthAtConsent).',
    ),
    refresh_succeeded: moves(
      'degraded',
      'The grant was never the problem. A live token does not make a refused read succeed.',
    ),
    refresh_failed_invalid_grant: moves('broken', 'A dead grant outranks everything else.'),
    capability_failed: moves('degraded', 'A second failing capability is the same state.'),
    gbp_read_refused_pending: refused(
      'not_the_current_obstacle',
      'Something the owner CAN act on is already being shown, and the pending review must never hide ' +
        'it — which is why pending ranks below a real failure rather than above it.',
    ),
    capabilities_all_ok: moves(
      'healthy',
      'Every declared capability read, and the pass that established that reached Google, so the ' +
        'recency moved in the same breath.',
    ),
    gbp_access_approved: moves(
      'degraded',
      'Approval cannot fix a capability that was already failing for a reason of its own.',
    ),
    staleness_window_passed: moves('degraded', 'A second reason for the same state.'),
    testing_expiry_within_window: refused(
      'not_the_current_obstacle',
      'The date is still rendered — the tripwire is an element, not a state — but a future deadline ' +
        'must not replace a present fault on the badge.',
    ),
    consent_screen_published: moves(
      'degraded',
      'The fuse is gone and the failing capability is not.',
    ),
    owner_disconnected: moves('never_connected', 'The owner ended it on purpose.'),
    grant_revoked_at_google: moves('broken', 'A dead grant outranks everything else.'),
    check_reached_google: moves(
      'degraded',
      'A call being answered clears staleness and not a refusal. The event that clears a refusal is ' +
        'capabilities_all_ok, and keeping them apart is what stops one answered call reporting ' +
        'all-clear for a capability nobody read.',
    ),
  },
  pending_gbp_approval: {
    consent_completed: moves(
      'pending_gbp_approval',
      'A new token does not bring quota with it: access is granted by application review, not by the ' +
        'consent screen.',
    ),
    refresh_succeeded: moves('pending_gbp_approval', 'A valid token with zero quota is the state.'),
    refresh_failed_invalid_grant: moves('broken', 'A dead grant outranks a pending review.'),
    capability_failed: moves(
      'degraded',
      'Something the owner can act on has appeared beside the thing they cannot, and it must be the ' +
        'one shown.',
    ),
    gbp_read_refused_pending: refused('already_in_that_state', 'This is what the state means.'),
    capabilities_all_ok: moves(
      'healthy',
      'The reads started working, which is what approval looks like from here — and it is why this ' +
        'state is never cleared by the setting alone.',
    ),
    gbp_access_approved: moves(
      'degraded',
      'The one setting change that makes a connection LOOK worse, and correctly: the refusal that ' +
        'read as the launch-day normal is a fault the moment Google says access is granted. Deriving ' +
        'the approval from the refusals instead would be circular, so a human records it.',
    ),
    staleness_window_passed: moves(
      'degraded',
      'Two days with nothing read at all is more than a pending review would explain.',
    ),
    testing_expiry_within_window: refused(
      'not_the_current_obstacle',
      'docs/07 §6 ranks the pending review above the deadline; the date is still rendered by the ' +
        'tripwire.',
    ),
    consent_screen_published: moves(
      'pending_gbp_approval',
      'Two different Google approvals, neither of which is the other: publishing the consent screen ' +
        'is not the Business Profile access review.',
    ),
    owner_disconnected: moves('never_connected', 'The owner ended it on purpose.'),
    grant_revoked_at_google: moves('broken', 'A dead grant outranks a pending review.'),
    check_reached_google: moves(
      'pending_gbp_approval',
      'Search Console answering keeps the recency fresh while Business Profile is still refused, ' +
        'which is exactly the state this is.',
    ),
  },
  broken: {
    consent_completed: moves(
      'degraded',
      'The grant is alive again and nothing has been read through it. Showing healthy here would be a ' +
        'green tick earned by a consent screen rather than by a call.',
    ),
    refresh_succeeded: moves(
      'degraded',
      'The owner re-consented, or a transient revocation resolved. The banner comes down — leaving it ' +
        'up on a working connection is the same credibility problem as a false alarm — but nothing has ' +
        'been read since it died, so this is not healthy either.',
    ),
    refresh_failed_invalid_grant: refused(
      'already_in_that_state',
      'The dedupe rule, and it is structural rather than in the mailer: three Google jobs per cycle ' +
        'would otherwise send three identical emails, and docs/07 §6 says one per incident.',
    ),
    capability_failed: refused('reconnect_first', DEAD_GRANT_READS_NOTHING),
    gbp_read_refused_pending: refused('reconnect_first', DEAD_GRANT_READS_NOTHING),
    capabilities_all_ok: refused('reconnect_first', DEAD_GRANT_READS_NOTHING),
    gbp_access_approved: refused('not_the_current_obstacle', 'Quota is no use without a token.'),
    staleness_window_passed: refused(
      'not_the_current_obstacle',
      'Of course nothing has succeeded: the grant is dead. Reporting staleness here would replace the ' +
        'cause with a symptom.',
    ),
    testing_expiry_within_window: refused(
      'not_the_current_obstacle',
      'The deadline is moot once the thing it predicted has happened.',
    ),
    consent_screen_published: refused(
      'reconnect_first',
      'Publishing stops the NEXT grant expiring after seven days. It does not revive this one, and ' +
        'expecting it to is the mistake the tripwire sentence is worded to prevent.',
    ),
    owner_disconnected: moves(
      'never_connected',
      'Disconnecting a dead grant is still worth doing: it revokes the token at Google so an old ' +
        'credential is dead rather than orphaned.',
    ),
    grant_revoked_at_google: refused(
      'already_in_that_state',
      'Revoked and needs-reauth are one state to a reader: the token does not work and a human has to ' +
        'reconnect.',
    ),
    check_reached_google: refused('reconnect_first', DEAD_GRANT_READS_NOTHING),
  },
})

/** What happens to a connection in `state` when `event` is observed. Total by construction. */
export function connectionTransition(
  state: GoogleConnectionDisplayState,
  event: ConnectionStateEvent,
): PresentationTransition {
  return CONNECTION_TRANSITIONS[state][event]
}

/**
 * The tone for a state, as a switch with `assertNever` at the end.
 *
 * Deliberately not read off `CONNECTION_STATE_COPY`, although the same value is there. This is the
 * exhaustiveness proof the acceptance asks for in the form the compiler reports best: add a member to
 * `GoogleConnectionDisplayState` and the error names the new state and this function, rather than naming
 * an object literal three files away. The test asserts the two agree, so the duplication cannot rot.
 */
export function connectionToneFor(state: GoogleConnectionDisplayState): ConnectionTone {
  switch (state) {
    case 'never_connected':
      return 'neutral'
    case 'healthy':
      return 'good'
    case 'expiring_soon':
      return 'attention'
    case 'degraded':
      return 'attention'
    case 'pending_gbp_approval':
      return 'attention'
    case 'broken':
      return 'urgent'
    default:
      return assertNever(state, 'connectionToneFor')
  }
}

/**
 * The English name of a capability, for a sentence like *"Permission missing: Search Console"*.
 *
 * docs/10 §4 requires the capability to be named in English rather than by its column value. `gbp_reviews`
 * is a perfectly good identifier and means nothing to the person who has to fix it.
 */
export const CAPABILITY_LABEL: Readonly<Record<GoogleCapability, string>> = Object.freeze({
  gbp_reviews: 'Google reviews',
  gbp_location: 'The Google business listing',
  gbp_performance: 'Business Profile performance figures',
  gsc: 'Search Console',
})

/** What a capability's stored health means, in the words docs/10 §4 uses. */
export const CAPABILITY_HEALTH_LABEL: Readonly<Record<GoogleCapabilityHealth, string>> =
  Object.freeze({
    ok: 'Working',
    permission_missing: 'Permission missing',
    not_verified: 'Listing not verified with Google',
    quota_zero: 'Waiting for Business Profile access',
    unknown: 'Not checked yet',
  })

/**
 * What each requested scope actually lets this system do, in English.
 *
 * A `Record` over `GoogleRequestedScope`, which is a union of two literals — so the table cannot describe
 * a scope the system may not request, and a scope added to that union has no label until somebody writes
 * one.
 *
 * `business.manage` has no read-only variant: the scope that reads reviews also rewrites the address and
 * the opening hours. The label says so, because the consent screen does not and the owner is the person
 * approving it.
 */
export const SCOPE_LABEL: Readonly<Record<GoogleRequestedScope, string>> = Object.freeze({
  [GOOGLE_SCOPE_BUSINESS_MANAGE]:
    'Read and reply to Google reviews, and read and change the business listing. Google offers no ' +
    'read-only version of this permission.',
  [GOOGLE_SCOPE_SEARCH_CONSOLE_READONLY]: 'Read Search Console performance figures. Read-only.',
})

export interface GrantedScopeLabel {
  /** True when the scope is one of the two this system requests. */
  readonly recognised: boolean
  /** The English sentence. Never the scope URL — docs/10 §4. */
  readonly label: string
  /**
   * The scope's last path segment, for an unrecognised scope, so the owner can tell which one it is.
   *
   * The segment and never the URL: the card is asserted to contain no `googleapis.com/auth/` substring
   * anywhere, and a value with no slash in it cannot reintroduce one. It is empty for a recognised scope,
   * where the sentence is the whole answer.
   */
  readonly token: string
}

/**
 * Turns what Google returned into sentences, including for a scope we did not ask for.
 *
 * `granted_scopes` is Google's answer rather than our request: a consent screen where the owner unticks
 * one product returns fewer scopes with an otherwise successful exchange, and a grant can carry more than
 * was asked for if somebody widens the client. Both cases have to be renderable, and neither may be
 * rendered as a URL — so an unrecognised scope gets a sentence saying nothing asks for it, plus its last
 * segment so it can be identified.
 */
export function grantedScopeLabels(scopes: readonly string[]): readonly GrantedScopeLabel[] {
  return scopes.map((scope) => {
    const known = SCOPE_LABEL[scope as GoogleRequestedScope]
    if (known !== undefined) return { recognised: true, label: known, token: '' }
    return {
      recognised: false,
      label:
        'A Google permission this system does not use. Nothing here asks for it, so it can be removed ' +
        'by reconnecting the account.',
      token: scopeToken(scope),
    }
  })
}

/**
 * The last path segment of a scope, or `unnamed`.
 *
 * Trailing slashes are stripped first, so `https://mail.google.com/` — one of the forbidden scopes, and
 * the only one with no path at all — identifies itself as `mail.google.com` rather than as a blank
 * bullet. `unnamed` is for the degenerate values a `text[]` column can still hold: the empty string, and
 * a value that is nothing but slashes.
 */
function scopeToken(scope: string): string {
  const trimmed = scope.replace(/\/+$/u, '')
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return segment === '' ? 'unnamed' : segment
}
