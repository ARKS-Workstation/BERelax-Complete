import {
  ANONYMOUS_REVIEWER,
  FIXTURE_REPLY_SIGNATURE,
  FIXTURE_ROSTER_DISPLAY_NAME,
  HOUSE_REPLY_RENDERINGS,
  KNOWN_BAD_REPLIES,
  paddedEnglishReply,
  REPLY_LENGTH_CAP,
  REPLY_SIGNATURE_SEPARATOR,
  SEND_PATH_LINT_RULES,
  SEND_PATH_LINT_VERSION,
  sendPathReplyLinter,
} from '@berelax/core'
import {
  createConnection,
  getReview,
  type QueuedReview,
  recordManualReview,
  recordReplyPostedManually,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  deliverApprovedReply,
  type ReplyDeliveryDeps,
  type ReplySubmitter,
  readReplyLintContext,
  replyContentSha256,
  replyDeliveryRefusalRulesOf,
  reproduceReplyLint,
} from './deliver.ts'

/**
 * G-REV-05 — the linter BLOCKING on the send path, against a real database.
 *
 * The unit tests prove the rules. This file proves the three things only a database can:
 *
 *   1. **A send attempt is REFUSED, in both delivery modes.** Not "the linter returns a finding" — a call to
 *      `deliverApprovedReply` that throws, leaves no delivery timestamp, and reaches no transport. docs/10 §6
 *      says the same linter runs in both modes, so every refusal case below runs twice and asserts the same
 *      rule name both times.
 *   2. **A caller cannot route around it.** The repository writers demand a stamp, and the database refuses a
 *      delivery timestamp on a row with no stamp — asserted by issuing the raw UPDATE, which is the only way
 *      to find out whether the floor is really there.
 *   3. **The rules are the profile's and the roster's, not this package's.** Every fixture is re-run against
 *      `regulatory_profile_current` read out of the database, and the roster rule is proved by INSERTING a
 *      display name and watching the same reply change from accepted to refused with no code change.
 *
 * ## Why it is in `packages/google`
 *
 * The same argument `review-draft.itest.ts` makes. It exercises a triple: `@berelax/core`'s linter,
 * `@berelax/db`'s delivery writers and 0113's constraints, and the send path that composes them. It is also
 * the only place the cap-equality check CAN live: ADR 0001 forbids `packages/db` from importing
 * `packages/core`, so a suite beside the other `google_reviews` constraint probes could not name
 * `REPLY_LENGTH_CAP`.
 *
 * ## Isolation
 *
 * Nothing here asserts a total on a shared table, and every delete is scoped. The rows this file creates are
 * the reviews of the one connection it makes and one `employee` row carrying its own staff reference, and all
 * three go in `afterAll` — reviews first, because `google_reviews.connection_id` is ON DELETE RESTRICT. The
 * employee row matters more than it looks: `packages/hr/src/employee.itest.ts` counts the therapists the seed
 * creates, so a row left behind would fail a file that has nothing to do with this one.
 *
 * ## No invented name
 *
 * The rostered label and the reviewer label are the record labels from
 * `packages/core/src/reviews/reply-linter.fixtures/`, imported rather than re-spelled: the display name this
 * file INSERTS has to be the one the fixture reply contains, or the roster case passes against a name the
 * roster does not hold.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const OWNER = { kind: 'staff', id: '55555555-5555-5555-5555-555555555555', label: 'Owner' } as const
const PLACE = 'ChIJ_berelax_deliver_place'
const SUB = 'sub-grev05-deliver'
const CT = Buffer.from('ciphertext-stand-in')
/** This file's own employee row, by a reference nothing else uses. */
const STAFF_REFERENCE = 'grev05-roster-fixture'
const CLEAN = 'Thank you for the feedback. We look forward to welcoming you back.'

let sql: Sql
let connectionId = ''

/** Every call the API-mode submitter received. Zero is the assertion that matters on a refusal. */
interface SubmitterSpy extends ReplySubmitter {
  readonly calls: { review: QueuedReview; reply: string }[]
}

function spy(): SubmitterSpy {
  const calls: { review: QueuedReview; reply: string }[] = []
  return {
    calls,
    async submit(input) {
      calls.push({ review: input.review, reply: input.reply })
    },
  }
}

