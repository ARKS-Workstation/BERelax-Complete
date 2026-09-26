import type { Instant } from '@berelax/core'
import { createConnection, readContraindicationFlags, type Sql } from '@berelax/db'
import { CONTRAINDICATION_DERIVATION_VERSION, CONTRAINDICATION_FLAG_KEYS } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateKek, type Kek } from './envelope.ts'
import { contraindicationFreshness, storedContraindicationFlags } from './flags-view.ts'
import type { ClinicalErrorSink, ClinicalLogger, ClinicalLogLine } from './logging.ts'
import { type ClinicalIntakeStore, createClinicalIntakeStore } from './repository.ts'

/**
 * The boolean-only crossing against real PostgreSQL (C-CRM-09).
 *
 * `packages/core/src/clinical/contraindication-flags.test.ts` proves the decisions — the derivation, the
 * staleness verdict, the access matrix, the copy. This proves the four things only a real database can, and
 * each of them is a claim the pure suite is structurally unable to make:
 *
 *   1. **The application credential reads the crossing and nothing else.** `berelax_app` selects from
 *      `public.customer_contraindication_flags` and is refused `clinical.contraindication_flag` by name.
 *      Every earlier suite in this package connects as the OWNER, which is why a route reading the clinical
 *      schema over the application credential was green here and would have failed in production.
 *   2. **The bytes.** A submission whose every free-text answer carries a sentinel is stored, and the
 *      sentinel is then searched for in every text-ish column of every base table in the application schema,
 *      in every log line and breadcrumb the path emitted, and in the rendered screen. A round-trip assertion
 *      that a flag came back cannot say any of that.
 *   3. **The two layers, separately.** Each rule this unit adds is held by the derivation AND by migration
 *      0084, and the observable that separates them is different for each — an audit row for the gate, a
 *      named constraint for the row shape. A case that asserted the same error name for both would pass with
 *      one layer deleted.
 *   4. **The crossing's own shape,** read out of `information_schema` rather than inferred: nine columns, a
 *      uuid and eight booleans, no text, no timestamp, no count.
 *
 * ## Isolation, and why it is by id prefix
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12). Every row this file writes carries its own uuid prefix and `sweep()` removes exactly those.
 * `merge_record` is the exception and cannot be swept — it is append-only for every role including the owner
 * (ZT001) — so its fixture row is written with `on conflict do nothing` and is idempotent across runs.
 *
 * Every audit assertion is a DELTA counted in SQL, because `audit_event` only grows (brief rule 9).
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/** Rows this file owns. Hex, because these are UUIDs. Distinct from `intake.itest.ts`'s prefixes. */
const CUSTOMER_PREFIX = '0c9c9c09'
const EMPLOYEE_PREFIX = '0c9c9c0a'

const customer = (n: number) => `${CUSTOMER_PREFIX}-0000-7000-8000-${String(n).padStart(12, '0')}`
const employee = (n: number) => `${EMPLOYEE_PREFIX}-0000-7000-8000-${String(n).padStart(12, '0')}`

/**
 * The leak sentinel, and why it is spelled like this.
 *
 * Obviously synthetic (brief rule 15): a plausible health fact in a fixture is indistinguishable from a real
 * one, and this one has to be planted in every free-text field of a stored submission. The word PREGNANT is
 * in it deliberately — the value is the kind of disclosure the boundary exists to keep in, so a sweep that
 * finds it has found the thing that matters rather than a random string.
 */
const SENTINEL = 'PREGNANT-SENTINEL-7Q2K'

/** The question set. Three flag-keyed booleans, and two free-text fields that feed no flag at all. */
const FIELDS = [
  {
    key: 'pregnancy',
    label: 'Are you pregnant?',
    kind: 'boolean' as const,
    required: true,
  },
  {
    key: 'recent_surgery',
    label: 'Any surgery in the last six months?',
    kind: 'boolean' as const,
    required: true,
  },
  {
    key: 'blood_thinners',
    label: 'Are you taking blood thinners?',
    kind: 'boolean' as const,
    required: false,
  },
  {
    key: 'medication',
    label: 'Anything else we should know?',
    kind: 'short_text' as const,
    required: false,
  },
  {
    key: 'notes_for_us',
    label: 'Anything you would like us to avoid?',
    kind: 'long_text' as const,
    required: false,
  },
]

