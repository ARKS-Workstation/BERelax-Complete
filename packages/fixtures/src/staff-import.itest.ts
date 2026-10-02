import { readFileSync } from 'node:fs'
import { leaveYearStart } from '@berelax/core'
import {
  type Actor,
  createConnection,
  readEligibleTherapists,
  readImportedStaffCounts,
  readReassignmentCandidates,
  type Sql,
  STAFF_IMPORT_SQLSTATE,
  STAFF_QUARANTINE_REASONS,
  STAFF_QUARANTINES,
  withUnitOfWork,
  ZERO_LEAVE_BALANCE_QUESTION,
} from '@berelax/db'
import { runImport } from '@berelax/migration'
import {
  buildStaffWorkbook,
  SEPARATOR,
  STAFF_HEADER,
  STAFF_IMPORTER_TARGETS,
  staffImporter,
} from '@berelax/migration/importers/staff'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * H-MIG-06's five acceptance lines, against a real PostgreSQL, each with a control that must fail.
 *
 * This is the only place they can be asserted. `packages/migration` may not import `@berelax/core`, so
 * the leave-year anchor the importer needs is injected here from the real `leaveYearStart`;
 * `packages/db` may not import `packages/core` either, so the availability gate and the accrual policy
 * can only be seen together from `packages/fixtures`.
 *
 * ## The one acceptance line whose answer is an ABSENCE
 *
 * *"imported bank and identity fields are encrypted at rest and unreadable by the receptionist role,
 * asserted by a field-level policy test."* This importer writes NEITHER, and that is the answer rather
 * than a gap. The staging ledger keeps `import_row.payload` for ever and no erasure reaches it (ADR
 * 0072, Y9-import-ledger), so an IBAN in a staff workbook is an IBAN in that ledger permanently —
 * strictly worse than the plaintext column `employee_bank_detail` was built to avoid, because that
 * column does not exist and this one could not be removed afterwards.
 *
 * So the field-level policy test below asserts four things rather than one: the receptionist's field
 * groups do not include either; the sealed tables hold no plaintext column at all; the schema REFUSES a
 * plaintext identity reference, measured by attempting one; and the import has no cell and no payload key
 * that could carry one. The fourth is what makes the other three about this unit.
 *
 * ## Teardown: this suite deletes nothing
 *
 * `imported_staff_row` is append-only (ZY373) and holds `employee_id` with ON DELETE RESTRICT; so does
 * `leave_movement` (ZH001 and its own RESTRICT). The employees it imports therefore stay, which is the
 * schema working — a balance that could be deleted is one nobody can reconcile. Every reference is drawn
 * per EXECUTION from a prefix no seed or fixture uses, so a second run creates different people rather
 * than asserting about the first run's; and every eligibility read is narrowed by `employeeIds` rather
 * than by deleting rows, which is `EligibilityQueryInput`'s own recorded reason.
 */

let sql: Sql

const ACTOR: Actor = { kind: 'system', label: 'H-MIG-06 staff suite' }

/**
 * Unique per EXECUTION. `employee.staff_reference` is not unique in the database, but this importer
 * QUARANTINES a reference somebody already holds — so a fixed prefix would make the second run of this
 * file quarantine every line and assert about the first run's rows.
 */
const RUN = `HMIG06-${process.pid}-${Math.floor(Math.random() * 1e6)}`
let referenceCounter = 0
const nextReference = (): string => {
  referenceCounter += 1
  return `${RUN}-${String(referenceCounter).padStart(3, '0')}`
}

const OPTIONS = {
  leaveYearStart: (args: {
    readonly startsOnAnniversary: boolean
    readonly employedFrom: string
    readonly on: string
  }): string =>
    leaveYearStart(
      {
        effectiveFrom: '1900-01-01',
        annualEntitlementDays: 30,
        monthlyAccrualHundredths: 250,
        probationMonths: 6,
        accruesDuringProbation: true,
        carryOverCapHundredths: 3000,
        carryOverExpiresAfterOneLeaveYear: false,
        leaveYearStartsOnAnniversary: args.startsOnAnniversary,
        unpaidLeaveReducesAccrual: true,
        absentDayReducesAccrual: true,
        sickLeave: { fullPayDays: 15, halfPayDays: 30, unpaidDays: 45 },
      } as never,
      args.employedFrom as never,
      args.on as never,
    ) as string,
  importedBy: 'H-MIG-06 staff suite',
}