/**
 * The deps for one delivery.
 *
 * There is deliberately no `linter` field to override — `deliverApprovedReply` builds its own from the
 * database, which is what makes it a chokepoint rather than a default. If this object ever grows one, the
 * bypass is back and this comment is the place it will be noticed.
 */
function deps(overrides: Partial<ReplyDeliveryDeps> = {}): ReplyDeliveryDeps {
  return { sql, actor: OWNER, signature: null, submitter: null, ...overrides }
}

async function seedConnection(): Promise<string> {
  const [connection] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
    values (${SUB}, ${'owner@berelax.ae'},
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

/** A pasted review awaiting a reply, which is the state the approval queue delivers from. */
async function review(args: {
  readonly rating?: number
  readonly comment?: string | null
  readonly reviewerDisplayName?: string
}): Promise<string> {
  const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
    recordManualReview(uow, {
      connectionId,
      placeId: PLACE,
      source: 'paste',
      rating: args.rating ?? 5,
      comment: args.comment ?? null,
      reviewerDisplayName: args.reviewerDisplayName ?? ANONYMOUS_REVIEWER,
      reviewedAtIso: '2026-09-20T09:00:00.000Z',
    }),
  )
  return id
}

/** The delivery state of a row, as the four facts that say whether anything went out. */
async function deliveryOf(id: string) {
  const row = await getReview(sql, id)
  return {
    submittedAtIso: row?.submittedAtIso ?? null,
    postedManuallyAtIso: row?.postedManuallyAtIso ?? null,
    lintVersion: row?.replyLintVersion ?? null,
    approvedText: row?.replyApprovedText ?? null,
  }
}

/**
 * Asserts the send path refused this delivery, by the name of the rule it breaks.
 *
 * `rule` is threaded into BOTH failure messages on purpose. ADR 0003 asks a gate's known-bad fixture to fail
 * by the name of the rule, and the fixtures for these cases are gate-block edits to the send path — so the
 * rule name has to appear in the output whether the reply was refused by the wrong rule or not refused at
 * all. Gate 141o is the case that found this: it broke the reviewer-name read, the suite failed correctly,
 * and the output named no rule at all, so the gate could not tell a real catch from a syntax error.
 */
async function refusedBy(
  rule: string,
  input: Parameters<typeof deliverApprovedReply>[1],
  overrides: Partial<ReplyDeliveryDeps> = {},
): Promise<void> {
  try {
    await deliverApprovedReply(deps(overrides), input)
  } catch (error) {
    const rules = replyDeliveryRefusalRulesOf(error)
    if (rules === null) throw error
    expect(rules, `expected the send path to refuse this reply by ${rule}`).toEqual([rule])
    return
  }
  throw new Error(
    `the send path delivered a reply it should have refused by ${rule}: ${input.approvedReply}`,
  )
}

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
})

afterAll(async () => {
  // Reviews before connections: the foreign key is ON DELETE RESTRICT, so a leftover review would make a
  // later file's connection delete fail on a constraint that has nothing to do with it.
  await sql`delete from google_reviews where connection_id = ${connectionId}`
  await sql`delete from google_connections where google_sub = ${SUB}`
  await sql`delete from employee where staff_reference = ${STAFF_REFERENCE}`
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  if (connectionId !== '') {
    await sql`delete from google_reviews where connection_id = ${connectionId}`
  }
  await sql`delete from employee where staff_reference = ${STAFF_REFERENCE}`
  if (connectionId === '') connectionId = await seedConnection()
})

