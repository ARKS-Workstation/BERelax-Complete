import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  composeJourney,
  conditionStep,
  delayStep,
  exitStep,
  type FlowTemplateFact,
  messageStep,
  serialiseFlowDefinition,
  tagStep,
  templateChoicesFor,
} from '@berelax/core'
import {
  type Actor,
  countEnrolmentsOnVersion,
  createConnection,
  enrolOnLiveVersion,
  readCurrentTemplateClasses,
  readFlowByKey,
  readLiveFlowVersion,
  type Sql,
  setFlowActive,
  withUnitOfWork,
} from '@berelax/db'
import {
  createFixturePrincipal,
  type FixturePrincipal,
  SYNTHETIC_MOBILE_PREFIX,
} from '@berelax/fixtures'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import { installAdminBrowserCookie, installAdminCookie } from '@berelax/harness/admin-session'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { MESSAGE_CLASSES } from '@berelax/shared'
import { type Browser, chromium, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { repositoryRoot } from './media/storage.ts'
import { ADMIN_SESSION_COOKIE } from './session-cookie.ts'

/**
 * C-AUTO-09 — the journey builder and its publish endpoint, driven against the built application.
 *
 * Five claims live here and nowhere else, because none can be checked by reading source:
 *
 *   1. **The template picker lists only templates of the node's declared class.** Asserted against the
 *      rendered `<option>` sets for BOTH classes, compared with `templateChoicesFor` over the registry
 *      this suite reads out of `message_template` — so the screen and the type's own partition are held
 *      equal rather than each asserted against a literal.
 *   2. **A direct API call binding a promotional node to a transactional template is refused by name.**
 *      Over HTTP, bypassing the UI entirely, which is what the acceptance line asks for:
 *      `flow-dsl-message-class-mismatch` with a 422.
 *   3. **Add, save, reload: an identical serialised graph.** Four steps added through the forms, saved,
 *      and the page reopened — the canonical bytes on the reloaded page equal the bytes of the version
 *      that was stored, and they equal what `composeJourney` produces for the same journey.
 *   4. **The enrolment figure is the database's.** The number printed beside the save control equals
 *      `countEnrolmentsOnVersion(..., activeOnly)` at the moment the page was read, and it MOVES when a
 *      row is added — which is what makes it a count rather than a cached figure.
 *   5. **Keyboard-only, accessible, and photographable.** Every node is added, selected, connected and
 *      deleted with `page.keyboard` and no `click()` anywhere; axe reports nothing serious or critical
 *      over twelve renders; and two consecutive captures are byte-identical.
 *
 * ## Isolation, and the rows this suite cannot take back
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind
 * (brief rule 12). `flow_definition` refuses DELETE for every role including the owner (ZF001), so every
 * version this file publishes is permanent. Three consequences, all deliberate and all copied from
 * `flow-versioning.itest.ts`, which proved them:
 *
 *   - the flow keys are namespaced to this file, so no other suite's journey is touched;
 *   - every version number is READ first and asserted RELATIVELY, so a second run against the same
 *     database appends instead of colliding;
 *   - every enrolment count is narrowed to this file's own flow id and counted in SQL.
 *
 * The contacts this suite enrols are on the unallocated `+971 59` prefix in a band no other suite uses
 * (60_801 upward; `flow-versioning.itest.ts` holds 60_001-60_400) and are removed in `afterAll` — which
 * is exactly why `flow_enrolment.customer_id` cascades rather than restricts (migration 0070).
 *
 * Nothing here is a message body or a person's name: every template is a KEY from `message_template`,
 * and every contact is a synthetic number with no label (ADR 0020, brief rules 10 and 15).
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const MARKER = 'cauto09 flow builder itest'
const ACTOR: Actor = { kind: 'staff', label: MARKER }

/** One key per concern, all namespaced to this file. */
const KEYS = {
  /** The journey the keyboard pass draws and saves. Published on every run, so versions accumulate. */
  drawn: 'cauto09_drawn',
  /** The journey the enrolment figure is asserted against. Published once per run and enrolled on. */
  pinned: 'cauto09_pinned',
  /** The journey the API refusals are sent to. The control publish lands here, so it gains versions. */
  refusals: 'cauto09_refusals',
  /**
   * A journey this suite NEVER publishes to, so a GET always opens an empty draft.
   *
   * `flow_definition` refuses DELETE, so a key this file publishes to keeps its versions for ever and
   * "the builder opens on nothing drawn" would be true on the first run and false on every run after
   * it — brief rule 12's hazard, inflicted by a suite on itself. C-AUTO-06 keeps `cauto06_unpublished`
   * for exactly this reason, and this is the same device. Every form-driven case below uses this key.
   */
  scratch: 'cauto09_scratch',
} as const

/** The band this suite's contacts live in. Outside every band `synthetic.ts`'s callers use. */
const CONTACT_BAND_FIRST = 60_801
const ENROLMENTS = 3

/** One synthetic contact's number, on the unallocated prefix, from the band above. */
const fixturePhone = (index: number): string =>
  `+971${SYNTHETIC_MOBILE_PREFIX}${String(index).padStart(7, '0')}`

const SCREENS = join(repositoryRoot(), 'artifacts', 'screens', 'C-AUTO-09')

let BASE = ''
let server: WebServer
let browser: Browser
let sql: Sql
let registry: readonly FlowTemplateFact[]
let adminPrincipal: FixturePrincipal | undefined
let restoreAdminFetch: () => void = () => {}
let restoreAdminBrowser: () => void = () => {}
let contactIds: string[] = []
let pinnedVersion = 0

const builderPath = (key: string): string => `/crm/flows/${key}/builder`
const API_PATH = '/crm/flows/api'

/**
 * The journey this suite publishes to `cauto09_pinned`, composed through the TYPED surface.
 *
 * Composed rather than written as JSON, deliberately: it is the same document the builder's forms
 * produce, and composing it here means the suite's own fixture could not express a misrouting either.
 */
function pinnedJourney(): unknown {
  const promotional = templateChoicesFor(registry, 'promotional')[0]
  if (promotional === undefined) throw new Error('no promotional template is current')
  return composeJourney({
    key: KEYS.pinned,
    title: 'The journey the enrolment figure is about',
    trigger: { id: 'entered', event: 'appointment.completed' },
    steps: {
      settle: delayStep({ minutes: 1440 }),
      may_we_ask: conditionStep({ test: { fact: 'has_marketing_consent', operator: 'is_true' } }),
      ask: messageStep({ template: promotional, channel: 'sms' }),
      noted: tagStep({ tag: 'review_requested' }),
      done: exitStep({ reason: 'goal_met' }),
      no_consent: exitStep({ reason: 'not_eligible' }),
    },
    edges: {
      'entered:default': 'settle',
      'settle:default': 'may_we_ask',
      'may_we_ask:true': 'ask',
      'may_we_ask:false': 'no_consent',
      'ask:default': 'noted',
      'noted:default': 'done',
    },
  })
}

async function publishOverHttp(body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE}${API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: (await response.json()) as unknown }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  registry = await readCurrentTemplateClasses(sql)

  // The contacts. The numbers are built in JS from `SYNTHETIC_MOBILE_PREFIX` rather than written into
  // the SQL, so the band in the comment and the band in the statement are one value — `+971 59` is
  // unallocated and therefore undialable, which `synthetic.ts` explains is a stronger guarantee than a
  // convention.
  const phones = Array.from({ length: ENROLMENTS }, (_unused, index) =>
    fixturePhone(CONTACT_BAND_FIRST + index),
  )
  await sql`
    insert into customer (phone_e164, created_via)
    select unnest(${phones}::text[]), 'front_desk'
     on conflict (phone_e164) do nothing
  `
  const rows = await sql<{ id: string }[]>`
    select id from customer where phone_e164 = any(${phones}::text[]) order by phone_e164
  `
  contactIds = rows.map((row) => row.id)
  if (contactIds.length !== ENROLMENTS) {
    throw new Error(`expected ${ENROLMENTS} fixture contacts, found ${contactIds.length}`)
  }

  server = await startWebServer({
    suite: 'flow-builder',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/robots.txt',
    readyWithinMs: 90_000,
    env: {
      // Both routes call `loadConfig()`. Declared rather than assumed, the note every admin suite makes:
      // a local run that exported only TEST_DATABASE_URL would get a 503 that reads like a broken route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
    },
  })
  BASE = server.origin

  // The session, before anything is fetched and before the browser is launched:
  // `installAdminBrowserCookie` patches `chromium.launch`, so it has to run first.
  //
  // `owner`, because this suite asserts what the screens SHOW and holds both `campaign:read` and
  // `campaign:send`. What the matrix decides per role is asserted below with a second principal, which
  // is the only way to prove the publish permission is really the narrower of the two.
  adminPrincipal = await createFixturePrincipal(sql, { role: 'owner' })
  const adminToken = adminPrincipal.sessionToken ?? ''
  restoreAdminFetch = installAdminCookie({
    origin: BASE,
    cookie: `${ADMIN_SESSION_COOKIE}=${adminToken}`,
  })
  restoreAdminBrowser = installAdminBrowserCookie(chromium, {
    origin: BASE,
    name: ADMIN_SESSION_COOKIE,
    token: adminToken,
  })
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })

  // The journey the enrolment figure is about, published and enrolled on. Published over HTTP through
  // the route under test rather than through the repository, so the version this suite then counts
  // against is one the endpoint really wrote.
  const published = await publishOverHttp({
    flowKey: KEYS.pinned,
    title: 'The journey the enrolment figure is about',
    definition: pinnedJourney(),
  })
  if (published.status !== 200) {
    throw new Error(`publishing the pinned journey answered ${published.status}`)
  }
  pinnedVersion = (published.body as { version: number }).version
  /*
    Activated by this SUITE and not by the publish, and the distinction is load-bearing.

    `flow.is_active` is false until somebody enables it, so a publish cannot start messaging anybody by
    itself — `enrolOnLiveVersion` answers `flow_not_active` until it is set. The builder deliberately
    offers no activation control: publishing a version is `campaign:send`'s authority over a DOCUMENT,
    and turning a journey on is the switch C-AUTO-05's kill switch and `setFlowActive` own. Enrolling is
    what this suite needs in order to have a figure to assert, so it flips the switch itself.
  */
  await withUnitOfWork(sql, ACTOR, (uow) => setFlowActive(uow, KEYS.pinned, true))
  for (const customerId of contactIds) {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      enrolOnLiveVersion(uow, {
        flowKey: KEYS.pinned,
        customerId,
        createdBy: MARKER,
        at: new Date(),
      }),
    )
  }
}, 300_000)

