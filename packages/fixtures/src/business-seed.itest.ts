import {
  assertPublicDisplayNameCompliant,
  type CompliancePolicy,
  isPlaceholderText,
  lintPublicDisplayName,
  PLACEHOLDER_TRN,
  refusedRulesOf,
} from '@berelax/core'
import {
  assertPublicDisplayNameLinted,
  comparePriceCells,
  createConnection,
  DOCS_13_PRICE_POINT_COUNT,
  LEGAL_ENTITY_SEED,
  PREMISES_NAP,
  PRICE_ON_REQUEST_SEED,
  type Sql,
  type StoredPricePoint,
  seedCatalogue,
  TRADING_CLOSE_TIME,
  TRADING_OPEN_TIME,
  unconfirmedAssumptionRows,
  WHATSAPP_PENDING,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FIXTURE_CLOSE, FIXTURE_OPEN } from './clock.ts'
import { loadSalon } from './load.ts'
import { generateSalon } from './salon.ts'

/**
 * B-CAT-06 — the real business, in the database.
 *
 * Everything asserted here is a fact from `docs/13-business-profile.md` or the deliberate absence of
 * one. It lives in `packages/fixtures` for the usual reason: `packages/db` writes the rows and
 * `packages/core` holds the compliance lexicon and the placeholder validator, `packages/db` may never
 * import `packages/core`, and this is the only package allowed to depend on both.
 *
 * The three claims that need both halves:
 *
 *   1. the 32 prices in `service_variant` are the 32 cells of docs/13 §4 — compared against the
 *      transcription, cell by cell, with a corrupted row proving the comparison can fail;
 *   2. every public display name the seed publishes passes the banned-claims lexicon under the
 *      `regulatory_profile` row actually in force, and the seed refuses to publish an unlinted one;
 *   3. the values docs/13 does **not** state are absent or carry a marker both layers refuse — the
 *      canonical WhatsApp number (Y1-nap), the TRN (Y1-trn) and every price-on-request figure
 *      (Y9-poa-prices) — and the Unconfirmed Assumptions query returns all of them.
 *
 * This file writes nothing it does not roll back. The integration suite runs sequentially against one
 * database and earlier files leave rows behind, so every probe here is inside a transaction that ends in
 * a rollback and every count is scoped to the rows the seed owns.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
let policy: CompliancePolicy

/** Thrown to roll a probe back. Any error rolls `sql.begin` back; a named one cannot be mistaken. */
const ROLLBACK = 'bcat06-probe-rollback'

/** Runs `body` in a transaction and rolls it back, returning whatever it produced. */
async function probe<T>(body: (tx: Sql) => Promise<T>): Promise<T> {
  let carried: T | undefined
  try {
    await sql.begin(async (tx) => {
      carried = await body(tx as unknown as Sql)
      throw new Error(ROLLBACK)
    })
  } catch (err) {
    if (!(err instanceof Error) || err.message !== ROLLBACK) throw err
  }
  return carried as T
}

/** The constraint a driver error names, in either of the spellings the drivers use. */
const constraintOf = (err: unknown): string =>
  String(
    (err as { constraint_name?: string; constraint?: string } | null)?.constraint_name ??
      (err as { constraint?: string } | null)?.constraint ??
      (err as Error)?.message ??
      '',
  )

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  // The suite shares one database and the file order is not this file's to choose, so the seed is
  // (re)run here rather than assumed. It is idempotent, which is the point of the assertion below.
  await loadSalon(sql, generateSalon())
  const [row] = await sql<{ banned: string[]; titles: string[]; medical: boolean }[]>`
    select banned_claim_terms as banned, permitted_public_titles as titles,
           medical_claims_permitted as medical
      from regulatory_profile where superseded_at is null
  `
  policy = {
    bannedClaimTerms: row?.banned ?? [],
    permittedPublicTitles: row?.titles ?? [],
    medicalClaimsPermitted: row?.medical ?? false,
  }
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

