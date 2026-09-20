import { generateKek, type Kek } from '@berelax/clinical'
import {
  assertEmployeeFieldReadable,
  EMPLOYEE_FIELD_ERRORS,
  projectEmployeeRecord,
  totalMonthlyWageFils,
} from '@berelax/core'
import {
  createConnection,
  type Sql,
  THERAPIST_HEADCOUNT,
  therapistStaffReference,
  therapistStyleSkill,
  unconfirmedAssumptionRows,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createEmployeeRepository, type EmployeeRepository } from './employee-repository.ts'
import { openBankDetail, rewrapStaffSecret } from './staff-secret.ts'

/**
 * P-HR-01 against real PostgreSQL: the employment record, the sealed columns and the audited read.
 *
 * ## Fixture values, and why they are shaped the way they are
 *
 * Every number below **fails its own check digit**, deliberately, and `pnpm pii` is the gate that makes
 * that a rule rather than an intention. `AE00…` can never be a real IBAN because `00` is not a producible
 * mod-97 residue, and `784-0000-0000000-0` fails the Luhn digit an Emirates ID carries. A *plausible*
 * value here would be worse than a blank one — brief rule 15 — and worse than that for an identity
 * number, which unlike every other secret in this system cannot be reissued because it leaked.
 *
 * ## The database is shared and sequential
 *
 * Every row this file writes carries the `PHR01-` staff reference prefix and is swept by that prefix in
 * `beforeAll` and `afterAll`. The prefix and not a truncate: the nineteen seeded therapists must survive
 * — this file asserts they do — and so must every other integration file's rows. `audit_event` is
 * append-only (ADR 0008), so every assertion about it is a **delta counted in SQL**, never a total.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** Obviously-not-real values. See the header: both fail their own check digit, on purpose. */
const FIXTURE_IBAN = 'AE000000000000000000000'
const FIXTURE_EMIRATES_ID = '784-0000-0000000-0'
const FIXTURE_ACCOUNT_HOLDER = 'FIXTURE ACCOUNT HOLDER (not a real person)'

/** This file's own rows. Swept by prefix, so nothing else's rows are touched. */
const PREFIX = 'PHR01-'
const reference = (name: string) => `${PREFIX}${name}`

const OWNER = { role: 'owner', actor: { kind: 'staff', label: 'phr01-owner' } } as const
const MANAGER = { role: 'manager', actor: { kind: 'staff', label: 'phr01-manager' } } as const
const RECEPTIONIST = {
  role: 'receptionist',
  actor: { kind: 'staff', label: 'phr01-receptionist' },
} as const
const THERAPIST = { role: 'therapist', actor: { kind: 'staff', label: 'phr01-therapist' } } as const
/** Holds employee.bank and employee.salary and NO employee:read — F07's payroll role. */
const ACCOUNTANT = {
  role: 'accountant',
  actor: { kind: 'staff', label: 'phr01-accountant' },
} as const

let sql: Sql
let kek: Kek
let repository: EmployeeRepository

/** 32 random bytes, generated in this process and never written to a file. */
const freshKek = (version: string): Kek => generateKek(version)

async function sweep(): Promise<void> {
  // Ordered by dependency, and `employee_bank_detail` first because its foreign key is ON DELETE
  // RESTRICT — an employee who has been paid has a history, which is 0030's and 0050's rule working.
  await sql`
    delete from employee_bank_detail
     where employee_id in (select id from employee where staff_reference like ${`${PREFIX}%`})
  `
  await sql`
    delete from employee_document
     where employee_id in (select id from employee where staff_reference like ${`${PREFIX}%`})
  `
  await sql`
    delete from employee_language
     where employee_id in (select id from employee where staff_reference like ${`${PREFIX}%`})
  `
  await sql`
    delete from employee_skill
     where employee_id in (select id from employee where staff_reference like ${`${PREFIX}%`})
  `
  await sql`delete from employee where staff_reference like ${`${PREFIX}%`}`
}

/** Inserts an employee with the given reference and returns its id. */
async function employee(
  name: string,
  columns: { readonly basicWageFils?: number; readonly housingAllowanceFils?: number } = {},
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from, basic_wage_fils, housing_allowance_fils)
    values (${reference(name)}, '2026-01-01',
            ${columns.basicWageFils ?? null}, ${columns.housingAllowanceFils ?? null})
    returning id
  `
  if (row === undefined) throw new Error('the employee fixture insert returned no row')
  return row.id
}

/** Inserts an `employee_document` row with no number yet, and returns its id. */
async function documentRow(employeeId: string, expiresOn: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee_document (employee_id, document_type, expires_on)
    values (${employeeId}, 'emirates_id', ${expiresOn}::date)
    returning id
  `
  if (row === undefined) throw new Error('the employee_document fixture insert returned no row')
  return row.id
}