interface Line {
  readonly staffReference?: string
  readonly gender?: string
  readonly employedFrom?: string
  readonly employedUntil?: string
  readonly styleSkills?: readonly string[]
  readonly languages?: readonly string[]
  readonly credentialExpiries?: readonly string[]
  readonly leaveOpeningDayHundredths?: string
  readonly leaveOpeningBasis?: string
  readonly leaveBalanceAsAt?: string
}

/** Every mandatory therapist credential, all lapsing well in the future. */
let futureCredentials: readonly string[] = []
let mandatoryTypes: readonly string[] = []
let fileCounter = 0

function staffFile(lines: readonly Line[]): string {
  fileCounter += 1
  const rows = lines.map((line) =>
    [
      line.staffReference ?? nextReference(),
      line.gender ?? 'female',
      line.employedFrom ?? '2024-03-01',
      line.employedUntil ?? '',
      (line.styleSkills ?? ['asian_style']).join(SEPARATOR),
      (line.languages ?? ['english']).join(SEPARATOR),
      (line.credentialExpiries ?? futureCredentials).join(SEPARATOR),
      line.leaveOpeningDayHundredths ?? '1400',
      line.leaveOpeningBasis ?? 'trading_session_day',
      line.leaveBalanceAsAt ?? '2026-09-30',
    ].join('\t'),
  )
  // The counter is a COMMENT, which the parser drops: it changes the file's bytes and therefore its
  // sha-256 without changing a value, so each file gets its own `import_run` while every row's content
  // hash stays exactly what the row says.
  return [buildStaffWorkbook(), `# suite file ${fileCounter}`, ...rows, ''].join('\n')
}

const importFile = async (source: string, mode: 'live' | 'dry-run' = 'live') =>
  runImport({
    sql,
    importer: staffImporter(OPTIONS),
    sourceFile: `staff-${fileCounter}.tsv`,
    sourceText: source,
    mode,
    actor: ACTOR,
  })

const lastQuarantineReason = async (): Promise<string | null> => {
  const rows = await sql<{ reason: string | null }[]>`
    select quarantine_reason as reason from imported_staff_row
     order by created_at desc, id desc limit 1
  `
  return rows[0]?.reason ?? null
}

