import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createConnection, type Sql } from '../connection.ts'
import { withUnitOfWork } from '../tx.ts'
import {
  archiveService,
  CATALOGUE_SQLSTATE,
  catalogueError,
  changeVariantPrice,
  deleteService,
  listBookableServices,
  publishService,
  readService,
  refusalOf,
  renameServiceSlug,
  resolveServicePath,
  servicePath,
  setInternalName,
  setPublicDisplayName,
  TREATMENTS_INDEX_PATH,
} from './catalogue.ts'

/**
 * B-CAT-05 — the catalogue guard rails against real PostgreSQL.
 *
 * Every rule this file asserts is a database rule: two deferred constraint triggers, one immediate
 * trigger raising three distinct codes, a CHECK and a foreign key two levels down. A mock would assert
 * the mock, and each of these exists precisely because an application-level check is not enough — the
 * CMS, a seed and a `psql` prompt all write this schema.
 *
 * The file is `.itest.ts` and not `.test.ts`: `packages/db` has no database in the unit runner, so a
 * database-backed suite here must be an integration test or it never connects. Same correction as
 * `otp.itest.ts` (B-LIFE-02) and `booking-constraints.itest.ts` (B-AVAIL-01); the manifest's file list
 * named `catalogue.test.ts`, and both files now exist — the pure half there, this half here.
 *
 * Every probe is paired with a control. A guard rail that has never been seen to accept the legitimate
 * case is indistinguishable from a table nobody can write to (ADR 0003).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** Probe rows carry this prefix, so cleanup never touches the seeded catalogue. */
const PROBE = 'bcat05_probe'
const PROBE_SLUG = 'bcat05-probe'
/** A trading date far enough ahead that the fixture appointment is always in the future. */
const TRADING_DATE = '2099-05-01'
const at = (hhmm: string): string => `2099-05-01 ${hhmm}:00+00`
/** Phone-shaped, not a person. The customer is `Customer 0042` wherever it is displayed. */
const PROBE_PHONE = '+971500000143'
/** Therapists carry no display name; this is an id and nothing else (brief rule 10, ADR 0020). */
const THERAPIST = 'aaaaaaaa-0000-4000-8000-0000000c0501'
/** The actor every mutation runs as. A system label, because no person is being invented here. */
const ACTOR = { kind: 'system', label: 'B-CAT-05 itest' } as const

/** The gross the fixture appointment is quoted at, in integer fils (200.00 AED). */
const QUOTED_FILS = 20000
/**
 * The exact net/VAT split of that gross, which 0038 made NOT NULL on `appointment`.
 *
 * `net = roundHalfUp(gross x 10000 / 10500)` and `vat = gross - net`, so `net + vat = gross` exactly
 * (ADR 0007) and `appointment_price_split_exact` accepts it. Written out rather than computed here,
 * because a fixture that derived the figure with the same formula the constraint checks would assert
 * that the formula equals itself.
 */
const QUOTED_NET_FILS = 19048
const QUOTED_VAT_FILS = 952

let sql: Sql
let customerId: string
let roomId: string

/** The raw error a promise rejected with, or `null` when it resolved. */
async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return null
  } catch (error) {
    return error
  }
}

