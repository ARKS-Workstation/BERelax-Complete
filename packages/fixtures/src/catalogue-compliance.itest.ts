import {
  assertPublicDisplayNameCompliant,
  type CompliancePolicy,
  filsFrom,
  lintPublicDisplayName,
  lintServiceName,
  localDate,
  money,
  type PriceListId,
  refusedRulesOf,
  resolvePrice,
  splitGross,
} from '@berelax/core'
import {
  type CompliancePolicyRow,
  changeVariantPrice,
  createConnection,
  readCompliancePolicy,
  type Sql,
  setPublicDisplayName,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * B-CAT-05 — the two halves of this unit, joined.
 *
 * The lexicon is pure and lives in `@berelax/core`; the term list and the permitted staff titles are
 * versioned rows in `regulatory_profile`, read by `@berelax/db`. Neither package may import the other —
 * `packages/db` must never import `packages/core` — so nothing but `@berelax/fixtures` can assert that
 * the pair works, and the pair is the whole claim: a licence answer recorded as data has to reach the
 * lint without a deploy.
 *
 * Three things are proved here that neither half can prove alone:
 *
 *   1. the lint refuses `Therapeutic Deep Tissue Treatment` under the profile that is actually in force
 *      in the database, and accepts it under a healthcare profile — the flip, against real rows;
 *   2. the catalogue chokepoint refuses the write, so the lint is a guard rail rather than a linting
 *      library nobody called;
 *   3. a `price_list` change leaves an existing appointment's snapshotted gross — and therefore its
 *      derived net and VAT — exactly as they were, while the resolver prices new bookings at the new
 *      figure. Both halves matter: without the second, "untouched" is satisfied by a price change that
 *      did nothing.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const PROBE = 'bcat05_pair_probe'
const PROBE_SLUG = 'bcat05-pair-probe'
const TRADING_DATE = '2099-06-01'
const at = (hhmm: string): string => `2099-06-01 ${hhmm}:00+00`
const PROBE_PHONE = '+971500000144'
/** Therapists carry no display name; this is an id and nothing else (brief rule 10). */
const THERAPIST = 'aaaaaaaa-0000-4000-8000-0000000c0502'
const ACTOR = { kind: 'system', label: 'B-CAT-05 pair itest' } as const
/** The gross the appointment is quoted at: 200.00 AED as integer fils, VAT-inclusive (ADR 0007). */
const QUOTED_FILS = 20000
/** What the price rises to. Different from the quote, or the snapshot assertion proves nothing. */
const RAISED_FILS = 24000

let sql: Sql
let seededProfile: ProfileSnapshot
let serviceId: string
let variantId: string
let appointmentId: string

/** The db-side policy row in the shape `@berelax/core` lints from. A field copy, and nothing more. */
const asPolicy = (row: CompliancePolicyRow): CompliancePolicy => ({
  bannedClaimTerms: row.bannedClaimTerms,
  permittedPublicTitles: row.permittedPublicTitles,
  medicalClaimsPermitted: row.medicalClaimsPermitted,
})

/** The fields of the profile in force this file changes, so it can put every one of them back. */
interface ProfileSnapshot {
  readonly licenceClass: string
  readonly medicalClaimsPermitted: boolean
  readonly permittedPublicTitles: readonly string[]
  readonly isProvisional: boolean
}

/**
 * Supersedes the profile in force and inserts a new one, which is how 0004 says a profile changes.
 *
 * `regulatory_profile` is append-only (ADR 0008): rows are never edited and never deleted, and
 * `superseded_at` on the outgoing row is the one field a change writes. So this adds rows, the
 * assertions below read a DELTA rather than a count, and the restore at the end is a further row rather
 * than a `delete`.
 *
 * Everything not named in the snapshot — the retention years, the erasure rule, the banned terms, the
 * emirate — is carried over from the retired row rather than restated, and `licenceClass` is in the
 * snapshot for a reason found the hard way: restoring a "strict" profile as `wellness` rather than the
 * seeded `unconfirmed` left `spine.itest.ts` asserting the default combination against a profile this
 * file had quietly changed. A fixture that restores *nearly* the original row is a fixture that breaks
 * another suite one file later.
 */
async function supersedeProfile(
  snapshot: ProfileSnapshot & { readonly note: string },
): Promise<number> {
  const [row] = await sql<{ version: number }[]>`
    with retired as (
      update regulatory_profile set superseded_at = now() where superseded_at is null
      returning banned_claim_terms, clinical_retention_years, financial_retention_years,
                erasure_overrides_retention, emirate
    )
    insert into regulatory_profile
      (licence_class, emirate, clinical_retention_years, financial_retention_years,
       erasure_overrides_retention, medical_claims_permitted, permitted_public_titles,
       banned_claim_terms, is_provisional, source_note)
    select
      ${snapshot.licenceClass}::licence_class,
      retired.emirate, retired.clinical_retention_years, retired.financial_retention_years,
      retired.erasure_overrides_retention, ${snapshot.medicalClaimsPermitted},
      ${sql.array([...snapshot.permittedPublicTitles])}::text[], retired.banned_claim_terms,
      ${snapshot.isProvisional}, ${snapshot.note}
    from retired
    returning version
  `
  return Number(row?.version)
}

/** The profile as this file found it, restored verbatim after every flip. */
async function currentProfile(): Promise<ProfileSnapshot> {
  const [row] = await sql<
    {
      licence_class: string
      medical_claims_permitted: boolean
      permitted_public_titles: string[]
      is_provisional: boolean
    }[]
  >`
    select licence_class, medical_claims_permitted, permitted_public_titles, is_provisional
      from regulatory_profile_current
  `
  return {
    licenceClass: (row as { licence_class: string }).licence_class,
    medicalClaimsPermitted: (row as { medical_claims_permitted: boolean }).medical_claims_permitted,
    permittedPublicTitles: (row as { permitted_public_titles: string[] }).permitted_public_titles,
    isProvisional: (row as { is_provisional: boolean }).is_provisional,
  }
}

async function profileRowCount(): Promise<number> {
  const [row] = await sql<{ n: string }[]>`select count(*)::text as n from regulatory_profile`
  return Number(row?.n)
}

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  seededProfile = await currentProfile()
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
    values ('asian', ${PROBE}, ${PROBE_SLUG}, 'Probe', 'Normal Massage (Asian)', 20)
    returning id
  `
  serviceId = service?.id as string
  const [variant] = await sql<{ id: string }[]>`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 60, ${QUOTED_FILS}, ${'B-CAT-05 pair fixture'})
    returning id
  `
  variantId = variant?.id as string

  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${at('07')}::timestamptz, ${at('22')}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `
  const [room] = await sql<{ id: string }[]>`select id from rooms where code = 'room-1'`
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source) values (${customer?.id as string}, 'online')
    returning id
  `
  const [appointment] = await sql<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       gross_price_fils)
    values (
      ${booking?.id as string}, ${TRADING_DATE}, ${variantId}, 'solo', ${THERAPIST},
      ${room?.id as string}, ${`[${at('20')},${at('21')})`}::tstzrange, 'confirmed', ${QUOTED_FILS}
    )
    returning id
  `
  appointmentId = appointment?.id as string
})

