import {
  ASIA_DUBAI,
  assertPublicDisplayNameCompliant,
  type CompliancePolicy,
  fromLocal,
  hoursFromSchedule,
  localDate,
  localTime,
  resolveTradingDate,
  type TradingHours,
} from '@berelax/core'
import {
  createConnection,
  DOCS_13_PRICE_POINT_COUNT,
  ensureLegalEntity,
  PREMISES_NAP,
  readCompliancePolicy,
  readPremisesFacts,
  type Sql,
  seedCatalogue,
  seedPremises,
  unconfirmedAssumptionRows,
  WHATSAPP_CANDIDATES,
  WHATSAPP_PENDING,
} from '@berelax/db'
import { type Facts, factsSchema } from '@berelax/shared'
import { NapBlock } from '@berelax/ui/patterns'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NAP_COPY_EN } from '../app/_dev/nap-copy.ts'
import { buildFacts, factsEtag } from './facts/build.ts'
import { factsResponse, llmsPages, llmsResponse, robotsResponse } from './facts/handlers.ts'
import { lintLlmsTxt } from './facts/llms.ts'
import { DEFAULT_LOCALE, localisedPath } from './i18n/locales.ts'
import { absoluteUrl, siteOrigin } from './routes/alternates.ts'
import { ROUTES } from './routes/registry.ts'

/**
 * W-SITE-02 — the premises row as the only NAP source, against a real database.
 *
 * What is decidable from source is in `apps/web/src/facts.test.ts`: the shape of the payload, the ETag's
 * independence from the clock, the robots groups, the lint. Nothing there touches the business. This file
 * is the other half, and every assertion in it compares a **surface** against the **row** rather than
 * against a literal — which is the acceptance criterion's own wording, and the only form of the claim that
 * cannot be satisfied by two copies of the same mistake.
 *
 * ## Why the handlers are called directly rather than over HTTP
 *
 * `factsResponse`, `llmsResponse` and `robotsResponse` take their dependencies as an argument, exactly as
 * `handleOtpRequest` does, so a `Request` in and a `Response` out is the whole contract. Starting
 * `next start` would add ninety seconds and a port collision to prove the same three things — and the ETag,
 * the 304 and the content types are decided in the handler, not by the framework. That the paths are served
 * at all is asserted by `route-spine.itest.ts`, which compares the registry against
 * `.next/app-path-routes-manifest.json`.
 *
 * ## What it writes
 *
 * The seed, which is idempotent and is the values the migration seeds — brief rule 12's third case, and the
 * reason this file calls `seedPremises` rather than inserting its own premises row. Everything else is
 * inside a transaction that ends in a rollback, because the integration suite shares one database and a
 * mutated `premises` row would be read by every later file as the business's real address.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql
let policy: CompliancePolicy

/** Thrown to roll a probe back. Any error rolls `sql.begin` back; a named one cannot be mistaken. */
const ROLLBACK = 'wsite02-probe-rollback'

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

/** A fixed clock, so two responses differ in nothing but what the row says. */
const NOW = '2026-09-18T12:00:00.000Z'
const deps = (from: Sql) => ({ sql: from, now: () => NOW })

async function factsFrom(from: Sql = sql): Promise<Facts> {
  const read = await readPremisesFacts(from)
  if (read === null) throw new Error('the premises singleton is missing after the seed')
  return buildFacts(read, { generatedAt: NOW, origin: siteOrigin() })
}

