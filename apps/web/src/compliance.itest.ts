import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Actor,
  completeObligationInstance,
  createConnection,
  fileObligationEvidence,
  generateObligationInstances,
  issueObligationEvidenceGrant,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { auditPage, blockingViolations, describeViolation } from '@berelax/harness/accessibility'
import {
  captureUntilStable,
  DETERMINISM_CSS,
  DETERMINISTIC_LAUNCH_ARGS,
} from '@berelax/harness/determinism'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appMediaStorage, repositoryRoot } from './media/storage.ts'

/**
 * M-VAT-11 — the compliance calendar, the open-questions dashboard and the private evidence download,
 * driven against the built application.
 *
 * Four claims live here and nowhere else, because none can be checked by reading source: the two screens
 * answer HTML with the noindex header the registry says they carry; **axe** reports nothing serious or
 * critical on a rendered DOM at three viewports in two themes; the same routes photographed twice produce
 * **byte-identical images**; and the evidence route answers **403 without a grant** and writes an
 * `audit_event` for every download that succeeds.
 *
 * ## Why three viewports and two themes, and no direction axis
 *
 * Both screens are route handlers serving one English document, and that is a decision rather than an
 * omission: W-SITE-01's registry requires every *document* to be served in both locales, so a `page.tsx`
 * would need an Arabic admin document and the W-SYS-01 shell. The Messages inbox, the breakpoint preview
 * and the HR credentials screen are the three precedents. The acceptance criterion asks for three
 * viewports for exactly that reason; the theme axis is added because a compliance banner told apart by
 * colour has to be legible in both, and the audit asserts the dark render really is darker.
 *
 * ## Isolation, and the one row this file cannot take back
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind (brief
 * rule 12), so every assertion narrows the page with `?key=` and every screenshot is taken at a fixed
 * `?at=`. A page showing every occurrence in a shared database would diff the moment another unit
 * generated one.
 *
 * The evidence row is permanent and that is stated rather than hidden. `obligation_evidence` is
 * append-only — ZO004 refuses DELETE for every role including the owner — and the occurrence beneath it is
 * ON DELETE RESTRICT, so filing an attachment that a SEPARATE PROCESS then downloads over HTTP cannot be
 * rolled back the way `apps/worker`'s suite rolls its own back. So this file files exactly one, against
 * one `event_driven` probe obligation whose cadence generates nothing, marks the occurrence COMPLETED with
 * it, and leaves all three rows in place: a completed occurrence appears in no section of the dashboard
 * and adds nothing to any overdue count, which is why this is the shape chosen rather than an open one.
 */
/**
 * Assigned in `beforeAll`, because the port is ACQUIRED rather than drawn — see
 * `packages/harness/src/server.ts`. This suite was written against a base where each file spawned
 * `next start` itself; it is the thirteenth, and `test-ports.test.ts` refuses a private spawn now, so
 * the conversion happened at merge rather than being discovered later as a leaked temp root.
 */
let BASE = ''
const SCREENS = join(repositoryRoot(), 'artifacts', 'screens', 'M-VAT-11')

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const RUN = `${process.pid}${Math.floor(Math.random() * 1e6)}`
const MARKER = 'mvat11 compliance screens itest'
const ACTOR: Actor = { kind: 'staff', label: MARKER }

/**
 * The fixed instant every screenshot and every assertion is taken at.
 *
 * A fixed `?at=` is what makes a repeat capture byte-identical: the page prints the date it judged
 * against, so a render that read the clock could not be photographed twice. 2093 is a year no other suite
 * dates rows in, and the premises has no `business_day` row for it — so the calendar's as-of resolution
 * falls back to the Dubai CALENDAR date, which is `resolveTradingDate`'s `premises_closed` answer and is
 * correct: on a date the salon does not open there is no trading date for an obligation to be judged in.
 */
const AT = '2093-05-20T12:00:00Z'
const AS_OF = '2093-05-20'

