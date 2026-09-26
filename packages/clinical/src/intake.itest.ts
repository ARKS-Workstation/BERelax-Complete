import type { Instant } from '@berelax/core'
import { createConnection, type Sql, withUnitOfWork, writeSetting } from '@berelax/db'
import {
  CLINICAL_REAL_INTAKE_SETTING_KEY,
  CLINICAL_STEP_UP_WINDOW_SETTING_KEY,
} from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateKek, type Kek, open } from './envelope.ts'
import type { ClinicalErrorSink, ClinicalLogger, ClinicalLogLine } from './logging.ts'
import { type ClinicalIntakeStore, createClinicalIntakeStore } from './repository.ts'

/**
 * Clinical intake against real PostgreSQL (C-CRM-08).
 *
 * The unit suites prove the decisions — `intake.test.ts` in `@berelax/core` for the gate and the render,
 * `envelope-intake-aad.test.ts` for the fourth AAD term. This proves the things only a real database can:
 * that the app role cannot see the table at all, that a refused write leaves NO ROW, that a read writes an
 * audit row a query can find, that a payload read with the wrong key fails rather than returning
 * something, and that the stored bytes do not contain the plaintext.
 *
 * ## Isolation, and why it is by id prefix
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12). Every row this file writes carries its own uuid prefix and `sweep()` removes exactly those, so
 * a previous run's rows cannot satisfy this run's assertions — the failure mode that made
 * `with-google.itest.ts` green for weeks while proving nothing.
 *
 * Templates are the one thing NOT written with a fixed number. `publishTemplate` computes the next version
 * for the locale, so this file works whether or not `crypto/rotation.itest.ts` has already seeded its own
 * fixture template — and migration 0082 requires a new version to be numbered above every existing one, so
 * a hard-coded number here would make the two files order-dependent.
 *
 * ## Every audit assertion is a DELTA
 *
 * `audit_event` is append-only (ADR 0008, brief rule 9), so a total is a number every other suite in the
 * run contributes to. Counts are taken in SQL against this file's own entity ids, before and after.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/** Rows this file owns. Hex, because these are UUIDs. */
const CUSTOMER_PREFIX = '0c8c8c08'
const EMPLOYEE_PREFIX = '0c8c8c09'

const customer = (n: number) => `${CUSTOMER_PREFIX}-0000-7000-8000-${String(n).padStart(12, '0')}`
const employee = (n: number) => `${EMPLOYEE_PREFIX}-0000-7000-8000-${String(n).padStart(12, '0')}`

/**
 * Obviously-fake answers. `Y5-residency` gates loading real intake data, and brief rule 15's argument
 * bites hardest here: a plausible health fact in a fixture is indistinguishable from a real one.
 */
const SENTINEL = 'SYNTHETIC-FIXTURE-ONLY-4QK7'
const ANSWERS = {
  recent_surgery: true,
  medication: `none declared ${SENTINEL}`,
  pressure: 'firm',
} as const

/** Every distinct string a payload holds, for the leak sweeps. */
const PAYLOAD_VALUES = [SENTINEL, `none declared ${SENTINEL}`, 'firm'] as const

const PURPOSE = 'checking contraindications before this appointment'
const OTHER_PURPOSE = 'answering a query about an invoice line'

const FIELDS = [
  {
    key: 'recent_surgery',
    label: 'Any surgery in the last six months?',
    kind: 'boolean' as const,
    required: true,
  },
  {
    key: 'medication',
    label: 'Are you taking any medication?',
    kind: 'short_text' as const,
    required: false,
  },
  {
    key: 'pressure',
    label: 'Preferred pressure',
    kind: 'choice' as const,
    required: false,
    choices: ['light', 'medium', 'firm'],
  },
]

/**
 * The clock this suite hands the store, and why it is the system clock rather than a fixed one.
 *
 * `grantStepUp` computes `expires_at` in the DATABASE — `now() + interval` — because migration 0082's
 * ceiling CHECK compares it against `granted_at`, whose default is the database's `now()`. A fixed clock
 * in this process therefore disagrees with every grant it reads, and the first version of this file used
 * `fixedClock('2026-09-26T12:00:00Z')` against a database whose `now()` was 03:12 the same morning — so
 * every grant read as expired and six cases failed naming the step-up window rather than the clock.
 *
 * Determinism is kept where it is load-bearing instead: the expiry-boundary case builds its own clocks
 * from the `expiresAt` the grant returned, so it asserts the boundary exactly and reads no wall time.
 */
const systemClock = { now: () => Date.now() as Instant }

let sql: Sql
let kek: Kek
let wrongKek: Kek
let store: ClinicalIntakeStore
let lines: ClinicalLogLine[]
let breadcrumbs: unknown[]

const logger: ClinicalLogger = { log: (line) => lines.push(line) }
const errors: ClinicalErrorSink = {
  addBreadcrumb: (crumb) => breadcrumbs.push(crumb),
  captureException: (error) => breadcrumbs.push({ captured: String(error) }),
}

