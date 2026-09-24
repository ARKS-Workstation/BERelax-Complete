import {
  OPT_OUT_NOT_FOUND,
  OPT_OUT_TOKEN_LENGTH,
  OPT_OUT_TOKEN_TTL_SECONDS,
  suppressionKeyNormaliser,
} from '@berelax/core'
import {
  type Actor,
  createConnection,
  issueOptOutGrant,
  OPTOUT_VERIFY_MAX_PER_IP,
  readSuppressionHistory,
  type Sql,
  type SuppressionKeying,
  seedConsent,
  withUnitOfWork,
} from '@berelax/db'
import { fixtureSuppressionPeppers, syntheticPerson } from '@berelax/fixtures'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  handlePreferenceRead,
  handlePreferenceWrite,
  type PreferenceEndpointDeps,
} from '../app/api/v1/preferences/handler.ts'

/**
 * C-CRM-04 — `/api/v1/preferences`, driven against a real PostgreSQL.
 *
 * The handler is called directly rather than over HTTP, for the reason `otp-route.itest.ts` gives about
 * its own: what is asserted here is the SHAPE of a refusal, and a `next start` in front of it would add a
 * router and a JSON parser to every case without changing a single one of them. No port band is taken by
 * this file (brief rule 18), because nothing here starts a server.
 *
 * ## What this file exists to prove, and it is one thing
 *
 * **Every refusal is byte-identical.** An unknown token, an expired one, a revoked one, a malformed one, a
 * missing one, a contact id that is not a uuid, and a perfectly valid token presented for somebody else's
 * page: one status, one body, byte for byte. That is not tidiness. A 403 for "expired" against a 404 for
 * "never existed" tells a caller that a given contact id has been sent a promotional message, and a
 * distinguishable "not for this contact" confirms that a contact id exists at all — and the whole point of
 * a login-free opt-out is that the URL is the only thing the holder needs, so anybody who guesses a
 * contact id must learn nothing from trying.
 *
 * The rate limit is the one deliberate exception and the last case asserts it: a 429 with `Retry-After` is
 * a fact about the caller rather than about anybody's data, and answering 404 to a flood would leave a
 * well-behaved client retrying immediately for ever.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

/**
 * Outside every band in use, including `suppression.itest.ts`'s 9301–9307.
 *
 * FOUR contacts and not two, and the split is between the ones that are READ and the ones that are
 * WRITTEN. `SUBJECT` and `OTHER` are never mutated by any case here, so the refusal cases resolve the same
 * way on a first run and on a tenth; `WRITER` and `TOGGLER` each carry exactly one mutation, at its own
 * fixed instant. One shared contact would have made the read cases depend on whether the write cases had
 * run, which is the file-ordering trap brief rule 12 is about arriving from inside one file — and worse,
 * two changes at ONE frozen instant resolve to a tie, which both resolvers deliberately fail closed on. It
 * happened while this file was being written: the withdrawal and the later re-grant landed on the same
 * millisecond, `resolveConsent` answered `unknown` and `resolveSuppression` answered `suppressed` with no
 * deciding record, and both readings were correct.
 */
const SUBJECT = syntheticPerson(9_401)
const OTHER = syntheticPerson(9_402)
const WRITER = syntheticPerson(9_403)
const TOGGLER = syntheticPerson(9_404)

const FROZEN_ISO = '2026-09-19T10:00:00.000Z'
const ACTOR: Actor = { kind: 'system', label: 'Preference route fixture' }
/** The documentation range (RFC 5737), so no case can be attributed to a real address. */
const ip = (n: number): string => `203.0.113.${100 + n}`

let sql: Sql
let deps: PreferenceEndpointDeps
let keying: SuppressionKeying
let subjectId: string
let otherId: string
let writerId: string
let togglerId: string

async function contactIdFor(phone: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from customer where phone_e164 = ${phone}`
  if (row === undefined) throw new Error(`No fixture contact for ${phone}`)
  return row.id
}

/** A request the handler can read: the two query parameters, and the proxy header it needs. */
function request(args: {
  readonly contactId?: string
  readonly token?: string | null
  readonly requestIp?: string | null
  readonly body?: unknown
}): Request {
  const params = new URLSearchParams()
  if (args.contactId !== undefined) params.set('c', args.contactId)
  if (args.token !== undefined && args.token !== null) params.set('t', args.token)
  const headers = new Headers()
  if (args.requestIp !== null) headers.set('x-forwarded-for', args.requestIp ?? ip(1))
  return new Request(`https://berelax.test/api/v1/preferences?${params.toString()}`, {
    method: args.body === undefined ? 'GET' : 'POST',
    headers,
    ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
  })
}

