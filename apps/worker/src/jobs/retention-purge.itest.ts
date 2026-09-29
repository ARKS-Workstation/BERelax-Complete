import { createHash } from 'node:crypto'
import { createConnection, type Sql } from '@berelax/db'
import { RETENTION_PURGE_JOB } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cronRegistrations, JOB_REGISTRY } from '../registry.ts'
import { retentionRulesFor, runRetentionPurge } from './retention-purge.ts'

/**
 * C-CRM-10 — the retention purge, driven end to end against real PostgreSQL under a FROZEN clock.
 *
 * The pure tests in `packages/core/src/privacy/rights-policy.test.ts` prove the verdicts. What only a
 * database can prove is the pair the acceptance line names: that **exactly the expected row ids** are
 * removed, and that a row under legal hold is **skipped and reported** rather than quietly kept. The second
 * half is the one that needs rows, because "reported" is a field in a returned structure and "quietly kept"
 * looks identical from the table afterwards.
 *
 * ## Isolation (brief rule 12)
 *
 * The purge sweeps the WHOLE database, exactly as it does in production, so every assertion here narrows to
 * this run's own row ids — never to a total and never to "the purge removed n rows". A run is identified by
 * `RUN`, and the phone numbers are on `+971 59`, which is not an allocated UAE mobile prefix.
 *
 * The rows this file creates are `otp_challenge` and `booking_manage_grant`, both of which the purge
 * deletes and neither of which is append-only — so the file cleans up after itself, and a leftover row
 * from an interrupted run is simply purged by the next one.
 */
const md5 = (value: string): string => createHash('md5').update(value).digest('hex')

const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '') {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/** Frozen. Every date below is relative to this, so nothing depends on when the suite runs. */
const NOW_ISO = '2099-07-01T05:15:00.000Z'
/** 180 days before NOW: past the 30-day contact-channel rule and past the 90-day credential rule. */
const OLD_ISO = '2099-01-02T05:15:00.000Z'
/** 5 days before NOW: inside both. */
const RECENT_ISO = '2099-06-26T05:15:00.000Z'

const RUN = Date.now().toString(36)
/**
 * A 64-hex token unique to this RUN, for the two token columns that are UNIQUE.
 *
 * A literal like `repeat('c', 64)` collides with the row an earlier run of this file left behind, and the
 * failure arrives as a duplicate-key error in `beforeAll` that skips every case — green once, red for ever
 * after, and about nothing. Derived rather than random so a leftover row can still be recognised.
 */
const token = (label: string) => `${md5(`${RUN}:${label}:a`)}${md5(`${RUN}:${label}:b`)}`

let sql: Sql
/** The ids this run created, so every assertion can name its own rows. */
const created = {
  oldChallenge: '',
  recentChallenge: '',
  heldChallenge: '',
  oldGrant: '',
}
let heldCustomerId = ''
let holdId = ''

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })

  const phone = (suffix: number) => `+9715910${String(suffix).padStart(5, '0')}`

  const challenge = async (createdAtIso: string, suffix: number): Promise<string> => {
    const [row] = await sql<{ id: string }[]>`
      insert into otp_challenge (phone_e164, purpose, code_hash, code_salt, issued_at, expires_at,
                                 created_at)
      values (${phone(suffix)}, 'booking_verify', decode(${token(`otp${suffix}`)}, 'hex'),
              decode(${md5(`${RUN}:salt${suffix}`)}, 'hex'),
              ${createdAtIso}::timestamptz,
              ${createdAtIso}::timestamptz + interval '5 minutes', ${createdAtIso}::timestamptz)
      returning id
    `
    if (row === undefined) throw new Error('the fixture challenge was not created')
    return row.id
  }

  created.oldChallenge = await challenge(OLD_ISO, 1)
  created.recentChallenge = await challenge(RECENT_ISO, 2)

  // A booking, so a manage grant has something to hang off, and a customer so the hold has a subject.
  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${phone(3)}, 'front_desk')
    on conflict (phone_e164) do update set created_via = 'front_desk'
    returning id
  `
  heldCustomerId = customer?.id ?? ''
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source) values (${heldCustomerId}::uuid, 'front_desk')
    returning id
  `
  if (booking === undefined) throw new Error('the fixture booking was not created')
  const [grant] = await sql<{ id: string }[]>`
    insert into booking_manage_grant (booking_id, token_sha256, purpose, issued_at, expires_at,
                                      created_at)
    values (${booking.id}::uuid, ${token('grant')}, 'manage_booking', ${OLD_ISO}::timestamptz,
            ${OLD_ISO}::timestamptz + interval '1 hour', ${OLD_ISO}::timestamptz)
    returning id
  `
  created.oldGrant = grant?.id ?? ''

  // A held challenge for the same subject, and a hold naming that subject. The hold is scoped by SUBJECT
  // rather than by class so the case proves the subject scoping too, which is the half a class-wide hold
  // cannot distinguish. `booking_session` carries the customer id; `otp_challenge` does not — so the held
  // row has to be a session, which is also the more interesting case: the purge has to know whose it is.
  const [session] = await sql<{ id: string }[]>`
    insert into booking_session (token_hash, phone_e164, customer_id, verified_at, expires_at,
                                created_at)
    -- verified_at is supplied because booking_session_verification_names_a_customer ties the two columns
    -- together: a session naming a customer has had that customer's number proved. The hold has to be on a
    -- row that HAS a customer id, so the session must be a verified one.
    values (decode(${token('session')}, 'hex'), ${phone(3)}, ${heldCustomerId}::uuid,
            ${OLD_ISO}::timestamptz, ${OLD_ISO}::timestamptz + interval '1 hour',
            ${OLD_ISO}::timestamptz)
    returning id
  `
  created.heldChallenge = session?.id ?? ''

  const [hold] = await sql<{ id: string }[]>`
    insert into legal_hold (subject_customer_id, data_class, reason, placed_at, placed_by_kind,
                            placed_by_label)
    values (${heldCustomerId}::uuid, 'contact_channel',
            ${`Fixture hold for retention-purge.itest run ${RUN}: a dispute is open about this record.`},
            ${OLD_ISO}::timestamptz, 'staff', 'Owner (fixture)')
    on conflict do nothing
    returning id
  `
  holdId = hold?.id ?? ''
})