const employeeByReference = async (
  reference: string,
): Promise<{ id: string; gender: string | null; isPublishable: boolean } | undefined> => {
  const rows = await sql<{ id: string; gender: string | null; isPublishable: boolean }[]>`
    select id, gender::text as gender, is_publishable as "isPublishable"
      from employee where staff_reference = ${reference}
  `
  return rows[0]
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`the suite expected ${what} and the read returned none`)
  return value
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 6 })
  const profile = await sql<{ mandatory: string[] }[]>`
    select mandatory_therapist_document_types as mandatory from regulatory_profile_current
  `
  mandatoryTypes = must(profile[0]?.mandatory, 'a regulatory profile in force')
  // Read, never written down. Which credentials gate availability is the profile's to say (0004), and a
  // list stated here would be the second statement that drifts the first time the profile changes.
  futureCredentials = mandatoryTypes.map((type) => `${type}=2030-12-31`)
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('a clean staff line imports the facts the file carried and nothing else', () => {
  let reference: string
  let employeeId: string

  beforeAll(async () => {
    reference = nextReference()
    const report = await importFile(
      staffFile([{ staffReference: reference, styleSkills: ['asian_style', 'arabic_style'] }]),
    )
    expect(report.state).toBe('completed')
    expect(report.applied).toBe(1)
    employeeId = must(await employeeByReference(reference), 'the imported employee').id
  })

  it('records the style skills and the languages, both provisional against Y8-staff', async () => {
    const skills = await sql<{ skill: string; isProvisional: boolean; question: string | null }[]>`
      select skill::text as skill, is_provisional as "isProvisional",
             open_question_id as question
        from employee_skill where employee_id = ${employeeId}::uuid order by skill::text
    `
    expect(skills.map((row) => row.skill).sort()).toEqual(['arabic_style', 'asian_style'])
    for (const row of skills) {
      expect(row.isProvisional).toBe(true)
      expect(row.question).toBe('Y8-staff')
    }
    const languages = await sql<{ language: string }[]>`
      select language::text as language from employee_language where employee_id = ${employeeId}::uuid
    `
    expect(languages.map((row) => row.language)).toEqual(['english'])
  })

  it('records every credential with its expiry and NO number and NO issuing authority', async () => {
    const documents = await sql<
      {
        type: string
        expiresOn: string
        reference: string | null
        authority: string | null
        ciphertext: Buffer | null
      }[]
    >`
      select document_type::text as type, expires_on::text as "expiresOn", reference,
             issuing_authority as authority, number_ct as ciphertext
        from employee_document where employee_id = ${employeeId}::uuid
       order by document_type::text
    `
    expect(documents.map((row) => row.type).sort()).toEqual([...mandatoryTypes].sort())
    for (const row of documents) {
      expect(row.expiresOn).toBe('2030-12-31')
      // Nothing is invented and nothing is sealed: the import has no cell for either, and
      // `employee_document_issuing_authority_not_placeholder` would refuse a marker (brief rule 15).
      expect(row.reference).toBeNull()
      expect(row.authority).toBeNull()
      expect(row.ciphertext).toBeNull()
    }
  })

  it('files the opening balance on the leave year the policy anchors, in day-hundredths', async () => {
    const movements = await sql<
      {
        kind: string
        hundredths: number
        occurredOn: string
        leaveYearStart: string
        dayBasis: string
        isProvisional: boolean
        sourceNote: string
      }[]
    >`
      select kind::text as kind, hundredths, occurred_on::text as "occurredOn",
             leave_year_start::text as "leaveYearStart", day_basis as "dayBasis",
             is_provisional as "isProvisional", source_note as "sourceNote"
        from leave_movement where employee_id = ${employeeId}::uuid
    `
    expect(movements).toHaveLength(1)
    const movement = must(movements[0], 'the opening balance')
    expect(movement.kind).toBe('opening_balance')
    expect(movement.hundredths).toBe(1400)
    expect(movement.occurredOn).toBe('2026-09-30')
    // The anniversary anchor, which is the figure `accrual.worked-examples.test.ts` derives by hand.
    expect(movement.leaveYearStart).toBe('2026-03-01')
    expect(movement.leaveYearStart).not.toBe('2026-01-01')
    expect(movement.dayBasis).toBe('trading_session_day')
    // A non-zero balance is NOT provisional: it is the owner's own figure.
    expect(movement.isProvisional).toBe(false)
    expect(movement.sourceNote).toContain('import_staging.import_provenance')
  })

  it('leaves the therapist unpublishable, and publishability is the database’s and not ours', async () => {
    const before = must(await employeeByReference(reference), 'the imported employee')
    expect(before.isPublishable).toBe(false)
    // A display name ALONE is not enough — decision 23 needs both. Asserted by moving one at a time,
    // because a generation that read only one would satisfy "unpublishable after import" too.
    await sql`update employee set display_name = 'Therapist A' where id = ${employeeId}::uuid`
    expect(must(await employeeByReference(reference), 'the employee').isPublishable).toBe(false)
    await sql`
      update employee
         set photo_consent = true, photo_consent_recorded_at = now(),
             photo_consent_recorded_by = 'H-MIG-06 staff suite'
       where id = ${employeeId}::uuid
    `
    expect(must(await employeeByReference(reference), 'the employee').isPublishable).toBe(true)
    // Put it back, so the rows this suite leaves behind are unpublishable as they arrived.
    await sql`
      update employee
         set display_name = null, photo_consent = false, photo_consent_recorded_at = null,
             photo_consent_recorded_by = null
       where id = ${employeeId}::uuid
    `
    expect(must(await employeeByReference(reference), 'the employee').isPublishable).toBe(false)
  })

  it('leaves no imported row without provenance', async () => {
    for (const relation of STAFF_IMPORTER_TARGETS) {
      expect(relation.startsWith('public.')).toBe(true)
    }
    /*
      Scoped to the line this `describe` imported, and NOT a total over the table — which would be false
      by construction and would have been a failing test about nothing. The ZY371, ZY372 and ZY374 probes
      below insert `imported_staff_row` rows by raw SQL on purpose: their whole subject is what happens
      when something OTHER than this importer writes one, so those rows have no staged line to be
      provenanced from. The total claim is the framework's own and is made in `framework.itest.ts`.
    */
    const orphans = await sql<{ rows: string }[]>`
      select count(*)::text as rows
        from imported_staff_row r
       where r.staff_reference = ${reference}
         and not exists (
           select 1 from import_staging.import_provenance p
            where p.target_table = 'imported_staff_row' and p.target_id = r.id::text
         )
    `
    expect(Number(orphans[0]?.rows ?? '-1')).toBe(0)
    // The control: counting the rows that DO have provenance proves the predicate does work, where a
    // zero from a query matching nothing at all would look identical.
    const provenanced = await sql<{ rows: string }[]>`
      select count(*)::text as rows
        from imported_staff_row r
        join import_staging.import_provenance p
          on p.target_table = 'imported_staff_row' and p.target_id = r.id::text
    `
    expect(Number(provenanced[0]?.rows ?? '0')).toBeGreaterThan(0)
  })
})