afterAll(async () => {
  await sql.unsafe('truncate booking_idempotency, appointment_status_history, appointment, booking')
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

describe('acceptance — the lexicon reads its list from regulatory_profile', () => {
  const NAME = 'Therapeutic Deep Tissue Treatment'

  it('refuses the name under the profile the database actually holds', async () => {
    const policy = asPolicy(await readCompliancePolicy(sql))
    // Not a hand-made object: the seeded profile (0004) is the stricter combination, and the point of
    // this assertion is that the row says so rather than that a fixture does.
    expect(policy.medicalClaimsPermitted).toBe(false)
    expect(policy.bannedClaimTerms).toContain('therapeutic')
    expect(policy.permittedPublicTitles).toEqual(['Therapist', 'Senior Therapist', 'Spa Therapist'])

    const findings = lintPublicDisplayName(NAME, policy)
    expect(findings.map((f) => f.rule)).toEqual(['banned_claim_term', 'banned_claim_term'])
    expect(findings.map((f) => f.term)).toEqual(['therapeutic', 'treatment'])
    // The same string as the internal name is accepted, which is the asymmetry 0017 split the columns
    // for: the front desk's own words are not published.
    expect(lintServiceName(NAME, 'internal', policy)).toEqual([])
  })

  it('accepts every public name the catalogue actually ships with', async () => {
    const policy = asPolicy(await readCompliancePolicy(sql))
    const rows = await sql<{ public_display_name: string }[]>`
      select public_display_name from service where treatment_key <> ${PROBE} order by display_order
    `
    expect(rows.length).toBeGreaterThanOrEqual(8)
    for (const row of rows) {
      expect(lintPublicDisplayName(row.public_display_name, policy)).toEqual([])
    }
  })

  it('accepts the same name once the profile in force permits medical claims', async () => {
    const before = await profileRowCount()
    const version = await supersedeProfile({
      licenceClass: 'healthcare',
      medicalClaimsPermitted: true,
      permittedPublicTitles: seededProfile.permittedPublicTitles,
      isProvisional: true,
      note: 'B-CAT-05 pair itest: healthcare licence confirmed (probe)',
    })
    try {
      const flipped = asPolicy(await readCompliancePolicy(sql))
      expect(flipped.medicalClaimsPermitted).toBe(true)
      // The flip, and the reason the list is data: a lawyer's answer reaches the lint without a deploy.
      expect(lintPublicDisplayName(NAME, flipped)).toEqual([])
      // And the half no licence class relaxes is still refused, under the same profile.
      expect(lintPublicDisplayName('Happy Ending Massage', flipped).map((f) => f.rule)).toEqual([
        'reads_as_solicitation',
      ])
    } finally {
      // Restored by INSERTING the strict profile again, never by deleting the row: the table is
      // append-only, so the profile in force on any past date stays recoverable (ADR 0008).
      await supersedeProfile({
        ...seededProfile,
        note: 'B-CAT-05 pair itest: restoring the seeded strict profile',
      })
    }
    // A delta, never a total: two rows added, the version moved forward, nothing deleted.
    expect(await profileRowCount()).toBe(before + 2)
    expect(version).toBeGreaterThan(0)
    const restored = asPolicy(await readCompliancePolicy(sql))
    expect(restored.medicalClaimsPermitted).toBe(false)
    expect(lintPublicDisplayName(NAME, restored).length).toBeGreaterThan(0)
    // Every field back, not just the one this case flipped: `spine.itest.ts` asserts the seeded
    // combination, and it runs after this file.
    expect(await currentProfile()).toEqual(seededProfile)
  })

  it('follows the profile when the permitted staff titles change', async () => {
    const before = await profileRowCount()
    await supersedeProfile({
      ...seededProfile,
      permittedPublicTitles: ['Spa Therapist'],
      note: 'B-CAT-05 pair itest: narrowing the permitted titles (probe)',
    })
    try {
      const narrowed = asPolicy(await readCompliancePolicy(sql))
      // 'Therapist' is no longer permitted on its own, and the lint says so without a code change.
      expect(narrowed.permittedPublicTitles).toEqual(['Spa Therapist'])
      expect(
        lintPublicDisplayName('Massage with a Senior Therapist', narrowed).map((f) => f.rule),
      ).toEqual([])
      expect(lintPublicDisplayName('Massage with a Masseuse', narrowed).map((f) => f.rule)).toEqual(
        ['unpermitted_staff_title'],
      )
    } finally {
      await supersedeProfile({
        ...seededProfile,
        note: 'B-CAT-05 pair itest: restoring the seeded strict profile',
      })
    }
    expect(await profileRowCount()).toBe(before + 2)
    expect(await currentProfile()).toEqual(seededProfile)
  })
})

describe('acceptance — the catalogue chokepoint applies the lint it is given', () => {
  it('refuses to write a non-compliant public display name', async () => {
    const policy = asPolicy(await readCompliancePolicy(sql))
    const lint = (name: string): void => {
      assertPublicDisplayNameCompliant(name, policy)
    }
    let caught: unknown = null
    try {
      await withUnitOfWork(sql, ACTOR, (uow) =>
        setPublicDisplayName(uow, {
          serviceId,
          publicDisplayName: 'Therapeutic Deep Tissue Treatment',
          lint,
        }),
      )
    } catch (error) {
      caught = error
    }
    expect(refusedRulesOf(caught)).toEqual(['banned_claim_term', 'banned_claim_term'])
    // Nothing was written: the refusal happens before the UPDATE, and the transaction rolled back.
    const [row] = await sql<{ public_display_name: string }[]>`
      select public_display_name from service where id = ${serviceId}
    `
    expect(row?.public_display_name).toBe('Normal Massage (Asian)')
  })

  it('writes a compliant one, so the guard rail is not simply refusing everything', async () => {
    const policy = asPolicy(await readCompliancePolicy(sql))
    const written = await withUnitOfWork(sql, ACTOR, (uow) =>
      setPublicDisplayName(uow, {
        serviceId,
        publicDisplayName: 'Hot Oil / Balm Massage (Asian)',
        lint: (name) => {
          assertPublicDisplayNameCompliant(name, policy)
        },
      }),
    )
    expect(written.publicDisplayName).toBe('Hot Oil / Balm Massage (Asian)')
  })
})

describe('acceptance — a price_list change leaves a booked appointment alone', () => {
  it('leaves the snapshotted gross, net and VAT exactly as they were', async () => {
    const readAppointment = async (): Promise<number> => {
      const [row] = await sql<{ gross_price_fils: string }[]>`
        select gross_price_fils from appointment where id = ${appointmentId}
      `
      return Number(row?.gross_price_fils)
    }

    const grossBefore = await readAppointment()
    expect(grossBefore).toBe(QUOTED_FILS)
    // Net and VAT are not stored (ADR 0007): gross is authoritative and the pair is derived, so
    // "untouched" means the derivation from the snapshot gives the same two figures afterwards.
    const breakdownBefore = splitGross(money(filsFrom(grossBefore)))

    const change = await withUnitOfWork(sql, ACTOR, (uow) =>
      changeVariantPrice(uow, {
        serviceVariantId: variantId,
        grossPriceFils: RAISED_FILS,
        label: 'B-CAT-05 pair itest rise',
        validFrom: '2098-01-01',
        validTo: null,
      }),
    )
    expect(change.before.effectiveGrossPriceFils).toBe(QUOTED_FILS)
    expect(change.after.grossPriceFils).toBe(RAISED_FILS)

    const grossAfter = await readAppointment()
    const breakdownAfter = splitGross(money(filsFrom(grossAfter)))
    expect(grossAfter).toBe(grossBefore)
    expect(breakdownAfter.net).toEqual(breakdownBefore.net)
    expect(breakdownAfter.vat).toEqual(breakdownBefore.vat)
    expect(breakdownAfter.net.fils + breakdownAfter.vat.fils).toBe(grossAfter)

    // The control. Without it, "the appointment did not move" is satisfied by a price change that
    // changed nothing — which is the failure mode this whole assertion exists to exclude.
    const rows = await sql<
      { id: string; gross_price_fils: string; valid_from: Date; valid_to: Date | null }[]
    >`
      select id, gross_price_fils, valid_from, valid_to from price_list
       where service_variant_id = ${variantId} and id = ${change.priceListId}
    `
    expect(rows).toHaveLength(1)
    // Read into a local rather than reached for with `?.`: the row was just inserted and asserted to
    // exist, and an optional chain here would silently price from `NaN` if it ever stopped existing.
    const listRow = rows[0] as { id: string; gross_price_fils: string; valid_from: Date }
    const priced = resolvePrice(
      {
        variant: { grossFils: filsFrom(QUOTED_FILS), durationMinutes: 60 },
        priceList: {
          priceListId: listRow.id as PriceListId,
          grossFils: filsFrom(Number(listRow.gross_price_fils)),
          validFrom: localDate(listRow.valid_from.toISOString().slice(0, 10)),
          validTo: null,
        },
      },
      { on: localDate('2099-06-01') },
    )
    expect(priced.appliedRule).toBe('price_list')
    expect(priced.gross.fils).toBe(RAISED_FILS)
    // A new booking is priced at the new figure; the one already taken is not. Both, or neither
    // assertion means anything.
    expect(priced.gross.fils).not.toBe(grossAfter)
  })
})