afterAll(async () => {
  // Lifted rather than deleted, because a live hold left behind would stop the purge for that subject in
  // every later run of the suite — and a hold nobody can see the reason for is worse than no hold.
  if (holdId !== '') {
    await sql`
      update legal_hold
         set lifted_at = placed_at, lifted_reason = 'Fixture hold lifted at the end of the suite.'
       where id = ${holdId}::uuid and lifted_at is null
    `
  }
  if (created.heldChallenge !== '') {
    await sql`delete from booking_session where id = ${created.heldChallenge}::uuid`
  }
  // The fixture booking, because `booking.customer_id` is ON DELETE RESTRICT. One row left here once turned
  // all eleven cases of a suite elsewhere red with a foreign-key message that named neither this file nor
  // the row, and the row still has to go whoever is next: the next suite to touch this customer meets the
  // same restriction. The grants hanging off it go first: they carry no foreign key to
  // `booking` (0067, deliberately), so nothing removes them for us.
  if (heldCustomerId !== '') {
    await sql`
      delete from booking_manage_grant
       where booking_id in (select id from booking where customer_id = ${heldCustomerId}::uuid)
    `
    await sql`delete from booking where customer_id = ${heldCustomerId}::uuid`
  }
  await sql?.end({ timeout: 5 })
})

describe('the retention rules', () => {
  it('purges only three classes, and says why each of the others is never purged', () => {
    const rules = retentionRulesFor({ financialRetentionYears: 5, clinicalRetentionYears: 25 })
    const purged = rules.filter((r) => r.retainDays !== null).map((r) => r.dataClass)
    expect(purged.sort()).toEqual(['contact_channel', 'credential', 'operational'])
    // Every rule, purging or not, says why — and the four whose whole purpose is to outlive the data they
    // are about are named, because a class missing from this list would be a class nobody decided about.
    for (const rule of rules) {
      expect(rule.why.length, rule.dataClass).toBeGreaterThan(40)
    }
    for (const never of ['financial', 'audit', 'consent_record', 'suppression_record']) {
      expect(rules.find((r) => r.dataClass === never)?.retainDays, never).toBeNull()
    }
  })

  it('ties the operational period to the FINANCIAL obligation rather than choosing a number', () => {
    const five = retentionRulesFor({ financialRetentionYears: 5, clinicalRetentionYears: 25 })
    const seven = retentionRulesFor({ financialRetentionYears: 7, clinicalRetentionYears: 25 })
    const days = (rules: ReturnType<typeof retentionRulesFor>) =>
      rules.find((r) => r.dataClass === 'operational')?.retainDays
    expect(days(five)).toBe(365 * 5)
    // The control: the figure MOVES with the profile. A literal would give the same answer twice, and a
    // retention period that ignored the profile is the defect this is built against — purging a booking an
    // invoice line points at would break the document the FTA requires be kept.
    expect(days(seven)).toBe(365 * 7)
    expect(days(seven)).not.toBe(days(five))
  })
})