afterAll(async () => {
  restoreAdminFetch()
  restoreAdminBrowser()
  await adminPrincipal?.cleanup()
  await browser?.close()
  await server?.stop()
  // The contacts are this file's own to remove, and their enrolments go with them:
  // `flow_enrolment.customer_id` cascades (0070). The flows and their versions stay — `flow_definition`
  // refuses DELETE for every role, which is why every version number here is read first and asserted
  // relatively.
  if (contactIds.length > 0) {
    await sql`delete from customer where id = any(${contactIds}::uuid[])`
  }
  await sql?.end({ timeout: 5 })
})

const get = (path: string): Promise<Response> => fetch(`${BASE}${path}`, { redirect: 'manual' })

const post = (path: string, form: Record<string, string>): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })

/** The hidden draft field the page carries, which is the builder's whole state. */
function draftFieldFrom(html: string): string {
  const match = /name="draft" value="([^"]*)"/.exec(html)
  if (match?.[1] === undefined) throw new Error('the page carried no draft field')
  return match[1]
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

/** The `<option>` values of one `<select>`, by its id. */
function optionsOf(html: string, selectId: string): readonly string[] {
  const block = new RegExp(`<select id="${selectId}"[^>]*>([\\s\\S]*?)</select>`).exec(html)
  if (block?.[1] === undefined) return []
  return [...block[1].matchAll(/value="([^"]*)"/g)].map((match) => match[1] as string)
}

