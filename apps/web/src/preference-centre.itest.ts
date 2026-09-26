import {
  OPT_OUT_TOKEN_LENGTH,
  OPT_OUT_TOKEN_TTL_SECONDS,
  suppressionKeyNormaliser,
  unreachableOptOutPhrasesIn,
} from '@berelax/core'
import {
  type Actor,
  applyPreferenceSelection,
  consentWordingHash,
  createConnection,
  issueOptOutGrant,
  OPTOUT_VERIFY_MAX_PER_IP,
  PREFERENCE_GRID,
  preferenceCentreRefusalOf,
  readPreferenceSubject,
  type Sql,
  type SuppressionKeying,
  seedConsent,
  withUnitOfWork,
} from '@berelax/db'
import { fixtureSuppressionPeppers, syntheticPerson } from '@berelax/fixtures'
import { DETERMINISTIC_LAUNCH_ARGS } from '@berelax/harness/determinism'
import { DEFAULT_TEMPLATES } from '@berelax/messaging'
import { PREFERENCE_CENTRE_PATH, preferenceCentrePath } from '@berelax/shared'
import { type Browser, chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  handlePreferenceCentreRead,
  handlePreferenceCentreWrite,
  type PreferenceCentreDeps,
  readPreferenceRequest,
} from '../app/(public)/preferences/handler.ts'
import { callerAddress } from '../app/api/v1/otp/handler.ts'
import { canonicalPath, needsCanonicalRedirect } from './routes/canonical.ts'

/**
 * C-CRM-07 — the preference centre's rows and refusals, against real PostgreSQL.
 *
 * ## Why this file starts no server, and its sibling does
 *
 * The handlers are called directly, exactly as `preferences-route.itest.ts` and `manage-booking.itest.ts`
 * call theirs, and for the reason the first of those states: what is asserted here is the SHAPE of a refusal
 * and the rows a write leaves, and a `next start` in front of them would add a router and a form parser to
 * every case without changing one of them. Brief rule 18 asks a server-starting suite to draw a band from
 * `@berelax/harness/ports`; nothing here starts one, so no band is drawn and none is declared.
 *
 * `preference-centre-browser.itest.ts` is the half that needs a server — the acceptance criterion about a
 * document loaded with JavaScript DISABLED whose form then submits — plus axe and the screenshots. Two files
 * rather than one, and the reason is the gate block: every mutant in block 99 that breaks a row-level claim
 * has to run the suite that proves it, and a suite carrying a production build, twelve axe audits and twelve
 * screenshots costs minutes per mutant to re-prove something none of them touches.
 *
 * A browser is still launched here, for one thing: the wording case reads the statement out of the DOM
 * rather than off the HTML, so that nothing in this file reimplements the escaping `safeText` applies.
 *
 * ## Isolation (brief rule 12)
 *
 * The integration suite runs sequentially against ONE database and earlier files leave rows behind. Four
 * things keep this file's assertions about this file:
 *
 *   - the contacts are `syntheticPerson(9_5xx)`, a band no other suite or gate uses;
 *   - every consent assertion narrows to one contact id AND to this file's own frozen instant, so a row an
 *     earlier run left is outside it;
 *   - `audit_event` and `consent` are append-only, so every count over them is a DELTA computed in SQL and
 *     never a total read through a capped reader (`settings-store.itest.ts` read three changes as zero that
 *     way);
 *   - the rate-limit attempt log is cleared for `198.51.100.0/24` only. `preferences-route.itest.ts` owns
 *     `203.0.113.0/24` and clears that one; two files clearing one band would each be removing rows the
 *     other is about to count.
 *
 * The merge case runs inside a `withUnitOfWork` that is rolled back, for the reason
 * `packages/fixtures/src/merge.itest.ts` gives: `merge_record` refuses DELETE for every role (ZT001), so a
 * committed tombstone would make every later run of this file answer `already_merged` and would leave the
 * estate every other suite reads holding a merge nobody expected.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * Six contacts, and the split is between the ones that are READ and the ones that are WRITTEN.
 *
 * `READER` is never mutated, so the shell and refusal cases resolve the same way on a first run and on a
 * tenth. `TOGGLER` and `STOPPER` each carry their own writes at their own instants. One shared contact would
 * have made the read cases depend on whether the write cases had run — and worse, two changes at ONE frozen
 * instant resolve to a tie, which `resolveConsent` deliberately fails closed on.
 *
 * 9_704 is deliberately absent: it belongs to `preference-centre-browser.itest.ts`, which commits a real
 * withdrawal through a real server and must not share a contact with anything asserted here.
 *
 * ## THE 9_7xx BAND, and the two bands before it that were somebody else's
 *
 * This file COMMITS withdrawals and suppressions, and `consent` and `suppression` refuse DELETE for every
 * role including the owner — so a contact shared with another suite is damage that cannot be taken back and
 * the database has to be rebuilt. It happened twice while this unit was written, and both cost a whole
 * integration run:
 *
 *   - **9_5xx** is `packages/fixtures/src/merge.itest.ts`'s — `syntheticPerson(9_501)` to `(9_503)` are its
 *     survivor, its loser and its third record. Three of its cases went red about a copied log, a
 *     back-referenced detail and a chain, and not one of them named a contact, let alone this file.
 *   - **9_6xx** is `packages/fixtures/src/duplicate-queue.ts`'s, and THAT is the one worth writing down: its
 *     indexes are a `DUPLICATE_QUEUE_FIXTURE_INDEXES` record of bare numbers — `nearMissSurvivor: 9_601` —
 *     so a grep for `syntheticPerson(` finds nothing and the band reads as free. Two cases of
 *     `merge-preview.itest.ts` went red.
 *
 * So the check is over every customer index the repository names in ANY shape, `syntheticPerson(`,
 * `customerLabel(` and the literal maps: 42, 43, 95, 4_4xx, 5_318, 9_1xx, 9_3xx, 9_4xx, 9_5xx, 9_601, 9_602,
 * 9_611, 9_622, 9_631, 9_632, 9_641 and 9_999 are taken. 9_7xx is not (9700 in `ports.ts` is a port band,
 * not a person).
 */