/** Counted in SQL, always: `audit_event` only grows, so every assertion about it is a delta. */
async function auditCount(action: string, operation: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
     where action = ${action} and operation = ${operation}
  `
  return Number(row?.n ?? '0')
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  kek = freshKek('phr01-v1')
  repository = createEmployeeRepository(sql, kek)
  await sweep()
})

afterAll(async () => {
  if (sql !== undefined) {
    await sweep()
    await sql.end({ timeout: 5 })
  }
})

describe('the migration is expand-only over the therapist rows the seed creates', () => {
  const references = Array.from({ length: THERAPIST_HEADCOUNT }, (_, i) =>
    therapistStaffReference(i + 1),
  )

  it('leaves every seeded therapist with exactly one employee row, 19 of them', async () => {
    const rows = await sql<{ staff_reference: string; n: string }[]>`
      select staff_reference, count(*)::text as n
        from employee
       where staff_reference = any(${references}::text[])
       group by staff_reference
       order by staff_reference
    `
    // Key-set equality rather than a total: other integration files create their own employees in this
    // shared database, so `count(*) from employee` is somebody else's number as much as ours.
    expect(rows.map((row) => row.staff_reference)).toEqual(references)
    expect(rows).toHaveLength(19)
    expect(rows.every((row) => row.n === '1')).toBe(true)
  })

  it('seeds every one of them unnamed, unconsented and therefore unpublishable', async () => {
    const [row] = await sql<{ named: string; consented: string; publishable: string }[]>`
      select count(display_name)::text                      as named,
             count(*) filter (where photo_consent)::text    as consented,
             count(*) filter (where is_publishable)::text    as publishable
        from employee
       where staff_reference = any(${references}::text[])
    `
    // docs/13 §5: 19 photographs, 0 names. ADR 0020 needs a name AND a consent before a page exists.
    expect(row).toEqual({ named: '0', consented: '0', publishable: '0' })
  })

  it('invents no gender, contract or wage for any of them', async () => {
    const [row] = await sql<Record<string, string>[]>`
      select count(gender)::text          as genders,
             count(contract_type)::text   as contracts,
             count(basic_wage_fils)::text as wages,
             count(*) filter (where is_provisional)::text as provisional
        from employee
       where staff_reference = any(${references}::text[])
    `
    // 0030 left gender nullable in so many words because a NOT NULL "would have this migration invent
    // nineteen people's genders". Seeding nineteen genders would do what that migration refused to do —
    // and gender is a hard constraint on assignment (B-AVAIL-05), so it is not inert either.
    expect(row).toEqual({ genders: '0', contracts: '0', wages: '0', provisional: '19' })
  })

  it('splits the provisional style skills evenly and flags every one against Y8-staff', async () => {
    const rows = await sql<{ skill: string; n: string }[]>`
      select s.skill::text as skill, count(*)::text as n
        from employee_skill s join employee e on e.id = s.employee_id
       where e.staff_reference = any(${references}::text[]) and s.is_provisional
         and s.open_question_id = 'Y8-staff'
       group by s.skill
       order by s.skill::text
    `
    // Ten and nine, because nineteen is odd: the remainder goes to the Asian style, which is a stated
    // tie-break in the seed rather than an accident of rounding.
    expect(rows).toEqual([
      { skill: 'arabic_style', n: '9' },
      { skill: 'asian_style', n: '10' },
    ])
    expect(therapistStyleSkill(1)).toBe('asian_style')
    expect(therapistStyleSkill(2)).toBe('arabic_style')
  })

  it('seeds no languages at all, because nobody has said what they are', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from employee_language l join employee e on e.id = l.employee_id
       where e.staff_reference = any(${references}::text[])
    `
    expect(row?.n).toBe('0')
  })

  it('keeps a row written with only 0030 columns readable, which is what expand-only means', async () => {
    // The shape another unit's fixture writes: no column 0050 added. If any of them were NOT NULL without
    // a default, this insert would fail — which is the mechanical meaning of "expand-only over the rows
    // that already exist".
    const id = await employee('expand-only-probe')
    const [row] = await sql<{ photo_consent: boolean; is_publishable: boolean }[]>`
      select photo_consent, is_publishable from employee where id = ${id}
    `
    expect(row).toEqual({ photo_consent: false, is_publishable: false })
  })

  it('lists the unnamed-therapist assumption in the Unconfirmed Assumptions query', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const employees = rows.filter((row) => row.source === 'employee')
    expect(employees).toHaveLength(19)
    expect(employees.map((row) => row.reference)).toContain(therapistStaffReference(1))
    expect(new Set(employees.map((row) => row.openQuestionId))).toEqual(new Set(['Y8-staff']))
    expect(employees[0]?.note).toMatch(/no names/)
    // The skills are a SEPARATE source: an admin may confirm the person and not yet the skills.
    expect(rows.filter((row) => row.source === 'employee_skill')).toHaveLength(19)
  })
})

