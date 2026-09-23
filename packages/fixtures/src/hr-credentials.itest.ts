import {
  CANDIDATE_MANDATORY_CREDENTIALS,
  type CredentialStatus,
  evaluateCredentials,
  type HeldCredential,
  type Instant,
  instantFromIso,
  localDate,
  statusSatisfies,
} from '@berelax/core'
import {
  CREDENTIAL_EXPIRING_SOON_SETTING_KEY,
  createConnection,
  PROVISIONAL_EXPIRING_SOON_DAYS,
  readCredentialPolicy,
  readEmployeeCredentials,
  type Sql,
  seedSettingDefaults,
  unconfirmedAssumptionRows,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * P-HR-02 — the credential registry and the evaluator, joined.
 *
 * The **rule** is pure and lives in `@berelax/core` (`evaluateCredentials`). The **rows and the policy**
 * live in PostgreSQL and are read by `@berelax/db` (`readCredentialPolicy`, `readEmployeeCredentials`).
 * `packages/db` may never import `packages/core`, so nothing but `@berelax/fixtures` can assert that the
 * pair works — the same reason `therapist-eligibility.itest.ts` is in this package.
 *
 * Five claims need both halves:
 *
 *   1. the mandatory set is **derived from `regulatory_profile`** and from nothing else. The profile in
 *      force is flipped from the stricter healthcare reading to wellness and the set is asserted to
 *      SHRINK, with the eligibility answer for one therapist changing in both directions — and then
 *      flipped to a set that is NEITHER candidate, which is the control that a hard-coded list with a
 *      licence-class lookup wrapped round it would fail;
 *   2. the column DEFAULT is decision 20's stricter six, asserted by inserting a profile version that
 *      states no mandatory set at all and reading back what the database chose;
 *   3. a type declared non-expiring may hold a NULL expiry and is never EXPIRED, while the same NULL on
 *      an undeclared type is refused by the database (ZS006). Both directions, because either alone is
 *      satisfied by a rule that permits everything or refuses everything;
 *   4. the **Asia/Dubai boundary** holds over rows that made the round trip through `date` and back to
 *      text, not only over literals in a unit test;
 *   5. the EXPIRING_SOON window is the `app_setting` value and is listed by the Unconfirmed Assumptions
 *      query.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind. So:
 * every read is narrowed to the employees this file creates, the staff references are prefixed
 * `PHR02 CRED`, and `regulatory_profile` is append-only (ADR 0008) — the flips SUPERSEDE and INSERT, the
 * count assertion is a DELTA, and the restore is a further row rather than a delete. The restore puts
 * back the SEEDED profile — every column at its DEFAULT, which is what 0004 and 0058 both insert — and
 * never what this file found in force. A restore that re-asserts what it FOUND propagates pollution
 * instead of repairing it, and that is not hypothetical: see {@link restoreSeededProfile} for the
 * version of this table's history it produced and the gate case that now proves the repair.
 *
 * No employee here has a name. `staff_reference` is an internal handle, and no document number, licence
 * number or issuing authority is invented (brief rule 15).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
/** The `employee.id` of each fixture employee, by handle. */
const employees = new Map<string, string>()

/**
 * The SEEDED profile, which is what {@link restoreSeededProfile} puts back — every column at its DEFAULT.
 *
 * These three constants are the columns this file MUTATES, and they are written down rather than
 * snapshotted for the reason the restore's own header gives: a restore that re-asserts what it FOUND
 * cannot repair pollution, it propagates it. Each is asserted to be the database's own default
 * elsewhere in this file, so a migration that revises one fails here rather than drifting silently:
 * `mandatory` and `nonExpiring` by the test that inserts a version naming no set at all, and the licence
 * class by the restore assertion at the end of the first test.
 */
const SEEDED_MANDATORY = CANDIDATE_MANDATORY_CREDENTIALS.healthcare
/** 0054's default and the strict reading: every credential must be renewed until somebody says otherwise. */
const SEEDED_NON_EXPIRING: readonly string[] = []
/** 0004's default. An unconfirmed licence resolves to the stricter combination (Y1-licence). */
const SEEDED_LICENCE_CLASS = 'unconfirmed'

const HEALTHCARE = [...CANDIDATE_MANDATORY_CREDENTIALS.healthcare]
const WELLNESS = [...CANDIDATE_MANDATORY_CREDENTIALS.wellness]

const at = (iso: string): Instant => instantFromIso(iso)

/** Every fixture document expires here unless the case is about an expiry. Far past any other suite. */
const FAR_FUTURE = '2098-12-31'
/** The date the criterion names: VALID at 23:59:59+04:00 on it, EXPIRED at 00:00:00+04:00 the next day. */
const LAPSED_LABOUR_CARD = '2026-03-31'
/** The instant every status assertion is made at unless the case is about the boundary. */
const NOON = at('2026-03-01T12:00:00+04:00')

async function makeEmployee(handle: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into employee (staff_reference, employed_from)
    values (${`PHR02 CRED ${handle}`}, date '2020-01-01')
    on conflict (staff_reference) do update set employed_from = excluded.employed_from
    returning id
  `
  const id = (row as { id: string }).id
  employees.set(handle, id)
  return id
}

async function fileDocument(
  handle: string,
  documentType: string,
  expiresOn: string | null,
): Promise<void> {
  await sql`
    insert into employee_document (employee_id, document_type, expires_on)
    values (${employees.get(handle) as string}, ${documentType}::employee_document_type,
            ${expiresOn}::date)
    on conflict do nothing
  `
}

/** Everything on file for one fixture employee, shaped for the pure evaluator. */
async function heldBy(handle: string): Promise<readonly HeldCredential[]> {
  const rows = await readEmployeeCredentials(sql, [employees.get(handle) as string])
  return rows.map((row) => ({
    documentType: row.documentType,
    expiresOn: row.expiresOn === null ? null : localDate(row.expiresOn),
  }))
}

/** The pair: rows from PostgreSQL, policy from PostgreSQL, judgement from `@berelax/core`. */
async function evaluate(handle: string, instant: Instant = NOON) {
  const policy = await readCredentialPolicy(sql)
  return evaluateCredentials({ credentials: await heldBy(handle), policy, at: instant })
}

const statusOf = (
  result: { mandatory: readonly { documentType: string; status: CredentialStatus }[] },
  documentType: string,
): CredentialStatus | undefined =>
  result.mandatory.find((a) => a.documentType === documentType)?.status

interface ProfileChange {
  readonly mandatory?: readonly string[]
  readonly nonExpiring?: readonly string[]
  readonly licenceClass?: 'unconfirmed' | 'wellness' | 'healthcare'
  readonly note: string
}

/**
 * Supersedes the profile in force and inserts a new version, which is how 0004 says a profile changes.
 *
 * Every field the change does not name is carried over from the retired row rather than restated. Omit
 * `mandatory` and the column's DEFAULT applies instead — which is how the "the default profile yields
 * the stricter set" assertion reads the default without parsing `pg_get_expr`.
 */
async function supersedeProfile(change: ProfileChange): Promise<number> {
  const carryMandatory = change.mandatory === undefined
  const [row] = await sql<{ version: number }[]>`
    with retired as (
      update regulatory_profile set superseded_at = now() where superseded_at is null
      returning licence_class, emirate, clinical_retention_years, financial_retention_years,
                erasure_overrides_retention, medical_claims_permitted, permitted_public_titles,
                banned_claim_terms, is_provisional, mandatory_therapist_document_types,
                non_expiring_document_types
    )
    insert into regulatory_profile
      (licence_class, emirate, clinical_retention_years, financial_retention_years,
       erasure_overrides_retention, medical_claims_permitted, permitted_public_titles,
       banned_claim_terms, is_provisional, source_note,
       -- The mandatory column is named ONLY when the change supplies one. Naming it with a NULL would
       -- write a NULL rather than fall back to the default, which is the whole point of the omission.
       ${carryMandatory ? sql`` : sql`mandatory_therapist_document_types,`}
       non_expiring_document_types)
    select coalesce(${change.licenceClass ?? null}::licence_class, retired.licence_class),
           retired.emirate, retired.clinical_retention_years, retired.financial_retention_years,
           retired.erasure_overrides_retention, retired.medical_claims_permitted,
           retired.permitted_public_titles, retired.banned_claim_terms, retired.is_provisional,
           ${change.note},
           ${
             carryMandatory
               ? sql``
               : sql`${sql.array([...(change.mandatory as readonly string[])])}::employee_document_type[],`
           }
           ${
             change.nonExpiring === undefined
               ? sql`retired.non_expiring_document_types`
               : sql`${sql.array([...change.nonExpiring])}::employee_document_type[]`
           }
      from retired
    returning version
  `
  return Number((row as { version: number }).version)
}

async function profileRowCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from regulatory_profile`
  return Number((row as { n: string }).n)
}

/**
 * Restores the SEEDED profile, by INSERTING a version that names ONLY `source_note` — never by deleting
 * a row, and never by restating a value.
 *
 * ## The defect this replaces, and why "restore what you found" is not a restore
 *
 * This function used to re-insert `originalPolicy` — the profile this file read in its own `beforeAll`.
 * A restore that re-asserts what it FOUND cannot repair pollution: it propagates it, and it propagates
 * it for ever, because every subsequent run finds what the previous one wrote. The append-only history
 * has the whole chain in it. Version 22 carries the note
 * `B-AVAIL-04 pair itest: work permit is the only mandatory credential (probe)` — a probe left in force
 * by another suite that was stopped between its supersede and its `finally` — and from that version on
 * every run of this file read `{work_permit}`, called it the original, and wrote it back.
 *
 * The visible symptom was somewhere else entirely, which is why it survived so long: gate case 66y
 * snapshots the set in force as `seeded`, its `restoreSeededProfile()` writes the value the migrations
 * actually seed, and the control then failed with
 * `before={professional_licence,health_certificate} after={professional_licence,health_certificate}
 * seeded={work_permit}`. Red on a reused database, green on a fresh one — so it never failed a merge
 * verify, where the database is created from nothing.
 *
 * ## Why naming only `source_note` is the whole of the fix
 *
 * `insert into regulatory_profile (source_note) values (...)` is character for character what 0004's
 * own seed does and what 0058's reconciliation does, so every other column takes its DEFAULT — which
 * makes "the seeded profile" and "every column at its DEFAULT" the same sentence. Nothing is restated,
 * so nothing can be restated wrongly (the failure `opening-balances.itest.ts` records from one side and
 * `catalogue-compliance.itest.ts` from the other), and nothing is read back from a row another suite may
 * have left behind, so there is nothing to propagate.
 *
 * It therefore HEALS a polluted database rather than merely surviving one. That is asserted by gate case
 * 75: the profile in force is deliberately corrupted, this file is run, and the set in force afterwards
 * must be the seeded one — with the found-value version of this function restored as the known-bad
 * control, under which the corruption survives.
 */
async function restoreSeededProfile(): Promise<void> {
  await sql`
    with retired as (
      update regulatory_profile set superseded_at = now() where superseded_at is null returning version
    )
    insert into regulatory_profile (source_note)
    select 'P-HR-02 hr-credentials itest: restoring the SEEDED profile — every column at its DEFAULT, '
        || 'which is what 0004 and 0058 both insert. Retired version ' || retired.version || '.'
      from retired
  `
}

/**
 * Runs `body` with a named profile in force, and restores the SEEDED profile afterwards, always.
 *
 * The boundary and window assertions below are about `labour_card`, which is in decision 20's stricter
 * reading. Since migration 0058 that is also what the row in force says, so these wrappers now state a
 * profile the database already has — which is deliberate rather than redundant: a test that leaned on
 * the row in force would go quiet the day somebody supersedes it, and stating the profile it needs is
 * what keeps "VALID at 23:59:59+04:00, EXPIRED one second later" a claim about the labour card.
 */
async function withProfile<T>(change: ProfileChange, body: () => Promise<T>): Promise<T> {
  await supersedeProfile(change)
  try {
    return await body()
  } finally {
    await restoreSeededProfile()
  }
}

const ROLLBACK = 'phr02-probe-rollback'

/** Runs `body` in a transaction that is always rolled back, returning the error it raised, if any. */
async function refusalOf(body: (tx: Sql) => Promise<unknown>): Promise<string> {
  try {
    await sql.begin(async (tx) => {
      await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
    return ''
  } catch (err) {
    const message = String((err as Error)?.message ?? '')
    if (message === ROLLBACK) return ''
    return message
  }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  // Self-sufficient rather than dependent on the file order: `pnpm seed` runs before this suite in CI,
  // but this file's own Unconfirmed Assumptions assertion needs the `app_setting` row and the insert is
  // `on conflict do nothing`, so re-running it is free and cannot overwrite a confirmed value.
  await seedSettingDefaults(sql)
  // Nothing about the profile is snapshotted here, and that is the point of this file's repair: the
  // value in force at the start of a run is not evidence of anything — it is whatever the previous run,
  // or a suite that was stopped mid-probe, happened to leave. What this file restores is the SEEDED
  // profile; see restoreSeededProfile.

  for (const handle of ['full', 'wellness-only', 'lapsed', 'nothing', 'nonexpiring']) {
    await makeEmployee(handle)
  }
  // Every document these five hold is written here, so a previous run of this file cannot leave a row
  // that changes an answer. The employees survive — they are keyed on `staff_reference` and other rows
  // may reference them — and only the documents are rewritten.
  await sql`
    delete from employee_document where employee_id = any(${[...employees.values()]}::uuid[])
  `
  // Holds the whole stricter six, all far in the future.
  for (const documentType of HEALTHCARE) await fileDocument('full', documentType, FAR_FUTURE)
  // Holds the wellness three only: eligible under a wellness profile, not under a healthcare one.
  for (const documentType of WELLNESS) await fileDocument('wellness-only', documentType, FAR_FUTURE)
  // Holds the whole six, but the labour card expired at the end of 2026-03-31 and has NOT been renewed —
  // so the latest row for that type is the lapsed one, which is what the boundary assertions need.
  for (const documentType of HEALTHCARE) {
    await fileDocument(
      'lapsed',
      documentType,
      documentType === 'labour_card' ? LAPSED_LABOUR_CARD : FAR_FUTURE,
    )
  }
  // 'nothing' holds nothing at all. 'nonexpiring' gets its row inside the test that declares the type.
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the mandatory set is derived from regulatory_profile and from nothing else', () => {
  it('shrinks when the profile flips from the stricter healthcare reading to wellness', async () => {
    const before = await profileRowCount()
    let versions = 0
    try {
      // 1. The stricter reading in force. The therapist holding only the wellness three is refused, and
      //    the three refused documents are exactly the healthcare-specific ones.
      versions += 1
      await supersedeProfile({
        mandatory: HEALTHCARE,
        licenceClass: 'unconfirmed',
        note: 'P-HR-02 itest: the stricter healthcare reading of an unconfirmed licence (probe)',
      })
      const strict = await readCredentialPolicy(sql)
      expect([...strict.mandatoryTypes]).toEqual(HEALTHCARE)
      const underStrict = await evaluate('wellness-only')
      expect(underStrict.eligible).toBe(false)
      expect(underStrict.blocking.map((a) => a.documentType).sort()).toEqual([
        'good_conduct_certificate',
        'medical_fitness_certificate',
        'occupational_health_card',
      ])
      // And the therapist holding all six is eligible, so the refusal above is about the documents and
      // not about the gate refusing everybody.
      expect((await evaluate('full')).eligible).toBe(true)

      // 2. The flip. A lawyer's answer of "commercial wellness activity" reaches the gate with no deploy.
      versions += 1
      await supersedeProfile({
        mandatory: WELLNESS,
        licenceClass: 'wellness',
        note: 'P-HR-02 itest: the wellness reading — the labour and immigration documents only (probe)',
      })
      const wellness = await readCredentialPolicy(sql)
      // The set SHRANK, and it shrank to a strict subset rather than to something else.
      expect(wellness.mandatoryTypes.length).toBeLessThan(strict.mandatoryTypes.length)
      expect([...wellness.mandatoryTypes]).toEqual(WELLNESS)
      for (const documentType of wellness.mandatoryTypes) {
        expect(strict.mandatoryTypes).toContain(documentType)
      }
      // Both directions of the consequence. The therapist who was refused is now eligible...
      const underWellness = await evaluate('wellness-only')
      expect(underWellness.eligible).toBe(true)
      expect(underWellness.blocking).toEqual([])
      // ...and the three healthcare documents the other therapist holds are no longer MANDATORY, so they
      // moved to `other`. A gate that had merely stopped checking would satisfy the first half only.
      const full = await evaluate('full')
      expect(full.mandatory.map((a) => a.documentType)).toEqual(WELLNESS)
      expect(full.other.map((a) => a.documentType).sort()).toEqual([
        'good_conduct_certificate',
        'medical_fitness_certificate',
        'occupational_health_card',
      ])

      // 3. The control that a lookup on licence_class cannot pass. A set that is NEITHER candidate, under
      //    a licence class that says healthcare: the gate must honour the ROW.
      versions += 1
      await supersedeProfile({
        mandatory: ['passport', 'training_certificate'],
        licenceClass: 'healthcare',
        note: 'P-HR-02 itest: a mandatory set that is neither published reading (probe)',
      })
      const invented = await readCredentialPolicy(sql)
      expect([...invented.mandatoryTypes]).toEqual(['passport', 'training_certificate'])
      const underInvented = await evaluate('full')
      expect(underInvented.mandatory.map((a) => a.documentType)).toEqual([
        'passport',
        'training_certificate',
      ])
      // Neither is on file, so the therapist who holds all six healthcare documents is now refused — the
      // opposite answer from case 1 under a licence class that would have implied the stricter set.
      expect(underInvented.eligible).toBe(false)
      expect(underInvented.blocking).toHaveLength(2)

      // 4. And the empty set: no credential gate at all, which 0030 records as a decision a lawyer takes.
      versions += 1
      await supersedeProfile({
        mandatory: [],
        note: 'P-HR-02 itest: no credential gate (probe)',
      })
      expect((await readCredentialPolicy(sql)).mandatoryTypes).toEqual([])
      expect((await evaluate('nothing')).eligible).toBe(true)
    } finally {
      versions += 1
      await restoreSeededProfile()
    }
    // A delta, never a total, and nothing deleted: the table is append-only, so the profile in force on
    // any past date stays recoverable.
    expect(await profileRowCount()).toBe(before + versions)
    // The SEEDED value, not the one this file found. Asserting the restore against the snapshot would be
    // asserting that the restore wrote back what the restore was told to write back, which is true of
    // the broken version too — see restoreSeededProfile.
    const policy = await readCredentialPolicy(sql)
    expect([...policy.mandatoryTypes]).toEqual([...SEEDED_MANDATORY])
    expect([...policy.nonExpiringTypes]).toEqual([...SEEDED_NON_EXPIRING])
    // And the licence class, which is the column of this table that reaches the public site: the probe
    // above set it to `healthcare` on purpose, and a restore that put back only the two arrays would
    // leave the banned-claims lint, the permitted titles and the JSON-LD vocabulary changed for every
    // suite after this one. It cost a run to find; the assertion is what stops it costing another.
    const [restored] = await sql<{ licence_class: string }[]>`
      select licence_class::text from regulatory_profile_current
    `
    expect((restored as { licence_class: string }).licence_class).toBe(SEEDED_LICENCE_CLASS)
  })

  it('yields the stricter set when the profile states no mandatory set, which is the DEFAULT', async () => {
    // "The default profile yields the stricter set." Read from the database by inserting a version that
    // names no mandatory column at all, so the value comes from 0054's DEFAULT rather than from this
    // test — the alternative, asserting the text of `pg_get_expr`, proves the SQL says something and not
    // that the database does it.
    const before = await profileRowCount()
    try {
      await supersedeProfile({
        note: 'P-HR-02 itest: a profile version stating no mandatory set, so the default applies (probe)',
      })
      const defaulted = await readCredentialPolicy(sql)
      expect([...defaulted.mandatoryTypes]).toEqual(HEALTHCARE)
      // The default is also the strict option in the other column: nothing is declared non-expiring, so
      // every credential must be renewed until somebody says otherwise.
      expect([...defaulted.nonExpiringTypes]).toEqual([])
    } finally {
      await restoreSeededProfile()
    }
    expect(await profileRowCount()).toBe(before + 2)
  })

  it('reads the view and not the table, so a superseded version cannot answer', async () => {
    // The control on the reader itself. Every consumer reads `regulatory_profile_current` (0004), and a
    // reader that queried the table would see every version ever written and return an arbitrary one.
    const [counts] = await sql<{ rows: string; current: string }[]>`
      select (select count(*)::text from regulatory_profile) as rows,
             (select count(*)::text from regulatory_profile_current) as current
    `
    expect(Number((counts as { rows: string }).rows)).toBeGreaterThan(1)
    expect(Number((counts as { current: string }).current)).toBe(1)
    const policy = await readCredentialPolicy(sql)
    expect(policy.profileVersion).toBeGreaterThan(0)
    const [inForce] = await sql<{ version: number }[]>`
      select version from regulatory_profile_current
    `
    expect(policy.profileVersion).toBe(Number((inForce as { version: number }).version))
  })
})

describe('acceptance — a type configured as non-expiring, against real PostgreSQL', () => {
  it('refuses a NULL expiry for a type the profile does not declare', async () => {
    // 0030's guarantee, still true after `expires_on` became nullable: this is the whole reason the
    // trigger exists rather than the NOT NULL simply being dropped.
    const message = await refusalOf(
      (tx) => tx`
        insert into employee_document (employee_id, document_type, expires_on)
        values (${employees.get('nonexpiring') as string}, 'emiratisation_record', null)
      `,
    )
    expect(message).toContain('EmployeeDocumentExpiryIsDeclared')
  })

  it('accepts one, and reports it VALID for ever, once the profile declares the type', async () => {
    const before = await profileRowCount()
    try {
      await supersedeProfile({
        nonExpiring: ['emiratisation_record'],
        mandatory: ['emiratisation_record'],
        note: 'P-HR-02 itest: the Emiratisation record declared non-expiring and mandatory (probe)',
      })
      await fileDocument('nonexpiring', 'emiratisation_record', null)
      const rows = await readEmployeeCredentials(sql, [employees.get('nonexpiring') as string])
      expect(rows).toHaveLength(1)
      expect(rows[0]?.expiresOn).toBeNull()
      expect(rows[0]?.hasSealedNumber).toBe(false)

      // VALID at an instant decades after every other document in this file has expired, which is what
      // "never returns EXPIRED" means when the row itself carries no date.
      for (const instant of [
        NOON,
        at('2099-12-31T23:00:00+04:00'),
        at('1971-01-01T00:00:00+04:00'),
      ]) {
        const result = await evaluate('nonexpiring', instant)
        expect(statusOf(result, 'emiratisation_record')).toBe('VALID')
        expect(result.eligible).toBe(true)
      }

      // One record per employee per non-expiring type. The UNIQUE constraint of 0030 cannot say this,
      // because it includes `expires_on` and two NULLs are distinct to a unique constraint.
      const duplicate = await refusalOf(
        (tx) => tx`
          insert into employee_document (employee_id, document_type, expires_on)
          values (${employees.get('nonexpiring') as string}, 'emiratisation_record', null)
        `,
      )
      expect(duplicate).toContain('employee_document_one_row_per_non_expiring')
    } finally {
      // The document is removed as well as the profile restored. A row with a NULL expiry surviving into
      // a database where no type is declared non-expiring would be exactly the state 0030 refused, and
      // an UPDATE on it would then trip the trigger for a later suite — brief rule 12.
      await sql`
        delete from employee_document
         where employee_id = ${employees.get('nonexpiring') as string}
           and expires_on is null
      `
      await restoreSeededProfile()
    }
    expect(await profileRowCount()).toBe(before + 2)
    // And the control: with the declaration withdrawn, the type is refused a NULL expiry again.
    const again = await refusalOf(
      (tx) => tx`
        insert into employee_document (employee_id, document_type, expires_on)
        values (${employees.get('nonexpiring') as string}, 'emiratisation_record', null)
      `,
    )
    expect(again).toContain('EmployeeDocumentExpiryIsDeclared')
  })
})

describe('acceptance — the expiry boundary is Asia/Dubai over rows that made the round trip', () => {
  const STRICTER: ProfileChange = {
    mandatory: HEALTHCARE,
    note: 'P-HR-02 itest: the stricter healthcare reading, for the boundary assertions (probe)',
  }

  it('is VALID at 2026-03-31T23:59:59+04:00 and EXPIRED one second later', async () => {
    // The same two instants the criterion names, over a `date` column read back as text rather than over
    // a literal in a unit test. The `lapsed` employee's labour card expires 2026-03-31.
    await withProfile(STRICTER, async () => {
      const lastSecond = await evaluate('lapsed', at('2026-03-31T23:59:59+04:00'))
      expect(lastSecond.asOfDate).toBe('2026-03-31')
      expect(statusSatisfies(statusOf(lastSecond, 'labour_card') as CredentialStatus)).toBe(true)
      expect(lastSecond.eligible).toBe(true)

      const nextInstant = await evaluate('lapsed', at('2026-04-01T00:00:00+04:00'))
      expect(nextInstant.asOfDate).toBe('2026-04-01')
      expect(statusOf(nextInstant, 'labour_card')).toBe('EXPIRED')
      expect(nextInstant.eligible).toBe(false)
      expect(nextInstant.blocking.map((a) => a.documentType)).toEqual(['labour_card'])
      // Every other document on that file is untouched, so the flip is the labour card's and not the
      // evaluator's opinion of the whole row.
      for (const assessment of nextInstant.mandatory) {
        if (assessment.documentType !== 'labour_card') expect(assessment.status).toBe('VALID')
      }
    })
  })

  it('and the renewal takes effect from the row, with no edit to the lapsed one', async () => {
    // A renewal is a new row, which is what `employee_document_one_row_per_expiry` is for. Filed and then
    // removed, because the rest of this file asserts the card IS lapsed at that instant.
    await withProfile(STRICTER, async () => {
      await fileDocument('lapsed', 'labour_card', '2027-03-31')
      try {
        const renewed = await evaluate('lapsed', at('2026-04-01T00:00:00+04:00'))
        expect(statusOf(renewed, 'labour_card')).toBe('VALID')
        expect(renewed.eligible).toBe(true)
        // Both rows are still on file: the history is the evidence of what was valid last March.
        const rows = await readEmployeeCredentials(sql, [employees.get('lapsed') as string])
        expect(
          rows.filter((r) => r.documentType === 'labour_card').map((r) => r.expiresOn),
        ).toEqual(['2027-03-31', '2026-03-31'])
      } finally {
        await sql`
          delete from employee_document
           where employee_id = ${employees.get('lapsed') as string}
             and document_type = 'labour_card' and expires_on = date '2027-03-31'
        `
      }
      expect(
        statusOf(await evaluate('lapsed', at('2026-04-01T00:00:00+04:00')), 'labour_card'),
      ).toBe('EXPIRED')
    })
  })
})

describe('acceptance — the EXPIRING_SOON window is the settings value and is an unconfirmed assumption', () => {
  it('is read from app_setting and is the provisional 60 days', async () => {
    const policy = await readCredentialPolicy(sql)
    expect(policy.expiringSoonDays).toBe(PROVISIONAL_EXPIRING_SOON_DAYS)
    const [row] = await sql<{ value: number; provisional: boolean; question: string | null }[]>`
      select value::text::int as value, is_provisional as provisional,
             open_question_id as question
        from app_setting where key = ${CREDENTIAL_EXPIRING_SOON_SETTING_KEY}
    `
    expect(row?.value).toBe(PROVISIONAL_EXPIRING_SOON_DAYS)
    expect(row?.provisional).toBe(true)
    expect(row?.question).toBe('Y1-licence')
  })

  it('is returned by the Unconfirmed Assumptions query', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const entry = rows.find(
      (row) =>
        row.source === 'app_setting' && row.reference === CREDENTIAL_EXPIRING_SOON_SETTING_KEY,
    )
    expect(entry, CREDENTIAL_EXPIRING_SOON_SETTING_KEY).toBeDefined()
    expect(entry?.openQuestionId).toBe('Y1-licence')
    expect(entry?.note ?? '').not.toBe('')
    // The control: a setting the build decided rather than guessed is absent, so the assertion above is
    // not satisfied by a query that returns every row of `app_setting`.
    expect(
      rows.some(
        (row) => row.source === 'app_setting' && row.reference === 'messaging.promotional_window',
      ),
    ).toBe(false)
  })

  it('changes the status a document is reported with, without changing eligibility', async () => {
    // The window is a warning and not a refusal. The `lapsed` employee's labour card expires 2026-03-31;
    // judged on 2026-03-01 that is 30 days out.
    const thirtyDaysBefore = at('2026-03-01T12:00:00+04:00')
    await withProfile(
      {
        mandatory: HEALTHCARE,
        note: 'P-HR-02 itest: the stricter healthcare reading, for the window assertions (probe)',
      },
      async () => {
        const policy = await readCredentialPolicy(sql)
        const credentials = await heldBy('lapsed')
        const soon = evaluateCredentials({ credentials, policy, at: thirtyDaysBefore })
        expect(statusOf(soon, 'labour_card')).toBe('EXPIRING_SOON')
        expect(soon.eligible).toBe(true)

        // A narrower window, as an admin may set it, and the same row is merely VALID.
        const narrow = evaluateCredentials({
          credentials,
          policy: { ...policy, expiringSoonDays: 7 },
          at: thirtyDaysBefore,
        })
        expect(statusOf(narrow, 'labour_card')).toBe('VALID')
        expect(narrow.eligible).toBe(true)
      },
    )
  })
})

describe('the registry refuses what the whole estate refuses', () => {
  it('will not take a residence-visa number in the plaintext reference column', async () => {
    // 0050's rule for an Emirates ID and a passport, extended by 0054 to the third identity-bearing
    // type. The value below is not a visa number and does not look like one: the constraint is on the
    // column being non-null for that type, so the probe needs no plausible number (brief rule 15).
    const message = await refusalOf(
      (tx) => tx`
        insert into employee_document (employee_id, document_type, reference, expires_on)
        values (${employees.get('nothing') as string}, 'residence_visa', 'anything at all',
                date '2030-01-01')
      `,
    )
    expect(message).toContain('employee_document_visa_number_is_encrypted')
  })

  it('will not take a placeholder issuing authority, because a placeholder reads as configured', async () => {
    const message = await refusalOf(
      (tx) => tx`
        insert into employee_document (employee_id, document_type, issuing_authority, expires_on)
        values (${employees.get('nothing') as string}, 'labour_card', 'TBC', date '2030-01-01')
      `,
    )
    expect(message).toContain('employee_document_issuing_authority_not_placeholder')
  })

  it('takes a real issuing authority, which is the control on the rule above', async () => {
    const accepted = await refusalOf(
      (tx) => tx`
        insert into employee_document (employee_id, document_type, issuing_authority, expires_on)
        values (${employees.get('nothing') as string}, 'labour_card',
                'Ministry of Human Resources and Emiratisation', date '2030-01-01')
      `,
    )
    expect(accepted).toBe('')
  })

  it('holds every label 0054 added, in the order the enum holds them', async () => {
    const rows = await sql<{ label: string }[]>`
      select unnest(enum_range(null::employee_document_type))::text as label
    `
    const labels = rows.map((row) => row.label)
    // The six of decision 20's stricter reading have to be spellable, or the DEFAULT could not name them.
    for (const documentType of HEALTHCARE) expect(labels).toContain(documentType)
    // And the three records docs/04 §7 names in the same paragraph, in this registry rather than in
    // tables of their own.
    expect(labels).toContain('health_insurance')
    expect(labels).toContain('unemployment_insurance')
    expect(labels).toContain('emiratisation_record')
    // The control: 0030's six are still there and still first, so nothing was renamed or reordered —
    // which would silently reinterpret every stored row, because an enum is stored by ordinal.
    expect(labels.slice(0, 6)).toEqual([
      'professional_licence',
      'health_certificate',
      'work_permit',
      'emirates_id',
      'passport',
      'training_certificate',
    ])
  })
})
