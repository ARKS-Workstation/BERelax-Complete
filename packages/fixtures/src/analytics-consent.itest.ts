import { analyticsEventId, dispatchPayloadBytes } from '@berelax/analytics'
import {
  buildEgressPayload,
  CONSENT_GATED_TARGET_IDS,
  consentGatedTarget,
  consentStateFromSessionRow,
  gateConsent,
  SESSION_CONSENT_COLUMNS,
} from '@berelax/core'
import {
  ANALYTICS_CONSENT_SQLSTATE,
  analyticsConsentCounts,
  analyticsConsentStoreRefusalOf,
  createConnection,
  enqueueAnalyticsDispatch,
  recordAnalyticsConsent,
  type Sql,
  sessionConsentRow,
  withdrawAnalyticsConsent,
} from '@berelax/db'
import {
  ANALYTICS_CONSENT_PURPOSE,
  ANALYTICS_CONSENT_WORDING,
  CONSENT_MODE_SIGNALS,
  type ConsentModeSignal,
  type FunnelStage,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The two fields migration 0137 (A-MEAS-03) made NOT NULL on `analytics_dispatch`.
 *
 * This file's subject is the GATE and not the transport, so the identity and the payload are supplied the
 * way the real consumer supplies them rather than with placeholders: `analyticsEventId` is the same pure
 * derivation the on-page tag uses, and the payload is a real branded `EgressPayload` serialised by the one
 * serialiser. A literal string in either place would have made these cases pass against a column whose
 * shape nothing checks — and `payload` is `jsonb`, so a non-JSON placeholder would have failed anyway for
 * a reason that had nothing to do with consent.
 *
 * The event id is derived from the SESSION rather than from a booking, which is what keeps the cases
 * independent: the unique index is on `(event_id, destination)`, so two cases enqueuing the same stage to
 * the same destination would collide on the second if the id did not vary with the fixture's own session.
 */
const dispatchEventId = (sessionId: string, stage: FunnelStage): string =>
  analyticsEventId({ kind: 'booking', aggregateId: sessionId, stage })

/**
 * The action source and the conversion instant 0137 also made NOT NULL.
 *
 * `'website'` and the fixture's own frozen instant, because this file's subject is the GATE: every case
 * here is about which signals permit a dispatch, and the channel a booking came through has nothing to do
 * with that. `occurredAtIso` is the same instant as `decidedAtIso`, which the table's
 * `occurred_at <= decided_at` CHECK admits and which is what a LIVE conversion looks like — an offline
 * upload's earlier instant is A-MEAS-05's subject.
 */
const dispatchPayload = (stage: FunnelStage): string =>
  dispatchPayloadBytes(
    buildEgressPayload({ ref: { kind: 'package_template' }, eventType: stage, quantity: 1 })
      .payload,
  )

/**
 * The analytics consent store and the dispatch gate, against a real PostgreSQL (A-MEAS-02).
 *
 * ## Why this file is in `packages/fixtures` and could be nowhere else
 *
 * It holds `CONSENT_GATED_TARGETS` from `@berelax/core` against `analytics_dispatch_destination` as the
 * DATABASE holds it, and `SESSION_CONSENT_COLUMNS` against the columns `analytics.session` actually has.
 * `packages/db` may never import `packages/core` (ADR 0001) and `packages/core` may reach no
 * infrastructure, so `packages/fixtures` is the only package that may hold both — brief rule 4's own
 * reason for it existing.
 *
 * Those two equalities are the load-bearing cases in the file, because they are the ones that fail
 * silently. A mapping edited in core and not in the migration leaves the pure gate refusing a dispatch
 * the trigger permits, or the reverse; a renamed session column makes every `SESSION_CONSENT_COLUMNS`
 * lookup `undefined`, so every signal reads as denied, every dispatch is suppressed, and every test about
 * suppression passes.
 *
 * ## What it deletes, and the one table it cannot
 *
 * It creates its own visitors and deletes them (ADR 0050); sessions and dispatch rows go with them by
 * `on delete cascade`, which is the arrangement 0125 chose. `analytics.consent_record` is APPEND-ONLY and
 * nothing here deletes from it — brief rule 9 — so every assertion about it is a DELTA taken across the
 * work, never a total. A total would pass on a fresh database and fail on the second run of this file.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/** Visitors this file created, removed in `afterAll`. Sessions and dispatches cascade from them. */
const createdVisitors: string[] = []

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
})