async function mintToken(contactId: string, ttlSeconds = OPT_OUT_TOKEN_TTL_SECONDS) {
  return withUnitOfWork(sql, ACTOR, (uow) =>
    issueOptOutGrant(uow, {
      contactCustomerId: contactId,
      channel: 'sms',
      purpose: 'preference_centre',
      issuedAtIso: FROZEN_ISO,
      ttlSeconds,
    }),
  )
}

beforeAll(async () => {
  sql = createConnection({ url: url as string, max: 4 })
  keying = { peppers: fixtureSuppressionPeppers(process.env), normalise: suppressionKeyNormaliser }
  deps = { sql, now: () => FROZEN_ISO, keying }

  // The attempt log is the ONE table this unit can clean, and with a frozen clock it has to be. Every case
  // below is evaluated at a fixed instant, so the sixty-second rate-limit window never slides between runs:
  // a row written by an earlier run of this file is still inside the window of this one, and after ten runs
  // a case that makes a single verification would be refused with 429 by its own history. That happened
  // while this file was being written, and it is why `optout_verification_attempt` keeps DELETE granted
  // while `suppression` refuses it — the comment on the table says so. The documentation range (RFC 5737)
  // is this unit's, and the two integration files that use it run sequentially (`fileParallelism: false`),
  // so clearing it here cannot remove a row the other one is about to assert on.
  await sql`delete from optout_verification_attempt where request_ip << '203.0.113.0/24'::inet`
  // Idempotent, and it creates the `customer` rows as well as the grants — `customer-identity.itest.ts`
  // clears that table between its cases, so a file that assumed a contact was still there would pass or
  // fail on vitest's file ordering (brief rule 12).
  await seedConsent(sql, {
    contacts: [SUBJECT, OTHER, WRITER, TOGGLER].map((person) => ({
      phoneE164: person.phone,
      locale: 'en' as const,
      state: 'granted' as const,
      label: person.label,
    })),
    recordedAtIso: '2026-09-18T10:00:00.000Z',
  })
  subjectId = await contactIdFor(SUBJECT.phone)
  otherId = await contactIdFor(OTHER.phone)
  writerId = await contactIdFor(WRITER.phone)
  togglerId = await contactIdFor(TOGGLER.phone)
})

afterAll(async () => {
  await sql.end({ timeout: 5 })
})

