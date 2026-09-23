import type { Sql } from '../connection.ts'

/**
 * The shipped message templates, written into `message_template` and `message_template_variant`.
 *
 * ## Why this exists now, and why B-MSG-01 did not write it
 *
 * B-MSG-01 declared the templates as DATA — `DEFAULT_TEMPLATES` in `packages/messaging/src/templates.ts`
 * — and every use of them so far has been a render at the call site: B-LIFE-02's OTP route picks the
 * `auth.otp` definition out of that array and hands it to the choke point. Nothing needed a ROW.
 *
 * B-MSG-04 needed one and said so: `message.template_id` is `not null references message_template(id)`,
 * because "a message has to keep pointing at the words and the class it actually left with" after
 * `reclassify_template` supersedes a version. Its NOTE hands the seed to B-MSG-03 ("once B-MSG-03 adds
 * that seed — it needs the same thing to resolve a template per scheduled step"), and this is it: a
 * scheduled step is resolved to a template at SEND time, by key, so the row has to be there.
 *
 * ## Why the definitions are an ARGUMENT
 *
 * `packages/db` may import `@berelax/shared` and `@berelax/config` and nothing else, so it cannot reach
 * `DEFAULT_TEMPLATES`. That is not an obstacle to work around — it is the same seam `seedCatalogue` takes
 * for its compliance lint, and for the same reason: the vocabulary belongs to the package that owns it,
 * the SQL belongs here, and `packages/fixtures` is the one place both can be imported. The loader in
 * `packages/fixtures/src/load.ts` passes `DEFAULT_TEMPLATES` in.
 *
 * ## Idempotent, and what that means for a versioned template
 *
 * `pnpm seed` runs twice (H03's acceptance criterion) and must produce the same rows. A template is
 * versioned and `reclassify_template` (0015) creates a NEW version rather than editing one, so this seed
 * writes **version 1 only** and leaves every later version alone: an owner who has reworded a template
 * has a version 2 marked current, and a seed that re-asserted version 1 as current would silently revert
 * their edit on the next deploy. `on conflict do nothing` on `(template_key, version)` is what makes that
 * true, and it is why the count this returns is rows WRITTEN rather than rows that exist.
 */

/** One shipped template variant, exactly as `DEFAULT_TEMPLATES` declares it. */
export interface TemplateSeedDefinition {
  readonly key: string
  readonly messageClass: 'transactional' | 'promotional'
  readonly purpose: string
  readonly channel: string
  readonly locale: string
  readonly subject?: string
  readonly body: string
  readonly variables: readonly string[]
  /**
   * The approval state the shipped definition declares, written verbatim.
   *
   * It used to be the literal `'approved'` here for every row, which was true of the templates that
   * existed then and became a lie the moment one shipped in `draft`: `review.request` is promotional
   * marketing copy nobody with the authority to approve it has seen, and a seed that approved it on
   * their behalf would make it sendable. So the definition decides, and 0061's state machine is what
   * stops a later UPDATE moving it to `approved` in one step.
   */
  readonly approvalState: 'draft' | 'pending' | 'approved' | 'rejected'
}

export interface TemplateSeedResult {
  readonly templatesWritten: number
  readonly variantsWritten: number
}

