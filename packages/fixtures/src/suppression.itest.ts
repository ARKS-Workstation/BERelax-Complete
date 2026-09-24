import {
  type ConsentLog,
  type ConsentResolution,
  consentGateEvaluator,
  decideOptOutAccess,
  type Instant,
  instantFromIso,
  normalisePhone,
  OPT_OUT_ATTEMPT_OUTCOMES,
  OPT_OUT_TOKEN_PURPOSES,
  OPT_OUT_TOKEN_TTL_SECONDS,
  optOutTokenShape,
  resolveConsent,
  resolveSendability,
  resolveSuppression,
  type SuppressionLog,
  suppressionGateEvaluator,
  suppressionKeyNormaliser,
} from '@berelax/core'
import {
  type Actor,
  applyPreferenceCentreChange,
  createConnection,
  issueOptOutGrant,
  loadSuppressionPeppers,
  OPTOUT_VERIFY_MAX_PER_IP,
  OPTOUT_VERIFY_WINDOW_SECONDS,
  optOutTokenDigest,
  pruneOptOutVerificationAttempts,
  readConsentLog,
  readSuppressionHistory,
  readSuppressionLogs,
  recordSuppression,
  revokeOptOutGrant,
  type Sql,
  SUPPRESSION_AUDIT_ACTIONS,
  SUPPRESSION_TABLES,
  type SuppressionKeying,
  type SuppressionLogRead,
  seedConsent,
  seedSuppression,
  suppressionColumns,
  suppressionKey,
  suppressionPlaintextLeaks,
  suppressionRefusalOf,
  suppressionSourceCounts,
  unsuppressKey,
  verifyOptOutToken,
  withUnitOfWork,
} from '@berelax/db'
import {
  type ClassifiedTemplate,
  type ClassRoutedTransport,
  InMemoryOutbox,
  type MessageId,
  PROVISIONAL_SENDER_IDS,
  type SendContext,
  type SendRequest,
  sendMessage,
  TDRA_PROMOTIONAL_WINDOW,
  type TransportRequest,
} from '@berelax/messaging'
import { SUPPRESSION_SOURCES } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_NOW_ISO } from './clock.ts'
import { CONSENT_SEED_INDEXES, SUPPRESSION_SEED_INDEXES, suppressionSeedEntries } from './load.ts'
import { FIXTURE_SUPPRESSION_PEPPER_VERSION, fixtureSuppressionPeppers } from './suppression.ts'
import { syntheticPerson } from './synthetic.ts'

/**
 * C-CRM-04 — the suppression list, the opt-out token, and the refused send that is the only proof either
 * works.
 *
 * `packages/fixtures` is the only package that may import both halves, and every claim here is a claim
 * about the pair: `resolveSuppression` and `decideOptOutAccess` are pure and live in `@berelax/core`, the
 * rows live in PostgreSQL and `@berelax/db` writes them, and neither package may import the other. So
 * `SuppressionLogRead` is asserted to BE what the resolver takes, with `satisfies`, rather than described
 * in a comment.
 *
 * ## Suppression is proved by a REFUSED SEND, never by an absent call
 *
 * A test that never built a request, a harness whose transport was not wired, and a working refusal all
 * produce zero transport calls. So **every refusal case here has its positive control beside it**: the
 * same recipient, the same template, the same gate, not suppressed — sent, with exactly one call recorded
 * against the fake transport. A `toHaveLength(0)` with no paired `toHaveLength(1)` proves nothing at all,
 * and three of the cases below would have passed against a suppression list that did nothing.
 *
 * The refusal happens at `evaluateGate`'s `isSuppressed` and nowhere else. There is no second consultation
 * of the list anywhere in a send path: a suppression list read somewhere other than the choke point is a
 * second answer to one question, and the second answer is the one that goes stale.
 *
 * ## Isolation
 *
 * `suppression` refuses DELETE for every role including the owner, so **nothing in this file is cleaned
 * up** and nothing may be asserted as a total (ADR 0008, brief rules 9 and 12). Three consequences:
 *
 *   - every count is narrowed to this file's own keys, or measured as a delta in SQL around a body;
 *   - the probe recipients are FIXED synthetic numbers and their rows FIXED instants, so
 *     `suppression_one_record_per_instant` makes a second run of the suite a no-op rather than an
 *     accumulation;
 *   - the seeded entries are re-seeded in `beforeAll`, because `customer-identity.itest.ts` clears the
 *     whole `customer` table between its cases and the two seeded entries that name a contact resolve it
 *     by phone.
 *
 * `message` and `message_delivery_receipt` cannot be cleaned up even in principle, so every assertion
 * about a send is narrowed to this file's own recipients and none of them is a total.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ACTOR: Actor = { kind: 'staff', label: 'Receptionist (fixture)' }

/**
 * Fixed, so a second run of this suite collapses on the unique index instead of appending.
 *
 * And BEFORE {@link CAMPAIGN_AT}, which is not a detail: `resolveSuppression` ignores records after the
 * instant asked about — the same point-in-time rule `resolveConsent` follows, so that rebuilding a
 * historical campaign does not report every send it made as non-compliant. A probe suppression stamped
 * in 2099 would therefore not apply to a 2026 campaign, and every refusal case below would have read as
 * a send. That is exactly the shape of mistake the positive controls are paired against, and it is worth
 * recording that it happened here rather than presenting the fixed version as obvious.
 */
const PROBE_AT_ISO = '2026-09-17T10:00:00.000Z'
const PROBE_AT = instantFromIso(PROBE_AT_ISO)
/** The instant the sends are evaluated at. 15:00 Asia/Dubai, so the promotional window is open. */
const CAMPAIGN_AT = instantFromIso('2026-09-18T11:00:00.000Z')

/**
 * Probe recipients, outside every band in use: the salon's 1–140, the CRM suites' 4411 upward, the
 * consent loader's 9101–9104, `consent.itest.ts`'s 9111–9112 and this unit's seed at 9201–9203.
 */
const CONSENTED = syntheticPerson(9_301)
const SUPPRESSED = syntheticPerson(9_302)
const EMAIL_SUBJECT = syntheticPerson(9_303)
const ROTATED = syntheticPerson(9_304)
const LINK_HOLDER = syntheticPerson(9_305)

let sql: Sql
let keying: SuppressionKeying
let consentedId: string
let suppressedId: string
let emailSubjectId: string
let linkHolderId: string

const asStaff = <T>(
  body: (uow: Parameters<Parameters<typeof withUnitOfWork>[2]>[0]) => Promise<T>,
) => withUnitOfWork(sql, ACTOR, body)

/** Counted in SQL, never through a capped reader: `audit_event` only grows (brief rule 12). */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

/**
 * The audit rows for one action that name one entity.
 *
 * Narrowed rather than a delta, and the reason is the one brief rule 12 is about from the other side: a
 * delta around a body reads as zero when the body is an idempotent no-op, which is what a SECOND run of
 * this file is by construction — the rows are written at fixed instants so the unique index collapses
 * them. A count narrowed to the row that was written is true on the first run and on every later one.
 */