describe('acceptance — every refusal is byte-identical', () => {
  it('serves the preference view for a valid token, so the refusals below are about the fault', async () => {
    // THE positive control. Without it, an endpoint that answered 404 to everything would satisfy every
    // case in this describe.
    const issued = await mintToken(subjectId)
    const response = await handlePreferenceRead(
      deps,
      request({ contactId: subjectId, token: issued.token, requestIp: ip(1) }),
    )
    expect(response.status).toBe(200)
    const view = (await response.json()) as {
      contactId: string
      states: { channel: string; purpose: string; consent: string }[]
      suppressed: boolean
      wording: { textEn: string; textAr: string; isProvisional: boolean } | null
    }
    expect(view.contactId).toBe(subjectId)
    // Three channels × two send-gating purposes, all granted by the seed.
    expect(view.states).toHaveLength(6)
    expect(view.states.every((state) => state.consent === 'granted')).toBe(true)
    expect(view.suppressed).toBe(false)
    // Both languages, from the version a resubscribe would be recorded against — and flagged provisional,
    // because the seeded statement is this build's draft (`Y9-consent-wording`) and a page that presented
    // it as approved copy would be doing exactly what brief rule 15 is about.
    expect(view.wording?.textEn.length ?? 0).toBeGreaterThan(0)
    expect(view.wording?.textAr.length ?? 0).toBeGreaterThan(0)
    expect(view.wording?.isProvisional).toBe(true)
    // And no contact detail anywhere in the body: the page renders preferences, not a phone number.
    const raw = JSON.stringify(view)
    expect(raw).not.toContain(SUBJECT.phone)
    expect(raw).not.toContain(SUBJECT.email)
  })

  it('answers ONE status and ONE body for every kind of bad token', async () => {
    const valid = await mintToken(subjectId)
    const revoked = await mintToken(subjectId)
    await sql`delete from optout_grant where id = ${revoked.grantId}::uuid`
    const expired = await mintToken(subjectId, 60)

    const cases: readonly {
      readonly label: string
      readonly request: Request
      /** Overridden only for the expired case, which needs an instant past its own expiry. */
      readonly nowIso?: string
    }[] = [
      { label: 'no token at all', request: request({ contactId: subjectId, requestIp: ip(2) }) },
      {
        label: 'a malformed token',
        request: request({ contactId: subjectId, token: 'not-a-token', requestIp: ip(3) }),
      },
      {
        label: 'a well-formed token nothing holds',
        request: request({
          contactId: subjectId,
          token: 'A'.repeat(OPT_OUT_TOKEN_LENGTH),
          requestIp: ip(4),
        }),
      },
      {
        label: 'a revoked token',
        request: request({ contactId: subjectId, token: revoked.token, requestIp: ip(5) }),
      },
      {
        label: 'an expired token',
        // Minted with a 60-second life at the frozen instant and presented two minutes later. The clock
        // is an argument all the way down, so "later" costs nothing and the control below presents the
        // SAME grant thirty seconds in and is served — which is the only way to tell that the expiry arm
        // was reached at all, since an expired token is indistinguishable from an unknown one by design.
        request: request({ contactId: subjectId, token: expired.token, requestIp: ip(6) }),
        nowIso: '2026-09-19T10:02:00.000Z',
      },
      {
        label: 'a contact id that is not a uuid',
        request: request({ contactId: 'customer-42', token: valid.token, requestIp: ip(7) }),
      },
      {
        // The acceptance criterion's own case, and the most important one in the file: a perfectly VALID
        // token for contact A, asking for contact B's page.
        label: "a valid token for another contact's page",
        request: request({ contactId: otherId, token: valid.token, requestIp: ip(8) }),
      },
    ]

    const bodies: string[] = []
    for (const probe of cases) {
      const response = await handlePreferenceRead(
        probe.nowIso === undefined ? deps : { ...deps, now: () => probe.nowIso as string },
        probe.request,
      )
      expect(response.status, probe.label).toBe(OPT_OUT_NOT_FOUND.status)
      bodies.push(await response.text())
    }
    // Byte for byte, all of them, and equal to the ONE declared body. Compared as a set so the failure
    // names the odd one out rather than the first pair that differed.
    expect(
      new Set(bodies).size,
      `distinct refusal bodies: ${[...new Set(bodies)].join(' | ')}`,
    ).toBe(1)
    expect(bodies[0]).toBe(JSON.stringify(OPT_OUT_NOT_FOUND.body))

    // The control on the expired case specifically, because "expired" is indistinguishable from "unknown"
    // by design and a test could not otherwise tell that the expiry arm was reached at all: the same
    // grant, presented a second BEFORE it expires, is served.
    const beforeExpiry = await handlePreferenceRead(
      { ...deps, now: () => '2026-09-19T10:00:30.000Z' },
      request({ contactId: subjectId, token: expired.token, requestIp: ip(9) }),
    )
    expect(beforeExpiry.status).toBe(200)
  })

  it('refuses a request it cannot attribute, by name, rather than serving it unlimited', async () => {
    const issued = await mintToken(subjectId)
    const response = await handlePreferenceRead(
      deps,
      request({ contactId: subjectId, token: issued.token, requestIp: null }),
    )
    // NOT the 404: this is a fact about the request rather than about anybody's data, and the endpoint's
    // only defence is per-address. `otp_challenge.request_ip` is nullable and this table's is not, because
    // the OTP endpoint has a per-number limit that still binds and this one has nothing to fall back on.
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toBe('unattributable_request')
  })
})

