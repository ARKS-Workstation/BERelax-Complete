import type { CmsPrincipal } from '@berelax/cms'
import { type Instant, instantFromIso } from '@berelax/core'
import { createConnection, type Sql } from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  handleReviewsPasteRead,
  handleReviewsPasteWrite,
  pasteActorFor,
  REVIEWS_PASTE_PERMISSION,
} from '../app/(admin)/reviews/paste/handler.ts'
import { REVIEWS_PASTE_FIELDS, REVIEWS_PASTE_PATH } from '../app/(admin)/reviews/paste/view.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * G-REV-02 — the paste form's handler, driven directly against real PostgreSQL on a frozen clock.
 *
 * ## Why the row claims are here and not in the e2e beside it
 *
 * Because `reviews-paste.itest.ts` drives the BUILT application: `next start` serves whatever `.next` was
 * last built, so a change to this handler's source does not reach it without a rebuild. That makes the e2e
 * the right place for the one claim that needs a browser — *completes in one form submission* — and the
 * wrong place for every other claim, because a gate case that mutates this file and runs the e2e proves
 * nothing. That is not a hypothetical: the first version of this unit's gate block had four cases doing
 * exactly that and all four reported "exited zero; nothing was rejected" against a stale build.
 *
 * So the split is: the browser asserts the number of POSTs, and this file asserts the row, the audit actor,
 * the two refusals, the refusal page's contents and the redirect — each of which a mutation to this handler
 * changes immediately.
 *
 * ## The principal is a fixture, and there is no `?role=` anywhere
 *
 * The handler takes a `CmsPrincipal` and decides with `can()` from the F07 matrix. Here the principal is a
 * literal this file constructs, which is what lets one case be an owner and the next a marketer with no
 * sign-in; the ROUTE resolves it from Payload's verified session, and the e2e signs in for real so that path
 * is exercised too. Nothing in either reads a role from the query string — W-SYS-11's first acceptance line
 * is a repository-wide scan for that, and a form that WRITES must not be what fails it.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind (brief
 * rule 12). Rows are removed intake-first because of the RESTRICT chain, every assertion names this file's
 * own listing, and `audit_event` is append-only (ADR 0008) so its assertion is a DELTA counted in SQL.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** 20:15 Asia/Dubai on Tuesday 22 September 2026, frozen. The future-date refusal is measured from it. */
const NOW = instantFromIso('2026-09-22T16:15:00.000Z')

/** The date typed into the form: two days before `NOW`, so it is in the past whatever the clock says. */
const REVIEWED_ON = '2026-09-20'

const PLACE = 'ChIJ_berelax_paste_handler_place'
const CT = Buffer.from('ciphertext-stand-in')

/**
 * A principal this file constructs. Not a staff member: an id and a role, which is all the matrix reads.
 *
 * The ids are UUIDs because Payload mints UUIDs here and `audit_event.actor_id` is a `uuid` column. The
 * non-uuid case is asserted separately, because Payload's id shape is a configuration choice and a readable
 * id used to make every paste a 500 from the audit insert.
 */
const PRINCIPAL_IDS: Readonly<Record<string, string>> = {
  owner: '00000000-0000-4000-8000-00000000fa01',
  manager: '00000000-0000-4000-8000-00000000fa02',
  receptionist: '00000000-0000-4000-8000-00000000fa03',
  marketer: '00000000-0000-4000-8000-00000000fa04',
}
const AS = (role: CmsPrincipal['role']): CmsPrincipal => ({
  id: PRINCIPAL_IDS[role] ?? '00000000-0000-4000-8000-00000000fa09',
  role,
})

/** No banner and a return path. The chrome is the route's concern; this file is about the decision. */
const CHROME: AdminChrome = { googleReauth: null, sendBacklog: null, returnTo: REVIEWS_PASTE_PATH }

let sql: Sql
let connectionId = ''