async function storedPrices(from: Sql = sql): Promise<readonly StoredPricePoint[]> {
  const rows = await from<
    { style: string; treatment_key: string; duration_minutes: number; gross_price_fils: string }[]
  >`
    select s.style::text as style, s.treatment_key, v.duration_minutes, v.gross_price_fils
      from service_variant v join service s on s.id = v.service_id
     order by s.style, s.treatment_key, v.duration_minutes
  `
  return rows.map((row) => ({
    style: row.style,
    treatmentKey: row.treatment_key,
    durationMinutes: Number(row.duration_minutes),
    // The driver returns `fils` (bigint) as a string so a money column cannot lose precision in
    // transit; the figures here are five digits, so Number() is exact.
    grossPriceFils: Number(row.gross_price_fils),
  }))
}

describe('the catalogue is docs/13 §4', () => {
  it('holds exactly 8 services and 32 priced variants', async () => {
    const [services] = await sql<{ n: string }[]>`select count(*)::text as n from service`
    const [variants] = await sql<{ n: string }[]>`select count(*)::text as n from service_variant`
    expect(Number(services?.n)).toBe(8)
    expect(Number(variants?.n)).toBe(DOCS_13_PRICE_POINT_COUNT)
  })

  it('matches every cell of docs/13 §4, and names the one that does not', async () => {
    expect(comparePriceCells(await storedPrices())).toEqual([])

    // The control, against the database rather than against an in-memory copy: a repriced row must be
    // reported by name. Without it, "every cell matches" is also what a comparison that read nothing
    // would say.
    const mismatches = await probe(async (tx) => {
      await tx`
        update service_variant set gross_price_fils = 52500
         where duration_minutes = 90
           and service_id = (select id from service
                              where style = 'arabic' and treatment_key = 'morocco_bath_jacuzzi')
      `
      return comparePriceCells(await storedPrices(tx))
    })
    expect(mismatches).toHaveLength(1)
    expect(mismatches[0]?.cell).toBe('arabic/morocco_bath_jacuzzi 90min')
    expect(mismatches[0]?.expectedFils).toBe(52000)
    expect(mismatches[0]?.reason).toBe('wrong_price')
    // And the rollback held: the live figure is still the document's.
    expect(comparePriceCells(await storedPrices())).toEqual([])
  })

  it('flags no variant price as provisional, because all 32 are transcribed and none derived', async () => {
    // `service_variant.is_provisional` means "this price was derived". Every one of these came off
    // docs/13 §4, so a true here would mean the seed had invented a figure.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from service_variant where is_provisional
    `
    expect(Number(row?.n)).toBe(0)
  })

  it('publishes all 8 services, which needs all three of 0029’s preconditions', async () => {
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from service
       where published_at is not null and archived_at is null
    `
    expect(Number(row?.n)).toBe(8)
    // The preconditions themselves, so "published" is not satisfied by a trigger that stopped firing:
    // every published service has a compatibility row, a resource shape and a priced variant.
    const [gaps] = await sql<{ n: string }[]>`
      select count(*)::text as n from service s
       where s.published_at is not null
         and (not exists (select 1 from service_room_type_compat c
                           where c.service_style = s.style
                             and c.service_treatment_key = s.treatment_key)
           or not exists (select 1 from service_resource_shape h
                           where h.service_style = s.style
                             and h.service_treatment_key = s.treatment_key)
           or not exists (select 1 from service_variant v
                           where v.service_id = s.id and v.gross_price_fils > 0))
    `
    expect(Number(gaps?.n)).toBe(0)
  })

  it('refuses to publish a service with no priced duration, which is why order matters', async () => {
    const refusal = await probe(async (tx) => {
      await tx`insert into service (style, treatment_key, slug, internal_name,
                 public_display_name, turnaround_minutes, display_order)
               values ('asian', 'bcat06_probe', 'bcat06-probe', 'Probe', 'Normal Massage (Asian)', 20, 90)`
      await tx`insert into service_room_type_compat (service_style, service_treatment_key, room_type)
               values ('asian', 'bcat06_probe', 'standard')`
      await tx`insert into service_resource_shape (service_style, service_treatment_key, shape,
                 therapists_required, rooms_required, min_room_capacity, required_room_type,
                 therapist_buffer_minutes)
               values ('asian', 'bcat06_probe', 'solo', 1, 1, 1, 'standard', 10)`
      try {
        await tx`update service set published_at = now() where treatment_key = 'bcat06_probe'`
        return 'accepted'
      } catch (err) {
        return constraintOf(err)
      }
    })
    expect(refusal).toContain('service_publish_without_priced_variant')
  })
})