afterAll(async () => {
  if (sql !== undefined && createdVisitors.length > 0) {
    await sql`delete from analytics.visitor where visitor_id = any(${createdVisitors}::uuid[])`
  }
  await sql?.end({ timeout: 5 })
})

/**
 * A session with a stated consent claim, filed on a seeded trading day.
 *
 * `started_at` is the business day's own `opens_at`, because `analytics.assert_session_trading_basis`
 * (ZY222) holds the basis against `business_day`'s stored window in both directions — a fixture session
 * whose instant had nothing to do with its trading date was always a nonsense row and is now a refused
 * one. The day is the one NEAREST now rather than the one containing now, which is A-FIRST-05's own fix
 * for a suite that otherwise fails depending on the hour it runs in.
 */
async function sessionWith(
  granted: readonly ConsentModeSignal[],
): Promise<{ readonly visitorId: string; readonly sessionId: string }> {
  const set = new Set(granted)
  const [visitor] = await sql<{ visitor_id: string }[]>`
    insert into analytics.visitor (first_seen_at, last_seen_at) values (now(), now())
    returning visitor_id
  `
  const visitorId = visitor?.visitor_id as string
  createdVisitors.push(visitorId)
  const [session] = await sql<{ session_id: string }[]>`
    insert into analytics.session (
      visitor_id, started_at, last_event_at, trading_date, trading_date_basis, landing_path,
      device_kind, breakpoint, bot,
      consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
      consent_analytics_storage
    )
    select ${visitorId}::uuid, b.opens_at, b.opens_at, b.trading_date, 'trading', '/en/consent-fixture',
           'desktop', 'lg', false,
           ${set.has('ad_storage')}, ${set.has('ad_user_data')},
           ${set.has('ad_personalization')}, ${set.has('analytics_storage')}
      from public.business_day b
     order by abs(extract(epoch from (b.opens_at - now())))
     limit 1
    returning session_id
  `
  return { visitorId, sessionId: session?.session_id as string }
}

const AT = '2026-10-02T09:00:00.000Z'

// ------------------------------------------------------------------------------------------------
// The wording version, and the hash that ties a record to the words that were shown
// ------------------------------------------------------------------------------------------------

describe("the banner's wording version", () => {
  it('holds the exact bytes the banner renders, which the migration published', () => {
    // Asserted here and not only in a pure test, because the two statements of the copy are the shared
    // constant and migration 0125's INSERT, and only a database can compare them.
    return sql<{ text_en: string; text_ar: string; version: number; is_provisional: boolean }[]>`
      select text_en, text_ar, version, is_provisional
        from consent_wording where purpose = ${ANALYTICS_CONSENT_PURPOSE} order by version
    `.then((rows) => {
      expect(rows.length, 'the migration published no analytics wording version').toBeGreaterThan(0)
      const first = rows[0]
      expect(first?.text_en).toBe(ANALYTICS_CONSENT_WORDING.textEn)
      expect(first?.text_ar).toBe(ANALYTICS_CONSENT_WORDING.textAr)
      expect(first?.version).toBe(1)
      // Flagged provisional, because the copy is legal text and this build has seen none.
      expect(first?.is_provisional).toBe(true)
    })
  })

  it('hashes to the bytes the banner renders, and to nothing else', async () => {
    const [row] = await sql<{ stored: string; computed: string; perturbed: string }[]>`
      select encode(w.content_hash, 'hex') as stored,
             encode(consent_wording_hash(
               ${ANALYTICS_CONSENT_WORDING.textEn}, ${ANALYTICS_CONSENT_WORDING.textAr}
             ), 'hex') as computed,
             encode(consent_wording_hash(
               ${`${ANALYTICS_CONSENT_WORDING.textEn} `}, ${ANALYTICS_CONSENT_WORDING.textAr}
             ), 'hex') as perturbed
        from consent_wording w
       where w.purpose = ${ANALYTICS_CONSENT_PURPOSE} and w.version = 1
    `
    expect(row?.computed).toBe(row?.stored)
    /*
     * **The hash changes when the banner copy changes.**
     *
     * One trailing space is the smallest edit anybody makes by accident, and it moves the hash. That is
     * the acceptance line, and the consequence is the half worth having: the lookup
     * `recordAnalyticsConsent` performs is BY this hash, so a tree whose copy was edited without a new
     * version being published finds no wording row at all and every write is refused by name — rather
     * than recording a decision against words nobody read.
     */
    expect(row?.perturbed).not.toBe(row?.stored)
    const [absent] = await sql<{ n: string }[]>`
      select count(*)::text as n from consent_wording
       where purpose = ${ANALYTICS_CONSENT_PURPOSE}
         and content_hash = consent_wording_hash(
               ${`${ANALYTICS_CONSENT_WORDING.textEn} `}, ${ANALYTICS_CONSENT_WORDING.textAr}
             )
    `
    expect(absent?.n).toBe('0')
    // The control: the real bytes DO find a row, so the zero above is about the perturbation and not
    // about a query that matches nothing.
    const [present] = await sql<{ n: string }[]>`
      select count(*)::text as n from consent_wording
       where purpose = ${ANALYTICS_CONSENT_PURPOSE}
         and content_hash = consent_wording_hash(
               ${ANALYTICS_CONSENT_WORDING.textEn}, ${ANALYTICS_CONSENT_WORDING.textAr}
             )
    `
    expect(present?.n).toBe('1')
  })
})