// ------------------------------------------------------------------------------------------------
// The picker, and the API behind it
// ------------------------------------------------------------------------------------------------

describe('acceptance — the template picker lists only templates of the declared class', () => {
  it('renders one select per class, each holding exactly that class of the live registry', async () => {
    const response = await get(builderPath(KEYS.scratch))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()

    for (const messageClass of MESSAGE_CLASSES) {
      const rendered = optionsOf(html, `builder-template-${messageClass}`)
      const offered = templateChoicesFor(registry, messageClass).map((ref) => ref.templateKey)
      // The screen and the type's own partition, held equal. Not asserted against a literal: the
      // registry is `message_template`'s and a literal here would be a second statement of it.
      expect(rendered, messageClass).toEqual(offered)
    }

    // The control that makes the equality mean something: the two lists really are different, and the
    // promotional picker really does NOT offer a transactional key. Without this, a registry read as
    // empty would satisfy the loop above twice over.
    const promotional = optionsOf(html, 'builder-template-promotional')
    const transactional = optionsOf(html, 'builder-template-transactional')
    expect(promotional.length).toBeGreaterThan(0)
    expect(transactional.length).toBeGreaterThan(0)
    expect(promotional).not.toEqual(transactional)
    expect(promotional).not.toContain('booking.confirmed')
    expect(transactional).toContain('booking.confirmed')
    expect(transactional).not.toContain('review.request')
    // And the classes the registry holds are the two the vocabulary declares, from the database.
    expect([...new Set(registry.map((fact) => fact.messageClass))].sort()).toEqual([
      'promotional',
      'transactional',
    ])
  })

  it('refuses a form that posts a template of the other class, by name, before any publish', async () => {
    // The UI's own edge. The pair was never offered, so this is a crafted body — and the refusal names
    // the pair rather than reporting a document-level rule, because the operator is holding the form.
    const opened = await get(builderPath(KEYS.scratch))
    // The way in first: every other step is something the trigger leads to, so a `place` before it is
    // refused for a different reason and this case would be about the wrong refusal.
    const withTrigger = await post(builderPath(KEYS.scratch), {
      draft: draftFieldFrom(await opened.text()),
      op: 'trigger',
      event: 'appointment.completed',
    })
    const draft = draftFieldFrom(await withTrigger.text())

    const refused = await post(builderPath(KEYS.scratch), {
      draft,
      op: 'place',
      kind: 'action_message',
      class: 'promotional',
      template: 'booking.confirmed',
      channel: 'sms',
    })
    expect(refused.status).toBe(422)
    expect(await refused.text()).toContain('data-refusal="template_not_offered"')

    // The control: the SAME form with a template of the matching class is accepted, so the refusal is
    // about the class and not about the form being unreadable or the step being unavailable.
    const accepted = await post(builderPath(KEYS.scratch), {
      draft,
      op: 'place',
      kind: 'action_message',
      class: 'promotional',
      template: 'review.request',
      channel: 'sms',
    })
    expect(accepted.status).toBe(200)
    expect(await accepted.text()).toContain('review.request')
  })
})