describe('acceptance — the change a customer makes', () => {
  it('records an unsubscribe, and the view then says so', async () => {
    const issued = await mintToken(writerId)
    const write = await handlePreferenceWrite(
      deps,
      request({
        contactId: writerId,
        token: issued.token,
        requestIp: ip(20),
        body: { action: 'unsubscribe', locale: 'en' },
      }),
    )
    expect(write.status).toBe(200)
    const result = (await write.json()) as { status: string; action: string }
    expect(result).toMatchObject({ status: 'recorded', action: 'unsubscribe' })

    // Both halves landed. The suppression is what outlives a later consent grant, which is the whole
    // reason the precedence rule is "suppression beats consent with no exceptions".
    const history = await readSuppressionHistory(sql, keying, {
      keyKind: 'phone',
      recipient: WRITER.phone,
    })
    expect(history.some((row) => row.source === 'preference_centre')).toBe(true)
    expect(history[0]?.actorKind).toBe('customer')

    const read = await handlePreferenceRead(
      deps,
      request({ contactId: writerId, token: issued.token, requestIp: ip(21) }),
    )
    const view = (await read.json()) as {
      suppressed: boolean
      suppressionSource: string | null
      states: { consent: string }[]
    }
    expect(view.suppressed).toBe(true)
    expect(view.suppressionSource).toBe('preference_centre')
    expect(view.states.every((state) => state.consent === 'withdrawn')).toBe(true)
  })

  it('refuses an unrecognised action rather than defaulting it', async () => {
    const issued = await mintToken(togglerId)
    for (const body of [{ action: 'stop' }, { action: null }, {}, 'unsubscribe']) {
      const response = await handlePreferenceWrite(
        deps,
        request({ contactId: togglerId, token: issued.token, requestIp: ip(22), body }),
      )
      expect(response.status, JSON.stringify(body)).toBe(400)
    }
    // The control: the recognised action on the same token is accepted, so the 400s are about the action.
    // At its own instant, five minutes after the frozen one, so this contact's one mutation cannot tie with
    // anything — see the note on the four probe contacts.
    const accepted = await handlePreferenceWrite(
      { ...deps, now: () => '2026-09-19T10:05:00.000Z' },
      request({
        contactId: togglerId,
        token: issued.token,
        requestIp: ip(23),
        body: { action: 'resubscribe', locale: 'ar' },
      }),
    )
    expect(accepted.status).toBe(200)
  })

  it('refuses a WRITE with a bad token the same way it refuses a read', async () => {
    const response = await handlePreferenceWrite(
      deps,
      request({
        contactId: togglerId,
        token: 'A'.repeat(OPT_OUT_TOKEN_LENGTH),
        requestIp: ip(24),
        body: { action: 'unsubscribe' },
      }),
    )
    expect(response.status).toBe(OPT_OUT_NOT_FOUND.status)
    expect(await response.text()).toBe(JSON.stringify(OPT_OUT_NOT_FOUND.body))
  })
})

describe('acceptance — the rate limit', () => {
  it('refuses the 11th verification from one address inside a minute, with Retry-After', async () => {
    const address = ip(50)
    await sql`delete from optout_verification_attempt where request_ip = ${address}::inet`
    const issued = await mintToken(subjectId)
    for (let i = 0; i < OPTOUT_VERIFY_MAX_PER_IP; i += 1) {
      const response = await handlePreferenceRead(
        deps,
        request({ contactId: subjectId, token: issued.token, requestIp: address }),
      )
      expect(response.status, `attempt ${i + 1}`).toBe(200)
    }
    const refused = await handlePreferenceRead(
      deps,
      request({ contactId: subjectId, token: issued.token, requestIp: address }),
    )
    // The ONE distinguishable refusal in this endpoint, and deliberately so: a 404 to a flood would leave
    // a well-behaved client retrying immediately for ever.
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).not.toBeNull()
    const body = (await refused.json()) as { error: string; retryAfterSeconds: number }
    expect(body.error).toBe('too_many_requests')
    expect(body.retryAfterSeconds).toBeGreaterThan(0)

    // Two controls. A different address is unaffected by this one's flood…
    expect(
      (
        await handlePreferenceRead(
          deps,
          request({ contactId: subjectId, token: issued.token, requestIp: ip(51) }),
        )
      ).status,
    ).toBe(200)
    // …and the window slides, so the same address is served again a minute later.
    expect(
      (
        await handlePreferenceRead(
          { ...deps, now: () => '2026-09-19T10:01:30.000Z' },
          request({ contactId: subjectId, token: issued.token, requestIp: address }),
        )
      ).status,
    ).toBe(200)

    for (const address_ of [address, ip(51)]) {
      await sql`delete from optout_verification_attempt where request_ip = ${address_}::inet`
    }
  })
})