// ------------------------------------------------------------------------------------------------
// The record: append-only, shape-constrained, and a delta rather than a total
// ------------------------------------------------------------------------------------------------

describe('the analytics consent record', () => {
  it('records a grant, a denial and a withdrawal, each as its own row', async () => {
    const before = await analyticsConsentCounts(sql)
    await recordAnalyticsConsent(sql, {
      decision: 'granted',
      granted: [...CONSENT_MODE_SIGNALS],
      locale: 'en',
      surface: 'consent_banner',
      decidedAtIso: AT,
    })
    await recordAnalyticsConsent(sql, {
      decision: 'denied',
      granted: [],
      locale: 'ar',
      surface: 'consent_banner',
      decidedAtIso: AT,
    })
    await recordAnalyticsConsent(sql, {
      decision: 'withdrawn',
      granted: [],
      locale: 'en',
      surface: 'consent_banner',
      decidedAtIso: AT,
    })
    const after = await analyticsConsentCounts(sql)
    // DELTAS. The table is append-only and this file cannot clear it, so a total would pass once.
    expect(after.granted - before.granted).toBe(1)
    expect(after.denied - before.denied).toBe(1)
    expect(after.withdrawn - before.withdrawn).toBe(1)
  })

  it('stores a wording version and a timestamptz on every row, with no exception', async () => {
    // The acceptance line's own words. Asserted over EVERY row in the table rather than the one just
    // written, because the claim is about the column rather than about this insert — and the columns are
    // NOT NULL, so the only way this fails is a migration that relaxed them.
    const [row] = await sql<{ n: string; missing: string }[]>`
      select count(*)::text as n,
             count(*) filter (
               where consent_wording_id is null or wording_hash is null or decided_at is null
             )::text as missing
        from analytics.consent_record
    `
    expect(Number(row?.n)).toBeGreaterThan(0)
    expect(row?.missing).toBe('0')
    // And `decided_at` really is a timestamptz rather than a naive timestamp, which `pnpm db:conventions`
    // also refuses — read from the catalogue so this is a fact about the column and not about a value.
    const [type] = await sql<{ data_type: string }[]>`
      select format_type(a.atttypid, a.atttypmod) as data_type
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'analytics' and c.relname = 'consent_record' and a.attname = 'decided_at'
    `
    expect(type?.data_type).toBe('timestamp with time zone')
  })

  it('refuses an UPDATE and a DELETE, by ZY311, for the owner as well', async () => {
    const [row] = await sql<{ consent_record_id: string }[]>`
      select consent_record_id from analytics.consent_record order by created_at desc limit 1
    `
    const id = row?.consent_record_id as string
    for (const statement of [
      sql`update analytics.consent_record set capture_locale = 'ar' where consent_record_id = ${id}::uuid`,
      sql`delete from analytics.consent_record where consent_record_id = ${id}::uuid`,
    ]) {
      await expect(statement).rejects.toMatchObject({
        code: ANALYTICS_CONSENT_SQLSTATE.recordImmutable,
      })
    }
    // The row survived both, which is the fact the refusal is for.
    const [still] = await sql<{ n: string }[]>`
      select count(*)::text as n from analytics.consent_record where consent_record_id = ${id}::uuid
    `
    expect(still?.n).toBe('1')
  })

  it('refuses a grant that grants nothing and a refusal that keeps a signal, at both layers', async () => {
    // The repository refuses first, by name, which is what a caller reads.
    await expect(
      recordAnalyticsConsent(sql, {
        decision: 'granted',
        granted: [],
        locale: 'en',
        surface: 'consent_banner',
        decidedAtIso: AT,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => analyticsConsentStoreRefusalOf(error) === 'decision_shape_invalid',
    )
    await expect(
      recordAnalyticsConsent(sql, {
        decision: 'withdrawn',
        granted: ['ad_storage'],
        locale: 'en',
        surface: 'consent_banner',
        decidedAtIso: AT,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => analyticsConsentStoreRefusalOf(error) === 'decision_shape_invalid',
    )
    /*
     * And the database refuses the same two shapes on its own, which is the half that holds when the
     * write arrives from a psql session or a call site that never heard of the repository. The
     * duplication is deliberate and `repositories/consent.ts` states why.
     */
    const direct = (decision: string, flags: readonly boolean[]) => sql`
      insert into analytics.consent_record (
        decision, consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
        consent_analytics_storage, consent_wording_id, wording_hash, decided_at, capture_locale,
        capture_surface
      )
      select ${decision}::analytics.consent_decision,
             ${flags[0] as boolean}, ${flags[1] as boolean}, ${flags[2] as boolean},
             ${flags[3] as boolean},
             w.id, w.content_hash, ${AT}::timestamptz, 'en', 'consent_banner'
        from consent_wording w
       where w.purpose = ${ANALYTICS_CONSENT_PURPOSE} and w.version = 1
    `
    await expect(direct('granted', [false, false, false, false])).rejects.toMatchObject({
      constraint_name: 'consent_record_grant_grants_something',
    })
    await expect(direct('denied', [true, false, false, false])).rejects.toMatchObject({
      constraint_name: 'consent_record_refusal_grants_nothing',
    })
  })

  it('refuses a snapshot that disagrees with the version it names, by ZP002', async () => {
    // 0056's own trigger, attached to this table rather than copied. Without it a record could name
    // version 1 and claim the hash of something else, and the words the record proves would be a value.
    await expect(
      sql`
        insert into analytics.consent_record (
          decision, consent_ad_storage, consent_ad_user_data, consent_ad_personalization,
          consent_analytics_storage, consent_wording_id, wording_hash, decided_at, capture_locale,
          capture_surface
        )
        select 'granted'::analytics.consent_decision, true, false, false, true,
               w.id, sha256('not the wording'::bytea), ${AT}::timestamptz, 'en', 'consent_banner'
          from consent_wording w
         where w.purpose = ${ANALYTICS_CONSENT_PURPOSE} and w.version = 1
      `,
    ).rejects.toMatchObject({ code: ANALYTICS_CONSENT_SQLSTATE.wordingHashMismatch })
  })

  it('is on the retention list, which is what stops the whole pass', async () => {
    // 0096 raises ZY062 for a base table in `analytics` with no `retention_policy` row, so this is not
    // paperwork: without it the nightly retention pass stops rather than retaining a new table for ever.
    const [policy] = await sql<{ policy: string; reason: string }[]>`
      select policy, reason from analytics.retention_policy where relation_name = 'consent_record'
    `
    expect(policy?.policy).toBe('keep_indefinitely')
    expect(policy?.reason.length).toBeGreaterThan(40)
  })
})

// ------------------------------------------------------------------------------------------------
// The two tables that must agree with `packages/core`, which is why this file is here
// ------------------------------------------------------------------------------------------------

describe('the gate stated in core and the gate stated in the database', () => {
  it('agree about every server destination, in both directions', async () => {
    const rows = await sql<
      {
        destination: string
        requires_ad_storage: boolean
        requires_ad_user_data: boolean
        requires_ad_personalization: boolean
        requires_analytics_storage: boolean
      }[]
    >`select * from analytics_dispatch_destination order by destination`
    const fromDatabase = new Map<string, ReadonlySet<ConsentModeSignal>>(
      rows.map((row) => {
        // Spelled out rather than indexed by `requires_${signal}`, which needs a cast to compile and
        // would then silently read `undefined` — and `undefined !== true` is the FALSE branch, so a
        // renamed column would make every destination look as though it required nothing. The names are
        // written once each here and held against the catalogue by the case below.
        const required = new Set<ConsentModeSignal>()
        if (row.requires_ad_storage) required.add('ad_storage')
        if (row.requires_ad_user_data) required.add('ad_user_data')
        if (row.requires_ad_personalization) required.add('ad_personalization')
        if (row.requires_analytics_storage) required.add('analytics_storage')
        return [row.destination, required]
      }),
    )
    const fromCore = new Map<string, ReadonlySet<ConsentModeSignal>>(
      CONSENT_GATED_TARGET_IDS.filter(
        (id) => consentGatedTarget(id)?.surface === 'server_dispatch',
      ).map((id) => [id, new Set(consentGatedTarget(id)?.requires ?? [])]),
    )
    // Direction 1: every destination the database gates is one core knows about, with the same set.
    // Direction 2: every server target core knows about has a row. A set comparison does both at once,
    // and both matter — a row with no core entry is an ungated destination from the pure gate's point of
    // view, and a core entry with no row cannot be written to the table at all (the foreign key).
    expect([...fromDatabase.keys()].toSorted()).toEqual([...fromCore.keys()].toSorted())
    for (const [destination, required] of fromCore) {
      expect(
        [...(fromDatabase.get(destination) ?? [])].toSorted(),
        `${destination} requires a different set in the database than in core`,
      ).toEqual([...required].toSorted())
    }
    // The control: there is more than one destination and they do NOT all require the same signals, so
    // the comparison above is about a mapping rather than about one value repeated.
    expect(fromCore.size).toBeGreaterThan(1)
    expect(new Set([...fromCore.values()].map((set) => [...set].toSorted().join(','))).size).toBe(
      fromCore.size,
    )
  })

  it('agree about which column each signal is recorded in', async () => {
    const columns = await sql<{ attname: string }[]>`
      select a.attname
        from pg_attribute a
        join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'analytics' and c.relname = 'session'
         and a.attnum > 0 and not a.attisdropped and a.attname like 'consent_%'
       order by a.attname
    `
    // The silent failure this is for: a renamed column makes every `SESSION_CONSENT_COLUMNS` lookup
    // `undefined`, so `consentStateFromSessionRow` reads every signal as denied, every dispatch is
    // suppressed, and every test about suppression goes on passing.
    expect(columns.map((column) => column.attname)).toEqual(
      CONSENT_MODE_SIGNALS.map((signal) => SESSION_CONSENT_COLUMNS[signal]).toSorted(),
    )
  })

  it('agree on a real session: the pure gate and the database reach the same verdict', async () => {
    const { sessionId } = await sessionWith(['analytics_storage'])
    const row = await sessionConsentRow(sql, sessionId)
    const state = consentStateFromSessionRow(row)
    expect([...state]).toEqual(['analytics_storage'])
    for (const destination of CONSENT_GATED_TARGET_IDS.filter(
      (id) => consentGatedTarget(id)?.surface === 'server_dispatch',
    )) {
      const pure = gateConsent({ target: destination, state })
      const [gap] = await sql<{ missing: string[] }[]>`
        select dispatch_consent_gap(${sessionId}::uuid, ${destination}) as missing
      `
      // The same question, asked of the pure table and of the database's own function. They are two
      // statements of one mapping, and this is the comparison that makes the duplication safe.
      expect([...(gap?.missing ?? [])].toSorted(), destination).toEqual(
        [...pure.missing].toSorted(),
      )
      expect((gap?.missing ?? []).length === 0, destination).toBe(pure.permitted)
    }
    // The control: this session makes the two destinations disagree, so the loop above compared a
    // permitted verdict and a refused one rather than two refusals.
    const verdicts = CONSENT_GATED_TARGET_IDS.filter(
      (id) => consentGatedTarget(id)?.surface === 'server_dispatch',
    ).map((id) => gateConsent({ target: id, state }).permitted)
    expect(verdicts).toContain(true)
    expect(verdicts).toContain(false)
  })
})

// ------------------------------------------------------------------------------------------------
// The dispatch gate: a suppression is a ROW, and the database refuses the alternative
// ------------------------------------------------------------------------------------------------

describe('enqueueing a dispatch', () => {
  it('queues what consent permits and SUPPRESSES what it does not, visibly', async () => {
    const { sessionId } = await sessionWith(['analytics_storage'])
    const permitted = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'analytics_measurement_push',
      funnelStage: 'booking_created',
      decidedAtIso: AT,
      eventId: dispatchEventId(sessionId, 'booking_created'),
      payload: dispatchPayload('booking_created'),
      actionSource: 'website',
      occurredAtIso: AT,
    })
    expect(permitted).toMatchObject({ state: 'queued', reason: null, missing: [] })

    const refused = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'advertising_conversion_push',
      funnelStage: 'booking_created',
      decidedAtIso: AT,
      eventId: dispatchEventId(sessionId, 'booking_created'),
      payload: dispatchPayload('booking_created'),
      actionSource: 'website',
      occurredAtIso: AT,
    })
    // The acceptance line, verbatim: not enqueued, and a row is written with reason = 'consent_denied',
    // so the suppression is visible rather than silent.
    expect(refused).toMatchObject({ state: 'suppressed', reason: 'consent_denied' })
    expect(refused.missing).toEqual(['ad_user_data'])

    const rows = await sql<
      { state: string; reason: string | null; transmitted_at: string | null }[]
    >`
      select state::text as state, reason, transmitted_at::text as transmitted_at
        from analytics_dispatch where session_id = ${sessionId}::uuid order by destination
    `
    expect(rows).toEqual([
      { state: 'suppressed', reason: 'consent_denied', transmitted_at: null },
      { state: 'queued', reason: null, transmitted_at: null },
    ])
  })

  it('refuses a queued row the gate would not permit, by ZY312, whatever the caller', async () => {
    const { sessionId } = await sessionWith(['analytics_storage'])
    /*
     * The call site is bypassed entirely: a direct INSERT, as a worker or a psql session would make it.
     *
     * The transport columns 0137 added are NOT NULL, so every one of these statements carries them — and
     * the CONTROL at the bottom is why that matters rather than being paperwork. A control insert missing
     * `event_id` fails with a not-null violation, which is not the gate refusing anything, and the two
     * `rejects` above would still have passed. The case would then have been green about a statement that
     * never reached the trigger.
     */
    const eventId = dispatchEventId(sessionId, 'booking_created')
    const payload = dispatchPayload('booking_created')
    await expect(
      sql`
        insert into analytics_dispatch (
          session_id, destination, funnel_stage, state, decided_at, event_id, payload, action_source,
          occurred_at
        )
        values (${sessionId}::uuid, 'advertising_conversion_push', 'booking_created', 'queued',
                ${AT}::timestamptz, ${eventId}, ${payload}::text::jsonb, 'website',
                ${AT}::timestamptz)
      `,
    ).rejects.toMatchObject({ code: ANALYTICS_CONSENT_SQLSTATE.dispatchConsentGate })
    // And the same for a row that tried to be born already sent.
    await expect(
      sql`
        insert into analytics_dispatch (
          session_id, destination, funnel_stage, state, decided_at, transmitted_at, attempts,
          event_id, payload, action_source, occurred_at
        )
        values (${sessionId}::uuid, 'advertising_conversion_push', 'booking_created', 'sent',
                ${AT}::timestamptz, ${AT}::timestamptz, 1, ${eventId},
                ${payload}::text::jsonb, 'website', ${AT}::timestamptz)
      `,
    ).rejects.toMatchObject({ code: ANALYTICS_CONSENT_SQLSTATE.dispatchConsentGate })
    // The control: the destination this session DOES consent to inserts directly without complaint, so
    // the two refusals are about the gate rather than about the statement.
    await sql`
      insert into analytics_dispatch (
        session_id, destination, funnel_stage, state, decided_at, event_id, payload, action_source,
        occurred_at
      )
      values (${sessionId}::uuid, 'analytics_measurement_push', 'booking_created', 'queued',
              ${AT}::timestamptz, ${eventId}, ${payload}::text::jsonb, 'website',
              ${AT}::timestamptz)
    `
  })

  it('refuses a dispatch whose consent state cannot be read, rather than suppressing it', async () => {
    // An unknown session is REFUSED and not recorded as a suppression: a suppression says a visitor said
    // no, and saying that about a row nobody could judge would be a false record of somebody's choice.
    await expect(
      enqueueAnalyticsDispatch(sql, {
        sessionId: '00000000-0000-7000-8000-000000000000',
        destination: 'analytics_measurement_push',
        funnelStage: 'booking_created',
        decidedAtIso: AT,
        eventId: dispatchEventId('00000000-0000-7000-8000-000000000000', 'booking_created'),
        payload: dispatchPayload('booking_created'),
        actionSource: 'website',
        occurredAtIso: AT,
      }),
    ).rejects.toSatisfy(
      (error: unknown) => analyticsConsentStoreRefusalOf(error) === 'dispatch_consent_unreadable',
    )
    /*
     * An unknown DESTINATION is refused too, and by the GATE rather than by the foreign key.
     *
     * This case was written expecting `23503` and the run returned `ZY312`, which is the better answer and
     * is worth stating: a BEFORE INSERT trigger runs before the row's foreign keys are checked, so
     * `dispatch_consent_gap` reaches its "no row in analytics_dispatch_destination, so nothing says which
     * consent signals it needs" branch first. That branch was written as a belt-and-braces guard against a
     * NULL the foreign key makes impossible — and it is the one that actually fires, which is why it
     * raises rather than returning an empty gap.
     */
    await expect(
      sql`
        insert into analytics_dispatch (session_id, destination, funnel_stage, state, decided_at)
        select session_id, 'a_destination_nobody_declared', 'booking_created', 'queued',
               ${AT}::timestamptz
          from analytics.session where visitor_id = any(${createdVisitors}::uuid[]) limit 1
      `,
    ).rejects.toMatchObject({ code: ANALYTICS_CONSENT_SQLSTATE.dispatchConsentGate })
  })

  it('cannot hold a destination that requires nothing, which would be an open gate', async () => {
    // The fail-closed guard on the requirement table itself. The natural way to add a destination is to
    // copy a row and clear the flags, and a destination requiring nothing is permitted for every session
    // including one that answered the banner with a flat no.
    await expect(
      sql`
        insert into analytics_dispatch_destination (
          destination, requires_ad_storage, requires_ad_user_data, requires_ad_personalization,
          requires_analytics_storage, reason
        ) values ('__fixture_ungated', false, false, false, false, 'a fixture')
      `,
    ).rejects.toMatchObject({
      constraint_name: 'analytics_dispatch_destination_requires_something',
    })
  })
})

