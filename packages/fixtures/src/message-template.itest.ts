/**
 * C-AUTO-01 — the half of the template model that only a real PostgreSQL can answer for.
 *
 * Four claims, and every one of them is about something the database REFUSES rather than something the
 * application remembers not to do:
 *
 *   - **`message_class` is immutable**, asserted by SQLSTATE and not by prose. Migration 0014 already
 *     raised on the UPDATE; it raised `restrict_violation`, which seven other triggers and every
 *     `ON DELETE RESTRICT` foreign key in this schema also raise, so a probe asserting 23001 could pass
 *     for an entirely different reason. 0061 gives it `ZM001`.
 *   - **The permitted path** — `reclassify_template` — creates a new version, resets every carried-over
 *     variant to `draft`, and writes one `message_template.reclassified` audit row naming the actor.
 *   - **The approval state machine**, in both implementations: `TEMPLATE_APPROVAL_TRANSITIONS` in
 *     `@berelax/shared` and `template_approval_transition_allowed` in SQL are compared on **all sixteen**
 *     ordered pairs, because two implementations that refuse everything agree perfectly.
 *   - **The sender identity on a message row**: present for SMS and absent otherwise, `AD-` prefixed for
 *     a promotional SMS and not for a transactional one, and the row's class equal to the class of the
 *     template version it points at (ZM004).
 *
 * ## Cleanup, and what cannot be cleaned up
 *
 * `message` and `message_delivery_receipt` cannot be removed even in principle — the receipt table
 * refuses DELETE and protects the message with `ON DELETE RESTRICT` (brief rule 12) — so every probe that
 * writes a `message` row runs inside a transaction that is ALWAYS rolled back, and no assertion here is a
 * total over any table. The template rows this file writes are namespaced with a fixed prefix and removed
 * in `beforeEach`: a fixed prefix rather than a per-run one, deliberately, so each run tidies up its
 * predecessor's instead of leaving every previous run's rows behind for ever.
 *
 * ## Why the audit assertion is a delta
 *
 * `audit_event` is append-only (ADR 0008, brief rule 9) and is counted in SQL rather than through a
 * capped reader: the `settings-store.itest.ts` defect in the brief is a delta read through a `limit`,
 * where both sides of the subtraction pinned at the cap and three recorded changes read as zero.
 */
import {
  createConnection,
  reclassifyTemplate,
  type Sql,
  setTemplateApproval,
  templateRefusalOf,
} from '@berelax/db'
import {
  isTemplateApprovalTransition,
  TEMPLATE_APPROVAL_STATES,
  type TemplateApprovalState,
} from '@berelax/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

let sql: Sql

/** This file's own template keys. Fixed prefix; see the header. */
const PREFIX = 'cauto01-itest.'
const key = (name: string) => `${PREFIX}${name}`

const RECLASSIFY_ACTION = 'message_template.reclassified'
const ROLLBACK = 'cauto01 rollback'

beforeAll(() => {
  sql = createConnection({ url, max: 3 })
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  // This file's templates only. Narrowing what the test can see is the fix; deleting rows a foreign key
  // protects is not.
  await sql`delete from message_template where template_key like ${`${PREFIX}%`}`
})

/**
 * Runs a body in a transaction that is ALWAYS rolled back, and carries its answer out.
 *
 * `sql.begin` COMMITS when its callback returns, and the probes below write `message` rows, which
 * nothing in this repository can remove afterwards.
 */
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

/** The SQLSTATE a statement raised, or null when it did not raise. */
async function sqlstateOf(run: Promise<unknown>): Promise<string | null> {
  try {
    await run
    return null
  } catch (error) {
    return typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code
      : null
  }
}

