import {
  archiveService,
  createConnection,
  renameServiceSlug,
  type Sql,
  servicePath,
  TREATMENTS_INDEX_PATH,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { handleTreatmentPath } from '../app/(en)/(public)/treatments/[slug]/handler.ts'

/**
 * B-CAT-05 — the route half of the redirect pair, against real PostgreSQL.
 *
 * The acceptance line is "a route test then asserts the old path returns 301 with the new Location",
 * and the reason it is a route test rather than a query is that a redirect nothing serves is a row in a
 * table. The other half is asserted in the same cases and matters just as much: **what the 301 points
 * at returns 200**. A redirect to a slug that no longer resolves is a 404 with extra steps, and a test
 * that stopped at the `location` header would pass for one.
 *
 * The handler is called directly rather than over HTTP, the same choice `otp-route.itest.ts` made and
 * for the same reason: `next start` in front of it would add a server, a router and a locale layer to
 * every assertion, none of which is under test here.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const PROBE = 'bcat05_route_probe'
const PROBE_SLUG = 'bcat05-route-probe'
const ORIGIN = 'https://berelax.test'
const ACTOR = { kind: 'system', label: 'B-CAT-05 route itest' } as const
const PUBLIC_NAME = 'Hot Oil / Balm Massage (Asian)'

let sql: Sql
let serviceId: string

const get = async (path: string): Promise<Response> =>
  handleTreatmentPath({ sql }, new Request(`${ORIGIN}${path}`))

async function seedPublishedService(): Promise<void> {
  const [service] = await sql<{ id: string }[]>`
    insert into service
      (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
    values ('asian', ${PROBE}, ${`${PROBE_SLUG}-old`}, 'Probe', ${PUBLIC_NAME}, 20)
    returning id
  `
  serviceId = service?.id as string
  await sql`
    insert into service_room_type_compat (service_style, service_treatment_key, room_type)
    values ('asian', ${PROBE}, 'standard')
  `
  await sql`
    insert into service_resource_shape
      (service_style, service_treatment_key, shape, therapists_required, rooms_required,
       min_room_capacity, required_room_type, therapist_buffer_minutes)
    values ('asian', ${PROBE}, 'solo', 1, 1, 1, 'standard', 10)
  `
  await sql`
    insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
    values (${serviceId}, 60, 20000, ${'B-CAT-05 route fixture'})
  `
  await sql`update service set published_at = now() where id = ${serviceId}`
}

async function cleanUp(): Promise<void> {
  await sql`delete from redirect_map where source_path like ${`/treatments/${PROBE_SLUG}%`}`
  await sql`delete from redirect_map where target_path like ${`/treatments/${PROBE_SLUG}%`}`
  await sql`delete from service where treatment_key = ${PROBE}`
  await sql`delete from service_room_type_compat where service_treatment_key = ${PROBE}`
}

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  await cleanUp()
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await cleanUp()
  await seedPublishedService()
})

describe('acceptance — the old path returns 301 with the new Location', () => {
  it('301s the retired path, and the path it names returns 200', async () => {
    const oldPath = servicePath(`${PROBE_SLUG}-old`)
    const newPath = servicePath(`${PROBE_SLUG}-new`)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-new` }),
    )

    const moved = await get(oldPath)
    expect(moved.status).toBe(301)
    expect(moved.headers.get('location')).toBe(newPath)

    // The half that makes the 301 worth having. Following it must arrive somewhere.
    const landed = await get(moved.headers.get('location') as string)
    expect(landed.status).toBe(200)
    expect(await landed.text()).toBe(PUBLIC_NAME)
  })

  it('resolves in exactly one hop after two renames', async () => {
    const oldest = servicePath(`${PROBE_SLUG}-old`)
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-mid` }),
    )
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-final` }),
    )

    const first = await get(oldest)
    expect(first.status).toBe(301)
    expect(first.headers.get('location')).toBe(servicePath(`${PROBE_SLUG}-final`))
    // One hop: what it points at is a 200, not another 301. A chain would be a second redirect here,
    // and one more rename would make it a third.
    const second = await get(first.headers.get('location') as string)
    expect(second.status).toBe(200)

    const middle = await get(servicePath(`${PROBE_SLUG}-mid`))
    expect(middle.status).toBe(301)
    expect((await get(middle.headers.get('location') as string)).status).toBe(200)
  })

  it('keeps the query string on the redirect', async () => {
    // A campaign parameter is how the traffic that hits an old URL is usually attributed, and dropping
    // it turns a tracked visit into direct traffic silently.
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-utm` }),
    )
    const moved = await get(`${servicePath(`${PROBE_SLUG}-old`)}?utm_source=google`)
    expect(moved.status).toBe(301)
    expect(moved.headers.get('location')).toBe(
      `${servicePath(`${PROBE_SLUG}-utm`)}?utm_source=google`,
    )
  })

  it('301s a legacy path onto a live treatment page', async () => {
    // The shape W-SITE-09's importer writes into the same table. Asserted here so the route is known
    // to serve rows it did not write itself.
    await sql`
      insert into redirect_map (source_path, target_path, reason, created_by)
      values ('/treatments/bcat05-route-probe-legacy', ${servicePath(`${PROBE_SLUG}-old`)},
              'baseline import', 'probe')
    `
    const moved = await get('/treatments/bcat05-route-probe-legacy')
    expect(moved.status).toBe(301)
    expect((await get(moved.headers.get('location') as string)).status).toBe(200)
  })

  it('sends an archived service’s retired path to the treatments index', async () => {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-gone` }),
    )
    await withUnitOfWork(sql, ACTOR, (uow) => archiveService(uow, { serviceId }))

    const moved = await get(servicePath(`${PROBE_SLUG}-old`))
    expect(moved.status).toBe(301)
    expect(moved.headers.get('location')).toBe(TREATMENTS_INDEX_PATH)
    // The archived service's own path answers nothing rather than redirecting to itself.
    expect((await get(servicePath(`${PROBE_SLUG}-gone`))).status).toBe(404)
  })

  it('404s a path that was never a slug and is not a redirect', async () => {
    // The control that keeps every 301 above meaningful: the route is not answering everything.
    expect((await get('/treatments/bcat05-route-probe-never-existed')).status).toBe(404)
  })

  it('serves the live page rather than a stale redirect when a slug comes back', async () => {
    // Rename away and back. Both rows exist, and the live service has to win: otherwise the page 301s
    // to its own former name and the browser reports a loop.
    await withOneHop(`${PROBE_SLUG}-away`)
    await withOneHop(`${PROBE_SLUG}-old`)
    const direct = await get(servicePath(`${PROBE_SLUG}-old`))
    expect(direct.status).toBe(200)
    expect(await direct.text()).toBe(PUBLIC_NAME)
  })
})

/** Renames the probe service and asserts nothing; the cases above assert what it produced. */
async function withOneHop(slug: string): Promise<void> {
  await withUnitOfWork(sql, ACTOR, (uow) => renameServiceSlug(uow, { serviceId, slug }))
}