describe('acceptance — the API refuses a misrouting sent straight to it, bypassing the UI', () => {
  it('answers 422 and names flow-dsl-message-class-mismatch', async () => {
    // A document that is valid in every other way: one trigger, every branch routed, an exit reachable.
    // The ONLY thing wrong is a promotional node bound to a transactional template — which is exactly
    // what the typed composer cannot express, so this document is written by hand on purpose.
    const misrouted = {
      dslVersion: 1,
      key: KEYS.refusals,
      title: 'A promotional step on a transactional template',
      nodes: [
        { id: 'entered', kind: 'trigger', event: 'appointment.completed' },
        {
          id: 'ask',
          kind: 'action_message',
          messageClass: 'promotional',
          templateKey: 'booking.confirmed',
          channel: 'sms',
        },
        { id: 'done', kind: 'exit', reason: 'goal_met' },
      ],
      edges: [
        { from: 'entered', to: 'ask', branch: 'default' },
        { from: 'ask', to: 'done', branch: 'default' },
      ],
    }
    const liveBefore = await readLiveFlowVersion(sql, KEYS.refusals)
    const refused = await publishOverHttp({
      flowKey: KEYS.refusals,
      title: 'A promotional step on a transactional template',
      definition: misrouted,
    })
    expect(refused.status).toBe(422)
    const body = refused.body as { ok: boolean; refusal: string; rules: readonly string[] }
    expect(body.ok).toBe(false)
    expect(body.refusal).toBe('definition_invalid')
    expect(body.rules).toContain('flow-dsl-message-class-mismatch')
    // Nothing was written: `flow_definition` refuses DELETE, so a document that reached the table would
    // be there for ever. Asserted as "the live version did not move" rather than "there is none",
    // because the control below publishes to this key and a second run of this suite would then find
    // one — brief rule 12.
    expect(await readLiveFlowVersion(sql, KEYS.refusals)).toBe(liveBefore)

    // The control, in both directions. The SAME document with the classes agreeing is accepted, so the
    // refusal is about the binding and not about anything else in the document.
    const corrected = {
      ...misrouted,
      nodes: misrouted.nodes.map((node) =>
        node.id === 'ask' ? { ...node, messageClass: 'transactional' } : node,
      ),
    }
    const accepted = await publishOverHttp({
      flowKey: KEYS.refusals,
      title: 'A promotional step on a transactional template',
      definition: corrected,
    })
    expect(accepted.status).toBe(200)
    expect((accepted.body as { version: number }).version).toBeGreaterThanOrEqual(1)
  })

  it('refuses an unreadable body, a bad key and an invalid graph with three different names', async () => {
    // Three refusals that must not collapse into one. Each one is a different status, which is what a
    // script branches on.
    const unreadable = await fetch(`${BASE}${API_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    })
    expect(unreadable.status).toBe(400)
    expect(((await unreadable.json()) as { refusal: string }).refusal).toBe('unreadable_request')

    const badKey = await publishOverHttp({
      flowKey: 'Not A Key',
      title: 'x',
      definition: {},
    })
    expect(badKey.status).toBe(400)
    expect((badKey.body as { refusal: string }).refusal).toBe('flow_key_invalid')

    const deadEnd = await publishOverHttp({
      flowKey: KEYS.refusals,
      title: 'A journey with a dead end',
      definition: {
        dslVersion: 1,
        key: KEYS.refusals,
        title: 'A journey with a dead end',
        nodes: [
          { id: 'entered', kind: 'trigger', event: 'manual' },
          { id: 'hold', kind: 'delay', minutes: 60 },
        ],
        edges: [{ from: 'entered', to: 'hold', branch: 'default' }],
      },
    })
    expect(deadEnd.status).toBe(422)
    expect((deadEnd.body as { rules: readonly string[] }).rules).toContain(
      'flow-analysis-non-terminal-node-has-no-outgoing-edge',
    )
  })

  it('refuses a publish from a role that may open the builder and not publish', async () => {
    // The F07 matrix, over HTTP, with a real session. `manager` holds `campaign:read` and not
    // `campaign:send`, which is the split this unit chose rather than inventing a permission.
    const manager = await createFixturePrincipal(sql, { role: 'manager', enrolTotp: true })
    try {
      const cookie = `${ADMIN_SESSION_COOKIE}=${manager.sessionToken ?? ''}`
      const opened = await fetch(`${BASE}${builderPath(KEYS.scratch)}`, {
        redirect: 'manual',
        headers: { cookie },
      })
      // It may LOOK: `campaign:read`.
      expect(opened.status).toBe(200)
      const html = await opened.text()
      // And the save control says so on its own face rather than vanishing.
      expect(html).toContain('data-save')
      expect(html).toContain('disabled')
      expect(html).toContain('may not publish a journey')

      const refused = await fetch(`${BASE}${API_PATH}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          flowKey: KEYS.refusals,
          title: 'A journey a manager may not publish',
          definition: pinnedJourney(),
        }),
      })
      expect(refused.status).toBe(403)
      expect(((await refused.json()) as { refusal: string }).refusal).toBe('forbidden')
    } finally {
      await manager.cleanup()
    }
  })
})

// ------------------------------------------------------------------------------------------------
// The enrolment figure
// ------------------------------------------------------------------------------------------------

