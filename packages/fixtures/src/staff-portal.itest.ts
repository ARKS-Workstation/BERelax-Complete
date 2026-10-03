import { HUNDREDTHS_PER_DAY, localDate, PORTAL_SURFACES, portalRefusalOf } from '@berelax/core'
import {
  type Actor,
  createConnection,
  readCredentialExpiryNotices,
  readTradingDayWindows,
  recordCredentialExpiryNotice,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import {
  readPortalBank,
  readPortalCommission,
  readPortalLeave,
  readPortalPayslips,
  readPortalSchedule,
  submitLeaveRequest,
  tradingHoursFromWindows,
} from '@berelax/hr'
import { AppError } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/**
 * P-HR-14 — a therapist cannot read another therapist's row, proved against real PostgreSQL.
 *
 * ## Why this file exists rather than a unit test over the predicate
 *
 * `packages/core/src/hr/self-service.test.ts` asserts the RULE: every role, every surface, a colleague's
 * subject refused. That is a claim about a function. The claim the acceptance line makes is stronger —
 * *"every portal route requested with another employee's id returns a refusal, enumerated across schedule,
 * leave, commission and payslip routes"* — and it is only provable where the rows exist.
 *
 * So every case here runs with the colleague's rows **present**: a shift they are rostered on, a leave
 * request they filed, a balance on their ledger, a bank account on their file. That is the whole point — a
 * refusal against an empty table is indistinguishable from an empty table, and a reader scoped by a WHERE
 * clause would pass a suite that asserted only "I got no rows back".
 *
 * Each refusal is therefore paired with TWO controls: the colleague reading their OWN row gets it, so the
 * row is really there and really readable through the same function; and the viewer reading their own
 * surface gets their own rows, so the reader works at all.
 *
 * ## Nothing here is deleted, and that is the schema's position rather than laziness
 *
 * Five of the tables this file writes refuse DELETE outright. `rota_version` and
 * `rota_version_assignment` raise on it (0081), `leave_movement` raises ZH001 for every role (0066),
 * `leave_request` has DELETE revoked from the application role (0030), and `credential_expiry_notice`
 * raises ZY841 (0163, this unit's). Brief rule 9 is explicit that a suite over an append-only table
 * asserts a DELTA and does not try to delete, which is `hr-leave-approval.itest.ts`'s arrangement too —
 * *"`leave_request`, `leave_approval`, every notice and every employee stay"*.
 *
 * So the isolation is in the VALUES rather than in a teardown: {@link MARKER} is per-run and appears in
 * every value that has to be unique — the staff references, the rota period, the document expiry. Two runs
 * cannot collide, and every assertion in the file is a delta or is scoped to this run's own ids.
 *
 * It also means this file uses NO `createFixturePrincipal`. That helper promises a `cleanup()`, and an
 * employee carrying a `leave_movement` cannot be deleted — `leave_movement.employee_id` is
 * `on delete restrict` — so the promise would be one this file could not keep, and the first draft
 * discovered that by failing in `afterAll` three lines before the statement that mattered. The portal
 * readers take a `{ role, employeeId }` and no session, so a plain employee row is all they need; the
 * admin ROUTES are where a session matters and `apps/web/src/session.itest.ts` is where that is driven.
 */

const sql: Sql = createConnection({ url, max: 4 })

const ACTOR: Actor = { kind: 'system', label: 'staff-portal.itest' }

/**
 * Per-run, and it appears in every value that must be unique across runs.
 *
 * `hr-leave-approval.itest.ts`'s `RUN`, for its reason: a staff reference, a rota period and a document
 * expiry from two runs cannot coexist under the constraints that hold them.
 */
const RUN = Math.floor(Math.random() * 1_000_000)
const MARKER = `phr14-${RUN}`

/**
 * A trading date in 2088, which no other suite uses, offset by the run.
 *
 * `rota_version_number_unique_per_period` is `(from_trading_date, to_trading_date, version_no)` and
 * `rota_version` refuses DELETE, so a fixed period would collide with the previous run and the failure
 * would name the constraint rather than anything about this file.
 */
const SHIFT_DATE = new Date(Date.UTC(2088, 0, 1) + (RUN % 300) * 86_400_000)
  .toISOString()
  .slice(0, 10)

/** The expiry on this run's fixture document, so the notice's unique key cannot collide either. */
const DOCUMENT_EXPIRY = new Date(Date.UTC(2089, 0, 1) + (RUN % 300) * 86_400_000)
  .toISOString()
  .slice(0, 10)

interface Fixtures {
  /** A therapist with no shift and no bank account: the one being refused. */
  readonly viewerId: string
  /** A therapist with one of each: the one whose rows must not be readable. */
  readonly colleagueId: string
  /** A role holding `payroll:read` on every other surface, refused here all the same. */
  readonly ownerId: string
  /** A role holding `leave:approve`, which is what filing on somebody's behalf needs. */
  readonly managerId: string
  readonly colleagueLeaveRequestId: string
  readonly viewerDocumentId: string
  readonly commissionRunId: string | null
  readonly payrollRunId: string | null
}

let fixtures: Fixtures

const viewer = () => ({ role: 'therapist' as const, employeeId: fixtures.viewerId })

async function hoursFor(from: string, to: string) {
  return tradingHoursFromWindows(
    await readTradingDayWindows(sql, { fromTradingDate: from, toTradingDate: to }),
  )
}

async function makeEmployee(handle: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from)
    values (${`${MARKER} ${handle}`}, '2024-01-01'::date)
    returning id::text as id
  `
  if (row === undefined)
    throw new Error(`Inserting the fixture employee ${handle} returned no row.`)
  return row.id
}

beforeAll(async () => {
  const viewerId = await makeEmployee('viewer')
  const colleagueId = await makeEmployee('colleague')
  const ownerId = await makeEmployee('owner')
  const managerId = await makeEmployee('manager')

  /*
    A published rota version with ONE assignment, and it belongs to the colleague.

    Written here rather than through `publishRota`, which would need a coverage rule, a working-hours rule
    and a labour-cost version pinned to it and would be a test of the publisher. What this file needs is a
    row `readPortalShifts` can see, and that is `rota_version_assignment` plus a version nothing
    supersedes. The digest is COMPUTED rather than written as a label because
    rota_version_digest_is_a_sha256_hex refuses anything but 64 lower-case hex characters — which is the
    right answer: a digest that is not a digest would make the publisher's reproducibility claim a string
    comparison against a word.
  */
  const [version] = await sql<{ id: string }[]>`
    insert into rota_version
      (from_trading_date, to_trading_date, version_no, coverage_rule_effective_from,
       working_hours_rule_effective_from, labour_cost_rule_effective_from,
       forecast_labour_cost_fils, forecast_unpriced_employees, assignment_digest,
       published_at, published_by)
    select ${SHIFT_DATE}::date, ${SHIFT_DATE}::date, 1,
           (select min(effective_from) from rota_coverage_rule),
           (select min(effective_from) from working_hours_rule),
           (select min(effective_from) from labour_cost_rule),
           0, 0, encode(sha256(${MARKER}::bytea), 'hex'), now(), 'staff-portal.itest'
    returning id::text as id
  `
  if (version === undefined) throw new Error('Inserting the fixture rota version returned no row.')

  // No `returning`: `rota_version_assignment` has no id column — its key is
  // (rota_version_id, employee_id, trading_date, period).
  await sql`
    insert into rota_version_assignment (rota_version_id, employee_id, trading_date, period)
    values (
      ${version.id}::uuid,
      ${colleagueId}::uuid,
      ${SHIFT_DATE}::date,
      tstzrange(
        (${SHIFT_DATE}::date + time '11:00') at time zone 'Asia/Dubai',
        (${SHIFT_DATE}::date + time '19:00') at time zone 'Asia/Dubai',
        '[)'
      )
    )
  `

  const [leaveRequest] = await sql<{ id: string }[]>`
    insert into leave_request (employee_id, period, kind, reason)
    values (
      ${colleagueId}::uuid,
      tstzrange(
        (${SHIFT_DATE}::date + time '11:00') at time zone 'Asia/Dubai',
        (${SHIFT_DATE}::date + interval '1 day' + time '02:00') at time zone 'Asia/Dubai',
        '[)'
      ),
      'annual',
      ${MARKER}
    )
    returning id::text as id
  `
  if (leaveRequest === undefined)
    throw new Error('Inserting the fixture leave request returned no row.')

  // Thirty days on each ledger, so the balance is readable and the submission has something to spend.
  for (const employeeId of [viewerId, colleagueId]) {
    await sql`
      insert into leave_movement
        (employee_id, kind, hundredths, occurred_on, leave_year_start, created_by, source_note,
         day_basis)
      values (
        ${employeeId}::uuid, 'opening_balance', ${30 * HUNDREDTHS_PER_DAY},
        '2024-01-01'::date, '2024-01-01'::date, 'staff-portal.itest', ${MARKER},
        -- Required on an opening balance and refused on every other kind
        -- (leave_movement_day_basis_matches_kind): an imported figure has to say which DAY it counted,
        -- because a trading session that runs past midnight is not a calendar day and the two give
        -- different totals for the same leave.
        'trading_session_day'
      )
    `
  }

  /*
    A bank account on the colleague's file.

    The sealed columns hold bytes that are NOT a real envelope, and that is safe here for one reason worth
    stating: nothing in this file or in the portal decrypts one. `readPortalBankSummary` selects `label`
    and `created_at` and no sealed column at all, which is the claim this fixture exists to exercise — a
    statement that cannot return ciphertext cannot have a caller that opens it.
  */
  await sql`
    insert into employee_bank_detail
      (employee_id, label, detail_ct, detail_nonce, detail_wrapped_key, detail_kid, detail_aad_fp,
       created_by)
    values (
      ${colleagueId}::uuid, ${`${MARKER} account`},
      '\\x00'::bytea, '\\x01'::bytea, '\\x02'::bytea, 'itest-kid', 'itest-aad', 'staff-portal.itest'
    )
  `

  const [document] = await sql<{ id: string }[]>`
    insert into employee_document (employee_id, document_type, expires_on)
    values (${viewerId}::uuid, 'labour_card', ${DOCUMENT_EXPIRY}::date)
    returning id::text as id
  `
  if (document === undefined) throw new Error('Inserting the fixture document returned no row.')

  /*
    Whichever runs the database happens to hold, and null is a legitimate answer.

    The commission and payslip cases need a run id to pass to the reader. A seeded database holds none, so
    the all-zero uuid stands in — `uuid_generate_v7()` cannot produce it, so it names no row. That is
    sound for what these cases assert: the FENCE refuses before any statement is composed, which an absent
    run cannot change. The control that the reader works at all is the viewer's own read, which returns an
    empty list for a run that does not exist and does not throw.
  */
  const [commissionRun] = await sql<{ id: string }[]>`
    select id::text as id from commission_run order by computed_at desc limit 1
  `
  const [payrollRun] = await sql<{ id: string }[]>`
    select id::text as id from payroll_run order by created_at desc limit 1
  `

  fixtures = {
    viewerId,
    colleagueId,
    ownerId,
    managerId,
    colleagueLeaveRequestId: leaveRequest.id,
    viewerDocumentId: document.id,
    commissionRunId: commissionRun?.id ?? null,
    payrollRunId: payrollRun?.id ?? null,
  }
}, 30_000)

afterAll(async () => {
  // Nothing is deleted: see the header. Every table this file writes either refuses DELETE or holds rows
  // an employee this file cannot delete depends on, and the isolation is in the per-run values instead.
  await sql.end({ timeout: 5 })
})

/** A run id that names no row, for the two surfaces whose reader takes one. */
const NO_SUCH_RUN = '00000000-0000-0000-0000-000000000000'

/** Every portal read, as `(surface, call)` pairs, so the refusal is enumerated rather than listed. */
function portalReads(subjectEmployeeId: string): readonly {
  readonly surface: string
  readonly run: () => Promise<unknown>
}[] {
  return [
    {
      surface: 'schedule',
      run: () =>
        readPortalSchedule(sql, {
          viewer: viewer(),
          subjectEmployeeId,
          fromTradingDate: SHIFT_DATE,
          toTradingDate: SHIFT_DATE,
        }),
    },
    { surface: 'leave', run: () => readPortalLeave(sql, { viewer: viewer(), subjectEmployeeId }) },
    {
      surface: 'commission',
      run: () =>
        readPortalCommission(sql, {
          viewer: viewer(),
          subjectEmployeeId,
          runId: fixtures.commissionRunId ?? NO_SUCH_RUN,
        }),
    },
    {
      surface: 'payslip',
      run: () =>
        readPortalPayslips(sql, {
          viewer: viewer(),
          subjectEmployeeId,
          runId: fixtures.payrollRunId ?? NO_SUCH_RUN,
          actor: ACTOR,
        }),
    },
    { surface: 'bank', run: () => readPortalBank(sql, { viewer: viewer(), subjectEmployeeId }) },
  ]
}

describe("a therapist cannot read another therapist's row", () => {
  it('has the colleague rows in place, which is what makes every refusal below mean something', async () => {
    const colleague = { role: 'therapist' as const, employeeId: fixtures.colleagueId }
    const shifts = await readPortalSchedule(sql, {
      viewer: colleague,
      subjectEmployeeId: fixtures.colleagueId,
      fromTradingDate: SHIFT_DATE,
      toTradingDate: SHIFT_DATE,
    })
    expect(shifts).toHaveLength(1)
    expect(shifts[0]?.tradingDate).toBe(SHIFT_DATE)

    const leave = await readPortalLeave(sql, {
      viewer: colleague,
      subjectEmployeeId: fixtures.colleagueId,
    })
    expect(leave.requests.map((request) => request.id)).toContain(fixtures.colleagueLeaveRequestId)
    expect(leave.balanceHundredths).toBe(30 * HUNDREDTHS_PER_DAY)

    const bank = await readPortalBank(sql, {
      viewer: colleague,
      subjectEmployeeId: fixtures.colleagueId,
    })
    expect(bank.onFile).toBe(true)
    expect(bank.label).toBe(`${MARKER} account`)
  })

  it('refuses every surface for the colleague, by name, with the rows present', async () => {
    const reads = portalReads(fixtures.colleagueId)
    // Four surfaces plus the bank panel, which rides on the payslip surface. The floor is the
    // non-vacuity control for the loop: an empty enumeration would pass with nothing asserted.
    expect(reads.length).toBeGreaterThanOrEqual(PORTAL_SURFACES.length)
    for (const read of reads) {
      let thrown: unknown
      try {
        await read.run()
      } catch (error) {
        thrown = error
      }
      expect(
        thrown,
        `portal_subject_is_not_the_viewer: the ${read.surface} surface was not refused a colleague`,
      ).toBeInstanceOf(AppError)
      expect(portalRefusalOf(thrown), read.surface).toBe('portal_subject_is_not_the_viewer')
      expect((thrown as AppError).kind, read.surface).toBe('forbidden')
    }
  })

  it('returns the viewer their OWN rows on every surface, which is the second control', async () => {
    // Without this, the refusal above is satisfied by a reader that throws for everybody.
    for (const read of portalReads(fixtures.viewerId)) {
      await expect(
        read.run(),
        `${read.surface} refused the viewer their own row`,
      ).resolves.toBeDefined()
    }
    const own = await readPortalSchedule(sql, {
      viewer: viewer(),
      subjectEmployeeId: fixtures.viewerId,
      fromTradingDate: SHIFT_DATE,
      toTradingDate: SHIFT_DATE,
    })
    // And the viewer sees NONE of the colleague's shifts — the half a filter would also pass. Asserted
    // anyway, because the two together say the reader is both scoped and fenced.
    expect(own).toHaveLength(0)
    const ownBank = await readPortalBank(sql, {
      viewer: viewer(),
      subjectEmployeeId: fixtures.viewerId,
    })
    expect(ownBank.onFile).toBe(false)
    expect(ownBank.label).toBeNull()
  })

  it('refuses an OWNER the portal of somebody else, so the fence is not about the role', async () => {
    const owner = { role: 'owner' as const, employeeId: fixtures.ownerId }
    let thrown: unknown
    try {
      await readPortalLeave(sql, { viewer: owner, subjectEmployeeId: fixtures.colleagueId })
    } catch (error) {
      thrown = error
    }
    expect(portalRefusalOf(thrown)).toBe('portal_subject_is_not_the_viewer')
    // The control: the owner reads their own. `owner` holds `permissions: 'all'`, so a fence with a
    // permission in it would have let the call above through.
    await expect(
      readPortalLeave(sql, { viewer: owner, subjectEmployeeId: fixtures.ownerId }),
    ).resolves.toBeDefined()
  })

  it('never returns a sealed bank column, because the statement cannot select one', async () => {
    const bank = await readPortalBank(sql, {
      viewer: { role: 'therapist', employeeId: fixtures.colleagueId },
      subjectEmployeeId: fixtures.colleagueId,
    })
    // The view's key set is fixed and holds no sealed column, and the mask has no alphanumeric character
    // in it — so there is no field an account number could arrive in and nothing to un-mask.
    expect(Object.keys(bank).sort()).toEqual(['filedOn', 'label', 'maskedNumber', 'onFile'])
    expect(bank.maskedNumber).not.toMatch(/[0-9A-Za-z]/)
  })
})

describe('filing leave reserves the days in the same transaction', () => {
  it('writes the request and the reserved movement together, and moves the balance', async () => {
    const before = await readPortalLeave(sql, {
      viewer: viewer(),
      subjectEmployeeId: fixtures.viewerId,
    })
    const outcome = await submitLeaveRequest(sql, {
      viewer: viewer(),
      subjectEmployeeId: fixtures.viewerId,
      kind: 'annual',
      from: localDate('2088-06-03'),
      to: localDate('2088-06-05'),
      submittedOn: localDate('2088-05-01'),
      employedFrom: localDate('2024-01-01'),
      hoursFor: await hoursFor('2088-06-03', '2088-06-05'),
      actor: ACTOR,
      createdBy: 'staff-portal.itest',
    })
    expect(outcome.kind).toBe('submitted')
    if (outcome.kind !== 'submitted') return
    // Pending, always: a row inserted as approved would skip every rule in `approveLeaveRequest`.
    expect(outcome.status).toBe('pending')
    expect(outcome.reservationMovementId).not.toBeNull()
    // Signed as the movement stored it. `leave_movement_sign_matches_kind` refuses a positive `reserved`.
    expect(outcome.reservedHundredths).toBe(-3 * HUNDREDTHS_PER_DAY)

    const after = await readPortalLeave(sql, {
      viewer: viewer(),
      subjectEmployeeId: fixtures.viewerId,
    })
    // A DELTA and not a total (brief rule 9): three days out of the balance and three days reserved.
    expect((after.balanceHundredths ?? 0) - (before.balanceHundredths ?? 0)).toBe(
      -3 * HUNDREDTHS_PER_DAY,
    )
    expect((after.reservedHundredths ?? 0) - (before.reservedHundredths ?? 0)).toBe(
      3 * HUNDREDTHS_PER_DAY,
    )
    expect(after.requests.some((request) => request.id === outcome.leaveRequestId)).toBe(true)
  })

  it('reserves NOTHING for unpaid leave, which is not drawn from the annual ledger', async () => {
    // The defect this case caught: the first version reserved `days * 100` for every kind, so three days
    // of unpaid leave cost three days of annual entitlement — against a ledger those days were never
    // earned on, in a table nothing can take a row back from (ZH001).
    const before = await readPortalLeave(sql, {
      viewer: viewer(),
      subjectEmployeeId: fixtures.viewerId,
    })
    const outcome = await submitLeaveRequest(sql, {
      viewer: viewer(),
      subjectEmployeeId: fixtures.viewerId,
      kind: 'unpaid',
      from: localDate('2088-07-03'),
      to: localDate('2088-07-05'),
      submittedOn: localDate('2088-05-01'),
      employedFrom: localDate('2024-01-01'),
      hoursFor: await hoursFor('2088-07-03', '2088-07-05'),
      actor: ACTOR,
      createdBy: 'staff-portal.itest',
    })
    expect(outcome.kind).toBe('submitted')
    if (outcome.kind !== 'submitted') return
    expect(outcome.reservationMovementId).toBeNull()
    expect(outcome.reservedHundredths).toBe(0)
    const after = await readPortalLeave(sql, {
      viewer: viewer(),
      subjectEmployeeId: fixtures.viewerId,
    })
    expect((after.balanceHundredths ?? 0) - (before.balanceHundredths ?? 0)).toBe(0)
    // The control: the request itself WAS written, so "nothing reserved" is not "nothing happened".
    expect(after.requests.some((request) => request.id === outcome.leaveRequestId)).toBe(true)
  })

  it('refuses a request it cannot fund, and writes NEITHER row', async () => {
    const [{ count: before } = { count: '0' }] = await sql<{ count: string }[]>`
      select count(*)::text as count from leave_request
       where employee_id = ${fixtures.viewerId}::uuid
    `
    const outcome = await submitLeaveRequest(sql, {
      viewer: viewer(),
      subjectEmployeeId: fixtures.viewerId,
      kind: 'annual',
      from: localDate('2088-08-03'),
      // Ninety days against what is left of a thirty-day balance.
      to: localDate('2088-10-31'),
      submittedOn: localDate('2088-05-01'),
      employedFrom: localDate('2024-01-01'),
      hoursFor: await hoursFor('2088-08-03', '2088-10-31'),
      actor: ACTOR,
      createdBy: 'staff-portal.itest',
    })
    expect(outcome).toMatchObject({ kind: 'refused' })
    if (outcome.kind === 'refused') expect(outcome.verdict.refusal).toBe('insufficient_balance')
    const [{ count: after } = { count: '0' }] = await sql<{ count: string }[]>`
      select count(*)::text as count from leave_request
       where employee_id = ${fixtures.viewerId}::uuid
    `
    // Counted in SQL rather than through a capped reader (brief rule 12), and as a delta of zero.
    expect(Number(after) - Number(before)).toBe(0)
  })

  it('refuses a therapist filing for somebody else, and allows a role holding leave:approve', async () => {
    let thrown: unknown
    try {
      await submitLeaveRequest(sql, {
        viewer: viewer(),
        subjectEmployeeId: fixtures.colleagueId,
        kind: 'unpaid',
        from: localDate('2088-09-10'),
        to: localDate('2088-09-10'),
        submittedOn: localDate('2088-05-01'),
        employedFrom: localDate('2024-01-01'),
        hoursFor: await hoursFor('2088-09-10', '2088-09-10'),
        actor: ACTOR,
        createdBy: 'staff-portal.itest',
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).details['refusal']).toBe('on_behalf_requires_leave_approve')

    // The control: the same call from a role that holds `leave:approve` is accepted. `unpaid`, so the
    // colleague's annual balance is untouched and this file's other deltas stay readable.
    const filed = await submitLeaveRequest(sql, {
      viewer: { role: 'manager', employeeId: fixtures.managerId },
      subjectEmployeeId: fixtures.colleagueId,
      kind: 'unpaid',
      from: localDate('2088-09-10'),
      to: localDate('2088-09-10'),
      submittedOn: localDate('2088-05-01'),
      employedFrom: localDate('2024-01-01'),
      hoursFor: await hoursFor('2088-09-10', '2088-09-10'),
      actor: ACTOR,
      createdBy: `${MARKER} manager`,
    })
    expect(filed.kind).toBe('submitted')
    if (filed.kind !== 'submitted') return
    // The audit row records that it was on behalf, which is the fact a review asks about: a therapist did
    // not file this.
    const [audit] = await sql<{ afterState: Record<string, unknown> }[]>`
      select after_state as "afterState" from audit_event
       where entity_type = 'leave_request' and entity_id = ${filed.leaveRequestId}
       order by occurred_at desc limit 1
    `
    expect(audit?.afterState['onBehalf']).toBe(true)
  })
})

describe('the credential expiry notice table', () => {
  const record = (window: number) =>
    withUnitOfWork(sql, ACTOR, (uow) =>
      recordCredentialExpiryNotice(uow, {
        employeeId: fixtures.viewerId,
        employeeDocumentId: fixtures.viewerDocumentId,
        windowDays: window,
        expiresOn: DOCUMENT_EXPIRY,
        detectedOn: '2088-11-01',
        templateKey: 'hr.credential_expiring',
        outcome: 'skipped',
        skipReason: 'no_recipient_on_file',
        createdBy: 'staff-portal.itest',
      }),
    )

  it('is idempotent per (employee, document, window) and append-only, raising ZY841', async () => {
    const first = await record(60)
    expect(first).not.toBeNull()
    if (first === null) return
    // The second call under the same window writes nothing and answers null, which is what the pass reads
    // as "already decided" and why it sends nothing on a rerun.
    expect(await record(60)).toBeNull()
    // The control: a DIFFERENT window is a different question, so it is a new notice rather than a
    // duplicate. Without this the claim above is satisfied by a key that ignores the window entirely.
    const wider = await record(90)
    expect(wider).not.toBeNull()
    expect(wider?.windowDays).toBe(90)

    await expect(
      sql`update credential_expiry_notice set outcome = 'sent' where id = ${first.id}::uuid`,
    ).rejects.toMatchObject({ code: 'ZY841' })
    await expect(
      sql`delete from credential_expiry_notice where id = ${first.id}::uuid`,
    ).rejects.toMatchObject({ code: 'ZY841' })

    // And the reader sees both, which is the control a refusal about an unreadable row would not have.
    const notices = await readCredentialExpiryNotices(sql, { employeeId: fixtures.viewerId })
    expect(notices.map((row) => row.windowDays).sort((a, b) => a - b)).toEqual([60, 90])
  })

  it('refuses a skip with no reason before the statement', async () => {
    // The constraint name is not a sentence an operator can act on, so the repository says so first. The
    // control is the accepted call in the case above.
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        recordCredentialExpiryNotice(uow, {
          employeeId: fixtures.viewerId,
          employeeDocumentId: fixtures.viewerDocumentId,
          windowDays: 120,
          expiresOn: DOCUMENT_EXPIRY,
          detectedOn: '2088-11-01',
          templateKey: 'hr.credential_expiring',
          outcome: 'skipped',
          createdBy: 'staff-portal.itest',
        }),
      ),
    ).rejects.toThrow('must name a reason')
  })
})