async function seedConnection(): Promise<string> {
  const [connection] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
    values ('sub-review-paste-handler', 'owner@berelax.ae',
            ${sql.array(['https://www.googleapis.com/auth/business.manage'])},
            ${CT}, ${CT}, ${CT}, 'v1', 'fp-stand-in')
    returning id
  `
  const id = connection?.id ?? ''
  await sql`
    insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary)
    values (${id}, 'gbp_reviews', ${sql.json({ placeId: PLACE })}, 'permission_missing', true)
  `
  return id
}

async function clean(): Promise<void> {
  await sql`delete from review_intake_email where place_id = ${PLACE}`
  await sql`delete from google_reviews where place_id = ${PLACE}`
  await sql`delete from google_connections where google_sub = 'sub-review-paste-handler'`
}

async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

const deps = () => ({ sql, now: () => NOW as Instant })

function body(fields: Record<string, string>): URLSearchParams {
  return new URLSearchParams(fields)
}

const validFields = (): Record<string, string> => ({
  [REVIEWS_PASTE_FIELDS.connection]: connectionId,
  [REVIEWS_PASTE_FIELDS.placeId]: PLACE,
  [REVIEWS_PASTE_FIELDS.rating]: '4',
  [REVIEWS_PASTE_FIELDS.reviewer]: 'A Google user',
  [REVIEWS_PASTE_FIELDS.reviewedOn]: REVIEWED_ON,
  [REVIEWS_PASTE_FIELDS.comment]: 'Quiet room and the towels were warm.',
})

async function write(
  principal: CmsPrincipal | null,
  fields: Record<string, string>,
): Promise<Response> {
  return await handleReviewsPasteWrite(
    {
      searchParams: new URLSearchParams(),
      chrome: CHROME,
      body: body(fields),
      principal,
      requestId: 'req-grev02',
    },
    deps(),
  )
}

async function read(
  principal: CmsPrincipal | null,
  search = new URLSearchParams(),
): Promise<Response> {
  return await handleReviewsPasteRead(
    { searchParams: search, chrome: CHROME, body: null, principal, requestId: null },
    deps(),
  )
}

beforeAll(() => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
})

afterAll(async () => {
  await clean()
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await clean()
  connectionId = await seedConnection()
})

describe('acceptance — the row the paste form writes', () => {
  it("records source='paste', delivery_mode='manual' and google_review_id NULL", async () => {
    const response = await write(AS('receptionist'), validFields())
    // 303, not 200: a reload of a 200 would re-post and file the same review twice under two ids, and
    // `google_review_id` is NULL on a pasted row so nothing in the database would refuse the duplicate.
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('created=')

    const [row] = await sql<
      {
        id: string
        source: string
        delivery_mode: string
        google_review_id: string | null
        rating: number
        comment_text: string | null
        reviewer_display_name: string
        reviewed_at: Date
      }[]
    >`
      select id::text as id, source, delivery_mode, google_review_id, rating, comment_text,
             reviewer_display_name, reviewed_at
      from google_reviews where place_id = ${PLACE}
    `
    expect(row?.source).toBe('paste')
    expect(row?.delivery_mode).toBe('manual')
    expect(row?.google_review_id).toBeNull()
    expect(row?.rating).toBe(4)
    expect(row?.comment_text).toBe('Quiet room and the towels were warm.')
    expect(row?.reviewer_display_name).toBe('A Google user')
    // The date read back in Asia/Dubai is the date that was typed, which is the only property
    // reconciliation needs (migration 0020) — and the instant is the start of that day rather than an
    // invented midday.
    expect(
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(row?.reviewed_at),
    ).toBe(REVIEWED_ON)
  })

  it('writes an audit_event naming the signed-in operator, not the surface', async () => {
    const before = await auditCount('google_review.recorded')
    await write(AS('receptionist'), validFields())
    expect(await auditCount('google_review.recorded')).toBe(before + 1)

    const [row] = await sql<{ id: string }[]>`
      select id::text as id from google_reviews where place_id = ${PLACE}
    `
    const [audit] = await sql<
      {
        actor_kind: string
        actor_id: string | null
        actor_label: string
        request_id: string | null
      }[]
    >`
      select actor_kind, actor_id, actor_label, request_id from audit_event
      where action = 'google_review.recorded' and entity_id = ${row?.id ?? ''}
    `
    expect(audit?.actor_kind).toBe('staff')
    // The principal's own id, from the verified session. The diary, the pipeline board and the quick-book
    // screen all record the SURFACE instead, correctly, because they have no session to read — this one has.
    expect(audit?.actor_id).toBe(PRINCIPAL_IDS['receptionist'])
    expect(audit?.actor_label).toBe(pasteActorFor(AS('receptionist')).label)
    expect(audit?.actor_label).toContain('receptionist')
    expect(audit?.request_id).toBe('req-grev02')
  })

  it('records the paste when the session id is not a UUID, naming the actor in the label', async () => {
    // Payload's id shape is a configuration choice: it is a UUID here and an integer in a default setup, and
    // `audit_event.actor_id` is a `uuid` column. A readable id made every paste a 500 from the audit insert,
    // which is how `pasteActorFor`'s UUID check came to exist. The row still identifies the actor, because
    // the LABEL carries the principal.
    const response = await write({ id: '4711', role: 'receptionist' }, validFields())
    expect(response.status).toBe(303)
    const [row] = await sql<{ id: string }[]>`
      select id::text as id from google_reviews where place_id = ${PLACE}
    `
    const [audit] = await sql<{ actor_id: string | null; actor_label: string }[]>`
      select actor_id, actor_label from audit_event
      where action = 'google_review.recorded' and entity_id = ${row?.id ?? ''}
    `
    expect(audit?.actor_id).toBeNull()
    expect(audit?.actor_label).toContain('4711')
    expect(audit?.actor_label).toContain('receptionist')
  })

  it('records a star-only review as NULL and never as an empty string', async () => {
    await write(AS('receptionist'), {
      ...validFields(),
      [REVIEWS_PASTE_FIELDS.comment]: '   ',
    })
    const [row] = await sql<{ comment_text: string | null }[]>`
      select comment_text from google_reviews where place_id = ${PLACE}
    `
    expect(row?.comment_text).toBeNull()
  })

  it('closes the forwarded message it was opened from, in the same transaction', async () => {
    const [intake] = await sql<{ id: string }[]>`
      insert into review_intake_email
        (connection_id, place_id, status, refusal, raw_body, raw_body_sha256, raw_body_bytes, received_at)
      values (${connectionId}, ${PLACE}, 'needs_paste', 'no_template_recognised',
              'somebody left you feedback', ${'c'.repeat(64)}, 26,
              ${'2026-09-21T10:00:00.000Z'}::timestamptz)
      returning id
    `
    const response = await write(AS('receptionist'), {
      ...validFields(),
      [REVIEWS_PASTE_FIELDS.intake]: intake?.id ?? '',
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toContain('intakeResolved=1')
    const [row] = await sql<{ resolved_at: Date | null; review_id: string | null }[]>`
      select resolved_at, review_id::text as review_id from review_intake_email
      where id = ${intake?.id ?? ''}::uuid
    `
    expect(row?.resolved_at).not.toBeNull()
    expect(row?.review_id).not.toBeNull()
  })

  it('refuses an item somebody else has already closed, and writes NOTHING', async () => {
    // Two operators can open the same queue item. The loser must not silently re-point it at their own
    // review, and must not file a second copy of one review either — so the refusal happens before the
    // write and the request is 409 rather than 400: nothing about it was malformed.
    const [review] = await sql<{ id: string }[]>`
      insert into google_reviews
        (connection_id, place_id, source, delivery_mode, rating, reviewer_display_name, reviewed_at)
      values (${connectionId}, ${PLACE}, 'paste', 'manual', 5, 'A Google user',
              ${'2026-09-20T20:00:00.000Z'}::timestamptz)
      returning id::text as id
    `
    const [intake] = await sql<{ id: string }[]>`
      insert into review_intake_email
        (connection_id, place_id, status, refusal, raw_body, raw_body_sha256, raw_body_bytes,
         received_at, resolved_at, review_id)
      values (${connectionId}, ${PLACE}, 'needs_paste', 'no_template_recognised',
              'already dealt with', ${'d'.repeat(64)}, 18,
              ${'2026-09-21T10:00:00.000Z'}::timestamptz, ${'2026-09-21T11:00:00.000Z'}::timestamptz,
              ${review?.id ?? ''}::uuid)
      returning id::text as id
    `
    const response = await write(AS('receptionist'), {
      ...validFields(),
      [REVIEWS_PASTE_FIELDS.intake]: intake?.id ?? '',
    })
    expect(response.status).toBe(409)
    expect(await response.text()).toContain('already been dealt with')
    // ONE review: the one seeded above, and not a second one from the refused submission.
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_reviews where place_id = ${PLACE}
    `
    expect(row?.n).toBe('1')
  })
})