describe('acceptance — the displayed enrolment count is the live row count, not a cached figure', () => {
  it('prints exactly what countEnrolmentsOnVersion answers, and moves when a row is added', async () => {
    const flow = await readFlowByKey(sql, KEYS.pinned)
    expect(flow).not.toBeNull()
    if (flow === null) throw new Error('unreachable')

    const live = await readLiveFlowVersion(sql, KEYS.pinned)
    expect(live).toBe(pinnedVersion)
    const counted = await countEnrolmentsOnVersion(sql, flow.id, pinnedVersion, {
      activeOnly: true,
    })
    expect(counted).toBe(ENROLMENTS)

    const html = await (await get(builderPath(KEYS.pinned))).text()
    expect(html).toContain(`data-live-version="${pinnedVersion}"`)
    // THE assertion: the printed figure is the database's, asserted against a count taken here.
    expect(html).toContain(`data-enrolments-remaining="${counted}"`)

    // And it is a COUNT and not a constant: one more active enrolment and the page says one more.
    // Without this half, a page printing a hard-coded number would pass the assertion above whenever the
    // fixture happened to have that many rows.
    const extra = await sql<{ id: string }[]>`
      insert into customer (phone_e164, created_via)
      values (${fixturePhone(CONTACT_BAND_FIRST + ENROLMENTS)}, 'front_desk')
      on conflict (phone_e164) do update set created_via = customer.created_via
      returning id
    `
    const extraId = extra[0]?.id
    if (extraId === undefined) throw new Error('the extra contact was not created')
    contactIds = [...contactIds, extraId]
    await withUnitOfWork(sql, ACTOR, (uow) =>
      enrolOnLiveVersion(uow, {
        flowKey: KEYS.pinned,
        customerId: extraId,
        createdBy: MARKER,
        at: new Date(),
      }),
    )
    const after = await countEnrolmentsOnVersion(sql, flow.id, pinnedVersion, { activeOnly: true })
    expect(after).toBe(counted + 1)
    const reread = await (await get(builderPath(KEYS.pinned))).text()
    expect(reread).toContain(`data-enrolments-remaining="${after}"`)
    expect(reread).not.toContain(`data-enrolments-remaining="${counted}"`)
  }, 60_000)
})

// ------------------------------------------------------------------------------------------------
// Drawing a journey, keyboard-only, and reloading it
// ------------------------------------------------------------------------------------------------

/**
 * A trigger, a delay, a condition and an action, added and wired keyboard-only.
 *
 * `page.keyboard` throughout and not one `click()`: the acceptance line is "every node can be added,
 * selected, connected and deleted keyboard-only", and the only way to assert that is to use nothing
 * else. There is no canvas to trap focus — see `render.ts` — so this is Tab to the control and Enter.
 */
const TAB_BUDGET = 900

