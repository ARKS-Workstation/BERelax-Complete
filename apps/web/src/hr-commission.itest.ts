import { createConnection, type Sql } from '@berelax/db'
import { createFixturePrincipal, type FixturePrincipal } from '@berelax/fixtures'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

/**
 * P-HR-11's commission screen, asserted against SERVED BYTES.
 *
 * Two claims, and neither can be made anywhere else:
 *
 *   1. **The disabled state is visible in the admin UI.** The acceptance line is "with the module disabled by
 *      default the engine produces zero lines and the disabled state is visible in the admin UI and in the
 *      Unconfirmed Assumptions panel — no silent success", and `apps/web/src/hr-commission-render.test.ts`
 *      proves the renderer says so when it is handed a disabled view. What it cannot prove is that the ROUTE
 *      hands it one: that depends on `readSetting(COMMISSION_ENABLED_SETTING_KEY)` really returning `false`
 *      against the seeded database, which is the half that would break if somebody changed the registry
 *      default or the seeder.
 *   2. **The derivation's scope comes from the session.** A therapist receives their own rows and an owner
 *      receives everybody's, and the difference is produced by a cookie. There is no `?employee=` to drive it
 *      with — `apps/web/src/admin-guard.test.ts` refuses one across the whole of `apps/web`, and it caught
 *      this route the first time it was written — so a render test can be handed either view and only a
 *      served response proves which view a cookie gets.
 *
 * The band `commission` in `@berelax/harness/ports` is this file's (brief rules 18 and 19).
 *
 * ## It creates its own principals and removes them
 *
 * `Y8-staff` is open and the seed carries no credential, deliberately — see
 * `packages/fixtures/src/admin-principal.ts`. So this file creates the two it needs, uses them, and removes
 * them in `afterAll`. It asserts nothing about a COUNT of anything, because the integration suite runs
 * sequentially against one database and earlier files leave rows behind (brief rule 12).
 */

let server: WebServer
let sql: Sql
let BASE = ''
const created: FixturePrincipal[] = []

async function principal(role: 'owner' | 'therapist'): Promise<FixturePrincipal> {
  // `enrolTotp` for the owner, because `requiresTotp` is true for it and `createFixturePrincipal` mints the
  // session directly — the flag is what keeps the fixture's shape honest about the real login path.
  const made = await createFixturePrincipal(sql, { role, enrolTotp: role === 'owner' })
  created.push(made)
  return made
}

/** The `Cookie` header for a token, composed from the app's own constant and never invented. */
function cookieFor(token: string | null): string {
  if (token === null) throw new Error('the fixture principal was created without a session')
  return `${ADMIN_SESSION_COOKIE}=${token}`
}

async function get(path: string, cookie: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual', headers: { cookie } })
  return { status: response.status, body: await response.text() }
}

beforeAll(async () => {
  const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
  if (url === '') throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set for this suite.')
  sql = createConnection({ url, max: 4 })
  server = await startWebServer({
    suite: 'commission',
    cwd: new URL('..', import.meta.url).pathname,
    // `/login` rather than the default `/robots.txt`, and rather than `/hr/commission` itself: this suite's
    // subject is an admin screen, so probing the admin estate proves the group is being served by this
    // build, and a probe cannot carry a cookie — `/hr/commission` answers 303 without one, which the
    // 200-expecting probe would read as not ready. The route's own presence is asserted by the first case;
    // in a merged tree nobody rebuilt it would 404 there, which is brief rule 17's failure.
    probePath: '/login',
    readyWithinMs: 90_000,
    env: { APP_ENV: process.env['APP_ENV'] ?? 'test', DATABASE_URL: url },
  })
  BASE = server.origin
}, 180_000)

afterAll(async () => {
  for (const made of created) await made.cleanup()
  await sql?.end({ timeout: 5 })
  await server?.stop()
})

describe('the commission screen says the module is off, on its face', () => {
  it('serves the disabled state and the open question to an owner', async () => {
    const owner = await principal('owner')
    const { status, body } = await get('/hr/commission', cookieFor(owner.sessionToken))
    expect(status).toBe(200)
    expect(body).toContain('The commission module is DISABLED')
    // The open question's id, on the screen. docs/12 §2 requires a provisional value to be visible where it
    // is USED and not only on the panel, and this screen's provisional value is "there is no rate".
    expect(body).toContain('Y9-commission')
    // And the reason, because "disabled" alone reads as a switch somebody turned off rather than as a
    // question nobody has answered.
    expect(body).toContain('no commission structure has been agreed')
    // The CONTROL for all three: the page really is the commission page and not a redirect or an error.
    expect(body).toContain('<title>Commission — HR admin</title>')
  }, 60_000)

  it('publishes no rate of its own — the version list is empty', async () => {
    const owner = created[0] ?? (await principal('owner'))
    const { body } = await get('/hr/commission', cookieFor(owner.sessionToken))
    // `commission_rule` seeds nothing, because Y9-commission's provisional answer is that no structure is
    // configured. An empty list is the assertion: a seeded "10%" would be indistinguishable from a
    // configured one, and this is the surface on which somebody would read it as configured.
    expect(body).toContain('No commission rule version is published')
    expect(body).not.toContain('Band 1')
  }, 60_000)
})

describe('the derivation scope comes from the session and from nowhere else', () => {
  it('shows a therapist their own rows and an owner everybody’s', async () => {
    const therapist = await principal('therapist')
    const owner = created.find((made) => made.role === 'owner') ?? (await principal('owner'))

    const asTherapist = await get('/hr/commission', cookieFor(therapist.sessionToken))
    expect(asTherapist.status).toBe(200)
    expect(asTherapist.body).toContain('only — you')
    expect(asTherapist.body).toContain(
      'There is no way to ask for another employee’s from this screen',
    )
    // Their own handle, which is what "only you" means, and it is a handle rather than a name (ADR 0020).
    expect(asTherapist.body).toContain(therapist.staffReference)

    const asOwner = await get('/hr/commission', cookieFor(owner.sessionToken))
    expect(asOwner.status).toBe(200)
    expect(asOwner.body).toContain('Showing <strong>every employee</strong>')
    // The two responses really do differ, which is the claim. Asserted as a difference rather than as two
    // separate `toContain`s alone, because a page that happened to contain both sentences would satisfy
    // those and would mean the scope sentence says nothing.
    expect(asOwner.body).not.toContain('only — you')
    expect(asTherapist.body).not.toContain('Showing <strong>every employee</strong>')
  }, 60_000)

  it('refuses a request with no session at all', async () => {
    // W-SYS-11's guard, on this route specifically. `session.itest.ts` drives every admin route including
    // this one; asserted here as well because this file's other cases all send a cookie, and a route that
    // had quietly lost its guard would pass all of them.
    const response = await fetch(`${BASE}/hr/commission`, { redirect: 'manual' })
    expect(response.status).toBe(303)
  }, 60_000)
})