describe('a therapist row without a recorded gender is quarantined', () => {
  it('names the reason and creates no employment record', async () => {
    const reference = nextReference()
    const before = await sql<{ count: string }[]>`select count(*)::text from employee`
    const report = await importFile(staffFile([{ staffReference: reference, gender: '' }]))
    expect(report.state).toBe('completed')
    expect(await lastQuarantineReason()).toBe(STAFF_QUARANTINES.genderNotRecorded)
    expect(await employeeByReference(reference)).toBeUndefined()
    const after = await sql<{ count: string }[]>`select count(*)::text from employee`
    // Nothing is defaulted. A guessed gender decides who may treat whom (B-AVAIL-05), and 0030 refused
    // to have a migration invent nineteen people's genders.
    expect(after[0]?.count).toBe(before[0]?.count)
  })

  it('and a record naming a genderless employee cannot COMMIT, which is what makes it a rule', async () => {
    // ZY374. Raised at COMMIT, so the insert succeeds and the transaction does not.
    const reference = nextReference()
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        const [employee] = await uow.sql<{ id: string }[]>`
          insert into employee (staff_reference, employed_from, is_provisional, open_question_id)
          values (${reference}, '2024-03-01'::date, true, 'Y8-staff')
          returning id
        `
        await uow.sql`
          insert into imported_staff_row (staff_reference, outcome, employee_id)
          values (${reference}, 'imported', ${must(employee?.id, 'the employee')}::uuid)
        `
      }),
    ).rejects.toMatchObject({ code: STAFF_IMPORT_SQLSTATE.importedStaffHasNoGender })
  })

  it('permits the same record when the gender IS recorded, which is the control', async () => {
    const reference = nextReference()
    await withUnitOfWork(sql, ACTOR, async (uow) => {
      const [employee] = await uow.sql<{ id: string }[]>`
        insert into employee (staff_reference, gender, employed_from, is_provisional, open_question_id)
        values (${reference}, 'male'::employee_gender, '2024-03-01'::date, true, 'Y8-staff')
        returning id
      `
      await uow.sql`
        insert into imported_staff_row (staff_reference, outcome, employee_id)
        values (${reference}, 'imported', ${must(employee?.id, 'the employee')}::uuid)
      `
    })
    expect(must(await employeeByReference(reference), 'the employee').gender).toBe('male')
  })
})