/**
 * Answers with the sentinel in EVERY free-text field.
 *
 * `pregnancy: false` while the free text screams the opposite, which is the point rather than a joke: the
 * derivation reads the boolean and never the prose, so the flag must come back false — and the sentinel must
 * reach nothing. A derivation that pattern-matched the text would set `pregnancy: true` here and would be
 * asserting a fact about somebody's health that nobody stated.
 */
const ANSWERS = {
  pregnancy: false,
  recent_surgery: true,
  blood_thinners: false,
  medication: `${SENTINEL} and nothing else`,
  notes_for_us: `please avoid ${SENTINEL}`,
} as const

const PURPOSE = 'checking contraindications before this appointment'

const systemClock = { now: () => Date.now() as Instant }

let sql: Sql
let kek: Kek
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
    delete from clinical.contraindication_flag
     where customer_id::text like ${`${CUSTOMER_PREFIX}%`}
  `
  await sql`
    delete from clinical.intake_submission where customer_id::text like ${`${CUSTOMER_PREFIX}%`}
  `
  await sql`
    delete from clinical.treatment_consent where customer_id::text like ${`${CUSTOMER_PREFIX}%`}
  `
  await sql`delete from clinical.step_up_grant where employee_id::text like ${`${EMPLOYEE_PREFIX}%`}`
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

const publish = async (fields: typeof FIELDS = FIELDS, title = 'Before your visit') =>
  await store.publishTemplate({
    locale: 'en',
    title,
    fields,
    consentText: 'I agree that my answers may be held so the session can be delivered safely.',
    actor: { employeeId: employee(1), label: 'fixture publisher' },
  })

const submitFor = async (
  n: number,
  templateId: string,
  answers: Readonly<Record<string, unknown>> = ANSWERS,
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
    answers,
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
  kek = generateKek(active.v)
  store = createClinicalIntakeStore({ sql, kek, clock: systemClock, logger, errors })
}, 120_000)

afterAll(async () => {
  await sweep().catch(() => {})
  await sql?.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------
// 1. The crossing's shape, and who may read it
// ------------------------------------------------------------------------------------------------

describe('acceptance — the crossing carries booleans and nothing else', () => {
  it('has exactly a customer id and the closed flag set, read out of information_schema', async () => {
    const rows = await sql<{ columnName: string; dataType: string }[]>`
      select column_name as "columnName", data_type as "dataType"
        from information_schema.columns
       where table_schema = 'public' and table_name = 'customer_contraindication_flags'
       order by ordinal_position
    `
    // Checked, not inferred (C-CRM-08's lesson about the convention scanner): the view's own catalogue rows.
    expect(rows.map((r) => r.columnName).sort()).toEqual(
      ['customer_id', ...CONTRAINDICATION_FLAG_KEYS].sort(),
    )
    for (const row of rows.filter((r) => r.columnName !== 'customer_id')) {
      expect(row.dataType, `${row.columnName} is not boolean`).toBe('boolean')
    }
    expect(rows.find((r) => r.columnName === 'customer_id')?.dataType).toBe('uuid')
  })

  it('keeps updated_at, the counts and the provenance on the TABLE and off the view', async () => {
    // The control on the assertion above. A view that exposed nothing at all would satisfy "no text
    // columns"; what has to be true is that the columns exist behind the boundary and do not cross it.
    const behind = await sql<{ columnName: string }[]>`
      select column_name as "columnName"
        from information_schema.columns
       where table_schema = 'clinical' and table_name = 'contraindication_flag'
    `
    const names = behind.map((row) => row.columnName)
    for (const held of [
      'updated_at',
      'undetermined_count',
      'derivation_version',
      'source_template_version',
      'source_submission_id',
    ]) {
      expect(names, `${held} is missing from the table`).toContain(held)
    }
    const crossing = await sql<{ columnName: string }[]>`
      select column_name as "columnName"
        from information_schema.columns
       where table_schema = 'public' and table_name = 'customer_contraindication_flags'
    `
    for (const held of ['updated_at', 'undetermined_count', 'derivation_version']) {
      expect(
        crossing.map((r) => r.columnName),
        `${held} crosses the boundary`,
      ).not.toContain(held)
    }
  })

  it('is readable by berelax_app, which is refused the table it is built on', async () => {
    const { customerId, submissionId } = await submitFor(1, (await publish()).templateId)
    await stepUp(1)
    await store.deriveFlags({
      submissionId,
      actor: { employeeId: employee(1), label: 'fixture reader' },
      statedPurpose: PURPOSE,
    })

    // THE statement the brief asks for: as the APPLICATION role, not as the owner this pool connects as.
    const asApp = await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      return await tx<{ recentSurgery: boolean }[]>`
        select recent_surgery as "recentSurgery"
          from public.customer_contraindication_flags
         where customer_id = ${customerId}::uuid
      `
    })
    expect(asApp[0]?.recentSurgery).toBe(true)

    // And the control that makes that a boundary rather than a grant: the same role, the same data, the
    // table underneath. A page that read the table over this credential would be green as the owner.
    const denied = await sql
      .begin(async (tx) => {
        await tx`set local role berelax_app`
        await tx`select 1 from clinical.contraindication_flag limit 1`
      })
      .then(
        () => null,
        (error: unknown) => error,
      )
    expect(
      denied,
      'the app role reads the clinical table, which is the boundary gone',
    ).not.toBeNull()
    expect((denied as { readonly code?: string }).code).toBe('42501')
  }, 30_000)

  it('is what the db repository returns, over the application credential', async () => {
    const flags = await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      return await readContraindicationFlags(tx as unknown as Sql, customer(1))
    })
    expect(flags).not.toBeNull()
    expect(flags?.recent_surgery).toBe(true)
    expect(flags?.pregnancy).toBe(false)
    // Not asked by this template at all, so false — and the screens say what that means.
    expect(flags?.skin_condition).toBe(false)
    expect(Object.keys(flags ?? {}).sort()).toEqual([...CONTRAINDICATION_FLAG_KEYS].sort())
  })

  it('answers null for a client nothing has been derived for, not eight falses', async () => {
    const flags = await readContraindicationFlags(sql, customer(99))
    // The distinction the reader's own doc turns on: a derivation that has not run is not a client with no
    // contraindications, and a repository that returned a zeroed set would erase the difference for ever.
    expect(flags).toBeNull()
  })
})

// ------------------------------------------------------------------------------------------------
// 2. The leak sweep
// ------------------------------------------------------------------------------------------------

describe('acceptance — a sentinel in every free-text answer escapes nowhere', () => {
  /**
   * Every text-ish column of every base table in the application schema, searched for one value.
   *
   * Built from `information_schema` rather than from a list, so a table another unit adds tomorrow is swept
   * on the day it lands rather than on the day somebody remembers. `outbox_event` and `audit_event` are in
   * it by construction, which is what the acceptance line asks for by name.
   */
  const sweepAppSchema = async (needle: string): Promise<readonly string[]> => {
    const columns = await sql<{ tableName: string; columnName: string }[]>`
      select c.table_name as "tableName", c.column_name as "columnName"
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public'
         and t.table_type = 'BASE TABLE'
         and c.data_type in ('text', 'character varying', 'character', 'jsonb', 'json')
       order by c.table_name, c.column_name
    `
    // A MEASURED floor, not a guess: this database has 540 such columns, and the number only grows as
    // migrations land. 400 is under it by enough that a unit landing a table cannot trip it, and far enough
    // above zero that a query returning nothing — the wrong schema, a broken catalogue read — fails here
    // rather than reporting a clean sweep over an empty set (ADR 0002).
    expect(
      columns.length,
      'the sweep found almost no columns to search, so its silence means nothing',
    ).toBeGreaterThan(400)
    const hits: string[] = []
    for (const { tableName, columnName } of columns) {
      const found = await sql.unsafe<{ n: string }[]>(
        `select count(*)::text as n from public."${tableName}" where "${columnName}"::text like $1`,
        [`%${needle}%`],
      )
      if (Number(found[0]?.n ?? '0') > 0) hits.push(`${tableName}.${columnName}`)
    }
    return hits
  }

  it('appears in no application-schema table, including outbox_event and audit_event', async () => {
    const hits = await sweepAppSchema(SENTINEL)
    expect(hits, `the sentinel leaked into ${hits.join(', ')}`).toEqual([])

    // THE CONTROL, and without it the sweep above is a loop that cannot fail.
    //
    // The needle deliberately shares NO substring with `SENTINEL`, and the first version of this case got
    // that wrong: it planted `${SENTINEL}-CONTROL`, which the sweep for `SENTINEL` finds — so the file
    // passed on its first run and failed on its second, in the assertion above, naming a leak that was its
    // own control row. Brief rule 12 in one line of test code.
    const planted = 'SWEEP-CONTROL-NEEDLE-5R3M'
    await sql`
      insert into audit_event (actor_kind, actor_id, actor_label, action, entity_type, entity_id,
                               operation, after_state)
      values ('system', null, 'flags-view sweep control', 'gate.sweep_control', 'gate.control',
              ${customer(98)}, 'create', ${sql.json({ planted } as never)})
    `
    const found = await sweepAppSchema(planted)
    expect(
      found,
      'the sweep cannot find a value that IS there, so its silence means nothing',
    ).not.toEqual([])
    // `audit_event` is append-only and a test must not DELETE from it (brief rule 9). The control row
    // therefore stays, and one more lands per run: it carries this file's own label and an entity id inside
    // this file's prefix, and it can never satisfy the sweep above because the two needles do not overlap.
  }, 120_000)

  it('appears in no log line and no breadcrumb from the whole path', async () => {
    // Every line and crumb emitted since `beforeAll`, which includes the publish, the consent, the store,
    // the step-up and the derivation. The store's own leak test covers the read; this covers the derivation,
    // which is the path that holds a decrypted payload for the purpose of producing something else.
    const emitted = JSON.stringify({ lines, breadcrumbs })
    expect(emitted).not.toContain(SENTINEL)
    expect(lines.length, 'nothing was logged, so this assertion is vacuous').toBeGreaterThan(0)
    // The control on the search itself.
    expect(JSON.stringify({ lines, breadcrumbs, planted: SENTINEL })).toContain(SENTINEL)
  })

  it('cannot be reached through the crossing at all, because the crossing has nowhere to put it', async () => {
    // The screen half of the acceptance line is deliberately NOT asserted here, and the reason is a boundary
    // rather than an omission: a suite in `packages/clinical` importing a document from `apps/web` would be a
    // package reaching into an application, which `pnpm boundaries` refuses — correctly. It is asserted in
    // two places that can:
    //
    //   - `apps/web/src/flags-render.test.ts` drives the real renderer and asserts the BYTES of the response
    //     body hold no answer, no question label, no count and no instant, with controls.
    //   - `apps/web/src/manage-booking.itest.ts` sweeps `CLINICAL_FIELD_MARKERS` over a real served booking
    //     page, and that list now derives from `CONTRAINDICATION_FLAG_KEYS` — so every key of the closed set
    //     is refused on the customer-facing surface by a guard that was already wired to a server.
    //
    // What IS asserted here is the stronger structural claim: the value cannot reach a screen through the
    // crossing, because every column the crossing has is a boolean. Read from the catalogue, not inferred.
    const notBoolean = await sql<{ columnName: string; dataType: string }[]>`
      select column_name as "columnName", data_type as "dataType"
        from information_schema.columns
       where table_schema = 'public' and table_name = 'customer_contraindication_flags'
         and data_type <> 'boolean' and column_name <> 'customer_id'
    `
    expect(
      notBoolean,
      `the crossing has a non-boolean column: ${JSON.stringify(notBoolean)}`,
    ).toEqual([])
  })
})

// ------------------------------------------------------------------------------------------------
// 3. The two layers of each rule, separately
// ------------------------------------------------------------------------------------------------

describe('acceptance — the database holds the rules the derivation holds', () => {
  /** A hand-written flag row, as a `psql` session would write one. Returns the error or null. */
  const insertRow = async (over: Record<string, unknown>): Promise<unknown> => {
    const row = {
      customer_id: customer(1),
      pregnancy: false,
      recent_surgery: false,
      cardiovascular: false,
      skin_condition: false,
      allergy_present: false,
      blood_thinners: false,
      acute_injury: false,
      requires_consultation: false,
      source_submission_id: null,
      derivation_version: CONTRAINDICATION_DERIVATION_VERSION,
      source_template_version: 1,
      undetermined_count: 0,
      ...over,
    }
    return await sql
      .begin(async (tx) => {
        await tx`
          insert into clinical.contraindication_flag
            (customer_id, pregnancy, recent_surgery, cardiovascular, skin_condition, allergy_present,
             blood_thinners, acute_injury, requires_consultation, updated_at, source_submission_id,
             derivation_version, source_template_version, undetermined_count)
          values (${row.customer_id as string}::uuid, ${row.pregnancy as boolean},
                  ${row.recent_surgery as boolean}, ${row.cardiovascular as boolean},
                  ${row.skin_condition as boolean}, ${row.allergy_present as boolean},
                  ${row.blood_thinners as boolean}, ${row.acute_injury as boolean},
                  ${row.requires_consultation as boolean}, now(),
                  ${row.source_submission_id as string | null}::uuid,
                  ${row.derivation_version as number}, ${row.source_template_version as number},
                  ${row.undetermined_count as number})
          on conflict (customer_id) do update set
            requires_consultation   = excluded.requires_consultation,
            undetermined_count      = excluded.undetermined_count,
            source_submission_id    = excluded.source_submission_id,
            source_template_version = excluded.source_template_version,
            derivation_version      = excluded.derivation_version
        `
        // Always rolled back: this is a probe of what the database refuses, not a write.
        throw new Error('ROLLBACK_PROBE')
      })
      .then(
        () => null,
        (error: unknown) => (String(error).includes('ROLLBACK_PROBE') ? null : error),
      )
  }

  let submissionId = ''
  let templateVersion = 0

  beforeAll(async () => {
    const [row] = await sql<{ id: string; templateVersion: number }[]>`
      select id, template_version as "templateVersion"
        from clinical.intake_submission
       where customer_id = ${customer(1)}::uuid and superseded_at is null
    `
    if (row === undefined) throw new Error('the fixture submission for customer 1 is missing')
    submissionId = row.id
    templateVersion = Number(row.templateVersion)
  })

  it('refuses a row that swallows an unreadable answer — "ask a human" is a CHECK', async () => {
    const error = await insertRow({
      source_submission_id: submissionId,
      source_template_version: templateVersion,
      undetermined_count: 1,
      requires_consultation: false,
    })
    expect(String(error)).toContain('contraindication_undetermined_requires_consultation')
    // The control: the same row with the escalation set is accepted, so the constraint is about the
    // IMPLICATION and not about the column.
    expect(
      await insertRow({
        source_submission_id: submissionId,
        source_template_version: templateVersion,
        undetermined_count: 1,
        requires_consultation: true,
      }),
    ).toBeNull()
  })

  it('refuses a row whose claimed template version its source submission does not have (ZA001)', async () => {
    const error = await insertRow({
      source_submission_id: submissionId,
      source_template_version: templateVersion + 7,
    })
    expect(String(error)).toContain('ContraindicationProvenanceMismatch')
    expect((error as { readonly code?: string }).code).toBe('ZA001')
  })

  it('refuses a row that attributes one client`s answers to another (ZA002)', async () => {
    // The one that is a disclosure rather than a stale marker: `customer_id` is the primary key and
    // `source_submission_id` points at a submission whose own customer is a different column, so nothing
    // structural stops a flag row putting one person's answers on somebody else's record.
    const other = await submitFor(
      2,
      (await publish(FIELDS, 'Before your visit, second')).templateId,
    )
    const [row] = await sql<{ templateVersion: number }[]>`
      select template_version as "templateVersion" from clinical.intake_submission
       where id = ${other.submissionId}::uuid
    `
    const error = await insertRow({
      customer_id: customer(1),
      source_submission_id: other.submissionId,
      source_template_version: Number(row?.templateVersion ?? 0),
    })
    expect(String(error)).toContain('ContraindicationSubmissionNotThisCustomer')
    expect((error as { readonly code?: string }).code).toBe('ZA002')
  }, 30_000)

  it('spells the derivation version the same way the TypeScript constant does', async () => {
    // Two spellings that must agree: the staleness check has to run as SQL, because the credential serving
    // the crossing cannot read the clinical schema. Asserted rather than trusted.
    const [row] = await sql<{ v: number }[]>`
      select clinical.contraindication_derivation_version() as v
    `
    expect(Number(row?.v)).toBe(CONTRAINDICATION_DERIVATION_VERSION)
  })
})