describe('runRetentionPurge under a frozen clock', () => {
  it('purges exactly the expected row ids, and SKIPS the held row with the hold reported', async () => {
    const report = await runRetentionPurge(sql, NOW_ISO)

    // Named ids, never counts: the pass sweeps the whole database and earlier files leave rows behind.
    expect(report.purged).toContain(created.oldChallenge)
    expect(report.purged).toContain(created.oldGrant)
    expect(report.keptWithinRetention).toContain(created.recentChallenge)

    // The half only rows can prove. The held row is old enough to purge, belongs to a subject under a
    // hold, and is REPORTED as skipped rather than being absent from every list.
    expect(report.skippedUnderLegalHold.map((s) => s.rowId)).toContain(created.heldChallenge)
    expect(report.purged).not.toContain(created.heldChallenge)
    expect(report.keptWithinRetention).not.toContain(created.heldChallenge)

    // And the rows themselves agree with the report, which is the claim that matters: a report is only
    // worth reading if it describes what happened.
    const gone = await sql`select 1 from otp_challenge where id = ${created.oldChallenge}::uuid`
    expect(gone).toHaveLength(0)
    const kept = await sql`select 1 from otp_challenge where id = ${created.recentChallenge}::uuid`
    expect(kept).toHaveLength(1)
    const held = await sql`select 1 from booking_session where id = ${created.heldChallenge}::uuid`
    expect(held).toHaveLength(1)
    const grantGone = await sql`
      select 1 from booking_manage_grant where id = ${created.oldGrant}::uuid
    `
    expect(grantGone).toHaveLength(0)
  }, 30_000)

  it('purges the held row once the hold is LIFTED — the control for the skip', async () => {
    // Without this the case above would pass for a purge that skipped everything, or for one that could
    // not see the row at all. The hold is lifted through the real column pair (`lifted_at` and
    // `lifted_reason` are required together by `legal_hold_lifting_is_explained`), and nothing else
    // changes.
    await sql`
      update legal_hold
         set lifted_at = ${NOW_ISO}::timestamptz,
             lifted_reason = 'The dispute closed; the fixture hold is lifted to prove the control.'
       where id = ${holdId}::uuid
    `
    const report = await runRetentionPurge(sql, NOW_ISO)
    expect(report.purged).toContain(created.heldChallenge)
    expect(report.skippedUnderLegalHold.map((s) => s.rowId)).not.toContain(created.heldChallenge)
    const gone = await sql`select 1 from booking_session where id = ${created.heldChallenge}::uuid`
    expect(gone).toHaveLength(0)
  }, 30_000)

  it('is idempotent: a second pass over the same instant purges nothing new', async () => {
    const first = await runRetentionPurge(sql, NOW_ISO)
    const second = await runRetentionPurge(sql, NOW_ISO)
    // The rows this run created are gone by now, so the interesting claim is that the second pass finds
    // nothing of theirs — a reclaimed job must be safe to re-run, which is what `expireInSeconds` assumes.
    for (const id of Object.values(created)) {
      expect(second.purged).not.toContain(id)
    }
    expect(first.purged.filter((id) => second.purged.includes(id))).toEqual([])
  }, 30_000)
})

describe('the job registration', () => {
  it('is scheduled, watched, and named by the one constant the settings registry also names', () => {
    const definition = JOB_REGISTRY.find((job) => job.name === RETENTION_PURGE_JOB)
    expect(definition).toBeDefined()
    // A cron with no agent is a cron nobody watches and nothing caps (G-AGT-01), and `pnpm jobs` refuses
    // one statically. Asserted here too because the static check reads source and this reads the registry.
    expect(definition?.cron).toBeDefined()
    expect(definition?.agent).toBe('retention_purge')
    // After trading closes at 02:00 and after the other nightly passes, so they do not contend.
    expect(definition?.cron).toBe('15 5 * * *')
    expect(cronRegistrations().some((r) => r.name === RETENTION_PURGE_JOB)).toBe(true)
  })

  it('has an agent row and a heartbeat row, or the watchdog silently never checks it', async () => {
    const [agent] = await sql<{ intervalSeconds: number; budget: number }[]>`
      select expected_interval_seconds as "intervalSeconds", budget_fils_per_run as budget
        from agent_definition where agent_key = 'retention_purge'
    `
    expect(Number(agent?.intervalSeconds)).toBe(60 * 60 * 24)
    // Zero fils, and stated rather than incidental: the purge makes no external call and consults no
    // model, so a non-zero budget would make the spend report wrong about where money goes.
    expect(Number(agent?.budget)).toBe(0)
    // 0031's note, which every later agent has to repeat: `agentsWithHeartbeat` INNER joins, so an agent
    // with no heartbeat row does not appear, and one that does not appear is never checked.
    const heartbeat = await sql`select 1 from agent_heartbeat where agent_key = 'retention_purge'`
    expect(heartbeat).toHaveLength(1)
  })
})