describe('a raw select returns ciphertext only', () => {
  it('holds no part of the IBAN or the account holder anywhere in the row', async () => {
    const employeeId = await employee('ciphertext-only')
    await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
      label: 'salary account',
    })
    // The whole row as text, so a column added later is covered by this assertion the day it appears —
    // the same reason migration 0050's trigger compares `to_jsonb(new)` rather than a column list.
    const [row] = await sql<{ dump: string }[]>`
      select to_jsonb(d)::text as dump from employee_bank_detail d where d.employee_id = ${employeeId}
    `
    expect(row?.dump).toBeDefined()
    expect(row?.dump).not.toContain(FIXTURE_IBAN)
    expect(row?.dump).not.toContain('FIXTURE ACCOUNT HOLDER')
    // The control. A test asserting only absence passes against an empty row, so assert the ciphertext
    // is really there and is really bytes rather than text.
    expect(row?.dump).toMatch(/"detail_ct": ?"\\+x[0-9a-f]{8}/)
  })

  it('holds no part of the document number, and the plaintext is recoverable only with the key', async () => {
    const employeeId = await employee('document-ciphertext')
    const documentId = await documentRow(employeeId, '2030-01-01')
    await repository.writeDocumentNumber(OWNER, {
      employeeId,
      documentId,
      number: FIXTURE_EMIRATES_ID,
    })
    const [row] = await sql<{ dump: string }[]>`
      select to_jsonb(d)::text as dump from employee_document d where d.id = ${documentId}
    `
    expect(row?.dump).not.toContain(FIXTURE_EMIRATES_ID)
    expect(row?.dump).not.toContain('784')
    expect(
      await repository.readDocumentNumber(OWNER, {
        employeeId,
        documentId,
        purpose: 'credential_check',
      }),
    ).toBe(FIXTURE_EMIRATES_ID)
  })

  it('refuses an identity number typed into the plaintext reference column', async () => {
    const employeeId = await employee('plaintext-reference')
    await expect(
      sql`
        insert into employee_document (employee_id, document_type, reference, expires_on)
        values (${employeeId}, 'emirates_id', 'anything at all', '2030-01-01')
      `,
    ).rejects.toThrow(/employee_document_identity_number_is_encrypted/)
    // The control: the same column accepts a licence number, which is what it is for.
    await expect(
      sql`
        insert into employee_document (employee_id, document_type, reference, expires_on)
        values (${employeeId}, 'professional_licence', 'LIC-FIXTURE-0001', '2030-01-01')
      `,
    ).resolves.toBeDefined()
  })

  it('leaves nothing IBAN-shaped or Emirates-ID-shaped in the seeded tables', async () => {
    // The dump half of the acceptance criterion; `pnpm pii` is the grep half over committed files. The
    // seed writes no bank rows at all, and this is what says so rather than assuming it.
    const [row] = await sql<{ dump: string }[]>`
      select coalesce(string_agg(to_jsonb(d)::text, ' '), '') as dump from employee_bank_detail d
    `
    const dump = `${row?.dump ?? ''}`
    expect(dump).not.toMatch(/AE\d{21}/)
    expect(dump).not.toMatch(/784[\s-]?\d{4}[\s-]?\d{7}[\s-]?\d/)
  })
})