describe('authorisation is server-side, in both verbs', () => {
  it('refuses an unauthenticated read with 401', async () => {
    const response = await read(null)
    expect(response.status).toBe(401)
  })

  it('refuses an unauthenticated write with 401 and writes nothing', async () => {
    const response = await write(null, validFields())
    expect(response.status).toBe(401)
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_reviews where place_id = ${PLACE}
    `
    expect(row?.n).toBe('0')
  })

  it('refuses a role the matrix does not trust with 403, in both verbs', async () => {
    expect((await read(AS('marketer'))).status).toBe(403)
    expect((await write(AS('marketer'), validFields())).status).toBe(403)
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_reviews where place_id = ${PLACE}
    `
    expect(row?.n).toBe('0')
  })

  it('serves the roles the matrix does trust, so the 403 is about the role', async () => {
    // The control. Without it a guard that refused everybody would satisfy every assertion above.
    for (const role of ['owner', 'manager', 'receptionist'] as const) {
      expect((await read(AS(role))).status).toBe(200)
    }
    expect(REVIEWS_PASTE_PERMISSION).toBe('review:record')
  })

  it('shows NOTHING from the database on a refusal page', async () => {
    // The defect this unit's own e2e found first: the refusal page rendered the queue, so the 401 document
    // carried a forwarded review's full text, the connection id and the Google account email. A page that
    // says "you may not see this" must not be the page that shows it.
    await sql`
      insert into review_intake_email
        (connection_id, place_id, status, refusal, raw_body, raw_body_sha256, raw_body_bytes, received_at)
      values (${connectionId}, ${PLACE}, 'needs_paste', 'no_template_recognised',
              'a distinctive forwarded body nobody signed in should see', ${'e'.repeat(64)}, 55,
              ${'2026-09-21T10:00:00.000Z'}::timestamptz)
    `
    for (const principal of [null, AS('marketer')]) {
      const text = await (await read(principal)).text()
      expect(text).not.toContain('a distinctive forwarded body nobody signed in should see')
      expect(text).not.toContain(connectionId)
      expect(text).not.toContain('owner@berelax.ae')
      expect(text).not.toContain(PLACE)
      // Not vacuous: the refusal itself is on the page, so this is about what is absent from a document that
      // was rendered rather than about an empty response.
      expect(text).toMatch(/needs a signed-in admin session|may not record a review/)
    }
    // And the control: a reader who IS entitled sees it, so the absence above is about the refusal.
    expect(await (await read(AS('receptionist'))).text()).toContain(
      'a distinctive forwarded body nobody signed in should see',
    )
  })
})