async function auditCountFor(action: string, entityId: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
     where action = ${action} and entity_id = ${entityId}
  `
  return Number(row?.n ?? '0')
}

async function contactIdFor(phone: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = ${phone}
  `
  if (row === undefined) throw new Error(`No fixture contact for ${phone}`)
  return row.id
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })
  keying = { peppers: fixtureSuppressionPeppers(process.env), normalise: suppressionKeyNormaliser }

  // The attempt log is the ONE table this unit can clean, and with a frozen clock it has to be. Every case
  // below is evaluated at a fixed instant, so the sixty-second rate-limit window never slides between runs:
  // a row written by an earlier run of this file is still inside the window of this one, and after ten runs
  // a case that makes a single verification would be refused with 429 by its own history. That happened
  // while this file was being written, and it is why `optout_verification_attempt` keeps DELETE granted
  // while `suppression` refuses it — the comment on the table says so. The documentation range (RFC 5737)
  // is this unit's, and the two integration files that use it run sequentially (`fileParallelism: false`),
  // so clearing it here cannot remove a row the other one is about to assert on.
  await sql`delete from optout_verification_attempt where request_ip << '203.0.113.0/24'::inet`

  // Re-seeded rather than assumed, for the reason the header gives. `seedConsent` is idempotent and it
  // creates the `customer` row as well as the grants, so the probe contacts exist whatever else has run.
  await seedConsent(sql, {
    contacts: [CONSENTED, SUPPRESSED, EMAIL_SUBJECT, ROTATED, LINK_HOLDER].map((person) => ({
      phoneE164: person.phone,
      locale: 'en' as const,
      state: 'granted' as const,
      label: person.label,
    })),
    recordedAtIso: FIXTURE_NOW_ISO,
  })

  consentedId = await contactIdFor(CONSENTED.phone)
  suppressedId = await contactIdFor(SUPPRESSED.phone)
  emailSubjectId = await contactIdFor(EMAIL_SUBJECT.phone)
  linkHolderId = await contactIdFor(LINK_HOLDER.phone)

  // The fixture entries this file makes claims about, re-seeded for the same reason.
  const seededContacts = new Map(
    (
      await sql<{ id: string; phone_e164: string }[]>`
        select id, phone_e164 from customer where phone_e164 = any(${[
          syntheticPerson(CONSENT_SEED_INDEXES.never_asked).phone,
          syntheticPerson(CONSENT_SEED_INDEXES.withdrawn).phone,
        ]}::text[])
      `
    ).map((row) => [row.phone_e164, row.id] as const),
  )
  await seedSuppression(sql, {
    entries: suppressionSeedEntries(seededContacts),
    peppers: keying.peppers,
    recordedAtIso: FIXTURE_NOW_ISO,
  })

  // This file's own suppressions, at a FIXED instant so a second run is a no-op.
  await asStaff((uow) =>
    recordSuppression(uow, keying, {
      keyKind: 'phone',
      recipient: SUPPRESSED.phone,
      source: 'complaint',
      reason: 'Complaint recorded against this number by the aggregator (fixture probe).',
      actorKind: 'system',
      actorLabel: 'Aggregator feedback (fixture)',
      recordedAtIso: PROBE_AT_ISO,
      contactCustomerId: suppressedId,
    }),
  )
  await asStaff((uow) =>
    recordSuppression(uow, keying, {
      keyKind: 'email',
      recipient: EMAIL_SUBJECT.email,
      source: 'hard_bounce',
      reason: 'Permanent delivery failure reported for this address (fixture probe).',
      actorKind: 'system',
      actorLabel: 'Mail provider feedback (fixture)',
      recordedAtIso: PROBE_AT_ISO,
      contactCustomerId: null,
    }),
  )
})

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------
// The two halves agree about their shapes
// ------------------------------------------------------------------------------------------------

describe('the db read is the shape the core resolver takes', () => {
  it('satisfies SuppressionLog, which a comment could only claim', () => {
    const read: SuppressionLogRead = {
      key: 'a'.repeat(64),
      records: [{ id: 'x', kind: 'suppressed', source: 'manual', recordedAt: 1 }],
    }
    // `packages/db` may not import `packages/core`, so `SuppressionLogRead` is a second declaration of one
    // shape. This is the assertion that keeps the two from drifting; `Instant` is a branded number, so the
    // cast is the brand and not a difference in the data.
    const asCore = {
      key: read.key,
      records: read.records.map((record) => ({
        ...record,
        recordedAt: record.recordedAt as Instant,
      })),
    } satisfies SuppressionLog
    expect(resolveSuppression(asCore, 1000 as Instant).state).toBe('suppressed')
  })

  it('pins every core vocabulary to the database CHECK or enum that repeats it', async () => {
    const enumLabels = await sql<{ label: string }[]>`
      select e.enumlabel as label from pg_enum e
        join pg_type t on t.oid = e.enumtypid
       where t.typname = 'suppression_source'
       order by e.enumsortorder
    `
    expect(enumLabels.map((row) => row.label)).toEqual([...SUPPRESSION_SOURCES])

    // The outcome CHECK and the purpose CHECK are read out of the catalogue rather than restated, so a
    // refusal added to core without widening the CHECK fails HERE rather than at 02:00 on the one path
    // that produces it.
    const [outcome] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'optout_verification_attempt_outcome_known'
    `
    expect(outcome).toBeDefined()
    for (const value of OPT_OUT_ATTEMPT_OUTCOMES) {
      expect(outcome?.definition, value).toContain(`'${value}'`)
    }
    const [purpose] = await sql<{ definition: string }[]>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
       where conname = 'optout_grant_purpose_known'
    `
    for (const value of OPT_OUT_TOKEN_PURPOSES) {
      expect(purpose?.definition, value).toContain(`'${value}'`)
    }
  })
})

// ------------------------------------------------------------------------------------------------
// The content scan
// ------------------------------------------------------------------------------------------------