// ------------------------------------------------------------------------------------------------
// Withdrawal: cancel what is queued, block what is next, and transmit nothing
// ------------------------------------------------------------------------------------------------

describe('withdrawing consent', () => {
  it('cancels queued-but-unsent dispatches, blocks future ones, and transmits nothing', async () => {
    const { visitorId, sessionId } = await sessionWith([...CONSENT_MODE_SIGNALS])
    const queued = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'advertising_conversion_push',
      funnelStage: 'booking_created',
      decidedAtIso: AT,
      eventId: dispatchEventId(sessionId, 'booking_created'),
      payload: dispatchPayload('booking_created'),
      actionSource: 'website',
      occurredAtIso: AT,
    })
    expect(queued.state, 'the fixture must have something queued to cancel').toBe('queued')

    const before = await analyticsConsentCounts(sql)
    const result = await withdrawAnalyticsConsent(sql, {
      visitorId,
      locale: 'en',
      surface: 'consent_banner',
      decidedAtIso: AT,
    })
    expect(result.dispatchesCancelled).toBe(1)
    expect(result.sessionsCleared).toBe(1)
    const after = await analyticsConsentCounts(sql)
    expect(after.withdrawn - before.withdrawn).toBe(1)

    // The cancelled row ends in the state the acceptance line names, with its reason.
    const [row] = await sql<
      { state: string; reason: string | null; transmitted_at: string | null }[]
    >`
      select state::text as state, reason, transmitted_at::text as transmitted_at
        from analytics_dispatch where dispatch_id = ${queued.dispatchId}::uuid
    `
    expect(row).toEqual({
      state: 'cancelled_consent_withdrawn',
      reason: 'consent_withdrawn',
      transmitted_at: null,
    })

    /*
     * **Nothing was transmitted**, asserted as a stored fact rather than as an absence.
     *
     * `analytics_dispatch_transmitted_iff_sent` makes `transmitted_at` present exactly when the state is
     * `sent`, so "no row for this visitor has ever been transmitted" is a query rather than a claim about
     * what the test did not do.
     */
    const [transmitted] = await sql<{ n: string }[]>`
      select count(*)::text as n from analytics_dispatch d
        join analytics.session s on s.session_id = d.session_id
       where s.visitor_id = ${visitorId}::uuid
         and (d.state = 'sent' or d.transmitted_at is not null)
    `
    expect(transmitted?.n).toBe('0')

    // Future ones are BLOCKED, and blocked at the database: the session's columns are cleared, so the
    // ZY312 trigger refuses a new queued row for any destination.
    const nextTime = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'analytics_measurement_push',
      funnelStage: 'confirmed',
      decidedAtIso: AT,
      eventId: dispatchEventId(sessionId, 'confirmed'),
      payload: dispatchPayload('confirmed'),
      actionSource: 'website',
      occurredAtIso: AT,
    })
    expect(nextTime).toMatchObject({ state: 'suppressed', reason: 'consent_denied' })
    expect([...consentStateFromSessionRow(await sessionConsentRow(sql, sessionId))]).toEqual([])
  })

  it('cannot be undone by reinstating a cancelled row, because the trigger reads the session', async () => {
    const { visitorId, sessionId } = await sessionWith([...CONSENT_MODE_SIGNALS])
    const queued = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'advertising_conversion_push',
      funnelStage: 'booking_created',
      decidedAtIso: AT,
      eventId: dispatchEventId(sessionId, 'booking_created'),
      payload: dispatchPayload('booking_created'),
      actionSource: 'website',
      occurredAtIso: AT,
    })
    await withdrawAnalyticsConsent(sql, {
      visitorId,
      locale: 'en',
      surface: 'consent_banner',
      decidedAtIso: AT,
    })
    // This is the attack a cancellation alone does not stop: put the row back in the queue, or mark it
    // sent, after the visitor has withdrawn. The trigger fires on UPDATE as well as INSERT and reads the
    // session's columns, which the withdrawal cleared.
    for (const statement of [
      sql`update analytics_dispatch set state = 'queued', reason = null
           where dispatch_id = ${queued.dispatchId}::uuid`,
      sql`update analytics_dispatch set state = 'sent', reason = null,
                 transmitted_at = ${AT}::timestamptz, attempts = 1
           where dispatch_id = ${queued.dispatchId}::uuid`,
    ]) {
      await expect(statement).rejects.toMatchObject({
        code: ANALYTICS_CONSENT_SQLSTATE.dispatchConsentGate,
      })
    }
  })

  it('records the withdrawal even for a device that presents no visitor, and cancels nothing', async () => {
    // A device whose consent cookie survived its visitor cookie has nothing identified to cancel. The
    // withdrawal is still EVIDENCE and is still recorded; the counts say which case it was rather than
    // leaving a caller to infer it.
    const before = await analyticsConsentCounts(sql)
    const result = await withdrawAnalyticsConsent(sql, {
      visitorId: null,
      locale: 'ar',
      surface: 'consent_banner',
      decidedAtIso: AT,
    })
    expect(result).toMatchObject({ sessionsCleared: 0, dispatchesCancelled: 0 })
    const after = await analyticsConsentCounts(sql)
    expect(after.withdrawn - before.withdrawn).toBe(1)
  })

  it('leaves a dispatch that was already SENT exactly as it is', async () => {
    const { visitorId, sessionId } = await sessionWith([...CONSENT_MODE_SIGNALS])
    const queued = await enqueueAnalyticsDispatch(sql, {
      sessionId,
      destination: 'advertising_conversion_push',
      funnelStage: 'booking_created',
      decidedAtIso: AT,
      eventId: dispatchEventId(sessionId, 'booking_created'),
      payload: dispatchPayload('booking_created'),
      actionSource: 'website',
      occurredAtIso: AT,
    })
    // Transmission is A-MEAS-03's, so the fixture performs it: while consent still stands, the trigger
    // permits the move to `sent`.
    await sql`
      update analytics_dispatch
         set state = 'sent', transmitted_at = ${AT}::timestamptz, attempts = 1
       where dispatch_id = ${queued.dispatchId}::uuid
    `
    await withdrawAnalyticsConsent(sql, {
      visitorId,
      locale: 'en',
      surface: 'consent_banner',
      decidedAtIso: AT,
    })
    // A transmission that happened cannot be un-happened, and a row rewritten to claim otherwise would be
    // a false record. `state = 'queued'` is the whole predicate the cancellation uses, which is what
    // makes this true by construction rather than by a second check.
    const [row] = await sql<{ state: string; transmitted_at: string | null }[]>`
      select state::text as state, transmitted_at::text as transmitted_at
        from analytics_dispatch where dispatch_id = ${queued.dispatchId}::uuid
    `
    expect(row?.state).toBe('sent')
    expect(row?.transmitted_at).not.toBeNull()
  })
})