/** Walks the tab order to a control, which is what a keyboard user does, and says so when it cannot. */
async function tabTo(page: Page, target: Locator, what: string): Promise<void> {
  await target.waitFor({ state: 'attached' })
  for (let step = 0; step < TAB_BUDGET; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  throw new Error(`${what} was not reachable by Tab within ${TAB_BUDGET} presses`)
}

/**
 * Presses a submit button with the keyboard and waits for the page it produces.
 *
 * The wait is armed BEFORE the key is pressed, and that is not a flourish. Every control here submits a
 * form, so every press replaces the document — and `waitForLoadState` called afterwards can return
 * about the OLD page, after which the next read fails with "Execution context was destroyed, most
 * likely because of a navigation". That is what this file's first keyboard pass did, and the failure
 * named a locator rather than a race.
 */
async function pressButton(page: Page, name: string | RegExp): Promise<void> {
  // Focus by WALKING the tab order rather than calling `focus()`: a programmatic focus would prove
  // nothing about whether the control is reachable, which is the half of "keyboard-only" that fails in
  // practice.
  const target = page.getByRole('button', { name, exact: typeof name === 'string' }).first()
  await tabTo(page, target, `the "${String(name)}" button`)
  const navigated = page.waitForEvent('framenavigated', { timeout: 30_000 })
  await page.keyboard.press('Enter')
  await navigated
  await page.waitForLoadState('load')
}

async function selectByKeyboard(page: Page, selectId: string, value: string): Promise<void> {
  const target = page.locator(`#${selectId}`)
  await tabTo(page, target, `#${selectId}`)
  // `selectOption` on a FOCUSED select is the arrow-key interaction; typing an option's first letters
  // is the other, and is fragile across option sets. The claim is that the control is reachable and
  // operable without a pointer, and the walk above is what establishes it.
  await target.selectOption(value)
}

async function typeInto(page: Page, inputId: string, value: string): Promise<void> {
  const target = page.locator(`#${inputId}`)
  await tabTo(page, target, `#${inputId}`)
  await page.keyboard.press('Control+a')
  await page.keyboard.type(value)
}

describe('acceptance — a journey is drawn, saved and reloaded as an identical serialised graph', () => {
  it('adds a trigger, a delay, a condition and an action keyboard-only, saves, and reloads the same bytes', async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: 'light',
      locale: 'en-AE',
      timezoneId: 'Asia/Dubai',
      reducedMotion: 'reduce',
    })
    try {
      await context.addInitScript({
        content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
      })
      const page = await context.newPage()
      const before = await readLiveFlowVersion(sql, KEYS.drawn)

      await page.goto(`${BASE}${builderPath(KEYS.drawn)}`, { waitUntil: 'networkidle' })

      // The journey this run draws is a fresh one each time — `flow_definition` keeps every version —
      // so the page is reset to an empty draft by deleting whatever the live version holds. That is the
      // honest shape: a second run appends rather than colliding, exactly as the file header says.
      for (;;) {
        const rows = await page.locator('tbody tr[aria-selected]').count()
        if (rows === 0) break
        const id = await page.locator('tbody tr th code').first().innerText()
        await pressButton(page, `Delete ${id}`)
      }

      // 1. The way in.
      await selectByKeyboard(page, 'builder-event', 'appointment.completed')
      await pressButton(page, 'Add the way in')

      // 2. A wait. A number input rather than a select, reached the same way and typed.
      await typeInto(page, 'builder-minutes', '1440')
      await pressButton(page, 'Add wait')

      // 3. A condition.
      await selectByKeyboard(page, 'builder-fact', 'has_marketing_consent')
      await selectByKeyboard(page, 'builder-operator', 'is_true')
      await pressButton(page, 'Add ask a question')

      // 4. An action — a promotional message, from the PROMOTIONAL card. There is one card per class,
      //    each with its own channel control and its own picker, which is why the ids are suffixed.
      await selectByKeyboard(page, 'builder-channel-promotional', 'sms')
      await selectByKeyboard(page, 'builder-template-promotional', 'review.request')
      await pressButton(page, 'Add promotional message')

      // Two exits, so both answers of the condition have somewhere to go.
      await selectByKeyboard(page, 'builder-reason', 'goal_met')
      await pressButton(page, 'Add end the journey')
      await selectByKeyboard(page, 'builder-reason', 'not_eligible')
      await pressButton(page, 'Add end the journey')

      // Selecting a node keyboard-only, which the acceptance line names separately from adding one.
      await pressButton(page, 'Select delay_1')
      expect(await page.locator('tr[aria-selected="true"] th code').innerText()).toBe('delay_1')

      // Now the connections — every one of them through the two OFFER selects.
      const wiring: readonly (readonly [string, string])[] = [
        ['entered:default', 'delay_1'],
        ['delay_1:default', 'condition_1'],
        ['condition_1:true', 'action_message_1'],
        ['condition_1:false', 'exit_2'],
        ['action_message_1:default', 'exit_1'],
      ]
      for (const [outlet, to] of wiring) {
        await selectByKeyboard(page, 'builder-outlet', outlet)
        await selectByKeyboard(page, 'builder-to', to)
        await pressButton(page, 'Connect')
      }

      // The graph is publishable now, and the page says so rather than only enabling a button. The
      // rule list is asserted rather than a bare count, so a failure NAMES what is still wrong instead
      // of reporting `expected 0 to be 1` about a page nobody can see.
      expect(await page.locator('[data-rule]').allInnerTexts()).toEqual([])
      expect(await page.locator('[data-publishable="true"]').count()).toBe(1)
      const drawnBytes = await page.locator('[data-canonical]').innerText()

      // Matched by PATTERN rather than by the exact version, because the version depends on how many
      // times this suite has run against this database and `flow_definition` keeps every one of them.
      await pressButton(page, /^Save as version \d+$/)

      // Saved: a version appeared, and the page says which. The page's own words go into the failure
      // message, because "no version appeared" on its own cannot say whether the publish was refused,
      // and by what.
      const saved = await page.locator('body').innerText()
      const after = await readLiveFlowVersion(sql, KEYS.drawn)
      expect(after, `the page said:\n${saved}`).toBe((before ?? 0) + 1)
      expect(saved).toContain(`Saved as version ${after}`)

      // THE reload. Open the page again — a fresh request, which reads the live version out of the
      // database — and the serialised graph is byte-identical to what was drawn.
      await page.goto(`${BASE}${builderPath(KEYS.drawn)}`, { waitUntil: 'networkidle' })
      const reloadedBytes = await page.locator('[data-canonical]').innerText()
      expect(reloadedBytes).toBe(drawnBytes)

      // And it is the same document the TYPED composer produces for the same journey, which is the
      // strongest form of the claim: the builder's output and `composeJourney`'s agree byte for byte.
      const promotional = templateChoicesFor(registry, 'promotional')[0]
      if (promotional === undefined) throw new Error('no promotional template is current')
      const composed = composeJourney({
        key: KEYS.drawn,
        title: KEYS.drawn,
        trigger: { id: 'entered', event: 'appointment.completed' },
        steps: {
          delay_1: delayStep({ minutes: 1440 }),
          condition_1: conditionStep({
            test: { fact: 'has_marketing_consent', operator: 'is_true' },
          }),
          action_message_1: messageStep({ template: promotional, channel: 'sms' }),
          exit_1: exitStep({ reason: 'goal_met' }),
          exit_2: exitStep({ reason: 'not_eligible' }),
        },
        edges: {
          'entered:default': 'delay_1',
          'delay_1:default': 'condition_1',
          'condition_1:true': 'action_message_1',
          'condition_1:false': 'exit_2',
          'action_message_1:default': 'exit_1',
        },
      })
      // The page prints the bytes with the browser's own whitespace handling, so the comparison is on
      // the parsed documents rather than on the rendered text — and the serialiser is what makes that a
      // byte claim: two documents with one canonical form are one document.
      expect(JSON.parse(reloadedBytes)).toEqual(JSON.parse(serialiseFlowDefinition(composed)))
    } finally {
      await context.close()
    }
  }, 300_000)
})