describe('acceptance — the gate cannot be bypassed', () => {
  /**
   * The criterion, and the shape it has to be asserted in: a call to the delivery function, refused by the
   * delivery function, with no UI anywhere near it.
   *
   * Both modes, because docs/10 §6's claim is that the linter runs in both and fallback mode is the one every
   * reply takes on launch day. A linter wired into the API path alone would be a linter that had never run.
   */
  it('refuses an unlinted draft in BOTH delivery modes, by the name of the rule it breaks', async () => {
    const id = await review({})
    const draft = 'Thank you for the feedback. We have arranged a refund for the visit.'

    await refusedBy('promises_discount_or_refund', {
      reviewId: id,
      approvedReply: draft,
      language: 'en',
      mode: 'manual',
    })
    const submitter = spy()
    await refusedBy(
      'promises_discount_or_refund',
      { reviewId: id, approvedReply: draft, language: 'en', mode: 'api' },
      { submitter },
    )

    // Nothing left the process and nothing was recorded. The transport spy is the half that a reading of
    // the source cannot give you: "the network call is after the check" is a claim a refactor reverses.
    expect(submitter.calls).toEqual([])
    expect(await deliveryOf(id)).toEqual({
      submittedAtIso: null,
      postedManuallyAtIso: null,
      lintVersion: null,
      approvedText: null,
    })

    // The control: the same review, a clean reply, and it goes out. Without this the case is satisfied by a
    // send path that refuses everything.
    const delivered = await deliverApprovedReply(deps(), {
      reviewId: id,
      approvedReply: CLEAN,
      language: 'en',
      mode: 'manual',
    })
    expect(delivered.reply).toBe(CLEAN)
    expect((await deliveryOf(id)).postedManuallyAtIso).not.toBeNull()
  })

  /**
   * The floor under the signature: the raw UPDATE a caller who skipped this module would have to write.
   *
   * This is the claim "a caller cannot route around it" as something other than a TypeScript signature.
   * `recordReplyPostedManually` demands a stamp and cannot produce one — `packages/db` may not import
   * `packages/core`, so it holds nothing that can lint — and 0113 refuses the timestamp underneath.
   */
  it('refuses a delivery timestamp written by hand on a row with no lint stamp', async () => {
    const id = await review({})
    await expect(
      sql`update google_reviews set delivery_mode = 'manual', posted_manually_at = now() where id = ${id}`,
    ).rejects.toThrow(/google_reviews_delivery_needs_a_lint_pass/)
    await expect(
      sql`update google_reviews set delivery_mode = 'api', submitted_at = now() where id = ${id}`,
    ).rejects.toThrow(/google_reviews_delivery_needs_a_lint_pass/)

    // And a stamp cannot be half written, so the way round the constraint above is closed too.
    await expect(
      sql`update google_reviews set reply_lint_version = ${SEND_PATH_LINT_VERSION} where id = ${id}`,
    ).rejects.toThrow(/google_reviews_reply_lint_stamp_is_whole/)
  })

  /** A malformed stamp is named by the field rather than by the constraint, before the statement runs. */
  it('names the missing part of a stamp rather than reporting a SQLSTATE', async () => {
    const id = await review({})
    await expect(
      withUnitOfWork(sql, OWNER, (uow) =>
        recordReplyPostedManually(uow, id, {
          approvedText: CLEAN,
          lintVersion: SEND_PATH_LINT_VERSION,
          contentSha256: 'NOT-A-DIGEST',
        }),
      ),
    ).rejects.toThrow(/contentSha256/)
    expect(await deliveryOf(id)).toMatchObject({ postedManuallyAtIso: null, lintVersion: null })
  })
})