const sweep = async (): Promise<void> => {
  await sql`
    delete from clinical.intake_submission where customer_id::text like ${`${CUSTOMER_PREFIX}%`}
  `
  await sql`
    delete from clinical.treatment_consent where customer_id::text like ${`${CUSTOMER_PREFIX}%`}
  `
  await sql`delete from clinical.step_up_grant where employee_id::text like ${`${EMPLOYEE_PREFIX}%`}`
  // The `ar` fixture templates the versioning cases insert. Left behind, they would raise the locale's
  // high-water mark for every later run, which is harmless — but a template row nothing references is
  // still a row this file created and did not clean up.
  await sql`
    delete from clinical.intake_form_template
     where locale = 'ar' and consent_hash like 'ar-%'
       and not exists (
         select 1 from clinical.intake_submission s where s.template_id = clinical.intake_form_template.id
       )
       and not exists (
         select 1 from clinical.treatment_consent c where c.template_id = clinical.intake_form_template.id
       )
  `
}

/**
 * How many refusals were recorded against one customer, counted in SQL.
 *
 * A refusal has no entity id — nothing was written, so there is no row to name — so it is counted by
 * action plus the customer in `after_state`. Scoped to this file's own prefix, and a DELTA either side of
 * the call, because `audit_event` is append-only and a total is a number every other suite contributes to.
 *
 * This is also the ONLY observable that separates the application's consent gate from migration 0082's
 * trigger. Both refuse the same INSERT with the same name; only the application refuses it before the
 * transaction opens and records that somebody tried. A gate case that asserted on the message alone would
 * pass with the application check deleted, because the database would supply the same message — which is
 * exactly what happened the first time this file was written.
 */
const refusalCount = async (customerId: string, refusal: string): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
     where operation = 'denied'
       and after_state ->> 'customerId' = ${customerId}
       and after_state ->> 'refusal' = ${refusal}
  `
  return Number(row?.n ?? '0')
}

/** How many audit rows exist for one entity id, counted in SQL. Never a total, never through a limit. */
const auditCount = async (entityId: string, operation?: string): Promise<number> => {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
     where entity_id = ${entityId}
       and (${operation ?? null}::text is null or operation = ${operation ?? null})
  `
  return Number(row?.n ?? '0')
}

const publish = async (
  over: { title?: string; fields?: typeof FIELDS; consentText?: string } = {},
) =>
  await store.publishTemplate({
    locale: 'en',
    title: over.title ?? 'Before your visit',
    fields: over.fields ?? FIELDS,
    consentText:
      over.consentText ??
      'I agree that my answers may be held so the session can be delivered safely.',
    actor: { employeeId: employee(1), label: 'fixture publisher' },
  })

/** A customer with consent to a template's wording, and their submission. */
const submitFor = async (
  n: number,
  templateId: string,
): Promise<{ readonly customerId: string; readonly submissionId: string }> => {
  const customerId = customer(n)
  await store.recordConsent({
    customerId,
    templateId,
    capturedVia: 'in_salon',
    signaturePresent: true,
    actor: { employeeId: employee(1), label: 'fixture front desk' },
  })
  const { submissionId } = await store.recordIntake({
    customerId,
    templateId,
    answers: ANSWERS,
    submittedVia: 'in_salon',
    dataOrigin: 'synthetic',
    actor: { employeeId: employee(1), label: 'fixture front desk' },
  })
  return { customerId, submissionId }
}

const stepUp = async (n: number, purpose = PURPOSE) =>
  await store.grantStepUp({
    employeeId: employee(n),
    statedPurpose: purpose,
    method: 'totp',
    actorLabel: 'fixture reader',
  })

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  await sweep()
  lines = []
  breadcrumbs = []

  const [active] = await sql<{ v: string | null }[]>`select clinical.active_kek_version() as v`
  if (!active?.v) throw new Error('no active KEK version; migration 0043 seeds one')
  // The key MATERIAL is this process's own and is written nowhere. Only the version label is shared with
  // the database, which is the whole arrangement: the label says which externally-held key opens a row.
  kek = generateKek(active.v)
  wrongKek = generateKek(active.v)

  store = createClinicalIntakeStore({
    sql,
    kek,
    clock: systemClock,
    logger,
    errors,
  })
}, 120_000)

afterAll(async () => {
  await sweep().catch(() => {})
  await sql?.end({ timeout: 5 })
})