describe('the ciphertext is bound to its row by AAD', () => {
  it('fails to decrypt a payload swapped onto another employee, rather than returning theirs', async () => {
    const alice = await employee('aad-a')
    const bob = await employee('aad-b')
    const aliceDoc = await documentRow(alice, '2030-02-02')
    const bobDoc = await documentRow(bob, '2030-03-03')
    await repository.writeDocumentNumber(OWNER, {
      employeeId: alice,
      documentId: aliceDoc,
      number: '784-0000-0000003-0',
    })
    await repository.writeDocumentNumber(OWNER, {
      employeeId: bob,
      documentId: bobDoc,
      number: '784-0000-0000002-0',
    })

    // The control, and it is the half that keeps this from being vacuous: before the swap, each read
    // returns that employee's own number. A test that only asserts a failure afterwards would pass
    // against a decrypt that never worked.
    expect(
      await repository.readDocumentNumber(OWNER, {
        employeeId: bob,
        documentId: bobDoc,
        purpose: 'credential_check',
      }),
    ).toBe('784-0000-0000002-0')

    // Alice's sealed bytes, moved wholesale onto Bob's row. The DATABASE permits this — employee_document
    // is mutable by design, because 0030 makes a renewal a new row and a mistyped number has to be
    // correctable in place — so the AAD is what has to refuse it, and this is the assertion that proves
    // the AAD is load-bearing rather than decorative.
    await sql`
      update employee_document dst
         set number_ct          = src.number_ct,
             number_nonce       = src.number_nonce,
             number_wrapped_key = src.number_wrapped_key,
             number_kid         = src.number_kid,
             number_aad_fp      = src.number_aad_fp
        from employee_document src
       where dst.id = ${bobDoc} and src.id = ${aliceDoc}
    `
    await expect(
      repository.readDocumentNumber(OWNER, {
        employeeId: bob,
        documentId: bobDoc,
        purpose: 'credential_check',
      }),
    ).rejects.toThrow(/StaffSecretOpenFailed/)
  })

  it('refuses the same move on a bank row at the database, before the AAD is reached', async () => {
    const employeeId = await employee('aad-bank')
    await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    // Two layers, and this is the outer one: `employee_bank_detail` is written once and superseded, so an
    // UPDATE that touches the ciphertext is refused by name (ZS002) rather than producing a row the AAD
    // will later decline to open.
    await expect(
      sql`
        update employee_bank_detail set detail_ct = '\\x01'::bytea where employee_id = ${employeeId}
      `,
    ).rejects.toThrow(/StaffSealedRowImmutable/)
  })

  it('refuses moving a sealed document row to another employee', async () => {
    const owner = await employee('rebind-owner')
    const other = await employee('rebind-other')
    const documentId = await documentRow(owner, '2030-04-04')
    await repository.writeDocumentNumber(OWNER, {
      employeeId: owner,
      documentId,
      number: FIXTURE_EMIRATES_ID,
    })
    await expect(
      sql`update employee_document set employee_id = ${other} where id = ${documentId}`,
    ).rejects.toThrow(/StaffSealedRowRebound/)
  })

  it('re-wraps under a new key without touching the ciphertext, and the row still opens', async () => {
    const employeeId = await employee('rewrap')
    const { bankDetailId } = await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    const before = await sql<{ ct_md5: string }[]>`
      select md5(detail_ct) as ct_md5 from employee_bank_detail where id = ${bankDetailId}
    `
    const [sealedRow] = await sql<
      { ct: Buffer; nonce: Buffer; wrapped_key: Buffer; kid: string; aad_fp: string }[]
    >`
      select detail_ct as ct, detail_nonce as nonce, detail_wrapped_key as wrapped_key,
             detail_kid as kid, detail_aad_fp as aad_fp
        from employee_bank_detail where id = ${bankDetailId}
    `
    if (sealedRow === undefined) throw new Error('the sealed row was not found')
    const nextKek = freshKek('phr01-v2')
    const binding = {
      table: 'employee_bank_detail',
      recordId: bankDetailId,
      employeeId,
    } as const
    const rewrapped = rewrapStaffSecret(kek, nextKek, binding, {
      ct: sealedRow.ct,
      nonce: sealedRow.nonce,
      wrappedKey: sealedRow.wrapped_key,
      kid: sealedRow.kid,
      aadFp: sealedRow.aad_fp,
    })
    await sql`
      update employee_bank_detail
         set detail_wrapped_key = ${rewrapped.wrappedKey}, detail_kid = ${rewrapped.kid}
       where id = ${bankDetailId} and detail_kid = ${sealedRow.kid}
    `
    const after = await sql<{ ct_md5: string; kid: string }[]>`
      select md5(detail_ct) as ct_md5, detail_kid as kid
        from employee_bank_detail where id = ${bankDetailId}
    `
    // The ciphertext is read back from the heap as md5 rather than compared in JavaScript, which is how
    // H-HARD-03 asserts the same property: it is the stored bytes that must not have moved.
    expect(after[0]?.ct_md5).toBe(before[0]?.ct_md5)
    expect(after[0]?.kid).toBe('phr01-v2')
    const [reread] = await sql<
      { ct: Buffer; nonce: Buffer; wrapped_key: Buffer; kid: string; aad_fp: string }[]
    >`
      select detail_ct as ct, detail_nonce as nonce, detail_wrapped_key as wrapped_key,
             detail_kid as kid, detail_aad_fp as aad_fp
        from employee_bank_detail where id = ${bankDetailId}
    `
    if (reread === undefined) throw new Error('the re-wrapped row was not found')
    expect(
      openBankDetail(nextKek, binding, {
        ct: reread.ct,
        nonce: reread.nonce,
        wrappedKey: reread.wrapped_key,
        kid: reread.kid,
        aadFp: reread.aad_fp,
      }).iban,
    ).toBe(FIXTURE_IBAN)
    // The control: the retired key no longer opens it, which is what makes the re-wrap real rather than
    // a version label somebody changed.
    expect(() =>
      openBankDetail(kek, binding, {
        ct: reread.ct,
        nonce: reread.nonce,
        wrappedKey: reread.wrapped_key,
        kid: reread.kid,
        aadFp: reread.aad_fp,
      }),
    ).toThrow(/StaffSecretOpenFailed/)
  })

  it('refuses a version change that did not re-wrap the key', async () => {
    const employeeId = await employee('rewrap-liar')
    const { bankDetailId } = await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    await expect(
      sql`update employee_bank_detail set detail_kid = 'phr01-v9' where id = ${bankDetailId}`,
    ).rejects.toThrow(/StaffRewrapDidNotRewrap/)
  })
})