/** The NAP block, rendered to HTML. `createElement` rather than JSX: this file is `.ts`, not `.tsx`. */
function renderNap(facts: Facts): string {
  return renderToStaticMarkup(createElement(NapBlock, { copy: NAP_COPY_EN, facts }))
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  // The suite shares one database and the file order is not this file's to choose, so the rows this unit
  // reads are (re)seeded here rather than assumed. `seedPremises` writes the values docs/13 states and
  // `ensureLegalEntity` leaves 0026's own singleton alone.
  await seedPremises(sql)
  await ensureLegalEntity(sql)
  policy = await readCompliancePolicy(sql)
  await seedCatalogue(sql, {
    lint: (name) => assertPublicDisplayNameCompliant(name, policy),
  })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('acceptance — /api/facts is the premises row, validated', () => {
  it('answers 200 with JSON that satisfies the published contract', async () => {
    const response = await factsResponse(deps(sql), new Request('https://x.test/api/facts'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
    // Parsed from the bytes that were served, not from the object that was built: a serialiser that
    // dropped a field would satisfy the builder's own parse and fail here.
    const parsed = factsSchema.safeParse(JSON.parse(await response.text()))
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true)
  })

  it('carries every NAP field as the row holds it, compared against the row', async () => {
    const facts = await factsFrom()
    const [row] = await sql<
      {
        display_name: string
        address_line_1: string
        address_line_2: string | null
        floor: string | null
        area: string
        emirate: string
        country_code: string
        phone_landline: string
        phone_mobile: string
        parking_notes: string
        timezone: string
      }[]
    >`
      select display_name, address_line_1, address_line_2, floor, area, emirate, country_code,
             phone_landline, phone_mobile, parking_notes, timezone
        from premises where id = 1
    `
    expect(row).toBeDefined()
    if (row === undefined) return
    expect(facts.names.display).toBe(row.display_name)
    expect(facts.address.line1).toBe(row.address_line_1)
    expect(facts.address.line2).toBe(row.address_line_2)
    expect(facts.address.floor).toBe(row.floor)
    expect(facts.address.area).toBe(row.area)
    expect(facts.address.emirate).toBe(row.emirate)
    expect(facts.address.countryCode).toBe(row.country_code)
    expect(facts.contact.landline?.e164).toBe(row.phone_landline)
    expect(facts.contact.mobile?.e164).toBe(row.phone_mobile)
    expect(facts.parkingNotes).toBe(row.parking_notes)
    expect(facts.hours.timezone).toBe(row.timezone)
    // Every part of the one-line form is a part of the row, and the whole row is in it.
    for (const part of [row.address_line_1, row.floor, row.area, row.emirate]) {
      if (part !== null) expect(facts.address.oneLine).toContain(part)
    }
    // The two names a tax invoice and a citation need, from the other singleton.
    const [legal] = await sql<{ legal_name: string; trading_name: string }[]>`
      select legal_name, trading_name from legal_entity where id = 1
    `
    expect(facts.names.legal).toBe(legal?.legal_name)
    expect(facts.names.trading).toBe(legal?.trading_name)
  })

  it('publishes the district aliases docs/13 §2 gives, and none when the area changes', async () => {
    const facts = await factsFrom()
    expect(facts.address.areaAliases.length).toBe(2)
    for (const alias of facts.address.areaAliases) {
      expect(alias).not.toBe(facts.address.area)
    }
    // The control, and the reason the aliases are keyed on the area rather than listed beside it: an area
    // the mapping does not know publishes nothing, so a business that moved cannot go on advertising the
    // previous district. This is the failure a flat list would have had for ever.
    const moved = await probe(async (tx) => {
      await tx`update premises set area = 'Gate Probe District' where id = 1`
      return await factsFrom(tx)
    })
    expect([...moved.address.areaAliases]).toEqual([])
    expect(moved.address.area).toBe('Gate Probe District')
  })

  it('publishes the 32 price points of docs/13 §4, counted from the same rows', async () => {
    const facts = await factsFrom()
    const [counted] = await sql<{ n: string }[]>`
      select count(*)::text as n
        from service_variant v join service s on s.id = v.service_id
       where s.published_at is not null and s.archived_at is null
    `
    expect(facts.catalogue.pricePointCount).toBe(Number(counted?.n))
    // And the figure docs/13 §4 actually states, so the comparison above cannot pass on an empty menu.
    expect(facts.catalogue.pricePointCount).toBe(DOCS_13_PRICE_POINT_COUNT)
    expect(facts.catalogue.services).toHaveLength(8)
    // Every variant's AED string is its fils, divided by a hundred, to two places. Compared against the
    // stored figure rather than against a table: the transcription is B-CAT-06's to assert.
    for (const service of facts.catalogue.services) {
      expect(service.variants).toHaveLength(4)
      for (const variant of service.variants) {
        const [stored] = await sql<{ fils: string }[]>`
          select v.gross_price_fils::text as fils
            from service_variant v join service s on s.id = v.service_id
           where s.slug = ${service.slug} and v.duration_minutes = ${variant.durationMinutes}
        `
        expect(variant.grossFils).toBe(stored?.fils)
        expect(variant.grossAed).toBe(
          `${Math.floor(Number(stored?.fils) / 100)}.${String(Number(stored?.fils) % 100).padStart(2, '0')}`,
        )
      }
    }
  })

  it('names the price-on-request offerings and publishes no figure for them', async () => {
    const facts = await factsFrom()
    const rows = await sql<{ menu_label: string }[]>`
      select menu_label from price_on_request order by menu_label
    `
    expect(facts.catalogue.onRequest.map((offering) => offering.label)).toEqual(
      rows.map((row) => row.menu_label),
    )
    for (const offering of facts.catalogue.onRequest) {
      expect(offering.provisional).toBe(true)
      expect(offering.openQuestionId.length).toBeGreaterThan(0)
    }
    // 0032 has no price column, so there is nothing to leak — asserted rather than assumed, because a
    // later migration that added one would make this endpoint quote a guessed price.
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'price_on_request'
    `
    expect(columns.map((column) => column.column_name)).not.toContain('gross_price_fils')
  })

  it('returns 304 on a conditional request, and 200 when the validator does not match', async () => {
    const first = await factsResponse(deps(sql), new Request('https://x.test/api/facts'))
    const etag = first.headers.get('etag')
    expect(etag).toMatch(/^W\/"[0-9a-f]{32}"$/)
    if (etag === null) return

    const revalidated = await factsResponse(
      deps(sql),
      new Request('https://x.test/api/facts', { headers: { 'if-none-match': etag } }),
    )
    expect(revalidated.status).toBe(304)
    expect(await revalidated.text()).toBe('')
    expect(revalidated.headers.get('etag')).toBe(etag)

    // A weak validator re-quoted as strong by a proxy still matches: RFC 9110 §8.8.3.2 asks for a weak
    // comparison on a GET, and a strict string compare here would turn every revalidation into a 200.
    const requoted = await factsResponse(
      deps(sql),
      new Request('https://x.test/api/facts', {
        headers: { 'if-none-match': etag.replace(/^W\//, '') },
      }),
    )
    expect(requoted.status).toBe(304)

    // The control. A tag that does not match must produce the body, or "304" is just what this endpoint
    // always says and a crawler would never see a correction.
    const stale = await factsResponse(
      deps(sql),
      new Request('https://x.test/api/facts', { headers: { 'if-none-match': 'W/"0"' } }),
    )
    expect(stale.status).toBe(200)
    expect((await stale.text()).length).toBeGreaterThan(100)
  })

  it('changes its ETag when the row changes, and not otherwise', async () => {
    const before = factsEtag(await factsFrom())
    const after = await probe(async (tx) => {
      await tx`update premises set floor = 'Gate Probe Floor' where id = 1`
      return factsEtag(await factsFrom(tx))
    })
    expect(after).not.toBe(before)
    // And back, because the probe rolled back: the validator is a function of the row, so an unchanged row
    // must produce the tag a crawler already holds.
    expect(factsEtag(await factsFrom())).toBe(before)
  })

  it('answers 503 rather than an empty fact sheet when the singleton is missing', async () => {
    // A 200 with no address teaches a crawler that this business has no address, and it will repeat that
    // from cache for as long as it pleases. Rolled back, so the row survives for every later file.
    const response = await probe(async (tx) => {
      await tx`delete from premises where id = 1`
      return await factsResponse(deps(tx), new Request('https://x.test/api/facts'))
    })
    expect(response.status).toBe(503)
    expect(await response.text()).toMatch(/pnpm seed/)
    // The control: the row is back.
    expect((await factsResponse(deps(sql), new Request('https://x.test/api/facts'))).status).toBe(
      200,
    )
  })
})

describe('acceptance — crossing midnight, in the payload and on the page', () => {
  it('puts 01:30 Asia/Dubai inside opening hours and 03:00 outside, from the published hours', async () => {
    const facts = await factsFrom()
    // The schedule is built from what `/api/facts` publishes, not from the seed constants: this is the
    // assertion that the payload a consumer reads is enough to answer "are you open now?" correctly.
    const weekly: (TradingHours | undefined)[] = Array.from({ length: 7 }, () => undefined)
    for (const day of facts.hours.weekly) {
      if (day.isClosed) continue
      weekly[day.dayOfWeek] = { open: localTime(day.opens), close: localTime(day.closes) }
    }
    const hoursFor = hoursFromSchedule({ weekly }, ASIA_DUBAI)

    const halfOne = fromLocal(localDate('2026-09-19'), localTime('01:30'), ASIA_DUBAI)
    const inside = resolveTradingDate(halfOne, hoursFor, ASIA_DUBAI)
    expect(inside.kind).toBe('trading')
    // And it belongs to the PREVIOUS day, which is the whole point of the next-day close: cash-up, the
    // rota and every daily report cut on that date, not on the calendar one.
    if (inside.kind === 'trading') expect(inside.date).toBe('2026-09-18')

    const three = fromLocal(localDate('2026-09-19'), localTime('03:00'), ASIA_DUBAI)
    const outside = resolveTradingDate(three, hoursFor, ASIA_DUBAI)
    expect(outside.kind).toBe('outside_trading')
    if (outside.kind === 'outside_trading') expect(outside.reason).toBe('before_opening')

    // The flag that makes all of that legible to a consumer that does not have this resolver, read off the
    // generated column rather than recomputed.
    expect(facts.hours.crossesMidnight).toBe(true)
    for (const day of facts.hours.weekly) expect(day.closesNextDay).toBe(true)
    const [generated] = await sql<{ n: string }[]>`
      select count(*)::text as n from premises_hours where crosses_midnight
    `
    expect(Number(generated?.n)).toBe(facts.hours.weekly.filter((d) => d.closesNextDay).length)
  })

  it('says so on the visible hours block, in words a reader cannot misread', async () => {
    const html = renderNap(await factsFrom())
    expect(html).toContain(NAP_COPY_EN.closesNextDay)
    expect(html).toContain(NAP_COPY_EN.everyDay)
    // The control: a schedule that does not cross midnight must not carry the marker, or the marker means
    // nothing and a reader learns to ignore it.
    const daytime = await probe(async (tx) => {
      await tx`update premises_hours set open_time = '09:00', close_time = '17:00'`
      return renderNap(await factsFrom(tx))
    })
    expect(daytime).not.toContain(NAP_COPY_EN.closesNextDay)
    expect(daytime).toContain('09:00')
  })
})

describe('acceptance — the unanswered WhatsApp number is published as unanswered', () => {
  it('serves no number, names Y1-nap, and appears in the Unconfirmed Assumptions query', async () => {
    const facts = await factsFrom()
    expect(facts.contact.whatsapp.status).toBe('unconfirmed')
    expect(facts.contact.whatsapp.provisional).toBe(true)
    // Neither candidate, and no digits at all. docs/13 §3 records two; this endpoint exists to end that
    // divergence, so publishing either from it would be the divergence with a schema attached.
    const serialised = JSON.stringify(facts.contact.whatsapp)
    for (const candidate of WHATSAPP_CANDIDATES) {
      expect(serialised).not.toContain(candidate.value)
    }
    expect(serialised).not.toMatch(/\d{6}/)
    // And not the placeholder either: `WHATSAPP-PENDING-Y1-NAP` is a marker for the schema, not copy.
    expect(serialised).not.toContain(WHATSAPP_PENDING)

    const panel = await unconfirmedAssumptionRows(sql)
    const whatsapp = panel.find(
      (entry) => entry.source === 'premises' && entry.reference === 'phone_whatsapp',
    )
    expect(whatsapp?.openQuestionId).toBe('Y1-nap')
    // Both directions. Every provisional value the payload publishes is a row of the panel, so a
    // provisional value cannot be served to the public and be invisible on the screen built to show it.
    const panelQuestions = new Set(panel.map((entry) => entry.openQuestionId))
    expect(facts.provisional.length).toBeGreaterThan(0)
    for (const entry of facts.provisional) {
      expect(panelQuestions.has(entry.openQuestionId), entry.field).toBe(true)
    }
  })

  it('renders the absence on the page rather than a number or an empty space', async () => {
    const html = renderNap(await factsFrom())
    expect(html).toContain(NAP_COPY_EN.whatsappUnconfirmed)
    expect(html).not.toContain(WHATSAPP_PENDING)
    for (const candidate of WHATSAPP_CANDIDATES) {
      expect(html).not.toContain(candidate.value)
    }
  })

  it('publishes the number the moment the column holds one, and drops it from the panel', async () => {
    // The control that makes the whole mechanism falsifiable: it is the database's own
    // `is_placeholder_text()` that decides, on both sides, so answering Y1-nap is one UPDATE and no code
    // change. Rolled back.
    const answered = await probe(async (tx) => {
      await tx`update premises set phone_whatsapp = '+971500000000' where id = 1`
      const facts = await factsFrom(tx)
      const panel = await unconfirmedAssumptionRows(tx)
      return { facts, panel, html: renderNap(facts) }
    })
    expect(answered.facts.contact.whatsapp.status).toBe('confirmed')
    expect(answered.facts.provisional.map((entry) => entry.field)).not.toContain('contact.whatsapp')
    expect(
      answered.panel.filter(
        (entry) => entry.source === 'premises' && entry.reference === 'phone_whatsapp',
      ),
    ).toEqual([])
    expect(answered.html).toContain('+971 50 000 0000')
    // And the seeded state is back.
    expect((await factsFrom()).contact.whatsapp.status).toBe('unconfirmed')
  })
})

describe('acceptance — one field, every surface', () => {
  it('changes the NAP block, the fact sheet, /llms.txt, the map link and the directions link', async () => {
    const before = await factsFrom()
    const PROBE = 'Gate Probe Street'

    const after = await probe(async (tx) => {
      await tx`update premises set address_line_1 = ${PROBE} where id = 1`
      const facts = await factsFrom(tx)
      const llms = await (await llmsResponse(deps(tx))).text()
      return { facts, llms, html: renderNap(facts) }
    })

    // Five surfaces, one edit, one test run. Each compared against the ROW's new value rather than a
    // literal spelling of it, which is the acceptance criterion's own wording.
    expect(after.facts.address.line1).toBe(PROBE)
    expect(after.facts.address.oneLine).toContain(PROBE)
    expect(after.html).toContain(PROBE)
    expect(after.llms).toContain(PROBE)
    expect(new URL(after.facts.geo.mapUrl).searchParams.get('query')).toContain(PROBE)
    expect(new URL(after.facts.geo.directionsUrl).searchParams.get('destination')).toContain(PROBE)

    // And none of them still shows the old value, which is what "derived" means as distinct from
    // "duplicated": a surface that kept a copy would carry both.
    for (const surface of [after.facts.address.oneLine, after.html, after.llms]) {
      expect(surface).not.toContain(before.address.line1)
    }

    // The control, after the rollback: the surfaces are back to the row, so the assertions above measured
    // the edit rather than a difference that was always there.
    const restored = await factsFrom()
    expect(restored.address.line1).toBe(before.address.line1)
    expect(restored.address.line1).toBe(PREMISES_NAP.addressLine1)
    expect(renderNap(restored)).not.toContain(PROBE)
  })

  it('renders every part of the row on the page, and nothing that is not in it', async () => {
    const facts = await factsFrom()
    const html = renderNap(facts)
    for (const part of [
      facts.address.line1,
      facts.address.area,
      facts.address.emirate,
      ...facts.address.areaAliases,
    ]) {
      expect(html, part).toContain(part)
    }
    if (facts.address.line2 !== null) expect(html).toContain(facts.address.line2)
    if (facts.address.floor !== null) expect(html).toContain(facts.address.floor)
    if (facts.parkingNotes !== null) expect(html).toContain(facts.parkingNotes)
    // The two links and the two `tel:` URIs, exactly as the payload publishes them.
    expect(html).toContain(`href="${facts.geo.mapUrl.replaceAll('&', '&amp;')}"`)
    expect(html).toContain(`href="tel:${facts.contact.landline?.e164}"`)
    expect(html).toContain(`href="tel:${facts.contact.mobile?.e164}"`)
    expect(html).toContain(facts.contact.landline?.display ?? '')
    // And the country code is NOT set under an Abu Dhabi address, which is the one part of the one-line
    // form that exists for a geocoder rather than for a reader.
    expect(html).not.toContain(`>${facts.address.countryCode}<`)
  })
})

describe('acceptance — /llms.txt is text/plain, derived, and linted', () => {
  it('is served as text/plain and links the fact sheet and every indexable page', async () => {
    const response = await llmsResponse(deps(sql))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const body = await response.text()
    expect(body).toContain(`${siteOrigin()}/api/facts`)
    // The page list is the registry's, so a route added tomorrow appears here with no change to the file
    // or to this test. That is also the statement that the treatment and therapist indexes are covered the
    // day they land: they are registry documents, `indexable: true`, and nothing else is needed.
    const facts = await factsFrom()
    // The catalogue-derived route is a pattern, so its pages are its slugs: `/llms.txt` lists eight treatment
    // URLs and never `/treatments/[slug]`, which would be a page this file told an assistant to fetch and a
    // 404 when it did.
    const catalogue = facts.catalogue.services.map((service) => ({
      slug: service.slug,
      label: service.name,
    }))
    const expected = ROUTES.filter((route) => route.kind === 'document' && route.indexable).flatMap(
      (route) =>
        route.path.includes('[')
          ? catalogue.map((page) =>
              absoluteUrl(localisedPath(route.path.replace('[slug]', page.slug), DEFAULT_LOCALE)),
            )
          : [absoluteUrl(localisedPath(route.path, DEFAULT_LOCALE))],
    )
    expect(llmsPages(catalogue).map((page) => page.url)).toEqual(expected)
    for (const page of expected) expect(body).toContain(page)
    // The control on the expansion: the pattern itself is published nowhere.
    expect(body).not.toContain('[slug]')
    // The control: a non-indexable route must NOT be listed, or the registry's policy is decoration.
    expect(body).not.toContain(absoluteUrl('/kitchen-sink'))
  })

  it('names the menu and the prices the database holds', async () => {
    const facts = await factsFrom()
    const body = await (await llmsResponse(deps(sql))).text()
    for (const service of facts.catalogue.services) {
      expect(body, service.name).toContain(service.name)
      for (const variant of service.variants) expect(body).toContain(variant.grossAed)
    }
    for (const offering of facts.catalogue.onRequest) {
      expect(body).toContain(offering.label)
    }
  })

  it('passes the banned-claims lint under the profile actually in force', async () => {
    const body = await (await llmsResponse(deps(sql))).text()
    expect(lintLlmsTxt(body, policy)).toEqual([])
    // The control, against the same profile: a claim the licence does not carry is refused BY RULE NAME. A
    // lint that returned [] for everything would satisfy the line above for ever.
    const findings = lintLlmsTxt(`${body}\n- Our therapeutic massage cures back pain.\n`, policy)
    expect(findings.map((finding) => finding.rule)).toContain('banned_claim_term')
    // And the profile really is the strict one, so the control is not passing because claims are permitted.
    expect(policy.medicalClaimsPermitted).toBe(false)
    expect(policy.bannedClaimTerms.length).toBeGreaterThan(5)
  })
})

describe('acceptance — robots.txt, line by line', () => {
  it('serves exactly the policy, with every AI crawler in its own complete group', async () => {
    const response = robotsResponse()
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const lines = (await response.text()).split('\n')
    const origin = siteOrigin()

    const group = (agent: string): readonly string[] => [
      `User-agent: ${agent}`,
      'Allow: /',
      'Disallow: /admin',
      'Disallow: /cms-api',
      'Disallow: /api/',
      'Allow: /api/facts',
    ]
    // Asserted as a sequence, not as a set of `toContain` calls: the order inside a group is what a reader
    // checks, and `Allow: /api/facts` sitting in a different group from `Disallow: /api/` would satisfy
    // every membership test while granting nothing.
    const directives = lines.filter((line) => /^(User-agent|Allow|Disallow|Sitemap):/.test(line))
    expect(directives).toEqual([
      ...group('*'),
      ...group('GPTBot'),
      ...group('ClaudeBot'),
      ...group('PerplexityBot'),
      ...group('Google-Extended'),
      ...group('CCBot'),
    ])
    // The two machine surfaces, named as comments rather than as directives, because neither is one.
    expect(lines).toContain(`# ${origin}/api/facts`)
    expect(lines).toContain(`# ${origin}/llms.txt`)
    // No Sitemap line, because no route serves one — see the note in the manifest. W-SITE-08 owns it.
    expect(directives.some((line) => line.startsWith('Sitemap:'))).toBe(false)
  })

  it('reads no database, so it answers on a deployment with none', async () => {
    // Stated as a test because it is the reason this handler takes no dependencies: robots.txt is a
    // property of the URL space, and a crawl policy that failed when the database did would hand a crawler
    // a 500 and no rules at all.
    const withoutDatabase = robotsResponse()
    expect(withoutDatabase.status).toBe(200)
    expect((await withoutDatabase.text()).length).toBeGreaterThan(100)
  })
})