describe('every public display name passes the compliance lexicon', () => {
  it('under the regulatory_profile row actually in force', async () => {
    const names = await sql<{ public_display_name: string }[]>`
      select public_display_name from service order by display_order
    `
    expect(names).toHaveLength(8)
    for (const { public_display_name: name } of names) {
      expect(lintPublicDisplayName(name, policy), `"${name}"`).toEqual([])
    }
    // The three price-on-request labels are public too: they appear on a menu and in a quote.
    const labels = await sql<{ menu_label: string }[]>`select menu_label from price_on_request`
    expect(labels).toHaveLength(3)
    for (const { menu_label: label } of labels) {
      expect(lintPublicDisplayName(label, policy), `"${label}"`).toEqual([])
    }
  })

  it('and the lint is not permitting everything, which is the only way that could be vacuous', () => {
    // Two controls, one per half of the lexicon. Without them "every name passes" is also what a lint
    // with an empty term list reports.
    expect(() =>
      assertPublicDisplayNameCompliant('Therapeutic Deep Tissue Treatment', policy),
    ).toThrow()
    try {
      assertPublicDisplayNameCompliant('Asian Ladies Massage', policy)
      throw new Error('the lexicon accepted a style attached to a person')
    } catch (err) {
      expect(refusedRulesOf(err)).toContain('style_as_therapist_attribute')
    }
    // The seeded name it would be easiest to break: the style belongs to the treatment, in brackets.
    expect(lintPublicDisplayName('Normal Massage (Asian)', policy)).toEqual([])
  })

  it('and the seed refuses to publish a name it was given no lint for', async () => {
    // Fail closed. The plausible defect is a caller that forgot the lint, and an unlinted public name is
    // indistinguishable from a compliant one until an inspector reads it.
    await expect(
      seedCatalogue(sql, { lint: undefined as unknown as (name: string) => void }),
    ).rejects.toThrow(/public_display_name_unlinted/)
    expect(() =>
      assertPublicDisplayNameLinted('Normal Massage (Asian)', null as unknown as () => void),
    ).toThrow(/public_display_name_unlinted/)
  })
})