/** The probe whose evidence is permanent. `event_driven`, so no generator ever adds an occurrence. */
const EVIDENCE_KEY = 'mvat11_web_evidence_probe'
/** An overdue probe, so the dashboard's third section is non-empty and the banner has something to say. */
const OVERDUE_KEY = 'mvat11_web_overdue_probe'
/** A seeded UNVERIFIED duty and a seeded CONFIRMED one with no deadline, for the other two sections. */
const SEEDED_UNVERIFIED = 'vat_return_filing'
const SEEDED_NO_DEADLINE = 'trade_licence_renewal'

const EVIDENCE_DUE = '2093-01-31'
const OVERDUE_DUE = '2093-03-31'

/** 64 hex characters, which 0052's CHECK requires. Distinctive, so this file's row is findable. */
const CONTENT_HASH = `beef${RUN.replace(/[^0-9a-f]/g, 'a')}`.padEnd(64, 'c').slice(0, 64)
const STORAGE_KEY = `compliance/evidence/${RUN}.txt`
const EVIDENCE_BYTES = new TextEncoder().encode(`mvat11 evidence probe ${RUN}\n`)

/** The calendar and the dashboard, narrowed to this file's rows. */
const CALENDAR_PATH =
  `/compliance?at=${encodeURIComponent(AT)}` + `&key=${EVIDENCE_KEY}&key=${OVERDUE_KEY}`
const DASHBOARD_PATH =
  `/compliance/unverified?at=${encodeURIComponent(AT)}` +
  `&key=${SEEDED_UNVERIFIED}&key=${SEEDED_NO_DEADLINE}&key=${OVERDUE_KEY}`

let server: WebServer
let browser: Browser
let sql: Sql
let evidenceId: string
let grantToken: string