describe('acceptance — the rules are the profile’s and the roster’s', () => {
  /**
   * Every fixture, re-run against `regulatory_profile_current`.
   *
   * This is the check that holds the unit tests' stand-in policy and the real row together. The stand-in
   * carries one banned term, so a profile that stopped banning `therapeutic` — or a profile row somebody
   * narrowed — would leave the unit test green and this case red, which is the right way round.
   */
  it('refuses every known-bad fixture under the profile in force, by rule name', async () => {
    const linter = sendPathReplyLinter({
      ...(await readReplyLintContext(sql)),
      rosterDisplayNames: [FIXTURE_ROSTER_DISPLAY_NAME],
    })
    const missed: string[] = []
    for (const fixture of KNOWN_BAD_REPLIES) {
      const rules = linter
        .lint({
          draft: fixture.draft,
          language: fixture.language,
          reviewText: fixture.reviewText,
          reviewerDisplayName: fixture.reviewerDisplayName,
          signature: fixture.signature,
          origin: fixture.origin,
        })
        .map((finding) => finding.rule)
      if (!rules.includes(fixture.rule)) missed.push(`${fixture.rule}: got [${rules.join(', ')}]`)
    }
    expect(missed).toEqual([])
    expect(KNOWN_BAD_REPLIES.length).toBe(SEND_PATH_LINT_RULES.length)
  })

  /**
   * Every rendering the generator can produce, against the profile in force — and the case that found the
   * live defect this unit fixed.
   *
   * 32 of the 296 renderings were REFUSED when this ran for the first time: the English `treatment` aspect
   * said "the treatment itself" and `treatment` is on `regulatory_profile.banned_claim_terms` (0004). The
   * Arabic for the same aspect had never used the word. So the generator's own vocabulary contained a
   * compliance claim, an owner would have approved it, and nothing in the build had ever compared a house
   * rendering against the claim list — the unit test cannot, because its stand-in policy is one term long.
   */
  it('passes every house rendering under the profile in force, in both languages', async () => {
    const linter = sendPathReplyLinter(await readReplyLintContext(sql))
    const refused: string[] = []
    let walked = 0
    for (const language of ['en', 'ar'] as const) {
      for (const rendering of HOUSE_REPLY_RENDERINGS[language]) {
        walked += 1
        const rules = linter
          .lint({ draft: rendering, language, reviewText: null, origin: 'machine_draft' })
          .map((finding) => finding.rule)
        if (rules.length > 0) refused.push(`${language}: ${rendering} → ${rules.join(', ')}`)
      }
    }
    expect(refused).toEqual([])
    // The vacuity floor. A closed set that had become empty would satisfy the walk above silently.
    expect(walked).toBeGreaterThan(200)
  })

  /**
   * The roster criterion: add a therapist, and the same draft is refused. No code change, no lexicon edit.
   *
   * The reply names the label in LOWER CASE, which `textNamesAnIndividual` cannot see, so the roster read is
   * the only thing that can refuse it — and the first half of the case is what proves that: with the display
   * name unset the identical reply is delivered.
   */
  it('refuses a reply naming a therapist the moment the roster holds the name', async () => {
    const reply = `Thank you for the feedback. We are glad ${FIXTURE_ROSTER_DISPLAY_NAME.toLowerCase()} was able to help.`
    const before = await review({})
    const delivered = await deliverApprovedReply(deps(), {
      reviewId: before,
      approvedReply: reply,
      language: 'en',
      mode: 'manual',
    })
    expect(delivered.reply).toBe(reply)

    // An admin sets a display name on a staff record. This is the whole change.
    await sql`
      insert into employee (staff_reference, employed_from, display_name)
      values (${STAFF_REFERENCE}, '2026-01-01'::date, ${FIXTURE_ROSTER_DISPLAY_NAME})
    `

    const after = await review({})
    await refusedBy('names_a_rostered_therapist', {
      reviewId: after,
      approvedReply: reply,
      language: 'en',
      mode: 'manual',
    })
    expect(await deliveryOf(after)).toMatchObject({ postedManuallyAtIso: null, lintVersion: null })
  })

  /**
   * The health-disclosure echo, driven through the send path against two real review rows.
   *
   * The same reply, one review that discloses a pregnancy and one that does not. The reply is refused
   * against the first and delivered against the second, which is what makes the rule a statement about the
   * review rather than a list of health words.
   */
  it('refuses a reply that quotes a health disclosure, and delivers it when the review made none', async () => {
    const reply =
      'Thank you for the feedback. We are glad the visit was comfortable while you were pregnant.'
    const discloses = await review({
      rating: 5,
      comment: 'I told the front desk I was pregnant and they were very careful with me.',
    })
    const silent = await review({
      rating: 5,
      comment: 'The front desk was helpful and they were careful with me.',
    })

    await refusedBy('echoes_health_disclosure', {
      reviewId: discloses,
      approvedReply: reply,
      language: 'en',
      mode: 'manual',
    })
    const delivered = await deliverApprovedReply(deps(), {
      reviewId: silent,
      approvedReply: reply,
      language: 'en',
      mode: 'manual',
    })
    expect(delivered.reply).toBe(reply)
  })

  /** The reviewer's own display name comes off the ROW, so the rule needs no argument to be right. */
  it('refuses a reply that confirms the named reviewer was a client', async () => {
    const id = await review({ reviewerDisplayName: 'Fixture Reviewer B' })
    await refusedBy('confirms_the_reviewer_was_a_client', {
      reviewId: id,
      approvedReply:
        'Thank you for the feedback. We are glad fixture reviewer b enjoyed the visit.',
      language: 'en',
      mode: 'manual',
    })
  })
})