describe('the premises row is docs/13 §2 and §3', () => {
  it('carries the address and the two numbers the two sources agree on', async () => {
    const [row] = await sql<
      {
        display_name: string
        address_line_1: string
        address_line_2: string | null
        floor: string | null
        area: string
        emirate: string
        phone_landline: string | null
        phone_mobile: string | null
        parking_notes: string | null
        timezone: string
      }[]
    >`select display_name, address_line_1, address_line_2, floor, area, emirate,
             phone_landline, phone_mobile, parking_notes, timezone
        from premises where id = 1`
    expect(row?.address_line_1).toBe(PREMISES_NAP.addressLine1)
    expect(row?.address_line_2).toBe(PREMISES_NAP.addressLine2)
    expect(row?.floor).toBe(PREMISES_NAP.floor)
    expect(row?.area).toBe(PREMISES_NAP.area)
    expect(row?.emirate).toBe(PREMISES_NAP.emirate)
    expect(row?.phone_landline).toBe(PREMISES_NAP.phoneLandline)
    expect(row?.phone_mobile).toBe(PREMISES_NAP.phoneMobile)
    expect(row?.parking_notes).toBe(PREMISES_NAP.parkingNotes)
    expect(row?.timezone).toBe('Asia/Dubai')
    // The trading name, spelled once. docs/13 §1 gives it and 0026 snapshots it onto every invoice, so
    // the premises row and the legal entity must not disagree about it.
    expect(row?.display_name).toBe(LEGAL_ENTITY_SEED.tradingName)
  })

  it('leaves every field docs/13 does not state NULL rather than plausible', async () => {
    const [row] = await sql<Record<string, string | null>[]>`
      select po_box, makani_number, latitude::text as latitude, longitude::text as longitude,
             plus_code, google_place_id, email, directions_notes
        from premises where id = 1
    `
    for (const [column, value] of Object.entries(row ?? {})) {
      expect(value, `docs/13 states no ${column}, so it must be NULL`).toBeNull()
    }
  })

  it('holds a WhatsApp placeholder both layers refuse, because docs/13 §3 shows two numbers', async () => {
    const [row] = await sql<{ whatsapp: string | null; flagged: boolean }[]>`
      select phone_whatsapp as whatsapp, is_placeholder_text(phone_whatsapp) as flagged
        from premises where id = 1
    `
    expect(row?.whatsapp).toBe(WHATSAPP_PENDING)
    // SQL and TypeScript agree, which they have to: the CHECK holds for a psql session and the
    // application has to explain the refusal before it attempts a write.
    expect(row?.flagged).toBe(true)
    expect(isPlaceholderText(row?.whatsapp)).toBe(true)
    // The control. The two numbers docs/13 agrees on are NOT placeholders, or "everything is refused"
    // would be indistinguishable from this assertion.
    const [real] = await sql<{ landline: boolean; mobile: boolean }[]>`
      select is_placeholder_text(phone_landline) as landline,
             is_placeholder_text(phone_mobile) as mobile
        from premises where id = 1
    `
    expect(real?.landline).toBe(false)
    expect(real?.mobile).toBe(false)
    expect(isPlaceholderText(PREMISES_NAP.phoneLandline)).toBe(false)
    expect(isPlaceholderText(PREMISES_NAP.phoneMobile)).toBe(false)
  })

  it('trades 11:00–02:00 on all seven days, with crosses_midnight generated true', async () => {
    const rows = await sql<
      { day_of_week: number; open_time: string; close_time: string; crosses_midnight: boolean }[]
    >`select day_of_week, open_time::text as open_time, close_time::text as close_time,
             crosses_midnight from premises_hours order by day_of_week`
    expect(rows).toHaveLength(7)
    for (const row of rows) {
      expect(row.open_time).toBe(`${TRADING_OPEN_TIME}:00`)
      expect(row.close_time).toBe(`${TRADING_CLOSE_TIME}:00`)
      expect(row.crosses_midnight).toBe(true)
    }
    // The fixture clock places the demo appointments against the same window. Two spellings of the
    // trading hours is a fixture whose bookings fall outside the hours the database reports.
    expect(TRADING_OPEN_TIME).toBe(FIXTURE_OPEN)
    expect(TRADING_CLOSE_TIME).toBe(FIXTURE_CLOSE)
  })

  it('leaves the legal entity exactly as 0026 seeded it, placeholder TRN included', async () => {
    const [row] = await sql<
      {
        legal_name: string
        trading_name: string
        trn: string | null
        trade_licence_number: string | null
        licensing_authority: string
        emirate: string
      }[]
    >`select legal_name, trading_name, trn, trade_licence_number, licensing_authority, emirate
        from legal_entity where id = 1`
    expect(row?.legal_name).toBe(LEGAL_ENTITY_SEED.legalName)
    expect(row?.trading_name).toBe(LEGAL_ENTITY_SEED.tradingName)
    expect(row?.licensing_authority).toBe('ADDED')
    expect(row?.emirate).toBe('Abu Dhabi')
    // The seed's declared TRN and the migration's are the same string, and it is the one core refuses.
    // That invoice issuance itself refuses it is asserted by invoice-document.itest.ts against this
    // same row; duplicating it here would be a second place for that claim to be weakened.
    expect(LEGAL_ENTITY_SEED.trn).toBe(PLACEHOLDER_TRN)
    expect(row?.trn).toBe(PLACEHOLDER_TRN)
    // Y1-trn covers the licence number too, and docs/13 §1 marks it [CONFIRM]. NULL, not invented.
    expect(row?.trade_licence_number).toBeNull()
  })
})