/** The SQLSTATE and message of a rejected promise, or a marker that it was not rejected. */
async function stateOf(
  promise: Promise<unknown>,
): Promise<{ code: string | undefined; message: string; constraint: string | undefined }> {
  try {
    await promise
    return { code: undefined, message: 'the statement succeeded', constraint: undefined }
  } catch (error) {
    const err = error as { code?: unknown; constraint_name?: unknown }
    return {
      code: typeof err.code === 'string' ? err.code : undefined,
      constraint: typeof err.constraint_name === 'string' ? err.constraint_name : undefined,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

interface ProbeOptions {
  /** `false` leaves the service with no room-type compatibility row. */
  readonly compat?: boolean
  readonly shape?: boolean
  readonly variant?: boolean
  readonly published?: boolean
}

/** A service of this file's own, built to order so each publish precondition can be missing alone. */
async function makeProbeService(
  key: string,
  slug: string,
  options: ProbeOptions = {},
): Promise<{ serviceId: string; variantId: string | null }> {
  const treatmentKey = `${PROBE}_${key}`
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes,
       display_order)
    values ('asian', ${treatmentKey}, ${slug}, ${'Probe'}, ${'Normal Massage (Asian)'}, 20, 99)
    returning id
  `
  const serviceId = service?.id as string
  if (options.compat !== false) {
    await sql`
      insert into service_room_type_compat (service_style, service_treatment_key, room_type)
      values ('asian', ${treatmentKey}, 'standard')
    `
  }
  if (options.shape !== false) {
    // `required_room_type` is NULL when this service has no compatibility row, because
    // `service_resource_shape_room_type_compat_fk` would otherwise refuse the shape — a shape may only
    // name a room type the service is compatible with (0017). Which is the answer to a question this
    // fixture had to ask: the no-compat-row case is reachable WITH a resource shape, so the publish
    // trigger's first refusal is not an artefact of the second precondition also being missing.
    const requiredRoomType = options.compat === false ? null : 'standard'
    await sql`
      insert into service_resource_shape
        (service_style, service_treatment_key, shape, therapists_required, rooms_required,
         min_room_capacity, required_room_type, therapist_buffer_minutes)
      values ('asian', ${treatmentKey}, 'solo', 1, 1, 1, ${requiredRoomType}, 10)
    `
  }
  let variantId: string | null = null
  if (options.variant !== false) {
    const [variant] = await sql<{ id: string }[]>`
      insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
      values (${serviceId}, 60, ${QUOTED_FILS}, ${'B-CAT-05 fixture'})
      returning id
    `
    variantId = variant?.id as string
  }
  if (options.published === true) {
    await sql`update service set published_at = now() where id = ${serviceId}`
  }
  return { serviceId, variantId }
}

/** A confirmed appointment in the future, against a probe variant. */
async function bookAppointment(variantId: string): Promise<string> {
  const [booking] = await sql<{ id: string }[]>`
    insert into booking (customer_id, source) values (${customerId}, 'front_desk') returning id
  `
  const [appointment] = await sql<{ id: string }[]>`
    insert into appointment
      (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
       turnaround_minutes, therapist_buffer_minutes, gross_price_fils, net_fils, vat_fils)
    values (
      ${booking?.id as string}, ${TRADING_DATE}, ${variantId}, 'solo', ${THERAPIST}, ${roomId},
      ${`[${at('19')},${at('20')})`}::tstzrange, 'confirmed', 20, 10, ${QUOTED_FILS},
      ${QUOTED_NET_FILS}, ${QUOTED_VAT_FILS}
    )
    returning id
  `
  return appointment?.id as string
}

/** Audit rows for one entity — read as a DELTA by every caller, never as a total (ADR 0008). */
async function auditRows(
  entityId: string,
): Promise<readonly { action: string; before: unknown; after: unknown }[]> {
  const rows = await sql<{ action: string; before_state: unknown; after_state: unknown }[]>`
    select action, before_state, after_state from audit_event
     where entity_id = ${entityId} order by occurred_at, action
  `
  return rows.map((row) => ({
    action: row.action,
    before: row.before_state,
    after: row.after_state,
  }))
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const [customer] = await sql<{ id: string }[]>`
    insert into customer (phone_e164, created_via) values (${PROBE_PHONE}, 'guest_booking')
    on conflict (phone_e164) do update set created_via = excluded.created_via
    returning id
  `
  customerId = customer?.id as string
  await sql`
    insert into business_day (trading_date, opens_at, closes_at, source)
    values (${TRADING_DATE}, ${at('07')}::timestamptz, ${at('22')}::timestamptz, 'weekly')
    on conflict (trading_date) do nothing
  `
  const [room] = await sql<{ id: string }[]>`
    select id from rooms where code = 'room-1'
  `
  roomId = room?.id as string
})

afterAll(async () => {
  // audit_event is append-only (ADR 0008): nothing here deletes from it, and the assertions above are
  // deltas for exactly that reason.
  await sql.unsafe('truncate booking_idempotency, appointment_status_history, appointment, booking')
  await sql`delete from redirect_map where source_path like ${`/treatments/${PROBE_SLUG}%`}`
  await sql`delete from redirect_map where target_path like ${`/treatments/${PROBE_SLUG}%`}`
  await sql`delete from service where treatment_key like ${`${PROBE}%`}`
  await sql`delete from service_room_type_compat where service_treatment_key like ${`${PROBE}%`}`
  await sql`delete from business_day where trading_date = ${TRADING_DATE}`
  await sql`delete from customer where phone_e164 = ${PROBE_PHONE}`
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql.unsafe('truncate booking_idempotency, appointment_status_history, appointment, booking')
  await sql`delete from redirect_map where source_path like ${`/treatments/${PROBE_SLUG}%`}`
  await sql`delete from redirect_map where target_path like ${`/treatments/${PROBE_SLUG}%`}`
  await sql`delete from service where treatment_key like ${`${PROBE}%`}`
  await sql`delete from service_room_type_compat where service_treatment_key like ${`${PROBE}%`}`
})

describe('acceptance — archiving a booked service succeeds; deleting it does not', () => {
  it('archives it, takes it out of bookable availability, and leaves the appointment alone', async () => {
    const { serviceId, variantId } = await makeProbeService('archive', `${PROBE_SLUG}-archive`, {
      published: true,
    })
    const appointmentId = await bookAppointment(variantId as string)

    const bookableBefore = await listBookableServices(sql)
    expect(bookableBefore.map((s) => s.id)).toContain(serviceId)

    await withUnitOfWork(sql, ACTOR, (uow) => archiveService(uow, { serviceId }))

    const after = await readService(sql, serviceId)
    expect(after?.archivedAt).not.toBeNull()
    // Archiving withdraws publication in the same statement; the CHECK would refuse the alternative.
    expect(after?.publishedAt).toBeNull()
    const bookableAfter = await listBookableServices(sql)
    expect(bookableAfter.map((s) => s.id)).not.toContain(serviceId)

    // The appointment is untouched, at the price it was quoted. That is the whole reason archive
    // exists: the guest who booked last week is still booked.
    const [appointment] = await sql<{ id: string; gross_price_fils: string }[]>`
      select id, gross_price_fils from appointment where id = ${appointmentId}
    `
    expect(appointment?.id).toBe(appointmentId)
    expect(Number(appointment?.gross_price_fils)).toBe(QUOTED_FILS)
  })

  it('refuses the DELETE by the appointment foreign key, as a named domain error', async () => {
    const { serviceId, variantId } = await makeProbeService('delete', `${PROBE_SLUG}-delete`)
    await bookAppointment(variantId as string)

    const failure = await errorOf(
      withUnitOfWork(sql, ACTOR, (uow) => deleteService(uow, serviceId)),
    )
    // 23503 from `appointment_service_variant_id_fkey`: the delete cascades into service_variant and
    // is refused by the grandchild, which is the ON DELETE RESTRICT of 0024. Asserted by the refusal
    // NAME rather than by "it threw", because a typo in the fixture also throws.
    expect(refusalOf(failure)).toBe('service_has_appointments')
    expect((failure as Error).message).toContain('Archive it instead')

    const stillThere = await readService(sql, serviceId)
    expect(stillThere?.id).toBe(serviceId)
  })

  it('carries the SQLSTATE and the constraint that make that refusal meaningful', async () => {
    const { serviceId, variantId } = await makeProbeService('fk', `${PROBE_SLUG}-fk`)
    await bookAppointment(variantId as string)
    const raw = await stateOf(sql`delete from service where id = ${serviceId}`)
    expect(raw.code).toBe('23503')
    expect(raw.constraint).toBe('appointment_service_variant_id_fkey')
    // The translation is what a caller branches on, and it must come from that pair rather than from
    // the message: a 23503 on another constraint is a different problem entirely.
    expect(
      catalogueError({ code: raw.code, constraint_name: raw.constraint })?.details['refusal'],
    ).toBe('service_has_appointments')
  })

  it('control: a service nobody ever booked really can be deleted', async () => {
    // Without this the refusal above is satisfied by a table from which nothing can ever be deleted.
    const { serviceId } = await makeProbeService('unbooked', `${PROBE_SLUG}-unbooked`)
    const deleted = await withUnitOfWork(sql, ACTOR, (uow) => deleteService(uow, serviceId))
    expect(deleted.id).toBe(serviceId)
    expect(await readService(sql, serviceId)).toBeNull()
  })
})

describe('acceptance — a slug change writes the 301 in the same transaction', () => {
  it('moves the slug, writes (old_path, new_path, 301) and resolves the old path in one hop', async () => {
    const { serviceId } = await makeProbeService('slug', `${PROBE_SLUG}-slug`, { published: true })
    const oldPath = servicePath(`${PROBE_SLUG}-slug`)
    const newPath = servicePath(`${PROBE_SLUG}-renamed`)

    const result = await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-renamed` }),
    )
    expect(result.redirect).toEqual({ sourcePath: oldPath, targetPath: newPath })

    const [row] = await sql<{ target_path: string; status_code: number; reason: string }[]>`
      select target_path, status_code, reason from redirect_map where source_path = ${oldPath}
    `
    expect(row?.target_path).toBe(newPath)
    expect(Number(row?.status_code)).toBe(301)
    expect(row?.reason).toBe('slug change')

    // The pair the route serves: the old path is a redirect, and what it points at resolves.
    expect(await resolveServicePath(sql, oldPath)).toEqual({
      kind: 'redirect',
      target: newPath,
      status: 301,
    })
    const landed = await resolveServicePath(sql, newPath)
    expect(landed.kind).toBe('service')
  })

  it('refuses a rename that leaves no redirect — at COMMIT, by name', async () => {
    const { serviceId } = await makeProbeService('bare', `${PROBE_SLUG}-bare`)
    const failure = await stateOf(
      sql.begin(async (tx) => {
        // The UPDATE itself must succeed: the trigger is DEFERRED precisely so the correct sequence,
        // which is invalid in the middle, is not refused halfway through.
        await tx`update service set slug = ${`${PROBE_SLUG}-bare-2`} where id = ${serviceId}`
        const [read] = await tx<
          { slug: string }[]
        >`select slug from service where id = ${serviceId}`
        expect(read?.slug).toBe(`${PROBE_SLUG}-bare-2`)
      }),
    )
    expect(failure.code).toBe(CATALOGUE_SQLSTATE.slugChangeWithoutRedirect)
    expect(catalogueError(failure)?.details['refusal']).toBe('slug_change_without_redirect')
    // Rolled back whole: the slug did not move.
    expect((await readService(sql, serviceId))?.slug).toBe(`${PROBE_SLUG}-bare`)
  })

  it('collapses a second rename to one hop instead of chaining', async () => {
    const { serviceId } = await makeProbeService('hop', `${PROBE_SLUG}-hop-a`)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-hop-b` }),
    )
    const second = await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-hop-c` }),
    )
    expect(second.collapsed).toEqual([servicePath(`${PROBE_SLUG}-hop-a`)])

    const rows = await sql<{ source_path: string; target_path: string }[]>`
      select source_path, target_path from redirect_map
       where source_path like ${`/treatments/${PROBE_SLUG}-hop%`} order by source_path
    `
    expect(rows).toEqual([
      {
        source_path: servicePath(`${PROBE_SLUG}-hop-a`),
        target_path: servicePath(`${PROBE_SLUG}-hop-c`),
      },
      {
        source_path: servicePath(`${PROBE_SLUG}-hop-b`),
        target_path: servicePath(`${PROBE_SLUG}-hop-c`),
      },
    ])

    // One hop, proven the way a crawler would: every target resolves to a service, and no target is
    // itself a source. A redirect to a redirect is a 404 with extra steps waiting for one more rename.
    for (const row of rows) {
      const landed = await resolveServicePath(sql, row.source_path)
      expect(landed).toEqual({
        kind: 'redirect',
        target: servicePath(`${PROBE_SLUG}-hop-c`),
        status: 301,
      })
      const destination = await resolveServicePath(sql, row.target_path)
      expect(destination.kind).toBe('service')
    }
  })

  it('refuses a chain written by hand, by name', async () => {
    const { serviceId } = await makeProbeService('chain', `${PROBE_SLUG}-chain-a`)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-chain-b` }),
    )
    // A -> B exists. Writing B -> C without retargeting A is the chain.
    const failure = await stateOf(
      sql.begin(async (tx) => {
        await tx`update service set slug = ${`${PROBE_SLUG}-chain-c`} where id = ${serviceId}`
        await tx`
          insert into redirect_map (source_path, target_path, reason)
          values (${servicePath(`${PROBE_SLUG}-chain-b`)},
                  ${servicePath(`${PROBE_SLUG}-chain-c`)}, 'by hand')
        `
      }),
    )
    expect(failure.code).toBe(CATALOGUE_SQLSTATE.redirectChainNotCollapsed)
    expect(catalogueError(failure)?.details['refusal']).toBe('redirect_chain_not_collapsed')
  })

  it('refuses a redirect to a slug nothing answers on, by name', async () => {
    const failure = await stateOf(sql`
      insert into redirect_map (source_path, target_path, reason)
      values (${servicePath(`${PROBE_SLUG}-nowhere`)},
              ${servicePath(`${PROBE_SLUG}-no-such-thing`)}, 'probe')
    `)
    expect(failure.code).toBe(CATALOGUE_SQLSTATE.redirectTargetUnresolved)
    expect(catalogueError(failure)?.details['refusal']).toBe('redirect_target_unresolved')
  })

  it('refuses a rename that leaves an existing redirect pointing at the retired path', async () => {
    const { serviceId } = await makeProbeService('dead', `${PROBE_SLUG}-dead-a`)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-dead-b` }),
    )
    // Renaming again while leaving A -> B alone: B stops resolving, so A costs a hop to a 404. The
    // rule that gets there first is the write-time chain check on the new 301 — A already points at
    // the path this row retires — and it is ZC006 rather than ZC005. Asserted as what actually
    // happens: a test that demanded ZC005 here would be asserting an ordering the schema does not
    // have, and the fix would have been to weaken the earlier guard.
    const failure = await stateOf(
      sql.begin(async (tx) => {
        await tx`update service set slug = ${`${PROBE_SLUG}-dead-c`} where id = ${serviceId}`
        await tx`
          insert into redirect_map (source_path, target_path, reason)
          values (${servicePath(`${PROBE_SLUG}-dead-b`)},
                  ${servicePath(`${PROBE_SLUG}-dead-c`)}, 'by hand')
        `
      }),
    )
    expect(failure.code).toBe(CATALOGUE_SQLSTATE.redirectChainNotCollapsed)
  })

  it('still refuses it at COMMIT when the write-time guard is not there to catch it first', async () => {
    // The deferred check is a backstop, and a backstop nothing has been seen to hit is not a backstop.
    // So the write-time trigger is removed for the length of this transaction — the same technique
    // B-AVAIL-01 used to prove the argument for its DEFERRED trigger by installing the IMMEDIATE
    // variant as a fixture — and the rename is refused anyway, from COMMIT, by name.
    const { serviceId } = await makeProbeService('backstop', `${PROBE_SLUG}-backstop-a`)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-backstop-b` }),
    )
    await sql.unsafe('alter table redirect_map disable trigger redirect_map_one_hop')
    try {
      const failure = await stateOf(
        sql.begin(async (tx) => {
          await tx`update service set slug = ${`${PROBE_SLUG}-backstop-c`} where id = ${serviceId}`
          await tx`
            insert into redirect_map (source_path, target_path, reason)
            values (${servicePath(`${PROBE_SLUG}-backstop-b`)},
                    ${servicePath(`${PROBE_SLUG}-backstop-c`)}, 'by hand')
          `
        }),
      )
      expect(failure.code).toBe(CATALOGUE_SQLSTATE.redirectTargetUnresolved)
      expect(catalogueError(failure)?.details['refusal']).toBe('redirect_target_unresolved')
    } finally {
      // In a finally, because a trigger left disabled would make every later case in this file pass
      // for the wrong reason — and the next reader would spend an hour on the wrong bug.
      await sql.unsafe('alter table redirect_map enable trigger redirect_map_one_hop')
    }
    const [enabled] = await sql<{ tgenabled: string }[]>`
      select tgenabled from pg_trigger where tgname = 'redirect_map_one_hop'
    `
    expect(enabled?.tgenabled).toBe('O')
  })

  it('refuses deleting a service that a redirect still points at', async () => {
    // The third way a target dies. Nothing points at a service the day it is created, so this is
    // reachable only after a rename — which is exactly when somebody decides to clean up.
    const { serviceId } = await makeProbeService('del2', `${PROBE_SLUG}-del2-a`)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-del2-b` }),
    )
    const failure = await stateOf(sql`delete from service where id = ${serviceId}`)
    expect(failure.code).toBe(CATALOGUE_SQLSTATE.redirectTargetUnresolved)
    expect((await readService(sql, serviceId))?.slug).toBe(`${PROBE_SLUG}-del2-b`)
  })

  it('retargets a redirect to the treatments index when its service is archived', async () => {
    const { serviceId } = await makeProbeService('arch', `${PROBE_SLUG}-arch-a`, {
      published: true,
    })
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-arch-b` }),
    )
    const archived = await withUnitOfWork(sql, ACTOR, (uow) => archiveService(uow, { serviceId }))
    expect(archived.retargeted).toEqual([servicePath(`${PROBE_SLUG}-arch-a`)])

    const resolution = await resolveServicePath(sql, servicePath(`${PROBE_SLUG}-arch-a`))
    expect(resolution).toEqual({ kind: 'redirect', target: TREATMENTS_INDEX_PATH, status: 301 })
    // And the archived service's own path answers nothing, rather than 301-ing to itself.
    expect(await resolveServicePath(sql, servicePath(`${PROBE_SLUG}-arch-b`))).toEqual({
      kind: 'not_found',
    })
  })

  it('refuses an archive that would leave a redirect pointing at the archived page', async () => {
    const { serviceId } = await makeProbeService('arch2', `${PROBE_SLUG}-arch2`, {
      published: true,
    })
    await sql`
      insert into redirect_map (source_path, target_path, reason)
      values ('/product-category/bcat05-probe', ${servicePath(`${PROBE_SLUG}-arch2`)}, 'probe')
    `
    const failure = await stateOf(
      sql`update service set archived_at = now(), published_at = null where id = ${serviceId}`,
    )
    expect(failure.code).toBe(CATALOGUE_SQLSTATE.redirectTargetUnresolved)
    await sql`delete from redirect_map where source_path = '/product-category/bcat05-probe'`
  })

  it('refuses a rename to the slug it already has, rather than writing a self-redirect', async () => {
    const { serviceId } = await makeProbeService('same', `${PROBE_SLUG}-same`)
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-same` }),
      ),
    ).rejects.toThrow(/infinite loop/)
  })

  it('releases the stale redirect when a slug is renamed back to one it used to have', async () => {
    // The case that found the bug: renaming A -> B and then B -> A left the A -> B row being
    // retargeted onto its own source, and the write-time chain check reported it as a chain against a
    // row that was itself. A redirect from a page that answers can never fire, so the row is dropped.
    const { serviceId } = await makeProbeService('back', `${PROBE_SLUG}-back-a`, {
      published: true,
    })
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-back-b` }),
    )
    const home = await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-back-a` }),
    )
    expect(home.released).toEqual([servicePath(`${PROBE_SLUG}-back-b`)])

    // The original path answers for itself again, and the one it was renamed to redirects to it.
    const live = await resolveServicePath(sql, servicePath(`${PROBE_SLUG}-back-a`))
    expect(live.kind).toBe('service')
    expect(await resolveServicePath(sql, servicePath(`${PROBE_SLUG}-back-b`))).toEqual({
      kind: 'redirect',
      target: servicePath(`${PROBE_SLUG}-back-a`),
      status: 301,
    })
  })

  it('refuses a redirect written from a page that still answers, by name', async () => {
    const { serviceId } = await makeProbeService('live', `${PROBE_SLUG}-live`, { published: true })
    const failure = await stateOf(sql`
      insert into redirect_map (source_path, target_path, reason)
      values (${servicePath(`${PROBE_SLUG}-live`)}, ${TREATMENTS_INDEX_PATH}, 'by hand')
    `)
    expect(failure.code).toBe(CATALOGUE_SQLSTATE.redirectSourceStillLive)
    expect(catalogueError(failure)?.details['refusal']).toBe('redirect_source_still_live')
    // Control: the same row is legitimate once the service is archived — which is how the archived
    // page gets its 301 to the treatments index (W-SITE-05).
    await withUnitOfWork(sql, ACTOR, (uow) => archiveService(uow, { serviceId }))
    const accepted = await stateOf(sql`
      insert into redirect_map (source_path, target_path, reason)
      values (${servicePath(`${PROBE_SLUG}-live`)}, ${TREATMENTS_INDEX_PATH}, 'archived')
    `)
    expect(accepted.code).toBeUndefined()
  })

  it('agrees with the SQL about what a treatment path is', async () => {
    // `servicePath` in TypeScript and `treatment_path()` in 0029 are two spellings of one prefix, and
    // the trigger validates what the repository writes. Two spellings that drifted apart would be a
    // redirect that silently stops matching, so the pair is asserted rather than assumed.
    const slug = `${PROBE_SLUG}-prefix`
    const [built] = await sql<{ path: string; extracted: string | null }[]>`
      select treatment_path(${slug}) as path, treatment_path_slug(${servicePath(slug)}) as extracted
    `
    expect(built?.path).toBe(servicePath(slug))
    expect(built?.extracted).toBe(slug)
    // And a path that is not a treatment page yields no slug, which is what exempts the treatments
    // index and W-SITE-09's legacy URLs from the live-service check.
    const [other] = await sql<{ extracted: string | null }[]>`
      select treatment_path_slug(${'/product-category/arabic-massage-abu-dhabi/'}) as extracted
    `
    expect(other?.extracted).toBeNull()
  })

  it('control: a legitimate redirect to a live treatment page is accepted', async () => {
    await makeProbeService('legit', `${PROBE_SLUG}-legit`, { published: true })
    await sql`
      insert into redirect_map (source_path, target_path, reason)
      values ('/product-tag/bcat05-probe', ${servicePath(`${PROBE_SLUG}-legit`)}, 'baseline import')
    `
    const resolution = await resolveServicePath(sql, '/product-tag/bcat05-probe')
    expect(resolution).toEqual({
      kind: 'redirect',
      target: servicePath(`${PROBE_SLUG}-legit`),
      status: 301,
    })
    await sql`delete from redirect_map where source_path = '/product-tag/bcat05-probe'`
  })
})