describe('a leave opening balance has to say what it counted', () => {
  it('quarantines a balance stated in calendar days, whole', async () => {
    const reference = nextReference()
    await importFile(staffFile([{ staffReference: reference, leaveOpeningBasis: 'calendar_day' }]))
    expect(await lastQuarantineReason()).toBe(STAFF_QUARANTINES.leaveBalanceInCalendarDays)
    // Whole, and not "imported without the balance": an employee with no opening-balance movement has a
    // balance of zero by construction, which is the failure ZY372 exists to refuse reached the long way.
    expect(await employeeByReference(reference)).toBeUndefined()
  })

  it('and the database refuses one directly, naming the trading dates it counted', async () => {
    // ZY371, and the message has to carry the business_day count — that is the "read the bounds from
    // business_day" half, and a refusal that only said "wrong unit" would not tell anybody whether the
    // two readings differ at all.
    const reference = nextReference()
    let message = ''
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        const [employee] = await uow.sql<{ id: string }[]>`
          insert into employee (staff_reference, gender, employed_from, is_provisional, open_question_id)
          values (${reference}, 'female'::employee_gender, '2024-03-01'::date, true, 'Y8-staff')
          returning id
        `
        await uow.sql`
          insert into leave_movement (
            employee_id, kind, hundredths, occurred_on, leave_year_start, created_by, source_note,
            day_basis, is_provisional
          ) values (
            ${must(employee?.id, 'the employee')}::uuid, 'opening_balance', 1400,
            '2026-09-30'::date, '2026-03-01'::date, 'H-MIG-06 staff suite',
            'Reconstructed staff file, suite probe.', 'calendar_day', false
          )
        `
      }).catch((error: unknown) => {
        message = error instanceof Error ? error.message : String(error)
        throw error
      }),
    ).rejects.toMatchObject({ code: STAFF_IMPORT_SQLSTATE.leaveOpeningBalanceInCalendarDays })
    expect(message).toMatch(/date\(s\) this business does not trade/)
    expect(message).toMatch(/leave year opening 2026-03-01/)
  })

  it('records a ZERO balance as provisional, naming its open question', async () => {
    const reference = nextReference()
    const report = await importFile(
      staffFile([{ staffReference: reference, leaveOpeningDayHundredths: '0' }]),
    )
    expect(report.applied).toBe(1)
    const employeeId = must(await employeeByReference(reference), 'the employee').id
    const rows = await sql<
      { hundredths: number; isProvisional: boolean; question: string | null; note: string | null }[]
    >`
      select hundredths, is_provisional as "isProvisional", open_question_id as question,
             provisional_note as note
        from leave_movement where employee_id = ${employeeId}::uuid
    `
    const movement = must(rows[0], 'the opening balance')
    expect(movement.hundredths).toBe(0)
    expect(movement.isProvisional).toBe(true)
    expect(movement.question).toBe(ZERO_LEAVE_BALANCE_QUESTION)
    expect(movement.note).toContain('not an answer')
  })

  it('and refuses an UNMARKED zero directly, which is what makes the mark load-bearing', async () => {
    const reference = nextReference()
    await expect(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        const [employee] = await uow.sql<{ id: string }[]>`
          insert into employee (staff_reference, gender, employed_from, is_provisional, open_question_id)
          values (${reference}, 'female'::employee_gender, '2024-03-01'::date, true, 'Y8-staff')
          returning id
        `
        await uow.sql`
          insert into leave_movement (
            employee_id, kind, hundredths, occurred_on, leave_year_start, created_by, source_note,
            day_basis, is_provisional
          ) values (
            ${must(employee?.id, 'the employee')}::uuid, 'opening_balance', 0,
            '2026-09-30'::date, '2026-03-01'::date, 'H-MIG-06 staff suite',
            'Reconstructed staff file, suite probe.', 'trading_session_day', false
          )
        `
      }),
    ).rejects.toMatchObject({
      code: STAFF_IMPORT_SQLSTATE.leaveOpeningBalanceOfZeroIsNotAnAnswer,
    })
  })

  it('restates migration 0066 version 1 field for field in the worked examples', async () => {
    // The worked examples are PURE, so they restate the policy as a literal; this is the check that
    // holds the restatement equal to the row, in the same commit (brief: a second statement of a fact
    // drifts, so add the check that holds the two equal). It reads the file as TEXT rather than
    // importing it, because a test file is not a module anything may depend on.
    const rows = await sql<
      {
        annual: number
        monthly: number
        probation: number
        carryOver: number
        anniversary: boolean
      }[]
    >`
      select annual_entitlement_days as annual, monthly_accrual_hundredths as monthly,
             probation_months as probation, carry_over_cap_hundredths as "carryOver",
             leave_year_starts_on_anniversary as anniversary
        from leave_entitlement_rule order by effective_from desc limit 1
      `
    const rule = must(rows[0], 'the leave entitlement rule')
    const source = readFileSync('packages/core/src/hr/accrual.worked-examples.test.ts', 'utf8')
    expect(source).toContain(`annualEntitlementDays: ${rule.annual},`)
    expect(source).toContain(`monthlyAccrualHundredths: ${rule.monthly},`)
    expect(source).toContain(`probationMonths: ${rule.probation},`)
    expect(source).toContain(`carryOverCapHundredths: ${rule.carryOver},`)
    expect(source).toContain(`leaveYearStartsOnAnniversary: ${rule.anniversary},`)
  })
})