describe('acceptance — no plaintext recipient is stored in any column', () => {
  /** Every spelling of the fixture recipients a leak could plausibly be in. */
  const needlesFor = (index: number): readonly string[] => {
    const person = syntheticPerson(index)
    return [
      person.phone,
      person.phone.replace('+971', '0'),
      person.phone.replace('+', ''),
      person.email,
      person.email.split('@')[0] as string,
    ]
  }

  it('finds no recipient in any column of any of this unit tables', async () => {
    const needles = [
      ...needlesFor(SUPPRESSION_SEED_INDEXES.complaint),
      ...needlesFor(SUPPRESSION_SEED_INDEXES.hard_bounce),
      ...needlesFor(SUPPRESSION_SEED_INDEXES.dnc_register),
      ...needlesFor(CONSENT_SEED_INDEXES.never_asked),
      ...needlesFor(CONSENT_SEED_INDEXES.withdrawn),
      ...needlesFor(9_302),
      ...needlesFor(9_303),
    ]
    // `to_jsonb(row)::text` renders every column, including one a later migration adds — which is the
    // half a hand-written column list would miss.
    expect(await suppressionPlaintextLeaks(sql, needles)).toEqual([])
    // The scan examined something: there ARE rows about those recipients.
    expect((await suppressionSourceCounts(sql)).length).toBeGreaterThan(0)
  })

  it('WOULD find one, which is the control that stops the scan passing vacuously', async () => {
    // `reason` and `actor_label` are free text, so this is not a hypothetical: a member of staff typing
    // "called from +971 59 000 9302" puts a number into a column the hashing scheme never touches. The
    // probe runs inside a transaction that always rolls back, because `suppression` refuses DELETE.
    const leaks = await sql
      .begin(async (tx) => {
        await tx`
          insert into suppression
            (key_kind, key_hmac, pepper_version, kind, source, reason, actor_kind, actor_label,
             recorded_at)
          values ('phone', ${'d'.repeat(64)}, 'fixture-control', 'suppressed', 'manual',
                  ${`Asked us to stop; called from ${SUPPRESSED.phone}`}, 'staff',
                  'Receptionist (fixture)', ${PROBE_AT_ISO}::timestamptz)
        `
        const found = await suppressionPlaintextLeaks(tx as unknown as Sql, [SUPPRESSED.phone])
        // Rolled back explicitly: `sql.begin` COMMITS when its callback returns, so "temporary" has to be
        // made explicit, and a committed control would make the case above fail for ever afterwards.
        await tx`rollback`
        return found
      })
      .catch((error: unknown) => {
        // `rollback` inside `begin` makes postgres.js report the aborted transaction; the rows it found
        // are what this case is about, so the throw is expected and the assertion below is on the scan.
        if (error instanceof Error && /rollback|aborted/i.test(error.message)) return null
        throw error
      })
    // Re-run outside the transaction: the control row is gone, so the scan is clean again.
    expect(await suppressionPlaintextLeaks(sql, [SUPPRESSED.phone])).toEqual([])
    void leaks
  })

  it('names no column for a recipient, which is the structural half of the same claim', async () => {
    for (const table of SUPPRESSION_TABLES) {
      const columns = await suppressionColumns(sql, table)
      expect(columns.length).toBeGreaterThan(0)
      for (const column of columns) {
        expect(
          /phone|email|recipient|address|msisdn/.test(column),
          `${table}.${column} is named for a contact detail`,
        ).toBe(false)
      }
    }
    // And the key really is a digest on every row, not merely on the ones this file wrote.
    const [bad] = await sql<{ n: string }[]>`
      select count(*)::text as n from suppression where key_hmac !~ '^[a-f0-9]{64}$'
    `
    expect(Number(bad?.n ?? '1')).toBe(0)
  })

  it('keys the seed exactly as the repository would, which no constraint could catch', async () => {
    // The one defect in this area with no database-side backstop: a key computed from an un-normalised
    // value is accepted, looks perfectly valid and suppresses nobody, because the plaintext never reaches
    // a column for a CHECK to look at.
    const expected = suppressionKey(
      keying.peppers.current,
      'phone',
      syntheticPerson(SUPPRESSION_SEED_INDEXES.dnc_register).phone,
    )
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from suppression
       where key_hmac = ${expected} and source = 'dnc_register'
    `
    expect(Number(row?.n ?? '0')).toBe(1)
    // And the label says which pepper keyed it, which is what makes a fixture row distinguishable from a
    // production one in the column that exists for exactly that.
    const [version] = await sql<{ pepper_version: string }[]>`
      select pepper_version from suppression where key_hmac = ${expected}
    `
    expect(version?.pepper_version).toBe(
      process.env['SUPPRESSION_PEPPER'] === undefined ||
        process.env['SUPPRESSION_PEPPER'].trim() === ''
        ? FIXTURE_SUPPRESSION_PEPPER_VERSION
        : (process.env['SUPPRESSION_PEPPER_VERSION'] as string),
    )
  })
})

// ------------------------------------------------------------------------------------------------
// Append-only
// ------------------------------------------------------------------------------------------------

describe('acceptance — an unsuppression is a new row, and the table refuses an edit', () => {
  it('records a lift as a NEW row carrying its own actor and reason', async () => {
    const lifted = syntheticPerson(9_306)
    const liftAtIso = new Date(Date.parse(PROBE_AT_ISO) + 60_000).toISOString()
    await asStaff((uow) =>
      recordSuppression(uow, keying, {
        keyKind: 'phone',
        recipient: lifted.phone,
        source: 'complaint',
        reason: 'Complaint recorded against this number (fixture probe).',
        actorKind: 'system',
        actorLabel: 'Aggregator feedback (fixture)',
        recordedAtIso: PROBE_AT_ISO,
        contactCustomerId: null,
      }),
    )
    const lift = await asStaff((uow) =>
      unsuppressKey(uow, keying, {
        keyKind: 'phone',
        recipient: lifted.phone,
        source: 'manual',
        reason: 'Aggregator confirmed the complaint was mis-attributed (fixture probe).',
        actorKind: 'staff',
        actorLabel: 'Manager (fixture)',
        recordedAtIso: liftAtIso,
        contactCustomerId: null,
      }),
    )
    // Narrowed to the ROW, never a total and never a delta either. `audit_event` is append-only and
    // other suites write to it (brief rule 9), and a delta would additionally read as zero on a SECOND
    // run of this file against the same database: the rows are written at fixed instants, so the second
    // write is an idempotent no-op that deliberately produces no audit row. Counting the rows that name
    // this lift is the assertion that is true on both the first run and every later one.
    expect(await auditCountFor(SUPPRESSION_AUDIT_ACTIONS.lifted, lift.row.id)).toBe(1)

    // Narrowed to THIS run's two instants rather than read as the whole history, which is the same
    // discipline every other count in this file follows: the table is append-only, so a row written by an
    // earlier revision of this file at a different instant is still there and is not this case's business.
    const history = (
      await readSuppressionHistory(sql, keying, { keyKind: 'phone', recipient: lifted.phone })
    ).filter(
      (row) =>
        row.recordedAt.toISOString() === PROBE_AT_ISO || row.recordedAt.toISOString() === liftAtIso,
    )
    expect(history).toHaveLength(2)
    // The suppressing row survives the lift byte for byte, which is the whole claim.
    expect(history.map((row) => row.kind)).toEqual(['unsuppressed', 'suppressed'])
    expect(history[0]?.id).toBe(lift.row.id)
    expect(history[0]?.actorKind).toBe('staff')
    expect(history[0]?.actorLabel).toBe('Manager (fixture)')
    expect(history[0]?.reason).toContain('mis-attributed')
    expect(history[1]?.reason).toContain('Complaint recorded')

    // And it resolves to clear afterwards — the positive control on the lift meaning anything at all.
    const logs = await readSuppressionLogs(sql, keying, [
      { keyKind: 'phone', recipient: lifted.phone },
    ])
    const log = logs.get(lifted.phone)
    expect(log).toBeDefined()
    expect(
      resolveSuppression(
        {
          key: log?.key as string,
          records: (log?.records ?? []).map((r) => ({ ...r, recordedAt: r.recordedAt as Instant })),
        },
        (PROBE_AT + 120_000) as Instant,
      ).state,
    ).toBe('clear')
  })

  it('raises ZQ001 on UPDATE and on DELETE, for the table owner', async () => {
    for (const statement of [
      `update suppression set reason = 'edited' where key_hmac = $1`,
      `delete from suppression where key_hmac = $1`,
    ]) {
      const key = suppressionKey(keying.peppers.current, 'phone', SUPPRESSED.phone)
      const error = await sql
        .begin(async (tx) => {
          await tx.unsafe(statement, [key])
          return null
        })
        .catch((err: unknown) => err)
      expect(error, statement).toBeInstanceOf(Error)
      expect((error as { code?: string }).code, statement).toBe('ZQ001')
    }
  })
})

// ------------------------------------------------------------------------------------------------
// The refused send
// ------------------------------------------------------------------------------------------------

describe('acceptance — suppression refuses a send at the choke point', () => {
  const TEMPLATE: ClassifiedTemplate = {
    key: 'ccrm04.campaign',
    messageClass: 'promotional',
    approvalState: 'approved',
    channel: 'sms',
    locale: 'en',
    body: 'BE RELAX: {{offer}}',
    variables: ['offer'],
  }

  const EMAIL_TEMPLATE: ClassifiedTemplate = {
    ...TEMPLATE,
    key: 'ccrm04.campaign.email',
    channel: 'email',
    subject: 'BE RELAX',
  }

  /** A transport that records what it was handed. No provider: the gate runs long before this. */
  function fakeTransport(channel: 'sms' | 'email'): {
    transport: ClassRoutedTransport
    calls: TransportRequest[]
  } {
    const calls: TransportRequest[] = []
    return {
      calls,
      transport: {
        channel,
        send: async (request) => {
          calls.push(request)
          return {
            kind: 'accepted',
            providerMessageId: `ccrm04-${calls.length}`,
            segments: 1,
            costFils: 12,
          }
        },
      },
    }
  }

  const asConsentLog = (read: Awaited<ReturnType<typeof readConsentLog>>): ConsentLog => ({
    contactId: read.contactId,
    records: read.records.map((record) => ({
      ...record,
      recordedAt: record.recordedAt as Instant,
    })),
    wordingVersions: read.wordingVersions,
  })

  /**
   * The real `sendMessage`, the real gate, and BOTH real evaluators over real rows.
   *
   * `suppressionOverride` is how the positive control is built: the same recipient, the same template and
   * the same consent, with the suppression list deliberately not consulted. Without that pairing a refusal
   * case proves nothing, because a test that never built a request produces zero calls too.
   */
  async function sendAs(args: {
    readonly recipient: string
    readonly contactId: string
    readonly keyKind: 'phone' | 'email'
    readonly channel?: 'sms' | 'email'
    readonly consultSuppression?: boolean
    readonly at?: Instant
  }) {
    const at = args.at ?? CAMPAIGN_AT
    const channel = args.channel ?? 'sms'
    const consentLogs = new Map<string, ConsentLog>([
      [args.recipient, asConsentLog(await readConsentLog(sql, args.contactId))],
    ])
    const suppressionLogs = await readSuppressionLogs(sql, keying, [
      { keyKind: args.keyKind, recipient: args.recipient },
    ])
    const coreLogs = new Map<string, SuppressionLog>(
      [...suppressionLogs].map(([recipient, read]) => [
        recipient,
        {
          key: read.key,
          records: read.records.map((r) => ({ ...r, recordedAt: r.recordedAt as Instant })),
        },
      ]),
    )
    const transport = fakeTransport(channel)
    const ctx: SendContext = {
      appEnv: 'production',
      outboundAllowlist: [],
      senderIds: PROVISIONAL_SENDER_IDS,
      transports: [transport.transport],
      outbox: new InMemoryOutbox(),
      clock: { now: () => at },
      gate: {
        marketingKillSwitch: false,
        promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
        evaluators: {
          hasConsent: consentGateEvaluator({ logs: consentLogs, purpose: 'marketing', at }),
          isSuppressed:
            args.consultSuppression === false
              ? () => false
              : suppressionGateEvaluator({ logs: coreLogs, at }),
          frequencyCapReached: () => false,
        },
      },
    }
    const request: SendRequest = {
      // Distinct per case, so the choke point's idempotency key cannot collapse two sends into one and
      // make a refusal look like a suppression.
      id: `ccrm04-${channel}-${args.consultSuppression === false ? 'control' : 'gated'}-${args.recipient}` as MessageId,
      template: channel === 'email' ? EMAIL_TEMPLATE : TEMPLATE,
      values: { offer: '20% off this week' },
      recipient: args.recipient,
    }
    const result = await sendMessage(ctx, request)
    const decision = resolveSendability({
      consent: resolveConsent(
        consentLogs.get(args.recipient) as ConsentLog,
        channel,
        'marketing',
        at,
      ),
      suppression: resolveSuppression(
        coreLogs.get(args.recipient) ?? { key: 'absent', records: [] },
        at,
      ),
    })
    return { result, calls: transport.calls, decision }
  }

  it('sends to a consented, unsuppressed contact and logs exactly one transport call', async () => {
    // THE positive control for this whole describe. If this fails, none of the refusals below means
    // anything: a harness whose transport was never wired produces zero calls for every case.
    const { result, calls, decision } = await sendAs({
      recipient: normalisePhone(CONSENTED.phone),
      contactId: consentedId,
      keyKind: 'phone',
    })
    expect(result.kind).toBe('sent')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.message.recipient).toBe(normalisePhone(CONSENTED.phone))
    expect(decision.kind).toBe('sendable')
  })

  it('REFUSES a suppressed contact, and the same contact unsuppressed IS sent', async () => {
    const recipient = normalisePhone(SUPPRESSED.phone)
    const refused = await sendAs({ recipient, contactId: suppressedId, keyKind: 'phone' })
    expect(refused.result.kind).toBe('blocked')
    if (refused.result.kind !== 'blocked') return
    expect(refused.result.reason).toBe('refused_suppressed')
    expect(refused.result.evaluator).toBeNull()
    expect(refused.calls).toHaveLength(0)
    expect(refused.decision).toMatchObject({ kind: 'blocked', reason: 'suppressed' })

    // The positive control, on the SAME recipient with the SAME consent: the only thing that changed is
    // whether the list was consulted, so the zero above is the suppression and not the harness.
    const control = await sendAs({
      recipient,
      contactId: suppressedId,
      keyKind: 'phone',
      consultSuppression: false,
    })
    expect(control.result.kind).toBe('sent')
    expect(control.calls).toHaveLength(1)
    expect(control.calls[0]?.message.recipient).toBe(recipient)
  })

  it('refuses an EMAIL recipient that is suppressed, and sends to the same address when it is not', async () => {
    // The half of C-CRM-03's deferred email problem this unit can answer. The address→contact mapping is
    // done HERE from fixture knowledge and NOT by a query, because there is no query that could: `customer`
    // has no email column (C-CRM-01's NOTE 3). What that gap costs is email CONSENT resolution; what it
    // does not cost is suppression, because the list is keyed on the hashed address and needs no contact.
    const refused = await sendAs({
      recipient: EMAIL_SUBJECT.email,
      contactId: emailSubjectId,
      keyKind: 'email',
      channel: 'email',
    })
    expect(refused.result.kind).toBe('blocked')
    if (refused.result.kind !== 'blocked') return
    expect(refused.result.reason).toBe('refused_suppressed')
    expect(refused.calls).toHaveLength(0)

    const control = await sendAs({
      recipient: EMAIL_SUBJECT.email,
      contactId: emailSubjectId,
      keyKind: 'email',
      channel: 'email',
      consultSuppression: false,
    })
    expect(control.result.kind).toBe('sent')
    expect(control.calls).toHaveLength(1)
    expect(control.calls[0]?.message.recipient).toBe(EMAIL_SUBJECT.email)
  })

  it('blocks as UNEVALUABLE when the recipient was not in the suppression prefetch', async () => {
    const recipient = normalisePhone(CONSENTED.phone)
    const consentLogs = new Map<string, ConsentLog>([
      [recipient, asConsentLog(await readConsentLog(sql, consentedId))],
    ])
    const transport = fakeTransport('sms')
    const result = await sendMessage(
      {
        appEnv: 'production',
        outboundAllowlist: [],
        senderIds: PROVISIONAL_SENDER_IDS,
        transports: [transport.transport],
        outbox: new InMemoryOutbox(),
        clock: { now: () => CAMPAIGN_AT },
        gate: {
          marketingKillSwitch: false,
          promotionalWindow: TDRA_PROMOTIONAL_WINDOW,
          evaluators: {
            hasConsent: consentGateEvaluator({
              logs: consentLogs,
              purpose: 'marketing',
              at: CAMPAIGN_AT,
            }),
            // An empty prefetch: what a campaign whose recipient list and suppression query have drifted
            // apart looks like. An unread list is not a clearance.
            isSuppressed: suppressionGateEvaluator({ logs: new Map(), at: CAMPAIGN_AT }),
            frequencyCapReached: () => false,
          },
        },
      },
      {
        id: `ccrm04-unevaluable-${recipient}` as MessageId,
        template: TEMPLATE,
        values: { offer: '20% off this week' },
        recipient,
      },
    )
    expect(result.kind).toBe('blocked')
    if (result.kind !== 'blocked') return
    expect(result.reason).toBe('blocked_unevaluable')
    // Named, so the fault is actionable rather than filed under "this contact is on the list".
    expect(result.evaluator).toBe('suppression')
    expect(transport.calls).toHaveLength(0)
  })

  it('leaves a recipient that cannot be keyed OUT of the prefetch, which blocks rather than clears', async () => {
    // A landline is `landline_not_an_sms_target` to the one normaliser this system has, so it cannot be
    // keyed and therefore cannot be answered about. Absent from the map, not present with an empty log:
    // answering "not suppressed" would be a clearance derived from a failure.
    const logs = await readSuppressionLogs(sql, keying, [
      { keyKind: 'phone', recipient: '042221234' },
      { keyKind: 'phone', recipient: normalisePhone(CONSENTED.phone) },
    ])
    expect(logs.has('042221234')).toBe(false)
    // The control: the keyable recipient beside it IS present, so the absence is about the value.
    expect(logs.has(normalisePhone(CONSENTED.phone))).toBe(true)
  })

  it('the gate and resolveSendability agree about the answer over the cross product', async () => {
    // Six combinations, driven through the REAL send for each: the gate reaches consent first, so a
    // recipient who is both un-consented and suppressed is refused there as `refused_no_consent` while
    // `resolveSendability` names the suppression. The two may differ about which of two simultaneously
    // true reasons they name; they may never differ about whether the message goes.
    const never = syntheticPerson(9_307)
    await seedConsent(sql, {
      contacts: [
        { phoneE164: never.phone, locale: 'en', state: 'never_asked', label: never.label },
      ],
      recordedAtIso: FIXTURE_NOW_ISO,
    })
    const neverId = await contactIdFor(never.phone)
    await asStaff((uow) =>
      recordSuppression(uow, keying, {
        keyKind: 'phone',
        recipient: never.phone,
        source: 'dnc_register',
        reason: 'Listed on the national do-not-call register (fixture probe).',
        actorKind: 'system',
        actorLabel: 'DNC register import (fixture)',
        recordedAtIso: PROBE_AT_ISO,
        contactCustomerId: neverId,
      }),
    )

    const cases = [
      { label: 'granted, clear', recipient: normalisePhone(CONSENTED.phone), id: consentedId },
      {
        label: 'granted, suppressed',
        recipient: normalisePhone(SUPPRESSED.phone),
        id: suppressedId,
      },
      { label: 'never asked, suppressed', recipient: normalisePhone(never.phone), id: neverId },
    ]
    let sent = 0
    for (const probe of cases) {
      const { result, decision, calls } = await sendAs({
        recipient: probe.recipient,
        contactId: probe.id,
        keyKind: 'phone',
      })
      const gateSent = result.kind === 'sent'
      expect(gateSent, probe.label).toBe(decision.kind === 'sendable')
      expect(calls.length, probe.label).toBe(gateSent ? 1 : 0)
      if (gateSent) sent += 1
    }
    // The control: one of the three DID send, so "they agree" is not "they both always refuse".
    expect(sent).toBe(1)
  })
})

// ------------------------------------------------------------------------------------------------
// The pepper
// ------------------------------------------------------------------------------------------------

describe('the pepper', () => {
  it('refuses to load an absent, short, half-retired or same-labelled pair, by name', () => {
    const good = 'x'.repeat(40)
    for (const env of [
      {},
      { SUPPRESSION_PEPPER: good },
      { SUPPRESSION_PEPPER_VERSION: 'v1' },
      { SUPPRESSION_PEPPER: 'short', SUPPRESSION_PEPPER_VERSION: 'v1' },
      {
        SUPPRESSION_PEPPER: good,
        SUPPRESSION_PEPPER_VERSION: 'v2',
        SUPPRESSION_PEPPER_PREVIOUS: good,
      },
      {
        SUPPRESSION_PEPPER: good,
        SUPPRESSION_PEPPER_VERSION: 'v2',
        SUPPRESSION_PEPPER_PREVIOUS_VERSION: 'v1',
      },
      {
        SUPPRESSION_PEPPER: good,
        SUPPRESSION_PEPPER_VERSION: 'v1',
        SUPPRESSION_PEPPER_PREVIOUS: `${good}y`,
        SUPPRESSION_PEPPER_PREVIOUS_VERSION: 'v1',
      },
    ]) {
      let refusal: string | null = null
      try {
        loadSuppressionPeppers(env)
      } catch (error) {
        refusal = suppressionRefusalOf(error)
      }
      expect(refusal, JSON.stringify(env)).toBe('suppression_pepper_absent')
    }
    // The control: the whole pair loads, so the refusals above are about the fault.
    expect(
      loadSuppressionPeppers({
        SUPPRESSION_PEPPER: good,
        SUPPRESSION_PEPPER_VERSION: 'v2',
        SUPPRESSION_PEPPER_PREVIOUS: `${good}y`,
        SUPPRESSION_PEPPER_PREVIOUS_VERSION: 'v1',
      }).retired?.version,
    ).toBe('v1')
  })

  it('separates the kind from the value, so one kind key cannot be another', () => {
    const pepper = keying.peppers.current
    expect(suppressionKey(pepper, 'phone', '+971590009304')).not.toBe(
      suppressionKey(pepper, 'email', '+971590009304'),
    )
    // And the separator is what stops a re-split of the pair producing one key.
    expect(suppressionKey(pepper, 'phon', 'e+971590009304')).not.toBe(
      suppressionKey(pepper, 'phone', '+971590009304'),
    )
  })

  it('refuses a value that could break the separator guarantee', () => {
    let refusal: string | null = null
    try {
      suppressionKey(keying.peppers.current, 'email', 'a\u001fb@example.com')
    } catch (error) {
      refusal = suppressionRefusalOf(error)
    }
    expect(refusal).toBe('suppression_key_not_keyable')
  })

  it('still matches a row keyed under the RETIRED pepper, which is what makes a rotation seamless', async () => {
    // Written under the fixture pepper, then read back with that pepper RETIRED and a new one current. A
    // read that consulted only the current pepper would report this key clear — which presents as a
    // promotional message to somebody who opted out, months after the rotation that caused it.
    await asStaff((uow) =>
      recordSuppression(uow, keying, {
        keyKind: 'phone',
        recipient: ROTATED.phone,
        source: 'manual',
        reason: 'Asked the front desk not to be included in offers (fixture probe).',
        actorKind: 'staff',
        actorLabel: 'Receptionist (fixture)',
        recordedAtIso: PROBE_AT_ISO,
        contactCustomerId: null,
      }),
    )
    const rotated: SuppressionKeying = {
      peppers: {
        current: { version: 'v-next', secret: 'z'.repeat(48) },
        retired: keying.peppers.current,
      },
      normalise: suppressionKeyNormaliser,
    }
    const logs = await readSuppressionLogs(sql, rotated, [
      { keyKind: 'phone', recipient: ROTATED.phone },
    ])
    const log = logs.get(ROTATED.phone)
    expect(log?.records.length).toBeGreaterThan(0)
    // The log reports the CURRENT key, so a caller that writes after reading writes forward.
    expect(log?.key).toBe(suppressionKey(rotated.peppers.current, 'phone', ROTATED.phone))
    expect(
      resolveSuppression(
        {
          key: log?.key as string,
          records: (log?.records ?? []).map((r) => ({ ...r, recordedAt: r.recordedAt as Instant })),
        },
        (PROBE_AT + 1000) as Instant,
      ).state,
    ).toBe('suppressed')

    // The control: with NO retired pepper, the same read finds nothing — so the match above is the retired
    // pepper being consulted and not the key being pepper-independent.
    const currentOnly = await readSuppressionLogs(
      sql,
      {
        peppers: { current: rotated.peppers.current, retired: null },
        normalise: suppressionKeyNormaliser,
      },
      [{ keyKind: 'phone', recipient: ROTATED.phone }],
    )
    expect(currentOnly.get(ROTATED.phone)?.records).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------
// The opt-out token
// ------------------------------------------------------------------------------------------------

describe('acceptance — the opt-out token', () => {
  const verification = { decide: decideOptOutAccess, shape: optOutTokenShape }
  /** The documentation range (RFC 5737), so no case can be attributed to a real address. */
  const ip = (n: number): string => `203.0.113.${n}`

  async function verify(args: {
    readonly token: string | null
    readonly contactId: string
    readonly requestIp: string
    readonly atIso?: string
  }) {
    return asStaff((uow) =>
      verifyOptOutToken(uow, verification, {
        token: args.token,
        requestedContactId: args.contactId,
        requestIp: args.requestIp,
        atIso: args.atIso ?? PROBE_AT_ISO,
      }),
    )
  }

  it('grants a freshly minted token for its own contact, and stores only its digest', async () => {
    const issued = await asStaff((uow) =>
      issueOptOutGrant(uow, {
        contactCustomerId: consentedId,
        channel: 'sms',
        purpose: 'preference_centre',
        issuedAtIso: PROBE_AT_ISO,
        ttlSeconds: OPT_OUT_TOKEN_TTL_SECONDS,
      }),
    )
    // The token itself is nowhere in the table; only its sha256.
    const [stored] = await sql<{ token_sha256: string }[]>`
      select token_sha256 from optout_grant where id = ${issued.grantId}::uuid
    `
    expect(stored?.token_sha256).toBe(optOutTokenDigest(issued.token))
    expect(await suppressionPlaintextLeaks(sql, [issued.token])).toEqual([])

    const granted = await verify({
      token: issued.token,
      contactId: consentedId,
      requestIp: ip(10),
    })
    expect(granted.kind).toBe('granted')

    // Thirty days, from the instant supplied rather than from `now()`.
    const [row] = await sql<{ seconds: string }[]>`
      select (extract(epoch from (expires_at - issued_at)))::bigint::text as seconds
        from optout_grant where id = ${issued.grantId}::uuid
    `
    expect(Number(row?.seconds)).toBe(OPT_OUT_TOKEN_TTL_SECONDS)
    await asStaff((uow) => revokeOptOutGrant(uow, { grantId: issued.grantId, reason: 'fixture' }))
  })

  it('refuses a revoked token, and the audit row for the minting survives the revocation', async () => {
    const issued = await asStaff((uow) =>
      issueOptOutGrant(uow, {
        contactCustomerId: consentedId,
        channel: 'sms',
        purpose: 'preference_centre',
        issuedAtIso: PROBE_AT_ISO,
        ttlSeconds: OPT_OUT_TOKEN_TTL_SECONDS,
      }),
    )
    const before = await auditCount(SUPPRESSION_AUDIT_ACTIONS.grantIssued)
    await asStaff((uow) => revokeOptOutGrant(uow, { grantId: issued.grantId, reason: 'fixture' }))
    // The mint's audit row is untouched by the revoke: `audit_event` is append-only, so a link that should
    // never have been minted is removed and the record that somebody minted it stays.
    expect(await auditCount(SUPPRESSION_AUDIT_ACTIONS.grantIssued)).toBe(before)
    const refused = await verify({
      token: issued.token,
      contactId: consentedId,
      requestIp: ip(11),
    })
    expect(refused).toMatchObject({ kind: 'refused', reason: 'token_unknown' })
    // A second revoke is an error, not a no-op.
    const error = await asStaff((uow) =>
      revokeOptOutGrant(uow, { grantId: issued.grantId, reason: 'fixture' }),
    ).catch((err: unknown) => err)
    expect(suppressionRefusalOf(error)).toBe('optout_grant_not_found')
  })

  it('refuses a valid token presented for ANOTHER contact page', async () => {
    const issued = await asStaff((uow) =>
      issueOptOutGrant(uow, {
        contactCustomerId: consentedId,
        channel: 'sms',
        purpose: 'preference_centre',
        issuedAtIso: PROBE_AT_ISO,
        ttlSeconds: OPT_OUT_TOKEN_TTL_SECONDS,
      }),
    )
    const crossed = await verify({
      token: issued.token,
      contactId: suppressedId,
      requestIp: ip(12),
    })
    expect(crossed).toMatchObject({ kind: 'refused', reason: 'token_not_for_this_contact' })
    // The positive control: the same token, for its own contact, is granted — so the refusal is the
    // mismatch and not a token that never worked.
    expect(
      (await verify({ token: issued.token, contactId: consentedId, requestIp: ip(13) })).kind,
    ).toBe('granted')
    await asStaff((uow) => revokeOptOutGrant(uow, { grantId: issued.grantId, reason: 'fixture' }))
  })

  it('records every attempt, including the refusals, with a named outcome', async () => {
    const address = ip(14)
    await sql`delete from optout_verification_attempt where request_ip = ${address}::inet`
    await verify({ token: null, contactId: consentedId, requestIp: address })
    await verify({ token: 'not-a-token', contactId: consentedId, requestIp: address })
    const rows = await sql<{ outcome: string }[]>`
      select outcome from optout_verification_attempt where request_ip = ${address}::inet
       order by attempted_at, outcome
    `
    expect(rows.map((row) => row.outcome).sort()).toEqual(['token_absent', 'token_malformed'])
    for (const row of rows) {
      expect(OPT_OUT_ATTEMPT_OUTCOMES as readonly string[]).toContain(row.outcome)
    }
    await sql`delete from optout_verification_attempt where request_ip = ${address}::inet`
  })

  it('refuses the 11th verification from one address inside a minute, by name', async () => {
    const address = ip(20)
    await sql`delete from optout_verification_attempt where request_ip = ${address}::inet`
    const issued = await asStaff((uow) =>
      issueOptOutGrant(uow, {
        contactCustomerId: consentedId,
        channel: 'sms',
        purpose: 'preference_centre',
        issuedAtIso: PROBE_AT_ISO,
        ttlSeconds: OPT_OUT_TOKEN_TTL_SECONDS,
      }),
    )
    // Ten GENUINE verifications, all inside one second of frozen time. Genuine on purpose: a limit that
    // only counted failures would be no limit at all against somebody with a working link.
    for (let i = 0; i < OPTOUT_VERIFY_MAX_PER_IP; i += 1) {
      const result = await verify({
        token: issued.token,
        contactId: consentedId,
        requestIp: address,
        atIso: PROBE_AT_ISO,
      })
      expect(result.kind, `attempt ${i + 1}`).toBe('granted')
    }
    const refused = await verify({
      token: issued.token,
      contactId: consentedId,
      requestIp: address,
      atIso: PROBE_AT_ISO,
    })
    expect(refused.kind).toBe('rate_limited')
    if (refused.kind !== 'rate_limited') return
    expect(refused.limit).toBe('ip')
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    expect(refused.retryAfterSeconds).toBeLessThanOrEqual(OPTOUT_VERIFY_WINDOW_SECONDS)
    // Recorded as an attempt too, so a flood is countable afterwards.
    const [counted] = await sql<{ n: string }[]>`
      select count(*)::text as n from optout_verification_attempt
       where request_ip = ${address}::inet and outcome = 'rate_limited'
    `
    expect(Number(counted?.n)).toBe(1)

    // Two controls. The window SLIDES: the same address one window later is served again.
    const later = new Date(
      Date.parse(PROBE_AT_ISO) + (OPTOUT_VERIFY_WINDOW_SECONDS + 1) * 1000,
    ).toISOString()
    expect(
      (
        await verify({
          token: issued.token,
          contactId: consentedId,
          requestIp: address,
          atIso: later,
        })
      ).kind,
    ).toBe('granted')
    // And the limit is PER ADDRESS: a different address is unaffected by this one's flood.
    expect(
      (
        await verify({
          token: issued.token,
          contactId: consentedId,
          requestIp: ip(21),
          atIso: PROBE_AT_ISO,
        })
      ).kind,
    ).toBe('granted')

    await asStaff((uow) => revokeOptOutGrant(uow, { grantId: issued.grantId, reason: 'fixture' }))
    for (const address_ of [address, ip(21)]) {
      await sql`delete from optout_verification_attempt where request_ip = ${address_}::inet`
    }
  })

  it('refuses a thousand forged tokens through the REAL lookup', async () => {
    const issued = await asStaff((uow) =>
      issueOptOutGrant(uow, {
        contactCustomerId: consentedId,
        channel: 'sms',
        purpose: 'preference_centre',
        issuedAtIso: PROBE_AT_ISO,
        ttlSeconds: OPT_OUT_TOKEN_TTL_SECONDS,
      }),
    )
    const address = ip(30)
    await sql`delete from optout_verification_attempt where request_ip = ${address}::inet`
    const base = Date.parse(PROBE_AT_ISO)
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    let refused = 0
    for (let i = 0; i < 1000; i += 1) {
      const position = i % issued.token.length
      const replacement = alphabet[(i * 11 + 3) % alphabet.length] as string
      const forged =
        issued.token[position] === replacement
          ? `${issued.token.slice(0, position)}${replacement === 'A' ? 'B' : 'A'}${issued.token.slice(position + 1)}`
          : `${issued.token.slice(0, position)}${replacement}${issued.token.slice(position + 1)}`
      expect(forged, `forgery ${i} reproduced the real token`).not.toBe(issued.token)
      // The clock advances ten seconds per attempt, so a thousand verifications from one address never
      // trip the ten-a-minute limit — and the advance is free, because `atIso` is an argument and the
      // window is judged against it rather than against a clock this process read.
      const result = await verify({
        token: forged,
        contactId: consentedId,
        requestIp: address,
        atIso: new Date(base + i * 10_000).toISOString(),
      })
      expect(result.kind, `forgery ${i}`).toBe('refused')
      if (result.kind === 'refused') refused += 1
    }
    expect(refused).toBe(1000)
    // The control, and it is the whole reason the thousand means anything: the UNMUTATED token is granted
    // through the same path, so "everything is refused" cannot be why the loop is green.
    expect(
      (
        await verify({
          token: issued.token,
          contactId: consentedId,
          requestIp: ip(31),
          atIso: PROBE_AT_ISO,
        })
      ).kind,
    ).toBe('granted')

    await asStaff((uow) => revokeOptOutGrant(uow, { grantId: issued.grantId, reason: 'fixture' }))
    for (const address_ of [address, ip(31)]) {
      await sql`delete from optout_verification_attempt where request_ip = ${address_}::inet`
    }
    // An explicit timeout, above the suite's 30,000 ms: this case is a thousand round trips — a count, a
    // lookup and an insert each — and the integration config's default is sized for a case that makes a
    // handful. It is a ceiling on a hang and not a performance budget; nothing here measures a clock, and
    // the three tests in this repository that have failed for want of a spare core are the reason it is
    // stated rather than inherited.
  }, 120_000)

  it('prunes the attempt window, which is the only cleanup this unit needs', async () => {
    const address = ip(40)
    await verify({ token: null, contactId: consentedId, requestIp: address })
    const removed = await pruneOptOutVerificationAttempts(sql, {
      beforeIso: new Date(Date.parse(PROBE_AT_ISO) + 1000).toISOString(),
    })
    expect(removed).toBeGreaterThan(0)
    const [left] = await sql<{ n: string }[]>`
      select count(*)::text as n from optout_verification_attempt
       where request_ip = ${address}::inet
    `
    expect(Number(left?.n)).toBe(0)
  })
})

// ------------------------------------------------------------------------------------------------
// The preference centre
// ------------------------------------------------------------------------------------------------

describe('acceptance — the preference centre writes both halves', () => {
  it('an unsubscribe withdraws consent AND suppresses, and the send is then refused', async () => {
    const recipient = normalisePhone(LINK_HOLDER.phone)
    const at = instantFromIso('2099-09-22T10:00:00.000Z')
    const atIso = '2099-09-22T10:00:00.000Z'

    // Before: the contact is consented and clear, so the send would go. Asserted rather than assumed —
    // an unsubscribe test whose subject was already blocked would pass against a no-op.
    //
    // Asserted POINT-IN-TIME rather than as an empty log, and that is not a workaround. A second run of
    // this file leaves the rows this case and the next one wrote, at their own fixed instants, so `records
    // is empty` is true once and false afterwards. `clear at an instant before the change` is true on
    // every run and is the stronger claim anyway: it is the same question the send path asks.
    const beforeLogs = await readSuppressionLogs(sql, keying, [{ keyKind: 'phone', recipient }])
    const beforeLog = beforeLogs.get(recipient)
    expect(beforeLog).toBeDefined()
    expect(
      resolveSuppression(
        {
          key: beforeLog?.key as string,
          records: (beforeLog?.records ?? []).map((r) => ({
            ...r,
            recordedAt: r.recordedAt as Instant,
          })),
        },
        (at - 1000) as Instant,
      ).state,
    ).toBe('clear')
    const beforeConsent = resolveConsent(
      {
        contactId: linkHolderId,
        records: (await readConsentLog(sql, linkHolderId)).records.map((r) => ({
          ...r,
          recordedAt: r.recordedAt as Instant,
        })),
        wordingVersions: (await readConsentLog(sql, linkHolderId)).wordingVersions,
      },
      'sms',
      'marketing',
      // One millisecond before the change, for the reason the suppression assertion above gives: the
      // withdrawal this case writes is stamped AT `at`, so resolving at `at` on a second run reads that
      // run's own withdrawal and the "before" claim would be about the wrong instant.
      (at - 1000) as Instant,
    )
    expect(beforeConsent.state).toBe('granted')

    const result = await asStaff((uow) =>
      applyPreferenceCentreChange(uow, keying, {
        contactCustomerId: linkHolderId,
        action: 'unsubscribe',
        recipient,
        keyKind: 'phone',
        locale: 'en',
        decidedAtIso: atIso,
      }),
    )
    // Three channels × two send-gating purposes. Counted in SQL at the instant of the change rather than
    // read off the return value, because the return value counts rows this CALL wrote and a second run of
    // this file writes none — the instant is fixed, so `consent_one_record_per_instant` collapses it. What
    // has to be true either way is that the six withdrawals exist.
    expect(result.consentRows === 6 || result.consentRows === 0).toBe(true)
    const [withdrawals] = await sql<{ n: string }[]>`
      select count(*)::text as n from consent
       where contact_customer_id = ${linkHolderId}::uuid and kind = 'withdrawn'
         and recorded_at = ${atIso}::timestamptz and capture_source = 'preference_centre'
    `
    expect(Number(withdrawals?.n)).toBe(6)

    const afterConsent = await readConsentLog(sql, linkHolderId)
    const consentAfter: ConsentResolution = resolveConsent(
      {
        contactId: afterConsent.contactId,
        records: afterConsent.records.map((r) => ({ ...r, recordedAt: r.recordedAt as Instant })),
        wordingVersions: afterConsent.wordingVersions,
      },
      'sms',
      'marketing',
      (at + 1000) as Instant,
    )
    expect(consentAfter.state).toBe('withdrawn')

    const afterLogs = await readSuppressionLogs(sql, keying, [{ keyKind: 'phone', recipient }])
    const log = afterLogs.get(recipient)
    expect((log?.records ?? []).some((r) => r.source === 'preference_centre')).toBe(true)
    expect(
      resolveSuppression(
        {
          key: log?.key as string,
          records: (log?.records ?? []).map((r) => ({ ...r, recordedAt: r.recordedAt as Instant })),
        },
        (at + 1000) as Instant,
      ).state,
    ).toBe('suppressed')

    // The row records the CUSTOMER as the actor, never staff: a preference-centre entry attributed to
    // anybody else would be a withdrawal nobody made.
    //
    // Narrowed to the row at THIS instant rather than `history[0]`, because the next case writes a lift at a
    // later instant and `readSuppressionHistory` returns newest first — so on a second run of the file
    // `history[0]` is the previous run's lift and not the row this case is about.
    const history = (
      await readSuppressionHistory(sql, keying, { keyKind: 'phone', recipient })
    ).filter((row) => row.recordedAt.toISOString() === atIso)
    expect(history).toHaveLength(1)
    expect(history[0]?.actorKind).toBe('customer')
    expect(history[0]?.source).toBe('preference_centre')
    // It names WHICH record the change was about, and there is one.
    expect(history[0]?.contactCustomerId).not.toBeNull()
    // It names the CURRENT contact only on the run that wrote it, and the reason is the whole design rather
    // than a concession to re-runs. `customer-identity.itest.ts` clears the whole `customer` table between
    // its cases, so `beforeAll` here re-creates this contact with a NEW uuid — while the suppression row
    // from the earlier run is still there, carrying the old one, because `suppression` refuses UPDATE for
    // every role including the owner and the unique index is on the hashed DETAIL and not on the record.
    // That is the append-only log outliving the erasure of the identity it is about (docs/04 §4, §8), and it
    // arrived here as a failing assertion the first time the whole suite ran in order — which is a better
    // demonstration of the property than any case written to assert it directly.
    if (result.suppressionRecorded) expect(history[0]?.contactCustomerId).toBe(linkHolderId)

    // And it is idempotent at one instant: a double-clicked link is one row, whatever the run.
    const again = await asStaff((uow) =>
      applyPreferenceCentreChange(uow, keying, {
        contactCustomerId: linkHolderId,
        action: 'unsubscribe',
        recipient,
        keyKind: 'phone',
        locale: 'en',
        decidedAtIso: atIso,
      }),
    )
    expect(again.consentRows).toBe(0)
    expect(again.suppressionRecorded).toBe(false)
  })

  it('a resubscribe grants consent under the CURRENT wording and lifts the suppression', async () => {
    const recipient = normalisePhone(LINK_HOLDER.phone)
    const atIso = '2099-09-23T10:00:00.000Z'
    const at = instantFromIso(atIso)
    const result = await asStaff((uow) =>
      applyPreferenceCentreChange(uow, keying, {
        contactCustomerId: linkHolderId,
        action: 'resubscribe',
        recipient,
        keyKind: 'phone',
        locale: 'ar',
        decidedAtIso: atIso,
      }),
    )
    // Counted in SQL below rather than read off the return value, for the reason the unsubscribe case
    // states: a second run of this file writes nothing new at this fixed instant.
    expect(result.consentRows === 6 || result.consentRows === 0).toBe(true)

    const afterLogs = await readSuppressionLogs(sql, keying, [{ keyKind: 'phone', recipient }])
    const log = afterLogs.get(recipient)
    expect(
      resolveSuppression(
        {
          key: log?.key as string,
          records: (log?.records ?? []).map((r) => ({ ...r, recordedAt: r.recordedAt as Instant })),
        },
        (at + 1000) as Instant,
      ).state,
    ).toBe('clear')
    // Both rows survive: the suppression and the lift. A resubscribe that had edited the first row could
    // not answer "when did they opt out" afterwards. Narrowed to the two instants the preference-centre
    // cases write, for the reason the unsubscribe case states about its own filter.
    const history = (
      await readSuppressionHistory(sql, keying, { keyKind: 'phone', recipient })
    ).filter((row) => ['2099-09-22T10:00:00.000Z', atIso].includes(row.recordedAt.toISOString()))
    expect(history.map((row) => row.kind)).toEqual(['unsuppressed', 'suppressed'])
    expect(history[0]?.source).toBe('preference_centre')
    // The grant carries the wording version, which is what `consent_grant_carries_its_wording` demands.
    const grants = await sql<{ n: string }[]>`
      select count(*)::text as n from consent
       where contact_customer_id = ${linkHolderId}::uuid and kind = 'granted'
         and recorded_at = ${atIso}::timestamptz and consent_wording_id is not null
    `
    expect(Number(grants[0]?.n)).toBe(6)
  })
})