describe('the room inventory, and the Four Hands footprint it cannot hold', () => {
  it('is 3 standard, 1 couples at capacity 2 and 1 wet — the Y8-rooms stub, unchanged', async () => {
    const rows = await sql<{ room_type: string; capacity: number; n: string }[]>`
      select room_type::text as room_type, capacity, count(*)::text as n
        from rooms where is_bookable group by room_type, capacity order by room_type, capacity
    `
    expect(rows).toEqual([
      { room_type: 'couples', capacity: 2, n: '1' },
      { room_type: 'standard', capacity: 1, n: '3' },
      { room_type: 'wet', capacity: 1, n: '1' },
    ])
  })

  it('gives every one of the 8 services at least one bookable room', async () => {
    // `service_room_type_compat` has no fall-back: zero rows means zero bookable rooms, which reads as
    // "no availability" for ever rather than as an error. So the claim is about all 8, not about the
    // rows that happen to exist.
    const [empty] = await sql<{ n: string }[]>`
      select count(*)::text as n from service s
       where not exists (select 1 from service_bookable_room b
                          where b.service_style = s.style
                            and b.service_treatment_key = s.treatment_key)
    `
    expect(Number(empty?.n)).toBe(0)
    // And the load-bearing restriction is still a restriction: the Morocco Bath resolves to the wet
    // room and nothing else. Without this, "every service has a room" is satisfied by a compatibility
    // table that permits everything.
    const wetOnly = await sql<{ room_code: string }[]>`
      select room_code from service_bookable_room
       where service_treatment_key = 'morocco_bath_jacuzzi' order by room_code
    `
    expect(wetOnly.map((r) => r.room_code)).toEqual(['room-wet', 'room-wet'])
  })

  it('records the Four Hands footprint docs/13 states, which no seeded room can hold', async () => {
    // docs/13 §4: Four Hands is "2 therapists, 1 standard room, 1 client". One client, so
    // min_room_capacity is 1 and 0017 is right. But 0024 stores one appointment ROW per therapist and
    // its deferred trigger counts ROWS against rooms.capacity, so a Four Hands booking peaks at 2 in a
    // capacity-1 room and the second row is refused at COMMIT with room_over_capacity.
    //
    // Both halves are asserted as the facts they are, and neither is worked around. docs/13 §8 lists
    // "room count and room types" as still unknown, so there is no measured inventory to seed a
    // two-place standard room from, and inventing one would be inventing an inventory to make a test
    // pass — and would also mean a capacity-2 standard room into which the scheduler could put two
    // unrelated clients. Resolving it belongs to B-AVAIL-06, which moves the count off "appointment
    // rows" onto a per-booking places figure. Tracked under Y8-rooms.
    //
    // This assertion is the tripwire: if a two-place standard room ever appears, it appears here.
    const shapes = await sql<{ min_room_capacity: number; therapists_required: number }[]>`
      select min_room_capacity, therapists_required from service_resource_shape
       where shape = 'four_hands'
    `
    expect(shapes).toHaveLength(4)
    for (const shape of shapes) {
      expect(shape.therapists_required).toBe(2)
      expect(shape.min_room_capacity).toBe(1)
    }
    const [twoPlaceStandard] = await sql<{ n: string }[]>`
      select count(*)::text as n from rooms where room_type = 'standard' and capacity >= 2
    `
    expect(Number(twoPlaceStandard?.n)).toBe(0)
    // The couples footprint, by contrast, has a room: two clients, capacity 2, and one such room.
    const [couplesRoom] = await sql<{ n: string }[]>`
      select count(*)::text as n from rooms where room_type = 'couples' and capacity >= 2
    `
    expect(Number(couplesRoom?.n)).toBe(1)
  })
})

