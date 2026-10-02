import {
  HOUSE_DRAFT_LINT_VERSION,
  type Instant,
  instantFromIso,
  REVIEW_ESCALATION_LEXICON_VERSION,
} from '@berelax/core'
import {
  createConnection,
  getReview,
  recordManualReview,
  recordReplyDraft,
  recordRoutingVerdict,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { reproduceReplyLint } from '@berelax/google'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  handleReviewApprove,
  handleReviewDetailRead,
  handleReviewMarkPosted,
} from '../app/(admin)/reviews/[id]/handler.ts'
import { handleReviewsQueueRead, REVIEWS_QUEUE_PERMISSION } from '../app/(admin)/reviews/handler.ts'
import {
  REVIEWS_APPROVE_FIELDS,
  REVIEWS_QUEUE_PATH,
  reviewPath,
} from '../app/(admin)/reviews/view.ts'
import type { AdminChrome } from './components/admin/google-reauth-banner.ts'

/**
 * G-REV-06 — the approval queue's handlers, driven directly against real PostgreSQL.
 *
 * ## Why these claims are here and not in the browser suite beside them
 *
 * `reviews-queue.itest.ts` drives the BUILT application: `next start` serves whatever `.next` was last
 * built, so a change to these handlers does not reach it without a rebuild — which makes it the right
 * place for the claims that need a browser (the clipboard, axe, the screenshots) and the wrong place for
 * every other claim. G-REV-02 records the same split, and records why: *"the first version of this unit's
 * gate block had four cases doing exactly that and all four reported 'exited zero; nothing was rejected'
 * against a stale build."*
 *
 * So the browser asserts what only a browser can, and this file asserts the rows, the refusals, the audit
 * actors and the two database floors — each of which a mutation to a handler changes immediately.
 *
 * ## Isolation
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind (brief
 * rule 12). Every assertion names this file's own listing, every delete is scoped to it, and `audit_event`
 * is append-only (ADR 0008) so its assertions are DELTAS counted in SQL.
 *
 * ## No invented name
 *
 * `A Google user` is what Google shows for a reviewer with no public name, and it is the label G-REV-02's
 * own suites use. No therapist, no customer and no staff member is named anywhere here: the principals are
 * uuids and a role, which is all the F07 matrix reads.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (DATABASE_URL === '')
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

/** 09:00 Asia/Dubai on Tuesday 22 September 2026, frozen. The page prints it; nothing else reads it. */
const NOW = instantFromIso('2026-09-22T05:00:00.000Z')

const PLACE = 'ChIJ_berelax_queue_handler_place'
const OTHER_PLACE = 'ChIJ_berelax_queue_handler_other'
const SUB = 'sub-review-queue-handler'
const OTHER_SUB = 'sub-review-queue-handler-other'
const CT = Buffer.from('ciphertext-stand-in')
const REVIEWER = 'A Google user'

/** A reply the send-path linter clears. The same sentence G-REV-05's own delivery suite uses. */
const CLEAN = 'Thank you for the feedback. We look forward to welcoming you back.'

/**
 * A hand-edited reply carrying a banned claim.
 *
 * `treatment` is on `regulatory_profile.banned_claim_terms` (migration 0004), and it is quoted from that
 * list rather than invented — it is the exact word that made 32 of G-REV-04's house renderings
 * unpublishable, which G-REV-05 found and fixed. So this fixture is the live rule rather than a guess at
 * one, and the rule it must be refused by is `banned_claim_term`.
 */
const BANNED = 'Thank you for the feedback. Your treatment was carried out exactly as planned.'

/** The machine's draft, so the detail screen has something to start the textarea from. */
const DRAFT = 'Thank you for telling us. Please contact the salon directly so we can look into it.'

const ACTOR = { kind: 'staff', id: '66666666-6666-4666-8666-666666666666', label: 'Queue' } as const