describe('every decrypt writes exactly one audit row', () => {
  it('writes one read event per decrypt call, with the actor, the entity and the purpose', async () => {
    const employeeId = await employee('audited-read')
    await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    const before = await auditCount('employee.bank_detail.read', 'read')
    const decrypts = 3
    for (let i = 0; i < decrypts; i += 1) {
      expect(
        (await repository.readBankDetail(OWNER, { employeeId, purpose: 'payroll_run' }))?.iban,
      ).toBe(FIXTURE_IBAN)
    }
    const after = await auditCount('employee.bank_detail.read', 'read')
    // A DELTA, counted in SQL. `audit_event` is append-only and partitioned, and every other integration
    // file in this database writes to it, so a total is somebody else's number.
    expect(after - before).toBe(decrypts)

    const [row] = await sql<{ actor_label: string; entity_id: string; purpose: string }[]>`
      select actor_label, entity_id, after_state ->> 'purpose' as purpose
        from audit_event
       where action = 'employee.bank_detail.read' and entity_id = ${employeeId}
       order by occurred_at desc
       limit 1
    `
    expect(row).toEqual({
      actor_label: 'phr01-owner',
      entity_id: employeeId,
      purpose: 'payroll_run',
    })
  })

  it('records the attempt even when the decrypt fails, so a failed read is not invisible', async () => {
    const employeeId = await employee('audited-failure')
    const documentId = await documentRow(employeeId, '2030-05-05')
    await repository.writeDocumentNumber(OWNER, {
      employeeId,
      documentId,
      number: FIXTURE_EMIRATES_ID,
    })
    // A repository holding the wrong key: the row is intact, the read is authorised, and the decrypt
    // cannot succeed. This is the line in the table somebody investigating actually wants.
    const wrongKey = createEmployeeRepository(sql, freshKek('phr01-v1'))
    const before = await auditCount('employee.document_number.read', 'read')
    await expect(
      wrongKey.readDocumentNumber(OWNER, {
        employeeId,
        documentId,
        purpose: 'credential_check',
      }),
    ).rejects.toThrow(/StaffSecretOpenFailed/)
    expect((await auditCount('employee.document_number.read', 'read')) - before).toBe(1)
  })

  it('refuses an undeclared purpose rather than recording an unexplained read', async () => {
    const employeeId = await employee('purpose-check')
    await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    const before = await auditCount('employee.bank_detail.read', 'read')
    await expect(
      repository.readBankDetail(OWNER, { employeeId, purpose: 'because I wanted to' }),
    ).rejects.toThrow(/not a declared purpose/)
    // And it wrote nothing: a refusal before the read is not a read.
    expect((await auditCount('employee.bank_detail.read', 'read')) - before).toBe(0)
  })

  it('cannot have its audit row edited away — the UPDATE reports success and changes nothing', async () => {
    const employeeId = await employee('append-only')
    await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    await repository.readBankDetail(OWNER, { employeeId, purpose: 'audit_response' })
    const [before] = await sql<{ purpose: string }[]>`
      select after_state ->> 'purpose' as purpose from audit_event
       where action = 'employee.bank_detail.read' and entity_id = ${employeeId}
    `
    // `audit_event` is append-only through `do instead nothing` RULES (0005), and a rule reports SUCCESS
    // to the caller. So the control cannot be "this throws" — it has to read the row back. A test that
    // expected an error here would fail while the table was behaving exactly as designed.
    await expect(
      sql`
        update audit_event set after_state = '{"purpose":"tampered"}'::jsonb
         where action = 'employee.bank_detail.read' and entity_id = ${employeeId}
      `,
    ).resolves.toBeDefined()
    const [after] = await sql<{ purpose: string }[]>`
      select after_state ->> 'purpose' as purpose from audit_event
       where action = 'employee.bank_detail.read' and entity_id = ${employeeId}
    `
    expect(after?.purpose).toBe(before?.purpose)
    expect(after?.purpose).toBe('audit_response')
  })
})

