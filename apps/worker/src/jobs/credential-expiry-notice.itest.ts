import { createConnection, readCredentialExpiryNotices, type Sql } from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type CredentialNoticeDelivery,
  credentialNoticeMessageId,
  NO_DELIVERY_WIRED,
  NO_STAFF_CONTACT_ON_FILE,
  runCredentialExpiryNotices,
  type StaffRecipientResolver,
} from './credential-expiry-notice.ts'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * P-HR-14 — the credential-expiry notice pass, and the one claim that is the whole acceptance line:
 * **a second run sends nothing.**
 *
 * ## It is proved against a FAKE OUTBOX and not against a count
 *
 * The acceptance line says "proven against the fake SMS outbox", and the distinction matters. A case that
 * counted `credential_expiry_notice` rows would pass against a pass that inserted nothing and sent
 * twice — which is the exact failure the ordering in that file exists to prevent. So the recipient
 * resolver and the delivery are both injected, the delivery RECORDS every call, and the assertion is that
 * the recording is empty on the second run.
 *
 * ## The two controls
 *
 * The first run must send, or "the second sent nothing" is satisfied by a pass that never sends. And the
 * shipped resolver must answer `none`, or the send path asserted here is not the one production takes —
 * which is the honest statement about this unit: nothing in this build holds a staff phone number, so the
 * send branch exists and is exercised by a resolver a test supplies.
 *
 * ## Nothing is deleted
 *
 * `credential_expiry_notice` raises ZY841 on DELETE (0163) and `employee_document` pins the employee. The
 * isolation is a per-run marker in the staff reference and a per-run document expiry, which is
 * `staff-portal.itest.ts`'s arrangement and the reason it gives.
 */

const sql: Sql = createConnection({ url, max: 2 })

const RUN = Math.floor(Math.random() * 1_000_000)
const MARKER = `phr14-notice-${RUN}`

/** The instant every run is driven at. Inside the seeded trading calendar, so `business_day` has a row. */
let AT_ISO = ''

interface Recorded {
  readonly messageId: string
  readonly recipient: string
  readonly expiresOn: string
}

let employeeId = ''
let documentId = ''
let windowDays = 0
/** An expiry inside the configured window as measured from {@link AT_ISO}. */
let expiresOn = ''

/** A delivery that records and reports success, so the pass's send branch is exercised and visible. */
function recordingDelivery(): {
  readonly delivery: CredentialNoticeDelivery
  readonly calls: Recorded[]
} {
  const calls: Recorded[] = []
  return {
    calls,
    delivery: async (args) => {
      calls.push({
        messageId: args.messageId,
        recipient: args.recipient,
        expiresOn: args.expiresOn,
      })
      return { kind: 'sent', providerMessageId: `fake-${calls.length}` }
    },
  }
}

const RECIPIENT = '+971500000002'
const withRecipient: StaffRecipientResolver = async () => ({
  kind: 'recipient',
  recipient: RECIPIENT,
})