export async function seedMessageTemplates(
  sql: Sql,
  definitions: readonly TemplateSeedDefinition[],
): Promise<TemplateSeedResult> {
  let templatesWritten = 0
  let variantsWritten = 0

  // Grouped by key first, because one template has many variants and the `message_class` is the
  // TEMPLATE's (ADR 0016: a class chosen per send puts the compliance decision inside a loop at 9pm).
  // Two variants of one key disagreeing about the class would be a template that is transactional in
  // English and promotional in Arabic, which is not a thing that can be true.
  const byKey = new Map<string, TemplateSeedDefinition[]>()
  for (const definition of definitions) {
    const existing = byKey.get(definition.key)
    if (existing === undefined) byKey.set(definition.key, [definition])
    else existing.push(definition)
  }

  for (const [key, variants] of byKey) {
    const first = variants[0]
    if (first === undefined) continue
    const disagreeing = variants.find((variant) => variant.messageClass !== first.messageClass)
    if (disagreeing !== undefined) {
      throw new Error(
        `Template '${key}' declares two message classes (${first.messageClass} and ` +
          `${disagreeing.messageClass}). The class is the TEMPLATE's and a trigger refuses to change ` +
          'it, so a key whose variants disagree cannot be stored at all.',
      )
    }
    const inserted = await sql<{ id: string }[]>`
      insert into message_template (template_key, version, message_class, purpose, is_current)
      values (${key}, 1, ${first.messageClass}::message_class, ${first.purpose}, true)
      on conflict (template_key, version) do nothing
      returning id
    `
    templatesWritten += inserted.length

    // Read back rather than relying on `returning`: on the second run the insert above returns nothing,
    // and the variants still have to find the template they belong to. Version 1 by name, not
    // `is_current`, for the reason in the header — a later version is somebody's edit.
    const [template] = await sql<{ id: string }[]>`
      select id::text as id from message_template where template_key = ${key} and version = 1
    `
    if (template === undefined) {
      throw new Error(`Template '${key}' was neither inserted nor found after its own insert.`)
    }

    for (const variant of variants) {
      // `encoding`, `segments` and `cost_fils` are left NULL. They are the authoring-time figures B-MSG-01
      // computes with `costOf` while somebody is editing a body, and for a SHIPPED default they are
      // derivable from the body at any moment — while the figures that matter are the ones on the `message`
      // row, which are what the vendor billed. Writing a second copy here would be a number that agrees
      // with the body today and is not corrected when the body changes.
      const rows = await sql<{ id: string }[]>`
        insert into message_template_variant
          (template_id, channel, locale, approval_state, customer_care_window, subject, body, variables)
        values (
          ${template.id}, ${variant.channel}::message_channel, ${variant.locale},
          ${variant.approvalState}::template_approval, false,
          ${variant.subject ?? null}, ${variant.body}, ${sql.array([...variant.variables])}
        )
        on conflict (template_id, channel, locale) do nothing
        returning id
      `
      variantsWritten += rows.length
    }
  }

  return { templatesWritten, variantsWritten }
}

/** A template variant as the send path needs it: the row's id, and the words that are current. */
export interface ResolvedTemplateRow {
  readonly templateId: string
  readonly templateKey: string
  readonly messageClass: string
  readonly channel: string
  readonly locale: string
  readonly subject: string | null
  readonly body: string
  readonly variables: readonly string[]
  /**
   * The variant's approval state, returned rather than filtered on.
   *
   * This reader used to add `and v.approval_state = 'approved'` to its WHERE clause, so an unapproved
   * template was indistinguishable from a missing one — and the worker recorded the difference as
   * `content_unavailable`, which sends whoever reads the report to look for a rendering fault. The send
   * choke point refuses an unapproved template with `template_not_approved` and records that, so the row
   * comes back and the decision is made where the reason can be stated. C-AUTO-01.
   */
  readonly approvalState: string
  /** The 24-hour WhatsApp care-window flag. Carried so a caller need not read the row twice. */
  readonly customerCareWindow: boolean
  readonly category: string | null
}

/**
 * The CURRENT version of one template, in one channel and locale.
 *
 * `is_current` rather than `max(version)`: 0015 makes the flag the answer, and a reclassification resets
 * approval, so the newest row is not necessarily the one that may be sent. Returns `undefined` rather
 * than throwing, because "no template" is a decision the caller has to record — a scheduled step whose
 * template is missing is skipped with a reason code, not crashed on.
 *
 * It does NOT filter on `approval_state`, deliberately. See `ResolvedTemplateRow.approvalState`: a filter
 * here collapses "nobody has approved these words" into "there is no template", and those are different
 * facts with different repairs.
 */
export async function readCurrentTemplate(
  sql: Sql,
  args: { readonly key: string; readonly channel: string; readonly locale: string },
): Promise<ResolvedTemplateRow | undefined> {
  const [row] = await sql<
    {
      template_id: string
      template_key: string
      message_class: string
      channel: string
      locale: string
      subject: string | null
      body: string
      variables: string[]
      approval_state: string
      customer_care_window: boolean
      category: string | null
    }[]
  >`
    select t.id::text as template_id, t.template_key, t.message_class::text as message_class,
           v.channel::text as channel, v.locale, v.subject, v.body, v.variables,
           v.approval_state::text as approval_state, v.customer_care_window, v.category
      from message_template t
      join message_template_variant v on v.template_id = t.id
     where t.template_key = ${args.key}
       and t.is_current
       and v.channel = ${args.channel}::message_channel
       and v.locale = ${args.locale}
     limit 1
  `
  if (row === undefined) return undefined
  return {
    templateId: row.template_id,
    templateKey: row.template_key,
    messageClass: row.message_class,
    channel: row.channel,
    locale: row.locale,
    subject: row.subject,
    body: row.body,
    variables: row.variables,
    approvalState: row.approval_state,
    customerCareWindow: row.customer_care_window,
    category: row.category,
  }
}