describe('acceptance — the save control is disabled on an invalid intermediate state', () => {
  it('disables save and names the rules while a branch is unrouted, and enables it when it is not', async () => {
    // The UI half of the first acceptance line. Driven over HTTP rather than in a browser, because the
    // claim is about the bytes the server sends: a `disabled` attribute added by a script would be a
    // control that is enabled with scripting off.
    const opened = await get(builderPath(KEYS.scratch))
    let draft = draftFieldFrom(await opened.text())

    const step = async (form: Record<string, string>): Promise<string> => {
      const response = await post(builderPath(KEYS.scratch), { ...form, draft })
      const html = await response.text()
      draft = draftFieldFrom(html)
      return html
    }

    await step({ op: 'trigger', event: 'manual' })
    const withCondition = await step({
      op: 'place',
      kind: 'condition',
      fact: 'is_vip',
      operator: 'is_true',
    })
    // A condition with no branches routed: save is disabled and every rule is named.
    expect(withCondition).toContain('data-publishable="false"')
    expect(withCondition).toContain('data-rule="flow-analysis-condition-branch-missing"')
    expect(withCondition).toMatch(/<button type="submit" data-save\s+disabled>/)

    // And the same graph posted to the API anyway is refused by name, which is the other half of the
    // line: the UI's disabled control and the API's refusal are one verdict, not two that agree.
    const refused = await publishOverHttp({
      flowKey: KEYS.scratch,
      title: 'A condition with one answer',
      definition: JSON.parse(draft) as unknown,
    })
    expect(refused.status).toBe(422)
    expect((refused.body as { rules: readonly string[] }).rules).toContain(
      'flow-analysis-condition-branch-missing',
    )

    // Route both answers and it becomes publishable — so "disabled" is about THIS graph and not a
    // control that is never enabled.
    await step({ op: 'place', kind: 'exit', reason: 'completed' })
    await step({ op: 'place', kind: 'exit', reason: 'not_eligible' })
    await step({ op: 'connect', outlet: 'entered:default', to: 'condition_1' })
    await step({ op: 'connect', outlet: 'condition_1:true', to: 'exit_1' })
    const complete = await step({ op: 'connect', outlet: 'condition_1:false', to: 'exit_2' })
    expect(complete).toContain('data-publishable="true"')
    expect(complete).not.toMatch(/data-save\s+disabled/)
  }, 120_000)

  it('refuses an edge the page never offered, by name, in all four shapes', async () => {
    // The four misroutings, over HTTP. Each one is a crafted body: the page's two selects never held
    // any of them, which is the point — the type makes them unexpressible in the composer and
    // `resolveJourneyOutlet` makes them unnameable here.
    const opened = await get(builderPath(KEYS.scratch))
    let draft = draftFieldFrom(await opened.text())
    const step = async (form: Record<string, string>): Promise<Response> => {
      const response = await post(builderPath(KEYS.scratch), { ...form, draft })
      if (response.status === 200) draft = draftFieldFrom(await response.clone().text())
      return response
    }
    await step({ op: 'trigger', event: 'manual' })
    await step({ op: 'place', kind: 'exit', reason: 'completed' })
    await step({ op: 'place', kind: 'condition', fact: 'is_vip', operator: 'is_true' })
    await step({ op: 'connect', outlet: 'entered:default', to: 'condition_1' })

    const shapes: readonly (readonly [string, Record<string, string>])[] = [
      ['out of an exit', { op: 'connect', outlet: 'exit_1:default', to: 'condition_1' }],
      ['into the trigger', { op: 'connect', outlet: 'condition_1:true', to: 'entered' }],
      [
        'on a branch the kind does not declare',
        { op: 'connect', outlet: 'condition_1:default', to: 'exit_1' },
      ],
      ['a second edge on one branch', { op: 'connect', outlet: 'entered:default', to: 'exit_1' }],
    ]
    for (const [what, form] of shapes) {
      const response = await post(builderPath(KEYS.scratch), { ...form, draft })
      expect(response.status, what).toBe(422)
      expect(await response.text(), what).toContain('data-refusal="edge_not_offered"')
    }

    // The control: an edge the page DID offer is accepted, so the four refusals are about those four
    // shapes and not about a handler that refuses every connection.
    const accepted = await post(builderPath(KEYS.scratch), {
      draft,
      op: 'connect',
      outlet: 'condition_1:true',
      to: 'exit_1',
    })
    expect(accepted.status).toBe(200)
  }, 120_000)
})

// ------------------------------------------------------------------------------------------------
// Accessibility and the capture matrix
// ------------------------------------------------------------------------------------------------

/** Three widths x two themes x two directions. Twelve renders, stated rather than counted afterwards. */
const CELLS = [390, 768, 1440].flatMap((width) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    (['ltr', 'rtl'] as const).map((direction) => ({
      width,
      height: width === 390 ? 844 : 1024,
      theme,
      direction,
    })),
  ),
)

/**
 * The rendered background, as the engine resolved it.
 *
 * Read rather than asserted against a literal: a hex or `rgb()` in this file would be an un-tokened
 * colour and `pnpm colours` would reject it. The claim that matters is that the dark cell really is
 * darker, so the theme axis is a rendered difference rather than a filename.
 */
async function backgroundLuminance(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const colour = globalThis.getComputedStyle(document.body).backgroundColor
    const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  })
}