/** Counted in SQL, never through a capped reader: `audit_event` only grows. */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event where action = ${action}
  `
  return Number(row?.n ?? '0')
}

async function seedTemplate(
  templateKey: string,
  messageClass: 'transactional' | 'promotional' = 'transactional',
  approvalState: TemplateApprovalState = 'approved',
  executor: Sql = sql,
): Promise<string> {
  const [row] = await executor<{ id: string }[]>`
    insert into message_template (template_key, version, message_class, purpose, is_current)
    values (${templateKey}, 1, ${messageClass}::message_class, 'C-AUTO-01 fixture', true)
    returning id::text as id
  `
  if (row === undefined) throw new Error(`could not create template ${templateKey}`)
  await executor`
    insert into message_template_variant
      (template_id, channel, locale, approval_state, body, variables)
    values (
      ${row.id}, 'sms', 'en', ${approvalState}::template_approval,
      'Booking confirmed for {{date}}.', '{"date"}'
    )
  `
  return row.id
}

// --- message_class is immutable ------------------------------------------------------------------

describe('acceptance — an UPDATE changing message_class raises, by SQLSTATE', () => {
  it('raises ZM001, which is this rule and nothing else', async () => {
    const id = await seedTemplate(key('immutable'))
    const state = await sqlstateOf(
      sql`update message_template set message_class = 'promotional' where id = ${id}`,
    )
    // By code, not by words. `restrict_violation` is raised by seven other triggers and by every
    // ON DELETE RESTRICT foreign key here, so asserting 23001 would pass for the wrong reason; and a
    // regex over the message passes until somebody rewords the raise.
    expect(state).toBe('ZM001')
  })

  it('permits an UPDATE that leaves the class alone, so the table is not read-only', async () => {
    // The control. A trigger that refused every UPDATE would satisfy the case above.
    const id = await seedTemplate(key('immutable'))
    await sql`update message_template set purpose = 'revised' where id = ${id}`
    const [row] = await sql<{ purpose: string }[]>`
      select purpose from message_template where id = ${id}
    `
    expect(row?.purpose).toBe('revised')
  })
})

describe('acceptance — the permitted path creates a version, resets to draft and audits', () => {
  it('supersedes the old version and lands every carried-over variant in draft', async () => {
    await seedTemplate(key('reclassified'), 'transactional', 'approved')

    const before = await auditCount(RECLASSIFY_ACTION)
    const { templateId } = await reclassifyTemplate(sql, {
      templateKey: key('reclassified'),
      to: 'promotional',
      purpose: 'Reclassified by C-AUTO-01 fixture',
      actor: { kind: 'staff', label: 'Owner (fixture)' },
    })
    const delta = (await auditCount(RECLASSIFY_ACTION)) - before

    const versions = await sql<{ version: number; is_current: boolean; message_class: string }[]>`
      select version, is_current, message_class from message_template
       where template_key = ${key('reclassified')} order by version
    `
    expect(versions).toHaveLength(2)
    expect(versions[0]).toMatchObject({ version: 1, is_current: false })
    expect(versions[1]).toMatchObject({
      version: 2,
      is_current: true,
      message_class: 'promotional',
    })

    const [variant] = await sql<{ approval_state: string; body: string }[]>`
      select approval_state, body from message_template_variant where template_id = ${templateId}
    `
    // `draft` and not `pending`. The words carried over were written for a transactional message, and
    // `pending` would put them in front of a reviewer whose only question is yes or no — with the likely
    // answer, because the words look fine, being yes. That is the laundering the immutability rule
    // exists to prevent, one screen later.
    expect(variant?.approval_state).toBe('draft')
    expect(variant?.body).toBe('Booking confirmed for {{date}}.')

    // A DELTA of exactly one. `audit_event` only grows and other suites write to it.
    expect(delta).toBe(1)
  })

  it('names the actor on the audit row, rather than recording it as a psql correction', async () => {
    await seedTemplate(key('audited'), 'transactional')
    const { templateId } = await reclassifyTemplate(sql, {
      templateKey: key('audited'),
      to: 'promotional',
      purpose: 'Reclassified by C-AUTO-01 fixture',
      actor: { kind: 'staff', label: 'Owner (fixture)' },
    })
    const [row] = await sql<
      {
        actor_kind: string
        actor_label: string
        operation: string
        before_state: { message_class: string } | null
        after_state: { message_class: string } | null
      }[]
    >`
      select actor_kind, actor_label, operation, before_state, after_state
        from audit_event
       where action = ${RECLASSIFY_ACTION} and entity_id = ${templateId}
    `
    expect(row).toMatchObject({
      actor_kind: 'staff',
      actor_label: 'Owner (fixture)',
      operation: 'update',
    })
    // Both states, so "what changed" is answerable from the row without re-reading a superseded version.
    expect(row?.before_state?.message_class).toBe('transactional')
    expect(row?.after_state?.message_class).toBe('promotional')
  })

  it('refuses a reclassification to the class the template already has', async () => {
    // A no-op reclassification would still supersede the current version and reset every approval —
    // a template taken out of service by a change that changed nothing.
    await seedTemplate(key('already'), 'transactional')
    await expect(
      reclassifyTemplate(sql, {
        templateKey: key('already'),
        to: 'transactional',
        purpose: 'no-op',
        actor: { kind: 'staff', label: 'Owner (fixture)' },
      }),
    ).rejects.toThrow(/already transactional/)
  })

  it('writes no audit row when the reclassification is refused', async () => {
    // The transaction is the unit: an audit row claiming a reclassification that did not happen is
    // worse than no audit row at all.
    await seedTemplate(key('refused'), 'promotional')
    const before = await auditCount(RECLASSIFY_ACTION)
    await expect(
      reclassifyTemplate(sql, {
        templateKey: key('refused'),
        to: 'promotional',
        purpose: 'no-op',
        actor: { kind: 'staff', label: 'Owner (fixture)' },
      }),
    ).rejects.toThrow()
    expect((await auditCount(RECLASSIFY_ACTION)) - before).toBe(0)
  })
})

// --- the approval state machine --------------------------------------------------------------------

describe('the approval state machine agrees with itself in both dialects', () => {
  it('answers all sixteen ordered pairs identically in SQL and in TypeScript', async () => {
    let permitted = 0
    let refused = 0
    for (const from of TEMPLATE_APPROVAL_STATES) {
      for (const to of TEMPLATE_APPROVAL_STATES) {
        const [row] = await sql<{ allowed: boolean }[]>`
          select template_approval_transition_allowed(
            ${from}::template_approval, ${to}::template_approval
          ) as allowed
        `
        const inSql = row?.allowed === true
        expect(inSql, `${from}->${to}`).toBe(isTemplateApprovalTransition(from, to))
        if (inSql) permitted += 1
        else refused += 1
      }
    }
    // The control, and the reason the comparison is over all sixteen rather than over the seven legal
    // ones: two implementations that refuse everything agree perfectly, and so do two that permit
    // everything. Both sets have to be non-empty for the agreement to mean anything.
    expect(permitted).toBeGreaterThan(0)
    expect(refused).toBeGreaterThan(0)
    expect(permitted + refused).toBe(16)
  })

  it('raises ZM002 on a jump the machine does not have, through the trigger', async () => {
    const id = await seedTemplate(key('jump'), 'transactional', 'draft')
    // The raw UPDATE, so the SQLSTATE is asserted rather than the repository's translation of it: the
    // function being right is not the same as the trigger being wired to it, and a writer that never
    // came through the repository — a migration, a psql session — has only the trigger between it and an
    // approved draft.
    const state = await sqlstateOf(
      sql`
        update message_template_variant set approval_state = 'approved'
         where template_id = ${id} and channel = 'sms' and locale = 'en'
      `,
    )
    expect(state).toBe('ZM002')
  })

  it('turns that SQLSTATE into a named refusal a caller can branch on', async () => {
    // The other half. A screen that had to read a PostgreSQL message to tell "you cannot approve a draft
    // in one step" from "you cannot edit approved words" is a screen whose behaviour changes when
    // somebody rewords a raise.
    const id = await seedTemplate(key('jump'), 'transactional', 'draft')
    const refusal = await setTemplateApproval(sql, {
      templateId: id,
      channel: 'sms',
      locale: 'en',
      to: 'approved',
    }).then(
      () => null,
      (error: unknown) => templateRefusalOf(error),
    )
    expect(refusal).toBe('template_approval_transition_refused')
  })

  it('walks the permitted path, so the refusal above is about the edge', async () => {
    // The control: draft -> pending -> approved, each step accepted.
    const id = await seedTemplate(key('walk'), 'transactional', 'draft')
    const variant = { templateId: id, channel: 'sms', locale: 'en' } as const
    expect(await setTemplateApproval(sql, { ...variant, to: 'pending' })).toBe('pending')
    expect(await setTemplateApproval(sql, { ...variant, to: 'approved' })).toBe('approved')
  })

  it('refuses approving a rejection without re-authoring it', async () => {
    const id = await seedTemplate(key('rejected'), 'promotional', 'draft')
    const variant = { templateId: id, channel: 'sms', locale: 'en' } as const
    await setTemplateApproval(sql, { ...variant, to: 'pending' })
    await setTemplateApproval(sql, { ...variant, to: 'rejected' })
    // A rejection answered by resubmitting the identical words is the reviewer being asked the same
    // question until they say yes. Asserted through the trigger, by code.
    for (const to of ['approved', 'pending'] as const) {
      expect(
        await sqlstateOf(sql`
          update message_template_variant set approval_state = ${to}::template_approval
           where template_id = ${id} and channel = 'sms' and locale = 'en'
        `),
        `rejected->${to}`,
      ).toBe('ZM002')
    }
    // And the way out is re-authoring.
    expect(await setTemplateApproval(sql, { ...variant, to: 'draft' })).toBe('draft')
  })

  it('raises ZM003 when an approved variant is edited in place', async () => {
    const id = await seedTemplate(key('frozen'), 'promotional', 'approved')
    const state = await sqlstateOf(
      sql`
        update message_template_variant set body = 'Half price this week only. {{link}}'
         where template_id = ${id} and channel = 'sms' and locale = 'en'
      `,
    )
    // The same defect as an editable class, in a different column: the approval stays attached while the
    // words underneath it change. The permitted path is approved -> draft, edit, and back up.
    expect(state).toBe('ZM003')
  })

  it('permits the same edit once the approval has been withdrawn', async () => {
    // The control. A trigger that refused every edit would satisfy the case above.
    const id = await seedTemplate(key('frozen'), 'promotional', 'approved')
    await setTemplateApproval(sql, { templateId: id, channel: 'sms', locale: 'en', to: 'draft' })
    await sql`
      update message_template_variant set body = 'Rewritten while in draft. {{date}}'
       where template_id = ${id} and channel = 'sms' and locale = 'en'
    `
    const [row] = await sql<{ body: string }[]>`
      select body from message_template_variant where template_id = ${id}
    `
    expect(row?.body).toBe('Rewritten while in draft. {{date}}')
  })
})

// --- the sender identity as a fact about the row -----------------------------------------------------

describe('the message row cannot lie about the identity it left from', () => {
  /** One message row, in a transaction that is always rolled back. */
  const messageRow = async (
    tx: Sql,
    templateId: string,
    overrides: {
      channel?: string
      messageClass?: string
      senderId?: string | null
      vendor?: string
      subject?: string | null
      bodyHtml?: string | null
      segments?: number
      costFils?: number
    } = {},
  ) => {
    const channel = overrides.channel ?? 'sms'
    const isEmail = channel === 'email'
    return await tx`
      insert into message (
        template_id, channel, message_class, locale, vendor, recipient, sender_id,
        subject, body, body_html, encoding, segments, cost_fils, status, provider_message_id,
        attempts, queued_at, sent_at
      ) values (
        ${templateId}, ${channel}::message_channel,
        ${overrides.messageClass ?? 'transactional'}::message_class, 'en',
        ${overrides.vendor ?? (isEmail ? 'resend' : 'smsala')},
        ${isEmail ? 'guest@example.com' : '+971500000901'},
        ${overrides.senderId === undefined ? (isEmail ? null : 'BERELAX') : overrides.senderId},
        ${overrides.subject ?? (isEmail ? 'Your tax invoice' : null)},
        'Booking confirmed.',
        ${overrides.bodyHtml ?? (isEmail ? '<!doctype html><html><body><p>x</p></body></html>' : null)},
        'GSM-7', ${overrides.segments ?? (isEmail ? 0 : 1)}, ${overrides.costFils ?? (isEmail ? 0 : 9)},
        'sent'::message_status, ${`cauto01-${Math.random().toString(36).slice(2, 10)}`},
        1, now(), now()
      )
    `
  }

  it('accepts the two legitimate shapes, so the refusals below are about the fault', async () => {
    // The positive control, first. Every case after this is a refusal, and a database that refused
    // everything would satisfy all of them.
    const accepted = await probe(async (tx) => {
      const smsTemplate = await seedTemplate(key('rows-sms'), 'transactional', 'approved', tx)
      const promoTemplate = await seedTemplate(key('rows-promo'), 'promotional', 'approved', tx)
      await messageRow(tx, smsTemplate)
      await messageRow(tx, promoTemplate, { messageClass: 'promotional', senderId: 'AD-BERELAX' })
      await messageRow(tx, smsTemplate, { channel: 'email' })
      return true
    })
    expect(accepted).toBe(true)
  })

  it('refuses an SMS sender identity on an email row', async () => {
    const state = await probe(async (tx) => {
      const templateId = await seedTemplate(key('rows-sms'), 'transactional', 'approved', tx)
      // `sender_id` is a TDRA alphanumeric registration and email has none — it leaves from a verified
      // sending subdomain the transport holds. Before 0061 this row was storable, and `deliverMessage`
      // really did write `BERELAX` onto every email it sent.
      return await sqlstateOf(messageRow(tx, templateId, { channel: 'email', senderId: 'BERELAX' }))
    })
    expect(state).toBe('23514')
  })

  it('refuses an SMS row with no identity at all', async () => {
    const state = await probe(async (tx) => {
      const templateId = await seedTemplate(key('rows-sms'), 'transactional', 'approved', tx)
      return await sqlstateOf(messageRow(tx, templateId, { senderId: null }))
    })
    // The other half of the biconditional. An SMS with no recorded identity is a send nobody can trace
    // back to a registration, which is exactly what a suspension investigation asks for.
    expect(state).toBe('23514')
  })

  it('refuses a promotional SMS that did not leave from the AD- identity', async () => {
    const state = await probe(async (tx) => {
      const templateId = await seedTemplate(key('rows-promo'), 'promotional', 'approved', tx)
      return await sqlstateOf(messageRow(tx, templateId, { messageClass: 'promotional' }))
    })
    // The send that gets `BERELAX` suspended, and a suspension of the transactional identity stops every
    // booking confirmation, reminder and OTP in the business.
    expect(state).toBe('23514')
  })

  it('refuses a transactional SMS sent from the promotional identity', async () => {
    const state = await probe(async (tx) => {
      const templateId = await seedTemplate(key('rows-sms'), 'transactional', 'approved', tx)
      return await sqlstateOf(messageRow(tx, templateId, { senderId: 'AD-BERELAX' }))
    })
    // The other direction: a booking confirmation that arrives looking like an advert is what customers
    // block, and it spends a promotional registration's reputation on transactional traffic.
    expect(state).toBe('23514')
  })

  it('raises ZM004 when a message claims a class its template does not have', async () => {
    const state = await probe(async (tx) => {
      const templateId = await seedTemplate(key('rows-sms'), 'transactional', 'approved', tx)
      return await sqlstateOf(
        messageRow(tx, templateId, { messageClass: 'promotional', senderId: 'AD-BERELAX' }),
      )
    })
    // `message.message_class` is a COPY of the template's, taken at send time and never recomputed. A
    // copy nobody checks against its source is two readings of one question, and the one that matters is
    // the one nobody looks at: the frequency cap, the kill switch and the cost report all read this one.
    expect(state).toBe('ZM004')
  })
})

// --- the shipped corpus, as rows ---------------------------------------------------------------------

describe('the seeded corpus carries both classes, and the promotional one is not sendable', () => {
  it('seeds review.request as a promotional template in draft', async () => {
    const [row] = await sql<{ message_class: string; approval_state: string }[]>`
      select t.message_class::text as message_class, v.approval_state::text as approval_state
        from message_template t
        join message_template_variant v on v.template_id = t.id
       where t.template_key = 'review.request' and t.is_current and v.locale = 'en'
    `
    // Seeded by `pnpm seed` through `seedMessageTemplates`, which used to write `'approved'` for every
    // row regardless of what the definition said. Marketing copy nobody with the authority to approve it
    // has seen must not be sendable on the day of install.
    expect(row).toMatchObject({ message_class: 'promotional', approval_state: 'draft' })
  })

  it('seeds the transactional templates approved, so the assertion above is about the class', async () => {
    const [row] = await sql<{ approval_state: string }[]>`
      select v.approval_state::text as approval_state
        from message_template t
        join message_template_variant v on v.template_id = t.id
       where t.template_key = 'booking.confirmed' and t.is_current and v.locale = 'en'
    `
    expect(row?.approval_state).toBe('approved')
  })
})