const READER = syntheticPerson(9_701)
const TOGGLER = syntheticPerson(9_702)
const STOPPER = syntheticPerson(9_703)
const MERGE_SURVIVOR = syntheticPerson(9_705)
const MERGE_LOSER = syntheticPerson(9_706)

const SEEDED_ISO = '2026-09-18T10:00:00.000Z'

/**
 * Every instant this file writes at, unique PER RUN, and that is not tidiness.
 *
 * `consent_one_record_per_instant` is `(contact, channel, purpose, kind, recorded_at)` and the repository
 * inserts `on conflict do nothing`, so a second run at a FIXED instant writes nothing and reports
 * `recorded: false` — and `suppression`'s unique key does the same. Three assertions in this file were red
 * on their second run for that reason, with the symptom "expected 1 consent row, got 0" and nothing
 * pointing at the instant. The alternative, which `preferences-route.itest.ts` takes, is to accept either
 * count (`consentRows === 6 || consentRows === 0`); that is a weaker claim and it goes vacuous the moment
 * the write stops writing. So the instants move instead, and every assertion stays exact.
 *
 * Derived from the pid, for `manage-booking.itest.ts`'s reason: several worktrees run the same file at once
 * and two of them drawing the same millisecond would be the same collision from outside.
 */
const RUN_JITTER_MS = Math.floor(Math.random() * 1000)
/*
  The jitter is its own constant, and that is not style. `apps/web/src/test-ports.test.ts` scans every
  `.itest.ts` for a four-digit literal added to a random draw — the shape a suite computing its own port had
  before `@berelax/harness/ports` existed — and the instant below had exactly that shape when it was one
  expression, because the pid term is scaled by a thousand. This file draws no port at all, so the report was
  a false positive; the scanner is deliberately loose, because what it looks for is worth one. Splitting the
  expression removes the shape, and the scanner reads COMMENTS too, which is why this one does not quote it.
*/
const RUN_BASE_MS =
  Date.parse('2026-09-19T10:00:00.000Z') + (process.pid % 20_000) * 1000 + RUN_JITTER_MS
/** One instant per writing case, minutes apart, so no two decisions land on the same millisecond. */
const at = (minutes: number): string => new Date(RUN_BASE_MS + minutes * 60_000).toISOString()
const TOGGLE_ISO = at(0)
const STOP_ISO = at(60)
const SCOPE_ISO = at(90)
const EMAIL_ISO = at(100)
const GRANT_ISO = at(110)
const MERGE_ISO = at(120)
const WORDING_ISO = at(180)
const READ_ISO = at(240)

const ACTOR: Actor = { kind: 'system', label: 'Preference centre itest fixture' }
/**
 * RFC 5737 block two. Block three is `preferences-route.itest.ts`'s; see the header.
 *
 * A FRESH address per request unless a case names one, and that is load-bearing rather than fussy: the rate
 * limit is ten verifications per address per minute counted over the last sixty seconds, every read in this
 * file is judged at an instant inside one window, and the nine that shared an address left exactly one
 * verification of headroom. One more case would have turned the file red with a 429 nobody had asked for.
 * The flood case names its own address, which is the only place the limit is the thing under test.
 */
const ip = (n: number): string => `198.51.100.${n}`
let addressesIssued = 0
/** 198.51.100.20 to .219, cycling. The named addresses below sit outside that span. */
const freshIp = (): string => ip(20 + (addressesIssued++ % 200))
/** The two addresses a case owns, because what it asserts is about the address itself. */
const VISITS_IP = ip(250)
const FLOOD_IP = ip(251)

let sql: Sql
let keying: SuppressionKeying
let browser: Browser
let readerId = ''
let togglerId = ''
let stopperId = ''
let survivorId = ''
let loserId = ''

async function contactIdFor(phone: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from customer where phone_e164 = ${phone}`
  if (row === undefined) throw new Error(`No fixture contact for ${phone}`)
  return row.id
}

/** Deps with the clock frozen at one instant. Every expiry and every `recorded_at` is judged against it. */
const depsAt = (nowIso: string): PreferenceCentreDeps => ({ sql, now: () => nowIso, keying })

async function mintToken(contactId: string, ttlSeconds = OPT_OUT_TOKEN_TTL_SECONDS) {
  return withUnitOfWork(sql, ACTOR, (uow) =>
    issueOptOutGrant(uow, {
      contactCustomerId: contactId,
      channel: 'sms',
      purpose: 'preference_centre',
      issuedAtIso: SEEDED_ISO,
      ttlSeconds,
    }),
  )
}

/** A GET the handler can read: the three query fields and the proxy header the rate limit needs. */
function get(args: {
  readonly contactId?: string
  readonly token?: string
  readonly locale?: 'en' | 'ar'
  readonly requestIp?: string | null
  readonly query?: string
}): { url: URL; headers: Headers } {
  const params = new URLSearchParams()
  if (args.contactId !== undefined) params.set('c', args.contactId)
  if (args.token !== undefined) params.set('t', args.token)
  params.set('lang', args.locale ?? 'en')
  const headers = new Headers()
  if (args.requestIp !== null) headers.set('x-forwarded-for', args.requestIp ?? freshIp())
  const suffix = args.query === undefined ? '' : `&${args.query}`
  return {
    url: new URL(`https://berelax.test${PREFERENCE_CENTRE_PATH}?${params.toString()}${suffix}`),
    headers,
  }
}