describe('acceptance — the cap is measured on what is published', () => {
  /**
   * 1,200 delivers and 1,201 is refused, with the signature appended by the send path in both cases.
   *
   * The control is the stored text: the delivered reply ENDS with the signature, so the cap was measured
   * over bytes that really went out rather than over the draft the caller passed.
   */
  it('delivers at 1,200 including the signature and refuses at 1,201', async () => {
    const room =
      REPLY_LENGTH_CAP - FIXTURE_REPLY_SIGNATURE.length - REPLY_SIGNATURE_SEPARATOR.length
    const signed = { signature: FIXTURE_REPLY_SIGNATURE }

    const inside = await review({})
    const delivered = await deliverApprovedReply(deps(signed), {
      reviewId: inside,
      approvedReply: paddedEnglishReply(room),
      language: 'en',
      mode: 'manual',
    })
    expect([...delivered.reply].length).toBe(REPLY_LENGTH_CAP)
    expect(delivered.reply.endsWith(FIXTURE_REPLY_SIGNATURE)).toBe(true)
    expect((await deliveryOf(inside)).approvedText).toBe(delivered.reply)

    const over = await review({})
    await refusedBy(
      'exceeds_length_cap',
      {
        reviewId: over,
        approvedReply: paddedEnglishReply(room + 1),
        language: 'en',
        mode: 'manual',
      },
      signed,
    )
    // The draft alone is inside the cap, so only the rendering can have tipped it over.
    expect([...paddedEnglishReply(room + 1)].length).toBeLessThanOrEqual(REPLY_LENGTH_CAP)
  })

  /**
   * The cap in the schema, and the check that holds the two numbers equal.
   *
   * 0113 carries 1,200 as a CHECK and `REPLY_LENGTH_CAP` carries it in TypeScript. A second statement of a
   * figure drifts, and the direction it drifts in here is the dangerous one: a database still accepting what
   * the linter has started refusing. This reads the constraint's own definition and compares the number.
   */
  it('carries the same cap in the database as the linter does in code', async () => {
    const [check] = await sql<{ def: string }[]>`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'google_reviews'::regclass
        and conname = 'google_reviews_reply_approved_text_within_cap'
    `
    const def = check?.def ?? ''
    expect(def, 'the cap constraint is not on the applied schema').toContain('length')
    const numbers = [...def.matchAll(/\b(\d{2,})\b/g)].map((match) => Number(match[1]))
    expect(numbers).toEqual([REPLY_LENGTH_CAP])
  })

  /** And the floor: a reply over the cap cannot be stored at all, however it is written. */
  it('refuses an over-cap approved text written by hand', async () => {
    const id = await review({})
    const long = paddedEnglishReply(REPLY_LENGTH_CAP + 1)
    await expect(
      sql`
        update google_reviews set reply_approved_text = ${long},
          reply_lint_version = ${SEND_PATH_LINT_VERSION},
          reply_lint_content_sha256 = ${replyContentSha256(long)},
          reply_lint_passed_at = now()
        where id = ${id}
      `,
    ).rejects.toThrow(/google_reviews_reply_approved_text_within_cap/)
  })
})