describe('the boundary, for the table this unit added', () => {
  it('the app role cannot read a submission; the clinical role can', async () => {
    // The acceptance line names the SQLSTATE, so the SQLSTATE is what is asserted: `insufficient_privilege`
    // is 42501, and a code is a contract where a message is prose that also appears in errors that are not
    // this one. Both are checked, because the message is what an operator reads.
    const denied = await sql
      .begin(async (tx) => {
        await tx`set local role berelax_app`
        await tx`select 1 from clinical.intake_submission limit 1`
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(denied, 'the app role was NOT denied, which is the boundary gone').not.toBeNull()
    expect((denied as { readonly code?: string }).code).toBe('42501')
    expect(String(denied)).toMatch(/permission denied/i)

    // The control. Without it, the refusal above is satisfied by a table that nobody can read, including
    // the role whose whole purpose is to read it.
    await sql.begin(async (tx) => {
      await tx`set local role berelax_clinical`
      const rows = await tx`select count(*) from clinical.intake_submission`
      expect(rows).toHaveLength(1)
    })
  })

  it('the app role cannot read a step-up grant either, and the clinical role can', async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role berelax_app`
        await tx`select 1 from clinical.step_up_grant limit 1`
      }),
    ).rejects.toThrow(/permission denied/i)
    await sql.begin(async (tx) => {
      await tx`set local role berelax_clinical`
      expect(await tx`select count(*) from clinical.step_up_grant`).toHaveLength(1)
    })
  })

  it('no foreign key crosses the boundary, including from the table 0082 added', async () => {
    const rows = await sql<{ constraint_name: string; from_table: string; to_table: string }[]>`
      select c.conname as constraint_name,
             sf.nspname || '.' || tf.relname as from_table,
             st.nspname || '.' || tt.relname as to_table
        from pg_constraint c
        join pg_class tf on tf.oid = c.conrelid
        join pg_namespace sf on sf.oid = tf.relnamespace
        join pg_class tt on tt.oid = c.confrelid
        join pg_namespace st on st.oid = tt.relnamespace
       where c.contype = 'f'
         and sf.nspname <> st.nspname
         and 'clinical' in (sf.nspname, st.nspname)
    `
    expect(rows, `cross-boundary foreign keys: ${JSON.stringify(rows)}`).toEqual([])

    // The control on the query itself: it must FIND the foreign keys that exist INSIDE the schema, or
    // the assertion above is satisfied by a query that matches nothing (ADR 0003).
    const [inside] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from pg_constraint c
        join pg_class tf on tf.oid = c.conrelid
        join pg_namespace sf on sf.oid = tf.relnamespace
       where c.contype = 'f' and sf.nspname = 'clinical'
    `
    expect(Number(inside?.n ?? '0')).toBeGreaterThan(0)

    // And `step_up_grant` holds an employee id that is deliberately NOT a foreign key.
    const [grantFks] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from pg_constraint c
        join pg_class tf on tf.oid = c.conrelid
       where c.contype = 'f' and tf.relname = 'step_up_grant'
    `
    expect(Number(grantFks?.n ?? '0')).toBe(0)
  })
})

describe('the consent gate', () => {
  it('refuses a submission BY NAME and writes no row when consent was never given', async () => {
    const { templateId } = await publish()
    const customerId = customer(10)
    const before = await sql<{ n: string }[]>`
      select count(*)::text as n from clinical.intake_submission
       where customer_id = ${customerId}::uuid
    `

    await expect(
      store.recordIntake({
        customerId,
        templateId,
        answers: ANSWERS,
        submittedVia: 'online',
        dataOrigin: 'synthetic',
        actor: { employeeId: employee(1), label: 'fixture front desk' },
      }),
    ).rejects.toThrow(/IntakeConsentNotEstablished/)

    const after = await sql<{ n: string }[]>`
      select count(*)::text as n from clinical.intake_submission
       where customer_id = ${customerId}::uuid
    `
    // Nothing was stored. This is the assertion the unit exists for: a refusal is not a soft state.
    expect(after[0]?.n).toBe(before[0]?.n)
    expect(after[0]?.n).toBe('0')
  })

  it('refuses after the consent is withdrawn, and the row already stored is retained', async () => {
    const { templateId } = await publish()
    const customerId = customer(11)
    const { consentId } = await store.recordConsent({
      customerId,
      templateId,
      capturedVia: 'online',
      signaturePresent: false,
      actor: { employeeId: employee(1), label: 'fixture front desk' },
    })
    const first = await store.recordIntake({
      customerId,
      templateId,
      answers: ANSWERS,
      submittedVia: 'online',
      dataOrigin: 'synthetic',
      actor: { employeeId: employee(1), label: 'fixture front desk' },
    })

    await store.withdrawConsent({
      consentId,
      actor: { employeeId: employee(1), label: 'fixture front desk' },
    })

    await expect(
      store.recordIntake({
        customerId,
        templateId,
        answers: ANSWERS,
        submittedVia: 'online',
        dataOrigin: 'synthetic',
        actor: { employeeId: employee(1), label: 'fixture front desk' },
      }),
    ).rejects.toThrow(/IntakeConsentWithdrawn/)

    // The record already captured is NOT deleted. ADR 0010 revokes DELETE even from the clinical role:
    // a clinical record is evidence, and a withdrawal stops it being read rather than erasing it.
    const [kept] = await sql<{ n: string }[]>`
      select count(*)::text as n from clinical.intake_submission where id = ${first.submissionId}::uuid
    `
    expect(kept?.n).toBe('1')
  })

  it('refuses a submission against a template whose consent wording nobody consented to', async () => {
    // The case the hash exists for, and the ONLY one that distinguishes a gate keyed on the wording from
    // a gate keyed on the customer or on the template id. The client consented to version A's paragraph;
    // version B's paragraph is different; the submission is against B. A gate keyed on "does this client
    // have a consent" accepts it, and what it accepts is a submission whose consent record does not
    // correspond to anything the person read.
    const a = await publish({ consentText: 'Wording A: I agree that my answers may be held.' })
    const customerId = customer(14)
    await store.recordConsent({
      customerId,
      templateId: a.templateId,
      capturedVia: 'in_salon',
      signaturePresent: true,
      actor: { employeeId: employee(1), label: 'fixture front desk' },
    })
    const b = await publish({
      consentText: 'Wording B: I agree that my answers may be held AND shared with a third party.',
    })
    expect(b.consentHash).not.toBe(a.consentHash)

    const refusedBefore = await refusalCount(customerId, 'consent_not_established')
    await expect(
      store.recordIntake({
        customerId,
        templateId: b.templateId,
        answers: ANSWERS,
        submittedVia: 'in_salon',
        dataOrigin: 'synthetic',
        actor: { employeeId: employee(1), label: 'fixture front desk' },
      }),
    ).rejects.toThrow(/IntakeConsentNotEstablished/)
    // The APPLICATION refused it, not only the database. Both produce the same name, so the audit row is
    // the only thing that tells them apart — and the application's refusal is the one that happens before
    // anything is sealed and that records the attempt.
    expect(await refusalCount(customerId, 'consent_not_established')).toBe(refusedBefore + 1)

    // The control: the SAME client and the SAME answers against the version they did consent to are
    // stored. Without it the refusal above is satisfied by a client who cannot submit anything at all.
    await expect(
      store.recordIntake({
        customerId,
        templateId: a.templateId,
        answers: ANSWERS,
        submittedVia: 'in_salon',
        dataOrigin: 'synthetic',
        actor: { employeeId: employee(1), label: 'fixture front desk' },
      }),
    ).resolves.toMatchObject({ submissionId: expect.any(String) })
  })

  it('the DATABASE refuses the same insert, so a psql session is held to it too', async () => {
    // The application gate and the trigger are both real and neither makes the other redundant. This is
    // the half that survives a mistake in the code above it, which is ADR 0010's whole thesis.
    const { templateId } = await publish()
    await expect(
      sql.begin(async (tx) => {
        await tx`
          insert into clinical.intake_submission
            (customer_id, template_id, payload_ciphertext, payload_nonce, wrapped_data_key,
             kek_version, aad_fingerprint, submitted_via, template_version, aad_context, data_origin,
             retain_until)
          select ${customer(12)}::uuid, t.id, '\\x00'::bytea, '\\x01'::bytea, '\\x02'::bytea,
                 clinical.active_kek_version(), 'fp', 'online', t.version,
                 'template_version=' || t.version::text, 'synthetic', now() + interval '25 years'
            from clinical.intake_form_template t where t.id = ${templateId}::uuid
        `
      }),
    ).rejects.toThrow(/IntakeConsentNotEstablished/)
  })
})

describe('the Y5-residency gate', () => {
  it('refuses a real payload by name, and permits one once the setting is turned on', async () => {
    const { templateId } = await publish()
    const customerId = customer(13)
    await store.recordConsent({
      customerId,
      templateId,
      capturedVia: 'in_salon',
      signaturePresent: true,
      actor: { employeeId: employee(1), label: 'fixture front desk' },
    })

    const real = {
      customerId,
      templateId,
      answers: ANSWERS,
      submittedVia: 'in_salon' as const,
      dataOrigin: 'real' as const,
      actor: { employeeId: employee(1), label: 'fixture front desk' },
    }
    const refusedBefore = await refusalCount(customerId, 'real_intake_not_permitted')
    await expect(store.recordIntake(real)).rejects.toThrow(/ClinicalRealIntakeNotPermitted/)
    // The refusal names the open question, because "refused" without it sends somebody bug-hunting.
    await expect(store.recordIntake(real)).rejects.toThrow(/Y5-residency/)
    // And the APPLICATION refused it, before the transaction opened and before anything was sealed.
    // Migration 0082's ZJ005 refuses the same write with the same name, so the audit row is the only
    // observable that separates the two — see `refusalCount`.
    expect(await refusalCount(customerId, 'real_intake_not_permitted')).toBe(refusedBefore + 2)

    try {
      await withUnitOfWork(sql, { kind: 'staff', label: 'fixture owner' }, (uow) =>
        writeSetting(uow, {
          key: CLINICAL_REAL_INTAKE_SETTING_KEY,
          value: true,
          role: 'owner',
          actorLabel: 'fixture owner',
          justification:
            'fixture: proving the gate is a configuration change and not a code change',
        }),
      )
      const stored = await store.recordIntake(real)
      expect(stored.submissionId).toMatch(/^[0-9a-f-]{36}$/)
    } finally {
      // Restored whatever happened above. Left on, this would permit a real payload for every later file
      // in a suite that runs sequentially against one database.
      await withUnitOfWork(sql, { kind: 'staff', label: 'fixture owner' }, (uow) =>
        writeSetting(uow, {
          key: CLINICAL_REAL_INTAKE_SETTING_KEY,
          value: false,
          role: 'owner',
          actorLabel: 'fixture owner',
          justification: 'fixture teardown: back to the strict default',
        }),
      )
    }

    // And the gate is shut again, which is the control on the teardown.
    await expect(store.recordIntake(real)).rejects.toThrow(/ClinicalRealIntakeNotPermitted/)
  })

  it('a compliance-locked change with no written justification is refused', async () => {
    await expect(
      withUnitOfWork(sql, { kind: 'staff', label: 'fixture owner' }, (uow) =>
        writeSetting(uow, {
          key: CLINICAL_REAL_INTAKE_SETTING_KEY,
          value: true,
          role: 'owner',
          actorLabel: 'fixture owner',
        }),
      ),
    ).rejects.toThrow(/justification is required/)
  })

  it('a manager may not turn it on at all', async () => {
    await expect(
      withUnitOfWork(sql, { kind: 'staff', label: 'fixture manager' }, (uow) =>
        writeSetting(uow, {
          key: CLINICAL_REAL_INTAKE_SETTING_KEY,
          value: true,
          role: 'manager',
          actorLabel: 'fixture manager',
          justification: 'fixture: a manager attempting an owner-only change',
        }),
      ),
    ).rejects.toThrow()
  })
})

describe('the read gate and the audit trail', () => {
  it('refuses a read with no step-up, writes a denied row, and succeeds after stepping up', async () => {
    const { templateId } = await publish()
    const { submissionId } = await submitFor(20, templateId)
    const reader = { employeeId: employee(20), label: 'fixture reader' }

    const deniedBefore = await auditCount(submissionId, 'denied')
    await expect(
      store.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE }),
    ).rejects.toThrow(/clinical_step_up_required/)
    expect(await auditCount(submissionId, 'denied')).toBe(deniedBefore + 1)

    const readBefore = await auditCount(submissionId, 'read')
    await stepUp(20)
    const result = await store.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE })
    expect(result.rendered.answers.map((a) => a.value)).toEqual(['yes', ANSWERS.medication, 'firm'])
    expect(await auditCount(submissionId, 'read')).toBe(readBefore + 1)
  })

  it('the read audit row carries the actor, the stated purpose and the submission id', async () => {
    const { templateId } = await publish()
    const { submissionId } = await submitFor(21, templateId)
    const reader = { employeeId: employee(21), label: 'fixture reader 21' }
    await stepUp(21)
    await store.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE })

    const [row] = await sql<
      {
        actorId: string
        actorLabel: string
        action: string
        entityId: string
        operation: string
        after: { statedPurpose?: string; grantId?: string } | null
      }[]
    >`
      select actor_id as "actorId", actor_label as "actorLabel", action, entity_id as "entityId",
             operation, after_state as after
        from audit_event
       where entity_id = ${submissionId} and operation = 'read'
       order by occurred_at desc
       limit 1
    `
    expect(row?.actorId).toBe(employee(21))
    expect(row?.actorLabel).toBe('fixture reader 21')
    expect(row?.action).toBe('clinical.intake_submission.read')
    expect(row?.entityId).toBe(submissionId)
    expect(row?.after?.statedPurpose).toBe(PURPOSE)
    expect(row?.after?.grantId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a grant for another purpose does not open the record', async () => {
    const { templateId } = await publish()
    const { submissionId } = await submitFor(22, templateId)
    const reader = { employeeId: employee(22), label: 'fixture reader 22' }
    await stepUp(22, OTHER_PURPOSE)
    await expect(
      store.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE }),
    ).rejects.toThrow(/clinical_step_up_purpose_mismatch/)
    // The control: the SAME grant opens it for the purpose it was given for.
    await expect(
      store.readIntake({ submissionId, actor: reader, statedPurpose: OTHER_PURPOSE }),
    ).resolves.toMatchObject({ submissionId })
  })

  it('an expired window refuses the read, and the window comes from the setting', async () => {
    const { templateId } = await publish()
    const { submissionId } = await submitFor(23, templateId)
    const reader = { employeeId: employee(23), label: 'fixture reader 23' }
    const granted = await stepUp(23)

    const windowMinutes = granted.windowMinutes
    expect(windowMinutes).toBe(5)

    // The clock is this suite's, so "expired" is a value rather than a wait: a store with a clock five
    // minutes and one second past the grant refuses it.
    const late = createClinicalIntakeStore({
      sql,
      kek,
      clock: { now: () => (granted.expiresAt + 1) as Instant },
      logger,
      errors,
    })
    await expect(
      late.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE }),
    ).rejects.toThrow(/clinical_step_up_expired/)

    // The control: a clock one millisecond BEFORE the expiry permits it, so the refusal is the window
    // and not a broken fixture.
    const early = createClinicalIntakeStore({
      sql,
      kek,
      clock: { now: () => (granted.expiresAt - 1) as Instant },
      logger,
      errors,
    })
    await expect(
      early.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE }),
    ).resolves.toMatchObject({ submissionId })
  })

  it('a revoked grant refuses the read', async () => {
    const { templateId } = await publish()
    const { submissionId } = await submitFor(24, templateId)
    const reader = { employeeId: employee(24), label: 'fixture reader 24' }
    const granted = await stepUp(24)
    await sql`
      update clinical.step_up_grant set revoked_at = now() where id = ${granted.grantId}::uuid
    `
    await expect(
      store.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE }),
    ).rejects.toThrow(/clinical_step_up_revoked/)
  })

  it('the step-up window setting cannot be widened past the ceiling the database enforces', async () => {
    await expect(
      withUnitOfWork(sql, { kind: 'staff', label: 'fixture owner' }, (uow) =>
        writeSetting(uow, {
          key: CLINICAL_STEP_UP_WINDOW_SETTING_KEY,
          value: 60,
          role: 'owner',
          actorLabel: 'fixture owner',
          justification: 'fixture: attempting a window above the ceiling',
        }),
      ),
    ).rejects.toThrow()
  })
})

describe('what an attacker holding the rows sees', () => {
  it('the stored bytes do not contain any payload value', async () => {
    const { templateId } = await publish()
    const { submissionId } = await submitFor(30, templateId)
    // The bytes are read as bytes and decoded in this process. `convert_from(..., 'LATIN1')` is what the
    // first version did, and Postgres refuses it: a ciphertext contains 0x00, which is not a valid
    // character in any server encoding. A search for a plaintext run has to happen over the raw octets.
    const [row] = await sql<{ ciphertext: Buffer; nonce: Buffer; wrappedDataKey: Buffer }[]>`
      select payload_ciphertext as "ciphertext", payload_nonce as "nonce",
             wrapped_data_key as "wrappedDataKey"
        from clinical.intake_submission where id = ${submissionId}::uuid
    `
    if (row === undefined) throw new Error('fixture: the submission was not stored')
    const stored = Buffer.concat([row.ciphertext, row.nonce, row.wrappedDataKey]).toString('latin1')
    for (const value of PAYLOAD_VALUES) {
      expect(stored, `stored bytes contain ${value}`).not.toContain(value)
    }
    // The control on the search: the same needles ARE found in the plaintext.
    const plaintext = JSON.stringify(ANSWERS)
    for (const value of PAYLOAD_VALUES) expect(plaintext).toContain(value)
  })

  it('a row read with the WRONG key fails rather than returning something', async () => {
    const { templateId } = await publish()
    const { submissionId } = await submitFor(31, templateId)
    const [row] = await sql<
      {
        customerId: string
        aadContext: string
        ciphertext: Buffer
        nonce: Buffer
        wrappedDataKey: Buffer
        kekVersion: string
        aadFingerprint: string
      }[]
    >`
      select customer_id as "customerId", aad_context as "aadContext",
             payload_ciphertext as "ciphertext", payload_nonce as "nonce",
             wrapped_data_key as "wrappedDataKey", kek_version as "kekVersion",
             aad_fingerprint as "aadFingerprint"
        from clinical.intake_submission where id = ${submissionId}::uuid
    `
    if (row === undefined) throw new Error('fixture: the submission was not stored')
    const binding = {
      table: 'clinical.intake_submission',
      recordId: submissionId,
      customerId: row.customerId,
      context: row.aadContext,
    }
    const sealed = {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      wrappedDataKey: row.wrappedDataKey,
      kekVersion: row.kekVersion,
      aadFingerprint: row.aadFingerprint,
    }
    // Same version LABEL, different key material — which is the realistic case, because the label is in
    // the database and the material is not.
    expect(wrongKek.version).toBe(kek.version)
    expect(() => open(wrongKek, binding, sealed)).toThrow(/failed authentication/)
    // The control: the right key opens it, so the failure is the key and not the row.
    expect(open(kek, binding, sealed)).toContain(SENTINEL)
  })

  it('the same answers written twice produce different ciphertext', async () => {
    const { templateId } = await publish()
    const a = await submitFor(32, templateId)
    const b = await submitFor(33, templateId)
    const rows = await sql<{ id: string; digest: string }[]>`
      select id, md5(payload_ciphertext) as digest
        from clinical.intake_submission
       where id in (${a.submissionId}::uuid, ${b.submissionId}::uuid)
    `
    expect(rows).toHaveLength(2)
    expect(rows[0]?.digest).not.toBe(rows[1]?.digest)
  })

  it('there is no plaintext column to fall back to', async () => {
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'clinical' and table_name = 'intake_submission'
    `
    const names = columns.map((c) => c.column_name)
    expect(names).not.toContain('answers')
    expect(names).not.toContain('payload')
    // The control: the scan found the table's columns at all.
    expect(names).toContain('payload_ciphertext')
  })
})

describe('versioning', () => {
  it('editing a template creates a new version, and the old submission keeps the old labels', async () => {
    const v1 = await publish({ title: 'Before your visit' })
    const { submissionId } = await submitFor(40, v1.templateId)
    const reader = { employeeId: employee(40), label: 'fixture reader 40' }
    await stepUp(40)

    const before = await store.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE })
    const labelsBefore = before.rendered.answers.map((a) => a.label)

    // The "edit": a new version with every label reworded.
    const v2 = await publish({
      title: 'Before your visit (revised)',
      fields: FIELDS.map((f) => ({ ...f, label: `${f.label} REWORDED` })),
    })
    expect(v2.version).toBe(v1.version + 1)
    expect(v2.supersededTemplateId).toBe(v1.templateId)

    const after = await store.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE })
    // The acceptance criterion: the rendered label set is EQUAL to the old version's after the edit.
    expect(after.rendered.answers.map((a) => a.label)).toEqual(labelsBefore)
    expect(after.rendered.templateVersion).toBe(v1.version)
    // The control: the new version really does have different labels, so the equality above is not
    // satisfied by an edit that changed nothing.
    expect(labelsBefore.some((label) => label.includes('REWORDED'))).toBe(false)
    const [current] = await sql<{ definition: { fields: { label: string }[] } }[]>`
      select definition from clinical.intake_form_template where id = ${v2.templateId}::uuid
    `
    expect(
      current?.definition.fields.map((f) => f.label).every((l) => l.includes('REWORDED')),
    ).toBe(true)
  })

  it('the old version is superseded and exactly one is current for the locale', async () => {
    await publish()
    await publish({ title: 'Newer still' })
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from clinical.intake_form_template
       where locale = 'en' and is_current
    `
    expect(row?.n).toBe('1')
  })

  it('the DATABASE refuses an edit to a template that already exists', async () => {
    const { templateId } = await publish()
    await expect(
      sql`
        update clinical.intake_form_template set consent_text = 'rewritten'
         where id = ${templateId}::uuid
      `,
    ).rejects.toThrow(/IntakeTemplateImmutable/)
  })

  it('the DATABASE refuses a version below the current one', async () => {
    // Worked in the `ar` locale and over a deliberate GAP, for two reasons the first version got wrong.
    // `max - 1` in `en` is a version that already EXISTS, so the unique index refused it first and the
    // case proved nothing about the trigger; and touching `en` would supersede whichever template the
    // rest of this file had just published. The gap also exercises the monotonic-not-contiguous rule:
    // `base + 5` is accepted although `base + 1` was never used.
    const [highest] = await sql<{ v: number | null }[]>`
      select max(version) as v from clinical.intake_form_template where locale = 'ar'
    `
    const base = Number(highest?.v ?? 0)
    await sql`
      insert into clinical.intake_form_template
        (version, locale, title, definition, consent_text, consent_hash, is_current)
      values (${base + 5}, 'ar', 'fixture ar', '{"fields":[]}'::jsonb, 'fixture', ${`ar-${base + 5}`},
              false)
    `
    await expect(
      sql`
        insert into clinical.intake_form_template
          (version, locale, title, definition, consent_text, consent_hash, is_current)
        values (${base + 3}, 'ar', 'backwards', '{"fields":[]}'::jsonb, 'fixture',
                ${`ar-${base + 3}`}, false)
      `,
    ).rejects.toThrow(/IntakeTemplateVersionNotNewer/)

    // The control: the very same INSERT above the maximum is accepted, so the refusal is the ordering
    // rule and not the row.
    await sql`
      insert into clinical.intake_form_template
        (version, locale, title, definition, consent_text, consent_hash, is_current)
      values (${base + 6}, 'ar', 'forwards', '{"fields":[]}'::jsonb, 'fixture', ${`ar-${base + 6}`},
              false)
    `
  })

  it('an INSERT of a version that already exists is left to ON CONFLICT', async () => {
    // A BEFORE INSERT trigger fires before ON CONFLICT is resolved, so a trigger that refused an
    // existing version would break every idempotent upsert on this table — which is how the second run
    // of `crypto/rotation.itest.ts` came to fail on a database nobody had touched.
    const [highest] = await sql<{ v: number | null }[]>`
      select max(version) as v from clinical.intake_form_template where locale = 'ar'
    `
    const existing = Number(highest?.v ?? 0)
    const result = await sql`
      insert into clinical.intake_form_template
        (version, locale, title, definition, consent_text, consent_hash, is_current)
      values (${existing}, 'ar', 'again', '{"fields":[]}'::jsonb, 'fixture', ${`ar-${existing}`}, false)
      on conflict (version, locale) do nothing
    `
    expect(result.count).toBe(0)
  })

  it('a submission may not claim a version its template does not hold', async () => {
    const { templateId } = await publish()
    await expect(
      sql`
        insert into clinical.intake_submission
          (customer_id, template_id, payload_ciphertext, payload_nonce, wrapped_data_key,
           kek_version, aad_fingerprint, submitted_via, template_version, aad_context, data_origin,
           retain_until)
        values (${customer(41)}::uuid, ${templateId}::uuid, '\\x00'::bytea, '\\x01'::bytea,
                '\\x02'::bytea, clinical.active_kek_version(), 'fp', 'online', 999999,
                'template_version=999999', 'synthetic', now() + interval '25 years')
      `,
    ).rejects.toThrow(/IntakeSubmissionVersionMismatch/)
  })
})

describe('superseding', () => {
  it('a second intake form supersedes the first, and deletes nothing', async () => {
    const { templateId } = await publish()
    const first = await submitFor(70, templateId)
    const second = await store.recordIntake({
      customerId: first.customerId,
      templateId,
      answers: ANSWERS,
      submittedVia: 'online',
      dataOrigin: 'synthetic',
      actor: { employeeId: employee(1), label: 'fixture front desk' },
    })

    const rows = await sql<{ id: string; superseded: boolean }[]>`
      select id, superseded_at is not null as superseded
        from clinical.intake_submission
       where customer_id = ${first.customerId}::uuid
       order by submitted_at, id
    `
    // Both rows are still there. ADR 0010 revokes DELETE even from the clinical role: a clinical record
    // is evidence, and the older answers are the evidence of what was true at the older appointment.
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.superseded)).toEqual([true, false])
    expect(rows.map((r) => r.id)).toEqual([first.submissionId, second.submissionId])
  })

  it('a superseded submission is still readable, because it is still evidence', async () => {
    const { templateId } = await publish()
    const first = await submitFor(71, templateId)
    await store.recordIntake({
      customerId: first.customerId,
      templateId,
      answers: ANSWERS,
      submittedVia: 'online',
      dataOrigin: 'synthetic',
      actor: { employeeId: employee(1), label: 'fixture front desk' },
    })
    const reader = { employeeId: employee(71), label: 'fixture reader 71' }
    await stepUp(71)
    await expect(
      store.readIntake({ submissionId: first.submissionId, actor: reader, statedPurpose: PURPOSE }),
    ).resolves.toMatchObject({ submissionId: first.submissionId })
  })
})

describe('retention', () => {
  it('is stored, and comes from the profile in force', async () => {
    const { templateId } = await publish()
    const { submissionId } = await submitFor(50, templateId)
    const [row] = await sql<{ years: string }[]>`
      select round(extract(epoch from (retain_until - submitted_at)) / 31557600)::text as years
        from clinical.intake_submission where id = ${submissionId}::uuid
    `
    const [profile] = await sql<{ years: number }[]>`
      select clinical_retention_years as years from regulatory_profile_current
    `
    expect(Number(row?.years)).toBe(Number(profile?.years))
    // The provisional value: unconfirmed licence resolves to the healthcare-grade figure (Y1-licence).
    expect(Number(profile?.years)).toBe(25)
  })
})

/**
 * The structured-logging spy (the sixth acceptance criterion).
 *
 * Driven through the FULL submission path — publish, consent, store, step up, read — and then every line
 * and every breadcrumb is serialised and searched for every payload value. The control is the part that
 * makes it a check rather than a formality: the same detector is handed a line that DOES carry a payload
 * value, and it must find it.
 */
describe('no payload value reaches a log line or a breadcrumb', () => {
  const leaksIn = (records: readonly unknown[]): readonly string[] => {
    const text = records.map((record) => JSON.stringify(record)).join('\n')
    return PAYLOAD_VALUES.filter((value) => text.includes(value))
  }

  it('the full path emits lines and breadcrumbs, and none of them holds a payload value', async () => {
    lines = []
    breadcrumbs = []
    const { templateId } = await publish()
    const { submissionId } = await submitFor(60, templateId)
    const reader = { employeeId: employee(60), label: 'fixture reader 60' }
    await stepUp(60)
    await store.readIntake({ submissionId, actor: reader, statedPurpose: PURPOSE })
    // A refusal too, because the refusal path logs as well and is the one nobody thinks to check.
    await expect(
      store.readIntake({
        submissionId,
        actor: { employeeId: employee(61), label: 'fixture reader 61' },
        statedPurpose: PURPOSE,
      }),
    ).rejects.toThrow(/clinical_step_up_required/)

    // Non-vacuity: the path emitted something into BOTH sinks. A spy that captured nothing would pass
    // every assertion below, which is the failure ADR 0003 exists for.
    //
    // A floor and not an equality, deliberately. The equality — every line also produced a breadcrumb —
    // is a separate claim and is asserted in its own case below, because asserting it HERE made this test
    // fail on the count before it reached the leak assertions: a gate case that planted a payload value in
    // a breadcrumb was then reported as un-caught, since the message naming the leak never appeared.
    expect(lines.length).toBeGreaterThanOrEqual(5)
    expect(breadcrumbs.length).toBeGreaterThanOrEqual(5)

    expect(leaksIn(lines), 'a log line carries a payload value').toEqual([])
    expect(leaksIn(breadcrumbs), 'a breadcrumb carries a payload value').toEqual([])
  })

  it('every line the store logs also produces a breadcrumb', () => {
    // The claim the case above used to carry. `log` writes to both sinks, so a line with no breadcrumb is
    // a path that bypassed it — which is where a leak into one sink and not the other comes from.
    expect(breadcrumbs.length).toBe(lines.length)
    expect(lines.length).toBeGreaterThan(0)
  })

  it('control: the detector finds a planted payload value in a line and in a breadcrumb', () => {
    // Without this, the two assertions above are satisfied by a search that can never match.
    const planted = { level: 'info', message: `answers: ${ANSWERS.medication}`, fields: {} }
    expect(leaksIn([planted])).toContain(SENTINEL)
    expect(leaksIn([{ category: 'clinical', message: 'firm' }])).toContain('firm')
  })

  it('no log line or breadcrumb carries a field named after a payload', () => {
    // The closed field map in `logging.ts` is the structural half of the rule; this is the observable
    // half, and it fails the day somebody widens the type.
    const keys = new Set(lines.flatMap((line) => Object.keys(line.fields)))
    for (const forbidden of ['answers', 'payload', 'plaintext', 'body', 'medication', 'notes']) {
      expect([...keys], `a log field is named ${forbidden}`).not.toContain(forbidden)
    }
    expect(keys.size).toBeGreaterThan(0)
  })

  it('an error thrown on the refusal path carries no payload value either', async () => {
    const { templateId } = await publish()
    const customerId = customer(62)
    const error = await store
      .recordIntake({
        customerId,
        templateId,
        answers: ANSWERS,
        submittedVia: 'online',
        dataOrigin: 'synthetic',
        actor: { employeeId: employee(1), label: 'fixture front desk' },
      })
      .catch((caught: unknown) => caught)
    const serialised = `${String(error)}${JSON.stringify(error, Object.getOwnPropertyNames(error))}`
    expect(serialised).toContain('IntakeConsentNotEstablished')
    for (const value of PAYLOAD_VALUES) expect(serialised).not.toContain(value)
  })
})