// ------------------------------------------------------------------------------------------------
// 4. The gate, the audit trail, and what is NOT on it
// ------------------------------------------------------------------------------------------------

describe('acceptance — deriving a flag set is a gated, audited read of a health record', () => {
  it('is refused without a step-up grant, and the refusal writes a denied row', async () => {
    const { submissionId } = await submitFor(3, (await publish(FIELDS, 'Third form')).templateId)
    const before = await auditCount(submissionId, 'denied')
    await expect(
      store.deriveFlags({
        submissionId,
        actor: { employeeId: employee(3), label: 'fixture reader' },
        statedPurpose: PURPOSE,
      }),
    ).rejects.toThrow(/clinical_step_up_required/)
    // The AUDIT ROW, because it is the only observable that separates this refusal from any other: the
    // message would be identical if the gate were somewhere else, and the row is what an insider-threat
    // review looks for. A delta, counted in SQL, because `audit_event` only grows.
    expect(await auditCount(submissionId, 'denied')).toBe(before + 1)
    // And nothing was written.
    expect(await storedContraindicationFlags(sql, customer(3))).toBeNull()
  }, 30_000)

  it('writes a read row on the submission AND a derived row on the flags, after a step-up', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from clinical.intake_submission
       where customer_id = ${customer(3)}::uuid and superseded_at is null
    `
    const submissionId = row?.id as string
    const readsBefore = await auditCount(submissionId, 'read')
    const derivedBefore = await auditCount(customer(3))
    await stepUp(3)
    const result = await store.deriveFlags({
      submissionId,
      actor: { employeeId: employee(3), label: 'fixture reader' },
      statedPurpose: PURPOSE,
    })
    expect(result.flags.recent_surgery).toBe(true)
    // Both rows. A path that recorded only "flags derived" would be a way to open a health record that the
    // query for reads of a submission does not see.
    expect(await auditCount(submissionId, 'read')).toBe(readsBefore + 1)
    expect(await auditCount(customer(3))).toBe(derivedBefore + 1)
  }, 30_000)

  it('puts no flag VALUE on the audit row, because audit:read reaches roles the flags do not', async () => {
    const [row] = await sql<{ afterState: Record<string, unknown> }[]>`
      select after_state as "afterState" from audit_event
       where entity_id = ${customer(3)} and action = 'clinical.contraindication_flag.derived'
       order by occurred_at desc, id desc limit 1
    `
    const after = row?.afterState ?? {}
    expect(Object.keys(after).length).toBeGreaterThan(0)
    for (const key of CONTRAINDICATION_FLAG_KEYS) {
      expect(Object.keys(after), `the audit row carries the flag ${key}`).not.toContain(key)
    }
    // The versions and the counts ARE there — that is what an audit reader needs — and the control proves
    // the assertion above is about the flags rather than about an empty payload.
    expect(after['derivationVersion']).toBe(CONTRAINDICATION_DERIVATION_VERSION)
    expect(after['changed']).toBe(true)
  })

  it('stores the unreadable count, and the escalation the database refuses a row without', async () => {
    // A payload that OMITS an answer to a question the captured version asked as a boolean. This is the
    // application half of the rule migration 0084 holds as a CHECK, and the two are asserted through
    // different observables on purpose: this one reads the stored row, and the database one (above) reads
    // the constraint's NAME. A case that asserted the same thing for both would pass with either deleted.
    const { customerId, submissionId } = await submitFor(
      5,
      (await publish(FIELDS, 'Fifth form, with a gap')).templateId,
      { pregnancy: false, recent_surgery: false, medication: SENTINEL },
    )
    await stepUp(5)
    const result = await store.deriveFlags({
      submissionId,
      actor: { employeeId: employee(5), label: 'fixture reader' },
      statedPurpose: PURPOSE,
    })
    expect(result.undetermined).toEqual(['blood_thinners'])
    expect(result.undeterminedCount).toBe(1)
    expect(result.flags.requires_consultation).toBe(true)
    // The specific flag stays false: escalating must never become a way of asserting the condition.
    expect(result.flags.blood_thinners).toBe(false)

    const [row] = await sql<{ undeterminedCount: number; requiresConsultation: boolean }[]>`
      select undetermined_count as "undeterminedCount",
             requires_consultation as "requiresConsultation"
        from clinical.contraindication_flag where customer_id = ${customerId}::uuid
    `
    expect(Number(row?.undeterminedCount)).toBe(1)
    expect(row?.requiresConsultation).toBe(true)
  }, 30_000)

  it('records a re-derivation that changed nothing as changed: false', async () => {
    const [row] = await sql<{ id: string }[]>`
      select id from clinical.intake_submission
       where customer_id = ${customer(3)}::uuid and superseded_at is null
    `
    const again = await store.deriveFlags({
      submissionId: row?.id as string,
      actor: { employeeId: employee(3), label: 'fixture reader' },
      statedPurpose: PURPOSE,
    })
    // The useful question after a sweep is not "did it run" but "did the answer move".
    expect(again.changed).toBe(false)
  }, 30_000)
})

// ------------------------------------------------------------------------------------------------
// 5. Staleness, observable through the crossing
// ------------------------------------------------------------------------------------------------

describe('acceptance — a stale flag set escalates rather than being silently used', () => {
  const escalatedForApp = async (customerId: string): Promise<boolean> => {
    const flags = await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      return await readContraindicationFlags(tx as unknown as Sql, customerId)
    })
    return flags?.requires_consultation ?? false
  }

  it('escalates at the view when the client has answered a NEWER form, and clears on re-derivation', async () => {
    const first = await publish(FIELDS, 'Fourth form')
    const { customerId, submissionId } = await submitFor(4, first.templateId, {
      ...ANSWERS,
      recent_surgery: false,
    })
    await stepUp(4)
    await store.deriveFlags({
      submissionId,
      actor: { employeeId: employee(4), label: 'fixture reader' },
      statedPurpose: PURPOSE,
    })
    expect(await escalatedForApp(customerId)).toBe(false)
    expect((await storedContraindicationFlags(sql, customerId))?.requires_consultation).toBe(false)

    // The client fills in a second form. The first is superseded and the flags now come from a submission
    // that is no longer the live one.
    const second = await store.recordIntake({
      customerId,
      templateId: first.templateId,
      answers: { ...ANSWERS, recent_surgery: false },
      submittedVia: 'in_salon',
      dataOrigin: 'synthetic',
      actor: { employeeId: employee(1), label: 'fixture front desk' },
    })
    expect(await contraindicationFreshness(sql, customerId)).toMatchObject({
      fresh: false,
      reason: 'source_submission_changed',
    })
    // The FRONT DESK's observable, over the application credential: the escalation flag, with no second
    // column to check and no `if (stale)` for anybody to leave out. The STORED row still says false, which
    // is the difference between what the derivation found and what the front desk must do.
    expect(await escalatedForApp(customerId)).toBe(true)
    expect((await storedContraindicationFlags(sql, customerId))?.requires_consultation).toBe(false)

    await store.deriveFlags({
      submissionId: second.submissionId,
      actor: { employeeId: employee(4), label: 'fixture reader' },
      statedPurpose: PURPOSE,
    })
    expect(await contraindicationFreshness(sql, customerId)).toEqual({ fresh: true })
    expect(await escalatedForApp(customerId)).toBe(false)
  }, 60_000)

  it('escalates when the TEMPLATE version moves, and re-deriving does not clear it', async () => {
    const customerId = customer(4)
    expect(await escalatedForApp(customerId)).toBe(false)

    // A new version of the form for the same locale. The client has not answered it.
    await publish(FIELDS, 'Fifth form, a later version')
    expect(await contraindicationFreshness(sql, customerId)).toMatchObject({
      fresh: false,
      reason: 'template_version_changed',
    })
    expect(await escalatedForApp(customerId)).toBe(true)

    // Re-deriving CANNOT clear this one, and that is correct rather than a defect: the answers on record are
    // still answers to the older question set, so a flag the new version asks about has nothing behind it.
    // What clears it is the client filling in the newer form.
    const [row] = await sql<{ id: string }[]>`
      select id from clinical.intake_submission
       where customer_id = ${customerId}::uuid and superseded_at is null
    `
    await store.deriveFlags({
      submissionId: row?.id as string,
      actor: { employeeId: employee(4), label: 'fixture reader' },
      statedPurpose: PURPOSE,
    })
    expect(await escalatedForApp(customerId)).toBe(true)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// 6. The merge tombstone, which this unit is the first reader to make live
// ------------------------------------------------------------------------------------------------

describe('acceptance — a merged-away record keeps its flags, under the survivor id', () => {
  it('answers the survivor id, and unions the two histories', async () => {
    const loser = customer(11)
    const survivor = customer(12)
    const template = await publish(FIELDS, 'Sixth form, for the merge')
    const loserSubmission = await submitFor(11, template.templateId, {
      ...ANSWERS,
      recent_surgery: true,
      pregnancy: false,
    })
    await stepUp(11)
    await store.deriveFlags({
      submissionId: loserSubmission.submissionId,
      actor: { employeeId: employee(11), label: 'fixture reader' },
      statedPurpose: PURPOSE,
    })

    // No pre-condition assertion that the survivor has nothing, and its absence is deliberate: the
    // tombstone below cannot be swept, so on a SECOND run of this file the merge already exists and the
    // loser's fresh flag row already resolves to the survivor — an assertion that the survivor is empty
    // passes once and then fails for ever. What is asserted instead is the PAIR at the end, which cannot
    // pass vacuously: without the resolution the loser would answer the flags and the survivor would
    // answer nothing, which is the exact opposite of both expectations.
    //
    // The tombstone. `merge_record` is append-only for every role (ZT001), so this cannot be swept and is
    // written idempotently instead — a second run of this file finds its own row and does nothing.
    await sql`
      insert into merge_record (survivor_customer_id, loser_customer_id, merged_at, actor_kind,
                                actor_label, authority, reason, score_per_mille, phone_agreement,
                                label_agreement, field_resolutions)
      values (${survivor}::uuid, ${loser}::uuid, now(), 'system',
              'flags-view itest fixture merge', 'auto_merge',
              'the same person reached the front desk twice with one phone number', 1000,
              'identical', 'identical', '[]'::jsonb)
      on conflict (loser_customer_id) do nothing
    `

    // C-CRM-05 registered this table as one a merge deliberately does not re-point, and recorded that the
    // tombstone is resolved ON READ because nothing in the build read the view yet. This unit is that
    // reader, so the deferral comes due: without the resolution, a client whose duplicate was merged away
    // silently loses every marker, which is the worst shape a data-quality fix could take.
    const resolved = await sql.begin(async (tx) => {
      await tx`set local role berelax_app`
      return await readContraindicationFlags(tx as unknown as Sql, survivor)
    })
    expect(resolved, 'the survivor lost the flags the merged-away record held').not.toBeNull()
    expect(resolved?.recent_surgery).toBe(true)

    // And the loser's own id no longer answers: it resolves to the survivor, so the flags are in exactly
    // one place rather than two that can disagree.
    expect(await readContraindicationFlags(sql, loser)).toBeNull()
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// 7. Publication: a template that could not derive what it appears to is refused
// ------------------------------------------------------------------------------------------------

describe('a template whose flag question is not a boolean is refused at publication', () => {
  it('refuses a flag-keyed free-text question by name', async () => {
    await expect(
      publish(
        [
          {
            key: 'recent_surgery',
            label: 'Describe any surgery in the last six months',
            kind: 'long_text' as const,
            required: false,
          },
        ] as typeof FIELDS,
        'A form that could not derive its own flags',
      ),
    ).rejects.toThrow(/IntakeTemplateContraindicationRefused/)
  }, 30_000)

  it('refuses asking the client to answer the escalation flag', async () => {
    await expect(
      publish(
        [
          {
            key: 'requires_consultation',
            label: 'Would you like a consultation first?',
            kind: 'boolean' as const,
            required: false,
          },
        ] as typeof FIELDS,
        'A form that asks the client to escalate',
      ),
    ).rejects.toThrow(/escalation_flag_is_not_a_question|IntakeTemplateContraindicationRefused/)
  }, 30_000)
})