const readPage = async (args: Parameters<typeof get>[0], nowIso = READ_ISO): Promise<Response> => {
  const { url: requested, headers } = get(args)
  return await handlePreferenceCentreRead(
    readPreferenceRequest(requested, headers, callerAddress),
    depsAt(nowIso),
  )
}

const writePage = async (
  args: Parameters<typeof get>[0],
  form: Record<string, string>,
  nowIso: string,
): Promise<Response> => {
  const { url: requested, headers } = get(args)
  return await handlePreferenceCentreWrite(
    readPreferenceRequest(requested, headers, callerAddress),
    new URLSearchParams(form),
    depsAt(nowIso),
  )
}

/** Every consent row for one contact, as a comparable snapshot. Ordered, so equality is over the set. */
interface ConsentSnapshot {
  readonly id: string
  readonly channel: string
  readonly purpose: string
  readonly kind: string
  readonly recordedAt: string
  readonly wordingHash: string | null
  readonly source: string
}

const consentRowsFor = async (contactId: string): Promise<readonly ConsentSnapshot[]> =>
  await sql<ConsentSnapshot[]>`
    select id::text as id, channel::text as channel, purpose, kind::text as kind,
           recorded_at::text as "recordedAt", encode(wording_hash, 'hex') as "wordingHash",
           capture_source as source
      from consent where contact_customer_id = ${contactId}::uuid
     order by recorded_at, channel::text, purpose, kind::text
  `

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })
  keying = { peppers: fixtureSuppressionPeppers(process.env), normalise: suppressionKeyNormaliser }

  // The attempt log is the ONE table this unit may clean, and with a frozen clock it has to be: every case
  // is evaluated at a fixed instant, so a row an earlier run left is still inside this run's sixty-second
  // window and after ten runs a single verification would be refused 429 by its own history. 0064 keeps
  // DELETE granted on this table and refuses it on `suppression` for exactly this reason.
  await sql`delete from optout_verification_attempt where request_ip << '198.51.100.0/24'::inet`

  // Idempotent, and it creates the `customer` rows as well as the consent: `customer-identity.itest.ts`
  // clears that table between its cases, so a file that assumed a contact was still there would pass or
  // fail on vitest's file ordering.
  await seedConsent(sql, {
    contacts: [READER, TOGGLER, STOPPER, MERGE_SURVIVOR, MERGE_LOSER].map((person) => ({
      phoneE164: person.phone,
      locale: 'en' as const,
      state: 'granted' as const,
      label: person.label,
    })),
    recordedAtIso: SEEDED_ISO,
  })
  readerId = await contactIdFor(READER.phone)
  togglerId = await contactIdFor(TOGGLER.phone)
  stopperId = await contactIdFor(STOPPER.phone)
  survivorId = await contactIdFor(MERGE_SURVIVOR.phone)
  loserId = await contactIdFor(MERGE_LOSER.phone)

  browser = await chromium.launch({ args: [...DETERMINISTIC_LAUNCH_ARGS] })
}, 300_000)

afterAll(async () => {
  await browser?.close()
  await sql?.end({ timeout: 5 })
})

// ------------------------------------------------------------------------------------------------