beforeAll(async () => {
  // The newest trading date the seeded calendar holds, so `businessDayAt` finds a session. Read rather
  // than written: a date this file chose would need its own `business_day` row, and generating one is
  // another unit's function.
  const [day] = await sql<{ tradingDate: string; opensAt: Date }[]>`
    select trading_date::text as "tradingDate", opens_at as "opensAt"
      from business_day order by trading_date desc limit 1
  `
  if (day === undefined) {
    throw new Error(
      'business_day holds no trading session, so this file has no instant to drive the pass at. Run ' +
        '`pnpm seed` — the pass refuses an instant with no session rather than dating a notice on the ' +
        "instant's own calendar date.",
    )
  }
  AT_ISO = new Date(day.opensAt.getTime() + 60 * 60 * 1000).toISOString()

  const [employee] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from)
    values (${`${MARKER} subject`}, '2024-01-01'::date)
    returning id::text as id
  `
  if (employee === undefined) throw new Error('Inserting the fixture employee returned no row.')
  employeeId = employee.id

  // The configured window, read from the same place the pass reads it. Hard-coding 60 here would make
  // this file disagree with the setting the moment somebody changed it, and the expiry below is computed
  // FROM the window so the evaluator's verdict is EXPIRING_SOON by construction.
  const { readCredentialPolicy } = await import('@berelax/db')
  windowDays = (await readCredentialPolicy(sql)).expiringSoonDays
  expiresOn = new Date(Date.parse(AT_ISO) + (windowDays - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10)

  const [document] = await sql<{ id: string }[]>`
    insert into employee_document (employee_id, document_type, expires_on)
    values (${employeeId}::uuid, 'labour_card', ${expiresOn}::date)
    returning id::text as id
  `
  if (document === undefined) throw new Error('Inserting the fixture document returned no row.')
  documentId = document.id
}, 30_000)

afterAll(async () => {
  // Nothing is deleted: `credential_expiry_notice` raises ZY841 on DELETE and `employee_document` pins
  // the employee. The per-run marker is the isolation.
  await sql.end({ timeout: 5 })
})

describe('the credential expiry notice pass', () => {
  it('decides a notice from the evaluator at the CONFIGURED window', async () => {
    const { delivery, calls } = recordingDelivery()
    const first = await runCredentialExpiryNotices(sql, AT_ISO, {
      recipientFor: withRecipient,
      delivery,
    })
    expect(first.windowDays).toBe(windowDays)
    // The pass considered the whole file of every current employee — the reader filters on EMPLOYMENT and
    // never on the expiry, which is what makes the window the evaluator's.
    expect(first.considered).toBeGreaterThan(0)

    const mine = first.recorded.filter((row) => row.employeeDocumentId === documentId)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.windowDays).toBe(windowDays)
    expect(mine[0]?.expiresOn).toBe(expiresOn)
    expect(mine[0]?.templateKey).toBe('hr.credential_expiring')
    expect(mine[0]?.outcome).toBe('sent')

    // The FIRST control: it really sent. Without this, "the second run sent nothing" is satisfied by a
    // pass that never sends at all.
    const sentForMine = calls.filter(
      (call) =>
        call.messageId ===
        credentialNoticeMessageId({ employeeId, employeeDocumentId: documentId, windowDays }),
    )
    expect(sentForMine).toHaveLength(1)
    expect(sentForMine[0]?.recipient).toBe(RECIPIENT)
    expect(sentForMine[0]?.expiresOn).toBe(expiresOn)
  }, 30_000)

  it('sends NOTHING on a second run, which is the acceptance line', async () => {
    const { delivery, calls } = recordingDelivery()
    const second = await runCredentialExpiryNotices(sql, AT_ISO, {
      recipientFor: withRecipient,
      delivery,
    })
    // Nothing recorded for this document, and nothing attempted for it either. The second half is the one
    // a row count cannot make: the pass could have inserted nothing and still called the transport.
    expect(
      second.recorded.filter((row) => row.employeeDocumentId === documentId),
      'credential-expiry-notice-must-be-idempotent-per-window: a second pass over the same ' +
        '(employee, document, window) must record nothing',
    ).toHaveLength(0)
    expect(second.alreadyDecided).toBeGreaterThan(0)
    expect(
      calls.filter(
        (call) =>
          call.messageId ===
          credentialNoticeMessageId({ employeeId, employeeDocumentId: documentId, windowDays }),
      ),
      'credential-expiry-notice-must-be-idempotent-per-window: a second pass must SEND nothing, which ' +
        'is the half a row count cannot make',
    ).toHaveLength(0)

    // And the table still holds exactly one notice for the (employee, document, window).
    const notices = await readCredentialExpiryNotices(sql, { employeeId })
    expect(
      notices.filter(
        (row) => row.employeeDocumentId === documentId && row.windowDays === windowDays,
      ),
    ).toHaveLength(1)
  }, 30_000)

  it('writes exactly ONE audit row for the notice, across both runs', async () => {
    // A delta that must be one, counted in SQL rather than through a capped reader (brief rule 12). A
    // second run that re-decided the notice would write a second row, which is how a daily pass fills
    // the one table an insider-threat review reads.
    const noticeIds = (await readCredentialExpiryNotices(sql, { employeeId }))
      .filter((row) => row.employeeDocumentId === documentId && row.windowDays === windowDays)
      .map((row) => row.id)
    expect(noticeIds).toHaveLength(1)
    const [{ count } = { count: '0' }] = await sql<{ count: string }[]>`
      select count(*)::text as count from audit_event
       where action = 'hr.credential_expiry_notice' and entity_id = ${noticeIds[0] ?? ''}
    `
    expect(Number(count)).toBe(1)
  })

  it('records the document type NOWHERE, which is the discretion rule applied to staff', async () => {
    // Which document somebody holds is a fact about their immigration or professional status, and an
    // audit row is read by more people than the file is (docs/06 D4). The notice row has no type column
    // and the audit row's payload must not carry one either.
    const noticeIds = (await readCredentialExpiryNotices(sql, { employeeId })).map((row) => row.id)
    const rows = await sql<{ afterState: Record<string, unknown> }[]>`
      select after_state as "afterState" from audit_event
       where action = 'hr.credential_expiry_notice'
         and entity_id = any(${noticeIds}::text[])
    `
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(JSON.stringify(row.afterState)).not.toContain('labour_card')
      expect(JSON.stringify(row.afterState)).not.toContain('documentType')
    }
  })

  it('answers a DIFFERENT window as a new notice, so the window is part of the identity', async () => {
    // The control for the idempotency: a key that ignored the window would answer "already decided" here
    // too, and widening the setting would then silently never warn anybody about the documents it newly
    // covers.
    const { delivery, calls } = recordingDelivery()
    const wider = windowDays + 30
    // Through `writeSetting` rather than an INSERT: `app_setting` has a NOT NULL `tier`, the registry
    // decides it, and a hand-written row is refused by the column — which the first draft discovered.
    // It also writes the `app_setting_history` row the real path writes, so this case cannot pass
    // against a setting nothing could actually change.
    const setWindow = async (value: number) => {
      const { withUnitOfWork, writeSetting } = await import('@berelax/db')
      await withUnitOfWork(sql, { kind: 'system', label: 'credential-notice.itest' }, (uow) =>
        writeSetting(uow, {
          key: 'hr.credential_expiring_soon_days',
          value,
          role: 'owner',
          actorLabel: 'credential-notice.itest',
        }),
      )
    }
    await setWindow(wider)
    try {
      const run = await runCredentialExpiryNotices(sql, AT_ISO, {
        recipientFor: withRecipient,
        delivery,
      })
      expect(run.windowDays).toBe(wider)
      const mine = run.recorded.filter((row) => row.employeeDocumentId === documentId)
      expect(mine).toHaveLength(1)
      expect(mine[0]?.windowDays).toBe(wider)
      expect(calls.length).toBeGreaterThan(0)
    } finally {
      // Restored, because the setting is shared and every later suite reads it. `app_setting` is not
      // append-only; `app_setting_history` is, and the rows it gained are a delta nothing here asserts.
      await setWindow(windowDays)
    }
  }, 30_000)
})

describe('what the shipped runtime actually does', () => {
  it('resolves no recipient, so every notice is skipped with a reason', async () => {
    // The SECOND control, and the honest statement of this unit: no table in this build holds a staff
    // phone number or an email address, so the shipped resolver answers `none` and nothing leaves. A
    // notice table that could only record a send would be indistinguishable from a notification path
    // that does nothing (0081), which is why the skip is a row.
    expect(await NO_STAFF_CONTACT_ON_FILE({ employeeId, staffReference: MARKER })).toEqual({
      kind: 'none',
      reason: 'no_recipient_on_file',
    })

    // A second employee and document, so the skip branch is exercised on a notice no other case owns.
    const [other] = await sql<{ id: string }[]>`
      insert into employee (staff_reference, employed_from)
      values (${`${MARKER} skipped`}, '2024-01-01'::date)
      returning id::text as id
    `
    if (other === undefined)
      throw new Error('Inserting the second fixture employee returned no row.')
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${other.id}::uuid, 'labour_card', ${expiresOn}::date)
    `
    const run = await runCredentialExpiryNotices(sql, AT_ISO)
    const mine = run.recorded.filter((row) => row.employeeId === other.id)
    expect(mine).toHaveLength(1)
    expect(mine[0]?.outcome).toBe('skipped')
    expect(mine[0]?.skipReason).toBe('no_recipient_on_file')
    expect(mine[0]?.messageId).toBeNull()
    // Nothing was delivered, and nothing could have been: the default delivery REFUSES rather than
    // quietly doing nothing.
    expect(run.delivered).toHaveLength(0)
  }, 30_000)

  it('REFUSES rather than skipping when a recipient exists and no delivery is wired', async () => {
    // "The recipient exists and nothing is wired to send to them" is a configuration fault, and a skip
    // would hide it behind the state the build ships in — which is exactly the honest-failure rule this
    // batch is held to.
    await expect(
      NO_DELIVERY_WIRED({ messageId: 'x', recipient: RECIPIENT, expiresOn }),
    ).rejects.toThrow('no delivery is wired')
  })

  it('refuses an instant with no trading session rather than dating a notice on a guess', async () => {
    await expect(runCredentialExpiryNotices(sql, '1990-01-01T12:00:00.000Z')).rejects.toThrow(
      'no trading session',
    )
  })
})