describe('acceptance — the approved reply records the lint version and the content hash', () => {
  it('stamps both, in the same statement as the delivery timestamp', async () => {
    const id = await review({})
    const delivered = await deliverApprovedReply(deps(), {
      reviewId: id,
      approvedReply: CLEAN,
      language: 'en',
      mode: 'manual',
    })
    const row = await getReview(sql, id)
    expect(row?.replyApprovedText).toBe(CLEAN)
    expect(row?.replyLintVersion).toBe(SEND_PATH_LINT_VERSION)
    expect(row?.replyLintContentSha256).toBe(replyContentSha256(CLEAN))
    expect(row?.replyLintPassedAtIso).not.toBeNull()
    expect(row?.postedManuallyAtIso).not.toBeNull()
    expect(row?.deliveryMode).toBe('manual')
    expect(delivered.contentSha256).toBe(row?.replyLintContentSha256)
  })

  /**
   * The reproduction criterion: the decision re-taken from the stored version alone.
   *
   * `reproduceReplyLint` never reads `SEND_PATH_LINT_VERSION`. It reads the row's own version, resolves it
   * to a rule set and re-runs. The two controls are what make that a claim: a version this build has never
   * had answers `unknown_lint_version` rather than falling back to today's rules, and text that no longer
   * hashes to its digest answers `content_changed` rather than being re-judged as if nothing had happened.
   */
  it('reproduces the decision from the stored version, and refuses to guess when it cannot', async () => {
    const id = await review({
      rating: 5,
      comment: 'The rooms were spotless and the staff were kind.',
    })
    await deliverApprovedReply(deps(), {
      reviewId: id,
      approvedReply: CLEAN,
      language: 'en',
      mode: 'manual',
    })
    expect(await reproduceReplyLint(sql, id)).toEqual({
      kind: 'reproduced',
      lintVersion: SEND_PATH_LINT_VERSION,
      rules: [],
    })

    // A row nothing has delivered has no decision to reproduce, which is a different answer from "it passed".
    const undelivered = await review({})
    expect(await reproduceReplyLint(sql, undelivered)).toEqual({ kind: 'not_delivered' })

    // The text changed under the digest.
    const tampered = `${CLEAN} We have arranged a refund.`
    await sql`update google_reviews set reply_approved_text = ${tampered} where id = ${id}`
    const changed = await reproduceReplyLint(sql, id)
    expect(changed.kind).toBe('content_changed')

    /*
      A version this build has never had, on a row carrying a WHOLE stamp and no delivery timestamp — the
      "approved, not yet posted" state G-REV-06's approval queue introduced, and the one `reproduceReplyLint`
      reaches `unknown_lint_version` from. It used to be asserted by rewriting the version on the delivered
      row above, and migration 0128's ZY342 now refuses that: the version is the record of WHICH rules
      judged a published reply, so it is frozen once the reply is out, exactly as the digest is.

      Nothing is lost, because the rewrite was never the subject. The real case is a row delivered by an
      older build whose rule set this one no longer has, and the state that reproduces it is a complete
      stamp naming a version `SEND_PATH_LINTERS` does not hold. The digest matches `CLEAN`, so the only
      thing wrong is the version — otherwise this case could pass for the `content_changed` reason above.
    */
    await sql`
      update google_reviews set reply_approved_text = ${CLEAN},
        reply_lint_content_sha256 = ${replyContentSha256(CLEAN)},
        reply_lint_version = 'g-rev-05-send-path-0',
        reply_lint_passed_at = now()
      where id = ${undelivered}
    `
    expect(await reproduceReplyLint(sql, undelivered)).toEqual({
      kind: 'unknown_lint_version',
      lintVersion: 'g-rev-05-send-path-0',
    })
  })
})

describe('api delivery reaches the submitter only after a clean lint', () => {
  it('submits the exact delivered bytes once, and records the api timestamps', async () => {
    const id = await review({})
    const submitter = spy()
    const delivered = await deliverApprovedReply(
      deps({ submitter, signature: FIXTURE_REPLY_SIGNATURE }),
      {
        reviewId: id,
        approvedReply: CLEAN,
        language: 'en',
        mode: 'api',
      },
    )
    expect(submitter.calls).toHaveLength(1)
    // Byte for byte, and including the signature: the transport must not be handed the draft.
    expect(submitter.calls[0]?.reply).toBe(delivered.reply)
    expect(delivered.reply).toBe(`${CLEAN}${REPLY_SIGNATURE_SEPARATOR}${FIXTURE_REPLY_SIGNATURE}`)
    const row = await getReview(sql, id)
    expect(row?.deliveryMode).toBe('api')
    expect(row?.submittedAtIso).not.toBeNull()
    expect(row?.postedManuallyAtIso).toBeNull()
    expect(row?.replyApprovedText).toBe(delivered.reply)
  })

  /** A missing adapter is a configuration problem and must not read as a refused reply. */
  it('refuses api mode with no submitter, and not as a lint finding', async () => {
    const id = await review({})
    let caught: unknown
    try {
      await deliverApprovedReply(deps(), {
        reviewId: id,
        approvedReply: CLEAN,
        language: 'en',
        mode: 'api',
      })
    } catch (error) {
      caught = error
    }
    expect(replyDeliveryRefusalRulesOf(caught)).toBeNull()
    expect(String(caught)).toContain('api mode with no submitter')
    expect(await deliveryOf(id)).toMatchObject({ submittedAtIso: null, lintVersion: null })
  })
})