/** A count over an append-only table, in SQL. Subtracted, never read as a total (brief rule 9). */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count from audit_event where action = ${action}
  `
  return Number(row?.count ?? '0')
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })

  /*
    No `anchor_on`. Two things depend on that, and both of them matter.

    Rule 15 first: an anchor IS a renewal date read off a document, and these two probes have no document
    behind them. The occurrence each one needs is stated directly to `generateObligationInstances` below,
    which takes `dueOn` per row and never consults the definition's anchor — so the anchor was never
    load-bearing here.

    And the isolation: `packages/db/src/services/obligation-blocking.itest.ts` and
    `packages/fixtures/src/obligation-calendar.itest.ts` both enumerate EVERY row of `obligation` and
    assert that none carries an anchor, because 0052 seeds none. The evidence probe below is permanent —
    see this file's header — so an anchor on it would fail those two suites in every run of the integration
    suite from now on, which is a real defect in this file rather than a false alarm in theirs.
  */
  await sql`
    insert into obligation
      (key, title, obligation_class, cadence, subject_scope, owner_role, blocking_effect,
       evidence_required, source_reference)
    values
      (${EVIDENCE_KEY}, ${'Probe: a completed duty with its attachment on file'}, 'hygiene',
       'event_driven', 'business', 'manager', 'none', true, 'docs/04-uae-compliance.md §9'),
      (${OVERDUE_KEY}, ${'Probe: a duty whose deadline has passed'}, 'hygiene',
       'event_driven', 'business', 'manager', 'none', false, 'docs/04-uae-compliance.md §9')
    on conflict (key) do nothing
  `
  // An older revision of this file inserted the two probes WITH an anchor, so a database that has already
  // run it still carries one on the permanent row. Cleared here rather than by hand, because the two
  // suites above would otherwise keep failing on a developer machine long after this file stopped writing
  // it.
  await sql`
    update obligation set anchor_on = null
     where key in (${EVIDENCE_KEY}, ${OVERDUE_KEY}) and anchor_on is not null
  `
  await generateObligationInstances(sql, [
    { obligationKey: EVIDENCE_KEY, dueOn: EVIDENCE_DUE },
    { obligationKey: OVERDUE_KEY, dueOn: OVERDUE_DUE },
  ])

  const [occurrence] = await sql<{ id: string }[]>`
    select i.id::text as id from obligation_instance i
      join obligation o on o.id = i.obligation_id
     where o.key = ${EVIDENCE_KEY} and i.due_on = ${EVIDENCE_DUE}::date
  `
  const instanceId = occurrence?.id as string

  const [already] = await sql<{ id: string }[]>`
    select id::text as id from obligation_evidence
     where obligation_instance_id = ${instanceId}::uuid and content_hash = ${CONTENT_HASH}
  `
  evidenceId =
    already?.id ??
    (
      await withUnitOfWork(sql, ACTOR, (uow) =>
        fileObligationEvidence(uow, {
          instanceId,
          storageKey: STORAGE_KEY,
          contentHash: CONTENT_HASH,
          uploadedByLabel: MARKER,
        }),
      )
    ).evidenceId

  // Completed WITH its attachment, which is the only way 0052 permits a completion of a duty that
  // requires one — and it is what keeps this permanent row out of every overdue count for ever.
  const [status] = await sql<{ status: string }[]>`
    select status::text as status from obligation_instance where id = ${instanceId}::uuid
  `
  if (status?.status === 'open') {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      completeObligationInstance(uow, { instanceId, role: 'manager', actorLabel: MARKER }),
    )
  }

  // The bytes, in the private bucket the route reads. The fake adapter writes them under
  // `artifacts/media-outbox`, which `mediaOutboxRoot()` anchors on the repository root so the suite and
  // the server agree about where it is whatever each one's working directory happens to be.
  await appMediaStorage().put({
    bucket: 'private',
    key: STORAGE_KEY,
    body: EVIDENCE_BYTES,
    contentType: 'text/plain; charset=utf-8',
    cacheControl: 'private, no-store',
  })

  grantToken = (
    await withUnitOfWork(sql, ACTOR, (uow) =>
      issueObligationEvidenceGrant(uow, {
        evidenceId,
        role: 'manager',
        actorLabel: MARKER,
        purpose: 'the integration suite reading one filed attachment',
      }),
    )
  ).token

  server = await startWebServer({
    suite: 'compliance',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/compliance',
    readyWithinMs: 90_000,
    env: {
      // These routes call `loadConfig()`, so the two values they need are declared rather than assumed —
      // the same note the Messages inbox makes: a local run that exported only TEST_DATABASE_URL would
      // otherwise get a 503 that reads like a broken route.
      APP_ENV: process.env['APP_ENV'] ?? 'test',
      DATABASE_URL: url,
    },
  })
  BASE = server.origin
  // The shared list, not a hand-written one: `--disable-skia-runtime-opts` and `--disable-lcd-text` are
  // what make the repeat capture below byte-identical. See `packages/harness/src/determinism.ts`.
  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await server?.stop()
  // The grants go — they are the one revocable part, which is the whole reason the capability is a stored
  // row rather than a signature. The evidence, its occurrence and the two probe definitions stay: see this
  // file's header for why, and note that `obligation_notice` would cascade with the occurrence if any pass
  // had planned one (an `event_driven` cadence generates none).
  await sql`
    delete from obligation_evidence_grant
     where obligation_evidence_id in (
       select id from obligation_evidence where content_hash = ${CONTENT_HASH}
     )
  `
  await sql`
    delete from obligation_instance
     where obligation_id in (select id from obligation where key = ${OVERDUE_KEY})
  `
  await sql`delete from obligation where key = ${OVERDUE_KEY}`
  await sql?.end({ timeout: 5 })
})

interface Cell {
  readonly width: number
  readonly height: number
  readonly theme: 'light' | 'dark'
}

/** Three viewports x two themes. The phone, the front desk and the laptop; light and dark. */
const CELLS: readonly Cell[] = (['light', 'dark'] as const).flatMap((theme) =>
  [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ].map((viewport) => ({ ...viewport, theme })),
)

async function withCell<T>(
  cell: Cell,
  pagePath: string,
  body: (page: Page) => Promise<T>,
): Promise<T> {
  const context: BrowserContext = await browser.newContext({
    viewport: { width: cell.width, height: cell.height },
    deviceScaleFactor: 1,
    colorScheme: cell.theme,
    locale: 'en-AE',
    timezoneId: 'Asia/Dubai',
    reducedMotion: 'reduce',
  })
  try {
    // The esbuild `keepNames` shim: Playwright serialises a callback's compiled source into the page.
    await context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || ((fn) => fn)',
    })
    const page = await context.newPage()
    await page.goto(`${BASE}${pagePath}`, { waitUntil: 'networkidle' })
    await page.addStyleTag({ content: DETERMINISM_CSS })
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    return await body(page)
  } finally {
    await context.close()
  }
}

/**
 * The rendered background, as the engine resolved it.
 *
 * Read rather than asserted against a literal: a hex or `rgb()` in this file would be an un-tokened colour
 * and `pnpm colours` would reject it, rightly. The claim that matters is the one made below — the dark
 * cell really is darker — so the theme axis is a rendered difference rather than a filename.
 */
async function backgroundLuminance(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const colour = globalThis.getComputedStyle(document.body).backgroundColor
    const [r = 0, g = 0, b = 0] = (colour.match(/\d+(\.\d+)?/g) ?? []).map(Number)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  })
}

describe('acceptance — the calendar answers HTML, noindex, and names what is overdue', () => {
  it('serves the calendar with the robots header the registry declares', async () => {
    const response = await fetch(`${BASE}${CALENDAR_PATH}`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    // Derived from the registry by the proxy rather than hand-written per route: `/compliance` is a prefix
    // in ADMIN_GROUP_PREFIXES, so the next route under it arrives noindex before it is written.
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(response.headers.get('cache-control')).toContain('no-store')

    const html = await response.text()
    expect(html).toContain(`Judged against ${AS_OF}`)
    expect(html).toContain(OVERDUE_KEY)
    expect(html).toContain(EVIDENCE_KEY)
    // The escalation ladder is shown per obligation, which is what makes an escalation accountable on the
    // screen and not only in the schema: the manager's duty escalates to the owner.
    expect(html).toContain('manager')
    expect(html).toContain('owner')
    // The evidence is named by the first twelve characters of its content hash and NEVER by its storage
    // key: the key is a path into the private bucket.
    expect(html).toContain(CONTENT_HASH.slice(0, 12))
    expect(html).not.toContain(STORAGE_KEY)
  }, 60_000)

  it('counts an unanswered question separately from an overdue deadline', async () => {
    // The trap, on the screen. The two banners are separate and the unconfirmed one links to its own page;
    // a single count would report six breaches on a calendar where nothing blocking is overdue at all.
    const withQuestion = await (
      await fetch(`${BASE}/compliance?at=${encodeURIComponent(AT)}&key=${SEEDED_UNVERIFIED}`)
    ).text()
    expect(withQuestion).toContain('1 unconfirmed')
    expect(withQuestion).toContain('/compliance/unverified')
    // `vat_return_filing` has no due date on file, so nothing of it can be overdue — and the blocking
    // banner says exactly that rather than counting the question.
    expect(withQuestion).toContain('Nothing blocking is overdue')

    // The control: a page narrowed to a CONFIRMED obligation raises no question banner, so the banner
    // above is about the flag rather than about something every page prints.
    const withoutQuestion = await (
      await fetch(`${BASE}/compliance?at=${encodeURIComponent(AT)}&key=${OVERDUE_KEY}`)
    ).text()
    expect(withoutQuestion).not.toContain('unconfirmed duty(ies)')
  }, 60_000)

  it('refuses an unparseable ?at= rather than quietly answering for today', async () => {
    const response = await fetch(`${BASE}/compliance?at=not-a-date`)
    // A query parameter that silently did nothing would make "as of the 31st" answer for today and look
    // right. 503 with the reason, which is the same failure shape the credentials screen uses.
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('could not be read')
  }, 30_000)
})

describe('acceptance — the dashboard lists exactly the obligations flagged unverified', () => {
  it('counts the unconfirmed duties, and the count is the number of flagged rows', async () => {
    const flagged = await sql<{ key: string; open_question_id: string }[]>`
      select key, open_question_id from obligation where is_unverified order by key
    `
    expect(flagged.length).toBeGreaterThan(0)
    const html = await (
      await fetch(`${BASE}/compliance/unverified?at=${encodeURIComponent(AT)}`)
    ).text()
    // The count the acceptance criterion names, read off the rendered page.
    expect(html).toContain(`Unconfirmed duties: <span class="count">${flagged.length}</span>`)
    // And every flagged obligation is actually listed, with the open question that would settle it — a
    // count alone would be satisfied by a page that printed a number and no rows.
    for (const row of flagged) {
      expect(html, row.key).toContain(row.key)
      expect(html, row.key).toContain(row.open_question_id)
    }
    // The control: an obligation that is NOT flagged is absent from that section. `trade_licence_renewal`
    // is confirmed and has no deadline on file, so it belongs to the second section instead.
    expect(flagged.map((row) => row.key)).not.toContain(SEEDED_NO_DEADLINE)
    expect(html).toContain('Confirmed, no deadline on file')
  }, 60_000)

  it('ties every flagged obligation back to a docs/04 section that really is [UNVERIFIED]', async () => {
    // The other half of "seeded from docs/04-uae-compliance.md". A count that matched a number in a
    // document nobody read would be a coincidence; this asserts the SOURCE each row cites is a section of
    // that file which genuinely carries the marker.
    const doc = readFileSync(join(repositoryRoot(), 'docs', '04-uae-compliance.md'), 'utf8')
    const unverifiedSections = new Set<string>()
    let current = ''
    for (const line of doc.split('\n')) {
      const heading = /^##\s+(\d+)\./.exec(line)
      if (heading?.[1] !== undefined) current = heading[1]
      if (line.includes('[UNVERIFIED]') && current !== '') unverifiedSections.add(current)
    }
    expect(unverifiedSections.size).toBeGreaterThan(0)

    const flagged = await sql<{ key: string; source_reference: string }[]>`
      select key, source_reference from obligation where is_unverified order by key
    `
    for (const row of flagged) {
      const cited = [...row.source_reference.matchAll(/§\s*(\d+)/g)].map((match) => match[1])
      expect(cited.length, `${row.key} cites no section`).toBeGreaterThan(0)
      expect(
        cited.some((section) => section !== undefined && unverifiedSections.has(section)),
        `${row.key} cites §${cited.join(', §')} and none of those sections is [UNVERIFIED] in docs/04`,
      ).toBe(true)
    }
    // The control on the parser: a section that is NOT marked is not in the set, so the assertion above is
    // not passing because every section matched. §10 is consumer protection and carries no marker.
    expect(unverifiedSections.has('10')).toBe(false)
  }, 60_000)

  it('keeps an overdue deadline out of the unconfirmed count and in its own section', async () => {
    const html = await (await fetch(`${BASE}${DASHBOARD_PATH}`)).text()
    // Three sections, three counts. The overdue probe is confirmed, so it is a breach and not a question.
    expect(html).toContain('Unconfirmed duties: <span class="count">1</span>')
    expect(html).toContain('Confirmed, no deadline on file: <span class="count">1</span>')
    expect(html).toContain('Overdue: <span class="count">1</span>')
    expect(html).toContain(OVERDUE_DUE)
    // The distinction in words, because the words are what stops somebody adding the numbers together.
    expect(html).toContain('<strong>None of these is overdue</strong>')
    expect(html).toContain('This is the only section that reports a breach')
  }, 60_000)
})

describe('acceptance — evidence attachments are private', () => {
  it('answers 403 for an unsigned fetch, and for every other kind of bad grant', async () => {
    for (const [query, reason] of [
      ['', 'grant_absent'],
      ['?grant=', 'grant_absent'],
      ['?grant=not-a-grant', 'grant_unknown'],
    ] as const) {
      const response = await fetch(`${BASE}/compliance/evidence/${evidenceId}${query}`)
      expect(response.status, `${query || '(no grant)'}`).toBe(403)
      expect(await response.text()).toContain(reason)
    }
    // A 404 for an id that does not exist and a 403 for one that does would answer "has an inspection
    // report been filed against this occurrence" to anybody who can guess a uuid, so an unknown id is 403
    // as well.
    const unknown = await fetch(
      `${BASE}/compliance/evidence/00000000-0000-4000-8000-0000000000ff?grant=${grantToken}`,
    )
    expect(unknown.status).toBe(403)
  }, 60_000)

  it('serves the bytes for a valid grant, and writes an audit_event for every download', async () => {
    const before = await auditCount('compliance.obligation_evidence.downloaded')

    const first = await fetch(`${BASE}/compliance/evidence/${evidenceId}?grant=${grantToken}`)
    expect(first.status).toBe(200)
    // An attachment, and never the stored content type: a hygiene report is whatever an inspector handed
    // over, and rendering an untrusted upload inline in an admin origin is the stored-XSS path a
    // `Content-Disposition` closes.
    expect(first.headers.get('content-type')).toBe('application/octet-stream')
    expect(first.headers.get('content-disposition')).toContain('attachment;')
    expect(first.headers.get('cache-control')).toContain('no-store')
    expect(first.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(EVIDENCE_BYTES)

    // The SECOND download of the same link. Two rows, because a second download is a second copy leaving
    // the business and a trail that recorded only the first would answer the inspection's question wrongly.
    const second = await fetch(`${BASE}/compliance/evidence/${evidenceId}?grant=${grantToken}`)
    expect(second.status).toBe(200)
    // A delta over an append-only table, never a total (brief rule 9).
    expect(await auditCount('compliance.obligation_evidence.downloaded')).toBe(before + 2)

    // And the row names the bytes it served by content hash, which is what a substituted re-upload would
    // break. The storage key is deliberately absent: it is a path into the private bucket.
    const [row] = await sql<{ hash: string; key: string | null }[]>`
      select after_state->>'contentHash' as hash, after_state->>'storageKey' as key
        from audit_event
       where action = 'compliance.obligation_evidence.downloaded'
         and entity_id = ${evidenceId}
       order by occurred_at desc limit 1
    `
    expect(row?.hash).toBe(CONTENT_HASH)
    expect(row?.key).toBeNull()
  }, 60_000)

  it('and an expired grant is refused, with the bytes still in the bucket', async () => {
    const expired = await withUnitOfWork(sql, ACTOR, (uow) =>
      issueObligationEvidenceGrant(uow, {
        evidenceId,
        role: 'manager',
        actorLabel: MARKER,
        purpose: 'the expiry case',
        ttlSeconds: 60,
      }),
    )
    // Both instants move, because `expires_at > created_at` is a CHECK: a grant that had already expired
    // when it was written would read on the screen as a broken link rather than as a lapsed one.
    await sql`
      update obligation_evidence_grant
         set created_at = now() - interval '10 minutes', expires_at = now() - interval '5 minutes'
       where id = ${expired.grantId}::uuid
    `
    const response = await fetch(`${BASE}/compliance/evidence/${evidenceId}?grant=${expired.token}`)
    expect(response.status).toBe(403)
    expect(await response.text()).toContain('grant_expired')
    // The control: the VALID grant still works, so the refusal above is about the expiry and not about the
    // file having gone missing.
    expect(
      (await fetch(`${BASE}/compliance/evidence/${evidenceId}?grant=${grantToken}`)).status,
    ).toBe(200)
  }, 60_000)
})

describe('acceptance — axe reports nothing serious or critical, in twelve renders', () => {
  it('audits both screens at 390/768/1440 x light/dark, and each render is the cell it claims', async () => {
    // Twelve, stated rather than counted after the fact: a matrix that lost an axis would report a pass
    // over six renders.
    expect(CELLS).toHaveLength(6)
    const luminance: Record<string, number> = {}
    let audited = 0
    for (const [label, path] of [
      ['calendar', CALENDAR_PATH],
      ['dashboard', DASHBOARD_PATH],
    ] as const) {
      for (const cell of CELLS) {
        const where = `${label} ${cell.theme} ${cell.width}px`
        const { violations, width, lum } = await withCell(cell, path, async (page) => {
          const result = await auditPage(page, {
            page: label === 'calendar' ? '/compliance' : '/compliance/unverified',
            viewport: {
              name: `${cell.width}`,
              width: cell.width,
              height: cell.height,
              scale: 1,
              why: 'M-VAT-11 acceptance',
            },
            theme: cell.theme,
            direction: 'ltr',
          })
          return {
            violations: result.violations,
            width: await page.evaluate(() => globalThis.innerWidth),
            lum: await backgroundLuminance(page),
          }
        })
        expect(width, `${where}: viewport`).toBe(cell.width)
        luminance[where] = lum
        const blocking = blockingViolations(violations)
        expect(
          blocking.map(describeViolation),
          `${where}: ${blocking.length} serious/critical violation(s)`,
        ).toEqual([])
        audited += 1
      }
    }
    expect(audited).toBe(12)
    // The theme axis is real: the dark cell resolved a darker ground at every width, on both screens.
    // Without this, twelve identical light renders would satisfy every assertion above.
    for (const label of ['calendar', 'dashboard']) {
      for (const width of [390, 768, 1440]) {
        expect(
          luminance[`${label} dark ${width}px`],
          `${label} dark ${width}px is darker than light`,
        ).toBeLessThan(luminance[`${label} light ${width}px`] ?? 0)
      }
    }
  }, 900_000)

  it('reports the two defects a known-bad version of these pages has, by rule id', async () => {
    // The control on the audit itself. A sweep that reported zero because axe never ran would pass the
    // test above for ever (ADR 0003), so the calendar is audited again with an unlabelled button and body
    // text on the decorative gold — the two failures docs/08 fences off — injected into the DOM.
    const violations = await withCell(
      { width: 390, height: 844, theme: 'light' },
      CALENDAR_PATH,
      async (page) => {
        await page.evaluate(() => {
          const button = document.createElement('button')
          button.type = 'button'
          document.body.append(button)
          const text = document.createElement('p')
          text.textContent = 'Acknowledge this obligation'
          // The decorative gold on the sand surface: 2.90:1, and the reason --color-decor-gold never
          // carries text. Read from the token layer rather than typed, so this file states no colour.
          const root = globalThis.getComputedStyle(document.documentElement)
          text.style.color = root.getPropertyValue('--color-decor-gold')
          text.style.backgroundColor = root.getPropertyValue('--color-surface-sand')
          document.body.append(text)
        })
        const result = await auditPage(page, {
          page: '/compliance (known-bad)',
          viewport: { name: '390', width: 390, height: 844, scale: 1, why: 'the control' },
          theme: 'light',
          direction: 'ltr',
        })
        return result.violations
      },
    )
    const ids = violations.map((violation) => violation.id)
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('button-name')
    expect(ids, JSON.stringify(violations.map(describeViolation))).toContain('color-contrast')
    expect(blockingViolations(violations).map((violation) => violation.id)).toContain('button-name')
  }, 180_000)
})

describe('acceptance — the same routes photographed twice are byte-identical', () => {
  it('captures both screens at 3 viewports x 2 themes twice, with zero pixel diff', async () => {
    mkdirSync(SCREENS, { recursive: true })
    const shots = new Map<string, Uint8Array>()
    for (const [name, path] of [
      ['calendar', CALENDAR_PATH],
      ['dashboard', DASHBOARD_PATH],
    ] as const) {
      for (const cell of CELLS) {
        const label = `${name}__${cell.theme}-${cell.width}`
        /*
          The claim is about the PAGE: it renders from a database, and a document printing a relative time
          or a generated id could not render identically twice. Through `captureUntilStable` rather than
          comparing capture one to capture two, because that also asserts paint had settled by the first
          capture — untrue at load 10 on a four-core box. The helper throws
          `[screenshot-never-stabilised]` when no two CONSECUTIVE captures ever agree, which is exactly
          what a clock in the render produces.
        */
        const stable = await captureUntilStable(
          () =>
            withCell(cell, path, (page) =>
              page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' }),
            ),
          { label },
        )
        expect(stable.png.byteLength, label).toBeGreaterThan(1000)
        expect(stable.attemptsUsed, `${label} settled in`).toBeLessThanOrEqual(5)
        shots.set(label, stable.png)
        writeFileSync(join(SCREENS, `${label}__ltr.png`), stable.png)
      }
    }
    expect(shots.size).toBe(12)

    // The control on the comparison: two DIFFERENT cells are not identical. Without it, a screenshot
    // function that returned the same bytes every time would pass every assertion above.
    const differs = (left: string, right: string): number =>
      Buffer.compare(
        Buffer.from(shots.get(left) ?? new Uint8Array()),
        Buffer.from(shots.get(right) ?? new Uint8Array()),
      )
    expect(differs('calendar__light-390', 'calendar__dark-390')).not.toBe(0)
    expect(differs('calendar__light-390', 'calendar__light-1440')).not.toBe(0)
    expect(differs('calendar__light-390', 'dashboard__light-390')).not.toBe(0)
  }, 900_000)
})
