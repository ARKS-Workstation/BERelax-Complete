import {
  ANALYTICS_CONSENT_PURPOSE,
  ANALYTICS_CONSENT_WORDING,
  type AnalyticsConsentDecision,
  type AnalyticsConsentSurface,
  AppError,
  CONSENT_MODE_SIGNALS,
  type ConsentModeSignal,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { CONSENT_SQLSTATE } from './consent.ts'

/**
 * The analytics consent store's writes (A-MEAS-02), over migration 0125.
 *
 * ## Why this is a file of its own and not part of `repositories/consent.ts`
 *
 * The manifest entry names `packages/db/src/repositories/consent.ts` and this is beside it instead. That
 * file is C-CRM-03's: every function in it is keyed on `contact_customer_id`, a CRM identity, and on a
 * `message_channel`. The analytics subject is a web visitor who has no CRM identity and no channel — and
 * `analytics.consent_record` deliberately names no subject at all (0125's header). Putting a
 * subject-less, channel-less record into a repository whose whole shape is contact-and-channel would
 * either widen every signature with nullable arguments or invite a caller to use the wrong one, and a
 * second consent decision reached through the wrong door is exactly the defect this unit is about. The
 * ONE thing the two share — the canonical wording hash — is shared rather than copied: the hash is
 * computed by the database's own `consent_wording_hash()` here too, as `consentWordingHash` in that file
 * records at length.
 *
 * ## Nothing here updates a record, and one thing here updates a SESSION
 *
 * There is no `clearConsent`. A withdrawal is an INSERT with `decision = 'withdrawn'` and the database
 * refuses the alternative for every role (ZY311). What {@link withdrawAnalyticsConsent} does update is
 * `analytics.session`'s four consent columns, and that is not a contradiction: the record is the EVIDENCE
 * of a decision and is immutable, while the session's columns are the OPERATIVE state and have to be able
 * to change, because a visitor who withdraws has changed it.
 *
 * ## The gate is asked once, and the database is what asks it
 *
 * `packages/db` may never import `packages/core` (ADR 0001), where `gateConsent` lives. So
 * {@link enqueueAnalyticsDispatch} does not re-implement the comparison: it calls
 * `dispatch_consent_gap(session, destination)`, which is the same function the ZY312 trigger calls, and
 * writes a `queued` row when the gap is empty and the visible `suppressed` row when it is not. One
 * statement of the gate inside the database, one in `packages/core`, and
 * `packages/fixtures/src/analytics-consent.itest.ts` holds the two equal in both directions.
 */

/** Every reason an analytics consent write is refused, as a value. Callers branch on these. */
export const ANALYTICS_CONSENT_STORE_REFUSALS = [
  /**
   * No `consent_wording` row hashes to the words this tree's banner renders.
   *
   * The refusal a tree whose copy was edited without a new version being published gets, and the whole
   * reason the lookup is by HASH rather than by a version number somebody types: the alternative records
   * a decision against words nobody showed, silently.
   */
  'wording_not_published',
  /** A grant that grants nothing, or a refusal that keeps a signal. Refused by CHECK as well. */
  'decision_shape_invalid',
  /** The snapshot disagrees with the stored version — ZP002, 0056's own trigger, attached to 0125. */
  'wording_hash_mismatch',
  /** A dispatch naming a session or a destination the gate could not read — ZY312. */
  'dispatch_consent_unreadable',
] as const
export type AnalyticsConsentStoreRefusal = (typeof ANALYTICS_CONSENT_STORE_REFUSALS)[number]

/**
 * SQLSTATEs raised on this path, so a caller can tell a tamper from a gate without reading prose.
 *
 * The two 0125 codes are written out. The wording-hash one is IMPORTED from `CONSENT_SQLSTATE` rather than
 * respelled, which `pnpm sqlstate` is what caught: a code is an identity, and a second literal of `ZP002`
 * in this file made the registry entry's translator list wrong — the gate asked for the entry to name both
 * modules, and the better answer was for only one of them to hold the code. 0056 raises it, 0125 attaches
 * 0056's own trigger function, and there is one spelling of the code between them.
 */
export const ANALYTICS_CONSENT_SQLSTATE = {
  recordImmutable: 'ZY311',
  dispatchConsentGate: 'ZY312',
  wordingHashMismatch: CONSENT_SQLSTATE.wordingHashMismatch,
} as const

function refuse(refusal: AnalyticsConsentStoreRefusal, message: string): never {
  throw new AppError('conflict', message, { details: { refusal } })
}

/** The named refusal carried on an error this module raised, or null. */
export function analyticsConsentStoreRefusalOf(err: unknown): AnalyticsConsentStoreRefusal | null {
  if (!(err instanceof AppError)) return null
  const refusal = (err.details as { refusal?: unknown } | undefined)?.refusal
  return typeof refusal === 'string' &&
    (ANALYTICS_CONSENT_STORE_REFUSALS as readonly string[]).includes(refusal)
    ? (refusal as AnalyticsConsentStoreRefusal)
    : null
}

const sqlstateOf = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

export interface AnalyticsConsentCapture {
  readonly decision: AnalyticsConsentDecision
  /** The signals GRANTED. Everything not in here is denied; there is one spelling for that. */
  readonly granted: readonly ConsentModeSignal[]
  readonly locale: 'en' | 'ar'
  readonly surface: AnalyticsConsentSurface
  /** When the visitor decided. Supplied, never defaulted: every ordering assertion is frozen-clock. */
  readonly decidedAtIso: string
}

/** Four booleans in the column order 0125 declares, from the set of granted signals. */
function signalFlags(granted: readonly ConsentModeSignal[]): Record<ConsentModeSignal, boolean> {
  const set = new Set(granted)
  return {
    ad_storage: set.has('ad_storage'),
    ad_user_data: set.has('ad_user_data'),
    ad_personalization: set.has('ad_personalization'),
    analytics_storage: set.has('analytics_storage'),
  }
}

/**
 * Writes one analytics consent record, against the wording version whose words the banner renders.
 *
 * The wording row is resolved **by the hash of {@link ANALYTICS_CONSENT_WORDING}'s bytes**, computed by
 * the database's own `consent_wording_hash()`. Three things follow and all three are the point:
 *
 *   - the record always references the version whose text is byte-identical to what was rendered, so
 *     `assert_consent_wording_hash` (ZP002) can only fire if the row was tampered with after the lookup;
 *   - a tree whose copy was edited without publishing a new version finds no row and is refused by name,
 *     rather than recording consent against words nobody showed;
 *   - there is no version NUMBER anywhere in this path, so there is nothing to keep in step with the copy.
 *
 * The snapshot is written as the function's own result rather than read back from the row and re-sent. A
 * caller that read `content_hash` out of the row and inserted it would make the trigger vacuous — the two
 * values would be the same value — which is the mistake `repositories/consent.ts` warns about one subject
 * along.
 */
export async function recordAnalyticsConsent(
  sql: Sql,
  capture: AnalyticsConsentCapture,
): Promise<{ readonly consentRecordId: string }> {
  const flags = signalFlags(capture.granted)
  const anyGranted = CONSENT_MODE_SIGNALS.some((signal) => flags[signal])
  if (capture.decision === 'granted' && !anyGranted) {
    refuse(
      'decision_shape_invalid',
      'A grant that grants no signal is a denial wearing the wrong name, and recording it as a grant ' +
        'would report a consent rate this build did not earn.',
    )
  }
  if (capture.decision !== 'granted' && anyGranted) {
    refuse(
      'decision_shape_invalid',
      `A ${capture.decision} record may not claim a granted signal: keeping one is a NEW GRANT of it and ` +
        'has to be recorded as one, or the log says somebody opted out while the gate goes on opening.',
    )
  }

  try {
    const rows = await sql<{ consent_record_id: string }[]>`
      insert into analytics.consent_record (
        decision,
        consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
        consent_analytics_storage,
        consent_wording_id, wording_hash, decided_at, capture_locale, capture_surface
      )
      select
        ${capture.decision}::analytics.consent_decision,
        ${flags.ad_storage}, ${flags.ad_user_data}, ${flags.ad_personalization},
        ${flags.analytics_storage},
        w.id,
        consent_wording_hash(
          ${ANALYTICS_CONSENT_WORDING.textEn}, ${ANALYTICS_CONSENT_WORDING.textAr}
        ),
        ${capture.decidedAtIso}::timestamptz,
        ${capture.locale},
        ${capture.surface}
        from consent_wording w
       where w.purpose = ${ANALYTICS_CONSENT_PURPOSE}
         and w.content_hash = consent_wording_hash(
               ${ANALYTICS_CONSENT_WORDING.textEn}, ${ANALYTICS_CONSENT_WORDING.textAr}
             )
      returning consent_record_id
    `
    const row = rows[0]
    if (row === undefined) {
      // The `select` matched nothing, so no row was inserted and nothing raised. This is the
      // edited-copy case, and it is the one failure here that is silent in every other design.
      refuse(
        'wording_not_published',
        `No consent_wording row for purpose ${ANALYTICS_CONSENT_PURPOSE} hashes to the words this ` +
          "banner renders, so there is no version to record the decision against. The banner's copy has " +
          'been changed without a new version being published; publish one rather than editing version 1, ' +
          'which consent_wording refuses anyway (ZP001).',
      )
    }
    return { consentRecordId: row.consent_record_id }
  } catch (error) {
    if (sqlstateOf(error) === ANALYTICS_CONSENT_SQLSTATE.wordingHashMismatch) {
      refuse(
        'wording_hash_mismatch',
        'The wording version this record snapshots does not hash to its own stored text, so the words ' +
          'the record claims were shown are not the words stored.',
      )
    }
    throw error
  }
}

/** How many of each kind of record there are. The consented SHARE A-FIRST-10 publishes starts here. */
export async function analyticsConsentCounts(
  sql: Sql,
): Promise<Readonly<Record<AnalyticsConsentDecision, number>>> {
  const rows = await sql<{ decision: AnalyticsConsentDecision; n: string }[]>`
    select decision::text as decision, count(*)::text as n
      from analytics.consent_record group by decision
  `
  const counts: Record<AnalyticsConsentDecision, number> = {
    granted: 0,
    denied: 0,
    withdrawn: 0,
  }
  for (const row of rows) counts[row.decision] = Number(row.n)
  return counts
}

export interface DispatchEnqueueResult {
  readonly dispatchId: string
  readonly state: 'queued' | 'suppressed'
  readonly reason: 'consent_denied' | null
  /** The required signals the session did not grant, sorted. Empty exactly when queued. */
  readonly missing: readonly string[]
  /**
   * True when a row for this `(event_id, destination)` was ALREADY there and nothing was written.
   *
   * A-MEAS-03's acceptance line "replaying the outbox event twice writes no second dispatch" is this
   * field, and the mechanism behind it is the unique index 0137 adds rather than a check in the caller:
   * the second insert conflicts whichever call site makes it. Reported rather than swallowed, because a
   * replay that was absorbed and a dispatch that was newly enqueued are different facts and a consumer
   * counting pushes must not count the first.
   *
   * The state returned is then the EXISTING row's — read back, not assumed — so a replay of an event
   * whose first dispatch was suppressed does not report itself as newly queued.
   */
  readonly alreadyPresent: boolean
}

/**
 * Enqueues one dispatch, or records why it was not enqueued.
 *
 * **One statement, and the gate is inside it.** `dispatch_consent_gap` is the same function the ZY312
 * trigger calls, so the state this writes and the state the trigger would permit cannot disagree: if the
 * gap is empty the row is `queued` and the trigger lets it through; if it is not, the row is `suppressed`
 * with `reason = 'consent_denied'` and the trigger ignores it by design. There is no round trip to decide
 * the state and therefore no window in which the session's consent could change between the decision and
 * the write.
 *
 * `cardinality(...) = 0` and never `array_length(..., 1) > 0`: the latter is NULL for an empty array, and
 * a NULL condition in a `case` falls to the `else` — which here would be the permitted branch. That is a
 * one-character fail-open and it is the kind this unit's gate block plants deliberately.
 *
 * A session or a destination the gate cannot read RAISES (ZY312) and is translated to
 * `dispatch_consent_unreadable` rather than becoming a suppression. A suppression says "this visitor said
 * no", and saying that about a row nobody could judge would be a false record of somebody's choice.
 */
export async function enqueueAnalyticsDispatch(
  sql: Sql,
  input: {
    readonly sessionId: string
    readonly destination: string
    readonly funnelStage: string
    readonly decidedAtIso: string
    /**
     * The shared event identity (0137, A-MEAS-03), derived by `analyticsEventId` in `@berelax/analytics`.
     *
     * An argument rather than something this function mints, and that is ADR 0001 rather than a
     * preference: `packages/db` may not import `packages/core`, where the derivation's inputs live, and
     * a second derivation here would be the second statement of an identity the on-page tag also
     * computes — which is the one fact that must be identical on both surfaces.
     */
    readonly eventId: string
    /** The serialised egress payload, from `dispatchPayloadBytes`. Stored so A-MEAS-07 has both sides. */
    readonly payload: string
    /**
     * Where the conversion happened, from `BOOKING_SOURCE_ACTION_SOURCE` in `@berelax/analytics`.
     *
     * An argument because the ENQUEUER knows and the consumer cannot: nothing in this schema links an
     * analytics session to the booking it produced (A-FIRST-08 owns attribution, A-FIRST-09 the funnel
     * materialisation), so a consumer that derived it would be deriving it from nothing. Mapped by the
     * caller rather than here, because `packages/db` may not import the mapping's home.
     */
    readonly actionSource: string
    /**
     * When the conversion HAPPENED, which for an offline upload is days before `decidedAtIso`.
     *
     * Separate from the decision instant because a platform dates the conversion on this value and every
     * attribution window is measured from it. The table refuses one after the decision, which is also
     * what refuses a future instant.
     */
    readonly occurredAtIso: string
  },
): Promise<DispatchEnqueueResult> {
  try {
    const rows = await sql<
      { dispatch_id: string; state: string; reason: string | null; missing: string[] }[]
    >`
      with gap as (
        select dispatch_consent_gap(${input.sessionId}::uuid, ${input.destination}) as missing
      )
      insert into analytics_dispatch (
        session_id, destination, funnel_stage, state, reason, decided_at, event_id, payload,
        action_source, occurred_at
      )
      select
        ${input.sessionId}::uuid,
        ${input.destination},
        ${input.funnelStage}::analytics.funnel_step_name,
        case when cardinality(gap.missing) = 0
             then 'queued'::analytics_dispatch_state
             else 'suppressed'::analytics_dispatch_state end,
        case when cardinality(gap.missing) = 0 then null else 'consent_denied' end,
        ${input.decidedAtIso}::timestamptz,
        ${input.eventId},
        ${input.payload}::jsonb,
        ${input.actionSource},
        ${input.occurredAtIso}::timestamptz
        from gap
      -- The replay. DO NOTHING and not DO UPDATE: the first row is the record of what was decided
      -- about this conversion, and overwriting it with a second decision would lose the first, which is
      -- the whole of A-MEAS-07's comparison.
      on conflict (event_id, destination) do nothing
      returning dispatch_id, state::text as state, reason,
                (select missing from gap) as missing
    `
    const row = rows[0]
    if (row === undefined) {
      /*
       * Nothing was inserted, which with `on conflict do nothing` means a row for this
       * `(event_id, destination)` was already there. The EXISTING row is read back rather than its state
       * being assumed: a replay of an event whose first dispatch was suppressed must not report itself as
       * newly queued, and a caller that counted it as a push would count a conversion that never went out.
       */
      const existing = await sql<{ dispatch_id: string; state: string; reason: string | null }[]>`
        select dispatch_id, state::text as state, reason
          from analytics_dispatch
         where event_id = ${input.eventId} and destination = ${input.destination}
      `
      const present = existing[0]
      if (present === undefined) {
        throw new AppError(
          'invariant_violated',
          'analytics_dispatch inserted no row and no row for that (event_id, destination) exists, so ' +
            'whether the dispatch was enqueued is unknown. The unique index 0137 creates is the only ' +
            'reason the insert can be a no-op.',
          { details: { eventId: input.eventId, destination: input.destination } },
        )
      }
      return {
        dispatchId: present.dispatch_id,
        state: present.state === 'queued' ? 'queued' : 'suppressed',
        reason: present.reason === 'consent_denied' ? 'consent_denied' : null,
        missing: [],
        alreadyPresent: true,
      }
    }
    return {
      dispatchId: row.dispatch_id,
      state: row.state === 'queued' ? 'queued' : 'suppressed',
      reason: row.reason === 'consent_denied' ? 'consent_denied' : null,
      missing: [...row.missing].sort(),
      alreadyPresent: false,
    }
  } catch (error) {
    if (sqlstateOf(error) === ANALYTICS_CONSENT_SQLSTATE.dispatchConsentGate) {
      refuse(
        'dispatch_consent_unreadable',
        'The consent state for this dispatch could not be read — the session or the destination has no ' +
          'row — so it is refused rather than suppressed: a suppression says a visitor said no, and ' +
          "saying that about a row nobody could judge would be a false record of somebody's choice.",
      )
    }
    throw error
  }
}

export interface WithdrawalResult {
  readonly consentRecordId: string
  /** Sessions whose four consent columns were cleared. This is what blocks every FUTURE dispatch. */
  readonly sessionsCleared: number
  /** Dispatches that were queued-but-unsent and are now `cancelled_consent_withdrawn`. */
  readonly dispatchesCancelled: number
}

/**
 * Records a withdrawal, cancels what is queued, and blocks what would be queued next.
 *
 * Three statements, one transaction, and the ORDER is the design:
 *
 *   1. **Cancel every `queued` dispatch for the visitor's sessions.** `state = 'queued'` is the whole
 *      predicate, so a dispatch already `sent` is left exactly as it is — a transmission that happened
 *      cannot be un-happened, and a row rewritten to claim otherwise would be a false record. The
 *      `transmitted_at is null` half is enforced by the table's own CHECK rather than repeated here.
 *   2. **Clear the four consent columns on every one of the visitor's sessions.** This is what "blocks
 *      future ones" means: the ZY312 trigger reads those columns, so after this no row can reach `queued`
 *      or `sent` for any of those sessions, from any caller, in any role. It is also why step 1 has to
 *      come first — with the columns already false, the UPDATE in step 1 would be refused by the trigger,
 *      because `cancelled_consent_withdrawn` is reached from `queued` and the trigger reads NEW.state,
 *      not OLD's.
 *   3. **Insert the withdrawal record**, which is the evidence, carrying no granted signal at all.
 *
 * A visitor with no sessions is not an error: a device whose consent cookie survived its visitor cookie
 * has nothing identified to cancel, and the withdrawal is still recorded. The counts are returned so a
 * caller — and the suite — can tell the two cases apart rather than inferring.
 */
export async function withdrawAnalyticsConsent(
  sql: Sql,
  input: {
    readonly visitorId: string | null
    readonly locale: 'en' | 'ar'
    readonly surface: AnalyticsConsentSurface
    readonly decidedAtIso: string
  },
): Promise<WithdrawalResult> {
  return await sql.begin(async (tx) => {
    let dispatchesCancelled = 0
    let sessionsCleared = 0
    if (input.visitorId !== null) {
      const cancelled = await tx<{ dispatch_id: string }[]>`
        update analytics_dispatch
           set state = 'cancelled_consent_withdrawn', reason = 'consent_withdrawn'
         where state = 'queued'
           and session_id in (
             select session_id from analytics.session where visitor_id = ${input.visitorId}::uuid
           )
        returning dispatch_id
      `
      dispatchesCancelled = cancelled.length

      const cleared = await tx<{ session_id: string }[]>`
        update analytics.session
           set consent_ad_storage = false,
               consent_ad_user_data = false,
               consent_ad_personalization = false,
               consent_analytics_storage = false
         where visitor_id = ${input.visitorId}::uuid
        returning session_id
      `
      sessionsCleared = cleared.length
    }
    const record = await recordAnalyticsConsent(tx as unknown as Sql, {
      decision: 'withdrawn',
      granted: [],
      locale: input.locale,
      surface: input.surface,
      decidedAtIso: input.decidedAtIso,
    })
    return { consentRecordId: record.consentRecordId, sessionsCleared, dispatchesCancelled }
  })
}

/**
 * The four signal columns a session holds, for the gate to read.
 *
 * Returns the row as the database spells it — `consent_ad_storage` and not `consentAdStorage` — because
 * `consentStateFromSessionRow` in `packages/core` keys on the COLUMN names through
 * `SESSION_CONSENT_COLUMNS`, which is the one place a Consent Mode signal meets this schema's spelling.
 * Re-casing them here would be a second mapping, and a second mapping that disagreed would read every
 * signal as denied while every test about suppression still passed.
 */
export async function sessionConsentRow(
  sql: Sql,
  sessionId: string,
): Promise<Readonly<Record<string, boolean>> | null> {
  const rows = await sql<
    {
      consent_ad_storage: boolean
      consent_ad_user_data: boolean
      consent_ad_personalization: boolean
      consent_analytics_storage: boolean
    }[]
  >`
    select consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
           consent_analytics_storage
      from analytics.session where session_id = ${sessionId}::uuid
  `
  return rows[0] ?? null
}