describe('field-level RBAC is deny-by-default', () => {
  it('refuses a receptionist and a therapist the bank and identity fields', async () => {
    const employeeId = await employee('rbac-refused')
    await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    const documentId = await documentRow(employeeId, '2030-06-06')
    await repository.writeDocumentNumber(OWNER, {
      employeeId,
      documentId,
      number: FIXTURE_EMIRATES_ID,
    })

    const before = await auditCount('employee.bank_detail.read', 'denied')
    for (const access of [RECEPTIONIST, THERAPIST]) {
      await expect(
        repository.readBankDetail(access, { employeeId, purpose: 'payroll_run' }),
      ).rejects.toThrow(/may not read employee\.bank/)
    }
    // A refusal is evidence, not silence: docs/06 D4's question is "who tried".
    expect((await auditCount('employee.bank_detail.read', 'denied')) - before).toBe(2)

    await expect(
      repository.readDocumentNumber(RECEPTIONIST, {
        employeeId,
        documentId,
        purpose: 'credential_check',
      }),
    ).rejects.toThrow(/may not read employee\.identity_documents/)
  })

  it('allows the owner, the manager and the accountant, which keeps the refusals meaningful', async () => {
    const employeeId = await employee('rbac-allowed')
    await repository.writeBankDetail(MANAGER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    expect(
      (await repository.readBankDetail(OWNER, { employeeId, purpose: 'wps_file' }))?.iban,
    ).toBe(FIXTURE_IBAN)
    expect(
      (await repository.readBankDetail(MANAGER, { employeeId, purpose: 'wps_file' }))
        ?.accountHolder,
    ).toBe(FIXTURE_ACCOUNT_HOLDER)
    // The accountant holds `employee.bank` and NOT `employee:read` (F07: "Salary and bank are needed to
    // run payroll; clinical data never is"). This assertion is what says the FIELD GROUP is the
    // authorisation for a field-level read: add a coarse `employee:read` check to that path and the role
    // that runs payroll loses the account it is paying into.
    expect(
      (await repository.readBankDetail(ACCOUNTANT, { employeeId, purpose: 'wps_file' }))?.iban,
    ).toBe(FIXTURE_IBAN)
  })

  it('drops the wage columns for a manager and keeps them for the owner', async () => {
    const employeeId = await employee('rbac-projection', {
      basicWageFils: 200_000,
      housingAllowanceFils: 50_000,
    })
    const asOwner = await repository.readEmployee(OWNER, employeeId)
    expect(asOwner?.visible['basicWageFils']).toBe('200000')
    // The manager is the role holding `employee:read` and not `employee.salary`, so the projection is
    // exercised against a real row rather than only in the pure test. If P-HR ever grants the manager
    // `employee.salary`, this assertion fails and that is the review the grant deserves.
    const asManager = await repository.readEmployee(MANAGER, employeeId)
    expect(asManager?.visible['basicWageFils']).toBeUndefined()
    expect(asManager?.visible['totalWageFils']).toBeUndefined()
    expect(asManager?.visible['staffReference']).toBe(reference('rbac-projection'))
    expect(asManager?.refused.map((entry) => entry.field)).toContain('basicWageFils')
    // A role with no `employee:read` at all does not get the record either.
    await expect(repository.readEmployee(RECEPTIONIST, employeeId)).rejects.toThrow(
      /may not employee:read/,
    )
  })

  it('refuses an UNLISTED field rather than returning it', async () => {
    // The defect this criterion exists to catch: a policy that allow-lists reads and defaults to permit.
    // `ibanLast4` is the field somebody adds to a query next, and nothing in the map mentions it.
    const record = { staffReference: 'x', ibanLast4: '0000' }
    const { visible, refused } = projectEmployeeRecord('owner', record)
    expect(visible.staffReference).toBe('x')
    expect(visible.ibanLast4).toBeUndefined()
    expect(refused).toEqual([{ field: 'ibanLast4', reason: EMPLOYEE_FIELD_ERRORS.unknownField }])
    // Even for the wildcard role, and that is the point: `owner` holds every field GROUP, so a policy
    // keyed on groups alone would return a field nobody classified.
    expect(() => assertEmployeeFieldReadable('owner', 'ibanLast4')).toThrow(/UnknownEmployeeField/)
  })

  it('keeps the sealed fields out of any projection, whatever the role', async () => {
    // A sealed field is only ever returned by an audited decrypt. If one ever appeared on a row, the
    // projection must not hand it over as though it were an ordinary column.
    const { visible, refused } = projectEmployeeRecord('receptionist', {
      staffReference: 'x',
      bankIban: FIXTURE_IBAN,
    })
    expect(visible.bankIban).toBeUndefined()
    expect(refused[0]?.reason).toContain('employee.bank')
  })
})

describe('wages are integer fils, refused by the database when they are not', () => {
  it('refuses a decimal AED figure with the bigint domain’s own error', async () => {
    const employeeId = await employee('fils-decimal')
    // 1250.50 AED is 125050 fils. Sent as a decimal it is refused by the DOMAIN's base type, not by an
    // application check: postgres.js sends a JS number as text, and `bigint`'s input function rejects it.
    await expect(
      sql`update employee set basic_wage_fils = ${1250.5} where id = ${employeeId}`,
    ).rejects.toThrow(/invalid input syntax for type bigint/)
    await expect(
      sql`update employee set housing_allowance_fils = ${0.01} where id = ${employeeId}`,
    ).rejects.toThrow(/invalid input syntax for type bigint/)
  })

  it('refuses a negative amount by the fils_nonneg check constraint, by name', async () => {
    const employeeId = await employee('fils-negative')
    await expect(
      sql`update employee set basic_wage_fils = ${-1} where id = ${employeeId}`,
    ).rejects.toThrow(/fils_nonneg_check/)
  })

  it('accepts integer fils, which is the control', async () => {
    const employeeId = await employee('fils-integer')
    await sql`update employee set basic_wage_fils = ${125_050} where id = ${employeeId}`
    const [row] = await sql<{ basic: string }[]>`
      select basic_wage_fils::text as basic from employee where id = ${employeeId}
    `
    // Read back as a STRING: the driver returns bigint as text so nothing rounds a money figure.
    expect(row?.basic).toBe('125050')
  })

  it('generates the same total the pure function computes', async () => {
    const employeeId = await employee('fils-total', {
      basicWageFils: 300_000,
      housingAllowanceFils: 120_000,
    })
    const [row] = await sql<{ total: string }[]>`
      select total_wage_fils::text as total from employee where id = ${employeeId}
    `
    // The database is the authority and the pure function must agree with it. Asserted against each
    // other on one row rather than trusting that two expressions read alike.
    const pure = totalMonthlyWageFils({
      basicWageFils: 300_000 as never,
      housingAllowanceFils: 120_000 as never,
      transportAllowanceFils: null,
      otherAllowanceFils: null,
    })
    expect(row?.total).toBe('420000')
    expect(String(pure)).toBe(row?.total)
  })

  it('leaves the total NULL while the basic wage is unknown, rather than reading as zero', async () => {
    const employeeId = await employee('fils-absent')
    const [row] = await sql<{ total: string | null }[]>`
      select total_wage_fils::text as total from employee where id = ${employeeId}
    `
    expect(row?.total).toBeNull()
    expect(
      totalMonthlyWageFils({
        basicWageFils: null,
        housingAllowanceFils: 50_000 as never,
        transportAllowanceFils: null,
        otherAllowanceFils: null,
      }),
    ).toBeNull()
  })
})

describe('the publication guard is a column nothing can write', () => {
  it('refuses a direct write to is_publishable', async () => {
    const employeeId = await employee('publishable-write')
    await expect(
      sql`update employee set is_publishable = true where id = ${employeeId}`,
    ).rejects.toThrow(/can only be updated to DEFAULT/)
  })

  it('needs both a display name and a recorded consent', async () => {
    const employeeId = await employee('publishable-both')
    await sql`update employee set display_name = ${reference('A Named Fixture')} where id = ${employeeId}`
    const [named] = await sql<{ is_publishable: boolean }[]>`
      select is_publishable from employee where id = ${employeeId}
    `
    expect(named?.is_publishable).toBe(false)
    // Consent with no record of who took it and when is refused outright: otherwise the guard is one
    // UPDATE away from being satisfied with no evidence behind it.
    await expect(
      sql`update employee set photo_consent = true where id = ${employeeId}`,
    ).rejects.toThrow(/employee_photo_consent_has_a_record/)
    await sql`
      update employee
         set photo_consent = true,
             photo_consent_recorded_at = now(),
             photo_consent_recorded_by = 'phr01-fixture'
       where id = ${employeeId}
    `
    const [consented] = await sql<{ is_publishable: boolean }[]>`
      select is_publishable from employee where id = ${employeeId}
    `
    expect(consented?.is_publishable).toBe(true)
  })

  it('refuses a placeholder display name, which would publish as though it were a name', async () => {
    // The fixture reference cannot itself carry a marker: 'placeholder' is one of the words 0026's
    // is_placeholder_text() matches, so naming this employee 'publishable-placeholder' was refused by
    // employee_staff_reference_not_placeholder - the constraint working on the fixture that tests it.
    const employeeId = await employee('publishable-marker')
    await expect(
      sql`update employee set display_name = 'Name TBC' where id = ${employeeId}`,
    ).rejects.toThrow(/employee_display_name_not_placeholder/)
  })
})

describe('the sealed tables are reachable only by the roles that need them', () => {
  it('keeps the reporting role out of the bank table', async () => {
    const [row] = await sql<Record<string, boolean>[]>`
      select has_table_privilege('berelax_readonly', 'employee_bank_detail', 'SELECT') as bank,
             has_column_privilege('berelax_readonly', 'employee_document', 'number_ct', 'SELECT')
               as number_ct,
             has_column_privilege('berelax_readonly', 'employee_document', 'expires_on', 'SELECT')
               as expires_on
    `
    expect(row?.['bank']).toBe(false)
    // The control: the reporting role keeps the expiry dates a credential report is made of.
    expect(row?.['expires_on']).toBe(true)
    /*
      And it CAN still read `number_ct`, which is asserted rather than wished away.

      0050 first carried `revoke select (number_ct, …) on employee_document from berelax_readonly`, and
      that statement is a no-op: a column-level REVOKE does not subtract from a TABLE-level grant, and
      0009's `alter default privileges` gives this role select on the whole table. This assertion is here
      so the next reader sees the fact instead of a comment claiming a protection that was never applied —
      and so that if somebody does make it real (revoke the table, re-grant the other columns), this test
      fails and they have to say why in the same change.

      What protects the column is the KEY, not the grant: these are ciphertext bytes, berelax_readonly
      holds no STAFF_PII_KEK, and reading them reveals the length of a document number and nothing else.
    */
    expect(row?.['number_ct']).toBe(true)
  })

  it('keeps the clinical role out of the staff tables, and refuses a DELETE of a bank row', async () => {
    const [row] = await sql<Record<string, boolean>[]>`
      select has_table_privilege('berelax_clinical', 'employee_bank_detail', 'SELECT') as clinical,
             has_table_privilege('berelax_app', 'employee_bank_detail', 'DELETE')      as app_delete,
             has_table_privilege('berelax_app', 'employee_bank_detail', 'INSERT')      as app_insert,
             has_table_privilege('berelax_app', 'audit_event', 'INSERT')               as app_audit
    `
    expect(row?.['clinical']).toBe(false)
    // A bank account is superseded, never deleted: the row is the evidence of where a salary was sent.
    expect(row?.['app_delete']).toBe(false)
    expect(row?.['app_insert']).toBe(true)
    // H-HARD-03 had to grant this to `berelax_clinical`. The application role has held it since 0009, so
    // the audited read needs no new grant — checked rather than assumed.
    expect(row?.['app_audit']).toBe(true)
  })

  it('keeps one current bank account per employee', async () => {
    const employeeId = await employee('one-current')
    const first = await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: FIXTURE_IBAN, accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    const second = await repository.writeBankDetail(OWNER, {
      employeeId,
      detail: { iban: 'AE000000000000000000001', accountHolder: FIXTURE_ACCOUNT_HOLDER },
    })
    expect(second.supersededId).toBe(first.bankDetailId)
    const rows = await sql<{ n: string }[]>`
      select count(*)::text as n from employee_bank_detail
       where employee_id = ${employeeId} and superseded_at is null
    `
    expect(rows[0]?.n).toBe('1')
    // The superseded row is still there and still openable: it is the record of where money was sent.
    const [old] = await sql<
      { ct: Buffer; nonce: Buffer; wrapped_key: Buffer; kid: string; aad_fp: string }[]
    >`
      select detail_ct as ct, detail_nonce as nonce, detail_wrapped_key as wrapped_key,
             detail_kid as kid, detail_aad_fp as aad_fp
        from employee_bank_detail where id = ${first.bankDetailId}
    `
    if (old === undefined) throw new Error('the superseded row was deleted')
    expect(
      openBankDetail(
        kek,
        { table: 'employee_bank_detail', recordId: first.bankDetailId, employeeId },
        {
          ct: old.ct,
          nonce: old.nonce,
          wrappedKey: old.wrapped_key,
          kid: old.kid,
          aadFp: old.aad_fp,
        },
      ).iban,
    ).toBe(FIXTURE_IBAN)
    // And the current row is the OTHER account, so "which account does payroll pay into" has one answer.
    expect(
      (await repository.readBankDetail(OWNER, { employeeId, purpose: 'wps_file' }))?.iban,
    ).toBe('AE000000000000000000001')
  })
})