describe('the refusals a wrong submission gets', () => {
  it('refuses a date that has not happened yet', async () => {
    const response = await write(AS('receptionist'), {
      ...validFields(),
      [REVIEWS_PASTE_FIELDS.reviewedOn]: '2099-01-01',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('has not happened yet')
  })

  it('refuses a date one day after the frozen clock, which is the boundary', async () => {
    // 2026-09-23 starts after `NOW` (20:15 on the 22nd in Dubai), so it is in the future by hours rather
    // than by years — the case a `getFullYear` comparison would let through.
    const response = await write(AS('receptionist'), {
      ...validFields(),
      [REVIEWS_PASTE_FIELDS.reviewedOn]: '2026-09-23',
    })
    expect(response.status).toBe(400)
  })

  it('accepts the same day as the frozen clock, so the boundary is not off by one', async () => {
    // 00:00 on the 22nd in Dubai is before 20:15 on the 22nd, so today's review is acceptable.
    const response = await write(AS('receptionist'), {
      ...validFields(),
      [REVIEWS_PASTE_FIELDS.reviewedOn]: '2026-09-22',
    })
    expect(response.status).toBe(303)
  })

  it('refuses a rating outside 1-5 and a missing one', async () => {
    for (const rating of ['6', '0', '', 'four']) {
      const response = await write(AS('receptionist'), {
        ...validFields(),
        [REVIEWS_PASTE_FIELDS.rating]: rating,
      })
      expect(response.status, rating).toBe(400)
    }
  })

  it('refuses a blank reviewer, because reconciliation matches on it', async () => {
    const response = await write(AS('receptionist'), {
      ...validFields(),
      [REVIEWS_PASTE_FIELDS.reviewer]: '  ',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('reconciliation matches on')
  })

  it('refuses a connection this system does not manage', async () => {
    const response = await write(AS('receptionist'), {
      ...validFields(),
      [REVIEWS_PASTE_FIELDS.connection]: '11111111-1111-1111-1111-111111111111',
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('not a listing this system manages')
  })

  it('refuses a place that is not a resource of the submitted connection', async () => {
    // Migration 0020's trigger would refuse the row anyway; refusing here makes it a sentence the desk can
    // act on rather than a 503 from the database.
    const response = await write(AS('receptionist'), {
      ...validFields(),
      [REVIEWS_PASTE_FIELDS.placeId]: 'ChIJ_some_other_listing',
    })
    expect(response.status).toBe(400)
  })

  it('refuses an empty body rather than answering 500', async () => {
    const response = await handleReviewsPasteWrite(
      {
        searchParams: new URLSearchParams(),
        chrome: CHROME,
        body: new URLSearchParams(),
        principal: AS('receptionist'),
        requestId: null,
      },
      deps(),
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('not a submission this form could have sent')
  })

  it('writes nothing for any refusal, counted after all of them', async () => {
    const before = await auditCount('google_review.recorded')
    for (const fields of [
      { ...validFields(), [REVIEWS_PASTE_FIELDS.rating]: '9' },
      { ...validFields(), [REVIEWS_PASTE_FIELDS.reviewer]: '' },
      { ...validFields(), [REVIEWS_PASTE_FIELDS.reviewedOn]: '' },
      { ...validFields(), [REVIEWS_PASTE_FIELDS.reviewedOn]: 'not-a-date' },
    ]) {
      expect((await write(AS('receptionist'), fields)).status).toBe(400)
    }
    expect(await auditCount('google_review.recorded')).toBe(before)
    const [row] = await sql<{ n: string }[]>`
      select count(*)::text as n from google_reviews where place_id = ${PLACE}
    `
    expect(row?.n).toBe('0')
  })
})