describe('a lapsed credential takes the therapist out of availability at once', () => {
  it('excludes them by name and flags their future appointments for reassignment', async () => {
    const reference = nextReference()
    // One mandatory credential already expired, the rest in the future. That is the shape the acceptance
    // line is about, and it is imported AS IT STANDS — the import writes the truth and the existing gate
    // does the rest, which is why this unit adds no availability code.
    const lapsed = must(mandatoryTypes[0], 'a mandatory document type')
    const report = await importFile(
      staffFile([
        {
          staffReference: reference,
          credentialExpiries: [
            `${lapsed}=2025-01-31`,
            ...mandatoryTypes.slice(1).map((type) => `${type}=2030-12-31`),
          ],
        },
      ]),
    )
    expect(report.applied).toBe(1)
    const employeeId = must(await employeeByReference(reference), 'the employee').id

    const pool = await readEligibleTherapists(sql, {
      tradingDate: '2026-10-01',
      requiredSkill: 'asian_style',
      // Narrowed by id rather than by deleting rows — `EligibilityQueryInput`'s own recorded reason.
      employeeIds: [employeeId],
    })
    expect(pool.therapists.map((row) => row.therapistId)).not.toContain(employeeId)
    expect(pool.excluded.find((row) => row.therapistId === employeeId)?.reason).toBe(
      'credential_expired',
    )

    // And their future appointments are findable by the sweep. There are none for a therapist imported
    // a moment ago, so the claim asserted is the one that can be: the sweep's window INCLUDES them, and
    // the reason they produce no rows is that they hold no future appointment rather than that the
    // reader cannot see them.
    const candidates = await readReassignmentCandidates(sql, {
      fromTradingDate: '2026-10-01',
      fromInstant: '2026-10-01T07:00:00.000Z',
    })
    expect(candidates.every((row) => row.therapistId !== employeeId)).toBe(true)
    const theirs = await sql<{ rows: string }[]>`
      select count(*)::text as rows from appointment where therapist_id = ${employeeId}::uuid
    `
    expect(Number(theirs[0]?.rows ?? '-1')).toBe(0)
  })

  it('and a therapist whose credentials are all current is eligible, which is the control', async () => {
    const reference = nextReference()
    await importFile(staffFile([{ staffReference: reference }]))
    const employeeId = must(await employeeByReference(reference), 'the employee').id
    const pool = await readEligibleTherapists(sql, {
      tradingDate: '2026-10-01',
      requiredSkill: 'asian_style',
      employeeIds: [employeeId],
    })
    /*
      The control is about the CREDENTIAL gate and nothing else, and the first spelling of it was wrong
      in a way worth recording: it asserted the therapist was not excluded at all, and they ARE —
      `not_rostered`, because nobody imported by this file has a shift. That is correct behaviour and a
      different rule, so asserting its absence would have made this control fail for a reason that has
      nothing to do with credentials.

      So the claim is exactly the one the case above needs: a therapist whose mandatory documents are all
      current is not excluded FOR THAT, which is what makes the `credential_expired` above the credential
      gate's doing rather than a blanket exclusion.
    */
    const exclusion = pool.excluded.find((row) => row.therapistId === employeeId)
    expect(exclusion?.reason).not.toBe('credential_expired')
    expect(exclusion?.reason).toBe('not_rostered')
  })

  it('quarantines a credential type no regulatory profile knows about', async () => {
    const reference = nextReference()
    await importFile(
      staffFile([
        { staffReference: reference, credentialExpiries: ['training_certificate=2030-12-31'] },
      ]),
    )
    // `training_certificate` is a real `employee_document_type` and is NOT in the mandatory list, so the
    // case proves the check reads the PROFILE rather than the enum — an enum check would admit it.
    expect(mandatoryTypes).not.toContain('training_certificate')
    expect(await lastQuarantineReason()).toBe(STAFF_QUARANTINES.documentTypeUnknown)
  })
})