describe('acceptance — one toggle writes one withdrawal and one suppression, and touches nothing else', () => {
  it('leaves every other pair byte-unchanged', async () => {
    const issued = await mintToken(togglerId)
    const before = await consentRowsFor(togglerId)
    const suppressionsBefore = await sql<{ n: string }[]>`
      select count(*)::text as n from suppression
       where contact_customer_id = ${togglerId}::uuid and source = 'preference_centre'
    `

    const response = await writePage(
      { contactId: togglerId, token: issued.token },
      { intent: 'pair', channel: 'sms', purpose: 'marketing', action: 'unsubscribe' },
      TOGGLE_ISO,
    )
    // A redirect rather than a rendered 200: a page rendered from a POST is resubmittable on reload, and
    // "we have stopped it" shown twice reads as two decisions.
    expect(response.status).toBe(303)
    const location = new URL(response.headers.get('location') ?? '', 'https://berelax.test')
    expect(location.pathname).toBe(PREFERENCE_CENTRE_PATH)
    expect(location.searchParams.get('done')).toBe('stopped')
    // The capability survives the redirect, or the reader lands on "this link is not available" having just
    // succeeded.
    expect(location.searchParams.get('t')).toBe(issued.token)

    const after = await consentRowsFor(togglerId)
    const added = after.filter((row) => !before.some((old) => old.id === row.id))
    expect(added).toHaveLength(1)
    const written = added[0]
    expect(written?.channel).toBe('sms')
    expect(written?.purpose).toBe('marketing')
    expect(written?.kind).toBe('withdrawn')
    expect(written?.source).toBe('preference_centre')

    // BYTE-UNCHANGED, which is the acceptance's own word: every row that existed before is still there,
    // with the same id, instant, kind and wording hash. `consent` revokes UPDATE for every role, so this is
    // belt and braces — and it is also the assertion that would catch a write that looped over the whole
    // grid while reporting one pair.
    const survived = after.filter((row) => before.some((old) => old.id === row.id))
    expect(survived).toEqual([...before])
    // And no SECOND row for any other pair, which is the half a row-count alone would miss.
    for (const cell of PREFERENCE_GRID) {
      if (cell.channel === 'sms' && cell.purpose === 'marketing') continue
      const at = after.filter(
        (row) =>
          row.channel === cell.channel &&
          row.purpose === cell.purpose &&
          row.recordedAt === written?.recordedAt,
      )
      expect(at, `${cell.channel}:${cell.purpose} at the toggle instant`).toEqual([])
    }

    const suppressionsAfter = await sql<{ n: string }[]>`
      select count(*)::text as n from suppression
       where contact_customer_id = ${togglerId}::uuid and source = 'preference_centre'
    `
    expect(Number(suppressionsAfter[0]?.n ?? 0) - Number(suppressionsBefore[0]?.n ?? 0)).toBe(1)
  })

  it('is one transaction: a selection whose suppression refuses writes no consent row either', async () => {
    // The consent rows are written BEFORE the suppression, so if a refusal from the suppression half leaves
    // zero consent rows behind, the two really were in one transaction. Driven through the repository rather
    // than the handler because the handler cannot produce an unkeyable recipient — which is the point: the
    // atomicity has to hold for every caller, not only for the one that validates first.
    const before = await consentRowsFor(stopperId)
    await expect(
      withUnitOfWork(sql, ACTOR, (uow) =>
        applyPreferenceSelection(uow, keying, {
          contactCustomerId: stopperId,
          action: 'unsubscribe',
          scope: { kind: 'pair', channel: 'sms', purpose: 'marketing' },
          // A value the one normaliser this system has refuses, so `recordSuppression` raises after the
          // consent rows have been inserted.
          recipient: 'not a telephone number',
          keyKind: 'phone',
          locale: 'en',
          wording: null,
          decidedAtIso: STOP_ISO,
          actorLabel: 'Preference centre (link holder)',
        }),
      ),
    ).rejects.toThrow()
    expect(await consentRowsFor(stopperId)).toEqual([...before])

    // The positive control: the same selection with a keyable recipient DOES write, so the case above is
    // about the rollback rather than about a selection that never writes anything.
    const result = await withUnitOfWork(sql, ACTOR, (uow) =>
      applyPreferenceSelection(uow, keying, {
        contactCustomerId: stopperId,
        action: 'unsubscribe',
        scope: { kind: 'pair', channel: 'sms', purpose: 'marketing' },
        recipient: STOPPER.phone,
        keyKind: 'phone',
        locale: 'en',
        wording: null,
        decidedAtIso: STOP_ISO,
        actorLabel: 'Preference centre (link holder)',
      }),
    )
    expect(result.consentRows).toBe(1)
    expect(result.suppressionRecorded).toBe(true)
    expect((await consentRowsFor(stopperId)).length).toBe(before.length + 1)
  })

  it('writes the decision and no suppression for a channel whose detail this system has none of', async () => {
    // `customer` has no email column at all (C-CRM-01's NOTE 3), so an email row records the DECISION and
    // there is no address to put on the list. A reported state rather than a refusal, because the consent
    // half IS the whole of what can be recorded about email — promotional email already fails closed as
    // `blocked_unevaluable` — and the page says so beside the grid rather than offering a toggle that does
    // less than its neighbours.
    const at = EMAIL_ISO
    const before = await consentRowsFor(togglerId)
    const [suppressionsBefore] = await sql<{ n: string }[]>`
      select count(*)::text as n from suppression where contact_customer_id = ${togglerId}::uuid
    `
    const result = await withUnitOfWork(sql, ACTOR, (uow) =>
      applyPreferenceSelection(uow, keying, {
        contactCustomerId: togglerId,
        action: 'unsubscribe',
        scope: { kind: 'pair', channel: 'email', purpose: 'marketing' },
        recipient: TOGGLER.phone,
        keyKind: 'phone',
        locale: 'en',
        wording: null,
        decidedAtIso: at,
        actorLabel: 'Preference centre (link holder)',
      }),
    )
    expect(result.consentRows).toBe(1)
    expect(result.suppressionRecorded).toBe(false)
    expect(result.suppressionId).toBeNull()

    const after = await consentRowsFor(togglerId)
    const added = after.filter((row) => !before.some((old) => old.id === row.id))
    expect(added).toHaveLength(1)
    expect(added[0]?.channel).toBe('email')
    // No suppression row at all, even though a recipient WAS supplied: the scope decides which detail is
    // reached, not the caller's argument list.
    const [suppressionsAfter] = await sql<{ n: string }[]>`
      select count(*)::text as n from suppression where contact_customer_id = ${togglerId}::uuid
    `
    expect(Number(suppressionsAfter?.n ?? 0)).toBe(Number(suppressionsBefore?.n ?? 0))
    // And the audit row names the CUSTOMER rather than a suppression that does not exist.
    const [audited] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event
       where action = 'preference_centre.changed' and entity_type = 'customer'
         and entity_id = ${togglerId} and after_state->>'decided_at' = ${at}
    `
    expect(Number(audited?.n ?? 0)).toBe(1)

    // The control: the same selection on a HANDSET channel does write a suppression, so the case above is
    // about the scope rather than about a write that never suppresses anything.
    const handset = await withUnitOfWork(sql, ACTOR, (uow) =>
      applyPreferenceSelection(uow, keying, {
        contactCustomerId: togglerId,
        action: 'unsubscribe',
        scope: { kind: 'pair', channel: 'whatsapp', purpose: 'marketing' },
        recipient: TOGGLER.phone,
        keyKind: 'phone',
        locale: 'en',
        wording: null,
        decidedAtIso: at,
        actorLabel: 'Preference centre (link holder)',
      }),
    )
    expect(handset.suppressionRecorded).toBe(true)
    expect(handset.suppressionId).not.toBeNull()
  })

  it('refuses a pair outside the grid rather than defaulting it', async () => {
    const issued = await mintToken(stopperId)
    const response = await writePage(
      { contactId: stopperId, token: issued.token },
      { intent: 'pair', channel: 'pigeon', purpose: 'marketing', action: 'unsubscribe' },
      SCOPE_ISO,
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('refused=preference_scope_unknown')
  })
})

// ------------------------------------------------------------------------------------------------

describe('acceptance — the wording rendered is the wording recorded', () => {
  it('hashes the text off both rendered pages and matches the consent row', async () => {
    const issued = await mintToken(readerId)

    // The words as a READER sees them, taken out of the DOM rather than off the HTML, so nothing here
    // reimplements the escaping `safeText` applies — a second unescaper would be the thing that disagreed.
    // The statement for THE PURPOSE the write is about, not "the statement": the page prints one per
    // purpose, because a `review_request` row recorded against the marketing words would be evidence of an
    // agreement to words that say nothing about review requests.
    const PURPOSE = 'review_request'
    const english = await renderedWording({
      contactId: readerId,
      token: issued.token,
      locale: 'en',
      purpose: PURPOSE,
    })
    const arabic = await renderedWording({
      contactId: readerId,
      token: issued.token,
      locale: 'ar',
      purpose: PURPOSE,
    })
    expect(english.text.length).toBeGreaterThan(10)
    expect(arabic.text.length).toBeGreaterThan(10)
    expect(arabic.text).not.toBe(english.text)
    expect(arabic.version).toBe(english.version)

    // And it is NOT the marketing statement, which is the whole point of matching by purpose: if the two
    // were the same words this case would pass with the versions crossed over.
    const marketing = await renderedWording({
      contactId: readerId,
      token: issued.token,
      locale: 'en',
      purpose: 'marketing',
    })
    expect(marketing.text).not.toBe(english.text)

    // The hash the DATABASE computes from the pair the page printed. `consentWordingHash` is a round trip
    // to `consent_wording_hash()` rather than a `createHash` here, because one definition of the
    // canonicalisation exists and it is the one the generated column and the INSERT trigger use.
    const rendered = await consentWordingHash(sql, {
      textEn: english.text,
      textAr: arabic.text,
    })

    const before = await consentRowsFor(readerId)
    const response = await writePage(
      { contactId: readerId, token: issued.token },
      { intent: 'pair', channel: 'whatsapp', purpose: PURPOSE, action: 'unsubscribe' },
      WORDING_ISO,
    )
    expect(response.status).toBe(303)
    const after = await consentRowsFor(readerId)
    const added = after.filter((row) => !before.some((old) => old.id === row.id))
    expect(added).toHaveLength(1)
    expect(added[0]?.wordingHash).toBe(rendered)

    // The control, and it is what makes the equality mean something: one character different in either
    // language is a different hash, so the assertion above could have failed.
    expect(
      await consentWordingHash(sql, { textEn: `${english.text}.`, textAr: arabic.text }),
    ).not.toBe(rendered)
    expect(
      await consentWordingHash(sql, { textEn: english.text, textAr: `${arabic.text}.` }),
    ).not.toBe(rendered)
  }, 120_000)
})

/** One purpose's statement as the DOM holds it, plus the version the page says it is. */
async function renderedWording(args: {
  readonly contactId: string
  readonly token: string
  readonly locale: 'en' | 'ar'
  readonly purpose: string
}): Promise<{ readonly text: string; readonly version: string }> {
  const html = await (
    await readPage({ contactId: args.contactId, token: args.token, locale: args.locale })
  ).text()
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    await page.setContent(html, { waitUntil: 'load' })
    const statement = page.locator(`[data-preference-wording="${args.purpose}"]`)
    expect(await statement.count(), `a statement for ${args.purpose}`).toBe(1)
    const text = (await statement.textContent()) ?? ''
    const version = (await statement.getAttribute('data-preference-wording-version')) ?? ''
    return { text: text.trim(), version }
  } finally {
    await context.close()
  }
}

// ------------------------------------------------------------------------------------------------

describe('acceptance — a grant is evidence of the words published for ITS purpose', () => {
  it('records a GRANT against its own purpose\u2019s wording and never another purpose\u2019s', async () => {
    /*
      The defect this is here to refuse is silent in the page and wrong in the row. A preference centre shows
      a statement; if one statement stood in for the whole grid, a `review_request` resubscribe would be
      stored with `consent_wording_id` pointing at the MARKETING version — and nothing in the database would
      object, because `consent_grant_carries_its_wording` only requires that there is a version and
      `assert_consent_wording_hash()` only checks the hash against the version named. So the row would be
      perfectly legal evidence of an agreement to words that say nothing about review requests.
    */
    const issued = await mintToken(stopperId)
    const at = GRANT_ISO
    const before = await consentRowsFor(stopperId)
    const response = await writePage(
      { contactId: stopperId, token: issued.token },
      { intent: 'everything', action: 'resubscribe' },
      at,
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('done=started')

    const rows = await sql<{ purpose: string; wording_purpose: string }[]>`
      select c.purpose, w.purpose as wording_purpose
        from consent c join consent_wording w on w.id = c.consent_wording_id
       where c.contact_customer_id = ${stopperId}::uuid
         and c.recorded_at = ${at}::timestamptz and c.kind = 'granted'
    `
    // Six rows, and every one of them names the version published for ITS OWN purpose.
    expect(rows).toHaveLength(PREFERENCE_GRID.length)
    for (const row of rows) {
      expect(row.wording_purpose, `${row.purpose} granted under`).toBe(row.purpose)
    }
    // The control that the join could have disagreed: the two purposes really are both present, so a
    // single-purpose grid would not satisfy the loop.
    expect([...new Set(rows.map((row) => row.purpose))].sort()).toEqual([
      'marketing',
      'review_request',
    ])
    expect((await consentRowsFor(stopperId)).length).toBe(before.length + PREFERENCE_GRID.length)
  })
})

// ------------------------------------------------------------------------------------------------

describe('the URL is where the capability lives, because a path segment cannot hold it', () => {
  it('keeps the capability in the query, where canonicalPath cannot destroy it', () => {
    // The central decision of this unit, asserted rather than argued in a comment. `canonicalPath`
    // lower-cases every path segment and the proxy 301s to the result, and C-CRM-04's token is 43
    // characters of MIXED-CASE base64url — so a token in a path is destroyed by the site's own
    // canonicalisation, for every customer, every time, with a 404 whose cause is two modules away.
    const token = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE'
    expect(token).toHaveLength(OPT_OUT_TOKEN_LENGTH)
    const path = preferenceCentrePath({ contactId: readerId, token, locale: 'ar' })
    const built = new URL(path, 'https://berelax.test')

    // The pathname is the bare route and carries nothing case-sensitive, so the canonical spelling of it is
    // itself and no redirect is issued at all.
    expect(built.pathname).toBe(PREFERENCE_CENTRE_PATH)
    expect(canonicalPath(built.pathname)).toBe(built.pathname)
    expect(needsCanonicalRedirect(built.pathname)).toBe(false)
    // And the capability is in the query, intact, case for case.
    expect(built.searchParams.get('t')).toBe(token)
    expect(built.searchParams.get('c')).toBe(readerId)
    expect(built.searchParams.get('lang')).toBe('ar')

    // The control, and it is the whole argument: the same token as a path SEGMENT is canonicalised into a
    // different string, so the link would resolve to no grant.
    const asSegment = `${PREFERENCE_CENTRE_PATH}/${token}`
    expect(canonicalPath(asSegment)).not.toBe(asSegment)
    expect(canonicalPath(asSegment)).not.toContain(token)
    // `/preferences` is NOT proxy-exempt — only `/api`, `/_next` and the CMS are — so that redirect really
    // would be issued rather than being a theoretical property of the function.
    expect(needsCanonicalRedirect(asSegment)).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------

describe('acceptance — a valid link and an unknown one answer the same status and the same shell', () => {
  it('compares the two documents outside <main>, byte for byte', async () => {
    const issued = await mintToken(readerId)
    const valid = await readPage({ contactId: readerId, token: issued.token })
    // Well-formed and belonging to nothing: the shape C-CRM-04 refuses without a query.
    const forged = 'A'.repeat(OPT_OUT_TOKEN_LENGTH - 1) + 'b'
    expect(forged).toHaveLength(OPT_OUT_TOKEN_LENGTH)
    const unknown = await readPage({ contactId: readerId, token: forged }, READ_ISO)

    expect(valid.status).toBe(200)
    expect(unknown.status).toBe(valid.status)
    for (const header of ['content-type', 'cache-control', 'x-robots-tag', 'referrer-policy']) {
      expect(unknown.headers.get(header), header).toBe(valid.headers.get(header))
    }

    const validHtml = await valid.text()
    const unknownHtml = await unknown.text()
    const shell = (html: string): readonly [string, string] => {
      const open = html.indexOf('<main data-preference-page="preferences">')
      const close = html.indexOf('</main>')
      expect(open, 'the shell marker').toBeGreaterThan(-1)
      expect(close, 'the shell marker').toBeGreaterThan(open)
      return [html.slice(0, open), html.slice(close)]
    }
    expect(shell(unknownHtml)).toEqual(shell(validHtml))

    // The controls. Without the first, a page that answered one constant document would satisfy every
    // assertion above; without the second, a page that leaked the grid to an unknown token would too.
    expect(unknownHtml).not.toBe(validHtml)
    expect(validHtml).toContain('data-preference-body="grid"')
    expect(unknownHtml).toContain('data-preference-body="unavailable"')
    expect(unknownHtml).not.toContain('data-preference-cell=')
    // And no contact detail in either, which is the other half of "reveals nothing".
    for (const html of [validHtml, unknownHtml]) {
      expect(html).not.toContain(READER.phone)
      expect(html).not.toContain(READER.email)
    }
  })

  it('answers that same page for a malformed token, an expired one and another contact’s', async () => {
    const expired = await mintToken(readerId, 60)
    const foreign = await mintToken(togglerId)
    const cases: readonly { readonly label: string; readonly response: Response }[] = [
      { label: 'malformed', response: await readPage({ contactId: readerId, token: 'nope' }) },
      { label: 'absent', response: await readPage({ contactId: readerId }) },
      {
        label: 'not a uuid',
        response: await readPage({ contactId: 'not-a-uuid', token: foreign.token }),
      },
      {
        label: 'expired',
        response: await readPage({ contactId: readerId, token: expired.token }, READ_ISO),
      },
      {
        label: 'another contact',
        response: await readPage({ contactId: readerId, token: foreign.token }),
      },
    ]
    const bodies = await Promise.all(
      cases.map(async (entry) => ({ label: entry.label, html: await entry.response.text() })),
    )
    for (const entry of cases) expect(entry.response.status, entry.label).toBe(200)
    // Every refusal is the SAME document, not merely the same shell: nothing about any of them reaches the
    // page, so the bytes are equal. That is stronger than the criterion and it is free, because the refusal
    // document is built from the locale alone.
    const first = bodies[0]?.html
    for (const entry of bodies) expect(entry.html, entry.label).toBe(first)
  })

  it('records every visit, so an honoured opt-out is provable from the database', async () => {
    const issued = await mintToken(readerId)
    const [before] = await sql<{ attempts: string; redeemed: string }[]>`
      select (select count(*) from optout_verification_attempt
               where request_ip = ${VISITS_IP}::inet)::text as attempts,
             (select count(*) from audit_event
               where action = 'optout_grant.redeemed' and entity_id = ${issued.grantId})::text
               as redeemed
    `
    await readPage({ contactId: readerId, token: issued.token, requestIp: VISITS_IP })
    await readPage({ contactId: readerId, token: 'nope', requestIp: VISITS_IP })
    const [after] = await sql<{ attempts: string; redeemed: string }[]>`
      select (select count(*) from optout_verification_attempt
               where request_ip = ${VISITS_IP}::inet)::text as attempts,
             (select count(*) from audit_event
               where action = 'optout_grant.redeemed' and entity_id = ${issued.grantId})::text
               as redeemed
    `
    // Two attempts — the refusal is recorded as well, because the rate limit counts attempts rather than
    // successes — and one redemption, because only one of them granted anything.
    expect(Number(after?.attempts ?? 0) - Number(before?.attempts ?? 0)).toBe(2)
    expect(Number(after?.redeemed ?? 0) - Number(before?.redeemed ?? 0)).toBe(1)
  })

  it('answers 429 — the one distinguishable refusal — when an address floods it', async () => {
    const flooder = FLOOD_IP
    await sql`delete from optout_verification_attempt where request_ip = ${flooder}::inet`
    let last: Response | undefined
    for (let attempt = 0; attempt <= OPTOUT_VERIFY_MAX_PER_IP; attempt += 1) {
      last = await readPage({ contactId: readerId, token: 'nope', requestIp: flooder })
    }
    // A 429 with `Retry-After` is a fact about the CALLER rather than about anybody's data, which is why it
    // is allowed to differ — and answering the ordinary page to a flood would leave a well-behaved client
    // retrying immediately for ever.
    expect(last?.status).toBe(429)
    expect(Number(last?.headers.get('retry-after') ?? 0)).toBeGreaterThan(0)
  })

  it('refuses a request it cannot attribute, by name', async () => {
    const issued = await mintToken(readerId)
    const response = await readPage({ contactId: readerId, token: issued.token, requestIp: null })
    // Not the page: `optout_verification_attempt.request_ip` is NOT NULL and the limit has one dimension,
    // so a request whose address cannot be read would bypass the only defence there is. It is a fact about
    // the REQUEST rather than about anybody's data, so it is allowed to be distinguishable.
    expect(response.status).toBe(400)
    expect(response.headers.get('berelax-error')).toBe('unattributable_request')
  })
})

// ------------------------------------------------------------------------------------------------

describe('acceptance — no template tells anybody to reply STOP, in any locale', () => {
  it('scans the shipped corpus and every seeded message_template row', async () => {
    const shipped = DEFAULT_TEMPLATES.map((template) => ({
      where: `${template.key} (${template.locale}, shipped)`,
      body: template.body,
    }))
    const stored = (
      await sql<{ key: string; locale: string; body: string; subject: string | null }[]>`
        select t.template_key as key, v.locale, v.body, v.subject
          from message_template_variant v join message_template t on t.id = v.template_id
      `
    ).flatMap((row) => [
      { where: `${row.key} (${row.locale}, variant body)`, body: row.body },
      // The SUBJECT as well as the body: an email template's subject line is copy a reader sees, and a
      // template whose body was cleaned while its subject still said it would pass a body-only scan.
      ...(row.subject === null
        ? []
        : [{ where: `${row.key} (${row.locale}, variant subject)`, body: row.subject }]),
    ])

    // A scan over nothing passes, so the corpus is counted first (ADR 0003). Both halves, because the
    // shipped defaults are what a fresh database is seeded FROM and the rows are what the send path reads —
    // a template edited in the admin would show up only in the second.
    expect(shipped.length).toBeGreaterThanOrEqual(18)
    expect(stored.length).toBeGreaterThanOrEqual(shipped.length)
    // Both locales are really in each half, which is what "in any locale" rests on: a corpus that had lost
    // its Arabic bodies would satisfy the scan below over English alone.
    for (const half of [shipped, stored]) {
      const locales = new Set(half.map((entry) => entry.where.split('(')[1]?.split(',')[0]))
      expect([...locales].sort()).toEqual(['ar', 'en'])
    }

    const offenders = [...shipped, ...stored]
      .map((entry) => ({ ...entry, found: unreachableOptOutPhrasesIn(entry.body) }))
      .filter((entry) => entry.found.length > 0)
      .map((entry) => `${entry.where}: ${entry.found.join(', ')}`)
    expect(
      offenders,
      'an alphanumeric sender ID cannot receive an inbound SMS, so these promise an opt-out that does not ' +
        'exist — the link to /preferences is the only functional one this business has',
    ).toEqual([])

    // The control on the scan itself: the same predicate over the same corpus with one body broken finds it,
    // so a scan that had quietly stopped matching cannot pass this case.
    const broken = [...shipped, { where: 'fixture', body: 'Offers. Reply STOP to end.' }]
      .map((entry) => ({ ...entry, found: unreachableOptOutPhrasesIn(entry.body) }))
      .filter((entry) => entry.found.length > 0)
    expect(broken.map((entry) => entry.where)).toEqual(['fixture'])
  })
})

// ------------------------------------------------------------------------------------------------

describe('acceptance — a link for a merged-away record (C-CRM-05 NOTE 8b)', () => {
  /**
   * One rolled-back unit of work, for `merge.itest.ts`'s reason.
   *
   * `merge_record` refuses DELETE for every role including the owner (ZT001), so a committed tombstone here
   * would make every later run of this file answer `already_merged`, and would leave a merge nobody expected
   * in the estate every other suite reads. Nothing is skipped by rolling back: the trigger, the CHECKs and
   * the unique index all fire inside the transaction.
   */
  class RolledBack extends Error {}
  async function probe<T>(
    body: (uow: Parameters<Parameters<typeof withUnitOfWork>[2]>[0]) => Promise<T>,
  ) {
    let captured: T | undefined
    try {
      await withUnitOfWork(sql, ACTOR, async (uow) => {
        captured = await body(uow)
        throw new RolledBack()
      })
    } catch (error) {
      if (!(error instanceof RolledBack)) throw error
    }
    return captured as T
  }

  /** The tombstone, written directly. See the comment inside for why this is not a hand-rolled merge. */
  const tombstone = async (uow: { sql: Sql }): Promise<void> => {
    /*
      A `merge_record` row and nothing else, because `merge_survivor_of()` reads nothing else — and what is
      under test here is whether THIS unit consults it. Driving C-CRM-05's participants would re-prove the
      re-pointing that `packages/fixtures/src/merge.itest.ts` already pins from both sides, and it would
      need a scoring pair: `planCustomerMerge` refuses a pair the scorer calls distinct under both
      authorities, and two synthetic contacts with different numbers are distinct. The control below asserts
      the fixture is real, which is the property that matters.
    */
    await uow.sql`
      insert into merge_record
        (survivor_customer_id, loser_customer_id, merged_at, actor_kind, actor_label, authority, reason,
         score_per_mille, phone_agreement, label_agreement, field_resolutions)
      values (${survivorId}::uuid, ${loserId}::uuid, ${MERGE_ISO}::timestamptz, 'staff',
              'C-CRM-07 itest operator', 'operator_confirmed',
              'Joined by the front desk during the duplicate review', 960, 'one_digit_apart',
              'identical', '[]'::jsonb)
    `
  }

  it('resolves the survivor, and the withdrawal lands on the survivor’s log', async () => {
    const result = await probe(async (uow) => {
      await tombstone(uow)
      // The fixture is real: without this the resolution below could be reading an id that was never a
      // tombstone, and the case would pass over nothing.
      const [walked] = await uow.sql<{ survivor: string }[]>`
        select merge_survivor_of(${loserId}::uuid)::text as survivor
      `
      const subject = await readPreferenceSubject(uow.sql, loserId)
      const applied = await applyPreferenceSelection(uow, keying, {
        // The id the LINK names, which is the tombstone. Resolving it is the whole of the fix.
        contactCustomerId: loserId,
        action: 'unsubscribe',
        scope: { kind: 'pair', channel: 'sms', purpose: 'marketing' },
        recipient: MERGE_LOSER.phone,
        keyKind: 'phone',
        locale: 'en',
        wording: null,
        decidedAtIso: MERGE_ISO,
        actorLabel: 'Preference centre (link holder)',
      })
      const rows = await uow.sql<{ contact: string; channel: string; kind: string }[]>`
        select contact_customer_id::text as contact, channel::text as channel, kind::text as kind
          from consent
         where recorded_at = ${MERGE_ISO}::timestamptz and capture_source = 'preference_centre'
           and contact_customer_id in (${loserId}::uuid, ${survivorId}::uuid)
      `
      const suppressions = await uow.sql<{ contact: string }[]>`
        select contact_customer_id::text as contact from suppression
         where recorded_at = ${MERGE_ISO}::timestamptz and source = 'preference_centre'
      `
      return { walked: walked?.survivor, subject, applied, rows, suppressions }
    })

    expect(result.walked).toBe(survivorId)
    expect(result.subject?.contactCustomerId).toBe(survivorId)
    expect(result.subject?.wasTombstone).toBe(true)
    // The survivor's OWN number, not the loser's: the page shows and suppresses the detail the live record
    // holds, which is what a reader of the survivor's page would expect to change.
    expect(result.subject?.phoneE164).toBe(MERGE_SURVIVOR.phone)
    expect(result.applied.contactCustomerId).toBe(survivorId)
    expect(result.applied.wasTombstone).toBe(true)
    expect(result.applied.consentRows).toBe(1)

    // The row is on the SURVIVOR and there is none on the tombstone. Before this unit, the withdrawal
    // landed on the tombstone's log and `resolveConsent` for the live record never saw it — which is
    // C-CRM-05's NOTE (8b) exactly.
    expect(result.rows.map((row) => row.contact)).toEqual([survivorId])
    expect(result.rows[0]?.kind).toBe('withdrawn')
    expect(result.suppressions.map((row) => row.contact)).toEqual([survivorId])
  }, 60_000)

  it('refuses a RESUBSCRIBE through the same link, by name, and writes nothing', async () => {
    const result = await probe(async (uow) => {
      await tombstone(uow)
      let refusal: string | null = null
      try {
        await applyPreferenceSelection(uow, keying, {
          contactCustomerId: loserId,
          action: 'resubscribe',
          scope: { kind: 'pair', channel: 'sms', purpose: 'marketing' },
          recipient: MERGE_LOSER.phone,
          keyKind: 'phone',
          locale: 'en',
          wording: null,
          decidedAtIso: MERGE_ISO,
          actorLabel: 'Preference centre (link holder)',
        })
      } catch (error) {
        refusal = preferenceCentreRefusalOf(error)
      }
      const rows = await uow.sql<{ n: string }[]>`
        select count(*)::text as n from consent
         where recorded_at = ${MERGE_ISO}::timestamptz and capture_source = 'preference_centre'
      `
      return { refusal, written: Number(rows[0]?.n ?? 0) }
    })
    // A withdrawal applied too widely stops messages nobody will miss; a GRANT applied to a record the link
    // was not minted for is marketing consent nobody gave, which is the one thing `consent` exists to be
    // evidence of. So the two actions are deliberately not symmetric.
    expect(result.refusal).toBe('preference_grant_on_a_tombstone')
    expect(result.written).toBe(0)
  }, 60_000)

  it('leaves a record that was never merged pointing at itself', async () => {
    // The control on the resolution. Without it, a `readPreferenceSubject` that returned some other id
    // unconditionally would satisfy both cases above.
    const subject = await readPreferenceSubject(sql, readerId)
    expect(subject?.contactCustomerId).toBe(readerId)
    expect(subject?.wasTombstone).toBe(false)
    expect(subject?.phoneE164).toBe(READER.phone)
  })
})