async function withCell<T>(
  cell: (typeof CELLS)[number],
  path: string,
  body: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  try {
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    const page = await context.newPage()
    const separator = path.includes('?') ? '&' : '?'
    const url = cell.direction === 'rtl' ? `${BASE}${path}${separator}dir=rtl` : `${BASE}${path}`
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

describe('acceptance — axe reports nothing serious or critical on the builder', () => {
  it('audits the builder at 390/768/1440 x light/dark x ltr/rtl, twelve renders', async () => {
    // Twelve, stated rather than counted after the fact: a matrix that lost an axis would report a pass
    // over six renders.
    expect(CELLS).toHaveLength(12)
    const luminance: Record<string, number> = {}
    let audited = 0
    for (const cell of CELLS) {
      const where = `${cell.theme} ${cell.direction} ${cell.width}px`
      const { violations, width, dir, lum } = await withCell(
        cell,
        builderPath(KEYS.pinned),
        async (page) => {
          const result = await auditPage(page, {
            page: '/crm/flows/[id]/builder',
            viewport: {
              name: `${cell.width}`,
              width: cell.width,
              height: cell.height,
              scale: 1,
              why: 'C-AUTO-09 acceptance',
            },
            theme: cell.theme,
            direction: cell.direction,
          })
          return {
            violations: result.violations,
            width: await page.evaluate(() => globalThis.innerWidth),
            dir: await page.evaluate(() => document.documentElement.dir),
            lum: await backgroundLuminance(page),
          }
        },
      )
      expect(width, `${where}: viewport`).toBe(cell.width)
      // The direction axis is REAL: the document really is mirrored, so twelve identical LTR renders
      // cannot satisfy the assertions in this case or in the capture case below. Without this the rtl
      // half of the matrix would be six duplicates of the ltr half and nothing would say so.
      expect(dir, `${where}: dir`).toBe(cell.direction)
      luminance[where] = lum
      const blocking = blockingViolations(violations)
      expect(
        blocking.map(describeViolation),
        `${where}: ${blocking.length} serious/critical violation(s)`,
      ).toEqual([])
      audited += 1
    }
    expect(audited).toBe(12)
    // And the theme axis is real too: the dark cell resolved a darker ground at every width, in both
    // directions. Read from the engine rather than compared with a literal, because a hex in this file
    // would be an un-tokened colour and `pnpm colours` would reject it, rightly.
    for (const direction of ['ltr', 'rtl']) {
      for (const width of [390, 768, 1440]) {
        expect(
          luminance[`dark ${direction} ${width}px`],
          `dark ${direction} ${width}px is darker than light`,
        ).toBeLessThan(luminance[`light ${direction} ${width}px`] ?? 0)
      }
    }
  }, 900_000)

  it('reports a known-bad version of this page by rule id', async () => {
    // The control on the audit. A sweep reporting zero because axe never ran would pass the case above
    // for ever (ADR 0003), so the page is audited again with an unlabelled button injected into the DOM.
    const violations = await withCell(
      { width: 390, height: 844, theme: 'light', direction: 'ltr' },
      builderPath(KEYS.pinned),
      async (page) => {
        await page.evaluate(() => {
          const button = document.createElement('button')
          button.type = 'button'
          document.body.append(button)
        })
        const result = await auditPage(page, {
          page: '/crm/flows/[id]/builder (known-bad)',
          viewport: { name: '390', width: 390, height: 844, scale: 1, why: 'the control' },
          theme: 'light',
          direction: 'ltr',
        })
        return result.violations
      },
    )
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(blockingViolations(violations).map((violation) => violation.id)).toContain('button-name')
  }, 180_000)
})

describe('acceptance — two consecutive captures with animations disabled are byte-identical', () => {
  it('captures the builder at 3 viewports x 2 themes x 2 directions twice, with zero pixel diff', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const cell of CELLS) {
      const label = `builder__${cell.theme}-${cell.width}__${cell.direction}`
      /*
        The claim is about the PAGE: it renders from a database, and a document printing a relative time
        or a generated id could not render identically twice. Through `captureUntilStable` rather than
        comparing capture one with capture two, because that also asserts paint had settled by the first
        capture — untrue at load 10 on a four-core box.

        This page prints the instant it read the counts at, which is a wall clock — so it is pinned with
        `?at=` … it is not: the builder takes no instant from the query, deliberately (a query parameter
        that changes what a screen shows about a journey is a parameter somebody can put in a link). What
        makes the capture stable is that `DETERMINISM_CSS` hides the one element carrying it, which is
        how the other admin screens photograph a live clock.
      */
      const stable = await captureUntilStable(
        () =>
          withCell(cell, builderPath(KEYS.pinned), async (page) => {
            // The instant is the only thing on this page that changes between two reads, so it is
            // covered for the capture and asserted elsewhere. Hiding rather than freezing, because the
            // page must go on printing it for a reader.
            await page.addStyleTag({
              content: 'main > p:first-of-type { visibility: hidden; }',
            })
            return await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' })
          }),
        { label },
      )
      expect(stable.png.byteLength, label).toBeGreaterThan(1000)
      expect(stable.attemptsUsed, `${label} settled in`).toBeLessThanOrEqual(5)
      shots.set(label, stable.png)
      writeFileSync(join(SCREENS, `${label}.png`), stable.png)
    }
    expect(shots.size).toBe(12)

    // The control on the comparison: two DIFFERENT cells are not identical. Without it, a screenshot
    // function returning the same bytes every time would pass every assertion above.
    const differs = (left: string, right: string): number =>
      Buffer.compare(
        Buffer.from(shots.get(left) ?? new Uint8Array()),
        Buffer.from(shots.get(right) ?? new Uint8Array()),
      )
    expect(differs('builder__light-390__ltr', 'builder__dark-390__ltr')).not.toBe(0)
    expect(differs('builder__light-390__ltr', 'builder__light-1440__ltr')).not.toBe(0)
    // The mirrored render differs from the one it mirrors, which is what makes the rtl half of the
    // matrix six renders rather than six copies.
    expect(differs('builder__light-390__ltr', 'builder__light-390__rtl')).not.toBe(0)
  }, 900_000)
})