describe('acceptance — publishing is refused three distinct, named ways', () => {
  it('refuses a service no room type may deliver', async () => {
    const { serviceId } = await makeProbeService('pub1', `${PROBE_SLUG}-pub1`, { compat: false })
    const failure = await stateOf(
      withUnitOfWork(sql, ACTOR, (uow) => publishService(uow, serviceId)),
    )
    expect(failure.message).toContain('service_publish_without_compat_row')
    expect((await readService(sql, serviceId))?.publishedAt).toBeNull()
  })

  it('refuses a service with no resource shape', async () => {
    const { serviceId } = await makeProbeService('pub2', `${PROBE_SLUG}-pub2`, { shape: false })
    const failure = await stateOf(
      withUnitOfWork(sql, ACTOR, (uow) => publishService(uow, serviceId)),
    )
    expect(failure.message).toContain('service_publish_without_resource_shape')
  })

  it('refuses a service with no priced variant', async () => {
    const { serviceId } = await makeProbeService('pub3', `${PROBE_SLUG}-pub3`, { variant: false })
    const failure = await stateOf(
      withUnitOfWork(sql, ACTOR, (uow) => publishService(uow, serviceId)),
    )
    expect(failure.message).toContain('service_publish_without_priced_variant')
  })

  it('names the three with three distinct SQLSTATEs', async () => {
    // Three names and one code would be a single refusal wearing three messages: a caller could not
    // tell the owner which of the three to fix without matching on prose.
    const codes = new Set<string | undefined>()
    const shapes: readonly ProbeOptions[] = [
      { compat: false },
      { shape: false },
      { variant: false },
    ]
    for (const [index, options] of shapes.entries()) {
      const { serviceId } = await makeProbeService(
        `code${index}`,
        `${PROBE_SLUG}-code-${index}`,
        options,
      )
      const failure = await stateOf(
        sql`update service set published_at = now() where id = ${serviceId}`,
      )
      codes.add(failure.code)
    }
    expect(codes).toEqual(
      new Set([
        CATALOGUE_SQLSTATE.publishWithoutCompatRow,
        CATALOGUE_SQLSTATE.publishWithoutResourceShape,
        CATALOGUE_SQLSTATE.publishWithoutPricedVariant,
      ]),
    )
  })

  it('refuses publishing an archived service by the CHECK, not by a fourth trigger', async () => {
    const { serviceId } = await makeProbeService('pub4', `${PROBE_SLUG}-pub4`)
    await withUnitOfWork(sql, ACTOR, (uow) => archiveService(uow, { serviceId }))
    const failure = await stateOf(
      withUnitOfWork(sql, ACTOR, (uow) => publishService(uow, serviceId)),
    )
    expect(failure.message).toContain('service_archived_is_not_published')
  })

  it('control: a service with all three publishes, and appears in bookable availability', async () => {
    const { serviceId } = await makeProbeService('pub5', `${PROBE_SLUG}-pub5`)
    const published = await withUnitOfWork(sql, ACTOR, (uow) => publishService(uow, serviceId))
    expect(published.publishedAt).not.toBeNull()
    expect((await listBookableServices(sql)).map((s) => s.id)).toContain(serviceId)
  })

  it('control: an unrelated update of a published service is not re-validated', async () => {
    // The trigger fires on the transition only. Re-checking every update would refuse the very edit
    // that fixes a service which has since lost its last variant.
    const { serviceId, variantId } = await makeProbeService('pub6', `${PROBE_SLUG}-pub6`, {
      published: true,
    })
    await sql`delete from service_variant where id = ${variantId}`
    const touched = await stateOf(
      sql`update service set display_order = 98 where id = ${serviceId}`,
    )
    expect(touched.code).toBeUndefined()
  })
})