describe('the field-level policy over bank and identity data', () => {
  it('has no plaintext column to import into', async () => {
    const columns = await sql<{ table: string; column: string }[]>`
      select table_name as table, column_name as column
        from information_schema.columns
       where table_schema = 'public'
         and table_name in ('employee_bank_detail', 'employee_document', 'imported_staff_row')
       order by table_name, column_name
    `
    const names = columns.map((row) => `${row.table}.${row.column}`)
    // `employee_bank_detail` holds ciphertext, a nonce, a wrapped key, a key id and an AAD fingerprint,
    // and nothing else about the account. There is no `iban`, no `account_number` and no `sort_code`.
    for (const forbidden of ['iban', 'account_number', 'sort_code', 'bank_name']) {
      expect(names.filter((name) => name.includes(forbidden))).toEqual([])
    }
    expect(names).toContain('employee_bank_detail.detail_ct')
    expect(names).toContain('employee_document.number_ct')
    // And the import record itself holds nothing of the kind.
    expect(names.filter((name) => name.startsWith('imported_staff_row.'))).toEqual([
      'imported_staff_row.created_at',
      'imported_staff_row.employee_id',
      'imported_staff_row.id',
      'imported_staff_row.outcome',
      'imported_staff_row.quarantine_reason',
      'imported_staff_row.staff_reference',
    ])
  })

  it('refuses a plaintext identity reference, measured rather than asserted', async () => {
    const reference = nextReference()
    const [employee] = await sql<{ id: string }[]>`
      insert into employee (staff_reference, gender, employed_from, is_provisional, open_question_id)
      values (${reference}, 'female'::employee_gender, '2024-03-01'::date, true, 'Y8-staff')
      returning id
    `
    const employeeId = must(employee?.id, 'the employee')
    await expect(
      sql`
        insert into employee_document (employee_id, document_type, reference, expires_on)
        values (${employeeId}::uuid, 'emirates_id', '784-1234-1234567-1', '2030-12-31'::date)
      `,
    ).rejects.toThrow(/employee_document_identity_number_is_encrypted/)
    // The control: the same row with no reference is accepted, so the refusal is about the plaintext
    // and not about the insert.
    await sql`
      insert into employee_document (employee_id, document_type, expires_on)
      values (${employeeId}::uuid, 'emirates_id', '2030-12-31'::date)
    `
  })

  it('and the import has no cell and no payload key that could carry one', () => {
    const generated = buildStaffWorkbook()
    expect(generated).toContain(STAFF_HEADER)
    for (const forbidden of ['iban', 'account', 'emirates_id_number', 'passport_number', 'wage']) {
      expect(STAFF_HEADER).not.toContain(forbidden)
    }
    // The file says so in words to whoever fills it in, which is the layer a column list cannot be.
    expect(generated).toContain('No Emirates ID number, passport number or visa number')
  })
})

describe('the import record is evidence', () => {
  it('refuses to be rewritten or removed', async () => {
    const [record] = await sql<{ id: string }[]>`
      select id from imported_staff_row order by created_at desc limit 1
    `
    const id = must(record?.id, 'an imported-staff record')
    await expect(
      sql`update imported_staff_row set outcome = 'quarantined' where id = ${id}::uuid`,
    ).rejects.toMatchObject({ code: STAFF_IMPORT_SQLSTATE.importedStaffRowImmutable })
    await expect(sql`delete from imported_staff_row where id = ${id}::uuid`).rejects.toMatchObject({
      code: STAFF_IMPORT_SQLSTATE.importedStaffRowImmutable,
    })
  })

  it('quarantines a reference somebody already holds rather than importing a second record', async () => {
    const reference = nextReference()
    await importFile(staffFile([{ staffReference: reference }]))
    const before = await readImportedStaffCounts(sql)
    await importFile(staffFile([{ staffReference: reference, gender: 'male' }]))
    const after = await readImportedStaffCounts(sql)
    // A delta, never a total: `imported_staff_row` only grows (brief rule 9).
    expect(after.quarantined - before.quarantined).toBe(1)
    expect(after.imported - before.imported).toBe(0)
    expect(await lastQuarantineReason()).toBe(STAFF_QUARANTINES.staffReferenceAlreadyHeld)
    const rows = await sql<{ rows: string }[]>`
      select count(*)::text as rows from employee where staff_reference = ${reference}
    `
    expect(Number(rows[0]?.rows ?? '-1')).toBe(1)
  })

  it('leaves no quarantine reason outside the vocabulary', async () => {
    const used = await sql<{ reason: string }[]>`
      select distinct quarantine_reason as reason from imported_staff_row
       where quarantine_reason is not null
    `
    for (const row of used) expect(STAFF_QUARANTINE_REASONS).toContain(row.reason)
    expect(used.length).toBeGreaterThan(0)
  })

  it('rehearses without changing anything', async () => {
    const before = await readImportedStaffCounts(sql)
    const report = await importFile(staffFile([{}]), 'dry-run')
    expect(report.committed).toBe(false)
    expect(report.applied).toBe(1)
    expect(await readImportedStaffCounts(sql)).toEqual(before)
  })
})