describe('the three price-on-request offerings', () => {
  it('are recorded with no price, a stated reason and an open question', async () => {
    const rows = await sql<
      {
        menu_label: string
        resource_requirement: string
        modelled_as: string
        shape: string | null
        is_provisional: boolean
        provisional_note: string
        open_question_id: string
      }[]
    >`select menu_label, resource_requirement, modelled_as::text as modelled_as,
             shape::text as shape, is_provisional, provisional_note, open_question_id
        from price_on_request order by menu_label`
    expect(rows.map((r) => r.menu_label)).toEqual([
      'Couple Massage',
      'Four Hands Massage',
      'Full Body Shaving',
    ])
    for (const row of rows) {
      expect(row.is_provisional).toBe(true)
      expect(row.open_question_id).toBe('Y9-poa-prices')
      expect(row.provisional_note).toContain('price on request')
      expect(row.resource_requirement.length).toBeGreaterThan(10)
    }
    // No price column exists at all — the absence is what 0032 is for. Asserted against the catalogue
    // rather than the seed object, because a later migration could add one.
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'price_on_request'
    `
    for (const { column_name: column } of columns) {
      expect(/price|fils|amount|aed/i.test(column), `price_on_request.${column}`).toBe(false)
    }
    // And the seed module and the rows agree, so a corrected note reaches the database.
    expect(rows.map((r) => r.menu_label).sort()).toEqual(
      PRICE_ON_REQUEST_SEED.map((i) => i.menuLabel).sort(),
    )
  })

  it('cannot be marked confirmed, because there is nowhere to put the answer', async () => {
    // The answer arrives as ordinary catalogue data and DELETES the row. A cleared flag would mean the
    // question had left the Unconfirmed Assumptions panel while still being unanswered.
    const refusal = await probe(async (tx) => {
      try {
        await tx`update price_on_request set is_provisional = false`
        return 'accepted'
      } catch (err) {
        return constraintOf(err)
      }
    })
    expect(refusal).toContain('price_on_request_row_is_always_unanswered')

    // The control: the row IS deletable, which is how Y9-poa-prices closes. Without it, the refusal
    // above is indistinguishable from a table nothing can be done to.
    const deleted = await probe(async (tx) => {
      const rows = await tx`delete from price_on_request
                             where menu_label = 'Full Body Shaving' returning menu_label`
      return rows.length
    })
    expect(deleted).toBe(1)
  })

  it('refuses a label that is itself a stand-in, and an open question nobody can look up', async () => {
    const placeholderLabel = await probe(async (tx) => {
      try {
        await tx`insert into price_on_request (menu_label, resource_requirement, modelled_as,
                   provisional_note, open_question_id)
                 values ('Treatment TBC', 'two therapists', 'not_modelled', 'no figure',
                         'Y9-poa-prices')`
        return 'accepted'
      } catch (err) {
        return constraintOf(err)
      }
    })
    expect(placeholderLabel).toContain('price_on_request_menu_label_not_placeholder')

    const freeTextQuestion = await probe(async (tx) => {
      try {
        await tx`insert into price_on_request (menu_label, resource_requirement, modelled_as,
                   provisional_note, open_question_id)
                 values ('Head Massage', 'one therapist', 'not_modelled', 'no figure',
                         'ask the owner')`
        return 'accepted'
      } catch (err) {
        return constraintOf(err)
      }
    })
    expect(freeTextQuestion).toContain('price_on_request_names_an_open_question')

    const shapeWithoutModelling = await probe(async (tx) => {
      try {
        await tx`insert into price_on_request (menu_label, resource_requirement, modelled_as, shape,
                   provisional_note, open_question_id)
                 values ('Head Massage', 'one therapist', 'not_modelled', 'couple', 'no figure',
                         'Y9-poa-prices')`
        return 'accepted'
      } catch (err) {
        return constraintOf(err)
      }
    })
    expect(shapeWithoutModelling).toContain('price_on_request_shape_matches_modelling')

    // The control for all three: a legitimate row inserts. Otherwise the refusals above are satisfied
    // by a table nothing can be written to at all.
    const accepted = await probe(async (tx) => {
      const rows = await tx`insert into price_on_request (menu_label, resource_requirement,
                   modelled_as, shape, provisional_note, open_question_id)
                 values ('Head Massage', 'one therapist, one standard room',
                         'service_resource_shape', 'solo', 'no figure stated', 'Y9-poa-prices')
                 returning menu_label`
      return rows.length
    })
    expect(accepted).toBe(1)
  })
})

describe('the Unconfirmed Assumptions query returns every unanswered value', () => {
  it('including all three price-on-request offerings', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const byPriceOnRequest = rows.filter((row) => row.source === 'price_on_request')
    expect(byPriceOnRequest.map((row) => row.reference).sort()).toEqual([
      'Couple Massage',
      'Four Hands Massage',
      'Full Body Shaving',
    ])
    for (const row of byPriceOnRequest) {
      expect(row.openQuestionId).toBe('Y9-poa-prices')
      expect(row.note ?? '').not.toBe('')
    }
  })

  it('and the two singletons whose columns stand in for an answer', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const find = (source: string, reference: string) =>
      rows.find((row) => row.source === source && row.reference === reference)
    expect(find('premises', 'phone_whatsapp')?.openQuestionId).toBe('Y1-nap')
    expect(find('legal_entity', 'trn')?.openQuestionId).toBe('Y1-trn')
    expect(find('legal_entity', 'trade_licence_number')?.openQuestionId).toBe('Y1-trn')
    // The control: the columns docs/13 DOES answer are absent from the panel. Without it, a query that
    // listed every column of both singletons would pass.
    expect(find('premises', 'phone_landline')).toBeUndefined()
    expect(find('premises', 'address_line_1')).toBeUndefined()
    expect(find('legal_entity', 'legal_name')).toBeUndefined()
  })

  it('and the catalogue rows four migrations said it would read', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const sources = new Set(rows.map((row) => row.source))
    // 0012, 0017 and 0032 each carry the provenance trio and each say the panel reads it the way it
    // reads app_setting. Until this unit, nothing did.
    expect(sources.has('service')).toBe(true)
    expect(sources.has('service_resource_shape')).toBe(true)
    expect(sources.has('service_room_type_compat')).toBe(true)
    expect(sources.has('price_on_request')).toBe(true)
    // Every row names a question that can be looked up, and none is left unexplained.
    for (const row of rows) {
      expect(row.openQuestionId, `${row.source}/${row.reference}`).toMatch(
        /^Y[0-9]+-[a-z][a-z0-9-]*$/i,
      )
    }
    // The control: a row whose flag is cleared leaves the panel. Otherwise "the panel lists them" is
    // satisfied by a query with no WHERE clause.
    const afterConfirming = await probe(async (tx) => {
      await tx`update service set is_provisional = false, open_question_id = null,
                 provisional_note = null where treatment_key = 'morocco_bath_jacuzzi'`
      const listed = await unconfirmedAssumptionRows(tx)
      return listed.filter((row) => row.source === 'service').length
    })
    expect(afterConfirming).toBe(6)
  })
})

describe('seeding twice from clean is byte-identical (H03, extended)', () => {
  /** The catalogue, premises, rooms and price-on-request rows as one comparable string per row. */
  async function snapshot() {
    const variants = await sql<{ row: string }[]>`
      select (s.style || '|' || s.treatment_key || '|' || v.duration_minutes || '|' ||
              v.gross_price_fils || '|' || v.is_provisional) as row
        from service_variant v join service s on s.id = v.service_id
       order by s.style, s.treatment_key, v.duration_minutes
    `
    const services = await sql<{ row: string }[]>`
      select (style || '|' || treatment_key || '|' || slug || '|' || public_display_name || '|' ||
              turnaround_minutes || '|' || (published_at is not null) || '|' ||
              coalesce(published_at::text, '-') || '|' || coalesce(archived_at::text, '-')) as row
        from service order by display_order, id
    `
    const premises = await sql<{ row: string }[]>`
      select (display_name || '|' || address_line_1 || '|' || coalesce(address_line_2, '-') || '|' ||
              coalesce(floor, '-') || '|' || area || '|' || coalesce(phone_landline, '-') || '|' ||
              coalesce(phone_mobile, '-') || '|' || coalesce(phone_whatsapp, '-')) as row
        from premises order by id
    `
    const rooms = await sql<{ row: string }[]>`
      select (code || '|' || room_type || '|' || capacity || '|' || is_bookable) as row
        from rooms order by display_order, code
    `
    const onRequest = await sql<{ row: string }[]>`
      select (menu_label || '|' || modelled_as || '|' || coalesce(shape::text, '-') || '|' ||
              is_provisional || '|' || open_question_id || '|' || created_at::text) as row
        from price_on_request order by menu_label
    `
    return {
      variants: variants.map((r) => r.row),
      services: services.map((r) => r.row),
      premises: premises.map((r) => r.row),
      rooms: rooms.map((r) => r.row),
      onRequest: onRequest.map((r) => r.row),
    }
  }

  it('writes the same rows on a second run, timestamps included', async () => {
    const salon = generateSalon()
    await loadSalon(sql, salon)
    const first = await snapshot()
    await loadSalon(sql, salon)
    const second = await snapshot()
    // `published_at` and `created_at` are in the snapshot deliberately. A loader that re-published or
    // re-inserted would still produce equal *values* everywhere else, and the one thing that would
    // change is the instant — which is exactly what "wrote nothing the second time" means.
    expect(second).toEqual(first)
    expect(first.variants).toHaveLength(DOCS_13_PRICE_POINT_COUNT)
    expect(first.services).toHaveLength(8)
    expect(first.rooms).toHaveLength(5)
    expect(first.onRequest).toHaveLength(3)
  })
})