describe('acceptance — every catalogue mutation writes an audit_event with before and after', () => {
  it('records the price change as a delta, with the price in force before it', async () => {
    const { variantId } = await makeProbeService('audit1', `${PROBE_SLUG}-audit1`)
    const before = (await auditRows(variantId as string)).length
    await withUnitOfWork(sql, ACTOR, (uow) =>
      changeVariantPrice(uow, {
        serviceVariantId: variantId as string,
        grossPriceFils: 24000,
        label: 'B-CAT-05 rise',
        validFrom: '2099-01-01',
        validTo: null,
      }),
    )
    const rows = await auditRows(variantId as string)
    // A delta, never a total: audit_event is append-only and shared with every other unit's rows.
    expect(rows.length - before).toBe(1)
    const written = rows[rows.length - 1]
    expect(written?.action).toBe('catalogue.price.change')
    expect(written?.before).toMatchObject({ variantGrossPriceFils: QUOTED_FILS })
    expect(written?.after).toMatchObject({ grossPriceFils: 24000, validFrom: '2099-01-01' })
  })

  it('records the public display name, before and after', async () => {
    const { serviceId } = await makeProbeService('audit2', `${PROBE_SLUG}-audit2`)
    const before = (await auditRows(serviceId)).length
    await withUnitOfWork(sql, ACTOR, (uow) =>
      setPublicDisplayName(uow, {
        serviceId,
        publicDisplayName: 'Hot Oil / Balm Massage (Asian)',
        // The lint the real caller injects from @berelax/core. Here it is a pass-through, because what
        // this case asserts is the audit row; the lint itself is asserted in lexicon.test.ts and
        // against the live profile in packages/fixtures/src/catalogue-compliance.itest.ts.
        lint: () => undefined,
      }),
    )
    const rows = await auditRows(serviceId)
    expect(rows.length - before).toBe(1)
    expect(rows[rows.length - 1]).toMatchObject({
      action: 'catalogue.service.rename_public',
      before: { publicDisplayName: 'Normal Massage (Asian)' },
      after: { publicDisplayName: 'Hot Oil / Balm Massage (Asian)' },
    })
  })

  it('records the slug change, with the redirect it wrote', async () => {
    const { serviceId } = await makeProbeService('audit3', `${PROBE_SLUG}-audit3`)
    const before = (await auditRows(serviceId)).length
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-audit3-b` }),
    )
    const rows = await auditRows(serviceId)
    expect(rows.length - before).toBe(1)
    const written = rows[rows.length - 1]
    expect(written?.action).toBe('catalogue.service.rename_slug')
    expect(written?.before).toMatchObject({ slug: `${PROBE_SLUG}-audit3` })
    expect(written?.after).toMatchObject({
      slug: `${PROBE_SLUG}-audit3-b`,
      redirect: {
        sourcePath: servicePath(`${PROBE_SLUG}-audit3`),
        targetPath: servicePath(`${PROBE_SLUG}-audit3-b`),
        status: 301,
      },
    })
  })

  it('records the archive, with what it retargeted', async () => {
    const { serviceId } = await makeProbeService('audit4', `${PROBE_SLUG}-audit4`, {
      published: true,
    })
    const before = (await auditRows(serviceId)).length
    await withUnitOfWork(sql, ACTOR, (uow) => archiveService(uow, { serviceId }))
    const rows = await auditRows(serviceId)
    expect(rows.length - before).toBe(1)
    const written = rows[rows.length - 1]
    expect(written?.action).toBe('catalogue.service.archive')
    expect(written?.before).toMatchObject({ archivedAt: null })
    const archivedAfter = (written as { after: { archivedAt: string | null } }).after
    expect(archivedAfter.archivedAt).not.toBeNull()
  })

  it('rolls the audit row back with the mutation it describes', async () => {
    // The audit row and the change share a transaction (F06). An audit row for a change that did not
    // happen is as bad as a change with no audit row, and this is the case that proves which it is.
    const { serviceId } = await makeProbeService('audit5', `${PROBE_SLUG}-audit5`)
    const before = (await auditRows(serviceId)).length
    await stateOf(
      withUnitOfWork(sql, ACTOR, async (uow) => {
        await setInternalName(uow, { serviceId, internalName: 'Renamed by the front desk' })
        throw new Error('the rest of the transaction failed')
      }),
    )
    expect((await auditRows(serviceId)).length - before).toBe(0)
    expect((await readService(sql, serviceId))?.internalName).toBe('Probe')
  })

  it('leaves the internal name unlinted, and says so in the audit trail', async () => {
    // The asymmetry 0017 split the columns for. `setInternalName` takes no lint, and the audit row
    // records the change so the exemption is evidenced rather than assumed.
    const { serviceId } = await makeProbeService('audit6', `${PROBE_SLUG}-audit6`)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      setInternalName(uow, { serviceId, internalName: 'Therapeutic Deep Tissue Treatment' }),
    )
    const rows = await auditRows(serviceId)
    expect(rows[rows.length - 1]).toMatchObject({
      action: 'catalogue.service.rename_internal',
      after: { internalName: 'Therapeutic Deep Tissue Treatment' },
    })
    expect((await readService(sql, serviceId))?.internalName).toBe(
      'Therapeutic Deep Tissue Treatment',
    )
  })
})