const PRINCIPAL_IDS: Readonly<Record<string, string>> = {
  owner: '00000000-0000-4000-8000-00000000fb01',
  manager: '00000000-0000-4000-8000-00000000fb02',
  receptionist: '00000000-0000-4000-8000-00000000fb03',
}
const AS = (role: 'owner' | 'manager' | 'receptionist') => ({
  id: PRINCIPAL_IDS[role] ?? '00000000-0000-4000-8000-00000000fb09',
  role,
})

/** No banner and a return path. The chrome is the route's concern; this file is about the decision. */
const CHROME: AdminChrome = { googleReauth: null, returnTo: REVIEWS_QUEUE_PATH }

let sql: Sql
let connectionId = ''
let otherConnectionId = ''

async function seedConnection(sub: string, place: string): Promise<string> {
  const [connection] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
    values (${sub}, 'owner@berelax.ae',
            ${sql.array(['https://www.googleapis.com/auth/business.manage'])},
            ${CT}, ${CT}, ${CT}, 'v1', 'fp-stand-in')
    returning id
  `
  const id = connection?.id ?? ''
  await sql`
    insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary)
    values (${id}, 'gbp_reviews', ${sql.json({ placeId: place })}, 'permission_missing', true)
  `
  return id
}

async function clean(): Promise<void> {
  await sql`delete from review_intake_email where place_id in (${PLACE}, ${OTHER_PLACE})`
  await sql`delete from google_reviews where place_id in (${PLACE}, ${OTHER_PLACE})`
  await sql`delete from google_connections where google_sub in (${SUB}, ${OTHER_SUB})`
}

/** A delta, counted in SQL. `audit_event` only grows, so a total is a different number every run. */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

async function auditRow(action: string, reviewId: string) {
  const [row] = await sql<
    { actor_kind: string; actor_id: string | null; actor_label: string; after_state: unknown }[]
  >`
    select actor_kind, actor_id, actor_label, after_state from audit_event
    where action = ${action} and entity_id = ${reviewId}
    order by occurred_at desc limit 1
  `
  return row
}

/**
 * A routed, drafted review awaiting approval — the state the approval queue works from.
 *
 * The verdict is written through `recordRoutingVerdict` rather than inserted, because the row the screen
 * explains has to be the row the router writes: the rule id and the lexicon version are what
 * `explainReviewEscalation` reads, and an invented pair would make the escalation assertions a test of
 * this file's fixture.
 */
async function reviewAwaitingApproval(
  options: {
    readonly place?: string
    readonly connection?: string
    readonly rating?: number
    readonly comment?: string | null
    readonly draft?: string | null
  } = {},
): Promise<string> {
  const place = options.place ?? PLACE
  const connection = options.connection ?? connectionId
  const { id } = await withUnitOfWork(sql, ACTOR, (uow) =>
    recordManualReview(uow, {
      connectionId: connection,
      placeId: place,
      source: 'paste',
      rating: options.rating ?? 1,
      comment:
        options.comment === undefined
          ? 'One star. I asked for a refund and nobody answered.'
          : options.comment,
      reviewerDisplayName: REVIEWER,
      reviewedAtIso: '2026-09-20T09:00:00.000Z',
    }),
  )
  await withUnitOfWork(sql, ACTOR, (uow) =>
    recordRoutingVerdict(uow, id, {
      verdict: 'escalate',
      ruleId: 'rating_escalates',
      // The version the verdict is taken against, from `@berelax/core` rather than spelled here: the
      // whole claim the escalation panel makes is that the categories come from the lexicon this string
      // names, and a copy of it would be the one that went stale.
      lexiconVersion: REVIEW_ESCALATION_LEXICON_VERSION,
      categories: ['refund'],
    }),
  )
  const draft = options.draft === undefined ? DRAFT : options.draft
  if (draft !== null) {
    await withUnitOfWork(sql, ACTOR, (uow) =>
      recordReplyDraft(uow, id, {
        draft,
        skeletonId: 'apology',
        aspects: [],
        language: 'en',
        promptVersion: 'g-rev-04-1',
        promptFingerprint: 'f'.repeat(64),
        lintVersion: HOUSE_DRAFT_LINT_VERSION,
      }),
    )
  }
  return id
}

const deps = () => ({ sql, now: () => NOW as Instant })

const queueRequest = (query = '', principal = AS('owner')) => ({
  searchParams: new URLSearchParams(query),
  chrome: CHROME,
  body: null,
  principal,
  requestId: null,
})

const detailRequest = (
  reviewId: string,
  options: {
    readonly query?: string
    readonly principal?: ReturnType<typeof AS> | null
    readonly body?: URLSearchParams | null
  } = {},
) => ({
  reviewId,
  searchParams: new URLSearchParams(options.query ?? ''),
  chrome: CHROME,
  body: options.body ?? null,
  principal: options.principal === undefined ? AS('owner') : options.principal,
  requestId: null,
})

const approveBody = (reply: string, language = 'en') =>
  new URLSearchParams({
    [REVIEWS_APPROVE_FIELDS.reply]: reply,
    [REVIEWS_APPROVE_FIELDS.language]: language,
  })

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  await clean()
})

afterAll(async () => {
  await clean()
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await clean()
  connectionId = await seedConnection(SUB, PLACE)
  otherConnectionId = await seedConnection(OTHER_SUB, OTHER_PLACE)
})

describe('acceptance — every queue route is behind the session door and the F07 matrix', () => {
  it('refuses an unauthenticated caller and a role the matrix does not trust, in every verb', async () => {
    const id = await reviewAwaitingApproval()
    const cases = [
      ['queue', () => handleReviewsQueueRead(queueRequest('', AS('receptionist')), deps())],
      [
        'detail',
        () => handleReviewDetailRead(detailRequest(id, { principal: AS('receptionist') }), deps()),
      ],
      [
        'approve',
        () =>
          handleReviewApprove(
            detailRequest(id, { principal: AS('receptionist'), body: approveBody(CLEAN) }),
            deps(),
          ),
      ],
      [
        'mark-posted',
        () => handleReviewMarkPosted(detailRequest(id, { principal: AS('receptionist') }), deps()),
      ],
    ] as const
    for (const [name, run] of cases) {
      const response = await run()
      expect(response.status, `${name} as receptionist`).toBe(403)
      const html = await response.text()
      expect(html, `refusal-reveals-nothing ${name}`).toContain('data-refusal="forbidden"')
      // The refusal page reveals nothing: not the reviewer, not the review text, not the listing. The
      // paste form next door got this wrong first and its 401 carried all three.
      expect(html, `refusal-reveals-nothing ${name}: the reviewer`).not.toContain(REVIEWER)
      expect(html, `refusal-reveals-nothing ${name}: the review text`).not.toContain(
        'refund and nobody answered',
      )
      expect(html, `refusal-reveals-nothing ${name}: the listing`).not.toContain(PLACE)
    }
    // A null principal is 401 and not 403, because they are different screens.
    const anonymous = await handleReviewDetailRead(detailRequest(id, { principal: null }), deps())
    expect(anonymous.status).toBe(401)
    expect(await anonymous.text()).toContain('data-refusal="unauthenticated"')
    // The control: the owner gets the page, with all three of the things the refusals withheld. Without
    // it every assertion above would pass against a handler that refused everybody.
    const allowed = await handleReviewDetailRead(detailRequest(id), deps())
    expect(allowed.status).toBe(200)
    const page = await allowed.text()
    expect(page).toContain(REVIEWER)
    expect(page).toContain('refund and nobody answered')
    expect(page).toContain(PLACE)
  })

  it('is gated on review:reply_approve, which is not the permission that records a review', async () => {
    // Stated here as well as in `permissions.test.ts` because this is the screen the distinction is about:
    // the role that types in a one-star review must not be the role that publishes the answer to it.
    expect(REVIEWS_QUEUE_PERMISSION).toBe('review:reply_approve')
  })

  it('refuses a review that belongs to another connection, as if it did not exist', async () => {
    const mine = await reviewAwaitingApproval()
    const theirs = await reviewAwaitingApproval({
      place: OTHER_PLACE,
      connection: otherConnectionId,
    })
    // `getReview` is by id and is not scoped, so a uuid in the address bar would otherwise reach any row.
    // Both listings are managed here, so this case needs a review the LISTING SET does not contain: the
    // other connection is disconnected first, which is how `with-google.itest.ts` isolates for the same
    // reason — narrow what the code can SEE rather than delete rows a foreign key protects.
    await sql`update google_capabilities set connection_id = connection_id, health = 'permission_missing'
              where connection_id = ${otherConnectionId}`
    await sql`delete from google_capabilities where connection_id = ${otherConnectionId}`
    const refused = await handleReviewDetailRead(detailRequest(theirs), deps())
    expect(refused.status, 'a-review-belongs-to-one-listing').toBe(404)
    expect(await refused.text()).toContain('data-refusal="unknown_review"')
    // The control: the same handler, the same principal, this connection's review — 200.
    const found = await handleReviewDetailRead(detailRequest(mine), deps())
    expect(found.status).toBe(200)
    // And an id that is not a review at all is the same answer rather than a 500.
    const nonsense = await handleReviewDetailRead(
      detailRequest('00000000-0000-4000-8000-0000000000ff'),
      deps(),
    )
    expect(nonsense.status).toBe(404)
  })
})

describe('acceptance — editing re-lints, and the refusal is the server’s', () => {
  it('refuses a hand-edited draft carrying a banned claim, by rule name, and stores nothing', async () => {
    const id = await reviewAwaitingApproval()
    const before = await auditCount('google_review.reply_approved')
    const response = await handleReviewApprove(
      detailRequest(id, { body: approveBody(BANNED) }),
      deps(),
    )
    // 422 and not 400: the submission was well formed and the reply is not publishable.
    //
    // Labelled, and labelled HERE as well as on the rule assertion below, because this is the line that
    // fails FIRST when the refusal is swallowed — gate 158i's first run reported "expected 303 to be 422"
    // and never reached the labelled line, so the gate could not tell a real catch from a syntax error.
    expect(response.status, 'the-edit-is-re-linted-server-side').toBe(422)
    const html = await response.text()
    expect(html).toContain('data-refusal="reply_refused_by_the_linter"')
    // BY RULE NAME (ADR 0003). `banned_claim_term` is the rule `treatment` breaks against the profile in
    // force, which is a live row rather than a list in this file.
    expect(html, 'the-edit-is-re-linted-server-side').toContain('data-rule="banned_claim_term"')
    // What the owner typed is echoed back, so a refusal never throws away an edit.
    expect(html).toContain('Your treatment was carried out exactly as planned')
    // NOTHING was stored, and no audit row was written: a refused approval is not an approval.
    const row = await getReview(sql, id)
    expect(row?.replyApprovedText).toBeNull()
    expect(row?.replyLintVersion).toBeNull()
    expect(await auditCount('google_review.reply_approved')).toBe(before)

    // The control, and the whole point of the case: the SAME handler, the same review, a reply that
    // clears the linter — approved. Without it a handler that refused every approval would pass above.
    const approved = await handleReviewApprove(
      detailRequest(id, { body: approveBody(CLEAN) }),
      deps(),
    )
    expect(approved.status).toBe(303)
    expect(approved.headers.get('location')).toBe(`${reviewPath(id)}?done=approved`)
    const stored = await getReview(sql, id)
    expect(stored?.replyApprovedText).toBe(CLEAN)
    expect(stored?.replyLintVersion).toBe('g-rev-05-send-path-1')
    expect(await auditCount('google_review.reply_approved')).toBe(before + 1)
  })

  it('refuses an empty reply, an unoffered language and an unreadable body, each by name', async () => {
    const id = await reviewAwaitingApproval()
    const empty = await handleReviewApprove(detailRequest(id, { body: approveBody('   ') }), deps())
    expect(empty.status).toBe(400)
    expect(await empty.text()).toContain('data-refusal="reply_missing"')

    const language = await handleReviewApprove(
      detailRequest(id, { body: approveBody(CLEAN, 'fr') }),
      deps(),
    )
    expect(language.status).toBe(400)
    expect(await language.text()).toContain('data-refusal="language_not_offered"')

    const unreadable = await handleReviewApprove(
      detailRequest(id, { body: new URLSearchParams() }),
      deps(),
    )
    expect(unreadable.status).toBe(400)
    expect(await unreadable.text()).toContain('data-refusal="unreadable_request"')

    // A declaration is not a way round the language rule: claiming Arabic over English text is refused by
    // the linter rather than accepted because the form said so.
    const lying = await handleReviewApprove(
      detailRequest(id, { body: approveBody(CLEAN, 'ar') }),
      deps(),
    )
    expect(lying.status, 'the-edit-is-re-linted-server-side').toBe(422)
    expect(await lying.text()).toContain('data-rule="language_mismatch"')
    // Nothing above stored anything.
    expect((await getReview(sql, id))?.replyApprovedText).toBeNull()
  })
})

describe('acceptance — Marked as posted is a named person’s claim', () => {
  it('writes delivery_mode=manual, posted_manually_at and an audit row naming the approver', async () => {
    const id = await reviewAwaitingApproval()
    await handleReviewApprove(detailRequest(id, { body: approveBody(CLEAN) }), deps())
    const before = await auditCount('google_review.reply_posted_manually')

    const response = await handleReviewMarkPosted(detailRequest(id), deps())
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe(`${reviewPath(id)}?done=posted`)

    const row = await getReview(sql, id)
    expect(row?.deliveryMode).toBe('manual')
    expect(row?.postedManuallyAtIso).not.toBeNull()
    expect(row?.submittedAtIso).toBeNull()
    // The bytes recorded are the bytes that were approved, which is what *Copy reply* copies.
    expect(row?.replyApprovedText).toBe(CLEAN)

    expect(await auditCount('google_review.reply_posted_manually')).toBe(before + 1)
    const audit = await auditRow('google_review.reply_posted_manually', id)
    // The CLAIM: a named human. `actor_id` is the employee uuid the session resolved, and migration
    // 0128's ZY341 is what refuses the write without it — see the next case.
    expect(audit?.actor_kind).toBe('staff')
    expect(audit?.actor_id).toBe(PRINCIPAL_IDS['owner'])
    expect(audit?.actor_label).toContain('owner')
    expect(audit?.actor_label).toContain('employee')
  })

  it('refuses a claim about a review nothing has approved, and a second claim', async () => {
    const id = await reviewAwaitingApproval()
    const nothing = await handleReviewMarkPosted(detailRequest(id), deps())
    expect(nothing.status).toBe(409)
    expect(await nothing.text()).toContain('data-refusal="nothing_approved_to_post"')
    expect((await getReview(sql, id))?.postedManuallyAtIso).toBeNull()

    await handleReviewApprove(detailRequest(id, { body: approveBody(CLEAN) }), deps())
    const first = await handleReviewMarkPosted(detailRequest(id), deps())
    expect(first.status).toBe(303)
    const claimedAt = (await getReview(sql, id))?.postedManuallyAtIso ?? null
    expect(claimedAt).not.toBeNull()

    const second = await handleReviewMarkPosted(detailRequest(id), deps())
    expect(second.status).toBe(409)
    expect(await second.text()).toContain('data-refusal="already_posted"')
    // The instant did not move. A second claim is not a second posting.
    expect((await getReview(sql, id))?.postedManuallyAtIso).toBe(claimedAt)
  })

  it('re-lints on the way out, so a reply that has stopped being publishable is not posted', async () => {
    /*
      The row sits editable between approval and the claim, by design (0128 freezes the stamp only once a
      delivery timestamp exists) — and the regulatory profile and the staff roster are live rows, which
      `SEND_PATH_LINT_VERSION` records that it does not pin. So the bytes are judged AGAIN at the moment
      of delivery. Here the edit is made directly, which is also the state a hand-written UPDATE produces.
    */
    const id = await reviewAwaitingApproval()
    await handleReviewApprove(detailRequest(id, { body: approveBody(CLEAN) }), deps())
    await sql`update google_reviews set reply_approved_text = ${BANNED} where id = ${id}::uuid`

    const response = await handleReviewMarkPosted(detailRequest(id), deps())
    expect(response.status).toBe(422)
    const html = await response.text()
    expect(html).toContain('data-refusal="reply_refused_by_the_linter"')
    expect(html).toContain('data-rule="banned_claim_term"')
    expect((await getReview(sql, id))?.postedManuallyAtIso).toBeNull()
  })
})

describe('acceptance — the approved text hash is immutable after delivery', () => {
  it('refuses a hand-written UPDATE of the digest, by name, and permits one before delivery', async () => {
    const id = await reviewAwaitingApproval()
    await handleReviewApprove(detailRequest(id, { body: approveBody(CLEAN) }), deps())

    // BEFORE delivery the stamp is rewritable on purpose: an owner may read their own approved text again
    // and change their mind. This is the control, and without it the refusal below would be unremarkable.
    const second = 'Thank you for the feedback. We hope to see you again soon.'
    const reapproved = await handleReviewApprove(
      detailRequest(id, { body: approveBody(second) }),
      deps(),
    )
    expect(reapproved.status).toBe(303)
    expect((await getReview(sql, id))?.replyApprovedText).toBe(second)

    await handleReviewMarkPosted(detailRequest(id), deps())
    const delivered = await getReview(sql, id)
    const digest = delivered?.replyLintContentSha256 ?? ''
    expect(digest).toMatch(/^[0-9a-f]{64}$/)

    // The rejected UPDATE the acceptance line asks for. Written by hand, as the person going round the
    // screen would write it, and refused by migration 0128's trigger BY NAME.
    await expect(
      sql`update google_reviews set reply_lint_content_sha256 = ${'a'.repeat(64)}
          where id = ${id}::uuid`,
    ).rejects.toThrow(/DeliveredReplyIsFrozen/)
    // The posting instant is frozen too, because it is half of the claim: an instant that can be moved
    // is a claim with no time in it.
    await expect(
      sql`update google_reviews set posted_manually_at = now() + interval '1 day'
          where id = ${id}::uuid`,
    ).rejects.toThrow(/DeliveredReplyIsFrozen/)
    // Nothing moved.
    const after = await getReview(sql, id)
    expect(after?.replyLintContentSha256).toBe(digest)
    expect(after?.postedManuallyAtIso).toBe(delivered?.postedManuallyAtIso)

    // The other control, and the sharper half of 0128's design: `reply_approved_text` is deliberately
    // NOT frozen. Freezing the digest is what makes a change to the text DETECTABLE — freeze both and an
    // edited row is indistinguishable from an untouched one; freeze neither and whoever edits the text
    // recomputes the hash and nothing notices. So the tampering succeeds and `reproduceReplyLint` is
    // what catches it, which is the mechanism G-REV-05 built `content_changed` for.
    await sql`update google_reviews set reply_approved_text = ${BANNED} where id = ${id}::uuid`
    const reproduction = await reproduceReplyLint(sql, id)
    expect(reproduction.kind).toBe('content_changed')
    expect(reproduction.kind === 'content_changed' ? reproduction.expectedSha256 : '').toBe(digest)
  })
})

describe('acceptance — the queue lists this listing’s reviews and explains each verdict', () => {
  it('shows the stage, the rule in plain English and what the review mentions', async () => {
    const id = await reviewAwaitingApproval()
    const response = await handleReviewsQueueRead(queueRequest(), deps())
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toContain('no-store')
    const html = await response.text()
    expect(html).toContain(`data-review="${id}"`)
    expect(html).toContain('drafted, waiting for a human to approve it')
    // The rule, from the docs/07 §4 table, and the category, from the lexicon the verdict names.
    expect(html).toContain('data-rule="rating_escalates"')
    expect(html).toContain('mentions a refund')
    // Scoped to ONE listing. The other connection's review is not on this page.
    const theirs = await reviewAwaitingApproval({
      place: OTHER_PLACE,
      connection: otherConnectionId,
    })
    const again = await handleReviewsQueueRead(queueRequest(), deps())
    const listed = await again.text()
    expect(listed).toContain(`data-review="${id}"`)
    expect(listed).not.toContain(`data-review="${theirs}"`)
    // And the other listing, asked for by its own pair, shows the other review and not this one.
    const other = await handleReviewsQueueRead(
      queueRequest(`connection=${otherConnectionId}&place=${OTHER_PLACE}`),
      deps(),
    )
    const otherHtml = await other.text()
    expect(otherHtml).toContain(`data-review="${theirs}"`)
    expect(otherHtml).not.toContain(`data-review="${id}"`)
  })

  it('moves a review through the stages the screen names, and off the waiting list', async () => {
    const id = await reviewAwaitingApproval()
    const stageOnPage = async (query = 'show=all'): Promise<string> => {
      const html = await (await handleReviewsQueueRead(queueRequest(query), deps())).text()
      const found = new RegExp(
        `data-review="${id}"[\\s\\S]*?<span class="stage">([^<]*)</span>`,
      ).exec(html)
      return found?.[1] ?? ''
    }
    expect(await stageOnPage()).toBe('drafted, waiting for a human to approve it')
    await handleReviewApprove(detailRequest(id, { body: approveBody(CLEAN) }), deps())
    expect(await stageOnPage()).toBe('approved — not yet claimed as posted')
    await handleReviewMarkPosted(detailRequest(id), deps())
    // The end of fallback mode, worded as what it is: somebody SAID they posted it.
    expect(await stageOnPage()).toBe('a named person says they posted it')
    // And it has LEFT the worklist, which is what makes *Marked as posted* worth clicking: the default
    // queue holds the reviews that still need somebody. The link back says what it is hiding.
    const worklist = await (await handleReviewsQueueRead(queueRequest(), deps())).text()
    expect(worklist).not.toContain(`data-review="${id}"`)
    expect(worklist).toContain('1 review is finished with and not shown')
    expect(worklist).toContain('Show all 1')
    // The control: before the claim it WAS on the worklist, which the three assertions above would pass
    // without if the queue simply showed nothing.
    const second = await reviewAwaitingApproval()
    const again = await (await handleReviewsQueueRead(queueRequest(), deps())).text()
    expect(again).toContain(`data-review="${second}"`)
  })

  it('renders mirrored when asked, with the same language', async () => {
    await reviewAwaitingApproval()
    const rtl = await (await handleReviewsQueueRead(queueRequest('dir=rtl'), deps())).text()
    expect(rtl).toContain('<html lang="en" dir="rtl">')
    const ltr = await (await handleReviewsQueueRead(queueRequest(), deps())).text()
    expect(ltr).toContain('<html lang="en" dir="ltr">')
  })
})

describe('acceptance — Copy reply has nothing to copy until a human has approved one', () => {
  it('renders the copy control only once reply_approved_text exists, with those bytes', async () => {
    const id = await reviewAwaitingApproval()
    const before = await (await handleReviewDetailRead(detailRequest(id), deps())).text()
    expect(before.split('<script>')[0] ?? '').not.toContain('data-testid="reply-copy"')
    expect(before).toContain('Nothing has been approved yet')
    // The draft is on the page, so the absence above is about the copy control.
    expect(before).toContain(DRAFT)

    await handleReviewApprove(detailRequest(id, { body: approveBody(CLEAN) }), deps())
    const after = await (await handleReviewDetailRead(detailRequest(id), deps())).text()
    const body = after.split('<script>')[0] ?? ''
    expect(body).toContain('data-testid="reply-copy"')
    expect(body).toContain('data-testid="reply-approved"')
    // The bytes on the page are the bytes in the column, which is what makes the clipboard claim in the
    // browser suite a claim about the DATABASE rather than about a textarea.
    expect((await getReview(sql, id))?.replyApprovedText).toBe(CLEAN)
    expect(body).toContain(CLEAN)
    // And the deep link is there, built from the stored place id.
    expect(body).toContain('data-testid="reply-deep-link"')
    expect(body).toContain(PLACE)
  })
})
